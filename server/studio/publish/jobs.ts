/**
 * studio/publish/jobs — the queue, the lease, and the one write that lets a publish happen.
 *
 * Read shared/schema.ts (studio_publish_jobs) first: it says why this table has the stitch queue's
 * shape and the video queue's posture. This file is where that posture is enforced.
 *
 * ─── THE RULE: THE PUBLISH CALL IS MADE AT MOST ONCE PER ROW, EVER ──────────────────────────────
 *
 * It is held by ONE statement, `recordPublishAttempt`, and by nothing else:
 *
 *     UPDATE … SET publish_attempted_at = now
 *      WHERE id = $1 AND publish_attempted_at IS NULL AND ig_media_id IS NULL …
 *
 * A compare-and-set. It returns true to exactly one caller in the life of the row, and the runner
 * may call Instagram's publish ONLY on true. Not "the runner checks, then writes" — a check and a
 * write are two statements, and two runners holding the same stale row both pass the check. The
 * database decides, and it decides once.
 *
 * Everything else here can therefore be ordinary. In particular:
 *
 * ─── THE REAPER MAY REQUEUE AN ORPHAN, AND THAT IS SAFE ─────────────────────────────────────────
 *
 * videoJobs.ts fails an orphan (attempted, no handle) inside the reaper, because a Veo submit that
 * lost its handle is unreadable: nobody can ask Vertex what happened. We can ask. A container says
 * PUBLISHED when the post exists, so an orphan goes BACK TO THE QUEUE for a runner to read — and
 * that runner cannot re-publish it however it is written, because `recordPublishAttempt` will never
 * return true for that row again. The runner reads the container: PUBLISHED ⇒ it posted, succeed;
 * anything else ⇒ fail closed with "this may have posted — check Instagram".
 *
 * (This is a change from the plan I gave, which had the reaper fail orphans first the way video's
 * does. Same guarantee, held one level lower, and it turns some "may have posted" into "posted".)
 *
 * What the reaper must NOT do is lie. A row that has been attempted and is then given up on is told
 * "this may have posted", never "nothing was posted" — see the first arm.
 *
 * ─── THE HANDLE IS WRITTEN WHATEVER HAPPENED TO THE LEASE ───────────────────────────────────────
 *
 * Every other write here is guarded on the holder, so a runner that lost its lease cannot overwrite
 * the job's new owner. `recordMediaId` is the exception, as video's recordOperationName is: if
 * Instagram returned a media id, THE POST EXISTS, and a lost lease is no reason to forget it. It is
 * guarded on `ig_media_id IS NULL` instead, so it can be written once and never replaced.
 *
 * ─── TENANCY ────────────────────────────────────────────────────────────────────────────────────
 *
 * `claimPublishJobs` and the reaper are system consumers of a queue spanning every athlete and
 * carry no athlete predicate — they cannot, and still be a queue. They take no id from anyone: each
 * claimed row carries its own athlete_id and the runner uses THAT for every lookup. Everything the
 * route calls (`queuePublish`, `readPublishJob`, `readLatestPublishForAsset`) filters by the
 * athlete id the route read from `req.athleteId`.
 */
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  studioPublishJobs,
  type StudioPublishJob,
} from "../../../shared/schema";
import { isUniqueViolation } from "../../services/intelligence/identity/users";
import { createLogger } from "../../logger";
import {
  leaseMs,
  maxAttempts,
  type JobMode,
  type PublishPlatform,
} from "./config";
import type { PublishErrorCode } from "./instagram";

const logger = createLogger("studio/publish/jobs");

const LIVE_INDEX = "uq_studio_publish_jobs_live";

/**
 * Why a job ended without a post, as the client needs it. Instagram's refusals (./instagram) plus
 * the ones that are ours.
 */
export type JobErrorCode =
  | PublishErrorCode
  /** We asked Instagram to publish and never learned the answer. NEVER re-sent. */
  | "may_have_posted"
  /** Claimed and lapsed too many times before anything was sent. */
  | "gave_up"
  /** The video or the account was removed while the job waited. */
  | "asset_gone"
  | "account_gone"
  /** STUDIO_PUBLISH_MODE was not live (or the row was not) when its turn came. */
  | "not_sending";

export const MAY_HAVE_POSTED =
  "We asked Instagram to post this and lost the answer, so it may have posted. Check Instagram before posting it again.";

/** pg returns `{rows}`; PGlite returns the array. Both drivers, one reader — as stitchJobs does. */
const rowsOf = <T>(res: unknown): T[] =>
  ((res as { rows?: T[] })?.rows ?? res) as T[];

/**
 * MAKE THE TYPE TRUE. `db.execute(sql…RETURNING *)` is raw: drizzle does not map it, so a driver is
 * free to hand timestamps back as strings while `StudioPublishJob` promises Dates — and the first
 * `gte(column, job.started_at)` downstream throws. The claim is the only raw read here, so the
 * claimed row is normalised once, at the door.
 */
const TIMESTAMPS = [
  "container_created_at",
  "publish_attempted_at",
  "lease_until",
  "created_at",
  "started_at",
  "completed_at",
  "updated_at",
] as const;
function hydrate(row: StudioPublishJob): StudioPublishJob {
  const out = { ...row } as Record<string, unknown>;
  for (const k of TIMESTAMPS) {
    const v = out[k];
    if (v !== null && v !== undefined && !(v instanceof Date))
      out[k] = new Date(v as string);
  }
  return out as StudioPublishJob;
}

// ─── 1. Queue ──────────────────────────────────────────────────────────────────────────────────

export interface QueuePublishInput {
  /** From `req.athleteId`. Never from the body. */
  athleteId: string;
  /** Already resolved against the athlete by the route. */
  assetId: string;
  /** THE ACCOUNT SHE CONFIRMED — already resolved against the athlete by the route. */
  connectedAccountId: string;
  platform: PublishPlatform;
  caption: string;
  /** Frozen from STUDIO_PUBLISH_MODE at the tap. `off` never reaches here. */
  mode: JobMode;
}

export interface QueuedPublish {
  id: string;
  /**
   * TRUE when this tap found a job for the same video already live and was handed THAT job instead
   * of a new one. Two taps are one post — and the second tap gets an answer, not an error.
   */
  alreadyLive: boolean;
}

/**
 * Queue a post. The whole of what the REQUEST does once it has decided to.
 *
 * The double-tap guard is 0059's partial unique index, not a read-then-insert: the loser of a race
 * between two requests meets a 23505, and is given the winner's job. If the winner finished in the
 * instant between, the insert is tried once more — a finished job does not hold the slot.
 */
export async function queuePublish(
  input: QueuePublishInput,
): Promise<QueuedPublish> {
  for (let tries = 0; tries < 2; tries++) {
    try {
      const [row] = await db
        .insert(studioPublishJobs)
        .values({
          athlete_id: input.athleteId,
          asset_id: input.assetId,
          connected_account_id: input.connectedAccountId,
          platform: input.platform,
          caption: input.caption,
          mode: input.mode,
          status: "queued",
        } as never)
        .returning({ id: studioPublishJobs.id });
      logger.info(
        { athleteId: input.athleteId, publishId: row.id, mode: input.mode },
        "publish queued",
      );
      return { id: row.id, alreadyLive: false };
    } catch (err) {
      if (!isUniqueViolation(err, LIVE_INDEX)) throw err;
      const [live] = await db
        .select({ id: studioPublishJobs.id })
        .from(studioPublishJobs)
        .where(
          and(
            // THE TENANCY PREDICATE, even here: the index is per asset, and an asset is hers, but a
            // predicate that is merely implied is not a predicate.
            eq(studioPublishJobs.athlete_id, input.athleteId),
            eq(studioPublishJobs.asset_id, input.assetId),
            eq(studioPublishJobs.platform, input.platform),
            sql`${studioPublishJobs.status} IN ('queued','running')`,
          ),
        )
        .limit(1);
      if (live) {
        logger.info(
          { athleteId: input.athleteId, publishId: live.id },
          "publish already live for this video — second tap joined it",
        );
        return { id: live.id, alreadyLive: true };
      }
    }
  }
  throw new Error("could not queue this post — try again");
}

// ─── 2. Claim and lease ────────────────────────────────────────────────────────────────────────

/**
 * Atomically move up to `limit` queued jobs to `running` under a lease. SKIP LOCKED is the mutex
 * between instances. NOT athlete-scoped — see the tenancy note in the header.
 */
export async function claimPublishJobs(
  limit: number,
  holder: string,
): Promise<StudioPublishJob[]> {
  if (limit <= 0) return [];
  const now = new Date();
  const until = new Date(now.getTime() + leaseMs());
  const res = await db.execute(sql`
    UPDATE studio_publish_jobs
       SET status = 'running',
           lease_until = ${until},
           lease_holder = ${holder},
           attempts = attempts + 1,
           started_at = COALESCE(started_at, ${now}),
           updated_at = ${now}
     WHERE id IN (
       SELECT id FROM studio_publish_jobs
        WHERE status = 'queued'
        ORDER BY created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
     RETURNING *`);
  const jobs = rowsOf<StudioPublishJob>(res).map(hydrate);
  if (jobs.length)
    logger.info({ holder, claimed: jobs.length }, "publish jobs claimed");
  return jobs;
}

/** This runner, on this job, while it is still running. The guard every ordinary write carries. */
const held = (jobId: string, holder: string) =>
  and(
    eq(studioPublishJobs.id, jobId),
    eq(studioPublishJobs.lease_holder, holder),
    eq(studioPublishJobs.status, "running"),
  );

// ─── 3. The container: a resume handle ─────────────────────────────────────────────────────────

/**
 * Remember the container, once. Guarded on `container_id IS NULL` so a runner cannot replace the
 * container a job is already waiting on — the one a later publish will name.
 */
export async function recordContainer(
  jobId: string,
  holder: string,
  containerId: string,
): Promise<boolean> {
  const now = new Date();
  const out = await db
    .update(studioPublishJobs)
    .set({
      container_id: containerId,
      container_created_at: now,
      updated_at: now,
    })
    .where(and(held(jobId, holder), isNull(studioPublishJobs.container_id)))
    .returning({ id: studioPublishJobs.id });
  return out.length > 0;
}

/**
 * Instagram is still preparing the video: hand the job back for the NEXT tick to look again.
 *
 * KEEPS `container_id` — that is the point — and gives the claim's attempt back, because `attempts`
 * counts claims that LAPSED, and waiting for Instagram is not a lapse. `poll_count` is what bounds
 * the waiting. Returns the new poll count, or null if this runner no longer holds the job.
 */
export async function releaseForPoll(
  jobId: string,
  holder: string,
): Promise<number | null> {
  const out = await db
    .update(studioPublishJobs)
    .set({
      status: "queued",
      lease_until: null,
      lease_holder: null,
      poll_count: sql`${studioPublishJobs.poll_count} + 1`,
      attempts: sql`GREATEST(${studioPublishJobs.attempts} - 1, 0)`,
      updated_at: new Date(),
    })
    .where(held(jobId, holder))
    .returning({ polls: studioPublishJobs.poll_count });
  return out[0]?.polls ?? null;
}

// ─── 4. THE SUBMIT-ONCE PAIR ───────────────────────────────────────────────────────────────────

/**
 * ⚠️  THE ONE WRITE THAT LETS A PUBLISH HAPPEN. Returns TRUE to exactly one caller in the life of
 * the row. The runner calls Instagram's publish if and only if this returned true, and writes it
 * BEFORE the call — so a crash at any later instant leaves a row that says "attempted".
 *
 * Every clause of the WHERE is load-bearing:
 *   publish_attempted_at IS NULL   never twice
 *   ig_media_id IS NULL            never after a post exists
 *   container_id IS NOT NULL       never with nothing to publish
 *   mode = 'live'                  a dry row can never be sent, whatever the process says
 *   held(…)                        only by the runner that holds it, only while running
 */
export async function recordPublishAttempt(
  jobId: string,
  holder: string,
): Promise<boolean> {
  const now = new Date();
  const out = await db
    .update(studioPublishJobs)
    .set({ publish_attempted_at: now, updated_at: now })
    .where(
      and(
        held(jobId, holder),
        isNull(studioPublishJobs.publish_attempted_at),
        isNull(studioPublishJobs.ig_media_id),
        isNotNull(studioPublishJobs.container_id),
        eq(studioPublishJobs.mode, "live"),
      ),
    )
    .returning({ id: studioPublishJobs.id });
  return out.length > 0;
}

/**
 * The post exists; remember it. NOT holder-guarded — see the header. Written once: a second call
 * cannot replace the id of a real post with another.
 */
export async function recordMediaId(
  jobId: string,
  mediaId: string,
): Promise<boolean> {
  const out = await db
    .update(studioPublishJobs)
    .set({ ig_media_id: mediaId, updated_at: new Date() })
    .where(
      and(
        eq(studioPublishJobs.id, jobId),
        isNull(studioPublishJobs.ig_media_id),
      ),
    )
    .returning({ id: studioPublishJobs.id });
  if (!out.length)
    logger.warn(
      { jobId },
      "media id already recorded for this job — kept the first",
    );
  return out.length > 0;
}

// ─── 5. Closing a job ──────────────────────────────────────────────────────────────────────────

export async function succeedPublish(
  jobId: string,
  holder: string,
  permalink: string | null,
): Promise<boolean> {
  const now = new Date();
  const out = await db
    .update(studioPublishJobs)
    .set({
      status: "succeeded",
      permalink,
      last_error: null,
      error_code: null,
      completed_at: now,
      lease_until: null,
      lease_holder: null,
      updated_at: now,
    })
    .where(held(jobId, holder))
    .returning({ id: studioPublishJobs.id });
  if (!out.length)
    logger.warn(
      { jobId },
      "succeeded a publish this runner no longer holds — ignored",
    );
  return out.length > 0;
}

/** `message` reaches her through the status route: a sentence, never a Meta code. */
export async function failPublish(
  jobId: string,
  holder: string,
  code: JobErrorCode,
  message: string,
): Promise<boolean> {
  const now = new Date();
  const out = await db
    .update(studioPublishJobs)
    .set({
      status: "failed",
      last_error: message,
      error_code: code,
      completed_at: now,
      lease_until: null,
      lease_holder: null,
      updated_at: now,
    })
    .where(held(jobId, holder))
    .returning({ id: studioPublishJobs.id });
  return out.length > 0;
}

// ─── 6. The reaper ─────────────────────────────────────────────────────────────────────────────

export interface PublishReapResult {
  /** Attempted, never confirmed, and out of attempts. Told the truth: it may have posted. */
  unconfirmed: number;
  /** Out of attempts with a media id on the row: the post exists, so the record says so. */
  posted: number;
  /** Out of attempts before anything was sent. Nothing was posted. */
  exhausted: number;
  /** Back to the queue — container, attempt mark and media id all kept — for a runner to resume. */
  requeued: number;
}

/**
 * Find jobs whose holder died and decide what each deserves. Runs at the top of every tick.
 *
 * THE ORDER IS THE POLICY. The three give-up arms run before the handoff, and among them the two
 * that know something was SENT run before the one that assumes nothing was — so a row is never told
 * "nothing was posted" when a publish call went out for it. The handoff requeues everything else,
 * orphans included, because no runner can re-publish one: `recordPublishAttempt` has already
 * returned its only true.
 */
export async function reapExpiredPublishLeases(): Promise<PublishReapResult> {
  const now = new Date();
  const lapsed = and(
    eq(studioPublishJobs.status, "running"),
    isNotNull(studioPublishJobs.lease_until),
    sql`${studioPublishJobs.lease_until} < ${now}`,
  );
  const spent = sql`${studioPublishJobs.attempts} >= ${maxAttempts()}`;
  const closed = {
    completed_at: now,
    lease_until: null,
    lease_holder: null,
    updated_at: now,
  };

  // 1. POSTED — the handle is on the row. Whatever bookkeeping was lost, the post is real.
  const posted = await db
    .update(studioPublishJobs)
    .set({ status: "succeeded", last_error: null, error_code: null, ...closed })
    .where(and(lapsed, spent, isNotNull(studioPublishJobs.ig_media_id)))
    .returning({ id: studioPublishJobs.id });

  // 2. UNCONFIRMED — we called publish and never learned the answer. Fail closed, and say so.
  const unconfirmed = await db
    .update(studioPublishJobs)
    .set({
      status: "failed",
      last_error: MAY_HAVE_POSTED,
      error_code: "may_have_posted" satisfies JobErrorCode,
      ...closed,
    })
    .where(
      and(lapsed, spent, isNotNull(studioPublishJobs.publish_attempted_at)),
    )
    .returning({ id: studioPublishJobs.id });

  // 3. EXHAUSTED — given up on before anything was sent. This sentence is only true because 1 and 2
  //    have already taken every row it would be false for.
  const exhausted = await db
    .update(studioPublishJobs)
    .set({
      status: "failed",
      last_error: `We tried to post this ${maxAttempts()} times and couldn't get it started. Nothing was posted — try again.`,
      error_code: "gave_up" satisfies JobErrorCode,
      ...closed,
    })
    .where(and(lapsed, spent))
    .returning({ id: studioPublishJobs.id });

  // 4. HANDOFF — everything else. container_id, publish_attempted_at and ig_media_id are all KEPT:
  //    they are what tells the next runner where this job really is.
  const requeued = await db
    .update(studioPublishJobs)
    .set({
      status: "queued",
      lease_until: null,
      lease_holder: null,
      updated_at: now,
    })
    .where(lapsed)
    .returning({ id: studioPublishJobs.id });

  const out = {
    unconfirmed: unconfirmed.length,
    posted: posted.length,
    exhausted: exhausted.length,
    requeued: requeued.length,
  };
  if (out.unconfirmed || out.posted || out.exhausted || out.requeued)
    logger.warn(out, "expired publish leases reaped");
  return out;
}

// ─── 7. Reads, for the athlete who owns the job ────────────────────────────────────────────────

/** Not-found and not-yours are the same answer — the predicate is what makes them so. */
export async function readPublishJob(
  athleteId: string,
  jobId: string,
): Promise<StudioPublishJob | null> {
  const [row] = await db
    .select()
    .from(studioPublishJobs)
    .where(
      and(
        eq(studioPublishJobs.id, jobId),
        eq(studioPublishJobs.athlete_id, athleteId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The newest job for one of her videos — what the result card shows when she comes back to it. */
export async function readLatestPublishForAsset(
  athleteId: string,
  assetId: string,
  platform: PublishPlatform,
): Promise<StudioPublishJob | null> {
  const [row] = await db
    .select()
    .from(studioPublishJobs)
    .where(
      and(
        eq(studioPublishJobs.athlete_id, athleteId),
        eq(studioPublishJobs.asset_id, assetId),
        eq(studioPublishJobs.platform, platform),
      ),
    )
    .orderBy(desc(studioPublishJobs.created_at))
    .limit(1);
  return row ?? null;
}
