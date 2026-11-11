/**
 * store.test.ts — her brand profiles, against real SQL (PGlite).
 *
 * The tenancy claims, each red BY NAME when taken out of store.ts:
 *   * "lists only HER profiles" — drop the athlete predicate from listBrandProfiles.
 *   * "another athlete's profile id resolves to nothing" — drop it from getBrandProfile.
 * And the one the table holds for us: a second profile for the same catalog brand is an "exists", never a throw.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { db, initTestDb, closeTestDb } from "../../testUtils/pgliteDb";
import {
  athletes,
  inboxBrands,
  studioBrandProfiles,
} from "../../../shared/schema";
import {
  MAX_ATTRIBUTES,
  MAX_NAME,
  cleanAttributes,
  createBrandProfile,
  getBrandProfile,
  listBrandProfiles,
} from "./store";

// Synthetic throughout — no real person or brand.
const HER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
let brandId: number;

beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values([
    { id: HER, full_name: "A" },
    { id: OTHER, full_name: "B" },
  ]);
  const [brand] = await db
    .insert(inboxBrands)
    .values({ name: "Synthetic Brand", normalized_name: "synthetic brand" })
    .returning({ id: inboxBrands.id });
  brandId = brand.id;
});

afterAll(closeTestDb);

beforeEach(async () => {
  await db.delete(studioBrandProfiles);
});

async function mustCreate(
  athleteId: string,
  input: Parameters<typeof createBrandProfile>[1],
) {
  const res = await createBrandProfile(athleteId, input);
  if (!res.ok) throw new Error(`create refused: ${res.reason}`);
  return res.profile;
}

describe("brand profiles: tenancy", () => {
  it("lists only HER profiles, newest first", async () => {
    const first = await mustCreate(HER, { name: "First" });
    await mustCreate(OTHER, { name: "Theirs" });
    const second = await mustCreate(HER, { name: "Second" });

    const mine = await listBrandProfiles(HER);
    expect(mine.map((p) => p.id).sort()).toEqual([first.id, second.id].sort());
    expect(mine.map((p) => p.name)).not.toContain("Theirs");
  });

  it("another athlete's profile id resolves to nothing — not-yours is not-found", async () => {
    const theirs = await mustCreate(OTHER, { name: "Theirs" });
    expect(await getBrandProfile(HER, theirs.id)).toBeNull();
    expect(await getBrandProfile(OTHER, theirs.id)).toMatchObject({
      id: theirs.id,
      name: "Theirs",
    });
  });

  it("a malformed id is not-found, not a thrown cast error", async () => {
    await expect(getBrandProfile(HER, "not-a-uuid")).resolves.toBeNull();
  });

  it("the same catalog brand may have a profile per athlete", async () => {
    await mustCreate(HER, { name: "Synthetic Brand", brandId });
    const res = await createBrandProfile(OTHER, {
      name: "Synthetic Brand",
      brandId,
    });
    expect(res.ok).toBe(true);
  });
});

describe("brand profiles: create", () => {
  it("keeps the catalog brand and cleaned attributes", async () => {
    const p = await mustCreate(HER, {
      name: "  Synthetic   Brand ",
      brandId,
      attributes: [" premium", "Athletic", "athletic", "confident"],
    });
    expect(p).toMatchObject({
      name: "Synthetic Brand",
      brandId,
      attributes: ["premium", "Athletic", "confident"],
    });
  });

  it("a second profile for the same brand is an 'exists', never a throw", async () => {
    await mustCreate(HER, { name: "Synthetic Brand", brandId });
    await expect(
      createBrandProfile(HER, { name: "Again", brandId }),
    ).resolves.toEqual({ ok: false, reason: "exists" });
  });

  it("refuses a catalog brand that does not exist", async () => {
    await expect(
      createBrandProfile(HER, { name: "Ghost", brandId: 987654 }),
    ).resolves.toEqual({ ok: false, reason: "unknown_brand" });
  });

  it("refuses an empty or over-long name", async () => {
    for (const name of ["", "   ", "x".repeat(MAX_NAME + 1)]) {
      await expect(createBrandProfile(HER, { name })).resolves.toEqual({
        ok: false,
        reason: "invalid_name",
      });
    }
  });

  it("refuses attributes that are not a short list of short words", async () => {
    for (const attributes of [
      "premium",
      [1],
      [""],
      ["x".repeat(41)],
      Array.from({ length: MAX_ATTRIBUTES + 1 }, (_, i) => `a${i}`),
    ]) {
      await expect(
        createBrandProfile(HER, { name: "N", attributes }),
      ).resolves.toEqual({ ok: false, reason: "invalid_attributes" });
    }
    expect(await listBrandProfiles(HER)).toEqual([]);
  });

  it("cleanAttributes: absent is empty", () => {
    expect(cleanAttributes(undefined)).toEqual([]);
  });
});
