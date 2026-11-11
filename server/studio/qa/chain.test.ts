/**
 * qa/chain + qa/record — against real SQL, in PGlite.
 *
 * The lineage walk and the metadata merge are the two pieces that touch the database, so they are
 * tested against a real Postgres with the real schema rather than a mock: the tenancy predicate,
 * the self-referencing FK and the jsonb round-trip are all things a mock would agree with while
 * being wrong.
 */
import { eq } from "drizzle-orm";

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { db } from "../../db";
import { mediaAssets } from "../../../shared/schema";
import { closeTestDb, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { findChainRoot } from "./chain";
import { QA_METADATA_KEY, readVerdict, writeVerdict } from "./record";
import type { CreativeQaVerdict } from "./verdict";

let athleteA: string;
let athleteB: string;

beforeAll(async () => {
  await initTestDb();
  athleteA = await seedAthlete("Athlete A");
  athleteB = await seedAthlete("Athlete B");
});
afterAll(async () => closeTestDb());

/** Insert one asset, optionally derived from another. Returns its id. */
async function asset(
  athleteId: string,
  derivedFrom: string | null = null,
  path = "gs://x.png",
): Promise<string> {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: athleteId,
      platform: "studio",
      origin: derivedFrom ? "generated" : "upload",
      media_type: "IMAGE",
      status: "stored",
      gcs_path: path,
      derived_from_asset_id: derivedFrom,
    } as never)
    .returning({ id: mediaAssets.id });
  return row.id;
}

describe("findChainRoot", () => {
  it("returns the asset itself at depth 0 when nothing is above it", async () => {
    const a = await asset(athleteA);
    const r = await findChainRoot(a, athleteA);
    expect(r).toMatchObject({
      rootAssetId: a,
      depth: 0,
      truncated: false,
      reason: "root",
    });
  });

  it("walks a direct edit to depth 1", async () => {
    const root = await asset(athleteA, null, "gs://root.png");
    const edit = await asset(athleteA, root);
    const r = await findChainRoot(edit, athleteA);
    expect(r).toMatchObject({ rootAssetId: root, depth: 1, truncated: false });
    expect(r!.gcsPath).toBe("gs://root.png");
  });

  it("walks a chain of edits to the ORIGINAL, not the parent — the whole point", async () => {
    const root = await asset(athleteA, null, "gs://original.png");
    const one = await asset(athleteA, root);
    const two = await asset(athleteA, one);
    const three = await asset(athleteA, two);

    const r = await findChainRoot(three, athleteA);
    expect(r!.rootAssetId).toBe(root);
    expect(r!.rootAssetId).not.toBe(two); // the parent, which a naive walk would return
    expect(r!.depth).toBe(3);
    expect(r!.gcsPath).toBe("gs://original.png");
  });

  it("returns null for an asset that is not this athlete's", async () => {
    const theirs = await asset(athleteB);
    expect(await findChainRoot(theirs, athleteA)).toBeNull();
  });

  it("stops at a tenancy boundary rather than reading across it", async () => {
    // A pointer that crosses athletes should never be followed, whatever wrote it.
    const theirRoot = await asset(athleteB, null, "gs://theirs.png");
    const mine = await asset(athleteA, theirRoot);

    const r = await findChainRoot(mine, athleteA);
    expect(r!.rootAssetId).toBe(mine);
    expect(r!.truncated).toBe(true);
    expect(r!.reason).toBe("missing_ancestor");
    expect(r!.gcsPath).not.toBe("gs://theirs.png");
  });

  it("treats a pointer severed by ON DELETE SET NULL as a root, because that is what it is", async () => {
    // The schema makes a DANGLING pointer impossible — derived_from_asset_id is a real FK, and an
    // attempt to point at a uuid with no row is rejected by Postgres. What CAN happen is the
    // documented one: the parent is deleted and the FK sets this to NULL. The asset then genuinely
    // has no reachable ancestor, and calling it a root is correct rather than a degradation.
    const root = await asset(athleteA);
    const edit = await asset(athleteA, root);
    await db
      .update(mediaAssets)
      .set({ derived_from_asset_id: null })
      .where(eq(mediaAssets.id, edit));

    const r = await findChainRoot(edit, athleteA);
    expect(r).toMatchObject({
      rootAssetId: edit,
      depth: 0,
      truncated: false,
      reason: "root",
    });
  });

  it("cannot be pointed at a row that does not exist — the FK forbids it", async () => {
    const edit = await asset(athleteA);
    await expect(
      db
        .update(mediaAssets)
        .set({ derived_from_asset_id: "00000000-0000-0000-0000-000000000000" })
        .where(eq(mediaAssets.id, edit)),
    ).rejects.toThrow(/foreign key/i);
  });

  it("survives a lineage cycle instead of looping forever", async () => {
    const a = await asset(athleteA);
    const b = await asset(athleteA, a);
    await db
      .update(mediaAssets)
      .set({ derived_from_asset_id: b })
      .where(eq(mediaAssets.id, a));

    const r = await findChainRoot(b, athleteA);
    expect(r!.truncated).toBe(true);
    expect(r!.reason).toBe("cycle");
  });
});

describe("writeVerdict / readVerdict", () => {
  const verdict = (overall: "pass" | "flag" | "fail"): CreativeQaVerdict =>
    ({
      schemaVersion: 1,
      at: new Date().toISOString(),
      overall,
      unknownChecks: 1,
      advisoryChecks: [
        {
          check: "marks" as const,
          status: "pass" as const,
          reason: "advisory",
        },
      ],
      checks: {} as never,
      subject: "edit" as const,
      spend: {
        usd: 0.004,
        basis: "estimated",
        visionCalls: 6,
        embedCalls: 2,
        inputTokens: 100,
        outputTokens: 20,
      },
      latencyMs: 3200,
      comparison: {
        rootAssetId: "root",
        outputAssetId: "out",
        chainDepth: 2,
        chainTruncated: false,
      },
    }) as CreativeQaVerdict;

  it("round-trips a verdict through jsonb", async () => {
    const a = await asset(athleteA);
    expect(await writeVerdict(a, athleteA, verdict("flag"))).toBe(true);

    const back = await readVerdict(a, athleteA);
    expect(back!.overall).toBe("flag");
    expect(back!.unknownChecks).toBe(1);
    expect(back!.spend.usd).toBeCloseTo(0.004);
    expect(back!.comparison.chainDepth).toBe(2);
  });

  it("merges beside existing metadata keys instead of replacing them", async () => {
    const a = await asset(athleteA);
    await db
      .update(mediaAssets)
      .set({
        metadata: {
          vision: { athlete_present: true },
          pixel_grade: "full",
        } as never,
      })
      .where(eq(mediaAssets.id, a));

    await writeVerdict(a, athleteA, verdict("pass"));

    const [row] = await db
      .select({ metadata: mediaAssets.metadata })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, a));
    const m = row.metadata as Record<string, unknown>;
    expect(m.pixel_grade).toBe("full");
    expect((m.vision as Record<string, unknown>).athlete_present).toBe(true);
    expect((m[QA_METADATA_KEY] as CreativeQaVerdict).overall).toBe("pass");
  });

  it("overwrites its own key on a re-run without touching the neighbours", async () => {
    const a = await asset(athleteA);
    await db
      .update(mediaAssets)
      .set({ metadata: { vision: { x: 1 } } as never })
      .where(eq(mediaAssets.id, a));

    await writeVerdict(a, athleteA, verdict("fail"));
    await writeVerdict(a, athleteA, verdict("pass"));

    const back = await readVerdict(a, athleteA);
    expect(back!.overall).toBe("pass");
    const [row] = await db
      .select({ metadata: mediaAssets.metadata })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, a));
    expect((row.metadata as Record<string, unknown>).vision).toEqual({ x: 1 });
  });

  it("sets metadata_updated_at", async () => {
    const a = await asset(athleteA);
    await writeVerdict(a, athleteA, verdict("pass"));
    const [row] = await db
      .select({ at: mediaAssets.metadata_updated_at })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, a));
    expect(row.at).toBeInstanceOf(Date);
  });

  it("refuses to write to another athlete's asset", async () => {
    const theirs = await asset(athleteB);
    expect(await writeVerdict(theirs, athleteA, verdict("fail"))).toBe(false);
    expect(await readVerdict(theirs, athleteA)).toBeNull();

    const [row] = await db
      .select({ metadata: mediaAssets.metadata })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, theirs));
    expect(row.metadata).toBeNull();
  });

  it("returns false rather than throwing when the asset does not exist", async () => {
    const ok = await writeVerdict(
      "00000000-0000-0000-0000-000000000000",
      athleteA,
      verdict("pass"),
    );
    expect(ok).toBe(false);
  });
});
