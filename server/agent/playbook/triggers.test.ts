/**
 * triggers.test.ts — sweepPlaybookRefresh: off → nothing; a key with no active row or a stale one gets refreshed; a
 * recently-refreshed key is skipped; a recently-FAILED key backs off; the per-run cap and the wall-clock budget each
 * stop a sweep from refreshing every key in one call; a failed key is counted without stopping the rest; the
 * advisory lock keeps two sweeps from running at once; two calls never share mutable state. The store (DB) and lock
 * boundaries are mocked, so no real database is reached.
 *
 *   - isStale: ONLY the UTC calendar-month rollover (review fix, round 2: a day-count threshold stacked on top of
 *     the month check made most keys refresh TWICE a month — removed). A test walks every day from Oct 1 to Nov 1
 *     and pins exactly one stale day.
 */
jest.mock("../../db", () => ({ db: {} }));
jest.mock("./store", () => ({ getActivePlaybook: jest.fn(), getLatestPlaybookRow: jest.fn(), FAILURE_VERSION_PREFIX: "failed-" }));
jest.mock("../../lib/pgAdvisoryLock", () => ({
  LOCK_PLAYBOOK_REFRESH: 1n,
  withAdvisoryLock: jest.fn(async (_key: bigint, fn: () => Promise<unknown>) => ({ ran: true, result: await fn() })),
}));

import type { PlaybookKey } from "../../../shared/playbook";
import type { RosterPlaybookKey } from "./keys";
import type { PlaybookRefreshOutcome } from "./refresh";
import { getActivePlaybook, getLatestPlaybookRow } from "./store";
import { withAdvisoryLock } from "../../lib/pgAdvisoryLock";
import { isStale, recentlyFailed, sweepPlaybookRefresh } from "./triggers";

const mockActive = getActivePlaybook as jest.Mock;
const mockLatest = getLatestPlaybookRow as jest.Mock;
const mockLock = withAdvisoryLock as jest.Mock;
const saved = {
  flag: process.env.AGENT_PLAYBOOK, cap: process.env.AGENT_PLAYBOOK_MAX_KEYS_PER_RUN,
  budget: process.env.AGENT_PLAYBOOK_RUN_BUDGET_MS, backoff: process.env.AGENT_PLAYBOOK_FAILURE_BACKOFF_DAYS,
};
afterEach(() => {
  mockActive.mockReset();
  mockLatest.mockReset();
  mockLatest.mockResolvedValue(null);   // default: no failure on file, so recentlyFailed is false unless a test says otherwise
  mockLock.mockReset();
  mockLock.mockImplementation(async (_key: bigint, fn: () => Promise<unknown>) => ({ ran: true, result: await fn() }));
  if (saved.flag === undefined) delete process.env.AGENT_PLAYBOOK; else process.env.AGENT_PLAYBOOK = saved.flag;
  if (saved.cap === undefined) delete process.env.AGENT_PLAYBOOK_MAX_KEYS_PER_RUN; else process.env.AGENT_PLAYBOOK_MAX_KEYS_PER_RUN = saved.cap;
  if (saved.budget === undefined) delete process.env.AGENT_PLAYBOOK_RUN_BUDGET_MS; else process.env.AGENT_PLAYBOOK_RUN_BUDGET_MS = saved.budget;
  if (saved.backoff === undefined) delete process.env.AGENT_PLAYBOOK_FAILURE_BACKOFF_DAYS; else process.env.AGENT_PLAYBOOK_FAILURE_BACKOFF_DAYS = saved.backoff;
});
beforeEach(() => { mockLatest.mockResolvedValue(null); });

const key = (sport: string): PlaybookKey => ({ sport, stage: "developing", platform: "instagram" });
const activated = (k: PlaybookKey, version = "v1"): PlaybookRefreshOutcome => ({ status: "activated", key: k, version, created: true, costMicroUsd: 1 });

describe("isStale (ONLY the UTC calendar-month rollover — no day-count threshold)", () => {
  it("no active row at all is always stale", () => {
    expect(isStale(null, new Date("2026-10-01T11:00:00Z"))).toBe(true);
  });
  it("the Sep 1 11:03 -> Oct 1 11:00 case (the original bug's own pin): a different UTC month is stale, whatever the exact elapsed time", () => {
    expect(isStale(new Date("2026-09-01T11:03:00Z"), new Date("2026-10-01T11:00:00Z"))).toBe(true);
  });
  it("the SAME UTC month is never stale, no matter how many days have passed — there is no day-count threshold any more", () => {
    expect(isStale(new Date("2026-10-01T00:00:00Z"), new Date("2026-10-30T23:59:00Z"))).toBe(false);   // 29+ days, same month
  });
  it("a row activated on the last day of a month is stale the very next day (month rollover), even though it is barely a day old", () => {
    expect(isStale(new Date("2026-09-30T23:00:00Z"), new Date("2026-10-01T01:00:00Z"))).toBe(true);
  });
  it("walking every day from Oct 1 to Nov 1, a row activated Oct 1 is stale on EXACTLY one day: Nov 1 (the month rolls over)", () => {
    const activatedAt = new Date("2026-10-01T05:00:00Z");
    const days: boolean[] = [];
    for (let d = 1; d <= 31; d++) days.push(isStale(activatedAt, new Date(`2026-10-${String(d).padStart(2, "0")}T05:00:00Z`)));
    days.push(isStale(activatedAt, new Date("2026-11-01T05:00:00Z")));
    expect(days.filter(Boolean)).toHaveLength(1);
    expect(days[days.length - 1]).toBe(true);
  });
});

describe("recentlyFailed (detected by VERSION — 'failed-…' — never by the note, review fix)", () => {
  it("no row at all: not a recent failure", () => {
    expect(recentlyFailed(null, new Date("2026-10-11T00:00:00Z"))).toBe(false);
  });
  it("an ACTIVE row is never a failure marker, whatever its version is", () => {
    expect(recentlyFailed({ status: "active", version: "failed-2026-10-10T00:00:00.000Z", created_at: new Date("2026-10-10T00:00:00Z") }, new Date("2026-10-11T00:00:00Z"))).toBe(false);
  });
  it("a draft row whose VERSION does not start 'failed-' is not a failure marker, whatever its note says (e.g. a real refresh's own path_note stored as the note)", () => {
    expect(recentlyFailed({ status: "draft", version: "v2026-10-10-abc123", created_at: new Date("2026-10-10T00:00:00Z") }, new Date("2026-10-11T00:00:00Z"))).toBe(false);
  });
  it("a failure less than FAILURE_BACKOFF_DAYS old is a recent failure", () => {
    expect(recentlyFailed({ status: "draft", version: "failed-2026-10-10T00:00:00.000Z", created_at: new Date("2026-10-10T00:00:00Z") }, new Date("2026-10-11T00:00:00Z"))).toBe(true);
  });
  it("a failure older than FAILURE_BACKOFF_DAYS is no longer backed off", () => {
    expect(recentlyFailed({ status: "draft", version: "failed-2026-10-01T00:00:00.000Z", created_at: new Date("2026-10-01T00:00:00Z") }, new Date("2026-10-11T00:00:00Z"))).toBe(false);
  });
});

test("off: nothing is checked, the roster is never listed, the lock is never taken, and refresh is never called", async () => {
  delete process.env.AGENT_PLAYBOOK;
  const refresh = jest.fn();
  const listKeys = jest.fn(async (): Promise<RosterPlaybookKey[]> => [{ key: key("rowing"), athleteCount: 1 }]);
  const out = await sweepPlaybookRefresh({ listKeys, refresh });
  expect(out).toEqual({ checked: 0, refreshed: 0, failed: 0, skipped: {}, outcomes: [] });
  expect(listKeys).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  expect(mockLock).not.toHaveBeenCalled();
});

test("two 'off' calls never share mutable state — mutating one result cannot pollute the next (review fix, round 2: a shared EMPTY singleton would)", async () => {
  delete process.env.AGENT_PLAYBOOK;
  const first = await sweepPlaybookRefresh({});
  first.skipped.mutated = 99;
  first.outcomes.push({ status: "failed", key: key("rowing"), reason: "error" });
  const second = await sweepPlaybookRefresh({});
  expect(second).toEqual({ checked: 0, refreshed: 0, failed: 0, skipped: {}, outcomes: [] });
});

test("another instance holds the lock: the sweep answers the empty result at once, without listing keys", async () => {
  process.env.AGENT_PLAYBOOK = "true";
  mockLock.mockResolvedValue({ ran: false, result: undefined });
  const refresh = jest.fn();
  const listKeys = jest.fn(async (): Promise<RosterPlaybookKey[]> => [{ key: key("rowing"), athleteCount: 1 }]);
  const out = await sweepPlaybookRefresh({ listKeys, refresh });
  expect(out).toEqual({ checked: 0, refreshed: 0, failed: 0, skipped: {}, outcomes: [] });
  expect(listKeys).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
});

test("on: a key with no active row yet is refreshed, inside the lock", async () => {
  process.env.AGENT_PLAYBOOK = "true";
  mockActive.mockResolvedValue(null);
  const refresh = jest.fn(async (k: PlaybookKey) => activated(k));
  const listKeys = jest.fn(async (): Promise<RosterPlaybookKey[]> => [{ key: key("rowing"), athleteCount: 2 }]);
  const out = await sweepPlaybookRefresh({ listKeys, refresh });
  expect(out).toMatchObject({ checked: 1, refreshed: 1, failed: 0 });
  expect(refresh).toHaveBeenCalledWith(key("rowing"), { athleteCount: 2, now: expect.any(Date) });
  expect(mockLock).toHaveBeenCalledTimes(1);
});

test("a key whose active row is in the SAME UTC month is skipped as recent; a key in an earlier month is refreshed", async () => {
  process.env.AGENT_PLAYBOOK = "true";
  const now = new Date("2026-10-11T00:00:00Z");
  const sameMonth = { activated_at: new Date("2026-10-05T00:00:00Z") };
  const earlierMonth = { activated_at: new Date("2026-08-01T00:00:00Z") };
  mockActive.mockImplementation(async (k: PlaybookKey) => (k.sport === "rowing" ? sameMonth : earlierMonth));
  const refresh = jest.fn(async (k: PlaybookKey) => activated(k));
  const listKeys = jest.fn(async (): Promise<RosterPlaybookKey[]> => [{ key: key("rowing"), athleteCount: 1 }, { key: key("fencing"), athleteCount: 1 }]);
  const out = await sweepPlaybookRefresh({ listKeys, refresh, now });
  expect(out).toMatchObject({ checked: 2, refreshed: 1, failed: 0, skipped: { recent: 1 } });
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledWith(key("fencing"), { athleteCount: 1, now });
});

test("a key that failed recently is backed off and never retried this sweep, even though its active row (if any) is stale", async () => {
  process.env.AGENT_PLAYBOOK = "true";
  const now = new Date("2026-10-11T00:00:00Z");
  mockActive.mockResolvedValue(null);   // no active row at all — would be stale on its own
  mockLatest.mockImplementation(async (k: PlaybookKey) =>
    (k.sport === "rowing" ? { status: "draft", version: "failed-2026-10-10T00:00:00.000Z", created_at: new Date("2026-10-10T00:00:00Z") } : null));
  const refresh = jest.fn(async (k: PlaybookKey) => activated(k));
  const listKeys = jest.fn(async (): Promise<RosterPlaybookKey[]> => [{ key: key("rowing"), athleteCount: 1 }, { key: key("fencing"), athleteCount: 1 }]);
  const out = await sweepPlaybookRefresh({ listKeys, refresh, now });
  expect(out).toMatchObject({ checked: 2, refreshed: 1, failed: 0, skipped: { recent_failure: 1 } });
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledWith(key("fencing"), { athleteCount: 1, now });
});

test("a failed key is counted, never thrown, and other keys still run", async () => {
  process.env.AGENT_PLAYBOOK = "true";
  mockActive.mockResolvedValue(null);
  const refresh = jest.fn(async (k: PlaybookKey): Promise<PlaybookRefreshOutcome> =>
    (k.sport === "rowing" ? { status: "failed", key: k, reason: "invalid_output" } : activated(k)));
  const listKeys = jest.fn(async (): Promise<RosterPlaybookKey[]> => [{ key: key("rowing"), athleteCount: 1 }, { key: key("fencing"), athleteCount: 1 }]);
  const out = await sweepPlaybookRefresh({ listKeys, refresh });
  expect(out).toMatchObject({ checked: 2, refreshed: 1, failed: 1 });
  expect(refresh).toHaveBeenCalledTimes(2);
});

test("the per-run cap stops a sweep from refreshing every key in one call", async () => {
  process.env.AGENT_PLAYBOOK = "true";
  process.env.AGENT_PLAYBOOK_MAX_KEYS_PER_RUN = "1";
  mockActive.mockResolvedValue(null);
  const refresh = jest.fn(async (k: PlaybookKey) => activated(k));
  const listKeys = jest.fn(async (): Promise<RosterPlaybookKey[]> => [{ key: key("rowing"), athleteCount: 1 }, { key: key("fencing"), athleteCount: 1 }]);
  const out = await sweepPlaybookRefresh({ listKeys, refresh });
  expect(out.refreshed + out.failed).toBe(1);
  expect(out.skipped.run_limit).toBe(1);
  expect(refresh).toHaveBeenCalledTimes(1);
});

test("the wall-clock budget stops a sweep from starting new keys once the budget is spent", async () => {
  jest.useFakeTimers({ now: new Date("2026-10-11T00:00:00Z") });
  try {
    process.env.AGENT_PLAYBOOK = "true";
    process.env.AGENT_PLAYBOOK_RUN_BUDGET_MS = String(25 * 60_000);
    mockActive.mockResolvedValue(null);
    // Each refresh "takes" 20 minutes of wall-clock time; the third key should never be reached.
    const refresh = jest.fn(async (k: PlaybookKey) => {
      jest.advanceTimersByTime(20 * 60_000);
      return activated(k);
    });
    const listKeys = jest.fn(async (): Promise<RosterPlaybookKey[]> => [
      { key: key("rowing"), athleteCount: 1 }, { key: key("fencing"), athleteCount: 1 }, { key: key("swimming"), athleteCount: 1 },
    ]);
    const out = await sweepPlaybookRefresh({ listKeys, refresh });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ checked: 3, refreshed: 2, failed: 0, skipped: { time_budget: 1 } });
  } finally {
    jest.useRealTimers();
  }
});
