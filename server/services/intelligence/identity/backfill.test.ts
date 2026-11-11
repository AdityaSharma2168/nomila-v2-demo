/**
 * backfill.test.ts — Phase A Step 3a: the pure planner (plan §2) — pre-flight findings, idempotency, revert shape.
 */
import { planIdentityBackfill, hasBlockers, type BackfillInput } from "./backfill";

const d = (s: string) => new Date(s);
const base = (): BackfillInput => ({
  athletes: [
    { id: "a1", auth_id: "uid-1", auth_provider: "firebase", email: "1@x", full_name: "One", claimed_at: d("2026-01-05T00:00:00Z"), created_at: d("2026-01-01T00:00:00Z") },
    { id: "a2", auth_id: "microsoft:2", auth_provider: "microsoft", email: null, full_name: "Two", claimed_at: null, created_at: d("2026-02-01T00:00:00Z") },
    { id: "a3", auth_id: null, auth_provider: null, email: "3@x", full_name: "Three", claimed_at: null, created_at: d("2026-03-01T00:00:00Z") },
  ],
  roles: [{ account_id: "a1", role: "athlete" }, { account_id: "a1", role: "admin" }, { account_id: "a3", role: "athlete" }],
  owners: [{ athlete_id: "a1", platform: "instagram", account_id: "X" }],
  connections: [{ id: "c1", athlete_id: "a1", platform: "instagram", platform_user_id: "X", connected_by_user_id: null }, { id: "c2", athlete_id: "a3", platform: "gmail", platform_user_id: "g", connected_by_user_id: null }],
  users: [], memberships: [],
});

it("plans one user per distinct uid, one self-membership per athlete with auth_id (established_at = claimed_at else created_at), roles via the membership, connections attributed; P5 reported and left in place", () => {
  const p = planIdentityBackfill(base());
  expect(hasBlockers(p)).toBe(false);
  expect(p.users).toEqual([
    { provider: "firebase", providerUid: "uid-1", email: "1@x", displayName: "One", createdAt: d("2026-01-01T00:00:00Z") },
    { provider: "microsoft", providerUid: "microsoft:2", email: null, displayName: "Two", createdAt: d("2026-02-01T00:00:00Z") },
  ]);
  expect(p.memberships).toEqual([{ athleteId: "a1", providerUid: "uid-1", establishedAt: d("2026-01-05T00:00:00Z") }, { athleteId: "a2", providerUid: "microsoft:2", establishedAt: d("2026-02-01T00:00:00Z") }]);
  expect(p.roles).toEqual([{ providerUid: "uid-1", role: "athlete" }, { providerUid: "uid-1", role: "admin" }]);
  expect(p.connections).toEqual([{ connectionId: "c1", providerUid: "uid-1" }]);
  expect(p.reports.P5).toEqual([{ athleteId: "a3", role: "athlete" }]);
  expect(p.skipped).toEqual({ usersExisting: 0, membershipsExisting: 0, rolesWithoutUser: 1 });
});

it("running it twice plans nothing new (existing users + memberships are skipped)", () => {
  const i = base();
  i.users = [{ id: "u1", provider: "firebase", provider_uid: "uid-1" }, { id: "u2", provider: "microsoft", provider_uid: "microsoft:2" }];
  i.memberships = [{ athlete_id: "a1", user_id: "u1" }, { athlete_id: "a2", user_id: "u2" }];
  i.connections[0].connected_by_user_id = "u1";
  const p = planIdentityBackfill(i);
  expect(p.users).toEqual([]); expect(p.memberships).toEqual([]); expect(p.connections).toEqual([]);
  expect(p.skipped).toMatchObject({ usersExisting: 2, membershipsExisting: 2 });
});

it("P1: one uid on two athletes is a blocker", () => {
  const i = base(); i.athletes.push({ id: "a4", auth_id: "uid-1", auth_provider: "firebase", email: null, full_name: "Dup", claimed_at: null, created_at: null });
  const p = planIdentityBackfill(i);
  expect(p.blockers.P1).toEqual([{ uid: "uid-1", athleteIds: ["a1", "a4"] }]); expect(hasBlockers(p)).toBe(true);
});

it("P2: a microsoft: uid with auth_provider firebase (or the reverse) is a blocker; NULL auth_provider counts as firebase", () => {
  const i = base(); i.athletes[1].auth_provider = "firebase"; i.athletes[0].auth_provider = null;
  const p = planIdentityBackfill(i);
  expect(p.blockers.P2).toEqual([{ athleteId: "a2", uid: "microsoft:2", authProvider: "firebase", expected: "microsoft" }]);
});

it("P3: two active connected_verified owners of one account is a blocker; P4 connected_accounts collisions only reported", () => {
  const i = base(); i.owners.push({ athlete_id: "a2", platform: "instagram", account_id: "X" }); i.connections.push({ id: "c3", athlete_id: "a2", platform: "instagram", platform_user_id: "X", connected_by_user_id: null });
  const p = planIdentityBackfill(i);
  expect(p.blockers.P3).toEqual([{ platform: "instagram", accountId: "X", athleteIds: ["a1", "a2"] }]);
  expect(p.reports.P4).toEqual([{ platform: "instagram", platformUserId: "X", athleteIds: ["a1", "a2"] }]);
  expect(hasBlockers(p)).toBe(true);
});
