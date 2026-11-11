// WS2 · negotiateLogic — the pure core behind the Negotiate composer.
//
// Dependency-free (no React, no RN, no hooks) so it's trivially unit-testable and
// the composer stays a thin view over it. Mirrors the money-safety spirit of
// server/lib/dealVoice.ts: every figure the composer SHOWS must be backed by real
// data (a floor the athlete set, a suggested rate from the rate card, or the
// athlete's own typed counter) — these helpers never fabricate a number.
//
// Mined from the orphaned Variant B `opps/detail/DraftReply.tsx` (tone + tappable
// asks) and folded down to the two things the Brief's negotiate path needs: the
// three-number strip and the draft-point chips.

import type { RateFloorKey } from "../../../hooks/use-deals";
import type { DealCategory } from "../DealCard";

// ─── Tones (2, not 4) ──────────────────────────────────────────────────────────
// Variant B shipped 4 tones (enthusiastic / professional / higher / decline). The
// Brief composer is a NEGOTIATE-only surface, so the two that remain are the two
// styles of a counter: Friendly and Professional. Both drive reply_intent
// "negotiate"; only the draft `style` differs — matching the draft endpoint's
// existing `style: "friendly" | "professional"` contract (see use-deal-draft.ts).

export type NegotiateToneId = "friendly" | "professional";

export interface NegotiateTone {
  id:    NegotiateToneId;
  label: string;
  icon:  "smile" | "briefcase";
}

export const NEGOTIATE_TONES: NegotiateTone[] = [
  { id: "friendly",     label: "Friendly",     icon: "smile" },
  { id: "professional", label: "Professional", icon: "briefcase" },
];

/** A tone → the two fields the draft endpoint expects. reply_intent is always
 *  "negotiate" here (this surface only ever counters). */
export function toneToDraftParams(
  tone: NegotiateToneId,
): { style: NegotiateToneId; reply_intent: "negotiate" } {
  return { style: tone, reply_intent: "negotiate" };
}

// ─── Deal type ↔ rate-floor key ────────────────────────────────────────────────
// The floor lives in `deal_preferences.minimum_rates`, keyed by RateFloorKey
// (socialPost / appearance / …). The client `DealItem` only carries the coarse
// `category` (PAID / MEDIA / EDITORIAL / GIFTING), not the server's granular
// `deal_type`, so we approximate. socialPost is the honest default: it's the
// headline per-post anchor the whole app already quotes ($835 for our test
// athlete), and the Brief's asks are per-post-content dominant.
//
// SEAM: when the client `DealItem` surfaces the server `deal_type` (today it's
// dropped in use-deals.ts `mapToDealItem`, out of this lane), swap this coarse
// map for a direct deal_type → RateFloorKey lookup.
const CATEGORY_TO_RATE_KEY: Record<DealCategory, RateFloorKey> = {
  PAID:      "socialPost",
  GIFTING:   "socialPost",
  EDITORIAL: "socialPost",
  MEDIA:     "appearance",
};

export function rateKeyForCategory(category: DealCategory): RateFloorKey {
  return CATEGORY_TO_RATE_KEY[category] ?? "socialPost";
}

// ─── Money ─────────────────────────────────────────────────────────────────────

/** "$1,000" — whole dollars, US grouping. Matches dealVoice.formatMoney. */
export function formatMoney(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** Strip a free-text money input down to a positive integer, or null. Empty /
 *  zero / garbage → null (so the caller shows "—" rather than a fake number). */
export function sanitizeCounterInput(text: string): number | null {
  const digits = (text ?? "").replace(/[^0-9]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ─── Three-number strip ─────────────────────────────────────────────────────────

export interface ThreeNumbers {
  /** Walk-away line — the athlete's floor for this deal type (or null = not set). */
  floor:          number | null;
  /** Market benchmark — the suggested/anchor rate (rate-card mid, or null). */
  suggested:      number | null;
  /** What the counter input should seed to. Defaults to the suggested mid; falls
   *  back to the floor when there's no suggested rate; null when we have neither
   *  (the athlete types her own — we never invent a starting number). */
  counterDefault: number | null;
}

/**
 * Resolve the three numbers from the two backed inputs. Both inputs are already
 * validated by the caller (floor from `minimum_rates`, mid from the rate card),
 * so this is pure arithmetic + the counter-default rule.
 *
 * Counter default (spec): "Default the counter to the suggested mid." We fall
 * back to the floor only when there's no suggested rate at all, so the athlete
 * always opens on a real, defensible number when one exists.
 */
export function resolveThreeNumbers(
  floor:        number | null | undefined,
  suggestedMid: number | null | undefined,
): ThreeNumbers {
  const f = typeof floor === "number" && Number.isFinite(floor) && floor > 0 ? floor : null;
  const s = typeof suggestedMid === "number" && Number.isFinite(suggestedMid) && suggestedMid > 0 ? suggestedMid : null;
  return { floor: f, suggested: s, counterDefault: s ?? f ?? null };
}

// ─── Draft-point chips ──────────────────────────────────────────────────────────
// Selectable points to fold into the counter. Source-of-truth preference:
//   1. `deal.draftPoints` (score.draft_points) — the richest referenceable facts,
//   2. `deal.negotiateTerms` (score.negotiate_terms) — scored negotiation moves,
//   3. a static starter set.
// Both server fields are now surfaced on the client `DealItem` (use-deals.ts).

export interface DraftPoint {
  id:   string;
  chip: string; // short label for the chip
  term: string; // full sentence fed to the draft endpoint as a selected_term
}

/** Static fallback when a deal has no scored negotiate terms yet. Rate-negotiation
 *  flavored (PLACEHOLDER copy — the LLM rewrites into the athlete's voice). */
export const STATIC_STARTER_POINTS: DraftPoint[] = [
  { id: "usage", chip: "Lock usage rights",    term: "Confirm the usage license and term in writing before we lock the rate." },
  { id: "excl",  chip: "Keep non-exclusive",   term: "Keep this non-exclusive so I'm free to work with other brands." },
  { id: "scope", chip: "Confirm deliverables", term: "Confirm the exact deliverables and revision count so the rate matches the scope." },
];

/** Chip list for a deal: `draftPoints` when present, else scored `negotiateTerms`,
 *  else the static starter set. Truncates long terms for the chip label (full text
 *  still sent). */
export function resolveDraftPoints(
  draftPoints?: string[] | null,
  negotiateTerms?: string[] | null,
): DraftPoint[] {
  const clean = (arr?: string[] | null) =>
    (arr ?? []).filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  const terms = clean(draftPoints).length > 0 ? clean(draftPoints) : clean(negotiateTerms);
  if (terms.length === 0) return STATIC_STARTER_POINTS;
  return terms.slice(0, 4).map((t, i) => ({
    id:   `t${i}`,
    chip: t.length > 26 ? `${t.slice(0, 24).trim()}…` : t,
    term: t,
  }));
}

// ─── Counter instruction ────────────────────────────────────────────────────────

/**
 * The `custom_instruction` we hand the draft endpoint so the generated reply
 * counters at the athlete's number. The counter is the whole point of this
 * surface, and it's a figure the athlete typed (or the suggested mid she
 * accepted) — always backed, so it's safe to state. Returns "" when there's no
 * counter, so we never instruct the model to invent a rate.
 *
 * `floor` is passed only as a private guard rail for the model (don't drop below
 * it); it is NOT restated as a second number in the ask.
 */
export function buildCounterInstruction(
  counter: number | null,
  floor:   number | null,
): string {
  if (counter == null) return "";
  const base = `Counter at ${formatMoney(counter)} for this work and hold that as my rate.`;
  return floor != null && floor > 0
    ? `${base} Do not go below ${formatMoney(floor)}; keep the tone collaborative.`
    : base;
}
