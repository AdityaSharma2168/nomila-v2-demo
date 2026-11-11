/**
 * opportunityOrder.ts — the ONE order of an athlete's open opportunities (Opportunities PR 3). OPPS_RANKING and
 * DEALS_BOARD_V2 were retired on 2 Nov 2026 (always on); the board orders by compareOpportunitiesV2 (decision D3).
 *
 * Deterministic, by design (owner decision, 6 Oct 2026, after two ranking trials): who is asking first,
 * then what they asked. No score, no model.
 *
 *   0. Category guards, before anything else: an unverifiable sender sorts last; a free-product-only offer
 *      sorts below every inquiry with plausible paid intent, whatever the brand's standing (owner, 7 Oct:
 *      a confirmed brand's no-obligation sample is less important than someone asking about paid work).
 *   1. Standing — CONFIRMED brand research only (enrichment.identity.status = confirmed, #778):
 *      established/premium → mid → emerging → no confirmed research; an unverifiable sender sorts last.
 *   2. State — the LEAD thread's qualification: cash terms → below floor → needs terms → product only.
 *   3. Channel — direct before via an agency.
 *   4. Newest activity, then id (a total, reproducible order).
 *
 * Known gap, kept on purpose: a confirmed brand's nominal, extreme-turnaround offer (the POPMART test case)
 * is not demoted by any rule. It stays a test case for later ranking work.
 *
 * Unconfirmed research is about the RESEARCH, never the opportunity: it only means "no standing yet",
 * never Verify first.
 */
import { readIdentity } from "./brandIdentity";

export type Standing = "established" | "mid" | "emerging" | "none" | "unverifiable";
/**
 * A commission-only offer (no cash, no product) is the "product" state: owner decision 23 Oct 2026 — it is handled
 * exactly like a gifting / product-only offer (same ranking, placement, chip and actions), with no label of its own.
 * Only the card's words say "commission" instead of "product" (cardLine `commissionOnly`).
 */
export type OppState = "cash" | "below_floor" | "needs_terms" | "product" | "unqualified";
export type OppChannel = "direct" | "agency" | "unverifiable";

/** D3: her money and her move. A product or commission-only offer sits below any ask that could pay her a fee. */
const STATE_RANK_V2: Record<OppState, number> = { cash: 0, below_floor: 1, needs_terms: 2, product: 3, unqualified: 4 };
/** D3: the confirmed tier is a tiebreak only, and no confirmed research ranks with "emerging" — never below it. */
const STANDING_TIEBREAK: Record<Standing, number> = { established: 0, mid: 1, emerging: 2, none: 2, unverifiable: 3 };

export interface OrderInput {
  id: string;
  standing: Standing;
  state: OppState;
  channel: OppChannel;
  lastActivityAt: string | Date | null;
  /** D3 (DEALS_BOARD_V2): the move is hers (lib/opportunityNext `hers`). */
  hers?: boolean;
  /** D3 (DEALS_BOARD_V2): the stated cash on the table (the latest offer), for "her money first" within a state. */
  cash?: number | null;
}

/** Confirmed research → its tier; anything else → none. An unverifiable sender → unverifiable. */
export function standingOf(
  brand: { brand_tier?: string | null; enrichment?: unknown } | null | undefined,
  channel: OppChannel,
): Standing {
  if (channel === "unverifiable") return "unverifiable";
  if (!brand || readIdentity(brand.enrichment)?.status !== "confirmed") return "none";
  const t = brand.brand_tier;
  if (t === "established" || t === "premium") return "established";
  if (t === "mid") return "mid";
  if (t === "emerging") return "emerging";
  return "none";
}

/**
 * The opportunity's state from its LEAD thread's qualification (never the "best" member: one x1
 * product-test thread once turned StartX1's paid partnership into a gift).
 */
export function stateOf(
  qualification: string | null | undefined,
  offer: { unit?: string | null; amount?: number | null } | null | undefined,
  qualificationReason?: string | null,
): OppState {
  if (qualification === "below_floor") return "below_floor";
  if (qualification === "needs_terms") return "needs_terms";
  if (qualification === "workable") {
    const productOnly = offer?.unit === "gifting_only"
      || (offer?.amount == null && /\(product\)/i.test(qualificationReason ?? ""));
    // A commission-only offer is handled exactly like a product-only one (owner, 23 Oct 2026; deals audit B issue 2:
    // affiliate blasts read as paid).
    if (productOnly || isCommissionOnly(offer, qualificationReason)) return "product";
    return "cash";
  }
  return "unqualified";
}

/** A commission-only offer: the summariser's unit says so, or code's stored workable reason does ("(commission)"). */
export function isCommissionOnly(
  offer: { unit?: string | null; amount?: number | null } | null | undefined,
  qualificationReason?: string | null,
): boolean {
  return offer?.unit === "commission_only" || (offer?.amount == null && /\(commission\)/i.test(qualificationReason ?? ""));
}

const ts = (v: string | Date | null): number => {
  if (v == null) return 0;
  const n = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isNaN(n) ? 0 : n;
};

/**
 * D3 (12 Oct 2026; DEALS_BOARD_V2 until it was retired on 2 Nov 2026): an unverifiable sender last → her move first → state (cash terms → under her minimum → no fee
 * yet → product or commission only) → more cash first → the confirmed tier as a tiebreak (no confirmed research ties with
 * "emerging") → newest. The channel is no longer a key: an agency deal is judged on what it offers.
 */
export function compareOpportunitiesV2(a: OrderInput, b: OrderInput): number {
  const last = (x: OrderInput) => (x.standing === "unverifiable" ? 1 : 0);
  const notHers = (x: OrderInput) => (x.hers ? 0 : 1);
  const money = (x: OrderInput) => (typeof x.cash === "number" && Number.isFinite(x.cash) ? x.cash : -1);
  return last(a) - last(b)
    || notHers(a) - notHers(b)
    || STATE_RANK_V2[a.state] - STATE_RANK_V2[b.state]
    || money(b) - money(a)
    || STANDING_TIEBREAK[a.standing] - STANDING_TIEBREAK[b.standing]
    || ts(b.lastActivityAt) - ts(a.lastActivityAt)
    || a.id.localeCompare(b.id);
}

export function orderOpportunities<T extends OrderInput>(items: T[]): T[] {
  return [...items].sort(compareOpportunitiesV2);
}

const fmtDate = (v: string | Date | null): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" });
};

/**
 * The card's one line, from stored fields only. Never a rate, never a score. A dollar figure appears
 * only when the brand stated it (below floor).
 */
/** The summarizer's ask as a short phrase: first letter up, trailing stop gone, cut at a word near `max`. */
export function askPhrase(ask: string | null | undefined, max = 80): string | null {
  const t = (ask ?? "").replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
  if (!t) return null;
  const up = `${t.charAt(0).toUpperCase()}${t.slice(1)}`;
  if (up.length <= max) return up;
  const cut = up.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 15)).replace(/[,;:\s]+$/, "")}…`;
}

/** The money the brand STATED, first on the line: "$625". Null when nothing was stated. */
const moneyOf = (cash: number | null | undefined): string | null =>
  typeof cash === "number" && Number.isFinite(cash) && cash > 0 ? `$${cash.toLocaleString("en-US")}` : null;

/**
 * In motion: where it stands, from the deal's effective status — never the stale first-email qualification. The money
 * the brand stated leads the line and the ask follows, so the card always says what's on the table.
 */
export function motionLine(p: {
  effectiveStatus: string | null; herMoveSince?: string | Date | null; signed?: boolean; cash?: number | null; ask?: string | null;
}): string {
  const stage = p.signed ? "Signed"
    : p.effectiveStatus === "accepted" ? "Agreed"
    : p.effectiveStatus === "completed" ? "Completed"
    : p.effectiveStatus === "negotiating" ? "Negotiating"
    : p.effectiveStatus === "pending" ? "In progress"
    : "You replied";
  return [moneyOf(p.cash), askPhrase(p.ask, 60), stage, p.herMoveSince ? `Waiting on you since ${fmtDate(p.herMoveSince)}` : "Their move"]
    .filter(Boolean).join(" · ");
}

export function cardLine(p: {
  /** "request" = an interview / press ask or a school request: never a terms conversation. */
  kind?: "deal" | "interview" | "school";
  state: OppState;
  channel: OppChannel;
  ask?: string | null;
  cash?: number | null;
  herMoveSince?: string | Date | null;
  confirmedCategory?: string | null;
  /** The agency's name is on the card already (its "via X" chip): the line then doesn't say it again. */
  agencyNamed?: boolean;
  /** A "product" card whose offer is commission only (isCommissionOnly): same line, its own words. */
  commissionOnly?: boolean;
}): string {
  const since = p.herMoveSince ? `Waiting on you since ${fmtDate(p.herMoveSince)}` : null;
  // The summarizer's `ask` is a short imperative ("Create 3 Instagram Reels…"), so it is quoted as
  // their ask, not spliced into a sentence.
  const ask = askPhrase(p.ask);
  const via = p.channel === "agency" && !p.agencyNamed ? "Via an agency · " : "";
  if (p.kind === "interview" || p.kind === "school") {
    const label = p.kind === "interview" ? "Interview request" : "From your school";
    return [`${via}${label}${ask ? ` · Their ask: ${ask}` : ""}`, since].filter(Boolean).join(" · ");
  }
  const money = moneyOf(p.cash);
  let what: string;
  switch (p.state) {
    // The money they stated leads, then what they asked for. No figure stated: say so, and still show the ask.
    case "cash":        what = [money ?? "Paid, no amount yet", ask].filter(Boolean).join(" · "); break;
    case "product":     what = [p.commissionOnly ? "Commission only, no set fee" : "Product only, no cash", ask].filter(Boolean).join(" · "); break;
    case "below_floor": what = p.cash != null ? `$${p.cash.toLocaleString("en-US")} offered, under your floor for this work` : "Offer under your floor for this work"; break;
    case "needs_terms": what = `${via}${ask ? `Their ask: ${ask}` : "Interested in working together"} · no fee yet`; break;
    default:            what = ask ? `Their ask: ${ask}` : "Waiting for details";
  }
  const lead = p.confirmedCategory && p.state !== "needs_terms" ? `${p.confirmedCategory} · ` : "";
  return [lead + what, since].filter(Boolean).join(" · ");
}
