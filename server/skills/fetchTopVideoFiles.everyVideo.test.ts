/**
 * fetchTopVideoFiles.everyVideo.test.ts — MEDIA_VIDEO_FIXES fix 1: the mp4 for EVERY Instagram video she owns.
 *
 *   order    the most-viewed (INSTAGRAM_VIDEO_FETCH_CAP of them) first, then the newest
 *   budget   at most INSTAGRAM_VIDEO_FETCH_TICK_MAX files and INSTAGRAM_VIDEO_FETCH_TICK_MB per athlete per tick; the
 *            rest wait for the next night and are fetched then (nothing is skipped for good by the budget)
 *   size     a file over the cap is marked once and never retried
 *   failure  three failed nights and the video is left as its poster
 *   off      the top-8 behaviour (fetchTopVideoFiles.test.ts) unchanged
 *
 * The Graph call and the rehost are mocked: no network, no GCS.
 *
 * ⚠️ MUTATIONS: drop the byte budget — "the tick stops at its byte budget" reds; drop the size marker — "an oversize
 * file is marked once and never retried" reds.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/integrations/instagram", () => ({
  fetchMediaFileUrl: jest.fn(async (_conn: string, id: string) => `https://cdn.example/${id}.mp4`),
}));
jest.mock("../lib/mediaStore", () => ({ rehostFromUrl: jest.fn() }));

import { eq } from "drizzle-orm";
import { connectedAccounts, mediaAssets } from "../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { fetchTopVideoFiles, videoFetchOrder } from "./fetchTopVideoFiles";
import { fetchMediaFileUrl } from "../lib/integrations/instagram";
import { rehostFromUrl } from "../lib/mediaStore";

const rehost = rehostFromUrl as jest.MockedFunction<typeof rehostFromUrl>;
const fetchUrl = fetchMediaFileUrl as jest.MockedFunction<typeof fetchMediaFileUrl>;
let athleteId: string;

const ENV = ["MEDIA_VIDEO_FIXES", "INSTAGRAM_VIDEO_FETCH_CAP", "INSTAGRAM_VIDEO_FETCH_TICK_MAX", "INSTAGRAM_VIDEO_FETCH_TICK_MB"];

beforeAll(async () => { await initTestDb(); });
afterAll(async () => { await closeTestDb(); for (const k of ENV) delete process.env[k]; });
beforeEach(async () => {
  await db.delete(mediaAssets);
  await db.delete(connectedAccounts);
  athleteId = await seedAthlete("Every Video Tester");
  await db.insert(connectedAccounts).values({ athlete_id: athleteId, platform: "instagram", status: "active" } as never);
  for (const k of ENV) delete process.env[k];
  process.env.MEDIA_VIDEO_FIXES = "true";
  jest.clearAllMocks();
  rehost.mockImplementation(async (_url: string, path: string) => ({ gcs_path: `${path}.mp4`, content_type: "video/mp4", bytes: 10 * 1024 * 1024 }));
});

/** A reel as the sync leaves it: its poster JPEG. `daysAgo` sets posted_at. */
async function reel(tag: string, views: number | null, daysAgo: number): Promise<string> {
  const [row] = await db.insert(mediaAssets).values({
    athlete_id: athleteId, platform: "instagram", origin: "connected", media_type: "REELS", status: "stored",
    source_media_id: `ig-${tag}`, gcs_path: `athletes/${athleteId}/instagram/ig-${tag}.jpg`, content_type: "image/jpeg",
    insights: views === null ? {} : { video_views: views }, metadata: { pixel_grade: "thumbnail" },
    posted_at: new Date(Date.now() - daysAgo * 86_400_000), ingested_at: new Date(),
  } as never).returning({ id: mediaAssets.id });
  return row.id;
}
const rowOf = async (id: string) => (await db.select().from(mediaAssets).where(eq(mediaAssets.id, id)))[0] as any;
const fetchedOrder = () => fetchUrl.mock.calls.map((c) => c[1]);

it("the order: the top by views first, then the newest", () => {
  const r = (id: string, views: number | null, day: number) => ({ id, sourceMediaId: id, gcsPath: null, views, postedAt: new Date(2026, 0, day) });
  const out = videoFetchOrder([r("old-hit", 900, 1), r("new", 5, 20), r("mid-hit", 500, 5), r("newest", null, 30), r("older", 1, 2)], 2);
  expect(out.map((x) => x.id)).toEqual(["old-hit", "mid-hit", "newest", "new", "older"]);
});

it("every video she owns becomes an mp4 — not only the top 8 — and the swap is written on its own keys", async () => {
  process.env.INSTAGRAM_VIDEO_FETCH_CAP = "1";
  const ids = await Promise.all(Array.from({ length: 12 }, (_, i) => reel(`v${i}`, i * 10, i)));
  const r = await fetchTopVideoFiles(athleteId);
  expect(r).toEqual({ fetched: 12, skipped: 0, failed: 0 });
  // v11 has the most views; then newest first (v0 is the newest).
  expect(fetchedOrder().slice(0, 3)).toEqual(["ig-v11", "ig-v0", "ig-v1"]);
  const row = await rowOf(ids[3]);
  expect(row.content_type).toBe("video/mp4");
  expect(row.metadata).toMatchObject({ pixel_grade: "full" });
  expect(row.gcs_thumb_path).toBeNull();   // the poster worker cuts the clip's own poster
});

it("the tick stops at its file count; the next tick picks up where it stopped", async () => {
  process.env.INSTAGRAM_VIDEO_FETCH_TICK_MAX = "3";
  await Promise.all(Array.from({ length: 5 }, (_, i) => reel(`c${i}`, null, i)));
  expect(await fetchTopVideoFiles(athleteId)).toEqual({ fetched: 3, skipped: 0, failed: 0 });
  expect(await fetchTopVideoFiles(athleteId)).toEqual({ fetched: 2, skipped: 0, failed: 0 });
  expect(await fetchTopVideoFiles(athleteId)).toEqual({ fetched: 0, skipped: 0, failed: 0 });
});

it("the tick stops at its byte budget", async () => {
  process.env.INSTAGRAM_VIDEO_FETCH_TICK_MB = "25";   // three 10 MB files reach it
  await Promise.all(Array.from({ length: 6 }, (_, i) => reel(`b${i}`, null, i)));
  expect((await fetchTopVideoFiles(athleteId)).fetched).toBe(3);
});

it("an oversize file is marked once and never retried", async () => {
  const id = await reel("big", 100, 1);
  rehost.mockResolvedValueOnce({ skipped: "size" });
  expect(await fetchTopVideoFiles(athleteId)).toEqual({ fetched: 0, skipped: 1, failed: 0 });
  expect((await rowOf(id)).metadata.video_fetch_skipped).toBe("size");
  expect(await fetchTopVideoFiles(athleteId)).toEqual({ fetched: 0, skipped: 0, failed: 0 });
});

it("three failed nights and the video is left as its poster; a success clears the count", async () => {
  const id = await reel("flaky", 100, 1);
  rehost.mockResolvedValue(null);
  for (let i = 0; i < 3; i++) expect((await fetchTopVideoFiles(athleteId)).failed).toBe(1);
  expect((await rowOf(id)).metadata.video_fetch_failures).toBe(3);
  expect(await fetchTopVideoFiles(athleteId)).toEqual({ fetched: 0, skipped: 0, failed: 0 });

  const other = await reel("once", 100, 1);
  rehost.mockResolvedValueOnce(null);
  await fetchTopVideoFiles(athleteId);
  rehost.mockImplementation(async (_u: string, path: string) => ({ gcs_path: `${path}.mp4`, content_type: "video/mp4", bytes: 1 }));
  await fetchTopVideoFiles(athleteId);
  expect((await rowOf(other)).metadata.video_fetch_failures).toBeUndefined();
});

it("an athlete with no active Instagram connection is not touched", async () => {
  await db.delete(connectedAccounts);
  await reel("x", 1, 1);
  expect(await fetchTopVideoFiles(athleteId)).toEqual({ fetched: 0, skipped: 0, failed: 0 });
  expect(fetchUrl).not.toHaveBeenCalled();
});
