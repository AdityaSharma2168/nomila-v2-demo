/**
 * plans.resign.test.ts — a saved plan picks up a LATER clip read (PR 9.5, F22 B3), through real SQL.
 *
 * R-2: a MERGE, not a re-plan. `resignItems` keeps its "no model, no search" contract and adds
 * `beats: N` to a clip item whose asset has beats NOW. P2, as Adi restated it at the go: the answer
 * is byte-identical to today's resign when no asset gained beats, and differs ONLY in `beats` when
 * one did. The stored row is never rewritten.
 *
 * ⚠️ MUTATION "saved plan ignores a later read": drop the merge in plans.ts resignItems — the second
 * half reds by name.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/mediaEmbed", () => ({
  embedText: jest.fn(),
  embedImageGcs: jest.fn(),
  embedImageGcsWithReason: jest.fn(),
  cosine: () => 0,
}));
jest.mock("../../lib/mediaStore", () => ({
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
  readObject: jest.fn(),
  headObject: jest.fn(),
}));
jest.mock("../../logger", () => ({
  createLogger: () => ({
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { eq, sql } from "drizzle-orm";
import { mediaAssets, studioPlans } from "../../../shared/schema";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../../testUtils/pgliteDb";
import { readPlan, resignItems, savePlan, type StoredPlanBody } from "./plans";
import type { CastItem } from "./cast";

let athleteId: string;
beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Plans Resign Athlete");
});
afterAll(async () => {
  await closeTestDb();
});
beforeEach(async () => {
  await db.delete(studioPlans);
  await db.delete(mediaAssets);
});

const BEATS = [
  {
    start_s: 0,
    end_s: 3,
    description: "wide",
    camera: "static",
    motion: "run",
  },
  {
    start_s: 3,
    end_s: 6,
    description: "close",
    camera: "handheld",
    motion: "still",
  },
];

async function clip(over: Record<string, unknown> = {}): Promise<string> {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: athleteId,
      platform: "upload",
      origin: "upload",
      media_type: "VIDEO",
      status: "stored",
      gcs_path: `athletes/${athleteId}/uploads/clip.mp4`,
      gcs_thumb_path: `athletes/${athleteId}/uploads/clip-poster.jpg`,
      content_type: "video/mp4",
      duration_seconds_precise: 6,
      metadata: { vision: { athlete_present: true, description: "poster" } },
      ingested_at: new Date(),
      ...over,
    } as never)
    .returning({ id: mediaAssets.id });
  return row.id;
}

/** A whole-clip item, as the caster stores one she added as-is. */
const clipItem = (assetId: string): CastItem => ({
  kind: "clip",
  beat: "her clip, as it is",
  direction: "",
  sound: true,
  motion: null,
  focus: null,
  reason: null,
  assetId,
  thumbUrl: null,
  athletePresent: true,
  brandFlag: null,
  swapped: null,
  rewritten: null,
  demoted: null,
  uncast: null,
  mediaType: "clip",
  trim: null,
  durationSeconds: 6,
  videoUrl: null,
  provenance: "camera",
  platform: "upload",
  editNote: null,
});

const body = (assetId: string): StoredPlanBody => ({
  items: [clipItem(assetId)],
  castCount: 1,
  picksWithoutHer: [],
  gaps: [],
  look: null,
  music: null,
});

const noPoster = async () => null;
const storedItems = async (planId: string) =>
  ((await readPlan(athleteId, planId))!.plan as StoredPlanBody).items;

describe("resignItems merges a later read (B3, P2)", () => {
  it("no asset gained beats: the answer is byte-identical to the resign of the stored plan, twice, and carries no `beats` key", async () => {
    const id = await clip();
    const { id: planId } = await savePlan(athleteId, { plan: body(id) });
    const items = await storedItems(planId);
    const first = await resignItems(athleteId, items, noPoster);
    const second = await resignItems(athleteId, items, noPoster);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect("beats" in first[0]).toBe(false);
    // What a resign changes today, and nothing else: the signed urls.
    expect(first[0]).toEqual({
      ...items[0],
      thumbUrl: `https://signed.example/athletes/${athleteId}/uploads/clip-poster.jpg`,
      videoUrl: `https://signed.example/athletes/${athleteId}/uploads/clip.mp4`,
    });
  });

  it("the asset gained beats: the answer differs ONLY in `beats: N`, and the stored row is untouched — 'saved plan ignores a later read' reds here", async () => {
    const id = await clip();
    const { id: planId } = await savePlan(athleteId, { plan: body(id) });
    const before = await resignItems(
      athleteId,
      await storedItems(planId),
      noPoster,
    );
    const storedBefore = JSON.stringify(await storedItems(planId));
    // The clip read lands later, on its one key — exactly as videoEnrichment.ts writes it.
    await db.execute(
      sql`UPDATE ${mediaAssets} SET metadata = jsonb_set(metadata, '{vision,beats}', ${JSON.stringify(BEATS)}::jsonb) WHERE id = ${id}`,
    );
    const after = await resignItems(
      athleteId,
      await storedItems(planId),
      noPoster,
    );
    expect(after[0]).toEqual({ ...before[0], beats: 2 });
    expect(JSON.stringify(await storedItems(planId))).toBe(storedBefore);
  });

  it("an item whose asset is no longer hers keeps its place with no url and no beats", async () => {
    const id = await clip();
    const { id: planId } = await savePlan(athleteId, { plan: body(id) });
    await db
      .update(mediaAssets)
      .set({ deleted_at: new Date() })
      .where(eq(mediaAssets.id, id));
    const items = await resignItems(
      athleteId,
      await storedItems(planId),
      noPoster,
    );
    expect(items[0]).toMatchObject({
      assetId: id,
      thumbUrl: null,
      videoUrl: null,
    });
    expect("beats" in items[0]).toBe(false);
  });
});
