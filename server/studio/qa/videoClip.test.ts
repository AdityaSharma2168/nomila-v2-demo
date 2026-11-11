/**
 * videoClip.test.ts — the two properties a clip verdict must have, and the arithmetic under them.
 *
 * The four checks are MOCKED. What is under test is the composition — which frames get which
 * questions, how frames roll up into one verdict, what the record says about what was not looked
 * at, and that identity cannot reach the overall from any of those directions. The checks
 * themselves are covered by their own suites against real images.
 *
 * Frames are real files with dummy bytes, because `checkFrame` reads them off disk and mocking
 * `fs` to test a composer would be testing the mock.
 */
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import type { QaSpend } from "./cost";
import type { CheckResult, CheckStatus } from "./types";
import type { FrameSample, FrameStrip } from "../video/frames";

jest.mock("./anatomy", () => ({ checkAnatomy: jest.fn() }));
jest.mock("./text", () => ({ checkText: jest.fn() }));
jest.mock("./marks", () => ({ checkMarks: jest.fn() }));
jest.mock("./identity", () => ({ checkIdentity: jest.fn() }));

import { checkAnatomy } from "./anatomy";
import { checkIdentity } from "./identity";
import { checkMarks } from "./marks";
import { checkText } from "./text";
import { runClipQa } from "./videoClip";

const anatomyMock = checkAnatomy as jest.Mock;
const textMock = checkText as jest.Mock;
const marksMock = checkMarks as jest.Mock;
const identityMock = checkIdentity as jest.Mock;

const spend = (usd: number): QaSpend => ({
  usd,
  basis: "estimated",
  visionCalls: 1,
  embedCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
});

const res = (
  status: CheckStatus,
  summary = "the check said something",
  usd = 0.001,
): CheckResult<never> => ({
  status,
  summary,
  detail: null,
  error: status === "unknown" ? "could not answer" : null,
  spend: spend(usd),
  latencyMs: 5,
});

/** Every check answers `status` on every frame unless a test overrides one. */
function setAll(status: CheckStatus, usd = 0.001) {
  anatomyMock.mockResolvedValue(res(status, "anatomy", usd));
  textMock.mockResolvedValue(res(status, "text", usd));
  marksMock.mockResolvedValue(res(status, "marks", usd));
  identityMock.mockResolvedValue(res(status, "identity", usd));
}

let dir: string;
let strip: FrameStrip;
let sample: FrameSample;

/** t=0 anchor · t=2 peak (the shape of V2b's hard cell) · t=5.75 last, back near the anchor. */
const CURVE = [0, 0.8, 0.01];

beforeEach(async () => {
  jest.clearAllMocks();
  dir = await mkdtemp(join(tmpdir(), "clipqa-"));
  const paths = await Promise.all(
    [0, 1, 2].map(async (i) => {
      const p = join(dir, `f-${i}.jpg`);
      await writeFile(p, Buffer.from([0xff, 0xd8, i]));
      return p;
    }),
  );
  strip = {
    dir,
    frames: [
      { path: paths[0], timeSec: 0 },
      { path: paths[1], timeSec: 2 },
      { path: paths[2], timeSec: 5.75 },
    ],
    durationSec: 6,
    plan: { kind: "fps", fps: 4 },
    dispose: async () => {},
  };
  sample = {
    frames: [
      { index: 0, timeSec: 0, drift: 0, role: "anchor" },
      { index: 1, timeSec: 2, drift: 0.8, role: "peak" },
      { index: 2, timeSec: 5.75, drift: 0.01, role: "last" },
    ],
    coverage: { checked: 3, scanned: 24, total: 145 },
    motionless: false,
  };
  setAll("pass");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const run = () =>
  runClipQa({
    assetId: "clip-1",
    strip,
    curve: CURVE,
    sample,
    instruction: "she looks into the camera",
  });

describe("runClipQa", () => {
  /**
   * ⭐ REVERT CHECK `identity-never-gates-a-clip`.
   *
   * MUTATION: in videoClip.ts, build `byCheck` with the observed per-frame identity status instead
   * of the `unknown` roll-up — e.g. `identity: frames[1].identityObservation?.status ?? "unknown"`.
   * The clip below then reports `overall: "fail"` on a ruler that cannot separate the athlete from
   * a stranger, and both assertions red by name.
   *
   * This is the single most consequential property in the card. qa/identity.ts records that an
   * invented person scored 0.3584 against her held-out photographs, INSIDE her own same-person band
   * of 0.3158-0.4186. A verdict built on that number would tell an athlete her own clip is not her.
   */
  it("identity-never-gates-a-clip: a failing identity at every frame moves nothing", async () => {
    setAll("pass");
    // The worst thing this metric can say, said at every frame that has an answer.
    identityMock.mockResolvedValue(res("fail", "the face moved past the band"));

    const v = await run();

    expect(v.overall).toBe("pass");
    expect(v.checks.identity.status).toBe("unknown");
    // And the observations ARE on the record — the point is that they are recorded, not hidden.
    const observed = v.clip!.frames.filter((f) => f.identityObservation);
    expect(observed).toHaveLength(2);
    expect(observed[0].identityObservation!.status).toBe("fail");
  });

  it("identity is not even a key in a frame's `checks`, so no roll-up can reach it", async () => {
    // Structural rather than behavioural: `combine()` summarises `checks`, so a field that is not
    // in `checks` cannot be promoted by a future aggregation, a refactor or a well-meaning addition.
    const v = await run();
    expect(Object.keys(v.clip!.frames[1].checks).sort()).toEqual([
      "anatomy",
      "marks",
      "text",
    ]);
  });

  /**
   * ⭐ REVERT CHECK `coverage-is-recorded`.
   *
   * MUTATION, and the sharp one is the second: setting `coverage.total` to `coverage.scanned` —
   * the PLAUSIBLE bug, where "we looked at everything we extracted" is mistaken for "we looked at
   * the whole clip". That reds this test and only this test (1 failed / 12 passed). Not attaching
   * the detail at all also reds it, but takes five other tests with it and proves less.
   *
   * A clip verdict that says "pass" without saying how much of the clip it saw is making exactly
   * the claim qa/types.ts exists to forbid.
   */
  it("coverage-is-recorded: a passing verdict still says it saw 3 of 145 frames", async () => {
    const v = await run();
    expect(v.overall).toBe("pass");
    expect(v.subject).toBe("clip");
    expect(v.clip!.coverage).toEqual({ checked: 3, scanned: 24, total: 145 });
    expect(v.clip!.coverage.checked).toBeLessThan(v.clip!.coverage.total);
    expect(v.clip!.frames.map((f) => f.role)).toEqual([
      "anchor",
      "peak",
      "last",
    ]);
  });

  it("asks marks of every frame EXCEPT the anchor, which is the thing being compared against", async () => {
    await run();
    // Two comparison frames, not three: the anchor is frame 0, and "arrived / vanished / redrawn"
    // measured against itself is not a question.
    expect(marksMock).toHaveBeenCalledTimes(2);
    expect(identityMock).toHaveBeenCalledTimes(2);
    // Anatomy and text read one image, so every sampled frame gets them.
    expect(anatomyMock).toHaveBeenCalledTimes(3);
    expect(textMock).toHaveBeenCalledTimes(3);
  });

  it("records the anchor's marks as null rather than unknown", async () => {
    const v = await run();
    // null is "there was nothing to ask"; unknown is "we asked and could not tell". A reader of the
    // stored record has to be able to tell those apart.
    expect(v.clip!.frames[0].checks.marks).toBeNull();
    expect(v.clip!.frames[0].identityObservation).toBeNull();
    expect(v.clip!.frames[1].checks.marks).not.toBeNull();
  });

  it("rolls a check up to its worst ANSWER and names the frame that gave it", async () => {
    anatomyMock
      .mockResolvedValueOnce(res("pass", "fine at the anchor"))
      .mockResolvedValueOnce(res("fail", "three hands"))
      .mockResolvedValueOnce(res("pass", "fine at the end"));

    const v = await run();
    expect(v.checks.anatomy.status).toBe("fail");
    expect(v.overall).toBe("fail");
    expect(v.checks.anatomy.summary).toContain("2.00s");
    expect(v.checks.anatomy.summary).toContain("three hands");
  });

  it("prefers the EARLIEST frame when two share the worst status", async () => {
    anatomyMock
      .mockResolvedValueOnce(res("pass", "fine"))
      .mockResolvedValueOnce(res("fail", "broke here first"))
      .mockResolvedValueOnce(res("fail", "still broken"));
    const v = await run();
    // When it went wrong is more useful than that it was still wrong later.
    expect(v.checks.anatomy.summary).toContain("2.00s");
    expect(v.checks.anatomy.summary).toContain("broke here first");
  });

  it("an unknown frame neither drags the roll-up down nor lifts it", async () => {
    anatomyMock
      .mockResolvedValueOnce(res("unknown", "could not see the anchor"))
      .mockResolvedValueOnce(res("pass", "fine"))
      .mockResolvedValueOnce(res("pass", "fine"));
    const v = await run();
    // One frame could not answer and two could. The answer is pass, and the frame that could not
    // answer is on the per-frame record rather than folded into the status.
    expect(v.checks.anatomy.status).toBe("pass");
    expect(v.clip!.frames[0].checks.anatomy.status).toBe("unknown");
  });

  it("every frame unknown rolls up to unknown, never to pass", async () => {
    anatomyMock.mockResolvedValue(res("unknown", "could not answer"));
    const v = await run();
    expect(v.checks.anatomy.status).toBe("unknown");
    expect(v.unknownChecks).toBeGreaterThanOrEqual(3);
  });

  it("counts what the discarded identity answers COST, because an unknown verdict still billed", async () => {
    setAll("pass", 0.002);
    const v = await run();
    // 3 anatomy + 3 text + 2 marks + 2 identity = 10 calls at $0.002. Carrying zeroSpend() on the
    // identity roll-up — which is what the first draft of this file did — reports the stage at
    // $0.016 instead of $0.020, and that is the "confident zero" qa/cost.ts refuses.
    expect(v.spend.usd).toBeCloseTo(0.02, 6);
    expect(v.checks.identity.spend.usd).toBeCloseTo(0.004, 6);
    expect(v.checks.identity.status).toBe("unknown");
  });

  it("marks stays advisory on a clip, exactly as it is on an image", async () => {
    setAll("pass");
    marksMock.mockResolvedValue(res("fail", "a swoosh arrived"));
    const v = await run();
    expect(v.checks.marks.status).toBe("fail");
    // 27% specificity on the 36-row corpus. Recorded in full, excluded from the overall, and the
    // reason travels on the record so a reader learns it without opening the source.
    expect(v.overall).toBe("pass");
    expect(v.advisoryChecks).toEqual([
      expect.objectContaining({ check: "marks", status: "fail" }),
    ]);
  });

  it("a frame it cannot read is unknown, not a thrown generation", async () => {
    strip.frames[1] = { path: join(dir, "does-not-exist.jpg"), timeSec: 2 };
    const v = await run();
    expect(v.clip!.frames[1].checks.anatomy.status).toBe("unknown");
    expect(v.clip!.frames[1].checks.marks).toBeNull();
    // The other frames still answered, so the clip still has a verdict.
    expect(v.clip!.frames[0].checks.anatomy.status).toBe("pass");
  });

  it("adherence is unknown with a reason, not a silent pass", async () => {
    const v = await run();
    expect(v.checks.adherence.status).toBe("unknown");
    expect(v.checks.adherence.summary).toContain("changed nothing");
  });
});
