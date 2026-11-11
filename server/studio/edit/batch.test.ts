/**
 * batch.test.ts — the ad carousel's batch on PGlite (PR 9, Lane 4), the router, the store, detection and the
 * reference resolver stood in. The ten mutations, each red by name:
 *
 *   "run starts without the itemized quote"       — queue a job without consuming its row's quote
 *   "candidate or stage count exceeds the quote"   — drop the four-candidate cap on reroll
 *   "a 4th reference accepted"                     — drop the MAX_REFS check
 *   "cleanup runs on a ref with no grounded rec"   — skip groundRecs in quoteBatch
 *   "unverified person reference reaches generation" — the source gate on a batch ref (engine.ts)
 *   "Create blocks the screen until completion"    — await the tick inside runBatch
 *   "intermediate persists as a library row"       — accept an intermediate (engine.ts acceptEdit)
 *   "downloaded frame loses derived_from"          — recordGeneratedAsset without derivedFromAssetId
 *   "download-all includes a discarded frame"      — accept discarded rows in acceptAllBatch
 *   "kick and tick both run the same job"          — drop the status predicate from claimEditJobs
 *   ("ad chip runs headless instead of opening this screen" is the client's — editPopoverLogic.test)
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
  studioEditPreviews,
  studioGenerationPreviews,
} from "../../../shared/schema";
import { claimVideoJobs } from "../videoJobs";
import { acceptEdit, discardEdit, presentEdit } from "./engine";
import {
  acceptAllBatch,
  batchView,
  claimEditJobs,
  editTick,
  quoteBatch,
  rerollBatch,
  runBatch,
  settingForVariation,
  sweepIntermediates,
  VARIATION_SETTINGS,
} from "./batch";
import { listEditPreviews, readEditPreview } from "./previews";
import type { Rec } from "./recommend";

const W = 640;
const H = 960;
let SOURCE_PNG: Buffer;
let OUT_PNG: Buffer;
let A: string;
let hers: string;
let hers2: string;
let product: string;
let stranger: string;

const LINES = [
  "No Nike marks on kit or ball.",
  "No competitor firms named or shown.",
];
const CLEANUP: Rec = {
  op: "recolour",
  params: { target: "logos", colour: "black" },
  because: "No Nike marks on kit or ball.",
  what: "Nike logos on the kit.",
};
const AD = {
  brand: "Jane Street",
  headline: "Without theatrics",
  setting: "stadium pitch at dusk",
  campaign: { story: "without theatrics" },
};

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
const rowsOf = async (batchId: string) =>
  db
    .select()
    .from(studioEditPreviews)
    .where(eq(studioEditPreviews.batch_id, batchId));
/** Empty the shared queue, so a tick test measures only its own batch (PGlite is one database for the file). */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) if ((await editTick(50)).claimed === 0) return;
}
const jobOf = async (id: string) =>
  (await db.select().from(generationJobs).where(eq(generationJobs.id, id)))[0];

beforeAll(async () => {
  process.env.STUDIO_NATIVE_EDIT = "true";
  process.env.STUDIO_DISPLAY_TEXT = "true";
  await initTestDb();
  await client.exec(
    readFileSync(join(__dirname, "..", "sql", "generationGuards.sql"), "utf8"),
  );
  A = await seedAthlete("Athlete A");
  await db.insert(athletesCurrent).values({
    athlete_id: A,
    story_arc: "A synthetic athlete.",
  } as never);
  await db.insert(athleteSnapshots).values({
    athlete_id: A,
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
  hers = await seedPhoto(A, { subject: "the_athlete", athlete_present: true });
  hers2 = await seedPhoto(A, { subject: "the_athlete", athlete_present: true });
  product = await seedPhoto(A, { subject: "nobody", athlete_present: false });
  stranger = await seedPhoto(A, {
    subject: "another_person",
    athlete_present: false,
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
  mockDetect.mockResolvedValue({
    ok: true,
    regions: [{ label: "logos", left: 0.3, top: 0.3, width: 0.3, height: 0.3 }],
  });
  mockResolveRef.mockImplementation(async (r: { ref: string }) => ({
    kind: "bytes",
    bytes: mockStore.get(r.ref)?.buf ?? SOURCE_PNG,
    mimeType: "image/png",
  }));
  mockGenerate.mockImplementation(async (task: string) => ({
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
  }));
});

const quoteOne = (over: Partial<Parameters<typeof quoteBatch>[0]> = {}) =>
  quoteBatch({
    athleteId: A,
    refs: [{ assetId: hers, variations: 3, cleanup: CLEANUP }],
    briefLines: LINES,
    ...AD,
    ...over,
  });

describe("the itemized quote — rows under one batch id, every one under its own quote, before anything runs", () => {
  it("1 ref × 3 with a grounded cleanup: 4 rows (1 A + 3 B), itemized lines, a total; nothing queued, nothing spent", async () => {
    const before = await assetCount();
    const q = await quoteOne();
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    const rows = await rowsOf(q.batchId);
    expect(rows).toHaveLength(4);
    expect(
      rows.every(
        (r) =>
          r.status === "quoted" && r.job_id === null && r.preview_id !== null,
      ),
    ).toBe(true);
    const a = rows.find(
      (r) => (r.params as { role?: string }).role === "intermediate",
    )!;
    const bs = rows.filter(
      (r) => (r.params as { stage?: string }).stage === "B",
    );
    expect(a.op).toBe("recolour");
    expect(bs).toHaveLength(3);
    expect(
      bs.every(
        (b) => (b.params as { after?: string }).after === a.id && b.op === "ad",
      ),
    ).toBe(true);
    expect(q.lines).toEqual([
      {
        assetId: hers,
        cleanup: { id: a.id, op: "recolour", costUsd: expect.any(Number) },
        ads: bs.map((b) => ({ id: b.id, costUsd: expect.any(Number) })),
      },
    ]);
    expect(q.totalUsd).toBeCloseTo(
      rows.reduce((s, r) => s + Number(r.cost_quoted_usd), 0),
      3,
    );
    expect(q.unpriced).toBe(false);
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(await assetCount()).toBe(before);
  });

  /** ⚠️ MUTATION "a 4th reference accepted": drop the MAX_REFS check in quoteBatch. */
  it("a 4th reference is refused, and so is a total over three, before any row exists", async () => {
    const ids = [hers, hers2, product, stranger].map((id, i) => ({
      assetId: id,
      variations: 1,
      cleanup: null,
    }));
    // The refs-count refusal by its own words — four photos also exceed the three-ad total, and the
    // total's refusal must not be what satisfies this test.
    expect(
      await quoteBatch({ athleteId: A, refs: ids, briefLines: LINES, ...AD }),
    ).toMatchObject({
      ok: false,
      status: 400,
      field: "refs",
      error: "Up to 3 photos — remove one.",
    });
    expect(
      await quoteBatch({
        athleteId: A,
        refs: [
          { assetId: hers, variations: 3, cleanup: null },
          { assetId: hers2, variations: 1, cleanup: null },
        ],
        briefLines: LINES,
        ...AD,
      }),
    ).toMatchObject({ ok: false, status: 400 });
    const stray = await db
      .select()
      .from(studioEditPreviews)
      .where(eq(studioEditPreviews.source_asset_id, stranger));
    expect(stray).toHaveLength(0);
  });

  /** ⚠️ MUTATION "cleanup runs on a ref with no grounded rec": skip groundRecs in quoteBatch. */
  it("a cleanup that does not re-ground against the brief lines is refused, and the half-made batch is discarded", async () => {
    const out = await quoteOne({
      refs: [
        {
          assetId: hers,
          variations: 2,
          cleanup: { ...CLEANUP, because: "No Nike anywhere." },
        },
      ],
    });
    expect(out).toMatchObject({ ok: false, status: 422 });
    const other = await quoteOne({
      refs: [
        { assetId: hers, variations: 1, cleanup: CLEANUP },
        {
          assetId: hers2,
          variations: 1,
          cleanup: { ...CLEANUP, because: "paraphrased" },
        },
      ],
    });
    expect(other).toMatchObject({ ok: false, status: 422 });
    // Nothing of that batch stays quoted.
    const quoted = await db
      .select()
      .from(studioEditPreviews)
      .where(eq(studioEditPreviews.status, "quoted"));
    expect(quoted.filter((r) => r.source_asset_id === hers2)).toHaveLength(0);
  });

  /** ⚠️ MUTATION "unverified person reference reaches generation": let another_person through the source gate. */
  it("a reference showing someone else is refused at the quote; a person-free product photo proceeds", async () => {
    expect(
      await quoteOne({
        refs: [{ assetId: stranger, variations: 1, cleanup: null }],
      }),
    ).toMatchObject({ ok: false, status: 422 });
    const ok = await quoteOne({
      refs: [{ assetId: product, variations: 1, cleanup: null }],
    });
    expect(ok.ok).toBe(true);
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});

describe("the three ads differ", () => {
  it("each variation takes its own setting — hers first when given, then settings she did not give; a quote's B rows carry three different ones", async () => {
    expect(settingForVariation("stadium pitch at dusk", 0)).toBe(
      "stadium pitch at dusk",
    );
    expect(settingForVariation("stadium pitch at dusk", 1)).not.toBe(
      "stadium pitch at dusk",
    );
    expect(
      new Set(
        [0, 1, 2].map((i) => settingForVariation("stadium pitch at dusk", i)),
      ).size,
    ).toBe(3);
    expect(
      new Set([0, 1, 2].map((i) => settingForVariation(null, i))).size,
    ).toBe(3);
    expect(settingForVariation("my own place", 0)).toBe("my own place");
    for (const v of VARIATION_SETTINGS)
      expect(v.length).toBeLessThanOrEqual(40);
    const q = await quoteOne({
      refs: [{ assetId: hers2, variations: 3, cleanup: null }],
      setting: "stadium pitch at dusk",
    });
    if (!q.ok) throw new Error(q.error);
    const bs = (await rowsOf(q.batchId)).filter(
      (r) => (r.params as { stage?: string }).stage === "B",
    );
    const settings = bs.map((b) => (b.params as { setting?: string }).setting);
    expect(new Set(settings).size).toBe(3);
    expect(settings).toContain("stadium pitch at dusk");
  });
});

describe("Create — quotes consumed, jobs queued, the screen free", () => {
  /** ⚠️ MUTATION "run starts without the itemized quote": queueJob without consumePreview in runBatch. */
  it("consumes every row's quote and queues an edit job per row; rows keep their status until the tick", async () => {
    const q = await quoteOne();
    if (!q.ok) throw new Error(q.error);
    const out = await runBatch({
      athleteId: A,
      batchId: q.batchId,
      kick: false,
    });
    expect(out).toEqual({ ok: true, queued: 4 });
    const rows = await rowsOf(q.batchId);
    for (const r of rows) {
      expect(r.status).toBe("quoted");
      expect(r.job_id).toEqual(expect.any(String));
      const job = await jobOf(r.job_id!);
      expect(job.status).toBe("queued");
      expect(job.mode).toBe("edit");
      const [pv] = await db
        .select()
        .from(studioGenerationPreviews)
        .where(eq(studioGenerationPreviews.id, r.preview_id!));
      expect(pv.consumed_by_job_id).toBe(r.job_id);
    }
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(
      await runBatch({ athleteId: A, batchId: q.batchId, kick: false }),
    ).toMatchObject({ ok: false, status: 409 });
    await drain();
  });

  /** ⚠️ MUTATION "Create blocks the screen until completion": await editTick() inside runBatch. */
  it("returns before any model call finishes — the kick runs after, not inside", async () => {
    await drain();
    const q = await quoteOne({
      refs: [{ assetId: hers2, variations: 1, cleanup: null }],
    });
    if (!q.ok) throw new Error(q.error);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockGenerate.mockImplementation(async (task: string) => {
      await gate;
      return {
        task,
        provider: "vertex",
        model: "m",
        assets: [{ bytes: OUT_PNG, mimeType: "image/png" }],
        cost: { amountUsd: 0.165, currency: "USD", basis: "reported" },
        timings: { startedAt: "", completedAt: "", ms: 1 },
      };
    });
    const started = Date.now();
    const out = await Promise.race([
      runBatch({ athleteId: A, batchId: q.batchId }),
      new Promise<"blocked">((r) => setTimeout(() => r("blocked"), 3000)),
    ]);
    expect(out).toEqual({ ok: true, queued: 1 });
    expect(Date.now() - started).toBeLessThan(3000);
    release();
    // Let the kicked tick finish before the next test touches the tables.
    await new Promise((r) => setTimeout(r, 300));
    for (
      let i = 0;
      i < 100 && (await rowsOf(q.batchId))[0].status !== "ready";
      i++
    )
      await new Promise((r) => setTimeout(r, 100));
    expect((await rowsOf(q.batchId))[0].status).toBe("ready");
  });
});

describe("the tick — one owner per job, A before B, the intermediate never kept", () => {
  it("runs A, then the three B rows on A's object as the frame; B rows record the chain and keep the ORIGINAL as their source", async () => {
    await drain();
    const q = await quoteOne();
    if (!q.ok) throw new Error(q.error);
    await runBatch({ athleteId: A, batchId: q.batchId, kick: false });
    const before = await assetCount();
    const tally = await editTick(10);
    expect(tally).toMatchObject({
      claimed: 4,
      succeeded: 4,
      failed: 0,
      deferred: 0,
    });
    const rows = await rowsOf(q.batchId);
    const a = rows.find(
      (r) => (r.params as { role?: string }).role === "intermediate",
    )!;
    const bs = rows.filter(
      (r) => (r.params as { stage?: string }).stage === "B",
    );
    expect(a.status).toBe("ready");
    expect(bs.every((b) => b.status === "ready")).toBe(true);
    expect(bs.every((b) => b.source_asset_id === hers)).toBe(true);
    expect(
      bs.every(
        (b) =>
          (b.params as { chain?: { cleanup?: string } }).chain?.cleanup ===
          a.id,
      ),
    ).toBe(true);
    // The B calls read A's object as the frame.
    const framesRead = mockResolveRef.mock.calls.map(
      (c) => (c[0] as { ref: string }).ref,
    );
    expect(framesRead.filter((ref) => ref === a.gcs_path)).toHaveLength(3);
    expect(mockGenerate).toHaveBeenCalledTimes(4);
    expect(mockGenerate.mock.calls.every((c) => c[0] === "image.edit")).toBe(
      true,
    );
    expect(await assetCount()).toBe(before);
    // A second tick finds nothing.
    expect(await editTick(10)).toMatchObject({ claimed: 0 });
  });

  /** ⚠️ MUTATION "kick and tick both run the same job": drop `status = 'queued'` from claimEditJobs. */
  it("two claims over the same queued jobs: the first takes them, the second takes none; the video tick takes none of them", async () => {
    await drain();
    const q = await quoteOne({
      refs: [{ assetId: hers2, variations: 2, cleanup: null }],
    });
    if (!q.ok) throw new Error(q.error);
    await runBatch({ athleteId: A, batchId: q.batchId, kick: false });
    expect(await claimVideoJobs(10, "video-instance")).toEqual([]);
    const first = await claimEditJobs(10, "kick");
    expect(first).toHaveLength(2);
    expect(await claimEditJobs(10, "tick")).toEqual([]);
    expect(await claimVideoJobs(10, "video-instance")).toEqual([]);
    // Put them back so later tests see a clean queue.
    for (const j of first)
      await db
        .update(generationJobs)
        .set({ status: "queued", lease_until: null, lease_holder: null })
        .where(eq(generationJobs.id, j.id));
    await editTick(10);
  });

  it("a B row waits for its A: claimed alone, it is deferred, and runs once A is ready", async () => {
    await drain();
    const q = await quoteOne({
      refs: [{ assetId: hers2, variations: 1, cleanup: CLEANUP }],
    });
    if (!q.ok) throw new Error(q.error);
    await runBatch({ athleteId: A, batchId: q.batchId, kick: false });
    const rows = await rowsOf(q.batchId);
    const a = rows.find(
      (r) => (r.params as { role?: string }).role === "intermediate",
    )!;
    const b = rows.find((r) => (r.params as { stage?: string }).stage === "B")!;
    // Claim B alone (A is younger in this seeding order? no — A was quoted first; claim by id instead).
    await db
      .update(generationJobs)
      .set({
        status: "running",
        lease_holder: "elsewhere",
        lease_until: new Date(Date.now() + 60_000),
      })
      .where(eq(generationJobs.id, a.job_id!));
    expect(await editTick(10)).toMatchObject({
      claimed: 1,
      deferred: 1,
      succeeded: 0,
    });
    expect((await readEditPreview(A, b.id))!.status).toBe("quoted");
    expect((await jobOf(b.job_id!)).status).toBe("queued");
    // Release A, run everything.
    await db
      .update(generationJobs)
      .set({ status: "queued", lease_holder: null, lease_until: null })
      .where(eq(generationJobs.id, a.job_id!));
    expect(await editTick(10)).toMatchObject({ succeeded: 2 });
    expect((await readEditPreview(A, b.id))!.status).toBe("ready");
  });

  /** ⚠️ MUTATION "intermediate persists as a library row": accept an intermediate in acceptEdit. */
  it("an intermediate can never be accepted, alone or by accept-all; it is swept once its B rows are decided", async () => {
    await drain();
    const q = await quoteOne({
      refs: [{ assetId: hers2, variations: 2, cleanup: CLEANUP }],
    });
    if (!q.ok) throw new Error(q.error);
    await runBatch({ athleteId: A, batchId: q.batchId, kick: false });
    await editTick(10);
    const rows = await rowsOf(q.batchId);
    const a = rows.find(
      (r) => (r.params as { role?: string }).role === "intermediate",
    )!;
    const before = await assetCount();
    expect(await acceptEdit({ athleteId: A, id: a.id })).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(await assetCount()).toBe(before);
    expect(mockStore.has(a.gcs_path!)).toBe(true);
    const all = await acceptAllBatch({ athleteId: A, batchId: q.batchId });
    expect(all).toMatchObject({ ok: true, skipped: 0 });
    if (!all.ok) return;
    expect(all.assetIds).toHaveLength(2);
    expect(await assetCount()).toBe(before + 2);
    // Every B decided → A swept: discarded, object gone, never a library row.
    const aAfter = (await readEditPreview(A, a.id))!;
    expect(aAfter.status).toBe("discarded");
    expect(mockStore.has(a.gcs_path!)).toBe(false);
    for (const id of all.assetIds) {
      const [asset] = await db
        .select()
        .from(mediaAssets)
        .where(eq(mediaAssets.id, id));
      expect(asset.origin).toBe("generated");
      expect(asset.derived_from_asset_id).toBe(hers2);
    }
  });
});

describe("expiry (PR 10, R-7 / AUDIT2 F3)", () => {
  /** ⚠️ MUTATION "an expired ready row shows under Now": drop the `gt` predicate in listEditPreviews, or sign on status alone in presentEdit. */
  it("an expired ready row shows under Now: never — it is gone from every list, the batch view and accept-all, and presentEdit signs nothing for it", async () => {
    await drain();
    const q = await quoteOne();
    if (!q.ok) throw new Error(q.error);
    await runBatch({ athleteId: A, batchId: q.batchId, kick: false });
    await editTick(10);
    const ready = (await rowsOf(q.batchId)).filter((r) => r.status === "ready" && (r.params as { stage?: string }).stage === "B");
    expect(ready.length).toBeGreaterThanOrEqual(2);
    const gone = ready[0];
    await db
      .update(studioEditPreviews)
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where(eq(studioEditPreviews.id, gone.id));
    const listed = await listEditPreviews(A, { batchId: q.batchId });
    expect(listed.map((r) => r.id)).not.toContain(gone.id);
    expect(listed.length).toBe((await rowsOf(q.batchId)).length - 1);
    const view = await batchView(A, q.batchId);
    expect(view.candidates.map((c) => c.id)).not.toContain(gone.id);
    expect(view.candidates.length).toBe(ready.length - 1);
    // The row itself, presented: no url, and it says why.
    const row = (await readEditPreview(A, gone.id))!;
    expect(row.status).toBe("ready");
    expect(await presentEdit(row)).toMatchObject({ id: gone.id, url: null, expired: true });
    expect(await presentEdit(ready[1])).toMatchObject({ id: ready[1].id, expired: false, url: expect.any(String) });
    // Accept-all keeps only what stands.
    const all = await acceptAllBatch({ athleteId: A, batchId: q.batchId });
    expect(all).toMatchObject({ ok: true });
    if (!all.ok) return;
    expect(all.assetIds).toHaveLength(ready.length - 1);
  });
});

describe("downloads and the re-roll", () => {
  /** ⚠️ MUTATION "download-all includes a discarded frame": accept discarded rows in acceptAllBatch. */
  /** ⚠️ MUTATION "downloaded frame loses derived_from": recordGeneratedAsset without derivedFromAssetId (engine.ts). */
  it("download-all keeps every ready candidate, skips the discarded one and names it, and every kept frame derives from the ORIGINAL reference", async () => {
    await drain();
    const q = await quoteOne();
    if (!q.ok) throw new Error(q.error);
    await runBatch({ athleteId: A, batchId: q.batchId, kick: false });
    await editTick(10);
    const bs = (await rowsOf(q.batchId)).filter(
      (r) => (r.params as { stage?: string }).stage === "B",
    );
    expect(await discardEdit({ athleteId: A, id: bs[0].id })).toMatchObject({
      ok: true,
    });
    const before = await assetCount();
    const all = await acceptAllBatch({ athleteId: A, batchId: q.batchId });
    expect(all).toMatchObject({ ok: true, skipped: 1 });
    if (!all.ok) return;
    expect(all.assetIds).toHaveLength(2);
    expect(await assetCount()).toBe(before + 2);
    for (const id of all.assetIds) {
      const [asset] = await db
        .select()
        .from(mediaAssets)
        .where(eq(mediaAssets.id, id));
      expect(asset.derived_from_asset_id).toBe(hers); // the ORIGINAL, not the intermediate
      expect(asset.origin).toBe("generated");
    }
    expect(
      await acceptAllBatch({ athleteId: A, batchId: q.batchId }),
    ).toMatchObject({ ok: true, assetIds: [], skipped: 1 });
  });

  /** ⚠️ MUTATION "candidate or stage count exceeds the quote": drop the MAX_CANDIDATES cap in rerollBatch. */
  it("one re-roll adds one quoted candidate on the same chain; a second is refused at four; the tick runs only what was quoted", async () => {
    await drain();
    const q = await quoteOne();
    if (!q.ok) throw new Error(q.error);
    await runBatch({ athleteId: A, batchId: q.batchId, kick: false });
    await editTick(10);
    const view1 = await batchView(A, q.batchId);
    expect(view1.candidates).toHaveLength(3);
    expect(view1.canReroll).toBe(true);
    const extra = await rerollBatch({
      athleteId: A,
      batchId: q.batchId,
      assetId: hers,
    });
    expect(extra).toMatchObject({ ok: true, costUsd: expect.any(Number) });
    if (!extra.ok) return;
    const row = (await readEditPreview(A, extra.id))!;
    expect(row.status).toBe("quoted");
    expect((row.params as { after?: string; reroll?: boolean }).reroll).toBe(
      true,
    );
    expect(
      await rerollBatch({ athleteId: A, batchId: q.batchId, assetId: hers }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      await runBatch({ athleteId: A, batchId: q.batchId, kick: false }),
    ).toEqual({ ok: true, queued: 1 });
    const calls = mockGenerate.mock.calls.length;
    expect(await editTick(10)).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(mockGenerate.mock.calls.length).toBe(calls + 1);
    expect((await batchView(A, q.batchId)).candidates).toHaveLength(4);
    expect((await batchView(A, q.batchId)).canReroll).toBe(false);
    // Full: the intermediate is swept now that no re-roll can need it.
    expect(await sweepIntermediates(A, q.batchId)).toBeGreaterThanOrEqual(0);
    const rows = await rowsOf(q.batchId);
    const a = rows.find(
      (r) => (r.params as { role?: string }).role === "intermediate",
    )!;
    expect(a.status).toBe("discarded");
  });
});
