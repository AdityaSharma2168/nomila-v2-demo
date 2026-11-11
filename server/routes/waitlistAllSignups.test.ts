/**
 * waitlistAllSignups.test.ts — WAITLIST_ALL_SIGNUPS (production, owner 24 Oct 2026). With it exactly "true", EVERY new
 * account is created 'waitlisted', from every door: /auth/signup (legacy and index create branches), /auth/microsoft
 * (legacy and index create branches) and /waitlist. Off ⇒ today's 'raw'. Existing accounts are untouched: an admin-
 * promoted ('active') athlete signs in on /auth/signup and /auth/microsoft and stays 'active' (how app reviewers get in).
 * Microsoft's token + Graph endpoints are stubbed; no test reaches a provider.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
const verifyIdToken = jest.fn();
jest.mock("../lib/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireFirebaseUser: (_req: any, _res: any, next: any) => next(),
  verifyIdTokenChecked: (t: string) => verifyIdToken(t),
  tokenFailure: () => ({ status: 401, body: { error: "Invalid or expired token" } }),
  firebaseAuth: { verifyIdToken: (t: string) => verifyIdToken(t), setCustomUserClaims: jest.fn().mockResolvedValue(undefined), createCustomToken: jest.fn().mockResolvedValue("custom") },
}));
jest.mock("../workflow/runner", () => ({ startRun: jest.fn().mockResolvedValue({ runId: "r" }) }));
jest.mock("../services/intelligence/research/lifecycle", () => ({ startLifecycleResearch: jest.fn().mockResolvedValue({}), reenterIdentityResolution: jest.fn().mockResolvedValue({}) }));
jest.setTimeout(180_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { client, db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { athletes } from "../../shared/schema";
import authRouter, { newAccountStatus } from "./auth";
import waitlistRouter from "./waitlist";
import { waitlistAllSignupsEnabled } from "../lib/joinWaitlist";

let server: Server; let base: string; const env = process.env;
const realFetch = global.fetch;
let msProfile: Record<string, unknown> = {};
const setEnv = (f: Record<string, string | undefined>) => { process.env = { ...env, SIGNUPS_OPEN: "true", MICROSOFT_CLIENT_ID: "cid", MICROSOFT_CLIENT_SECRET: "sec", ...f }; };
const post = async (path: string, body: Record<string, unknown>, uid?: string, email: string | null = null, emailVerified = false) => {
  if (uid) verifyIdToken.mockResolvedValue({ uid, email: email ?? undefined, email_verified: emailVerified });
  const r = await realFetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
};
const statusByAuth = async (authId: string) => (await db.select({ status: athletes.status }).from(athletes).where(eq(athletes.auth_id, authId)))[0]?.status;

beforeAll(async () => {
  await initTestDb();
  for (const f of ["0048_athlete_index.sql", "0051_identity_users.sql", "0052_identity_claim_sessions.sql"]) await client.exec(readFileSync(join(__dirname, "../../migrations", f), "utf8"));
  const app = express(); app.use(express.json());
  app.use("/auth", authRouter); app.use("/waitlist", waitlistRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  global.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "at" }), { status: 200 });
    if (u.includes("graph.microsoft.com")) return new Response(JSON.stringify(msProfile), { status: 200 });
    return realFetch(url, init);
  }) as typeof fetch;
});
afterAll(async () => { global.fetch = realFetch; process.env = env; await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
afterEach(() => { process.env = env; });

test("only the exact string \"true\" turns it on; on ⇒ every new account status is 'waitlisted'", () => {
  for (const v of [undefined, "", "false", "1", "TRUE"]) { setEnv({ WAITLIST_ALL_SIGNUPS: v }); expect(waitlistAllSignupsEnabled()).toBe(false); expect(newAccountStatus()).toBe("raw"); }
  setEnv({ WAITLIST_ALL_SIGNUPS: "true" });
  expect(waitlistAllSignupsEnabled()).toBe(true);
  expect(newAccountStatus()).toBe("waitlisted");
});

test.each([["legacy create branches", "false"], ["index create branches", "true"]])("W1, %s: on ⇒ /auth/signup, /auth/microsoft and /waitlist all create 'waitlisted'", async (_b, claim) => {
  setEnv({ WAITLIST_ALL_SIGNUPS: "true", ATHLETE_INDEX_CLAIM: claim });
  // Distinct names per branch: a near-identical name would be an index candidate ("Is this you?", 409), not a create.
  const name = claim === "true" ? "Ximena Dovrecourt" : "Saffi Signupwell";
  const s = await post("/auth/signup", { name, role: "athlete", sport: "Golf" }, `uid-s-${claim}`, `s-${claim}@new.example`, true);
  expect(s.status).toBe(201);
  expect(s.json.status).toBe("waitlisted");
  expect(await statusByAuth(`uid-s-${claim}`)).toBe("waitlisted");   // not moved to 'claimed' by the index path's link

  msProfile = { id: `ms-mica-${claim}`, displayName: claim === "true" ? "Quillon Zanzibarova" : "Mica Microsoftly", mail: `mica-${claim}@new.example` };
  expect(await post("/auth/microsoft", { code: "c", redirectUri: "r" })).toEqual({ status: 200, json: { customToken: "custom" } });
  expect(await statusByAuth(`microsoft:ms-mica-${claim}`)).toBe("waitlisted");

  const w = await post("/waitlist", { full_name: claim === "true" ? "Odalys Fennimore" : "Wynn Waitlistly" }, `uid-w-${claim}`, `w-${claim}@new.example`, true);
  expect(w.status).toBe(200);
  expect(await statusByAuth(`uid-w-${claim}`)).toBe("waitlisted");
});

test("W2: off ⇒ today's behaviour (/auth/signup and /auth/microsoft create 'raw')", async () => {
  setEnv({ WAITLIST_ALL_SIGNUPS: undefined, ATHLETE_INDEX_CLAIM: "false" });
  const s = await post("/auth/signup", { name: "Rory Rawly", role: "athlete", sport: "Golf" }, "uid-raw-s", "raw-s@new.example", true);
  expect([s.status, s.json.status]).toEqual([201, "raw"]);
  msProfile = { id: "ms-rawly", displayName: "Remy Rawly", mail: "remy@new.example" };
  await post("/auth/microsoft", { code: "c", redirectUri: "r" });
  expect(await statusByAuth("microsoft:ms-rawly")).toBe("raw");
});

test("Y1: production runs with it on (gcp/cloud-run-prod.yaml)", () => {
  const yaml = readFileSync(join(__dirname, "../../gcp/cloud-run-prod.yaml"), "utf8");
  expect(yaml).toMatch(/- name: WAITLIST_ALL_SIGNUPS\s*\n\s*value: "true"/);
});

test("L1: the landing shows \"You're in\" only for a promoted ('active') account; any other status stays on the list", () => {
  const html = readFileSync(join(__dirname, "../../landing/index.html"), "utf8");
  // both places that open "You're in": the sign-in route and the spot's promoted-since-last-look check
  expect(html).toContain("if (me && me.status === 'active') return openIn();");
  expect(html).toContain("if (S.progress && S.progress.status === 'active') { openIn(); return; }");
  // the old "anything but waitlisted is in" checks are gone (a 'raw' account from the app showed "You're in")
  expect(html).not.toMatch(/status !== 'waitlisted'\)\s*(return openIn|\{ openIn)/);
});

test("W3: existing accounts are untouched — an admin-promoted ('active') athlete signs in and stays 'active' (app reviewers)", async () => {
  setEnv({ WAITLIST_ALL_SIGNUPS: "true", ATHLETE_INDEX_CLAIM: "false" });
  await seedAthlete("Reva Reviewer", { auth_id: "uid-reviewer", auth_provider: "firebase", status: "active" } as any);
  const s = await post("/auth/signup", { name: "Reva Reviewer", role: "athlete" }, "uid-reviewer", "reviewer@nomila.example", true);
  expect(s.status).toBe(200);
  expect(s.json.status).toBe("active");
  expect(await statusByAuth("uid-reviewer")).toBe("active");

  await seedAthlete("Mo Reviewer", { auth_id: "microsoft:ms-reviewer", auth_provider: "microsoft", status: "active" } as any);
  msProfile = { id: "ms-reviewer", displayName: "Mo Reviewer", mail: "mo@nomila.example" };
  expect(await post("/auth/microsoft", { code: "c", redirectUri: "r" })).toEqual({ status: 200, json: { customToken: "custom" } });
  expect(await statusByAuth("microsoft:ms-reviewer")).toBe("active");
});
