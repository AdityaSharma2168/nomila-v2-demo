/**
 * auth-context.accountDeleting.test — the global 410 account_deleting handling. GET /auth/me answering 410
 * account_deleting sets `accountDeleting` and never starts a sign-up (it is not "no athlete"); any shared request path
 * reporting it (lib/account-deleting) does the same; leaveDeletedAccount signs out and clears it; a phone that silenced
 * the signal (it deleted the account itself) is not told. Fetch and Firebase are stubbed.
 */
import React from "react";
import { act, render, waitFor } from "@testing-library/react-native";

let authCallback: ((u: unknown) => void) | null = null;
const user = { uid: "u1", displayName: "Pat Rowe", email: "pat@example.com", getIdToken: async () => "tok" };
const fbAuth: { currentUser: unknown } = { currentUser: user };
const signOutUser = jest.fn(async () => {});
jest.mock("expo-auth-session", () => ({ makeRedirectUri: () => "x", useAuthRequest: () => [null, null, jest.fn()] }));
jest.mock("expo-auth-session/providers/google", () => ({ useIdTokenAuthRequest: () => [null, null, jest.fn()] }));
jest.mock("expo-apple-authentication", () => ({ isAvailableAsync: async () => false }));
jest.mock("expo-web-browser", () => ({ maybeCompleteAuthSession: () => {} }));
jest.mock("./firebase-client", () => ({
  auth: fbAuth,
  onAuthStateChanged: (_a: unknown, cb: (u: unknown) => void) => { authCallback = cb; return () => {}; },
  firebaseSignOutUser: () => signOutUser(),
}));
jest.mock("./query-client", () => ({ getApiUrl: () => "https://api.test" }));
jest.mock("./athlete-selection", () => ({ athleteHeader: () => ({}), loadSelectedAthlete: async () => {}, setSelectedAthlete: async () => {} }));
jest.mock("./flags", () => ({ AGENT_V3: false, IDENTITY_CLAIM: false }));
jest.mock("./logger", () => ({ logger: { error: () => {}, warn: () => {}, info: () => {} } }));
jest.mock("./push", () => ({ unregisterPush: async () => {} }));

import { AuthProvider, useAuth } from "./auth-context";
import { isAccountDeletingResponse, reportAccountDeleting, silenceAccountDeleting } from "./account-deleting";

let ctx: ReturnType<typeof useAuth> | null = null;
function Probe() { ctx = useAuth(); return null; }
const athlete = { id: "a1", email: "pat@example.com", firstName: "Pat", lastName: "Rowe", role: "athlete", status: "raw" };
let calls: string[] = [];
const answerMe = (status: number) => {
  calls = [];
  (global as any).fetch = jest.fn(async (url: string) => {
    const path = new URL(url).pathname; calls.push(path);
    if (path === "/api/v1/auth/me") {
      const body = status === 200 ? athlete : status === 410 ? { error: "account_deleting" } : { error: "x" };
      return { ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) };
    }
    return { ok: true, status: 201, json: async () => ({}), text: async () => "{}" };
  });
};
beforeEach(() => { signOutUser.mockClear(); silenceAccountDeleting(false); });

it("reads only the server's 410 account_deleting answer", () => {
  expect(isAccountDeletingResponse(410, '{"error":"account_deleting"}')).toBe(true);
  expect(isAccountDeletingResponse(410, '{"error":"gone"}')).toBe(false);
  expect(isAccountDeletingResponse(401, '{"error":"account_deleting"}')).toBe(false);
  expect(isAccountDeletingResponse(410, "not json")).toBe(false);
});

it("a 410 from /auth/me is 'being deleted', never 'no athlete': no sign-up", async () => {
  answerMe(410);
  render(<AuthProvider><Probe /></AuthProvider>);
  await act(async () => { authCallback!(user); });
  await waitFor(() => expect(ctx!.accountDeleting).toBe(true));
  expect(ctx!.isLoading).toBe(false);
  expect(calls).not.toContain("/api/v1/auth/signup");
});

it("any request reporting it while signed in shows the state; leaveDeletedAccount signs out and clears it", async () => {
  answerMe(200);
  render(<AuthProvider><Probe /></AuthProvider>);
  await act(async () => { authCallback!(user); });
  await waitFor(() => expect(ctx!.athlete?.id).toBe("a1"));
  expect(ctx!.accountDeleting).toBe(false);
  act(() => reportAccountDeleting());
  expect(ctx!.accountDeleting).toBe(true);
  await act(async () => { await ctx!.leaveDeletedAccount(); });
  expect(signOutUser).toHaveBeenCalledTimes(1);
  expect(ctx!.accountDeleting).toBe(false);
});

it("silenced (this phone deleted the account itself), a 410 does not show the 'being deleted' screen", async () => {
  answerMe(200);
  render(<AuthProvider><Probe /></AuthProvider>);
  await act(async () => { authCallback!(user); });
  await waitFor(() => expect(ctx!.athlete?.id).toBe("a1"));
  silenceAccountDeleting(true);
  act(() => reportAccountDeleting());
  expect(ctx!.accountDeleting).toBe(false);
});
