/**
 * rights.db.test.ts — the rights words on the real table (agent/ready/rights.ts dbRightsStore), on PGlite (in memory,
 * no real database). Made-up athletes only.
 *
 *   RD1 insertMany writes the athlete's rows; a word already live (a double tap) is skipped, never an error
 *   RD2 listLive: the athlete's live rows only, newest first; another athlete's never
 *   RD3 revoke: only a live row of theirs; the row stays (revoked_at), and a new word can then be given
 *   RD4 the photo is deleted: the word is kept (asset_id null, asset_ref naming it) and never counts for a new asset
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { mediaAssets, mediaRightsAttestations } from "../../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { dbRightsStore, dealKeyOf } from "./rights";

let A = "";
let B = "";
let asset = "";

beforeAll(async () => {
  await initTestDb();
  A = await seedAthlete("Pat Example");
  B = await seedAthlete("Rival Private");
  [{ id: asset }] = await db.insert(mediaAssets).values({ athlete_id: A, platform: "studio", origin: "upload", media_type: "IMAGE", status: "stored" } as any).returning({ id: mediaAssets.id });
}, 60_000);
afterAll(async () => { await closeTestDb(); });

const own = (athleteId: string, assetId: string) => ({ athleteId, scope: "own_posts" as const, assetId, assetRef: `studio:${assetId}`, assetKind: "photo", dealKey: null, brand: null, itemId: null, words: "w", wordsVersion: "rights/1" });
const deal = (athleteId: string, brand: string) => ({ athleteId, scope: "sponsored" as const, assetId: null, assetRef: null, assetKind: null, dealKey: dealKeyOf(brand), brand, itemId: null, words: "s", wordsVersion: "rights/1" });

test("RD1–RD3: write, skip a live duplicate, list theirs, revoke, give again", async () => {
  await dbRightsStore.insertMany(A, [own(A, asset), deal(A, "Brand One")]);
  await dbRightsStore.insertMany(A, [own(A, asset), deal(A, "brand one")]);       // a double tap: skipped
  await dbRightsStore.insertMany(B, [deal(B, "Brand One"), own(A, asset)]);        // B's own row; A's row in B's call is ignored
  const live = await dbRightsStore.listLive(A);
  expect(live.map((r) => [r.scope, r.assetId, r.dealKey]).sort()).toEqual([["own_posts", asset, null], ["sponsored", null, "brand:brand one"]]);
  expect((await dbRightsStore.listLive(B)).map((r) => r.athleteId)).toEqual([B]);

  const ownRow = live.find((r) => r.scope === "own_posts")!;
  expect(await dbRightsStore.revoke(B, ownRow.id, new Date())).toBe(false);
  expect(await dbRightsStore.revoke(A, ownRow.id, new Date())).toBe(true);
  expect(await dbRightsStore.revoke(A, ownRow.id, new Date())).toBe(false);
  expect((await dbRightsStore.listLive(A)).map((r) => r.scope)).toEqual(["sponsored"]);
  await dbRightsStore.insertMany(A, [own(A, asset)]);
  expect((await dbRightsStore.listLive(A)).map((r) => r.scope).sort()).toEqual(["own_posts", "sponsored"]);
  expect((await db.select().from(mediaRightsAttestations)).length).toBe(4);
});

test("RD4: a deleted photo keeps the word, and that word never counts for a new asset", async () => {
  const { eq } = await import("drizzle-orm");
  const { needsOf } = await import("./rights");
  const [{ id: gone }] = await db.insert(mediaAssets).values({ athlete_id: A, platform: "studio", origin: "upload", media_type: "IMAGE", status: "stored" } as any).returning({ id: mediaAssets.id });
  await dbRightsStore.insertMany(A, [own(A, gone)]);
  await db.delete(mediaAssets).where(eq(mediaAssets.id, gone));
  const kept = (await dbRightsStore.listLive(A)).find((r) => r.assetRef === "studio:" + gone)!;
  expect(kept).toMatchObject({ scope: "own_posts", assetId: null, assetKind: "photo", words: "w" });
  const [{ id: fresh }] = await db.insert(mediaAssets).values({ athlete_id: A, platform: "studio", origin: "upload", media_type: "IMAGE", status: "stored" } as any).returning({ id: mediaAssets.id });
  const live = await dbRightsStore.listLive(A);
  expect(needsOf({ assets: [{ assetId: fresh }] as any, guard: undefined }, null, live).missingAssetIds).toEqual([fresh]);
  await dbRightsStore.insertMany(A, [own(A, fresh)]);
  expect((await dbRightsStore.listLive(A)).filter((r) => r.assetId === fresh)).toHaveLength(1);
});
