/**
 * ownership.test.ts — Phase A Step 3a §3a-C: one active canonical owner per account; the collision branch; the
 * savepoint recovery on a mid-flight 23505; repeat; release (plan §4, tests table).
 */
jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.setTimeout(180_000);

import { and, eq, sql } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../../testUtils/pgliteDb";
import { connectedAccounts, identityClaims, socialIdentities } from "../../../../shared/schema";
import { claimAccountOwnership } from "./ownership";
import { ensureIdentity } from "../social/ingest";
import { ensureUser, insertSelfMembership } from "./users";

beforeAll(async () => { await initTestDb(); });
afterAll(async () => { await closeTestDb(); });

const activeOwners = async (platform: string, accountId: string) =>
  db.select({ athleteId: socialIdentities.athlete_id }).from(socialIdentities).where(and(eq(socialIdentities.platform, platform), eq(socialIdentities.account_id, accountId), eq(socialIdentities.source_class, "connected_verified"), eq(socialIdentities.status, "active")));
const rowsFor = async (athleteId: string, platform: string, accountId: string) =>
  db.select().from(socialIdentities).where(and(eq(socialIdentities.athlete_id, athleteId), eq(socialIdentities.platform, platform), eq(socialIdentities.account_id, accountId)));

async function athleteWithUser(name: string, uid: string) {
  const athleteId = await seedAthlete(name);
  const user = await ensureUser({ uid });
  await insertSelfMembership({ athleteId, userId: user.id, proof: "existing_auth" });
  return { athleteId, userId: user.id };
}
const input = (athleteId: string, accountId: string, connectedAccountId: string | null, byUserId?: string | null, handle = "h") => ({
  athleteId, platform: "instagram", accountId, accountIdKind: "platform_id" as const, handle, canonicalUrl: null, sourceClass: "connected_verified" as const, sourceMethod: "oauth_instagram_login", connectedAccountId, byUserId, verifiedAt: new Date(),
});

describe("sequential", () => {
  it("A owns X; B completes OAuth for X ⇒ no throw, B's connection stays active, B's identity unverified with the collision evidence, one proposed claim against A, A untouched, one active owner", async () => {
    const A = await athleteWithUser("Owner A", "own-a"); const B = await athleteWithUser("Claimant B", "own-b");
    const connA = await seedConnection({ athleteId: A.athleteId, platform: "instagram" });
    const a = await claimAccountOwnership(input(A.athleteId, "X-1", connA, A.userId, "owner_a"));
    expect(a.outcome).toBe("owner");
    const aBefore = await rowsFor(A.athleteId, "instagram", "X-1");
    const connB = await seedConnection({ athleteId: B.athleteId, platform: "instagram" });
    const b = await claimAccountOwnership(input(B.athleteId, "X-1", connB, B.userId, "claimant_b"));
    expect(b.outcome).toBe("collision");
    if (b.outcome !== "collision") return;
    expect(b.ownerAthleteId).toBe(A.athleteId); expect(b.claimId).not.toBeNull();
    const [bRow] = await rowsFor(B.athleteId, "instagram", "X-1");
    expect(bRow).toMatchObject({ source_class: "connected_verified", status: "unverified", connected_account_id: connB });
    expect((bRow.evidence as any).ownership_collision).toMatchObject({ ownerAthleteId: A.athleteId, byUserId: B.userId, connectedAccountId: connB });
    const [conn] = await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, connB));
    expect(conn.status).toBe("active");
    const claims = await db.select().from(identityClaims).where(eq(identityClaims.user_id, B.userId));
    expect(claims.length).toBe(1);
    expect(claims[0]).toMatchObject({ athlete_id: A.athleteId, proof: "verified_social_ownership", status: "proposed", decided_by: null, match_id: null });
    expect(claims[0].note).toMatchObject({ accountId: "X-1", platform: "instagram", claimantAthleteId: B.athleteId, connectedAccountId: connB });
    expect(await rowsFor(A.athleteId, "instagram", "X-1")).toEqual(aBefore);
    expect((await activeOwners("instagram", "X-1")).map((r) => r.athleteId)).toEqual([A.athleteId]);
  });

  it("repeat: B connects X again ⇒ still one claim, last_verified_at advanced, still unverified", async () => {
    const B = (await db.select({ athlete_id: identityClaims.athlete_id, user_id: identityClaims.user_id, note: identityClaims.note }).from(identityClaims))[0];
    const claimant = (B.note as any).claimantAthleteId as string;
    const [before] = await rowsFor(claimant, "instagram", "X-1");
    await new Promise((r) => setTimeout(r, 5));
    const r = await claimAccountOwnership({ ...input(claimant, "X-1", (B.note as any).connectedAccountId, B.user_id, "claimant_b"), verifiedAt: new Date() });
    expect(r.outcome).toBe("collision");
    const [after] = await rowsFor(claimant, "instagram", "X-1");
    expect(after.status).toBe("unverified"); expect(after.last_verified_at!.getTime()).toBeGreaterThan(before.last_verified_at!.getTime());
    expect((await db.select().from(identityClaims).where(eq(identityClaims.user_id, B.user_id))).length).toBe(1);
    expect((await activeOwners("instagram", "X-1")).length).toBe(1);
  });

  it("release: after A's identity is superseded (3c), B's next claim promotes B to the active owner", async () => {
    const [claim] = await db.select().from(identityClaims);
    const claimant = (claim.note as any).claimantAthleteId as string;
    await db.update(socialIdentities).set({ status: "superseded" }).where(and(eq(socialIdentities.athlete_id, claim.athlete_id), eq(socialIdentities.account_id, "X-1")));
    const r = await claimAccountOwnership(input(claimant, "X-1", (claim.note as any).connectedAccountId, claim.user_id, "claimant_b"));
    expect(r.outcome).toBe("owner");
    expect((await activeOwners("instagram", "X-1")).map((x) => x.athleteId)).toEqual([claimant]);
    const [row] = await rowsFor(claimant, "instagram", "X-1");
    expect(row.status).toBe("active");
  });

  it("no user to attribute: the collision is recorded on the identity row only (no claim), still no throw", async () => {
    const A = await athleteWithUser("Owner C", "own-c");
    const orphan = await seedAthlete("Orphan D");   // no user, no membership
    await claimAccountOwnership(input(A.athleteId, "X-2", null, A.userId));
    const r = await claimAccountOwnership(input(orphan, "X-2", null, null));
    expect(r.outcome).toBe("collision");
    if (r.outcome === "collision") expect(r.claimId).toBeNull();
    const [row] = await rowsFor(orphan, "instagram", "X-2");
    expect(row.status).toBe("unverified");
    expect((await activeOwners("instagram", "X-2")).map((x) => x.athleteId)).toEqual([A.athleteId]);
  });
});

describe("concurrent (D-13 recovery path)", () => {
  it("a 23505 on social_identities_owner_uq after the owner read ⇒ rollback to savepoint, re-read the winner, persist the collision branch — no error surfaces, one active owner, one proposed claim", async () => {
    const C = await athleteWithUser("Racer C", "race-c"); const D = await athleteWithUser("Racer D", "race-d");
    // D's transaction reads "no owner", then C's owner row lands before D's active write ⇒ D's insert raises 23505 on
    // social_identities_owner_uq INSIDE the transaction. PGlite is one session behind a mutex, so the competing row is
    // written through the same transaction client (before the savepoint) — the failure mode is identical to a concurrent
    // commit: the active write fails, and only a real ROLLBACK TO SAVEPOINT leaves the transaction usable afterwards
    // (without one every later statement fails with "current transaction is aborted").
    const r = await claimAccountOwnership(input(D.athleteId, "Y-1", null, D.userId, "racer_d"), {
      __afterOwnerRead: async (tx) => {
        await tx.insert(socialIdentities).values({ athlete_id: C.athleteId, platform: "instagram", account_id: "Y-1", account_id_kind: "platform_id", handle: "racer_c", source_class: "connected_verified", source_method: "oauth_instagram_login", confidence: "1", status: "active", last_verified_at: new Date() });
      },
    });
    expect(r.outcome).toBe("collision");
    if (r.outcome !== "collision") return;
    expect(r.ownerAthleteId).toBe(C.athleteId); expect(r.claimId).not.toBeNull();
    expect((await activeOwners("instagram", "Y-1")).map((x) => x.athleteId)).toEqual([C.athleteId]);
    const [dRow] = await rowsFor(D.athleteId, "instagram", "Y-1");
    expect(dRow.status).toBe("unverified"); expect((dRow.evidence as any).ownership_collision.ownerAthleteId).toBe(C.athleteId);
    const claims = await db.select().from(identityClaims).where(eq(identityClaims.user_id, D.userId));
    expect(claims.length).toBe(1); expect(claims[0].athlete_id).toBe(C.athleteId);
    // the transaction stayed usable after the savepoint rollback: everything above committed in it
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(socialIdentities).where(and(eq(socialIdentities.platform, "instagram"), eq(socialIdentities.account_id, "Y-1")));
    expect(n).toBe(2);
  });

  it("two callers for a fresh account back to back ⇒ exactly one owner outcome and one collision outcome, one active row, one claim", async () => {
    const E = await athleteWithUser("Racer E", "race-e"); const F = await athleteWithUser("Racer F", "race-f");
    // PGlite runs one session: the two transactions are serialised by the driver; both must resolve, never reject
    const results = await Promise.all([claimAccountOwnership(input(E.athleteId, "Z-1", null, E.userId, "e")), claimAccountOwnership(input(F.athleteId, "Z-1", null, F.userId, "f"))]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["collision", "owner"]);
    expect((await activeOwners("instagram", "Z-1")).length).toBe(1);
    expect((await db.select().from(identityClaims).where(sql`${identityClaims.note}->>'accountId' = 'Z-1'`)).length).toBe(1);
  });

  it("the index itself refuses a second active owner written by any other path", async () => {
    const G = await seedAthlete("Raw G"); const H = await seedAthlete("Raw H");
    await db.insert(socialIdentities).values({ athlete_id: G, platform: "tiktok", account_id: "T-1", account_id_kind: "platform_id", handle: "g", source_class: "connected_verified", source_method: "x", confidence: "1", status: "active" });
    await expect(db.insert(socialIdentities).values({ athlete_id: H, platform: "tiktok", account_id: "T-1", account_id_kind: "platform_id", handle: "h", source_class: "connected_verified", source_method: "x", confidence: "1", status: "active" })).rejects.toThrow(/social_identities_owner_uq|duplicate key/);
    // a platform_public row on the same account is not an owner and is allowed
    await db.insert(socialIdentities).values({ athlete_id: H, platform: "tiktok", account_id: "T-1", account_id_kind: "platform_id", handle: "h", source_class: "platform_public", source_method: "x", confidence: "0.7", status: "active" });
  });
});

describe("ensureIdentity delegation", () => {
  it("connected_verified goes through claimAccountOwnership; other source classes keep the plain upsert (no ownership check)", async () => {
    const A = await athleteWithUser("Ingest A", "ing-a"); const B = await athleteWithUser("Ingest B", "ing-b");
    const a = await ensureIdentity({ athleteId: A.athleteId, platform: "youtube", accountId: "UC1", accountIdKind: "platform_id", handle: "a", canonicalUrl: null, sourceClass: "connected_verified", sourceMethod: "oauth", connectedAccountId: null, byUserId: A.userId });
    expect(a.status).toBe("active");
    const b = await ensureIdentity({ athleteId: B.athleteId, platform: "youtube", accountId: "UC1", accountIdKind: "platform_id", handle: "b", canonicalUrl: null, sourceClass: "connected_verified", sourceMethod: "oauth", connectedAccountId: null, byUserId: B.userId });
    expect(b.status).toBe("unverified");
    const c = await ensureIdentity({ athleteId: B.athleteId, platform: "youtube", accountId: "UC2", accountIdKind: "platform_id", handle: "b2", canonicalUrl: null, sourceClass: "platform_public", sourceMethod: "discovery", confidence: 0.7 });
    expect(c.status).toBe("active");
    // upgrade path: a platform_public row promoted by a later connected_verified ingest becomes the owner when nobody else holds it
    const d = await ensureIdentity({ athleteId: B.athleteId, platform: "youtube", accountId: "UC2", accountIdKind: "platform_id", handle: "b2", canonicalUrl: null, sourceClass: "connected_verified", sourceMethod: "oauth", byUserId: B.userId });
    expect(d).toMatchObject({ id: c.id, source_class: "connected_verified", status: "active" });
  });
});
