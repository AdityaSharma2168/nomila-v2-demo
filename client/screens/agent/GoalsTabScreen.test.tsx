/**
 * GoalsTabScreen.test — the Goals tab (AGENT_V3 + AGENT_PLAN), the chosen design, over typed GET /me/agent/goals
 * fixtures through the in-memory AgentApi (no provider is reached: the API, the media pool and navigation are mocked).
 *
 *   dark route        → today's GoalsScreen, unchanged
 *   one open          the first goal in full; the others compact; a tap anywhere on a compact card opens it and folds
 *                     the open one; Home's goalId opens that goal
 *   actions           each with its button; the button and the whole row go to the same place; logos lead platform and
 *                     brand actions; "Before <event> on <date>"
 *   writes            keep · not now · add · change · set aside · drop · bring back · undo, each through goalWrite
 *   images            her action shot only for a performance goal; atmosphere, never a credit line; category default
 *                     while the picker is dark
 *   never             upside / risk; "AI"
 *   post rows         a post reads as its idea with its kit's button and state; a tap opens it in place, one at a time;
 *                     Open kit / Build it go to the kit; "Mila is updating your plan", polling only while a plan is in
 *                     progress, then "Your plan is updated: N posts this week."
 *   recommended       plan 1.5.0: "Once" or what repeats it on the card; opened, the actions held for it (read only)
 */
import React from "react";
import { act, configure, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { renderAgent, spyApi } from "../../test/agentHarness";
import { fixtureAgentApi } from "../../lib/agent/fixtureApi";
import { GOALS_PLAN_FIXTURE, goalsPostsFixture } from "../../lib/agent/goalsFixtures";
import { POST_KIT_FIXTURE, POST_KIT_PREVIEW_READY } from "../../lib/agent/fixtures";
import { GOALS_POLL_MS, goalsRefetchInterval } from "../../lib/agent/hooks";
import { POST_KIT_COPY } from "../../components/postKit/copy";
import { GoalsTab, GOALS_TAB_COPY } from "./GoalsTabScreen";
import { GOALS_UPDATING_COPY, type AtmosphereSlot } from "../../lib/agent/goalsLogic";
import type { PostKitResponse } from "../../../shared/postKit";

jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("expo-linear-gradient", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { LinearGradient: (p: Record<string, unknown>) => React.createElement(View, p) };
});
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
const navigate = jest.fn();
const setParams = jest.fn();
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate, setParams, goBack: jest.fn() }), useIsFocused: () => true }));
jest.mock("../../lib/auth-context", () => ({ useAuth: () => ({ athlete: { id: "ath-1" } }) }));
const openMila = jest.fn();
jest.mock("../../lib/milaLaunch", () => ({ openMila: (l: unknown) => openMila(l) }));
const openSettings = jest.fn();
jest.mock("../../navigation/meNav", () => ({ openSettings: (n: unknown) => openSettings(n) }));
let mockPool: Array<Record<string, unknown>> = [];
jest.mock("../../hooks/use-me-knowledge", () => ({ useMePool: () => mockPool }));

// A full Goals screen (five category-default SVGs, the rail) renders slowly on a cold Windows runner: wait generously.
configure({ asyncUtilTimeout: 10_000 });
jest.setTimeout(60_000);

beforeEach(() => { navigate.mockClear(); setParams.mockClear(); openMila.mockClear(); openSettings.mockClear(); mockPool = []; });

/** The read settles (a real tick inside act first: waitFor alone can poll past the query's resolution), then the screen is drawn. */
const ready = async () => {
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  await waitFor(() => { expect(screen.getByTestId("goals-tab")).toBeTruthy(); expect(screen.queryByTestId("goals-loading")).toBeNull(); });
};
/** A write's tap: pressed inside act with a real tick, so the mutation and the fresh read land before the next look. */
const tapWrite = async (testID: string) => { await act(async () => { fireEvent.press(screen.getByTestId(testID)); await new Promise((r) => setTimeout(r, 50)); }); };
const card = (id: string) => screen.getByTestId(`goal-card-${id}`);
const atmosphere = (slot: AtmosphereSlot) => ({ key: slot.key, kind: "image" as const, imageId: `img-${slot.key}`, url: `https://example.test/${slot.key}.jpg`, width: null, height: null });

describe("Goals tab: route dark", () => {
  it("while GET /me/agent/goals answers 404 (AGENT_PLAN off) the tab is today's GoalsScreen", async () => {
    renderAgent(<GoalsTab />);
    await waitFor(() => expect(screen.getByTestId("agent-goals")).toBeTruthy());
    expect(screen.queryByTestId("goals-tab")).toBeNull();
  });
});

describe("Goals tab: the chosen design", () => {
  it("loading, then the title and the first goal open in full; the others compact", async () => {
    renderAgent(<GoalsTab />, { opts: { plan: GOALS_PLAN_FIXTURE } });
    await ready();
    expect(screen.getByText(GOALS_TAB_COPY.title)).toBeTruthy();
    expect(screen.getByText(GOALS_TAB_COPY.lede)).toBeTruthy();
    const full = within(card("goal-1"));
    expect(full.getByText("Goal 1 of 3")).toBeTruthy();
    expect(full.getByText("“Land my first paid partnership this season.”")).toBeTruthy();
    expect(full.getByText("Game plan")).toBeTruthy();
    expect(full.getByText(/Pitch two brands/)).toBeTruthy();
    expect(full.getByText("This week")).toBeTruthy();
    expect(full.getAllByText("Commercial").length).toBeGreaterThan(0);
    expect(full.getByText("This month")).toBeTruthy();
    expect(full.getByText("Review")).toBeTruthy();
    expect(full.getByText("Start with Mila")).toBeTruthy();
    expect(full.getAllByText("Before [Event A] on 18 Oct").length).toBe(2);
    // Compact: goal line, horizon chip, the next action; no game plan.
    const two = within(card("goal-2"));
    expect(two.getByText("Goal 2 of 3")).toBeTruthy();
    expect(two.getByText("This quarter")).toBeTruthy();
    expect(two.getByText("Next")).toBeTruthy();
    expect(two.getByText("Post-game post, ready to check")).toBeTruthy();
    expect(two.queryByText("One post after every game.")).toBeNull();
    const three = within(card("goal-3"));
    expect(three.getByText("This year")).toBeTruthy();
    // Nomila's wording is never quoted; a month-only event reads its month.
    expect(three.getByText("Get stronger for next season.")).toBeTruthy();
    expect(three.getByText("Before [Event C] in December")).toBeTruthy();
  });

  it("a tap anywhere on a compact card opens it and folds the open one", async () => {
    renderAgent(<GoalsTab />, { opts: { plan: GOALS_PLAN_FIXTURE } });
    await ready();
    fireEvent.press(screen.getByTestId("goal-toggle-goal-2"));
    expect(within(card("goal-2")).getByText("One post after every game.")).toBeTruthy();
    expect(screen.getByTestId("goal-toggle-goal-1")).toBeTruthy();
    expect(within(card("goal-1")).queryByText(/Pitch two brands/)).toBeNull();
  });

  it("Home's Coming up opens the tab at the goal timed for the event", async () => {
    renderAgent(<GoalsTab route={{ params: { goalId: "goal-3" } }} />, { opts: { plan: GOALS_PLAN_FIXTURE } });
    await ready();
    await waitFor(() => expect(within(card("goal-3")).getByText("This week")).toBeTruthy());
    expect(screen.getByTestId("goal-toggle-goal-1")).toBeTruthy();
    expect(setParams).toHaveBeenCalledWith({ goalId: undefined });
  });

  it("logos lead platform and brand actions only", async () => {
    renderAgent(<GoalsTab />, { opts: { plan: GOALS_PLAN_FIXTURE } });
    await ready();
    expect(screen.getByTestId("action-mark-act-pitch")).toBeTruthy();   // a brand
    expect(screen.getByTestId("action-mark-act-post")).toBeTruthy();    // a platform (compact next action)
    expect(screen.queryByTestId("action-mark-act-floor")).toBeNull();   // neither
  });

  it("each action's button and its whole row go to the same place", async () => {
    renderAgent(<GoalsTab />, { opts: { plan: GOALS_PLAN_FIXTURE } });
    await ready();
    fireEvent.press(screen.getByTestId("goal-action-button-act-pitch"));
    expect(navigate).toHaveBeenLastCalledWith("Studio", { screen: "StudioHome", params: { focus: "studio-1" } });
    navigate.mockClear();
    fireEvent.press(screen.getByTestId("goal-action-act-pitch"));
    expect(navigate).toHaveBeenLastCalledWith("Studio", { screen: "StudioHome", params: { focus: "studio-1" } });
    fireEvent.press(screen.getByTestId("goal-action-button-act-floor"));
    expect(openMila).toHaveBeenCalledWith({ prompt: "Help me set my floor rate." });
    // A compact card's action button keeps its own target: it does not open the card.
    fireEvent.press(screen.getByTestId("goal-action-button-act-connect"));
    expect(openSettings).toHaveBeenCalled();
    expect(within(card("goal-3")).queryByText("This week")).toBeNull();
  });

  it("never shows the upside / risk read, and never says AI", async () => {
    renderAgent(<GoalsTab />, { opts: { plan: GOALS_PLAN_FIXTURE } });
    await ready();
    expect(screen.queryByText(/must never show/)).toBeNull();
    expect(screen.queryByText(/\bAI\b/)).toBeNull();
  });

  it("error state with Retry", async () => {
    const api = spyApi(fixtureAgentApi({ plan: GOALS_PLAN_FIXTURE }));
    api.readGoals.mockRejectedValueOnce(new Error("500: boom"));
    renderAgent(<GoalsTab />, { api });
    await waitFor(() => expect(screen.getByTestId("goals-error")).toBeTruthy());
    fireEvent.press(screen.getByText(GOALS_TAB_COPY.retry));
    await waitFor(() => expect(screen.getByTestId("goal-card-goal-1")).toBeTruthy());
  });

  it("empty: no goals yet, Add a goal still there", async () => {
    renderAgent(<GoalsTab />, { opts: { plan: { ...GOALS_PLAN_FIXTURE, goals: [] } } });
    await ready();
    expect(screen.getByTestId("goals-empty")).toBeTruthy();
    expect(screen.getByTestId("goals-add")).toBeTruthy();
  });
});

describe("Goals tab: recommended and the writes", () => {
  it("Recommended for you: a rail; a tap opens its game plan; Keep makes it a goal, with Undo", async () => {
    const { api } = renderAgent(<GoalsTab />, { opts: { plan: GOALS_PLAN_FIXTURE } });
    await ready();
    expect(within(screen.getByTestId("goals-recommended")).getByText(GOALS_TAB_COPY.recommended)).toBeTruthy();
    fireEvent.press(screen.getByTestId("goal-recommended-open-rec-1"));
    expect(screen.getByTestId("goal-recommended-plan-rec-1")).toBeTruthy();
    await tapWrite("goal-keep-rec-1");
    await waitFor(() => expect(screen.getByTestId("goals-notice")).toBeTruthy());
    expect(api.goalWrite).toHaveBeenCalledWith({ op: "keep", decisionId: "rec-1" });
    expect(screen.queryByTestId("goal-recommended-rec-1")).toBeNull();
    expect(screen.getByTestId("goal-card-kept-rec-1")).toBeTruthy();
    expect(screen.getByText(GOALS_TAB_COPY.done.keep)).toBeTruthy();
    await tapWrite("goals-undo");
    await waitFor(() => expect(api.goalWrite).toHaveBeenLastCalledWith({ op: "undo", decisionId: expect.stringMatching(/^change-/) }));
  });

  it("plan 1.5.0: a recommendation says Once or what repeats it, and opened it shows the actions held for it", async () => {
    renderAgent(<GoalsTab />, { opts: { plan: GOALS_PLAN_FIXTURE } });
    await ready();
    expect(within(screen.getByTestId("goal-recommended-rec-1")).getByText("Before every event")).toBeTruthy();
    expect(within(screen.getByTestId("goal-recommended-rec-2")).getByText("Once")).toBeTruthy();
    expect(screen.queryByTestId("goal-recommended-actions-rec-1")).toBeNull();
    fireEvent.press(screen.getByTestId("goal-recommended-open-rec-1"));
    const held = within(screen.getByTestId("goal-recommended-actions-rec-1"));
    expect(held.getByText("“The night before [Event A].”")).toBeTruthy();
    expect(held.getByText("Before [Event A] on 18 Oct")).toBeTruthy();
    // A recommendation with nothing held shows no list.
    fireEvent.press(screen.getByTestId("goal-recommended-open-rec-2"));
    expect(screen.queryByTestId("goal-recommended-actions-rec-2")).toBeNull();
  });

  it("Not now skips it", async () => {
    const { api } = renderAgent(<GoalsTab />, { opts: { plan: GOALS_PLAN_FIXTURE } });
    await ready();
    await tapWrite("goal-skip-rec-2");
    await waitFor(() => expect(screen.queryByTestId("goal-recommended-rec-2")).toBeNull());
    expect(api.goalWrite).toHaveBeenCalledWith({ op: "skip", decisionId: "rec-2" });
    expect(screen.getByText(GOALS_TAB_COPY.skipped)).toBeTruthy();
  });

  it("Add a goal: your words and a horizon", async () => {
    const { api } = renderAgent(<GoalsTab />, { opts: { plan: GOALS_PLAN_FIXTURE } });
    await ready();
    fireEvent.press(screen.getByTestId("goals-add"));
    expect(screen.getByTestId("goal-editor-save").props.accessibilityState.disabled).toBe(true);
    fireEvent.changeText(screen.getByTestId("goal-editor-text"), "Run a summer camp");
    fireEvent.press(screen.getByTestId("goal-editor-horizon-next"));
    await tapWrite("goal-editor-save");
    await waitFor(() => expect(screen.getByText("“Run a summer camp”")).toBeTruthy());
    expect(api.goalWrite).toHaveBeenCalledWith({ op: "add", text: "Run a summer camp", horizon: "next" });
  });

  it("Change, Set aside, Bring back and Drop", async () => {
    const { api } = renderAgent(<GoalsTab />, { opts: { plan: GOALS_PLAN_FIXTURE } });
    await ready();
    fireEvent.press(screen.getByTestId("goal-change-goal-1"));
    fireEvent.changeText(screen.getByTestId("goal-editor-text"), "Land two paid partnerships");
    await tapWrite("goal-editor-save");
    await waitFor(() => expect(screen.getByText("“Land two paid partnerships”")).toBeTruthy());
    expect(api.goalWrite).toHaveBeenCalledWith({ op: "change", goalId: "goal-1", text: "Land two paid partnerships", horizon: "now" });

    await tapWrite("goal-set-aside-goal-1");
    await waitFor(() => expect(screen.getByTestId("goal-set-aside-row-goal-1")).toBeTruthy());
    expect(within(screen.getByTestId("goals-set-aside")).getByText(GOALS_TAB_COPY.setAside)).toBeTruthy();
    // The next goal is open now.
    expect(within(card("goal-2")).getByText("This week")).toBeTruthy();

    await waitFor(() => expect(screen.getByText(GOALS_TAB_COPY.done.set_aside)).toBeTruthy());
    await tapWrite("goal-bring-back-goal-4");
    await waitFor(() => expect(screen.getByTestId("goal-card-goal-4")).toBeTruthy());
    expect(api.goalWrite).toHaveBeenCalledWith({ op: "bring_back", goalId: "goal-4" });

    await waitFor(() => expect(screen.getByTestId("goal-drop-goal-2").props.accessibilityState.disabled).toBe(false));
    await tapWrite("goal-drop-goal-2");
    await waitFor(() => expect(screen.queryByTestId("goal-card-goal-2")).toBeNull());
    expect(api.goalWrite).toHaveBeenCalledWith({ op: "drop", goalId: "goal-2" });
    expect(screen.getByText(GOALS_TAB_COPY.done.drop)).toBeTruthy();
  });

  it("a write that fails says so", async () => {
    const api = spyApi(fixtureAgentApi({ plan: GOALS_PLAN_FIXTURE }));
    api.goalWrite.mockRejectedValueOnce(new Error("500: boom"));
    renderAgent(<GoalsTab />, { api });
    await ready();
    await act(async () => { fireEvent.press(screen.getByTestId("goal-drop-goal-1")); });
    await waitFor(() => expect(screen.getByText(GOALS_TAB_COPY.failed)).toBeTruthy());
    expect(screen.getByTestId("goal-card-goal-1")).toBeTruthy();
  });
});

describe("Goals tab: post rows (design 'Goals tab post details + plan ready')", () => {
  const kitFor = (id: string, over: Partial<PostKitResponse> = {}): PostKitResponse => ({ ...POST_KIT_FIXTURE, decisionId: id, ...over });

  it("each post reads as its idea: format · moment (else pillar), the opening line, one button and the kit's state", async () => {
    renderAgent(<GoalsTab />, { opts: { plan: goalsPostsFixture() } });
    await ready();
    const ready1 = within(screen.getByTestId("goal-post-act-post-ready"));
    expect(ready1.getByText("Reel · Before [Event A]")).toBeTruthy();
    expect(ready1.getByText("“Nobody sees the early part.”")).toBeTruthy();
    expect(ready1.getByText("Open kit")).toBeTruthy();
    expect(within(screen.getByTestId("goal-post-status-act-post-ready")).getByText("Kit ready")).toBeTruthy();
    const preparing = within(screen.getByTestId("goal-post-act-post-preparing"));
    expect(preparing.getByText("Carousel · Behind the scenes")).toBeTruthy();
    expect(preparing.getByText("Preparing your preview")).toBeTruthy();
    const noKit = within(screen.getByTestId("goal-post-act-post-nokit"));
    expect(noKit.getByText("Story · Your community")).toBeTruthy();
    expect(noKit.getByText("Build it")).toBeTruthy();
    // The older plan-title row and its "Start with Mila" are gone for posts; no picture on a closed row.
    expect(within(card("goal-2")).queryByText("Start with Mila")).toBeNull();
    expect(screen.queryByTestId("goal-post-thumb-act-post-ready")).toBeNull();
    // Pitches and other kinds keep today's row.
    expect(screen.getByTestId("goal-action-act-pitch")).toBeTruthy();
  });

  it("a tap on a row opens its idea in place, one at a time; the button keeps its own target", async () => {
    renderAgent(<GoalsTab />, { opts: { plan: goalsPostsFixture(), postKits: { "act-post-ready": kitFor("act-post-ready", POST_KIT_PREVIEW_READY) } } });
    await ready();
    fireEvent.press(screen.getByTestId("goal-post-toggle-act-post-ready"));
    const detail = within(screen.getByTestId("goal-post-detail-act-post-ready"));
    for (const t of ["What it shows", "The caption", "Leave out", "You'll need", "Why now", "Open post kit", "Talk it over with Mila", "Behind the scenes", "[Event A] · Sun 18 Oct"]) expect(detail.getByText(t)).toBeTruthy();
    expect(detail.getByText(/arriving early, warming up alone/)).toBeTruthy();
    // The preview's picture, read through the kit's own query (the kit screen then opens at once).
    await waitFor(() => expect(screen.getByTestId("goal-post-thumb-act-post-ready")).toBeTruthy());
    expect(detail.getByText("Your preview")).toBeTruthy();
    // Opening another closes the first.
    fireEvent.press(screen.getByTestId("goal-post-toggle-act-post-nokit"));
    expect(screen.queryByTestId("goal-post-detail-act-post-ready")).toBeNull();
    expect(screen.getByTestId("goal-post-detail-act-post-nokit")).toBeTruthy();
    // The row's button opens the kit without opening the row.
    fireEvent.press(screen.getByTestId("goal-post-button-act-post-preparing"));
    expect(navigate).toHaveBeenLastCalledWith("Studio", { screen: "PostKit", params: { id: "act-post-preparing" } });
    expect(screen.queryByTestId("goal-post-detail-act-post-preparing")).toBeNull();
    // Talk it over with Mila asks about the post (nothing goes out).
    fireEvent.press(screen.getByTestId("goal-post-talk-act-post-nokit"));
    expect(openMila).toHaveBeenCalledWith({ prompt: "Post a story asking for questions" });
  });

  it("Open post kit in the opened row goes to the kit", async () => {
    renderAgent(<GoalsTab />, { opts: { plan: goalsPostsFixture() } });
    await ready();
    fireEvent.press(screen.getByTestId("goal-post-toggle-act-post-ready"));
    fireEvent.press(screen.getByTestId("goal-post-open-act-post-ready"));
    expect(navigate).toHaveBeenLastCalledWith("Studio", { screen: "PostKit", params: { id: "act-post-ready" } });
  });

  it("Build it builds the kit (a tap: nothing goes out), then opens it", async () => {
    const empty = kitFor("act-post-nokit", { state: "to_start", kit: null, preview: null });
    const { api } = renderAgent(<GoalsTab />, { opts: { plan: goalsPostsFixture(), postKits: { "act-post-nokit": empty } } });
    await ready();
    await tapWrite("goal-post-button-act-post-nokit");
    await waitFor(() => expect(navigate).toHaveBeenLastCalledWith("Studio", { screen: "PostKit", params: { id: "act-post-nokit" } }));
    expect(api.postKitWrite).toHaveBeenCalledWith({ op: "build", id: "act-post-nokit" });
  });

  it("a build that makes nothing says why, in plain words, and stays on Goals", async () => {
    const empty = kitFor("act-post-nokit", { state: "to_start", kit: null, preview: null });
    renderAgent(<GoalsTab />, { opts: { plan: goalsPostsFixture(), postKits: { "act-post-nokit": empty }, postKitBuildOutcome: { status: "held", reason: "never_content" } } });
    await ready();
    await tapWrite("goal-post-button-act-post-nokit");
    await waitFor(() => expect(screen.getByText(POST_KIT_COPY.buildHeld)).toBeTruthy());
    expect(navigate).not.toHaveBeenCalled();
  });

  it("while Mila builds kits the row says so and its button is off", async () => {
    renderAgent(<GoalsTab />, { opts: { plan: goalsPostsFixture({ planning: { runId: "run-2", step: "post_kits", startedAt: "2026-10-12T09:00:00.000Z" } }) } });
    await ready();
    expect(within(screen.getByTestId("goal-post-act-post-nokit")).getByText("Mila is building your kit")).toBeTruthy();
    expect(screen.getByTestId("goal-post-button-act-post-nokit").props.accessibilityState.disabled).toBe(true);
  });

  it("a plan in progress: 'Mila is updating your plan', a re-read every 5 s while it lasts, then the updated notice", async () => {
    jest.useFakeTimers();
    try {
      const api = spyApi(fixtureAgentApi({ plan: goalsPostsFixture(), latencyMs: 0 }));
      const running = goalsPostsFixture({ planning: { runId: "run-2", step: "plan", startedAt: "2026-10-12T09:00:00.000Z" } });
      api.readGoals.mockResolvedValueOnce(running);
      renderAgent(<GoalsTab />, { api });
      await act(async () => { await jest.advanceTimersByTimeAsync(100); });
      expect(within(screen.getByTestId("goals-updating")).getByText(GOALS_UPDATING_COPY.title)).toBeTruthy();
      expect(screen.getByText(GOALS_UPDATING_COPY.sub)).toBeTruthy();
      const calls = api.readGoals.mock.calls.length;
      await act(async () => { await jest.advanceTimersByTimeAsync(GOALS_POLL_MS + 100); });
      expect(screen.queryByTestId("goals-updating")).toBeNull();
      expect(api.readGoals.mock.calls.length).toBe(calls + 1);
      expect(screen.getByText("Your plan is updated: 3 posts this week.")).toBeTruthy();
      // Nothing in progress: no more re-reads.
      await act(async () => { await jest.advanceTimersByTimeAsync(3 * GOALS_POLL_MS); });
      expect(api.readGoals.mock.calls.length).toBe(calls + 1);
    } finally { jest.useRealTimers(); }
  });

  it("the plan-updated notice never replaces a pending Undo", async () => {
    jest.useFakeTimers();
    try {
      // A plan run is in progress when she makes a change; the change's fresh read is the one that shows the run over.
      const api = spyApi(fixtureAgentApi({ plan: goalsPostsFixture(), latencyMs: 0 }));
      api.readGoals.mockResolvedValueOnce(goalsPostsFixture({ planning: { runId: "run-3", step: "plan", startedAt: "2026-10-12T09:00:00.000Z" } }));
      renderAgent(<GoalsTab />, { api });
      await act(async () => { await jest.advanceTimersByTimeAsync(100); });
      expect(screen.getByTestId("goals-updating")).toBeTruthy();
      await act(async () => { fireEvent.press(screen.getByTestId("goal-set-aside-goal-2")); await jest.advanceTimersByTimeAsync(100); });
      expect(screen.queryByTestId("goals-updating")).toBeNull();
      // The run is over, but her Undo stays.
      expect(screen.getByTestId("goals-undo")).toBeTruthy();
      expect(screen.queryByText(/Your plan is updated/)).toBeNull();
    } finally { jest.useRealTimers(); }
  });

  it("a screen reader reaches the row's Open kit / Build it as an action on the row", async () => {
    renderAgent(<GoalsTab />, { opts: { plan: goalsPostsFixture() } });
    await ready();
    const row = screen.getByTestId("goal-post-toggle-act-post-nokit");
    expect(row.props.accessibilityActions).toEqual([{ name: "activate" }, { name: "kit", label: "Build it" }]);
    const ready1 = screen.getByTestId("goal-post-toggle-act-post-preparing");
    expect(ready1.props.accessibilityActions).toEqual([{ name: "activate" }, { name: "kit", label: "Open kit" }]);
    fireEvent(ready1, "accessibilityAction", { nativeEvent: { actionName: "kit" } });
    expect(navigate).toHaveBeenLastCalledWith("Studio", { screen: "PostKit", params: { id: "act-post-preparing" } });
    fireEvent(ready1, "accessibilityAction", { nativeEvent: { actionName: "activate" } });
    expect(screen.getByTestId("goal-post-detail-act-post-preparing")).toBeTruthy();
  });

  it("a folded goal's next post keeps its Next eyebrow", async () => {
    const plan = goalsPostsFixture();
    renderAgent(<GoalsTab />, { opts: { plan: { ...plan, goals: [plan.goals[1], plan.goals[0], ...plan.goals.slice(2)] } } });
    await ready();
    expect(within(screen.getByTestId("goal-post-act-post-ready")).getByText("Next")).toBeTruthy();
  });

  it("DESIGN.md §9: with two photos of her on screen, the opened post shows no kit picture", async () => {
    mockPool = [
      { asset_id: "p1", url: "https://example.test/her-1.jpg", shot_type: "action" },
      { asset_id: "p2", url: "https://example.test/her-2.jpg", shot_type: "action" },
    ];
    const plan = goalsPostsFixture();
    const perf = (g: (typeof plan.goals)[number]) => ({ ...g, domain: "athletic" as const });
    renderAgent(<GoalsTab />, { opts: { plan: { ...plan, goals: [perf(plan.goals[0]), perf(plan.goals[1]), ...plan.goals.slice(2)] }, postKits: { "act-post-ready": kitForThumb() } } });
    await ready();
    fireEvent.press(screen.getByTestId("goal-post-toggle-act-post-ready"));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.queryByTestId("goal-post-thumb-act-post-ready")).toBeNull();
  });

  it("the poll runs only while a plan is in progress", () => {
    expect(goalsRefetchInterval(goalsPostsFixture())).toBe(false);
    expect(goalsRefetchInterval(null)).toBe(false);
    expect(goalsRefetchInterval(goalsPostsFixture({ planning: { runId: "r", step: "tell", startedAt: "2026-10-12T09:00:00.000Z" } }))).toBe(GOALS_POLL_MS);
  });
});

const kitForThumb = (): PostKitResponse => ({ ...POST_KIT_PREVIEW_READY, decisionId: "act-post-ready" });

describe("Goals tab: images (DESIGN.md §9)", () => {
  it("picker dark: every card draws its category default", async () => {
    renderAgent(<GoalsTab />, { opts: { plan: GOALS_PLAN_FIXTURE } });
    await ready();
    expect(screen.queryAllByTestId("goal-visual-performance")).toHaveLength(0);
    expect(screen.queryAllByTestId("goal-visual-subject")).toHaveLength(0);
    expect(screen.getAllByTestId("goal-visual-typographic").length).toBeGreaterThanOrEqual(5);
  });

  it("her action shot only for the performance goal; atmosphere for every other card, with no image credit anywhere", async () => {
    mockPool = [{ asset_id: "p1", url: "https://example.test/her-action.jpg", shot_type: "action" }, { asset_id: "p2", url: "https://example.test/her-portrait.jpg", shot_type: "portrait" }];
    const { api } = renderAgent(<GoalsTab />, { opts: { plan: GOALS_PLAN_FIXTURE, atmosphere } });
    await ready();
    await waitFor(() => expect(screen.getAllByTestId("goal-visual-subject").length).toBe(4));
    const [screenName, slots] = api.pickAtmosphere.mock.calls[0] as [string, AtmosphereSlot[]];
    expect(screenName).toBe("goals");
    // The performance goal (goal-3, athletic) asks for no atmosphere: it has her photo.
    expect(slots.map((s) => s.key)).toEqual(["goal:goal-1", "goal:goal-2", "rec:rec-1", "rec:rec-2"]);
    expect(within(card("goal-3")).getByTestId("goal-visual-performance")).toBeTruthy();
    expect(screen.getAllByTestId("goal-visual-performance")).toHaveLength(1);
    expect(within(card("goal-1")).getByTestId("goal-visual-subject")).toBeTruthy();
    // Owner decision (#907): no photographer or image credit is shown anywhere.
    expect(screen.queryAllByTestId("atmosphere-credit")).toHaveLength(0);
    expect(screen.queryByText(/credit|photo by|pixabay|unsplash|placeholder/i)).toBeNull();
  });
});
