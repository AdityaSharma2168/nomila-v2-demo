/**
 * SignInEmail.test — sign in with a 6-digit email code on the agent front (design "Sign in with email", 12 Oct 2026),
 * with the two server calls injected (no network, no provider):
 *   the link     "Use email instead" under the providers only when the server offers it
 *   email step   the design's copy; a bad address is caught before any call; Send code → the code step; every error
 *                state (invalid · couldn't send · too many) as the one white error line
 *   code step    one real field (number pad, one-time-code autofill) under six cells, sent by itself at the 6th digit;
 *                wrong (tries left, cells cleared) · expired · locked (dimmed, "Send a new code"); resend after the
 *                countdown; "Use a different email" and "Other ways to sign in" go back
 *   the gate     a Google / Apple / Microsoft failure is the same error line (no system alert); the name typed on the
 *                sport grid reaches completeSignup when the sign-in brought none
 */
import React from "react";
import { AccessibilityInfo, StyleSheet } from "react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SignInFront, type EmailStepInitial } from "./SignInFront";
import { FRONT_COPY } from "./frontCopy";
import { Bold } from "../../constants/theme";
import { filterSports } from "../../lib/onboardingFront";
import type { StartOutcome } from "../../lib/emailCodeSignIn";
import type { EmailVerifyResult, SignInFailure } from "../../lib/auth-context";

jest.mock("@expo/vector-icons", () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));  // the sport grid draws MDI glyphs
jest.mock("expo-linear-gradient", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { LinearGradient: (p: Record<string, unknown>) => React.createElement(View, p) };
});
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }), useIsFocused: () => true }));
jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
const hapticCalls: string[] = [];
jest.mock("../../lib/haptics", () => {
  const fns = Object.fromEntries(["tap", "press", "select", "success", "warning", "error"].map((k) => [k, () => { hapticCalls.push(k); }]));
  return { ...fns, haptics: fns };
});
const auth: Record<string, any> = {};
jest.mock("../../lib/auth-context", () => ({ useAuth: () => auth }));
jest.mock("../../lib/flags", () => ({ IDENTITY_CLAIM: false }));

const E = FRONT_COPY.email; const K = FRONT_COPY.code; const ERR = FRONT_COPY.err;
const noop = () => {};

function draw(over: { start?: jest.Mock; verify?: jest.Mock; initial?: EmailStepInitial; emailSignIn?: boolean; providerError?: SignInFailure; appleAvailable?: boolean } = {}) {
  const start = over.start ?? jest.fn(async (): Promise<StartOutcome> => ({ kind: "sent", resendAfterSec: 60 }));
  const verify = over.verify ?? jest.fn(async (): Promise<EmailVerifyResult> => ({ kind: "ok" }));
  render(
    <SignInFront
      photos={[]} onGoogle={noop} onApple={noop} onMicrosoft={noop} optionsOpen intervalMs={0} revealMs={0}
      appleAvailable={over.appleAvailable ?? true}
      emailSignIn={over.emailSignIn ?? true} onEmailStart={start} onEmailVerify={verify}
      providerError={over.providerError} initialEmailStep={over.initial ?? null}
    />,
  );
  return { start, verify };
}
const errorLine = (id: string) => screen.getByTestId(id);
const typeCode = (code: string) => fireEvent.changeText(screen.getByTestId("signin-code-input"), code);

const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => {});
beforeEach(() => { hapticCalls.length = 0; announce.mockClear(); });

describe("the link", () => {
  it("shows \"Use email instead\" under the providers only when the server offers it", () => {
    draw();
    expect(screen.getByTestId("signin-use-email")).toBeTruthy();
    expect(screen.getByText(FRONT_COPY.signIn.useEmail)).toBeTruthy();
    screen.unmount();
    draw({ emailSignIn: false });
    expect(screen.queryByTestId("signin-use-email")).toBeNull();
  });
});

describe("email step", () => {
  it("draws the design's copy; a bad address is caught before any call; Send code opens the code step", async () => {
    const { start } = draw();
    fireEvent.press(screen.getByTestId("signin-use-email"));
    for (const t of [E.eyebrow, E.title, E.sub, E.label, E.send, E.back]) expect(screen.getByText(t)).toBeTruthy();
    const input = screen.getByTestId("signin-email-input");
    expect(input.props).toMatchObject({ keyboardType: "email-address", autoComplete: "email", autoCapitalize: "none", placeholder: E.placeholder });

    fireEvent.changeText(input, "jordan.lee@gmail");
    fireEvent.press(screen.getByTestId("signin-email-send"));
    expect(errorLine("signin-email-error")).toBeTruthy();
    expect(screen.getByText(ERR.invalid)).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
    expect(hapticCalls).toContain("error");

    fireEvent.changeText(input, "jordan.lee@gmail.com");
    expect(screen.queryByTestId("signin-email-error")).toBeNull();   // typing clears the line
    await act(async () => { fireEvent.press(screen.getByTestId("signin-email-send")); });
    expect(start).toHaveBeenCalledWith("jordan.lee@gmail.com");
    expect(screen.getByTestId("signin-code-step")).toBeTruthy();
    for (const t of [K.eyebrow, K.title, K.spam, K.change]) expect(screen.getByText(t)).toBeTruthy();
    expect(screen.getByText("jordan.lee@gmail.com")).toBeTruthy();
    expect(screen.getByTestId("signin-code-wait").props.children).toBe(K.resendIn("1:00"));
  });

  it("the service is busy ⇒ its own plain line, not \"check your connection\" (email step and resend)", async () => {
    draw({ start: jest.fn(async (): Promise<StartOutcome> => ({ kind: "busy" })), initial: { step: "email", email: "jordan.lee@gmail.com" } });
    await act(async () => { fireEvent.press(screen.getByTestId("signin-email-send")); });
    expect(screen.getByText("Lots of sign-ins right now. Try again in a few minutes.")).toBeTruthy();
    expect(screen.queryByText(ERR.sendFailed)).toBeNull();
    screen.unmount();
    draw({ start: jest.fn(async (): Promise<StartOutcome> => ({ kind: "busy" })), initial: { step: "code", email: "a@b.co", resendInSec: 0 } });
    await act(async () => { fireEvent.press(screen.getByTestId("signin-code-resend")); });
    expect(screen.getByText(ERR.busy)).toBeTruthy();
  });

  it("couldn't send ⇒ the send-failed line, and still on the email step", async () => {
    draw({ start: jest.fn(async (): Promise<StartOutcome> => ({ kind: "failed" })), initial: { step: "email", email: "jordan.lee@gmail.com" } });
    await act(async () => { fireEvent.press(screen.getByTestId("signin-email-send")); });
    expect(screen.getByText(ERR.sendFailed)).toBeTruthy();
    expect(screen.getByTestId("signin-email-step")).toBeTruthy();
  });

  it("too many codes ⇒ the wait in minutes, Apple named only where it is offered, and Send code off until the address changes", async () => {
    draw({ start: jest.fn(async (): Promise<StartOutcome> => ({ kind: "too_many", retryAfterSec: 900 })), initial: { step: "email", email: "jordan.lee@gmail.com" } });
    await act(async () => { fireEvent.press(screen.getByTestId("signin-email-send")); });
    expect(screen.getByText("Too many codes for this email. Try again in 15 minutes, or use Google or Apple.")).toBeTruthy();
    expect(screen.getByTestId("signin-email-send").props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.changeText(screen.getByTestId("signin-email-input"), "other@gmail.com");
    expect(screen.getByTestId("signin-email-send").props.accessibilityState).toMatchObject({ disabled: false });
    screen.unmount();
    draw({ appleAvailable: false, initial: { step: "email", email: "a@b.co", emailError: { kind: "tooMany", minutes: 1 } } });
    expect(screen.getByText("Too many codes for this email. Try again in 1 minute, or use Google.")).toBeTruthy();
    screen.unmount();
    // a locked-out address waits up to a day: said in hours
    draw({ initial: { step: "email", email: "a@b.co", emailError: { kind: "tooMany", minutes: 1440 } } });
    expect(screen.getByText("Too many codes for this email. Try again in 24 hours, or use Google or Apple.")).toBeTruthy();
  });

  it("a code sent under a minute ago ⇒ straight to the code step on the countdown (that code still works)", async () => {
    draw({ start: jest.fn(async (): Promise<StartOutcome> => ({ kind: "too_soon", retryAfterSec: 42 })), initial: { step: "email", email: "a@b.co" } });
    await act(async () => { fireEvent.press(screen.getByTestId("signin-email-send")); });
    expect(screen.getByTestId("signin-code-wait").props.children).toBe(K.resendIn("0:42"));
  });

  it("\"Other ways to sign in\" goes back to the providers", () => {
    draw({ initial: { step: "email", email: "a@b.co" } });
    fireEvent.press(screen.getByTestId("signin-email-back"));
    expect(screen.getByTestId("signin-options")).toBeTruthy();
    expect(screen.getByText(FRONT_COPY.signIn.line)).toBeTruthy();
  });
});

describe("code step", () => {
  const at = (extra: Partial<EmailStepInitial> = {}): EmailStepInitial => ({ step: "code", email: "jordan.lee@gmail.com", resendInSec: 42, ...extra });

  it("one real field with one-time-code autofill and the number pad; sent by itself at the sixth digit", async () => {
    const { verify } = draw({ initial: at() });
    const input = screen.getByTestId("signin-code-input");
    expect(input.props).toMatchObject({ textContentType: "oneTimeCode", keyboardType: "number-pad", maxLength: 6 });
    expect(input.props.autoComplete).toBe("one-time-code");
    typeCode("4829");
    expect(verify).not.toHaveBeenCalled();
    const cell = (n: number) => StyleSheet.flatten(screen.getByTestId(`signin-code-cell-${n}`, { includeHiddenElements: true }).props.style);
    expect(screen.getAllByText("9", { includeHiddenElements: true })).toHaveLength(1);   // the 4th cell holds the 4th digit
    expect(cell(4).borderColor).toBe(Bold.ink);                                             // the 5th is the one being typed
    expect(cell(3).borderColor).toBe(Bold.paper);
    await act(async () => { typeCode("482 913"); });   // a pasted code with a space
    expect(verify).toHaveBeenCalledWith("jordan.lee@gmail.com", "482913");
    expect(hapticCalls).toContain("success");
  });

  it("wrong ⇒ tries left, the cells cleared, still alive", async () => {
    draw({ initial: at(), verify: jest.fn(async (): Promise<EmailVerifyResult> => ({ kind: "wrong", triesLeft: 2 })) });
    await act(async () => { typeCode("111111"); });
    expect(screen.getByText(ERR.wrong(2))).toBeTruthy();
    expect(screen.getByText("That code isn’t right. 2 tries left.")).toBeTruthy();
    expect(screen.getByTestId("signin-code-input").props.value).toBe("");
    expect(screen.getByTestId("signin-code-wait")).toBeTruthy();
    expect(hapticCalls).toContain("error");
  });

  it.each([["expired", ERR.expired], ["locked", ERR.locked]] as const)("%s ⇒ the cells dim and \"Send a new code\" asks again", async (kind, line) => {
    const { start } = draw({ initial: at(), verify: jest.fn(async (): Promise<EmailVerifyResult> => ({ kind })) });
    await act(async () => { typeCode("482913"); });
    expect(screen.getByText(line)).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId("signin-code-cell-0", { includeHiddenElements: true }).props.style).opacity).toBe(0.4);
    expect(screen.getByTestId("signin-code-input").props.editable).toBe(false);
    expect(screen.queryByText(K.spam)).toBeNull();
    await act(async () => { fireEvent.press(screen.getByTestId("signin-code-new")); });
    expect(start).toHaveBeenCalledWith("jordan.lee@gmail.com");
    expect(screen.queryByTestId("signin-code-error")).toBeNull();
    expect(screen.getByTestId("signin-code-input").props.editable).toBe(true);
  });

  it("a double submit (autofill and the last keystroke together) checks the code once", async () => {
    let release: (v: EmailVerifyResult) => void = () => {};
    const verify = jest.fn(() => new Promise<EmailVerifyResult>((r) => { release = r; }));
    draw({ initial: at(), verify });
    await act(async () => { typeCode("482913"); typeCode("482913"); });
    expect(verify).toHaveBeenCalledTimes(1);
    await act(async () => { release({ kind: "wrong", triesLeft: 4 }); });
    await act(async () => { typeCode("482914"); });
    expect(verify).toHaveBeenCalledTimes(2);   // free again once the first check answered
  });

  it("the error line is announced to the screen reader when it appears", async () => {
    draw({ initial: at(), verify: jest.fn(async (): Promise<EmailVerifyResult> => ({ kind: "wrong", triesLeft: 3 })) });
    await act(async () => { typeCode("111111"); });
    expect(announce).toHaveBeenCalledWith(ERR.wrong(3));
  });

  it("a check that did not go through ⇒ the generic line, the code cleared to try again", async () => {
    draw({ initial: at(), verify: jest.fn(async (): Promise<EmailVerifyResult> => ({ kind: "failed" })) });
    await act(async () => { typeCode("482913"); });
    expect(screen.getByText(ERR.signInFailed)).toBeTruthy();
    expect(screen.getByTestId("signin-code-input").props.value).toBe("");
  });

  it("after the countdown, \"Resend code\" sends again; a resend that fails says so on the code step", async () => {
    const start = jest.fn(async (): Promise<StartOutcome> => ({ kind: "failed" }));
    draw({ start, initial: at({ resendInSec: 0 }) });
    await act(async () => { fireEvent.press(screen.getByTestId("signin-code-resend")); });
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.getByText(ERR.sendFailed)).toBeTruthy();
  });

  it("\"Use a different email\" goes back to the email step with the address kept", () => {
    draw({ initial: at() });
    fireEvent.press(screen.getByTestId("signin-code-change"));
    expect(screen.getByTestId("signin-email-input").props.value).toBe("jordan.lee@gmail.com");
  });

  it("the error line is white with no red anywhere", () => {
    draw({ initial: at({ codeError: { kind: "wrong", triesLeft: 2 } }) });
    const text = screen.getByText(ERR.wrong(2));
    expect(StyleSheet.flatten(text.props.style).color).toBe(Bold.onDark);
    expect(errorLine("signin-code-error").props.accessibilityRole).toBe("alert");
  });
});

describe("the gate", () => {
  // Imported here so the auth mock above is in place.
  const { OnboardingFrontGate } = require("./OnboardingFrontGate") as typeof import("./OnboardingFrontGate");
  const front = { agentOnboarding: true, signinPhotos: [], emailSignIn: true };
  const base = () => Object.assign(auth, {
    claimPrompt: null, profileChoice: null, awaitingSports: false, signupNeedsName: false, appleSignInAvailable: true,
    confirmClaim: jest.fn(), dismissClaims: jest.fn(), chooseProfile: jest.fn(), completeSignup: jest.fn(async () => {}),
    signInWithGoogle: jest.fn(async () => {}), signInWithApple: jest.fn(async () => {}), signInWithMicrosoft: jest.fn(async () => {}),
    startEmailCode: jest.fn(async () => ({ kind: "sent", resendAfterSec: 60 })), verifyEmailCode: jest.fn(async () => ({ kind: "ok" })),
  });
  beforeEach(base);

  it("a Google sign-in that failed is the front's error line (handed back, never a system alert)", async () => {
    auth.signInWithGoogle = jest.fn(async (opts?: { onError?: (f: SignInFailure) => void }) => { opts?.onError?.({ kind: "failed" }); });
    render(<OnboardingFrontGate front={front} />);
    fireEvent.press(screen.getByTestId("signin-cta"));
    await act(async () => { fireEvent.press(screen.getByTestId("signin-google")); });
    expect(auth.signInWithGoogle).toHaveBeenCalledWith({ onError: expect.any(Function) });
    expect(screen.getByText(ERR.signInFailed)).toBeTruthy();
    expect(hapticCalls).toContain("error");
  });

  it("a Microsoft sign-in that threw shows the same line, and the next try clears it", async () => {
    auth.signInWithMicrosoft = jest.fn(async () => { throw new Error("network"); });
    render(<OnboardingFrontGate front={front} />);
    fireEvent.press(screen.getByTestId("signin-cta"));
    await act(async () => { fireEvent.press(screen.getByTestId("signin-microsoft")); });
    await waitFor(() => expect(screen.getByTestId("signin-error")).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByTestId("signin-apple")); });
    expect(screen.queryByTestId("signin-error")).toBeNull();
  });

  it("the email link follows the server's answer and runs on auth-context's calls", async () => {
    render(<OnboardingFrontGate front={front} />);
    fireEvent.press(screen.getByTestId("signin-cta"));
    fireEvent.press(screen.getByTestId("signin-use-email"));
    fireEvent.changeText(screen.getByTestId("signin-email-input"), "a@b.co");
    await act(async () => { fireEvent.press(screen.getByTestId("signin-email-send")); });
    expect(auth.startEmailCode).toHaveBeenCalledWith("a@b.co");
    await act(async () => { typeCode("123456"); });
    expect(auth.verifyEmailCode).toHaveBeenCalledWith("a@b.co", "123456");
    screen.unmount();
    render(<OnboardingFrontGate front={{ ...front, emailSignIn: false }} />);
    fireEvent.press(screen.getByTestId("signin-cta"));
    expect(screen.queryByTestId("signin-use-email")).toBeNull();
  });

  it("Google refused because the address already has an account ⇒ a plain line and \"Send me a code\" for that address", async () => {
    auth.signInWithGoogle = jest.fn(async (opts?: { onError?: (f: SignInFailure) => void }) => { opts?.onError?.({ kind: "account_exists", email: "jordan.lee@school.edu" }); });
    render(<OnboardingFrontGate front={front} />);
    fireEvent.press(screen.getByTestId("signin-cta"));
    await act(async () => { fireEvent.press(screen.getByTestId("signin-google")); });
    expect(screen.getByText(ERR.accountExists(true))).toBeTruthy();
    expect(screen.queryByTestId("signin-use-email")).toBeNull();   // the button below replaces the link
    fireEvent.press(screen.getByTestId("signin-account-exists-code"));
    expect(screen.getByTestId("signin-email-input").props.value).toBe("jordan.lee@school.edu");
  });

  it("an Apple sign-in that THREW account-exists is read the same way; without the email code it says to sign in as before", async () => {
    auth.signInWithApple = jest.fn(async () => { throw Object.assign(new Error("exists"), { code: "auth/account-exists-with-different-credential", customData: { email: "a@b.co" } }); });
    render(<OnboardingFrontGate front={{ ...front, emailSignIn: false }} />);
    fireEvent.press(screen.getByTestId("signin-cta"));
    await act(async () => { fireEvent.press(screen.getByTestId("signin-apple")); });
    await waitFor(() => expect(screen.getByText(ERR.accountExists(false))).toBeTruthy());
    expect(screen.queryByTestId("signin-account-exists-code")).toBeNull();
  });

  it("the sport grid asks the name when the sign-in brought none, and the name reaches completeSignup", async () => {
    Object.assign(auth, { awaitingSports: true, signupNeedsName: true });
    render(<OnboardingFrontGate front={front} />);
    expect(screen.getByTestId("sport-name-input").props.maxLength).toBe(80);
    fireEvent.changeText(screen.getByTestId("sport-name-input"), "  Jordan   Lee ");
    fireEvent.press(screen.getByTestId(`sport-${filterSports("")[0]}`));  // the grid's tiles are buttons (the one look's sport grid)
    await act(async () => { fireEvent.press(screen.getByTestId("sport-continue")); });
    expect(auth.completeSignup).toHaveBeenCalledWith([expect.any(String)], "Jordan Lee");
  });

  it("with a name from the provider, the grid does not ask and sends none", async () => {
    Object.assign(auth, { awaitingSports: true, signupNeedsName: false });
    render(<OnboardingFrontGate front={front} />);
    expect(screen.queryByTestId("sport-name-input")).toBeNull();
    fireEvent.press(screen.getByTestId(`sport-${filterSports("")[0]}`));  // the grid's tiles are buttons (the one look's sport grid)
    await act(async () => { fireEvent.press(screen.getByTestId("sport-continue")); });
    expect(auth.completeSignup).toHaveBeenCalledWith([expect.any(String)], null);
  });
});
