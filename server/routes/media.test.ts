/**
 * Media upload-url — the one-time rights acknowledgment gate.
 *
 * Uploading media is gated on an attestation that the athlete has the rights to the file. The
 * server refuses to mint a signed upload URL until it has one, and records it once per athlete
 * (`athletes.media_rights_ack_at`) so it is never asked again. Both halves matter: refusing
 * without the ack is what makes the attestation real, and persisting it is what makes it
 * one-time. A regression in either is silent — the client just stops being able to upload
 * (which is exactly how the web client broke), or starts uploading without ever attesting.
 *
 * Real Express router against PGlite; GCS signing and enrichment mocked (signing needs a
 * service-account key, so it can't run outside Cloud Run).
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("../lib/mediaStore", () => {
  const actual = jest.requireActual("../lib/mediaStore");
  return {
    ...actual,
    signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
    signedUploadUrl: jest.fn(async (p: string) => `https://signed.example/upload/${p}?sig=abc`),
  };
});
jest.mock("../services/mediaEnrichment", () => ({ enrichNextChunk: jest.fn(async () => {}) }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import mediaRouter from "./media";
import { athletes, generationJobs, mediaAssets } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";

let server: Server;
let base: string;
let athleteId: string;
let otherAthleteId: string;

function asUser(id: string) { (globalThis as any).__TEST_ATHLETE_ID = id; }

async function mint(body: unknown) {
  const res = await fetch(`${base}/media/upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) as any };
}

/** The ack timestamp currently on record for an athlete, or null. */
async function ackAt(id: string): Promise<Date | null> {
  const [row] = await db.select({ ack: athletes.media_rights_ack_at }).from(athletes).where(eq(athletes.id, id)).limit(1);
  return row?.ack ?? null;
}

const PHOTO = { contentType: "image/jpeg", bytes: 2_000_000 };

beforeAll(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/", mediaRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

// A fresh, never-acked athlete per test — "one-time" is a property of athlete state, so these
// cases can't share one row.
beforeEach(async () => {
  athleteId      = await seedAthlete();
  otherAthleteId = await seedAthlete();
  asUser(athleteId);
});

describe("POST /media/upload-url — rights acknowledgment gate", () => {
  it("refuses to mint an upload URL before the athlete has attested", async () => {
    const { status, json } = await mint(PHOTO);

    expect(status).toBe(428);
    expect(json).toEqual({ error: "rights_ack_required" });
    expect(json.uploadUrl).toBeUndefined();
    // A refusal is not an attestation — nothing recorded.
    expect(await ackAt(athleteId)).toBeNull();
  });

  it("does not accept a truthy non-boolean as an attestation", async () => {
    // The gate is `ackRights !== true`. A client that serialises the flag loosely (a "true"
    // string, a 1) must not be able to attest by accident.
    for (const ackRights of ["true", 1, {}, "yes"]) {
      const { status, json } = await mint({ ...PHOTO, ackRights });
      expect(status).toBe(428);
      expect(json).toEqual({ error: "rights_ack_required" });
    }
    expect(await ackAt(athleteId)).toBeNull();
  });

  it("mints the URL and records the attestation when the athlete affirmatively acks", async () => {
    const before = new Date();
    const { status, json } = await mint({ ...PHOTO, ackRights: true });

    expect(status).toBe(200);
    expect(json.uploadUrl).toContain("https://signed.example/upload/");
    expect(json.gcsPath).toMatch(new RegExp(`^athletes/${athleteId}/uploads/`));
    expect(json.kind).toBe("image");

    const recorded = await ackAt(athleteId);
    expect(recorded).toBeInstanceOf(Date);
    expect(recorded!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it("is one-time — later uploads succeed without sending the flag again", async () => {
    await mint({ ...PHOTO, ackRights: true });
    const recorded = await ackAt(athleteId);

    // The client stops sending ackRights entirely once it has been accepted once.
    const { status, json } = await mint({ contentType: "video/mp4", bytes: 10_000_000 });

    expect(status).toBe(200);
    expect(json.kind).toBe("video");
    // Still the ORIGINAL attestation — not re-stamped on every upload.
    expect((await ackAt(athleteId))!.getTime()).toBe(recorded!.getTime());
  });

  it("does not let one athlete's attestation unlock another's uploads", async () => {
    await mint({ ...PHOTO, ackRights: true });
    expect(await ackAt(athleteId)).toBeInstanceOf(Date);

    asUser(otherAthleteId);
    const { status, json } = await mint(PHOTO);

    expect(status).toBe(428);
    expect(json).toEqual({ error: "rights_ack_required" });
    expect(await ackAt(otherAthleteId)).toBeNull();
  });
});

describe("POST /media/upload-url — type and size are checked before the ack", () => {
  it("rejects an unsupported media type", async () => {
    const { status, json } = await mint({ contentType: "application/pdf", bytes: 1000, ackRights: true });
    expect(status).toBe(415);
    expect(json.error).toBe("Unsupported media type");
    // Rejected before the gate — an unusable request must not bank an attestation.
    expect(await ackAt(athleteId)).toBeNull();
  });

  it("rejects a file over the per-kind size limit", async () => {
    const image = await mint({ contentType: "image/jpeg", bytes: 26 * 1024 * 1024, ackRights: true });
    expect(image.status).toBe(413);
    expect(image.json.error).toContain("25MB");

    const video = await mint({ contentType: "video/mp4", bytes: 201 * 1024 * 1024, ackRights: true });
    expect(video.status).toBe(413);
    expect(video.json.error).toContain("200MB");

    expect(await ackAt(athleteId)).toBeNull();
  });

  it("accepts a file at the limit", async () => {
    const { status } = await mint({ contentType: "image/jpeg", bytes: 25 * 1024 * 1024, ackRights: true });
    expect(status).toBe(200);
  });
});

// ─── GET /media — what a video row hands the grid ─────────────────────────────
// The bytes at gcs_path decide the shape, not media_type. An Instagram clip usually holds only
// its poster (image/*) — that is the grid image and there is no mp4 to play. An uploaded clip
// holds the mp4; its grid image exists only once a poster was made. 203 of one athlete's 212
// clips rendered as grey tiles because the client refused any video without gcs_thumb_path.
describe("GET /media — video rows", () => {
  async function insert(v: Record<string, unknown>) {
    await db.insert(mediaAssets).values({
      athlete_id: athleteId, platform: "instagram", origin: "connected", status: "stored",
      posted_at: new Date("2026-08-01T00:00:00Z"), ...v,
    } as any);
  }
  async function list(): Promise<any[]> {
    const res = await fetch(`${base}/media`);
    return ((await res.json()) as any).items;
  }

  it("an Instagram clip stored as its poster shows the poster and has nothing to play", async () => {
    await insert({ media_type: "VIDEO", content_type: "image/jpeg", gcs_path: "ig/poster.jpg", source_media_id: "1" });
    const [item] = await list();
    expect(item.thumb_url).toBe("https://signed.example/ig/poster.jpg");
    expect(item.poster_gcs_path).toBe("ig/poster.jpg");
    expect(item.video_url).toBeNull();
  });

  it("an uploaded clip without a poster shows nothing (never an mp4 to <Image>) but plays", async () => {
    await insert({ platform: "upload", origin: "upload", media_type: "VIDEO", content_type: "video/mp4", gcs_path: `athletes/${athleteId}/uploads/clip.mp4` });
    const [item] = await list();
    expect(item.thumb_url).toBeNull();
    expect(item.poster_gcs_path).toBeNull();
    expect(item.video_url).toBe(`https://signed.example/athletes/${athleteId}/uploads/clip.mp4`);
  });

  it("a clip with a made poster shows the poster and plays the mp4", async () => {
    await insert({ media_type: "REELS", content_type: "video/mp4", gcs_path: "ig/top.mp4", gcs_thumb_path: "ig/top.poster.jpg", source_media_id: "2" });
    const [item] = await list();
    expect(item.thumb_url).toBe("https://signed.example/ig/top.poster.jpg");
    expect(item.poster_gcs_path).toBe("ig/top.poster.jpg");
    expect(item.video_url).toBe("https://signed.example/ig/top.mp4");
  });

  it("a photo is unchanged: its still is both url and thumb", async () => {
    await insert({ media_type: "IMAGE", content_type: "image/jpeg", gcs_path: "ig/still.jpg", source_media_id: "3" });
    const [item] = await list();
    expect(item.thumb_url).toBe("https://signed.example/ig/still.jpg");
    expect(item.video_url).toBeNull();
  });
});

describe("GET /media — PR 12 lane 3: hero first behind STUDIO_LIBRARY_FIELDS, byte-identical with it off", () => {
  const vision = (over: Record<string, unknown>) => ({ vision: { athlete_present: true, subject: "the_athlete", shot_type: "portrait", disposition: "as_is", ...over } });
  async function photo(v: Record<string, unknown>, posted: string, metadata: unknown = null) {
    const [row] = await db.insert(mediaAssets).values({
      athlete_id: athleteId, platform: "upload", origin: "upload", status: "stored", media_type: "IMAGE", content_type: "image/jpeg",
      gcs_path: `athletes/${athleteId}/${Math.random().toString(36).slice(2)}.jpg`, posted_at: new Date(posted), metadata, ...v,
    } as any).returning({ id: mediaAssets.id });
    return row.id;
  }
  async function list(qs: string): Promise<any> {
    const res = await fetch(`${base}/media${qs}`);
    return await res.json();
  }
  async function walk(qs: string): Promise<string[]> {
    const ids: string[] = [];
    let cur: { posted: string; id: string; hero?: number } | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const c = cur ? `&cursor_posted=${encodeURIComponent(cur.posted)}&cursor_id=${cur.id}${cur.hero !== undefined ? `&cursor_hero=${cur.hero}` : ""}` : "";
      const page = await list(`${qs}${c}`);
      ids.push(...page.items.map((i: any) => i.asset_id));
      if (!page.next_cursor) return ids;
      cur = page.next_cursor;
    }
    throw new Error("the cursor never ended");
  }
  afterEach(() => { delete process.env.STUDIO_LIBRARY_FIELDS; });

  /**
   * ⚠️ MUTATION "media list order changes with STUDIO_LIBRARY_FIELDS off": drop `libraryFieldsEnabled()`
   * from `ranked` — the flag-off order and the flag-off keys below both red by name.
   */
  it("with the flag off: date order, the exact item keys of today, no cursor_hero — whatever the tags say", async () => {
    const reject = await photo({}, "2026-08-03T00:00:00Z", vision({ hero_suitability: 0.9, disposition: "reject" }));
    const hero = await photo({}, "2026-08-02T00:00:00Z", vision({ hero_suitability: 0.95 }));
    const untagged = await photo({}, "2026-08-01T00:00:00Z");
    const page = await list("?type=photos");
    expect(page.items.map((i: any) => i.asset_id)).toEqual([reject, hero, untagged]);
    expect(Object.keys(page.items[0]).sort()).toEqual([
      "asset_id", "brand_safe", "brands_visible", "caption", "comments_count", "duration_seconds", "duration_seconds_precise",
      "enriched", "gcs_path", "id", "like_count", "media_type", "origin", "permalink", "platform", "posted_at",
      "poster_gcs_path", "reach", "saves", "shares", "shot_type", "thumb_url", "url", "video_url", "views",
    ]);
    expect(page.items[0]).not.toHaveProperty("subject");
    expect(page.next_cursor).toBeNull();
  });

  it("with the flag on and ?type=photos: hero desc, then the unread, the reject last and labelled — across the cursor; the fields ride every item", async () => {
    process.env.STUDIO_LIBRARY_FIELDS = "true";
    const heros = [0.9, 0.3, 0.7, 0.5, 0.7, 0.1, 0.8];
    const tagged: string[] = [];
    for (let i = 0; i < heros.length; i++) tagged.push(await photo({}, `2026-08-0${i + 1}T00:00:00Z`, vision({ hero_suitability: heros[i] })));
    const untaggedOld = await photo({}, "2026-07-01T00:00:00Z");
    const untaggedNew = await photo({}, "2026-07-02T00:00:00Z");
    // Amended 24 Sep: someone else below the unread, above the reject. ⚠️ MUTATION "a someone-else row ranks above her rows": drop the -1.5 arm — reds.
    const stranger = await photo({}, "2026-08-20T00:00:00Z", vision({ hero_suitability: 0.99, subject: "another_person" }));
    const [job] = await db.insert(generationJobs).values({ athlete_id: athleteId, origin: "system", mode: "generate", objective: "grow-following", deliverable: "post", brief: { job: { references: [] } }, status: "succeeded" } as never).returning({ id: generationJobs.id });
    const madeNotHer = await photo({ origin: "generated", generation_job_id: job.id }, "2026-08-19T00:00:00Z", vision({ hero_suitability: 0.99 }));
    const reject = await photo({}, "2026-08-09T00:00:00Z", vision({ hero_suitability: 0.95, disposition: "reject" }));
    const expected = [tagged[0], tagged[6], tagged[4], tagged[2], tagged[3], tagged[1], tagged[5], untaggedNew, untaggedOld, stranger, madeNotHer, reject];
    expect(await walk("?type=photos")).toEqual(expected);
    const page = await list("?type=photos");
    expect(page.items[0]).toMatchObject({ tagged: true, subject: "the_athlete", hero: 0.9, reject: false, face: "partial" });
    expect(page.items[7]).toMatchObject({ tagged: false, subject: null, hero: null, reject: false, face: null });
    expect(page.items[9]).toMatchObject({ subject: "another_person" });
    expect(page.items[10]).toMatchObject({ madeHereNotHer: true });
    expect(page.items[11]).toMatchObject({ tagged: true, reject: true });
    // Every tab ranks (a video ranks off its poster tag, ruling 24 Sep): "All" leads with the hero, and a video row carries the fields.
    const clip = await photo({ media_type: "VIDEO", content_type: "image/jpeg" }, "2026-08-10T00:00:00Z", vision({ hero_suitability: 0.99 }));
    const all = await list("");
    expect(all.items.map((i: any) => i.asset_id).slice(0, 2)).toEqual([clip, tagged[0]]);
    expect(all.items[0]).toMatchObject({ tagged: true, subject: "the_athlete", hero: 0.99 });
  });
});

describe("GET /media — ruling 24 Sep: made here without her says so, off the job", () => {
  afterEach(() => { delete process.env.STUDIO_LIBRARY_FIELDS; });
  const job = async (owner: string, references: unknown[]) =>
    (await db.insert(generationJobs).values({ athlete_id: owner, origin: "system", mode: "generate", objective: "grow-following", deliverable: "post", brief: { job: { references } }, status: "succeeded" } as never).returning({ id: generationJobs.id }))[0].id;
  async function made(jobId: string | null, origin = "generated"): Promise<string> {
    const [row] = await db.insert(mediaAssets).values({
      athlete_id: athleteId, platform: "upload", origin, status: "stored", media_type: "IMAGE", content_type: "image/jpeg",
      gcs_path: `athletes/${athleteId}/${Math.random().toString(36).slice(2)}.jpg`, posted_at: new Date("2026-08-01T00:00:00Z"),
      generation_job_id: jobId, metadata: { vision: { athlete_present: true, subject: "the_athlete", shot_type: "portrait", disposition: "as_is", hero_suitability: 0.5 } },
    } as any).returning({ id: mediaAssets.id });
    return row.id;
  }

  /** ⚠️ MUTATION "a made-here still with no person reference shows You" (shared library, server half): drop the identityBound lookup in shapeItems — the first assertion reds. */
  it("serves madeHereNotHer true only for a generated row whose OWN job carried no person reference — with the flag on; nothing with it off", async () => {
    const noHer = await made(await job(athleteId, [{ role: "product" }]));
    const fromHer = await made(await job(athleteId, [{ role: "person" }]));
    const theirs = await made(await job(otherAthleteId, [{ role: "product" }]));
    const upload = await made(null, "upload");
    process.env.STUDIO_LIBRARY_FIELDS = "true";
    const on = (await fetch(`${base}/media?type=photos`).then((r) => r.json())) as any;
    const by = Object.fromEntries(on.items.map((i: any) => [i.asset_id, i]));
    expect(by[noHer]).toMatchObject({ subject: "the_athlete", madeHereNotHer: true });
    expect(by[fromHer].madeHereNotHer).toBe(false);
    expect(by[theirs].madeHereNotHer).toBe(false);
    expect(by[upload].madeHereNotHer).toBe(false);
    delete process.env.STUDIO_LIBRARY_FIELDS;
    const off = (await fetch(`${base}/media?type=photos`).then((r) => r.json())) as any;
    expect(off.items[0]).not.toHaveProperty("madeHereNotHer");
  });
});

describe("GET /media — a reference row (origin 'reference', 0062) is never hers to see", () => {
  // A picture she pointed the direction engine at: stored under her id so a plan row can name it,
  // read by that engine alone. ⚠️ MUTATION: drop `ne(mediaAssets.origin, "reference")` from the
  // list, counts or top query in routes/media.ts — this reds by name.
  it("is absent from the items, the counts and the top row", async () => {
    const REF = `athletes/${athleteId}/references/r.jpg`;
    await db.insert(mediaAssets).values([
      { athlete_id: athleteId, platform: "instagram", origin: "connected", status: "stored", media_type: "IMAGE",
        content_type: "image/jpeg", gcs_path: "ig/hers.jpg", source_media_id: "9", posted_at: new Date("2026-08-01T00:00:00Z") },
      { athlete_id: athleteId, platform: "web", origin: "reference", status: "stored", media_type: "IMAGE",
        content_type: "image/jpeg", gcs_path: REF, ingested_at: new Date(), posted_at: new Date("2026-08-02T00:00:00Z"),
        like_count: 1000, metadata: { reference: { url: "https://brand.example/look.jpg" } } },
    ] as any);
    const res = await fetch(`${base}/media`);
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.items.map((i: any) => i.gcs_path)).toContain("ig/hers.jpg");
    expect(body.items.map((i: any) => i.gcs_path)).not.toContain(REF);
    expect(body.top.map((i: any) => i.gcs_path)).not.toContain(REF);
    expect(body.summary.total).toBe(body.items.length);
    // Asking for it by source does not find it either — the exclusion is not a default filter.
    const bySource = (await (await fetch(`${base}/media?source=reference`)).json()) as any;
    expect(bySource.items).toEqual([]);
  });
});
