import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Animated,
  StyleSheet,
  SafeAreaView,
  ActivityIndicator,
  Linking,
  type LayoutChangeEvent,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BrandLogo } from "../components/BrandLogo";
import { Card, Row } from "../components/ui";
import { PlatformIcon } from "../components/PlatformIcon";
import { BrandDeckHero, BRAND_HERO_HEIGHT, SHEET_OVERLAP } from "../components/deals/BrandDeckHero";
import {
  CATEGORY_CONFIG,
  type DealItem,
  type DealStatus,
} from "../components/deals/DealCard";
import {
  resolveDealActions,
  coPilotPrimary,
  ACTION_TONE_COLOR,
  type DealActionKind,
} from "../components/deals/dealActions";
import { formatScheduleMoney, usdShort, scheduleSummary } from "../components/deals/scheduleMoney";
import { useDeals, useDeal } from "../hooks/use-deals";
import {
  useDealAttachments,
  useDealTimeline,
  fetchAttachmentUrl,
  type DealAttachment,
  type DealActivityItem,
  type DealPaymentState,
} from "../hooks/use-deal-attachments";
import { AddContractSheet } from "../components/deals/AddContractSheet";
import { dayLabel, messagesLabel, respondByLabel } from "../lib/dealWords";
import { Bold, Fonts, Colors, Spacing, BorderRadius } from "../constants/theme";

// ─────────────────────────────────────────────────────────────────────────────
// DealDetailScreen — "Option C": ONE pushed screen that replaces the stack of
// bottom sheets (ScoreAnalysisSheet / BrandInfoSheet). Every
// facet of a deal lives in an anchored section on a single scroll; taps that
// used to open a sheet now deep-link to a section (`initialSection`), and the
// native back gesture restores list context instead of dismissing a modal pile.
//
// Section contract: every section renders in exactly one of three states —
// populated, explicit-empty (an honest "not here yet" row), or pending (data is
// known to still be computing, e.g. brand enrichment). No section may render
// blank or throw on partial data; all reads off `deal` are guarded.
// ─────────────────────────────────────────────────────────────────────────────

/** Anchor targets a caller can deep-link to (score-tap → "score", etc.). */
export type DealDetailSection =
  | "score"
  | "structure"
  | "attachments"
  | "activity"
  | "brand"
  | "thread"
  | "pitch";

/** Route params once this is registered on the Opportunities stack. */
export type DealDetailParams = {
  dealId: string;
  /** Scroll this section into view on mount (score-tap / brand-tap deep links). */
  section?: DealDetailSection;
};

export interface DealDetailScreenProps {
  dealId: string;
  initialSection?: DealDetailSection;
  onBack: () => void;
  /** Handlers mirror OpportunitiesScreen's; any that are absent simply hide their action. */
  onAccept?: (deal: DealItem) => void;
  onNegotiate?: (deal: DealItem) => void;
  /** Open the composer in request-terms mode — asks for budget/scope, never names a rate. */
  onAskTerms?: (deal: DealItem) => void;
  onDecline?: (deal: DealItem) => void;
  onViewThread?: (deal: DealItem) => void;
  onSetStatus?: (dealId: string, status: DealStatus) => void;
  onToggleSaved?: (dealId: string, saved: boolean) => void;
  /** Future: jump to the Nomi Card tailored for this brand (Brand stack). */
  onOpenPitch?: (deal: DealItem) => void;
}

const SOURCE_LABEL: Record<string, string> = {
  gmail: "Gmail",
  instagram: "Instagram",
  tiktok: "TikTok",
  twitter: "X",
  outlook: "Outlook",
};

// Only "poor" is read (a declined or unusable state). The ring colours paint the M.I.A. score only (one look, 23 Oct 2026).
const RATING_COLOR: Record<string, string> = {
  poor: "#E87070",
};


// ─── Component ───────────────────────────────────────────────────────────────

export function DealDetailScreen({
  dealId,
  initialSection,
  onBack,
  onAccept,
  onNegotiate,
  onAskTerms,
  onDecline,
  onViewThread,
  onSetStatus,
  onToggleSaved,
  onOpenPitch,
}: DealDetailScreenProps) {
  const C = Colors.light; // light only (one look, Oct 2026)
  const styles = useMemo(() => createStyles(C), [C]);

  // Fetch THIS deal, rather than scanning the whole list for it.
  //
  // `deals.find()` over useDeals() is what made the list a client-side store: the list had to
  // return every deal, uncapped and unfiltered, or opening one outside the page rendered
  // nothing. That is the single dependency keeping GET /deals from being filtered or paged
  // server-side, which is why it ships 100 rows — 65 of them archived and discarded on
  // arrival — on every load.
  //
  // ?id= goes through the same query and the same mapper as the list, so the shape is
  // identical by construction, and it fetches the whole cross-thread GROUP so a grouped deal
  // (gorjana is six threads) still collapses with its summed activity and borrowed offer.
  //
  // The list stays as a FALLBACK. Every other screen still uses it, so it is already in
  // cache; falling back costs nothing and means a failure of the new path renders exactly
  // what it rendered before rather than an empty screen.
  const { deals, isLoading: listLoading, error, refetch } = useDeals();
  const { deal: fetched, isLoading: dealLoading } = useDeal(dealId);
  const deal = fetched ?? deals.find((d) => d.id === dealId) ?? null;
  const isLoading = dealLoading && listLoading;

  // ── Attachments — PDFs the brand sent, stored at ingest ──
  const { attachments } = useDealAttachments(dealId);
  // ── Stage + activity/payments timeline (same GET /deals/:id, shared cache) ──
  const { activity, payment } = useDealTimeline(dealId);
  // The screen no longer sits inside a SafeAreaView — the photo runs under the status
  // bar — so the floating controls carry the top inset themselves.
  const insets = useSafeAreaInsets();
  // Keyed by `${messageId}:${index}` so only the row actually tapped shows a spinner.
  const [openingAttachment, setOpeningAttachment] = useState<string | null>(null);
  const [attachmentError, setAttachmentError]     = useState<string | null>(null);
  // Which attachment she asked us to read as the contract, if any.
  const [readingContract, setReadingContract] =
    useState<{ messageId: string; index: number } | null>(null);

  const openAttachment = useCallback(async (a: DealAttachment) => {
    const key = `${a.messageId}:${a.index}`;
    setOpeningAttachment(key);
    setAttachmentError(null);
    try {
      const url = await fetchAttachmentUrl(dealId, a);
      await Linking.openURL(url);
    } catch {
      // Inline on the row rather than an alert — the rest of the deal is still usable.
      setAttachmentError(key);
    } finally {
      setOpeningAttachment(null);
    }
  }, [dealId]);

  const attachmentsTeaser =
    attachments.length === 0
      ? "None yet"
      : attachments.length === 1
        ? attachments[0].filename
        : `${attachments.length} files`;

  // ── Section anchors — measured y positions for deep-link scrolling ──
  const scrollRef = useRef<ScrollView>(null);
  const sectionY = useRef<Partial<Record<DealDetailSection, number>>>({});
  const didAutoScroll = useRef(false);

  // ── Airbnb-style brand-deck hero: fades / recedes as the deal detail scrolls up,
  // and returns as you scroll back to the top. Native-driver (opacity + transform only). ──
  const scrollY = useRef(new Animated.Value(0)).current;
  const heroOpacity = scrollY.interpolate({
    inputRange: [0, BRAND_HERO_HEIGHT * 0.62],
    outputRange: [1, 0],
    extrapolate: "clamp",
  });
  const heroTranslate = scrollY.interpolate({
    inputRange: [0, BRAND_HERO_HEIGHT],
    outputRange: [0, -34],
    extrapolate: "clamp",
  });
  const heroScale = scrollY.interpolate({
    inputRange: [-60, 0, BRAND_HERO_HEIGHT],
    outputRange: [1.08, 1, 0.95],
    extrapolate: "clamp",
  });

  const registerSection = useCallback(
    (key: DealDetailSection) => (e: LayoutChangeEvent) => {
      sectionY.current[key] = e.nativeEvent.layout.y;
      if (initialSection === key && !didAutoScroll.current) {
        didAutoScroll.current = true;
        // Defer one frame so the ScrollView has content size before scrolling.
        requestAnimationFrame(() => {
          scrollRef.current?.scrollTo({
            y: Math.max(0, e.nativeEvent.layout.y - Spacing.sm),
            animated: false,
          });
        });
      }
    },
    [initialSection],
  );

  const scrollToSection = useCallback((key: DealDetailSection) => {
    const y = sectionY.current[key];
    if (y != null) {
      scrollRef.current?.scrollTo({ y: Math.max(0, y - Spacing.sm), animated: true });
    }
  }, []);

  // ── Accordion open/closed state — all collapsed by default, except the
  // deep-linked `initialSection` (so a score-tap lands on an expanded section). ──
  const [open, setOpen] = useState<Partial<Record<DealDetailSection, boolean>>>(
    () => (initialSection ? { [initialSection]: true } : {}),
  );
  const toggleSection = useCallback((key: DealDetailSection) => {
    setOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // ── Whole-screen loading / error / not-found guards ──
  if (isLoading && !deal) {
    return (
      <Shell styles={styles} onBack={onBack} title="Deal">
        <View style={styles.centerFill}>
          <ActivityIndicator size="small" color={C.primary} />
          <Text style={styles.centerFillText}>Loading deal…</Text>
        </View>
      </Shell>
    );
  }

  if (!deal) {
    return (
      <Shell styles={styles} onBack={onBack} title="Deal">
        <View style={styles.centerFill}>
          <Feather name={error ? "alert-circle" : "inbox"} size={24} color={C.textMuted} />
          <Text style={styles.centerFillTitle}>
            {error ? "Could not load this deal" : "Deal not found"}
          </Text>
          <Text style={styles.centerFillText}>
            {error
              ? "Check your connection and try again."
              : "It may have been archived or removed."}
          </Text>
          {error ? (
            <Pressable style={styles.retryBtn} onPress={() => refetch()}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      </Shell>
    );
  }

  const cat = CATEGORY_CONFIG[deal.category] ?? CATEGORY_CONFIG.PAID;

  // ── Derived section states ──
  const hasStructure =
    (deal.deliverables?.length ?? 0) > 0 ||
    !!deal.convAsk ||
    !!deal.factors?.exclusivity ||
    !!deal.deadline ||
    !!deal.offerDisplay ||
    !!deal.offerAmount;

  // The Deal structure rows, in reading order. A row with no `value` renders its `empty` text
  // in the placeholder style; a qualifying sentence becomes the row's meta line.
  const structureRows: Array<{ label: string; value?: string; empty?: string; meta?: string; lines?: number }> = [];
  if (deal.money?.basis === "schedule") {
    structureRows.push({ label: "Compensation", value: formatScheduleMoney(deal.money) ?? undefined, empty: "Not stated" });
    if (deal.money.conditionalCents) structureRows.push({ label: "Conditional", value: usdShort(deal.money.conditionalCents), meta: "Only if the contract's conditions are met" });
    // Money she DIRECTS but never receives: kept outside the compensation figure, and said
    // beside the number, because that is the only safe way to show a figure that is not hers.
    if (deal.money.directedCents) structureRows.push({ label: "Charitable credit", value: usdShort(deal.money.directedCents), meta: "You direct where it goes; not part of the deal's value" });
  } else {
    structureRows.push({ label: "Compensation", value: deal.offerDisplay ?? deal.offerAmount ?? undefined, empty: "Not stated" });
  }
  if ((deal.deliverables?.length ?? 0) > 0) structureRows.push({ label: "Deliverables", value: deal.deliverables!.join("\n"), lines: 8 });
  else if (deal.convAsk) structureRows.push({ label: "The ask", value: deal.convAsk, lines: 4 });
  else structureRows.push({ label: "Deliverables", empty: "Not specified yet" });
  // Exclusivity only when something states it. "None mentioned" was shown on every deal (nothing maps `factors`), even
  // on a contract she confirmed as exclusive: false reassurance on the one term that blocks other deals (audit E §1.4).
  if (deal.factors?.exclusivity) structureRows.push({ label: "Exclusivity", value: deal.factors.exclusivity.split(/[.;]/)[0].trim() });
  if (dayLabel(deal.deadline)) structureRows.push({ label: "Respond by", value: dayLabel(deal.deadline)! });

  const brandDescription = deal.brandDescription || deal.brandSummary;
  const hasBrandContent =
    !!brandDescription ||
    !!deal.brandAudienceSummary ||
    (deal.brandSportCategories?.length ?? 0) > 0 ||
    (deal.brandKnownPartnerships?.length ?? 0) > 0 ||
    !!deal.brandTier ||
    !!deal.brandSportFit ||
    !!deal.brandAudienceFit;

  // ── Sticky action bar (same resolver as DealCard, so recommendations agree) ──
  const actions = resolveDealActions(deal);
  const runAction = (kind: DealActionKind) => {
    switch (kind) {
      case "accept":     onAccept?.(deal); break;
      case "negotiate":  onNegotiate?.(deal); break;
      case "askTerms":   onAskTerms?.(deal); break;
      case "reply":      (onNegotiate ?? onViewThread)?.(deal); break;
      case "decline":
      case "dismiss":    onDecline?.(deal); break;
      case "viewThread":
      case "nudge":      onViewThread?.(deal); break;
      case "markDone":   onSetStatus?.(deal.id, "completed"); break;
      case "reopen":     onSetStatus?.(deal.id, "detected"); break;
      case "save":       onToggleSaved?.(deal.id, !deal.saved); break;
    }
  };
  const hasHandler = (kind: DealActionKind): boolean => {
    switch (kind) {
      case "accept":     return !!onAccept;
      case "negotiate":  return !!onNegotiate;
      case "askTerms":   return !!onAskTerms;
      case "reply":      return !!onNegotiate || !!onViewThread;
      case "decline":
      case "dismiss":    return !!onDecline;
      case "viewThread":
      case "nudge":      return !!onViewThread && !!deal.threadId;
      case "markDone":
      case "reopen":     return !!onSetStatus;
      case "save":       return !!onToggleSaved;
    }
  };
  // The primary comes from the co-pilot resolver, so this screen and the Brief can no
  // longer name different moves for the same deal. resolveDealActions still owns the
  // lifecycle cases it alone understands: a won or closed deal, and "waiting on brand".
  // Asking coPilotAction about those would produce nonsense — "Draft a yes" on a deal that
  // completed months ago.
  const isLifecycleState =
    deal.status === "accepted" || deal.status === "completed" || deal.status === "rejected";
  const resolvedPrimary =
    actions.waiting || isLifecycleState ? actions.primary : coPilotPrimary(deal);
  const primaryAction =
    resolvedPrimary && hasHandler(resolvedPrimary.kind) ? resolvedPrimary : actions.primary;

  const brandDisplayName =
    deal.viaAgency && deal.agencyName && !deal.advertiser
      ? "Brand TBD"
      : deal.advertiser ?? deal.brandName;

  // ── Collapsed-accordion teasers — short, data-driven, guarded to a generic. ──
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const structureTeaser = deal.offerDisplay ?? deal.offerAmount ?? "No terms yet";
  const brandTeaser =
    [deal.brandTier ? `${cap(deal.brandTier)} brand` : null, deal.brandCategory]
      .filter(Boolean)
      .join(" · ") || "Still researching…";
  const turnLabel =
    deal.awaitingResponseFrom === "athlete"
      ? "Your turn"
      : deal.awaitingResponseFrom === "brand"
        ? "Their turn"
        : null;
  const threadTeaser =
    [turnLabel, deal.messageCount != null ? messagesLabel(deal.messageCount) : null]
      .filter(Boolean)
      .join(" · ") || "No messages yet";

  return (
    <View style={styles.safe}>
      {/* ── Floating controls — no bar, no title. The photo runs to the very top of the
          screen (under the status bar) and these sit ON it as frosted circles, so the
          brand image is the first thing on screen rather than the second. Identity is
          already on the deck, so a title here would only repeat it. ── */}
      <View style={[styles.navFloat, { top: insets.top + 6 }]} pointerEvents="box-none">
        <Pressable onPress={onBack} hitSlop={10} style={styles.circleBtn}>
          <Feather name="chevron-left" size={20} color="#171513" />
        </Pressable>
        <View style={{ flex: 1 }} />
        {onToggleSaved ? (
          <Pressable
            onPress={() => onToggleSaved(deal.id, !deal.saved)}
            hitSlop={10}
            style={styles.circleBtn}
          >
            <Feather
              name="heart"
              size={18}
              color={deal.saved ? C.primary : "#171513"}
            />
          </Pressable>
        ) : null}
      </View>

      <Animated.ScrollView
        ref={scrollRef as any}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true },
        )}
      >
        {/* ── Hero stack: the photo deck and the content sheet are ONE unit, so
            scrollContent's `gap` applies once BELOW the pair and can never eat the
            sheet's overlap. In Yoga, gap and margin are ADDITIVE — gap 20 against
            marginTop -26 left only 6px of overlap under a 26px corner radius, so 20px
            of each corner arc hung over the page ground and read as a white
            square with a notch. The dark ground lives here, on the UNTRANSFORMED
            parent, so the deck's scale-down reveals #0E0D0B rather than the page. ── */}
        <View style={styles.heroStack}>
        {/* ── 0 · Brand-deck hero — swipeable brand story, fades as the detail rises.
            Full-bleed: cancels the scroll content's horizontal padding. ── */}
        <Animated.View
          style={[
            styles.heroDeck,
            { opacity: heroOpacity, transform: [{ translateY: heroTranslate }, { scale: heroScale }] },
          ]}
        >
          <BrandDeckHero deal={deal} brandDisplayName={brandDisplayName} />
        </Animated.View>

        {/* ── 1 · Deal summary — one-liner, then summary, then chips + score.
            Brand identity (logo, name, category) is NOT repeated here: it lives on the
            deck hero directly above, the same rule the collapsed card follows. That frees
            the top of the sheet for the thing being decided — the money. ── */}
        <View style={styles.sheet}>
        <View style={styles.hero}>
          <View style={styles.heroOfferRow}>
            {deal.offerDisplay || deal.offerAmount ? (
              <>
                <Text style={styles.heroOffer} numberOfLines={2}>
                  {deal.offerDisplay ?? deal.offerAmount}
                </Text>
                {deal.rateVsMarket != null ? (
                  <View
                    style={[
                      styles.rateChip,
                      { backgroundColor: deal.rateVsMarket >= 0 ? Bold.ground : "#EF44441E" },
                    ]}
                  >
                    <Text
                      style={[
                        styles.rateChipText,
                        { color: deal.rateVsMarket >= 0 ? Bold.ink : "#DC2626" },
                      ]}
                    >
                      {deal.rateVsMarket >= 0 ? "+" : ""}
                      {deal.rateVsMarket}% vs avg
                    </Text>
                  </View>
                ) : null}
              </>
            ) : (
              <Text style={styles.heroNoOffer}>No offer stated yet</Text>
            )}
          </View>

          {deal.aiSummary ? (
            <Text style={styles.heroSummary}>{deal.aiSummary}</Text>
          ) : null}

          {/* Chip line — the card's foot, repeated here so the two surfaces read the same way. */}
          <View style={styles.heroFoot}>
            <View style={styles.heroChips}>
              <View style={styles.statusPill}>
                <Text style={styles.statusPillText}>{deal.status.toUpperCase()}</Text>
              </View>
              <View style={[styles.catChip, { backgroundColor: cat.color + "1A" }]}>
                <Feather name={cat.icon} size={10} color={cat.color} />
                <Text style={[styles.catChipText, { color: cat.color }]}>
                  {deal.brandCategory ?? deal.category}
                </Text>
              </View>
              <View style={styles.heroSource}>
                <PlatformIcon platform={deal.source} color={C.textMuted} size={12} />
                <Text style={styles.heroSourceText} numberOfLines={1}>
                  {SOURCE_LABEL[deal.source] ?? deal.source} · {deal.timeAgo}
                </Text>
              </View>
              {respondByLabel(deal.deadline) ? (
                <View style={styles.deadlineChip}>
                  <Feather name="clock" size={12} color="#C4850D" />
                  <Text style={styles.deadlineText}>{respondByLabel(deal.deadline)}</Text>
                </View>
              ) : null}
            </View>

          </View>
        </View>

        {/* ── 2 · Mila's recommendation — the verdict-to-action bridge ──
            Kept as its own surface, because the whole point is that you can find what
            Mila suggests at a glance without reading the page. What it no longer needs
            is a left accent bar shouting for attention: the heading and the hairline do
            that job now, the way they do for every other section. ── */}
        {deal.recommendationUi ? (
          <View style={styles.section}>
            <SectionHeader styles={styles} icon="compass" title="Mila's take" C={C} />
            <View style={styles.recoCard}>
            {deal.recommendationUi ? (
              <Text style={styles.recoText}>{deal.recommendationUi}</Text>
            ) : null}
            {deal.recommendation === "negotiate" &&
            (deal.negotiateTerms?.length ?? 0) > 0 ? (
              <View style={styles.recoTerms}>
                {deal.negotiateTerms!.slice(0, 3).map((term, i) => (
                  <Text key={i} style={styles.recoTermText}>· {term}</Text>
                ))}
              </View>
            ) : null}
            </View>
          </View>
        ) : null}


        {/* ── 4 · Deal structure — terms as they firm up (PDF terms land here) ── */}
        <AccordionSection
          styles={styles}
          C={C}
          icon="layers"
          title="Deal structure"
          teaser={structureTeaser}
          isOpen={!!open.structure}
          onToggle={() => toggleSection("structure")}
          onLayout={registerSection("structure")}
        >
          {hasStructure ? (
            <Card flat>
              {/* The named figures, once, at the top of the money. A four-year total under a
                  heading that says "Compensation", with no period qualifier, is the most
                  misleading thing this screen could show — when a schedule exists it is
                  written per year, with the total labelled. The full name travels with the
                  acronym (ACV) so an athlete meets the word an agent will use. */}
              {deal.money?.basis === "schedule" && scheduleSummary(deal.money).map((row) => (
                <Row
                  key={row.abbr}
                  label={`${row.name} · ${row.abbr}`}
                  value={row.value}
                  meta={row.note}
                />
              ))}
              {structureRows.map((r, i) => (
                <Row
                  key={r.label}
                  label={r.label}
                  value={r.value ?? null}
                  empty={r.empty}
                  meta={r.meta}
                  lines={r.lines}
                  last={i === structureRows.length - 1}
                />
              ))}
            </Card>
          ) : (
            <EmptyRow
              styles={styles}
              C={C}
              icon="file-text"
              text="No structured terms yet. When the brand shares scope, rate, or usage — including in a PDF — they'll be broken out here."
            />
          )}
        </AccordionSection>

        {/* ── Deal stage — where this sits in the lifecycle (derived from status +
            payment state; no new events table). ── */}
        <View style={styles.section}>
          <SectionHeader styles={styles} icon="git-commit" title="Deal stage" C={C} />
          <StageTrack styles={styles} C={C} status={deal.status} payment={payment} />
        </View>

        {/* ── Payments & activity — real per-deal timeline (messages · agent receipts ·
            money movements). Payment/deposit read 'none' until the escrow engine runs.
            Collapsed by default: it's reference, not part of the decision, and open it
            pushed Mila's recommendation far below the fold. ── */}
        <AccordionSection
          styles={styles}
          C={C}
          icon="activity"
          title="Payments & activity"
          teaser={
            activity.length > 0
              ? `${activity.length} event${activity.length === 1 ? "" : "s"} · payment ${payment?.payment_status ?? "none"}`
              : "No activity recorded yet"
          }
          isOpen={!!open.activity}
          onToggle={() => toggleSection("activity")}
          onLayout={registerSection("activity")}
        >
          <View style={styles.payRow}>
            {payChipsFor(payment).map((c) => (
              <View
                key={c.key}
                style={[
                  styles.payChip,
                  c.solid
                    ? { backgroundColor: c.color }
                    : c.color
                      ? { backgroundColor: c.color + "18" }
                      : styles.payChipEmpty,
                ]}
              >
                {c.check ? (
                  <Feather name="check" size={10} color={c.solid ? "#FFFFFF" : c.text} />
                ) : null}
                <Text
                  style={[
                    styles.payChipText,
                    { color: c.solid ? "#FFFFFF" : (c.text ?? C.textMuted) },
                  ]}
                >
                  {c.label}
                </Text>
              </View>
            ))}
          </View>
          {activity.length > 0 ? (
            <View style={styles.timeline}>
              {activity.map((it, i) => (
                <TimelineRow key={i} styles={styles} C={C} item={it} last={i === activity.length - 1} />
              ))}
            </View>
          ) : (
            <EmptyRow styles={styles} C={C} icon="clock" text="No activity recorded on this deal yet." />
          )}
        </AccordionSection>

        {/* ── 5 · Attachments — PDF proposals the brand sent, stored and openable ── */}
        <AccordionSection
          styles={styles}
          C={C}
          icon="paperclip"
          title="Attachments"
          teaser={attachmentsTeaser}
          isOpen={!!open.attachments}
          onToggle={() => toggleSection("attachments")}
          onLayout={registerSection("attachments")}
        >
          {attachments.length > 0 ? (
            <View style={{ gap: 8 }}>
              {attachments.map((a) => (
                <AttachmentRow
                  key={`${a.messageId}:${a.index}`}
                  styles={styles}
                  C={C}
                  attachment={a}
                  busy={openingAttachment === `${a.messageId}:${a.index}`}
                  error={attachmentError === `${a.messageId}:${a.index}`}
                  onPress={() => openAttachment(a)}
                  onReadAsContract={() => setReadingContract({ messageId: a.messageId, index: a.index })}
                />
              ))}
            </View>
          ) : (
            <EmptyRow
              styles={styles}
              C={C}
              icon="paperclip"
              text="No attachments on this deal. Proposal PDFs from the brand will show up here with their key terms pulled out."
            />
          )}
        </AccordionSection>

        {/* ── About the brand now lives in the swipeable BrandDeckHero above
            (who they are · athletes · audience · fit-for-you), so it is no longer
            a section here. The "brand" deep-link simply lands at the top / hero. ── */}

        {/* ── 7 · Conversation — latest message + jump to the full thread. The
            turn badge is folded into the collapsed teaser (Your/Their turn). ── */}
        <AccordionSection
          styles={styles}
          C={C}
          icon="message-square"
          title="Conversation"
          teaser={threadTeaser}
          isOpen={!!open.thread}
          onToggle={() => toggleSection("thread")}
          onLayout={registerSection("thread")}
        >
          {deal.latestComms ? (
            <View style={styles.bulletCard}>
              {deal.messageCount != null || deal.lastContact ? (
                <Text style={styles.threadMeta}>
                  {[
                    deal.messageCount != null ? messagesLabel(deal.messageCount) : null,
                    deal.lastContact ? `Last contact ${dayLabel(deal.lastContact) ?? deal.lastContact}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              ) : null}
              <Text style={styles.bodyText}>{deal.latestComms}</Text>
            </View>
          ) : (
            <EmptyRow
              styles={styles}
              C={C}
              icon="mail"
              text="No messages captured for this deal yet."
            />
          )}

          {deal.threadId && onViewThread ? (
            <Pressable
              style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.7 }]}
              onPress={() => onViewThread(deal)}
            >
              <Feather name="message-square" size={13} color={C.primary} />
              <Text style={styles.linkRowText}>View full conversation</Text>
              <Feather name="chevron-right" size={14} color={C.primary} />
            </Pressable>
          ) : null}
        </AccordionSection>

        {/* ── 8 · Your pitch — the per-deal Nomi Card (near-term feature slot) ── */}
        <View style={styles.section} onLayout={registerSection("pitch")}>
          <SectionHeader styles={styles} icon="zap" title="Your pitch" C={C} />
          {onOpenPitch ? (
            <Pressable
              style={({ pressed }) => [styles.pitchCta, pressed && { opacity: 0.85 }]}
              onPress={() => onOpenPitch(deal)}
            >
              <View style={styles.pitchCtaIcon}>
                <Feather name="zap" size={15} color="#fff" />
              </View>
              <View style={styles.pitchCtaBody}>
                <Text style={styles.pitchCtaTitle}>Tailor a Nomi Card for {brandDisplayName}</Text>
                <Text style={styles.pitchCtaSub}>
                  A pitch deck built from your media kit, matched to this deal.
                </Text>
              </View>
              <Feather name="chevron-right" size={16} color={C.textMuted} />
            </Pressable>
          ) : (
            <EmptyRow
              styles={styles}
              C={C}
              icon="zap"
              text="A tailored pitch deck for this brand will be available here."
            />
          )}
        </View>
        </View>
        </View>
      </Animated.ScrollView>

      {/* ── Sticky action bar — same resolver as the card, always reachable ── */}
      <View style={styles.actionBar}>
        {actions.waiting ? (
          <View style={styles.waitingPill}>
            <Feather name="clock" size={13} color={C.textMuted} />
            <Text style={styles.waitingText}>Waiting on brand</Text>
          </View>
        ) : primaryAction ? (
          <Pressable
            style={({ pressed }) => [
              styles.primaryBtn,
              { backgroundColor: ACTION_TONE_COLOR[primaryAction.tone] },
              pressed && { opacity: 0.88 },
            ]}
            onPress={() => runAction(primaryAction.kind)}
          >
            <Feather name={primaryAction.icon} size={15} color="#fff" />
            <Text style={styles.primaryBtnText}>{primaryAction.label}</Text>
          </Pressable>
        ) : null}
        {actions.overflow
          .filter((a) => hasHandler(a.kind) && (a.kind === "decline" || a.kind === "dismiss"))
          .slice(0, 1)
          .map((a) => (
            <Pressable
              key={a.kind}
              style={({ pressed }) => [styles.secondaryBtn, pressed && { opacity: 0.7 }]}
              onPress={() => runAction(a.kind)}
            >
              <Feather name={a.icon} size={15} color={C.textMuted} />
            </Pressable>
          ))}
      </View>

      {/* Reading a contract off this deal's own thread. The sheet skips its picker and its
          destination question entirely — the file is already ours and the deal is known,
          so both answers are facts rather than guesses. */}
      {readingContract && (
        <AddContractSheet
          visible
          dealId={dealId}
          attachment={readingContract}
          onClose={() => setReadingContract(null)}
          onCreated={() => { setReadingContract(null); refetch(); }}
        />
      )}
    </View>
  );
}

// ─── Small building blocks ───────────────────────────────────────────────────

type S = ReturnType<typeof createStyles>;
type Palette = (typeof Colors)["light"] | (typeof Colors)["dark"];

/** Nav shell used by the loading / error / not-found whole-screen states. */
function Shell({
  styles,
  onBack,
  title,
  children,
}: {
  styles: S;
  onBack: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.navBar}>
        <Pressable onPress={onBack} hitSlop={10} style={styles.backBtn}>
          <Feather name="chevron-left" size={22} color={styles.navTitle.color as string} />
        </Pressable>
        <View style={styles.navTitleWrap}>
          <Text style={styles.navTitle}>{title}</Text>
        </View>
        <View style={styles.backBtn} />
      </View>
      {children}
    </SafeAreaView>
  );
}

function SectionHeader({
  styles,
  icon,
  title,
  C,
}: {
  styles: S;
  icon: React.ComponentProps<typeof Feather>["name"];
  title: string;
  C: Palette;
}) {
  return (
    <View style={styles.sectionHeader}>
      <Feather name={icon} size={14} color={C.text} />
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
  );
}

/** A collapsible section: header (icon · title · collapsed teaser · chevron) that
 *  toggles its body. The body renders only when open; collapsed shows the teaser.
 *  Keeps the section's `onLayout` on the outer wrapper so deep-link scroll still
 *  measures the same anchor. */
function AccordionSection({
  styles,
  C,
  icon,
  title,
  teaser,
  isOpen,
  onToggle,
  onLayout,
  children,
}: {
  styles: S;
  C: Palette;
  icon: React.ComponentProps<typeof Feather>["name"];
  title: string;
  teaser: string;
  isOpen: boolean;
  onToggle: () => void;
  onLayout?: (e: LayoutChangeEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section} onLayout={onLayout}>
      <Pressable
        style={({ pressed }) => [styles.accordionHeader, pressed && { opacity: 0.6 }]}
        onPress={onToggle}
        hitSlop={6}
      >
        <Feather name={icon} size={12} color={C.textMuted} />
        <Text style={styles.sectionTitle}>{title}</Text>
        {isOpen ? (
          <View style={{ flex: 1 }} />
        ) : (
          <Text style={styles.accordionTeaser} numberOfLines={1}>
            {teaser}
          </Text>
        )}
        <Feather name={isOpen ? "chevron-up" : "chevron-down"} size={16} color={C.textMuted} />
      </Pressable>
      {isOpen ? children : null}
    </View>
  );
}

/** The one honest empty/pending state every section falls back to. */
function EmptyRow({
  styles,
  C,
  icon,
  text,
}: {
  styles: S;
  C: Palette;
  icon: React.ComponentProps<typeof Feather>["name"];
  text: string;
}) {
  return (
    <View style={styles.emptyRow}>
      <Feather name={icon} size={14} color={C.textMuted} />
      <Text style={styles.emptyRowText}>{text}</Text>
    </View>
  );
}

/** Human file size — brands send 4 MB decks, so kB alone reads as noise. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** One tappable attachment: opens a signed link in the system PDF viewer. */
function AttachmentRow({
  styles,
  C,
  attachment,
  busy,
  error,
  onPress,
  onReadAsContract,
}: {
  styles: S;
  C: Palette;
  attachment: DealAttachment;
  busy: boolean;
  error: boolean;
  onPress: () => void;
  onReadAsContract: () => void;
}) {
  const size = formatBytes(attachment.bytes);
  // "Terms not read" is the honest line for a file we stored but never parsed —
  // without it the row implies the deal reflects this document when it doesn't.
  const meta = [size, attachment.parsed ? null : "Terms not read"].filter(Boolean).join(" · ");

  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={`Open ${attachment.filename}`}
      style={({ pressed }) => [styles.attachmentRow, pressed && { opacity: 0.6 }]}
    >
      <Feather name="file-text" size={16} color={C.textMuted} />
      <View style={{ flex: 1 }}>
        <Text style={styles.attachmentName} numberOfLines={1}>
          {attachment.filename}
        </Text>
        {error ? (
          <Text style={[styles.attachmentMeta, { color: RATING_COLOR.poor }]}>
            Could not open — tap to retry
          </Text>
        ) : meta ? (
          <Text style={styles.attachmentMeta}>{meta}</Text>
        ) : null}
      </View>
      {busy ? (
        <ActivityIndicator size="small" color={C.textMuted} />
      ) : (
        <>
          {/* A thread often carries several PDFs — a proposal, a brief, the agreement —
              and only she knows which is which, so every one of them offers this. */}
          <Pressable
            onPress={onReadAsContract}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Read ${attachment.filename} as this deal's contract`}
          >
            <Text style={styles.attachmentRead}>Read terms</Text>
          </Pressable>
          <Feather name="external-link" size={14} color={C.textMuted} />
        </>
      )}
    </Pressable>
  );
}

// ─── Deal stage track ─────────────────────────────────────────────────────────

const STAGE_STEPS = ["Outreach", "Qualify", "Negotiate", "Contract", "Activate", "Execute", "Complete"] as const;

// The current segment takes the deal's own status colour, so the track agrees with the
// status semantics used everywhere else rather than inventing a second vocabulary.
const STAGE_NOW_COLOR: Record<string, string> = {
  detected:    "#EAB308",
  pending:     "#EAB308",
  negotiating: "#3B82F6",
  accepted:    "#22C55E",
  completed:   "#10B981",
};

// The LABEL needs a different value from the segment. A 5px bar can carry a bright fill,
// but the same gold as 8px text on white is unreadable — these are the darkened pairs the
// app already uses for text (the deadline chip's #C4850D, etc.).
const STAGE_NOW_TEXT: Record<string, string> = {
  detected:    "#C4850D",
  pending:     "#C4850D",
  negotiating: "#1E6FCC",
  accepted:    "#15803D",
  completed:   "#0E9F6E",
};

const STATUS_STAGE: Record<string, number> = {
  detected: 0,
  pending: 1,
  negotiating: 2,
  accepted: 3,
  completed: 6,
};

/** Where the deal sits on the 7-step track, from status + payment state (no events table).
 *  -1 = rejected/terminal (rendered as "Declined"). */
function deriveStageIndex(status: string, payment: DealPaymentState | null): number {
  if (status === "rejected") return -1;
  let idx = STATUS_STAGE[status] ?? 0;
  if (payment) {
    if (payment.deposit_status === "held") idx = Math.max(idx, 3);
    if (["funded", "delivered_pending_confirmation"].includes(payment.payment_status)) idx = Math.max(idx, 4);
    if (payment.payment_status === "settled") idx = 6;
  }
  return idx;
}

function StageTrack({
  styles,
  status,
  payment,
}: {
  styles: S;
  C: Palette;
  status: string;
  payment: DealPaymentState | null;
}) {
  const current = deriveStageIndex(status, payment);
  if (current < 0) {
    return (
      <View style={styles.declinedPill}>
        <Feather name="x-circle" size={13} color={RATING_COLOR.poor} />
        <Text style={styles.declinedText}>Declined — this deal is closed.</Text>
      </View>
    );
  }
  // Segmented bar, not dots-and-connectors: seven equal segments read as progress through
  // a pipeline at a glance, and the label sits under its own segment so "where am I" needs
  // no counting. The current segment carries a soft glow ring in its status colour.
  const nowColor = STAGE_NOW_COLOR[status] ?? Bold.ink;
  const nowText  = STAGE_NOW_TEXT[status] ?? "#1E6FCC";

  return (
    <View style={{ gap: 8 }}>
      <View style={styles.track}>
        {STAGE_STEPS.map((label, i) => (
          <View
            key={label}
            style={[
              styles.seg,
              i < current && styles.segDone,
              i === current && {
                backgroundColor: nowColor,
                shadowColor: nowColor,
                shadowOpacity: 0.35,
                shadowRadius: 4,
                shadowOffset: { width: 0, height: 0 },
                elevation: 2,
              },
            ]}
          />
        ))}
      </View>
      <View style={styles.trackLabels}>
        {STAGE_STEPS.map((label, i) => (
          <Text
            key={label}
            numberOfLines={1}
            style={[
              styles.trackLabel,
              i < current && styles.trackLabelDone,
              i === current && [styles.trackLabelNow, { color: nowText }],
            ]}
          >
            {label}
          </Text>
        ))}
      </View>
    </View>
  );
}

// ─── Activity timeline row ────────────────────────────────────────────────────

// Payment state → the chips that describe it. Colour carries the meaning: green for money
// that actually landed (solid once paid in full), gold for something owed, blue for a
// request in flight, and a plain outlined chip for "nothing has happened yet" — which is
// the honest reading until the escrow engine runs, not an error.
type PayChip = { key: string; label: string; color?: string; text?: string; solid?: boolean; check?: boolean };

function payChipsFor(payment: { deposit_status?: string | null; payment_status?: string | null } | null | undefined): PayChip[] {
  const dep = payment?.deposit_status ?? "none";
  const pay = payment?.payment_status ?? "none";
  const chips: PayChip[] = [];

  if (dep === "held")      chips.push({ key: "dep", label: "Deposit held",  color: "#10B981", text: "#0E9F6E", check: true });
  else if (dep === "released") chips.push({ key: "dep", label: "Deposit released", color: "#10B981", text: "#0E9F6E", check: true });
  else if (dep !== "none") chips.push({ key: "dep", label: "Deposit due",   color: Bold.ink, text: Bold.ink });

  if (pay === "settled")   chips.push({ key: "pay", label: "Paid in full", color: "#10B981", solid: true, check: true });
  else if (pay === "funded")   chips.push({ key: "pay", label: "Funded",        color: "#10B981", text: "#0E9F6E", check: true });
  else if (pay === "payment_requested") chips.push({ key: "pay", label: "Invoice sent", color: Bold.ink, text: Bold.ink });
  else if (pay === "disputed") chips.push({ key: "pay", label: "Disputed",      color: "#EF4444", text: "#DC2626" });
  else if (pay !== "none") chips.push({ key: "pay", label: pay.replace(/_/g, " "), color: Bold.ink, text: Bold.ink });

  if (chips.length === 0) chips.push({ key: "none", label: "No payment activity yet" });
  return chips;
}

const TL_COLOR: Record<DealActivityItem["type"], string> = {
  detected: Bold.ink,
  message:  Bold.ink,
  agent:    Bold.mute,
  payment:  Bold.ink,
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDay(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// A timeline row has three dot states, because "it happened", "money landed", and "this is
// still expected" are different claims and a single grey dot made them look identical:
//   · default — hollow grey ring: a recorded event
//   · done    — filled green with a check: a completed money movement
//   · next    — dashed ring, muted copy: an EXPECTED future event, not a fact yet
const PAID_GREEN = "#10B981";
const PAID_TEXT  = "#0E9F6E";

function TimelineRow({
  styles,
  C,
  item,
  last,
}: {
  styles: S;
  C: Palette;
  item: DealActivityItem;
  last: boolean;
}) {
  const isDone = item.type === "payment";
  const isNext = (item as any).expected === true;

  return (
    <View style={styles.tlRow}>
      <View style={styles.tlRail}>
        <View
          style={[
            styles.tlDot,
            isDone
              ? { backgroundColor: PAID_GREEN, borderColor: PAID_GREEN }
              : isNext
                ? { borderColor: C.textMuted, borderStyle: "dashed" }
                : { borderColor: TL_COLOR[item.type] ?? "#C5BFB8" },
          ]}
        >
          {isDone ? <Feather name="check" size={7} color="#FFFFFF" /> : null}
        </View>
        {!last ? <View style={styles.tlLine} /> : null}
      </View>
      <View style={styles.tlBody}>
        {/* Timestamp leads the row, uppercase and tabular, so a scan down the rail reads
            as a chronology rather than as a list of headlines. */}
        {item.ts ? <Text style={styles.tlTime}>{formatDay(item.ts)}</Text> : null}
        <View style={styles.tlHead}>
          <Text
            style={[
              styles.tlTitle,
              isDone ? { color: PAID_TEXT } : null,
              isNext ? styles.tlTitleNext : null,
            ]}
            numberOfLines={1}
          >
            {item.title}
          </Text>
          {(item as any).source ? (
            <Text style={styles.tlSrc}>{(item as any).source}</Text>
          ) : null}
        </View>
        {item.detail ? <Text style={styles.tlDetail} numberOfLines={2}>{item.detail}</Text> : null}
      </View>
    </View>
  );
}

// ─── Styles (theme-derived; memoized per scheme in the component) ────────────

function createStyles(C: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: C.backgroundRoot },

    // Nav — floating circles over the photo, not a bar.
    navFloat: {
      position: "absolute",
      left: Spacing.md,
      right: Spacing.md,
      zIndex: 20,
      flexDirection: "row",
      alignItems: "center",
    },
    circleBtn: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(255,255,255,0.92)",
      shadowColor: "#000",
      shadowOpacity: 0.22,
      shadowRadius: 4,
      shadowOffset: { width: 0, height: 1 },
      elevation: 3,
    },
    navBar: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      gap: Spacing.sm,
    },
    backBtn: {
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
    },
    navTitleWrap: { flex: 1, alignItems: "center" },
    navTitle: {
      fontFamily: Fonts.headingSemiBold,
      fontSize: 16,
      color: C.text,
    },
    navSubtitle: {
      fontFamily: Fonts.bodyMedium,
      fontSize: 11,
      color: C.textMuted,
    },

    // Whole-screen states
    centerFill: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      paddingHorizontal: Spacing["3xl"],
    },
    centerFillTitle: {
      fontFamily: Fonts.headingSemiBold,
      fontSize: 16,
      color: C.text,
      textAlign: "center",
    },
    centerFillText: {
      fontFamily: Fonts.body,
      fontSize: 13,
      color: C.textMuted,
      textAlign: "center",
      lineHeight: 19,
    },
    retryBtn: {
      marginTop: Spacing.xs,
      borderWidth: 1,
      borderColor: C.border,
      borderRadius: BorderRadius.full,
      paddingHorizontal: Spacing.xl,
      paddingVertical: Spacing.sm,
    },
    retryText: {
      fontFamily: Fonts.bodySemiBold,
      fontSize: 13,
      color: C.textSecondary,
    },

    // Scroll
    scroll: { flex: 1 },
    scrollContent: {
      paddingHorizontal: Spacing.lg,
      // No bottom padding and no gap: the sheet is the only child and owns both. Any
      // padding here would show page ground BELOW the white surface, which is exactly
      // the seam this screen is meant not to have.
    },
    // The deck + sheet as one unit, bleeding past scrollContent's horizontal padding.
    // NO `gap` here — the sheet's negative marginTop is the only thing between them, so
    // the overlap is exactly what that margin says it is.
    //
    // The dark ground sits on THIS node, which is not transformed. Putting it on the
    // animated deck (as a previous attempt did) meant it scaled away with the photo, so
    // the fade still exposed the page background at the sides.
    heroStack: {
      marginHorizontal: -Spacing.lg,
      marginTop: -Spacing.sm,
      backgroundColor: "#0E0D0B",
    },
    // Layout now lives on heroStack; this node only carries the scroll animation.
    heroDeck: {},

    // The content sheet — ONE surface from the photo to the end of the page.
    //
    // Everything below the deck lives in here: the summary, the recommendation, the
    // score breakdown, terms, attachments, the conversation. Previously the summary
    // closed itself off with a bottom radius and the rest of the page sat on the ground
    // beneath it, so the screen read as two stacked cards with a seam between them —
    // the opposite of the Airbnb-style detail this is modelled on, where the sheet
    // simply continues and hairlines do the dividing.
    //
    // Hence NO bottom radius and no bottom margin: the surface runs off the end of the
    // scroll. The rounded TOP edge and the lift over the photo are the only separation
    // it needs.
    sheet: {
      backgroundColor: C.card,
      borderTopLeftRadius: 26,
      borderTopRightRadius: 26,
      // heroStack already bleeds to the screen edges, so no horizontal margin here.
      // Overlap by MORE than the 26px corner radius so the whole arc sits on the photo
      // with slack to spare, instead of hanging over the page ground. The deck reads the
      // same constant to keep its own bottom content clear of this.
      marginTop: -SHEET_OVERLAP,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.lg + 4,
      // Runs under the sticky action bar, which supplies its own inset.
      paddingBottom: Spacing["3xl"] * 2,
      // The rhythm BETWEEN sections. Inside a section, its own gap is tighter, so the
      // page reads as grouped bands rather than an even list of rows.
      gap: Spacing.xl,
      shadowColor: "#000",
      shadowOpacity: 0.05,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: -3 },
      elevation: 2,
    },
    // The summary block — now purely an internal group inside the sheet. It carries no
    // surface of its own; the sheet is the surface.
    hero: {
      gap: Spacing.md,
    },
    // Chip line + score, mirroring the collapsed card's foot.
    heroFoot: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: Spacing.md,
    },
    heroChips: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 6,
    },
    heroSource: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      flexShrink: 1,
    },
    catChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: BorderRadius.full,
    },
    catChipText: {
      fontFamily: Fonts.bodySemiBold,
      fontSize: 11,
    },
    heroTopRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
    },
    heroLogoWrap: { position: "relative", flexShrink: 0 },
    catBadge: {
      position: "absolute",
      bottom: -3,
      left: -3,
      width: 20,
      height: 20,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 2,
      borderColor: C.card,
    },
    heroMeta: { flex: 1, gap: 3 },
    heroBrand: {
      fontFamily: Fonts.bodySemiBold,
      fontSize: 18,
      color: C.text,
    },
    heroCategory: {
      fontFamily: Fonts.bodyMedium,
      fontSize: 11,
      color: C.textMuted,
    },
    heroMetaRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    statusPill: {
      borderRadius: BorderRadius.full,
      paddingHorizontal: 7,
      paddingVertical: 2,
      backgroundColor: C.text,
    },
    statusPillText: {
      fontFamily: Fonts.bodySemiBold,
      fontSize: 10,
      letterSpacing: 0.5,
      color: C.card,
    },
    heroSourceText: {
      fontFamily: Fonts.bodyMedium,
      fontSize: 11,
      color: C.textMuted,
      flexShrink: 1,
    },
    heroVerdict: {
      fontFamily: Fonts.bodySemiBold,
      fontSize: 11,
    },
    heroOfferRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: Spacing.sm,
    },
    heroOffer: {
      flex: 1,
      fontFamily: Fonts.display,
      fontSize: 17,
      color: C.text,
      letterSpacing: -0.2,
      lineHeight: 22,
    },
    heroNoOffer: {
      fontFamily: Fonts.bodyMedium,
      fontSize: 12,
      color: C.textMuted,
      fontStyle: "italic",
    },
    rateChip: {
      borderRadius: BorderRadius.full,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    rateChipText: {
      fontFamily: Fonts.bodySemiBold,
      fontSize: 10,
      letterSpacing: 0.2,
    },
    heroSummary: {
      fontFamily: Fonts.body,
      fontSize: 13,
      color: C.textSecondary,
      lineHeight: 19,
    },
    deadlineChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      alignSelf: "flex-start",
      backgroundColor: Bold.ground,
      borderRadius: BorderRadius.full,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    deadlineText: {
      fontFamily: Fonts.bodySemiBold,
      fontSize: 12,
      color: Bold.ink,
    },

    // Recommendation
    // A soft surface, not a bordered card. It still reads as "this is Mila speaking"
    // at a glance, which is the reason to keep it, but the heading above now carries the
    // separation so the accent bar was doing the same job twice.
    recoCard: {
      backgroundColor: C.primary + "0A",
      borderRadius: BorderRadius.md,
      padding: Spacing.lg,
      gap: Spacing.sm,
    },
    recoText: {
      fontFamily: Fonts.bodySemiBold,
      fontSize: 14,
      color: C.primary,
      lineHeight: 20,
    },
    recoTerms: { gap: 4 },
    recoTermText: {
      fontFamily: Fonts.body,
      fontSize: 13,
      color: C.textSecondary,
      lineHeight: 19,
    },

    // Sections
    section: { gap: 10 },
    sectionHeaderRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    // The hairline is the divider the cards used to be. Airbnb-style: a rule and space
    // above each heading, so the sheet reads as sections rather than one long column.
    sectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      paddingTop: Spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: C.borderLight,
    },
    accordionHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingVertical: 2,
    },
    accordionTeaser: {
      flex: 1,
      textAlign: "right",
      fontFamily: Fonts.bodyMedium,
      fontSize: 12,
      color: C.textMuted,
    },
    // Promoted from an 11px uppercase eyebrow to an actual heading.
    //
    // While every section sat on its own card, the card edge did the dividing and the
    // label only had to name the block. On one continuous sheet the headings ARE the
    // structure, so they have to be findable when scanning — and 11px muted uppercase is
    // the least legible combination the type scale offers. Sentence case at 16px in the
    // text colour reads at a glance and matches the listing detail this screen follows.
    sectionTitle: {
      fontFamily: Fonts.bodySemiBold,
      fontSize: 16,
      color: C.text,
      letterSpacing: -0.15,
    },

    // Grid (factor / structure rows)
    moneySummary: {
    backgroundColor: Colors.light.card,
    borderRadius: BorderRadius.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.light.border,
    paddingHorizontal: Spacing.md,
    marginBottom: Spacing.md,
  },
  moneyRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingVertical: Spacing.sm,
    gap: Spacing.md,
  },
  moneyLabel: { flex: 1 },
  moneyAbbr: {
    fontFamily: Fonts.headingSemiBold,
    fontSize: 13,
    color: Colors.light.text,
    letterSpacing: 0.4,
  },
  moneyName: {
    fontFamily: Fonts.body,
    fontSize: 11,
    color: Colors.light.textMuted,
    marginTop: 1,
  },
  moneyRight: { alignItems: "flex-end" },
  moneyValue: {
    fontFamily: Fonts.headingSemiBold,
    fontSize: 15,
    color: Colors.light.text,
    fontVariant: ["tabular-nums"],
  },
  moneyNote: {
    fontFamily: Fonts.body,
    fontSize: 10.5,
    color: Colors.light.textMuted,
    marginTop: 1,
    textAlign: "right",
  },
  grid: {
      backgroundColor: C.card,
      borderRadius: BorderRadius.sm,
      paddingVertical: 4,
      paddingHorizontal: Spacing.md,
      borderWidth: 1,
      borderColor: C.borderLight,
    },
    gridRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: Spacing.sm,
      paddingVertical: 9,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: C.borderLight,
    },
    gridLabel: {
      fontFamily: Fonts.bodyMedium,
      fontSize: 13,
      color: C.textMuted,
      width: 110,
      flexShrink: 0,
    },
    gridValue: {
      flex: 1,
      fontFamily: Fonts.body,
      fontSize: 13,
      color: C.text,
      lineHeight: 19,
    },
    gridValueMuted: { color: C.textMuted, fontStyle: "italic" },
    ratingDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      marginTop: 5,
      flexShrink: 0,
    },

    // Bullet / body cards
    bulletCard: {
      backgroundColor: C.card,
      borderRadius: BorderRadius.sm,
      padding: Spacing.md,
      gap: 8,
      borderWidth: 1,
      borderColor: C.borderLight,
    },
    bulletRow: { flexDirection: "row", alignItems: "flex-start", gap: 9 },
    bulletDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      marginTop: 6,
      flexShrink: 0,
    },
    bulletText: {
      flex: 1,
      fontFamily: Fonts.body,
      fontSize: 13,
      color: C.textSecondary,
      lineHeight: 19,
    },
    bodyText: {
      fontFamily: Fonts.body,
      fontSize: 13,
      color: C.textSecondary,
      lineHeight: 20,
    },
    subLabel: {
      fontFamily: Fonts.bodySemiBold,
      fontSize: 11,
      color: C.textMuted,
      letterSpacing: 0.4,
      textTransform: "uppercase",
    },
    inferredNote: {
      fontFamily: Fonts.body,
      fontSize: 11,
      color: C.textMuted,
      fontStyle: "italic",
    },
    threadMeta: {
      fontFamily: Fonts.body,
      fontSize: 11,
      color: C.textMuted,
    },

    // Red flags
    flagCard: {
      backgroundColor: Bold.ground,
      borderRadius: BorderRadius.sm,
      padding: Spacing.md,
      gap: 8,
    },
    flagHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
    flagHeaderText: {
      fontFamily: Fonts.bodySemiBold,
      fontSize: 11,
      color: "#B45309",
      letterSpacing: 0.4,
      textTransform: "uppercase",
    },

    // Brand extras
    tierPill: {
      alignSelf: "flex-start",
      borderRadius: BorderRadius.full,
      paddingHorizontal: 10,
      paddingVertical: 3,
    },
    tierPillText: {
      fontFamily: Fonts.bodySemiBold,
      fontSize: 11,
      letterSpacing: 0.2,
    },
    tagRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    tag: {
      backgroundColor: Bold.ground,
      borderRadius: BorderRadius.full,
      paddingHorizontal: 12,
      paddingVertical: 5,
    },
    tagText: {
      fontFamily: Fonts.bodyMedium,
      fontSize: 12,
      color: Bold.ink,
    },

    // Turn badge
    turnBadge: {
      backgroundColor: C.primary + "18",
      borderRadius: BorderRadius.full,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    turnBadgeMuted: { backgroundColor: C.backgroundSecondary },
    turnBadgeText: {
      fontFamily: Fonts.bodySemiBold,
      fontSize: 10,
      color: C.primary,
      letterSpacing: 0.3,
    },

    // Link rows
    linkRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingVertical: Spacing.sm,
      paddingHorizontal: 2,
    },
    linkRowText: {
      flex: 1,
      fontFamily: Fonts.bodySemiBold,
      fontSize: 13,
      color: C.primary,
    },

    // Empty/pending rows
    attachmentRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: C.backgroundDefault,
      borderRadius: BorderRadius.sm,
      padding: Spacing.md,
      borderWidth: 1,
      borderColor: C.borderLight,
    },
    attachmentName: {
      fontFamily: Fonts.body,
      fontSize: 13,
      color: C.text,
    },
    attachmentMeta: {
      fontFamily: Fonts.body,
      fontSize: 11,
      color: C.textMuted,
      marginTop: 2,
    },
    attachmentRead: { fontFamily: Fonts.bodyMedium, fontSize: 12, color: C.primary },
    emptyRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 9,
      backgroundColor: C.backgroundDefault,
      borderRadius: BorderRadius.sm,
      padding: Spacing.md,
      borderWidth: 1,
      borderColor: C.borderLight,
      borderStyle: "dashed",
    },
    emptyRowText: {
      flex: 1,
      fontFamily: Fonts.body,
      fontSize: 13,
      color: C.textMuted,
      lineHeight: 19,
    },

    // Pitch CTA
    pitchCta: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      backgroundColor: C.card,
      borderRadius: BorderRadius.sm,
      padding: Spacing.md,
      borderWidth: 1,
      borderColor: C.primary + "30",
    },
    pitchCtaIcon: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: C.primary,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    pitchCtaBody: { flex: 1, gap: 2 },
    pitchCtaTitle: {
      fontFamily: Fonts.bodySemiBold,
      fontSize: 13,
      color: C.text,
    },
    pitchCtaSub: {
      fontFamily: Fonts.body,
      fontSize: 12,
      color: C.textMuted,
      lineHeight: 17,
    },

    // Sticky action bar
    actionBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.sm,
      paddingBottom: Spacing.lg,
      borderTopWidth: 1,
      borderTopColor: C.borderLight,
      backgroundColor: C.backgroundRoot,
    },
    primaryBtn: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      height: 46,
      borderRadius: BorderRadius.full,
    },
    primaryBtnText: {
      fontFamily: Fonts.bodySemiBold,
      fontSize: 14,
      color: "#fff",
    },
    secondaryBtn: {
      width: 46,
      height: 46,
      borderRadius: BorderRadius.full,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: C.border,
    },
    waitingPill: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 7,
      height: 46,
      borderRadius: BorderRadius.full,
      backgroundColor: C.backgroundDefault,
      borderWidth: 1,
      borderColor: C.borderLight,
    },
    waitingText: {
      fontFamily: Fonts.bodyMedium,
      fontSize: 13,
      color: C.textMuted,
    },

    // Stage track
    // 7-segment progress bar + a label under each segment.
    track: { flexDirection: "row", gap: 4, paddingVertical: 2 },
    seg: { flex: 1, height: 5, borderRadius: 3, backgroundColor: C.backgroundSecondary },
    segDone: { backgroundColor: "#1C1915" },
    trackLabels: { flexDirection: "row", gap: 4, marginTop: 3 },
    trackLabel: {
      flex: 1,
      textAlign: "center",
      fontFamily: Fonts.body,
      fontSize: 8,
      color: C.textMuted,
    },
    trackLabelDone: { color: C.textSecondary },
    trackLabelNow: { fontFamily: Fonts.bodyBold, fontSize: 8.5 },
    declinedPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      backgroundColor: C.backgroundDefault,
      borderRadius: BorderRadius.sm,
      paddingVertical: 10,
      paddingHorizontal: 12,
    },
    declinedText: { fontFamily: Fonts.bodyMedium, fontSize: 13, color: C.textSecondary },

    // Payments
    // Payment state reads through COLOUR, not through a label/value dump. A row of
    // semantic pills answers "where is the money" at a glance; "DEPOSIT: none" did not.
    payRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: Spacing.sm },
    payChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingVertical: 4,
      paddingHorizontal: 10,
      borderRadius: BorderRadius.full,
    },
    payChipEmpty: {
      backgroundColor: C.card,
      borderWidth: 1,
      borderColor: C.borderLight,
    },
    payChipText: { fontFamily: Fonts.bodySemiBold, fontSize: 11 },

    // Activity timeline
    timeline: { marginTop: 4 },
    tlRow: { flexDirection: "row", gap: 12 },
    tlRail: { width: 12, alignItems: "center" },
    tlDot: {
      width: 12,
      height: 12,
      borderRadius: 6,
      borderWidth: 2,
      backgroundColor: C.card,
      marginTop: 3,
      alignItems: "center",
      justifyContent: "center",
    },
    tlLine: { flex: 1, width: 1.5, backgroundColor: C.borderLight, marginVertical: 2 },
    tlBody: { flex: 1, paddingBottom: 15 },
    tlHead: { flexDirection: "row", alignItems: "center", gap: 6 },
    tlTitle: { flex: 1, fontFamily: Fonts.bodySemiBold, fontSize: 13, color: C.text },
    tlTitleNext: { fontFamily: Fonts.bodyMedium, color: C.textSecondary },
    tlSrc: {
      fontFamily: Fonts.bodySemiBold,
      fontSize: 9.5,
      color: C.textSecondary,
      backgroundColor: C.backgroundSecondary,
      borderWidth: 1,
      borderColor: C.borderLight,
      borderRadius: 5,
      paddingHorizontal: 6,
      paddingVertical: 1,
      overflow: "hidden",
    },
    tlTime: {
      fontFamily: Fonts.bodyBold,
      fontSize: 10,
      letterSpacing: 0.9,
      textTransform: "uppercase",
      color: C.textMuted,
      fontVariant: ["tabular-nums"],
      marginBottom: 1,
    },
    tlDetail: { fontFamily: Fonts.body, fontSize: 12, color: C.textMuted, marginTop: 1 },
  });
}
