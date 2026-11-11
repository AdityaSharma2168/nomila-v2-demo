/**
 * studio/agent/eval/spendGuard — REFUSE UP FRONT, NEVER TRUNCATE (PR 16, R-13).
 *
 * Before the first call: a run whose planned calls exceed MAX_CALLS, or whose planned calls ×
 * PER_CALL_CEILING_USD exceed the cell's quoted ceiling, is refused whole — nothing is sent. A run is
 * never cut short midway: a half-run is a sheet with holes and money spent on it. After a run, billed
 * tokens are compared to the ceiling and REPORTED, never enforced after the fact.
 * ⚠️ MUTATIONS (spendGuard.test): drop either comparison — "a run exceeds MAX_CALLS" and "a run exceeds
 * the per-call ceiling" red by name.
 */

/** The eval's hard cap on model calls per run (studioPlanEval.ts:61's default). */
export const MAX_CALLS = 80;
/** The planner's upper per-call cost (docs/probes/ingest-flip.md:185-199; studioPlanRoute.ts:103). */
export const PER_CALL_CEILING_USD = 0.075;

export type GuardAnswer =
  | { ok: true; ceilingUsd: number }
  | { ok: false; reason: string };

/** Up front: may this run start at all? `quotedUsd` is the ceiling Adi gave the go for. */
export function guardRun(planned: {
  calls: number;
  quotedUsd: number;
}): GuardAnswer {
  const { calls, quotedUsd } = planned;
  if (!Number.isInteger(calls) || calls < 1)
    return {
      ok: false,
      reason: `planned calls must be a positive integer, got ${calls}`,
    };
  if (calls > MAX_CALLS)
    return {
      ok: false,
      reason: `${calls} calls exceed MAX_CALLS ${MAX_CALLS} — refused whole, nothing sent`,
    };
  const ceilingUsd = Math.round(calls * PER_CALL_CEILING_USD * 100) / 100;
  if (ceilingUsd > quotedUsd + 1e-9)
    return {
      ok: false,
      reason: `${calls} calls × $${PER_CALL_CEILING_USD} = $${ceilingUsd.toFixed(2)} exceeds the quoted $${quotedUsd.toFixed(2)} — refused whole, nothing sent`,
    };
  return { ok: true, ceilingUsd };
}

/** After: what was billed against the ceiling — a report line, never a stop. */
export function reportRun(run: {
  calls: number;
  ceilingUsd: number;
  billedUsd: number | null;
}): string {
  if (run.billedUsd === null)
    return `${run.calls} calls; billed amount unknown (tokens only) — ceiling $${run.ceilingUsd.toFixed(2)}`;
  const over = run.billedUsd > run.ceilingUsd;
  return `${run.calls} calls; billed ≈ $${run.billedUsd.toFixed(2)} against the ceiling $${run.ceilingUsd.toFixed(2)}${over ? " — OVER the ceiling: report to Adi" : ""}`;
}
