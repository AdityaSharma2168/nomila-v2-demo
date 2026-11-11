/**
 * evals/agent/runCase.ts — run one case through the new agent's stages and record what happened.
 *
 * The stages are the SAME functions the agent_onboarding workflow calls (agent/onboarding/workflow.ts), in the same
 * order and with the same arguments, minus the workflow runner itself (so one stage can be run alone):
 *
 *   research    searchPass A ‖ searchPass B → mergePasses → recordIdentityOutcome
 *   onboarding  takeTurn "opening" (the reveal) … then, after understand, takeTurn "insights"
 *   understand  understand (the Brief)            ┐ in parallel, as in the workflow
 *   mia         the M.I.A. preview (injected)     ┘
 *   plan        runPlan (agent/plan): recommended goals, game plans, this week's actions — as the understand step
 *               starts it once the Brief is written (its own plan_refresh run in production)
 *
 * Every model call goes through runSkill, so each one leaves an agent_runs row (or an in-memory run in --mock) under
 * this case's parent prefix; the record's cost and latency come from those rows, not from timers in this file.
 *
 * Spend is bounded twice: the eval's global budget (Budget, a hard stop checked before every stage with a reserve for
 * the stage's worst case) and the production per-onboarding cap, passed to every skill run as its JobContext budget so
 * runSkill itself refuses a call at or over it.
 */
import { randomUUID } from "node:crypto";
import { ageBandFrom } from "../../server/agent/ageBand";
import { mergePasses, recordIdentityOutcome, searchPass, type JobContext } from "../../server/agent/research/research";
import { CostCapError } from "../../server/agent/research/runSkill";
import type { AgentStore, StoredRun } from "../../server/agent/research/store";
import { understand } from "../../server/agent/research/understand";
import { takeTurn } from "../../server/agent/onboarding/turn";
import type { PlanSources } from "../../server/agent/plan/input";
import { runPlan, type PlanRunOutcome, type PlanRunOutput } from "../../server/agent/plan/run";
import type { CaseRecord, EvalCase, EvalStage, RecordedMia, RunTrace } from "./types";
import { judgeBrief, type JudgeCaller } from "./judge";

/** Worst-case spend reserved before each stage (USD). A stage starts only if spent + reserve ≤ budget. */
export const STAGE_RESERVE_USD = { researchPass: 0.75, merge: 0.3, understand: 0.75, turn: 0.15, mia: 0.4, plan: 0.15, judge: 0.1 } as const;

export class BudgetStop extends Error {}

/** The eval's global budget, in micro-dollars. */
export class Budget {
  spentMicroUsd = 0;
  constructor(readonly capMicroUsd: number) {}
  get remainingMicroUsd(): number { return Math.max(0, this.capMicroUsd - this.spentMicroUsd); }
  /** Throws BudgetStop unless `usd` more still fits under the cap. */
  reserve(usd: number, what: string): void {
    if (this.spentMicroUsd + Math.round(usd * 1e6) > this.capMicroUsd) {
      throw new BudgetStop(`${what} needs up to $${usd.toFixed(2)}, $${(this.remainingMicroUsd / 1e6).toFixed(2)} left of $${(this.capMicroUsd / 1e6).toFixed(2)}`);
    }
  }
}

/** Which stages run for a --stage choice (each needs the ones before it). Null = all. */
export function stagesFor(stage: EvalStage | null): EvalStage[] {
  switch (stage) {
    case "research": return ["research"];
    case "understand": return ["research", "understand"];
    case "onboarding": return ["research", "onboarding", "understand"];
    case "mia": return ["research", "mia"];
    case "plan": return ["research", "understand", "plan"];
    default: return ["research", "onboarding", "understand", "mia", "plan"];
  }
}

/** The plan's non-memory inputs in an eval: nothing connected, no open threads, no preferences, no M.I.A. read. */
const EVAL_PLAN_SOURCES: PlanSources = {
  mia: async () => null, connected: async () => [], openThreads: async () => [], preferences: async () => [], playbook: async () => [],
};

export interface CaseDeps {
  mode: "live" | "mock";
  store: AgentStore;
  /** Create the throwaway athlete row (live) or an id (mock). */
  createAthlete: (c: EvalCase) => Promise<string>;
  /** The M.I.A. preview for the athlete (live: services/miaPreview; mock: a stub). */
  mia?: (athleteId: string) => Promise<RecordedMia>;
  /** Null = no judge. */
  judge: JudgeCaller | null;
  budget: Budget;
  /** The production per-onboarding cap (micro-dollars). */
  onboardingCapMicroUsd: number;
  log: (line: string) => void;
  today?: string;
}

const durationOf = (r: StoredRun) => (r.endedAt ? new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime() : null);

/** agent_runs row → the trace the graders read. `prefix` is the case's parent prefix. */
export function traceOf(r: StoredRun, prefix: string): RunTrace {
  const tail = (r.parentRef ?? "").slice(prefix.length + 1);
  const role = tail === "research_merge" ? "merge" : tail.startsWith("turn:") ? tail : tail || r.skillId;
  const out = (r.output ?? {}) as { json?: unknown; sources?: Array<{ url: string; title?: string }> };
  return {
    runId: r.id, role, skillId: r.skillId, skillVersion: r.skillVersion, model: r.model.model, effort: r.model.effort,
    status: r.status, stopReason: r.stopReason, error: r.error,
    costMicroUsd: r.cost.microUsd, inputTokens: r.cost.inputTokens, cachedInputTokens: r.cost.cachedInputTokens, outputTokens: r.cost.outputTokens,
    webSearchCalls: r.cost.webSearchCalls, durationMs: durationOf(r),
    modelMs: r.steps.reduce((n, s) => n + (s.type === "model" ? s.durationMs : 0), 0),
    json: out.json ?? null, sources: out.sources ?? [],
    policy: r.steps.flatMap((s) => (s.type === "policy" ? [{ rule: s.rule, decision: s.decision, reason: s.reason }] : [])),
  };
}

/** Run one case. Never throws for a model or budget failure: the record says where it stopped. */
export async function runCase(c: EvalCase, stages: EvalStage[], deps: CaseDeps): Promise<{ record: CaseRecord; athleteId: string | null }> {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const scope = randomUUID();
  const prefix = `workflow:${scope}`;
  const { store, budget } = deps;
  const athlete = { name: c.input.name, sport: c.input.sport };
  const baseSpent = budget.spentMicroUsd;
  let athleteId: string | null = null;
  let mia: RecordedMia | null = null;
  let identity: CaseRecord["identity"] = null;
  let stopped: CaseRecord["stopped"] = null;
  let plan: PlanRunOutcome | null = null;
  /** Stages that FINISHED (a budget stop leaves the rest unfinished; graders skip those, they are not failures). */
  const done: EvalStage[] = [];

  const caseSpent = async () => (athleteId ? (await store.costByParentPrefix(athleteId, prefix)).microUsd : 0) + (mia?.costMicroUsd ?? 0);
  const sync = async () => { budget.spentMicroUsd = baseSpent + (await caseSpent()); };
  // The stricter of the two caps, as runSkill's budget: the per-onboarding cap and what the eval has left.
  const job = async (): Promise<JobContext> => {
    const spent = await caseSpent();
    return { store, athleteId: athleteId!, parentPrefix: prefix, today: deps.today, budget: { spentMicroUsd: spent, capMicroUsd: Math.min(deps.onboardingCapMicroUsd, spent + budget.remainingMicroUsd) } };
  };
  const turnCtx = async () => {
    const j = await job();
    return { store, athleteId: athleteId!, scope, athlete, connected: [] as string[], budget: j.budget };
  };

  try {
    athleteId = await deps.createAthlete(c);
    // What the athlete told us, as the onboarding start writes it (name, sport), plus any identity anchor the case gives.
    const today = deps.today ?? new Date().toISOString().slice(0, 10);
    await store.insertFacts(athleteId, [
      { subject: { kind: "athlete", name: athlete.name }, claim: `The athlete's name is ${athlete.name}.`, type: "said", source: { ref: `onboarding/${scope}#name`, title: "You told us" }, date: today, confidence: 1, runId: null },
      { subject: { kind: "athlete", name: athlete.name }, claim: `${athlete.name}'s sport is ${athlete.sport}.`, type: "said", source: { ref: `onboarding/${scope}#sport`, title: "You told us" }, date: today, confidence: 1, runId: null },
      ...(c.input.said ?? []).map((s, i) => ({ subject: { kind: "athlete" as const, name: athlete.name }, claim: s, type: "said" as const, source: { ref: `onboarding/${scope}#said:${i + 1}`, title: "You told us" }, date: today, confidence: 1, runId: null })),
    ]);
    await store.setCheckpoint(athleteId, scope, "name_sport", { status: "done" });

    // research ─────────────────────────────────────────────────────────────
    budget.reserve(STAGE_RESERVE_USD.researchPass * 2 + STAGE_RESERVE_USD.merge, `${c.id} research`);
    deps.log(`  research: two passes in parallel`);
    const existing = await store.listFacts(athleteId, ["active", "disputed"]);
    const summary = "No accounts connected yet.";
    const ctx = await job();
    const [a, b] = await Promise.all((["a", "b"] as const).map((pass) => searchPass(ctx, { pass, athlete, connectedSummary: summary, existing })));
    await sync();
    deps.log(`  research: merge (${a.facts.length} + ${b.facts.length} pass facts)`);
    const m = await mergePasses(await job(), { athlete, a, b, existing });
    await recordIdentityOutcome(store, athleteId, { runId: m.runId, resolved: m.identity.resolved, ambiguity: m.identity.ambiguity, athlete });
    identity = m.identity;
    await sync();
    done.push("research");

    // onboarding: the opening turn (reveal) ─────────────────────────────────
    if (stages.includes("onboarding")) {
      budget.reserve(STAGE_RESERVE_USD.turn, `${c.id} opening turn`);
      deps.log(`  onboarding: opening turn`);
      await takeTurn(await turnCtx(), { message: null, actions: [], reply: true, turnKey: "opening", phase: "ready", event: "Research is done. The Brief is still being written (insights come later): open with the reveal moment." });
      await sync();
      if (!stages.includes("understand")) done.push("onboarding");
    }

    // understand ‖ mia ──────────────────────────────────────────────────────
    const parallel: Array<Promise<unknown>> = [];
    if (stages.includes("understand")) {
      budget.reserve(STAGE_RESERVE_USD.understand + (stages.includes("mia") && deps.mia ? STAGE_RESERVE_USD.mia : 0), `${c.id} understand`);
      deps.log(`  understand${stages.includes("mia") ? " ‖ M.I.A." : ""}`);
      const facts = await store.listFacts(athleteId);
      parallel.push(understand(await job(), { athlete, facts, gaps: m.gaps, ageBand: ageBandFrom(facts) }));
    } else if (stages.includes("mia")) {
      budget.reserve(STAGE_RESERVE_USD.mia, `${c.id} M.I.A.`);
      deps.log(`  M.I.A. preview`);
    }
    if (stages.includes("mia") && deps.mia) parallel.push(deps.mia(athleteId).then((x) => { mia = x; }));
    const settled = await Promise.allSettled(parallel);
    await sync();
    const rejected = settled.find((s) => s.status === "rejected") as PromiseRejectedResult | undefined;
    if (rejected) throw rejected.reason;
    if (stages.includes("understand")) done.push("understand");
    if (stages.includes("mia") && mia) done.push("mia");

    if (stages.includes("onboarding") && stages.includes("understand")) {
      budget.reserve(STAGE_RESERVE_USD.turn, `${c.id} insights turn`);
      deps.log(`  onboarding: insights turn`);
      await takeTurn(await turnCtx(), { message: null, actions: [], reply: true, turnKey: "insights", event: "The Brief is ready. Share one or two early insights that prove value; pick up the conversation where it is." });
      await sync();
      done.push("onboarding");
    }

    // plan: the plan step, as onboarding starts it once the Brief is written (one call; its own caps) ─────────────
    if (stages.includes("plan")) {
      budget.reserve(STAGE_RESERVE_USD.plan, `${c.id} plan`);
      deps.log(`  plan`);
      const today = deps.today ?? new Date().toISOString().slice(0, 10);
      plan = await runPlan({
        store, sources: EVAL_PLAN_SOURCES, athleteId, trigger: "event", reason: "the Brief was written", parentRef: `${prefix}:plan`,
        now: new Date(`${today}T12:00:00.000Z`),
      });
      await sync();
      done.push("plan");
    }
  } catch (err: any) {
    stopped = err instanceof BudgetStop || err instanceof CostCapError
      ? { reason: "budget", detail: String(err.message) }
      : { reason: "error", detail: String(err?.message ?? err).slice(0, 500) };
    deps.log(`  stopped: ${stopped.reason}: ${stopped.detail}`);
  }

  const record = await collect(c, stages, done, deps, { athleteId, prefix, startedAt, t0, identity, mia, stopped, plan });
  await sync().catch(() => undefined);

  // The judge (only when a Brief exists), outside the case's agent spend.
  if (record.brief && deps.judge && !stopped) {
    try {
      budget.reserve(STAGE_RESERVE_USD.judge, `${c.id} judge`);
      deps.log(`  judge`);
      record.judge = await judgeBrief(c.input.name, c.input.sport, record, deps.judge);
      budget.spentMicroUsd += record.judge.costMicroUsd;
    } catch (err: any) {
      if (!(err instanceof BudgetStop)) throw err;
      deps.log(`  judge skipped: ${err.message}`);
    }
  }
  return { record, athleteId };
}

async function collect(c: EvalCase, stages: EvalStage[], done: EvalStage[], deps: CaseDeps, s: {
  athleteId: string | null; prefix: string; startedAt: string; t0: number; identity: CaseRecord["identity"]; mia: RecordedMia | null; stopped: CaseRecord["stopped"];
  plan: PlanRunOutcome | null;
}): Promise<CaseRecord> {
  const base: CaseRecord = {
    caseId: c.id, mode: deps.mode, stages, stagesDone: [...done], startedAt: s.startedAt, wallMs: Date.now() - s.t0, stopped: s.stopped,
    runs: [], identity: s.identity, facts: [], brief: null, turns: [], mia: s.mia, judge: null,
  };
  if (!s.athleteId) return base;
  const { store } = deps;
  const runs = await store.listRunsByPrefix(s.athleteId, s.prefix);
  base.runs = runs.map((r) => traceOf(r, s.prefix));
  base.facts = (await store.listFacts(s.athleteId)).map((f) => ({
    id: f.id, claim: f.claim, type: f.type, status: f.status, subject: { kind: f.subject.kind, name: f.subject.name },
    sourceUrl: f.source.url ?? null, sourceRef: f.source.ref ?? null, sensitive: !!f.sensitive, runId: f.runId,
  }));
  const brief = await store.currentBrief(s.athleteId);
  if (brief) {
    const internal = await store.currentBriefInternal(s.athleteId);
    base.brief = {
      summary: brief.summary,
      sections: brief.sections.map((x) => ({ key: x.key, title: x.title, lines: x.lines.map((l) => ({ text: l.text, kind: l.kind, factIds: l.factIds })), ...(x.soWhat ? { soWhat: x.soWhat } : {}) })),
      ...(brief.display?.contentPillars ? { contentPillars: brief.display.contentPillars.map((p) => ({ key: p.key, name: p.name, whyThisAthlete: p.whyThisAthlete, factIds: p.factIds })) } : {}),
      internal: internal ? { currentSponsors: internal.currentSponsors.map((x) => ({ name: x.name })), pastSponsors: ((internal as any).pastSponsors ?? []).map((x: any) => ({ name: String(x?.name ?? "") })) } : null,
    };
  }
  base.turns = runs.filter((r) => r.skillId === "onboarding").flatMap((r) => {
    const t = (r.output as any)?.turn;
    if (!t) return [];
    const key = (r.parentRef ?? "").split(":turn:")[1] ?? String(t.turn);
    return [{ key, runId: r.id, message: String(t.message ?? ""), cards: (t.cards ?? []).map((k: any) => ({ kind: k.kind, title: k.title, payload: k.payload })), held: t.held ?? [] }];
  });
  if (s.plan) {
    const run = runs.find((r) => r.skillId === "plan" && r.parentRef === `${s.prefix}:plan`);
    const out = (run?.output ?? {}) as PlanRunOutput;
    const p = out.plan;
    base.plan = {
      status: s.plan.status === "skipped" ? `skipped:${s.plan.reason}` : s.plan.status,
      stageBand: p?.stageRead.band ?? null,
      recommended: (p?.recommendedGoals ?? []).map((g) => ({ goal: g.goal, horizon: g.horizon, whyNow: g.whyNow, value: g.value.text, valueConfidence: g.valueConfidence, factIds: g.factIds })),
      gamePlans: (p?.gamePlans ?? []).flatMap((g) => g.lines),
      actions: (p?.actions ?? []).map((a) => ({
        what: a.what, why: a.why, kind: a.kind, button: a.button, dueOn: a.dueOn, eventDate: a.event?.date ?? null,
        deliverableTitle: a.deliverable.title, deliverableBody: a.deliverable.body, factIds: a.factIds,
      })),
      held: out.held ?? [],
      missing: (p?.missing ?? []).map((m) => m.text),
    };
  }
  return base;
}
