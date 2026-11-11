/**
 * OnboardingFront.test — the agent onboarding front, screen by screen and as a flow, over the in-memory AgentApi (no
 * provider, no network):
 *   sign-in        the current tagline, "Get your agent" on the photo, tapping it (or anywhere on the hero) reveals
 *                  Google, Apple and Microsoft with their marks and "Continue with …" labels; tapping outside the
 *                  options (or ~8s with no choice) collapses back to the CTA; several photos rotate with dots; none
 *                  ⇒ the dark ground
 *   sport grid     the shared list's tiles; "Main" on the first pick, checks on the others, turning the main off
 *                  promotes the next; "Other" is an inline field; Continue sends the sports main first
 *   Is this you?   the full-bleed card over the claim prompt: That's me confirms, Not me moves on, then dismisses
 *   Mila's intro   a dark status bar; the head (her name once, "Your agent", the "i" opens the one sheet); the grid
 *                  (Your brand wide, six below, Soon tiles last), multi-select with the count on the button, and a
 *                  picked Soon tile's plain line
 *   what Mila has  photo-led cards; a tap anywhere opens the card; tick confirms; edit corrects in your words
 *   the flow       sports picked before sign-up start the onboarding (name + every sport), the intro's picks go out as
 *                  `capability` actions (reply:false), "What Mila already has" reads the facts, then the conversation;
 *                  with the front off the old first screen is unchanged
 */
import React from "react";
import { StatusBar } from "react-native";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { renderAgent } from "../../test/agentHarness";
import { SPORTS } from "../../../shared/sports";
import { ONBOARDING_INTERESTS } from "../../../shared/onboardingInterests";
import { SignInFront } from "./SignInFront";
import { SportGridScreen } from "./SportGridScreen";
import { IsThisYouFront } from "./IsThisYouFront";
import { MilaIntroScreen } from "./MilaIntroScreen";
import { WhatMilaHasScreen } from "./WhatMilaHasScreen";
import { FRONT_COPY, joinWords } from "./frontCopy";
import { AgentOnboardingFlow } from "../agent/AgentOnboardingFlow";
import type { ClaimPrompt } from "../../lib/auth-context";
import { interestActions, type OnboardingFact } from "../../lib/onboardingFront";

jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { Feather: () => null, MaterialCommunityIcons: ({ name }: { name: string }) => React.createElement(View, { testID: `mdi-${name}` }) };
});
jest.mock("react-native-svg", () => {
  const React = require("react");
  const { View } = require("react-native");
  const Svg = (p: Record<string, unknown>) => React.createElement(View, { testID: p.testID });
  const Stub = () => null;
  return { __esModule: true, default: Svg, G: Stub, Path: Stub, Rect: Stub, Circle: Stub };
});
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
// The atmosphere picker (a provider-backed route) never runs here: the cards draw the dark ground.
const pickAtmosphere = jest.fn((..._a: unknown[]) => ({}));
jest.mock("../../hooks/use-me-memory", () => ({ useAtmosphere: (...a: unknown[]) => pickAtmosphere(...a) }));
// Mila's avatar runs an endless idle animation that would keep Jest alive after the suite; a still stand-in here.
jest.mock("../../components/mila/MilaAvatar", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { MilaAvatar: () => React.createElement(View, { testID: "mila-avatar" }) };
});
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }), useIsFocused: () => true }));
const auth: { athlete: { id: string; firstName: string | null; lastName: string | null }; frontSports: string[] | null } = { athlete: { id: "ath-1", firstName: "Alex", lastName: "Test" }, frontSports: null };
jest.mock("../../lib/auth-context", () => ({ useAuth: () => auth }));

const tile = (label: string) => screen.getByTestId(`sport-${label}`);
const [S1, S2, S3] = SPORTS.map((s) => s.label);

describe("sign-in", () => {
  const providers = () => ({ onGoogle: jest.fn(), onApple: jest.fn(), onMicrosoft: jest.fn() });

  it("keeps the tagline; the CTA is on the photo and reveals Google, Apple and Microsoft with their marks and labels", () => {
    const { onGoogle, onApple, onMicrosoft } = providers();
    render(<SignInFront photos={[]} onGoogle={onGoogle} onApple={onApple} onMicrosoft={onMicrosoft} />);
    expect(screen.getByText(FRONT_COPY.signIn.line)).toBeTruthy();
    expect(screen.getByText(FRONT_COPY.signIn.sub)).toBeTruthy();
    expect(screen.getByText(FRONT_COPY.signIn.cta)).toBeTruthy();
    expect(screen.getByTestId("me-hero-blank")).toBeTruthy();      // no library photos: the neutral dark ground
    expect(screen.queryByTestId("signin-options")).toBeNull();
    fireEvent.press(screen.getByTestId("signin-cta"));
    expect(screen.getByTestId("signin-mark-google")).toBeTruthy();
    expect(screen.getByTestId("signin-mark-apple")).toBeTruthy();
    expect(screen.getByTestId("signin-mark-microsoft")).toBeTruthy();
    expect(screen.getByText("Continue with Google")).toBeTruthy();
    expect(screen.getByText("Continue with Apple")).toBeTruthy();
    expect(screen.getByText("Continue with Microsoft")).toBeTruthy();
    fireEvent.press(screen.getByTestId("signin-google"));
    fireEvent.press(screen.getByTestId("signin-apple"));
    fireEvent.press(screen.getByTestId("signin-microsoft"));
    expect(onGoogle).toHaveBeenCalledTimes(1);
    expect(onApple).toHaveBeenCalledTimes(1);
    expect(onMicrosoft).toHaveBeenCalledTimes(1);
  });

  it("Apple hides when the platform does not offer it (auth-context's appleSignInAvailable)", () => {
    const { onGoogle, onApple, onMicrosoft } = providers();
    render(<SignInFront photos={[]} onGoogle={onGoogle} onApple={onApple} onMicrosoft={onMicrosoft} appleAvailable={false} optionsOpen />);
    expect(screen.queryByTestId("signin-apple")).toBeNull();
    expect(screen.getByTestId("signin-google")).toBeTruthy();
    expect(screen.getByTestId("signin-microsoft")).toBeTruthy();
  });

  it("shows a plain notice line when given one (signups_closed), and none otherwise", () => {
    const { onGoogle, onApple, onMicrosoft } = providers();
    const { rerender } = render(<SignInFront photos={[]} onGoogle={onGoogle} onApple={onApple} onMicrosoft={onMicrosoft} />);
    expect(screen.queryByTestId("signin-notice")).toBeNull();
    rerender(<SignInFront photos={[]} onGoogle={onGoogle} onApple={onApple} onMicrosoft={onMicrosoft} notice="Sign-ups are closed for now" />);
    expect(screen.getByTestId("signin-notice")).toHaveTextContent("Sign-ups are closed for now");
  });

  it("tapping outside the options (the hero, not a button) collapses back to the CTA", () => {
    const { onGoogle, onApple, onMicrosoft } = providers();
    render(<SignInFront photos={[]} onGoogle={onGoogle} onApple={onApple} onMicrosoft={onMicrosoft} optionsOpen />);
    expect(screen.getByTestId("signin-options")).toBeTruthy();
    fireEvent.press(screen.getByTestId("signin-hero"));
    expect(screen.queryByTestId("signin-options")).toBeNull();
    expect(screen.getByTestId("signin-cta")).toBeTruthy();
  });

  it("~8s with no choice made collapses back to the CTA; a choice under way holds it open", () => {
    // doNotFake: React's own scheduler leans on setImmediate/queueMicrotask; faking those deadlocks render (see
    // MeAgentScreen.test.tsx's same guard).
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    const { onGoogle, onApple, onMicrosoft } = providers();
    const { rerender } = render(<SignInFront photos={[]} onGoogle={onGoogle} onApple={onApple} onMicrosoft={onMicrosoft} optionsOpen />);
    expect(screen.getByTestId("signin-options")).toBeTruthy();
    // Busy (a sign-in under way) holds the reveal open past the timeout.
    rerender(<SignInFront photos={[]} onGoogle={onGoogle} onApple={onApple} onMicrosoft={onMicrosoft} optionsOpen busy="google" />);
    act(() => { jest.advanceTimersByTime(8000); });
    expect(screen.getByTestId("signin-options")).toBeTruthy();
    // Nothing chosen: the timeout collapses it.
    rerender(<SignInFront photos={[]} onGoogle={onGoogle} onApple={onApple} onMicrosoft={onMicrosoft} optionsOpen />);
    act(() => { jest.advanceTimersByTime(8000); });
    expect(screen.queryByTestId("signin-options")).toBeNull();
    jest.useRealTimers();
  });

  it("the whole hero opens the options; several photos rotate with dots", async () => {
    const photos = [{ id: "a", url: "https://storage.example/a.webp" }, { id: "b", url: "https://storage.example/b.webp" }];
    const { onGoogle, onApple, onMicrosoft } = providers();
    const { unmount } = render(<SignInFront photos={photos} onGoogle={onGoogle} onApple={onApple} onMicrosoft={onMicrosoft} intervalMs={40} />);
    expect(screen.getByTestId("signin-dots").props.accessibilityLabel).toBe("Image 1 of 2");
    await waitFor(() => expect(screen.getByTestId("signin-dots").props.accessibilityLabel).toBe("Image 2 of 2"));
    fireEvent.press(screen.getByTestId("signin-hero"));
    expect(screen.getByTestId("signin-options")).toBeTruthy();
    unmount();
  });
});

describe("the sport grid", () => {
  it("draws the ONE shared list, including pickleball and skiing", () => {
    render(<SportGridScreen onContinue={jest.fn()} />);
    for (const s of SPORTS) expect(tile(s.label)).toBeTruthy();
    expect(tile("Pickleball")).toBeTruthy();
    expect(tile("Skiing")).toBeTruthy();
  });

  it("Main on the first pick, checks on the others; turning the main off promotes the next", () => {
    const onContinue = jest.fn();
    render(<SportGridScreen onContinue={onContinue} />);
    expect(screen.getByTestId("sport-continue").props.accessibilityState.disabled).toBe(true);
    fireEvent.press(tile(S2));
    fireEvent.press(tile(S1));
    fireEvent.press(tile(S3));
    expect(within(tile(S2)).getByTestId("sport-main-badge")).toBeTruthy();
    expect(within(tile(S1)).getByTestId(`sport-check-${S1}`)).toBeTruthy();
    expect(tile(S1).props.accessibilityState.checked).toBe(true);
    fireEvent.press(tile(S2));                                         // the main one off
    expect(tile(S2).props.accessibilityState.checked).toBe(false);
    expect(within(tile(S1)).getByTestId("sport-main-badge")).toBeTruthy();
    expect(screen.getByText(`${FRONT_COPY.sport.go} · 2`)).toBeTruthy();
    fireEvent.press(screen.getByTestId("sport-continue"));
    expect(onContinue).toHaveBeenCalledWith({ sports: [S1, S3], name: null });
  });

  it("every tile shows its sport's icon (the three drawn glyphs included) and reads main / selected", () => {
    render(<SportGridScreen onContinue={jest.fn()} initial={["Soccer", "Track and field"]} />);
    expect(within(tile("Soccer")).getByTestId("mdi-soccer")).toBeTruthy();
    expect(within(tile("Lacrosse")).getByTestId("sport-glyph-lacrosse")).toBeTruthy();
    expect(within(tile("Artistic swimming")).getByTestId("sport-glyph-artistic_swimming")).toBeTruthy();
    expect(within(tile("Pickleball")).getByTestId("sport-glyph-pickleball")).toBeTruthy();
    expect(tile("Soccer").props.accessibilityRole).toBe("button");
    expect(tile("Soccer").props.accessibilityLabel).toBe("Soccer, main sport, selected");
    expect(tile("Track and field").props.accessibilityLabel).toBe("Track and field, selected");
    expect(tile("Golf").props.accessibilityLabel).toBe("Golf");
  });

  it('"Other" searches: typing filters the tiles; no add while the words find a tile', () => {
    render(<SportGridScreen onContinue={jest.fn()} />);
    fireEvent.changeText(screen.getByTestId("sport-other-input"), "VOL");
    expect(tile("Volleyball")).toBeTruthy();
    expect(tile("Beach volleyball")).toBeTruthy();
    expect(screen.queryByTestId("sport-Soccer")).toBeNull();
    expect(screen.queryByTestId("sport-other-add")).toBeNull();
    fireEvent.press(tile("Beach volleyball"));
    fireEvent.changeText(screen.getByTestId("sport-other-input"), "");
    expect(within(tile("Beach volleyball")).getByTestId("sport-main-badge")).toBeTruthy();
    expect(tile("Soccer")).toBeTruthy();
  });

  it('words that match no tile offer "Add … as your sport"; added, it is a pick with a pill and the field clears', () => {
    const onContinue = jest.fn();
    render(<SportGridScreen onContinue={onContinue} />);
    fireEvent.press(tile(S1));
    fireEvent.changeText(screen.getByTestId("sport-other-input"), "Ultimate frisbee");
    expect(screen.getByText(FRONT_COPY.sport.add("Ultimate frisbee"))).toBeTruthy();
    fireEvent.press(screen.getByTestId("sport-other-add"));
    expect(screen.getByTestId("sport-other-input").props.value).toBe("");
    expect(screen.getByTestId("sport-picked-Ultimate frisbee")).toBeTruthy();
    expect(screen.getByText(`${FRONT_COPY.sport.go} · 2`)).toBeTruthy();
    fireEvent.press(screen.getByTestId("sport-continue"));
    expect(onContinue).toHaveBeenCalledWith({ sports: [S1, "Ultimate frisbee"], name: null });
    fireEvent.press(screen.getByTestId("sport-picked-Ultimate frisbee"));       // the pill's ✕ removes it
    expect(screen.queryByTestId("sport-picked-Ultimate frisbee")).toBeNull();
  });

  it('"Other" is an inline field; typed alone it is the main sport', () => {
    const onContinue = jest.fn();
    render(<SportGridScreen onContinue={onContinue} />);
    fireEvent.changeText(screen.getByTestId("sport-other-input"), "  My own sport ");
    expect(screen.getByTestId("sport-main-badge-other")).toBeTruthy();
    fireEvent.press(screen.getByTestId("sport-continue"));
    expect(onContinue).toHaveBeenCalledWith({ sports: ["My own sport"], name: null });
  });

  it("asks the name only when it is not known", () => {
    const onContinue = jest.fn();
    render(<SportGridScreen onContinue={onContinue} askName />);
    fireEvent.press(tile(S1));
    expect(screen.getByTestId("sport-continue").props.accessibilityState.disabled).toBe(true);
    fireEvent.changeText(screen.getByTestId("sport-name-input"), " Alex  Test ");
    fireEvent.press(screen.getByTestId("sport-continue"));
    expect(onContinue).toHaveBeenCalledWith({ sports: [S1], name: "Alex Test" });
  });
});

describe("Is this you?", () => {
  const cand = (n: number) => ({ athleteId: `a${n}`, fullName: `Candidate ${n}`, sport: "Sport A", teamOrSchool: "Team A", classYear: 2027, cityOrCountry: null, knownSocialHandles: null, claimability: "open" as const });
  const prompt: ClaimPrompt = { claimSessionId: "s1", tier: "candidate", claims: [{ claimId: "c1", athleteId: "a1", candidate: cand(1) }, { claimId: "c2", athleteId: "a2", candidate: cand(2) }] };

  it("That's me confirms the profile on screen", async () => {
    const onConfirm = jest.fn(async () => {}); const onDismiss = jest.fn(async () => {});
    render(<IsThisYouFront prompt={prompt} onConfirm={onConfirm} onDismiss={onDismiss} />);
    expect(screen.getByText("Candidate 1")).toBeTruthy();
    expect(screen.getByText("Sport A · Team A")).toBeTruthy();
    fireEvent.press(screen.getByTestId("claim-yes"));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("c1"));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("Not me moves to the next profile; after the last, nothing is chosen", async () => {
    const onConfirm = jest.fn(async () => {}); const onDismiss = jest.fn(async () => {});
    render(<IsThisYouFront prompt={prompt} onConfirm={onConfirm} onDismiss={onDismiss} />);
    fireEvent.press(screen.getByTestId("claim-no"));
    expect(screen.getByText("Candidate 2")).toBeTruthy();
    fireEvent.press(screen.getByTestId("claim-no"));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("Mila's intro", () => {
  const soonTiles = ONBOARDING_INTERESTS.filter((i) => i.soon);
  const liveTiles = ONBOARDING_INTERESTS.filter((i) => !i.soon);

  it("sets a dark status bar and shows her name once, as your agent", () => {
    render(<MilaIntroScreen onStart={jest.fn()} />);
    expect(screen.UNSAFE_getByType(StatusBar).props.barStyle).toBe("dark-content");
    expect(screen.getAllByText(FRONT_COPY.intro.name)).toHaveLength(1);
    expect(screen.getByText(FRONT_COPY.intro.role)).toBeTruthy();
    expect(screen.queryByText("I'm Mila.")).toBeNull();
  });

  it("the labelled \"i\" opens the one sheet with the approved copy", () => {
    render(<MilaIntroScreen onStart={jest.fn()} />);
    const info = screen.getByTestId("intro-more");
    expect(info.props.accessibilityLabel).toBe("How it works");
    expect(screen.queryByTestId("intro-sheet")).toBeNull();
    fireEvent.press(info);
    const sheet = screen.getByTestId("intro-sheet");
    expect(within(sheet).getByText("Mila, your agent, works 24/7 — while you train, compete and sleep.")).toBeTruthy();
    expect(within(sheet).getByText("Nothing goes out until you tap.")).toBeTruthy();
    fireEvent.press(screen.getByTestId("intro-sheet-close"));
    expect(screen.queryByTestId("intro-sheet")).toBeNull();
  });

  it("every tile, Soon tiles shown last; multi-select with the count on the button; picks keep their order", () => {
    const onStart = jest.fn();
    render(<MilaIntroScreen onStart={onStart} />);
    for (const i of ONBOARDING_INTERESTS) expect(screen.getByTestId(`interest-${i.key}`)).toBeTruthy();
    expect(FRONT_COPY.intro.interests.map((i) => i.key)).toEqual([...liveTiles, ...soonTiles].map((i) => i.key));
    expect(screen.getByTestId("intro-start").props.accessibilityLabel).toBe("Let's start");
    fireEvent.press(screen.getByTestId("interest-brand"));
    fireEvent.press(screen.getByTestId("interest-money"));
    expect(screen.getByTestId("interest-brand").props.accessibilityState.checked).toBe(true);
    expect(screen.getByTestId("interest-check-brand")).toBeTruthy();
    expect(screen.getByTestId("intro-start").props.accessibilityLabel).toBe("Let's start · 2 picked");
    fireEvent.press(screen.getByTestId("interest-money"));
    expect(screen.getByTestId("interest-money").props.accessibilityState.checked).toBe(false);
    expect(screen.getByTestId("intro-start").props.accessibilityLabel).toBe("Let's start · 1 picked");
    fireEvent.press(screen.getByTestId("interest-deals"));
    expect(screen.getByTestId("intro-start").props.accessibilityLabel).toBe("Let's start · 2 picked");
    fireEvent.press(screen.getByTestId("intro-start"));
    expect(onStart).toHaveBeenCalledWith(["brand", "deals"]);
  });

  it("a Soon tile carries the chip, stays pickable, and then says it will tell you", () => {
    const onStart = jest.fn();
    render(<MilaIntroScreen onStart={onStart} />);
    expect(soonTiles.length).toBeGreaterThan(0);
    const soon = soonTiles[0];
    expect(screen.getByTestId(`interest-soon-${soon.key}`)).toBeTruthy();
    expect(screen.queryByTestId("intro-soon-line")).toBeNull();
    fireEvent.press(screen.getByTestId(`interest-${soon.key}`));
    expect(screen.getByTestId(`interest-${soon.key}`).props.accessibilityState.checked).toBe(true);
    expect(within(screen.getByTestId("intro-soon-line")).getByText(`${soon.label} opens soon. We'll tell you when it's ready.`)).toBeTruthy();
    expect(screen.getByTestId("intro-start").props.accessibilityLabel).toBe("Let's start · 1 picked");
    fireEvent.press(screen.getByTestId("intro-start"));
    expect(onStart).toHaveBeenCalledWith([soon.key]);
  });

  it("Money shown before Picks, yet picks are saved in the stored order", () => {
    const onStart = jest.fn();
    render(<MilaIntroScreen onStart={onStart} />);
    const shown = FRONT_COPY.intro.interests.map((i) => i.key);
    expect(shown.indexOf("money")).toBeLessThan(shown.indexOf("picks"));
    fireEvent.press(screen.getByTestId("interest-money"));
    fireEvent.press(screen.getByTestId("interest-picks"));
    fireEvent.press(screen.getByTestId("intro-start"));
    expect(onStart).toHaveBeenCalledWith(["money", "picks"]);
    expect(interestActions(onStart.mock.calls[0][0])).toEqual([{ type: "capability", capabilityId: "shop" }, { type: "capability", capabilityId: "money" }]);
  });

  it("joins several Soon labels in plain words", () => {
    expect(joinWords(["A"])).toBe("A");
    expect(joinWords(["A", "B"])).toBe("A and B");
    expect(joinWords(["A", "B", "C"])).toBe("A, B and C");
    expect(FRONT_COPY.intro.soonLine(["A", "B", "C"])).toBe("A, B and C open soon. We'll tell you when it's ready.");
  });

  it("never says AI", () => {
    const words = JSON.stringify(FRONT_COPY);
    expect(/\bAI\b/.test(words)).toBe(false);
  });
});

describe("what Mila already has", () => {
  const facts: OnboardingFact[] = [
    { id: "f1", claim: "Won a title in 2026.", type: "found", status: "active", date: "2026-05-01", topic: "achievement", sources: [{ label: "Source A", url: "https://source-a.example/x" }] },
    { id: "f2", claim: "Plays for Team A.", type: "found", status: "active", date: "2026-01-01", topic: "team", sources: [{ label: "Source B" }] },
  ];

  it("sets a dark status bar over the cream", () => {
    render(<WhatMilaHasScreen facts={facts} onConfirm={jest.fn(async () => {})} onCorrect={jest.fn(async () => {})} onContinue={jest.fn()} />);
    expect(screen.UNSAFE_getByType(StatusBar).props.barStyle).toBe("dark-content");
  });

  it("a tap anywhere on a card opens it; tick confirms; edit corrects in your words", async () => {
    const onConfirm = jest.fn(async () => {}); const onCorrect = jest.fn(async () => {}); const onContinue = jest.fn();
    render(<WhatMilaHasScreen facts={facts} onConfirm={onConfirm} onCorrect={onCorrect} onContinue={onContinue} working />);
    expect(screen.getByTestId("has-looking")).toBeTruthy();
    expect(screen.getByText("Results")).toBeTruthy();
    fireEvent.press(screen.getByTestId("has-card-f1"));
    expect(within(screen.getByTestId("has-sheet")).getByText("Won a title in 2026.")).toBeTruthy();
    fireEvent.press(screen.getByTestId("has-sheet-right"));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("f1"));
    await waitFor(() => expect(screen.queryByTestId("has-sheet")).toBeNull());
    expect(screen.getByTestId("has-answered-f1")).toBeTruthy();
    fireEvent.press(screen.getByTestId("has-edit-f2"));
    fireEvent.changeText(screen.getByTestId("has-edit-input"), "Plays for Team B.");
    fireEvent.press(screen.getByTestId("has-save"));
    await waitFor(() => expect(onCorrect).toHaveBeenCalledWith("f2", "Plays for Team B."));
    fireEvent.press(screen.getByTestId("has-continue"));
    expect(onContinue).toHaveBeenCalled();
  });
});

describe("the flow", () => {
  beforeEach(async () => {
    const AsyncStorage = require("@react-native-async-storage/async-storage/jest/async-storage-mock");
    await AsyncStorage.clear();
  });

  it("sports picked before sign-up start the onboarding; intro picks are capability actions; then what Mila has; then the conversation", async () => {
    auth.frontSports = [S2, S1];
    const { api } = renderAgent(<AgentOnboardingFlow onDone={jest.fn()} front />, { opts: { researchStepMs: 0 } });
    await waitFor(() => expect(screen.getByTestId("mila-intro")).toBeTruthy());
    expect(api.startOnboarding).toHaveBeenCalledWith({ name: "Alex Test", sport: S2, sports: [S2, S1] });
    fireEvent.press(screen.getByTestId("interest-brand"));
    fireEvent.press(screen.getByTestId("interest-page"));
    fireEvent.press(screen.getByTestId("intro-start"));
    await waitFor(() => expect(screen.getByTestId("mila-has")).toBeTruthy());
    expect(api.turn).toHaveBeenCalledWith({ actions: [{ type: "capability", capabilityId: "brand" }, { type: "capability", capabilityId: "public_card" }], reply: false });
    await waitFor(() => expect(api.listFacts).toHaveBeenCalled());
    // The cards' photos are asked of the atmosphere picker, one slot per card (never the athlete's own photo).
    await waitFor(() => expect(pickAtmosphere.mock.calls.some(([s, slots]) => s === "onboarding_has" && Array.isArray(slots) && slots.length > 0)).toBe(true));
    fireEvent.press(screen.getByTestId("has-continue"));
    await waitFor(() => expect(screen.getByTestId("onboarding-conversation")).toBeTruthy());
    auth.frontSports = null;
  });

  it("without sports from sign-up, the grid is the first screen", async () => {
    const { api } = renderAgent(<AgentOnboardingFlow onDone={jest.fn()} front />);
    await waitFor(() => expect(screen.getByTestId("sport-grid")).toBeTruthy());
    fireEvent.press(tile(S3));
    fireEvent.press(screen.getByTestId("sport-continue"));
    await waitFor(() => expect(api.startOnboarding).toHaveBeenCalledWith({ name: "Alex Test", sport: S3, sports: [S3] }));
    await waitFor(() => expect(screen.getByTestId("mila-intro")).toBeTruthy());
  });

  it("with the front off, the old first screen is unchanged", async () => {
    renderAgent(<AgentOnboardingFlow onDone={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId("onboarding-name")).toBeTruthy());
    expect(screen.queryByTestId("sport-grid")).toBeNull();
  });
});
