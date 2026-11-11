/**
 * cast.shots.test.ts — the caster's snap (quality-scrappy piece 3): a clip item cut to a beat has its edges moved onto
 * a stored camera cut within half a second, under STUDIO_SHOT_DETECT; off, the trim and the pick are what they were.
 * Real Postgres (PGlite) and the real `castPlan`, as cast.test.ts runs it; the network boundaries stood in.
 *
 * ⚠️ MUTATION M3d: trimFor ignores the boundaries — "a beat edge 0.2 s from a cut is cut on the cut" reds.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/mediaEmbed", () => ({
  embedText: jest.fn(async () => [1, 0, 0]),
  cosine: () => 1,
}));
jest.mock("../../lib/mediaStore", () => ({
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
  uploadLocalFile: jest.fn(async () => undefined),
}));

import { randomUUID } from "node:crypto";
import { mediaAssets } from "../../../shared/schema";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../../testUtils/pgliteDb";
import { asPick, castPlan, loadCastable } from "./cast";
import type { AgentPlan, PlanItem } from "./types";

let her: string;
beforeAll(async () => {
  await initTestDb();
  her = await seedAthlete("Cast Shots Athlete");
});
afterAll(async () => {
  await closeTestDb();
});
beforeEach(async () => {
  await db.delete(mediaAssets);
  delete process.env.STUDIO_SHOT_DETECT;
  delete process.env.STUDIO_ALL_ON;
});

/** A 6.5 s clip of hers with two Flash beats, [0–3] and [3–6.5], and the given stored cuts (or none). */
async function clip(boundaries: number[] | null): Promise<string> {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: her,
      platform: "studio",
      origin: "generated",
      media_type: "VIDEO",
      status: "stored",
      generation_job_id: randomUUID(),
      gcs_path: `athletes/${her}/${Math.random().toString(36).slice(2)}.mp4`,
      gcs_thumb_path: `athletes/${her}/poster.jpg`,
      content_type: "video/mp4",
      duration_seconds_precise: 6.5,
      ingested_at: new Date(),
      metadata: {
        vision: {
          athlete_present: true,
          athlete_prominence: 0.8,
          shot_type: "action",
          description: "a clip",
          brands_visible: [],
          aesthetic_quality: 0.8,
          brand_safe: true,
          hero_suitability: 0.8,
          content_flags: {},
          beats: [
            {
              start_s: 0,
              end_s: 3,
              description: "a beat",
              camera: "wide",
              motion: "runs",
            },
            {
              start_s: 3,
              end_s: 6.5,
              description: "a beat",
              camera: "close",
              motion: "still",
            },
          ],
          video: { source: "clip" },
        },
        embedding: [1, 0, 0],
        ...(boundaries
          ? {
              shots: {
                version: 1,
                method: "ffmpeg-scene",
                threshold: 0.3,
                boundaries,
                durationSec: 6.5,
                at: "x",
              },
            }
          : {}),
      },
    } as never)
    .returning({ id: mediaAssets.id });
  return row.id;
}

const item = (over: Partial<PlanItem> = {}): PlanItem => ({
  kind: "clip",
  beat: "the close-up",
  direction: "she looks at the camera",
  ref: "a1",
  segment: 1,
  window: null,
  motion: null,
  searchQuery: null,
  sound: false,
  ...over,
});
const plan = (...items: PlanItem[]): AgentPlan => ({
  items,
  nulled: [],
  gaps: [],
});

async function castSegment(id: string) {
  const library = new Map([["a1", (await loadCastable(her, [id])).get(id)!]]);
  const out = await castPlan(her, plan(item()), {
    products: [],
    library,
    picks: [],
    avoid: [],
  });
  return out.items[0] as { trim: { startSec: number; endSec: number } | null };
}

it("a beat edge 0.2 s from a cut is cut on the cut", async () => {
  process.env.STUDIO_SHOT_DETECT = "true";
  expect((await castSegment(await clip([2.8]))).trim).toEqual({
    startSec: 2.8,
    endSec: 6.5,
  });
});

it("a cut 0.7 s away leaves the beat as it is", async () => {
  process.env.STUDIO_SHOT_DETECT = "true";
  expect((await castSegment(await clip([2.3]))).trim).toEqual({
    startSec: 3,
    endSec: 6.5,
  });
});

it("flag off: the beat as the read wrote it, whatever cuts are stored", async () => {
  expect((await castSegment(await clip([2.8]))).trim).toEqual({
    startSec: 3,
    endSec: 6.5,
  });
});

it("the pick carries its boundaries only under the flag, and only when stored — off, the pick is what it was", async () => {
  const withCuts = await clip([2.8]);
  const bare = await clip(null);
  const rows = await loadCastable(her, [withCuts, bare]);
  expect((await asPick(rows.get(withCuts)!)).shots).toBeUndefined();
  expect("shots" in rows.get(bare)!).toBe(false);
  process.env.STUDIO_SHOT_DETECT = "true";
  expect((await asPick(rows.get(withCuts)!)).shots).toEqual([2.8]);
  expect("shots" in (await asPick(rows.get(bare)!))).toBe(false);
});
