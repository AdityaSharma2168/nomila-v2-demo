/**
 * use-mila-chat.stop.test — Stop asks the server to stop Mila (POST /api/v1/me/chat/stop with the open conversation),
 * because on the Mastra engine a dropped connection no longer stops a turn. It also still drops the stream. Nothing
 * in flight ⇒ no server call. The transport is a hand-fed SSE reader, as in use-mila-chat.phase.test.
 */
import { act, renderHook } from "@testing-library/react-native";

type Chunk = { done: boolean; value?: Uint8Array };
type Call = { url: string; init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } };

let calls: Call[] = [];

jest.mock("expo/fetch", () => ({
  fetch: jest.fn((url: string, init: Call["init"]) => {
    calls.push({ url, init });
    if (url.endsWith("/api/v1/me/chat/stop")) return Promise.resolve({ ok: true, status: 202, json: async () => ({ stopped: 1 }) });
    let waiting: ((c: Chunk) => void) | null = null;
    init.signal?.addEventListener("abort", () => waiting?.({ done: true }));
    return Promise.resolve({
      ok: true, status: 200,
      body: { getReader: () => ({ read: () => new Promise<Chunk>((r) => { waiting = r; }) }) },
    });
  }),
}));
jest.mock("expo-crypto", () => ({ randomUUID: () => "11111111-2222-4333-8444-555555555555" }));
jest.mock("../lib/query-client", () => ({
  getApiUrl: () => "http://test",
  getAuthHeaders: async () => ({ Authorization: "Bearer t" }),
}));

import { useMilaChat } from "./use-mila-chat";

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

beforeEach(() => { calls = []; });

describe("useMilaChat stop", () => {
  it("a reply in flight: Stop calls POST /me/chat/stop with the conversation, and drops the stream", async () => {
    const { result } = renderHook(() => useMilaChat());
    act(() => { void result.current.send("a long question"); });
    await flush();
    const chat = calls.find((c) => c.url.endsWith("/api/v1/me/chat"))!;
    expect(chat).toBeTruthy();

    act(() => result.current.stop());
    await flush();

    const stops = calls.filter((c) => c.url === "http://test/api/v1/me/chat/stop");
    expect(stops).toHaveLength(1);
    expect(stops[0].init.method).toBe("POST");
    expect(stops[0].init.headers).toMatchObject({ "Content-Type": "application/json", Authorization: "Bearer t" });
    expect(JSON.parse(stops[0].init.body!)).toEqual({ conversation_id: result.current.conversationId });
    expect(JSON.parse(chat.init.body!).conversation_id).toBe(result.current.conversationId);
    expect(chat.init.signal!.aborted).toBe(true);
    expect(result.current.phase).toBe("idle");
  });

  it("nothing in flight: Stop makes no server call", async () => {
    const { result } = renderHook(() => useMilaChat());
    act(() => result.current.stop());
    await flush();
    expect(calls).toHaveLength(0);
  });
});
