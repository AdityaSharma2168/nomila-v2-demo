/**
 * styleSpec.test.ts — the stored reading → the style spec (pure), and her already-read references under her id
 * (PGlite). PR 18.
 *
 * Red by name when taken out:
 *   M1  "a style spec is not derived from the stored reading" (restated for derive-on-read, ADI-GO18 G1): the
 *       spec a resolve returns is exactly styleSpecFrom of her stored row, and a changed row gives a changed spec.
 *   Tenancy: "another athlete's reading resolves to nothing" — drop the athlete predicate in styleStore.ts.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import {
  closeTestDb,
  db,
  initTestDb,
  seedAthlete,
} from "../../testUtils/pgliteDb";
import { mediaAssets, studioReferenceAnalyses } from "../../../shared/schema";
import {
  STILL_DIMENSIONS,
  STYLE_SPEC_VERSION,
  styleSpecFrom,
} from "./styleSpec";
import { listReadStyleReferences, resolveStyleReference } from "./styleStore";
import { READING, analysisRow, SPEC } from "./styleFixtures";

describe("styleSpecFrom — pure, versioned, whole", () => {
  it("keeps the still's dimensions, whole, and drops motion, editing rhythm and typography (R-C 3, 8, 10)", () => {
    expect(SPEC.version).toBe(STYLE_SPEC_VERSION);
    expect(Object.keys(SPEC.dimensions)).toEqual(
      STILL_DIMENSIONS.filter((d) => READING.reference_intent[d] !== null),
    );
    expect(SPEC.dimensions.lighting?.summary).toBe(
      READING.reference_intent.lighting.summary,
    );
    expect(JSON.stringify(SPEC)).not.toMatch(/ZQMOTION|ZQTYPE/);
  });

  it("the image shot keeps shot sizes and angles and drops camera movement", () => {
    expect(SPEC.shot).toEqual({
      camera: ["low_angle", "close_up"],
      lighting: ["hard_light", "rim_light"],
      composition: ["negative_space"],
    });
  });

  it("a 300-character summary is carried whole, never cut", () => {
    const long = "ZQLONG " + "x".repeat(293);
    const spec = styleSpecFrom(
      analysisRow({
        decomposition: {
          ...READING,
          reference_intent: {
            ...READING.reference_intent,
            color: { summary: long, tags: [], basis: "observed" },
          },
        },
      }),
    )!;
    expect(long).toHaveLength(300);
    expect(spec.dimensions.color?.summary).toBe(long);
  });

  it("carries its provenance: the analysis, the image, the reading's own prompt version and model", () => {
    expect(SPEC).toMatchObject({
      analysisId: analysisRow().id,
      sourceAssetId: analysisRow().source_asset_id,
      reading: {
        promptVersion: "reference/1",
        model: "gemini-flash-synthetic",
      },
      target: "whole_frame",
      commercialStyle: ["sports_campaign"],
    });
  });

  it("the same row gives the same spec, every time", () => {
    expect(styleSpecFrom(analysisRow())).toEqual(styleSpecFrom(analysisRow()));
  });

  it("refuses what is not a style reading from an image: another role, a text source, a reading the stored shape refuses", () => {
    expect(
      styleSpecFrom(analysisRow({ role: "composition_reference" })),
    ).toBeNull();
    expect(styleSpecFrom(analysisRow({ source_asset_id: null }))).toBeNull();
    expect(
      styleSpecFrom(analysisRow({ decomposition: { ...READING, extra: 1 } })),
    ).toBeNull();
  });
});

describe("her already-read references, under her id (PGlite)", () => {
  let HER: string;
  let OTHER: string;
  let herImage: string;
  let herUnread: string;
  let theirImage: string;

  const image = async (athleteId: string) => {
    const [row] = await db
      .insert(mediaAssets)
      .values({
        athlete_id: athleteId,
        platform: "web",
        origin: "reference",
        media_type: "IMAGE",
        status: "stored",
        gcs_path: `athletes/${athleteId}/references/${Math.random().toString(36).slice(2)}.jpg`,
      } as never)
      .returning({ id: mediaAssets.id });
    return row.id;
  };
  const read = (athleteId: string, assetId: string, decomposition = READING) =>
    db.insert(studioReferenceAnalyses).values({
      athlete_id: athleteId,
      source_kind: "image",
      source_asset_id: assetId,
      role: "style_reference",
      decomposition,
      prompt_version: "reference/1",
      model: "gemini-flash-synthetic",
    } as never);

  beforeAll(async () => {
    await initTestDb();
    HER = await seedAthlete("A");
    OTHER = await seedAthlete("B");
    herImage = await image(HER);
    herUnread = await image(HER);
    theirImage = await image(OTHER);
    await read(HER, herImage);
    await read(OTHER, theirImage);
  }, 120_000);
  afterAll(closeTestDb);

  it("a style spec is not derived from the stored reading — it must be: the resolve IS styleSpecFrom of her row", async () => {
    const out = await resolveStyleReference(HER, herImage);
    if (!out.ok) throw new Error(out.reason);
    const [row] = await db
      .select()
      .from(studioReferenceAnalyses)
      .where(
        (await import("drizzle-orm")).eq(
          studioReferenceAnalyses.source_asset_id,
          herImage,
        ),
      );
    expect(out.reference.style).toEqual(styleSpecFrom(row));
    expect(out.reference).toMatchObject({
      role: "style_reference",
      mediaAssetId: herImage,
    });
  });

  it("the newest reading of an image wins", async () => {
    await read(HER, herImage, {
      ...READING,
      reference_intent: {
        ...READING.reference_intent,
        emotional_tone: {
          summary: "ZQNEWMOOD light and easy",
          tags: [],
          basis: "observed",
        },
      },
    });
    const out = await resolveStyleReference(HER, herImage);
    if (!out.ok) throw new Error(out.reason);
    expect(out.reference.style.dimensions.emotional_tone?.summary).toBe(
      "ZQNEWMOOD light and easy",
    );
  });

  it("an image with no reading is still being read, never a spec", async () => {
    expect(await resolveStyleReference(HER, herUnread)).toEqual({
      ok: false,
      reason: "style_unread",
    });
  });

  it("another athlete's reading resolves to nothing", async () => {
    expect(await resolveStyleReference(HER, theirImage)).toEqual({
      ok: false,
      reason: "style_not_found",
    });
  });

  it("the picker's list is hers, read, one row per image, newest first", async () => {
    const rows = await listReadStyleReferences(HER);
    expect(rows.map((r) => r.assetId)).toEqual([herImage]);
    expect(rows[0].caption).toBe(READING.reference_intent.lighting.summary);
    expect(await listReadStyleReferences(OTHER)).toHaveLength(1);
  });
});
