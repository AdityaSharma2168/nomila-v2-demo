/**
 * spendGuard.test.ts — refuse up front, never truncate (PR 16, R-13, M9/M10).
 */
import {
  guardRun,
  MAX_CALLS,
  PER_CALL_CEILING_USD,
  reportRun,
} from "./spendGuard";

describe("spendGuard", () => {
  it("the quoted cells pass as quoted: S-1 26 calls at $1.95, S-2 39 calls at $2.93", () => {
    expect(guardRun({ calls: 26, quotedUsd: 1.95 })).toEqual({
      ok: true,
      ceilingUsd: 1.95,
    });
    expect(guardRun({ calls: 39, quotedUsd: 2.93 })).toEqual({
      ok: true,
      ceilingUsd: 2.93,
    });
  });
  it("a run exceeds MAX_CALLS — refused whole", () => {
    expect(MAX_CALLS).toBe(80);
    expect(guardRun({ calls: 81, quotedUsd: 100 }).ok).toBe(false);
  });
  it("a run exceeds the per-call ceiling — refused whole", () => {
    expect(PER_CALL_CEILING_USD).toBe(0.075);
    expect(guardRun({ calls: 26, quotedUsd: 1.5 }).ok).toBe(false);
  });
  it("after a run it reports, never stops", () => {
    expect(
      reportRun({ calls: 26, ceilingUsd: 1.95, billedUsd: 2.1 }),
    ).toContain("OVER the ceiling");
  });
});
