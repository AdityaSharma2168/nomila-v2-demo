/**
 * videoEnrichment.test.ts — the video path of the enrichment worker, through real SQL (PGlite).
 *
 * What is under test: the candidate predicate (which rows a clip read reaches and which it never
 * does), the jsonb_set write (beats added, whole-clip fields overwritten, the previous vision
 * stashed under `prev`, `enrichment` cleared), the oversize brake, the run cap's resume-not-abandon
 * semantics, and the flag — with STUDIO_VIDEO_ENRICH off the shared worker never loads this path.
 *
 * Network boundaries mocked: the Gemini client (lib/models) and the GCS reader (lib/mediaStore).
 * The photo tagger and embedder are mocked as the worker's own suite mocks them.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/visionTag", () => ({
  ...jest.requireActual("../../lib/visionTag"),
  tagAsset: jest.fn(),
}));
jest.mock("../../lib/mediaEmbed", () => ({
  embedImageGcsWithReason: jest.fn(),
}));
jest.mock("../../lib/mediaStore", () => ({
  readObject: jest.fn(),
  // The provenance probe signs the original's path before ffprobing it (provenanceSignal.ts).
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
}));
// The per-row line is part of the contract now (a 51 s upload once failed with no line at all), so
// the logger is a seam here: one fake, shared by this module and the worker it sits inside.
const logWarn = jest.fn();
const logInfo = jest.fn();
jest.mock("../../logger", () => ({
  createLogger: () => ({
    warn: logWarn,
    info: logInfo,
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));
const generateContent = jest.fn();
jest.mock("../../lib/models", () => ({
  genai: () => ({ models: { generateContent } }),
  GEMINI: {
    flash: "registry-flash",
    flashLite: "registry-flash-lite",
    pro: "registry-pro",
  },
}));

import { eq, sql as sqlRaw } from "drizzle-orm";
import { mediaAssets } from "../../../shared/schema";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../../testUtils/pgliteDb";
import { enrichVideoChunk, spentToday, utcDay } from "./videoEnrichment";
import { enrichNextChunk } from "../../services/mediaEnrichment";
import { RunBudget } from "./videoCost";
import { tagAsset } from "../../lib/visionTag";
import { embedImageGcsWithReason } from "../../lib/mediaEmbed";
import { readObject } from "../../lib/mediaStore";

const mockTag = tagAsset as jest.MockedFunction<typeof tagAsset>;
const mockEmbed = embedImageGcsWithReason as jest.MockedFunction<
  typeof embedImageGcsWithReason
>;
const mockRead = readObject as jest.MockedFunction<typeof readObject>;

const CLIP_JSON = {
  athlete_present: true,
  athlete_prominence: 0.9,
  shot_type: "action",
  description: "from the clip",
  brands_visible: ["Adidas"],
  aesthetic_quality: 0.8,
  brand_safe: true,
  setting: "track",
  attire: "kit",
  vibe: "fast",
  hero_suitability: 0.7,
  disposition: "as_is",
  edit_note: "",
  reason: "r",
  beats: [
    {
      start_s: 0,
      end_s: 3,
      description: "wide",
      shot_type: "action",
      athlete_present: true,
      athlete_prominence: 0.9,
      setting: "track",
      attire: "kit",
      vibe: "fast",
      brands_visible: [],
      aesthetic_quality: 0.8,
      camera: "static wide",
      motion: "she sprints",
      hero_suitability: 0.7,
    },
    {
      start_s: 3,
      end_s: 6,
      description: "close",
      shot_type: "portrait",
      athlete_present: true,
      athlete_prominence: 1,
      setting: "track",
      attire: "kit",
      vibe: "calm",
      brands_visible: [],
      aesthetic_quality: 0.9,
      camera: "handheld close-up",
      motion: "still, she looks at camera",
      hero_suitability: 0.9,
    },
  ],
};
const POSTER_VISION = {
  athlete_present: true,
  shot_type: "portrait",
  description: "from the poster",
  brand_safe: true,
  prev: { description: "older still" },
};
const BYTES = Buffer.from("mp4-bytes");

/** A transport that answers the clip JSON and reports usage. The real one is Gemini; this is the seam. */
const okTransport = jest.fn<
  Promise<{
    text: string;
    usage: { inputTokens: number; outputTokens: number } | null;
    model: string;
  }>,
  [Buffer, string]
>(async () => ({
  text: JSON.stringify(CLIP_JSON),
  usage: { inputTokens: 1500, outputTokens: 700 },
  model: "registry-flash",
}));
const load = jest.fn<Promise<Buffer | null>, [string, number]>(
  async () => BYTES,
);
/** The stat seam behind a null read. null = the object is absent. */
const stat = jest.fn<Promise<number | null>, [string]>(async () => null);

let athleteId: string;
beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Video Enrichment Athlete");
});
afterAll(async () => {
  await closeTestDb();
});
beforeEach(async () => {
  await db.delete(mediaAssets);
  jest.clearAllMocks();
  delete process.env.STUDIO_VIDEO_ENRICH;
  okTransport.mockImplementation(async () => ({
    text: JSON.stringify(CLIP_JSON),
    usage: { inputTokens: 1500, outputTokens: 700 },
    model: "registry-flash",
  }));
  load.mockImplementation(async () => BYTES);
  stat.mockImplementation(async () => null);
});

async function seed(
  over: Partial<Record<string, unknown>> = {},
): Promise<string> {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: athleteId,
      platform: "studio",
      origin: "generated",
      media_type: "VIDEO",
      status: "stored",
      gcs_path: "athletes/x/studio/job/clip.mp4",
      gcs_thumb_path: "athletes/x/studio/job/clip-poster.jpg",
      content_type: "video/mp4",
      bytes: 1_000_000,
      duration_seconds_precise: 6.0,
      metadata: { vision: POSTER_VISION, embedding: [0.1, 0.2] },
      ingested_at: new Date(),
      ...over,
    } as never)
    .returning({ id: mediaAssets.id });
  return row.id;
}
const metaOf = async (id: string) => {
  const [row] = await db
    .select({ m: mediaAssets.metadata })
    .from(mediaAssets)
    .where(eq(mediaAssets.id, id));
  return (row.m ?? {}) as Record<string, any>;
};
const run = (over: Partial<Parameters<typeof enrichVideoChunk>[0]> = {}) =>
  enrichVideoChunk({
    athleteId,
    transport: okTransport,
    loadBytes: load,
    statBytes: stat,
    ...over,
  });

describe("the write — beats added, whole-clip overwritten, the poster read kept under prev", () => {
  it("replaces the poster-derived vision with the clip's, stashes the old object under vision.prev (one level), and clears enrichment", async () => {
    const id = await seed({
      metadata: {
        vision: POSTER_VISION,
        embedding: [0.1],
        enrichment: { attempts: 2 },
        creative_qa: { kept: true },
      },
    });
    const r = await run();
    expect(r).toMatchObject({
      total: 1,
      tagged: 1,
      failed: 0,
      abandoned: 0,
      capped: false,
      remaining: 0,
    });
    const m = await metaOf(id);
    expect(m.vision.description).toBe("from the clip"); // overwritten, not preserved
    expect(m.vision.beats).toHaveLength(2);
    expect(m.vision.beats[1]).toMatchObject({
      start_s: 3,
      end_s: 6,
      camera: "handheld close-up",
    });
    expect(m.vision.video).toMatchObject({
      source: "clip",
      model: "registry-flash",
      sampled_fps: 1,
      duration_s: 6,
    });
    expect(m.vision.prev).toEqual({
      athlete_present: true,
      shot_type: "portrait",
      description: "from the poster",
      brand_safe: true,
    }); // its own prev dropped
    expect(m.enrichment).toBeUndefined();
    expect(m.embedding).toEqual([0.1]); // the other keys are untouched: jsonb_set on 'vision' only
    expect(m.creative_qa).toEqual({ kept: true });
  });

  it("a row with no vision at all gets prev: null, not a missing key — the eval can tell 'never poster-tagged' from 'nothing recorded'", async () => {
    const id = await seed({ metadata: null });
    await run();
    const m = await metaOf(id);
    expect(m.vision.beats).toHaveLength(2);
    expect("prev" in m.vision).toBe(true);
    expect(m.vision.prev).toBeNull();
  });

  it("reads the clip's own bytes (gcs_path), never the poster, and hands the transport video/mp4", async () => {
    await seed();
    await run();
    expect(load).toHaveBeenCalledWith(
      "athletes/x/studio/job/clip.mp4",
      expect.any(Number),
    );
    // The clip's bytes, its real MIME type, and the prompt that names HER (22 Sep 2026).
    expect(okTransport).toHaveBeenCalledWith(
      BYTES,
      "video/mp4",
      expect.stringContaining("THE ATHLETE is"),
    );
  });
});

describe("the candidate predicate", () => {
  it("a video with no poster yet is not a candidate — it waits, as it does for the photo path", async () => {
    await seed({ gcs_thumb_path: null });
    const r = await run();
    expect(r).toMatchObject({ total: 0, remaining: 0 });
    expect(okTransport).not.toHaveBeenCalled();
  });

  it("a synced reel (media_type REELS, JPEG still in gcs_path) is never a candidate — content_type says its bytes are not a video", async () => {
    await seed({
      media_type: "REELS",
      origin: "connected",
      platform: "instagram",
      content_type: "image/jpeg",
      gcs_path: "athletes/x/ig/reel.jpg",
      gcs_thumb_path: null,
    });
    await seed({
      media_type: "REELS",
      origin: "connected",
      platform: "instagram",
      content_type: "image/jpeg",
      gcs_path: "athletes/x/ig/reel.jpg",
      gcs_thumb_path: "athletes/x/ig/reel-thumb.jpg",
    });
    expect(await run()).toMatchObject({ total: 0, remaining: 0 });
  });

  it("a row already read as a clip (vision.beats present) is done; a deleted row, an abandoned row and a carousel child are out", async () => {
    await seed({ metadata: { vision: { ...POSTER_VISION, beats: [] } } });
    await seed({ deleted_at: new Date() });
    await seed({
      metadata: {
        vision: POSTER_VISION,
        enrichment: {
          abandoned_at: "2026-09-21T00:00:00Z",
          abandoned_reason: "attempts",
        },
      },
    });
    await seed({ parent_media_id: "parent" });
    expect(await run()).toMatchObject({ total: 0, remaining: 0 });
    expect(okTransport).not.toHaveBeenCalled();
  });

  it("a reference video (origin 'reference', a link she pointed the direction engine at) is never a candidate — as on the photo lane (K-S7, PR 20)", async () => {
    await seed({ origin: "reference" });
    expect(await run()).toMatchObject({ total: 0, remaining: 0 });
    expect(okTransport).not.toHaveBeenCalled();
    // The same row as her own upload is read: the clause is the origin, nothing else.
    await seed({ origin: "upload" });
    expect(await run()).toMatchObject({ total: 1, tagged: 1, remaining: 0 });
  });

  it("scopes to the athlete asked for and reports the rest as remaining", async () => {
    const other = await seedAthlete("Someone Else");
    await seed();
    await seed({ athlete_id: other });
    const r = await run({ chunk: 1 });
    expect(r).toMatchObject({ total: 1, tagged: 1, remaining: 0 });
    const all = await enrichVideoChunk({
      transport: okTransport,
      loadBytes: load,
      chunk: 1,
    });
    expect(all).toMatchObject({ total: 1, remaining: 0 });
  });
});

describe("failures", () => {
  it("OVERSIZE by the bytes column is set down on sight — reason 'oversize', missing ['beats'], the poster tags kept, no bytes read", async () => {
    const id = await seed({ bytes: 500 * 1024 * 1024 });
    const r = await run();
    expect(r).toMatchObject({
      total: 1,
      tagged: 0,
      abandoned: 1,
      remaining: 0,
    });
    const m = await metaOf(id);
    expect(m.enrichment).toMatchObject({
      abandoned_reason: "oversize",
      abandoned_missing: ["beats"],
    });
    expect(m.vision.description).toBe("from the poster");
    expect(load).not.toHaveBeenCalled();
  });

  it("a transport failure is one consecutive attempt, and the shared budget abandons at the cap", async () => {
    okTransport.mockRejectedValue(new Error("503 from vertex"));
    const id = await seed();
    await run();
    let m = await metaOf(id);
    expect(m.enrichment.attempts).toBe(1);
    expect(m.enrichment.abandoned_at).toBeUndefined();
    expect(m.vision.description).toBe("from the poster");
    // Nine more in a row: the tenth sets it down, reason 'attempts'.
    for (let i = 0; i < 9; i++) await run();
    m = await metaOf(id);
    expect(m.enrichment).toMatchObject({
      attempts: 10,
      abandoned_reason: "attempts",
      abandoned_missing: ["beats"],
    });
    expect((await run()).total).toBe(0);
  });

  it("an unparseable answer is a failure that counts an attempt, and a success wipes the count", async () => {
    okTransport.mockResolvedValueOnce({
      text: "not json",
      usage: null,
      model: "m",
    });
    const id = await seed();
    await run();
    expect((await metaOf(id)).enrichment.attempts).toBe(1);
    await run();
    expect((await metaOf(id)).enrichment).toBeUndefined();
    expect((await metaOf(id)).vision.beats).toHaveLength(2);
  });
});

describe("two runs in flight — the write is compare-and-set", () => {
  it("a row another run read first is discarded, not written, not an attempt — and its prev keeps the POSTER read", async () => {
    const id = await seed();
    // While this run's model call is in flight, another run lands its clip read on the same row.
    const other = {
      ...CLIP_JSON,
      description: "the other run's read",
      prev: POSTER_VISION,
    };
    okTransport.mockImplementationOnce(async () => {
      await db.execute(
        sqlRaw`UPDATE media_assets SET metadata = jsonb_set(metadata, '{vision}', ${JSON.stringify(other)}::jsonb) WHERE id = ${id}`,
      );
      return {
        text: JSON.stringify(CLIP_JSON),
        usage: { inputTokens: 1500, outputTokens: 700 },
        model: "registry-flash",
      };
    });
    const r = await run();
    expect(r).toMatchObject({
      total: 1,
      tagged: 0,
      failed: 0,
      raced: 1,
      remaining: 0,
    });
    const m = await metaOf(id);
    expect(m.vision.description).toBe("the other run's read");
    expect(m.vision.prev).toEqual(POSTER_VISION);
    expect(m.enrichment).toBeUndefined();
  });
});

describe("the run cap — resume, not abandon", () => {
  it("stops BY NAME when the next clip would pass the cap: the rest are untouched, count no attempt, and stay candidates", async () => {
    const a = await seed({ duration_seconds_precise: 6 });
    const b = await seed({ duration_seconds_precise: 6 });
    const c = await seed({ duration_seconds_precise: 6 });
    // One 6 s clip on Flash is about $0.01 of estimate; a cap of $0.015 admits exactly one.
    const r = await run({ budget: new RunBudget(0.015) });
    expect(r).toMatchObject({
      total: 3,
      tagged: 1,
      failed: 0,
      abandoned: 0,
      capped: true,
      remaining: 2,
    });
    expect(okTransport).toHaveBeenCalledTimes(1);
    let withBeats = 0;
    for (const id of [a, b, c]) {
      const m = await metaOf(id);
      if (m.vision.beats) {
        withBeats++;
        continue;
      }
      expect(m.enrichment).toBeUndefined();
      expect(m.vision.description).toBe("from the poster");
    }
    expect(withBeats).toBe(1);
    // The next pass resumes: one more.
    const r2 = await run({ budget: new RunBudget(0.015) });
    expect(r2).toMatchObject({ tagged: 1, capped: true, remaining: 1 });
  });

  it("spend settles to what Vertex reported, not the estimate", async () => {
    await seed();
    const budget = new RunBudget(5);
    await run({ budget });
    // 1500 in × $1.5/M + 700 out × $9/M
    expect(budget.spentUsd).toBeCloseTo(1500 * 1.5e-6 + 700 * 9e-6, 8);
  });
});

describe("the flag — the shared worker with STUDIO_VIDEO_ENRICH off", () => {
  it("OFF: a video row is tagged from its poster and never read as a clip; nothing reaches the Gemini client for a video", async () => {
    mockTag.mockResolvedValue({
      shot_type: "portrait",
      description: "from the poster",
    } as never);
    mockEmbed.mockResolvedValue({ ok: true, embedding: [0.5] } as never);
    const id = await seed({ metadata: null });
    const r = await enrichNextChunk({ athleteId });
    expect(r).toMatchObject({ total: 1, tagged: 1, embedded: 1, remaining: 0 });
    expect(mockTag).toHaveBeenCalledWith(
      "athletes/x/studio/job/clip-poster.jpg",
      expect.objectContaining({ name: expect.any(String) }),
    );
    expect(generateContent).not.toHaveBeenCalled();
    expect(mockRead).not.toHaveBeenCalled();
    const m = await metaOf(id);
    expect(m.vision.beats).toBeUndefined();
  });

  it("ON: the clip is read FIRST, so the poster path finds vision present and only embeds; remaining counts both paths", async () => {
    process.env.STUDIO_VIDEO_ENRICH = "true";
    mockRead.mockResolvedValue({ buf: BYTES, contentType: "video/mp4" });
    generateContent.mockResolvedValue({
      text: JSON.stringify(CLIP_JSON),
      usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 700 },
    });
    mockEmbed.mockResolvedValue({ ok: true, embedding: [0.5] } as never);
    const id = await seed({ metadata: null });
    const r = await enrichNextChunk({ athleteId });
    expect(mockTag).not.toHaveBeenCalled(); // no poster tag: the clip's tags were already there
    expect(mockEmbed).toHaveBeenCalledWith(
      "athletes/x/studio/job/clip-poster.jpg",
    );
    expect(r.remaining).toBe(0);
    // The cron stops on `total === 0`: the clip read must count, or one request does one chunk and
    // stops. Two here — the clip read, and the same row as the photo path's embed candidate.
    expect(r.total).toBe(2);
    expect(r.tagged).toBe(1);
    const m = await metaOf(id);
    expect(m.vision.description).toBe("from the clip");
    expect(m.vision.beats).toHaveLength(2);
    expect(m.embedding).toEqual([0.5]);
    const call = generateContent.mock.calls[0][0];
    expect(call.model).toBe("registry-flash");
    expect(call.contents[0].parts[0]).toMatchObject({
      inlineData: { mimeType: "video/mp4" },
      videoMetadata: { fps: 1 },
    });
    expect(call.config.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it("ON, and the run capped: the worker reports the untagged clips as remaining so the next pass resumes", async () => {
    process.env.STUDIO_VIDEO_ENRICH = "true";
    process.env.STUDIO_VIDEO_ENRICH_MAX_RUN_USD = "0.015";
    try {
      mockRead.mockResolvedValue({ buf: BYTES, contentType: "video/mp4" });
      generateContent.mockResolvedValue({
        text: JSON.stringify(CLIP_JSON),
        usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 700 },
      });
      await seed();
      await seed();
      const r = await enrichNextChunk({ athleteId });
      expect(generateContent).toHaveBeenCalledTimes(1);
      expect(r.remaining).toBe(1);
    } finally {
      delete process.env.STUDIO_VIDEO_ENRICH_MAX_RUN_USD;
    }
  });
});

describe("every non-tagged row is one log line with the asset id and a reason (22 Sep 2026: a 51 s upload failed with no line at all)", () => {
  const warnFor = (id: string) =>
    logWarn.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((f) => f.assetId === id);

  it("a transport failure: reason 'transport_error', the error text, the attempt count", async () => {
    okTransport.mockRejectedValue(new Error("503 from vertex"));
    const id = await seed();
    await run();
    expect(warnFor(id)).toEqual([
      expect.objectContaining({
        assetId: id,
        reason: "transport_error",
        error: "503 from vertex",
        attempts: 1,
        abandoned: null,
        durationS: 6,
      }),
    ]);
    expect(logWarn.mock.calls[0][1]).toBe("video not tagged");
  });

  it("an unparseable answer: reason 'unparseable'; oversize by the column: reason 'oversize_column', abandoned 'oversize', no attempt", async () => {
    okTransport.mockResolvedValueOnce({
      text: "not json",
      usage: null,
      model: "m",
    });
    const a = await seed();
    const b = await seed({ bytes: 500 * 1024 * 1024 });
    const r = await run();
    expect(warnFor(a)[0]).toMatchObject({
      reason: "unparseable",
      attempts: 1,
      abandoned: null,
    });
    expect(warnFor(b)[0]).toMatchObject({
      reason: "oversize_column",
      attempts: 0,
      abandoned: "oversize",
      bytesColumn: 500 * 1024 * 1024,
    });
    // Set down is not a failure: the two rows are one failed, one abandoned — not two failed.
    expect(r).toMatchObject({ total: 2, failed: 1, abandoned: 1, tagged: 0 });
  });

  it("a row another run read first is logged at info as 'raced', never at warn", async () => {
    const id = await seed();
    okTransport.mockImplementationOnce(async () => {
      await enrichVideoChunk({
        athleteId,
        transport: okTransport,
        loadBytes: load,
        statBytes: stat,
      });
      return { text: JSON.stringify(CLIP_JSON), usage: null, model: "m" };
    });
    const r = await run();
    expect(r.raced).toBe(1);
    expect(warnFor(id)).toEqual([]);
    expect(logInfo).toHaveBeenCalledWith(
      { assetId: id, reason: "raced" },
      "video not tagged",
    );
  });
});

describe("a null read is stat'ed: the reader answers null for 'absent' and for 'over the cap', and only one of those is forever", () => {
  it("an oversize OBJECT (the column said less) is set down on sight like an oversize column — no attempt, reason 'oversize'", async () => {
    load.mockResolvedValue(null);
    stat.mockResolvedValue(500 * 1024 * 1024);
    const id = await seed({ bytes: 1_000_000 });
    const r = await run();
    expect(r).toMatchObject({
      total: 1,
      tagged: 0,
      failed: 0,
      abandoned: 1,
      remaining: 0,
    });
    const m = await metaOf(id);
    expect(m.enrichment).toMatchObject({
      attempts: 0,
      abandoned_reason: "oversize",
      abandoned_missing: ["beats"],
    });
    expect(m.vision.description).toBe("from the poster");
    expect(stat).toHaveBeenCalledWith("athletes/x/studio/job/clip.mp4");
    expect(logWarn.mock.calls[0][0]).toMatchObject({
      assetId: id,
      reason: "oversize_object",
      objectBytes: 500 * 1024 * 1024,
    });
  });

  it("an ABSENT object is one consecutive attempt, reason 'missing_object' — it may be there next pass", async () => {
    load.mockResolvedValue(null);
    stat.mockResolvedValue(null);
    const id = await seed();
    const r = await run();
    expect(r).toMatchObject({
      total: 1,
      failed: 1,
      abandoned: 0,
      remaining: 1,
    });
    expect((await metaOf(id)).enrichment).toMatchObject({ attempts: 1 });
    expect((await metaOf(id)).enrichment.abandoned_at).toBeUndefined();
    expect(logWarn.mock.calls[0][0]).toMatchObject({
      assetId: id,
      reason: "missing_object",
      objectBytes: null,
      attempts: 1,
    });
    expect(okTransport).not.toHaveBeenCalled();
  });
});

describe("the worker's door — enrichNextChunk — is one door", () => {
  beforeEach(() => {
    process.env.STUDIO_VIDEO_ENRICH = "true";
    mockRead.mockResolvedValue({ buf: BYTES, contentType: "video/mp4" });
    generateContent.mockResolvedValue({
      text: JSON.stringify(CLIP_JSON),
      usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 700 },
    });
    mockEmbed.mockResolvedValue({ ok: true, embedding: [0.5] } as never);
  });

  it("two calls in flight at once are run one after the other: one clip is read ONCE, the second call finds nothing to do", async () => {
    const id = await seed();
    const [first, second] = await Promise.all([
      enrichNextChunk({ athleteId }),
      enrichNextChunk({ athleteId }),
    ]);
    // Unserialised, both selects run before either write: two reads paid for, one of them `raced`.
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ tagged: 1, raced: 0 });
    expect(second).toMatchObject({ tagged: 0, raced: 0, total: 0 });
    expect((await metaOf(id)).vision.beats).toHaveLength(2);
  });

  it("a call that throws does not jam the door for the next one", async () => {
    // A per-row video failure is caught inside its loop; the photo path's embedder is not — one
    // rejection there is a throw above the loop, the shape a jammed door would have stuck on.
    const id = await seed({ metadata: null });
    mockEmbed.mockRejectedValueOnce(new Error("embedder down"));
    const bad = enrichNextChunk({ athleteId }).then(
      () => null,
      (e: unknown) => e,
    );
    const good = enrichNextChunk({ athleteId });
    expect(await bad).toBeInstanceOf(Error);
    expect(await good).toMatchObject({ embedded: 1, tagged: 0 });
    expect((await metaOf(id)).vision.beats).toHaveLength(2);
  });

  it("`abandoned` and `raced` travel through the worker's result, so the cron response can carry them", async () => {
    await seed({ bytes: 500 * 1024 * 1024 });
    const r = await enrichNextChunk({ athleteId });
    expect(r).toMatchObject({
      total: 1,
      tagged: 0,
      failed: 0,
      abandoned: 1,
      raced: 0,
      remaining: 0,
    });
  });
});

describe("one record, two lanes — the photo lane's success does not wipe the clip lane's attempt count", () => {
  beforeEach(() => {
    process.env.STUDIO_VIDEO_ENRICH = "true";
    mockRead.mockResolvedValue({ buf: BYTES, contentType: "video/mp4" });
    mockTag.mockResolvedValue(POSTER_VISION as never);
    mockEmbed.mockResolvedValue({ ok: true, embedding: [0.5] } as never);
  });

  /**
   * ⚠️  THE REVERT CHECK. Drop `&& !clipStillOwed(c, patch)` from the photo lane's clearing branch
   * (services/mediaEnrichment.ts) and `attempts` reads undefined after the first pass, 1 after the
   * second: the counter restarts every time this lane progresses, and the clip never sets down.
   */
  it("a clip read that fails while the poster frame tags fine keeps attempts: 1, and the next failure makes it 2", async () => {
    generateContent.mockResolvedValue({
      text: "not json",
      usageMetadata: null,
    });
    const id = await seed({ metadata: null });
    const r1 = await enrichNextChunk({ athleteId });
    expect(r1).toMatchObject({ failed: 1, tagged: 1, embedded: 1 });
    let m = await metaOf(id);
    expect(m.vision.description).toBe("from the poster");
    expect(m.vision.beats).toBeUndefined();
    expect(m.embedding).toEqual([0.5]);
    expect(m.enrichment.attempts).toBe(1);
    await enrichNextChunk({ athleteId });
    m = await metaOf(id);
    expect(m.enrichment.attempts).toBe(2);
    expect(m.enrichment.abandoned_at).toBeUndefined();
  });

  it("with the clip lane OFF the record is cleared as it always was — a poster-tagged video is not half-broken", async () => {
    delete process.env.STUDIO_VIDEO_ENRICH;
    const id = await seed({ metadata: { enrichment: { attempts: 2 } } });
    await enrichNextChunk({ athleteId });
    const m = await metaOf(id);
    expect(m.vision.description).toBe("from the poster");
    expect(m.enrichment).toBeUndefined();
  });

  it("a photo's record is cleared on success whatever the flag says — the clip lane owes a photo nothing", async () => {
    const id = await seed({
      media_type: "IMAGE",
      content_type: "image/jpeg",
      gcs_path: "athletes/x/studio/job/0.jpg",
      metadata: { enrichment: { attempts: 3 } },
    });
    await enrichNextChunk({ athleteId });
    expect((await metaOf(id)).enrichment).toBeUndefined();
  });
});

/**
 * ─── SIGNAL 1 RIDES BESIDE THE TAGS (22 Sep 2026) ─────────────────────────────────────────────
 * ⚠️ MUTATION, red here by name: in `provenanceOf` return null for every row (skip the probe) —
 * "an upload's container is probed … and the score lands beside vision" reds.
 */
describe("the clip lane probes an upload's container and writes provenance_signal beside vision", () => {
  it("an upload's container is probed at its ORIGINAL when the transcode kept one, and the score lands beside vision; a generated row is not probed", async () => {
    const upload = await seed({
      origin: "upload",
      metadata: { original_gcs_path: "athletes/x/uploads/original.mov" },
    });
    const generated = await seed({
      origin: "generated",
      gcs_path: "athletes/x/studio/job/other.mp4",
    });
    const probed: string[] = [];
    const r = await run({
      probeContainer: async (source) => {
        probed.push(source);
        return {
          format: { tags: { "com.apple.quicktime.make": "Apple" } },
          streams: [{ codec_type: "video" }],
        };
      },
    });
    expect(r.tagged).toBe(2);
    expect(probed).toHaveLength(1);
    expect(probed[0]).toContain("original.mov");
    const u = await metaOf(upload);
    const g = await metaOf(generated);
    expect(u.provenance_signal.signal).toBe("device-camera");
    expect(u.vision.beats).toBeDefined();
    expect(g.provenance_signal).toBeUndefined();
  });

  /**
   * PR 4 B2b — a reel she posted, once the poster worker has done the upload's full job on it
   * (poster, 1080p transcode, original kept). No code made it a candidate: the predicate never
   * filtered on origin. ⚠️ MUTATION: make `provenanceOf` skip origin 'connected' — this reds by name.
   */
  it("a connected Instagram mp4 is tagged with beats and probed at its original — Lavf, no device atom: no-device-metadata", async () => {
    const reel = await seed({
      origin: "connected",
      platform: "instagram",
      gcs_path: "athletes/x/uploads/reel-1080.mp4",
      gcs_thumb_path: "athletes/x/uploads/reel-poster.jpg",
      metadata: { original_gcs_path: "athletes/x/instagram/ig-1.mp4" },
    });
    const probed: string[] = [];
    const r = await run({
      probeContainer: async (source) => {
        probed.push(source);
        return {
          format: { tags: { encoder: "Lavf58.76.100" } },
          streams: [{ codec_type: "video" }, { codec_type: "audio" }],
        };
      },
    });
    expect(r.tagged).toBe(1);
    expect(probed).toHaveLength(1);
    expect(probed[0]).toContain("instagram/ig-1.mp4");
    const m = await metaOf(reel);
    expect(m.vision.beats).toBeDefined();
    expect(m.provenance_signal.signal).toBe("no-device-metadata");
    expect(m.provenance_signal.evidence.encoder).toMatch(/^Lavf/);
  });

  it("a probe that fails scores unknown and never fails the tag", async () => {
    const upload = await seed({ origin: "upload" });
    const r = await run({ probeContainer: async () => null });
    expect(r.tagged).toBe(1);
    expect((await metaOf(upload)).provenance_signal.signal).toBe("unknown");
  });
});

/**
 * ─── THE DAILY CAP (PR 4, C1) ─────────────────────────────────────────────────────────────────
 * A 6 s clip estimates ≈ $0.0080 and the stub reports 1500 in / 700 out ≈ $0.00855, so a $0.012 cap
 * fits exactly one clip. ⚠️ MUTATION: skip the day check in the loop — the first case reds by name.
 */
describe("the daily cap — per athlete per UTC day, across runs, resumes tomorrow", () => {
  const NOW = new Date("2026-09-22T15:00:00Z");
  const TODAY = utcDay(NOW);
  const YESTERDAY = "2026-09-21";

  it("the second clip waits for tomorrow: one tagged, the other untouched with no attempt, and the spend is booked under today", async () => {
    const first = await seed();
    const second = await seed({ gcs_path: "athletes/x/studio/job/two.mp4" });
    const r = await run({ dailyCapUsd: 0.012, now: () => NOW });
    expect(r).toMatchObject({ total: 2, tagged: 1, failed: 0, dailyCapped: 1 });
    expect(okTransport).toHaveBeenCalledTimes(1);
    const [done, waiting] = (await metaOf(first)).vision.beats
      ? [first, second]
      : [second, first];
    const d = await metaOf(done);
    expect(d.enrich_spend.day).toBe(TODAY);
    expect(d.enrich_spend.usd).toBeCloseTo(0.00855, 5);
    const w = await metaOf(waiting);
    expect(w.vision.beats).toBeUndefined();
    expect(w.enrichment).toBeUndefined();
    expect(w.enrich_spend).toBeUndefined();
    expect((await spentToday(TODAY, athleteId)).get(athleteId)).toBeCloseTo(
      0.00855,
      5,
    );
  });

  it("an athlete already at the cap is left out of the pass — nothing selected, no model call, the clip still a candidate", async () => {
    await seed({
      metadata: {
        vision: { beats: [{ start_s: 0, end_s: 3 }] },
        enrich_spend: { day: TODAY, usd: 0.02 },
      },
    });
    const waiting = await seed({ gcs_path: "athletes/x/studio/job/two.mp4" });
    const r = await run({ dailyCapUsd: 0.012, now: () => NOW });
    expect(r).toMatchObject({ total: 0, tagged: 0, remaining: 1 });
    expect(okTransport).not.toHaveBeenCalled();
    expect((await metaOf(waiting)).enrichment).toBeUndefined();
  });

  it("yesterday's spend is not today's: the day key rolls, and the clip is read", async () => {
    await seed({
      metadata: {
        vision: { beats: [{ start_s: 0, end_s: 3 }] },
        enrich_spend: { day: YESTERDAY, usd: 5 },
      },
    });
    await seed({ gcs_path: "athletes/x/studio/job/two.mp4" });
    const r = await run({ dailyCapUsd: 0.012, now: () => NOW });
    expect(r).toMatchObject({ tagged: 1, dailyCapped: 0 });
  });

  it("a row booked yesterday and read again today resets to today's figure, never adds across days", async () => {
    const id = await seed({
      metadata: {
        vision: POSTER_VISION,
        enrich_spend: { day: YESTERDAY, usd: 5 },
      },
    });
    await run({ dailyCapUsd: 1, now: () => NOW });
    const m = await metaOf(id);
    expect(m.enrich_spend.day).toBe(TODAY);
    expect(m.enrich_spend.usd).toBeCloseTo(0.00855, 5);
  });

  it("unset is no cap — every candidate is read, as before", async () => {
    await seed();
    await seed({ gcs_path: "athletes/x/studio/job/two.mp4" });
    const r = await run({ dailyCapUsd: null, now: () => NOW });
    expect(r).toMatchObject({ tagged: 2, dailyCapped: 0 });
  });
});
