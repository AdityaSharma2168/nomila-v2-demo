/**
 * videoRunnerQa.test.ts — WHERE the QA stage sits in the runner, which is the whole of its design.
 *
 * videoRunner.test.ts pins the property the detached model exists for (one submit across a
 * handoff). This pins the one that video QA introduced, and it is a different hazard:
 *
 *   `reapExpiredLeases` requeues on `status='running' AND lease_until < now()`, KEEPING
 *   `provider_operation_name`. Between the store and `succeedJob` the job is still `running`, and
 *   the lease is renewed only on poll progress — which has finished. Put a three-minute QA stage in
 *   that window and the lease lapses, the reaper requeues, the next runner RESUMES THE SAME
 *   OPERATION, and the asset is recorded a second time.
 *
 * ─── ⚠️  HOW "QA OUTLIVED THE LEASE" IS MADE DETERMINISTIC ─────────────────────────────────────
 *
 * Not by waiting, which is not a test. The QA mock EXPIRES THE LEASE ITSELF — it writes
 * `lease_until` into the past, which is exactly the state elapsed time would have produced, and is
 * the same thing videoJobs.test.ts already does to drive the reaper. `leaseMs()` has a hard
 * `Math.max(180_000, …)` floor and cannot be shrunk by env, so the column is written rather than
 * the clock moved.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

const submitMock = jest.fn();
const pollMock = jest.fn();
jest.mock("./adapters/vertex", () => ({
  submitVideoOperation: (...a: unknown[]) => submitMock(...a),
  pollVideoOperation: (...a: unknown[]) => pollMock(...a),
  vertexAdapter: {
    name: "vertex",
    supports: (task: string) => task === "video.generate",
    generate: () => {
      throw new Error("the runner must use the detached pair");
    },
    estimate: () => ({ amountUsd: 0, currency: "USD", basis: "estimated" }),
    video: {
      submit: (...a: unknown[]) => submitMock(...a),
      poll: (...a: unknown[]) => pollMock(...a),
    },
  },
}));

const previewGenerationMock = jest.fn();
jest.mock("./preview", () => ({
  ...jest.requireActual("./preview"),
  plannedInputs: () => ({
    task: "video.generate",
    inputs: {
      prompt: "she looks into the camera",
      durationSeconds: 8,
      aspectRatio: "9:16",
      references: [],
    },
    references: [],
    blocker: null,
    referenceBlockers: [],
    providerParams: { parameters: { generateAudio: false } },
    crops: null,
    shotType: "identity",
    videoRoute: { provider: "vertex", model: "veo-3.1-generate-001" },
  }),
  previewGeneration: (...a: unknown[]) => previewGenerationMock(...a),
}));

const storeAssetMock = jest.fn();
const resolveReferenceMock = jest.fn();
jest.mock("./generate", () => ({
  resolveStoredReference: (...a: unknown[]) => resolveReferenceMock(...a),
  storeAsset: (...a: unknown[]) => storeAssetMock(...a),
  studioObjectBase: (athleteId: string, jobId: string, i: number) =>
    `athletes/${athleteId}/studio/${jobId}/${i}`,
}));

const inspectClipMock = jest.fn();
jest.mock("./qa/inspectClip", () => ({
  inspectClipAsset: (...a: unknown[]) => inspectClipMock(...a),
}));

const qaEnabledMock = jest.fn();
jest.mock("./qa/record", () => ({
  ...jest.requireActual("./qa/record"),
  creativeQaEnabled: () => qaEnabledMock(),
}));

import { existsSync, readFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import { athletes, generationJobs, mediaAssets } from "../../shared/schema";
import { videoTick } from "./videoRunner";
import { queueJob, reapExpiredLeases } from "./videoJobs";
import { GenerationError } from "./types";

const ATHLETE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OPERATION = "projects/p/locations/us-central1/operations/op-qa";
const STATEMENT = "She looks into the camera and breaks into a smile.";

beforeAll(async () => {
  await initTestDb();
  await db
    .insert(athletes)
    .values({ id: ATHLETE_ID, full_name: "QA Runner Athlete" } as never);
});
afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await db.delete(mediaAssets);
  await db.delete(generationJobs);
  jest.clearAllMocks();
  submitMock.mockResolvedValue(OPERATION);
  pollMock.mockResolvedValue({
    assets: [
      {
        bytes: Buffer.from("mp4-bytes"),
        mimeType: "video/mp4",
        width: 720,
        height: 1280,
        durationSeconds: 8,
      },
    ],
    jobId: OPERATION,
    raw: {},
  });
  storeAssetMock.mockResolvedValue({
    gcs_path: "athletes/x/clip.mp4",
    content_type: "video/mp4",
    bytes: 1_204_567,
  });
  previewGenerationMock.mockReturnValue({ references: [] });
  resolveReferenceMock.mockResolvedValue({
    kind: "url",
    url: "https://example.test/ref.jpg",
  });
  inspectClipMock.mockResolvedValue(null);
  qaEnabledMock.mockReturnValue(false);
});

async function seedQueuedJob(): Promise<string> {
  const [row] = await db
    .insert(generationJobs)
    .values({
      athlete_id: ATHLETE_ID,
      origin: "system",
      mode: "generate",
      objective: "grow-following",
      deliverable: "clip",
      brief: {
        job: {
          mode: "generate",
          direction: { set: "chosen", statement: STATEMENT, untrusted: false },
        },
      },
      status: "pending",
      provider: "vertex",
      model: "veo-3.1-generate-001",
      cost_estimated_usd: "1.6",
      cost_basis: "estimated",
    } as never)
    .returning({ id: generationJobs.id });
  await queueJob(row.id, ATHLETE_ID);
  return row.id;
}

const readJob = async (id: string) =>
  (await db.select().from(generationJobs).where(eq(generationJobs.id, id)))[0];
const assetRows = () => db.select().from(mediaAssets);
const expireLease = (id: string) =>
  db
    .update(generationJobs)
    .set({ lease_until: new Date(Date.now() - 1000) })
    .where(eq(generationJobs.id, id));

describe("the flag", () => {
  it("costs one boolean when it is off", async () => {
    await seedQueuedJob();
    const out = await videoTick();
    expect(out.succeeded).toBe(1);
    expect(qaEnabledMock).toHaveBeenCalled();
    expect(inspectClipMock).not.toHaveBeenCalled();
  });

  it("inspects each stored clip when it is on, with the athlete off the ROW", async () => {
    qaEnabledMock.mockReturnValue(true);
    const jobId = await seedQueuedJob();
    await videoTick();

    expect(inspectClipMock).toHaveBeenCalledTimes(1);
    const [asset] = await assetRows();
    expect(inspectClipMock.mock.calls[0][0]).toMatchObject({
      assetId: asset.id,
      // Read off the claimed row, never from a request, a client or a model.
      athleteId: ATHLETE_ID,
      // Her sentence, off the FROZEN brief.
      instruction: STATEMENT,
    });
    // The pixels the adapter returned, handed over rather than re-downloaded a line after upload.
    expect(inspectClipMock.mock.calls[0][0].bytes).toEqual(
      Buffer.from("mp4-bytes"),
    );
    expect((await readJob(jobId)).status).toBe("succeeded");
  });
});

describe("QA cannot touch the job it inspects", () => {
  it("leaves status, last_error and the lease exactly as succeedJob left them", async () => {
    qaEnabledMock.mockReturnValue(true);
    const jobId = await seedQueuedJob();
    await videoTick();

    const job = await readJob(jobId);
    expect(job.status).toBe("succeeded");
    expect(job.last_error).toBeNull();
    expect(job.lease_until).toBeNull();
    expect(job.lease_holder).toBeNull();
  });

  /**
   * ⚠️ THIS ONE IS NOT DECORATION — IT FAILS WITHOUT THE RUNNER'S OWN try/catch.
   *
   * `studio/jobs.ts` `finish()` is UNGUARDED ON STATUS: it writes whatever it is given over
   * whatever is there. So a throw after `succeedJob` but inside workJob's outer try reaches that
   * catch, which calls `failJob` — flipping a job that SUCCEEDED, whose clip is stored and whose
   * money is spent, to `failed`. She would be told "couldn't generate that" about a clip sitting in
   * her library.
   *
   * `inspectClipAsset` is written never to throw. That is a property of THAT function, and the
   * runner must not depend on it.
   */
  it("survives a QA stage that THROWS — the job stays succeeded and the clip stays stored", async () => {
    qaEnabledMock.mockReturnValue(true);
    inspectClipMock.mockRejectedValue(new Error("ffmpeg fell over"));
    const jobId = await seedQueuedJob();

    const out = await videoTick();
    expect(out.succeeded).toBe(1);
    expect(out.failed).toBe(0);

    const job = await readJob(jobId);
    expect(job.status).toBe("succeeded");
    expect(job.last_error).toBeNull();
    expect(await assetRows()).toHaveLength(1);
  });
});

/**
 * ⭐⭐ REVERT CHECK `qa-before-succeed-double-records`.
 *
 * MUTATION: in videoRunner.ts, move the `if (creativeQaEnabled())` block ABOVE
 * `await succeedJob(...)`.
 *
 * ─── ⚠️  THE FIRST VERSION OF THIS TEST DID NOT RED UNDER THAT MUTATION, AND THE REASON MATTERS ─
 *
 * It expired the lease inside the QA mock and then called the reaper AFTERWARDS, sequentially. That
 * proves nothing: with QA moved up, `succeedJob` still runs microseconds later in the same tick, so
 * by the time a sequential reaper looks the job is already terminal either way. The test passed
 * under its own mutation — the exact failure the repo has a memo about.
 *
 * The hazard is CONCURRENT by nature: it needs ANOTHER INSTANCE's reaper to run while this instance
 * is still inside QA. So the mock now does that — it expires the lease AND reaps AND ticks, from
 * inside the QA stage, which is precisely "a second instance noticed the lapse while the first was
 * busy". PGlite serialises transactions, so this is deterministic rather than a race the suite hopes
 * to hit.
 *
 * ASSERTED AS A ROW COUNT OF 2, and on both rows carrying the SAME generation_job_id — so a red for
 * any other reason (the mock threw, nothing was claimed, a different job appeared) cannot be
 * mistaken for this one.
 */
describe("qa-before-succeed-double-records", () => {
  /** Stops the re-entrant tick from running QA again and recursing. */
  let insideQa = false;

  /**
   * The QA stage, standing in for one that outlived its lease on a multi-instance deployment: the
   * lease lapses, and a DIFFERENT instance's tick reaps and claims while this one is still working.
   */
  const qaThatOutlivesItsLease = (jobId: string) =>
    inspectClipMock.mockImplementation(async () => {
      if (insideQa) return null;
      insideQa = true;
      try {
        await expireLease(jobId);
        await reapExpiredLeases();
        await videoTick();
      } finally {
        insideQa = false;
      }
      return null;
    });

  it("one clip, ONE row — even when another instance reaps while QA is running", async () => {
    qaEnabledMock.mockReturnValue(true);
    const jobId = await seedQueuedJob();
    qaThatOutlivesItsLease(jobId);

    const out = await videoTick();
    expect(out.succeeded).toBe(1);
    expect(inspectClipMock).toHaveBeenCalled();

    // ─── THE ASSERTION THAT IS THE POINT ───
    // Correct order: QA runs after succeedJob, so the job is already terminal when the other
    // instance looks — its reaper's `status='running'` predicate excludes the row whatever the
    // lease says, and there is nothing to claim.
    const rows = await assetRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].generation_job_id).toBe(jobId);
    // And the provider was polled once, because the operation was never resumed.
    expect(pollMock).toHaveBeenCalledTimes(1);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it("the hazard is REAL: the same lapse before the job is terminal DOES requeue it", async () => {
    // The control. Without it, "nothing was requeued" could be true because the reaper never works
    // in this harness at all, and the check above would prove nothing. Here the lease lapses while
    // the job is still `running` — precisely the window QA would sit in under the mutation — and
    // the reaper does exactly what the ordering exists to keep it away from.
    const jobId = await seedQueuedJob();
    // A GenerationError with code "timeout", not a plain Error carrying a `code` property: workJob
    // narrows with `instanceof`, so a look-alike takes the failJob arm and the control would be
    // setting up the wrong state. (It did, on the first run of this file.)
    pollMock.mockRejectedValueOnce(
      new GenerationError("Veo operation unfinished", "timeout", "vertex"),
    );
    await videoTick();
    expect((await readJob(jobId)).status).toBe("running");

    await expireLease(jobId);
    const reaped = await reapExpiredLeases();
    expect(reaped.requeued).toBe(1);
    expect((await readJob(jobId)).provider_operation_name).toBe(OPERATION);
  });
});

/**
 * ⭐⭐ REVERT CHECK `record-only-no-auto-reroll`.
 *
 * MUTATION: make the runner act on a failing verdict — re-submit, or open a second job row.
 *
 * WHY IT IS A MONEY RULE AND NOT A PRODUCT PREFERENCE: `spentTodayUsd` sums cost_estimated_usd over
 * generation_jobs and the quote is BANKED AT INSERT. A re-roll that reused this row would spend a
 * second $1.20 the rolling 24-hour ceiling never sees — the exact failure that cap exists to
 * prevent, and one no amount of care inside the runner can undo, because the ledger was never told.
 */
describe("record-only-no-auto-reroll", () => {
  it("a FAILING verdict buys nothing: one submit, one job row, one asset", async () => {
    qaEnabledMock.mockReturnValue(true);
    // The worst thing the stage can say. The runner discards the return value by design.
    inspectClipMock.mockResolvedValue({
      subject: "clip",
      overall: "fail",
      clip: {
        coverage: { checked: 3, scanned: 24, total: 145 },
        motionless: false,
        frames: [],
        reroll: {
          shotType: "identity",
          reasons: [{ check: "anatomy", atSec: 2, summary: "three hands" }],
          quoteUsd: 1.6,
          acted: false,
        },
      },
    });

    const jobId = await seedQueuedJob();
    const out = await videoTick();
    expect(out.succeeded).toBe(1);

    // Nothing was bought.
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(pollMock).toHaveBeenCalledTimes(1);
    // Nothing was opened. A re-roll is a NEW preview, a NEW approval and a NEW row, started from
    // the client — jobs.ts:174, "a failed job stays failed".
    expect(await db.select().from(generationJobs)).toHaveLength(1);
    expect(await assetRows()).toHaveLength(1);
    // And the job it inspected is still the success it was.
    expect((await readJob(jobId)).status).toBe("succeeded");
  });

  it("a second tick after a failing verdict still claims nothing", async () => {
    // The follow-up that would catch an "act on it next tick" implementation, which a
    // single-tick assertion would miss.
    qaEnabledMock.mockReturnValue(true);
    inspectClipMock.mockResolvedValue({ subject: "clip", overall: "fail" });
    await seedQueuedJob();
    await videoTick();
    const second = await videoTick();
    expect(second.claimed).toBe(0);
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(await db.select().from(generationJobs)).toHaveLength(1);
  });
});

// ─── The import graph ───────────────────────────────────────────────────────────────────────────

describe("what importing the runner costs", () => {
  /**
   * ⚠️ THIS EXISTS BECAUSE IT ALREADY HAPPENED, in the first draft of this very commit.
   *
   * A STATIC `import { inspectClipAsset } from "./qa/inspectClip"` reaches
   * qa/inspectClip -> qa/videoClip -> qa/identity -> qa/embed -> lib/mediaEmbed — and that module
   * runs `new Storage().bucket(BUCKET)` AT MODULE LOAD. Importing the runner therefore built a GCS
   * client, which threw in videoRunner.dispatch.test.ts (a suite about provider dispatch, which has
   * no reason to mock cloud storage) and took the whole jest worker down with it: "CRASHED (exit 1)
   * — no JSON report produced".
   *
   * Two things are wrong with that and only one is the crash. The other is that the stage sits
   * behind a flag which is OFF by default, so every instance was paying to load the module graph of
   * something that never runs.
   *
   * The walk below is the same shape stitchRunner.test.ts uses for its "no spend surface" guard,
   * narrowed to STATIC specifiers — `await import(...)` is deliberately NOT followed, because
   * deferring the cost is exactly the fix being pinned.
   */
  const SERVER = join(__dirname, "..");
  const REPO = join(SERVER, "..");
  const code = (src: string) =>
    src
      .replace(/^\s*\/\*[\s\S]*?\*\//gm, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  /** STATIC only: `from "…"` and a bare `import "…"`. Never `import("…")` or `require("…")`. */
  const STATIC_RE =
    /\bfrom\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

  function staticReach(entry: string): Set<string> {
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      let src: string;
      try {
        src = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const m of code(src).matchAll(STATIC_RE)) {
        const s = m[1] ?? m[2];
        if (!s?.startsWith(".")) continue;
        const stem = resolve(dirname(file), s.replace(/\.js$/, ""));
        const hit = [`${stem}.ts`, `${stem}.tsx`, join(stem, "index.ts")].find(
          (c) => existsSync(c),
        );
        if (hit) stack.push(hit);
      }
    }
    return new Set([...seen].map((f) => relative(REPO, f)));
  }

  it("the walk can see a deep import, so an empty answer means something", () => {
    // The control, exactly as the stitch guard has one: if the walk found nothing at all, every
    // assertion below would pass vacuously.
    const from = staticReach(join(SERVER, "studio", "videoRunner.ts"));
    expect(from).toContain("server/studio/videoJobs.ts");
    expect(from).toContain("server/studio/config.ts");
  });

  it("does not STATICALLY import the clip QA stage — the property the crash taught", () => {
    // Depth 1, deliberately, and the transitive graph is the wrong question. `lib/mediaEmbed` is
    // ALREADY reachable from here through generate.ts -> qa/inspect, and has been since long
    // before this card — that path is fine because every suite that exercises the runner mocks
    // `./generate`. What broke was that a static `./qa/inspectClip` was a SECOND path to the same
    // module, and that one nothing mocked. So the property worth pinning is the direct edge.
    const src = readFileSync(join(SERVER, "studio", "videoRunner.ts"), "utf8");
    expect(src).not.toMatch(/\bfrom\s*["']\.\/qa\/inspectClip["']/);
  });

  it("loads it dynamically instead, inside the flag check", () => {
    // The positive half. With STUDIO_CREATIVE_QA off — the default — none of qa/ beyond record.ts
    // is loaded at all, which is right for a stage that never runs.
    const src = readFileSync(join(SERVER, "studio", "videoRunner.ts"), "utf8");
    expect(src).toMatch(
      /await import\(\s*["']\.\/qa\/inspectClip\.js["']\s*\)/,
    );
  });

  it("the only qa/ module it loads eagerly is the one that answers the flag", () => {
    // Its own direct imports, not the transitive closure — see above.
    const src = readFileSync(join(SERVER, "studio", "videoRunner.ts"), "utf8");
    const direct = [...src.matchAll(/\bfrom\s*["'](\.[^"']+)["']/g)].map(
      (m) => m[1],
    );
    expect(direct.filter((s) => s.includes("/qa/"))).toEqual(["./qa/record"]);
  });
});
