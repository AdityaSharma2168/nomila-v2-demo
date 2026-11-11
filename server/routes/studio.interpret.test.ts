/**
 * studio.interpret.test.ts — the interpreter through the REAL routes: the preview that interprets, the
 * generate that spends, the reject that refuses, the classify that reports (the interpreter, I.5).
 * End to end against in-memory Postgres; every row synthetic.
 *
 * What only the routes can show, and so what this suite exists to prove:
 *
 *   1. FLAG OFF IS MAIN: no call, no record, detection reads her sentence exactly as before.
 *   2. A PROPOSAL CONTINUES AS IF SHE TYPED C: the row's statement is C, the frozen intent is C's, detection
 *      reads C and never her words, and the spend-time re-check agrees — while the same row with her words
 *      put back refuses. The record and the card's lines ride on the row.
 *   3. EVERY ASK BLOCKS, AND DETECTION NEVER RUNS ON HER WORDS: a decline, the ad gate's asks.
 *   4. "NOT WHAT I MEANT" IS HERS ALONE: it blocks her own interpreted, unspent preview and nothing else.
 *   5. NO LOG LINE ON THE PATH CARRIES HER SENTENCE OR C.
 *
 * Mocked, and only these: the interpreter's transport (its replies are the fixture — no model is called),
 * detection, the billable router call, storage, and the logger (captured, for the log scan).
 */

const logged: string[] = [];
jest.mock("../logger", () => ({
  createLogger: (module: string) => {
    const log =
      (level: string) =>
      (...args: unknown[]) => {
        logged.push(JSON.stringify([module, level, ...args]));
      };
    return {
      info: log("info"),
      warn: log("warn"),
      error: log("error"),
      debug: log("debug"),
    };
  },
}));
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
jest.mock("../studio/autoMask", () => {
  const actual = jest.requireActual("../studio/autoMask");
  return {
    ...actual,
    detectRegionsMemoized: jest.fn(),
    probeBytesFor: jest.fn(),
  };
});
// QA's inspection is observed, not run: the pin is what the spend hands it (N7).
jest.mock("../studio/qa/inspect", () => ({
  inspectAsset: jest.fn(async () => null),
}));
// The interpreter's one network boundary. Each test states the reply the model "gave".
jest.mock("../studio/interpret/transport", () => {
  const actual = jest.requireActual("../studio/interpret/transport");
  return { ...actual, geminiTransport: jest.fn() };
});

import express from "express";
import { readFileSync } from "fs";
import { join } from "path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, isNotNull } from "drizzle-orm";
import studioRouter, { NATIVE_INTENT_CHANGED } from "./studio";
import { generate } from "../studio/router";
import { detectRegionsMemoized, probeBytesFor } from "../studio/autoMask";
import { freezeRefusalNote } from "../studio/nativeIntent";
import { route } from "../studio/classify";
import { geminiTransport } from "../studio/interpret/transport";
import { inspectAsset } from "../studio/qa/inspect";
import { __clearInterpreterMemo } from "../studio/interpret/interpret";
import {
  athletes,
  athletesCurrent,
  generationJobs,
  inboxBrands,
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

// ─── The sentences, and the replies the model "gave" ───────────────────────────────────────────────

/** Asks `brand_change` on main: rule 4c reads no "to adidas" shape in it. */
const S = "switch my jersey over to adidas";
const C = "change my jersey to an adidas jersey";
const REPLY = JSON.stringify({
  decline: false,
  spans: [{ quote: S, reads: "edit", edits: [0] }],
  edits: [
    {
      kind: "brand_swap",
      source: "yours",
      item: "jersey",
      descriptors: [],
      brand: "adidas",
    },
  ],
  constraints: [],
  visibleMarks: [{ brand: "nike", item: "jersey" }],
});

const AD_1A = "turn this into an adidas ad. dont change anything about me";
const C_1A =
  'change my jersey to an adidas jersey, change my socks to adidas socks, change my cleats to adidas cleats, and add the headline "OWN THE MOMENT" across the top';
const reply1a = (sentence = AD_1A) =>
  JSON.stringify({
    decline: false,
    spans: [
      { quote: sentence.split(". ")[0] + ".", reads: "treatment" },
      {
        quote: "dont change anything about me",
        reads: "constraint",
        constraints: [0],
      },
    ],
    edits: [
      { kind: "text", source: "suggested", content: "OWN THE MOMENT" },
      { kind: "background", source: "suggested", setting: "stadium at night" },
    ],
    constraints: [{ kind: "preserve_person" }],
    // The Q1 frame as R1's replies saw it.
    visibleMarks: [
      { brand: "nike", item: "jersey" },
      { brand: "nike", item: "socks" },
      { brand: "nike", item: "cleats" },
      { brand: "nike", item: "other" },
    ],
  });

const DECLINE = JSON.stringify({
  decline: true,
  spans: [],
  edits: [],
  constraints: [],
  visibleMarks: [],
});

const answer = (text: string) =>
  (geminiTransport as jest.Mock).mockResolvedValue({
    text,
    usage: { inputTokens: 2400, outputTokens: 380 },
    model: "gemini-3.5-flash",
  });

// ─── Harness (studio.native.test.ts's) ─────────────────────────────────────────────────────────────

let server: Server;
let base: string;
let athleteId: string;
let otherAthleteId: string;

const asUser = (id: string) => {
  (globalThis as any).__TEST_ATHLETE_ID = id;
};

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as any,
  };
}

const FRAMES = new Map<string, { width: number; height: number }>();
const realFetch = globalThis.fetch;

function jpegBytes(width: number, height: number): Buffer {
  const sof = Buffer.alloc(10);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(0xc0, 1);
  sof.writeUInt16BE(8, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.writeUInt8(3, 9);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    sof,
    Buffer.from([0xff, 0xda]),
  ]);
}

function pngBytes(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(17);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16);
  return Buffer.concat([sig, ihdr]);
}

async function seedScoredAthlete(name: string): Promise<string> {
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

let frameSeq = 0;
async function seedFrame(owner = athleteId): Promise<string> {
  const path = `athletes/${owner}/uploads/frame-${++frameSeq}.jpg`;
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: owner,
      platform: "studio",
      origin: "upload",
      media_type: "IMAGE",
      status: "stored",
      gcs_path: path,
    } as any)
    .returning({ id: mediaAssets.id });
  FRAMES.set(path, { width: 4000, height: 6000 });
  return row.id;
}

let brandSeq = 0;
async function seedBrand(name: string, category: string | null = null) {
  const [row] = await db
    .insert(inboxBrands)
    .values({
      name,
      normalized_name: `synthetic-brand-${++brandSeq}`,
      category,
    } as any)
    .returning({ id: inboxBrands.id });
  return row.id;
}

function detected(...labels: string[]) {
  (detectRegionsMemoized as jest.Mock).mockResolvedValue({
    ok: true,
    regions: labels.map((label, i) => ({
      label,
      left: 0.41,
      top: 0.3 + i * 0.12,
      width: 0.147,
      height: 0.097,
    })),
  });
}

/** Every instruction detection was asked to read. */
const detectionReads = () =>
  (detectRegionsMemoized as jest.Mock).mock.calls.map(
    ([key]: [{ instruction: string }]) => key.instruction,
  );

const editReq = (
  sourceAssetId: string,
  direction: string,
  extra: Record<string, unknown> = {},
) => ({
  intent: "image.edit",
  deliverable: "post",
  objective: "grow-following",
  sourceAssetId,
  direction,
  ...extra,
});

async function storedRow(previewId: string) {
  const [row] = await db
    .select()
    .from(studioGenerationPreviews)
    .where(eq(studioGenerationPreviews.id, previewId));
  return row as any;
}

beforeAll(async () => {
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url =
      typeof input === "string" ? input : (input?.url ?? String(input));
    if (url.startsWith("https://signed.example/")) {
      const frame = FRAMES.get(
        decodeURIComponent(url.slice("https://signed.example/".length)),
      );
      if (!frame) return new Response(null, { status: 404 });
      return new Response(
        new Uint8Array(jpegBytes(frame.width, frame.height)),
        { status: 206 },
      );
    }
    return realFetch(input, init);
  };

  await initTestDb();
  await client.exec(
    readFileSync(
      join(__dirname, "..", "studio", "sql", "generationGuards.sql"),
      "utf8",
    ),
  );
  athleteId = await seedScoredAthlete("Test Athlete");
  otherAthleteId = await seedScoredAthlete("Other Athlete");

  const app = express();
  app.use(express.json());
  app.use("/", studioRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  (globalThis as any).fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(async () => {
  process.env.STUDIO_ENABLED = "true";
  process.env.STUDIO_NATIVE_EDIT = "true";
  process.env.STUDIO_INTERPRETER = "true";
  delete process.env.STUDIO_DISPLAY_TEXT;
  delete process.env.STUDIO_SERVER_ROUTING;
  delete process.env.STUDIO_CREATIVE_QA;
  asUser(athleteId);
  __clearInterpreterMemo();
  logged.length = 0;
  (geminiTransport as jest.Mock).mockReset();
  (probeBytesFor as jest.Mock)
    .mockReset()
    .mockResolvedValue({ bytes: Buffer.from("frame"), mimeType: "image/jpeg" });
  (detectRegionsMemoized as jest.Mock).mockReset();
  (generate as jest.Mock).mockReset().mockResolvedValue({
    task: "image.edit",
    provider: "vertex",
    model: "gemini-3-pro-image",
    assets: [{ mimeType: "image/png", bytes: pngBytes(3392, 5056) }],
    cost: { amountUsd: 0.24, currency: "USD", basis: "estimated" },
    timings: {
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      ms: 10,
    },
    raw: {},
  });
  await db.delete(studioGenerationPreviews);
  await db.delete(mediaAssets).where(isNotNull(mediaAssets.generation_job_id));
  await db.delete(generationJobs);
  await db.delete(mediaAssets);
  await db.delete(inboxBrands);
});

afterEach(() => {
  delete process.env.STUDIO_NATIVE_EDIT;
  delete process.env.STUDIO_INTERPRETER;
  delete process.env.STUDIO_DISPLAY_TEXT;
});

// ─── 1. Flag off ───────────────────────────────────────────────────────────────────────────────────

describe("with STUDIO_INTERPRETER off, the preview is the one main builds", () => {
  it("calls nothing, records nothing, and detection reads her sentence as before", async () => {
    delete process.env.STUDIO_INTERPRETER;
    answer(REPLY);
    detected("jersey");
    const { json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), S),
    );

    expect(geminiTransport).not.toHaveBeenCalled();
    expect(json.status).toBe("blocked");
    expect("interpretation" in json).toBe(false);
    const row = await storedRow(json.previewId);
    expect(row.brief.job.direction.statement).toBe(S);
    expect("interpretation" in row.brief.job).toBe(false);
    expect(detectionReads()).toEqual([S]);
  });
});

// ─── 2. A proposal ─────────────────────────────────────────────────────────────────────────────────

describe("a proposal continues exactly as if she had typed C", () => {
  it("stores C as the statement and C's frozen intent, with the record and the card beside it", async () => {
    answer(REPLY);
    detected("jersey");
    const { status, json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), S),
    );

    expect(status).toBe(200);
    expect(json.status).toBe("ready");
    expect(geminiTransport).toHaveBeenCalledTimes(1);
    expect(json.interpretation).toEqual({
      lines: [
        {
          kind: "change",
          text: "Swap your jersey for an adidas jersey",
          source: "yours",
        },
      ],
    });

    const { brief } = await storedRow(json.previewId);
    expect(brief.job.direction.statement).toBe(C);
    expect(brief.job.editIntent).toMatchObject({
      version: 1,
      steps: route(C, true, { objects: 0 }).steps,
      changes: [
        { op: "REPLACE_OBJECT", target: "jersey", change: "adidas jersey" },
      ],
    });
    expect(brief.job.interpretation).toMatchObject({
      from: S,
      canonical: C,
      outcome: "proposed",
      promptVersion: expect.stringMatching(/^interpret\//),
      lines: json.interpretation.lines,
    });
  });

  it("sends detection C's words — never hers", async () => {
    answer(REPLY);
    detected("jersey");
    await post("/studio/preview", editReq(await seedFrame(), S));
    expect(detectionReads()).toEqual([C]);
  });

  it("is spent as quoted: the re-check reads C and agrees", async () => {
    answer(REPLY);
    detected("jersey");
    const preview = await post(
      "/studio/preview",
      editReq(await seedFrame(), S),
    );
    const spend = await post("/studio/generate", {
      previewId: preview.json.previewId,
    });
    expect(spend.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("refuses to spend the same row with HER words put back as the statement", async () => {
    answer(REPLY);
    detected("jersey");
    const preview = await post(
      "/studio/preview",
      editReq(await seedFrame(), S),
    );
    const row = await storedRow(preview.json.previewId);
    row.brief.job.direction.statement = S;
    await db
      .update(studioGenerationPreviews)
      .set({ brief: row.brief } as any)
      .where(eq(studioGenerationPreviews.id, preview.json.previewId));

    const spend = await post("/studio/generate", {
      previewId: preview.json.previewId,
    });
    expect(spend.status).toBe(409);
    expect(spend.json.error).toBe(NATIVE_INTENT_CHANGED);
    expect(generate).not.toHaveBeenCalled();
  });
});

// ─── The ad (cell 1a) ──────────────────────────────────────────────────────────────────────────────

describe("an ad — the brand she named is the ad's brand, and the kit swap is the brand's", () => {
  it("freezes C with her keep and the exclusion (version 2), the card reads M2's line, and the spend carries both", async () => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
    const adidas = await seedBrand("adidas", "Athletic Apparel");
    answer(reply1a());
    detected("jersey", "socks", "cleats");
    const { json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), AD_1A),
    );

    expect(json.status).toBe("ready");
    expect(
      json.interpretation.lines.map((l: any) => [l.text, l.source]),
    ).toEqual([
      [
        "Swap your jersey, socks and cleats for adidas ones — adidas ads can't show Nike",
        "brand",
      ],
      ['Add the headline "OWN THE MOMENT" across the top', "suggested"],
      ["Keep your face, hair, body and pose as they are", "yours"],
      ["No Nike logos anywhere in the photo", "brand"],
    ]);
    const { brief } = await storedRow(json.previewId);
    expect(brief.job.direction.statement).toBe(C_1A);
    expect(brief.brand?.brandId).toBe(adidas);
    expect(brief.job.editIntent).toMatchObject({
      version: 2,
      constraints: [
        { kind: "preserve_person" },
        { kind: "exclude_marks", brand: "nike" },
      ],
    });
    // Detection read the swaps' clauses of C — never her sentence.
    expect(detectionReads()).toEqual([
      "change my jersey to an adidas jersey and change my socks to adidas socks and change my cleats to adidas cleats",
    ]);

    const spend = await post("/studio/generate", {
      previewId: json.previewId,
    });
    expect(spend.status).toBe(200);
    const [, inputs] = (generate as jest.Mock).mock.calls[0];
    expect(inputs.prompt).toContain(
      "Keep the person's face, hair, body and pose exactly as they are.",
    );
    expect(inputs.prompt).toContain(
      "show any Nike logo anywhere in the photograph",
    );
  });

  it("hands QA who asked for each mark — adidas in and Nike out, both the brand's (N7)", async () => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
    process.env.STUDIO_CREATIVE_QA = "true";
    (inspectAsset as jest.Mock).mockClear();
    await seedBrand("adidas", "Athletic Apparel");
    answer(reply1a());
    detected("jersey", "socks", "cleats");
    const { json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), AD_1A),
    );
    expect(
      (await post("/studio/generate", { previewId: json.previewId })).status,
    ).toBe(200);
    expect(inspectAsset).toHaveBeenCalledTimes(1);
    expect((inspectAsset as jest.Mock).mock.calls[0][2]).toEqual({
      instruction: C_1A,
      provenance: {
        arrivals: [{ brand: "adidas", source: "brand" }],
        departures: [{ brand: "nike", source: "brand" }],
      },
    });
  });

  it("hands QA nothing new on a job the interpreter did not propose", async () => {
    process.env.STUDIO_CREATIVE_QA = "true";
    (inspectAsset as jest.Mock).mockClear();
    detected("blue socks");
    const { json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), "make the socks blue"),
    );
    expect(
      (await post("/studio/generate", { previewId: json.previewId })).status,
    ).toBe(200);
    expect((inspectAsset as jest.Mock).mock.calls[0][2]).toEqual({
      instruction: "make the socks blue",
    });
  });

  it("proceeds on the name alone when her brand has no row — and the preview says so", async () => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
    answer(reply1a());
    detected("jersey", "socks", "cleats");
    const { json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), AD_1A),
    );
    expect(json.status).toBe("ready");
    expect(json.warnings).toContainEqual(
      expect.objectContaining({
        field: "brand",
        note: "We don't have adidas's brand guidelines on file, so none are applied.",
      }),
    );
    expect((await storedRow(json.previewId)).brief.brand).toBeNull();
  });
});

// ─── 3. Every ask blocks ───────────────────────────────────────────────────────────────────────────

describe("every ask blocks — and detection never runs on her words", () => {
  it("blocks with her own ask when the model declines, and keeps what the call made of it", async () => {
    answer(DECLINE);
    const { json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), S),
    );

    expect(json.status).toBe("blocked");
    expect(json.blockers).toContainEqual(
      expect.objectContaining({
        field: "job.direction",
        note: freezeRefusalNote({
          ok: false,
          reason: "not_routed",
          askReason: "brand_change",
        }),
      }),
    );
    expect(detectRegionsMemoized).not.toHaveBeenCalled();
    expect("interpretation" in json).toBe(false);
    // A decline is never a new image — the response says so only for the exit's own answer.
    expect("newImage" in json).toBe(false);
    const { brief } = await storedRow(json.previewId);
    expect(brief.job.direction.statement).toBe(S);
    expect(brief.job.interpretation).toMatchObject({
      from: S,
      outcome: "declined",
      canonical: null,
    });
    expect("editIntent" in brief.job).toBe(false);
  });

  it("EXITS a new image to a generate, her marked frame carried as her likeness — and nothing is detected or frozen (the new-image exit, wave D card 1)", async () => {
    const SCENE = "me on a beach";
    expect(route(SCENE, true, { objects: 0 })).toMatchObject({
      initialPath: "ASK",
      reason: "fast_path_declined",
    });
    answer(
      JSON.stringify({
        decline: false,
        newImage: true,
        spans: [],
        edits: [],
        constraints: [],
        visibleMarks: [],
      }),
    );
    const frameId = await seedFrame();
    const { json } = await post("/studio/preview", editReq(frameId, SCENE));

    // The verdict is HONOURED: a new picture of her is a generate, not a blocked edit of this one.
    expect(json.status).not.toBe("blocked");
    expect(json.newImage).toBe(true);
    const { brief } = await storedRow(json.previewId);
    expect(brief.job.mode).toBe("generate");
    expect(brief.job.source).toBeNull();
    // Her frame is her LIKENESS now — the role's second reading, never the thing being edited.
    expect(brief.job.references).toEqual([
      expect.objectContaining({ role: "person", mediaAssetId: frameId }),
    ]);
    // Nothing detected, nothing frozen — a generate has no region to find and no intent to freeze.
    expect(detectRegionsMemoized).not.toHaveBeenCalled();
    expect("editIntent" in brief.job).toBe(false);
    expect(brief.job.direction.statement).toBe(SCENE);
    expect(brief.job.interpretation).toMatchObject({
      from: SCENE,
      outcome: "new_image",
      askReason: "new_image",
      canonical: null,
      lines: [],
    });
    expect(logged.filter((l) => l.toLowerCase().includes(SCENE))).toEqual([]);
  });

  it("does NOT take the exit on a MOTION deliverable — the video blocker says the useful thing (wave D card 1)", async () => {
    // `image.edit` + "clip" passes the request's pair check, so it reaches the interpreter. Turning
    // the mode to `generate` would SATISFY taskFor instead of tripping it: the preview would come
    // back ready as a video.generate, quoted at video prices, and she would get a clip she never
    // asked for — in place of copy that tells her to generate it as a new clip. (Before video V3
    // this was a 503 from `assertRunnableInline`; the reason for the blocker is unchanged.)
    const SCENE = "me on a beach";
    answer(
      JSON.stringify({
        decline: false,
        newImage: true,
        spans: [],
        edits: [],
        constraints: [],
        visibleMarks: [],
      }),
    );
    const { json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), SCENE, { deliverable: "clip" }),
    );

    expect(json.status).toBe("blocked");
    const { brief } = await storedRow(json.previewId);
    // Still an EDIT, so taskFor refuses it as one — never a ready video quote.
    expect(brief.job.mode).toBe("edit");
    expect(json.newImage).toBeUndefined();
  });

  it("does NOT add the frame when she attached a likeness of her own — hers is a choice, the frame is only the fallback (wave D card 1)", async () => {
    const SCENE = "me on a beach";
    answer(
      JSON.stringify({
        decline: false,
        newImage: true,
        spans: [],
        edits: [],
        constraints: [],
        visibleMarks: [],
      }),
    );
    const frameId = await seedFrame();
    const hers = await seedFrame();
    const { json } = await post(
      "/studio/preview",
      editReq(frameId, SCENE, {
        references: [{ assetId: hers, role: "person" }],
      }),
    );

    expect(json.newImage).toBe(true);
    const { brief } = await storedRow(json.previewId);
    expect(brief.job.mode).toBe("generate");
    expect(brief.job.references).toEqual([
      expect.objectContaining({ role: "person", mediaAssetId: hers }),
    ]);
  });

  it("asks which brand — before any call — when an ad has none anywhere", async () => {
    answer(REPLY);
    const { json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), "turn this into an ad"),
    );
    expect(json.status).toBe("blocked");
    expect(json.blockers).toContainEqual(
      expect.objectContaining({
        note: "An ad for which brand? Name it — 'turn this into an adidas ad' — or start from Brand post and pick it.",
      }),
    );
    expect(geminiTransport).not.toHaveBeenCalled();
    expect(detectRegionsMemoized).not.toHaveBeenCalled();
    expect(
      "interpretation" in (await storedRow(json.previewId)).brief.job,
    ).toBe(false);
  });

  it("asks when the brand she named is not the one she picked", async () => {
    const nike = await seedBrand("Nike");
    answer(REPLY);
    const { json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), AD_1A, { brandId: nike }),
    );
    expect(json.blockers).toContainEqual(
      expect.objectContaining({
        note: "That ad names a different brand from the one you picked, or more than one. Name the one brand it's for.",
      }),
    );
    expect(geminiTransport).not.toHaveBeenCalled();
  });

  it("never interprets a box she drew, a sentence the rules read, or her body", async () => {
    answer(REPLY);
    detected("jersey");
    const drawn = [
      { label: "jersey", left: 0.4, top: 0.3, width: 0.2, height: 0.2 },
    ];
    await post(
      "/studio/preview",
      editReq(await seedFrame(), S, { regions: drawn }),
    );
    detected("socks");
    await post(
      "/studio/preview",
      editReq(await seedFrame(), "make the socks blue"),
    );
    await post(
      "/studio/preview",
      editReq(await seedFrame(), "make my face thinner"),
    );
    expect(geminiTransport).not.toHaveBeenCalled();
  });

  it("never reads another athlete's photograph — the same 404, and no call", async () => {
    answer(REPLY);
    const theirs = await seedFrame(otherAthleteId);
    const { status } = await post("/studio/preview", editReq(theirs, S));
    expect(status).toBe(404);
    expect(geminiTransport).not.toHaveBeenCalled();
    expect(probeBytesFor).not.toHaveBeenCalled();
  });
});

// ─── 4. Not what I meant ───────────────────────────────────────────────────────────────────────────

describe("'Not what I meant' refuses her own interpreted preview, and nothing else", () => {
  const reject = (previewId: string) =>
    post(`/studio/previews/${previewId}/interpretation/reject`, {});

  async function interpretedPreview(): Promise<string> {
    answer(REPLY);
    detected("jersey");
    const { json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), S),
    );
    expect(json.status).toBe("ready");
    return json.previewId;
  }

  it("records the rejection and blocks the row, so it can never be spent", async () => {
    const previewId = await interpretedPreview();
    const res = await reject(previewId);
    expect(res).toEqual({ status: 200, json: { previewId, rejected: true } });

    const row = await storedRow(previewId);
    expect(row.status).toBe("blocked");
    expect(typeof row.plan.interpretation_rejected_at).toBe("string");
    const spend = await post("/studio/generate", { previewId });
    expect(spend.status).toBe(409);
    expect(generate).not.toHaveBeenCalled();
  });

  it("changes nothing on another athlete's preview — the same 404 a missing one gets", async () => {
    const previewId = await interpretedPreview();
    asUser(otherAthleteId);
    expect((await reject(previewId)).status).toBe(404);
    expect((await reject("00000000-0000-4000-8000-000000000000")).status).toBe(
      404,
    );
    expect((await reject("not-a-uuid")).status).toBe(404);
    asUser(athleteId);
    const row = await storedRow(previewId);
    expect(row.status).toBe("ready");
    expect(row.plan?.interpretation_rejected_at).toBeUndefined();
  });

  it("refuses a preview the interpreter never read, and one Generate already spent", async () => {
    detected("blue socks");
    const plain = await post(
      "/studio/preview",
      editReq(await seedFrame(), "make the socks blue"),
    );
    expect((await reject(plain.json.previewId)).status).toBe(409);
    expect((await storedRow(plain.json.previewId)).status).toBe("ready");

    const previewId = await interpretedPreview();
    expect((await post("/studio/generate", { previewId })).status).toBe(200);
    expect((await reject(previewId)).status).toBe(409);
  });
});

// ─── /studio/classify ──────────────────────────────────────────────────────────────────────────────

describe("/studio/classify says whether the preview may interpret — and spends nothing", () => {
  const classify = (direction: string, hasSourcePhoto = true) =>
    post("/studio/classify", { direction, hasSourcePhoto });

  it("is true for an eligible ask with a photo and both flags on", async () => {
    expect((await classify(S)).json).toMatchObject({
      initialPath: "ASK",
      reason: "brand_change",
      interpretable: true,
    });
    expect(geminiTransport).not.toHaveBeenCalled();
  });

  it("is false with the flag off, without a photo, on a routed answer, and on her body", async () => {
    expect((await classify(S, false)).json.interpretable).toBe(false);
    expect((await classify("make the socks blue")).json.interpretable).toBe(
      false,
    );
    expect((await classify("make my face thinner")).json.interpretable).toBe(
      false,
    );
    delete process.env.STUDIO_INTERPRETER;
    expect((await classify(S)).json.interpretable).toBe(false);
  });
});

// ─── 5. The log ────────────────────────────────────────────────────────────────────────────────────

describe("no log line on the path carries her sentence or C", () => {
  it("holds across a proposal, an ad, a decline and the gate", async () => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
    answer(REPLY);
    detected("jersey");
    await post("/studio/preview", editReq(await seedFrame(), S));
    __clearInterpreterMemo();
    answer(reply1a());
    detected("jersey", "socks", "cleats");
    await post("/studio/preview", editReq(await seedFrame(), AD_1A));
    __clearInterpreterMemo();
    answer(DECLINE);
    await post("/studio/preview", editReq(await seedFrame(), S));
    await post(
      "/studio/preview",
      editReq(await seedFrame(), "turn this into an ad"),
    );

    expect(logged.length).toBeGreaterThan(0);
    const said = [S, C, AD_1A, C_1A, "turn this into an ad"].map((x) =>
      x.toLowerCase(),
    );
    const leaks = logged.filter((line) =>
      said.some((x) => line.toLowerCase().includes(x)),
    );
    expect(leaks).toEqual([]);
  });
});

// ─── Her keep beside a sentence the rules read (A3b, the style vocabulary's branch) ────────────────

describe("a preview the rules read with her keep beside them shows the same card — and nothing to refuse (A3b)", () => {
  const WARM_KEEP = "make it warmer, dont change anything about me";
  const lines = (look: string) => [
    { kind: "change", text: look, source: "yours" },
    {
      kind: "constraint",
      text: "Keep your face, hair, body and pose as they are",
      source: "yours",
    },
  ];
  const KEEP_SENTENCE =
    "Keep the person's face, hair, body and pose exactly as they are.";

  it("freezes the look and her keep (version 2), shows the card, and detection never reads her keep — the interpreter on or off", async () => {
    for (const interpreter of [true, false]) {
      if (interpreter) process.env.STUDIO_INTERPRETER = "true";
      else delete process.env.STUDIO_INTERPRETER;
      (detectRegionsMemoized as jest.Mock).mockClear();
      detected("jersey");
      const { status, json } = await post(
        "/studio/preview",
        editReq(await seedFrame(), WARM_KEEP),
      );
      expect({ interpreter, status }).toEqual({ interpreter, status: 200 });
      expect("interpretation" in json).toBe(false);
      expect(json.card).toEqual({ lines: lines("Make it warmer") });

      const { brief } = await storedRow(json.previewId);
      expect(brief.job.direction.statement).toBe(WARM_KEEP);
      expect(brief.job.editIntent).toMatchObject({
        version: 2,
        changes: [{ op: "GLOBAL_STYLE", target: null, change: "warmer" }],
        constraints: [{ kind: "preserve_person" }],
      });
      expect(brief.job.card).toEqual({ lines: lines("Make it warmer") });
      expect("interpretation" in brief.job).toBe(false);
      expect(detectionReads()).toEqual(["make it warmer"]);
    }
    // It routes, so the interpreter never runs on it.
    expect(geminiTransport).not.toHaveBeenCalled();
  });

  it("is spent as quoted: the re-check agrees, and the prompt carries the keep sentence", async () => {
    detected("jersey");
    const preview = await post(
      "/studio/preview",
      editReq(await seedFrame(), WARM_KEEP),
    );
    const spend = await post("/studio/generate", {
      previewId: preview.json.previewId,
    });
    expect(spend.status).toBe(200);
    const [, inputs] = (generate as jest.Mock).mock.calls[0];
    expect(inputs.prompt).toContain(
      "give the whole photograph this look: warmer.",
    );
    expect(inputs.prompt).toContain(KEEP_SENTENCE);
  });

  it("compiles 'make it golden hour, keep me the same' as the look — never 'make the same golden'", async () => {
    detected("jersey");
    const preview = await post(
      "/studio/preview",
      editReq(await seedFrame(), "make it golden hour, keep me the same"),
    );
    expect(preview.json.card).toEqual({ lines: lines("Make it golden hour") });
    const spend = await post("/studio/generate", {
      previewId: preview.json.previewId,
    });
    expect(spend.status).toBe(200);
    const [, inputs] = (generate as jest.Mock).mock.calls[0];
    expect(inputs.prompt).toContain(
      "give the whole photograph this look: golden hour.",
    );
    expect(inputs.prompt).toContain(KEEP_SENTENCE);
    expect(inputs.prompt).not.toContain("the same");
  });

  it("shows no rules' card with no keep, on a box she drew, or on a preview the interpreter read (its own card)", async () => {
    detected("jersey");
    const plain = await post(
      "/studio/preview",
      editReq(await seedFrame(), "make it warmer"),
    );
    expect("card" in plain.json).toBe(false);
    expect("card" in (await storedRow(plain.json.previewId)).brief.job).toBe(
      false,
    );

    // A box she drew runs masked, with no frozen intent — so no promise to show.
    const drawn = [
      { label: "jersey", left: 0.4, top: 0.3, width: 0.2, height: 0.2 },
    ];
    const boxed = await post(
      "/studio/preview",
      editReq(await seedFrame(), WARM_KEEP, { regions: drawn }),
    );
    expect("card" in boxed.json).toBe(false);

    answer(REPLY);
    detected("jersey");
    const interpreted = await post(
      "/studio/preview",
      editReq(await seedFrame(), S),
    );
    expect(interpreted.json.interpretation).toBeDefined();
    expect("card" in interpreted.json).toBe(false);
  });
});
