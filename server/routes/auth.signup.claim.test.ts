/**
 * auth.signup.claim.test.ts — Phase A Step 3b: POST /auth/signup with the claim flag OFF (the verified e-mail stage; the
 * old name-match claim is gone — `%`, `_` and exact-name probes create a new row, a name match only queues a proposed
 * claim for an operator) and ON (the 409 `confirmation_required` contract, the retry with the session id, the created
 * row's human_confirmation membership, an unknown session ⇒ 400); the Microsoft D-6 rule; and, on both paths, an
 * UNVERIFIED token e-mail never attaches an existing row (security: email+password accounts can carry any address).
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
const verifyIdToken = jest.fn(); const setCustomUserClaims = jest.fn().mockResolvedValue(undefined);
jest.mock("../lib/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireFirebaseUser: (_req: any, _res: any, next: any) => next(),
  verifyIdTokenChecked: (t: string) => verifyIdToken(t),   // routes/auth /signup and waitlist verify through lib/auth
  tokenFailure: () => ({ status: 401, body: { error: "Invalid or expired token" } }),
  firebaseAuth: { verifyIdToken: (t: string) => verifyIdToken(t), setCustomUserClaims: (...a: unknown[]) => setCustomUserClaims(...a), createCustomToken: jest.fn().mockResolvedValue("custom") },
}));
const startRun = jest.fn().mockResolvedValue({ runId: "r" });
jest.mock("../workflow/runner", () => ({ startRun: (...a: unknown[]) => startRun(...a) }));
jest.setTimeout(180_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { client, db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { athleteUsers, athletes, identityClaims } from "../../shared/schema";
import authRouter, { microsoftEmailVerified } from "./auth";
import { confirmClaim, decideClaim, expireStale, listClaims, listMine, pendingClaimCount } from "../services/intelligence/identity/claims";
import { escapeLike, nameUsableForMatch } from "../lib/signups";
import { findUserByUid, membershipsForUser, selfMembershipFor } from "../services/intelligence/identity/users";

let server: Server; let base: string; const env = process.env;
const signup = async (uid: string, body: Record<string, unknown>, email: string | null = null, emailVerified = false) => {
  verifyIdToken.mockResolvedValue({ uid, email: email ?? undefined, email_verified: emailVerified });
  const r = await fetch(`${base}/signup`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
};

beforeAll(async () => {
  await initTestDb();
  for (const f of ["0048_athlete_index.sql", "0051_identity_users.sql", "0052_identity_claim_sessions.sql"]) await client.exec(readFileSync(join(__dirname, "../../migrations", f), "utf8"));
  const app = express(); app.use(express.json()); app.use("/", authRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { process.env = env; await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
afterEach(() => { process.env = env; startRun.mockClear(); });

describe("flag OFF — the legacy path (no name-match claim)", () => {
  beforeEach(() => { process.env = { ...env, ATHLETE_INDEX_CLAIM: "false", SIGNUPS_OPEN: "true" }; });
  it("stage 2 (verified e-mail match) still links silently; a name match never claims — it creates and records a proposed claim for an operator; onboarding starts on v2", async () => {
    const byEmail = await seedAthlete("Pat Rowe"); await db.update(athletes).set({ email: "pat@example.com", status: "raw" } as any).where(eq(athletes.id, byEmail));
    const r1 = await signup("uid-pat", { name: "Pat Rowe", role: "athlete", sport: "golf" }, "pat@example.com", true);
    expect(r1.status).toBe(200); expect(r1.json.id).toBe(byEmail);
    expect((await selfMembershipFor(byEmail))).toMatchObject({ proof: "existing_auth", note: "legacy_path:signup_email" });
    const byName = await seedAthlete("Quincy Adebayo"); await db.update(athletes).set({ sport: "tennis", status: "raw", email: "quincy@real.example" } as any).where(eq(athletes.id, byName));
    const r2 = await signup("uid-quincy", { name: "Quincy Adebayo", role: "athlete", sport: "tennis" }, "q@example.com", true);
    expect(r2.status).toBe(201); expect(r2.json.id).not.toBe(byName); expect(r2.json.claimed).toBe(false);
    const [untouched] = await db.select({ auth_id: athletes.auth_id, email: athletes.email, status: athletes.status }).from(athletes).where(eq(athletes.id, byName));
    expect(untouched).toEqual({ auth_id: null, email: "quincy@real.example", status: "raw" });
    expect(await selfMembershipFor(byName)).toBeNull();
    const [proposal] = await db.select().from(identityClaims).where(eq(identityClaims.athlete_id, byName));
    expect(proposal).toMatchObject({ status: "proposed", proof: "none", note: { path: "signup_legacy_name" }, user_id: (await findUserByUid("uid-quincy"))!.id });
    // the user never sees it (operator-only): not in /identity/claims/mine, not in /auth/me pendingClaims
    const quincyUser = (await findUserByUid("uid-quincy"))!;
    expect(await listMine({ uid: "uid-quincy", email: "q@example.com", emailVerified: true })).toEqual([]);
    expect(await pendingClaimCount(quincyUser.id)).toBe(0);
    // the operator queue shows who is asking: provider, e-mail and whether it was verified (never the provider uid)
    const queued = (await listClaims("proposed")).find((c) => c.claimId === proposal.id)!;
    expect(queued.user).toEqual({ provider: "firebase", email: "q@example.com", emailVerified: false });   // grandfathered users record emailVerified false
    expect(JSON.stringify(queued)).not.toContain("uid-quincy");
    // operator approval would only add a second membership (the auth_id projection stays on her sign-up row) ⇒ refused,
    // routed to a manual merge; nothing links, and the claim stays queued (kept out of the 7-day expiry)
    const d = await decideClaim({ claimId: proposal.id, decision: "confirm", operator: "ops@test" });
    expect(d).toMatchObject({ outcome: "manual_merge_required", athleteId: byName, heldBy: r2.json.id });
    expect((d as any).message).toMatch(/Merge the two rows by hand/);
    // where the approved user actually resolves: the auth_id lookup AND the membership rule both still give her sign-up row
    const [resolved] = await db.select({ id: athletes.id }).from(athletes).where(eq(athletes.auth_id, "uid-quincy"));
    expect(resolved.id).toBe(r2.json.id);
    expect((await membershipsForUser(quincyUser.id)).map((m) => m.athleteId)).toEqual([r2.json.id]);
    expect(await selfMembershipFor(byName)).toBeNull();
    const [after] = await db.select({ auth_id: athletes.auth_id }).from(athletes).where(eq(athletes.id, byName)); expect(after.auth_id).toBeNull();
    const [still] = await db.select().from(identityClaims).where(eq(identityClaims.id, proposal.id));
    expect(still.status).toBe("proposed"); expect((still.note as any).manualMergeRequired).toMatchObject({ heldBy: r2.json.id, operator: "ops@test" });
    expect(await expireStale(new Date(Date.now() + 8 * 24 * 3600 * 1000))).toBe(0);
    expect((await db.select().from(identityClaims).where(eq(identityClaims.id, proposal.id)))[0].status).toBe("proposed");
    // and a reject still works
    expect((await decideClaim({ claimId: proposal.id, decision: "reject", operator: "ops@test" })).outcome).toBe("rejected");
    const r3 = await signup("uid-fresh", { name: "Zuri Nobody", role: "athlete", sport: "golf" }, "z@example.com", true);
    expect(r3.status).toBe(201);
    expect((await selfMembershipFor(r3.json.id))).toMatchObject({ proof: "existing_auth", note: "legacy_path:signup_create" });
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ process: "onboarding", athleteId: r3.json.id }));
    expect(startRun.mock.calls[0][0].version).toBeUndefined();   // untouched legacy call
    expect((await db.select().from(identityClaims)).length).toBe(1);   // only Quincy's proposal; no match for Zuri
  });

  it("SECURITY: `%`, `_` and an exact victim name (unverified e-mail) never claim; wildcards match literally; short names propose nothing", async () => {
    const victim = await seedAthlete("Wilhelmina Strand"); await db.update(athletes).set({ status: "enriched", email: "wil@real.example" } as any).where(eq(athletes.id, victim));
    const other  = await seedAthlete("Xavi Moreno");       await db.update(athletes).set({ status: "raw" } as any).where(eq(athletes.id, other));
    const before = (await db.select().from(identityClaims)).length;
    const probes: Array<[string, Record<string, unknown>, boolean]> = [
      ["uid-probe-pct",   { name: "%", role: "athlete" }, false],
      ["uid-probe-pct2",  { name: "%%%%%%", role: "athlete" }, false],
      ["uid-probe-us",    { name: "_", role: "athlete" }, false],
      ["uid-probe-us2",   { name: "W%a S_rand", role: "athlete" }, false],
      ["uid-probe-exact", { name: "Wilhelmina Strand", role: "athlete" }, false],   // exact name + unverified e-mail
    ];
    for (const [uid, body, verified] of probes) {
      const r = await signup(uid, body, "attacker@evil.example", verified);
      expect(r.status).toBe(201); expect(r.json.claimed).toBe(false); expect([victim, other]).not.toContain(r.json.id);
    }
    for (const id of [victim, other]) {
      const [row] = await db.select({ auth_id: athletes.auth_id, email: athletes.email, status: athletes.status }).from(athletes).where(eq(athletes.id, id));
      expect(row.auth_id).toBeNull(); expect(row.email).not.toBe("attacker@evil.example"); expect(row.status).not.toBe("claimed");
      expect(await selfMembershipFor(id)).toBeNull();
    }
    // the wildcard probes recorded nothing (too short / matched literally); only the exact name is queued for an operator
    const added = await db.select().from(identityClaims);
    expect(added.length).toBe(before + 1);
    const queued = added.filter((c) => c.athlete_id === victim || c.athlete_id === other);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ athlete_id: victim, status: "proposed", proof: "none", note: { path: "signup_legacy_name" }, user_id: (await findUserByUid("uid-probe-exact"))!.id });
  });

  it("SECURITY: the verified e-mail stage skips a row already in an identity flow (an active self-membership, or a proposed / confirmed claim)", async () => {
    const mkUser = async (uid: string) => { const { ensureUser } = await import("../services/intelligence/identity/users"); return ensureUser({ uid, email: null, emailVerified: false, displayName: null }); };
    // a membership-only self link (auth_id still NULL), a proposed claim, a confirmed claim
    const withMember = await seedAthlete("Ines Member", { email: "ines@real.example", status: "raw" } as any);
    const { insertSelfMembership } = await import("../services/intelligence/identity/users");
    await insertSelfMembership({ athleteId: withMember, userId: (await mkUser("uid-ines-owner")).id, proof: "verified_social_ownership", note: "test" });
    const withProposed = await seedAthlete("Jun Proposed", { email: "jun@real.example", status: "raw" } as any);
    await db.insert(identityClaims).values({ user_id: (await mkUser("uid-jun-other")).id, athlete_id: withProposed, proof: "verified_social_ownership", status: "proposed" });
    const withConfirmed = await seedAthlete("Kai Confirmed", { email: "kai@real.example", status: "raw" } as any);
    await db.insert(identityClaims).values({ user_id: (await mkUser("uid-kai-other")).id, athlete_id: withConfirmed, proof: "verified_unique_email", status: "confirmed", decided_by: "system" });
    for (const [uid, mail, row] of [["uid-ines", "ines@real.example", withMember], ["uid-jun", "jun@real.example", withProposed], ["uid-kai", "kai@real.example", withConfirmed]] as const) {
      const r = await signup(uid, { name: "Someone Else", role: "athlete" }, mail, true);
      expect(r.status).toBe(201); expect(r.json.id).not.toBe(row); expect(r.json.claimed).toBe(false);
      const [after] = await db.select({ auth_id: athletes.auth_id }).from(athletes).where(eq(athletes.id, row)); expect(after.auth_id).toBeNull();
    }
    // a clean row with the same kind of verified address still links (the stage itself is unchanged)
    const clean = await seedAthlete("Lia Clean", { email: "lia@real.example", status: "raw" } as any);
    const ok = await signup("uid-lia", { name: "Lia Clean", role: "athlete" }, "lia@real.example", true);
    expect(ok.status).toBe(200); expect(ok.json.id).toBe(clean);
  });

  it("SECURITY: a victim's name proposal (proof none, anyone can create it) does not block the real owner's verified e-mail", async () => {
    const victim = await seedAthlete("Marisol Vantongeren", { email: "marisol@real.example", status: "enriched" } as any);
    // an attacker types her exact name: a new row, plus a proof-none signup_legacy_name proposal on her row
    const probe = await signup("uid-marisol-attacker", { name: "Marisol Vantongeren", role: "athlete" }, "evil@attacker.example", false);
    expect(probe.status).toBe(201); expect(probe.json.id).not.toBe(victim);
    const [proposal] = await db.select().from(identityClaims).where(eq(identityClaims.athlete_id, victim));
    expect(proposal).toMatchObject({ status: "proposed", proof: "none", note: { path: "signup_legacy_name" } });
    // the real owner signs in with her VERIFIED address: she still links to her row
    const owner = await signup("uid-marisol", { name: "Marisol Vantongeren", role: "athlete" }, "marisol@real.example", true);
    expect(owner.status).toBe(200); expect(owner.json).toMatchObject({ id: victim, claimed: true });
    const [row] = await db.select({ auth_id: athletes.auth_id }).from(athletes).where(eq(athletes.id, victim)); expect(row.auth_id).toBe("uid-marisol");
    expect((await selfMembershipFor(victim))).toMatchObject({ note: "legacy_path:signup_email" });
  });

  it("the helpers: escapeLike escapes %, _ and \\; nameUsableForMatch needs 4 letters/digits", () => {
    expect(escapeLike("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
    expect(nameUsableForMatch("%%%%")).toBe(false); expect(nameUsableForMatch("Al")).toBe(false); expect(nameUsableForMatch(" Ana B ")).toBe(true);
  });

  it("SECURITY: an UNVERIFIED e-mail never attaches to the existing row carrying it — a new row is created instead", async () => {
    const victim = await seedAthlete("Una Halvorsen"); await db.update(athletes).set({ email: "una@example.com", status: "raw" } as any).where(eq(athletes.id, victim));
    for (const [uid, verified] of [["uid-attacker-false", false], ["uid-attacker-missing", undefined]] as const) {
      verifyIdToken.mockResolvedValue({ uid, email: "UNA@example.com", ...(verified === undefined ? {} : { email_verified: verified }) });
      const r = await fetch(`${base}/signup`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok" }, body: JSON.stringify({ name: "Mallory Q", role: "athlete" }) });
      const json = await r.json() as any;
      expect(r.status).toBe(201); expect(json.id).not.toBe(victim); expect(json.claimed).toBe(false);
    }
    const [row] = await db.select({ auth_id: athletes.auth_id }).from(athletes).where(eq(athletes.id, victim));
    expect(row.auth_id).toBeNull();
    expect(await selfMembershipFor(victim)).toBeNull();
    // the real owner, with a VERIFIED address, still claims it by e-mail
    const owner = await signup("uid-una", { name: "Una Halvorsen", role: "athlete" }, "una@example.com", true);
    expect(owner.status).toBe(200); expect(owner.json).toMatchObject({ id: victim, claimed: true });
    expect((await selfMembershipFor(victim))).toMatchObject({ note: "legacy_path:signup_email" });
  });
});

describe("flag ON — the claim flow", () => {
  beforeEach(() => { process.env = { ...env, ATHLETE_INDEX_CLAIM: "true", SIGNUPS_OPEN: "true" }; });
  it("candidates ⇒ 409 confirmation_required with a session id and the claims; the retry after 'none of these' creates a row with a human_confirmation membership; onboarding starts on v2 (flag off) or v3 (flag on)", async () => {
    const existing = await seedAthlete("Rae Lindqvist"); await db.update(athletes).set({ sport: "skiing", status: "enriched", email: "rae@example.com" } as any).where(eq(athletes.id, existing));
    const r = await signup("uid-rae2", { name: "Rae Lindqvist", role: "athlete", sport: "skiing" }, "r2@example.com", true);
    expect(r.status).toBe(409); expect(r.json.error).toBe("confirmation_required"); expect(r.json.claimSessionId).toMatch(/^[0-9a-f-]{36}$/); expect(["auto_match", "candidate"]).toContain(r.json.tier);
    expect(r.json.claims[0]).toMatchObject({ athleteId: existing, status: "proposed" }); expect(r.json.claims[0].candidate.fullName).toBe("Rae Lindqvist");
    expect(JSON.stringify(r.json)).not.toContain("uid-rae2"); expect(JSON.stringify(r.json)).not.toContain("rae@example.com");
    expect(await selfMembershipFor(existing)).toBeNull();
    // the same request again (no decision yet) ⇒ the same session, no new rows
    const again = await signup("uid-rae2", { name: "Rae Lindqvist", role: "athlete", sport: "skiing", claimSessionId: r.json.claimSessionId }, "r2@example.com", true);
    expect(again.status).toBe(409); expect(again.json.claimSessionId).toBe(r.json.claimSessionId);
    expect((await db.select().from(identityClaims).where(eq(identityClaims.claim_session_id, r.json.claimSessionId))).length).toBe(1);
    // an unknown session ⇒ 400
    expect((await signup("uid-rae2", { name: "Rae Lindqvist", role: "athlete", sport: "skiing", claimSessionId: "00000000-0000-0000-0000-000000000000" }, "r2@example.com", true)).status).toBe(400);
    // "none of these"
    await db.update(identityClaims).set({ status: "expired", decided_by: "user", decided_at: new Date() }).where(eq(identityClaims.claim_session_id, r.json.claimSessionId));
    const created = await signup("uid-rae2", { name: "Rae Lindqvist", role: "athlete", sport: "skiing", claimSessionId: r.json.claimSessionId }, "r2@example.com", true);
    expect(created.status).toBe(201); expect(created.json.id).not.toBe(existing);
    expect((await selfMembershipFor(created.json.id))).toMatchObject({ proof: "human_confirmation", note: `created_after_claim:${r.json.claimSessionId}` });
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ process: "onboarding", athleteId: created.json.id, version: 2 }));
    // AND the initial M.I.A. assessment. Gated on a resolvable sport, not merely on an athlete existing: the evaluator
    // needs one and buildEvidenceSnapshot returns null without it. The athlete has no connected accounts yet, so the
    // block is empty and the evaluator works from its own grounded research — the intended first assessment, which a
    // later SOCIAL_BLOCK_CHANGED supersedes on newer evidence.
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({
      process: "mia_evaluation", athleteId: created.json.id,
      input: expect.objectContaining({ trigger: "IDENTITY_RESOLVED", force: false }),
    }));
  });

  it("a confirmed claim (corroborated) ⇒ the retry returns the linked row (200, claimed); user_roles written", async () => {
    const open = await seedAthlete("Sam Ibarra"); await db.update(athletes).set({ sport: "golf", status: "enriched", email: "sam@example.com" } as any).where(eq(athletes.id, open));
    const r = await signup("uid-sam2", { name: "Sam Ibarra", role: "athlete", sport: "golf" }, "sam@example.com", false);
    expect(r.status).toBe(409);
    const claim = r.json.claims.find((c: any) => c.athleteId === open);
    expect((await confirmClaim({ caller: { uid: "uid-sam2", email: "sam@example.com", emailVerified: true }, claimId: claim.claimId, claimSessionId: r.json.claimSessionId })).outcome).toBe("linked");
    const retry = await signup("uid-sam2", { name: "Sam Ibarra", role: "athlete", sport: "golf", claimSessionId: r.json.claimSessionId }, "sam@example.com", true);
    expect(retry.status).toBe(200); expect(retry.json).toMatchObject({ id: open });   // the idempotent "existing account" answer, byte for byte
    const u = (await findUserByUid("uid-sam2"))!;
    const { userRoles } = await import("../../shared/schema");
    expect((await db.select().from(userRoles).where(eq(userRoles.user_id, u.id))).map((x) => x.role)).toEqual(["athlete"]);
    expect((await db.select().from(athleteUsers).where(eq(athleteUsers.athlete_id, open))).length).toBe(1);
  });

  it("a unique verified e-mail still links before any question (2c), now with a confirmed/system claim", async () => {
    const open = await seedAthlete("Tess Varga"); await db.update(athletes).set({ sport: "golf", status: "enriched", email: "tess@example.com" } as any).where(eq(athletes.id, open));
    const r = await signup("uid-tess", { name: "Tess Varga", role: "athlete", sport: "golf" }, "tess@example.com", true);
    expect(r.status).toBe(200); expect(r.json.id).toBe(open);
    const [claim] = await db.select().from(identityClaims).where(eq(identityClaims.athlete_id, open));
    expect(claim).toMatchObject({ status: "confirmed", decided_by: "system", proof: "verified_unique_email" });
    const m = (await selfMembershipFor(open))!; expect(m.proof).toBe("verified_unique_email");
    const [au] = await db.select({ claim_id: athleteUsers.claim_id }).from(athleteUsers).where(eq(athleteUsers.id, m.id)); expect(au.claim_id).toBe(claim.id);
  });

  it("SECURITY: an UNVERIFIED e-mail neither links nor surfaces the row carrying it (no 409, no claim) — it creates a new row", async () => {
    const victim = await seedAthlete("Vera Okonkwo"); await db.update(athletes).set({ sport: "golf", status: "enriched", email: "vera@example.com" } as any).where(eq(athletes.id, victim));
    const r = await signup("uid-vera-attacker", { name: "Mallory Z", role: "athlete", sport: "curling" }, "vera@example.com", false);
    expect(r.status).toBe(201); expect(r.json.id).not.toBe(victim); expect(r.json).toMatchObject({ claimed: false });
    expect(await selfMembershipFor(victim)).toBeNull();
    expect((await db.select().from(identityClaims).where(eq(identityClaims.athlete_id, victim))).length).toBe(0);
    const [row] = await db.select({ auth_id: athletes.auth_id }).from(athletes).where(eq(athletes.id, victim));
    expect(row.auth_id).toBeNull();
    // the same address VERIFIED links (verified_unique_email)
    const owner = await signup("uid-vera", { name: "Vera Okonkwo", role: "athlete", sport: "golf" }, "vera@example.com", true);
    expect(owner.status).toBe(200); expect(owner.json.id).toBe(victim);
    expect((await selfMembershipFor(victim))!.proof).toBe("verified_unique_email");
  });
});

test("D-6: Microsoft Graph never asserts e-mail verification", () => {
  expect(microsoftEmailVerified({ mail: "a@b.c" })).toBe(false);
  expect(microsoftEmailVerified({ userPrincipalName: "a@b.c" })).toBe(false);
});
