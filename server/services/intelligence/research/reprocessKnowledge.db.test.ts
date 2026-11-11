/**
 * reprocessKnowledge.db.test.ts — generic deterministic reprocessing on PGlite, through the admin seam (Concept 0.4 PR 4).
 *
 *   D1 dry run: 200 with the plan; nothing written (facts, evidence, payloads, research state unchanged)
 *   D2 a write while RESEARCH_SUBSTRATE_WRITE is off: 409 { reason: "disabled" }, nothing written
 *   D3 the write: the fact today's mapping supports is created from the ORIGINAL evidence row — its id in provenance, its
 *      retrieved_at (not now), a `reprocessed` marker with the versions; evidence and payload rows are byte-identical
 *   D4 idempotent: a second run creates nothing
 *   D5 404 for an unknown athlete
 * No provider is reachable: the module imports none, and nothing here mocks one into existence.
 */
jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }), logger: { info() {}, warn() {}, error() {}, debug() {} } }));
jest.setTimeout(180_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../../testUtils/pgliteDb";
import { athleteFacts, athleteResearchState, researchEvidence, researchRuns, researchSourcePayloads } from "../../../../shared/schema";
import adminIntelligenceRouter from "../../../routes/adminIntelligence";
import { __resetResearchPolicyCache } from "./config";
import { HYBRID_MARKER } from "./spec/directEvidenceV1";
import { REPROCESS_KNOWLEDGE_VERSION } from "./reprocessKnowledge";

const T0 = new Date("2025-09-01T00:00:00.000Z");
const QUOTE = "Senior studying BS Example Studies at Example University";
let server: Server; let base = "";
let athleteId = ""; let evidenceId = "";

const post = async (path: string, body: unknown = {}) => {
  const r = await fetch(`${base}/api/v1/admin/intelligence${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};
const snapshot = async () => ({
  facts: await db.select().from(athleteFacts).where(eq(athleteFacts.athlete_id, athleteId)),
  evidence: await db.select().from(researchEvidence).where(eq(researchEvidence.athlete_id, athleteId)),
  payloads: await db.select().from(researchSourcePayloads).where(eq(researchSourcePayloads.athlete_id, athleteId)),
  state: await db.select().from(athleteResearchState).where(eq(athleteResearchState.athlete_id, athleteId)),
});
const setWrite = (on: boolean) => { if (on) process.env.RESEARCH_SUBSTRATE_WRITE = "true"; else delete process.env.RESEARCH_SUBSTRATE_WRITE; __resetResearchPolicyCache(); };

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Reprocess Rae");
  const [run] = await db.insert(researchRuns).values({ athlete_id: athleteId, domain: "refresh", trigger: "manual", status: "ok", started_at: T0, as_of: T0 } as any).returning({ id: researchRuns.id });
  const items = { education_class_year: { status: "found", findings: [{ value: { class_year_label: "senior", season: 2026, degree: "BS Example Studies", institution: "Example University" }, statement: null, as_of: "2025-09-01", sources: [{ url: "https://uni.example/roster", quote: QUOTE }] }] } };
  const [p] = await db.insert(researchSourcePayloads).values({
    run_id: run.id, athlete_id: athleteId, provider: "gemini_direct", endpoint_family: "search:Identity + Biography + Affiliations",
    request: { path: "generateContent", params: { contract: "v2" } } as any,
    payload: { answerText: "Research prose.", chunks: [{ id: "d0:c0", url: "https://uni.example/roster", domain: "uni.example" }], supports: [], raw: { text: `Research prose.\n${HYBRID_MARKER}\n${JSON.stringify({ items })}`, groundingChunks: [], groundingSupports: [] } } as any,
    payload_hash: "h", bytes: 1, sanitizer_version: "test", fetched_at: T0,
  } as any).returning({ id: researchSourcePayloads.id });
  // The row an OLDER mapping stored for that finding: class year only; the degree rode along as an extra.
  const [ev] = await db.insert(researchEvidence).values({
    athlete_id: athleteId, run_id: run.id, payload_id: p.id, kind: "profile_attribute",
    claim: { factKey: "class_year", value: { label: "senior", season: 2026 }, degree: "BS Example Studies", item: "education_class_year" } as any,
    support: { chunkIds: ["d0:c0"], quote: QUOTE } as any, lineage_status: "native_supported", source_url: "https://uni.example/roster", source_domain: "uni.example",
    source_type: "official_team_or_school", retrieved_at: T0, confidence: "0.85", source_class: "web_researched", suspect: false, dedupe_key: "edu:old",
  } as any).returning({ id: researchEvidence.id });
  evidenceId = ev.id;
  await db.insert(athleteFacts).values({ athlete_id: athleteId, fact_key: "class_year", value: { label: "senior", season: 2026 } as any, value_text: "senior 2026", status: "current", retrieved_at: T0, origin: "research", source_class: "web_researched", authority_tier: 2, confidence: "0.85", provenance: { evidenceIds: [ev.id], domains: ["uni.example"] } as any, freshness_family: "affiliations", resolver_version: "v1", registry_version: "v2" } as any);

  const app = express(); app.use(express.json()); app.use("/api/v1/admin/intelligence", adminIntelligenceRouter);
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { setWrite(false); if (server) await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });

describe("knowledge reprocess (admin seam, PGlite)", () => {
  it("D1 dry run reports the plan and writes nothing", async () => {
    setWrite(false);
    const before = await snapshot();
    const r = await post(`/athletes/${athleteId}/knowledge/reprocess`, { dryRun: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ dryRun: true, wrote: false, version: REPROCESS_KNOWLEDGE_VERSION, counts: { created: 1 } });
    expect(r.json.created[0]).toMatchObject({ factKey: "education", evidenceIds: [evidenceId], retrievedAt: T0.toISOString() });
    expect(await snapshot()).toEqual(before);
  });

  it("D2 a write with research writes off is refused", async () => {
    setWrite(false);
    const before = await snapshot();
    const r = await post(`/athletes/${athleteId}/knowledge/reprocess`);
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("disabled");
    expect(await snapshot()).toEqual(before);
  });

  it("D3 writes the fact from the original evidence, with its time and a reprocessed marker; evidence untouched", async () => {
    setWrite(true);
    const before = await snapshot();
    const r = await post(`/athletes/${athleteId}/knowledge/reprocess`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ wrote: true, counts: { created: 1 } });
    const [edu] = await db.select().from(athleteFacts).where(and(eq(athleteFacts.athlete_id, athleteId), eq(athleteFacts.fact_key, "education")));
    expect(edu).toMatchObject({ status: "current", origin: "research", value: { institution: "Example University", degree: "BS Example Studies" }, registry_version: "v3" });
    expect(edu.retrieved_at.toISOString()).toBe(T0.toISOString());
    expect(edu.provenance).toMatchObject({ evidenceIds: [evidenceId], reprocessed: { version: REPROCESS_KNOWLEDGE_VERSION, registryVersion: "v3" } });
    const after = await snapshot();
    expect(after.evidence).toEqual(before.evidence);
    expect(after.payloads).toEqual(before.payloads);
    // the class-year fact it already had is left alone
    expect(after.facts.find((f) => f.fact_key === "class_year")).toEqual(before.facts.find((f) => f.fact_key === "class_year"));
  });

  it("D4 a second run creates nothing", async () => {
    setWrite(true);
    const before = await snapshot();
    const r = await post(`/athletes/${athleteId}/knowledge/reprocess`);
    expect(r.status).toBe(200);
    expect(r.json.counts.created).toBe(0);
    expect((await snapshot()).facts).toEqual(before.facts);
  });

  it("D5 404 for an unknown athlete", async () => {
    expect((await post(`/athletes/00000000-0000-4000-8000-000000000000/knowledge/reprocess`, { dryRun: true })).status).toBe(404);
  });
});
