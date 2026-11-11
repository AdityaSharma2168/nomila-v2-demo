/**
 * reprocessKnowledge.test.ts — the pure plan of generic deterministic reprocessing (Concept 0.4 PR 4). No DB, no provider.
 *
 *   R1 a stored direct-evidence/2 payload is re-mapped with TODAY's item mapping; a fact the current rules now support is
 *      created from the ORIGINAL evidence row: its id in provenance, its retrieved_at (never now)
 *   R2 an officially sourced captaincy becomes the role of the one current affiliation (resolver supersedes the row)
 *   R3 athlete authority outranks: with her said teams, research only proposes; her assertion keeps its key
 *   R4 idempotent: applying the plan and planning again creates nothing
 *   R5 a finding with no stored evidence row is refused (nothing is ever acquired); suspect / superseded evidence refused
 *   R6 stored evidence whose payload is gone goes through today's registry (B path); non-v2 payloads are skipped, reported
 *   R7 the reprocessed marker carries the versions and never replaces the original timestamps
 */
jest.mock("../../../db", () => ({ db: {}, pool: {} }));
jest.mock("./researchInputs", () => ({ assertionsFor: async () => [] }));

import { HYBRID_MARKER } from "./spec/directEvidenceV1";
import { markReprocessed, planKnowledgeReprocess, remapPayload, REPROCESS_KNOWLEDGE_VERSION, type PlanInput, type StoredEvidence, type StoredPayload } from "./reprocessKnowledge";
import { valueTextFor } from "./factRegistry";
import type { FactRow } from "./resolve";

const T0 = "2025-09-01T00:00:00.000Z";          // when the evidence was originally retrieved
const NOW = new Date("2026-10-01T00:00:00.000Z");
const RUN_Q1 = "11111111-1111-4111-8111-111111111111";
const RUN_Q6 = "22222222-2222-4222-8222-222222222222";
const POLICY = { ttlDays: { identity: null, affiliations: 365, achievements: null, brand_mentions: 180, press: 90, narrative: 90, signals: 30, social_handles: 90, profile: 365 } as any, minCorroboration: 2, uncitedConfidenceCap: 0.5 };

const Q_EDU = "Senior at Example University studying BS Example Studies";
const Q_CAP = "Named team captain for the 2025 season";
const Q_GHOST = "Played in an all-star game";

const payload = (id: string, runId: string, queryName: string, items: Record<string, unknown>, over: Partial<StoredPayload> = {}): StoredPayload => ({
  id, runId, provider: "gemini_direct", endpointFamily: `search:${queryName}`, request: { path: "generateContent", params: { contract: "v2", queryName } },
  payload: { answerText: "prose", chunks: [{ id: "d0:c0", url: "https://uni.example/roster", domain: "uni.example" }], supports: [], raw: { text: `Research prose.\n${HYBRID_MARKER}\n${JSON.stringify({ identity: { anchor_match: "matched", confidence: 0.9 }, items })}`, groundingChunks: [], groundingSupports: [] } },
  ...over,
});
const finding = (value: Record<string, unknown>, quote: string, statement: string | null = null) => ({ value, statement, as_of: "2025-09-01", sources: [{ url: "https://uni.example/roster", quote }] });

const Q1 = payload("p-q1", RUN_Q1, "Identity + Biography + Affiliations", {
  education_class_year: { status: "found", findings: [finding({ class_year_label: "senior", season: 2026, degree: "BS Example Studies", institution: "Example University" }, Q_EDU)] },
  current_affiliation: { status: "found", findings: [finding({ organization: "Ghost College", organization_type: "school" }, Q_GHOST)] },
});
const Q6 = payload("p-q6", RUN_Q6, "Recent Developments + Reputation", {
  milestones_selections: { status: "found", findings: [finding({ event: "Named team captain", date: "2025-08-01" }, Q_CAP)] },
});

const row = (id: string, runId: string | null, kind: string, claim: Record<string, unknown>, quote: string, over: Partial<StoredEvidence> = {}): StoredEvidence => ({
  id, runId, kind, claim, support: { quote }, lineage: "native_supported", sourceType: "official_team_or_school", sourceDomain: "uni.example", sourceClass: "web_researched",
  suspect: false, supersededBy: null, confidence: 0.8, publishedAt: null, retrievedAt: T0, ...over,
});
// Rows as an OLDER mapping stored them: the class-year claim carried the degree only as an extra; the milestone carried no captaincy.
const EV_EDU = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const EV_CAP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const EV_NAT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const EVIDENCE: StoredEvidence[] = [
  row(EV_EDU, RUN_Q1, "profile_attribute", { factKey: "class_year", value: { label: "senior", season: 2026 }, degree: "BS Example Studies", item: "education_class_year" }, Q_EDU),
  row(EV_CAP, RUN_Q6, "career_event", { eventKind: "milestone", event: "Named team captain", date: "2025-08-01", item: "milestones_selections" }, Q_CAP),
  // B: a stored claim whose payload is gone, never turned into a fact before (e.g. the registry refused it then).
  row(EV_NAT, null, "affiliation", { factKey: "national_team_participation", value: { level: "youth", year: 2024, team: "U-20 National Team" } }, "U-20 squad 2024", { sourceType: "official_governing_body", sourceDomain: "federation.example" }),
];

const factRow = (id: string, factKey: string, value: any, over: Partial<FactRow> = {}): FactRow => ({
  id, factKey, value, valueText: valueTextFor(factKey, value), status: "current", origin: "research", sourceClass: "web_researched", authorityTier: 2, confidence: 0.8,
  retrievedAt: T0, observedAt: null, validFrom: null, validTo: null, provenance: { evidenceIds: [], domains: ["uni.example"] }, ...over,
});
const F_AFF = "ffffffff-ffff-4fff-8fff-fffffffffff1";
const FACTS: FactRow[] = [
  factRow(F_AFF, "affiliation", { org: "Example University", orgKind: "school", season: 2025, primary: true }),
  factRow("ffffffff-ffff-4fff-8fff-fffffffffff2", "class_year", { label: "senior", season: 2026 }, { provenance: { evidenceIds: [EV_EDU] } }),
];

const input = (over: Partial<PlanInput> = {}): PlanInput => ({ payloads: [Q1, Q6], evidence: EVIDENCE, facts: FACTS, assertions: [], hasAssertedAffiliations: false, policy: POLICY, asOf: NOW, ...over });

/** Apply a plan to the fact list the way the writer does (insert + supersede), for the idempotency check. */
function apply(facts: FactRow[], plan: ReturnType<typeof planKnowledgeReprocess>): FactRow[] {
  let out = [...facts];
  plan.inserts.forEach((x, n) => {
    const id = `eeeeeeee-eeee-4eee-8eee-${String(n).padStart(12, "0")}`;
    out = out.map((f) => (x.supersedes.includes(f.id) ? { ...f, status: "superseded" as any } : f));
    const m = markReprocessed(x.fact, NOW);
    out.push({ id, factKey: m.factKey, value: m.value, valueText: m.valueText, status: m.status, origin: m.origin, sourceClass: m.sourceClass, authorityTier: m.authorityTier, confidence: m.confidence, retrievedAt: m.retrievedAt, observedAt: m.observedAt, validFrom: m.validFrom, validTo: m.validTo, provenance: m.provenance });
  });
  return out;
}

describe("R1 re-map with today's item mapping", () => {
  it("creates the education fact from the original class-year evidence row, with its retrieved_at", () => {
    const plan = planKnowledgeReprocess(input());
    const edu = plan.inserts.find((x) => x.fact.factKey === "education");
    expect(edu).toBeDefined();
    expect(edu!.fact).toMatchObject({ value: { institution: "Example University", degree: "BS Example Studies" }, origin: "research", retrievedAt: T0, provenance: { evidenceIds: [EV_EDU] } });
    expect(edu!.fact.retrievedAt).not.toBe(NOW.toISOString());
    expect(plan.report.payloads).toMatchObject({ examined: 2, remapped: 2 });
    // the class year itself is already recorded from that row
    expect(plan.inserts.some((x) => x.fact.factKey === "class_year")).toBe(false);
    expect(plan.report.counts.unchanged).toBeGreaterThanOrEqual(1);
  });
});

describe("R2 captaincy → the current affiliation's role", () => {
  it("sets the role on the one current affiliation from an official native_supported milestone", () => {
    const plan = planKnowledgeReprocess(input());
    const aff = plan.inserts.find((x) => x.fact.factKey === "affiliation");
    expect(aff!.fact.value).toMatchObject({ org: "Example University", role: "captain", roleSince: "2025-08-01" });   // no year in the event ⇒ no roleSeason (never the date)
    expect(aff!.supersedes).toEqual([F_AFF]);
    expect(aff!.fact.provenance.evidenceIds).toEqual([EV_CAP]);
    expect(aff!.fact.retrievedAt).toBe(T0);
  });

  it("a non-official source never sets a role", () => {
    const ev = EVIDENCE.map((r) => (r.id === EV_CAP ? { ...r, sourceType: "major_news", sourceDomain: "news.example" } : r));
    expect(planKnowledgeReprocess(input({ evidence: ev })).inserts.some((x) => x.fact.factKey === "affiliation")).toBe(false);
  });
});

describe("R3 athlete authority outranks", () => {
  it("with her said teams research only proposes; her assertion keeps its key", () => {
    const plan = planKnowledgeReprocess(input({ hasAssertedAffiliations: true, assertions: [{ factKey: "class_year", value: { label: "junior", season: 2026 }, assertedId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", kind: "asserted", at: T0 }] }));
    expect(plan.inserts.some((x) => x.fact.factKey === "affiliation")).toBe(false);
    expect(plan.report.proposed.some((p) => p.factKey === "affiliation")).toBe(true);
    // the resolver's own assertion insert is never written by a reprocess
    expect(plan.inserts.some((x) => x.fact.origin === "athlete_asserted")).toBe(false);
  });
});

describe("R4 idempotent", () => {
  it("planning again after applying creates nothing", () => {
    const first = planKnowledgeReprocess(input());
    expect(first.inserts.length).toBeGreaterThanOrEqual(3);   // education, role, national team
    const second = planKnowledgeReprocess(input({ facts: apply(FACTS, first) }));
    expect(second.inserts).toEqual([]);
    expect(second.report.counts.created).toBe(0);
    expect(second.report.counts.unchanged).toBeGreaterThanOrEqual(first.report.counts.created);
  });
});

describe("R5 refusals", () => {
  it("a finding that was never stored is refused, not acquired", () => {
    const plan = planKnowledgeReprocess(input());
    expect(plan.report.refused.some((r) => r.evidenceId === null && /never acquired/.test(r.reason))).toBe(true);
    expect(plan.inserts.some((x) => JSON.stringify(x.fact.value).includes("Ghost College"))).toBe(false);
  });

  it("suspect and superseded evidence are refused", () => {
    const ev = EVIDENCE.map((r) => (r.id === EV_NAT ? { ...r, suspect: true } : r.id === EV_EDU ? { ...r, supersededBy: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1" } : r));
    const plan = planKnowledgeReprocess(input({ evidence: ev }));
    expect(plan.report.refused.map((r) => r.reason)).toEqual(expect.arrayContaining(["suspect evidence", "superseded evidence"]));
    expect(plan.inserts.some((x) => x.fact.factKey === "education" || x.fact.factKey === "national_team_participation")).toBe(false);
  });
});

describe("R6 stored claims and payload contracts", () => {
  it("a stored claim with no payload goes through today's registry, keeping its evidence time", () => {
    const nat = planKnowledgeReprocess(input()).inserts.find((x) => x.fact.factKey === "national_team_participation");
    expect(nat!.fact).toMatchObject({ retrievedAt: T0, provenance: { evidenceIds: [EV_NAT] }, authorityTier: 1 });
  });

  it("skips payloads that are not the direct-evidence/2 contract, or whose answer is gone, with a reason", () => {
    expect(remapPayload({ ...Q1, provider: "gemini_grounded" })).toMatchObject({ skip: expect.stringContaining("direct-evidence/2") });
    expect(remapPayload({ ...Q1, payload: { chunks: [], raw: {} } })).toMatchObject({ skip: expect.stringContaining("retention") });
    expect(remapPayload({ ...Q1, endpointFamily: "extraction" })).toMatchObject({ skip: expect.stringContaining("not a search payload") });
    const plan = planKnowledgeReprocess(input({ payloads: [{ ...Q1, provider: "gemini_grounded" }] }));
    expect(plan.report.payloads.skipped).toHaveLength(1);
    // without the re-map, the stored class-year row is re-read as stored: nothing new from it
    expect(plan.inserts.some((x) => x.fact.factKey === "education")).toBe(false);
  });
});

describe("R7 the reprocessed marker", () => {
  it("adds versions without touching the original timestamps", () => {
    const edu = planKnowledgeReprocess(input()).inserts.find((x) => x.fact.factKey === "education")!;
    const m = markReprocessed(edu.fact, NOW);
    expect((m.provenance as any).reprocessed).toMatchObject({ at: NOW.toISOString(), version: REPROCESS_KNOWLEDGE_VERSION, registryVersion: "v3" });
    expect(m.retrievedAt).toBe(T0);
    expect(m.provenance.evidenceIds).toEqual([EV_EDU]);
  });
});
