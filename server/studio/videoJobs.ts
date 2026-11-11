/**
 * studio/videoJobs — the lease, and the guard that makes a lease handoff free.
 *
 * Image generation runs INLINE in the request and never comes near this file. Video cannot: the
 * spike measured Veo at ~63s for an 8s clip and studio/config.ts already permits polling for 600s,
 * so `POST /studio/generate` queues the job and returns, and a leased runner works it afterwards
 * (studio/videoRunner.ts). That is a new execution model, and it reopens a hazard the inline path
 * never had — which is what everything below exists to close.
 *
 * ─── THREE GUARDS, THREE DIFFERENT HAZARDS. NONE SUBSTITUTES FOR ANOTHER ────────────────────────
 *
 *   the client double-taps Generate   → studio_generation_previews.consumed_at   (already existed)
 *   two runners claim the same job    → FOR UPDATE SKIP LOCKED + lease_until     (here)
 *   one job is submitted twice        → provider_operation_name + unique index   (here)
 *
 * The approval guard protects the ATHLETE'S AUTHORIZATION and is claimed once per tap, in the
 * request, before a job is ever queued. It cannot help here: by the time a runner sees the row,
 * `consumed_at` is already set, so a second runner meets nothing left to claim — and would happily
 * call the provider anyway. That is a different hazard and it needs the third guard.
 *
 * ─── WHY THE LEASE PROTECTS THE POLL AND NOT THE SUBMIT ─────────────────────────────────────────
 *
 * server/workflow/runner.ts has the same claim shape and recovers from an expired lease by opening a
 * NEW ATTEMPT and re-running the step. Copying that here would double-charge — and for nothing,
 * because when our instance dies the Veo operation is STILL RUNNING AT VERTEX. Re-submitting buys a
 * second copy of a video we already own.
 *
 * So recovery is: return the row to `queued` KEEPING `provider_operation_name`, and let the next
 * runner resume polling that operation. One submit, one charge, however many instances die.
 *
 * ─── THE ORPHAN WINDOW, AND WHY IT FAILS CLOSED ─────────────────────────────────────────────────
 *
 * `submit_attempted_at` is written BEFORE the provider call and `provider_operation_name` AFTER it.
 * An instance that dies between them leaves (attempted, no name): Vertex may or may not have been
 * paid, and we have no handle either way. That job is FAILED, never re-submitted. At most one paid
 * call, never two. The cost is a rare false failure when the submit never actually left the box —
 * she re-runs, which is a new preview and a new cost line, and that is honest. The alternative
 * (re-submit and hope) recovers the rare orphan by risking a double charge every time it happens,
 * which is the wrong direction for this codebase's whole spend posture.
 *
 * ─── TENANCY: THIS IS THE ONE MODULE THAT IS NOT ATHLETE-SCOPED, DELIBERATELY ───────────────────
 *
 * A runner is a SYSTEM consumer of a queue spanning every athlete, so `claimVideoJobs` has no
 * `athlete_id` predicate — it cannot have one and still be a queue. That is safe because it never
 * takes an athlete id from anywhere: every row it claims already carries its own `athlete_id`, and
 * studio/videoRunner.ts reads the athlete off the CLAIMED ROW and passes that to every write. No
 * request, model or client ever supplies it. The athlete-scoped reads (the job route, the asset
 * list) are unchanged and still filter by `req.athleteId`.
 */
import { and, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import { generationJobs, type GenerationJob } from "../../shared/schema";
import { httpTimeoutMs } from "./config";
import { createLogger } from "../logger";

const logger = createLogger("studio/videoJobs");

/**
 * How long a claim is good for.
 *
 * ⚠️  THIS MUST EXCEED `httpTimeoutMs()`, AND THAT IS NOT A STYLE PREFERENCE. The submit call may
 * legitimately take up to the HTTP timeout (120s by default). If the lease could lapse while a
 * healthy instance was still inside that call, the reaper would see (attempted, no name) on a job
 * whose submit was merely SLOW and fail it as an orphan — turning a working generation into a
 * refusal. Derived rather than hardcoded so raising STUDIO_HTTP_TIMEOUT_MS cannot silently
 * reintroduce that.
 */
export const leaseMs = () => Math.max(180_000, httpTimeoutMs() + 60_000);

/**
 * How many times one job may be claimed before it is given up on. Bounds a reclaim loop: a job that
 * makes an instance die every time would otherwise be handed round forever.
 */
export const maxAttempts = () => Number(process.env.STUDIO_VIDEO_MAX_ATTEMPTS ?? 5);

/** pg returns `{rows}`; PGlite returns the array. Both drivers, one reader — as workflow/runner does. */
const rowsOf = <T>(res: unknown): T[] => ((res as { rows?: T[] })?.rows ?? res) as T[];

/**
 * pending → queued. The last thing the REQUEST does for a video job.
 *
 * Guarded on `pending` so it is idempotent under a retry and cannot resurrect a job that already
 * ran, failed or was canceled.
 */
export async function queueJob(jobId: string, athleteId: string): Promise<boolean> {
  const out = await db.update(generationJobs)
    .set({ status: "queued", updated_at: new Date() })
    .where(and(
      eq(generationJobs.id, jobId),
      eq(generationJobs.athlete_id, athleteId),
      eq(generationJobs.status, "pending"),
    ))
    .returning({ id: generationJobs.id });
  if (!out.length) logger.warn({ jobId }, "job was not pending — not queued");
  return out.length > 0;
}

/**
 * Atomically move up to `limit` queued jobs to `running` under a lease.
 *
 * SKIP LOCKED is the mutex: three instances ticking at the same instant never claim the same row,
 * because a row another transaction holds is passed over rather than waited for. `attempts` is
 * incremented HERE — at the claim — so a job that dies mid-run still counts its try and cannot be
 * reclaimed forever.
 *
 * NOT athlete-scoped. See the tenancy note in this file's header before adding a predicate.
 */
/**
 * ⚠️ NEVER AN EDIT JOB. The ad carousel's batch rows (studio/edit/batch.ts) queue `mode = 'edit'` jobs
 * for THEIR tick; this claim takes every other queued job. Two ticks, two owners, no overlap — the
 * stitch-tick double-fire is the standing lesson (PR 9, Lane 4, rider 1).
 */
export async function claimVideoJobs(limit: number, holder: string): Promise<GenerationJob[]> {
  const now = new Date();
  const until = new Date(now.getTime() + leaseMs());
  const res = await db.execute(sql`
    UPDATE generation_jobs
       SET status = 'running',
           lease_until = ${until},
           lease_holder = ${holder},
           attempts = attempts + 1,
           started_at = COALESCE(started_at, ${now}),
           updated_at = ${now}
     WHERE id IN (
       SELECT id FROM generation_jobs
        WHERE status = 'queued'
          AND mode <> 'edit'
        ORDER BY created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
     RETURNING id`);
  const ids = rowsOf<{ id: string }>(res).map((r) => r.id);
  if (!ids.length) return [];
  // Parameterised, never interpolated — the same read-back workflow/runner.ts does after its claim.
  const jobs = await db.select().from(generationJobs).where(inArray(generationJobs.id, ids));
  logger.info({ holder, claimed: jobs.length }, "video jobs claimed");
  return jobs;
}

/**
 * Push the lease out while work is still in flight. Guarded on the HOLDER as well as the status, so
 * an instance that lost its lease to the reaper cannot silently take it back and end up polling the
 * same operation as the runner that legitimately owns it now.
 */
export async function renewLease(jobId: string, holder: string): Promise<boolean> {
  const out = await db.update(generationJobs)
    .set({ lease_until: new Date(Date.now() + leaseMs()), updated_at: new Date() })
    .where(and(
      eq(generationJobs.id, jobId),
      eq(generationJobs.lease_holder, holder),
      eq(generationJobs.status, "running"),
    ))
    .returning({ id: generationJobs.id });
  return out.length > 0;
}

/**
 * Mark that a provider submit is ABOUT to happen. Written before the call, so that an instance which
 * dies inside the call leaves evidence it was there — which is what makes the orphan window
 * detectable at all rather than looking like a job that had never started.
 */
export async function recordSubmitAttempt(jobId: string, holder: string): Promise<boolean> {
  const out = await db.update(generationJobs)
    .set({ submit_attempted_at: new Date(), updated_at: new Date() })
    .where(and(
      eq(generationJobs.id, jobId),
      eq(generationJobs.lease_holder, holder),
      eq(generationJobs.status, "running"),
    ))
    .returning({ id: generationJobs.id });
  return out.length > 0;
}

/**
 * Write the operation handle back, exactly once.
 *
 * The guard is `provider_operation_name IS NULL` INSIDE the update, so the check and the write are
 * one statement and cannot interleave. A caller that gets `false` has just discovered that another
 * runner already submitted this job — it must NOT poll its own operation and must NOT submit again;
 * it re-reads the row and polls the winner's operation instead (studio/videoRunner.ts).
 *
 * The partial unique index on this column is the same rule one layer down, where a bug or a script
 * cannot get past it.
 */
export async function recordOperationName(jobId: string, operationName: string): Promise<boolean> {
  const out = await db.update(generationJobs)
    .set({ provider_operation_name: operationName, updated_at: new Date() })
    .where(and(
      eq(generationJobs.id, jobId),
      isNull(generationJobs.provider_operation_name),
    ))
    .returning({ id: generationJobs.id });
  if (!out.length) {
    logger.warn({ jobId }, "operation name already recorded — this runner did NOT win the submit");
  }
  return out.length > 0;
}

/**
 * Give back a handle THIS runner wrote, so the same job may be submitted once more.
 *
 * ─── ⚠️  THE NARROWEST POSSIBLE UNDO, AND EVERY CLAUSE OF THE GUARD IS LOAD-BEARING ────────────
 *
 * `recordOperationName` exists to make submitting twice impossible, and this is the one hole
 * deliberately cut in it: an output-filtered clip is a completed operation whose result was
 * withheld, so re-asking means a NEW operation, which means the old handle has to go. Everything
 * about the guard is there to make sure it can only ever undo OUR OWN write:
 *
 *   id                        this job.
 *   lease_holder = holder     we still hold the lease. If it lapsed and the reaper handed the job
 *                             on, the new runner's handle is not ours to clear.
 *   status = 'running'        not a job that has since finished or failed underneath us.
 *   provider_operation_name = expected
 *                             THE EXACT HANDLE WE WROTE. Without this clause a slow runner could
 *                             clear a handle another runner had just recorded, and that operation —
 *                             paid for, in flight — would be orphaned at the provider with nothing
 *                             left pointing at it.
 *
 * A `false` return means one of those stopped being true, and the caller must treat the job as no
 * longer its business rather than submitting anyway.
 *
 * ⚠️ IT DOES NOT DECIDE ANYTHING ABOUT MONEY. Clearing a handle is what makes a second submit
 * POSSIBLE; whether one is WANTED is `retryEnabled()` and studio/refusal.ts, in the runner.
 */
export async function clearOperationName(
  jobId: string,
  holder: string,
  expected: string,
): Promise<boolean> {
  const out = await db.update(generationJobs)
    .set({ provider_operation_name: null, updated_at: new Date() })
    .where(and(
      eq(generationJobs.id, jobId),
      eq(generationJobs.lease_holder, holder),
      eq(generationJobs.status, "running"),
      eq(generationJobs.provider_operation_name, expected),
    ))
    .returning({ id: generationJobs.id });
  if (!out.length) {
    logger.warn(
      { jobId, holder },
      "operation handle was not ours to clear — standing down instead of re-submitting",
    );
  }
  return out.length > 0;
}

/** Poll bookkeeping. Best-effort: losing a counter must never fail a job that is otherwise fine. */
export async function notePoll(jobId: string): Promise<void> {
  await db.update(generationJobs)
    .set({ poll_count: sql`${generationJobs.poll_count} + 1`, last_polled_at: new Date() })
    .where(eq(generationJobs.id, jobId))
    .catch(() => {});
}

/** Release the lease on a job that has reached a terminal state, so the reaper never looks at it. */
export async function clearLease(jobId: string): Promise<void> {
  await db.update(generationJobs)
    .set({ lease_until: null, lease_holder: null, updated_at: new Date() })
    .where(eq(generationJobs.id, jobId));
}

export interface ReapResult {
  /** Died inside the submit call. Failed closed — never re-submitted. */
  orphaned: number;
  /** Claimed too many times without finishing. Given up on. */
  exhausted: number;
  /** Returned to the queue with the operation handle intact, for another runner to resume polling. */
  requeued: number;
}

/**
 * Find jobs whose holder died and decide what each one deserves. Runs at the top of every tick.
 *
 * THE ORDER OF THESE THREE IS THE POLICY, and it is deliberate: the orphan check runs FIRST, so a
 * job in the dangerous window fails closed even when it still had attempts left. Reversing them
 * would let a possibly-paid-for submit be retried, which is the one outcome this design refuses.
 */
export async function reapExpiredLeases(): Promise<ReapResult> {
  const now = new Date();
  const lapsed = and(
    eq(generationJobs.status, "running"),
    isNotNull(generationJobs.lease_until),
    sql`${generationJobs.lease_until} < ${now}`,
  );

  // 1. ORPHANS — submit was entered, no handle came back. Fail closed.
  const orphaned = await db.update(generationJobs)
    .set({
      status: "failed",
      last_error:
        "The instance generating this died while submitting it, so we can't tell whether the " +
        "provider started. We won't submit it again — that could charge twice. Run it again to retry.",
      completed_at: now, lease_until: null, lease_holder: null, updated_at: now,
    })
    .where(and(lapsed, isNotNull(generationJobs.submit_attempted_at), isNull(generationJobs.provider_operation_name)))
    .returning({ id: generationJobs.id });

  // 2. EXHAUSTED — handed round too many times. Give up rather than loop.
  const exhausted = await db.update(generationJobs)
    .set({
      status: "failed",
      last_error: `Gave up after ${maxAttempts()} attempts — this job could not be completed.`,
      completed_at: now, lease_until: null, lease_holder: null, updated_at: now,
    })
    .where(and(lapsed, sql`${generationJobs.attempts} >= ${maxAttempts()}`))
    .returning({ id: generationJobs.id });

  // 3. HANDOFF — the ordinary case. Back to the queue, OPERATION NAME KEPT, so the next runner
  //    resumes polling work that is already paid for instead of buying it again.
  const requeued = await db.update(generationJobs)
    .set({ status: "queued", lease_until: null, lease_holder: null, updated_at: now })
    .where(lapsed)
    .returning({ id: generationJobs.id });

  const out = { orphaned: orphaned.length, exhausted: exhausted.length, requeued: requeued.length };
  if (out.orphaned || out.exhausted || out.requeued) logger.warn(out, "expired video leases reaped");
  return out;
}
