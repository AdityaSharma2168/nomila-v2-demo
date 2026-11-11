/**
 * auth-context.profile503.test — a 503 (or any 5xx, or no network) from GET /auth/me is "try again", never "no athlete":
 * the app keeps loading and retries, never calls sign-up or opens the sport grid on it, and moves on with the real
 * answer once there is one. After PROFILE_RETRY.attempts tries it stops on `profileUnavailable` (Try again / Sign out:
 * ProfileUnavailableScreen) and retryProfile starts over. A 401 (no athlete) still goes to sign-up, with a fresh token.
 * Fetch and Firebase are stubbed.
 */
import React from "react";
import { act, render, waitFor } from "@testing-library/react-native";

let authCallback: ((u: unknown) => void) | null = null;
let tokenSeq = 0;
const user = { uid: "u1", displayName: "Pat Rowe", email: "pat@example.com", getIdToken: async () => `tok${++tokenSeq}` };
const fbAuth: { currentUser: unknown } = { currentUser: user };
jest.mock("expo-auth-session", () => ({ makeRedirectUri: () => "x", useAuthRequest: () => [null, null, jest.fn()] }));
jest.mock("expo-auth-session/providers/google", () => ({ useIdTokenAuthRequest: () => [null, null, jest.fn()] }));
jest.mock("expo-apple-authentication", () => ({ isAvailableAsync: async () => false }));
jest.mock("expo-web-browser", () => ({ maybeCompleteAuthSession: () => {} }));
jest.mock("./firebase-client", () => ({ auth: fbAuth, onAuthStateChanged: (_a: unknown, cb: (u: unknown) => void) => { authCallback = cb; return () => {}; } }));
jest.mock("./query-client", () => ({ getApiUrl: () => "https://api.test" }));
jest.mock("./athlete-selection", () => ({ athleteHeader: () => ({}), loadSelectedAthlete: async () => {}, setSelectedAthlete: async () => {} }));
jest.mock("./flags", () => ({ AGENT_V3: false, IDENTITY_CLAIM: false }));
jest.mock("./logger", () => ({ logger: { error: () => {}, warn: () => {}, info: () => {} } }));

import { AuthProvider, PROFILE_RETRY, useAuth } from "./auth-context";

let ctx: ReturnType<typeof useAuth> | null = null;
function Probe() { ctx = useAuth(); return null; }
const athlete = { id: "a1", email: "pat@example.com", firstName: "Pat", lastName: "Rowe", role: "athlete", status: "raw" };
let calls: string[] = [];
let auths: Record<string, string[]> = {};
const answer = (meStatuses: number[]) => {
  calls = []; auths = {};
  (global as any).fetch = jest.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    const path = new URL(url).pathname; calls.push(path);
    (auths[path] ??= []).push(init?.headers?.Authorization ?? "");
    if (path === "/api/v1/auth/me") {
      const st = meStatuses.length ? meStatuses.shift()! : 200;
      return { ok: st === 200, status: st, json: async () => (st === 200 ? athlete : { error: "x" }) };
    }
    return { ok: true, status: 201, json: async () => ({}) };
  });
};
beforeAll(() => { PROFILE_RETRY.firstMs = 1; PROFILE_RETRY.maxMs = 2; });

it("503 twice, then the profile: keeps loading, never signs up, then lands on the athlete", async () => {
  answer([503, 503, 200]);
  render(<AuthProvider><Probe /></AuthProvider>);
  await act(async () => { authCallback!(user); });
  await waitFor(() => expect(ctx!.athlete?.id).toBe("a1"));
  expect(calls.filter((c) => c === "/api/v1/auth/me")).toHaveLength(3);
  expect(calls).not.toContain("/api/v1/auth/signup");
  expect(ctx!.isLoading).toBe(false);
});

it("no network is the same as a 503", async () => {
  let n = 0;
  (global as any).fetch = jest.fn(async (url: string) => {
    if (n++ === 0) throw new Error("offline");
    return new URL(url).pathname === "/api/v1/auth/me" ? { ok: true, status: 200, json: async () => athlete } : { ok: true, status: 201, json: async () => ({}) };
  });
  render(<AuthProvider><Probe /></AuthProvider>);
  await act(async () => { authCallback!(user); });
  await waitFor(() => expect(ctx!.athlete?.id).toBe("a1"));
});

it("signed out while it waits: it stops retrying and never signs up", async () => {
  answer([503, 503, 503, 503]);
  render(<AuthProvider><Probe /></AuthProvider>);
  fbAuth.currentUser = null;
  await act(async () => { authCallback!(user); await new Promise((r) => setTimeout(r, 30)); });
  expect(calls).not.toContain("/api/v1/auth/signup");
  expect(calls.filter((c) => c === "/api/v1/auth/me")).toHaveLength(1);
  fbAuth.currentUser = user;
});

it("a 401 (no athlete) still goes to sign-up, as before", async () => {
  answer([401, 200]);
  render(<AuthProvider><Probe /></AuthProvider>);
  await act(async () => { authCallback!(user); });
  await waitFor(() => expect(calls).toContain("/api/v1/auth/signup"));
});

it("after PROFILE_RETRY.attempts unavailable answers it stops on profileUnavailable (no spinner, no sign-up); Try again starts over", async () => {
  expect(PROFILE_RETRY.attempts).toBe(6);
  answer([503, 503, 503, 503, 503, 503]);
  render(<AuthProvider><Probe /></AuthProvider>);
  await act(async () => { authCallback!(user); });
  await waitFor(() => expect(ctx!.profileUnavailable).toBe(true));
  expect(ctx!.isLoading).toBe(false);
  expect(calls.filter((c) => c === "/api/v1/auth/me")).toHaveLength(6);
  expect(calls).not.toContain("/api/v1/auth/signup");
  await act(async () => { ctx!.retryProfile(); });   // the server is back
  await waitFor(() => expect(ctx!.athlete?.id).toBe("a1"));
  expect(ctx!.profileUnavailable).toBe(false);
});

it("sign-up after the retries uses a fresh token, not the first one", async () => {
  answer([503, 401]);
  render(<AuthProvider><Probe /></AuthProvider>);
  await act(async () => { authCallback!(user); });
  await waitFor(() => expect(calls).toContain("/api/v1/auth/signup"));
  const firstMe = auths["/api/v1/auth/me"][0];
  expect(auths["/api/v1/auth/signup"][0]).not.toBe(firstMe);
  expect(auths["/api/v1/auth/signup"][0]).toMatch(/^Bearer tok\d+$/);
});
