// WS-Brief · coPilotActions — the DYNAMIC co-pilot action pair for a Brief deal card.
//
// Pure, dependency-free (no React/RN/network) so every branch is trivially unit-testable
// and the Brief stays a thin view over it. Given a deal's LATEST state, it picks Mila's
// single next-best move (the primary) plus one quiet alternative (the secondary).
//
// Money-safe: "priced" is decided from a real currency figure only — a bare deliverable
// count like "3 posts" is NOT a price. Nothing here states or invents a rate.
//
// The PRIMARY is Mila's dynamic recommended move; the SECONDARY is uniform on every
// card — "I'll decide" → opens the DecisionSheet.
//
// That sheet is Mila showing her working, NOT a menu of alternatives: her position, an
// expandable "why" (reasons + red flags), the negotiate terms as a numbered plan, and
// then the same primary action plus "See thread". Pass, accept and decline are not in
// there. This comment used to promise all of them, which made the secondary sound like
// an escape hatch when it is really a justification.
//
//   recommendation reject/delete → Not for me    · I'll decide
//   unpriced, brand asked HER rate → Send your rate · I'll decide
//   unpriced, otherwise           → Ask for terms  · I'll decide
//   priced, recommendation accept → Draft a yes    · I'll decide
//   priced, otherwise             → Counter        · I'll decide

import type { DealItem } from "../DealCard";

// ─── Types ────────────────────────────────────────────────────────────────────────

export type CoPilotPrimaryKind = "askTerms" | "sendRate" | "draftYes" | "counter" | "notForMe";
// The secondary is always the "see all options" escape hatch — never a trap.
export type CoPilotSecondaryKind = "decide";

export interface CoPilotPair {
  primary:   { kind: CoPilotPrimaryKind; label: string };
  secondary: { kind: CoPilotSecondaryKind; label: string };
}

// The one, uniform secondary — Mila's "you choose" route into the full Decision sheet.
const DECIDE_SECONDARY: CoPilotPair["secondary"] = { kind: "decide", label: "I'll decide" };

// ─── Signals ────────────────────────────────────────────────────────────────────────

// The money test now lives in dealActions, because BOTH action resolvers depend on it and
// two copies is how they drifted apart in the first place. Re-exported so this module's
// own tests and callers are unchanged.
import { isPriced } from "../dealActions";
export { isPriced };

// The latest comm is asking HER for a rate/quote — she should lead with her number,
// not ask them to name one first.
const SEND_RATE_RE = /your rate|how much|what.*(charge|cost)|quote|pricing|what.*budget.*you|send.*rate/i;

/** True when the thread's latest state is a request for the athlete's rate/quote. */
export function asksForRate(deal: DealItem): boolean {
  return SEND_RATE_RE.test(`${deal.convAsk ?? ""} ${deal.aiSummary ?? ""}`);
}

// ─── The decision ─────────────────────────────────────────────────────────────────

/**
 * Mila's next-best move for a deal, given its latest state. Returns a primary
 * (the recommended action) + a quiet secondary (the escape hatch).
 */
export function coPilotAction(deal: DealItem): CoPilotPair {
  const rec = deal.recommendation;

  // Mila recommends passing entirely — lead with the graceful "no".
  if (rec === "reject" || rec === "delete") {
    return {
      primary:   { kind: "notForMe", label: "Not for me" },
      secondary: DECIDE_SECONDARY,
    };
  }

  // No price on the table yet — there's nothing to counter, only terms to ask for.
  if (!isPriced(deal)) {
    return {
      primary: asksForRate(deal)
        ? { kind: "sendRate", label: "Send your rate" }
        : { kind: "askTerms", label: "Ask for terms" },
      secondary: DECIDE_SECONDARY,
    };
  }

  // A real number is on the table — accept it (draft a yes) or push back (counter).
  return {
    primary: rec === "accept"
      ? { kind: "draftYes", label: "Draft a yes" }
      : { kind: "counter", label: "Counter" },
    secondary: DECIDE_SECONDARY,
  };
}
