/**
 * reroll.test.ts — what a failed clip recommends, and the four times it recommends nothing.
 *
 * The rule under test is a MONEY rule, not a product preference. `spentTodayUsd` banks a quote at
 * INSERT, so anything that spends without opening a row spends money the day ceiling never sees.
 * Everything here exists to keep the recommendation a record rather than an action.
 */
import { rerollFor } from "./reroll";
import type { CheckName, CreativeQaVerdict } from "../qa/verdict";
import type { CheckResult, CheckStatus } from "../qa/types";

const spend = () => ({
  usd: 0,
  basis: "estimated" as const,
  visionCalls: 0,
  embedCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
});

const res = (
  status: CheckStatus,
  summary = "said something",
): CheckResult<never> => ({
  status,
  summary,
  detail: null,
  error: status === "unknown" ? "could not answer" : null,
  spend: spend(),
  latencyMs: 1,
});

const frame = (timeSec: number, anatomy: CheckStatus, text: CheckStatus) =>
  ({
    timeSec,
    role: timeSec === 0 ? "anchor" : "peak",
    drift: timeSec === 0 ? 0 : 0.5,
    checks: { anatomy: res(anatomy), text: res(text), marks: null },
    identityObservation: null,
  }) as never;

function verdict(
  over: Partial<Record<CheckName, CheckStatus>> = {},
  opts: { overall?: "pass" | "flag" | "fail"; frames?: unknown[] } = {},
): CreativeQaVerdict {
  const by = {
    identity: "unknown",
    marks: "pass",
    anatomy: "pass",
    adherence: "unknown",
    text: "pass",
    ...over,
  } as Record<CheckName, CheckStatus>;
  return {
    schemaVersion: 6,
    at: "2026-09-19T00:00:00.000Z",
    overall: opts.overall ?? "fail",
    unknownChecks: 2,
    advisoryChecks: [],
    checks: {
      identity: res(by.identity),
      marks: res(by.marks, "a swoosh arrived"),
      anatomy: res(by.anatomy, "three hands visible"),
      adherence: res(by.adherence),
      text: res(by.text, "a name on the kit"),
    },
    subject: "clip",
    spend: spend(),
    latencyMs: 10,
    comparison: {
      rootAssetId: "c",
      outputAssetId: "c",
      chainDepth: 0,
      chainTruncated: false,
    },
    clip: {
      coverage: { checked: 3, scanned: 24, total: 145 },
      motionless: false,
      frames: (opts.frames ?? [
        frame(0, "pass", "pass"),
        frame(2, by.anatomy, by.text),
        frame(5.75, "pass", "pass"),
      ]) as never,
    },
  } as CreativeQaVerdict;
}

const ctx = { shotType: "identity" as const, quotedUsd: 1.2 };

describe("it recommends when a gating check failed", () => {
  it("names the check, the frame and what a re-run costs — and says it did nothing", () => {
    const advice = rerollFor(verdict({ anatomy: "fail" }), ctx)!;
    expect(advice).not.toBeNull();
    expect(advice.reasons).toEqual([
      { check: "anatomy", atSec: 2, summary: "three hands visible" },
    ]);
    expect(advice.shotType).toBe("identity");
    // The SAME figure the clip was quoted. A re-roll of the same brief is the same job at the same
    // price, and recomputing it here could disagree with what she approved.
    expect(advice.quoteUsd).toBe(1.2);
    // On the record, so a reader of a stored verdict learns the posture from the verdict.
    expect(advice.acted).toBe(false);
  });

  it("names every failing gating check, not just the first", () => {
    const advice = rerollFor(verdict({ anatomy: "fail", text: "fail" }), ctx)!;
    expect(advice.reasons.map((r) => r.check).sort()).toEqual([
      "anatomy",
      "text",
    ]);
  });

  it("reads the frame off the per-frame records, not out of a summary string", () => {
    // The roll-up's summary is formatted for a human ("At 2.00s — ..."). A regex over it would
    // break the first time that wording moved; the per-frame records are structured data.
    const advice = rerollFor(
      verdict(
        { anatomy: "fail" },
        { frames: [frame(0, "pass", "pass"), frame(4.25, "fail", "pass")] },
      ),
      ctx,
    )!;
    expect(advice.reasons[0].atSec).toBe(4.25);
  });

  it("says null, never zero, when it cannot price a re-run", () => {
    // pricing.ts refuses a confident zero and so does this: $0.00 shown for a clip that costs
    // $1.20 is worse than showing nothing.
    for (const quotedUsd of [null, undefined, NaN, Infinity]) {
      const advice = rerollFor(verdict({ anatomy: "fail" }), {
        shotType: "broll",
        quotedUsd: quotedUsd as number | null,
      })!;
      expect(advice.quoteUsd).toBeNull();
    }
  });
});

describe("the four times it recommends nothing", () => {
  it("a pass", () => {
    expect(rerollFor(verdict({}, { overall: "pass" }), ctx)).toBeNull();
  });

  it("a pass carrying unknowns — a check that could not look has found nothing wrong", () => {
    // Charging her again because a check could not answer would invert the whole point of
    // `unknown` being a distinct value from `pass`.
    const v = verdict(
      { anatomy: "unknown", text: "unknown" },
      { overall: "pass" },
    );
    expect(v.unknownChecks).toBeGreaterThan(0);
    expect(rerollFor(v, ctx)).toBeNull();
  });

  it("a FLAG — worth a human's attention is not the same as worth her money", () => {
    expect(
      rerollFor(verdict({ anatomy: "flag" }, { overall: "flag" }), ctx),
    ).toBeNull();
  });

  it("marks alone, however loudly it failed", () => {
    // 16 false positives against 6 true negatives on the 36-row corpus. A recommendation driven by
    // a check that fires on three good clips in four would be a bill for nothing, four times in
    // five — which is why marks is advisory everywhere else too.
    const v = verdict({ marks: "fail" });
    expect(v.checks.marks.status).toBe("fail");
    expect(rerollFor(v, ctx)).toBeNull();
  });

  it("a verdict that is not about a clip at all", () => {
    const v = { ...verdict({ anatomy: "fail" }), subject: "generate" as const };
    expect(rerollFor(v, ctx)).toBeNull();
  });
});
