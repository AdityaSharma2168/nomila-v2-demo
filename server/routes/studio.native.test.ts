/**
 * studio.native.test.ts — the native edit through BOTH doors: the preview that freezes it, and the
 * generate that spends it. End to end against in-memory Postgres.
 *
 * What only the routes can show, and so what this suite exists to prove:
 *
 *   1. The intent is frozen by the PREVIEW, onto the row that authorizes the spend — with the flag on,
 *      for a sentence detection derived regions from, and for nothing else. Flag off, or a box she
 *      drew, and the stored brief carries no intent at all.
 *   2. The quote is ONE call at the frozen size, and the generate leg sends exactly that: the whole
 *      frame, the frame's ratio, the frozen tier, and the compiled instruction.
 *   3. The spend-time re-check REFUSES a frozen intent it does not reproduce — before a job opens or
 *      the approval is claimed, and whether or not STUDIO_SERVER_ROUTING is on.
 *   4. A frozen intent spent after the flag went off refuses, and nothing falls back to masked.
 *
 * Mocked, and only these: detection (a Gemini call — its output is what the freeze reads, so the
 * tests say exactly what it returned), the billable router call, and storage. `estimate` is REAL, so
 * every quote below is the price table's own arithmetic.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.athleteId = (globalThis as any).__TEST_ATHLETE_ID;
    next();
  },
}));
// services/shotList builds a GoogleGenAI client at module load; nothing here calls it — except the
// live-path detection tests at the end, which answer through it as the model would.
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
    // The frame here is a synthetic JPEG header, which sharp cannot decode; the live-path tests stand
    // in for the probe's bytes and let everything after it run for real.
    probeBytesFor: jest.fn(),
  };
});

import express from "express";
import { readFileSync } from "fs";
import { join } from "path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, isNotNull } from "drizzle-orm";
import studioRouter, { NATIVE_INTENT_CHANGED } from "./studio";
import { generate } from "../studio/router";
import {
  detectRegionsMemoized,
  labelFor,
  probeBytesFor,
} from "../studio/autoMask";
import { genai } from "../lib/models";
import { imageSizeFrom } from "../studio/config";
import { NATIVE_EDIT_SWITCHED_OFF } from "../studio/generate";
import { freezeRefusalNote } from "../studio/nativeIntent";
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

/** Q5's measured prompt, verbatim — the compiled instruction must begin with it. */
const Q5_SHORTS =
  "make the shorts black and green. Keep everything else exactly as-is — change only the shorts.";
const SENTENCE = "make the shorts black and green";

let server: Server;
let base: string;
let athleteId: string;

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

// ─── The source frame, served synthetically (the same technique studio.test.ts uses) ────────────

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

/** A PNG signature + IHDR, so the shape guard measures the "returned" image for real. */
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

/** Her upload, 4000x6000 — N.1's source shape. */
async function seedFrame(): Promise<string> {
  const path = `athletes/${athleteId}/uploads/frame-${Math.random().toString(36).slice(2)}.jpg`;
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: athleteId,
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

/** What detection "found" — the freeze reads these labels, so each test states them. */
function detected(...labels: string[]) {
  (detectRegionsMemoized as jest.Mock).mockResolvedValue({
    ok: true,
    regions: labels.map((label, i) => ({
      label,
      left: 0.41,
      top: 0.59 + i * 0.1,
      width: 0.147,
      height: 0.097,
    })),
  });
}

const editReq = (
  sourceAssetId: string,
  direction: string,
  regions?: unknown,
) => ({
  intent: "image.edit",
  deliverable: "post",
  objective: "grow-following",
  sourceAssetId,
  direction,
  ...(regions ? { regions } : {}),
});

async function storedBrief(previewId: string): Promise<any> {
  const [row] = await db
    .select({ brief: studioGenerationPreviews.brief })
    .from(studioGenerationPreviews)
    .where(eq(studioGenerationPreviews.id, previewId));
  return row.brief;
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
  delete process.env.STUDIO_SERVER_ROUTING;
  delete process.env.STUDIO_CREATIVE_QA;
  asUser(athleteId);
  (generate as jest.Mock).mockReset().mockResolvedValue({
    task: "image.edit",
    provider: "vertex",
    model: "gemini-3-pro-image",
    // A 4K full-frame return for a 4000x6000 frame (probe memo, Q5L).
    assets: [{ mimeType: "image/png", bytes: pngBytes(3392, 5056) }],
    cost: { amountUsd: 0.24, currency: "USD", basis: "estimated" },
    timings: {
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      ms: 10,
    },
    raw: {},
  });
  (detectRegionsMemoized as jest.Mock).mockReset();
  // In FK order. The two tables point at each other — a generated asset at its job, an edit's job at
  // its source upload — so the generated rows go first, then the jobs, then the uploads.
  await db.delete(studioGenerationPreviews);
  await db.delete(mediaAssets).where(isNotNull(mediaAssets.generation_job_id));
  await db.delete(generationJobs);
  await db.delete(mediaAssets);
});

afterEach(() => {
  delete process.env.STUDIO_NATIVE_EDIT;
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("the preview FREEZES the intent onto the row that authorizes the spend", () => {
  it("quotes ONE native call at 4K for her sentence, and the stored brief carries the intent", async () => {
    detected("black and green shorts");
    const { status, json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), SENTENCE),
    );

    expect(status).toBe(200);
    expect(json.status).toBe("ready");
    // (2000 image tokens at 4K + 258 for the one reference) × $0.00012 — the price table's own sum.
    expect(json.cost.amountUsd).toBe(0.271);

    const intent = (await storedBrief(json.previewId)).job.editIntent;
    expect(intent).toMatchObject({
      version: 1,
      imageSize: "4K",
      changes: [{ op: "RECOLOR", target: "shorts", change: "black and green" }],
    });
  });

  it("freezes NOTHING with the flag off — the stored brief has no key, and the quote is masked", async () => {
    delete process.env.STUDIO_NATIVE_EDIT;
    detected("black and green shorts");
    const { json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), SENTENCE),
    );

    expect("editIntent" in (await storedBrief(json.previewId)).job).toBe(false);
    // One 2K crop plus its reference — what this preview quoted before the flag existed.
    expect(json.cost.amountUsd).toBe(0.1654);
  });

  it("leaves a box she DREW on the masked path with the flag on — explicit spatial intent", async () => {
    const drawn = [
      {
        label: "black and green shorts",
        left: 0.41,
        top: 0.59,
        width: 0.147,
        height: 0.097,
      },
    ];
    const { json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), SENTENCE, drawn),
    );

    expect(detectRegionsMemoized).not.toHaveBeenCalled();
    expect("editIntent" in (await storedBrief(json.previewId)).job).toBe(false);
    expect(json.cost.amountUsd).toBe(0.1654);
  });

  it("BLOCKS on the echo fallback, and that preview can never be spent", async () => {
    // The recolour whose echo would pair (see nativeIntent.test.ts), with detection's fallback label.
    const ask = "i want blue on the socks";
    detected(labelFor(ask));
    const preview = await post(
      "/studio/preview",
      editReq(await seedFrame(), ask),
    );

    expect(preview.json.status).toBe("blocked");
    expect(preview.json.blockers).toContainEqual(
      expect.objectContaining({ field: "job.direction", severity: "blocking" }),
    );
    expect(
      "editIntent" in (await storedBrief(preview.json.previewId)).job,
    ).toBe(false);

    const spend = await post("/studio/generate", {
      previewId: preview.json.previewId,
    });
    expect(spend.status).toBe(409);
    expect(generate).not.toHaveBeenCalled();
  });

  it("an ASK still ASKs — blocked at the preview, nothing frozen", async () => {
    detected("something cool");
    const { json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), "do something cool with this"),
    );
    expect(json.status).toBe("blocked");
    expect("editIntent" in (await storedBrief(json.previewId)).job).toBe(false);
  });
});

describe("the generate leg spends exactly what was frozen", () => {
  it("makes one call: the whole frame, the frame's ratio, the frozen tier, the compiled instruction", async () => {
    detected("black and green shorts");
    const preview = await post(
      "/studio/preview",
      editReq(await seedFrame(), SENTENCE),
    );
    const spend = await post("/studio/generate", {
      previewId: preview.json.previewId,
    });

    expect(spend.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
    const [task, inputs, opts] = (generate as jest.Mock).mock.calls[0];
    expect(task).toBe("image.edit");
    expect(inputs.references).toHaveLength(1);
    expect(inputs.references[0]).toMatchObject({ slot: "frame" });
    expect(inputs.aspectRatio).toBe("2:3");
    expect(imageSizeFrom(opts.providerParams)).toBe("4K");
    expect(inputs.prompt.startsWith(Q5_SHORTS)).toBe(true);
    expect(inputs.prompt).toMatch(
      /Keep the original photograph's lighting, exposure, contrast, colour grade and scene/,
    );
  });
});

describe("the spend-time re-check refuses a frozen intent it does not reproduce", () => {
  /** Rewrite the stored brief's statement — what the re-check reads — leaving the frozen intent as it was. */
  async function tamper(previewId: string, statement: string): Promise<void> {
    const brief = await storedBrief(previewId);
    brief.job.direction.statement = statement;
    await db
      .update(studioGenerationPreviews)
      .set({ brief } as any)
      .where(eq(studioGenerationPreviews.id, previewId));
  }

  async function expectNothingSpent(previewId: string) {
    expect(generate).not.toHaveBeenCalled();
    expect(await db.select().from(generationJobs)).toHaveLength(0);
    const [row] = await db
      .select({ consumed: studioGenerationPreviews.consumed_at })
      .from(studioGenerationPreviews)
      .where(eq(studioGenerationPreviews.id, previewId));
    expect(row.consumed).toBeNull();
  }

  it("refuses a changed value, with STUDIO_SERVER_ROUTING off — the native path owns this check", async () => {
    detected("black and green shorts");
    const preview = await post(
      "/studio/preview",
      editReq(await seedFrame(), SENTENCE),
    );
    await tamper(preview.json.previewId, "make the shorts red");

    const spend = await post("/studio/generate", {
      previewId: preview.json.previewId,
    });
    expect(spend.status).toBe(409);
    expect(spend.json.error).toBe(NATIVE_INTENT_CHANGED);
    await expectNothingSpent(preview.json.previewId);
  });

  it("refuses when the re-check would ASK — never resolves toward either answer", async () => {
    detected("black and green shorts");
    const preview = await post(
      "/studio/preview",
      editReq(await seedFrame(), SENTENCE),
    );
    await tamper(preview.json.previewId, "do something cool with this");

    const spend = await post("/studio/generate", {
      previewId: preview.json.previewId,
    });
    expect(spend.status).toBe(409);
    expect(spend.json.error).toBe(NATIVE_INTENT_CHANGED);
    await expectNothingSpent(preview.json.previewId);
  });

  it("refuses a frozen intent once the flag is off — nothing falls back to masked", async () => {
    detected("black and green shorts");
    const preview = await post(
      "/studio/preview",
      editReq(await seedFrame(), SENTENCE),
    );
    delete process.env.STUDIO_NATIVE_EDIT;

    const spend = await post("/studio/generate", {
      previewId: preview.json.previewId,
    });
    expect(spend.status).toBe(409);
    expect(spend.json.error).toBe(NATIVE_EDIT_SWITCHED_OFF);
    await expectNothingSpent(preview.json.previewId);
  });
});

describe("the resolution record — accepted, recorded, and shown before she pays (N.3)", () => {
  it("warns on the preview, and leaves tier, source and output one join apart on the record", async () => {
    detected("black and green shorts");
    const preview = await post(
      "/studio/preview",
      editReq(await seedFrame(), SENTENCE),
    );
    expect(preview.json.warnings).toContainEqual(
      expect.objectContaining({
        field: "job.source",
        severity: "degraded",
        note: expect.stringMatching(
          /about 17 megapixels, and your photo is 24/,
        ),
      }),
    );

    await post("/studio/generate", { previewId: preview.json.previewId });

    // The query the pricing conversation runs: the frozen brief on the job, the measured output on
    // the asset. Tenancy in the predicate, as it would be anywhere else.
    const [record] = await db
      .select({
        brief: generationJobs.brief,
        outW: mediaAssets.width,
        outH: mediaAssets.height,
      })
      .from(generationJobs)
      .innerJoin(
        mediaAssets,
        eq(mediaAssets.generation_job_id, generationJobs.id),
      )
      .where(eq(generationJobs.athlete_id, athleteId));
    const job = (record.brief as any).job;
    expect({
      tier: job.editIntent.imageSize,
      source: [job.source.width, job.source.height],
      output: [record.outW, record.outH],
    }).toEqual({ tier: "4K", source: [4000, 6000], output: [3392, 5056] });
  });
});

describe("an add is MEASURED, never detected — and runs native or not at all (PR C′)", () => {
  const ADD = "put a water bottle on the grass";

  it("skips detection, measures the frame, and freezes the add onto the row", async () => {
    const { status, json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), ADD),
    );

    expect(status).toBe(200);
    // Nothing to find: the bottle is not in the photograph yet. Detection is not asked, and not paid.
    expect(detectRegionsMemoized).not.toHaveBeenCalled();
    expect(json.status).toBe("ready");
    expect(json.derivedRegions).toBeUndefined();

    const brief = await storedBrief(json.previewId);
    // Measured, because the ratio and the size are pinned from it — and no regions, by design.
    expect(brief.job.source).toMatchObject({
      width: 4000,
      height: 6000,
      editRegions: [],
    });
    expect(brief.job.editIntent.changes).toEqual([
      {
        op: "ADD_OBJECT",
        target: null,
        change: null,
        add: {
          thing: "water bottle",
          place: "on the grass",
          objectAssetId: null,
        },
      },
    ]);
  });

  it("BLOCKS with the flag off, in its own words — no detection, no 'mark the photo' copy, never spendable", async () => {
    delete process.env.STUDIO_NATIVE_EDIT;
    const preview = await post(
      "/studio/preview",
      editReq(await seedFrame(), ADD),
    );

    expect(detectRegionsMemoized).not.toHaveBeenCalled();
    expect(preview.json.status).toBe("blocked");
    expect(preview.json.verdict.reason).toBe(
      freezeRefusalNote({ ok: false, reason: "native_edit_off" }),
    );
    // The no-regions gap would surface as "Mark the part of the photo you want changed" — true of
    // a recolour with no box, false of an add. Only the add's own refusal blocks.
    expect(preview.json.blockers.map((b: any) => b.field)).toEqual([
      "job.direction",
    ]);

    const spend = await post("/studio/generate", {
      previewId: preview.json.previewId,
    });
    expect(spend.status).toBe(409);
    expect(generate).not.toHaveBeenCalled();
  });

  it("spends ONE call: the whole frame, the frame's ratio, the add's compiled instruction", async () => {
    const preview = await post(
      "/studio/preview",
      editReq(await seedFrame(), ADD),
    );
    const spend = await post("/studio/generate", {
      previewId: preview.json.previewId,
    });

    // The spend-time re-check ran and reproduced the add — a refusal would be a 409 here.
    expect(spend.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
    const [task, inputs] = (generate as jest.Mock).mock.calls[0];
    expect(task).toBe("image.edit");
    expect(inputs.references).toHaveLength(1);
    expect(inputs.references[0]).toMatchObject({ slot: "frame" });
    expect(inputs.aspectRatio).toBe("2:3");
    expect(
      inputs.prompt.startsWith("add a water bottle, place it on the grass."),
    ).toBe(true);
  });
});

describe("a composed sentence runs native or not at all (composition, 6a)", () => {
  it("BLOCKS with the flag off in its own words, and that preview can never be spent", async () => {
    delete process.env.STUDIO_NATIVE_EDIT;
    detected("blue jersey");
    const preview = await post(
      "/studio/preview",
      editReq(await seedFrame(), "make her jersey blue and remove the ball"),
    );

    expect(preview.json.status).toBe("blocked");
    expect(preview.json.verdict.reason).toBe(
      freezeRefusalNote({ ok: false, reason: "compound_off_native" }),
    );
    expect(
      "editIntent" in (await storedBrief(preview.json.previewId)).job,
    ).toBe(false);

    const spend = await post("/studio/generate", {
      previewId: preview.json.previewId,
    });
    expect(spend.status).toBe(409);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("detection reads only the clauses that name a thing in the frame (composition, decision 3)", () => {
  /** Every instruction detection was asked about, in order. */
  const detectedFrom = () =>
    (detectRegionsMemoized as jest.Mock).mock.calls.map(
      (c) => c[0].instruction,
    );

  it("sends a lone sentence exactly as it came — nothing moves for what composition does not compose", async () => {
    detected("black and green shorts");
    await post("/studio/preview", editReq(await seedFrame(), SENTENCE));
    expect(detectedFrom()).toEqual([SENTENCE]);
  });

  it("sends B-c1's recolour clause alone, and freezes both changes — ready to quote", async () => {
    // Given the whole sentence, detection's background arm answers with the frame and nothing else,
    // and the jersey has no label to pair its colour from.
    detected("blue jersey");
    const { json } = await post(
      "/studio/preview",
      editReq(
        await seedFrame(),
        "make her jersey blue and change the background to a stadium",
      ),
    );
    expect(detectedFrom()).toEqual(["make her jersey blue"]);
    expect(json.status).toBe("ready");
    expect((await storedBrief(json.previewId)).job.editIntent.changes).toEqual([
      { op: "RECOLOR", target: "jersey", change: "blue" },
      { op: "CHANGE_BACKGROUND", target: null, change: "stadium" },
    ]);
  });

  it("sends B-c11's recolour clause alone — the add's place never reaches detection's person rule", async () => {
    detected("blue jersey");
    const { json } = await post(
      "/studio/preview",
      editReq(
        await seedFrame(),
        "make her jersey blue, add a soccer ball at her feet, and change the background to a stadium",
      ),
    );
    expect(detectedFrom()).toEqual(["make her jersey blue"]);
    expect(json.status).toBe("ready");
    expect(
      (await storedBrief(json.previewId)).job.editIntent.changes.map(
        (c: { op: string }) => c.op,
      ),
    ).toEqual(["RECOLOR", "ADD_OBJECT", "CHANGE_BACKGROUND"]);
  });

  it("asks detection NOTHING for an add beside a background — measured, ready, and spent as one call", async () => {
    const ASK =
      "add a soccer ball at her feet and change the background to a packed stadium at night";
    const preview = await post(
      "/studio/preview",
      editReq(await seedFrame(), ASK),
    );
    expect(detectRegionsMemoized).not.toHaveBeenCalled();
    // Ready: the no-regions gap is answered by the intent, which needs no region (preview.ts).
    expect(preview.json.status).toBe("ready");
    const brief = await storedBrief(preview.json.previewId);
    expect(brief.job.source).toMatchObject({
      width: 4000,
      height: 6000,
      editRegions: [],
    });
    expect(
      brief.job.editIntent.changes.map((c: { op: string }) => c.op),
    ).toEqual(["ADD_OBJECT", "CHANGE_BACKGROUND"]);

    const spend = await post("/studio/generate", {
      previewId: preview.json.previewId,
    });
    expect(spend.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
    const [, inputs] = (generate as jest.Mock).mock.calls[0];
    expect(inputs.aspectRatio).toBe("2:3");
    expect(
      inputs.prompt.startsWith(
        "add a soccer ball, place it at the person's feet, and change the background to packed stadium at night.",
      ),
    ).toBe(true);
  });
});

describe("the G3 sentence — the one that ASKed live on 2026-09-09 — through the preview (C.2)", () => {
  it("is ready, detects nothing, and freezes her place in her words", async () => {
    const { json } = await post(
      "/studio/preview",
      editReq(
        await seedFrame(),
        "add a soccer ball to the image, place it in the middle of my cleats",
      ),
    );

    expect(json.status).toBe("ready");
    expect(detectRegionsMemoized).not.toHaveBeenCalled();
    expect(
      (await storedBrief(json.previewId)).job.editIntent.changes[0].add,
    ).toEqual({
      thing: "soccer ball",
      place: "in the middle of my cleats",
      objectAssetId: null,
    });
  });
});

describe("C.3 — her photo, and the photo of the thing, through both doors", () => {
  const ASK =
    "add the soccer ball from the second image, place it between her cleats";

  /** A synthetic square product shot, like Q1's 700x700 ball — owned by her, stored. */
  async function seedObject(): Promise<string> {
    const path = `athletes/${athleteId}/uploads/ball-${Math.random().toString(36).slice(2)}.png`;
    const [row] = await db
      .insert(mediaAssets)
      .values({
        athlete_id: athleteId,
        platform: "studio",
        origin: "upload",
        media_type: "IMAGE",
        status: "stored",
        gcs_path: path,
      } as any)
      .returning({ id: mediaAssets.id });
    FRAMES.set(path, { width: 700, height: 700 });
    return row.id;
  }

  it("freezes the ball's asset id, and the spend sends frame then ball with the instruction pointing at Image 2", async () => {
    const ball = await seedObject();
    const preview = await post("/studio/preview", {
      ...editReq(await seedFrame(), ASK),
      references: [{ assetId: ball, role: "object", label: "the ball" }],
    });
    expect(preview.json.status).toBe("ready");
    expect(
      (await storedBrief(preview.json.previewId)).job.editIntent.changes[0].add
        .objectAssetId,
    ).toBe(ball);
    // Hers is attached, so nothing is invented and nothing says it will be.
    expect(preview.json.warnings.map((w: any) => w.field)).not.toContain(
      "job.references",
    );

    const spend = await post("/studio/generate", {
      previewId: preview.json.previewId,
    });
    expect(spend.status).toBe(200);
    const [, inputs] = (generate as jest.Mock).mock.calls[0];
    expect(inputs.references.map((r: any) => r.slot)).toEqual([
      "frame",
      "object",
    ]);
    expect(inputs.prompt).toContain(
      "add the soccer ball from Image 2, place it between the person's cleats.",
    );
    // THE FRAME'S RATIO, with a square object attached — Q1's squaring bug does not come back.
    expect(inputs.aspectRatio).toBe("2:3");
  });

  it("BLOCKS two object photos, and that preview can never be spent", async () => {
    const preview = await post("/studio/preview", {
      ...editReq(await seedFrame(), ASK),
      references: [
        { assetId: await seedObject(), role: "object" },
        { assetId: await seedObject(), role: "object" },
      ],
    });
    expect(preview.json.status).toBe("blocked");
    expect(preview.json.verdict.reason).toMatch(/More than one object photo/);

    const spend = await post("/studio/generate", {
      previewId: preview.json.previewId,
    });
    expect(spend.status).toBe(409);
    expect(generate).not.toHaveBeenCalled();
  });
});

// ─── G.2 (guard scope) — the masked floor does not refuse a job that is never cropped ────────────

describe("a detected region too small to CROP still runs native — the 8px floor is the masked path's (G.2)", () => {
  // An earring on N.1's 4000x6000 frame: 0.0015 of 4000 is 6px wide, under MIN_REGION_PX (8). Mia's
  // "swap my earrings…" rephrase was refused here as "too small" on a job that could only run native.
  const EARRING = { left: 0.52, top: 0.18, width: 0.0015, height: 0.003 };
  const ASK = "make my earrings gold";
  const tinyDetected = () =>
    (detectRegionsMemoized as jest.Mock).mockResolvedValue({
      ok: true,
      regions: [{ label: "gold earrings", ...EARRING }],
    });

  it("freezes and quotes it with the flag on, and the spend is ONE full-frame call", async () => {
    tinyDetected();
    const preview = await post(
      "/studio/preview",
      editReq(await seedFrame(), ASK),
    );
    expect(preview.status).toBe(200);
    expect(preview.json.status).toBe("ready");
    expect(
      (await storedBrief(preview.json.previewId)).job.editIntent.changes,
    ).toEqual([{ op: "RECOLOR", target: "earrings", change: "gold" }]);

    const spend = await post("/studio/generate", {
      previewId: preview.json.previewId,
    });
    expect(spend.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
    expect((generate as jest.Mock).mock.calls[0][1].aspectRatio).toBe("2:3");
  });

  it("refuses it with the flag OFF — the region would be cropped, and the masked floor is right there", async () => {
    delete process.env.STUDIO_NATIVE_EDIT;
    tinyDetected();
    const { status, json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), ASK),
    );
    expect(status).toBe(400);
    expect(json.error).toMatch(
      /too small to edit — draw a box at least 8 pixels/,
    );
  });

  it("refuses a box she DREW that small with the flag on — a drawn box routes masked, permanently", async () => {
    const { status, json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), ASK, [{ label: "gold earrings", ...EARRING }]),
    );
    expect(status).toBe(400);
    expect(json.error).toMatch(
      /too small to edit — draw a box at least 8 pixels/,
    );
    expect(detectRegionsMemoized).not.toHaveBeenCalled();
  });
});

// ─── Replace with reference: her Object photo, frozen at the quote and counted again at the spend ───

const FOUNDER = "change my earrings to these gold hoops";

/**
 * Her Object photo, in HER library — resolveReferences re-reads it under her athlete id. A SQUARE
 * product shot, like C.3's ball: the canvas must still be the frame's 2:3 (Q1's squaring bug).
 */
async function seedHoopsPhoto(): Promise<string> {
  const path = `athletes/${athleteId}/uploads/hoops-${Math.random().toString(36).slice(2)}.png`;
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: athleteId,
      platform: "studio",
      origin: "upload",
      media_type: "IMAGE",
      status: "stored",
      gcs_path: path,
    } as any)
    .returning({ id: mediaAssets.id });
  FRAMES.set(path, { width: 700, height: 700 });
  return row.id;
}

/** Her sentence on her frame, with her photo in the Object tile. */
const withObject = (
  sourceAssetId: string,
  objectId: string,
  direction = FOUNDER,
) => ({
  ...editReq(sourceAssetId, direction),
  references: [{ assetId: objectId, role: "object", label: "the hoops" }],
});

/** The SAME request with the hoops in the PRODUCT tile — the shape the client actually sends (card 4). */
const withProduct = (
  sourceAssetId: string,
  productId: string,
  direction = FOUNDER,
) => ({
  ...editReq(sourceAssetId, direction),
  references: [{ assetId: productId, role: "product", label: "the hoops" }],
});

describe("card 4 THROUGH THE HTTP PATH — a pointed replacement reads the Product tile", () => {
  // ⚠️ THIS IS THE PIN THAT WAS MISSING, AND ITS ABSENCE IS WHY CARD 4 SHIPPED BROKEN.
  //
  // Card 4's first proof was a constructed call straight into `freezeEditIntent` with a hand-built
  // references array. That skipped `attachedIn`, which is what the ROUTE counts with — and which
  // filtered `role === "object"` just like the two gates inside the freeze did. So the freeze was
  // fixed, the entry was not, and a live Product-tile replacement asked and then fell back to a
  // GENERATE ("1 of 1 frames invented") with only the PRODUCT in BUILT FROM.
  //
  // Same bypass class as pinning `route()` alone: a fix proved below the entry point is not proved.
  it("plans the REPLACE and lists both photos — not a generate, and not an ask", async () => {
    detected("gold hoop earrings");
    const { json } = await post(
      "/studio/preview",
      withProduct(await seedFrame(), await seedHoopsPhoto()),
    );
    expect(json.status).toBe("ready");
    // The frame is still the frame: a Product tile must not turn an edit into a new image.
    expect(json.references.map((r: any) => [r.slot, r.role])).toEqual([
      ["frame", "source-frame"],
      ["object", "product"],
    ]);
    expect(json.plan.inputs.prompt).toMatch(/replace the earrings with/);
    // Bound to HER product, and said before she pays.
    expect(JSON.stringify(json.warnings)).toMatch(/Product photo/);
    expect(JSON.stringify(json.warnings)).not.toMatch(/invent/);
  });

  it("still asks when NEITHER tile has a photo", async () => {
    detected("gold hoop earrings");
    const { json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), FOUNDER),
    );
    expect(json.status).toBe("blocked");
  });
});

describe("replace with reference, R.1 — the preview freezes her photo, and the spend re-checks WITH it", () => {
  it("freezes her photo onto the replacement, and the spend sends it as Image 2 — the re-check counted it too", async () => {
    detected("gold hoop earrings");
    const objectId = await seedHoopsPhoto();
    const preview = await post(
      "/studio/preview",
      withObject(await seedFrame(), objectId),
    );
    expect({ status: preview.status, verdict: preview.json.status }).toEqual({
      status: 200,
      verdict: "ready",
    });
    const intent = (await storedBrief(preview.json.previewId)).job.editIntent;
    expect(intent.changes).toEqual([
      {
        op: "REPLACE_OBJECT",
        target: "earrings",
        change: "gold hoops",
        object: { objectAssetId: objectId },
      },
    ]);
    expect(intent.steps[0].reference).toBe("object");

    // The re-check classifies the frozen brief's statement WITH the brief's own Object photos. Counted
    // as none, it would ask for the photo and refuse this spend as "something changed".
    const spend = await post("/studio/generate", {
      previewId: preview.json.previewId,
    });
    expect({ status: spend.status, error: spend.json.error }).toEqual({
      status: 200,
      error: undefined,
    });
    const [, inputs] = (generate as jest.Mock).mock.calls[0];
    expect(inputs.references.map((r: any) => r.slot)).toEqual([
      "frame",
      "object",
    ]);
    expect(inputs.aspectRatio).toBe("2:3");
    expect(inputs.prompt).toMatch(
      /replace the earrings with the gold hoops from Image 2\./,
    );
  });

  it("spends with STUDIO_SERVER_ROUTING on too — the refusal re-check counts the brief's photos", async () => {
    process.env.STUDIO_SERVER_ROUTING = "true";
    detected("gold hoop earrings");
    const preview = await post(
      "/studio/preview",
      withObject(await seedFrame(), await seedHoopsPhoto()),
    );
    const spend = await post("/studio/generate", {
      previewId: preview.json.previewId,
    });
    expect({ status: spend.status, error: spend.json.error }).toEqual({
      status: 200,
      error: undefined,
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe("replace with reference, R.3 — the preview tells the truth: built from her photo, or asked for it", () => {
  const TEACHING =
    'Attach a photo of the thing you want with the Product or Object tile — or describe it instead, like "make my earrings gold".';

  it("lists her Object photo among what it is built from, points the prompt at it, and warns of nothing invented", async () => {
    detected("gold hoop earrings");
    const { json } = await post(
      "/studio/preview",
      withObject(await seedFrame(), await seedHoopsPhoto()),
    );
    expect(json.status).toBe("ready");
    // What it is BUILT FROM, as the server plans it — the same list the manifest numbers, which the
    // screen's strip walks (use-studio-pending, builtFromOf). An OBJECT, like an add's.
    expect(json.references.map((r: any) => [r.slot, r.role, r.label])).toEqual([
      ["frame", "source-frame", "the frame to preserve"],
      ["object", "object", "the hoops"],
    ]);
    expect(json.plan.inputs.references).toBe(2);
    expect(json.plan.inputs.prompt).toMatch(
      /replace the earrings with the gold hoops from Image 2\./,
    );
    // Her photo IS the thing, so nothing is invented — and nothing says so.
    expect(JSON.stringify(json.warnings)).not.toMatch(/invent/);
  });

  it("ASKS with no photo — the teaching line blocks, and there is no 'the edit will invent one' warning", async () => {
    detected("gold hoop earrings");
    const { json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), FOUNDER),
    );
    expect(json.status).toBe("blocked");
    expect(json.blockers).toContainEqual({
      field: "job.direction",
      note: TEACHING,
      severity: "blocking",
    });
    expect(JSON.stringify(json.warnings)).not.toMatch(/invent/);
    expect("editIntent" in (await storedBrief(json.previewId)).job).toBe(false);
    // A blocked check never spends.
    const spend = await post("/studio/generate", { previewId: json.previewId });
    expect(spend.status).toBe(409);
    expect(generate).not.toHaveBeenCalled();
  });

  it("— where an ADD with no photo routes, and says it will invent one: the difference, pinned both ways", async () => {
    const { json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), "put a water bottle on the grass"),
    );
    expect(json.status).toBe("ready");
    expect(json.warnings).toContainEqual(
      expect.objectContaining({
        field: "job.references",
        severity: "degraded",
        note: expect.stringMatching(/so the edit will invent one/),
      }),
    );
  });
});

// ─── The founder's sentence, through the live detection path (guard scope) ───────────────────────

describe("'change the earrings in my ears to gold' previews clean — detection's own person check, run for real", () => {
  // Acceptance on b7bb420: route() claimed RECOLOR [earrings], and the preview still answered "We don't
  // edit people in photos" — auto-mask detection complete, refusal person_target, samNoun absent. The
  // model had copied her words into `target`. Every mock above detection is lifted here: the memo, the
  // call and parseDetections run as they do live, and only the model's reply and the probe's bytes are
  // stood in for — the reply being the one measured on the Gorjana frame, verbatim.
  const ASK = "change the earrings in my ears to gold";
  const reply = (entry: Record<string, unknown>) =>
    (genai as jest.Mock).mockReturnValue({
      models: {
        generateContent: jest.fn().mockResolvedValue({
          text: JSON.stringify([
            {
              box_2d: [578, 555, 612, 575],
              scope: "object",
              directive: "gold earrings",
              label: "earring",
              ...entry,
            },
          ]),
        }),
      },
    });

  beforeEach(() => {
    const actual = jest.requireActual("../studio/autoMask");
    actual.__clearAutoMaskMemo();
    (detectRegionsMemoized as jest.Mock).mockImplementation(
      actual.detectRegionsMemoized,
    );
    (probeBytesFor as jest.Mock).mockResolvedValue({
      bytes: Buffer.from("probe"),
      mimeType: "image/jpeg",
    });
  });

  afterEach(() => {
    (genai as jest.Mock).mockImplementation(() => ({}));
  });

  it("is READY and frozen on the model's own reply — the one that copied her location into the target", async () => {
    reply({ target: "the earrings in my ears" });
    const { status, json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), ASK),
    );
    expect({ status, error: json.error }).toEqual({
      status: 200,
      error: undefined,
    });
    expect(json.status).toBe("ready");
    expect((await storedBrief(json.previewId)).job.editIntent.changes).toEqual([
      { op: "RECOLOR", target: "earrings", change: "gold" },
    ]);
  });

  it("still refuses with the person line when the model's target LEADS with her — 'ears'", async () => {
    reply({ target: "ears" });
    const { status, json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), ASK),
    );
    expect(status).toBe(400);
    expect(json.error).toMatch(/We don't edit people in photos/);
  });

  it("still refuses when the samNoun names her, whatever the target says", async () => {
    reply({ target: "the earrings in my ears", samNoun: "ear" });
    const { status, json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), ASK),
    );
    expect(status).toBe(400);
    expect(json.error).toMatch(/We don't edit people in photos/);
  });
});

// ─── R.4 (replace with reference) — the pointed sentence, through the live detection path ─────────

describe("'change the earrings in my ears to these gold hoops' previews READY with her photo — detection's own person check, run for real (R.4)", () => {
  // Measured 2026-09-11, before this pin was written: two flash calls, the real detection prompt, the
  // Gorjana frame #405 measured on. The model copied her words into `target` again ("the earrings in my
  // ears") and wrote her pointer into the directive. This is that reply, verbatim; only the model's
  // reply and the probe's bytes are stood in for — the memo, the call and parseDetections run as live.
  const R4 = "change the earrings in my ears to these gold hoops";
  const MEASURED = {
    box_2d: [578, 556, 612, 575],
    scope: "object",
    target: "the earrings in my ears",
    directive: "these gold hoops",
    label: "earring",
  };
  const reply = (entry: Record<string, unknown>) =>
    (genai as jest.Mock).mockReturnValue({
      models: {
        generateContent: jest.fn().mockResolvedValue({
          text: JSON.stringify([{ ...MEASURED, ...entry }]),
        }),
      },
    });

  beforeEach(() => {
    const actual = jest.requireActual("../studio/autoMask");
    actual.__clearAutoMaskMemo();
    (detectRegionsMemoized as jest.Mock).mockImplementation(
      actual.detectRegionsMemoized,
    );
    (probeBytesFor as jest.Mock).mockResolvedValue({
      bytes: Buffer.from("probe"),
      mimeType: "image/jpeg",
    });
  });

  afterEach(() => {
    (genai as jest.Mock).mockImplementation(() => ({}));
  });

  it("is READY and frozen as a replacement from her photo, on the model's own measured reply", async () => {
    reply({});
    const objectId = await seedHoopsPhoto();
    const { status, json } = await post(
      "/studio/preview",
      withObject(await seedFrame(), objectId, R4),
    );
    expect({ status, error: json.error }).toEqual({
      status: 200,
      error: undefined,
    });
    expect(json.status).toBe("ready");
    expect((await storedBrief(json.previewId)).job.editIntent.changes).toEqual([
      {
        op: "REPLACE_OBJECT",
        target: "earrings",
        change: "gold hoops",
        object: { objectAssetId: objectId },
      },
    ]);
    expect(json.plan.inputs.prompt).toMatch(
      /replace the earrings with the gold hoops from Image 2\./,
    );
  });

  it("still refuses with the person line when the model's target LEADS with her — 'ears'", async () => {
    reply({ target: "ears" });
    const { status, json } = await post(
      "/studio/preview",
      withObject(await seedFrame(), await seedHoopsPhoto(), R4),
    );
    expect(status).toBe(400);
    expect(json.error).toMatch(/We don't edit people in photos/);
  });

  it("still refuses when the samNoun names her, whatever the target says", async () => {
    reply({ samNoun: "ear" });
    const { status, json } = await post(
      "/studio/preview",
      withObject(await seedFrame(), await seedHoopsPhoto(), R4),
    );
    expect(status).toBe(400);
    expect(json.error).toMatch(/We don't edit people in photos/);
  });
});

// ─── PR M3 — founder sentence 3, through the live preview path ────────────────────────────────────

describe("PR M3 — 'add these gold hoops to my ears' with her hoops photo: ready, never detected, and the prompt is its golden", () => {
  const M3 = "add these gold hoops to my ears";
  const GOLDEN = JSON.parse(
    readFileSync(
      join(__dirname, "..", "studio", "compile", "compile.golden.json"),
      "utf8",
    ),
  );
  const WITH_PHOTO: string[] =
    GOLDEN["worn add — founder sentence 3, her hoops photo attached"].prompt;
  let generateContent: jest.Mock;

  beforeEach(() => {
    // Detection is lifted to the real thing, as the live-path tests above lift it: if the route asked it
    // anything, the memo would call the model, and the model's only door here is this spy.
    const actual = jest.requireActual("../studio/autoMask");
    actual.__clearAutoMaskMemo();
    (detectRegionsMemoized as jest.Mock).mockImplementation(
      actual.detectRegionsMemoized,
    );
    (probeBytesFor as jest.Mock).mockResolvedValue({
      bytes: Buffer.from("probe"),
      mimeType: "image/jpeg",
    });
    generateContent = jest.fn().mockResolvedValue({ text: "[]" });
    (genai as jest.Mock).mockReturnValue({ models: { generateContent } });
  });

  afterEach(() => {
    (genai as jest.Mock).mockImplementation(() => ({}));
  });

  it("is READY, frozen as an add of the hoops from her photo, and detection is called ZERO times", async () => {
    const objectId = await seedHoopsPhoto();
    const { status, json } = await post(
      "/studio/preview",
      withObject(await seedFrame(), objectId, M3),
    );
    expect({ status, error: json.error, verdict: json.status }).toEqual({
      status: 200,
      error: undefined,
      verdict: "ready",
    });
    // A routed add is region-free: the hoops are not in the frame to be found, and her ears are where
    // they are worn, not a region. Nothing is asked of detection, and nothing is paid for it.
    expect(detectRegionsMemoized).toHaveBeenCalledTimes(0);
    expect(generateContent).toHaveBeenCalledTimes(0);
    expect(json.derivedRegions).toBeUndefined();
    expect((await storedBrief(json.previewId)).job.editIntent.changes).toEqual([
      {
        op: "ADD_OBJECT",
        target: null,
        change: null,
        add: {
          thing: "gold hoops",
          place: "to my ears",
          objectAssetId: objectId,
        },
      },
    ]);
    // What she is quoted is the golden, byte for byte — the manifest, then "worn in the person's ears".
    expect(json.plan.inputs.prompt).toBe(WITH_PHOTO.join("\n"));
    // Her photo is the thing, so nothing is invented, and nothing says it will be.
    expect(JSON.stringify(json.warnings)).not.toMatch(/invent/);
  });

  it("spends ONE call — frame, then her hoops, the frame's ratio and the golden's prompt; the re-check reproduced it", async () => {
    const preview = await post(
      "/studio/preview",
      withObject(await seedFrame(), await seedHoopsPhoto(), M3),
    );
    const spend = await post("/studio/generate", {
      previewId: preview.json.previewId,
    });
    expect({ status: spend.status, error: spend.json.error }).toEqual({
      status: 200,
      error: undefined,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    const [task, inputs] = (generate as jest.Mock).mock.calls[0];
    expect(task).toBe("image.edit");
    expect(inputs.references.map((r: any) => r.slot)).toEqual([
      "frame",
      "object",
    ]);
    expect(inputs.aspectRatio).toBe("2:3");
    expect(inputs.prompt).toBe(WITH_PHOTO.join("\n"));
    expect(detectRegionsMemoized).toHaveBeenCalledTimes(0);
  });

  it("with NO photo, is ready too — and says the hoops will be invented", async () => {
    const { json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), M3),
    );
    expect(json.status).toBe("ready");
    expect(detectRegionsMemoized).toHaveBeenCalledTimes(0);
    expect(json.plan.inputs.prompt).toBe(
      GOLDEN[
        "worn add — founder sentence 3, NO photo: the hoops invented, and disclosed"
      ].prompt.join("\n"),
    );
    expect(json.warnings).toContainEqual(
      expect.objectContaining({
        field: "job.references",
        severity: "degraded",
        note: expect.stringMatching(/No photo of the gold hoops is attached/),
      }),
    );
  });
});

describe("PR M3 — the free acceptance cells, through the preview (Adi drives them live)", () => {
  const PERSON_NOTE = /doesn't change a person's face or body/;

  it("'put an adidas cap on my head' is READY — a cap, never a design on her head — and detects nothing", async () => {
    const { json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), "put an adidas cap on my head"),
    );
    expect(json.status).toBe("ready");
    expect(detectRegionsMemoized).not.toHaveBeenCalled();
    expect(
      (await storedBrief(json.previewId)).job.editIntent.changes[0].add,
    ).toEqual({
      thing: "adidas cap",
      place: "on my head",
      objectAssetId: null,
    });
    expect(json.plan.inputs.prompt).toMatch(
      /^add an adidas cap, worn on the person's head\./,
    );
  });

  it("a tattoo, placed or not, muscles, and a lip ring or eyebrow stud all BLOCK with the person note — never 'say where'", async () => {
    // The piercings here were a ring and a stud in her nose until M3.9 opened the nose (the next block).
    for (const sentence of [
      "add a tattoo on my arm",
      "add a tattoo",
      "add muscles",
      "add a ring to my lip",
      "put a stud through my eyebrow",
    ]) {
      // Each asks, so detection is asked about it as every ask is; the freeze then refuses it.
      detected("thing");
      const { status, json } = await post(
        "/studio/preview",
        editReq(await seedFrame(), sentence),
      );
      expect({ sentence, status, verdict: json.status }).toEqual({
        sentence,
        status: 200,
        verdict: "blocked",
      });
      expect({ sentence, note: json.verdict.reason }).toEqual({
        sentence,
        note: expect.stringMatching(PERSON_NOTE),
      });
      expect("editIntent" in (await storedBrief(json.previewId)).job).toBe(
        false,
      );
    }
  });
});

// ─── PR M3.9 — pierced jewelry in her nose, through the live preview path (Mia opened it) ──────────

describe("PR M3.9 — 'add a ring to my nose' with her ring photo, on a square frame: ready, never detected, spent at 1:1", () => {
  const NOSE = "add a ring to my nose";

  /** A SQUARE upload — the paid acceptance cell's shape: a small target (her nose) on a 1:1 frame. */
  async function seedSquareFrame(): Promise<string> {
    const path = `athletes/${athleteId}/uploads/square-${Math.random().toString(36).slice(2)}.jpg`;
    const [row] = await db
      .insert(mediaAssets)
      .values({
        athlete_id: athleteId,
        platform: "studio",
        origin: "upload",
        media_type: "IMAGE",
        status: "stored",
        gcs_path: path,
      } as any)
      .returning({ id: mediaAssets.id });
    FRAMES.set(path, { width: 3000, height: 3000 });
    return row.id;
  }

  it("is READY and frozen as an add of the ring from her photo — detection is called ZERO times", async () => {
    const ringId = await seedHoopsPhoto();
    const { status, json } = await post("/studio/preview", {
      ...editReq(await seedSquareFrame(), NOSE),
      references: [{ assetId: ringId, role: "object", label: "the ring" }],
    });
    expect({ status, error: json.error, verdict: json.status }).toEqual({
      status: 200,
      error: undefined,
      verdict: "ready",
    });
    expect(detectRegionsMemoized).not.toHaveBeenCalled();
    expect(
      (await storedBrief(json.previewId)).job.editIntent.changes[0].add,
    ).toEqual({ thing: "ring", place: "to my nose", objectAssetId: ringId });
    expect(json.plan.inputs.prompt).toContain(
      "add the ring from Image 2, worn in the person's nose.",
    );
    expect(JSON.stringify(json.warnings)).not.toMatch(/invent/);

    // A square frame of 9 MP buys 4K, and the model returns it square — the default stand-in above is
    // N.1's 2:3 return, which the output shape guard would rightly refuse for a 1:1 request.
    (generate as jest.Mock).mockResolvedValueOnce({
      task: "image.edit",
      provider: "vertex",
      model: "gemini-3-pro-image",
      assets: [{ mimeType: "image/png", bytes: pngBytes(4096, 4096) }],
      cost: { amountUsd: 0.24, currency: "USD", basis: "estimated" },
      timings: {
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        ms: 10,
      },
      raw: {},
    });
    const spend = await post("/studio/generate", {
      previewId: json.previewId,
    });
    expect({ status: spend.status, error: spend.json.error }).toEqual({
      status: 200,
      error: undefined,
    });
    const [, inputs] = (generate as jest.Mock).mock.calls[0];
    expect(inputs.references.map((r: any) => r.slot)).toEqual([
      "frame",
      "object",
    ]);
    // The frame's own ratio: 1:1, whatever shape her ring photo is.
    expect(inputs.aspectRatio).toBe("1:1");
    expect(detectRegionsMemoized).not.toHaveBeenCalled();
  });
});

// ─── PR T — a headline through the live preview and spend (Adi previews the acceptance cell) ───────

describe("PR T — 'add the headline \"OWN THE MOMENT\" across the top': ready and never detected with the switch on, asks with it off", () => {
  const HEADLINE = 'add the headline "OWN THE MOMENT" across the top';
  /** q6-t1's banner with her words, the scope sentence, and every property kept — written out. */
  const PROMPT =
    "add a large banner across the top of the background that reads OWN THE MOMENT in bold white " +
    "capital letters. Keep everything else exactly as-is — only add the banner. Keep the original " +
    "photograph's lighting, exposure, contrast, colour grade and scene exactly as they are.";

  afterEach(() => {
    delete process.env.STUDIO_DISPLAY_TEXT;
  });

  it("is READY with the switch on, frozen as ONE headline — detection is called ZERO times", async () => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
    const { status, json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), HEADLINE),
    );
    expect({ status, error: json.error, verdict: json.status }).toEqual({
      status: 200,
      error: undefined,
      verdict: "ready",
    });
    // The op names no region, so nothing is asked of detection and nothing is paid for it.
    expect(detectRegionsMemoized).not.toHaveBeenCalled();
    expect(json.derivedRegions).toBeUndefined();
    expect((await storedBrief(json.previewId)).job.editIntent.changes).toEqual([
      { op: "DISPLAY_TEXT", target: null, change: "OWN THE MOMENT" },
    ]);
    expect(json.plan.inputs.prompt).toBe(PROMPT);
    expect(JSON.stringify(json.warnings)).not.toMatch(
      /invent|can't be matched/,
    );
  });

  it("spends ONE call — the frame alone, its ratio, the frozen prompt — and the re-check reproduced it", async () => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
    const preview = await post(
      "/studio/preview",
      editReq(await seedFrame(), HEADLINE),
    );
    const spend = await post("/studio/generate", {
      previewId: preview.json.previewId,
    });
    expect({ status: spend.status, error: spend.json.error }).toEqual({
      status: 200,
      error: undefined,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    const [task, inputs] = (generate as jest.Mock).mock.calls[0];
    expect(task).toBe("image.edit");
    expect(inputs.references.map((r: any) => r.slot)).toEqual(["frame"]);
    expect(inputs.aspectRatio).toBe("2:3");
    expect(inputs.prompt).toBe(PROMPT);
    expect(detectRegionsMemoized).not.toHaveBeenCalled();
  });

  it("with the switch OFF, asks exactly as main does — blocked, nothing frozen, the rephrase note", async () => {
    // An ask goes to detection as every ask does; the freeze then refuses it with the classifier's code.
    detected("thing");
    const { status, json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), HEADLINE),
    );
    expect({ status, verdict: json.status }).toEqual({
      status: 200,
      verdict: "blocked",
    });
    expect(json.verdict.reason).toBe(
      freezeRefusalNote({
        ok: false,
        reason: "not_routed",
        askReason: "add_unclear",
      }),
    );
    expect("editIntent" in (await storedBrief(json.previewId)).job).toBe(false);
  });

  it("refuses at spend when it was quoted ON and spent OFF — the re-check asks, nothing falls back, nothing is spent", async () => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
    const preview = await post(
      "/studio/preview",
      editReq(await seedFrame(), HEADLINE),
    );
    expect(preview.json.status).toBe("ready");
    delete process.env.STUDIO_DISPLAY_TEXT;
    const spend = await post("/studio/generate", {
      previewId: preview.json.previewId,
    });
    expect(spend.status).toBe(409);
    expect(spend.json.error).toBe(NATIVE_INTENT_CHANGED);
    expect(generate).not.toHaveBeenCalled();
    expect(await db.select().from(generationJobs)).toHaveLength(0);
  });

  it("a natural banner phrasing still asks with the switch on — #433's sentence is the interpreter's, never this rule's", async () => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
    detected("thing");
    const { json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), "add a banner that says GET LOUD"),
    );
    expect(json.status).toBe("blocked");
    expect("editIntent" in (await storedBrief(json.previewId)).job).toBe(false);
  });
});

describe("PR T, T.5 — what the preview quotes for a headline is its golden, byte for byte", () => {
  const GOLDEN = JSON.parse(
    readFileSync(
      join(__dirname, "..", "studio", "compile", "compile.golden.json"),
      "utf8",
    ),
  );

  afterEach(() => {
    delete process.env.STUDIO_DISPLAY_TEXT;
  });

  it("quotes the 'headline — alone' golden's prompt, and the hand-built op golden is the same string", async () => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
    const { json } = await post(
      "/studio/preview",
      editReq(
        await seedFrame(),
        'add the headline "OWN THE MOMENT" across the top',
      ),
    );
    expect(json.status).toBe("ready");
    const alone: string[] =
      GOLDEN[
        "headline — alone, in her words: q6-t1's banner, only the banner added"
      ].prompt;
    expect(json.plan.inputs.prompt).toBe(alone.join("\n"));
    expect(
      GOLDEN["op DISPLAY_TEXT — q6-t1's banner, her words where GET LOUD was"]
        .prompt,
    ).toEqual(alone);
    expect(detectRegionsMemoized).not.toHaveBeenCalled();
  });
});

describe("PR T, T.6 — a headline with a box she DREW blocks, and that preview can never be spent", () => {
  const HEADLINE = 'add the headline "OWN THE MOMENT" across the top';
  /** The drawn box the masked-path test above uses — main's quote for it is 0.1654. */
  const drawn = [
    {
      label: "black and green shorts",
      left: 0.41,
      top: 0.59,
      width: 0.147,
      height: 0.097,
    },
  ];

  afterEach(() => {
    delete process.env.STUDIO_DISPLAY_TEXT;
  });

  it("BLOCKS with its own note, freezes nothing, asks detection nothing — and the spend refuses", async () => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
    const preview = await post(
      "/studio/preview",
      editReq(await seedFrame(), HEADLINE, drawn),
    );
    expect({ status: preview.status, verdict: preview.json.status }).toEqual({
      status: 200,
      verdict: "blocked",
    });
    expect(preview.json.verdict.reason).toBe(
      freezeRefusalNote({ ok: false, reason: "text_off_native" }),
    );
    expect(detectRegionsMemoized).not.toHaveBeenCalled();
    expect(
      "editIntent" in (await storedBrief(preview.json.previewId)).job,
    ).toBe(false);

    const spend = await post("/studio/generate", {
      previewId: preview.json.previewId,
    });
    expect(spend.status).toBe(409);
    expect(generate).not.toHaveBeenCalled();
    expect(await db.select().from(generationJobs)).toHaveLength(0);
  });

  it("with the switch OFF, the same box takes main's masked arm untouched — main's quote for a drawn box", async () => {
    const { json } = await post(
      "/studio/preview",
      editReq(await seedFrame(), HEADLINE, drawn),
    );
    expect(detectRegionsMemoized).not.toHaveBeenCalled();
    expect("editIntent" in (await storedBrief(json.previewId)).job).toBe(false);
    expect(json.cost.amountUsd).toBe(0.1654);
    expect(JSON.stringify(json)).not.toContain(
      freezeRefusalNote({ ok: false, reason: "text_off_native" }),
    );
  });
});
