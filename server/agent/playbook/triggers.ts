/**
 * agent/playbook/triggers.ts — the daily sweep: for every (sport, stage, platform) key currently in the roster
 * (keys.ts), refresh it when it has no active row yet or its active row is STALE (isStale, below) — unless it just
 * FAILED and is still inside its backoff window (recentlyFailed, below). Capped at PLAYBOOK.MAX_KEYS_PER_RUN keys
 * AND PLAYBOOK.RUN_BUDGET_MS of wall-clock time a call, oldest-first, so one cron call stays inside its attempt
 * deadline even on a roster with many distinct keys; a key not reached this call is picked up by the next one.
 *
 * Review fix (PR #929, two rounds):
 *   round 1 — the cron used to run once a month, on the 1st, with a flat 30-day staleness threshold. A key
 *     activated slightly after that run's own timestamp reads as LESS than 30 days old at the next monthly check
 *     whenever the month in between has 30 days or fewer — so it was skipped, and skipped again the month after,
 *     drifting later forever. Fixed by running the check daily (provision-schedulers.sh) against a UTC
 *     calendar-month rollover test.
 *   round 2 — that fix ALSO kept a flat day-count threshold (28 days) alongside the month test, "OR"-ed together.
 *     That stacking is the actual bug this round removes: the day-count threshold fires partway through most
 *     months (28 days after any activation that isn't on the 1st), so a key would refresh TWICE in most calendar
 *     months — once on the day-count, once on the month rollover. The UTC calendar-month test alone is both
 *     necessary and sufficient for "at least once a month, every month": isStale now checks ONLY that. A test
 *     walks every day from Oct 1 to Nov 1 and pins exactly one stale day (Nov 1).
 *
 * One sweep at a time cluster-wide: wrapped in a Postgres advisory lock (pgAdvisoryLock.ts), the same primitive every
 * other periodic job in this app already uses. A sweep that cannot take the lock returns its zero result at once —
 * never queues, never waits — exactly like those other jobs.
 *
 * Off unless AGENT_PLAYBOOK is "true". Never throws: a sweep is fire-and-forget for its caller (the cron route).
 */
import { createLogger } from "../../logger";
import { LOCK_PLAYBOOK_REFRESH, withAdvisoryLock } from "../../lib/pgAdvisoryLock";
import type { ContentPlaybookRow } from "../../../shared/schema";
import { agentPlaybookEnabled, PLAYBOOK } from "./config";
import { FAILURE_VERSION_PREFIX, getActivePlaybook, getLatestPlaybookRow } from "./store";
import { rosterPlaybookKeys, type RosterPlaybookKey } from "./keys";
import { refreshPlaybookKey, type PlaybookRefreshOutcome } from "./refresh";

const logger = createLogger("agent/playbook/triggers");
const DAY = 86_400_000;

/**
 * An active row is stale ONLY when it was activated in a UTC calendar month strictly before `now`'s (or there is no
 * active row at all). No day-count threshold — see the module header for why one was tried and removed. Exported
 * and pure so the exact boundary is pinned directly, with no DB and no sweep around it.
 */
export function isStale(activatedAt: Date | string | null, now: Date): boolean {
  if (!activatedAt) return true;
  const at = typeof activatedAt === "string" ? new Date(activatedAt) : activatedAt;
  const atMonth = at.getUTCFullYear() * 12 + at.getUTCMonth();
  const nowMonth = now.getUTCFullYear() * 12 + now.getUTCMonth();
  return atMonth < nowMonth;
}

/**
 * A key that just failed (store.ts recordPlaybookFailure writes a `draft` row versioned "failed-…") is left alone
 * for PLAYBOOK.FAILURE_BACKOFF_DAYS, so a consistently-broken key (a bad skill answer, a provider outage) is not
 * retried — and re-billed — on every single daily check. Detected by VERSION (`failed-…`), not by `note` — review
 * fix: `note` is a human-readable reason with no guaranteed wording, `version` is the one field recordPlaybookFailure
 * and activatePlaybook both already treat as the real marker. `latest` is the newest row for the key, whatever its
 * status; a real (content-bearing) activation since the failure makes `latest` that newer row instead (and also
 * archives every `failed-…` row for the key, store.ts activatePlaybook), so the backoff no longer applies.
 */
export function recentlyFailed(latest: Pick<ContentPlaybookRow, "status" | "version" | "created_at"> | null, now: Date): boolean {
  if (!latest || latest.status !== "draft" || !latest.version.startsWith(FAILURE_VERSION_PREFIX)) return false;
  const ageDays = (now.getTime() - new Date(latest.created_at).getTime()) / DAY;
  return ageDays < PLAYBOOK.FAILURE_BACKOFF_DAYS;
}

export interface PlaybookSweepResult {
  checked: number;
  refreshed: number;
  failed: number;
  skipped: Record<string, number>;
  outcomes: PlaybookRefreshOutcome[];
}

export interface PlaybookSweepDeps {
  now?: Date;
  listKeys?: () => Promise<RosterPlaybookKey[]>;
  refresh?: typeof refreshPlaybookKey;
}

/** A fresh object every call — review fix: a single shared `const EMPTY` object returned to every caller would let
 * one caller's mutation of its `skipped`/`outcomes` leak into every other call that ever got the same reference. */
const emptyResult = (): PlaybookSweepResult => ({ checked: 0, refreshed: 0, failed: 0, skipped: {}, outcomes: [] });

async function sweepOnce(deps: PlaybookSweepDeps): Promise<PlaybookSweepResult> {
  const out = emptyResult();
  const now = deps.now ?? new Date();
  const refresh = deps.refresh ?? refreshPlaybookKey;
  const skip = (why: string) => { out.skipped[why] = (out.skipped[why] ?? 0) + 1; };
  const startedAt = Date.now();

  const keys = await (deps.listKeys ?? rosterPlaybookKeys)();
  const withAge = await Promise.all(keys.map(async (k) => ({
    ...k, active: await getActivePlaybook(k.key), latest: await getLatestPlaybookRow(k.key),
  })));
  // Oldest (or never-refreshed) key first, so a roster with more keys than fit in one run still converges.
  withAge.sort((a, b) => (a.active?.activated_at ? new Date(a.active.activated_at).getTime() : 0) - (b.active?.activated_at ? new Date(b.active.activated_at).getTime() : 0));

  for (const { key, athleteCount, active, latest } of withAge) {
    out.checked++;
    if (out.refreshed + out.failed >= PLAYBOOK.MAX_KEYS_PER_RUN) { skip("run_limit"); continue; }
    if (Date.now() - startedAt >= PLAYBOOK.RUN_BUDGET_MS) { skip("time_budget"); continue; }
    if (recentlyFailed(latest, now)) { skip("recent_failure"); continue; }
    if (!isStale(active?.activated_at ?? null, now)) { skip("recent"); continue; }
    const outcome = await refresh(key, { athleteCount, now });
    out.outcomes.push(outcome);
    if (outcome.status === "activated") out.refreshed++; else out.failed++;
  }
  return out;
}

export async function sweepPlaybookRefresh(deps: PlaybookSweepDeps = {}): Promise<PlaybookSweepResult> {
  if (!agentPlaybookEnabled()) return emptyResult();
  const { ran, result } = await withAdvisoryLock(LOCK_PLAYBOOK_REFRESH, () => sweepOnce(deps));
  if (!ran) return emptyResult();
  const out = result!;
  logger.info({ checked: out.checked, refreshed: out.refreshed, failed: out.failed, skipped: out.skipped }, "playbook refresh sweep");
  return out;
}
