/**
 * agent/onboarding/service.ts — what the onboarding API does. Every function takes the athlete id from the session
 * (never from the request body) and every read and write is scoped to it.
 *
 *   start        name + sport → said facts, the name_sport checkpoint, and the durable workflow (research runs in the
 *                background; the API returns at once)
 *   state        where it is: progress card while research runs, the conversation so far (messages + cards), the
 *                checkpoints, done or not — resumable from any device at any point
 *   turn         the athlete's message and/or taps → one adaptive turn (turn.ts); completes the workflow's
 *                conversation step when the last checkpoint is met
 *   facts        the facts for review, each with its sources and the run that produced it
 *   brief        the Brief as the athlete sees it (never the internal read)
 *   how          "How I got this" for a run or a fact: sources, searches, the facts used, the trace
 */
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { athletes } from "../../../shared/schema";
import { FACT_SUBJECT_FILTERS, isAboutAthlete, type CardSource, type ChatCard, type FactSubjectFilter, type HowIGotThisCardPayload, type MemoryFact, type ProgressCardPayload, type ResearchEvent } from "../../../shared/agent";
import { createLogger } from "../../logger";
import { activeRunFor, completeStep, getRun, kick, listRuns } from "../../workflow/runner";
import { dbStore } from "../research/dbStore";
import { loadConnectedChannels, measuredFactsFrom } from "../research/connected";
import { syncMeasured } from "../research/research";
import type { CheckpointState } from "../research/store";
import { connectedPlatforms } from "./connections";
import { allDone, turnPrefix, type AthleteAction, type TurnRecord } from "./turn";
import { onboardingTurnFn } from "./milaTurn";
import { AGENT_ONBOARDING_PROCESS, onboardingCostCapMicroUsd, parentPrefixFor } from "./workflow";
import { researchQueueState } from "./dailyCap";
import { startSignupResearchRun } from "./signupResearch";

const logger = createLogger("agent/onboarding");

export class OnboardingError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

const clean = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** At most this many sports (the main one and the others). */
export const MAX_SPORTS = 8;

/**
 * The sports the athlete gave, main first: `sports` (the sport grid: main then the others, in the order picked) or the
 * single `sport` (the first screen before the grid). Cleaned, de-duplicated ignoring case, capped.
 */
export function sportsFrom(body: { sport?: unknown; sports?: unknown }): string[] {
  if (body.sports != null && !Array.isArray(body.sports)) throw new OnboardingError("sports must be a list", 400, "invalid");
  const raw = Array.isArray(body.sports) ? body.sports : [body.sport];
  if (raw.length > MAX_SPORTS) throw new OnboardingError(`at most ${MAX_SPORTS} sports`, 400, "invalid");
  const out: string[] = [];
  for (const s of raw) {
    const v = clean(s, 80);
    if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
}

export async function startOnboarding(athleteId: string, body: { name?: unknown; sport?: unknown; sports?: unknown; optIn?: unknown }) {
  const name = clean(body.name, 120);
  const sports = sportsFrom(body);
  const sport = sports[0] ?? "";
  if (!name || !sport) throw new OnboardingError("name and sport are required", 400, "invalid");
  const existing = await activeRunFor(athleteId, AGENT_ONBOARDING_PROCESS);
  if (existing) return { runId: existing.run.id, created: false };

  // The main sport fills an empty column (athletes.sport stays THE main sport for every reader); the others go to
  // other_sports (0122), never repeating the main one. Everything is recorded as what the athlete told us.
  const [row] = await db.select({ sport: athletes.sport, required: athletes.agent_onboarding_required }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!row) throw new OnboardingError("athlete not found", 404, "not_found");
  const main = row.sport?.trim() || sport;
  const others = sports.filter((s) => s.toLowerCase() !== main.toLowerCase());
  // An existing athlete who asks for this (the "Meet Mila" entry, optIn: true) is recorded as having opted in, so a
  // canceled/abandoned run still reopens the conversation on the next launch rather than silently dropping her back
  // into today's app. Never set false here — only signup (server/routes/auth.ts) decides the default.
  const optedIn = body.optIn === true && !row.required;
  const patch = { ...(row.sport?.trim() ? {} : { sport }), ...(sports.length > 1 ? { other_sports: others } : {}), ...(optedIn ? { agent_onboarding_required: true } : {}) };
  if (Object.keys(patch).length) await db.update(athletes).set(patch).where(eq(athletes.id, athleteId));

  // The daily cap on sign-up research (dailyCap.ts, DAILY_RESEARCH_CAP_USD): a new sign-up past the day's budget still
  // gets her run, her said facts and her name_sport checkpoint below, but the research is QUEUED (held), never kicked;
  // the minute tick starts it when there is budget again. An existing athlete's "Meet Mila" opt-in is not a sign-up.
  // The decision is the one sign-up research chokepoint's (signupResearch.ts), shared with every other sign-up route.
  const { run, created, queued: queue } = await startSignupResearchRun({ process: AGENT_ONBOARDING_PROCESS, athleteId, input: { name, sport, ...(sports.length > 1 ? { sports } : {}), ...(body.optIn === true ? { optIn: true } : {}) }, createdBy: "athlete", kick: false }, { capped: body.optIn !== true });
  if (created) {
    const today = new Date().toISOString().slice(0, 10);
    const said = (claim: string, ref: string) => ({ subject: { kind: "athlete" as const, name }, claim, type: "said" as const, source: { ref: `onboarding/${run.id}#${ref}`, title: "You told us" }, date: today, confidence: 1, runId: null });
    // A sign-up research (the waitlist's agent run) may already have recorded the same words: never twice.
    const known = new Set((await dbStore.listFacts(athleteId, ["active"])).filter((f) => f.type === "said").map((f) => f.claim.trim().toLowerCase()));
    await dbStore.insertFacts(athleteId, [
      said(`The athlete's name is ${name}.`, "name"),
      said(sports.length > 1 ? `${name}'s main sport is ${sport}.` : `${name}'s sport is ${sport}.`, "sport"),
      ...sports.slice(1).map((s, i) => said(`${name} also plays ${s}.`, `sport:${i + 2}`)),
    ].filter((f) => !known.has(f.claim.trim().toLowerCase())));
    await dbStore.setCheckpoint(athleteId, run.id, "name_sport", { status: "done" });
    // Research runs in the background; the minute tick picks it up if this process stops. A queued one waits for the tick.
    if (queue) logger.info({ athleteId, runId: run.id }, "agent onboarding: research queued by the daily cap");
    else void kick(run.id).catch((err) => logger.warn({ athleteId, runId: run.id, error: String(err?.message ?? err).slice(0, 200) }, "agent onboarding: kick failed (the tick will retry)"));
  }
  return { runId: run.id, created, ...(created ? { researchQueued: queue } : {}) };
}

/** The athlete's current (active, else latest) onboarding run. */
/**
 * Whether this conversation is OPTIONAL for the athlete — they can always leave it, and a launch never holds them on it.
 * True for a run started from the "Meet Mila" opt-in (input.optIn), and for any athlete who already finished an
 * earlier onboarding (the legacy `onboarding` process done). Only a genuinely new sign-up is held on the conversation.
 * Fails open (true) on a read error: a broken lookup must never lock an athlete out of the app.
 */
async function onboardingOptional(athleteId: string, run: { input?: unknown }): Promise<boolean> {
  if ((run.input as { optIn?: unknown } | null | undefined)?.optIn === true) return true;
  try {
    const earlier = await listRuns({ athleteId, process: "onboarding", status: "done", limit: 1 });
    return earlier.length > 0;
  } catch (err) {
    logger.warn({ athleteId, error: String((err as any)?.message ?? err).slice(0, 200) }, "agent onboarding: optional lookup failed (failing open)");
    return true;
  }
}

async function currentRun(athleteId: string) {
  const active = await activeRunFor(athleteId, AGENT_ONBOARDING_PROCESS);
  if (active) return active.run;
  const [latest] = await listRuns({ athleteId, process: AGENT_ONBOARDING_PROCESS, limit: 1 });
  return latest ?? null;
}

/**
 * Whether a fresh launch (no agent_onboarding run yet) should still land on Mila's conversation.
 *
 * Existing athletes — everyone who signed up before the agent onboarding front existed, and everyone who signs up
 * through any OTHER path (Microsoft, waitlist promotion, admin, claiming a pre-seeded profile) — never had this
 * column set true, so they count as done without ever running the workflow: a fresh launch opens straight into the
 * app. Only two things turn it on: the new agent front at signup (body.front === "agent", server/routes/auth.ts),
 * or an explicit later opt-in (POST /agent/onboarding/start, optIn: true — see startOnboarding). An athlete who has
 * since removed or never had this flag but ALREADY STARTED a run is read from the run above, never from here.
 *
 * Fails open (false ⇒ not required) on a missing row or a read error: a broken lookup must never force onboarding
 * on someone who should go straight into the app.
 */
async function agentOnboardingRequired(athleteId: string): Promise<boolean> {
  try {
    const [row] = await db.select({ required: athletes.agent_onboarding_required }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
    return row?.required ?? false;
  } catch (err) {
    logger.warn({ athleteId, error: String((err as any)?.message ?? err).slice(0, 200) }, "agent onboarding: required lookup failed (failing open)");
    return false;
  }
}

/** The progress card until the reveal; the two passes run in parallel and each reports its own state. */
const PROGRESS: Array<{ steps: string[]; label: string }> = [
  { steps: ["research_a", "research_b"], label: "Searching the web for you" },
  { steps: ["research_merge"], label: "Checking what I found" },
  { steps: ["opening"], label: "Getting your highlights ready" },
];
const PASS_LABELS: Record<string, string> = { research_a: "Your career, results and press", research_b: "Your audience, brand and community" };

/** Per-pass progress events (each pass: ready | running | done | failed). */
export function passesFrom(steps: Array<{ step: string; status: string }>) {
  return Object.entries(PASS_LABELS).map(([step, label]) => {
    const mine = steps.filter((s) => s.step === step);
    const status = mine.some((s) => s.status === "done") ? "done" : mine.some((s) => s.status === "running") ? "running" : mine.some((s) => s.status === "failed") && !mine.some((s) => s.status === "ready") ? "failed" : "waiting";
    return { step, label, status };
  });
}

export function progressFrom(steps: Array<{ step: string; status: string }>): ProgressCardPayload {
  const done = (names: string[]) => names.every((n) => steps.some((s) => s.step === n && s.status === "done"));
  const failed = steps.some((s) => s.status === "failed") && !steps.some((s) => s.status === "running" || s.status === "ready");
  let i = PROGRESS.findIndex((p) => !done(p.steps));
  if (i === -1) return { step: PROGRESS.length, of: PROGRESS.length, label: "Ready", state: "done" };
  return { step: i + 1, of: PROGRESS.length, label: PROGRESS[i].label, state: failed ? "failed" : "running" };
}

/** The live research events of an onboarding: both passes, in time order (the newest 60). */
export async function researchEvents(athleteId: string, workflowRunId: string): Promise<ResearchEvent[]> {
  const runs = await dbStore.listRunsByPrefix(athleteId, `${parentPrefixFor(workflowRunId)}:research_`);
  const all = runs.filter((r) => r.skillId === "research").flatMap((r) => ((r.output as any)?.events ?? []) as ResearchEvent[]);
  return all.sort((a, b) => a.at.localeCompare(b.at)).slice(-60);
}

/** researchQueued / researchExpectedBy for the state; a finished or failed run is never queued. Fails open (not queued). */
async function queueStateOf(run: { id: string; status: string }): Promise<{ researchQueued: boolean; researchExpectedBy: string | null }> {
  if (run.status !== "running") return { researchQueued: false, researchExpectedBy: null };
  try {
    const q = await researchQueueState(run.id);
    return { researchQueued: q.queued, researchExpectedBy: q.expectedBy };
  } catch (err) {
    logger.warn({ runId: run.id, error: String((err as any)?.message ?? err).slice(0, 200) }, "agent onboarding: queue state read failed");
    return { researchQueued: false, researchExpectedBy: null };
  }
}

export async function onboardingState(athleteId: string) {
  const run = await currentRun(athleteId);
  if (!run) return { started: false as const, required: await agentOnboardingRequired(athleteId) };
  const found = await getRun(run.id);
  const steps = (found?.steps ?? []).map((s) => ({ step: s.step, status: s.status }));
  const progress = progressFrom(steps);
  const turns = (await dbStore.listRunsByPrefix(athleteId, turnPrefix(run.id))).map((r) => (r.output as any)?.turn as TurnRecord | undefined).filter(Boolean) as TurnRecord[];
  const checkpoints = await dbStore.getCheckpoints(athleteId, run.id);
  // Live research events (what is being read, what has been found), kept on the research runs so any instance serves them.
  const events = await researchEvents(athleteId, run.id);
  const progressCard: ChatCard | null = progress.state === "done" ? null : { id: `${run.id}:progress`, kind: "progress", title: "Mila is researching", payload: { ...progress, events }, links: [], runId: null };
  // After the reveal, the Brief is written in the background; its insight cards arrive as their own turn.
  const briefPending = progress.state === "done" && !steps.some((s) => s.step === "insights" && s.status === "done");
  return {
    started: true as const,
    runId: run.id,
    status: run.status,
    waitingOn: found?.steps.find((s) => s.status === "waiting")?.step ?? null,
    progress: progressCard,
    passes: passesFrom(steps),
    /** Live research events (also on the progress card while it shows). */
    events,
    briefPending,
    turns: turns.map((t) => ({ turn: t.turn, athlete: t.athleteInput, message: t.message, cards: t.cards })),
    checkpoints: Object.fromEntries(Object.entries(checkpoints).map(([k, v]) => [k, v.status])),
    done: run.status === "done" || allDone(checkpoints),
    /** The athlete can leave at any time and a launch never holds them here (opt-in, or an earlier finished onboarding). */
    optional: await onboardingOptional(athleteId, run),
    /**
     * The daily research cap queued this research (dailyCap.ts): it starts by itself when there is budget again, by
     * `researchExpectedBy` (the next UTC midnight) at the latest unless the queue is longer than a day's budget.
     */
    ...(await queueStateOf(run)),
  };
}

export async function onboardingTurn(athleteId: string, body: { message?: unknown; actions?: unknown; reply?: unknown }) {
  const run = await currentRun(athleteId);
  if (!run || run.status === "canceled" || run.status === "failed") throw new OnboardingError("no onboarding in progress", 404, "not_found");
  const found = await getRun(run.id);
  // While research runs the athlete can still talk: Mila answers with a nudge and quick questions only.
  const openingDone = found?.steps.some((s) => s.step === "opening" && s.status === "done");
  const phase: "waiting" | "ready" = openingDone ? "ready" : "waiting";

  const message = clean(body.message, 2000) || null;
  const actions = parseActions(body.actions);
  const reply = typeof body.reply === "boolean" ? body.reply : !!message;
  const input = (run.input ?? {}) as { name?: string; sport?: string };

  // Measured facts follow the athlete's connections as they arrive (a connect started in the conversation lands here).
  const channels = await loadConnectedChannels(athleteId);
  await syncMeasured(dbStore, athleteId, measuredFactsFrom(channels, input.name ?? ""));

  const spent = await dbStore.costByParentPrefix(athleteId, parentPrefixFor(run.id));
  const result = await onboardingTurnFn()(
    { store: dbStore, athleteId, scope: run.id, athlete: { name: input.name ?? "", sport: input.sport ?? "" }, connected: await connectedPlatforms(athleteId), budget: { spentMicroUsd: spent.microUsd, capMicroUsd: onboardingCostCapMicroUsd() } },
    { message, actions, reply, phase },
  );
  if (result.done && found?.steps.some((s) => s.step === "conversation" && s.status === "waiting")) {
    await completeStep({ runId: run.id, step: "conversation", fields: {}, mode: "chat", athleteId });
  }
  return {
    runId: result.runId, turn: result.turn, message: result.message, cards: result.cards, done: result.done,
    checkpoints: Object.fromEntries(Object.entries(result.checkpoints as CheckpointState).map(([k, v]) => [k, v.status])),
    applied: result.athleteInput.actions, problems: result.errors,
  };
}

const ACTION_TYPES = new Set(["fact_review", "facts_reviewed", "goal", "goal_add", "connect", "consent", "age_band", "capability"]);
function parseActions(raw: unknown): AthleteAction[] {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 50) throw new OnboardingError("actions must be a list (at most 50)", 400, "invalid");
  return raw.map((a) => {
    if (!a || typeof a !== "object" || !ACTION_TYPES.has((a as any).type)) throw new OnboardingError("unknown action", 400, "invalid");
    const x = a as Record<string, unknown>;
    for (const [k, v] of Object.entries(x)) if (typeof v === "string" && v.length > 2000) throw new OnboardingError(`${k} is too long`, 400, "invalid");
    if (x.type === "fact_review" && !["confirm", "correct", "remove"].includes(String(x.action))) throw new OnboardingError("fact_review.action must be confirm, correct or remove", 400, "invalid");
    if (x.type === "goal" && !["accept", "edit", "skip"].includes(String(x.response))) throw new OnboardingError("goal.response must be accept, edit or skip", 400, "invalid");
    if (x.type === "connect" && !["started", "declined"].includes(String(x.response))) throw new OnboardingError("connect.response must be started or declined", 400, "invalid");
    if (x.type === "consent" && !["agree", "not_now"].includes(String(x.response))) throw new OnboardingError("consent.response must be agree or not_now", 400, "invalid");
    return x as unknown as AthleteAction;
  });
}

const sourcesOf = (f: MemoryFact): CardSource[] => [
  f.type === "said" ? { label: "You told us" } : f.source.url ? { label: f.source.title || f.source.url, url: f.source.url } : { label: f.source.title || "Nomila" },
  ...(f.alsoSeenAt ?? []).map((s) => ({ label: s.title || s.url, url: s.url })),
];

/** The name the athlete gave (their said #name fact), else the athletes row's name. */
export async function athleteNameFor(athleteId: string, facts: MemoryFact[]): Promise<string> {
  const said = facts.find((f) => f.type === "said" && (f.source.ref ?? "").endsWith("#name"));
  if (said?.subject.name) return said.subject.name;
  const [row] = await db.select({ name: athletes.full_name }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  return row?.name ?? "";
}

/** Parse a ?subject= value: athlete | others | all (default all, so existing callers see what they saw). */
export function subjectFilterOf(v: unknown): FactSubjectFilter {
  if (v == null || v === "") return "all";
  if (typeof v === "string" && (FACT_SUBJECT_FILTERS as readonly string[]).includes(v)) return v as FactSubjectFilter;
  throw new OnboardingError(`subject must be one of ${FACT_SUBJECT_FILTERS.join(", ")}`, 400, "invalid");
}

/** Pure: the facts a subject filter keeps (isAboutAthlete decides what is about the athlete). */
export function filterBySubject<T extends Pick<MemoryFact, "subject">>(facts: T[], filter: FactSubjectFilter, athleteName: string): T[] {
  if (filter === "all") return facts;
  return facts.filter((f) => isAboutAthlete(f.subject, athleteName) === (filter === "athlete"));
}

/**
 * Facts for review: everything Mila holds that is not removed, each with sources and the run that produced it, its
 * topic and source type (0115), and `about` — "athlete" for a fact about the athlete, "others" for context about
 * someone or something else. `subject` filters: athlete-facing surfaces that show the athlete's own record (a
 * sponsor list, a Scouting report) ask for subject=athlete, so a teammate's deal or a club's sponsor never shows as theirs.
 */
export async function onboardingFacts(athleteId: string, opts: { subject?: FactSubjectFilter } = {}) {
  const facts = await dbStore.listFacts(athleteId, ["active", "disputed"]);
  const name = await athleteNameFor(athleteId, facts);
  return filterBySubject(facts, opts.subject ?? "all", name).map((f) => ({
    id: f.id, claim: f.claim, type: f.type, status: f.status, date: f.date, confidence: f.confidence, subject: f.subject,
    about: isAboutAthlete(f.subject, name) ? "athlete" as const : "others" as const,
    topic: f.topic ?? null, sourceType: f.sourceType ?? null,
    sensitivity: f.sensitive ? "care" : "none", disputes: f.disputes ?? null, sources: sourcesOf(f), runId: f.runId,
  }));
}

/** The Brief as the athlete sees it: sections and lines with the sources each line rests on. Never the internal read. */
export async function onboardingBrief(athleteId: string) {
  const brief = await dbStore.currentBrief(athleteId);
  if (!brief) return null;
  const facts = new Map((await dbStore.getFacts(athleteId, brief.factIds)).map((f) => [f.id, f]));
  return {
    id: brief.id, version: brief.version, summary: brief.summary, runId: brief.runId, createdAt: brief.createdAt,
    // The stage and positioning as Understand returned them (null for a brief written before 0114).
    display: brief.display,
    sections: brief.sections.map((s) => ({
      key: s.key, title: s.title, soWhat: s.soWhat ?? null,
      lines: s.lines.map((l) => ({ text: l.text, kind: l.kind, factIds: l.factIds, sources: l.factIds.flatMap((id) => (facts.get(id) ? sourcesOf(facts.get(id)!) : [])) })),
    })),
  };
}

/** "How I got this" for one run: what it read, what it searched and found, the facts it used and produced. */
export async function howIGotThis(athleteId: string, runId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new OnboardingError("run not found", 404, "not_found");
  const run = await dbStore.getRun(athleteId, runId);
  if (!run) throw new OnboardingError("run not found", 404, "not_found");
  const readIds = run.evidenceRead.filter((e) => e.kind === "fact").map((e) => (e as { factId: string }).factId);
  const all = await dbStore.listFacts(athleteId);
  const produced = all.filter((f) => f.runId === runId && f.status !== "removed");
  const read = all.filter((f) => readIds.includes(f.id) && !f.sensitive && f.status !== "removed");
  const searches = run.steps.filter((s) => s.type === "web_search") as Array<{ queries: string[]; sources: Array<{ url: string; title?: string }> }>;
  const card: HowIGotThisCardPayload = {
    runId, skillId: run.skillId,
    why: `${run.skillId} ${run.skillVersion}: ${read.length} facts read, ${searches.reduce((n, s) => n + s.queries.length, 0)} web searches, ${produced.length} facts found.`,
    facts: [...produced, ...read].slice(0, 60).map((f) => ({ claim: f.claim, type: f.type, source: sourcesOf(f)[0] })),
  };
  return {
    card,
    trace: {
      skill: { id: run.skillId, version: run.skillVersion }, status: run.status, startedAt: run.startedAt, endedAt: run.endedAt,
      searches: searches.map((s) => ({ queries: s.queries, sources: s.sources })),
      steps: run.steps.map((s) => ({ seq: s.seq, type: s.type, at: s.at })),
    },
  };
}

/** "How I got this" for one fact: its sources, its status (disputed / superseded), and the run that produced it. */
export async function howForFact(athleteId: string, factId: string) {
  const [fact] = await dbStore.getFacts(athleteId, [factId]);
  if (!fact) throw new OnboardingError("fact not found", 404, "not_found");
  const related = await dbStore.getFacts(athleteId, [fact.disputes, fact.supersededBy].filter((x): x is string => !!x));
  return {
    fact: { id: fact.id, claim: fact.claim, type: fact.type, status: fact.status, date: fact.date, confidence: fact.confidence, sources: sourcesOf(fact) },
    disputes: related.find((r) => r.id === fact.disputes)?.claim ?? null,
    supersededBy: related.find((r) => r.id === fact.supersededBy)?.claim ?? null,
    run: fact.runId ? await howIGotThis(athleteId, fact.runId).then((h) => h.trace).catch(() => null) : null,
  };
}

/** Goals the athlete holds. */
export const onboardingGoals = (athleteId: string) => dbStore.listGoals(athleteId);

