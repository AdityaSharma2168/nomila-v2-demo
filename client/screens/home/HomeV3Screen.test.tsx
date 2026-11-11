/**
 * HomeV3Screen.test — Home v3 rendered from a model (lib/homeV3Logic over fixture reads; the reads themselves are the
 * hooks' business). The pieces draw; a circle opens its full-screen stories and marks what she saw; a story's one
 * action opens where it is handled; the admin row's "+N more" opens the checklist; Mila's briefing: each message has its
 * card and chips — "Review & post" opens the kit, "Later" hides it for today, an ask opens the chat sheet with it sent.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import React from "react";
import type { AgentGoalsResponse, GoalActionView } from "../../../shared/plan";
import { homeV3Model } from "../../lib/homeV3Logic";
import { HomeV3Screen } from "./HomeV3Screen";

const navigate = jest.fn();
const root = { navigate: jest.fn(), getParent: () => undefined, getState: () => ({ routeNames: ["Tabs", "Brand"] }) };
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: () => {}, navigate, getParent: () => root, setParams: () => {} }),
  useRoute: () => ({ params: undefined }),
}));
jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("../../lib/auth-context", () => ({ useAuth: () => ({ athlete: { id: "a1", firstName: "sam" } }) }));
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Feather: ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`) };
});
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("expo-blur", () => ({ BlurView: () => null }));
jest.mock("../../hooks/use-moment-images", () => ({ useMomentImages: () => ({}) }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
jest.mock("react-native-svg", () => {
  const Stub = () => null;
  return { __esModule: true, default: Stub, Circle: Stub, Path: Stub, Polygon: Stub, Rect: Stub, Line: Stub, ClipPath: Stub, Text: Stub, Defs: Stub, LinearGradient: Stub, Stop: Stub, G: Stub, RadialGradient: Stub };
});
jest.mock("../../lib/push", () => ({ acceptPushAsk: jest.fn(async () => true), phonePermission: async () => "granted" }));
jest.mock("../../hooks/use-me-knowledge", () => ({ useMeOverview: () => ({ data: { identity: { photoUrl: null } } }), useMePhotos: () => [] }));
jest.mock("../../components/homeV3/useMiaCard", () => ({
  useMiaCard: () => ({ score: 595, bands: undefined, early: false, refetch: async () => {}, overview: { data: null } }),
}));
jest.mock("../../components/homeV3/useKitPhoto", () => ({ useKitPhoto: () => null }));
// The chat itself is the Mila tab's screen (tested there); here only what the briefing opens it with.
jest.mock("../../components/homeV3/MilaChatSheet", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    MilaChatSheet: ({ seed }: { seed: { draft?: string; prompt?: string } | null }) =>
      seed ? React.createElement(Text, { testID: "chat-sheet" }, `chat:${seed.prompt ?? seed.draft ?? ""}`) : null,
  };
});
jest.mock("../../components/deals/NotForMeSheet", () => ({ NotForMeSheet: () => null }));

const NOW = new Date();
const today = `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, "0")}-${String(NOW.getDate()).padStart(2, "0")}`;
const post = (id: string): GoalActionView => ({
  id, title: `Post ${id}`, kind: "post_kit", when: null, state: "to_start", studioItemId: null, open: null, startPrompt: null, planKind: "post",
  why: "", button: "post", buttonLabel: "", dueOn: today, event: null,
  deliverable: { type: "post_brief", title: "", body: "", target: null, platform: null, thread: null, connector: null },
  approvalId: null, post: null, pillar: null, kit: { built: true, assets: 2, aiGenerationNeeded: false, preview: null },
});
const goals: AgentGoalsResponse = {
  contract: "agent-goals/1",
  goals: [{ id: "g", text: "g", plan: null, horizon: null, domain: null, actions: [post("a1"), post("a2")], status: "active", source: "athlete", gamePlanBy: "athlete", inYourWords: true, priority: 1, nextEvent: null } as any],
  setAside: [], recommended: [], comingUp: [], riskUpside: null, missing: [], plan: null,
};
const model = homeV3Model({
  now: NOW, goals, board: null, bookingRequests: null, winPosts: null, push: "undetermined",
  next: [{ key: "payout_setup", kind: "payout_setup", dueAt: null, at: null, order: null, title: null, brandName: null, logoUrl: null, amountCents: 10000, currency: "usd", target: { screen: "financials" } }],
  connections: [],
});
jest.mock("../../hooks/use-home-v3", () => {
  const actual = jest.requireActual("../../hooks/use-home-v3");
  return { ...actual, useHomeV3: () => ({ ...model, loading: false, refetch: async () => {} }) };
});

beforeEach(() => { navigate.mockReset(); });

it("draws the pieces: circles with badges, ONE admin row with +N, Mila's briefing", async () => {
  render(<HomeV3Screen />);
  await act(async () => {});
  expect(screen.getByText("NOMILA")).toBeTruthy();
  expect(screen.getByTestId("home-v3-circle-week")).toBeTruthy();
  expect(screen.getByTestId("home-v3-circle-offers")).toBeTruthy();
  expect(screen.getByTestId("home-v3-circle-moments")).toBeTruthy();
  expect(screen.queryByTestId("home-v3-circle-wins")).toBeNull();
  expect(screen.getByTestId("home-v3-badge-week").props.children).toBeTruthy();
  expect(screen.getByTestId("home-v3-ring-week-pink")).toBeTruthy();
  expect(screen.getAllByTestId("home-v3-admin")).toHaveLength(1);
  expect(screen.getByText("Set up payouts: $100 is waiting for you")).toBeTruthy();
  // payouts is the row; notifications, Instagram and an inbox are the "+3 more".
  expect(screen.getByText("+3 more")).toBeTruthy();
  // Mila's briefing: one post (the per-kind cap) as the hero card, greeted by her first name; the other post points at the circles.
  expect(screen.getAllByTestId("home-v3-hero-post")).toHaveLength(1);
  expect(screen.getByTestId("home-v3-brief-text").props.children).toMatch(/^(Morning|Afternoon|Evening), Sam — your post for today is ready\.$/);
  expect(screen.getByText("1 more in your circles")).toBeTruthy();
  // The avatar's badge: nice-to-have setup still to do.
  expect(screen.getByTestId("home-v3-avatar-badge")).toBeTruthy();
});

it("a circle opens its stories; seen but still waiting on her, the ring stays pink; the one action opens the post kit", async () => {
  render(<HomeV3Screen />);
  await act(async () => {});
  fireEvent.press(screen.getByTestId("home-v3-circle-week"));
  expect(screen.getByTestId("home-v3-story-week")).toBeTruthy();
  expect(within(screen.getByTestId("home-v3-story-week")).getByText("Post a1")).toBeTruthy();
  fireEvent.press(screen.getByTestId("home-v3-story-next"));
  expect(within(screen.getByTestId("home-v3-story-week")).getByText("Post a2")).toBeTruthy();
  fireEvent.press(screen.getByTestId("home-v3-story-action"));
  expect(navigate).toHaveBeenCalledWith("Studio", { screen: "PostKit", params: { id: "a2" } });
  await act(async () => {});
  expect(screen.queryByTestId("home-v3-story-week")).toBeNull();
  // Both seen, but both posts still need her (the badge): the ring stays pink, never grey while she owes something.
  expect(screen.getByTestId("home-v3-ring-week-pink")).toBeTruthy();
});

it("+N more opens the checklist", async () => {
  render(<HomeV3Screen />);
  await act(async () => {});
  fireEvent.press(screen.getByTestId("home-v3-admin-more"));
  expect(screen.getByTestId("home-v3-checklist")).toBeTruthy();
  expect(screen.getByText("0 of 4 done")).toBeTruthy();
});

it("the briefing's chips: Review & post opens the kit; Later hides it for today and the next post takes its place", async () => {
  render(<HomeV3Screen />);
  await act(async () => {});
  fireEvent.press(screen.getByTestId("home-v3-chip-post-open"));
  expect(navigate).toHaveBeenCalledWith("Studio", { screen: "PostKit", params: { id: "a1" } });
  fireEvent.press(screen.getByTestId("home-v3-chip-post-later"));
  await act(async () => {});
  // a2 now; nothing else left to point at.
  expect(screen.getAllByTestId("home-v3-hero-post")).toHaveLength(1);
  expect(screen.queryByText("1 more in your circles")).toBeNull();
  fireEvent.press(screen.getByTestId("home-v3-chip-post-open"));
  expect(navigate).toHaveBeenLastCalledWith("Studio", { screen: "PostKit", params: { id: "a2" } });
});

it("with nothing to say, the quiet-day idea asks Mila in the chat sheet (sent for her)", async () => {
  const quiet = homeV3Model({ now: NOW, goals: null, board: null, bookingRequests: null, winPosts: null, push: "granted", next: [], connections: [] });
  const hooks = require("../../hooks/use-home-v3");
  const spy = jest.spyOn(hooks, "useHomeV3").mockReturnValue({ ...quiet, loading: false, refetch: async () => {} });
  render(<HomeV3Screen />);
  await act(async () => {});
  expect(screen.queryByTestId("chat-sheet")).toBeNull();
  fireEvent.press(screen.getByTestId("home-v3-chip-idea-ask"));
  expect(screen.getByTestId("chat-sheet").props.children).toBe("chat:Give me one idea for my next post.");
  spy.mockRestore();
});
