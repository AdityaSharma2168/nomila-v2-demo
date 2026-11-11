/**
 * studio/publish/runner — works one publish job, and the tick that hands them out.
 *
 *   reap expired leases · claim ≤ capacity · START each (detached) · return
 *
 * ─── THE ORDER A JOB IS READ IN IS THE SAFETY ARGUMENT ──────────────────────────────────────────
 *
 * A claimed row can be in any state a previous runner left it in, so `workPublish` asks, IN THIS
 * ORDER, and acts on the first yes:
 *
 *   1. ig_media_id is set            THE POST EXISTS. Finish the paperwork. No Meta POST, ever.
 *   2. publish_attempted_at is set   WE ASKED AND NEVER HEARD. Read the container. No Meta POST, ever.
 *   3. may this job send?            off / dry / live, by the TWO KEYS (config.maySendLive).
 *   4. is it still postable?         the video and the pinned account, re-resolved against her id.
 *   5. container → status → publish  the ordinary path.
 *
 * 1 and 2 come before everything — before the mode, before eligibility — because they are facts
 * about the world, not about this process: a post that exists still exists with the switch off,
 * and "it may have posted" is still the truth if the video has since been deleted.
 *
 * ─── THE ONE PLACE `publish` IS CALLED ──────────────────────────────────────────────────────────
 *
 * `sendPublish`, and only after `recordPublishAttempt` returned true — a compare-and-set that says
 * yes once in the life of the row (jobs.ts). Any throw that is not an explicit refusal is treated
 * as "it may have posted" and handed to the same reader as (2). There is no retry, no loop, and no
 * second call site. The revert suite counts the fake's publish calls; the number is never 2.
 *
 * ─── DRY RUN ────────────────────────────────────────────────────────────────────────────────────
 *
 * Does everything except the two Meta POSTs: resolves the video and the account, refreshes the
 * token, signs the URL, reads her publishing limit (a GET that needs the publish permission — so
 * dry-run learns whether the recorded scope is TRUE), then logs the exact bodies it would have sent
 * with the URL's secrets redacted. The caption is in that log on purpose: dry-run exists to show
 * the payload, and it is off in production. Nothing is written to content_posts — nothing posted.
 *
 * ─── TENANCY ────────────────────────────────────────────────────────────────────────────────────
 *
 * The athlete comes off the CLAIMED ROW and goes into every lookup. Nothing here takes an id from a
 * request, a model or a client.
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { and, eq, gte } from "drizzle-orm";
import { db } from "../../db";
import { contentPosts, type StudioPublishJob } from "../../../shared/schema";
import { signedUrl } from "../../lib/mediaStore";
import { refreshTokenIfNeeded } from "../../lib/integrations/instagram";
import { createLogger } from "../../logger";
import { maxPolls, maySendLive, publishMode, videoUrlTtlMs } from "./config";
import {
  accountRefusal,
  pinnedInstagramAccount,
  resolvePostableAsset,
  type PublishAccount,
} from "./eligibility";
import {
  InstagramPublishError,
  checkPublishingLimit,
  checkStatus,
  classifyMetaError,
  containerBody,
  createContainer,
  fetchPermalink,
  liveDeps,
  publish,
  publishBody,
  redactUrl,
  sentenceFor,
  type InstagramDeps,
} from "./instagram";
import {
  MAY_HAVE_POSTED,
  claimPublishJobs,
  failPublish,
  reapExpiredPublishLeases,
  recordContainer,
  recordMediaId,
  recordPublishAttempt,
  releaseForPoll,
  succeedPublish,
  type JobErrorCode,
  type PublishReapResult,
} from "./jobs";

const logger = createLogger("studio/publish/runner");

export const RUNNER_ID = `${hostname()}-${randomUUID().slice(0, 8)}`;

/** How many jobs one instance works at once. Each is a few short HTTP calls; this bounds sockets, not memory. */
export const maxConcurrent = () =>
  Number(process.env.STUDIO_PUBLISH_MAX_CONCURRENT ?? 4);

/**
 * How long one claim keeps looking at a container before handing the job back, and how often.
 * Bounded well inside the lease. Meta's guidance is a read a minute; a short video is ready in
 * seconds, so one claim looks a few times and then lets the NEXT TICK look — never a loop that
 * outlives its lease.
 */
export const pollWindowMs = () =>
  Number(process.env.STUDIO_PUBLISH_POLL_WINDOW_MS ?? 40_000);
export const pollIntervalMs = () =>
  Number(process.env.STUDIO_PUBLISH_POLL_INTERVAL_MS ?? 10_000);

export interface RunnerDeps {
  ig: InstagramDeps;
  signUrl(gcsPath: string, ttlMs: number): Promise<string>;
  refreshToken(connectionId: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  holder: string;
}

export const liveRunnerDeps = (): RunnerDeps => ({
  ig: liveDeps(),
  signUrl: signedUrl,
  refreshToken: refreshTokenIfNeeded,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  holder: RUNNER_ID,
});

export type PublishOutcome =
  | "succeeded"
  | "failed"
  | "waiting" // handed back for the next tick
  | "lost"; // this runner no longer holds the job; someone else decides

const OUR_FAULT =
  "Something went wrong on our side before anything was sent. Nothing was posted — try again.";
const NOT_SENDING =
  "Posting was switched off before this went out. Nothing was posted.";

// ─── The record of a post that exists ──────────────────────────────────────────────────────────

/**
 * content_posts: "one publish record per real post". Written ONLY when a post really exists.
 * The paperwork step can be re-entered after a crash, so it looks before it writes: a row for this
 * video and platform made since this job started IS this job's row. (content_posts' own unique
 * index only helps when there is a permalink; a recovered orphan has none.)
 */
async function recordPost(job: StudioPublishJob, permalink: string | null) {
  if (!job.asset_id) return; // swept while we posted. The job row is the record.
  // 0075: the platform's own id for what we just published, so the observations ingested for this post can be found.
  // Non-fatal, like savePlan's bookkeeping: losing the post over its provenance would be worse than losing the link.
  try {
    const { recordPublishedIdentity } = await import("../../services/intelligence/outcome/publishedIdentity.js");
    await recordPublishedIdentity(db, { athleteId: job.athlete_id, assetId: job.asset_id, platform: job.platform, platformMediaId: job.ig_media_id ?? null, permalink, publishJobId: job.id });
  } catch (err) { logger.error({ err, jobId: job.id }, "published asset identity not recorded"); }
  const since = job.started_at ?? job.created_at;
  const [existing] = await db
    .select({ id: contentPosts.id })
    .from(contentPosts)
    .where(
      and(
        eq(contentPosts.asset_id, job.asset_id),
        eq(contentPosts.platform, job.platform),
        gte(contentPosts.created_at, since),
      ),
    )
    .limit(1);
  if (existing) return;
  await db
    .insert(contentPosts)
    .values({
      asset_id: job.asset_id,
      platform: job.platform,
      permalink,
      posted_at: new Date(),
    } as never)
    .onConflictDoNothing();
}

const fail = async (
  job: StudioPublishJob,
  deps: RunnerDeps,
  code: JobErrorCode,
  message: string,
): Promise<PublishOutcome> => {
  const held = await failPublish(job.id, deps.holder, code, message);
  logger.warn(
    { publishId: job.id, athleteId: job.athlete_id, code },
    "publish failed",
  );
  return held ? "failed" : "lost";
};

/** Instagram's refusal → her sentence and our code. The detail goes to the log, never to her. */
const failWith = (job: StudioPublishJob, deps: RunnerDeps, err: unknown) => {
  if (err instanceof InstagramPublishError) {
    logger.warn(
      { publishId: job.id, op: err.op, code: err.code, detail: err.detail },
      "instagram refused",
    );
    return fail(job, deps, err.code, err.userMessage);
  }
  // OURS, not Instagram's — a signing failure, a database error. Say so; do not blame a refusal
  // that never happened.
  logger.error({ err, publishId: job.id }, "publish job crashed");
  return fail(job, deps, "transient", OUR_FAULT);
};

// ─── 1. The post exists: finish the paperwork ──────────────────────────────────────────────────

async function finishPosted(
  job: StudioPublishJob,
  deps: RunnerDeps,
  token: string | null,
  mediaId: string | null,
): Promise<PublishOutcome> {
  let permalink: string | null = job.permalink;
  if (!permalink && mediaId && token) {
    // A read, after the fact. It cannot un-post anything, and it must not fail the job: the post
    // is real with or without a link to it.
    permalink = await fetchPermalink({ mediaId, token }, deps.ig).catch(
      () => null,
    );
  }
  await recordPost(job, permalink);
  const held = await succeedPublish(job.id, deps.holder, permalink);
  logger.info(
    { publishId: job.id, athleteId: job.athlete_id, hasPermalink: !!permalink },
    "published",
  );
  return held ? "succeeded" : "lost";
}

// ─── 2. We asked and never heard: read, never re-send ──────────────────────────────────────────

/**
 * The orphan window. NO PATH OUT OF THIS FUNCTION CALLS `publish`.
 *
 * PUBLISHED ⇒ it posted (no field returns the media id, so there is no permalink — the post is
 * real anyway). Still being prepared ⇒ look again next tick, while the poll budget lasts.
 * Anything else, or no answer ⇒ FAIL CLOSED with the truth: it may have posted.
 */
async function resolveUnconfirmed(
  job: StudioPublishJob,
  deps: RunnerDeps,
  token: string | null,
): Promise<PublishOutcome> {
  if (token && job.container_id && publishMode() === "live") {
    try {
      const { statusCode } = await checkStatus(
        { containerId: job.container_id, token },
        deps.ig,
      );
      if (statusCode === "PUBLISHED")
        return finishPosted(job, deps, token, null);
      if (
        (statusCode === "IN_PROGRESS" || statusCode === "FINISHED") &&
        job.poll_count < maxPolls()
      ) {
        const polls = await releaseForPoll(job.id, deps.holder);
        return polls === null ? "lost" : "waiting";
      }
    } catch {
      // A read that failed tells us nothing. Fall through to the only honest answer.
    }
  }
  return fail(job, deps, "may_have_posted", MAY_HAVE_POSTED);
}

// ─── 5c. THE ONE CALL SITE ─────────────────────────────────────────────────────────────────────

async function sendPublish(
  job: StudioPublishJob,
  deps: RunnerDeps,
  account: PublishAccount,
  containerId: string,
  gate: { passed: boolean },
): Promise<PublishOutcome> {
  // ⚠️  THE GATE. True once in the life of this row. Written BEFORE the call, so a crash at any
  // later instant leaves a row that says "attempted" and lands in resolveUnconfirmed.
  if (!(await recordPublishAttempt(job.id, deps.holder))) {
    // Not ours to send: already attempted, or the lease is gone. Re-sending is never the answer.
    return job.publish_attempted_at
      ? resolveUnconfirmed(
          { ...job, container_id: containerId },
          deps,
          account.accessToken,
        )
      : "lost";
  }
  gate.passed = true;

  let mediaId: string;
  try {
    ({ mediaId } = await publish(
      {
        igUserId: account.igUserId!,
        containerId,
        token: account.accessToken!,
      },
      deps.ig,
    ));
  } catch (err) {
    if (err instanceof InstagramPublishError && !err.outcomeUnknown)
      return failWith(job, deps, err); // an explicit "no": nothing was posted
    // Timeout, network, 5xx, "try again", a 200 with no id: THE POST MAY EXIST.
    logger.warn(
      {
        publishId: job.id,
        detail: err instanceof InstagramPublishError ? err.detail : undefined,
      },
      "publish outcome unknown — reading the container, never re-sending",
    );
    // THE ROW IN HAND IS STALE: it was claimed before this container existed. The reader needs the
    // container that was just published, or it has nothing to read and fails closed at once.
    return resolveUnconfirmed(
      { ...job, container_id: containerId, publish_attempted_at: new Date() },
      deps,
      account.accessToken,
    );
  }

  // The post exists. Remember it FIRST and whatever happened to the lease.
  await recordMediaId(job.id, mediaId);
  return finishPosted(job, deps, account.accessToken, mediaId);
}

// ─── The job ───────────────────────────────────────────────────────────────────────────────────

export async function workPublish(
  job: StudioPublishJob,
  deps: RunnerDeps,
): Promise<PublishOutcome> {
  // PAST THE GATE means a publish call has gone out for this row, now or in an earlier life. From
  // that moment "nothing was posted" is not ours to say, so the generic catch below must not say
  // it. It lets the lease lapse instead: the reaper hands the row on, and arm 1 or arm 2 — which
  // only ever read — tells the truth about it.
  const gate = { passed: !!job.ig_media_id || !!job.publish_attempted_at };
  // EVERY RETURN IN THIS TRY IS `return await`. A bare `return promise` leaves the try block before
  // the promise settles, so its rejection never reaches the catch — and the gate below would guard
  // nothing. (It did guard nothing, until a test threw through it.)
  try {
    // The pinned account, re-resolved against HER id. Needed by every arm that talks to Instagram;
    // its absence only fails the job in arm 4 — arms 1 and 2 are true without it.
    const account = job.connected_account_id
      ? await pinnedInstagramAccount(job.athlete_id, job.connected_account_id)
      : null;

    // 1. THE POST EXISTS.
    if (job.ig_media_id)
      return await finishPosted(
        job,
        deps,
        account?.accessToken ?? null,
        job.ig_media_id,
      );

    // 2. WE ASKED AND NEVER HEARD.
    if (job.publish_attempted_at)
      return await resolveUnconfirmed(job, deps, account?.accessToken ?? null);

    // 3. MAY THIS JOB SEND? The two keys. A live row in a process that is not live posts nothing;
    //    a dry row is dry whatever the process says; off is off.
    const env = publishMode();
    const live = maySendLive(job.mode);
    const dry = env !== "off" && job.mode === "dry";
    if (!live && !dry) return await fail(job, deps, "not_sending", NOT_SENDING);

    if (job.platform !== "instagram")
      return await fail(
        job,
        deps,
        "unknown",
        "We can't post to that platform yet.",
      );

    // 4. IS IT STILL POSTABLE? Same checks as the route, asked again because a job can wait.
    if (!job.asset_id)
      return await fail(
        job,
        deps,
        "asset_gone",
        "That video was removed before it could be posted. Nothing was posted.",
      );
    const resolved = await resolvePostableAsset(job.athlete_id, job.asset_id);
    if (!resolved.ok)
      return await fail(
        job,
        deps,
        resolved.code === "not_found" ? "asset_gone" : "unknown",
        `${resolved.message} Nothing was posted.`,
      );
    const refusal = accountRefusal(account);
    if (refusal || !account)
      return await fail(
        job,
        deps,
        account ? "reconnect" : "account_gone",
        `${(refusal ?? { message: "" }).message} Nothing was posted.`.trim(),
      );

    // The token may be a week from expiry. Non-fatal: a stale token is refused by Meta in words we
    // already turn into "reconnect".
    await deps
      .refreshToken(account.id)
      .catch((err: unknown) =>
        logger.warn(
          { err, publishId: job.id },
          "instagram token refresh failed — continuing",
        ),
      );
    const fresh =
      (await pinnedInstagramAccount(job.athlete_id, account.id)) ?? account;
    const token = fresh.accessToken!;
    const igUserId = fresh.igUserId!;

    // THE TRUTH ABOUT THE SCOPE. connected_accounts.scopes can claim a permission Meta never
    // granted; this GET needs it, so a token that cannot post is refused HERE — in dry-run too.
    //
    // It stops the job for exactly the two things it is there to learn — no permission, no quota.
    // Any other failure of a READ is not a reason to refuse a post: carry on, and let the create
    // call speak for itself.
    const limit = await checkPublishingLimit(
      { igUserId, token },
      deps.ig,
    ).catch((err: unknown) => {
      if (
        err instanceof InstagramPublishError &&
        (err.code === "reconnect" || err.code === "rate_limited")
      )
        throw err;
      logger.warn(
        { publishId: job.id },
        "publishing-limit read failed — continuing",
      );
      return { used: null, total: null };
    });
    if (
      limit.used !== null &&
      limit.total !== null &&
      limit.used >= limit.total
    )
      return await fail(
        job,
        deps,
        "rate_limited",
        `${sentenceFor("rate_limited")} Nothing was posted.`,
      );

    // ── DRY: say exactly what would be sent, and send nothing ────────────────────────────────
    if (dry) {
      const videoUrl = await deps.signUrl(
        resolved.asset.gcsPath,
        videoUrlTtlMs(),
      );
      logger.info(
        {
          publishId: job.id,
          athleteId: job.athlete_id,
          connectedAccountId: account.id,
          mode: "dry",
          quota: limit,
          wouldSend: [
            {
              method: "POST",
              path: "/<IG_ID>/media",
              body: {
                ...containerBody({ videoUrl, caption: job.caption }),
                video_url: redactUrl(videoUrl),
              },
            },
            {
              method: "POST",
              path: "/<IG_ID>/media_publish",
              body: publishBody("<the container id the first call returns>"),
            },
          ],
          video: {
            bytes: resolved.asset.bytes,
            durationSeconds: resolved.asset.durationSeconds,
          },
        },
        "DRY RUN — nothing was sent to Instagram",
      );
      const held = await succeedPublish(job.id, deps.holder, null);
      return held ? "succeeded" : "lost";
    }

    // ── LIVE ─────────────────────────────────────────────────────────────────────────────────
    // 5a. The container. A job that already has one RESUMES it — no second upload.
    let containerId = job.container_id;
    if (!containerId) {
      const videoUrl = await deps.signUrl(
        resolved.asset.gcsPath,
        videoUrlTtlMs(),
      );
      ({ containerId } = await createContainer(
        { igUserId, token, videoUrl, caption: job.caption },
        deps.ig,
      ));
      if (!(await recordContainer(job.id, deps.holder, containerId)))
        return "lost";
    }

    // 5b. Wait for Instagram to prepare it — a few looks, then the next tick's turn.
    const deadline = Date.now() + pollWindowMs();
    for (;;) {
      const state = await checkStatus({ containerId, token }, deps.ig);
      switch (state.statusCode) {
        case "FINISHED":
          return await sendPublish(job, deps, fresh, containerId, gate);
        case "PUBLISHED":
          // Published, and not by an attempt of ours on this row. It is posted; say so — and from
          // here on nothing may call it refused.
          gate.passed = true;
          return await finishPosted(job, deps, token, null);
        case "EXPIRED":
          return await fail(job, deps, "expired", sentenceFor("expired"));
        case "ERROR": {
          // "If status_code is ERROR, this value will be an error subcode."
          const sub = Number(/\b(22070\d\d)\b/.exec(state.status ?? "")?.[1]);
          const code = Number.isFinite(sub)
            ? classifyMetaError({ error_subcode: sub })
            : "unknown";
          logger.warn(
            { publishId: job.id, status: state.status },
            "container errored",
          );
          return await fail(
            job,
            deps,
            code,
            `${sentenceFor(code)} Nothing was posted.`,
          );
        }
        case "IN_PROGRESS":
          break;
      }
      if (Date.now() + pollIntervalMs() > deadline) break;
      await deps.sleep(pollIntervalMs());
    }

    if (job.poll_count + 1 >= maxPolls())
      return await fail(
        job,
        deps,
        "transient",
        "Instagram took too long preparing this video. Nothing was posted — try again.",
      );
    const polls = await releaseForPoll(job.id, deps.holder);
    return polls === null ? "lost" : "waiting";
  } catch (err) {
    if (gate.passed) {
      logger.error(
        { err, publishId: job.id },
        "publish job crashed AFTER a publish attempt — leaving it for the reaper, never failing it as refused",
      );
      return "lost";
    }
    // Before any publish attempt: "nothing was posted" is true of everything that lands here.
    return await failWith(job, deps, err);
  }
}

// ─── The tick ──────────────────────────────────────────────────────────────────────────────────

const inFlight = new Set<string>();
export const inFlightCount = () => inFlight.size;

export interface PublishTickResult {
  reaped: PublishReapResult;
  claimed: number;
  inFlight: number;
  atCapacity: boolean;
  mode: string;
}

/**
 * One pass. RUNS WITH THE SWITCH OFF TOO — on purpose: `off` must close the jobs that were waiting
 * (workPublish arm 3 fails them; arms 1 and 2 still tell the truth about posts that already went
 * out), and it makes no Meta call to do it.
 */
export async function publishTick(
  deps: RunnerDeps = liveRunnerDeps(),
): Promise<PublishTickResult> {
  const reaped = await reapExpiredPublishLeases();
  const capacity = maxConcurrent() - inFlight.size;
  if (capacity <= 0)
    return {
      reaped,
      claimed: 0,
      inFlight: inFlight.size,
      atCapacity: true,
      mode: publishMode(),
    };

  const jobs = await claimPublishJobs(capacity, deps.holder);
  for (const job of jobs) {
    inFlight.add(job.id);
    void workPublish(job, deps)
      .catch((err) =>
        logger.error({ err, publishId: job.id }, "publish worker crashed"),
      )
      .finally(() => inFlight.delete(job.id));
  }
  return {
    reaped,
    claimed: jobs.length,
    inFlight: inFlight.size,
    atCapacity: false,
    mode: publishMode(),
  };
}
