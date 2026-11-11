/**
 * mastraTurn.db.test.ts — a Mila turn on the Mastra engine end to end on PGlite: the REAL Mastra Agent loop (memory on
 * an in-memory store) with a scripted model (no provider, no network), calling OUR real tools in-process with the
 * athlete pass, the real approval queue and the durable turn store. Made-up athletes; nothing names a real person.
 *
 *   M1  one turn: run row (provider mastra, the price-table cost, tool records), approval_state awaiting_approval, the
 *       action card on `done` and on the assistant row, status lines from the stream, text streamed; the thread is the
 *       session row id (server-generated) with the athlete as resource
 *   M2  the next turn of the conversation reuses the thread: Mastra replays the earlier turn from memory
 *   M3  thread-id reuse: A sending B's conversation id never reaches B's thread or words
 *   M4  account deletion: fenced before the turn ⇒ nothing; fenced during ⇒ nothing more written; tools refuse
 *   M5  the day cost cap stops the turn before the model is called
 *   M6  proactive: SILENT and SPEAK decisions (#1161) on a Mastra turn, isolated (no chat rows, own thread)
 *   M7  a conversation another engine ran last (TrueForge, before Mastra-only): the stale Mastra thread is started over,
 *       seeded with the recent chat rows
 *   M8  outside events go to the conversation whose newest Mila turn (either engine) is latest
 *   M9  the step limit: a turn that ends at MAX_STEPS still calling tools stops with max_steps and says so
 *   M10 two turns at once on one conversation: the newer one wins (same instance, and across instances), the older
 *       one stops ("superseded"); no interleaved thread, one approval card
 *   M11 a lost first-insert race joins the winner's row: the pass names it (no pass_mismatch)
 *   M12 cost: the run cap stops the turn after the step that passes it
 *   M13 the fence poll stops a slow turn mid-step; the client leaving does NOT (decision 4): the turn finishes, is
 *       saved and records its whole cost
 *   M14 Stop: from another instance (the poll reads the mark; the row stays held until the turn ends); a Stop before
 *       the claim (no model call, never takes the conversation); v1's stop-by-conversation (this athlete's only)
 *   M15 the reply row cannot be written: the run still ends (failed, "reply not saved"), never left running
 *   M16 Mila's playbooks as Mastra agent skills (skills.ts): a chat turn is offered skill / skill_read / skill_search
 *       and the chat surface's skills, never get_playbook; the skill call shows the fixed status line and is not one
 *       of our tool records; a proactive turn gets the proactive surface's skills
 */
jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../services/push/events", () => ({ pushWaiting: jest.fn() }));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agentRuns, chatMessages, milaTfSessions, pendingActions } from "../../../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../../testUtils/pgliteDb";
import { scriptedModel, testRuntime, type ScriptedStep } from "../../../testUtils/mastraScripted";
import type { SSEStream } from "../../../lib/sse";
import { dbStore } from "../../research/dbStore";
import { clearJobCache } from "../../jobs";
import { costOf } from "../../models";
import { runProactiveTurn } from "../../proactive/turn";
import { PROACTIVE_RULES } from "../../proactive/rules";
import { runMilaTurn } from "../index";
import { runMastraTurn, stopMastraConversation, stopMastraRun, MAX_STEPS, type MastraTurnDeps } from "./turn";
import * as sessions from "../sessions";
import { queueEventForAthlete } from "../sessions";
import { STOP_MESSAGES } from "../stopMessages";
import { passRegistry } from "../tools/registry";
import { MILA_SKILL_TOOL_DESCRIPTIONS } from "./skills";

const KEY = "mastra-db-test-pass-key-0123456789-0123456789";
const ENV = ["NOMILA_MCP_PASS_KEY", "AGENT_SKILL_CAPS"] as const;
const saved: Record<string, string | undefined> = {};
let A = "";
let B = "";

function sse(): SSEStream & { tokens: string[]; statuses: Array<[string, string | undefined]>; doneWith: any; ctl: AbortController } {
  const ctl = new AbortController();
  const s: any = { tokens: [], statuses: [], doneWith: null, closed: false, signal: ctl.signal, ctl };
  s.status = (m: string, phase?: string) => s.statuses.push([m, phase]); s.token = (t: string) => s.tokens.push(t); s.done = (d: unknown) => { s.doneWith = d; };
  s.suggestions = () => undefined; s.profileUpdates = () => undefined; s.error = () => undefined; s.close = () => { s.closed = true; }; s.abort = () => ctl.abort();
  return s;
}

async function engine(steps: ScriptedStep[], opts: { mila?: boolean } = {}) {
  const m = scriptedModel(steps);
  const rt = await testRuntime(m.model, opts);
  // fold: false — the rolling-summary fold is its own test (reads/readsMastra.db.test.ts); left running here it outlives the suite.
  const deps: MastraTurnDeps = { runtime: async () => rt, passKey: KEY, spentToday: async () => 0, isDeleting: async () => false, toolsDeleting: async () => false, fold: false };
  return { m, rt, deps };
}
const promptText = (prompt: unknown) => JSON.stringify(prompt);

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.NOMILA_MCP_PASS_KEY = KEY;
  await initTestDb();
  A = await seedAthlete("Rowan Vale");
  B = await seedAthlete("Other Person");
  await dbStore.insertFacts(A, [
    { subject: { kind: "athlete", name: "Rowan Vale" }, claim: "Rowan Vale races for a university sailing club.", type: "found", source: { url: "https://example.org/club" }, date: "2026-09-01", confidence: 0.9, runId: null },
  ]);
}, 120_000);
afterAll(async () => {
  await closeTestDb();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});
beforeEach(() => clearJobCache());

describe("M1–M2: a Mastra turn", () => {
  const CONV = randomUUID();

  it("records the run, queues the approval card, streams status and text, keeps the thread as the session row", async () => {
    const { m, rt, deps } = await engine([
      { tools: [{ name: "remember_preference", args: { kind: "style", statement: "Afternoon shoots only." } }, { name: "recall_facts", args: { query: "sailing" } }] },
      { text: ["Want me to save ", "that?"] },
    ]);
    const s = sse();
    const res = await runMastraTurn({ athleteId: A, message: "Please remember I only shoot in the afternoon.", conversationId: CONV, sse: s }, deps);

    expect(res).toMatchObject({ status: "completed", stopReason: null, text: "Want me to save that?", approvalState: "awaiting_approval" });
    expect(m.calls).toBe(2);
    expect(s.tokens.join("")).toBe("Want me to save that?");
    expect(s.statuses).toEqual(expect.arrayContaining([["Getting that ready to save…", "tool"], ["Thinking…", "thinking"]]));
    expect(s.doneWith).toMatchObject({ runId: res.runId });
    expect(s.doneWith.cards.map((c: any) => c.kind)).toContain("action");

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, res.runId!));
    expect(run).toMatchObject({ provider: "mastra", model: "gpt-6-luna", trigger: "chat", status: "completed", approval_state: "awaiting_approval", conversation_id: CONV });
    expect((run.tools_called as any[]).map((t) => [t.name, t.outcome])).toEqual([["remember_preference", "queued_for_approval"], ["recall_facts", "ok"]]);
    const want = costOf("gpt-6-luna", { inputTokens: 2000, cachedInputTokens: 1600, outputTokens: 100, reasoningTokens: 20, webSearchCalls: 0 });
    expect([run.input_tokens, run.cached_input_tokens, run.output_tokens, run.cost_micro_usd]).toEqual([2000, 1600, 100, want.microUsd]);
    expect(await db.select().from(pendingActions).where(eq(pendingActions.athlete_id, A))).toHaveLength(1);

    const rows = await db.select().from(chatMessages).where(eq(chatMessages.conversation_id, CONV));
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
    expect(rows[1].agent_run_id).toBe(res.runId);

    const [session] = await db.select().from(milaTfSessions).where(and(eq(milaTfSessions.athlete_id, A), eq(milaTfSessions.conversation_id, CONV)));
    expect(session.tf_session_id).toBe(`mastra:${session.id}`);
    expect((await rt.memory.getThreadById({ threadId: session.id }))?.resourceId).toBe(A);
  });

  it("the next turn reuses the thread: Mastra replays the earlier turn", async () => {
    const { m, deps } = await engine([{ text: "Yes, afternoons." }]);
    // the same in-memory store as the first turn is not shared across engines; seed this one's history by a first turn
    await runMastraTurn({ athleteId: A, message: "First words: kestrel-41.", conversationId: CONV, sse: sse() }, deps);
    await runMastraTurn({ athleteId: A, message: "And again?", conversationId: CONV, sse: sse() }, deps);
    expect(promptText(m.prompts[1])).toContain("kestrel-41");
    const sessions = await db.select().from(milaTfSessions).where(and(eq(milaTfSessions.athlete_id, A), eq(milaTfSessions.conversation_id, CONV)));
    expect(sessions).toHaveLength(1);
  });
});

describe("M3: thread-id reuse", () => {
  it("A sending B's conversation id never reaches B's thread or words", async () => {
    const CONV_B = randomUUID();
    const { m, rt, deps } = await engine([{ text: "ok" }]);
    await runMastraTurn({ athleteId: B, message: "B's private words: osprey-88", conversationId: CONV_B, sse: sse() }, deps);
    const [bSession] = await db.select().from(milaTfSessions).where(eq(milaTfSessions.athlete_id, B));
    const bBefore = (await rt.memory.recall({ threadId: bSession.id })).messages.length;

    const res = await runMastraTurn({ athleteId: A, message: "show me the other chat", conversationId: CONV_B, sse: sse() }, deps);
    expect(promptText(m.prompts[m.prompts.length - 1])).not.toContain("osprey-88");
    expect((await rt.memory.recall({ threadId: bSession.id })).messages.length).toBe(bBefore);
    expect((await rt.memory.getThreadById({ threadId: bSession.id }))?.resourceId).toBe(B);
    // A has its own row for that conversation id (or none if the turn failed): never B's.
    const aRows = await db.select().from(milaTfSessions).where(and(eq(milaTfSessions.athlete_id, A), eq(milaTfSessions.conversation_id, CONV_B)));
    for (const r of aRows) expect(r.id).not.toBe(bSession.id);
    expect(res.status).not.toBe("failed");
  });
});

describe("M4: account deletion", () => {
  it("fenced before the turn: no run, no rows, no model call", async () => {
    const { m, deps } = await engine([{ text: "never" }]);
    const CONV = randomUUID();
    const res = await runMastraTurn({ athleteId: A, message: "hi", conversationId: CONV, sse: sse() }, { ...deps, isDeleting: async () => true });
    expect(res).toMatchObject({ runId: null, status: "stopped" });
    expect(m.calls).toBe(0);
    expect(await db.select().from(chatMessages).where(eq(chatMessages.conversation_id, CONV))).toHaveLength(0);
  });

  it("fenced during the turn: the run ends stopped, nothing more is written; a tool call is refused", async () => {
    const { deps } = await engine([{ tools: [{ name: "remember_preference", args: { kind: "style", statement: "Mornings." } }] }, { text: "Saved." }]);
    const CONV = randomUUID();
    let n = 0;
    const before = (await db.select().from(pendingActions).where(eq(pendingActions.athlete_id, A))).length;
    const res = await runMastraTurn({ athleteId: A, message: "remember mornings", conversationId: CONV, sse: sse() },
      { ...deps, isDeleting: async () => n++ > 0, toolsDeleting: async () => true });
    expect(res).toMatchObject({ status: "stopped", stopReason: "aborted", cards: [] });
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, res.runId!));
    expect(run).toMatchObject({ status: "stopped", error: "account deletion" });
    expect((await db.select().from(chatMessages).where(eq(chatMessages.conversation_id, CONV))).map((r) => r.role)).toEqual(["user"]);
    expect((await db.select().from(pendingActions).where(eq(pendingActions.athlete_id, A))).length).toBe(before);
  });
});

describe("M5: cost cap", () => {
  it("over the day cap: stopped before the model is called", async () => {
    const { m, deps } = await engine([{ text: "never" }]);
    const res = await runMastraTurn({ athleteId: A, message: "hi", conversationId: randomUUID(), sse: sse() }, { ...deps, spentToday: async () => Number.MAX_SAFE_INTEGER });
    expect(res).toMatchObject({ status: "stopped", stopReason: "cost_cap_day" });
    expect(m.calls).toBe(0);
  });
});

describe("M6: proactive decision on Mastra", () => {
  const ev = (conversationId: string) => ({ athleteId: A, kind: "payment_received" as const, payload: { dealId: randomUUID(), label: "Kite Co", facts: { amountCents: 50000, currency: "USD" } } as any, conversationId });

  it("SILENT: nothing is sent; the turn is isolated (no chat rows, its own thread)", async () => {
    const { deps } = await engine([{ text: "```json\n{\"decision\":\"SILENT\",\"reason\":\"nothing new for them\"}\n```" }]);
    const CONV = randomUUID();
    const r = await runProactiveTurn(ev(CONV), deps);
    expect(r.verdict.send).toBe(false);
    expect(r.run.status).toBe("completed");
    expect(await db.select().from(chatMessages).where(eq(chatMessages.conversation_id, CONV))).toEqual([]);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, r.run.runId!));
    expect(run).toMatchObject({ provider: "mastra", trigger: "event" });
  });

  it("SPEAK grounded in the event: the message is sent", async () => {
    expect(PROACTIVE_RULES.payment_received.check).toBe("text");
    const { deps } = await engine([{ text: "```json\n{\"decision\":\"SPEAK\",\"reason\":\"they got paid\",\"message\":\"Your payment from Kite Co arrived.\",\"evidence\":[\"event:payment_received\"]}\n```" }]);
    const r = await runProactiveTurn(ev(randomUUID()), deps);
    expect(r.verdict).toMatchObject({ send: true, text: "Your payment from Kite Co arrived." });
  });
});

describe("M7: a conversation another engine ran last", () => {
  it("the stale Mastra thread starts over, seeded with the chat rows it never saw", async () => {
    const CONV = randomUUID();
    const { m, rt, deps } = await engine([{ text: "Mastra one." }, { text: "Mastra again." }]);
    await runMilaTurn({ athleteId: A, message: "hello kestrel", conversationId: CONV, sse: sse() }, deps);
    const [row] = await db.select().from(milaTfSessions).where(and(eq(milaTfSessions.athlete_id, A), eq(milaTfSessions.conversation_id, CONV)));
    expect(row.last_engine).toBe("mastra");

    // Another engine's turn in between (TrueForge, before Mastra-only): its chat rows, and the session marked as its.
    await db.insert(chatMessages).values([
      { athlete_id: A, role: "user", content: "middle words", conversation_id: CONV },
      { athlete_id: A, role: "assistant", content: "TrueForge middle.", conversation_id: CONV },
    ]);
    await db.update(milaTfSessions).set({ last_engine: "trueforge" }).where(eq(milaTfSessions.id, row.id));

    const res = await runMilaTurn({ athleteId: A, message: "last words", conversationId: CONV, sse: sse() }, deps);
    expect(res).toMatchObject({ status: "completed", text: "Mastra again.", engine: "mastra" });
    const prompt = promptText(m.prompts[1]);
    expect(prompt).toContain("TrueForge middle.");                  // the turn Mastra never saw, from the chat rows
    expect(prompt).toContain("middle words");
    // The old thread was deleted: Mastra holds only this turn (its user message and answer), not the first turn again.
    const msgs = (await rt.memory.recall({ threadId: row.id })).messages;
    expect(msgs.map((x: any) => x.role)).toEqual(["user", "assistant"]);
    const [after] = await db.select().from(milaTfSessions).where(eq(milaTfSessions.id, row.id));
    expect(after.last_engine).toBe("mastra");
  });
});

describe("M8: outside events reach the latest conversation, on either engine", () => {
  it("Mastra runs count: the conversation Mastra ran last gets the event", async () => {
    const C = await seedAthlete("Event Target");
    const [X, Y] = [randomUUID(), randomUUID()];
    const at = (iso: string) => new Date(iso);
    // X: opened first, but Mastra ran it most recently. Y: opened later, a TrueForge turn before X's Mastra turn.
    await db.insert(milaTfSessions).values({ athlete_id: C, conversation_id: X, tf_session_id: `mastra:${randomUUID()}`, created_at: at("2026-10-01T10:00:00Z") });
    await db.insert(milaTfSessions).values({ athlete_id: C, conversation_id: Y, tf_session_id: `tfs-${randomUUID().slice(0, 8)}`, created_at: at("2026-10-02T10:00:00Z") });
    const runRow = (conversation_id: string, provider: string, started_at: Date) => ({
      athlete_id: C, skill_id: "chat", skill_version: "t", trigger: "chat" as const, provider, model: "m", effort: "low" as const, conversation_id, started_at,
    });
    await db.insert(agentRuns).values([runRow(Y, "trueforge", at("2026-10-03T10:00:00Z")), runRow(X, "mastra", at("2026-10-04T10:00:00Z"))]);
    expect(await queueEventForAthlete(C, { kind: "account_connected", platform: "gmail", reconnected: false }, "k1")).toBe(true);
    const rows = await db.select().from(milaTfSessions).where(eq(milaTfSessions.athlete_id, C));
    const events = Object.fromEntries(rows.map((r) => [r.conversation_id, (r.pending_events as unknown[]).length]));
    expect(events).toEqual({ [X]: 1, [Y]: 0 });
  });
});

describe("M9: the step limit", () => {
  it("ends at MAX_STEPS still calling tools: stopped, max_steps, the stop message shown and kept", async () => {
    const { m, deps } = await engine([{ tools: [{ name: "recall_facts", args: { query: "sailing" } }] }]);   // repeats every step
    const CONV = randomUUID();
    const s = sse();
    const res = await runMastraTurn({ athleteId: A, message: "loop forever", conversationId: CONV, sse: s }, deps);
    expect(m.calls).toBe(MAX_STEPS);
    expect(res).toMatchObject({ status: "stopped", stopReason: "max_steps", text: STOP_MESSAGES.max_steps });
    expect(s.tokens.join("")).toBe(STOP_MESSAGES.max_steps);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, res.runId!));
    expect(run).toMatchObject({ status: "stopped", stop_reason: "max_steps" });
    const rows = await db.select().from(chatMessages).where(eq(chatMessages.conversation_id, CONV));
    expect(rows.map((r) => [r.role, r.content])).toEqual([["user", "loop forever"], ["assistant", STOP_MESSAGES.max_steps]]);
  }, 60_000);
});

describe("M10: two turns at once on one conversation", () => {
  const until = async (ok: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); };

  for (const how of ["same instance", "another instance"] as const) {
    it(`the newer turn wins (${how}); the older stops; no interleaved thread; one approval card`, async () => {
      const { m, rt, deps } = await engine([
        { text: "older answer", delayMs: 8_000 },                                                                  // turn 1: slow
        { tools: [{ name: "remember_preference", args: { kind: "style", statement: `Evenings, ${how}.` } }] },     // turn 2
        { text: "Want me to save that?" },
      ]);
      const CONV = randomUUID();
      const before = (await db.select().from(pendingActions).where(eq(pendingActions.athlete_id, A))).length;
      const fast = { ...deps, fencePollMs: 20 };
      const t0 = Date.now();
      const first = runMastraTurn({ athleteId: A, message: "older message", conversationId: CONV, sse: sse() }, how === "same instance" ? fast : { ...fast, runningHere: new Map() });
      await until(() => m.calls >= 1);
      const second = await runMastraTurn({ athleteId: A, message: "newer message", conversationId: CONV, sse: sse() }, how === "same instance" ? fast : { ...fast, runningHere: new Map() });
      const older = await first;
      expect(Date.now() - t0).toBeLessThan(7_000);
      expect(older).toMatchObject({ status: "stopped", stopReason: "aborted", text: "" });
      expect(second).toMatchObject({ status: "completed", text: "Want me to save that?", approvalState: "awaiting_approval" });
      const [r1] = await db.select().from(agentRuns).where(eq(agentRuns.id, older.runId!));
      expect(r1).toMatchObject({ status: "stopped", error: "superseded" });
      expect((await db.select().from(pendingActions).where(eq(pendingActions.athlete_id, A))).length).toBe(before + 1);

      const [row] = await db.select().from(milaTfSessions).where(and(eq(milaTfSessions.athlete_id, A), eq(milaTfSessions.conversation_id, CONV)));
      expect(row.running_run_id).toBeNull();
      const msgs = (await rt.memory.recall({ threadId: row.id })).messages;
      const said = msgs.map((x: any) => `${x.role}:${JSON.stringify(x.content)}`);
      // Nothing of the older turn's answer, and nothing of the older turn after the newer turn's message.
      expect(said.join("\n")).not.toContain("older answer");
      const newer = said.findIndex((x: string) => x.startsWith("user:") && x.includes("newer message"));
      expect(newer).toBeGreaterThanOrEqual(0);
      expect(said.slice(newer + 1).some((x: string) => x.includes("older message"))).toBe(false);
      const chat = await db.select().from(chatMessages).where(eq(chatMessages.conversation_id, CONV));
      expect(chat.filter((r) => r.role === "assistant").map((r) => r.agent_run_id)).toEqual([second.runId]);
    }, 60_000);
  }
});

describe("M11: the first-insert race", () => {
  it("a turn that lost the insert joins the winner's row; its pass names that row (no pass_mismatch)", async () => {
    const CONV = randomUUID();
    const { m, rt, deps } = await engine([{ text: "first" }, { text: "joined" }]);
    await runMastraTurn({ athleteId: A, message: "winner words", conversationId: CONV, sse: sse() }, deps);
    // The loser looked before the winner's row existed: findSession saw nothing, its insert conflicts.
    const spy = jest.spyOn(sessions, "findSession").mockResolvedValueOnce(null);
    try {
      const res = await runMastraTurn({ athleteId: A, message: "loser words", conversationId: CONV, sse: sse() }, deps);
      expect(res).toMatchObject({ status: "completed", text: "joined" });
    } finally { spy.mockRestore(); }
    const rows = await db.select().from(milaTfSessions).where(and(eq(milaTfSessions.athlete_id, A), eq(milaTfSessions.conversation_id, CONV)));
    expect(rows).toHaveLength(1);
    expect(promptText(m.prompts[1])).toContain("winner words");                  // the winner's thread, replayed
    expect((await rt.memory.recall({ threadId: rows[0].id })).messages).toHaveLength(4);
  });
});

describe("M12: the run cost cap", () => {
  afterEach(() => { delete process.env.AGENT_SKILL_CAPS; });

  it("AGENT_SKILL_CAPS: the turn stops after the step that passes the cap; the stop message; that cost recorded", async () => {
    const one = costOf("gpt-6-luna", { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50, reasoningTokens: 10, webSearchCalls: 0 });
    process.env.AGENT_SKILL_CAPS = JSON.stringify({ chat: { cost_cap_usd: (one.microUsd / 2) / 1_000_000 } });
    const { m, deps } = await engine([{ tools: [{ name: "recall_facts", args: { query: "a" } }] }, { tools: [{ name: "recall_facts", args: { query: "b" } }] }, { text: "never" }]);
    const res = await runMastraTurn({ athleteId: A, message: "spend", conversationId: randomUUID(), sse: sse() }, deps);
    expect(res).toMatchObject({ status: "stopped", stopReason: "cost_cap_run", text: STOP_MESSAGES.cost_cap_run });
    expect(m.calls).toBeLessThanOrEqual(2);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, res.runId!));
    expect(run).toMatchObject({ status: "stopped", stop_reason: "cost_cap_run" });
    expect(run.cost_micro_usd).toBeGreaterThanOrEqual(one.microUsd);
    expect(run.input_tokens).toBeGreaterThanOrEqual(1000);
  });
});

describe("M13: a slow turn stopped mid-step", () => {
  it("the fence poll (fencePollMs 1): account deletion stops it", async () => {
    const { deps } = await engine([{ text: "too late", delayMs: 8_000 }]);
    let n = 0;
    const t0 = Date.now();
    const res = await runMastraTurn({ athleteId: A, message: "slow one", conversationId: randomUUID(), sse: sse() }, { ...deps, fencePollMs: 1, isDeleting: async () => n++ > 0 });
    expect(Date.now() - t0).toBeLessThan(6_000);
    expect(res).toMatchObject({ status: "stopped", stopReason: "aborted", text: "" });
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, res.runId!));
    expect(run).toMatchObject({ status: "stopped", stop_reason: "aborted", error: "account deletion" });
  }, 30_000);

  it("the client leaves mid-turn: the turn finishes, its reply is saved and its whole cost recorded (decision 4)", async () => {
    const { m, deps } = await engine([{ tools: [{ name: "recall_facts", args: { query: "sailing" } }] }, { text: "Finished anyway.", delayMs: 1_500 }]);
    const s = sse();
    const conv = randomUUID();
    const turn = runMastraTurn({ athleteId: A, message: "then I left", conversationId: conv, sse: s }, deps);
    const end = Date.now() + 10_000;
    while (m.calls < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    s.ctl.abort();
    const res = await turn;
    expect(res).toMatchObject({ status: "completed", stopReason: null, text: "Finished anyway." });
    const two = costOf("gpt-6-luna", { inputTokens: 2000, cachedInputTokens: 1600, outputTokens: 100, reasoningTokens: 20, webSearchCalls: 0 });
    expect(res.cost.microUsd).toBe(two.microUsd);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, res.runId!));
    expect(run).toMatchObject({ status: "completed", stop_reason: null, error: null, input_tokens: 2000, output_tokens: 100, cost_micro_usd: two.microUsd });
    expect(run.ended_at).not.toBeNull();
    const rows = await db.select().from(chatMessages).where(and(eq(chatMessages.athlete_id, A), eq(chatMessages.conversation_id, conv)));
    expect(rows.map((r) => [r.role, r.content])).toEqual([["user", "then I left"], ["assistant", "Finished anyway."]]);
    expect(rows[1].agent_run_id).toBe(res.runId);
  }, 30_000);
});

describe("M14: Stop", () => {
  const until = async (ok: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); };
  const runOf = async (conv: string) => (await db.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.athlete_id, A), eq(agentRuns.conversation_id, conv))))[0]?.id;

  it("from another instance: the poll stops the turn; the row stays held until it has ended; a second Stop is 'ended'", async () => {
    const { m, deps } = await engine([{ text: "too late", delayMs: 8_000 }]);
    const CONV = randomUUID();
    const t0 = Date.now();
    const turn = runMastraTurn({ athleteId: A, message: "stop me from elsewhere", conversationId: CONV, sse: sse() }, { ...deps, fencePollMs: 400, runningHere: new Map() });
    await until(() => m.calls >= 1);
    const runId = (await runOf(CONV))!;
    expect(await stopMastraRun(B, runId, new Map())).toBe("not_found");
    expect(await stopMastraRun(A, runId, new Map())).toBe("stopping");
    // Not given back by the Stop: a new message now would wait for this turn to end.
    const [held] = await db.select().from(milaTfSessions).where(and(eq(milaTfSessions.athlete_id, A), eq(milaTfSessions.conversation_id, CONV)));
    expect(held.running_run_id).toBe(runId);
    const res = await turn;
    expect(Date.now() - t0).toBeLessThan(6_000);
    expect(res).toMatchObject({ status: "stopped", stopReason: "aborted", text: "" });
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run).toMatchObject({ status: "stopped", stop_reason: "aborted", error: "stopped" });
    const [row] = await db.select().from(milaTfSessions).where(eq(milaTfSessions.id, held.id));
    expect(row.running_run_id).toBeNull();
    expect(await stopMastraRun(A, runId)).toBe("ended");
  }, 30_000);

  it("before the claim: no model call, and the turn never takes the conversation", async () => {
    const { m, deps } = await engine([{ text: "never" }]);
    const CONV = randomUUID();
    const realInsert = sessions.insertSession;
    const ins = jest.spyOn(sessions, "insertSession").mockImplementationOnce(async (q) => {
      expect(await stopMastraRun(A, (await runOf(CONV))!, new Map())).toBe("stopping");
      return realInsert(q);
    });
    const claim = jest.spyOn(sessions, "claimTurn");
    try {
      const res = await runMastraTurn({ athleteId: A, message: "stop me at once", conversationId: CONV, sse: sse() }, { ...deps, runningHere: new Map() });
      expect(res).toMatchObject({ status: "stopped", stopReason: "aborted" });
      expect(m.calls).toBe(0);
      expect(claim).not.toHaveBeenCalled();
    } finally { ins.mockRestore(); claim.mockRestore(); }
  }, 30_000);

  it("v1's stop by conversation: stops this athlete's running turn there; another athlete's ask stops nothing", async () => {
    const { m, deps } = await engine([{ text: "too late", delayMs: 8_000 }]);
    const CONV = randomUUID();
    const turn = runMilaTurn({ athleteId: A, message: "v1 stop me", conversationId: CONV, sse: sse() }, { ...deps, fencePollMs: 50 } as never);
    await until(() => m.calls >= 1);
    expect(await stopMastraConversation(B, CONV, new Map())).toBe(0);
    expect(await stopMastraConversation(A, randomUUID(), new Map())).toBe(0);
    expect(await stopMastraConversation(A, CONV, new Map())).toBe(1);
    const res = await turn;
    expect(res).toMatchObject({ engine: "mastra", status: "stopped", stopReason: "aborted" });
    expect(await stopMastraConversation(A, CONV, new Map())).toBe(0);
  }, 30_000);
});

describe("M15: the reply row cannot be written", () => {
  it("the run still ends: failed, 'reply not saved' (never left running)", async () => {
    const { deps } = await engine([{ text: "an answer that will not save" }]);
    const realInsert = db.insert.bind(db);
    let n = 0;
    const spy = jest.spyOn(db, "insert").mockImplementation(((t: unknown) => {
      if (t === chatMessages && ++n === 2) throw new Error("db down");
      return realInsert(t as never);
    }) as never);
    let res;
    try { res = await runMastraTurn({ athleteId: A, message: "save me", conversationId: randomUUID(), sse: sse() }, deps); }
    finally { spy.mockRestore(); }
    expect(n).toBe(2);
    expect(res).toMatchObject({ status: "failed", stopReason: "error" });
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, res.runId!));
    expect(run).toMatchObject({ status: "failed", stop_reason: "error", error: "reply not saved" });
    expect(run.ended_at).not.toBeNull();
  }, 30_000);
});

describe("M16: Mila's playbooks as Mastra agent skills", () => {
  // our catalog message (skills.ts playbooksCatalog): one "- name: description" line per playbook (prompt is JSON text)
  const catalog = (prompt: unknown) => {
    const b = /<available_playbooks>\\n([\s\S]*?)\\n<\/available_playbooks>/.exec(promptText(prompt));
    return b ? [...b[1].split("\\n").join("\n").matchAll(/^- ([a-z0-9-]+): /gm)].map((x) => x[1]).sort() : [];
  };

  it("a chat turn: skill tools and the chat surface's skills, no get_playbook; the playbook loads with the fixed status line", async () => {
    const { m, deps } = await engine([{ tools: [{ name: "skill", args: { name: "deals" } }] }, { text: "Your deal is waiting on the brand." }], { mila: true });
    const s = sse();
    const res = await runMastraTurn({ athleteId: A, message: "Where is my deal?", conversationId: randomUUID(), sse: s }, deps);
    expect(res).toMatchObject({ status: "completed", text: "Your deal is waiting on the brand." });
    expect(m.toolNames[0]).toEqual(expect.arrayContaining(["skill", "skill_read", "skill_search", "deals_find"]));
    expect(m.toolNames[0]).not.toContain("get_playbook");
    // our words for the skill tools, our own tools keep theirs, and none of Mastra's skills text
    expect(m.toolDescriptions[0].skill).toBe(MILA_SKILL_TOOL_DESCRIPTIONS.skill);
    expect(m.toolDescriptions[0].deals_get).toBe(passRegistry().get("deals_get")!.description);
    expect(promptText(m.prompts[0])).not.toMatch(/IMPORTANT: Skills are NOT tools|<available_skills>/);
    expect(catalog(m.prompts[0])).toEqual(["bookings", "deals", "documents", "onboarding", "public-page"]);
    // the model read the playbook (the tool result in its next prompt), the instructions name the skill tool
    expect(promptText(m.prompts[1])).toContain("# Deals: what you can do with them");
    expect(promptText(m.prompts[0])).toContain("call the skill tool with the area's name");
    expect(promptText(m.prompts[0])).not.toContain("get_playbook");
    expect(s.statuses).toEqual(expect.arrayContaining([["Getting ready…", "tool"]]));
    expect(s.tokens.join("")).not.toContain("# Deals");
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, res.runId!));
    expect((run.tools_called as any[]).map((t) => t.name)).toEqual([]);
  }, 30_000);

  it("a proactive turn: the proactive surface's skills", async () => {
    const { m, deps } = await engine([{ text: "```json\n{\"decision\":\"SILENT\",\"reason\":\"nothing new\"}\n```" }], { mila: true });
    const r = await runProactiveTurn({ athleteId: A, kind: "payment_received", payload: { dealId: randomUUID(), label: "Kite Co", facts: { amountCents: 50000, currency: "USD" } } as any, conversationId: randomUUID() }, deps);
    expect(r.run.status).toBe("completed");
    expect(catalog(m.prompts[0])).toEqual(["bookings", "deals", "documents"]);
  }, 30_000);
});
