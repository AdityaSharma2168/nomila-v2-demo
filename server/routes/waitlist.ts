/**
 * waitlist.ts — Auth-first landing-page waitlist (one-table).
 *
 * Landing signups authenticate with Firebase first, so a "waitlist entry" is just
 * an `athletes` row with status='waitlisted' (auth_id set). There is no separate
 * waitlist table — admin flips status to 'raw'/'active' to let someone into the app.
 *
 * POST /api/v1/waitlist
 *   Authenticated (Firebase ID token). Creates or updates the caller's athletes
 *   row. Called once per step of the landing flow (sign-in → sport → socials): the sign-in's own post carries no
 *   sport, so it creates her waitlisted row (name from the sign-in, else her e-mail's local part) and starts nothing;
 *   only fields present in the body are updated, so partial posts never wipe
 *   earlier answers, and socials merge instead of replacing.
 *   Body: { first_name?, last_name?, full_name?, school?, team?, sport?,
 *           goal_archetype?, secondary_goals?: string[], career_status?,
 *           socials?: { instagram?, tiktok?, youtube?, twitter? }, referral_code? }
 *   `team` (free text, asked by the new join flow only when the index finds nothing) is stored where the app stores
 *   the team it is told: athletes.school ("School / team"). `school` wins when both are sent.
 *
 * GET /api/v1/waitlist/rank
 *   Authenticated. Returns { rank, total, socials, connected } — the caller's live position
 *   among status='waitlisted' athletes (more socials = higher; signup time breaks ties).
 *   `socials` counts each ACTIVE connected Instagram / TikTok / YouTube account (one per
 *   distinct provider account) plus each legacy typed handle on a platform with no active
 *   connection; `connected` is the connected part alone. See RANK_SOCIALS_SQL.
 *
 * GET /api/v1/waitlist/progress
 *   Authenticated. What the join flow shows while she waits (agent/onboarding/waitlistProgress.ts):
 *   { status, research: { state, queuedUntil, readyEmail, steps: [{ key, status, count? }] }, findings: [{ kind, text, source: { label, url } }],
 *     score: null | { value, groups, bands, confidence, lines, raise }, rank: { position, total }, connected: [platform],
 *     referralCode, referrals, profile: { sport, team }, heroPhoto: boolean }. referralCode is HER OWN code for share links (https://nomila.co/?ref=<code>; lib/referralCode.ts,
 *   derived from her id); a ?ref= code a new athlete arrives with is stored as her referral_code, as before.
 *   referrals: how many athletes arrived with HER code — shown, never used for her spot.
 *   Rate-limited per SIGNED-IN USER, not per IP (a team on one campus network shares an IP); a 429 carries Retry-After
 *   (seconds) so the landing backs off.
 *   research.state "needs_more" (ATHLETE_FOOTPRINT_CHECK): the cheap "real athlete?" check found no public footprint, so
 *   no full research has started; research.reason says why. Adding a team or connecting Instagram re-runs the check.
 *   Dev only (signup_research v3/v4 runs): quickScore (the one-call quick score, until the full one lands) and
 *   scoreStage { stage: none|quick|final, full: processing|ready|failed, replacedQuick, quickAt, finalAt }.
 *   Findings and score come only from her real research and M.I.A. (never invented): [] / null until ready. A failed
 *   research (an outage, an exhausted provider quota) is research.state "failed" with a 200, never an error.
 */

import { Router, type Request, type Response } from "express";
import { actOnWaitlistHandle, HandleError, waitlistHandles } from "../agent/research/publicPlatform";
import rateLimit from "express-rate-limit";
import { eq, sql } from "drizzle-orm";
import { tokenFailure, verifyIdTokenChecked } from "../lib/auth";
import { db } from "../db";
import { athletes, accountRoles } from "../../shared/schema";
import { toGoalSlug , toCareerStatus } from "../../shared/goals";
import { recordLateSaidFacts, researchableName, signupResearchAgentEnabled, startSignupResearchRun } from "../agent/onboarding/signupResearch";
import { needsMoreFrom, startSignupResearchChecked } from "../agent/onboarding/footprintCheck";
import { athleteIndexClaimEnabled } from "../services/intelligence/identity/config";
import { finalizeResolution, resolveIdentity } from "../services/intelligence/identity/resolve";
import { grandfatherMembership } from "../services/intelligence/identity/users";
import { createAthleteForUser } from "../services/intelligence/identity/claims";
import { onboardingStartVersion } from "../workflow/definitions/onboarding";
import { createLogger } from "../logger";
import { referralCodeFor } from "../lib/referralCode";
import { newIdentityEvidence, recheckIdentityInBackground } from "../agent/researchRefresh/identityRecheck";
import { SIGNUPS_CLOSED_ERROR, signupsOpen } from "../lib/signups";
import { newAccountAllowed, refuseBurst } from "../lib/signupBurst";
import { appCheckAllows, refuseAppCheck } from "../lib/appCheck";
import { recordSignupFlags } from "../lib/signupFlags";
// PR E2b (design record §1.2 T1/T9, §5.4): the lifecycle research trigger and the anchor-edit re-entry. No-ops unless
// identityResolutionEnabled(); never fatal. Pinned by research/lifecycleHooks.test.ts (exhaustiveness guards).
import { anchorFieldsBefore, enterLifecycleResearch, reenterOnAnchorEdit } from "../services/intelligence/research/lifecycleHooks";

const logger = createLogger("routes/waitlist");
const router = Router();

const SOCIAL_KEYS = ["instagram", "tiktok", "youtube", "twitter"] as const;

// Per-IP rate limit. The landing flow posts once per step (signup → details → sport →
// goals → socials) plus retries, so the window is generous enough not to break a real
// multi-step signup while still blocking abuse. req.ip is the real client IP because
// index.ts trusts exactly Cloud Run's proxy hop (lib/trustProxy.ts), so it can't be spoofed.
const waitlistLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  limit:           50,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: "Too many requests — please slow down and try again shortly." },
});

// Max accepted lengths for free-text inputs. Anything longer is rejected (400) rather
// than silently truncated, so oversized/abusive payloads never reach the DB.
const LIMITS = {
  full_name: 120, first_name: 60, last_name: 60,
  school: 120, team: 120, sport: 60, goal_archetype: 80, referral_code: 64,
  social: 120, goal_item: 80, goals_count: 20,
} as const;

function overLimit(v: unknown, max: number): boolean {
  return typeof v === "string" && v.length > max;
}

// Returns the name of the first field that exceeds its cap, or null if all within limits.
function findOversizedField(body: Record<string, unknown>): string | null {
  const checks: [unknown, number, string][] = [
    [body.full_name,      LIMITS.full_name,      "full_name"],
    [body.first_name,     LIMITS.first_name,     "first_name"],
    [body.last_name,      LIMITS.last_name,      "last_name"],
    [body.school,         LIMITS.school,         "school"],
    [body.team,           LIMITS.team,           "team"],
    [body.sport,          LIMITS.sport,          "sport"],
    [body.goal_archetype, LIMITS.goal_archetype, "goal_archetype"],
    [body.referral_code,  LIMITS.referral_code,  "referral_code"],
  ];
  for (const [val, max, name] of checks) {
    if (overLimit(val, max)) return name;
  }
  if (Array.isArray(body.secondary_goals)) {
    if (body.secondary_goals.length > LIMITS.goals_count) return "secondary_goals";
    if (body.secondary_goals.some((g) => overLimit(g, LIMITS.goal_item))) return "secondary_goals";
  }
  if (body.socials && typeof body.socials === "object") {
    for (const k of SOCIAL_KEYS) {
      if (overLimit((body.socials as Record<string, unknown>)[k], LIMITS.social)) return `socials.${k}`;
    }
  }
  return null;
}

// Rank display: the REAL numbers (owner, 24 Oct 2026: no phantom members, no floor). Kept as named zeros so the rank
// arithmetic below and the tests read the same way they always did.
export const TOTAL_BASE = 0;   // no phantom members: the total is the real waitlist
export const RANK_FLOOR = 0;   // no floor: the first athlete on the list is #1

/** The connected platforms that move an athlete up the list (the social accounts the join flow asks her to connect). */
export const RANK_PLATFORMS = ["instagram", "tiktok", "youtube"] as const;

/**
 * Per waitlisted athlete: `connected` = her ACTIVE connected accounts on RANK_PLATFORMS, one per distinct provider
 * account (0071's connection identity: (athlete, platform, platform_user_id) is one account for life; a row with no
 * platform_user_id yet counts as itself), and `typed` = her legacy typed handles (athletes.socials, the old landing
 * form) on a platform where she has no active connection — so typing a handle and later connecting the same platform
 * is one signal, not two. `n` = connected + typed is the rank signal.
 */
const RANK_SOCIALS_SQL = sql`
  SELECT a.auth_id, a.created_at, c.connected,
         (SELECT count(*) FROM jsonb_each_text(coalesce(a.socials, '{}'::jsonb)) e
            WHERE e.value <> '' AND NOT (e.key = ANY(c.platforms))) AS typed
  FROM athletes a
  CROSS JOIN LATERAL (
    SELECT count(DISTINCT (ca.platform, coalesce(ca.platform_user_id, ca.id::text)))::int AS connected,
           coalesce(array_agg(DISTINCT ca.platform) FILTER (WHERE ca.platform IS NOT NULL), '{}'::text[]) AS platforms
    FROM connected_accounts ca
    WHERE ca.athlete_id = a.id AND ca.status = 'active'
      AND ca.platform IN (${sql.join(RANK_PLATFORMS.map((p) => sql`${p}`), sql`, `)})
  ) c
  WHERE a.status = 'waitlisted'
`;

// Input length caps — a waitlist row feeds the AI research pipeline, so an
// uncapped field could inflate prompt cost or break the API call. Truncate
// rather than reject so a legitimate (if long) submission still goes through.
const MAX_TEXT = 256;   // names, school, sport, goal, referral code
const MAX_HANDLE = 64;  // social handles are never this long

function cleanStr(v: unknown, max = MAX_TEXT): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

// Goals are slugs from the ONE vocabulary (shared/goals.ts). Anything else is rejected with
// the field name, not silently dropped — the landing page's list is tested to match.
function cleanGoals(v: unknown): { ok: true; goals: string[] } | { ok: false; bad: string } {
  if (!Array.isArray(v)) return { ok: true, goals: [] };
  const seen = new Set<string>();
  for (const item of v) {
    const g = toGoalSlug(item);
    if (!g) return { ok: false, bad: typeof item === "string" ? item.slice(0, 40) : String(item) };
    seen.add(g);
  }
  return { ok: true, goals: [...seen] };
}

// Keep only known platforms with non-empty handle strings.
function cleanSocials(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object") {
    for (const k of SOCIAL_KEYS) {
      const h = cleanStr((v as Record<string, unknown>)[k], MAX_HANDLE);
      if (h) out[k] = h;
    }
  }
  return out;
}

// Verify the Firebase ID token (revocation-checked) → caller identity; null if missing/invalid/revoked; "unavailable"
// when the revocation check itself could not run (answer 503, not 401).
async function verifyCaller(req: Request) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  try {
    const d = await verifyIdTokenChecked(header.slice(7));
    return {
      uid:     d.uid,
      email:   d.email ?? null,
      emailVerified: d.email_verified === true,
      name:    d.name ?? null,
      picture: d.picture ?? null,
    };
  } catch (err) {
    return tokenFailure(err).status === 503 ? ("unavailable" as const) : null;
  }
}

/** Answer a caller verifyCaller could not identify: 503 when the check could not run, else 401 with `message`. */
function refuseCaller(res: Response, user: "unavailable" | null, message: string): void {
  if (user === "unavailable") res.status(503).json(tokenFailure({ code: "auth/revocation-check-unavailable" }).body);
  else res.status(401).json({ error: message });
}

// ─── POST /api/v1/waitlist ────────────────────────────────────────────────────

router.post("/", waitlistLimiter, async (req: Request, res: Response): Promise<void> => {
  const user = await verifyCaller(req);
  if (!user || user === "unavailable") { refuseCaller(res, user, "Sign in to join the waitlist"); return; }

  const body = (req.body ?? {}) as Record<string, unknown>;

  const oversized = findOversizedField(body);
  if (oversized) {
    res.status(400).json({ error: `${oversized} is too long` });
    return;
  }
  const first   = cleanStr(body.first_name);
  const last    = cleanStr(body.last_name);
  // The name she typed in THIS post, if any. Only this updates an existing row: a later step's post (sport, socials…)
  // carries no name, and must not overwrite the one she gave with the sign-in's display name or her e-mail's local part
  // (the research searches for this name).
  const typedFull = cleanStr(body.full_name) ?? ([first, last].filter(Boolean).join(" ") || null);
  // A NEW row needs a name (NOT NULL): what she typed, else the sign-in's display name, else the e-mail's local part.
  const full    = typedFull
    ?? cleanStr(user.name)
    ?? (user.email ? user.email.split("@")[0] : null);
  const school   = cleanStr(body.school) ?? cleanStr(body.team);   // "School / team": one column, as the app stores it
  const sport    = cleanStr(body.sport);
  // Goals: slugs from shared/goals.ts only. A value we don't know is a 400 naming the field.
  const rawGoal  = cleanStr(body.goal_archetype);
  const goal     = rawGoal ? toGoalSlug(rawGoal) : null;
  if (rawGoal && !goal) {
    res.status(400).json({ error: "goal_archetype is not a known goal", field: "goal_archetype" });
    return;
  }
  const goalsResult = cleanGoals(body.secondary_goals);
  if (!goalsResult.ok) {
    res.status(400).json({ error: `secondary_goals contains an unknown goal: ${goalsResult.bad}`, field: "secondary_goals" });
    return;
  }
  const secGoals = goalsResult.goals;
  // Career status (landing step 4): a declared fact. A value we don't know is a 400 naming the field.
  const rawCareer = cleanStr(body.career_status, 40);
  const career    = rawCareer ? toCareerStatus(rawCareer) : null;
  if (rawCareer && !career) {
    res.status(400).json({ error: "career_status is not a known status", field: "career_status" });
    return;
  }
  const socials  = cleanSocials(body.socials);
  const referral = cleanStr(body.referral_code);
  // Only the goals step sends this key; other steps must not clear it.
  const hasSecGoals = "secondary_goals" in body;

  try {
    const [existing] = await db
      .select({
        id:             athletes.id,
        first_name:     athletes.first_name,
        sport:          athletes.sport,
        socials:        athletes.socials,
        goal_archetype: athletes.goal_archetype,
        status:         athletes.status,
      })
      .from(athletes)
      .where(eq(athletes.auth_id, user.uid))
      .limit(1);

    // Phase A Step 2c (ATHLETE_INDEX_CLAIM): before creating a waitlist row, search the Athlete Index.
    // Only a claim proof (a unique, provider-verified email) links this sign-in to an existing row;
    // any match tier on its own creates the row and records the candidates. Flag off ⇒ unchanged.
    let target: { id: string } | null = existing ? { id: existing.id } : null;
    let resolution: Awaited<ReturnType<typeof resolveIdentity>> | null = null;
    // Sign-ups kill switch (SIGNUPS_OPEN): a caller with no row yet is a NEW account. Index flag off ⇒ every such
    // call creates, so refuse now; flag on ⇒ a claim proof may still link an existing row, so refuse at the create below.
    if (!existing && !athleteIndexClaimEnabled() && !signupsOpen()) {
      res.status(403).json({ error: SIGNUPS_CLOSED_ERROR });
      return;
    }
    if (!existing && athleteIndexClaimEnabled()) {
      resolution = await resolveIdentity({ path: "waitlist", caller: { uid: user.uid, email: user.email, emailVerified: user.emailVerified }, provider: "firebase", claimSessionId: cleanStr(body.claim_session_id, 64), query: { name: full ?? "", sport, teamOrSchool: school, handles: socials }, linkOnly: !signupsOpen() });   // closed: no candidates surface
      // Phase A Step 3b: "Is this you?" — the landing page shows the candidates; nothing links on a tier
      if (resolution.action === "confirm") { res.status(409).json({ error: "confirmation_required", claimSessionId: resolution.claimSessionId, tier: resolution.tier, claims: resolution.claims }); return; }
      if (resolution.action === "session_unknown") { res.status(400).json({ error: "claim_session_unknown" }); return; }
      if (resolution.action === "linked" || resolution.action === "existing") {
        target = { id: resolution.athleteId! };
        await db.insert(accountRoles).values({ account_id: resolution.athleteId!, role: "athlete" }).onConflictDoNothing();
        logger.info({ athleteId: resolution.athleteId, proof: resolution.proof }, "Waitlist: linked existing row (claim proof)");
      } else if (!signupsOpen()) {
        res.status(403).json({ error: SIGNUPS_CLOSED_ERROR });
        return;
      }
    }

    // A NEW account (no row, no claim link): the burst limit (lib/signupBurst.ts), a calm 429 the landing retries later.
    // ...and App Check (lib/appCheck.ts, APP_CHECK_ENFORCE): only here, where a new account is about to be made.
    if (!target && !(await appCheckAllows(req, "waitlist"))) { refuseAppCheck(res); return; }
    if (!target && !(await newAccountAllowed(req))) { refuseBurst(res); return; }
    let createdId: string | null = null;   // a NEW account made below: its admin flags (lib/signupFlags.ts)

    if (target) {
      const anchorBefore = await anchorFieldsBefore(target.id);   // PR E2b: name / sport may change below
      // Her school / team and handles before this post: new identity evidence re-checks a held identity (below).
      const [evidenceBefore] = await db.select({ school: athletes.school, socials: athletes.socials }).from(athletes).where(eq(athletes.id, target.id)).limit(1);
      // COALESCE keeps prior answers when this step omitted a field; socials
      // merge (||) so each step adds handles instead of replacing them.
      await db
        .update(athletes)
        .set({
          full_name:     sql`coalesce(${typedFull}, ${athletes.full_name})`,
          first_name:    sql`coalesce(${first}, ${athletes.first_name})`,
          last_name:     sql`coalesce(${last}, ${athletes.last_name})`,
          school:        sql`coalesce(${school}, ${athletes.school})`,
          sport:         sql`coalesce(${sport}, ${athletes.sport})`,
          goal_archetype: sql`coalesce(${goal}, ${athletes.goal_archetype})`,
          career_status: sql`coalesce(${career}, ${athletes.career_status})`,
          ...(hasSecGoals
            ? { secondary_goals: sql`${JSON.stringify(secGoals)}::jsonb` }
            : {}),
          email:         sql`coalesce(${user.email}, ${athletes.email})`,
          photo_url:     sql`coalesce(${user.picture}, ${athletes.photo_url})`,
          referral_code: sql`coalesce(${referral}, ${athletes.referral_code})`,
          socials:       sql`${athletes.socials} || ${JSON.stringify(socials)}::jsonb`,
        })
        .where(eq(athletes.id, target.id));
      await reenterOnAnchorEdit(target.id, anchorBefore);         // PR E2b: T9 (resolved) / T7 on a changed name or sport
      // A held identity (an open "#identity" verdict) is re-checked when she adds or changes her school / team or a
      // handle (agent/researchRefresh/identityRecheck.ts: a no-op without one; at most once a day). Not awaited.
      const evidence = newIdentityEvidence(evidenceBefore ?? null, { school, socials });
      if (evidence) recheckIdentityInBackground(target.id, evidence, "waitlist", Object.keys(socials).length ? { typedHandles: socials } : {});
    } else if (resolution && (resolution.action === "create")) {
      // Phase A Step 3b (flag on): the new row + its self-membership in one transaction (proof human_confirmation)
      const created = await createAthleteForUser({ caller: { uid: user.uid, email: user.email, emailVerified: user.emailVerified }, provider: "firebase", path: "waitlist", claimSessionId: resolution.claimSessionId ?? null, displayName: full ?? null,
        values: { full_name: full ?? "Athlete", first_name: first, last_name: last, school, sport, goal_archetype: goal, career_status: career ?? undefined, secondary_goals: hasSecGoals ? secGoals : undefined, email: user.email, photo_url: user.picture, socials, referral_code: referral, status: "waitlisted" } as any });
      await db.insert(accountRoles).values({ account_id: created.athleteId, role: "athlete" });
      createdId = created.athleteId;
      await finalizeResolution(resolution, created.athleteId).catch((err: any) => logger.warn({ athleteId: created.athleteId, error: err.message }, "index match record failed"));
    } else {
      const [inserted] = await db
        .insert(athletes)
        .values({
          full_name:     full ?? "Athlete", // full_name is NOT NULL
          first_name:    first,
          last_name:     last,
          school,
          sport,
          goal_archetype: goal,
          career_status: career ?? undefined,
          secondary_goals: hasSecGoals ? secGoals : undefined,
          email:         user.email,
          photo_url:     user.picture,
          auth_id:       user.uid,
          auth_provider: "firebase",
          socials,
          referral_code: referral,
          status:        "waitlisted",
        })
        .returning({ id: athletes.id });
      await db.insert(accountRoles).values({ account_id: inserted.id, role: "athlete" });
      createdId = inserted.id;
      await grandfatherMembership({ athleteId: inserted.id, uid: user.uid, email: user.email ?? null, displayName: full ?? null, note: "legacy_path:waitlist_create", role: "athlete" });   // 3a (P-1)
      if (resolution) await finalizeResolution(resolution, inserted.id).catch((err: any) => logger.warn({ athleteId: inserted.id, error: err.message }, "index match record failed"));
    }

    // Research starts the moment we know who to search for. The landing page posts one
    // partial payload per step, so the row exists from step 1 but the sport arrives at
    // step 3 — this fires on the first post that leaves the row with a sport. Idempotent:
    // one active onboarding run per athlete, and the key returns the same run afterwards.
    if (createdId) await recordSignupFlags(createdId, req, user.email);   // signals for the admin list, never a block; never throws
    const athleteId = existing?.id ?? (await db.select({ id: athletes.id }).from(athletes).where(eq(athletes.auth_id, user.uid)).limit(1))[0]?.id;
    const knownSport = sport ?? existing?.sport ?? null;
    // ...and only with a name to search for. The landing creates her row at sign-in (a post with no sport), named from
    // the sign-in's display name or, without one, her e-mail's local part; research never searches for that local part
    // or the "Athlete" fallback (researchableName), on either route: it waits for the name she types with her sport.
    const [named] = athleteId && knownSport ? await db.select({ full_name: athletes.full_name, email: athletes.email }).from(athletes).where(eq(athletes.id, athleteId)).limit(1) : [];
    if (athleteId && knownSport && named && !researchableName(named.full_name, named.email)) logger.info({ athleteId }, "sign-up research waits for her name");
    if (athleteId && knownSport && named && researchableName(named.full_name, named.email)) {
      // Through the one sign-up research chokepoint (agent/onboarding/signupResearch.ts): over the daily cap
      // (DAILY_RESEARCH_CAP_USD) the run starts held and the minute tick releases it when there is budget; she joins
      // the waitlist either way.
      // PR E2b: every create / claim-link branch above converges here, under the same guard as onboarding (the sport is
      // known). Idempotent (T1 only from NULL; the same day key), not awaited, never fatal.
      const lifecycle = () => enterLifecycleResearch(athleteId, resolution?.action === "linked" || resolution?.action === "existing" ? "claim" : "signup");
      // SIGNUP_RESEARCH_AGENT on: the agent's research-only run (sourced facts in memory + her M.I.A. score) instead of
      // legacy research; never both for one athlete (the chokepoint refuses each when the other exists). The lifecycle
      // entry waits for the start to settle: once her agent run exists the hook skips her (agentFrontAthlete.ts), so
      // she is never researched by both.
      // ATHLETE_FOOTPRINT_CHECK on: one cheap "real athlete?" web check first (agent/onboarding/footprintCheck.ts); not
      // found ⇒ no full research (and no lifecycle entry) until a team or an Instagram account with posts is added.
      if (signupResearchAgentEnabled()) {
        void startSignupResearchChecked(athleteId, { createdBy: "signup" })
          .then((r) => { if (!r.started) logger.info({ athleteId, reason: r.reason }, "signup research (agent) not started"); return r; })
          .catch((err: any) => { logger.error({ athleteId, error: err.message }, "signup research (agent) start failed"); return null; })
          .then((r) => (r && !r.started && r.reason === "no_footprint" ? undefined : lifecycle()));
      } else {
        startSignupResearchRun({ process: "onboarding", athleteId, createdBy: "signup", idempotencyKey: `onboarding:${athleteId}`, version: onboardingStartVersion() }, { capped: true })
          .catch((err: any) => logger.error({ athleteId, error: err.message }, "onboarding run start failed"));
        void lifecycle();
      }
      // A school / team that arrives after her agent research was started (the join flow asks it later) is recorded as
      // something she told us, for any research step that has not run yet (a queued run, the merge). Never fatal.
      if (school && existing?.sport) void recordLateSaidFacts(athleteId).catch((err: any) => logger.warn({ athleteId, error: err.message }, "late said facts not recorded"));
    }

    // `returning` is true when this caller already had an athletes row before this
    // sign-in. The landing page uses it to skip a returning athlete straight to their
    // waitlist status screen instead of re-walking them through the signup steps; the
    // profile snapshot (pre-update values) lets that screen render their sport/socials.
    //
    // `promoted` is true once an admin has moved them off the waitlist (any status
    // other than 'waitlisted' — promotion flips it to 'active'). The landing page
    // shows a "you're in — open the app" screen instead of the waitlist status.
    res.status(200).json({
      ok:        true,
      returning: !!existing,
      promoted:  !!existing && existing.status !== "waitlisted",
      profile:   existing
        ? {
            first_name:     existing.first_name,
            sport:          existing.sport,
            socials:        existing.socials ?? {},
            goal_archetype: existing.goal_archetype,
            status:         existing.status,
          }
        : null,
    });
  } catch (err: any) {
    logger.error({ error: err.message }, "Waitlist upsert failed");
    res.status(500).json({ error: "Could not join the waitlist. Please try again." });
  }
});

// ─── GET /api/v1/waitlist/rank ────────────────────────────────────────────────

/** Her live waitlist position (null when she is not a waitlisted row). Shared by /rank and /progress. */
export async function rankFor(uid: string): Promise<{ rank: number; total: number; socials: number; connected: number } | null> {
  // Socials per row → "signal" (RANK_SOCIALS_SQL). Ordering ahead of me = higher
  // signal, or equal signal but signed up earlier. Scoped to waitlisted rows.
  const result: any = await db.execute(sql`
    WITH raw AS (${RANK_SOCIALS_SQL}),
    sc AS (SELECT auth_id, created_at, connected, (connected + typed) AS n FROM raw),
    me AS (SELECT n, connected, created_at FROM sc WHERE auth_id = ${uid})
    SELECT
      (SELECT count(*)::int FROM athletes WHERE status = 'waitlisted') AS total_real,
      (SELECT n FROM me) AS my_socials,
      (SELECT connected FROM me) AS my_connected,
      (SELECT count(*)::int FROM sc, me
         WHERE sc.n > me.n OR (sc.n = me.n AND sc.created_at < me.created_at)) AS ahead
    FROM me
  `);

  const row = result.rows?.[0];
  if (!row) return null;
  const total = TOTAL_BASE + Number(row.total_real ?? 0);
  const rank  = Math.min(total, RANK_FLOOR + Number(row.ahead ?? 0) + 1);
  return { rank, total, socials: Number(row.my_socials ?? 0), connected: Number(row.my_connected ?? 0) };
}

router.get("/rank", async (req: Request, res: Response): Promise<void> => {
  const user = await verifyCaller(req);
  if (!user || user === "unavailable") { refuseCaller(res, user, "Sign in to view your rank"); return; }

  try {
    const r = await rankFor(user.uid);
    if (!r) {
      res.status(404).json({ error: "Not on the waitlist yet" });
      return;
    }
    res.status(200).json(r);
  } catch (err: any) {
    logger.error({ error: err.message }, "Waitlist rank failed");
    res.status(500).json({ error: "Could not compute rank." });
  }
});

// ─── GET /api/v1/waitlist/progress ────────────────────────────────────────────

type Caller = Exclude<Awaited<ReturnType<typeof verifyCaller>>, null | "unavailable">;

/** Identify the caller first (401 / 503 as everywhere here), so the limit below can be keyed on her. */
async function progressCaller(req: Request, res: Response, next: () => void): Promise<void> {
  const user = await verifyCaller(req);
  if (!user || user === "unavailable") { refuseCaller(res, user, "Sign in to see your progress"); return; }
  res.locals.waitlistCaller = user;
  next();
}

// Keyed on the signed-in user (Firebase uid), not the IP: athletes on one campus or team network share an IP. A poll
// every ~4 s is 15 a minute; 40 leaves room for two tabs and retries, and stops a tight loop. A 429 carries Retry-After.
const progressLimiter = rateLimit({
  windowMs: 60_000, limit: 40, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (_req: Request, res: Response) => `uid:${(res.locals.waitlistCaller as Caller).uid}`,
  message: { error: "Too many requests — please slow down and try again shortly." },
});

router.get("/progress", progressCaller, progressLimiter, async (_req: Request, res: Response): Promise<void> => {
  const user = res.locals.waitlistCaller as Caller;

  try {
    const [me] = await db.select({ id: athletes.id, status: athletes.status, full_name: athletes.full_name, email: athletes.email, sport: athletes.sport, school: athletes.school, signup_flags: athletes.signup_flags })
      .from(athletes).where(eq(athletes.auth_id, user.uid)).limit(1);
    if (!me) { res.status(404).json({ error: "Not on the waitlist yet" }); return; }
    const { connectedPlatformsOf, waitlistResearchProgress } = await import("../agent/onboarding/waitlistProgress");
    const { heroPhotoOf } = await import("../agent/onboarding/heroPhoto");
    const myCode = referralCodeFor(me.id);
    const [progress, rank, connected, hero, referred] = await Promise.all([
      waitlistResearchProgress(me.id, me.full_name ?? "", undefined, { email: me.email, status: me.status }), rankFor(user.uid), connectedPlatformsOf(me.id),
      heroPhotoOf(me.id).catch(() => null),
      // How many athletes joined with her link (display only: referrals never change her spot; owner, 24 Oct 2026).
      db.select({ n: sql<number>`count(*)::int` }).from(athletes).where(eq(athletes.referral_code, myCode)).then((r) => Number(r[0]?.n) || 0).catch(() => 0),
    ]);
    // The "real athlete?" check found nothing yet (footprintCheck.ts): no research run, so say what would help.
    const held = needsMoreFrom(me.signup_flags, progress.research.state);
    res.status(200).json({
      status:    me.status,
      research:  held ? { ...progress.research, state: "needs_more", reason: held.reason } : progress.research,
      findings:  progress.findings,
      score:     progress.score,
      // The one-call grounded quick score (signup_research v3; dev only): shown to HER only — this route answers the
      // signed-in athlete about herself — with its sources (shown as our own source chips), until the full score lands.
      ...(progress.quickScore ? { quickScore: progress.quickScore } : {}),
      // Which score is on show — none → quick (full still processing) → final — on runs with a quick_score step only.
      ...(progress.scoreStage ? { scoreStage: progress.scoreStage } : {}),
      rank:     rank ? { position: rank.rank, total: rank.total } : null,
      connected: connected.filter((p) => (RANK_PLATFORMS as readonly string[]).includes(p)),
      referralCode: myCode,
      referrals: referred,                                         // athletes who joined with her link (display only)
      // The share card: the sport · team line under her name, and whether GET /hero-photo has her own photo.
      profile:   { sport: me.sport ?? null, team: me.school ?? null },
      heroPhoto: !!hero,
      // "Is this your Instagram / YouTube?" (agent/research/publicPlatform.ts; the scoring source rule): what she
      // confirmed, the handle research suggests, and what she rejected. Empty unless LEAN_SIGNUP_RESEARCH.
      handles:   handlesOn() ? await waitlistHandles(me.id).catch(() => []) : [],
    });
  } catch (err: any) {
    logger.error({ error: err.message }, "Waitlist progress failed");
    res.status(500).json({ error: "Could not read your progress." });
  }
});

// ─── POST /api/v1/waitlist/handles/:platform ──────────────────────────────────
// { action: "confirm" | "reject", handle? } — the signed-in athlete confirms or rejects the Instagram / YouTube handle
// shown for that platform (agent/research/publicPlatform.ts actOnWaitlistHandle). Idempotent. A confirm reads the
// public profile once (Business Discovery / YouTube Data API) so its numbers can reach the M.I.A. as public-platform
// measured data. → 200 { handles, lookup?, measured? }. 404 unless LEAN_SIGNUP_RESEARCH.
const handlesOn = () => process.env.LEAN_SIGNUP_RESEARCH === "true";
const handleActionLimiter = rateLimit({
  windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (_req: Request, res: Response) => `uid:${(res.locals.waitlistCaller as Caller).uid}`,
  message: { error: "Too many requests — please slow down and try again shortly." },
});

router.post("/handles/:platform", progressCaller, handleActionLimiter, async (req: Request, res: Response): Promise<void> => {
  if (!handlesOn()) { res.status(404).json({ error: "Not found" }); return; }
  const user = res.locals.waitlistCaller as Caller;
  try {
    const [me] = await db.select({ id: athletes.id }).from(athletes).where(eq(athletes.auth_id, user.uid)).limit(1);
    if (!me) { res.status(404).json({ error: "Not on the waitlist yet" }); return; }
    res.status(200).json(await actOnWaitlistHandle(me.id, String(req.params.platform), req.body ?? {}));
  } catch (err: any) {
    if (err instanceof HandleError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
    logger.error({ error: String(err?.message ?? err).slice(0, 200) }, "Waitlist handle action failed");
    res.status(500).json({ error: "Could not save that." });
  }
});

// ─── GET /api/v1/waitlist/hero-photo ──────────────────────────────────────────
// Her own hero photo's bytes (agent/onboarding/heroPhoto.ts: the Me hero's bar), for the landing's share card. Served
// through the API so the card's canvas stays exportable (a cross-origin image without CORS would taint it). 404 when
// she has none (the card uses an atmosphere photo). Private, short cache; the same per-user limit as /progress.
router.get("/hero-photo", progressCaller, progressLimiter, async (_req: Request, res: Response): Promise<void> => {
  const user = res.locals.waitlistCaller as Caller;
  try {
    const [me] = await db.select({ id: athletes.id }).from(athletes).where(eq(athletes.auth_id, user.uid)).limit(1);
    if (!me) { res.status(404).json({ error: "Not on the waitlist yet" }); return; }
    const { heroPhotoOf } = await import("../agent/onboarding/heroPhoto");
    const hero = await heroPhotoOf(me.id);
    const { readObject } = await import("../lib/mediaStore");
    const obj = hero?.gcs_path ? await readObject(hero.gcs_path) : null;
    if (!obj || !obj.contentType.startsWith("image/")) { res.status(404).json({ error: "No photo yet" }); return; }
    res.setHeader("Content-Type", obj.contentType);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.status(200).send(obj.buf);
  } catch (err: any) {
    logger.error({ error: err.message }, "Waitlist hero photo failed");
    res.status(500).json({ error: "Could not read your photo." });
  }
});

export default router;
