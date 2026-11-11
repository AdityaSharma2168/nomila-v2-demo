/**
 * bookingSession.ts — Bookings v2: the session itself and the after-session taps. Dark unless BOOKINGS_ENABLED=true.
 *
 * HER (mounted at /api/v1/me; requireAuth; the athlete is req.athleteId and every booking is checked to be hers — a
 * booking that is not hers answers 404, the same as one that does not exist):
 *   GET  /bookings/:id/session            → AthleteSessionView (the join window, the fallback link, attendance, taps)
 *   POST /bookings/:id/session/token      → a LiveKit join token, only inside the join window (rate-limited)
 *   POST /bookings/:id/session-done       → "Session done": notifies the buyer; never moves money
 *   POST /bookings/:id/buyer-no-show      → "Buyer didn't show", from start + 15 min; paid on the normal clock
 *   POST /bookings/:id/report             → "Report a problem": holds the money, emails support
 *   POST /bookings/:id/checkin            → "I'm OK" after an in-person session
 *   POST /bookings/:id/session/remove     { identity } → take the booker or an invited friend out of the call (0153);
 *                                         they get no new join token. An open-group booking acts on its whole time.
 *   POST /bookings/:id/session/mute       { identity, track: "microphone" | "camera" } → mute that person's mic or turn
 *                                         off their camera now (0154; they can turn it back on). Recorded on the booking.
 *   (Block — take them out AND block them — is POST /bookings/:id/block in routes/bookings.ts, 0154.)
 *   OPEN GROUP TIMES (0153; one room per slot, services/bookings/groups.ts):
 *   POST /bookings/groups/:slotId/session/token    → her join token for the time's ONE room (inside the join window)
 *   POST /bookings/groups/:slotId/session/remove   { identity } → take one fan out of the call
 *   POST /bookings/groups/:slotId/session/mute     { identity, track } → mute one fan's mic / turn off their camera (0154) *
 * THE BUYER (no account; a signed session link for ONE booking, see sessionLink.ts; per-IP rate limit). A private-group
 * friend (0153) has their own signed link (purpose "guest") to the same page: they can join, but "It happened" and
 * "Report a problem" are the booker's (403 not_allowed):
 *   GET  /s/:token                        → the call page (pre-join device check, the call, "How did it go?")
 *   GET  /s/:token/state                  → BuyerSessionView
 *   POST /s/:token/join                   → a LiveKit join token, only inside the window, only a verified buyer (never
 *                                           for someone she blocked: the same "not joinable" answer as any refusal).
 *                                           In a group call the answer carries startMuted (0154): the page joins muted.
 *   POST /s/:token/happened               → "It happened": releases her payment now (releaseGate)
 *   POST /s/:token/report                 → "Report a problem"
 *   GET  /ok/:token                       → the in-person check-in page her friend opens (no script)
 *
 * LIVEKIT:  POST /api/webhooks/livekit    → attendance evidence (signature-verified; raw body)
 * CRON:     POST /api/internal/booking-session-cron → the session sweep (x-cron-secret; advisory-locked)
 *
 * The gate (BOOKINGS_ENABLED) runs BEFORE auth on every route, so with bookings off each one is a 404 whoever asks.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { bookingSessionPublicLimiter, bookingSessionTokenLimiter } from "../lib/rateLimit";
import { htmlEscape, makeCspNonce } from "../lib/securityHeaders";
import { createLogger } from "../logger";
import { BOOKINGS } from "../services/bookings/config";
import { SessionError, httpStatusFor, type BookingForSession, type SessionRole } from "../services/bookings/session/sessionPorts";
import { SessionLinkConfigError, verifySessionLink } from "../services/bookings/session/sessionLink";
import { joinRefusal, missingLivekitEnv, mintJoinToken } from "../services/bookings/session/sessionRoom";
import { guestByLink } from "../services/bookings/guests";
import {
  callParticipants, groupSessionForJoin, muteCallMember, removeFromBookingCall, removeFromGroupCall, slotJoinableBookingIds,
} from "../services/bookings/groups";
import { callerIsBlocked } from "../services/bookings/blocking";
import type { BookingGuest } from "../../shared/schema";
import { athleteView, buyerView, isGroupAudience } from "../services/bookings/session/sessionView";
import {
  attendanceSummary, checkIn, checkinUrlFor, getAthleteBooking, getBookingForSession, isRemovedFromCall, isReportCategory, lastCheckIn,
  markBuyerNoShow, markItHappened, markSessionDone, recordJoinTapped, reportProblem,
} from "../services/bookings/session/sessionStore";
import { WebhookAuthError, handleLivekitWebhook } from "../services/bookings/session/livekitWebhook";
import { runBookingSessionSweep } from "../services/bookings/session/sessionSweep";

const logger = createLogger("routes/bookingSession");

/** The livekit-client build the buyer page loads: pinned, and verified by SRI in the page itself. */
export const LIVEKIT_CLIENT_URL = "https://cdn.jsdelivr.net/npm/livekit-client@2.21.0/dist/livekit-client.umd.js";

function gate(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store");
  if (!BOOKINGS.enabled) { res.status(404).json({ error: "Not found" }); return; }
  next();
}

function fail(res: Response, err: unknown): void {
  if (err instanceof SessionError) { res.status(httpStatusFor(err.code)).json({ error: err.code, ...(err.detail ?? {}) }); return; }
  if (err instanceof SessionLinkConfigError) { res.status(503).json({ error: "not_configured" }); return; }
  // The bookings services' coded errors (groups.ts, guests.ts).
  const code = (err as { code?: string })?.code;
  if (code === "NOT_FOUND") { res.status(404).json({ error: "not_found" }); return; }
  if (code === "INVALID") { res.status(400).json({ error: "bad_request", detail: (err as any).detail }); return; }
  logger.error({ error: (err as Error)?.message }, "booking session route failed");
  res.status(500).json({ error: "Internal server error" });
}

async function joinToken(res: Response, b: BookingForSession, role: SessionRole, guest?: BookingGuest): Promise<void> {
  const missing = missingLivekitEnv();
  if (missing.length) {
    logger.warn({ missing }, "Booking video not configured");
    res.status(503).json({ error: "video_not_configured", missing });
    return;
  }
  const now = new Date();
  const refusal = joinRefusal(b, role, now);
  if (refusal) { res.status(403).json({ error: refusal }); return; }
  // She took this person out of the call (0153): their link no longer gets them back in.
  if (role !== "athlete" && await isRemovedFromCall(b.id, guest ? `guest:${guest.id}` : "buyer")) { res.status(403).json({ error: "removed" }); return; }
  // Someone she blocked (0154) gets the same answer as any call that can't be joined: never "you are blocked".
  if (role !== "athlete" && await callerIsBlocked(b, guest)) { res.status(403).json({ error: "not_joinable" }); return; }
  try {
    const t = await mintJoinToken(b, role, now, guest ? { id: guest.id, name: guest.name } : undefined);
    logger.info({ bookingId: b.id, role, room: t.room }, "booking video token issued");
    // join_tapped (0154): weak evidence this side came (once per identity per booking). Her join in an open group's
    // ONE room is recorded on every live spot, as the webhook does with her LiveKit join.
    const ids = role === "athlete" && b.audience === "open_group" && b.slotId ? await slotJoinableBookingIds(b.slotId) : [b.id];
    await recordJoinTapped(ids, role, t.identity, guest?.id).catch((err: any) => logger.warn({ error: err?.message }, "join_tapped not recorded"));
    res.json({ ...t, startMuted: role !== "athlete" && isGroupAudience(b.audience) });
  } catch (err: any) {
    // Never echo err.message: a malformed-credential failure can quote the key.
    logger.error({ bookingId: b.id, error: err.message }, "booking video token mint failed");
    res.status(500).json({ error: "Internal server error" });
  }
}

// ─── Her routes ──────────────────────────────────────────────────────────────────────────────────────────────────

export const athleteSessionRouter = Router();
athleteSessionRouter.use("/bookings/:id", gate);

athleteSessionRouter.get("/bookings/:id/session", requireAuth, async (req: Request, res: Response) => {
  try {
    const b = await getAthleteBooking(String(req.params.id), req.athleteId!);
    const now = new Date();
    const checkin = b.locationMode === "in_person" ? checkinUrlFor(b, now) : null;
    res.json(athleteView(b, await attendanceSummary(b.id), await lastCheckIn(b.id), now, checkin, await callParticipants(b)));
  } catch (err) { fail(res, err); }
});

athleteSessionRouter.post("/bookings/:id/session/token", requireAuth, bookingSessionTokenLimiter, async (req: Request, res: Response) => {
  try {
    const b = await getAthleteBooking(String(req.params.id), req.athleteId!);
    await joinToken(res, b, "athlete");
  } catch (err) { fail(res, err); }
});

athleteSessionRouter.post("/bookings/:id/session-done", requireAuth, async (req: Request, res: Response) => {
  try { res.json(await markSessionDone(String(req.params.id), req.athleteId!)); } catch (err) { fail(res, err); }
});

athleteSessionRouter.post("/bookings/:id/buyer-no-show", requireAuth, async (req: Request, res: Response) => {
  try { res.json(await markBuyerNoShow(String(req.params.id), req.athleteId!)); } catch (err) { fail(res, err); }
});

athleteSessionRouter.post("/bookings/:id/report", requireAuth, async (req: Request, res: Response) => {
  try {
    await getAthleteBooking(String(req.params.id), req.athleteId!);
    const { category, details } = (req.body ?? {}) as { category?: unknown; details?: unknown };
    if (!isReportCategory(category)) { res.status(400).json({ error: "bad_request", field: "category" }); return; }
    res.json(await reportProblem({ bookingId: String(req.params.id), by: "athlete", category, details: typeof details === "string" ? details : null }));
  } catch (err) { fail(res, err); }
});

athleteSessionRouter.post("/bookings/:id/checkin", requireAuth, async (req: Request, res: Response) => {
  try { res.json(await checkIn(String(req.params.id), req.athleteId!)); } catch (err) { fail(res, err); }
});

athleteSessionRouter.post("/bookings/:id/session/remove", requireAuth, async (req: Request, res: Response) => {
  try { res.json(await removeFromBookingCall(req.athleteId!, String(req.params.id), req.body?.identity)); } catch (err) { fail(res, err); }
});

athleteSessionRouter.post("/bookings/:id/session/mute", requireAuth, async (req: Request, res: Response) => {
  try { res.json(await muteCallMember(req.athleteId!, { bookingId: String(req.params.id) }, req.body?.identity, req.body?.track)); } catch (err) { fail(res, err); }
});

// ── An open group's time (0153): ONE room per slot ──
athleteSessionRouter.use("/bookings/groups/:slotId", gate);
athleteSessionRouter.post("/bookings/groups/:slotId/session/token", requireAuth, bookingSessionTokenLimiter, async (req: Request, res: Response) => {
  try {
    const b = await groupSessionForJoin(req.athleteId!, String(req.params.slotId));
    await joinToken(res, b, "athlete");
  } catch (err) { fail(res, err); }
});
athleteSessionRouter.post("/bookings/groups/:slotId/session/remove", requireAuth, async (req: Request, res: Response) => {
  try { res.json(await removeFromGroupCall(req.athleteId!, String(req.params.slotId), req.body?.identity)); } catch (err) { fail(res, err); }
});
athleteSessionRouter.post("/bookings/groups/:slotId/session/mute", requireAuth, async (req: Request, res: Response) => {
  try { res.json(await muteCallMember(req.athleteId!, { slotId: String(req.params.slotId) }, req.body?.identity, req.body?.track)); } catch (err) { fail(res, err); }
});
// ─── The buyer's session page ────────────────────────────────────────────────────────────────────────────────────

export const buyerSessionRouter = Router();
buyerSessionRouter.use(["/s/:token", "/ok/:token"], gate);

interface Caller { b: BookingForSession; role: "buyer" | "guest"; guest?: BookingGuest }

/**
 * Who a /s/ link is: the booker (a "session" link for their booking) or a private-group friend (a "guest" link for their
 * booking_guests row, not revoked). Null for anything else.
 */
async function resolveLink(token: unknown): Promise<Caller | null> {
  const id = verifySessionLink(token, "session");
  if (id) { const b = await getBookingForSession(id); return b ? { b, role: "buyer" } : null; }
  const g = await guestByLink(token);
  if (!g) return null;
  const b = await getBookingForSession(g.bookingId);
  return b ? { b, role: "guest", guest: g.guest } : null;
}

/** The caller a session link names, or a 404 for anything that is not a valid, unexpired session (or guest) link. */
async function buyerBooking(req: Request, res: Response): Promise<Caller | null> {
  const c = await resolveLink(req.params.token);
  if (!c) { res.status(404).json({ error: "not_found" }); return null; }
  return c;
}

/** "It happened" and reports move or hold the booker's money: never a friend's tap. */
function payerOnly(c: Caller, res: Response): boolean {
  if (c.role === "buyer") return true;
  res.status(403).json({ error: "not_allowed" });
  return false;
}

function setSessionPageCsp(res: Response, nonce: string): void {
  const connect = new Set(["'self'", "wss://*.livekit.cloud", "https://*.livekit.cloud"]);
  const configured = process.env.LIVEKIT_URL?.trim();
  if (configured) {
    try { const { host } = new URL(configured); connect.add(`wss://${host}`); connect.add(`https://${host}`); } catch { /* reported by the token route */ }
  }
  res.setHeader("Content-Security-Policy", [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${LIVEKIT_CLIENT_URL}`,
    `style-src 'nonce-${nonce}' https://fonts.googleapis.com`,
    "font-src https://fonts.gstatic.com",
    `connect-src ${[...connect].join(" ")}`,
    "media-src 'self' blob: mediastream:",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "));
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), display-capture=()");
  res.setHeader("Referrer-Policy", "no-referrer");
}

let pageTemplate: string | null = null;
function sessionPage(nonce: string): string {
  // process.cwd(), as the voice demo page does: the bundle runs from server_dist, the page ships in server/public.
  pageTemplate ??= readFileSync(path.join(process.cwd(), "server/public/booking-session.html"), "utf8");
  return pageTemplate.replace(/__NONCE__/g, nonce);
}

function plainPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${htmlEscape(title)}</title><body style="font-family:system-ui,sans-serif;background:#fff;color:#0E0E0E;margin:0;padding:32px 16px">`
    + `<main style="max-width:420px;margin:0 auto"><h1 style="font-size:22px;text-transform:uppercase;letter-spacing:-.5px">${htmlEscape(title)}</h1>${body}`
    + `<p style="color:#6B6B6B;font-size:12px;margin-top:32px">Questions or safety concerns? ${htmlEscape(BOOKINGS.supportEmail)} · In danger? Call 911.</p></main></body></html>`;
}

function setPlainCsp(res: Response): void {
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader("Referrer-Policy", "no-referrer");
}

buyerSessionRouter.get("/s/:token", bookingSessionPublicLimiter, async (req: Request, res: Response) => {
  try {
    const c = await resolveLink(req.params.token);
    if (!c) {
      setPlainCsp(res);
      res.status(404).type("html").send(plainPage("Link not found", "<p>This session link isn't valid any more. Open your booking email for a fresh one.</p>"));
      return;
    }
    const nonce = makeCspNonce();
    setSessionPageCsp(res, nonce);
    res.type("html").send(sessionPage(nonce));
  } catch (err) {
    if (err instanceof SessionLinkConfigError) { setPlainCsp(res); res.status(503).type("html").send(plainPage("Not available", "<p>Please try again later.</p>")); return; }
    fail(res, err);
  }
});

buyerSessionRouter.get("/s/:token/state", bookingSessionPublicLimiter, async (req: Request, res: Response) => {
  try { const c = await buyerBooking(req, res); if (c) res.json(buyerView(c.b, new Date(), c.role, await attendanceSummary(c.b.id))); } catch (err) { fail(res, err); }
});

buyerSessionRouter.post("/s/:token/join", bookingSessionPublicLimiter, async (req: Request, res: Response) => {
  try { const c = await buyerBooking(req, res); if (c) await joinToken(res, c.b, c.role, c.guest); } catch (err) { fail(res, err); }
});

buyerSessionRouter.post("/s/:token/happened", bookingSessionPublicLimiter, async (req: Request, res: Response) => {
  try { const c = await buyerBooking(req, res); if (c && payerOnly(c, res)) res.json(await markItHappened(c.b.id)); } catch (err) { fail(res, err); }
});

buyerSessionRouter.post("/s/:token/report", bookingSessionPublicLimiter, async (req: Request, res: Response) => {
  try {
    const c = await buyerBooking(req, res);
    if (!c || !payerOnly(c, res)) return;
    const b = c.b;
    const { category, details } = (req.body ?? {}) as { category?: unknown; details?: unknown };
    if (!isReportCategory(category)) { res.status(400).json({ error: "bad_request", field: "category" }); return; }
    res.json(await reportProblem({ bookingId: b.id, by: "buyer", category, details: typeof details === "string" ? details : null }));
  } catch (err) { fail(res, err); }
});

/** Her trusted friend's page: whether she checked in. No script, no buyer data, her first name and the time only. */
buyerSessionRouter.get("/ok/:token", bookingSessionPublicLimiter, async (req: Request, res: Response) => {
  setPlainCsp(res);
  try {
    const id = verifySessionLink(req.params.token, "checkin");
    const b = id ? await getBookingForSession(id) : null;
    if (!b || b.locationMode !== "in_person") { res.status(404).type("html").send(plainPage("Link not found", "<p>This check-in link isn't valid any more.</p>")); return; }
    const at = await lastCheckIn(b.id);
    const name = htmlEscape(b.athleteFirstName);
    const body = at
      ? `<p>${name} tapped <b>I'm OK</b> at ${htmlEscape(at.toUTCString())}.</p>`
      : `<p>${name} hasn't checked in yet. The session ends ${htmlEscape(b.endsAt?.toUTCString() ?? "soon")}.</p><p>If you're worried, contact ${name} directly. If someone is in danger, call 911.</p>`;
    res.type("html").send(plainPage(at ? "Checked in" : "Not checked in yet", body));
  } catch (err) {
    res.status(503).type("html").send(plainPage("Not available", "<p>Please try again later.</p>"));
    if (!(err instanceof SessionLinkConfigError)) logger.error({ error: (err as Error).message }, "check-in page failed");
  }
});

// ─── The LiveKit webhook ─────────────────────────────────────────────────────────────────────────────────────────

export const livekitWebhookRouter = Router();
livekitWebhookRouter.post("/api/webhooks/livekit", express.raw({ type: () => true, limit: "64kb" }), async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  if (!BOOKINGS.enabled) { res.status(404).json({ error: "Not found" }); return; }
  const body = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  try {
    const out = await handleLivekitWebhook(body, req.header("authorization") ?? undefined);
    res.json({ ok: true, ...(out.handled ? { recorded: out.recorded } : { ignored: out.reason }) });
  } catch (err) {
    if (err instanceof WebhookAuthError) { res.status(401).json({ error: "unauthorized" }); return; }
    logger.error({ error: (err as Error).message }, "LiveKit webhook failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── The cron ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/internal/booking-session-cron. `cronSecretValid` and `withLock` are the app's own (server/index.ts passes
 * them in), so this file adds no second copy of the secret check or the lock.
 */
export function bookingSessionCronRouter(
  cronSecretValid: (req: Request) => boolean,
  withLock: <T>(fn: () => Promise<T>) => Promise<{ ran: boolean; result: T | undefined }>,
): Router {
  const r = Router();
  r.post("/api/internal/booking-session-cron", async (req: Request, res: Response) => {
    if (!cronSecretValid(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!BOOKINGS.enabled) { res.json({ ok: true, skipped: true }); return; }
    try {
      const outcome = await withLock(() => runBookingSessionSweep());
      res.json(outcome.ran ? { ok: true, ran: true, ...outcome.result } : { ok: true, ran: false, reason: "another instance holds the booking session lock" });
    } catch (err: any) {
      logger.error({ error: err.message }, "booking-session-cron failed");
      res.status(500).json({ error: "Internal server error" });
    }
  });
  return r;
}
