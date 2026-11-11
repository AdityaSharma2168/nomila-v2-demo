/**
 * claims.test.ts — Phase A Step 3b: the claim lifecycle on a real (PGlite + pg_trgm) Postgres with 0048 + 0051 + 0052
 * applied verbatim (plan §3b §13). Confirmation is never proof; a corroboration links; a taken row is never linked or merged.
 */
jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
const logInfo = jest.fn();
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: (...a: unknown[]) => logInfo(...a), warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.setTimeout(180_000);

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { client, db, initTestDb, closeTestDb, seedAthlete } from "../../../testUtils/pgliteDb";
import { athleteIndexMatches, athleteUsers, athletes, goldenAthletes, identityClaims, socialIdentities } from "../../../../shared/schema";
import { CLAIM_TTL_MS, confirmClaim, createAthleteForUser, decideClaim, dismissSession, expireStale, listClaims, listMine, pendingClaimCount, proposeClaims, sessionState } from "./claims";
import { resolveIdentity, finalizeResolution } from "./resolve";
import { claimAccountOwnership } from "./ownership";
import { ensureUser, findUserByUid, insertSelfMembership, membershipsForUser, selfMembershipFor } from "./users";
import { __resetIdentityPolicyCache } from "./config";
import { ClaimNotAuthorized, linkUserToAthlete } from "./link";

const caller = (uid: string, email: string | null = null, emailVerified = false) => ({ uid, email, emailVerified });
async function athlete(name: string, over: Partial<{ sport: string; status: string; email: string; auth_id: string; socials: Record<string, string> }> = {}) {
  const id = await seedAthlete(name);
  await db.update(athletes).set({ sport: over.sport ?? null, status: over.status ?? "raw", email: over.email ?? null, auth_id: over.auth_id ?? null, socials: over.socials ?? {} } as any).where(eq(athletes.id, id));
  return id;
}
const claimsOf = (userId: string) => db.select().from(identityClaims).where(eq(identityClaims.user_id, userId));

beforeAll(async () => {
  await initTestDb();
  for (const f of ["0048_athlete_index.sql", "0051_identity_users.sql", "0052_identity_claim_sessions.sql"]) await client.exec(readFileSync(join(__dirname, "../../../../migrations", f), "utf8"));
  __resetIdentityPolicyCache();
});
afterAll(closeTestDb);
beforeEach(() => logInfo.mockReset());

describe("propose", () => {
  it("one session UUID per interaction on every claim; one claim per candidate with its own match_id; re-proposing inside the session is a no-op; a new interaction is a new session", async () => {
    await athlete("Dana Whitfield", { sport: "soccer", status: "enriched", email: "dana@example.com" });
    await athlete("Dana Whitfield", { sport: "soccer", status: "raw", email: "dana2@example.com" });
    const r = await resolveIdentity({ path: "signup", caller: caller("uid-p1", "p1@example.com", true), provider: "firebase", query: { name: "Dana Whitfield", sport: "soccer" } });
    expect(r.action).toBe("confirm"); expect(r.tier).toBe("candidate"); expect(r.claimSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.claims!.length).toBe(2);
    const user = (await findUserByUid("uid-p1"))!;
    const rows = await claimsOf(user.id);
    expect(rows.length).toBe(2); expect(new Set(rows.map((x) => x.claim_session_id)).size).toBe(1); expect(rows.every((x) => x.match_id === r.matchId && x.status === "proposed" && x.proof === "none")).toBe(true);
    expect(await pendingClaimCount(user.id)).toBe(2);
    // same session, same candidates ⇒ no new rows (partial unique)
    const again = await proposeClaims({ caller: caller("uid-p1"), path: "signup", result: r.result, matchId: r.matchId });
    expect(again.claims.length).toBe(2);   // a NEW session: two more rows (different session id)
    expect((await claimsOf(user.id)).length).toBe(4);
    await db.insert(identityClaims).values({ user_id: user.id, athlete_id: rows[0].athlete_id, proof: "none", status: "proposed", claim_session_id: rows[0].claim_session_id! }).onConflictDoNothing();
    expect((await claimsOf(user.id)).length).toBe(4);   // the partial unique held
    await expect(db.insert(identityClaims).values({ user_id: user.id, athlete_id: rows[0].athlete_id, proof: "none", status: "proposed", claim_session_id: rows[0].claim_session_id! })).rejects.toThrow(/identity_claims_session_proposed_uq|duplicate key/);
    // resume groups by session, newest first
    const mine = await listMine(caller("uid-p1"));
    expect(mine.length).toBe(2); expect(mine[0].claimSessionId).toBe(again.claimSessionId); expect(mine[0].claims.length).toBe(2); expect(mine[0].claims[0].candidate?.fullName).toBe("Dana Whitfield");
    // the transitions are logged without a uid
    expect(logInfo.mock.calls.some((c) => c[0]?.claim === "identity_claim" && c[0].to === "proposed")).toBe(true);
    expect(JSON.stringify(logInfo.mock.calls)).not.toContain("uid-p1");
  });

  it("tier new ⇒ create (no claims); the created row gets a human_confirmation membership in one transaction", async () => {
    const r = await resolveIdentity({ path: "signup", caller: caller("uid-new", "n@example.com", true), provider: "firebase", query: { name: "Quinlan Ostrowski", sport: "curling" } });
    expect(r.action).toBe("create"); expect(r.tier).toBe("new");
    const created = await createAthleteForUser({ caller: caller("uid-new", "n@example.com", true), provider: "firebase", path: "signup", values: { full_name: "Quinlan Ostrowski", sport: "curling", status: "raw" } });
    await finalizeResolution(r, created.athleteId);
    const m = await selfMembershipFor(created.athleteId);
    expect(m).toMatchObject({ userId: created.userId, proof: "human_confirmation", note: "created:signup" });
    const [a] = await db.select({ auth_id: athletes.auth_id }).from(athletes).where(eq(athletes.id, created.athleteId));
    expect(a.auth_id).toBe("uid-new");
    expect(await claimsOf(created.userId)).toEqual([]);
  });
});

describe("confirm — the authorization matrix", () => {
  it("verified unique e-mail corroborates ⇒ linked (proof verified_unique_email, claim confirmed by user, membership.claim_id, follow-up telemetry linked_by_verified_email)", async () => {
    const open = await athlete("Evan Marsh", { sport: "golf", status: "enriched", email: "evan@example.com" });
    await athlete("Evan Marsh", { sport: "golf", status: "raw", email: "other@example.com" });
    // the resolver would link on a unique verified e-mail before asking; simulate the "asked first" path: the caller's e-mail is NOT verified at lookup
    const r = await resolveIdentity({ path: "signup", caller: caller("uid-evan", "evan@example.com", false), provider: "firebase", query: { name: "Evan Marsh", sport: "golf" } });
    expect(r.action).toBe("confirm");
    const claim = r.claims!.find((c) => c.athleteId === open)!;
    // later the provider verifies the e-mail (the token now says so)
    const out = await confirmClaim({ caller: caller("uid-evan", "evan@example.com", true), claimId: claim.claimId, claimSessionId: r.claimSessionId! });
    expect(out).toMatchObject({ outcome: "linked", athleteId: open, proof: "verified_unique_email", decision: "linked_by_verified_email" });
    const m = (await selfMembershipFor(open))!;
    expect(m.proof).toBe("verified_unique_email");
    const [row] = await db.select().from(identityClaims).where(eq(identityClaims.id, claim.claimId));
    expect(row).toMatchObject({ status: "confirmed", decided_by: "user" }); expect(row.decided_at).not.toBeNull();
    const [au] = await db.select({ claim_id: athleteUsers.claim_id }).from(athleteUsers).where(eq(athleteUsers.id, m.id));
    expect(au.claim_id).toBe(claim.claimId);
    const follow = await db.select().from(athleteIndexMatches).where(eq(athleteIndexMatches.decision, "linked_by_verified_email"));
    expect(follow.some((f) => f.chosen_athlete_id === open && f.claim_proof === "verified_unique_email")).toBe(true);
    // the retry reads the session: confirmed ⇒ existing
    const retry = await resolveIdentity({ path: "signup", caller: caller("uid-evan", "evan@example.com", true), provider: "firebase", query: { name: "Evan Marsh", sport: "golf" }, claimSessionId: r.claimSessionId });
    expect(retry.action).toBe("existing"); expect(retry.athleteId).toBe(open);
    // idempotent second confirm
    expect((await confirmClaim({ caller: caller("uid-evan", "evan@example.com", true), claimId: claim.claimId, claimSessionId: r.claimSessionId! })).outcome).toBe("linked");
  });

  it("no corroboration ⇒ pending_operator: the claim stays proposed, no membership; the retry creates a NEW row (human_confirmation, note created_after_claim)", async () => {
    const existing = await athlete("Farah Okoye", { sport: "tennis", status: "enriched", email: "farah@example.com" });
    const r = await resolveIdentity({ path: "signup", caller: caller("uid-farah2", "someone@example.com", true), provider: "firebase", query: { name: "Farah Okoye", sport: "tennis" } });
    expect(r.action).toBe("confirm");
    const claim = r.claims!.find((c) => c.athleteId === existing)!;
    const out = await confirmClaim({ caller: caller("uid-farah2", "someone@example.com", true), claimId: claim.claimId, claimSessionId: r.claimSessionId! });
    expect(out).toEqual({ outcome: "pending_operator", athleteId: existing });
    expect(await selfMembershipFor(existing)).toBeNull();
    const [row] = await db.select().from(identityClaims).where(eq(identityClaims.id, claim.claimId));
    expect(row.status).toBe("proposed"); expect((row.note as any).userConfirmedAt).toBeTruthy();
    const st = await sessionState(caller("uid-farah2"), r.claimSessionId!);
    expect(st).toMatchObject({ known: true, confirmedAthleteId: null }); if (st.known) { expect(st.undecided).toEqual([]); expect(st.pendingOperator.length).toBe(1); }
    const retry = await resolveIdentity({ path: "signup", caller: caller("uid-farah2", "someone@example.com", true), provider: "firebase", query: { name: "Farah Okoye", sport: "tennis" }, claimSessionId: r.claimSessionId });
    expect(retry.action).toBe("create");
    const created = await createAthleteForUser({ caller: caller("uid-farah2", "someone@example.com", true), provider: "firebase", path: "signup", claimSessionId: r.claimSessionId, values: { full_name: "Farah Okoye", sport: "tennis", status: "raw" } });
    expect((await selfMembershipFor(created.athleteId))).toMatchObject({ proof: "human_confirmation", note: `created_after_claim:${r.claimSessionId}` });
    expect(await selfMembershipFor(existing)).toBeNull();   // the existing row was never touched
    // the operator queue sees it
    const queue = await listClaims("proposed");
    expect(queue.some((q) => q.claimId === claim.claimId && q.athleteName === "Farah Okoye")).toBe(true);
    expect(JSON.stringify(queue)).not.toContain("uid-farah2");
  });

  it("a row with a self-member ⇒ rejected by the system with the pair; no membership, no merge; the pair is blocked from re-proposal", async () => {
    const taken = await athlete("Gia Romano", { sport: "rowing", status: "active", email: "gia@example.com", auth_id: "uid-gia" });
    const owner = await ensureUser({ uid: "uid-gia" }); await insertSelfMembership({ athleteId: taken, userId: owner.id, proof: "existing_auth" });
    const r = await resolveIdentity({ path: "signup", caller: caller("uid-gia2", "gia@example.com", true), provider: "firebase", query: { name: "Gia Romano", sport: "rowing" } });
    expect(r.action).toBe("confirm");
    const claim = r.claims!.find((c) => c.athleteId === taken)!;
    const out = await confirmClaim({ caller: caller("uid-gia2", "gia@example.com", true), claimId: claim.claimId, claimSessionId: r.claimSessionId! });
    expect(out).toEqual({ outcome: "taken", athleteId: taken, reason: "self_member_exists" });
    const [row] = await db.select().from(identityClaims).where(eq(identityClaims.id, claim.claimId));
    expect(row).toMatchObject({ status: "rejected", decided_by: "system" }); expect((row.note as any).reason).toBe("self_member_exists"); expect((row.note as any).pair).toContain(taken);
    expect((await selfMembershipFor(taken))!.userId).toBe(owner.id);
    expect((await membershipsForUser((await findUserByUid("uid-gia2"))!.id)).length).toBe(0);
    // a new interaction never re-proposes that pair
    const r2 = await resolveIdentity({ path: "signup", caller: caller("uid-gia2", "gia@example.com", true), provider: "firebase", query: { name: "Gia Romano", sport: "rowing" } });
    expect(r2.action).toBe("create");   // the only candidate is blocked ⇒ nothing to ask
  });

  it("a golden anchor is rejected; a claim of ANOTHER user or the wrong session is not found (nothing changes)", async () => {
    const anchor = await athlete("Hal Nakamura", { sport: "fencing", status: "raw", email: "hal.anchor@example.com" });
    await db.insert(goldenAthletes).values({ athlete_id: anchor, ground_truth_source: "manual", active: true });
    const r = await resolveIdentity({ path: "signup", caller: caller("uid-hal2", "hal@example.com", true), provider: "firebase", query: { name: "Hal Nakamura", sport: "fencing" } });
    expect(r.action).toBe("confirm");
    const claim = r.claims![0];
    expect((await confirmClaim({ caller: caller("uid-stranger"), claimId: claim.claimId, claimSessionId: r.claimSessionId! })).outcome).toBe("not_found");
    expect((await confirmClaim({ caller: caller("uid-hal2", "hal@example.com", true), claimId: claim.claimId, claimSessionId: "00000000-0000-0000-0000-000000000000" })).outcome).toBe("not_found");
    let [row] = await db.select().from(identityClaims).where(eq(identityClaims.id, claim.claimId)); expect(row.status).toBe("proposed");
    expect((await confirmClaim({ caller: caller("uid-hal2", "hal@example.com", true), claimId: claim.claimId, claimSessionId: r.claimSessionId! })).outcome).toBe("taken");
    [row] = await db.select().from(identityClaims).where(eq(identityClaims.id, claim.claimId)); expect((row.note as any).reason).toBe("golden_anchor");
    expect(await selfMembershipFor(anchor)).toBeNull();
  });

  it("a §3a-C ownership claim corroborates: confirming the candidate links to the owner row (linked_by_ownership) when it has no self-member; the account keeps one active owner", async () => {
    const ownerRow = await athlete("Ivy Chen", { sport: "track", status: "enriched", email: "ivy@example.com" });   // built from research, unclaimed
    await db.insert(socialIdentities).values({ athlete_id: ownerRow, platform: "instagram", account_id: "IG-IVY", account_id_kind: "platform_id", handle: "ivyruns", source_class: "connected_verified", source_method: "oauth", confidence: "1", status: "active" });
    // the caller signs up on her own new row, then connects the same Instagram account ⇒ collision claim against ownerRow
    const created = await createAthleteForUser({ caller: caller("uid-ivy", "ivy.new@example.com", true), provider: "firebase", path: "signup", values: { full_name: "Ivy Chen", sport: "track", status: "raw" } });
    const col = await claimAccountOwnership({ athleteId: created.athleteId, platform: "instagram", accountId: "IG-IVY", accountIdKind: "platform_id", handle: "ivyruns", canonicalUrl: null, sourceClass: "connected_verified", sourceMethod: "oauth", byUserId: created.userId });
    expect(col.outcome).toBe("collision");
    // the index now offers ownerRow as a candidate; she confirms it
    const r = await resolveIdentity({ path: "signup", caller: caller("uid-ivy", "ivy.new@example.com", true), provider: "firebase", query: { name: "Ivy Chen", sport: "track", handles: { instagram: "ivyruns" } } });
    // she already has a row (existing_auth) — the confirm path is the claim endpoint on the candidate; propose directly for the test
    expect(r.action).toBe("existing");
    const proposed = await proposeClaims({ caller: caller("uid-ivy"), path: "signup", result: { tier: "candidate", candidates: r.result.candidates.filter((c) => c.record.athleteId === ownerRow) }, matchId: null });
    const out = await confirmClaim({ caller: caller("uid-ivy", "ivy.new@example.com", true), claimId: proposed.claims[0].claimId, claimSessionId: proposed.claimSessionId });
    expect(out).toMatchObject({ outcome: "linked", athleteId: ownerRow, proof: "verified_social_ownership", decision: "linked_by_ownership" });
    expect((await selfMembershipFor(ownerRow))).toMatchObject({ userId: created.userId, proof: "verified_social_ownership" });
    expect((await membershipsForUser(created.userId)).length).toBe(2);   // two self-memberships until 3c resolves the pair (D-2)
    const [proj] = await db.select({ id: athletes.id }).from(athletes).where(eq(athletes.auth_id, "uid-ivy"));
    expect(proj.id).toBe(created.athleteId);   // the auth_id projection (unique, 0049) stays on her created row; the owner row is membership-only until 3c
    const owners = await db.select().from(socialIdentities).where(and(eq(socialIdentities.account_id, "IG-IVY"), eq(socialIdentities.status, "active"), eq(socialIdentities.source_class, "connected_verified")));
    expect(owners.map((o) => o.athlete_id)).toEqual([ownerRow]);   // exactly one active owner, unchanged
    const [ownership] = await db.select().from(identityClaims).where(and(eq(identityClaims.user_id, created.userId), eq(identityClaims.proof, "verified_social_ownership")));
    expect(ownership.status).toBe("confirmed");
  });
});

describe("dismiss, expiry, operator", () => {
  it("dismiss expires only the caller's proposed claims in that session; another user's session id does nothing", async () => {
    await athlete("Jon Park", { sport: "golf", status: "raw", email: "jon@example.com" });
    const r = await resolveIdentity({ path: "signup", caller: caller("uid-jon2", "x@example.com", true), provider: "firebase", query: { name: "Jon Park", sport: "golf" } });
    expect(r.action).toBe("confirm");
    expect(await dismissSession(caller("uid-other"), r.claimSessionId!)).toBe(0);
    expect(await dismissSession(caller("uid-jon2"), r.claimSessionId!)).toBe(r.claims!.length);
    const rows = await claimsOf((await findUserByUid("uid-jon2"))!.id);
    expect(rows.every((x) => x.status === "expired" && x.decided_by === "user")).toBe(true);
    const retry = await resolveIdentity({ path: "signup", caller: caller("uid-jon2", "x@example.com", true), provider: "firebase", query: { name: "Jon Park", sport: "golf" }, claimSessionId: r.claimSessionId });
    expect(retry.action).toBe("create");
    expect((await resolveIdentity({ path: "signup", caller: caller("uid-jon2"), provider: "firebase", query: { name: "Jon Park", sport: "golf" }, claimSessionId: "00000000-0000-0000-0000-000000000001" })).action).toBe("session_unknown");
  });

  it("7-day expiry: lazy at confirm (expired) and by the sweep", async () => {
    await athlete("Kim Lee", { sport: "golf", status: "raw", email: "kim@example.com" });
    const r = await resolveIdentity({ path: "signup", caller: caller("uid-kim2"), provider: "firebase", query: { name: "Kim Lee", sport: "golf" } });
    expect(r.action).toBe("confirm");
    const old = new Date(Date.now() - CLAIM_TTL_MS - 1000);
    await db.update(identityClaims).set({ proposed_at: old }).where(eq(identityClaims.id, r.claims![0].claimId));
    expect((await confirmClaim({ caller: caller("uid-kim2"), claimId: r.claims![0].claimId, claimSessionId: r.claimSessionId! })).outcome).toBe("expired");
    const r2 = await resolveIdentity({ path: "signup", caller: caller("uid-kim3"), provider: "firebase", query: { name: "Kim Lee", sport: "golf" } });
    await db.update(identityClaims).set({ proposed_at: old }).where(eq(identityClaims.id, r2.claims![0].claimId));
    expect(await expireStale()).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(identityClaims).where(eq(identityClaims.id, r2.claims![0].claimId));
    expect(row).toMatchObject({ status: "expired", decided_by: "system" });
  });

  it("operator confirm of an index \"Is this you?\" claim whose user already holds another row ⇒ manual_merge_required, never a second membership", async () => {
    const target = await athlete("Nadia Okafor", { sport: "rowing", status: "enriched", email: "nadia@example.com" });
    const who = caller("uid-nadia2", "n2@example.com", true);
    const r = await resolveIdentity({ path: "signup", caller: who, provider: "firebase", query: { name: "Nadia Okafor", sport: "rowing" } });
    const claim = r.claims!.find((c) => c.athleteId === target)!;
    expect((await confirmClaim({ caller: who, claimId: claim.claimId, claimSessionId: r.claimSessionId! })).outcome).toBe("pending_operator");
    // she continues on a NEW row while the claim waits (the retry's create)
    const created = await createAthleteForUser({ caller: who, provider: "firebase", path: "signup", claimSessionId: r.claimSessionId!, values: { full_name: "Nadia Okafor", status: "raw" } });
    const out = await decideClaim({ claimId: claim.claimId, decision: "confirm", operator: "op-1" });
    expect(out).toMatchObject({ outcome: "manual_merge_required", athleteId: target, heldBy: created.athleteId });
    expect((out as any).message).toMatch(/FIRST re-check that .* still has auth_id NULL/);
    // where she resolves: still (only) her own new row — no second membership, nothing on the target
    expect((await membershipsForUser(created.userId)).map((m) => m.athleteId)).toEqual([created.athleteId]);
    expect(await selfMembershipFor(target)).toBeNull();
    const [t] = await db.select({ auth_id: athletes.auth_id }).from(athletes).where(eq(athletes.id, target)); expect(t.auth_id).toBeNull();
    const [row] = await db.select().from(identityClaims).where(eq(identityClaims.id, claim.claimId));
    expect(row.status).toBe("proposed"); expect((row.note as any).manualMergeRequired.heldBy).toBe(created.athleteId);
  });

  it("a membership-only hold (no auth_id projection) also routes to the manual merge", async () => {
    const target = await athlete("Omar Lindgren", { sport: "rowing", status: "enriched", email: "omar@example.com" });
    const other = await athlete("Omar Elsewhere", { status: "raw" });
    const who = caller("uid-omar2", "o2@example.com", true);
    const r = await resolveIdentity({ path: "signup", caller: who, provider: "firebase", query: { name: "Omar Lindgren", sport: "rowing" } });
    const claim = r.claims!.find((c) => c.athleteId === target)!;
    const u = (await findUserByUid("uid-omar2"))!;
    await insertSelfMembership({ athleteId: other, userId: u.id, proof: "verified_social_ownership", note: "test" });
    expect(await decideClaim({ claimId: claim.claimId, decision: "confirm", operator: "op-1" })).toMatchObject({ outcome: "manual_merge_required", heldBy: other });
    expect(await selfMembershipFor(target)).toBeNull();
  });

  it("operator confirm ⇒ linked_by_operator with membership proof human_confirmation; a taken row is refused; reject records the operator", async () => {
    const open = await athlete("Lena Voss", { sport: "swimming", status: "enriched", email: "lena@example.com" });
    const r = await resolveIdentity({ path: "signup", caller: caller("uid-lena2", "l2@example.com", true), provider: "firebase", query: { name: "Lena Voss", sport: "swimming" } });
    const claim = r.claims!.find((c) => c.athleteId === open)!;
    expect((await confirmClaim({ caller: caller("uid-lena2", "l2@example.com", true), claimId: claim.claimId, claimSessionId: r.claimSessionId! })).outcome).toBe("pending_operator");
    // without the operator, a human click can never link a pre-existing row
    await expect(linkUserToAthlete(open, "uid-lena2", "firebase", "human_confirmation", new Date(), { claimId: claim.claimId })).rejects.toBeInstanceOf(ClaimNotAuthorized);
    const out = await decideClaim({ claimId: claim.claimId, decision: "confirm", note: "checked the roster", operator: "op-1" });
    expect(out).toEqual({ outcome: "linked", athleteId: open });
    expect((await selfMembershipFor(open))).toMatchObject({ proof: "human_confirmation", userId: (await findUserByUid("uid-lena2"))!.id });
    const [row] = await db.select().from(identityClaims).where(eq(identityClaims.id, claim.claimId));
    expect(row).toMatchObject({ status: "confirmed", decided_by: "operator" }); expect((row.note as any).operatorNote).toBe("checked the roster");
    expect((await db.select().from(athleteIndexMatches).where(eq(athleteIndexMatches.decision, "linked_by_operator"))).length).toBeGreaterThanOrEqual(1);
    expect((await decideClaim({ claimId: claim.claimId, decision: "confirm", operator: "op-1" })).outcome).toBe("not_proposed");
    // a second user proposes the same (now taken) row: the operator cannot link it either
    const r2 = await resolveIdentity({ path: "signup", caller: caller("uid-lena3", "l3@example.com", true), provider: "firebase", query: { name: "Lena Voss", sport: "swimming" } });
    const c2 = r2.claims!.find((c) => c.athleteId === open)!;
    expect((await decideClaim({ claimId: c2.claimId, decision: "confirm", operator: "op-1" })).outcome).toBe("taken");
    const rej = await decideClaim({ claimId: c2.claimId, decision: "reject", note: "not her", operator: "op-1" });
    expect(rej).toEqual({ outcome: "rejected" });
    const [r2row] = await db.select().from(identityClaims).where(eq(identityClaims.id, c2.claimId));
    expect(r2row).toMatchObject({ status: "rejected", decided_by: "operator" });
    expect((await decideClaim({ claimId: "00000000-0000-0000-0000-000000000000", decision: "reject", operator: "op-1" })).outcome).toBe("not_found");
  });

  it("concurrency: two users confirming the same open row with corroboration ⇒ one membership; the other is taken", async () => {
    const open = await athlete("Mo Salah-Smith", { sport: "handball", status: "enriched", email: "mo@example.com" });
    const rA = await resolveIdentity({ path: "signup", caller: caller("uid-moA", "mo@example.com", false), provider: "firebase", query: { name: "Mo Salah-Smith", sport: "handball" } });
    const rB = await resolveIdentity({ path: "signup", caller: caller("uid-moB", "mo@example.com", false), provider: "firebase", query: { name: "Mo Salah-Smith", sport: "handball" } });
    const cA = rA.claims!.find((c) => c.athleteId === open)!; const cB = rB.claims!.find((c) => c.athleteId === open)!;
    const [a, b] = await Promise.all([
      confirmClaim({ caller: caller("uid-moA", "mo@example.com", true), claimId: cA.claimId, claimSessionId: rA.claimSessionId! }),
      confirmClaim({ caller: caller("uid-moB", "mo@example.com", true), claimId: cB.claimId, claimSessionId: rB.claimSessionId! }),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(["linked", "taken"]);
    expect((await db.select().from(athleteUsers).where(eq(athleteUsers.athlete_id, open))).length).toBe(1);
  });
});

describe("one decision settles the session (acceptance fix, 12 Sep 2026)", () => {
  it("picking one candidate supersedes the session's other proposed claims: after 'taken' the retry creates instead of asking again; 'pending' does the same", async () => {
    const owned = await athlete("Nova Reyes", { sport: "soccer", status: "active", email: "nova@example.com", auth_id: "uid-nova" });
    const owner = await ensureUser({ uid: "uid-nova" }); await insertSelfMembership({ athleteId: owned, userId: owner.id, proof: "existing_auth" });
    const open = await athlete("Nova Reyes", { sport: "soccer", status: "enriched", email: "nova2@example.com" });
    const r = await resolveIdentity({ path: "signup", caller: caller("uid-nova-look", "look@example.com", true), provider: "firebase", query: { name: "Nova Reyes", sport: "soccer" } });
    expect(r.action).toBe("confirm"); expect(r.claims!.length).toBe(2);
    const ownedClaim = r.claims!.find((c) => c.athleteId === owned)!; const openClaim = r.claims!.find((c) => c.athleteId === open)!;
    expect((await confirmClaim({ caller: caller("uid-nova-look", "look@example.com", true), claimId: ownedClaim.claimId, claimSessionId: r.claimSessionId! })).outcome).toBe("taken");
    const [sib] = await db.select().from(identityClaims).where(eq(identityClaims.id, openClaim.claimId));
    expect(sib).toMatchObject({ status: "superseded", decided_by: "system" }); expect((sib.note as any).reason).toBe("user_chose_other");
    const st = await sessionState(caller("uid-nova-look"), r.claimSessionId!);
    expect(st).toMatchObject({ known: true, confirmedAthleteId: null }); if (st.known) expect(st.undecided).toEqual([]);
    const retry = await resolveIdentity({ path: "signup", caller: caller("uid-nova-look", "look@example.com", true), provider: "firebase", query: { name: "Nova Reyes", sport: "soccer" }, claimSessionId: r.claimSessionId });
    expect(retry.action).toBe("create");
    expect((await confirmClaim({ caller: caller("uid-nova-look", "look@example.com", true), claimId: openClaim.claimId, claimSessionId: r.claimSessionId! })).outcome).toBe("expired");   // superseded is final
    const r2 = await resolveIdentity({ path: "signup", caller: caller("uid-nova-look2", "x@example.com", true), provider: "firebase", query: { name: "Nova Reyes", sport: "soccer" } });
    const open2 = r2.claims!.find((c) => c.athleteId === open)!; const owned2 = r2.claims!.find((c) => c.athleteId === owned)!;
    expect((await confirmClaim({ caller: caller("uid-nova-look2", "x@example.com", true), claimId: open2.claimId, claimSessionId: r2.claimSessionId! })).outcome).toBe("pending_operator");
    expect((await db.select().from(identityClaims).where(eq(identityClaims.id, owned2.claimId)))[0].status).toBe("superseded");
    expect((await resolveIdentity({ path: "signup", caller: caller("uid-nova-look2", "x@example.com", true), provider: "firebase", query: { name: "Nova Reyes", sport: "soccer" }, claimSessionId: r2.claimSessionId })).action).toBe("create");
  });
});
