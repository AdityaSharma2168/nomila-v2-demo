/**
 * agent/ready/routes.ts — "Ready for you" (mounted under /api/v1/me, requireAuth; shared/readyQueue.ts):
 *
 *   GET  /engine/items?state=ready|posted     ReadyQueueResponse (state defaults to ready)
 *   POST /engine/items/:id/posted             { link?, postedAt? } → { item, receipt }   "I posted it"
 *   POST /engine/items/:id/approve            { ownMedia?, sponsoredRights?, disclosure? } → ApproveResponse   "Post it" (rights.ts)
 *   GET  /engine/rights                       { attestations }   every live rights word
 *   POST /engine/rights/:id/revoke            { revoked: true }  take one back (asked again next time)
 *
 * The paths are the content engine plan's (Part C "Endpoints and job events"), so Studio and Home call the address the
 * engine keeps; today an item is a post kit and these sit over the post-kit services (agent/ready/queue.ts).
 *
 * Mounted only while CONTENT_READY_QUEUE is "true" AND AGENT_POST_KITS is on (config.ts). Tenancy: the athlete id is
 * always req.athleteId (from the token); another athlete's item answers "not found". Nothing here posts anything.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../lib/auth";
import { createLogger } from "../../logger";
import { DISCLOSURE_ANSWERS, READY_STATES, type DisclosureAnswer, type ReadyState } from "../../../shared/readyQueue";
import { PostKitError } from "../postKit/errors";
import type { RightsDeps } from "./rights";

const logger = createLogger("agent/ready/routes");

export { contentReadyQueueEnabled } from "./config";

function fail(res: Response, err: any, what: string): void {
  if (err instanceof PostKitError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
  logger.error({ error: String(err?.message ?? err).slice(0, 300) }, what);
  res.status(500).json({ error: "Internal server error" });
}

const body = (req: Request) => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});

/** The production wiring, loaded on first use (the library port builds cloud clients at load). */
async function prodDeps(): Promise<RightsDeps> {
  const [{ dbPostKitDeps }, { dbRightsStore }] = await Promise.all([import("../postKit/deps"), import("./rights")]);
  return { ...dbPostKitDeps(), rights: dbRightsStore };
}

export function readyQueueRouter(opts: { deps?: () => Promise<RightsDeps> | RightsDeps } = {}): Router {
  const router = Router();
  const depsOf = async () => (opts.deps ? opts.deps() : prodDeps());

  router.get("/engine/items", requireAuth, async (req: Request, res: Response) => {
    const raw = typeof req.query.state === "string" ? req.query.state : "ready";
    if (!(READY_STATES as readonly string[]).includes(raw)) { res.status(400).json({ error: `state must be one of ${READY_STATES.join(", ")}`, code: "bad_state" }); return; }
    try {
      const { listQueue } = await import("./queue");
      res.json(await listQueue(await depsOf(), req.athleteId!, raw as ReadyState));
    } catch (err) { fail(res, err, "ready queue read failed"); }
  });

  router.post("/engine/items/:id/posted", requireAuth, async (req: Request, res: Response) => {
    try {
      const { markItemPosted } = await import("./queue");
      res.json(await markItemPosted(await depsOf(), req.athleteId!, req.params.id, { link: body(req).link as string | null | undefined, postedAt: body(req).postedAt as string | null | undefined }));
    } catch (err) { fail(res, err, "ready item posted failed"); }
  });

  router.post("/engine/items/:id/approve", requireAuth, async (req: Request, res: Response) => {
    try {
      const { approveItem } = await import("./rights");
      const b = body(req);
      res.json(await approveItem(await depsOf(), req.athleteId!, req.params.id, { ownMedia: b.ownMedia === true, sponsoredRights: b.sponsoredRights === true, ...(typeof b.disclosure === "string" && (DISCLOSURE_ANSWERS as readonly string[]).includes(b.disclosure) ? { disclosure: b.disclosure as DisclosureAnswer } : {}) }));
    } catch (err) { fail(res, err, "ready item approve failed"); }
  });

  router.get("/engine/rights", requireAuth, async (req: Request, res: Response) => {
    try {
      const { listRights } = await import("./rights");
      res.json({ attestations: await listRights(await depsOf(), req.athleteId!) });
    } catch (err) { fail(res, err, "rights read failed"); }
  });

  router.post("/engine/rights/:id/revoke", requireAuth, async (req: Request, res: Response) => {
    try {
      const { revokeRights } = await import("./rights");
      res.json(await revokeRights(await depsOf(), req.athleteId!, req.params.id));
    } catch (err) { fail(res, err, "rights revoke failed"); }
  });

  return router;
}

export const readyRouter = readyQueueRouter();
