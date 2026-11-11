/**
 * videoRunner.dispatch.test.ts — WHICH PROVIDER A QUEUED CLIP IS SENT TO, and where that answer
 * comes from.
 *
 * ─── THE PROPERTY ──────────────────────────────────────────────────────────────────────────────
 *
 *   A JOB GOES TO THE PROVIDER IT WAS QUEUED AGAINST, whatever the config says at the moment it is
 *   claimed.
 *
 * `studio/jobs.ts` writes `provider` and `model` onto the row at queue time, off the frozen preview
 * plan the athlete's approval was quoted against. Config (`routeFor`, `STUDIO_VIDEO_PROVIDER`)
 * answers "what would we do now"; the row answers "what did we commit to then". A job already in
 * flight only ever wants the second question, and this file is the proof that it asks it.
 *
 * ⚠️ WHAT GETTING THIS WRONG COSTS, and why it is worse than a refusal. A clip queued while the
 * flag said `openrouter` and claimed after it moved to `vertex` would be SUBMITTED to Vertex — a
 * second charge for a clip already running somewhere else. On a RESUME it is nastier: an OpenRouter
 * job id polled against Vertex's `fetchPredictOperation` fails looking like a dead job rather than
 * a misroute, so the clip is paid for, abandoned, and the log blames the wrong provider.
 *
 * ─── WHY THIS IS A SEPARATE FILE FROM videoRunner.test.ts ──────────────────────────────────────
 *
 * That one mocks `./adapters/vertex` wholesale, which is right for pinning the ORDER of calls and
 * useless for pinning WHICH ADAPTER runs — a mocked adapter cannot tell you it was the wrong one.
 *
 * So here BOTH ADAPTERS ARE REAL and the stubs sit at the two boundaries the house rules name:
 * `global.fetch` (network) and `google-auth-library` (credential), exactly as adapters/vertex.test.ts
 * already does. The assertion is then on the HOST that was called, which is routing proven end to
 * end rather than a mock reporting that it was invoked.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

// The credential boundary — same stub adapters/vertex.test.ts uses. No network, no real token.
jest.mock("google-auth-library", () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: async () => ({
      getAccessToken: async () => ({ token: "test-token" }),
      credentials: { expiry_date: Date.now() + 3_600_000 },
    }),
  })),
}));

/**
 * ⚠️ lib/mediaStore MUST BE STUBBED IN THIS FILE, and the reason is not obvious from the runner.
 *
 * `videoRunner -> jobs -> thumbnail -> lib/mediaStore`, and mediaStore constructs a
 * `@google-cloud/storage` client AT MODULE LOAD. That client builds itself out of
 * `google-auth-library` — which this file stubs, for Vertex — so the storage constructor dies on
 * `Cannot read properties of undefined (reading 'bind')` and the whole suite fails to run before a
 * single test starts.
 *
 * videoRunner.test.ts never hits this because it does not stub the credential library at all; it
 * mocks the Vertex adapter instead. Keeping BOTH adapters real is exactly what costs this stub, and
 * it is the right trade: a mocked adapter cannot tell you it was the wrong one.
 *
 * `jobs.ts` itself stays REAL — the job rows and their status transitions are part of what is under
 * test. Only the GCS boundary is replaced.
 */
jest.mock("../lib/mediaStore", () => ({
  saveBuffer: async () => ({ gcs_path: "athletes/x/clip.mp4", content_type: "video/mp4", bytes: 1234 }),
  rehostFromUrl: async () => ({ gcs_path: "athletes/x/clip.mp4", content_type: "video/mp4", bytes: 1234 }),
  signedUrl: async (p: string) => `https://signed.example/${p}`,
  readObject: async () => null,
  deleteObject: async () => undefined,
  uploadKind: () => "video",
  uploadObjectPath: (a: string, id: string) => `athletes/${a}/${id}`,
  UPLOAD_LIMITS: {},
  REVIEW_SUFFIX: ".review.jpg",
}));

// Inputs are not what is under test; the runner needs them to reach the submit decision. No
// `jest.requireActual` — the runner reads only these two functions from preview.
jest.mock("./preview", () => ({
  plannedInputs: () => ({
    task: "video.generate",
    inputs: { prompt: "athlete looks to camera", durationSeconds: 8, aspectRatio: "9:16", references: [] },
    references: [], blocker: null, referenceBlockers: [], providerParams: {}, crops: null,
  }),
  previewGeneration: () => ({ references: [] }),
}));

// The GCS boundary. Storing the clip is studio/generate.ts's job and has its own tests.
const storeAssetMock = jest.fn();
jest.mock("./generate", () => ({
  resolveStoredReference: async () => ({ kind: "url", url: "https://example.test/ref.jpg" }),
  storeAsset: (...a: unknown[]) => storeAssetMock(...a),
  studioObjectBase: (athleteId: string, jobId: string, i: number) => `athletes/${athleteId}/studio/${jobId}/${i}`,
}));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import { athletes, generationJobs, mediaAssets } from "../../shared/schema";
import { videoTick } from "./videoRunner";
import { queueJob } from "./videoJobs";

const ATHLETE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";
const ORIGINAL_ENV = { ...process.env };

let fetchMock: jest.Mock;

/** Every url `fetch` was called with, in order — the whole assertion surface of this file. */
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));
const hosts = () => urls().map((u) => new URL(u).host);

const json = (body: unknown) => ({
  ok: true, status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
  arrayBuffer: async () => new ArrayBuffer(8),
});

/** OpenRouter: submit accepted, one poll already complete, then the authenticated clip download. */
function openrouterServes() {
  fetchMock.mockImplementation(async (url: string) => {
    if (/\/api\/v1\/videos$/.test(url)) return json({ id: "or-job-1", status: "pending" });
    if (/\/api\/v1\/videos\/[^/]+\/content/.test(url)) return json({});
    if (/\/api\/v1\/videos\//.test(url)) {
      return json({
        status: "completed",
        unsigned_urls: ["https://openrouter.ai/api/v1/videos/or-job-1/content"],
        usage: { cost: 0.504 },
      });
    }
    throw new Error(`unexpected url for the OpenRouter arm: ${url}`);
  });
}

/** Vertex: predictLongRunning returns an operation, fetchPredictOperation returns a finished video. */
function vertexServes() {
  fetchMock.mockImplementation(async (url: string) => {
    if (/:predictLongRunning$/.test(url)) return json({ name: "projects/p/locations/us-central1/operations/op-1" });
    if (/:fetchPredictOperation$/.test(url)) {
      return json({ done: true, response: { videos: [{ bytesBase64Encoded: Buffer.from("mp4").toString("base64"), mimeType: "video/mp4" }] } });
    }
    throw new Error(`unexpected url for the Vertex arm: ${url}`);
  });
}

beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values({ id: ATHLETE_ID, full_name: "Dispatch Test Athlete" } as never);
});
afterAll(async () => { await closeTestDb(); });

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
  fetchMock = jest.fn();
  global.fetch = fetchMock as never;
  storeAssetMock.mockResolvedValue({ gcs_path: "athletes/x/clip.mp4", content_type: "video/mp4", bytes: 1234 });
});
afterEach(() => { process.env = ORIGINAL_ENV; });

async function seedQueuedJob(over: Record<string, unknown>): Promise<string> {
  const [row] = await db.insert(generationJobs).values({
    athlete_id: ATHLETE_ID,
    origin: "system", mode: "generate", objective: "grow-following", deliverable: "clip",
    brief: { job: { mode: "generate" } }, status: "pending",
    cost_estimated_usd: "0.504", cost_basis: "estimated",
    ...over,
  } as never).returning({ id: generationJobs.id });
  await queueJob(row.id, ATHLETE_ID);
  return row.id;
}

const readJob = async (id: string) =>
  (await db.select().from(generationJobs).where(eq(generationJobs.id, id)))[0];

// ─── 1. The row decides ─────────────────────────────────────────────────────────────────────────

it("routes an OpenRouter job to OpenRouter, not to Vertex", async () => {
  openrouterServes();
  const jobId = await seedQueuedJob({ provider: "openrouter", model: "kwaivgi/kling-v3.0-std" });

  const tick = await videoTick();

  expect(tick.succeeded).toBe(1);
  // THE ASSERTION. Before this commit the runner imported Vertex's two functions directly, so this
  // job went to aiplatform.googleapis.com with a model id Vertex has never heard of.
  expect(hosts()).not.toContain("aiplatform.googleapis.com");
  expect(hosts()).not.toContain("us-central1-aiplatform.googleapis.com");
  expect(urls()[0]).toBe("https://openrouter.ai/api/v1/videos");
  // and the model travelled in its OpenRouter form, untranslated
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe("kwaivgi/kling-v3.0-std");
  expect((await readJob(jobId)).status).toBe("succeeded");
});

it("still routes a Vertex job to Vertex", async () => {
  vertexServes();
  await seedQueuedJob({ provider: "vertex", model: "veo-3.1-generate-001" });

  const tick = await videoTick();

  expect(tick.succeeded).toBe(1);
  expect(hosts()[0]).toBe("us-central1-aiplatform.googleapis.com");
  expect(urls()[0]).toMatch(/:predictLongRunning$/);
});

// ─── 2. Config cannot move a job that is already queued ────────────────────────────────────────

it("a config flip between queue and claim does not misroute an in-flight job", async () => {
  // The row was written when the route said openrouter. The flag has since moved. The job is not
  // the flag's to re-decide: it was quoted, approved and queued against a specific provider.
  process.env.STUDIO_VIDEO_PROVIDER = "vertex";
  process.env.STUDIO_VIDEO_MODEL = "veo-3.1-generate-001";
  openrouterServes();
  await seedQueuedJob({ provider: "openrouter", model: "kwaivgi/kling-v3.0-std" });

  await videoTick();

  // RED the moment dispatch consults routeFor()/STUDIO_VIDEO_PROVIDER instead of the row.
  expect(urls()[0]).toBe("https://openrouter.ai/api/v1/videos");
  expect(hosts().some((h) => h.endsWith("aiplatform.googleapis.com"))).toBe(false);
});

it("and the same in reverse — a Vertex row is not dragged to OpenRouter by the flag", async () => {
  process.env.STUDIO_VIDEO_PROVIDER = "openrouter";
  process.env.STUDIO_VIDEO_MODEL = "kwaivgi/kling-v3.0-std";
  vertexServes();
  await seedQueuedJob({ provider: "vertex", model: "veo-3.1-generate-001" });

  await videoTick();

  expect(hosts()[0]).toBe("us-central1-aiplatform.googleapis.com");
  expect(urls().some((u) => u.startsWith("https://openrouter.ai/"))).toBe(false);
});

// ─── 3. A resume follows the handle's own provider ─────────────────────────────────────────────

it("a resume-poll goes to the provider that holds the operation, and submits nothing", async () => {
  process.env.STUDIO_VIDEO_PROVIDER = "vertex"; // the flag disagrees with the row on purpose
  openrouterServes();
  // A job that already has an OpenRouter handle: submitted by an instance that then died.
  await seedQueuedJob({
    provider: "openrouter",
    model: "kwaivgi/kling-v3.0-std",
    provider_operation_name: "or-job-1",
  });

  await videoTick();

  // ⚠️ THE WORST CASE THIS RULES OUT: polling an OpenRouter job id against Vertex's
  // fetchPredictOperation, which fails looking like a dead job rather than a misroute.
  expect(urls().some((u) => /:fetchPredictOperation$/.test(u))).toBe(false);
  expect(urls()[0]).toBe("https://openrouter.ai/api/v1/videos/or-job-1");
  // and nothing was re-submitted — a POST to /videos would be a second charge
  expect(urls().some((u) => /\/api\/v1\/videos$/.test(u))).toBe(false);
});

// ─── 4. Submit-once, on the arm that did not previously exist ──────────────────────────────────

it("submits exactly once across a die-and-hand-off cycle, on OpenRouter too", async () => {
  openrouterServes();
  const jobId = await seedQueuedJob({ provider: "openrouter", model: "kwaivgi/kling-v3.0-std" });

  // Tick 1 submits and completes. Simulate the instance dying AFTER the handle was recorded by
  // re-queuing the row with its handle intact — which is exactly what the reaper does.
  await videoTick();
  const submitsAfterFirst = urls().filter((u) => /\/api\/v1\/videos$/.test(u)).length;
  expect(submitsAfterFirst).toBe(1);
  expect((await readJob(jobId)).provider_operation_name).toBe("or-job-1");

  await db.update(generationJobs)
    .set({ status: "running", lease_until: null, lease_holder: null })
    .where(eq(generationJobs.id, jobId));
  await videoTick();

  // Still ONE submit across both ticks. A second would be a second clip, billed.
  expect(urls().filter((u) => /\/api\/v1\/videos$/.test(u)).length).toBe(1);
});

// ─── The rows this runner inherited ────────────────────────────────────────────────────────────

it("works a NULL-provider row as Vertex, because that is what it was queued against", async () => {
  // Not a fallback to config: such a row was written when this runner imported Vertex's two
  // functions directly and no other provider was reachable from here at all. Vertex is its history.
  process.env.STUDIO_VIDEO_PROVIDER = "openrouter";
  vertexServes();
  await seedQueuedJob({ provider: null, model: "veo-3.1-generate-001" });

  await videoTick();

  expect(hosts()[0]).toBe("us-central1-aiplatform.googleapis.com");
});

it("REFUSES a provider that cannot serve this job rather than substituting one", async () => {
  const jobId = await seedQueuedJob({ provider: "fal", model: "fal-ai/sam3" });

  const tick = await videoTick();

  // fal serves segmentation only. Sending this clip to whoever else happens to be routed would
  // submit it somewhere it was never quoted against, so it fails instead — spending nothing.
  expect(tick.failed).toBe(1);
  expect(fetchMock).not.toHaveBeenCalled();
  expect((await readJob(jobId)).last_error).toMatch(/does not support video\.generate/);

  // ⚠️ NOTE WHICH GUARD ACTUALLY FIRED. `router.resolve` rejects this on `supports(task)` before
  // `videoAdapterFor`'s own `!adapter.video` check is reached — so that second check is currently
  // UNEXERCISABLE, and this test does not pretend to cover it. It is there for a provider added
  // later that serves video.generate inline but has no detached pair, which is a real shape (the
  // pair is optional on GenerationAdapter precisely because fal has neither). Left in deliberately
  // and recorded as uncovered rather than deleted or faked.
});

it("one unworkable row does not take the rest of the tick down with it", async () => {
  // ⚠️ THIS IS A REGRESSION TEST FOR THIS COMMIT'S OWN FIRST DRAFT. `videoAdapterFor` was called
  // OUTSIDE workJob's try, so its throw escaped workJob and videoTick both — killing the whole
  // tick, taking every other claimed job in the batch with it, and leaving them claimed with their
  // leases held. One poison row would have stopped the queue.
  openrouterServes();
  await seedQueuedJob({ provider: "fal", model: "fal-ai/sam3" });
  const goodId = await seedQueuedJob({ provider: "openrouter", model: "kwaivgi/kling-v3.0-std" });

  const tick = await videoTick(5);

  expect(tick.failed).toBe(1);
  expect(tick.succeeded).toBe(1);
  expect((await readJob(goodId)).status).toBe("succeeded");
  // and the bad row released its lease rather than sitting on it
  const bad = (await db.select().from(generationJobs).where(eq(generationJobs.status, "failed")))[0];
  expect(bad.lease_holder).toBeNull();
});
