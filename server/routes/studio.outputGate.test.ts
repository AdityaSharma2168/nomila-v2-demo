/**
 * studio.outputGate.test.ts — the output gate at the doors (quality-scrappy piece 5, ADI-QS-GO), through the real
 * router: a re-quote's `corrective` codes reach the brief and the prompt only under STUDIO_OUTPUT_GATE (opt-in), text
 * is refused, and GET /studio/jobs/:jobId says a failed output failed — or is still being checked — instead of
 * presenting it as done. Flag off, both doors are the wire they were.
 *
 * Harness: studio.generate.test.ts's (real router, PGlite, the billable door and storage stubbed).
 *
 * ⚠️ MUTATIONS (docs/probes/quality-scrappy.md):
 *   M5e — the route applies `corrective` with the flag off: "flag off: corrective is dropped" reds.
 *   M5f — the job read skips the gate: "a failed clip reads as failed" reds.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.athleteId = (globalThis as any).__TEST_ATHLETE_ID;
    next();
  },
}));
jest.mock("../studio/router", () => {
  const actual = jest.requireActual("../studio/router");
  return { ...actual, generate: jest.fn() };
});
jest.mock("../studio/videoRunner", () => ({
  videoTick: jest.fn(async () => ({})),
}));
jest.mock("../lib/mediaStore", () => ({
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
  saveBuffer: jest.fn(async (_b: unknown, base: string) => ({
    gcs_path: `${base}.png`,
    content_type: "image/png",
    bytes: 1234,
  })),
  rehostFromUrl: jest.fn(),
}));
// The inspection is a model call; stood in by one that records what the text check would: a name she didn't ask for.
jest.mock("../studio/qa/inspect", () => ({
  inspectAsset: jest.fn(async (assetId: string) => {
    const { db } = require("../testUtils/pgliteDb");
    const { sql } = require("drizzle-orm");
    await db.execute(
      sql`UPDATE media_assets SET metadata = jsonb_build_object('creative_qa', jsonb_build_object('overall', 'fail', 'checks', jsonb_build_object('text', jsonb_build_object('status', 'fail')))) WHERE id = ${assetId}`,
    );
    return null;
  }),
}));

import express from "express";
import { readFileSync } from "fs";
import { join } from "path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import studioRouter from "./studio";
import { generate } from "../studio/router";
import { savePreview } from "../studio/previewStore";
import { previewGeneration } from "../studio/preview";
import type { CreativeBrief } from "../studio/brief";
import {
  athletes,
  athletesCurrent,
  generationJobs,
  mediaAssets,
} from "../../shared/schema";
import { db, client, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import { eq } from "drizzle-orm";
import * as scoring from "../studio/templateScore";

const HER = "22222222-3333-4444-8555-777777777777";
const OFF = { ...process.env };
let server: Server;
let base: string;

async function post(path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as any,
  };
}
async function get(path: string) {
  const res = await fetch(`${base}${path}`);
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as any,
  };
}

const BROLL = {
  intent: "video.generate",
  deliverable: "clip",
  objective: "grow-following",
  direction: "Rain beading on an empty bench at dusk.",
  references: [],
};

beforeAll(async () => {
  await initTestDb();
  await client.exec(
    readFileSync(
      join(__dirname, "..", "studio", "sql", "generationGuards.sql"),
      "utf8",
    ),
  );
  await db.insert(athletes).values({
    id: HER,
    full_name: "Gate Route Athlete",
    sport: "soccer",
  } as never);
  await db.insert(athletesCurrent).values({
    athlete_id: HER,
    story_arc: "A synthetic arc for tests.",
  } as never);
  const app = express();
  app.use(express.json());
  app.use("/", studioRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});
beforeEach(() => {
  process.env = {
    ...OFF,
    STUDIO_ENABLED: "true",
    STUDIO_VIDEO_ENABLED: "true",
  };
  delete process.env.STUDIO_OUTPUT_GATE;
  delete process.env.STUDIO_ALL_ON;
  delete process.env.STUDIO_PROMPT_REGISTRY;
  (globalThis as any).__TEST_ATHLETE_ID = HER;
});
afterAll(() => {
  process.env = OFF;
});

describe("POST /studio/preview — a re-quote's corrective", () => {
  it("under the flag: the codes are frozen on the brief and the fix is in the compiled prompt", async () => {
    process.env.STUDIO_OUTPUT_GATE = "true";
    const r = await post("/studio/preview", {
      ...BROLL,
      corrective: ["black", "black", "name_or_handle"],
    });
    expect(r.status).toBe(200);
    expect(r.json.brief.job.corrective).toEqual(["black", "name_or_handle"]);
    expect(r.json.plan.inputs.prompt).toContain(
      "THE LAST ATTEMPT CAME BACK WRONG.",
    );
  });

  it("flag off: corrective is dropped — the brief and the prompt are what a plain check gives", async () => {
    const plain = await post("/studio/preview", BROLL);
    const withFix = await post("/studio/preview", {
      ...BROLL,
      corrective: ["black"],
    });
    expect(withFix.status).toBe(200);
    expect("corrective" in withFix.json.brief.job).toBe(false);
    expect(withFix.json.plan.inputs.prompt).toBe(plain.json.plan.inputs.prompt);
  });

  it("the master does not turn it on (opt-in, ADI-QS-GO)", async () => {
    process.env.STUDIO_ALL_ON = "true";
    const r = await post("/studio/preview", {
      ...BROLL,
      corrective: ["black"],
    });
    expect("corrective" in r.json.brief.job).toBe(false);
  });

  it("text is never a corrective — anything but the closed codes is a 400", async () => {
    process.env.STUDIO_OUTPUT_GATE = "true";
    for (const bad of [
      ["make it better"],
      "black",
      [1],
      Array(9).fill("black"),
    ]) {
      const r = await post("/studio/preview", { ...BROLL, corrective: bad });
      expect({ status: r.status, field: r.json?.field }).toEqual({
        status: 400,
        field: "corrective",
      });
    }
  });
});

describe("GET /studio/jobs/:jobId — a failed output reads as failed", () => {
  async function succeededClip(
    creativeQa: unknown | null,
    completedAgoMs = 0,
  ): Promise<string> {
    const [job] = await db
      .insert(generationJobs)
      .values({
        athlete_id: HER,
        origin: "system",
        mode: "generate",
        objective: "grow-following",
        deliverable: "clip",
        brief: { job: { mode: "generate" } },
        status: "succeeded",
        provider: "openrouter",
        model: "bytedance/seedance-2.0-fast",
        cost_estimated_usd: "0.3667",
        cost_basis: "estimated",
        completed_at: new Date(Date.now() - completedAgoMs),
      } as never)
      .returning({ id: generationJobs.id });
    await db.insert(mediaAssets).values({
      athlete_id: HER,
      platform: "studio",
      origin: "generated",
      media_type: "VIDEO",
      status: "stored",
      approval_status: "draft",
      generation_job_id: job.id,
      gcs_path: `athletes/${HER}/studio/${job.id}/0.mp4`,
      content_type: "video/mp4",
      ...(creativeQa ? { metadata: { creative_qa: creativeQa } } : {}),
    } as never);
    return job.id;
  }
  const FAILED = {
    gate: {
      version: 1,
      failed: true,
      reasons: ["black"],
      kind: "clip",
      template: { key: null, version: null, source: null },
    },
  };

  it("a failed clip reads as failed: the headline, why, and the codes for a re-quote — the job still succeeded", async () => {
    process.env.STUDIO_OUTPUT_GATE = "true";
    const id = await succeededClip(FAILED);
    const r = await get(`/studio/jobs/${id}`);
    expect(r.json.status).toBe("succeeded");
    expect(r.json.assets[0].gate).toEqual({
      failed: true,
      headline: "This didn't come out right",
      lines: ["Part of it is a black screen."],
      corrective: ["black"],
    });
  });

  it("a clip whose gate has not landed reads as still being checked; an old one does not", async () => {
    process.env.STUDIO_OUTPUT_GATE = "true";
    expect(
      (await get(`/studio/jobs/${await succeededClip(null)}`)).json.assets[0]
        .gate,
    ).toEqual({ pending: true });
    const old = await succeededClip(null, 10 * 60_000);
    expect("gate" in (await get(`/studio/jobs/${old}`)).json.assets[0]).toBe(
      false,
    );
  });

  it("a passing clip carries no gate", async () => {
    process.env.STUDIO_OUTPUT_GATE = "true";
    const id = await succeededClip({
      gate: { ...FAILED.gate, failed: false, reasons: [] },
    });
    expect("gate" in (await get(`/studio/jobs/${id}`)).json.assets[0]).toBe(
      false,
    );
  });

  it("flag off: the wire it was, whatever the record says", async () => {
    const id = await succeededClip(FAILED);
    const r = await get(`/studio/jobs/${id}`);
    expect(Object.keys(r.json.assets[0]).sort()).toEqual([
      "allowedNext",
      "approvalStatus",
      "assetId",
      "mediaType",
      "url",
    ]);
  });
});

describe("POST /studio/generate — an inline image the gate failed is answered as failed", () => {
  const brief = (): CreativeBrief =>
    ({
      briefId: "brief-gate",
      createdAt: new Date().toISOString(),
      job: {
        origin: "system",
        objective: "grow-following",
        deliverable: "post",
        mode: "generate",
        source: null,
        direction: {
          set: "chosen",
          statement: "mid-stride, hard evening light",
          untrusted: false,
          featuredPieces: [],
        },
      },
      athlete: {
        athleteId: HER,
        identity: {
          name: "Test Spike Athlete",
          firstName: "Test",
          identityLine: "soccer · Test University · captain",
          sport: "soccer",
          org: "Test University",
          division: null,
          conference: null,
          segment: null,
          tier: null,
          marqueeTag: null,
        },
        voice: { storyArc: "walked on", highlights: [] },
        audience: {
          descriptor: "women 18-24 · top market US",
          ageRange: "18-24",
          topCity: null,
          topMarket: "US",
          share: 41,
        },
        aesthetic: { register: "grounded", notes: [] },
        goal: "grow her audience",
        commercialState: "none",
      },
      brand: null,
      gaps: [],
    }) as unknown as CreativeBrief;
  beforeEach(() => {
    const now = new Date().toISOString();
    (generate as jest.Mock).mockReset().mockResolvedValue({
      task: "image.generate",
      provider: "vertex",
      model: "gemini-3-pro-image",
      assets: [
        {
          mimeType: "image/png",
          bytes: new Uint8Array([1, 2, 3]).buffer,
          width: 1024,
          height: 1280,
        },
      ],
      cost: { amountUsd: 0.1344, currency: "USD", basis: "estimated" },
      timings: { startedAt: now, completedAt: now, ms: 10 },
      raw: {},
    });
    process.env.STUDIO_CREATIVE_QA = "true";
  });

  it("the gate is recorded before the answer, and the answer's asset says it failed and why", async () => {
    process.env.STUDIO_OUTPUT_GATE = "true";
    const previewId = await savePreview(HER, previewGeneration(brief()));
    const r = await post("/studio/generate", { previewId });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("succeeded");
    expect(r.json.assets[0].gate).toMatchObject({
      failed: true,
      corrective: ["name_or_handle"],
    });
  });

  it("flag off: the same failed inspection, and the answer is the wire it was", async () => {
    const previewId = await savePreview(HER, previewGeneration(brief()));
    const r = await post("/studio/generate", { previewId });
    expect(r.status).toBe(200);
    expect("gate" in r.json.assets[0]).toBe(false);
  });

  // quality-scrappy piece 10 (P10): under STUDIO_PROMPT_REGISTRY each image a generate stores is scored ONCE, on the
  // asset, with its template's key — beside the gate, and nothing in the answer changes. Off, no score is written.
  it("P10: the registry flag scores each stored image once, with its template key, beside the gate — the answer unchanged", async () => {
    process.env.STUDIO_OUTPUT_GATE = "true";
    process.env.STUDIO_PROMPT_REGISTRY = "true";
    const spy = jest.spyOn(scoring, "recordScore");
    try {
      const previewId = await savePreview(HER, previewGeneration(brief()));
      const r = await post("/studio/generate", { previewId });
      expect(r.status).toBe(200);
      expect(r.json.assets).toHaveLength(1);
      expect(spy).toHaveBeenCalledTimes(1);
      expect("score" in r.json.assets[0]).toBe(false);
      const [row] = await db
        .select({ m: mediaAssets.metadata })
        .from(mediaAssets)
        .where(eq(mediaAssets.id, r.json.assets[0].assetId));
      const qa = (row.m as Record<string, any>).creative_qa;
      expect(qa.gate.failed).toBe(true);
      expect(qa.score).toMatchObject({
        kind: "image",
        template: { key: "studio.image.generate", source: "code" },
        text: "fail",
        adherence: "n/a",
        gate: "fail",
        gateReasons: ["name_or_handle"],
      });
    } finally {
      spy.mockRestore();
      delete process.env.STUDIO_PROMPT_REGISTRY;
    }
  });

  it("registry flag off: no score is written", async () => {
    const spy = jest.spyOn(scoring, "recordScore");
    try {
      const previewId = await savePreview(HER, previewGeneration(brief()));
      const r = await post("/studio/generate", { previewId });
      expect(r.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
