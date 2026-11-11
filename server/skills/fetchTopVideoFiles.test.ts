/**
 * fetchTopVideoFiles.test.ts — the Instagram mp4 swap, as PR 4 left it (Mia-approved shared edit).
 *
 * Two things are held here: N is INSTAGRAM_VIDEO_FETCH_CAP (default 8, the value it always had),
 * and the swap leaves `gcs_thumb_path` NULL so the poster worker (services/videoPoster.ts, which
 * now takes origin 'connected') does the full job an upload gets — poster, precise duration,
 * transcode, original_gcs_path. The Graph call and the rehost are mocked: no network, no GCS.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/integrations/instagram", () => ({
  fetchMediaFileUrl: jest.fn(
    async (_conn: string, id: string) => `https://cdn.example/${id}.mp4`,
  ),
}));
jest.mock("../lib/mediaStore", () => ({
  rehostFromUrl: jest.fn(async (_url: string, path: string) => ({
    gcs_path: `${path}.mp4`,
    content_type: "video/mp4",
    bytes: 1_000_000,
  })),
}));

import { eq } from "drizzle-orm";
import { connectedAccounts, mediaAssets } from "../../shared/schema";
import {
  closeTestDb,
  db,
  initTestDb,
  seedAthlete,
} from "../testUtils/pgliteDb";
import { fetchTopVideoFiles, topVideosCap } from "./fetchTopVideoFiles";

let athleteId: string;

beforeAll(async () => {
  await initTestDb();
});
afterAll(async () => {
  await closeTestDb();
});
beforeEach(async () => {
  await db.delete(mediaAssets);
  await db.delete(connectedAccounts);
  athleteId = await seedAthlete("Top Video Tester");
  await db.insert(connectedAccounts).values({
    athlete_id: athleteId,
    platform: "instagram",
    status: "active",
  } as never);
  delete process.env.INSTAGRAM_VIDEO_FETCH_CAP;
});
afterEach(() => {
  delete process.env.INSTAGRAM_VIDEO_FETCH_CAP;
});

/** An Instagram reel as rehostAthleteMedia leaves it: a poster jpeg, origin connected. */
async function reel(views: number): Promise<string> {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: athleteId,
      platform: "instagram",
      origin: "connected",
      media_type: "VIDEO",
      status: "stored",
      source_media_id: `ig-${views}`,
      gcs_path: `athletes/${athleteId}/instagram/ig-${views}.jpg`,
      content_type: "image/jpeg",
      insights: { video_views: views },
      metadata: { pixel_grade: "thumbnail" },
      ingested_at: new Date(),
    } as never)
    .returning({ id: mediaAssets.id });
  return row.id;
}

const rowOf = async (id: string) =>
  (await db.select().from(mediaAssets).where(eq(mediaAssets.id, id)))[0];

describe("fetchTopVideoFiles — the cap is INSTAGRAM_VIDEO_FETCH_CAP, the thumbnail is the poster worker's", () => {
  it("defaults to 8 — prod's value — when the env is unset or not a positive integer", () => {
    expect(topVideosCap()).toBe(8);
    process.env.INSTAGRAM_VIDEO_FETCH_CAP = "0";
    expect(topVideosCap()).toBe(8);
    process.env.INSTAGRAM_VIDEO_FETCH_CAP = "twenty";
    expect(topVideosCap()).toBe(8);
    process.env.INSTAGRAM_VIDEO_FETCH_CAP = "25";
    expect(topVideosCap()).toBe(25);
  });

  /** ⚠️ MUTATION: `.limit(8)` in place of the env cap — the least-viewed reel is fetched and this reds by name. */
  it("honours the env cap: with 2, the two most-viewed reels get their mp4 and the third keeps its poster", async () => {
    process.env.INSTAGRAM_VIDEO_FETCH_CAP = "2";
    const top = await reel(300);
    const second = await reel(200);
    const third = await reel(100);
    expect(await fetchTopVideoFiles(athleteId)).toEqual({
      fetched: 2,
      skipped: 0,
      failed: 0,
    });
    for (const id of [top, second]) {
      expect((await rowOf(id)).content_type).toBe("video/mp4");
    }
    const left = await rowOf(third);
    expect(left.content_type).toBe("image/jpeg");
    expect(left.gcs_path).toMatch(/\.jpg$/);
  });

  it("the swapped row keeps origin 'connected', points gcs_path at the mp4, and leaves gcs_thumb_path NULL for the poster worker", async () => {
    const id = await reel(500);
    await fetchTopVideoFiles(athleteId);
    const r = await rowOf(id);
    expect(r).toMatchObject({
      origin: "connected",
      content_type: "video/mp4",
      gcs_thumb_path: null,
    });
    expect(r.gcs_path).toBe(`athletes/${athleteId}/instagram/ig-500.mp4`);
    expect((r.metadata as Record<string, unknown>).pixel_grade).toBe("full");
  });
});
