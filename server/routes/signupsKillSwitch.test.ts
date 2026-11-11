/**
 * signupsKillSwitch.test.ts — SIGNUPS_OPEN. Only exactly "true" lets the auth paths create a NEW athlete; anything else
 * answers 403 { error: "signups_closed" } on the create branches of /auth/signup (legacy and index paths),
 * /auth/microsoft (legacy and index paths) and /waitlist — and creates nothing. Existing users (a matching auth_id)
 * sign in unchanged, and a verified-e-mail claim of an existing row (not a new account) still links.
 * Microsoft's token + Graph endpoints are stubbed; no test reaches a provider.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
const verifyIdToken = jest.fn();
jest.mock("../lib/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireFirebaseUser: (_req: any, _res: any, next: any) => next(),
  verifyIdTokenChecked: (t: string) => verifyIdToken(t),   // routes/auth /signup and waitlist verify through lib/auth
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
import { eq, sql } from "drizzle-orm";
import { client, db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { athletes } from "../../shared/schema";
import authRouter from "./auth";
import waitlistRouter from "./waitlist";
import { signupsOpen } from "../lib/signups";

let server: Server; let base: string; const env = process.env;
const realFetch = global.fetch;
let msProfile: Record<string, unknown> = {};
const setEnv = (f: Record<string, string | undefined>) => { process.env = { ...env, MICROSOFT_CLIENT_ID: "cid", MICROSOFT_CLIENT_SECRET: "sec", ...f }; if (f.SIGNUPS_OPEN === undefined) delete process.env.SIGNUPS_OPEN; };
const post = async (path: string, body: Record<string, unknown>, uid?: string, email: string | null = null, emailVerified = false) => {
  if (uid) verifyIdToken.mockResolvedValue({ uid, email: email ?? undefined, email_verified: emailVerified });
  const r = await realFetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
};
const athleteCount = async () => Number((await db.select({ n: sql<number>`count(*)::int` }).from(athletes))[0].n);

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

test("only the exact string \"true\" opens sign-ups", () => {
  for (const v of [undefined, "", "false", "1", "TRUE", "True", " true"]) { setEnv({ SIGNUPS_OPEN: v }); expect(signupsOpen()).toBe(false); }
  setEnv({ SIGNUPS_OPEN: "true" }); expect(signupsOpen()).toBe(true);
});

describe.each([["legacy path", "false"], ["index path", "true"]])("closed — %s (ATHLETE_INDEX_CLAIM=%s)", (_label, claimFlag) => {
  it("blocks every NEW account: /auth/signup, /auth/microsoft and /waitlist answer 403 signups_closed and create nothing", async () => {
    for (const closed of [undefined, "false"]) {
      setEnv({ ATHLETE_INDEX_CLAIM: claimFlag, SIGNUPS_OPEN: closed });
      const before = await athleteCount();
      const s = await post("/auth/signup", { name: `Nadia Newcomer ${claimFlag}${closed}`, role: "athlete", sport: "golf" }, `uid-new-${claimFlag}-${closed}`, "nadia@new.example", true);
      expect(s).toEqual({ status: 403, json: { error: "signups_closed" } });
      msProfile = { id: `ms-new-${claimFlag}-${closed}`, displayName: `Milo Fresh ${claimFlag}`, mail: "milo@new.example" };
      const m = await post("/auth/microsoft", { code: "c", redirectUri: "r" });
      expect(m).toEqual({ status: 403, json: { error: "signups_closed" } });
      const w = await post("/waitlist", { full_name: `Wren Waiting ${claimFlag}`, sport: "golf" }, `uid-wl-${claimFlag}-${closed}`, "wren@new.example", true);
      expect(w).toEqual({ status: 403, json: { error: "signups_closed" } });
      expect(await athleteCount()).toBe(before);
    }
  });

  it("existing users are unaffected: a matching auth_id signs in on /auth/signup, /auth/microsoft and /waitlist", async () => {
    setEnv({ ATHLETE_INDEX_CLAIM: claimFlag, SIGNUPS_OPEN: "false" });
    const fb = await seedAthlete(`Esme Existing ${claimFlag}`, { auth_id: `uid-esme-${claimFlag}`, auth_provider: "firebase", status: "active" } as any);
    const s = await post("/auth/signup", { name: "Esme Existing", role: "athlete" }, `uid-esme-${claimFlag}`, "esme@x.example", true);
    expect(s.status).toBe(200); expect(s.json.id).toBe(fb);
    await seedAthlete(`Mona Existing ${claimFlag}`, { auth_id: `microsoft:ms-mona-${claimFlag}`, auth_provider: "microsoft", status: "active" } as any);
    msProfile = { id: `ms-mona-${claimFlag}`, displayName: "Mona Existing" };
    const m = await post("/auth/microsoft", { code: "c", redirectUri: "r" });
    expect(m).toEqual({ status: 200, json: { customToken: "custom" } });
    const wl = await seedAthlete(`Walt Waitlisted ${claimFlag}`, { auth_id: `uid-walt-${claimFlag}`, auth_provider: "firebase", status: "waitlisted" } as any);
    const w = await post("/waitlist", { sport: "golf" }, `uid-walt-${claimFlag}`, null, false);
    expect(w.status).toBe(200); expect(w.json.returning).toBe(true);
    const [row] = await db.select({ sport: athletes.sport }).from(athletes).where(eq(athletes.id, wl)); expect(row.sport).toBe("golf");
  });

  it("a verified-e-mail claim of an existing row still links while closed (it is not a new account)", async () => {
    setEnv({ ATHLETE_INDEX_CLAIM: claimFlag, SIGNUPS_OPEN: "false" });
    const row = await seedAthlete(`Clara Claimant ${claimFlag}`, { email: `clara-${claimFlag}@real.example`, status: "enriched", sport: "golf" } as any);
    const s = await post("/auth/signup", { name: `Clara Claimant ${claimFlag}`, role: "athlete", sport: "golf" }, `uid-clara-${claimFlag}`, `clara-${claimFlag}@real.example`, true);
    expect(s.status).toBe(200); expect(s.json.id).toBe(row);
  });
});

test("closed, index path: a name with candidates returns NO candidate records and proposes nothing (signup, waitlist); open still asks", async () => {
  const known = await seedAthlete("Odessa Quartermain", { status: "enriched", sport: "golf", email: "odessa@real.example" } as any);
  const claimsFor = async () => (await db.execute(sql`SELECT count(*)::int AS n FROM identity_claims WHERE athlete_id = ${known}::uuid`) as any).rows?.[0]?.n ?? 0;
  setEnv({ ATHLETE_INDEX_CLAIM: "true", SIGNUPS_OPEN: "false" });
  const s = await post("/auth/signup", { name: "Odessa Quartermain", role: "athlete", sport: "golf" }, "uid-odessa-probe", "probe@new.example", true);
  expect(s).toEqual({ status: 403, json: { error: "signups_closed" } });
  const w = await post("/waitlist", { full_name: "Odessa Quartermain", sport: "golf" }, "uid-odessa-probe-wl", "probe2@new.example", true);
  expect(w).toEqual({ status: 403, json: { error: "signups_closed" } });
  expect(await claimsFor()).toBe(0);
  // the same request with sign-ups open is the "Is this you?" question (so the closed answer above is the switch, not a miss)
  setEnv({ ATHLETE_INDEX_CLAIM: "true", SIGNUPS_OPEN: "true" });
  const open = await post("/auth/signup", { name: "Odessa Quartermain", role: "athlete", sport: "golf" }, "uid-odessa-probe", "probe@new.example", true);
  expect(open.status).toBe(409); expect(open.json.claims.map((c: any) => c.athleteId)).toContain(known);
});

test("open: the same new-account calls create (201 / custom token / ok)", async () => {
  setEnv({ ATHLETE_INDEX_CLAIM: "false", SIGNUPS_OPEN: "true" });
  const before = await athleteCount();
  expect((await post("/auth/signup", { name: "Opal Open", role: "athlete" }, "uid-opal", "opal@new.example", true)).status).toBe(201);
  msProfile = { id: "ms-otto", displayName: "Otto Open", mail: "otto@new.example" };
  expect(await post("/auth/microsoft", { code: "c", redirectUri: "r" })).toEqual({ status: 200, json: { customToken: "custom" } });
  expect((await post("/waitlist", { full_name: "Orla Open" }, "uid-orla", "orla@new.example", true)).status).toBe(200);
  expect(await athleteCount()).toBe(before + 3);
});
