/**
 * link.test.ts — Phase A Step 3a: linkUserToAthlete dual-writes the membership and the projection in one transaction (plan §3).
 */
jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.setTimeout(180_000);

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../../testUtils/pgliteDb";
import { athleteUsers, athletes, users } from "../../../../shared/schema";
import { ClaimNotAuthorized, linkUserToAthlete } from "./link";
import { ensureUser, findUserByUid, insertSelfMembership, membershipsForUser, selfMembershipFor, SelfMembershipTaken } from "./users";

beforeAll(async () => { await initTestDb(); });
afterAll(async () => { await closeTestDb(); });

it("dual-write: user + self membership (proof = the claim proof) + athletes.auth_id projection, in one call", async () => {
  const athleteId = await seedAthlete("Link One");
  const r = await linkUserToAthlete(athleteId, "link-1", "firebase", "verified_unique_email", new Date("2026-02-02T00:00:00Z"), { email: "l1@example.com", emailVerified: true });
  expect(r.status).toBe("claimed");
  const u = await findUserByUid("link-1");
  expect(u).toMatchObject({ id: r.userId, emailVerified: true });
  const m = await selfMembershipFor(athleteId);
  expect(m).toMatchObject({ id: r.membershipId, userId: u!.id, proof: "verified_unique_email" });
  const [a] = await db.select({ auth_id: athletes.auth_id, provider: athletes.auth_provider, claimed: athletes.claimed_at, status: athletes.status }).from(athletes).where(eq(athletes.id, athleteId));
  expect(a).toMatchObject({ auth_id: "link-1", provider: "firebase", status: "claimed" }); expect(a.claimed).not.toBeNull();
});

it("projection == membership: the membership's user is the user whose provider_uid the projection names", async () => {
  const athleteId = await seedAthlete("Link Two");
  await linkUserToAthlete(athleteId, "microsoft:77", "microsoft", "existing_auth");
  const [a] = await db.select({ auth_id: athletes.auth_id }).from(athletes).where(eq(athletes.id, athleteId));
  const m = await selfMembershipFor(athleteId);
  const [u] = await db.select().from(users).where(eq(users.id, m!.userId));
  expect(u.provider).toBe("microsoft"); expect(u.provider_uid).toBe(a.auth_id);
});

it("refusal: a second user on a linked athlete gets ClaimNotAuthorized and NOTHING is written (no membership, no user row is required to exist)", async () => {
  const athleteId = await seedAthlete("Link Three");
  await linkUserToAthlete(athleteId, "own-1", "firebase", "verified_unique_email");
  await expect(linkUserToAthlete(athleteId, "own-2", "firebase", "verified_unique_email")).rejects.toBeInstanceOf(ClaimNotAuthorized);
  expect((await db.select().from(athleteUsers).where(eq(athleteUsers.athlete_id, athleteId))).length).toBe(1);
  expect((await selfMembershipFor(athleteId))?.userId).toBe((await findUserByUid("own-1"))!.id);
  const [a] = await db.select({ auth_id: athletes.auth_id }).from(athletes).where(eq(athletes.id, athleteId));
  expect(a.auth_id).toBe("own-1");
});

it("proof 'none' or a non-linking proof never links", async () => {
  const athleteId = await seedAthlete("Link Four");
  await expect(linkUserToAthlete(athleteId, "x", "firebase", "none")).rejects.toBeInstanceOf(ClaimNotAuthorized);
  await expect(linkUserToAthlete(athleteId, "x", "firebase", "human_confirmation")).rejects.toBeInstanceOf(ClaimNotAuthorized);   // 3b: a click alone never links a pre-existing row (D-14)
  expect(await selfMembershipFor(athleteId)).toBeNull();
});

it("idempotency: the same user linking twice keeps one membership and one projection", async () => {
  const athleteId = await seedAthlete("Link Five");
  const a = await linkUserToAthlete(athleteId, "same-1", "firebase", "existing_auth");
  const b = await linkUserToAthlete(athleteId, "same-1", "firebase", "existing_auth");
  expect(b.userId).toBe(a.userId); expect(b.membershipId).toBe(a.membershipId);
  expect((await membershipsForUser(a.userId)).length).toBe(1);
});

it("a pre-0051 projection naming another uid (no membership yet) refuses and rolls the new membership back", async () => {
  const athleteId = await seedAthlete("Link Six");
  await db.update(athletes).set({ auth_id: "pre-0051", auth_provider: "firebase" }).where(eq(athletes.id, athleteId));
  await expect(linkUserToAthlete(athleteId, "newcomer", "firebase", "verified_unique_email")).rejects.toBeInstanceOf(ClaimNotAuthorized);
  expect((await db.select().from(athleteUsers).where(eq(athleteUsers.athlete_id, athleteId))).length).toBe(0);
  const [a] = await db.select({ auth_id: athletes.auth_id }).from(athletes).where(eq(athletes.id, athleteId));
  expect(a.auth_id).toBe("pre-0051");
});

it("concurrency: two users claiming one athlete at once ⇒ exactly one membership, one ClaimNotAuthorized", async () => {
  const athleteId = await seedAthlete("Link Seven");
  const results = await Promise.allSettled([linkUserToAthlete(athleteId, "race-a", "firebase", "verified_unique_email"), linkUserToAthlete(athleteId, "race-b", "firebase", "verified_unique_email")]);
  const ok = results.filter((r) => r.status === "fulfilled"); const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  expect(ok.length).toBe(1); expect(failed.length).toBe(1); expect(failed[0].reason).toBeInstanceOf(ClaimNotAuthorized);
  expect((await db.select().from(athleteUsers).where(eq(athleteUsers.athlete_id, athleteId))).length).toBe(1);
});

describe("membership race: a 23505 AFTER the pre-read (review of PR #426)", () => {
  // PGlite is one session behind a mutex, so a second connection cannot race the transaction; the competing self-membership
  // is written through the transaction client after the pre-read instead. The guarded INSERT then raises the 23505
  // mid-flight exactly as a concurrent commit would. In PostgreSQL a statement error aborts the transaction until a
  // ROLLBACK (TO SAVEPOINT): every assertion below that runs a statement afterwards in the same transaction holds only
  // because the INSERT ran in a real savepoint.
  it("insertSelfMembership: loser ⇒ SelfMembershipTaken, one membership, projection to the winner, and the outer transaction keeps working", async () => {
    const athleteId = await seedAthlete("Race Eight");
    const winner = await ensureUser({ uid: "sp-winner" }); const loser = await ensureUser({ uid: "sp-loser" });
    const committed = await db.transaction(async (tx) => {
      let caught: unknown = null;
      try {
        await insertSelfMembership({ athleteId, userId: loser.id, proof: "verified_unique_email" }, tx as any, {   // PGlite tx type vs the node-pg client type
          __afterPreRead: async (c) => {
            await c.insert(athleteUsers).values({ athlete_id: athleteId, user_id: winner.id, relation: "self", proof: "verified_unique_email" });
            await c.update(athletes).set({ auth_id: "sp-winner", auth_provider: "firebase" }).where(eq(athletes.id, athleteId));
          },
        });
      } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(SelfMembershipTaken);
      // the transaction is NOT aborted: further statements succeed (impossible without the savepoint rollback)
      const rows = await tx.select().from(athleteUsers).where(eq(athleteUsers.athlete_id, athleteId));
      expect(rows.length).toBe(1); expect(rows[0].user_id).toBe(winner.id);
      const [a] = await tx.update(athletes).set({ status: "claimed" }).where(eq(athletes.id, athleteId)).returning({ auth_id: athletes.auth_id, status: athletes.status });
      expect(a).toEqual({ auth_id: "sp-winner", status: "claimed" });
      return rows.length;
    });
    expect(committed).toBe(1);
    expect((await selfMembershipFor(athleteId))?.userId).toBe(winner.id);
    expect((await membershipsForUser(loser.id)).length).toBe(0);
    const [after] = await db.select({ auth_id: athletes.auth_id }).from(athletes).where(eq(athletes.id, athleteId));
    expect(after.auth_id).toBe("sp-winner");
  });

  it("insertSelfMembership: the same user racing itself is idempotent after the 23505 (returns the winning row)", async () => {
    const athleteId = await seedAthlete("Race Nine");
    const u = await ensureUser({ uid: "sp-same" });
    const m = await db.transaction(async (tx) => insertSelfMembership({ athleteId, userId: u.id, proof: "existing_auth" }, tx as any, {
      __afterPreRead: async (c) => { await c.insert(athleteUsers).values({ athlete_id: athleteId, user_id: u.id, relation: "self", proof: "human_confirmation", note: "raced" }); },
    }));
    expect(m).toMatchObject({ userId: u.id, proof: "human_confirmation", note: "raced" });
    expect((await db.select().from(athleteUsers).where(eq(athleteUsers.athlete_id, athleteId))).length).toBe(1);
  });

  it("linkUserToAthlete: the loser gets ClaimNotAuthorized (not 'transaction is aborted'), and its whole transaction rolls back", async () => {
    const athleteId = await seedAthlete("Race Ten");
    const winner = await ensureUser({ uid: "sp-link-winner" });
    let caught: unknown = null;
    try {
      await linkUserToAthlete(athleteId, "sp-link-loser", "firebase", "verified_unique_email", new Date(), {
        __afterPreRead: async (c) => { await c.insert(athleteUsers).values({ athlete_id: athleteId, user_id: winner.id, relation: "self", proof: "verified_unique_email" }); },
      });
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(ClaimNotAuthorized);
    expect(String((caught as Error).message)).not.toMatch(/aborted/i);
    // the loser's transaction (including the winner row the hook wrote inside it) is gone; the loser's user was never kept
    expect((await db.select().from(athleteUsers).where(eq(athleteUsers.athlete_id, athleteId))).length).toBe(0);
    expect(await findUserByUid("sp-link-loser")).toBeNull();
    const [a] = await db.select({ auth_id: athletes.auth_id }).from(athletes).where(eq(athletes.id, athleteId));
    expect(a.auth_id).toBeNull();
    // and the athlete is still claimable by the winner afterwards
    const r = await linkUserToAthlete(athleteId, "sp-link-winner", "firebase", "verified_unique_email");
    expect(r.userId).toBe(winner.id);
  });
});

describe("3b: the human_confirmation guard (D-14) and the tx option", () => {
  it("human_confirmation never links a pre-existing row on its own; createdInFlow links the row created in the same transaction", async () => {
    const existing = await seedAthlete("Guard One");
    await expect(linkUserToAthlete(existing, "hc-1", "firebase", "human_confirmation")).rejects.toBeInstanceOf(ClaimNotAuthorized);
    await expect(linkUserToAthlete(existing, "hc-1", "firebase", "human_confirmation", new Date(), { claimId: "00000000-0000-0000-0000-000000000000" })).rejects.toBeInstanceOf(ClaimNotAuthorized);
    expect(await selfMembershipFor(existing)).toBeNull(); expect(await findUserByUid("hc-1")).toBeNull();
    const made = await db.transaction(async (tx) => {
      const [row] = await tx.insert(athletes).values({ full_name: "Guard Created", auth_id: "hc-2", auth_provider: "firebase" } as any).returning({ id: athletes.id });
      const link = await linkUserToAthlete(row.id, "hc-2", "firebase", "human_confirmation", new Date(), { tx: tx as any, createdInFlow: true, note: "created:test" });
      return { id: row.id, ...link };
    });
    expect((await selfMembershipFor(made.id))).toMatchObject({ userId: made.userId, proof: "human_confirmation", note: "created:test" });
  });
  it("verified_social_ownership now links (D-4)", async () => {
    const row = await seedAthlete("Guard Owner");
    const r = await linkUserToAthlete(row, "vso-1", "firebase", "verified_social_ownership");
    expect((await selfMembershipFor(row))).toMatchObject({ userId: r.userId, proof: "verified_social_ownership" });
  });
});
