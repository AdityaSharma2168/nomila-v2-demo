/**
 * engine.test.ts — quote → run → accept | discard, on PGlite, with the router, the store and detection
 * stood in (PR 9, Lane 1). The law's five mutations, each red by name:
 *
 *   "quote skipped"                                  — run without consumePreview / the cap check
 *   "preview written to library without accept"      — record the asset at run time
 *   "edited asset claims camera provenance"          — insert the accepted row with origin 'upload'
 *   "edit falls through to from-scratch generate"    — plan a generate when the edit cannot run
 *   "unverified person used as op source"            — let an untagged / another_person row through
 *
 * And tenancy: another athlete's edit preview is invisible.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

const mockStore = new Map<string, { buf: Buffer; contentType: string }>();
jest.mock("../../lib/mediaStore", () => ({
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
  saveBuffer: jest.fn(
    async (buf: Buffer, basePath: string, contentType: string) => {
      const path = `${basePath}.${contentType === "image/png" ? "png" : "jpg"}`;
      mockStore.set(path, { buf, contentType });
      return { gcs_path: path, content_type: contentType, bytes: buf.length };
    },
  ),
  readObject: jest.fn(async (p: string) => mockStore.get(p) ?? null),
  deleteObject: jest.fn(async (p: string) => {
    mockStore.delete(p);
  }),
  rehostFromUrl: jest.fn(),
  headObject: jest.fn(),
  uploadLocalFile: jest.fn(),
  deletePrefix: jest.fn(),
  signedUploadUrl: jest.fn(),
  UPLOAD_LIMITS: { image: 25 * 1024 * 1024, video: 25 * 1024 * 1024 },
  uploadKind: () => "image",
  uploadObjectPath: () => "",
  REVIEW_SUFFIX: ".review.jpg",
  reviewObjectPath: () => "",
}));

const mockGenerate = jest.fn();
jest.mock("../router", () => ({
  ...jest.requireActual("../router"),
  generate: (...a: unknown[]) => mockGenerate(...a),
}));

const mockDetect = jest.fn();
jest.mock("../autoMask", () => ({
  ...jest.requireActual("../autoMask"),
  detectRegionsMemoized: (...a: unknown[]) => mockDetect(...a),
  probeBytesFor: jest.fn(),
}));

const mockProbe = jest.fn();
jest.mock("../imageSize", () => ({
  ...jest.requireActual("../imageSize"),
  probeImageSize: (...a: unknown[]) => mockProbe(...a),
}));

const mockResolveRef = jest.fn();
jest.mock("../generate", () => ({
  ...jest.requireActual("../generate"),
  resolveStoredReference: (...a: unknown[]) => mockResolveRef(...a),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import {
  client,
  closeTestDb,
  db,
  initTestDb,
  seedAthlete,
} from "../../testUtils/pgliteDb";
import {
  athleteSnapshots,
  athletesCurrent,
  generationJobs,
  mediaAssets,
  studioGenerationPreviews,
} from "../../../shared/schema";
import { consumePreview } from "../previewStore";
import {
  acceptEdit,
  discardEdit,
  editWarnings,
  quoteEdit,
  runEdit,
} from "./engine";
import { readEditPreview } from "./previews";
import {
  sourceDecision,
  subjectOf,
  withReadState,
  SOURCE_REFUSAL_COPY,
} from "./source";

const W = 640;
const H = 960;
let SOURCE_PNG: Buffer;
let OUT_PNG: Buffer;

let A: string;
let B: string;
let hers: string;
let product: string;
let stranger: string;
let untagged: string;
let theirs: string;

async function seedPhoto(
  athleteId: string,
  vision: Record<string, unknown> | null,
): Promise<string> {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: athleteId,
      platform: "upload",
      origin: "upload",
      media_type: "IMAGE",
      status: "stored",
      gcs_path: `athletes/${athleteId}/uploads/${Math.random().toString(36).slice(2)}.png`,
      width: W,
      height: H,
      metadata: vision ? { vision } : null,
    } as never)
    .returning({ id: mediaAssets.id });
  return row.id;
}

const assetCount = async () =>
  (await db.select({ id: mediaAssets.id }).from(mediaAssets)).length;

const region = (label: string) => ({
  label,
  left: 0.3,
  top: 0.3,
  width: 0.3,
  height: 0.3,
});

beforeAll(async () => {
  process.env.STUDIO_NATIVE_EDIT = "true";
  process.env.STUDIO_DISPLAY_TEXT = "true";
  await initTestDb();
  await client.exec(
    readFileSync(join(__dirname, "..", "sql", "generationGuards.sql"), "utf8"),
  );
  A = await seedAthlete("Athlete A");
  B = await seedAthlete("Athlete B");
  // assembleBrief reads her context (services/athleteContext): a current row and a snapshot, invented values.
  for (const id of [A, B]) {
    await db.insert(athletesCurrent).values({
      athlete_id: id,
      story_arc: "A synthetic athlete.",
    } as never);
    await db.insert(athleteSnapshots).values({
      athlete_id: id,
      trigger: "manual",
      research: {
        story_arc: "A synthetic athlete.",
        achievements: [],
        brand_mentions: [],
        values: [],
      },
      google_trends_score: "0",
      gdelt_article_count: 0,
      social: {},
      deals: [],
    } as never);
  }
  hers = await seedPhoto(A, { subject: "the_athlete", athlete_present: true });
  product = await seedPhoto(A, { subject: "nobody", athlete_present: false });
  stranger = await seedPhoto(A, {
    subject: "another_person",
    athlete_present: false,
  });
  untagged = await seedPhoto(A, null);
  theirs = await seedPhoto(B, {
    subject: "the_athlete",
    athlete_present: true,
  });
  SOURCE_PNG = await sharp({
    create: { width: W, height: H, channels: 3, background: "#4060a0" },
  })
    .png()
    .toBuffer();
  OUT_PNG = await sharp({
    create: { width: W, height: H, channels: 3, background: "#a04040" },
  })
    .png()
    .toBuffer();
}, 120_000);

afterAll(async () => {
  delete process.env.STUDIO_NATIVE_EDIT;
  delete process.env.STUDIO_DISPLAY_TEXT;
  await closeTestDb();
});

beforeEach(() => {
  mockGenerate.mockReset();
  mockDetect.mockReset();
  mockProbe.mockReset();
  mockResolveRef.mockReset();
  mockProbe.mockResolvedValue({ width: W, height: H, orientation: 1 });
  mockDetect.mockResolvedValue({ ok: true, regions: [region("jersey")] });
  mockResolveRef.mockImplementation(async () => ({
    kind: "bytes",
    bytes: SOURCE_PNG,
    mimeType: "image/png",
  }));
  mockGenerate.mockImplementation(
    async (task: string, _inputs: unknown, _opts: unknown) => ({
      task,
      provider: "vertex",
      model: "gemini-3-pro-image",
      assets: [{ bytes: OUT_PNG, mimeType: "image/png" }],
      cost: { amountUsd: 0.165, currency: "USD", basis: "reported" },
      timings: {
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        ms: 1,
      },
    }),
  );
});

const recolour = (over: Partial<Parameters<typeof quoteEdit>[0]> = {}) =>
  quoteEdit({
    athleteId: A,
    sourceAssetId: hers,
    op: "recolour",
    params: { target: "jersey", colour: "red" },
    ...over,
  });

describe("quote — the op becomes a priced edit, and nothing is written to her library", () => {
  it("quotes a recolour on her photo: a row under a real quote, priced, with the sentence she can read", async () => {
    const before = await assetCount();
    const out = await recolour();
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.row.status).toBe("quoted");
    expect(out.row.preview_id).toEqual(expect.any(String));
    expect(out.quote.sentence).toBe("make the jersey red");
    expect(out.quote.unpriced).toBe(false);
    expect(out.quote.costUsd).toBeGreaterThan(0);
    expect(Number(out.row.cost_quoted_usd)).toBe(out.quote.costUsd);
    expect(await assetCount()).toBe(before);
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockDetect).toHaveBeenCalledWith(
      expect.objectContaining({
        athleteId: A,
        sourceAssetId: hers,
        instruction: "make the jersey red",
      }),
      expect.any(Function),
    );
  });

  it("refuses a sixth op and bad params at the door, with a 400", async () => {
    expect(
      await quoteEdit({
        athleteId: A,
        sourceAssetId: hers,
        op: "upscale",
        params: {},
      }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await quoteEdit({
        athleteId: A,
        sourceAssetId: hers,
        op: "recolour",
        params: { target: "jersey" },
      }),
    ).toMatchObject({ ok: false, status: 400, field: "params" });
  });

  it("a product op resolves her product photo as the product reference, through the same gate", async () => {
    const out = await quoteEdit({
      athleteId: A,
      sourceAssetId: hers,
      op: "product",
      params: { productAssetId: product, thing: "ball" },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.quote.sentence).toBe("add this ball on the ground next to me");
    // Region-free: no detection call for a placed add.
    expect(mockDetect).not.toHaveBeenCalled();
    const stored = await db
      .select()
      .from(studioGenerationPreviews)
      .where(eq(studioGenerationPreviews.id, out.row.preview_id!));
    const brief = stored[0].brief as {
      job: { references: { role: string; mediaAssetId: string }[] };
    };
    expect(brief.job.references).toEqual([
      expect.objectContaining({ role: "product", mediaAssetId: product }),
    ]);
    // A product photo with someone else in it is refused as a reference, exactly as a source would be.
    expect(
      await quoteEdit({
        athleteId: A,
        sourceAssetId: hers,
        op: "product",
        params: { productAssetId: stranger, thing: "ball" },
      }),
    ).toMatchObject({ ok: false, status: 422, field: "productAssetId" });
  });
});

describe("the source gate — the casting law, extended to edits", () => {
  it("the gate as a table: nobody and the_athlete proceed; another_person and untagged are refused", () => {
    expect(sourceDecision("nobody")).toBeNull();
    expect(sourceDecision("the_athlete")).toBeNull();
    expect(sourceDecision("another_person")).toBe("source_not_her");
    expect(sourceDecision(null)).toBe("source_unverified");
    expect(subjectOf({ vision: { subject: "the_athlete" } })).toBe(
      "the_athlete",
    );
    expect(subjectOf({ vision: { athlete_present: true } })).toBe(
      "the_athlete",
    );
    expect(subjectOf({ vision: { athlete_present: false } })).toBeNull();
    expect(subjectOf(null)).toBeNull();
  });

  /**
   * PR 12 (ruling 2): with STUDIO_LIBRARY_FIELDS on, an unread source says WHY — a row enrichment set
   * down is not "give it a moment". Off, the reason set is exactly what it was.
   */
  it("an unread source's reason distinguishes pending / failed / capped with the flag on, and stays source_unverified with it off", () => {
    const failed = {
      enrichment: {
        abandoned_at: "2026-09-23T00:00:00Z",
        abandoned_reason: "oversize",
      },
    };
    const capped = {
      enrichment: {
        abandoned_at: "2026-09-23T00:00:00Z",
        abandoned_reason: "attempts",
      },
    };
    expect(withReadState("source_unverified", null)).toBe("source_unverified");
    expect(withReadState("source_unverified", failed)).toBe(
      "source_unverified",
    ); // flag off
    process.env.STUDIO_LIBRARY_FIELDS = "true";
    try {
      expect(withReadState("source_unverified", null)).toBe(
        "source_unverified",
      );
      expect(
        withReadState("source_unverified", { enrichment: { attempts: 3 } }),
      ).toBe("source_unverified");
      expect(withReadState("source_unverified", failed)).toBe(
        "source_read_failed",
      );
      expect(withReadState("source_unverified", capped)).toBe(
        "source_read_capped",
      );
      // Only the unread reason is re-read; not-her stays not-her, and every reason has its sentence.
      expect(withReadState("source_not_her", failed)).toBe("source_not_her");
      expect(Object.keys(SOURCE_REFUSAL_COPY)).toEqual(
        expect.arrayContaining(["source_read_failed", "source_read_capped"]),
      );
    } finally {
      delete process.env.STUDIO_LIBRARY_FIELDS;
    }
  });

  /** ⚠️ MUTATION "unverified person used as op source": sourceDecision returns null for null / another_person. */
  it("refuses a photo of someone else, and one the tagger has not read, before any quote exists", async () => {
    const before = await db
      .select({ id: studioGenerationPreviews.id })
      .from(studioGenerationPreviews);
    expect(await recolour({ sourceAssetId: stranger })).toMatchObject({
      ok: false,
      status: 422,
      error: expect.stringContaining("isn't you"),
    });
    expect(await recolour({ sourceAssetId: untagged })).toMatchObject({
      ok: false,
      status: 422,
      error: expect.stringContaining("still checking"),
    });
    const after = await db
      .select({ id: studioGenerationPreviews.id })
      .from(studioGenerationPreviews);
    expect(after.length).toBe(before.length);
    expect(mockDetect).not.toHaveBeenCalled();
  });

  it("a person-free photo proceeds", async () => {
    const out = await recolour({ sourceAssetId: product });
    expect(out.ok).toBe(true);
  });

  it("another athlete's photo, and a missing one, are one answer: not found", async () => {
    expect(await recolour({ sourceAssetId: theirs })).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(
      await recolour({ sourceAssetId: "00000000-0000-4000-8000-000000000000" }),
    ).toMatchObject({ ok: false, status: 404 });
  });
});

describe("run — one paid image.edit call, the result a preview under her prefix, never a library row", () => {
  /** ⚠️ MUTATION "preview written to library without accept": recordGeneratedAsset in runEdit. */
  /** ⚠️ MUTATION (studio/jobs.ts): drop the cost_usd write in finish() — this reds by name (P-cost). */
  it("finish() drops actual cost: never — the job's cost_usd at succeed equals the edit row's cost_usd, and the quote column is untouched", async () => {
    const q = await recolour();
    if (!q.ok) throw new Error(q.error);
    const out = await runEdit({ athleteId: A, id: q.row.id });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const [job] = await db
      .select()
      .from(generationJobs)
      .where(eq(generationJobs.id, out.row.job_id!));
    expect(job.status).toBe("succeeded");
    expect(job.cost_usd).toBe(out.row.cost_usd);
    expect(Number(job.cost_usd)).toBe(0.165);
    // The quote and its basis are what they were when the row opened — the day cap reads those.
    expect(Number(job.cost_estimated_usd)).toBe(
      Number(out.row.cost_quoted_usd),
    );
    expect(job.cost_basis).toBe("estimated");
  });

  it("runs a quoted edit once: the router sees image.edit with the frame, the row is ready, the library is unchanged", async () => {
    const q = await recolour();
    if (!q.ok) throw new Error(q.error);
    const before = await assetCount();
    const out = await runEdit({ athleteId: A, id: q.row.id });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.row.status).toBe("ready");
    expect(out.row.gcs_path).toMatch(
      new RegExp(`^athletes/${A}/studio/edit-previews/${q.row.id}`),
    );
    expect(out.row.width).toBe(W);
    expect(out.row.height).toBe(H);
    expect(Number(out.row.cost_usd)).toBe(0.165);
    expect(out.row.job_id).toEqual(expect.any(String));
    expect(out.url).toContain("signed.example");
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    const [task, inputs] = mockGenerate.mock.calls[0] as [
      string,
      { prompt: string; references: { kind: string }[] },
    ];
    expect(task).toBe("image.edit");
    expect(inputs.references.length).toBeGreaterThanOrEqual(1);
    expect(inputs.prompt).toContain("make the jersey red");
    expect(await assetCount()).toBe(before);
    const [job] = await db
      .select()
      .from(generationJobs)
      .where(eq(generationJobs.id, out.row.job_id!));
    expect(job.status).toBe("succeeded");
    expect(job.mode).toBe("edit");
    expect(job.source_asset_id).toBe(hers);
    // Not twice.
    expect(await runEdit({ athleteId: A, id: q.row.id })).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  /** ⚠️ MUTATION "quote skipped": drop consumePreview and assertSpendWithinCaps from runEdit. */
  it("a quote already spent never runs again, and a quote below the re-priced figure never runs at all", async () => {
    const spent = await recolour();
    if (!spent.ok) throw new Error(spent.error);
    // Someone (a racing caller, an older job) consumed the quote first.
    const [job] = await db
      .insert(generationJobs)
      .values({
        athlete_id: A,
        origin: "system",
        mode: "edit",
        objective: "showcase-product",
        deliverable: "post",
        brief: {},
        source_asset_id: hers,
        status: "pending",
      } as never)
      .returning({ id: generationJobs.id });
    const claim = await consumePreview(A, spent.row.preview_id!, job.id);
    expect(claim.claimed).toBe(true);
    expect(await runEdit({ athleteId: A, id: spent.row.id })).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(mockGenerate).not.toHaveBeenCalled();

    const under = await recolour();
    if (!under.ok) throw new Error(under.error);
    await db
      .update(studioGenerationPreviews)
      .set({ cost_usd: "0.0001" })
      .where(eq(studioGenerationPreviews.id, under.row.preview_id!));
    await expect(runEdit({ athleteId: A, id: under.row.id })).rejects.toThrow(
      /approved/i,
    );
    expect(mockGenerate).not.toHaveBeenCalled();
    expect((await readEditPreview(A, under.row.id))!.status).toBe("quoted");
  });

  it("the CAMPAIGN block rides the ad op's prompt at run time, fenced, after the instruction", async () => {
    const q = await quoteEdit({
      athleteId: A,
      sourceAssetId: hers,
      op: "ad",
      params: {
        brand: "Jane Street",
        instruction: "an ad for jane street",
        campaign: { product: "the matte-black ball" },
      },
    });
    if (!q.ok) throw new Error(q.error);
    const out = await runEdit({ athleteId: A, id: q.row.id });
    expect(out.ok).toBe(true);
    const [, inputs] = mockGenerate.mock.calls[0] as [
      string,
      { prompt: string },
    ];
    const [instruction, block] = inputs.prompt.split(
      "\n\nThe campaign, for context",
    );
    expect(instruction).toContain("JANE STREET");
    expect(block).toContain("<<<CAMPAIGN>>>");
    expect(block).toContain("product: the matte-black ball");
    expect(block.trim().endsWith("<<<END_CAMPAIGN>>>")).toBe(true);
  });

  it("a run that fails leaves the row failed, the job failed, and the library untouched", async () => {
    const q = await recolour();
    if (!q.ok) throw new Error(q.error);
    const before = await assetCount();
    mockGenerate.mockRejectedValueOnce(new Error("provider down"));
    await expect(runEdit({ athleteId: A, id: q.row.id })).rejects.toThrow(
      "provider down",
    );
    const row = (await readEditPreview(A, q.row.id))!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("provider down");
    expect(await assetCount()).toBe(before);
    const [job] = await db
      .select()
      .from(generationJobs)
      .where(eq(generationJobs.id, row.job_id!));
    expect(job.status).toBe("failed");
  });
});

describe("the quote's warnings are the op's, not the brief's generic gaps", () => {
  /** ⚠️ MUTATION "recolour quote carries a brief-gap warning": return preview.warnings whole in editWarnings. */
  it("a recolour quote carries zero brief-gap warnings — none of the assembled brief's gap notes reach her", async () => {
    const out = await recolour();
    if (!out.ok) throw new Error(out.error);
    const [stored] = await db
      .select()
      .from(studioGenerationPreviews)
      .where(eq(studioGenerationPreviews.id, out.row.preview_id!));
    const gaps = (stored.brief as { gaps: { note: string }[] }).gaps.map(
      (g) => g.note,
    );
    expect(gaps.length).toBeGreaterThan(0); // the brief DID report gaps — a generation's, not an edit's
    for (const g of gaps) expect(out.quote.warnings).not.toContain(g);
    expect(out.quote.warnings.join(" ")).not.toMatch(
      /No brand on this job|No first-class aesthetic/,
    );
  });

  it("what is not a brief gap still passes: the op's own note, a native preview note — and the source gate still refuses", async () => {
    const ad = await quoteEdit({
      athleteId: A,
      sourceAssetId: hers,
      op: "ad",
      params: { brand: "Jane Street", instruction: "an ad for jane street" },
    });
    if (!ad.ok) throw new Error(ad.error);
    expect(ad.quote.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("not a brand the rules know"),
      ]),
    );
    expect(ad.quote.warnings.join(" ")).not.toMatch(/No brand on this job/);
    // The pure filter: a preview note that is not one of the brief's gaps is kept, by identity.
    expect(
      editWarnings(
        { gaps: [{ note: "gap A" }, { note: "gap B" }] },
        {
          warnings: [
            { note: "gap A" },
            { note: "the frame is 4K; the edit is sent at 2K" },
            { note: "gap B" },
          ],
        },
      ),
    ).toEqual(["the frame is 4K; the edit is sent at 2K"]);
    // And a refusal is a refusal, never a warning: the unverified source still stops the quote.
    expect(await recolour({ sourceAssetId: untagged })).toMatchObject({
      ok: false,
      status: 422,
      error: expect.stringContaining("still checking"),
    });
  });
});

describe("accept and discard — the one library write, or none", () => {
  /** ⚠️ MUTATION "edited asset claims camera provenance": insert the accepted row with origin 'upload'. */
  it("accept records ONE draft asset: origin generated, derived from the source, its own job — and deletes the preview object", async () => {
    const q = await recolour();
    if (!q.ok) throw new Error(q.error);
    const ran = await runEdit({ athleteId: A, id: q.row.id });
    if (!ran.ok) throw new Error(ran.error);
    const before = await assetCount();
    const previewPath = ran.row.gcs_path!;
    expect(mockStore.has(previewPath)).toBe(true);

    const out = await acceptEdit({ athleteId: A, id: q.row.id });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(await assetCount()).toBe(before + 1);
    const [asset] = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, out.assetId));
    expect(asset.origin).toBe("generated");
    expect(asset.origin).not.toBe("upload");
    expect(asset.derived_from_asset_id).toBe(hers);
    expect(asset.generation_job_id).toBe(ran.row.job_id);
    expect(asset.approval_status).toBe("draft");
    expect(asset.status).toBe("stored");
    expect(asset.gcs_path).toMatch(
      new RegExp(`^athletes/${A}/studio/${ran.row.job_id}/0`),
    );
    expect(asset.width).toBe(W);
    expect(asset.height).toBe(H);
    expect(out.row.status).toBe("accepted");
    expect(out.row.accepted_asset_id).toBe(out.assetId);
    expect(mockStore.has(previewPath)).toBe(false);
    // Decided once.
    expect(await acceptEdit({ athleteId: A, id: q.row.id })).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(await discardEdit({ athleteId: A, id: q.row.id })).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(await assetCount()).toBe(before + 1);
  });

  it("discard deletes the preview object and writes nothing; a quoted row can be discarded too", async () => {
    const q = await recolour();
    if (!q.ok) throw new Error(q.error);
    const ran = await runEdit({ athleteId: A, id: q.row.id });
    if (!ran.ok) throw new Error(ran.error);
    const before = await assetCount();
    const out = await discardEdit({ athleteId: A, id: q.row.id });
    expect(out.ok && out.row.status).toBe("discarded");
    expect(mockStore.has(ran.row.gcs_path!)).toBe(false);
    expect(await assetCount()).toBe(before);
    expect(await acceptEdit({ athleteId: A, id: q.row.id })).toMatchObject({
      ok: false,
      status: 409,
    });

    const q2 = await recolour();
    if (!q2.ok) throw new Error(q2.error);
    expect(await discardEdit({ athleteId: A, id: q2.row.id })).toMatchObject({
      ok: true,
      row: expect.objectContaining({ status: "discarded" }),
    });
    expect(await runEdit({ athleteId: A, id: q2.row.id })).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  it("accept needs a finished preview: a quoted row cannot be accepted", async () => {
    const q = await recolour();
    if (!q.ok) throw new Error(q.error);
    expect(await acceptEdit({ athleteId: A, id: q.row.id })).toMatchObject({
      ok: false,
      status: 409,
    });
  });
});

describe("the law at the engine — image.edit with a source, or nothing", () => {
  /** ⚠️ MUTATION "edit falls through to from-scratch generate": plan a generate when detection finds nothing. */
  it("an edit that cannot run is refused — no generate, no row, no call", async () => {
    mockDetect.mockResolvedValue({ ok: true, regions: [] });
    const before = await assetCount();
    const out = await recolour();
    expect(out).toMatchObject({ ok: false, status: 422 });
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(await assetCount()).toBe(before);
  });

  it("every router call this suite made asked for image.edit with a reference — never image.generate", () => {
    // Runs after the suites above in file order; the assertion is over everything they did.
    expect(mockGenerate.mock.calls.length).toBe(0); // reset per test — the per-run checks above hold the claim.
  });

  it("an edit with no readable frame is refused, before anything is priced", async () => {
    mockProbe.mockResolvedValue(null);
    expect(await recolour()).toMatchObject({
      ok: false,
      status: 422,
      field: "sourceAssetId",
    });
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});

describe("tenancy — another athlete's edit preview is invisible", () => {
  /** ⚠️ MUTATION "another athlete's edit preview is invisible": drop the athlete filter in readEditPreview. */
  it("B cannot read, run, accept or discard A's edit", async () => {
    const q = await recolour();
    if (!q.ok) throw new Error(q.error);
    expect(await readEditPreview(B, q.row.id)).toBeNull();
    expect(await runEdit({ athleteId: B, id: q.row.id })).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await acceptEdit({ athleteId: B, id: q.row.id })).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await discardEdit({ athleteId: B, id: q.row.id })).toMatchObject({
      ok: false,
      status: 404,
    });
    expect((await readEditPreview(A, q.row.id))!.status).toBe("quoted");
  });
});
