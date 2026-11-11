/**
 * use-mila-chat.planFollowUp.test — AGENT_V3: a turn whose cards include refresh_plan's running progress card makes the
 * open chat follow the plan run: it re-reads the goals read every 5 s while `planning` names the run, then re-reads the
 * conversation once and adds Mila's follow-up under the card (now done), once. A reopened chat draws its agent cards.
 * The transport is mocked by URL (no server, no provider).
 */
import { act, renderHook } from "@testing-library/react-native";
import { AppState } from "react-native";

const RUN = "wf-run-1";
const CID_RE = /\/conversations\/([^/?]+)$/;
const progress = (state: string) => ({ id: `plan-progress:${RUN}`, kind: "progress", title: "Updating your plan", links: [], runId: "r", payload: { step: 1, of: 1, label: "Planning your week", state, planRunId: RUN, steps: [{ label: "Planning your week", state }] } });
const ready = { id: `plan-ready:${RUN}`, kind: "open-screen", title: "This week's plan", links: [], runId: null, payload: { screen: "goals", id: null, label: "your goals", why: "3 posts" } };

let goalsAnswers: Array<Record<string, unknown>> = [];
let calls: string[] = [];
let conversationRows: unknown[] = [];

function sse(events: Array<Record<string, unknown>>) {
  const enc = new TextEncoder();
  const chunks = events.map((e) => ({ done: false, value: enc.encode(`data: ${JSON.stringify(e)}\n\n`) }));
  chunks.push({ done: true } as any);
  return { getReader: () => ({ read: () => Promise.resolve(chunks.shift() ?? { done: true }) }) };
}

jest.mock("../lib/flags", () => ({ AGENT_V3: true }));
jest.mock("expo/fetch", () => ({
  fetch: jest.fn(async (url: string) => {
    calls.push(url);
    if (url.endsWith("/api/v1/me/chat")) return { ok: true, status: 200, body: sse([{ token: "On it." }, { done: true, runId: "r", cards: [progress("running")] }]) };
    if (url.endsWith("/api/v1/me/agent/goals")) return { ok: true, status: 200, json: async () => goalsAnswers.shift() ?? { planning: null } };
    if (CID_RE.test(url)) return { ok: true, status: 200, json: async () => ({ messages: conversationRows }) };
    return { ok: false, status: 404 };
  }),
}));
jest.mock("expo-crypto", () => ({ randomUUID: () => "11111111-1111-4111-8111-111111111111" }));
jest.mock("../lib/query-client", () => ({ getApiUrl: () => "http://test", getAuthHeaders: async () => ({}) }));

import { useMilaChat } from "./use-mila-chat";

const tick = async (ms: number) => { await act(async () => { await jest.advanceTimersByTimeAsync(ms); }); };

const setAppState = (s: string) => { (AppState as any).currentState = s; };
beforeEach(() => { jest.useFakeTimers(); calls = []; goalsAnswers = []; conversationRows = []; setAppState("active"); });
afterEach(() => { jest.useRealTimers(); });

it("follows the plan run while it is in progress, then adds Mila's follow-up under the done card, once", async () => {
  goalsAnswers = [{ planning: { runId: RUN, step: "post_kits", startedAt: "x" } }, { planning: null }];
  conversationRows = [
    { id: "1", role: "user", content: "Refresh my plan", agentCards: null },
    { id: "2", role: "assistant", content: "On it.", agentCards: [progress("done")] },
    { id: "3", role: "assistant", content: "Your plan's ready: 3 posts this week.", agentCards: [ready] },
  ];
  const { result } = renderHook(() => useMilaChat());
  await act(async () => { await result.current.send("Refresh my plan"); });
  expect((result.current.messages[1].cards as any[])[0].payload.state).toBe("running");

  await tick(5000);   // still planning
  expect(calls.filter((u) => u.endsWith("/agent/goals"))).toHaveLength(1);
  expect(result.current.messages).toHaveLength(2);
  await tick(5000);   // over: the conversation is read once
  expect(calls.filter((u) => CID_RE.test(u))).toHaveLength(1);
  expect(result.current.messages).toHaveLength(3);
  expect((result.current.messages[1].cards as any[])[0].payload.state).toBe("done");
  expect(result.current.messages[2]).toMatchObject({ role: "assistant", content: "Your plan's ready: 3 posts this week.", cards: [ready] });
  // Nothing more is polled.
  await tick(20_000);
  expect(calls.filter((u) => u.endsWith("/agent/goals"))).toHaveLength(2);
});

it("while the app is in the background nothing is read; back in front, the card moves to the step the run is on", async () => {
  goalsAnswers = [{ planning: { runId: RUN, step: "post_kits", startedAt: "x" } }];
  const { result } = renderHook(() => useMilaChat());
  await act(async () => { await result.current.send("Refresh my plan"); });
  setAppState("background");
  await tick(15_000);
  expect(calls.filter((u) => u.endsWith("/agent/goals"))).toHaveLength(0);
  setAppState("active");
  await tick(5000);
  expect(calls.filter((u) => u.endsWith("/agent/goals"))).toHaveLength(1);
  expect((result.current.messages[1].cards as any[])[0].payload).toMatchObject({ state: "running", step: 1 });   // one step: of 1
});

it("a reopened chat draws its agent cards, and keeps following a plan still running", async () => {
  conversationRows = [
    { id: "1", role: "user", content: "Refresh my plan", agentCards: null },
    { id: "2", role: "assistant", content: "On it.", agentCards: [progress("running")] },
  ];
  goalsAnswers = [{ planning: { runId: RUN, step: "plan", startedAt: "x" } }];
  const { result } = renderHook(() => useMilaChat());
  await act(async () => { await result.current.openConversation("22222222-2222-4222-8222-222222222222"); });
  expect(result.current.messages[1].cards).toEqual([progress("running")]);
  await tick(5000);
  expect(calls.filter((u) => u.endsWith("/agent/goals"))).toHaveLength(1);
  // A new chat stops following.
  act(() => { result.current.newChat(); });
  await tick(30_000);
  expect(calls.filter((u) => u.endsWith("/agent/goals"))).toHaveLength(1);
});
