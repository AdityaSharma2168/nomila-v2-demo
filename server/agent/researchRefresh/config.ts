/**
 * agent/researchRefresh/config.ts — the agent research refresh's flag and limits, in one place. Getters, so env is read
 * at call time.
 *
 * AGENT_RESEARCH_REFRESH — off unless exactly "true". Off: the cron answers { enabled: false } and starts nothing, and
 * the one-athlete admin path refuses. AGENT_RESEARCH_REFRESH_COHORT (below) separately gates the cron's sweep. Neither is
 * set in either Cloud Run yaml (default off): turning them on is an owner step.
 *
 * What one refresh costs: the same research the onboarding runs (two web-search passes + a merge) plus a new Brief and
 * an M.I.A. preview read (its evaluator call is skipped when her memory did not change). Bounds:
 *   - per refresh:  AGENT_RESEARCH_REFRESH_RUN_CAP_USD (default 1.50) — every model call is refused once one refresh's
 *                   spend reaches it (the same budget mechanism as the onboarding's cap);
 *   - per day:      AGENT_RESEARCH_REFRESH_DAY_CAP_USD (default 10) summed over EVERY refresh run started today (UTC),
 *                   all athletes — the sweep enqueues nothing once today's spend plus one refresh's cap would pass it,
 *                   and a step refuses its model call once it is reached;
 *   - per sweep:    AGENT_RESEARCH_REFRESH_PER_RUN (default 5) athletes at most;
 *   - per athlete:  the harness's AGENT_DAY_COST_CAP_USD still applies to everything she runs today.
 * Who is due: no agent research in AGENT_RESEARCH_REFRESH_STALE_DAYS (default 30) days — including an athlete who never
 * had any (she never onboarded through the agent) — or her identity anchor (name, sport, team) changed since her last
 * refresh.
 */
import { readCap } from "../../lib/spendCap";

/* Hard maxima (lib/spendCap.ts): RUN_CAP 10 USD, DAY_CAP 100 USD. */

function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function agentResearchRefreshEnabled(): boolean {
  return process.env.AGENT_RESEARCH_REFRESH === "true";
}

/**
 * AGENT_RESEARCH_REFRESH_COHORT — the daily sweep over everyone. Off unless exactly "true" (and AGENT_RESEARCH_REFRESH
 * on). Owner, 12 Oct 2026: the single-athlete run comes first (Mia); the cohort waits until her result is checked.
 */
export function agentResearchRefreshCohortEnabled(): boolean {
  return process.env.AGENT_RESEARCH_REFRESH_COHORT === "true";
}

export const RESEARCH_REFRESH_PROCESS = "agent_research_refresh";
/** Every model run of one refresh is keyed under "<this>:<workflow run id>:<step>" — the day cap sums this prefix. */
export const RESEARCH_REFRESH_PARENT = "research_refresh";

export const RESEARCH_REFRESH = {
  get STALE_DAYS(): number { return Math.floor(positive("AGENT_RESEARCH_REFRESH_STALE_DAYS", 30)); },
  get PER_RUN(): number { return Math.floor(positive("AGENT_RESEARCH_REFRESH_PER_RUN", 5)); },
  get RUN_CAP_MICRO_USD(): number { return Math.round(readCap("AGENT_RESEARCH_REFRESH_RUN_CAP_USD", 1.5, 10) * 1_000_000); },
  get DAY_CAP_MICRO_USD(): number { return Math.round(readCap("AGENT_RESEARCH_REFRESH_DAY_CAP_USD", 10, 100) * 1_000_000); },
} as const;
