/**
 * videoJobs.test.ts — the lease, the handoff, and the two ways a job must never cost twice.
 *
 * PGlite, so SKIP LOCKED, the partial unique index and the status CHECK are real Postgres rather
 * than a simulation. These are the money-safety properties of A6.1 and each one is written to FAIL
 * if its guard is removed:
 *
 *   1. Two runners ticking at once never claim the same job.            (SKIP LOCKED)
 *   2. A handoff RESUMES POLLING and never re-submits.                  (provider_operation_name)
 *   3. A job that died inside submit fails closed.                      (the orphan window)
 *   4. One approval is consumed once per tap, however many taps land.   (consumed_at — the guard
 *      that already existed, pinned here because the runner must not weaken it)
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { readFileSync } from "fs";
import { join } from "path";
import { eq, sql } from "drizzle-orm";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import { athletes, generationJobs, mediaAssets, studioGenerationPreviews } from "../../shared/schema";
import {
  claimVideoJobs, queueJob, renewLease, recordSubmitAttempt, recordOperationName,
  reapExpiredLeases, clearLease, clearOperationName, notePoll, leaseMs, maxAttempts,
} from "./videoJobs";
import { consumePreview } from "./previewStore";

const ATHLETE_ID = "11111111-2222-4333-8444-555555555555";

beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values({ id: ATHLETE_ID, full_name: "Lease Test Athlete" } as never);
});
afterAll(async () => { await closeTestDb(); });

beforeEach(async () => {
  // Previews first: consumed_by_job_id is an FK back onto generation_jobs.
  await db.delete(studioGenerationPreviews);
  await db.delete(generationJobs);
});

/** A video job sitting in `pending`, as the request leaves it before queueing. */
async function seedJob(over: Record<string, unknown> = {}): Promise<string> {
  const [row] = await db.insert(generationJobs).values({
    athlete_id: ATHLETE_ID,
    origin: "system", mode: "generate", objective: "grow-following", deliverable: "clip",
    brief: { job: { mode: "generate" } }, status: "pending",
    provider: "vertex", model: "veo-3.1-generate-001",
    cost_estimated_usd: "1.6", cost_basis: "estimated",
    ...over,
  } as never).returning({ id: generationJobs.id });
  return row.id;
}

const readJob = async (id: string) =>
  (await db.select().from(generationJobs).where(eq(generationJobs.id, id)))[0];

/** Force a lease into the past without waiting for it — the instance-died simulation. */
const expireLease = (id: string) =>
  db.update(generationJobs)
    .set({ lease_until: new Date(Date.now() - 1000) })
    .where(eq(generationJobs.id, id));

// ─── 1. Two runners can never claim one job ─────────────────────────────────────────────────────

describe("claim", () => {
  /**
   * ⚠️  WHAT THIS SUITE CANNOT PROVE, STATED PLAINLY.
   *
   * PGlite is a SINGLE-CONNECTION Postgres, so two `claimVideoJobs` calls in a `Promise.all` are
   * serialised by the driver — they are never two concurrent transactions. This suite therefore
   * cannot exercise a genuine row-lock race, and removing `SKIP LOCKED` does NOT make the test
   * below fail (verified by reverting it).
   *
   * What the behavioural test DOES prove is the half that lives in application logic: the claim is
   * predicated on `status = 'queued'`, so a job already taken is not taken again. That is the part a
   * refactor is likely to break.
   *
   * The `SKIP LOCKED` clause itself is pinned by the source assertion at the end of this block —
   * weaker than a behavioural test and honest about being so. It is the same posture
   * approval.test.ts takes when it asserts migration 0027 still embeds generationGuards.sql
   * verbatim: some guarantees can only be pinned structurally, and pinning them structurally beats
   * pretending a test covers them.
   */
  it("gives one job to exactly one of two runners racing for it", async () => {
    const jobId = await seedJob();
    await queueJob(jobId, ATHLETE_ID);

    // Serialised by PGlite, so this asserts the `status = 'queued'` predicate, not the row lock.
    const [a, b] = await Promise.all([
      claimVideoJobs(10, "instance-a"),
      claimVideoJobs(10, "instance-b"),
    ]);

    const claimedIds = [...a, ...b].map((j) => j.id);
    expect(claimedIds).toEqual([jobId]);             // exactly one claim, not two
    expect(a.length + b.length).toBe(1);

    const row = await readJob(jobId);
    expect(row.status).toBe("running");
    expect(row.attempts).toBe(1);                    // counted once, not twice
    expect(["instance-a", "instance-b"]).toContain(row.lease_holder);
  });

  it("never claims a job that is merely pending — the request must queue it first", async () => {
    const jobId = await seedJob();                   // still 'pending'
    expect(await claimVideoJobs(10, "instance-a")).toEqual([]);
    expect((await readJob(jobId)).status).toBe("pending");
  });

  it("does not hand a running job to a second runner while the lease is live", async () => {
    const jobId = await seedJob();
    await queueJob(jobId, ATHLETE_ID);
    await claimVideoJobs(10, "instance-a");
    expect(await claimVideoJobs(10, "instance-b")).toEqual([]);
  });

  it("refuses to renew a lease the caller no longer holds", async () => {
    const jobId = await seedJob();
    await queueJob(jobId, ATHLETE_ID);
    await claimVideoJobs(10, "instance-a");
    expect(await renewLease(jobId, "instance-a")).toBe(true);
    expect(await renewLease(jobId, "instance-b")).toBe(false);
  });

  it("still claims with FOR UPDATE SKIP LOCKED", () => {
    // The one guarantee this harness cannot reach behaviourally (see the note above): with three
    // Cloud Run instances on a real Postgres, `SKIP LOCKED` is what lets two ticks claim DIFFERENT
    // rows instead of one blocking behind the other. Dropping it does not corrupt anything — the
    // `status = 'queued'` predicate still prevents a double claim — but it turns the queue
    // serial under load, which is a silent throughput regression no behavioural test here would see.
    const src = readFileSync(join(__dirname, "videoJobs.ts"), "utf8");
    expect(src).toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  it("keeps the lease longer than one provider HTTP timeout, so a SLOW submit is not read as a dead one", () => {
    // The orphan rule fires on (submit attempted, no handle). If the lease could lapse inside a
    // legitimate submit call, a healthy slow request would be failed as an orphan.
    expect(leaseMs()).toBeGreaterThan(Number(process.env.STUDIO_HTTP_TIMEOUT_MS ?? 120_000));
  });
});

// ─── 2. A handoff resumes polling — it never re-submits ─────────────────────────────────────────

describe("two ticks, two owners (PR 9, Lane 4 — rider 1)", () => {
  /** ⚠️ MUTATION: drop `mode <> 'edit'` from claimVideoJobs — this reds by name. */
  it("the video claim never takes an edit-mode job — that is the edit tick's, and only its", async () => {
    const video = await seedJob();
    await queueJob(video, ATHLETE_ID);
    // An edit job names its frame (generation_jobs_edit_needs_source), as the batch's jobs do.
    const [photo] = await db
      .insert(mediaAssets)
      .values({ athlete_id: ATHLETE_ID, platform: "upload", origin: "upload", media_type: "IMAGE", status: "stored", gcs_path: "athletes/x/uploads/edit-seed.png" } as never)
      .returning({ id: mediaAssets.id });
    const edit = await seedJob({ mode: "edit", source_asset_id: photo.id });
    await queueJob(edit, ATHLETE_ID);
    const claimed = await claimVideoJobs(10, "instance-a");
    expect(claimed.map((j) => j.id)).toEqual([video]);
    const [left] = await db.select().from(generationJobs).where(eq(generationJobs.id, edit));
    expect(left.status).toBe("queued");
  });
});

describe("handoff", () => {
  it("returns a dead runner's job to the queue WITH the operation name, so the next one polls instead of paying again", async () => {
    const jobId = await seedJob();
    await queueJob(jobId, ATHLETE_ID);

    // Runner A claims it and submits.
    await claimVideoJobs(10, "instance-a");
    await recordSubmitAttempt(jobId, "instance-a");
    await recordOperationName(jobId, "projects/p/locations/us-central1/operations/op-1");

    // A dies mid-poll.
    await expireLease(jobId);
    const reaped = await reapExpiredLeases();
    expect(reaped).toEqual({ orphaned: 0, exhausted: 0, requeued: 1 });

    const afterReap = await readJob(jobId);
    expect(afterReap.status).toBe("queued");
    // THE PROPERTY THAT MATTERS: the handle survives, so the work already paid for is collectable.
    expect(afterReap.provider_operation_name).toBe("projects/p/locations/us-central1/operations/op-1");
    expect(afterReap.lease_holder).toBeNull();

    // Runner B picks it up and finds the operation waiting for it.
    const [taken] = await claimVideoJobs(10, "instance-b");
    expect(taken.id).toBe(jobId);
    expect(taken.provider_operation_name).toBe("projects/p/locations/us-central1/operations/op-1");
    expect(taken.attempts).toBe(2);                  // second claim, still one submit
  });

  it("lets only the first submit record its handle — the loser is told it did not win", async () => {
    const jobId = await seedJob();
    await queueJob(jobId, ATHLETE_ID);
    await claimVideoJobs(10, "instance-a");

    expect(await recordOperationName(jobId, "op-first")).toBe(true);
    expect(await recordOperationName(jobId, "op-second")).toBe(false);

    // The winner's handle is the one that stands — a second submit cannot overwrite it.
    expect((await readJob(jobId)).provider_operation_name).toBe("op-first");
  });

  it("refuses two jobs sharing one operation name, at the database level", async () => {
    const a = await seedJob();
    const b = await seedJob();
    await db.update(generationJobs).set({ provider_operation_name: "op-shared" }).where(eq(generationJobs.id, a));
    // The partial unique index holds even against a write that bypasses recordOperationName.
    await expect(
      db.update(generationJobs).set({ provider_operation_name: "op-shared" }).where(eq(generationJobs.id, b)),
    ).rejects.toThrow();
  });

  it("leaves many NULL operation names alone — the unique index must be partial", async () => {
    await seedJob(); await seedJob(); await seedJob();
    const rows = await db.select().from(generationJobs);
    expect(rows.every((r) => r.provider_operation_name === null)).toBe(true);
  });
});

// ─── 3. The orphan window fails closed ──────────────────────────────────────────────────────────

describe("orphan window", () => {
  it("FAILS a job whose runner died inside the submit call, and never re-queues it", async () => {
    const jobId = await seedJob();
    await queueJob(jobId, ATHLETE_ID);
    await claimVideoJobs(10, "instance-a");

    // Submit was entered; the instance died before a handle came back.
    await recordSubmitAttempt(jobId, "instance-a");
    await expireLease(jobId);

    const reaped = await reapExpiredLeases();
    expect(reaped.orphaned).toBe(1);
    expect(reaped.requeued).toBe(0);                 // NOT returned to the queue

    const row = await readJob(jobId);
    expect(row.status).toBe("failed");               // fail closed, so it can never be re-submitted
    expect(row.last_error).toMatch(/charge twice/i);
    expect(await claimVideoJobs(10, "instance-b")).toEqual([]);
  });

  it("fails the orphan even when attempts remain — the order of the reaper's checks is the policy", async () => {
    const jobId = await seedJob();
    await queueJob(jobId, ATHLETE_ID);
    await claimVideoJobs(10, "instance-a");          // attempts = 1, well under the cap
    await recordSubmitAttempt(jobId, "instance-a");
    await expireLease(jobId);

    await reapExpiredLeases();
    // If the requeue arm ran first this would be 'queued' and a paid-for submit would be retried.
    expect((await readJob(jobId)).status).toBe("failed");
  });

  it("does NOT treat a job that died before submitting as an orphan — that one is safe to retry", async () => {
    const jobId = await seedJob();
    await queueJob(jobId, ATHLETE_ID);
    await claimVideoJobs(10, "instance-a");          // claimed, but submit never entered
    await expireLease(jobId);

    const reaped = await reapExpiredLeases();
    expect(reaped.orphaned).toBe(0);
    expect(reaped.requeued).toBe(1);
    expect((await readJob(jobId)).status).toBe("queued");
  });

  it("gives up on a job that has been handed round too many times", async () => {
    const jobId = await seedJob({ attempts: maxAttempts() });
    await queueJob(jobId, ATHLETE_ID);
    await claimVideoJobs(10, "instance-a");
    await expireLease(jobId);

    const reaped = await reapExpiredLeases();
    expect(reaped.exhausted).toBe(1);
    expect((await readJob(jobId)).status).toBe("failed");
  });

  it("leaves a live lease alone", async () => {
    const jobId = await seedJob();
    await queueJob(jobId, ATHLETE_ID);
    await claimVideoJobs(10, "instance-a");          // lease is in the future
    expect(await reapExpiredLeases()).toEqual({ orphaned: 0, exhausted: 0, requeued: 0 });
    expect((await readJob(jobId)).status).toBe("running");
  });

  it("ignores a finished job whose lease was cleared", async () => {
    const jobId = await seedJob();
    await queueJob(jobId, ATHLETE_ID);
    await claimVideoJobs(10, "instance-a");
    await clearLease(jobId);
    await db.update(generationJobs).set({ status: "succeeded" }).where(eq(generationJobs.id, jobId));
    expect(await reapExpiredLeases()).toEqual({ orphaned: 0, exhausted: 0, requeued: 0 });
  });
});

// ─── 4. The approval is still claimed exactly once ──────────────────────────────────────────────

describe("consume, across the detached path", () => {
  async function seedPreview(): Promise<string> {
    const [row] = await db.insert(studioGenerationPreviews).values({
      athlete_id: ATHLETE_ID, brief: { job: {} }, plan: {},
      cost_usd: "1.6", cost_basis: "estimated", unpriced: false, status: "ready",
      expires_at: new Date(Date.now() + 30 * 60_000),
    } as never).returning({ id: studioGenerationPreviews.id });
    return row.id;
  }

  it("lets exactly one of two simultaneous taps claim the approval", async () => {
    const previewId = await seedPreview();
    const jobA = await seedJob();
    const jobB = await seedJob();

    const [a, b] = await Promise.all([
      consumePreview(ATHLETE_ID, previewId, jobA),
      consumePreview(ATHLETE_ID, previewId, jobB),
    ]);

    expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1);
    const loser = a.claimed ? b : a;
    expect(loser.claimed).toBe(false);
    // The loser is handed the WINNER's job, so both taps answer with one job and one charge.
    expect([jobA, jobB]).toContain((loser as { jobId: string | null }).jobId);
  });

  it("stays consumed across a lease handoff — a second runner has nothing left to claim", async () => {
    const previewId = await seedPreview();
    const jobId = await seedJob();

    // The REQUEST consumes, before the job is ever queued.
    expect((await consumePreview(ATHLETE_ID, previewId, jobId)).claimed).toBe(true);
    await queueJob(jobId, ATHLETE_ID);

    // Runner A claims and dies; runner B takes over.
    await claimVideoJobs(10, "instance-a");
    await expireLease(jobId);
    await reapExpiredLeases();
    await claimVideoJobs(10, "instance-b");

    // The approval was never released by the handoff, and cannot be spent a second time.
    const again = await consumePreview(ATHLETE_ID, previewId, jobId);
    expect(again.claimed).toBe(false);
    const [row] = await db.select().from(studioGenerationPreviews).where(eq(studioGenerationPreviews.id, previewId));
    expect(row.consumed_by_job_id).toBe(jobId);
  });
});

// ─── Bookkeeping ────────────────────────────────────────────────────────────────────────────────

it("counts polls without touching the lease", async () => {
  const jobId = await seedJob();
  await queueJob(jobId, ATHLETE_ID);
  await claimVideoJobs(10, "instance-a");
  const before = await readJob(jobId);
  await notePoll(jobId); await notePoll(jobId);
  const after = await readJob(jobId);
  expect(after.poll_count).toBe(2);
  expect(after.last_polled_at).not.toBeNull();
  expect(after.lease_until?.getTime()).toBe(before.lease_until?.getTime());
});

it("rejects a status the state machine does not have", async () => {
  const jobId = await seedJob();
  await expect(
    db.execute(sql`UPDATE generation_jobs SET status = 'leased' WHERE id = ${jobId}`),
  ).rejects.toThrow();
});

// ─── Giving a handle BACK, which is the one hole cut in submit-once ─────────────────────────────

describe("clearOperationName — the narrowest possible undo", () => {
  const OP = "projects/p/locations/us-central1/operations/op-1";

  /** A job claimed by `holder` and carrying `OP`, which is the only state this may act on. */
  async function submittedJob(holder = "instance-a"): Promise<string> {
    const jobId = await seedJob();
    await queueJob(jobId, ATHLETE_ID);
    await claimVideoJobs(10, holder);
    await recordSubmitAttempt(jobId, holder);
    await recordOperationName(jobId, OP);
    return jobId;
  }

  it("clears a handle its own holder wrote, and lets a second submit through", async () => {
    const jobId = await submittedJob();

    expect(await clearOperationName(jobId, "instance-a", OP)).toBe(true);
    expect((await readJob(jobId)).provider_operation_name).toBeNull();

    // The whole point: recordOperationName's `IS NULL` guard opens again for exactly one more write.
    expect(await recordOperationName(jobId, "operations/op-2")).toBe(true);
    expect((await readJob(jobId)).provider_operation_name).toBe("operations/op-2");
  });

  /**
   * ⚠️ THE CLAUSE THAT STOPS A PAID OPERATION BEING ORPHANED.
   *
   * Without `provider_operation_name = expected`, a slow runner could clear a handle that another
   * runner had just recorded — and THAT operation, already submitted and already billed, would be
   * left at the provider with nothing pointing at it. Nobody would ever poll it or store its clip.
   */
  it("refuses to clear a handle that is no longer the one we wrote", async () => {
    const jobId = await submittedJob();
    // Somebody else's handle is on the row now.
    await db.update(generationJobs)
      .set({ provider_operation_name: "operations/someone-elses" })
      .where(eq(generationJobs.id, jobId));

    expect(await clearOperationName(jobId, "instance-a", OP)).toBe(false);
    // Untouched — theirs is still collectable.
    expect((await readJob(jobId)).provider_operation_name).toBe("operations/someone-elses");
  });

  it("refuses when the lease has moved to another holder", async () => {
    const jobId = await submittedJob("instance-a");

    expect(await clearOperationName(jobId, "instance-b", OP)).toBe(false);
    expect((await readJob(jobId)).provider_operation_name).toBe(OP);
  });

  it("refuses on a job that is no longer running", async () => {
    const jobId = await submittedJob();
    await db.update(generationJobs)
      .set({ status: "succeeded" })
      .where(eq(generationJobs.id, jobId));

    expect(await clearOperationName(jobId, "instance-a", OP)).toBe(false);
    expect((await readJob(jobId)).provider_operation_name).toBe(OP);
  });

  it("does not disturb the lease it checked — the runner still holds the job", async () => {
    const jobId = await submittedJob();
    await clearOperationName(jobId, "instance-a", OP);

    const job = await readJob(jobId);
    expect(job.lease_holder).toBe("instance-a");
    expect(job.status).toBe("running");
  });
});
