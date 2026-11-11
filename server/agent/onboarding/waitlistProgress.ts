/**
 * agent/onboarding/waitlistProgress.ts — what GET /api/v1/waitlist/progress shows the landing while she waits (the join
 * flow's "Mila arrives" and "Your M.I.A. score" screens; contract: scratchpad joinflow/CONTRACT.md).
 *
 *   research   the state of her sign-up research run: signup_research (the waitlist's agent run), else her
 *              agent_onboarding run (an agent-front sign-up). not_started with neither (a legacy-researched athlete:
 *              the landing reads nothing from legacy research). queued while the daily cap holds it (queuedUntil = the
 *              next UTC midnight, when the day's spend resets), done once the merge has written her facts, failed when
 *              the run failed (an OpenAI outage or an exhausted quota: her waitlist place is untouched).
 *   findings   ONLY her real research facts: found facts about her, active, sourced (an http(s) URL), never a care
 *              (sensitive) fact or a disputed one. The claims are the research's own sentences, which name her (third
 *              person). EMPTY while research could not confirm who she is (a
 *              disputed identity in memory, readMemoryIdentity().uncertain): a namesake's facts are never shown as hers.
 *              Before the merge: each FINISHED search pass's own facts (provisionalFindingsFrom; research
 *              .findingsProvisional), only from a pass that confirmed who she is; the merge's checked facts replace them.
 *              Nothing is written or rephrased here.
 *   score      ONLY the M.I.A. of record from her memory (services/miaPreview readMiaPreview, status ready): the 0–850
 *              score, the four groups (0–100), the evaluator's own confidence, two lines that are the evaluator's own
 *              words (its strengths and constraints notes, else its dimension rationales, else its summary), and one
 *              way to raise it (the preview's first sharpen step), and the ring's bands (each dimension's stored
 *              contribution, as the app's ring draws them). Null until it exists, and null without a new-route
 *              run (never a legacy read here).
 *   quickScore (signup_research v3 only, QUICK_SCORE_ONE_CALL) the one-call web-searched quick score (services/quickScore)
 *              while `score` is still null: its 0–850 value, the four groups, the method's confidence (low when
 *              coverage was thin), its reason lines, and its sources (title + link), which the landing shows as our
 *              own source chips (clickable links). Hidden once the full score exists and while her identity is in dispute.
 *   scoreStage (only on a run that has a quick_score step: signup_research v3/v4, dev only) which score the landing shows
 *              and where the full one is (scoreStageFrom), so the quick → full hand-over is one explicit state:
 *                none   nothing to show yet (or the quick score is hidden: identity disputed, no quick read)
 *                quick  the quick score is shown; the full score is `processing` (or `failed`: the quick one stays)
 *                final  the full score of record is shown; it replaced the quick one when `replacedQuick`
 *              with when each landed (quickAt: the quick_score step's finish; finalAt: the M.I.A. ledger entry's time).
 *              Absent on every other run (v2, agent onboarding): their payload is unchanged.
 *   research.live (v4 runs only: a lean_research step) what the research is doing right now, from the runner's real
 *              rows (liveStatusFrom): finding / reading N pages / pulling facts / checking N facts / scoring /
 *              quick_ready / final_ready, or null when nothing real can be said. Never timed or scripted.
 *
 *   steps     what Mila is doing right now, for the wait screen's live checklist (researchStepsFrom): her web search
 *              (research_a / research_b), reading her Instagram (first_look fetch_social, social_sync
 *              collect_analytics; only when Instagram is connected), checking what she found (research_merge, with the
 *              number of facts it kept once done) and her M.I.A. score (the run's mia_preview step, then her latest
 *              mia_evaluation run's evaluate step). Real step statuses only: nothing is timed or invented.
 *
 * Read-only: no provider call, no write. The caller adds status, rank and connected.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { workflowRuns, workflowSteps } from "../../../shared/schemaWorkflow";
import { connectedAccounts } from "../../../shared/schema";
import { isAboutAthlete, type MemoryFact, type MiaPreview } from "../../../shared/agent";
import { HELD_READY_AT, runnerNow } from "../../workflow/runner";
import { nextUtcMidnight, RESEARCH_WRITTEN_STEPS, SIGNUP_RESEARCH_PROCESS } from "./dailyCap";
import { latestRunOf } from "./signupResearch";
import { dbStore } from "../research/dbStore";
import { checkSource, subjectOf } from "../research/research";
import { isCare, mustNotStore } from "../research/privacy";
import { cleanClaim } from "../factHygiene";

/** "needs_more" is set by GET /waitlist/progress (footprintCheck.ts needsMoreFrom), never by researchStateFrom. */
export type ResearchState = "queued" | "running" | "done" | "failed" | "not_started" | "needs_more";
export type FindingKind = "about" | "results" | "partners" | "press" | "audience";
export interface Finding { kind: FindingKind; text: string; source: { label: string; url: string } }
export interface ProgressScore {
  value: number;
  groups: Array<{ key: "audience" | "brand" | "commercial" | "performance"; label: string; value: number | null }>;
  /** The ring's bands, as the app's ring draws them (client lib/myIntelligenceLogic ringBands): each dimension's stored
   *  contribution (of 100) — a band's length — for the dimensions that have one above zero. Empty when none is stored. */
  bands: Array<{ key: string; contribution: number }>;
  confidence: "low" | "medium" | "high";
  lines: string[];
  raise: { text: string; action: string | null } | null;
}
export type StepStatus = "pending" | "running" | "done" | "failed";
export type ResearchStepKey = "web" | "instagram" | "merge" | "score";
export interface ResearchStep { key: ResearchStepKey; status: StepStatus; count?: number }
export interface WaitlistResearchProgress {
  /** readyEmail: the score-ready email will be (or was) sent when her score lands (signupResearchWorkflow score_email). */
  /** findingsProvisional: the findings are a search pass's own, before the merge has checked them (provisionalFindingsFrom). */
  /** live: what the research is doing now (v4 runs only; liveStatusFrom). */
  research: { state: ResearchState; queuedUntil: string | null; readyEmail: boolean; steps: ResearchStep[]; findingsProvisional?: true; live?: LiveStatus | null };
  findings: Finding[];
  score: ProgressScore | null;
  /** Only on a signup_research v3 run with a ready quick score, while `score` is null (see the header). */
  quickScore?: QuickProgressScore;
  /** Only on a run with a quick_score step (see the header). */
  scoreStage?: ScoreStage;
}

/**
 * What the research is doing right now (signup_research v4 only: runs with a lean_research step), from the runner's
 * real rows — never a timer: the lean step's own stage while it runs (leanResearchStep.ts writes it on its running row:
 * finding → reading N pages → pulling facts → checking N facts), then scoring while the M.I.A. step works, then
 * final_ready once the full score exists. quick_ready when nothing is running but the quick score is on show. Null
 * when nothing real can be said (queued, failed, not started): the landing keeps its state-based line.
 */
export interface LiveStatus { stage: "finding" | "reading" | "pulling" | "checking" | "scoring" | "quick_ready" | "final_ready"; count?: number; at: string | null }
const LEAN_STAGES = new Set(["finding", "reading", "pulling", "checking"]);
export function liveStatusFrom(i: { run: readonly StepRow[]; scoreReady: boolean; scoreStep: StepStatus | null; quickShown: boolean }): LiveStatus | null {
  const run = latestByStep(i.run);
  const lean = run.get("lean_research");
  if (!lean) return null;
  if (i.scoreReady) return { stage: "final_ready", at: null };
  if (lean.status === "running") {
    const p = (lean.output as { progress?: { stage?: unknown; count?: unknown; at?: unknown } } | null | undefined)?.progress;
    if (p && typeof p.stage === "string" && LEAN_STAGES.has(p.stage)) {
      return { stage: p.stage as LiveStatus["stage"], ...(typeof p.count === "number" && p.count >= 0 ? { count: Math.round(p.count) } : {}), at: typeof p.at === "string" ? p.at : null };
    }
    return { stage: "finding", at: null };
  }
  if (lean.status === "done" && (i.scoreStep === "running" || i.scoreStep === "pending")) return { stage: "scoring", at: null };
  return i.quickShown ? { stage: "quick_ready", at: null } : null;
}

/** The quick → full hand-over as one state (see the header). */
export interface ScoreStage {
  stage: "none" | "quick" | "final";
  /** The full score: still being worked out, ready, or ended without one (the checklist's "score" line failed). */
  full: "processing" | "ready" | "failed";
  /** True once the full score is shown on a run whose quick score was ready: it replaced the quick one. */
  replacedQuick: boolean;
  quickAt: string | null;
  finalAt: string | null;
}

/**
 * Pure: the score stage. `quick` is the quick card the landing may show (already null when hidden), `quickReady` whether
 * the run's quick score was ever ready to show (identity aside — a disputed identity never has a full score either),
 * `scoreStep` the checklist's score line.
 */
export function scoreStageFrom(i: { score: ProgressScore | null; quick: QuickProgressScore | null; quickReady: boolean; scoreStep: StepStatus | null; quickAt: Date | null; finalAt: Date | null }): ScoreStage {
  const full: ScoreStage["full"] = i.score ? "ready" : i.scoreStep === "failed" ? "failed" : "processing";
  const stage: ScoreStage["stage"] = i.score ? "final" : i.quick ? "quick" : "none";
  return {
    stage, full,
    replacedQuick: stage === "final" && i.quickReady,
    quickAt: i.quickReady && i.quickAt ? i.quickAt.toISOString() : null,
    finalAt: i.score && i.finalAt ? i.finalAt.toISOString() : null,
  };
}

/** The quick score card: ProgressScore's shape (so the landing paints it the same way) plus its sources. */
export interface QuickProgressScore extends ProgressScore {
  quick: true;
  lowConfidence: boolean;
  /** The sources the read drew on (title + http(s) link): the landing shows them as our own source chips. */
  sources: Array<{ title: string; url: string }>;
}

const QUICK_GROUPS: Array<{ key: ProgressScore["groups"][number]["key"]; label: string; dims: [string, string] }> = [
  { key: "audience", label: "Audience", dims: ["audience_scale", "engagement_quality"] },
  { key: "commercial", label: "Commercial", dims: ["commercial_proof", "brand_fit"] },
  { key: "brand", label: "Brand", dims: ["narrative_power", "cultural_relevance"] },
  { key: "performance", label: "Performance", dims: ["athletic_authority", "momentum"] },
];

/**
 * Pure: the quick score card from the quick_score step's output, or null (not ready, a fallback, withheld for identity,
 * The lines are the method's own words; nothing is rephrased or filled in.
 */
export function quickScoreFrom(output: unknown): QuickProgressScore | null {
  const o = (output ?? {}) as Record<string, any>;
  if (o.status !== "ready" || typeof o.score !== "number" || !Number.isFinite(o.score)) return null;
  const dims: Array<{ key: string; score: number; weight: number; contribution: number }> = Array.isArray(o.dimensions) ? o.dimensions : [];
  const groups = QUICK_GROUPS.map((g) => {
    const ds = dims.filter((d) => g.dims.includes(d.key) && typeof d.score === "number" && typeof d.weight === "number" && d.weight > 0);
    const w = ds.reduce((s, d) => s + d.weight, 0);
    return { key: g.key, label: g.label, value: w > 0 ? Math.max(0, Math.min(100, Math.round(ds.reduce((s, d) => s + d.score * d.weight, 0) / w))) : null };
  });
  const display = (o.display ?? {}) as { sources?: Array<{ uri?: string; title?: string }> };
  const sources = (display.sources ?? []).flatMap((s) => { const url = httpUrl(s?.uri); return url ? [{ title: labelOf(s?.title, url), url }] : []; });
  const lines = (Array.isArray(o.reasons) ? o.reasons : []).map((r: unknown) => plainLine(typeof r === "string" ? r : null)).filter((l: string | null): l is string => !!l).slice(0, 2);
  return {
    quick: true,
    value: Math.max(0, Math.min(850, Math.round(o.score))),
    groups,
    bands: dims.flatMap((d) => (typeof d.contribution === "number" && Number.isFinite(d.contribution) && d.contribution > 0 ? [{ key: d.key, contribution: Math.round(Math.min(100, d.contribution) * 10) / 10 }] : [])),
    confidence: o.confidence === "high" || o.confidence === "medium" ? o.confidence : "low",
    lowConfidence: o.low_confidence === true || !(o.confidence === "high" || o.confidence === "medium"),
    lines,
    raise: null,
    sources,
  };
}

/**
 * Her run's quick score: `ready` when the step produced one the landing may show; `card` only while
 * it is to be shown — the full score has not landed and her identity is not in dispute (`hide`, checked lazily: the
 * identity read runs only when there is a quick score to hide). `has` is whether the run has a quick_score step at all.
 */
async function quickScoreOf(steps: readonly StepRow[], hide: () => Promise<boolean>): Promise<{ has: boolean; ready: boolean; card: QuickProgressScore | null; at: Date | null }> {
  const step = latestByStep(steps).get("quick_score");
  if (!step) return { has: false, ready: false, card: null, at: null };
  if (step.status !== "done") return { has: true, ready: false, card: null, at: null };
  const card = quickScoreFrom(step.output);
  const at = step.finished_at ?? null;
  if (!card) return { has: true, ready: false, card: null, at };
  return { has: true, ready: true, card: (await hide()) ? null : card, at };
}

/** When her full score of record was written: its M.I.A. ledger entry's time (null when it cannot be read). */
async function finalScoreAt(ledgerEntryId: string | null | undefined): Promise<Date | null> {
  if (!ledgerEntryId) return null;
  const { intelligenceLedger } = await import("../../../shared/schema");
  const [row] = await db.select({ at: intelligenceLedger.created_at }).from(intelligenceLedger).where(eq(intelligenceLedger.id, ledgerEntryId)).limit(1).catch(() => []);
  return row?.at ?? null;
}

/** The research topic (research/schemas.ts FACT_TOPICS) → the landing's finding kind. A topic not listed is not shown. */
const KIND_OF_TOPIC: Record<string, FindingKind> = {
  identity: "about", career: "about", team: "about", education: "about", story: "about", status: "about", cause: "about",
  competition: "results", achievement: "results", stats: "results", upcoming: "results", event: "results",
  sponsor: "partners", business: "partners", commerce: "partners",
  media: "press", reputation: "press", conversation: "press",
  social: "audience", audience_growth: "audience", engagement: "audience", demographics: "audience", search_trend: "audience",
};
const KIND_ORDER: FindingKind[] = ["about", "results", "partners", "press", "audience"];
export const MAX_FINDINGS = 12;
/** A finding's text is web-derived: at most this many characters reach the page (cut at a word, with an ellipsis). */
export const MAX_FINDING_TEXT = 300;
/** A source URL longer than this is not shown (a cut URL would point somewhere else): the finding is left out. */
export const MAX_SOURCE_URL = 2048;

const httpUrl = (u: string | undefined): string | null => {
  if (!u) return null;
  try {
    const url = new URL(u);
    const s = url.toString();
    return (url.protocol === "https:" || url.protocol === "http:") && s.length <= MAX_SOURCE_URL ? s : null;
  } catch { return null; }
};
const capText = (t: string): string => {
  if (t.length <= MAX_FINDING_TEXT) return t;
  const cut = t.slice(0, MAX_FINDING_TEXT - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > MAX_FINDING_TEXT * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
};
const labelOf = (title: string | undefined, url: string): string => {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  if (t) return t.slice(0, 80);
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url.slice(0, 80); }
};

/** Pure: her shareable findings, a few of each kind in turn, most confident (then newest) first. */
export function findingsFrom(facts: MemoryFact[], athleteName: string): Finding[] {
  const byKind = new Map<FindingKind, Array<MemoryFact & { url: string }>>();
  for (const f of facts) {
    if (f.type !== "found" || f.status !== "active" || f.sensitive) continue;
    const kind = f.topic ? KIND_OF_TOPIC[f.topic] : undefined;
    const url = httpUrl(f.source?.url);
    if (!kind || !url || !f.claim?.trim()) continue;
    if (!isAboutAthlete(f.subject, athleteName)) continue;
    const list = byKind.get(kind) ?? [];
    list.push({ ...f, url });
    byKind.set(kind, list);
  }
  for (const list of byKind.values()) list.sort((a, b) => b.confidence - a.confidence || (b.date ?? "").localeCompare(a.date ?? ""));
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < MAX_FINDINGS; i++) {
    let any = false;
    for (const kind of KIND_ORDER) {
      const f = byKind.get(kind)?.[i];
      if (!f || out.length >= MAX_FINDINGS) continue;
      any = true;
      const text = capText(f.claim.replace(/\s+/g, " ").trim());
      if (seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      out.push({ kind, text, source: { label: labelOf(f.source.title, f.url), url: f.url } });
    }
    if (!any) break;
  }
  return out;
}

/**
 * Pure: findings from the search passes that have FINISHED, before the merge (the wait screen's early facts). The same
 * rules as the merge's input (research.ts searchPass) and as findingsFrom: a pass that could not confirm who she is
 * shows nothing (a namesake's facts are never shown as hers); never a care fact or one that must not be stored; only a
 * source the pass actually saw; only facts about her. Once the merge is done the checked facts replace these.
 */
export function provisionalFindingsFrom(passes: Array<{ json: any; sources: Array<{ url: string; title?: string }> }>, athleteName: string): Finding[] {
  const facts: MemoryFact[] = [];
  for (const p of passes) {
    if (p.json?.identity?.resolved !== true) continue;
    for (const f of Array.isArray(p.json?.facts) ? p.json.facts : []) {
      const claim = typeof f?.claim === "string" ? cleanClaim(f.claim) : "";
      if (!claim || mustNotStore(f) || isCare(f)) continue;
      const src = checkSource(String(f.source_url ?? ""), p.sources ?? []);
      if (!src.ok) continue;
      const topic = String(f.topic ?? "");
      const subject = subjectOf(f, { name: athleteName, sport: "" }, claim, topic);
      if ("reason" in subject) continue;
      facts.push({
        type: "found", status: "active", sensitive: false, topic, claim, subject, date: typeof f.date === "string" ? f.date : null,
        confidence: typeof f.confidence === "number" ? f.confidence * src.factor : 0.5, source: { url: src.url, title: String(f.source_title ?? "") },
      } as unknown as MemoryFact);
    }
  }
  return findingsFrom(facts, athleteName);
}

/** The finished passes' agent runs (their stored answers), read for provisionalFindingsFrom. */
async function provisionalFindings(athleteId: string, steps: readonly StepRow[], athleteName: string): Promise<Finding[]> {
  const done = [...latestByStep(steps).values()].filter((s) => (s.step === "research_a" || s.step === "research_b") && s.status === "done");
  const passes: Array<{ json: any; sources: Array<{ url: string; title?: string }> }> = [];
  for (const s of done) {
    const runId = (s.output as { run_id?: unknown } | null | undefined)?.run_id;
    if (typeof runId !== "string") continue;
    const run = await dbStore.getRun(athleteId, runId).catch(() => null);
    const out = (run?.output ?? null) as { json?: unknown; sources?: Array<{ url: string; title?: string }> } | null;
    if (out?.json) passes.push({ json: out.json, sources: out.sources ?? [] });
  }
  return passes.length ? provisionalFindingsFrom(passes, athleteName) : [];
}

/** A line short enough for a card: whole sentences up to ~200 characters, else cut at a word. */
export function plainLine(s: string | null | undefined, max = 200): string | null {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (t.length <= max) return t;
  const sentences = t.match(/[^.!?]+[.!?]+/g) ?? [];
  let acc = "";
  for (const x of sentences) { if ((acc + x).trim().length > max) break; acc += x; }
  if (acc.trim()) return acc.trim();
  return `${t.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

const CONFIDENCE: Record<string, ProgressScore["confidence"]> = { HIGH: "high", MEDIUM: "medium", LOW: "low" };

/** Pure: the landing's score card from a ready M.I.A. preview, or null. Every word is the evaluator's, except `raise`'s connect sentence. */
export function scoreFrom(p: MiaPreview | null): ProgressScore | null {
  if (!p || p.status !== "ready" || typeof p.score !== "number" || !Number.isFinite(p.score)) return null;
  const a = p.assessment;
  const dims = a?.dimensions ?? [];
  const candidates = [
    a?.notes?.strengths?.[0], a?.notes?.constraints?.[0],
    dims.find((d) => d.state === "strength")?.rationale, dims.find((d) => d.state === "gap")?.rationale,
    a?.summary,
  ];
  const lines: string[] = [];
  for (const c of candidates) {
    const l = plainLine(c);
    if (l && !lines.some((x) => x.toLowerCase() === l.toLowerCase())) lines.push(l);
    if (lines.length === 2) break;
  }
  const connect = [...p.sharpen].filter((s) => s.kind === "connect").sort((x, y) => Number(y.connector === "instagram") - Number(x.connector === "instagram"))[0];
  const evidence = p.sharpen.find((s) => s.kind === "evidence");
  const raise = connect && connect.kind === "connect"
    ? { text: `Connect your ${connect.service} so your real audience numbers count.`, action: `connect_${connect.connector}` }
    : evidence && evidence.kind === "evidence" && plainLine(evidence.text) ? { text: plainLine(evidence.text)!, action: null } : null;
  return {
    value: Math.max(0, Math.min(850, Math.round(p.score))),
    groups: p.groups.map((g) => ({ key: g.key, label: g.name, value: typeof g.score === "number" ? Math.max(0, Math.min(100, Math.round(g.score))) : null })),
    bands: dims.flatMap((d) => (typeof d.contribution === "number" && Number.isFinite(d.contribution) && d.contribution > 0 ? [{ key: d.key, contribution: Math.round(Math.min(100, d.contribution) * 10) / 10 }] : [])),
    confidence: CONFIDENCE[p.confidence.level ?? ""] ?? "low",
    lines,
    raise,
  };
}

/** Pure: the research state from her run and its step rows. */
export function researchStateFrom(run: { status: string } | null, steps: Array<{ step: string; status: string; ready_at: Date }>, now: Date): { state: ResearchState; queuedUntil: string | null } {
  if (!run) return { state: "not_started", queuedUntil: null };
  if (steps.some((s) => (RESEARCH_WRITTEN_STEPS as readonly string[]).includes(s.step) && s.status === "done")) return { state: "done", queuedUntil: null };
  if (run.status === "failed" || run.status === "canceled") return { state: "failed", queuedUntil: null };
  // Queued only when every open step is held (a held step beside a sibling still running is still "running").
  const heldStep = (s: { status: string; ready_at: Date }) => s.status === "ready" && s.ready_at.getTime() >= HELD_READY_AT.getTime();
  const openNow = steps.some((s) => s.status === "running" || (s.status === "ready" && !heldStep(s)));
  if (!openNow && steps.some(heldStep)) return { state: "queued", queuedUntil: nextUtcMidnight(now).toISOString() };
  return { state: "running", queuedUntil: null };
}

type StepRow = { step: string; status: string; attempt?: number | null; output?: unknown; finished_at?: Date | null };

/** One workflow step row's status as the checklist reads it: queued (ready, held or not) is pending; waiting is running. */
function rowStatus(r: StepRow | undefined): StepStatus | null {
  if (!r) return null;
  if (r.status === "done" || r.status === "skipped") return "done";
  if (r.status === "failed") return "failed";
  if (r.status === "running" || r.status === "waiting") return "running";
  return "pending";
}
/** The latest attempt of each step, by name. */
function latestByStep(rows: readonly StepRow[]): Map<string, StepRow> {
  const out = new Map<string, StepRow>();
  for (const r of rows) { const p = out.get(r.step); if (!p || (r.attempt ?? 1) >= (p.attempt ?? 1)) out.set(r.step, r); }
  return out;
}
/** Several steps as one line: all done ⇒ done; any running (or some done, some not) ⇒ running; any failed ⇒ failed. */
function combined(statuses: Array<StepStatus | null>): StepStatus | null {
  const xs = statuses.filter((x): x is StepStatus => x !== null);
  if (!xs.length) return null;
  if (xs.every((x) => x === "done")) return "done";
  if (xs.some((x) => x === "running")) return "running";
  if (xs.some((x) => x === "failed")) return "failed";
  return xs.some((x) => x === "done") ? "running" : "pending";
}

/**
 * Pure: the wait screen's checklist from real step rows. `run` = her sign-up research run's steps (research_a/b,
 * research_merge, mia_preview); `instagram` = the steps that read her connected Instagram (null when it is not
 * connected: the line is left out); `evaluation` = her latest mia_evaluation run (its status and steps), for a score
 * the mia_preview step left in flight. A score that is ready is done whatever the rows say; a score step that ended
 * without one (failed, or held) is failed — the only state the landing words as "I'll try again later".
 */
export function researchStepsFrom(i: {
  run: readonly StepRow[];
  instagram: readonly StepRow[] | null;
  evaluation: { status: string; steps: readonly StepRow[] } | null;
  scoreReady: boolean;
}): ResearchStep[] {
  const run = latestByStep(i.run);
  const out: ResearchStep[] = [];
  // signup_research v4: ONE lean_research step searches, reads and keeps her facts — it is both the web line and the
  // "checking what I found" line (its output's `inserted` is the count kept).
  const lean = run.get("lean_research");
  out.push({ key: "web", status: lean ? rowStatus(lean) ?? "pending" : combined([rowStatus(run.get("research_a")), rowStatus(run.get("research_b"))]) ?? "pending" });
  if (i.instagram) {
    const ig = latestByStep(i.instagram);
    const st = combined([rowStatus(ig.get("fetch_social")), rowStatus(ig.get("collect_analytics"))]);
    if (st) out.push({ key: "instagram", status: st });
  }
  const merge = lean ?? run.get("research_merge");
  const mergeStatus = rowStatus(merge) ?? "pending";
  const kept = (merge?.output as { inserted?: unknown } | null | undefined)?.inserted;
  out.push({ key: "merge", status: mergeStatus, ...(mergeStatus === "done" && typeof kept === "number" ? { count: kept } : {}) });
  out.push({ key: "score", status: i.scoreReady ? "done" : scoreStatus(run.get("mia_preview"), i.evaluation) });
  return out;
}
function scoreStatus(step: StepRow | undefined, evaluation: { status: string; steps: readonly StepRow[] } | null): StepStatus {
  const st = rowStatus(step);
  if (!st || st === "pending" || st === "running" || st === "failed") return st ?? "pending";
  // The step is done but the score is not ready: in flight (the evaluation is still running) or it ended without one.
  const o = (step!.output ?? {}) as { status?: string; computed?: string | null };
  if (o.computed === "in_flight" && evaluation) {
    if (evaluation.status === "failed" || evaluation.status === "canceled") return "failed";
    const ev = rowStatus(latestByStep(evaluation.steps).get("evaluate"));
    return ev === "failed" ? "failed" : "running";
  }
  if (o.computed === "in_flight") return "running";
  return "failed";
}

/** Her sign-up research progress: the research state, her findings and her M.I.A. score. */
/**
 * Whether the score-ready email will be (or was) sent: her run is a signup_research run that has the email step
 * (v2+) and was not canceled or failed, this deployment can send (scoreEmailEnabled), she has an address and is still
 * waitlisted, and the step has not already finished without sending.
 */
export function readyEmailFrom(run: { process: string; definition_version: number; status: string } | null, steps: Array<{ step: string; status: string; output?: unknown }>,
  athlete: { email: string | null; status: string | null }, enabled: boolean): boolean {
  if (!run || run.process !== SIGNUP_RESEARCH_PROCESS || run.definition_version < 2 || run.status === "canceled" || run.status === "failed") return false;
  if (!enabled || !athlete.email || athlete.status !== "waitlisted") return false;
  const done = steps.find((s) => s.step === "score_email" && s.status === "done");
  return !done || (done.output as { sent?: boolean } | null)?.sent === true;
}

export async function waitlistResearchProgress(athleteId: string, athleteName: string, now: Date = runnerNow(), athlete: { email: string | null; status: string | null } = { email: null, status: null }): Promise<WaitlistResearchProgress> {
  const run = (await latestRunOf(athleteId, SIGNUP_RESEARCH_PROCESS)) ?? (await latestRunOf(athleteId, "agent_onboarding"));
  const steps = run ? await db.select({ step: workflowSteps.step, status: workflowSteps.status, ready_at: workflowSteps.ready_at, output: workflowSteps.output, attempt: workflowSteps.attempt, finished_at: workflowSteps.finished_at }).from(workflowSteps).where(eq(workflowSteps.run_id, run.id)) : [];
  const { scoreEmailEnabled } = await import("../../services/notify/templates/waitlist");
  const base = { ...researchStateFrom(run, steps, now), readyEmail: readyEmailFrom(run, steps, athlete, scoreEmailEnabled()) };
  const live = (scoreReady: boolean) => (run ? liveSteps(athleteId, steps, scoreReady) : Promise.resolve([] as ResearchStep[]));
  const name = ((run?.input as { name?: unknown } | null)?.name as string | undefined) || athleteName;
  const { readMemoryIdentity } = await import("../../services/miaPreview/memoryAdapter");
  // A quick score and the stage that says which score is on show (runs with a quick_score step only; see the header).
  const withQuick = (quick: Awaited<ReturnType<typeof quickScoreOf>>, score: ProgressScore | null, researchSteps: ResearchStep[], finalAt: Date | null) => ({
    ...(quick.card ? { quickScore: quick.card } : {}),
    ...(quick.has ? { scoreStage: scoreStageFrom({ score, quick: quick.card, quickReady: quick.ready, scoreStep: researchSteps.find((s) => s.key === "score")?.status ?? null, quickAt: quick.at, finalAt }) } : {}),
  });
  // The live status line, on v4 runs only (a lean_research step): the key is absent on every other run.
  const liveOf = (researchSteps: ResearchStep[], scoreReady: boolean, quickShown: boolean) => (steps.some((s) => s.step === "lean_research")
    ? { live: liveStatusFrom({ run: steps, scoreReady, scoreStep: researchSteps.find((s) => s.key === "score")?.status ?? null, quickShown }) }
    : {});
  if (base.state !== "done") {
    // Before the merge: the facts of each search pass that has finished, so the wait screen fills minutes sooner.
    const early = base.state === "running" ? await provisionalFindings(athleteId, steps, name) : [];
    // Never a quick score while her identity is in dispute, before the merge too (a re-run over disputed memory).
    const quick = await quickScoreOf(steps, async () => (await readMemoryIdentity(athleteId)).uncertain);
    const researchSteps = await live(false);
    return { research: { ...base, steps: researchSteps, ...(early.length ? { findingsProvisional: true as const } : {}), ...liveOf(researchSteps, false, !!quick.card) }, findings: early, score: null, ...withQuick(quick, null, researchSteps, null) };
  }
  const identity = await readMemoryIdentity(athleteId);
  const findings = identity.uncertain ? [] : findingsFrom(await dbStore.listFacts(athleteId, ["active"]), name);
  const { readMiaPreview } = await import("../../services/miaPreview/preview");
  const preview = await readMiaPreview(athleteId);
  const score = scoreFrom(preview);
  const quick = await quickScoreOf(steps, async () => !!score || identity.uncertain);
  const researchSteps = await live(!!score);
  const finalAt = score && quick.has ? await finalScoreAt(preview?.provenance?.ledgerEntryId) : null;
  return { research: { ...base, steps: researchSteps, ...liveOf(researchSteps, !!score, !!quick.card) }, findings, score, ...withQuick(quick, score, researchSteps, finalAt) };
}

/** The checklist's other rows: her Instagram read (when connected) and her latest M.I.A. evaluation. */
async function liveSteps(athleteId: string, run: readonly StepRow[], scoreReady: boolean): Promise<ResearchStep[]> {
  const stepsOf = async (runId: string) => db.select({ step: workflowSteps.step, status: workflowSteps.status, attempt: workflowSteps.attempt }).from(workflowSteps).where(eq(workflowSteps.run_id, runId));
  const latest = async (process: string, extra?: ReturnType<typeof sql>) => (await db.select({ id: workflowRuns.id, status: workflowRuns.status }).from(workflowRuns)
    .where(and(eq(workflowRuns.athlete_id, athleteId), eq(workflowRuns.process, process), ...(extra ? [extra] : []))).orderBy(desc(workflowRuns.started_at)).limit(1))[0] ?? null;
  const [ig] = await db.select({ id: connectedAccounts.id }).from(connectedAccounts)
    .where(and(eq(connectedAccounts.athlete_id, athleteId), eq(connectedAccounts.platform, "instagram"), eq(connectedAccounts.status, "active"))).limit(1);
  let instagram: StepRow[] | null = null;
  if (ig) {
    const look = await latest("first_look", sql`${workflowRuns.input}->>'platform' = 'instagram'`);
    const sync = await latest("social_sync");
    instagram = [...(look ? await stepsOf(look.id) : []), ...(sync ? (await stepsOf(sync.id)).filter((r) => r.step === "collect_analytics") : [])];
  }
  const ev = await latest("mia_evaluation");
  const evaluation = ev ? { status: ev.status, steps: await stepsOf(ev.id) } : null;
  return researchStepsFrom({ run, instagram, evaluation, scoreReady });
}

/** Her active connected accounts' platforms, distinct, in a stable order. */
export async function connectedPlatformsOf(athleteId: string): Promise<string[]> {
  const rows = await db.selectDistinct({ platform: connectedAccounts.platform }).from(connectedAccounts)
    .where(and(eq(connectedAccounts.athlete_id, athleteId), eq(connectedAccounts.status, "active"), sql`${connectedAccounts.platform} IS NOT NULL`));
  return rows.map((r) => r.platform).sort();
}
