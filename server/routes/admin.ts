/**
 * admin.ts — Admin dashboard API: waitlist review + promotion.
 *
 * Mounted at /api/v1/admin, gated by requireAdmin (see server/lib/auth.ts): only callers
 * holding the 'admin' role pass.
 *
 *   GET  /api/v1/admin/me
 *     Whoami for the dashboard: caller's roles.
 *
 *   GET  /api/v1/admin/waitlist?status=waitlisted[&q=][&sport=][&from=YYYY-MM-DD][&to=YYYY-MM-DD]
 *     List athletes by status (default 'waitlisted') with the signals an admin needs to
 *     eyeball identity before promoting: landing-entered social handles + OAuth-connected
 *     accounts (the real ownership proof), her M.I.A. score, and her furthest join step
 *     (`step`: signed_in · sport · connected · researched · scored — furthestStep below, the same
 *     milestones the landing resumes from). `q` matches the Athlete Index by name/alias, plus the
 *     e-mail (contains, any case); `sport` is an exact match (any case); `from` / `to` bound the
 *     sign-up date (inclusive, UTC days). Each row carries `flags` (lib/signupFlags.ts: disposable_email ·
 *     same_network_burst · no_athlete_footprint), signals for review that never block; `flagged=yes|no` filters on them.
 *
 *   POST /api/v1/admin/waitlist/:athleteId/promote   body: { reresearch?: boolean }
 *     Flip status → 'active' and notify the athlete ("you're in"). Research is NOT this
 *     route's job any more — it runs at signup as the athlete's onboarding workflow run.
 *     Promotion only makes sure that run exists (older accounts) and, with reresearch,
 *     starts a research_refresh run. Both are visible on the admin runs page.
 *
 *   POST /api/v1/admin/athletes/:athleteId/delete   body: { confirmEmail }
 *     Run the account deletion for them (routes/adminDeleteAccount.ts). List rows carry `deleting` once it has started.
 */

import { Router, type Request, type Response } from "express";
import { containsPattern } from "../lib/likePattern";
import { and, eq, gte, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { requireAdmin } from "../lib/auth";
import { onboardingStartVersion } from "../workflow/definitions/onboarding";
import { db } from "../db";
import { athletes, connectedAccounts } from "../../shared/schema";
import { workflowRuns, workflowSteps } from "../../shared/schemaWorkflow";
import { buildMyIntelligence } from "../services/intelligence/views/myIntelligence";
import { startRun } from "../workflow/runner";
import { latestRunOf, retireSignupResearch, SIGNUP_RESEARCH_PROCESS, startSignupResearchRun } from "../agent/onboarding/signupResearch";
import { notifyPromotion } from "../lib/notify";
import { flagNames } from "../lib/signupFlags";
import { athleteIdFromReferralCode, referralCodeFor } from "../lib/referralCode";
import { createLogger } from "../logger";
import { workflowAdminRouter } from "../workflow/routes";
import adminIntelligenceRouter from "./adminIntelligence";
import { researchRefreshAdminRouter } from "../agent/researchRefresh/routes";
import adminDeleteAccountRouter from "./adminDeleteAccount";
import { searchIndex } from "../services/intelligence/identity/index";
// PR E2b (design record §5.4): claim-links converge on the lifecycle research trigger. No-op unless
// identityResolutionEnabled(); never fatal. Pinned by research/lifecycleHooks.test.ts (exhaustiveness guard).
import { enterLifecycleResearch } from "../services/intelligence/research/lifecycleHooks";

const logger = createLogger("routes/admin");
const router = Router();

const LISTABLE_STATUSES = ["waitlisted", "raw", "enriched", "claimed", "active"] as const;

router.use(requireAdmin);

// Workflow runner operator surface (/api/v1/admin/workflow/*) — mounted AFTER requireAdmin
// so every route inherits the gate. See server/workflow/routes.ts.
router.use(workflowAdminRouter);

// Development / admin seams for the intelligence pipeline (/api/v1/admin/intelligence/*): resolve identity, run governed
// v3 research, recompute M.I.A., inspect. Mounted AFTER requireAdmin so every route inherits the gate.
router.use("/intelligence", adminIntelligenceRouter);

// The agent research refresh, one athlete, now (/api/v1/admin/agent/research-refresh/:athleteId). After requireAdmin.
router.use(researchRefreshAdminRouter);

// Staff run the app's real account deletion (POST /api/v1/admin/athletes/:athleteId/delete). After requireAdmin.
router.use(adminDeleteAccountRouter);

// ─── GET /api/v1/admin/me ───────────────────────────────────────────────────────

router.get("/me", (req: Request, res: Response): void => {
  const roles = req.roles ?? [];
  res.json({
    athleteId:  req.athleteId ?? null,
    roles,
    isAdmin:    roles.includes("admin"),
  });
});

// ─── GET /api/v1/admin/waitlist ───────────────────────────────────────────────────

/** The join flow's milestones, in order: what the admin list shows as her furthest step. */
export const JOIN_STEPS = ["signed_in", "sport", "connected", "researched", "scored"] as const;
export type JoinStep = (typeof JOIN_STEPS)[number];
/** The platforms whose connection counts as "connected" (the landing's connect step; the waitlist rank's platforms). */
const JOIN_CONNECT_PLATFORMS = new Set(["instagram", "tiktok", "youtube"]);

/**
 * Pure: her furthest join step — the highest milestone reached (signed in < sport < connected < researched < scored),
 * the same facts the landing resumes from: a sport on her row; an active Instagram / TikTok / YouTube connection;
 * her sign-up research merged (or the legacy onboarding run done, or legacy enrichment); her M.I.A. score.
 */
export function furthestStep(f: { sport: string | null; connected: boolean; researched: boolean; scored: boolean }): JoinStep {
  if (f.scored) return "scored";
  if (f.researched) return "researched";
  if (f.connected) return "connected";
  if (f.sport && f.sport.trim()) return "sport";
  return "signed_in";
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (v: unknown): Date | null => (typeof v === "string" && DAY_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? new Date(`${v}T00:00:00Z`) : null);
const nextDay = (d: Date): Date => new Date(d.getTime() + 864e5);

router.get("/waitlist", async (req: Request, res: Response): Promise<void> => {
  const statusParam = typeof req.query.status === "string" ? req.query.status : "waitlisted";
  if (!LISTABLE_STATUSES.includes(statusParam as (typeof LISTABLE_STATUSES)[number])) {
    res.status(400).json({ error: `status must be one of: ${LISTABLE_STATUSES.join(", ")}` });
    return;
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
  // Phase A Step 2c: ?q= searches the Athlete Index by name/alias (read-only; mutates nothing).
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 160) : "";
  const sportQ = typeof req.query.sport === "string" ? req.query.sport.trim().slice(0, 60) : "";
  const from = dayOf(req.query.from), to = dayOf(req.query.to);
  if ((req.query.from && !from) || (req.query.to && !to)) { res.status(400).json({ error: "from / to must be YYYY-MM-DD" }); return; }
  // Sport and sign-up date: in SQL on the plain list, and on the q hits after they are read.
  const filters: SQL[] = [eq(athletes.status, statusParam)];
  if (sportQ) filters.push(sql`lower(${athletes.sport}) = ${sportQ.toLowerCase()}`);
  if (from) filters.push(gte(athletes.created_at, from));
  if (to) filters.push(lt(athletes.created_at, nextDay(to)));
  // Admin flags (anti-fake plan): ?flagged=yes ⇒ only rows with at least one flag; ?flagged=no ⇒ only rows with none.
  const flagged = req.query.flagged === "yes" ? true : req.query.flagged === "no" ? false : null;
  if (flagged === true) filters.push(sql`coalesce(${athletes.signup_flags}, '{}'::jsonb) <> '{}'::jsonb`);
  if (flagged === false) filters.push(sql`coalesce(${athletes.signup_flags}, '{}'::jsonb) = '{}'::jsonb`);

  try {
    const cols = { id: athletes.id, full_name: athletes.full_name, email: athletes.email, sport: athletes.sport, school: athletes.school, socials: athletes.socials, status: athletes.status, created_at: athletes.created_at, enriched_at: athletes.enriched_at, signup_flags: athletes.signup_flags, referral_code: athletes.referral_code, deletion_requested_at: athletes.deletion_requested_at };
    let rows: Array<{ id: string; full_name: string; email: string | null; sport: string | null; school: string | null; socials: unknown; status: string; created_at: Date | null; enriched_at: Date | null; signup_flags: unknown; referral_code: string | null; deletion_requested_at: Date | null }>;
    if (q) {
      // The index's name / alias hits first (its order), then e-mail matches it did not find.
      const hits = await searchIndex(q, { status: statusParam, limit });
      const order = new Map(hits.map((h, n) => [h.athleteId, n]));
      const byIndex = hits.length ? await db.select(cols).from(athletes).where(and(inArray(athletes.id, hits.map((h) => h.athleteId)), ...filters)) : [];
      const pattern = containsPattern(q);
      const byEmail = await db.select(cols).from(athletes).where(and(ilike(athletes.email, pattern), ...filters)).orderBy(athletes.created_at).limit(limit);
      const seen = new Set(byIndex.map((r) => r.id));
      rows = [...byIndex.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)), ...byEmail.filter((r) => !seen.has(r.id))].slice(0, limit);
    } else {
      rows = await db
        .select(cols)
        .from(athletes)
        .where(and(...filters))
        .orderBy(athletes.created_at) // oldest first = front of the line
        .limit(limit);
    }

    const ids = rows.map((r) => r.id);

    // Referrals — tracked and shown only; they never change anyone's spot (owner, 24 Oct 2026). athletes.referral_code
    // is the code she ARRIVED with (?ref=); every athlete's own code is derived from her id (lib/referralCode.ts).
    //   referredBy: the athlete her arrival code decodes to (any status), else null.
    //   referrals:  how many athletes arrived with HER code. One query each for the page.
    const referrerIdOf = new Map<string, string>();
    for (const r of rows) { const by = athleteIdFromReferralCode(r.referral_code); if (by && by !== r.id) referrerIdOf.set(r.id, by); }
    const referrerName = new Map<string, string>();
    const referrerIds = [...new Set(referrerIdOf.values())];
    if (referrerIds.length) {
      for (const a of await db.select({ id: athletes.id, full_name: athletes.full_name }).from(athletes).where(inArray(athletes.id, referrerIds))) referrerName.set(a.id, a.full_name);
    }
    const referralCount = new Map<string, number>();
    if (ids.length) {
      const codeToId = new Map(ids.map((id) => [referralCodeFor(id), id]));
      const counts = await db.select({ code: athletes.referral_code, n: sql<number>`count(*)::int` }).from(athletes)
        .where(inArray(athletes.referral_code, [...codeToId.keys()])).groupBy(athletes.referral_code);
      for (const c of counts) { const id = c.code ? codeToId.get(c.code) : undefined; if (id) referralCount.set(id, Number(c.n) || 0); }
    }

    // Connected (OAuth) accounts — the strongest identity signal. Grouped per athlete.
    const connByAthlete = new Map<string, { platform: string; username: string | null; status: string | null }[]>();
    if (ids.length) {
      const conns = await db
        .select({
          athlete_id: connectedAccounts.athlete_id,
          platform:   connectedAccounts.platform,
          username:   connectedAccounts.platform_username,
          status:     connectedAccounts.status,
        })
        .from(connectedAccounts)
        .where(inArray(connectedAccounts.athlete_id, ids));
      for (const c of conns) {
        const list = connByAthlete.get(c.athlete_id) ?? [];
        list.push({ platform: c.platform, username: c.username, status: c.status });
        connByAthlete.set(c.athlete_id, list);
      }
    }

    // Score — her M.I.A. (the number My Intelligence shows), never the legacy athletes_current display_score / tier
    // (legacy retirement P2-3, owner decision 7, 8 Oct 2026). No tier word: M.I.A. has none. A few at a time — each is
    // one ledger read.
    const scoreByAthlete = new Map<string, { displayScore: number | null; tier: null; updatedAt: string | null }>();
    for (let i = 0; i < ids.length; i += 4) {
      await Promise.all(ids.slice(i, i + 4).map(async (id) => {
        try {
          const a = (await buildMyIntelligence(id)).assessment;
          if (a) scoreByAthlete.set(id, { displayScore: a.score ?? null, tier: null, updatedAt: a.evidenceAsOf ?? null });
        } catch (err: any) {
          logger.warn({ athleteId: id, error: String(err?.message ?? err).slice(0, 200) }, "admin roster: M.I.A. read failed");
        }
      }));
    }

    // Research done, for her furthest step: her sign-up research (the waitlist's signup_research, or an agent-front
    // agent_onboarding) has merged, or the legacy onboarding run finished. One query for the page.
    const researched = new Set<string>();
    if (ids.length) {
      // The merge (or, for a lean signup_research v4 run, lean_research) is the step that writes her facts.
      const merged = sql`exists (select 1 from ${workflowSteps} where ${workflowSteps.run_id} = ${workflowRuns.id} and ${workflowSteps.step} in ('research_merge', 'lean_research') and ${workflowSteps.status} = 'done')`;
      const done = await db.selectDistinct({ athlete_id: workflowRuns.athlete_id }).from(workflowRuns).where(and(
        inArray(workflowRuns.athlete_id, ids),
        or(and(inArray(workflowRuns.process, ["signup_research", "agent_onboarding"]), merged), and(eq(workflowRuns.process, "onboarding"), eq(workflowRuns.status, "done"))),
      ));
      for (const d of done) if (d.athlete_id) researched.add(d.athlete_id);
    }

    // The team is the projection column and the handles the landing-entered socials.
    const athletesOut = rows.map((r) => {
      const socials = (r.socials ?? {}) as Record<string, string>;
      const connections = connByAthlete.get(r.id) ?? [];
      const score = scoreByAthlete.get(r.id) ?? null;
      const step = furthestStep({
        sport: r.sport,
        connected: connections.some((c) => c.status === "active" && JOIN_CONNECT_PLATFORMS.has(c.platform)),
        researched: researched.has(r.id) || !!r.enriched_at,
        scored: score?.displayScore != null,
      });
      return {
        id:             r.id,
        fullName:       r.full_name,
        email:          r.email,
        sport:          r.sport,
        school:         r.school,
        status:         r.status,
        createdAt:      r.created_at,
        enrichedAt:     r.enriched_at,
        socials,                                                       // landing-entered handles
        socialCount:    Object.values(socials).filter((v) => v && String(v).trim()).length,
        connections,                                                   // OAuth-connected accounts
        verifiedConnections: connections.filter((c) => c.status === "active").length,
        score,
        step,                                                          // her furthest join step (furthestStep)
        flags:          flagNames(r.signup_flags),                     // admin flags (lib/signupFlags.ts), never a block
        referredBy:     referrerIdOf.has(r.id) && referrerName.has(referrerIdOf.get(r.id)!)
          ? { id: referrerIdOf.get(r.id)!, name: referrerName.get(referrerIdOf.get(r.id)!)! } : null,
        referrals:      referralCount.get(r.id) ?? 0,                  // athletes who joined with her link (display only)
        deleting:       r.deletion_requested_at != null,               // their account deletion has started (purge running)
      };
    });
    // ?sort=referrals: most referrals first (ties keep the list order). Display only.
    if (req.query.sort === "referrals") athletesOut.sort((a, b) => b.referrals - a.referrals);

    res.json({ status: statusParam, q: q || null, count: athletesOut.length, athletes: athletesOut });
  } catch (err: any) {
    logger.error({ error: err.message }, "Admin waitlist list failed");
    res.status(500).json({ error: "Could not load waitlist" });
  }
});

// ─── POST /api/v1/admin/waitlist/:athleteId/promote ───────────────────────────────

router.post("/waitlist/:athleteId/promote", async (req: Request, res: Response): Promise<void> => {
  const { athleteId } = req.params;
  const reresearch = req.body?.reresearch === true;

  try {
    const [athlete] = await db
      .select({
        id:         athletes.id,
        full_name:  athletes.full_name,
        first_name: athletes.first_name,
        email:      athletes.email,
        sport:      athletes.sport,
        // Phase A Step 2d-3: `school` was selected here and never read; the projection column leaves.
        status:     athletes.status,
        // The agent onboarding front's sign-ups (auth.ts agentFrontSignup ⇒ this column): researched by their own
        // agent_onboarding run at sign-up, so promotion never starts the legacy onboarding run for them.
        agent_onboarding_required: athletes.agent_onboarding_required,
      })
      .from(athletes)
      .where(eq(athletes.id, athleteId))
      .limit(1);

    if (!athlete) {
      res.status(404).json({ error: "Athlete not found" });
      return;
    }

    const wasActive = athlete.status === "active";
    if (wasActive && !reresearch) {
      res.status(200).json({ ok: true, alreadyActive: true, athleteId, status: "active" });
      return;
    }

    // Flip to active FIRST — researchAthlete only promotes 'raw'→'enriched', so it will
    // leave 'active' untouched once we've set it here.
    if (!wasActive) {
      await db.update(athletes).set({ status: "active" }).where(eq(athletes.id, athleteId));
      logger.info({ athleteId, by: req.athleteId ?? null }, "Athlete promoted waitlisted → active");
    }

    // "You're in" — audit + best-effort email. Never blocks/fails the promotion.
    let notified = { logged: false, emailed: false };
    if (!wasActive) {
      notified = await notifyPromotion(athlete).catch((err: any) => {
        logger.error({ athleteId, error: err.message }, "notifyPromotion threw");
        return { logged: false, emailed: false };
      });
    }

    // Research is no longer promotion's job — it ran at signup as the athlete's onboarding
    // run. Promotion only makes sure a run exists (accounts created before signup-time
    // research have none) and, on an explicit re-research, starts a research_refresh run.
    // Both are visible on the admin runs page instead of a progress bar on a tasks row.
    let onboarding: { runId: string; created: boolean } | null = null;
    let refresh: { runId: string | null; created: boolean; queued?: boolean; refused?: string } | null = null;
    // An agent-front sign-up (agent_onboarding_required) was researched by her agent_onboarding run at sign-up: starting
    // the legacy onboarding run here would research her a second time. Both legacy runs below are skipped for her (her
    // research is refreshed by the agent's own research_refresh sweep, server/agent/researchRefresh).
    const agentFront = athlete.agent_onboarding_required === true;
    // A waitlister researched on the agent route at sign-up (signup_research, SIGNUP_RESEARCH_AGENT): with the agent app
    // front on (AGENT_ONBOARDING), her first launch opens the agent onboarding (v4 reuses that research), so she is
    // marked for it here and legacy research is NOT started — never both routes. With the agent front OFF the legacy app
    // is what she opens, and it reads only legacy research: it starts as today (design §5 rollback).
    const agentResearch = await latestRunOf(athleteId, SIGNUP_RESEARCH_PROCESS);
    const agentAppOn = process.env.AGENT_ONBOARDING === "true";
    const toAgentFront = !!agentResearch && agentAppOn && !agentFront;
    // Her sign-up research must not run on beside what comes next: agent front on ⇒ cancel it unless it has merged
    // (v4 reuses a merged run; an unmerged or queued one would be researched again by v4, and the daily cap's release
    // would still start a held one); agent front off ⇒ the legacy app researches her, so cancel any active run.
    const retired = agentResearch ? await retireSignupResearch(athleteId, { keepMerged: agentAppOn }) : { canceled: null };
    if (toAgentFront) {
      await db.update(athletes).set({ agent_onboarding_required: true }).where(eq(athletes.id, athleteId));
      logger.info({ athleteId, signupResearchRunId: agentResearch!.id }, "Promoted an agent-researched waitlister: agent onboarding at first launch, no legacy research");
    }
    if (athlete.sport && !agentFront && !toAgentFront) {
      // An operator act, not a sign-up: through the sign-up research chokepoint, uncapped (agent/onboarding/signupResearch.ts).
      const o = await startSignupResearchRun({ process: "onboarding", athleteId, createdBy: "admin", idempotencyKey: `onboarding:${athleteId}`, version: onboardingStartVersion() }, { capped: false, legacyAfterAgentResearch: !!agentResearch });
      onboarding = { runId: o.run.id, created: o.created };
      if (reresearch && !o.created) {
        const { researchPlannerExecutionEnabled } = await import("../services/intelligence/research/config.js");
        if (researchPlannerExecutionEnabled()) {
          // Phase A Step 2b: with planner EXECUTION enabled (both flags) an operator re-research is a queued
          // manual request the nightly planner admits under budget — never an immediate full run.
          const { requestRefresh } = await import("../services/intelligence/research/triggers.js");
          await requestRefresh(athleteId, ["identity", "affiliations", "achievements", "press", "brand_mentions", "social_handles"], "manual", "admin re-research");
          refresh = { runId: null, created: true, queued: true };
        } else {
          // Gate false: today's path, pinned to research_refresh v1 (the legacy full procedure).
          try {
            const r = await startRun({ process: "research_refresh", athleteId, createdBy: "admin", version: 1 });
            refresh = { runId: r.run.id, created: r.created };
          } catch (err: any) {
            // The daily research cap's hard stop (the runner refuses): the promotion stands, the re-research does not start.
            if (err?.code !== "daily_research_cap") throw err;
            refresh = { runId: null, created: false, refused: "daily_research_cap" };
          }
        }
      }
    }

    res.status(200).json({
      ok:        true,
      athleteId,
      status:    "active",
      reresearch: wasActive && reresearch,
      onboarding,
      signupResearch: agentResearch ? { runId: agentResearch.id, status: retired.canceled ? "canceled" : agentResearch.status, agentFront: agentFront || toAgentFront } : null,
      refresh,
      notified,
    });
  } catch (err: any) {
    logger.error({ athleteId, error: err.message }, "Promote failed");
    if (!res.headersSent) res.status(500).json({ error: "Promotion failed" });
  }
});

// ─── Phase A Step 3b: the operator's claim queue ─────────────────────────────
router.get("/identity/claims", async (req: Request, res: Response): Promise<void> => {
  const status = typeof req.query.status === "string" ? req.query.status : "proposed";
  if (!["proposed", "confirmed", "rejected", "expired", "superseded", "all"].includes(status)) { res.status(400).json({ error: "unknown status" }); return; }
  try {
    const { listClaims } = await import("../services/intelligence/identity/claims");
    res.json({ claims: await listClaims(status as any) });
  } catch (err: any) { res.status(500).json({ error: err.message?.slice(0, 200) ?? "Internal server error" }); }
});

router.post("/identity/claims/:id/decide", async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as { decision?: unknown; note?: unknown };
  if (body.decision !== "confirm" && body.decision !== "reject") { res.status(400).json({ error: "decision must be confirm or reject" }); return; }
  try {
    const { decideClaim } = await import("../services/intelligence/identity/claims");
    const r = await decideClaim({ claimId: req.params.id, decision: body.decision, note: typeof body.note === "string" ? body.note.slice(0, 500) : null, operator: req.athleteId ?? req.userId ?? "admin" });
    if (r.outcome === "not_found") { res.status(404).json({ error: "Not found" }); return; }
    if (r.outcome === "not_proposed") { res.status(409).json({ error: "claim_not_proposed", status: r.status }); return; }
    if (r.outcome === "taken") { res.status(409).json({ error: "self_member_exists" }); return; }
    if (r.outcome === "manual_merge_required") { res.status(409).json({ error: "manual_merge_required", athleteId: r.athleteId, heldBy: r.heldBy, message: r.message }); return; }
    if (r.outcome === "linked") void enterLifecycleResearch(r.athleteId, "claim");   // PR E2b: operator-approved claim-link
    res.json(r);
  } catch (err: any) { res.status(500).json({ error: err.message?.slice(0, 200) ?? "Internal server error" }); }
});

export default router;

/**
 * POST /api/v1/admin/mia/:athleteId/refresh — the manual refresh trigger.
 *
 * SHADOW-ONLY AND ADMIN-GATED ON PURPOSE. Beta.1 switches no reader and no UI to M.I.A., so there is no athlete-facing
 * refresh button to wire; putting the trigger here keeps it operable without implying a product surface that does not
 * exist yet. When a reader is switched, this is the behaviour an athlete-facing control adopts, not a thing to rebuild.
 *
 * MANUAL REFRESH IS THE DELIBERATE EXCEPTION TO IDEMPOTENCY. An automatic trigger whose evidence is unchanged skips,
 * because re-asking a non-deterministic evaluator the same question samples drift (a measured mean of 20.5 MIA points)
 * rather than learning anything. A person asking anyway is making a different request: same supplied evidence, fresh
 * grounded research. So `force` bypasses the digest COMPARISON while the digest is still computed and stored the
 * ordinary way — which is what later makes "identical evidence, different answer" legible as exactly that.
 *
 * It also takes its own active scope, so a manual refresh can never be silently absorbed by a debounced run that is
 * about to decide nothing changed and skip.
 */
router.post("/mia/:athleteId/refresh", async (req: Request, res: Response): Promise<void> => {
  const { athleteId } = req.params;
  // Lightweight and optional: free text, recorded on the snapshot as triggerDetail and NEVER sent to the evaluator.
  // An orchestration fact is not evidence — an athlete refreshed "because the score looks wrong" must not score
  // differently from an identical athlete nobody complained about.
  const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : null;

  try {
    const [athlete] = await db.select({ id: athletes.id, sport: athletes.sport }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
    if (!athlete) { res.status(404).json({ error: "athlete not found" }); return; }
    if (!athlete.sport) { res.status(422).json({ error: "athlete has no resolvable sport; the evaluator requires one and will not guess" }); return; }

    const { miaIdentityPreflight, requestEvaluation } = await import("../services/marketabilityBeta1Orchestrator.js");
    // PR H2: the identity gate asked BEFORE enqueueing (flag on only). An athlete whose public identity is not resolved
    // gets a 409 that says so, instead of a 202 and a run the gate would silently refuse. Nothing is enqueued; the
    // evaluation is requested automatically once identity resolves (R-a). Flag off ⇒ never held, today's 202.
    const pre = await miaIdentityPreflight(athleteId);
    if (pre.held) {
      res.status(409).json({ error: "held for identity: the athlete's public identity is not resolved, so M.I.A. will not evaluate yet", held: pre.held, identity: pre.identity, athleteId });
      return;
    }
    const { runId, created } = await requestEvaluation({
      athleteId, trigger: "USER_REQUESTED_REFRESH", force: true, reason, createdBy: "admin_manual_refresh",
    });
    // created:false means a manual refresh was already in flight for this athlete and this one joined it — the
    // coalescing working, not a failure. The caller gets the same run id either way.
    res.status(202).json({ runId, created, athleteId });
  } catch (err: any) {
    logger.error({ athleteId, error: err.message }, "manual MIA refresh failed");
    res.status(500).json({ error: "could not request an evaluation" });
  }
});
