import React, { useState, useCallback, useEffect, useMemo } from "react";
import {
  View,
  Text,
  SafeAreaView,
  StatusBar,
  Pressable,
  StyleSheet,
  Alert,
  Modal,
  ScrollView,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { openBookingDetail, openBookings, openGroupSession, openOfferEditor } from "../navigation/bookingsNav";
import { SessionSetupSheet } from "../components/bookings/SessionSetupSheet";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { OpportunitiesStackParamList } from "../navigation/MainTabNavigator";
import { Feather } from "@expo/vector-icons";
import { DealActionSheet } from "../components/deals/DealActionSheet";
import type { DealItem } from "../components/deals/DealCard";
import { ClassicListV2 } from "../components/deals/ClassicListV2";
import { useDeals } from "../hooks/use-deals";
import { useConnections } from "../hooks/use-connections";
import { BriefView } from "../components/deals/brief/BriefView";
import { DecisionSheet } from "../components/deals/brief/DecisionSheet";
import { YourWeekOutcome } from "../components/deals/week/YourWeekOutcome";
import { FilteredView } from "../components/deals/week/FilteredView";
import type { FilteredItem } from "../components/deals/week/filteredLogic";
import {
  bucketDeals,
  buildOutcomeLog,
  type OutcomeBucketId,
} from "../components/deals/week/yourWeekOutcomeLogic";
import { AskTermsBatch } from "../components/deals/askterms/AskTermsBatch";
import { AddContractSheet } from "../components/deals/AddContractSheet";
import { apiRequest } from "../lib/query-client";
import { openReply } from "../lib/reply-link";
import { proposeAndApproveReply, sendErrorMessage } from "../hooks/use-pending-actions";
import { haptics } from "../lib/haptics";
import { needsReplyCount } from "../components/deals/brief/briefTeaser";
import { OpportunityBoard } from "../components/opps/OpportunityBoard";
import { BOOKINGS, HOME_V3, OPPS_BOARD, OPPS_LABEL, OPPS_V2, SHOP_V1 } from "../lib/flags";
import { PillToggle } from "../components/opps/PillToggle";
import { useOpportunityBoard } from "../hooks/use-opportunity-board";
import { TopTabs } from "../components/deals/ChoiceChip";
import { BookingsBoard, BookingsComingSoon, BookingsEmpty, ShopComingSoon, bookingsTabState } from "../components/opps/BookingsBoard";
import { OPPS_TABS, type OppsTab } from "../components/opps/oppsTabs";
import { openPicks, openSettings } from "../navigation/meNav";
import { useBookingsSummary, useFinancials } from "../hooks/use-financials";
import { useShop } from "../hooks/use-shop";
import { opportunitySections, shopLine, stripLine } from "../lib/financialsLogic";
import { BookingsSection, MoneyStrip, SectionTitle, ShopSection } from "../components/opps/BusinessSections";
import { usePullRefresh, pullRefresh } from "../components/ui/PullRefresh";
import { askForPushOnce } from "../lib/push";
import { Fonts, Colors, Spacing, Bold, BoldType } from "../constants/theme";
import { statusAfterReply } from "../components/deals/replyStatus";


// ─── Screen ────────────────────────────────────────────────────────────────────
// App layout B (8 Oct 2026): Opportunities holds everything that pays her — Deals · Bookings · Shop. Deals is always
// there; Bookings appears once she has a published offer (GET /me/bookings/summary), Shop once she has a live pick
// (GET /me/shop). The money strip sits at the top once money exists (GET /me/financials) and opens Financials. A new
// athlete sees exactly today's screen: no strip, no section heads, no empty Bookings or Shop.
// Two tabs: Brief (Mila's co-pilot) + Explore All (the full list). Explore All now
// renders ONLY the redesigned, self-contained ClassicListV2 — the earlier Classic
// "Original" variant and the Original/Redesign A/B toggle were retired. The pushed-
// screen entry chips (From People / In Flight / Gifting / Couldn't-read) were also
// dropped. The Brief tab keeps its co-pilot flows (Your Week, Ask-for-terms, DecisionSheet).
type OppTab = "brief" | "classic";
const OPP_TABS: { key: OppTab; label: string }[] = [
  { key: "brief",   label: "Brief" },
  { key: "classic", label: "Explore All" },
];
const DEFAULT_OPP_TAB: OppTab = "brief";

type OpportunitiesNavProp = NativeStackNavigationProp<OpportunitiesStackParamList, "OpportunitiesList">;

export function OpportunitiesScreen() {
  const navigation = useNavigation<OpportunitiesNavProp>();
  // OPPS_V2 (§7b): Deals | Bookings, both always there.
  const [oppsTab, setOppsTab] = useState<OppsTab>("deals");
  // "Set up bookings" opens the three-step session sheet right here (fewer taps), not the public page.
  const [sessionSetup, setSessionSetup] = useState(false);
  const [activeTab, setActiveTab]     = useState<OppTab>(DEFAULT_OPP_TAB);
  const [expandedId, setExpandedId]   = useState<string | null>(null);
  const [activeSheet, setActiveSheet] = useState<{ deal: DealItem; mode: "accept" | "negotiate" | "terms" } | null>(null);

  const { deals, isLoading, error, refetch } = useDeals();
  // App layout B: the money strip and the sections beside Deals, each from its own read.
  const fin = useFinancials();
  const bookingsSummary = useBookingsSummary();
  const shop = useShop(SHOP_V1);
  const strip = stripLine(fin.data, new Date());
  const shopItems = SHOP_V1 ? shop.data?.items ?? [] : [];
  const sections = opportunitySections(bookingsSummary.data, shopItems);
  const refetchBusiness = useCallback(() => Promise.all([fin.refetch(), bookingsSummary.refetch(), SHOP_V1 ? shop.refetch() : undefined]), [fin, bookingsSummary, shop]);
  const { hasIssue } = useConnections();
  // Count shown as a badge on the Brief tab — the SAME tightened "needs your reply"
  // number the Brief greeting/section speak, so they never disagree.
  const briefCount = useMemo(() => needsReplyCount(deals), [deals]);

  const [briefDeal, setBriefDeal] = useState<DealItem | null>(null);   // WS2 DecisionSheet
  const [pushed, setPushed] = useState<"week" | "askterms" | "filtered" | null>(null); // Brief co-pilot screens
  // Explore All is the list of every deal however it reached her — so it is also where a
  // deal we never saw gets added. Detected mail, uploaded contracts and (later) inbound
  // from her public profile all land in one place, told apart by source rather than by
  // living on separate screens.
  const [addContract, setAddContract] = useState(false);

  // The "Last 30 Days" row the athlete drilled into. The rows promise "every count
  // opens those deals", but the handler used to discard the bucket id and just switch
  // tabs — so every row landed on the same unfiltered list. `now` is captured at tap
  // time and reused by bucketDeals, so the list can never disagree with the count that
  // was on screen when they tapped it.
  const [bucket, setBucket] = useState<
    { id: OutcomeBucketId; label: string; now: number } | null
  >(null);

  // Deals Nomila has set aside. Explore All hides these (ClassicListV2's `isArchived`),
  // so counting them in "What arrived" made a row promise 2 deals and open an empty
  // list. They already have their own section in the week view ("Set aside by Nomila",
  // which reads agent_actions, not this array), so excluding them here removes a
  // double-count rather than hiding anything.
  const liveDeals = useMemo(
    () => deals.filter((d) => d.threadStatus !== "archived"),
    [deals],
  );

  // Her first deal is on screen: the one moment Nomila asks to notify her phone (asked once per phone; lib/push).
  const hasDeal = liveDeals.length > 0;
  useEffect(() => { if (hasDeal) void askForPushOnce("first_deal"); }, [hasDeal]);

  const openBucket = useCallback((id: OutcomeBucketId) => {
    const now = Date.now();
    const log = buildOutcomeLog(liveDeals, now);
    const label = [...log.arrived, ...log.did].find((b) => b.id === id)?.label ?? "Selected";
    setPushed(null);
    setActiveTab("classic");
    setBucket({ id, label, now });
  }, [liveDeals]);

  // Explore All is the full list by definition — tapping the tab itself clears any
  // drill-in, so the filter can never be a state you're stuck in without noticing.
  const selectTab = useCallback((key: OppTab) => {
    haptics.select();
    setBucket(null);
    setActiveTab(key);
  }, []);

  const shownDeals = useMemo(
    () => (bucket ? bucketDeals(liveDeals, bucket.id, bucket.now) : deals),
    [deals, liveDeals, bucket],
  );

  // Swipe down on the Brief / Explore All lists: the deals again, and the strip + sections (the board owns its own pull).
  const pull = usePullRefresh(() => Promise.all([refetch(), refetchBusiness()]));

  const [decliningId, setDecliningId] = useState<string | null>(null);
  const [declineError, setDeclineError] = useState<string | null>(null);

  // Auto-clear the decline error banner so it doesn't linger forever.
  useEffect(() => {
    if (!declineError) return;
    const t = setTimeout(() => setDeclineError(null), 6000);
    return () => clearTimeout(t);
  }, [declineError]);

  const handleDecline = useCallback(async (dealId: string) => {
    setDecliningId(dealId);
    setDeclineError(null);
    try {
      await apiRequest("PATCH", `/api/v1/me/deals/${dealId}`, { status: "rejected" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDeclineError(`Decline failed: ${msg}`);
    } finally {
      await refetch();
      setDecliningId(null);
    }
  }, [refetch]);

  const toggle = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  // Direct status change (mark done / reopen / reply→negotiating / accept / counter).
  const handleSetStatus = useCallback(async (dealId: string, status: string) => {
    try {
      await apiRequest("PATCH", `/api/v1/me/deals/${dealId}`, { status });
    } finally {
      await refetch();
    }
  }, [refetch]);

  // Persisted bookmark toggle (cross-cutting, not a lifecycle status).
  const handleToggleSaved = useCallback(async (dealId: string, saved: boolean) => {
    try {
      await apiRequest("PATCH", `/api/v1/me/deals/${dealId}`, { saved });
    } finally {
      await refetch();
    }
  }, [refetch]);

  const inboxNeedsReconnect = hasIssue("gmail") || hasIssue("outlook");

  // The strip (once money exists) and, once a second section exists, the "Deals" head over the deals.
  // HOME_V3: no money strip. A payment reaches her as a notification and Mila's good news, and is filed on its deal.
  const moneyStrip = strip && !HOME_V3 ? <MoneyStrip line={strip} onPress={() => navigation.navigate("Financials")} /> : null;
  const dealsTitle = sections.any ? <SectionTitle title="Deals" /> : null;
  const otherSections = sections.any ? (
    <>
      {sections.bookings && bookingsSummary.data ? (
        <BookingsSection requests={bookingsSummary.data.requests} upcoming={bookingsSummary.data.upcoming}
          // Bookings v2 mount point: with her booking screens in the build, a row opens it and "See all" opens Bookings.
          {...(BOOKINGS ? { onOpen: (id: string) => openBookingDetail(navigation, id), onOpenGroup: (slotId: string) => openGroupSession(navigation, slotId), onSeeAll: () => openBookings(navigation) } : {})} />
      ) : null}
      {sections.shop ? <ShopSection {...shopLine(shopItems)} onOpen={() => openPicks(navigation)} /> : null}
    </>
  ) : null;

  const openSearch = () => { haptics.tap(); navigation.navigate("AllDeals", { mode: oppsTab }); };
  const head = (
    <View style={styles.head} testID="opportunities-head">
      <Text style={styles.title} accessibilityRole="header">{OPPS_LABEL}</Text>
      {/* OPPS_V2: the search icon — All deals on Deals, All bookings on Bookings (what Explore All used to do). */}
      {OPPS_V2 ? (
        <Pressable onPress={openSearch} hitSlop={6} style={styles.searchBtn} accessibilityRole="button"
          accessibilityLabel={oppsTab === "deals" ? "Search all deals" : "Search all bookings"} testID="opps-search">
          <Feather name="search" size={22} color={Bold.ink} />
        </Pressable>
      ) : null}
    </View>
  );
  // HOME_V3: the two sections as soft pills, each with what needs her (the board's "What matters next", the booking
  // requests waiting on an answer). Same tabs, same state; only the look and the counts are new.
  const board = useOpportunityBoard(HOME_V3 && OPPS_BOARD && OPPS_V2);
  const pillTabs = OPPS_TABS.map((t) => ({
    ...t,
    count: t.key === "deals" ? board.data?.whatMatters.length ?? null : BOOKINGS ? bookingsSummary.data?.requests.length ?? null : null,
  }));
  const topTabs = OPPS_V2 ? (
    HOME_V3
      ? <PillToggle tabs={pillTabs} active={oppsTab} onChange={setOppsTab} testID="opps-tabs" />
      : <TopTabs tabs={OPPS_TABS} active={oppsTab} onChange={setOppsTab} testID="opps-tabs" />
  ) : null;
  // OPPS_V2: the Bookings tab's own board (or its "not set up yet" state); the Deals tab keeps only the Shop section below.
  const bookingsState = bookingsTabState(bookingsSummary.isError ? null : bookingsSummary.data);
  const bookingsPull = usePullRefresh(() => Promise.all([bookingsSummary.refetch(), fin.refetch()]));

  return (
    <SafeAreaView style={[styles.safe, OPPS_BOARD && styles.safeBoard]}>
      <StatusBar barStyle="dark-content" backgroundColor={OPPS_BOARD ? Bold.paper : Colors.light.backgroundRoot} />

      {/* The tab-root title (DESIGN.md §3b screenTitle, left, as Strategy's): with the board it scrolls with the board;
          on the older Brief / Explore All tabs it stays above them. No refresh button — swipe down refreshes. */}
      {OPPS_BOARD ? null : <View style={styles.headPad}>{head}</View>}
      {/* The Brief / Explore All lists scroll on their own, so the strip and the other sections sit above them here. */}
      {!OPPS_BOARD && (moneyStrip || sections.any) ? (
        <View style={styles.business} testID="opps-business">
          {moneyStrip}
          {otherSections}
          {dealsTitle}
        </View>
      ) : null}

      {/* Inbox reconnect banner — a failed token stops detection silently */}
      {inboxNeedsReconnect && (
        <Pressable
          style={styles.reconnectBanner}
          onPress={() => openSettings(navigation)}
        >
          <Feather name="alert-triangle" size={15} color="#B45309" />
          <Text style={styles.reconnectBannerText}>
            Email disconnected — new deals are paused. Tap to reconnect.
          </Text>
          <Feather name="chevron-right" size={16} color="#B45309" />
        </Pressable>
      )}

      {/* Decline error (shown across both tabs) */}
      {declineError && (
        <View style={styles.declineErrorBanner}>
          <Feather name="alert-circle" size={14} color="#DC2626" />
          <Text style={styles.declineErrorText}>{declineError}</Text>
          <Pressable hitSlop={8} onPress={() => setDeclineError(null)}>
            <Feather name="x" size={14} color="#DC2626" />
          </Pressable>
        </View>
      )}

      {/* Opportunities PR 4: the board replaces the Brief / Explore All tabs (behind EXPO_PUBLIC_OPPS_BOARD). */}
      {OPPS_BOARD && OPPS_V2 && oppsTab === "bookings" ? (
        <ScrollView contentContainerStyle={styles.bookingsIn} refreshControl={pullRefresh(bookingsPull)} testID="opps-bookings-tab">
          {head}
          {topTabs}
          {/* Stage 1 (owner, 25 Oct 2026): with bookings not in this build, the tab says "Coming soon" — no set-up. */}
          {!BOOKINGS ? <BookingsComingSoon /> : bookingsState === "loading" ? null : bookingsState === "empty" ? (
            <BookingsEmpty onSetUp={() => { haptics.tap(); setSessionSetup(true); }} />
          ) : (
            <BookingsBoard
              summary={bookingsSummary.data!}
              {...(BOOKINGS ? { onOpen: (id: string) => openBookingDetail(navigation, id), onOpenGroup: (slotId: string) => openGroupSession(navigation, slotId), onSeeAll: () => openBookings(navigation) } : {})}
            />
          )}
        </ScrollView>
      ) : OPPS_BOARD ? (
        <OpportunityBoard
          header={OPPS_V2 ? <>{head}{topTabs}{moneyStrip}</> : <>{head}{moneyStrip}{dealsTitle}</>}
          footer={OPPS_V2 ? (sections.shop ? <ShopSection {...shopLine(shopItems)} onOpen={() => openPicks(navigation)} /> : !SHOP_V1 ? <ShopComingSoon /> : null) : otherSections}
          onRefresh={refetchBusiness}
          onOpenItem={(item) => navigation.navigate("OpportunityDetail", { opportunityId: item.opportunity_id })}
          onAskTerms={() => setPushed("askterms")}
          onOpenFiltered={() => (OPPS_V2 ? navigation.navigate("AllDeals", { mode: "deals", tab: "closed", notADeal: true }) : setPushed("filtered"))}
        />
      ) : (
      <>
      {/* Top tabs — Brief · Explore All */}
      <View style={styles.tabBar}>
        {OPP_TABS.map(({ key, label }) => (
          <Pressable key={key} onPress={() => selectTab(key)} style={styles.tabButton} hitSlop={6}>
            <View style={styles.tabLabelRow}>
              <Text style={[styles.tabLabel, activeTab === key && styles.tabLabelActive]}>{label}</Text>
              {key === "brief" && briefCount > 0 && (
                <View style={styles.tabBadge}>
                  <Text style={styles.tabBadgeText}>{briefCount}</Text>
                </View>
              )}
            </View>
            <View style={[styles.tabUnderline, activeTab === key && styles.tabUnderlineActive]} />
          </Pressable>
        ))}
        {/* Only on Explore All: the Brief is Mila's read of what needs doing, not a ledger. */}
        {activeTab === "classic" && (
          <Pressable
            onPress={() => { haptics.tap(); setAddContract(true); }}
            style={styles.addBtn}
            hitSlop={10}
            accessibilityLabel="Add a deal"
          >
            <Feather name="plus" size={18} color={Colors.light.text} />
          </Pressable>
        )}
      </View>

      {/* Brief — Mila's co-pilot */}
      {activeTab === "brief" && (
        <BriefView
          deals={deals}
          isLoading={isLoading}
          error={error}
          onOpenDeal={(deal) => setBriefDeal(deal)}
          onOpenWeek={() => setPushed("week")}
          onAskTerms={() => setPushed("askterms")}
          onAskTermsDeal={(deal) => setActiveSheet({ deal, mode: "terms" })}
          onAccept={(deal) => setActiveSheet({ deal, mode: "accept" })}
          onNegotiate={(deal) => setActiveSheet({ deal, mode: "negotiate" })}
          onDecline={(dealId) => handleDecline(dealId)}
          onSetStatus={(dealId, status) => handleSetStatus(dealId, status)}
          onToggleSaved={(dealId, saved) => handleToggleSaved(dealId, saved)}
          onViewThread={(deal) => { if (deal.threadId) navigation.navigate("Thread", { threadId: deal.threadId, brandName: deal.brandName }); }}
          onOpenDetail={(dealId, section) => navigation.navigate("DealDetail", { dealId, section })}
          onOpenFiltered={() => setPushed("filtered")}
          decliningId={decliningId}
          refreshControl={pullRefresh(pull)}
        />
      )}

      {/* Drill-in banner — names the bucket being shown and offers the way out. Without
          it a filtered list is indistinguishable from "you only have 2 deals". */}
      {activeTab === "classic" && bucket && (
        <>
          <View style={styles.filterBanner}>
            <Feather name="filter" size={13} color={Colors.light.primary} />
            {/* Just the bucket name. "· last 30 days" read as a promise the data doesn't
                keep: the accepted/completed buckets are all-time by design (weekLogic
                returns them before any recency check). */}
            <Text style={styles.filterBannerText} numberOfLines={1}>{bucket.label}</Text>
            <Pressable hitSlop={8} onPress={() => { haptics.tap(); setBucket(null); }}>
              <Text style={styles.filterBannerClear}>Show all</Text>
            </Pressable>
          </View>
          {/* A filtered list that empties out (accept the only deal in it, and it leaves
              the bucket) otherwise falls through to ClassicListV2's "You're all caught
              up." — which reads as "you have no deals" rather than "this bucket is now
              empty". Own the empty state while a bucket is applied. */}
          {shownDeals.length === 0 && (
            <View style={styles.bucketEmpty}>
              <Text style={styles.bucketEmptyText}>Nothing left in {bucket.label}.</Text>
              <Pressable hitSlop={8} onPress={() => { haptics.tap(); setBucket(null); }}>
                <Text style={styles.filterBannerClear}>Show all deals</Text>
              </Pressable>
            </View>
          )}
        </>
      )}

      {/* Explore All — the redesigned, self-contained deal list (Original variant retired) */}
      {activeTab === "classic" && !(bucket && shownDeals.length === 0) && (
        <ClassicListV2
          deals={shownDeals}
          isLoading={isLoading}
          error={error}
          expandedId={expandedId}
          decliningId={decliningId}
          onToggleExpand={toggle}
          onAccept={(deal) => setActiveSheet({ deal, mode: "accept" })}
          onNegotiate={(deal) => setActiveSheet({ deal, mode: "negotiate" })}
          onDecline={(dealId) => handleDecline(dealId)}
          onSetStatus={(dealId, status) => handleSetStatus(dealId, status)}
          onToggleSaved={(dealId, saved) => handleToggleSaved(dealId, saved)}
          onViewThread={(deal) => navigation.navigate("Thread", { threadId: deal.threadId!, brandName: deal.brandName })}
          onOpenDetail={(dealId, section) => navigation.navigate("DealDetail", { dealId, section })}
          refreshControl={pullRefresh(pull)}
        />
      )}

      </>
      )}

      {/* WS2 DecisionSheet — opened from the Brief */}
      {briefDeal && (
        <DecisionSheet
          deal={briefDeal}
          onClose={() => setBriefDeal(null)}
          onPrimary={(deal) => { setBriefDeal(null); setActiveSheet({ deal, mode: "negotiate" }); }}
          onViewThread={(deal) => {
            setBriefDeal(null);
            if (deal.threadId) navigation.navigate("Thread", { threadId: deal.threadId, brandName: deal.brandName });
          }}
        />
      )}

      {/* Brief co-pilot: "Your Week" outcome log + "Ask for terms" batch */}
      <Modal visible={pushed === "week"} animationType="slide" onRequestClose={() => setPushed(null)}>
        <YourWeekOutcome
          deals={liveDeals}
          isLoading={isLoading}
          error={error}
          onClose={() => setPushed(null)}
          onOpenBucket={openBucket}
        />
      </Modal>
      <Modal visible={pushed === "askterms"} animationType="slide" onRequestClose={() => setPushed(null)}>
        <AskTermsBatch
          deals={deals}
          isLoading={isLoading}
          error={error}
          onClose={() => setPushed(null)}
          onDone={() => { setPushed(null); void refetch(); }}
        />
      </Modal>

      {/* Filtered / not-a-deal — the transparency drill-in (reads agent_actions junk
          filings). Recovery is a stub for now (full re-classify lands later); we just
          log the intent so the affordance is real. */}
      <Modal visible={pushed === "filtered"} animationType="slide" onRequestClose={() => setPushed(null)}>
        <FilteredView
          onClose={() => setPushed(null)}
          onRecover={(item: FilteredItem) => {
            // TODO(recovery): POST a re-classify / un-file so the message re-enters the
            // deal pipeline. Stubbed until the server path exists — FilteredView already
            // gives the athlete inline "On it" acknowledgement.
            console.log("[filtered] recover requested", item.id, item.sender);
          }}
        />
      </Modal>

      {/* Add a deal we never saw — an uploaded contract, or details typed by hand. */}
      <AddContractSheet
        visible={addContract}
        onClose={() => setAddContract(false)}
        onCreated={() => { setAddContract(false); void refetch(); }}
      />

      {activeSheet && (
        <DealActionSheet
          deal={activeSheet.deal}
          mode={activeSheet.mode}
          onClose={() => setActiveSheet(null)}
          onSend={async (body: string, intent) => {
            const { deal } = activeSheet;
            // Actually send the drafted reply.
            try {
              if (deal.threadId) {
                // Governed path: propose a send_reply on the visible body, then approve it.
                // The server resolves the recipient + sets the RFC 2822 threading headers
                // so this nests into the existing Gmail thread.
                await proposeAndApproveReply({ dealId: deal.id, threadId: deal.threadId, body });
              } else {
                // No linked thread to reply into — hand off to the mail app.
                await openReply(null, body);
              }
            } catch (err: any) {
              Alert.alert(
                "Couldn't send reply",
                sendErrorMessage(err),
              );
              return; // keep the sheet open so the draft isn't lost
            }
            setActiveSheet(null);
            handleSetStatus(deal.id, statusAfterReply(intent));
          }}
        />
      )}

      {sessionSetup ? (
        <SessionSetupSheet
          visible
          onClose={() => setSessionSetup(false)}
          onDone={() => { setSessionSetup(false); bookingsSummary.refetch(); }}
          onOpenEditor={(id) => { setSessionSetup(false); openOfferEditor(navigation, id); }}
        />
      ) : null}
    </SafeAreaView>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  // The board is look B: the screen is white (DESIGN.md §8b), like every other shell tab root.
  safeBoard: { backgroundColor: Bold.paper },

  // The tab-root title row: screenTitle at the left (Strategy's), the classic avatar at the right.
  head:    { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  headPad: { paddingHorizontal: Bold.gutter, paddingTop: 4, paddingBottom: Spacing.sm },
  business: { paddingHorizontal: Bold.gutter, gap: 14, paddingBottom: Spacing.sm },
  title:   { ...BoldType.screenTitle, color: Bold.ink, flexShrink: 1, flexGrow: 1 },
  searchBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  bookingsIn: { paddingHorizontal: Bold.gutter, paddingTop: 4, gap: 14, paddingBottom: 48 },

  // Top tabs (mirrors BrandTabScreen)
  tabBar: { flexDirection: "row", alignItems: "center", paddingHorizontal: Spacing.xl, marginTop: Spacing.xs, marginBottom: Spacing.sm },
  addBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center", marginBottom: Spacing.sm },
  tabButton: { flex: 1, alignItems: "center", gap: Spacing.sm },
  tabLabelRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  tabLabel: { fontFamily: Fonts.headingSemiBold, fontSize: 15, color: Colors.light.textMuted },
  tabLabelActive: { color: Colors.light.text },
  tabBadge: {
    minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5,
    alignItems: "center", justifyContent: "center", backgroundColor: Colors.light.primary,
  },
  tabBadgeText: {
    fontFamily: Fonts.bodySemiBold, fontSize: 11, color: Colors.light.buttonText,
    fontVariant: ["tabular-nums"],
  },
  tabUnderline: { height: 2, width: "60%", borderRadius: 1, backgroundColor: "transparent" },
  tabUnderlineActive: { backgroundColor: Colors.light.primary },

  // Inbox reconnect banner
  reconnectBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: Spacing.xl,
    marginTop: Spacing.md,
    paddingHorizontal: 14,
    paddingVertical: 11,
    backgroundColor: "#FEF3C7",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#FDE68A",
  },
  reconnectBannerText: {
    flex: 1,
    fontFamily: Fonts.bodyMedium,
    fontSize: 13,
    color: "#B45309",
  },

  // Drill-in filter banner ("What arrived · Paid" etc.)
  filterBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: Spacing.xl,
    marginBottom: Spacing.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: Colors.light.primaryLight,
    borderRadius: 10,
  },
  filterBannerText: {
    flex: 1,
    fontFamily: Fonts.bodyMedium,
    fontSize: 13,
    color: Colors.light.primary,
  },
  filterBannerClear: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 13,
    color: Colors.light.primary,
  },
  bucketEmpty: {
    alignItems: "center",
    gap: Spacing.sm,
    paddingTop: 48,
    paddingHorizontal: Spacing["3xl"],
  },
  bucketEmptyText: {
    fontFamily: Fonts.body,
    fontSize: 14,
    color: Colors.light.textMuted,
    textAlign: "center",
  },

  // Decline error
  declineErrorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: Spacing.xl,
    marginTop: Spacing.sm,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: "#FEF2F2",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#FECACA",
  },
  declineErrorText: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 13,
    color: "#DC2626",
    flex: 1,
  },
});
