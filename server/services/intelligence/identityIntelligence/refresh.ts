/**
 * refresh.ts — "something she owns changed: reconsider My Story" (Oct 2026).
 *
 * ONE request seam, no dependency logic at the call sites. A write path (her assertions, an Objective decision, a
 * finished research refresh) only ASKS; the `identity_refresh` workflow waits out the debounce window, then runs
 * Identity Intelligence, which decides for itself whether anything changed: its input hash (`inputVersion`) is the
 * judge, so an unchanged envelope costs a database read and no model call. The workflow runner's one-active-run-per-
 * athlete constraint coalesces a burst of edits into one run.
 *
 * Never fatal: a failed request is logged, the write that asked has already succeeded. Flag off ⇒ nothing is started.
 * M.I.A. and the Brain are NOT refreshed from here.
 * Legacy intelligence switch-off (12 Oct 2026): no NEW run for an agent-front athlete (agentFrontAthlete.ts) — whatever
 * asked (a finished legacy research run, an old-Mila record, a goal write). Her existing My Story stays readable.
 */
import { createLogger } from "../../../logger";
import { identityIntelligenceEnabled } from "./config";

const logger = createLogger("intelligence/identity-refresh");

export const IDENTITY_REFRESH_PROCESS = "identity_refresh";
/** The window starts with the FIRST request, so a run of edits is bounded rather than extended by each new one. */
export const IDENTITY_REFRESH_DEBOUNCE_MS = 3 * 60_000;

export interface IdentityRefreshInput { reason: string }

export async function requestIdentityRefresh(athleteId: string, reason: string): Promise<{ runId: string; created: boolean } | null> {
  if (!identityIntelligenceEnabled()) return null;
  try {
    const { isAgentFrontAthlete } = await import("../../agentFrontAthlete");
    if (await isAgentFrontAthlete(athleteId)) { logger.info({ athleteId, reason: reason.slice(0, 120) }, "identity refresh skipped: agent-front athlete"); return null; }
    const { startRun } = await import("../../../workflow/runner");
    const { run, created } = await startRun({ process: IDENTITY_REFRESH_PROCESS, athleteId, input: { reason: reason.slice(0, 120) } satisfies IdentityRefreshInput });
    return { runId: run.id, created };
  } catch (err: any) {
    logger.error({ athleteId, reason, error: err?.message }, "identity refresh request failed; the change is saved, My Story refreshes on the next request");
    return null;
  }
}
