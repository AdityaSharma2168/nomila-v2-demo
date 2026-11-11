/**
 * resolveRefs.test — `ref_N` → the asset its reading was made from (PR 14, R-6), on PGlite.
 *
 * MUTATIONS, by name:
 *   "ref_N resolves to another athlete's reading" — drop `athlete_id` from the query: the tenancy test reds.
 *   "ref_N handle reaches compile unresolved" — return the brief untouched: the first test reds.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { mediaAssets, studioReferenceAnalyses } from "../../../shared/schema";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../../testUtils/pgliteDb";
import { validateCampaignBrief, type CampaignBrief } from "./brief";
import {
  postsReferenceAsset,
  resolveReferenceAssets,
  stripReferenceAssets,
} from "./resolveRefs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { campaign } = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "bottle-campaign.json"), "utf8"),
) as { campaign: Record<string, unknown> };

const INTENT = {
  composition: { summary: "Centered.", tags: ["centered"], basis: "observed" },
  camera: {
    summary: "A static medium shot.",
    tags: ["medium", "static"],
    basis: "observed",
  },
  lens_perspective: null,
  lighting: {
    summary: "Soft studio light.",
    tags: ["studio", "soft_light"],
    basis: "inferred",
  },
  color: { summary: "Muted.", tags: [], basis: "observed" },
  environment: null,
  subject_placement: null,
  wardrobe: null,
  motion: null,
  editing_rhythm: null,
  typography: null,
  emotional_tone: { summary: "Calm.", tags: [], basis: "observed" },
};

let her: string;
let other: string;
beforeAll(async () => {
  await initTestDb();
  her = await seedAthlete("Carrier Athlete");
  other = await seedAthlete("Other Athlete");
});
afterAll(async () => {
  await closeTestDb();
});
beforeEach(async () => {
  await db.delete(studioReferenceAnalyses);
  await db.delete(mediaAssets);
});

async function photo(owner: string): Promise<string> {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: owner,
      platform: "studio",
      origin: "upload",
      media_type: "IMAGE",
      status: "stored",
      gcs_path: `athletes/${owner}/${Math.random().toString(36).slice(2)}.jpg`,
      content_type: "image/jpeg",
      ingested_at: new Date(),
    } as never)
    .returning({ id: mediaAssets.id });
  return row.id;
}

async function reading(
  owner: string,
  assetId: string | null,
  intent: unknown = INTENT,
  role = "style_reference",
) {
  await db.insert(studioReferenceAnalyses).values({
    athlete_id: owner,
    source_kind: assetId ? "image" : "brief",
    source_asset_id: assetId,
    source_text: assetId ? null : "a pasted brief",
    role,
    decomposition: {
      schema: "reference-decomposition/1",
      reference_intent: intent,
      commercial_style: [],
    },
    prompt_version: "reference-decomposition/1",
    model: "test",
  } as never);
}

const brief = (
  intent: unknown = INTENT,
  role = "style_reference",
): CampaignBrief => {
  const v = validateCampaignBrief({
    ...campaign,
    references: [{ ref: "ref_1", role, intent }],
  });
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  return v.brief;
};

describe("resolveReferenceAssets", () => {
  it("P-ref: ref_1 resolves to the source_asset_id of the reading it carries, under her id", async () => {
    const asset = await photo(her);
    await reading(her, asset);
    const out = await resolveReferenceAssets(her, brief());
    expect(out.references[0]).toMatchObject({ ref: "ref_1", assetId: asset });
    // Everything else on the brief is untouched.
    expect({ ...out, references: [] }).toEqual({ ...brief(), references: [] });
  });

  it("never resolves to another athlete's reading, even an identical one", async () => {
    const theirs = await photo(other);
    await reading(other, theirs);
    const out = await resolveReferenceAssets(her, brief());
    expect("assetId" in out.references[0]).toBe(false);
  });

  it("a reading from text has no asset; a reading that no longer exists resolves to nothing — never an error", async () => {
    await reading(her, null);
    expect(
      "assetId" in (await resolveReferenceAssets(her, brief())).references[0],
    ).toBe(false);
    await db.delete(studioReferenceAnalyses);
    expect(
      "assetId" in (await resolveReferenceAssets(her, brief())).references[0],
    ).toBe(false);
  });

  it("matches the reading, not the role alone: a different intent under the same role is not it", async () => {
    const asset = await photo(her);
    await reading(her, asset, {
      ...INTENT,
      color: { summary: "Loud.", tags: [], basis: "observed" },
    });
    expect(
      "assetId" in (await resolveReferenceAssets(her, brief())).references[0],
    ).toBe(false);
  });

  it("the newest matching reading wins", async () => {
    const first = await photo(her);
    const second = await photo(her);
    await reading(her, first);
    await new Promise((r) => setTimeout(r, 5));
    await reading(her, second);
    expect(
      (await resolveReferenceAssets(her, brief())).references[0],
    ).toMatchObject({ assetId: second });
  });

  it("a posted assetId is dropped before resolving, and the helpers see it", async () => {
    const posted = {
      ...brief(),
      references: [
        {
          ...brief().references[0],
          assetId: "22222222-2222-4222-8222-222222222222",
        },
      ],
    };
    expect(postsReferenceAsset(posted)).toBe(true);
    expect(postsReferenceAsset(brief())).toBe(false);
    expect(postsReferenceAsset(null)).toBe(false);
    const out = await resolveReferenceAssets(her, posted as CampaignBrief);
    expect("assetId" in out.references[0]).toBe(false);
    expect(stripReferenceAssets(posted)).toEqual(brief());
    expect(stripReferenceAssets(null)).toBeNull();
    expect(stripReferenceAssets({ references: "no" })).toEqual({
      references: "no",
    });
  });
});
