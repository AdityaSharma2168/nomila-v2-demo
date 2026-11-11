import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, TextInput } from "react-native";
import { Feather } from "@expo/vector-icons";
import { BrandLogo } from "../BrandLogo";
import { PlatformIcon } from "../PlatformIcon";
import { Fonts, Colors, Spacing, BorderRadius, Bold } from "../../constants/theme";
import { formatScheduleMoney } from "./scheduleMoney";

export { formatScheduleMoney } from "./scheduleMoney";
import { useThread, useThreadReply } from "../../hooks/use-thread";
import { useDealDraft } from "../../hooks/use-deal-draft";
import { useConnections } from "../../hooks/use-connections";
import { openReply } from "../../lib/reply-link";
import { haptics } from "../../lib/haptics";
import { resolveDealActions, ACTION_TONE_COLOR, type DealAction, type DealActionKind } from "./dealActions";
import { AnchoredMenu, type AnchoredMenuItem } from "./AnchoredMenu";
import type { DealDetailSection } from "../../screens/DealDetailScreen";
import { dayLabel, messagesLabel, respondByLabel } from "../../lib/dealWords";

// Map a deal recommendation to the reply intent the draft endpoint expects.
function recommendationToIntent(
  rec?: "accept" | "negotiate" | "reject" | "delete",
): "accept" | "negotiate" | "decline" {
  if (rec === "negotiate") return "negotiate";
  if (rec === "reject" || rec === "delete") return "decline";
  return "accept";
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type DealCategory = "PAID" | "MEDIA" | "EDITORIAL" | "GIFTING";
export type DealStatus =
  | "detected"
  | "pending"
  | "negotiating"
  | "accepted"
  | "completed"
  | "rejected";
export type DealVerdict = "great" | "good" | "fair" | "poor";
export type DealSource = "gmail" | "instagram" | "tiktok" | "twitter" | "outlook";

type FactorRating = "poor" | "fair" | "good" | "great";



export interface DealItem {
  id:            string;
  brandName:     string;
  brandDomain?:  string | null;
  brandId?:      number | null;  // inbox_brands.id (via inbox_threads.brand_id) — seeds the per-deal pitch
  /** Its opportunity: with the board on, the ONE detail screen (OpportunityDetail) opens by this. */
  opportunityId?: string | null;
  category:      DealCategory;
  status:        DealStatus;
  // The retired 1–10 score (always null since 0088). Kept on the type for the mappers; no surface draws it (8 Oct).
  verdict:       DealVerdict | null;
  source:        DealSource;
  sourceType:    "Email" | "DM";
  score:         number | null;
  timeAgo:       string;
  aiSummary:     string;
  deliverables?: string[];
  offerAmount?:  string;
  /** Present only when the deal has a real schedule — see DealMoney in use-deals. */
  money?:        import("../../hooks/use-deals").DealMoney | null;
  termStart?:    string | null;
  termEnd?:      string | null;
  rateVsMarket?: number | null;
  reasons?:      string[];
  redFlags?:     string[];
  factors?:      { rateComparison: string; brandRelevance: string; deliverableScope: string; exclusivity: string };
  factorRatings?: {
    rateComparison:   { rating: FactorRating; label: string };
    brandRelevance:   { rating: FactorRating; label: string };
    deliverableScope: { rating: FactorRating; label: string };
    exclusivity:      { rating: FactorRating; label: string };
  };
  deadline?:             string | null;
  detectedAt?:           string;
  lastMessageAt?:        string | null;  // last thread activity (recency; sharper than detectedAt)
  latestComms?:          string;
  convAsk?:              string;
  offerDisplay?:         string;
  monthlyEstimate?:      string;
  offerHistory?:         number[];       // ordered stated $ figures (key_details.amounts) — negotiation timeline
  draftPoints?:          string[];       // score.draft_points — referenceable facts for the negotiate composer
  messageCount?:         number;
  lastContact?:          string;
  awaitingResponseFrom?: string;
  hasDraft?:             boolean;
  draftTone?:            string;
  /** Text of the saved draft — seeds the editor so a closed sheet can be resumed. */
  draftBody?:            string;
  /** The reply_intent that draft was written for ("accept" | "negotiate" | …). */
  draftIntent?:          string;
  recommendation?:          "accept" | "negotiate" | "reject" | "delete";
  recommendationUi?:        string;
  negotiateTerms?:          string[];
  urgency?:                 "high" | "medium" | "low";
  brandCategory?:           string;
  // Real brand imagery from inbox_brands: `brandCover` is the card cover, `brandImages` the
  // ranked set behind the deal-detail brand-deck hero. Absent until brand research/backfill ran.
  brandCover?:              string;
  brandImages?:             string[];
  groupSize?:               number;  // deals (threads) collapsed into this one; 1 = solo
  brandTier?:               "emerging" | "mid" | "established" | "premium";
  brandSportFit?:           { rating: string; label: string };
  brandAudienceFit?:        { rating: string; label: string };
  brandDiversification?:    { rating: string; label: string };
  capitalContribution?:       string;
  brandSummary?:              string;
  brandDescription?:          string;
  /** The pages brand research's web search saw: shown as links wherever the brand profile is shown. */
  brandSources?:              Array<{ url: string; title?: string | null }>;
  brandAudienceSummary?:      string;
  brandSportCategories?:      string[];
  brandKnownPartnerships?:    string[];
  threadId?:                  string | null;
  threadStatus?:              string | null;  // inbox_threads.status; 'archived' = filed/set-aside → out of the Brief
  saved?:                     boolean;
  // Resolved brand identity (display-only; from classification re-attribution).
  advertiser?:                string | null;  // end brand; null = agency-mediated, advertiser unknown
  agencyName?:                string | null;  // intermediary, when via_agency
  viaAgency?:                 boolean;
  // Opportunities PR 1 — the thread's qualification (needs_terms · below_floor · workable ·
  // verify_first · not_relevant), from inbox_threads.classification. Absent on threads
  // qualified before PR 1. Read by the Ask-for-terms pool; not rendered anywhere yet.
  qualification?:             string | null;
  /** direct · agency · unverifiable (the qualification's sender judgement). */
  channel?:                   string | null;
  /** The classifier's category as stored (MEDIA, SCHOOL_NIL, …), before the card mapping. */
  sourceCategory?:            string | null;
  // WS2: Mila's agent voice, composed server-side (composeDealVoice). Optional so
  // existing DealCard usage is unaffected; the Brief's AskCard reads it.
  voice?: { line: string; factLine: string | null; primaryActionLabel: string };
}

interface DealCardProps {
  deal:           DealItem;
  isExpanded:     boolean;
  onToggleExpand: () => void;
  // When PROVIDED, tapping the card BODY (row 1 + summary) opens the Deal Detail
  // screen instead of expanding in place — the single-list surface (ClassicListV2)
  // where Deal Detail is the canonical destination. The logo/score still deep-link to
  // their own sections, and the chevron becomes a navigate "›". Absent everywhere else,
  // so expand-in-place is 100% unchanged (BriefView, MilaWidget).
  onPressCard?:   () => void;
  onAccept?:      () => void;
  onNegotiate?:   () => void;
  onDecline?:     () => void;
  onToggleSaved?: (saved: boolean) => void;
  onViewThread?:  () => void;
  onSetStatus?:   (status: DealStatus) => void;
  isDeclining?:   boolean;
  // When true, the action bar is hidden on the collapsed card and shown only
  // once expanded. Defaults to false so existing usage is 100% unchanged.
  hideActionsWhenCollapsed?: boolean;
  // When PROVIDED, the brand line deep-links to the Deal Detail screen (at the given section).
  onOpenDetail?: (section?: DealDetailSection) => void;
  // When PROVIDED (Brief only), render a clean 2-button co-pilot pair — Mila's
  // dynamic next-best move (filled accent) + a quiet secondary (ghost/outline) —
  // IN PLACE OF the normal resolved action bar. Absent everywhere else (Classic,
  // ClassicListV2), so the resolveDealActions bar is 100% unchanged.
  coPilotActions?: {
    primary:   { label: string; onPress: () => void };
    secondary: { label: string; onPress: () => void };
  };
}

// ─── Config maps ─────────────────────────────────────────────────────────────

// One look (23 Oct 2026): a category reads by its icon and word, in ink — never a ring colour (those mean the score).
export const CATEGORY_CONFIG: Record<DealCategory, { color: string; icon: any }> = {
  PAID:      { color: Bold.ink, icon: "dollar-sign" },
  MEDIA:     { color: Bold.ink, icon: "mic" },
  EDITORIAL: { color: Bold.ink, icon: "edit-3" },
  GIFTING:   { color: Bold.ink, icon: "gift" },
};

export const STATUS_CONFIG: Record<DealStatus, { label: string }> = {
  detected:    { label: "NEW" },
  pending:     { label: "PENDING" },
  negotiating: { label: "NEGOTIATING" },
  accepted:    { label: "ACCEPTED" },
  completed:   { label: "COMPLETED" },
  rejected:    { label: "DECLINED" },
};

export const SOURCE_LABEL: Record<DealSource, string> = {
  gmail:     "Gmail",
  instagram: "Instagram",
  tiktok:    "TikTok",
  twitter:   "X",
  outlook:   "Outlook",
};

const LOGO_SIZE = 44;
const LOGO_GAP  = Spacing.md;

// ─── Component ───────────────────────────────────────────────────────────────

export function DealCard({
  deal,
  isExpanded,
  onToggleExpand,
  onPressCard,
  onAccept,
  onNegotiate,
  onDecline,
  onToggleSaved,
  onViewThread,
  onSetStatus,
  isDeclining = false,
  hideActionsWhenCollapsed = false,
  coPilotActions,
  onOpenDetail,
}: DealCardProps) {
  const cat        = CATEGORY_CONFIG[deal.category];
  const status     = STATUS_CONFIG[deal.status];
  const [showReplyCard, setShowReplyCard] = useState(false);
  // Auto-grow the reply box to fit its content. On web a multiline TextInput
  // (rendered as a <textarea>) doesn't grow on its own, so we track the measured
  // content height and apply it, never shrinking below a readable minimum.
  const [replyHeight, setReplyHeight]     = useState(0);

  // Fetch the thread only when the card is expanded (where the Reply button
  // lives), so we can pre-fill the reply recipient with the brand's email.
  const { data: thread } = useThread(deal.threadId, { enabled: isExpanded });
  const replyTo =
    thread?.messages.find((m) => m.direction === "inbound" && m.sender_email)
      ?.sender_email ?? null;

  // Inline LLM reply preview (streamed from the deal draft endpoint).
  const { draft, streaming, generated, error: draftError, generate, editDraft, saveDraft, saving, saved } =
    useDealDraft(deal.id);

  // In-app send: proposes the (possibly edited) draft as a send_reply pending action
  // and approves it in the same tap (the governed path), which sends it into the real
  // Gmail thread with proper In-Reply-To threading. No app hand-off.
  const reply = useThreadReply(deal.threadId ?? "", deal.id);

  // Only offer in-app send when the underlying connection actually has send
  // permission (e.g. a Gmail grant with the gmail.send scope). Older read-only
  // connections — and platforms we can't send from — fall back to "Open in Mail"
  // so the button never dead-ends on a permission error.
  const { canSend } = useConnections();
  const canSendInApp = !!deal.threadId && canSend(deal.source);

  // ── Conditional action model (#4/#11) ──────────────────────────────────────
  // One primary action (Mila's recommended move for this stage) + an overflow of
  // alternatives, resolved from the deal's status / whose-turn / recommendation.
  const actions = resolveDealActions(deal);

  function openReplyCard() {
    if (!isExpanded) onToggleExpand();
    setShowReplyCard(true);
    if (!generated && !streaming) {
      generate({ reply_intent: recommendationToIntent(deal.recommendation), style: "friendly" });
    }
  }

  function hasHandler(kind: DealActionKind): boolean {
    switch (kind) {
      case "accept":     return !!onAccept;
      case "negotiate":  return !!onNegotiate;
      // The card has no request-terms handler of its own; the Brief passes coPilotActions
      // and routes it there, so this path is never the one that renders it.
      case "askTerms":   return false;
      case "reply":      return true;
      case "decline":
      case "dismiss":    return !!onDecline;
      case "viewThread":
      case "nudge":      return !!onViewThread;
      case "markDone":
      case "reopen":     return !!onSetStatus;
      case "save":       return !!onToggleSaved;
    }
  }

  function runAction(kind: DealActionKind) {
    switch (kind) {
      case "accept":     onAccept?.(); break;
      case "negotiate":  onNegotiate?.(); break;
      case "reply":      openReplyCard(); break;
      case "decline":
      case "dismiss":    onDecline?.(); break;
      case "viewThread":
      case "nudge":      onViewThread?.(); break;
      case "markDone":   onSetStatus?.("completed"); break;
      case "reopen":     onSetStatus?.("detected"); break;
      case "save":       onToggleSaved?.(!deal.saved); break;
    }
  }

  const overflowItems: AnchoredMenuItem[] = actions.overflow
    .filter((a) => hasHandler(a.kind))
    .map((a) => ({
      key:     a.kind,
      label:   a.kind === "save" && deal.saved ? "Saved" : a.label,
      icon:    a.kind === "save" && deal.saved ? "check" : a.icon,
      tone:    a.tone,
      onPress: () => runAction(a.kind),
    }));

  // Resolved primary, or a View-conversation fallback when its handler isn't
  // wired (e.g. the declined/completed sub-filter lists pass no action handlers).
  const primaryAction: DealAction | null =
    actions.primary && hasHandler(actions.primary.kind)
      ? actions.primary
      : onViewThread
        ? { kind: "viewThread", label: "View conversation", icon: "message-square", tone: "neutral" }
        : null;

  const isDeclinePrimary = primaryAction?.kind === "decline" || primaryAction?.kind === "dismiss";

  function renderActionBar() {
    if (actions.waiting) {
      return (
        <View style={styles.actionBar}>
          <View style={styles.waitingPill}>
            <Feather name="clock" size={13} color="#9C968D" />
            <Text style={styles.waitingText}>Waiting on brand</Text>
          </View>
          {overflowItems.length > 0 && (
            <AnchoredMenu
              align="right"
              items={overflowItems}
              triggerStyle={styles.overflowBtn}
              trigger={() => <Feather name="more-horizontal" size={18} color="#9C968D" />}
            />
          )}
        </View>
      );
    }

    if (!primaryAction && overflowItems.length === 0) return null;

    return (
      <View style={styles.actionBar}>
        {primaryAction && (
          <Pressable
            style={({ pressed }) => [
              styles.primaryBtn,
              { backgroundColor: ACTION_TONE_COLOR[primaryAction.tone] },
              pressed && { opacity: 0.88 },
            ]}
            onPress={() => runAction(primaryAction.kind)}
            disabled={isDeclining && isDeclinePrimary}
          >
            {isDeclining && isDeclinePrimary
              ? <ActivityIndicator size="small" color="#fff" />
              : <Feather name={primaryAction.icon} size={15} color="#fff" />}
            <Text style={styles.primaryBtnText}>{primaryAction.label}</Text>
          </Pressable>
        )}
        {overflowItems.length > 0 && (
          <AnchoredMenu
            align="right"
            items={overflowItems}
            triggerStyle={styles.overflowBtn}
            trigger={() => <Feather name="more-horizontal" size={18} color="#9C968D" />}
          />
        )}
      </View>
    );
  }

  // Brief-only: a clean 2-button co-pilot pair (Mila's dynamic next-best move +
  // a quiet secondary), rendered IN PLACE OF renderActionBar() when the caller
  // passes coPilotActions. Filled accent primary + ghost/outline secondary.
  function renderCoPilotPair() {
    if (!coPilotActions) return null;
    const { primary, secondary } = coPilotActions;
    return (
      <View style={styles.actionBar}>
        <Pressable
          style={({ pressed }) => [styles.coPilotPrimaryBtn, pressed && { opacity: 0.88 }]}
          onPress={() => { haptics.press(); primary.onPress(); }}
        >
          <Text style={styles.coPilotPrimaryText}>{primary.label}</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.coPilotSecondaryBtn, pressed && { opacity: 0.7 }]}
          onPress={() => { haptics.tap(); secondary.onPress(); }}
        >
          <Text style={styles.coPilotSecondaryText}>{secondary.label}</Text>
        </Pressable>
      </View>
    );
  }

  async function handleSend() {
    const body = draft.trim();
    if (!body) return;
    // No thread to reply into (rare) — fall back to the mailto hand-off.
    if (!deal.threadId) {
      await openReply(replyTo, draft);
      return;
    }
    reply.reset();
    try {
      await reply.mutateAsync(body);
      // Replying to a still-new deal moves it into the negotiating stage.
      if (deal.status === "detected" || deal.status === "pending") onSetStatus?.("negotiating");
    } catch {
      // Failure surfaces via reply.isError below; nothing to do here.
    }
  }

  return (
    <View style={[styles.card, isExpanded && styles.cardExpanded]}>
      {/* ── Row 1: logo · brandCol · score circle + chevron ── */}
      <Pressable
        style={({ pressed }) => [styles.row1, pressed && { opacity: 0.94 }]}
        onPress={onPressCard ?? onToggleExpand}
      >
        {/* Tap the brand logo → deal detail, brand section (nested Pressable captures the touch so it
            doesn't toggle expand). Interactive only when a deep-link handler is provided. */}
        <Pressable
          style={styles.logoWrap}
          onPress={onOpenDetail ? () => onOpenDetail("brand") : undefined}
          disabled={!onOpenDetail}
          hitSlop={6}
        >
          <BrandLogo brandName={deal.brandName} brandDomain={deal.brandDomain} size={LOGO_SIZE} borderRadius={12} />
          <View style={[styles.catBadge, { backgroundColor: cat.color }]}>
            <Feather name={cat.icon} size={8} color={Colors.light.buttonText} />
          </View>
        </Pressable>

        <View style={styles.brandCol}>
          {/* Resolved brand identity — 3 states (direct / via-agency-known / via-agency-unknown).
              Reads the resolved advertiser, not the denormalized deals.brand_name. */}
          {deal.viaAgency && deal.agencyName && !deal.advertiser ? (
            <>
              <Text style={styles.brandNameTBD} numberOfLines={1}>Brand TBD</Text>
              <Text style={styles.viaAgencyLine} numberOfLines={1}>via {deal.agencyName}</Text>
            </>
          ) : (
            <>
              {/* Brand + agency provenance on ONE line: "POPMART via Tec-Do". The nested
                  Text flows inline; numberOfLines={1} truncates the whole line together. */}
              <Text style={styles.brandName} numberOfLines={1}>
                {deal.advertiser ?? deal.brandName}
                {deal.viaAgency && deal.agencyName && !!deal.advertiser && (
                  <Text style={styles.viaAgencyInline}> via {deal.agencyName}</Text>
                )}
              </Text>
            </>
          )}
          {!!deal.brandCategory && (
            <Text style={styles.brandCategoryLine} numberOfLines={1}>{deal.brandCategory}</Text>
          )}
          <View style={styles.metaRow}>
            <View style={styles.statusPill}>
              <Text style={styles.statusText}>{status.label}</Text>
            </View>
            {deal.urgency === "high" && (
              <View style={styles.urgencyPill}>
                <Text style={styles.urgencyText}>Urgent</Text>
              </View>
            )}
            <View style={styles.sourceRow}>
              <PlatformIcon platform={deal.source} color="#9C968D" size={12} />
              <Text style={styles.sourceLine} numberOfLines={1}>
                {SOURCE_LABEL[deal.source]} · {deal.timeAgo}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.row1Right}>
          <Feather
            name={onPressCard ? "chevron-right" : isExpanded ? "chevron-up" : "chevron-down"}
            size={14}
            color="#C5BFB8"
          />
        </View>
      </Pressable>

      {/* ── Offer — its own full-width line, shown in both (frozen, #3) ── */}
      <View style={styles.offerLine}>
        {/* A schedule wins over the single figure: deals.amount is one number and this
            deal is not one number. */}
        {deal.money?.basis === "schedule" && formatScheduleMoney(deal.money, { compact: true }) ? (
          <View style={styles.offerLine}>
            <Text style={styles.offerLineAmount} numberOfLines={2}>{formatScheduleMoney(deal.money, { compact: true })}</Text>
          </View>
        ) : (deal.offerDisplay || deal.offerAmount) ? (
          <>
            <Text style={styles.offerLineAmount} numberOfLines={2}>{deal.offerDisplay ?? deal.offerAmount}</Text>
            {deal.rateVsMarket != null && (
              <View style={[styles.rateChip, { backgroundColor: deal.rateVsMarket >= 0 ? Bold.ground : "#EF444418" }]}>
                <Text style={[styles.rateChipText, { color: deal.rateVsMarket >= 0 ? Bold.ink : "#DC2626" }]}>
                  {deal.rateVsMarket >= 0 ? "+" : ""}{deal.rateVsMarket}% vs avg
                </Text>
              </View>
            )}
          </>
        ) : (
          <Text style={styles.noOfferText}>No offer stated</Text>
        )}
      </View>

      {/* ── AI summary — frozen line, shown in both collapsed & expanded (#2).
          Tapping the summary body toggles expand too (not just the header row). ── */}
      {!!deal.aiSummary && (
        <Pressable style={styles.summaryBlock} onPress={onPressCard ?? onToggleExpand}>
          <Text style={styles.summaryText} numberOfLines={isExpanded ? undefined : 2}>
            {deal.aiSummary}
          </Text>
        </Pressable>
      )}

      {/* ── DELIVERABLES + key date (#5, #9a) — offer $ stays in row 1 (no-reflow) ── */}
      {isExpanded && (deal.deliverables?.length || deal.convAsk || deal.deadline || deal.monthlyEstimate) && (
        <View style={styles.expandedSection}>
          <Text style={styles.expandedSectionLabel}>DELIVERABLES</Text>
          <View style={styles.detailCard}>
            {deal.deliverables && deal.deliverables.length > 0 ? (
              deal.deliverables.map((d, i) => (
                <View key={i} style={styles.deliverableRow}>
                  <Feather name="check" size={13} color={Colors.light.primary} />
                  <Text style={styles.deliverableText}>{d}</Text>
                </View>
              ))
            ) : deal.convAsk ? (
              <Text style={styles.deliverableAsk} numberOfLines={4}>{deal.convAsk}</Text>
            ) : null}
            {deal.monthlyEstimate && (
              <Text style={styles.offerMonthlyEstimate}>~${deal.monthlyEstimate}/mo estimated</Text>
            )}
            {respondByLabel(deal.deadline) && (
              <View style={styles.respondByChip}>
                <Feather name="clock" size={12} color={Bold.ink} />
                <Text style={styles.respondByText}>{respondByLabel(deal.deadline)}</Text>
              </View>
            )}
          </View>
        </View>
      )}

      {/* ── EXCLUSIVITY — its own card (#6); "none mentioned" fallback is Phase 2 ── */}
      {isExpanded && deal.factors?.exclusivity && (
        <View style={styles.expandedSection}>
          <Text style={styles.expandedSectionLabel}>EXCLUSIVITY</Text>
          <View style={styles.detailCard}>
            <Text style={styles.exclusivityText}>
              {deal.factors.exclusivity.split(/[.;]/)[0].trim()}
            </Text>
          </View>
        </View>
      )}

      {/* ── MILA'S RECOMMENDATION ── */}
      {isExpanded && deal.recommendationUi && (
        <View style={styles.expandedSection}>
          <Text style={styles.expandedSectionLabel}>{"MILA'S RECOMMENDATION"}</Text>
          <View style={styles.recoCard}>
            {deal.recommendationUi && (
              <Text style={styles.recoHeroText}>💡 {deal.recommendationUi}</Text>
            )}
            {deal.recommendation === "negotiate" && deal.negotiateTerms && deal.negotiateTerms.length > 0 && (
              <>
                <View style={styles.recoCardDivider} />
                <View style={styles.recoTermsBlock}>
                  {deal.negotiateTerms.slice(0, 3).map((term, i) => (
                    <Text key={i} style={styles.recoTermText}>· {term}</Text>
                  ))}
                </View>
              </>
            )}
          </View>
        </View>
      )}

      {/* ── LATEST ── */}
      {isExpanded && deal.latestComms && (
        <View style={styles.expandedSection}>
          <View style={styles.milasTakeHeader}>
            <Text style={styles.expandedSectionLabel}>LATEST COMMUNICATION</Text>
            {deal.awaitingResponseFrom === "athlete" && (
              <View style={styles.awaitingBadge}>
                <Text style={styles.awaitingBadgeText}>Your turn</Text>
              </View>
            )}
            {deal.awaitingResponseFrom === "brand" && (
              <View style={[styles.awaitingBadge, { backgroundColor: "#E8E4DF" }]}>
                <Text style={[styles.awaitingBadgeText, { color: "#9C968D" }]}>Their turn</Text>
              </View>
            )}
          </View>
          {(deal.messageCount != null || deal.lastContact) && (
            <Text style={styles.latestMetaLine}>
              {[
                deal.messageCount != null ? messagesLabel(deal.messageCount) : null,
                deal.lastContact ? `Last contact ${dayLabel(deal.lastContact) ?? deal.lastContact}` : null,
              ].filter(Boolean).join(" · ")}
            </Text>
          )}
          <Text style={styles.latestCommText}>{deal.latestComms}</Text>
        </View>
      )}

      {/* (drafted-reply banner removed — #8) */}

      {/* ── See full thread ── */}
      {isExpanded && onViewThread && (
        <Pressable style={styles.seeThreadRow} onPress={onViewThread}>
          <Feather name="message-square" size={13} color="#9C968D" />
          <Text style={styles.seeThreadLink}>View full conversation</Text>
          <Feather name="chevron-right" size={13} color="#9C968D" />
        </Pressable>
      )}

      {/* ── Action bar (1 primary + ••• overflow) — frozen, shown in both views (#4/#11).
          When hideActionsWhenCollapsed is set (ClassicListV2 variant), the bar is
          suppressed on the collapsed card and appears only once expanded. ── */}
      {(!hideActionsWhenCollapsed || isExpanded) &&
        (coPilotActions ? renderCoPilotPair() : renderActionBar())}

      {/* ── Inline LLM reply preview (expanded; opened via the Reply action) ── */}
      {isExpanded && showReplyCard && (
        <View style={styles.replyCard}>
          <View style={styles.replyCardLabelRow}>
            <Feather
              name={draftError ? "alert-circle" : "zap"}
              size={11}
              color={draftError ? "#E87070" : Colors.light.primary}
            />
            <Text style={[styles.replyCardLabel, draftError && styles.replyCardLabelError]}>
              {draftError ? "Error" : streaming ? "Writing…" : "Mila's reply"}
            </Text>
            {generated && !streaming && !draftError && (
              <Pressable
                onPress={() => generate({ reply_intent: recommendationToIntent(deal.recommendation), style: "friendly" })}
                hitSlop={8}
                style={styles.replyRegenBtn}
              >
                <Feather name="refresh-cw" size={11} color="#9C968D" />
                <Text style={styles.replyRegenText}>Rewrite</Text>
              </Pressable>
            )}
            <Pressable onPress={() => setShowReplyCard(false)} hitSlop={8} style={styles.replyHideBtn}>
              <Feather name="chevron-up" size={14} color="#9C968D" />
            </Pressable>
          </View>

          {draftError ? (
            <Text style={styles.replyErrorText}>{draftError}</Text>
          ) : streaming && draft.length === 0 ? (
            <View style={styles.replyLoadingRow}>
              <ActivityIndicator size="small" color={Colors.light.primary} />
              <Text style={styles.replyLoadingText}>Drafting a reply…</Text>
            </View>
          ) : (
            <TextInput
              style={[styles.replyInput, { height: Math.max(replyHeight, 140) }]}
              value={draft}
              onChangeText={editDraft}
              onContentSizeChange={(e) =>
                setReplyHeight(e.nativeEvent.contentSize.height)
              }
              multiline
              scrollEnabled={false}
              textAlignVertical="top"
              editable={!streaming}
              placeholder="Your reply will appear here…"
              placeholderTextColor="#C5BFB8"
            />
          )}

          {reply.isSuccess ? (
            <View style={styles.replySentRow}>
              <Feather name="check-circle" size={15} color={Bold.ink} />
              <Text style={styles.replySentText}>Reply sent to {deal.brandName}</Text>
            </View>
          ) : canSendInApp ? (
            <>
              <View style={styles.replyActionRow}>
                <Pressable
                  style={({ pressed }) => [
                    styles.saveDraftBtn,
                    (!generated || streaming || draft.trim().length === 0 || saving) && styles.openMailBtnDisabled,
                    pressed && { opacity: 0.85 },
                  ]}
                  onPress={() => saveDraft({ mirrorToGmail: true })}
                  disabled={!generated || streaming || draft.trim().length === 0 || saving}
                >
                  {saving ? (
                    <ActivityIndicator size="small" color={Colors.light.primary} />
                  ) : (
                    <Feather name={saved ? "check" : "save"} size={14} color={Colors.light.primary} />
                  )}
                  <Text style={styles.saveDraftBtnText}>
                    {saving ? "Saving…" : saved ? "Saved" : "Save draft"}
                  </Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [
                    styles.openMailBtn,
                    styles.sendReplyBtn,
                    (!generated || streaming || draft.trim().length === 0 || reply.isPending) && styles.openMailBtnDisabled,
                    pressed && { opacity: 0.85 },
                  ]}
                  onPress={handleSend}
                  disabled={!generated || streaming || draft.trim().length === 0 || reply.isPending}
                >
                  {reply.isPending ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Feather name="send" size={14} color="#fff" />
                  )}
                  <Text style={styles.openMailBtnText}>
                    {reply.isPending ? "Sending…" : "Send reply"}
                  </Text>
                </Pressable>
              </View>

              {reply.isError && (
                <View style={styles.replySendErrorRow}>
                  <Text style={styles.replyErrorText}>
                    {"Couldn't send your reply. Check your Gmail connection and try again."}
                  </Text>
                  <Pressable onPress={() => openReply(replyTo, draft)} hitSlop={6}>
                    <Text style={styles.replyFallbackLink}>Open in Mail instead</Text>
                  </Pressable>
                </View>
              )}
            </>
          ) : (
            // No send permission on this connection — hand off to the mail app.
            <View style={styles.replyActionRow}>
              <Pressable
                style={({ pressed }) => [
                  styles.saveDraftBtn,
                  (!generated || streaming || draft.trim().length === 0 || saving) && styles.openMailBtnDisabled,
                  pressed && { opacity: 0.85 },
                ]}
                onPress={() => saveDraft({ mirrorToGmail: true })}
                disabled={!generated || streaming || draft.trim().length === 0 || saving}
              >
                <Feather name={saved ? "check" : "save"} size={14} color={Colors.light.primary} />
                <Text style={styles.saveDraftBtnText}>
                  {saving ? "Saving…" : saved ? "Saved" : "Save draft"}
                </Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.openMailBtn,
                  styles.sendReplyBtn,
                  (!generated || streaming || draft.trim().length === 0) && styles.openMailBtnDisabled,
                  pressed && { opacity: 0.85 },
                ]}
                onPress={() => openReply(replyTo, draft)}
                disabled={!generated || streaming || draft.trim().length === 0}
              >
                <Feather name="external-link" size={14} color="#fff" />
                <Text style={styles.openMailBtnText}>Open in Mail</Text>
              </Pressable>
            </View>
          )}
        </View>
      )}


    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.light.card,
    borderRadius: BorderRadius.md,
    marginHorizontal: Spacing.lg,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "transparent",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 8,
    elevation: 3,
    overflow: "hidden",
  },
  cardExpanded: {
    borderColor: Colors.light.primary + "40",
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 5,
  },

  // ── Brand category (under the brand name) ──
  brandCategoryLine: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 11,
    color: "#9C968D",
    letterSpacing: 0.1,
    marginTop: -1,
  },
  // ── Agency provenance ("via X") ──
  viaAgencyLine: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 11,
    color: "#9C968D",
    marginTop: -1,
  },
  // Inline variant — same muted treatment, riding on the brand's line ("Brand via X").
  viaAgencyInline: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 13,
    color: "#9C968D",
  },
  // "Brand TBD" placeholder in the brand-name slot — brand-sized but muted + italic
  // so it reads as a not-yet-resolved state, not a real brand.
  brandNameTBD: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 17,
    color: "#9C968D",
    fontStyle: "italic",
    letterSpacing: 0,
  },

  // ── Offer (own full-width line) ──
  offerLine: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 8,
  },
  offerLineAmount: {
    flex: 1,
    fontFamily: Fonts.display,
    fontSize: 16,
    color: "#171513",
    letterSpacing: -0.2,
    lineHeight: 21,
  },

  // ── AI summary (frozen line) ──
  summaryBlock: {
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  summaryText: {
    fontFamily: Fonts.body,
    fontSize: 13,
    color: "#5A554E",
    lineHeight: 19,
  },

  // ── Expanded detail cards (deliverables / exclusivity) ──
  detailCard: {
    backgroundColor: Colors.light.backgroundDefault,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  deliverableRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  deliverableText: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 13,
    color: "#171513",
    lineHeight: 19,
    flex: 1,
  },
  deliverableAsk: {
    fontFamily: Fonts.body,
    fontSize: 13,
    color: "#5A554E",
    lineHeight: 19,
  },
  respondByChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    backgroundColor: Bold.ground,
    borderRadius: BorderRadius.full,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginTop: 2,
  },
  respondByText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 12,
    color: Bold.ink,
  },
  exclusivityText: {
    fontFamily: Fonts.body,
    fontSize: 13,
    color: "#5A554E",
    lineHeight: 19,
  },

  // ── Action bar (1 primary + ••• overflow) ──
  actionBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingTop: 4,
    paddingBottom: 14,
  },
  primaryBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 44,
    borderRadius: BorderRadius.full,
  },
  primaryBtnText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 14,
    color: "#fff",
  },
  overflowBtn: {
    width: 44,
    height: 44,
    borderRadius: BorderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Colors.light.border,
  },

  // ── Co-pilot pair (Brief only) — filled accent primary + ghost secondary ──
  coPilotPrimaryBtn: {
    flex: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 44,
    borderRadius: BorderRadius.full,
    backgroundColor: Bold.act,
  },
  coPilotPrimaryText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 14,
    color: "#fff",
  },
  coPilotSecondaryBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 44,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: Colors.light.border,
    backgroundColor: "transparent",
  },
  coPilotSecondaryText: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 14,
    color: Colors.light.textMuted,
  },
  waitingPill: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    height: 44,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.light.backgroundDefault,
    borderWidth: 1,
    borderColor: Colors.light.borderLight,
  },
  waitingText: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 13,
    color: "#9C968D",
  },
  replyHideBtn: {
    marginLeft: 2,
  },

  // ── Row 1 ──
  row1: {
    flexDirection: "row",
    alignItems: "center",
    gap: LOGO_GAP,
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 10,
  },
  logoWrap: {
    position: "relative",
    flexShrink: 0,
  },
  catBadge: {
    position: "absolute",
    bottom: -3,
    left: -3,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: Colors.light.card,
  },
  brandCol: {
    flex: 1,
    gap: 4,
  },
  brandName: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 17,
    color: "#171513",
    letterSpacing: 0,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  statusPill: {
    borderRadius: BorderRadius.full,
    paddingHorizontal: 7,
    paddingVertical: 2,
    flexShrink: 0,
    backgroundColor: "#1C1915",
  },
  statusText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 10,
    letterSpacing: 0.5,
    color: "#FFFFFF",
  },
  sourceRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           4,
    flex:          1,
  },
  sourceLine: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 11,
    color: "#9C968D",
    letterSpacing: 0.1,
    flex: 1,
  },
  urgencyPill: {
    borderRadius: BorderRadius.full,
    paddingHorizontal: 7,
    paddingVertical: 2,
    backgroundColor: "#F59E0B18",
    borderWidth: 1,
    borderColor: "#F59E0B50",
    flexShrink: 0,
  },
  urgencyText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 10,
    letterSpacing: 0.3,
    color: "#B45309",
  },
  offerMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 2,
  },
  offerMetaAmount: {
    fontFamily: Fonts.display,
    fontSize: 17,
    color: "#171513",
    letterSpacing: -0.3,
    flex: 1,
  },
  rateChip: {
    borderRadius: BorderRadius.full,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  rateChipText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 10,
    letterSpacing: 0.2,
  },
  rateEmoji: {
    fontSize: 11,
  },
  row1Right: {
    alignItems: "center",
    gap: 4,
    flexShrink: 0,
  },
  // ── Collapsed comms one-liner ──
  collapsedCommsBlock: {
    borderLeftWidth: 2,
    borderLeftColor: "#C5BFB8",
    paddingLeft: 10,
    paddingVertical: 4,
    marginHorizontal: 14,
    marginBottom: 6,
  },

  // ── Reasons block (expanded fallback for pre-factorRatings deals) ──
  reasonsBlock: {
    borderLeftWidth: 3,
    borderRadius: 4,
    paddingLeft: 10,
    paddingRight: 8,
    paddingVertical: 8,
    backgroundColor: Colors.light.backgroundDefault,
  },
  reasonsList: {
    gap: 5,
  },
  reasonRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 7,
  },
  reasonBullet: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    marginTop: 7,
    flexShrink: 0,
  },
  reasonText: {
    flex: 1,
    fontFamily: Fonts.body,
    fontSize: 12,
    color: "#5A554E",
    lineHeight: 18,
    letterSpacing: 0.1,
  },

  // ── Collapsed actions ──
  collapsedActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingBottom: 12,
    marginTop: 4,
  },
  bookmarkBtn: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  collapsedActionsBtns: {
    flexDirection: "row",
    gap: 8,
  },
  collapsedActionBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  collapsedActionBtnRing: {
    borderWidth: 2,
    borderColor: "#FFFFFF",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 4,
  },
  collapsedActionBtnRingGray: {
    borderWidth: 2,
    borderColor: "#9C968D",
  },
  collapsedResolved: {
    alignItems: "flex-end",
    paddingHorizontal: 14,
    paddingBottom: 12,
    marginTop: 4,
  },

  // ── Expanded sections ──
  expandedSection: {
    marginHorizontal: 14,
    marginBottom: 12,
    gap: 8,
  },
  expandedSectionLabel: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 11,
    color: "#6B6560",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },

  // ── THE OFFER card ──
  offerCard: {
    backgroundColor: Colors.light.backgroundDefault,
    borderRadius: 8,
    padding: 12,
    gap: 10,
  },
  offerCardAmountRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  offerCardAmount: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 15,
    letterSpacing: 0,
    flexShrink: 1,
  },
  offerMonthlyEstimate: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: "#9C968D",
    marginTop: -2,
  },
  offerAskRow: {
    gap: 3,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.light.borderLight,
  },
  offerAskText: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: "#5A554E",
    lineHeight: 17,
  },
  offerColHeader: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 10,
    color: "#9C968D",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginBottom: 2,
  },

  // ── MILA'S TAKE header ──
  milasTakeHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  milasTakeHeaderRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  brandTierPill: {
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  brandTierPillText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 11,
  },

  // ── Factor grid ──
  factorGrid: {
    backgroundColor: Colors.light.backgroundDefault,
    borderRadius: 8,
    overflow: "hidden",
  },
  factorGridRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.light.borderLight,
    gap: 8,
  },
  factorGridLabel: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 12,
    color: "#9C968D",
    width: 100,
    flexShrink: 0,
  },
  factorGridEmoji: {
    fontSize: 13,
    width: 20,
    textAlign: "center",
    flexShrink: 0,
  },
  factorGridValue: {
    flex: 1,
    fontFamily: Fonts.body,
    fontSize: 12,
    color: "#5A554E",
  },
  factorGridEmojiSpacer: {
    width: 20,
    flexShrink: 0,
  },
  factorGridSectionDivider: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.light.borderLight,
    backgroundColor: "#F2EFE9",
  },
  factorGridSectionLabel: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 10,
    color: "#9C968D",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },

  // ── Brand tier row (inside factor grid — matches factorGridRow layout) ──
  brandTierRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.light.borderLight,
    gap: 8,
  },
  // ── About The Brand link row ──
  aboutBrandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  aboutBrandText: {
    flex: 1,
    fontFamily: Fonts.bodySemiBold,
    fontSize: 12,
    color: Colors.light.primary,
    letterSpacing: 0.1,
  },

  // ── MILA'S RECOMMENDATION card ──
  recoCard: {
    backgroundColor: Bold.actSoft,
    borderLeftWidth: 3,
    borderLeftColor: Bold.act,
    borderRadius: 6,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 10,
  },
  recoCardDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Bold.act + "30",
  },
  recoHeroText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 14,
    color: Bold.act,
    lineHeight: 20,
  },
  recoTermsBlock: {
    gap: 5,
  },
  recoTermText: {
    fontFamily: Fonts.body,
    fontSize: 13,
    color: "#4A4A4A",
    lineHeight: 19,
  },

  // ── Capital contribution note ──

  // ── No offer fallback ──
  noOfferText: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 12,
    color: "#9C968D",
    fontStyle: "italic",
    marginTop: 2,
  },

  // ── Red flags (condensed) ──
  redFlagRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    backgroundColor: "#FDF6E3",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  redFlagIcon: {
    fontSize: 12,
    marginTop: 1,
    flexShrink: 0,
  },
  redFlagText: {
    flex: 1,
    fontFamily: Fonts.body,
    fontSize: 12,
    color: "#7A5A00",
    lineHeight: 17,
  },

  // ── Awaiting badge ──
  awaitingBadge: {
    backgroundColor: Bold.actSoft,
    borderRadius: BorderRadius.full,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  awaitingBadgeText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 10,
    color: Colors.light.primary,
    letterSpacing: 0.3,
  },

  // ── LATEST ──
  latestMetaLine: {
    fontFamily: Fonts.body,
    fontSize: 11,
    color: "#9C968D",
    letterSpacing: 0.1,
    marginTop: -2,
  },
  latestCommText: {
    fontFamily: Fonts.body,
    fontSize: 13,
    color: "#5A554E",
    lineHeight: 19,
  },
  askMilaBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    marginHorizontal:  Spacing.lg,
    marginBottom:      Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical:   Spacing.sm,
    backgroundColor:   Colors.light.primary + "0C",
    borderRadius:      BorderRadius.xs,
    borderWidth:       1,
    borderColor:       Colors.light.primary + "25",
  },
  askMilaBtnText: {
    flex:       1,
    fontFamily: Fonts.bodyMedium,
    fontSize:   13,
    color:      Colors.light.primary,
  },
  seeThreadRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: Spacing.xl,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: Colors.light.borderLight,
  },
  seeThreadLink: {
    flex: 1,
    fontFamily: Fonts.bodyMedium,
    fontSize: 12,
    color: "#9C968D",
    letterSpacing: 0.1,
  },

  // ── Draft banner ──
  draftBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 14,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: Colors.light.primary + "10",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.light.primary + "30",
  },
  draftBannerText: {
    flex: 1,
    gap: 1,
  },
  draftBannerTitle: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 13,
    color: Colors.light.primary,
  },
  draftBannerTone: {
    fontFamily: Fonts.body,
    fontSize: 11,
    color: Colors.light.primary,
    opacity: 0.7,
    textTransform: "capitalize",
  },

  // ── Reply button ──
  replyBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "center",
    gap:               7,
    height:            44,
    marginHorizontal:  14,
    marginBottom:      10,
    borderRadius:      BorderRadius.full,
    backgroundColor:   "#1C1915",
  },
  replyBtnText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize:   14,
    color:      "#fff",
  },

  // ── Inline reply preview card ──
  replyCard: {
    marginHorizontal: 14,
    marginBottom:     10,
    padding:          14,
    gap:              10,
    borderRadius:     16,
    backgroundColor:  Colors.light.backgroundDefault,
    borderWidth:      1,
    borderColor:      Colors.light.borderLight,
  },
  replyCardLabelRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           5,
  },
  replyCardLabel: {
    fontFamily:    Fonts.bodySemiBold,
    fontSize:      11,
    color:         Colors.light.primary,
    letterSpacing: 0.3,
    flex:          1,
  },
  replyCardLabelError: {
    color: "#E87070",
  },
  replyRegenBtn: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           4,
  },
  replyRegenText: {
    fontFamily: Fonts.bodyMedium,
    fontSize:   11,
    color:      "#9C968D",
  },
  replyLoadingRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
    paddingVertical: 8,
  },
  replyLoadingText: {
    fontFamily: Fonts.body,
    fontSize:   13,
    color:      "#9C968D",
  },
  replyErrorText: {
    fontFamily: Fonts.body,
    fontSize:   13,
    color:      "#E87070",
    lineHeight: 18,
  },
  replyInput: {
    fontFamily:      Fonts.body,
    fontSize:        14,
    color:           Colors.light.text,
    lineHeight:      22,
    backgroundColor: Colors.light.card,
    borderRadius:    12,
    padding:         12,
    borderWidth:     1,
    borderColor:     Colors.light.borderLight,
  },
  openMailBtn: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             7,
    height:          42,
    borderRadius:    BorderRadius.full,
    backgroundColor: Colors.light.primary,
  },
  replyActionRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
  },
  saveDraftBtn: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             6,
    height:          42,
    paddingHorizontal: 14,
    borderRadius:    BorderRadius.full,
    borderWidth:     1,
    borderColor:     Colors.light.primary,
    backgroundColor: "transparent",
  },
  saveDraftBtnText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize:   13,
    color:      Colors.light.primary,
  },
  sendReplyBtn: {
    flex: 1,
  },
  openMailBtnDisabled: {
    opacity: 0.4,
  },
  openMailBtnText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize:   14,
    color:      "#fff",
  },
  replySentRow: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             7,
    height:          42,
    borderRadius:    BorderRadius.full,
    backgroundColor: Bold.ground,
  },
  replySentText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize:   14,
    color:      Bold.ink,
  },
  replySendErrorRow: {
    gap:        6,
    marginTop:  2,
    alignItems: "center",
  },
  replyFallbackLink: {
    fontFamily:          Fonts.bodySemiBold,
    fontSize:            13,
    color:               Colors.light.primary,
    textDecorationLine:  "underline",
  },

  // ── Expanded footer actions ──
  expandedFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginHorizontal: 14,
    marginBottom: 14,
    marginTop: 4,
  },
  expandedBookmarkBtn: {
    width: 40,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  expandedFooterBtns: {
    flex: 1,
    flexDirection: "row",
    gap: 8,
    marginLeft: 4,
  },
  expandedBtn: {
    flex: 1,
    height: 44,
    borderRadius: BorderRadius.full,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  expandedBtnText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 14,
    color: "#fff",
  },
  expandedDecline: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#E8E4DF",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  expandedBtnRing: {
    borderWidth: 2,
    borderColor: "#FFFFFF",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 4,
  },
  expandedDeclineRing: {
    borderWidth: 1.5,
    borderColor: "#9C968D",
  },
  expandedResolved: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingBottom: 14,
  },
  expandedResolvedText: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 13,
    color: "#9C968D",
  },
});
