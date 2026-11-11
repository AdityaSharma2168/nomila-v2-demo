/**
 * stitchRunner.test.ts — the tick, and the bound that lives in the process rather than the database.
 *
 * ─── WHAT IS REAL HERE AND WHAT IS MOCKED ───────────────────────────────────────────────────────
 *
 * REAL: the database (PGlite), the whole of studio/video/materialize.ts — so the tenancy predicate,
 * the caps and the streaming download all execute — and the real lease, reaper and claim.
 *
 * MOCKED: the two GCS calls that would cross the network, `fetch`, and `stitch()` itself. ffmpeg is
 * not run: V6's own suite drives the real binary, and this file is about the ORDER things happen
 * in, which a real encode would only make slow.
 *
 * ─── THE PROPERTIES WORTH BREAKING ──────────────────────────────────────────────────────────────
 *
 *   1. CAPACITY. Two ticks on one instance claim ONE job between them while the first is still
 *      running. Nothing in Postgres enforces this — SKIP LOCKED exists to hand the second caller a
 *      different row — so if the guard goes, two workspaces share one instance's 2 GiB.
 *   2. THE TICK RETURNS WITHOUT ffmpeg. Proven with a stitch that never resolves.
 *   3. A CROSS-ATHLETE ASSET FAILS CLOSED, before any byte moves.
 *   4. A RE-RUN PUBLISHES ONE ASSET. The reaper requeues always, so this is the ordinary path.
 *   5. THE WORKSPACE IS ALWAYS DISPOSED. /tmp is RAM on Cloud Run; a leak is memory, not a file.
 */
import { execFile } from "child_process";
import { promisify } from "util";

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/mediaStore", () => ({
  signedUrl: jest.fn(),
  uploadLocalFile: jest.fn(),
  UPLOAD_LIMITS: {
    image: { max: 25 * 1024 * 1024, types: [] },
    video: { max: 200 * 1024 * 1024, types: [] },
  },
}));
jest.mock("./video/stitch", () => ({ stitch: jest.fn() }));

import {
  existsSync,
  readdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, relative, resolve } from "path";
import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import { athletes, mediaAssets, studioStitchJobs } from "../../shared/schema";
import { signedUrl, uploadLocalFile } from "../lib/mediaStore";
import { stitch } from "./video/stitch";
import {
  claimStitchJobs,
  queueStitch,
  reapExpiredStitchLeases,
  stitchTimeoutMs,
} from "./stitchJobs";
import { STITCH_BEDS } from "./video/beds";
import { renderCaptionBand } from "./video/captionRender";
import { STITCH_TARGETS, type StitchSpec } from "./video/spec";
import type { Caption } from "./video/captions";
import { makeFixtures, type Fixtures } from "./video/testFixtures";
import { probeMedia } from "./video/probe";
import sharp from "sharp";
import {
  inFlightCount,
  leaseCoversWork,
  RUNNER_ID,
  stitchTick,
  workStitch,
} from "./stitchRunner";

/**
 * ⚠️  THE EFFECTIVE CEILING IS JEST'S 5s DEFAULT, NOT THE 120s jest.config.cjs APPEARS TO SET.
 *
 * `testTimeout` only takes effect from the config's TOP level — jest-circus reads it off the
 * GLOBAL config (jestAdapterInit: `if (globalConfig.testTimeout)`), and since the V4 projects
 * split it lives inside the per-project `shared` object, where nothing reads it. So this hook
 * got 5s: PGlite boot plus five ffmpeg encodes, which fits on a laptop and did not on the CI
 * runner (22 red, all of them this one hook). Same reason video/stitch.test.ts carries the line.
 *
 * This does not blunt anything: the one timing-sensitive test here ("returns without waiting for
 * ffmpeg") races its own explicit 2s reject and is unaffected by jest's ceiling.
 */
jest.setTimeout(180_000);

const WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), "stitch-runner-test-"));

const HER = "77777777-1111-4777-8777-777777777777";
const SOMEONE_ELSE = "88888888-1111-4888-8888-888888888888";

const mockSignedUrl = signedUrl as jest.MockedFunction<typeof signedUrl>;
const mockUpload = uploadLocalFile as jest.MockedFunction<
  typeof uploadLocalFile
>;
const mockStitch = stitch as jest.MockedFunction<typeof stitch>;

/**
 * A stand-in for V6's engine: writes a file where it was told to and answers a manifest about it.
 * It must WRITE — publishStitchOutput stats the path it is handed, and a mock that produced no file
 * would make every success path fail for a reason that has nothing to do with the runner.
 */
const writesOutput = (over: Record<string, unknown> = {}) =>
  jest.fn(async (req: any) => {
    writeFileSync(req.outputPath, Buffer.alloc(1234, 3));
    return manifest(over);
  }) as never;

/** A manifest shaped like V6's, with only what the runner reads off it. */
const manifest = (over: Record<string, unknown> = {}) =>
  ({
    outputPath: "/unused",
    clips: [{}],
    audioBed: null,
    expectedDurationSec: 8,
    output: { width: 1080, height: 1920, durationSec: 8.04, sizeBytes: 1234 },
    ffmpeg: { args: [], filterGraph: "", durationMs: 10 },
    ...over,
  }) as never;

/** Stand up a stored VIDEO asset for an athlete, with a byte count. */
/**
 * ⚠️  THE BYTES SERVED ARE A REAL MP4, and that is load-bearing rather than tidy.
 *
 * The runner ffprobes every downloaded clip before the encode (the exact timeline bound), so a
 * `Buffer.alloc` of zeroes is no longer a stand-in for a video — it is a file ffprobe cannot read.
 * Fixtures come from V6's lavfi generator: hermetic, $0, and no binary assets in git.
 *
 * `bytes` is what the ROW claims, deliberately independent of what the file actually is. That gap
 * between the claim and the fact is exactly what the probed check exists to close.
 */
async function seedAsset(
  owner: string,
  bytes = 1_000,
  fixture: keyof Fixtures = "clipA",
): Promise<string> {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: owner,
      platform: "studio",
      origin: "upload",
      media_type: "VIDEO",
      status: "stored",
      approval_status: "approved",
      gcs_path: `athletes/${owner}/clip-${Math.random().toString(36).slice(2)}.mp4`,
      content_type: "video/mp4",
      bytes,
      duration_seconds: 8,
      ingested_at: new Date(),
    } as never)
    .returning({ id: mediaAssets.id, gcs_path: mediaAssets.gcs_path });
  served.set(row.gcs_path!, readFileSync(fixtures[fixture].path));
  return row.id;
}

const spec = (assetIds: string[], bed?: string) => ({
  clips: assetIds.map((assetId) => ({ assetId })),
  target: "portrait",
  ...(bed ? { bed } : {}),
});

/**
 * Turn the beds on, and actually SERVE the object.
 *
 * ⚠️  WITHOUT THIS EVERY TEST IN THIS FILE TAKES THE NO-BED BRANCH AND STAYS GREEN while the bed
 * download is never executed — `bedsReady()` is false by default, so the code path simply does not
 * run. That is the same false green a harness gets by stubbing only the calls it remembered: the
 * suite passes and the feature is untested. Flagged by a peer session that hit the shape on a
 * different path, and it was true here.
 */
function serveBed(): string {
  process.env.STUDIO_STITCH_BEDS_READY = "true";
  const path = STITCH_BEDS.placeholder.gcsPath;
  served.set(path, Buffer.alloc(4096, 9));
  return path;
}

let served: Map<string, Buffer>;
let fetched: string[];
/**
 * The AbortSignal handed to each fetch, captured so a test can assert on the OBJECT.
 *
 * ⚠️  ASSERTING ON A SYMPTOM DOES NOT DISCRIMINATE HERE. A test that only checked "the job failed"
 * or "no bytes landed" passes with the signal removed entirely — the download simply fails for a
 * different reason and the outcome looks identical. Only `.aborted` on the signal the runner
 * actually passed can tell "cancelled" from "went wrong". (The shape was flagged by a peer session
 * that hit it on its own abort test; it was true here too, where the path had no test at all.)
 */
let signals: (AbortSignal | null)[];
/** Generated once from ffmpeg's lavfi sources. clipA is 2.0 s, which the duration test relies on. */
let fixtures: Fixtures;

beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values([
    { id: HER, full_name: "Stitch Runner Athlete" },
    { id: SOMEONE_ELSE, full_name: "Another Athlete" },
  ] as never);
  process.env.STUDIO_STITCH_WORKSPACE_DIR = WORKSPACE_ROOT;
  // The Studio is on: the tick works its timelines. (Dark, it claims only post-kit preview renders —
  // agent/postKit/render/publish.db.test.ts holds that.)
  process.env.STUDIO_ENABLED = "true";
  fixtures = await makeFixtures(WORKSPACE_ROOT);
});

afterAll(async () => {
  await closeTestDb();
  rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  delete process.env.STUDIO_STITCH_WORKSPACE_DIR;
  delete process.env.STUDIO_STITCH_CONCURRENCY;
  delete process.env.STUDIO_STITCH_BEDS_READY;
  delete process.env.STUDIO_ENABLED;
});

beforeEach(async () => {
  await db.delete(studioStitchJobs);
  await db.delete(mediaAssets);
  served = new Map();
  fetched = [];
  signals = [];
  delete process.env.STUDIO_STITCH_BEDS_READY;
  jest.clearAllMocks();

  mockSignedUrl.mockImplementation(
    async (p: string) => `https://signed.test/${p}`,
  );
  mockUpload.mockResolvedValue(undefined as never);
  mockStitch.mockImplementation(writesOutput());

  // The real streaming path runs; only the wire is stubbed. The body IS a web ReadableStream, so
  // Readable.fromWeb, the counting Transform and the file write all execute as in production.
  global.fetch = jest.fn(async (url: any, init: any) => {
    const path = String(url).replace("https://signed.test/", "");
    fetched.push(path);
    signals.push(init?.signal ?? null);
    const body = served.get(path);
    if (!body) return new Response(null, { status: 404 });
    if (init?.signal?.aborted) throw new Error("aborted");
    // Uint8Array, not Buffer: BodyInit does not accept a Node Buffer under the DOM lib.
    return new Response(new Uint8Array(body));
  }) as never;
});

/**
 * A stand-in engine that hangs until released, and announces when it was entered.
 *
 * The `entered` half is not ceremony: stitchTick() returns BEFORE the clips have downloaded, so at
 * the moment it resolves `stitch` has not been called and there is nothing to release yet. Waiting
 * on `entered` is how a test can be sure it is releasing a call that exists — and needing to wait
 * at all is the tick's claim-and-return property, observed from outside.
 */
function hangingEngine() {
  let release!: () => void;
  let announce!: () => void;
  const entered = new Promise<void>((r) => {
    announce = r;
  });
  mockStitch.mockImplementation(
    (req: any) =>
      new Promise((resolve) => {
        release = () => {
          writeFileSync(req.outputPath, Buffer.alloc(1234, 3));
          resolve(manifest());
        };
        announce();
      }) as never,
  );
  return { entered, release: () => release() };
}

/** Workspaces this suite left behind. Only ours — an injected root, never the OS temp directory. */
const leaked = () =>
  existsSync(WORKSPACE_ROOT)
    ? readdirSync(WORKSPACE_ROOT).filter((d) => d.startsWith("studio-stitch-"))
    : [];

/** Let the detached work this tick started run to completion before asserting on its row. */
const settle = async () => {
  for (let i = 0; i < 100 && inFlightCount() > 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 10));
};

const readJob = async (id: string) =>
  (
    await db.select().from(studioStitchJobs).where(eq(studioStitchJobs.id, id))
  )[0];

// ─── 1. The happy path ──────────────────────────────────────────────────────────────────────────

describe("workStitch", () => {
  it("materializes, stitches, publishes and closes the job", async () => {
    const a = await seedAsset(HER);
    const b = await seedAsset(HER);
    const id = await queueStitch(HER, spec([a, b]));
    const [job] = await claimStitchJobs(1, RUNNER_ID);

    expect(await workStitch(job)).toBe("succeeded");

    const [asset] = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.origin, "generated"));
    expect(asset.media_type).toBe("VIDEO");
    expect(asset.approval_status).toBe("draft");
    expect(asset.generation_job_id).toBeNull();
    // The integer column got a rounded figure; the exact 8.04 stayed on the manifest.
    expect(asset.duration_seconds).toBe(8);
    expect(fetched).toHaveLength(2);
    expect(leaked()).toEqual([]);
  });

  it("passes the CLAIMED ROW's athlete to the resolve, never anything else", async () => {
    // The cross-athlete case, and the one that must fail before any byte moves: a spec naming
    // someone else's clip resolves to nothing under this job's athlete.
    const hers = await seedAsset(HER);
    const theirs = await seedAsset(SOMEONE_ELSE);
    const id = await queueStitch(HER, spec([hers, theirs]));
    const [job] = await claimStitchJobs(1, RUNNER_ID);

    expect(await workStitch(job)).toBe("failed");
    expect(fetched).toEqual([]); // nothing downloaded, including the legitimate clip
    expect(mockStitch).not.toHaveBeenCalled();
    expect(leaked()).toEqual([]);

    const row = await readJob(id);
    expect(row.status).toBe("failed");
    expect(row.last_error).toMatch(/could not be found/i);
    // And the refusal does not distinguish "not yours" from "does not exist".
    expect(row.last_error).not.toMatch(/athlete|permission|forbidden|yours/i);
  });

  it("refuses an over-cap timeline at claim time, naming all three caps", async () => {
    // The library can change between queue and claim, so the runner re-checks. Cheapest way to
    // exceed a cap without seeding 665 MB: lower it for this one job.
    process.env.STUDIO_STITCH_MAX_CLIPS = "1";
    try {
      const a = await seedAsset(HER);
      const b = await seedAsset(HER);
      const id = await queueStitch(HER, spec([a, b]));
      const [job] = await claimStitchJobs(1, RUNNER_ID);

      expect(await workStitch(job)).toBe("failed");
      const row = await readJob(id);
      expect(row.last_error).toMatch(
        /up to 1 clips, \d+ MB of video and 3:00 of footage/,
      );
      expect(row.last_error).toMatch(/This one has 2 clips/);
      expect(fetched).toEqual([]);
    } finally {
      delete process.env.STUDIO_STITCH_MAX_CLIPS;
    }
  });

  it("disposes the workspace when ffmpeg throws, and hides the stderr from her", async () => {
    const a = await seedAsset(HER);
    const id = await queueStitch(HER, spec([a]));
    const [job] = await claimStitchJobs(1, RUNNER_ID);
    mockStitch.mockRejectedValue(
      new Error(
        "ffmpeg stitch failed: [libx264 @ 0x7f] height not divisible by 2",
      ),
    );

    expect(await workStitch(job)).toBe("failed");
    expect(leaked()).toEqual([]);

    const row = await readJob(id);
    // A decode error is not something she can act on, and it is not ours to hand out.
    expect(row.last_error).not.toMatch(/libx264|ffmpeg/);
    expect(row.last_error).toMatch(/couldn't put that timeline together/i);
  });

  it("publishes ONE asset however many times the job is run", async () => {
    // ⚠️  THE REVERT CHECK FOR THE IDEMPOTENT PUBLISH. The reaper requeues a lapsed stitch ALWAYS,
    // so a second run is ordinary. An unconditional insert in publishStitchOutput reds here with
    // two rows — and the orphaned first one would be visible in her library forever.
    const a = await seedAsset(HER);
    const id = await queueStitch(HER, spec([a]));

    const [first] = await claimStitchJobs(1, RUNNER_ID);
    await workStitch(first);
    const after = await readJob(id);

    // The instance died and the reaper handed it on.
    await db
      .update(studioStitchJobs)
      .set({ status: "running", lease_until: new Date(Date.now() - 1000) })
      .where(eq(studioStitchJobs.id, id));
    await reapExpiredStitchLeases();
    const [second] = await claimStitchJobs(1, RUNNER_ID);
    await workStitch(second);

    const rows = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.origin, "generated"));
    expect(rows).toHaveLength(1);
    // And the id is STABLE, so a client already holding it is not left pointing at nothing.
    expect(await readJob(id).then((r) => r.output_asset_id)).toBe(
      after.output_asset_id,
    );
    expect(rows[0].id).toBe(after.output_asset_id);
  });
});

describe("the transfer deadline", () => {
  afterEach(() => {
    delete process.env.STUDIO_STITCH_TRANSFER_MS;
  });

  it("hands the download a REAL AbortSignal, and aborts it when the clock runs out", async () => {
    // ⚠️ THE REVERT CHECK FOR THE ABORT. Dropping `signal` from the downloadTo call reds on the
    // first assertion below and nowhere else — every other symptom (a failed job, a clean
    // workspace, no bytes) is identical with and without it, because a hung download fails either
    // way. The difference that matters is WHY, and only the signal object records it.
    //
    // It matters because lib/withTimeout's loser keeps running: on Cloud Run /tmp is RAM, so a
    // download still writing into a workspace we have already rm -rf'd holds those pages on the
    // unlinked inode until the process exits. A race stops the caller waiting; only an abort stops
    // the writing.
    process.env.STUDIO_STITCH_TRANSFER_MS = "40";
    const a = await seedAsset(HER);
    await queueStitch(HER, spec([a]));
    const [job] = await claimStitchJobs(1, RUNNER_ID);

    // A fetch that never resolves on its own — it settles only when the signal fires.
    global.fetch = jest.fn((_url: any, init: any) => {
      signals.push(init?.signal ?? null);
      return new Promise((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) return; // no signal: hang forever, which is the bug this test is about
        sig.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    }) as never;

    const outcome = await workStitch(job);

    // THE DISCRIMINATING ASSERTION: a signal was passed, and it is the one that fired.
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]!.aborted).toBe(true);

    expect(outcome).toBe("failed");
    expect(leaked()).toEqual([]);
    expect(mockStitch).not.toHaveBeenCalled();
  });

  it("does not abort a download that finishes inside the clock", async () => {
    const a = await seedAsset(HER);
    await queueStitch(HER, spec([a]));
    const [job] = await claimStitchJobs(1, RUNNER_ID);

    expect(await workStitch(job)).toBe("succeeded");
    // The deadline is cleared once the workspace is up — a timer left running would abort a signal
    // nothing is listening to any more, and would keep the process alive in a test runner.
    expect(signals[0]!.aborted).toBe(false);
  });
});

describe("the exact timeline bound", () => {
  afterEach(() => {
    delete process.env.STUDIO_STITCH_MAX_TIMELINE_SEC;
  });

  it("counts a NULL-duration clip at its REAL length, not at its byte estimate", async () => {
    // ⚠️  THE REVERT CHECK FOR THE WHOLE FIX. media_assets.duration_seconds is nullable and is null
    // in practice, so the door falls back to bytes ÷ output-bitrate — which under-counts by
    // whatever the source bitrate happens to be, and under-counting is the direction that OOMs an
    // instance. In production shape: a 200 MB upload at 3 Mbps is 555 s of video counted as 100.
    //
    // Reproduced here at test scale rather than by seeding 200 MB: the row CLAIMS 1 000 bytes and
    // no duration, so the estimate is ~0.0005 s and sails through any cap. The FILE is really 2.0 s.
    // With the cap at 1 s, only a check that measures the file can refuse this.
    //
    // Mutate `assertProbedTimelineFits` back to the byte estimate and this goes green while the
    // timeline is twice the limit — which is the bug, reproduced.
    process.env.STUDIO_STITCH_MAX_TIMELINE_SEC = "1";

    const a = await seedAsset(HER, 1_000); // clipA: really 2.0 s, row says nothing
    await db
      .update(mediaAssets)
      .set({ duration_seconds: null })
      .where(eq(mediaAssets.id, a));

    const id = await queueStitch(HER, spec([a]));
    const [job] = await claimStitchJobs(1, RUNNER_ID);

    expect(await workStitch(job)).toBe("failed");

    // Refused BEFORE the encode — the expensive part never started.
    expect(mockStitch).not.toHaveBeenCalled();
    // But AFTER the download, which is the price of measuring rather than guessing.
    expect(fetched).toHaveLength(1);
    expect(leaked()).toEqual([]);

    const row = await readJob(id);
    expect(row.status).toBe("failed");
    expect(row.last_error).toMatch(/runs about 2 seconds/);
    expect(row.last_error).toMatch(/up to \d+ clips/);
  });

  it("lets the same clip through when it fits", async () => {
    // The other half: the guard must not refuse everything. Same file, honest cap.
    process.env.STUDIO_STITCH_MAX_TIMELINE_SEC = "180";
    const a = await seedAsset(HER, 1_000);
    await db
      .update(mediaAssets)
      .set({ duration_seconds: null })
      .where(eq(mediaAssets.id, a));

    await queueStitch(HER, spec([a]));
    const [job] = await claimStitchJobs(1, RUNNER_ID);
    expect(await workStitch(job)).toBe("succeeded");
    expect(mockStitch).toHaveBeenCalled();
  });

  it("counts each POSITION, so the same clip twice counts twice", async () => {
    // One 2.0 s file used twice is 4 s of output and ONE download. A guard that counted unique
    // files would let a timeline of twenty repeats through.
    process.env.STUDIO_STITCH_MAX_TIMELINE_SEC = "3";
    const a = await seedAsset(HER, 1_000);
    await db
      .update(mediaAssets)
      .set({ duration_seconds: null })
      .where(eq(mediaAssets.id, a));

    await queueStitch(HER, spec([a, a]));
    const [job] = await claimStitchJobs(1, RUNNER_ID);

    expect(await workStitch(job)).toBe("failed");
    expect((await readJob((job as any).id)).last_error).toMatch(
      /runs about 4 seconds/,
    );
    expect(fetched).toHaveLength(1); // still deduplicated — counted twice, fetched once
  });
});

describe("the audio bed", () => {
  it("fetches the bed and hands ffmpeg its LOCAL path, never the spec's name", async () => {
    const bedPath = serveBed();
    const a = await seedAsset(HER);
    await queueStitch(HER, spec([a], "placeholder"));
    const [job] = await claimStitchJobs(1, RUNNER_ID);

    expect(await workStitch(job)).toBe("succeeded");

    // It was really downloaded — a second fetch, against the bed's own object.
    expect(fetched).toContain(bedPath);
    expect(fetched).toHaveLength(2);

    const req = mockStitch.mock.calls[0][0] as any;
    expect(req.audioBed).toBeDefined();
    // A LOCAL path inside the workspace. Nothing off the spec reaches ffmpeg.
    expect(req.audioBed.source).toMatch(/studio-stitch-.*bed\.m4a$/);
    expect(req.audioBed.source).not.toContain("placeholder");
    // The level is V6's default and deliberately not on the wire; the duck is ASKED for with the
    // engine's defaults, and plan.ts emits it only under a clip that sounds (ledger D4).
    expect(req.audioBed.level).toBeUndefined();
    expect(req.audioBed.duck).toEqual({});
  });

  it("makes the clip WITHOUT music when the bed became unavailable after queueing", async () => {
    // A downgrade, not a refusal: the route already refuses a bed she asks for while unavailable,
    // so reaching here with one means it went away in between. Failing a job she is waiting on
    // over its soundtrack is the worse answer.
    const a = await seedAsset(HER);
    await queueStitch(HER, spec([a], "placeholder"));
    const [job] = await claimStitchJobs(1, RUNNER_ID);
    // beds NOT ready — bedsReady() is false in this test.

    expect(await workStitch(job)).toBe("succeeded");
    expect((mockStitch.mock.calls[0][0] as any).audioBed).toBeUndefined();
    expect(fetched).toHaveLength(1); // the clip only
  });

  it("is charged against the same budget the clips are", async () => {
    // Layer 3's lesson, applied before it bites: an uncounted file is charged at zero. With the
    // source budget lowered to just over one clip, adding a bed must tip it over.
    serveBed();
    const a = await seedAsset(HER, 1000);
    process.env.STUDIO_STITCH_BED_MAX_BYTES = String(1024 * 1024 * 1024);
    try {
      await queueStitch(HER, spec([a], "placeholder"));
      const [job] = await claimStitchJobs(1, RUNNER_ID);
      expect(await workStitch(job)).toBe("failed");
      const row = await readJob((job as any).id);
      expect(row.last_error).toMatch(/needs about \d+ MB/);
      expect(fetched).toEqual([]); // refused before anything moved
    } finally {
      delete process.env.STUDIO_STITCH_BED_MAX_BYTES;
    }
  });

  it("disposes the bed with the workspace", async () => {
    serveBed();
    const a = await seedAsset(HER);
    await queueStitch(HER, spec([a], "placeholder"));
    const [job] = await claimStitchJobs(1, RUNNER_ID);
    await workStitch(job);
    expect(leaked()).toEqual([]);
  });
});

// ─── 2. The tick ────────────────────────────────────────────────────────────────────────────────

describe("the sound from one of her own videos", () => {
  const withSound = (clipIds: string[], bedAssetId: string, over = {}) => ({
    clips: clipIds.map((assetId) => ({ assetId })),
    target: "portrait",
    bedAssetId,
    ...over,
  });

  it("lays the sound from the video on the job row, not a live one", async () => {
    // QUOTE MATCHES RUN, for sound. She queues with one video as the sound, keeps going and queues
    // again with another. The FIRST job must be handed the first video's file — resolved from its
    // own row — and that file's bytes must be that asset's bytes.
    // ⚠️ THREE DIFFERENT FILES, ON PURPOSE. With the timeline's clip and the first sound video both
    // seeded from clipA, a runner that handed ffmpeg the CLIP's file as the sound passed this test
    // (found by revert check) — same bytes. Nothing here may share a fixture.
    const clip = await seedAsset(HER, 1_000, "clipD");
    const first = await seedAsset(HER, 1_000, "clipA"); // 440 Hz
    const second = await seedAsset(HER, 1_000, "clipC"); // 880 Hz
    await queueStitch(HER, withSound([clip], first, { bedLevel: "high" }));
    await queueStitch(HER, withSound([clip], second));
    const [job] = await claimStitchJobs(1, RUNNER_ID);

    let handed: Buffer | null = null;
    mockStitch.mockImplementation((async (req: {
      outputPath: string;
      audioBed?: { source: string };
    }) => {
      handed = req.audioBed ? readFileSync(req.audioBed.source) : null;
      writeFileSync(req.outputPath, Buffer.alloc(1234, 3));
      return manifest();
    }) as never);

    expect(await workStitch(job)).toBe("succeeded");
    expect(handed).not.toBeNull();
    expect(handed!.equals(readFileSync(fixtures.clipA.path))).toBe(true);
    // The control: all three files really are different, so equality above means something.
    expect(handed!.equals(readFileSync(fixtures.clipC.path))).toBe(false);
    expect(handed!.equals(readFileSync(fixtures.clipD.path))).toBe(false);

    const req = mockStitch.mock.calls[0][0];
    // A LOCAL path in the workspace, and her chosen level — never anything off the spec.
    expect(req.audioBed!.source).toMatch(/studio-stitch-/);
    expect(req.audioBed!.source).not.toBe(req.clips[0].source);
    expect(req.audioBed!.level).toBe(0.4);
  });

  it("refuses another athlete's video as the sound, the same way as one that does not exist", async () => {
    const clip = await seedAsset(HER);
    const theirs = await seedAsset(SOMEONE_ELSE);
    const gone = "99999999-9999-4999-8999-999999999999";

    const errors: string[] = [];
    for (const sound of [theirs, gone]) {
      const id = await queueStitch(HER, withSound([clip], sound));
      const [job] = await claimStitchJobs(1, RUNNER_ID);
      expect(await workStitch(job)).toBe("failed");
      errors.push((await readJob(id)).last_error ?? "");
    }
    // ONE answer for both, it says which THING is missing, and it says nothing about whose it is.
    expect(errors[0]).toBe(errors[1]);
    expect(errors[0]).toMatch(/takes its sound from could not be found/);
    expect(errors[0]).not.toMatch(/athlete|permission|forbidden|yours/i);
    // Refused BEFORE any bytes moved — not even her own clip was fetched.
    expect(fetched).toEqual([]);
    expect(mockStitch).not.toHaveBeenCalled();
  });

  it("fails with a sentence when the video has no sound — never a quiet stitch without it", async () => {
    const clip = await seedAsset(HER);
    const mute = await seedAsset(HER, 1_000, "clipB"); // 4:3, NO audio track
    const id = await queueStitch(HER, withSound([clip], mute));
    const [job] = await claimStitchJobs(1, RUNNER_ID);

    expect(await workStitch(job)).toBe("failed");
    const row = await readJob(id);
    expect(row.last_error).toMatch(/has no sound to use/);
    // Her sentence, not the engine's: that one names a local path.
    expect(row.last_error).not.toMatch(/\/|tmp|audioBed|stream/);
    expect(mockStitch).not.toHaveBeenCalled();
    expect(leaked()).toEqual([]);
  });

  it("downloads a video ONCE when it is both a clip and the sound", async () => {
    const both = await seedAsset(HER);
    await queueStitch(HER, withSound([both], both));
    const [job] = await claimStitchJobs(1, RUNNER_ID);

    expect(await workStitch(job)).toBe("succeeded");
    expect(fetched).toHaveLength(1);
    const req = mockStitch.mock.calls[0][0];
    // The same file on disk serves as the picture and as the sound.
    expect(req.audioBed!.source).toBe(req.clips[0].source);
  });

  it("charges her video its REAL bytes, not the curated bed's 25 MB ceiling", async () => {
    // The ceiling is a number about the PRODUCT's tracks. On the default 664 MB source budget:
    // three 180 MB clips + a 180 MB sound video is 720 MB — over. Charged at the 25 MB ceiling it
    // would have been 565 MB and sailed through, into a workspace that is RAM.
    const MB = 1024 * 1024;
    const clips = [
      await seedAsset(HER, 180 * MB),
      await seedAsset(HER, 180 * MB),
      await seedAsset(HER, 180 * MB),
    ];
    const big = await seedAsset(HER, 180 * MB);

    const id = await queueStitch(HER, withSound(clips, big));
    const [job] = await claimStitchJobs(1, RUNNER_ID);
    expect(await workStitch(job)).toBe("failed");
    expect((await readJob(id)).last_error).toMatch(/needs about 720 MB/);
    expect(fetched).toEqual([]);

    // The control: the SAME three clips with no sound video fit, so it is her video that tipped it.
    const ok = await queueStitch(HER, spec(clips));
    const [second] = await claimStitchJobs(1, RUNNER_ID);
    expect(await workStitch(second)).toBe("succeeded");
    expect((await readJob(ok)).status).toBe("succeeded");
  });

  it("never downloads a curated bed alongside it", async () => {
    serveBed();
    const clip = await seedAsset(HER);
    const sound = await seedAsset(HER);
    await queueStitch(HER, withSound([clip], sound));
    const [job] = await claimStitchJobs(1, RUNNER_ID);

    expect(await workStitch(job)).toBe("succeeded");
    expect(fetched.some((p) => p.startsWith("studio/beds/"))).toBe(false);
  });
});

describe("captions", () => {
  // ⚠️ NEITHER IS AT A DEFAULT-LOOKING VALUE, ON PURPOSE. With the queued caption at "bottom", a
  // runner that ignored the stored position and always drew at the bottom passed the
  // quote-matches-run test below (found by revert check). Top and middle leave it nowhere to hide.
  const GAME_DAY: Caption = {
    text: "Game day",
    position: "top",
    style: "boxed",
    // Not the default either, for the same reason: a runner that dropped the colour would draw
    // white, and a white fixture could not tell.
    color: "yellow",
  };
  const EDITED: Caption = {
    text: "Something else",
    position: "middle",
    style: "bold",
  };

  const captioned = (assetId: string, caption: Caption): StitchSpec => ({
    clips: [{ assetId, caption }],
    target: "portrait",
  });

  /** The engine's request, plus the BYTES of each picture it was handed — read while they exist. */
  function recordingEngine() {
    const seen: { y: number; png: Buffer; source: string }[][] = [];
    mockStitch.mockImplementation((async (req: {
      outputPath: string;
      clips: { overlay?: { source: string; y: number } }[];
    }) => {
      seen.push(
        req.clips.flatMap((c) =>
          c.overlay
            ? [{ ...c.overlay, png: readFileSync(c.overlay.source) }]
            : [],
        ),
      );
      writeFileSync(req.outputPath, Buffer.alloc(1234, 3));
      return manifest();
    }) as never);
    return seen;
  }

  it("stitches the caption that was queued, not a live one", async () => {
    // THE QUOTE-MATCHES-RUN CHECK, for words. She queues "Game day", then keeps editing and queues
    // again with something else. The FIRST job must burn in the first caption — drawn from its own
    // row — and the pixels handed to ffmpeg must be exactly the render of what that row stores.
    const a = await seedAsset(HER);
    await queueStitch(HER, captioned(a, GAME_DAY));
    await queueStitch(HER, captioned(a, EDITED));
    const [first] = await claimStitchJobs(1, RUNNER_ID);
    const seen = recordingEngine();

    expect(await workStitch(first)).toBe("succeeded");

    const want = await renderCaptionBand(GAME_DAY, STITCH_TARGETS.portrait);
    const other = await renderCaptionBand(EDITED, STITCH_TARGETS.portrait);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
    expect(seen[0][0].png.equals(want.png)).toBe(true);
    expect(seen[0][0].y).toBe(want.y);
    // The control: the two captions really do draw differently, so equality above means something.
    expect(want.png.equals(other.png)).toBe(false);
    expect(want.y).not.toBe(other.y);
  });

  it("draws into the WORKSPACE, and the picture is gone with it", async () => {
    const a = await seedAsset(HER);
    await queueStitch(HER, captioned(a, GAME_DAY));
    const [job] = await claimStitchJobs(1, RUNNER_ID);
    const seen = recordingEngine();

    expect(await workStitch(job)).toBe("succeeded");
    expect(seen[0][0].source).toMatch(/studio-stitch-.*caption-0\.png$/);
    // A local path inside the disposable directory — and nothing of her words in its name.
    expect(seen[0][0].source).not.toMatch(/game|day/i);
    expect(existsSync(seen[0][0].source)).toBe(false);
    expect(leaked()).toEqual([]);
  });

  it("captions the POSITION, so one clip used twice can say two things", async () => {
    const a = await seedAsset(HER);
    await queueStitch(HER, {
      clips: [
        { assetId: a, trimEndSec: 0.5, caption: GAME_DAY },
        { assetId: a, trimStartSec: 0.5 },
        { assetId: a, trimStartSec: 0.2, trimEndSec: 0.4, caption: EDITED },
      ],
      target: "portrait",
    } satisfies StitchSpec);
    const [job] = await claimStitchJobs(1, RUNNER_ID);
    mockStitch.mockImplementation(writesOutput());

    expect(await workStitch(job)).toBe("succeeded");
    const req = mockStitch.mock.calls[0][0];
    expect(req.clips.map((c) => (c.overlay ? c.overlay.y : null))).toEqual([
      expect.any(Number),
      null,
      expect.any(Number),
    ]);
    expect(req.clips[0].overlay!.y).not.toBe(req.clips[2].overlay!.y);
    expect(req.clips[0].overlay!.source).not.toBe(req.clips[2].overlay!.source);
  });

  it("hands the engine no picture at all for a timeline without captions", async () => {
    const a = await seedAsset(HER);
    await queueStitch(HER, spec([a]));
    const [job] = await claimStitchJobs(1, RUNNER_ID);

    expect(await workStitch(job)).toBe("succeeded");
    const req = mockStitch.mock.calls[0][0];
    expect(req.clips.every((c) => !("overlay" in c))).toBe(true);
  });
});

describe("stills", () => {
  /** One of her photos, served as real JPEG bytes — sharp has to be able to decode what it fetches. */
  async function seedPhoto(owner: string, bytes?: Buffer): Promise<string> {
    const [row] = await db
      .insert(mediaAssets)
      .values({
        athlete_id: owner,
        platform: "studio",
        origin: "upload",
        media_type: "IMAGE",
        status: "stored",
        approval_status: "approved",
        gcs_path: `athletes/${owner}/photo-${Math.random().toString(36).slice(2)}.jpg`,
        content_type: "image/jpeg",
        bytes: 1_000,
        ingested_at: new Date(),
      } as never)
      .returning({ id: mediaAssets.id, gcs_path: mediaAssets.gcs_path });
    served.set(
      row.gcs_path!,
      bytes ??
        (await sharp({
          create: {
            width: 600,
            height: 400,
            channels: 3,
            background: { r: 10, g: 140, b: 60 },
          },
        })
          .jpeg()
          .toBuffer()),
    );
    return row.id;
  }

  /** The engine's request, with each still clip PROBED while the workspace still exists. */
  function probingEngine() {
    const seen: {
      sources: string[];
      timeoutMs?: number;
      stillSeconds: (number | null)[];
    }[] = [];
    mockStitch.mockImplementation((async (req: any) => {
      seen.push({
        sources: req.clips.map((c: any) => c.source),
        timeoutMs: req.timeoutMs,
        stillSeconds: await Promise.all(
          req.clips.map(async (c: any) =>
            /still-\d+\.mp4$/.test(c.source)
              ? (await probeMedia(c.source)).durationSec
              : null,
          ),
        ),
      });
      writeFileSync(req.outputPath, Buffer.alloc(1234, 3));
      return manifest();
    }) as never);
    return seen;
  }

  it("hands the engine an encoded clip at the still's POSITION — never the photo", async () => {
    const v = await seedAsset(HER);
    const p = await seedPhoto(HER);
    await queueStitch(HER, {
      clips: [{ assetId: v }, { assetId: p, stillSec: 2, crossfadeSec: 0.5 }],
      target: "portrait",
    } satisfies StitchSpec);
    const [job] = await claimStitchJobs(1, RUNNER_ID);
    const seen = probingEngine();

    expect(await workStitch(job)).toBe("succeeded");
    expect(seen).toHaveLength(1);
    expect(seen[0].sources[0]).toMatch(/\.mp4$/);
    expect(seen[0].sources[0]).not.toMatch(/still-/);
    expect(seen[0].sources[1]).toMatch(/studio-stitch-.*still-1\.mp4$/);
    expect(seen[0].stillSeconds).toEqual([null, expect.closeTo(2, 2)]);
    expect(mockStitch.mock.calls[0][0].clips[1].transitionIn).toEqual({
      kind: "crossfade",
      durationSec: 0.5,
    });
    expect(leaked()).toEqual([]);
  });

  it("holds the same photo for two lengths as two clips, downloaded once", async () => {
    const p = await seedPhoto(HER);
    await queueStitch(HER, {
      clips: [
        { assetId: p, stillSec: 2 },
        { assetId: p, stillSec: 3 },
      ],
      target: "portrait",
    } satisfies StitchSpec);
    const [job] = await claimStitchJobs(1, RUNNER_ID);
    const seen = probingEngine();

    expect(await workStitch(job)).toBe("succeeded");
    expect(seen[0].sources[0]).not.toBe(seen[0].sources[1]);
    expect(seen[0].stillSeconds).toEqual([
      expect.closeTo(2, 2),
      expect.closeTo(3, 2),
    ]);
    expect(fetched.filter((f) => f.includes("photo-"))).toHaveLength(1);
  });

  /**
   * ⚠️ MUTATION "runner drops the point": encodeStills stops passing `clip.stillFocus` — this reds by
   * name. Her tap is on the RIGHT; untapped, the zoom heads for the upper middle, whose window
   * reaches the red marker on the LEFT — so a dropped tap puts the marker in the first frame.
   */
  it("hands her tapped point to the encode — a zoom heads where she tapped, not to the framing prior (A1)", async () => {
    const marker = await sharp({
      create: {
        width: 120,
        height: 160,
        channels: 3,
        background: { r: 235, g: 15, b: 15 },
      },
    })
      .png()
      .toBuffer();
    const p = await seedPhoto(
      HER,
      await sharp({
        create: {
          width: 1200,
          height: 1600,
          channels: 3,
          background: { r: 110, g: 110, b: 110 },
        },
      })
        .composite([{ input: marker, left: 120, top: 720 }])
        .jpeg()
        .toBuffer(),
    );
    await queueStitch(HER, {
      clips: [
        {
          assetId: p,
          stillSec: 2,
          stillMotion: "zoom",
          stillFocus: { x: 0.85, y: 0.5 },
        },
      ],
      target: "portrait",
    } satisfies StitchSpec);
    const [job] = await claimStitchJobs(1, RUNNER_ID);
    let redPixels = -1;
    mockStitch.mockImplementation((async (req: any) => {
      const { stdout } = await promisify(execFile)(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          req.clips[0].source,
          "-frames:v",
          "1",
          "-vf",
          "format=rgb24",
          "-f",
          "rawvideo",
          "-",
        ],
        { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
      );
      const buf = stdout as unknown as Buffer;
      redPixels = 0;
      for (let i = 0; i < buf.length; i += 3) {
        if (buf[i] > 180 && buf[i + 1] < 80 && buf[i + 2] < 80) redPixels++;
      }
      writeFileSync(req.outputPath, Buffer.alloc(1234, 3));
      return manifest();
    }) as never);

    expect(await workStitch(job)).toBe("succeeded");
    // The window around x = 0.85 is the photo's right 900 px; the marker sits at x 120–240.
    expect(redPixels).toBe(0);
  });

  /** ⚠️ MUTATION "runner drops the look": encodeStills stops passing `spec.look` — this reds by name. */
  it("lays the set's look over each photo — black and white arrives with no colour (A3)", async () => {
    const p = await seedPhoto(HER); // green-ish (10, 140, 60)
    await queueStitch(HER, {
      clips: [{ assetId: p, stillSec: 1 }],
      target: "portrait",
      look: "mono",
    } satisfies StitchSpec);
    const [job] = await claimStitchJobs(1, RUNNER_ID);
    let spread = -1;
    mockStitch.mockImplementation((async (req: any) => {
      const { stdout } = await promisify(execFile)(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          req.clips[0].source,
          "-frames:v",
          "1",
          "-vf",
          "crop=200:200:440:860,scale=1:1:flags=area,format=rgb24",
          "-f",
          "rawvideo",
          "-",
        ],
        { encoding: "buffer" },
      );
      const px = [...(stdout as unknown as Buffer)];
      spread = Math.max(...px) - Math.min(...px);
      writeFileSync(req.outputPath, Buffer.alloc(1234, 3));
      return manifest();
    }) as never);

    expect(await workStitch(job)).toBe("succeeded");
    // Ungraded, this photo's channels are 130 apart.
    expect(spread).toBeLessThanOrEqual(6);
  });

  it("spends the engine's own budget, so the lease still covers the work", async () => {
    const p = await seedPhoto(HER);
    await queueStitch(HER, {
      clips: [{ assetId: p, stillSec: 2 }],
      target: "portrait",
    });
    const [job] = await claimStitchJobs(1, RUNNER_ID);
    const seen = probingEngine();

    expect(await workStitch(job)).toBe("succeeded");
    expect(seen[0].timeoutMs).toBeGreaterThan(0);
    expect(seen[0].timeoutMs).toBeLessThan(stitchTimeoutMs());
    expect(leaseCoversWork()).toBe(true);
  });

  it("fails the job — engine never called, workspace gone — when a photo cannot be decoded", async () => {
    const p = await seedPhoto(HER, Buffer.from("not a jpeg at all"));
    await queueStitch(HER, {
      clips: [{ assetId: p, stillSec: 2 }],
      target: "portrait",
    });
    const [job] = await claimStitchJobs(1, RUNNER_ID);
    mockStitch.mockImplementation(writesOutput());

    expect(await workStitch(job)).toBe("failed");
    expect(mockStitch).not.toHaveBeenCalled();
    expect((await readJob(job.id)).last_error).not.toMatch(
      /sharp|jpeg|ffmpeg|\/tmp|studio-stitch/i,
    );
    expect(leaked()).toEqual([]);
  });
});

describe("stitchTick", () => {
  it("returns without waiting for ffmpeg", async () => {
    // The whole reason a scheduler deadline is not load-bearing. `stitch` never resolves; the tick
    // must still come back, having claimed and started the row.
    const a = await seedAsset(HER);
    const id = await queueStitch(HER, spec([a]));
    const engine = hangingEngine();

    const out = await Promise.race([
      stitchTick(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("tick blocked on ffmpeg")), 2_000),
      ),
    ]);

    expect(out).toMatchObject({ claimed: 1, atCapacity: false });
    expect((await readJob(id)).status).toBe("running");

    await engine.entered;
    engine.release();
    await settle();
    expect((await readJob(id)).status).toBe("succeeded");
  });

  it("claims NOTHING while this instance is already at capacity", async () => {
    // ⚠️  THE PER-INSTANCE MEMORY BOUND. Nothing in Postgres enforces it: SKIP LOCKED's purpose is
    // to hand the second caller a DIFFERENT row, which is exactly the case that doubles the RAM.
    // Removing the guard reds here with two claimed jobs and two live workspaces.
    const a = await seedAsset(HER);
    const b = await seedAsset(HER);
    const first = await queueStitch(HER, spec([a]));
    const second = await queueStitch(HER, spec([b]));

    const engine = hangingEngine();

    const one = await stitchTick();
    expect(one.claimed).toBe(1);
    expect(inFlightCount()).toBe(1);

    // Wait until the FIRST job is inside ffmpeg before measuring. Its own download finishes after
    // the tick returned (that is the claim-and-return property), so counts taken any earlier would
    // move on their own and the assertions below would be measuring the wrong job.
    await engine.entered;

    // The scheduler tick landing on the same instance as the route's inline kick.
    const fetchesBefore = fetched.length;
    const workspacesBefore = leaked().length;
    expect(workspacesBefore).toBe(1); // the first job's, and only the first job's
    const two = await stitchTick();

    // ⚠️  MEASURED AFTER A SETTLE WINDOW, AND THAT IS THE WHOLE POINT. Asserting straight after
    // the tick returns proves nothing about I/O: the tick returns BEFORE its work downloads
    // anything, so the counts are unmoved even when a job WAS wrongly claimed and is about to
    // fetch. Verified — with the guard removed this assertion passed and the test only reds on the
    // count below. Letting the loop turn first is what makes "a refused tick costs nothing" a
    // claim about behaviour rather than about timing.
    await new Promise((r) => setTimeout(r, 100));

    // IT COST NOTHING TO REFUSE. The guard is checked BEFORE the claim, so a tick with no
    // room does no I/O at all: no row taken, no signed url, no byte downloaded, no workspace
    // created. A guard placed after the claim would look identical in the counts above and would
    // already have spent the bandwidth and the RAM it exists to protect.
    expect(fetched.length).toBe(fetchesBefore);
    expect(leaked().length).toBe(workspacesBefore);
    expect(mockSignedUrl).toHaveBeenCalledTimes(fetchesBefore);

    expect(two).toMatchObject({ claimed: 0, atCapacity: true, inFlight: 1 });

    // The second job is untouched and still visible to an instance that has room.
    expect((await readJob(second)).status).toBe("queued");
    expect((await readJob(second)).attempts).toBe(0);

    engine.release();
    await settle();
    expect(inFlightCount()).toBe(0);

    // With the first finished, the next tick takes the second.
    mockStitch.mockImplementation(writesOutput());
    expect((await stitchTick()).claimed).toBe(1);
    await settle();
    expect((await readJob(first)).status).toBe("succeeded");
  });

  it("contains a poison row to itself — one bad job does not stop the queue", async () => {
    // ⚠️  ONE BAD ROW MUST NOT TAKE THE TICK DOWN. If a per-job failure escaped into the tick, the
    // other jobs claimed in the same batch would be left `running` under leases nobody is honouring
    // — stalled until the reaper's clock runs out, on a queue that looks busy and is doing nothing.
    //
    // This runner is structurally immune for a reason that is NOT "the resolve is inside the try":
    // the work is DETACHED with a .catch, and an async function cannot throw synchronously at its
    // call site. That is a property a refactor can remove without noticing — awaiting the work
    // instead of voiding it reintroduces exactly this failure, and it is one of the mutations this
    // suite already runs. So the containment is pinned here rather than argued.
    //
    // (The shape came from a peer session that walked into it on the video runner, where resolving
    // a provider adapter outside workJob's try killed the whole tick and stranded its batch.)
    process.env.STUDIO_STITCH_CONCURRENCY = "2";
    try {
      const good = await seedAsset(HER);
      // A spec no parser will accept: no clips, no target. It fails before anything is resolved.
      const poisonId = await queueStitch(HER, { nonsense: true });
      const goodId = await queueStitch(HER, spec([good]));

      const out = await stitchTick();
      expect(out.claimed).toBe(2);
      await settle();

      // The good one went all the way through.
      expect((await readJob(goodId)).status).toBe("succeeded");

      // The bad one is CLOSED, not abandoned mid-flight holding a lease.
      const poison = await readJob(poisonId);
      expect(poison.status).toBe("failed");
      expect(poison.lease_holder).toBeNull();
      expect(poison.lease_until).toBeNull();
      expect(poison.completed_at).not.toBeNull();

      // And nothing is left occupying this instance's capacity.
      expect(inFlightCount()).toBe(0);
      expect(leaked()).toEqual([]);
    } finally {
      delete process.env.STUDIO_STITCH_CONCURRENCY;
    }
  });

  it("reaps before it claims, so a lapsed job is available to the same tick", async () => {
    const a = await seedAsset(HER);
    const id = await queueStitch(HER, spec([a]));
    await claimStitchJobs(1, "a-dead-instance");
    await db
      .update(studioStitchJobs)
      .set({ lease_until: new Date(Date.now() - 1000) })
      .where(eq(studioStitchJobs.id, id));

    const out = await stitchTick();
    expect(out.reaped).toEqual({ exhausted: 0, requeued: 1 });
    expect(out.claimed).toBe(1);
    await settle();
  });

  it("keeps the lease longer than the work it covers", () => {
    expect(leaseCoversWork()).toBe(true);
  });
});

// ─── 3. No spend surface ────────────────────────────────────────────────────────────────────────

describe("no spend surface", () => {
  const SERVER = join(__dirname, "..");
  const REPO = join(SERVER, "..");
  const code = (src: string) =>
    src
      .replace(/^\s*\/\*[\s\S]*?\*\//gm, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const SPEC_RE =
    /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*["']([^"']+)["']/g;

  function reach(entry: string): Set<string> {
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const m of code(readFileSync(file, "utf8")).matchAll(SPEC_RE)) {
        const s = m[1] ?? m[2] ?? m[3] ?? m[4];
        if (!s.startsWith(".")) continue;
        const stem = resolve(dirname(file), s.replace(/\.js$/, ""));
        const hit = [`${stem}.ts`, `${stem}.tsx`, join(stem, "index.ts")].find(
          (c) => existsSync(c),
        );
        if (hit) stack.push(hit);
      }
    }
    return new Set([...seen].map((f) => relative(REPO, f)));
  }

  const SPEND = [
    "server/studio/generate.ts",
    "server/studio/router.ts",
    "server/studio/adapters/",
    "server/studio/preview.ts",
    "server/studio/previewStore.ts",
    "server/studio/interpret/",
    "server/studio/compile/",
    "server/studio/qa/",
    "server/lib/models.ts",
  ];
  const spendIn = (files: Set<string>) =>
    [...files].filter((f) => SPEND.some((s) => f === s || f.startsWith(s)));

  it("the walk can see a spend path, so an empty answer means something", () => {
    expect(
      spendIn(reach(join(SERVER, "routes", "studio.ts"))).length,
    ).toBeGreaterThan(0);
  });

  it("the runner reaches the stitch engine and nothing that can spend", () => {
    const from = reach(join(SERVER, "studio", "stitchRunner.ts"));
    expect(from).toContain("server/studio/video/stitch.ts"); // the walk followed it into the engine
    expect(from).toContain("server/studio/video/materialize.ts");
    expect(spendIn(from)).toEqual([]);
  });

  it("is ticked by its own endpoint, with its own lock key", () => {
    const index = readFileSync(join(SERVER, "index.ts"), "utf8");
    expect(index).toMatch(/\/api\/internal\/studio-stitch-tick/);
    // Two keys, two queues. One value for both would silently serialise the money path behind this.
    const video = index.match(/STUDIO_VIDEO_TICK_LOCK_KEY = (\S+);/)![1];
    const stitchKey = index.match(/STUDIO_STITCH_TICK_LOCK_KEY = (\S+);/)![1];
    expect(stitchKey).not.toBe(video);
  });
});
