/**
 * briefTeaser — pure-function unit tests (no React, no RN, no network).
 * Covers the "Your Week" teaser ladder (full / sparse / empty, never zero-y) and the
 * "Ask for terms" unpriced count.
 *
 * Jest is scoped to server/ by the repo config, so run this suite explicitly:
 *   npx jest --roots client/components/deals/brief
 */

import {
  buildWeekTeaser,
  deriveTeaserInputs,
  weekTeaser,
  countUnpriced,
  isUnpriced,
  type TeaserInputs,
} from "./briefTeaser";
import type { AgentActionRow } from "../../../hooks/use-agent-actions";
import type { DealItem } from "../DealCard";

const NOW = Date.UTC(2026, 6, 25);
const daysAgoISO = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

function deal(over: Partial<DealItem> = {}): DealItem {
  return {
    id:         "d1",
    brandName:  "Playermaker",
    category:   "PAID",
    status:     "detected",
    verdict:    "good",
    source:     "gmail",
    sourceType: "Email",
    score:      7,
    timeAgo:    "2d ago",
    aiSummary:  "They want a launch post.",
    detectedAt:    daysAgoISO(2),
    lastMessageAt: daysAgoISO(2),
    ...over,
  };
}

function action(over: Partial<AgentActionRow> = {}): AgentActionRow {
  return {
    id: "a1", athlete_id: "ath1", action: "file", deal_id: "d1", thread_id: "t1",
    reason: null, reversible: true, held_until: null, undone_at: null,
    payload: null, result: null, created_at: daysAgoISO(2), ...over,
  };
}

// ─── buildWeekTeaser — the ladder ───────────────────────────────────────────────

describe("buildWeekTeaser — full / sparse / empty ladder", () => {
  const base: TeaserInputs = { handled: 0, setAside: 0, asked: 0, arrived: 0, needsYou: 0 };

  it("full tier leads with Mila's agency + all real detail clauses", () => {
    const t = buildWeekTeaser({ ...base, handled: 5, setAside: 2, asked: 3 });
    expect(t.tier).toBe("full");
    expect(t.text).toBe("Mila handled 5 for you — 2 set aside, 3 moved to terms");
  });

  it("full tier fires whenever Mila handled work, dropping any zero detail clause", () => {
    // handled + asked present, nothing set aside → the "set aside" clause is dropped,
    // never printed as "0 set aside". We stay in full — Mila still did the work.
    const t = buildWeekTeaser({ handled: 3, setAside: 0, asked: 3, arrived: 4, needsYou: 1 });
    expect(t.tier).toBe("full");
    expect(t.text).toBe("Mila handled 3 for you — 3 moved to terms, 4 new in");
  });

  it("full tier with no detail clauses is still a clean agency line", () => {
    const t = buildWeekTeaser({ ...base, handled: 2 });
    expect(t.tier).toBe("full");
    expect(t.text).toBe("Mila handled 2 for you");
  });

  it("sparse tier is a sentence weaving both numbers when both are real", () => {
    const t = buildWeekTeaser({ ...base, arrived: 4, needsYou: 2 });
    expect(t.tier).toBe("sparse");
    expect(t.text).toBe("4 new deals landed — 2 still need you.");
  });

  it("sparse tier reads naturally when only one number is real (with singulars)", () => {
    expect(buildWeekTeaser({ ...base, arrived: 0, needsYou: 3 }).text)
      .toBe("3 asks are waiting on you — everything else is handled.");
    expect(buildWeekTeaser({ ...base, arrived: 1, needsYou: 0 }).text)
      .toBe("1 new deal landed — I've got the rest held.");
  });

  it("empty tier when there is nothing real to show", () => {
    const t = buildWeekTeaser(base);
    expect(t.tier).toBe("empty");
    expect(t.text).toBe("A quiet stretch so far — I'll keep watch.");
  });
});

// ─── deriveTeaserInputs — reuses weekLogic ──────────────────────────────────────

describe("deriveTeaserInputs", () => {
  it("counts arrived (new, your court), needsYou (you owe), and set-aside", () => {
    const deals = [
      deal({ id: "arr", status: "detected", awaitingResponseFrom: "brand", lastMessageAt: daysAgoISO(1) }),
      deal({ id: "owe", status: "negotiating", awaitingResponseFrom: "athlete", lastMessageAt: daysAgoISO(1) }),
    ];
    const actions = [action({ id: "f", action: "file", created_at: daysAgoISO(1) })];
    const inp = deriveTeaserInputs(deals, actions, NOW);
    expect(inp.arrived).toBe(1);   // "arr" landed in your court this week
    expect(inp.needsYou).toBe(1);  // "owe" awaits the athlete
    expect(inp.setAside).toBe(1);  // one filing
  });

  it("empty inputs when there are no deals and no actions", () => {
    const inp = deriveTeaserInputs([], [], NOW);
    expect(inp).toEqual({ handled: 0, setAside: 0, asked: 0, arrived: 0, needsYou: 0 });
    expect(weekTeaser([], [], NOW).tier).toBe("empty");
  });

  it("tolerates a missing (undefined) actions feed", () => {
    expect(() => deriveTeaserInputs([], undefined, NOW)).not.toThrow();
  });
});

// ─── countUnpriced — the Ask-for-terms batch size ───────────────────────────────

describe("countUnpriced", () => {
  it("counts open deals with no offer, and excludes priced / closed / archived", () => {
    const deals = [
      deal({ id: "u1", offerAmount: undefined, offerDisplay: undefined }),           // unpriced open
      deal({ id: "u2", status: "negotiating" }),                                      // unpriced open
      deal({ id: "priced", offerAmount: "$2,000" }),                                  // has a price
      deal({ id: "closed", status: "completed" }),                                    // not open
      deal({ id: "filed", threadStatus: "archived" }),                                // set aside
    ];
    expect(countUnpriced(deals)).toBe(2);
    expect(isUnpriced(deals[0])).toBe(true);
    expect(isUnpriced(deals[2])).toBe(false);
  });
});
