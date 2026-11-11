/**
 * studio.style.test.ts — a style reference on a GENERATE, through the real client path (PR 18, R-5 (a)): Create
 * Anything's tray reduced by the client's own `toEngineReferences`, posted to the real /studio/preview route
 * (the carve-out, ADI-GO18 G3), frozen onto the brief, compiled by the legacy buildPrompt. The route's compiled
 * prompt is read off the stored preview row, and the spend leg's compile (`plannedInputs` of the frozen brief)
 * is checked to be the same string.
 *
 * Red by name when taken out:
 *   M17 "the image ShotSpec never reaches a generate through the real client path"   (crosses the boundary)
 *   M1  "a style spec is not derived from the stored reading" (route half): a spec posted in the body is ignored
 *   M3  "a raw style image is forwarded to the model" (route half)
 *   M4  "a style reference is usable before decomposition" (route half)
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.athleteId = (globalThis as any).__TEST_ATHLETE_ID;
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
  saveBuffer: jest.fn(),
  rehostFromUrl: jest.fn(),
}));
jest.mock("../studio/router", () => {
  const actual = jest.requireActual("../studio/router");
  return { ...actual, generate: jest.fn() };
});

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import studioRouter from "./studio";
import { generate } from "../studio/router";
import { plannedInputs } from "../studio/preview";
import {
  athletes,
  athletesCurrent,
  mediaAssets,
  studioGenerationPreviews,
  studioReferenceAnalyses,
} from "../../shared/schema";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../testUtils/pgliteDb";
import {
  toEngineReferences,
  type Attachment,
} from "../../client/lib/studio-contract";
import { READING } from "../studio/reference/styleFixtures";
import { STYLE_CLOSE, STYLE_OPEN } from "../studio/compile/style";

let server: Server;
let base: string;
let HER: string;
let OTHER: string;
let look: { id: string; path: string };
let unread: { id: string; path: string };
let theirs: { id: string; path: string };

async function seedScored(name: string): Promise<string> {
  const id = await seedAthlete(name);
  await db
    .update(athletes)
    .set({ sport: "Soccer", school: "Test University", division: "D1" } as any)
    .where(eq(athletes.id, id));
  await db.insert(athletesCurrent).values({
    athlete_id: id,
    story_arc: "A synthetic arc for tests.",
  } as any);
  return id;
}

async function referenceImage(athleteId: string, read: boolean) {
  const path = `athletes/${athleteId}/references/${Math.random().toString(36).slice(2)}.jpg`;
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: athleteId,
      platform: "web",
      origin: "reference",
      media_type: "IMAGE",
      status: "stored",
      gcs_path: path,
    } as any)
    .returning({ id: mediaAssets.id });
  if (read)
    await db.insert(studioReferenceAnalyses).values({
      athlete_id: athleteId,
      source_kind: "image",
      source_asset_id: row.id,
      role: "style_reference",
      decomposition: READING,
      prompt_version: "reference/1",
      model: "gemini-flash-synthetic",
    } as any);
  return { id: row.id, path };
}

/** Her tray, as Create Anything holds it: one Style chip. */
const tray = (assetId: string): Attachment[] => [
  { id: `style:${assetId}`, role: "style", name: "Style", uri: null, assetId },
];

/** The generate body Create Anything sends, with the tray reduced by the client's own function. */
const generateBody = (assetId: string) => ({
  intent: "image.generate",
  deliverable: "post",
  objective: "grow-following",
  direction: "a portrait of me at training",
  references: toEngineReferences(tray(assetId)).references,
});

async function post(body: unknown) {
  const res = await fetch(`${base}/studio/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function stored(previewId: string) {
  const [row] = await db
    .select({
      brief: studioGenerationPreviews.brief,
      plan: studioGenerationPreviews.plan,
    })
    .from(studioGenerationPreviews)
    .where(eq(studioGenerationPreviews.id, previewId));
  return row as { brief: any; plan: any };
}

beforeAll(async () => {
  await initTestDb();
  HER = await seedScored("Her");
  OTHER = await seedScored("Other");
  look = await referenceImage(HER, true);
  unread = await referenceImage(HER, false);
  theirs = await referenceImage(OTHER, true);
  const app = express();
  app.use(express.json());
  app.use("/", studioRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(() => {
  process.env.STUDIO_ENABLED = "true";
  process.env.STUDIO_STYLE_SPEC = "true";
  (globalThis as any).__TEST_ATHLETE_ID = HER;
  (generate as jest.Mock).mockReset();
});
afterEach(() => {
  delete process.env.STUDIO_STYLE_SPEC;
});

describe("a style reference on a generate, through the real client path", () => {
  it("the client sends the Style chip as `style_reference`, and nothing else about it", () => {
    expect(generateBody(look.id).references).toEqual([
      { assetId: look.id, role: "style_reference" },
    ]);
  });

  it("the image ShotSpec never reaches a generate through the real client path — it must: tray → route → frozen brief → prompt", async () => {
    const res = await post(generateBody(look.id));
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("ready");
    const row = await stored(res.json.previewId);
    const prompt: string = row.plan.inputs.prompt;
    // The fenced reading, every still dimension, and the shot phrased from the closed vocabulary.
    expect(prompt).toContain(STYLE_OPEN);
    for (const z of [
      "ZQLIGHT",
      "ZQCOLOR",
      "ZQMOOD",
      "ZQCOMP",
      "ZQCAM",
      "ZQENV",
    ])
      expect(prompt).toContain(z);
    expect(prompt).toContain(
      "CAMERA: shot from a low angle, looking up; a close-up of her head and shoulders.",
    );
    expect(prompt).toContain(
      "LIGHT: hard light with crisp, defined shadows; a rim light tracing the subject's edges.",
    );
    expect(prompt).toContain(
      "COMPOSITION: generous empty space around the subject.",
    );
    // What the spend leg compiles from the frozen brief is this same string.
    expect(plannedInputs(row.brief).inputs.prompt).toBe(prompt);
    // And nothing was spent to check it.
    expect(generate).not.toHaveBeenCalled();
  });

  it("a raw style image is forwarded to the model — it must not: not a planned reference, not in the prompt", async () => {
    const res = await post(generateBody(look.id));
    const row = await stored(res.json.previewId);
    // What the spend leg would hand the adapter: planned from the frozen brief, as runGeneration does.
    const spend = plannedInputs(row.brief);
    expect(spend.references.map((r) => r.ref)).not.toContain(look.path);
    expect(
      (spend.inputs.references ?? []).map((r) => (r as { url?: string }).url),
    ).not.toContain(look.path);
    expect(row.plan.inputs.references).toBe(0);
    expect(row.plan.inputs.prompt).not.toContain(look.path);
    // The reading's words sit only inside the fence.
    const outside = (row.plan.inputs.prompt as string).replace(
      new RegExp(`${STYLE_OPEN}[\\s\\S]*?${STYLE_CLOSE}`),
      "",
    );
    expect(outside).not.toMatch(/ZQ[A-Z]+/);
  });

  it("a style spec is not derived from the stored reading — it must be: a spec posted in the body is ignored", async () => {
    const body = generateBody(look.id);
    (body.references[0] as any).style = {
      dimensions: { lighting: { summary: "ZQFORGED" } },
    };
    const res = await post(body);
    expect(res.status).toBe(200);
    const row = await stored(res.json.previewId);
    expect(row.plan.inputs.prompt).toContain("ZQLIGHT");
    expect(row.plan.inputs.prompt).not.toContain("ZQFORGED");
    expect(row.brief.job.references[0].style.analysisId).toEqual(
      expect.any(String),
    );
  });

  it("a style reference is usable before decomposition — it must not: an unread image is refused, still reading", async () => {
    const res = await post(generateBody(unread.id));
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({
      field: "references",
      reason: "reference_unread",
    });
    expect(res.json.error).toMatch(/still reading/i);
  });

  it("another athlete's reference is not found, exactly as another athlete's photo is", async () => {
    const res = await post(generateBody(theirs.id));
    expect(res.status).toBe(404);
  });

  it("flag off: the role is refused at the same line, with the same 400 as any unknown role", async () => {
    delete process.env.STUDIO_STYLE_SPEC;
    const res = await post(generateBody(look.id));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({
      error: "Say what each photo is for.",
      field: "references",
    });
  });
});
