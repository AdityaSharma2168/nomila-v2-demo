/**
 * users.test.ts — Phase A Step 3a: users, memberships, roles (plan §4).
 */
jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.setTimeout(180_000);

import { and, eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../../testUtils/pgliteDb";
import { athleteUsers, userRoles, users } from "../../../../shared/schema";
import { ensureUser, findUserByUid, grandfatherMembership, insertSelfMembership, membershipsForUser, providerOf, rolesForUser, selfMembershipFor, selfUserOf, SelfMembershipTaken } from "./users";

beforeAll(async () => { await initTestDb(); });
afterAll(async () => { await closeTestDb(); });

describe("providerOf", () => {
  it("microsoft:<id> ⇒ microsoft; anything else ⇒ firebase", () => {
    expect(providerOf("microsoft:abc")).toBe("microsoft");
    expect(providerOf("abc")).toBe("firebase");
    expect(providerOf("microsoftabc")).toBe("firebase");
  });
});

describe("ensureUser", () => {
  it("upserts on (provider, provider_uid); a verified email is recorded and never downgraded; display name fills once", async () => {
    const a = await ensureUser({ uid: "u-1", email: "a@example.com", emailVerified: false, displayName: "A One" });
    expect(a).toMatchObject({ provider: "firebase", providerUid: "u-1", email: "a@example.com", emailVerified: false });
    const b = await ensureUser({ uid: "u-1", email: "a@example.com", emailVerified: true, displayName: "Other" });
    expect(b.id).toBe(a.id); expect(b.emailVerified).toBe(true);
    const c = await ensureUser({ uid: "u-1", emailVerified: false });
    expect(c.emailVerified).toBe(true);
    const [row] = await db.select().from(users).where(eq(users.id, a.id));
    expect(row.display_name).toBe("A One"); expect(row.last_seen_at).not.toBeNull();
    expect((await db.select().from(users).where(and(eq(users.provider, "firebase"), eq(users.provider_uid, "u-1")))).length).toBe(1);
    expect((await findUserByUid("u-1"))?.id).toBe(a.id);
    expect(await findUserByUid("nope")).toBeNull();
  });
  it("a Microsoft uid lands on provider microsoft", async () => {
    const m = await ensureUser({ uid: "microsoft:42", email: "m@example.com" });
    expect(m.provider).toBe("microsoft");
  });
});

describe("insertSelfMembership", () => {
  it("one active self per athlete: the second user throws SelfMembershipTaken; the same user is idempotent (not re-dated)", async () => {
    const athleteId = await seedAthlete("Self One");
    const u1 = await ensureUser({ uid: "self-1" }); const u2 = await ensureUser({ uid: "self-2" });
    const first = await insertSelfMembership({ athleteId, userId: u1.id, proof: "verified_unique_email", establishedAt: new Date("2026-01-01T00:00:00Z") });
    await expect(insertSelfMembership({ athleteId, userId: u2.id, proof: "human_confirmation" })).rejects.toBeInstanceOf(SelfMembershipTaken);
    const again = await insertSelfMembership({ athleteId, userId: u1.id, proof: "human_confirmation" });
    expect(again.id).toBe(first.id); expect(again.establishedAt.toISOString()).toBe("2026-01-01T00:00:00.000Z"); expect(again.proof).toBe("verified_unique_email");
    expect((await db.select().from(athleteUsers).where(eq(athleteUsers.athlete_id, athleteId))).length).toBe(1);
    expect((await selfMembershipFor(athleteId))?.userId).toBe(u1.id);
    expect(await selfUserOf(athleteId)).toBe(u1.id);
    expect((await membershipsForUser(u1.id)).map((m) => m.athleteId)).toEqual([athleteId]);
    expect(await membershipsForUser(u2.id)).toEqual([]);
  });
  it("the partial unique index is the guard: a raw concurrent insert is refused by Postgres, not by the pre-check", async () => {
    const athleteId = await seedAthlete("Self Two");
    const u1 = await ensureUser({ uid: "raw-1" }); const u2 = await ensureUser({ uid: "raw-2" });
    await db.insert(athleteUsers).values({ athlete_id: athleteId, user_id: u1.id, relation: "self", proof: "existing_auth" });
    await expect(db.insert(athleteUsers).values({ athlete_id: athleteId, user_id: u2.id, relation: "self", proof: "existing_auth" })).rejects.toThrow(/athlete_users_one_self_uq|duplicate key/);
  });
  it("a revoked membership frees the athlete for a new self", async () => {
    const athleteId = await seedAthlete("Self Three");
    const u1 = await ensureUser({ uid: "rev-1" }); const u2 = await ensureUser({ uid: "rev-2" });
    await insertSelfMembership({ athleteId, userId: u1.id, proof: "existing_auth" });
    await db.update(athleteUsers).set({ revoked_at: new Date(), revoked_reason: "test" }).where(eq(athleteUsers.athlete_id, athleteId));
    const m = await insertSelfMembership({ athleteId, userId: u2.id, proof: "existing_auth" });
    expect(m.userId).toBe(u2.id);
    expect((await membershipsForUser(u1.id)).length).toBe(0);
  });
});

describe("grandfatherMembership", () => {
  it("writes user + self membership (existing_auth, legacy note) + role; idempotent; never throws", async () => {
    const athleteId = await seedAthlete("Legacy One");
    const m = await grandfatherMembership({ athleteId, uid: "legacy-1", email: "l@example.com", displayName: "Legacy One", note: "legacy_path:signup_create", role: "athlete" });
    expect(m).toMatchObject({ proof: "existing_auth", note: "legacy_path:signup_create" });
    const again = await grandfatherMembership({ athleteId, uid: "legacy-1", note: "legacy_path:signup_create", role: "athlete" });
    expect(again?.id).toBe(m!.id);
    const u = await findUserByUid("legacy-1");
    expect(u?.emailVerified).toBe(false);
    expect(await rolesForUser(u!.id)).toEqual(["athlete"]);
    expect((await db.select().from(userRoles).where(eq(userRoles.user_id, u!.id))).length).toBe(1);
    // another uid on the same athlete: refused silently (null), the first membership stands
    const other = await grandfatherMembership({ athleteId, uid: "legacy-2", note: "legacy_path:signup_email" });
    expect(other).toBeNull();
    expect((await selfMembershipFor(athleteId))?.userId).toBe(u!.id);
  });
});
