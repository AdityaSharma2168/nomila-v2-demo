/**
 * auth.ts — Authentication endpoints.
 *
 * POST /api/v1/auth/signup
 *   Called on first sign-in. Requires a valid Firebase ID token.
 *   Creates the athletes row and account_roles row, sets Firebase custom claims.
 *   Auth: Firebase JWT verified inline (no requireAuth — row may not exist yet).
 *
 * GET /api/v1/auth/me
 *   Returns the authenticated athlete's profile. Requires requireAuth.
 *
 * POST /api/v1/auth/microsoft
 *   Exchanges a Microsoft OAuth code for a Firebase custom token (for native clients).
 *   Web clients use Firebase's signInWithPopup directly.
 */

import { Router, type Request, type Response } from "express";
import { firebaseAuth, requireAuth, tokenFailure, verifyIdTokenChecked } from "../lib/auth";
import { db } from "../db";
import { athletes, accountRoles, userRoles, users as usersTable } from "../../shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { SIGNUPS_CLOSED_ERROR, signupsOpen } from "../lib/signups";
import { newAccountAllowed, refuseBurst } from "../lib/signupBurst";
import { appCheckAllows, refuseAppCheck } from "../lib/appCheck";
import { recordSignupFlags } from "../lib/signupFlags";
import { setRoleClaimKeepingOthers } from "../lib/roleClaims";
import { waitlistAllSignupsEnabled } from "../lib/joinWaitlist";
import { createLogger } from "../logger";
import { signupResearchAgentEnabled, startSignupAgentResearch, startSignupResearchRun } from "../agent/onboarding/signupResearch";
import { athleteIndexClaimEnabled } from "../services/intelligence/identity/config";
import { finalizeResolution, resolveIdentity } from "../services/intelligence/identity/resolve";
import { findUserByUid, grandfatherMembership, membershipsForUser, selfMembershipFor } from "../services/intelligence/identity/users";
import { createAthleteForUser, pendingClaimCount, proposeLegacyNameClaim } from "../services/intelligence/identity/claims";
import { onboardingStartVersion } from "../workflow/definitions/onboarding";
import { MILA } from "../mila/config";
// PR E2b (design record §5.4, D14): every account-creating / claim-linking branch below converges on the lifecycle
// research trigger (T1 + the governed research_refresh v3 run). A no-op unless identityResolutionEnabled(); never
// awaited, never fatal; not part of the onboarding workflow. Pinned by lifecycleHooks.test.ts (exhaustiveness guard).
import { enterLifecycleResearch } from "../services/intelligence/research/lifecycleHooks";
import { identityResolutionEnabled } from "../services/intelligence/research/config";
import rateLimit from "express-rate-limit";

const logger = createLogger("routes/auth");

/** Phase A Step 3b (D-6): Microsoft Graph asserts no e-mail verification; `mail` is presence. Only a provider claim would flip this. */
export function microsoftEmailVerified(_profile: { mail?: string; userPrincipalName?: string }): boolean { return false; }
const router = Router();

const VALID_ROLES = new Set(["athlete", "fan", "brand"]);

// Anti-automation on the unauthenticated auth endpoints (signup + Microsoft code
// exchange). Keyed on the real client IP (index.ts trusts Cloud Run's hop). Generous
// enough for legitimate retries, tight enough to blunt credential/enumeration abuse.
const authLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  limit:           30,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: "Too many requests — please slow down and try again shortly." },
});

// ─── POST /api/v1/auth/signup ─────────────────────────────────────────────────

/**
 * The app's agent onboarding front signs up with `front: "agent"` once the athlete has picked their sports, so the
 * index match sees the main sport. With AGENT_ONBOARDING on, that front starts its own research (POST
 * /me/agent/onboarding/start), so the legacy onboarding run is not started for it. Any other caller: unchanged.
 */
export function agentFrontSignup(body: unknown): boolean {
  // AGENT_ONBOARDING, read as server/agent/onboarding/routes.ts agentOnboardingEnabled() reads it (not imported: that
  // module pulls the whole onboarding service into the auth routes).
  return process.env.AGENT_ONBOARDING === "true" && !!body && typeof body === "object" && (body as { front?: unknown }).front === "agent";
}


/**
 * The status a NEW account is created with — every create branch here (/signup both, /microsoft both) reads it.
 * WAITLIST_ALL_SIGNUPS on (production; server/lib/joinWaitlist.ts): every new account is 'waitlisted', and the app shows
 * the waitlist screen until an admin promotes her. Off: 'raw', as today.
 */
export function newAccountStatus(): "raw" | "waitlisted" {
  return waitlistAllSignupsEnabled() ? "waitlisted" : "raw";
}

/**
 * A non-agent-front app sign-up's research, through the one chokepoint (fire and forget, never fatal): the agent's
 * research-only run with SIGNUP_RESEARCH_AGENT on (design D8: the app fronts move with the landing), else the legacy
 * onboarding run exactly as before: the index-claim branch pins onboardingStartVersion(), the legacy branch passes no
 * version (pinned by auth.signup.claim.test.ts; the latest registered definition). Resolves when the agent start has
 * settled (at once for the legacy start), so the caller's lifecycle entry runs after it and skips an agent-researched
 * athlete (agentFrontAthlete.ts).
 */
function startAppSignupResearch(athleteId: string, legacy: { pinVersion: boolean }): Promise<void> {
  if (signupResearchAgentEnabled()) {
    return startSignupAgentResearch(athleteId, { createdBy: "app_signup" })
      .then((r) => { if (!r.started) logger.info({ accountId: athleteId, reason: r.reason }, "signup research (agent) not started"); })
      .catch((err: any) => logger.error({ accountId: athleteId, error: err.message }, "signup research (agent) start failed"));
  }
  void startSignupResearchRun({ process: "onboarding", athleteId, createdBy: "app_signup", idempotencyKey: `onboarding:${athleteId}`, ...(legacy.pinVersion ? { version: onboardingStartVersion() } : {}) }, { capped: true })
    .catch((err: any) => logger.error({ accountId: athleteId, error: err.message }, "onboarding run start failed"));
  return Promise.resolve();
}

router.post("/signup", authLimiter, async (req: Request, res: Response): Promise<void> => {
  // Verify Firebase token
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or malformed Authorization header" });
    return;
  }

  let uid: string;
  let email: string | undefined;
  let emailVerified = false;
  try {
    const decoded = await verifyIdTokenChecked(header.slice(7));   // revoked / disabled ⇒ 401; check unavailable ⇒ 503
    uid   = decoded.uid;
    email = decoded.email;
    emailVerified = decoded.email_verified === true;
  } catch (err: any) {
    logger.debug({ error: err.message?.slice(0, 80) }, "Signup: token verification failed");
    const f = tokenFailure(err);
    res.status(f.status).json(f.body);
    return;
  }

  // Validate body
  const { name, role, sport, school } = req.body as {
    name?: string;
    role?: string;
    sport?: string;
    school?: string;
  };

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (!role || !VALID_ROLES.has(role)) {
    res.status(400).json({ error: `role must be one of: ${Array.from(VALID_ROLES).join(", ")}` });
    return;
  }

  // Idempotency: if this UID already has a row, return it
  const [existing] = await db
    .select({ id: athletes.id, status: athletes.status })
    .from(athletes)
    .where(eq(athletes.auth_id, uid))
    .limit(1);

  if (existing) {
    // Phase A Step 3b (flag on only): a row linked through a confirmed claim reaches signup here — make the roles idempotent
    if (athleteIndexClaimEnabled() && VALID_ROLES.has(role)) {
      await db.insert(accountRoles).values({ account_id: existing.id, role }).onConflictDoNothing();
      const u = await findUserByUid(uid); if (u) await db.insert(userRoles).values({ user_id: u.id, role }).onConflictDoNothing();
    }
    logger.info({ uid, accountId: existing.id }, "Signup called for existing account — returning existing");
    res.json({ id: existing.id, role, status: existing.status });
    return;
  }

  // Phase A Step 2c (ATHLETE_INDEX_CLAIM): search the Athlete Index first. Only a claim PROOF links
  // (a unique, provider-verified email here; existing auth above); every match tier on its own
  // creates the new row and records the candidates. Flag off ⇒ the pre-Step-2c path below, byte for byte.
  if (athleteIndexClaimEnabled()) {
    const trimmedName = name.trim();
    const sportTrimmed = sport?.trim() || null;
    const claimSessionId = typeof (req.body as any)?.claimSessionId === "string" ? String((req.body as any).claimSessionId).slice(0, 64) : null;
    const r = await resolveIdentity({ path: "signup", caller: { uid, email: email ?? null, emailVerified }, provider: "firebase", query: { name: trimmedName, sport: sportTrimmed, teamOrSchool: school?.trim() || null }, claimSessionId,
      linkOnly: !signupsOpen() });   // sign-ups closed: no candidates, no session — only an existing account or a proof link
    // Phase A Step 3b: "Is this you?" — the index found candidates; nothing links on a tier, the user decides first.
    if (r.action === "confirm") { res.status(409).json({ error: "confirmation_required", claimSessionId: r.claimSessionId, tier: r.tier, claims: r.claims }); return; }
    if (r.action === "session_unknown") { res.status(400).json({ error: "claim_session_unknown" }); return; }
    let accountId: string; let responseStatus: number; let claimed: boolean; let status: string;
    if (r.action === "linked" || r.action === "existing") {
      accountId = r.athleteId!; responseStatus = 200; claimed = true; status = r.status ?? "claimed";
      await db.insert(accountRoles).values({ account_id: accountId, role }).onConflictDoNothing();
      { const u = await findUserByUid(uid); if (u) await db.insert(userRoles).values({ user_id: u.id, role }).onConflictDoNothing(); }   // 3a: the membership itself was written by linkUserToAthlete
      logger.info({ uid, accountId, role, proof: r.proof, tier: r.tier }, "Signup: linked existing row (claim proof)");
      if (role === "athlete") void enterLifecycleResearch(accountId, "claim");   // PR E2b: the claim-link lifecycle event
    } else {
      if (!signupsOpen()) {   // the kill switch: a new account only; the claim-link branch above is not a new account
        logger.info({ uid }, "Signup refused: sign-ups closed");
        res.status(403).json({ error: SIGNUPS_CLOSED_ERROR });
        return;
      }
      if (!(await appCheckAllows(req, "signup"))) { refuseAppCheck(res); return; }   // lib/appCheck.ts: new accounts only
      if (!(await newAccountAllowed(req))) { refuseBurst(res); return; }   // lib/signupBurst.ts: new accounts only
      // 3b: the new row + its self-membership (proof human_confirmation — hers by construction) in one transaction
      const created = await createAthleteForUser({ caller: { uid, email: email ?? null, emailVerified }, provider: "firebase", path: "signup", claimSessionId: r.claimSessionId ?? null, displayName: trimmedName,
        // agent_onboarding_required: only the new agent front (body.front === "agent") asks for the new onboarding;
        // every other signup path — including every one of these index-consulted creates — gets today's app.
        values: { full_name: trimmedName, email: email ?? null, sport: sportTrimmed, school: school?.trim() || null, status: newAccountStatus(), agent_onboarding_required: agentFrontSignup(req.body) } });
      await db.insert(accountRoles).values({ account_id: created.athleteId, role });
      await db.insert(userRoles).values({ user_id: created.userId, role }).onConflictDoNothing();
      await finalizeResolution(r, created.athleteId).catch((err: any) => logger.warn({ accountId: created.athleteId, error: err.message }, "index match record failed"));
      accountId = created.athleteId; responseStatus = 201; claimed = false; status = newAccountStatus();
      await recordSignupFlags(created.athleteId, req, email);   // lib/signupFlags.ts: admin signals, never a block
      if (role === "athlete" && sportTrimmed) {
        // The agent onboarding front (AGENT_ONBOARDING + the app's sport grid) runs its own research from its start
        // route; the legacy onboarding run would research the same athlete twice. Everything else here is unchanged.
        const started = agentFrontSignup(req.body) ? Promise.resolve() : startAppSignupResearch(created.athleteId, { pinVersion: true });
        void started.then(() => enterLifecycleResearch(created.athleteId, "signup"));   // PR E2b: the signup lifecycle event (created branch), after the start


        // THE INITIAL ASSESSMENT TRIGGER. Gated on a resolvable SPORT, not merely on an athlete existing: the
        // evaluator needs one and the snapshot builder returns null without it, so requesting earlier would schedule
        // a run that can only decline. This is the same condition onboarding uses, deliberately — an athlete Nomila
        // knows enough about to start onboarding is an athlete it knows enough about to assess.
        //
        // The athlete has no connected accounts at this instant, so the block is empty and the evaluator works from
        // its own grounded research. That is the intended first assessment, not a degraded one; connecting an account
        // later fires SOCIAL_BLOCK_CHANGED and supersedes it on newer evidence.
        //
        // Not awaited and never fatal: signup must not fail because a background assessment could not be scheduled.
        //
        // R-a (PR H2; research-acquisition architecture §10(c), PR E record D15): with identity resolution ON, this
        // request MOVES to after Q1 — the identity-resolved listener (requestEvaluationIfOwed) asks for it when
        // identity_resolution is written `resolved`. Requesting here too would only schedule a run the identity gate
        // refuses (the account was entered `pending` a moment ago). Flag off ⇒ exactly today's request.
        // Legacy intelligence switch-off (12 Oct 2026): never for an agent-front signup — her M.I.A. runs only through the
        // agent path (the onboarding preview on her memory), so this request would score her a second time.
        // SIGNUP_RESEARCH_AGENT on: the agent research run above scores her (its mia_preview step), so not here too.
        if (!identityResolutionEnabled() && !agentFrontSignup(req.body) && !signupResearchAgentEnabled()) {
          import("../services/marketabilityBeta1Orchestrator.js").then(({ requestEvaluation }) =>
            requestEvaluation({ athleteId: created.athleteId, trigger: "IDENTITY_RESOLVED", createdBy: "app_signup" }),
          ).catch((err: any) => logger.error({ accountId: created.athleteId, error: err.message }, "mia evaluation request failed at signup"));
        }
      }
      logger.info({ uid, accountId, role, tier: r.tier, decision: r.decision, claimSessionId: r.claimSessionId ?? null }, "Signup complete (index consulted)");
    }
    try { await setRoleClaimKeepingOthers(firebaseAuth, uid, role); }
    catch (err: any) { logger.warn({ uid, accountId, error: err.message }, "setCustomUserClaims failed — role will be missing from token until refresh"); }
    res.status(responseStatus).json({ id: accountId, role, status, claimed, candidates: r.decision === "possible_duplicate" });
    return;
  }

  // Email-based claim: a row may already exist without auth_id — e.g. a waitlist
  // signup that was migrated into athletes, or any pre-seeded profile carrying an
  // email. Attach this UID and preserve the row's current status (don't override
  // an admin's activation of a waitlisted athlete).
  //
  // SECURITY: only a provider-VERIFIED email (decoded.email_verified === true from the verified ID token above) may
  // attach this sign-in to an existing row. Anyone can create an email+password Firebase account with someone else's
  // address; an unverified email falls through and creates a new row instead, never a takeover.
  if (email && emailVerified) {
    const [byEmail] = await db
      .select({ id: athletes.id, status: athletes.status })
      .from(athletes)
      .where(and(
        sql`lower(${athletes.email}) = ${email.toLowerCase()}`,
        isNull(athletes.auth_id),
        // never a row already in an identity flow: one with an active self-membership, or a proposed / confirmed claim
        // carrying a REAL proof. A proof-none proposal (a legacy name match, an index candidate) is anyone's to create —
        // typing her name is enough — so it never blocks the owner's verified e-mail: the verified owner always wins.
        sql`NOT EXISTS (SELECT 1 FROM athlete_users au WHERE au.athlete_id = ${athletes.id} AND au.revoked_at IS NULL)`,
        sql`NOT EXISTS (SELECT 1 FROM identity_claims ic WHERE ic.athlete_id = ${athletes.id} AND ic.status IN ('proposed', 'confirmed') AND ic.proof <> 'none')`,
      ))
      .limit(1);

    if (byEmail) {
      await db
        .update(athletes)
        .set({ auth_id: uid, auth_provider: "firebase" })
        .where(eq(athletes.id, byEmail.id));
      await db.insert(accountRoles).values({ account_id: byEmail.id, role });
      await grandfatherMembership({ athleteId: byEmail.id, uid, email: email ?? null, note: "legacy_path:signup_email", role });   // 3a (P-1)
      if (role === "athlete") void enterLifecycleResearch(byEmail.id, "claim");   // PR E2b: legacy e-mail claim
      try {
        await setRoleClaimKeepingOthers(firebaseAuth, uid, role);
      } catch (err: any) {
        logger.warn({ uid, accountId: byEmail.id, error: err.message }, "setCustomUserClaims failed — role missing until token refresh");
      }
      logger.info({ uid, accountId: byEmail.id, role }, "Signup: claimed existing row by email");
      res.status(200).json({ id: byEmail.id, role, status: byEmail.status, claimed: true });
      return;
    }
  }

  // SECURITY: there is no name-match claim. The old stage here attached the first unclaimed raw/enriched row whose
  // full_name ILIKE'd `%<name>%` — unescaped, so `name: "%"` took over an arbitrary profile (and overwrote its e-mail),
  // and an exact victim name plus any unverified e-mail did the same. A /signup with no verified-email match (above)
  // always creates a new row. A plausible name match is only RECORDED, as a `proposed` identity claim (proof none)
  // that an operator can approve through decideClaim — it never links anything on its own.
  if (!signupsOpen()) {
    logger.info({ uid }, "Signup refused: sign-ups closed");
    res.status(403).json({ error: SIGNUPS_CLOSED_ERROR });
    return;
  }

  if (!(await appCheckAllows(req, "signup"))) { refuseAppCheck(res); return; }   // lib/appCheck.ts: new accounts only
  if (!(await newAccountAllowed(req))) { refuseBurst(res); return; }   // lib/signupBurst.ts: new accounts only
  const trimmedName = name.trim();
  const sportTrimmed = sport?.trim();

  const [inserted] = await db
    .insert(athletes)
    .values({
      full_name:     trimmedName,
      email:         email ?? null,
      auth_id:       uid,
      auth_provider: "firebase",
      sport:         sportTrimmed ?? null,
      school:        school?.trim() ?? null,
      status:        newAccountStatus(),
      // Only the new agent front (body.front === "agent") asks for the new onboarding — see agentFrontSignup.
      agent_onboarding_required: agentFrontSignup(req.body),
    })
    .returning({ id: athletes.id });

  await db.insert(accountRoles).values({ account_id: inserted.id, role });
  const membership = await grandfatherMembership({ athleteId: inserted.id, uid, email: email ?? null, displayName: trimmedName, note: "legacy_path:signup_create", role });   // 3a (P-1)
  const accountId = inserted.id;
  await recordSignupFlags(inserted.id, req, email);   // lib/signupFlags.ts: admin signals, never a block

  // Operator review only: never fatal, never a link.
  if (membership) {
    await proposeLegacyNameClaim({ userId: membership.userId, newAthleteId: inserted.id, name: trimmedName, sport: sportTrimmed || null })
      .catch((err: any) => logger.warn({ accountId, error: String(err?.message ?? err).slice(0, 160) }, "legacy name-match proposal not recorded"));
  }

  // Status 'raw' used to be a dead end: nothing ever researched an app-native signup.
  // Now research starts the moment a sport is known (the app sends name only today, so
  // this usually fires later from the landing page or the app's own setup — same run).
  if (role === "athlete" && sportTrimmed) {
    const started = agentFrontSignup(req.body) ? Promise.resolve() : startAppSignupResearch(inserted.id, { pinVersion: false });
    void started.then(() => enterLifecycleResearch(inserted.id, "signup"));   // PR E2b: the signup lifecycle event (legacy branch), after the start
  }
  logger.info({ uid, accountId, role }, "Signup complete");

  // Set Firebase custom claims — future tokens will carry { roles: ['athlete'] }
  // Client must call getIdToken(true) to force-refresh after signup
  try {
    await setRoleClaimKeepingOthers(firebaseAuth, uid, role);
  } catch (err: any) {
    // Non-fatal: claims will be missing until next natural token refresh.
    // The athlete row + role row are already created — don't roll back.
    logger.warn({ uid, accountId, error: err.message }, "setCustomUserClaims failed — role will be missing from token until refresh");
  }

  res.status(201).json({ id: accountId, role, status: newAccountStatus(), claimed: false });
});

// ─── GET /api/v1/auth/me ──────────────────────────────────────────────────────

router.get("/me", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;

  const [row] = await db.select().from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!row) { res.status(404).json({ error: "Athlete not found" }); return; }

  const [roleRow] = await db
    .select({ role: accountRoles.role })
    .from(accountRoles)
    .where(eq(accountRoles.account_id, athleteId))
    .limit(1);

  // Sport / school / conference: the projection columns.
  const identity = { sport: row.sport ?? null, school: row.school ?? null, conference: row.conference ?? null };

  // Phase A Step 3a: the caller's user and memberships (additive; never a provider uid). The self-membership of the
  // athlete this request resolved to is the caller's user (one self per athlete); with the read flag on req.userId is set.
  const self = await selfMembershipFor(athleteId).catch(() => null);
  const userId = req.userId ?? self?.userId ?? null;
  const memberships = userId ? await membershipsForUser(userId).catch(() => []) : [];
  const [userRow] = userId ? await db.select({ id: usersTable.id, provider: usersTable.provider, email_verified: usersTable.email_verified }).from(usersTable).where(eq(usersTable.id, userId)).limit(1) : [];
  const nameParts = (row.full_name ?? "").split(" ");
  res.json({
    user:             userRow ? { id: userRow.id, provider: userRow.provider, emailVerified: userRow.email_verified } : null,
    pendingClaims:    userId ? await pendingClaimCount(userId).catch(() => 0) : 0,
    memberships:      memberships.map((m) => ({ athleteId: m.athleteId, relation: m.relation, proof: m.proof, establishedAt: m.establishedAt.toISOString() })),
    id:               row.id,
    email:            row.email,
    firstName:        nameParts[0] || null,
    lastName:         nameParts.slice(1).join(" ") || null,
    profileImageUrl:  null,
    role:             roleRow?.role ?? "athlete",
    subscriptionTier: row.plan === "studio" ? "pro" : row.plan === "agent" ? "elite" : "free",
    sport:            identity.sport,
    school:           identity.school,
    conference:       identity.conference,
    goalArchetype:    row.goal_archetype ?? null,
    status:           row.status,
    gaFinaleSeen:     true,
    // Client-facing capability flag, not an athlete column — same shape as
    // gaFinaleSeen above. The Ask Mila mic button reads this to decide whether to
    // render at all: without it, a signed-in web user would be offered a button
    // that 404s whenever MILA_VOICE_WEB is off. Rides on this response because it
    // is the one authenticated bootstrap the app already fetches once per session
    // (client/lib/auth-context.tsx), so the button's availability is known before
    // the overlay first paints and costs no extra round-trip.
    voiceEnabled:     MILA.VOICE_WEB,
  });
});

// ─── POST /api/v1/auth/microsoft ──────────────────────────────────────────────
// Native-only: exchanges a Microsoft auth code for a Firebase custom token.
// Web clients use Firebase's signInWithPopup(microsoftProvider) directly.

const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MS_GRAPH_ME  = "https://graph.microsoft.com/v1.0/me";

router.post("/microsoft", authLimiter, async (req: Request, res: Response): Promise<void> => {
  const { code, redirectUri } = req.body as { code?: string; redirectUri?: string };
  if (!code || !redirectUri) {
    res.status(400).json({ error: "code and redirectUri required" });
    return;
  }

  const clientId     = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.status(500).json({ error: "Microsoft OAuth not configured" });
    return;
  }

  // Exchange code for tokens
  const tokenBody = new URLSearchParams({
    grant_type:    "authorization_code",
    client_id:     clientId,
    client_secret: clientSecret,
    redirect_uri:  redirectUri,
    code,
    scope:         "openid profile email User.Read",
  });

  const tokenRes = await fetch(MS_TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    tokenBody.toString(),
  });
  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    logger.warn({ status: tokenRes.status, detail: err.slice(0, 200) }, "Microsoft token exchange failed");
    res.status(400).json({ error: "Microsoft token exchange failed" });
    return;
  }
  const tokens = await tokenRes.json() as { access_token: string; id_token?: string };

  // Fetch Microsoft Graph profile
  const graphRes = await fetch(MS_GRAPH_ME, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!graphRes.ok) {
    res.status(400).json({ error: "Microsoft Graph profile fetch failed" });
    return;
  }
  const msProfile = await graphRes.json() as {
    id: string; displayName?: string; mail?: string; userPrincipalName?: string;
  };

  const msUid  = `microsoft:${msProfile.id}`;
  const email  = msProfile.mail ?? msProfile.userPrincipalName ?? null;
  const name   = msProfile.displayName ?? email?.split("@")[0] ?? "Athlete";

  // Find or create athlete
  let [existing] = await db
    .select({ id: athletes.id })
    .from(athletes)
    .where(eq(athletes.auth_id, msUid))
    .limit(1);

  if (!existing && athleteIndexClaimEnabled()) {
    // Phase A Step 3b (D-6): Graph `mail` is PRESENCE, not verification — Microsoft never yields verified_unique_email here.
    const r = await resolveIdentity({ path: "microsoft", caller: { uid: msUid, email, emailVerified: microsoftEmailVerified(msProfile) }, provider: "microsoft", query: { name }, linkOnly: !signupsOpen() });
    if (r.action === "confirm") {
      // 3b: candidates to confirm — no row is created here; the app's signup call after sign-in shows "Is this you?"
      logger.info({ msUid, tier: r.tier, claimSessionId: r.claimSessionId }, "Microsoft: candidates proposed, awaiting confirmation");
    } else if (r.action === "linked" || r.action === "existing") {
      await db.insert(accountRoles).values({ account_id: r.athleteId!, role: "athlete" });
      { const u = await findUserByUid(msUid); if (u) await db.insert(userRoles).values({ user_id: u.id, role: "athlete" }).onConflictDoNothing(); }   // 3a: membership written by linkUserToAthlete
      existing = { id: r.athleteId! };
      logger.info({ msUid, accountId: r.athleteId, proof: r.proof }, "Microsoft: linked existing row (claim proof)");
      void enterLifecycleResearch(r.athleteId!, "claim");   // PR E2b: Microsoft claim-link (role is always athlete here)
    } else {
      if (!signupsOpen()) { logger.info({ msUid }, "Microsoft: refused, sign-ups closed"); res.status(403).json({ error: SIGNUPS_CLOSED_ERROR }); return; }
      if (!(await appCheckAllows(req, "microsoft"))) { refuseAppCheck(res); return; }   // lib/appCheck.ts: new accounts only
      if (!(await newAccountAllowed(req))) { refuseBurst(res); return; }
      const created = await createAthleteForUser({ caller: { uid: msUid, email, emailVerified: false }, provider: "microsoft", path: "microsoft", displayName: name, values: { full_name: name, email, status: newAccountStatus() } });
      await db.insert(accountRoles).values({ account_id: created.athleteId, role: "athlete" });
      await db.insert(userRoles).values({ user_id: created.userId, role: "athlete" }).onConflictDoNothing();
      await finalizeResolution(r, created.athleteId).catch((err: any) => logger.warn({ accountId: created.athleteId, error: err.message }, "index match record failed"));
      existing = { id: created.athleteId };
      await recordSignupFlags(created.athleteId, req, email);   // lib/signupFlags.ts
      logger.info({ msUid, accountId: created.athleteId, tier: r.tier, decision: r.decision }, "Microsoft: created athlete (index consulted)");
      void enterLifecycleResearch(created.athleteId, "signup");   // PR E2b: Microsoft create (no sport yet ⇒ the service waits)
    }
  }
  if (!existing && !athleteIndexClaimEnabled()) {
    if (!signupsOpen()) { logger.info({ msUid }, "Microsoft: refused, sign-ups closed"); res.status(403).json({ error: SIGNUPS_CLOSED_ERROR }); return; }
    if (!(await appCheckAllows(req, "microsoft"))) { refuseAppCheck(res); return; }   // lib/appCheck.ts: new accounts only
    if (!(await newAccountAllowed(req))) { refuseBurst(res); return; }
    const [inserted] = await db
      .insert(athletes)
      .values({ full_name: name, email, auth_id: msUid, auth_provider: "microsoft", status: newAccountStatus() })
      .returning({ id: athletes.id });
    await grandfatherMembership({ athleteId: inserted.id, uid: msUid, email, displayName: name, note: "legacy_path:microsoft_create" });   // 3a (P-1)
    await db.insert(accountRoles).values({ account_id: inserted.id, role: "athlete" });
    existing = inserted;
    await recordSignupFlags(inserted.id, req, email);   // lib/signupFlags.ts
    logger.info({ msUid, accountId: inserted.id }, "Microsoft: created athlete");
    void enterLifecycleResearch(inserted.id, "signup");   // PR E2b: Microsoft legacy create (no sport yet ⇒ the service waits)
  }

  // Issue Firebase custom token — client calls signInWithCustomToken(auth, customToken)
  const customToken = await firebaseAuth.createCustomToken(msUid, { roles: ["athlete"] });

  res.json({ customToken });
});

export default router;
