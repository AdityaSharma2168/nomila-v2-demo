/**
 * index.test.ts — the Athlete Index on a real (PGlite + pg_trgm) Postgres with migration 0048 applied verbatim.
 *
 *   G3  the view's column set equals ATHLETE_INDEX_COLUMNS
 *   §2  field sources: ledger team (never athletes.school), fact sport over the column, handles by source class over
 *       the entered socials, research state read live, claimability derivable, no auth/email column in the view
 *   §4  findCandidates on a synthetic roster: near-duplicates, accents, nicknames, same-name-different-sport,
 *       the minimum-evidence rule (name-only never auto_match), same-name same-sport ⇒ candidate,
 *       a handle on two rows ⇒ ambiguous ⇒ candidate, unique handle ⇒ auto_match tier (matching only),
 *       anchors and rows with a user never auto_match
 *   §6  admin search returns index rows by name/alias
 */

jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { client, db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../../testUtils/pgliteDb";
import { athletes, athleteAffiliations, athleteFacts, athleteResearchState, goldenAthletes, socialIdentities } from "../../../../shared/schema";
import { ATHLETE_INDEX_COLUMNS, assertIndexShape, findCandidates, readIndexRecord, readIndexRecords, searchIndex, scoreCandidate, tierFor, type ScoredCandidate } from "./index";
import { DEFAULT_IDENTITY_POLICY } from "./policy";

const policy = DEFAULT_IDENTITY_POLICY;
const ids: Record<string, string> = {};

async function athlete(name: string, over: Partial<{ sport: string; school: string; status: string; email: string; auth_id: string; socials: Record<string, string> }> = {}): Promise<string> {
  const id = await seedAthlete(name);
  await db.update(athletes).set({ sport: over.sport ?? null, school: over.school ?? null, status: over.status ?? "raw", email: over.email ?? null, auth_id: over.auth_id ?? null, socials: over.socials ?? {} } as any).where(eq(athletes.id, id));
  return id;
}
const fact = (athleteId: string, key: string, value: unknown, valueText: string, over: Partial<{ origin: string; status: string }> = {}) =>
  db.insert(athleteFacts).values({ athlete_id: athleteId, fact_key: key, value: value as any, value_text: valueText, status: over.status ?? "current", retrieved_at: new Date("2026-09-01T00:00:00Z"), origin: over.origin ?? "research", source_class: over.origin === "athlete_asserted" ? null : "web_researched", authority_tier: over.origin === "athlete_asserted" ? null : 2, confidence: "0.90", provenance: {} as any, freshness_family: "identity", resolver_version: "v1", registry_version: "v1" });

beforeAll(async () => {
  await initTestDb();
  await client.exec(readFileSync(join(__dirname, "../../../../migrations/0048_athlete_index.sql"), "utf8"));
  await client.exec(readFileSync(join(__dirname, "../../../../migrations/0051_identity_users.sql"), "utf8"));   // Phase A Step 3a: re-creates the view (has_user via membership too)
  // ── the synthetic roster ──
  ids.mia = await athlete("Mia Bhuta", { sport: "soccer", school: "Stale School (projection)", status: "active", email: "mia@example.com", auth_id: "uid-mia", socials: { instagram: "@rileyathlete", twitter: "miab" } });
  await db.insert(athleteAffiliations).values({ athlete_id: ids.mia, org_name: "Example University", org_kind: "school", level: "D1", conference: "ACC", is_primary: true, kind: "said", started_on: "2024-08-01" });
  await db.insert(socialIdentities).values({ athlete_id: ids.mia, platform: "instagram", account_id: "178", account_id_kind: "platform_id", handle: "rileyathlete_official", source_class: "connected_verified", source_method: "connection", confidence: "1.00", status: "active" });
  await fact(ids.mia, "sport", { sport: "Soccer" }, "soccer", { origin: "athlete_asserted" });
  await fact(ids.mia, "alias", { text: "Mimi", kind: "nickname" }, "mimi", { origin: "athlete_asserted" });
  await fact(ids.mia, "class_year", { label: "Junior", season: 2026 }, "junior 2026");
  await fact(ids.mia, "hometown", { city: "Springfield", country: "US" }, "springfield us");
  await db.insert(athleteResearchState).values({ athlete_id: ids.mia, research_status: "research_complete", identity_confidence: "1.00", disputed_domains: ["profile"] as any, last_researched_at: new Date("2026-09-01T00:00:00Z") });

  ids.open = await athlete("Jordan Rivera", { sport: "basketball", school: "State University", status: "enriched", email: "jordan@example.com" });        // open: unclaimed with email
  await db.insert(athleteAffiliations).values({ athlete_id: ids.open, org_name: "State University", org_kind: "school", level: "D1", is_primary: true, kind: "said", started_on: "2024-08-01" });   // the athlete's word: full team weight
  ids.open2 = await athlete("Jordan Rivera", { sport: "basketball", school: "Coast College", status: "raw", email: "jr@example.com" });                   // same name, same sport
  ids.review = await athlete("Taylor Nguyen", { sport: "tennis", status: "raw" });                                                                        // discovery row: no auth, no email
  ids.wait = await athlete("Casey O'Neil", { sport: "swimming", status: "waitlisted" });                                                                  // waitlisted: open even without email
  ids.anchor = await athlete("Golden Anchor", { sport: "football", status: "raw" });
  await db.insert(goldenAthletes).values({ athlete_id: ids.anchor, ground_truth_source: "manual", active: true });
  ids.accent = await athlete("Zoë Müller-García", { sport: "volleyball", status: "raw", email: "zoe@example.com" });
  ids.handleA = await athlete("Sam Park", { sport: "golf", status: "raw", email: "sam1@example.com", socials: { instagram: "@sampark" } });
  ids.handleB = await athlete("Samuel Park", { sport: "golf", status: "raw", email: "sam2@example.com", socials: { instagram: "sampark" } });              // same entered handle on two rows
  ids.uniqueHandle = await athlete("Riley Chen", { sport: "track", status: "raw", email: "riley@example.com", socials: { tiktok: "@rileyruns" } });
  ids.lonely = await athlete("Avery Stone", { status: "raw", email: "avery@example.com" });                                                                // sparse: name only
  // review of PR #404 (ranking): a unique exact identifier outranks a high fuzzy-name score
  ids.lookalike = await athlete("Harper Lane", { sport: "fencing", status: "raw", email: "harper@example.com" });
  ids.owner = await athlete("Zed Quill", { sport: "fencing", status: "raw", email: "zed@example.com" });
  await db.insert(socialIdentities).values({ athlete_id: ids.owner, platform: "tiktok", account_id: "700", account_id_kind: "platform_id", handle: "harperlane", source_class: "platform_public", source_method: "discovery", confidence: "0.80", status: "active" });
  // review of PR #404: two active identities on one platform; the non-preferred one must still match exactly
  ids.twoIds = await athlete("Morgan Blake", { sport: "rowing", status: "raw", email: "morgan@example.com" });
  await db.insert(socialIdentities).values([
    { athlete_id: ids.twoIds, platform: "instagram", account_id: "900", account_id_kind: "platform_id", handle: "morganblake", source_class: "connected_verified", source_method: "connection", confidence: "1.00", status: "active" },
    { athlete_id: ids.twoIds, platform: "instagram", account_id: "901", account_id_kind: "platform_id", handle: "mb_rowing", source_class: "platform_public", source_method: "discovery", confidence: "0.80", status: "active" },
    { athlete_id: ids.twoIds, platform: "instagram", account_id: "902", account_id_kind: "handle", handle: "old_morgan", source_class: "web_researched", source_method: "research", confidence: "0.50", status: "superseded" },
  ]);
  // the same active handle on a second athlete where it is NOT the preferred projected handle: ambiguous
  ids.sharedAlt = await athlete("Quinn Blake", { sport: "rowing", status: "raw", email: "quinn@example.com" });
  await db.insert(socialIdentities).values([
    { athlete_id: ids.sharedAlt, platform: "instagram", account_id: "950", account_id_kind: "platform_id", handle: "quinnb", source_class: "connected_verified", source_method: "connection", confidence: "1.00", status: "active" },
    { athlete_id: ids.sharedAlt, platform: "instagram", account_id: "951", account_id_kind: "platform_id", handle: "mb_rowing", source_class: "platform_public", source_method: "discovery", confidence: "0.60", status: "active" },
  ]);
  for (let n = 0; n < 18; n++) await athlete(`Filler Person ${n}`, { sport: n % 2 ? "soccer" : "hockey", status: "raw" });
});
afterAll(closeTestDb);

describe("the view (§2, G3)", () => {
  it("G3: the live column set equals ATHLETE_INDEX_COLUMNS, and no auth/email column is exposed", async () => {
    await expect(assertIndexShape()).resolves.toBeUndefined();
    expect(ATHLETE_INDEX_COLUMNS).not.toContain("email"); expect(ATHLETE_INDEX_COLUMNS).not.toContain("auth_id");
  });

  it("fields come from the ledger, the facts, the identities and the research state — never athletes.school", async () => {
    const r = (await readIndexRecord(ids.mia))!;
    expect(r).toMatchObject({ fullName: "Mia Bhuta", nameNorm: "mia bhuta", sport: "Soccer", teamOrSchool: "Example University", orgKind: "school", level: "D1", affiliationKind: "said", classYear: 2026, cityOrCountry: "Springfield, US", researchStatus: "research_complete", identityConfidence: 1, disputedDomains: ["profile"], connectionStatus: "none", hasUser: true, claimability: "none", isGoldenAnchor: false, athleteStatus: "active" });
    expect(r.aliases).toEqual(["mimi"]);
    expect(r.knownSocialHandles.instagram).toMatchObject({ handle: "rileyathlete_official", sourceClass: "connected_verified" });   // identity beats the entered handle
    expect(r.knownSocialHandles.x).toMatchObject({ handle: "miab", sourceClass: "entered" });                                  // twitter → x
    expect(r.teamOrSchool).not.toBe("Stale School (projection)");
    expect((r as any).email).toBeUndefined();
  });

  it("readIndexRecords (2d-3 admin roster): bulk read by id, parameterized — same records as readIndexRecord, unknown ids absent, empty input empty", async () => {
    const m = await readIndexRecords([ids.mia, ids.open, "00000000-0000-0000-0000-000000000000"]);
    expect([...m.keys()].sort()).toEqual([ids.mia, ids.open].sort());
    expect(m.get(ids.mia)).toEqual(await readIndexRecord(ids.mia));
    expect(m.get(ids.open)).toEqual(await readIndexRecord(ids.open));
    expect((await readIndexRecords([])).size).toBe(0);
    await expect(readIndexRecords(["not-a-uuid'); drop table athletes; --"])).rejects.toThrow();   // a bound parameter, cast by Postgres — never spliced
    expect((await db.select({ id: athletes.id }).from(athletes).where(eq(athletes.id, ids.mia))).length).toBe(1);
  });

  it("Phase A Step 3a: a membership-only athlete (no auth_id projection) reads has_user=true and claimability none; the shape is unchanged", async () => {
    const { ensureUser, insertSelfMembership } = await import("./users");
    const memberOnly = await athlete("Member Only", { sport: "rugby", status: "raw", email: "member@example.com" });
    expect((await readIndexRecord(memberOnly))!).toMatchObject({ hasUser: false, claimability: "open" });
    const u = await ensureUser({ uid: "uid-member-only" });
    await insertSelfMembership({ athleteId: memberOnly, userId: u.id, proof: "verified_unique_email" });
    expect((await readIndexRecord(memberOnly))!).toMatchObject({ hasUser: true, claimability: "none" });
    await expect(assertIndexShape()).resolves.toBeUndefined();
    expect(ATHLETE_INDEX_COLUMNS.length).toBe(25);
  });

  it("claimability is derivable: open (email or waitlisted), review (no auth, no email), none (anchor or user); connection status derived", async () => {
    expect((await readIndexRecord(ids.open))!.claimability).toBe("open");
    expect((await readIndexRecord(ids.wait))!.claimability).toBe("open");
    expect((await readIndexRecord(ids.review))!).toMatchObject({ claimability: "review", researchStatus: "seed_only", identityConfidence: 0 });
    expect((await readIndexRecord(ids.anchor))!).toMatchObject({ claimability: "none", isGoldenAnchor: true });
    expect((await readIndexRecord(ids.mia))!.claimability).toBe("none");
    await seedConnection({ athleteId: ids.open, platform: "instagram", email: "jr_ig", status: "expired" });
    expect((await readIndexRecord(ids.open))!.connectionStatus).toBe("expired");
  });
});

describe("findCandidates (§4)", () => {
  const find = (q: Parameters<typeof findCandidates>[0]) => findCandidates(q, { policy, limit: 5 });

  it("fuzzy name + alias + accents: a near-duplicate spelling and a nickname both surface the right row", async () => {
    const r1 = await find({ name: "Mia Buta", sport: "soccer" });
    expect(r1.best!.record.athleteId).toBe(ids.mia); expect(r1.best!.signals.sportMatch).toBe(1);
    const r2 = await find({ name: "Mimi", sport: "soccer" });
    expect(r2.candidates.some((c) => c.record.athleteId === ids.mia)).toBe(true);
    const r3 = await find({ name: "Zoe Muller Garcia", sport: "volleyball" });
    expect(r3.best!.record.athleteId).toBe(ids.accent);
  });

  it("minimum-evidence rule: a sparse name-only record at high similarity is candidate, never auto_match", async () => {
    const r = await find({ name: "Avery Stone" });
    expect(r.best!.record.athleteId).toBe(ids.lonely);
    expect(r.best!.signals.nameSim).toBeGreaterThanOrEqual(0.97);
    expect(r.best!.matchScore).toBeGreaterThanOrEqual(0.9);
    expect(r.best!.corroborated).toBe(false);
    expect(r.tier).toBe("candidate");
  });

  it("same-name athletes in the same sport are candidate (the runner-up gap fails); a corroborated unique match is auto_match", async () => {
    const same = await find({ name: "Jordan Rivera", sport: "basketball" });
    expect(same.candidates.slice(0, 2).map((c) => c.record.athleteId).sort()).toEqual([ids.open, ids.open2].sort());
    expect(same.tier).toBe("candidate");
    const withTeam = await find({ name: "Jordan Rivera", sport: "basketball", teamOrSchool: "State University" });
    expect(withTeam.best!.record.athleteId).toBe(ids.open);
    expect(withTeam.best!.signals.teamMatch).toBeGreaterThan(0.6);
    expect(withTeam.candidates[1].signals.teamMatch).toBe(0);   // the same-name row has no team on record: a miss, not "unknown"
    expect(withTeam.tier).toBe("auto_match");   // matching tier only — no link without a claim proof (claim.test.ts)
  });

  it("a typed handle on two rows is ambiguous ⇒ candidate; a unique handle ⇒ auto_match tier (still not a proof)", async () => {
    const amb = await find({ name: "Sam Park", sport: "golf", handles: { instagram: "@SamPark" } });
    expect(amb.ambiguousIdentifier).toBe(true); expect(amb.tier).toBe("candidate");
    const uniq = await find({ name: "Riley Chen", handles: { tiktok: "rileyruns" } });
    expect(uniq.best!.record.athleteId).toBe(ids.uniqueHandle); expect(uniq.best!.uniqueIdentifier).toBe(true); expect(uniq.tier).toBe("auto_match");
  });

  it("a unique exact handle outranks a very high fuzzy-name score: the identifier's owner is best and the tier is auto_match", async () => {
    const r = await find({ name: "Harper Lane", handles: { tiktok: "@HarperLane" } });
    expect(r.best!.record.athleteId).toBe(ids.owner);
    expect(r.best!.uniqueIdentifier).toBe(true); expect(r.best!.signals.handleExact).toBe(1);
    expect(r.best!.signals.nameSim).toBeLessThan(0.5);
    expect(r.candidates[1].record.athleteId).toBe(ids.lookalike); expect(r.candidates[1].signals.nameSim).toBeGreaterThan(0.95);
    expect(r.tier).toBe("auto_match");
    // without the identifier the lookalike is best again
    expect((await find({ name: "Harper Lane" })).best!.record.athleteId).toBe(ids.lookalike);
  });

  it("a unique exact email (server-side) outranks a very high fuzzy-name score the same way", async () => {
    const r = await find({ name: "Harper Lane", email: "ZED@example.com" });
    expect(r.best!.record.athleteId).toBe(ids.owner); expect(r.best!.uniqueIdentifier).toBe(true); expect(r.best!.signals.emailExact).toBe(1);
    expect(r.tier).toBe("auto_match");
  });

  it("exact handles use ALL active identities: the non-preferred handle still matches; a superseded one does not", async () => {
    const r = await find({ name: "Morgan Blake", handles: { instagram: "@MB_Rowing" } });
    const hit = r.candidates.find((c) => c.record.athleteId === ids.twoIds)!;
    expect(hit.signals.handleExact).toBe(1);
    expect(hit.record.knownSocialHandles.instagram.handle).toBe("morganblake");   // the view still projects the preferred handle
    const gone = await find({ name: "Morgan Blake", handles: { instagram: "old_morgan" } });
    expect(gone.candidates.find((c) => c.record.athleteId === ids.twoIds)!.signals.handleExact).toBe(0);
  });

  it("the same active handle on two athletes is ambiguous even when one occurrence is not the projected handle", async () => {
    const r = await find({ name: "Blake", sport: "rowing", handles: { instagram: "mb_rowing" } });
    expect(r.ambiguousIdentifier).toBe(true); expect(r.tier).toBe("candidate");
    expect(r.candidates.filter((c) => c.signals.handleExact === 1).map((c) => c.record.athleteId).sort()).toEqual([ids.sharedAlt, ids.twoIds].sort());
    expect(r.candidates.every((c) => !c.uniqueIdentifier)).toBe(true);
  });

  it("an anchor, a review row or a row with a user never reaches auto_match", async () => {
    const anchor = await find({ name: "Golden Anchor", sport: "football" });
    expect(anchor.best!.record.athleteId).toBe(ids.anchor); expect(anchor.tier).toBe("candidate");
    const review = await find({ name: "Taylor Nguyen", sport: "tennis" });
    expect(review.best!.record.claimability).toBe("review"); expect(review.tier).toBe("candidate");
    const user = await find({ name: "Mia Bhuta", sport: "soccer", teamOrSchool: "Example University" });
    expect(user.best!.record.hasUser).toBe(true); expect(user.tier).toBe("candidate");
  });

  it("a stranger's name is new; email is a server-side matching signal that counts only when unique", async () => {
    expect((await find({ name: "Nobody Here" })).tier).toBe("new");
    const byEmail = await find({ name: "Someone Else", email: "jordan@example.com" });
    expect(byEmail.best!.record.athleteId).toBe(ids.open); expect(byEmail.best!.signals.emailExact).toBe(1); expect(byEmail.best!.uniqueIdentifier).toBe(true);
  });

  it("admin search returns index rows by name or alias, filtered by legacy status", async () => {
    expect((await searchIndex("mimi", { status: "active" })).map((r) => r.athleteId)).toEqual([ids.mia]);
    expect((await searchIndex("jordan rivera", { status: "raw" })).map((r) => r.athleteId)).toEqual([ids.open2]);
    expect(await searchIndex("   ")).toEqual([]);
  });
});

describe("pure scoring and tiers", () => {
  const rec = (over: Partial<ScoredCandidate["record"]> = {}): ScoredCandidate["record"] => ({ athleteId: "a", fullName: "X", nameNorm: "x", aliases: [], sport: null, teamOrSchool: null, orgKind: null, level: null, conference: null, affiliationKind: null, classYear: null, graduationYear: null, cityOrCountry: null, knownSocialHandles: {}, identityConfidence: 0, researchStatus: "seed_only", disputedDomains: [], lastResearchedAt: null, nextDueAt: null, connectionStatus: "none", hasUser: false, claimability: "open", isGoldenAnchor: false, athleteStatus: "raw", indexUpdatedAt: null, ...over });
  const raw = (record: ScoredCandidate["record"], sims: Partial<{ simFull: number; simNorm: number; simFact: number; simTeam: number | null; emailExact: boolean; handleExactPlatforms: string[] }> = {}) => ({ record, simFull: 0, simNorm: 0, simFact: 0, simTeam: null, emailExact: false, handleExactPlatforms: [], ...sims });

  it("null signals re-normalize the weights; a found affiliation weakens team; corroboration needs a non-name signal", () => {
    const nameOnly = scoreCandidate({ name: "x" }, raw(rec(), { simFull: 0.95 }), policy);
    expect(nameOnly.matchScore).toBe(0.95); expect(nameOnly.corroborated).toBe(false);
    const found = scoreCandidate({ name: "x", teamOrSchool: "T" }, raw(rec({ teamOrSchool: "T", affiliationKind: "found" }), { simFull: 0.9, simTeam: 1 }), policy);
    expect(found.signals.teamMatch).toBe(0.7); expect(found.corroborated).toBe(true);
    const sportOnly = scoreCandidate({ name: "x", sport: "Soccer" }, raw(rec({ sport: "soccer" }), { simFull: 0.9 }), policy);
    expect(sportOnly.signals.sportMatch).toBe(1); expect(sportOnly.corroborated).toBe(true);
  });

  it("tierFor: auto_match needs open claimability, corroboration and the gap, or a unique identifier; ambiguity forces candidate", () => {
    const mk = (score: number, over: Partial<ScoredCandidate> = {}): ScoredCandidate => ({ record: rec(), signals: { nameSim: score, sportMatch: null, teamMatch: null, yearMatch: null, handleExact: null, emailExact: null }, matchScore: score, corroborated: false, uniqueIdentifier: false, ...over });
    expect(tierFor([mk(0.97)], false, policy)).toBe("candidate");                                             // name only
    expect(tierFor([mk(0.95, { corroborated: true })], false, policy)).toBe("auto_match");
    expect(tierFor([mk(0.95, { corroborated: true }), mk(0.9, { corroborated: true })], false, policy)).toBe("candidate");   // gap 0.05 < 0.15
    expect(tierFor([mk(0.95, { corroborated: true })], true, policy)).toBe("candidate");                       // ambiguous identifier
    expect(tierFor([mk(0.5, { uniqueIdentifier: true })], false, policy)).toBe("auto_match");
    expect(tierFor([mk(0.95, { corroborated: true, record: rec({ claimability: "none", hasUser: true }) })], false, policy)).toBe("candidate");
    expect(tierFor([mk(0.95, { corroborated: true, record: rec({ claimability: "review" }) })], false, policy)).toBe("candidate");
    expect(tierFor([mk(0.5)], false, policy)).toBe("new");
    expect(tierFor([], false, policy)).toBe("new");
  });
});
