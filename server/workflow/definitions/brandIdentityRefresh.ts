/**
 * brand_identity_refresh — a brand gained domain evidence (or an athlete confirmed it): re-check its identity, then
 * picture it from its own site. Started only through requestBrandIdentityRefresh (services/brandIdentityRefresh.ts).
 *
 *   • THE COALESCER IS THE RUNNER. One active run per (athlete, brand) — activeScope carries the brand id — so a burst
 *     of emails from one brand joins one run.
 *   • THE WAIT IS A STEP. The row is read when `run` executes, after the window, so the run sees every domain fill and
 *     confirmation made inside it (and ingest's own research of a new brand has landed).
 *   • THE JOB DECIDES. runBrandIdentityRefresh caps research per brand and only pictures a trusted domain; a request
 *     with nothing left to do finishes without a provider call. No onDone: nothing here re-requests itself.
 */
import { createLogger } from "../../logger";
import {
  BRAND_IDENTITY_DEBOUNCE_MS, BRAND_IDENTITY_REFRESH_PROCESS, brandIdentityScope, runBrandIdentityRefresh,
  type BrandIdentityRefreshInput, type BrandIdentityRefreshOutcome,
} from "../../services/brandIdentityRefresh";
import { defineWorkflow } from "../registry";
import { runnerNow } from "../runner";

const log = createLogger("workflow/brand-identity-refresh");

export const BRAND_IDENTITY_REFRESH = defineWorkflow({
  process: BRAND_IDENTITY_REFRESH_PROCESS,
  version: 1,
  activeScope: brandIdentityScope,
  steps: [
    {
      name: "wait",
      kind: "schedule",
      readyAt: () => new Date(runnerNow().getTime() + BRAND_IDENTITY_DEBOUNCE_MS),
    },
    {
      name: "run",
      kind: "model",
      // Four grounded searches + one extraction + two homepage/image fetches, each bounded by its own timeout.
      leaseMs: 5 * 60_000,
      retry: { maxAttempts: 2 },
      run: async (ctx): Promise<BrandIdentityRefreshOutcome> => {
        const input = (ctx.runInput ?? {}) as unknown as BrandIdentityRefreshInput;
        if (!Number.isInteger(input.brandId)) throw new Error("brand_identity_refresh requires a brandId");
        const out = await runBrandIdentityRefresh(input, { now: runnerNow() });
        log.info({ athleteId: ctx.athleteId, reason: input.reason, ...out }, "brand identity refresh");
        return out;
      },
    },
  ],
});
