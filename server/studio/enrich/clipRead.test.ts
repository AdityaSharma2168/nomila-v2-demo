/**
 * clipRead.test.ts — one clip, read on demand (PR 9.5, F22 B1/B2/B4), through real SQL (PGlite).
 *
 * Under test: the `assetId` seam (exactly her one row, never another), the quote on every answer,
 * the booking against her day and the ONE cap guard (the chunk's — its refusal string is the reason,
 * verbatim), the R-7 dead-read rule, the failure path (the row is left unread and the list still
 * offers it as-is), the flags (off: 404 before a row is read), and the read state on the picker's
 * list rows and the media detail answer.
 *
 * Mutations, red-by-name (ledger docs/probes/clip-reads.md §4):
 *   "clip read runs unquoted"                     — startClipRead skips the quote
 *   "read spend not counted against the day cap"  — videoEnrichment.ts drops `await book(c, …)`
 *   "read at cap runs anyway"                     — videoEnrichment.ts drops the per-clip cap check
 *   "a dead read stays reading forever"           — readState.ts drops the age check
 *   "image asset gets a read affordance"          — clipRead.ts drops the video-only check
 *   "another athlete's clip is not found"         — clipRead.ts drops the athlete predicate
 *   "the read route is there with the flag off"   — routes.ts drops a flag
 *   "saved plan ignores a later read"             — lives in plans.resign.test.ts
 *
 * Network boundaries mocked: the Gemini client (lib/models), the GCS reader/signer (lib/mediaStore),
 * the photo tagger and embedder (never reached here).
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/visionTag", () => ({
  ...jest.requireActual("../../lib/visionTag"),
  tagAsset: jest.fn(),
}));
jest.mock("../../lib/mediaEmbed", () => ({
  embedImageGcsWithReason: jest.fn(),
  embedText: jest.fn(),
  embedImageGcs: jest.fn(),
  cosine: () => 0,
}));
jest.mock("../../lib/mediaStore", () => ({
  readObject: jest.fn(),
  headObject: jest.fn(async () => null),
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
  saveBuffer: jest.fn(),
  rehostFromUrl: jest.fn(),
  uploadLocalFile: jest.fn(),
  UPLOAD_LIMITS: {
    image: { max: 25 * 1024 * 1024, types: [] },
    video: { max: 200 * 1024 * 1024, types: [] },
  },
}));
jest.mock("../../lib/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const who = (globalThis as any).__TEST_ATHLETE_ID;
    if (who === undefined) {
      res
        .status(401)
        .json({ error: "Missing or malformed Authorization header" });
      return;
    }
    req.athleteId = who;
    next();
  },
}));
jest.mock("../../logger", () => ({
  createLogger: () => ({
    warn: jest.fn(),
    info: jest.fn(),
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

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { athletes, mediaAssets } from "../../../shared/schema";
import { db, initTestDb, closeTestDb } from "../../testUtils/pgliteDb";
import { readObject } from "../../lib/mediaStore";
import studioRouter from "../../routes/studio";
import mediaRouter from "../../routes/media";
import {
  DAILY_CAP_REFUSAL,
  enrichVideoChunk,
  spentToday,
  utcDay,
} from "./videoEnrichment";
import {
  clipReadStateOf,
  quoteClipReadUsd,
  READ_REASONS,
  readInputOf,
} from "./readState";
import { startClipRead, type OneClipEnricher } from "./clipRead";
import { clipReadStaleMs } from "./config";

const mockRead = readObject as jest.MockedFunction<typeof readObject>;

const HER = "22222222-1111-4444-8555-666666666666";
const SOMEONE_ELSE = "99999999-1111-4777-8666-555555555555";
const BYTES = Buffer.from("mp4-bytes");
const CLIP_JSON = {
  athlete_present: true,
  athlete_prominence: 0.9,
  shot_type: "action",
  description: "from the clip",
  brands_visible: [],
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
      motion: "still",
      hero_suitability: 0.9,
    },
  ],
};
const POSTER_VISION = { athlete_present: true, description: "from the poster" };
/** What the mocked Gemini answer reports; the row books this, not the estimate. */
const BILLED = 1500 * (1.5 / 1_000_000) + 700 * (9 / 1_000_000);

let server: Server;
let base: string;
const asUser = (id: string | undefined) => {
  (globalThis as any).__TEST_ATHLETE_ID = id;
};

async function seed(
  owner: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: owner,
      platform: "studio",
      origin: "generated",
      media_type: "VIDEO",
      status: "stored",
      gcs_path: `athletes/${owner}/studio/${Math.random().toString(36).slice(2)}.mp4`,
      gcs_thumb_path: `athletes/${owner}/studio/poster.jpg`,
      content_type: "video/mp4",
      bytes: 1_000_000,
      duration_seconds_precise: 6.0,
      metadata: { vision: POSTER_VISION },
      ingested_at: new Date(),
      ...over,
    } as never)
    .returning({ id: mediaAssets.id });
  return row.id;
}
const image = (owner: string) =>
  seed(owner, {
    media_type: "IMAGE",
    content_type: "image/jpeg",
    gcs_path: `athletes/${owner}/studio/${Math.random().toString(36).slice(2)}.jpg`,
    duration_seconds_precise: null,
  });
const metaOf = async (id: string) => {
  const [row] = await db
    .select({ m: mediaAssets.metadata })
    .from(mediaAssets)
    .where(eq(mediaAssets.id, id));
  return (row.m ?? {}) as Record<string, any>;
};

/** The chunk with its network seams — what the service half drives. The route drives the real door. */
const enrich: OneClipEnricher = (o) =>
  enrichVideoChunk({ ...o, chunk: 1, loadBytes: async () => BYTES });
const start = (
  assetId: string,
  over: Partial<Parameters<typeof startClipRead>[0]> = {},
) =>
  startClipRead({ athleteId: HER, assetId, enrich, graceMs: 10_000, ...over });

const post = async (id: string) => {
  const res = await fetch(`${base}/studio/media/${id}/read`, {
    method: "POST",
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as any,
  };
};
const get = async (path: string) => {
  const res = await fetch(`${base}${path}`);
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as any,
  };
};

beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values([
    { id: HER, full_name: "Clip Read Athlete" },
    { id: SOMEONE_ELSE, full_name: "Another Athlete" },
  ] as never);
  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", studioRouter);
  app.use("/api/v1/me", mediaRouter);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/me`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await closeTestDb();
});
beforeEach(async () => {
  await db.delete(mediaAssets);
  jest.clearAllMocks();
  asUser(HER);
  process.env.STUDIO_ENABLED = "true";
  process.env.STUDIO_CLIP_READ = "true";
  process.env.STUDIO_VIDEO_ENRICH = "true";
  delete process.env.STUDIO_ENRICH_DAILY_CAP_USD;
  mockRead.mockResolvedValue({ buf: BYTES, contentType: "video/mp4" } as never);
  generateContent.mockResolvedValue({
    text: JSON.stringify(CLIP_JSON),
    usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 700 },
  });
});
afterAll(() => {
  delete process.env.STUDIO_ENABLED;
  delete process.env.STUDIO_CLIP_READ;
  delete process.env.STUDIO_VIDEO_ENRICH;
});

describe("B1 — the assetId seam: exactly her one row (P1)", () => {
  it("reads the named clip and nothing else, even with two other unread clips in her library", async () => {
    const target = await seed(HER);
    const other = await seed(HER);
    const read = await seed(HER, {
      metadata: { vision: { ...POSTER_VISION, beats: [] } },
    });
    const r = await enrichVideoChunk({
      athleteId: HER,
      assetId: target,
      chunk: 8,
      loadBytes: async () => BYTES,
    });
    expect(r).toMatchObject({
      total: 1,
      tagged: 1,
      remaining: 0,
      outcomes: [{ id: target, outcome: "tagged" }],
    });
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect((await metaOf(target)).vision.beats).toHaveLength(2);
    expect((await metaOf(other)).vision.beats).toBeUndefined();
    expect((await metaOf(read)).vision.beats).toEqual([]);
  });

  it("selects zero rows for a read clip, an abandoned clip, and a clip that is not hers", async () => {
    const read = await seed(HER, {
      metadata: { vision: { ...POSTER_VISION, beats: [] } },
    });
    const abandoned = await seed(HER, {
      metadata: {
        enrichment: {
          abandoned_at: "2026-09-01T00:00:00Z",
          abandoned_reason: "oversize",
        },
      },
    });
    const theirs = await seed(SOMEONE_ELSE);
    for (const id of [read, abandoned, theirs]) {
      const r = await enrichVideoChunk({
        athleteId: HER,
        assetId: id,
        chunk: 1,
        loadBytes: async () => BYTES,
      });
      expect(r.total).toBe(0);
    }
    expect(generateContent).not.toHaveBeenCalled();
  });
});

describe("B2 — startClipRead: the quote, the booking, the one cap guard", () => {
  it("quotes before it runs and the quote is on the answer and on the row — 'clip read runs unquoted' reds here", async () => {
    const id = await seed(HER);
    const quote = quoteClipReadUsd(6);
    expect(quote).toBeCloseTo(0.008, 4);
    const { answer, done } = await start(id);
    await done;
    expect(answer).toEqual({ status: "done", beats: 2, quotedUsd: quote });
    const m = await metaOf(id);
    expect(m.clip_read).toMatchObject({ state: "done", quotedUsd: quote });
    expect(m.clip_read.billedUsd).toBeCloseTo(BILLED, 3); // the chunk's spentUsd, 4 dp
    expect(m.vision.beats).toHaveLength(2);
  });

  it("books what the model reported against her UTC day — 'read spend not counted against the day cap' reds here", async () => {
    const id = await seed(HER);
    const now = new Date("2026-09-23T10:00:00Z");
    const { done } = await start(id, { now: () => now });
    await done;
    const today = await spentToday(utcDay(now), HER);
    expect(today.get(HER)).toBeCloseTo(BILLED, 6); // booked, not the estimate
    expect((await metaOf(id)).enrich_spend).toMatchObject({
      day: "2026-09-23",
    });
  });

  it("at the day cap it refuses with the chunk's own refusal string, calls no model, books nothing — 'read at cap runs anyway' reds here (P4)", async () => {
    process.env.STUDIO_ENRICH_DAILY_CAP_USD = "0";
    const id = await seed(HER);
    const { answer, done } = await start(id);
    await done;
    expect(answer).toEqual({
      status: "at_cap",
      reason: DAILY_CAP_REFUSAL,
      quotedUsd: quoteClipReadUsd(6),
    });
    expect(generateContent).not.toHaveBeenCalled();
    const m = await metaOf(id);
    expect(m.vision.beats).toBeUndefined();
    expect(m.enrich_spend).toBeUndefined();
    expect(m.clip_read).toMatchObject({
      state: "at_cap",
      reason: DAILY_CAP_REFUSAL,
    });
    // And the picker's list still offers it, unread — the plan appends it as-is (R-1).
    const { json } = await get("/studio/media?kind=clips&origin=generated");
    expect(json.items).toHaveLength(1);
    expect(json.items[0]).toMatchObject({
      assetId: id,
      beats: 0,
      read: { state: "at_cap", reason: DAILY_CAP_REFUSAL },
    });
  });

  it("a read that fails leaves the row unread with a reason, one attempt counted, and the list still offers it (P5)", async () => {
    generateContent.mockRejectedValue(new Error("transport down"));
    const id = await seed(HER);
    const { answer, done } = await start(id);
    await done;
    expect(answer).toMatchObject({
      status: "failed",
      reason: READ_REASONS.failed,
    });
    const m = await metaOf(id);
    expect(m.vision.beats).toBeUndefined();
    expect(m.enrichment.attempts).toBe(1);
    expect(m.clip_read).toMatchObject({
      state: "failed",
      reason: READ_REASONS.failed,
    });
    const { json } = await get("/studio/media?kind=clips&origin=generated");
    expect(json.items[0]).toMatchObject({
      assetId: id,
      beats: 0,
      read: { state: "failed" },
    });
    // And it can be read again — a failure never blocks the next tap.
    generateContent.mockResolvedValue({
      text: JSON.stringify(CLIP_JSON),
      usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 700 },
    });
    const again = await start(id);
    await again.done;
    expect(again.answer).toMatchObject({ status: "done", beats: 2 });
  });

  it("answers `reading` past the grace and finishes in the background; a second tap meanwhile is refused as reading", async () => {
    let release!: () => void;
    generateContent.mockImplementation(
      () =>
        new Promise((r) => {
          release = () =>
            r({
              text: JSON.stringify(CLIP_JSON),
              usageMetadata: {
                promptTokenCount: 1500,
                candidatesTokenCount: 700,
              },
            });
        }),
    );
    const id = await seed(HER);
    const first = await start(id, { graceMs: 20 });
    expect(first.answer).toEqual({
      status: "reading",
      quotedUsd: quoteClipReadUsd(6),
    });
    const second = await start(id, { graceMs: 20 });
    expect(second.answer).toEqual({
      status: "reading",
      quotedUsd: quoteClipReadUsd(6),
    });
    expect(generateContent).toHaveBeenCalledTimes(1);
    release();
    await first.done;
    expect((await metaOf(id)).clip_read.state).toBe("done");
  });

  it("an already-read clip is answered from the row, no model", async () => {
    const id = await seed(HER, {
      metadata: { vision: { ...POSTER_VISION, beats: CLIP_JSON.beats } },
    });
    const { answer } = await start(id);
    expect(answer).toEqual({ status: "already_read", beats: 2 });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("a clip with no poster yet is not ready — the quote is real only after the transcode measured it", async () => {
    const id = await seed(HER, { gcs_thumb_path: null });
    const { answer } = await start(id);
    expect(answer).toMatchObject({
      status: "not_ready",
      reason: READ_REASONS.notReady,
    });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("an image is refused — 'image asset gets a read affordance' reds here (server half)", async () => {
    const id = await image(HER);
    const { answer } = await start(id);
    expect(answer).toMatchObject({ status: "not_video" });
    expect(generateContent).not.toHaveBeenCalled();
    expect((await metaOf(id)).clip_read).toBeUndefined();
  });

  it("another athlete's clip is not found, before any model call — 'another athlete's clip is not found' reds here", async () => {
    const id = await seed(SOMEONE_ELSE);
    const { answer } = await start(id);
    expect(answer).toEqual({ status: "not_found" });
    expect(generateContent).not.toHaveBeenCalled();
    expect((await metaOf(id)).clip_read).toBeUndefined();
  });
});

describe("R-7 — a dead read never blocks the next one", () => {
  const stale = () =>
    new Date(Date.now() - clipReadStaleMs() - 1_000).toISOString();
  const fresh = () => new Date(Date.now() - 10_000).toISOString();

  it("a `reading` mark older than 2× the call bound reads as failed ('read didn't finish') — 'a dead read stays reading forever' reds here", () => {
    const dead = clipReadStateOf(
      readInputOf(
        {
          clip_read: { state: "reading", startedAt: stale(), quotedUsd: 0.008 },
        },
        6,
      ),
      new Date(),
    );
    expect(dead).toMatchObject({ state: "failed", reason: READ_REASONS.dead });
    const live = clipReadStateOf(
      readInputOf(
        {
          clip_read: { state: "reading", startedAt: fresh(), quotedUsd: 0.008 },
        },
        6,
      ),
      new Date(),
    );
    expect(live).toMatchObject({ state: "reading" });
  });

  it("a new read is allowed over a dead mark and refused over a live one", async () => {
    const dead = await seed(HER, {
      metadata: {
        vision: POSTER_VISION,
        clip_read: { state: "reading", startedAt: stale(), quotedUsd: 0.008 },
      },
    });
    const live = await seed(HER, {
      metadata: {
        vision: POSTER_VISION,
        clip_read: { state: "reading", startedAt: fresh(), quotedUsd: 0.008 },
      },
    });
    const a = await start(dead);
    await a.done;
    expect(a.answer).toMatchObject({ status: "done", beats: 2 });
    const b = await start(live);
    expect(b.answer).toMatchObject({ status: "reading" });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});

describe("the state, as the list and the detail serve it (B4, P3)", () => {
  it("unread · done · abandoned, on GET /studio/media rows — with the quote on an unread row", async () => {
    const unread = await seed(HER);
    const done = await seed(HER, {
      metadata: { vision: { ...POSTER_VISION, beats: [] } },
    });
    const oversize = await seed(HER, {
      metadata: {
        vision: POSTER_VISION,
        enrichment: {
          abandoned_at: "2026-09-01T00:00:00Z",
          abandoned_reason: "oversize",
        },
      },
    });
    const { json } = await get(
      "/studio/media?kind=clips&origin=generated&limit=10",
    );
    const by = Object.fromEntries(json.items.map((r: any) => [r.assetId, r]));
    expect(by[unread]).toMatchObject({
      beats: 0,
      read: { state: "unread", quotedUsd: quoteClipReadUsd(6) },
    });
    // A read that found no beats is DONE, not unread: the tray never quotes a second read of it.
    expect(by[done]).toMatchObject({
      beats: 0,
      read: { state: "done", beats: 0 },
    });
    expect(by[oversize]).toMatchObject({
      read: { state: "failed", reason: READ_REASONS.oversize },
    });
  });

  it("GET /media/:id carries `read` for a video — a poster-tagged video is NOT done — and null for an image", async () => {
    const posterOnly = await seed(HER);
    const img = await image(HER);
    const v = await get(`/media/${posterOnly}`);
    expect(v.status).toBe(200);
    expect(v.json.vision).toEqual(POSTER_VISION); // has vision…
    expect(v.json.read).toMatchObject({ state: "unread" }); // …and is not analyzed as a clip
    const i = await get(`/media/${img}`);
    expect(i.json.read).toBeNull();
  });
});

describe("the route — POST /studio/media/:id/read", () => {
  it("is not there with STUDIO_CLIP_READ off, nor with STUDIO_VIDEO_ENRICH off — 'the read route is there with the flag off' reds here (P7)", async () => {
    const id = await seed(HER);
    process.env.STUDIO_CLIP_READ = "false";
    expect((await post(id)).status).toBe(404);
    process.env.STUDIO_CLIP_READ = "true";
    process.env.STUDIO_VIDEO_ENRICH = "false";
    expect((await post(id)).status).toBe(404);
    expect(generateContent).not.toHaveBeenCalled();
    expect((await metaOf(id)).clip_read).toBeUndefined();
  });

  it("reads her clip through the worker's one door and answers the outcome with the quote", async () => {
    const id = await seed(HER);
    const { status, json } = await post(id);
    expect(status).toBe(200);
    expect(json).toEqual({
      status: "done",
      beats: 2,
      quotedUsd: quoteClipReadUsd(6),
    });
    expect((await metaOf(id)).vision.beats).toHaveLength(2);
  });

  it("404 for a malformed id, another athlete's clip and a deleted clip; 409 for an image", async () => {
    expect((await post("not-a-uuid")).status).toBe(404);
    expect((await post(await seed(SOMEONE_ELSE))).status).toBe(404);
    expect(
      (await post(await seed(HER, { deleted_at: new Date() }))).status,
    ).toBe(404);
    const img = await post(await image(HER));
    expect(img.status).toBe(409);
    expect(img.json).toMatchObject({ status: "not_video" });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("at cap, the answer is the refusal — status at_cap, the chunk's reason — never a 5xx", async () => {
    process.env.STUDIO_ENRICH_DAILY_CAP_USD = "0";
    const { status, json } = await post(await seed(HER));
    expect(status).toBe(200);
    expect(json).toMatchObject({ status: "at_cap", reason: DAILY_CAP_REFUSAL });
  });
});
