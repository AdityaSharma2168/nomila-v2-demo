/**
 * profile.test — the row, and the ONE rule that lets a band be asserted (PR 17, R-1/R-4).
 *
 * REVERT CHECKS, red by name:
 *   "a threshold is asserted before the stranger control passes" → assertableBand returns the band
 *     when control_passed is null
 *   "position() reads the profile row when control failed"       → assertableBand returns the band
 *     when control_passed is false
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../../testUtils/pgliteDb";
import { identityProfiles } from "../../../shared/schema";
import {
  assertableBand,
  bandFor,
  parsePack,
  readProfile,
  writeBand,
  writeControl,
  writeFaceSizes,
  writePack,
  type IdentityProfile,
} from "./profile";

let A: string;
let B: string;

beforeAll(async () => {
  await initTestDb();
  A = await seedAthlete("A");
  B = await seedAthlete("B");
});
afterAll(closeTestDb);

const entry = (id: string) => ({
  assetId: id,
  faceSizeFrac: null,
  prominence: 0.8,
  faceVisibility: "clear" as const,
  shotType: "portrait" as string | null,
});
const twelve = Array.from({ length: 12 }, (_, i) =>
  entry(`0000000${i}-0000-4000-8000-00000000000${i % 10}`),
);

describe("the row", () => {
  it("is null until she saves a pack; then it is hers alone", async () => {
    expect(await readProfile(A)).toBeNull();
    await writePack(A, twelve);
    const p = await readProfile(A);
    expect(p?.pack).toHaveLength(12);
    expect(p?.incomplete).toBe(false);
    expect(await readProfile(B)).toBeNull();
  });

  it("fewer than PACK_MIN is incomplete", async () => {
    await writePack(B, twelve.slice(0, 4));
    expect((await readProfile(B))?.incomplete).toBe(true);
  });

  it("a band write never sets control_passed", async () => {
    await writeBand(A, { min: 0.2, max: 0.5, pairs: 66 });
    const p = await readProfile(A);
    expect(p?.band).toMatchObject({ min: 0.2, max: 0.5, pairs: 66 });
    expect(p?.controlPassed).toBeNull();
    expect(p?.embedder).toBe("face-crop/multimodalembedding@001");
  });

  it("face sizes are written back onto the same entries by id, numbers only", async () => {
    await writeFaceSizes(A, {
      [twelve[0].assetId]: 0.31,
      [twelve[1].assetId]: null,
    });
    const p = await readProfile(A);
    expect(p?.pack[0].faceSizeFrac).toBe(0.31);
    expect(p?.pack[1].faceSizeFrac).toBeNull();
    expect(p?.pack[2].faceSizeFrac).toBeNull();
  });

  it("a new pack clears every measurement — they were about the old photographs", async () => {
    await writeControl(A, true);
    expect((await readProfile(A))?.controlPassed).toBe(true);
    await writePack(A, twelve.slice(0, 11));
    const p = await readProfile(A);
    expect(p?.band).toBeNull();
    expect(p?.controlPassed).toBeNull();
    expect(p?.embedder).toBeNull();
  });

  it("the jsonb never carries anything but id + numbers + the face word", async () => {
    await writePack(A, [
      { ...entry(twelve[0].assetId), embedding: [0.1, 0.2] } as never,
    ]);
    const [row] = await db
      .select({ pack: identityProfiles.pack })
      .from(identityProfiles)
      .where(eq(identityProfiles.athlete_id, A));
    expect(row.pack).toEqual([entry(twelve[0].assetId)]);
  });

  it("parsePack drops what is not the closed shape", () => {
    expect(
      parsePack([
        {
          assetId: "x",
          faceSizeFrac: "0.2",
          prominence: "0.5",
          faceVisibility: "clear",
          shotType: 7,
        },
        { assetId: "y", faceVisibility: "none" },
        { faceVisibility: "clear" },
        "junk",
        null,
      ]),
    ).toEqual([
      {
        assetId: "x",
        faceSizeFrac: 0.2,
        prominence: 0.5,
        faceVisibility: "clear",
        shotType: null,
      },
    ]);
  });
});

describe("assertableBand — the only way a band reaches qa/identity.ts", () => {
  const base: IdentityProfile = {
    athleteId: A,
    pack: twelve,
    incomplete: false,
    band: {
      min: 0.2,
      max: 0.5,
      pairs: 66,
      measuredAt: "2026-09-24T00:00:00.000Z",
    },
    controlPassed: true,
    controlMeasuredAt: "2026-09-24T00:00:00.000Z",
    embedder: "face-crop/multimodalembedding@001",
  };

  it("answers the band when the control passed", () => {
    expect(assertableBand(base)).toEqual({ min: 0.2, max: 0.5, pairs: 66 });
  });

  it("a threshold is asserted before the stranger control passes — null while the control has not run", () => {
    expect(assertableBand({ ...base, controlPassed: null })).toBeNull();
  });

  it("position() reads the profile row when control failed — null when the control failed", () => {
    expect(assertableBand({ ...base, controlPassed: false })).toBeNull();
  });

  it("null with no band on the row, whatever the control says", () => {
    expect(assertableBand({ ...base, band: null })).toBeNull();
    expect(assertableBand(null)).toBeNull();
  });

  it("bandFor reads the same rule off the database", async () => {
    await writePack(B, twelve);
    await writeBand(B, { min: 0.1, max: 0.4, pairs: 66 });
    expect(await bandFor(B)).toBeNull();
    await writeControl(B, false);
    expect(await bandFor(B)).toBeNull();
    await writeControl(B, true);
    expect(await bandFor(B)).toEqual({ min: 0.1, max: 0.4, pairs: 66 });
  });
});
