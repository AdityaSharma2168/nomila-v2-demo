/**
 * spendErrors.ts — the error every spend cap throws. A cap of any scope (a run, a job, an athlete's day, the whole
 * platform's day: lib/platformSpend.ts PlatformCapError) is a CostCapError, so one `instanceof` stops the work.
 * Re-exported by agent/research/runSkill.ts, where it was first declared.
 */
export class CostCapError extends Error {
  constructor(readonly spentMicroUsd: number, readonly capMicroUsd: number) {
    super(`cost cap reached: spent ${(spentMicroUsd / 1e6).toFixed(4)} of ${(capMicroUsd / 1e6).toFixed(2)} USD`);
  }
}
