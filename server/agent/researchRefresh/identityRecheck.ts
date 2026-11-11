/**
 * agent/researchRefresh/identityRecheck.ts — research on hold while Nomila cannot tell who the athlete is, and a fresh
 * identity check the moment she gives us something new to tell by (owner, 3 Nov 2026).
 *
 * "Identity open" is the agent's own signal: an OPEN "#identity" verdict in her memory (research.ts isOpenIdentityFact:
 * a made fact, active or disputed, whose source ref ends "#identity" — the agent's replacement for
 * athlete_research_state). While it stands:
 *   - the ROUTINE refresh skips her, reason "identity_open": the daily sweep (sweep.ts refreshCandidates leaves her out),
 *     a scheduled start (sweep.ts requestResearchRefresh; an operator's or script's deliberate run still starts), and
 *     Mila's refresh_research for any topic but identity (leanRefresh.ts requestLeanRefresh). Researching everything again on an unconfirmed identity spends money
 *     on the same "couldn't confirm" — or on a namesake.
 *   - an IDENTITY-topic refresh still runs, and requestIdentityRecheck starts one when new evidence arrives: she adds or
 *     changes her school / team (the waitlist POST, the record editor and Mila's onboarding through recordAssertions),
 *     adds or changes a social handle (the waitlist POST, the handle confirm on the waitlist and in the app), or
 *     connects a social account (the OAuth callback). That run is the lean refresh (process lean_research_refresh,
 *     topics ["identity"]): her name, sport, team and handles anchor the identity queries; confirmed ⇒ the open verdict
 *     is superseded (her M.I.A. is no longer held); still unsure ⇒ its verdict replaces the old one.
 *
 * Guards, all checked before anything is started or spent (requestIdentityRecheck never throws):
 *   off              LEAN_SIGNUP_RESEARCH is not on (the identity-topic refresh is the lean pipeline's)
 *   deleting         the account-deletion fence is set (lib/privacy/deletionFence.ts; startRun refuses as well)
 *   no_open_dispute  nothing to re-check: a no-op for every athlete whose identity is settled
 *   research_running her sign-up research or agent onboarding is still running (it records its own identity verdict)
 *   recent           an identity re-check started in the last 24 hours (workflow_runs: the latest lean refresh run with
 *                    created_by "identity_recheck", ANY outcome — the same rows the idempotency key collides with, so
 *                    the read and the key never disagree). A FAILED re-check counts too: the runner already retried its
 *                    step under the same per-run cap, so a failure is rarely transient, and a fresh run would spend
 *                    again; the next one starts on new evidence after 24 hours. ACROSS INSTANCES: the idempotency key
 *                    names her and the 24-hour window, unique per process (workflow_runs_idempotency), and the runner's
 *                    one-active-run-per-athlete index (workflow_runs_one_active) refuses a second lean refresh while one
 *                    is running — two instances racing past the read both insert, and only one row is created
 *   daily_budget     the daily research cap (DAILY_RESEARCH_CAP_USD: the runner's hard stop, dailyCap.ts
 *                    researchCapRefusal — spent, sign-ups queued, or the budget unreadable: fails closed) or the
 *                    research refresh day cap (AGENT_RESEARCH_REFRESH_DAY_CAP_USD), both through requestLeanRefresh;
 *                    the run's own per-run cap
 *                    (AGENT_RESEARCH_REFRESH_RUN_CAP_USD, lowered to the day's room) refuses every model call past it
 *   already_running  a lean refresh is running for her (its own identity queries run first)
 * A handle typed on the waitlist is written as her word (a said fact, the sign-up's wording) for a held athlete (past
 * the fence and the open-dispute guard, BEFORE the 24-hour and budget guards: her word costs nothing and the next
 * re-check must read it). Her newer word for a platform supersedes her older one (confirmHandle's rule; history
 * kept). A said handle is never an anchor or connected data: research anchors on connected accounts only, and the
 * scorer ranks connected > platform API > web/said (publicPlatform.ts).
 * Known limit: an identity re-check counts as the lean refresh refresh_research's own once-a-day gap reads.
 * The start is the existing workflow runner's (startRun via requestLeanRefresh, the same path refresh_research uses;
 * kicked in the background, the minute tick runs it otherwise). No new runner, no new table, no new column.
 */
import { and, desc, eq, gt, sql, type SQL } from "drizzle-orm";
import { db } from "../../db";
import { workflowRuns } from "../../../shared/schemaWorkflow";
import { createLogger } from "../../logger";
import { IDENTITY_REF_SUFFIX } from "../research/research";

const logger = createLogger("agent/identity-recheck");

/** The lean refresh's process (leanRefresh.ts LEAN_REFRESH_PROCESS; not imported: that module imports this one). */
const LEAN_REFRESH_PROCESS = "lean_research_refresh";
const SIGNUP_RESEARCH_PROCESS = "signup_research";
const AGENT_ONBOARDING_PROCESS = "agent_onboarding";
/** created_by of an identity re-check run: the 24-hour window reads it. */
export const IDENTITY_RECHECK_CREATED_BY = "identity_recheck";
export const IDENTITY_RECHECK_WINDOW_MS = 24 * 3_600_000;

/**
 * SQL: the athlete (`athleteIdCol`) holds an OPEN identity verdict — research.ts isOpenIdentityFact as a query, for the
 * sweep's candidate read.
 */
export const openIdentitySql = (athleteIdCol: SQL | unknown): SQL => sql`EXISTS (SELECT 1 FROM memory_facts f
  WHERE f.athlete_id = ${athleteIdCol} AND f.type = 'made' AND f.status IN ('active', 'disputed')
    AND right(coalesce(f.source_ref, ''), ${IDENTITY_REF_SUFFIX.length}) = ${IDENTITY_REF_SUFFIX})`;

/** Whether research is holding this athlete on an unconfirmed identity (an open "#identity" verdict). */
export async function hasOpenIdentityDispute(athleteId: string): Promise<boolean> {
  const r = await db.execute(sql`SELECT ${openIdentitySql(sql`${athleteId}::uuid`)} AS open`);
  const row = (((r as any)?.rows ?? r) as Array<{ open: boolean }>)[0];
  return !!row?.open;
}

/** What she gave us: a school / team, a social handle, or a connected social account. */
export type IdentityEvidence = "school" | "handle" | "account";

export type IdentityRecheck =
  | { started: true; runId: string }
  | { started: false; reason: "off" | "deleting" | "no_open_dispute" | "research_running" | "no_anchor" | "error" }
  | { started: false; reason: "already_running"; runId: string }
  | { started: false; reason: "recent" | "daily_budget"; nextAllowedAt: string };

export interface IdentityRecheckDeps {
  now?: Date;
  /** Tests: the background kick (default: the runner's kick, never awaited). */
  kick?: (runId: string) => void;
}

const normText = (s: unknown) => (typeof s === "string" ? s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim() : "");
const normHandle = (s: unknown) => normText(s).replace(/^@/, "");

/**
 * Pure: what new identity evidence a profile write carries — a school / team she did not have (or a different one), else
 * a handle on a platform that had none (or a different one); null when nothing changed (case, accents, spacing and a
 * leading "@" ignored). `after` holds only what the write sent (an omitted field never counts).
 */
export function newIdentityEvidence(
  before: { school?: string | null; socials?: unknown } | null,
  after: { school?: string | null; socials?: Record<string, string> | null },
): IdentityEvidence | null {
  const school = normText(after.school);
  if (school && school !== normText(before?.school)) return "school";
  const had = (before?.socials && typeof before.socials === "object" ? before.socials : {}) as Record<string, unknown>;
  for (const [platform, handle] of Object.entries(after.socials ?? {})) {
    const h = normHandle(handle);
    if (h && h !== normHandle(had[platform])) return "handle";
  }
  return null;
}

/** The 24-hour window an idempotency key names: two instances in the same window collapse onto one run. */
export const recheckKey = (athleteId: string, now: Date) => `${IDENTITY_RECHECK_CREATED_BY}:${athleteId}:${Math.floor(now.getTime() / IDENTITY_RECHECK_WINDOW_MS)}`;

const HANDLE_LABELS: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", twitter: "X" };

/**
 * Her typed handles (the waitlist's socials) as what she told us — said facts in the sign-up's own wording
 * (signupResearch.ts), skipped when the same words are on file — so the re-check reads them: research takes handles as
 * anchors only from connected accounts, and reads her said facts.
 */
async function recordTypedHandles(athleteId: string, socials: Record<string, string>): Promise<number> {
  const { athletes } = await import("../../../shared/schema");
  const { dbStore } = await import("../research/dbStore");
  const [row] = await db.select({ name: athletes.full_name }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  const name = row?.name?.replace(/\s+/g, " ").trim();
  if (!name) return 0;
  const said = (await dbStore.listFacts(athleteId, ["active"])).filter((f) => f.type === "said");
  const known = new Set(said.map((f) => f.claim.trim().toLowerCase()));
  const today = new Date().toISOString().slice(0, 10);
  let written = 0;
  for (const [k, v] of Object.entries(socials)) {
    const handle = typeof v === "string" ? v.trim().replace(/^@+/, "").slice(0, 64) : "";
    if (!HANDLE_LABELS[k] || !handle) continue;
    const claim = `${name}'s ${HANDLE_LABELS[k]} handle is @${handle}.`;
    if (known.has(claim.toLowerCase())) continue;
    const [fresh] = await dbStore.insertFacts(athleteId, [{ subject: { kind: "athlete", name }, claim, type: "said", source: { ref: `waitlist#handle:${k}`, title: "You told us" }, date: today, confidence: 1, runId: null }]);
    written++;
    // Her newer word for this platform replaces her older one (history kept: superseded, not deleted).
    const samePlatform = new RegExp(`\\b${HANDLE_LABELS[k]}\\b handle is @`, "i");
    if (fresh) for (const old of said) if (samePlatform.test(old.claim)) await dbStore.setFactStatus(athleteId, old.id, "superseded", { supersededBy: fresh.id });
  }
  return written;
}

/** Start an identity-topic refresh for an athlete whose identity is open, under the guards above. Never throws. */
export async function requestIdentityRecheck(athleteId: string, evidence: IdentityEvidence, deps: IdentityRecheckDeps = {}, opts: { typedHandles?: Record<string, string> } = {}): Promise<IdentityRecheck> {
  const now = deps.now ?? new Date();
  try {
    const { leanSignupResearchEnabled } = await import("../research/v2/lean");
    if (!leanSignupResearchEnabled()) return { started: false, reason: "off" };
    const { isAthleteDeleting } = await import("../../lib/privacy/deletionFence");
    if (await isAthleteDeleting(athleteId)) return { started: false, reason: "deleting" };
    if (!(await hasOpenIdentityDispute(athleteId))) return { started: false, reason: "no_open_dispute" };
    // Her typed handles are her word whatever the guards below decide: free to record, and the next re-check reads them.
    if (opts.typedHandles) await recordTypedHandles(athleteId, opts.typedHandles);
    const { activeRunFor } = await import("../../workflow/runner");
    if (await activeRunFor(athleteId, SIGNUP_RESEARCH_PROCESS) || await activeRunFor(athleteId, AGENT_ONBOARDING_PROCESS)) return { started: false, reason: "research_running" };

    const [last] = await db.select({ startedAt: workflowRuns.started_at }).from(workflowRuns)
      .where(and(eq(workflowRuns.athlete_id, athleteId), eq(workflowRuns.process, LEAN_REFRESH_PROCESS), eq(workflowRuns.created_by, IDENTITY_RECHECK_CREATED_BY),
        gt(workflowRuns.started_at, new Date(now.getTime() - IDENTITY_RECHECK_WINDOW_MS))))
      .orderBy(desc(workflowRuns.started_at)).limit(1);
    if (last) return { started: false, reason: "recent", nextAllowedAt: new Date(last.startedAt.getTime() + IDENTITY_RECHECK_WINDOW_MS).toISOString() };

    // The budgets (the daily research cap's hard stop and the refresh day cap) are requestLeanRefresh's: one check.
    const { requestLeanRefresh } = await import("./leanRefresh");
    const r = await requestLeanRefresh(athleteId, ["identity"], { now, ...(deps.kick ? { kick: deps.kick } : {}) }, {
      identityRecheck: { idempotencyKey: recheckKey(athleteId, now), evidence },
    });
    if (r.started) {
      logger.info({ athleteId, evidence, runId: r.runId }, "identity re-check started");
      return { started: true, runId: r.runId };
    }
    if (r.reason === "already_running") return r;
    if (r.reason === "rate_limited") return { started: false, reason: "recent", nextAllowedAt: r.nextAllowedAt };
    if (r.reason === "daily_budget") return { started: false, reason: "daily_budget", nextAllowedAt: r.nextAllowedAt };
    if (r.reason === "identity_open") return { started: false, reason: "error" };   // never for the identity topic
    return { started: false, reason: r.reason };
  } catch (err: any) {
    logger.warn({ athleteId, evidence, error: String(err?.message ?? err).slice(0, 200) }, "identity re-check not started");
    return { started: false, reason: "error" };
  }
}

/** For a request handler: start the re-check without waiting for it. Never throws, never blocks the response. */
export function recheckIdentityInBackground(athleteId: string, evidence: IdentityEvidence, detail = "", opts: { typedHandles?: Record<string, string> } = {}): void {
  void requestIdentityRecheck(athleteId, evidence, {}, opts)
    .then((r) => { if (!r.started && r.reason !== "no_open_dispute" && r.reason !== "off") logger.info({ athleteId, evidence, detail, reason: r.reason }, "identity re-check not started"); })
    .catch(() => undefined);
}
