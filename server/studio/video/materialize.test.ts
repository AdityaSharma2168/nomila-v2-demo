/**
 * materialize.test.ts — the asset ↔ local-path bridge, before anything is wired to it.
 *
 * ─── WHAT IS REAL HERE AND WHAT IS MOCKED ───────────────────────────────────────────────────────
 *
 * REAL: the database (PGlite — real SQL, the real tenancy predicate, the real FKs), and the whole
 * streaming path. `fetch` is stubbed to return an ordinary `Response`, whose body IS a web
 * ReadableStream, so Readable.fromWeb, the counting Transform, `pipeline` and the file write all
 * execute exactly as they will in production. A test that mocked the download would assert that a
 * function was called; these assert that bytes landed on disk and that they stop landing at the cap.
 *
 * MOCKED: only the two GCS calls that would cross the network — `signedUrl` and `uploadLocalFile`.
 *
 * ─── THE PROPERTIES WORTH BREAKING ──────────────────────────────────────────────────────────────
 *
 *   1. TENANCY. A spec naming another athlete's asset fails closed BEFORE any byte moves, and does
 *      so with the same answer a nonexistent id gets — a spec must not be usable to probe someone
 *      else's library. Mutation: drop the athlete_id predicate from resolveClips → red.
 *   2. CLEANUP. The workspace is gone after a mid-download failure. /tmp is RAM on Cloud Run, so a
 *      leaked workspace is leaked memory on the instance, not a stale file on a disk somewhere.
 *   3. THE OUTPUT ROW. It carries generation_job_id NULL — anything else violates that column's FK
 *      to generation_jobs — and matches the media-poster cron's selection, so the poster arrives
 *      without new code.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/mediaStore", () => ({
  signedUrl: jest.fn(),
  uploadLocalFile: jest.fn(),
  // The real value, mirrored: a clip may be as large as an upload may be. Pinned in a test below so
  // this copy cannot drift from mediaStore's own constant unnoticed.
  UPLOAD_LIMITS: {
    image: { max: 25 * 1024 * 1024, types: [] },
    video: { max: 200 * 1024 * 1024, types: [] },
  },
}));

import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, initTestDb, closeTestDb } from "../../testUtils/pgliteDb";
import { athletes, mediaAssets } from "../../../shared/schema";
import { signedUrl, uploadLocalFile } from "../../lib/mediaStore";
import {
  assertProbedTimelineFits,
  assertTimelineFits,
  clipMaxBytes,
  describeLimits,
  effectiveSeconds,
  materializeWorkspace,
  maxClips,
  maxSourceBytes,
  maxTimelineSeconds,
  outputAllowanceBytes,
  publishStitchOutput,
  resolveClips,
  resolveTimeline,
  stitchLimits,
  stillWorkBytes,
  STILL_PREP_MAX_BYTES,
  workspaceMaxBytes,
  MaterializeError,
} from "./materialize";

/** A root only this suite writes to — see tmpDirs() at the foot of the file. */
const WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), "materialize-test-"));

const HER = "77777777-7777-4777-8777-777777777777";
const SOMEONE_ELSE = "88888888-8888-4888-8888-888888888888";

const mockSignedUrl = signedUrl as jest.MockedFunction<typeof signedUrl>;
const mockUpload = uploadLocalFile as jest.MockedFunction<
  typeof uploadLocalFile
>;

/** What each gcs path should serve, as bytes. Keyed by path so a dedupe failure is countable. */
let served: Map<string, Buffer>;
let fetchCount: Map<string, number>;

beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values([
    { id: HER, full_name: "Timeline Athlete" },
    { id: SOMEONE_ELSE, full_name: "Another Athlete" },
  ] as never);
});
afterAll(async () => {
  await closeTestDb();
  rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.delete(mediaAssets);
  served = new Map();
  fetchCount = new Map();
  jest.clearAllMocks();
  delete process.env.STUDIO_STITCH_CLIP_MAX_BYTES;
  delete process.env.STUDIO_STITCH_WORKSPACE_MAX_BYTES;
  process.env.STUDIO_STITCH_WORKSPACE_DIR = WORKSPACE_ROOT;

  // The signed url IS the gcs path here, so the stub can look up what to serve.
  mockSignedUrl.mockImplementation(
    async (gcsPath: string) => `https://signed.test/${gcsPath}`,
  );
  global.fetch = jest.fn(async (url: string | URL | Request) => {
    const path = String(url).replace("https://signed.test/", "");
    fetchCount.set(path, (fetchCount.get(path) ?? 0) + 1);
    const body = served.get(path);
    if (!body) return new Response(null, { status: 404 });
    // Uint8Array, not Buffer: Buffer is not a DOM BodyInit as TypeScript declares it.
    return new Response(new Uint8Array(body));
  }) as never;
});

/**
 * The error a call produced — and a failure if it produced none. Better than casting the result of
 * `.catch()`: that yields a union TypeScript cannot narrow, and it passes silently when the call it
 * was meant to prove refuses actually resolves.
 */
async function failure(p: Promise<unknown>): Promise<MaterializeError> {
  try {
    await p;
  } catch (err) {
    return err as MaterializeError;
  }
  throw new Error("expected this to be refused, but it resolved");
}

/** A stored clip of `size` bytes, belonging to `athleteId`. */
async function seedClip(
  athleteId: string,
  opts: {
    size?: number;
    mediaType?: string;
    status?: string;
    bytes?: number | null;
    /** The INTEGER column — what the picker asserted. Defaults to 5, as every existing test assumes. */
    durationSeconds?: number | null;
    /** The MEASURED column (0058). Defaults to NULL, which is every row written before this work. */
    durationSecondsPrecise?: number | null;
  } = {},
): Promise<string> {
  const size = opts.size ?? 64;
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: athleteId,
      platform: "studio",
      origin: "upload",
      media_type: opts.mediaType ?? "VIDEO",
      status: opts.status ?? "stored",
      gcs_path: `athletes/${athleteId}/uploads/${Math.random().toString(36).slice(2)}.mp4`,
      content_type: "video/mp4",
      duration_seconds:
        opts.durationSeconds === undefined ? 5 : opts.durationSeconds,
      duration_seconds_precise: opts.durationSecondsPrecise ?? null,
      bytes: opts.bytes === undefined ? size : opts.bytes,
      ingested_at: new Date(),
    } as never)
    .returning({ id: mediaAssets.id, gcs_path: mediaAssets.gcs_path });
  served.set(row.gcs_path!, Buffer.alloc(size, 7));
  return row.id;
}

const pathOf = async (assetId: string) =>
  (
    await db
      .select({ p: mediaAssets.gcs_path })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, assetId))
  )[0].p!;

// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where "measured beats asserted" actually lands for duration (migration 0058).
 *
 * The write side of 0058 deliberately does NOT touch duration_seconds — one provenance per column,
 * and the picker's readers were not asked to change. That makes the READ side the only place the
 * doctrine can be honoured, and this is it: resolveClips prefers the measured fraction and falls
 * back to the asserted integer. If that preference is ever reversed or dropped, the cap estimate
 * silently goes back to being wrong by up to half a second per clip, with nothing else to notice.
 */
describe("resolveClips: the measured duration is preferred over the asserted one", () => {
  /**
   * ⚠️  THE REVERT CHECK FOR THE PRECISION READ.
   *
   * MUTATION: change `row.duration_seconds_precise ?? row.duration_seconds` back to
   * `row.duration_seconds` in resolveClips. This reds on 8.033 vs 8 — and note the integer here is
   * the WRONG WAY (8 for a clip that is really 8.033), which is the direction that lets a timeline
   * slip under a cap it should not.
   */
  it("takes the fraction when the row has one", async () => {
    const id = await seedClip(HER, {
      durationSeconds: 8,
      durationSecondsPrecise: 8.033,
    });

    const [clip] = await resolveClips(HER, [id]);

    expect(clip.durationSeconds).toBeCloseTo(8.033, 6);
    expect(effectiveSeconds({ assetId: id }, clip)).toBeCloseTo(8.033, 6);
  });

  /**
   * Every row written before 0058 looks like this, and most Instagram video rows always will: the
   * clip holds a poster JPEG, so there are no bytes on our side to measure and the precise column
   * stays NULL forever. The integer must still be used — falling through to the byte-implied
   * estimate here would be a regression, because an asserted 5 is far better than bytes ÷ bitrate.
   */
  it("falls back to the integer when nothing was ever measured", async () => {
    const id = await seedClip(HER, {
      durationSeconds: 5,
      durationSecondsPrecise: null,
    });

    const [clip] = await resolveClips(HER, [id]);

    expect(clip.durationSeconds).toBe(5);
  });

  /**
   * Both NULL is still a legal row, and it must still reach the byte-implied estimate rather than
   * being read as a zero-length clip. A 0 here would let any timeline past the seconds cap.
   */
  it("leaves durationSeconds null when neither column holds anything", async () => {
    const id = await seedClip(HER, {
      durationSeconds: null,
      durationSecondsPrecise: null,
    });

    const [clip] = await resolveClips(HER, [id]);

    expect(clip.durationSeconds).toBeNull();
    // The documented fallback: bytes ÷ output bitrate, NOT zero.
    expect(effectiveSeconds({ assetId: id }, clip)).toBeGreaterThan(0);
  });

  /**
   * A trim window is exact and outranks both columns — unchanged by 0058, pinned because the
   * coalesce above sits directly upstream of it.
   */
  it("still lets an explicit trim win over either column", async () => {
    const id = await seedClip(HER, {
      durationSeconds: 30,
      durationSecondsPrecise: 29.97,
    });

    const [clip] = await resolveClips(HER, [id]);

    expect(
      effectiveSeconds({ assetId: id, trimStartSec: 2, trimEndSec: 5.5 }, clip),
    ).toBeCloseTo(3.5, 6);
  });
});

describe("resolveClips: tenancy is resolved here, because the runner has no request", () => {
  /**
   * THE REVERT CHECK. MUTATION: remove `eq(mediaAssets.athlete_id, athleteId)` from resolveClips'
   * where-clause and this goes red — the foreign asset resolves and would be downloaded and stitched
   * into her video.
   */
  it("refuses a clip belonging to another athlete", async () => {
    const hers = await seedClip(HER);
    const theirs = await seedClip(SOMEONE_ELSE);

    await expect(resolveClips(HER, [hers, theirs])).rejects.toThrow(
      MaterializeError,
    );
  });

  /**
   * "Not yours" and "doesn't exist" must be the SAME answer. A spec that could tell them apart is a
   * way to ask whether a given uuid is in someone else's library.
   */
  it("gives a foreign asset and a nonexistent one the same answer", async () => {
    const theirs = await seedClip(SOMEONE_ELSE);
    const nonexistent = "99999999-9999-4999-8999-999999999999";

    const foreign = await failure(resolveClips(HER, [theirs]));
    const absent = await failure(resolveClips(HER, [nonexistent]));

    expect(foreign.code).toBe("not_found");
    expect(absent.code).toBe("not_found");
    expect(foreign.message).toBe(absent.message);
  });

  it("resolves her own clips, in the order the timeline asked for", async () => {
    const a = await seedClip(HER);
    const b = await seedClip(HER);

    const resolved = await resolveClips(HER, [b, a]);

    expect(resolved.map((c) => c.assetId)).toEqual([b, a]);
  });

  it("refuses a soft-deleted clip", async () => {
    const id = await seedClip(HER);
    await db
      .update(mediaAssets)
      .set({ deleted_at: new Date() } as never)
      .where(eq(mediaAssets.id, id));

    await expect(resolveClips(HER, [id])).rejects.toThrow(MaterializeError);
  });

  /** An IMAGE in a stitch spec is a caller bug and should read as one, not as an ffmpeg decode failure. */
  it("refuses a photo, by name", async () => {
    const photo = await seedClip(HER, { mediaType: "IMAGE" });

    const err = await failure(resolveClips(HER, [photo]));

    expect(err.code).toBe("not_a_video");
    expect(err.message).toMatch(/IMAGE/);
  });

  it("accepts a REELS clip — an Instagram reel is a clip", async () => {
    const reel = await seedClip(HER, { mediaType: "REELS" });

    await expect(resolveClips(HER, [reel])).resolves.toHaveLength(1);
  });

  /**
   * media_assets.status is ('stored','failed','skipped_size') — there is no "pending". Both
   * non-stored states mean the bytes never arrived, so the row exists and the file does not.
   */
  it.each(["failed", "skipped_size"])(
    "refuses a clip whose file never arrived (%s)",
    async (status) => {
      const absent = await seedClip(HER, { status });

      await expect(resolveClips(HER, [absent])).rejects.toThrow(
        MaterializeError,
      );
    },
  );

  it("refuses an empty timeline", async () => {
    await expect(resolveClips(HER, [])).rejects.toThrow(MaterializeError);
  });
});

describe("materializeWorkspace: bytes actually land, once per clip", () => {
  it("writes each clip to the workspace with its real bytes", async () => {
    const a = await seedClip(HER, { size: 128 });
    const b = await seedClip(HER, { size: 256 });

    const ws = await materializeWorkspace(HER, [a, b]);
    try {
      expect(readFileSync(ws.paths.get(a)!).byteLength).toBe(128);
      expect(readFileSync(ws.paths.get(b)!).byteLength).toBe(256);
      // stitch() requires the output's directory to exist; it is the workspace itself.
      expect(existsSync(ws.dir)).toBe(true);
      expect(ws.outputPath.startsWith(ws.dir)).toBe(true);
    } finally {
      await ws.dispose();
    }
  });

  /**
   * The same clip twice in a timeline is an ordinary edit — a cutaway back to the first shot. It
   * must be downloaded ONCE. Mutation: resolve with a plain `map` over assetIds rather than over the
   * unique set → two fetches, red.
   */
  it("downloads a clip used twice only once", async () => {
    const a = await seedClip(HER);

    const ws = await materializeWorkspace(HER, [a, a, a]);
    try {
      expect(fetchCount.get(await pathOf(a))).toBe(1);
      expect(ws.paths.size).toBe(1);
    } finally {
      await ws.dispose();
    }
  });

  it("never downloads anything when tenancy fails", async () => {
    const theirs = await seedClip(SOMEONE_ELSE);
    const hers = await seedClip(HER);

    await expect(materializeWorkspace(HER, [hers, theirs])).rejects.toThrow(
      MaterializeError,
    );

    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("materializeWorkspace: the memory ceiling refuses before it OOMs", () => {
  /** Refused on the sizes the ROWS carry, before a single byte is fetched. */
  it("refuses a timeline whose clips exceed the workspace budget, up front", async () => {
    process.env.STUDIO_STITCH_WORKSPACE_MAX_BYTES = "100";
    const a = await seedClip(HER, { size: 60 });
    const b = await seedClip(HER, { size: 60 });

    const err = await failure(materializeWorkspace(HER, [a, b]));

    expect(err.code).toBe("workspace_too_large");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  /**
   * A row with no byte count is charged at the per-clip CEILING, not at zero. An unknown size must
   * never be treated as free — the same posture the spend gate takes on an unpriced model.
   * MUTATION: `c.bytes ?? 0` → the budget passes and the instance finds out by dying.
   */
  it("charges a clip of unknown size at the ceiling rather than at zero", async () => {
    process.env.STUDIO_STITCH_CLIP_MAX_BYTES = "1000";
    process.env.STUDIO_STITCH_WORKSPACE_MAX_BYTES = "900";
    const unknown = await seedClip(HER, { size: 10, bytes: null });

    const err = await failure(materializeWorkspace(HER, [unknown]));

    expect(err.code).toBe("workspace_too_large");
  });

  /**
   * The row's byte count is a claim, not a fact — the cap is also enforced WHILE WRITING, so an
   * object that is bigger than its row says still cannot fill the instance.
   */
  it("stops a clip that is larger than its row claims, mid-stream", async () => {
    process.env.STUDIO_STITCH_CLIP_MAX_BYTES = "100";
    const lying = await seedClip(HER, { size: 50, bytes: 10 });
    served.set(await pathOf(lying), Buffer.alloc(5000, 1)); // the object is really 5 kB

    const err = await failure(materializeWorkspace(HER, [lying]));

    expect(err.code).toBe("too_large");
  });

  it("reads both caps at call time, so a test — or a redeploy-free change — can move them", () => {
    expect(clipMaxBytes()).toBe(200 * 1024 * 1024);
    expect(workspaceMaxBytes()).toBe(1024 * 1024 * 1024);
    process.env.STUDIO_STITCH_CLIP_MAX_BYTES = "5";
    expect(clipMaxBytes()).toBe(5);
  });

  /** The mocked UPLOAD_LIMITS above mirrors mediaStore's real constant; this is the tripwire. */
  it("uses the same ceiling an upload uses", () => {
    const actual = jest.requireActual("../../lib/mediaStore") as {
      UPLOAD_LIMITS: { video: { max: number } };
    };
    expect(clipMaxBytes()).toBe(actual.UPLOAD_LIMITS.video.max);
  });
});

describe("materializeWorkspace: cleanup, because /tmp is RAM on Cloud Run", () => {
  /**
   * THE REVERT CHECK for cleanup. MUTATION: remove the `catch { await dispose(); throw err }` around
   * the download loop and this reds — the directory survives, holding whatever was downloaded before
   * the failure, on an instance that pays for it in memory.
   */
  it("leaves nothing behind when a download fails half way", async () => {
    const good = await seedClip(HER);
    const bad = await seedClip(HER);
    served.delete(await pathOf(bad)); // 404 on the second clip

    let dirs: string[] = [];
    const before = tmpDirs();
    await expect(materializeWorkspace(HER, [good, bad])).rejects.toThrow(
      MaterializeError,
    );
    dirs = tmpDirs().filter((d) => !before.includes(d));

    expect(dirs).toEqual([]);
  });

  it("leaves nothing behind when the stream errors mid-clip", async () => {
    const a = await seedClip(HER);
    const before = tmpDirs();
    global.fetch = jest.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(8));
              c.error(new Error("connection reset"));
            },
          }),
        ),
    ) as never;

    await expect(materializeWorkspace(HER, [a])).rejects.toThrow();

    expect(tmpDirs().filter((d) => !before.includes(d))).toEqual([]);
  });

  it("dispose() is idempotent — the runner calls it in a finally that may follow an error path", async () => {
    const a = await seedClip(HER);
    const ws = await materializeWorkspace(HER, [a]);

    await ws.dispose();
    await expect(ws.dispose()).resolves.toBeUndefined();
    expect(existsSync(ws.dir)).toBe(false);
  });
});

describe("publishStitchOutput: the return trip", () => {
  // A FRACTION on purpose: ffprobe returns one and the column is an integer.
  const OUT = { width: 1080, height: 1920, durationSeconds: 12.5 };

  async function publish(stitchJobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") {
    const a = await seedClip(HER, { size: 999 });
    const ws = await materializeWorkspace(HER, [a]);
    // Stand in for what stitch() would have written; publish reads its size off the real file.
    const local = ws.paths.get(a)!;
    const out = await publishStitchOutput({
      athleteId: HER,
      stitchJobId,
      localPath: local,
      ...OUT,
    });
    await ws.dispose();
    return out;
  }

  /**
   * generation_job_id MUST be null. media_assets.generation_job_id carries an FK to generation_jobs
   * (studio/sql/generationGuards.sql), so a stitch job id there would be a constraint violation —
   * and PGlite applies the real schema, so this test would fail on the INSERT, not on the assertion.
   */
  it("writes an asset with no generation_job_id — the link lives on the stitch job row", async () => {
    const { assetId } = await publish();

    const [row] = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, assetId));
    expect(row.generation_job_id).toBeNull();
    expect(row.athlete_id).toBe(HER);
    expect(row.origin).toBe("generated");
    expect(row.media_type).toBe("VIDEO");
    expect(row.status).toBe("stored");
    expect(row.width).toBe(1080);
    expect(row.height).toBe(1920);
    // Rounded on the way in — the column is an integer (see publishStitchOutput). Math.round, so
    // 12.5 goes UP here; Postgres's own int4 cast would have rounded half-to-even and said 12.
    expect(row.duration_seconds).toBe(13);
    // ⚠️  THE REVERT CHECK FOR THE STITCH WRITE-BACK (0058). The exact figure ffprobe read off the
    // file we just wrote, which this function has always been handed and until 0058 had nowhere to
    // put — it lived only on the stitch manifest, reachable only through the job.
    //
    // MUTATION: drop `duration_seconds_precise` from publishStitchOutput's `fields`. This reds on
    // null, and the only surviving record of the fraction goes back to being the manifest.
    expect(row.duration_seconds_precise).toBe(12.5);
    expect(row.bytes).toBe(999);
  });

  it("is born draft — a stitch is not a clearance", async () => {
    const { assetId } = await publish();

    const [row] = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, assetId));
    expect(row.approval_status).toBe("draft");
  });

  /**
   * The poster arrives from the EXISTING media-poster cron with no new code, provided the row
   * matches its selection. That predicate is reproduced here verbatim from services/videoPoster.ts,
   * so if either side moves this stops passing.
   */
  it("matches the media-poster cron's selection, so the poster arrives for free", async () => {
    const { assetId } = await publish();

    const queue = await db
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(
        and(
          inArray(mediaAssets.origin, ["upload", "generated"]),
          eq(mediaAssets.media_type, "VIDEO"),
          eq(mediaAssets.status, "stored"),
          isNull(mediaAssets.gcs_thumb_path),
        ),
      );

    expect(queue.map((r) => r.id)).toContain(assetId);
  });

  it("uploads to a stitch-owned path that names the job", async () => {
    const jobId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const { gcsPath } = await publish(jobId);

    expect(gcsPath).toBe(`athletes/${HER}/studio/stitch/${jobId}/output.mp4`);
    expect(mockUpload).toHaveBeenCalledWith(
      expect.any(String),
      gcsPath,
      "video/mp4",
    );
  });
});

// ─── The ceiling, in her units ──────────────────────────────────────────────────────────────────

/**
 * 12 clips · 664 MB · 3:00, and where each number comes from.
 *
 * These are ARITHMETIC ON CONSTANTS, not measurements: Cloud Run gives the instance 2 GiB, /tmp is
 * RAM, and macOS /tmp is disk so the behaviour that makes this matter cannot be observed here. What
 * the tests below can prove is that the arithmetic is self-consistent, that the output is charged
 * at all, and that the three quantities are counted over the right things.
 */
describe("the caps", () => {
  it("reserves the output's share of the workspace, rather than charging it at zero", () => {
    // The layer-2 bug this fixes: ffmpeg writes its output INTO the workspace, so on Cloud Run it
    // is resident in the same RAM as the inputs. Budgeting only the inputs over-commits by the
    // whole size of the finished file.
    expect(outputAllowanceBytes()).toBeGreaterThan(0);
    expect(maxSourceBytes() + outputAllowanceBytes()).toBe(workspaceMaxBytes());
  });

  it("derives the source budget, so moving the timeline cap moves it too", () => {
    const before = maxSourceBytes();
    process.env.STUDIO_STITCH_MAX_TIMELINE_SEC = String(
      maxTimelineSeconds() * 2,
    );
    try {
      expect(maxSourceBytes()).toBeLessThan(before);
      expect(maxSourceBytes() + outputAllowanceBytes()).toBe(
        workspaceMaxBytes(),
      );
    } finally {
      delete process.env.STUDIO_STITCH_MAX_TIMELINE_SEC;
    }
  });

  it("states all three in one sentence, in units she has", () => {
    expect(describeLimits()).toBe(
      "12 clips, 664 MB of video and 3:00 of footage",
    );
  });

  it("keeps BOTH caps reachable — the count binds for generated clips, the bytes for uploads", async () => {
    // A cap that can never bind is decoration. At 16 MB a generated clip, twelve is 192 MB and the
    // COUNT is what stops her; at 200 MB an upload, four is 800 MB and the BYTES are.
    const generated = 16 * 1024 * 1024;
    expect(maxClips() * generated).toBeLessThan(maxSourceBytes());
    expect(4 * clipMaxBytes()).toBeGreaterThan(maxSourceBytes());
  });
});

describe("assertTimelineFits", () => {
  const clip = (
    assetId: string,
    bytes: number | null,
    durationSeconds: number | null,
  ) => ({
    assetId,
    gcsPath: `p/${assetId}`,
    bytes,
    durationSeconds,
  });

  it("counts CLIPS over timeline positions and BYTES over unique assets", async () => {
    // The subtle one. The same clip twice is two inputs in ffmpeg's graph and two spans of output,
    // but ONE download — so charging its bytes twice would refuse a legal timeline, and counting it
    // once toward the clip cap would understate the graph.
    const one = clip("a", Math.floor(maxSourceBytes() * 0.6), 1);
    expect(() =>
      assertTimelineFits([{ assetId: "a" }, { assetId: "a" }], [one]),
    ).not.toThrow();

    const many = Array.from({ length: maxClips() + 1 }, () => ({
      assetId: "a",
    }));
    expect(() => assertTimelineFits(many, [clip("a", 1, 1)])).toThrow(
      /up to 12 clips/,
    );
  });

  it("refuses a timeline longer than the cap, counting each position", () => {
    const long = clip("a", 1, maxTimelineSeconds());
    expect(() => assertTimelineFits([{ assetId: "a" }], [long])).not.toThrow();
    expect(() =>
      assertTimelineFits([{ assetId: "a" }, { assetId: "a" }], [long]),
    ).toThrow(/runs about \d+ seconds/);
  });

  it("subtracts a trim, so the same clips fit once they are trimmed", () => {
    const long = clip("a", 1, maxTimelineSeconds());
    const twice = [{ assetId: "a" }, { assetId: "a" }];
    expect(() => assertTimelineFits(twice, [long])).toThrow(/timeline/i);

    const trimmed = twice.map(() => ({
      assetId: "a",
      trimStartSec: 0,
      trimEndSec: 1,
    }));
    expect(() => assertTimelineFits(trimmed, [long])).not.toThrow();
  });

  it("charges an unknown duration at the duration its SIZE implies, never at zero", () => {
    // Same posture as the byte budget on an unknown size, and for the same reason: the alternative
    // is finding out when the instance dies.
    const unknown = clip("a", 200 * 1024 * 1024, null);
    expect(effectiveSeconds({ assetId: "a" }, unknown)).toBeGreaterThan(0);
    // An unknown size AND an unknown duration is charged as the biggest clip we would ever accept.
    const nothing = clip("b", null, null);
    expect(effectiveSeconds({ assetId: "b" }, nothing)).toBe(
      effectiveSeconds({ assetId: "a" }, unknown),
    );
  });

  it("names every cap in the refusal, whichever one was hit", () => {
    const sentence = /up to \d+ clips, \d+ MB of video and \d+:\d\d of footage/;
    const tooMany = Array.from({ length: maxClips() + 1 }, () => ({
      assetId: "a",
    }));
    expect(() => assertTimelineFits(tooMany, [clip("a", 1, 1)])).toThrow(
      sentence,
    );
    expect(() =>
      assertTimelineFits(
        [{ assetId: "a" }],
        [clip("a", maxSourceBytes() + 1, 1)],
      ),
    ).toThrow(sentence);
    expect(() =>
      assertTimelineFits(
        [{ assetId: "a" }],
        [clip("a", 1, maxTimelineSeconds() + 1)],
      ),
    ).toThrow(sentence);
  });

  it("is the SAME function both doors call", () => {
    // The route refuses before a row exists; the runner re-checks because the library can change
    // between queue and claim. Two implementations would be two answers.
    const route = readFileSync(
      require.resolve("../../routes/studio.ts"),
      "utf8",
    );
    const runner = readFileSync(require.resolve("../stitchRunner.ts"), "utf8");
    expect(route).toMatch(/assertTimelineFits/);
    // The runner reaches it through materializeWorkspace rather than calling it directly.
    expect(runner).toMatch(/materializeWorkspace/);
  });
});

/** One of her photographs — a still's source. */
async function seedPhoto(
  athleteId: string,
  opts: {
    size?: number;
    bytes?: number | null;
    mediaType?: string;
    contentType?: string;
    deleted?: boolean;
    parent?: string;
  } = {},
): Promise<string> {
  const size = opts.size ?? 32;
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: athleteId,
      platform: "studio",
      origin: "upload",
      media_type: opts.mediaType ?? "IMAGE",
      status: "stored",
      gcs_path: `athletes/${athleteId}/uploads/${Math.random().toString(36).slice(2)}.jpg`,
      content_type: opts.contentType ?? "image/jpeg",
      bytes: opts.bytes === undefined ? size : opts.bytes,
      deleted_at: opts.deleted ? new Date() : null,
      parent_media_id: opts.parent ?? null,
      ingested_at: new Date(),
    } as never)
    .returning({ id: mediaAssets.id, gcs_path: mediaAssets.gcs_path });
  served.set(row.gcs_path!, Buffer.alloc(size, 3));
  return row.id;
}

describe("stills: one of her photos, resolved as a photo and never as a clip", () => {
  it("resolves her photo as a still, carrying its bytes and no duration of its own", async () => {
    const p = await seedPhoto(HER, { bytes: 1234 });
    const [still] = await resolveTimeline(HER, [{ assetId: p, stillSec: 2 }]);
    expect(still).toMatchObject({
      assetId: p,
      still: true,
      bytes: 1234,
      durationSeconds: null,
    });
  });

  it("another athlete's photo is not found — the same answer as a photo that does not exist", async () => {
    const theirs = await seedPhoto(SOMEONE_ELSE);
    const foreign = await failure(
      resolveTimeline(HER, [{ assetId: theirs, stillSec: 2 }]),
    );
    const absent = await failure(
      resolveTimeline(HER, [
        { assetId: "99999999-9999-4999-8999-999999999999", stillSec: 2 },
      ]),
    );
    expect(foreign.code).toBe("not_found");
    expect(foreign.message).toBe(absent.message);
    expect(foreign.message).not.toMatch(/athlete|yours|permission/i);
  });

  it("does not hold a deleted photo, a child of an album, or a video as a still", async () => {
    const album = await seedPhoto(HER, { mediaType: "CAROUSEL_ALBUM" });
    for (const id of [
      await seedPhoto(HER, { deleted: true }),
      await seedPhoto(HER, { parent: album }),
      await seedClip(HER),
    ]) {
      expect(
        (await failure(resolveTimeline(HER, [{ assetId: id, stillSec: 2 }])))
          .code,
      ).toBe("not_found");
    }
    // The album itself is a photograph in the Studio's sense, as the caster reads it.
    await expect(
      resolveTimeline(HER, [{ assetId: album, stillSec: 2 }]),
    ).resolves.toHaveLength(1);
  });

  it("refuses a photo in a format it cannot turn into a frame, by name (HEIC)", async () => {
    const heic = await seedPhoto(HER, { contentType: "image/heic" });
    const err = await failure(
      resolveTimeline(HER, [{ assetId: heic, stillSec: 2 }]),
    );
    expect(err.code).toBe("unusable_photo");
    expect(err.message).toMatch(/HEIC/);
  });

  it("still refuses a photo that arrives WITHOUT stillSec — as a clip, by name, as before", async () => {
    const p = await seedPhoto(HER);
    const err = await failure(resolveTimeline(HER, [{ assetId: p }]));
    expect(err.code).toBe("not_a_video");
  });

  it("resolves a timeline of only stills without asking the video query for zero clips", async () => {
    const a = await seedPhoto(HER);
    const b = await seedPhoto(HER);
    const out = await resolveTimeline(HER, [
      { assetId: a, stillSec: 2 },
      { assetId: b, stillSec: 3 },
    ]);
    expect(out.map((c) => c.assetId)).toEqual([a, b]);
  });

  it("is exactly as long as it is held — never a byte estimate", async () => {
    const p = await seedPhoto(HER, { bytes: null });
    const [still] = await resolveTimeline(HER, [{ assetId: p, stillSec: 3 }]);
    expect(effectiveSeconds({ assetId: p, stillSec: 3 }, still)).toBe(3);
  });

  it("counts as a position toward the clip cap, and its hold toward the timeline cap", () => {
    const clip = { assetId: "v", gcsPath: "v", durationSeconds: 175, bytes: 1 };
    const still = {
      assetId: "p",
      gcsPath: "p",
      durationSeconds: null,
      bytes: 1,
      still: true as const,
    };
    const twelve = Array.from({ length: maxClips() }, () => ({ assetId: "v" }));
    expect(() =>
      assertTimelineFits(
        [...twelve, { assetId: "p", stillSec: 1 }],
        [clip, still],
      ),
    ).toThrow(/13 clips/);
    expect(() =>
      assertTimelineFits(
        [{ assetId: "v" }, { assetId: "p", stillSec: 8 }],
        [clip, still],
      ),
    ).toThrow(/timeline/i);
    expect(() =>
      assertTimelineFits(
        [{ assetId: "v" }, { assetId: "p", stillSec: 5 }],
        [clip, still],
      ),
    ).not.toThrow();
  });

  it("charges a still its photo's bytes AND the frame and clip it will write, per position", () => {
    // A source budget of exactly what one 8 s still needs, beside a 1 MiB photo.
    const need = 1024 * 1024 + stillWorkBytes(8);
    process.env.STUDIO_STITCH_WORKSPACE_MAX_BYTES = String(
      outputAllowanceBytes() + need,
    );
    const still = {
      assetId: "p",
      gcsPath: "p",
      durationSeconds: null,
      bytes: 1024 * 1024,
      still: true as const,
    };
    expect(() =>
      assertTimelineFits([{ assetId: "p", stillSec: 8 }], [still]),
    ).not.toThrow();
    // The same photo held TWICE is one download but two encodes — the second one does not fit.
    expect(() =>
      assertTimelineFits(
        [
          { assetId: "p", stillSec: 8 },
          { assetId: "p", stillSec: 8 },
        ],
        [still],
      ),
    ).toThrow(/MB/);
    expect(stillWorkBytes(8)).toBeGreaterThan(STILL_PREP_MAX_BYTES);
  });

  it("charges a photo of UNKNOWN size at the image cap, not the clip cap and never at zero", () => {
    process.env.STUDIO_STITCH_WORKSPACE_MAX_BYTES = String(
      outputAllowanceBytes() + 25 * 1024 * 1024 + stillWorkBytes(2),
    );
    const unknown = {
      assetId: "p",
      gcsPath: "p",
      durationSeconds: null,
      bytes: null,
      still: true as const,
    };
    expect(() =>
      assertTimelineFits([{ assetId: "p", stillSec: 2 }], [unknown]),
    ).not.toThrow();
    process.env.STUDIO_STITCH_WORKSPACE_MAX_BYTES = String(
      outputAllowanceBytes() + 25 * 1024 * 1024 + stillWorkBytes(2) - 1,
    );
    expect(() =>
      assertTimelineFits([{ assetId: "p", stillSec: 2 }], [unknown]),
    ).toThrow(/MB/);
  });

  it("charges its hold in the measured bound, where there is no file to probe", () => {
    // 170 s of probed video and a 2 s still: 172, under the cap. Charged as an unprobed file it
    // would be the whole 180 on its own.
    expect(() =>
      assertProbedTimelineFits(
        [{ assetId: "v" }, { assetId: "p", stillSec: 2 }],
        new Map([["v", 170]]),
      ),
    ).not.toThrow();
  });

  it("downloads each photo once, into `stills` and never into `paths`", async () => {
    const v = await seedClip(HER, { size: 50 });
    const p = await seedPhoto(HER, { size: 40 });
    const ws = await materializeWorkspace(HER, [
      { assetId: v },
      { assetId: p, stillSec: 2 },
      { assetId: p, stillSec: 3 },
    ]);
    try {
      expect([...ws.paths.keys()]).toEqual([v]);
      expect([...ws.stills.keys()]).toEqual([p]);
      expect(readFileSync(ws.stills.get(p)!)).toHaveLength(40);
      expect(fetchCount.get(await pathOf(p))).toBe(1);
    } finally {
      await ws.dispose();
    }
  });

  it("downloads nothing when a still is not hers", async () => {
    const v = await seedClip(HER);
    const theirs = await seedPhoto(SOMEONE_ELSE);
    await expect(
      materializeWorkspace(HER, [
        { assetId: v },
        { assetId: theirs, stillSec: 2 },
      ]),
    ).rejects.toThrow(/could not be found/);
    expect(fetchCount.size).toBe(0);
  });
});

describe("stitchLimits", () => {
  it("is the shape the routes hand the client", () => {
    expect(stitchLimits()).toEqual({
      maxClips: 12,
      maxSourceBytes: 664 * 1024 * 1024,
      maxTimelineSeconds: 180,
      maxClipBytes: 200 * 1024 * 1024,
      minStillSec: 1,
      maxStillSec: 8,
      defaultStillSec: 2,
    });
  });
});

/**
 * Workspace directories under THIS SUITE'S OWN root, so a leak is countable and cannot be confused
 * with anybody else's. V6's stitch.test.ts mkdtemps with the same `studio-stitch-` prefix in the OS
 * temp directory, so scanning there would make these assertions flake under parallel workers.
 */
function tmpDirs(): string[] {
  return readdirSync(WORKSPACE_ROOT).filter((d) =>
    d.startsWith("studio-stitch-"),
  );
}
