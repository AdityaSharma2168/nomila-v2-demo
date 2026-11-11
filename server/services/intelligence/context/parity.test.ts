/**
 * parity.test.ts — gate G1 on PGlite: in legacy sourceMode each view reproduces today's reader output,
 * and every remaining difference is a DOCUMENTED design fix (design §1.2 D2 / D4 / D5 / D6 / D7, §3.1 dates
 * by `as_of`, §2.3 ledger-first identity). The expected diff lists below ARE the exception list carried
 * into the 2d-2..2d-5 shadow runs: a new, undocumented difference fails this suite.
 */

jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedConnection } from "../../../testUtils/pgliteDb";
import { athletes } from "../../../../shared/schema";
import { getAthleteRecord, type AthleteRecord } from "../../athleteRecord";
import { getAthleteContext } from "../../athleteContext";
import { loadOnboardingFacts, renderOnboardingBlock } from "../../../mila/onboarding";
import { buildSearchName } from "../../../skills/researchAthlete";
import { collectKnownHandles } from "../../../workflow/definitions/onboarding";
import { buildCanonicalContext, type BuiltContext } from "./build";
import { recordView, readRecordExtras } from "./views/record";
import { deckView, readDeckExtras } from "./views/deck";
import { promptView } from "./views/prompt";
import { identityView } from "./views/identity";
import { searchView, searchAnchorFor } from "./views/search";
import { shadowCompare, structuralDiff } from "./shadow";
import { seedLegacyAthlete } from "./testFixtures";

let id: string;
let built: BuiltContext;
jest.setTimeout(180_000);   // PGlite schema push + the fixtures exceed the 30 s default on a cold worker

beforeAll(async () => {
  await initTestDb();
  id = await seedLegacyAthlete();
  built = (await buildCanonicalContext(id))!;
});
afterAll(closeTestDb);

describe("record view vs getAthleteRecord (2d-2)", () => {
  it("is byte-equal except the documented D2 / D4 / labelled-provenance rows", async () => {
    const legacy = (await getAthleteRecord(id))!;
    const view = recordView(built, await readRecordExtras(id));
    expect(view.groups.map((g) => g.key)).toEqual(legacy.groups.map((g) => g.key));
    // c04 (the modern M.I.A. score PR): the legacy reader's "numbers" group drops "capitals" — no
    // modern replacement for the four legacy capitals — while the canonical view still carries it
    // (out of scope here; the canonical reader's own score switch is separate). Filtered out here
    // so this stays a same-rows-same-order check for every row that still exists on both sides.
    const fieldsOf = (r: AthleteRecord) => r.groups.map((g) => g.entries.map((e) => e.field).filter((f) => f !== "capitals"));
    expect(fieldsOf(view)).toEqual(fieldsOf(legacy));   // same rows, same order
    const r = shadowCompare("record", id, legacy, view);
    const who = (i: number, k: string) => `groups[0].entries[${i}].${k}`, found = (i: number, k: string) => `groups[4].entries[${i}].${k}`;
    expect(r.diffs.map((d) => d.path).sort()).toEqual([
      // D2: the level row carries the ledger row's kind, wording and date, never "found online · researchedAt"
      who(6, "at"), who(6, "kind"), who(6, "source"),
      // D4: class year and hometown are read (from research.profile.*) — the legacy reader looked at the top level and showed nothing
      who(9, "at"), who(9, "kind"), who(9, "source"), who(9, "value"), who(10, "at"), who(10, "kind"), who(10, "source"), who(10, "value"),
      // §3.2: a legacy-sourced row says so
      who(11, "source"), found(0, "source"), found(1, "source"), found(2, "source"),
      // D2 + D4 consequences: the level row counts as said (the ledger row is the athlete's word); two more found rows
      "counts.found", "counts.said",
      // Legacy retirement, phase 1 (8 Oct 2026): both readers now take the score from the ledger M.I.A. and
      // neither carries the legacy capitals or the computed rate-card row, so "Your numbers" and the header agree.
    ].sort());
    expect(view.groups[5].entries.map((e) => e.field)).toEqual(["score"]);
    expect(legacy.groups[5].entries.map((e) => e.field)).toEqual(["score"]);
    expect(view.counts).toMatchObject({ said: legacy.counts.said + 1, found: legacy.counts.found + 1, proof: legacy.counts.proof });
    expect(view.groups[0].entries[6]).toMatchObject({ value: "D1 · ACC", kind: "said", source: "signup" });
    expect(view.groups[0].entries[9]).toMatchObject({ value: "Junior 2026", kind: "found", source: "found online (earlier research)", at: "2026-08-01T12:00:00.000Z" });
    expect(view.groups[0].entries[8]).toMatchObject({ value: "Striker", kind: "said", source: "you told Mila" });   // the assertion wins in both
    expect(view.groups[4].entries[4]).toMatchObject({ field: "causes_seen", value: null });                      // D5: never a value
    expect(view.groups[3].entries[0]).toMatchObject({ field: "narrative", value: "Legacy story arc" });        // D6: the Story tab's row (first, since the kit hook is no longer read)
    expect(view.header).toMatchObject({ name: legacy.header.name, identityLine: legacy.header.identityLine, photoUrl: legacy.header.photoUrl });
    // This fixture seeds legacy display_score 650 · Rising but no ledger assessment: neither reader shows a score.
    expect(view.header.displayScore).toBeNull(); expect(view.header.tier).toBeNull();
    expect(legacy.header.displayScore).toBeNull(); expect(legacy.header.tier).toBeNull();
  });
});

describe("deck view vs getAthleteContext (2d-4)", () => {
  it("is equal except D7 (commercial state from confirmed deals only) and the rebuilt research passthrough", async () => {
    const legacy = await getAthleteContext(id);
    const view = deckView(built, await readDeckExtras(id));
    const r = shadowCompare("deck", id, legacy, view, ["research"]);
    expect(r.diffs.map((d) => d.path).sort()).toEqual(["brandFitTags", "commercialState", "coverage", "inferredPartners.length"].sort());   // coverage: view only (§3.2); brandFitTags: the canonical inference or [] on the view, never derived (D6); the legacy reader reports sourceMode "legacy"
    expect(legacy.commercialState).toBe("undisclosed"); expect(view.commercialState).toBe("none");   // D7
    expect(view.inferredPartners).toEqual([]);
    // the passthrough keeps the keys the deck consumers read, built from the contract
    expect(view.research.achievements).toEqual(legacy.research.achievements);
    expect(view.research.brand_mentions).toEqual(legacy.research.brand_mentions);
    expect(view.research.story_arc).toBe("Legacy story arc");
    expect(structuralDiff(legacy.asserted, view.asserted)).toEqual([]);
    expect(view).toMatchObject({ org: "Legacy", division: "D1", conference: "ACC", segment: "college", storyArc: "Legacy story arc", causes: [] });
  });
});

describe("prompt view vs the onboarding block (2d-2)", () => {
  it("emits the same facts as renderOnboardingBlock inside a typed fence, with no guidance prose and no raw blob", async () => {
    const f = (await loadOnboardingFacts(id))!;
    const legacyBlock = renderOnboardingBlock(f, "greet");
    const p = promptView(built, "onboarding", { score: { displayScore: f.display_score, tier: f.tier }, firstLooks: f.first_looks, step: "greet" });
    const untag = (s: string | null) => (s ?? "").replace(/\s\[[^\]]*\]/g, "");
    expect(p.facts.name).toBe(f.full_name); expect(p.facts.first_name).toBe(f.first_name);
    expect(p.facts.sport).toBe(f.sport); expect(p.facts.team_or_school).toBe(f.school);   // equal: the projection matches the ledger's primary current team
    expect(p.facts.career).toBe(f.career_status);
    expect([p.facts.division, p.facts.conference, p.facts.segment]).toEqual([f.division, f.conference, f.segment]);
    // Legacy retirement, phase 1: the score line is the ledger M.I.A. (none seeded here), never the legacy 650 (Rising).
    expect(p.facts.score).toBe("not scored yet"); expect(legacyBlock).toContain("score: not scored yet"); expect(legacyBlock).not.toContain("650");
    expect(p.facts.researched).toBe(f.researched_at!.slice(0, 10));                       // equal here because as_of == created_at (§3.1: as_of is the source)
    expect(untag(p.facts.achievements_found)).toBe(f.achievements.map((a) => (a.year ? `${a.name} (${a.year})` : a.name)).join("; "));
    expect(p.facts.brands_seen_in_public).toBe(f.brands_seen.join("; "));
    expect(p.facts.connected_accounts).toBe("none yet"); expect(p.facts.current_step).toBe("greet");
    expect(p.lines.find((l) => l.startsWith("team_current:"))).toBe("team_current: Legacy University (school, D1, 2024–now, primary) [said]");
    expect(p.lines.find((l) => l.startsWith("TOLD US:"))).toBe("TOLD US: position = Striker");
    expect(legacyBlock).toContain("TOLD US: position = Striker");
    expect(p.block).not.toContain("FIRST ENTRY");                                          // guidance is the caller's, never the view's
    expect(p.block).not.toContain("causes_seen_in_public");                                 // D5
    expect(p.block.startsWith("<<<ATHLETE_CONTEXT purpose=onboarding sourceMode=legacy>>>\n")).toBe(true);
    expect(p.block.endsWith("\n<<<END_ATHLETE_CONTEXT>>>")).toBe(true);
    expect(p.lines.find((l) => l.startsWith("position:"))).toBe("position: Forward [legacy_blob · retrieved 2026-08-01 · unknown]");   // D4, with real provenance
  });
});

describe("identity view vs the projection readers (2d-3)", () => {
  it("exposes what /auth/me, get_profile and the voice route read today, plus the ledger team", async () => {
    const [row] = await db.select({ sport: athletes.sport, school: athletes.school, division: athletes.division, conference: athletes.conference, segment: athletes.segment, career: athletes.career_status }).from(athletes).where(eq(athletes.id, id));
    const v = identityView(built);
    expect(v).toMatchObject({ name: "Legacy Lane", firstName: "Lee", sport: row.sport, legacySchool: row.school, currentTeam: row.school, careerStatus: row.career, level: { division: row.division, conference: row.conference, segment: row.segment }, connectionStatus: "none", sourceMode: "legacy" });
    expect(v.handles).toEqual({ instagram: "legacy_ig", x: "legacy_x", tiktok: "legacy_tt" });
  });
});

describe("search view vs buildSearchName + collectKnownHandles (2d-5)", () => {
  it("the anchor equals today's when the projection equals the ledger; knownHandles keeps connected > entered and never the blob", async () => {
    const [row] = await db.select({ full_name: athletes.full_name, school: athletes.school, sport: athletes.sport }).from(athletes).where(eq(athletes.id, id));
    let v = searchView(built);
    expect(v.legacySearchAnchor).toBe(buildSearchName(row));
    expect(v.searchAnchor).toBe(buildSearchName(row));
    expect(v.searchAnchor).toBe("Legacy Lane Legacy University soccer");
    expect(v.knownHandles).toEqual(await collectKnownHandles(id));
    await seedConnection({ athleteId: id, platform: "instagram", email: "conn_ig" });
    v = searchView((await buildCanonicalContext(id))!);
    expect(v.knownHandles).toEqual(await collectKnownHandles(id));
    expect(v.knownHandles.instagram).toBe("conn_ig");
    // a stale projection is the documented difference: the anchor follows the ledger
    await db.update(athletes).set({ school: "Old School" }).where(eq(athletes.id, id));
    v = searchView((await buildCanonicalContext(id))!);
    expect(v.legacySearchAnchor).toBe("Legacy Lane Old School soccer");
    expect(v.searchAnchor).toBe("Legacy Lane Legacy University soccer");
    expect(searchAnchorFor({ fullName: "A B", currentTeam: null, sport: null })).toBe("A B");
  });
});
