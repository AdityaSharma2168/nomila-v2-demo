/**
 * auth.membership.test.ts — Phase A Step 3a: requireAuth / requireAdmin behind IDENTITY_MEMBERSHIP_READ
 * (design §3.2 selection rule; plan §3).
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
const logInfo = jest.fn();
jest.mock("../logger", () => ({ createLogger: () => ({ info: (...a: unknown[]) => logInfo(...a), warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("firebase-admin/app", () => ({ initializeApp: () => ({}), getApps: () => [] }));
const verifyIdToken = jest.fn();
jest.mock("firebase-admin/auth", () => ({ getAuth: () => ({ getUser: async () => ({ disabled: false }),  // lib/auth's revocation check: never revoked here
    verifyIdToken: (t: string) => verifyIdToken(t) }) }));
jest.setTimeout(180_000);

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { accountRoles, athletes, users } from "../../shared/schema";
import { requireAdmin, requireAuth } from "./auth";
import { ensureUser, insertSelfMembership } from "../services/intelligence/identity/users";
import { userRoles } from "../../shared/schema";

const ids: Record<string, string> = {};
let selectSpy: jest.SpyInstance;

beforeAll(async () => {
  await initTestDb();
  // legacy-only: auth_id projection, no user row
  ids.legacy = await seedAthlete("Legacy"); await db.update(athletes).set({ auth_id: "uid-legacy" }).where(eq(athletes.id, ids.legacy));
  // one membership (and the projection): the normal post-backfill shape
  ids.one = await seedAthlete("One"); await db.update(athletes).set({ auth_id: "uid-one" }).where(eq(athletes.id, ids.one));
  const uOne = await ensureUser({ uid: "uid-one" }); await insertSelfMembership({ athleteId: ids.one, userId: uOne.id, proof: "existing_auth" });
  await db.insert(userRoles).values({ user_id: uOne.id, role: "athlete" });
  // two memberships for one user
  ids.twoA = await seedAthlete("Two A"); ids.twoB = await seedAthlete("Two B"); await db.update(athletes).set({ auth_id: "uid-two" }).where(eq(athletes.id, ids.twoA));
  const uTwo = await ensureUser({ uid: "uid-two" });
  await insertSelfMembership({ athleteId: ids.twoA, userId: uTwo.id, proof: "existing_auth" }); await insertSelfMembership({ athleteId: ids.twoB, userId: uTwo.id, proof: "human_confirmation" });
  // user with no memberships
  await ensureUser({ uid: "uid-none" });
  // membership disagrees with the projection (the read path must follow the membership)
  ids.disA = await seedAthlete("Dis A"); ids.disB = await seedAthlete("Dis B"); await db.update(athletes).set({ auth_id: "uid-dis" }).where(eq(athletes.id, ids.disA));
  const uDis = await ensureUser({ uid: "uid-dis" }); await insertSelfMembership({ athleteId: ids.disB, userId: uDis.id, proof: "existing_auth" });
  // admin via user_roles only
  ids.adm = await seedAthlete("Adm"); await db.update(athletes).set({ auth_id: "uid-adm" }).where(eq(athletes.id, ids.adm));
  const uAdm = await ensureUser({ uid: "uid-adm" }); await insertSelfMembership({ athleteId: ids.adm, userId: uAdm.id, proof: "existing_auth" }); await db.insert(userRoles).values({ user_id: uAdm.id, role: "admin" });
  await db.insert(accountRoles).values({ account_id: ids.legacy, role: "admin" });
});
afterAll(async () => { await closeTestDb(); });
beforeEach(() => { verifyIdToken.mockReset(); logInfo.mockReset(); delete process.env.IDENTITY_MEMBERSHIP_READ; });

const run = async (mw: typeof requireAuth, uid: string, headers: Record<string, string> = {}, tokenRoles?: string[]) => {
  verifyIdToken.mockResolvedValue({ uid, ...(tokenRoles ? { roles: tokenRoles } : {}) });
  const req: any = { headers: { authorization: "Bearer tok", ...headers } };
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await mw(req, res, next);
  return { req, res, next };
};
const usersReads = () => selectSpy.mock.calls.length;

describe("flag off (both environments today)", () => {
  it("resolves by athletes.auth_id byte for byte, never reads users, sets no req.userId", async () => {
    selectSpy = jest.spyOn(db, "select");
    const { req, next } = await run(requireAuth, "uid-legacy");
    expect(next).toHaveBeenCalled(); expect(req.athleteId).toBe(ids.legacy); expect(req.userId).toBeUndefined(); expect(req.roles).toEqual([]);
    // one select: the athletes lookup
    expect(usersReads()).toBe(1);
    selectSpy.mockRestore();
    // an athlete that has a membership but the projection answers first — identical outcome
    const r2 = await run(requireAuth, "uid-one");
    expect(r2.req.athleteId).toBe(ids.one); expect(r2.req.userId).toBeUndefined();
    // unknown uid ⇒ 401 exactly as before
    const r3 = await run(requireAuth, "uid-unknown");
    expect(r3.res.status).toHaveBeenCalledWith(401); expect(r3.next).not.toHaveBeenCalled();
    // membership-only (no projection) is NOT found with the flag off
    const r4 = await run(requireAuth, "uid-two");   // twoA has the projection
    expect(r4.req.athleteId).toBe(ids.twoA);
  });
  it("requireAdmin: roles = token ∪ account_roles; user_roles are NOT consulted", async () => {
    const r = await run(requireAdmin, "uid-legacy");
    expect(r.next).toHaveBeenCalled(); expect(r.req.roles).toEqual(["admin"]);
    const r2 = await run(requireAdmin, "uid-adm");   // admin only in user_roles
    expect(r2.res.status).toHaveBeenCalledWith(403);
    const r3 = await run(requireAdmin, "uid-one", {}, ["admin"]);
    expect(r3.next).toHaveBeenCalled(); expect(r3.req.roles).toEqual(["admin"]);   // uid-one's athlete role lives in user_roles only — not consulted with the flag off
  });
});

describe("read on", () => {
  beforeEach(() => { process.env.IDENTITY_MEMBERSHIP_READ = "true"; });
  it("0 memberships ⇒ 401 (a user row alone is not an athlete; a projection alone is not consulted)", async () => {
    expect((await run(requireAuth, "uid-none")).res.status).toHaveBeenCalledWith(401);
    expect((await run(requireAuth, "uid-legacy")).res.status).toHaveBeenCalledWith(401);
    expect((await run(requireAuth, "uid-unknown")).res.status).toHaveBeenCalledWith(401);
  });
  it("exactly 1 ⇒ auto-selected; req.userId set; roles = token ∪ user_roles", async () => {
    const r = await run(requireAuth, "uid-one", {}, ["fan"]);
    expect(r.next).toHaveBeenCalled(); expect(r.req.athleteId).toBe(ids.one);
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.provider_uid, "uid-one"));
    expect(r.req.userId).toBe(u.id); expect(r.req.roles!.sort()).toEqual(["athlete", "fan"]);
  });
  it("2 memberships ⇒ 409 athlete_selection_required with the held ids, never the first row", async () => {
    const r = await run(requireAuth, "uid-two");
    expect(r.res.status).toHaveBeenCalledWith(409);
    expect(r.res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "athlete_selection_required", athletes: expect.arrayContaining([ids.twoA, ids.twoB]) }));
    expect(r.res.json.mock.calls[0][0].profiles.map((p: any) => p.athleteId).sort()).toEqual([ids.twoA, ids.twoB].sort());   // 3b: names ride along for the chooser
    expect(r.next).not.toHaveBeenCalled(); expect(r.req.athleteId).toBeUndefined();
  });
  it("X-Athlete-Id selects a held athlete; a foreign one is 403", async () => {
    const r = await run(requireAuth, "uid-two", { "x-athlete-id": ids.twoB });
    expect(r.next).toHaveBeenCalled(); expect(r.req.athleteId).toBe(ids.twoB);
    const f = await run(requireAuth, "uid-two", { "x-athlete-id": ids.one });
    expect(f.res.status).toHaveBeenCalledWith(403); expect(f.res.json).toHaveBeenCalledWith({ error: "athlete_not_held", athleteId: ids.one });
    // with one membership a matching header is fine and a foreign one still 403
    expect((await run(requireAuth, "uid-one", { "x-athlete-id": ids.one })).req.athleteId).toBe(ids.one);
    expect((await run(requireAuth, "uid-one", { "x-athlete-id": ids.twoA })).res.status).toHaveBeenCalledWith(403);
  });
  it("the membership decides, not the projection: uid-dis resolves to Dis B", async () => {
    const r = await run(requireAuth, "uid-dis");
    expect(r.req.athleteId).toBe(ids.disB);
  });
  it("requireAdmin: roles = token ∪ account_roles ∪ user_roles; a selection error is not fatal", async () => {
    const a = await run(requireAdmin, "uid-adm");
    expect(a.next).toHaveBeenCalled(); expect(a.req.roles).toContain("admin"); expect(a.req.athleteId).toBe(ids.adm); expect(a.req.userId).toBeDefined();
    const l = await run(requireAdmin, "uid-legacy");   // account_roles admin, no user row
    expect(l.next).toHaveBeenCalled(); expect(l.req.athleteId).toBe(ids.legacy);
    const two = await run(requireAdmin, "uid-two", {}, ["admin"]);   // 409 shape on requireAuth, but admin passes with the token role
    expect(two.next).toHaveBeenCalled();
    const denied = await run(requireAdmin, "uid-one");
    expect(denied.res.status).toHaveBeenCalledWith(403);
  });
});

describe("no open-access switch (ADMIN_OPEN_ACCESS deleted 2 Nov 2026)", () => {
  afterEach(() => { delete process.env.ADMIN_OPEN_ACCESS; });
  it("a non-admin is 403 whatever the environment says, and no server code reads the old switch", async () => {
    process.env.ADMIN_OPEN_ACCESS = "true";
    const denied = await run(requireAdmin, "uid-one");
    expect(denied.res.status).toHaveBeenCalledWith(403); expect(denied.next).not.toHaveBeenCalled();
    const { execFileSync } = await import("node:child_process");
    let hits = "";
    try { hits = execFileSync("git", ["grep", "-l", "-E", "env(\\.|\\[\")ADMIN_OPEN_ACCESS", "--", "server", ":!*.test.ts"], { encoding: "utf8" }).trim(); }
    catch (err: any) { if (err.status !== 1) throw err; }   // git grep exits 1 when nothing matches
    expect(hits).toBe("");
  });
});
