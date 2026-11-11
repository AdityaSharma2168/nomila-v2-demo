/**
 * videoRunner.dialect.test.ts — the prompt a queued b-roll clip SENDS is written for the model on its ROW, whatever the
 * env says when it runs (quality-scrappy piece 1, ADI-QS-GO R6; docs/probes/video-prompt-quality-ledger.md D1).
 *
 * The runner re-derives the prompt from the frozen brief at run time (`inputsFor` → `plannedInputs`) but dispatches on
 * the row's provider and model. Before the dialect, that was invisible: every model got the same text. With it, an env
 * change between the quote and the run would compile for one model and send to another. So: quote under one env, flip
 * the env, run the REAL runner through the REAL planner and the REAL OpenRouter adapter, and read the prompt off the
 * request body that left.
 *
 * Harness: videoRunner.dispatch.test.ts's, minus its planner mock — the planner is what is under test here. The network
 * (`global.fetch`), the credential library, GCS and storage are the stubbed boundaries.
 *
 * ⚠️ MUTATION M1c (docs/probes/quality-scrappy.md): the runner stops passing the row's model (`dialectModel`) — "an env
 * flip between the quote and the run does not change the dialect" reds by name.
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

// mediaStore builds a GCS client at module load from the stubbed credential library — see dispatch.test.ts.
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

import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import { athletes, generationJobs, mediaAssets } from "../../shared/schema";
import { MODELS } from "./config";
import { previewGeneration } from "./preview";
import { videoTick } from "./videoRunner";
import { queueJob } from "./videoJobs";
import type { CreativeBrief } from "./brief";
import { clipBrief } from "./video/seedance.cells";

const ATHLETE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001";
const ORIGINAL_ENV = { ...process.env };
let fetchMock: jest.Mock;

const json = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
  arrayBuffer: async () => new ArrayBuffer(8),
});

function openrouterServes() {
  fetchMock.mockImplementation(async (url: string) => {
    if (/\/api\/v1\/videos$/.test(url))
      return json({ id: "or-job-1", status: "pending" });
    if (/\/api\/v1\/videos\/[^/]+\/content/.test(url)) return json({});
    if (/\/api\/v1\/videos\//.test(url))
      return json({
        status: "completed",
        unsigned_urls: ["https://openrouter.ai/api/v1/videos/or-job-1/content"],
        usage: { cost: 0.3667 },
      });
    throw new Error(`unexpected url: ${url}`);
  });
}

/** The prompt on the one submit the runner made. */
const sentPrompt = (): string => {
  const submit = fetchMock.mock.calls.find((c) =>
    /\/api\/v1\/videos$/.test(String(c[0])),
  );
  if (!submit) throw new Error("the runner submitted nothing");
  return JSON.parse(submit[1].body).prompt;
};

beforeAll(async () => {
  await initTestDb();
  await db
    .insert(athletes)
    .values({ id: ATHLETE_ID, full_name: "Dialect Test Athlete" } as never);
});
afterAll(async () => {
  await closeTestDb();
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
    STUDIO_DIALECTS: "true",
  };
  delete process.env.STUDIO_VIDEO_BROLL_MODEL;
  delete process.env.STUDIO_VIDEO_BROLL_PROVIDER;
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

/** Quote a b-roll clip under the CURRENT env, and queue a job the way jobs.ts writes one: off the quote's plan. */
async function quoteAndQueue(): Promise<{ quoted: string; model: string }> {
  const brief: CreativeBrief = {
    ...clipBrief({ durationSeconds: 4 } as Partial<CreativeBrief["job"]>),
    athlete: { ...clipBrief().athlete, athleteId: ATHLETE_ID },
  } as CreativeBrief;
  const preview = previewGeneration(brief, {});
  if (!preview.plan)
    throw new Error(`quote blocked: ${preview.verdict.reason}`);
  const [row] = await db
    .insert(generationJobs)
    .values({
      athlete_id: ATHLETE_ID,
      origin: "system",
      mode: "generate",
      objective: "grow-following",
      deliverable: "clip",
      brief: preview.brief as never,
      status: "pending",
      provider: preview.plan.provider,
      model: preview.plan.model,
      cost_estimated_usd: String(preview.cost?.amountUsd ?? 0.3667),
      cost_basis: "estimated",
    } as never)
    .returning({ id: generationJobs.id });
  await queueJob(row.id, ATHLETE_ID);
  return { quoted: preview.plan.inputs.prompt, model: preview.plan.model };
}

it("an env flip between the quote and the run does not change the dialect: quoted Seedance, run under Veo's env", async () => {
  openrouterServes();
  const { quoted, model } = await quoteAndQueue();
  expect(model).toBe(MODELS.seedanceFast);
  expect(quoted).toContain("Avoid: "); // the dialect, at the quote

  // The env moves b-roll to Veo before the tick. The row still says Seedance-fast.
  process.env.STUDIO_VIDEO_BROLL_MODEL = MODELS.veo;
  const tick = await videoTick();

  expect(tick.succeeded).toBe(1);
  expect(sentPrompt()).toBe(quoted);
});

it("and the reverse: quoted under Veo (no dialect), run under Seedance's env — still today's template", async () => {
  openrouterServes();
  process.env.STUDIO_VIDEO_BROLL_MODEL = MODELS.veo;
  const { quoted, model } = await quoteAndQueue();
  expect(model).toBe(MODELS.veo);
  expect(quoted).not.toContain("Avoid: ");

  delete process.env.STUDIO_VIDEO_BROLL_MODEL; // back to the Seedance-fast default
  await videoTick();

  expect(sentPrompt()).toBe(quoted);
});
