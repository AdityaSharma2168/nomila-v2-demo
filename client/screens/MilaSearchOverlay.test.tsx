/**
 * MilaSearchOverlay.test — Mila's floating header stays on screen in BOTH the empty state and the
 * conversation, its frosted label reads what the chat/voice hooks say she's doing, the old pink bolt orb is
 * gone from her labels (her still image is there instead), and the top-bar buttons still work.
 *
 * Muse behaviour (owner, 8 Oct 2026): a tap on the transcript or a drag puts the keyboard away and sending does too;
 * the transcript follows the newest message only while she is at the end; the top bar is ONE frosted menu (saved
 * chats, new chat, delete) and ONE visible action (new chat) — no close, the bottom tabs are how she leaves.
 *
 * The chat and voice hooks are stand-ins the test drives directly; everything the overlay merely
 * hosts (sheets, widgets) renders nothing. expo-video is mocked as in MilaAvatar.test; expo-blur's
 * BlurView is a plain View.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import React from "react";
import { AccessibilityInfo, Keyboard, Modal, ScrollView } from "react-native";
import type { MilaMessage } from "../hooks/use-mila-chat";

const chat = {
  send: jest.fn(),
  stop: jest.fn(),
  newChat: jest.fn(),
  openConversation: jest.fn(),
  syncToActiveThread: jest.fn(async () => {}),
  appendTranscript: jest.fn(),
  appendWidgetMessage: jest.fn(),
  streaming: false,
  phase: "idle" as "idle" | "thinking" | "tool" | "writing",
  messages: [] as MilaMessage[],
  conversationId: "c-1",
};
const voice = {
  supported: false,
  state: "idle" as "idle" | "connecting" | "listening" | "speaking" | "error",
  active: false,
  error: null,
  notice: null,
  justEnded: false,
  toggle: jest.fn(),
};

jest.mock("../hooks/use-mila-chat", () => ({ useMilaChat: () => chat }));
jest.mock("../components/mila/useMilaVoice", () => ({ useMilaVoice: () => voice }));
jest.mock("../hooks/use-media-library", () => ({
  pickFromCameraRoll: jest.fn(),
  useUploadMedia: () => ({ mutateAsync: jest.fn(), isPending: false }),
  RightsAckRequired: class extends Error {},
}));
jest.mock("../components/media/RightsAckPanel", () => ({ RightsAckPanel: () => null }));
jest.mock("../components/mila/MilaAttachSheet", () => ({ MilaAttachSheet: () => null }));
jest.mock("../components/deals/AddContractSheet", () => ({ AddContractSheet: () => null }));
jest.mock("../components/requests/RequestDocumentSheet", () => ({ RequestDocumentSheet: () => null }));
jest.mock("../components/mila/MilaWidget", () => ({ MilaWidget: () => null }));
jest.mock("../components/agent/AgentCard", () => ({ AgentCardList: () => null }));
jest.mock("../lib/agent/connect", () => ({ connectService: jest.fn() }));
jest.mock("../components/mila/SavedChatsSheet", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { SavedChatsSheet: ({ visible }: { visible: boolean }) => (visible ? React.createElement(View, { testID: "saved-chats-sheet" }) : null) };
});
jest.mock("../components/mila/MilaProfileConfirm", () => ({ MilaProfileConfirm: () => null }));
jest.mock("../components/mila/MilaVoiceButton", () => ({ MilaVoiceButton: () => null }));
jest.mock("../components/mila/MilaVoiceBar", () => ({ MilaVoiceBar: () => null }));
const mockConfirmDelete = jest.fn();
jest.mock("../lib/milaChats", () => ({ confirmDeleteChat: (...a: unknown[]) => mockConfirmDelete(...a) }));
jest.mock("../lib/haptics", () => ({ haptics: { press: jest.fn() } }));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
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
// Icons as Text carrying their glyph name, so a lingering bolt is findable.
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
    VideoView: (props: Record<string, unknown>) => {
      const { View } = require("react-native");
      return React.createElement(View, { testID: "mila-video", ...props });
    },
  };
});

import { MilaSearchOverlay } from "./MilaSearchOverlay";
import { MilaHeader } from "../components/mila/MilaHeader";
import { MilaChatMenu } from "../components/mila/MilaChatMenu";
import { openersFor } from "./milaOpeners";

const CONVO: MilaMessage[] = [
  { id: "u-1", role: "user", content: "How are my deals?" },
  { id: "a-2", role: "assistant", content: "Two are waiting on you." },
  { id: "u-3", role: "user", content: "Which first?" },
  { id: "a-4", role: "assistant", content: "The one with the deadline." },
];

beforeEach(() => {
  jest.useFakeTimers();
  chat.messages = [];
  chat.send.mockClear();
  chat.newChat.mockClear();
  mockConfirmDelete.mockReset();
  chat.phase = "idle";
  chat.streaming = false;
  voice.state = "idle";
  voice.active = false;
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
  jest.spyOn(AccessibilityInfo, "addEventListener").mockImplementation(() => ({ remove: jest.fn() }) as never);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/** Let the reduce-motion reads resolve inside act. */
const settle = () => act(async () => {});
const status = () => screen.getByTestId("mila-status");
/** Idle: the label is her name alone, no second line. */
const expectIdle = () => {
  expect(screen.getByTestId("mila-name")).toHaveTextContent("Mila");
  expect(screen.queryByTestId("mila-status")).toBeNull();
};
/** Past the 1.2s hold so the latest state is showing. */
const hold = async () => {
  act(() => { jest.advanceTimersByTime(1500); });
  await settle(); // a new loop remounts her video, which reads reduce-motion again
};

describe("MilaSearchOverlay floating header", () => {
  it("shows her header with her name in the empty state", async () => {
    render(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await settle();
    expect(screen.getByTestId("mila-header")).toBeTruthy();
    expectIdle();
    // Reduce motion is on in this suite: the header's avatar is her still alone, no video view over it.
    expect(screen.getByTestId("mila-avatar-still")).toBeTruthy();
    expect(screen.queryByTestId("mila-video")).toBeNull();
  });

  it("keeps the header once a conversation exists", async () => {
    chat.messages = CONVO;
    render(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await settle();
    expect(screen.getByTestId("mila-header")).toBeTruthy();
    expectIdle();
    expect(screen.getByText("The one with the deadline.")).toBeTruthy();
  });

  it("the label follows the reply's phase: thinking, looking things up, writing, then back to her name", async () => {
    chat.messages = CONVO;
    const ui = render(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await settle();
    const step = async (phase: typeof chat.phase, streaming: boolean) => {
      chat.phase = phase;
      chat.streaming = streaming;
      ui.rerender(<MilaSearchOverlay visible onClose={jest.fn()} />);
      await hold();
    };
    await step("thinking", true);
    expect(status()).toHaveTextContent("Generating…");
    await step("tool", true);
    expect(status()).toHaveTextContent("Looking things up…");
    await step("writing", true);
    expect(status()).toHaveTextContent("Writing…");
    await step("idle", false);
    expectIdle();
  });

  it("voice: speaking and listening come from the room's state", async () => {
    const ui = render(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await settle();
    voice.state = "speaking";
    voice.active = true;
    ui.rerender(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await hold();
    expect(status()).toHaveTextContent("Speaking");
    voice.state = "listening";
    ui.rerender(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await hold();
    expect(status()).toHaveTextContent("Listening");
  });

  it("she is small in a typed conversation and grows back to full size while voice is live", async () => {
    chat.messages = CONVO;
    const ui = render(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await settle();
    expect(ui.UNSAFE_getByType(MilaHeader).props.compact).toBe(true);
    voice.state = "speaking";
    voice.active = true;
    ui.rerender(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await hold();
    expect(ui.UNSAFE_getByType(MilaHeader).props.compact).toBe(false);
    expect(screen.getByTestId("mila-name")).toHaveTextContent("Mila");
    expect(status()).toHaveTextContent("Speaking");
  });

  it("no pink bolt orb beside her labels — her still image instead, once per run of her turns", async () => {
    chat.messages = CONVO;
    render(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await settle();
    expect(screen.queryAllByTestId("icon-zap")).toHaveLength(0);
    expect(screen.getAllByTestId("mila-label-avatar")).toHaveLength(2);
    // Still images, not more avatars: the header's is the only one (a still alone, as reduce motion is on here).
    expect(screen.getAllByTestId("mila-avatar-still")).toHaveLength(1);
    expect(screen.queryAllByTestId("mila-video")).toHaveLength(0);
  });

  it("the header takes no touches; Muse's two controls sit over it — one menu, one new-chat action, no close", async () => {
    chat.messages = CONVO;
    render(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await settle();
    expect(screen.getByTestId("mila-header").props.pointerEvents).toBe("none");
    expect(screen.getByLabelText("Chat menu")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("New chat"));
    expect(chat.newChat).toHaveBeenCalledTimes(1);
    // The old row of four is gone: no close, and saved chats / delete wait inside the menu.
    expect(screen.queryByLabelText("Close")).toBeNull();
    expect(screen.queryByLabelText("Saved chats")).toBeNull();
    expect(screen.queryByLabelText("Delete this chat")).toBeNull();
    // No title beside her: the avatar and her name are the identity.
    expect(screen.queryByText("Ask Mila")).toBeNull();
  });

  it("the top controls are frosted circles with no outline", async () => {
    chat.messages = CONVO;
    render(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await settle();
    // The header label + the two controls (+ the composer's glass).
    expect(screen.getAllByTestId("frost-blur").length).toBeGreaterThanOrEqual(3);
    for (const name of ["Chat menu", "New chat"]) {
      const btn = screen.getByLabelText(name);
      const style = ([] as unknown[]).concat(btn.props.style ?? []).flat(4)
        .reduce<Record<string, unknown>>((a, s) => (s && typeof s === "object" ? { ...a, ...(s as Record<string, unknown>) } : a), {});
      expect(style.borderWidth ?? 0).toBe(0);
    }
  });

  it("the first entry (onboarding) shows no controls at all", async () => {
    render(<MilaSearchOverlay visible variant="onboarding" onClose={jest.fn()} />);
    await settle();
    expect(screen.queryByLabelText("Chat menu")).toBeNull();
    expect(screen.queryByLabelText("New chat")).toBeNull();
  });
});

describe("the one menu (saved chats, new chat, delete)", () => {
  /** Open the menu, pick a row, and let the menu finish dismissing (iOS runs the pick from onDismiss). */
  const pick = async (ui: ReturnType<typeof render>, label: string) => {
    fireEvent.press(screen.getByLabelText("Chat menu"));
    expect(screen.getByTestId("mila-chat-menu")).toBeTruthy();
    const modal = ui.UNSAFE_getByType(MilaChatMenu).findByType(Modal);
    fireEvent.press(within(screen.getByTestId("mila-chat-menu")).getByLabelText(label));
    await act(async () => { modal.props.onDismiss?.(); });
  };

  it("lists saved chats, new chat and delete (delete only with something on screen), as a frosted popover", async () => {
    chat.messages = CONVO;
    const ui = render(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await settle();
    expect(screen.queryByTestId("mila-chat-menu")).toBeNull();
    fireEvent.press(screen.getByLabelText("Chat menu"));
    const menu = within(screen.getByTestId("mila-chat-menu"));
    for (const label of ["Saved chats", "New chat", "Delete this chat"]) expect(menu.getByLabelText(label)).toBeTruthy();
    ui.unmount();

    chat.messages = [];
    render(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await settle();
    fireEvent.press(screen.getByLabelText("Chat menu"));
    expect(within(screen.getByTestId("mila-chat-menu")).queryByLabelText("Delete this chat")).toBeNull();
  });

  it("Saved chats opens the saved-chats sheet and closes the menu", async () => {
    chat.messages = CONVO;
    const ui = render(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await settle();
    await pick(ui, "Saved chats");
    expect(screen.queryByTestId("mila-chat-menu")).toBeNull();
    expect(screen.getByTestId("saved-chats-sheet")).toBeTruthy();
  });

  it("New chat in the menu starts a fresh conversation", async () => {
    chat.messages = CONVO;
    const ui = render(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await settle();
    await pick(ui, "New chat");
    expect(chat.newChat).toHaveBeenCalledTimes(1);
  });

  it("Delete this chat asks first; only a confirmed delete clears the screen", async () => {
    chat.messages = CONVO;
    const ui = render(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await settle();
    mockConfirmDelete.mockResolvedValueOnce(false);
    await pick(ui, "Delete this chat");
    expect(mockConfirmDelete).toHaveBeenCalledWith("c-1");
    expect(chat.newChat).not.toHaveBeenCalled();
    mockConfirmDelete.mockResolvedValueOnce(true);
    await pick(ui, "Delete this chat");
    expect(chat.newChat).toHaveBeenCalledTimes(1);
  });
});

describe("keyboard and scrolling (Muse)", () => {
  const transcript = (ui: ReturnType<typeof render>) =>
    ui.UNSAFE_getAllByType(ScrollView).find((n) => n.props.testID === "mila-transcript")!;
  const scrollEvent = (y: number, content = 2000, viewport = 600) => ({
    nativeEvent: { contentOffset: { x: 0, y }, contentSize: { width: 390, height: content }, layoutMeasurement: { width: 390, height: viewport } },
  });

  it("a tap on the transcript puts the keyboard away; a drag does too (interactive on iOS)", async () => {
    chat.messages = CONVO;
    const ui = render(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await settle();
    const dismiss = jest.spyOn(Keyboard, "dismiss").mockImplementation(() => {});
    fireEvent.press(screen.getByTestId("mila-transcript-tap"));
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(transcript(ui).props.keyboardDismissMode).toBe("interactive");
  });

  it("sending puts the keyboard away so the reply has the screen", async () => {
    render(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await settle();
    const dismiss = jest.spyOn(Keyboard, "dismiss").mockImplementation(() => {});
    fireEvent.changeText(screen.getByPlaceholderText("Ask Mila anything"), "How are my deals?");
    fireEvent.press(screen.getByLabelText("Send"));
    expect(chat.send).toHaveBeenCalled();
    expect(dismiss).toHaveBeenCalled();
  });

  it("a conversation sits at the bottom, just above the composer", async () => {
    chat.messages = CONVO;
    render(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await settle();
    const style = ([] as unknown[]).concat(screen.getByTestId("mila-transcript-tap").props.style ?? []).flat(4)
      .reduce<Record<string, unknown>>((a, s) => (s && typeof s === "object" ? { ...a, ...(s as Record<string, unknown>) } : a), {});
    expect(style.justifyContent).toBe("flex-end");
  });

  it("follows the newest message as it streams, but not while she has scrolled up to read; sending re-attaches", async () => {
    chat.messages = CONVO;
    const ui = render(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await settle();
    const scrollToEnd = transcript(ui).instance.scrollToEnd as jest.Mock;
    const host = screen.getByTestId("mila-transcript");

    // At the end: a growing reply keeps the newest line in view.
    scrollToEnd.mockClear();
    fireEvent(host, "contentSizeChange", 390, 2000);
    expect(scrollToEnd).toHaveBeenCalledTimes(1);

    // She drags up to read history: the stream no longer pulls her down.
    fireEvent(host, "scrollBeginDrag", scrollEvent(1200));
    fireEvent.scroll(host, scrollEvent(200));
    fireEvent(host, "scrollEndDrag", scrollEvent(200));
    scrollToEnd.mockClear();
    fireEvent(host, "contentSizeChange", 390, 2100);
    expect(scrollToEnd).not.toHaveBeenCalled();

    // She sends: the transcript follows the new turn again.
    fireEvent.changeText(screen.getByPlaceholderText("Ask Mila anything"), "And then?");
    fireEvent.press(screen.getByLabelText("Send"));
    fireEvent(host, "contentSizeChange", 390, 2300);
    expect(scrollToEnd).toHaveBeenCalledTimes(1);

    // Scrolling herself back down to the end re-attaches too.
    fireEvent(host, "scrollBeginDrag", scrollEvent(200, 2300));
    fireEvent(host, "scrollEndDrag", scrollEvent(200, 2300));
    scrollToEnd.mockClear();
    fireEvent(host, "contentSizeChange", 390, 2400);
    expect(scrollToEnd).not.toHaveBeenCalled();
    fireEvent(host, "scrollBeginDrag", scrollEvent(200, 2400));
    fireEvent(host, "scrollEndDrag", scrollEvent(1780, 2400));
    fireEvent(host, "contentSizeChange", 390, 2500);
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("a programmatic scroll mid-animation never detaches it (only her drag does)", async () => {
    chat.messages = CONVO;
    const ui = render(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await settle();
    const scrollToEnd = transcript(ui).instance.scrollToEnd as jest.Mock;
    const host = screen.getByTestId("mila-transcript");
    fireEvent.scroll(host, scrollEvent(100));
    scrollToEnd.mockClear();
    fireEvent(host, "contentSizeChange", 390, 2000);
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("when the keyboard changes the viewport, the newest stays in view", async () => {
    chat.messages = CONVO;
    const ui = render(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await settle();
    const scrollToEnd = transcript(ui).instance.scrollToEnd as jest.Mock;
    scrollToEnd.mockClear();
    fireEvent(screen.getByTestId("mila-transcript"), "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 320 } } });
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
  });

  it("the empty state never scrolls to its end (the greeting stays in view)", async () => {
    const ui = render(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await settle();
    const scrollToEnd = transcript(ui).instance.scrollToEnd as jest.Mock;
    scrollToEnd.mockClear();
    fireEvent(screen.getByTestId("mila-transcript"), "contentSizeChange", 390, 2000);
    expect(scrollToEnd).not.toHaveBeenCalled();
  });
});

describe("the composer and openers (Muse look)", () => {
  const flat = (el: { props: { style?: unknown } }) =>
    ([] as unknown[]).concat(el.props.style ?? []).flat(4)
      .reduce<Record<string, unknown>>((a, s) => (s && typeof s === "object" ? { ...a, ...(s as Record<string, unknown>) } : a), {});

  it("the composer is a frosted bar with no border; a ready send is a white circle, never a dark disc", async () => {
    render(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await settle();
    expect(flat(screen.getByTestId("mila-composer")).borderWidth ?? 0).toBe(0);
    expect(screen.queryByTestId("mila-send-ready")).toBeNull();
    fireEvent.changeText(screen.getByPlaceholderText("Ask Mila anything"), "Hi");
    const send = flat(screen.getByTestId("mila-send-ready"));
    expect(send.backgroundColor).toBe("#FFFFFF");
    fireEvent.press(screen.getByLabelText("Send"));
    expect(chat.send).toHaveBeenCalled();
  });

  it("openers are frosted rows led by her still (no bolt), and a tap still sends the opener", async () => {
    chat.send.mockClear();
    render(<MilaSearchOverlay visible onClose={jest.fn()} />);
    await settle();
    expect(screen.queryAllByTestId("icon-zap")).toHaveLength(0);
    const first = openersFor(undefined)[0];
    fireEvent.press(screen.getByText(first));
    expect(chat.send).toHaveBeenCalledWith(first, undefined, undefined);
  });
});

describe("opening on a message Mila started (EXPO_PUBLIC_MILA_PROACTIVE push)", () => {
  it("opens the named chat and scrolls to that exact message once it is drawn", async () => {
    const MSG = "33333333-3333-4333-8333-333333333333";
    chat.openConversation.mockClear();
    chat.messages = [
      { id: "a-1", role: "assistant", content: "Earlier.", serverId: "44444444-4444-4444-8444-444444444444" },
      { id: "a-2", role: "assistant", content: "A brand replied. I drafted an answer.", serverId: MSG, milaStarted: true },
      { id: "u-3", role: "user", content: "Later question" },
    ];
    const scrollTo = jest.spyOn(ScrollView.prototype as any, "scrollTo").mockImplementation(() => undefined);
    const opened = jest.fn();
    render(<MilaSearchOverlay visible presentation="tab" onClose={jest.fn()} initialConversationId="c-9" initialMessageId={MSG} onInitialConversationOpened={opened} />);
    await settle();
    expect(chat.openConversation).toHaveBeenCalledWith("c-9");
    expect(opened).toHaveBeenCalled();
    const layout = (y: number) => ({ nativeEvent: { layout: { x: 0, y, width: 300, height: 40 } } });
    fireEvent(screen.getByTestId("mila-transcript-tap"), "layout", layout(100));
    fireEvent(screen.getByTestId("mila-convo"), "layout", layout(20));
    fireEvent(screen.getByTestId(`mila-msg-${MSG}`), "layout", layout(400));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect((scrollTo.mock.calls[0][0] as { y: number }).y).toBeGreaterThan(0);
    // Once is enough: a later layout of the same message does not pull the transcript back.
    fireEvent(screen.getByTestId(`mila-msg-${MSG}`), "layout", layout(420));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    scrollTo.mockRestore();
    chat.messages = [];
  });
});
