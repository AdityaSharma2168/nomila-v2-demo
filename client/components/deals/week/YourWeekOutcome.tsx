// WS5 · Your Week — YourWeekOutcome: the expandable OUTCOME-LOG view (a pushed screen).
//
// Where TheWeekView is the Sunday receipt tab, this is the drill-in the Brief's "Your
// Week" card opens: a calm log of what happened, as CLICKABLE bucket rows. It mirrors
// InFlightView's pushed-screen shell (back header + its own ScrollView) and reuses the
// same weekLogic derivations as the receipt — nothing is forked.
//
// Three sections:
//   1. What arrived      — this week's new-in-your-court deals, BY TYPE (deal-derived).
//   2. What you & Mila did — this week's motion, a fixed vocabulary of buckets.
//   3. Set aside by Nomila — from agent_actions (buildReceipt); each line has an Undo.
//   Footer: The Bar + Track record (the accountability payoff).
//
// Rows 1 & 2 are clickable (count + chevron → onOpenBucket(id); the orchestrator drills
// into bucketDeals(id)). Section 3 lights up only as ISSUE-9 wires agent_actions writers
// — until then it renders a gentle empty state while 1, 2 and the footer still fill in.
//
// Presentation (opps-prototype-v2): editorial masthead, per-section identity (accent
// dot + uppercase head + hairline rule + quiet count), per-type round icons on every
// bucket row with a big tabular count, the recoCard (#FFF8FC / pink left border)
// treatment on Mila's set-aside section with inline pink Undo pills, and a two-up
// framed stat footer (The Bar figure + the track-record stamp).

import React, { useMemo } from "react";
import { View, Text, Pressable, StyleSheet, ScrollView, ActivityIndicator } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import type { DealItem } from "../DealCard";
import { useAgentActions, useUndoAgentAction, useAgentActionCounts } from "../../../hooks/use-agent-actions";
import { haptics } from "../../../lib/haptics";
import {
  buildReceipt,
  type SetAsideItem,
} from "./weekLogic";
import {
  buildOutcomeLog,
  outcomeIsEmpty,
  type OutcomeBucket,
  type OutcomeBucketId,
} from "./yourWeekOutcomeLogic";
import { Fonts, Colors, Spacing, BorderRadius, Shadows, Bold } from "../../../constants/theme";

interface YourWeekOutcomeProps {
  deals:     DealItem[];
  isLoading: boolean;
  error:     Error | null;
  /** Dismiss the pushed screen (back). Renders a back chevron in the header. */
  onClose?:  () => void;
  /** Tap a bucket row → the orchestrator drills into bucketDeals(id). */
  onOpenBucket?: (bucketId: OutcomeBucketId) => void;
  /** Optional override for the Undo action; falls back to the internal mutation. */
  onUndo?:   (actionId: string) => void;
}

// ─── Per-bucket identity — icon in ink for every row (ring colours paint the score only, one look 23 Oct 2026) ─────────────────────

type FeatherName = React.ComponentProps<typeof Feather>["name"];

const BUCKET_LOOK: Record<OutcomeBucketId, { icon: FeatherName; color: string }> = {
  // What arrived — by type
  "arrived-paid":      { icon: "dollar-sign",    color: Bold.ink },
  "arrived-media":     { icon: "mic",            color: Bold.ink },
  "arrived-editorial": { icon: "edit-3",         color: Bold.ink },
  "arrived-gifting":   { icon: "gift",           color: Bold.ink },
  // What you & Mila did
  "did-counters":      { icon: "trending-up",    color: Bold.ink },
  "did-asked":         { icon: "message-circle", color: Bold.ink },
  "did-quality":       { icon: "star",           color: Bold.ink },
  "did-gifting":       { icon: "gift",           color: Bold.ink },
};

// Fixed "set aside" vocabulary — the kinds of things Mila files for you. Rendered ALWAYS
// (0 + muted when none), so the section teaches its taxonomy like the other two.
const SET_ASIDE_CATS: { action: "file" | "auto_decline" | "auto_archive"; label: string; icon: FeatherName }[] = [
  { action: "file",         label: "Filed as noise", icon: "archive" },
  { action: "auto_decline", label: "Auto-declined",  icon: "slash" },
  { action: "auto_archive", label: "Auto-archived",  icon: "clock" },
];

// The rolling 30-day window this screen is scoped to, e.g. "Jun 28 – Jul 27". Updates
// every day. Mirrors weekLogic's RECAP_WINDOW_MS "last 30 days" window.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function rangeLabel(now: number): string {
  const end   = new Date(now);
  const start = new Date(now - 29 * 86_400_000); // inclusive 30-day span
  const sM = MONTHS[start.getMonth()], eM = MONTHS[end.getMonth()];
  return sM === eM
    ? `${sM} ${start.getDate()} – ${end.getDate()}`
    : `${sM} ${start.getDate()} – ${eM} ${end.getDate()}`;
}

export function YourWeekOutcome({
  deals, isLoading, error, onClose, onOpenBucket, onUndo,
}: YourWeekOutcomeProps) {
  const actionsQuery = useAgentActions();
  const countsQuery  = useAgentActionCounts();
  const undo         = useUndoAgentAction();
  const insets       = useSafeAreaInsets();

  const now      = Date.now();
  const log      = useMemo(() => buildOutcomeLog(deals, now), [deals, now]);
  const receipt  = useMemo(() => buildReceipt(actionsQuery.data, now), [actionsQuery.data, now]);

  function handleUndo(id: string) {
    if (onUndo) onUndo(id);
    else undo.mutate(id);
  }
  const undoingId = undo.isPending ? (undo.variables as string | undefined) : undefined;

  let body: React.ReactNode;
  if (isLoading) {
    body = (
      <View style={styles.centered}>
        <ActivityIndicator size="small" color={Colors.light.primary} />
        <Text style={styles.muted}>Adding up your week…</Text>
      </View>
    );
  } else if (error) {
    body = (
      <View style={styles.centered}>
        <Feather name="alert-circle" size={20} color={Colors.light.error} />
        <Text style={styles.muted}>Couldn't add up your week</Text>
      </View>
    );
  } else {
    // Always render all three sections (each with its full category taxonomy, zeros
    // included) — even in a quiet week — so the athlete always sees how the week is
    // organized and what to expect. A quiet week just reads as rows of "0".
    const nothingHappened = outcomeIsEmpty(log) && receipt.isEmpty;
    body = (
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {nothingHappened && (
          <Text style={styles.quietNote}>A quiet week so far — here's how it's shaping up.</Text>
        )}
        {/* 1 · What arrived — by type */}
        <BucketSection
          title="What arrived"
          buckets={log.arrived}
          onOpenBucket={onOpenBucket}
        />

        {/* 2 · What you & Mila did */}
        <BucketSection
          title="What you & Mila did"
          buckets={log.did}
          onOpenBucket={onOpenBucket}
        />

        {/* 3 · Set aside by Nomila — from agent_actions, each reversible */}
        <SetAsideSection
          totals={countsQuery.data?.byAction}
          onLoadMore={() => actionsQuery.fetchNextPage()}
          canLoadMore={!!actionsQuery.hasNextPage}
          loadingMore={!!actionsQuery.isFetchingNextPage}
          setAside={receipt.setAside}
          isEmpty={receipt.isEmpty}
          onUndo={handleUndo}
          undoingId={undoingId}
        />
      </ScrollView>
    );
  }

  return (
    <View style={styles.screen}>
      {/* Masthead — back control below the status bar, editorial title, one-line promise.
          paddingTop uses the safe-area inset so the back control never hides under the
          notch/clock (the "can't get back" bug). */}
      <View style={[styles.header, { paddingTop: insets.top + Spacing.xs }]}>
        {onClose ? (
          <Pressable onPress={() => { haptics.tap(); onClose?.(); }} hitSlop={12} style={styles.backBtn}>
            <Feather name="chevron-left" size={24} color={Colors.light.text} />
            <Text style={styles.backLabel}>Brief</Text>
          </Pressable>
        ) : (
          <View style={styles.backBtn} />
        )}
      </View>
      <View style={styles.masthead}>
        <Text style={styles.mastheadTitle}>Last 30 Days</Text>
        {/* The window everything on this screen is scoped to (rolling 30 days), then the
            promise that each count drills into those exact deals. */}
        <Text style={styles.mastheadSub}>{rangeLabel(now)} · every count opens those deals</Text>
      </View>
      {body}
    </View>
  );
}

// ─── Ledger section head — accent dot · label · rule · count ─────────────────────────

function SectionHead({
  title, count,
}: { title: string; count?: number }) {
  return (
    <View style={styles.sectionHeadWrap}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionLabel}>{title}</Text>
        <View style={styles.sectionRule} />
        {count != null && <Text style={styles.sectionTotal}>{count} total</Text>}
      </View>
    </View>
  );
}

// ─── Clickable bucket section (What arrived / What you & Mila did) ───────────────────

function BucketSection({
  title, buckets, onOpenBucket,
}: {
  title: string;
  buckets: OutcomeBucket[];
  onOpenBucket?: (id: OutcomeBucketId) => void;
}) {
  const total = buckets.reduce((n, b) => n + b.count, 0);
  return (
    <View style={styles.section}>
      <SectionHead title={title} count={total} />
      <View style={styles.card}>
        {buckets.map((b, i) => {
          const look = BUCKET_LOOK[b.id];
          // Zero this week → a muted, non-tappable row. Every category still shows, so
          // the athlete always sees how the week is organized and what to expect.
          const empty = b.count === 0;
          const tappable = !!onOpenBucket && !empty;
          return (
            <Pressable
              key={b.id}
              onPress={tappable ? () => { haptics.tap(); onOpenBucket!(b.id); } : undefined}
              disabled={!tappable}
              style={({ pressed }) => [
                styles.bucketRow,
                i > 0 && styles.rowDivider,
                empty && styles.bucketRowEmpty,
                pressed && tappable && { backgroundColor: Bold.ground },
              ]}
            >
              <View style={[styles.bucketIcon, { backgroundColor: `${look.color}${empty ? "14" : "16"}` }]}>
                <Feather name={look.icon} size={14} color={empty ? "#9C968D" :look.color} />
              </View>
              <Text style={[styles.bucketLabel, empty && styles.bucketLabelEmpty]} numberOfLines={1}>{b.label}</Text>
              <Text style={[styles.bucketCount, empty && styles.bucketCountEmpty]}>{b.count}</Text>
              {tappable && <Feather name="chevron-right" size={15} color="#C5BFB8" />}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// ─── Set aside by Nomila — recoCard voice, itemized, each line reversible (Undo) ─────

function SetAsideSection({
  setAside, isEmpty, onUndo, undoingId, totals, onLoadMore, canLoadMore, loadingMore,
}: {
  setAside: SetAsideItem[];
  isEmpty: boolean;
  onUndo: (id: string) => void;
  undoingId?: string;
  /** TRUE totals per action, from the server — not a count of the rows loaded so far. */
  totals?: Record<string, number>;
  onLoadMore?: () => void;
  canLoadMore?: boolean;
  loadingMore?: boolean;
}) {
  // Count this week's set-aside items by kind, so the fixed categories can show ALWAYS
  // (0 + muted) — same always-visible-taxonomy treatment as the other two sections.
  // Prefer the SERVER totals. Counting the rows that happen to be loaded is what showed 190
  // filings against 969 real ones — the one screen whose job is showing what Mila did,
  // understating her fivefold because the feed stops at a page.
  const loaded: Record<string, number> = { file: 0, auto_decline: 0, auto_archive: 0 };
  for (const it of setAside) loaded[it.action] = (loaded[it.action] ?? 0) + 1;
  const counts: Record<string, number> = { ...loaded, ...(totals ?? {}) };
  const grandTotal = totals
    ? Object.values(totals).reduce((a, b) => a + b, 0)
    : setAside.length;
  return (
    <View style={styles.section}>
      <SectionHead title="Set aside by Nomila" count={grandTotal} />
      <View style={styles.card}>
        {SET_ASIDE_CATS.map((c, i) => {
          const n = counts[c.action] ?? 0;
          const empty = n === 0;
          return (
            <View key={c.action} style={[styles.bucketRow, i > 0 && styles.rowDivider, empty && styles.bucketRowEmpty]}>
              <View style={[styles.bucketIcon, { backgroundColor: Bold.ground }]}>
                <Feather name={c.icon} size={14} color={empty ? "#9C968D" : Bold.ink} />
              </View>
              <Text style={[styles.bucketLabel, empty && styles.bucketLabelEmpty]} numberOfLines={1}>{c.label}</Text>
              <Text style={[styles.bucketCount, empty && styles.bucketCountEmpty]}>{n}</Text>
            </View>
          );
        })}
      </View>
      {isEmpty && (
        // First-run helper — why the counts are zero (no writers wired yet — ISSUE-9).
        <Text style={styles.sectionEmpty}>I only file things once you've told me how.</Text>
      )}
      {setAside.length > 0 && (
        <>
          {/* What is LISTED vs what was DONE. The list is a page; the count is the truth, and
              saying so is better than letting the two disagree silently. */}
          {grandTotal > setAside.length && (
            <Text style={styles.setAsideMeta}>
              Showing {setAside.length} of {grandTotal}
            </Text>
          )}
          <View style={[styles.card, styles.setAsideCard]}>
            {setAside.map((item, i) => (
              <View key={item.id} style={[styles.setAsideRow, i > 0 && styles.setAsideDivider]}>
                <View style={styles.setAsideTop}>
                  <Text style={styles.setAsideVerb}>{item.verb}</Text>
                  <Text style={styles.setAsideSubject} numberOfLines={1}>{item.subject}</Text>
                  {item.undoable && (
                    <Pressable
                      onPress={() => onUndo(item.id)}
                      disabled={undoingId === item.id}
                      style={styles.undoPill}
                      hitSlop={6}
                    >
                      {undoingId === item.id
                        ? <ActivityIndicator size="small" color={Colors.light.primary} />
                        : <><Feather name="rotate-ccw" size={11} color={Colors.light.primary} />
                            <Text style={styles.undoText}>Undo</Text></>}
                    </Pressable>
                  )}
                </View>
                {!!item.reason && <Text style={styles.setAsideReason} numberOfLines={2}>{item.reason}</Text>}

                {/* 24h hold — framed as the window to undo, never as an automatic send. */}
                {item.hold && !item.hold.expired && (
                  <View style={styles.holdPill}>
                    <Feather name="clock" size={11} color={Bold.ink} />
                    <Text style={styles.holdText}>On hold · {item.hold.label}</Text>
                  </View>
                )}
              </View>
            ))}
          </View>
          {/* The promise that makes the section safe to trust */}
          <View style={styles.reversibleNote}>
            <Feather name="shield" size={11} color="#B98FA8" />
            <Text style={styles.reversibleText}>Nothing deleted — everything here is reversible.</Text>
          </View>
          {canLoadMore && (
            <Pressable
              onPress={() => { haptics.tap(); onLoadMore?.(); }}
              disabled={loadingMore}
              style={styles.loadMoreBtn}
              hitSlop={8}
            >
              {loadingMore
                ? <ActivityIndicator size="small" color={Colors.light.primary} />
                : <Text style={styles.loadMoreText}>Load more</Text>}
            </Pressable>
          )}
        </>
      )}
    </View>
  );
}

// ─── Styles (opps-prototype-v2 bar) ──────────────────────────────────────────────────

const styles = StyleSheet.create({
  // Cream ground, same as the Brief (Fable "Your Week" drill-in is NOT pink — the pink
  // treatment lives on the Brief's Your Week LINK card, not here).
  screen: { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: Spacing.lg, paddingBottom: 2,
  },
  backBtn: { flexDirection: "row", alignItems: "center", height: 36, marginLeft: -6, paddingRight: 8 },
  backLabel: { fontFamily: Fonts.body, fontSize: 15, color: Colors.light.text, marginLeft: -2 },

  // ── Masthead ──
  masthead: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.lg, gap: 3 },
  mastheadTitle: {
    fontFamily: Fonts.display, fontSize: 28, color: Colors.light.text, letterSpacing: -0.6,
  },
  mastheadSub: { fontFamily: Fonts.body, fontSize: 13, color: Colors.light.textMuted, lineHeight: 18 },

  scroll: { paddingTop: Spacing.xs, paddingBottom: Spacing["3xl"] },
  centered: { alignItems: "center", paddingTop: 44, paddingHorizontal: Spacing["3xl"], gap: Spacing.sm },
  muted:    { fontFamily: Fonts.body, fontSize: 14, color: Colors.light.textMuted, textAlign: "center" },
  quietTitle: { fontFamily: Fonts.headingSemiBold, fontSize: 16, color: Colors.light.textSecondary },
  quietNote: {
    fontFamily: Fonts.body, fontSize: 13, color: "#9C968D", lineHeight: 18,
    paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm,
  },

  // ── Ledger section head ──
  section: { marginBottom: Spacing["2xl"] },
  sectionHeadWrap: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm + 2, gap: 3 },
  sectionHead: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  sectionDot: { width: 6, height: 6, borderRadius: 3 },
  sectionLabel: {
    fontFamily: Fonts.bodySemiBold, fontSize: 12.5, letterSpacing: 0.6, color: "#4A4640",
    textTransform: "uppercase",
  },
  sectionRule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: Colors.light.border },
  sectionCountChip: {
    minWidth: 20, paddingHorizontal: 6, paddingVertical: 1, borderRadius: BorderRadius.full,
    backgroundColor: Colors.light.backgroundSecondary, alignItems: "center",
  },
  sectionCount: { fontFamily: Fonts.bodySemiBold, fontSize: 11, color: "#6B6560" },
  sectionTotal: {
    fontFamily: Fonts.bodySemiBold, fontSize: 11, color: "#9C968D",
    letterSpacing: 0.2, fontVariant: ["tabular-nums"],
  },
  sectionHint: { fontFamily: Fonts.body, fontSize: 11, color: "#9C968D", paddingLeft: 14 },
  sectionEmpty: {
    fontFamily: Fonts.body, fontSize: 13, color: "#9C968D",
    paddingHorizontal: Spacing.lg, lineHeight: 18,
  },

  // ── Shared card shell ──
  card: {
    marginHorizontal: Spacing.lg,
    backgroundColor: Colors.light.card,
    borderWidth: 1, borderColor: Colors.light.borderLight, borderRadius: BorderRadius.sm,
    overflow: "hidden",
    ...Shadows.sm,
  },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.light.borderLight },

  // ── Bucket row (clickable): round type icon · label · big tabular count · chevron ──
  bucketRow: {
    flexDirection: "row", alignItems: "center", gap: Spacing.md,
    paddingHorizontal: Spacing.md, paddingVertical: 13,
  },
  bucketIcon: {
    width: 30, height: 30, borderRadius: 15, flexShrink: 0,
    alignItems: "center", justifyContent: "center",
  },
  bucketLabel: { flex: 1, minWidth: 0, fontFamily: Fonts.bodySemiBold, fontSize: 14, color: Colors.light.text, letterSpacing: -0.1 },
  bucketCount: {
    fontFamily: Fonts.displayBold, fontSize: 19, color: Colors.light.text, letterSpacing: -0.4,
    fontVariant: ["tabular-nums"],
  },
  // Zero-count row — still clearly READABLE (it teaches the taxonomy); only the count
  // and icon read as inactive, so the category name stays legible.
  bucketRowEmpty: {},
  bucketLabelEmpty: { color: Colors.light.textSecondary, fontFamily: Fonts.bodyMedium },
  bucketCountEmpty: { color: "#C5BFB8" },

  // ── Set aside (Mila's voice marker — recoCard treatment) ──
  setAsideMeta: {
    fontSize: 12,
    color: "#77706A",
    paddingHorizontal: 4,
    paddingBottom: 6,
  },
  loadMoreBtn: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    marginTop: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#E6E1DA",
    backgroundColor: "#FFFFFF",
  },
  loadMoreText: {
    fontSize: 13,
    fontWeight: "600",
    color: Colors.light.primary,
  },
  setAsideCard: {
    backgroundColor: "#FFF8FC",
    borderColor: Colors.light.border,
    borderLeftWidth: 3, borderLeftColor: Colors.light.primary,
  },
  setAsideRow: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.md, gap: 6 },
  setAsideDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#F0DCE8" },
  setAsideTop: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  setAsideVerb: {
    fontFamily: Fonts.bodySemiBold, fontSize: 10, letterSpacing: 0.3, textTransform: "uppercase",
    color: "#6B6560", backgroundColor: "#00000008", paddingHorizontal: 7, paddingVertical: 3,
    borderRadius: BorderRadius.full, overflow: "hidden",
  },
  setAsideSubject: { flex: 1, minWidth: 0, fontFamily: Fonts.bodySemiBold, fontSize: 14, color: Colors.light.text },
  setAsideReason:  { fontFamily: Fonts.body, fontSize: 13, color: "#5A554E", lineHeight: 18 },
  holdPill: {
    flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start",
    backgroundColor: Bold.ground, paddingHorizontal: 8, paddingVertical: 3, borderRadius: BorderRadius.full,
  },
  holdText: { fontFamily: Fonts.bodyMedium, fontSize: 11, color: Bold.ink },
  undoPill: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, flexShrink: 0,
    minHeight: 24, paddingHorizontal: 10, paddingVertical: 3,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.light.primaryLight,
  },
  undoText: { fontFamily: Fonts.bodySemiBold, fontSize: 12, color: Colors.light.primary },
  reversibleNote: {
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm,
  },
  reversibleText: { fontFamily: Fonts.body, fontSize: 11.5, color: "#9C968D" },

  // ── Footer stat cards — The Bar + Track record ──
  statRow: {
    flexDirection: "row", gap: Spacing.md,
    paddingHorizontal: Spacing.lg, marginTop: Spacing.xs,
  },
  statCard: {
    flex: 1, minWidth: 0,
    backgroundColor: Colors.light.cardElevated,
    borderWidth: 1, borderColor: Colors.light.border, borderRadius: BorderRadius.sm,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.lg, gap: 6,
    ...Shadows.sm,
  },
  statKicker: {
    fontFamily: Fonts.bodySemiBold, fontSize: 10, letterSpacing: 1, textTransform: "uppercase",
    color: "#9C968D",
  },
  statFigure: {
    fontFamily: Fonts.displayBold, fontSize: 28, color: Colors.light.text, letterSpacing: -0.8,
    fontVariant: ["tabular-nums"],
  },
  statInferred: { fontFamily: Fonts.bodyMedium, fontSize: 10.5, color: "#9C968D", marginTop: -3 },
  statLine:     { fontFamily: Fonts.body, fontSize: 12, color: "#5A554E", lineHeight: 17 },

  stampWrap: { flex: 1, alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 2 },
  stampChip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: Colors.light.card,
    borderWidth: 1, borderColor: Colors.light.borderLight, borderRadius: BorderRadius.full,
    paddingHorizontal: Spacing.md, paddingVertical: 7,
  },
  stampStrong: { fontFamily: Fonts.bodySemiBold, fontSize: 13, color: Colors.light.text },
  stampSub:    { fontFamily: Fonts.body, fontSize: 11.5, color: "#6B6560", textAlign: "center", lineHeight: 16 },
});
