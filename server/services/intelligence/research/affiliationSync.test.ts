/**
 * affiliationSync.test.ts — gate G6 (design §3.5; 2d-6 review decisions Q2/Q3) on PGlite.
 *   idempotent: the same facts twice ⇒ no insert, no update, updated_at untouched
 *   reconfirm (new fact id, same key) ⇒ fact_id re-pointed, no new row; same-key date correction ⇒ dates updated in place
 *   different org/season ⇒ the previous found-from-fact current row is closed and one row inserted (history kept)
 *   historical fact ⇒ ended_on = valid_to; never deleted
 *   precedence: said/proof rows never modified or demoted; a found row is never primary while a said/proof current row exists
 *   Q2: the projection follows the PRIMARY current row only — NULL when there is none, even with non-primary current rows
 *   Q3: undated facts key on org + kind; repeated undated facts do not duplicate; later dated evidence is a distinct key handled by the rules
 *   legacy found rows (source='research') are never touched
 */

jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../../testUtils/pgliteDb";
import { athleteAffiliations, athleteFacts, athletes } from "../../../../shared/schema";
import { syncAffiliationsFromFacts } from "./affiliationSync";
import { listAffiliations, replaceSaidAffiliations } from "../../affiliations";

jest.setTimeout(180_000);
const AT = new Date("2026-09-11T00:00:00Z");
let id: string;
const factOf = async (v: Record<string, unknown>, over: Partial<{ status: string; validFrom: string | null; validTo: string | null; at: Date }> = {}) => {
  const [row] = await db.insert(athleteFacts).values({ athlete_id: id, fact_key: "affiliation", value: v as any, value_text: `${String(v.org).toLowerCase()} ${v.orgKind} ${v.season ?? ""}`.trim(), status: over.status ?? "current", valid_from: over.validFrom ?? null, valid_to: over.validTo ?? null, retrieved_at: over.at ?? AT, origin: "research", source_class: "web_researched", authority_tier: 2, confidence: "0.90", provenance: {} as any, freshness_family: "affiliations", resolver_version: "v1", registry_version: "v1" }).returning({ id: athleteFacts.id });
  return row.id;
};
const ledger = async () => (await db.select().from(athleteAffiliations).where(eq(athleteAffiliations.athlete_id, id))).sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.org_name.localeCompare(b.org_name));
const projection = async () => (await db.select({ school: athletes.school, division: athletes.division, conference: athletes.conference }).from(athletes).where(eq(athletes.id, id)))[0];

beforeAll(async () => { await initTestDb(); });
afterAll(closeTestDb);
beforeEach(async () => { id = await seedAthlete("Sync Athlete"); });

test("G6: a rule-7 fact becomes one found row (source=fact, fact_id); running again changes nothing; the projection follows", async () => {
  const f1 = await factOf({ org: "Example University", orgKind: "school", level: "D1", conference: "Atlantic Coast Conference (ACC)", season: 2026, primary: true });
  const r1 = await syncAffiliationsFromFacts(id, db as any, AT);
  expect(r1).toMatchObject({ inserted: 1, updated: 0, closed: 0, projected: { school: "Example University", division: "D1", conference: "ACC" } });   // D11: normalised
  const rows1 = await ledger();
  expect(rows1).toHaveLength(1);
  expect(rows1[0]).toMatchObject({ org_name: "Example University", org_kind: "school", kind: "found", source: "fact", fact_id: f1, is_primary: true, ended_on: null, conference: "Atlantic Coast Conference (ACC)" });   // the ledger keeps the raw entry
  expect(await projection()).toEqual({ school: "Example University", division: "D1", conference: "ACC" });
  const r2 = await syncAffiliationsFromFacts(id, db as any, new Date("2026-09-12T00:00:00Z"));
  expect(r2).toMatchObject({ inserted: 0, updated: 0, closed: 0 });
  const rows2 = await ledger();
  expect(rows2).toHaveLength(1);
  expect(rows2[0].updated_at.toISOString()).toBe(rows1[0].updated_at.toISOString());   // untouched
});

test("G6: a reconfirmed fact (new id, same key) re-points fact_id without a new row; a same-key date correction updates in place", async () => {
  const f1 = await factOf({ org: "Example University", orgKind: "school", level: "D1", season: 2026, primary: true });
  await syncAffiliationsFromFacts(id, db as any, AT);
  await db.update(athleteFacts).set({ status: "superseded" }).where(eq(athleteFacts.id, f1));
  const f2 = await factOf({ org: "Example University", orgKind: "school", level: "D1", season: 2026, from: "2026-08-15", primary: true }, { validFrom: "2026-08-15", at: new Date("2026-09-12T00:00:00Z") });
  const r = await syncAffiliationsFromFacts(id, db as any, new Date("2026-09-12T00:00:00Z"));
  expect(r).toMatchObject({ inserted: 0, updated: 1, closed: 0 });
  const rows = await ledger();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ fact_id: f2, started_on: "2026-08-15", ended_on: null, is_primary: true });
});

test("G6: a different org/season closes the previous found row (history kept) and inserts one; a historical fact sets ended_on", async () => {
  const f1 = await factOf({ org: "Example University", orgKind: "school", level: "D1", season: 2025, primary: true }, { validFrom: "2025-08-01" });
  await syncAffiliationsFromFacts(id, db as any, AT);
  await db.update(athleteFacts).set({ status: "historical", valid_to: "2026-06-30" }).where(eq(athleteFacts.id, f1));
  await factOf({ org: "Gotham FC", orgKind: "pro", level: "NWSL", season: 2026, primary: true }, { validFrom: "2026-07-01" });
  const r = await syncAffiliationsFromFacts(id, db as any, AT);
  expect(r).toMatchObject({ inserted: 1, updated: 1, closed: 0 });   // the historical fact ended its own row (an update); the new key inserted
  const rows = await ledger();
  expect(rows.map((x) => [x.org_name, x.ended_on, x.is_primary])).toEqual([["Example University", "2026-06-30", false], ["Gotham FC", null, true]]);
  expect(await projection()).toEqual({ school: "Gotham FC", division: "NWSL", conference: null });
  // a newer current fact of a different org: the resolver supersedes the older fact; the sync CLOSES its row on the new start, never deletes it
  await db.update(athleteFacts).set({ status: "superseded" }).where(eq(athleteFacts.value_text, "gotham fc pro 2026"));
  await factOf({ org: "Bay FC", orgKind: "pro", level: "NWSL", season: 2027, primary: true }, { validFrom: "2027-01-10" });
  const r2 = await syncAffiliationsFromFacts(id, db as any, new Date("2026-09-12T00:00:00Z"));
  expect(r2).toMatchObject({ inserted: 1, closed: 1 });
  const rows2 = await ledger();
  expect(rows2.map((x) => [x.org_name, x.ended_on, x.is_primary])).toEqual([["Example University", "2026-06-30", false], ["Gotham FC", "2027-01-10", false], ["Bay FC", null, true]]);
});

test("precedence: said/proof rows are never modified or demoted; a found row is never primary while a said current row exists (Q2: projection = primary only)", async () => {
  await replaceSaidAffiliations({ athleteId: id, source: "onboarding", teams: [{ org: "Said University", kind: "school", level: "D1", conference: "Big Ten", from: "2024", primary: true }] });
  const before = (await ledger())[0];
  await factOf({ org: "Found College", orgKind: "school", level: "D2", season: 2026, primary: true });
  const r = await syncAffiliationsFromFacts(id, db as any, AT);
  expect(r.inserted).toBe(1);
  const rows = await ledger();
  const said = rows.find((x) => x.kind === "said")!, found = rows.find((x) => x.kind === "found")!;
  expect(said).toMatchObject({ org_name: "Said University", is_primary: true, ended_on: null, updated_at: before.updated_at });
  expect(found).toMatchObject({ org_name: "Found College", is_primary: false, ended_on: null, source: "fact" });
  expect(await projection()).toEqual({ school: "Said University", division: "D1", conference: "Big Ten" });
  // Q2: with only NON-primary current rows the projection is NULL — no newest-current fallback
  await db.update(athleteAffiliations).set({ is_primary: false }).where(eq(athleteAffiliations.id, said.id));
  await syncAffiliationsFromFacts(id, db as any, AT);
  expect((await ledger()).filter((x) => x.ended_on === null)).toHaveLength(2);
  expect(await projection()).toEqual({ school: null, division: null, conference: null });
});

test("Q3: undated facts key on org + kind — repeats do not duplicate, a reconfirmation re-points; later dated evidence is a distinct key", async () => {
  const f1 = await factOf({ org: "Undated FC", orgKind: "club", primary: true });
  await syncAffiliationsFromFacts(id, db as any, AT);
  await factOf({ org: "undated fc", orgKind: "club", primary: true }, { at: new Date("2026-09-12T00:00:00Z") });   // the same team, normalised
  const r = await syncAffiliationsFromFacts(id, db as any, AT);
  expect(r).toMatchObject({ inserted: 0 });
  let rows = await ledger();
  expect(rows).toHaveLength(1);
  expect(rows[0].fact_id).not.toBe(f1);                                  // re-pointed to the newest same-key fact
  // dated evidence for a season is a genuinely distinct key: the resolver supersedes the undated fact; the sync closes the
  // undated row on the new start and inserts the dated row
  await db.update(athleteFacts).set({ status: "superseded" }).where(eq(athleteFacts.athlete_id, id));
  await factOf({ org: "Undated FC", orgKind: "club", season: 2027, from: "2027-01-01", primary: true }, { validFrom: "2027-01-01" });
  const r2 = await syncAffiliationsFromFacts(id, db as any, AT);
  expect(r2).toMatchObject({ inserted: 1, closed: 1 });
  rows = await ledger();
  expect(rows.map((x) => [x.started_on, x.ended_on, x.is_primary])).toEqual([[null, "2027-01-01", false], ["2027-01-01", null, true]]);
});

test("legacy found rows (source=research, fact_id NULL) are never touched by the sync", async () => {
  await db.insert(athleteAffiliations).values({ athlete_id: id, org_name: "Blob Team", org_kind: "club", kind: "found", source: "research", started_on: "2020-01-01" });
  await factOf({ org: "Blob Team", orgKind: "club", season: 2020, primary: true }, { validFrom: "2020-01-01" });
  const r = await syncAffiliationsFromFacts(id, db as any, AT);
  expect(r.inserted).toBe(1);                                              // the sync owns its own row; the legacy row is left as it was
  const rows = await ledger();
  expect(rows.filter((x) => x.source === "research")).toHaveLength(1);
  expect(rows.find((x) => x.source === "research")!.updated_at.toISOString()).toBe(rows.find((x) => x.source === "research")!.created_at.toISOString());
  const [after] = await listAffiliations(id);
  expect(after).toBeDefined();
});

test("concurrent affiliations: a second current fact of another org (both current) stays open beside the first; only one primary", async () => {
  await factOf({ org: "Example University", orgKind: "school", level: "D1", season: 2026, primary: true }, { validFrom: "2026-08-01" });
  await factOf({ org: "U-20 National Team", orgKind: "national", level: "U-20", season: 2026, primary: false }, { validFrom: "2026-06-01", at: new Date("2026-09-12T00:00:00Z") });
  const r = await syncAffiliationsFromFacts(id, db as any, AT);
  expect(r).toMatchObject({ inserted: 2, closed: 0 });
  const rows = await ledger();
  expect(rows.map((x) => [x.org_name, x.ended_on, x.is_primary])).toEqual([["Example University", null, true], ["U-20 National Team", null, false]]);
  expect(await projection()).toEqual({ school: "Example University", division: "D1", conference: null });
});

it("a year-only from/to (registry v2 allows YYYY) never reaches a date column: started_on stays null, the season carries the year", async () => {
  // Distinct retrieved_at: the sync reads facts oldest first and two inserts can share a created_at, so without it the order is a coin toss.
  await factOf({ org: "Year Only FC", orgKind: "club", from: "2020", to: "2022" }, { status: "historical", at: new Date("2026-09-10T00:00:00Z") });
  await factOf({ org: "Current Club", orgKind: "pro", from: "2024" });
  const r = await syncAffiliationsFromFacts(id, db as any, AT);
  expect(r.inserted).toBe(2);
  const rows = await ledger();
  const yo = rows.find((x) => x.org_name === "Year Only FC")!;
  expect(yo.started_on).toBeNull();
  expect(yo.ended_on).toBe("2026-09-11");   // a historical row with no full end date closes at the run's as-of (existing rule), never at "2022"
  expect(rows.find((x) => x.org_name === "Current Club")!.started_on).toBeNull();
});
