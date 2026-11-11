/**
 * webV2.gating.test — EXPO_PUBLIC_WEB_V2 is the dev web build's switch, and with it off (native, the production web app
 * at app.nomila.co) every path is exactly today's:
 *   - webV2On: on only with the flag AND a browser
 *   - connects: today's web body ({clientPlatform:"web"}) and popup; with the switch, a same-tab redirect and webReturn
 *   - WebFrame: no wrapper when off; on under 768 the full-width column as before; on at 768+ the rounded column over
 *     the landing's blurred hero photos (one photo, no fade, with reduced motion), never remounting the app
 *   - web push: off without the switch or without the VAPID key; an iPhone Safari tab gets the Home Screen hint
 * The API and the browser navigation are mocked (no server, no provider).
 */
import React from "react";
import { Dimensions, StyleSheet, Text } from "react-native";
import { act, render, screen } from "@testing-library/react-native";

const apiRequest = jest.fn(async (..._a: unknown[]) => ({ json: async () => ({ redirectUrl: "https://provider.example/auth" }) }));
jest.mock("./query-client", () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a), queryClient: {} }));

import { Platform } from "react-native";
import { webV2On } from "./flags";
import { connectBody, connectService, webNav } from "./agent/connect";
import { WebFrame, WEB_FRAME_BLUR, WEB_FRAME_MAX_WIDTH, WEB_FRAME_RADIUS } from "../components/web/WebFrame";
import { HERO_SLIDES } from "../components/web/heroSlides";
import { Bold } from "../constants/theme";
import { webPushModeFor, type WebEnv } from "./webPush";

const os = Platform.OS;
afterEach(() => { (Platform as any).OS = os; apiRequest.mockClear(); });

describe("webV2On", () => {
  it("on only with the flag in a browser", () => {
    expect(webV2On("web", true)).toBe(true);
    expect(webV2On("web", false)).toBe(false);
    expect(webV2On("ios", true)).toBe(false);
    expect(webV2On("android", true)).toBe(false);
  });
  it("the flag is off in this (non-dev-web) build", () => {
    expect(webV2On("web")).toBe(false);
  });
});

describe("connects", () => {
  it("the body: native nothing; today's web the web marker; the switch adds the same-tab return ask", () => {
    expect(connectBody("ios", true)).toEqual({});
    expect(connectBody("web", false)).toEqual({ clientPlatform: "web" });
    expect(connectBody("web", true)).toEqual({ clientPlatform: "web", webReturn: true });
  });

  it("switch on: same-tab redirect to the provider, never a popup", async () => {
    (Platform as any).OS = "web";
    const assign = jest.spyOn(webNav, "assign").mockImplementation(() => undefined);
    const open = jest.fn();
    (globalThis as any).window = Object.assign((globalThis as any).window ?? {}, { open });
    void connectService("tiktok", {} as any, true);
    await new Promise((r) => setTimeout(r, 0));
    expect(apiRequest).toHaveBeenCalledWith("POST", "/api/v1/me/connect/tiktok", { clientPlatform: "web", webReturn: true }, { credentials: "include" });
    expect(assign).toHaveBeenCalledWith("https://provider.example/auth");
    expect(open).not.toHaveBeenCalled();
    assign.mockRestore();
  });

  it("switch off (production web): today's popup, today's body", async () => {
    (Platform as any).OS = "web";
    const assign = jest.spyOn(webNav, "assign").mockImplementation(() => undefined);
    const open = jest.fn(() => ({}));
    const w = (globalThis as any).window;
    const saved = { open: w.open, addEventListener: w.addEventListener };
    w.open = open;
    w.addEventListener = jest.fn();
    void connectService("tiktok", {} as any, false);
    await new Promise((r) => setTimeout(r, 0));
    expect(apiRequest).toHaveBeenCalledWith("POST", "/api/v1/me/connect/tiktok", { clientPlatform: "web" }, { credentials: "include" });
    expect(open).toHaveBeenCalledWith("https://provider.example/auth", "_blank");
    expect(assign).not.toHaveBeenCalled();
    Object.assign(w, saved);
    assign.mockRestore();
  });
});

describe("WebFrame", () => {
  const setWindow = (width: number, height: number) => act(() => { Dimensions.set({ window: { width, height, scale: 1, fontScale: 1 } }); });
  const g = globalThis as any;
  const savedWindow = g.window;
  /** A browser window whose prefers-reduced-motion is `reduce`, with document already loaded. */
  const browser = (reduce: boolean) => {
    g.window = { ...(savedWindow ?? {}), matchMedia: (q: string) => ({ matches: reduce && q.includes("reduce"), addEventListener: jest.fn(), removeEventListener: jest.fn() }) };
    g.document = { readyState: "complete" };
  };
  afterEach(() => { g.window = savedWindow; delete g.document; setWindow(750, 1334); });

  it("off: the app with no wrapper at all, at any width", () => {
    setWindow(1280, 800);
    render(<WebFrame on={false}><Text>app</Text></WebFrame>);
    expect(screen.getByText("app")).toBeTruthy();
    expect(screen.queryByTestId("web-frame")).toBeNull();
    expect(screen.queryByTestId("web-frame-backdrop", { includeHiddenElements: true })).toBeNull();
  });

  it("on, under 768: unchanged — the full-width column on the ground, no frame, no photo, no wordmark", () => {
    setWindow(390, 844);
    render(<WebFrame on><Text>app</Text></WebFrame>);
    const page = screen.getByTestId("web-frame");
    expect(StyleSheet.flatten(page.props.style)).toMatchObject({ alignItems: "center", backgroundColor: Bold.ground });
    const column = StyleSheet.flatten(screen.getByTestId("web-frame-column").props.style);
    expect(column).toMatchObject({ width: "100%", maxWidth: WEB_FRAME_MAX_WIDTH });
    expect(column.borderRadius).toBeUndefined();
    expect(WEB_FRAME_MAX_WIDTH).toBe(480);
    expect(screen.queryByTestId("web-frame-backdrop", { includeHiddenElements: true })).toBeNull();
    expect(screen.queryByTestId("web-frame-wordmark")).toBeNull();
    expect(screen.UNSAFE_queryAllByType("img" as any)).toHaveLength(0);
    setWindow(767, 900);
    expect(screen.queryByTestId("web-frame-backdrop", { includeHiddenElements: true })).toBeNull();
  });

  it("on, 768 and wider: the rounded column over the landing's eight photos (first loads now, the rest after load), the wordmark", () => {
    browser(false);
    setWindow(1280, 800);
    render(<WebFrame on><Text>app</Text></WebFrame>);
    expect(screen.getByText("app")).toBeTruthy();
    const column = StyleSheet.flatten(screen.getByTestId("web-frame-column").props.style);
    expect(column).toMatchObject({ maxWidth: WEB_FRAME_MAX_WIDTH, borderRadius: WEB_FRAME_RADIUS });
    expect(screen.getByTestId("web-frame-wordmark")).toBeTruthy();
    const imgs = screen.UNSAFE_getAllByType("img" as any);
    expect(imgs).toHaveLength(HERO_SLIDES.length);
    expect(imgs.map((i) => i.props.style.objectPosition)).toEqual(HERO_SLIDES.map((s) => s.position));
    expect(imgs[0].props.srcSet).toBe("/web-frame/hero-1-960.webp 960w, /web-frame/hero-1-1920.webp 1920w");
    expect(imgs.every((i) => i.props.src && i.props.style.filter === `blur(${WEB_FRAME_BLUR}px)`)).toBe(true);
    expect(imgs.map((i) => i.props.className)).toEqual(HERO_SLIDES.map((_, n) => `nwf-slide nwf-s${n}`));
  });

  it("on, wide, reduced motion: one photo, no cross-fade, the others never fetched", () => {
    browser(true);
    setWindow(1024, 768);
    render(<WebFrame on><Text>app</Text></WebFrame>);
    const imgs = screen.UNSAFE_getAllByType("img" as any);
    expect(imgs).toHaveLength(1);
    expect(imgs[0].props.src).toBe("/web-frame/hero-1-1920.webp");
    expect(imgs[0].props.className).toBeUndefined();
    expect(imgs[0].props.style.opacity).toBe(1);
    expect(screen.UNSAFE_queryAllByType("style" as any)).toHaveLength(0);
  });

  it("between 768 and 880: the frame and photos, but no wordmark (it would run under the column)", () => {
    browser(false);
    setWindow(800, 800);
    render(<WebFrame on><Text>app</Text></WebFrame>);
    expect(screen.getByTestId("web-frame-backdrop", { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByTestId("web-frame-wordmark")).toBeNull();
    setWindow(880, 800);
    expect(screen.getByTestId("web-frame-wordmark")).toBeTruthy();
  });

  it("crossing 768 never remounts the app", () => {
    browser(false);
    setWindow(390, 844);
    const mounted = jest.fn();
    function App() { React.useEffect(() => { mounted(); }, []); return <Text>app</Text>; }
    render(<WebFrame on><App /></WebFrame>);
    setWindow(1280, 800);
    expect(screen.getByTestId("web-frame-backdrop", { includeHiddenElements: true })).toBeTruthy();
    setWindow(390, 844);
    expect(mounted).toHaveBeenCalledTimes(1);
  });
});

describe("web push mode", () => {
  const desktop: WebEnv = { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130", maxTouchPoints: 0, standalone: false, serviceWorker: true, notification: true, pushManager: true };
  const iphoneTab: WebEnv = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1", maxTouchPoints: 5, standalone: false, serviceWorker: true, notification: false, pushManager: false };
  it("off without the switch, or without the VAPID key (production web, or the key not created yet)", () => {
    expect(webPushModeFor(false, "key", desktop)).toBe("off");
    expect(webPushModeFor(true, "", desktop)).toBe("off");
  });
  it("on with both, in a browser that has push", () => {
    expect(webPushModeFor(true, "key", desktop)).toBe("available");
    expect(webPushModeFor(true, "key", { ...desktop, pushManager: false })).toBe("off");
  });
  it("iPhone/iPad Safari tab: the Home Screen hint; installed to the Home Screen: available", () => {
    expect(webPushModeFor(true, "key", iphoneTab)).toBe("needs_home_screen");
    expect(webPushModeFor(true, "key", { ...iphoneTab, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15" })).toBe("needs_home_screen");
    expect(webPushModeFor(true, "key", { ...iphoneTab, standalone: true, notification: true, pushManager: true })).toBe("available");
  });
});
