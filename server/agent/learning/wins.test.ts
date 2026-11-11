/**
 * wins.test — GET /me/agent/wins (Home v3's Wins circle) reads the learning loop's exceptional-post decisions back:
 * only that kind, only the last 7 days, only this athlete's, newest first, with the metric in words. No database: the
 * store is a fake (the route passes dbStore).
 */
import type { Decision } from "../../../shared/agent";
import { readWins, WIN_DAYS } from "./wins";
import { LEARNING } from "./config";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function decision(id: string, over: Partial<Decision> & { detail?: Record<string, unknown> } = {}): Decision {
  return {
    id, athleteId: "a1", runId: null, skillId: LEARNING.SKILL_ID, suggested: "s", why: "w", evidence: [], response: "pending",
    responseReason: null, respondedAt: null, outcome: "unknown", outcomeNote: null, outcomeAt: null, approvalId: null,
    createdAt: daysAgo(1), kind: "other",
    detail: { kind: "exceptional_post", platform: "instagram", format: "reel", metric: "save_count", ratio: 3.4, conversationId: "c1" },
    ...over,
  } as Decision;
}

const storeOf = (rows: Decision[]) => {
  const calls: unknown[] = [];
  return { calls, store: { listDecisions: async (athleteId: string, filter: unknown) => { calls.push({ athleteId, filter }); return rows; } } };
};

describe("readWins", () => {
  it("returns the loop's exceptional posts of the last 7 days, newest first, the metric in words", async () => {
    const { store, calls } = storeOf([
      decision("old", { createdAt: daysAgo(WIN_DAYS + 1) }),
      decision("one", { createdAt: daysAgo(2) }),
      decision("two", { createdAt: daysAgo(1), detail: { kind: "exceptional_post", platform: "tiktok", format: null, metric: "reach", ratio: 5, conversationId: null } }),
    ]);
    const r = await readWins("a1", store as any, NOW);
    expect(calls).toEqual([{ athleteId: "a1", filter: { skillId: LEARNING.SKILL_ID, kinds: ["other"] } }]);
    expect(r.contract).toBe("agent-wins/1");
    expect(r.posts.map((p) => p.id)).toEqual(["two", "one"]);
    expect(r.posts[1]).toEqual({ id: "one", at: daysAgo(2), platform: "instagram", format: "reel", ratio: 3.4, metric: "saves", conversationId: "c1" });
    expect(r.posts[0]).toMatchObject({ metric: "reach", format: null, conversationId: null });
  });

  it("ignores other decision kinds, another athlete's rows, unknown metrics and rows without a ratio", async () => {
    const { store } = storeOf([
      decision("summary", { detail: { kind: "what_works" } }),
      decision("theirs", { athleteId: "someone-else" }),
      decision("bad-metric", { detail: { kind: "exceptional_post", metric: "made_up", ratio: 3 } }),
      decision("no-ratio", { detail: { kind: "exceptional_post", metric: "reach" } }),
      decision("future", { createdAt: new Date(NOW.getTime() + 60_000).toISOString() }),
    ]);
    expect((await readWins("a1", store as any, NOW)).posts).toEqual([]);
  });

  it("adds brands' direct payments of the same 7 days when the route gives the reader; none without it", async () => {
    const { store } = storeOf([]);
    const sinceSeen: Date[] = [];
    const reader = async (since: Date) => {
      sinceSeen.push(since);
      return [
        { id: "t1", at: daysAgo(3), brand: "Brand", cents: 500000, currency: "usd", dealId: "d1" },
        { id: "future", at: new Date(NOW.getTime() + 86_400_000).toISOString(), brand: "Brand", cents: 100, currency: "usd", dealId: null },
      ];
    };
    const r = await readWins("a1", store as any, NOW, reader);
    expect(sinceSeen[0].toISOString()).toBe(daysAgo(WIN_DAYS));
    expect(r.payments).toEqual([{ id: "t1", at: daysAgo(3), brand: "Brand", cents: 500000, currency: "usd", dealId: "d1" }]);
    expect((await readWins("a1", store as any, NOW)).payments).toBeUndefined();
  });
});
