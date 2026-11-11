/**
 * agent/postKit/routes.ts — the post kit API (mounted under /api/v1/me, requireAuth), dark behind AGENT_POST_KITS.
 *
 *   GET   /agent/actions/:id/post-kit                              the kit and its media (PostKitResponse)
 *   POST  /agent/actions/:id/post-kit                              build it now (a post action still to start)
 *   POST  /agent/actions/:id/post-kit/swap     { replace, with }   swap one asset for one on the kit's shortlist
 *   PATCH /agent/actions/:id/post-kit/caption  { text }            the athlete's own caption
 *   POST  /agent/actions/:id/post-kit/music    { track }           switch to another suggested track, or null for none
 *   POST  /agent/actions/:id/post-kit/posted   { link?, postedAt? } "I posted it": answers the action (response accepted)
 *   POST  /agent/actions/:id/post-kit/preview                      ask for the preview render again (AGENT_POST_KIT_RENDER)
 *   POST  /agent/actions/:id/post-kit/use      { assetId }         CAMERA_ROLL_INTAKE: a photo or clip she just imported
 *                                                                  for this post goes into its empty kit (404 while off)
 *
 * Tenancy: the athlete id is always req.athleteId (from the token); nothing in a body or path picks an athlete. The
 * decision is read through the athlete-scoped store, and every asset through the athlete's own predicate, so another
 * athlete's action or asset answers "not found".
 *
 * Light at load: the services (and the library port, which builds cloud clients) are imported on first use.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../lib/auth";
import { createLogger } from "../../logger";
import type { PostKitDeps } from "./build";
import { agentPostKitsEnabled } from "./config";
import { PostKitError } from "./errors";
import { cameraRollIntakeEnabled } from "../../lib/cameraRollIntake";

const logger = createLogger("agent/postKit/routes");

export { agentPostKitsEnabled };

const body = (req: Request) => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});

function fail(res: Response, err: any, what: string): void {
  if (err instanceof PostKitError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
  logger.error({ error: String(err?.message ?? err).slice(0, 300) }, what);
  res.status(500).json({ error: "Internal server error" });
}

type Services = typeof import("./edit") & typeof import("./build");

const handle = (what: string, f: (req: Request, s: Services, deps: PostKitDeps) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    const [edit, build, { dbPostKitDeps }] = await Promise.all([import("./edit"), import("./build"), import("./deps")]);
    res.json(await f(req, { ...edit, ...build }, dbPostKitDeps()));
  } catch (err) { fail(res, err, what); }
};

export const agentPostKitRouter = Router();

agentPostKitRouter.get("/agent/actions/:id/post-kit", requireAuth, handle("post kit read failed", (req, s, deps) => s.readPostKit(deps, req.athleteId!, req.params.id)));

agentPostKitRouter.post("/agent/actions/:id/post-kit", requireAuth, handle("post kit build failed", async (req, s, deps) => {
  // The athlete asked: a hold with unchanged inputs answers at once, unless it is older than HOLD_RETRY_MS (build.ts).
  const outcome = await s.buildPostKit(deps, req.athleteId!, req.params.id, { trigger: "event", parentRef: null, asked: true });
  return { outcome, ...(await s.readPostKit(deps, req.athleteId!, req.params.id)) };
}));

agentPostKitRouter.post("/agent/actions/:id/post-kit/swap", requireAuth, handle("post kit swap failed", (req, s, deps) =>
  s.swapAsset(deps, req.athleteId!, req.params.id, { replace: body(req).replace, with: body(req).with })));

agentPostKitRouter.patch("/agent/actions/:id/post-kit/caption", requireAuth, handle("post kit caption failed", (req, s, deps) =>
  s.editCaption(deps, req.athleteId!, req.params.id, { text: body(req).text })));

agentPostKitRouter.post("/agent/actions/:id/post-kit/music", requireAuth, handle("post kit music failed", (req, s, deps) =>
  s.chooseTrack(deps, req.athleteId!, req.params.id, { track: body(req).track })));

agentPostKitRouter.post("/agent/actions/:id/post-kit/posted", requireAuth, handle("post kit posted failed", (req, s, deps) =>
  s.markPosted(deps, req.athleteId!, req.params.id, { link: body(req).link, postedAt: body(req).postedAt })));

agentPostKitRouter.post("/agent/actions/:id/post-kit/preview", requireAuth, handle("post kit preview failed", (req, s, deps) =>
  s.renderPreview(deps, req.athleteId!, req.params.id)));

agentPostKitRouter.post("/agent/actions/:id/post-kit/use", requireAuth, handle("post kit use failed", async (req, s, deps) => {
  if (!cameraRollIntakeEnabled()) throw new PostKitError("Not found", 404, "not_found");
  return s.useAsset(deps, req.athleteId!, req.params.id, { assetId: body(req).assetId });
}));
