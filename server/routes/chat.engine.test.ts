/**
 * chat.engine.test.ts — the Mila chat route runs on Mastra, always (Mastra-only PR 2, Nov 2026; was the engine switch's
 * test since P1, 5 Nov 2026).
 *
 *   always      whatever a leftover MILA_ENGINE / MILA_MASTRA_ATHLETES, MILA_TF_CHAT, NOMILA_MCP_ENABLED or AGENT_V3
 *               say, POST /me/chat runs the Mastra turn (runMilaTurn) for the caller and Stop asks the Mastra turn to
 *               stop; the old v1 loop never runs
 *   errors      a failed turn is a clean SSE error
 * The turn is mocked: no model, no Mastra runtime.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("../mila/loop", () => ({ runMilaLoop: jest.fn() }));
jest.mock("../mila/conversations", () => ({ ...jest.requireActual("../mila/conversations"), maybeSummarizeConversation: jest.fn(async () => undefined) }));
jest.mock("../lib/kimi", () => ({ kimiStream: jest.fn() }));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));
jest.mock("../agent/engine/mastra/turn", () => ({ runMastraTurn: jest.fn(), stopMastraConversation: jest.fn(async () => 1) }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import chatRouter from "./chat";
import { runMilaLoop } from "../mila/loop";
import { runMastraTurn, stopMastraConversation } from "../agent/engine/mastra/turn";
import { initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";

const loop = runMilaLoop as jest.Mock;
const mastra = runMastraTurn as jest.Mock;
const stop = stopMastraConversation as jest.Mock;
const FLAGS = ["MILA_ENGINE", "MILA_MASTRA_ATHLETES", "MILA_TF_CHAT", "NOMILA_MCP_ENABLED", "AGENT_V3"] as const;
const saved = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));
const CONV = "33333333-2222-4333-8444-555555555555";
const set = (env: Partial<Record<(typeof FLAGS)[number], string | undefined>>) => {
  for (const k of FLAGS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
};

let server: Server;
let base: string;
let athleteId: string;

async function chat(body: unknown) {
  const res = await fetch(`${base}/chat`, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(body) });
  const text = await res.text();
  return text.split("\n\n").map((b) => b.split("\n").find((l) => l.startsWith("data: "))).filter(Boolean).map((l) => JSON.parse(l!.slice(6)));
}
async function stopChat() {
  const res = await fetch(`${base}/chat/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversation_id: CONV }) });
  return { status: res.status, json: await res.json() };
}
const tokens = (events: any[]) => events.filter((e) => e.token).map((e) => e.token).join("");

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Chat engine");
  (globalThis as any).__TEST_ATHLETE_ID = athleteId;
  const app = express();
  app.use(express.json());
  app.use("/", chatRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
beforeEach(() => {
  jest.clearAllMocks();
  mastra.mockImplementation(async (p: any) => {
    p.sse.token("mastra"); p.sse.done({ runId: "mastra-run" });
    return { runId: "mastra-run", text: "mastra", status: "completed", stopReason: null, cards: [], cost: {} };
  });
});
afterEach(() => { for (const k of FLAGS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("the chat runs on Mastra, always", () => {
  test.each([
    [{}],
    [{ MILA_ENGINE: "harness" }],
    [{ MILA_ENGINE: "trueforge", MILA_TF_CHAT: "true", NOMILA_MCP_ENABLED: "true", AGENT_V3: "true" }],
    [{ MILA_ENGINE: "mastra" }],
    [{ MILA_ENGINE: "harness", MILA_MASTRA_ATHLETES: "00000000-0000-4000-a000-00000000e2e2" }],
  ])("with %j the Mastra turn runs for the caller, and Stop stops it", async (env) => {
    set(env);
    const events = await chat({ message: "What's next?", conversation_id: CONV, context: { type: "goals" } });
    expect(mastra).toHaveBeenCalledTimes(1);
    expect(mastra.mock.calls[0][0]).toMatchObject({ athleteId, message: "What's next?", conversationId: CONV, context: { type: "goals" } });
    expect(tokens(events)).toBe("mastra");
    expect(events.filter((e) => e.done)).toEqual([{ done: true, runId: "mastra-run" }]);
    expect(loop).not.toHaveBeenCalled();
    expect(await stopChat()).toEqual({ status: 202, json: { stopped: 1 } });
    expect(stop).toHaveBeenCalledWith(athleteId, CONV);
  });

  test("a failed Mastra turn is a clean SSE error", async () => {
    mastra.mockRejectedValue(new Error("boom"));
    const events = await chat({ message: "hi", conversation_id: CONV });
    expect(events).toContainEqual({ error: "Mila is unavailable right now — try again in a moment." });
  });
});
