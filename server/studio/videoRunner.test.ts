/**
 * videoRunner.test.ts — the property the whole detached design exists for:
 *
 *   A JOB IS SUBMITTED TO THE PROVIDER EXACTLY ONCE, however many runners touch it.
 *
 * videoJobs.test.ts pins the storage-level guards (the reaper keeps the handle, the guarded write
 * lets one submit win). This pins the RUNNER's use of them, which is where a double charge would
 * actually happen: it asserts against the mocked provider that `submitVideoOperation` is called once
 * and only once across a full die-and-hand-off cycle.
 *
 * PGlite for the job rows — real status transitions, real lease columns. The provider and the byte
 * storage are mocked, because what is under test is the ORDER of calls, not Vertex or GCS.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

const submitMock = jest.fn();
const pollMock = jest.fn();
/**
 * ⚠️ THE ADAPTER OBJECT IS MOCKED, NOT JUST ITS TWO FUNCTIONS, and that is a real change in what
 * the runner depends on rather than a quirk of this harness.
 *
 * The runner used to import `submitVideoOperation` / `pollVideoOperation` from this module
 * directly, which hardwired it to Vertex. It now resolves the provider's detached pair off the JOB
 * ROW through `router.resolve`, so what it reaches for is `vertexAdapter.video` — and a mock that
 * exports only the two loose functions leaves `ADAPTERS.vertex` undefined and every test here dies
 * on "Unknown provider".
 *
 * `.video` points at the SAME two mocks, so every assertion below is unchanged: what is under test
 * is still the order of calls, and it is still this file that decides what the provider returns.
 */
jest.mock("./adapters/vertex", () => ({
  submitVideoOperation: (...a: unknown[]) => submitMock(...a),
  pollVideoOperation: (...a: unknown[]) => pollMock(...a),
  vertexAdapter: {
    name: "vertex",
    supports: (task: string) => task === "video.generate",
    generate: () => { throw new Error("the runner must use the detached pair, never generate()"); },
    estimate: () => ({ amountUsd: 0, currency: "USD", basis: "estimated" }),
    video: {
      submit: (...a: unknown[]) => submitMock(...a),
      poll: (...a: unknown[]) => pollMock(...a),
    },
  },
}));

// `previewGeneration` is a mock rather than a stub so one test can use it as a HOOK: it runs inside
// the runner after the claim and before the submit decision, which is exactly the window the
// lease-stealing race lives in.
const previewGenerationMock = jest.fn();
// A jest.fn rather than a fixed arrow so ONE test can vary what the planner returns. Its default,
// set in beforeEach, is the object this was before — so every other test here is unchanged.
const plannedInputsMock = jest.fn();
jest.mock("./preview", () => ({
  ...jest.requireActual("./preview"),
  plannedInputs: (...a: unknown[]) => plannedInputsMock(...a),
  previewGeneration: (...a: unknown[]) => previewGenerationMock(...a),
}));

const PLANNED = {
  task: "video.generate",
  inputs: { prompt: "athlete looks to camera", durationSeconds: 8, aspectRatio: "9:16", references: [] },
  references: [], blocker: null, referenceBlockers: [],
  providerParams: { parameters: { generateAudio: false } }, crops: null,
};

const storeAssetMock = jest.fn();
// `resolveStoredReference` is async and runs inside the runner AFTER the claim and BEFORE the submit
// decision, which makes it the natural hook for the lease-stealing race one test below needs.
const resolveReferenceMock = jest.fn();
jest.mock("./generate", () => ({
  resolveStoredReference: (...a: unknown[]) => resolveReferenceMock(...a),
  storeAsset: (...a: unknown[]) => storeAssetMock(...a),
  studioObjectBase: (athleteId: string, jobId: string, i: number) => `athletes/${athleteId}/studio/${jobId}/${i}`,
}));

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { readLog } from "./costLog";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import { athletes, generationJobs, mediaAssets } from "../../shared/schema";
import { videoTick, RUNNER_ID } from "./videoRunner";
import { queueJob, claimVideoJobs, reapExpiredLeases } from "./videoJobs";
import { GenerationError } from "./types";
import sharp from "sharp";

const ATHLETE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OPERATION = "projects/p/locations/us-central1/operations/op-abc";

beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values({ id: ATHLETE_ID, full_name: "Runner Test Athlete" } as never);
});
afterAll(async () => { await closeTestDb(); });

let logFile: string;
beforeEach(async () => {
  await db.delete(mediaAssets);
  await db.delete(generationJobs);
  jest.clearAllMocks();
  // The runner writes a cost line per stored clip (PR 11); keep it out of the repo root.
  logFile = join(mkdtempSync(join(tmpdir(), "runner-cost-")), "log.jsonl");
  process.env.STUDIO_COST_LOG = logFile;
  submitMock.mockResolvedValue(OPERATION);
  pollMock.mockResolvedValue({
    assets: [{ bytes: Buffer.from("mp4"), mimeType: "video/mp4", width: 720, height: 1280, durationSeconds: 8 }],
    jobId: OPERATION, raw: {},
  });
  storeAssetMock.mockResolvedValue({ gcs_path: "athletes/x/clip.mp4", content_type: "video/mp4", bytes: 6_204_567 });
  plannedInputsMock.mockReturnValue(PLANNED);
  previewGenerationMock.mockReturnValue({ references: [] });
  resolveReferenceMock.mockResolvedValue({ kind: "url", url: "https://example.test/ref.jpg" });
});

async function seedQueuedJob(over: Record<string, unknown> = {}): Promise<string> {
  const [row] = await db.insert(generationJobs).values({
    athlete_id: ATHLETE_ID,
    origin: "system", mode: "generate", objective: "grow-following", deliverable: "clip",
    brief: { job: { mode: "generate" } }, status: "pending",
    provider: "vertex", model: "veo-3.1-generate-001",
    cost_estimated_usd: "1.6", cost_basis: "estimated",
    ...over,
  } as never).returning({ id: generationJobs.id });
  await queueJob(row.id, ATHLETE_ID);
  return row.id;
}

const readJob = async (id: string) =>
  (await db.select().from(generationJobs).where(eq(generationJobs.id, id)))[0];

const expireLease = (id: string) =>
  db.update(generationJobs).set({ lease_until: new Date(Date.now() - 1000) }).where(eq(generationJobs.id, id));

// ─── The happy path ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ HOP 3 OF 4 IN THE CLIP-AUDIO CHAIN, AND THE ONLY ONE NOTHING ELSE COULD SEE.
 *
 * The chain is: the frozen brief decides what is asked for (preview.test.ts), the planner's
 * `providerParams` reaches the SUBMIT unchanged (here), and the adapter turns that into the wire
 * field for seedance and for nothing else (adapters/openrouter.test.ts). No one file spans it.
 *
 * ⚠️ WHAT THIS DOES NOT CLAIM. `./preview` is mocked in this suite, so this says nothing about which
 * briefs produce the flag. And the job runs on VERTEX, because vertex is the only adapter this file
 * mocks — an openrouter row would reach the real `submitVideoOperation` and try to make an HTTP
 * call. That costs the test nothing: the hop under test is provider-agnostic, and it is where
 * `inputsFor`'s empty options live. A field the runner dropped here would be quoted and then
 * silently lost — which is exactly what durationSeconds did (de8826f), and what audio did before
 * 9c2ec71.
 *
 * MUTATION: have the runner build its submit options without `providerParams`. This reds.
 */
it("hands the planner's audio choice to the provider, unchanged — the queued path does not lose it", async () => {
  plannedInputsMock.mockReturnValue({
    ...PLANNED,
    providerParams: { parameters: { generateAudio: true } },
  });
  const jobId = await seedQueuedJob({ cost_estimated_usd: "3.2" });

  const out = await videoTick();

  expect(out.succeeded).toBe(1);
  expect(submitMock).toHaveBeenCalledTimes(1);
  // The third argument is the ProviderOpts the adapter reads. Asserted by path rather than by whole
  // object, because the runner legitimately adds its own lease-renewing `onProgress` alongside.
  const opts = submitMock.mock.calls[0][2] as {
    providerParams?: { parameters?: { generateAudio?: unknown } };
  };
  expect(opts.providerParams?.parameters?.generateAudio).toBe(true);
  expect((await readJob(jobId)).status).toBe("succeeded");
});

it("submits, polls, stores the clip as a DRAFT, and closes the job", async () => {
  const jobId = await seedQueuedJob();
  const out = await videoTick();

  expect(out.claimed).toBe(1);
  expect(out.succeeded).toBe(1);
  expect(submitMock).toHaveBeenCalledTimes(1);
  expect(pollMock).toHaveBeenCalledTimes(1);
  expect(pollMock.mock.calls[0][0]).toBe(OPERATION);

  const job = await readJob(jobId);
  expect(job.status).toBe("succeeded");
  expect(job.provider_operation_name).toBe(OPERATION);
  expect(job.lease_until).toBeNull();

  const [asset] = await db.select().from(mediaAssets);
  expect(asset.media_type).toBe("VIDEO");
  // A generated asset is never born cleared — the approval machine still owns it.
  expect(asset.approval_status).toBe("draft");
  expect(asset.athlete_id).toBe(ATHLETE_ID);      // read off the job row, never from a request
  expect(asset.generation_job_id).toBe(jobId);
});

/** ⚠️ MUTATION "a completed video clip writes no cost line": drop the recordGeneration call from workJob. */
it("a completed clip writes exactly one cost line — the job's quote, marked estimated, joined to job and clip", async () => {
  const jobId = await seedQueuedJob();
  await videoTick();

  const [asset] = await db.select().from(mediaAssets);
  const lines = await readLog(logFile);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({
    task: "video.generate",
    provider: "vertex",
    model: "veo-3.1-generate-001",
    cost: 1.6,
    costBasis: "estimated",
    outputRef: "athletes/x/clip.mp4",
    jobId,
    assetId: asset.id,
    previewId: null, editPreviewId: null, batchId: null, promptVersion: null,
  });
  // The line says where the figure came from: the poll result carries no billed amount.
  expect(lines[0].detail).toContain("cost_estimated_usd");
});

it("a job that fails at the poll writes no line — nothing completed", async () => {
  await seedQueuedJob();
  pollMock.mockRejectedValue(new GenerationError("provider exploded", "provider_error", "vertex"));
  await videoTick();
  expect(await readLog(logFile)).toEqual([]);
});

it("sends the model id translated to its Vertex form, not the OpenRouter one", async () => {
  await seedQueuedJob({ model: "google/veo-3.1" });
  await videoTick();
  expect(submitMock.mock.calls[0][1]).toBe("veo-3.1-generate-001");
});

// ─── THE PROPERTY: one submit across a handoff ──────────────────────────────────────────────────

it("RESUMES a handed-off operation instead of submitting it again", async () => {
  const jobId = await seedQueuedJob();

  // Pass 1: the runner submits, then the instance dies mid-poll.
  pollMock.mockRejectedValueOnce(new GenerationError("Veo operation unfinished", "timeout", "vertex"));
  const first = await videoTick();
  expect(first.deferred).toBe(1);
  expect(submitMock).toHaveBeenCalledTimes(1);

  // The lease lapses and the reaper hands the job on, keeping the handle.
  await expireLease(jobId);
  const reaped = await reapExpiredLeases();
  expect(reaped.requeued).toBe(1);
  expect(reaped.orphaned).toBe(0);
  expect((await readJob(jobId)).provider_operation_name).toBe(OPERATION);

  // Pass 2: a different runner works it.
  const second = await videoTick();
  expect(second.succeeded).toBe(1);

  // ─── THE ASSERTION THAT IS THE POINT OF ALL OF THIS ───
  // Two runners, two passes, ONE submit. A second call here is a second Veo charge.
  expect(submitMock).toHaveBeenCalledTimes(1);
  expect(pollMock).toHaveBeenCalledTimes(2);
  expect(pollMock.mock.calls[1][0]).toBe(OPERATION);
});

it("stands down without spending when the lease was lost between the claim and the submit", async () => {
  const jobId = await seedQueuedJob();
  // THE RACE THIS GUARD EXISTS FOR: we claimed the job, then got slow — long enough for the reaper
  // to requeue it and another instance to take it — and we are now about to spend money on a job
  // that is no longer ours. Reference resolution is the slow step in the real runner (it fetches and
  // may re-encode a full-resolution frame), so stealing the lease inside it is the faithful
  // simulation, and it is awaited so the write has landed before the submit decision is reached.
  previewGenerationMock.mockReturnValue({
    references: [{ role: "person", ref: "athletes/x/frame.jpg", label: "her", slot: "character" }],
  });
  resolveReferenceMock.mockImplementation(async () => {
    await db.update(generationJobs)
      .set({ lease_holder: "another-instance" })
      .where(eq(generationJobs.id, jobId));
    return { kind: "url", url: "https://example.test/ref.jpg" };
  });

  const out = await videoTick();
  expect(out.stoodDown).toBe(1);
  // The only thing that matters: no provider call, so no charge.
  expect(submitMock).not.toHaveBeenCalled();
  // And the job is left for its real holder, not failed out from under them.
  expect((await readJob(jobId)).status).toBe("running");
});

it("does not poll its own operation when it loses the race to record the handle", async () => {
  const jobId = await seedQueuedJob();
  // Another runner's handle lands between our submit and our write.
  submitMock.mockImplementation(async () => {
    await db.update(generationJobs)
      .set({ provider_operation_name: "op-somebody-else" })
      .where(eq(generationJobs.id, jobId));
    return "op-ours";
  });

  const out = await videoTick();
  expect(out.stoodDown).toBe(1);
  // Polling ours as well would store the same job's asset twice.
  expect(pollMock).not.toHaveBeenCalled();
  expect(await db.select().from(mediaAssets)).toEqual([]);
});

// ─── Failure handling ───────────────────────────────────────────────────────────────────────────

it("a poll TIMEOUT leaves the job running rather than failing it — the clip is still coming", async () => {
  const jobId = await seedQueuedJob();
  pollMock.mockRejectedValue(new GenerationError("unfinished after 600s", "timeout", "vertex"));

  const out = await videoTick();
  expect(out.deferred).toBe(1);
  expect(out.failed).toBe(0);
  const job = await readJob(jobId);
  // Still running and still holding its handle, so the reaper can hand it on and the next tick
  // resumes it. Failing here would abandon a clip that has already been paid for.
  expect(job.status).toBe("running");
  expect(job.provider_operation_name).toBe(OPERATION);
});

it("a real provider failure fails the job and releases the lease", async () => {
  const jobId = await seedQueuedJob();
  pollMock.mockRejectedValue(new GenerationError("safety filtered", "provider_error", "vertex"));

  const out = await videoTick();
  expect(out.failed).toBe(1);
  const job = await readJob(jobId);
  expect(job.status).toBe("failed");
  expect(job.last_error).toMatch(/safety filtered/);
  expect(job.lease_until).toBeNull();
});

it("reaps before it claims, so a handed-off job is workable in the same tick", async () => {
  const jobId = await seedQueuedJob();
  pollMock.mockRejectedValueOnce(new GenerationError("unfinished", "timeout", "vertex"));
  await videoTick();
  await expireLease(jobId);

  // One tick: the reap requeues it and the claim in the same pass picks it straight back up.
  const out = await videoTick();
  expect(out.reaped.requeued).toBe(1);
  expect(out.claimed).toBe(1);
  expect(out.succeeded).toBe(1);
  expect(submitMock).toHaveBeenCalledTimes(1);
});

it("claims nothing when the queue is empty, and spends nothing", async () => {
  const out = await videoTick();
  expect(out).toEqual({
    reaped: { orphaned: 0, exhausted: 0, requeued: 0 },
    claimed: 0, succeeded: 0, failed: 0, deferred: 0, stoodDown: 0,
  });
  expect(submitMock).not.toHaveBeenCalled();
});

it("identifies itself with a stable, non-empty runner id", () => {
  expect(RUNNER_ID).toEqual(expect.any(String));
  expect(RUNNER_ID.length).toBeGreaterThan(8);
});

// ─── The first frame leaves in the clip's shape ─────────────────────────────────────────────────

/**
 * MUTATION: in the runner, pass `resolvedReferences(...)` straight to `callInputs` again. This reds.
 *
 * firstFrame.test.ts proves the crop; it cannot prove the runner USES it, and an unwired helper is
 * green everywhere. So this reads the bytes `submit` was actually handed — the dimensions that LEAVE,
 * which is the only place the claim is true or false. Real sharp, a real 2:3 photograph, 9:16 asked.
 */
describe("the first frame is cut to the clip's aspect before submit", () => {
  const photo = () =>
    sharp({ create: { width: 800, height: 1200, channels: 3, background: { r: 40, g: 90, b: 60 } } })
      .jpeg()
      .toBuffer();

  const sentFrame = async () => {
    const sent = submitMock.mock.calls[0][0] as { references: { kind: string; bytes: Buffer }[] };
    const m = await sharp(sent.references[0].bytes).metadata();
    return { width: m.width, height: m.height };
  };

  beforeEach(async () => {
    previewGenerationMock.mockReturnValue({ references: [{ role: "person", ref: "gs://b/her.jpg" }] });
    resolveReferenceMock.mockResolvedValue({ kind: "bytes", bytes: await photo(), mimeType: "image/jpeg" });
  });

  it("sends 675x1200, not the 800x1200 that was stored", async () => {
    await seedQueuedJob();
    await videoTick();
    expect(await sentFrame()).toEqual({ width: 675, height: 1200 });
  });

  // The probe's AS-STORED cell has to be producible on the product path, or the crop can never be
  // measured against its own control.
  it("STUDIO_VIDEO_FRAME_CROP=false sends it as stored", async () => {
    process.env.STUDIO_VIDEO_FRAME_CROP = "false";
    try {
      await seedQueuedJob();
      await videoTick();
      expect(await sentFrame()).toEqual({ width: 800, height: 1200 });
    } finally {
      delete process.env.STUDIO_VIDEO_FRAME_CROP;
    }
  });

  // MUTATION: drop the try/catch in `framedReferences`. This reds — the clip fails instead of going
  // out as it always did. She has approved and been quoted; an optimization must not cost her that.
  it("a frame sharp cannot read still goes out, as stored", async () => {
    const junk = Buffer.from("not an image");
    resolveReferenceMock.mockResolvedValue({ kind: "bytes", bytes: junk, mimeType: "image/jpeg" });
    await seedQueuedJob();
    const out = await videoTick();
    expect(out.succeeded).toBe(1);
    const sent = submitMock.mock.calls[0][0] as { references: { bytes: Buffer }[] };
    expect(sent.references[0].bytes).toBe(junk);
  });
});

// ─── The refusal split, and the one re-roll that reads it ───────────────────────────────────────

describe("a refusal is acted on by its CODE, and the re-roll is off by default", () => {
  const filtered = () =>
    new GenerationError(
      "Veo returned no video — 1 output(s) filtered by safety (Support Codes: 58061214)",
      "content_filtered",
      "vertex",
    );
  const blocked = () =>
    new GenerationError(
      "Video job vid_1 failed: InputImageSensitiveContentDetected.PrivacyInformation",
      "content_blocked",
      "openrouter",
    );

  afterEach(() => {
    delete process.env.STUDIO_AGENT;
    delete process.env.STUDIO_AGENT_RETRY;
  });

  /**
   * ⚠️ THE ASSERTION IS THE SUBMIT COUNT, NOT THE OUTCOME.
   *
   * Both codes end at `failJob` with the job `failed`, so an outcome assertion cannot tell them
   * apart — and the thing that differs is the only thing that costs money. Counting submits is the
   * only assertion that can see a second clip being bought.
   */
  it("does NOT re-roll a filtered clip while STUDIO_AGENT_RETRY is off — one submit, and it fails", async () => {
    const jobId = await seedQueuedJob();
    pollMock.mockRejectedValue(filtered());

    const out = await videoTick();

    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(out.failed).toBe(1);
    expect((await readJob(jobId)).status).toBe("failed");
  });

  /**
   * ⚠️ MUTATION: re-couple the flags — open the brake on `retryEnabled() || agentEnabled()`. This
   * reds, and nothing else does.
   *
   * The reason the flag was split. Turning the Agent on for a demo is a product decision; buying a
   * second clip the day cap cannot see is a money decision nobody has the number for yet. One must
   * not come free with the other.
   */
  it("turning the AGENT on does not turn the retry on — still one submit", async () => {
    process.env.STUDIO_AGENT = "true";
    const jobId = await seedQueuedJob();
    pollMock.mockRejectedValue(filtered());

    const out = await videoTick();

    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(out.failed).toBe(1);
    expect((await readJob(jobId)).status).toBe("failed");
  });

  it("re-rolls ONCE with the flag on, and the second clip is a second submit", async () => {
    process.env.STUDIO_AGENT_RETRY = "true";
    const jobId = await seedQueuedJob();
    submitMock.mockResolvedValueOnce(OPERATION).mockResolvedValueOnce("operations/op-2");
    pollMock.mockRejectedValueOnce(filtered()); // the first ask is withheld
    // the default pollMock (a clip) answers the second

    const out = await videoTick();

    expect(submitMock).toHaveBeenCalledTimes(2);
    expect(out.succeeded).toBe(1);
    const job = await readJob(jobId);
    expect(job.status).toBe("succeeded");
    // The row points at the SECOND operation — the one that actually produced the clip.
    expect(job.provider_operation_name).toBe("operations/op-2");
  });

  it("re-rolls at most once — a second filtering fails the job rather than looping", async () => {
    process.env.STUDIO_AGENT_RETRY = "true";
    const jobId = await seedQueuedJob();
    submitMock.mockResolvedValueOnce(OPERATION).mockResolvedValueOnce("operations/op-2");
    pollMock.mockRejectedValue(filtered()); // withheld every time

    const out = await videoTick();

    expect(submitMock).toHaveBeenCalledTimes(2); // never a third
    expect(out.failed).toBe(1);
    expect((await readJob(jobId)).status).toBe("failed");
  });

  /**
   * THE ONE THAT PROTECTS THE MONEY. An input refusal is the same "no" however many times it is
   * asked, so a re-roll here buys a refusal. The flag being ON must not change that.
   */
  it("NEVER re-rolls an input refusal, even with the flag on", async () => {
    process.env.STUDIO_AGENT_RETRY = "true";
    const jobId = await seedQueuedJob();
    pollMock.mockRejectedValue(blocked());

    const out = await videoTick();

    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(out.failed).toBe(1);
    expect((await readJob(jobId)).status).toBe("failed");
  });

  it("does not re-roll a TIMEOUT — that is a deferral, not a refusal, and the clip is paid for", async () => {
    process.env.STUDIO_AGENT_RETRY = "true";
    await seedQueuedJob();
    pollMock.mockRejectedValue(new GenerationError("unfinished after 600s", "timeout", "vertex"));

    const out = await videoTick();

    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(out.deferred).toBe(1);
  });

  it("records WHY it failed in her words, chosen by the code rather than by the provider", async () => {
    const jobId = await seedQueuedJob();
    pollMock.mockRejectedValue(blocked());
    await videoTick();

    const job = await readJob(jobId);
    // The sentence says asking again will not help — which is the fact the code carries and the
    // provider's own string does not.
    expect(job.last_error).toMatch(/asking again won't change that/i);
    // ...and the provider's words are still there for whoever has to debug it.
    expect(job.last_error).toMatch(/InputImageSensitiveContentDetected/);
  });

  it("says the opposite for a filtered clip — trying again may work", async () => {
    const jobId = await seedQueuedJob();
    pollMock.mockRejectedValue(filtered());
    await videoTick();

    expect((await readJob(jobId)).last_error).toMatch(/Trying again\s+may work/i);
  });

  it("leaves an ordinary provider error's message exactly as it was", async () => {
    const jobId = await seedQueuedJob();
    pollMock.mockRejectedValue(new GenerationError("backend hiccup", "provider_error", "vertex"));
    await videoTick();

    const job = await readJob(jobId);
    expect(job.last_error).toBe("backend hiccup");
  });
});
