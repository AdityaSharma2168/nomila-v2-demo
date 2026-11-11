/**
 * auth.ts — the authorization boundary for the internal voice endpoints.
 *
 * One guard, one place: every route under /api/internal/voice calls
 * `voiceAuthorized` and nothing else. The caller is TRUSTED INFRASTRUCTURE (the
 * mila-voice worker), not a user — there is no session and no `req.athleteId`,
 * so the athlete id comes from the path.
 *
 * ── Two credentials ──────────────────────────────────────────────────────────
 * 1. `x-voice-secret` — the shared service secret (`VOICE_SERVICE_SECRET`). It
 *    proves "this is our worker". On its own it is an all-athletes key: whoever
 *    holds it can name any athlete in the path. It is its own secret with its own
 *    header and is never reused from `CRON_SECRET` (that one also signs OAuth
 *    state — see server/lib/oauthState.ts).
 * 2. `x-voice-grant` — a per-session, athlete-bound credential. POST /voice/token
 *    (./webTokenRoute.ts) mints it for the AUTHENTICATED athlete (`req.athleteId`)
 *    and puts it in the signed LiveKit dispatch metadata, which the worker reads
 *    and echoes on every call. It is an HMAC-SHA256 (`VOICE_GRANT_SECRET`) over
 *    {athleteId, conversationId, exp}: the path athlete must equal the athlete the
 *    session was opened for, and only until the session's max length.
 *
 * ── Enforcement: `VOICE_GRANT_ENFORCE` (default off) ─────────────────────────
 * The secret is ALWAYS required (401 without it). The grant is:
 *   off → OBSERVE: a missing / invalid / expired / mismatched grant is logged
 *         ("Voice grant check failed", enforced:false) and the request proceeds.
 *   on  → missing / invalid / expired grant = 401, athlete mismatch = 403.
 * Rollout: worker first (it sends the grant) → server in observe mode → logs show
 * zero failures → VOICE_GRANT_ENFORCE=true → later, stop relying on the secret
 * alone. See docs/runbooks/voice-grant-rollout.md. State (10 Nov 2026): ON in dev
 * (gcp/cloud-run-dev.yaml), off in prod (prod flag guard; prod has no
 * VOICE_GRANT_SECRET yet and voice is off there).
 *
 * ── The deletion fence (every route, 410) ────────────────────────────────────
 * After the secret and grant, the guard checks the athlete is not being deleted
 * (lib/privacy/deletionFence.ts clearFence; a missing row or a failed read counts
 * as deleting). A fenced athlete gets 410 {error:"account_deleting", message},
 * the same code requireAuth gives the app, and the route reads and writes
 * nothing. A new voice session cannot start for them anyway (POST /voice/token
 * is behind requireAuth); this stops a call that was already in progress.
 *
 * Fail-closed: with `VOICE_SERVICE_SECRET` unset every request is 401. With
 * `VOICE_GRANT_SECRET` unset no grant can be minted or verified, so enforce mode
 * answers 401 to everything (observe mode logs reason "unconfigured").
 *
 * Deliberately narrow: no general auth framework, no per-route policy. The one
 * documented exception is brand-knowledge (./brandKnowledgeRoute.ts): its answer
 * is shared brand data that the path id does not scope, so the secret alone would
 * be safe there. It still goes through this guard for uniformity.
 */

import crypto from "crypto";
import type { Request, Response } from "express";
import { clearFence, isAthleteDeleting } from "../lib/privacy/deletionFence";
import { createLogger } from "../logger";

const logger = createLogger("voice/auth");

/** The header the worker echoes the grant in. */
export const VOICE_GRANT_HEADER = "x-voice-grant";

/**
 * The longest a voice session is expected to run. A deliberate ceiling on the
 * grant: a session that outlives it loses its tools once enforcement is on
 * (they 401), which is the intended failure. The per-athlete DAILY cap on voice
 * minutes (./voiceMinutes.ts) is checked when the session is granted, and
 * shortens the grant to what is left of their day.
 */
export const VOICE_SESSION_MAX_MS = 60 * 60_000;
/** Slack for clock skew between Cloud Run and the worker, and a slow join. */
export const VOICE_GRANT_BUFFER_MS = 5 * 60_000;

const GRANT_VERSION = "v1";

/**
 * Constant-time comparison of the x-voice-secret header against the shared
 * secret, so these endpoints don't leak the secret via response-timing. Read
 * per-call so the unset case is directly testable.
 *
 * Internal to the guard: routes call `voiceAuthorized`, never this.
 */
export function voiceSecretValid(req: Request): boolean {
  const secret = process.env.VOICE_SERVICE_SECRET?.trim();
  const provided = req.headers["x-voice-secret"];
  if (!secret || typeof provided !== "string") return false;
  return safeEqual(provided, secret);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const grantSecret = (): string | undefined =>
  process.env.VOICE_GRANT_SECRET?.trim() || undefined;

/** Read per-call, like the secret. Only "true" turns it on. */
export function voiceGrantEnforced(): boolean {
  return process.env.VOICE_GRANT_ENFORCE?.trim().toLowerCase() === "true";
}

export interface VoiceGrantClaims {
  athleteId: string;
  /** The session's conversation ('' when it has none). */
  conversationId: string;
  /** Expiry, epoch SECONDS. */
  exp: number;
}

const sign = (secret: string, body: string): string =>
  crypto.createHmac("sha256", secret).update(body).digest("base64url");

/**
 * Mint the athlete-bound grant for one voice session. Returns null when
 * `VOICE_GRANT_SECRET` is unset — the session still works in observe mode, and
 * enforce mode will refuse it, which is the correct fail-closed outcome.
 */
export function mintVoiceGrant(
  athleteId: string,
  conversationId: string,
  now: number = Date.now(),
  /** The session's length, when shorter than VOICE_SESSION_MAX_MS (what is left of their day: ./voiceMinutes.ts). */
  maxMs: number = VOICE_SESSION_MAX_MS,
): { grant: string; exp: number } | null {
  const secret = grantSecret();
  if (!secret) return null;
  const sessionMs = Math.max(0, Math.min(VOICE_SESSION_MAX_MS, Number.isFinite(maxMs) ? maxMs : VOICE_SESSION_MAX_MS));
  const exp = Math.floor(
    (now + sessionMs + VOICE_GRANT_BUFFER_MS) / 1000,
  );
  const claims: VoiceGrantClaims = { athleteId, conversationId, exp };
  const body = `${GRANT_VERSION}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return { grant: `${body}.${sign(secret, body)}`, exp };
}

export type VoiceGrantFailure =
  | "unconfigured"
  | "missing"
  | "malformed"
  | "bad_signature"
  | "expired";

export function verifyVoiceGrant(
  grant: unknown,
  now: number = Date.now(),
):
  | { ok: true; claims: VoiceGrantClaims }
  | { ok: false; reason: VoiceGrantFailure } {
  const secret = grantSecret();
  if (!secret) return { ok: false, reason: "unconfigured" };
  if (typeof grant !== "string" || !grant) {
    return { ok: false, reason: "missing" };
  }

  const parts = grant.split(".");
  if (parts.length !== 3 || parts[0] !== GRANT_VERSION) {
    return { ok: false, reason: "malformed" };
  }
  const body = `${parts[0]}.${parts[1]}`;
  // Signature BEFORE parsing: nothing unauthenticated is interpreted.
  if (!safeEqual(parts[2], sign(secret, body))) {
    return { ok: false, reason: "bad_signature" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const c = parsed as Partial<VoiceGrantClaims> | null;
  if (
    !c ||
    typeof c !== "object" ||
    typeof c.athleteId !== "string" ||
    typeof c.conversationId !== "string" ||
    typeof c.exp !== "number" ||
    !Number.isFinite(c.exp)
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (c.exp * 1000 <= now) return { ok: false, reason: "expired" };
  return {
    ok: true,
    claims: {
      athleteId: c.athleteId,
      conversationId: c.conversationId,
      exp: c.exp,
    },
  };
}

export type VoiceAuthFailure = {
  ok: false;
  status: 400 | 401 | 403 | 410;
  error: "Unauthorized" | "Forbidden" | "Invalid athlete id" | "account_deleting";
  /** A plain sentence for the caller, when there is one worth saying (the deletion fence). */
  message?: string;
};
export type VoiceAuthResult = { ok: true } | VoiceAuthFailure;

const UNAUTHORIZED = { ok: false, status: 401, error: "Unauthorized" } as const;
const FORBIDDEN = { ok: false, status: 403, error: "Forbidden" } as const;
const BAD_ATHLETE_ID = { ok: false, status: 400, error: "Invalid athlete id" } as const;
/**
 * The account is being deleted (lib/privacy/deletionFence.ts). Same status and error code requireAuth answers the
 * app with (lib/auth.ts ACCOUNT_DELETING), so both doors refuse the same way.
 */
export const VOICE_ACCOUNT_DELETING = {
  ok: false,
  status: 410,
  error: "account_deleting",
  message: "This account is being deleted, so voice can't read or change anything for it.",
} as const;

export interface VoiceAuthDeps {
  /** The deletion-fence read (default lib/privacy/deletionFence.ts isAthleteDeleting). */
  isDeleting?: (athleteId: string) => Promise<boolean>;
}

/**
 * THE guard for every /api/internal/voice route, in this order:
 *   1. the service secret (401 without it, always);
 *   2. a valid, unexpired grant whose athlete equals the path athlete (enforced only when VOICE_GRANT_ENFORCE is on;
 *      observe mode logs and continues);
 *   3. the path athlete id is a uuid (400), so nothing malformed reaches the DB;
 *   4. the deletion fence: an athlete whose account is being deleted (or whose row is gone, or whose fence read
 *      failed) gets 410 account_deleting, before the route reads or writes anything.
 * Every route calls this first, so none of them can skip the fence. It is async because of step 4; a call site that
 * forgets the `await` does not typecheck (`.ok` is not on a Promise).
 *
 * At a call site:
 *   const auth = await voiceAuthorized(req, req.params.id);
 *   if (!auth.ok) { sendVoiceRefusal(res, auth); return; }
 */
export async function voiceAuthorized(
  req: Request,
  athleteIdFromPath: string | undefined,
  deps: VoiceAuthDeps = {},
): Promise<VoiceAuthResult> {
  const grant = voiceGrantVerdict(req, athleteIdFromPath);
  if (!grant.ok) return grant;
  if (!athleteIdFromPath || !UUID_RE.test(athleteIdFromPath)) return BAD_ATHLETE_ID;
  if (!(await clearFence(athleteIdFromPath, deps.isDeleting ?? isAthleteDeleting))) {
    logger.info({ athleteId: athleteIdFromPath, method: req.method, route: req.route?.path ?? null }, "Voice call refused: account being deleted");
    return VOICE_ACCOUNT_DELETING;
  }
  return { ok: true };
}

/**
 * The guard for the voice routes that take the athlete FROM THE GRANT (POST /session and POST /tool, ./oneMila/routes.ts:
 * no athlete in the path, so there is nothing for a secret holder to name). The grant is therefore REQUIRED whatever
 * VOICE_GRANT_ENFORCE says (401 when it is missing, invalid or expired: without it there is no athlete), and then
 * voiceAuthorized runs with the grant's athlete as the path athlete: the secret, the grant, the uuid and the deletion
 * fence, exactly as every other voice route. Returns the verified claims and the grant itself (the call's key is
 * derived from it, never the grant stored).
 */
export async function voiceGrantAuthorized(
  req: Request,
  deps: VoiceAuthDeps = {},
): Promise<{ ok: true; claims: VoiceGrantClaims; grant: string } | VoiceAuthFailure> {
  if (!voiceSecretValid(req)) return UNAUTHORIZED;
  const grant = req.headers[VOICE_GRANT_HEADER];
  const verdict = verifyVoiceGrant(grant);
  if (!verdict.ok) {
    logger.warn({ reason: verdict.reason, enforced: true, method: req.method, route: req.route?.path ?? null }, "Voice grant check failed");
    return UNAUTHORIZED;
  }
  const auth = await voiceAuthorized(req, verdict.claims.athleteId, deps);
  if (!auth.ok) return auth;
  return { ok: true, claims: verdict.claims, grant: grant as string };
}

/** Send a refusal from voiceAuthorized: the status, the error code, and the plain message when it has one. */
export function sendVoiceRefusal(res: Response, auth: VoiceAuthFailure): void {
  res
    .status(auth.status)
    .json(auth.message ? { error: auth.error, message: auth.message } : { error: auth.error });
}

/** Steps 1 and 2 of voiceAuthorized: the secret, then the grant (enforced or observed). */
function voiceGrantVerdict(
  req: Request,
  athleteIdFromPath: string | undefined,
): VoiceAuthResult {
  if (!voiceSecretValid(req)) return UNAUTHORIZED;

  const verdict = verifyVoiceGrant(req.headers[VOICE_GRANT_HEADER]);
  const reason: VoiceGrantFailure | "athlete_mismatch" | null = !verdict.ok
    ? verdict.reason
    : verdict.claims.athleteId !== athleteIdFromPath
      ? "athlete_mismatch"
      : null;
  if (reason === null) return { ok: true };

  const enforced = voiceGrantEnforced();
  // Never the grant itself, never the secret. `reason` is what the rollout gate
  // counts; the route and ids are what an operator greps by.
  logger.warn(
    {
      reason,
      enforced,
      method: req.method,
      route: req.route?.path ?? null,
      pathAthleteId: athleteIdFromPath ?? null,
      grantAthleteId: verdict.ok ? verdict.claims.athleteId : null,
    },
    "Voice grant check failed",
  );
  if (!enforced) return { ok: true };
  return reason === "athlete_mismatch" ? FORBIDDEN : UNAUTHORIZED;
}

/** Shared by every voice route: reject a malformed id before it reaches the DB. */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
