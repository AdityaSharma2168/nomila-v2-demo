/**
 * chatV2.client.db.test.ts — the CONTRACT between chat v2's server and the app: the real route
 * (POST /api/v1/me/chat/v2, the real Mastra loop on a scripted model — no provider, no network — real tools, PGlite)
 * read by the APP's own code (client/components/mila/thread/api.ts: assistant-ui's AssistantChatTransport over the
 * AI SDK's SSE parser and UI message chunk schema, then readUIMessageStream — exactly what useChat runs on the phone).
 *
 *   C1 the app's transport sends only { conversationId, message: { text } }; it parses every part the server writes;
 *      text arrives, the status parts are the fixed lines, the approval card is a checked DTO, data-mila-done arrives;
 *      no tool arguments or results reach the app
 *   C2 the run status and the saved turns, read through the app's calls (getRun, loadConversation)
 *   C3 Stop through the app's call (stopRun) stops a slow second turn; the run says stopped
 *   C4 her attachments go up through the app's transport as { asset_id, role } only, and the route takes them
 * Test athlete dd1a8a80-…; everyone else is made up.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => {
  const actual = jest.requireActual("../lib/auth");
  return { ...actual, requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); } };
});
jest.mock("../agent/engine/mastra/runtime", () => ({
  ...jest.requireActual("../agent/engine/mastra/runtime"),
  mastraRuntime: async () => (globalThis as any).__MASTRA_RT,
}));
jest.mock("../services/push/events", () => ({ pushWaiting: jest.fn() }));
// The turn's attachment step reads her media: never GCS here (an absent object is a noted, unread attachment).
jest.mock("../lib/mediaStore", () => ({
  ...jest.requireActual("../lib/mediaStore"),
  readObject: jest.fn(async () => null),
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
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { mediaAssets } from "../../shared/schema";
import { scriptedModel, testRuntime, type ScriptedStep } from "../testUtils/mastraScripted";
import { dbStore } from "../agent/research/dbStore";
import { clearJobCache } from "../agent/jobs";
import { THINKING_STATUS, TOOL_STATUS_FALLBACK, TOOL_STATUS_LABELS } from "../agent/engine/toolStatus";
import pendingActionsRouter from "./pendingActions";
import conversationsRouter from "./conversations";
import { mountChatV2 } from "./chatV2";
import { createMilaApi, sendAndCollect, type FetchLike } from "../../client/components/mila/thread/api";
import { cardsOf, doneOf, textOf } from "../../client/components/mila/thread/wire";

const TEST_ATHLETE = "dd1a8a80-d31b-423a-a572-9d146716cb0f";
const KEY = "chat-v2-client-test-pass-key-0123456789-0123456789";
const ENV = ["NOMILA_MCP_PASS_KEY", "MILA_CHAT_V2"] as const;
const saved: Record<string, string | undefined> = {};
let server: Server;
let base = "";
const sentBodies: string[] = [];

async function script(steps: ScriptedStep[]) {
  const m = scriptedModel(steps);
  (globalThis as any).__MASTRA_RT = await testRuntime(m.model);
  return m;
}

function appApi(conversationId: string) {
  const fetchSpy: FetchLike = async (url, init) => {
    if (typeof init?.body === "string") sentBodies.push(init.body);
    return fetch(url, init);
  };
  return createMilaApi({ apiUrl: () => base, headers: async () => ({}), conversationId: () => conversationId, fetch: fetchSpy });
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.NOMILA_MCP_PASS_KEY = KEY;
  process.env.MILA_CHAT_V2 = "true";
  await initTestDb();
  const a = await seedAthlete("Test Athlete", { id: TEST_ATHLETE } as never);
  (globalThis as any).__TEST_ATHLETE_ID = a;
  await dbStore.insertFacts(a, [
    { subject: { kind: "athlete", name: "Test Athlete" }, claim: "Test Athlete races keelboats for Tidewater-Q9 club.", type: "found", source: { url: "https://example.org/club" }, date: "2026-09-01", confidence: 0.9, runId: null },
  ]);
  const app = express();
  app.use(express.json());
  expect(mountChatV2(app)).toBe(true);
  app.use("/api/v1/me", pendingActionsRouter);
  app.use("/api/v1/me", conversationsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await closeTestDb();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});
beforeEach(() => { clearJobCache(); sentBodies.length = 0; });

const FIXED_LABELS = new Set([...Object.values(TOOL_STATUS_LABELS), TOOL_STATUS_FALLBACK, THINKING_STATUS]);
const CONV = randomUUID();
let runId = "";

describe("chat v2 read by the app's own transport and parser", () => {
  it("C1 text, fixed status lines, a checked card and done arrive; the body is only the new text; nothing raw", async () => {
    await script([
      { tools: [{ name: "recall_facts", args: { query: "zephyr-77 keelboats" } }, { name: "remember_preference", args: { kind: "style", statement: "Afternoon shoots only." } }] },
      { text: ["Want me to ", "save that?"] },
    ]);
    const r = await sendAndCollect(appApi(CONV), "Please remember I only shoot in the afternoon.");
    expect(r.error).toBeNull();
    expect(sentBodies.map((b) => JSON.parse(b))).toEqual([{ conversationId: CONV, message: { text: "Please remember I only shoot in the afternoon." } }]);

    const types = r.chunks.map((c) => c.type);
    expect(types[0]).toBe("start");
    expect(types).toEqual(expect.arrayContaining(["text-delta", "data-mila-status", "data-mila-card", "data-mila-done", "finish"]));
    expect(types.filter((t) => t.startsWith("tool-"))).toEqual([]);

    const m = r.message!;
    runId = String(m.metadata?.runId);
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(textOf(m)).toBe("Want me to save that?");
    const labels = m.parts.filter((p) => p.type === "data-mila-status").map((p) => (p as { data: { label: string } }).data.label);
    const streamedLabels = r.chunks.filter((c) => c.type === "data-mila-status").map((c) => (c as { data: { label: string } }).data.label);
    expect(streamedLabels.length).toBeGreaterThan(0);
    for (const l of [...labels, ...streamedLabels]) expect(FIXED_LABELS.has(l)).toBe(true);
    const action = cardsOf(m).find((c) => c.type === "action");
    expect(action?.data.fields).toMatchObject({ state: "needs_approval", verb: "save_memory" });
    expect(doneOf(m)).toMatchObject({ runId, status: "completed" });

    const everything = JSON.stringify(r.chunks);
    for (const leak of ["zephyr-77", "Tidewater-Q9", "\"query\"", "toolCallId", "\"input\"", "\"output\""]) expect([leak, everything.includes(leak)]).toEqual([leak, false]);
  }, 60_000);

  it("C2 the run status and the saved turns, through the app's calls", async () => {
    const api = appApi(CONV);
    expect(await api.getRun(runId)).toMatchObject({ runId, status: "completed", conversationId: CONV });
    const turns = await api.loadConversation(CONV);
    expect(turns?.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(textOf(turns![1])).toBe("Want me to save that?");
    expect(turns!.every((t) => t.metadata?.saved)).toBe(true);
    expect(await api.getRun(randomUUID())).toBeNull();
  }, 60_000);

  it("C3 Stop through the app's call stops a slow second turn", async () => {
    await script([{ text: "too late", delayMs: 8_000 }]);
    const api = appApi(CONV);
    const ctl = new AbortController();
    let seen = "";
    const started = new Promise<void>((resolve) => {
      void sendAndCollect(api, "Write me something long.", {
        signal: ctl.signal,
        onChunk: (c) => { if (c.type === "start" && !seen) { seen = String((c as { messageMetadata?: { runId?: string } }).messageMetadata?.runId); resolve(); } },
      });
    });
    await started;
    expect(await api.stopRun(seen)).toBe("stopping");
    ctl.abort();
    const end = Date.now() + 15_000;
    let st = await api.getRun(seen);
    while (st?.status === "running" && Date.now() < end) { await new Promise((r) => setTimeout(r, 50)); st = await api.getRun(seen); }
    expect(st).toMatchObject({ status: "stopped" });
    expect(await api.stopRun(seen)).toBe("ended");
  }, 60_000);

  it("C4 her attachments (data-mila-attachment parts, from the composer's adapter) go up as ids and roles only; the route takes them", async () => {
    const [asset] = await db.insert(mediaAssets).values({
      athlete_id: TEST_ATHLETE, platform: "upload", origin: "upload", media_type: "IMAGE", status: "stored",
      gcs_path: `athletes/${TEST_ATHLETE}/c4.jpg`, content_type: "image/jpeg",
    } as never).returning({ id: mediaAssets.id });
    await script([{ text: ["Nice."] }]);
    const conv = randomUUID();
    const api = appApi(conv);
    const user = {
      id: "u-1", role: "user" as const,
      parts: [{ type: "data-mila-attachment" as const, data: { assetId: asset.id, role: "photo" as const, thumbUrl: "https://cdn.test/secret-thumb.jpg" } }],
    };
    const stream = await api.transport.sendMessages({ chatId: "c4", messages: [user as never], abortSignal: undefined, trigger: "submit-message", messageId: undefined });
    const reader = stream.getReader();
    for (;;) { const { done } = await reader.read(); if (done) break; }
    expect(sentBodies.map((b) => JSON.parse(b))).toEqual([{ conversationId: conv, message: { text: "Take a look at this.", attachments: [{ asset_id: asset.id, role: "photo" }] } }]);
    expect(sentBodies[0]).not.toContain("secret-thumb");
    const turns = await api.loadConversation(conv);
    expect(turns!.map((t) => textOf(t))).toEqual(["Take a look at this.", "Nice."]);
  }, 60_000);
});
