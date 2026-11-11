/**
 * auth.ts — Firebase Admin JWT verification + requireAuth middleware.
 *
 * Mobile client sends:  Authorization: Bearer <Firebase ID token>
 * Middleware verifies the token, looks up the athlete row by auth_id (= Firebase UID),
 * and sets req.athleteId. Requests without a valid token get 401.
 *
 * Firebase Admin is initialized here once using Application Default Credentials
 * (automatically available in Cloud Run via the runtime service account).
 */

import type { Request, Response, NextFunction } from "express";
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { db } from "../db";
import { athletes, accountRoles } from "../../shared/schema";
import { identityMembershipReadEnabled } from "../services/intelligence/identity/config";
import { findUserByUid, membershipsForUser, rolesForUser } from "../services/intelligence/identity/users";
import { eq, inArray } from "drizzle-orm";
import { createLogger } from "../logger";
import { withTraceAthlete } from "./tracing";
import { gatePath, refuseNotLetIn, waitlistApiGateEnabled } from "./letInGate";

const logger = createLogger("auth");

// Initialize once — guard against hot-reload double-init in dev.
// Uses Application Default Credentials: runtime service account in Cloud Run,
// GOOGLE_APPLICATION_CREDENTIALS key file for local dev (same as v1).
if (getApps().length === 0) {
  initializeApp();
}

export const firebaseAuth = getAuth();

// ─── Revocation (security review of the email-code sign-in, Oct 2026) ─────────────────────────────────────────────
// verifyIdToken() alone checks the signature and expiry, so an ID token stays good for up to an hour after
// revokeRefreshTokens(). Firebase's own fix, verifyIdToken(token, true), costs a getUser call on EVERY request. Here
// the same check (auth_time against tokensValidAfterTime, and disabled) reads a per-uid record cached for
// REVOCATION_CACHE_MS on this instance: one getUser per signed-in user per minute per instance instead of one per
// request, at the price of a revocation (or a disable) taking up to a minute to bite on an instance that cached the
// user before it. Code that revokes on this instance calls forgetRevocationState(uid) so it bites here at once. A
// failed getUser fails CLOSED but answers 503 (try again), not 401: the token may be perfectly good, and a 401 would tell
// the app the person is signed out / has no athlete (tokenFailure). Revoked or disabled stay 401.

/** How long one user's revocation state is reused on this instance. */
export const REVOCATION_CACHE_MS = 60_000;
const REVOCATION_CACHE_MAX = 10_000;
const revocationState = new Map<string, { at: number; validSinceSec: number; disabled: boolean }>();

/** Drop the cached state for a user, or for everyone (call after revoking or disabling them). */
export function forgetRevocationState(uid?: string): void {
  if (uid === undefined) revocationState.clear(); else revocationState.delete(uid);
}

/** The revocation lookup itself failed (Firebase unreachable): not the caller's fault, so 503, never 401. */
export const AUTH_CHECK_UNAVAILABLE = "auth/revocation-check-unavailable";

/** How a failed token check answers: 503 when the check could not run, else 401. */
export function tokenFailure(err: unknown): { status: 401 | 503; body: Record<string, unknown> } {
  return (err as { code?: string } | null)?.code === AUTH_CHECK_UNAVAILABLE
    ? { status: 503, body: { error: "Sign-in check unavailable — please try again shortly.", code: "AUTH_UNAVAILABLE" } }
    : { status: 401, body: { error: "Invalid or expired token" } };
}

/** verifyIdToken, then refuse a token issued before the user's sessions were revoked, or a disabled user. */
export async function verifyIdTokenChecked(idToken: string, now: number = Date.now()): Promise<DecodedIdToken> {
  const decoded = await firebaseAuth.verifyIdToken(idToken);
  let state = revocationState.get(decoded.uid);
  if (!state || now - state.at > REVOCATION_CACHE_MS) {
    let user;
    try {
      user = await firebaseAuth.getUser(decoded.uid);
    } catch (err: any) {
      if (err?.code === "auth/user-not-found") throw Object.assign(new Error("The user no longer exists"), { code: "auth/user-not-found" });
      throw Object.assign(new Error(`revocation check failed: ${String(err?.message ?? err).slice(0, 120)}`), { code: AUTH_CHECK_UNAVAILABLE });
    }
    const validAfter = user.tokensValidAfterTime ? Date.parse(user.tokensValidAfterTime) : NaN;
    state = { at: now, validSinceSec: Number.isFinite(validAfter) ? Math.floor(validAfter / 1000) : 0, disabled: user.disabled === true };
    if (revocationState.size >= REVOCATION_CACHE_MAX) revocationState.clear();
    revocationState.set(decoded.uid, state);
  }
  if (state.disabled) throw Object.assign(new Error("The user account is disabled"), { code: "auth/user-disabled" });
  if ((decoded.auth_time ?? 0) < state.validSinceSec) throw Object.assign(new Error("The ID token has been revoked"), { code: "auth/id-token-revoked" });
  return decoded;
}

declare global {
  namespace Express {
    interface Request {
      athleteId?: string;
      roles?: string[];
      /** Phase A Step 3a: the users.id of the caller (set when IDENTITY_MEMBERSHIP_READ is on). */
      userId?: string;
      /** requireFirebaseUser: the verified identity-provider user, whether or not an athlete row is linked. */
      authUid?: string;
      authEmail?: string | null;
      authEmailVerified?: boolean;
    }
  }
}

/**
 * Phase A Step 2c — the PRE-LINK guard. Verifies the identity-provider token and exposes the user
 * (uid, email, email_verified) WITHOUT looking up an athlete row: the caller of the Athlete Index
 * candidates endpoint may not be linked to any athlete yet. Every supported sign-in resolves to a
 * Firebase ID token (Microsoft signs in through a Firebase custom token, routes/auth.ts), so one
 * Firebase verifier is provider-neutral here. Never sets req.athleteId.
 */
export async function requireFirebaseUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or malformed Authorization header" });
    return;
  }
  try {
    const decoded = await verifyIdTokenChecked(header.slice(7));
    req.authUid = decoded.uid;
    req.authEmail = decoded.email ?? null;
    req.authEmailVerified = decoded.email_verified === true;
  } catch (err: any) {
    logger.debug({ error: err.message?.slice(0, 80) }, "Firebase token verification failed (pre-link guard)");
    const f = tokenFailure(err);
    res.status(f.status).json(f.body);
    return;
  }
  next();
}

/** Why a request did not authenticate: the status + JSON body requireAuth answers with. */
export interface AuthFailure { status: number; body: Record<string, unknown> }

/**
 * The account is being deleted (athletes.deletion_requested_at, set by account deletion phase 1): every request of
 * theirs is refused from that moment, so no new turn, job or write starts while phase 2 purges (lib/privacy/deletionFence.ts).
 */
export const ACCOUNT_DELETING: AuthFailure = { status: 410, body: { error: "account_deleting" } };

/**
 * requireAuth's check WITHOUT writing a response. On success it sets req.athleteId / req.roles /
 * req.userId / req.authUid exactly as requireAuth does and returns null; on failure it returns the
 * status + body requireAuth would have sent. For a handler that must answer a failure differently
 * (the Nomi Card HTML answers 404, not 401, so an athlete id can't be probed).
 */
export async function authenticateRequest(req: Request): Promise<AuthFailure | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return { status: 401, body: { error: "Missing or malformed Authorization header" } };
  }

  const idToken = header.slice(7);
  let uid: string;
  let roles: string[];
  try {
    const decoded = await verifyIdTokenChecked(idToken);
    uid   = decoded.uid;
    roles = Array.isArray(decoded["roles"]) ? (decoded["roles"] as string[]) : [];
    req.authUid = uid;   // the verified uid, for handlers that must name the speaking user (e.g. /me/identity)
  } catch (err: any) {
    logger.debug({ error: err.message?.slice(0, 80) }, "Firebase token verification failed");
    return tokenFailure(err);
  }

  // Phase A Step 3a (design §3.2): with IDENTITY_MEMBERSHIP_READ on, the caller is a USER and the athlete comes from the
  // memberships by the selection rule (exactly one ⇒ auto; more ⇒ the request must name one; never the first row).
  if (identityMembershipReadEnabled()) {
    const sel = await selectAthleteByMembership(uid, req);
    if (sel.error) return sel.error;
    const [picked] = await db.select({ deleting: athletes.deletion_requested_at }).from(athletes).where(eq(athletes.id, sel.athleteId)).limit(1);
    if (picked?.deleting) return ACCOUNT_DELETING;
    req.userId = sel.userId; req.athleteId = sel.athleteId;
    req.roles = Array.from(new Set([...roles, ...sel.roles]));
    return null;
  }
  // Flag off: today's lookup, byte for byte.
  const [athlete] = await db
    .select({ id: athletes.id, status: athletes.status, deleting: athletes.deletion_requested_at })
    .from(athletes)
    .where(eq(athletes.auth_id, uid))
    .limit(1);
  if (!athlete) {
    return { status: 401, body: { error: "No athlete account found for this token" } };
  }
  if (athlete.deleting) return ACCOUNT_DELETING;
  req.athleteId = athlete.id;
  req.roles     = roles;
  (req as any).athleteStatus = athlete.status;   // for requireAuth's let-in gate (lib/letInGate.ts), from the same read
  return null;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const failure = await authenticateRequest(req);
  if (failure) {
    res.status(failure.status).json(failure.body);
    return;
  }
  // Launch board f14: an athlete still on the waitlist may call only what the waitlist uses (lib/letInGate.ts).
  if (waitlistApiGateEnabled() && req.athleteId) {
    let status = (req as any).athleteStatus as string | undefined;
    // The membership path (IDENTITY_MEMBERSHIP_READ) picks the athlete without reading its status: read it here.
    if (status === undefined && identityMembershipReadEnabled()) {
      const [row] = await db.select({ status: athletes.status }).from(athletes).where(eq(athletes.id, req.athleteId)).limit(1);
      status = row?.status;
    }
    if (refuseNotLetIn({ status, roles: req.roles, path: gatePath(req.originalUrl ?? req.url ?? "") })) {
      res.status(403).json({ error: "not_let_in" });
      return;
    }
  }
  // Every trace this request starts is tagged as hers, so account deletion can find and delete it.
  withTraceAthlete(req.athleteId, next);
}

interface MembershipSelection { userId: string; athleteId: string; roles: string[]; error?: undefined }
interface MembershipSelectionError { error: { status: number; body: Record<string, unknown> }; userId?: undefined; athleteId?: undefined; roles?: undefined }

/** The §3.2 selection rule over the caller's active memberships. */
async function selectAthleteByMembership(uid: string, req: Request): Promise<MembershipSelection | MembershipSelectionError> {
  const user = await findUserByUid(uid);
  if (!user) return { error: { status: 401, body: { error: "No athlete account found for this token" } } };
  const memberships = await membershipsForUser(user.id);
  const roles = await rolesForUser(user.id);
  if (memberships.length === 0) return { error: { status: 401, body: { error: "No athlete account found for this token" } } };
  const requested = typeof req.headers["x-athlete-id"] === "string" ? String(req.headers["x-athlete-id"]).trim() : null;
  if (requested) {
    const m = memberships.find((x) => x.athleteId === requested);
    if (!m) return { error: { status: 403, body: { error: "athlete_not_held", athleteId: requested } } };
    return { userId: user.id, athleteId: m.athleteId, roles };
  }
  if (memberships.length === 1) return { userId: user.id, athleteId: memberships[0].athleteId, roles };
  // 3b: the names ride along so a client can ask "which profile?" — never chosen server-side
  const names = await db.select({ id: athletes.id, full_name: athletes.full_name }).from(athletes).where(inArray(athletes.id, memberships.map((m) => m.athleteId)));
  return { error: { status: 409, body: { error: "athlete_selection_required", athletes: memberships.map((m) => m.athleteId), profiles: memberships.map((m) => ({ athleteId: m.athleteId, fullName: names.find((n) => n.id === m.athleteId)?.full_name ?? null, relation: m.relation, proof: m.proof })) } } };
}

// ─── Admin gate ────────────────────────────────────────────────────────────────
//
// Fail-closed: only callers holding the 'admin' role pass (grant it with scripts/grant-admin.ts).
// There is no open-access switch (ADMIN_OPEN_ACCESS was deleted 2 Nov 2026, owner decision).
//
// The 'admin' role is resolved from BOTH sources we maintain: Firebase custom claims
// (req-time, set at signup / by scripts/grant-admin.ts) and the account_roles table
// (source of truth we can edit with SQL). Either grants access.
//
// Unlike requireAuth, a missing athletes row is NOT fatal here (an admin need not be an athlete).
// When the token does map to an athlete, req.athleteId and req.roles are populated so handlers
// can audit who performed an action.
export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or malformed Authorization header" });
    return;
  }

  let uid: string;
  let roles: string[];
  try {
    const decoded = await verifyIdTokenChecked(header.slice(7));
    uid   = decoded.uid;
    roles = Array.isArray(decoded["roles"]) ? (decoded["roles"] as string[]) : [];
  } catch (err: any) {
    logger.debug({ error: err.message?.slice(0, 80) }, "Admin token verification failed");
    const f = tokenFailure(err);
    res.status(f.status).json(f.body);
    return;
  }

  // Map token → athlete row (optional). Merge any DB roles with the token's claim roles.
  const [athlete] = await db
    .select({ id: athletes.id })
    .from(athletes)
    .where(eq(athletes.auth_id, uid))
    .limit(1);

  if (athlete) {
    req.athleteId = athlete.id;
    const dbRoles = await db
      .select({ role: accountRoles.role })
      .from(accountRoles)
      .where(eq(accountRoles.account_id, athlete.id));
    roles = Array.from(new Set([...roles, ...dbRoles.map((r) => r.role)]));
  }
  // Phase A Step 3a: with the read flag on, roles also come from user_roles and the athlete from the memberships (§3.2 rule;
  // a selection error is NOT fatal here — admin access must work for a caller with no athlete, exactly as today).
  if (identityMembershipReadEnabled()) {
    const sel = await selectAthleteByMembership(uid, req);
    if (!sel.error) { req.userId = sel.userId; req.athleteId = sel.athleteId; }
    const user = await findUserByUid(uid);
    if (user) { req.userId = user.id; roles = Array.from(new Set([...roles, ...(await rolesForUser(user.id))])); }
  }
  req.roles = roles;

  const isAdmin = roles.includes("admin");

  if (!isAdmin) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}
