/**
 * studio/enrich/routes — `POST /studio/media/:id/read` (PR 9.5, F22 B2).
 *
 * Behind the Studio gate, STUDIO_CLIP_READ and STUDIO_VIDEO_ENRICH. Off, the door is not there — a
 * 404 before any row is read, the edit routes' shape. Answers `{status, quotedUsd?, beats?, reason?}`;
 * never throws to the client. Ids and counts are logged, never the beats.
 */
import type { Request, RequestHandler, Response, Router } from "express";
import { createLogger } from "../../logger";
import { clipReadEnabled, videoEnrichEnabled } from "./config";
import { CLIP_READ_GRACE_MS, startClipRead } from "./clipRead";

const logger = createLogger("studio/enrich/routes");
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Off, the door is not there: a 404, not a 403, so the flag's state is not readable from outside. */
const requireClipRead: RequestHandler = (_req, res, next) => {
  // ⚠️ MUTATION (clipRead.test): drop either flag — "the read route is there with the flag off" reds.
  if (!clipReadEnabled() || !videoEnrichEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
};

export function registerClipReadRoutes(
  router: Router,
  gate: readonly RequestHandler[],
): void {
  router.post(
    "/studio/media/:id/read",
    ...gate,
    requireClipRead,
    async (req: Request, res: Response): Promise<void> => {
      const athleteId = req.athleteId as string;
      const assetId = String(req.params.id ?? "").toLowerCase();
      if (!UUID_RE.test(assetId)) {
        res.status(404).json({ error: "No such clip" });
        return;
      }
      try {
        const { enrichOneClip } = await import(
          "../../services/mediaEnrichment.js"
        );
        const { answer } = await startClipRead({
          athleteId,
          assetId,
          enrich: enrichOneClip,
          graceMs: CLIP_READ_GRACE_MS,
        });
        if (answer.status === "not_found") {
          res.status(404).json({ error: "No such clip" });
          return;
        }
        if (answer.status === "not_video") {
          res.status(409).json({ error: answer.reason, ...answer });
          return;
        }
        res.status(200).json(answer);
      } catch (err) {
        logger.error({ err, athleteId, assetId }, "clip read failed");
        res.status(500).json({ error: "Couldn't read that clip right now." });
      }
    },
  );
}
