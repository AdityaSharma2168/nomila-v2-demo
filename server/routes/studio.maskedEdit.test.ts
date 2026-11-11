/**
 * studio.maskedEdit.test.ts — one masked edit through the real routes, its prompt bytes pinned (image-parity, guard 1).
 *
 * `buildPrompt` moved into studio/compile/image.ts (R-3 (a)). Its masked arm had three compile goldens and no
 * route-level coverage: nothing held the bytes a real drawn-box edit quotes and then sends, through the preview,
 * the frozen brief, the crop planner, the crop's own resolver seam and the paste-back. This suite does, once:
 *
 *   - the QUOTED prompt (the preview's plan) and the SENT prompt (what the billable door is handed for crop 0)
 *     are each pinned to a capture taken on the pre-move tip b7e71617 (studio.maskedEdit.golden.json), and are
 *     the same bytes as each other and as `plannedInputs` of the stored brief;
 *   - what the model is handed is the CROP, in the frame slot, and nothing else;
 *   - the paste-back ran: one generation, one stored asset, the job succeeded.
 *
 * Stood in, at the edge only: the billable router call (answering with a real PNG the size of the crop it was
 * handed, so the paste-back composites for real), storage and URL signing, and the fetch of a signed URL (a real
 * JPEG made by sharp). Any other outbound fetch throws, so this suite cannot reach a model.
 *
 * IMAGE_ROUTE_CAPTURE=1 writes the golden and FAILS, so a capture run is never read as green.
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
    gcs_path: `${base}.png`,
    content_type: "image/png",
    bytes: 1234,
  })),
  rehostFromUrl: jest.fn(async (_u: string, base: string) => ({
    gcs_path: `${base}.png`,
    content_type: "image/png",
    bytes: 1234,
  })),
}));
jest.mock("../studio/router", () => {
  const actual = jest.requireActual("../studio/router");
  return { ...actual, generate: jest.fn() };
});

import express from "express";
import sharp from "sharp";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, isNotNull } from "drizzle-orm";
import studioRouter from "./studio";
import { generate } from "../studio/router";
import { plannedInputs } from "../studio/preview";
import type { CreativeBrief } from "../studio/brief";
import type { ImageRef } from "../studio/types";
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

const GOLDEN_PATH = join(__dirname, "studio.maskedEdit.golden.json");
const CAPTURE = process.env.IMAGE_ROUTE_CAPTURE === "1";
const GOLDEN: Record<string, string[]> =
  !CAPTURE && existsSync(GOLDEN_PATH)
    ? JSON.parse(readFileSync(GOLDEN_PATH, "utf8"))
    : {};
const captured: Record<string, string[]> = {};

const FRAME_W = 1200;
const FRAME_H = 1800;
const SENTENCE = "make the shorts black and green";
/** A box she drew: a drawn box routes masked, whatever the native flag says (studio.native.test.ts). */
const DRAWN = [
  {
    label: "black and green shorts",
    left: 0.41,
    top: 0.59,
    width: 0.147,
    height: 0.097,
  },
];

let server: Server;
let base: string;
let athleteId: string;
let frameJpeg: Buffer;
const realFetch = globalThis.fetch;

interface Json {
  previewId?: string;
  plan?: { inputs?: { prompt?: string } };
  jobId?: string;
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
function need<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined)
    throw new Error(`the route answered without ${what}`);
  return v;
}

function pinned(name: string, prompt: string) {
  if (CAPTURE) {
    captured[name] = prompt.split("\n");
    return;
  }
  expect(prompt.split("\n")).toEqual(GOLDEN[name]);
}

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
    throw new Error(
      `studio.maskedEdit.test: no outbound fetch is allowed (${url})`,
    );
  }) as typeof fetch;

  await initTestDb();
  await client.exec(
    readFileSync(
      join(__dirname, "..", "studio", "sql", "generationGuards.sql"),
      "utf8",
    ),
  );
  athleteId = await seedAthlete("Masked Test Athlete");
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
  if (CAPTURE) {
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(captured, null, 2)}\n`);
    throw new Error(
      `captured ${Object.keys(captured).length} masked goldens — a capture run always fails`,
    );
  }
});

beforeEach(async () => {
  (globalThis as { __TEST_ATHLETE_ID?: string }).__TEST_ATHLETE_ID = athleteId;
  process.env.STUDIO_ENABLED = "true";
  process.env.STUDIO_NATIVE_EDIT = "true";
  for (const f of [
    "STUDIO_SERVER_ROUTING",
    "STUDIO_CREATIVE_QA",
    "STUDIO_INTERPRETER",
    "STUDIO_STYLE_SPEC",
    "STUDIO_LIBRARY_FIELDS",
    "STUDIO_GARMENT_MASK",
    "STUDIO_BACKGROUND_MASK",
  ])
    delete process.env[f];
  // The model's answer: a real PNG exactly the size of the crop it was handed, so the paste-back is real.
  (generate as jest.Mock)
    .mockReset()
    .mockImplementation(
      async (task: string, inputs: { references?: ImageRef[] }) => {
        const frame = (inputs.references ?? []).find((r) => r.slot === "frame");
        const bytes = frame && frame.kind === "bytes" ? frame.bytes : null;
        const meta = bytes
          ? await sharp(bytes).metadata()
          : { width: 64, height: 64 };
        const now = new Date().toISOString();
        return {
          task,
          provider: "vertex",
          model: "gemini-3-pro-image",
          assets: [
            {
              mimeType: "image/png",
              bytes: await sharp({
                create: {
                  width: meta.width ?? 64,
                  height: meta.height ?? 64,
                  channels: 3,
                  background: { r: 10, g: 10, b: 10 },
                },
              })
                .png()
                .toBuffer(),
            },
          ],
          cost: { amountUsd: 0.1654, currency: "USD", basis: "estimated" },
          timings: { startedAt: now, completedAt: now, ms: 1 },
          raw: {},
        };
      },
    );
  await db.delete(studioGenerationPreviews);
  await db.delete(mediaAssets).where(isNotNull(mediaAssets.generation_job_id));
  await db.delete(generationJobs);
  await db.delete(mediaAssets);
});

afterEach(() => {
  delete process.env.STUDIO_NATIVE_EDIT;
});

it("a drawn-box masked edit: the quoted prompt and the prompt sent for its crop are the pre-move bytes, and the crop is pasted back", async () => {
  const [frame] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: athleteId,
      platform: "studio",
      origin: "upload",
      media_type: "IMAGE",
      status: "stored",
      gcs_path: `athletes/${athleteId}/uploads/frame.jpg`,
      content_type: "image/jpeg",
    } as typeof mediaAssets.$inferInsert)
    .returning({ id: mediaAssets.id });

  const quoted = await post("/studio/preview", {
    intent: "image.edit",
    deliverable: "post",
    objective: "grow-following",
    sourceAssetId: frame.id,
    direction: SENTENCE,
    regions: DRAWN,
  });
  expect(quoted.status).toBe(200);
  const previewId = need(quoted.json.previewId, "previewId");
  const [stored] = await db
    .select({ brief: studioGenerationPreviews.brief })
    .from(studioGenerationPreviews)
    .where(eq(studioGenerationPreviews.id, previewId));
  const brief = stored.brief as CreativeBrief;
  // A drawn box stays masked: no frozen native intent.
  expect("editIntent" in brief.job).toBe(false);
  const quotedPrompt = need(
    quoted.json.plan?.inputs?.prompt,
    "plan.inputs.prompt",
  );
  pinned("masked — the quoted prompt", quotedPrompt);

  const ran = await post("/studio/generate", { previewId });
  expect(ran.status).toBe(200);
  expect(generate).toHaveBeenCalledTimes(1);
  const [task, inputs] = (generate as jest.Mock).mock.calls[0] as [
    string,
    { prompt: string; references: ImageRef[] },
  ];
  expect(task).toBe("image.edit");
  pinned("masked — the prompt sent for crop 0", inputs.prompt);
  expect(inputs.prompt).toBe(
    plannedInputs(brief, { cropIndex: 0 }).inputs.prompt,
  );
  expect(inputs.prompt).toBe(quotedPrompt);
  // The model is handed the CROP, in the frame slot, and nothing else.
  expect(inputs.references.map((r) => [r.slot, r.kind])).toEqual([
    ["frame", "bytes"],
  ]);
  const crop =
    inputs.references[0].kind === "bytes"
      ? await sharp(inputs.references[0].bytes).metadata()
      : null;
  expect(
    crop && (crop.width ?? 0) < FRAME_W && (crop.height ?? 0) < FRAME_H,
  ).toBe(true);

  const jobs = await db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.athlete_id, athleteId));
  expect(jobs.map((j) => j.status)).toEqual(["succeeded"]);
  const made = await db
    .select({ id: mediaAssets.id })
    .from(mediaAssets)
    .where(eq(mediaAssets.generation_job_id, jobs[0].id));
  expect(made).toHaveLength(1);
});
