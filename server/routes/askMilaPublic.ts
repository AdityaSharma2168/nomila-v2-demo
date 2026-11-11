/**
 * askMilaPublic.ts — the visitor's side of public Mila mode on /p/:handle (design-public-card-v3 §4, PR 5). Behind
 * PUBLIC_CARD and ASK_MILA_PUBLIC (askMila/config.ts): with either off every route here falls through to the app's 404.
 *
 *   POST /p/:handle/ask           one turn: { text ≤ 300, intent, sessionId?, token?, pinnedPickId?, tz? }
 *                                 → { sessionId, token, reply: { text, chapterId, widget }, limited, ended }
 *   POST /p/:handle/ask/booking   the visitor's tap on a prepared request card → the bookings port (404 until wired)
 *   POST /p/:handle/ask/partner   the visitor's tap on a prepared partner card → the intake port (404 until wired)
 *
 * Simple JSON, not SSE: the output gate must read the WHOLE answer before the visitor sees any of it, so there is
 * nothing to stream (the page's Mila sheet shows Mila's "searching" state while the request is in flight).
 *
 * The page is cookieless and these routes act on no ambient credential, so CSRF here is about keeping other sites from
 * spending a visitor's (or an athlete's) limits, and about one chat never being driven by anyone but its token holder:
 *   - JSON only (application/json) and a custom header X-Nomila-Ask: 1. Both force a CORS preflight, and the app's CORS
 *     layer never allows that header, so a cross-site page cannot send the request at all;
 *   - when the browser says where the request came from (Origin, Sec-Fetch-Site), it must be this site;
 *   - every chat is bound to a random token the visitor holds (stored as sha256); a tap needs the same token.
 * Plus a per-IP burst limiter (askMilaLimiter) in front of the DB-backed daily limits.
 *
 * Who the athlete is comes only from the handle, resolved on the server. Responses are no-store and noindex.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { askMilaLimiter } from "../lib/rateLimit";
import { sameSite } from "../lib/publicPost";
import { askMilaPublicEnabled } from "../services/askMila/config";
import { bookingTap, partnerTap, runPublicTurn, type TapResult } from "../services/askMila/turn";
import type { PartnerIntakePort, PublicBookingsPort, PublicMilaPorts } from "../mila/public/ports";
import { HANDLE_RE } from "./publicPage";
import { createLogger } from "../logger";

const logger = createLogger("routes/askMilaPublic");

export const ASK_HEADER = "x-nomila-ask";

const gate = (_req: Request, _res: Response, next: NextFunction) => (askMilaPublicEnabled() ? next() : next("router"));


function csrf(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Vary", "Origin");
  if (!req.is("application/json")) { res.status(415).json({ error: "JSON only." }); return; }
  if (req.get(ASK_HEADER) !== "1" || !sameSite(req)) { res.status(403).json({ error: "Not allowed." }); return; }
  if (!HANDLE_RE.test(req.params.handle ?? "")) { res.status(404).json({ error: "Not found." }); return; }
  next();
}

const TurnBody = z.object({
  text: z.string().max(2000),
  intent: z.enum(["ask", "partner", "book", "shop"]).optional(),
  sessionId: z.string().max(64).nullish(),
  token: z.string().max(128).nullish(),
  pinnedPickId: z.string().max(128).nullish(),
  tz: z.string().max(64).nullish(),
});

const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
  fn(req, res).catch((err) => {
    logger.error({ error: (err as Error).message }, "public Mila route failed");
    if (!res.headersSent) res.status(500).json({ error: "Mila can't answer right now." });
  });
};

function sendTap(res: Response, r: TapResult): void {
  if (r.status === "not_found") { res.status(404).json({ error: "Not found." }); return; }
  if (r.status === "invalid") { res.status(400).json({ error: r.error }); return; }
  if (r.status === "refused") { res.status(409).json({ error: "That couldn't be started.", reason: r.reason }); return; }
  res.json({ nextUrl: r.nextUrl, ...(r.ref ? { ref: r.ref } : {}) });
}

export interface AskMilaPublicRouterOptions {
  /** The bookings track's buyer API (feat/bookings-flow). null until it is wired: no slot tools, and the tap route 404s. */
  bookings?: PublicBookingsPort | null;
  /** The partner-intake track (feat/partner-intake-relay). null until it is wired: no partner tool, and the tap route 404s. */
  partner?: PartnerIntakePort | null;
}

export function createAskMilaPublicRouter(opts: AskMilaPublicRouterOptions = {}): Router {
  const ports: PublicMilaPorts = { bookings: opts.bookings ?? null, partner: opts.partner ?? null };
  const router = Router();

  router.post("/p/:handle/ask", gate, askMilaLimiter, csrf, wrap(async (req, res) => {
    const body = TurnBody.safeParse(req.body ?? {});
    if (!body.success) { res.status(400).json({ error: "Bad request." }); return; }
    const r = await runPublicTurn({
      handle: req.params.handle, text: body.data.text, intent: body.data.intent ?? "ask",
      sessionId: body.data.sessionId ?? null, token: body.data.token ?? null,
      pinnedPickId: body.data.pinnedPickId ?? null, tz: body.data.tz ?? null, ip: req.ip ?? "",
    }, ports);
    if (r.status === "not_found") { res.status(404).json({ error: "Not found." }); return; }
    if (r.status === "invalid") { res.status(400).json({ error: r.error }); return; }
    res.json({ sessionId: r.sessionId, token: r.token, reply: r.reply, limited: r.limited, ended: r.ended });
  }));

  router.post("/p/:handle/ask/booking", gate, askMilaLimiter, csrf, wrap(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    sendTap(res, await bookingTap({ handle: req.params.handle, sessionId: b.sessionId, token: b.token, offerId: b.offerId, slotId: b.slotId, times: b.times, note: b.note }, ports));
  }));

  router.post("/p/:handle/ask/partner", gate, askMilaLimiter, csrf, wrap(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    sendTap(res, await partnerTap({ handle: req.params.handle, sessionId: b.sessionId, token: b.token, kind: b.kind }, ports));
  }));

  return router;
}
