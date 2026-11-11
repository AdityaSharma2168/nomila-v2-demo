/**
 * The chain rule (PR 19, ADI-R19-BOARD) — "is this made-here row her?", run as real SQL on PGlite, one case per clause
 * of the ruling. The expression under test is `CHAIN_IDENTITY_BOUND_SQL` (studio/referenceGate.ts), the one every
 * consumer reads with STUDIO_LIBRARY_FIELDS on: the reference door, the media lists, the tiles, the caster.
 *
 *   an edit of her upload → her; an edit of an edit of her upload → her; a crop of her upload → her
 *   a CAMERA or RELIGHT edit → her only when identity-on-accept ran on it and passed
 *   an edit whose accept flagged drift → not her, and so is everything made from it
 *   a chain whose root is not her upload → today's rule (the row's own job carried a `person` reference)
 *   a hop onto another athlete's row, a cycle → today's rule; a row with no job → NULL
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { eq, sql } from "drizzle-orm";
import {
  closeTestDb,
  db,
  initTestDb,
  seedAthlete,
} from "../testUtils/pgliteDb";
import { generationJobs, mediaAssets } from "../../shared/schema";
import {
  CHAIN_IDENTITY_BOUND_SQL,
  IDENTITY_BOUND_SQL,
  identityBoundSql,
  jobIdentityBoundOf,
  PHOTO_RANK_SQL,
} from "./referenceGate";

let her: string;
let someoneElse: string;

beforeAll(async () => {
  await initTestDb();
  her = await seedAthlete("Standing Chain Athlete");
  someoneElse = await seedAthlete("Another Athlete");
});
afterAll(async () => {
  await closeTestDb();
});

const path = () =>
  `athletes/synthetic/chain-${Math.random().toString(36).slice(2)}.jpg`;

/** One of her uploads (origin upload). */
async function upload(owner = her): Promise<string> {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: owner,
      platform: "upload",
      origin: "upload",
      media_type: "IMAGE",
      status: "stored",
      gcs_path: path(),
      content_type: "image/jpeg",
    } as never)
    .returning({ id: mediaAssets.id });
  return row.id;
}

/**
 * A made-here row: its own job (the ops its frozen intent changed, the references it carried), what it was derived
 * from, and what identity-on-accept recorded on it, if anything (edit/identityOnAccept.ts `metadata.edit_identity`).
 */
async function made(
  opts: {
    owner?: string;
    from?: string | null;
    ops?: string[];
    refs?: { role: string }[];
    check?: "pass" | "flag";
  } = {},
): Promise<string> {
  const owner = opts.owner ?? her;
  const [job] = await db
    .insert(generationJobs)
    .values({
      athlete_id: owner,
      origin: "system",
      mode: opts.from ? "edit" : "generate",
      ...(opts.from ? { source_asset_id: opts.from } : {}),
      objective: "grow-following",
      deliverable: "post",
      brief: {
        job: {
          references: opts.refs ?? [],
          ...(opts.ops
            ? { editIntent: { changes: opts.ops.map((op) => ({ op })) } }
            : {}),
        },
      },
      status: "succeeded",
    } as never)
    .returning({ id: generationJobs.id });
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: owner,
      platform: "studio",
      origin: "generated",
      media_type: "IMAGE",
      status: "stored",
      gcs_path: path(),
      content_type: "image/jpeg",
      generation_job_id: job.id,
      derived_from_asset_id: opts.from ?? null,
      metadata: opts.check ? { edit_identity: { status: opts.check } } : {},
    } as never)
    .returning({ id: mediaAssets.id });
  return row.id;
}

/** The row's standing as a list query selects it: the chain rule (flag on) or today's rule (flag off). */
async function standing(id: string, chain = true): Promise<boolean | null> {
  const [r] = await db
    .select({ b: sql<boolean | null>`(${sql.raw(identityBoundSql(chain))})` })
    .from(mediaAssets)
    .where(eq(mediaAssets.id, id));
  return r.b;
}

describe("an edit of her upload is her (ADI-R19-BOARD)", () => {
  /** ⚠️ MUTATION M-chain: answer today's rule for every row — this reds by name. */
  it("an edit of her upload → her; today's rule said no", async () => {
    const edit = await made({ from: await upload(), ops: ["REPLACE_OBJECT"] });
    expect(await standing(edit)).toBe(true);
    // The walk's 2342131e: today's rule reads the edit's own job, which carried no `person` reference.
    expect(await standing(edit, false)).toBe(false);
  });

  it("an edit of an edit of her upload → her", async () => {
    const first = await made({ from: await upload(), ops: ["RECOLOR"] });
    const second = await made({ from: first, ops: ["CHANGE_BACKGROUND"] });
    expect(await standing(second)).toBe(true);
  });

  it("a crop of her upload → her: R-14's crop standing is this rule's case", async () => {
    const crop = await made({ from: await upload(), ops: ["CROP"] });
    expect(await standing(crop)).toBe(true);
  });

  it("an edit that ran identity-on-accept and passed → her", async () => {
    const edit = await made({
      from: await upload(),
      ops: ["RECOLOR"],
      check: "pass",
    });
    expect(await standing(edit)).toBe(true);
  });
});

describe("what breaks the chain", () => {
  /** ⚠️ MUTATION M-chainFlag: drop the flag arm — this reds by name. */
  it("an edit whose accept flagged drift is not her — and neither is anything made from it", async () => {
    const flagged = await made({
      from: await upload(),
      ops: ["RECOLOR"],
      check: "flag",
    });
    expect(await standing(flagged)).toBe(false);
    const after = await made({ from: flagged, ops: ["CHANGE_BACKGROUND"] });
    expect(await standing(after)).toBe(false);
  });

  /** ⚠️ MUTATION M-chainReface: drop the refacing arm — this reds by name. */
  it("a camera or relight edit with no passed check is not her; with a passed check it is", async () => {
    for (const op of ["CAMERA", "RELIGHT"]) {
      const unchecked = await made({ from: await upload(), ops: [op] });
      expect({ op, standing: await standing(unchecked) }).toEqual({
        op,
        standing: false,
      });
      const passed = await made({
        from: await upload(),
        ops: [op],
        check: "pass",
      });
      expect({ op, standing: await standing(passed) }).toEqual({
        op,
        standing: true,
      });
    }
    // …and an edit made FROM an unchecked camera edit inherits its break.
    const camera = await made({ from: await upload(), ops: ["CAMERA"] });
    expect(await standing(await made({ from: camera, ops: ["RECOLOR"] }))).toBe(
      false,
    );
  });
});

describe("a chain whose root is not her upload → today's rule", () => {
  it("a from-scratch generate with no person reference of her is not her; with one it is", async () => {
    expect(await standing(await made({ refs: [{ role: "product" }] }))).toBe(
      false,
    );
    expect(
      await standing(
        await made({ refs: [{ role: "product" }, { role: "person" }] }),
      ),
    ).toBe(true);
  });

  it("an edit of a from-scratch generate reads its OWN job, as today", async () => {
    const generated = await made({ refs: [{ role: "person" }] });
    expect(
      await standing(await made({ from: generated, ops: ["RECOLOR"] })),
    ).toBe(false);
  });

  it("a hop onto another athlete's row stops the walk — today's rule, never her standing", async () => {
    const theirs = await upload(someoneElse);
    expect(await standing(await made({ from: theirs, ops: ["RECOLOR"] }))).toBe(
      false,
    );
  });

  it("a cycle terminates at the cap and answers today's rule", async () => {
    const a = await made({ from: await upload(), ops: ["RECOLOR"] });
    const b = await made({ from: a, ops: ["RECOLOR"] });
    await db
      .update(mediaAssets)
      .set({ derived_from_asset_id: b } as never)
      .where(eq(mediaAssets.id, a));
    expect(await standing(b)).toBe(false);
  });

  it("a row with no generating job is NULL, as today", async () => {
    expect(await standing(await upload())).toBeNull();
  });
});

describe("with STUDIO_LIBRARY_FIELDS off, today's rule — main's SQL, byte for byte", () => {
  it("the flag-off expressions are main's text", () => {
    expect(jobIdentityBoundOf("gj.brief")).toBe(
      `coalesce(gj.brief -> 'job' -> 'references', '[]'::jsonb) @> '[{"role":"person"}]'::jsonb`,
    );
    expect(identityBoundSql(false)).toBe(IDENTITY_BOUND_SQL);
    expect(IDENTITY_BOUND_SQL)
      .toBe(`CASE WHEN media_assets.generation_job_id IS NULL THEN NULL ELSE (
  SELECT coalesce(gj.brief -> 'job' -> 'references', '[]'::jsonb) @> '[{"role":"person"}]'::jsonb
    FROM generation_jobs gj
   WHERE gj.id = media_assets.generation_job_id AND gj.athlete_id = media_assets.athlete_id) END`);
    expect(PHOTO_RANK_SQL).toContain(`(${IDENTITY_BOUND_SQL}) = false`);
    expect(identityBoundSql(true)).toBe(CHAIN_IDENTITY_BOUND_SQL);
  });
});
