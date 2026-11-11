/**
 * inspectClip.test.ts — the four ways there is nothing to look at, and the tenancy predicate.
 *
 * The verdict arithmetic is videoClip.test.ts's; the strip is frames.test.ts's. What is left here is
 * the half that owns the database and the filesystem, and the property that matters most about it:
 * **every path returns null rather than throwing**, because by the time this runs the clip has been
 * paid for, stored, and the job closed as succeeded.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

const runClipQaMock = jest.fn();
jest.mock("./videoClip", () => ({
  runClipQa: (...a: unknown[]) => runClipQaMock(...a),
}));

const readObjectMock = jest.fn();
jest.mock("../../lib/mediaStore", () => ({
  readObject: (...a: unknown[]) => readObjectMock(...a),
}));

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { eq } from "drizzle-orm";
import { readLog } from "../costLog";
import { db, initTestDb, closeTestDb } from "../../testUtils/pgliteDb";
import { athletes, mediaAssets } from "../../../shared/schema";
import { inspectClipAsset } from "./inspectClip";
import { readVerdict } from "./record";

const ZERO = {
  usd: 0,
  basis: "estimated" as const,
  visionCalls: 0,
  embedCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
};

/** A real, tiny mp4 — this suite's one case that has to get past ffprobe. */
async function realClipBytes(): Promise<Buffer> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const { mkdtemp, readFile, rm } = await import("fs/promises");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  const dir = await mkdtemp(join(tmpdir(), "clipqa-fixture-"));
  const out = join(dir, "c.mp4");
  try {
    await promisify(execFile)("ffmpeg", [
      "-y",
      "-nostdin",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=64x64:d=1:r=8",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      out,
    ]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const HER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SOMEONE_ELSE = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values([
    { id: HER, full_name: "Her" },
    { id: SOMEONE_ELSE, full_name: "Someone Else" },
  ] as never);
});
afterAll(async () => {
  await closeTestDb();
});

let logFile: string;
beforeEach(async () => {
  await db.delete(mediaAssets);
  jest.clearAllMocks();
  readObjectMock.mockResolvedValue(null);
  // The door writes a line per inspection (PR 11); keep it out of the repo root.
  logFile = joinPath(
    mkdtempSync(joinPath(tmpdir(), "clipqa-cost-")),
    "log.jsonl",
  );
  process.env.STUDIO_COST_LOG = logFile;
});

async function seedAsset(
  athleteId: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: athleteId,
      platform: "studio",
      origin: "generated",
      media_type: "VIDEO",
      status: "stored",
      approval_status: "draft",
      gcs_path: "athletes/x/clip.mp4",
      content_type: "video/mp4",
      ingested_at: new Date(),
      ...over,
    } as never)
    .returning({ id: mediaAssets.id });
  return row.id;
}

const call = (assetId: string, athleteId: string, bytes?: Buffer) =>
  inspectClipAsset({
    assetId,
    athleteId,
    instruction: "she looks into the camera",
    ...(bytes ? { bytes } : {}),
  });

describe("tenancy", () => {
  it("another athlete's clip is NOT FOUND, not forbidden — and nothing is inspected", async () => {
    // The same answer for "does not exist" and "is not yours", so an id cannot be used to probe
    // another athlete's library. This is the rule server/CLAUDE.md states, applied at the door of a
    // stage that runs from a leased runner with no request in scope.
    const hers = await seedAsset(HER);
    expect(await call(hers, SOMEONE_ELSE)).toBeNull();
    expect(runClipQaMock).not.toHaveBeenCalled();

    const missing = "cccccccc-dddd-4eee-8fff-000000000000";
    expect(await call(missing, HER)).toBeNull();
    expect(runClipQaMock).not.toHaveBeenCalled();
  });
});

describe("the ways there is nothing to look at — all null, never a throw", () => {
  it("a still: the image stage owns that one", async () => {
    const id = await seedAsset(HER, { media_type: "IMAGE" });
    expect(await call(id, HER, Buffer.from("jpeg"))).toBeNull();
    expect(runClipQaMock).not.toHaveBeenCalled();
  });

  it("no pixels anywhere — none passed in and none readable back", async () => {
    const id = await seedAsset(HER);
    readObjectMock.mockResolvedValue(null);
    expect(await call(id, HER)).toBeNull();
    expect(readObjectMock).toHaveBeenCalledWith("athletes/x/clip.mp4");
  });

  it("bytes that ffmpeg cannot read are a null, not an exception", async () => {
    // The whole reason this function swallows: a generation that has been paid for, stored and
    // closed must not be disturbed because an inspection could not parse it. Nine bytes of ASCII is
    // not an mp4, and ffprobe says so.
    const id = await seedAsset(HER);
    await expect(call(id, HER, Buffer.from("not-an-mp4"))).resolves.toBeNull();
    expect(runClipQaMock).not.toHaveBeenCalled();
    // And nothing was written to the record — a verdict about an unreadable clip would be a lie.
    expect(await readVerdict(id, HER)).toBeNull();
  });

  it("reads the bytes back off the store when the caller holds none", async () => {
    const id = await seedAsset(HER);
    readObjectMock.mockResolvedValue({ buf: Buffer.from("still-not-an-mp4") });
    await call(id, HER);
    // It got as far as trying, which is the property: the fallback path is live, not decorative.
    expect(readObjectMock).toHaveBeenCalledTimes(1);
  });

  it("prefers the caller's bytes over a round trip to the store", async () => {
    const id = await seedAsset(HER);
    await call(id, HER, Buffer.from("caller-bytes"));
    // The runner uploaded these microseconds ago; re-downloading them would be a round trip for
    // nothing, on an instance where /tmp is RAM.
    expect(readObjectMock).not.toHaveBeenCalled();
  });
});

describe("the re-roll advice rides on the verdict that is written", () => {
  it("a failing clip's stored verdict carries its reasons and its quote", async () => {
    const id = await seedAsset(HER);
    runClipQaMock.mockResolvedValue({
      schemaVersion: 6,
      at: "2026-09-19T00:00:00.000Z",
      overall: "fail",
      unknownChecks: 2,
      advisoryChecks: [],
      checks: {
        identity: {
          status: "unknown",
          summary: "",
          detail: null,
          error: "x",
          spend: ZERO,
          latencyMs: 0,
        },
        marks: {
          status: "pass",
          summary: "",
          detail: null,
          error: null,
          spend: ZERO,
          latencyMs: 0,
        },
        anatomy: {
          status: "fail",
          summary: "three hands visible",
          detail: null,
          error: null,
          spend: ZERO,
          latencyMs: 0,
        },
        adherence: {
          status: "unknown",
          summary: "",
          detail: null,
          error: "x",
          spend: ZERO,
          latencyMs: 0,
        },
        text: {
          status: "pass",
          summary: "",
          detail: null,
          error: null,
          spend: ZERO,
          latencyMs: 0,
        },
      },
      subject: "clip",
      spend: ZERO,
      latencyMs: 1,
      comparison: {
        rootAssetId: id,
        outputAssetId: id,
        chainDepth: 0,
        chainTruncated: false,
      },
      clip: {
        coverage: { checked: 3, scanned: 24, total: 145 },
        motionless: false,
        frames: [
          {
            timeSec: 0,
            role: "anchor",
            drift: 0,
            checks: {
              anatomy: {
                status: "pass",
                summary: "",
                detail: null,
                error: null,
                spend: ZERO,
                latencyMs: 0,
              },
              text: {
                status: "pass",
                summary: "",
                detail: null,
                error: null,
                spend: ZERO,
                latencyMs: 0,
              },
              marks: null,
            },
            identityObservation: null,
          },
          {
            timeSec: 2,
            role: "peak",
            drift: 0.5,
            checks: {
              anatomy: {
                status: "fail",
                summary: "three hands visible",
                detail: null,
                error: null,
                spend: ZERO,
                latencyMs: 0,
              },
              text: {
                status: "pass",
                summary: "",
                detail: null,
                error: null,
                spend: ZERO,
                latencyMs: 0,
              },
              marks: null,
            },
            identityObservation: null,
          },
        ],
      },
    });

    const verdict = await inspectClipAsset({
      assetId: id,
      athleteId: HER,
      instruction: "she looks into the camera",
      bytes: await realClipBytes(),
      shotType: "identity",
      quotedUsd: 1.6,
    });

    expect(verdict?.clip?.reroll).toEqual({
      shotType: "identity",
      reasons: [{ check: "anatomy", atSec: 2, summary: "three hands visible" }],
      quoteUsd: 1.6,
      acted: false,
    });
    // And it is on the RECORD, not only in the return value nobody reads.
    const stored = await readVerdict(id, HER);
    expect(stored?.clip?.reroll?.quoteUsd).toBe(1.6);
  });
});

describe("clip QA spend goes through the cost-log door (PR 11, R-2)", () => {
  const check = (status: "pass" | "fail", summary = "") => ({
    status,
    summary,
    detail: null,
    error: null,
    spend: ZERO,
    latencyMs: 0,
  });
  const frame = (timeSec: number, role: string) => ({
    timeSec,
    role,
    drift: 0,
    checks: { anatomy: check("pass"), text: check("pass"), marks: null },
    identityObservation: null,
  });

  /** ⚠️ MUTATION "QA spend unlogged" (clip half): drop the recordOffRouterSpend call from inspectClip's inner. */
  it("a stored verdict is followed by one line, task clip.inspect, joined to the clip and its job", async () => {
    const JOB = "dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb";
    const id = await seedAsset(HER, { generation_job_id: JOB });
    const spend = {
      usd: 0.021,
      basis: "estimated" as const,
      visionCalls: 4,
      embedCalls: 0,
      inputTokens: 12000,
      outputTokens: 400,
    };
    runClipQaMock.mockResolvedValue({
      schemaVersion: 6,
      at: "2026-09-19T00:00:00.000Z",
      overall: "pass",
      unknownChecks: 0,
      advisoryChecks: [],
      checks: {
        identity: check("pass"),
        marks: check("pass"),
        anatomy: check("pass"),
        adherence: check("pass"),
        text: check("pass"),
      },
      subject: "clip",
      spend,
      latencyMs: 777,
      comparison: {
        rootAssetId: id,
        outputAssetId: id,
        chainDepth: 0,
        chainTruncated: false,
      },
      clip: {
        coverage: { checked: 2, scanned: 8, total: 8 },
        motionless: false,
        frames: [frame(0, "anchor"), frame(0.5, "peak")],
      },
    });

    const verdict = await inspectClipAsset({
      assetId: id,
      athleteId: HER,
      instruction: "she looks into the camera",
      bytes: await realClipBytes(),
    });
    expect(verdict?.overall).toBe("pass");
    expect(await readVerdict(id, HER)).not.toBeNull();

    const lines = await readLog(logFile);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      task: "clip.inspect",
      provider: "vertex",
      cost: 0.021,
      costBasis: "estimated",
      latencyMs: 777,
      inputRefs: { count: 1, ids: [id] },
      assetId: id,
      jobId: JOB,
      previewId: null,
      editPreviewId: null,
      batchId: null,
      promptVersion: null,
    });
    expect(lines[0].detail).toContain("4 vision");
  });

  it("a clip that was never inspected (unreadable bytes) writes no line", async () => {
    const id = await seedAsset(HER);
    await inspectClipAsset({
      assetId: id,
      athleteId: HER,
      instruction: "x",
      bytes: Buffer.from("not-an-mp4"),
    });
    expect(await readLog(logFile)).toEqual([]);
  });
});
