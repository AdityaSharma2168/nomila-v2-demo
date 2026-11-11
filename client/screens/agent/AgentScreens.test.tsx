/**
 * AgentScreens.test — the onboarding flow (name → conversation → Home, resumable, loading / error), Goals and the Studio
 * library (loading · error · empty · active), each from typed fixtures over the in-memory AgentApi. Taps go somewhere.
 */
import React from "react";
import { AccessibilityInfo } from "react-native";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { renderAgent, spyApi } from "../../test/agentHarness";
import { fixtureAgentApi } from "../../lib/agent/fixtureApi";
import { AgentOnboardingFlow } from "./AgentOnboardingFlow";
import { GoalsScreen, GOALS_COPY } from "./GoalsScreen";
import { StudioLibraryScreen, filterItems } from "./StudioLibraryScreen";
import { PublishedSection } from "../../components/agent/PublishedSection";
import { STUDIO_FIXTURE } from "../../lib/agent/fixtures";
import { CAPABILITY_PROMPT } from "./AgentOnboardingFlow";

jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
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
jest.mock("expo-video", () => {
  const React = require("react");
  return {
    useVideoPlayer: () => ({ play: () => {}, pause: () => {}, loop: false, muted: true }),
    VideoView: (p: Record<string, unknown>) => React.createElement(require("react-native").View, p),
  };
});
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
jest.mock("../../hooks/use-platform-oauth", () => ({ usePlatformOAuth: () => ({ connect: jest.fn(), disconnect: jest.fn(), connecting: false }) }));
const navigate = jest.fn();
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate, goBack: jest.fn() }), useIsFocused: () => true }));
jest.mock("../../lib/auth-context", () => ({ useAuth: () => ({ athlete: { id: "ath-1" } }) }));
const openMila = jest.fn();
jest.mock("../../lib/milaLaunch", () => ({ openMila: (l: unknown) => openMila(l) }));

beforeEach(() => {
  navigate.mockClear();
  openMila.mockClear();
  // ProgressCard/ResearchActivityCard pulse with a real Animated.loop while a research step or progress card is
  // "running" (that loop's requestAnimationFrame-via-setTimeout chain would outlive the test, since this file never
  // flips those cards' state to done; the client#3 hang itself was StatusBar, see the research test). Same guard as MilaSearchOverlay.test.tsx and
  // MeAgentScreen.test.tsx: force reduced motion so those components never start the loop at all.
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
  jest.spyOn(AccessibilityInfo, "addEventListener").mockImplementation(() => ({ remove: jest.fn() }) as never);
});
afterEach(() => { jest.restoreAllMocks(); });

describe("onboarding (adaptive, over #890's wire through the adapter)", () => {
  it("loading, then the one fixed screen; Start needs a name and a sport", async () => {
    const { api, unmount } = renderAgent(<AgentOnboardingFlow onDone={jest.fn()} />);
    expect(screen.getByTestId("onboarding-loading")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("onboarding-name")).toBeTruthy());
    expect(screen.getByTestId("onboarding-start").props.accessibilityState.disabled).toBe(true);
    fireEvent.changeText(screen.getByTestId("onboarding-name-input"), "Alex");
    fireEvent.changeText(screen.getByTestId("onboarding-sport-input"), "[Sport]");
    fireEvent.press(screen.getByTestId("onboarding-start"));
    await waitFor(() => expect(screen.getByTestId("onboarding-conversation")).toBeTruthy());
    expect(api.startOnboarding).toHaveBeenCalledWith({ name: "Alex", sport: "[Sport]" });
    // Research runs: the progress card lists the passes, and the subtle progress shows what's covered.
    expect(screen.getByTestId("progress-steps")).toBeTruthy();
    expect(within(screen.getByTestId("onboarding-covered")).getByText("1 of 7 covered")).toBeTruthy();
    unmount();
  });

  it("resumes mid-way: draws whatever turns the server holds", async () => {
    renderAgent(<AgentOnboardingFlow onDone={jest.fn()} />, { opts: { segment: 5 } });
    await waitFor(() => expect(screen.getByTestId("onboarding-conversation")).toBeTruthy());
    // The reveal moment (#891): the M.I.A. preview, then the reveal (idea, highlights, where you stand, timely windows).
    expect(screen.getByTestId("card-mia-preview")).toBeTruthy();
    expect(screen.getByTestId("reveal-standing")).toBeTruthy();
    expect(screen.getAllByTestId("reveal-window").length).toBeGreaterThan(0);
    expect(screen.getByTestId("card-rate-ranges")).toBeTruthy();
    expect(screen.getAllByTestId("card-connect")).toHaveLength(3);
    expect(screen.getAllByTestId("card-fact-review")).toHaveLength(3);
    expect(screen.getByTestId("fact-care")).toBeTruthy();
    expect(screen.getByTestId("card-age-band")).toBeTruthy();
    expect(within(screen.getByTestId("onboarding-covered")).getByText("3 of 7 covered")).toBeTruthy();
    expect(screen.queryByTestId("onboarding-finish")).toBeNull();
  });

  it("Keep going asks Mila for her next turn when the skill sent no quick replies", async () => {
    const { api } = renderAgent(<AgentOnboardingFlow onDone={jest.fn()} />, { opts: { segment: 3 } });
    await waitFor(() => expect(screen.getAllByTestId("onboarding-suggestion").length).toBe(1));
    fireEvent.press(screen.getByTestId("onboarding-suggestion"));
    await waitFor(() => expect(screen.getAllByTestId("card-connect").length).toBe(3));
    expect(api.turn).toHaveBeenCalledWith({ message: "Keep going" });
  });

  it("a card answer is an action on the turn; checkpoints move", async () => {
    const { api } = renderAgent(<AgentOnboardingFlow onDone={jest.fn()} />, { opts: { segment: 7 } });
    await waitFor(() => expect(screen.getByTestId("card-consent")).toBeTruthy());
    fireEvent.press(screen.getByTestId("consent-agree"));
    await waitFor(() => expect(screen.getByTestId("consent-done")).toBeTruthy());
    expect(api.turn).toHaveBeenCalledWith({ actions: [{ type: "consent", consentId: "how_mila_works/1", response: "agree" }], reply: true });
    await waitFor(() => expect(screen.getAllByTestId("card-capability").length).toBe(6));
  });

  it("goals: the athlete adds their own beside Mila's (an action, no reply)", async () => {
    const { api } = renderAgent(<AgentOnboardingFlow onDone={jest.fn()} />, { opts: { segment: 6 } });
    await waitFor(() => expect(screen.getByTestId("own-goal")).toBeTruthy());
    fireEvent.changeText(screen.getByTestId("own-goal-input"), "Play abroad one day");
    fireEvent.press(screen.getByTestId("own-goal-add"));
    await waitFor(() => expect(api.turn).toHaveBeenCalledWith({ actions: [{ type: "goal_add", text: "Play abroad one day" }], reply: false }));
  });

  it("every checkpoint met: Go to Home releases the app; a capability starts in Mila or opens its screen", async () => {
    const onDone = jest.fn();
    renderAgent(<AgentOnboardingFlow onDone={onDone} />, { opts: { segment: 8 } });
    await waitFor(() => expect(screen.getByTestId("onboarding-home")).toBeTruthy());
    fireEvent.press(screen.getAllByTestId("card-capability")[0]);
    expect(onDone).toHaveBeenCalledWith({ startPrompt: CAPABILITY_PROMPT("Deals") });
    screen.unmount();
    const onDone2 = jest.fn();
    renderAgent(<AgentOnboardingFlow onDone={onDone2} />, { opts: { segment: 8 } });
    await waitFor(() => expect(screen.getByTestId("onboarding-home")).toBeTruthy());
    fireEvent.press(screen.getAllByTestId("card-capability")[3]);
    expect(onDone2).toHaveBeenCalledWith({ startPrompt: null, screen: "me" });
    screen.unmount();
    const onDone3 = jest.fn();
    renderAgent(<AgentOnboardingFlow onDone={onDone3} />, { opts: { segment: 8 } });
    await waitFor(() => expect(screen.getByTestId("onboarding-home")).toBeTruthy());
    fireEvent.press(screen.getByTestId("onboarding-home"));
    expect(onDone3).toHaveBeenCalledWith({ startPrompt: null });
  });

  it("research runs live, then the presentation arrives without a tap", async () => {
    // Leave setImmediate/clearImmediate real (as OnboardingFront/MeAgentScreen do): the flow's loading ground mounts a
    // StatusBar, and RN keeps its pending update in the module-level StatusBar._updateImmediate. A FAKE immediate id
    // left there outlives useRealTimers(); the next StatusBar hands it to Node's real clearImmediate, which decrements
    // Node's immediate count for a timer it never queued — so every later setImmediate (React's scheduler) is skipped
    // and the rest of the file spins at 100% CPU forever. That was the client#3 CI hang.
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "clearImmediate", "queueMicrotask"] });
    try {
      const { unmount } = renderAgent(<AgentOnboardingFlow onDone={jest.fn()} />, { opts: { segment: 1, researchStepMs: 1000 } });
      await act(async () => { await jest.advanceTimersByTimeAsync(10); });
      expect(screen.getByTestId("progress-steps")).toBeTruthy();
      // Live activity (#891 events): what Mila reads, running counts, discoveries popping in; her quick question.
      await act(async () => { await jest.advanceTimersByTimeAsync(1600); });
      expect(screen.getByTestId("activity-reading")).toBeTruthy();
      expect(screen.getAllByTestId("activity-discovery").length).toBeGreaterThan(0);
      expect(screen.getByTestId("card-quick-question")).toBeTruthy();
      await act(async () => { await jest.advanceTimersByTimeAsync(6000); });
      expect(screen.getByTestId("card-mia-preview")).toBeTruthy();
      unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  it("a failed load says so and retries", async () => {
    const api = spyApi(fixtureAgentApi({ fail: true }));
    renderAgent(<AgentOnboardingFlow onDone={jest.fn()} />, { api });
    await waitFor(() => expect(screen.getByTestId("onboarding-error")).toBeTruthy());
    fireEvent.press(screen.getByTestId("onboarding-retry"));
    await waitFor(() => expect(api.getOnboarding).toHaveBeenCalledTimes(2));
  });
});

describe("Goals (one screen)", () => {
  it("each goal: the athlete's words, the game plan, this week's actions; made opens, to-start starts in Mila", async () => {
    renderAgent(<GoalsScreen />);
    expect(screen.getByTestId("goals-loading")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("goal-g-1")).toBeTruthy());
    expect(screen.getAllByText("Game plan").length).toBe(2);
    // Three goal eyebrows, plus one action due "This week".
    expect(screen.getAllByText("This week").length).toBe(4);
    fireEvent.press(screen.getByTestId("goal-action-a-1"));
    expect(navigate).toHaveBeenCalledWith("Studio", { screen: "PitchDetail", params: { brandId: 1, brandName: "[Brand A]" } });
    fireEvent.press(screen.getByTestId("goal-action-a-2"));
    expect(openMila).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Shortlist 5 brands that fit me." }));
    // A finished action is not a button.
    expect(screen.getByTestId("goal-action-a-3").props.accessibilityRole).toBeUndefined();
    fireEvent.press(screen.getByTestId("goal-plan-g-3"));
    expect(openMila).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: GOALS_COPY.planPrompt("Make my community work part of my public story") }));
  });

  it("empty and error", async () => {
    renderAgent(<GoalsScreen />, { opts: { goals: [] } });
    await waitFor(() => expect(screen.getByTestId("goals-empty")).toBeTruthy());
    fireEvent.press(screen.getByTestId("goals-add"));
    expect(openMila).toHaveBeenCalledWith({ draft: GOALS_COPY.addPrompt });
    screen.unmount();
    renderAgent(<GoalsScreen />, { opts: { fail: true } });
    await waitFor(() => expect(screen.getByTestId("goals-error")).toBeTruthy());
  });
});

describe("Studio library", () => {
  it("lists everything with status, version and goal; filters by kind; rows open their item", async () => {
    renderAgent(<StudioLibraryScreen />);
    expect(screen.getByTestId("studio-loading")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("studio-list")).toBeTruthy());
    expect(screen.getAllByTestId("status-published").length).toBe(2);
    expect(screen.getByTestId("status-experimental")).toBeTruthy();
    expect(screen.getByText("v2")).toBeTruthy();
    fireEvent.press(screen.getByTestId("studio-filter-deck"));
    expect(screen.queryByTestId("studio-item-studio-page-1")).toBeNull();
    fireEvent.press(screen.getByTestId("studio-item-studio-deck-1"));
    expect(navigate).toHaveBeenCalledWith("Studio", { screen: "PitchDetail", params: { brandId: 1, brandName: "[Brand A]" } });
    // An item with nowhere to open is not a button.
    fireEvent.press(screen.getByTestId("studio-filter-media_edit"));
    expect(screen.getByTestId("studio-item-studio-visual-1").props.accessibilityRole).toBeUndefined();
  });

  it("empty (per kind) and error", async () => {
    renderAgent(<StudioLibraryScreen />, { opts: { studio: [] } });
    await waitFor(() => expect(screen.getByTestId("studio-empty")).toBeTruthy());
    fireEvent.press(screen.getByTestId("studio-ask"));
    expect(openMila).toHaveBeenCalled();
    screen.unmount();
    renderAgent(<StudioLibraryScreen />, { opts: { fail: true } });
    await waitFor(() => expect(screen.getByTestId("studio-error")).toBeTruthy());
  });

  it("filterItems: newest first", () => {
    expect(filterItems(STUDIO_FIXTURE, "deck").map((i) => i.id)).toEqual(["studio-deck-1", "studio-deck-2"]);
  });

  it("published items also show on Me; nothing published → nothing drawn", async () => {
    renderAgent(<PublishedSection />);
    await waitFor(() => expect(screen.getByTestId("me-published")).toBeTruthy());
    expect(screen.getAllByTestId("status-published").length).toBe(2);
    screen.unmount();
    renderAgent(<PublishedSection />, { opts: { studio: STUDIO_FIXTURE.filter((i) => i.status !== "published") } });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(screen.queryByTestId("me-published")).toBeNull();
  });
});

// A deterministic guard, not a wall-clock one: this file's research/progress cards each run a
// real Animated.loop, and the onboarding reads (useAgentOnboarding, useOnboardingFacts) poll on a
// real refetchInterval while "working" — none of which any test here waits to finish. If a test
// leaves one running (a missed `unmount()`, or a component that doesn't clear its own loop or
// timer on unmount), that's a leaked Node handle, not just a slow suite — assert there are none
// left rather than inferring it from how long the process takes to exit.
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 50));
  const leaked = ((process as any)._getActiveHandles?.() ?? []).filter((h: any) => h?.constructor?.name !== "Socket");
  expect(leaked.map((h: any) => h?.constructor?.name)).toEqual([]);
});
