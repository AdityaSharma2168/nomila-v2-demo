/**
 * use-mila-chat.sharedThread.test — the Mila tab and Home's half-sheet are two useMilaChat instances but ONE
 * conversation: a surface shown after the other one talked re-reads the shared thread and continues it; a new chat on
 * one is a new (empty) chat on the other; a surface already current reads nothing. Transport mocked by URL.
 */
import { act, renderHook } from "@testing-library/react-native";

const CID_RE = /\/conversations\/([^/?]+)$/;
let calls: string[] = [];
const saved = new Map<string, unknown[]>();

function sse(events: Array<Record<string, unknown>>) {
  const enc = new TextEncoder();
  const chunks = events.map((e) => ({ done: false, value: enc.encode(`data: ${JSON.stringify(e)}\n\n`) }));
  chunks.push({ done: true } as any);
  return { getReader: () => ({ read: () => Promise.resolve(chunks.shift() ?? { done: true }) }) };
}

jest.mock("../lib/flags", () => ({ AGENT_V3: false }));
jest.mock("expo/fetch", () => ({
  fetch: jest.fn(async (url: string, init?: { body?: string }) => {
    calls.push(url);
    if (url.endsWith("/api/v1/me/chat")) {
      const body = JSON.parse(init?.body ?? "{}");
      const rows = saved.get(body.conversation_id) ?? [];
      saved.set(body.conversation_id, [...rows, { role: "user", content: body.message }, { role: "assistant", content: "Done." }]);
      return { ok: true, status: 200, body: sse([{ token: "Done." }, { done: true }]) };
    }
    const m = url.match(CID_RE);
    if (m) {
      const rows = saved.get(m[1]);
      return rows ? { ok: true, status: 200, json: async () => ({ messages: rows }) } : { ok: false, status: 404 };
    }
    return { ok: false, status: 404 };
  }),
}));
let n = 0;
jest.mock("expo-crypto", () => ({ randomUUID: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` }));
jest.mock("../lib/query-client", () => ({ getApiUrl: () => "http://test", getAuthHeaders: async () => ({}) }));

import { useMilaChat, activeMilaThread, resetActiveMilaThreadForTests } from "./use-mila-chat";

beforeEach(() => { calls = []; saved.clear(); resetActiveMilaThreadForTests(); });

it("both surfaces start on the same thread", () => {
  const tab = renderHook(() => useMilaChat());
  const sheet = renderHook(() => useMilaChat());
  expect(tab.result.current.conversationId).toBe(sheet.result.current.conversationId);
  expect(activeMilaThread().id).toBe(tab.result.current.conversationId);
});

it("what she said in the half-sheet is in the Mila tab when she opens it, and the tab continues it", async () => {
  const tab = renderHook(() => useMilaChat());
  const sheet = renderHook(() => useMilaChat());
  await act(async () => { await sheet.result.current.send("Draft a reply to the brand"); });
  await act(async () => { await tab.result.current.syncToActiveThread(); });
  expect(tab.result.current.messages.map((m) => m.content)).toEqual(["Draft a reply to the brand", "Done."]);
  await act(async () => { await tab.result.current.send("Make it shorter"); });
  await act(async () => { await sheet.result.current.syncToActiveThread(); });
  expect(sheet.result.current.messages.map((m) => m.content)).toEqual(["Draft a reply to the brand", "Done.", "Make it shorter", "Done."]);
  expect(saved.size).toBe(1);
});

it("a surface that is already current reads nothing", async () => {
  const sheet = renderHook(() => useMilaChat());
  await act(async () => { await sheet.result.current.send("Hi"); });
  calls = [];
  await act(async () => { await sheet.result.current.syncToActiveThread(); });
  expect(calls.filter((u) => CID_RE.test(u))).toHaveLength(0);
});

it("a new chat on one surface is a new, empty chat on the other", async () => {
  const tab = renderHook(() => useMilaChat());
  const sheet = renderHook(() => useMilaChat());
  await act(async () => { await tab.result.current.send("Old topic"); });
  await act(async () => { await sheet.result.current.syncToActiveThread(); });
  act(() => { tab.result.current.newChat(); });
  await act(async () => { await sheet.result.current.syncToActiveThread(); });
  expect(sheet.result.current.conversationId).toBe(tab.result.current.conversationId);
  expect(sheet.result.current.messages).toEqual([]);
});
