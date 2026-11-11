/**
 * studio.media.test.ts — GET /studio/media, the shared Studio picker's list, against real SQL.
 *
 * PGlite in memory (server/testUtils/pgliteDb.ts); signing mocked at the storage boundary.
 *
 * REVERT CHECKS, red by name:
 *   RC2a  drop the athlete clause from herPhoto          → "hers only — another athlete's photo is the same answer as none"
 *   RC2b  drop `OR date IS NULL` from the dated cursor   → "walks from the dated rows into the undated tail, and through it"
 *   RC2c  drop the still narrowing                       → "a still list drops HEIC, which the stitch refuses by name"
 *   RC2d  carry the cursor key at millisecond precision  → "keeps microseconds — two rows a microsecond apart are neither skipped nor repeated"
 *   RC2e  drop the origin narrowing                      → "narrows by origin — uploads, made here, and synced as connected with discovery"
 *
 * GET /studio/media/search:
 *   RC3a  rank every row of hers, not the predicate's     → "a video — one with a poster included — never comes back from a photos search, and a deleted photo never at all"
 *   RC3b  answer a failed embed with the browse order     → "a failed embed says search is unavailable — never a list ranked by anything else"
 *   RC3c  cut the top 60 BEFORE the origin filter          → "an uploads-only search is ranked among her uploads — no number of closer synced posts can crowd it out"
 *   RC3d  drop the athlete clause from herPhoto            → "search is hers only — another athlete's closer photo never appears"
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
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
jest.mock("../lib/mediaStore", () => ({
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
  saveBuffer: jest.fn(),
  rehostFromUrl: jest.fn(),
  uploadLocalFile: jest.fn(),
  UPLOAD_LIMITS: {
    image: { max: 25 * 1024 * 1024, types: [] },
    video: { max: 200 * 1024 * 1024, types: [] },
  },
}));

jest.mock("../lib/mediaEmbed", () => ({
  embedText: jest.fn(async () => [1, 0, 0]),
  embedImageGcs: jest.fn(),
  embedImageGcsWithReason: jest.fn(),
  cosine: (a: number[], b: number[]) => {
    let dot = 0,
      na = 0,
      nb = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import studioRouter from "./studio";
import { athletes, generationJobs, mediaAssets } from "../../shared/schema";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import { embedText } from "../lib/mediaEmbed";
import {
  MEDIA_PAGE_DEFAULT,
  MEDIA_SEARCH_LIMIT,
  MEDIA_SEARCH_UNAVAILABLE,
} from "../studio/mediaList";

const HER = "22222222-1111-4444-8555-666666666666";
const SOMEONE_ELSE = "99999999-1111-4777-8666-555555555555";

let server: Server;
let base: string;

const asUser = (id: string | undefined) => {
  (globalThis as any).__TEST_ATHLETE_ID = id;
};

const get = async (path: string) => {
  const res = await fetch(`${base}${path}`);
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as any,
  };
};

type Row = { kind: string; assetId: string; [k: string]: unknown };

/** One page of the list. */
const page = async (
  query: string,
): Promise<{ items: Row[]; nextCursor: string | null }> => {
  const { status, json } = await get(`/studio/media?${query}`);
  expect(status).toBe(200);
  return json;
};

/** Every page, following `nextCursor` until it is null — the ids in the order they were served. */
const walk = async (query: string): Promise<string[]> => {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 100; guard++) {
    const p = await page(
      cursor ? `${query}&cursor=${encodeURIComponent(cursor)}` : query,
    );
    ids.push(...p.items.map((r) => r.assetId));
    if (!p.nextCursor) return ids;
    cursor = p.nextCursor;
  }
  throw new Error("the cursor never ended");
};

async function seed(
  owner: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: owner,
      platform: "upload",
      origin: "upload",
      media_type: "IMAGE",
      status: "stored",
      gcs_path: `athletes/${owner}/${Math.random().toString(36).slice(2)}.jpg`,
      content_type: "image/jpeg",
      bytes: 1_000,
      ingested_at: new Date(),
      ...over,
    } as never)
    .returning({ id: mediaAssets.id });
  return row.id;
}

const clip = (owner: string, over: Record<string, unknown> = {}) =>
  seed(owner, {
    media_type: "VIDEO",
    content_type: "video/mp4",
    gcs_path: `athletes/${owner}/${Math.random().toString(36).slice(2)}.mp4`,
    duration_seconds: 8,
    ...over,
  });

const ids = (rows: Row[]) => rows.map((r) => r.assetId);
const mockEmbed = embedText as jest.MockedFunction<typeof embedText>;
/** A stored embedding, as enrichment writes it into metadata. */
const emb = (v: number[], extra: Record<string, unknown> = {}) => ({
  metadata: { embedding: v, ...extra },
});
const sorted = (xs: string[]) => [...xs].sort();

beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values([
    { id: HER, full_name: "Media Route Athlete" },
    { id: SOMEONE_ELSE, full_name: "Another Athlete" },
  ] as never);
  process.env.STUDIO_ENABLED = "true";

  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", studioRouter);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/me`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await closeTestDb();
  delete process.env.STUDIO_ENABLED;
});

beforeEach(async () => {
  await db.delete(mediaAssets);
  jest.clearAllMocks();
  mockEmbed.mockResolvedValue([1, 0, 0]);
  asUser(HER);
});

// ─── What a mount may offer ─────────────────────────────────────────────────────────────────────

describe("GET /studio/media — what a mount may offer", () => {
  it("hers only — another athlete's photo is the same answer as none", async () => {
    const mine = await seed(HER);
    await seed(SOMEONE_ELSE);
    await clip(SOMEONE_ELSE);

    expect(ids((await page("kind=photos")).items)).toEqual([mine]);
    expect((await page("kind=clips")).items).toEqual([]);
  });

  it("offers photos exactly as the photo predicate does — never a deleted, failed, child, byteless or video row, a video with a poster included", async () => {
    const photo = await seed(HER);
    const album = await seed(HER, { media_type: "CAROUSEL_ALBUM" });
    await seed(HER, { deleted_at: new Date() });
    await seed(HER, { status: "failed" });
    await seed(HER, { parent_media_id: "album-1" });
    await seed(HER, { gcs_path: null });
    // An Instagram video row whose gcs_path holds its POSTER: a JPEG in the path, VIDEO in the type.
    // searchMedia would hand this back looking like a still; our predicate asks the type.
    await seed(HER, {
      media_type: "VIDEO",
      origin: "connected",
      content_type: "image/jpeg",
    });
    await clip(HER);

    const rows = (await page("kind=photos")).items;

    expect(sorted(ids(rows))).toEqual(sorted([photo, album]));
    expect(rows.every((r) => r.kind === "photo")).toBe(true);
  });

  it("offers clips exactly as a stitch accepts them — a video type with video bytes, never a poster-only row or a photo", async () => {
    const video = await clip(HER);
    const reel = await clip(HER, { media_type: "REELS" });
    await clip(HER, { origin: "connected", content_type: "image/jpeg" });
    await clip(HER, { deleted_at: new Date() });
    await seed(HER);

    const rows = (await page("kind=clips")).items;

    expect(sorted(ids(rows))).toEqual(sorted([video, reel]));
    expect(rows.every((r) => r.kind === "clip")).toBe(true);
  });

  it("a still list drops HEIC, which the stitch refuses by name", async () => {
    const jpeg = await seed(HER);
    const png = await seed(HER, { content_type: "image/png" });
    const heic = await seed(HER, { content_type: "image/heic" });

    expect(sorted(ids((await page("kind=photos&still=1")).items))).toEqual(
      sorted([jpeg, png]),
    );
    // The same photo is offered where it is not being held in a video.
    expect(ids((await page("kind=photos")).items)).toContain(heic);
  });

  it("offers an untagged photo — she is choosing by eye, not by tag", async () => {
    const untagged = await seed(HER, { metadata: null });
    const tagged = await seed(HER, {
      metadata: { vision: { athlete_present: true, shot_type: "action" } },
    });

    expect(sorted(ids((await page("kind=photos")).items))).toEqual(
      sorted([untagged, tagged]),
    );
  });

  it("narrows by origin — uploads, made here, and synced as connected with discovery", async () => {
    const upload = await seed(HER, { origin: "upload" });
    const made = await seed(HER, { origin: "generated" });
    const connected = await seed(HER, {
      origin: "connected",
      platform: "instagram",
    });
    const discovery = await seed(HER, {
      origin: "discovery",
      platform: "tiktok",
    });

    expect(ids((await page("kind=photos&origin=upload")).items)).toEqual([
      upload,
    ]);
    expect(
      sorted(ids((await page("kind=photos&origin=upload,generated")).items)),
    ).toEqual(sorted([upload, made]));
    expect(
      sorted(ids((await page("kind=photos&origin=synced")).items)),
    ).toEqual(sorted([connected, discovery]));
    expect((await page("kind=photos")).items).toHaveLength(4);
  });

  it("signs the photo and its thumbnail, and a clip's poster as null — never the mp4 — before one exists", async () => {
    const withThumb = await seed(HER, {
      gcs_thumb_path: `athletes/${HER}/thumb.jpg`,
    });
    const bare = await seed(HER, { ingested_at: new Date(Date.now() - 1_000) });
    const postered = await clip(HER, {
      gcs_thumb_path: `athletes/${HER}/poster.jpg`,
      duration_seconds_precise: 5.25,
    });
    const posterless = await clip(HER, {
      ingested_at: new Date(Date.now() - 1_000),
    });

    const photos = new Map(
      (await page("kind=photos")).items.map((r) => [r.assetId, r]),
    );
    const clips = new Map(
      (await page("kind=clips")).items.map((r) => [r.assetId, r]),
    );

    expect(photos.get(withThumb)).toMatchObject({
      kind: "photo",
      thumbUrl: `https://signed.example/athletes/${HER}/thumb.jpg`,
      origin: "upload",
    });
    expect(photos.get(withThumb)?.imageUrl).toMatch(
      /^https:\/\/signed\.example\/.+\.jpg$/,
    );
    expect(photos.get(bare)?.thumbUrl).toBe(photos.get(bare)?.imageUrl);
    expect(clips.get(postered)).toMatchObject({
      kind: "clip",
      posterUrl: `https://signed.example/athletes/${HER}/poster.jpg`,
      durationSec: 8,
      durationPreciseSec: 5.25,
    });
    expect(clips.get(posterless)?.videoUrl).toMatch(/\.mp4$/);
    expect(clips.get(posterless)?.posterUrl).toBeNull();
    expect(clips.get(posterless)?.durationPreciseSec).toBeNull();
  });

  it("serves a clip's beat count — the beats its clip read wrote, 0 before one (enrichment fixes)", async () => {
    const read = await clip(HER, {
      metadata: {
        vision: {
          athlete_present: true,
          beats: [
            { start_s: 0, end_s: 3 },
            { start_s: 3, end_s: 8 },
          ],
        },
      },
    });
    const unread = await clip(HER, {
      ingested_at: new Date(Date.now() - 1_000),
      metadata: { vision: { athlete_present: true } },
    });
    const clips = new Map(
      (await page("kind=clips")).items.map((r) => [r.assetId, r]),
    );
    expect(clips.get(read)).toMatchObject({ kind: "clip", beats: 2 });
    expect(clips.get(unread)).toMatchObject({ kind: "clip", beats: 0 });
  });
});

// ─── The order and the cursor ───────────────────────────────────────────────────────────────────

describe("GET /studio/media — the order and the cursor", () => {
  const at = (iso: string) => new Date(iso);

  it("orders each row by its own date — what she just made above an old shoot", async () => {
    const oldShoot = await seed(HER, { posted_at: at("2025-06-01T12:00:00Z") });
    const justMade = await seed(HER, {
      origin: "generated",
      posted_at: null,
      ingested_at: new Date(),
    });
    const yesterday = await seed(HER, {
      posted_at: new Date(Date.now() - 86_400_000),
    });

    expect(ids((await page("kind=photos")).items)).toEqual([
      justMade,
      yesterday,
      oldShoot,
    ]);
  });

  it("walks past 24 in order, serving every row exactly once", async () => {
    const seeded: string[] = [];
    for (let i = 0; i < MEDIA_PAGE_DEFAULT + 6; i++) {
      seeded.push(
        await seed(HER, { posted_at: new Date(Date.UTC(2026, 0, 1, 0, i)) }),
      );
    }
    const first = await page("kind=photos");

    expect(first.items).toHaveLength(MEDIA_PAGE_DEFAULT);
    expect(first.nextCursor).not.toBeNull();
    // Newest first, so the walk is the seeding order reversed.
    expect(await walk("kind=photos")).toEqual([...seeded].reverse());
  });

  it("walks from the dated rows into the undated tail, and through it", async () => {
    const dated = [
      await seed(HER, { posted_at: at("2026-03-03T00:00:00Z") }),
      await seed(HER, { posted_at: at("2026-02-02T00:00:00Z") }),
      await seed(HER, { posted_at: at("2026-01-01T00:00:00Z") }),
    ];
    const undated: string[] = [];
    for (let i = 0; i < 5; i++)
      undated.push(await seed(HER, { posted_at: null, ingested_at: null }));

    const served = await walk("kind=photos&limit=2");

    // Dated first, newest first; then the undated tail by id, as the order says — each exactly once.
    expect(served).toEqual([...dated, ...sorted(undated).reverse()]);
  });

  it("keeps microseconds — two rows a microsecond apart are neither skipped nor repeated at a page edge", async () => {
    const [a] = await db
      .insert(mediaAssets)
      .values({
        athlete_id: HER,
        platform: "upload",
        origin: "upload",
        media_type: "IMAGE",
        status: "stored",
        gcs_path: `athletes/${HER}/a.jpg`,
        content_type: "image/jpeg",
        ingested_at: sql`'2026-09-01 12:00:00.000001+00'::timestamptz`,
      } as never)
      .returning({ id: mediaAssets.id });
    const [b] = await db
      .insert(mediaAssets)
      .values({
        athlete_id: HER,
        platform: "upload",
        origin: "upload",
        media_type: "IMAGE",
        status: "stored",
        gcs_path: `athletes/${HER}/b.jpg`,
        content_type: "image/jpeg",
        ingested_at: sql`'2026-09-01 12:00:00.000002+00'::timestamptz`,
      } as never)
      .returning({ id: mediaAssets.id });

    expect(await walk("kind=photos&limit=1")).toEqual([b.id, a.id]);
  });

  it("refuses a cursor it never handed out, and a list it cannot make", async () => {
    const refusals: [string, string][] = [
      ["kind=photos&cursor=not-a-cursor", "cursor"],
      [
        `kind=photos&cursor=${Buffer.from(JSON.stringify({ k: "yesterday", id: HER })).toString("base64url")}`,
        "cursor",
      ],
      ["", "kind"],
      ["kind=albums", "kind"],
      ["kind=clips&still=1", "still"],
      ["kind=photos&origin=instagram", "origin"],
      ["kind=photos&limit=0", "limit"],
      ["kind=photos&limit=61", "limit"],
    ];
    for (const [query, field] of refusals) {
      const { status, json } = await get(`/studio/media?${query}`);
      expect({ query, status, field: json?.field }).toEqual({
        query,
        status: 400,
        field,
      });
    }
  });

  it("does not exist with STUDIO_ENABLED off", async () => {
    expect((await get("/studio/media?kind=photos")).status).toBe(200);
    process.env.STUDIO_ENABLED = "false";
    try {
      expect((await get("/studio/media?kind=photos")).status).toBe(404);
    } finally {
      process.env.STUDIO_ENABLED = "true";
    }
  });
});

// ─── GET /studio/media/search ───────────────────────────────────────────────────────────────────

describe("GET /studio/media — PR 12: hero first, the unread, then the rejects (STUDIO_LIBRARY_FIELDS)", () => {
  const vision = (over: Record<string, unknown>) => ({
    metadata: {
      vision: {
        athlete_present: true,
        subject: "the_athlete",
        shot_type: "portrait",
        disposition: "as_is",
        ...over,
      },
    },
  });
  afterEach(() => {
    delete process.env.STUDIO_LIBRARY_FIELDS;
  });

  /**
   * P-picker. ⚠️ MUTATIONS: "picker ignores hero_suitability" — `mediaOrderFor` returns the date order
   * for photos (the first assertion reds), or `mediaAfter` drops the rank arm (the walk repeats rows).
   * "picker hides or unlabels a reject-disposition photo" — drop the reject from the list, or serve
   * it without `reject: true` (the last two assertions red).
   */
  /** ⚠️ MUTATION "a someone-else row ranks above her rows": drop the -1.5 arm of PHOTO_RANK_SQL — the stranger at 0.99 leads and this reds by name. */
  it("serves 12 photos as hero desc, recency within a rank, the 2 untagged next, then someone else and made-here-not-her, the reject last and labelled — and page 2 continues the order", async () => {
    process.env.STUDIO_LIBRARY_FIELDS = "true";
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, i));
    const heros = [0.9, 0.3, 0.7, 0.5, 0.7, 0.1, 0.8];
    const tagged: string[] = [];
    for (let i = 0; i < heros.length; i++)
      tagged.push(
        await seed(HER, {
          posted_at: at(i),
          ...vision({ hero_suitability: heros[i] }),
        }),
      );
    const untaggedOld = await seed(HER, { posted_at: at(20) });
    const untaggedNew = await seed(HER, { posted_at: at(21) });
    // Amended 24 Sep: someone else — the tagger's word, or made here without her — below the unread, above the reject.
    const stranger = await seed(HER, {
      posted_at: at(25),
      ...vision({ hero_suitability: 0.99, subject: "another_person" }),
    });
    const [job] = await db
      .insert(generationJobs)
      .values({
        athlete_id: HER,
        origin: "system",
        mode: "generate",
        objective: "grow-following",
        deliverable: "post",
        brief: { job: { references: [] } },
        status: "succeeded",
      } as never)
      .returning({ id: generationJobs.id });
    const madeNotHer = await seed(HER, {
      posted_at: at(24),
      origin: "generated",
      generation_job_id: job.id,
      ...vision({ hero_suitability: 0.99 }),
    });
    const reject = await seed(HER, {
      posted_at: at(30),
      ...vision({ hero_suitability: 0.95, disposition: "reject" }),
    });

    const expected = [
      tagged[0],
      tagged[6],
      tagged[4],
      tagged[2],
      tagged[3],
      tagged[1],
      tagged[5], // 0.9 0.8 0.7(newer) 0.7 0.5 0.3 0.1
      untaggedNew,
      untaggedOld,
      stranger, // -1.5, newer first
      madeNotHer,
      reject,
    ];
    expect(await walk("kind=photos&limit=4")).toEqual(expected);
    expect(await walk("kind=photos&limit=3")).toEqual(expected);

    const rows = (await page("kind=photos&limit=12")).items;
    expect(rows.map((r) => r.assetId)).toEqual(expected);
    expect(rows[0]).toMatchObject({
      tagged: true,
      subject: "the_athlete",
      shotType: "portrait",
      reject: false,
    });
    expect(rows[7]).toMatchObject({
      tagged: false,
      subject: null,
      shotType: null,
      reject: false,
    });
    expect(rows[9]).toMatchObject({ subject: "another_person" });
    expect(rows[10]).toMatchObject({ madeHereNotHer: true });
    expect(rows[11]).toMatchObject({ tagged: true, reject: true });
  });

  it("a pre-ternary row's subject is read off the boolean; a clip list ranks off its poster tag too, with the fields and a three-key cursor (ruling 24 Sep)", async () => {
    process.env.STUDIO_LIBRARY_FIELDS = "true";
    const old = await seed(HER, {
      metadata: { vision: { athlete_present: true } },
    });
    expect((await page("kind=photos")).items[0]).toMatchObject({
      assetId: old,
      subject: "the_athlete",
    });
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, i));
    const low = await clip(HER, {
      posted_at: at(2),
      gcs_thumb_path: "p.jpg",
      ...vision({ hero_suitability: 0.2, subject: "another_person" }),
    });
    const untagged = await clip(HER, {
      posted_at: at(1),
      gcs_thumb_path: "p.jpg",
    });
    const high = await clip(HER, {
      posted_at: at(0),
      gcs_thumb_path: "p.jpg",
      ...vision({ hero_suitability: 0.9 }),
    });
    const first = await page("kind=clips&limit=2");
    // Amended 24 Sep: the another_person clip ranks below the unread one, whatever its hero.
    expect(ids(first.items)).toEqual([high, untagged]);
    expect(first.items[1]).toMatchObject({ tagged: false });
    expect(
      JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString()),
    ).toHaveProperty("h", -1);
    const all = (await page("kind=clips&limit=3")).items;
    expect(ids(all)).toEqual([high, untagged, low]);
    expect(all[2]).toMatchObject({
      tagged: true,
      subject: "another_person",
      shotType: "portrait",
      reject: false,
    });
    expect(await walk("kind=clips&limit=2")).toEqual([high, untagged, low]);
  });

  /** Ruling 24 Sep. ⚠️ MUTATION: drop `identityBound` from MEDIA_COLUMNS / `madeHereNotHer` from tagFields — the first two red. */
  it("a made-here row whose job carried no person reference serves madeHereNotHer — off the job, not the tag; from her, or another athlete's job, it does not", async () => {
    process.env.STUDIO_LIBRARY_FIELDS = "true";
    const job = async (owner: string, references: unknown[]) =>
      (
        await db
          .insert(generationJobs)
          .values({
            athlete_id: owner,
            origin: "system",
            mode: "generate",
            objective: "grow-following",
            deliverable: "post",
            brief: { job: { references } },
            status: "succeeded",
          } as never)
          .returning({ id: generationJobs.id })
      )[0].id;
    const noHer = await seed(HER, {
      origin: "generated",
      generation_job_id: await job(HER, [{ role: "product" }]),
      ...vision({ hero_suitability: 0.9 }),
    });
    const fromHer = await seed(HER, {
      origin: "generated",
      generation_job_id: await job(HER, [{ role: "person" }]),
      ...vision({ hero_suitability: 0.8 }),
    });
    const theirJob = await seed(HER, {
      origin: "generated",
      generation_job_id: await job(SOMEONE_ELSE, [{ role: "product" }]),
      ...vision({ hero_suitability: 0.7 }),
    });
    const upload = await seed(HER, { ...vision({ hero_suitability: 0.6 }) });
    const rows = (await page("kind=photos")).items;
    const by = Object.fromEntries(rows.map((r) => [r.assetId, r]));
    expect(by[noHer]).toMatchObject({
      subject: "the_athlete",
      madeHereNotHer: true,
    });
    expect(by[fromHer]).toMatchObject({ madeHereNotHer: false });
    expect(by[theirJob]).toMatchObject({ madeHereNotHer: false }); // unknown, never "not from her"
    expect(by[upload]).toMatchObject({ madeHereNotHer: false });
  });

  /** ⚠️ MUTATION "stale cursor strands the picker": `cursorFits` accepts either shape — the 400s here become 200s. */
  it("a cursor from the other order is refused — the flag flipped under her, either way", async () => {
    for (let i = 0; i < 3; i++)
      await seed(HER, {
        posted_at: new Date(Date.UTC(2026, 0, 1, 0, i)),
        ...vision({ hero_suitability: 0.5 }),
      });
    const dated = (await page("kind=photos&limit=2")).nextCursor!; // flag off: two keys
    process.env.STUDIO_LIBRARY_FIELDS = "true";
    const ranked = (await page("kind=photos&limit=2")).nextCursor!; // flag on: three keys
    expect(
      JSON.parse(Buffer.from(ranked, "base64url").toString()),
    ).toHaveProperty("h", 0.5);
    const refused = await get(
      `/studio/media?kind=photos&limit=2&cursor=${encodeURIComponent(dated)}`,
    );
    expect([refused.status, refused.json?.field]).toEqual([400, "cursor"]);
    delete process.env.STUDIO_LIBRARY_FIELDS;
    const rankedOnDated = await get(
      `/studio/media?kind=photos&limit=2&cursor=${encodeURIComponent(ranked)}`,
    );
    expect([rankedOnDated.status, rankedOnDated.json?.field]).toEqual([
      400,
      "cursor",
    ]);
  });

  it("with the flag off, a reject and a hero sort by date like everything else, and no tile field is served", async () => {
    const reject = await seed(HER, {
      posted_at: new Date(Date.UTC(2026, 0, 2)),
      ...vision({ hero_suitability: 0.9, disposition: "reject" }),
    });
    const hero = await seed(HER, {
      posted_at: new Date(Date.UTC(2026, 0, 1)),
      ...vision({ hero_suitability: 0.9 }),
    });
    const rows = (await page("kind=photos")).items;
    expect(ids(rows)).toEqual([reject, hero]);
    expect(rows[0]).not.toHaveProperty("tagged");
    expect(rows[0]).not.toHaveProperty("reject");
  });
});

// ─── quality-scrappy (Investigation 12): rows by id, through the mount's own predicate ──────────────────────────────
//
// What an upload made from inside a picker asks. ⚠️ MUTATIONS (docs/probes/quality-scrappy.md): MI2 the route ignores
// `ids` and serves its first page — "a fresh upload ranked below the first page is found by id" reds; MI3 the lookup
// skips the mount's predicate — "answers through the mount's own predicate" reds.
describe("GET /studio/media?ids= — a lookup, not a page (Investigation 12)", () => {
  const read = (hero: number) => ({
    metadata: {
      vision: {
        athlete_present: true,
        subject: "the_athlete",
        shot_type: "portrait",
        disposition: "as_is",
        hero_suitability: hero,
      },
    },
  });
  afterEach(() => {
    delete process.env.STUDIO_LIBRARY_FIELDS;
  });

  it("a fresh upload ranked below the first page is found by id", async () => {
    process.env.STUDIO_LIBRARY_FIELDS = "true";
    for (let i = 0; i < 30; i++) await seed(HER, read(0.5));
    const fresh = await seed(HER); // no vision yet: unread, ranks -1, behind every read photo
    const first = await page("kind=photos&origin=upload,generated");
    expect(ids(first.items)).not.toContain(fresh); // the old check's answer: not on page 1
    const found = await page(
      `kind=photos&origin=upload,generated&ids=${fresh}`,
    );
    expect(ids(found.items)).toEqual([fresh]);
    expect(found.nextCursor).toBeNull();
  });

  it("answers through the mount's own predicate — never another athlete's, a deleted row, a clip on a photo list, or HEIC on a still list", async () => {
    const mine = await seed(HER);
    const theirs = await seed(SOMEONE_ELSE);
    const deleted = await seed(HER, { deleted_at: new Date() });
    const video = await clip(HER);
    const heic = await seed(HER, { content_type: "image/heic" });
    const all = [mine, theirs, deleted, video, heic].join(",");
    expect(ids((await page(`kind=photos&ids=${all}`)).items).sort()).toEqual(
      [heic, mine].sort(),
    );
    expect(ids((await page(`kind=photos&still=1&ids=${all}`)).items)).toEqual([
      mine,
    ]);
    // An origin the mount does not offer is absent too: her upload on a made-here-only list.
    expect(
      ids((await page(`kind=photos&origin=generated&ids=${mine}`)).items),
    ).toEqual([]);
  });

  it("refuses ids it cannot read, too many, and ids with a cursor", async () => {
    const a = await seed(HER);
    await seed(HER);
    for (const bad of [
      "not-a-uuid",
      "",
      Array(13)
        .fill(a)
        .map((_, i) => a.slice(0, -2) + String(i).padStart(2, "0"))
        .join(","),
    ]) {
      const r = await get(`/studio/media?kind=photos&ids=${bad}`);
      expect({ bad, status: r.status, field: r.json?.field }).toEqual({
        bad,
        status: 400,
        field: "ids",
      });
    }
    const { nextCursor } = await page("kind=photos&limit=1");
    const r = await get(
      `/studio/media?kind=photos&ids=${a}&cursor=${encodeURIComponent(nextCursor!)}`,
    );
    expect({ status: r.status, field: r.json?.field }).toEqual({
      status: 400,
      field: "ids",
    });
  });
});

describe("GET /studio/media/search", () => {
  const search = async (query: string) => get(`/studio/media/search?${query}`);
  const found = async (query: string): Promise<string[]> => {
    const { status, json } = await search(query);
    expect(status).toBe(200);
    expect(json.nextCursor).toBeNull();
    return ids(json.items);
  };

  it("ranks her photos by how close they are to her words — popularity and hero score move nothing", async () => {
    const exact = await seed(HER, emb([1, 0, 0]));
    const near = await seed(HER, emb([0.8, 0.6, 0]));
    // Far from her words, and everything searchMedia's other 30% rewards: her in frame, a hero shot,
    // a million likes. Ranked by similarity alone it is still last.
    const popular = await seed(HER, {
      ...emb([0, 1, 0], {
        vision: {
          athlete_present: true,
          athlete_prominence: 1,
          hero_suitability: 1,
          aesthetic_quality: 1,
        },
      }),
      like_count: 1_000_000,
    });

    expect(await found("q=red+dress&kind=photos")).toEqual([
      exact,
      near,
      popular,
    ]);
  });

  it("a video — one with a poster included — never comes back from a photos search, and a deleted photo never at all", async () => {
    await seed(HER, {
      ...emb([1, 0, 0]),
      media_type: "VIDEO",
      origin: "connected",
      content_type: "image/jpeg",
    });
    await seed(HER, { ...emb([1, 0, 0]), deleted_at: new Date() });
    await clip(HER, emb([1, 0, 0]));
    const photo = await seed(HER, emb([0.5, 0.5, 0]));

    expect(await found("q=the+goal&kind=photos")).toEqual([photo]);
  });

  it("searches exactly the rows browsing would offer, under the same filters", async () => {
    const jpeg = await seed(HER, emb([1, 0, 0]));
    await seed(HER, { ...emb([1, 0, 0]), content_type: "image/heic" });
    await seed(HER, { ...emb([1, 0, 0]), origin: "connected" });
    await seed(HER, { ...emb([1, 0, 0]), status: "failed" });
    const made = await seed(HER, {
      ...emb([0.9, 0.1, 0]),
      origin: "generated",
    });
    const filters = "kind=photos&still=1&origin=upload,generated";

    const browsed = ids((await page(filters)).items);
    const searched = await found(`q=anything&${filters}`);

    expect(sorted(searched)).toEqual(sorted(browsed));
    expect(sorted(searched)).toEqual(sorted([jpeg, made]));
  });

  it("an uploads-only search is ranked among her uploads — no number of closer synced posts can crowd it out", async () => {
    // More synced posts than a search serves, every one closer to her words than any upload. A ranker
    // that cuts first and filters after (searchMedia's k) would hand the Board nothing at all.
    await db.insert(mediaAssets).values(
      Array.from({ length: MEDIA_SEARCH_LIMIT + 10 }, (_, i) => ({
        athlete_id: HER,
        platform: "instagram",
        origin: "connected",
        media_type: "IMAGE",
        status: "stored",
        gcs_path: `athletes/${HER}/ig-${i}.jpg`,
        content_type: "image/jpeg",
        ingested_at: new Date(),
        metadata: { embedding: [1, 0, 0] },
      })) as never,
    );
    const uploads = [
      await seed(HER, emb([0.6, 0.8, 0])),
      await seed(HER, emb([0.2, 1, 0])),
      await seed(HER, emb([0, 1, 0])),
    ];

    expect(await found("q=at+the+beach&kind=photos&origin=upload")).toEqual(
      uploads,
    );
  });

  it("offers an untagged photo, and ranks a photo with no embedding after every photo with one", async () => {
    const untagged = await seed(HER, {
      ...emb([0.1, 1, 0]),
      ingested_at: new Date(Date.now() - 60_000),
    });
    const unembedded = await seed(HER, { metadata: null });
    const tagged = await seed(
      HER,
      emb([1, 0, 0], { vision: { athlete_present: true } }),
    );

    expect(await found("q=jersey&kind=photos")).toEqual([
      tagged,
      untagged,
      unembedded,
    ]);
  });

  it("makes one embedText per search — and none when nothing is eligible", async () => {
    await seed(HER, emb([1, 0, 0]));
    await found("q=warmup&kind=photos");
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    expect(mockEmbed).toHaveBeenCalledWith("warmup");

    mockEmbed.mockClear();
    expect(await found("q=warmup&kind=clips")).toEqual([]);
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it("a failed embed says search is unavailable — never a list ranked by anything else", async () => {
    await seed(HER, emb([1, 0, 0]));
    mockEmbed.mockResolvedValueOnce(null);
    expect(await search("q=anything&kind=photos")).toEqual({
      status: 503,
      json: { error: MEDIA_SEARCH_UNAVAILABLE },
    });
    mockEmbed.mockRejectedValueOnce(new Error("embed 500"));
    expect((await search("q=anything&kind=photos")).status).toBe(503);
  });

  it("search is hers only — another athlete's closer photo never appears", async () => {
    await seed(SOMEONE_ELSE, emb([1, 0, 0]));
    const mine = await seed(HER, emb([0, 1, 0]));

    expect(await found("q=anything&kind=photos")).toEqual([mine]);
  });

  it("serves at most 60, on one page with no cursor", async () => {
    await db.insert(mediaAssets).values(
      Array.from({ length: MEDIA_SEARCH_LIMIT + 5 }, (_, i) => ({
        athlete_id: HER,
        platform: "upload",
        origin: "upload",
        media_type: "IMAGE",
        status: "stored",
        gcs_path: `athletes/${HER}/p-${i}.jpg`,
        content_type: "image/jpeg",
        ingested_at: new Date(),
        metadata: { embedding: [1, i / 100, 0] },
      })) as never,
    );
    expect(await found("q=anything&kind=photos")).toHaveLength(
      MEDIA_SEARCH_LIMIT,
    );
  });

  it("refuses a search it cannot make, and does not exist with STUDIO_ENABLED off", async () => {
    for (const [query, field] of [
      ["kind=photos", "q"],
      ["q=a&kind=photos", "q"],
      [`q=${"x".repeat(201)}&kind=photos`, "q"],
      ["q=anything", "kind"],
      ["q=anything&kind=clips&still=1", "still"],
    ] as const) {
      const { status, json } = await search(query);
      expect({ query, status, field: json?.field }).toEqual({
        query,
        status: 400,
        field,
      });
    }
    expect(mockEmbed).not.toHaveBeenCalled();
    process.env.STUDIO_ENABLED = "false";
    try {
      expect((await search("q=anything&kind=photos")).status).toBe(404);
    } finally {
      process.env.STUDIO_ENABLED = "true";
    }
  });
});
