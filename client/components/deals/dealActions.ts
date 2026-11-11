import type { DealItem } from "./DealCard";
import { coPilotAction } from "./brief/coPilotActions";

/**
 * A real money figure: a currency-marked amount ($2,000 / EUR500), a thousands-separated
 * number (2,000), or a k/m magnitude suffix (1.5k, 3m). A bare deliverable count ("3
 * posts") has none of these, so it never reads as priced.
 *
 * This lives here rather than beside one caller because BOTH action resolvers need it and
 * only one of them had it. coPilotAction (the Brief) checked it and correctly offered "Ask
 * for terms"; resolveDealActions (Deal Detail) did not, and labelled the same deal "Counter
 * offer" — an instruction to counter an offer that was never made. Twelve of the deals
 * currently on screen are in exactly that state, Mila's own text reading "Request full
 * proposal" or "Get pricing & scope first" directly above the button.
 */
const MONEY_RE = /[$€£]\s?\d|\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s?[km]\b/i;

/** True when a real currency value appears in the offer fields (never a bare count). */
export function isPriced(deal: DealItem): boolean {
  const offer = `${deal.offerDisplay ?? ""} ${deal.offerAmount ?? ""}`;
  return MONEY_RE.test(offer);
}

// ─── Conditional action model ────────────────────────────────────────────────
//
// A deal card surfaces ONE primary action (Mila's recommended move, given the
// deal's lifecycle stage and whose turn it is) plus a set of alternatives in an
// overflow menu — so the athlete can always overrule Mila one tap away. The same
// resolver feeds both the collapsed and expanded card, so the two stay in sync.

export type DealActionKind =
  | "accept"      // open the accept composer
  | "negotiate"   // open the counter/negotiate composer
  | "askTerms"    // open the composer in request-terms mode (no rate is named)
  | "reply"       // open the inline reply (mid-negotiation, your turn)
  | "decline"     // decline the deal
  | "dismiss"     // dismiss spam / zero-value outreach (uses the decline handler)
  | "viewThread"  // open the full conversation
  | "nudge"       // follow up when the brand owes a reply (opens the thread)
  | "markDone"    // accepted → completed
  | "reopen"      // declined → back to New
  | "save";       // bookmark for later

export type ActionTone = "accept" | "negotiate" | "decline" | "neutral";

export interface DealAction {
  kind:  DealActionKind;
  label: string;
  icon:  any; // Feather icon name
  tone:  ActionTone;
}

export interface ResolvedDealActions {
  /** The single prominent action, or null when we're waiting on the brand. */
  primary:  DealAction | null;
  /** True → render a muted "Waiting on brand" state instead of a CTA. */
  waiting:  boolean;
  /** Alternatives shown under the ••• menu (always ends with Save). */
  overflow: DealAction[];
}

const SAVE: DealAction = { kind: "save",       label: "Save for later",   icon: "bookmark",        tone: "neutral" };
const VIEW: DealAction = { kind: "viewThread", label: "View conversation", icon: "message-square", tone: "neutral" };
const NUDGE: DealAction = { kind: "nudge",     label: "Send a nudge",      icon: "bell",           tone: "neutral" };
const DISMISS: DealAction = { kind: "dismiss", label: "Dismiss",           icon: "trash-2",        tone: "decline" };
const MARK_DONE: DealAction = { kind: "markDone", label: "Mark as done",   icon: "check-circle",   tone: "neutral" };
const REOPEN: DealAction = { kind: "reopen",   label: "Reopen deal",       icon: "rotate-ccw",     tone: "neutral" };

const accept    = (label = "Accept"):        DealAction => ({ kind: "accept",    label, icon: "check",          tone: "accept"   });
const askTerms  = (label = "Ask for terms"): DealAction => ({ kind: "askTerms",  label, icon: "help-circle",    tone: "negotiate" });
const negotiate = (label = "Counter offer"): DealAction => ({ kind: "negotiate", label, icon: "message-circle", tone: "negotiate" });
const reply     = (label = "Reply"):         DealAction => ({ kind: "reply",     label, icon: "edit-3",         tone: "negotiate" });
const decline   = (label = "Decline"):       DealAction => ({ kind: "decline",   label, icon: "x",              tone: "decline"  });

/**
 * The PRIMARY action, taken from the co-pilot resolver rather than resolved again here.
 *
 * Two functions used to answer "what is the next move for this deal", from the same
 * inputs, with different logic — and they disagreed on six of seven cases. Three of those
 * were different ACTS rather than different wording, the worst being an unpriced deal
 * where the Brief said "Ask for terms" and Deal Detail said "Accept & reply". Accept what?
 * No offer had been made.
 *
 * coPilotAction is the better logic and it is not close: it is the only one that consults
 * whether a price exists and whether the brand asked HER to name one. So it wins, and this
 * maps its vocabulary into the DealAction shape the sticky bar already renders.
 *
 * The split was never a design decision. The commit that introduced the co-pilot pair says
 * the prop was "additive — Classic + ClassicListV2 (no prop) render the old action bar
 * unchanged", which is a safe-rollout pattern. This finishes that migration.
 *
 * NOT used for lifecycle states. A completed deal must not be told to "Draft a yes", and
 * the co-pilot resolver knows nothing about whose turn it is or whether a deal is already
 * won — resolveDealActions still owns those, and the caller below picks accordingly.
 */
export function coPilotPrimary(deal: DealItem): DealAction {
  const { primary } = coPilotAction(deal);
  switch (primary.kind) {
    case "askTerms": return askTerms(primary.label);
    // She names the number, so it is the negotiate composer — same as the Brief does.
    case "sendRate": return negotiate(primary.label);
    case "draftYes": return accept(primary.label);
    case "counter":  return negotiate(primary.label);
    case "notForMe": return decline(primary.label);
  }
}

/**
 * Resolve the primary + overflow actions for a deal from its lifecycle stage
 * (`status`), whose turn it is (`awaitingResponseFrom`), and Mila's
 * recommendation. Pure — no side effects; the card maps each kind to a handler.
 */
export function resolveDealActions(deal: DealItem): ResolvedDealActions {
  const { status, recommendation: rec, awaitingResponseFrom: turn } = deal;

  // ── Resolved lifecycle states — review + a way back ──
  if (status === "accepted") {
    return { primary: VIEW, waiting: false, overflow: [MARK_DONE, SAVE] };
  }
  if (status === "completed") {
    return { primary: VIEW, waiting: false, overflow: [SAVE] };
  }
  if (status === "rejected") {
    return { primary: VIEW, waiting: false, overflow: [REOPEN, SAVE] };
  }

  // ── Mid-negotiation — gate the primary on whose turn it is ──
  if (status === "negotiating") {
    if (turn === "brand") {
      // Their turn: nothing to reply to. Muted state; nudge/view in overflow.
      return { primary: null, waiting: true, overflow: [NUDGE, VIEW, decline(), SAVE] };
    }
    // Your turn (or unknown): a reply is the move.
    return { primary: reply("Reply"), waiting: false, overflow: [accept("Accept now"), decline(), VIEW, SAVE] };
  }

  // ── New (detected / pending) — Mila's recommendation drives the primary ──
  switch (rec) {
    case "accept":
      return { primary: accept("Accept & reply"), waiting: false, overflow: [negotiate(), decline(), SAVE] };
    case "reject":
      return { primary: decline("Decline"), waiting: false, overflow: [reply("Reply anyway"), SAVE] };
    case "delete":
      return { primary: DISMISS, waiting: false, overflow: [decline("Decline politely"), SAVE] };
    case "negotiate":
    default:
      // REVERTED, deliberately. This said "Ask for terms" on an unpriced deal, which is
      // the truthful label — but the tap still routes to the negotiate composer, whose
      // intent drafts a counter to a price nobody named. A button that tells the truth
      // and then does something else is worse than one that is consistently blunt, so it
      // is blunt again until the Brief / Explore All reply flows are designed together.
      //
      // The fix is small when we get there: route on isPriced (below) to
      // DealActionSheet mode "terms", which already exists and which the Brief already
      // uses. Both halves have to move at once.
      return { primary: negotiate("Counter offer"), waiting: false, overflow: [accept(), decline(), SAVE] };
  }
}

// Tone → fill color for the primary button / accents. The main action is the ONE raspberry (Bold.act) whether it
// accepts or counters; ring colours never paint a button (one look, 23 Oct 2026). Bold.act's hex: this module stays
// React-free (its tests run without react-native), so it cannot import constants/theme.
const ACT = "#C8325A";
export const ACTION_TONE_COLOR: Record<ActionTone, string> = {
  accept:    ACT,
  negotiate: ACT,
  decline:   "#9C968D",
  neutral:   "#6B6660",
};
