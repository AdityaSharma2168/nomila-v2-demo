/**
 * affiliations.test.ts — teams as dated facts, on PGlite.
 *
 * Pinned:
 *   • coerceTeams: objects and Mila's line grammar both parse; one primary among current teams
 *     (the marked one, else the highest level); a past team is never primary; dupes collapse
 *   • coerceCareerStatus: slugs, labels, "retired 2024", objects
 *   • replaceSaidAffiliations: replaces said rows, keeps found rows unless the athlete confirms the
 *     same team, projects the primary current row onto athletes.school/division/conference
 *   • the ledger door: recordAssertions('affiliations') writes rows + a receipt; undo restores the
 *     previous list; career_status projects its slug and undo puts it back
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { athleteAffiliations, athleteAsserted, athleteFacts, athletes, agentActions } from "../../shared/schema";
import { coerceTeams, coerceCareerStatus, replaceSaidAffiliations, listAffiliations, primaryAffiliation, displayTeams, proposeFoundAffiliations, teamsFromAchievements, levelRecordFor, teamsLineFor, projectPrimary } from "./affiliations";
import { recordAssertions, undoProfileWrite, latestAssertions } from "../mila/onboarding";

let athleteId: string;

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Mia Bhuta");
  await db.update(athletes).set({ school: "Stanford University", division: "D1", conference: "ACC" } as any).where(eq(athletes.id, athleteId));
}, 30_000);
afterAll(closeTestDb);
beforeEach(async () => {
  await db.delete(athleteAffiliations);
  // The ledger rows point at their receipts; clear them first or the FK blocks the receipts' delete.
  await db.delete(athleteAsserted);
  await db.delete(agentActions);
});

test("coerceTeams: objects, the line grammar, one primary among current teams, past never primary", () => {
  const fromObjects = coerceTeams([
    { org: "Stanford University", kind: "school", level: "D1", conference: "ACC", position: "midfielder", from: "2023" },
    { org: "U-17 USWNT", kind: "national", role: "captain", from: "2022", to: "2022" },
  ]);
  expect(fromObjects.map((t) => [t.org, t.kind, t.primary, t.from, t.to])).toEqual([
    ["Stanford University", "school", true, "2023-01-01", null],
    ["U-17 USWNT", "national", false, "2022-01-01", "2022-01-01"],
  ]);
  const fromLines = coerceTeams("Angel City FC | pro | NWSL | forward | 2026- \n USWNT | national | senior | | 2025-");
  // Neither marked primary → the highest level (national) is primary.
  expect(fromLines.map((t) => [t.org, t.primary])).toEqual([["Angel City FC", false], ["USWNT", true]]);
  const marked = coerceTeams("Angel City FC | pro | NWSL | forward | 2026- | primary; USWNT | national | | | 2025-");
  expect(marked.map((t) => [t.org, t.primary])).toEqual([["Angel City FC", true], ["USWNT", false]]);
  expect(() => coerceTeams("Somewhere | ???")).toThrow(/kind/);
  expect(displayTeams(marked)).toBe("Angel City FC · pro (current, primary); USWNT · national (current)");
});

test("coerceCareerStatus: slug, label, sentence with a year, object", () => {
  expect(coerceCareerStatus("retired")).toEqual({ status: "retired", since: null });
  expect(coerceCareerStatus("Retired 2024")).toEqual({ status: "retired", since: "2024" });
  expect(coerceCareerStatus("between teams")).toEqual({ status: "between_teams", since: null });
  expect(coerceCareerStatus("playing")).toEqual({ status: "active", since: null });
  expect(coerceCareerStatus({ status: "out_this_season", since: "2026" })).toEqual({ status: "out_this_season", since: "2026" });
  expect(() => coerceCareerStatus("sabbatical")).toThrow();
});

test("replaceSaidAffiliations keeps found rows, replaces said rows, projects the primary onto the athlete", async () => {
  await db.insert(athleteAffiliations).values([
    { athlete_id: athleteId, org_name: "U-17 USWNT", org_kind: "national", started_on: "2022-01-01", ended_on: "2022-12-31", kind: "found", source: "research" },
    { athlete_id: athleteId, org_name: "stanford university", org_kind: "school", level: "D1", kind: "found", source: "research", is_primary: true },
  ] as any);
  await replaceSaidAffiliations({ athleteId, source: "onboarding", teams: [
    { org: "Stanford University", kind: "school", level: "D1", conference: "ACC", position: "midfielder", from: "2023", primary: true },
    { org: "Ohio Premier", kind: "club", from: "2019", to: "2022" },
  ] });
  const rows = await listAffiliations(athleteId);
  // The found Stanford row yielded to the said one; the found national row survived; order = current first.
  // Order: current first; past teams most recently ended first (U-17 ended Dec 2022, Ohio Premier Jan 2022).
  expect(rows.map((r) => [r.org, r.kindOfFact, r.current, r.primary])).toEqual([
    ["Stanford University", "said", true, true],
    ["U-17 USWNT", "found", false, false],
    ["Ohio Premier", "said", false, false],
  ]);
  const [a] = await db.select({ school: athletes.school, division: athletes.division, conference: athletes.conference }).from(athletes).where(eq(athletes.id, athleteId));
  expect(a).toEqual({ school: "Stanford University", division: "D1", conference: "ACC" });
  expect((await primaryAffiliation(athleteId))?.org).toBe("Stanford University");

  // A trade: end Stanford, add a pro team → the projection follows.
  await replaceSaidAffiliations({ athleteId, source: "settings", teams: [
    { org: "Stanford University", kind: "school", level: "D1", conference: "ACC", from: "2023", to: "2027-06" },
    { org: "Gotham FC", kind: "pro", level: "NWSL", from: "2027-07" },
  ] });
  const [b] = await db.select({ school: athletes.school, division: athletes.division, conference: athletes.conference }).from(athletes).where(eq(athletes.id, athleteId));
  expect(b).toEqual({ school: "Gotham FC", division: "NWSL", conference: null });
});

test("the ledger door: affiliations and career_status write rows + receipts; undo restores both", async () => {
  const [saved] = await recordAssertions({ athleteId, runId: null, mode: "chat", corrections: [
    { field: "affiliations", value: "Stanford University | school | D1 | midfielder | 2023- | primary; U-17 USWNT | national | | captain | 2022-2022", said: "Just Stanford right now, I was with the U-17s before" },
  ] });
  expect(saved.field).toBe("affiliations");
  expect(saved.value).toBe("Stanford University · D1 (current, primary); U-17 USWNT · national (2022–2022)");
  expect((await listAffiliations(athleteId)).map((r) => r.org)).toEqual(["Stanford University", "U-17 USWNT"]);

  const [second] = await recordAssertions({ athleteId, runId: null, mode: "form", source: "settings", corrections: [
    { field: "affiliations", value: [{ org: "Gotham FC", kind: "pro", level: "NWSL", from: "2027" }] },
  ] });
  expect((await listAffiliations(athleteId)).map((r) => r.org)).toEqual(["Gotham FC"]);
  const [receipt] = await db.select().from(agentActions).where(eq(agentActions.id, second.agent_action_id));
  await undoProfileWrite(receipt);
  expect((await listAffiliations(athleteId)).map((r) => r.org)).toEqual(["Stanford University", "U-17 USWNT"]);
  const [afterUndo] = await db.select({ school: athletes.school }).from(athletes).where(eq(athletes.id, athleteId));
  expect(afterUndo.school).toBe("Stanford University");

  const [career] = await recordAssertions({ athleteId, runId: null, mode: "chat", corrections: [{ field: "career_status", value: "retired 2024", said: "Done. Retired after 2024." }] });
  expect(career.value).toBe("Retired · 2024");
  let [c] = await db.select({ cs: athletes.career_status }).from(athletes).where(eq(athletes.id, athleteId));
  expect(c.cs).toBe("retired");
  const facts = await latestAssertions(athleteId);
  expect(facts.find((f) => f.field === "career_status")?.value).toBe("Retired · 2024");
  const [careerReceipt] = await db.select().from(agentActions).where(eq(agentActions.id, career.agent_action_id));
  await undoProfileWrite(careerReceipt);
  [c] = await db.select({ cs: athletes.career_status }).from(athletes).where(eq(athletes.id, athleteId));
  expect(c.cs).toBe("active");
});

test("teamsFromAchievements: national and Olympic programmes only, generic patterns, deduped", () => {
  const found = teamsFromAchievements([
    { name: "U-17 USWNT Captain" },                                          // undated …
    { name: "First to captain the U-17 Women's World Cup team", year: 2022 }, // … the same programme, dated
    { name: "First player to compete for USWNT at FIFA World Cup level" },   // senior mention, no year → skipped
    { name: "ACC Champion", year: 2025 },              // a conference honour, not a team
    { name: "U-18 club player of the year", year: 2020 }, // an age token alone is not a national team
    { name: "Olympic silver medal", year: 2024 },
    { name: "Canada national team debut", year: 2023 },
  ]);
  // Grouped by programme: the undated U-17 captaincy takes the year from the dated World Cup line;
  // a programme with no year at all is skipped (it would read as current). Years, not dates —
  // coerceTeams turns them into dates when the rows are written.
  expect(found.map((t) => [t.org, t.kind, t.level, t.role, t.from])).toEqual([
    ["U-17 USWNT", "national", "U-17", "captain", "2022"],
    ["Olympic team", "olympic", null, null, "2024"],
    ["national team", "national", "senior", null, "2023"],
  ]);
});

test("proposeFoundAffiliations adds found rows, never a primary, never over a said row, and dedupes", async () => {
  await replaceSaidAffiliations({ athleteId, source: "onboarding", teams: [{ org: "Stanford University", kind: "school", level: "D1", from: "2023", primary: true }] });
  const added = await proposeFoundAffiliations({ athleteId, source: "research", teams: [
    { org: "stanford university", kind: "school", level: "D1", from: "2023" },          // already hers → skipped
    { org: "U-17 USWNT", kind: "national", level: "U-17", role: "captain", from: "2022", to: "2022" },
    { org: "Angel City FC", kind: "pro", level: "NWSL", from: "2026" },                // a found CURRENT team
  ] });
  expect(added.map((a) => [a.org, a.kindOfFact, a.primary])).toEqual([["Angel City FC", "found", false], ["U-17 USWNT", "found", false]]);
  // an undated proposal is refused: it would read as a current team
  expect(await proposeFoundAffiliations({ athleteId, source: "research", teams: [{ org: "Somewhere FC", kind: "pro" }] })).toEqual([]);
  // a found CURRENT pro team does not set the level while a said team exists
  expect(await levelRecordFor(athleteId)).toMatchObject({ org: "Stanford University", segment: "college" });
  const rows = await listAffiliations(athleteId);
  expect(rows.filter((r) => r.primary).map((r) => r.org)).toEqual(["Stanford University"]); // the said primary stands
  const [a] = await db.select({ school: athletes.school }).from(athletes).where(eq(athletes.id, athleteId));
  expect(a.school).toBe("Stanford University"); // the projection did not move
  // a second proposal of the same teams adds nothing
  expect(await proposeFoundAffiliations({ athleteId, source: "research", teams: [{ org: "U-17 USWNT", kind: "national" }] })).toEqual([]);
});

test("levelRecordFor: highest current team sets the level; retired reads the highest ever held; no rows → the row's columns", async () => {
  // no rows yet → fallback
  expect(await levelRecordFor(athleteId, { division: "D1", conference: "ACC", segment: "college" })).toMatchObject({ org: null, division: "D1", conference: "ACC", segment: "college" });

  // school + a youth national team in the past → college, D1, the school's conference
  await replaceSaidAffiliations({ athleteId, source: "onboarding", teams: [
    { org: "Stanford University", kind: "school", level: "D1", conference: "ACC", from: "2023", primary: true },
    { org: "U-17 national team", kind: "national", level: "U-17", from: "2022", to: "2022" },
  ] });
  expect(await levelRecordFor(athleteId)).toMatchObject({ org: "Stanford University", segment: "college", division: "D1", conference: "ACC", alsoNational: false });

  // pro club + senior national team, both current → top tier from the national side, two shirts
  await replaceSaidAffiliations({ athleteId, source: "settings", teams: [
    { org: "Angel City FC", kind: "pro", level: "NWSL", from: "2026", primary: true },
    { org: "National team", kind: "national", level: "senior", from: "2025" },
  ] });
  expect(await levelRecordFor(athleteId)).toMatchObject({ org: "National team", segment: "olympic", alsoNational: false });

  // retired: every row ended → the highest level ever held, no current team
  await replaceSaidAffiliations({ athleteId, source: "settings", teams: [
    { org: "Angel City FC", kind: "pro", level: "NWSL", from: "2022", to: "2024" },
    { org: "Some High School", kind: "school", level: "High School", from: "2015", to: "2019" },
  ] });
  expect(await levelRecordFor(athleteId)).toMatchObject({ org: "Angel City FC", segment: "pro", division: "Pro" });

  // a high-school athlete
  await replaceSaidAffiliations({ athleteId, source: "settings", teams: [{ org: "Some High School", kind: "school", level: "High School", from: "2024" }] });
  expect(await levelRecordFor(athleteId)).toMatchObject({ segment: "high_school", division: "High School" });

  expect(await teamsLineFor(athleteId)).toBe("Some High School (school, High School, current, primary)");
});

// ─── Phase A Step 2d-6 (§4.4, D11, C13; review decisions Q1/Q2): the projection follows the PRIMARY current row only ───

test("2d-6: projectPrimary writes the primary current row (conference normalised) and NULL when there is none — retired, or only non-primary current rows", async () => {
  const a = await seedAthlete("Projection Athlete");
  await db.update(athletes).set({ school: "Stale U", division: "D3", conference: "Old" } as any).where(eq(athletes.id, a));
  const proj = async () => (await db.select({ school: athletes.school, division: athletes.division, conference: athletes.conference, segment: athletes.segment }).from(athletes).where(eq(athletes.id, a)))[0];
  // no rows at all ⇒ NULL (the stale values are NOT kept — C13)
  expect(await projectPrimary(a)).toEqual({ school: null, division: null, conference: null });
  expect(await proj()).toEqual({ school: null, division: null, conference: null, segment: "unknown" });
  // a primary current row ⇒ projected, conference in the one normalised form (D11)
  await db.insert(athleteAffiliations).values({ athlete_id: a, org_name: "Example University", org_kind: "school", level: "D1", conference: "Atlantic Coast Conference (ACC)", is_primary: true, kind: "said", source: "onboarding", started_on: "2024-08-01" });
  expect(await projectPrimary(a)).toEqual({ school: "Example University", division: "D1", conference: "ACC" });
  expect((await proj()).segment).toBe("college");
  expect((await levelRecordFor(a)).conference).toBe("ACC");   // Q1: the ledger-derived level reads the same representation
  // Q2: current rows exist but none is primary ⇒ NULL, never the newest current
  await db.update(athleteAffiliations).set({ is_primary: false }).where(eq(athleteAffiliations.athlete_id, a));
  await db.insert(athleteAffiliations).values({ athlete_id: a, org_name: "Newer Club", org_kind: "club", kind: "found", source: "research", started_on: "2026-01-01" });
  expect(await projectPrimary(a)).toEqual({ school: null, division: null, conference: null });
  // retired: every row ended ⇒ NULL
  await db.update(athleteAffiliations).set({ ended_on: "2026-06-30", is_primary: true }).where(eq(athleteAffiliations.athlete_id, a));
  expect(await projectPrimary(a)).toEqual({ school: null, division: null, conference: null });
});

test("removing a FOUND team in the record editor records her denial of its fact (once); Mila's partial lists never deny", async () => {
  const [fact] = await db.insert(athleteFacts).values({ athlete_id: athleteId, fact_key: "affiliation", value: { org: "Summer Program", orgKind: "school", season: 2026 } as any, value_text: "summer program school 2026", status: "current", retrieved_at: new Date("2026-09-01T00:00:00Z"), origin: "research", source_class: "web_researched", authority_tier: 2, confidence: "0.50", provenance: {} as any, freshness_family: "affiliations", resolver_version: "v3", registry_version: "v3" }).returning({ id: athleteFacts.id });
  await db.insert(athleteAffiliations).values({ athlete_id: athleteId, org_name: "Summer Program", org_kind: "school", started_on: "2026-01-01", is_primary: false, kind: "found", source: "research", fact_id: fact.id } as any);
  const kept = [{ org: "Northfield College", kind: "school" as const, from: "2023", primary: true }];
  const disputes = async () => (await db.select().from(athleteAsserted).where(eq(athleteAsserted.field, "dispute"))).filter((r) => !r.superseded_by && !r.retracted_at);

  // Mila sends part of a list: the found team is not "removed", so nothing is denied.
  await recordAssertions({ athleteId, runId: null, mode: "chat", source: "chat", corrections: [{ field: "affiliations", value: kept as any }] });
  expect(await disputes()).toHaveLength(0);

  // The editor sends the whole list she was shown, without it: her denial of the fact behind it.
  await recordAssertions({ athleteId, runId: null, mode: "form", source: "settings", corrections: [{ field: "affiliations", value: kept as any }] });
  const live = await disputes();
  expect(live).toHaveLength(1);
  expect(JSON.stringify(live[0].value)).toContain(fact.id);
  // History stays: the found row and the fact are kept; the denial is what hides them.
  expect((await db.select().from(athleteFacts).where(eq(athleteFacts.id, fact.id)))[0].status).toBe("current");
  expect(await db.select().from(athleteAffiliations).where(eq(athleteAffiliations.fact_id, fact.id))).toHaveLength(1);

  // Saving the list again writes no second denial.
  await recordAssertions({ athleteId, runId: null, mode: "form", source: "settings", corrections: [{ field: "affiliations", value: kept as any }] });
  expect(await disputes()).toHaveLength(1);
  await db.delete(athleteFacts);
});
