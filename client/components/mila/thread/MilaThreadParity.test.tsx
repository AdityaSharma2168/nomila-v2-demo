/**
 * MilaThreadParity.test — chat v2 does what today's chat does, with today's pieces: the real thread module (assistant-ui's
 * React Native primitives, the AI SDK runtime, our transport) over a stand-in network (expo/fetch), a stand-in voice
 * session, a stand-in camera roll and a stand-in upload. No provider, no server, no device.
 *
 *   Voice        today's voice button in the composer (only where voice is available); live, today's voice bar stands
 *                where the composer was; the session gets THIS conversation's id (the worker saves the spoken turns
 *                into it); spoken lines show live with today's collapse rule; a voice card shows with today's widget;
 *                a spoken turn is never sent (or retried) as a typed one
 *   Attachments  the ＋ opens today's sheet; a photo or video / a product go through our adapter onto the upload (a
 *                chip that uploads, then waits); Send carries ONLY their ids and roles; the bubble shows them; an
 *                attachment-only turn reads "Take a look at this."; remove; a failed upload is not sent; the one-time
 *                rights acknowledgment asks once and uploads again; at most 4; Retry sends them again; a contract opens
 *                today's contract sheet and its save tells Mila; search fills the composer
 *   Follow-ups   a saved chat's nav chips under the newest answer (a tap opens the screen; a request chip opens its
 *                sheet in place); a saved row's widget is drawn; opening a chat with an unread Mila message marks it seen
 */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo, Pressable, Text } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ─── The network: expo/fetch, routed by path ──────────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ReadableStream: NodeReadableStream } = require("node:stream/web");
const enc = new TextEncoder();
interface Sse { push: (part: Record<string, unknown>) => void; end: () => void; body: string }
function makeSse(body: string): { sse: Sse; stream: ReadableStream<Uint8Array> } {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const stream = new NodeReadableStream({ start(c: ReadableStreamDefaultController<Uint8Array>) { ctl = c; } });
  const sse: Sse = {
    body,
    push: (part) => { if (!closed) try { ctl.enqueue(enc.encode(`data: ${JSON.stringify(part)}\n\n`)); } catch { closed = true; } },
    end: () => { if (closed) return; closed = true; try { ctl.enqueue(enc.encode("data: [DONE]\n\n")); ctl.close(); } catch { /* cancelled */ } },
  };
  return { sse, stream };
}
const calls: Array<{ url: string; method: string; body?: string }> = [];
let streams: Sse[] = [];
let chatFails = 0;
let savedRows: Array<Record<string, unknown>> = [];
const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const mockFetch = jest.fn(async (url: string, init: RequestInit = {}) => {
  const method = (init.method ?? "GET").toUpperCase();
  calls.push({ url, method, body: typeof init.body === "string" ? init.body : undefined });
  if (url.endsWith("/api/v1/me/chat/v2")) {
    if (chatFails > 0) { chatFails--; return json(500, { error: "boom" }); }
    const { sse, stream } = makeSse(String(init.body));
    streams.push(sse);
    return { ok: true, status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body: stream } as unknown as Response;
  }
  if (/\/runs\/[^/]+$/.test(url)) return json(200, { runId: "r", status: "failed", messageIds: [], conversationId: null });
  if (/\/me\/conversations\//.test(url)) return json(200, { messages: savedRows });
  return json(404, {});
});
jest.mock("expo/fetch", () => ({ fetch: (url: string, init?: RequestInit) => mockFetch(url, init) }));
let uuid = 0;
jest.mock("expo-crypto", () => ({ randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` }));
jest.mock("../../../lib/query-client", () => ({
  getApiUrl: () => "https://dev.test",
  getAuthHeaders: async () => ({ Authorization: "Bearer t" }),
  apiRequest: async () => ({ ok: true, status: 200, json: async () => ({}) }),
}));
const mockSeen = jest.fn(async (_id: string) => {});
jest.mock("../../../lib/milaUnread", () => ({ markConversationSeen: (id: string) => mockSeen(id) }));

// ─── Today's pieces that reach native modules: stand-ins that say what they were given ─────────────────────────────
jest.mock("../MilaWidget", () => {
  const React = require("react");
  const { Pressable, Text } = require("react-native");
  return {
    MilaWidget: ({ widget, onReply, onOpenDeal }: { widget: { type: string; data: { brandName?: string; id?: string } }; onReply?: (b: string) => void; onOpenDeal?: (id: string) => void }) =>
      React.createElement(Pressable, { testID: `widget-${widget.type}`, onPress: () => onReply?.(widget.data.brandName ?? ""), onLongPress: () => onOpenDeal?.(widget.data.id ?? "") },
        React.createElement(Text, null, `widget:${widget.type}`)),
  };
});
jest.mock("../MilaAttachSheet", () => {
  const React = require("react");
  const { Pressable, Text, View } = require("react-native");
  return {
    MilaAttachSheet: ({ visible, onPick, onClose }: { visible: boolean; onPick: (k: string) => void; onClose: () => void }) =>
      visible ? React.createElement(View, { testID: "attach-sheet" }, ...["photo", "product", "contract", "search"].map((k) =>
        React.createElement(Pressable, { key: k, testID: `attach-${k}`, onPress: () => { onClose(); onPick(k); } }, React.createElement(Text, null, k)))) : null,
  };
});
jest.mock("../../deals/AddContractSheet", () => {
  const React = require("react");
  const { Pressable, Text } = require("react-native");
  return {
    AddContractSheet: ({ visible, requestId, onCreated }: { visible: boolean; requestId?: string; onCreated: () => void }) =>
      visible ? React.createElement(Pressable, { testID: `contract-sheet-${requestId ?? "none"}`, onPress: onCreated }, React.createElement(Text, null, "contract")) : null,
  };
});
jest.mock("../../requests/RequestDocumentSheet", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { RequestDocumentSheet: ({ visible, requestId }: { visible: boolean; requestId: string | null }) => (visible ? React.createElement(Text, { testID: `document-sheet-${requestId}` }, "doc") : null) };
});
jest.mock("../../media/RightsAckPanel", () => {
  const React = require("react");
  const { Pressable, Text } = require("react-native");
  return { RightsAckPanel: ({ onConfirm }: { onConfirm: () => void }) => React.createElement(Pressable, { testID: "rights-ack", onPress: onConfirm }, React.createElement(Text, null, "ack")) };
});
jest.mock("../../../hooks/use-media-library", () => {
  class RightsAckRequired extends Error { constructor() { super("rights_ack_required"); this.name = "RightsAckRequired"; } }
  return {
    pickFromCameraRoll: jest.fn(async () => null),
    useUploadMedia: () => ({ mutateAsync: jest.fn(), isPending: false }),
    RightsAckRequired,
  };
});
jest.mock("../useMilaVoice", () => ({ useMilaVoice: () => { throw new Error("the suite hands in its own voice"); } }));

jest.mock("expo-clipboard", () => ({ setStringAsync: async () => true }));
jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }) }));
jest.mock("../../../hooks/use-platform-oauth", () => ({ usePlatformOAuth: () => ({ connect: jest.fn(), disconnect: jest.fn(), connecting: false }) }));
jest.mock("../../../lib/agent/connect", () => ({ connectService: jest.fn(async () => true) }));
jest.mock("../../../lib/milaChats", () => ({ confirmDeleteChat: jest.fn(async () => false) }));
jest.mock("../SavedChatsSheet", () => ({ SavedChatsSheet: () => null }));
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
    useVideoPlayer: (src: unknown) => { const ref = React.useRef(null); if (!ref.current) ref.current = { source: src, play: jest.fn(), pause: jest.fn() }; return ref.current; },
    VideoView: (props: Record<string, unknown>) => React.createElement(require("react-native").View, props),
  };
});

import { MilaThreadScreen } from "./MilaThreadScreen";
import { sharedThread } from "./useMilaThread";
import type { UseMilaVoice } from "../useMilaVoice";
import { RightsAckRequired } from "../../../hooks/use-media-library";

// ─── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────
const flush = (n = 6) => act(async () => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10)); });
const chatPosts = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/api/v1/me/chat/v2"));
const bodyOf = (i: number) => JSON.parse(chatPosts()[i].body!);
function completeTurn(s: Sse, runId: string, text: string) {
  s.push({ type: "start", messageId: runId, messageMetadata: { runId } });
  s.push({ type: "text-start", id: "t1" });
  s.push({ type: "text-delta", id: "t1", delta: text });
  s.push({ type: "text-end", id: "t1" });
  s.push({ type: "data-mila-done", data: { runId, status: "completed", stopReason: null, messageIds: [] } });
  s.push({ type: "finish", finishReason: "stop" });
  s.end();
}

// The voice session, as the screen sees it: its state, and the callbacks the screen handed it.
type VoiceOpts = Parameters<NonNullable<import("./useMilaThread").MilaThreadOptions["useVoice"]>>[0];
let voiceOpts: VoiceOpts | null = null;
const toggle = jest.fn();
let setVoice: (v: Partial<UseMilaVoice>) => void = () => {};
function useFakeVoice(opts: VoiceOpts): UseMilaVoice {
  voiceOpts = opts;
  const [v, set] = React.useState<UseMilaVoice>({ state: "idle", error: null, notice: null, supported: true, toggle, active: false, justEnded: false });
  setVoice = (p) => set((prev) => ({ ...prev, ...p }));
  return v;
}

// The camera roll and the upload.
type Asset = { uri: string; type: "image" | "video"; fileName?: string; mimeType?: string };
let picked: Asset[] = [];
const pick = jest.fn(async () => ({ assets: picked }));
let uploadGate: Promise<void> = Promise.resolve();
let uploadFails: Array<"ack" | "error"> = [];
type Uploaded = { asset_id: string; media_type: string; url: string | null; thumb_url: string | null };
let uploads = 0;
const upload = jest.fn(async (input: { asset: Asset; ackRights?: boolean; role?: string }): Promise<Uploaded> => {
  await uploadGate;
  const f = uploadFails.shift();
  if (f === "ack") throw new RightsAckRequired();
  if (f === "error") throw new Error("Upload failed (500)");
  const n: number = ++uploads;
  return { asset_id: `a0000000-0000-4000-8000-00000000000${n}`, media_type: input.asset.type === "video" ? "VIDEO" : "IMAGE", url: `https://cdn.test/${n}.jpg`, thumb_url: `https://cdn.test/${n}-t.jpg` };
});

const onNavigate = jest.fn();
const onClose = jest.fn();
function renderThread(props: Record<string, unknown> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  return render(
    <QueryClientProvider client={qc}>
      <MilaThreadScreen
        visible
        onClose={onClose}
        onNavigate={onNavigate}
        presentation="tab"
        threadOptions={{ pollMs: 20, pollCap: 5, waitGraceMs: 0, useVoice: useFakeVoice, pick: pick as never, upload: upload as never }}
        {...props}
      />
    </QueryClientProvider>,
  );
}
async function attach(kind: "photo" | "product" | "contract" | "search") {
  fireEvent.press(screen.getByTestId("thread-add"));
  await flush(1);
  fireEvent.press(screen.getByTestId(`attach-${kind}`));
  await flush();
}

beforeEach(() => {
  calls.length = 0;
  streams = [];
  chatFails = 0;
  savedRows = [];
  picked = [{ uri: "file:///roll/1.jpg", type: "image", fileName: "1.jpg", mimeType: "image/jpeg" }];
  uploadGate = Promise.resolve();
  uploadFails = [];
  uploads = 0;
  voiceOpts = null;
  sharedThread.id = null;
  sharedThread.rev = 0;
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
});
afterEach(() => {
  for (const s of streams) s.end();
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

// ─── Voice ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("voice (today's session, on this thread)", () => {
  it("today's voice button sits in the composer and toggles the session; live, the voice bar stands where the composer was", async () => {
    renderThread();
    await flush();
    const btn = screen.getByLabelText("Start voice");
    fireEvent.press(btn);
    expect(toggle).toHaveBeenCalledTimes(1);
    act(() => setVoice({ state: "listening", active: true }));
    expect(screen.queryByTestId("thread-input")).toBeNull();
    expect(screen.getByTestId("mila-voice-bar")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("End voice session"));
    expect(toggle).toHaveBeenCalledTimes(2);
    act(() => setVoice({ state: "idle", active: false, justEnded: true, error: "Voice failed — try again." }));
    expect(screen.getByTestId("thread-input")).toBeTruthy();
    expect(screen.getByTestId("thread-voice-status").props.children).toBe("Voice failed — try again.");
  });

  it("no voice button where voice is not available", async () => {
    renderThread();
    await flush();
    act(() => setVoice({ supported: false }));
    expect(screen.queryByLabelText("Start voice")).toBeNull();
  });

  it("the session gets this conversation's id (the worker saves spoken turns into it); a new chat hands it the new id", async () => {
    renderThread();
    await flush();
    const first = voiceOpts!.conversationId;
    expect(first).toMatch(/^00000000-/);
    fireEvent.changeText(screen.getByTestId("thread-input"), "hi");
    await flush(1);
    fireEvent.press(screen.getByTestId("thread-send"));
    await flush();
    expect(bodyOf(0).conversationId).toBe(first);
    completeTurn(streams[0], "run-1", "Hello.");
    await flush();
    fireEvent.press(screen.getByTestId("thread-new-chat"));
    await flush();
    expect(voiceOpts!.conversationId).not.toBe(first);
  });

  it("spoken lines show live (a growing line is rewritten, not repeated); a voice card shows with today's widget; neither is sent", async () => {
    renderThread();
    await flush();
    act(() => voiceOpts!.onTranscript!({ streamId: "u1", role: "user", text: "how are my", done: false }));
    act(() => voiceOpts!.onTranscript!({ streamId: "u1", role: "user", text: "How are my deals?", done: true }));
    act(() => voiceOpts!.onTranscript!({ streamId: "m1", role: "assistant", text: "Two need you.", done: true }));
    await flush();
    expect(screen.getAllByText("How are my deals?")).toHaveLength(1);
    expect(screen.queryByText("how are my")).toBeNull();
    expect(screen.getByText("Two need you.")).toBeTruthy();
    act(() => voiceOpts!.onWidget!({ line: "Here is the Northpeak deal.", widget: { type: "deal_card", data: { id: "d1", brandName: "Northpeak" } } as never }));
    await flush();
    expect(screen.getByText("Here is the Northpeak deal.")).toBeTruthy();
    expect(screen.getByTestId("widget-deal_card")).toBeTruthy();
    // Nothing went to the chat route: the voice worker saves spoken turns.
    expect(chatPosts()).toHaveLength(0);
    // The widget's Reply asks Mila, as today ("Draft a reply to the … deal.").
    fireEvent.press(screen.getByTestId("widget-deal_card"));
    await flush();
    expect(bodyOf(0).message).toEqual({ text: "Draft a reply to the Northpeak deal." });
    // Its Open goes to the deal.
    completeTurn(streams[0], "run-2", "Drafted.");
    await flush();
    fireEvent(screen.getByTestId("widget-deal_card"), "longPress");
    expect(onNavigate).toHaveBeenCalledWith({ screen: "deal_detail", dealId: "d1" });
  });

  it("a spoken line after a failed typed turn ends that turn's moment: no Retry, and nothing is resent", async () => {
    chatFails = 1;
    renderThread();
    await flush();
    fireEvent.changeText(screen.getByTestId("thread-input"), "Typed question");
    await flush(1);
    fireEvent.press(screen.getByTestId("thread-send"));
    await flush();
    act(() => voiceOpts!.onTranscript!({ streamId: "u9", role: "user", text: "spoken words", done: true }));
    await flush();
    // A spoken line ends the failed turn's moment: nothing to retry until a typed turn fails again.
    expect(screen.queryByTestId("thread-retry")).toBeNull();
    expect(chatPosts()).toHaveLength(1);
  });

  it("a typed reply that drops while a spoken line lands after it is still caught up from the server", async () => {
    renderThread();
    await flush();
    fireEvent.changeText(screen.getByTestId("thread-input"), "Typed question");
    await flush(1);
    fireEvent.press(screen.getByTestId("thread-send"));
    await flush();
    streams[0].push({ type: "start", messageId: "run-7", messageMetadata: { runId: "run-7" } });
    streams[0].push({ type: "text-start", id: "t1" });
    streams[0].push({ type: "text-delta", id: "t1", delta: "Half an ans" });
    await flush();
    // She starts talking while the typed reply is still coming; then the stream drops (no data-mila-done).
    act(() => voiceOpts!.onTranscript!({ streamId: "u3", role: "user", text: "and my rates?", done: true }));
    await flush();
    streams[0].end();
    await flush(12);
    expect(calls.some((c) => c.method === "GET" && /\/chat\/v2\/runs\/run-7$/.test(c.url))).toBe(true);
    expect(chatPosts()).toHaveLength(1);
  });
});

// ─── Attachments ──────────────────────────────────────────────────────────────────────────────────────────────────

describe("attachments (today's ＋, through assistant-ui's composer attachments and our adapter)", () => {
  it("a photo uploads as a chip, then Send carries only its id and role with the text; the bubble shows it", async () => {
    let release!: () => void;
    uploadGate = new Promise<void>((r) => { release = r; });
    renderThread();
    await flush();
    await attach("photo");
    expect(pick).toHaveBeenCalledWith("all", { multiple: true, selectionLimit: 4 });
    expect(screen.getByTestId("thread-attachment-chip-uploading")).toBeTruthy();
    await act(async () => { release(); });
    await flush();
    expect(screen.queryByTestId("thread-attachment-chip-uploading")).toBeNull();
    expect(screen.getByTestId("thread-attachment-chip")).toBeTruthy();
    expect(upload).toHaveBeenCalledWith({ asset: picked[0], ackRights: undefined, role: undefined });
    expect(screen.getByTestId("thread-input").props.placeholder).toBe("Say something about it, or just send");

    fireEvent.changeText(screen.getByTestId("thread-input"), "What do you think?");
    await flush(1);
    fireEvent.press(screen.getByTestId("thread-send"));
    await flush();
    expect(bodyOf(0)).toEqual({
      conversationId: expect.any(String),
      message: { text: "What do you think?", attachments: [{ asset_id: "a0000000-0000-4000-8000-000000000001", role: "photo" }] },
    });
    expect(screen.queryByTestId("thread-attachment-chip")).toBeNull();
    expect(screen.getByTestId("mila-bubble-thumbs")).toBeTruthy();
    expect(screen.getByText("What do you think?")).toBeTruthy();
  });

  it("a product (photos only, tagged for Studio) sent on its own reads \"Take a look at this.\"", async () => {
    renderThread();
    await flush();
    await attach("product");
    expect(pick).toHaveBeenCalledWith("photo", { multiple: true, selectionLimit: 4 });
    expect(upload).toHaveBeenCalledWith({ asset: picked[0], ackRights: undefined, role: "product" });
    fireEvent.press(screen.getByTestId("thread-send"));
    await flush();
    expect(bodyOf(0).message).toEqual({ text: "Take a look at this.", attachments: [{ asset_id: "a0000000-0000-4000-8000-000000000001", role: "product" }] });
    expect(screen.getByText("Take a look at this.")).toBeTruthy();
  });

  it("a video is sent as a video; a removed chip is not sent; a failed upload shows and is not sent", async () => {
    picked = [
      { uri: "file:///roll/v.mov", type: "video", mimeType: "video/quicktime" },
      { uri: "file:///roll/2.jpg", type: "image" },
      { uri: "file:///roll/3.jpg", type: "image" },
    ];
    uploadFails = [];
    renderThread();
    await flush();
    // Second upload ok, third fails.
    upload.mockImplementationOnce(async () => ({ asset_id: "b0000000-0000-4000-8000-000000000001", media_type: "VIDEO", url: null, thumb_url: null }) as never);
    upload.mockImplementationOnce(async () => ({ asset_id: "b0000000-0000-4000-8000-000000000002", media_type: "IMAGE", url: "u", thumb_url: "t" }) as never);
    upload.mockImplementationOnce(async () => { throw new Error("Upload failed (500)"); });
    await attach("photo");
    expect(screen.getAllByTestId("thread-attachment-chip").length).toBe(3);
    expect(screen.getByTestId("thread-attachment-chip-failed")).toBeTruthy();
    // Remove the photo (the second chip).
    fireEvent.press(screen.getAllByLabelText("Remove attachment")[1]);
    await flush();
    fireEvent.changeText(screen.getByTestId("thread-input"), "Look");
    await flush(1);
    fireEvent.press(screen.getByTestId("thread-send"));
    await flush();
    expect(bodyOf(0).message).toEqual({ text: "Look", attachments: [{ asset_id: "b0000000-0000-4000-8000-000000000001", role: "video" }] });
  });

  it("the one-time rights acknowledgment: the pick waits, today's panel asks once, then it uploads with ackRights", async () => {
    uploadFails = ["ack"];
    renderThread();
    await flush();
    await attach("photo");
    expect(screen.queryByTestId("thread-attachment-chip")).toBeNull();
    fireEvent.press(screen.getByTestId("rights-ack"));
    await flush();
    expect(upload).toHaveBeenLastCalledWith({ asset: picked[0], ackRights: true, role: undefined });
    expect(screen.queryByTestId("rights-ack")).toBeNull();
    expect(screen.getByTestId("thread-attachment-chip")).toBeTruthy();
  });

  it("at most 4: the picker is asked only for the room left, and a full composer does not open it", async () => {
    picked = [1, 2, 3].map((i) => ({ uri: `file:///roll/${i}.jpg`, type: "image" as const }));
    renderThread();
    await flush();
    await attach("photo");
    expect(screen.getAllByTestId("thread-attachment-chip")).toHaveLength(3);
    await attach("photo");
    expect(pick).toHaveBeenLastCalledWith("all", { multiple: true, selectionLimit: 1 });
    expect(screen.getAllByTestId("thread-attachment-chip")).toHaveLength(4);
    pick.mockClear();
    await attach("photo");
    expect(pick).not.toHaveBeenCalled();
  });

  it("Retry after a failed turn sends the same text and attachments again", async () => {
    chatFails = 1;
    renderThread();
    await flush();
    await attach("photo");
    fireEvent.changeText(screen.getByTestId("thread-input"), "Thoughts?");
    await flush(1);
    fireEvent.press(screen.getByTestId("thread-send"));
    await flush();
    fireEvent.press(screen.getByTestId("thread-retry"));
    await flush();
    expect(bodyOf(1)).toEqual(bodyOf(0));
    expect(bodyOf(1).message.attachments).toHaveLength(1);
  });

  it("a contract opens today's contract sheet, and saving it tells Mila; search fills the composer, never sends", async () => {
    renderThread();
    await flush();
    await attach("contract");
    fireEvent.press(screen.getByTestId("contract-sheet-none"));
    await flush();
    expect(bodyOf(0).message).toEqual({ text: "I just added a contract. What should I know about it?" });
    completeTurn(streams[0], "run-c", "Got it.");
    await flush();
    await attach("search");
    expect(screen.getByTestId("thread-input").props.value).toBe("Search the web for ");
    expect(chatPosts()).toHaveLength(1);
  });

  it("nothing but text goes up when nothing is attached (the body stays { conversationId, message: { text } })", async () => {
    renderThread();
    await flush();
    fireEvent.changeText(screen.getByTestId("thread-input"), "Plain");
    await flush(1);
    fireEvent.press(screen.getByTestId("thread-send"));
    await flush();
    expect(Object.keys(bodyOf(0).message)).toEqual(["text"]);
  });
});

// ─── Follow-ups, saved widgets, opening a saved chat ──────────────────────────────────────────────────────────────

describe("follow-ups and saved chats", () => {
  const CONV = "11111111-1111-4111-8111-111111111111";

  it("a saved chat's nav chips show under the newest answer; a tap closes the chat and opens the screen", async () => {
    savedRows = [
      { id: 1, role: "user", content: "What next?" },
      { id: 2, role: "assistant", content: "Look at your deals.", app_actions: [
        { label: "Open deals", target: { screen: "deals" } }, { label: "Junk", target: {} },
        // The model's output, saved: an unknown screen, a prototype key, a link, or a deal without its id never shows.
        { label: "Unknown", target: { screen: "admin" } }, { label: "Proto", target: { screen: "constructor" } },
        { label: "Link", target: { screen: "https://evil.test" } }, { label: "No id", target: { screen: "deal" } },
        { label: "Booking", target: { screen: "booking", bookingId: "b-1" } },
      ] },
    ];
    renderThread({ initialConversationId: CONV });
    await flush();
    expect(screen.getByTestId("mila-nav-chips")).toBeTruthy();
    for (const gone of ["Junk", "Unknown", "Proto", "Link", "No id"]) expect(screen.queryByText(gone)).toBeNull();
    expect(screen.getByText("Booking")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Open deals"));
    expect(onClose).toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith({ screen: "deals" });
  });

  it("only under the NEWEST answer, and not while a reply is coming", async () => {
    savedRows = [
      { id: 1, role: "assistant", content: "Older.", app_actions: [{ label: "Open deals", target: { screen: "deals" } }] },
      { id: 2, role: "assistant", content: "Newest." },
    ];
    renderThread({ initialConversationId: CONV });
    await flush();
    expect(screen.queryByTestId("mila-nav-chips")).toBeNull();
  });

  it("a request chip opens its sheet in place, over the conversation (nothing is created until she saves)", async () => {
    savedRows = [{ id: 2, role: "assistant", content: "Can you add these?", app_actions: [
      { label: "Add the contract", target: { screen: "add_contract", requestId: "req-1" } },
      { label: "Add the stats", target: { screen: "add_document", requestId: "req-2" } },
    ] }];
    renderThread({ initialConversationId: CONV });
    await flush();
    fireEvent.press(screen.getByLabelText("Add the contract"));
    await flush();
    expect(screen.getByTestId("contract-sheet-req-1")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Add the stats"));
    await flush();
    expect(screen.getByTestId("document-sheet-req-2")).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId("contract-sheet-req-1"));
    await flush();
    expect(bodyOf(0).message.text).toBe("I just added the contract you asked me for. What should I know about it?");
  });

  it("a saved row's widget is drawn with today's MilaWidget; opening a chat with an unread Mila message marks it seen", async () => {
    savedRows = [{ id: 5, role: "assistant", content: "Your deal:", widget: { type: "deal_card", data: { id: "d9", brandName: "Trailmark" } }, unread: true, milaStarted: true }];
    renderThread({ initialConversationId: CONV, initialMessageId: "5" });
    await flush();
    expect(screen.getByTestId("widget-deal_card")).toBeTruthy();
    expect(mockSeen).toHaveBeenCalledWith(CONV);
  });

  it("a chat with nothing unread is not marked", async () => {
    savedRows = [{ id: 5, role: "assistant", content: "Hi." }];
    renderThread({ initialConversationId: CONV });
    await flush();
    expect(mockSeen).not.toHaveBeenCalled();
  });

  it("Mila's camera-roll offer shows at the top of a conversation too (today's chat)", async () => {
    savedRows = [{ id: 5, role: "assistant", content: "Hi." }];
    const onPress = jest.fn();
    renderThread({ initialConversationId: CONV, offer: { label: "Review 12 new photos", onPress } });
    await flush();
    fireEvent.press(screen.getByLabelText("Review 12 new photos"));
    expect(onPress).toHaveBeenCalled();
  });
});

// Keep the unused imports honest for the linter (Pressable/Text are used by the stand-ins through require()).
void Pressable; void Text;
