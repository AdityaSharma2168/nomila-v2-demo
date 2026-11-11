// Made-up served bodies for the agent Me (GET /me/scouting, GET /me/facts). No real athlete, sport, school or brand.
import type { KnowsFact, KnowsView, ScoutingReport } from "../../../../shared/meScouting";

export const REPORT: ScoutingReport = {
  contract: "scouting/1",
  status: "ready",
  version: 3,
  updatedOn: "2026-10-07",
  hero: {
    statement: "A starter brands can trust, on the field and off it.",
    stage: { label: "College", band: "developing" },
    identity: { line: "Team Example · Second slot · Junior", parts: [] },
  },
  defines: {
    today: "known for results",
    headed: "known for your story and your results",
    pillars: [{ key: "pillar_1", label: "Comeback", definition: "Back from injury." }, { key: "pillar_2", label: "Leader", definition: "Captain." }],
  },
  mia: {
    status: "ready", score: 612, scale: { min: 0, max: 850 }, groups: [], preliminary: true, label: "Preliminary", confidence: { level: "MEDIUM", explanation: null },
    sharpen: [], evidenceAsOf: "2026-10-07",
    assessment: { summary: "Strongest in engagement quality. Thinnest in commercial proof.", dimensions: [{ key: "engagement_quality", score: 71, contribution: 40 }, { key: "commercial_proof", score: 22, contribution: 10 }] } as any,
  },
  notes: {
    workingForYou: [{ text: "Engagement runs above your level.", dimension: "engagement_quality", group: "audience" }, { text: "Steady local press.", dimension: null, group: null }],
    roomToGrow: [{ text: "Few paid partnerships on record.", dimension: "commercial_proof", group: "commercial" }],
    notOnRecordCount: 2,
    detail: {
      strengths: [{ text: "Engagement runs above your level.", dimension: "engagement_quality", group: "audience" }],
      growth: [{ text: "Few paid partnerships on record.", dimension: "commercial_proof", group: "commercial" }],
      missing: [{ text: "Insights from your main account", dimension: "engagement_quality", group: "audience" }, { text: "Season results", dimension: null, group: null }],
    },
  },
  brands: {
    current: [{ name: "Brand One", logoDomain: "brandone.example", logoUrl: null, latestConfirmedOn: "2026-10-03", startedOn: "2024", status: "current", factIds: ["f1"] }],
    past: [{ name: "Brand Two", logoDomain: null, logoUrl: null, latestConfirmedOn: "2026-10-03", startedOn: null, status: "past", factIds: ["f2"] }],
    unclear: [],
  },
  conflicts: [{ what: "Brand One and Brand Three sell in the same category", blocks: ["Brand Three"], factIds: ["f1"] }],
  knows: { facts: 12, unconfirmed: 1 },
  riskUpside: { upside: "the comeback story opens bigger brands.", risk: "a quiet off-season could cost reach." },
};

export const fact = (id: string, over: Partial<KnowsFact> = {}): KnowsFact => ({
  id, claim: `Fact ${id}.`, topic: "career", provenance: "found", unconfirmed: false, confirmedByYou: false, date: "2026-10-03",
  confidence: 0.8, status: "active", sources: [{ label: "example.org", url: "https://example.org/a" }], alsoSeen: 0,
  subject: { kind: "athlete", name: "Sam Example" }, about: "athlete", editable: true, ...over,
});

export const KNOWS: KnowsView = {
  contract: "knows/1", status: "ready", asOf: "2026-10-10", subject: "athlete",
  counts: { total: 3, you: 1, found: 1, accounts: 1, unconfirmed: 1, hidden: 1, private: 0 },
  sections: [
    { key: "glance", facts: [fact("g1", { claim: "You play second slot.", provenance: "you", topic: "identity" })] },
    { key: "career", facts: [fact("c1", { claim: "Started every game this season.", unconfirmed: true })] },
    { key: "honours", facts: [] },
    { key: "academics", facts: [] },
    { key: "brands", facts: [] },
    { key: "media", facts: [fact("m1", { claim: "12,400 followers on your main account.", provenance: "accounts", editable: false })] },
    { key: "interests", facts: [] },
    { key: "details", facts: [] },
  ],
  private: [],
  hidden: [{ id: "h1", claim: "An old hidden fact." }],
};
