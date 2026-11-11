/**
 * agent/moments/scan.ts — one moments scan: read → (guards) → one model call with web search → code checks → write. The
 * single owner of the moments store (facts.ts): it refreshes, de-duplicates and retires it.
 *
 *   1. No current Brief → skipped (the weekly scan; the onboarding scan runs before the first Brief, requireBrief false).
 *   2. A retried workflow step whose run already wrote → reused. A run that completed (paid) but never wrote → its
 *      output is applied now, with no cap check and no second call (the money is spent; dropping the answer helps no
 *      one).
 *   3. Budget: the athlete's spend today (every run; AGENT_DAY_COST_CAP_USD), on moments runs in the last 7 days
 *      (AGENT_MOMENTS_WEEK_CAP_USD) and, at onboarding, the onboarding's own cap must each leave room for one scan's
 *      worst case (AGENT_MOMENTS_RUN_CAP_USD); else skipped.
 *   4. runSkill: skill moments, the fast tier (OpenAI: web search stays on OpenAI by rule, models.ts), web_search capped
 *      at AGENT_MOMENTS_MAX_SEARCHES, MOMENTS_SCHEMA, max_output_tokens AGENT_MOMENTS_MAX_OUTPUT_TOKENS. A moment the
 *      model marks never-store (or whose words carry contact details) is removed before the run's output is stored.
 *      Search guard (moments 1.2.0): a run that made NO web search gets ONE retry (its own run, parentRef
 *      "<parentRef>:retry"), its input carrying a note to search the other kinds first — when the caps still leave room
 *      for it. A retry that searches nothing again is not a failure: it is recorded on the run (output.search_guard)
 *      and logged, and its answer is applied as usual.
 *   5. applyMoments (code, never the model) writes what passes its checks, and the run's output records what was
 *      written, refreshed (with what it was before) and held, and why:
 *        - a moment needs a real date (a day, or a month) whose period has not ended and starts inside the window
 *          (today … today + 60 days, the plan's own window);
 *        - a moment needs a source: a URL this scan's searches saw, or — for a schedule moment — a fact of the
 *          athlete's, or — for a partner moment — a SIGNED or ACCEPTED deal (an unsigned deal is conflict context only),
 *          stored as a source ref. A refreshed moment keeps its source when the scan gives no new one;
 *        - the same moment twice (date + normalised name, facts.ts) is written once. A moment the store owns (topic
 *          moment or upcoming, found by research or a scan) is REFRESHED in place (same id, so its decision and any plan
 *          action timed to it stay valid). Anything else — an event fact filed under another topic, one the athlete told
 *          us, one the athlete confirmed — is LINKED: never rewritten and never retired; its date rules;
 *        - no key, contact detail or "AI" / "brain" in the words (the source title included); at most twelve moments;
 *        - each moment carries ONE angle with a hook (moments 1.2.0); the plan picks format, platform, timing and the
 *          shot list. Rows written before keep their old idea, brief and media needs, and every reader reads them;
 *        - care: stored as a sensitive fact, with NO candidate post (a care moment never becomes content);
 *        - retire: passed | cancelled | moved | wrong supersede an owned fact (never deleted); not_worth_a_post keeps the
 *          fact and expires only its candidate post. An owned moment whose period has ended is retired too;
 *        - each kept moment has ONE pending candidate post (memory_decisions kind other, detail.kind moment), refreshed
 *          in place or written; a pending candidate whose moment is no longer active, or has ended, is expired;
 *        - the idea bank (design §6, build step 8): each candidate post is also filed
 *          as ONE bank entry, time-bound to it (agent/ideaBank/bank.ts mirrorMoment) — written once, refreshed in place
 *          while still new, never touched once the plan used, skipped or adapted it. A moment that turns out to be a
 *          care moment has EVERY idea on it skipped (its own entry, a reverse-pass idea, a plan-adapted row), whether
 *          or not its candidate was still pending (a care moment never becomes a post, not even adapted). An entry
 *          whose moment is retired or passed stays new: a missed idea the plan may adapt to a later event — unless the
 *          retire reason (recorded on the candidate) says it was cancelled or wrong.
 */
import type { DatePrecision, Decision, EvidenceRef, MemoryFact, Preference, RunTrigger } from "../../../shared/agent";
import {
  MOMENT_CATEGORIES, MOMENT_RETIRE_WHYS, type MomentCategory, type MomentDecisionDetail, type MomentRetireWhy,
} from "../../../shared/plan";
import { createLogger } from "../../logger";
import { copywriterEnabled } from "../../services/copywriterFlag";
import { cleanClaim } from "../factHygiene";
import { findNeverContent } from "../policy";
import { guardrailLines, guardrailsFrom, type AthleteGuardrails } from "../guardrails";
import { BANNED_WORDS } from "../plan/validate";
import { dropReason, type PrivacyDrop } from "../research/privacy";
import { checkSource, datePrecisionOf } from "../research/research";
import { CostCapError, runSkill } from "../research/runSkill";
import { MOMENTS_SCHEMA } from "../research/schemas";
import { athleteDaySpendMicroUsd, type AgentStore, type StoredRun } from "../research/store";
import { mirrorMoment, skipIdeasForMoment } from "../ideaBank/bank";
import { MOMENTS, MOMENTS_SKILL_ID } from "./config";
import { EVENT_TOPICS, findSameMoment, isEventFact, momentDatesMatch, momentNameOf, momentNamesMatch, notEnded, periodEnd } from "./facts";

export { periodEnd };

const logger = createLogger("agent/moments");
const DAY = 86_400_000;

/** One of the athlete's deals, as the scan reads it (sources.ts reads them from the deals table). */
export interface MomentDeal {
  id: string;
  brand: string;
  /** The brand's category, when known. */
  category: string | null;
  status: string | null;
  termStart: string | null;
  termEnd: string | null;
  signed: boolean;
}

/** A deal a partner moment may rest on: signed, or accepted. Any other deal is conflict context only. */
export const dealCanSource = (d: Pick<MomentDeal, "signed" | "status">): boolean => d.signed || d.status === "accepted";

/** The scan's non-memory inputs (sources.ts reads them from the database; tests pass their own). */
export interface MomentsSources {
  /** The athlete's current and recent deals. */
  deals(athleteId: string, today: string): Promise<MomentDeal[]>;
  /** Her active preferences: the avoid-list and never-use names (the plan's own source, memory listPreferences). */
  preferences(athleteId: string): Promise<Preference[]>;
}

export interface MomentsScanRequest {
  store: AgentStore;
  sources: MomentsSources;
  athleteId: string;
  trigger: Extract<RunTrigger, "schedule" | "event">;
  /** "workflow:<run id>:scan" — a retried step reuses the finished run. */
  parentRef: string | null;
  now?: Date;
  /** Default true. False at onboarding: the first scan runs before the first Brief, so its timing is not thin. */
  requireBrief?: boolean;
  /** The budget of the job this scan belongs to (the onboarding's cap), checked beside the scan's own caps. */
  jobBudget?: { spentMicroUsd: number; capMicroUsd: number };
}

/** A refreshed moment, and what it was before (the store keeps one row; its history lives here, on the run). */
export interface RefreshedMoment {
  factId: string;
  before: { name: string; claim: string; date: string | null; precision: DatePrecision | null; source: MemoryFact["source"]; confidence: number };
}

/** What one scan wrote (agent_runs.output.applied). */
export interface MomentsApplied {
  /** New moment facts written. */
  written: string[];
  /** Moment facts refreshed in place, each with what it was before. */
  refreshed: RefreshedMoment[];
  /** Event facts the scan does not own (another topic, the athlete's own word, confirmed) a moment was linked to. */
  linked: string[];
  /** Moment facts retired because the scan said they passed, were cancelled, moved or wrong. */
  retired: string[];
  /** Moment facts retired because their period had ended. */
  passed: string[];
  /** Candidate-post decisions written or refreshed, in rank order. */
  decisions: string[];
  /** Candidate-post decisions expired (their moment retired, ended, inactive, care, or not worth a post). */
  expired: string[];
}

export type MomentsScanOutcome =
  | { status: "scanned"; runId: string; written: number; refreshed: number; linked: number; retired: number; passed: number; held: number; costMicroUsd: number; searches: number; retried: boolean }
  | { status: "reused"; runId: string; why: "retried_step" }
  | { status: "skipped"; reason: "no_brief" | "day_cap" | "week_cap" | "job_cap" };

/** What a moments run's output holds (agent_runs.output), beside runSkill's own fields. */
export interface MomentsRunOutput {
  json?: unknown;
  applied?: MomentsApplied;
  held?: Array<{ what: string; reason: string }>;
  privacy_drops?: PrivacyDrop[];
  /**
   * The search guard (moments 1.2.0). On a run that made no search: `retry_run_id`, the retry it handed over to (that
   * run's output is the one applied). On the run that was applied: how many searches it made, and whether it was a retry
   * that still searched nothing (`note`).
   */
  search_guard?: { searches: number; retry_run_id?: string; retried?: boolean; note?: string };
}

/** What a run that made no web search is retried with (moments 1.2.0): ahead of the input, once. */
export const SEARCH_FIRST_NOTE = "NOTE: the last attempt at this scan made no web search. Before you choose anything, search the web for each of the other kinds first (the sport's and the league's moments, awareness days and holidays, cultural and trending moments, and any partner campaign dates), then choose.";

// ─── Dates ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY));

/**
 * A moment's date as stored: a real calendar day (`YYYY-MM-DD`) or a month (`YYYY-MM`, stored as its 1st), at the
 * coarser of what the text gives and what the model said. A year alone, or a day that does not exist, is no date.
 */
export function momentDateOf(raw: unknown, said: unknown): { date: string; precision: "day" | "month" } | null {
  const text = String(raw ?? "").trim();
  const shape = datePrecisionOf(text);
  if (shape !== "day" && shape !== "month") return null;
  const precision: "day" | "month" = shape === "day" && said !== "month" ? "day" : "month";
  const date = precision === "day" ? text : `${text.slice(0, 7)}-01`;
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(t) && isoDay(new Date(t)) === date ? { date, precision } : null;
}

// ─── The input ─────────────────────────────────────────────────────────────────────────────────────────────────────

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

/** The scan's pending candidate posts, by the moment fact each is for (the newest wins if there were ever two). */
export function momentDecisionsByFact(decisions: Decision[]): Map<string, Decision> {
  const by = new Map<string, Decision>();
  for (const d of decisions) {
    const detail = d.detail as Partial<MomentDecisionDetail> | undefined;
    if (d.skillId === MOMENTS_SKILL_ID && (d.kind ?? "other") === "other" && detail?.kind === "moment" && typeof detail.factId === "string" && d.response === "pending") by.set(detail.factId, d);
  }
  return by;
}

export interface MomentsInput {
  input: string;
  today: string;
  horizonEnd: string;
  /** F-keys → the athlete's facts; D-keys → deals; M-keys → event facts on file that have not ended. */
  facts: Map<string, MemoryFact>;
  deals: Map<string, MomentDeal>;
  existing: Map<string, MemoryFact>;
  /** Every event fact on file that has not ended (not capped): what a candidate is de-duplicated against. */
  upcoming: MemoryFact[];
  /** Owned moments whose period has ended: retired by this scan. */
  passed: MemoryFact[];
  /** Ids of the facts the scan may rewrite or retire (the store owns them); every other event fact is linked only. */
  owned: Set<string>;
  /** Every fact of the athlete's by id, any status (what a pending candidate's moment is now). */
  everyFact: Map<string, MemoryFact>;
  decisionsByFact: Map<string, Decision>;
  /** Each candidate post's own idea-bank entry (moment decision id → the entry's row); empty while the bank is off. */
  ideaEntries: Map<string, Decision>;
  /** Every candidate post ever written for each moment fact, any response (what a care moment's ideas are bound to);
   * empty while the bank is off. */
  momentIdsByFact: Map<string, Set<string>>;
  /** Her avoid-list, never-use names, current partners and conflicts (agent/guardrails.ts): in the input, and checked. */
  guardrails: AthleteGuardrails;
  evidence: EvidenceRef[];
}

/**
 * The store owns a moment it may rewrite and retire: filed as a moment (or as upcoming) by research or a scan, never
 * the athlete's own word ("said") and never a fact the athlete confirmed.
 */
export function ownsMoment(f: Pick<MemoryFact, "id" | "topic" | "type">, confirmed: ReadonlySet<string>): boolean {
  return (EVENT_TOPICS as readonly string[]).includes(f.topic ?? "") && f.type !== "said" && !confirmed.has(f.id);
}

export async function buildMomentsInput(store: AgentStore, sources: MomentsSources, athleteId: string, now: Date): Promise<MomentsInput> {
  const today = isoDay(now);
  const horizonEnd = addDays(today, MOMENTS.HORIZON_DAYS);
  const every = await store.listFacts(athleteId);
  const all = every.filter((f) => f.status === "active" || f.status === "disputed");
  const confirmed = await store.confirmedFactIds(athleteId);
  const brief = await store.currentBrief(athleteId);
  const decisionsByFact = momentDecisionsByFact(await store.listDecisions(athleteId, { skillId: MOMENTS_SKILL_ID, kinds: ["other"], responses: ["pending"] }));
  const ideaEntries = new Map<string, Decision>();
  const momentIdsByFact = new Map<string, Set<string>>();
  for (const d of await store.listDecisions(athleteId, { skillId: MOMENTS_SKILL_ID, kinds: ["other"] })) {
    const detail = (d.detail ?? {}) as { kind?: unknown; momentDecisionId?: unknown; factId?: unknown };
    if (detail.kind === "idea" && typeof detail.momentDecisionId === "string") ideaEntries.set(detail.momentDecisionId, d);
    if (detail.kind === "moment" && typeof detail.factId === "string") momentIdsByFact.set(detail.factId, (momentIdsByFact.get(detail.factId) ?? new Set()).add(d.id));
  }
  const deals = await sources.deals(athleteId, today).catch(() => [] as MomentDeal[]);
  // The same guardrails the plan reads: her preferences and the Brief's internal read (partners, conflicts).
  const guardrails = guardrailsFrom(
    await sources.preferences(athleteId).catch(() => [] as Preference[]),
    brief ? await store.currentBriefInternal(athleteId).catch(() => null) : null,
  );

  const events = all.filter(isEventFact);
  const owned = new Set(events.filter((f) => ownsMoment(f, confirmed)).map((f) => f.id));
  const upcoming = events.filter((f) => notEnded(f, today)).sort((a, b) => a.date!.localeCompare(b.date!) || a.createdAt.localeCompare(b.createdAt));
  const passed = events.filter((f) => owned.has(f.id) && !notEnded(f, today));

  const name = all.find((f) => f.type === "said" && (f.source.ref ?? "").endsWith("#name"))?.subject.name ?? "";
  const told = all.filter((f) => f.type === "said" && /#(sport|said:\d+)$/.test(f.source.ref ?? "")).map((f) => oneLine(f.claim));
  // The identity line: the newest value research confirmed for each identity field.
  const fields = new Map<string, string>();
  for (const f of [...all].filter((x) => x.field && x.fieldValue && x.status === "active").sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (!fields.has(f.field!)) fields.set(f.field!, f.fieldValue!);
  }
  // The athlete's own facts a moment may rest on: not event facts (those are moments), never care facts (no content
  // rests on one), never measured numbers; newest first.
  const own = all.filter((f) => !isEventFact(f) && !f.sensitive && f.type !== "measured")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MOMENTS.CAPS.facts);
  const facts = new Map(own.map((f, i) => [`F${i + 1}`, f] as const));
  const dealMap = new Map(deals.slice(0, MOMENTS.CAPS.deals).map((d, i) => [`D${i + 1}`, d] as const));
  const existing = new Map(upcoming.slice(0, MOMENTS.CAPS.existing).map((f, i) => [`M${i + 1}`, f] as const));

  const disputed = (f: MemoryFact) => (f.status === "disputed" ? " (DISPUTED: sources disagree)" : "");
  const dateWords = (f: MemoryFact) => `${f.datePrecision === "month" ? f.date!.slice(0, 7) : f.date!.slice(0, 10)} | ${f.datePrecision === "month" ? "month" : "day"}`;
  const whose = (f: MemoryFact) => (owned.has(f.id) ? "" : f.type === "said" ? " | the athlete told us: keep its date" : confirmed.has(f.id) ? " | the athlete confirmed it: keep its date" : " | research filed it: keep its date");
  const ideaOf = (f: MemoryFact) => {
    const d = decisionsByFact.get(f.id)?.detail as Partial<MomentDecisionDetail> | undefined;
    // A row from before moments 1.2.0 has no angle: its hook alone is what is on file.
    return d?.idea ? `idea on file: ${oneLine(d.idea.hook)}${d.idea.angle ? ` (angle: ${oneLine(d.idea.angle)})` : ""}` : "no idea on file";
  };
  const input = [
    `TODAY: ${today} (the window runs to ${horizonEnd})`,
    ``,
    `ATHLETE`,
    `- name: ${name || "(not given)"}`,
    ...(brief?.display?.stage ? [`- career stage: ${oneLine(brief.display.stage.label)} (band ${brief.display.stage.band})`] : []),
    ...[...fields].map(([k, v]) => `- ${k}: ${oneLine(v)}`),
    ...told.map((t) => `- told us: ${t}`),
    ``,
    `THE ATHLETE'S FACTS`,
    ...(facts.size ? [...facts].map(([k, f]) => `${k} | ${f.subject.kind}: ${oneLine(f.subject.name)}${disputed(f)} | ${clip(oneLine(f.claim), 300)} | date ${f.date ?? "-"}`) : ["- (none yet)"]),
    ``,
    `EXISTING MOMENTS (on file, not ended)`,
    ...(existing.size ? [...existing].map(([k, f]) => `${k} | ${dateWords(f)} | ${oneLine(momentNameOf(f))}${disputed(f)} | ${clip(oneLine(f.claim), 300)} | ${ideaOf(f)}${whose(f)}`) : ["- (none yet)"]),
    ``,
    `DEALS`,
    ...(dealMap.size ? [...dealMap].map(([k, d]) => `${k} | ${oneLine(d.brand)} | category ${d.category ? oneLine(d.category) : "-"} | status ${d.status ?? "-"} | term ${d.termStart ?? "?"} to ${d.termEnd ?? "?"} | ${d.signed ? "signed" : "not confirmed signed"} | ${dealCanSource(d) ? "may be a partner moment" : "conflict context only: never a partner moment"}`) : ["- (none)"]),
    ``,
    ...guardrailLines(guardrails),
  ].join("\n");

  return {
    input, today, horizonEnd, facts, deals: dealMap, existing, upcoming, passed, owned, everyFact: new Map(every.map((f) => [f.id, f])), decisionsByFact,
    ideaEntries, momentIdsByFact, guardrails,
    evidence: [
      ...[...facts.values(), ...existing.values()].map((f) => ({ kind: "fact" as const, factId: f.id })),
      ...[...dealMap.values()].map((d) => ({ kind: "record" as const, table: "deals", id: d.id })),
    ],
  };
}

// ─── The checks and the write ──────────────────────────────────────────────────────────────────────────────────────

const KEY_LIST = String.raw`[FDM]\d+(?:\s*(?:,|and|&)\s*[FDM]\d+)*`;
/**
 * Keys the model leaked into words, removed without garbling the sentence: bracketed key lists ("(F1, M2)"), a lead-in
 * that only points at a key ("per F1, " / "see M2: "), a clause that ends by pointing at one ("as noted in F1."), a
 * possessive ("F1's " → "the "). A key left inside the sentence ("for D1 day") is replaced by what it names ("for Acme
 * day"), never just deleted. Only keys this input used: "the M5 motorway" stays.
 */
export function stripMomentKeys(text: unknown, names: ReadonlyMap<string, string>): string {
  const isKnown = (k: string) => names.has(k);
  const allKnown = (list: string) => (list.match(/[FDM]\d+/g) ?? []).every(isKnown);
  let s = cleanClaim(String(text ?? ""));
  const first = s.trimStart().slice(0, 1);
  s = s.replace(new RegExp(String.raw`\s*[(\[]\s*(${KEY_LIST})\s*[)\]]`, "g"), (m, list: string) => (allKnown(list) ? "" : m));
  s = s.replace(new RegExp(String.raw`\b(?:per|see|via|from|as in|according to|based on)\s+(${KEY_LIST})\s*[,:;]?\s*`, "gi"), (m, list: string) => (allKnown(list) ? "" : m));
  // A clause that ends by pointing at keys ("as noted in F1.") loses the pointer with them.
  s = s.replace(new RegExp(String.raw`\s*(?:,\s*)?\b(?:as noted|as listed|as shown|noted|listed|shown)?\s*\b(?:in|on|at|per|from|see)\s+(${KEY_LIST})(?=\s*(?:[.,;:!?)]|$))`, "gi"), (m, list: string) => (allKnown(list) ? "" : m));
  s = s.replace(/\b([FDM]\d+)'s\s+/g, (m, k: string) => (isKnown(k) ? "the " : m));
  s = s.replace(new RegExp(String.raw`\b(${KEY_LIST})\b`, "g"), (m, list: string) => {
    const keys = list.match(/[FDM]\d+/g) ?? [];
    if (!keys.every(isKnown)) return m;
    const words = keys.map((k) => names.get(k)!).filter(Boolean);
    return words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : words[0] ?? "";
  });
  s = s.replace(/\s{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").replace(/([,;:])\s*([.,;:!?])/g, "$2").replace(/^[\s,;:]+/, "").trim();
  // A sentence whose opening words were a key lead-in starts with a capital again (only then: the rest is as written).
  const startChanged = !!s && first !== s.slice(0, 1) && /^[A-Z]/.test(first);
  return startChanged ? s[0].toUpperCase() + s.slice(1) : s;
}

const clamp01 = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);
/** Retire reasons that end the moment as recorded (the fact is superseded); not_worth_a_post keeps it. */
const ENDS_THE_FACT: ReadonlySet<MomentRetireWhy> = new Set(["passed", "cancelled", "moved", "wrong"]);
const isActive = (f: MemoryFact | undefined) => !!f && (f.status === "active" || f.status === "disputed");

/** Apply a scan's JSON: check every moment, write the store, retire, and say what was held and why. */
export async function applyMoments(store: AgentStore, athleteId: string, runId: string, json: any, ctx: MomentsInput & { seen: Array<{ url: string }>; now: Date }): Promise<{ applied: MomentsApplied; held: Array<{ what: string; reason: string }> }> {
  const applied: MomentsApplied = { written: [], refreshed: [], linked: [], retired: [], passed: [], decisions: [], expired: [] };
  const held: Array<{ what: string; reason: string }> = [];
  // What each key names, for a key left inside a sentence: a fact's subject, a moment's name, a deal's brand.
  const known = new Map<string, string>([
    ...[...ctx.facts].map(([k, f]) => [k, oneLine(f.subject.name)] as [string, string]),
    ...[...ctx.existing].map(([k, f]) => [k, oneLine(momentNameOf(f))] as [string, string]),
    ...[...ctx.deals].map(([k, d]) => [k, oneLine(d.brand)] as [string, string]),
  ]);
  const touched = new Set<string>();
  const kept: Array<{ name: string; date: string; precision: "day" | "month" }> = [];
  const expired = new Set<string>();
  // `why`: the scan's retire reason, recorded on the candidate (idea bank on) so a cancelled or wrong moment's idea is
  // never adapted to another event.
  const expire = async (d: Decision | undefined, reason: string, why?: MomentRetireWhy) => {
    if (!d || expired.has(d.id)) return;
    await store.respondDecision(athleteId, d.id, "expired", reason);
    if (why) await store.updateDecision(athleteId, d.id, { detail: { ...(d.detail ?? {}), retiredWhy: why } });
    expired.add(d.id);
    applied.expired.push(d.id);
  };

  for (const m of (Array.isArray(json?.moments) ? json.moments : []).slice(0, MOMENTS.MAX_MOMENTS)) {
    const name = stripMomentKeys(m?.name, known).slice(0, 120);
    const what = name || "(unnamed moment)";
    const description = stripMomentKeys(m?.description, known).slice(0, 2000);
    const whyNow = stripMomentKeys(m?.why_now, known).slice(0, 300);
    const category = (MOMENT_CATEGORIES as readonly string[]).includes(m?.category) ? (m.category as MomentCategory) : null;
    // moments 1.2.0: the moment's ONE angle and its hook; the plan picks format, platform, timing and the shot list.
    const idea: { hook: string; angle: string; original?: { hook: string; angle: string } } = { hook: stripMomentKeys(m?.idea?.hook, known).slice(0, 300), angle: stripMomentKeys(m?.idea?.angle, known).slice(0, 300) };
    // The copy pass (COPYWRITER_V1, polishMoments below): the scan's own words, kept beside the rewrite.
    if (m?.idea?.original?.hook && m?.idea?.original?.angle) idea.original = { hook: stripMomentKeys(m.idea.original.hook, known).slice(0, 300), angle: stripMomentKeys(m.idea.original.angle, known).slice(0, 300) };
    const sourceTitle = oneLine(m?.source_title).slice(0, 300);
    const words = [name, description, whyNow, idea.hook, idea.angle, sourceTitle];

    // Privacy first: a never-store moment is not stored (runSkill's sanitize removed any the model marked; this holds
    // one that reached code anyway), and its words are never recorded.
    if (m?.sensitivity === "never") { held.push({ what: "(a moment not stored)", reason: "marked never-store" }); continue; }
    const care = m?.sensitivity === "care";
    // Every name she marked never to use (moments 1.1.0), checked before any hold that records the moment's name: a
    // moment naming one is held without its words, like a never-store moment (sanitizeMoments already kept it out of
    // the stored output; this holds one that reached code anyway).
    const never = words.flatMap((w) => findNeverContent(w, ctx.guardrails.neverTerms));
    if (never.includes("never_term")) { held.push({ what: "(a moment not stored)", reason: NEVER_TERM_HELD }); continue; }
    if (!name || !description || !whyNow || !category || !idea.hook || !idea.angle) { held.push({ what, reason: "incomplete: a name, what it is, why now, a category, a hook and an angle are all needed" }); continue; }
    if (words.some((w) => BANNED_WORDS.test(w))) { held.push({ what, reason: "says \"AI\" or \"brain\"" }); continue; }
    // Contact details or an address.
    if (never.length) { held.push({ what, reason: "carries contact details or an address" }); continue; }
    const dated = momentDateOf(m?.date, m?.date_precision);
    if (!dated) { held.push({ what, reason: `no usable date (${oneLine(m?.date) || "none"}): a day or a month is needed` }); continue; }
    if (periodEnd(dated.date, dated.precision) < ctx.today || dated.date > ctx.horizonEnd) { held.push({ what, reason: `${dated.date} is outside the window (${ctx.today} to ${ctx.horizonEnd})` }); continue; }
    if (kept.some((k) => momentDatesMatch({ date: k.date, precision: k.precision }, { date: dated.date, precision: dated.precision }) && momentNamesMatch(k.name, name))) {
      held.push({ what, reason: "the same moment twice in this scan" });
      continue;
    }

    // The same moment on file: by date + name; else the M-key the model named, when its date agrees.
    const hinted = typeof m?.refreshes === "string" ? ctx.existing.get(m.refreshes.trim()) : undefined;
    const same = findSameMoment({ name, ...dated }, ctx.upcoming)
      ?? (hinted && momentDatesMatch({ date: dated.date, precision: dated.precision }, { date: hinted.date!, precision: hinted.datePrecision }) ? hinted : null);
    if (same && touched.has(same.id)) { held.push({ what, reason: "the same moment twice in this scan" }); continue; }
    const ownsSame = !!same && ctx.owned.has(same.id);

    // The source: a page this scan saw; else a schedule moment's own fact, or a partner moment's signed or accepted deal.
    const basedOn: string[] = (Array.isArray(m?.based_on) ? m.based_on : []).map((k: unknown) => String(k).trim());
    const deal = basedOn.map((k) => ctx.deals.get(k)).find((d): d is MomentDeal => !!d && dealCanSource(d));
    const fact = basedOn.map((k) => ctx.facts.get(k)).find((f): f is MemoryFact => !!f);
    const url = oneLine(m?.source_url);
    let source: { url?: string; ref?: string; title?: string } | null = null;
    let factor = 1;
    if (url) {
      const s = checkSource(url, ctx.seen);
      if (s.ok) { source = { url: s.url, ...(sourceTitle ? { title: sourceTitle } : {}) }; factor = s.factor; }
    }
    if (!source && category === "partner_campaign" && deal) source = { ref: `deals/${deal.id}`, title: `Your deal with ${oneLine(deal.brand)}` };
    if (!source && category === "schedule" && fact) source = { ref: `memory_facts/${fact.id}`, title: "From what Nomila knows" };
    const keepSource = !source && ownsSame;
    if (!source && !keepSource && !(same && !ownsSame)) {
      const reason = url ? "its source was not seen by this scan's searches"
        : category === "partner_campaign" ? (basedOn.some((k) => ctx.deals.has(k)) ? "no source: its deal is not signed or accepted (conflict context only)" : "no source: no page seen, and no signed or accepted deal behind it")
          : category === "schedule" ? "no source: no page seen, and no fact of the athlete's behind it"
            : "no source: a league, holiday, awareness or cultural moment needs a page this scan saw";
      held.push({ what, reason });
      continue;
    }
    const confidence = Math.round(clamp01(m?.confidence) * factor * 100) / 100;

    // Write: refresh an owned moment, link one the store does not own (its date rules), or write a new one.
    let factId: string;
    let momentDate = dated;
    if (same && ownsSame) {
      const before = { name: momentNameOf(same), claim: same.claim, date: same.date, precision: same.datePrecision ?? null, source: same.source, confidence: same.confidence };
      const r = await store.refreshFact(athleteId, same.id, {
        subjectName: name, claim: description, source: keepSource ? same.source : source!, date: dated.date, datePrecision: dated.precision, confidence, runId,
        ...(keepSource ? {} : { sourceType: null }), ...(care ? { sensitive: true } : {}),
      });
      if (!r) { held.push({ what, reason: "the moment on file could not be refreshed (no longer active)" }); continue; }
      factId = r.id;
      applied.refreshed.push({ factId, before });
    } else if (same) {
      factId = same.id;
      // The athlete's word, a confirmed fact or research's own: never rewritten, and its date rules.
      momentDate = { date: same.date!, precision: same.datePrecision === "month" ? "month" : "day" };
      applied.linked.push(factId);
    } else {
      const [f] = await store.insertFacts(athleteId, [{
        subject: { kind: "event", name }, claim: description, type: "found", source: source!, date: dated.date, datePrecision: dated.precision,
        confidence, topic: "moment", runId, ...(care ? { sensitive: true, careKind: "personal" as const } : {}),
      }]);
      factId = f.id;
      applied.written.push(factId);
    }
    touched.add(factId);
    kept.push({ name, ...dated });

    // Care: kept as a sensitive fact, never content — no candidate post, and any on file expires.
    const prior = ctx.decisionsByFact.get(factId);
    if (care) {
      await expire(prior, "a care moment never becomes a post");
      // Every idea on it is skipped, whoever wrote it, whether or not its candidate post was still pending.
      await skipIdeasForMoment(store, athleteId, factId, new Set([...(ctx.momentIdsByFact.get(factId) ?? []), ...(prior ? [prior.id] : [])]));
      continue;
    }

    // The moment's one pending candidate post: refreshed in place, or written.
    const detail: MomentDecisionDetail = {
      kind: "moment", factId, name, date: momentDate.date, datePrecision: momentDate.precision, category, whyNow, rank: kept.length,
      idea, scannedAt: ctx.now.toISOString(),
    };
    const evidence: EvidenceRef[] = [{ kind: "fact", factId }, ...(deal ? [{ kind: "record" as const, table: "deals", id: deal.id }] : [])];
    const d = prior
      ? await store.updateDecision(athleteId, prior.id, { suggested: idea.hook, why: whyNow, evidence, detail: detail as unknown as Record<string, unknown>, runId })
      : await store.insertDecision(athleteId, { runId, skillId: MOMENTS_SKILL_ID, kind: "other", suggested: idea.hook, why: whyNow, evidence, detail: detail as unknown as Record<string, unknown> });
    if (d) {
      applied.decisions.push(d.id);
      // The idea bank: the candidate post, filed as its bank entry too.
      await mirrorMoment(store, athleteId, runId, d.id, detail, ctx.ideaEntries.get(d.id));
    }
  }

  // Retire what the scan says: passed / cancelled / moved / wrong supersede an owned fact; not_worth_a_post (and any
  // fact the store does not own) only expires the candidate post. Never one kept this run.
  for (const r of Array.isArray(json?.retire) ? json.retire : []) {
    const key = oneLine(r?.key);
    const why = (MOMENT_RETIRE_WHYS as readonly string[]).includes(r?.why) ? (r.why as MomentRetireWhy) : null;
    const f = ctx.existing.get(key);
    const because = `${why ?? "retired"}: ${oneLine(r?.reason).slice(0, 160) || "no longer fits"}`;
    if (!f) { held.push({ what: `retire ${key || "(no key)"}`, reason: "not a moment on file" }); continue; }
    if (!why) { held.push({ what: `retire ${key}`, reason: "no reason from the list (passed, cancelled, moved, wrong, not_worth_a_post)" }); continue; }
    if (touched.has(f.id)) { held.push({ what: `retire ${key}`, reason: "kept by this same scan" }); continue; }
    if (why === "not_worth_a_post") { await expire(ctx.decisionsByFact.get(f.id), `the moments scan: ${because}`, why); continue; }
    if (!ctx.owned.has(f.id)) {
      await expire(ctx.decisionsByFact.get(f.id), `the moments scan: ${because}`, why);
      held.push({ what: `retire ${key}`, reason: "the fact is the athlete's own, confirmed, or research's: kept as written; only its post expired" });
      continue;
    }
    if (applied.retired.includes(f.id)) continue;
    await store.setFactStatus(athleteId, f.id, "superseded");
    await expire(ctx.decisionsByFact.get(f.id), `retired by the moments scan: ${because}`, why);
    applied.retired.push(f.id);
  }
  // Every owned moment whose period has ended.
  for (const f of ctx.passed) {
    await store.setFactStatus(athleteId, f.id, "superseded");
    await expire(ctx.decisionsByFact.get(f.id), "the moment has passed");
    applied.passed.push(f.id);
  }
  // Any pending candidate whose moment is no longer active, or has ended (owned and linked alike).
  for (const [factId, d] of ctx.decisionsByFact) {
    if (touched.has(factId)) continue;
    const f = ctx.everyFact.get(factId);
    if (!isActive(f) || applied.retired.includes(factId)) await expire(d, "its moment is no longer on file");
    else if (!notEnded(f!, ctx.today)) await expire(d, "the moment has passed");
  }
  return { applied, held };
}

// ─── One scan ──────────────────────────────────────────────────────────────────────────────────────────────────────

const sum = (runs: StoredRun[]) => runs.reduce((n, r) => n + (r.cost?.microUsd ?? 0), 0);

/** What a moment held for naming one of her never-use names says (held list and privacy drop alike). */
export const NEVER_TERM_HELD = "uses a name the athlete marked never to use";

/**
 * Never-store moments out of the model's JSON before the run's output is stored (the research privacy rule), and any
 * moment that names one of her never-use names (moments 1.1.0), so neither is ever written to agent_runs.output.
 */
export function sanitizeMoments(json: any, neverTerms: readonly string[] = []): { json: any; dropped: number; drops: PrivacyDrop[] } {
  const list: any[] = Array.isArray(json?.moments) ? json.moments : [];
  const drops: PrivacyDrop[] = [];
  const kept = list.filter((m) => {
    const d = dropReason({ claim: [m?.name, m?.description, m?.why_now].map((x) => String(x ?? "")).join(" "), sensitivity: m?.sensitivity, never_reason: m?.never_reason, source_url: m?.source_url })
      ?? (neverTerms.length && findNeverContent(JSON.stringify(m ?? {}), neverTerms).includes("never_term")
        ? { category: "never_term" as const, reason: NEVER_TERM_HELD, source_url: typeof m?.source_url === "string" && m.source_url ? m.source_url : null }
        : null);
    if (d) drops.push(d);
    return !d;
  });
  return { json: { ...(json ?? {}), moments: kept }, dropped: drops.length, drops };
}

export async function runMomentsScan(req: MomentsScanRequest): Promise<MomentsScanOutcome> {
  const { store, athleteId } = req;
  const now = req.now ?? new Date();

  // A retried step: the finished run is the answer; a finished run that never wrote is applied now (it is paid for).
  const done = req.parentRef ? await store.findCompletedRun(athleteId, req.parentRef) : null;
  if (done && (done.output as MomentsRunOutput | null)?.applied) return { status: "reused", runId: done.id, why: "retried_step" };
  // A first run that handed over to its search retry (moments 1.2.0): the retry's run is the one that writes.
  if (done && (done.output as MomentsRunOutput | null)?.search_guard?.retry_run_id) {
    const retry = await store.findCompletedRun(athleteId, `${req.parentRef}:retry`);
    if (retry && (retry.output as MomentsRunOutput | null)?.applied) return { status: "reused", runId: retry.id, why: "retried_step" };
  }
  const resume = !!done;

  if (!resume) {
    if (req.requireBrief !== false && !(await store.currentBrief(athleteId))) return { status: "skipped", reason: "no_brief" };
    // Budget: room for one more scan's worst case today, this week and in the job.
    const today = await athleteDaySpendMicroUsd(store, athleteId, now);
    if (today + MOMENTS.RUN_RESERVE_MICRO_USD > MOMENTS.DAY_CAP_MICRO_USD) {
      logger.warn({ athleteId, spentMicroUsd: today }, "moments scan skipped: the day's cap would be passed");
      return { status: "skipped", reason: "day_cap" };
    }
    if (req.jobBudget && req.jobBudget.spentMicroUsd + MOMENTS.RUN_RESERVE_MICRO_USD > req.jobBudget.capMicroUsd) {
      logger.warn({ athleteId, spentMicroUsd: req.jobBudget.spentMicroUsd }, "moments scan skipped: the job's cap would be passed");
      return { status: "skipped", reason: "job_cap" };
    }
  }
  const week = sum(await store.listRunsSince(athleteId, { since: new Date(now.getTime() - 7 * DAY).toISOString(), skillId: MOMENTS_SKILL_ID }));
  if (!resume && week + MOMENTS.RUN_RESERVE_MICRO_USD > MOMENTS.WEEK_CAP_MICRO_USD) {
    logger.warn({ athleteId, spentMicroUsd: week }, "moments scan skipped: the week's moments cap would be passed");
    return { status: "skipped", reason: "week_cap" };
  }

  const built = await buildMomentsInput(store, req.sources, athleteId, now);
  const call = (input: string, parentRef: string | null, spentMicroUsd: number) => runSkill({
    store, athleteId, skillId: MOMENTS_SKILL_ID, trigger: req.trigger, parentRef,
    input, schemaName: "moments", schema: MOMENTS_SCHEMA, maxOutputTokens: MOMENTS.MAX_OUTPUT_TOKENS,
    webSearch: { maxCalls: MOMENTS.MAX_SEARCHES, contextSize: "low" }, sanitize: (json) => sanitizeMoments(json, built.guardrails.neverTerms),
    evidenceRead: built.evidence, ...(resume ? {} : { budget: { spentMicroUsd, capMicroUsd: MOMENTS.WEEK_CAP_MICRO_USD } }),
  });
  let r;
  try {
    r = await call(built.input, req.parentRef, week);
  } catch (err) {
    if (err instanceof CostCapError) return { status: "skipped", reason: "week_cap" };
    throw err;
  }
  if (r.cost.microUsd > MOMENTS.RUN_RESERVE_MICRO_USD && !r.reused) {
    logger.warn({ athleteId, runId: r.runId, costUsd: r.cost.microUsd / 1e6, reserveUsd: MOMENTS.RUN_RESERVE_MICRO_USD / 1e6 }, "moments scan cost more than its reserve");
  }

  // The search guard: a scan that searched nothing is retried once, told to search the other kinds first — only while
  // the day's and the week's caps still leave room for a second scan's worst case. A retried step reuses both runs.
  let spent = r.cost.microUsd;
  let retried = false;
  if (searchesOf(r) === 0) {
    const first = r;
    const retryRef = req.parentRef ? `${req.parentRef}:retry` : null;
    const reused = retryRef ? await store.findCompletedRun(athleteId, retryRef) : null;
    const room = !!reused || (
      week + (first.reused ? 0 : first.cost.microUsd) + MOMENTS.RUN_RESERVE_MICRO_USD <= MOMENTS.WEEK_CAP_MICRO_USD
      && (await athleteDaySpendMicroUsd(store, athleteId, now)) + MOMENTS.RUN_RESERVE_MICRO_USD <= MOMENTS.DAY_CAP_MICRO_USD
    );
    if (!room) {
      logger.warn({ athleteId, runId: first.runId }, "moments scan made no search; no retry: a cap would be passed");
    } else {
      try {
        const second = await call(`${SEARCH_FIRST_NOTE}\n\n${built.input}`, retryRef, week + (first.reused ? 0 : first.cost.microUsd));
        // The first run hands over to its retry: the retry's answer is the one applied (and a retried step finds it).
        const out = ((await store.getRun(athleteId, first.runId))?.output ?? {}) as MomentsRunOutput & Record<string, unknown>;
        await store.setRunOutput(athleteId, first.runId, { ...out, search_guard: { searches: 0, retry_run_id: second.runId } });
        r = second;
        retried = true;
        spent += second.cost.microUsd;
      } catch (err) {
        // The retry is a second chance, never a failure of the scan: the first answer stands.
        logger.warn({ athleteId, runId: first.runId, error: String((err as Error)?.message ?? err).slice(0, 200) }, "moments scan retry failed; the first answer is applied");
      }
    }
  }
  const searches = searchesOf(r);
  const note = retried && searches === 0 ? "retried once and still made no web search: the answer rests on the athlete's own facts and deals only" : undefined;
  if (note) logger.warn({ athleteId, runId: r.runId }, `moments scan ${note}`);

  const json = copywriterEnabled() && !r.reused ? await polishMoments(athleteId, r.json, built.guardrails.neverTerms) : r.json;
  const { applied, held } = await applyMoments(store, athleteId, r.runId, json, { ...built, seen: r.sources, now });
  const prior = ((await store.getRun(athleteId, r.runId))?.output ?? {}) as MomentsRunOutput & Record<string, unknown>;
  // What privacy removed before storage is held too — its category only, never its words.
  const privacyHeld = (prior.privacy_drops ?? []).map((d) => ({ what: "(a moment not stored)", reason: d.category === "never_term" ? NEVER_TERM_HELD : `never-store: ${d.category}` }));
  const output: MomentsRunOutput & Record<string, unknown> = {
    ...prior, applied, held: [...privacyHeld, ...held],
    search_guard: { searches, ...(retried ? { retried: true } : {}), ...(note ? { note } : {}) },
  };
  await store.setRunOutput(athleteId, r.runId, output);
  logger.info({
    athleteId, runId: r.runId, trigger: req.trigger, resumed: resume, written: applied.written.length, refreshed: applied.refreshed.length, linked: applied.linked.length,
    retired: applied.retired.length, passed: applied.passed.length, held: output.held!.length, costUsd: spent / 1e6, searches, retried,
  }, "moments scan written");
  return {
    status: "scanned", runId: r.runId, written: applied.written.length, refreshed: applied.refreshed.length, linked: applied.linked.length,
    retired: applied.retired.length, passed: applied.passed.length, held: output.held!.length, costMicroUsd: spent, searches, retried,
  };
}

/**
 * The copy pass (COPYWRITER_V1): the narrator's craft rewrites every moment's angle and hook in one Fable call (+ one
 * editor call, a few cents, outside the scan caps), the scan's own words kept as `idea.original`. A copy of the answer is
 * returned; the run's stored output is the scan's own. Any failure returns the answer unchanged.
 */
export async function polishMoments(athleteId: string, json: any, neverTerms: readonly string[]): Promise<any> {
  const list: any[] = Array.isArray(json?.moments) ? json.moments.slice(0, MOMENTS.MAX_MOMENTS) : [];
  const usable = list.filter((m) => m?.idea?.hook && m?.idea?.angle);
  if (!usable.length) return json;
  const { polishMomentCopy } = await import("../../services/copywriter");
  const out = await polishMomentCopy(athleteId, usable.map((m) => ({
    name: String(m.name ?? ""), date: String(m.date ?? ""), category: String(m.category ?? ""), whyNow: String(m.why_now ?? ""),
    angle: String(m.idea.angle), hook: String(m.idea.hook),
  })), { neverTerms });
  if (!out) return json;
  const polished = new Map(usable.map((m, i) => [m, out[i]]));
  return {
    ...json,
    moments: (json.moments as any[]).map((m) => {
      const p = polished.get(m);
      return p ? { ...m, idea: { ...m.idea, hook: p.picked.hook, angle: p.picked.angle, original: { hook: m.idea.hook, angle: m.idea.angle } } } : m;
    }),
  };
}

/** How many web searches a run made: the provider's count, else the queries it recorded (a reused run keeps both). */
function searchesOf(r: { cost: { webSearchCalls?: number }; queries: string[]; sources: Array<{ url: string }> }): number {
  return Math.max(r.cost.webSearchCalls ?? 0, r.queries.length, r.sources.length ? 1 : 0);
}
