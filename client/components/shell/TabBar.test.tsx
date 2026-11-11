/**
 * TabBar.test — the shell's centre Mila button shows her IDLE avatar only (owner decision, 8 Oct 2026):
 *   - her idle loop plays while the app is foregrounded, reduce-motion is off and the Ask Mila overlay is closed;
 *   - otherwise (overlay open, app backgrounded, reduce motion) her still image, and no video player at all — so only
 *     one Mila video ever plays;
 *   - the button still announces "Ask Mila" (not "Mila is idle") and a press opens Mila.
 * expo-video is mocked the way MilaAvatar.test does (a View stand-in + a fake player).
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { AccessibilityInfo, AppState } from "react-native";
import { TabBar } from "./TabBar";
import { barTabsFor } from "../../navigation/shellTabs";

class FakePlayer {
  loop = false;
  muted = false;
  play = jest.fn();
  pause = jest.fn();
  constructor(public source: unknown) {}
}
const players: FakePlayer[] = [];

jest.mock("expo-video", () => {
  const React = require("react");
  return {
    useVideoPlayer: (src: unknown, setup?: (p: unknown) => void) => {
      const ref = React.useRef(null);
      if (!ref.current) {
        ref.current = new FakePlayer(src);
        players.push(ref.current);
        setup?.(ref.current);
      }
      return ref.current;
    },
    VideoView: (props: Record<string, unknown>) => {
      const { View } = require("react-native");
      return React.createElement(View, { testID: "mila-video", ...props });
    },
  };
});
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Feather: ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`) };
});
const press = jest.fn();
jest.mock("../../lib/haptics", () => {
  const noop = () => {};
  const fns = { tap: noop, press: () => press(), select: noop, success: noop, warning: noop, error: noop };
  return { ...fns, haptics: fns };
});

let reduceMotion = false;
// Every AppState subscriber (the bar's Mila and, while she plays, MilaAvatar's own).
const appStateListeners: Array<(s: string) => void> = [];
const setAppState = (s: string) => act(() => { for (const cb of [...appStateListeners]) cb(s); });

beforeEach(() => {
  players.length = 0;
  press.mockReset();
  reduceMotion = false;
  appStateListeners.length = 0;
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockImplementation(() => Promise.resolve(reduceMotion));
  jest.spyOn(AccessibilityInfo, "addEventListener").mockImplementation(() => ({ remove: jest.fn() }) as never);
  jest.spyOn(AppState, "addEventListener").mockImplementation(((_t: string, cb: (s: string) => void) => {
    appStateListeners.push(cb);
    return { remove: () => { const i = appStateListeners.indexOf(cb); if (i >= 0) appStateListeners.splice(i, 1); } };
  }) as never);
});
afterEach(() => jest.restoreAllMocks());

const settle = () => act(async () => {});
// Her picture sits inside the button but is hidden from screen readers (the button speaks for her), so queries for it
// must include hidden elements.
const HIDDEN = { includeHiddenElements: true };

function renderBar({ milaActive }: { milaActive?: boolean } = {}) {
  const tabs = barTabsFor(false, false);
  const state = { index: 0, routes: tabs.map((t) => ({ key: `${t.name}-k`, name: t.name })) } as any;
  const navigation = { emit: jest.fn(() => ({ defaultPrevented: false })), navigate: jest.fn() } as any;
  const onOpen = jest.fn();
  const utils = render(<TabBar state={state} navigation={navigation} onOpenSearchAsk={onOpen} milaActive={milaActive} />);
  return { ...utils, onOpen, state, navigation };
}

describe("TabBar centre Mila", () => {
  it("shows her idle avatar, playing, once motion is known; the button is 'Ask Mila' and a press opens Mila", async () => {
    const { onOpen } = renderBar();
    await settle();
    expect(screen.getByTestId("tab-mila")).toBeTruthy();
    expect(screen.getByTestId("mila-video", HIDDEN)).toBeTruthy();
    expect(screen.queryByTestId("tab-mila-still", HIDDEN)).toBeNull();
    expect(players).toHaveLength(1);
    expect(players[0].play).toHaveBeenCalled();
    // The button keeps its own label; her "Mila is idle" is hidden from screen readers inside it.
    const btn = screen.getByLabelText("Ask Mila");
    expect(btn.props.accessibilityRole).toBe("button");
    expect(screen.queryByLabelText("Mila is idle")).toBeNull();
    expect(screen.getByLabelText("Mila is idle", HIDDEN)).toBeTruthy(); // she is there, just not announced
    fireEvent.press(btn);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(press).toHaveBeenCalledTimes(1);
  });

  it("before reduce-motion is read she shows her still", () => {
    renderBar();
    expect(screen.getByTestId("tab-mila-still", HIDDEN)).toBeTruthy();
    expect(screen.queryByTestId("mila-video", HIDDEN)).toBeNull();
  });

  it("while the Ask Mila overlay is open: her still image, no video player (only one Mila video plays)", async () => {
    const { rerender, state, navigation, onOpen } = renderBar({ milaActive: false });
    await settle();
    expect(screen.getByTestId("tab-mila-still", HIDDEN)).toBeTruthy();
    expect(screen.queryByTestId("mila-video", HIDDEN)).toBeNull();
    expect(players).toHaveLength(0);
    // The overlay closes: she comes back to life.
    rerender(<TabBar state={state} navigation={navigation} onOpenSearchAsk={onOpen} milaActive />);
    await settle();
    expect(screen.getByTestId("mila-video", HIDDEN)).toBeTruthy();
    expect(screen.getByLabelText("Ask Mila")).toBeTruthy();
  });

  it("reduce motion: her still image, never a video", async () => {
    reduceMotion = true;
    renderBar();
    await settle();
    expect(screen.getByTestId("tab-mila-still", HIDDEN)).toBeTruthy();
    expect(screen.queryByTestId("mila-video", HIDDEN)).toBeNull();
    expect(players).toHaveLength(0);
    expect(screen.getByLabelText("Ask Mila")).toBeTruthy();
  });

  it("app backgrounded: her still; foregrounded again: her idle loop", async () => {
    renderBar();
    await settle();
    expect(screen.getByTestId("mila-video", HIDDEN)).toBeTruthy();
    setAppState("background");
    expect(screen.getByTestId("tab-mila-still", HIDDEN)).toBeTruthy();
    expect(screen.queryByTestId("mila-video", HIDDEN)).toBeNull();
    setAppState("active");
    expect(screen.getByTestId("mila-video", HIDDEN)).toBeTruthy();
  });
});
