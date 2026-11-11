/**
 * identity_refresh — her change reaches My Story (Oct 2026). Started only through requestIdentityRefresh
 * (services/intelligence/identityIntelligence/refresh.ts).
 *
 * The same shape as mia_evaluation, and for the same reasons:
 *   • THE COALESCER IS THE RUNNER. One active run per athlete (`workflow_runs_one_active`), so ten edits in a minute
 *     join one run.
 *   • THE WAIT IS A STEP. The envelope is read when `run` executes, after the window, so the run sees every edit made
 *     inside it rather than the state at the first request.
 *   • IDENTITY INTELLIGENCE DECIDES. `runIdentityIntelligence` skips when its input hash is unchanged (no model call)
 *     and, here, when exactly these inputs already failed validation (the retry cap). On any failure nothing is
 *     written, so the last valid My Story stays.
 *   • A LATE EDIT IS NOT LOST. An edit that lands while the run is executing joins the active run, which has already
 *     read the envelope. So when the run is done, the envelope is hashed again (a database read) and, if it moved past
 *     what the run answered, one more request is made.
 */
import { createLogger } from "../../logger";
import { callIdentitySynthesis } from "../../services/identityIntelligenceProvider";
import { buildIdentityEnvelope } from "../../services/intelligence/identityIntelligence/envelope";
import { IDENTITY_REFRESH_DEBOUNCE_MS, IDENTITY_REFRESH_PROCESS, requestIdentityRefresh } from "../../services/intelligence/identityIntelligence/refresh";
import { runIdentityIntelligence, type RunOutcome } from "../../services/intelligence/identityIntelligence/run";
import { defineWorkflow } from "../registry";
import { runnerNow } from "../runner";

const log = createLogger("intelligence/identity-refresh");

export interface IdentityRefreshOutput { outcome: RunOutcome; inputVersion: string; entryId: string | null }

export const IDENTITY_REFRESH = defineWorkflow({
  process: IDENTITY_REFRESH_PROCESS,
  version: 1,
  onDone: async (run) => {
    const out = run.outputs.run as IdentityRefreshOutput | undefined;
    if (!run.athleteId || !out?.inputVersion) return;
    const live = (await buildIdentityEnvelope(run.athleteId, runnerNow())).inputVersion;
    if (live !== out.inputVersion) await requestIdentityRefresh(run.athleteId, "changed during the previous refresh");
  },
  steps: [
    {
      name: "wait",
      kind: "schedule",
      readyAt: () => new Date(runnerNow().getTime() + IDENTITY_REFRESH_DEBOUNCE_MS),
    },
    {
      name: "run",
      kind: "model",
      // One synthesis call plus one repair, each bounded by the provider's own timeout.
      leaseMs: 5 * 60_000,
      // Technical failures only (a thrown error). Validation failures return, and the retry cap above stops them.
      retry: { maxAttempts: 2 },
      run: async (ctx): Promise<IdentityRefreshOutput> => {
        if (!ctx.athleteId) throw new Error("identity_refresh requires an athlete");
        const r = await runIdentityIntelligence(ctx.athleteId, { synthesize: callIdentitySynthesis, now: runnerNow(), skipIfFailedBefore: true });
        log.info({ athleteId: ctx.athleteId, outcome: r.outcome, reason: (ctx.runInput as { reason?: string } | null)?.reason ?? null }, "identity refresh");
        // A provider outage is technical: throw so the runner retries it. Every other outcome is an answer.
        if (r.outcome === "provider_error") throw new Error(r.reason ?? "identity synthesis provider error");
        return { outcome: r.outcome, inputVersion: r.inputVersion, entryId: r.entryId };
      },
    },
  ],
});
