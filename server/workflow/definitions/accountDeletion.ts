/**
 * account_deletion v2 — account deletion phase 2 (server/services/privacy/accountDeletionSteps.ts has the steps and
 * the reasons). Started only by phase 1 (deleteAthleteAccount.ts requestAccountDeletion), in the same small transaction
 * that marks the athlete as deleting. The run is athlete-less (athlete_id NULL, input.subject_athlete_id names whose
 * account it is), so it is never itself purged and never fenced; it is the deletion receipt.
 *
 * v1 receipts (the single-transaction delete) were written already finished and are never executed by the runner.
 */
import { defineWorkflow } from "../registry";
import {
  DELETION_PROCESS, fenceStep, financialRecordsStep, finishStep, purgeExternalStep, purgeRowsStep, snapshotStep, verifyStep,
  type DeletionRunInput,
} from "../../services/privacy/accountDeletionSteps";

/** purge_external tries: 1 min, 3 min, 9 min … capped at 2 h between tries (about 8 h in all), then what is left fails. */
export const PURGE_EXTERNAL_ATTEMPTS = 8;

const input = (x: unknown) => x as DeletionRunInput;

export const ACCOUNT_DELETION = defineWorkflow({
  process: DELETION_PROCESS,
  version: 2,
  steps: [
    // Up to ~7 min of retries: past TURN_WINDOW_MS a turn still marked running is stale and no longer waited for.
    { name: "fence", kind: "code", run: (ctx) => fenceStep(ctx.runId, input(ctx.runInput)),
      retry: { maxAttempts: 12, factor: 1.5, minTimeoutMs: 10_000, maxTimeoutMs: 60_000, randomize: false } },
    { name: "snapshot", kind: "code", run: (ctx) => snapshotStep(ctx.runId, input(ctx.runInput)) },
    { name: "financial_records", kind: "code", run: (ctx) => financialRecordsStep(ctx.runId, input(ctx.runInput)) },
    { name: "purge_rows", kind: "code", run: (ctx) => purgeRowsStep(ctx.runId, input(ctx.runInput)), leaseMs: 15 * 60_000,
      retry: { maxAttempts: 5, factor: 2, minTimeoutMs: 15_000, maxTimeoutMs: 5 * 60_000 } },
    { name: "purge_external", kind: "code", leaseMs: 15 * 60_000,
      run: (ctx) => purgeExternalStep(ctx.runId, input(ctx.runInput), ctx.attempt >= PURGE_EXTERNAL_ATTEMPTS),
      retry: { maxAttempts: PURGE_EXTERNAL_ATTEMPTS, factor: 3, minTimeoutMs: 60_000, maxTimeoutMs: 2 * 60 * 60_000, randomize: true } },
    { name: "verify", kind: "code", run: (ctx) => verifyStep(ctx.runId, input(ctx.runInput)),
      retry: { maxAttempts: 5, factor: 2, minTimeoutMs: 30_000, maxTimeoutMs: 10 * 60_000 } },
    // Complete only when everything is confirmed; otherwise the run fails at once with the report (no retry).
    { name: "finish", kind: "code", run: (ctx) => finishStep(ctx.runId, input(ctx.runInput)), retry: { maxAttempts: 1 } },
  ],
});
