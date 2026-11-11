/**
 * lifecycleEntryPoints.test.ts — PR E2b: every signup / claim-link entry point reaches startLifecycleResearch through
 * research/lifecycleHooks.enterLifecycleResearch when the boundary is open (execution gate + binding direct), and none
 * does anything when it is closed. The service is mocked here (its own behaviour — T1, the run, self-membership
 * admission, no_sport — is research/lifecycle.test.ts); the static exhaustiveness guard is research/lifecycleHooks.test.ts.
 *
 *   auth.ts      legacy e-mail claim (verified), legacy create, Microsoft create (legacy and index paths)
 *   waitlist.ts  create (fires once the sport is known), claim-link by a unique verified e-mail
 *   identityClaims.ts  "Is this you?" confirm (linked);   admin.ts  operator decide confirm (linked)
 *   T9           the waitlist's returning post that changes the sport → reenterIdentityResolution; unchanged → nothing
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
const verifyIdToken = jest.fn();
let callerUid = "uid-none"; let callerEmail: string | null = null;
jest.mock("../lib/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireAdmin: (req: any, _res: any, next: any) => { req.athleteId = "op-athlete"; next(); },
  requireFirebaseUser: (req: any, _res: any, next: any) => { req.authUid = callerUid; req.authEmail = callerEmail; req.authEmailVerified = true; next(); },
  verifyIdTokenChecked: (t: string) => verifyIdToken(t),   // routes/auth /signup and waitlist verify through lib/auth
  tokenFailure: () => ({ status: 401, body: { error: "Invalid or expired token" } }),
  firebaseAuth: { verifyIdToken: (t: string) => verifyIdToken(t), setCustomUserClaims: jest.fn().mockResolvedValue(undefined), createCustomToken: jest.fn().mockResolvedValue("custom") },
}));
jest.mock("../lib/notify", () => ({ notifyPromotion: jest.fn() }));
const startRun = jest.fn().mockResolvedValue({ run: { id: "r" }, created: true });
jest.mock("../workflow/runner", () => ({ ...jest.requireActual("../workflow/runner"), startRun: (...a: unknown[]) => startRun(...a) }));
const startLifecycleResearch = jest.fn();
const reenterIdentityResolution = jest.fn();
jest.mock("../services/intelligence/research/lifecycle", () => ({
  startLifecycleResearch: (...a: unknown[]) => startLifecycleResearch(...a),
  reenterIdentityResolution: (...a: unknown[]) => reenterIdentityResolution(...a),
}));
jest.setTimeout(180_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { client, db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { athletes } from "../../shared/schema";
import authRouter from "./auth";
import waitlistRouter from "./waitlist";
import identityClaimsRouter from "./identityClaims";
import adminRouter from "./admin";
import { resolveIdentity } from "../services/intelligence/identity/resolve";


let server: Server; let base: string; const env = process.env;
const ON = { RESEARCH_REFRESH_ENABLED: "true", RESEARCH_SUBSTRATE_WRITE: "true", RESEARCH_REFRESH_PROVIDER: "direct" };
const OFF = { RESEARCH_REFRESH_ENABLED: "false", RESEARCH_SUBSTRATE_WRITE: "false", RESEARCH_REFRESH_PROVIDER: "kimi" };
const setEnv = (f: Record<string, string>) => { process.env = { ...env, SIGNUPS_OPEN: "true", MICROSOFT_CLIENT_ID: "cid", MICROSOFT_CLIENT_SECRET: "sec", ...f }; };
const realFetch = global.fetch;
let msProfile: Record<string, unknown> = {};
const post = async (path: string, body: Record<string, unknown>, uid?: string, email: string | null = null, emailVerified = true) => {
  if (uid) verifyIdToken.mockResolvedValue({ uid, email: email ?? undefined, email_verified: emailVerified });
  const r = await realFetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
};
/** The calls are fire-and-forget (a dynamic import): let them land. */
const settle = () => new Promise((r) => setTimeout(r, 80));
let n = 0; const uniq = (s: string) => `${s}${++n}${Math.random().toString(36).slice(2, 6)}`;

beforeAll(async () => {
  await initTestDb();
  for (const f of ["0048_athlete_index.sql", "0051_identity_users.sql", "0052_identity_claim_sessions.sql"]) await client.exec(readFileSync(join(__dirname, "../../migrations", f), "utf8"));
  const app = express(); app.use(express.json());
  app.use("/auth", authRouter); app.use("/waitlist", waitlistRouter); app.use("/identity", identityClaimsRouter); app.use("/admin", adminRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Microsoft's token + Graph endpoints (the only outbound calls); everything else is the real fetch.
  global.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "at" }), { status: 200 });
    if (u.includes("graph.microsoft.com")) return new Response(JSON.stringify(msProfile), { status: 200 });
    return realFetch(url, init);
  }) as typeof fetch;
});
afterAll(async () => { global.fetch = realFetch; process.env = env; await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
beforeEach(() => { startLifecycleResearch.mockReset().mockResolvedValue({ started: true }); reenterIdentityResolution.mockReset().mockResolvedValue({ written: true }); startRun.mockClear(); });

/** Each scenario: run it, then return the athlete id it should have entered and with which trigger. */
const SCENARIOS: Array<[string, () => Promise<{ id: string; trigger: "signup" | "claim" }>]> = [
  ["auth legacy e-mail claim", async () => {
    setEnvKeep({ ATHLETE_INDEX_CLAIM: "false" });
    const id = await seedAthlete(uniq("Pat Rowe ")); const mail = `${uniq("pat")}@example.com`;
    await db.update(athletes).set({ email: mail, status: "raw", sport: "golf" } as any).where(eq(athletes.id, id));
    const r = await post("/auth/signup", { name: "Pat Rowe", role: "athlete", sport: "golf" }, uniq("uid-pat-"), mail, true);
    expect(r.status).toBe(200); expect(r.json.id).toBe(id);
    return { id, trigger: "claim" };
  }],
  ["auth legacy create (a name match only queues a proposal; never a claim)", async () => {
    setEnvKeep({ ATHLETE_INDEX_CLAIM: "false" });
    const name = uniq("Quincy Adebayo "); const id = await seedAthlete(name);
    await db.update(athletes).set({ sport: "tennis", status: "raw" } as any).where(eq(athletes.id, id));
    const r = await post("/auth/signup", { name, role: "athlete", sport: "tennis" }, uniq("uid-q-"), `${uniq("q")}@example.com`, true);
    expect(r.status).toBe(201); expect(r.json.id).not.toBe(id);
    return { id: r.json.id, trigger: "signup" };
  }],
  ["Microsoft legacy create", async () => {
    setEnvKeep({ ATHLETE_INDEX_CLAIM: "false" });
    msProfile = { id: uniq("ms-"), displayName: uniq("Mona Soft "), mail: `${uniq("mona")}@example.com` };
    expect((await post("/auth/microsoft", { code: "c", redirectUri: "x" })).status).toBe(200);
    const [a] = await db.select({ id: athletes.id }).from(athletes).where(eq(athletes.auth_id, `microsoft:${msProfile.id}`));
    return { id: a.id, trigger: "signup" };
  }],
  ["Microsoft index create", async () => {
    setEnvKeep({ ATHLETE_INDEX_CLAIM: "true" });
    msProfile = { id: uniq("ms-"), displayName: uniq("Zed Unique "), mail: `${uniq("zed")}@example.com` };
    expect((await post("/auth/microsoft", { code: "c", redirectUri: "x" })).status).toBe(200);
    const [a] = await db.select({ id: athletes.id }).from(athletes).where(eq(athletes.auth_id, `microsoft:${msProfile.id}`));
    return { id: a.id, trigger: "signup" };
  }],
  ["waitlist create (fires once the sport is known)", async () => {
    setEnvKeep({ ATHLETE_INDEX_CLAIM: "false" });
    const uid = uniq("uid-wl-");
    expect((await post("/waitlist", { full_name: "Wren Lane" }, uid, `${uniq("w")}@example.com`)).status).toBeLessThan(300);
    await settle();
    expect(startLifecycleResearch).not.toHaveBeenCalled();     // no sport yet: the onboarding guard holds both
    expect((await post("/waitlist", { sport: "rowing" }, uid, `${uniq("w")}@example.com`)).status).toBeLessThan(300);
    const [a] = await db.select({ id: athletes.id }).from(athletes).where(eq(athletes.auth_id, uid));
    return { id: a.id, trigger: "signup" };
  }],
  ["waitlist claim-link (unique verified e-mail)", async () => {
    setEnvKeep({ ATHLETE_INDEX_CLAIM: "true" });
    const name = uniq("Tove Lind "); const id = await seedAthlete(name); const mail = `${uniq("tove")}@example.com`;
    await db.update(athletes).set({ sport: "golf", status: "enriched", email: mail } as any).where(eq(athletes.id, id));
    const r = await post("/waitlist", { full_name: name, sport: "golf" }, uniq("uid-tove-"), mail, true);
    expect(r.status).toBeLessThan(300);
    return { id, trigger: "claim" };
  }],
  ["\"Is this you?\" confirm", async () => {
    setEnvKeep({ ATHLETE_INDEX_CLAIM: "true" });
    const name = uniq("Sam Ibarra "); const id = await seedAthlete(name); const mail = `${uniq("sam")}@example.com`;
    await db.update(athletes).set({ sport: "golf", status: "enriched", email: mail } as any).where(eq(athletes.id, id));
    callerUid = uniq("uid-sam-"); callerEmail = mail;
    const rr = await resolveIdentity({ path: "signup", caller: { uid: callerUid, email: mail, emailVerified: false }, provider: "firebase", query: { name, sport: "golf" } });
    const claim = rr.claims!.find((c) => c.athleteId === id)!;
    const r = await post(`/identity/claims/${claim.claimId}/confirm`, { claimSessionId: rr.claimSessionId });
    expect(r.json.outcome).toBe("linked");
    return { id, trigger: "claim" };
  }],
  ["operator decide confirm", async () => {
    setEnvKeep({ ATHLETE_INDEX_CLAIM: "true" });
    const name = uniq("Ola Brandt "); const id = await seedAthlete(name);
    await db.update(athletes).set({ sport: "golf", status: "enriched", email: `${uniq("ola")}@example.com` } as any).where(eq(athletes.id, id));
    const rr = await resolveIdentity({ path: "signup", caller: { uid: uniq("uid-ola-"), email: `${uniq("z")}@example.com`, emailVerified: true }, provider: "firebase", query: { name, sport: "golf" } });
    const claim = rr.claims!.find((c) => c.athleteId === id)!;
    const r = await post(`/admin/identity/claims/${claim.claimId}/decide`, { decision: "confirm" });
    expect(r.json.outcome).toBe("linked");
    return { id, trigger: "claim" };
  }],
];
let flagSet: Record<string, string> = ON;
function setEnvKeep(extra: Record<string, string>) { setEnv({ ...flagSet, ...extra }); }

describe("boundary open (execution gate + binding direct): every entry point enters", () => {
  beforeAll(() => { flagSet = ON; });
  for (const [label, run] of SCENARIOS) {
    test(`${label} → startLifecycleResearch(id, trigger)`, async () => {
      const want = await run();
      await settle();
      expect(startLifecycleResearch).toHaveBeenCalledWith(want.id, want.trigger);
    });
  }
});

describe("boundary closed: no entry point does anything (the service is never even loaded)", () => {
  beforeAll(() => { flagSet = OFF; });
  for (const [label, run] of SCENARIOS) {
    test(`${label} → nothing`, async () => {
      await run();
      await settle();
      expect(startLifecycleResearch).not.toHaveBeenCalled();
      expect(reenterIdentityResolution).not.toHaveBeenCalled();
    });
  }
});

describe("T9 at the waitlist's returning post (the real re-entry is research/anchorWriters tests)", () => {
  async function returning() {
    const uid = uniq("uid-ret-");
    expect((await post("/waitlist", { full_name: "Remy Return", sport: "soccer" }, uid, `${uniq("r")}@example.com`)).status).toBeLessThan(300);
    const [a] = await db.select({ id: athletes.id }).from(athletes).where(eq(athletes.auth_id, uid));
    await settle(); reenterIdentityResolution.mockClear();
    return { uid, id: a.id };
  }
  test("a changed sport re-enters (nameOrSportChanged); the same name and sport do nothing", async () => {
    flagSet = ON; setEnvKeep({ ATHLETE_INDEX_CLAIM: "false" });
    const r = await returning();
    await post("/waitlist", { full_name: "Remy Return", sport: "soccer", school: "New School" }, r.uid, "x@example.com");
    expect(reenterIdentityResolution).not.toHaveBeenCalled();
    await post("/waitlist", { full_name: "Remy Return", sport: "basketball" }, r.uid, "x@example.com");
    expect(reenterIdentityResolution).toHaveBeenCalledWith(r.id, { trigger: "anchor_changed", nameOrSportChanged: true });
  });
  test("boundary closed: nothing", async () => {
    flagSet = OFF; setEnvKeep({ ATHLETE_INDEX_CLAIM: "false" });
    const r = await returning();
    await post("/waitlist", { full_name: "Remy Renamed", sport: "basketball" }, r.uid, "x@example.com");
    expect(reenterIdentityResolution).not.toHaveBeenCalled();
  });
});

test("a seeded athlete (no account) is never handed to the service by any route (only linked / created rows are)", async () => {
  flagSet = ON; setEnvKeep({ ATHLETE_INDEX_CLAIM: "true" });
  const seeded = await seedAthlete(uniq("Seeda Only "));
  await db.update(athletes).set({ sport: "golf", status: "enriched" } as any).where(eq(athletes.id, seeded));
  // a candidate proposal (409) links nothing and enters nothing
  const r = await post("/auth/signup", { name: "Seeda Only", role: "athlete", sport: "golf" }, uniq("uid-seed-"), `${uniq("s")}@example.com`, true);
  await settle();
  expect(startLifecycleResearch.mock.calls.map((c) => c[0])).not.toContain(seeded);
  expect([200, 201, 409]).toContain(r.status);

});
