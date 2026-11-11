/**
 * meShell.test — the app shell: Home · Strategy · Mila · Opportunities · Studio, the shared top bar, Me above the tabs.
 * One layout since stage 1 (owner, 25 Oct 2026): the Classic layout switch that restored the previous shell is gone.
 *
 *   A1 the bottom menu: five tabs (Home home · Strategy compass · Mila · Opportunities inbox · Studio aperture); the
 *      TabBar draws them, the centre button opens Mila
 *   A2 the top bar: NOMILA wordmark; the gear opens Home › Settings; the avatar opens Home › Me. Me, its screens and
 *      Settings live inside the Home tab, so the bottom menu stays under them and only Deal Detail hides it
 *   A3 the Brand header keeps her avatar at the left of the identity block, and draws a back chevron when pushed
 *   A5 Settings: pushed above the tabs it shows a back chevron and no header avatar; no Classic layout switch
 *   A6 meNav: leaveMeTo / openSettings / toBrand land inside the tabs or on the Brand stack above them
 *   A7 Mila's nav-chips re-pointed (navTargetRoute): score → My Intelligence, facts → What Nomila Knows, story → My
 *      Story, profile → Settings, deck · rates · signals → the Brand stack above the tabs; Home seeds the "brand"
 *      context, Strategy none
 *   A8 GET /me/story is optional: a 404 reads as "unavailable", never as an error; other failures still throw
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { BrandHeader } from "../components/brand/BrandHeader";
import { TabBar } from "../components/shell/TabBar";
import { TopBar } from "../components/shell/TopBar";
import { SettingsScreen } from "../screens/SettingsScreen";
import { leaveMeTo, openIntelligence, openPicks, openSettings, toBrand } from "./meNav";
import { barTabsFor, navTargetRoute, contextForTabName, INITIAL_TAB, isFullScreenRoute, NOMILA_MARK_ICON } from "./shellTabs";
import { fetchMeStory } from "../hooks/use-me-story";
import { meStoryModel } from "../lib/meStoryLogic";

// A plain in-memory AsyncStorage (not the package's jest.fn mock: spying on those clobbers their implementations).
jest.mock("@react-native-async-storage/async-storage", () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear: async () => { store.clear(); },
    },
  };
});
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Feather: ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`) };
});
const apiRequest = jest.fn();
jest.mock("../lib/query-client", () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
jest.mock("../lib/haptics", () => {
  const noop = () => {};
  const fns = { tap: noop, press: noop, select: noop, success: noop, warning: noop, error: noop };
  return { ...fns, haptics: fns };
});
// One navigation mock for every component under test: a tab-level nav whose parent is the ROOT stack (Tabs + Brand).
const SHELL_ROOT = ["Tabs", "Brand"];
let navType: "tab" | "stack" = "tab";
const rootNavigate = jest.fn();
const rootPopTo = jest.fn();
const root = { navigate: rootNavigate, popTo: rootPopTo, getParent: () => undefined, getState: () => ({ routeNames: SHELL_ROOT, routes: [{ name: "Tabs" }] }) };
const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const nav = { navigate: mockNavigate, goBack: mockGoBack, getParent: () => root, getState: () => ({ type: navType }) };
jest.mock("@react-navigation/native", () => ({ useNavigation: () => nav }));
jest.mock("../lib/auth-context", () => ({ useAuth: () => ({ athlete: { id: "a1", firstName: "Sam", lastName: null, email: "sam@example.test" }, signOut: jest.fn() }) }));
let mockIdentity: { photoUrl: string | null; displayName: string | null } = { photoUrl: null, displayName: "Sam" };
// Her eligible library photos, hero first (what useMePhotos serves): the avatar falls back to the hero's photo.
let mockPhotos: Array<{ asset_id: string; url: string | null; thumb_url: string | null; origin: string }> = [];
jest.mock("../hooks/use-me-knowledge", () => ({ useMeOverview: () => ({ data: { identity: mockIdentity }, refetch: jest.fn() }), useMePhotos: () => mockPhotos, useMePool: () => mockPhotos }));
// SettingsScreen's own data hooks — not under test here.
jest.mock("../hooks/use-connections", () => ({ useConnections: () => ({ connections: [], forPlatform: () => [], isLoading: false, refetch: jest.fn() }) }));
jest.mock("../hooks/use-platform-oauth", () => ({ usePlatformOAuth: () => ({ connect: jest.fn(), disconnect: jest.fn(), connecting: false }) }));
jest.mock("../hooks/use-deals", () => ({ useDealPreferences: () => ({ data: undefined }), useUpdatePreferences: () => ({ mutateAsync: jest.fn(), isPending: false }) }));
jest.mock("../components/PlatformIcon", () => ({ PlatformIcon: () => null }));
// The shell's centre button draws Mila's idle avatar (expo-video): a View stand-in, as MilaAvatar.test does.
jest.mock("expo-video", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    useVideoPlayer: () => ({ loop: false, muted: false, play: () => {}, pause: () => {} }),
    VideoView: (props: Record<string, unknown>) => React.createElement(View, { testID: "mila-video", ...props }),
  };
});

beforeEach(async () => {
  mockNavigate.mockReset(); mockGoBack.mockReset(); rootNavigate.mockReset(); rootPopTo.mockReset();
  mockIdentity = { photoUrl: null, displayName: "Sam" };
  mockPhotos = [];
  navType = "tab";
  await AsyncStorage.clear();
});

// ─── A1 the bottom menu ───────────────────────────────────────────────────────

describe("A1 the bottom menu", () => {
  it("Home · Strategy · Mila · Opportunities · Studio, with home · compass · the Nomila mark · inbox · aperture (look B)", () => {
    expect(barTabsFor(false, false).map((t) => [t.name, t.icon, t.label])).toEqual([
      ["Home", "home", "Home"], ["Strategy", "compass", "Strategy"], ["SearchAsk", NOMILA_MARK_ICON, "Mila"], ["Opportunities", "inbox", "Opportunities"], ["Studio", "aperture", "Studio"],
    ]);
    expect(barTabsFor(false, false).find((t) => t.isCenter)?.name).toBe("SearchAsk");
    expect(INITIAL_TAB).toBe("Home");
  });

  it("the TabBar draws the five; a tab navigates, the centre button opens Mila", async () => {
    const tabs = barTabsFor(false, false);
    const state = { index: 0, routes: tabs.map((t) => ({ key: `${t.name}-k`, name: t.name })) } as any;
    const navigation = { emit: jest.fn(() => ({ defaultPrevented: false })), navigate: jest.fn() } as any;
    const onOpen = jest.fn();
    render(<TabBar state={state} navigation={navigation} onOpenSearchAsk={onOpen} />);
    await act(async () => {}); // her reduce-motion read settles
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    // The centre button draws Mila herself (her avatar), not a Feather glyph.
    for (const t of tabs) {
      if (t.icon === NOMILA_MARK_ICON) expect(screen.getByTestId("tab-mila")).toBeTruthy();
      else expect(screen.getByText(`icon:${t.icon}`)).toBeTruthy();
    }
    expect(screen.getByTestId("shell-tab-bar")).toBeTruthy();
    fireEvent.press(screen.getByLabelText(tabs[1].label));
    expect(navigation.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "tabPress", target: `${tabs[1].name}-k` }));
    expect(navigation.navigate).toHaveBeenCalledWith(tabs[1].name);
    fireEvent.press(screen.getByLabelText("Ask Mila"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Mila")).toBeTruthy();
    expect(screen.queryByText("Settings")).toBeNull();
  });

  it("the bottom menu stays under Me, its screens and Settings (Home › …); only Deal Detail hides it", () => {
    const homeWith = (child: string) => ({ index: 0, routes: [{ name: "Home", state: { index: 1, routes: [{ name: "Landing" }, { name: child }] } }, { name: "Strategy" }] });
    for (const child of ["Me", "Story", "Knows", "Intelligence", "IntelligenceArea", "Settings"]) expect(isFullScreenRoute(homeWith(child))).toBe(false);
    expect(isFullScreenRoute({ index: 0, routes: [{ name: "Home" }] })).toBe(false);
    expect(isFullScreenRoute({ index: 0, routes: [{ name: "Opportunities", state: { index: 1, routes: [{ name: "OpportunitiesList" }, { name: "DealDetail" }] } }] })).toBe(true);
    expect(isFullScreenRoute({ index: 0, routes: [{ name: "Opportunities", state: { index: 0, routes: [{ name: "OpportunitiesList" }, { name: "DealDetail" }] } }] })).toBe(false);
  });
});

// ─── A2 the top bar ───────────────────────────────────────────────────────────

describe("A2 the top bar", () => {
  it("wordmark; the gear opens Home › Settings; the avatar opens Home › Me (both inside the tab, so the menu stays)", () => {
    render(<TopBar />);
    expect(screen.getByText("NOMILA")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Open Settings"));
    expect(mockNavigate).toHaveBeenCalledWith("Home", { screen: "Settings" });
    fireEvent.press(screen.getByLabelText("Open Me"));
    expect(mockNavigate).toHaveBeenCalledWith("Home", { screen: "Me" });
    expect(rootNavigate).not.toHaveBeenCalled();
    // No photo: the DESIGN.md fallback — a sport icon in a neutral circle, never an initial.
    expect(screen.queryByText("S")).toBeNull();
    expect(screen.getAllByTestId("me-avatar-fallback")).toHaveLength(1);
  });

  it("her photo when there is one (no initial)", () => {
    mockIdentity = { photoUrl: "https://example.test/her.jpg", displayName: "Sam" };
    render(<TopBar />);
    expect(screen.getByLabelText("Open Me")).toBeTruthy();
    expect(screen.queryByTestId("me-avatar-fallback")).toBeNull();
  });

  it("no record photo: the avatar falls back to the hero's photo (her best eligible library photo); the sport icon only when there is none", () => {
    mockIdentity = { photoUrl: "", displayName: "Sam" };
    mockPhotos = [{ asset_id: "hero", url: "https://example.test/hero.jpg", thumb_url: null, origin: "connected" }, { asset_id: "other", url: "https://example.test/other.jpg", thumb_url: null, origin: "upload" }];
    const { unmount } = render(<TopBar />);
    const img = screen.UNSAFE_getAllByType(require("react-native").Image).find((i: any) => i.props.source?.uri?.includes("hero.jpg"));
    expect(img).toBeTruthy();
    expect(screen.queryByTestId("me-avatar-fallback")).toBeNull();
    unmount();
    mockPhotos = [];
    render(<TopBar />);
    expect(screen.getAllByTestId("me-avatar-fallback")).toHaveLength(1);
  });
});

// ─── A3 the Brand header ──────────────────────────────────────────────────────

const header = () => <BrandHeader name="Sam" identityLine={null} displayScore={null} tier={null} onScore={() => {}} />;

describe("A3 the Brand header", () => {
  it("keeps her left avatar and has no Me button (the top bar has the avatar)", () => {
    render(header());
    expect(screen.queryByLabelText("Open Me")).toBeNull();
    expect(screen.getAllByText("S")).toHaveLength(1);
  });

  it("draws a back chevron only when the stack is pushed above the tabs", () => {
    const { unmount } = render(header());
    expect(screen.queryByLabelText("Back")).toBeNull();
    unmount();
    const onBack = jest.fn();
    render(<BrandHeader name="Sam" identityLine={null} displayScore={null} tier={null} onScore={() => {}} onBack={onBack} />);
    fireEvent.press(screen.getByLabelText("Back"));
    expect(onBack).toHaveBeenCalled();
  });
});

// ─── A5 Settings ──────────────────────────────────────────────────────────────

describe("A5 Settings", () => {
  it("pushed inside Home: a back chevron, no header avatar, no Classic layout switch", () => {
    navType = "stack";
    render(<SettingsScreen />);
    expect(screen.getByLabelText("Back")).toBeTruthy();
    expect(screen.queryByLabelText("Open Me")).toBeNull();
    expect(screen.queryByText("Classic layout")).toBeNull();
    expect(screen.queryByTestId("classic-layout-switch")).toBeNull();
    // OPPS_V2 off here: the rates door is Brand › Rates, "Your floor" (Your rates needs the server's RATES_V1).
    expect(screen.getByText("Your floor")).toBeTruthy();
    fireEvent.press(screen.getByText("Your floor"));
    expect(rootNavigate).toHaveBeenCalledWith("Brand", { screen: "Rates", params: undefined });
    fireEvent.press(screen.getByLabelText("Back"));
    expect(mockGoBack).toHaveBeenCalled();
  });
});

// ─── A6 meNav ─────────────────────────────────────────────────────────────────

describe("A6 meNav", () => {
  const shellRoot = () => ({ navigate: jest.fn(), popTo: jest.fn(), getParent: () => undefined, getState: () => ({ routeNames: SHELL_ROOT }) });

  it("Me is inside Home, so tab destinations are a plain navigate; Settings is Home › Settings; Brand opens above the tabs", () => {
    const r = shellRoot();
    const n = { navigate: jest.fn(), getParent: () => r };
    leaveMeTo(n, "Studio", "MediaLibrary");
    expect(n.navigate).toHaveBeenLastCalledWith("Studio", { screen: "MediaLibrary", params: undefined });
    leaveMeTo(n, "Strategy");
    expect(n.navigate).toHaveBeenLastCalledWith("Strategy", undefined);
    openSettings(n);
    expect(n.navigate).toHaveBeenLastCalledWith("Home", { screen: "Settings" });
    toBrand(n, "Deck");
    expect(r.navigate).toHaveBeenLastCalledWith("Brand", { screen: "Deck", params: undefined });
    toBrand(n, "Rates");
    expect(r.navigate).toHaveBeenLastCalledWith("Brand", { screen: "Rates", params: undefined });
    expect(r.popTo).not.toHaveBeenCalled();
    // The score lives on My Intelligence (legacy retirement, phase 1).
    openIntelligence(n);
    expect(n.navigate).toHaveBeenLastCalledWith("Home", { screen: "Intelligence" });
    // Opportunities › Shop opens My Picks inside the Home tab (app layout B).
    openPicks(n);
    expect(n.navigate).toHaveBeenLastCalledWith("Home", { screen: "Picks" });
  });

  it("toBrand navigates directly when there is no root stack", () => {
    const n = { navigate: jest.fn(), getParent: () => undefined };
    toBrand(n, "Deck");
    expect(n.navigate).toHaveBeenCalledWith("Brand", { screen: "Deck", params: undefined });
  });
});

// ─── A7 Mila's nav-chips ──────────────────────────────────────────────────────

describe("A7 nav-chips re-pointed", () => {
  it("Brand destinations go to Me's screens inside Home or to the Brand stack above the tabs; profile → Home › Settings", () => {
    expect(navTargetRoute({ screen: "score" })).toEqual({ kind: "tab", tab: "Home", screen: "Intelligence" });
    expect(navTargetRoute({ screen: "facts" })).toEqual({ kind: "tab", tab: "Home", screen: "Knows" });
    expect(navTargetRoute({ screen: "story" })).toEqual({ kind: "tab", tab: "Home", screen: "Story" });
    expect(navTargetRoute({ screen: "deck" })).toEqual({ kind: "root", screen: "Brand", nested: { screen: "Deck", params: undefined } });
    // OPPS_V2 off here: Brand › Rates.
    expect(navTargetRoute({ screen: "rates" })).toEqual({ kind: "root", screen: "Brand", nested: { screen: "Rates", params: undefined } });
    expect(navTargetRoute({ screen: "signals" })).toEqual({ kind: "root", screen: "Brand", nested: { screen: "Signals", params: undefined } });
    expect(navTargetRoute({ screen: "profile" })).toEqual({ kind: "tab", tab: "Home", screen: "Settings" });
    expect(navTargetRoute({ screen: "deals" })).toEqual({ kind: "tab", tab: "Opportunities", screen: "OpportunitiesList" });
    expect(navTargetRoute({ screen: "deal", threadId: "t1", brandName: "B" })).toEqual({ kind: "tab", tab: "Opportunities", screen: "Thread", params: { threadId: "t1", brandName: "B" } });
    expect(navTargetRoute({ screen: "studio" })).toEqual({ kind: "tab", tab: "Studio", screen: "StudioHome" });
    expect(navTargetRoute({ screen: "pitches" })).toEqual({ kind: "tab", tab: "Studio", screen: "PitchesList" });
    expect(navTargetRoute({ screen: "media" })).toEqual({ kind: "tab", tab: "Studio", screen: "MediaLibrary" });
    expect(navTargetRoute({ screen: "add_contract", requestId: "r" })).toEqual({ kind: "none" });
  });

  it("Mila's launch context: Home reads as brand, Strategy seeds nothing, the rest as before", () => {
    expect(contextForTabName("Home")).toEqual({ type: "brand" });
    expect(contextForTabName("Strategy")).toBeUndefined();
    expect(contextForTabName("Opportunities")).toEqual({ type: "deals-list" });
    expect(contextForTabName("Studio")).toEqual({ type: "studio" });
    expect(contextForTabName("Me")).toEqual({ type: "profile" });
    expect(contextForTabName("SearchAsk")).toBeUndefined();
  });
});

// ─── A8 /me/story is optional ─────────────────────────────────────────────────

describe("A8 /me/story is optional", () => {
  beforeEach(() => apiRequest.mockReset());

  it("404 ⇒ unavailable", async () => {
    apiRequest.mockRejectedValue(new Error("404: Not Found"));
    await expect(fetchMeStory()).resolves.toMatchObject({ pageState: "unavailable", essence: null, positioning: { current: null, desired: null }, pillars: [], athleteStatements: [] });
  });

  it("other failures throw", async () => {
    apiRequest.mockRejectedValue(new Error("500: boom"));
    await expect(fetchMeStory()).rejects.toThrow("500");
  });

  it("ready (0.2) passes essence and positioning through; the model prefers long essence and desired positioning", async () => {
    apiRequest.mockResolvedValue({ json: async () => ({
      pageState: "ready", essence: { short: "A.", long: "A, longer.", basis: [], strength: "established" },
      positioning: { current: { short: "C.", long: "C, longer.", basis: [], strength: "reported" }, desired: { value: "D.", source: "objective", basis: [] } }, pillars: [],
    }) });
    const s = await fetchMeStory();
    expect(s).toMatchObject({ pageState: "ready", essence: { short: "A.", long: "A, longer.", strength: "established" }, positioning: { current: { short: "C.", long: "C, longer." }, desired: { value: "D.", source: "objective" } }, pillars: [] });
    expect(meStoryModel(s)).toEqual({ ready: true, identity: "A, longer.", positioning: "D." });
    expect(meStoryModel({ ...s, positioning: { ...s.positioning, desired: null } }).positioning).toBe("C.");
    const none = { essence: null, positioning: { current: null, desired: null } };
    expect(meStoryModel({ pageState: "ready", ...none }).ready).toBe(false);
    expect(meStoryModel({ pageState: "learning", ...none, essence: { short: "A.", long: "" } }).ready).toBe(false);
  });
});
