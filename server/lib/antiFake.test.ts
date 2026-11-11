/**
 * antiFake.test.ts — the anti-fake plan's quick layers (owner, 24 Oct 2026) through the real landing route (POST
 * /waitlist) and the app's POST /auth/signup on Express + PGlite. firebase-admin's App Check is mocked: nothing here
 * reaches a provider. Research is mocked off.
 *
 *   A1 App Check modes: off (default, any unknown value) verifies nothing; monitor verifies, logs a missing / invalid
 *      token and still creates; enforce refuses a NEW account without a valid token (403 app_check_failed, nothing made)
 *   A2 only a create is checked: an existing athlete's later steps never are, even under enforce
 *   A3 a verification that could not run (Google's keys unreachable, our credentials) fails open, even under enforce
 *   A4 /auth/signup's create is checked the same way
 *   F1 disposable_email: a throwaway domain (or a sub-domain of one) is flagged at creation; a normal domain is not
 *   F2 same_network_burst: the 6th new account from one network within 24 h is flagged (and the ones after); the first
 *      five are not; another network is not; the account is always made (a flag never blocks); no IP is stored
 *   F3 the counter read covers 24 hourly windows and never an older one; flags merge and clear
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
const verifyIdToken = jest.fn();
jest.mock("./auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireFirebaseUser: (_req: any, _res: any, next: any) => next(),
  verifyIdTokenChecked: (t: string) => verifyIdToken(t),
  tokenFailure: () => ({ status: 401, body: { error: "Invalid or expired token" } }),
  firebaseAuth: { verifyIdToken: (t: string) => verifyIdToken(t), setCustomUserClaims: jest.fn().mockResolvedValue(undefined), createCustomToken: jest.fn().mockResolvedValue("custom") },
}));
const verifyAppCheckToken = jest.fn();
jest.mock("firebase-admin/app", () => ({ getApps: () => [{}], initializeApp: jest.fn() }));
jest.mock("firebase-admin/app-check", () => ({ getAppCheck: () => ({ verifyToken: (t: string) => verifyAppCheckToken(t) }) }));
jest.mock("./backgroundHost", () => ({ runsBackgroundWork: () => false }));
jest.mock("../skills/researchAthlete", () => ({ ...jest.requireActual("../skills/researchAthlete"), researchAthlete: jest.fn(async () => { throw new Error("no provider in this test"); }) }));
jest.mock("../services/marketabilityBeta1Orchestrator", () => ({ requestEvaluation: jest.fn(async () => ({})), getMarketability: jest.fn(async () => null) }));
jest.mock("../services/intelligence/research/lifecycle", () => ({ startLifecycleResearch: jest.fn(async () => ({ started: false, reason: "disabled" })), reenterIdentityResolution: jest.fn() }));
jest.setTimeout(120_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { closeTestDb, db, initTestDb } from "../testUtils/pgliteDb";
import { athletes, publicRateCounters } from "../../shared/schema";
import authRouter from "../routes/auth";
import waitlistRouter from "../routes/waitlist";
import { appCheckMode } from "./appCheck";
import { isDisposableEmail } from "./disposableDomains";
import { clearSignupFlag, setSignupFlags } from "./signupFlags";
import { recentTotal, take } from "./publicRateCounters";

let server: Server; let base = ""; const env = process.env;
let n = 0; const uniq = (s: string) => `${s}-${++n}-${Math.random().toString(36).slice(2, 6)}`;

const post = async (path: string, uid: string, body: Record<string, unknown>, o: { ip?: string; email?: string; appCheck?: string } = {}) => {
  verifyIdToken.mockResolvedValue({ uid, email: o.email ?? `${uid}@example.com`, email_verified: true });
  const headers: Record<string, string> = { "content-type": "application/json", authorization: "Bearer tok", "x-forwarded-for": o.ip ?? "203.0.113.7" };
  if (o.appCheck) headers["x-firebase-appcheck"] = o.appCheck;
  const r = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
};
const rowFor = async (uid: string) => (await db.select({ id: athletes.id, flags: athletes.signup_flags }).from(athletes).where(eq(athletes.auth_id, uid)))[0] ?? null;

beforeAll(async () => {
  await initTestDb();
  const app = express(); app.set("trust proxy", 1); app.use(express.json()); app.use("/auth", authRouter); app.use("/waitlist", waitlistRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { process.env = env; await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
beforeEach(async () => {
  process.env = { ...env, SIGNUPS_OPEN: "true", ATHLETE_INDEX_CLAIM: "false", SIGNUP_RESEARCH_AGENT: "false", RESEARCH_REFRESH_ENABLED: "false", APP_CHECK_ENFORCE: "" };
  delete process.env.NEW_ACCOUNTS_PER_IP_PER_HOUR; delete process.env.NEW_ACCOUNTS_PER_HOUR;
  await db.delete(publicRateCounters);
  verifyAppCheckToken.mockReset();
  verifyAppCheckToken.mockImplementation(async (t: string) => {
    if (t === "good") return { appId: "web" };
    throw Object.assign(new Error("The provided App Check token has invalid signature."), { code: "app-check/invalid-argument" });
  });
});

describe("App Check on account creation", () => {
  test("A1: off by default; monitor verifies and allows; enforce refuses a missing or invalid token and makes nothing", async () => {
    expect(appCheckMode()).toBe("off");
    process.env.APP_CHECK_ENFORCE = "loud"; expect(appCheckMode()).toBe("off");
    process.env.APP_CHECK_ENFORCE = "";
    expect((await post("/waitlist", uniq("off"), {})).status).toBe(200);
    expect(verifyAppCheckToken).not.toHaveBeenCalled();

    process.env.APP_CHECK_ENFORCE = "monitor";
    const m1 = uniq("mon"); expect((await post("/waitlist", m1, {})).status).toBe(200);                         // missing: allowed
    const m2 = uniq("mon"); expect((await post("/waitlist", m2, {}, { appCheck: "forged" })).status).toBe(200);   // invalid: allowed
    expect(await rowFor(m1)).not.toBeNull(); expect(await rowFor(m2)).not.toBeNull();
    expect(verifyAppCheckToken).toHaveBeenCalledWith("forged");

    process.env.APP_CHECK_ENFORCE = "ENFORCE";
    const e1 = uniq("enf"); const r1 = await post("/waitlist", e1, {});
    expect(r1.status).toBe(403); expect(r1.json.error).toBe("app_check_failed"); expect(await rowFor(e1)).toBeNull();
    const e2 = uniq("enf"); expect((await post("/waitlist", e2, {}, { appCheck: "forged" })).status).toBe(403); expect(await rowFor(e2)).toBeNull();
    const e3 = uniq("enf"); expect((await post("/waitlist", e3, {}, { appCheck: "good" })).status).toBe(200); expect(await rowFor(e3)).not.toBeNull();
  });

  test("A2: an existing athlete's later steps are never checked, even under enforce", async () => {
    const a = uniq("later");
    expect((await post("/waitlist", a, {}, { appCheck: "good" })).status).toBe(200);
    process.env.APP_CHECK_ENFORCE = "enforce"; verifyAppCheckToken.mockClear();
    expect((await post("/waitlist", a, { sport: "Golf", full_name: "Later Steps" })).status).toBe(200);
    expect(verifyAppCheckToken).not.toHaveBeenCalled();
  });

  test("A3: a verification that cannot run fails open, even under enforce", async () => {
    process.env.APP_CHECK_ENFORCE = "enforce";
    verifyAppCheckToken.mockRejectedValue(Object.assign(new Error("Error fetching public keys for Google certs: socket hang up"), { code: "app-check/invalid-argument" }));
    expect((await post("/waitlist", uniq("down"), {}, { appCheck: "anything" })).status).toBe(200);
    verifyAppCheckToken.mockRejectedValue(Object.assign(new Error("no project id"), { code: "app-check/invalid-credential" }));
    expect((await post("/waitlist", uniq("down"), {}, { appCheck: "anything" })).status).toBe(200);
  });

  test("A4: /auth/signup's create is checked the same way", async () => {
    process.env.APP_CHECK_ENFORCE = "enforce";
    const body = { name: "App Signer", role: "athlete" };
    expect((await post("/auth/signup", uniq("s"), body)).status).toBe(403);
    expect((await post("/auth/signup", uniq("s"), body, { appCheck: "good" })).status).toBe(201);
  });
});

describe("admin flags at creation", () => {
  test("F1: disposable_email for a throwaway domain (and its sub-domains), never for a normal one", async () => {
    expect([isDisposableEmail("x@mailinator.com"), isDisposableEmail("x@EU.Mailinator.com"), isDisposableEmail("x@gmail.com"), isDisposableEmail("x@notmailinator.com"), isDisposableEmail(null)])
      .toEqual([true, true, false, false, false]);
    const d = uniq("disp");
    expect((await post("/waitlist", d, {}, { email: `${d}@yopmail.com` })).status).toBe(200);
    expect((await rowFor(d))!.flags).toMatchObject({ disposable_email: { domain: "yopmail.com" } });
    const g = uniq("good");
    expect((await post("/waitlist", g, {}, { email: `${g}@gmail.com` })).status).toBe(200);
    expect((await rowFor(g))!.flags).toBeNull();
    const s = uniq("app");
    expect((await post("/auth/signup", s, { name: "App Disp", role: "athlete" }, { email: `${s}@guerrillamail.com` })).status).toBe(201);
    expect((await rowFor(s))!.flags).toHaveProperty("disposable_email");
  });

  test("F2: same_network_burst from the 6th new account on one network in 24 h; never a block; no IP stored", async () => {
    const uids = Array.from({ length: 7 }, () => uniq("net"));
    for (const u of uids) expect((await post("/waitlist", u, {}, { ip: "198.51.100.50" })).status).toBe(200);
    const flags = await Promise.all(uids.map(async (u) => (await rowFor(u))!.flags as any));
    expect(flags.slice(0, 5).every((f) => !f?.same_network_burst)).toBe(true);
    expect(flags[5].same_network_burst).toMatchObject({ accounts24h: 6 });
    expect(flags[6].same_network_burst).toMatchObject({ accounts24h: 7 });
    expect(JSON.stringify(flags)).not.toContain("198.51.100.50");
    const other = uniq("net2"); await post("/waitlist", other, {}, { ip: "198.51.100.51" });
    expect((await rowFor(other))!.flags).toBeNull();
  });

  test("F3: the 24 h read spans the current and 23 earlier hourly windows only; flags merge and clear", async () => {
    const now = new Date("2026-10-24T12:30:00Z");
    await take(["t", "x"], 999, "hour", new Date(now.getTime() - 23 * 3_600_000));   // inside
    await take(["t", "x"], 999, "hour", new Date(now.getTime() - 25 * 3_600_000));   // outside
    await take(["t", "x"], 999, "hour", now);
    expect(await recentTotal(["t", "x"], "hour", 86_400_000, now)).toBe(2);

    const u = uniq("merge"); await post("/waitlist", u, {}, { email: `${u}@mailinator.com` });
    const id = (await rowFor(u))!.id;
    await setSignupFlags(id, { no_athlete_footprint: { at: now.toISOString(), reason: "none" } });
    expect(Object.keys((await rowFor(u))!.flags as any).sort()).toEqual(["disposable_email", "no_athlete_footprint"]);
    await clearSignupFlag(id, "no_athlete_footprint"); await clearSignupFlag(id, "disposable_email");
    expect((await rowFor(u))!.flags).toBeNull();
  });
});
