/**
 * retag.test — the PR 12 backfill writes two keys inside vision and nothing else (PGlite, real SQL).
 *
 * ⚠️ MUTATIONS, each red by name:
 *   "backfill rewrites the vision object"   — write vision whole (the 16 fields / beats move)
 *   "backfill clobbers clip_read"            — write metadata whole (clip_read is gone)
 *   "backfill runs without a cap"            — drop the limit check in retag()
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/visionTag", () => ({
  ...jest.requireActual("../../lib/visionTag"),
  tagAsset: jest.fn(),
}));
jest.mock("../../lib/tagProfile", () => ({
  tagProfileFor: jest.fn(async () => null),
}));
jest.mock("../../logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { eq } from "drizzle-orm";
import { athletes, mediaAssets } from "../../../shared/schema";
import { db, initTestDb, closeTestDb } from "../../testUtils/pgliteDb";
import { tagAsset } from "../../lib/visionTag";
import { quoteRetag, retag, RETAG_USD_PER_ROW } from "./retag";

const HER = "44444444-1111-4444-8555-777777777777";
const tag = tagAsset as jest.Mock;

const OLD_VISION = {
  athlete_present: true,
  subject: "the_athlete",
  athlete_prominence: 0.95,
  shot_type: "portrait",
  description: "she looks to camera",
  brands_visible: ["Nike"],
  aesthetic_quality: 0.8,
  brand_safe: true,
  content_flags: { hateful: false },
  setting: "a gym",
  attire: "a red kit",
  vibe: "calm",
  hero_suitability: 0.7,
  disposition: "as_is",
  edit_note: "",
  reason: "sharp",
};

async function row(
  metadata: unknown,
  over: Record<string, unknown> = {},
): Promise<string> {
  const [r] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: HER,
      platform: "upload",
      origin: "upload",
      media_type: "IMAGE",
      status: "stored",
      gcs_path: `athletes/${HER}/${Math.random().toString(36).slice(2)}.jpg`,
      content_type: "image/jpeg",
      ingested_at: new Date(),
      metadata,
      ...over,
    } as never)
    .returning({ id: mediaAssets.id });
  return r.id;
}
const metaOf = async (id: string) =>
  (
    await db
      .select({ m: mediaAssets.metadata })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, id))
  )[0].m as Record<string, any>;

beforeAll(async () => {
  await initTestDb();
  await db
    .insert(athletes)
    .values([{ id: HER, full_name: "Retag Athlete" }] as never);
});
afterAll(closeTestDb);
beforeEach(async () => {
  tag.mockReset();
  await db.delete(mediaAssets);
});

/** The model's whole answer — every one of the 16 fields DIFFERENT from what is stored, plus the two keys. */
const shifted = (over: Record<string, unknown> = {}) => ({
  ...OLD_VISION,
  athlete_prominence: 0.5,
  aesthetic_quality: 0.1,
  hero_suitability: 0.1,
  shot_type: "other",
  description: "a different sentence",
  brands_visible: [],
  disposition: "reject",
  reason: "changed",
  face_visibility: "clear",
  role: "identity",
  ...over,
});

it("quotes rows × the per-row estimate, athlete-scoped, only rows missing the cell's key", async () => {
  await row({ vision: OLD_VISION });
  await row({ vision: OLD_VISION });
  await row({
    vision: { ...OLD_VISION, face_visibility: "clear", role: "identity" },
  }); // already has them
  await row(null); // untagged: not a candidate
  expect(await quoteRetag(HER, "face", 100)).toEqual({
    rows: 2,
    usd: Number((2 * RETAG_USD_PER_ROW).toFixed(4)),
  });
  expect(await quoteRetag(HER, "face", 1)).toEqual({
    rows: 1,
    usd: RETAG_USD_PER_ROW,
  });
  expect(
    await quoteRetag("55555555-1111-4444-8555-777777777777", "face", 100),
  ).toEqual({ rows: 0, usd: 0 });
});

/** ⚠️ MUTATION "backfill rewrites the vision object" / "backfill clobbers clip_read" — the two assertions on OLD_VISION and clip_read red. */
it("cell (a) writes face_visibility and role INSIDE vision and moves nothing else — not the 16 fields, not beats, not clip_read, not the embedding", async () => {
  const clipRead = {
    state: "done",
    at: "2026-09-23T00:00:00Z",
    quotedUsd: 0.01,
    billedUsd: 0.01,
  };
  const id = await row({
    vision: {
      ...OLD_VISION,
      beats: [
        {
          startSec: 0,
          endSec: 2,
          description: "she runs",
          camera: "wide",
          motion: "run",
        },
      ],
    },
    clip_read: clipRead,
    enrich_spend: { day: "2026-09-23", usd: 0.01 },
    embedding: [1, 0, 0],
    enrichment: { attempts: 1 },
  });
  tag.mockResolvedValueOnce(shifted());

  expect(await retag(HER, "face", 10)).toEqual({
    attempted: 1,
    written: 1,
    skipped: 0,
    failed: 0,
  });

  const m = await metaOf(id);
  expect(m.vision).toEqual({
    ...OLD_VISION,
    beats: [
      {
        startSec: 0,
        endSec: 2,
        description: "she runs",
        camera: "wide",
        motion: "run",
      },
    ],
    face_visibility: "clear",
    role: "identity",
  });
  expect(m.clip_read).toEqual(clipRead);
  expect(m.enrich_spend).toEqual({ day: "2026-09-23", usd: 0.01 });
  expect(m.embedding).toEqual([1, 0, 0]);
  expect(m.enrichment).toEqual({ attempts: 1 });
  // And it is no longer a candidate.
  expect(await quoteRetag(HER, "face", 10)).toEqual({ rows: 0, usd: 0 });
});

it("cell (b) writes subject and the derived athlete_present onto a pre-ternary row — and nothing else", async () => {
  const { subject: _s, ...preTernary } = OLD_VISION;
  const id = await row({
    vision: preTernary,
    clip_read: { state: "failed", at: "x", reason: "r", quotedUsd: 0 },
  });
  tag.mockResolvedValueOnce(shifted({ subject: "another_person" }));
  expect(await retag(HER, "subject", 10)).toEqual({
    attempted: 1,
    written: 1,
    skipped: 0,
    failed: 0,
  });
  const m = await metaOf(id);
  expect(m.vision).toEqual({
    ...preTernary,
    subject: "another_person",
    athlete_present: false,
  });
  expect(m.clip_read).toEqual({
    state: "failed",
    at: "x",
    reason: "r",
    quotedUsd: 0,
  });
});

it("an answer outside the enum, or no answer, writes nothing — skipped or failed, the row untouched and still a candidate", async () => {
  const a = await row({ vision: OLD_VISION });
  const b = await row({ vision: OLD_VISION });
  tag
    .mockResolvedValueOnce(shifted({ face_visibility: "excellent" }))
    .mockResolvedValueOnce(null);
  expect(await retag(HER, "face", 10)).toEqual({
    attempted: 2,
    written: 0,
    skipped: 1,
    failed: 1,
  });
  expect((await metaOf(a)).vision).toEqual(OLD_VISION);
  expect((await metaOf(b)).vision).toEqual(OLD_VISION);
  expect(await quoteRetag(HER, "face", 10)).toMatchObject({ rows: 2 });
});

/** ⚠️ MUTATION "backfill runs without a cap": drop the limit check — the throw is gone and every row is tagged. */
it("a batch is capped by its limit, and refuses to run without one", async () => {
  for (let i = 0; i < 3; i++) await row({ vision: OLD_VISION });
  tag.mockResolvedValue(shifted());
  expect(await retag(HER, "face", 2)).toMatchObject({
    attempted: 2,
    written: 2,
  });
  expect(tag).toHaveBeenCalledTimes(2);
  await expect(retag(HER, "face", 0)).rejects.toThrow("batch limit");
  expect(tag).toHaveBeenCalledTimes(2);
});
