// ClassicListV2 — a redesigned visual variant of the Classic deal list, built for
// an on-device A/B against the current Classic. It renders the SAME rich DealCard
// (with collapsed action buttons hidden) — the card style is untouched. What differs
// is the control HEADER and the removal of the money hero:
//
//   Row 1 · a search bar (over brand · advertiser · aiSummary) + a bookmark toggle
//   Row 2 · the existing CategoryFilter chips (reused as-is)
//   Row 3 · a compact status PILL (reusing StageDropdown's stage values) + a live count
//
// All filter state (search / category / stage / savedOnly) lives INSIDE here, so the
// component is self-contained. The root is a virtualized FlatList that scrolls itself.

import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  TextInput,
  ActivityIndicator,
  FlatList,
  type RefreshControlProps,
} from "react-native";
import { Feather, Ionicons } from "@expo/vector-icons";
import { type CategoryId } from "./CategoryFilter";
import { haptics } from "../../lib/haptics";

// Category filter — the ORIGINAL CategoryFilter icons (identical Ionicons + colors),
// rendered smaller and muted until selected. Inactive circles are a soft tint; the
// selected one fills to the full solid color with a white icon, matching the original.
const CATS: { id: CategoryId; label: string; icon: keyof typeof Ionicons.glyphMap; color: string }[] = [
  // One look (23 Oct 2026): the selected filter fills ink — never a ring colour (those mean the score).
  { id: "ALL",       label: "All",       icon: "infinite-outline",  color: Bold.ink },
  { id: "PAID",      label: "Paid",      icon: "cash-outline",      color: Bold.ink },
  { id: "MEDIA",     label: "Media",     icon: "mic-outline",       color: Bold.ink },
  { id: "EDITORIAL", label: "Product review", icon: "newspaper-outline", color: Bold.ink },
  { id: "GIFTING",   label: "Gifting",   icon: "gift-outline",      color: Bold.ink },
];
import { type DealItem, type DealStatus } from "./DealCard";
import { BrandDealCard } from "./BrandDealCard";
import type { DealDetailSection } from "../../screens/DealDetailScreen";
import { STAGES, type StageKey } from "./StageDropdown";
import { useDeals, useDealCounts } from "../../hooks/use-deals";
import { AnchoredMenu, type AnchoredMenuItem } from "./AnchoredMenu";
import { Bold, Fonts, Colors, Spacing, BorderRadius } from "../../constants/theme";

interface ClassicListV2Props {
  deals:          DealItem[];
  isLoading:      boolean;
  error:          Error | null;
  expandedId:     string | null;
  decliningId:    string | null;
  onToggleExpand: (dealId: string) => void;
  onAccept:       (deal: DealItem) => void;
  onNegotiate:    (deal: DealItem) => void;
  onDecline:      (dealId: string) => void;
  onSetStatus:    (dealId: string, status: DealStatus) => void;
  onToggleSaved:  (dealId: string, saved: boolean) => void;
  onViewThread:   (deal: DealItem) => void;
  onOpenDetail?:  (dealId: string, section?: DealDetailSection) => void;
  /** Swipe-down refresh (ui/PullRefresh), owned by the screen. */
  refreshControl?: React.ReactElement<RefreshControlProps>;
}

// Map a deal status to its dropdown stage (detected + pending = "new").
// (Same mapping the current OpportunitiesScreen uses.)
const stageOf = (s: DealStatus): StageKey =>
  s === "negotiating" ? "negotiating" :
  s === "accepted"    ? "accepted"    :
  s === "completed"   ? "completed"   :
  s === "rejected"    ? "declined"    :
  "new";

// Auto-archived (dormant) deals live on the ARCHIVED thread status — a thread-level
// state, not a deal status. They're hidden from every stage except "Archived".
const isArchived = (d: DealItem): boolean => d.threadStatus === "archived";

export function ClassicListV2({
  refreshControl,
  deals,
  isLoading,
  error,
  expandedId,
  decliningId,
  onToggleExpand,
  onAccept,
  onNegotiate,
  onDecline,
  onSetStatus,
  onToggleSaved,
  onViewThread,
  onOpenDetail,
}: ClassicListV2Props) {
  // Self-contained filter state, initialized to the same defaults as Classic.
  const [query, setQuery]       = useState("");
  const [category, setCategory] = useState<CategoryId>("ALL");
  const [stage, setStage]       = useState<StageKey>("all");
  const [savedOnly, setSavedOnly] = useState(false);

  // ── Archived, fetched only when asked for ──
  // `deals` is now the ACTIVE list — filed deals are not in it. They are fetched the moment
  // this tab is opened and not before, so the default screen carries 35 rows instead of 100.
  // The chip's number comes from the server, because the rows behind it are not here to count.
  const { deals: archivedDeals, isLoading: archivedLoading } = useDeals("archived", stage === "archived");
  const { archived: archivedCount } = useDealCounts();

  const source = stage === "archived" ? archivedDeals : deals;
  // The Archived tab has its own fetch, so it needs its own spinner — otherwise opening it
  // shows the empty state for as long as the request takes, which reads as "nothing filed"
  // when in fact 169 things are.
  const loading = stage === "archived" ? archivedLoading : isLoading;

  // ── Filtering — category → search → stage / savedOnly (mirrors Classic) ──
  const categoryDeals = useMemo(
    () =>
      category === "ALL"
        ? source
        : source.filter((d) => d.category === category),
    [source, category],
  );

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return categoryDeals;
    return categoryDeals.filter((d) =>
      [d.brandName, d.advertiser ?? "", d.aiSummary ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [categoryDeals, query]);

  const stageCounts = useMemo(() => {
    const counts: Record<StageKey, number> = {
      all: 0, new: 0, negotiating: 0, accepted: 0, completed: 0, declined: 0, archived: 0,
    };
    // Archived deals count ONLY toward "archived"; every other stage (incl. "all") is
    // the active set, so archiving genuinely declutters the default Explore view.
    for (const d of searched) {
      if (isArchived(d)) { counts.archived += 1; continue; }
      counts.all += 1;
      counts[stageOf(d.status)] += 1;
    }
    // The archived total comes from the server whenever those rows are not loaded — which is
    // every view except this one. It is deliberately NOT scoped to the search box: the rows to
    // search are not here, and a global total is honest where a zero would simply be wrong.
    if (stage !== "archived") counts.archived = archivedCount;
    return counts;
  }, [searched, stage, archivedCount]);

  const dealsToShow = useMemo(
    () => {
      const base =
        stage === "archived"
          ? searched                                                      // already archived-only
          : savedOnly
            ? searched.filter((d) => d.saved && !isArchived(d))
            : stage === "all"
              ? searched.filter((d) => !isArchived(d))                     // active only
              : searched.filter((d) => !isArchived(d) && stageOf(d.status) === stage);
      return base.filter((d) => d.id !== decliningId);
    },
    [searched, savedOnly, stage, decliningId],
  );

  const currentStage = STAGES.find((s) => s.key === stage) ?? STAGES[0];
  const resultCount  = dealsToShow.length;

  const stageItems: AnchoredMenuItem[] = STAGES.map((s) => ({
    key:     s.key,
    label:   s.label,
    count:   stageCounts[s.key] ?? 0,
    active:  s.key === stage,
    onPress: () => setStage(s.key),
  }));

  const listHeader = (
    <View style={styles.headerWrap}>
      {/* ── Row 1 · search + bookmark toggle ── */}
      <View style={styles.searchRow}>
        <View style={styles.searchBar}>
          <Feather name="search" size={15} color="#9C968D" />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Search brands, offers, notes…"
            placeholderTextColor="#B8B0A6"
            autoCorrect={false}
            returnKeyType="search"
          />
          {query.length > 0 && (
            <Pressable onPress={() => setQuery("")} hitSlop={8}>
              <Feather name="x" size={15} color="#9C968D" />
            </Pressable>
          )}
        </View>
        <Pressable
          onPress={() => setSavedOnly((v) => !v)}
          hitSlop={8}
          style={[styles.bookmarkToggle, savedOnly && styles.bookmarkToggleActive]}
        >
          <Feather
            name="bookmark"
            size={17}
            color={savedOnly ? Colors.light.primary : "#9C968D"}
          />
        </Pressable>
      </View>

      {/* ── Row 2 · category filter — the ORIGINAL CategoryFilter treatment (colored
          circle + white icon + label below), just SMALLER and MUTED until selected:
          inactive = soft tinted circle with the colored icon; active = the full solid
          color circle with a white icon + shadow (exactly the original's selected look). ── */}
      <View style={styles.catRow}>
        {CATS.map((c) => {
          const active = category === c.id;
          return (
            <Pressable
              key={c.id}
              onPress={() => { haptics.select(); setCategory(c.id); }}
              style={styles.catItem}
              hitSlop={4}
            >
              <View style={[
                styles.catCircle,
                active
                  ? [{ backgroundColor: c.color }, styles.catCircleActive]
                  : { backgroundColor: c.color + "1F" },   // ~12% tint — muted until clicked
              ]}>
                <Ionicons
                  name={c.icon}
                  size={17}
                  color={active ? Colors.light.buttonText : c.color + "9E"}
                />
              </View>
              <Text style={[styles.catLabel, { color: active ? c.color : "#AAAAAA" }]}>
                {c.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* ── Row 3 · status pill + live result count ── */}
      <View style={styles.statusRow}>
        <AnchoredMenu
          align="left"
          minWidth={220}
          items={stageItems}
          triggerStyle={styles.statusPillTrigger}
          trigger={(open) => (
            <View style={styles.statusPill}>
              <Text style={styles.statusPillText}>Status: {currentStage.label}</Text>
              <Feather
                name={open ? "chevron-up" : "chevron-down"}
                size={14}
                color={Colors.light.primary}
              />
            </View>
          )}
        />
        <View style={{ flex: 1 }} />
        <Text style={styles.resultCount}>
          {resultCount} {resultCount === 1 ? "deal" : "deals"}
        </Text>
      </View>
    </View>
  );

  const listEmpty = loading ? (
    <View style={styles.centered}>
      <ActivityIndicator size="small" color={Colors.light.primary} />
      <Text style={styles.muted}>Loading deals…</Text>
    </View>
  ) : error ? (
    <View style={styles.centered}>
      <Feather name="alert-circle" size={20} color={Colors.light.error} />
      <Text style={styles.muted}>Could not load deals</Text>
    </View>
  ) : (
    <View style={styles.centered}>
      <Feather name="inbox" size={22} color="#B8B0A6" />
      <Text style={styles.muted}>
        {savedOnly
          ? "No saved deals yet."
          : query.trim().length > 0
            ? "Nothing matches that."
            : "You're all caught up."}
      </Text>
    </View>
  );

  return (
    <FlatList
      refreshControl={refreshControl}
      style={styles.scroll}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      data={loading || error ? [] : dealsToShow}
      keyExtractor={(deal) => deal.id}
      extraData={`${expandedId}|${decliningId}`}
      initialNumToRender={8}
      windowSize={11}
      ListHeaderComponent={listHeader}
      ListEmptyComponent={listEmpty}
      ListFooterComponent={<View style={styles.bottomPad} />}
      renderItem={({ item: deal }) => (
        // Redesigned Explore All row: the brand-led card. Tapping opens the pushed
        // Deal Detail (no inline expand / action bar here — the detail screen owns actions).
        <BrandDealCard
          deal={deal}
          onPress={() => onOpenDetail?.(deal.id)}
        />
      )}
    />
  );
}

const styles = StyleSheet.create({
  scroll:  { flex: 1 },
  content: { paddingBottom: Spacing.xl },

  headerWrap: { paddingTop: Spacing.sm },

  // ── Row 1 · search + bookmark ──
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.sm,
  },
  searchBar: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    height: 42,
    backgroundColor: Colors.light.card,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  searchInput: {
    flex: 1,
    fontFamily: Fonts.body,
    fontSize: 14,
    color: Colors.light.text,
    padding: 0,
  },
  bookmarkToggle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Colors.light.border,
    backgroundColor: Colors.light.card,
  },
  bookmarkToggleActive: {
    borderColor: Colors.light.primary + "55",
    backgroundColor: Colors.light.primary + "12",
  },

  // ── Row 2 · category filter — original circle+label, smaller + muted-until-clicked ──
  catRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.xl,
    paddingTop: 2,
    marginBottom: Spacing.sm,
  },
  catItem: { alignItems: "center", gap: 4 },
  catCircle: {
    width: 34, height: 34, borderRadius: 17,
    alignItems: "center", justifyContent: "center",
  },
  catCircleActive: {
    shadowColor: "#000", shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18, shadowRadius: 4, elevation: 3,
  },
  catLabel: { fontFamily: Fonts.bodySemiBold, fontSize: 10.5, letterSpacing: 0.4 },

  // ── Row 3 · status pill + count ──
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingTop: 2,
    paddingBottom: 10,
  },
  statusPillTrigger: {
    alignSelf: "flex-start",
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: Colors.light.primary + "66",
    backgroundColor: Colors.light.primary + "0C",
  },
  statusPillText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 13,
    color: Colors.light.primary,
    letterSpacing: 0.1,
  },
  resultCount: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 13,
    color: "#9C968D",
  },

  // ── Calm states ──
  centered: {
    alignItems: "center",
    paddingTop: 44,
    paddingHorizontal: Spacing["3xl"],
    gap: Spacing.sm,
  },
  muted: {
    fontFamily: Fonts.body,
    fontSize: 14,
    color: Colors.light.textMuted,
    textAlign: "center",
  },

  bottomPad: { height: Spacing["4xl"] },
});
