/**
 * state.test.ts — Phase A Step 3a: verificationStateFor equals the legacy expressions on a roster (plan §4).
 */
jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.setTimeout(180_000);

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../../testUtils/pgliteDb";
import { athletes, socialIdentities } from "../../../../shared/schema";
import { verificationStateFor, verificationStatesFor } from "./state";
import { ensureUser, insertSelfMembership } from "./users";
import { claimAccountOwnership } from "./ownership";

beforeAll(async () => { await initTestDb(); });
afterAll(async () => { await closeTestDb(); });

it("legacy expressions hold: identityResolved = claimed_at || auth_id; hasIdentitySignal = that || connected — for every roster shape", async () => {
  const raw = await seedAthlete("Raw");
  const auth = await seedAthlete("Auth only"); await db.update(athletes).set({ auth_id: "st-1", auth_provider: "firebase" }).where(eq(athletes.id, auth));
  const claimed = await seedAthlete("Claimed only"); await db.update(athletes).set({ claimed_at: new Date() }).where(eq(athletes.id, claimed));
  const connectedOnly = await seedAthlete("Connected only"); await seedConnection({ athleteId: connectedOnly, platform: "instagram" });
  const pendingOnly = await seedAthlete("Pending only"); await seedConnection({ athleteId: pendingOnly, platform: "instagram", status: "pending" });
  const states = await verificationStatesFor([raw, auth, claimed, connectedOnly, pendingOnly]);
  expect(states.get(raw)).toMatchObject({ selfMember: null, authProjection: false, claimedAt: null, connected: false, identityResolved: false, hasIdentitySignal: false, verifiedEmail: false, ownedAccounts: [], contestedAccounts: [] });
  expect(states.get(auth)).toMatchObject({ authProjection: true, identityResolved: true, hasIdentitySignal: true, connected: false });
  expect(states.get(claimed)).toMatchObject({ authProjection: false, identityResolved: true, hasIdentitySignal: true });
  expect(states.get(connectedOnly)).toMatchObject({ connected: true, identityResolved: false, hasIdentitySignal: true });
  expect(states.get(pendingOnly)).toMatchObject({ connected: false, identityResolved: false, hasIdentitySignal: false });
  expect(await verificationStateFor("00000000-0000-0000-0000-000000000000")).toBeNull();
});

it("a self-membership alone resolves identity (no projection needed); verified email comes from the user; owned vs contested accounts", async () => {
  const a = await seedAthlete("Member A"); const b = await seedAthlete("Member B");
  const ua = await ensureUser({ uid: "st-a", email: "a@example.com", emailVerified: true }); const ub = await ensureUser({ uid: "st-b" });
  await insertSelfMembership({ athleteId: a, userId: ua.id, proof: "verified_unique_email" });
  await insertSelfMembership({ athleteId: b, userId: ub.id, proof: "existing_auth" });
  await claimAccountOwnership({ athleteId: a, platform: "instagram", accountId: "S-1", accountIdKind: "platform_id", handle: "a", canonicalUrl: null, sourceClass: "connected_verified", sourceMethod: "oauth", byUserId: ua.id });
  await claimAccountOwnership({ athleteId: b, platform: "instagram", accountId: "S-1", accountIdKind: "platform_id", handle: "b", canonicalUrl: null, sourceClass: "connected_verified", sourceMethod: "oauth", byUserId: ub.id });
  const sa = (await verificationStateFor(a))!; const sb = (await verificationStateFor(b))!;
  expect(sa).toMatchObject({ selfMember: ua.id, authProjection: false, identityResolved: true, hasIdentitySignal: true, verifiedEmail: true });
  expect(sa.ownedAccounts.map((x) => x.accountId)).toEqual(["S-1"]); expect(sa.contestedAccounts).toEqual([]);
  expect(sb).toMatchObject({ selfMember: ub.id, verifiedEmail: false, identityResolved: true });
  expect(sb.ownedAccounts).toEqual([]); expect(sb.contestedAccounts.map((x) => x.accountId)).toEqual(["S-1"]);
  expect(sb.contestedAccounts[0].byUserId).toBe(ub.id);
  // a non-connected identity is never listed as owned
  await db.insert(socialIdentities).values({ athlete_id: a, platform: "tiktok", account_id: "pub", account_id_kind: "platform_id", handle: "a", source_class: "platform_public", source_method: "x", confidence: "0.7", status: "active" });
  expect((await verificationStateFor(a))!.ownedAccounts.length).toBe(1);
});
