/**
 * replyPush.db.test — "Mila: your reply is ready" (agent/engine/replyPush.ts), on PGlite with the REAL Mastra turn and a
 * scripted model (no provider), and Expo's push service MOCKED (setPushClient: tests never reach Expo).
 *
 *   R1 the client left before the turn finished → one push, with the run's key and the conversation + saved message ids
 *   R2 the client was still connected → none
 *   R3 stopped (her Stop), superseded (a newer turn in the conversation) and refused by the turn cap → none
 *   R4 her "all notifications" switch off → none (the push service says opted_out; Expo is never called)
 *   R5 two instances finishing the same run → one notification (the push_sends claim); the deletion fence → none
 *   R6 a turn that queued a card waiting on her tap (it pushed already) → none; the pure rule for the rest
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../services/push/events", () => ({ pushWaiting: jest.fn() }));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { chatMessages, pushSends } from "../../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { scriptedModel, testRuntime, type ScriptedStep } from "../../testUtils/mastraScripted";
import type { SSEStream } from "../../lib/sse";
import { clearJobCache } from "../jobs";
import { admitRun, runMastraTurn, stopMastraRun, type MastraTurnDeps } from "./mastra/turn";
import { notifyReplyReady, replyPushWanted, replyReadyEvent, REPLY_READY_COPY, type ReplyPushFacts } from "./replyPush";
import { registerDevice, sendPush, setPushClient, writePreferences, type PushClient, type PushEvent, type PushMessage } from "../../services/push/push";

const KEY = "reply-push-test-pass-key-0123456789-0123456789";
const ENV = ["NOMILA_MCP_PASS_KEY", "PUSH_NOTIFICATIONS", "MILA_MAX_CONCURRENT_TURNS"] as const;
const saved: Record<string, string | undefined> = {};
let A = "";

const sent: PushMessage[] = [];
const fake: PushClient = {
  chunkPushNotifications: (m) => [m],
  sendPushNotificationsAsync: async (m) => { sent.push(...m); return m.map((_, i) => ({ status: "ok" as const, id: `t-${sent.length}-${i}` })); },
  chunkPushNotificationReceiptIds: (ids) => [ids],
  getPushNotificationReceiptsAsync: async () => ({}),
};

function sse(closed = false): SSEStream & { ctl: AbortController } {
  const ctl = new AbortController();
  const s: any = { closed, signal: ctl.signal, ctl };
  s.status = () => undefined; s.token = () => undefined; s.done = () => undefined; s.suggestions = () => undefined;
  s.profileUpdates = () => undefined; s.error = () => undefined; s.close = () => { s.closed = true; }; s.abort = () => ctl.abort();
  return s;
}

/** The pushes the turn asked for (the real push service is exercised in R4–R5). */
const pushes: Array<{ athleteId: string; event: PushEvent }> = [];
async function engine(steps: ScriptedStep[]) {
  const m = scriptedModel(steps);
  const rt = await testRuntime(m.model);
  const deps: MastraTurnDeps = {
    runtime: async () => rt, passKey: KEY, spentToday: async () => 0, isDeleting: async () => false, toolsDeleting: async () => false, fold: false,
    replyPush: { isDeleting: async () => false, push: async (athleteId, event) => { pushes.push({ athleteId, event }); return { status: "sent", devices: 1 }; } },
  };
  return { m, deps };
}
const until = async (ok: () => boolean | Promise<boolean>, ms = 10_000) => { const end = Date.now() + ms; while (!(await ok()) && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); };

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.NOMILA_MCP_PASS_KEY = KEY;
  await initTestDb();
  A = await seedAthlete("Rowan Vale");
  setPushClient(fake);
}, 120_000);
afterAll(async () => {
  setPushClient(null);
  await closeTestDb();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});
beforeEach(() => { clearJobCache(); pushes.length = 0; sent.length = 0; });

describe("R1–R2: did she leave?", () => {
  it("R1 the client left before the turn finished: one push, with the run's key, the conversation and the saved message", async () => {
    const { m, deps } = await engine([{ text: "Here is your long answer.", delayMs: 300 }]);
    const s = sse();
    const CONV = randomUUID();
    const turn = runMastraTurn({ athleteId: A, message: "a long one", conversationId: CONV, sse: s }, deps);
    await until(() => m.calls >= 1);
    s.closed = true; // the phone dropped mid-reply
    const res = await turn;
    expect(res.status).toBe("completed");
    const [reply] = await db.select({ id: chatMessages.id }).from(chatMessages).where(and(eq(chatMessages.conversation_id, CONV), eq(chatMessages.role, "assistant")));
    expect(pushes).toHaveLength(1);
    expect(pushes[0].athleteId).toBe(A);
    expect(pushes[0].event).toMatchObject({
      kind: "mila_reply", dedupeKey: `mila_reply:${res.runId}`, title: REPLY_READY_COPY.title, body: REPLY_READY_COPY.body,
      target: { screen: "mila", id: CONV, messageId: reply.id }, threadId: CONV,
    });
  }, 30_000);

  it("R2 the client was still connected when the turn finished: no push", async () => {
    const { deps } = await engine([{ text: "You saw this live." }]);
    const res = await runMastraTurn({ athleteId: A, message: "quick one", conversationId: randomUUID(), sse: sse() }, deps);
    expect(res.status).toBe("completed");
    expect(pushes).toHaveLength(0);
  });
});

describe("R3: stopped, superseded, capped", () => {
  it("her Stop: no push, though she had left", async () => {
    const { m, deps } = await engine([{ text: "too late", delayMs: 8_000 }]);
    const CONV = randomUUID();
    let runId = "";
    const turn = runMastraTurn({ athleteId: A, message: "stop me", conversationId: CONV, sse: sse(true), tap: { run: (id) => { runId = id; }, chunk: () => undefined, text: () => undefined } }, { ...deps, fencePollMs: 50 });
    await until(() => m.calls >= 1 && !!runId);
    expect(await stopMastraRun(A, runId)).toBe("stopping");
    expect((await turn).status).toBe("stopped");
    expect(pushes).toHaveLength(0);
  }, 30_000);

  it("superseded by a newer turn in the conversation: the older one sends nothing; the newer one (she left) sends one", async () => {
    const { m, deps } = await engine([{ text: "older answer", delayMs: 8_000 }, { text: "newer answer" }]);
    const CONV = randomUUID();
    const fast = { ...deps, fencePollMs: 20 };
    const first = runMastraTurn({ athleteId: A, message: "older", conversationId: CONV, sse: sse(true) }, fast);
    await until(() => m.calls >= 1);
    const second = await runMastraTurn({ athleteId: A, message: "newer", conversationId: CONV, sse: sse(true) }, fast);
    const older = await first;
    expect(older.status).toBe("stopped");
    expect(pushes.map((p) => p.event.dedupeKey)).toEqual([`mila_reply:${second.runId}`]);
  }, 30_000);

  it("refused by the turn cap: no push", async () => {
    process.env.MILA_MAX_CONCURRENT_TURNS = "1";
    try {
      const busy = await seedAthlete("Busy Person");
      await admitRun({
        athleteId: busy, conversationId: null, cap: 1, staleMs: 600_000,
        values: { athlete_id: busy, skill_id: "chat", skill_version: "mastra:test", trigger: "chat", provider: "mastra", model: "gpt-6-luna", effort: "low", conversation_id: randomUUID() },
      });
      const { m, deps } = await engine([{ text: "never" }]);
      const res = await runMastraTurn({ athleteId: busy, message: "and this", conversationId: randomUUID(), sse: sse(true) }, deps);
      expect(res.turnCap).toBe(true);
      expect(m.calls).toBe(0);
      expect(pushes).toHaveLength(0);
    } finally { delete process.env.MILA_MAX_CONCURRENT_TURNS; }
  });
});

describe("R4–R5: the push service's rules, for real (Expo mocked)", () => {
  const facts = (over: Partial<ReplyPushFacts> = {}): ReplyPushFacts => ({
    athleteId: A, runId: randomUUID(), conversationId: randomUUID(), messageId: randomUUID(), status: "completed",
    clientLeft: true, interactive: true, turnCap: false, waitingPushed: false, ...over,
  });
  beforeAll(async () => {
    process.env.PUSH_NOTIFICATIONS = "true";
    await registerDevice(A, { token: "ExponentPushToken[reply-push-test-0001]", platform: "ios", timeZone: "UTC" });
  });
  afterAll(() => { delete process.env.PUSH_NOTIFICATIONS; });

  it("R4 her 'all notifications' switch off: nothing reaches Expo", async () => {
    await writePreferences(A, { enabled: false });
    try {
      expect(await notifyReplyReady(facts(), { isDeleting: async () => false })).toBe("opted_out");
      expect(sent).toHaveLength(0);
    } finally { await writePreferences(A, { enabled: true }); }
  });

  it("R4 the 'Mila's suggestions' switch off does not hold it back (she asked for this reply)", async () => {
    await writePreferences(A, { milaSuggestion: false, quietHours: false });
    try {
      expect(await notifyReplyReady(facts(), { isDeleting: async () => false })).toBe("sent");
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ title: "Mila", body: "Your reply is ready.", data: { kind: "mila_reply", target: { screen: "mila" } } });
    } finally { await writePreferences(A, { milaSuggestion: true, quietHours: true }); }
  });

  it("R5 two instances finishing the same run: one notification (the push_sends claim)", async () => {
    await writePreferences(A, { quietHours: false });
    const f = facts();
    const [a, b] = await Promise.all([notifyReplyReady(f, { isDeleting: async () => false }), notifyReplyReady(f, { isDeleting: async () => false })]);
    expect([a, b].sort()).toEqual(["duplicate", "sent"]);
    expect(sent).toHaveLength(1);
    expect((sent[0].data.target as { id: string; messageId: string })).toEqual({ screen: "mila", id: f.conversationId, messageId: f.messageId });
    const rows = await db.select().from(pushSends).where(and(eq(pushSends.athlete_id, A), eq(pushSends.dedupe_key, `mila_reply:${f.runId}`)));
    expect(rows).toHaveLength(1);
    expect(await sendPush(A, { kind: "mila_reply", dedupeKey: `mila_reply:${f.runId}`, title: "x", body: "y", target: { screen: "mila" } })).toMatchObject({ status: "duplicate" });
  });

  it("R4 inside her quiet hours: delivered silently (no sound, passive, the quiet channel), not skipped", async () => {
    // A quiet window that covers every minute but the last one of the day (UTC, the device's zone).
    await writePreferences(A, { quietHours: true, quietStart: 0, quietEnd: 24 * 60 - 1 });
    try {
      const now = new Date("2026-11-03T12:00:00Z");
      const res = await sendPush(A, replyReadyEvent({ runId: randomUUID(), conversationId: randomUUID(), messageId: randomUUID() }), { now });
      expect(res).toMatchObject({ status: "sent", quiet: true });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ sound: null, interruptionLevel: "passive", channelId: "quiet" });
    } finally { await writePreferences(A, { quietHours: true, quietStart: 22 * 60, quietEnd: 8 * 60 }); }
  });

  it("R5 after the account-deletion fence: nothing", async () => {
    expect(await notifyReplyReady(facts(), { isDeleting: async () => true })).toBe("fenced");
    expect(sent).toHaveLength(0);
  });
});

describe("R6: the rule", () => {
  const f = (over: Partial<ReplyPushFacts>): ReplyPushFacts => ({
    athleteId: A, runId: "r", conversationId: "c", messageId: "m", status: "completed", clientLeft: true, interactive: true, turnCap: false, waitingPushed: false, ...over,
  });
  it("only a completed, saved, interactive turn she left, with no waiting card that pushed already", () => {
    expect(replyPushWanted(f({}))).toBe(true);
    expect(replyPushWanted(f({ clientLeft: false }))).toBe(false);
    expect(replyPushWanted(f({ status: "stopped" }))).toBe(false);
    expect(replyPushWanted(f({ status: "failed" }))).toBe(false);
    expect(replyPushWanted(f({ turnCap: true }))).toBe(false);
    expect(replyPushWanted(f({ interactive: false }))).toBe(false);
    expect(replyPushWanted(f({ messageId: null }))).toBe(false);
    expect(replyPushWanted(f({ conversationId: null }))).toBe(false);
    expect(replyPushWanted(f({ waitingPushed: true }))).toBe(false);
  });

  it("a turn whose only card is 'Want me to save that?' (which never pushes): the reply push still goes, once", async () => {
    const { deps } = await engine([
      { tools: [{ name: "remember_preference", args: { kind: "style", statement: "Mornings." } }] },
      { text: "Want me to save that?" },
    ]);
    // save_memory never pushes, so the reply push still goes: one push in all.
    const res = await runMastraTurn({ athleteId: A, message: "remember mornings", conversationId: randomUUID(), sse: sse(true) }, deps);
    expect(res.approvalState).toBe("awaiting_approval");
    expect(pushes).toHaveLength(1);
  });
});
