/**
 * claim.test.ts — claim proof, the decision matrix, the protected link and the creation-path resolver
 * (design §4.4–4.5, §5) on PGlite with migration 0048 applied.
 *
 *   a typed public handle never links; an unverified email never links; an email shared by two rows never links;
 *   a unique verified email links and writes claimed_at; linkUserToAthlete throws on `none`; an auto_match tier
 *   with proof `none` creates + records possible_duplicate; existing auth is authoritative; anchors never linked
 */

jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { client, db, initTestDb, closeTestDb, seedAthlete } from "../../../testUtils/pgliteDb";
import { athletes, athleteIndexMatches, goldenAthletes, athleteUsers } from "../../../../shared/schema";
import { claimProofFor, decide, proofMayLink } from "./claim";
import { ClaimNotAuthorized, linkUserToAthlete } from "./link";
import { finalizeResolution, resolveIdentity } from "./resolve";
import { __resetIdentityPolicyCache } from "./config";

const ids: Record<string, string> = {};
async function athlete(name: string, over: Partial<{ sport: string; status: string; email: string; auth_id: string; socials: Record<string, string> }> = {}): Promise<string> {
  const id = await seedAthlete(name);
  await db.update(athletes).set({ sport: over.sport ?? null, status: over.status ?? "raw", email: over.email ?? null, auth_id: over.auth_id ?? null, socials: over.socials ?? {} } as any).where(eq(athletes.id, id));
  return id;
}
const row = (id: string) => db.select().from(athletes).where(eq(athletes.id, id)).then((r) => r[0]);
const matches = () => db.select().from(athleteIndexMatches);

beforeAll(async () => {
  await initTestDb();
  await client.exec(readFileSync(join(__dirname, "../../../../migrations/0048_athlete_index.sql"), "utf8"));
  __resetIdentityPolicyCache();
  ids.pub = await athlete("Dana Whitfield", { sport: "soccer", status: "enriched", email: "dana@example.com", socials: { instagram: "@danaw" } });
  ids.shared1 = await athlete("Pat Lee", { sport: "golf", status: "raw", email: "family@example.com" });
  ids.shared2 = await athlete("Robin Lee", { sport: "golf", status: "raw", email: "family@example.com" });
  ids.anchor = await athlete("Anchor Person", { sport: "football", status: "raw" });
  await db.insert(goldenAthletes).values({ athlete_id: ids.anchor, ground_truth_source: "manual", active: true });
  ids.owned = await athlete("Owned Row", { sport: "tennis", status: "active", email: "owned@example.com", auth_id: "uid-owner" });
});
afterAll(closeTestDb);
beforeEach(() => db.delete(athleteIndexMatches));

describe("claim proof (pure)", () => {
  const caller = (over: Partial<{ email: string | null; emailVerified: boolean }> = {}) => ({ uid: "uid-new", email: "dana@example.com", emailVerified: true, ...over });
  it("only existing auth or a unique verified email are proofs; public evidence never is", () => {
    expect(claimProofFor({ caller: caller(), candidateAuthId: "uid-new", emailMatchesCandidate: false, unclaimedEmailRows: 0 })).toBe("existing_auth");
    expect(claimProofFor({ caller: caller(), candidateAuthId: null, emailMatchesCandidate: true, unclaimedEmailRows: 1 })).toBe("verified_unique_email");
    expect(claimProofFor({ caller: caller({ emailVerified: false }), candidateAuthId: null, emailMatchesCandidate: true, unclaimedEmailRows: 1 })).toBe("none");
    expect(claimProofFor({ caller: caller(), candidateAuthId: null, emailMatchesCandidate: true, unclaimedEmailRows: 2 })).toBe("none");
    expect(claimProofFor({ caller: caller(), candidateAuthId: "uid-other", emailMatchesCandidate: true, unclaimedEmailRows: 1 })).toBe("none");
    expect(claimProofFor({ caller: caller({ email: null }), candidateAuthId: null, emailMatchesCandidate: false, unclaimedEmailRows: 0 })).toBe("none");
    // 3b (D-4): verified_social_ownership links when the other row has no self-member; human_confirmation only inside linkUserToAthlete's guard
    expect(proofMayLink("verified_social_ownership")).toBe(true); expect(proofMayLink("human_confirmation")).toBe(true); expect(proofMayLink("none")).toBe(false);
  });
  it("the decision matrix: a proof links; every tier alone creates and records", () => {
    expect(decide("auto_match", "existing_auth")).toBe("linked_by_auth");
    expect(decide("candidate", "verified_unique_email")).toBe("linked_by_verified_email");
    expect(decide("auto_match", "none")).toBe("possible_duplicate");
    expect(decide("candidate", "none")).toBe("possible_duplicate");
    expect(decide("new", "none")).toBe("new");
    // 3b: the proof-specific decisions; a human click alone stays possible_duplicate; an operator's confirm is its own decision
    expect(decide("candidate", "verified_social_ownership")).toBe("linked_by_ownership");
    expect(decide("candidate", "human_confirmation")).toBe("possible_duplicate");
    expect(decide("candidate", "none", { operator: true })).toBe("linked_by_operator");
  });
});

describe("linkUserToAthlete", () => {
  it("throws on proof none (and on a match tier, which is never a proof); links on a linking proof, writes claimed_at, preserves an operator's status", async () => {
    await expect(linkUserToAthlete(ids.pub, "uid-x", "firebase", "none")).rejects.toBeInstanceOf(ClaimNotAuthorized);
    await expect(linkUserToAthlete(ids.pub, "uid-x", "firebase", "human_confirmation")).rejects.toBeInstanceOf(ClaimNotAuthorized);   // 3b (D-14): a click alone never links a pre-existing row
    expect((await row(ids.pub)).auth_id).toBeNull();
    const at = new Date("2026-09-11T10:00:00Z");
    await expect(linkUserToAthlete(ids.pub, "uid-x", "firebase", "verified_unique_email", at)).resolves.toMatchObject({ status: "claimed" });
    expect(await row(ids.pub)).toMatchObject({ auth_id: "uid-x", auth_provider: "firebase", status: "claimed" });
    expect((await row(ids.pub)).claimed_at!.toISOString()).toBe(at.toISOString());
    // never re-bind a row that already has a user
    await expect(linkUserToAthlete(ids.owned, "uid-x", "firebase", "verified_unique_email")).rejects.toBeInstanceOf(ClaimNotAuthorized);
    // an active row keeps its status on link
    const active = await athlete("Active Unclaimed", { status: "active", email: "act@example.com" });
    await expect(linkUserToAthlete(active, "uid-act", "firebase", "verified_unique_email")).resolves.toMatchObject({ status: "active" });
    // reset for the resolver tests below (Phase A Step 3a: the membership is the authority — drop it with the projection)
    await db.delete(athleteUsers).where(eq(athleteUsers.athlete_id, ids.pub));
    await db.update(athletes).set({ auth_id: null, auth_provider: null, status: "enriched", claimed_at: null } as any).where(eq(athletes.id, ids.pub));
  });
});

describe("linkUserToAthlete is atomic (review of PR #404)", () => {
  it("two different uids concurrently claim the same unclaimed athlete: exactly one wins, the other is refused, the winner is never overwritten", async () => {
    const target = await athlete("Race Target", { status: "raw", email: "race@example.com" });
    const results = await Promise.allSettled([
      linkUserToAthlete(target, "uid-race-1", "firebase", "verified_unique_email"),
      linkUserToAthlete(target, "uid-race-2", "firebase", "verified_unique_email"),
    ]);
    const wins = results.filter((r) => r.status === "fulfilled"); const losses = results.filter((r) => r.status === "rejected");
    expect(wins).toHaveLength(1); expect(losses).toHaveLength(1);
    expect((losses[0] as PromiseRejectedResult).reason).toBeInstanceOf(ClaimNotAuthorized);
    const after = await row(target);
    expect(["uid-race-1", "uid-race-2"]).toContain(after.auth_id);
    const winner = after.auth_id!; const loser = winner === "uid-race-1" ? "uid-race-2" : "uid-race-1";
    // the loser cannot overwrite afterwards; the winner is idempotent and keeps claimed_at
    await expect(linkUserToAthlete(target, loser, "firebase", "verified_unique_email")).rejects.toBeInstanceOf(ClaimNotAuthorized);
    const claimedAt = after.claimed_at!.toISOString();
    await expect(linkUserToAthlete(target, winner, "firebase", "verified_unique_email", new Date("2030-01-01T00:00:00Z"))).resolves.toMatchObject({ status: "claimed" });
    expect((await row(target)).auth_id).toBe(winner); expect((await row(target)).claimed_at!.toISOString()).toBe(claimedAt);
  });
});

describe("resolveIdentity (the creation paths)", () => {
  it("a typed public handle + exact name + sport (auto_match tier) with no proof ⇒ ask first (3b: claims proposed, no link); the create after 'none of these' records possible_duplicate", async () => {
    const r = await resolveIdentity({ path: "signup", caller: { uid: "uid-stranger", email: "stranger@example.com", emailVerified: true }, provider: "firebase", query: { name: "Dana Whitfield", sport: "soccer", handles: { instagram: "@danaw" } } });
    expect(r.tier).toBe("auto_match"); expect(r.proof).toBe("none"); expect(r.action).toBe("confirm"); expect(r.decision).toBe("possible_duplicate");
    expect(r.claimSessionId).toMatch(/^[0-9a-f-]{36}$/); expect(r.claims!.some((c) => c.athleteId === ids.pub)).toBe(true);
    expect((await row(ids.pub)).auth_id).toBeNull();
    const created = await athlete("Dana Whitfield", { status: "raw", email: "stranger@example.com", auth_id: "uid-stranger" });
    await finalizeResolution(r, created);
    const ms = await matches();
    expect(ms.length).toBe(2);   // the proposal (chosen = the best candidate) and the create
    expect(ms.find((m) => m.created_athlete_id === created)).toMatchObject({ path: "signup", tier: "auto_match", claim_proof: "none", decision: "possible_duplicate", chosen_athlete_id: ids.pub, policy_version: "defaults" });
    for (const m of ms) { expect(JSON.stringify(m.query)).not.toContain("stranger@example.com"); expect(JSON.stringify(m)).not.toContain("uid-stranger"); }
  });

  it("an unverified email never links; an email shared by two rows never links", async () => {
    const unverified = await resolveIdentity({ path: "signup", caller: { uid: "uid-u", email: "dana@example.com", emailVerified: false }, provider: "firebase", query: { name: "Dana Whitfield" } });
    expect(unverified.action).toBe("confirm"); expect(unverified.proof).toBe("none");   // 3b: candidates ⇒ ask; never a link
    expect((await row(ids.pub)).auth_id).toBeNull();
    const shared = await resolveIdentity({ path: "signup", caller: { uid: "uid-s", email: "family@example.com", emailVerified: true }, provider: "firebase", query: { name: "Pat Lee", sport: "golf" } });
    expect(shared.action).toBe("confirm"); expect(shared.proof).toBe("none"); expect(shared.result.ambiguousIdentifier).toBe(true);
    expect((await row(ids.shared1)).auth_id).toBeNull(); expect((await row(ids.shared2)).auth_id).toBeNull();
  });

  it("a unique verified email links (claimed_at written, match recorded); existing auth is authoritative afterwards", async () => {
    const r = await resolveIdentity({ path: "signup", caller: { uid: "uid-dana", email: "Dana@Example.com", emailVerified: true }, provider: "firebase", query: { name: "D. Whitfield" } });
    expect(r).toMatchObject({ action: "linked", athleteId: ids.pub, proof: "verified_unique_email", decision: "linked_by_verified_email", status: "claimed" });
    expect(await row(ids.pub)).toMatchObject({ auth_id: "uid-dana", status: "claimed" }); expect((await row(ids.pub)).claimed_at).not.toBeNull();
    const [m] = await matches(); expect(m).toMatchObject({ decision: "linked_by_verified_email", chosen_athlete_id: ids.pub });
    const again = await resolveIdentity({ path: "signup", caller: { uid: "uid-dana", email: "dana@example.com", emailVerified: true }, provider: "firebase", query: { name: "Dana Whitfield" } });
    expect(again).toMatchObject({ action: "existing", athleteId: ids.pub, proof: "existing_auth" });
  });

  it("a golden anchor is never linked, whatever the caller supplies", async () => {
    const r = await resolveIdentity({ path: "signup", caller: { uid: "uid-a", email: "anchor@example.com", emailVerified: true }, provider: "firebase", query: { name: "Anchor Person", sport: "football" } });
    expect(r.result.best?.record.isGoldenAnchor).toBe(true);
    expect(r.action).toBe("confirm"); expect((await row(ids.anchor)).auth_id).toBeNull();
  });
});
