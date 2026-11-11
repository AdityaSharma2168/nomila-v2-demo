/**
 * videoRunner.structure.test.ts — the structure check's wiring on the CLIP path (quality-scrappy piece 2): a job that
 * succeeds under STUDIO_CLIP_QC gets `creative_qa.structure` on its stored asset, measured from the bytes the provider
 * returned; with the flag off nothing is written; and no finding — however bad — turns a stored clip's job `failed`.
 *
 * Harness: videoRunner.dispatch.test.ts's (real OpenRouter adapter, stubbed network), with the planner stubbed to a
 * 4 s 9:16 360x640 ask and the "provider" serving a real fixture clip generated at test time.
 *
 * ⚠️ MUTATION M2d: drop the runner's STUDIO_CLIP_QC block — "a succeeded clip carries its structure record" reds.
 * ⚠️ MUTATION M5g: drop the runner's STUDIO_OUTPUT_GATE block — "with the gate on, the black clip's output is failed"
 *   reds.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("google-auth-library", () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: async () => ({
      getAccessToken: async () => ({ token: "test-token" }),
      credentials: { expiry_date: Date.now() + 3_600_000 },
    }),
  })),
}));
jest.mock("../lib/mediaStore", () => ({
  saveBuffer: async () => ({
    gcs_path: "athletes/x/clip.mp4",
    content_type: "video/mp4",
    bytes: 1234,
  }),
  rehostFromUrl: async () => ({
    gcs_path: "athletes/x/clip.mp4",
    content_type: "video/mp4",
    bytes: 1234,
  }),
  signedUrl: async (p: string) => `https://signed.example/${p}`,
  readObject: async () => null,
  deleteObject: async () => undefined,
  uploadKind: () => "video",
  uploadObjectPath: (a: string, id: string) => `athletes/${a}/${id}`,
  UPLOAD_LIMITS: {},
  REVIEW_SUFFIX: ".review.jpg",
}));
jest.mock("./preview", () => ({
  plannedInputs: () => ({
    task: "video.generate",
    inputs: {
      prompt: "an empty court",
      durationSeconds: 4,
      aspectRatio: "9:16",
      width: 360,
      height: 640,
      references: [],
    },
    references: [],
    blocker: null,
    referenceBlockers: [],
    providerParams: { parameters: { generateAudio: false } },
    crops: null,
    shotType: "broll",
  }),
  previewGeneration: () => ({ references: [] }),
}));
const storeAssetMock = jest.fn();
jest.mock("./generate", () => ({
  resolveStoredReference: async () => ({
    kind: "url",
    url: "https://example.test/ref.jpg",
  }),
  storeAsset: (...a: unknown[]) => storeAssetMock(...a),
  studioObjectBase: (athleteId: string, jobId: string, i: number) =>
    `athletes/${athleteId}/studio/${jobId}/${i}`,
}));

import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import { athletes, generationJobs, mediaAssets } from "../../shared/schema";
import { videoTick } from "./videoRunner";
import { queueJob } from "./videoJobs";
import {
  makeStructureFixtures,
  type StructureFixtures,
} from "./video/structureFixtures";

jest.setTimeout(120_000);

const ATHLETE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0002";
const ORIGINAL_ENV = { ...process.env };
const DIR = mkdtempSync(join(tmpdir(), "runner-structure-"));
let fx: StructureFixtures;
let fetchMock: jest.Mock;

const json = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
  arrayBuffer: async () => new ArrayBuffer(8),
});

/** OpenRouter completes at once and serves `clip`'s real bytes on the authenticated download. */
function serves(clip: string) {
  const bytes = readFileSync(clip);
  fetchMock.mockImplementation(async (url: string) => {
    if (/\/api\/v1\/videos$/.test(url))
      return json({ id: "or-job-1", status: "pending" });
    if (/\/api\/v1\/videos\/[^/]+\/content/.test(url))
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
      };
    if (/\/api\/v1\/videos\//.test(url))
      return json({
        status: "completed",
        unsigned_urls: ["https://openrouter.ai/api/v1/videos/or-job-1/content"],
      });
    throw new Error(`unexpected url: ${url}`);
  });
}

beforeAll(async () => {
  fx = await makeStructureFixtures(DIR);
  await initTestDb();
  await db
    .insert(athletes)
    .values({ id: ATHLETE_ID, full_name: "Structure Runner Athlete" } as never);
});
afterAll(async () => {
  await closeTestDb();
  rmSync(DIR, { recursive: true, force: true });
});
beforeEach(async () => {
  await db.delete(mediaAssets);
  await db.delete(generationJobs);
  jest.clearAllMocks();
  process.env = {
    ...ORIGINAL_ENV,
    OPENROUTER_API_KEY: "test-key",
    STUDIO_VIDEO_POLL_MS: "1",
    STUDIO_COST_LOG: "/dev/null",
  };
  delete process.env.STUDIO_CLIP_QC;
  delete process.env.STUDIO_OUTPUT_GATE;
  delete process.env.STUDIO_ALL_ON;
  delete process.env.STUDIO_CREATIVE_QA;
  delete process.env.STUDIO_PROMPT_REGISTRY;
  fetchMock = jest.fn();
  global.fetch = fetchMock as never;
  storeAssetMock.mockResolvedValue({
    gcs_path: "athletes/x/clip.mp4",
    content_type: "video/mp4",
    bytes: 1234,
  });
});
afterEach(() => {
  process.env = ORIGINAL_ENV;
});

async function runOne(): Promise<{ job: string; creativeQa: any }> {
  const [row] = await db
    .insert(generationJobs)
    .values({
      athlete_id: ATHLETE_ID,
      origin: "system",
      mode: "generate",
      objective: "grow-following",
      deliverable: "clip",
      brief: {
        job: { mode: "generate", direction: { statement: "an empty court" } },
      },
      status: "pending",
      provider: "openrouter",
      model: "bytedance/seedance-2.0-fast",
      cost_estimated_usd: "0.3667",
      cost_basis: "estimated",
    } as never)
    .returning({ id: generationJobs.id });
  await queueJob(row.id, ATHLETE_ID);
  await videoTick();
  const [job] = await db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.id, row.id));
  const [asset] = await db
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.generation_job_id, row.id));
  return { job: job.status, creativeQa: (asset?.metadata as any)?.creative_qa };
}

it("a succeeded clip carries its structure record — measured from the bytes returned", async () => {
  process.env.STUDIO_CLIP_QC = "true";
  serves(fx.clean);
  const { job, creativeQa } = await runOne();
  expect(job).toBe("succeeded");
  expect(creativeQa.structure).toMatchObject({
    subject: "clip",
    status: "pass",
    findings: [],
  });
  expect(creativeQa.structure.expected).toEqual({
    durationSec: 4,
    aspect: "9:16",
    width: 360,
    height: 640,
    sound: false,
  });
});

it("a black clip is recorded as failing — and its job STAYS succeeded, the clip stored", async () => {
  process.env.STUDIO_CLIP_QC = "true";
  serves(fx.black);
  const { job, creativeQa } = await runOne();
  expect(job).toBe("succeeded");
  expect(creativeQa.structure.status).toBe("fail");
  expect(creativeQa.structure.findings).toContainEqual({
    reason: "black",
    severity: "fail",
  });
});

it("the master turns it on (it is under the master, ADI-QS-GO)", async () => {
  process.env.STUDIO_ALL_ON = "true";
  serves(fx.clean);
  expect((await runOne()).creativeQa?.structure?.status).toBe("pass");
});

it("flag off: nothing is written — the asset's metadata is what it was", async () => {
  serves(fx.black);
  const { job, creativeQa } = await runOne();
  expect(job).toBe("succeeded");
  expect(creativeQa).toBeUndefined();
});

// ─── quality-scrappy piece 5: the gate, last, over what the checks wrote ─────────────────────────────

it("with the gate on, the black clip's output is failed — and its job STAYS succeeded", async () => {
  process.env.STUDIO_CLIP_QC = "true";
  process.env.STUDIO_OUTPUT_GATE = "true";
  serves(fx.black);
  const { job, creativeQa } = await runOne();
  expect(job).toBe("succeeded");
  expect(creativeQa.gate).toMatchObject({ failed: true, kind: "clip" });
  expect(creativeQa.gate.reasons).toContain("black");
});

it("with the gate on, a clean clip is recorded as passing — the pass rate's denominator", async () => {
  process.env.STUDIO_CLIP_QC = "true";
  process.env.STUDIO_OUTPUT_GATE = "true";
  serves(fx.clean);
  expect((await runOne()).creativeQa.gate).toMatchObject({
    failed: false,
    reasons: [],
  });
});

// ─── quality-scrappy piece 10: the template's score, after the gate ────────────────────────────────────

it("under the registry flag each clip is scored, after the gate — adherence n/a, the gate's template on it", async () => {
  process.env.STUDIO_CLIP_QC = "true";
  process.env.STUDIO_OUTPUT_GATE = "true";
  process.env.STUDIO_PROMPT_REGISTRY = "true";
  serves(fx.black);
  const { job, creativeQa } = await runOne();
  expect(job).toBe("succeeded");
  expect(creativeQa.score).toMatchObject({
    kind: "clip",
    adherence: "n/a",
    gate: "fail",
  });
  expect(creativeQa.score.gateReasons).toContain("black");
  // The same template record as the gate's (this harness's stored brief is bare, so both name none; a real key on a
  // score is routes/studio.outputGate.test.ts's, through a real generate).
  expect(creativeQa.score.template).toEqual(creativeQa.gate.template);
});

it("registry flag off: no score on the clip", async () => {
  process.env.STUDIO_CLIP_QC = "true";
  process.env.STUDIO_OUTPUT_GATE = "true";
  serves(fx.black);
  expect((await runOne()).creativeQa.score).toBeUndefined();
});

it("the master does not turn the gate on (opt-in)", async () => {
  process.env.STUDIO_ALL_ON = "true";
  serves(fx.black);
  const { creativeQa } = await runOne();
  expect(creativeQa.structure.status).toBe("fail");
  expect(creativeQa.gate).toBeUndefined();
});
