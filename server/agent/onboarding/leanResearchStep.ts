/**
 * agent/onboarding/leanResearchStep.ts — the `lean_research` workflow step: LEAN research (agent/research/v2/lean.ts)
 * run LIVE, its verified facts kept in her memory. Used by signup_research v4 (LEAN_SIGNUP_RESEARCH) in place of
 * research_a / research_b / research_merge, and by the lean_research_refresh run Mila's refresh_research tool starts.
 *
 *   reads     her name and sport (the run's input), the team she gave (legacyAdapter readLegacyRow, the one sanctioned
 *             reader, sourceGuard G5), handles of her connected accounts, and the facts she holds
 *   research  runLeanResearch: Wikidata first, then OpenAI web search (never Google grounding), our own fetch, rank,
 *             extract-all, identity, verify, one follow-up round for empty commercial areas
 *   identity  not confirmed ⇒ NO fact is kept, and the outcome is recorded exactly as the merge records it today
 *             (research.ts recordIdentityOutcome: a disputed "#identity" fact that holds M.I.A.); confirmed ⇒ any open
 *             "#identity" fact is superseded
 *   save      the verified facts as FOUND facts with source URL, date and topic, de-duplicated in code against what she
 *             holds (v2/leanSave.ts) — no schema change
 *   measured  her connected accounts' numbers re-synced (code), as the merge does
 *
 * Every paid call is an agent_runs row under the run's parent prefix, so the per-run cap (runSkill's budget) and the
 * daily caps count it: the extract and verify calls through runSkill (a retried step reuses a finished call, never pays
 * twice), and the web searches as one "research/lean-discover" row with their cost and the result links (a retried step
 * reads those links instead of searching again).
 */
import type { StepCtx } from "../../workflow/types";
import type { ModelChoice } from "../../../shared/agent";
import { createLogger } from "../../logger";
import { dbStore } from "../research/dbStore";
import { loadConnectedChannels, measuredFactsFrom } from "../research/connected";
import { recordIdentityOutcome, syncMeasured } from "../research/research";
import type { AgentStore } from "../research/store";
import { readLegacyRow } from "../../services/intelligence/context/legacyAdapter";
import { AGENT_MODELS } from "../models";
import { openaiDiscover, type DiscoverQuery, type FoundPage } from "../research/v2/discover";
import { skillModelCall, type LeanModelCall } from "../research/v2/extractAll";
import { leanExtractModel, leanSearchOf, leanVerifyModel, runLeanResearch, type LeanDeps, type LeanResult, type LeanSearchSpend, type LeanStage } from "../research/v2/lean";
import { planFactWrites, saveLeanFacts } from "../research/v2/leanSave";
import type { EvidenceAim, ResearchMoment } from "../research/v2/plan";

const logger = createLogger("agent/lean-research");

export const LEAN_RESEARCH_STEP_NAME = "lean_research";
/** The agent_runs row that records a lean run's web searches (cost + result links). */
export const LEAN_DISCOVER_SKILL_ID = "research/lean-discover";

export interface LeanStepOptions {
  moment: ResearchMoment;
  /** The run's parent prefix: every agent run of this step is keyed under it ("workflow:<id>", "research_refresh:<id>"). */
  parentPrefix: string;
  /** This run's cap (micro-dollars), already lowered to any day cap left. */
  capMicroUsd: number;
  aims?: EvidenceAim[] | null;
  /** Tests: provider seams (never reached in tests). */
  deps?: Partial<Pick<LeanDeps, "wikidataGet" | "fetchImpl" | "discoverQuery" | "cleaner">> & { call?: LeanModelCall; store?: AgentStore; writeProgress?: typeof writeStepProgress };
}

const discoverParent = (prefix: string) => `${prefix}:lean_discover`;

/**
 * The step's live stage, written on its own RUNNING row as `output.progress` { stage, count?, at } (the runner reads
 * outputs only from done rows and replaces this with the step's real output when it finishes), so GET
 * /waitlist/progress can say what the research is doing right now — real transitions, never a timer. Writes are
 * ordered, at most one per `minGapMs` per stage (the latest count wins, written at the end of the gap), and never throw.
 */
export async function writeStepProgress(ctx: Pick<StepCtx, "runId" | "step" | "attempt">, s: LeanStage): Promise<void> {
  const { db } = await import("../../db");
  const { workflowSteps } = await import("../../../shared/schemaWorkflow");
  const { and, eq } = await import("drizzle-orm");
  await db.update(workflowSteps).set({ output: { progress: { stage: s.stage, ...(typeof s.count === "number" ? { count: s.count } : {}), at: new Date().toISOString() } } as any })
    .where(and(eq(workflowSteps.run_id, ctx.runId), eq(workflowSteps.step, ctx.step), eq(workflowSteps.attempt, ctx.attempt), eq(workflowSteps.status, "running")));
}
export function stageReporter(ctx: Pick<StepCtx, "runId" | "step" | "attempt">, o: { write?: typeof writeStepProgress; minGapMs?: number } = {}) {
  const write = o.write ?? writeStepProgress;
  const gap = o.minGapMs ?? 1500;
  let chain: Promise<void> = Promise.resolve();
  let last: { stage: string; at: number } | null = null;
  let pending: LeanStage | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const send = (s: LeanStage) => { last = { stage: s.stage, at: Date.now() }; chain = chain.then(() => write(ctx, s)).catch(() => {}); };
  const report = (s: LeanStage) => {
    if (last && last.stage === s.stage && Date.now() - last.at < gap) {
      pending = s;
      if (!timer) timer = setTimeout(() => { timer = null; if (pending) { const p = pending; pending = null; send(p); } }, gap - (Date.now() - last.at));
      return;
    }
    if (timer) { clearTimeout(timer); timer = null; }
    pending = null;
    send(s);
  };
  /** Stop: drop a pending write (the step's output replaces the progress) and wait for any write in flight. */
  const done = async () => { if (timer) clearTimeout(timer); timer = null; pending = null; await chain; };
  return { report, done };
}

export async function runLeanStep(ctx: StepCtx, o: LeanStepOptions): Promise<Record<string, unknown>> {
  const athleteId = ctx.athleteId!;
  const store = o.deps?.store ?? dbStore;
  const input = (ctx.runInput ?? {}) as { name?: string; sport?: string };
  if (!input.name || !input.sport) throw new Error("lean research needs a name and a sport");
  const athlete = { name: input.name, sport: input.sport };
  const team = (await readLegacyRow(athleteId).catch(() => null))?.school ?? null;
  const channels = await loadConnectedChannels(athleteId).catch(() => []);
  const known = await store.listFacts(athleteId, ["active", "disputed"]);
  const spent = (await store.costByParentPrefix(athleteId, o.parentPrefix)).microUsd;

  // A retried step reads its earlier search results (already paid) instead of searching again.
  const prior = await store.findCompletedRun(athleteId, discoverParent(o.parentPrefix));
  const priorOut = (prior?.output ?? null) as { pages?: FoundPage[]; search_queries?: number } | null;
  // ...and the follow-up round's, when that round's search finished before (a retry, or a step held then released).
  const priorR2 = await store.findCompletedRun(athleteId, `${discoverParent(o.parentPrefix)}:r2`);
  const priorR2Out = (priorR2?.output ?? null) as { pages?: FoundPage[]; search_queries?: number } | null;
  const search = leanSearchOf();
  const discoverQuery: DiscoverQuery | null = o.deps?.discoverQuery !== undefined ? o.deps.discoverQuery : search === "openai" ? openaiDiscover() : null;

  const stages = stageReporter(ctx, { write: o.deps?.writeProgress });
  // Handles only from accounts she connected: the measured channels, plus an account connected moments ago whose first
  // reading has not landed yet (an identity re-check on connect runs right away; researchRefresh/identityRecheck.ts).
  const handles = [...new Set([...channels.map((c) => c.handle), ...(await activeConnectedHandles(athleteId).catch(() => []))]
    .filter((h): h is string => !!h).map((h) => h.replace(/^@/, "")))];
  // Each round's search spend is recorded the moment it is known (before an extract the platform day cap could refuse),
  // so a held step's spend still reaches agent_runs; round 1's complete results are the ones a retried step reuses.
  let searchRecordedId: string | null = null;
  const onSearchSpend = async (s: LeanSearchSpend) => {
    const id = await recordSearchSpend(store, athleteId, o.parentPrefix, s);
    if (s.round === 1 && s.complete) searchRecordedId = id;
  };
  const r = await runLeanResearch(
    { athlete, team, handles, known, today: new Date().toISOString().slice(0, 10), moment: o.moment, aims: o.aims ?? null },
    {
      call: o.deps?.call ?? skillModelCall({ store, athleteId, parentPrefix: o.parentPrefix, budget: { spentMicroUsd: spent, capMicroUsd: o.capMicroUsd } }),
      discoverQuery, wikidataGet: o.deps?.wikidataGet, fetchImpl: o.deps?.fetchImpl, cleaner: o.deps?.cleaner,
      extractModel: leanExtractModel(), verifyModel: leanVerifyModel(),
      priorSearch: priorOut?.pages ? { pages: priorOut.pages, searchQueries: priorOut.search_queries ?? 0, costMicroUsd: 0 } : null,
      priorFollowUpSearch: priorR2Out?.pages ? { pages: priorR2Out.pages, searchQueries: priorR2Out.search_queries ?? 0 } : null,
      spentBeforeMicroUsd: spent,
      onStage: stages.report,
      onSearchSpend,
    },
  ).finally(() => stages.done());
  const discoverRunId = prior?.id ?? searchRecordedId;

  let saved = { inserted: 0, disputed: 0, duplicates: 0, dropped: 0 };
  const runRef = r.rounds[0].extractRunId ?? discoverRunId ?? ctx.runId;
  if (r.outcome === "confirmed") {
    // Re-read: the facts she holds now (a said fact may have arrived while the research ran).
    const existing = await store.listFacts(athleteId, ["active", "disputed"]);
    const plan = planFactWrites(existing, r.facts, athlete, r.rounds[0].extractRunId);
    const s = await saveLeanFacts(store, athleteId, plan);
    saved = { inserted: s.inserted.length, disputed: s.disputed, duplicates: s.duplicates, dropped: s.dropped };
  }
  // Identity, kept in memory exactly as the merge keeps it: unresolved ⇒ a disputed "#identity" fact (holds M.I.A.).
  await recordIdentityOutcome(store, athleteId, { runId: runRef, resolved: r.outcome === "confirmed", ambiguity: r.unconfirmedReason ?? "", athlete });
  const measured = await syncMeasured(store, athleteId, measuredFactsFrom(channels, athlete.name));
  logger.info({ athleteId, runId: ctx.runId, moment: o.moment, outcome: r.outcome, facts: r.facts.length, inserted: saved.inserted, costMicroUsd: r.costMicroUsd.total, ms: r.ms.total }, "lean research");
  return stepOutput(r, saved, measured.inserted, discoverRunId);
}

/** The usernames of her ACTIVE connected social accounts (connected_accounts; no reading needed). */
async function activeConnectedHandles(athleteId: string): Promise<string[]> {
  const { db } = await import("../../db");
  const { sql } = await import("drizzle-orm");
  const rows: any[] = ((await db.execute(sql`
    SELECT platform_username FROM connected_accounts
     WHERE athlete_id = ${athleteId} AND status = 'active' AND platform IN ('instagram', 'tiktok', 'youtube')
       AND coalesce(trim(platform_username), '') <> ''`)) as any).rows ?? [];
  return rows.map((r) => String(r.platform_username));
}

/** The searches as one agent_runs row: their cost (so the caps count it) and the result links (reused on retry). */
/**
 * One round's paid search as an agent_runs row (its cost counts in every cap the moment it lands). A COMPLETE search
 * is recorded with its result links (round 1 under discoverParent(prefix), the follow-up round under ":r2"), which a
 * retried (or held, then released) step reads instead of searching again. A search the platform day cap cut short is
 * recorded as spend only, under its own ":rN_cut" ref (never reused).
 */
async function recordSearchSpend(store: AgentStore, athleteId: string, prefix: string, s: LeanSearchSpend): Promise<string> {
  const model: ModelChoice = { provider: "openai", model: AGENT_MODELS.fast, effort: "low" };
  const reusable = s.complete;
  const parentRef = !s.complete ? `${discoverParent(prefix)}:r${s.round}_cut` : s.round === 1 ? discoverParent(prefix) : `${discoverParent(prefix)}:r2`;
  const id = await store.startRun({ athleteId, skillId: LEAN_DISCOVER_SKILL_ID, skillVersion: "1.0.0", trigger: "event", model, parentRef });
  const cost = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, webSearchCalls: s.searchQueries || s.queries.length, microUsd: s.costMicroUsd };
  await store.finishRun(athleteId, id, {
    status: "completed", stopReason: null, cost, evidenceRead: [], steps: [],
    output: reusable
      ? { queries: s.queries, round: s.round, pages: s.pages.map((p) => ({ url: p.url, title: p.title, snippet: "", aim: p.aim, quality: p.quality })), search_queries: s.searchQueries }
      : { queries: s.queries, round: s.round, cut_by_platform_cap: true, search_queries: s.searchQueries },
    error: null,
  });
  return id;
}

/** The step's output: what an operator, the waitlist progress and agent_onboarding v4's reuse read. */
export function stepOutput(r: LeanResult, saved: { inserted: number; disputed: number; duplicates: number; dropped: number }, measured: number, discoverRunId: string | null) {
  return {
    run_id: r.rounds[0].extractRunId, verify_run_id: r.rounds[0].verifyRunId, discover_run_id: discoverRunId,
    outcome: r.outcome, identity_resolved: r.outcome === "confirmed", unconfirmed_reason: r.unconfirmedReason,
    identity_question: r.identityQuestion,
    inserted: saved.inserted, disputed: saved.disputed, duplicates: saved.duplicates, save_dropped: saved.dropped, measured,
    facts_extracted: r.rounds.reduce((n, x) => n + x.extracted, 0), facts_verified: r.facts.length, withheld: r.withheld,
    verify_dropped: r.rounds.reduce((n, x) => n + x.verifyDropped.length, 0),
    by_topic: r.byTopic.topics, by_area: r.byTopic.aims, by_dimension: r.byDimension, follow_up: r.followUp,
    sources: r.sources.slice(0, 40), pages_read: r.pages.length, wrong_person: r.wrongPerson.slice(0, 20),
    wikidata_hits: r.wikidata.hits.map((h) => ({ id: h.id, kept: h.kept })),
    gaps: r.gaps.slice(0, 20).map((g) => g.slice(0, 200)),
    models: r.models, cost_micro_usd: r.costMicroUsd.total, cost: r.costMicroUsd, ms: r.ms,
  };
}
