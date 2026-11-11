/**
 * milaTab.test — Ask Mila is the centre tab's own screen, so the shell's bottom menu stays under the chat (owner,
 * 8 Oct 2026: "much like Muse"):
 *   - on the Mila tab the screen is the chat AND the tab bar is still drawn under it;
 *   - the centre button opens the Mila tab seeded with the tab she came from; pressed on the Mila tab it does nothing;
 *   - while the keyboard is up on Ask Mila the bar steps aside; put away, the tabs return; other tabs keep the bar;
 *   - a tab press is how she leaves (no close), and tab focus stands in for the chat's `visible`;
 *   - Deal Detail still hides the bar.
 * React Navigation itself does not load under this Jest setup (ESM), so the navigator is replaced by its state and a
 * navigation stand-in, the way meShell.test drives TabBar; `useIsFocused` is the one hook mocked.
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { AccessibilityInfo, AppState, Keyboard, View } from "react-native";
import { MilaTabScreen, ShellTabBar, MILA_TAB } from "./milaTab";
import { barTabsFor } from "./shellTabs";

let mockFocused = true;
jest.mock("@react-navigation/native", () => ({ useIsFocused: () => mockFocused }));
jest.mock("../screens/MilaSearchOverlay", () => {
  const React = require("react");
  const { Text, View } = require("react-native");
  return {
    MilaSearchOverlay: (p: { visible: boolean; presentation?: string; initialContext?: { type: string }; initialDraft?: string }) =>
      React.createElement(View, { testID: "mila-chat" },
        React.createElement(Text, { testID: "mila-chat-props" }, JSON.stringify({
          visible: p.visible, presentation: p.presentation, context: p.initialContext?.type ?? null, draft: p.initialDraft ?? null,
        }))),
  };
});
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Feather: ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`) };
});
jest.mock("../lib/haptics", () => {
  const noop = () => {};
  const fns = { tap: noop, press: noop, select: noop, success: noop, warning: noop, error: noop };
  return { ...fns, haptics: fns };
});
jest.mock("expo-video", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    useVideoPlayer: () => ({ loop: false, muted: false, play: () => {}, pause: () => {} }),
    VideoView: (props: Record<string, unknown>) => React.createElement(View, { testID: "mila-video", ...props }),
  };
});

// Every Keyboard subscriber, by event name, so a test can raise and put away the keyboard.
const kb: Record<string, Array<() => void>> = {};
const keyboard = (event: string) => act(() => { for (const cb of [...(kb[event] ?? [])]) cb(); });

beforeEach(() => {
  mockFocused = true;
  for (const k of Object.keys(kb)) delete kb[k];
  jest.spyOn(Keyboard, "addListener").mockImplementation(((event: string, cb: () => void) => {
    (kb[event] ??= []).push(cb);
    return { remove: () => { kb[event] = (kb[event] ?? []).filter((x) => x !== cb); } };
  }) as never);
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(false);
  jest.spyOn(AccessibilityInfo, "addEventListener").mockImplementation(() => ({ remove: jest.fn() }) as never);
  jest.spyOn(AppState, "addEventListener").mockImplementation(() => ({ remove: jest.fn() }) as never);
});
afterEach(() => jest.restoreAllMocks());

const settle = () => act(async () => {});
const TABS = barTabsFor(false, false);
const stateOn = (name: string, nested?: object) =>
  ({ index: TABS.findIndex((t) => t.name === name), routes: TABS.map((t) => ({ key: `${t.name}-k`, name: t.name, ...(t.name === name && nested ? { state: nested } : {}) })) }) as any;
const makeNav = () => ({ emit: jest.fn(() => ({ defaultPrevented: false })), navigate: jest.fn() }) as any;
const chatProps = () => JSON.parse(String(screen.getByTestId("mila-chat-props").props.children));

/** What the navigator draws on a tab: the focused screen, and the shell's bar under it. */
function Shell({ on, navigation, onLaunch = jest.fn() }: { on: string; navigation: any; onLaunch?: (c: unknown) => void }) {
  return (
    <View style={{ flex: 1 }}>
      {on === MILA_TAB ? <MilaTabScreen context={{ type: "brand" }} /> : <View testID={`${on}-screen`} />}
      <ShellTabBar state={stateOn(on)} navigation={navigation} onLaunch={onLaunch} />
    </View>
  );
}

describe("Ask Mila as the centre tab", () => {
  it("on the Mila tab the chat is the screen and the tab bar is still drawn under it", async () => {
    render(<Shell on={MILA_TAB} navigation={makeNav()} />);
    await settle();
    expect(screen.getByTestId("mila-chat")).toBeTruthy();
    expect(screen.getByTestId("shell-tab-bar")).toBeTruthy();
    expect(chatProps()).toEqual({ visible: true, presentation: "tab", context: "brand", draft: null });
    // The centre button reads as the selected one, and her bar avatar holds still (the chat plays its own Mila).
    expect(screen.getByLabelText("Ask Mila").props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
    expect(screen.getByTestId("tab-mila-still", { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByTestId("mila-video", { includeHiddenElements: true })).toBeNull();
  });

  it("the centre button opens the Mila tab seeded with the tab she came from; on the Mila tab it does nothing", async () => {
    const nav = makeNav();
    const onLaunch = jest.fn();
    const ui = render(<Shell on="Opportunities" navigation={nav} onLaunch={onLaunch} />);
    await settle();
    fireEvent.press(screen.getByLabelText("Ask Mila"));
    expect(onLaunch).toHaveBeenCalledWith({ type: "deals-list" });
    expect(nav.navigate).toHaveBeenCalledWith(MILA_TAB);

    onLaunch.mockClear(); nav.navigate.mockClear();
    ui.rerender(<Shell on={MILA_TAB} navigation={nav} onLaunch={onLaunch} />);
    await settle();
    fireEvent.press(screen.getByLabelText("Ask Mila"));
    expect(onLaunch).not.toHaveBeenCalled();
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it("while the keyboard is up on Ask Mila the bar steps aside; put away, the tabs return", async () => {
    render(<Shell on={MILA_TAB} navigation={makeNav()} />);
    await settle();
    keyboard("keyboardWillShow");
    expect(screen.queryByTestId("shell-tab-bar")).toBeNull();
    expect(screen.getByTestId("mila-chat")).toBeTruthy();
    keyboard("keyboardWillHide");
    expect(screen.getByTestId("shell-tab-bar")).toBeTruthy();
  });

  it("other tabs keep the bar with the keyboard up, as before", async () => {
    render(<Shell on="Home" navigation={makeNav()} />);
    await settle();
    keyboard("keyboardWillShow");
    expect(screen.getByTestId("shell-tab-bar")).toBeTruthy();
  });

  it("a tab press is how she leaves Mila — no close button needed", async () => {
    const nav = makeNav();
    render(<Shell on={MILA_TAB} navigation={nav} />);
    await settle();
    fireEvent.press(screen.getByLabelText("Studio"));
    expect(nav.navigate).toHaveBeenCalledWith("Studio");
  });

  it("tab focus stands in for the chat's `visible` (unfocused: her loop pauses, the composer clears)", async () => {
    mockFocused = false;
    render(<MilaTabScreen draft="Tell Mila about this" />);
    expect(chatProps()).toEqual({ visible: false, presentation: "tab", context: null, draft: "Tell Mila about this" });
  });

  it("Deal Detail still hides the bar", () => {
    render(<ShellTabBar state={stateOn("Opportunities", { index: 1, routes: [{ name: "OpportunitiesList" }, { name: "DealDetail" }] })} navigation={makeNav()} onLaunch={jest.fn()} />);
    expect(screen.queryByTestId("shell-tab-bar")).toBeNull();
  });
});
