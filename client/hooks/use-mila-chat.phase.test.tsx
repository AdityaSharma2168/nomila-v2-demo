/**
 * use-mila-chat.phase.test — the hook's `phase` (what drives Mila's avatar + status pill) follows
 * the reply stream's real events: thinking on send and on a "thinking" status, tool on a "tool"
 * status, writing on the first token, idle on done / stop / a new chat. A superseded turn's late
 * events never move it. The transport is a hand-fed SSE reader, so each event lands on cue.
 */
import { act, renderHook } from "@testing-library/react-native";

type Chunk = { done: boolean; value?: Uint8Array };

/** One response body whose chunks the test pushes in by hand. */
function makeBody() {
  const queue: Chunk[] = [];
  let waiting: ((c: Chunk) => void) | null = null;
  const enc = new TextEncoder();
  const push = (c: Chunk) => {
    if (waiting) { const w = waiting; waiting = null; w(c); } else queue.push(c);
  };
  return {
    body: {
      getReader: () => ({
        read: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise<Chunk>((r) => { waiting = r; })),
      }),
    },
    event: (data: Record<string, unknown>, name?: string) =>
      push({ done: false, value: enc.encode(`${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(data)}\n\n`) }),
    end: () => push({ done: true }),
  };
}

let bodies: ReturnType<typeof makeBody>[] = [];

jest.mock("expo/fetch", () => ({
  fetch: jest.fn((_url: string, init: { signal: AbortSignal }) => {
    const b = makeBody();
    bodies.push(b);
    // An abort ends this body the way expo/fetch does: the pending read rejects.
    init.signal.addEventListener("abort", () => b.end());
    return Promise.resolve({ ok: true, status: 200, body: b.body });
  }),
}));
jest.mock("expo-crypto", () => ({ randomUUID: () => `id-${Math.random().toString(36).slice(2)}` }));
jest.mock("../lib/query-client", () => ({
  getApiUrl: () => "http://test",
  getAuthHeaders: async () => ({}),
}));

import { useMilaChat } from "./use-mila-chat";

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

beforeEach(() => { bodies = []; });

describe("useMilaChat phase", () => {
  it("thinking → tool → thinking → writing → idle, from the stream's own events", async () => {
    const { result } = renderHook(() => useMilaChat());
    expect(result.current.phase).toBe("idle");

    act(() => { void result.current.send("what's my score?"); });
    expect(result.current.phase).toBe("thinking");
    await flush();

    const b = bodies[0];
    b.event({ type: "status", message: "Thinking…", phase: "thinking" }, "status");
    await flush();
    expect(result.current.phase).toBe("thinking");

    b.event({ type: "status", message: "Checking your score…", phase: "tool" }, "status");
    await flush();
    expect(result.current.phase).toBe("tool");

    b.event({ type: "status", message: "Thinking…", phase: "thinking" }, "status");
    await flush();
    expect(result.current.phase).toBe("thinking");

    b.event({ token: "Your score " });
    await flush();
    expect(result.current.phase).toBe("writing");

    b.event({ done: true });
    await flush();
    expect(result.current.phase).toBe("idle");
    b.end();
    await flush();
  });

  it("reads a status from a server without `phase`: a tool's phrase is a tool round", async () => {
    const { result } = renderHook(() => useMilaChat());
    act(() => { void result.current.send("deals?"); });
    await flush();
    bodies[0].event({ type: "status", message: "Pulling up your deals…" }, "status");
    await flush();
    expect(result.current.phase).toBe("tool");
    bodies[0].event({ type: "status", message: "Thinking…" }, "status");
    await flush();
    expect(result.current.phase).toBe("thinking");
    act(() => result.current.stop());
    expect(result.current.phase).toBe("idle");
    await flush();
  });

  it("a superseded turn's late events never move the phase", async () => {
    const { result } = renderHook(() => useMilaChat());
    act(() => { void result.current.send("first"); });
    await flush();
    act(() => { void result.current.send("second"); });
    await flush();
    bodies[1].event({ token: "Hi" });
    await flush();
    expect(result.current.phase).toBe("writing");
    // The first body was ended by its abort; nothing it does now may reset the second turn.
    await flush();
    expect(result.current.phase).toBe("writing");
    act(() => result.current.newChat());
    expect(result.current.phase).toBe("idle");
    await flush();
  });
});
