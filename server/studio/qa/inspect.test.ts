/**
 * qa/inspect — the depth-0 branch, which used to be `return null` and is the reason no generated
 * image has ever been inspected.
 *
 * The db is mocked rather than PGlite-backed: every assertion here is about which BRANCH runs for a
 * given row shape, and the queries themselves are two `select … where id AND athlete_id` reads that
 * chain.test.ts already covers against real SQL.
 */
jest.mock("../../db", () => ({ db: { select: jest.fn() } }));
jest.mock("./chain", () => ({ findChainRoot: jest.fn() }));
jest.mock("./record", () => ({ writeVerdict: jest.fn(async () => true) }));
jest.mock("../../lib/mediaStore", () => ({
  signedUrl: jest.fn(async () => "https://signed.invalid/x.png"),
}));
jest.mock("./verdict", () => ({
  runCreativeQa: jest.fn(async () => ({ overall: "pass" })),
  runGenerateQa: jest.fn(async () => ({ overall: "fail" })),
  // The real merge is verdict.test.ts's to prove; here it only has to show what reached it.
  withIdentityObservation: (v: object, o: object | null) =>
    o ? { ...v, identityObservation: o } : v,
  withFramingObservation: (v: object, o: object | null) =>
    o ? { ...v, framingObservation: o } : v,
  summarize: () => "summary",
}));
// The instrument is framing.test.ts's to calibrate; here only its GATE is under test, and mocking it
// keeps ~5s of sharp numerics out of a suite about which branch runs.
jest.mock("./framing", () => ({
  observeAddFraming: jest.fn(async () => null),
}));
jest.mock("./identitySet", () => ({
  identityTargetsFor: jest.fn(async () => []),
}));
jest.mock("./identity", () => ({ observeGenerateIdentity: jest.fn() }));

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../../db";
import { readLog } from "../costLog";
import { inspectAsset } from "./inspect";
import { findChainRoot } from "./chain";
import { observeAddFraming } from "./framing";
import { observeGenerateIdentity } from "./identity";
import { identityTargetsFor } from "./identitySet";
import { writeVerdict } from "./record";
import { runCreativeQa, runGenerateQa } from "./verdict";

/** Successive `select(...).from(...).where(...).limit(1)` calls, in order. */
let queue: unknown[][] = [];
const queueRows = (...rowSets: unknown[][]) => {
  queue = [...rowSets];
};

let logFile: string;
beforeEach(() => {
  jest.clearAllMocks();
  queue = [];
  // The door writes a line per inspection; point it at a fresh file so nothing lands in the repo.
  logFile = join(mkdtempSync(join(tmpdir(), "qa-cost-")), "log.jsonl");
  process.env.STUDIO_COST_LOG = logFile;
  (db.select as jest.Mock).mockImplementation(() => ({
    from: () => ({
      where: () => ({ limit: async () => queue.shift() ?? [] }),
    }),
  }));
  global.fetch = jest.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(8),
  })) as never;
});

const ATH = "athlete-1";

describe("a GENERATE is inspected now", () => {
  it("runs the generate path when the asset is depth 0 and we generated it", async () => {
    queueRows(
      [{ gcs_path: "studio/a.png", generation_job_id: "job-1" }],
      [{ brief: { job: { direction: { statement: "a portrait of me" } } } }],
    );
    (findChainRoot as jest.Mock).mockResolvedValue({
      rootAssetId: "a",
      gcsPath: "studio/a.png",
      depth: 0,
      truncated: false,
      reason: "root",
    });

    const v = await inspectAsset("a", ATH);

    expect(runGenerateQa).toHaveBeenCalledTimes(1);
    expect(runCreativeQa).not.toHaveBeenCalled();
    expect(v).toEqual({ overall: "fail" });
    // Her sentence reaches the check, so "did she ask for these words" can be answered.
    expect(runGenerateQa).toHaveBeenCalledWith(
      expect.objectContaining({
        outputAssetId: "a",
        instruction: "a portrait of me",
      }),
    );
    expect(writeVerdict).toHaveBeenCalledWith("a", ATH, { overall: "fail" });
  });

  it("prefers the caller's instruction and asks the database for nothing else", async () => {
    queueRows([{ gcs_path: "studio/a.png", generation_job_id: "job-1" }]);
    (findChainRoot as jest.Mock).mockResolvedValue({
      rootAssetId: "a",
      gcsPath: "studio/a.png",
      depth: 0,
      truncated: false,
      reason: "root",
    });

    await inspectAsset("a", ATH, { instruction: "her live words" });

    expect(runGenerateQa).toHaveBeenCalledWith(
      expect.objectContaining({ instruction: "her live words" }),
    );
  });

  it("does not persist on a dry run", async () => {
    queueRows([{ gcs_path: "studio/a.png", generation_job_id: "job-1" }]);
    (findChainRoot as jest.Mock).mockResolvedValue({
      rootAssetId: "a",
      gcsPath: "studio/a.png",
      depth: 0,
      truncated: false,
      reason: "root",
    });

    await inspectAsset("a", ATH, { instruction: "x", persist: false });
    expect(writeVerdict).not.toHaveBeenCalled();
  });
});

describe("⚠️ an UPLOAD is depth 0 too, and it is not ours to inspect", () => {
  it("returns null for a depth-0 asset with no generation job", async () => {
    queueRows([{ gcs_path: "uploads/hers.jpg", generation_job_id: null }]);
    (findChainRoot as jest.Mock).mockResolvedValue({
      rootAssetId: "a",
      gcsPath: "uploads/hers.jpg",
      depth: 0,
      truncated: false,
      reason: "root",
    });

    expect(await inspectAsset("a", ATH)).toBeNull();
    expect(runGenerateQa).not.toHaveBeenCalled();
    // Nothing was fetched, so her camera roll cost nothing to not-inspect.
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("an EDIT still takes the comparison path", () => {
  it("compares against the chain root at depth >= 1", async () => {
    queueRows(
      [{ gcs_path: "studio/out.png", generation_job_id: "job-2" }],
      [{ brief: { job: { direction: { statement: "make the socks blue" } } } }],
    );
    (findChainRoot as jest.Mock).mockResolvedValue({
      rootAssetId: "root",
      gcsPath: "uploads/root.jpg",
      depth: 2,
      truncated: false,
      reason: "root",
    });

    const v = await inspectAsset("out", ATH);

    expect(runCreativeQa).toHaveBeenCalledTimes(1);
    expect(runGenerateQa).not.toHaveBeenCalled();
    expect(v).toEqual({ overall: "pass" });
  });
});

describe("the framing observation runs on a placed add and nothing else (wave B)", () => {
  const editRow = () => {
    queueRows(
      [{ gcs_path: "studio/out.png", generation_job_id: "job-2" }],
      [
        {
          brief: { job: { direction: { statement: "add a ball at my feet" } } },
        },
      ],
    );
    (findChainRoot as jest.Mock).mockResolvedValue({
      rootAssetId: "root",
      gcsPath: "uploads/root.jpg",
      depth: 1,
      truncated: false,
      reason: "root",
    });
  };

  it("is handed both frames and the things the intent placed", async () => {
    editRow();
    (observeAddFraming as jest.Mock).mockResolvedValue({
      placedAdds: ["soccer ball"],
      reframed: false,
      fit: { scale: 1, dxFrac: 0, dyFrac: 0, ncc: 1, nccAtIdentity: 1 },
      baseline: null,
      excess: null,
      reason: null,
      output: { width: 1792, height: 2400 },
      latencyMs: 12,
    });

    const v = await inspectAsset("out", ATH, { placedAdds: ["soccer ball"] });

    expect(observeAddFraming).toHaveBeenCalledWith(
      expect.objectContaining({ placedAdds: ["soccer ball"] }),
    );
    expect(v).toMatchObject({
      overall: "pass",
      framingObservation: { placedAdds: ["soccer ball"], reframed: false },
    });
  });

  it("is NOT called when the intent placed no add", async () => {
    editRow();
    await inspectAsset("out", ATH);
    // The caller passes the compile tier's own predicate; no placed add means the option is absent and
    // the observation is never reached — not called with an empty list and dismissed inside.
    expect(observeAddFraming).toHaveBeenCalledWith(
      expect.objectContaining({ placedAdds: [] }),
    );
  });

  it("a null observation leaves the verdict exactly as the checks left it", async () => {
    editRow();
    (observeAddFraming as jest.Mock).mockResolvedValue(null);
    expect(await inspectAsset("out", ATH, { placedAdds: ["ball"] })).toEqual({
      overall: "pass",
    });
  });

  it("⚠️ a THROWING observation cannot cost the verdict — the generation is already paid for", async () => {
    editRow();
    (observeAddFraming as jest.Mock).mockRejectedValue(new Error("sharp died"));
    // `Promise.all` would reject, and `inspectAsset`'s own catch turns that into null — which loses the
    // whole verdict. The observation swallows its own failures (framing.ts returns a reason instead of
    // throwing); this pin is what says the stage still lands if that contract is ever broken.
    expect(await inspectAsset("out", ATH, { placedAdds: ["ball"] })).toBeNull();
  });

  it("a GENERATE is never framed — there is no source frame to compare against", async () => {
    queueRows(
      [{ gcs_path: "studio/a.png", generation_job_id: "job-1" }],
      [{ brief: { job: { direction: { statement: "a portrait of me" } } } }],
    );
    (findChainRoot as jest.Mock).mockResolvedValue({
      rootAssetId: "a",
      gcsPath: "studio/a.png",
      depth: 0,
      truncated: false,
      reason: "root",
    });

    await inspectAsset("a", ATH, { placedAdds: ["soccer ball"] });

    expect(observeAddFraming).not.toHaveBeenCalled();
  });
});

describe("R0.b — a generate's face is OBSERVED against her own photographs, never judged", () => {
  const generateRow = () => {
    queueRows([{ gcs_path: "studio/gen.png", generation_job_id: "job-1" }]);
    (findChainRoot as jest.Mock).mockResolvedValue({
      rootAssetId: "gen",
      gcsPath: "studio/gen.png",
      depth: 0,
      truncated: false,
      reason: "root",
    });
  };
  const targets = [
    {
      assetId: "ref-1",
      gcsPath: "lib/ref-1.jpg",
      comparedAgainst: "references",
    },
    {
      assetId: "held-1",
      gcsPath: "lib/held-1.jpg",
      comparedAgainst: "identity-set",
    },
  ];
  // The fields the log line reads; the rest of the shape is identity.test.ts's to prove.
  const OBSERVATION = {
    outputFace: { confidence: 0.9, sizeFrac: 0.2, small: false },
    outputReason: null,
    comparisons: [
      { assetId: "ref-1", comparedAgainst: "references", reason: null },
      { assetId: "held-1", comparedAgainst: "identity-set", reason: null },
    ],
    referencesMean: 0.31,
    referencesCount: 1,
    identitySetMean: 0.4,
    identitySetCount: 1,
    spend: { usd: 0.004 },
  };

  it("records the observation beside the verdict, compared against the job's own targets", async () => {
    generateRow();
    (identityTargetsFor as jest.Mock).mockResolvedValue(targets);
    (observeGenerateIdentity as jest.Mock).mockResolvedValue(OBSERVATION);

    const v = await inspectAsset("gen", ATH, { instruction: "me on a pitch" });

    // Scoped to HER job, under her athlete id.
    expect(identityTargetsFor).toHaveBeenCalledWith("job-1", ATH);
    const [output, fetched] = (observeGenerateIdentity as jest.Mock).mock
      .calls[0];
    expect(output.bytes).toBeInstanceOf(Buffer);
    // The render's own id rides along, so its face-box and embedding log lines name it (R0.b's follow-up).
    expect(output.assetId).toBe("gen");
    expect(fetched.map((t: { assetId: string }) => t.assetId)).toEqual([
      "ref-1",
      "held-1",
    ]);
    expect(
      fetched.every((t: { bytes: unknown }) => t.bytes instanceof Buffer),
    ).toBe(true);
    // The verdict runGenerateQa returned is the verdict recorded; the observation only rides along.
    expect(v).toEqual({ overall: "fail", identityObservation: OBSERVATION });
    expect(writeVerdict).toHaveBeenCalledWith("gen", ATH, {
      overall: "fail",
      identityObservation: OBSERVATION,
    });
  });

  it("a generate with no photograph of her: nothing compared, nothing fetched beyond the render", async () => {
    generateRow();
    (identityTargetsFor as jest.Mock).mockResolvedValue([]);

    const v = await inspectAsset("gen", ATH, { instruction: "x" });

    expect(observeGenerateIdentity).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(v).toEqual({ overall: "fail" });
  });

  it("a failing observation costs the verdict nothing", async () => {
    generateRow();
    (identityTargetsFor as jest.Mock).mockResolvedValue(targets);
    (observeGenerateIdentity as jest.Mock).mockRejectedValue(
      new Error("embed exploded"),
    );

    const v = await inspectAsset("gen", ATH, { instruction: "x" });

    expect(v).toEqual({ overall: "fail" });
    expect(writeVerdict).toHaveBeenCalledWith("gen", ATH, { overall: "fail" });
  });

  describe("on a fake clock", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it("⚠️ a HUNG observation is cut off on its own clock, and the verdict still lands", async () => {
      generateRow();
      (identityTargetsFor as jest.Mock).mockResolvedValue(targets);
      (observeGenerateIdentity as jest.Mock).mockReturnValue(
        new Promise(() => {}),
      );

      const pending = inspectAsset("gen", ATH, { instruction: "x" });
      // Past the observation's 45s bound, well short of the stage's 90s.
      await jest.advanceTimersByTimeAsync(46_000);
      const v = await pending;

      expect(v).toEqual({ overall: "fail" });
      expect(writeVerdict).toHaveBeenCalledWith("gen", ATH, {
        overall: "fail",
      });
    });
  });

  it("an EDIT is never observed this way — it has a chain root", async () => {
    queueRows(
      [{ gcs_path: "studio/out.png", generation_job_id: "job-2" }],
      [{ brief: { job: { direction: { statement: "socks blue" } } } }],
    );
    (findChainRoot as jest.Mock).mockResolvedValue({
      rootAssetId: "root",
      gcsPath: "uploads/root.jpg",
      depth: 1,
      truncated: false,
      reason: "root",
    });

    await inspectAsset("out", ATH);

    expect(identityTargetsFor).not.toHaveBeenCalled();
    expect(observeGenerateIdentity).not.toHaveBeenCalled();
  });
});

describe("QA spend goes through the cost-log door (PR 11, R-2)", () => {
  const SPEND = {
    usd: 0.0123,
    basis: "estimated",
    visionCalls: 3,
    embedCalls: 2,
    inputTokens: 9000,
    outputTokens: 300,
  };

  /** ⚠️ MUTATION "QA spend unlogged": drop the recordOffRouterSpend call after writeVerdict in inspect.ts. */
  it("a generate inspection writes one line, task image.inspect, the verdict's own spend, joined to the asset and its job", async () => {
    queueRows([{ gcs_path: "studio/a.png", generation_job_id: "job-1" }]);
    (findChainRoot as jest.Mock).mockResolvedValue({
      rootAssetId: "a",
      gcsPath: "studio/a.png",
      depth: 0,
      truncated: false,
      reason: "root",
    });
    (runGenerateQa as jest.Mock).mockResolvedValueOnce({
      overall: "pass",
      spend: SPEND,
      latencyMs: 4321,
    });

    await inspectAsset("a", ATH, { instruction: "x" });

    const lines = await readLog(logFile);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      task: "image.inspect",
      provider: "vertex",
      cost: 0.0123,
      costBasis: "estimated",
      latencyMs: 4321,
      inputRefs: { count: 1, ids: ["a"] },
      assetId: "a",
      jobId: "job-1",
      editPreviewId: null,
      batchId: null,
      previewId: null,
      promptVersion: null,
    });
    expect(lines[0].detail).toContain("3 vision");
  });

  it("an edit inspection names the chain root and the output as its inputs", async () => {
    queueRows([{ gcs_path: "studio/b.png", generation_job_id: "job-2" }]);
    (findChainRoot as jest.Mock).mockResolvedValue({
      rootAssetId: "root",
      gcsPath: "uploads/root.jpg",
      depth: 1,
      truncated: false,
      reason: "root",
    });
    (runCreativeQa as jest.Mock).mockResolvedValueOnce({
      overall: "flag",
      spend: SPEND,
      latencyMs: 10,
    });
    // An earlier test leaves the framing observation REJECTING ("sharp died") — clearAllMocks keeps
    // implementations — and a thrown observation ends the inspection before any line is written.
    (observeAddFraming as jest.Mock).mockResolvedValue(null);

    await inspectAsset("b", ATH, { instruction: "x" });

    const [line] = await readLog(logFile);
    expect(line).toMatchObject({
      task: "image.inspect",
      inputRefs: { count: 2, ids: ["root", "b"] },
      assetId: "b",
      jobId: "job-2",
    });
  });

  it("a stubbed verdict with no spend still cannot fail the inspection — the line is best-effort", async () => {
    queueRows([{ gcs_path: "studio/a.png", generation_job_id: "job-1" }]);
    (findChainRoot as jest.Mock).mockResolvedValue({
      rootAssetId: "a",
      gcsPath: "studio/a.png",
      depth: 0,
      truncated: false,
      reason: "root",
    });
    expect(await inspectAsset("a", ATH, { instruction: "x" })).toEqual({
      overall: "fail",
    });
  });
});
