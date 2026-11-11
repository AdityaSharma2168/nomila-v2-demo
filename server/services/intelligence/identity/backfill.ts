/**
 * identity/backfill.ts — the PURE planner behind scripts/backfillIdentityUsers.ts (Phase A Step 3a, plan §2).
 * Reads nothing, writes nothing: rows in, pre-flight findings + the exact rows to insert out.
 *
 *   P1 one uid on more than one athlete            blocker (a person would hold two self-memberships with no proof)
 *   P2 provider consistency (uid form vs auth_provider) blocker
 *   P3 one account with two active connected_verified owners   blocker (the 0051 unique index would fail)
 *   P4 connected_accounts collisions                report only
 *   P5 account_roles on athletes without auth_id    report only (left in account_roles; no user to attach to)
 *   P6 emails: every backfilled user is email_verified=false (nobody re-verifies at backfill)
 */

import { providerOf, type Provider } from "./provider";

export interface AthleteRow { id: string; auth_id: string | null; auth_provider: string | null; email: string | null; full_name: string | null; claimed_at: Date | null; created_at: Date | null }
export interface RoleRow { account_id: string; role: string }
export interface OwnerRow { athlete_id: string; platform: string; account_id: string }
export interface ConnectionRow { id: string; athlete_id: string; platform: string; platform_user_id: string | null; connected_by_user_id: string | null }
export interface ExistingUser { id: string; provider: string; provider_uid: string }
export interface ExistingMembership { athlete_id: string; user_id: string }

export interface BackfillInput { athletes: AthleteRow[]; roles: RoleRow[]; owners: OwnerRow[]; connections: ConnectionRow[]; users: ExistingUser[]; memberships: ExistingMembership[] }

export interface BackfillPlan {
  blockers: { P1: Array<{ uid: string; athleteIds: string[] }>; P2: Array<{ athleteId: string; uid: string; authProvider: string | null; expected: Provider }>; P3: Array<{ platform: string; accountId: string; athleteIds: string[] }> };
  reports: { P4: Array<{ platform: string; platformUserId: string; athleteIds: string[] }>; P5: Array<{ athleteId: string; role: string }> };
  users: Array<{ provider: Provider; providerUid: string; email: string | null; displayName: string | null; createdAt: Date | null }>;
  memberships: Array<{ athleteId: string; providerUid: string; establishedAt: Date | null }>;
  roles: Array<{ providerUid: string; role: string }>;
  connections: Array<{ connectionId: string; providerUid: string }>;
  skipped: { usersExisting: number; membershipsExisting: number; rolesWithoutUser: number };
}

export function planIdentityBackfill(i: BackfillInput): BackfillPlan {
  const byUid = new Map<string, AthleteRow[]>();
  for (const a of i.athletes) if (a.auth_id) byUid.set(a.auth_id, [...(byUid.get(a.auth_id) ?? []), a]);
  const P1 = [...byUid.entries()].filter(([, rows]) => rows.length > 1).map(([uid, rows]) => ({ uid, athleteIds: rows.map((r) => r.id).sort() }));
  const P2 = i.athletes.filter((a) => a.auth_id && (a.auth_provider ?? "firebase") !== providerOf(a.auth_id)).map((a) => ({ athleteId: a.id, uid: a.auth_id!, authProvider: a.auth_provider, expected: providerOf(a.auth_id!) }));
  const owners = new Map<string, Set<string>>();
  for (const o of i.owners) { const k = `${o.platform}\u0000${o.account_id}`; owners.set(k, new Set([...(owners.get(k) ?? []), o.athlete_id])); }
  const P3 = [...owners.entries()].filter(([, s]) => s.size > 1).map(([k, s]) => { const [platform, accountId] = k.split("\u0000"); return { platform, accountId, athleteIds: [...s].sort() }; });
  const conns = new Map<string, Set<string>>();
  for (const c of i.connections) if (c.platform_user_id) { const k = `${c.platform}\u0000${c.platform_user_id}`; conns.set(k, new Set([...(conns.get(k) ?? []), c.athlete_id])); }
  const P4 = [...conns.entries()].filter(([, s]) => s.size > 1).map(([k, s]) => { const [platform, platformUserId] = k.split("\u0000"); return { platform, platformUserId, athleteIds: [...s].sort() }; });
  const withAuth = new Map(i.athletes.filter((a) => a.auth_id).map((a) => [a.id, a]));
  const P5 = i.roles.filter((r) => !withAuth.has(r.account_id)).map((r) => ({ athleteId: r.account_id, role: r.role }));

  const existingUsers = new Set(i.users.map((u) => `${u.provider}\u0000${u.provider_uid}`));
  const existingMember = new Set(i.memberships.map((m) => m.athlete_id));
  const users: BackfillPlan["users"] = []; const memberships: BackfillPlan["memberships"] = []; const roles: BackfillPlan["roles"] = []; const connections: BackfillPlan["connections"] = [];
  let usersExisting = 0, membershipsExisting = 0;
  const seenUid = new Set<string>();
  for (const a of i.athletes) {
    if (!a.auth_id) continue;
    const provider = providerOf(a.auth_id);
    if (!seenUid.has(a.auth_id)) {
      seenUid.add(a.auth_id);
      if (existingUsers.has(`${provider}\u0000${a.auth_id}`)) usersExisting++;
      else users.push({ provider, providerUid: a.auth_id, email: a.email, displayName: a.full_name, createdAt: a.created_at });
    }
    if (existingMember.has(a.id)) membershipsExisting++;
    else memberships.push({ athleteId: a.id, providerUid: a.auth_id, establishedAt: a.claimed_at ?? a.created_at });
    for (const r of i.roles.filter((x) => x.account_id === a.id)) if (!roles.some((x) => x.providerUid === a.auth_id && x.role === r.role)) roles.push({ providerUid: a.auth_id, role: r.role });
    for (const c of i.connections.filter((x) => x.athlete_id === a.id && !x.connected_by_user_id)) connections.push({ connectionId: c.id, providerUid: a.auth_id });
  }
  return { blockers: { P1, P2, P3 }, reports: { P4, P5 }, users, memberships, roles, connections, skipped: { usersExisting, membershipsExisting, rolesWithoutUser: P5.length } };
}

export const hasBlockers = (p: BackfillPlan) => p.blockers.P1.length + p.blockers.P2.length + p.blockers.P3.length > 0;
