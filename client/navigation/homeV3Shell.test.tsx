/**
 * homeV3Shell.test — the v3 shell behind EXPO_PUBLIC_HOME_V3, and the flag-off path unchanged.
 *
 *   S1 flag off (production): the shell registers today's five in today's order (Home · Strategy · Mila ·
 *      Opportunities · Studio), the bar is exactly shellTabsFor(AGENT_V3), the avatar opens Home › Me — no "Me" tab
 *   S2 flag on: the bar is Home · Opportunities · Mila · Studio · Me; Strategy stays registered (last) but has no button;
 *      the avatar (and Home's ring) opens the Me tab
 *   S3 the flag reads exactly "true"; unset or anything else is off
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { TabBar } from "../components/shell/TabBar";
import { barTabsFor, HOME_V3_TABS, shellRoutesFor, shellTabsFor, NOMILA_MARK_ICON } from "./shellTabs";
import { openMe } from "./meNav";

let mockHomeV3 = false;
jest.mock("../lib/flags", () => {
  const actual = jest.requireActual("../lib/flags");
  return { ...actual, get HOME_V3() { return mockHomeV3; } };
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

const TODAY_ROUTES = ["Home", "Strategy", "SearchAsk", "Opportunities", "Studio"];

function renderBar(routes: string[]) {
  const state = { index: 0, routes: routes.map((name) => ({ key: `${name}-k`, name })) } as any;
  const navigation = { emit: jest.fn(() => ({ defaultPrevented: false })), navigate: jest.fn() } as any;
  render(<TabBar state={state} navigation={navigation} onOpenSearchAsk={jest.fn()} />);
  return navigation;
}

/** A tab-level nav whose parent is the shell's ROOT stack (it registers "Brand"). */
function shellNav() {
  const root = { navigate: jest.fn(), getParent: () => undefined, getState: () => ({ routeNames: ["Tabs", "Brand"] }) };
  return { navigate: jest.fn(), getParent: () => root, getState: () => ({}) };
}

afterEach(() => { mockHomeV3 = false; });

describe("S1 flag off: the shell exactly as today", () => {
  it("registers today's five in today's order, and the bar is today's", () => {
    expect(shellRoutesFor(false)).toEqual(TODAY_ROUTES);
    for (const agentV3 of [false, true]) expect(barTabsFor(agentV3, false)).toBe(shellTabsFor(agentV3));
  });

  it("the TabBar draws today's four buttons and Mila; no Me", async () => {
    renderBar(TODAY_ROUTES);
    await act(async () => {});
    expect(screen.getAllByRole("tab").map((t) => t.props.accessibilityLabel)).toEqual(["Home", "Strategy", "Opportunities", "Studio"]);
    expect(screen.queryByLabelText("Me")).toBeNull();
  });

  it("the avatar opens Me inside the Home tab, as before", () => {
    const nav = shellNav();
    openMe(nav);
    expect(nav.navigate).toHaveBeenCalledWith("Home", { screen: "Me" });
  });
});

describe("S2 flag on: Home · Business · Mila · Studio · Me", () => {
  beforeEach(() => { mockHomeV3 = true; });

  it("the bar's five, then Strategy registered with no button", () => {
    expect(shellRoutesFor(true)).toEqual(["Home", "Opportunities", "SearchAsk", "Studio", "Me", "Strategy"]);
    expect(barTabsFor(true, true)).toBe(HOME_V3_TABS);
    expect(HOME_V3_TABS.map((t) => [t.name, t.icon, t.label])).toEqual([
      ["Home", "home", "Home"], ["Opportunities", "inbox", "Business"], ["SearchAsk", NOMILA_MARK_ICON, "Mila"], ["Studio", "aperture", "Studio"], ["Me", "user", "Me"],
    ]);
  });

  it("the TabBar draws Home · Business · Studio · Me and Mila; Goals is off the bar; Me navigates", async () => {
    const navigation = renderBar(shellRoutesFor(true));
    await act(async () => {});
    expect(screen.getAllByRole("tab").map((t) => t.props.accessibilityLabel)).toEqual(["Home", "Business", "Studio", "Me"]);
    expect(screen.queryByLabelText("Strategy")).toBeNull();
    expect(screen.queryByLabelText("Goals")).toBeNull();
    fireEvent.press(screen.getByLabelText("Me"));
    expect(navigation.navigate).toHaveBeenCalledWith("Me");
  });

  it("the avatar opens the Me tab", () => {
    const nav = shellNav();
    openMe(nav);
    expect(nav.navigate).toHaveBeenCalledWith("Me", { screen: "MeHome" });
  });
});

describe("S3 the flag", () => {
  const read = (value: string | undefined): boolean => {
    const before = process.env.EXPO_PUBLIC_HOME_V3;
    if (value === undefined) delete process.env.EXPO_PUBLIC_HOME_V3; else process.env.EXPO_PUBLIC_HOME_V3 = value;
    let v = false;
    jest.isolateModules(() => { v = jest.requireActual("../lib/flags").HOME_V3; });
    if (before === undefined) delete process.env.EXPO_PUBLIC_HOME_V3; else process.env.EXPO_PUBLIC_HOME_V3 = before;
    return v;
  };
  it("is on only for exactly \"true\"", () => {
    expect(read(undefined)).toBe(false);
    expect(read("false")).toBe(false);
    expect(read("TRUE")).toBe(false);
    expect(read("true")).toBe(true);
  });
});
