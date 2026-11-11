/**
 * concept.test.ts — A3.2: a campaign concept, brief to deck slot.
 *
 * This is where A2.5's pre-generation gate and A3.1's clearance machine stop being unit-tested in
 * isolation and get driven for real, by the first feature that uses them both.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT, because it decides what these assertions are worth:
 *
 *   REAL — PGlite (Postgres in WASM) with shared/schema.ts pushed into it, plus
 *          server/studio/sql/generationGuards.sql applied: the same file migration 0027 embeds and
 *          the deploy step `-f`s into prod. So the FKs, the CHECK constraints and BOTH plpgsql
 *          triggers are real Postgres, not a simulation. The "unapproved content cannot reach a
 *          brand" test below is asserted against that trigger by a raw INSERT that bypasses the
 *          application entirely — which is the only version of that test worth having.
 *   REAL — assembleBrief, previewGeneration, the job lifecycle, the approval machine, and
 *          cardOverrides.applyOverrides (imported unmodified from the deck engine, read-only).
 *   MOCKED — the router (so "did we spend?" is a call count, and so this suite costs $0) and
 *          mediaStore (so no bytes reach GCS).
 *
 * THE THREE PROPERTIES THIS SUITE EXISTS FOR
 *   1. Unapproved-embed REFUSED. A draft concept cannot reach the deck — refused by the application,
 *      and refused by the database when the application is bypassed.
 *   2. Missing-ref preview REFUSED. A brief whose named piece has no reference is blocked before a
 *      billable call exists: the router's generate() is never called and no job row is opened.
 *   3. The happy path lands. An approved concept fills the deck's campaignConcept slot — proven by
 *      running the cached kit through the deck engine's OWN applyOverrides.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

// The router, mocked at the module boundary — the same technique preview.test.ts uses, for the same
// reason: spending becomes directly observable as a call count.
const estimateMock = jest.fn();
const generateMock = jest.fn();
jest.mock("./router", () => ({
  estimate: (...a: unknown[]) => estimateMock(...a),
  generate: (...a: unknown[]) => generateMock(...a),
}));

// GCS, mocked. Nothing in this suite touches a bucket.
const saveBufferMock = jest.fn();
const rehostMock = jest.fn();
jest.mock("../lib/mediaStore", () => ({
  saveBuffer: (...a: unknown[]) => saveBufferMock(...a),
  rehostFromUrl: (...a: unknown[]) => rehostMock(...a),
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
  // recordGeneratedAsset thumbnails every generated asset now, and its fallback when the caller
  // holds no bytes is to read the object back. Omitting this from the mock does not fail the
  // suite — writeGeneratedThumbnail catches and returns null — which is exactly why it is named
  // here: an absent mock would have made "no thumbnail was written" indistinguishable from
  // "thumbnailing is broken", the shape docs/runbooks/verifying-a-guard-bites.md calls a default
  // that swallows its own failure.
  readObject: jest.fn(async () => null),
}));

import { readFileSync } from "fs";
import { join } from "path";
import { and, eq } from "drizzle-orm";
import { db, client, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import {
  athletes, athletesCurrent, inboxBrands, mediaKits, mediaAssets,
  generationJobs, kitContent, cardOverrides,
} from "../../shared/schema";
import { applyOverrides, getOverrides, saveOverrides } from "../services/cardOverrides";
import { setApprovalStatus } from "./approval";
import {
  previewConcept, runConceptGeneration, embedConceptInDeck, unembedConceptFromDeck,
  readDeckConceptSlot, embeddedConceptAssets, decksEmbedding, conceptObjectBase, CONCEPT_CARD_ID,
} from "./concept";
import { GenerationError } from "./types";

const ATHLETE_ID = "33333333-4444-4555-8666-777777777777";
const OTHER_ATHLETE_ID = "44444444-5555-4666-8777-888888888888";

/** Brands, one per deck shape the embed has to distinguish between. */
const BRAND_MAIN = 4001;       // deck exists AND has a campaignConcept card
const BRAND_NO_CONCEPT = 4002; // deck exists, narrator produced no concept → no card
const BRAND_NO_KIT = 4003;     // brand exists, no deck built yet

/** The SKU an inbound ask names by hand, and for which no product photograph exists. Synthetic. */
const NAMED_PIECE = "Test Mini Alphabet Charm M";

const PLAN = {
  task: "image.generate" as const,
  provider: "vertex" as const,
  model: "gemini-3-pro-image",
  inputs: { prompt: "p", references: 0, n: 1 },
  cost: { amountUsd: 0.1344, currency: "USD" as const, basis: "estimated" as const },
};

/**
 * A REAL 1x1 PNG, not a placeholder string.
 *
 * It used to be `Buffer.from("not-a-real-png")`, which was fine while nothing decoded it. Since
 * recordGeneratedAsset thumbnails what it records, a non-image makes `sharp` throw, the thumbnail
 * comes back null by design, and the suite would have reported green on a path it never ran.
 */
const IMAGE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function generationResult(over: Record<string, unknown> = {}) {
  return {
    task: "image.generate", provider: "vertex", model: "gemini-3-pro-image",
    assets: [{ bytes: IMAGE_BYTES, mimeType: "image/png", width: 1024, height: 1280 }],
    cost: { amountUsd: 0.1344, currency: "USD", basis: "reported" },
    timings: { startedAt: "2026-08-29T00:00:00.000Z", completedAt: "2026-08-29T00:00:20.000Z", ms: 20_000 },
    ...over,
  };
}

/** A cached kit in the shape mediaKitService caches: PATH form, cards + deck. */
function cachedKit(withConcept: boolean) {
  const cards: Array<Record<string, unknown>> = [
    { id: "cover", type: "cover", emphasis: "hero", eyebrow: "Nomila", image: "athletes/x/cover.jpg", nameLines: ["Test"], meta: "", hook: "", stats: [] },
  ];
  if (withConcept) {
    cards.push({
      id: CONCEPT_CARD_ID, type: "campaignConcept", emphasis: "hero", eyebrow: "Campaign concept",
      brand: { id: BRAND_MAIN, name: "Testbrand", category: "jewelry", logo: null },
      title: "The Concept", line: "A line.", lineEmphasis: "emphasis", facets: ["Athlete"], note: "note",
      // The stand-in the deck ships with today: a recycled athlete photo.
      image: "athletes/x/recycled-hero.jpg",
    });
  }
  return { athleteId: ATHLETE_ID, identity: {}, tokens: { theme: "luxe", accent: "#E0243E" }, cards, deck: cards.map((c) => c.id), meta: {} };
}

/** Generate one concept and return the (draft) asset row id. */
async function generateOneConcept(): Promise<{ jobId: string; assetId: string; gcsPath: string }> {
  generateMock.mockResolvedValueOnce(generationResult());
  const out = await runConceptGeneration({ athleteId: ATHLETE_ID, brandId: BRAND_MAIN }, { approvedCostUsd: 0.5 });
  return { jobId: out.jobId, assetId: out.assets[0].id, gcsPath: out.assets[0].gcsPath! };
}

beforeAll(async () => {
  await initTestDb();
  // The DDL Drizzle cannot express — the FK cycle and BOTH approval triggers. Same file as 0027.
  await client.exec(readFileSync(join(__dirname, "sql", "generationGuards.sql"), "utf8"));

  await db.insert(athletes).values([
    { id: ATHLETE_ID, full_name: "Test Concept Athlete", sport: "soccer", school: "Example University", division: "D1", conference: "Example Conference", segment: "college" },
    { id: OTHER_ATHLETE_ID, full_name: "Other Athlete", sport: "soccer" },
  ] as never);
  // getAthleteContext inner-joins athletes_current and throws without it.
  await db.insert(athletesCurrent).values([
    { athlete_id: ATHLETE_ID, story_arc: "A defender who kept choosing the harder programme." },
    { athlete_id: OTHER_ATHLETE_ID },
  ] as never);

  await db.insert(inboxBrands).values([
    {
      id: BRAND_MAIN, name: "Testbrand", category: "jewelry", brand_tier: "premium",
      audience_summary: "women 18-34", normalized_name: "testbrand",
      enrichment: { product_categories: ["necklaces", "charms"], content_style: "coastal-cool", brand_values: "quiet confidence" },
    },
    { id: BRAND_NO_CONCEPT, name: "Nocardbrand", category: "apparel", normalized_name: "nocardbrand", enrichment: {} },
    { id: BRAND_NO_KIT, name: "Nokitbrand", category: "beverage", normalized_name: "nokitbrand", enrichment: {} },
  ] as never);

  await db.insert(mediaKits).values([
    { athlete_id: ATHLETE_ID, brand_id: BRAND_MAIN, data: cachedKit(true), theme: "luxe" },
    { athlete_id: ATHLETE_ID, brand_id: BRAND_NO_CONCEPT, data: cachedKit(false), theme: "luxe" },
  ] as never);
});

afterAll(async () => { await closeTestDb(); });

beforeEach(() => {
  estimateMock.mockReset();
  generateMock.mockReset();
  saveBufferMock.mockReset();
  rehostMock.mockReset();
  estimateMock.mockReturnValue(PLAN);
  saveBufferMock.mockImplementation(async (_buf: Buffer, basePath: string, contentType: string) => ({
    gcs_path: `${basePath}.png`, content_type: contentType, bytes: IMAGE_BYTES.byteLength,
  }));
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The gate: a named piece with no reference blocks BEFORE anything is spent
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("missing-ref → preview REFUSED before spending", () => {
  const inbound = {
    athleteId: ATHLETE_ID, brandId: BRAND_MAIN,
    ask: { ask: "Brand announcement — showcase the charm.", featuredPieces: [NAMED_PIECE] },
  };

  it("blocks the preview, naming the piece that has no photograph", async () => {
    const preview = await previewConcept(inbound);

    expect(preview.status).toBe("blocked");
    expect(preview.verdict.canGenerate).toBe(false);
    const blocker = preview.blockers.find((b) => b.field === `brand.pieces[${NAMED_PIECE}].reference`);
    expect(blocker).toBeDefined();
    expect(blocker!.note).toMatch(/Rendering it would invent the product/);
    expect(blocker!.severity).toBe("blocking");
  });

  it("never calls the router's generate — nothing was spent", async () => {
    await previewConcept(inbound);

    expect(generateMock).not.toHaveBeenCalled();
    // estimate() IS reached: it is a local price-table lookup that types.ts requires "must never
    // make a billable call". The spend property is about generate().
    expect(estimateMock).toHaveBeenCalled();
  });

  it("refuses to run, and opens no job row for a blocked brief", async () => {
    const before = await db.select().from(generationJobs);

    await expect(runConceptGeneration(inbound, { approvedCostUsd: 5 }))
      .rejects.toThrow(/Refusing to generate a concept/);

    expect(generateMock).not.toHaveBeenCalled();
    const after = await db.select().from(generationJobs);
    expect(after.length).toBe(before.length);
  });

  it("does NOT block when the same piece is only a category, not a named ask", async () => {
    // "necklaces" is one of the brand's categories. Nobody named it, so a missing photograph is a
    // degraded gap, not a blocking one — the distinction the whole gate rests on.
    const preview = await previewConcept({ athleteId: ATHLETE_ID, brandId: BRAND_MAIN });

    expect(preview.status).toBe("ready");
    expect(preview.blockers).toEqual([]);
    expect(preview.warnings.some((w) => w.field === "brand.pieces[necklaces].reference")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2 · Generation: the concept path is `generate`, and its output is born draft
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("runConceptGeneration", () => {
  it("routes image.generate, records the job, and stores the asset as draft", async () => {
    const { jobId, assetId } = await generateOneConcept();

    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    expect(job.status).toBe("succeeded");
    expect(job.mode).toBe("generate");
    expect(job.objective).toBe("concept");
    expect(job.origin).toBe("system");
    expect(job.brand_id).toBe(BRAND_MAIN);
    expect(job.provider).toBe("vertex");
    expect(job.cost_basis).toBe("estimated");      // carried from the quote, never recomputed
    // The edit/generate fork, enforced by the DB CHECK as well as by assembleBrief.
    expect(job.source_asset_id).toBeNull();
    expect(job.started_at).not.toBeNull();
    expect(job.completed_at).not.toBeNull();

    const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
    expect(asset.origin).toBe("generated");
    expect(asset.platform).toBe("studio");
    expect(asset.approval_status).toBe("draft");   // never born cleared
    expect(asset.generation_job_id).toBe(jobId);
    // GENERATE has no frame it came from — that is what makes it not an edit.
    expect(asset.derived_from_asset_id).toBeNull();
    expect(asset.gcs_path).toBe(`${conceptObjectBase(ATHLETE_ID, jobId, 0)}.png`);
    // ─── THE THUMBNAIL IS WRITTEN WITH THE ROW, NOT LEFT TO THE CRON ──────────────────────────
    //
    // A generated asset with no thumb is embedded from full-res, and the largest studio outputs
    // cross Vertex's base64 cap — no embedding, and mediaSearch's dedup reads `cand.emb && …`, so
    // it can never suppress a near-duplicate. Asserted on the ROW because that is what the
    // embedder reads, and because a null here is invisible until retrieval quietly degrades.
    expect(asset.gcs_thumb_path).toBe(`${conceptObjectBase(ATHLETE_ID, jobId, 0)}.thumb.png`);

    expect(generateMock).toHaveBeenCalledTimes(1);
    const [task] = generateMock.mock.calls[0];
    expect(task).toBe("image.generate");
  });

  it("refuses a quote above the approved ceiling, and spends nothing", async () => {
    await expect(runConceptGeneration({ athleteId: ATHLETE_ID, brandId: BRAND_MAIN }, { approvedCostUsd: 0.01 }))
      .rejects.toThrow(/above the approved ceiling/);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("refuses an unpriced model rather than spending as if it were $0", async () => {
    estimateMock.mockReturnValue({ ...PLAN, cost: { ...PLAN.cost, amountUsd: 0, unpriced: true } });

    await expect(runConceptGeneration({ athleteId: ATHLETE_ID, brandId: BRAND_MAIN }, { approvedCostUsd: 100 }))
      .rejects.toThrow(/no price is configured/);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("marks the job failed when the provider throws, and records no asset", async () => {
    generateMock.mockRejectedValueOnce(new GenerationError("provider exploded", "provider_error"));

    await expect(runConceptGeneration({ athleteId: ATHLETE_ID, brandId: BRAND_MAIN }, { approvedCostUsd: 0.5 }))
      .rejects.toThrow(/provider exploded/);

    const [job] = await db.select().from(generationJobs).orderBy(generationJobs.created_at);
    const failed = (await db.select().from(generationJobs).where(eq(generationJobs.status, "failed")))[0];
    expect(failed).toBeDefined();
    expect(failed.last_error).toMatch(/provider exploded/);
    expect(job).toBeDefined();
    const assets = await db.select().from(mediaAssets).where(eq(mediaAssets.generation_job_id, failed.id));
    expect(assets).toEqual([]);
  });

  it("refuses brand 0 — an untailored deck has no concept card to fill", async () => {
    await expect(runConceptGeneration({ athleteId: ATHLETE_ID, brandId: 0 }, { approvedCostUsd: 0.5 }))
      .rejects.toThrow(/needs a real brand/);
    expect(generateMock).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 3 · THE ONE THAT MATTERS: unapproved content cannot reach a brand
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("unapproved-embed REFUSED", () => {
  it("the application refuses a draft concept, and writes NOTHING", async () => {
    const { assetId } = await generateOneConcept();

    await expect(embedConceptInDeck({ athleteId: ATHLETE_ID, brandId: BRAND_MAIN, assetId }))
      .rejects.toThrow(/has not been approved/);

    // Neither write happened — the record is absent AND the deck cannot render it.
    const embeds = await db.select().from(kitContent).where(eq(kitContent.asset_id, assetId));
    expect(embeds).toEqual([]);
    const ov = await getOverrides(ATHLETE_ID, BRAND_MAIN);
    expect(ov?.images?.[CONCEPT_CARD_ID]).toBeUndefined();
  });

  it("the DATABASE refuses it too, when the application is bypassed entirely", async () => {
    const { assetId } = await generateOneConcept();
    const slot = await readDeckConceptSlot(ATHLETE_ID, BRAND_MAIN);

    // A raw INSERT — no application code in the path at all. This is the guarantee that holds
    // against a psql session, a one-off script, and code nobody has written yet.
    await expect(
      client.query("INSERT INTO kit_content (media_kit_id, asset_id, position) VALUES ($1, $2, 0)", [slot!.mediaKitId, assetId]),
    ).rejects.toThrow(/cannot embed it in a kit/);

    // And the publish gate from 0027 still refuses the same asset, one verb over.
    await expect(
      client.query("INSERT INTO content_posts (asset_id, platform) VALUES ($1, 'instagram')", [assetId]),
    ).rejects.toThrow(/cannot record a publish/);
  });

  it("both gates open once — and only once — the asset is approved", async () => {
    const { assetId } = await generateOneConcept();
    const slot = await readDeckConceptSlot(ATHLETE_ID, BRAND_MAIN);

    await setApprovalStatus(ATHLETE_ID, assetId, "approved");

    await expect(
      client.query("INSERT INTO kit_content (media_kit_id, asset_id, position) VALUES ($1, $2, 7)", [slot!.mediaKitId, assetId]),
    ).resolves.toBeDefined();
    await expect(
      client.query("INSERT INTO content_posts (asset_id, platform) VALUES ($1, 'instagram')", [assetId]),
    ).resolves.toBeDefined();
  });

  it("a rejected asset cannot be re-embedded — the trigger re-checks on UPDATE", async () => {
    const { assetId } = await generateOneConcept();
    await setApprovalStatus(ATHLETE_ID, assetId, "approved");
    await embedConceptInDeck({ athleteId: ATHLETE_ID, brandId: BRAND_MAIN, assetId });

    // Withdrawal is ORDERED: take it out of the deck, then reject (see §4 below).
    await unembedConceptFromDeck({ athleteId: ATHLETE_ID, brandId: BRAND_MAIN, assetId });
    await setApprovalStatus(ATHLETE_ID, assetId, "rejected");

    // The application refuses to put it back …
    await expect(embedConceptInDeck({ athleteId: ATHLETE_ID, brandId: BRAND_MAIN, assetId, position: 3 }))
      .rejects.toThrow(/has not been approved/);
    // … and so does the trigger, on the UPDATE arm of the upsert. This is why the embed is an
    // onConflictDoUpdate and not an onConflictDoNothing.
    const slot = await readDeckConceptSlot(ATHLETE_ID, BRAND_MAIN);
    await expect(
      client.query(
        "INSERT INTO kit_content (media_kit_id, asset_id, position) VALUES ($1, $2, 3) " +
          "ON CONFLICT (media_kit_id, asset_id) DO UPDATE SET position = 3",
        [slot!.mediaKitId, assetId],
      ),
    ).rejects.toThrow(/cannot embed it in a kit/);
  });

  it("leaves ingested content ungated — no retroactive gating", async () => {
    // origin 'connected', approval_status NULL: the 561-row case migration 0022 protects.
    const [ingested] = await db.insert(mediaAssets).values({
      athlete_id: ATHLETE_ID, platform: "instagram", origin: "connected", source_media_id: "ig-ungated-1",
      media_type: "IMAGE", status: "stored", gcs_path: "athletes/x/ingested.jpg", content_type: "image/jpeg",
    } as never).returning();
    const slot = await readDeckConceptSlot(ATHLETE_ID, BRAND_MAIN);

    // The trigger is scoped to origin='generated', so this is allowed at the DB level …
    await expect(
      client.query("INSERT INTO kit_content (media_kit_id, asset_id, position) VALUES ($1, $2, 9)", [slot!.mediaKitId, ingested.id]),
    ).resolves.toBeDefined();
    // … while the Studio door still refuses it, because this door places Studio output.
    await expect(embedConceptInDeck({ athleteId: ATHLETE_ID, brandId: BRAND_MAIN, assetId: ingested.id }))
      .rejects.toThrow(/has origin "connected"/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The happy path: an approved concept fills the slot
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("approved concept lands in the deck's concept slot", () => {
  it("writes the guarded record, then the render override, and the deck picks it up", async () => {
    // The athlete already has edits — they must survive a Studio write.
    await saveOverrides(ATHLETE_ID, BRAND_MAIN, { theme: "luxe", copy: { "cover.eyebrow": { text: "Her words" } } });

    const { assetId, gcsPath } = await generateOneConcept();
    await setApprovalStatus(ATHLETE_ID, assetId, "approved");

    const result = await embedConceptInDeck({ athleteId: ATHLETE_ID, brandId: BRAND_MAIN, assetId });
    expect(result.gcsPath).toBe(gcsPath);

    // Write 1 — the canonical, guarded embed record.
    const [embed] = await db.select().from(kitContent)
      .where(and(eq(kitContent.media_kit_id, result.mediaKitId), eq(kitContent.asset_id, assetId)));
    expect(embed).toBeDefined();

    // Write 2 — the mechanism the renderer honours, merged over what the athlete already had.
    const ov = await getOverrides(ATHLETE_ID, BRAND_MAIN);
    expect(ov?.images?.[CONCEPT_CARD_ID]).toBe(gcsPath);
    expect(ov?.theme).toBe("luxe");
    expect(ov?.copy?.["cover.eyebrow"]?.text).toBe("Her words");

    // ── THE SEAM ASSERTION ──────────────────────────────────────────────────────────────────────
    // Run the deck's own cached kit through the deck engine's OWN applyOverrides — imported
    // unmodified from services/cardOverrides. If this passes, the picture is in the slot without a
    // single line of the pitch-deck engine having changed. If someone alters applyOverrides'
    // image routing, this test is what tells us.
    const [kitRow] = await db.select({ data: mediaKits.data }).from(mediaKits)
      .where(and(eq(mediaKits.athlete_id, ATHLETE_ID), eq(mediaKits.brand_id, BRAND_MAIN)));
    const resolved = applyOverrides(kitRow.data as never, ov);
    const card = resolved.cards.find((c) => c.id === CONCEPT_CARD_ID) as { image: string } | undefined;

    expect(card).toBeDefined();
    expect(card!.image).toBe(gcsPath);
    // It replaced the recycled stand-in the deck ships with, rather than sitting beside it.
    expect(card!.image).not.toBe("athletes/x/recycled-hero.jpg");
    // The rest of the deck is untouched — this is a slot fill, not a deck rewrite.
    expect(resolved.deck?.[0]).toBe("cover");
  });

  it("is idempotent — re-embedding the same approved asset updates rather than duplicating", async () => {
    const { assetId } = await generateOneConcept();
    await setApprovalStatus(ATHLETE_ID, assetId, "approved");

    await embedConceptInDeck({ athleteId: ATHLETE_ID, brandId: BRAND_MAIN, assetId, position: 1 });
    await embedConceptInDeck({ athleteId: ATHLETE_ID, brandId: BRAND_MAIN, assetId, position: 2 });

    const rows = await db.select().from(kitContent).where(eq(kitContent.asset_id, assetId));
    expect(rows).toHaveLength(1);
    expect(rows[0].position).toBe(2);
  });

  it("lists what is embedded in a deck, scoped to the athlete", async () => {
    const { assetId } = await generateOneConcept();
    await setApprovalStatus(ATHLETE_ID, assetId, "approved");
    await embedConceptInDeck({ athleteId: ATHLETE_ID, brandId: BRAND_MAIN, assetId });

    const embedded = await embeddedConceptAssets(ATHLETE_ID, BRAND_MAIN);
    expect(embedded.some((e) => e.assetId === assetId)).toBe(true);
    expect(await embeddedConceptAssets(OTHER_ATHLETE_ID, BRAND_MAIN)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 4b · Clearance cannot be withdrawn out from under a live embed (guards §4)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("an embed locks clearance", () => {
  it("refuses to reject an asset that is currently placed in a deck", async () => {
    const { assetId } = await generateOneConcept();
    await setApprovalStatus(ATHLETE_ID, assetId, "approved");
    await embedConceptInDeck({ athleteId: ATHLETE_ID, brandId: BRAND_MAIN, assetId });

    // The application refuses with a sentence naming what has to be cleared first.
    await expect(setApprovalStatus(ATHLETE_ID, assetId, "rejected"))
      .rejects.toThrow(/embedded in 1 pitch deck\(s\).*Remove it from the deck first/s);

    // And the asset really is still approved — the refusal did not half-apply.
    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
    expect(row.approval_status).toBe("approved");
  });

  it("the DATABASE refuses the same withdrawal when the application is bypassed", async () => {
    const { assetId } = await generateOneConcept();
    await setApprovalStatus(ATHLETE_ID, assetId, "approved");
    await embedConceptInDeck({ athleteId: ATHLETE_ID, brandId: BRAND_MAIN, assetId });

    // A raw UPDATE — no application code in the path. This is the copy that cannot be bypassed.
    await expect(
      client.query("UPDATE media_assets SET approval_status = 'rejected' WHERE id = $1", [assetId]),
    ).rejects.toThrow(/embedded in a pitch deck/);

    // Nor by going out through the un-gated door: NULL is not an escape hatch either.
    await expect(
      client.query("UPDATE media_assets SET approval_status = NULL WHERE id = $1", [assetId]),
    ).rejects.toThrow(/embedded in a pitch deck/);
  });

  it("leaves every other update on an embedded asset alone", async () => {
    const { assetId } = await generateOneConcept();
    await setApprovalStatus(ATHLETE_ID, assetId, "approved");
    await embedConceptInDeck({ athleteId: ATHLETE_ID, brandId: BRAND_MAIN, assetId });

    // The trigger's WHEN clause fires only on a clearance change, so ordinary writes are untouched.
    await expect(
      client.query("UPDATE media_assets SET width = 2048 WHERE id = $1", [assetId]),
    ).resolves.toBeDefined();
    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
    expect(row.width).toBe(2048);
    expect(row.approval_status).toBe("approved");
  });

  it("un-embed then reject succeeds — withdrawal is ordered, not blocked", async () => {
    const { assetId, gcsPath } = await generateOneConcept();
    await setApprovalStatus(ATHLETE_ID, assetId, "approved");
    await embedConceptInDeck({ athleteId: ATHLETE_ID, brandId: BRAND_MAIN, assetId });

    const retracted = await unembedConceptFromDeck({ athleteId: ATHLETE_ID, brandId: BRAND_MAIN, assetId });
    expect(retracted).not.toBeNull();

    // BOTH writes reversed: the record is gone AND the deck has stopped rendering it.
    expect(await db.select().from(kitContent).where(eq(kitContent.asset_id, assetId))).toEqual([]);
    const ov = await getOverrides(ATHLETE_ID, BRAND_MAIN);
    expect(ov?.images?.[CONCEPT_CARD_ID]).toBeUndefined();

    // The card falls back to the deck's own stand-in rather than to a dangling path.
    const [kitRow] = await db.select({ data: mediaKits.data }).from(mediaKits)
      .where(and(eq(mediaKits.athlete_id, ATHLETE_ID), eq(mediaKits.brand_id, BRAND_MAIN)));
    const card = applyOverrides(kitRow.data as never, ov).cards.find((c) => c.id === CONCEPT_CARD_ID) as { image: string };
    expect(card.image).toBe("athletes/x/recycled-hero.jpg");
    expect(card.image).not.toBe(gcsPath);

    // …and now clearance can be withdrawn.
    await expect(setApprovalStatus(ATHLETE_ID, assetId, "rejected")).resolves.toMatchObject({ to: "rejected" });
  });

  it("a retraction never clears an override pointing at a different picture", async () => {
    const { assetId } = await generateOneConcept();
    await setApprovalStatus(ATHLETE_ID, assetId, "approved");
    await embedConceptInDeck({ athleteId: ATHLETE_ID, brandId: BRAND_MAIN, assetId });

    // The athlete has since swapped the slot to something else by hand.
    const before = await getOverrides(ATHLETE_ID, BRAND_MAIN);
    await saveOverrides(ATHLETE_ID, BRAND_MAIN, { ...before, images: { [CONCEPT_CARD_ID]: "athletes/x/her-own-pick.jpg" } });

    await unembedConceptFromDeck({ athleteId: ATHLETE_ID, brandId: BRAND_MAIN, assetId });

    const after = await getOverrides(ATHLETE_ID, BRAND_MAIN);
    expect(after?.images?.[CONCEPT_CARD_ID]).toBe("athletes/x/her-own-pick.jpg");
  });

  it("reports the decks an asset is placed in, scoped to the athlete", async () => {
    const { assetId } = await generateOneConcept();
    await setApprovalStatus(ATHLETE_ID, assetId, "approved");
    await embedConceptInDeck({ athleteId: ATHLETE_ID, brandId: BRAND_MAIN, assetId });

    expect(await decksEmbedding(ATHLETE_ID, assetId)).toEqual([
      expect.objectContaining({ brandId: BRAND_MAIN }),
    ]);
    expect(await decksEmbedding(OTHER_ATHLETE_ID, assetId)).toEqual([]);
  });

  it("un-embedding something that is not embedded is a no-op, not an error", async () => {
    const { assetId } = await generateOneConcept();
    expect(await unembedConceptFromDeck({ athleteId: ATHLETE_ID, brandId: BRAND_MAIN, assetId })).toBeNull();
    expect(await unembedConceptFromDeck({ athleteId: ATHLETE_ID, brandId: BRAND_NO_KIT, assetId })).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 5 · Tenancy and the rest of the refusal table
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("the embed refusal table", () => {
  it("refuses another athlete's asset id — it resolves to nothing, not to their content", async () => {
    const { assetId } = await generateOneConcept();
    await setApprovalStatus(ATHLETE_ID, assetId, "approved");

    await expect(embedConceptInDeck({ athleteId: OTHER_ATHLETE_ID, brandId: BRAND_MAIN, assetId }))
      .rejects.toThrow(/No asset .* for this athlete/);
  });

  it("refuses when the brand has no deck built yet", async () => {
    const { assetId } = await generateOneConcept();
    await setApprovalStatus(ATHLETE_ID, assetId, "approved");

    await expect(embedConceptInDeck({ athleteId: ATHLETE_ID, brandId: BRAND_NO_KIT, assetId }))
      .rejects.toThrow(/No pitch deck exists/);
  });

  it("refuses when the deck has no concept card, and writes no dead override", async () => {
    const { assetId } = await generateOneConcept();
    await setApprovalStatus(ATHLETE_ID, assetId, "approved");

    await expect(embedConceptInDeck({ athleteId: ATHLETE_ID, brandId: BRAND_NO_CONCEPT, assetId }))
      .rejects.toThrow(new RegExp(`has no "${CONCEPT_CARD_ID}" card`));

    // An override on a card the assembler never built would be a silent no-op — applyOverrides only
    // maps over cards that exist. Refusing loudly is the point; so is leaving no residue.
    const rows = await db.select().from(cardOverrides)
      .where(and(eq(cardOverrides.athlete_id, ATHLETE_ID), eq(cardOverrides.brand_id, BRAND_NO_CONCEPT)));
    expect(rows).toEqual([]);
  });

  it("refuses brand 0 at the embed door as well as the generate door", async () => {
    const { assetId } = await generateOneConcept();
    await setApprovalStatus(ATHLETE_ID, assetId, "approved");

    await expect(embedConceptInDeck({ athleteId: ATHLETE_ID, brandId: 0, assetId }))
      .rejects.toThrow(/needs a real brand/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 6 · The deck boundary read
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("readDeckConceptSlot", () => {
  it("finds the concept card in the cached kit", async () => {
    const slot = await readDeckConceptSlot(ATHLETE_ID, BRAND_MAIN);
    expect(slot?.card?.id).toBe(CONCEPT_CARD_ID);
    expect(slot?.card?.type).toBe("campaignConcept");
  });

  it("distinguishes 'no deck' from 'deck with no concept card'", async () => {
    expect(await readDeckConceptSlot(ATHLETE_ID, BRAND_NO_KIT)).toBeNull();

    const noCard = await readDeckConceptSlot(ATHLETE_ID, BRAND_NO_CONCEPT);
    expect(noCard).not.toBeNull();
    expect(noCard!.card).toBeNull();
  });

  it("does not read another athlete's deck", async () => {
    expect(await readDeckConceptSlot(OTHER_ATHLETE_ID, BRAND_MAIN)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 7 · The guards file and the migration cannot drift
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("the embed guard ships with the migration", () => {
  it("0027 still embeds generationGuards.sql verbatim, including the new embed gate", () => {
    const guards = readFileSync(join(__dirname, "sql", "generationGuards.sql"), "utf8");
    const migration = readFileSync(join(__dirname, "..", "..", "migrations", "0027_studio_generation.sql"), "utf8");

    expect(guards).toContain("trg_kit_content_require_approval");
    expect(guards).toContain("trg_media_assets_embed_locks_approval");
    expect(migration).toContain(guards);
  });
});
