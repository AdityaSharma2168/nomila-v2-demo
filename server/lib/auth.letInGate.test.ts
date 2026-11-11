/**
 * auth.letInGate.test.ts — launch board f14 through the real requireAuth: a waitlisted athlete gets 403 not_let_in on an
 * app-only path and passes on a waitlist path; let-in and older accounts are unchanged; the membership read path
 * (IDENTITY_MEMBERSHIP_READ) applies the same gate.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("firebase-admin/app", () => ({ initializeApp: () => ({}), getApps: () => [] }));
const verifyIdToken = jest.fn();
jest.mock("firebase-admin/auth", () => ({ getAuth: () => ({ getUser: async () => ({ disabled: false }), verifyIdToken: (t: string) => verifyIdToken(t) }) }));
jest.setTimeout(180_000);

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { athletes } from "../../shared/schema";
import { requireAuth } from "./auth";
import { ensureUser, insertSelfMembership } from "../services/intelligence/identity/users";

const ids: Record<string, string> = {};

beforeAll(async () => {
  await initTestDb();
  ids.wait = await seedAthlete("Waiting"); await db.update(athletes).set({ auth_id: "uid-wait", status: "waitlisted" }).where(eq(athletes.id, ids.wait));
  ids.active = await seedAthlete("Let In"); await db.update(athletes).set({ auth_id: "uid-active", status: "active" }).where(eq(athletes.id, ids.active));
  ids.raw = await seedAthlete("Older"); await db.update(athletes).set({ auth_id: "uid-raw", status: "raw" }).where(eq(athletes.id, ids.raw));
  const u = await ensureUser({ uid: "uid-wait" }); await insertSelfMembership({ athleteId: ids.wait, userId: u.id, proof: "existing_auth" });
});
afterAll(async () => { await closeTestDb(); });
beforeEach(() => { verifyIdToken.mockReset(); delete process.env.IDENTITY_MEMBERSHIP_READ; delete process.env.WAITLIST_API_GATE; });

const call = async (uid: string, path: string, tokenRoles?: string[]) => {
  verifyIdToken.mockResolvedValue({ uid, ...(tokenRoles ? { roles: tokenRoles } : {}) });
  const req: any = { headers: { authorization: "Bearer tok" }, originalUrl: path };
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await requireAuth(req, res, next);
  return { res, next };
};

it("waitlisted: app-only path refused with 403 not_let_in", async () => {
  const { res, next } = await call("uid-wait", "/api/v1/me/chat");
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.json).toHaveBeenCalledWith({ error: "not_let_in" });
});

it("waitlisted: the waitlist's own paths pass", async () => {
  for (const p of ["/api/v1/waitlist/progress", "/api/v1/me/connections", "/api/v1/me/account", "/api/v1/me/connect/instagram"]) {
    const { next } = await call("uid-wait", p);
    expect(next).toHaveBeenCalled();
  }
});

it("let-in, older accounts and admins pass everywhere", async () => {
  expect((await call("uid-active", "/api/v1/me/chat")).next).toHaveBeenCalled();
  expect((await call("uid-raw", "/api/v1/me/chat")).next).toHaveBeenCalled();
  expect((await call("uid-wait", "/api/v1/me/chat", ["athlete", "admin"])).next).toHaveBeenCalled();
});

it("WAITLIST_API_GATE=false lets a waitlisted athlete through", async () => {
  process.env.WAITLIST_API_GATE = "false";
  expect((await call("uid-wait", "/api/v1/me/chat")).next).toHaveBeenCalled();
});

it("an account being deleted (account deletion phase 1) is refused with 410 on every path, on both read paths", async () => {
  const id = await seedAthlete("Leaving");
  await db.update(athletes).set({ auth_id: "uid-leaving", status: "active", deletion_requested_at: new Date() }).where(eq(athletes.id, id));
  const u = await ensureUser({ uid: "uid-leaving" }); await insertSelfMembership({ athleteId: id, userId: u.id, proof: "existing_auth" });
  for (const p of ["/api/v1/me/chat", "/api/v1/me/account", "/api/v1/waitlist/progress"]) {
    const { res, next } = await call("uid-leaving", p);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.json).toHaveBeenCalledWith({ error: "account_deleting" });
  }
  process.env.IDENTITY_MEMBERSHIP_READ = "true";
  const viaMembership = await call("uid-leaving", "/api/v1/me/chat");
  expect(viaMembership.next).not.toHaveBeenCalled();
  expect(viaMembership.res.status).toHaveBeenCalledWith(410);
});

it("the membership read path applies the same gate", async () => {
  process.env.IDENTITY_MEMBERSHIP_READ = "true";
  const refused = await call("uid-wait", "/api/v1/me/brand-book");
  expect(refused.res.status).toHaveBeenCalledWith(403);
  expect((await call("uid-wait", "/api/v1/waitlist/rank")).next).toHaveBeenCalled();
});
