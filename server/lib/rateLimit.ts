/**
 * Per-athlete rate limiters for the LLM streaming routes (+ one per-IP limiter for the
 * public card pages, at the bottom).
 *
 * Mount AFTER requireAuth so req.athleteId is set — keying by athlete (not IP)
 * means one user's bursts can't exhaust Vertex quota or hold DB connections for
 * everyone. The per-IP limiter below relies on index.ts trusting exactly Cloud Run's proxy hop (lib/trustProxy.ts).
 */

import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { isIP } from "node:net";
import type { Request } from "express";

const byAthlete = (req: Request): string => req.athleteId ?? "unknown";

function makeLimiter(limit: number, message: string) {
  return rateLimit({
    windowMs:        60_000,
    limit,
    keyGenerator:    byAthlete,
    standardHeaders: true,
    legacyHeaders:   false,
    message:         { error: message },
  });
}

// Draft generation is expensive (a full Vertex stream) — a small burst per minute.
export const draftLimiter = makeLimiter(6, "You're generating drafts too fast — give it a moment and try again.");
// Chat already has a 30/hour DB cap; this bounds short bursts on top of that.
export const chatLimiter  = makeLimiter(20, "You're sending messages too fast — give it a moment and try again.");
// The tightest of the three, because a voice token is the most expensive thing a
// single request can buy: minting one dispatches a LiveKit worker job and opens a
// billable Gemini Live realtime session. An athlete can only be in one call at a
// time, so 5/min is already generous — it exists to absorb reconnects and retries,
// not concurrent sessions.
export const voiceTokenLimiter = makeLimiter(5, "You're starting voice too often — give it a moment and try again.");
// Phone registration (POST /me/push/devices): a phone registers on sign-in and on a profile switch; 10/min absorbs
// retries and switching, and bounds token-takeover attempts (services/push/push.ts registerDevice).
export const pushRegisterLimiter = makeLimiter(10, "Too many tries — give it a moment and try again.");

// Per-IP (not per-athlete) for the PUBLIC Nomi Card pages (/card/:athleteId, which answers 404 to anyone but the owner,
// and the public page routes; /c/:shareId uses shareLinkLimiters below, the same 120 / min per visitor). None can start
// a kit build any more; this only blunts scraping / share-id guessing. Keyed on the client IP (index.ts trusts Cloud Run's hop), the
// same as the signup limiter in routes/auth.ts. Generous: a brand flipping through a deck, or an
// office behind one NAT, stays far below it.
export const publicCardLimiter = rateLimit({
  windowMs:        60_000,
  limit:           120,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         "Too many requests — please slow down and try again shortly.",
});

// ─── /c/:shareId through nomila.co (Firebase Hosting) ────────────────────────────────────────────────────────────
// The landing site rewrites nomila.co/c/** to this service (firebase.json, target "landing"). That adds a hop: Hosting
// forwards `X-Forwarded-For: <visitor>` and Cloud Run's front end appends the Hosting edge it received the request from,
// so with the app's one trusted hop req.ip is the EDGE, shared by every visitor it serves — publicCardLimiter would
// throttle a whole edge as one person. For this route only, the visitor is the SECOND-from-right entry.
//
// That entry is written by the caller when the request did NOT come through Hosting (the run.app URL or a domain
// mapping called directly): "<anything>, <real caller>". So the visitor bucket alone could be dodged by rotating a fake
// header on a direct call. Two limits, both must pass:
//   per visitor   publicCardLimiter's 120 / min, keyed on the second-from-right entry (a real visitor via Hosting)
//   per peer      1200 / min, keyed on req.ip (one trusted hop: the Hosting edge, or a direct caller's real address) —
//                 loose enough for a busy edge, tight enough to cap a direct caller rotating fake headers.

/** The second-from-right X-Forwarded-For entry when it is an IP address, else req.ip. */
export function viaHostingClientIp(req: Request): string {
  const header = req.headers["x-forwarded-for"];
  const raw = Array.isArray(header) ? header.join(",") : header ?? "";
  const hops = raw.split(",").map((h) => h.trim()).filter(Boolean);
  const visitor = hops.length >= 2 ? hops[hops.length - 2] : "";
  return isIP(visitor) ? visitor : (req.ip ?? "unknown");
}

export const SHARE_LINK_PEER_LIMIT = 1200;

export const shareLinkLimiters = [
  rateLimit({
    windowMs:        60_000,
    limit:           120,
    standardHeaders: true,
    legacyHeaders:   false,
    keyGenerator:    (req: Request) => `visitor:${ipKeyGenerator(viaHostingClientIp(req))}`,
    message:         "Too many requests — please slow down and try again shortly.",
  }),
  rateLimit({
    windowMs:        60_000,
    limit:           SHARE_LINK_PEER_LIMIT,
    standardHeaders: false,
    legacyHeaders:   false,
    keyGenerator:    (req: Request) => `peer:${ipKeyGenerator(req.ip ?? "unknown")}`,
    message:         "Too many requests — please slow down and try again shortly.",
  }),
];

// Her picks (docs/design/shop-her-picks.md): reading a pasted link fetches a third-party page (and may ask a small
// model), so adding / previewing is bounded per athlete.
export const shopLinkLimiter = makeLimiter(20, "You're adding links too fast — give it a moment and try again.");

// Per-IP for the PUBLIC click redirect /go/:code. In memory only: the IP is never written anywhere. Generous — a fan
// tapping through a shelf stays far below it; it only blunts code guessing and click inflation.
export const shopRedirectLimiter = rateLimit({
  windowMs:        60_000,
  limit:           60,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         "Too many requests — please slow down and try again shortly.",
});

// Bookings v2 video session (server/routes/bookingSession.ts). Her join token, per athlete: a call is one session at a
// time, so 10/min only absorbs reconnects after a dropped network and a flipped app.
export const bookingSessionTokenLimiter = makeLimiter(10, "You're rejoining too often — give it a moment and try again.");

// Per-IP for the buyer's PUBLIC session page API (/s/:token/state, /join, /happened, /report). The link is a signed
// bearer credential for one booking; this only blunts guessing and a stuck page's retry loop. Generous for a page that
// polls its state every 15s, in memory only (the IP is never written anywhere).
export const bookingSessionPublicLimiter = rateLimit({
  windowMs:        60_000,
  limit:           30,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: "Too many requests — please slow down and try again shortly." },
});
// Bookings v2, the buyer's side (/api/v1/book): per-IP, in memory only (the IP is never written anywhere). Reading an
// offer or a booking page is generous; sending a request and trying codes are tight (they send email and guard codes —
// each code also has its own 5-try limit in the database).
const ipLimiter = (limit: () => number, message: string) => rateLimit({
  windowMs: 60_000, limit, standardHeaders: true, legacyHeaders: false, message: { error: message, code: "RATE_LIMITED" },
});
// Limits are read per request (env-overridable without a restart in tests; constant in production).
const envLimit = (name: string, fallback: number) => () => Number(process.env[name] ?? fallback);
export const bookingPublicLimiter  = ipLimiter(envLimit("BOOKING_PUBLIC_RATE_LIMIT", 60), "Too many requests. Wait a minute and try again.");
export const bookingRequestLimiter = ipLimiter(envLimit("BOOKING_REQUEST_RATE_LIMIT", 5), "Too many tries. Wait a few minutes.");
export const bookingCodeLimiter    = ipLimiter(envLimit("BOOKING_CODE_RATE_LIMIT", 10), "Too many tries. Wait a few minutes.");
// Per-IP for public Mila on /p/:handle (POST /p/:handle/ask and its two tap routes). A short-burst guard only: the real
// limits (30 turns a visitor a day, 400 an athlete a day, the spend cap) are DB-backed in server/services/askMila. In
// memory only; the IP is never written anywhere.
export const askMilaLimiter = rateLimit({
  windowMs:        60_000,
  limit:           15,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: "You're sending messages too fast. Give it a moment and try again." },
});

// Per-IP for the page's like (POST /p/:handle/like). One like per visitor is enforced in the database; this only blunts
// a script flipping likes. In memory only; the IP is never written anywhere.
export const publicLikeLimiter = rateLimit({
  windowMs:        60_000,
  limit:           20,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: "Too many taps. Give it a moment and try again." },
});
