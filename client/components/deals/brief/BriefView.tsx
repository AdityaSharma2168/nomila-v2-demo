// WS2 · BriefView — the agent surface (default view once proven).
//
// Mila leads with the debt, then hands you the top few asks under a "Needs your reply"
// section head as the FULL classic deal cards (logo · source · offer · score ring ·
// summary · expand · co-pilot action pair). Above the asks sit two co-pilot cards:
//
//   · "Your Week" — an activity-led teaser link into the outcome log (onOpenWeek).
//   · "Ask for terms" — a pink batch card for the deals nobody named a price on
//     (onAskTerms → the WS4 batch screen).
//
// Mila's stance now lives IN each card's co-pilot primary button (Counter / Ask for
// terms / …), so we no longer float her verbose voice paragraph above the card. The
// old "Also this week" rollup and the entry chips are gone too — that content lives in
// the Your Week outcome view, reached from the link card above (two-tab structure:
// Brief + Classic).
//
// Ranking is a client-side stand-in (awaiting-you first, then score); WS3 §3.7 moves
// it server-side. Actions are co-pilot — the DealCard's own action bar drives the send
// path (preview before send); nothing auto-sends.

import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, Pressable, ScrollView, type RefreshControlProps } from "react-native";
import { Feather } from "@expo/vector-icons";
import { DealCard, type DealItem, type DealStatus } from "../DealCard";
import type { DealDetailSection } from "../../../screens/DealDetailScreen";
import { BrandLogo } from "../../BrandLogo";
import { weekTeaser, countUnpriced, isUnpriced, needsReply } from "./briefTeaser";
import { coPilotAction } from "./coPilotActions";
import { useAgentActions } from "../../../hooks/use-agent-actions";
import { useAuth } from "../../../lib/auth-context";
import { haptics } from "../../../lib/haptics";
import { Fonts, Colors, Spacing, BorderRadius } from "../../../constants/theme";

// Time-of-day for the personal greeting line. Honest and boring on purpose.
function daypart(hours: number): string {
  if (hours < 12) return "Good morning";
  if (hours < 18) return "Good afternoon";
  return "Good evening";
}

const MAX_ASKS = 3;

interface BriefViewProps {
  deals:     DealItem[];
  isLoading: boolean;
  error:     Error | null;
  // "Let's talk" / open the decision detail for a deal (kept from the prior AskCard).
  onOpenDeal: (deal: DealItem) => void;

  // ── NEW co-pilot cards (all optional so the existing orchestrator call still
  //    typechecks; wire them up to light the cards) ──
  /** Tap the "Your Week" link card → push the outcome log. */
  onOpenWeek?: () => void;
  /** Tap the "Ask for terms" batch card → the WS4 batch review/send screen. */
  onAskTerms?: () => void;
  /** Co-pilot primary for a single unpriced ask → the request-for-terms composer. */
  onAskTermsDeal?: (deal: DealItem) => void;

  // ── DealCard action handlers (mirror ClassicListV2's shapes). Optional — DealCard
  //    hides any action whose handler is absent, so the Brief degrades cleanly if the
  //    orchestrator only wires a subset. ──
  onAccept?:      (deal: DealItem) => void;
  onNegotiate?:   (deal: DealItem) => void;
  onDecline?:     (dealId: string) => void;
  onSetStatus?:   (dealId: string, status: DealStatus) => void;
  onToggleSaved?: (dealId: string, saved: boolean) => void;
  onViewThread?:  (deal: DealItem) => void;
  /** Deep-link a card's score/brand tap into the pushed Deal Detail screen. */
  onOpenDetail?:  (dealId: string, section?: DealDetailSection) => void;
  /** Low-emphasis tap → the "Filtered / not a deal" transparency screen. */
  onOpenFiltered?: () => void;
  /** Id of a deal whose decline is in flight (spinner on its button). */
  decliningId?:   string | null;
  /** Swipe-down refresh (ui/PullRefresh), owned by the screen. */
  refreshControl?: React.ReactElement<RefreshControlProps>;
}

// Live work only: a thread the athlete filed / the agent set aside is out of the Brief
// (it lives in Files / Your Week). Passed & closed deals also drop out.
function isBriefVisible(d: DealItem): boolean {
  return d.status !== "rejected" && d.status !== "completed" && d.threadStatus !== "archived";
}

// The Brief's "Needs your reply" list: only the deals that genuinely need the athlete's
// reply (open · her turn · not expired · not cold — see needsReply), ranked by score.
// (WS3 §3.7 moves the ranking server-side.)
function rankAsks(deals: DealItem[]): DealItem[] {
  return [...deals]
    .filter((d) => needsReply(d))
    // Unscored last (-1), never a phantom 5 in the middle of the ranking.
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

export function BriefView({
  deals, isLoading, error, onOpenDeal,
  onOpenWeek, onAskTerms, onAskTermsDeal,
  onAccept, onNegotiate, onDecline, onSetStatus, onToggleSaved, onViewThread,
  onOpenDetail, onOpenFiltered,
  decliningId, refreshControl,
}: BriefViewProps) {
  // The receipt feed powers the "Your Week" teaser (may be empty today — ISSUE-9).
  const actionsQuery = useAgentActions();
  const { athlete }  = useAuth();

  const [expandedId, setExpandedId] = useState<string | null>(null);

  const visible    = useMemo(() => deals.filter(isBriefVisible), [deals]);
  const ranked     = useMemo(() => rankAsks(deals), [deals]);
  const asks       = ranked.slice(0, MAX_ASKS);
  // The tightened count — the SAME number the greeting, tab badge, section head and
  // teaser all speak, so they never disagree (was: raw awaiting-athlete → a scary 81).
  const replyCount = ranked.length;

  const teaser   = useMemo(() => weekTeaser(deals, actionsQuery.data), [deals, actionsQuery.data]);
  const unpriced = useMemo(() => countUnpriced(deals), [deals]);
  // The same predicate countUnpriced uses — surfaced as deals so the batch card can
  // show WHO with real logos (presentation only; the count above stays the source).
  const unpricedDeals = useMemo(() => deals.filter(isUnpriced), [deals]);

  // ── Greeting: personal line + honest status line (real counts only) ──
  // Fable framing: a BOLD count up front, then the reassurance that the rest is triaged.
  // `others` = everything else Mila has already read/handled this cycle.
  const firstName = athlete?.firstName?.trim() || null;
  const hello     = firstName ? `${daypart(new Date().getHours())}, ${firstName}.` : `${daypart(new Date().getHours())}.`;
  const others    = Math.max(visible.length - replyCount, 0);
  let statusBold = "";           // the emphasized count clause (may be empty)
  let statusRest: string;        // the un-emphasized remainder
  if (visible.length === 0) {
    statusRest = "Nothing needs you right now — I'll flag anything that does.";
  } else if (replyCount === 0) {
    statusRest = visible.length === 1
      ? "Nothing's waiting on a reply — I'm across the one open thread."
      : `Nothing's waiting on a reply — I'm across all ${visible.length} open threads.`;
  } else {
    statusBold = replyCount === 1 ? "1 ask needs a reply" : `${replyCount} asks need a reply`;
    statusRest = others > 0 ? ` — I've read the other ${others}, nothing else is urgent.` : ".";
  }

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="small" color={Colors.light.primary} />
        <Text style={styles.muted}>Mila is reading your inbox…</Text>
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.centered}>
        <Feather name="alert-circle" size={20} color={Colors.light.error} />
        <Text style={styles.muted}>Couldn't load your Brief</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false} refreshControl={refreshControl}>
      {/* Greeting — a warm personal line first, then the honest debt line */}
      <View style={styles.greetingBlock}>
        <Text style={styles.greetingHello}>{hello}</Text>
        <Text style={styles.greetingStatus}>
          {!!statusBold && <Text style={styles.greetingStatusStrong}>{statusBold}</Text>}
          {statusRest}
        </Text>
      </View>

      {/* "Your Week" — activity-led teaser link into the outcome log. The pink treatment
          (Fable) lives HERE on the Brief link card: soft-pink ground, pink "YOUR WEEK"
          kicker, pink calendar chip + chevron. The drill-in screen itself stays cream. */}
      {onOpenWeek && (
        <Pressable style={styles.weekCard} onPress={() => { haptics.tap(); onOpenWeek?.(); }} hitSlop={4}>
          <View style={styles.weekIcon}>
            <Feather name="calendar" size={15} color={Colors.light.primary} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.weekKicker}>Last 30 days</Text>
            <Text style={styles.weekTeaser} numberOfLines={2}>{teaser.text}</Text>
          </View>
          <Feather name="chevron-right" size={18} color={Colors.light.primary} />
        </Pressable>
      )}

      {/* "Ask for terms" — pink co-pilot batch card (only when there's a batch to send) */}
      {onAskTerms && unpriced > 0 && (
        <Pressable style={styles.termsCard} onPress={() => { haptics.tap(); onAskTerms?.(); }} hitSlop={4}>
          <View style={styles.termsHead}>
            <View style={styles.termsBadge}>
              <Feather name="zap" size={11} color="#fff" />
            </View>
            <Text style={styles.termsKicker}>Mila can qualify these</Text>
          </View>
          <Text style={styles.termsTitle}>Ask for terms</Text>
          <Text style={styles.termsBody}>
            {unpriced === 1
              ? "1 brand hasn't spelled out their terms — I'll ask for the scope, timeline and budget they left open. Nothing sends until you approve."
              : `${unpriced} brands haven't spelled out their terms — I'll ask each for the scope, timeline and budget they left open. Nothing sends until you approve.`}
          </Text>
          {/* Who, exactly — real logos, never monograms */}
          <View style={styles.termsFaceRow}>
            <View style={styles.facepile}>
              {unpricedDeals.slice(0, 4).map((d, i) => (
                <View key={d.id} style={[styles.faceRing, i > 0 && styles.faceOverlap]}>
                  <BrandLogo brandName={d.brandName} brandDomain={d.brandDomain} size={26} borderRadius={13} />
                </View>
              ))}
            </View>
            {unpriced > 4 && (
              <Text style={styles.faceMore}>+{unpriced - 4} {unpriced - 4 === 1 ? "other" : "others"}</Text>
            )}
          </View>
          <View style={styles.termsCta}>
            <Text style={styles.termsCtaText}>Review &amp; send</Text>
            <Feather name="arrow-right" size={14} color="#fff" />
          </View>
        </Pressable>
      )}

      {/* Ranked asks — a clean sectioned list of the FULL classic DealCards. Mila's
          stance now lives IN each card's co-pilot primary button (Counter / Ask for
          terms / …), so we no longer float her verbose voice paragraph above the card. */}
      {asks.length === 0 ? (
        <View style={styles.calm}>
          <Feather name="check-circle" size={22} color={Colors.light.statusAccepted} />
          <Text style={styles.calmText}>New opportunities will show up here as they arrive.</Text>
        </View>
      ) : (
        <>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionKicker}>Needs your reply</Text>
            <Text style={styles.sectionCount}>{replyCount}</Text>
          </View>
          {asks.map((deal) => {
            // Mila's dynamic next-best move for THIS thread's latest state (primary),
            // routed to the orchestrator's handlers by kind. The secondary is uniform on
            // every card — "I'll decide" opens the DecisionSheet, which explains the
            // recommendation (position, why, the plan) rather than offering alternatives
            // to it. Accept, decline and pass are NOT in there, whatever this comment
            // said before.
            const pair = coPilotAction(deal);
            const primaryPress =
              pair.primary.kind === "askTerms" ? () => onAskTermsDeal?.(deal)
              : pair.primary.kind === "sendRate" ? () => onNegotiate?.(deal)
              : pair.primary.kind === "draftYes" ? () => onAccept?.(deal)
              : pair.primary.kind === "counter"  ? () => onNegotiate?.(deal)
              : /* notForMe */                      () => onDecline?.(deal.id);
            return (
              <DealCard
                key={deal.id}
                deal={deal}
                isExpanded={expandedId === deal.id}
                onToggleExpand={() => setExpandedId((cur) => (cur === deal.id ? null : deal.id))}
                coPilotActions={{
                  primary:   { label: pair.primary.label,   onPress: primaryPress },
                  secondary: { label: pair.secondary.label, onPress: () => onOpenDeal(deal) },
                }}
                onAccept={onAccept ? () => onAccept(deal) : undefined}
                onNegotiate={onNegotiate ? () => onNegotiate(deal) : undefined}
                onDecline={onDecline ? () => onDecline(deal.id) : undefined}
                onSetStatus={onSetStatus ? (status) => onSetStatus(deal.id, status) : undefined}
                onToggleSaved={onToggleSaved ? (saved) => onToggleSaved(deal.id, saved) : undefined}
                onViewThread={onViewThread ? () => onViewThread(deal) : undefined}
                onOpenDetail={onOpenDetail ? (section) => onOpenDetail(deal.id, section) : undefined}
                isDeclining={decliningId === deal.id}
              />
            );
          })}
        </>
      )}

      {/* Low-emphasis transparency link — what Mila filed as junk/not-a-deal, and why.
          Deliberately quiet: it's reassurance ("we file, we don't silently drop"), not a
          primary flow. Only shown when the orchestrator wires it. */}
      {onOpenFiltered && (
        <Pressable style={styles.filteredLink} onPress={() => { haptics.tap(); onOpenFiltered(); }} hitSlop={8}>
          <Feather name="filter" size={12} color={Colors.light.textMuted} />
          <Text style={styles.filteredLinkText}>See what I filtered out</Text>
          <Feather name="chevron-right" size={14} color={Colors.light.textMuted} />
        </Pressable>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll:        { flex: 1 },
  scrollContent: { paddingBottom: Spacing["3xl"] },
  centered: { alignItems: "center", paddingTop: 44, paddingHorizontal: Spacing["3xl"], gap: Spacing.sm },
  muted:    { fontFamily: Fonts.body, fontSize: 14, color: Colors.light.textMuted, textAlign: "center" },
  // ── Greeting — two lines: personal, then the honest status ──
  greetingBlock: {
    paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, paddingBottom: Spacing.lg, gap: 3,
  },
  greetingHello: {
    fontFamily: Fonts.heading, fontSize: 22, color: Colors.light.text,
    letterSpacing: -0.4, lineHeight: 28,
  },
  greetingStatus: {
    fontFamily: Fonts.body, fontSize: 14, color: Colors.light.textSecondary, lineHeight: 20,
  },
  greetingStatusStrong: { fontFamily: Fonts.bodySemiBold, color: Colors.light.text },

  // ── "Your Week" link card — pink (Fable) ──
  weekCard: {
    flexDirection: "row", alignItems: "center", gap: Spacing.md,
    marginHorizontal: Spacing.lg, marginBottom: Spacing.md,
    paddingHorizontal: Spacing.md, paddingVertical: 12,
    backgroundColor: "#FDF2F8",
    borderWidth: 1, borderColor: "#F3D9E8", borderRadius: BorderRadius.sm,
  },
  weekIcon: {
    width: 34, height: 34, borderRadius: 10, flexShrink: 0,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "#F9E2EF",
  },
  weekKicker: {
    fontFamily: Fonts.bodySemiBold, fontSize: 12.5, color: Colors.light.primary,
    letterSpacing: 0.6, textTransform: "uppercase",
  },
  weekTeaser: { fontFamily: Fonts.body, fontSize: 12.5, color: "#6B6560", lineHeight: 17, marginTop: 1 },

  // ── "Ask for terms" batch card — a WHITE action card with a pink accent bar, so it
  //    reads distinctly from the solid-pink "Your Week" LINK card above it (differentiate).
  termsCard: {
    marginHorizontal: Spacing.lg, marginBottom: Spacing.md,
    padding: 13, gap: 8,
    backgroundColor: Colors.light.cardElevated,
    borderRadius: BorderRadius.sm,
    borderWidth: 1, borderColor: Colors.light.border,
    borderLeftWidth: 3, borderLeftColor: Colors.light.primary,
  },
  termsHead: { flexDirection: "row", alignItems: "center", gap: 7 },
  termsBadge: {
    width: 20, height: 20, borderRadius: 10, flexShrink: 0,
    alignItems: "center", justifyContent: "center",
    backgroundColor: Colors.light.primary,
  },
  termsKicker: {
    fontFamily: Fonts.bodySemiBold, fontSize: 12.5, color: Colors.light.primary,
    letterSpacing: 0.6, textTransform: "uppercase", flex: 1,
  },
  termsTitle: {
    fontFamily: Fonts.heading, fontSize: 17, color: Colors.light.text, letterSpacing: -0.3,
    marginTop: 2,
  },
  termsBody: {
    fontFamily: Fonts.body, fontSize: 13.5, color: Colors.light.textSecondary, lineHeight: 19,
  },
  termsFaceRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, marginTop: 2 },
  facepile: { flexDirection: "row", alignItems: "center" },
  faceRing: {
    borderRadius: 15, borderWidth: 2, borderColor: Colors.light.cardElevated,
    backgroundColor: Colors.light.cardElevated,
  },
  faceOverlap: { marginLeft: -9 },
  faceMore: { fontFamily: Fonts.bodyMedium, fontSize: 12, color: Colors.light.textMuted },
  termsCta: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7,
    alignSelf: "flex-start",
    paddingHorizontal: 14, paddingVertical: 9, marginTop: 2,
    borderRadius: BorderRadius.full, backgroundColor: Colors.light.primary,
  },
  termsCtaText: { fontFamily: Fonts.bodySemiBold, fontSize: 13, color: "#fff" },

  // ── Mila's one-line voice, above each classic card ──
  // ── Section head above the ranked asks (kicker + count) ──
  sectionHead: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    marginHorizontal: Spacing.lg, marginTop: Spacing.sm, marginBottom: Spacing.xs,
  },
  sectionKicker: {
    fontFamily: Fonts.bodySemiBold, fontSize: 12.5, color: "#4A4640",
    letterSpacing: 0.6, textTransform: "uppercase",
  },
  sectionCount: {
    fontFamily: Fonts.bodySemiBold, fontSize: 12, color: Colors.light.textMuted,
    fontVariant: ["tabular-nums"],
  },

  // ── Calm state (no asks, but the week cards still show) ──
  calm: { alignItems: "center", paddingTop: 28, paddingHorizontal: Spacing["3xl"], gap: Spacing.sm },
  calmText: { fontFamily: Fonts.body, fontSize: 13.5, color: Colors.light.textMuted, textAlign: "center", lineHeight: 19 },

  // ── Low-emphasis "Filtered" footer link ──
  filteredLink: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    alignSelf: "center", marginTop: Spacing.lg, paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md,
  },
  filteredLinkText: { fontFamily: Fonts.bodyMedium, fontSize: 12.5, color: Colors.light.textMuted },
});
