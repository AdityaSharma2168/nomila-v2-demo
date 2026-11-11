/**
 * MilaSearchOverlay.threadV2.test — the ONE switch (EXPO_PUBLIC_MILA_THREAD_V2):
 *   off (unset, or anything but "true"): the Mila chat is exactly the old one, and the chat v2 module is never loaded;
 *   on: every surface but the first entry (variant "onboarding") is the chat v2 screen, with the same props.
 * The chat v2 module is a stand-in here (its own suite mounts it for real: components/mila/thread/MilaThread.test.tsx);
 * the old chat's hooks are stand-ins as in MilaSearchOverlay.test.
 */
import React from "react";

const mockThreadScreen = jest.fn((p: { presentation?: string }) => {
  const { View } = require("react-native");
  return React.createElement(View, { testID: "thread-v2-mock", accessibilityHint: p.presentation });
});
let threadModuleLoaded = false;
jest.mock("../components/mila/thread", () => {
  threadModuleLoaded = true;
  return { MilaThreadScreen: (p: { presentation?: string }) => mockThreadScreen(p) };
});

jest.mock("../hooks/use-mila-chat", () => ({
  useMilaChat: () => ({
    send: jest.fn(), stop: jest.fn(), newChat: jest.fn(), openConversation: jest.fn(), syncToActiveThread: jest.fn(async () => {}),
    appendTranscript: jest.fn(), appendWidgetMessage: jest.fn(), streaming: false, phase: "idle", messages: [], conversationId: "c-1",
  }),
}));
jest.mock("../components/mila/useMilaVoice", () => ({
  useMilaVoice: () => ({ supported: false, state: "idle", active: false, error: null, notice: null, justEnded: false, toggle: jest.fn() }),
}));
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
jest.mock("../components/mila/SavedChatsSheet", () => ({ SavedChatsSheet: () => null }));
jest.mock("../components/mila/MilaProfileConfirm", () => ({ MilaProfileConfirm: () => null }));
jest.mock("../components/mila/MilaVoiceButton", () => ({ MilaVoiceButton: () => null }));
jest.mock("../components/mila/MilaVoiceBar", () => ({ MilaVoiceBar: () => null }));
jest.mock("../lib/milaChats", () => ({ confirmDeleteChat: jest.fn() }));
jest.mock("../lib/haptics", () => ({ haptics: { press: jest.fn() } }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("expo-blur", () => {
  const { View } = require("react-native");
  return { BlurView: (p: Record<string, unknown>) => React.createElement(View, p) };
});
jest.mock("expo-linear-gradient", () => {
  const { View } = require("react-native");
  return { LinearGradient: (p: Record<string, unknown>) => React.createElement(View, p) };
});
jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("expo-video", () => ({
  useVideoPlayer: () => ({ play: jest.fn(), pause: jest.fn() }),
  VideoView: () => null,
}));

type Overlay = typeof import("./MilaSearchOverlay").MilaSearchOverlay;
type RNTL = typeof import("@testing-library/react-native");
/**
 * The flag is read when the module loads, so each case loads the overlay afresh with its own env — together with the
 * renderer, React and React Native, so they all share one React.
 */
function load(flag: string | undefined): { Overlay: Overlay; rntl: RNTL; R: typeof React } {
  if (flag === undefined) delete process.env.EXPO_PUBLIC_MILA_THREAD_V2;
  else process.env.EXPO_PUBLIC_MILA_THREAD_V2 = flag;
  jest.resetModules();
  const R = require("react") as typeof React;
  // The "pure" entry: the default one registers afterEach hooks on import, which a test body may not do.
  const rntl = require("@testing-library/react-native/pure") as RNTL;
  jest.spyOn(require("react-native").AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
  const Overlay = (require("./MilaSearchOverlay") as typeof import("./MilaSearchOverlay")).MilaSearchOverlay;
  current = rntl;
  return { Overlay, rntl, R };
}
let current: RNTL | null = null;

beforeEach(() => {
  threadModuleLoaded = false;
  mockThreadScreen.mockClear();
});
afterEach(() => {
  current?.cleanup();
  current = null;
  delete process.env.EXPO_PUBLIC_MILA_THREAD_V2;
  jest.restoreAllMocks();
});

it("flag off (unset): the old chat, and the chat v2 module is never loaded", async () => {
  const { Overlay, rntl, R } = load(undefined);
  rntl.render(R.createElement(Overlay, { visible: true, presentation: "tab", onClose: jest.fn() }));
  await rntl.act(async () => {});
  expect(rntl.screen.getByTestId("mila-transcript")).toBeTruthy();
  expect(rntl.screen.queryByTestId("thread-v2-mock")).toBeNull();
  expect(threadModuleLoaded).toBe(false);
});

it('flag set to anything but "true": still the old chat', async () => {
  const { Overlay, rntl, R } = load("1");
  rntl.render(R.createElement(Overlay, { visible: true, presentation: "tab", onClose: jest.fn() }));
  await rntl.act(async () => {});
  expect(rntl.screen.getByTestId("mila-transcript")).toBeTruthy();
  expect(threadModuleLoaded).toBe(false);
});

it("flag on: the Mila tab and Home's sheet are chat v2, with the same props", async () => {
  const { Overlay, rntl, R } = load("true");
  rntl.render(R.createElement(Overlay, { visible: true, presentation: "tab", onClose: jest.fn() }));
  await rntl.act(async () => {});
  expect(rntl.screen.getByTestId("thread-v2-mock")).toBeTruthy();
  expect(rntl.screen.queryByTestId("mila-transcript")).toBeNull();
  expect(mockThreadScreen).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, presentation: "tab" }));
  rntl.render(R.createElement(Overlay, { visible: true, presentation: "sheet", onClose: jest.fn() }));
  await rntl.act(async () => {});
  expect(mockThreadScreen).toHaveBeenLastCalledWith(expect.objectContaining({ presentation: "sheet" }));
});

it("flag on: the first entry (onboarding) stays on the old chat", async () => {
  const { Overlay, rntl, R } = load("true");
  rntl.render(R.createElement(Overlay, { visible: true, variant: "onboarding", presentation: "tab", onClose: jest.fn() }));
  await rntl.act(async () => {});
  expect(rntl.screen.getByTestId("mila-transcript")).toBeTruthy();
  expect(rntl.screen.queryByTestId("thread-v2-mock")).toBeNull();
});
