/**
 * dealRanking.test.ts — the deterministic Brief ranking (WS3 §3.7).
 *
 * Pure functions, injectable clock — no db, no mocks. Locks the signal priority
 * (awaiting-athlete ≫ deadline ≫ freshness) and the thread-age derivation.
 */

import {
  threadAgeDays,
  computeDealRank,
  compareByRank,
  isDeadlineExpired,
  type DealRankInput,
} from "./dealRanking";

// Fixed "now" so every ramp is exact.
const NOW = new Date("2026-07-24T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const daysAhead = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

describe("threadAgeDays", () => {
  it("counts whole days since last_message_at", () => {
    expect(threadAgeDays({ lastMessageAt: daysAgo(3) }, NOW)).toBe(3);
  });

  it("falls back to detected_at when there's no message timestamp", () => {
    expect(threadAgeDays({ lastMessageAt: null, detectedAt: daysAgo(10) }, NOW)).toBe(10);
  });

  it("is null when there's no timestamp to anchor on", () => {
    expect(threadAgeDays({ lastMessageAt: null, detectedAt: null }, NOW)).toBeNull();
  });

  it("never goes negative for a future timestamp", () => {
    expect(threadAgeDays({ lastMessageAt: daysAhead(2) }, NOW)).toBe(0);
  });
});

describe("computeDealRank — signal priority", () => {
  const base: DealRankInput = {
    awaitingResponseFrom: "brand",
    deadline: null,
    lastMessageAt: daysAgo(5),
  };

  it("awaiting-athlete dominates every other signal", () => {
    const owed = computeDealRank({ ...base, awaitingResponseFrom: "athlete" }, NOW);
    // A brand-turn deal that maxes deadline + freshness still can't beat it.
    const maxedOther = computeDealRank(
      { awaitingResponseFrom: "brand", deadline: daysAgo(1), lastMessageAt: daysAgo(0) },
      NOW,
    );
    expect(owed).toBeGreaterThan(maxedOther);
  });

  it("a nearer deadline outranks a farther one, all else equal", () => {
    const near = computeDealRank({ ...base, deadline: daysAhead(2) }, NOW);
    const far  = computeDealRank({ ...base, deadline: daysAhead(25) }, NOW);
    expect(near).toBeGreaterThan(far);
  });

  it("a JUST-overdue deadline is still act-now urgent (within grace)", () => {
    const overdue = computeDealRank({ ...base, deadline: daysAgo(2) }, NOW);
    const today   = computeDealRank({ ...base, deadline: NOW.toISOString() }, NOW);
    expect(overdue).toBeGreaterThanOrEqual(today);
    expect(today).toBeGreaterThan(computeDealRank({ ...base, deadline: daysAhead(60) }, NOW));
  });

  it("a WELL-overdue deadline (window closed) is deprioritized, not boosted", () => {
    // The bug: a months-old / past-event deadline (e.g. a finished 'World Cup' campaign)
    // used to score max urgency. It must now rank BELOW a genuinely imminent deal.
    const wellOverdue = computeDealRank({ ...base, deadline: daysAgo(45) }, NOW);
    const imminent    = computeDealRank({ ...base, deadline: daysAhead(2) }, NOW);
    const noDeadline  = computeDealRank({ ...base, deadline: null }, NOW);
    expect(wellOverdue).toBeLessThan(imminent);
    // Past the expire window it contributes no deadline urgency at all.
    expect(wellOverdue).toBe(noDeadline);
    expect(isDeadlineExpired(daysAgo(45), NOW)).toBe(true);
    expect(isDeadlineExpired(daysAgo(2), NOW)).toBe(false);
    expect(isDeadlineExpired(null, NOW)).toBe(false);
  });

  it("freshness breaks ties when awaiting + deadline match", () => {
    const fresh = computeDealRank({ ...base, lastMessageAt: daysAgo(0) }, NOW);
    const stale = computeDealRank({ ...base, lastMessageAt: daysAgo(30) }, NOW);
    expect(fresh).toBeGreaterThan(stale);
  });

  it("is deterministic — identical inputs give identical output", () => {
    const a = computeDealRank(base, NOW);
    const b = computeDealRank({ ...base }, NOW);
    expect(a).toBe(b);
  });

});

describe("compareByRank — stable total order", () => {
  it("sorts awaiting-athlete first, then by rank, deterministically", () => {
    const deals: Array<DealRankInput & { id: string }> = [
      { id: "a", awaitingResponseFrom: "brand",   deadline: null, lastMessageAt: daysAgo(1) },
      { id: "b", awaitingResponseFrom: "athlete", deadline: null, lastMessageAt: daysAgo(9) },
      { id: "c", awaitingResponseFrom: "athlete", deadline: daysAhead(1), lastMessageAt: daysAgo(9) },
    ];
    const order = [...deals].sort((x, y) => compareByRank(x, y, NOW)).map((d) => d.id);
    // Both athlete-turn deals lead; the one with the imminent deadline leads them.
    expect(order).toEqual(["c", "b", "a"]);
  });

  it("ties fall back to fresher-first then id", () => {
    const same = (id: string, ageDays: number): DealRankInput & { id: string } => ({
      id, awaitingResponseFrom: "brand", deadline: null, lastMessageAt: daysAgo(ageDays),
    });
    const order = [same("z", 5), same("y", 2), same("x", 5)]
      .sort((a, b) => compareByRank(a, b, NOW))
      .map((d) => d.id);
    // y is freshest → first; x and z tie on rank+age → id order.
    expect(order).toEqual(["y", "x", "z"]);
  });
});
