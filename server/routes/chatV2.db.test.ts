/**
 * chatV2.db.test.ts — POST /api/v1/me/chat/v2 (MILA_CHAT_V2) end to end on PGlite: the real route, the REAL Mastra
 * Agent loop with a scripted model (testUtils/mastraScripted.ts; no provider, no network), our real tools in-process,
 * the real approval queue and approve route. Test athlete dd1a8a80-…; everyone else is made up.
 *
 *   V1  auth: no session ⇒ 401 (the real requireAuth)
 *   V2  the flag off ⇒ not mounted (404); on ⇒ mounted
 *   V3  (retired: the engine precondition went with the engine switch, Mastra-only PR 2; every turn is a Mastra turn)
 *   V4  the stream: AI SDK v7 headers and framing; text, status lines and the approval card (with its pendingActionId,
 *       before the text, as soon as its tool ended); start/done carry the run id; client history, ids, tools and
 *       state ignored; NO tool arguments or results anywhere in the bytes; the reply saved
 *   V5  the card's tap through the existing approve route runs once (409 on the second tap)
 *   V6  a foreign conversation id: this athlete's own new row and thread, nothing of the other's
 *   V7  the client leaves mid-turn: the turn finishes and is saved; the run status says so
 *   V8  run status: the owner sees it, another athlete gets 404
 *   V9  Stop: the run stops (stopped / aborted), a second Stop is 409
 *   V10 v1's Stop (POST /me/chat/stop): stops a v1 turn on the Mastra engine (a dropped fetch alone does not); only
 *       the caller's own turns
 *   V11 attachments: ids of her own stored media (v1's shape and checks), shown to Mila (the photo reaches the model); attachment-only reads "Take a look at this.";
 *       another athlete's, a deleted or an unknown asset is a 404 for the whole turn; a bad shape is a 400
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => {
  const actual = jest.requireActual("../lib/auth");
  return {
    ...actual,
    requireAuth: (req: any, res: any, next: any) => {
      if ((globalThis as any).__REAL_AUTH) return actual.requireAuth(req, res, next);
      req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next();
    },
  };
});
jest.mock("../agent/engine/mastra/runtime", () => ({
  ...jest.requireActual("../agent/engine/mastra/runtime"),
  mastraRuntime: async () => (globalThis as any).__MASTRA_RT,
}));
jest.mock("../services/push/events", () => ({ pushWaiting: jest.fn() }));
// The attachment step reads her media: never GCS here. A small JPEG made at call time stands in for every object.
jest.mock("../lib/mediaStore", () => ({
  ...jest.requireActual("../lib/mediaStore"),
  readObject: jest.fn(async () => ({
    buf: await require("sharp")({ create: { width: 64, height: 48, channels: 3, background: { r: 10, g: 120, b: 200 } } }).jpeg().toBuffer(),
    contentType: "image/jpeg",
  })),
  signedUrl: jest.fn(async () => { throw new Error("tests never sign GCS URLs"); }),
}));
jest.mock("../lib/integrations/gmail", () => ({ fetchMessageThreadingInfo: jest.fn(), sendGmailReply: jest.fn() }));
jest.mock("../lib/integrations/instagram", () => ({ sendInstagramDM: jest.fn() }));
jest.mock("../skills/threadSummarizer", () => ({ summarizeThread: jest.fn(async () => null), updateMechanicalThreadState: jest.fn(async () => undefined) }));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agentRuns, chatMessages, mediaAssets, milaTfSessions, pendingActions } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { scriptedModel, testRuntime, type ScriptedStep } from "../testUtils/mastraScripted";
import { dbStore } from "../agent/research/dbStore";
import { clearJobCache } from "../agent/jobs";
import { ALLOWED_PART_TYPES } from "../agent/engine/mastra/chatV2Stream";
import pendingActionsRouter from "./pendingActions";
import chatRouter from "./chat";
import { mountChatV2 } from "./chatV2";
import { MILA_TURN } from "../agent/engine/config";
import { registerDevice, setPushClient, writePreferences, type PushClient, type PushMessage } from "../services/push/push";

const TEST_ATHLETE = "dd1a8a80-d31b-423a-a572-9d146716cb0f";
const KEY = "chat-v2-db-test-pass-key-0123456789-0123456789";
const ENV = ["NOMILA_MCP_PASS_KEY", "MILA_CHAT_V2"] as const;
const saved: Record<string, string | undefined> = {};
let server: Server;
let base: string;
let A = "";
let B = "";

const as = (id: string) => { (globalThis as any).__TEST_ATHLETE_ID = id; };
/** Expo's push service, mocked (tests never reach Expo): what the reply-ready push sent. */
const sentPushes: PushMessage[] = [];
const fakePush: PushClient = {
  chunkPushNotifications: (m) => [m],
  sendPushNotificationsAsync: async (m) => { sentPushes.push(...m); return m.map((_, i) => ({ status: "ok" as const, id: `t-${i}` })); },
  chunkPushNotificationReceiptIds: (ids) => [ids],
  getPushNotificationReceiptsAsync: async () => ({}),
};
async function script(steps: ScriptedStep[]) {
  const m = scriptedModel(steps);
  (globalThis as any).__MASTRA_RT = await testRuntime(m.model);
  return m;
}

type Frame = Record<string, any>;
const framesOf = (raw: string): Array<Frame | "[DONE]"> =>
  raw.split("\n\n").map((b) => b.split("\n").find((l) => l.startsWith("data: "))).filter(Boolean)
    .map((l) => (l === "data: [DONE]" ? "[DONE]" : JSON.parse(l!.slice(6))));

async function chat(body: unknown) {
  const res = await fetch(`${base}/api/v1/me/chat/v2`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const raw = await res.text();
  return { res, raw, frames: res.ok ? framesOf(raw) : [], json: res.ok ? null : JSON.parse(raw || "null") };
}
const parts = (frames: Array<Frame | "[DONE]">) => frames.filter((f): f is Frame => f !== "[DONE]");

async function runStatus(runId: string) {
  const res = await fetch(`${base}/api/v1/me/chat/v2/runs/${runId}`);
  return { status: res.status, json: await res.json() };
}
async function waitForRun(runId: string, until: (s: string) => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const r = await runStatus(runId);
    if (until(r.json.status) || Date.now() > end) return r;
    await new Promise((res) => setTimeout(res, 50));
  }
}
/** Starts a turn and reads until the start part (the run id), leaving the response open. */
async function startTurn(body: unknown) {
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/v1/me/chat/v2`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error("stream ended before the start part");
    buf += dec.decode(value, { stream: true });
    const start = parts(framesOf(buf)).find((p) => p.type === "start");
    if (start) return { ctl, reader, runId: start.messageMetadata.runId as string };
  }
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.NOMILA_MCP_PASS_KEY = KEY;
  process.env.MILA_CHAT_V2 = "true";
  await initTestDb();
  A = await seedAthlete("Test Athlete", { id: TEST_ATHLETE } as never);
  B = await seedAthlete("Other Person");
  await dbStore.insertFacts(A, [
    { subject: { kind: "athlete", name: "Test Athlete" }, claim: "Test Athlete races keelboats for Tidewater-Q9 club.", type: "found", source: { url: "https://example.org/club" }, date: "2026-09-01", confidence: 0.9, runId: null },
  ]);
  const app = express();
  app.use(express.json());
  expect(mountChatV2(app)).toBe(true);
  app.use("/api/v1", pendingActionsRouter);
  app.use("/api/v1/me", chatRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await closeTestDb();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});
beforeEach(() => { clearJobCache(); as(A); (globalThis as any).__REAL_AUTH = false; });

describe("V1–V3: who and when", () => {
  it("V1 no session ⇒ 401", async () => {
    (globalThis as any).__REAL_AUTH = true;
    const r = await chat({ message: { text: "hi" } });
    expect(r.res.status).toBe(401);
  });

  it("V2 the flag off ⇒ not mounted", async () => {
    process.env.MILA_CHAT_V2 = "false";
    const app = express();
    app.use(express.json());
    expect(mountChatV2(app)).toBe(false);
    const s: Server = await new Promise((resolve) => { const x = app.listen(0, () => resolve(x)); });
    const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/v1/me/chat/v2`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: { text: "hi" } }) });
    expect(res.status).toBe(404);
    await new Promise<void>((r) => s.close(() => r()));
    process.env.MILA_CHAT_V2 = "true";
  });

  it("a bad body is a 400", async () => {
    expect((await chat({ message: "plain string" })).res.status).toBe(400);
    expect((await chat({ conversationId: "not-a-uuid", message: { text: "hi" } })).res.status).toBe(400);
    expect((await chat({ message: { text: "   " } })).res.status).toBe(400);
  });
});

describe("V4–V5: the stream and the approval card", () => {
  const CONV = randomUUID();
  let pendingId = "";

  it("V4 streams text, status lines and the card; nothing raw; client history ignored", async () => {
    const m = await script([
      { tools: [{ name: "recall_facts", args: { query: "zephyr-77 keelboats" } }, { name: "remember_preference", args: { kind: "style", statement: "Afternoon shoots only." } }] },
      { text: ["Want me to ", "save that?"] },
    ]);
    const r = await chat({
      conversationId: CONV,
      id: "client-chat-id-HIST",
      message: { id: "client-msg-id-HIST", text: "Please remember I only shoot in the afternoon." },
      messages: [{ id: "m0", role: "user", parts: [{ type: "text", text: "HISTORY-SECRET-1 from the client" }] }],
      tools: { evil: {} }, state: { approved: true }, context: { athleteId: B },
    });
    expect(r.res.status).toBe(200);
    expect(r.res.headers.get("content-type")).toContain("text/event-stream");
    expect(r.res.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    expect(r.frames[r.frames.length - 1]).toBe("[DONE]");

    const ps = parts(r.frames);
    for (const p of ps) expect(ALLOWED_PART_TYPES.has(p.type)).toBe(true);
    expect(ps[0].type).toBe("start");
    const runId = ps[0].messageMetadata.runId;
    expect(ps[0].messageId).toBe(runId);

    expect(ps.filter((p) => p.type === "text-delta").map((p) => p.delta).join("")).toBe("Want me to save that?");
    const labels = ps.filter((p) => p.type === "data-mila-status").map((p) => p.data.label);
    expect(labels).toEqual(expect.arrayContaining(["Checking what I know…", "Getting that ready to save…", "Thinking…"]));

    const cards = ps.filter((p) => p.type === "data-mila-card");
    const action = cards.find((c) => c.data.type === "action");
    expect(action).toBeTruthy();
    const [row] = await db.select().from(pendingActions).where(eq(pendingActions.athlete_id, A));
    pendingId = row.id;
    expect(action!.data.data.fields).toMatchObject({ pendingActionId: row.id, state: "needs_approval", verb: "save_memory" });
    // as soon as its tool ended: before the answer text
    expect(ps.indexOf(action!)).toBeLessThan(ps.findIndex((p) => p.type === "text-start"));
    expect(cards.map((c) => c.id)).toEqual([...new Set(cards.map((c) => c.id))]);

    const done = ps.find((p) => p.type === "data-mila-done")!;
    const rows = await db.select().from(chatMessages).where(and(eq(chatMessages.athlete_id, A), eq(chatMessages.conversation_id, CONV)));
    expect(rows.map((x) => x.role)).toEqual(["user", "assistant"]);
    expect(rows[0].content).toBe("Please remember I only shoot in the afternoon.");
    expect(done.data).toEqual({ runId, status: "completed", stopReason: null, messageIds: [String(rows[1].id)] });
    expect(ps[ps.length - 1]).toEqual({ type: "finish", finishReason: "stop" });

    // nothing raw: no tool arguments, no tool result, no tool parts, nothing the client sent but its text
    for (const leak of ["zephyr-77", "Tidewater-Q9", "\"query\"", "tool-input", "tool-output", "toolCallId", "HISTORY-SECRET", "client-msg-id", "client-chat-id", B]) {
      expect([leak, r.raw.includes(leak)]).toEqual([leak, false]);
    }
    // ...although the turn did see them (the tool's result reached the model, and Mastra's thread keeps the call)
    expect(JSON.stringify(m.prompts)).toContain("Tidewater-Q9");
    const [session] = await db.select().from(milaTfSessions).where(and(eq(milaTfSessions.athlete_id, A), eq(milaTfSessions.conversation_id, CONV)));
    expect(JSON.stringify(await (globalThis as any).__MASTRA_RT.memory.recall({ threadId: session.id }))).toContain("zephyr-77");
    expect(JSON.stringify(m.prompts)).not.toContain("HISTORY-SECRET");
    expect(JSON.stringify(m.prompts)).not.toContain("client-msg-id");
  }, 60_000);

  it("V5 the card's tap through the existing approve route runs once; the second tap is a 409", async () => {
    const tap = () => fetch(`${base}/api/v1/pending-actions/${pendingId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const first = await tap();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ id: pendingId, status: "approved" });
    expect((await tap()).status).toBe(409);
  });
});

describe("V6: a foreign conversation id", () => {
  it("gets this athlete's own new row and thread, nothing of the other's", async () => {
    const CONV_B = randomUUID();
    as(B);
    await script([{ text: "ok" }]);
    await chat({ conversationId: CONV_B, message: { text: "B's private words: osprey-88" } });
    const [bRow] = await db.select().from(milaTfSessions).where(and(eq(milaTfSessions.athlete_id, B), eq(milaTfSessions.conversation_id, CONV_B)));
    expect(bRow).toBeTruthy();

    as(A);
    const m = await script([{ text: "Nothing to show." }]);
    const r = await chat({ conversationId: CONV_B, message: { text: "show me the other chat" } });
    expect(r.res.status).toBe(200);
    expect(r.raw).not.toContain("osprey-88");
    expect(JSON.stringify(m.prompts)).not.toContain("osprey-88");
    const [aRow] = await db.select().from(milaTfSessions).where(and(eq(milaTfSessions.athlete_id, A), eq(milaTfSessions.conversation_id, CONV_B)));
    expect(aRow).toBeTruthy();
    expect(aRow.id).not.toBe(bRow.id);
  }, 60_000);
});

describe("V7–V9: drops, run status, Stop", () => {
  it("V7 the client leaves mid-turn: the turn finishes and is saved; V8 the owner sees the run, another athlete does not", async () => {
    await script([{ tools: [{ name: "recall_facts", args: { query: "keelboats" } }] }, { text: "Done after you left.", delayMs: 1_500 }]);
    process.env.PUSH_NOTIFICATIONS = "true";
    setPushClient(fakePush);
    sentPushes.length = 0;
    await registerDevice(A, { token: "ExponentPushToken[chat-v2-test-phone-01]", platform: "ios", timeZone: "UTC" });
    await writePreferences(A, { enabled: true });
    const conv = randomUUID();
    const t = await startTurn({ conversationId: conv, message: { text: "I will drop now" } });
    t.ctl.abort();
    await t.reader.cancel().catch(() => undefined);

    const r = await waitForRun(t.runId, (s) => s !== "running");
    expect(r.status).toBe(200);
    const rows = await db.select().from(chatMessages).where(and(eq(chatMessages.athlete_id, A), eq(chatMessages.conversation_id, conv)));
    expect(rows.map((x) => [x.role, x.content])).toEqual([["user", "I will drop now"], ["assistant", "Done after you left."]]);
    expect(r.json).toEqual({ runId: t.runId, status: "completed", messageIds: [String(rows[1].id)], conversationId: conv, turnTimeoutMs: MILA_TURN.timeoutMs });
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, t.runId));
    expect(run.cost_micro_usd).toBeGreaterThan(0);

    // The phone had left: one "your reply is ready" push, opening that conversation on the saved reply (Expo mocked).
    // (It is sent just after the run is marked ended.)
    const pushBy = Date.now() + 5_000;
    while (!sentPushes.length && Date.now() < pushBy) await new Promise((res) => setTimeout(res, 20));
    delete process.env.PUSH_NOTIFICATIONS;
    setPushClient(null);
    expect(sentPushes.map((m) => [m.body, m.data])).toEqual([["Your reply is ready.", { kind: "mila_reply", target: { screen: "mila", id: conv, messageId: String(rows[1].id) } }]]);

    as(B);
    expect((await runStatus(t.runId)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/me/chat/v2/runs/${t.runId}/stop`, { method: "POST" })).status).toBe(404);
    as(A);
    expect((await runStatus("not-a-uuid")).status).toBe(404);
  }, 60_000);

  it("V9 Stop: the running turn stops (stopped / aborted); a second Stop is a 409", async () => {
    await script([{ text: "too late", delayMs: 8_000 }]);
    const t = await startTurn({ conversationId: randomUUID(), message: { text: "a slow one" } });
    // the run holds its conversation once it has claimed it
    const end = Date.now() + 10_000;
    while (Date.now() < end) {
      const [held] = await db.select({ id: milaTfSessions.id }).from(milaTfSessions).where(eq(milaTfSessions.running_run_id, t.runId));
      if (held) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    // While running, the status says how long the phone may wait: the engine's turn timeout and how far in it is.
    const live = await runStatus(t.runId);
    expect(live.json).toMatchObject({ status: "running", turnTimeoutMs: MILA_TURN.timeoutMs });
    expect(live.json.runningForMs).toBeGreaterThanOrEqual(0);
    expect(live.json.runningForMs).toBeLessThan(MILA_TURN.timeoutMs);
    const t0 = Date.now();
    const stop = await fetch(`${base}/api/v1/me/chat/v2/runs/${t.runId}/stop`, { method: "POST" });
    expect(stop.status).toBe(202);
    const r = await waitForRun(t.runId, (s) => s !== "running");
    expect(Date.now() - t0).toBeLessThan(6_000);
    expect(r.json).toMatchObject({ status: "stopped", stopReason: "aborted" });
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, t.runId));
    expect(run.error).toBe("stopped");
    expect((await fetch(`${base}/api/v1/me/chat/v2/runs/${t.runId}/stop`, { method: "POST" })).status).toBe(409);
    await t.reader.cancel().catch(() => undefined);
  }, 60_000);

  it("V9 a Stop the moment the run id arrives (before the turn claimed its conversation) still stops it", async () => {
    const m = await script([{ text: "too late", delayMs: 8_000 }]);
    const t = await startTurn({ conversationId: randomUUID(), message: { text: "stop me at once" } });
    expect((await fetch(`${base}/api/v1/me/chat/v2/runs/${t.runId}/stop`, { method: "POST" })).status).toBe(202);
    const r = await waitForRun(t.runId, (s) => s !== "running");
    expect(r.json).toMatchObject({ status: "stopped", stopReason: "aborted" });
    expect(m.calls).toBeLessThanOrEqual(1);
    await t.reader.cancel().catch(() => undefined);
  }, 60_000);
});

describe("V10: v1's Stop on the Mastra engine", () => {
  const stopV1 = (body: unknown) => fetch(`${base}/api/v1/me/chat/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("stops the v1 turn; another athlete's Stop stops nothing; a bad body is a 400", async () => {
    await script([{ text: "too late", delayMs: 8_000 }]);
    const conv = randomUUID();
    const ctl = new AbortController();
    const res = await fetch(`${base}/api/v1/me/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "a slow v1 one", conversation_id: conv }), signal: ctl.signal });
    expect(res.status).toBe(200);
    let runId: string | undefined;
    for (const end = Date.now() + 10_000; !runId && Date.now() < end;) {
      runId = (await db.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.athlete_id, A), eq(agentRuns.conversation_id, conv))))[0]?.id;
      if (!runId) await new Promise((r) => setTimeout(r, 20));
    }
    expect(runId).toBeTruthy();
    // What v1 Stop used to be on its own: the fetch dropped. The turn carries on (decision 4)...
    ctl.abort();
    await new Promise((r) => setTimeout(r, 200));
    expect((await runStatus(runId!)).json.status).toBe("running");

    as(B);
    expect(await (await stopV1({ conversation_id: conv })).json()).toEqual({ stopped: 0 });
    as(A);
    expect((await stopV1({ conversation_id: "nope" })).status).toBe(400);
    // ...so Stop asks the server.
    const t0 = Date.now();
    const stop = await stopV1({ conversation_id: conv });
    expect(stop.status).toBe(202);
    expect(await stop.json()).toEqual({ stopped: 1 });
    const r = await waitForRun(runId!, (st) => st !== "running");
    expect(Date.now() - t0).toBeLessThan(6_000);
    expect(r.json).toMatchObject({ status: "stopped", stopReason: "aborted" });
    expect(await (await stopV1({ conversation_id: conv })).json()).toEqual({ stopped: 0 });
  }, 60_000);
});

describe("V11: attachments (the composer's ＋), as POST /me/chat takes them", () => {
  const asset = async (athleteId: string, extra: Record<string, unknown> = {}) => {
    const [r] = await db.insert(mediaAssets).values({
      athlete_id: athleteId, platform: "upload", origin: "upload", media_type: "IMAGE", status: "stored",
      gcs_path: `athletes/${athleteId}/${randomUUID()}.jpg`, content_type: "image/jpeg", ...extra,
    } as never).returning({ id: mediaAssets.id });
    return r.id as string;
  };
  const turnsIn = (conv: string) => db.select().from(chatMessages)
    .where(and(eq(chatMessages.athlete_id, A), eq(chatMessages.conversation_id, conv)));

  it("her own uploaded media: the turn runs, with her text, and Mila is shown the photo", async () => {
    const mine = await asset(A);
    const m = await script([{ text: ["Nice shot."] }]);
    const conv = randomUUID();
    const r = await chat({ conversationId: conv, message: { text: "What do you think of this?", attachments: [{ asset_id: mine, role: "photo" }] } });
    expect(r.res.status).toBe(200);
    const sent = (m.prompts[0] as Array<{ role: string; content: unknown }>).flatMap((x) => (Array.isArray(x.content) ? x.content : [])) as Array<{ type: string; mediaType?: string }>;
    expect(sent.filter((x) => x.type === "file" && x.mediaType === "image/jpeg")).toHaveLength(1);
    expect(parts(r.frames).find((p) => p.type === "data-mila-done")!.data.status).toBe("completed");
    expect((await turnsIn(conv)).map((x) => [x.role, x.content])).toEqual([["user", "What do you think of this?"], ["assistant", "Nice shot."]]);
  }, 60_000);

  it("attachments only (no text): the turn reads \"Take a look at this.\"", async () => {
    const mine = await asset(A);
    await script([{ text: ["Got it."] }]);
    const conv = randomUUID();
    const r = await chat({ conversationId: conv, message: { text: "", attachments: [{ asset_id: mine, role: "product" }] } });
    expect(r.res.status).toBe(200);
    expect((await turnsIn(conv))[0].content).toBe("Take a look at this.");
  }, 60_000);

  it("another athlete's asset, a deleted one or an unknown id refuses the whole turn (404), and no turn runs", async () => {
    const theirs = await asset(B);
    const gone = await asset(A, { deleted_at: new Date() });
    const before = (await db.select().from(agentRuns).where(eq(agentRuns.athlete_id, A))).length;
    for (const id of [theirs, gone, randomUUID()]) {
      const r = await chat({ message: { text: "look", attachments: [{ asset_id: id, role: "photo" }] } });
      expect(r.res.status).toBe(404);
      expect(r.json).toEqual({ error: "Attachment not found in your library" });
    }
    expect((await db.select().from(agentRuns).where(eq(agentRuns.athlete_id, A))).length).toBe(before);
  });

  // (Blank text with no attachments is the 400 in "a bad body is a 400"; the per-minute chat limiter caps how many more
  // requests this suite may make.)
  it("a bad shape is a 400 (not an array, a bad role, not a uuid, more than 4, the wrong key)", async () => {
    const mine = await asset(A);
    const one = { asset_id: mine, role: "photo" };
    for (const attachments of [
      "plain", [{ asset_id: mine, role: "contract" }], [{ asset_id: "not-a-uuid", role: "photo" }],
      [one, one, one, one, one], [{ assetId: mine, role: "photo" }],
    ]) {
      const r = await chat({ message: { text: "look", attachments } });
      expect([JSON.stringify(attachments), r.res.status]).toEqual([JSON.stringify(attachments), 400]);
    }
  });
});
