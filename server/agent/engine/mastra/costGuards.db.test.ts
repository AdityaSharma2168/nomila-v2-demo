/**
 * costGuards.db.test.ts — the Mastra engine's cost guards (1 Nov 2026) on PGlite, with the REAL Mastra Agent loop and a
 * scripted model (testUtils/mastraScripted.ts; no provider, no network). Test athlete dd1a8a80-…; nobody real.
 *
 *   G1  per-athlete turn cap (MILA_MAX_CONCURRENT_TURNS, default 2): a third chat turn in another conversation is
 *       refused with the fixed line (no model call, run stopped/policy/"turn cap", reply kept) while two run, each on
 *       its own simulated instance; a supersede in the SAME conversation still runs; a proactive turn over the cap
 *       defers (never an error, no chat rows); the cap releases when a turn ends; stale running rows do not count;
 *       two admissions racing for the last place: exactly one wins
 *   G2  the day cap is checked after every step: a turn that crosses it mid-run stops with cost_cap_day and its
 *       message, and the cost it ran up is recorded
 *   G3  no second copy of the cards in Mastra's thread: the stored messages carry the tool call and its result text but
 *       no display payload (no toolPayloadTransform, no card DTO); chat v2's stream still carries the card; the next
 *       turn on the thread replays the tool call and result
 */
jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../services/push/events", () => ({ pushWaiting: jest.fn() }));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agentRuns, chatMessages } from "../../../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../../testUtils/pgliteDb";
import { scriptedModel, testRuntime, type ScriptedStep } from "../../../testUtils/mastraScripted";
import type { SSEStream } from "../../../lib/sse";
import { clearJobCache } from "../../jobs";
import { costOf } from "../../models";
import { STOP_MESSAGES } from "../stopMessages";
import { runProactiveTurn } from "../../proactive/turn";
import { MILA_TURN } from "../config";
import { MASTRA_PROVIDER } from "../config";
import { createChatV2Stream, MILA_CARD_PART, type UiPart } from "./chatV2Stream";
import { admitRun, runMastraTurn, stopMastraRun, TURN_CAP, TURN_CAP_MESSAGE, type MastraTurnDeps, type MastraTurnTap } from "./turn";

const TEST_ATHLETE = "dd1a8a80-d31b-423a-a572-9d146716cb0f";
const KEY = "mastra-guards-test-pass-key-0123456789-0123456789";
const ENV = ["NOMILA_MCP_PASS_KEY", "MILA_MAX_CONCURRENT_TURNS", "AGENT_DAY_COST_CAP_USD"] as const;
const saved: Record<string, string | undefined> = {};
let A = "";

function sse(): SSEStream & { tokens: string[] } {
  const s: any = { tokens: [], closed: false, signal: new AbortController().signal };
  s.status = () => undefined; s.token = (t: string) => s.tokens.push(t); s.done = () => undefined;
  s.suggestions = () => undefined; s.profileUpdates = () => undefined; s.error = () => undefined; s.close = () => { s.closed = true; }; s.abort = () => undefined;
  return s;
}
async function engine(steps: ScriptedStep[]) {
  const m = scriptedModel(steps);
  const rt = await testRuntime(m.model);
  // fold: false — the rolling-summary fold is its own test (reads/readsMastra.db.test.ts); left running here it outlives the suite.
  const deps: MastraTurnDeps = { runtime: async () => rt, passKey: KEY, spentToday: async () => 0, isDeleting: async () => false, toolsDeleting: async () => false, fold: false };
  return { m, rt, deps };
}
const until = async (ok: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); };
const runTap = (ids: string[]): MastraTurnTap => ({ run: (id) => ids.push(id), chunk: () => undefined, text: () => undefined });
async function running(): Promise<number> {
  const rows = await db.select({ id: agentRuns.id }).from(agentRuns)
    .where(and(eq(agentRuns.athlete_id, A), eq(agentRuns.provider, MASTRA_PROVIDER), eq(agentRuns.status, "running")));
  return rows.length;
}
/** A slow chat turn in its own conversation on its own simulated instance (its own in-process registry). */
async function slowTurn(conv = randomUUID()) {
  const { m, deps } = await engine([{ text: "slow answer", delayMs: 20_000 }]);
  const ids: string[] = [];
  const here = new Map();
  const done = runMastraTurn({ athleteId: A, message: "take your time", conversationId: conv, sse: sse(), tap: runTap(ids) }, { ...deps, runningHere: here, fencePollMs: 50 });
  await until(() => m.calls >= 1);
  return { conv, done, here, runId: () => ids[0], m };
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.NOMILA_MCP_PASS_KEY = KEY;
  delete process.env.MILA_MAX_CONCURRENT_TURNS;   // the default, 2
  await initTestDb();
  A = await seedAthlete("Test Athlete", { id: TEST_ATHLETE } as never);
}, 120_000);
afterAll(async () => {
  await closeTestDb();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});
beforeEach(() => clearJobCache());
afterEach(async () => { expect(await running()).toBe(0); });

describe("G1: per-athlete turn cap", () => {
  it("a third turn in another conversation is refused while two run; a same-conversation supersede still runs; the cap releases when a turn ends", async () => {
    const one = await slowTurn();
    const two = await slowTurn();
    expect(await running()).toBe(2);

    // A third conversation, a third instance: refused before anything runs.
    const { m: m3, deps: d3 } = await engine([{ text: "never" }]);
    const CONV3 = randomUUID();
    const refused = await runMastraTurn({ athleteId: A, message: "and this too", conversationId: CONV3, sse: sse() }, { ...d3, runningHere: new Map() });
    expect(refused).toMatchObject({ status: "stopped", stopReason: "policy", text: TURN_CAP_MESSAGE, turnCap: true });
    expect(m3.calls).toBe(0);
    const [r3] = await db.select().from(agentRuns).where(eq(agentRuns.id, refused.runId!));
    expect(r3).toMatchObject({ status: "stopped", stop_reason: "policy", error: TURN_CAP, cost_micro_usd: 0 });
    expect(r3.ended_at).not.toBeNull();
    const rows3 = await db.select().from(chatMessages).where(eq(chatMessages.conversation_id, CONV3));
    expect(rows3.map((r) => [r.role, r.content])).toEqual([["user", "and this too"], ["assistant", TURN_CAP_MESSAGE]]);

    // A newer message in conversation one replaces that conversation's turn: not counted, it runs.
    const { m: ms, deps: ds } = await engine([{ text: "newer answer" }]);
    const newer = await runMastraTurn({ athleteId: A, message: "actually, this", conversationId: one.conv, sse: sse() }, { ...ds, runningHere: one.here, fencePollMs: 50 });
    expect(newer).toMatchObject({ status: "completed", text: "newer answer" });
    expect(newer.turnCap).toBeUndefined();
    expect(ms.calls).toBe(1);
    expect(await one.done).toMatchObject({ status: "stopped", stopReason: "aborted" });
    const [r1] = await db.select().from(agentRuns).where(eq(agentRuns.id, one.runId()));
    expect(r1).toMatchObject({ status: "stopped", error: "superseded" });

    // One turn ended: there is room again for another conversation.
    expect(await running()).toBe(1);
    const { m: m4, deps: d4 } = await engine([{ text: "room now" }]);
    const again = await runMastraTurn({ athleteId: A, message: "and this too", conversationId: CONV3, sse: sse() }, { ...d4, runningHere: new Map() });
    expect(again).toMatchObject({ status: "completed", text: "room now" });
    expect(m4.calls).toBe(1);

    expect(await stopMastraRun(A, two.runId(), two.here)).toBe("stopping");
    await two.done;
  }, 90_000);

  it("a proactive turn over the cap defers through the DEFER path: no error, no chat rows, no model call", async () => {
    const one = await slowTurn();
    const two = await slowTurn();
    try {
      const { m, deps } = await engine([{ text: "never" }]);
      const CONV = randomUUID();
      const r = await runProactiveTurn({ athleteId: A, kind: "payment_received", payload: { dealId: randomUUID(), label: "Kite Co", facts: { amountCents: 50000, currency: "USD" } } as never, conversationId: CONV }, { ...deps, runningHere: new Map() } as never);
      expect(m.calls).toBe(0);
      expect(r.run).toMatchObject({ status: "stopped", stopReason: "policy", text: "", turnCap: true });
      expect(r.verdict).toMatchObject({ send: false, why: "defer", defer: { why: "better_time", afterMinutes: 15 } });
      expect(await db.select().from(chatMessages).where(eq(chatMessages.conversation_id, CONV))).toEqual([]);
      const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, r.run.runId!));
      expect(run).toMatchObject({ trigger: "event", status: "stopped", stop_reason: "policy", error: TURN_CAP });
    } finally {
      await stopMastraRun(A, one.runId(), one.here); await stopMastraRun(A, two.runId(), two.here);
      await one.done; await two.done;
    }
  }, 90_000);

  it("a running proactive turn recorded against a conversation still counts there (it never yields to a chat turn)", async () => {
    // The proactive turn holds an isolated row (no conversation); a chat turn in that conversation must not replace it.
    const CONV = randomUUID();
    const values = (conv: string | null) => ({ athlete_id: A, skill_id: "chat", skill_version: "mastra:test", trigger: "event", provider: MASTRA_PROVIDER, model: "m", effort: "low", conversation_id: conv } as const);
    const iso = await admitRun({ athleteId: A, conversationId: null, cap: 2, staleMs: MILA_TURN.timeoutMs, values: values(CONV) });
    const sid = randomUUID();
    await db.execute(sql`INSERT INTO mila_tf_sessions (id, athlete_id, conversation_id, tf_session_id, running_run_id, running_at) VALUES (${sid}::uuid, ${A}::uuid, NULL, ${`mastra:${sid}`}, ${iso.id}::uuid, now())`);
    const other = await admitRun({ athleteId: A, conversationId: randomUUID(), cap: 2, staleMs: MILA_TURN.timeoutMs, values: values(null) });
    const chat = await admitRun({ athleteId: A, conversationId: CONV, cap: 2, staleMs: MILA_TURN.timeoutMs, values: values(CONV) });
    expect([iso.admitted, other.admitted, chat.admitted]).toEqual([true, true, false]);
    expect(chat.running).toBe(2);
    await db.update(agentRuns).set({ status: "stopped", ended_at: new Date() }).where(eq(agentRuns.athlete_id, A));
  });

  it("a proactive turn recorded against a conversation counts there before it claims its row and after it gave it back", async () => {
    // The windows the session-row check alone missed (independent review, 1 Nov 2026): an isolated turn between its
    // admission and its claim, and between giving its row back and writing ended_at. It must count at every moment.
    const CONV = randomUUID();
    const values = (conv: string | null, trigger = "event") => ({ athlete_id: A, skill_id: "chat", skill_version: "mastra:test", trigger, provider: MASTRA_PROVIDER, model: "m", effort: "low", conversation_id: conv } as const);
    const iso = await admitRun({ athleteId: A, conversationId: null, cap: 2, staleMs: MILA_TURN.timeoutMs, values: values(CONV) });
    const other = await admitRun({ athleteId: A, conversationId: randomUUID(), cap: 2, staleMs: MILA_TURN.timeoutMs, values: values(null, "chat") });
    // No session row holds the proactive run (not claimed yet, or already given back): it still counts in CONV.
    const chat = await admitRun({ athleteId: A, conversationId: CONV, cap: 2, staleMs: MILA_TURN.timeoutMs, values: values(CONV, "chat") });
    expect([iso.admitted, other.admitted, chat.admitted]).toEqual([true, true, false]);
    expect(chat.running).toBe(2);
    await db.update(agentRuns).set({ status: "stopped", ended_at: new Date() }).where(eq(agentRuns.athlete_id, A));
  });

  it("in the same conversation: a chat turn is replaced (not counted), a non-chat turn holding the conversation's row is replaced, one not holding it yet counts", async () => {
    const CONV = randomUUID();
    const values = (trigger: string) => ({ athlete_id: A, skill_id: "chat", skill_version: "mastra:test", trigger, provider: MASTRA_PROVIDER, model: "m", effort: "low", conversation_id: CONV } as const);
    const admit = (trigger: string, cap = 1) => admitRun({ athleteId: A, conversationId: CONV, cap, staleMs: MILA_TURN.timeoutMs, values: values(trigger) });
    const end = () => db.update(agentRuns).set({ status: "stopped", ended_at: new Date() }).where(eq(agentRuns.athlete_id, A));
    // A chat turn there, not yet holding the row: replaced.
    expect((await admit("chat")).admitted).toBe(true);
    expect(await admit("chat")).toMatchObject({ admitted: true, running: 0 });
    await end();
    // A waitlist / onboarding moment (trigger event, not isolated) that has not claimed the row yet: counts (fails closed).
    const ev = await admit("event");
    expect(await admit("chat")).toMatchObject({ admitted: false, running: 1 });
    // Once it holds the conversation's row, a newer turn there replaces it.
    const sid = randomUUID();
    await db.execute(sql`INSERT INTO mila_tf_sessions (id, athlete_id, conversation_id, tf_session_id, running_run_id, running_at) VALUES (${sid}::uuid, ${A}::uuid, ${CONV}::uuid, ${`mastra:${sid}`}, ${ev.id}::uuid, now())`);
    expect(await admit("chat")).toMatchObject({ admitted: true, running: 0 });
    await end();
    await db.execute(sql`DELETE FROM mila_tf_sessions WHERE id = ${sid}::uuid`);
  });

  it("stale running rows (older than the turn timeout: a dead instance) do not count", async () => {
    const old = new Date(Date.now() - MILA_TURN.timeoutMs - 60_000);
    for (let i = 0; i < 3; i++) {
      await db.insert(agentRuns).values({ athlete_id: A, skill_id: "chat", skill_version: "mastra:test", trigger: "chat", provider: MASTRA_PROVIDER, model: "m", effort: "low", conversation_id: randomUUID(), started_at: old });
    }
    try {
      const { m, deps } = await engine([{ text: "still here" }]);
      const res = await runMastraTurn({ athleteId: A, message: "hello", conversationId: randomUUID(), sse: sse() }, deps);
      expect(res).toMatchObject({ status: "completed", text: "still here" });
      expect(m.calls).toBe(1);
    } finally {
      await db.update(agentRuns).set({ status: "failed", ended_at: new Date() }).where(and(eq(agentRuns.athlete_id, A), eq(agentRuns.status, "running")));
    }
  });

  it("two instances racing for the last place: exactly one is admitted", async () => {
    const values = { athlete_id: A, skill_id: "chat", skill_version: "mastra:test", trigger: "chat", provider: MASTRA_PROVIDER, model: "m", effort: "low" } as const;
    const first = await admitRun({ athleteId: A, conversationId: randomUUID(), cap: 2, staleMs: MILA_TURN.timeoutMs, values });
    expect(first.admitted).toBe(true);
    const race = await Promise.all([randomUUID(), randomUUID(), randomUUID()].map((conv) =>
      admitRun({ athleteId: A, conversationId: conv, cap: 2, staleMs: MILA_TURN.timeoutMs, values: { ...values, conversation_id: conv } })));
    expect(race.filter((r) => r.admitted)).toHaveLength(1);
    const refused = await db.select().from(agentRuns).where(and(eq(agentRuns.athlete_id, A), eq(agentRuns.error, TURN_CAP)));
    for (const r of race.filter((x) => !x.admitted)) expect(refused.find((x) => x.id === r.id)).toMatchObject({ status: "stopped", stop_reason: "policy" });
    expect(await running()).toBe(2);
    await db.update(agentRuns).set({ status: "stopped", ended_at: new Date() }).where(and(eq(agentRuns.athlete_id, A), eq(agentRuns.status, "running")));
  });

  it("MILA_MAX_CONCURRENT_TURNS tunes the cap", async () => {
    process.env.MILA_MAX_CONCURRENT_TURNS = "1";
    const one = await slowTurn();
    try {
      const { m, deps } = await engine([{ text: "never" }]);
      const res = await runMastraTurn({ athleteId: A, message: "second", conversationId: randomUUID(), sse: sse() }, { ...deps, runningHere: new Map() });
      expect(res).toMatchObject({ stopReason: "policy", turnCap: true });
      expect(m.calls).toBe(0);
    } finally {
      delete process.env.MILA_MAX_CONCURRENT_TURNS;
      await stopMastraRun(A, one.runId(), one.here);
      await one.done;
    }
  }, 60_000);
});

describe("G2: the day cap after every step", () => {
  afterEach(() => { delete process.env.AGENT_DAY_COST_CAP_USD; });

  it("a turn that crosses the day cap mid-run stops with cost_cap_day and its message; its cost is recorded", async () => {
    process.env.AGENT_DAY_COST_CAP_USD = "1";
    const one = costOf("gpt-6-luna", { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50, reasoningTokens: 10, webSearchCalls: 0 });
    // Under the cap at the start, by half a step: the first step crosses it.
    const spent = 1_000_000 - Math.floor(one.microUsd / 2);
    const { m, deps } = await engine([{ tools: [{ name: "recall_facts", args: { query: "a" } }] }, { tools: [{ name: "recall_facts", args: { query: "b" } }] }, { text: "never" }]);
    const res = await runMastraTurn({ athleteId: A, message: "spend", conversationId: randomUUID(), sse: sse() }, { ...deps, spentToday: async () => spent });
    expect(res).toMatchObject({ status: "stopped", stopReason: "cost_cap_day", text: STOP_MESSAGES.cost_cap_day });
    expect(m.calls).toBeLessThanOrEqual(2);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, res.runId!));
    expect(run).toMatchObject({ status: "stopped", stop_reason: "cost_cap_day" });
    expect(run.cost_micro_usd).toBeGreaterThanOrEqual(one.microUsd);
    expect(run.input_tokens).toBeGreaterThanOrEqual(1000);
  });

  it("the spend re-read at each poll counts: other turns that ended meanwhile push this one over the cap", async () => {
    process.env.AGENT_DAY_COST_CAP_USD = "1";
    let reads = 0;
    // At the start nothing is spent; by the first poll their other turns have spent the whole day's cap.
    const spentToday = async () => (reads++ === 0 ? 0 : 1_000_000);
    const { m, deps } = await engine([{ tools: [{ name: "recall_facts", args: { query: "a" } }], delayMs: 300 }, { tools: [{ name: "recall_facts", args: { query: "b" } }], delayMs: 300 }, { text: "never" }]);
    const res = await runMastraTurn({ athleteId: A, message: "spend", conversationId: randomUUID(), sse: sse() }, { ...deps, spentToday, fencePollMs: 20 });
    expect(reads).toBeGreaterThan(1);
    expect(res).toMatchObject({ status: "stopped", stopReason: "cost_cap_day", text: STOP_MESSAGES.cost_cap_day });
    expect(m.calls).toBeLessThan(3);
  });

  it("a failed re-read keeps the last value (never 0): the turn still stops at the cap", async () => {
    process.env.AGENT_DAY_COST_CAP_USD = "1";
    const one = costOf("gpt-6-luna", { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50, reasoningTokens: 10, webSearchCalls: 0 });
    let reads = 0;
    const spentToday = async () => { if (reads++ === 0) return 1_000_000 - Math.floor(one.microUsd / 2); throw new Error("db down"); };
    const { deps } = await engine([{ tools: [{ name: "recall_facts", args: { query: "a" } }], delayMs: 300 }, { tools: [{ name: "recall_facts", args: { query: "b" } }], delayMs: 300 }, { text: "never" }]);
    const res = await runMastraTurn({ athleteId: A, message: "spend", conversationId: randomUUID(), sse: sse() }, { ...deps, spentToday, fencePollMs: 20 });
    expect(reads).toBeGreaterThan(1);
    expect(res).toMatchObject({ status: "stopped", stopReason: "cost_cap_day" });
  });

  it("well under the cap: the same turn runs to the end", async () => {
    process.env.AGENT_DAY_COST_CAP_USD = "1";
    const { deps } = await engine([{ tools: [{ name: "recall_facts", args: { query: "a" } }] }, { text: "done" }]);
    const res = await runMastraTurn({ athleteId: A, message: "spend a little", conversationId: randomUUID(), sse: sse() }, deps);
    expect(res).toMatchObject({ status: "completed", stopReason: null, text: "done" });
  });
});

describe("G3: no second copy of the cards in Mastra's thread", () => {
  it("the stored messages keep the tool call and result text but no display payload; chat v2 still streams the card; the next turn replays the call", async () => {
    const { m, rt, deps } = await engine([
      { tools: [{ name: "remember_preference", args: { kind: "style", statement: "Mornings only." } }] },
      { text: "Want me to save that?" },
      { text: "Saved when you tap." },
    ]);
    const CONV = randomUUID();
    const out: UiPart[] = [];
    const stream = await createChatV2Stream((part) => out.push(part));
    const res = await runMastraTurn({ athleteId: A, message: "Remember I shoot in the mornings.", conversationId: CONV, sse: sse(), tap: stream.tap }, deps);
    await stream.end({ runId: res.runId, status: res.status, stopReason: res.stopReason, cards: res.cards }, []);
    expect(res).toMatchObject({ status: "completed", approvalState: "awaiting_approval" });

    // The stream carries the approval card, as soon as its tool ended (before the text).
    const cardAt = out.findIndex((p) => p.type === MILA_CARD_PART && (p as any).data.type === "action");
    expect(cardAt).toBeGreaterThanOrEqual(0);
    expect((out[cardAt] as any).data.data.fields.pendingActionId).toEqual(expect.any(String));
    expect(cardAt).toBeLessThan(out.findIndex((p) => p.type === "text-delta"));
    const pendingActionId = (out[cardAt] as any).data.data.fields.pendingActionId as string;

    // What Mastra stored for the thread: the raw rows of its memory store.
    const [row] = await db.execute(sql`SELECT id FROM mila_tf_sessions WHERE athlete_id = ${A}::uuid AND conversation_id = ${CONV}::uuid`).then((r: any) => r.rows ?? r);
    const store: any = await rt.storage.getStore("memory");
    const { messages } = await store.listMessages({ threadId: row.id, perPage: false });
    const stored = JSON.stringify(messages);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(stored).not.toContain("toolPayloadTransform");
    expect(stored).not.toContain("pendingActionId");
    expect(stored).not.toContain("needs_approval");
    expect(stored).not.toContain('"fields"');
    // (The approval's id is in the model-facing result, as before: the model needs it. Never as a card.)
    expect(stored).toContain(pendingActionId);
    // The tool call and its model-facing result are still there.
    const parts = messages.flatMap((x: any) => x.content?.parts ?? []);
    const call = parts.find((p: any) => p.type === "tool-invocation" && p.toolInvocation?.toolName === "remember_preference");
    expect(call?.toolInvocation).toMatchObject({ state: "result", args: { kind: "style", statement: "Mornings only." } });
    // (The model-facing result text, which carries the approval's id: never an empty or missing result.)
    expect(JSON.stringify(call.toolInvocation.result ?? null)).toContain(pendingActionId);

    // A later turn on the same thread works and replays the tool call and its result.
    const next = await runMastraTurn({ athleteId: A, message: "ok", conversationId: CONV, sse: sse() }, deps);
    expect(next).toMatchObject({ status: "completed", text: "Saved when you tap." });
    const replay = JSON.stringify(m.prompts[2]);
    expect(replay).toContain("remember_preference");
    expect(replay).toContain("tool-result");
  }, 60_000);
});
