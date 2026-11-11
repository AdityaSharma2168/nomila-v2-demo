/**
 * engine.style.test.ts — a style reference as a MODIFIER on a typed edit, end to end on PGlite (PR 18), from the
 * client's own request body through the real route and engine to the adapter's prompt, with the router, the
 * store and detection stood in. Then identity on accept (R-6, R-13).
 *
 * Red by name when taken out:
 *   M2  "a second edit off the same reference re-decomposes"
 *   M3  "a raw style image is forwarded to the model"
 *   M4  "a style reference is usable before decomposition"
 *   M13 "an accepted edit is never inspected"
 *   M14 "a failed identity check blocks an accept"
 *   M15 "an identity score is shown for an athlete whose control failed"
 *   M18 "the style spec never reaches an edit through the real client path"   (crosses the boundary)
 *   M20 "a spec derived under a new version replays an old quote differently"
 * And tenancy: another athlete's reference resolves to nothing.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

const mockStore = new Map<string, { buf: Buffer; contentType: string }>();
jest.mock("../../lib/mediaStore", () => ({
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
  saveBuffer: jest.fn(
    async (buf: Buffer, basePath: string, contentType: string) => {
      const path = `${basePath}.${contentType === "image/png" ? "png" : "jpg"}`;
      mockStore.set(path, { buf, contentType });
      return { gcs_path: path, content_type: contentType, bytes: buf.length };
    },
  ),
  readObject: jest.fn(async (p: string) => mockStore.get(p) ?? null),
  deleteObject: jest.fn(async (p: string) => {
    mockStore.delete(p);
  }),
  rehostFromUrl: jest.fn(),
  headObject: jest.fn(),
  uploadLocalFile: jest.fn(),
  deletePrefix: jest.fn(),
  signedUploadUrl: jest.fn(),
  UPLOAD_LIMITS: { image: 25 * 1024 * 1024, video: 25 * 1024 * 1024 },
  uploadKind: () => "image",
  uploadObjectPath: () => "",
  REVIEW_SUFFIX: ".review.jpg",
  reviewObjectPath: () => "",
}));

const mockGenerate = jest.fn();
jest.mock("../router", () => ({
  ...jest.requireActual("../router"),
  generate: (...a: unknown[]) => mockGenerate(...a),
}));

const mockDetect = jest.fn();
jest.mock("../autoMask", () => ({
  ...jest.requireActual("../autoMask"),
  detectRegionsMemoized: (...a: unknown[]) => mockDetect(...a),
  probeBytesFor: jest.fn(),
}));

const mockProbe = jest.fn();
jest.mock("../imageSize", () => ({
  ...jest.requireActual("../imageSize"),
  probeImageSize: (...a: unknown[]) => mockProbe(...a),
}));

const mockResolveRef = jest.fn();
jest.mock("../generate", () => ({
  ...jest.requireActual("../generate"),
  resolveStoredReference: (...a: unknown[]) => mockResolveRef(...a),
}));

// The reference engine and its transport: counted, so "no new model call" is a number, not a hope.
const mockDecompose = jest.fn();
jest.mock("../reference/decompose", () => ({
  ...jest.requireActual("../reference/decompose"),
  decomposeReference: (...a: unknown[]) => mockDecompose(...a),
}));
const mockTransport = jest.fn();
jest.mock("../reference/transport", () => ({
  ...jest.requireActual("../reference/transport"),
  geminiReferenceTransport: (...a: unknown[]) => mockTransport(...a),
}));

// The identity instrument: stood in at checkIdentity, so its spend and its answer are the test's.
const mockCheckIdentity = jest.fn();
jest.mock("../qa/identity", () => ({
  ...jest.requireActual("../qa/identity"),
  checkIdentity: (...a: unknown[]) => mockCheckIdentity(...a),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import {
  client,
  closeTestDb,
  db,
  initTestDb,
  seedAthlete,
} from "../../testUtils/pgliteDb";
import {
  athleteSnapshots,
  athletesCurrent,
  identityProfiles,
  mediaAssets,
  studioReferenceAnalyses,
} from "../../../shared/schema";
import { acceptEdit, quoteEdit, runEdit } from "./engine";
import { registerEditRoutes } from "./routes";
import { settleEditIdentity, EDIT_IDENTITY_KEY } from "./identityOnAccept";
import {
  paramsFor,
  quoteBodyFor,
} from "../../../client/screens/studio/editPopoverLogic";
import { READING } from "../reference/styleFixtures";
import { STYLE_CLOSE, STYLE_OPEN } from "../compile/style";
import { STYLE_UNREAD_COPY } from "../reference/styleSpec";

const W = 640;
const H = 960;
let SOURCE_PNG: Buffer;
let OUT_PNG: Buffer;

let A: string;
let B: string;
let hers: string;
let herLook: string;
let unread: string;
let theirLook: string;
let server: Server;
let base: string;

async function seedAsset(
  athleteId: string,
  over: Record<string, unknown> = {},
): Promise<{ id: string; gcsPath: string }> {
  const gcsPath = `athletes/${athleteId}/${Math.random().toString(36).slice(2)}.png`;
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: athleteId,
      platform: "upload",
      origin: "upload",
      media_type: "IMAGE",
      status: "stored",
      gcs_path: gcsPath,
      width: W,
      height: H,
      metadata: { vision: { subject: "the_athlete", athlete_present: true } },
      ...over,
    } as never)
    .returning({ id: mediaAssets.id });
  return { id: row.id, gcsPath };
}

async function seedReading(
  athleteId: string,
  assetId: string,
  decomposition: unknown = READING,
) {
  await db.insert(studioReferenceAnalyses).values({
    athlete_id: athleteId,
    source_kind: "image",
    source_asset_id: assetId,
    role: "style_reference",
    decomposition,
    prompt_version: "reference/1",
    model: "gemini-flash-synthetic",
  } as never);
}

const lookPath = new Map<string, string>();

beforeAll(async () => {
  process.env.STUDIO_NATIVE_EDIT = "true";
  process.env.STUDIO_DISPLAY_TEXT = "true";
  process.env.STUDIO_IMAGE_EDIT_OPS = "true";
  await initTestDb();
  await client.exec(
    readFileSync(join(__dirname, "..", "sql", "generationGuards.sql"), "utf8"),
  );
  A = await seedAthlete("Athlete A");
  B = await seedAthlete("Athlete B");
  for (const id of [A, B]) {
    await db.insert(athletesCurrent).values({
      athlete_id: id,
      story_arc: "A synthetic athlete.",
    } as never);
    await db.insert(athleteSnapshots).values({
      athlete_id: id,
      trigger: "manual",
      research: {
        story_arc: "A synthetic athlete.",
        achievements: [],
        brand_mentions: [],
        values: [],
      },
      google_trends_score: "0",
      gdelt_article_count: 0,
      social: {},
      deals: [],
    } as never);
  }
  SOURCE_PNG = await sharp({
    create: { width: W, height: H, channels: 3, background: "#4060a0" },
  })
    .png()
    .toBuffer();
  OUT_PNG = await sharp({
    create: { width: W, height: H, channels: 3, background: "#a04040" },
  })
    .png()
    .toBuffer();

  const h = await seedAsset(A);
  hers = h.id;
  mockStore.set(h.gcsPath, { buf: SOURCE_PNG, contentType: "image/png" });
  const look = await seedAsset(A, { origin: "reference", metadata: {} });
  herLook = look.id;
  lookPath.set(herLook, look.gcsPath);
  await seedReading(A, herLook);
  unread = (await seedAsset(A, { origin: "reference", metadata: {} })).id;
  const theirs = await seedAsset(B, { origin: "reference", metadata: {} });
  theirLook = theirs.id;
  await seedReading(B, theirLook);

  // Her band, and her stranger control passed; B's control failed.
  await db.insert(identityProfiles).values([
    {
      athlete_id: A,
      band_min: "0.15",
      band_max: "0.45",
      band_pairs: 45,
      band_measured_at: new Date("2026-09-24T00:00:00Z"),
      control_passed: true,
    },
    {
      athlete_id: B,
      band_min: "0.15",
      band_max: "0.45",
      band_pairs: 45,
      band_measured_at: new Date("2026-09-24T00:00:00Z"),
      control_passed: false,
    },
  ] as never);

  const app = express();
  app.use(express.json());
  const router = express.Router();
  const gate: RequestHandler = (req, _res, next) => {
    req.athleteId = A;
    next();
  };
  registerEditRoutes(router, [gate]);
  app.use("/api/v1/me", router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/me`;
}, 120_000);

afterAll(async () => {
  delete process.env.STUDIO_NATIVE_EDIT;
  delete process.env.STUDIO_DISPLAY_TEXT;
  delete process.env.STUDIO_IMAGE_EDIT_OPS;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(() => {
  process.env.STUDIO_STYLE_SPEC = "true";
  for (const m of [
    mockGenerate,
    mockDetect,
    mockProbe,
    mockResolveRef,
    mockDecompose,
    mockTransport,
    mockCheckIdentity,
  ])
    m.mockReset();
  mockProbe.mockResolvedValue({ width: W, height: H, orientation: 1 });
  mockDetect.mockResolvedValue({
    ok: true,
    regions: [
      { label: "jersey", left: 0.3, top: 0.3, width: 0.3, height: 0.3 },
    ],
  });
  mockResolveRef.mockImplementation(async () => ({
    kind: "bytes",
    bytes: SOURCE_PNG,
    mimeType: "image/png",
  }));
  mockGenerate.mockImplementation(async (task: string) => ({
    task,
    provider: "vertex",
    model: "gemini-3-pro-image",
    assets: [{ bytes: OUT_PNG, mimeType: "image/png" }],
    cost: { amountUsd: 0.165, currency: "USD", basis: "reported" },
    timings: {
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      ms: 1,
    },
  }));
  mockCheckIdentity.mockResolvedValue({
    status: "pass",
    summary:
      "Face distance 0.2 (within the same-person band 0.15–0.45). Recorded, not gated.",
    detail: {
      distance: 0.2,
      band: "within",
      bandRange: { min: 0.15, max: 0.45, pairs: 45 },
      comparedSourceAssetId: null,
      comparedOutputAssetId: null,
      chainDepth: 1,
      method: "face-crop/multimodalembedding@001",
      sourceFace: { confidence: 0.9, sizeFrac: 0.2, small: false },
      outputFace: { confidence: 0.9, sizeFrac: 0.2, small: false },
    },
    error: null,
    spend: {
      usd: 0.00128,
      basis: "estimated",
      visionCalls: 2,
      embedCalls: 2,
      inputTokens: 2600,
      outputTokens: 120,
    },
    latencyMs: 1,
  });
});
afterEach(() => {
  delete process.env.STUDIO_STYLE_SPEC;
  delete process.env.STUDIO_IDENTITY_PACK;
});

const post = async (path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
};

/** Her tap, as the edit sheet makes it: paramsFor, then quoteBodyFor, then the real route. */
const sheetQuote = (styleAssetId: string | null) =>
  post(
    "/studio/edits/quote",
    quoteBodyFor(
      hers,
      "recolour",
      paramsFor("recolour", { target: "jersey", colour: "red" }, null)!,
      styleAssetId,
    ),
  );

/** The prompt the adapter was handed on the last generate. */
const lastPrompt = (): string =>
  (mockGenerate.mock.calls.at(-1)![1] as { prompt: string }).prompt;

describe("the real client path (M18, crosses the client/server boundary)", () => {
  it("the style spec never reaches an edit through the real client path — it must: sheet body → route → engine → adapter prompt", async () => {
    const q = await sheetQuote(herLook);
    expect(q.status).toBe(200);
    expect(q.body.quote.sentence).toBe(
      "make the jersey red, and make it colour grade",
    );
    const ran = await post(`/studio/edits/${q.body.edit.id}/run`);
    expect(ran.status).toBe(200);
    const p = lastPrompt();
    expect(p).toContain(
      "give the whole photograph the look of the style reference below: its light, colour and mood",
    );
    expect(p).toContain(STYLE_OPEN);
    expect(p).toContain("ZQLIGHT");
    expect(p).toContain("LIGHT: hard light with crisp, defined shadows");
    // The edit keeps her frame: nothing about the reference's framing reaches an edit (ADI-GO18 G9).
    expect(p).not.toMatch(/ZQCOMP|ZQCAM|ZQENV|ZQWARD|CAMERA:|COMPOSITION:/);
  });

  it("with no look picked the sheet's body and the adapter's prompt are exactly today's", async () => {
    expect(
      quoteBodyFor(hers, "recolour", { target: "jersey", colour: "red" }, null),
    ).toEqual({
      sourceAssetId: hers,
      op: "recolour",
      params: { target: "jersey", colour: "red" },
    });
    const q = await sheetQuote(null);
    expect(q.body.quote.sentence).toBe("make the jersey red");
    await post(`/studio/edits/${q.body.edit.id}/run`);
    expect(lastPrompt()).not.toContain(STYLE_OPEN);
  });

  it("flag off: the route refuses the key exactly as the strict body always has", async () => {
    delete process.env.STUDIO_STYLE_SPEC;
    const q = await sheetQuote(herLook);
    expect(q.status).toBe(400);
    expect(q.body.error).toMatch(/styleAssetId|Unrecognized/);
  });
});

describe("R-8 and G8: the pixels never go, and an unread reference never shapes anything", () => {
  it("a raw style image is forwarded to the model — it must not: not a resolved ref, not a ref id, not in the prompt", async () => {
    const q = await sheetQuote(herLook);
    await post(`/studio/edits/${q.body.edit.id}/run`);
    const path = lookPath.get(herLook)!;
    const refsResolved = mockResolveRef.mock.calls.map(
      (c) => (c[0] as { ref: string }).ref,
    );
    expect(refsResolved).not.toContain(path);
    const [, inputs, opts] = mockGenerate.mock.calls.at(-1)!;
    expect((opts as { refIds: string[] }).refIds).not.toContain(path);
    expect((inputs as { references: unknown[] }).references).toHaveLength(1); // the frame alone
    expect(lastPrompt()).not.toContain(path);
  });

  it("a style reference is usable before decomposition — it must not: an unread image is refused, still reading", async () => {
    const out = await quoteEdit({
      athleteId: A,
      sourceAssetId: hers,
      op: "recolour",
      params: { target: "jersey", colour: "red" },
      styleAssetId: unread,
    });
    expect(out).toMatchObject({
      ok: false,
      status: 422,
      field: "styleAssetId",
      error: STYLE_UNREAD_COPY,
    });
    expect(mockDecompose).not.toHaveBeenCalled();
  });

  it("another athlete's reference resolves to nothing: not found, never her reading", async () => {
    const out = await quoteEdit({
      athleteId: A,
      sourceAssetId: hers,
      op: "recolour",
      params: { target: "jersey", colour: "red" },
      styleAssetId: theirLook,
    });
    expect(out).toMatchObject({
      ok: false,
      status: 404,
      field: "styleAssetId",
    });
  });
});

describe("P-reuse and G1: derived on read, frozen at quote", () => {
  it("a second edit off the same reference re-decomposes — it must not: two edits, zero reference-model calls", async () => {
    for (let i = 0; i < 2; i++) {
      const q = await sheetQuote(herLook);
      expect(q.status).toBe(200);
      expect((await post(`/studio/edits/${q.body.edit.id}/run`)).status).toBe(
        200,
      );
      expect(lastPrompt()).toContain("ZQLIGHT");
    }
    expect(mockDecompose).not.toHaveBeenCalled();
    expect(mockTransport).not.toHaveBeenCalled();
    // One paid call per edit, the image edit itself, and nothing else went to a model.
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  it("a spec derived under a new version replays an old quote differently — it must not: the run replays the frozen spec even when the stored reading changes under it", async () => {
    const own = await seedAsset(A, { origin: "reference", metadata: {} });
    await seedReading(A, own.id);
    const q = await sheetQuote(own.id);
    expect(q.status).toBe(200);
    // The reading changes after the quote (a re-read, a new derivation): the quote must not follow it.
    await db
      .update(studioReferenceAnalyses)
      .set({
        decomposition: {
          ...READING,
          reference_intent: {
            ...READING.reference_intent,
            lighting: {
              ...READING.reference_intent.lighting,
              summary: "ZQNEWLIGHT soft overcast, no shadows",
            },
          },
        },
      } as never)
      .where(eq(studioReferenceAnalyses.source_asset_id, own.id));
    await post(`/studio/edits/${q.body.edit.id}/run`);
    expect(lastPrompt()).toContain("ZQLIGHT hard midday sun");
    expect(lastPrompt()).not.toContain("ZQNEWLIGHT");
  });

  it("the cost line says which derivation shaped the edit", async () => {
    const q = await sheetQuote(herLook);
    await post(`/studio/edits/${q.body.edit.id}/run`);
    const opts = mockGenerate.mock.calls.at(-1)![2] as {
      attribution: { promptVersion: string };
    };
    expect(opts.attribution.promptVersion).toBe("typed-op/1+style-spec/1");
  });

  it("the style fence holds the reading on the adapter's prompt: nothing of it outside", async () => {
    const q = await sheetQuote(herLook);
    await post(`/studio/edits/${q.body.edit.id}/run`);
    const outside = lastPrompt().replace(
      new RegExp(`${STYLE_OPEN}[\\s\\S]*?${STYLE_CLOSE}`),
      "",
    );
    expect(outside).not.toMatch(/ZQ[A-Z]+/);
  });
});

describe("identity on accept (R-6, R-13; ADI-GO18 G10)", () => {
  const quoteRunAccept = async (styleAssetId: string | null = herLook) => {
    const q = await sheetQuote(styleAssetId);
    if (q.status !== 200) throw new Error(JSON.stringify(q.body));
    const ran = await runEdit({ athleteId: A, id: q.body.edit.id });
    if (!ran.ok) throw new Error(ran.error);
    return acceptEdit({ athleteId: A, id: q.body.edit.id });
  };
  const observationOn = async (assetId: string) => {
    const [row] = await db
      .select({ metadata: mediaAssets.metadata })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, assetId));
    return (row.metadata as Record<string, unknown> | null)?.[
      EDIT_IDENTITY_KEY
    ] as { status: string; band: { source: string } } | undefined;
  };

  it("an accepted edit is never inspected — it must be: output → source on her band, recorded as an observation", async () => {
    process.env.STUDIO_IDENTITY_PACK = "true";
    const out = await quoteRunAccept();
    if (!out.ok) throw new Error(out.error);
    await settleEditIdentity();
    expect(mockCheckIdentity).toHaveBeenCalledTimes(1);
    const [pair, band] = mockCheckIdentity.mock.calls[0] as [
      { sourceAssetId: string; outputAssetId: string },
      { min: number; max: number; pairs: number },
    ];
    expect(pair.sourceAssetId).toBe(hers);
    expect(pair.outputAssetId).toBe(out.assetId);
    expect(band).toEqual({ min: 0.15, max: 0.45, pairs: 45 });
    const obs = await observationOn(out.assetId);
    expect(obs).toMatchObject({
      status: "pass",
      band: { source: "her-control-passed" },
    });
  });

  it("any typed edit is observed, with or without a look", async () => {
    process.env.STUDIO_IDENTITY_PACK = "true";
    const out = await quoteRunAccept(null);
    if (!out.ok) throw new Error(out.error);
    await settleEditIdentity();
    expect(await observationOn(out.assetId)).toBeDefined();
  });

  it("a failed identity check blocks an accept — it must not: the check throws, the accept is exactly today's, nothing is recorded", async () => {
    process.env.STUDIO_IDENTITY_PACK = "true";
    mockCheckIdentity.mockRejectedValue(new Error("embedding unavailable"));
    const out = await quoteRunAccept();
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    await settleEditIdentity();
    expect(await observationOn(out.assetId)).toBeUndefined();
  });

  it("the accept does not wait for the check: a check that never answers still returns the accept", async () => {
    process.env.STUDIO_IDENTITY_PACK = "true";
    let release: (v: unknown) => void = () => {};
    mockCheckIdentity.mockReturnValue(
      new Promise((r) => {
        release = r;
      }),
    );
    const out = await quoteRunAccept();
    expect(out.ok).toBe(true);
    release({
      status: "unknown",
      summary: "",
      detail: null,
      error: "x",
      spend: {
        usd: 0,
        basis: "estimated",
        visionCalls: 0,
        embedCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
      latencyMs: 0,
    });
    await settleEditIdentity();
  });

  it("an identity score is shown for an athlete whose control failed — it must not: no observation, no call, nothing spent", async () => {
    process.env.STUDIO_IDENTITY_PACK = "true";
    const { observeAcceptedEdit } = await import("./identityOnAccept");
    const outcome = await observeAcceptedEdit({
      athleteId: B,
      sourceAssetId: theirLook,
      outputAssetId: theirLook,
      outputBytes: OUT_PNG,
      outputMimeType: "image/png",
      jobId: "00000000-0000-4000-8000-000000000000",
      instruction: "make the jersey red",
    });
    expect(outcome).toBe("skipped");
    expect(mockCheckIdentity).not.toHaveBeenCalled();
    expect(await observationOn(theirLook)).toBeUndefined();
  });

  it("gated on STUDIO_STYLE_SPEC && STUDIO_IDENTITY_PACK: either off, nothing runs", async () => {
    const out = await quoteRunAccept(null); // style on, pack off
    if (!out.ok) throw new Error(out.error);
    await settleEditIdentity();
    expect(mockCheckIdentity).not.toHaveBeenCalled();
    expect(await observationOn(out.assetId)).toBeUndefined();
  });
});
