/**
 * proactive.db.test.ts — Mila starts the conversation, end to end on PGlite (design "Mila on watch", phase 1). The
 * Mila turn is a scripted fake; the push is a recorder. No model, no provider, no TrueForge, no Expo is ever reached.
 * (The real isolated turn on Mastra is engine/mastra/mastraTurn.db.test.ts M6.) Test athlete dd1a8a80-…; a second, made-up
 * athlete for tenancy.
 *
 *   P1  the event log: once per (athlete, key), the run started once, a repeat ignored
 *   P2  decide: brief and unknown kinds are recorded and end; a reminder sends its own fixed-copy push, once
 *   P3  SILENT, or no card on a card rule ⇒ nothing in the chat, no push
 *   P4  speak + notify: only the finished message lands in the deal's own conversation, Mila-started and unread, is
 *       remembered on that conversation's session row (max 3), and ONE push opens on that exact message
 *   P5  no buzz while the athlete is in the app; no buzz past 5 Mila notifications a day; connects never buzz
 *   P6  a turn that cannot run sends the source's fixed-copy push instead
 *   P7  a burst of replies on one deal is one Mila message
 *   P8  unread count and seen are the athlete's own; reopening a chat shows which messages Mila started
 *   P9  (retired with the TrueForge chat path, Mastra-only PR 2: the isolated real turn is mastraTurn.db.test.ts M6)
 *   P10 owner decision (b), 28 Oct 2026: once Mila has said it, the same news waiting on the "next chat" queue is
 *       dropped; SILENT keeps it; with the flag off the queue is as before
 *   P11 owner decision (c): the lock screen shows Mila's first sentence only with "Show brand names" on (the real
 *       sendPush, Expo mocked); otherwise the rule's fixed words
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { ChatCard } from "../../../shared/agent";
import { agentRuns, athleteEvents, chatMessages, milaTfSessions, pushSends } from "../../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { registerDevice, sendPush, setPushClient, writePreferences, type PushClient, type PushEvent, type PushMessage } from "../../services/push/push";
import { noteAccountConnected } from "../engine/events";
import { getConversationMessages } from "../../mila/conversations";
import { clearJobCache } from "../jobs";
import { emitAthleteEvent } from "./events";
import { decideStep, notifyStep, proactiveConversationId, speakStep, type DispatchDeps } from "./dispatcher";
import type { AthleteEventKind } from "./rules";
import { markSeen, unreadMila } from "./unread";

const A = "dd1a8a80-d31b-423a-a572-9d146716cb0f";
let B = "";
const NOW = new Date("2026-10-27T15:00:00Z");
const ENV = ["NOMILA_MCP_PASS_KEY", "MILA_PROACTIVE", "PUSH_NOTIFICATIONS"] as const;
const savedEnv: Record<string, string | undefined> = {};

const actionCard = (runId: string): ChatCard => ({ id: `action:${runId}`, kind: "action", title: "Reply to the brand", payload: {}, links: [], runId } as unknown as ChatCard);
/** The decision block a proactive turn ends with (decision.ts). */
const decision = (o: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify({ reason: "test", ...o })}\n\`\`\``;
const says = (message: string, evidence: string[], extra: Record<string, unknown> = {}) => decision({ decision: "SPEAK", message, evidence, cards: [], risk: "none", ...extra });
type Script = { text: string; cards?: (runId: string) => ChatCard[]; status?: "completed" | "failed"; tools?: any[]; throws?: boolean };
const fakeTurn = (s: Script) => jest.fn(async () => {
  if (s.throws) throw new Error("MILA_TF_CHAT is on but not configured: TRUEFORGE_BASE_URL");
  const runId = randomUUID();
  return { runId, text: s.text, status: s.status ?? "completed", stopReason: null, cards: s.cards?.(runId) ?? [], cost: {} as any, tools: s.tools ?? [] };
});
const recorder = () => {
  const sent: Array<{ athleteId: string; e: PushEvent }> = [];
  return { sent, push: async (athleteId: string, e: PushEvent) => { sent.push({ athleteId, e }); return { status: "sent" as const, devices: 1 }; } };
};

async function logEvent(kind: AthleteEventKind, key: string, payload: Record<string, unknown> = {}, athleteId = A): Promise<string> {
  const id = await emitAthleteEvent({ athleteId, kind, dedupeKey: key, payload }, { start: async () => undefined });
  if (!id) throw new Error("event not logged");
  return id;
}
async function dispatch(eventId: string, deps: DispatchDeps, athleteId = A) {
  const d = await decideStep(athleteId, eventId, deps);
  if (d.done) return { outcome: d.outcome };
  const s = await speakStep(athleteId, eventId, deps);
  if (!s.spoke) return { outcome: s.outcome };
  return notifyStep(athleteId, eventId, deps);
}
const eventRow = async (id: string) => (await db.select().from(athleteEvents).where(eq(athleteEvents.id, id)))[0];

beforeAll(async () => {
  for (const k of ENV) savedEnv[k] = process.env[k];
  process.env.NOMILA_MCP_PASS_KEY = "proactive-test-pass-key-0123456789-0123456789";
  // The turn itself is injected in every test here.
  process.env.MILA_PROACTIVE = "true";
  await initTestDb();
  await seedAthlete("Test Athlete", { id: A } as any);
  B = await seedAthlete("Other Person");
}, 120_000);
afterAll(async () => {
  await closeTestDb();
  for (const k of ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});
beforeEach(async () => {
  clearJobCache();
  await db.delete(athleteEvents);
  await db.delete(chatMessages);
  await db.delete(pushSends);
  await db.delete(milaTfSessions);
});

describe("P1 the event log", () => {
  it("writes once per (athlete, key) and starts one run; another athlete's same key is theirs", async () => {
    const start = jest.fn(async () => undefined);
    const e = { athleteId: A, kind: "brand_reply" as const, dedupeKey: "brand_reply:d1:m1", payload: { dealId: "d1", label: "Acme" } };
    const id = await emitAthleteEvent(e, { start });
    expect(id).toBeTruthy();
    expect(await emitAthleteEvent(e, { start })).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(A, id);
    expect(await emitAthleteEvent({ ...e, athleteId: B }, { start })).toBeTruthy();
    expect((await eventRow(id!)).payload).toEqual({ dealId: "d1", label: "Acme" });
  });

  it("the run cannot start: the source's fixed-copy push still goes out", async () => {
    const sendSpy = jest.spyOn(require("../../services/push/push"), "pushSoon").mockImplementation(() => undefined);
    try {
      const fallbackPush: PushEvent = { kind: "brand_reply", dedupeKey: "brand_reply:d8:m1", title: "A brand replied", body: "Open Nomila to read it.", target: { screen: "opportunities" } };
      const id = await emitAthleteEvent({ athleteId: A, kind: "brand_reply", dedupeKey: "brand_reply:d8:m1", payload: { dealId: "d8", fallbackPush } }, { start: async () => { throw new Error("runner down"); } });
      expect(id).toBeNull();
      expect(sendSpy).toHaveBeenCalledWith(A, fallbackPush);
    } finally { sendSpy.mockRestore(); }
  });
});

describe("P2 decide", () => {
  it("brief and unknown kinds are recorded and end; nothing runs", async () => {
    const runTurn = fakeTurn({ text: "x" });
    const p = recorder();
    const brief = await logEvent("research_done", "research_done:r1");
    expect(await dispatch(brief, { now: () => NOW, push: p.push, turn: { runTurn } })).toEqual({ outcome: "brief" });
    const [unknown] = await db.insert(athleteEvents).values({ athlete_id: A, kind: "something_new", dedupe_key: "x:1" }).returning({ id: athleteEvents.id });
    expect(await dispatch(unknown.id, { now: () => NOW, push: p.push, turn: { runTurn } })).toEqual({ outcome: "silent" });
    expect(runTurn).not.toHaveBeenCalled();
    expect(p.sent).toEqual([]);
    expect((await eventRow(brief)).dispatched_at).toBeTruthy();
  });

  it("a reminder sends its own fixed-copy push, once", async () => {
    const p = recorder();
    const fallbackPush: PushEvent = { kind: "waiting", dedupeKey: "waiting:item1", title: "Waiting on your tap", body: "A message is ready for you to check.", target: { screen: "mila" } };
    const id = await logEvent("draft_waiting", "draft_waiting:item1", { fallbackPush });
    expect(await dispatch(id, { now: () => NOW, push: p.push })).toEqual({ outcome: "reminded_sent" });
    expect(await dispatch(id, { now: () => NOW, push: p.push })).toEqual({ outcome: "reminded_sent" });
    expect(p.sent).toEqual([{ athleteId: A, e: fallbackPush }]);
  });
});

describe("P3 code checks", () => {
  it("SILENT sends nothing", async () => {
    const p = recorder();
    const id = await logEvent("payment_received", "payment_received:t1", { label: "Acme", facts: { amountCents: 50000 } });
    expect(await dispatch(id, { now: () => NOW, push: p.push, turn: { runTurn: fakeTurn({ text: "SILENT" }) } })).toEqual({ outcome: "silent" });
    expect(await db.select().from(chatMessages)).toEqual([]);
    expect(p.sent).toEqual([]);
  });

  it("a deal message with no card (and no read of the deal) sends nothing", async () => {
    const p = recorder();
    const id = await logEvent("brand_reply", "brand_reply:d1:m1", { dealId: "d1", label: "Acme" });
    expect(await dispatch(id, { now: () => NOW, push: p.push, turn: { runTurn: fakeTurn({ text: says("Acme wrote back.", ["deal:d1"]) }) } })).toEqual({ outcome: "no_card" });
    expect(await db.select().from(chatMessages)).toEqual([]);
    expect(p.sent).toEqual([]);
  });
});

describe("P4 speak and notify", () => {
  it("adds only the finished message to the deal's conversation, unread, remembers it, and sends one push that opens on it", async () => {
    const conv = proactiveConversationId(A, "deal:d1");
    // The athlete already has a session row for that conversation, with three earlier Mila-started messages.
    const old = [1, 2, 3].map((n) => ({ id: randomUUID(), at: NOW.toISOString(), key: `mila_started:old${n}`, kind: "mila_started", text: `old ${n}`, cards: [] }));
    await db.insert(milaTfSessions).values({ athlete_id: A, conversation_id: conv, tf_session_id: "tfs-athlete", pending_events: old });
    const p = recorder();
    const runTurn = fakeTurn({ text: says("Acme asked for your rate for three posts. I drafted a reply quoting it.", ["deal:d1"]), cards: (r) => [actionCard(r)] });
    const id = await logEvent("brand_reply", "brand_reply:d1:m1", { dealId: "d1", label: "Acme" });
    expect(await dispatch(id, { now: () => NOW, push: p.push, turn: { runTurn } })).toEqual({ outcome: "spoke" });

    const msgs = await db.select().from(chatMessages);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ athlete_id: A, role: "assistant", conversation_id: conv, mila_started: true, seen_at: null });
    expect((msgs[0].agent_cards as any[])[0].kind).toBe("action");
    const ev = await eventRow(id);
    expect(ev).toMatchObject({ outcome: "spoke", conversation_id: conv, message_id: msgs[0].id });

    // Remembered on the conversation's own session; at most 3 Mila-started messages are kept there.
    const [s] = await db.select().from(milaTfSessions).where(eq(milaTfSessions.conversation_id, conv));
    const started = (s.pending_events as any[]).filter((e) => e.kind === "mila_started");
    expect(started.map((e) => e.text)).toEqual(["old 2", "old 3", msgs[0].content]);
    expect(started[2].cards).toEqual(["Reply to the brand"]);

    expect(p.sent).toHaveLength(1);
    const e = p.sent[0].e;
    expect(e).toMatchObject({ kind: "mila_message", dedupeKey: "mila:brand_reply:d1:m1", title: "Mila", pref: "brandReply", target: { screen: "mila", id: conv, messageId: msgs[0].id }, threadId: conv });
    expect(e.body).not.toContain("Acme");   // the lock screen names no brand unless they turned names on
    expect(e.named?.body).toBe("Acme asked for your rate for three posts.");
    expect(e.collapseId).toMatch(/^mila-[0-9a-f]{24}$/);

    // A retried notify step sends nothing new.
    expect(await notifyStep(A, id, { now: () => NOW, push: p.push })).toEqual({ outcome: "spoke" });
    expect(p.sent).toHaveLength(1);
  });

  it("a read of the event's own deal is enough without a card; other events go to that day's conversation", async () => {
    const p = recorder();
    const id = await logEvent("brand_reply", "brand_reply:d2:m1", { dealId: "d2" });
    const tools = [{ name: "deals_get", outcome: "ok", args: { deal_id: "d2" } }];
    expect(await dispatch(id, { now: () => NOW, push: p.push, turn: { runTurn: fakeTurn({ text: says("They confirmed the date for the shoot.", ["deal:d2"]), tools }) } })).toEqual({ outcome: "spoke" });
    const pay = await logEvent("payment_received", "payment_received:t9", { label: "Acme" });
    expect(await dispatch(pay, { now: () => NOW, push: p.push, turn: { runTurn: fakeTurn({ text: says("Acme paid you.", ["event:payment_received"]) }) } })).toEqual({ outcome: "spoke" });
    expect((await eventRow(pay)).conversation_id).toBe(proactiveConversationId(A, "day:2026-10-27"));
  });
});

describe("P5 when the phone stays quiet", () => {
  it("the athlete is in the app: the message waits in the chat, no buzz", async () => {
    await db.insert(chatMessages).values({ athlete_id: A, role: "user", content: "hi", created_at: new Date(NOW.getTime() - 60_000) });
    const p = recorder();
    const id = await logEvent("payment_received", "payment_received:t2", {});
    expect(await dispatch(id, { now: () => NOW, push: p.push, turn: { runTurn: fakeTurn({ text: says("You got paid.", ["event:payment_received"]) }) } })).toEqual({ outcome: "spoke_held_active" });
    expect(p.sent).toEqual([]);
  });

  it("past 5 Mila notifications in 24 hours, no buzz (other kinds don't count); never for an important event", async () => {
    for (let i = 0; i < 5; i++) await db.insert(pushSends).values({ athlete_id: A, kind: "mila_message", dedupe_key: `mila:x${i}`, devices: 1, created_at: new Date(NOW.getTime() - 3_600_000) });
    await db.insert(pushSends).values({ athlete_id: B, kind: "mila_message", dedupe_key: "mila:b", devices: 1 });
    const p = recorder();
    const id = await logEvent("score_band_moved", "score_band_moved:t3", { facts: { from: "Rising", to: "Strong" } });
    expect(await dispatch(id, { now: () => NOW, push: p.push, turn: { runTurn: fakeTurn({ text: says("Your score moved up a band.", ["event:score_band_moved"]) }) } })).toEqual({ outcome: "spoke_capped" });
    expect(p.sent).toEqual([]);
    // Owner rule (28 Oct 2026): a payment (an important business event) is never held back by pacing.
    const pay = await logEvent("payment_received", "payment_received:t3", {});
    expect(await dispatch(pay, { now: () => NOW, push: p.push, turn: { runTurn: fakeTurn({ text: says("You got paid.", ["event:payment_received"]) }) } })).toEqual({ outcome: "spoke" });
    expect(p.sent).toHaveLength(1);
  });

  it("a connect is said in the chat only", async () => {
    const p = recorder();
    const id = await logEvent("account_connected", "account_connected:c1", { facts: { platform: "instagram", reconnected: false } });
    expect(await dispatch(id, { now: () => NOW, push: p.push, turn: { runTurn: fakeTurn({ text: says("Instagram is connected.", ["platform:instagram"]) }) } })).toEqual({ outcome: "spoke_in_chat" });
    expect(p.sent).toEqual([]);
    expect(await db.select().from(chatMessages)).toHaveLength(1);
  });
});

describe("P6 a turn that cannot run", () => {
  it("sends the source's fixed-copy push instead", async () => {
    const p = recorder();
    const fallbackPush: PushEvent = { kind: "brand_reply", dedupeKey: "brand_reply:d3:m1", title: "A brand replied", body: "Open Nomila to read it.", target: { screen: "opportunities" } };
    const id = await logEvent("brand_reply", "brand_reply:d3:m1", { dealId: "d3", fallbackPush });
    expect(await dispatch(id, { now: () => NOW, push: p.push, turn: { runTurn: fakeTurn({ text: "", throws: true }) } })).toEqual({ outcome: "turn_error_fallback_sent" });
    const id2 = await logEvent("brand_reply", "brand_reply:d3:m2", { dealId: "d3", fallbackPush: { ...fallbackPush, dedupeKey: "brand_reply:d3:m2" } });
    expect(await dispatch(id2, { now: () => NOW, push: p.push, turn: { runTurn: fakeTurn({ text: "Sorry", status: "failed" }) } })).toEqual({ outcome: "turn_failed_fallback_sent" });
    expect(p.sent.map((s) => s.e.kind)).toEqual(["brand_reply", "brand_reply"]);
    expect(await db.select().from(chatMessages)).toEqual([]);
  });
});

describe("P7 a burst on one deal", () => {
  it("is one Mila message within the window", async () => {
    const p = recorder();
    const runTurn = fakeTurn({ text: says("They replied; I drafted an answer.", ["deal:d4"]), cards: (r) => [actionCard(r)] });
    const first = await logEvent("brand_reply", "brand_reply:d4:m1", { dealId: "d4" });
    expect(await dispatch(first, { now: () => NOW, push: p.push, turn: { runTurn } })).toEqual({ outcome: "spoke" });
    const second = await logEvent("brand_reply", "brand_reply:d4:m2", { dealId: "d4" });
    expect(await dispatch(second, { now: () => new Date(NOW.getTime() + 60_000), push: p.push, turn: { runTurn } })).toEqual({ outcome: "coalesced" });
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("two turns on one deal that overlap: the one that finishes second stays quiet", async () => {
    const p = recorder();
    const first = await logEvent("brand_reply", "brand_reply:d6:m1", { dealId: "d6" });
    const second = await logEvent("brand_reply", "brand_reply:d6:m2", { dealId: "d6" });
    const deps = { now: () => NOW, push: p.push, turn: { runTurn: fakeTurn({ text: says("They replied; I drafted an answer.", ["deal:d6"]), cards: (r) => [actionCard(r)] }) } };
    expect(await decideStep(A, first, deps)).toEqual({ done: false });
    expect(await decideStep(A, second, deps)).toEqual({ done: false });
    // While the second event's turn runs, the first one's message lands (its notify step has not run yet).
    const slow = jest.fn(async () => {
      expect((await speakStep(A, first, deps)).spoke).toBe(true);
      return { runId: randomUUID(), text: says("They replied again.", ["deal:d6"]), status: "completed" as const, stopReason: null, cards: [actionCard("r2")], cost: {} as any, tools: [] };
    });
    expect(await speakStep(A, second, { ...deps, turn: { runTurn: slow } })).toEqual({ spoke: false, outcome: "coalesced" });
    expect(await db.select().from(chatMessages)).toHaveLength(1);
  });
});

describe("P8 unread", () => {
  it("counts the athlete's own unseen Mila-started messages; seen is per conversation and per athlete", async () => {
    const c1 = randomUUID(); const c2 = randomUUID();
    const [m1] = await db.insert(chatMessages).values({ athlete_id: A, role: "assistant", content: "one", conversation_id: c1, mila_started: true, created_at: new Date(NOW.getTime() - 2000) }).returning();
    const [m2] = await db.insert(chatMessages).values({ athlete_id: A, role: "assistant", content: "two", conversation_id: c2, mila_started: true, created_at: new Date(NOW.getTime() - 1000) }).returning();
    await db.insert(chatMessages).values({ athlete_id: A, role: "assistant", content: "a reply", conversation_id: c1, created_at: NOW });
    await db.insert(chatMessages).values({ athlete_id: B, role: "assistant", content: "theirs", conversation_id: c1, mila_started: true });
    expect(await unreadMila(A)).toEqual({ count: 2, latest: { conversationId: c2, messageId: m2.id } });
    expect((await getConversationMessages(A, c1)).map((m) => [m.content, m.milaStarted ?? false, m.unread ?? false])).toEqual([["one", true, true], ["a reply", false, false]]);
    expect(await markSeen(B, c2)).toBe(0);
    expect(await markSeen(A, c1)).toBe(1);
    expect(await unreadMila(A)).toEqual({ count: 1, latest: { conversationId: c2, messageId: m2.id } });
    expect((await unreadMila(B)).count).toBe(1);
    expect((await db.select().from(chatMessages).where(eq(chatMessages.id, m1.id)))[0].seen_at).toBeTruthy();
  });
});

describe("P10 the next-chat queue after Mila spoke (owner decision b)", () => {
  const queued = (key: string, extra: Record<string, unknown> = {}) => ({ id: randomUUID(), at: NOW.toISOString(), key, ...extra });
  async function chatSession(events: unknown[]) {
    await db.insert(milaTfSessions).values({ athlete_id: A, conversation_id: randomUUID(), tf_session_id: `tfs-${randomUUID()}`, pending_events: events });
  }
  const keysWaiting = async () => (await db.select().from(milaTfSessions).where(eq(milaTfSessions.athlete_id, A)))
    .flatMap((r) => (r.pending_events as any[]).map((e) => e.key)).sort();

  it("drops the same news from the queue once Mila's message is in the chat; other news stays", async () => {
    await chatSession([
      queued("deal_reply:d5", { kind: "deal_reply", dealId: "d5", brand: "Acme" }),
      queued("research_done:r1", { kind: "research_done", process: "signup_research", runId: "r1", newFacts: 2 }),
    ]);
    await db.insert(milaTfSessions).values({ athlete_id: B, conversation_id: randomUUID(), tf_session_id: "tfs-b", pending_events: [queued("deal_reply:d5", { kind: "deal_reply", dealId: "d5", brand: null })] });
    const id = await logEvent("brand_reply", "brand_reply:d5:m1", { dealId: "d5", label: "Acme", queueKey: "deal_reply:d5" });
    const runTurn = fakeTurn({ text: says("Acme replied. I drafted an answer.", ["deal:d5"]), cards: (r) => [actionCard(r)] });
    expect(await dispatch(id, { now: () => NOW, push: recorder().push, turn: { runTurn } })).toEqual({ outcome: "spoke" });
    expect(await keysWaiting()).toEqual(["research_done:r1"]);
    // Another athlete's queue is never touched.
    const [b] = await db.select().from(milaTfSessions).where(eq(milaTfSessions.athlete_id, B));
    expect((b.pending_events as any[]).map((e) => e.key)).toEqual(["deal_reply:d5"]);
  });

  it("keeps the queued news when Mila's turn sent nothing (SILENT) or could not run", async () => {
    await chatSession([queued("account_connected:c9", { kind: "account_connected", platform: "instagram", reconnected: false })]);
    const id = await logEvent("account_connected", "account_connected:c9", { facts: { platform: "instagram" }, queueKey: "account_connected:c9" });
    expect(await dispatch(id, { now: () => NOW, push: recorder().push, turn: { runTurn: fakeTurn({ text: "SILENT" }) } })).toEqual({ outcome: "silent" });
    const id2 = await logEvent("account_connected", "account_connected:c9b", { facts: { platform: "instagram" }, queueKey: "account_connected:c9" });
    expect(await dispatch(id2, { now: () => NOW, push: recorder().push, turn: { runTurn: fakeTurn({ text: "", throws: true }) } })).toEqual({ outcome: "turn_error" });
    expect(await keysWaiting()).toEqual(["account_connected:c9"]);
  });

  it("with MILA_PROACTIVE off, a connect is queued for the next chat exactly as before and nothing is logged", async () => {
    await chatSession([]);
    process.env.MILA_PROACTIVE = "false";
    try {
      expect(await noteAccountConnected(A, { platform: "instagram", reconnected: false, connectKey: "c10" })).toBe(true);
    } finally { process.env.MILA_PROACTIVE = "true"; }
    expect(await keysWaiting()).toEqual(["account_connected:c10"]);
    expect(await db.select().from(athleteEvents)).toEqual([]);
  });
});

describe("P11 the lock screen (owner decision c)", () => {
  const sent: PushMessage[][] = [];
  const fakeExpo: PushClient = {
    chunkPushNotifications: (m) => [m],
    sendPushNotificationsAsync: async (m) => { sent.push(m); return m.map(() => ({ status: "ok" as const, id: `t-${randomUUID()}` })); },
    chunkPushNotificationReceiptIds: (ids) => [ids],
    getPushNotificationReceiptsAsync: async () => ({}),
  };
  beforeAll(() => setPushClient(fakeExpo));
  afterAll(() => setPushClient(null));

  it("fixed words by default; Mila's first sentence only when they turned \"Show brand names\" on", async () => {
    process.env.PUSH_NOTIFICATIONS = "true";
    expect(await registerDevice(A, { token: "ExponentPushToken[proactive1111]", platform: "ios", timeZone: "UTC" })).toBe(true);
    const speak = (key: string) => logEvent("brand_reply", key, { dealId: key, label: "Acme" });
    // Each event gets its own words (the same words twice are never sent: P13).
    let n = 0;
    const runTurn = jest.fn(async () => {
      const runId = randomUUID();
      return { runId, text: says(`Acme asked for your rate for three posts. I drafted a reply${n++ ? " for you to check" : ""}.`, [`deal:brand_reply:lock${n}`]), status: "completed" as const, stopReason: null, cards: [actionCard(runId)], cost: {} as any, tools: [] };
    });
    const real ={ now: () => NOW, push: (a: string, e: PushEvent) => sendPush(a, e, { now: NOW }), turn: { runTurn } };

    expect(await dispatch(await speak("brand_reply:lock1"), real)).toEqual({ outcome: "spoke" });
    expect(sent.at(-1)![0]).toMatchObject({ title: "Mila", body: "A brand replied. Mila has the next step ready." });
    expect(sent.at(-1)![0].body).not.toContain("Acme");

    await writePreferences(A, { showBrandNames: true });
    expect(await dispatch(await speak("brand_reply:lock2"), real)).toEqual({ outcome: "spoke" });
    expect(sent.at(-1)![0]).toMatchObject({ title: "Mila", body: "Acme asked for your rate for three posts." });
    await writePreferences(A, { showBrandNames: false });
  });
});

// ─── The decision contract (owner-approved fix, 28 Oct 2026): fail closed, policy in code ──────────────────────────

describe("P12 an invalid or ungrounded decision fails closed: no message, no push (not even the fallback)", () => {
  const fallbackPush: PushEvent = { kind: "brand_reply", dedupeKey: "brand_reply:x", title: "A brand replied", body: "Open Nomila to read it.", target: { screen: "opportunities" } };
  it.each([
    ["prose with no decision (the T8 failure)", "Acme sent a newsletter. No action needed.", "no_decision"],
    ["a broken block", "```json\n{\"decision\": \"SPEAK\", \n```", "malformed"],
    ["SPEAK with no evidence", says("Acme replied. I drafted an answer.", []), "ungrounded"],
    ["SPEAK citing another deal", says("Acme replied. I drafted an answer.", ["deal:someone-elses"]), "ungrounded"],
    ["SPEAK with a card it never made", says("Acme replied. I drafted an answer.", ["deal:d12"], { cards: ["invented-card"] }), "bad_card_ref"],
  ])("%s", async (_n, text, outcome) => {
    const p = recorder();
    const id = await logEvent("brand_reply", `brand_reply:d12:${randomUUID()}`, { dealId: "d12", fallbackPush });
    expect(await dispatch(id, { now: () => NOW, push: p.push, turn: { runTurn: fakeTurn({ text, cards: (r) => [actionCard(r)] }) } })).toEqual({ outcome });
    expect(await db.select().from(chatMessages)).toEqual([]);
    expect(p.sent).toEqual([]);
    expect((await eventRow(id)).dispatched_at).toBeTruthy();
  });
});

describe("P13 duplicates", () => {
  it("the same source event twice is one event and one run", async () => {
    const start = jest.fn(async () => undefined);
    const e = { athleteId: A, kind: "payment_received" as const, dedupeKey: "payment_received:dup", payload: {} };
    expect(await emitAthleteEvent(e, { start })).toBeTruthy();
    expect(await emitAthleteEvent(e, { start })).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("the same words already in their chats are not sent again", async () => {
    const p = recorder();
    const runTurn = fakeTurn({ text: says("Acme paid you $500.", ["event:payment_received"]) });
    const one = await logEvent("payment_received", "payment_received:t11", {});
    expect(await dispatch(one, { now: () => NOW, push: p.push, turn: { runTurn } })).toEqual({ outcome: "spoke" });
    const two = await logEvent("payment_received", "payment_received:t12", {});
    expect(await dispatch(two, { now: () => new Date(NOW.getTime() + 60_000), push: p.push, turn: { runTurn: fakeTurn({ text: says("acme paid you $500!", ["event:payment_received"]) }) } })).toEqual({ outcome: "duplicate" });
    expect(await db.select().from(chatMessages)).toHaveLength(1);
    expect(p.sent).toHaveLength(1);
  });
});

describe("P14 their switches and quiet hours (the message still waits in the chat)", () => {
  afterEach(async () => { await writePreferences(A, { enabled: true, brandReply: true, quietHours: true, quietStart: 22 * 60, quietEnd: 8 * 60 }); });
  it("quiet hours on their clock: no push", async () => {
    await writePreferences(A, { quietHours: true, quietStart: 14 * 60, quietEnd: 16 * 60 });   // NOW is 15:00 UTC
    const p = recorder();
    const id = await logEvent("payment_received", "payment_received:q1", {});
    expect(await dispatch(id, { now: () => NOW, push: p.push, turn: { runTurn: fakeTurn({ text: says("You got paid.", ["event:payment_received"]) }) } })).toEqual({ outcome: "spoke_quiet_hours" });
    expect(p.sent).toEqual([]);
    expect(await db.select().from(chatMessages)).toHaveLength(1);
  });
  it("their switch for this kind is off: no push", async () => {
    await writePreferences(A, { brandReply: false });
    const p = recorder();
    const id = await logEvent("payment_received", "payment_received:q2", {});
    expect(await dispatch(id, { now: () => NOW, push: p.push, turn: { runTurn: fakeTurn({ text: says("You got paid again.", ["event:payment_received"]) }) } })).toEqual({ outcome: "spoke_push_off" });
    expect(p.sent).toEqual([]);
  });
  it("MILA_PROACTIVE switched off after the event was logged: no turn, the source's own push", async () => {
    const fb: PushEvent = { kind: "brand_reply", dedupeKey: "brand_reply:off", title: "A brand replied", body: "Open Nomila to read it.", target: { screen: "opportunities" } };
    const id = await logEvent("brand_reply", "brand_reply:d14:m1", { dealId: "d14", fallbackPush: fb });
    const p = recorder();
    const runTurn = fakeTurn({ text: says("x", ["deal:d14"]) });
    process.env.MILA_PROACTIVE = "false";
    try {
      expect(await dispatch(id, { now: () => NOW, push: p.push, turn: { runTurn } })).toEqual({ outcome: "flag_off_fallback_sent" });
    } finally { process.env.MILA_PROACTIVE = "true"; }
    expect(runTurn).not.toHaveBeenCalled();
    expect(p.sent.map((s) => s.e)).toEqual([fb]);
  });
});

describe("P15 DEFER: one re-check per event, never a loop", () => {
  const deferring = (why = "missing_dependency") => fakeTurn({ text: decision({ decision: "DEFER", defer: { why, after_minutes: 45 } }) });
  it("schedules one re-check; the re-check can speak", async () => {
    const p = recorder();
    const rechecks: Array<{ eventId: string; at: Date }> = [];
    const recheck = async (_a: string, eventId: string, at: Date) => { rechecks.push({ eventId, at }); };
    const id = await logEvent("payment_received", "payment_received:d1", {});
    expect(await dispatch(id, { now: () => NOW, push: p.push, recheck, turn: { runTurn: deferring() } })).toEqual({ outcome: "deferred" });
    expect(rechecks).toEqual([{ eventId: id, at: new Date(NOW.getTime() + 45 * 60_000) }]);
    const ev = await eventRow(id);
    expect(ev.dispatched_at).toBeNull();
    expect(ev.outcome).toBe("deferred");
    expect(await db.select().from(chatMessages)).toEqual([]);
    expect(p.sent).toEqual([]);
    // The re-check run (workflow input recheck: true).
    const later = new Date(NOW.getTime() + 46 * 60_000);
    const d = await decideStep(A, id, { now: () => later });
    expect(d).toEqual({ done: false });
    const s = await speakStep(A, id, { now: () => later, push: p.push, recheck, turn: { runTurn: fakeTurn({ text: says("The payment cleared.", ["event:payment_received"]) }) } }, { recheck: true });
    expect(s.spoke).toBe(true);
    expect(rechecks).toHaveLength(1);
  });
  it("a second DEFER (the re-check, or a repeated run) ends it closed: nothing sent", async () => {
    const p = recorder();
    const rechecks: string[] = [];
    const recheck = async (_a: string, eventId: string) => { rechecks.push(eventId); };
    const id = await logEvent("payment_received", "payment_received:d2", {});
    expect(await dispatch(id, { now: () => NOW, push: p.push, recheck, turn: { runTurn: deferring("better_time") } })).toEqual({ outcome: "deferred" });
    // A repeated (non-re-check) run asks again: still only one defer.
    expect(await speakStep(A, id, { now: () => NOW, push: p.push, recheck, turn: { runTurn: deferring() } })).toEqual({ spoke: false, outcome: "defer_exhausted" });
    expect(rechecks).toHaveLength(1);
    expect((await eventRow(id)).dispatched_at).toBeTruthy();
    const id2 = await logEvent("payment_received", "payment_received:d3", {});
    await decideStep(A, id2, { now: () => NOW });
    expect(await speakStep(A, id2, { now: () => NOW, push: p.push, recheck, turn: { runTurn: deferring() } }, { recheck: true })).toEqual({ spoke: false, outcome: "defer_exhausted" });
    expect(await db.select().from(chatMessages)).toEqual([]);
    expect(p.sent).toEqual([]);
  });
  it("a turn refused by the turn cap defers once; capped again on the re-check, the news still goes out as the fallback push", async () => {
    const p = recorder();
    const fb: PushEvent = { kind: "payment_received", dedupeKey: "payment_received:cap1", title: "Payment received", body: "Open Nomila to see it.", target: { screen: "opportunities" } } as PushEvent;
    const capped = jest.fn(async () => ({ runId: randomUUID(), text: "", status: "stopped" as const, stopReason: "policy" as const, cards: [], cost: {} as any, tools: [], turnCap: true }));
    const rechecks: string[] = [];
    const recheck = async (_a: string, eventId: string) => { rechecks.push(eventId); };
    const id = await logEvent("payment_received", "payment_received:cap1", { fallbackPush: fb });
    expect(await dispatch(id, { now: () => NOW, push: p.push, recheck, turn: { runTurn: capped } })).toEqual({ outcome: "deferred" });
    expect(p.sent).toEqual([]);
    const s = await speakStep(A, id, { now: () => NOW, push: p.push, recheck, turn: { runTurn: capped } }, { recheck: true });
    expect(s).toEqual({ spoke: false, outcome: "turn_capped_fallback_sent" });
    expect(p.sent).toEqual([{ athleteId: A, e: fb }]);
    expect(rechecks).toHaveLength(1);
    expect(await db.select().from(chatMessages)).toEqual([]);
    // And when the re-check cannot even be scheduled.
    const p2 = recorder();
    const id2 = await logEvent("payment_received", "payment_received:cap2", { fallbackPush: { ...fb, dedupeKey: "payment_received:cap2" } });
    expect(await dispatch(id2, { now: () => NOW, push: p2.push, recheck: async () => { throw new Error("runner down"); }, turn: { runTurn: capped } })).toEqual({ outcome: "turn_capped_fallback_sent" });
    expect(p2.sent).toHaveLength(1);
  });
  it("a re-check that cannot be scheduled ends it closed", async () => {
    const id = await logEvent("payment_received", "payment_received:d4", {});
    expect(await dispatch(id, { now: () => NOW, push: recorder().push, recheck: async () => { throw new Error("runner down"); }, turn: { runTurn: deferring() } })).toEqual({ outcome: "defer_unscheduled" });
  });
});

describe("P16 a suspected scam (policy: never engage; a warning is chat-only)", () => {
  it("an endorsement of a flagged email is refused; nothing sent", async () => {
    const p = recorder();
    const id = await logEvent("deal_new", "deal_new:scam1", { dealId: "scam1", facts: { suspectedScam: true } });
    const runTurn = fakeTurn({ text: says("You won a $500 gift card! I drafted a reply to claim it.", ["deal:scam1"]), cards: (r) => [actionCard(r)] });
    expect(await dispatch(id, { now: () => NOW, push: p.push, turn: { runTurn } })).toEqual({ outcome: "endorses_scam" });
    expect(await db.select().from(chatMessages)).toEqual([]);
    expect(p.sent).toEqual([]);
  });
  it("a warning lands in the chat with no card and no notification", async () => {
    const p = recorder();
    const id = await logEvent("deal_new", "deal_new:scam2", { dealId: "scam2", facts: { suspectedScam: true } });
    const runTurn = fakeTurn({ text: says("This prize email looks like a scam: it asks for your bank details. Don't click it.", ["deal:scam2"], { risk: "suspected_scam" }), cards: (r) => [actionCard(r)] });
    expect(await dispatch(id, { now: () => NOW, push: p.push, turn: { runTurn } })).toEqual({ outcome: "spoke_warning_in_chat" });
    const [m] = await db.select().from(chatMessages);
    expect(m.agent_cards).toBeNull();
    expect(p.sent).toEqual([]);
  });
});
