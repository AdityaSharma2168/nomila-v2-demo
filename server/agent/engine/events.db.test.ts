/**
 * events.db.test.ts (was agent/tf/tfEvents.db.test.ts) — outside events for Mila (design §5 follow-ups, first written for
 * TrueForge), on PGlite. No model, no provider is reached: these only queue rows that the next Mila turn delivers (that
 * delivery is engine/mastra/mastraTurn.db.test.ts).
 * A made-up athlete; nothing names a real person, team or brand.
 *
 *   E1  target: an outside event lands on the athlete's most recently used Mila conversation (newest Mila run; the
 *       "trueforge" runs here are history that still counts),
 *       never on a conversation-less row, never on another athlete's session
 *   E2  idempotent: one waiting event per key (a webhook twice, a second reply on the same deal); after delivery
 *       (clearEvents) the same key queues again
 *   E3  deal reply: fresh replies only (24 h), the deal's brand read for this athlete only, nothing for a deal not theirs
 *   E4  research finished: the lean refresh and sign-up research onDone hooks queue one event with the saved-fact count
 *   E5  account connected: one event per connect key; reconnect says so
 *   E6  Mila always runs on Mastra: a leftover MILA_ENGINE value changes nothing (still queued)
 *   E7  the lines Mila reads (Prompt Register "Mila on TrueForge — per-turn input")
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agentRuns, deals, milaTfSessions } from "../../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { clearEvents, pendingEvents, queueEventForAthlete, type AppEvent } from "./sessions";
import { newFactsFrom, noteAccountConnected, noteDealReply, noteResearchDone } from "./events";
import { eventLine } from "./context";
import { leanRefreshOnDone } from "../researchRefresh/leanRefresh";
import { signupResearchOnDone } from "../onboarding/signupResearchWorkflow";

const ENV = ["NOMILA_MCP_PASS_KEY", "MILA_ENGINE"] as const;
const savedEnv: Record<string, string | undefined> = {};

let A = "";
let B = "";
let NEW = "";   // A's most recently used conversation (session row id)
let OLD = "";
let B_ROW = "";

async function session(athleteId: string, conversationId: string | null, createdAt: Date): Promise<string> {
  const [r] = await db.insert(milaTfSessions).values({
    athlete_id: athleteId, conversation_id: conversationId, tf_session_id: `tfs-${randomUUID()}`, created_at: createdAt,
  }).returning({ id: milaTfSessions.id });
  return r.id;
}
async function milaRun(athleteId: string, conversationId: string, startedAt: Date, provider = "trueforge"): Promise<void> {
  await db.insert(agentRuns).values({
    athlete_id: athleteId, skill_id: "chat", skill_version: "tf:mila-dev", trigger: "chat", provider, model: "mila-dev",
    effort: "low", status: "completed", conversation_id: conversationId, started_at: startedAt, ended_at: startedAt,
  });
}
const waiting = async (rowId: string): Promise<AppEvent[]> => {
  const [r] = await db.select({ e: milaTfSessions.pending_events }).from(milaTfSessions).where(eq(milaTfSessions.id, rowId));
  return (r?.e ?? []) as AppEvent[];
};
const reset = () => db.update(milaTfSessions).set({ pending_events: [] });

beforeAll(async () => {
  for (const k of ENV) savedEnv[k] = process.env[k];
  process.env.NOMILA_MCP_PASS_KEY = "tf-events-pass-key-0123456789-0123456789-01";
  await initTestDb();
  A = await seedAthlete("Rowan Vale");
  B = await seedAthlete("Other Person");
  const c1 = randomUUID(); const c2 = randomUUID(); const cB = randomUUID();
  // c1 was created later than c2, but c2 had the newest Mila turn (a TrueForge one, from before its retirement): c2 is the one in use.
  OLD = await session(A, c1, new Date("2026-10-20T10:00:00Z"));
  NEW = await session(A, c2, new Date("2026-10-10T10:00:00Z"));
  await milaRun(A, c1, new Date("2026-10-20T10:05:00Z"));
  await milaRun(A, c2, new Date("2026-10-25T09:00:00Z"));
  await milaRun(A, c1, new Date("2026-10-26T09:00:00Z"), "openai");   // not a Mila turn: does not count
  await session(A, null, new Date("2026-10-26T12:00:00Z"));           // conversation-less: never a target
  B_ROW = await session(B, cB, new Date("2026-10-26T12:30:00Z"));
}, 120_000);
afterAll(async () => {
  for (const k of ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  await closeTestDb();
});
beforeEach(() => reset());

describe("E1/E2 target and idempotency", () => {
  it("queues on the most recently used conversation only, once per key, and again after delivery", async () => {
    const e = { kind: "account_connected" as const, platform: "gmail", reconnected: false };
    expect(await queueEventForAthlete(A, e, "account_connected:k1")).toBe(true);
    expect(await queueEventForAthlete(A, e, "account_connected:k1")).toBe(false);   // same news already waits
    expect(await queueEventForAthlete(A, e, "account_connected:k2")).toBe(true);
    expect((await waiting(NEW)).map((x) => x.key)).toEqual(["account_connected:k1", "account_connected:k2"]);
    expect(await waiting(OLD)).toEqual([]);
    expect(await waiting(B_ROW)).toEqual([]);

    const row = { id: NEW, athleteId: A, conversationId: null, tfSessionId: "x" };
    const delivered = await pendingEvents(row);
    await clearEvents(row, delivered.map((x) => x.id));
    expect(await queueEventForAthlete(A, e, "account_connected:k1")).toBe(true);   // delivered ⇒ may queue again
  });

  it("nothing for an athlete without a Mila conversation", async () => {
    const C = await seedAthlete("No Chat Yet");
    expect(await queueEventForAthlete(C, { kind: "account_connected", platform: "gmail", reconnected: false }, "k")).toBe(false);
  });
});

describe("E3 deal reply", () => {
  it("queues a fresh reply with the deal's brand, one per deal; old, undated and someone else's deals queue nothing", async () => {
    const [mine] = await db.insert(deals).values({ athlete_id: A, brand_name: "Example Outdoor Co", status: "detected" } as any).returning({ id: deals.id });
    const [theirs] = await db.insert(deals).values({ athlete_id: B, brand_name: "Elsewhere Ltd", status: "detected" } as any).returning({ id: deals.id });
    const now = new Date("2026-10-26T15:00:00Z");
    expect(await noteDealReply(A, { dealId: mine.id, receivedAt: new Date("2026-10-26T14:00:00Z") }, now)).toBe(true);
    expect(await noteDealReply(A, { dealId: mine.id, receivedAt: new Date("2026-10-26T14:30:00Z") }, now)).toBe(false);   // one per deal
    expect(await noteDealReply(A, { dealId: mine.id, receivedAt: new Date("2026-10-24T14:00:00Z") }, now)).toBe(false);   // older than 24 h
    expect(await noteDealReply(A, { dealId: mine.id, receivedAt: null }, now)).toBe(false);
    expect(await noteDealReply(A, { dealId: theirs.id, receivedAt: new Date("2026-10-26T14:00:00Z") }, now)).toBe(false);   // not hers
    const ev = await waiting(NEW);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: "deal_reply", dealId: mine.id, brand: "Example Outdoor Co", key: `deal_reply:${mine.id}`, at: now.toISOString() });
  });
});

describe("E4 research finished", () => {
  it("the lean refresh and sign-up research hooks queue one event per run with the facts saved", async () => {
    const r1 = randomUUID(); const r2 = randomUUID();
    await leanRefreshOnDone({ runId: r1, athleteId: A, input: {}, outputs: { lean_research: { inserted: 3 }, mia_preview: { status: "ready" } } });
    await leanRefreshOnDone({ runId: r1, athleteId: A, input: {}, outputs: { lean_research: { inserted: 3 } } });   // exactly once anyway
    await signupResearchOnDone({ runId: r2, athleteId: A, input: {}, outputs: { research_merge: { inserted: 0 } } });
    await signupResearchOnDone({ runId: randomUUID(), athleteId: null, input: {}, outputs: {} });   // no athlete: nothing
    const ev = await waiting(NEW);
    expect(ev.map((e) => e.kind === "research_done" && [e.process, e.runId, e.newFacts])).toEqual([
      ["lean_research_refresh", r1, 3], ["signup_research", r2, 0],
    ]);
  });

  it("reads the saved-fact count from either research step, or none", () => {
    expect(newFactsFrom({ lean_research: { inserted: 4 } })).toBe(4);
    expect(newFactsFrom({ research_merge: { inserted: 2 } })).toBe(2);
    expect(newFactsFrom({ lean_research: { inserted: "x" } })).toBeNull();
    expect(newFactsFrom(undefined)).toBeNull();
  });
});

describe("E5 account connected", () => {
  it("one event per connect; a reconnect says so", async () => {
    expect(await noteAccountConnected(A, { platform: "instagram", reconnected: true, connectKey: "conn-1:2026-10-26T10:00:00.000Z" })).toBe(true);
    expect(await noteAccountConnected(A, { platform: "instagram", reconnected: true, connectKey: "conn-1:2026-10-26T10:00:00.000Z" })).toBe(false);
    const [e] = await waiting(NEW);
    expect(e).toMatchObject({ kind: "account_connected", platform: "instagram", reconnected: true });
  });
});

describe("E6 always on Mastra", () => {
  it.each([["harness"], ["trueforge"]])("a leftover MILA_ENGINE=%s changes nothing: the event is still queued", async (v) => {
    const before = process.env.MILA_ENGINE;
    process.env.MILA_ENGINE = v;
    try {
      expect(await noteAccountConnected(A, { platform: "gmail", reconnected: false, connectKey: `leftover-${v}` })).toBe(true);
      expect((await waiting(NEW)).map((e) => e.kind)).toEqual(["account_connected"]);
    } finally { if (before === undefined) delete process.env.MILA_ENGINE; else process.env.MILA_ENGINE = before; }
  });
});

describe("E7 the lines Mila reads", () => {
  const at = "2026-10-26T14:02:00.000Z";
  it.each([
    [{ kind: "deal_reply", dealId: "d-1", brand: "Example Outdoor Co" }, '- 2026-10-26 14:02 UTC · A new message arrived on their deal with "Example Outdoor Co" (deal_id d-1). Read it with deals_get before you say what it says.'],
    [{ kind: "deal_reply", dealId: "d-1", brand: null }, "- 2026-10-26 14:02 UTC · A new message arrived on one of their deals (deal_id d-1). Read it with deals_get before you say what it says."],
    [{ kind: "research_done", process: "lean_research_refresh", runId: "r", newFacts: 3 }, "- 2026-10-26 14:02 UTC · The research refresh finished: 3 new facts saved to their record. Look them up with recall_facts before you use them."],
    [{ kind: "research_done", process: "signup_research", runId: "r", newFacts: 1 }, "- 2026-10-26 14:02 UTC · Research on the athlete finished: 1 new fact saved to their record. Look them up with recall_facts before you use them."],
    [{ kind: "research_done", process: "lean_research_refresh", runId: "r", newFacts: 0 }, "- 2026-10-26 14:02 UTC · The research refresh finished: nothing new was saved to their record."],
    [{ kind: "research_done", process: "signup_research", runId: "r", newFacts: null }, "- 2026-10-26 14:02 UTC · Research on the athlete finished. Look up what it found with recall_facts before you use it."],
    [{ kind: "account_connected", platform: "youtube", reconnected: false }, "- 2026-10-26 14:02 UTC · The athlete connected YouTube. Nomila is reading it now, which can take a few minutes."],
    [{ kind: "account_connected", platform: "spotify", reconnected: true }, "- 2026-10-26 14:02 UTC · The athlete reconnected spotify. Nomila is reading it now, which can take a few minutes."],
  ])("%j", (body, line) => {
    expect(eventLine({ id: "e", at, ...(body as any) })).toBe(line);
  });
});
