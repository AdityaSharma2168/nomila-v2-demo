/**
 * auth-context.signupName.test — the name the agent front's sport grid asked for reaches POST /auth/signup (it used to be
 * dropped, so an email-only athlete was named after the part of the address before the @). Without one, the provider's
 * display name, then the address, as before. Fetch and Firebase are stubbed: nothing reaches a server or a provider.
 */
jest.mock("expo-auth-session", () => ({ makeRedirectUri: () => "x", useAuthRequest: () => [null, null, jest.fn()] }));
jest.mock("expo-auth-session/providers/google", () => ({ useIdTokenAuthRequest: () => [null, null, jest.fn()] }));
jest.mock("expo-apple-authentication", () => ({ isAvailableAsync: async () => false }));
jest.mock("expo-web-browser", () => ({ maybeCompleteAuthSession: () => {} }));
jest.mock("./firebase-client", () => ({ auth: {}, onAuthStateChanged: () => () => {} }));
jest.mock("./query-client", () => ({ getApiUrl: () => "https://api.test" }));
jest.mock("./athlete-selection", () => ({ athleteHeader: () => ({}), loadSelectedAthlete: async () => {}, setSelectedAthlete: async () => {} }));
jest.mock("./flags", () => ({ AGENT_V3: true, IDENTITY_CLAIM: false }));

import { createAthleteRow } from "./auth-context";

const user = (displayName: string | null, email: string | null) => ({ displayName, email, getIdToken: async () => "fresh" }) as any;
let bodies: any[] = [];
beforeEach(() => {
  bodies = [];
  (global as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/v1/auth/signup")) { bodies.push(JSON.parse(String(init?.body))); return { ok: true, status: 201, json: async () => ({}) }; }
    return { ok: true, status: 200, json: async () => ({ id: "a1" }) };
  });
});

it("sends the name typed on the sport grid, tidied", async () => {
  await createAthleteRow(user(null, "jordan.lee@example.com"), "tok", null, { sport: "Tennis", name: "  Jordan   Lee " });
  expect(bodies[0]).toEqual({ name: "Jordan Lee", role: "athlete", sport: "Tennis", front: "agent" });
});

it("without a typed name: the provider's display name, then the address, then \"Athlete\"", async () => {
  await createAthleteRow(user("Pat Rowe", "pat@example.com"), "tok", null, { sport: "Golf", name: null });
  await createAthleteRow(user(null, "jordan.lee@example.com"), "tok", null, { sport: "Golf" });
  await createAthleteRow(user("", null), "tok");
  expect(bodies.map((b) => b.name)).toEqual(["Pat Rowe", "jordan.lee", "Athlete"]);
});
