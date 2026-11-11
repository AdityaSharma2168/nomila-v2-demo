/**
 * MilaThread.test — chat v2's app module, mounted for real: assistant-ui's React Native primitives and its AI SDK
 * runtime (useChat over AssistantChatTransport) reading a REAL AI SDK v7 SSE byte stream, built from the part shapes the
 * server writes (server/agent/engine/mastra/chatV2Stream.ts: start · text-* · data-mila-status · data-mila-card ·
 * data-mila-done · error · finish, each `data: <json>\n\n`, then `data: [DONE]`). Only the network is a stand-in
 * (expo/fetch); no provider, no server.
 *
 *   - text arrives progressively; the status line follows the status parts
 *   - a deal card and an approval card arrive mid-turn, drawn by the existing cards; Approve calls the approve route
 *     ONCE on a double tap, and the card says Sent (or the error)
 *   - Stop calls POST /chat/v2/runs/:runId/stop and aborts the stream (also when tapped before the run id arrived)
 *   - a dropped stream → "Mila is still working…" while GET /runs/:runId says running → the saved turns are shown
 *   - every request body is exactly { conversationId, message: { text } }
 *   - Copy copies the plain text; Retry is on the last failed / stopped turn only, fires once, and sends the same body
 *   - accessibility: every pressable has a role and a label; the composer has a label; the status line is a polite
 *     live region
 */
import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import { AccessibilityInfo, AppState } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toMilaCardDto } from "../../../../shared/milaCards";
import { ACTION_CARD } from "../../../lib/agent/fixtures";
import { DEAL_CARD_YOURS } from "../../../lib/agent/dealFixtures";

// ─── The network: expo/fetch, routed by path ──────────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ReadableStream: NodeReadableStream } = require("node:stream/web");
const enc = new TextEncoder();

interface Sse { push: (part: Record<string, unknown>) => void; end: () => void; drop: () => void; signal?: AbortSignal; body: string }
function makeSse(body: string, signal?: AbortSignal): { sse: Sse; stream: ReadableStream<Uint8Array> } {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const stream = new NodeReadableStream({ start(c: ReadableStreamDefaultController<Uint8Array>) { ctl = c; } });
  const sse: Sse = {
    body,
    signal,
    // A stream the reader has cancelled (Stop) refuses writes; the server's later writes are simply dropped.
    push: (part) => { if (!closed) try { ctl.enqueue(enc.encode(`data: ${JSON.stringify(part)}\n\n`)); } catch { closed = true; } },
    end: () => { if (closed) return; closed = true; try { ctl.enqueue(enc.encode("data: [DONE]\n\n")); ctl.close(); } catch { /* cancelled */ } },
    drop: () => { if (closed) return; closed = true; try { ctl.error(new TypeError("Network request failed")); } catch { /* cancelled */ } },
  };
  return { sse, stream };
}

const calls: Array<{ url: string; method: string; body?: string; at: number }> = [];
let streams: Sse[] = [];
let chatFails = 0;
let runReplies: Array<Record<string, unknown>> = [];
let savedRows: Array<Record<string, unknown>> = [];
const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

const mockFetch = jest.fn(async (url: string, init: RequestInit = {}) => {
  const method = (init.method ?? "GET").toUpperCase();
  calls.push({ url, method, body: typeof init.body === "string" ? init.body : undefined, at: Date.now() });
  if (url.endsWith("/api/v1/me/chat/v2")) {
    if (chatFails > 0) { chatFails--; return json(500, { error: "boom" }); }
    const { sse, stream } = makeSse(String(init.body), init.signal ?? undefined);
    streams.push(sse);
    return { ok: true, status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body: stream } as unknown as Response;
  }
  if (/\/runs\/[^/]+\/stop$/.test(url)) return json(202, { status: "stopping" });
  if (/\/runs\/[^/]+$/.test(url)) return json(200, runReplies.shift() ?? { runId: "r", status: "completed", messageIds: [], conversationId: null });
  if (/\/me\/conversations\//.test(url)) return json(200, { messages: savedRows });
  return json(404, {});
});
jest.mock("expo/fetch", () => ({ fetch: (url: string, init?: RequestInit) => mockFetch(url, init) }));

let uuid = 0;
jest.mock("expo-crypto", () => ({ randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` }));

const approveCalls: Array<{ method: string; route: string; data?: unknown }> = [];
let approveFails = false;
let mockToken = "test-token";
jest.mock("../../../lib/query-client", () => ({
  getApiUrl: () => "https://dev.test",
  getAuthHeaders: async () => ({ Authorization: `Bearer ${mockToken}` }),
  apiRequest: async (method: string, route: string, data?: unknown) => {
    approveCalls.push({ method, route, data });
    if (approveFails && route.endsWith("/approve")) throw new Error("500: nope");
    return { ok: true, status: 200, json: async () => (route.includes("pending-actions?") ? [] : { id: "appr-1", status: "approved" }) };
  },
}));

const mockSetString = jest.fn(async (_t: string) => true);
jest.mock("expo-clipboard", () => ({ setStringAsync: (t: string) => mockSetString(t) }));

jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }) }));
jest.mock("../../../hooks/use-platform-oauth", () => ({ usePlatformOAuth: () => ({ connect: jest.fn(), disconnect: jest.fn(), connecting: false }) }));
jest.mock("../../../lib/agent/connect", () => ({ connectService: jest.fn(async () => true) }));
jest.mock("../../../lib/milaChats", () => ({ confirmDeleteChat: jest.fn(async () => false) }));
jest.mock("../SavedChatsSheet", () => ({ SavedChatsSheet: () => null }));
// Voice and the ＋ have their own suite (MilaThreadParity.test.tsx); here voice is unavailable, as for a signed-out build.
jest.mock("../useMilaVoice", () => ({
  useMilaVoice: () => ({ state: "idle", error: null, notice: null, supported: false, toggle: () => {}, active: false, justEnded: false }),
}));
jest.mock("../MilaAttachSheet", () => ({ MilaAttachSheet: () => null }));
jest.mock("../MilaWidget", () => ({ MilaWidget: () => null }));
jest.mock("../../deals/AddContractSheet", () => ({ AddContractSheet: () => null }));
jest.mock("../../requests/RequestDocumentSheet", () => ({ RequestDocumentSheet: () => null }));
jest.mock("../../media/RightsAckPanel", () => ({ RightsAckPanel: () => null }));
jest.mock("../../../hooks/use-media-library", () => ({
  pickFromCameraRoll: jest.fn(async () => null),
  useUploadMedia: () => ({ mutateAsync: jest.fn(), isPending: false }),
  RightsAckRequired: class RightsAckRequired extends Error {},
}));
jest.mock("../MilaChatMenu", () => ({ MilaChatMenu: () => null }));
jest.mock("../../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("expo-blur", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { BlurView: (p: Record<string, unknown>) => React.createElement(View, p) };
});
jest.mock("expo-linear-gradient", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { LinearGradient: (p: Record<string, unknown>) => React.createElement(View, p) };
});
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Feather: ({ name }: { name: string }) => React.createElement(Text, { testID: `icon-${name}` }, name) };
});
jest.mock("expo-video", () => {
  const React = require("react");
  return {
    useVideoPlayer: (src: unknown) => {
      const ref = React.useRef(null);
      if (!ref.current) ref.current = { source: src, play: jest.fn(), pause: jest.fn() };
      return ref.current;
    },
    VideoView: (props: Record<string, unknown>) => React.createElement(require("react-native").View, props),
  };
});

import { MilaThreadScreen } from "./MilaThreadScreen";
import { catchUpBudgetMs, DEFAULT_TURN_TIMEOUT_MS, MAX_WAIT_MS, sharedThread } from "./useMilaThread";

// ─── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────
const flush = (n = 6) => act(async () => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10)); });
const chatPosts = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/api/v1/me/chat/v2"));
const start = (runId: string) => ({ type: "start", messageId: runId, messageMetadata: { runId } });
const status = (label: string, phase: "thinking" | "tool" = "tool") => ({ type: "data-mila-status", id: "status", data: { label, phase } });
const card = (c: unknown) => {
  const r = toMilaCardDto(c);
  if (!r.ok) throw new Error(`fixture card is not a valid DTO: ${r.reason}`);
  return { type: "data-mila-card", id: r.dto.data.id, data: r.dto };
};
const done = (runId: string, st: "completed" | "stopped" | "failed" = "completed") =>
  ({ type: "data-mila-done", data: { runId, status: st, stopReason: null, messageIds: ["m-1"] } });
/** A whole, normal turn: start → text → done → finish → [DONE]. */
function completeTurn(s: Sse, runId: string, text: string, extra: Array<Record<string, unknown>> = []) {
  s.push(start(runId));
  s.push({ type: "start-step" });
  for (const p of extra) s.push(p);
  s.push({ type: "text-start", id: "t1" });
  s.push({ type: "text-delta", id: "t1", delta: text });
  s.push({ type: "text-end", id: "t1" });
  s.push({ type: "finish-step" });
  s.push(done(runId));
  s.push({ type: "finish", finishReason: "stop" });
  s.end();
}

function renderThread(threadOptions: Record<string, number> = {}) {
  // gcTime Infinity: a 5-minute cache-collection timer would hold the Jest process open long after the tests end.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  return render(
    <QueryClientProvider client={qc}>
      <MilaThreadScreen visible onClose={jest.fn()} presentation="tab" threadOptions={{ pollMs: 20, pollCap: 10, stopWaitMs: 2000, ...threadOptions }} />
    </QueryClientProvider>,
  );
}

/** Type in the composer and tap Send (assistant-ui's ComposerPrimitive). */
async function typeAndSend(text: string) {
  fireEvent.changeText(screen.getByTestId("thread-input"), text);
  await flush(1);
  fireEvent.press(screen.getByTestId("thread-send"));
  await flush();
}

beforeEach(() => {
  calls.length = 0;
  streams = [];
  chatFails = 0;
  runReplies = [];
  savedRows = [];
  approveCalls.length = 0;
  approveFails = false;
  mockToken = "test-token";
  mockSetString.mockClear();
  sharedThread.id = null;
  sharedThread.rev = 0;
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
});
afterEach(() => {
  for (const s of streams) s.end();
  jest.restoreAllMocks();
});

// ─── 1. Streaming ─────────────────────────────────────────────────────────────────────────────────────────────────

it("draws Mila's text progressively as text-delta parts arrive", async () => {
  renderThread();
  await flush();
  await typeAndSend("How are my deals?");
  expect(screen.getByText("How are my deals?")).toBeTruthy();
  const s = streams[0];
  s.push(start("run-1"));
  s.push({ type: "text-start", id: "t1" });
  s.push({ type: "text-delta", id: "t1", delta: "Two are " });
  await flush();
  expect(screen.getByTestId("thread-answer")).toHaveTextContent("Two are");
  s.push({ type: "text-delta", id: "t1", delta: "waiting on you." });
  await flush();
  expect(screen.getByTestId("thread-answer")).toHaveTextContent("Two are waiting on you.");
  // Still streaming: Stop shows, Send does not.
  expect(screen.getByTestId("thread-stop")).toBeTruthy();
  s.push({ type: "text-end", id: "t1" });
  s.push(done("run-1"));
  s.push({ type: "finish", finishReason: "stop" });
  s.end();
  await flush();
  expect(screen.queryByTestId("thread-stop")).toBeNull();
  expect(screen.getByTestId("thread-send")).toBeTruthy();
  expect(screen.queryByTestId("thread-retry")).toBeNull();
});

// ─── 2. Status line ──────────────────────────────────────────────────────────────────────────────────────────────

it("the status line follows the data-mila-status parts, then gives way to the text", async () => {
  renderThread();
  await flush();
  await typeAndSend("What's new?");
  // Sent, nothing back yet: her label and "Thinking".
  expect(screen.getByTestId("thread-status-text")).toHaveTextContent("Thinking");
  const s = streams[0];
  s.push(start("run-2"));
  s.push(status("Looking at your deals…"));
  await flush();
  expect(screen.getByTestId("thread-status-text")).toHaveTextContent("Looking at your deals");
  s.push(status("Checking your calendar…"));
  await flush();
  expect(screen.getByTestId("thread-status-text")).toHaveTextContent("Checking your calendar");
  expect(screen.getAllByTestId("thread-status-text")).toHaveLength(1);
  s.push({ type: "text-start", id: "t1" });
  s.push({ type: "text-delta", id: "t1", delta: "Here it is." });
  await flush();
  expect(screen.queryByTestId("thread-status-text")).toBeNull();
  completeTurnTail(s, "run-2");
  await flush();
});

function completeTurnTail(s: Sse, runId: string) {
  s.push({ type: "text-end", id: "t1" });
  s.push(done(runId));
  s.push({ type: "finish", finishReason: "stop" });
  s.end();
}

// ─── 3. Cards + the approve route ─────────────────────────────────────────────────────────────────────────────────

it("a deal card and an approval card arrive mid-turn; Approve calls the approve route once on a double tap and says Sent", async () => {
  renderThread();
  await flush();
  await typeAndSend("Reply to Northpeak");
  const s = streams[0];
  s.push(start("run-3"));
  s.push(card(DEAL_CARD_YOURS));
  await flush();
  // The deal card is there before any text, while the turn is still running.
  expect(screen.getByTestId("card-deal")).toBeTruthy();
  expect(screen.getByTestId("thread-stop")).toBeTruthy();
  s.push(card(ACTION_CARD));
  s.push({ type: "text-start", id: "t1" });
  s.push({ type: "text-delta", id: "t1", delta: "I drafted it — tap Send when it looks right." });
  completeTurnTail(s, "run-3");
  await flush();
  expect(screen.getByTestId("card-action")).toBeTruthy();
  // Needs approval: nothing has gone out on render.
  expect(approveCalls.filter((c) => c.route.endsWith("/approve"))).toHaveLength(0);
  const approve = screen.getByTestId("action-approve");
  fireEvent.press(approve);
  fireEvent.press(approve);
  await flush();
  const approves = approveCalls.filter((c) => c.method === "POST" && c.route.endsWith("/approve"));
  expect(approves).toHaveLength(1);
  expect(approves[0].route).toBe("/api/v1/me/pending-actions/appr-1/approve");
  expect(screen.getByTestId("action-done")).toHaveTextContent(/Sent\./);
  // The approve route is the ONLY way out: the tap sent nothing through the chat stream.
  expect(chatPosts()).toHaveLength(1);
});

it("each lead-in line is drawn directly above its card, in the order the stream made them (never all the text first)", async () => {
  renderThread();
  await flush();
  await typeAndSend("What's new?");
  const s = streams[0];
  s.push(start("run-il"));
  s.push({ type: "text-start", id: "t1" });
  s.push({ type: "text-delta", id: "t1", delta: "LEAD-ONE about the deal." });
  s.push({ type: "text-end", id: "t1" });
  s.push(card(DEAL_CARD_YOURS));
  s.push({ type: "text-start", id: "t2" });
  s.push({ type: "text-delta", id: "t2", delta: "LEAD-TWO about the draft." });
  s.push({ type: "text-end", id: "t2" });
  s.push(card(ACTION_CARD));
  s.push(done("run-il"));
  s.push({ type: "finish", finishReason: "stop" });
  s.end();
  await flush();
  const tree = JSON.stringify(screen.toJSON());
  const at = (needle: string) => { const i = tree.indexOf(needle); expect(i).toBeGreaterThanOrEqual(0); return i; };
  const order = [at("LEAD-ONE"), at("\"card-deal\""), at("LEAD-TWO"), at("\"card-action\"")];
  expect([...order].sort((a, b) => a - b)).toEqual(order);
});

it("an approval that fails says so and keeps the draft (error state)", async () => {
  approveFails = true;
  renderThread();
  await flush();
  await typeAndSend("Reply to them");
  completeTurn(streams[0], "run-3b", "Here's a draft.", [card(ACTION_CARD)]);
  await flush();
  fireEvent.press(screen.getByTestId("action-approve"));
  await flush();
  expect(screen.getByTestId("action-error")).toBeTruthy();
  expect(screen.getByTestId("action-body")).toBeTruthy();
  expect(screen.queryByTestId("action-done")).toBeNull();
  // The double-tap guard lets go once the failed call settles: a second, deliberate tap is sent (and succeeds).
  approveFails = false;
  fireEvent.press(screen.getByTestId("action-approve"));
  await flush();
  expect(approveCalls.filter((c) => c.method === "POST" && c.route.endsWith("/approve"))).toHaveLength(2);
  expect(screen.getByTestId("action-done")).toHaveTextContent(/Sent\./);
});

it("a card type with no view draws nothing (and the turn still draws)", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  renderThread();
  await flush();
  await typeAndSend("Hi");
  completeTurn(streams[0], "run-3c", "Hello.", [{ type: "data-mila-card", id: "w1", data: { type: "waitlist-card", data: { id: "w1", title: "x", links: [], fields: { card: "sport" } } } }]);
  await flush();
  expect(screen.getByTestId("thread-answer")).toHaveTextContent("Hello.");
  expect(screen.queryByTestId("card-deal")).toBeNull();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("waitlist-card"));
});

// ─── 4. Stop ─────────────────────────────────────────────────────────────────────────────────────────────────────

it("Stop calls POST /chat/v2/runs/:runId/stop and aborts the stream; Retry is offered", async () => {
  renderThread();
  await flush();
  await typeAndSend("Write me a long pitch");
  const s = streams[0];
  s.push(start("run-4"));
  s.push({ type: "text-start", id: "t1" });
  s.push({ type: "text-delta", id: "t1", delta: "Dear brand," });
  await flush();
  fireEvent.press(screen.getByTestId("thread-stop"));
  await flush();
  const stops = calls.filter((c) => c.method === "POST" && c.url.endsWith("/runs/run-4/stop"));
  expect(stops).toHaveLength(1);
  expect(stops[0].url).toBe("https://dev.test/api/v1/me/chat/v2/runs/run-4/stop");
  expect(s.signal?.aborted).toBe(true);
  expect(screen.queryByTestId("thread-stop")).toBeNull();
  expect(screen.getByTestId("thread-answer")).toHaveTextContent("Dear brand,");
  expect(screen.getByTestId("thread-retry")).toBeTruthy();
});

it("Stop before the run id arrived waits for it, then stops the run (not just the reading)", async () => {
  renderThread();
  await flush();
  await typeAndSend("Go");
  fireEvent.press(screen.getByTestId("thread-stop"));
  await flush();
  expect(calls.filter((c) => c.url.includes("/stop"))).toHaveLength(0);
  streams[0].push(start("run-4b"));
  await flush();
  expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/runs/run-4b/stop"))).toHaveLength(1);
  expect(streams[0].signal?.aborted).toBe(true);
});

// ─── 5. Dropped stream → polling → saved turns ───────────────────────────────────────────────────────────────────

it("a dropped stream: 'Mila is still working…' while the run is running, then the saved reply", async () => {
  runReplies = [
    { runId: "run-5", status: "running", messageIds: [], conversationId: null },
    { runId: "run-5", status: "running", messageIds: [], conversationId: null },
    { runId: "run-5", status: "completed", messageIds: ["m-9"], conversationId: null },
  ];
  savedRows = [
    { id: "u-1", role: "user", content: "What can you help me with?" },
    { id: "m-9", role: "assistant", content: "Deals, posts, your page and your money.", agentCards: [DEAL_CARD_YOURS] },
  ];
  renderThread();
  await flush();
  await typeAndSend("What can you help me with?");
  const s = streams[0];
  s.push(start("run-5"));
  s.push({ type: "text-start", id: "t1" });
  s.push({ type: "text-delta", id: "t1", delta: "Deals, po" });
  await flush(2);
  s.drop();
  await flush(2);
  expect(screen.getByTestId("thread-status-text")).toHaveTextContent("Mila is still working");
  await flush(12);
  const runGets = calls.filter((c) => c.method === "GET" && c.url.endsWith("/runs/run-5"));
  expect(runGets.length).toBe(3);
  expect(calls.some((c) => c.method === "GET" && /\/me\/conversations\/00000000-/.test(c.url))).toBe(true);
  expect(screen.getByTestId("thread-answer")).toHaveTextContent("Deals, posts, your page and your money.");
  expect(screen.getByTestId("card-deal")).toBeTruthy();
  expect(screen.queryByTestId("thread-status-text")).toBeNull();
  expect(screen.queryByTestId("thread-retry")).toBeNull();
});

it("reloaded saved turns: an approval the server says was sent shows Sent, one declined shows Declined (never asks again)", async () => {
  const at = "2026-11-01T10:00:00.000Z";
  runReplies = [{ runId: "run-r", status: "completed", messageIds: ["m-r"], conversationId: null }];
  savedRows = [
    { id: "u-1", role: "user", content: "Reply to Northpeak" },
    {
      id: "m-r", role: "assistant", content: "Here you go.",
      agentCards: [
        { ...ACTION_CARD, id: "sent-card", payload: { ...ACTION_CARD.payload, approval: { state: "sent", at } } },
        { ...ACTION_CARD, id: "declined-card", payload: { ...ACTION_CARD.payload, approvalId: "appr-2", approval: { state: "declined", at } } },
      ],
    },
  ];
  renderThread();
  await flush();
  await typeAndSend("Reply to Northpeak");
  const s = streams[0];
  s.push(start("run-r"));
  await flush(2);
  s.drop();
  await flush(12);
  expect(screen.getByTestId("action-done")).toBeTruthy();
  expect(screen.getByTestId("action-declined")).toBeTruthy();
  expect(screen.queryByTestId("action-approve")).toBeNull();
  expect(approveCalls).toHaveLength(0);
});

// ─── 5b. The catch-up's lifecycle: nothing outlives the screen, the conversation or the turn ─────────────────────

const running = (runId: string, n: number) =>
  Array.from({ length: n }, () => ({ runId, status: "running", messageIds: [], conversationId: null }));
const runGets = (runId: string) => calls.filter((c) => c.method === "GET" && c.url.endsWith(`/runs/${runId}`)).length;

/** Send, let the run start and write a little, then drop the signal: the catch-up starts polling. */
async function dropMidTurn(runId: string, text = "Tell me about my deals") {
  await typeAndSend(text);
  const s = streams[streams.length - 1];
  s.push(start(runId));
  s.push({ type: "text-start", id: "t1" });
  s.push({ type: "text-delta", id: "t1", delta: "Looking" });
  await flush(2);
  s.drop();
  await flush(2);
  return s;
}

it("a long reply: 'Mila is still working…' with a growing wait until the server's turn timeout, then the calm line (no error, no Retry, no more looks)", async () => {
  // The server says its turn timeout is 600 ms and the run is 100 ms in: the phone waits ~500 ms (grace 0 here).
  runReplies = Array.from({ length: 40 }, () => ({ runId: "run-L", status: "running", messageIds: [], conversationId: null, turnTimeoutMs: 600, runningForMs: 100 }));
  renderThread({ pollCap: 40, waitGraceMs: 0 });
  await flush();
  await dropMidTurn("run-L");
  await flush(15); // ~150 ms: past where a fixed 20 ms poll would have made 7 looks
  expect(screen.getByTestId("thread-status-text")).toHaveTextContent("Mila is still working");
  expect(screen.queryByTestId("thread-error")).toBeNull();
  await flush(60);
  const gets = calls.filter((c) => c.method === "GET" && c.url.endsWith("/runs/run-L"));
  // Back-off: 20, 32, 51, 82, 131 … ms — far fewer looks than 500 ms of fixed 20 ms polling (25), each wait longer.
  expect(gets.length).toBeGreaterThanOrEqual(4);
  expect(gets.length).toBeLessThan(12);
  const gaps = gets.slice(1).map((g, i) => g.at - gets[i].at);
  // (The last wait is cut short by the deadline, so it is left out.)
  expect(Math.max(...gaps.slice(0, -1))).toBeGreaterThan(gaps[0] * 2);
  // The wait ran out with the run still going: the calm line, never the error or Retry; the saved turns are not loaded
  // over what arrived, and the polling has stopped.
  expect(screen.getByTestId("thread-slow")).toHaveTextContent("This is taking longer than usual. I'll let you know when it's ready.");
  expect(screen.queryByTestId("thread-status-text")).toBeNull();
  expect(screen.queryByTestId("thread-error")).toBeNull();
  expect(screen.queryByTestId("thread-retry")).toBeNull();
  expect(calls.some((c) => /\/me\/conversations\//.test(c.url))).toBe(false);
  const settled = runGets("run-L");
  await flush(30);
  expect(runGets("run-L")).toBe(settled);
});

it("after a drop, only a failed run shows the error and Retry", async () => {
  runReplies = [
    { runId: "run-F", status: "running", messageIds: [], conversationId: null },
    { runId: "run-F", status: "failed", messageIds: [], conversationId: null },
  ];
  savedRows = [{ id: "u-1", role: "user", content: "Tell me about my deals" }];
  renderThread();
  await flush();
  await dropMidTurn("run-F");
  await flush(12);
  expect(screen.getByTestId("thread-error")).toBeTruthy();
  expect(screen.getByTestId("thread-retry")).toBeTruthy();
  expect(screen.queryByTestId("thread-slow")).toBeNull();
});

it("catchUpBudgetMs: the server's turn timeout less the time already spent, plus grace; bounded both ways", () => {
  expect(catchUpBudgetMs({ turnTimeoutMs: 240_000, runningForMs: 60_000 }, 30_000)).toBe(210_000);
  expect(catchUpBudgetMs(null, 30_000)).toBe(DEFAULT_TURN_TIMEOUT_MS + 30_000);
  expect(catchUpBudgetMs({ turnTimeoutMs: 1_000, runningForMs: 9_000 }, 0)).toBe(0);
  expect(catchUpBudgetMs({ turnTimeoutMs: 10 * 3_600_000 }, 0)).toBe(MAX_WAIT_MS);
});

it("unmount while catching up: the polling stops at once (no timer or request outlives the screen)", async () => {
  runReplies = running("run-u", 50);
  const view = renderThread();
  await flush();
  await dropMidTurn("run-u");
  expect(screen.getByTestId("thread-status-text")).toHaveTextContent("Mila is still working");
  const before = runGets("run-u");
  expect(before).toBeGreaterThan(0);
  view.unmount();
  await flush(10);
  expect(runGets("run-u")).toBe(before);
  expect(calls.some((c) => /\/me\/conversations\//.test(c.url))).toBe(false);
});

it("the app goes to the background while catching up: polling stops; back to the foreground: it picks up again", async () => {
  const handlers: Array<(s: string) => void> = [];
  jest.spyOn(AppState, "addEventListener").mockImplementation(((_t: string, h: (s: string) => void) => {
    handlers.push(h);
    return { remove: () => { handlers.splice(handlers.indexOf(h), 1); } };
  }) as unknown as typeof AppState.addEventListener);
  const appState = (s: string) => act(async () => { for (const h of [...handlers]) h(s); });
  runReplies = running("run-bg", 3);
  savedRows = [
    { id: "u-1", role: "user", content: "Tell me about my deals" },
    { id: "a-1", role: "assistant", content: "Two are waiting on you." },
  ];
  renderThread();
  await flush();
  await dropMidTurn("run-bg");
  await appState("background");
  const paused = runGets("run-bg");
  await flush(8);
  expect(runGets("run-bg")).toBe(paused);
  expect(screen.queryByTestId("thread-status-text")).toBeNull();
  await appState("active");
  await flush(12);
  expect(runGets("run-bg")).toBeGreaterThan(paused);
  expect(screen.getByTestId("thread-answer")).toHaveTextContent("Two are waiting on you.");
});

it("New chat mid-reply: the old stream writes nothing more, no catch-up of the old run, the next send is the new chat's", async () => {
  runReplies = running("run-old", 50);
  renderThread();
  await flush();
  await typeAndSend("Old question");
  const s = streams[0];
  s.push(start("run-old"));
  s.push({ type: "text-start", id: "t1" });
  s.push({ type: "text-delta", id: "t1", delta: "Old answer" });
  await flush(2);
  fireEvent.press(screen.getByTestId("thread-new-chat"));
  await flush(2);
  expect(s.signal?.aborted).toBe(true);
  s.push({ type: "text-delta", id: "t1", delta: " that keeps going" });
  s.drop();
  await flush(8);
  expect(screen.getByTestId("thread-empty")).toBeTruthy();
  expect(screen.queryByTestId("thread-answer")).toBeNull();
  expect(runGets("run-old")).toBe(0);
  expect(screen.queryByTestId("thread-status-text")).toBeNull();
  await typeAndSend("Fresh start");
  completeTurn(streams[1], "run-new", "Hello again.");
  await flush();
  const [first, second] = chatPosts().map((c) => JSON.parse(c.body!));
  expect(second).toEqual({ conversationId: expect.any(String), message: { text: "Fresh start" } });
  expect(second.conversationId).not.toBe(first.conversationId);
  expect(screen.getAllByTestId("thread-answer").map((n) => n.props.children)).toEqual(["Hello again."]);
});

it("Stop before the run id, then New chat: the waiting Stop is dropped and never stops the new chat's run", async () => {
  renderThread();
  await flush();
  await typeAndSend("Go");
  fireEvent.press(screen.getByTestId("thread-stop"));
  await flush(1);
  fireEvent.press(screen.getByTestId("thread-new-chat"));
  await flush(2);
  await typeAndSend("Something else");
  streams[1].push(start("run-next"));
  await flush(4);
  expect(calls.filter((c) => c.url.includes("/stop"))).toHaveLength(0);
  expect(streams[1].signal?.aborted).toBe(false);
});

it("a new message while catching up: the catch-up stops and never lands the old saved turns over the new reply", async () => {
  runReplies = running("run-c1", 50);
  savedRows = [{ id: "x-1", role: "assistant", content: "STALE SAVED TURN" }];
  renderThread();
  await flush();
  await dropMidTurn("run-c1", "First");
  expect(screen.getByTestId("thread-status-text")).toHaveTextContent("Mila is still working");
  await typeAndSend("Second");
  const polled = runGets("run-c1");
  completeTurn(streams[1], "run-c2", "Fresh reply.");
  await flush(12);
  expect(runGets("run-c1")).toBe(polled);
  expect(screen.queryByText("STALE SAVED TURN")).toBeNull();
  expect(screen.getByText("Fresh reply.")).toBeTruthy();
  expect(JSON.parse(chatPosts()[1].body!)).toEqual({ conversationId: expect.any(String), message: { text: "Second" } });
});

// ─── 6. The request body ─────────────────────────────────────────────────────────────────────────────────────────

it("every send's body is exactly { conversationId, message: { text } } — never the history", async () => {
  renderThread();
  await flush();
  await typeAndSend("First question");
  completeTurn(streams[0], "run-6a", "First answer.");
  await flush();
  await typeAndSend("Second question");
  completeTurn(streams[1], "run-6b", "Second answer.");
  await flush();
  const bodies = chatPosts().map((c) => JSON.parse(c.body!));
  expect(bodies).toHaveLength(2);
  for (const b of bodies) {
    expect(Object.keys(b).sort()).toEqual(["conversationId", "message"]);
    expect(Object.keys(b.message)).toEqual(["text"]);
    expect(b.conversationId).toMatch(/^[0-9a-f-]{36}$/);
  }
  expect(bodies[0].message.text).toBe("First question");
  expect(bodies[1].message.text).toBe("Second question");
  expect(bodies[1].conversationId).toBe(bodies[0].conversationId);
  expect(JSON.stringify(bodies[1])).not.toContain("First");
  // Auth per request, from getAuthHeaders.
  const init = mockFetch.mock.calls.find(([u]) => String(u).endsWith("/chat/v2"))![1] as RequestInit;
  expect(JSON.stringify(init.headers)).toContain("Bearer test-token");
  // A refreshed token is read on the next request (never the one the transport was built with).
  mockToken = "refreshed-token";
  await typeAndSend("Third question");
  completeTurn(streams[2], "run-6c", "Third answer.");
  await flush();
  const inits = mockFetch.mock.calls.filter(([u]) => String(u).endsWith("/chat/v2")).map(([, i]) => JSON.stringify((i as RequestInit).headers));
  expect(inits[inits.length - 1]).toContain("Bearer refreshed-token");
  expect(inits[inits.length - 1]).not.toContain("test-token");
});

// ─── Copy and Retry ──────────────────────────────────────────────────────────────────────────────────────────────

it("Copy puts Mila's message on the clipboard as plain text and says Copied", async () => {
  renderThread();
  await flush();
  await typeAndSend("Sum it up");
  completeTurn(streams[0], "run-7", "**Two** deals need you:\n- *Northpeak* by Friday\n- [Trailmark](https://trailmark.example)");
  await flush();
  fireEvent.press(screen.getByTestId("thread-copy"));
  await flush();
  expect(mockSetString).toHaveBeenCalledTimes(1);
  expect(mockSetString).toHaveBeenCalledWith("Two deals need you:\n• Northpeak by Friday\n• Trailmark (https://trailmark.example)");
  expect(screen.getByTestId("thread-copied")).toHaveTextContent("Copied");
});

it("Retry: only on the last turn, only once it failed; one tap → one new turn with the same body", async () => {
  renderThread();
  await flush();
  await typeAndSend("First");
  completeTurn(streams[0], "run-8a", "Fine.");
  await flush();
  // A completed turn offers no Retry.
  expect(screen.queryByTestId("thread-retry")).toBeNull();
  chatFails = 1; // the next POST answers 500: no run, an error
  await typeAndSend("Second, please");
  await flush();
  expect(screen.getByTestId("thread-error")).toBeTruthy();
  const retries = screen.getAllByTestId("thread-retry");
  expect(retries).toHaveLength(1);
  const before = chatPosts().length;
  fireEvent.press(retries[0]);
  fireEvent.press(retries[0]);
  await flush();
  const after = chatPosts();
  expect(after.length).toBe(before + 1);
  expect(JSON.parse(after[after.length - 1].body!)).toEqual({ conversationId: expect.any(String), message: { text: "Second, please" } });
  // In flight: no Retry until it ends.
  expect(screen.queryByTestId("thread-retry")).toBeNull();
  completeTurn(streams[streams.length - 1], "run-8c", "Done now.");
  await flush();
  expect(screen.queryByTestId("thread-retry")).toBeNull();
});

it("Retry after a turn the server ended in an error part (failed run): the saved turns, then Retry on the last only", async () => {
  runReplies = [{ runId: "run-9", status: "failed", stopReason: "error", messageIds: [], conversationId: null }];
  savedRows = [
    { id: "u-1", role: "user", content: "Earlier" },
    { id: "a-1", role: "assistant", content: "Earlier answer." },
    { id: "u-2", role: "user", content: "Now this" },
    { id: "a-2", role: "assistant", content: "Partial" },
  ];
  renderThread();
  await flush();
  await typeAndSend("Now this");
  const s = streams[0];
  s.push(start("run-9"));
  s.push({ type: "text-start", id: "t1" });
  s.push({ type: "text-delta", id: "t1", delta: "Partial" });
  s.push({ type: "error", errorText: "Mila is unavailable right now — try again in a moment." });
  s.push(done("run-9", "failed"));
  s.push({ type: "finish", finishReason: "error" });
  s.end();
  await flush(10);
  const blocks = screen.getAllByTestId("thread-mila-msg");
  expect(blocks).toHaveLength(2);
  expect(within(blocks[0]).queryByTestId("thread-retry")).toBeNull();
  expect(within(blocks[1]).getByTestId("thread-retry")).toBeTruthy();
  expect(within(blocks[1]).getByTestId("thread-error")).toBeTruthy();
  fireEvent.press(within(blocks[1]).getByTestId("thread-retry"));
  await flush();
  const last = chatPosts()[chatPosts().length - 1];
  expect(JSON.parse(last.body!).message).toEqual({ text: "Now this" });
});

// ─── Native layout (the React Native renderer, iOS by default in the preset) ────────────────────────────────────────

it("native: the keyboard is avoided as the old chat does it (KeyboardAvoidingView, padding on iOS); no web-only inset", async () => {
  const { KeyboardAvoidingView } = require("react-native");
  renderThread();
  await flush();
  const kav = screen.UNSAFE_getByType(KeyboardAvoidingView);
  expect(kav.props.behavior).toBe("padding");
  expect(kav.props.keyboardVerticalOffset).toBe(0);
  // The composer bar's bottom pad is the old chat's 12 (the tab: no home-indicator pad), with no browser keyboard inset.
  const { StyleSheet } = require("react-native");
  let n = screen.getByTestId("thread-composer").parent;
  let pad: unknown = undefined;
  while (n && pad === undefined) { pad = StyleSheet.flatten(n.props.style)?.paddingBottom; n = n.parent; }
  expect(pad).toBe(12);
});

// ─── Accessibility ───────────────────────────────────────────────────────────────────────────────────────────────

it("accessibility: every pressable has a role and a label; the composer is labelled; the status line is a polite live region", async () => {
  const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => {});
  announce.mockClear(); // a jest.fn from RN's jest setup: earlier tests' calls are still on it
  renderThread();
  await flush();
  // Empty state: openers, the menu, new chat, the composer.
  const check = () => {
    const pressables = screen.UNSAFE_root.findAll(
      (n) => typeof n.type === "string" && typeof n.props.onResponderRelease === "function" && n.props.accessible !== false,
    );
    expect(pressables.length).toBeGreaterThan(0);
    const missing = pressables
      .filter((n) => !(n.props.accessibilityRole || n.props.role) || !(n.props.accessibilityLabel || n.props["aria-label"]))
      .map((n) => n.props.testID ?? JSON.stringify(Object.keys(n.props)));
    expect(missing).toEqual([]);
  };
  check();
  expect(screen.getByLabelText("Message Mila")).toBeTruthy();
  expect(screen.getByLabelText("Send")).toBeTruthy();

  await typeAndSend("Reply to Northpeak");
  const s = streams[0];
  s.push(start("run-10"));
  s.push(status("Looking at your deals…"));
  await flush();
  expect(screen.getByTestId("thread-status-text").props.accessibilityLiveRegion).toBe("polite");
  // iOS (the test platform): VoiceOver is told the line too, since it has no live regions (announce.ts).
  expect(announce).toHaveBeenCalledWith("Thinking");
  await act(async () => { await new Promise((r) => setTimeout(r, 2100)); });
  expect(announce.mock.calls.map((c) => c[0])).toEqual(["Thinking", "Looking at your deals"]);
  expect(screen.getByLabelText("Stop")).toBeTruthy();
  s.push(card(DEAL_CARD_YOURS));
  s.push(card(ACTION_CARD));
  s.push({ type: "text-start", id: "t1" });
  s.push({ type: "text-delta", id: "t1", delta: "Here you go." });
  completeTurnTail(s, "run-10");
  await flush();
  check();
  expect(screen.getByLabelText("Copy Mila's message")).toBeTruthy();
  expect(within(screen.getByTestId("card-action")).getAllByRole("button").length).toBeGreaterThan(0);
  expect(screen.getByTestId("action-approve").props.accessibilityLabel).toBe("Send");

  chatFails = 1;
  await typeAndSend("Again");
  check();
  expect(screen.getByLabelText("Retry: send your last message again")).toBeTruthy();
});
