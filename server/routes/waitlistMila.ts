/**
 * routes/waitlistMila.ts — Mila hosts the landing's waitlist join flow (MILA_TF_WAITLIST, dev only;
 * docs/design/mila-hosted-waitlist.md). Mounted at /api/v1/waitlist/mila. Auth as the other waitlist routes: the
 * landing's Firebase ID token (revocation-checked), so a WAITLISTED athlete (not let into the app) can use it; the
 * athlete is always the token's, never the body's.
 *
 *   GET  /       → { enabled }: whether the landing should run the conversation (false ⇒ today's screens, unchanged)
 *   POST /turn   SSE. Body { moment } (one of WAITLIST_MOMENTS) or { message } (her words, ≤ 1,000 characters), exactly
 *                one. Streams `{ token }`, then one `{ done: true, runId, cards, status, stopReason }`; `status` other
 *                than "completed" tells the landing to fall back to today's screens. 404 with the flag off.
 *                Per signed-in user: 30 turns per 10 minutes (a 429 carries Retry-After). The day cost cap applies.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { athletes } from "../../shared/schema";
import { tokenFailure, verifyIdTokenChecked } from "../lib/auth";
import { openSSEStream, type SSEStream } from "../lib/sse";
import { createLogger } from "../logger";
import { milaWaitlistEnabled } from "../agent/engine/config";
import { isWaitlistMoment, runWaitlistTurn } from "../agent/waitlist/turn";

const logger = createLogger("routes/waitlist-mila");
export const WAITLIST_MESSAGE_MAX = 1000;

type Deps = { runTurn?: typeof runWaitlistTurn; verify?: (token: string) => Promise<{ uid: string }> };

export function createWaitlistMilaRouter(deps: Deps = {}): Router {
  const router = Router();
  const verify = deps.verify ?? (async (t: string) => verifyIdTokenChecked(t));
  const runTurn = deps.runTurn ?? runWaitlistTurn;

  async function caller(req: Request, res: Response, next: NextFunction): Promise<void> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) { res.status(401).json({ error: "Sign in first" }); return; }
    try {
      res.locals.waitlistUid = (await verify(header.slice(7))).uid;
    } catch (err) {
      const f = tokenFailure(err);
      res.status(f.status === 503 ? 503 : 401).json(f.status === 503 ? f.body : { error: "Sign in first" });
      return;
    }
    next();
  }

  const turnLimiter = rateLimit({
    windowMs: 10 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (_req: Request, res: Response) => `uid:${res.locals.waitlistUid as string}`,
    message: { error: "Too many messages — please slow down and try again shortly." },
  });

  router.get("/", caller, (_req, res) => { res.status(200).json({ enabled: milaWaitlistEnabled() }); });

  router.post("/turn", caller, turnLimiter, async (req: Request, res: Response): Promise<void> => {
    if (!milaWaitlistEnabled()) { res.status(404).json({ error: "Not found" }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const moment = body.moment ?? null;
    const message = typeof body.message === "string" ? body.message.replace(/\s+/g, " ").trim() : null;
    if ((moment == null) === (message == null || message === "")) { res.status(400).json({ error: "send a moment or a message" }); return; }
    if (moment != null && !isWaitlistMoment(moment)) { res.status(400).json({ error: "unknown moment" }); return; }
    if (message && message.length > WAITLIST_MESSAGE_MAX) { res.status(400).json({ error: "message is too long" }); return; }

    const [me] = await db.select({ id: athletes.id }).from(athletes).where(eq(athletes.auth_id, res.locals.waitlistUid as string)).limit(1);
    if (!me) { res.status(404).json({ error: "Not on the waitlist yet" }); return; }

    const sse = openSSEStream(res, req);
    // `done` waits for the turn's result so the landing learns whether to fall back (status, stopReason).
    let doneData: Record<string, unknown> | null = null;
    const held: SSEStream = Object.create(sse, { done: { value: (d: Record<string, unknown> = {}) => { doneData = d; } } });
    try {
      const r = await runTurn({ athleteId: me.id, moment: moment as any, message: message || null, sse: held });
      if (!sse.closed) sse.done({ ...(doneData ?? { runId: r.runId }), status: r.status, stopReason: r.stopReason });
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        logger.error({ athleteId: me.id, error: String(err?.message ?? err).slice(0, 200) }, "waitlist Mila turn failed");
        if (!sse.closed) sse.done({ status: "failed", stopReason: "error" });
      }
    } finally {
      sse.close();
    }
  });

  return router;
}

export default createWaitlistMilaRouter();
