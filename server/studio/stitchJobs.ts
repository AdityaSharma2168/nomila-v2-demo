/**
 * studio/stitchJobs — the lease for detached STITCH jobs. studio/videoJobs.ts's shape, minus the
 * half of it that exists because video costs money.
 *
 *   queue (in the request) · claim ≤ N · renew while working · reap what lapsed · close
 *
 * ─── WHAT IS DELIBERATELY ABSENT, AND WHY THAT IS THE DESIGN AND NOT AN OMISSION ────────────────
 *
 * videoJobs.ts carries a SUBMIT-ONCE PAIR — `submit_attempted_at` written before the provider call,
 * `provider_operation_name` after it — and a reaper whose FIRST arm fails a job that died between
 * them. Every line of that exists for one reason: a Vertex submit may have been PAID FOR, we may
 * have no handle to it, and re-submitting buys a second copy of a video we already own. Failing
 * closed is right there because the alternative risks a double charge.
 *
 * A STITCH SPENDS NOTHING. One ffmpeg call, no provider, no model, no token — studio/video/stitch.ts
 * is $0 by construction and 0057 gives this table no cost column to move. So re-running a reaped
 * stitch costs CPU and a download, and the whole orphan apparatus has nothing to protect:
 *
 *   ⚠️  THE REAPER HERE RETURNS A LAPSED JOB TO `queued`, ALWAYS. There is no orphan arm, and adding
 *   one back by reflex would convert an instance that merely died into a REFUSAL she has to notice
 *   and redo, in exchange for protecting money that was never at risk.
 *
 * `attempts` stays, because $0 is not the same as free: a timeline that kills its instance every
 * time would otherwise be handed round the fleet forever. Exhausted is the only way a lapse becomes
 * a failure.
 *
 * ─── TENANCY ────────────────────────────────────────────────────────────────────────────────────
 *
 * Same posture as videoJobs.ts, and the same single exception. `claimStitchJobs` has NO athlete
 * predicate — a runner is a system consumer of a queue spanning every athlete, and it cannot have
 * one and still be a queue. It is safe because it never TAKES an athlete id from anywhere: every
 * claimed row carries its own, studio/stitchRunner.ts reads it off the row, and
 * studio/video/materialize.ts resolves every asset id in the spec against THAT value. The
 * athlete-facing reads below (`readStitchJob`) do filter, and answer not-found for not-yours.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import { studioStitchJobs, type StudioStitchJob } from "../../shared/schema";
import { createLogger } from "../logger";

const logger = createLogger("studio/stitchJobs");

/**
 * The hard kill for one ffmpeg run, passed EXPLICITLY rather than taken from V6's default.
 *
 * ⚠️  THIS AND `leaseMs()` ARE ONE DECISION, and the ordering between them is load-bearing in both
 * directions:
 *
 *   lease SHORTER than the timeout  the reaper requeues a job that is still encoding, and a second
 *                                   runner stitches it alongside the first — two workspaces, two
 *                                   ffmpegs, one instance.
 *   lease MUCH LONGER than needed   a job whose instance died is stranded for the whole lease
 *                                   before anyone may pick it up.
 *
 * V6's `defaultTimeoutMs` scales at 15 s per output second, so a 180 s timeline would allow 45.5
 * MINUTES and force a lease longer than that. Ten minutes is ~3× realtime for the longest timeline
 * studio/video/materialize.ts will accept, on the 2 vCPUs the service has. That is a BUDGET, chosen
 * because there is no measurement of x264 veryfast throughput on a Cloud Run instance in this repo;
 * it is env-overridable, and `leaseMs` is DERIVED from it so raising one cannot silently invalidate
 * the other.
 */
export const stitchTimeoutMs = () =>
  Number(process.env.STUDIO_STITCH_TIMEOUT_MS ?? 600_000);

/**
 * The budget for ONE transfer phase — every download in the timeline together, and separately the
 * upload of the finished file. Both sit inside the same claim, so both have to be bounded by a
 * clock or the lease's ordering argument above is about the ffmpeg call alone.
 *
 * The download half is enforced by a real AbortSignal (studio/video/materialize.ts), not by
 * lib/withTimeout's race: a download whose loser keeps running writes into a workspace that has
 * already been deleted, and on tmpfs those pages are not reclaimed while the descriptor is open.
 */
export const transferTimeoutMs = () =>
  Number(process.env.STUDIO_STITCH_TRANSFER_MS ?? 300_000);

/**
 * How long a claim is good for: the ffmpeg budget PLUS both transfer phases, because all three
 * happen inside one claim. Derived rather than written down, so that raising any of the three
 * cannot leave the lease shorter than the work it is supposed to cover — the failure at the top of
 * the ordering note above.
 */
export const leaseMs = () => stitchTimeoutMs() + 2 * transferTimeoutMs();

/** How many times one stitch may be claimed before it is given up on. Bounds the reclaim loop. */
export const maxAttempts = () =>
  Number(process.env.STUDIO_STITCH_MAX_ATTEMPTS ?? 3);

/** pg returns `{rows}`; PGlite returns the array. Both drivers, one reader — as videoJobs does. */
const rowsOf = <T>(res: unknown): T[] =>
  ((res as { rows?: T[] })?.rows ?? res) as T[];

/**
 * Queue a stitch. The whole of what the REQUEST does.
 *
 * Born `queued`, never `pending`: there is no inline path for a stitch, so the state video uses to
 * mean "the request is still deciding" has nothing to describe here (0057's CHECK does not permit
 * it). The athlete comes from `req.athleteId` at the only place it can — the route.
 */
export async function queueStitch(
  athleteId: string,
  spec: unknown,
): Promise<string> {
  return (await queueStitchJob(athleteId, spec)).id;
}

/**
 * queueStitch, answering also WHEN the row was queued by the DATABASE's clock — so a caller that
 * later compares against the row's created_at (the post-kit preview render's superseded check,
 * agent/postKit/render/worker.ts) compares one clock with itself.
 */
export async function queueStitchJob(
  athleteId: string,
  spec: unknown,
): Promise<{ id: string; createdAt: string }> {
  const [row] = await db
    .insert(studioStitchJobs)
    .values({ athlete_id: athleteId, spec, status: "queued" } as never)
    .returning({ id: studioStitchJobs.id, created_at: studioStitchJobs.created_at });
  logger.info({ athleteId, stitchId: row.id }, "stitch queued");
  return { id: row.id, createdAt: new Date(row.created_at).toISOString() };
}

/**
 * Cancel a row nobody has claimed yet — a post-kit preview render whose request did not end up
 * pointing the kit at it. Only while still `queued`, and only the athlete's own: a claimed row is
 * the worker's to close (it checks the kit itself before any byte moves).
 */
export async function cancelQueuedStitch(
  athleteId: string,
  jobId: string,
  message: string,
): Promise<boolean> {
  const now = new Date();
  const out = await db
    .update(studioStitchJobs)
    .set({ status: "canceled", last_error: message, completed_at: now, updated_at: now })
    .where(
      and(
        eq(studioStitchJobs.id, jobId),
        eq(studioStitchJobs.athlete_id, athleteId),
        eq(studioStitchJobs.status, "queued"),
      ),
    )
    .returning({ id: studioStitchJobs.id });
  return out.length > 0;
}

/**
 * Atomically move up to `limit` queued stitches to `running` under a lease.
 *
 * SKIP LOCKED is the mutex between INSTANCES: two ticks landing at the same moment pass over each
 * other's locked rows rather than waiting. It is NOT a bound on how many stitches one instance
 * runs — that is a memory question and it is answered in studio/stitchRunner.ts, because SKIP
 * LOCKED's whole job is to hand the second caller a DIFFERENT row.
 *
 * NOT athlete-scoped. See the tenancy note in this file's header before adding a predicate.
 */
export async function claimStitchJobs(
  limit: number,
  holder: string,
  /**
   * Claim only rows whose spec is of this kind. The tick passes "post_kit_render" while the Studio
   * is dark (STUDIO_ENABLED off): the post-kit preview flags open the tick, and must not open the
   * Studio's own timelines with it. Absent: every queued row, as always.
   */
  opts: { kind?: "post_kit_render" } = {},
): Promise<StudioStitchJob[]> {
  if (limit <= 0) return [];
  const kindFilter = opts.kind ? sql` AND spec->>'kind' = ${opts.kind}` : sql``;
  const now = new Date();
  const until = new Date(now.getTime() + leaseMs());
  const res = await db.execute(sql`
    UPDATE studio_stitch_jobs
       SET status = 'running',
           lease_until = ${until},
           lease_holder = ${holder},
           attempts = attempts + 1,
           started_at = COALESCE(started_at, ${now}),
           updated_at = ${now}
     WHERE id IN (
       SELECT id FROM studio_stitch_jobs
        WHERE status = 'queued'${kindFilter}
        ORDER BY created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
     RETURNING *`);
  const jobs = rowsOf<StudioStitchJob>(res);
  if (jobs.length)
    logger.info({ holder, claimed: jobs.length }, "stitch jobs claimed");
  return jobs;
}

/**
 * Push the lease out while ffmpeg is still running. Guarded on the HOLDER as well as the status, so
 * an instance that already lost its lease to the reaper cannot take it back underneath the runner
 * that legitimately owns the job now.
 */
export async function renewStitchLease(
  jobId: string,
  holder: string,
): Promise<boolean> {
  const out = await db
    .update(studioStitchJobs)
    .set({
      lease_until: new Date(Date.now() + leaseMs()),
      updated_at: new Date(),
    })
    .where(
      and(
        eq(studioStitchJobs.id, jobId),
        eq(studioStitchJobs.lease_holder, holder),
        eq(studioStitchJobs.status, "running"),
      ),
    )
    .returning({ id: studioStitchJobs.id });
  return out.length > 0;
}

/**
 * Close a stitch that produced a file. Guarded on the HOLDER: a runner that lost its lease mid-run
 * must not overwrite the outcome of whoever holds the job now.
 */
export async function succeedStitch(
  jobId: string,
  holder: string,
  outputAssetId: string,
): Promise<boolean> {
  const now = new Date();
  const out = await db
    .update(studioStitchJobs)
    .set({
      status: "succeeded",
      output_asset_id: outputAssetId,
      last_error: null,
      completed_at: now,
      lease_until: null,
      lease_holder: null,
      updated_at: now,
    })
    .where(
      and(
        eq(studioStitchJobs.id, jobId),
        eq(studioStitchJobs.lease_holder, holder),
        eq(studioStitchJobs.status, "running"),
      ),
    )
    .returning({ id: studioStitchJobs.id });
  if (!out.length)
    logger.warn(
      { jobId },
      "succeeded a stitch this runner no longer holds — ignored",
    );
  return out.length > 0;
}

/**
 * Close a stitch that could not be made. Same holder guard.
 *
 * `message` reaches the athlete through the status route, so what is passed here is the readable
 * refusal from studio/video/materialize.ts — never an ffmpeg stderr tail, which studio/stitchRunner
 * .ts logs instead.
 */
export async function failStitch(
  jobId: string,
  holder: string,
  message: string,
): Promise<boolean> {
  const now = new Date();
  const out = await db
    .update(studioStitchJobs)
    .set({
      status: "failed",
      last_error: message,
      completed_at: now,
      lease_until: null,
      lease_holder: null,
      updated_at: now,
    })
    .where(
      and(
        eq(studioStitchJobs.id, jobId),
        eq(studioStitchJobs.lease_holder, holder),
        eq(studioStitchJobs.status, "running"),
      ),
    )
    .returning({ id: studioStitchJobs.id });
  return out.length > 0;
}

/**
 * Close a job that no longer needs doing — a post-kit preview render superseded by a newer one before it started
 * (agent/postKit/render/worker.ts). `canceled` is in 0057's CHECK for exactly this. Same holder guard as the two above.
 */
export async function cancelStitch(
  jobId: string,
  holder: string,
  message: string,
): Promise<boolean> {
  const now = new Date();
  const out = await db
    .update(studioStitchJobs)
    .set({
      status: "canceled",
      last_error: message,
      completed_at: now,
      lease_until: null,
      lease_holder: null,
      updated_at: now,
    })
    .where(
      and(
        eq(studioStitchJobs.id, jobId),
        eq(studioStitchJobs.lease_holder, holder),
        eq(studioStitchJobs.status, "running"),
      ),
    )
    .returning({ id: studioStitchJobs.id });
  return out.length > 0;
}

export interface StitchReapResult {
  /** Claimed too many times without finishing. Given up on — the ONLY way a lapse becomes a failure. */
  exhausted: number;
  /** Returned to the queue for another runner. The ordinary case, and at $0 it is the only one. */
  requeued: number;
}

/**
 * Find stitches whose holder died and put them back.
 *
 * TWO ARMS, NOT THREE. videoJobs.ts's first arm — fail a job that died inside a paid submit — has
 * no counterpart here and must not grow one: see this file's header. The order of what remains is
 * still the policy, and it is the same one: give up on a job that has burned its attempts BEFORE
 * handing it out again, so a timeline that kills instances cannot cycle the fleet.
 */
export async function reapExpiredStitchLeases(
  /**
   * Told about every row this pass gave up on, after it is failed — the post-kit preview render
   * uses it to mark its kit failed too (otherwise the kit would say "queued" forever). Its errors
   * are its own: they are logged and never undo the reap.
   */
  onExhausted?: (rows: Array<Pick<StudioStitchJob, "id" | "athlete_id" | "spec">>) => Promise<void>,
): Promise<StitchReapResult> {
  const now = new Date();
  const lapsed = and(
    eq(studioStitchJobs.status, "running"),
    isNotNull(studioStitchJobs.lease_until),
    sql`${studioStitchJobs.lease_until} < ${now}`,
  );

  // 1. EXHAUSTED — handed round too many times. Give up rather than loop.
  const exhausted = await db
    .update(studioStitchJobs)
    .set({
      status: "failed",
      last_error: `We tried to put this together ${maxAttempts()} times and couldn't finish it. Try a shorter timeline.`,
      completed_at: now,
      lease_until: null,
      lease_holder: null,
      updated_at: now,
    })
    .where(and(lapsed, sql`${studioStitchJobs.attempts} >= ${maxAttempts()}`))
    .returning({ id: studioStitchJobs.id, athlete_id: studioStitchJobs.athlete_id, spec: studioStitchJobs.spec });
  if (exhausted.length && onExhausted) {
    await onExhausted(exhausted).catch((err) =>
      logger.error({ err }, "a reaped job's owner could not be told it was given up on"),
    );
  }

  // 2. HANDOFF — the ordinary case, and the only other one. Nothing was spent, so nothing is at
  //    risk in doing the work again.
  const requeued = await db
    .update(studioStitchJobs)
    .set({
      status: "queued",
      lease_until: null,
      lease_holder: null,
      updated_at: now,
    })
    .where(lapsed)
    .returning({ id: studioStitchJobs.id });

  const out = { exhausted: exhausted.length, requeued: requeued.length };
  if (out.exhausted || out.requeued)
    logger.warn(out, "expired stitch leases reaped");
  return out;
}

/**
 * One stitch, for the athlete who owns it. Not-found and not-yours are the same answer — the
 * predicate is what makes them so, and there is no branch here that could tell them apart.
 */
export async function readStitchJob(
  athleteId: string,
  jobId: string,
): Promise<StudioStitchJob | null> {
  const [row] = await db
    .select()
    .from(studioStitchJobs)
    .where(
      and(
        eq(studioStitchJobs.id, jobId),
        eq(studioStitchJobs.athlete_id, athleteId),
      ),
    )
    .limit(1);
  return row ?? null;
}
