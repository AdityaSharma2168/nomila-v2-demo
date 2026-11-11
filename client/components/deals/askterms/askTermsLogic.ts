// WS4 · Ask-for-Terms — askTermsLogic: the pure core of the batch co-pilot.
//
// Dependency-free (no React, no RN, no hooks) so it's trivially unit-testable and
// AskTermsBatch stays a thin view over it. Mirrors inflightLogic.ts / filesLogic.ts.
//
// Three honest, money-safe jobs:
//   1. isUnpricedCandidate() — WHICH inbound deals belong in the pool: a real, still
//      -open thread on which NO price has been named. "No price named" is read from
//      ONLY real currency figures on the DealItem (offerAmount / offerDisplay /
//      offerHistory) — a deal with any stated dollar figure is `negotiate`, not
//      `request_terms`, and is excluded. Set-aside/filed threads (threadStatus
//      'archived') and passed deals (status 'rejected') are excluded — asking would
//      reopen a killed deal.
//   2. segmentOf() — bucket a candidate by thread age × sender-type. Sender-type wins:
//      an agency-mediated thread (viaAgency) is its own variant regardless of age; a
//      direct thread buckets by age (Fresh <30d · Gone quiet 30–90d · Old 90+d).
//   3. default-checked rules — the review is SUBTRACTIVE (rows pre-checked, the athlete
//      unchecks to exclude), EXCEPT the Old (90+d) segment, which defaults OFF: reviving
//      a months-cold thread is the one ask that shouldn't happen without a deliberate opt-in.
//
// Nothing here sends, drafts, or names a rate. It only decides who is a candidate,
// which segment they fall in, and whether their row starts checked.

import type { DealItem, DealStatus } from "../DealCard";

// ─── Open / active ─────────────────────────────────────────────────────────────

// A deal is still "live" (askable) for these statuses. accepted/completed/rejected
// are settled — asking for terms on them makes no sense.
const ACTIVE_STATUSES: ReadonlySet<DealStatus> = new Set<DealStatus>([
  "detected",
  "pending",
  "negotiating",
]);

export function isActive(status: DealStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

// ─── "No price named" ──────────────────────────────────────────────────────────

// Pull real, currency-marked figures ("$500", "$1,000") from free text. The `$`
// requirement is the money-safety guard: a bare "3" (as in "3 posts") is never
// mistaken for a dollar amount. Mirrors inflightLogic.parseCurrencyTokens.
function parseCurrencyTokens(text: string): number[] {
  const out: number[] = [];
  const re = /\$\s?([\d,]+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1].replace(/,/g, ""));
    if (isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

/**
 * Has a real dollar figure been named ANYWHERE on this deal? Reads only the honest,
 * currency-marked figures the server surfaces:
 *   - offerHistory[] — the ordered stated-amounts sequence (the true progression),
 *   - offerDisplay   — the verbatim one-line offer ("$75/creative · 15%"),
 *   - offerAmount    — the single resolved offer ("$500").
 * A `true` here means the deal is priced → it's a `negotiate`, not `request_terms`.
 */
export function hasNamedPrice(
  deal: Pick<DealItem, "offerAmount" | "offerDisplay" | "offerHistory">,
): boolean {
  const fromHistory = (deal.offerHistory ?? []).filter(
    (n): n is number => typeof n === "number" && isFinite(n) && n > 0,
  );
  if (fromHistory.length > 0) return true;
  if (deal.offerDisplay && parseCurrencyTokens(deal.offerDisplay).length > 0) return true;
  if (deal.offerAmount) {
    if (parseCurrencyTokens(deal.offerAmount).length > 0) return true;
    const bare = Number(deal.offerAmount.replace(/[^\d.]/g, ""));
    if (isFinite(bare) && bare > 0) return true;
  }
  return false;
}

/**
 * The RAW unpriced-inbound pool: a real inbound we can reply to, still open, with NO
 * price named, that hasn't been filed away or passed on. This is BEFORE the value
 * qualification (paid-type / commission / decline) below.
 *   · open        — status ∈ {detected, pending, negotiating}
 *   · repliable   — has a threadId (the batch is N threaded replies; no thread = nothing to reply to)
 *   · unpriced    — !hasNamedPrice (no stated dollar figure anywhere)
 *   · not filed   — threadStatus !== 'archived' (set-aside threads are out of the Brief)
 * (status 'rejected'/passed is already excluded by the open check.)
 */
export function isUnpricedInbound(deal: DealItem): boolean {
  if (!isActive(deal.status)) return false;
  if (!deal.threadId) return false;
  if (deal.threadStatus === "archived") return false;
  if (deal.channel === "unverifiable") return false; // never batch-ask a sender we can't verify
  // An interview / press ask or a school request is answered, never asked for a budget.
  if (deal.sourceCategory === "MEDIA" || deal.sourceCategory === "SCHOOL_NIL") return false;
  // Opportunities PR 1: when the thread carries a qualification, it decides — only
  // `needs_terms` is a terms conversation. Older threads fall back to "no price named".
  if (deal.qualification) return deal.qualification === "needs_terms";
  if (hasNamedPrice(deal)) return false;
  return true;
}

// ─── Value qualification — only pursue deals worth an ask ──────────────────────

// Real paid-type categories worth asking a budget for. GIFTING is the silence=pass
// pile (no budget to ask for) and is excluded. Compared as strings so a future
// SCHOOL_NIL category qualifies without a type change.
// MEDIA (an interview / press ask) and SCHOOL_NIL are requests of her, answered — never asked for a
// budget (owner, 7 Oct). EDITORIAL stays: a brand offering paid editorial can be asked.
const PAID_TYPE_CATEGORIES: ReadonlySet<string> = new Set(["PAID", "EDITORIAL"]);

export function isPaidTypeCategory(category: string): boolean {
  return PAID_TYPE_CATEGORIES.has(category);
}

// Commission-only / referral / MLM inbounds — there's no fixed budget to ask for, so
// they're not qualified. We don't get offer_struct.kind on the client, so infer from
// the summary / offer text. Conservative by design: over-excluding just means fewer
// asks (the money-safe direction), never a wrongful send.
const COMMISSION_RE =
  /\b(commission|affiliate|referral|downline|multi-?level|mlm)\b|%\s*(of\s*sales|commission|per\s*sale)|per\s+(referral|sale|signup|sign-?up)|earn\s+\$?\d|\$\s?\d+\s*(?:\/|per)\s*(referral|sale|signup|sign-?up)/i;

export function looksCommissionOrReferral(
  deal: Pick<DealItem, "aiSummary" | "offerDisplay" | "convAsk">,
): boolean {
  const text = [deal.aiSummary, deal.offerDisplay, deal.convAsk].filter(Boolean).join(" · ");
  return COMMISSION_RE.test(text);
}

/** Mila already recommends passing on this deal (reject/delete) — never batch-ask it. */
export function isDeclineRecommended(deal: Pick<DealItem, "recommendation">): boolean {
  return deal.recommendation === "reject" || deal.recommendation === "delete";
}

/**
 * The QUALIFIED candidate predicate — who actually enters the batch:
 *   raw unpriced inbound (above)  AND
 *   a real paid-type category (PAID / MEDIA / EDITORIAL / SCHOOL_NIL; not GIFTING)  AND
 *   not commission-only / referral / MLM  AND
 *   not already recommended to pass (reject/delete).
 */
export function isUnpricedCandidate(deal: DealItem): boolean {
  if (!isUnpricedInbound(deal)) return false;
  if (!isPaidTypeCategory(deal.category)) return false;
  if (looksCommissionOrReferral(deal)) return false;
  if (isDeclineRecommended(deal)) return false;
  return true;
}

/** Raw unpriced inbounds that were EXCLUDED by value qualification (gifting-only,
 *  commission/referral, or recommended-pass) — surfaced as the "low-value skipped" count. */
export function countExcludedLowValue(deals: DealItem[], now: number = Date.now()): number {
  void now;
  return deals.filter((d) => isUnpricedInbound(d) && !isUnpricedCandidate(d)).length;
}

// ─── Age × sender-type segmentation ────────────────────────────────────────────

export type AskSegmentId = "fresh" | "agency" | "quiet" | "old";

const DAY_MS = 86_400_000;
const FRESH_MAX_DAYS = 30;   // Fresh: < 30d
const QUIET_MAX_DAYS = 90;   // Gone quiet: 30–90d; Old: 90d+

/** Days since the last real activity on the deal (last message, else detected). */
export function dealAgeDays(deal: Pick<DealItem, "lastMessageAt" | "detectedAt">, now: number): number {
  const iso = deal.lastMessageAt ?? deal.detectedAt ?? null;
  const ms = iso ? Date.parse(iso) : NaN;
  if (!isFinite(ms)) return 0; // unknown age → treat as fresh (never punish a missing date into "old/off")
  return Math.max(0, Math.floor((now - ms) / DAY_MS));
}

/**
 * Bucket a candidate by thread age × sender-type. Sender-type WINS: an agency-mediated
 * thread is the "agency" variant regardless of age (its copy speaks to the client's
 * side, and agency threads shouldn't be silently aged into the off-by-default pile).
 * A direct thread buckets by age: Fresh <30d · quiet 30–90d · old 90+d.
 */
export function segmentOf(deal: DealItem, now: number): AskSegmentId {
  if (deal.viaAgency) return "agency";
  const age = dealAgeDays(deal, now);
  if (age < FRESH_MAX_DAYS) return "fresh";
  if (age < QUIET_MAX_DAYS) return "quiet";
  return "old";
}

/**
 * Whether a row starts CHECKED. The review is subtractive — everything is pre-checked
 * so the athlete only has to UNCHECK exclusions — EXCEPT the Old (90+d) segment, which
 * starts OFF. Reviving a months-cold thread is the one ask that needs a deliberate opt-in.
 */
export function defaultChecked(segment: AskSegmentId): boolean {
  return segment !== "old";
}

// ─── Segment presentation (labels + honest previews) ───────────────────────────

export interface SegmentMeta {
  id:          AskSegmentId;
  label:       string;
  /** One line describing the group + why it's grouped this way. */
  blurb:       string;
  /** A representative first line of the ask — a PREVIEW, never a rate. Mirrors the
   *  server template's opening so the athlete sees the shape of what will send. */
  preview:     string;
}

// Order the segments render in: freshest/highest-intent first, off-by-default last.
export const SEGMENT_ORDER: AskSegmentId[] = ["fresh", "agency", "quiet", "old"];

export const SEGMENT_META: Record<AskSegmentId, SegmentMeta> = {
  fresh: {
    id: "fresh",
    label: "Fresh — reached out recently",
    blurb: "New inbounds that never named a price. Highest intent — ask while it's warm.",
    preview:
      "Thanks so much for reaching out — I'd love to explore this. Could you share the budget you're working with, the deliverables and scope, any usage rights, and your timeline?",
  },
  agency: {
    id: "agency",
    label: "Through an agency",
    blurb: "Agency-mediated threads. The ask speaks to their client's side.",
    preview:
      "Thanks for thinking of me for this — happy to take a look. Could you send over your client's budget, the deliverables and scope, usage rights, exclusivity, and the timeline?",
  },
  quiet: {
    id: "quiet",
    label: "Gone quiet — 30 to 90 days",
    blurb: "Still open, just slow. A light nudge back to a real number.",
    preview:
      "Thanks for your patience — this one stayed on my list. If it's still open, could you share the budget, the deliverables and scope, usage rights, and the timeline?",
  },
  old: {
    id: "old",
    label: "Old — 90+ days",
    blurb: "Months cold. Off by default — check the ones genuinely worth reviving.",
    preview:
      "I know it's been a while — apologies for the slow follow-up. If there's still interest, could you share the budget, deliverables and scope, usage rights, and timeline you had in mind?",
  },
};

// ─── Rows + grouping (the view model) ──────────────────────────────────────────

export interface AskRow {
  deal:            DealItem;
  segment:         AskSegmentId;
  /** Whether this row starts checked (subtractive default; old = off). */
  defaultChecked:  boolean;
  ageDays:         number;
}

export interface AskSegmentGroup {
  meta: SegmentMeta;
  rows: AskRow[];
}

/** All unpriced candidates as rows, tagged with segment + default-checked state. */
export function selectCandidateRows(deals: DealItem[], now: number = Date.now()): AskRow[] {
  return deals
    .filter(isUnpricedCandidate)
    .map((deal) => {
      const segment = segmentOf(deal, now);
      return { deal, segment, defaultChecked: defaultChecked(segment), ageDays: dealAgeDays(deal, now) };
    });
}

/** Group candidate rows into ordered segments (empty segments omitted). Within a
 *  segment, freshest (smallest age) first. */
export function buildSegments(deals: DealItem[], now: number = Date.now()): AskSegmentGroup[] {
  const rows = selectCandidateRows(deals, now);
  return SEGMENT_ORDER.map((id) => ({
    meta: SEGMENT_META[id],
    rows: rows
      .filter((r) => r.segment === id)
      .sort((a, b) => a.ageDays - b.ageDays),
  })).filter((g) => g.rows.length > 0);
}

/** The set of dealIds that start checked (used to seed the screen's selection). */
export function defaultCheckedIds(deals: DealItem[], now: number = Date.now()): Set<string> {
  return new Set(
    selectCandidateRows(deals, now)
      .filter((r) => r.defaultChecked)
      .map((r) => r.deal.id),
  );
}

/** Split summary for the intro line: how many will be asked vs. set aside, given the
 *  current checked set over all candidates. */
export function summarizeSelection(
  deals: DealItem[],
  checkedIds: ReadonlySet<string>,
  now: number = Date.now(),
): { willAsk: number; setAside: number; total: number } {
  const rows = selectCandidateRows(deals, now);
  const willAsk = rows.filter((r) => checkedIds.has(r.deal.id)).length;
  return { willAsk, setAside: rows.length - willAsk, total: rows.length };
}

// ─── Per-message approval (owner decision, 6 Oct 2026) ────────────────────────
//
// Every message in the batch is approved ON ITS OWN, as the exact text it will send — but
// there is one send tap for all the approved ones, not one per message. The rules:
//   · a row can be approved only once it has been OPENED (its full body was on screen),
//     and never while it is being edited;
//   · an approval records the body the row showed at that moment;
//   · editing a row clears its approval (a new body needs a new look);
//   · only approved rows send, each with the body it was approved on.
// There is deliberately no "approve all": each approval is the review of that message.

/** May this row be approved right now? Only once opened, and not mid-edit. */
export function canApprove(id: string, opened: ReadonlySet<string>, editingId: string | null): boolean {
  return opened.has(id) && editingId !== id;
}

/** Approve row `id` on the body it displayed. Returns a new map (state-safe). */
export function withApproval(
  approved: ReadonlyMap<string, string>,
  id: string,
  displayedBody: string,
): Map<string, string> {
  const next = new Map(approved);
  next.set(id, displayedBody);
  return next;
}

/** Clear row `id`'s approval (an edit began or landed, or the row was set aside). */
export function withoutApproval(approved: ReadonlyMap<string, string>, id: string): Map<string, string> {
  if (!approved.has(id)) return approved as Map<string, string>;
  const next = new Map(approved);
  next.delete(id);
  return next;
}

/**
 * The rows that send: approved ones whose current body is still the body they were
 * approved on, in list order, each paired with that body. A row whose body has changed
 * since its approval is left out (belt and braces; editing already clears approval).
 */
export function approvedToSend<T extends { id: string; payload: Record<string, unknown> }>(
  proposals: readonly T[],
  approved: ReadonlyMap<string, string>,
): Array<{ pa: T; body: string }> {
  const out: Array<{ pa: T; body: string }> = [];
  for (const pa of proposals) {
    const body = approved.get(pa.id);
    if (body === undefined) continue;
    if (String(pa.payload?.body ?? "") !== body) continue;
    out.push({ pa, body });
  }
  return out;
}

/** The primary button: "Send {k} approved replies" (singular at one). */
export function sendApprovedLabel(k: number): string {
  return `Send ${k} approved ${k === 1 ? "reply" : "replies"}`;
}

// A short client delay between sends — we have NO scheduler, so the batch sends NOW,
// spaced by this delay so N threaded replies don't leave in one indistinguishable burst.
// This is a real, honest pacing (a few seconds apart), NOT a multi-day drip.
export const SEND_SPACING_MS = 1200;
