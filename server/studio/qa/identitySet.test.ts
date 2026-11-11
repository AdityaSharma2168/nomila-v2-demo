/**
 * qa/identitySet — against real SQL, in PGlite.
 *
 * Every assertion here is about WHICH ROWS a generate's face is compared against, and the rules that
 * pick them are all SQL: the tenancy predicate, the jsonb vision tags, the held-out exclusion. A mock
 * would agree with any of them while being wrong.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { db } from "../../db";
import { generationJobs, mediaAssets } from "../../../shared/schema";
import { closeTestDb, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { IDENTITY_SET_SIZE, identityTargetsFor } from "./identitySet";

let me: string;
let other: string;

beforeAll(async () => {
  await initTestDb();
  me = await seedAthlete("Athlete Me");
  other = await seedAthlete("Athlete Other");
});
afterAll(async () => closeTestDb());

interface PhotoOver {
  present?: unknown;
  prominence?: unknown;
  mediaType?: string;
  generated?: boolean;
  deleted?: boolean;
  noPixels?: boolean;
}

/** One library photo. `vision` shaped as lib/visionTag.ts writes it. */
async function photo(
  owner: string,
  path: string,
  over: PhotoOver = {},
): Promise<string> {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: owner,
      platform: over.generated ? "studio" : "upload",
      origin: over.generated ? "generated" : "upload",
      media_type: over.mediaType ?? "IMAGE",
      status: "stored",
      gcs_path: over.noPixels ? null : path,
      deleted_at: over.deleted ? new Date() : null,
      metadata: {
        vision: {
          athlete_present: over.present ?? true,
          athlete_prominence: over.prominence ?? 0.9,
        },
      },
    } as never)
    .returning({ id: mediaAssets.id });
  return row.id;
}

/** A job whose frozen brief carries these references. */
async function job(
  owner: string,
  references: { role: string; mediaAssetId: string }[],
) {
  const [row] = await db
    .insert(generationJobs)
    .values({
      athlete_id: owner,
      origin: "system",
      mode: "generate",
      objective: "grow-following",
      deliverable: "post",
      brief: {
        job: {
          references: references.map((r) => ({
            ...r,
            ref: "synthetic/ref.jpg",
          })),
        },
      },
      status: "running",
    } as never)
    .returning({ id: generationJobs.id });
  return row.id;
}

/** Each test builds its own athlete, so one test's library never leaks into another's held-out set. */
async function freshAthlete(): Promise<string> {
  return seedAthlete("Athlete Fresh");
}

describe("references — the photographs the job was conditioned on", () => {
  it("returns her person references in brief order, read off HER rows", async () => {
    const a = await freshAthlete();
    const r1 = await photo(a, "lib/r1.jpg");
    const r2 = await photo(a, "lib/r2.jpg");
    const product = await photo(a, "lib/boot.jpg");
    const j = await job(a, [
      { role: "person", mediaAssetId: r2 },
      { role: "product", mediaAssetId: product },
      { role: "person", mediaAssetId: r1 },
    ]);

    const refs = (await identityTargetsFor(j, a)).filter(
      (t) => t.comparedAgainst === "references",
    );
    expect(refs).toEqual([
      { assetId: r2, gcsPath: "lib/r2.jpg", comparedAgainst: "references" },
      { assetId: r1, gcsPath: "lib/r1.jpg", comparedAgainst: "references" },
    ]);
  });

  it("is EMPTY for a generate with no person reference — not scored, nothing fetched", async () => {
    const a = await freshAthlete();
    await photo(a, "lib/her.jpg");
    const product = await photo(a, "lib/boot.jpg");
    expect(await identityTargetsFor(await job(a, []), a)).toEqual([]);
    expect(
      await identityTargetsFor(
        await job(a, [{ role: "product", mediaAssetId: product }]),
        a,
      ),
    ).toEqual([]);
  });

  it("⚠️ TENANCY: another athlete's photo on the brief is dropped, never compared", async () => {
    const a = await freshAthlete();
    const theirs = await photo(other, "lib/THEIRS.jpg");
    await photo(a, "lib/held.jpg");
    const j = await job(a, [{ role: "person", mediaAssetId: theirs }]);

    const targets = await identityTargetsFor(j, a);
    expect(targets).toEqual([]);
    expect(JSON.stringify(targets)).not.toContain("THEIRS");
  });

  it("⚠️ TENANCY: another athlete's job reads as no job — even when its references would resolve", async () => {
    // A job of MINE naming a photo of THEIRS, asked for as them. The re-read would find the photo, so
    // only the job's own predicate stands between this call and a job that is not theirs.
    const theirs = await photo(other, "lib/theirs-too.jpg");
    await photo(other, "lib/their-held.jpg");
    const j = await job(me, [{ role: "person", mediaAssetId: theirs }]);
    expect(await identityTargetsFor(j, other)).toEqual([]);
  });
});

describe("identity-set — her library, HELD OUT from the job", () => {
  it("takes photos where she is present and prominent, and never a reference", async () => {
    const a = await freshAthlete();
    const ref = await photo(a, "lib/ref.jpg", { prominence: 1.0 });
    const held = await photo(a, "lib/held.jpg", { prominence: 0.8 });
    const j = await job(a, [{ role: "person", mediaAssetId: ref }]);

    const set = (await identityTargetsFor(j, a)).filter(
      (t) => t.comparedAgainst === "identity-set",
    );
    expect(set.map((t) => t.assetId)).toEqual([held]);
  });

  it("excludes every photo that is not a clean photograph of her", async () => {
    const a = await freshAthlete();
    const ref = await photo(a, "lib/ref.jpg");
    const keep = await photo(a, "lib/keep.jpg", { prominence: 0.5 });
    await photo(a, "lib/absent.jpg", { present: false });
    await photo(a, "lib/incidental.jpg", { prominence: 0.3 });
    await photo(a, "lib/garbage-prominence.jpg", { prominence: "high" });
    await photo(a, "lib/video.mp4", { mediaType: "VIDEO" });
    await photo(a, "studio/a-render-of-her.png", { generated: true });
    await photo(a, "lib/deleted.jpg", { deleted: true });
    await photo(a, "lib/no-pixels.jpg", { noPixels: true });
    await photo(other, "lib/their-library.jpg");
    const j = await job(a, [{ role: "person", mediaAssetId: ref }]);

    const set = (await identityTargetsFor(j, a)).filter(
      (t) => t.comparedAgainst === "identity-set",
    );
    expect(set.map((t) => t.gcsPath)).toEqual(["lib/keep.jpg"]);
    expect(set[0].assetId).toBe(keep);
  });

  it(`caps at ${IDENTITY_SET_SIZE}, most prominent first`, async () => {
    const a = await freshAthlete();
    const ref = await photo(a, "lib/ref.jpg");
    for (const p of [0.55, 0.95, 0.6, 1.0, 0.7, 0.9])
      await photo(a, `lib/p${p}.jpg`, { prominence: p });
    const j = await job(a, [{ role: "person", mediaAssetId: ref }]);

    const set = (await identityTargetsFor(j, a)).filter(
      (t) => t.comparedAgainst === "identity-set",
    );
    expect(IDENTITY_SET_SIZE).toBe(4);
    expect(set.map((t) => t.gcsPath)).toEqual([
      "lib/p1.jpg",
      "lib/p0.95.jpg",
      "lib/p0.9.jpg",
      "lib/p0.7.jpg",
    ]);
  });
});
