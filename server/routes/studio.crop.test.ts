/**
 * studio.crop.test.ts — a CROP through the real routes (PR 19, S-6 / S-7; ADI-R19-S). $0: nothing here can reach a model.
 *
 * The sentence door quotes "crop to 4:5" as `image.crop` at $0, and the spend leg runs it through the REAL router and the
 * in-process `local` adapter (sharp): one job, one stored asset derived from her photo, exactly the planned window, and
 * the standard cost line at $0 written at the router's one door with the job's id. A second tap spends nothing and
 * makes no second job. And R-14's condition, by name: the crop of her photo is HER — no "Made here · not from you",
 * accepted by the reference door as her likeness — while a crop of a made-here item keeps that item's standing. Since
 * ADI-R19-BOARD the standing is the chain rule's (a crop is one kind of edit), and since ADI-R19-BOARD3 the door runs
 * what she chose either way; the label is what differs.
 *
 * Stood in, at the edge only: storage and URL signing, the signed-URL reads (a real JPEG made by sharp), and the cost
 * log's writer (captured, so the suite writes no file). The router, the adapter, the preview and the gate are real.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (
    req: { athleteId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.athleteId = (
      globalThis as { __TEST_ATHLETE_ID?: string }
    ).__TEST_ATHLETE_ID;
    next();
  },
}));
jest.mock("../lib/models", () => ({
  // An empty client, as the masked-edit suite's: any model method called on it throws.
  genai: jest.fn(() => ({})),
  GEMINI: {
    pro: "test-pro",
    flash: "test-flash",
    flashLite: "test-flash-lite",
  },
}));
jest.mock("../lib/mediaStore", () => ({
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
  saveBuffer: jest.fn(async (_b: unknown, base: string) => ({
    gcs_path: `${base}.jpg`,
    content_type: "image/jpeg",
    bytes: 1234,
  })),
  rehostFromUrl: jest.fn(async () => {
    throw new Error("studio.crop.test: no rehost");
  }),
}));
jest.mock("../lib/safeFetch", () => ({
  ...jest.requireActual("../lib/safeFetch"),
  safeFetch: jest.fn(),
}));
jest.mock("../studio/costLog", () => ({
  ...jest.requireActual("../studio/costLog"),
  recordGeneration: jest.fn(async () => "line-id"),
}));

import express from "express";
import sharp from "sharp";
import { readFileSync } from "fs";
import { join } from "path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, isNotNull, sql } from "drizzle-orm";
import studioRouter from "./studio";
import { safeFetch } from "../lib/safeFetch";
import { recordGeneration } from "../studio/costLog";
import type { CreativeBrief } from "../studio/brief";
import { CHAIN_IDENTITY_BOUND_SQL, madeHereNotHer } from "../studio/referenceGate";
import {
  athletes,
  athletesCurrent,
  generationJobs,
  mediaAssets,
  studioGenerationPreviews,
} from "../../shared/schema";
import {
  db,
  client,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../testUtils/pgliteDb";

const FRAME_W = 1200;
const FRAME_H = 1800;
const HER_VISION = {
  subject: "the_athlete",
  athlete_present: true,
  face_visibility: "clear",
  role: "identity",
  shot_type: "portrait",
};

let server: Server;
let base: string;
let athleteId: string;
let frameJpeg: Buffer;
const realFetch = globalThis.fetch;

interface Json {
  previewId?: string;
  jobId?: string;
  status?: string;
  reason?: string;
  plan?: { task?: string; inputs?: { prompt?: string } };
  cost?: { amountUsd?: number } | null;
}
async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: ((await res.json().catch(() => null)) ?? {}) as Json,
  };
}

let seq = 0;
async function seed(
  o: { origin?: string; jobId?: string; vision?: unknown } = {},
) {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: athleteId,
      platform: "studio",
      origin: o.origin ?? "upload",
      media_type: "IMAGE",
      status: "stored",
      gcs_path: `athletes/${athleteId}/uploads/crop-${++seq}.jpg`,
      content_type: "image/jpeg",
      ...(o.jobId ? { generation_job_id: o.jobId } : {}),
      metadata: { vision: o.vision ?? HER_VISION },
    } as typeof mediaAssets.$inferInsert)
    .returning({ id: mediaAssets.id });
  return row.id;
}
/** A made-here item whose job carried no photo of her — "Made here · not from you". */
async function madeHereNotHerRow() {
  const [job] = await db
    .insert(generationJobs)
    .values({
      athlete_id: athleteId,
      origin: "system",
      mode: "generate",
      objective: "grow-following",
      deliverable: "post",
      brief: { job: { references: [{ role: "product" }] } },
      status: "succeeded",
    } as typeof generationJobs.$inferInsert)
    .returning({ id: generationJobs.id });
  return seed({ origin: "generated", jobId: job.id });
}
/** Its standing as every list reads it with STUDIO_LIBRARY_FIELDS on: the chain rule (ADI-R19-BOARD folds R-14 in). */
async function standingOf(assetId: string) {
  const [row] = await db
    .select({
      origin: mediaAssets.origin,
      identityBound: sql<boolean | null>`(${sql.raw(CHAIN_IDENTITY_BOUND_SQL)})`,
    })
    .from(mediaAssets)
    .where(eq(mediaAssets.id, assetId));
  return row;
}
/** Quote "crop to 4:5" on this photo and run it; the crop's own row. */
async function crop(sourceId: string) {
  const quoted = await post("/studio/preview", {
    intent: "image.edit",
    deliverable: "post",
    objective: "grow-following",
    sourceAssetId: sourceId,
    direction: "crop to 4:5",
  });
  expect(quoted.status).toBe(200);
  const ran = await post("/studio/generate", {
    previewId: quoted.json.previewId,
  });
  expect(ran.status).toBe(200);
  const [made] = await db
    .select({ id: mediaAssets.id })
    .from(mediaAssets)
    .where(eq(mediaAssets.derived_from_asset_id, sourceId));
  // Enrichment reads every new row; the crop is her own pixels, so it reads as she does.
  await db
    .update(mediaAssets)
    .set({ metadata: { vision: HER_VISION } } as Partial<
      typeof mediaAssets.$inferInsert
    >)
    .where(eq(mediaAssets.id, made.id));
  return { quoted, made: made.id };
}
const asLikeness = (assetId: string) =>
  post("/studio/preview", {
    intent: "image.generate",
    deliverable: "post",
    objective: "grow-following",
    direction: "me on a beach at sunset",
    references: [{ assetId, role: "person" }],
  });

beforeAll(async () => {
  frameJpeg = await sharp({
    create: {
      width: FRAME_W,
      height: FRAME_H,
      channels: 3,
      background: { r: 30, g: 110, b: 60 },
    },
  })
    .jpeg()
    .toBuffer();
  // The preview probes the photo's size through fetch; the adapter reads it through safeFetch. Both get her JPEG.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.startsWith("https://signed.example/"))
      return new Response(new Uint8Array(frameJpeg), { status: 200 });
    if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
    throw new Error(`studio.crop.test: no outbound fetch is allowed (${url})`);
  }) as typeof fetch;
  (safeFetch as jest.Mock).mockImplementation(async (url: string) => {
    if (!url.startsWith("https://signed.example/"))
      throw new Error(`studio.crop.test: unexpected read ${url}`);
    return new Response(new Uint8Array(frameJpeg), { status: 200 });
  });

  await initTestDb();
  await client.exec(
    readFileSync(
      join(__dirname, "..", "studio", "sql", "generationGuards.sql"),
      "utf8",
    ),
  );
  athleteId = await seedAthlete("Crop Test Athlete");
  await db
    .update(athletes)
    .set({
      sport: "Soccer",
      school: "Test University",
      division: "D1",
    } as Partial<typeof athletes.$inferInsert>)
    .where(eq(athletes.id, athleteId));
  await db.insert(athletesCurrent).values({
    athlete_id: athleteId,
    story_arc: "A synthetic arc for tests.",
  } as typeof athletesCurrent.$inferInsert);

  const app = express();
  app.use(express.json());
  app.use("/", studioRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(async () => {
  (globalThis as { __TEST_ATHLETE_ID?: string }).__TEST_ATHLETE_ID = athleteId;
  process.env.STUDIO_ENABLED = "true";
  process.env.STUDIO_NATIVE_EDIT = "true";
  process.env.STUDIO_IMAGE_OPS = "true";
  process.env.STUDIO_LIBRARY_FIELDS = "true";
  for (const f of [
    "STUDIO_SERVER_ROUTING",
    "STUDIO_CREATIVE_QA",
    "STUDIO_INTERPRETER",
    "STUDIO_STYLE_SPEC",
  ])
    delete process.env[f];
  (recordGeneration as jest.Mock).mockClear();
  await db.delete(studioGenerationPreviews);
  await db
    .delete(mediaAssets)
    .where(isNotNull(mediaAssets.derived_from_asset_id));
  await db.delete(mediaAssets).where(isNotNull(mediaAssets.generation_job_id));
  await db.delete(generationJobs);
  await db.delete(mediaAssets);
});

afterEach(() => {
  for (const f of [
    "STUDIO_NATIVE_EDIT",
    "STUDIO_IMAGE_OPS",
    "STUDIO_LIBRARY_FIELDS",
  ])
    delete process.env[f];
});

it("quotes image.crop at $0, runs it in-process as one job, and stores exactly the planned window, derived from her photo", async () => {
  const frame = await seed();
  const { quoted, made } = await crop(frame);
  expect(quoted.json.plan?.task).toBe("image.crop");
  expect(quoted.json.cost?.amountUsd).toBe(0);
  const [stored] = await db
    .select({ brief: studioGenerationPreviews.brief })
    .from(studioGenerationPreviews)
    .where(eq(studioGenerationPreviews.id, quoted.json.previewId!));
  const brief = stored.brief as CreativeBrief;
  expect(brief.job.editIntent?.changes).toEqual([
    { op: "CROP", target: null, change: "4:5" },
  ]);

  const jobs = await db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.athlete_id, athleteId));
  expect(jobs.map((j) => [j.status, j.provider, j.model])).toEqual([
    ["succeeded", "local", "local/sharp-crop"],
  ]);
  const [row] = await db
    .select({
      origin: mediaAssets.origin,
      width: mediaAssets.width,
      height: mediaAssets.height,
    })
    .from(mediaAssets)
    .where(eq(mediaAssets.id, made));
  // 4:5 of a 1200x1800 portrait: the full width, 1500 of its height — never wider, never upscaled.
  expect(row).toEqual({ origin: "generated", width: 1200, height: 1500 });
});

it("writes the standard cost line at $0 through the router's one door, joined to its job", async () => {
  const frame = await seed();
  await crop(frame);
  const [job] = await db.select({ id: generationJobs.id }).from(generationJobs);
  expect(recordGeneration).toHaveBeenCalledTimes(1);
  const line = (recordGeneration as jest.Mock).mock.calls[0][0];
  expect(line).toMatchObject({
    task: "image.crop",
    provider: "local",
    model: "local/sharp-crop",
    cost: 0,
    attribution: { jobId: job.id },
  });
});

/**
 * ADI-R19-S: "a double tap makes one job." Measured: ONE job runs and spends; the second tap's claim on the quote fails
 * (compare-and-set) and the row it opened is CANCELED, never started, $0 — the shared spend path creates the job
 * before it claims the quote, because the claim records the job's id (studio/generate.ts:1210-1218). Pinned as it is;
 * the ledger names the gap for a ruling rather than restructuring every generation's spend path here.
 */
it("a double tap runs one job and spends once — the second tap's row is canceled and never runs", async () => {
  const frame = await seed();
  const quoted = await post("/studio/preview", {
    intent: "image.edit",
    deliverable: "post",
    objective: "grow-following",
    sourceAssetId: frame,
    direction: "crop it square",
  });
  // The house's contract (parity T5): the second tap answers `already_running` with the first job's id, and spends nothing.
  const first = await post("/studio/generate", {
    previewId: quoted.json.previewId,
  });
  const second = await post("/studio/generate", {
    previewId: quoted.json.previewId,
  });
  expect(first.status).toBe(200);
  expect([second.status, second.json.status, second.json.jobId]).toEqual([
    200,
    "already_running",
    first.json.jobId,
  ]);
  const jobs = await db.select().from(generationJobs);
  const ran = jobs.filter((j) => j.status === "succeeded");
  expect(ran.map((j) => j.id)).toEqual([first.json.jobId]);
  expect(
    jobs
      .filter((j) => j.status !== "succeeded")
      .map((j) => [j.status, j.started_at, j.cost_usd]),
  ).toEqual([["canceled", null, null]]);
  expect(recordGeneration).toHaveBeenCalledTimes(1);
});

it("a crop of her photo is her: no Made-here label, accepted as a likeness reference", async () => {
  const frame = await seed();
  const { made } = await crop(frame);
  const standing = await standingOf(made);
  expect(standing).toEqual({ origin: "generated", identityBound: true });
  expect(madeHereNotHer(standing)).toBe(false);
  // Through the real reference door (STUDIO_LIBRARY_FIELDS on): her likeness, quoted.
  const asHer = await asLikeness(made);
  expect([asHer.status, asHer.json.reason]).toEqual([200, undefined]);
});

it("a crop of a made-here item keeps that item's standing: still labelled not her — and, chosen by her, it runs (ADI-R19-BOARD3)", async () => {
  const source = await madeHereNotHerRow();
  expect(madeHereNotHer(await standingOf(source))).toBe(true);
  const { made } = await crop(source);
  const standing = await standingOf(made);
  expect(standing).toEqual({ origin: "generated", identityBound: false });
  expect(madeHereNotHer(standing)).toBe(true);
  // The label stays; the door no longer refuses what she chose.
  const chosen = await asLikeness(made);
  expect([chosen.status, chosen.json.reason]).toEqual([200, undefined]);
});
