/**
 * auth-context.googleError.test — native Google finishes in an effect after the prompt returns, so the caller's onError
 * waits in a ref: it fires once for that sign-in and is then cleared, so a later Google response never reports to a
 * stale caller. Also: account-exists from Firebase is handed back as such (with the address), and signInFailureOf.
 * Google, Firebase and the network are stubbed: nothing reaches a provider.
 */
import React from "react";
import { act, render } from "@testing-library/react-native";

let googleResponse: unknown = null;
const promptAsync = jest.fn(async () => {});
jest.mock("expo-auth-session", () => ({ makeRedirectUri: () => "x", useAuthRequest: () => [null, null, jest.fn()] }));
jest.mock("expo-auth-session/providers/google", () => ({ useIdTokenAuthRequest: () => [null, googleResponse, promptAsync] }));
jest.mock("expo-apple-authentication", () => ({ isAvailableAsync: async () => false }));
jest.mock("expo-web-browser", () => ({ maybeCompleteAuthSession: () => {} }));
const signInWithGoogleCredential = jest.fn();
jest.mock("./firebase-client", () => ({ auth: {}, onAuthStateChanged: () => () => {}, signInWithGoogleCredential: (t: string) => signInWithGoogleCredential(t) }));
jest.mock("./query-client", () => ({ getApiUrl: () => "https://api.test" }));
jest.mock("./athlete-selection", () => ({ athleteHeader: () => ({}), loadSelectedAthlete: async () => {}, setSelectedAthlete: async () => {} }));
jest.mock("./flags", () => ({ AGENT_V3: true, IDENTITY_CLAIM: false }));
jest.mock("./logger", () => ({ logger: { error: () => {}, warn: () => {}, info: () => {} } }));

import { AuthProvider, useAuth } from "./auth-context";
import { signInFailureOf } from "./signInFailure";

let ctx: ReturnType<typeof useAuth> | null = null;
function Probe() { ctx = useAuth(); return null; }
const tree = () => <AuthProvider><Probe /></AuthProvider>;

it("onError fires once for the sign-in that set it, then is cleared", async () => {
  const onError = jest.fn();
  const view = render(tree());
  await act(async () => { await ctx!.signInWithGoogle({ onError }); });
  googleResponse = { type: "error", params: {} };
  await act(async () => { view.rerender(tree()); });
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledWith({ kind: "failed" });
  googleResponse = { type: "error", params: {} };   // a new response object, no new sign-in
  await act(async () => { view.rerender(tree()); });
  expect(onError).toHaveBeenCalledTimes(1);
});

it("Firebase's account-exists on the Google credential reaches onError with the address", async () => {
  googleResponse = null;
  signInWithGoogleCredential.mockRejectedValue(Object.assign(new Error("exists"), { code: "auth/account-exists-with-different-credential", customData: { email: "jordan.lee@school.edu" } }));
  const onError = jest.fn();
  const view = render(tree());
  await act(async () => { await ctx!.signInWithGoogle({ onError }); });
  googleResponse = { type: "success", params: { id_token: "idt" } };
  await act(async () => { view.rerender(tree()); });
  await act(async () => { await Promise.resolve(); });
  expect(onError).toHaveBeenCalledWith({ kind: "account_exists", email: "jordan.lee@school.edu" });
});

it("signInFailureOf: account-exists (with or without the address), anything else is a failure", () => {
  expect(signInFailureOf({ code: "auth/account-exists-with-different-credential", customData: { email: "a@b.co" } })).toEqual({ kind: "account_exists", email: "a@b.co" });
  expect(signInFailureOf({ code: "auth/account-exists-with-different-credential" })).toEqual({ kind: "account_exists", email: null });
  for (const e of [new Error("x"), { code: "auth/network-request-failed" }, null, undefined]) expect(signInFailureOf(e)).toEqual({ kind: "failed" });
});
