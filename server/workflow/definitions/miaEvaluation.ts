/**
 * mia_evaluation — one run per athlete per debounce window, from "something changed" to a score of record.
 *
 * THE COALESCER IS THE RUNNER, not a queue we wrote. `workflow_runs_one_active` is unique on
 * (athlete_id, active_scope), so the second and third events for an athlete inside the window hit that constraint and
 * `startRun` hands back the run already in flight. An Instagram connect at 10:00, a YouTube connect at 10:04 and a
 * social sync at 10:07 therefore produce ONE run — and one ~$0.21 provider call — not three.
 *
 * THE WAIT IS A STEP, WHICH IS THE WHOLE POINT. Because `wait` is a scheduled step and `snapshot` runs after it, the
 * evidence is assembled at 10:10 from whatever is authoritative at 10:10. Had the snapshot been captured when the run
 * was created, the coalesced run would evaluate the athlete as they looked at 10:00 — deliberately spending the call
 * on evidence we already knew was two connects out of date. The debounce coalesces orchestration; it never freezes
 * evidence.
 *
 * MANUAL REFRESH IS THE EXCEPTION, AND HAS ITS OWN SCOPE. A person asking for a refresh should not silently join a
 * debounced run that is about to decide nothing changed and skip. So a forced run gets its own active scope: it starts
 * immediately, evaluates regardless of the digest, and still records the digest the ordinary way — which is what makes
 * "same supplied evidence, different grounded research" legible afterwards instead of looking like an input change.
 */

import {
  MIA_DEBOUNCE_MS, MIA_EVALUATION_PROCESS,
  buildAndPersistSnapshot, miaIdentityGate, requestEvaluationIfOwed, runEvaluation, scoreAndRecord,
  type SnapshotStepOutput,
} from "../../services/marketabilityBeta1Orchestrator";
import { onIdentityResolved, type IdentityValue } from "../../services/intelligence/research/identityResolution";
import { isMemoryAthlete } from "../../services/miaPreview/memoryAdapter";
import { createLogger } from "../../logger";
import { TRIGGER_REASONS, type TriggerReason } from "../../services/marketabilityBeta1Snapshot";
import { defineWorkflow } from "../registry";
import { runnerNow } from "../runner";

const log = createLogger("mia:evaluation");

/** The snapshot step's skip for an athlete with no memory facts: nothing to score from yet, and nothing searches. */
export const NO_FACTS = "no_facts";

/**
 * The identity gate's record (PR H1). Returned by `snapshot` instead of a snapshot when the gate refuses, so the run
 * itself is the durable record of the deferred request: its input says which trigger asked, and its steps say why
 * nothing was evaluated. Once identity resolves, the listener at the end of this file re-requests it (PR H2).
 */
export interface IdentityBlockedOutput {
  blocked: "identity_gate";
  identity: IdentityValue;
  trigger: TriggerReason;
  force: boolean;
}

export interface MiaEvaluationInput {
  trigger: TriggerReason;
  /** Manual refresh: start now and evaluate even when the evidence is unchanged. */
  force?: boolean;
  /** The M.I.A. preview: start now, but an unchanged digest still skips (no second paid call). */
  immediate?: boolean;
  /** Why a person asked. Recorded on the snapshot, never sent to the evaluator. */
  reason?: string | null;
}

export function miaEvaluationInput(runInput: unknown): MiaEvaluationInput {
  const i = (runInput ?? {}) as Partial<MiaEvaluationInput>;
  if (!i.trigger || !(TRIGGER_REASONS as readonly string[]).includes(i.trigger)) {
    throw new Error(`mia_evaluation needs { trigger ∈ ${TRIGGER_REASONS.join("|")} }`);
  }
  return { trigger: i.trigger, force: !!i.force, immediate: !!i.immediate, reason: i.reason ?? null };
}

/** A forced run must never be absorbed by a debounced one, or a person's refresh would silently become a skip. */
export const miaEvaluationScope = (input: unknown): string =>
  (input as any)?.force ? `${MIA_EVALUATION_PROCESS}:forced` : (input as any)?.immediate ? `${MIA_EVALUATION_PROCESS}:immediate` : MIA_EVALUATION_PROCESS;

export const MIA_EVALUATION = defineWorkflow({
  process: MIA_EVALUATION_PROCESS,
  version: 1,
  activeScope: miaEvaluationScope,
  /**
   * THE BLOCKED-RUN RE-CHECK (PR H2). A request made while an identity-blocked run is still finishing (its evaluate and
   * score steps) joins that run through the active-scope constraint — and that run will never evaluate. So when a
   * blocked run is DONE (no longer holding the scope), identity is read again: resolved and still owed ⇒ the ordinary
   * IDENTITY_RESOLVED request (debounced, not forced). Not done from inside `score`: the run is still active there, and
   * a same-scope request would only join it again. requestEvaluationIfOwed owns the flag, the gate and the owed /
   * in-flight checks, so this never duplicates a request and does nothing with the flag off.
   */
  onDone: async (run) => {
    if (!run.athleteId || (run.outputs.snapshot as any)?.blocked !== "identity_gate") return;
    await requestEvaluationIfOwed(run.athleteId, { transition: "blocked_run_done" });
  },
  steps: [
    {
      name: "wait",
      kind: "schedule",
      // The window starts when the FIRST event arrived, so a cascade is bounded by ten minutes total rather than
      // extended by each new event — an athlete connecting accounts steadily would otherwise never reach evaluation.
      readyAt: (ctx) => { const i = miaEvaluationInput(ctx.runInput); return new Date(runnerNow().getTime() + (i.force || i.immediate ? 0 : MIA_DEBOUNCE_MS)); },
    },
    {
      name: "snapshot",
      kind: "code",
      leaseMs: 2 * 60_000,
      run: async (ctx) => {
        const { trigger, reason } = miaEvaluationInput(ctx.runInput);
        if (!ctx.athleteId) throw new Error("mia_evaluation requires an athlete");
        // THE CHOKE POINT for the identity invariant (see miaIdentityGate). Before any snapshot or provider call, for
        // every trigger. Flag off ⇒ always permitted, and nothing below changes.
        const gate = await miaIdentityGate(ctx.athleteId);
        if (!gate.permitted) {
          const { force } = miaEvaluationInput(ctx.runInput);
          log.info({ athleteId: ctx.athleteId, trigger, force, identity: gate.identity }, "mia evaluation deferred: identity not resolved");
          return { blocked: gate.reason, identity: gate.identity, trigger, force: !!force } satisfies IdentityBlockedOutput;
        }
        // Built HERE, at execution time — see the module note. Returns null for an athlete with no resolvable sport
        // (the evaluator needs one, and guessing would be inventing evidence) and for an athlete with no memory facts:
        // M.I.A. scores only from facts we hold and never searches for her (4 Nov 2026) — "no facts yet".
        const out = await buildAndPersistSnapshot(ctx.athleteId, trigger, { triggerDetail: reason });
        if (out) return out;
        return (await isMemoryAthlete(ctx.athleteId)) ? { skipped: "no resolvable identity" } : { skipped: NO_FACTS };
      },
    },
    {
      name: "evaluate",
      kind: "model",
      // A grounded evaluation with default thinking runs ~85s; the lease has to outlast a slow one or the runner
      // would reclaim a step that is still mid-call and pay for the same question twice.
      leaseMs: 5 * 60_000,
      // Two retries, technical failures only. A validation failure returns rather than throws (it would reproduce),
      // so it never reaches this policy.
      retry: { maxAttempts: 3 },
      run: async (ctx) => {
        const { force } = miaEvaluationInput(ctx.runInput);
        const snap = ctx.outputs.snapshot as SnapshotStepOutput | { skipped: string } | IdentityBlockedOutput;
        // Blocked by the identity gate: no provider call. The status carries the reason through to `score`.
        if ("blocked" in snap) return { status: "blocked_identity", reason: snap.blocked, identity: snap.identity };
        if (!("snapshotId" in snap)) return { status: snap.skipped === NO_FACTS ? "skipped_no_facts" : "skipped_no_identity" };
        if (snap.unchanged && !force) {
          // The evidence is identical to a question already answered. Asking again would sample the evaluator's
          // non-determinism (a measured mean of 20.5 MIA points of drift) and call it news.
          return { status: "skipped_unchanged", snapshotId: snap.snapshotId, digest: snap.digest };
        }
        return runEvaluation(snap.snapshotId, ctx.attempt);
      },
    },
    {
      name: "score",
      kind: "code",
      leaseMs: 60_000,
      run: async (ctx) => {
        const ev = ctx.outputs.evaluate as { runId?: string; status: string };
        // No run id means nothing was asked, and no assessment means nothing to record. Both are ordinary outcomes,
        // not failures — a skip is the system working.
        if (!ev?.runId || ev.status !== "ok") return { recorded: false, reason: ev?.status ?? "no evaluation" };
        const scored = await scoreAndRecord(ev.runId);
        return scored ? { recorded: true, ...scored } : { recorded: false, reason: "run produced no judgements" };
      },
    },
  ],
});

/**
 * R-a (PR H2): when identity_resolution is WRITTEN to `resolved` (T2 by Q1, T6 by her confirmation, T10 by a TTL re-run),
 * request the evaluation that is owed — a request the identity gate held, or a first assessment she does not have yet.
 * Registered here, beside the workflow it starts, so the research modules never depend on M.I.A. (the seam lives in
 * identityResolution.ts). Owed-ness, idempotency and the flag are requestEvaluationIfOwed's; the H1 gate in the
 * snapshot step stays the final guard.
 */
onIdentityResolved(MIA_EVALUATION_PROCESS, (e) => requestEvaluationIfOwed(e.athleteId, { transition: e.transition }));
