/**
 * studio/publish/routes — the three doors, mounted on the Studio router behind its gate.
 *
 *   GET  /studio/publish/options?assetId=   may she post, to whom, and what happened last time
 *   POST /studio/publish                    { assetId, platform, caption, approve? } → a queued job
 *   GET  /studio/publish/:publishId         where that job is. A READ: it drives nothing.
 *
 * They live here and not in routes/studio.ts so the whole feature can be read — and reverted — in
 * one folder; that file gains one import and one call. The gate is passed in, so these routes
 * cannot be mounted behind a different one by accident.
 *
 * ─── WHY /options IS OURS AND /connections IS NOT TOUCHED ───────────────────────────────────────
 *
 * The client cannot learn "may this account post?" from GET /connections: that route strips
 * `scopes` and answers in Gmail-shaped booleans, and it is shared code. So the Studio asks its own
 * question here and gets exactly the three facts the pill needs — connected, @handle, canPublish.
 * No token, no scope list and no account id leaves the server.
 *
 * ─── APPROVE, THEN QUEUE. IN THAT ORDER, AND THE SECOND ONLY AFTER THE FIRST COMMITS ────────────
 *
 * approval.ts: `approved` is "cleared for embed and publish" — so a draft does not post. Her ONE
 * confirm ("Approve and post to @handle") is two acts on the server: the approve door runs, through
 * setApprovalStatus and nothing else, and ONLY WHEN IT HAS RETURNED is a job created. If approval
 * fails there is no job. If approval succeeds and queueing fails she has an approved video and a
 * plain error. There is no ordering of failures that leaves a draft in the queue — and if there
 * were, `queue` re-resolves the video with requireApproved and the runner asks a third time.
 *
 * Every refusal that does not need approval — no account, no scope, too big, too short, caption too
 * long — is decided BEFORE the approve door, so she is never asked to clear a video that could not
 * have been posted anyway.
 *
 * ─── TENANCY ────────────────────────────────────────────────────────────────────────────────────
 *
 * `req.athleteId`, from the gate, into every lookup. An `athleteId`, an account id or a handle in
 * the body is ignored: the account is whichever row is HERS and active, resolved here, and pinned.
 *
 * ─── THE SWITCH ─────────────────────────────────────────────────────────────────────────────────
 *
 * STUDIO_PUBLISH_MODE=off: POST and the job read are 404 — the surface does not exist, the same
 * answer STUDIO_ENABLED=off gives. /options answers { mode: "off" } so the client can draw nothing.
 */
import type { Request, RequestHandler, Response, Router } from "express";
import { createLogger } from "../../logger";
import { setApprovalStatus } from "../approval";
import { isPublishPlatform, publishMode, PUBLISH_PLATFORMS } from "./config";
import {
  accountRefusal,
  currentInstagramAccount,
  resolvePostableAsset,
  type Refusal,
} from "./eligibility";
import {
  CAPTION_MAX_CHARS,
  CAPTION_MAX_HASHTAGS,
  CAPTION_MAX_MENTIONS,
  REEL_MAX_BYTES,
  REEL_MIN_SECONDS,
} from "./instagram";
import {
  queuePublish,
  readLatestPublishForAsset,
  readPublishJob,
} from "./jobs";
import type { StudioPublishJob } from "../../../shared/schema";

const logger = createLogger("studio/publish/routes");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOT_FOUND = {
  error: "That video could not be found.",
  code: "not_found",
};

/** What the client is told about a job. No container id, no media id, no account id. */
function shapeJob(job: StudioPublishJob) {
  return {
    publishId: job.id,
    assetId: job.asset_id,
    platform: job.platform,
    status: job.status,
    /** True only for a real post. A dry run that "succeeded" posted nothing, and says so. */
    posted: job.status === "succeeded" && job.mode === "live",
    dryRun: job.mode === "dry",
    permalink: job.permalink,
    error: job.last_error,
    errorCode: job.error_code,
    createdAt: job.created_at?.toISOString() ?? null,
    completedAt: job.completed_at?.toISOString() ?? null,
  };
}

const refuse = (res: Response, r: Refusal) =>
  res.status(r.status).json({ error: r.message, code: r.code });

/**
 * Her caption, or a sentence about why not. Length is counted in UTF-16 units — the LARGER of the
 * two ways to count — so a caption we accept can never be over Meta's 2,200 however Meta counts.
 */
export function parsePublishCaption(
  raw: unknown,
): { ok: true; caption: string } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, caption: "" };
  if (typeof raw !== "string")
    return { ok: false, message: "A caption has to be text." };
  const caption = raw.trim();
  if (caption.length > CAPTION_MAX_CHARS)
    return {
      ok: false,
      message: `Instagram captions can be up to ${CAPTION_MAX_CHARS.toLocaleString("en-US")} characters, and this one is ${caption.length.toLocaleString("en-US")}.`,
    };
  const hashtags = (caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
  if (hashtags > CAPTION_MAX_HASHTAGS)
    return {
      ok: false,
      message: `Instagram allows up to ${CAPTION_MAX_HASHTAGS} hashtags, and this caption has ${hashtags}.`,
    };
  const mentions = (caption.match(/(^|[^\w@])@[\w.]+/g) ?? []).length;
  if (mentions > CAPTION_MAX_MENTIONS)
    return {
      ok: false,
      message: `Instagram allows up to ${CAPTION_MAX_MENTIONS} @mentions, and this caption has ${mentions}.`,
    };
  return { ok: true, caption };
}

export function registerPublishRoutes(
  router: Router,
  gate: readonly RequestHandler[],
): void {
  // ─── GET /studio/publish/options ────────────────────────────────────────────────────────────
  // DECLARED BEFORE /studio/publish/:publishId ON PURPOSE. Express matches in order, and "options"
  // is not a UUID — but a route that depends on a regex elsewhere to stay reachable is one edit
  // from unreachable.
  router.get(
    "/studio/publish/options",
    ...gate,
    async (req: Request, res: Response): Promise<void> => {
      const athleteId = req.athleteId as string;
      const mode = publishMode();
      if (mode === "off") {
        res.json({ mode });
        return;
      }
      try {
        const account = await currentInstagramAccount(athleteId);
        const body: Record<string, unknown> = {
          mode,
          platforms: PUBLISH_PLATFORMS,
          instagram: {
            connected: !!account,
            handle: account?.handle ?? null,
            // OUR RECORDS' answer. Meta has the last word, at the runner's first call.
            canPublish: accountRefusal(account) === null,
          },
          limits: {
            captionMaxChars: CAPTION_MAX_CHARS,
            minSeconds: REEL_MIN_SECONDS,
            maxBytes: REEL_MAX_BYTES,
          },
        };

        const assetId = req.query.assetId;
        if (typeof assetId === "string") {
          if (!UUID_RE.test(assetId)) {
            res.status(404).json(NOT_FOUND);
            return;
          }
          // requireApproved: false — a draft has to be DESCRIBED so the pill can offer to approve it.
          const resolved = await resolvePostableAsset(athleteId, assetId, {
            requireApproved: false,
          });
          if (!resolved.ok && resolved.status === 404) {
            res.status(404).json(NOT_FOUND);
            return;
          }
          const latest = await readLatestPublishForAsset(
            athleteId,
            assetId,
            "instagram",
          );
          body.asset = resolved.ok
            ? {
                postable: true,
                approvalStatus: resolved.asset.approvalStatus,
                needsApproval: resolved.asset.approvalStatus !== "approved",
              }
            : {
                postable: false,
                refusal: { code: resolved.code, message: resolved.message },
              };
          body.latest = latest ? shapeJob(latest) : null;
        }
        res.json(body);
      } catch (err) {
        logger.error({ err, athleteId }, "studio publish options failed");
        res.status(500).json({ error: "Couldn't check posting right now." });
      }
    },
  );

  // ─── POST /studio/publish ───────────────────────────────────────────────────────────────────
  router.post(
    "/studio/publish",
    ...gate,
    async (req: Request, res: Response): Promise<void> => {
      const athleteId = req.athleteId as string;
      const mode = publishMode();
      if (mode === "off") {
        res.status(404).json({ error: "Not found" });
        return;
      }

      const {
        assetId,
        platform,
        caption: rawCaption,
        approve,
      } = (req.body ?? {}) as Record<string, unknown>;
      if (!isPublishPlatform(platform)) {
        res.status(400).json({
          error: `Posting is available for: ${PUBLISH_PLATFORMS.join(", ")}.`,
          code: "bad_platform",
          field: "platform",
        });
        return;
      }
      if (typeof assetId !== "string" || !UUID_RE.test(assetId)) {
        res.status(404).json(NOT_FOUND);
        return;
      }
      const parsed = parsePublishCaption(rawCaption);
      if (!parsed.ok) {
        res.status(400).json({
          error: parsed.message,
          code: "bad_caption",
          field: "caption",
        });
        return;
      }

      try {
        // 1. The video — hers, a video, inside Instagram's limits. Approval is looked at in (3).
        const resolved = await resolvePostableAsset(athleteId, assetId, {
          requireApproved: false,
        });
        if (!resolved.ok) {
          refuse(res, resolved);
          return;
        }

        // 2. The account — HERS, resolved here, never taken from the body.
        const account = await currentInstagramAccount(athleteId);
        const noAccount = accountRefusal(account);
        if (noAccount || !account) {
          refuse(
            res,
            noAccount ?? {
              ok: false,
              status: 409,
              code: "not_connected",
              message: "",
            },
          );
          return;
        }

        // 3. APPROVE — and only then (4). See the header.
        const approval = resolved.asset.approvalStatus;
        if (approval !== "approved") {
          if (approve !== true || approval !== "draft") {
            res.status(409).json({
              error:
                approval === "rejected"
                  ? "This video was turned down. Move it back to a draft before posting it."
                  : "Approve this video before posting it.",
              code: "not_approved",
            });
            return;
          }
          try {
            // THE ONE DOOR that may move approval_status. Awaited: nothing below runs until it commits.
            await setApprovalStatus(athleteId, assetId, "approved");
          } catch (err) {
            logger.warn(
              { err, athleteId, assetId },
              "approve-and-post: approval did not go through",
            );
            res.status(409).json({
              error:
                "Couldn't approve this video, so it wasn't posted. Try again.",
              code: "not_approved",
            });
            return;
          }
        }

        // 4. QUEUE. Re-resolved WITH requireApproved, so this line cannot queue a draft even if the
        //    lines above are one day rearranged.
        const cleared = await resolvePostableAsset(athleteId, assetId);
        if (!cleared.ok) {
          refuse(res, cleared);
          return;
        }
        const queued = await queuePublish({
          athleteId,
          assetId: cleared.asset.id,
          connectedAccountId: account.id,
          platform,
          caption: parsed.caption,
          mode,
        });

        res.status(202).json({
          publishId: queued.id,
          status: "queued",
          alreadyLive: queued.alreadyLive,
          dryRun: mode === "dry",
          handle: account.handle,
        });

        // Kick a tick so she is not waiting on the scheduler's minute. Best-effort: the scheduled
        // tick picks it up regardless. The response is already sent — a poll never drives execution.
        void import("./runner.js")
          .then(({ publishTick }) => publishTick())
          .catch((err) =>
            logger.warn(
              { err, publishId: queued.id },
              "publish kick failed — the scheduled tick will pick it up",
            ),
          );
      } catch (err) {
        logger.error({ err, athleteId }, "studio publish queue failed");
        res.status(500).json({
          error: "Couldn't start that post right now. Nothing was posted.",
        });
      }
    },
  );

  // ─── GET /studio/publish/:publishId ─────────────────────────────────────────────────────────
  // Reconnect-and-refresh. Drives no execution: the runner works the queue on its own tick.
  router.get(
    "/studio/publish/:publishId",
    ...gate,
    async (req: Request, res: Response): Promise<void> => {
      const athleteId = req.athleteId as string;
      const publishId = req.params.publishId;
      if (publishMode() === "off" || !UUID_RE.test(publishId)) {
        res.status(404).json({ error: "No such post" });
        return;
      }
      try {
        const job = await readPublishJob(athleteId, publishId);
        if (!job) {
          res.status(404).json({ error: "No such post" });
          return;
        }
        res.json(shapeJob(job));
      } catch (err) {
        logger.error(
          { err, athleteId, publishId },
          "studio publish read failed",
        );
        res.status(500).json({ error: "Couldn't check that post right now." });
      }
    },
  );
}
