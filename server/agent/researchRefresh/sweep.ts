/**
 * agent/researchRefresh/sweep.ts — who gets a research refresh, and the one way to start one.
 *
 *   requestResearchRefresh  start ONE refresh for one athlete (an operator's "run it now", or the sweep). Refuses with a
 *                           reason, never throws, when: AGENT_RESEARCH_REFRESH is off · the athlete has no name or
 *                           sport · her identity is open and the trigger is not "manual" (an open "#identity" verdict
 *                           ⇒ "identity_open"; the identity check runs on new evidence instead, identityRecheck.ts; an
 *                           operator's or script's run still starts) · an agent onboarding or a refresh is already
 *                           running for her · today's refresh spend leaves no room for one more refresh's cap · the
 *                           daily research cap is spent or unreadable ("research_cap": the runner's hard stop,
 *                           dailyCap.ts researchCapRefusal). One active refresh per athlete is the runner's rule.
 *   sweepResearchRefresh    the daily cron. Starts NOTHING unless AGENT_RESEARCH_REFRESH_COHORT is also "true" (owner,
 *                           12 Oct 2026: Mia first, by hand; the cohort only after her result is checked). Candidates:
 *                           real users (auth_id set), not waitlisted, with a name and a sport, no open identity verdict
 *                           (identity_open: they wait for new evidence, identityRecheck.ts), oldest agent research first.
 *                           Due when stale (no completed agent research merge in STALE_DAYS; none at all counts) or her
 *                           anchor (name, sport, team) changed since her last refresh. At most PER_RUN starts per sweep,
 *                           never past the day cap. Only ENQUEUES (kick: false); the idempotency key
 *                           "research_refresh:<trigger>:<athlete>:<day>" makes a re-sent cron the same day start nothing.
 */
import { and, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db";
import { athletes } from "../../../shared/schema";
import { createLogger } from "../../logger";
import { activeRunFor, startRun } from "../../workflow/runner";
import { agentResearchRefreshCohortEnabled, agentResearchRefreshEnabled, RESEARCH_REFRESH, RESEARCH_REFRESH_PROCESS } from "./config";
import { anchorChanged, currentAnchor, lastRefreshAnchor, todaySpendMicroUsd } from "./state";
import { hasOpenIdentityDispute, openIdentitySql } from "./identityRecheck";
import type { ResearchRefreshInput } from "./workflow";
import { enabledChoiceSql, jobGate } from "../welcome/gate";

const logger = createLogger("agent/research-refresh");
const DAY = 86_400_000;
const AGENT_ONBOARDING_PROCESS = "agent_onboarding";
// A research run ends in a merge: the full one, or the compact one (RESEARCH_MERGE_COMPACT; same judgement, same facts).
const MERGE_SKILL_IDS = ["research/merge", "research/merge-compact"];

export type RefreshTrigger = ResearchRefreshInput["trigger"];
export type RefreshStart =
  | { started: true; runId: string; created: boolean }
  | { started: false; reason: "off" | "no_athlete" | "no_name_or_sport" | "identity_open" | "onboarding_running" | "refresh_running" | "day_cap" | "research_cap" };

export type RefreshStarter = (opts: { process: string; athleteId: string; input: ResearchRefreshInput; createdBy: string; idempotencyKey?: string; kick?: boolean }) => Promise<{ runId: string; created: boolean }>;
const defaultStart: RefreshStarter = async (o) => { const { run, created } = await startRun(o); return { runId: run.id, created }; };

export async function requestResearchRefresh(athleteId: string, req: {
  trigger: RefreshTrigger; reason: string; now?: Date; kick?: boolean; createdBy?: string; idempotencyKey?: string; daySpentMicroUsd?: number;
}, deps: { start?: RefreshStarter } = {}): Promise<RefreshStart> {
  if (!agentResearchRefreshEnabled()) return { started: false, reason: "off" };
  const now = req.now ?? new Date();
  const anchor = await currentAnchor(athleteId);
  if (!anchor) return { started: false, reason: "no_athlete" };
  if (!anchor.name.trim() || !anchor.sport.trim()) return { started: false, reason: "no_name_or_sport" };
  // Her identity is open: the ROUTINE refresh waits for new evidence (identityRecheck.ts). An operator's or script's
  // deliberate run (trigger "manual") still starts: in prod (LEAN_SIGNUP_RESEARCH off) it is the only way to look again.
  if (req.trigger !== "manual" && await hasOpenIdentityDispute(athleteId)) return { started: false, reason: "identity_open" };
  if (await activeRunFor(athleteId, AGENT_ONBOARDING_PROCESS)) return { started: false, reason: "onboarding_running" };
  if (await activeRunFor(athleteId, RESEARCH_REFRESH_PROCESS)) return { started: false, reason: "refresh_running" };
  const spent = req.daySpentMicroUsd ?? (await todaySpendMicroUsd(now));
  if (spent + RESEARCH_REFRESH.RUN_CAP_MICRO_USD > RESEARCH_REFRESH.DAY_CAP_MICRO_USD) return { started: false, reason: "day_cap" };
  const input: ResearchRefreshInput = { name: anchor.name.trim(), sport: anchor.sport.trim(), trigger: req.trigger, reason: req.reason.slice(0, 120) };
  let r: { runId: string; created: boolean };
  try {
    r = await (deps.start ?? defaultStart)({
      process: RESEARCH_REFRESH_PROCESS, athleteId, input, createdBy: req.createdBy ?? (req.trigger === "manual" ? "admin" : "schedule"),
      ...(req.idempotencyKey ? { idempotencyKey: req.idempotencyKey } : {}), ...(req.kick === false ? { kick: false } : {}),
    });
  } catch (err: any) {
    // The daily research cap's hard stop (the runner refuses; dailyCap.ts researchCapRefusal).
    if (err?.code === "daily_research_cap") return { started: false, reason: "research_cap" };
    throw err;
  }
  logger.info({ athleteId, trigger: req.trigger, reason: input.reason, runId: r.runId, created: r.created }, "agent research refresh requested");
  return { started: true, ...r };
}

/**
 * The candidates, oldest agent research first (never first). Bounded so one sweep reads at most `scan` rows.
 * `staleBefore` (MILA_WELCOME on): an athlete whose research is older than it (or missing) is a candidate only if they
 * said yes to the monthly refresh (profile_refresh), so athletes who never chose it do not take the scan's slots;
 * athletes with recent research stay candidates for the anchor refresh (name, sport or team changed: data upkeep).
 */
export async function refreshCandidates(scan = 500, opts: { staleBefore?: Date } = {}): Promise<Array<{ athleteId: string; lastResearch: string | null; agentOnboarding: boolean }>> {
  const lastResearch = sql<string | null>`(SELECT max(r.started_at)::text FROM agent_runs r WHERE r.athlete_id = athletes.id AND r.skill_id IN (${sql.join(MERGE_SKILL_IDS.map((id) => sql`${id}`), sql`, `)}) AND r.status = 'completed')`;
  const chose = opts.staleBefore ? enabledChoiceSql(athletes.id, "profile_refresh") : undefined;
  const rows = await db.select({
    athleteId: athletes.id,
    agentOnboarding: athletes.agent_onboarding_required,
    lastResearch,
  }).from(athletes)
    .where(and(isNotNull(athletes.auth_id), inArray(athletes.status, ["raw", "enriched", "claimed", "active"]),
      sql`coalesce(trim(${athletes.sport}), '') <> ''`, sql`coalesce(trim(${athletes.full_name}), '') <> ''`,
      // Her identity is open: the routine refresh waits; the identity re-check runs on new evidence (identityRecheck.ts).
      sql`NOT ${openIdentitySql(athletes.id)}`,
      chose && opts.staleBefore ? sql`(${chose} OR (SELECT max(r.started_at) FROM agent_runs r WHERE r.athlete_id = athletes.id AND r.skill_id IN (${sql.join(MERGE_SKILL_IDS.map((id) => sql`${id}`), sql`, `)}) AND r.status = 'completed') >= ${opts.staleBefore.toISOString()}::timestamptz)` : undefined))
    .orderBy(sql`3 ASC NULLS FIRST`).limit(Math.max(1, scan));
  return rows.map((r) => ({ athleteId: r.athleteId, lastResearch: r.lastResearch, agentOnboarding: r.agentOnboarding }));
}

export interface SweepResult { enabled: boolean; cohort: boolean; checked: number; started: number; stale: number; anchor: number; skipped: Record<string, number> }

export async function sweepResearchRefresh(opts: { now?: Date; limit?: number; scan?: number; start?: RefreshStarter } = {}): Promise<SweepResult> {
  const out: SweepResult = { enabled: agentResearchRefreshEnabled(), cohort: agentResearchRefreshCohortEnabled(), checked: 0, started: 0, stale: 0, anchor: 0, skipped: {} };
  if (!out.enabled || !out.cohort) return out;
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const limit = Math.max(1, Math.min(opts.limit ?? RESEARCH_REFRESH.PER_RUN, 100));
  const staleBefore = now.getTime() - RESEARCH_REFRESH.STALE_DAYS * DAY;
  let spent = await todaySpendMicroUsd(now);
  const skip = (why: string) => { out.skipped[why] = (out.skipped[why] ?? 0) + 1; };

  const chose = jobGate("profile_refresh");
  for (const c of await refreshCandidates(opts.scan, { staleBefore: new Date(staleBefore) })) {
    if (out.started >= limit) break;
    out.checked++;
    // Marked for the agent onboarding and never researched: the onboarding's own research comes first.
    if (c.agentOnboarding && !c.lastResearch) { skip("awaiting_onboarding"); continue; }
    let trigger: RefreshTrigger | null = null;
    let reason = "";
    if (!c.lastResearch || Date.parse(c.lastResearch) < staleBefore) {
      // MILA_WELCOME: the monthly refresh is optional — only athletes who said yes (transparent while the flag is off).
      if (!(await chose(c.athleteId))) { skip("not_chosen"); continue; }
      trigger = "schedule";
      reason = c.lastResearch ? `no agent research since ${c.lastResearch.slice(0, 10)}` : "no agent research yet";
    } else {
      const before = await lastRefreshAnchor(c.athleteId);
      const nowAnchor = before ? await currentAnchor(c.athleteId) : null;
      if (before && nowAnchor && anchorChanged(before, nowAnchor)) { trigger = "anchor"; reason = "name, sport or team changed"; }
    }
    if (!trigger) continue;
    const s = await requestResearchRefresh(c.athleteId, {
      trigger, reason, now, kick: false, createdBy: "schedule", daySpentMicroUsd: spent,
      idempotencyKey: `research_refresh:${trigger}:${c.athleteId}:${today}`,
    }, { start: opts.start });
    if (!s.started) { skip(s.reason); if (s.reason === "day_cap" || s.reason === "research_cap") break; continue; }
    if (!s.created) { skip("already_today"); continue; }
    out.started++;
    if (trigger === "schedule") out.stale++; else out.anchor++;
    // Reserve this refresh's whole cap against the day, so one sweep never enqueues past it.
    spent += RESEARCH_REFRESH.RUN_CAP_MICRO_USD;
  }
  logger.info({ ...out, today }, "agent research refresh sweep");
  return out;
}
