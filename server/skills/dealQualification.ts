/**
 * dealQualification.ts — Opportunities PR 1: qualify an inbound email before it becomes an opportunity.
 *
 * What the athlete gets: every email that reaches the deals pipeline carries one plain answer —
 * is a real brand behind it, and has it said what it wants and what it pays? Five states:
 *
 *   needs_terms   a real brand/agency ask with no compensation stated yet — including one that lists
 *                 deliverables or asks for HER rate (common, NOT low value; she inquires before naming a rate)
 *   below_floor   real brand, cash-only offer under her floor for that kind of work
 *   workable      terms stated: a cash figure at/above her floor (or no floor), a figure plus product, product, commission
 *   verify_first  an unverifiable sender claiming a recognisable brand
 *   not_relevant  not a commercial ask of her (newsletter, promo, fan mail, platform pitch)
 *
 * WHO DECIDES WHAT. The classify model (the SAME call that already decides is_deal/category — no new
 * model call) reads the email and proposes: the sender channel, whether a recognisable brand is
 * claimed, needs_terms / workable / verify_first / not_relevant, one sentence why, and the raw terms
 * (cash, comp kind, kind of work, units). CODE then enforces the rules that must be guarantees:
 *
 *   · below_floor vs workable is ARITHMETIC here — stated cash vs HER floor for that kind of work
 *     (deal_preferences.minimum_rates). The computed rate-card mid is retired (legacy retirement, 8 Oct 2026).
 *     Only a cash-only offer can be "below"; a mix or a non-cash offer never is by itself. No floor
 *     known ⇒ never "below". The model never judges whether money is enough.
 *   · verify_first ⇔ channel "unverifiable" AND a recognisable-brand claim. An agency channel is a
 *     normal opportunity ("via [agency]"), judged separately from the advertiser.
 *   · contract / e-signature / payment workflow mail (WORKFLOW_DOMAINS) is part of an existing deal
 *     and is never not_relevant or verify_first — it must keep linking to its deal.
 *   · missing money is never a penalty: no compensation stated ⇒ needs_terms, full stop — even when
 *     deliverables are listed or her quote is asked for. She opens a conversation, never rates first.
 *   · paid with no amount named (cash, or cash plus product, but no figure) ⇒ needs_terms, never workable: there is
 *     nothing to accept yet. Only product or commission alone are complete terms without a figure.
 *
 * Re-qualification: the classify runs on every new inbound message, so the stored qualification is
 * re-evaluated as the conversation moves. `mergeQualification` keeps it honest across follow-ups:
 * terms, once stated, are not erased by a later "sounds good", and a follow-up on a live thread is
 * never re-judged as junk or verify-first.
 *
 * Stored on inbox_threads.classification (jsonb) — no migration.
 */

import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { athletes } from "../../shared/schema";
import { WORKFLOW_DOMAINS, domainOf } from "../lib/senderProfile";
import { isSettlementOnly } from "../lib/emailFilters";
import { DEAL_TYPE_LABEL, DELIVERABLE_LABEL, RATE_TYPES, BOOKING_RATE_TYPES, deliverableOfText, floorKeyOf, type DealType, type RateType } from "../../shared/deals";
import { minimumFor } from "../services/ratesFloor";

export const QUALIFICATION_VERSION = "opps-qual/1";

export const QUALIFICATIONS = ["needs_terms", "below_floor", "workable", "verify_first", "not_relevant"] as const;
export type Qualification = typeof QUALIFICATIONS[number];

export const CHANNELS = ["direct", "agency", "unverifiable"] as const;
export type Channel = typeof CHANNELS[number];

const WORK_KINDS = ["social_post", "appearance", "ambassador", "autograph", "licensing", "other"] as const;
export type WorkKind = typeof WORK_KINDS[number];

const COMP_KINDS = ["cash", "cash_and_product", "product", "commission", "none"] as const;
export type CompKind = typeof COMP_KINDS[number];

/** What the classify model proposed — parsed and enum-validated, never trusted beyond that. */
export interface ModelQualification {
  channel:            Channel | null;
  qualification:      Qualification | null;
  reason:             string | null;
  claims_known_brand: boolean;
  work_kind:          WorkKind | null;
  work_units:         number | null;
  cash_amount:        number | null;
  comp_kind:          CompKind | null;
}

/** The floor check, kept beside the verdict so "why below" is auditable. */
export interface FloorCheck {
  kind:   WorkKind;
  cash:   number;
  units:  number;
  floor:  number;
  /** "rate_card_mid" is only ever READ: rows stored before the legacy retirement (see withoutRetiredFloor). */
  source: "minimum_rate" | "rate_card_mid";
}

/** The fields written onto inbox_threads.classification. */
export interface StoredQualification {
  channel:                  Channel;
  qualification:            Qualification;
  qualification_reason:     string;
  qualification_version:    string;
  qualification_message_id: string | null;
  qualification_floor:      FloorCheck | null;
}

/** Her per-type floors, keyed like deal_preferences.minimum_rates. */
export interface QualificationFloors {
  minimumRates: Record<string, unknown>;
}

const enumOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;

const posNum = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
};

/**
 * Parse the qualification half of the classify JSON. Returns null when the model produced none of
 * it (an older prompt, a truncated response) so callers can tell "not qualified" from a verdict.
 * The model may say "below_floor" despite being told not to — that is a terms-stated signal and is
 * read as "workable"; code alone decides below vs workable.
 */
export function parseModelQualification(parsed: any): ModelQualification | null {
  if (!parsed || typeof parsed !== "object") return null;
  let qualification = enumOf(parsed.qualification, QUALIFICATIONS);
  if (qualification === "below_floor") qualification = "workable";
  const channel = enumOf(parsed.channel, CHANNELS);
  if (!qualification && !channel) return null;
  const units = posNum(parsed.work_units);
  return {
    channel,
    qualification,
    reason:             typeof parsed.qualification_reason === "string" && parsed.qualification_reason.trim()
      ? parsed.qualification_reason.trim().slice(0, 280)
      : null,
    claims_known_brand: parsed.claims_known_brand === true,
    work_kind:          enumOf(parsed.work_kind, WORK_KINDS),
    work_units:         units != null ? Math.max(1, Math.round(units)) : null,
    cash_amount:        posNum(parsed.cash_amount),
    comp_kind:          enumOf(parsed.comp_kind, COMP_KINDS),
  };
}

/** The classifier's free-text deliverables as the term-sheet shape floorKeyOf reads (those it can name). */
export function deliverableKinds(texts: ReadonlyArray<string> | null | undefined): Array<{ kind: string }> {
  return (texts ?? []).map(deliverableOfText).filter((d): d is NonNullable<typeof d> => d != null).map((kind) => ({ kind }));
}

/**
 * Her floor for one kind of work — her own minimum, or null (no floor set). Never a computed rate. The key is the
 * classifier's work kind refined by the deliverables it named (a Reel, a TikTok, a virtual appearance); with work kind
 * "other" the deliverables alone decide it.
 */
export function floorFor(
  kind: WorkKind | null,
  floors: QualificationFloors | null,
  deliverables?: ReadonlyArray<string> | null,
): { floor: number; source: "minimum_rate" } | null {
  if (!kind || !floors) return null;
  // THE floor key (shared/deals floorKeyOf) read through services/ratesFloor minimumFor — the one reader Your rates,
  // the draft and the deal read share (rate-type key first, the legacy minimum_rates key as the fallback) — so the
  // check, the draft and the screen can't disagree.
  const key = floorKeyOf({ workKind: kind === "other" ? null : kind, deliverables: deliverableKinds(deliverables) });
  const own = minimumFor(floors.minimumRates, key);
  return own != null ? { floor: own.value, source: "minimum_rate" } : null;
}

/** What "Why it's here" knows about her minimum for this deal's work (minimumContextFor). */
export interface MinimumContext {
  /** The one floor key for the deal's work, or null when nothing about it maps to a rate type. */
  rateType: RateType | null;
  /** Her minimum for that key, or null. */
  minimum: number | null;
  /** Whether she has set a minimum for any kind of work. */
  anySet: boolean;
  /** The work in words, for "couldn't match …" (the first deliverable named, else the deal type). */
  work: string | null;
}

/**
 * Her minimum for THIS deal's work, from everything known about it: the deal type, the classifier's work kind, the
 * term sheet's deliverables and the classifier's deliverable words, through the one floor key (shared/deals floorKeyOf).
 * Pure.
 */
export function minimumContextFor(input: {
  minimumRates: Record<string, unknown> | null | undefined;
  dealType?: DealType | null;
  workKind?: string | null;
  termDeliverables?: ReadonlyArray<{ kind: string }> | null;
  deliverableTexts?: ReadonlyArray<string> | null;
}): MinimumContext {
  const deliverables = [...(input.termDeliverables ?? []), ...deliverableKinds(input.deliverableTexts)];
  const workKind = input.workKind && input.workKind !== "other" ? input.workKind : null;
  const rateType = floorKeyOf({ dealType: input.dealType ?? null, workKind, deliverables });
  const anySet = RATE_TYPES.some((t) => !BOOKING_RATE_TYPES.includes(t) && minimumFor(input.minimumRates, t) != null);
  const firstText = (input.deliverableTexts ?? []).find((t) => typeof t === "string" && t.trim())?.trim() ?? null;
  const firstKind = (input.termDeliverables ?? []).find((d) => d.kind in DELIVERABLE_LABEL)?.kind as keyof typeof DELIVERABLE_LABEL | undefined;
  const work = firstKind ? DELIVERABLE_LABEL[firstKind] : firstText ? firstText.slice(0, 60) : input.dealType ? DEAL_TYPE_LABEL[input.dealType] : null;
  return { rateType, minimum: minimumFor(input.minimumRates, rateType)?.value ?? null, anySet, work };
}

/** The sentence after "They named a fee of $X." when no floor check was stored. Never implies none exist when some do. */
function minimumWords(m: MinimumContext | null | undefined): string {
  if (!m) return "You haven’t set a minimum for this kind of work yet.";
  const label = m.rateType ? RATE_WORDS[m.rateType] : null;
  if (label && m.minimum != null) return `Your minimum for ${label} is ${usd(m.minimum)}.`;
  if (label) return `You haven’t set a minimum for ${label} yet.`;
  if (!m.anySet) return "You haven’t set any minimums yet.";
  return m.work
    ? `You have minimums set, but Nomila couldn’t match “${m.work}” to one of them.`
    : "You have minimums set, but Nomila couldn’t tell which one this work falls under.";
}
/** Each rate type in a sentence ("your minimum for an Instagram Reel"). */
const RATE_WORDS: Record<RateType, string> = {
  ig_post: "an Instagram feed post", ig_reel: "an Instagram Reel", ig_story: "an Instagram story", tiktok_video: "a TikTok video",
  yt_short: "a YouTube Short", yt_video: "a YouTube video", ugc: "UGC (not posted)",
  appearance_in_person_hour: "an in-person appearance", appearance_virtual: "a virtual appearance", camp_clinic: "a camp or clinic",
  autograph_session: "an autograph session", speaking: "speaking or a panel", ambassador_month: "ambassador work", licensing: "licensing",
  booking_video_call_30: "a video call", booking_clinic: "a clinic", booking_appearance: "an appearance",
};

const KIND_LABEL: Record<WorkKind, [string, string]> = {
  social_post: ["social post", "social posts"],
  appearance:  ["appearance", "appearances"],
  ambassador:  ["month of ambassador work", "months of ambassador work"],
  autograph:   ["autograph deal", "autograph deals"],
  licensing:   ["licensing deal", "licensing deals"],
  other:       ["piece of work", "pieces of work"],
};

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/**
 * The code-enforced verdict. Pure. `model` null ⇒ null (nothing to enforce — e.g. the SCHOOL_NIL
 * fast path, which never calls the model).
 */
/** An interview / press ask (MEDIA) or a school request (SCHOOL_NIL): a request of her, not a sale. */
export function isRequestCategory(category: string | null | undefined): boolean {
  return category === "MEDIA" || category === "SCHOOL_NIL";
}

export function enforceQualification(input: {
  model:          ModelQualification | null;
  from:           string | null;
  deliverables?:  string[] | null;
  floors:         QualificationFloors | null;
  messageId?:     string | null;
  /** The classifier's category. MEDIA (an interview / press ask) and SCHOOL_NIL are requests of HER. */
  category?:      string | null;
}): StoredQualification | null {
  const m = input.model;
  if (!m) return null;

  const senderDomain = domainOf(input.from);
  const workflowSender = !!senderDomain && WORKFLOW_DOMAINS.has(senderDomain);
  // E-sign / payment mail carries the brand's own paperwork — never labelled "unverifiable".
  const channel: Channel = workflowSender && m.channel === "unverifiable" ? "direct" : m.channel ?? "direct";
  const base = {
    channel,
    qualification_version:    QUALIFICATION_VERSION,
    qualification_message_id: input.messageId ?? null,
  };

  // 1. Unverifiable intermediary claiming a recognisable brand — never filed, never "normal".
  if (!workflowSender && channel === "unverifiable" && m.claims_known_brand) {
    return {
      ...base,
      qualification:        "verify_first",
      qualification_reason: m.qualification === "verify_first" && m.reason
        ? m.reason
        : "The sender can't be verified as working for the brand it names — worth confirming before anything else.",
      qualification_floor:  null,
    };
  }

  // 2. Not a commercial ask of her. A deal's own contract/payment mail is never this, and neither is a
  //    personal interview / press request or a school request: those are asks of her even with no money
  //    in them, so they are never filed as junk (owner, 7 Oct).
  if (!workflowSender && m.qualification === "not_relevant" && !isRequestCategory(input.category)) {
    return {
      ...base,
      qualification:        "not_relevant",
      qualification_reason: m.reason ?? "Not a commercial ask of you.",
      qualification_floor:  null,
    };
  }

  // 2b. Money paid or owed, not an offer: every deliverable is invoice / settlement language ("Goods and services
  //     supplied as invoiced"). An amount on a payment advice is a payment, never terms to meet a floor.
  const asked = (input.deliverables ?? []).filter((d) => typeof d === "string" && d.trim());
  if (!workflowSender && asked.length > 0 && asked.every((d) => isSettlementOnly(d))) {
    return {
      ...base,
      qualification:        "not_relevant",
      qualification_reason: "A payment or invoice notice, not an offer.",
      qualification_floor:  null,
    };
  }

  // 3. Terms-based. Terms = stated COMPENSATION. Deliverables alone, or "what's your rate?", are
  //    still needs_terms (product decision 5 Oct): she inquires and talks first, never quotes first.
  const cash = m.cash_amount;
  const comp: CompKind | null = m.comp_kind ?? (cash != null ? "cash" : null);
  const deliverables = (input.deliverables ?? []).filter((d) => typeof d === "string" && d.trim());
  // Paid work with no amount named (cash, or cash plus product, but no figure) is NOT terms: there is nothing to accept
  // yet, so it is needs_terms and she asks for their budget and the specifics (owner, 23 Oct 2026 — no new category).
  // Only product or commission ALONE are complete terms without a figure.
  const paidNoAmount = cash == null && (comp === "cash" || comp === "cash_and_product");
  const nonCashTerms = comp === "product" || comp === "commission";
  const hasTerms = cash != null || nonCashTerms;

  if (!hasTerms) {
    return {
      ...base,
      qualification:        "needs_terms",
      qualification_reason: m.qualification === "needs_terms" && m.reason
        ? m.reason
        : paidNoAmount
          ? UNSTATED_FEE_REASON
          : deliverables.length > 0
          ? "They've said what they'd like but not what they'd pay — worth a conversation before naming a rate."
          : "A real ask, but no fee or deliverables have been named yet.",
      qualification_floor:  null,
    };
  }

  // Floor arithmetic — cash-only offers only. Mixed or non-cash comp is never "below" by itself.
  if (cash != null && comp === "cash") {
    const kind = m.work_kind ?? "other";
    const units = m.work_units ?? 1;
    const f = floorFor(kind, input.floors, deliverables);
    const [one, many] = KIND_LABEL[kind];
    if (f) {
      const check: FloorCheck = { kind, cash, units, floor: f.floor, source: f.source };
      const needed = f.floor * units;
      const unitText = `${units} ${units === 1 ? one : many}`;
      if (cash < needed) {
        return {
          ...base,
          qualification:        "below_floor",
          qualification_reason: `The cash offered (${usd(cash)} for ${unitText}) is under your floor for this kind of work (${usd(f.floor)} each).`,
          qualification_floor:  check,
        };
      }
      return {
        ...base,
        qualification:        "workable",
        qualification_reason: `The cash offered (${usd(cash)} for ${unitText}) meets your floor for this kind of work (${usd(f.floor)} each).`,
        qualification_floor:  check,
      };
    }
    return {
      ...base,
      qualification:        "workable",
      qualification_reason: `Terms are stated (${usd(cash)} cash); there's no floor set for this kind of work yet.`,
      qualification_floor:  null,
    };
  }

  // Reached only with cash stated (cash plus product) or a product / commission offer.
  const what =
    comp === "cash_and_product" ? "cash plus product"
    : comp === "product"        ? "product"
    : "commission";
  return {
    ...base,
    qualification:        "workable",
    qualification_reason: `Terms are stated (${what}); it isn't a cash-only offer, so it isn't measured against your floor.`,
    qualification_floor:  null,
  };
}

const TERMED = new Set<Qualification>(["below_floor", "workable"]);
const JUDGED_ON_FIRST_TOUCH = new Set<Qualification>(["verify_first", "not_relevant"]);

/**
 * Fold a newly computed qualification into the thread's stored one.
 *
 *   · the latest stated terms win (below_floor ↔ workable as the offer moves);
 *   · needs_terms does not erase terms already stated earlier in the thread;
 *   · on a FOLLOW-UP, verify_first / not_relevant are not taken from one reply — a "thanks!" on a
 *     live deal is not junk. Those are first-touch judgements of who is writing and why.
 */
export function mergeQualification(
  stored: StoredQualification | null,
  next: StoredQualification | null,
  opts: { followUp: boolean },
): StoredQualification | null {
  if (!next) return stored;
  if (opts.followUp && JUDGED_ON_FIRST_TOUCH.has(next.qualification)) return stored;
  if (!stored) return next;
  if (TERMED.has(next.qualification)) return next;
  if (next.qualification === "needs_terms" && TERMED.has(stored.qualification)) return stored;
  if (JUDGED_ON_FIRST_TOUCH.has(next.qualification)) return stored;
  return next;
}

/** The stored qualification off a classification jsonb, or null for an unqualified (legacy) thread. */
export function readStoredQualification(classification: unknown): StoredQualification | null {
  const c = classification as Record<string, any> | null;
  const q = enumOf(c?.qualification, QUALIFICATIONS);
  if (!c || !q) return null;
  return {
    channel:                  enumOf(c.channel, CHANNELS) ?? "direct",
    qualification:            q,
    qualification_reason:     typeof c.qualification_reason === "string" ? c.qualification_reason : "",
    qualification_version:    typeof c.qualification_version === "string" ? c.qualification_version : QUALIFICATION_VERSION,
    qualification_message_id: typeof c.qualification_message_id === "string" ? c.qualification_message_id : null,
    qualification_floor:      c.qualification_floor && typeof c.qualification_floor === "object" ? c.qualification_floor : null,
  };
}

/**
 * Legacy retirement, phase 1 (owner decision 8 Oct 2026): a stored "below_floor" whose floor was the computed rate-card
 * mid (`source: "rate_card_mid"`) was never HER floor — the reason text still says "under your floor ($876 each)". For
 * what she SEES (the board's state and the detail's reason), it reads as the verdict a fresh qualification now gives:
 * workable, no floor set for that kind of work. The stored row is untouched until the requalify pass (phase 2).
 */
export function withoutRetiredFloor(q: StoredQualification | null): StoredQualification | null {
  if (!q || q.qualification_floor?.source !== "rate_card_mid") return q;
  return {
    ...q,
    qualification:        "workable",
    qualification_reason: `Terms are stated (${usd(q.qualification_floor.cash)} cash); there's no floor set for this kind of work yet.`,
    qualification_floor:  null,
  };
}

/** Why a paid ask with no amount is needs_terms — one plain sentence she reads under "Why it's here". */
export const UNSTATED_FEE_REASON = "They want paid work but haven’t named a fee yet — ask for their budget and the details before any number.";

/**
 * A stored "workable" that names no amount (rows qualified before the paid-no-amount rule, 23 Oct 2026: a "cash plus
 * product" offer with no figure was stored as workable and the board said "Accept or counter" with nothing to accept)
 * reads as needs_terms for every surface that acts on it: the board's chip and action, the reply's deal type, the
 * ask-for-terms batch. Product-only and commission-only offers keep "workable" — those are complete terms without a fee.
 * Code's workable reasons are fixed sentences, so the shape is read from the stored reason ("(cash plus product)").
 * `statedCash` is any cash figure known elsewhere (the deal's amount, the summariser's offer, the classifier's
 * offer_amount); a positive one keeps the verdict. The stored row is untouched. Pure.
 */
export function withoutUnstatedFee(
  q: StoredQualification | null,
  ctx: { statedCash?: unknown; offerUnit?: string | null } = {},
): StoredQualification | null {
  if (!q || q.qualification !== "workable" || q.qualification_floor) return q;
  const n = typeof ctx.statedCash === "string" ? Number(ctx.statedCash) : ctx.statedCash;
  if (typeof n === "number" && Number.isFinite(n) && n > 0) return q;
  const unit = ctx.offerUnit ?? null;
  if (unit === "gifting_only" || unit === "product_only" || unit === "commission_only") return q;
  // Only the one shape code stored for paid-without-a-figure: "Terms are stated (cash plus product)…" (it never carried
  // the figure, so a known cash amount above is what keeps a real "$500 plus product" workable). A cash offer stores its
  // figure ("($500 cash)"), and "(product)" / "(commission)" are complete non-cash terms — none of those change.
  if (!/\(cash plus product\)/i.test(q.qualification_reason ?? "")) return q;
  return { ...q, qualification: "needs_terms", qualification_reason: UNSTATED_FEE_REASON };
}

/**
 * The effective qualification string off a classification jsonb (withoutRetiredFloor, then withoutUnstatedFee), for
 * readers that hold the raw thread rather than a StoredQualification. Null for an unqualified (legacy) thread.
 */
export function effectiveQualification(
  classification: unknown,
  ctx: { statedCash?: unknown; offerUnit?: string | null } = {},
): Qualification | null {
  const c = classification as Record<string, any> | null;
  const statedCash = posNum(ctx.statedCash) ?? posNum(c?.offer_amount);
  return withoutUnstatedFee(withoutRetiredFloor(readStoredQualification(classification)), { statedCash, offerUnit: ctx.offerUnit })?.qualification ?? null;
}

/**
 * The qualification as SHE reads it under "Why it's here" (owner, 8 Oct 2026: no rule text on screen). The stored
 * `qualification_reason` is an audit record — for a termed verdict it is CODE's sentence about floors and cash-only
 * measurement ("it isn't a cash-only offer, so it isn't measured against your floor"), which is how the rule works, not
 * what she needs to know. So the termed verdicts are worded here from the STRUCTURED fields (the floor check, the cash
 * the card already reads, the summariser's offer unit), for every stored row old or new; the untermed verdicts keep the
 * model's own one plain sentence (or the plain default code wrote). Pure.
 */
export function plainQualificationReason(
  q: StoredQualification | null,
  ctx: {
    state?: string | null; cash?: number | null; offer?: { unit?: string | null; amount?: number | null; product_value?: number | null } | null;
    /** Her minimum for this deal's work (minimumContextFor). Absent: the older generic sentence. */
    minimum?: MinimumContext | null;
  } = {},
): string | null {
  if (!q) return null;
  if (q.qualification === "below_floor" || q.qualification === "workable") {
    const f = q.qualification_floor;
    if (f && Number.isFinite(f.cash) && Number.isFinite(f.floor)) {
      const [one, many] = KIND_LABEL[f.kind] ?? KIND_LABEL.other;
      const what = `${usd(f.cash)} for ${f.units} ${f.units === 1 ? one : many}`;
      return q.qualification === "below_floor"
        ? `They offered ${what}. That’s under your minimum of ${usd(f.floor)} each.`
        : `They offered ${what}. That meets your minimum of ${usd(f.floor)} each.`;
    }
    const unit = ctx.offer?.unit ?? null;
    const cash = ctx.cash ?? ctx.offer?.amount ?? null;
    const product = ctx.offer?.product_value ?? null;
    // Commission only shares the "product" state (owner, 23 Oct 2026), so it is worded before the product check.
    if (unit === "commission_only" || (cash == null && /\(commission\)/i.test(q.qualification_reason ?? ""))) {
      return "They’re offering a commission on sales, not a set fee.";
    }
    if (unit === "gifting_only" || ctx.state === "product" || (cash == null && product != null)) {
      return product != null ? `They’re offering product worth about ${usd(product)}, not a fee.` : "They’re offering product, not a fee.";
    }
    if (cash != null) {
      return product != null
        ? `They named a fee of ${usd(cash)} plus product. ${minimumWords(ctx.minimum)}`
        : `They named a fee of ${usd(cash)}. ${minimumWords(ctx.minimum)}`;
    }
    return "They’ve named their terms. Open the conversation to see what they’re offering.";
  }
  const text = q.qualification_reason?.trim();
  return text ? text : null;
}

/** What the OPPS_QUALIFIED_INTAKE flag does with a new thread's qualification. */
export type IntakeAction = "mint" | "mint_marked" | "file";

export function intakeActionFor(q: StoredQualification | null): IntakeAction {
  if (!q) return "mint";                           // unqualified (fast path / legacy) — as today
  if (q.qualification === "not_relevant") return "file";
  if (q.qualification === "verify_first") return "mint_marked";
  return "mint";
}

// ─── Internal test senders (config only) ─────────────────────────────────────────────────────
// Developers send test mail into real inboxes. INTERNAL_TEST_SENDERS is a comma-separated list of
// the team's own addresses and/or domains (e.g. "dev@example.com, example.org"). Nothing is
// hard-coded: an empty or unset list means no sender is ever treated as internal.

/** The configured internal senders, lower-cased: full addresses and bare domains. */
export function internalTestSenders(env: string | undefined = process.env.INTERNAL_TEST_SENDERS): { addresses: Set<string>; domains: Set<string> } {
  const addresses = new Set<string>();
  const domains = new Set<string>();
  for (const raw of (env ?? "").split(",")) {
    const v = raw.trim().toLowerCase().replace(/^@/, "");
    if (!v) continue;
    if (v.includes("@")) addresses.add(v);
    else domains.add(v);
  }
  return { addresses, domains };
}

/** Is this From one of the configured internal senders (exact address, or the domain / a subdomain of it)? */
export function isInternalSender(from: string | null | undefined, env?: string): boolean {
  const { addresses, domains } = internalTestSenders(env);
  if (addresses.size === 0 && domains.size === 0) return false;
  const m = String(from ?? "").match(/<([^>]+@[^>]+)>/) ?? String(from ?? "").match(/([^\s<>]+@[^\s<>]+)/);
  const address = m ? m[1].toLowerCase().trim() : null;
  if (!address) return false;
  if (addresses.has(address)) return true;
  const domain = domainOf(address);
  if (!domain) return false;
  for (const d of domains) if (domain === d || domain.endsWith(`.${d}`)) return true;
  return false;
}

/**
 * A possible developer test message: an internal sender, with the reason noting an obvious
 * "test" marker in the subject or body when there is one. Null when the sender is not internal.
 */
export function possibleTestMessage(
  m: { from: string | null | undefined; subject?: string | null; body?: string | null },
  env?: string,
): string | null {
  if (!isInternalSender(m.from, env)) return null;
  const marker = /\btest(s|ing|ed)?\b/i.test(`${m.subject ?? ""}\n${m.body ?? ""}`);
  return marker ? "internal sender + \"test\" in subject/body" : "internal sender";
}

/**
 * Flag ON only: a NEW thread from a configured internal sender is filed as not_relevant instead
 * of becoming an opportunity. Config-driven — with INTERNAL_TEST_SENDERS empty this never fires.
 */
export function internalSenderQualification(from: string | null | undefined, messageId: string | null): StoredQualification | null {
  if (!isInternalSender(from)) return null;
  return {
    channel:                  "direct",
    qualification:            "not_relevant",
    qualification_reason:     "Sent from an internal test address — not a brand approach.",
    qualification_version:    QUALIFICATION_VERSION,
    qualification_message_id: messageId,
    qualification_floor:      null,
  };
}

/** Her floors. Accepts any drizzle instance (the dry-run passes a read-only one). */
export async function loadQualificationFloors(
  athleteId: string,
  dbx: any = defaultDb,
): Promise<QualificationFloors> {
  const [athlete] = await dbx
    .select({ deal_preferences: athletes.deal_preferences })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  // Only HER stated minimum counts (legacy retirement, 8 Oct 2026); with none set, a cash offer is "workable — no
  // floor set yet" rather than measured against a Nomila-computed number presented to her as "your floor".
  return {
    minimumRates: ((athlete?.deal_preferences as any)?.minimum_rates ?? {}) as Record<string, unknown>,
  };
}
