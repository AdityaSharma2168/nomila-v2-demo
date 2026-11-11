/**
 * studio.stitch.test.ts — the two routes, end to end over HTTP against in-memory Postgres.
 *
 * studio/stitchJobs.test.ts proves the lease and the reaper; studio/stitchRunner.test.ts proves the
 * tick and the memory bound. This file proves the SURFACE:
 *
 *   1. THE SURFACE DOES NOT EXIST unless STUDIO_ENABLED says so, and a 404 rather than a 403 — an
 *      unreleased surface must not be discoverable by the shape of its refusal.
 *   2. NOTHING FROM THE WIRE REACHES ffmpeg. `target` is a name from an allowlist; a resolution, a
 *      codec or a preset in the body is a 400 and is not stored.
 *   3. AN OVER-CAP TIMELINE IS REFUSED BEFORE A ROW EXISTS, with all three caps named.
 *   4. NOT-YOURS AND NOT-FOUND ARE ONE ANSWER, byte for byte, on both routes.
 *   5. THE SPEC IS STORED AS IDS, never paths — a path in a job row is a durable file-read
 *      primitive pointed at whatever a client once wrote there.
 *   6. IT CANNOT SPEND. Queueing a stitch opens no generation job and moves no spend figure.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    if (who !== "no-athlete") req.athleteId = who;
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
// The runner is the kick's target and is not this suite's subject. Mocked so a queue never starts
// an encode — and so the test that the kick FIRES can watch for it.
jest.mock("../studio/stitchRunner", () => ({
  stitchTick: jest.fn(async () => ({})),
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import studioRouter, { STITCH_CLIPS_LIMIT } from "./studio";
import { stitchTick } from "../studio/stitchRunner";
import {
  athletes,
  generationJobs,
  mediaAssets,
  studioPlans,
  studioStitchJobs,
} from "../../shared/schema";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import { maxClips, maxSourceBytes } from "../studio/video/materialize";
import { signedUrl } from "../lib/mediaStore";
import { renderCaptionBand } from "../studio/video/captionRender";
import { STITCH_TARGETS } from "../studio/video/spec";
import type { Caption } from "../studio/video/captions";
import { seedRowsFrom } from "../../client/screens/studio/agentLogic";
import { boardStitch } from "../../client/screens/studio/boardStitch";
import type { AgentPlanItem } from "../../client/hooks/use-studio";

const HER = "22222222-1111-4444-8555-666666666666";
const SOMEONE_ELSE = "99999999-1111-4777-8666-555555555555";
const MISSING = "11111111-1111-4333-8444-555555555555";

let server: Server;
let base: string;

const asUser = (id: string | undefined) => {
  (globalThis as any).__TEST_ATHLETE_ID = id;
};
const mockTick = stitchTick as jest.MockedFunction<typeof stitchTick>;

const post = async (path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
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

async function seedClip(
  owner: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: owner,
      platform: "studio",
      origin: "upload",
      media_type: "VIDEO",
      status: "stored",
      approval_status: "approved",
      gcs_path: `athletes/${owner}/${Math.random().toString(36).slice(2)}.mp4`,
      content_type: "video/mp4",
      bytes: 1_000,
      duration_seconds: 8,
      ingested_at: new Date(),
      ...over,
    } as never)
    .returning({ id: mediaAssets.id });
  return row.id;
}

const timeline = (ids: string[], over: Record<string, unknown> = {}) => ({
  clips: ids.map((assetId) => ({ assetId })),
  target: "portrait",
  ...over,
});

beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values([
    { id: HER, full_name: "Stitch Route Athlete" },
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
  await db.delete(studioStitchJobs);
  await db.delete(mediaAssets);
  jest.clearAllMocks();
  asUser(HER);
});

// ─── 1. The gate ────────────────────────────────────────────────────────────────────────────────

describe("the gate", () => {
  it("404s the whole surface with STUDIO_ENABLED off — not 403", async () => {
    process.env.STUDIO_ENABLED = "false";
    try {
      const a = await post("/studio/stitch", timeline([MISSING]));
      const b = await get(`/studio/stitch/${MISSING}`);
      expect(a.status).toBe(404);
      expect(b.status).toBe(404);
    } finally {
      process.env.STUDIO_ENABLED = "true";
    }
  });

  it("401s an unauthenticated caller and 403s a principal with no athlete", async () => {
    asUser(undefined);
    expect((await post("/studio/stitch", timeline([MISSING]))).status).toBe(
      401,
    );
    asUser("no-athlete");
    expect((await post("/studio/stitch", timeline([MISSING]))).status).toBe(
      403,
    );
  });
});

// ─── 2. Shape, and what may not come off the wire ───────────────────────────────────────────────

describe("POST /studio/stitch — shape", () => {
  it("refuses a body with no target, and names the shapes it will take", async () => {
    const r = await post("/studio/stitch", { clips: [{ assetId: MISSING }] });
    expect(r.status).toBe(400);
    expect(r.json.field).toBe("target");
    expect(r.json.error).toMatch(/portrait.*square.*landscape/);
  });

  it("refuses a RESOLUTION or a CODEC in place of a target name", async () => {
    // ⚠️  THE REVERT CHECK FOR "no target off the wire". target.videoCodec / preset / pixFmt all
    // reach an ffmpeg argv. Accepting an object here — even a well-formed one — is how a client
    // starts choosing this instance's encoder.
    for (const target of [
      { width: 1080, height: 1920, fps: 30 },
      {
        width: 1080,
        height: 1920,
        fps: 30,
        videoCodec: "libx264",
        preset: "placebo",
      },
      "1080x1920",
      "portrait ",
    ]) {
      const r = await post("/studio/stitch", {
        clips: [{ assetId: MISSING }],
        target,
      });
      expect(r.status).toBe(400);
      expect(r.json.field).toBe("target");
    }
    expect(await db.select().from(studioStitchJobs)).toHaveLength(0);
  });

  it("refuses an empty timeline, a non-uuid clip and a bad trim, each by field", async () => {
    const cases: [unknown, string][] = [
      [{ clips: [], target: "portrait" }, "clips"],
      [
        { clips: [{ assetId: "not-a-uuid" }], target: "portrait" },
        "clips[0].assetId",
      ],
      [
        {
          clips: [{ assetId: MISSING, trimStartSec: "3" }],
          target: "portrait",
        },
        "clips[0].trimStartSec",
      ],
      [
        {
          clips: [{ assetId: MISSING, trimStartSec: 5, trimEndSec: 5 }],
          target: "portrait",
        },
        "clips[0].trimEndSec",
      ],
      [
        {
          clips: [{ assetId: MISSING, trimEndSec: Infinity }],
          target: "portrait",
        },
        "clips[0].trimEndSec",
      ],
      [
        {
          clips: [{ assetId: MISSING, crossfadeSec: 0.5 }],
          target: "portrait",
        },
        "clips[0].crossfadeSec",
      ],
    ];
    for (const [body, field] of cases) {
      const r = await post("/studio/stitch", body);
      expect(r.status).toBe(400);
      expect(r.json.field).toBe(field);
    }
  });

  it("refuses a crossfade longer than the cap, and takes one inside it", async () => {
    const a = await seedClip(HER);
    const b = await seedClip(HER);
    const tooLong = await post("/studio/stitch", {
      clips: [{ assetId: a }, { assetId: b, crossfadeSec: 5 }],
      target: "portrait",
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.json.field).toBe("clips[1].crossfadeSec");

    const ok = await post("/studio/stitch", {
      clips: [{ assetId: a }, { assetId: b, crossfadeSec: 0.5 }],
      target: "portrait",
    });
    expect(ok.status).toBe(202);
  });
});

// ─── 3. Tenancy ─────────────────────────────────────────────────────────────────────────────────

describe("POST /studio/stitch — tenancy", () => {
  it("answers the same 404 for another athlete's clip as for one that does not exist", async () => {
    const theirs = await seedClip(SOMEONE_ELSE);
    const notYours = await post("/studio/stitch", timeline([theirs]));
    const notThere = await post("/studio/stitch", timeline([MISSING]));

    expect(notYours.status).toBe(404);
    expect(notYours.json).toEqual(notThere.json); // byte for byte
    expect(notYours.json.error).not.toMatch(
      /athlete|permission|forbidden|yours/i,
    );
    expect(await db.select().from(studioStitchJobs)).toHaveLength(0);
  });

  it("will not join one of hers to one of someone else's", async () => {
    const hers = await seedClip(HER);
    const theirs = await seedClip(SOMEONE_ELSE);
    expect(
      (await post("/studio/stitch", timeline([hers, theirs]))).status,
    ).toBe(404);
    expect(await db.select().from(studioStitchJobs)).toHaveLength(0);
  });

  it("refuses an IMAGE, and a clip whose bytes never arrived", async () => {
    const image = await seedClip(HER, { media_type: "IMAGE" });
    const unstored = await seedClip(HER, { status: "skipped_size" });
    expect((await post("/studio/stitch", timeline([image]))).status).toBe(409);
    expect((await post("/studio/stitch", timeline([unstored]))).status).toBe(
      404,
    );
  });
});

// ─── 4. The caps, stated ────────────────────────────────────────────────────────────────────────

describe("POST /studio/stitch — the caps", () => {
  it("refuses too many clips BEFORE a row exists, naming all three caps", async () => {
    const ids: string[] = [];
    for (let i = 0; i < maxClips() + 1; i++) ids.push(await seedClip(HER));

    const r = await post("/studio/stitch", timeline(ids));
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(
      new RegExp(
        `up to ${maxClips()} clips, \\d+ MB of video and \\d+:\\d\\d of footage`,
      ),
    );
    expect(r.json.error).toMatch(`This one has ${ids.length} clips`);
    expect(await db.select().from(studioStitchJobs)).toHaveLength(0);
  });

  it("refuses a timeline over the source budget, in MB she can act on", async () => {
    const big = await seedClip(HER, { bytes: maxSourceBytes() + 1 });
    const r = await post("/studio/stitch", timeline([big]));
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/needs about \d+ MB/);
  });

  it("charges a clip of UNKNOWN size at the ceiling, never at zero", async () => {
    // The posture the spend gate takes on an unpriced model. Four 200 MB clips is 800 MB, over the
    // 664 MB source budget — so four unknowns must refuse.
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await seedClip(HER, { bytes: null }));
    expect((await post("/studio/stitch", timeline(ids))).status).toBe(409);
  });

  it("queues a still of hers, and stores it as the position she sent", async () => {
    const clip = await seedClip(HER);
    const photo = await seedClip(HER, {
      media_type: "IMAGE",
      content_type: "image/jpeg",
      duration_seconds: null,
    });
    const r = await post("/studio/stitch", {
      clips: [
        { assetId: clip },
        { assetId: photo, stillSec: 2, crossfadeSec: 0.5 },
      ],
      target: "portrait",
    });
    expect(r.status).toBe(202);
    const [row] = await db
      .select({ spec: studioStitchJobs.spec })
      .from(studioStitchJobs)
      .where(eq(studioStitchJobs.id, r.json.stitchId));
    expect((row.spec as any).clips[1]).toEqual({
      assetId: photo,
      stillSec: 2,
      crossfadeSec: 0.5,
    });
  });

  it("answers another athlete's photo as a still exactly as it answers one that does not exist", async () => {
    const theirs = await seedClip(SOMEONE_ELSE, {
      media_type: "IMAGE",
      content_type: "image/jpeg",
    });
    const foreign = await post("/studio/stitch", {
      clips: [{ assetId: theirs, stillSec: 2 }],
      target: "portrait",
    });
    const absent = await post("/studio/stitch", {
      clips: [{ assetId: MISSING, stillSec: 2 }],
      target: "portrait",
    });
    expect(foreign.status).toBe(404);
    expect(foreign.json).toEqual(absent.json);
  });

  it("refuses a HEIC still at the door, pointed at the timeline, before any row exists", async () => {
    const heic = await seedClip(HER, {
      media_type: "IMAGE",
      content_type: "image/heic",
    });
    const before = (await db.select().from(studioStitchJobs)).length;
    const r = await post("/studio/stitch", {
      clips: [{ assetId: heic, stillSec: 2 }],
      target: "portrait",
    });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ field: "clips" });
    expect(r.json.error).toMatch(/HEIC/);
    expect((await db.select().from(studioStitchJobs)).length).toBe(before);
  });

  it("hands the caps back on every answer, so the UI can state them first", async () => {
    const a = await seedClip(HER);
    const queued = await post("/studio/stitch", timeline([a]));
    expect(queued.json.limits).toEqual({
      maxClips: maxClips(),
      maxSourceBytes: maxSourceBytes(),
      maxTimelineSeconds: 180,
      maxClipBytes: 200 * 1024 * 1024,
      minStillSec: 1,
      maxStillSec: 8,
      defaultStillSec: 2,
    });
    expect(
      (await get(`/studio/stitch/${queued.json.stitchId}`)).json.limits,
    ).toEqual(queued.json.limits);
  });
});

// ─── 4b. Music ──────────────────────────────────────────────────────────────────────────────────

describe("the audio bed", () => {
  afterEach(() => {
    delete process.env.STUDIO_STITCH_BEDS_READY;
  });

  it("refuses a bed AT THE DOOR while none is installed", async () => {
    // Rather than queueing a job that discovers a 404 from storage three minutes in, while she
    // waits. The sentence says what will happen, not what went wrong.
    const a = await seedClip(HER);
    const r = await post("/studio/stitch", {
      ...timeline([a]),
      bed: "placeholder",
    });
    expect(r.status).toBe(400);
    expect(r.json.field).toBe("bed");
    expect(r.json.error).toMatch(/isn't available yet/i);
    expect(await db.select().from(studioStitchJobs)).toHaveLength(0);
  });

  it("refuses a bed that is not on the list, installed or not", async () => {
    process.env.STUDIO_STITCH_BEDS_READY = "true";
    const a = await seedClip(HER);
    for (const bed of [
      "../../etc/passwd",
      "gs://bucket/track.mp3",
      "Placeholder",
      7,
    ]) {
      const r = await post("/studio/stitch", { ...timeline([a]), bed });
      expect(r.status).toBe(400);
      expect(r.json.field).toBe("bed");
    }
    expect(await db.select().from(studioStitchJobs)).toHaveLength(0);
  });

  it("stores the bed's NAME, never its path", async () => {
    process.env.STUDIO_STITCH_BEDS_READY = "true";
    const a = await seedClip(HER);
    const r = await post("/studio/stitch", {
      ...timeline([a]),
      bed: "placeholder",
    });
    expect(r.status).toBe(202);

    const [row] = await db.select().from(studioStitchJobs);
    expect((row.spec as any).bed).toBe("placeholder");
    // A path in a job row would be a durable file-read primitive. Same rule as the target.
    expect(JSON.stringify(row.spec)).not.toMatch(/studio\/beds|\.m4a|gs:\/\//);
  });

  it("treats an absent bed and a null bed as the same thing — no music", async () => {
    process.env.STUDIO_STITCH_BEDS_READY = "true";
    const a = await seedClip(HER);
    const r = await post("/studio/stitch", { ...timeline([a]), bed: null });
    expect(r.status).toBe(202);
    const [row] = await db.select().from(studioStitchJobs);
    expect("bed" in (row.spec as any)).toBe(false);
  });
});

describe("POST /studio/stitch — captions", () => {
  const caption = { text: "Game day", position: "bottom", style: "boxed" };
  const captioned = (id: string, c: unknown) => ({
    clips: [{ assetId: id, caption: c }],
    target: "portrait",
  });

  it("freezes her caption on the job row — words and two names, exactly as queued", async () => {
    const a = await seedClip(HER);
    const r = await post("/studio/stitch", captioned(a, caption));
    expect(r.status).toBe(202);

    const [row] = await db.select().from(studioStitchJobs);
    const spec = row.spec as { clips: { caption?: unknown }[] };
    expect(spec.clips[0].caption).toEqual(caption);
  });

  it("400s an unknown style or position BY NAME and queues nothing", async () => {
    const a = await seedClip(HER);
    const cases: [unknown, string][] = [
      [{ ...caption, style: "neon" }, "clips[0].caption.style"],
      [{ ...caption, position: "centre" }, "clips[0].caption.position"],
    ];
    for (const [c, field] of cases) {
      const r = await post("/studio/stitch", captioned(a, c));
      expect(r.status).toBe(400);
      expect(r.json.field).toBe(field);
    }
    expect(await db.select().from(studioStitchJobs)).toHaveLength(0);
  });

  it("400s text the font cannot draw, and says what a caption CAN be", async () => {
    const a = await seedClip(HER);
    const r = await post(
      "/studio/stitch",
      captioned(a, { ...caption, text: "lets go 🔥" }),
    );
    expect(r.status).toBe(400);
    expect(r.json.field).toBe("clips[0].caption.text");
    expect(r.json.error).toMatch(/letters \(accents included\)/);
    expect(r.json.error).toMatch(/Emoji/);
    expect(await db.select().from(studioStitchJobs)).toHaveLength(0);
  });

  it("queues an accented name untouched", async () => {
    const a = await seedClip(HER);
    const r = await post(
      "/studio/stitch",
      captioned(a, { ...caption, text: "Peña — 3:1" }),
    );
    expect(r.status).toBe(202);
    const [row] = await db.select().from(studioStitchJobs);
    const spec = row.spec as { clips: { caption?: { text: string } }[] };
    expect(spec.clips[0].caption?.text).toBe("Peña — 3:1");
  });
});

describe("POST /studio/stitch — the sound from one of her own videos", () => {
  it("queues it as an asset ID, with no music flag needed — her video is already hers", async () => {
    // STUDIO_STITCH_BEDS_READY is off here. A curated `bed` is refused for that; this is not.
    const clip = await seedClip(HER);
    const sound = await seedClip(HER);
    const r = await post("/studio/stitch", {
      ...timeline([clip]),
      bedAssetId: sound,
      bedLevel: "low",
    });
    expect(r.status).toBe(202);
    const [row] = await db.select().from(studioStitchJobs);
    const stored = row.spec as { bedAssetId?: string; bedLevel?: string };
    expect(stored.bedAssetId).toBe(sound);
    expect(stored.bedLevel).toBe("low");
    expect(JSON.stringify(row.spec)).not.toMatch(/https?:|athletes\/|\.mp4/);
  });

  it("gives ONE answer for another athlete's video and one that does not exist, and queues nothing", async () => {
    const clip = await seedClip(HER);
    const theirs = await seedClip(SOMEONE_ELSE);
    const gone = "12345678-1234-4234-8234-123456789abc";

    const a = await post("/studio/stitch", {
      ...timeline([clip]),
      bedAssetId: theirs,
    });
    const b = await post("/studio/stitch", {
      ...timeline([clip]),
      bedAssetId: gone,
    });
    expect([a.status, b.status]).toEqual([404, 404]);
    expect(a.json).toEqual(b.json);
    // Pointed at Music, where she chose it — not at the timeline.
    expect(a.json.field).toBe("bedAssetId");
    expect(a.json.error).not.toMatch(/athlete|permission|forbidden|yours/i);
    expect(await db.select().from(studioStitchJobs)).toHaveLength(0);
  });

  it("refuses a photo as the sound", async () => {
    const clip = await seedClip(HER);
    const photo = await seedClip(HER, { media_type: "IMAGE" });
    const r = await post("/studio/stitch", {
      ...timeline([clip]),
      bedAssetId: photo,
    });
    expect(r.status).toBe(409);
    expect(r.json.field).toBe("bedAssetId");
    expect(r.json.error).toMatch(/one of your videos/);
  });

  it("400s a track AND a video's sound together", async () => {
    process.env.STUDIO_STITCH_BEDS_READY = "true";
    try {
      const clip = await seedClip(HER);
      const r = await post("/studio/stitch", {
        ...timeline([clip]),
        bed: "walking-away",
        bedAssetId: clip,
      });
      expect(r.status).toBe(400);
      expect(r.json.field).toBe("bedAssetId");
    } finally {
      delete process.env.STUDIO_STITCH_BEDS_READY;
    }
  });

  it("still says `clips` when it is a CLIP that cannot be found", async () => {
    const r = await post("/studio/stitch", timeline([MISSING]));
    expect(r.status).toBe(404);
    expect(r.json.field).toBe("clips");
  });
});

describe("GET /studio/stitch/beds/:name/preview", () => {
  afterEach(() => {
    delete process.env.STUDIO_STITCH_BEDS_READY;
  });

  it("signs the product's OWN object for a name on the allowlist, briefly", async () => {
    process.env.STUDIO_STITCH_BEDS_READY = "true";
    const r = await get("/studio/stitch/beds/placeholder/preview");
    expect(r.status).toBe(200);
    expect(r.json.url).toBe(
      "https://signed.example/studio/beds/placeholder-loop.m4a",
    );
    // Minutes, not the media store's default hour: a copied link should not outlive the afternoon.
    expect(r.json.expiresInSec).toBeLessThanOrEqual(15 * 60);
    expect(signedUrl).toHaveBeenLastCalledWith(
      "studio/beds/placeholder-loop.m4a",
      r.json.expiresInSec * 1000,
    );
  });

  it("404s anything that is not a NAME on the list — a path most of all — and signs nothing", async () => {
    process.env.STUDIO_STITCH_BEDS_READY = "true";
    (signedUrl as jest.Mock).mockClear();
    for (const bad of [
      "nope",
      "Placeholder",
      "toString",
      "__proto__",
      encodeURIComponent("../../athletes/x/secret.mp4"),
      encodeURIComponent("studio/beds/placeholder-loop.m4a"),
    ]) {
      const r = await get(`/studio/stitch/beds/${bad}/preview`);
      expect([bad, r.status]).toEqual([bad, 404]);
    }
    expect(signedUrl).not.toHaveBeenCalled();
  });

  it("404s while no bed object is installed, rather than signing a link to nothing", async () => {
    (signedUrl as jest.Mock).mockClear();
    const r = await get("/studio/stitch/beds/placeholder/preview");
    expect(r.status).toBe(404);
    expect(signedUrl).not.toHaveBeenCalled();
  });

  it("is behind the same gate as the rest of the stitch surface", async () => {
    process.env.STUDIO_STITCH_BEDS_READY = "true";
    asUser(undefined);
    expect((await get("/studio/stitch/beds/placeholder/preview")).status).toBe(
      401,
    );
  });
});

describe("GET /studio/stitch/sound/:assetId/preview", () => {
  it("signs HER video's own object, briefly", async () => {
    const hers = await seedClip(HER);
    const [row] = await db
      .select({ gcs_path: mediaAssets.gcs_path })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, hers));

    const r = await get(`/studio/stitch/sound/${hers}/preview`);
    expect(r.status).toBe(200);
    expect(r.json.url).toBe(`https://signed.example/${row.gcs_path}`);
    expect(r.json.expiresInSec).toBeLessThanOrEqual(15 * 60);
  });

  it("404s another athlete's video exactly as it 404s one that does not exist, and signs nothing", async () => {
    const theirs = await seedClip(SOMEONE_ELSE);
    (signedUrl as jest.Mock).mockClear();

    const a = await get(`/studio/stitch/sound/${theirs}/preview`);
    const b = await get(`/studio/stitch/sound/${MISSING}/preview`);
    expect([a.status, b.status]).toEqual([404, 404]);
    expect(a.json).toEqual(b.json);
    expect(signedUrl).not.toHaveBeenCalled();
  });

  it("404s anything that is not an asset id, and refuses a photo", async () => {
    (signedUrl as jest.Mock).mockClear();
    for (const bad of [
      "placeholder",
      "walking-away",
      encodeURIComponent("../x"),
    ]) {
      expect((await get(`/studio/stitch/sound/${bad}/preview`)).status).toBe(
        404,
      );
    }
    const photo = await seedClip(HER, { media_type: "IMAGE" });
    expect((await get(`/studio/stitch/sound/${photo}/preview`)).status).toBe(
      409,
    );
    expect(signedUrl).not.toHaveBeenCalled();
  });

  it("is behind the same gate as the rest of the stitch surface", async () => {
    const hers = await seedClip(HER);
    asUser(undefined);
    expect((await get(`/studio/stitch/sound/${hers}/preview`)).status).toBe(
      401,
    );
  });
});

describe("POST /studio/stitch/caption-preview", () => {
  const caption: Caption = {
    text: "Game day",
    position: "top",
    style: "boxed",
  };
  const ask = (body: unknown) => post("/studio/stitch/caption-preview", body);

  it("returns THE picture the runner burns in — same bytes, same place", async () => {
    // The point of drawing the preview on the server. Not "a caption that looks similar": the band
    // from the same function, so what she approves over the player is what ffmpeg is handed.
    const r = await ask({ caption, target: "portrait" });
    expect(r.status).toBe(200);

    const want = await renderCaptionBand(caption, STITCH_TARGETS.portrait);
    expect(r.json.uri).toBe(
      `data:image/png;base64,${want.png.toString("base64")}`,
    );
    expect(r.json.top).toBeCloseTo(want.y / 1920, 10);
    expect(r.json.height).toBeCloseTo(want.height / 1920, 10);
  });

  it("places it as FRACTIONS of the frame, inside it, in every shape", async () => {
    for (const target of ["portrait", "square", "landscape"]) {
      for (const position of ["top", "middle", "bottom"]) {
        const r = await ask({ caption: { ...caption, position }, target });
        expect(r.status).toBe(200);
        expect(r.json.top).toBeGreaterThanOrEqual(0);
        expect(r.json.top + r.json.height).toBeLessThanOrEqual(1);
      }
    }
  });

  it("refuses exactly what the queue refuses, by the same field names under `caption`", async () => {
    const a = await seedClip(HER);
    const cases: [unknown, string][] = [
      [{ ...caption, style: "neon" }, "style"],
      [{ ...caption, position: "centre" }, "position"],
      [{ ...caption, text: "go 🔥" }, "text"],
      [{ ...caption, text: "" }, "text"],
    ];
    for (const [c, leaf] of cases) {
      const preview = await ask({ caption: c, target: "portrait" });
      const queue = await post("/studio/stitch", {
        clips: [{ assetId: a, caption: c }],
        target: "portrait",
      });
      expect(preview.status).toBe(400);
      expect(queue.status).toBe(400);
      expect(preview.json.field).toBe(`caption.${leaf}`);
      expect(queue.json.field).toBe(`clips[0].caption.${leaf}`);
      // One rule, so one sentence.
      expect(preview.json.error).toBe(queue.json.error);
    }
  });

  it("400s a missing caption and an unknown shape", async () => {
    expect((await ask({ target: "portrait" })).status).toBe(400);
    const r = await ask({ caption, target: "1080x1920" });
    expect(r.status).toBe(400);
    expect(r.json.field).toBe("target");
  });

  it("writes nothing — no job, no asset", async () => {
    await ask({ caption, target: "portrait" });
    expect(await db.select().from(studioStitchJobs)).toHaveLength(0);
    expect(await db.select().from(mediaAssets)).toHaveLength(0);
  });

  it("is behind the same gate as the rest of the stitch surface", async () => {
    asUser(undefined);
    expect((await ask({ caption, target: "portrait" })).status).toBe(401);
    asUser("no-athlete");
    expect((await ask({ caption, target: "portrait" })).status).toBe(403);
  });
});

describe("POST /studio/stitch/music/suggest (PR 8)", () => {
  it("answers the top pick and its reason for her row sentences, without touching the database", async () => {
    const r = await post("/studio/stitch/music/suggest", {
      feel: ["warm, slow, golden light"],
      objective: "grow-following",
    });
    expect(r.status).toBe(200);
    expect(r.json.top).toEqual({
      name: "walking-around",
      label: "Walking Around",
      reason: expect.stringMatching(/\bwarm\b/),
    });
  });

  it("is a 400 with the server's sentence for a body that is not a list of sentences", async () => {
    const r = await post("/studio/stitch/music/suggest", { feel: "warm" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/list of up to/);
  });

  // PR 10, R-2: with a plan id the route derives brand-ness off HER stored row (brief + deal), the same
  // function the planner used. A plan that is not hers is not found; the body's chip never overrides a brief.
  it("reads brand-ness off her stored plan by id — not hers is a 404, hers answers; the handler derives through brandSignalsFrom", async () => {
    const { savePlan } = await import("../studio/agent/plans");
    const body = { items: [], castCount: 0, picksWithoutHer: [], gaps: [], look: null, music: null };
    const mine = await savePlan(HER, {
      plan: body,
      brief: { objective: { type: "brand_campaign", goal: "grow-following" }, brand: { name: "Solstice" } },
    });
    const theirs = await savePlan(SOMEONE_ELSE, { plan: body });
    const feel = ["warm, slow, golden light"];
    expect((await post("/studio/stitch/music/suggest", { feel, objective: "grow-following", planId: theirs.id })).status).toBe(404);
    const r = await post("/studio/stitch/music/suggest", { feel, objective: "grow-following", planId: mine.id });
    expect(r.status).toBe(200);
    expect(r.json.top?.name).toBe("walking-around");
    const src = readFileSync(join(__dirname, "studio.ts"), "utf8");
    const handler = src.slice(src.indexOf('router.post("/studio/stitch/music/suggest"'));
    expect(handler.slice(0, 1200)).toMatch(/brandSignalsFrom\(row\.brief, row\.deal_deliverable_id !== null\)/);
  });
});

describe("GET /studio/stitch/options", () => {
  afterEach(() => {
    delete process.env.STUDIO_STITCH_BEDS_READY;
  });

  it("answers the caps and the bed list without touching the database", async () => {
    const r = await get("/studio/stitch/options");
    expect(r.status).toBe(200);
    expect(r.json.limits.maxClips).toBe(maxClips());
    // CHANGED ON PURPOSE (captions + music card): this used to expect the placeholder here. It is
    // now UNLISTED — still a valid name for a stored row, no longer offered, because a 220 Hz tone
    // is not music. Nothing real is listed until a person has listened to it and its provenance is
    // recorded (studio/video/beds.test.ts), so today the picker is honestly empty.
    expect(r.json.beds.map((b: { name: string }) => b.name)).not.toContain(
      "placeholder",
    );
    for (const b of r.json.beds) {
      expect(b).toEqual({
        name: expect.any(String),
        label: expect.any(String),
        note: expect.any(String),
        artist: expect.any(String),
        // Added with the sound tile: how far in she may ask a track to start is bounded by this.
        durationSec: expect.any(Number),
        // Added with the beat grid (PR 5 A2): every listed track is measured, so a stills edit can
        // be cut on its beat.
        beat: { bpm: expect.any(Number), firstBeatSec: expect.any(Number) },
      });
    }
    expect(r.json.levels.map((l: { name: string }) => l.name)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(r.json.defaultLevel).toBe("medium");
  });

  it("still QUEUES the unlisted placeholder by name, so an old client or row is not broken", async () => {
    process.env.STUDIO_STITCH_BEDS_READY = "true";
    const a = await seedClip(HER);
    const r = await post("/studio/stitch", {
      ...timeline([a]),
      bed: "placeholder",
      bedLevel: "high",
    });
    expect(r.status).toBe(202);
    const [row] = await db.select().from(studioStitchJobs);
    const spec = row.spec as { bed?: string; bedLevel?: string };
    expect(spec.bed).toBe("placeholder");
    expect(spec.bedLevel).toBe("high");
  });

  it("400s a bed level that is not one of the three names", async () => {
    process.env.STUDIO_STITCH_BEDS_READY = "true";
    const a = await seedClip(HER);
    const r = await post("/studio/stitch", {
      ...timeline([a]),
      bed: "placeholder",
      bedLevel: 0.9,
    });
    expect(r.status).toBe(400);
    expect(r.json.field).toBe("bedLevel");
    expect(await db.select().from(studioStitchJobs)).toHaveLength(0);
  });

  it("serves the caption vocabulary and the geometry the client previews with", async () => {
    const r = await get("/studio/stitch/options");
    expect(
      r.json.captions.positions.map((p: { name: string }) => p.name),
    ).toEqual(["top", "middle", "bottom"]);
    expect(r.json.captions.styles.map((s: { name: string }) => s.name)).toEqual(
      ["clean", "boxed", "bold"],
    );
    expect(r.json.captions.maxChars).toBe(60);
    expect(r.json.captions.geometry.fontOverShortEdge).toBeGreaterThan(0);
  });

  it("says plainly whether any bed can be used yet", async () => {
    expect((await get("/studio/stitch/options")).json.ready).toBe(false);
    process.env.STUDIO_STITCH_BEDS_READY = "true";
    expect((await get("/studio/stitch/options")).json.ready).toBe(true);
  });

  it("is reachable at all — it is declared BEFORE /studio/stitch/:stitchId", async () => {
    // ⚠️ THE ROUTING REVERT CHECK. Express matches in order and "options" is not a uuid, so with
    // the parameterised route first this 404s through its UUID_RE guard — and the bug looks like a
    // missing feature rather than a misordered declaration.
    expect((await get("/studio/stitch/options")).status).toBe(200);
  });

  it("is behind the same gate as everything else", async () => {
    process.env.STUDIO_ENABLED = "false";
    try {
      expect((await get("/studio/stitch/options")).status).toBe(404);
    } finally {
      process.env.STUDIO_ENABLED = "true";
    }
  });
});

// ─── 5. Queueing ────────────────────────────────────────────────────────────────────────────────

describe("POST /studio/stitch — queueing", () => {
  it("answers 202 with an id to poll, stores IDS not paths, and kicks the runner", async () => {
    const a = await seedClip(HER);
    const b = await seedClip(HER);
    const r = await post("/studio/stitch", {
      clips: [
        { assetId: a },
        { assetId: b, trimStartSec: 1, trimEndSec: 4, crossfadeSec: 0.5 },
      ],
      target: "square",
    });

    expect(r.status).toBe(202);
    expect(r.json.status).toBe("queued");

    const [row] = await db.select().from(studioStitchJobs);
    expect(row.id).toBe(r.json.stitchId);
    expect(row.athlete_id).toBe(HER); // off the REQUEST, never the body
    expect(row.spec).toEqual({
      clips: [
        { assetId: a },
        { assetId: b, trimStartSec: 1, trimEndSec: 4, crossfadeSec: 0.5 },
      ],
      target: "square",
    });
    // The stored spec holds the target's NAME, not its expansion — so a preset can be corrected
    // later and every queued row picks the correction up.
    expect(JSON.stringify(row.spec)).not.toMatch(/1080|libx264|veryfast|\//);

    await new Promise((r2) => setImmediate(r2));
    expect(mockTick).toHaveBeenCalled();
  });

  it("ignores an athleteId in the body — the row's owner comes off the request", async () => {
    const a = await seedClip(HER);
    const r = await post("/studio/stitch", {
      ...timeline([a]),
      athleteId: SOMEONE_ELSE,
      athlete_id: SOMEONE_ELSE,
    });
    expect(r.status).toBe(202);
    const [row] = await db.select().from(studioStitchJobs);
    expect(row.athlete_id).toBe(HER);
  });

  it("queues even when the kick throws — the job is durable, the kick is latency", async () => {
    mockTick.mockRejectedValueOnce(new Error("no runner today"));
    const a = await seedClip(HER);
    expect((await post("/studio/stitch", timeline([a]))).status).toBe(202);
    expect(await db.select().from(studioStitchJobs)).toHaveLength(1);
  });

  it("spends nothing: no generation job, and no previewId is read", async () => {
    const a = await seedClip(HER);
    const r = await post("/studio/stitch", {
      ...timeline([a]),
      previewId: MISSING,
    });
    expect(r.status).toBe(202);
    expect(await db.select().from(generationJobs)).toHaveLength(0);
  });
});

// ─── 6. Reading one back ────────────────────────────────────────────────────────────────────────

describe("GET /studio/stitch/:stitchId", () => {
  it("reports queued, then the finished clip with a signed url", async () => {
    const a = await seedClip(HER);
    const { json: queued } = await post("/studio/stitch", timeline([a]));

    const first = await get(`/studio/stitch/${queued.stitchId}`);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({
      status: "queued",
      error: null,
      asset: null,
      completedAt: null,
    });

    const output = await seedClip(HER, {
      origin: "generated",
      approval_status: "draft",
    });
    await db
      .update(studioStitchJobs)
      .set({
        status: "succeeded",
        output_asset_id: output,
        completed_at: new Date(),
      })
      .where(eq(studioStitchJobs.id, queued.stitchId));

    const done = await get(`/studio/stitch/${queued.stitchId}`);
    expect(done.json.status).toBe("succeeded");
    expect(done.json.asset).toMatchObject({
      assetId: output,
      mediaType: "VIDEO",
      approvalStatus: "draft",
    });
    expect(done.json.asset.url).toMatch(/^https:\/\/signed\.example\//);
    expect(done.json.completedAt).not.toBeNull();
  });

  it("shows her the refusal a runner wrote", async () => {
    const a = await seedClip(HER);
    const { json: queued } = await post("/studio/stitch", timeline([a]));
    await db
      .update(studioStitchJobs)
      .set({
        status: "failed",
        last_error:
          "A timeline can hold up to 12 clips, 664 MB of video and 3:00 of footage.",
      })
      .where(eq(studioStitchJobs.id, queued.stitchId));

    const r = await get(`/studio/stitch/${queued.stitchId}`);
    expect(r.json.status).toBe("failed");
    expect(r.json.error).toMatch(/up to 12 clips/);
  });

  it("answers the same 404 for someone else's stitch as for one that never existed", async () => {
    const a = await seedClip(HER);
    const { json: queued } = await post("/studio/stitch", timeline([a]));

    asUser(SOMEONE_ELSE);
    const notYours = await get(`/studio/stitch/${queued.stitchId}`);
    const notThere = await get(`/studio/stitch/${MISSING}`);
    expect(notYours.status).toBe(404);
    expect(notYours.json).toEqual(notThere.json);
  });

  it("404s a malformed id without touching the database", async () => {
    expect((await get("/studio/stitch/not-a-uuid")).status).toBe(404);
  });

  it("does not hand back another athlete's asset even if a row points at one", async () => {
    // Defence in depth: output_asset_id is written by the runner from its own publish, but the
    // read filters on the athlete anyway rather than trusting the pointer.
    const a = await seedClip(HER);
    const { json: queued } = await post("/studio/stitch", timeline([a]));
    const theirs = await seedClip(SOMEONE_ELSE);
    await db
      .update(studioStitchJobs)
      .set({ status: "succeeded", output_asset_id: theirs })
      .where(eq(studioStitchJobs.id, queued.stitchId));

    expect(
      (await get(`/studio/stitch/${queued.stitchId}`)).json.asset,
    ).toBeNull();
  });
});

// ─── GET /studio/stitch/clips — the picker's own list ───────────────────────────────────────────

describe("GET /studio/stitch/clips", () => {
  type Clip = {
    assetId: string;
    videoUrl: string;
    posterUrl: string | null;
    durationSec: number | null;
    durationPreciseSec: number | null;
    origin: string;
  };
  const clipsNow = async (): Promise<Clip[]> => {
    const { status, json } = await get("/studio/stitch/clips");
    expect(status).toBe(200);
    return json.clips as Clip[];
  };
  const ago = (ms: number) => new Date(Date.now() - ms);
  const DAY = 24 * 60 * 60_000;

  /** A clip made here: recorded just now, and no `posted_at` — nothing of hers was ever posted. */
  const madeHere = (over: Record<string, unknown> = {}) =>
    seedClip(HER, {
      origin: "generated",
      posted_at: null,
      ingested_at: new Date(),
      ...over,
    });

  /**
   * ⚠️ MUTATION: order by `posted_at` alone, DESC NULLS LAST — GET /me/media's order. This test
   * reds, and nothing else in the suite does.
   *
   * The live shape (measured 2026-09-21): enough dated videos to fill the list, and clips made here
   * with no `posted_at`. Ordered by `posted_at` alone, every generated clip sorts after every dated
   * one, so once the dated ones fill the bound what she just made is not offered at all.
   */
  it("offers what she just made, each row by its own date, even when old dated videos fill the list", async () => {
    const oldShoot = new Date("2025-06-01T12:00:00Z").getTime();
    await db.insert(mediaAssets).values(
      Array.from({ length: STITCH_CLIPS_LIMIT }, (_, i) => ({
        athlete_id: HER,
        platform: "studio",
        origin: "upload",
        media_type: "VIDEO",
        status: "stored",
        gcs_path: `athletes/${HER}/old-shoot-${i}.mp4`,
        content_type: "video/mp4",
        bytes: 1_000,
        posted_at: new Date(oldShoot + i * 60_000),
        ingested_at: new Date(),
      })) as never,
    );
    const justNow = await madeHere();
    const aMinuteAgo = await madeHere({ ingested_at: ago(60_000) });
    // An upload's `posted_at` is its CAPTURE date — a clip shot yesterday sits by yesterday, below
    // what was made a minute ago and above what was made three days ago.
    const shotYesterday = await seedClip(HER, { posted_at: ago(DAY) });
    const threeDaysAgo = await madeHere({ ingested_at: ago(3 * DAY) });

    const ids = (await clipsNow()).map((c) => c.assetId);

    expect(ids).toHaveLength(STITCH_CLIPS_LIMIT);
    expect(ids.slice(0, 4)).toEqual([
      justNow,
      aMinuteAgo,
      shotYesterday,
      threeDaysAgo,
    ]);
  });

  it("offers exactly what a stitch accepts — hers, stored, top-level, not deleted, a video with mp4 bytes", async () => {
    const clip = await seedClip(HER);
    const reel = await seedClip(HER, { media_type: "REELS" });
    await seedClip(SOMEONE_ELSE);
    await seedClip(HER, { media_type: "IMAGE", content_type: "image/jpeg" });
    await seedClip(HER, { deleted_at: new Date() });
    await seedClip(HER, { status: "failed" });
    await seedClip(HER, { parent_media_id: "album-1" });
    // An Instagram video row that holds only its POSTER — gcs_path is a JPEG, not a clip. It used
    // to be filtered on the client AFTER the page was cut, so it could take a slot and then vanish.
    await seedClip(HER, { origin: "connected", content_type: "image/jpeg" });

    const ids = (await clipsNow()).map((c) => c.assetId);

    expect([...ids].sort()).toEqual([clip, reel].sort());
  });

  it("signs the mp4 and the poster — and says null, never the mp4, before a poster exists", async () => {
    const postered = await seedClip(HER, {
      gcs_thumb_path: `athletes/${HER}/poster.jpg`,
      duration_seconds_precise: 5.25,
    });
    const bare = await seedClip(HER, { ingested_at: ago(1_000) });

    const byId = new Map((await clipsNow()).map((c) => [c.assetId, c]));

    expect(byId.get(postered)).toMatchObject({
      posterUrl: `https://signed.example/athletes/${HER}/poster.jpg`,
      durationSec: 8,
      durationPreciseSec: 5.25,
      origin: "upload",
    });
    expect(byId.get(bare)?.videoUrl).toMatch(
      /^https:\/\/signed\.example\/.+\.mp4$/,
    );
    expect(byId.get(bare)?.posterUrl).toBeNull();
    // "Nothing measured this row" is an answer, and is not collapsed into the integer.
    expect(byId.get(bare)?.durationPreciseSec).toBeNull();
  });

  it("is not read as a stitch id, and does not exist with STUDIO_ENABLED off", async () => {
    expect((await get("/studio/stitch/clips")).status).toBe(200);
    process.env.STUDIO_ENABLED = "false";
    try {
      expect((await get("/studio/stitch/clips")).status).toBe(404);
    } finally {
      process.env.STUDIO_ENABLED = "true";
    }
  });
});

// ─── GET /studio/stitch/stills — the still picker's own list ───────────────────────────────────

describe("GET /studio/stitch/stills", () => {
  type Still = {
    assetId: string;
    imageUrl: string;
    thumbUrl: string;
    origin: string;
  };
  const stillsNow = async (): Promise<Still[]> => {
    const { status, json } = await get("/studio/stitch/stills");
    expect(status).toBe(200);
    return json.stills as Still[];
  };
  const photo = (owner: string, over: Record<string, unknown> = {}) =>
    seedClip(owner, {
      media_type: "IMAGE",
      content_type: "image/jpeg",
      gcs_path: `athletes/${owner}/${Math.random().toString(36).slice(2)}.jpg`,
      duration_seconds: null,
      ...over,
    });
  const ago = (ms: number) => new Date(Date.now() - ms);
  const DAY = 24 * 60 * 60_000;

  it("lists only her photos — exactly what a still may be made from", async () => {
    const jpeg = await photo(HER);
    const png = await photo(HER, { content_type: "image/png" });
    const album = await photo(HER, { media_type: "CAROUSEL_ALBUM" });
    await photo(SOMEONE_ELSE);
    await photo(HER, { content_type: "image/heic" });
    await photo(HER, { deleted_at: new Date() });
    await photo(HER, { status: "failed" });
    await photo(HER, { parent_media_id: album });
    await seedClip(HER);

    const ids = (await stillsNow()).map((p) => p.assetId);

    expect([...ids].sort()).toEqual([jpeg, png, album].sort());
  });

  it("offers a photo she just made, each row by its own date, above an old dated shoot", async () => {
    const oldShoot = await photo(HER, {
      posted_at: new Date("2025-06-01T12:00:00Z"),
    });
    const justMade = await photo(HER, {
      origin: "generated",
      posted_at: null,
      ingested_at: new Date(),
    });
    const shotYesterday = await photo(HER, { posted_at: ago(DAY) });

    const ids = (await stillsNow()).map((p) => p.assetId);

    expect(ids).toEqual([justMade, shotYesterday, oldShoot]);
  });

  it("signs the full photo for the preview and the thumbnail for the tile", async () => {
    const withThumb = await photo(HER, {
      gcs_thumb_path: `athletes/${HER}/thumb.jpg`,
    });
    const bare = await photo(HER, { ingested_at: ago(1_000) });

    const byId = new Map((await stillsNow()).map((p) => [p.assetId, p]));

    expect(byId.get(withThumb)?.thumbUrl).toBe(
      `https://signed.example/athletes/${HER}/thumb.jpg`,
    );
    expect(byId.get(withThumb)?.imageUrl).toMatch(
      /^https:\/\/signed\.example\/.+\.jpg$/,
    );
    // No thumbnail yet: the tile shows the photo itself rather than nothing.
    expect(byId.get(bare)?.thumbUrl).toBe(byId.get(bare)?.imageUrl);
  });

  it("is not read as a stitch id, and does not exist with STUDIO_ENABLED off", async () => {
    expect((await get("/studio/stitch/stills")).status).toBe(200);
    process.env.STUDIO_ENABLED = "false";
    try {
      expect((await get("/studio/stitch/stills")).status).toBe(404);
    } finally {
      process.env.STUDIO_ENABLED = "true";
    }
  });
});

// ─── The composer's record, from the Board to the row (PR 15.1, R-4, composer-boundary.md) ──────
//
// Both sides of the boundary in one test: the plan items go through the Board's ONE mapping
// (`seedRowsFrom`, composer on) and its stitch (`boardStitch`, composer on), the body is POSTed, and
// the assertion is on the jsonb the runner will claim. PR 15's tests stopped at `BoardStitch.joins`.

describe("POST /studio/stitch — the composer's record reaches the row", () => {
  const PLAN = "0c0c0c0c-2222-4333-8444-555555555555";
  let prevFlag: string | undefined;
  beforeAll(() => {
    prevFlag = process.env.STUDIO_COMPOSER;
    process.env.STUDIO_COMPOSER = "true";
  });
  afterAll(() => {
    if (prevFlag === undefined) delete process.env.STUDIO_COMPOSER;
    else process.env.STUDIO_COMPOSER = prevFlag;
  });
  beforeEach(async () => {
    await db.delete(studioPlans);
  });

  const clipItem = (assetId: string): AgentPlanItem => ({
    kind: "clip",
    beat: "her sprint",
    direction: "she sprints",
    assetId,
    thumbUrl: null,
    athletePresent: true,
    sound: false,
    brandFlag: null,
    swapped: null,
    uncast: null,
    mediaType: "clip",
    trim: null,
    durationSeconds: 4,
    shot: { framing: "wide", composition: "centered" },
  });
  /** Her two clips, planned with slots a held clip cannot carry, stitched from the Board. */
  const boardBody = async (planId: string | null) => {
    const a = await seedClip(HER);
    const b = await seedClip(HER);
    const rows = seedRowsFrom([clipItem(a), clipItem(b)], "n1", 2, true);
    const out = boardStitch(rows, [], {}, [], null, null, null, null, {
      rhythm: null,
      planId,
    });
    if (!out.body) throw new Error(out.refusal ?? "no body");
    return out.body;
  };
  const storedSpec = async (stitchId: string) => {
    const [row] = await db
      .select({ spec: studioStitchJobs.spec })
      .from(studioStitchJobs)
      .where(eq(studioStitchJobs.id, stitchId));
    return row.spec as {
      clips: { assetId: string; crossfadeSec?: number }[];
      composer?: {
        joins: { key: string; kind: string; reason: string }[];
        dropped: { row: string; slot: string; value: string; reason: string }[];
        planId?: string;
      };
    };
  };

  /** ⚠️ MUTATION: drop the record from `boardStitch`'s body, or from `parseStitchSpec` — each reds by name. */
  it("a join reason never leaves the client — never: every join's reason is on the stored spec, one per clip", async () => {
    const r = await post("/studio/stitch", await boardBody(null));
    expect(r.status).toBe(202);
    const spec = await storedSpec(r.json.stitchId);
    expect(spec.composer?.joins).toEqual([
      { key: "agent:n1:0:own", kind: "cut", reason: "position-0" },
      { key: "agent:n1:1:own", kind: "fade", reason: "default-fade" },
    ]);
    // The index is the join key: joins[i] is the join INTO clips[i], and it agrees with the wire.
    expect(spec.composer?.joins.length).toBe(spec.clips.length);
    spec.composer?.joins.forEach((j, i) =>
      expect(j.kind).toBe(spec.clips[i].crossfadeSec ? "fade" : "cut"),
    );
  });

  /** ⚠️ MUTATION: leave `dropped` out of the record, client or server — this reds by name. */
  it("a dropped slot never leaves the client — never: every held row's nothing-filmed drop is on the stored spec", async () => {
    const r = await post("/studio/stitch", await boardBody(null));
    expect(r.status).toBe(202);
    expect((await storedSpec(r.json.stitchId)).composer?.dropped).toEqual([
      { row: "agent:n1:0", slot: "framing", value: "wide", reason: "nothing-filmed" },
      { row: "agent:n1:0", slot: "composition", value: "centered", reason: "nothing-filmed" },
      { row: "agent:n1:1", slot: "framing", value: "wide", reason: "nothing-filmed" },
      { row: "agent:n1:1", slot: "composition", value: "centered", reason: "nothing-filmed" },
    ]);
  });

  /** ⚠️ MUTATION: skip the route's ownership read — this reds by name. */
  it("a plan id that is not hers is stored on a stitch — never: someone else's plan is a 404 and no row; hers is stored", async () => {
    await db.insert(studioPlans).values([
      { id: PLAN, athlete_id: SOMEONE_ELSE, plan: {} },
    ] as never);
    const theirs = await post("/studio/stitch", await boardBody(PLAN));
    expect(theirs.status).toBe(404);
    expect(theirs.json.field).toBe("composer.planId");
    expect(await db.select().from(studioStitchJobs)).toHaveLength(0);

    await db.delete(studioPlans);
    await db.insert(studioPlans).values([
      { id: PLAN, athlete_id: HER, plan: {} },
    ] as never);
    const hers = await post("/studio/stitch", await boardBody(PLAN));
    expect(hers.status).toBe(202);
    expect((await storedSpec(hers.json.stitchId)).composer?.planId).toBe(PLAN);
  });

  it("a malformed record is a 400 naming the field, and no row (D-1)", async () => {
    const body = await boardBody(null);
    const r = await post("/studio/stitch", {
      ...body,
      composer: { joins: [], dropped: [] },
    });
    expect(r.status).toBe(400);
    expect(r.json.field).toBe("composer.joins");
    expect(await db.select().from(studioStitchJobs)).toHaveLength(0);
  });

  /** ⚠️ MUTATION: parse the record with the server flag off — this reds by name (D-3). */
  it("composer changes an artifact with STUDIO_COMPOSER off — never: the server stores today's spec for the same body", async () => {
    const body = await boardBody(PLAN); // a plan id that exists nowhere: never even read with the flag off
    const { composer: _record, ...today } = body as Record<string, unknown>;
    process.env.STUDIO_COMPOSER = "false";
    try {
      const withRecord = await post("/studio/stitch", body);
      const without = await post("/studio/stitch", today);
      expect([withRecord.status, without.status]).toEqual([202, 202]);
      const a = await storedSpec(withRecord.json.stitchId);
      const b = await storedSpec(without.json.stitchId);
      expect(a).not.toHaveProperty("composer");
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    } finally {
      process.env.STUDIO_COMPOSER = "true";
    }
  });
});
