/**
 * agent/trace.ts — every run leaves a trace (agent_runs).
 *
 * A run row is inserted 'running' before the first model call, flushed after every model call (so a concurrent run
 * sees this one's spend in the per-day cap), and finished exactly once with its status and stop reason. The trace —
 * steps, tools called, evidence read — is jsonb on the row: one row per run, readable as a whole for "How I got this".
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db";
import { agentRuns, type AgentRunRow } from "../../shared/schema";
import type { AgentRun, EvidenceRef, ModelChoice, RunApprovalState, RunCost, RunStatus, RunTrigger, StopReason, ToolCallRecord, TraceStep } from "../../shared/agent";
import { addCost, ZERO_COST } from "./models";
import { promptDigest } from "./jobs";
import { assertAthleteNotDeleting } from "../lib/privacy/deletionFence";
import { voiceSpendTodayMicroUsd } from "../voice/voiceMinutes";

type StepInput = TraceStep extends infer T ? (T extends TraceStep ? Omit<T, "seq" | "at"> : never) : never;

/** A run's first step: the skill, its semver and the digest of the exact prompt text it ran on (jobs.ts promptDigest). */
export function skillStep(skill: { id: string; version: string; instructions: string }): Extract<StepInput, { type: "skill" }> {
  return { type: "skill", skillId: skill.id, version: skill.version, digest: promptDigest(skill) };
}

function evidenceKey(e: EvidenceRef): string {
  switch (e.kind) {
    case "fact": return `fact:${e.factId}`;
    case "url": return `url:${e.url}`;
    case "record": return `record:${e.table}:${e.id}`;
    case "tool_result": return `tool:${e.runId}:${e.seq}`;
  }
}

export interface TraceStart { athleteId: string; skillId: string; skillVersion: string; trigger: RunTrigger; model: ModelChoice; conversationId?: string | null }
export type TraceColumns = ReturnType<TraceRecorder["columns"]>;
export interface TraceFinish { status: Exclude<RunStatus, "running">; stop_reason: StopReason | null; error: string | null; ended_at: Date; approval_state?: RunApprovalState | null }

/**
 * Where a trace is written. The database (agent_runs) in the app; an in-memory sink for the chat eval and pure tests,
 * which must never write to a database.
 */
export interface TraceSink {
  insert(p: TraceStart): Promise<string>;
  update(athleteId: string, runId: string, columns: TraceColumns & Partial<TraceFinish>): Promise<void>;
}

export const dbTraceSink: TraceSink = {
  async insert(p) {
    // No run starts for an athlete whose account is being deleted (lib/privacy/deletionFence.ts).
    await assertAthleteNotDeleting(p.athleteId);
    const [row] = await db.insert(agentRuns).values({
      athlete_id: p.athleteId,
      skill_id: p.skillId,
      skill_version: p.skillVersion,
      trigger: p.trigger,
      provider: p.model.provider,
      model: p.model.model,
      effort: p.model.effort,
      conversation_id: p.conversationId ?? null,
    }).returning({ id: agentRuns.id });
    return row.id;
  },
  async update(athleteId, runId, columns) {
    await db.update(agentRuns).set(columns).where(and(eq(agentRuns.id, runId), eq(agentRuns.athlete_id, athleteId)));
  },
};

/** An in-memory sink: every run's start and its latest columns, by run id. */
export function memoryTraceSink(): TraceSink & { runs: Map<string, TraceStart & Partial<TraceColumns & TraceFinish>> } {
  const runs = new Map<string, TraceStart & Partial<TraceColumns & TraceFinish>>();
  let n = 0;
  return {
    runs,
    async insert(p) { const id = `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`; runs.set(id, { ...p }); return id; },
    async update(_athleteId, runId, columns) { const r = runs.get(runId); if (r) Object.assign(r, columns); },
  };
}

export class TraceRecorder {
  readonly steps: TraceStep[] = [];
  readonly toolsCalled: ToolCallRecord[] = [];
  readonly evidence: EvidenceRef[] = [];
  cost: RunCost = { ...ZERO_COST };
  private seen = new Set<string>();
  private finished = false;

  private constructor(readonly runId: string, readonly athleteId: string, private readonly sink: TraceSink) {}

  static async start(p: TraceStart, sink: TraceSink = dbTraceSink): Promise<TraceRecorder> {
    return new TraceRecorder(await sink.insert(p), p.athleteId, sink);
  }

  /** The run's first step: the skill, its semver and the digest of the exact prompt text it runs on (skillStep). */
  stepSkill(skill: { id: string; version: string; instructions: string }): TraceStep {
    return this.step(skillStep(skill));
  }

  step(s: StepInput): TraceStep {
    const full = { ...s, seq: this.steps.length + 1, at: new Date().toISOString() } as TraceStep;
    this.steps.push(full);
    if (full.type === "tool") this.toolsCalled.push(full.call);
    return full;
  }

  addCost(c: RunCost): void {
    this.cost = addCost(this.cost, c);
  }

  addEvidence(refs: EvidenceRef[]): void {
    for (const e of refs) {
      const k = evidenceKey(e);
      if (!this.seen.has(k)) { this.seen.add(k); this.evidence.push(e); }
    }
  }

  columns() {
    return {
      input_tokens: this.cost.inputTokens,
      cached_input_tokens: this.cost.cachedInputTokens,
      output_tokens: this.cost.outputTokens,
      reasoning_tokens: this.cost.reasoningTokens,
      web_search_calls: this.cost.webSearchCalls,
      cost_micro_usd: this.cost.microUsd,
      steps: this.steps,
      tools_called: this.toolsCalled,
      evidence_read: this.evidence,
    };
  }

  /** Persist progress (cost + trace so far). The row stays 'running'. */
  async flush(): Promise<void> {
    if (this.finished) return;
    await this.sink.update(this.athleteId, this.runId, this.columns());
  }

  /** `approvalState`: "awaiting_approval" when the run queued a card for the athlete's tap (agent_runs.approval_state). */
  async finish(status: Exclude<RunStatus, "running">, stopReason: StopReason | null = null, error: string | null = null, approvalState: RunApprovalState | null = null): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    await this.sink.update(this.athleteId, this.runId, {
      ...this.columns(), status, stop_reason: stopReason, error: error ? error.slice(0, 1000) : null, ended_at: new Date(),
      ...(approvalState ? { approval_state: approvalState } : {}),
    });
  }
}

/**
 * Her spend since UTC midnight, in micro-dollars: every run (finished or running) in agent_runs, PLUS her voice today,
 * ESTIMATED (voice minutes × VOICE_COST_PER_MINUTE_USD: voice/voiceMinutes.ts voiceSpendTodayMicroUsd, the same
 * helper the platform total uses). Voice is billed by Gemini Live and LiveKit, not recorded per call, so its part is an
 * estimate, not a bill. Every per-athlete day cap (AGENT_DAY_COST_CAP_USD) reads this total, so time spent talking to
 * Mila counts against the same day as her text turns, research and searches; an athlete who never used voice is unchanged.
 */
export async function spentTodayMicroUsd(athleteId: string, now: Date = new Date()): Promise<number> {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [[row], voice] = await Promise.all([
    db
      .select({ total: sql<string>`coalesce(sum(${agentRuns.cost_micro_usd}), 0)` })
      .from(agentRuns)
      .where(and(eq(agentRuns.athlete_id, athleteId), gte(agentRuns.started_at, midnight))),
    voiceSpendTodayMicroUsd(athleteId, now),
  ]);
  return Number(row?.total ?? 0) + voice;
}

export function toAgentRun(r: AgentRunRow): AgentRun {
  return {
    id: r.id,
    athleteId: r.athlete_id,
    skillId: r.skill_id,
    skillVersion: r.skill_version,
    trigger: r.trigger as RunTrigger,
    model: { provider: r.provider as ModelChoice["provider"], model: r.model, effort: r.effort as ModelChoice["effort"] },
    status: r.status as RunStatus,
    stopReason: (r.stop_reason as StopReason | null) ?? null,
    approvalState: (r.approval_state as RunApprovalState | null) ?? null,
    startedAt: r.started_at.toISOString(),
    endedAt: r.ended_at ? r.ended_at.toISOString() : null,
    cost: {
      inputTokens: r.input_tokens,
      cachedInputTokens: r.cached_input_tokens,
      outputTokens: r.output_tokens,
      reasoningTokens: r.reasoning_tokens,
      webSearchCalls: r.web_search_calls,
      microUsd: Number(r.cost_micro_usd),
    },
    steps: r.steps as TraceStep[],
    toolsCalled: r.tools_called as ToolCallRecord[],
    evidenceRead: r.evidence_read as EvidenceRef[],
    conversationId: r.conversation_id ?? null,
    error: r.error ?? null,
  };
}

/** One run, scoped to its athlete (null when it is not hers). */
export async function getRun(athleteId: string, runId: string): Promise<AgentRun | null> {
  const [row] = await db.select().from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.athlete_id, athleteId))).limit(1);
  return row ? toAgentRun(row) : null;
}
