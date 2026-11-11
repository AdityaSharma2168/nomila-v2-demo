/**
 * opportunityRead.ts — the deal's four-line read (deals design §5 "The read: four lines instead of a score"; build
 * contract, Builder 2). Replaces "Why it's here" and "Nomila's take" on the detail, rides on every board card, and is
 * what Mila speaks. Every line says where it came from.
 *
 *   Money  CODE. The latest offer (the summariser's offer_struct — ONE extractor) against HER minimum for that kind of
 *          work (services/rates minimumFor — the one floor key) and Mila's stored suggested range (athlete_rate_ranges).
 *          States: above_min · below_min · no_min · no_fee · commission_only · product_only · unpaid. Her minimum is
 *          NEVER written as a number in the line ("above your minimum"), because Mila speaks this line.
 *   Risk   CODE, an enum (RISK_FLAGS). Her exclusivity conflicts (Understand's internal read) through the plan's own
 *          check (agent/plan/validate blockedBy); confirmed research's competitors against her current partners and its
 *          brand_safety note; the sender (verify_first / unverifiable); and the scam signals the classify call stores
 *          on the thread (classification.risk_flags — Builder 1's classifier).
 *   Fit    MODEL (skill deal-read, OpenAI fast tier), confirmed research (an `external` input: fenced at the transport)
 *          + her facts. Null when the brand is unconfirmed.
 *   Goal   MODEL picks which of HER goals (agent memory_goals — never the legacy objectives) the deal serves; CODE writes
 *          the line from her own goal text. Null when she has no goals.
 *
 * Fit and Goal are stored once per athlete + deal (deal_reads, 0133) with a digest of what the call read (the brand's
 * research and identity verdict, her goals, the deal's ask). A changed digest = stale: not served, refilled. Reads
 * never wait on a model unless the caller asks (the detail waits briefly; the board never does).
 *
 * The read on items and the detail is always on (DEALS_READ, retired 2 Nov 2026). Flag (off by default):
 * DEALS_READ_MODEL (the fit / goal call — background model spend, kept as its switch).
 * Nothing here names an athlete, sport, school or brand. Imports from the legacy intelligence layer: none.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { dealReads } from "../../shared/schema";
import { DELIVERABLE_RATE_TYPE, RISK_FLAGS, floorKeyOf, isDeliverable, type DealRead, type DealType, type RateType, type RiskFlag, type TermSheet } from "../../shared/deals";
import type { Goal, MemoryFact } from "../../shared/agent";
import type { OfferStruct } from "../skills/dealScoreGrid";
import { readIdentity } from "../lib/brandIdentity";
import { blockedBy } from "../agent/plan/validate";
import type { BriefInternal, ExclusivityConflict } from "../agent/research/store";
import { dbStore } from "../agent/research/dbStore";
import { runSkill } from "../agent/research/runSkill";
import { loadJob } from "../agent/jobs";
import { createLogger } from "../logger";
import { RATE_LABEL, loadRateContext, type StoredRange } from "./rates";
import { minimumFor } from "./ratesFloor";

const logger = createLogger("services/opportunityRead");

export function dealReadModelEnabled(): boolean {
  return process.env.DEALS_READ_MODEL?.trim().toLowerCase() === "true";
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const range = (lo: number, hi: number) => (Math.round(lo) === Math.round(hi) ? usd(lo) : `${usd(lo)}–${Math.round(hi).toLocaleString("en-US")}`);

// ─── Money (code) ─────────────────────────────────────────────────────────────────────────────────────────────

/** The summariser's deliverable_counts keys → a rate type. Unknown keys still count as work, with no rate type. */
const COUNT_KEY: Record<string, RateType> = {
  reel: "ig_reel", reels: "ig_reel",
  post: "ig_post", posts: "ig_post", carousel: "ig_post", carousels: "ig_post", feed_post: "ig_post", feed_posts: "ig_post",
  story: "ig_story", stories: "ig_story",
  tiktok: "tiktok_video", tiktoks: "tiktok_video", video: "tiktok_video", videos: "tiktok_video", tiktok_videos: "tiktok_video",
  short: "yt_short", shorts: "yt_short", youtube_short: "yt_short", youtube_shorts: "yt_short",
  youtube: "yt_video", youtube_video: "yt_video", youtube_videos: "yt_video",
  ugc: "ugc", ugc_video: "ugc", ugc_videos: "ugc",
  appearance: "appearance_in_person_hour", appearances: "appearance_in_person_hour",
  clinic: "camp_clinic", clinics: "camp_clinic", camp: "camp_clinic", camps: "camp_clinic",
  autograph: "autograph_session", autographs: "autograph_session", signing: "autograph_session", signings: "autograph_session",
  speaking: "speaking", talk: "speaking", talks: "speaking", panel: "speaking", panels: "speaking",
};
/** offer_struct.deal_type (the classifier's work kind) → a rate type, when there are no counts. */
const DEAL_TYPE_RATE: Record<string, RateType> = {
  social_post: "ig_post", appearance: "appearance_in_person_hour", ambassador: "ambassador_month",
  autograph: "autograph_session", licensing: "licensing",
};
/** "3 Reels", "1 feed post". */
const UNIT_WORDS: Partial<Record<RateType, [string, string]>> = {
  ig_post: ["post", "posts"], ig_reel: ["Reel", "Reels"], ig_story: ["story", "stories"], tiktok_video: ["TikTok", "TikToks"],
  yt_short: ["Short", "Shorts"], yt_video: ["YouTube video", "YouTube videos"], ugc: ["UGC video", "UGC videos"],
  appearance_in_person_hour: ["appearance", "appearances"], camp_clinic: ["clinic", "clinics"], autograph_session: ["signing", "signings"],
  speaking: ["talk", "talks"], ambassador_month: ["month", "months"], licensing: ["licence", "licences"],
};

export interface WorkNeed { rateType: RateType | null; count: number; key: string }

/** What the offer buys, as rate types × counts. Pure. */
export function workOf(offer: OfferStruct | null | undefined): WorkNeed[] {
  if (!offer) return [];
  if (offer.unit === "monthly" || offer.unit === "annual") return [{ rateType: "ambassador_month", count: 1, key: "month" }];
  const counts = offer.deliverable_counts ?? null;
  const out: WorkNeed[] = [];
  if (counts) {
    for (const [k, v] of Object.entries(counts)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) continue;
      const key = k.trim().toLowerCase().replace(/[\s-]+/g, "_");
      out.push({ rateType: (isDeliverable(key) ? DELIVERABLE_RATE_TYPE[key] : undefined) ?? COUNT_KEY[key] ?? null, count: Math.round(n), key });
    }
  }
  if (out.length) return out;
  const t = offer.deal_type ? DEAL_TYPE_RATE[offer.deal_type] : undefined;
  return t ? [{ rateType: t, count: 1, key: offer.deal_type! }] : [];
}

/** The cash the offer is worth for the work it buys (per month for a monthly / annual deal). Pure. */
export function cashFor(offer: OfferStruct, work: WorkNeed[]): number | null {
  if (offer.amount == null || !Number.isFinite(offer.amount) || offer.amount <= 0) return null;
  const units = work.reduce((n, w) => n + w.count, 0);
  switch (offer.unit) {
    case "per_post":
    case "per_deliverable":
    case "per_appearance": return offer.amount * Math.max(units, 1);
    case "annual":         return offer.amount / 12;
    default:               return offer.amount;               // total, monthly, or no unit stated: the figure they wrote
  }
}

export interface MoneyInput {
  kind: "deal" | "interview" | "school";
  /** shared/deals dealTypeOf; null = not a deal type it knows (then `kind` decides, as before). */
  dealType?: DealType | null;
  /** The classifier's work_kind (the base of the one floor key). */
  workKind?: string | null;
  offer: OfferStruct | null;
  /** The summariser's term sheet (key_details.terms), already parsed. Its fee and deliverables fill what offer_struct lacks. */
  terms?: TermSheet | null;
  minimumRates: Record<string, unknown>;
  ranges: Map<RateType, StoredRange>;
}

/** Types a request of her time, never a paid offer. */
const UNPAID_TYPES = new Set<DealType>(["press", "podcast", "school_compliance"]);

/** The family of work each rate type prices (shared/deals floorKeyOf's rule: a piece of work refines, never moves). */
const FAMILY: Record<RateType, string> = {
  ig_post: "content", ig_reel: "content", ig_story: "content", tiktok_video: "content", yt_short: "content", yt_video: "content", ugc: "content",
  appearance_in_person_hour: "appearance", appearance_virtual: "appearance", camp_clinic: "appearance", autograph_session: "appearance", speaking: "appearance",
  ambassador_month: "ambassador", licensing: "licensing",
  booking_video_call_30: "booking", booking_clinic: "booking", booking_appearance: "booking",
};

const FEE_UNIT_OFFER: Record<string, OfferStruct["unit"]> = {
  flat: "total", per_deliverable: "per_deliverable", monthly: "monthly", commission_only: "commission_only", product_only: "gifting_only",
};

/** The offer the read measures: offer_struct, with the term sheet's fee and deliverables filling what it lacks. Pure. */
export function offerWithTerms(offer: OfferStruct | null, terms: TermSheet | null | undefined): OfferStruct | null {
  if (!terms) return offer;
  const o: OfferStruct = { ...(offer ?? { amount: null, unit: null }) };
  if (o.amount == null && terms.fee?.amount != null) o.amount = terms.fee.amount;
  if (o.unit == null && terms.fee?.unit) o.unit = FEE_UNIT_OFFER[terms.fee.unit] ?? null;
  if (terms.deliverables?.length) {
    const counts: Record<string, number> = {};
    for (const d of terms.deliverables) counts[d.kind] = (counts[d.kind] ?? 0) + (d.count ?? 1);
    o.deliverable_counts = counts;
  }
  if ((o as any).commission_pct == null && terms.commission?.pct != null) (o as any).commission_pct = terms.commission.pct;
  return offer == null && o.amount == null && o.unit == null && !o.deliverable_counts ? null : o;
}

/** The Money line. Pure. */
export function moneyRead(i: MoneyInput): DealRead["money"] {
  const t = i.dealType ?? null;
  if ((t && UNPAID_TYPES.has(t)) || (!t && i.kind !== "deal")) {
    return t === "school_compliance" || (!t && i.kind === "school")
      ? { line: "From your school, not a paid offer", state: "unpaid", source: "From their email" }
      : { line: "A request for your time, not a paid offer", state: "unpaid", source: "From their email" };
  }
  const o = offerWithTerms(i.offer, i.terms);
  const product = o?.product_value != null && o.product_value > 0 ? o.product_value : null;
  const pct = (o as any)?.commission_pct;
  const commissionLine = `Commission only, no set fee${typeof pct === "number" && pct > 0 ? ` (${pct}% of sales)` : ""}`;
  if (o?.unit === "commission_only") return { line: commissionLine, state: "commission_only", source: "From their latest email" };
  const pieces = workOf(o);
  let work = pieces;
  const cash = o ? cashFor(o, pieces) : null;
  if (cash == null) {
    if (t === "affiliate") return { line: commissionLine, state: "commission_only", source: "From their latest email" };
    if (o?.unit === "gifting_only" || product != null || t === "gift" || t === "product_review") {
      return { line: product != null ? `Product only (~${usd(product)}), no fee` : "Product only, no fee", state: "product_only", source: "From their latest email" };
    }
    return { line: "No fee yet — ask what they’d pay", state: "no_fee", source: "From their latest email" };
  }

  // The one floor key: a type that is never floored (a gift, press, an affiliate programme…) is not measured; a piece
  // of work outside the deal's own family of work (four posts inside an ambassador deal) is measured as the deal's kind.
  const floorable = t == null || floorKeyOf({ dealType: t }) != null;
  const base = t ? floorKeyOf({ dealType: t, workKind: i.workKind ?? null }) : null;
  if (base && o!.unit !== "monthly" && o!.unit !== "annual") {
    if (!work.length || work.some((w) => w.rateType && FAMILY[w.rateType] !== FAMILY[base])) work = [{ rateType: base, count: 1, key: base }];
  }

  // The words describe what they asked for (the pieces); the minimum and range use the work it is measured as.
  const units = pieces.reduce((n, w) => n + w.count, 0);
  const single = pieces.length === 1 ? pieces[0] : null;
  const words = single?.rateType ? UNIT_WORDS[single.rateType] : undefined;
  const monthly = o!.unit === "monthly" || o!.unit === "annual";
  const what = monthly ? `${usd(cash)} a month`
    : single && words ? `${usd(cash)} for ${single.count} ${single.count === 1 ? words[0] : words[1]}${single.count > 1 ? ` — about ${usd(cash / single.count)} each` : ""}`
    : units > 1 ? `${usd(cash)} for ${units} pieces of work`
    : `${usd(cash)} offered`;
  const plus = product != null ? ` plus product (~${usd(product)})` : "";

  // Her minimum: every piece of work with a known rate type and her minimum for it. Arithmetic only.
  const known = work.filter((w) => w.rateType);
  const mins = known.map((w) => ({ w, min: minimumFor(i.minimumRates, w.rateType!) }));
  const needed = mins.reduce((n, m) => n + (m.min ? m.min.value * m.w.count : 0), 0);
  const allMin = work.length > 0 && known.length === work.length && mins.every((m) => m.min);
  let state: DealRead["money"]["state"];
  let minWords: string;
  if (!floorable) { state = "no_min"; minWords = "not measured against your minimum"; }
  else if (needed > 0 && cash < needed) { state = "below_min"; minWords = "under your minimum"; }
  else if (allMin) { state = "above_min"; minWords = "meets your minimum"; }
  else {
    state = "no_min";
    const missing = known.find((w) => !minimumFor(i.minimumRates, w.rateType!));
    minWords = missing ? `no minimum set for ${RATE_LABEL[missing.rateType!].toLowerCase()} yet` : "no minimum to compare — the work isn’t clear yet";
  }

  // Mila's suggested range: only when every piece of work has a stored range. Per piece for one kind of work.
  const rs = known.map((w) => ({ w, r: i.ranges.get(w.rateType!) }));
  let rangeWords = "";
  let usedRange = false;
  if (work.length > 0 && known.length === work.length && rs.every((x) => x.r)) {
    usedRange = true;
    const lo = rs.reduce((n, x) => n + x.r!.low * x.w.count, 0);
    const hi = rs.reduce((n, x) => n + x.r!.high * x.w.count, 0);
    const perPiece = work === pieces && single && single.count > 1;
    const shown = perPiece ? range(lo / single!.count, hi / single!.count) : range(lo, hi);
    rangeWords = cash < lo ? `under your suggested range (${shown})` : cash > hi ? `above your suggested range (${shown})` : `inside your suggested range (${shown})`;
  }
  const line = [`${what}${plus}`, minWords, rangeWords].filter(Boolean).join(", ");
  const source = ["Their latest email", floorable && (needed > 0 || allMin) ? "your minimum" : null, usedRange ? "your suggested range" : null].filter(Boolean).join(" · ");
  return { line, state, source };
}

// ─── Risk (code) ──────────────────────────────────────────────────────────────────────────────────────────────

/** The scam signals the classify call may store on the thread (classification.risk_flags). */
const CLASSIFY_FLAGS = new Set<RiskFlag>(["upfront_fee", "payment_details_asked", "off_platform_payment", "sender_mismatch", "unverified_identity"]);
const SEVERITY: RiskFlag[] = ["sender_mismatch", "upfront_fee", "payment_details_asked", "off_platform_payment", "unverified_identity",
  "exclusivity_conflict", "competitor_of_partner", "brand_safety_note"];

export interface RiskInput {
  qualification: string | null;
  channel: "direct" | "agency" | "unverifiable";
  /** The lead thread's classification jsonb (risk_flags read from it). */
  classification: unknown;
  brandName: string;
  /** Confirmed research only; null otherwise. */
  research: { category?: string | null; competitors?: unknown; brand_safety?: unknown; product_categories?: unknown } | null;
  conflicts: ExclusivityConflict[];
  currentPartners: string[];
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length >= 2).map((x) => x.trim()) : []);
const sameName = (a: string, b: string) => {
  const x = a.trim().toLowerCase(); const y = b.trim().toLowerCase();
  return x.length >= 3 && y.length >= 3 && (x === y || x.includes(y) || y.includes(x));
};
/** A research brand_safety value that actually says something (not "none", "no known controversies", …). */
export function safetyNote(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const t = v.trim().toLowerCase();
  return t.length > 3 && !/^(none|n\/a|null|no\b|nothing|not found|no known|no significant|no major|no notable|no public)/.test(t);
}

/** The Risk line. Pure. */
export function riskRead(i: RiskInput): DealRead["risk"] {
  const flags = new Set<RiskFlag>();
  const sources = new Set<string>();
  if (i.qualification === "verify_first") { flags.add("sender_mismatch"); sources.add("the sender’s address"); }
  else if (i.channel === "unverifiable") { flags.add("unverified_identity"); sources.add("the sender’s address"); }
  for (const f of strs((i.classification as any)?.risk_flags)) {
    if ((RISK_FLAGS as readonly string[]).includes(f) && CLASSIFY_FLAGS.has(f as RiskFlag)) { flags.add(f as RiskFlag); sources.add("their email"); }
  }
  let conflict: ExclusivityConflict | null = null;
  for (const target of [i.brandName, i.research?.category ?? "", ...strs(i.research?.product_categories)]) {
    if (!target) continue;
    conflict = blockedBy(target, i.conflicts);
    if (conflict) break;
  }
  if (conflict) { flags.add("exclusivity_conflict"); sources.add("your partners and exclusivity"); }
  const partner = i.research ? i.currentPartners.find((p) => strs(i.research!.competitors).some((c) => sameName(c, p))) : undefined;
  if (partner) { flags.add("competitor_of_partner"); sources.add("Nomila’s research"); }
  if (i.research && safetyNote(i.research.brand_safety)) { flags.add("brand_safety_note"); sources.add("Nomila’s research"); }

  const ordered = SEVERITY.filter((f) => flags.has(f));
  const words: Record<RiskFlag, string> = {
    sender_mismatch: "Sender doesn’t match the brand",
    unverified_identity: "Can’t check who’s writing yet",
    upfront_fee: "Asks for a fee up front",
    payment_details_asked: "Asks for your bank or card details",
    off_platform_payment: "Wants to pay outside normal channels",
    exclusivity_conflict: "Could clash with an exclusivity you hold",
    competitor_of_partner: `Competes with your partner ${partner ?? ""}`.trim(),
    brand_safety_note: "Nomila’s research notes a controversy",
  };
  if (!ordered.length) {
    const checked = ["the sender", "your partners and exclusivity", i.research ? "Nomila’s research" : null].filter(Boolean).join(", ");
    return { line: "Nothing to flag", flags: [], source: `Checked ${checked}` };
  }
  return { line: ordered.slice(0, 2).map((f) => words[f]).join(" · "), flags: ordered, source: `From ${[...sources].join(", ")}` };
}

// ─── Fit and Goal (model, stored) ─────────────────────────────────────────────────────────────────────────────

export const DEAL_READ_SKILL = "deal-read";

/** The brand fields the fit may read — CONFIRMED research only (null otherwise). Pure. */
export function confirmedResearch(brand: any): Record<string, unknown> | null {
  if (!brand || readIdentity(brand.enrichment)?.status !== "confirmed") return null;
  const e = (brand.enrichment ?? {}) as Record<string, unknown>;
  return {
    name: brand.name ?? null, category: brand.category ?? null, description: brand.description ?? null,
    audience: brand.audience_summary ?? null, sports: brand.sport_categories ?? [], athletes: brand.known_athlete_partnerships ?? [],
    products: strs(e.product_categories), values: typeof e.brand_values === "string" ? e.brand_values : null,
    competitors: strs(e.competitors), brand_safety: e.brand_safety ?? null,
  };
}

/** What the stored fit / goal depends on. A change to any of these makes the stored row stale. Pure. */
export function readInputsKey(p: { brand: any; goals: Array<Pick<Goal, "id" | "text" | "status">>; ask: string | null }): string {
  const id = readIdentity(p.brand?.enrichment);
  const parts = {
    v: 1,
    brand: p.brand ? { id: p.brand.id ?? null, status: id?.status ?? null, checked: id?.checked_at ?? null, enriched: p.brand.enriched_at ? new Date(p.brand.enriched_at).toISOString() : null } : null,
    goals: p.goals.filter((g) => g.status === "active").map((g) => [g.id, g.text]).sort(),
    ask: (p.ask ?? "").trim(),
  };
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

export interface StoredFitGoal { fit_line: string | null; goal_id: string | null; goal_line: string | null; inputs_key: string }

const goalLine = (text: string) => {
  const t = text.trim().replace(/\s+/g, " ");
  return `Helps your goal: ${t.length > 80 ? `${t.slice(0, 79).trimEnd()}…` : t}`;
};
export const NO_GOAL_LINE = "Doesn’t move a goal — money only";

/** Validate the model's answer against what it was given. Pure. */
export function checkFitGoal(json: any, ctx: { research: Record<string, unknown> | null; factKeys: Set<string>; goals: Map<string, Goal> }): { fit: string | null; goal: Goal | null } {
  let fit: string | null = typeof json?.fit === "string" ? json.fit.trim().replace(/\s+/g, " ") : "";
  const keys = strs(json?.fit_facts).filter((k) => ctx.factKeys.has(k));
  if (!ctx.research || !fit || !keys.length || fit.length > 160 || /[$€£]|\d/.test(fit) || /\bAI\b|\bbrains?\b/i.test(fit)) fit = null;
  const ref = typeof json?.goal_ref === "string" ? json.goal_ref.trim() : "none";
  const goal = ref !== "none" ? ctx.goals.get(ref) ?? null : null;
  return { fit, goal };
}

/** Facts the call may read: about her, active, not care, newest first, capped. */
function factsForRead(facts: MemoryFact[]): MemoryFact[] {
  return facts.filter((f) => f.status === "active" && !f.sensitive && f.subject?.kind === "athlete")
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 30);
}

const inflight = new Map<string, Promise<StoredFitGoal | null>>();

/**
 * Fill (or refresh) the stored fit / goal for one deal. One model call at most, and none when there is nothing to ask
 * (brand unconfirmed AND no goals). Deduplicated per deal + inputs.
 */
export async function fillFitGoal(p: { athleteId: string; dealId: string; brand: any; kind: string; ask: string | null; moneyLine: string; goals?: Goal[] }, dbx: any = defaultDb): Promise<StoredFitGoal | null> {
  const goalsAll = p.goals ?? await dbStore.listGoals(p.athleteId);
  const goals = goalsAll.filter((g) => g.status === "active");
  const key = readInputsKey({ brand: p.brand, goals, ask: p.ask });
  const flight = `${p.athleteId}:${p.dealId}:${key}`;
  const existing = inflight.get(flight);
  if (existing) return existing;
  const job = (async (): Promise<StoredFitGoal | null> => {
    const research = confirmedResearch(p.brand);
    let fit: string | null = null;
    let goal: Goal | null = null;
    let runId: string | null = null;
    let skillVersion: string | null = null;
    if (research || goals.length) {
      const facts = factsForRead(await dbStore.listFacts(p.athleteId, ["active"]));
      const factKeys = new Map(facts.map((f, k) => [`F${k + 1}`, f]));
      const goalKeys = new Map(goals.map((g, k) => [`G${k + 1}`, g]));
      // The fit reads what the brand IS; its competitors and safety notes feed the Risk line, not the fit.
      const brandForModel = research ? (({ brand_safety: _s, competitors: _c, ...rest }) => rest)(research as any) : null;
      const input = [
        "DEAL", JSON.stringify({ kind: p.kind, ask: p.ask ?? null, money: p.moneyLine }),
        "",
        // Outside text: the skill declares `brand` external, so the transport fences the whole input (jobs.ts
        // fenceSkillInput, #968) — never fenced here as well.
        "BRAND (confirmed research)",
        brandForModel ? JSON.stringify(brandForModel) : "null",
        "",
        "FACTS",
        ...(facts.length ? [...factKeys].map(([k, f]) => `${k} | ${f.type} | ${f.claim.replace(/\s+/g, " ").slice(0, 300)}`) : ["- (none)"]),
        "",
        "GOALS",
        ...(goals.length ? [...goalKeys].map(([k, g]) => `${k} | domain ${g.domain ?? "-"} | ${g.text.replace(/\s+/g, " ")}`) : ["- (none)"]),
      ].join("\n");
      const res = await runSkill({
        store: dbStore, athleteId: p.athleteId, skillId: DEAL_READ_SKILL, trigger: "event", parentRef: `deal_read:${p.dealId}:${key}`,
        input, schemaName: "deal_read", maxOutputTokens: 400,
        schema: {
          type: "object", additionalProperties: false, required: ["fit", "fit_facts", "goal_ref"],
          properties: { fit: { type: "string" }, fit_facts: { type: "array", items: { type: "string" } }, goal_ref: { type: "string" } },
        } as any,
        evidenceRead: facts.map((f) => ({ kind: "fact" as const, factId: f.id })),
      });
      runId = res.runId;
      skillVersion = loadJob(DEAL_READ_SKILL).version;
      const checked = checkFitGoal(res.json, { research, factKeys: new Set(factKeys.keys()), goals: goalKeys });
      fit = checked.fit;
      goal = checked.goal;
    }
    const row: StoredFitGoal = {
      fit_line: fit,
      goal_id: goal?.id ?? null,
      goal_line: goals.length ? (goal ? goalLine(goal.text) : NO_GOAL_LINE) : null,
      inputs_key: key,
    };
    await dbx.insert(dealReads).values({ athlete_id: p.athleteId, deal_id: p.dealId, brand_id: p.brand?.id ?? null, ...row, skill_version: skillVersion, run_id: runId, updated_at: new Date() })
      .onConflictDoUpdate({ target: [dealReads.athlete_id, dealReads.deal_id],
        set: { brand_id: p.brand?.id ?? null, ...row, skill_version: skillVersion, run_id: runId, updated_at: new Date() } });
    return row;
  })().catch((err) => {
    logger.warn({ athleteId: p.athleteId, dealId: p.dealId, error: err?.message }, "deal read fit/goal fill failed");
    return null;
  }).finally(() => { inflight.delete(flight); });
  inflight.set(flight, job);
  return job;
}

// ─── The read for a set of board items ────────────────────────────────────────────────────────────────────────

/** What one board item needs for its read (the board already loaded all of it). */
export interface ReadItemFacts {
  opportunityId: string;
  dealId: string | null;
  kind: "deal" | "interview" | "school";
  /** shared/deals dealTypeOf; null when the mail is not a type it knows (FAN, NOISE, unknown). */
  dealType: DealType | null;
  workKind: string | null;
  /** key_details.terms, parsed (null when the summariser stored none). */
  terms: TermSheet | null;
  qualification: string | null;
  channel: "direct" | "agency" | "unverifiable";
  classification: unknown;
  offer: OfferStruct | null;
  ask: string | null;
  brand: any;           // the inbox_brands row (or the board's selected columns), null when none
  brandName: string;
}

export interface ReadContext {
  minimumRates: Record<string, unknown>;
  ranges: Map<RateType, StoredRange>;
  conflicts: ExclusivityConflict[];
  currentPartners: string[];
  goals: Goal[];
  stored: Map<string, StoredFitGoal>;
}

/** Everything the reads of one athlete's items need, in a handful of queries. */
export async function loadReadContext(athleteId: string, dealIds: string[], dbx: any = defaultDb): Promise<ReadContext> {
  const [{ ranges, minimumRates }, internal, goals, stored] = await Promise.all([
    loadRateContext(athleteId, dbx),
    dbStore.currentBriefInternal(athleteId).catch(() => null) as Promise<BriefInternal | null>,
    dbStore.listGoals(athleteId).catch(() => [] as Goal[]),
    dealIds.length
      ? dbx.select().from(dealReads).where(and(eq(dealReads.athlete_id, athleteId), inArray(dealReads.deal_id, dealIds)))
      : Promise.resolve([]),
  ]);
  return {
    minimumRates, ranges,
    conflicts: (internal?.exclusivityConflicts ?? []).filter((c) => c && typeof c.what === "string" && Array.isArray(c.blocks)),
    currentPartners: (internal?.currentSponsors ?? []).map((s) => s?.name).filter((n): n is string => typeof n === "string" && n.trim().length > 0),
    goals,
    stored: new Map((stored as any[]).map((r) => [r.deal_id, { fit_line: r.fit_line, goal_id: r.goal_id, goal_line: r.goal_line, inputs_key: r.inputs_key }])),
  };
}

export interface ItemRead { read: DealRead; /** The stored fit / goal is missing or stale (a fill would refresh it). */ stale: boolean }

/** The read of one item from the loaded context. Pure apart from nothing: no I/O. */
export function readFor(item: ReadItemFacts, ctx: ReadContext): ItemRead {
  const money = moneyRead({ kind: item.kind, dealType: item.dealType, workKind: item.workKind, offer: item.offer, terms: item.terms, minimumRates: ctx.minimumRates, ranges: ctx.ranges });
  const research = confirmedResearch(item.brand);
  const risk = riskRead({
    qualification: item.qualification, channel: item.channel, classification: item.classification, brandName: item.brandName,
    research, conflicts: ctx.conflicts, currentPartners: ctx.currentPartners,
  });
  const key = readInputsKey({ brand: item.brand, goals: ctx.goals, ask: item.ask });
  const row = item.dealId ? ctx.stored.get(item.dealId) : undefined;
  const fresh = !!row && row.inputs_key === key;
  const activeGoals = ctx.goals.some((g) => g.status === "active");
  return {
    read: {
      money, risk,
      fit: research && fresh && row!.fit_line ? { line: row!.fit_line, source: "Nomila’s research and what you’ve shared" } : null,
      goal: activeGoals && fresh && row!.goal_line ? { line: row!.goal_line, source: "Your goals" } : null,
    },
    stale: !!item.dealId && !fresh && (!!research || activeGoals),
  };
}

/** Fill a few stale items in the background (the board never waits). Returns how many were started. */
export function refreshStale(athleteId: string, items: Array<ReadItemFacts & { moneyLine: string }>, goals: Goal[], max = 5): number {
  if (!dealReadModelEnabled()) return 0;
  const todo = items.filter((i) => i.dealId).slice(0, max);
  for (const i of todo) {
    void fillFitGoal({ athleteId, dealId: i.dealId!, brand: i.brand, kind: i.dealType ?? i.kind, ask: i.ask, moneyLine: i.moneyLine, goals });
  }
  return todo.length;
}
