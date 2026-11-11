/**
 * mediaEnrichment.test.ts — the treadmill brake.
 *
 * The defect: `UNENRICHED` is `vision IS NULL OR embedding IS NULL`, and `enrichRows` only wrote a
 * row back `if (changed)`. So an asset that tagged fine and could NEVER embed — measured live, two
 * 4000x6000 generated frames whose base64 is ~32.8M characters against Vertex's 27,000,000 cap —
 * left no trace of having been tried, stayed a candidate, and was re-downloaded and re-sent on
 * every cron tick for two days.
 *
 * These tests drive the real SQL through PGlite (the repo's convention) and mock only the two
 * network boundaries, so what is under test is the candidate predicate and the attempt bookkeeping
 * rather than a description of them.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/visionTag", () => ({ tagAsset: jest.fn() }));
jest.mock("../lib/mediaEmbed", () => ({ embedImageGcsWithReason: jest.fn() }));

import { eq } from "drizzle-orm";
import { enrichNextChunk, enrichAthleteMedia } from "./mediaEnrichment";
import { mediaAssets } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { tagAsset } from "../lib/visionTag";
import { embedImageGcsWithReason } from "../lib/mediaEmbed";

const mockTag = tagAsset as jest.MockedFunction<typeof tagAsset>;
const mockEmbed = embedImageGcsWithReason as jest.MockedFunction<typeof embedImageGcsWithReason>;

/** The two failure shapes, named once so a test reads as the case it is. */
const OVERSIZE = { ok: false, reason: "oversize" } as const;
const TRANSIENT = { ok: false, reason: "other" } as const;
const embedded = (e: number[]) => ({ ok: true, embedding: e }) as const;

const VISION = { shot_type: "action", brand_safe: true } as never;
const EMBEDDING = Array.from({ length: 8 }, (_, i) => i / 8);

let athleteId: string;

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Enrichment Test Athlete");
});
afterAll(async () => { await closeTestDb(); });

beforeEach(async () => {
  await db.delete(mediaAssets);
  jest.clearAllMocks();
});

async function seedAsset(over: Partial<Record<string, unknown>> = {}): Promise<string> {
  const [row] = await db.insert(mediaAssets).values({
    athlete_id: athleteId,
    platform: "studio",
    origin: "generated",
    media_type: "IMAGE",
    status: "stored",
    gcs_path: "athletes/x/studio/job/0.png",
    content_type: "image/png",
    ingested_at: new Date(),
    ...over,
  } as never).returning({ id: mediaAssets.id });
  return row.id;
}

const metaOf = async (id: string) => {
  const [row] = await db.select({ m: mediaAssets.metadata }).from(mediaAssets).where(eq(mediaAssets.id, id));
  return (row.m ?? {}) as Record<string, any>;
};

describe("a row that cannot embed stops being retried", () => {
  it("records an attempt even when NOTHING changed — the old code wrote nothing at all here", async () => {
    // Both halves fail. Under the previous `if (changed)` this row was untouched, so the next tick
    // could not tell it apart from one never tried. That is the unbounded loop, exactly.
    mockTag.mockResolvedValue(null);
    mockEmbed.mockResolvedValue(TRANSIENT);
    const id = await seedAsset();

    await enrichNextChunk({ athleteId });

    expect((await metaOf(id)).enrichment.attempts).toBe(1);
    expect((await metaOf(id)).enrichment.abandoned_at).toBeUndefined();
  });

  it("counts up across ticks and sets the row down at the cap", async () => {
    // The live shape: vision succeeds, embedding never will.
    mockTag.mockResolvedValue(VISION);
    mockEmbed.mockResolvedValue(TRANSIENT);
    const id = await seedAsset();

    await enrichNextChunk({ athleteId });
    expect((await metaOf(id)).enrichment.attempts).toBe(1);
    await enrichNextChunk({ athleteId });
    expect((await metaOf(id)).enrichment.attempts).toBe(2);

    for (let i = 0; i < 8; i++) await enrichNextChunk({ athleteId });
    const meta = await metaOf(id);
    expect(meta.enrichment.attempts).toBe(10);
    expect(meta.enrichment.abandoned_at).toEqual(expect.any(String));
    // Which half was missing, because "it failed" is not a thing anyone can act on.
    expect(meta.enrichment.abandoned_missing).toEqual(["embedding"]);
    expect(meta.enrichment.abandoned_reason).toBe("attempts");
    // And the vision tag it DID get is still there — being set down is not being reset.
    expect(meta.vision).toBeTruthy();
  });

  it("drops out of the candidate set once abandoned, and stops costing calls", async () => {
    mockTag.mockResolvedValue(VISION);
    mockEmbed.mockResolvedValue(TRANSIENT);
    await seedAsset();

    for (let i = 0; i < 10; i++) await enrichNextChunk({ athleteId });
    const callsAtAbandon = mockEmbed.mock.calls.length;

    const after = await enrichNextChunk({ athleteId });

    // THE ASSERTION THAT MATTERS: not "attempts stopped incrementing" but "the row is no longer
    // work". `remaining` is what the cron reads to decide whether to tick again.
    expect(after.remaining).toBe(0);
    expect(after.total).toBe(0);
    expect(mockEmbed.mock.calls.length).toBe(callsAtAbandon);
  });
});

describe("the brake does not catch anything it should not", () => {
  it("never marks a row that enriches cleanly", async () => {
    mockTag.mockResolvedValue(VISION);
    mockEmbed.mockResolvedValue(embedded(EMBEDDING));
    const id = await seedAsset();

    const res = await enrichNextChunk({ athleteId });

    const meta = await metaOf(id);
    expect(meta.enrichment).toBeUndefined();
    expect(meta.embedding).toEqual(EMBEDDING);
    expect(res.remaining).toBe(0);
  });

  it("CLEARS the record when a row recovers, rather than leaving it looking half-broken", async () => {
    mockTag.mockResolvedValue(VISION);
    mockEmbed.mockResolvedValue(TRANSIENT);
    const id = await seedAsset();
    await enrichNextChunk({ athleteId });
    expect((await metaOf(id)).enrichment.attempts).toBe(1);

    // A thumbnail lands (studio/thumbnail.ts) and the same row now embeds.
    mockEmbed.mockResolvedValue(embedded(EMBEDDING));
    await enrichNextChunk({ athleteId });

    expect((await metaOf(id)).enrichment).toBeUndefined();
    expect((await metaOf(id)).embedding).toEqual(EMBEDDING);
  });

  it("keeps a mid-backoff row IN the candidate set — only abandonment removes it", async () => {
    // The predicate reads the abandoned_at KEY. A `= false`-style test would have dropped this row
    // after its first failure, which is a far worse bug than the one being fixed.
    mockTag.mockResolvedValue(VISION);
    mockEmbed.mockResolvedValue(TRANSIENT);
    await seedAsset();

    const first = await enrichNextChunk({ athleteId });
    expect(first.remaining).toBe(1);
  });

  it("still picks up rows with no metadata at all", async () => {
    mockTag.mockResolvedValue(VISION);
    mockEmbed.mockResolvedValue(embedded(EMBEDDING));
    const id = await seedAsset({ metadata: null });

    const res = await enrichNextChunk({ athleteId });

    expect(res.total).toBe(1);
    expect((await metaOf(id)).embedding).toEqual(EMBEDDING);
  });

  it("prefers the thumbnail over the full-res path when one exists", async () => {
    // The whole point of studio/thumbnail.ts: the embedder must be handed the small copy.
    mockTag.mockResolvedValue(VISION);
    mockEmbed.mockResolvedValue(embedded(EMBEDDING));
    await seedAsset({ gcs_thumb_path: "athletes/x/studio/job/0.thumb.jpg" });

    await enrichNextChunk({ athleteId });

    expect(mockEmbed).toHaveBeenCalledWith("athletes/x/studio/job/0.thumb.jpg");
  });
});

describe("reEmbed is the way back for a row that was set down", () => {
  it("ignores the marker so an abandoned row can be retried deliberately", async () => {
    mockTag.mockResolvedValue(VISION);
    mockEmbed.mockResolvedValue(TRANSIENT);
    const id = await seedAsset();
    for (let i = 0; i < 10; i++) await enrichNextChunk({ athleteId });
    expect((await metaOf(id)).enrichment.abandoned_at).toEqual(expect.any(String));

    // The reason changed — a thumbnail exists now — so a human asks for another go.
    mockEmbed.mockResolvedValue(embedded(EMBEDDING));
    await enrichAthleteMedia(athleteId, { reEmbed: true });

    expect((await metaOf(id)).enrichment).toBeUndefined();
    expect((await metaOf(id)).embedding).toEqual(EMBEDDING);
  });

  it("an ordinary athlete backfill still respects the marker", async () => {
    mockTag.mockResolvedValue(VISION);
    mockEmbed.mockResolvedValue(TRANSIENT);
    await seedAsset();
    for (let i = 0; i < 10; i++) await enrichNextChunk({ athleteId });
    const callsAtAbandon = mockEmbed.mock.calls.length;

    await enrichAthleteMedia(athleteId);

    expect(mockEmbed.mock.calls.length).toBe(callsAtAbandon);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE BRAKE READS THE REASON — DETERMINISTIC AND TRANSIENT GET OPPOSITE ANSWERS
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("an oversize row is set down on the FIRST hit", () => {
  it("does not spend the retry budget on bytes that can never fit", async () => {
    // The two live rows: 4000x6000 at ~24.5MB, ~32.8M base64 against a 27,000,000 cap. Retrying
    // identical bytes against a published limit cannot produce a different answer, and each go
    // costs a full multi-MB download.
    mockTag.mockResolvedValue(VISION);
    mockEmbed.mockResolvedValue(OVERSIZE);
    const id = await seedAsset();

    await enrichNextChunk({ athleteId });

    const meta = await metaOf(id);
    expect(meta.enrichment.attempts).toBe(1);
    expect(meta.enrichment.abandoned_at).toEqual(expect.any(String));
    expect(meta.enrichment.abandoned_reason).toBe("oversize");
  });

  it("stops costing downloads immediately after", async () => {
    mockTag.mockResolvedValue(VISION);
    mockEmbed.mockResolvedValue(OVERSIZE);
    await seedAsset();

    await enrichNextChunk({ athleteId });
    const callsAfterFirst = mockEmbed.mock.calls.length;
    const after = await enrichNextChunk({ athleteId });

    expect(after.remaining).toBe(0);
    expect(mockEmbed.mock.calls.length).toBe(callsAfterFirst);
  });

  it("a TRANSIENT failure is not treated the same way — that is the whole distinction", async () => {
    // The regression this guards: collapsing the two reasons back together would retire a healthy
    // library during a provider outage, which is far worse than the treadmill it replaced.
    mockTag.mockResolvedValue(VISION);
    mockEmbed.mockResolvedValue(TRANSIENT);
    const id = await seedAsset();

    await enrichNextChunk({ athleteId });

    expect((await metaOf(id)).enrichment.abandoned_at).toBeUndefined();
  });
});

describe("the transient budget is CONSECUTIVE, not cumulative", () => {
  it("an outage shorter than the cap leaves nothing behind once it clears", async () => {
    mockTag.mockResolvedValue(VISION);
    mockEmbed.mockResolvedValue(TRANSIENT);
    const id = await seedAsset();
    for (let i = 0; i < 9; i++) await enrichNextChunk({ athleteId });
    expect((await metaOf(id)).enrichment.attempts).toBe(9);
    expect((await metaOf(id)).enrichment.abandoned_at).toBeUndefined();

    mockEmbed.mockResolvedValue(embedded(EMBEDDING));
    await enrichNextChunk({ athleteId });

    expect((await metaOf(id)).enrichment).toBeUndefined();
  });

  it("a success on the row resets the count, so bad days never accumulate", async () => {
    // vision fails and embedding succeeds: the row PROGRESSED, so its failure streak restarts
    // rather than creeping toward abandonment across weeks of unrelated blips.
    mockTag.mockResolvedValue(null);
    mockEmbed.mockResolvedValue(TRANSIENT);
    const id = await seedAsset();
    for (let i = 0; i < 5; i++) await enrichNextChunk({ athleteId });
    expect((await metaOf(id)).enrichment.attempts).toBe(5);

    mockEmbed.mockResolvedValue(embedded(EMBEDDING));
    await enrichNextChunk({ athleteId });

    // Embedding landed, vision still missing — incomplete, so still counted, but back to 1.
    expect((await metaOf(id)).enrichment.attempts).toBe(1);
    expect((await metaOf(id)).embedding).toEqual(EMBEDDING);
    expect((await metaOf(id)).enrichment.abandoned_at).toBeUndefined();
  });

  it("the cap is high enough that a real outage does not retire a library", async () => {
    // Pinned as a number, not derived from the constant: a test reading MAX_ENRICH_ATTEMPTS would
    // pass at any value, including the 3 that made an afternoon of 5xx enough to abandon rows.
    mockTag.mockResolvedValue(VISION);
    mockEmbed.mockResolvedValue(TRANSIENT);
    const id = await seedAsset();

    for (let i = 0; i < 9; i++) await enrichNextChunk({ athleteId });

    expect((await metaOf(id)).enrichment.abandoned_at).toBeUndefined();
  });
});

describe("a video with no poster waits for one instead of burning its attempts", () => {
  // The live defect (measured 2026-09-21): enrichment reads `thumb ?? path`, which for a posterless
  // video is the mp4. Both halves failed on every pass, the cron's in-request loop spent all ten
  // attempts in about a minute, and the row was set down for good — poster or no poster.
  const CLIP = "athletes/x/uploads/clip.mp4";
  const POSTER = "athletes/x/uploads/clip-poster.jpg";
  const posterless = (over: Partial<Record<string, unknown>> = {}) =>
    seedAsset({ origin: "upload", media_type: "VIDEO", content_type: "video/mp4", gcs_path: CLIP, ...over });

  // MUTATION: drop the poster clause from UNENRICHED. This reds, and nothing else in the suite does.
  it("is not a candidate — nothing is called, no attempt is written, and it is not counted as remaining", async () => {
    mockTag.mockResolvedValue(null);
    mockEmbed.mockResolvedValue(TRANSIENT);
    const id = await posterless();

    const r = await enrichNextChunk({ athleteId });

    expect(r.total).toBe(0);
    // `remaining` is what the cron's loop reads to decide whether to go round again.
    expect(r.remaining).toBe(0);
    expect(mockTag).not.toHaveBeenCalled();
    expect(mockEmbed).not.toHaveBeenCalled();
    expect((await metaOf(id)).enrichment).toBeUndefined();
  });

  it("becomes one when its poster lands, and is enriched FROM the poster", async () => {
    mockTag.mockResolvedValue(VISION);
    mockEmbed.mockResolvedValue(embedded(EMBEDDING));
    const id = await posterless({ gcs_thumb_path: POSTER });

    const r = await enrichNextChunk({ athleteId });

    expect(r.total).toBe(1);
    // The poster path, and WHO to look for — her row's name (lib/tagProfile.ts), since 22 Sep 2026.
    expect(mockTag).toHaveBeenCalledWith(
      POSTER,
      expect.objectContaining({ name: expect.any(String) }),
    );
    expect(mockEmbed).toHaveBeenCalledWith(POSTER);
    const meta = await metaOf(id);
    expect(meta.vision).toBeTruthy();
    expect(meta.embedding).toEqual(EMBEDDING);
  });

  // MUTATION: gate on media_type instead — `media_type <> 'VIDEO' OR gcs_thumb_path IS NOT NULL`.
  // This reds, and nothing else does. It is the blast-radius pin: a synced Instagram video stores its
  // STILL in gcs_path with no thumb (skills/rehostAthleteMedia.ts), enriches fine today, and the
  // poster cron never visits it — so a media_type gate would retire it for good.
  it("still takes a synced Instagram video whose stored file IS its still", async () => {
    mockTag.mockResolvedValue(VISION);
    mockEmbed.mockResolvedValue(embedded(EMBEDDING));
    await seedAsset({ origin: "connected", media_type: "VIDEO", content_type: "image/jpeg", gcs_path: "athletes/x/ig/reel.jpg" });

    const r = await enrichNextChunk({ athleteId });

    expect(r.total).toBe(1);
    expect(mockEmbed).toHaveBeenCalledWith("athletes/x/ig/reel.jpg");
  });

  // MUTATION: drop the `coalesce` around content_type. This reds — a null NOT LIKE is null, and the
  // row would quietly stop being a candidate.
  it("leaves an image, and a row with no content_type at all, candidates exactly as before", async () => {
    mockTag.mockResolvedValue(VISION);
    mockEmbed.mockResolvedValue(embedded(EMBEDDING));
    await seedAsset();
    await seedAsset({ content_type: null, gcs_path: "athletes/x/legacy/asset" });

    const r = await enrichNextChunk({ athleteId });

    expect(r.total).toBe(2);
  });
});

describe("a reference row (origin 'reference', 0062) is never a candidate", () => {
  // A picture she pointed the direction engine at is read by that engine alone — tagging or embedding
  // it would make it searchable as hers. ⚠️ MUTATION: drop `ne(mediaAssets.origin, "reference")` from
  // `conds` / `remConds` or from enrichAthleteMedia's selector — this reds by name.
  it("is not tagged, not embedded, not counted as remaining — on the cron path and the athlete path both", async () => {
    mockTag.mockResolvedValue(VISION);
    mockEmbed.mockResolvedValue(embedded(EMBEDDING));
    await seedAsset({ origin: "reference", platform: "web" });

    const tick = await enrichNextChunk({ athleteId });
    expect(tick.total).toBe(0);
    expect(tick.remaining).toBe(0);

    const backfill = await enrichAthleteMedia(athleteId);
    expect(backfill.total).toBe(0);

    expect(mockTag).not.toHaveBeenCalled();
    expect(mockEmbed).not.toHaveBeenCalled();
  });
});
