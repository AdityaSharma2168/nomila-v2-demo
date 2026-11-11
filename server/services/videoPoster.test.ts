/**
 * videoPoster.test.ts — the poster worker as a WRITER BESIDE OTHER WRITERS.
 *
 * Measured 22 Sep 2026 on a 51 s upload (asset d076a790): the poster UPDATE landed at 13:20:05Z and
 * made the row enrichable at once; enrichment wrote to it; the transcode's UPDATE at 13:20:45Z wrote
 * `metadata: { ...row.metadata, original_gcs_path }` — the object as read at batch-select time,
 * four minutes earlier — and the row was left with {moderation, original_gcs_path}: no poster read,
 * no enrichment marker, no trace either had happened. Nothing had failed; the failure was that
 * nothing showed. This suite holds the two metadata writes to ONE KEY EACH, in SQL, and the kick
 * that tells enrichment a clip has just become readable.
 *
 * ffmpeg/ffprobe and GCS are mocked as the duration suite mocks them. The interleaved writer is the
 * enrichment worker's real jsonb_set shape, executed from inside the ffmpeg stub — i.e. while the
 * poster worker is between its select and its write.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/mediaStore", () => ({
  signedUrl: jest.fn(
    async (p: string) => `https://signed.example/${p}?sig=secret`,
  ),
  uploadLocalFile: jest.fn(async () => {}),
}));
jest.mock("../studio/video/probe", () => ({ probeDurationSeconds: jest.fn() }));
jest.mock("child_process", () => ({ execFile: jest.fn() }));
const statMock = jest.fn(async () => ({ size: 4096 }));
jest.mock("fs/promises", () => ({
  stat: (...a: unknown[]) => statMock(...(a as [])),
  unlink: jest.fn(async () => {}),
}));
// The kick's target. Mocked so the poster suite never loads the enrichment worker or its clients.
const enrichNextChunk = jest.fn(async () => ({ total: 0, remaining: 0 }));
jest.mock("./mediaEnrichment", () => ({ enrichNextChunk }));

import { execFile } from "child_process";
import { eq, sql } from "drizzle-orm";
import { processOneVideo, processPosterBatch } from "./videoPoster";
import { mediaAssets } from "../../shared/schema";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../testUtils/pgliteDb";
import { probeDurationSeconds } from "../studio/video/probe";

const probeMock = probeDurationSeconds as jest.MockedFunction<
  typeof probeDurationSeconds
>;
const execFileMock = execFile as unknown as jest.Mock;

let athleteId: string;
/** What happened, in order — the ffmpeg stub and the kick both append. */
let events: string[] = [];

const isTranscode = (args: string[]) => args.includes("libx264");

/**
 * The ffmpeg stub. `during` runs while the worker is between its batch-select and the write that
 * follows this ffmpeg call — the exact window the transcode's write used to close over.
 */
function ffmpeg(during?: (args: string[]) => Promise<void>) {
  execFileMock.mockImplementation(
    (_cmd: string, args: string[], _opts: any, cb: any) => {
      events.push(isTranscode(args) ? "transcode" : "poster");
      Promise.resolve(during?.(args)).then(
        () => cb(null, { stdout: "", stderr: "" }),
        (e) => cb(e),
      );
    },
  );
}

/** The enrichment worker's write, in its real shape: jsonb_set on the one key. */
async function enrichmentWrites(id: string) {
  await db.execute(sql`
    UPDATE ${mediaAssets}
       SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{vision}',
             '{"description":"from the clip","beats":[{"start_s":0,"end_s":3},{"start_s":3,"end_s":6}]}'::jsonb)
     WHERE id = ${id}`);
  await db.execute(sql`
    UPDATE ${mediaAssets}
       SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{enrichment}', '{"attempts":1}'::jsonb)
     WHERE id = ${id}`);
}

async function seedPosterless(over: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: athleteId,
      platform: "upload",
      origin: "upload",
      media_type: "VIDEO",
      status: "stored",
      gcs_path: `athletes/${athleteId}/uploads/${Math.random().toString(36).slice(2)}.mp4`,
      content_type: "video/mp4",
      gcs_thumb_path: null,
      metadata: { moderation: { skipped: "video" } },
      ingested_at: new Date(),
      ...over,
    } as never)
    .returning();
  return row;
}

const rowOf = async (id: string) => {
  const [r] = await db
    .select({
      m: mediaAssets.metadata,
      path: mediaAssets.gcs_path,
      thumb: mediaAssets.gcs_thumb_path,
    })
    .from(mediaAssets)
    .where(eq(mediaAssets.id, id));
  return { ...r, m: (r.m ?? {}) as Record<string, any> };
};

/** The kick is not awaited by the worker; let the dynamic import and the call land. */
const settle = () => new Promise((r) => setImmediate(r));

beforeAll(async () => {
  await initTestDb();
});
afterAll(async () => {
  await closeTestDb();
});
beforeEach(async () => {
  await db.delete(mediaAssets);
  athleteId = await seedAthlete("Poster Writer Tester");
  events = [];
  jest.clearAllMocks();
  probeMock.mockResolvedValue(12.5);
  statMock.mockResolvedValue({ size: 4096 });
  ffmpeg();
});

describe("metadata is written one key at a time", () => {
  /**
   * ⚠️  THE REVERT CHECK. Put `metadata: { ...(row.metadata ?? {}), original_gcs_path: row.gcs_path }`
   * back on the transcode UPDATE and the beats written during the transcode are gone: this test's
   * `vision.beats` assertion is the one that goes red. It is also the regression that matters most
   * for the 51 s clip — a rerun's beats must survive whatever the poster worker does next.
   */
  it("a clip read that lands DURING the transcode survives the transcode's write — beats, enrichment and moderation all kept, original_gcs_path added", async () => {
    const row = await seedPosterless();
    ffmpeg(async (args) => {
      if (isTranscode(args)) await enrichmentWrites(row.id);
    });
    expect(await processOneVideo(row as never)).toBe("transcoded");
    const after = await rowOf(row.id);
    expect(after.m.vision.beats).toHaveLength(2);
    expect(after.m.vision.description).toBe("from the clip");
    expect(after.m.enrichment).toEqual({ attempts: 1 });
    expect(after.m.moderation).toEqual({ skipped: "video" });
    expect(after.m.original_gcs_path).toBe(row.gcs_path);
    expect(after.path).toBe(`athletes/${athleteId}/uploads/${row.id}-1080.mp4`);
    expect(after.thumb).toBe(
      `athletes/${athleteId}/uploads/${row.id}-poster.jpg`,
    );
  });

  it("a write that lands while the POSTER is being cut survives the poster_error write on a clip that will not poster", async () => {
    const row = await seedPosterless();
    statMock.mockResolvedValue({ size: 0 }); // the frame never lands: both attempts, then the throw
    ffmpeg(async () => {
      await enrichmentWrites(row.id);
    });
    expect(await processOneVideo(row as never)).toBe("failed");
    const after = await rowOf(row.id);
    expect(after.m.poster_error).toBe("poster frame is empty");
    expect(after.m.vision.beats).toHaveLength(2);
    expect(after.m.moderation).toEqual({ skipped: "video" });
    expect(after.thumb).toBeNull();
  });

  it("a row with NULL metadata gets the key on an object, not an error", async () => {
    const row = await seedPosterless({ metadata: null });
    expect(await processOneVideo(row as never)).toBe("transcoded");
    expect((await rowOf(row.id)).m).toEqual({
      original_gcs_path: row.gcs_path,
    });
  });
});

describe("a landed poster kicks enrichment — the clip is readable now, and nothing else would say so until the next scheduled cron", () => {
  it("once per athlete, after the whole batch (so after every transcode), through enrichNextChunk", async () => {
    await seedPosterless();
    await seedPosterless();
    const r = await processPosterBatch(3);
    expect(r).toMatchObject({ processed: 2, transcoded: 2, failed: 0 });
    await settle();
    expect(enrichNextChunk).toHaveBeenCalledTimes(1);
    expect(enrichNextChunk).toHaveBeenCalledWith({ athleteId });
    expect(events.filter((e) => e === "transcode")).toHaveLength(2);
  });

  it("the kick comes after the transcode, not after the poster", async () => {
    const row = await seedPosterless();
    enrichNextChunk.mockImplementation(async () => {
      events.push("kick");
      return { total: 0, remaining: 0 };
    });
    await processPosterBatch(3);
    await settle();
    expect(events).toEqual(["poster", "transcode", "kick"]);
    expect((await rowOf(row.id)).thumb).not.toBeNull();
  });

  it("a row that would not poster kicks nothing — there is nothing new to read", async () => {
    await seedPosterless();
    statMock.mockResolvedValue({ size: 0 });
    const r = await processPosterBatch(3);
    expect(r).toMatchObject({ processed: 0, failed: 1 });
    await settle();
    expect(enrichNextChunk).not.toHaveBeenCalled();
  });

  /**
   * PR 4 (Mia-approved): fetchTopVideoFiles swaps an Instagram mp4 in with no thumbnail, and this
   * worker gives it the upload's full job. ⚠️ MUTATION: drop "connected" from the batch's origin
   * list — the row is never selected and this reds by name.
   */
  it("a connected Instagram mp4 with no thumbnail is postered, timed and transcoded — and keeps origin 'connected'", async () => {
    const row = await seedPosterless({
      platform: "instagram",
      origin: "connected",
      gcs_path: `athletes/${athleteId}/instagram/ig-1.mp4`,
      metadata: { pixel_grade: "full" },
    });
    const r = await processPosterBatch(3);
    expect(r).toMatchObject({ processed: 1, transcoded: 1, failed: 0 });
    const [after] = await db
      .select({
        origin: mediaAssets.origin,
        thumb: mediaAssets.gcs_thumb_path,
        seconds: mediaAssets.duration_seconds_precise,
        m: mediaAssets.metadata,
      })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, row.id));
    expect(after.origin).toBe("connected");
    expect(after.thumb).toBe(
      `athletes/${athleteId}/uploads/${row.id}-poster.jpg`,
    );
    expect(Number(after.seconds)).toBe(12.5);
    expect((after.m as Record<string, unknown>).original_gcs_path).toBe(
      `athletes/${athleteId}/instagram/ig-1.mp4`,
    );
  });

  it("a kick that throws is logged and does not fail the batch", async () => {
    await seedPosterless();
    enrichNextChunk.mockRejectedValueOnce(new Error("worker down"));
    const r = await processPosterBatch(3);
    expect(r.processed).toBe(1);
    await settle();
    expect(enrichNextChunk).toHaveBeenCalledTimes(1);
  });
});
