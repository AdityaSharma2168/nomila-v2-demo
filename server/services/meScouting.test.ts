/**
 * meScouting.test.ts — the Scouting report builder (pure): hero and stage, what defines you, the M.I.A. notes with
 * their dimension tags, partners from facts about you only, the Knows counts; the identity line (0119) and the
 * exclusivity / category conflicts (understand 1.9.0). Made-up names; no provider, no database.
 */
jest.mock("../db", () => ({ db: {} }));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
import { buildScoutingReport, scoutBrands, scoutConflicts, scoutIdentity, tagNote, type ScoutingInputs } from "./meScouting";
import type { MemoryFact, MiaPreview } from "../../shared/agent";
import type { StoredBrief } from "../agent/research/store";

const NAME = "Avery Placeholder";
let n = 0;
function fact(p: Partial<MemoryFact> & { claim: string }): MemoryFact {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, athleteId: "a", subject: { kind: "athlete", name: NAME }, type: "found",
    source: { url: `https://example.org/${n}` }, date: null, confidence: 0.8, status: "active", supersededBy: null, runId: null,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(), topic: null, ...p,
  };
}

const ownDeal = fact({ claim: `${NAME} is a partner of Brand One.`, topic: "sponsor", date: "2026-05-01" });
const ownDealOlder = fact({ claim: `${NAME} appeared for Brand One.`, topic: "sponsor", date: "2025-02-01" });
const teamDeal = fact({ claim: "Team Placeholder is sponsored by Brand Two.", topic: "sponsor", subject: { kind: "organization", name: "Team Placeholder" } });
const pastDeal = fact({ claim: `${NAME} worked with Brand Three.`, topic: "sponsor", date: "2023-08-01" });
const disputedDeal = fact({ claim: `${NAME} works with Brand Four.`, topic: "sponsor", status: "disputed" });
const removedDeal = fact({ claim: `${NAME} works with Brand Five.`, topic: "sponsor", status: "removed" });
const both = fact({ claim: `${NAME} and Brand Six.`, topic: "sponsor", date: "2024-01-01" });
const lowConfidence = fact({ claim: `${NAME} was born abroad.`, topic: "identity", confidence: 0.3 });
const name = fact({ claim: `The athlete's name is ${NAME}.`, type: "said", source: { ref: "onboarding/r#name" } });
const FACTS = [ownDeal, ownDealOlder, teamDeal, pastDeal, disputedDeal, removedDeal, both, lowConfidence, name];

const INTERNAL = {
  currentSponsors: [
    { name: "Brand One", factIds: [ownDeal.id, ownDealOlder.id], since: "2024" },
    { name: "Brand Two", factIds: [teamDeal.id], since: "2019" },
    { name: "Brand Four", factIds: [disputedDeal.id] },
    { name: "Brand Five", factIds: [removedDeal.id] },
    { name: "Brand Six", factIds: [both.id], since: "2021-03" },
  ],
  pastSponsors: [{ name: "Brand Three", factIds: [pastDeal.id] }, { name: "brand six", factIds: [both.id], since: "2020" }],
};
const LOGOS = { domains: new Map([["brand one", "brandone.example"]]), logoUrls: new Map<string, string>() };

const BRIEF: StoredBrief = {
  id: "b", athleteId: "a", version: 3, status: "current", summary: "s", sections: [], factIds: [], runId: null, createdAt: "2026-10-07T10:00:00.000Z",
  display: {
    stage: { label: "D1 college", band: "developing", confidence: 0.8, why: "w", factIds: [] },
    positioning: {
      from: "Known for results", to: "Known for your story and your results", statement: "A starter brands can trust.",
      pillars: [{ name: "Comeback", line: "Back from injury.", factIds: [] }, { name: "Leader", line: "Captain.", factIds: [] }, { name: "Roots", line: "Home town.", factIds: [] }, { name: "Extra", line: "x", factIds: [] }],
      factIds: [],
    },
  },
};

const PREVIEW = {
  contract: "mia-preview/1", athleteId: "a", status: "ready", score: 540, scale: { min: 0, max: 850 }, groups: [], preliminary: true,
  label: "Preliminary", confidence: { level: "MEDIUM", explanation: null }, inputs: { public: [], measured: [] }, sharpen: [], evidenceAsOf: "2026-10-07",
  identity: { uncertain: false, factIds: [] }, provenance: null,
  assessment: { notes: { strengths: ["Two seasons as a starter.", "Steady local press.", "A third strength."], constraints: ["One partner on record.", "Engagement not measured."], missingEvidence: ["Insights from your main account"], evaluationRisks: [] } },
} as unknown as MiaPreview;

const TAGGED = {
  keyStrengths: [{ text: "Two seasons as a starter.", dimension: "athletic_authority", evidenceIds: [] }, { text: "Steady local press.", dimension: "not_a_dimension", evidenceIds: [] }],
  keyConstraints: [{ text: "One partner on record. ", dimension: "commercial_proof", evidenceIds: [] }],
  importantMissingData: [{ text: "Insights from your main account", dimension: "engagement_quality", evidenceIds: [] }],
  summary: null,
};

const inputs = (over: Partial<ScoutingInputs> = {}): ScoutingInputs => ({
  brief: BRIEF, internal: INTERNAL, facts: FACTS, athleteName: NAME, confirmed: new Set(), preview: PREVIEW, tagged: TAGGED, logos: LOGOS, ...over,
});

describe("buildScoutingReport", () => {
  it("the biggest upside and risk come from the Brief's risks_upside section (the read in detail opens with them); none → null", () => {
    const sections = [{ key: "risks_upside", title: "Biggest risk and biggest upside", text: "", factIds: [], lines: [
      { text: "Risk: a quiet off-season.", kind: "inference", factIds: [] }, { text: "Upside: the comeback story.", kind: "inference", factIds: [] },
    ] }] as unknown as StoredBrief["sections"];
    expect(buildScoutingReport(inputs({ brief: { ...BRIEF, sections } })).riskUpside).toEqual({ risk: "a quiet off-season.", upside: "the comeback story." });
    expect(buildScoutingReport(inputs()).riskUpside).toBeNull();
    expect(buildScoutingReport(inputs({ brief: null })).riskUpside).toBeNull();
  });

  it("hero, stage and what defines you come from the Brief's display, three pillars at most", () => {
    const r = buildScoutingReport(inputs());
    expect(r.status).toBe("ready");
    expect(r.version).toBe(3);
    expect(r.updatedOn).toBe("2026-10-07");
    expect(r.hero).toEqual({ statement: "A starter brands can trust.", stage: { label: "D1 college", band: "developing" }, identity: { line: null, parts: [] } });
    expect(r.conflicts).toEqual([]);
    expect(r.defines).toEqual({
      today: "Known for results", headed: "Known for your story and your results",
      pillars: [
        { key: "pillar_1", label: "Comeback", definition: "Back from injury." },
        { key: "pillar_2", label: "Leader", definition: "Captain." },
        { key: "pillar_3", label: "Roots", definition: "Home town." },
      ],
    });
  });

  it("an unclear band is no stage; no Brief is no_brief with an empty hero", () => {
    const unclear = { ...BRIEF, display: { ...BRIEF.display!, stage: { ...BRIEF.display!.stage, band: "unclear" as const } } };
    expect(buildScoutingReport(inputs({ brief: unclear })).hero.stage).toBeNull();
    const none = buildScoutingReport(inputs({ brief: null, internal: null }));
    expect(none.status).toBe("no_brief");
    expect(none.hero).toEqual({ statement: null, stage: null, identity: { line: null, parts: [] } });
    expect(none.defines).toBeNull();
    expect(none.brands).toEqual({ current: [], past: [], unclear: [] });
  });

  it("notes: top two each, the missing count, every note tagged from the run (untagged when the tag is not one of the eight)", () => {
    const r = buildScoutingReport(inputs());
    expect(r.notes!.workingForYou).toEqual([
      { text: "Two seasons as a starter.", dimension: "athletic_authority", group: "performance" },
      { text: "Steady local press.", dimension: null, group: null },
    ]);
    expect(r.notes!.roomToGrow).toEqual([
      { text: "One partner on record.", dimension: "commercial_proof", group: "commercial" },
      { text: "Engagement not measured.", dimension: null, group: null },
    ]);
    expect(r.notes!.notOnRecordCount).toBe(1);
    expect(r.notes!.detail.strengths).toHaveLength(3);
    expect(r.notes!.detail.missing).toEqual([{ text: "Insights from your main account", dimension: "engagement_quality", group: "audience" }]);
    // No tagged answer at all: every note untagged, never guessed.
    expect(buildScoutingReport(inputs({ tagged: null })).notes!.workingForYou.every((x) => x.dimension === null && x.group === null)).toBe(true);
  });

  it("no M.I.A. read: no block and no notes", () => {
    const r = buildScoutingReport(inputs({ preview: { ...PREVIEW, status: "not_assessed", score: null, assessment: null } }));
    expect(r.mia).toBeNull();
    expect(r.notes).toBeNull();
    const ready = buildScoutingReport(inputs());
    expect(ready.mia).toMatchObject({ status: "ready", score: 540, preliminary: true, scale: { min: 0, max: 850 } });
    expect(Object.keys(ready.mia!)).not.toContain("inputs");
  });

  it("knows counts: facts about you, in use; low confidence or disputed counts as couldn't confirm", () => {
    const r = buildScoutingReport(inputs());
    // About you and in use: ownDeal, ownDealOlder, pastDeal, disputedDeal, both, lowConfidence, name (team + removed out).
    expect(r.knows).toEqual({ facts: 7, unconfirmed: 2 });
  });
});

describe("scoutBrands: partners from facts about you only", () => {
  const b = scoutBrands(INTERNAL, FACTS, NAME, LOGOS);
  it("keeps a brand a fact about you backs; drops a team's sponsor and a brand whose only fact was hidden", () => {
    const names = [...b.current, ...b.past, ...b.unclear].map((x) => x.name);
    expect(names).not.toContain("Brand Two");
    expect(names).not.toContain("Brand Five");
  });
  it("current with its newest confirmed date and logo domain; past; unclear when listed both ways or only disputed", () => {
    expect(b.current).toEqual([{ name: "Brand One", logoDomain: "brandone.example", logoUrl: null, latestConfirmedOn: "2026-05-01", startedOn: "2024", status: "current", factIds: [ownDeal.id, ownDealOlder.id] }]);
    expect(b.past).toEqual([{ name: "Brand Three", logoDomain: null, logoUrl: null, latestConfirmedOn: "2023-08-01", startedOn: null, status: "past", factIds: [pastDeal.id] }]);
    expect(b.unclear.map((x) => [x.name, x.status, x.latestConfirmedOn])).toEqual([["Brand Four", "unclear", null], ["Brand Six", "unclear", "2024-01-01"]]);
  });
  it("startedOn: the earliest start a backed entry states (understand 1.10.0), null when none; a dropped brand's never shows", () => {
    expect(b.unclear.map((x) => [x.name, x.startedOn])).toEqual([["Brand Four", null], ["Brand Six", "2020"]]);
    expect(JSON.stringify(b)).not.toContain("2019");
  });
  it("no internal read (an older Brief): no brands", () => {
    expect(scoutBrands(null, FACTS, NAME, LOGOS)).toEqual({ current: [], past: [], unclear: [] });
  });
});

describe("scoutIdentity: team · position · level from identity facts about you", () => {
  const team = fact({ claim: `${NAME} plays for Team Placeholder.`, topic: "team", field: "team", fieldValue: "Team Placeholder", date: "2025-09-01" });
  const teamNewer = fact({ claim: `${NAME} joined Club Placeholder.`, topic: "team", field: "team", fieldValue: "Club Placeholder", date: "2026-08-01" });
  const position = fact({ claim: `${NAME} plays the second slot.`, topic: "career", field: "position", fieldValue: "Second slot" });
  const saidLevel = fact({ claim: "I compete at the top school level.", type: "said", source: { ref: "chat/1" }, field: "level", fieldValue: "Top school level" });
  const foundLevel = fact({ claim: `${NAME} competes at a lower level.`, field: "level", fieldValue: "Lower level", date: "2026-09-01", confidence: 0.95 });
  const classYear = fact({ claim: `${NAME} is a junior.`, field: "class_year", fieldValue: "Junior" });
  const teammate = fact({ claim: "A teammate plays first slot.", subject: { kind: "person", name: "Another Person" }, field: "position", fieldValue: "First slot" });
  const disputed = fact({ claim: `${NAME} plays third slot.`, status: "disputed", field: "position", fieldValue: "Third slot" });

  it("one fact per field (said first, then newest), in team · position · level order; every field in parts", () => {
    const id = scoutIdentity([team, teamNewer, position, saidLevel, foundLevel, classYear, teammate, disputed, name], NAME);
    expect(id.line).toBe("Club Placeholder · Second slot · Top school level");
    expect(id.parts).toEqual([
      { field: "team", value: "Club Placeholder", factId: teamNewer.id },
      { field: "position", value: "Second slot", factId: position.id },
      { field: "level", value: "Top school level", factId: saidLevel.id },
      { field: "class_year", value: "Junior", factId: classYear.id },
    ]);
  });

  it("no line from someone else's or a disputed fact; none of the three on record is a null line", () => {
    expect(scoutIdentity([teammate, disputed], NAME)).toEqual({ line: null, parts: [] });
    expect(scoutIdentity([classYear], NAME)).toEqual({ line: null, parts: [{ field: "class_year", value: "Junior", factId: classYear.id }] });
  });

  it("is served on the report's hero", () => {
    expect(buildScoutingReport(inputs({ facts: [...FACTS, team, position] })).hero.identity.line).toBe("Team Placeholder · Second slot");
  });
});

describe("scoutConflicts: the Brief's conflicts, with what each blocks", () => {
  it("keeps a conflict while a fact it rests on is in use; drops one with none left, no words or nothing blocked", () => {
    const internal = { ...INTERNAL, exclusivityConflicts: [
      { what: "Team Placeholder's partner Brand Two holds the drinks category.", blocks: ["other drinks brands"], factIds: [teamDeal.id, "gone"] },
      { what: "Only a hidden fact.", blocks: ["x"], factIds: [removedDeal.id] },
      { what: " ", blocks: ["x"], factIds: [ownDeal.id] },
      { what: "Nothing blocked.", blocks: [], factIds: [ownDeal.id] },
    ] };
    const want = [{ what: "Team Placeholder's partner Brand Two holds the drinks category.", blocks: ["other drinks brands"], factIds: [teamDeal.id] }];
    expect(scoutConflicts(internal, FACTS)).toEqual(want);
    expect(buildScoutingReport(inputs({ internal })).conflicts).toEqual(want);
    expect(scoutConflicts(INTERNAL, FACTS)).toEqual([]);           // a Brief from before understand 1.9.0
    expect(scoutConflicts(null, FACTS)).toEqual([]);
  });
});

describe("tagNote", () => {
  it("matches the evaluator's text ignoring case and spacing", () => {
    expect(tagNote("one partner  on record.", TAGGED.keyConstraints)).toEqual({ text: "one partner  on record.", dimension: "commercial_proof", group: "commercial" });
    expect(tagNote("Something else.", TAGGED.keyConstraints)).toEqual({ text: "Something else.", dimension: null, group: null });
  });
});
