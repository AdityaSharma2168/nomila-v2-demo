/**
 * adminDeleteAccount.test.ts — POST /api/v1/admin/athletes/:id/delete over HTTP, through the full admin router with the
 * REAL admin gate (only Firebase token verification faked), on PGlite, with the real phase 1 of the account deletion.
 * Providers never reached: grant revocation and Apple revoke are mocked, and the runner's kick is stubbed so phase 2
 * (storage / Firebase / Langfuse) does not run here — the full purge is covered by account.delete.test.ts.
 *
 *   D1 no token → 401; a signed-in non-admin → 403, nothing deleted
 *   D2 confirmEmail missing → 400; not their sign-in email → 400; nothing deleted
 *   D3 a protected account (ADMIN_DELETE_PROTECTED_EMAILS / default tester@nomila.co, or an admin role) → 403
 *   D4 a held payment → 409 PAYMENTS_IN_FLIGHT, no fence, no receipt
 *   D5 happy path (email in any case): 202 with the receipt; the fence is set, the receipt run is created_by admin,
 *      the Apple grant is recorded as skipped (no code on an admin request), grants revoked, audit line ids only
 *   D6 a repeat returns the same receipt (already: true) and writes no second run
 *   D7 the acting admin's own athlete → 403 SELF_DELETE; a malformed id → 404
 *   D8 admin held only in user_roles, or only as a Firebase custom claim → 403; REVIEW_LOGIN_EMAIL → 403
 *   D9 the email matched via their sign-in user (users table); a Sign in with Apple user → Apple recorded as skipped
 *   D10 the Firebase user cannot be read → 503, nothing deleted
 * The Firebase Admin SDK is faked (getUser per uid: claims + providerData); no network.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
const logs: Array<{ level: string; obj: any; msg: string }> = [];
jest.mock("../logger", () => {
  const mk = () => ({
    info: (obj: any, msg: string) => logs.push({ level: "info", obj, msg }), warn: (obj: any, msg: string) => logs.push({ level: "warn", obj, msg }),
    error: (obj: any, msg: string) => logs.push({ level: "error", obj, msg }), debug: () => {},
  });
  return { createLogger: mk, logger: mk() };
});
jest.mock("firebase-admin/app", () => ({ initializeApp: () => ({}), getApps: () => [] }));
/** Firebase sign-in users by uid (claims, providers); "throw" makes getUser fail. Unknown uid ⇒ a plain user. */
const fbUsers = new Map<string, { customClaims?: Record<string, unknown>; providerData?: Array<{ providerId: string }> } | "throw">();
jest.mock("firebase-admin/auth", () => ({
  getAuth: () => ({
    getUser: async (uid: string) => {
      const u = fbUsers.get(uid);
      if (u === "throw") throw Object.assign(new Error("firebase unavailable"), { code: "app/network-error" });
      return { uid, disabled: false, customClaims: u?.customClaims, providerData: u?.providerData ?? [{ providerId: "google.com" }] };
    },
    verifyIdToken: async (t: string) => {
      if (t === "admin-token") return { uid: "uid-operator", roles: ["admin"] };
      if (t.startsWith("user:")) return { uid: t.slice(5), roles: [] };
      throw new Error("invalid token");
    },
  }),
}));
const revokeGrant = jest.fn(async (g: any) => ({ connection_id: g.id, platform: g.platform, outcome: "revoked" }));
jest.mock("../lib/privacy/revokeGrants", () => ({ revokeGrantForDeletion: (g: any) => revokeGrant(g) }));
const revokeApple = jest.fn();
jest.mock("../lib/privacy/appleRevoke", () => ({ revokeAppleSignIn: (...a: unknown[]) => revokeApple(...a) }));
const kick = jest.fn().mockResolvedValue(0);
jest.mock("../workflow/runner", () => ({ ...jest.requireActual("../workflow/runner"), kick: (...a: unknown[]) => kick(...a) }));
jest.mock("../lib/notify", () => ({ notifyPromotion: jest.fn() }));
jest.setTimeout(180_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { accountRoles, deals, payments, userRoles, users } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";
import adminRouter from "./admin";
import { protectedEmails } from "./adminDeleteAccount";

let server: Server; let base: string; let operatorId: string;
const rows = (r: any) => (r.rows ?? r) as any[];

beforeAll(async () => {
  await initTestDb();
  // The acting admin has an athlete row (as the founders do): requireAdmin sets req.athleteId to it.
  operatorId = await seedAthlete("Operator", { email: "operator@nomila.co", auth_id: "uid-operator" } as any);
  const app = express(); app.use(express.json()); app.use("/api/v1/admin", adminRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/admin`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
const env = process.env;
beforeEach(() => { fbUsers.clear(); process.env = { ...env }; delete process.env.ADMIN_DELETE_PROTECTED_EMAILS; delete process.env.REVIEW_LOGIN_EMAIL; logs.length = 0; kick.mockClear(); revokeApple.mockClear(); revokeGrant.mockClear(); });
afterAll(() => { process.env = env; });

const del = async (id: string, body: unknown, token: string | null = "admin-token") => {
  const r = await fetch(`${base}/athletes/${id}/delete`, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as any };
};
const appleItems = async (runId: string) => rows(await db.execute(sql`
  SELECT system, ref, status, outcome, attempts FROM account_deletion_items WHERE run_id = ${runId}::uuid AND ref = 'apple_sign_in'
`));
/** A sign-in user (users row keyed on the athlete's auth_id) with an email; returns its id. */
const seedUser = async (authId: string, email: string | null) =>
  (await db.insert(users).values({ provider: "firebase", provider_uid: authId, email } as any).returning({ id: users.id }))[0].id;
const fenced = async (id: string) => rows(await db.execute(sql`SELECT deletion_requested_at IS NOT NULL AS f FROM athletes WHERE id = ${id}::uuid`))[0]?.f === true;
const receipts = async (id: string) => rows(await db.execute(sql`
  SELECT id, status, created_by FROM workflow_runs WHERE process = 'account_deletion' AND input->>'subject_athlete_id' = ${id}
`));

test("D1: no token → 401; a signed-in non-admin → 403; nothing deleted", async () => {
  const id = await seedAthlete("Gate Check", { email: "gate@example.com", auth_id: "uid-gate" } as any);
  expect((await del(id, { confirmEmail: "gate@example.com" }, null)).status).toBe(401);
  expect((await del(id, { confirmEmail: "gate@example.com" }, "user:uid-gate")).status).toBe(403);
  expect(await fenced(id)).toBe(false);
  expect(await receipts(id)).toHaveLength(0);
});

test("D2: confirmEmail missing or not their sign-in email → 400, nothing deleted", async () => {
  const id = await seedAthlete("Mismatch", { email: "right@example.com" } as any);
  const missing = await del(id, {});
  expect(missing.status).toBe(400);
  expect(missing.json.code).toBe("CONFIRM_EMAIL_REQUIRED");
  const wrong = await del(id, { confirmEmail: "wrong@example.com" });
  expect(wrong.status).toBe(400);
  expect(wrong.json.code).toBe("CONFIRM_EMAIL_MISMATCH");
  expect(await fenced(id)).toBe(false);
  expect(await receipts(id)).toHaveLength(0);
});

test("D3: protected accounts are refused with 403 (default tester@nomila.co, the env list, an admin role)", async () => {
  expect([...protectedEmails({} as NodeJS.ProcessEnv)]).toEqual(["tester@nomila.co"]);
  const reviewer = await seedAthlete("App Review", { email: "Tester@Nomila.co" } as any);
  const r = await del(reviewer, { confirmEmail: "tester@nomila.co" });
  expect(r.status).toBe(403);
  expect(r.json.code).toBe("PROTECTED_ACCOUNT");

  process.env.ADMIN_DELETE_PROTECTED_EMAILS = "staff@nomila.co, other@nomila.co";
  const staff = await seedAthlete("Staff", { email: "staff@nomila.co" } as any);
  expect((await del(staff, { confirmEmail: "staff@nomila.co" })).status).toBe(403);

  const admin = await seedAthlete("An Admin", { email: "boss@example.com" } as any);
  await db.insert(accountRoles).values({ account_id: admin, role: "admin" } as any);
  expect((await del(admin, { confirmEmail: "boss@example.com" })).status).toBe(403);

  for (const id of [reviewer, staff, admin]) { expect(await fenced(id)).toBe(false); expect(await receipts(id)).toHaveLength(0); }
});

test("D4: a held payment → 409 PAYMENTS_IN_FLIGHT; no fence, no receipt", async () => {
  const id = await seedAthlete("Held Money", { email: "held@example.com" } as any);
  const [d] = await db.insert(deals).values({ athlete_id: id, brand_name: "Brand", status: "accepted", source: "self_reported" } as any).returning({ id: deals.id });
  await db.insert(payments).values({ deal_id: d.id, athlete_id: id, kind: "deal_payment", status: "funded", deal_value_cents: 50_000 } as any);
  const r = await del(id, { confirmEmail: "held@example.com" });
  expect(r.status).toBe(409);
  expect(r.json).toMatchObject({ code: "PAYMENTS_IN_FLIGHT", deal_ids: [d.id] });
  expect(await fenced(id)).toBe(false);
  expect(await receipts(id)).toHaveLength(0);
});

test("D5 + D6: happy path sets the fence and writes the receipt; a repeat returns the same receipt", async () => {
  const id = await seedAthlete("Going Away", { email: "going@example.com", auth_id: "uid-going" } as any);
  const conn = await seedConnection({ athleteId: id, platform: "instagram" });
  await db.execute(sql`UPDATE connected_accounts SET access_token = 'tok' WHERE id = ${conn}::uuid`);
  const r = await del(id, { confirmEmail: "  GOING@example.com " });
  expect(r.status).toBe(202);
  expect(r.json).toMatchObject({ ok: true, status: "deleting", already: false });
  const receiptId = r.json.receipt_id;
  expect(await fenced(id)).toBe(true);
  const runs = await receipts(id);
  expect(runs).toEqual([{ id: receiptId, status: "running", created_by: "admin" }]);
  // Phase 1 ran: grants revoked (mocked); a Google sign-in user ⇒ no Apple call and no Apple line.
  expect(revokeGrant).toHaveBeenCalledTimes(1);
  expect(revokeApple).not.toHaveBeenCalled();
  expect(await appleItems(receiptId)).toEqual([]);
  expect(kick).toHaveBeenCalledWith(receiptId);
  // The acting admin's id is on the receipt input (an id only).
  const [input] = rows(await db.execute(sql`SELECT input FROM workflow_runs WHERE id = ${receiptId}::uuid`));
  expect(input.input.requested_by_admin_id).toBe(operatorId);
  // Audit: ids only, never the email.
  const audit = logs.find((l) => l.msg === "admin account deletion requested");
  expect(audit?.obj).toEqual({ adminId: operatorId, athleteId: id, receiptId, already: false });
  expect(JSON.stringify(logs)).not.toContain("going@example.com");

  // The list marks them as deleting.
  const list = await fetch(`${base}/waitlist?status=raw`, { headers: { authorization: "Bearer admin-token" } }).then((x) => x.json() as Promise<any>);
  expect(list.athletes.find((a: any) => a.id === id)?.deleting).toBe(true);

  const again = await del(id, { confirmEmail: "going@example.com" });
  expect(again.status).toBe(202);
  expect(again.json).toEqual({ ok: true, receipt_id: receiptId, status: "deleting", already: true });
  expect(await receipts(id)).toHaveLength(1);
});

test("D7: the acting admin's own athlete → 403 SELF_DELETE; a malformed id → 404", async () => {
  const self = await del(operatorId, { confirmEmail: "operator@nomila.co" });
  expect(self.status).toBe(403);
  expect(self.json).toMatchObject({ code: "SELF_DELETE", error: "Delete your own account in the app" });
  expect(await fenced(operatorId)).toBe(false);
  expect((await del("not-a-uuid", { confirmEmail: "x@example.com" })).status).toBe(404);
  expect((await del("00000000-0000-4000-8000-000000000000", { confirmEmail: "x@example.com" })).status).toBe(404);
});

test("D8: admin only in user_roles, only as a Firebase claim, or the REVIEW_LOGIN_EMAIL → 403", async () => {
  const viaUserRoles = await seedAthlete("User Roles Admin", { email: "ur@example.com", auth_id: "uid-ur" } as any);
  const uid = await seedUser("uid-ur", "ur@example.com");
  await db.insert(userRoles).values({ user_id: uid, role: "admin" } as any);
  expect((await del(viaUserRoles, { confirmEmail: "ur@example.com" })).json.code).toBe("PROTECTED_ACCOUNT");

  const viaClaim = await seedAthlete("Claim Admin", { email: "claim@example.com", auth_id: "uid-claim" } as any);
  fbUsers.set("uid-claim", { customClaims: { roles: ["admin"] } });
  const c = await del(viaClaim, { confirmEmail: "claim@example.com" });
  expect(c.status).toBe(403);
  expect(c.json.code).toBe("PROTECTED_ACCOUNT");

  process.env.REVIEW_LOGIN_EMAIL = "Reviewer@Example.com";
  const reviewer = await seedAthlete("Reviewer", { email: "reviewer@example.com" } as any);
  expect((await del(reviewer, { confirmEmail: "reviewer@example.com" })).status).toBe(403);

  for (const id of [viaUserRoles, viaClaim, reviewer]) { expect(await fenced(id)).toBe(false); expect(await receipts(id)).toHaveLength(0); }
});

test("D9: the email is matched via their sign-in user; a Sign in with Apple user gets the Apple grant recorded as skipped", async () => {
  const id = await seedAthlete("Apple Signin", { auth_id: "uid-apple" } as any);   // no email on the athlete row
  await seedUser("uid-apple", "Apple.Person@privaterelay.example.com");
  fbUsers.set("uid-apple", { providerData: [{ providerId: "apple.com" }] });
  const r = await del(id, { confirmEmail: "apple.person@privaterelay.example.com" });
  expect(r.status).toBe(202);
  expect(await fenced(id)).toBe(true);
  expect(revokeApple).not.toHaveBeenCalled();
  expect(await appleItems(r.json.receipt_id)).toEqual([{ system: "provider_grants", ref: "apple_sign_in", status: "skipped", outcome: "apple_no_code_admin_request", attempts: 0 }]);
});

test("D10: their Firebase user cannot be read → 503, nothing deleted", async () => {
  const id = await seedAthlete("Lookup Fails", { email: "lookup@example.com", auth_id: "uid-lookup" } as any);
  fbUsers.set("uid-lookup", "throw");
  const r = await del(id, { confirmEmail: "lookup@example.com" });
  expect(r.status).toBe(503);
  expect(r.json.code).toBe("SIGN_IN_LOOKUP_FAILED");
  expect(await fenced(id)).toBe(false);
  expect(await receipts(id)).toHaveLength(0);
});
