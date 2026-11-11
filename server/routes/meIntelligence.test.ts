/**
 * routes/meIntelligence.test.ts — Concept 0.4 Slice 2, GET /me/intelligence (`my-intelligence/0.1`, FROZEN with D-1..D-3)
 * and the Me overview slot, on PGlite.
 *
 *   P1 every page state, and the precedence ambiguous/failed > pending > not started > updating > no assessment >
 *      insufficient > partial > assessed (pure table + over HTTP)
 *   P2 O-6: under ambiguous / failed the read of record is withheld server-side — not in the payload in any form
 *   P3 an unknown dimension (imputed-majority per State, or absent from the row) carries score null
 *   P4 no assumed counts, no component values, no thresholds, no legacy/numeric confidence in the payload
 *   P5 citation strength from the LEDGER row via citationStrength(): grounded, site_only, nomila_supplied — never State's
 *      merged list; not_support, unrecorded (incl. a pre-#706 row with no lineage) and dangling ids are never sent
 *   P6 D-1: an active H1-eligible mia_evaluation run ⇒ updating; an H1-blocked one ⇒ not; research (Q1–Q6) activity
 *      alone ⇒ not; a finished run with no new ledger row ⇒ no new read
 *   P7 identity is null exactly when identityResolutionEnabled() is off; reason codes carried for D-3; no actions (D-2)
 *   P8 the Me slot equals the page's pageState / score / evidenceAsOf in every state
 *   P9 read-only: every statement is a SELECT, and the route serves under a READ ONLY session
 *   P10 auth: 401 without a session; an athlete reads only her own (another athlete's read never leaks)
 *   P11 bridge: null with its flags off; shaped per contract with them on
 *   P12 0.2: each dimension carries the row's stored weight, contribution and sub-signals (an imputed signal's value is
 *      withheld, a dimension absent from the row carries null / []), and a waiting request carries its sourceClass —
 *      nothing recomputed, nothing new reached for
 * Providers are never reached: the evaluator boundary is mocked to throw, and nothing here would call it anyway.
 * Fixtures are a generic athlete; no sport, school or person is assumed.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const id = (globalThis as any).__TEST_ATHLETE_ID;
    if (!id) { res.status(401).json({ error: "Unauthorized" }); return; }
    req.athleteId = id; next();
  },
}));
jest.mock("../services/marketabilityBeta1Evaluator", () => {
  const actual = jest.requireActual("../services/marketabilityBeta1Evaluator");
  return { ...actual, callEvaluator: () => { throw new Error("provider reached from a read-only route"); } };
});

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import meIntelligenceRouter from "./meIntelligence";
import meKnowledgeRouter from "./meKnowledge";
import { client, closeTestDb, db, initTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { athleteResearchState, intelligenceLedger, researchRuns, workflowRuns, workflowSteps } from "../../shared/schema";
import { MARKETABILITY_DIMENSIONS, type MarketabilityDimension } from "../services/intelligence/types";
import { findingsFromMia } from "../services/intelligence/state/build";
import {
  buildMyIntelligence, myIntelligenceEntry, runMayEvaluate, selectPageState,
  type MyIntelligenceIdentity, type MyIntelligenceView, type PageState, type ReadState,
} from "../services/intelligence/views/myIntelligence";

jest.setTimeout(180_000);   // PGlite schema push on a cold worker

const g = globalThis as any;
let server: Server; let base = "";
const get = async (path: string, athleteId: string | null) => {
  g.__TEST_ATHLETE_ID = athleteId;
  const r = await fetch(`${base}/api/v1/me${path}`);
  return { status: r.status, body: await r.json().catch(() => undefined) };
};
const page = async (athleteId: string): Promise<MyIntelligenceView> => {
  const r = await get("/intelligence", athleteId);
  expect(r.status).toBe(200);
  return r.body as MyIntelligenceView;
};
/** Every [key, value] pair in a payload, recursively. */
const entriesDeep = (v: unknown): Array<[string, unknown]> =>
  v !== null && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [[k, x] as [string, unknown], ...entriesDeep(x)]) : [];

// ── flags ─────────────────────────────────────────────────────────────────────

/** identityResolutionEnabled() = RESEARCH_REFRESH_ENABLED && RESEARCH_SUBSTRATE_WRITE && provider "direct". */
const IDENTITY_ON = { RESEARCH_REFRESH_ENABLED: "true", RESEARCH_SUBSTRATE_WRITE: "true", RESEARCH_REFRESH_PROVIDER: "direct" };
const FLAG_KEYS = ["RESEARCH_REFRESH_ENABLED", "RESEARCH_SUBSTRATE_WRITE", "RESEARCH_REFRESH_PROVIDER"];
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(FLAG_KEYS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const k of FLAG_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

// ── fixtures ──────────────────────────────────────────────────────────────────

type Dim = MarketabilityDimension;
type DimSpec = { score: number | null; imputed?: boolean } | "omit";
const EVIDENCE_AS_OF = new Date("2026-09-20T00:00:00.000Z");
/** A distinctive component value: P4 asserts it never reaches the payload. */
const COMPONENT_VALUE = 61.37;
/** A mixed, realistic read: strengths, middling (State's `neutral`) and gaps, all measured. */
const MIXED: Record<Dim, DimSpec> = {
  athletic_authority: { score: 88 }, audience_scale: { score: 62 }, engagement_quality: { score: 41 },
  cultural_relevance: { score: 77 }, narrative_power: { score: 81 }, brand_fit: { score: 66 },
  commercial_proof: { score: 33 }, momentum: { score: 58 },
};
const allDims = (spec: DimSpec): Record<Dim, DimSpec> => Object.fromEntries(MARKETABILITY_DIMENSIONS.map((d) => [d, spec])) as Record<Dim, DimSpec>;

/** One of each lineage level, plus one citation with no lineage at all (written before #706). */
const EVIDENCE_WITH_LINEAGE = [
  { id: "E1", claim: "Named to a national youth roster.", sourceUrl: "https://governing.example/rosters/2026", sourceType: "official", sourceTitle: "Roster", observedAt: "2026-06-01", lineage: { level: "native_supported" } },
  { id: "E2", claim: "Profiled in a regional outlet.", sourceUrl: "https://news.example/profile", sourceType: "major_media", sourceTitle: "Profile", observedAt: null, lineage: { level: "native_retrieved" } },
  { id: "E3", claim: "1,200 followers on a connected account.", sourceUrl: null, sourceType: "connected", sourceTitle: null, observedAt: "2026-09-14", lineage: { level: "nomila_supplied" } },
  { id: "E4", claim: "Said to have a footwear deal.", sourceUrl: "https://blog.example/rumour", sourceType: "secondary", sourceTitle: "Rumour", observedAt: null, lineage: { level: "asserted_only" } },
  { id: "E5", claim: "Unbacked claim.", sourceUrl: "not a url", sourceType: null, sourceTitle: null, observedAt: null, lineage: { level: "unsupported" } },
  { id: "E6", claim: "", sourceUrl: "https://team.example/bio", sourceType: "official", sourceTitle: "Bio", observedAt: null },
];
const stripLineage = (e: any) => { const { lineage: _drop, ...rest } = e; return rest; };

function miaValue(spec: Record<Dim, DimSpec>, opts: { findings?: boolean; lineage?: boolean; score?: number } = {}) {
  const withFindings = opts.findings ?? true;
  const evidence = (opts.lineage ?? true) ? EVIDENCE_WITH_LINEAGE : EVIDENCE_WITH_LINEAGE.map(stripLineage);
  const present = MARKETABILITY_DIMENSIONS.filter((d) => spec[d] !== "omit");
  const dimensions = present.map((d) => {
    const s = spec[d] as { score: number | null; imputed?: boolean };
    const sig = (k: string) => ({ key: `${d}.${k}`, value: COMPONENT_VALUE, imputed: !!s.imputed, source: s.imputed ? "imputed" : "web_researched", confidence: 70 });
    // P12: the stored contribution is score × weight as the row holds it; the view never recomputes it.
    return { dimension: d, score: s.score, confidence: 72, weight: 0.125, contribution: s.score == null ? null : Math.round(s.score * 0.125 * 100) / 100, signals: [sig("signal_a"), sig("signal_b")] };
  });
  const findings = present.map((d) => ({
    key: d, value: (spec[d] as any).score, confidence: "HIGH", rationale: `Nomila's interpretation of ${d}.`, confidenceReason: `Why ${d} is held with this confidence.`,
    // E99 resolves to nothing (dangling): it must never be rendered as a source.
    citedEvidence: ["E1", "E2", "E3", "E4", "E5", "E6", "E99"], danglingEvidence: ["E99"],
    components: [
      { key: `${d}.signal_a`, value: COMPONENT_VALUE, weight: 0.5, label: "A", evidenceClass: "EVALUATED", confidence: "MEDIUM", rationale: "Component reason.", citedEvidence: ["E1", "E4", "E6", "E99"] },
      { key: `${d}.signal_b`, value: COMPONENT_VALUE, evidenceClass: "ASSUMED", confidence: null, rationale: null, citedEvidence: [] },
    ],
  }));
  return {
    score: opts.score ?? 612, composite: 0.7123, confidence: 0.6631, drivers: [{ dimension: "athletic_authority", impact: 0.2 }],
    dimensions,
    summary: "The athlete has a credible competitive profile and a modest but engaged audience.",
    overallConfidence: { level: "MEDIUM", explanation: "Competitive record is well sourced; commercial history is thin." },
    identityConfidence: "HIGH",
    importantMissingData: ["Past brand partnerships"],
    ...(withFindings
      ? {
          headline: { key: "mia_score", value: opts.score ?? 612, confidence: "MEDIUM" },
          findings, evidence,
          notes: { strengths: ["Elite competitive credential"], constraints: ["Small audience"], missingEvidence: ["Past brand partnerships"] },
        }
      : {}),
  };
}

async function seedRead(athleteId: string, value: unknown, evidenceAsOf = EVIDENCE_AS_OF): Promise<string> {
  const [row] = await db.insert(intelligenceLedger).values({
    subject_type: "athlete", subject_id: athleteId, owner: "marketability", kind: "ASSESSMENT", value: value as any, confidence: null,
    versions: { methodology: "v1.0.1-beta.1", evaluator: "mia-eval/test", params: "params/test", lookups: "l", priors: "p" } as any,
    evidence_as_of: evidenceAsOf,
  } as any).returning({ id: intelligenceLedger.id });
  return row.id;
}

type IdentitySeed = "pending" | "resolved" | "ambiguous" | "failed" | null;
async function setIdentity(athleteId: string, value: IdentitySeed, detail: Record<string, unknown> = {}) {
  await db.insert(athleteResearchState).values({
    athlete_id: athleteId, identity_resolution: value,
    identity_resolution_detail: value === null ? null : { basis: "q1", at: "2026-09-25T10:00:00.000Z", confidence: 0.41, researchRunId: "rr-1", ...detail },
  } as any);
}

/** An mia_evaluation run (or any process) with its steps. `snapshot` = the snapshot step's output, once it ran. */
async function seedRun(athleteId: string, o: { process?: string; status?: string; force?: boolean; snapshot?: Record<string, unknown>; version?: number } = {}) {
  const process = o.process ?? "mia_evaluation";
  const [run] = await db.insert(workflowRuns).values({
    athlete_id: athleteId, process, definition_version: o.version ?? 1,
    active_scope: o.force ? `${process}:forced` : process, status: o.status ?? "waiting",
    input: { trigger: "SOCIAL_BLOCK_CHANGED", force: !!o.force, reason: null } as any,
    ...(o.status === "done" ? { finished_at: new Date() } : {}),
  } as any).returning({ id: workflowRuns.id });
  if (process === "mia_evaluation") {
    await db.insert(workflowSteps).values({ run_id: run.id, step: "wait", ordinal: 0, kind: "schedule", status: o.snapshot || o.status === "done" ? "done" : "waiting" } as any);
    if (o.snapshot) await db.insert(workflowSteps).values({ run_id: run.id, step: "snapshot", ordinal: 1, kind: "code", status: "done", output: o.snapshot as any } as any);
  }
  return run.id;
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await initTestDb();
  const app = express(); app.use(express.json());
  app.use("/api/v1/me", meKnowledgeRouter);
  app.use("/api/v1/me", meIntelligenceRouter);
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { g.__TEST_ATHLETE_ID = undefined; if (server) await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });

// ── P1 the state function ─────────────────────────────────────────────────────

describe("P1 state selection (pure)", () => {
  const id = (value: MyIntelligenceIdentity["value"]): MyIntelligenceIdentity => ({ value, basis: null, reason: null, determinedAt: null });
  const reads: Array<ReadState | null> = [null, "insufficient", "assessed_partial", "assessed"];
  const identities: Array<MyIntelligenceIdentity | null> = [null, id(null), id("pending"), id("resolved"), id("ambiguous"), id("failed")];

  it("follows the frozen precedence for every combination, first match wins", () => {
    for (const identity of identities) for (const readState of reads) for (const inProgress of [false, true]) {
      const { pageState, withheld } = selectPageState({ identity, readState, inProgress });
      const v = identity?.value ?? null; const on = identity !== null;
      const expected: PageState =
        on && v === "ambiguous" ? "identity_ambiguous"
          : on && v === "failed" ? "identity_failed"
            : on && v === "pending" ? "identity_pending"
              : on && v === null && readState === null ? "identity_not_started"
                : readState === null ? (inProgress ? "updating" : "no_assessment")
                  : readState;
      expect(pageState).toBe(expected);
      expect(withheld).toBe(expected === "identity_ambiguous" || expected === "identity_failed");
    }
  });

  it("the ranking, pairwise: each state beats every state below it", () => {
    expect(selectPageState({ identity: id("ambiguous"), readState: "assessed", inProgress: true }).pageState).toBe("identity_ambiguous");
    expect(selectPageState({ identity: id("failed"), readState: null, inProgress: true }).pageState).toBe("identity_failed");
    expect(selectPageState({ identity: id("pending"), readState: null, inProgress: true }).pageState).toBe("identity_pending");
    expect(selectPageState({ identity: id(null), readState: null, inProgress: true }).pageState).toBe("identity_not_started");
    expect(selectPageState({ identity: null, readState: null, inProgress: true }).pageState).toBe("updating");
    expect(selectPageState({ identity: id("resolved"), readState: null, inProgress: false }).pageState).toBe("no_assessment");
    expect(selectPageState({ identity: null, readState: "insufficient", inProgress: true }).pageState).toBe("insufficient");
    expect(selectPageState({ identity: id(null), readState: "assessed_partial", inProgress: false }).pageState).toBe("assessed_partial");
    expect(selectPageState({ identity: id("resolved"), readState: "assessed", inProgress: true }).pageState).toBe("assessed");
  });

  it("D-1 run predicate: blocked / skipped / unchanged-unforced never evaluate; a not-yet-snapshotted run may", () => {
    expect(runMayEvaluate({ input: { force: false }, snapshotOutput: null })).toBe(true);
    expect(runMayEvaluate({ input: { force: false }, snapshotOutput: { snapshotId: "s", digest: "d", evidenceAsOf: "x", unchanged: false } })).toBe(true);
    expect(runMayEvaluate({ input: { force: false }, snapshotOutput: { blocked: "identity_gate", identity: null, trigger: "SIGNUP", force: false } })).toBe(false);
    expect(runMayEvaluate({ input: { force: false }, snapshotOutput: { skipped: "no resolvable identity" } })).toBe(false);
    expect(runMayEvaluate({ input: { force: false }, snapshotOutput: { snapshotId: "s", unchanged: true } })).toBe(false);
    expect(runMayEvaluate({ input: { force: true }, snapshotOutput: { snapshotId: "s", unchanged: true } })).toBe(true);
  });
});

// ── P1/P2/P7/P8 every state over HTTP, with the Me slot ───────────────────────

interface Scenario { name: string; env?: Record<string, string>; setup: (a: string) => Promise<void>; expect: PageState; withheld?: boolean; hasRead?: boolean; inProgress?: boolean }
const SCENARIOS: Scenario[] = [
  { name: "no read, nothing in flight", setup: async () => {}, expect: "no_assessment" },
  { name: "no read, an eligible evaluation in flight", setup: async (a) => { await seedRun(a); }, expect: "updating", inProgress: true },
  { name: "every dimension measured", setup: async (a) => { await seedRead(a, miaValue(MIXED)); }, expect: "assessed", hasRead: true },
  { name: "some dimensions unknown", setup: async (a) => { await seedRead(a, miaValue({ ...MIXED, brand_fit: { score: 70, imputed: true }, momentum: "omit" })); }, expect: "assessed_partial", hasRead: true },
  { name: "every dimension unknown", setup: async (a) => { await seedRead(a, miaValue(allDims({ score: 50, imputed: true }))); }, expect: "insufficient", hasRead: true },
  { name: "read + evaluation in flight ⇒ the read, with inProgress", setup: async (a) => { await seedRead(a, miaValue(MIXED)); await seedRun(a); }, expect: "assessed", hasRead: true, inProgress: true },
  { name: "flag on, identity NULL, no read", env: IDENTITY_ON, setup: async () => {}, expect: "identity_not_started" },
  { name: "flag on, identity NULL, a read ⇒ falls through", env: IDENTITY_ON, setup: async (a) => { await seedRead(a, miaValue(MIXED)); }, expect: "assessed", hasRead: true },
  { name: "flag on, pending, no read", env: IDENTITY_ON, setup: async (a) => { await setIdentity(a, "pending"); await seedRun(a); }, expect: "identity_pending" },
  { name: "flag on, pending, a read ⇒ shown", env: IDENTITY_ON, setup: async (a) => { await setIdentity(a, "pending"); await seedRead(a, miaValue(MIXED)); }, expect: "identity_pending", hasRead: true },
  { name: "flag on, resolved, in flight", env: IDENTITY_ON, setup: async (a) => { await setIdentity(a, "resolved"); await seedRun(a); }, expect: "updating", inProgress: true },
  { name: "flag on, resolved, a read", env: IDENTITY_ON, setup: async (a) => { await setIdentity(a, "resolved"); await seedRead(a, miaValue(MIXED)); }, expect: "assessed", hasRead: true },
  { name: "flag on, ambiguous, a read + a run ⇒ withheld", env: IDENTITY_ON, setup: async (a) => { await setIdentity(a, "ambiguous", { reason: "namesakes_unseparated" }); await seedRead(a, miaValue(MIXED)); await seedRun(a); }, expect: "identity_ambiguous", withheld: true },
  { name: "flag on, failed, a read ⇒ withheld", env: IDENTITY_ON, setup: async (a) => { await setIdentity(a, "failed", { reason: "no_public_match" }); await seedRead(a, miaValue(MIXED)); }, expect: "identity_failed", withheld: true },
];

describe("P1/P2/P8 every page state over HTTP, and the Me slot equals the page", () => {
  for (const s of SCENARIOS) {
    it(s.name, async () => withEnv(s.env ?? {}, async () => {
      const a = await seedAthlete("Test Athlete");
      await s.setup(a);
      const v = await page(a);
      expect(v.contract).toBe("my-intelligence/0.2");
      expect(v.athleteId).toBe(a);
      expect(v.pageState).toBe(s.expect);
      expect(v.inProgress).toBe(!!s.inProgress);
      expect(v.movement).toEqual({ displayable: false, reason: "no_governed_stability_threshold" });
      expect(v.identity === null).toBe(!s.env);                                   // P7: null ⇔ boundary off
      if (s.hasRead) {
        expect(v.assessment).not.toBeNull();
        expect(v.assessment!.score).toBe(612);
        expect(v.assessment!.confidenceBand).toBeNull();
        if (s.expect !== "identity_pending") expect(v.assessment!.readState).toBe(s.expect);
        else expect(v.assessment!.readState).toBe("assessed");
      } else {
        expect(v.assessment).toBeNull();
      }
      if (s.withheld) {
        // P2 (O-6): a read of record exists, and nothing of it is in the payload.
        const [row] = await db.select({ id: intelligenceLedger.id }).from(intelligenceLedger).where(eq(intelligenceLedger.subject_id, a));
        expect(row).toBeDefined();
        const text = JSON.stringify(v);
        expect(v.assessment).toBeNull();
        expect(text).not.toContain(row.id);
        expect(entriesDeep(v).some(([, x]) => x === 612)).toBe(false);
        expect(text).not.toContain("Nomila's interpretation");
        expect(text).not.toContain("governing.example");
        expect(v.inProgress).toBe(false);
      }

      // P8: the Me slot is the page's own state, score and date — through the same state function.
      const ov = await get("/overview", a);
      expect(ov.status).toBe(200);
      expect(ov.body.version).toBe("knowledge/3");
      expect(ov.body.intelligence).toEqual({ status: "ready", pageState: v.pageState, score: v.assessment?.score ?? null, evidenceAsOf: v.assessment?.evidenceAsOf ?? null, preliminary: null });
      expect(ov.body.intelligence).toEqual(myIntelligenceEntry(v));
      if (s.withheld) expect(ov.body.intelligence.score).toBeNull();
    }));
  }
});

// ── P3/P4/P5 the assessment body ──────────────────────────────────────────────

describe("P3/P4/P5 the assessment of record, projected", () => {
  let a = ""; let entryId = ""; let v: MyIntelligenceView;
  const value = miaValue({ ...MIXED, brand_fit: { score: 70, imputed: true }, momentum: "omit" });
  beforeAll(async () => {
    a = await seedAthlete("Test Athlete");
    entryId = await seedRead(a, value);
    v = await page(a);
  });

  it("carries the row's identity, versions, overall, summary and notes from the one reader", () => {
    const x = v.assessment!;
    expect(x.entryId).toBe(entryId);
    expect(x.evidenceAsOf).toBe(EVIDENCE_AS_OF.toISOString());
    expect(new Date(x.createdAt).toISOString()).toBe(x.createdAt);
    expect(x.versions).toEqual({ methodology: "v1.0.1-beta.1", evaluator: "mia-eval/test", params: "params/test" });
    expect(x.overall).toEqual({ level: "MEDIUM", explanation: "Competitive record is well sourced; commercial history is thin." });
    expect(x.summary).toBe(value.summary);
    expect(x.hasReasons).toBe(true);
    expect(x.notes).toEqual({ strengths: ["Elite competitive credential"], constraints: ["Small audience"], missingEvidence: ["Past brand partnerships"], evaluationRisks: [] });
  });

  it("always eight dimensions in canonical order; state is State's own label, verbatim (incl. neutral)", () => {
    const x = v.assessment!;
    expect(x.dimensions.map((d) => d.key)).toEqual([...MARKETABILITY_DIMENSIONS]);
    const state = new Map(findingsFromMia({ id: entryId, value, evidence_as_of: EVIDENCE_AS_OF }).map((f) => [f.key, f.direction]));
    for (const d of x.dimensions) if (d.key !== "momentum") expect(d.state).toBe(state.get(`mia.${d.key}`));
    expect(x.dimensions.map((d) => d.state)).toContain("neutral");
    expect(x.dimensions.map((d) => d.state)).toContain("gap");
    expect(x.dimensions.map((d) => d.state)).toContain("strength");
  });

  it("P3 an unknown dimension has score null — imputed-majority (State says unknown) and absent from the row", () => {
    const by = Object.fromEntries(v.assessment!.dimensions.map((d) => [d.key, d]));
    expect(by.brand_fit).toMatchObject({ state: "unknown", score: null });
    expect(by.momentum).toEqual({
      key: "momentum", state: "unknown", score: null, confidence: null, confidenceReason: null, rationale: null, components: [],
      sources: { grounded: [], site_only: [], nomila_supplied: [], not_support: [], unrecorded: [] },
      weight: null, contribution: null, signals: [],
    });
    expect(by.athletic_authority.score).toBe(88);
    expect(by.audience_scale).toMatchObject({ state: "neutral", score: 62 });
    expect(v.assessment!.readState).toBe("assessed_partial");
  });

  it("P4 no assumed counts, no component values, no thresholds, no numeric/legacy confidence or drivers", () => {
    const deep = entriesDeep(v.assessment);
    const keys = new Set(deep.map(([k]) => k));
    for (const banned of ["imputedShare", "assumed", "drivers", "composite", "identityConfidence", "headline", "importantMissingData", "danglingEvidence", "citedEvidence", "lineage", "strengthAtOrAbove", "gapAtOrBelow", "threshold", "modelVersion", "evidenceIds", "asOf"]) {
      expect(keys.has(banned)).toBe(false);
    }
    // 0.2: `value` / `imputed` / `weight` / `contribution` live ONLY on a dimension or its signals, never on a component;
    // and the ASSUMED dimension's signal values (COMPONENT_VALUE, imputed) never reach the payload.
    const bf = v.assessment!.dimensions.find((d) => d.key === "brand_fit")!;
    expect(bf.signals.every((s) => s.imputed && s.value === null)).toBe(true);
    expect(deep.some(([, x]) => x === 0.6631 || x === 0.7123)).toBe(false);   // numeric confidence, composite
    for (const d of v.assessment!.dimensions) for (const c of d.components) expect(Object.keys(c).sort()).toEqual(["confidence", "evidenceClass", "key", "rationale", "sources"]);
    for (const d of v.assessment!.dimensions) for (const s of d.signals) expect(Object.keys(s).sort()).toEqual(["imputed", "key", "source", "value"]);
    expect(Object.keys(v).sort()).toEqual(["asOf", "assessment", "athleteId", "bridge", "contract", "identity", "identityUnconfirmed", "inProgress", "movement", "pageState", "preview"]);
  });

  it("P12 0.2: the stored weight, contribution and signals ride each dimension; imputed values withheld; absent ⇒ null / []", () => {
    const by = Object.fromEntries(v.assessment!.dimensions.map((d) => [d.key, d]));
    // Measured: the row's own numbers, verbatim.
    expect(by.athletic_authority.weight).toBe(0.125);
    expect(by.athletic_authority.contribution).toBe(11);                       // 88 × 0.125 as the fixture stored it
    expect(by.athletic_authority.signals).toEqual([
      { key: "athletic_authority.signal_a", value: COMPONENT_VALUE, source: "web_researched", imputed: false },
      { key: "athletic_authority.signal_b", value: COMPONENT_VALUE, source: "web_researched", imputed: false },
    ]);
    // Imputed (State says unknown): weight and contribution as stored, every signal flagged, no value.
    expect(by.brand_fit).toMatchObject({ state: "unknown", score: null, weight: 0.125, contribution: 8.75 });
    expect(by.brand_fit.signals).toEqual([
      { key: "brand_fit.signal_a", value: null, source: "imputed", imputed: true },
      { key: "brand_fit.signal_b", value: null, source: "imputed", imputed: true },
    ]);
    // Absent from the row entirely.
    expect(by.momentum).toMatchObject({ weight: null, contribution: null, signals: [] });
    // The contributions are the row's, not a recomputation: they add up to what the row stored, nothing else.
    const sum = v.assessment!.dimensions.reduce((n, d) => n + (d.contribution ?? 0), 0);
    expect(sum).toBeCloseTo(value.dimensions.reduce((n: number, d: any) => n + (d.contribution ?? 0), 0), 6);
  });

  it("P12 a row whose dimensions carry no weight / contribution (an older evaluator) serves null — never invented", async () => {
    const b = await seedAthlete("Test Athlete");
    const bare = miaValue(MIXED);
    bare.dimensions = bare.dimensions.map(({ weight: _w, contribution: _c, ...rest }: any) => rest);
    await seedRead(b, bare);
    const w = await page(b);
    expect(w.pageState).toBe("assessed");
    for (const d of w.assessment!.dimensions) {
      expect(d).toMatchObject({ weight: null, contribution: null });
      expect(d.signals).toHaveLength(2);
      expect(typeof d.score).toBe("number");
    }
  });

  it("P5 citations bucketed from the LEDGER row by citationStrength; ungrounded ones (not_support, unrecorded) and dangling ids are not sent", () => {
    const aa = v.assessment!.dimensions.find((d) => d.key === "athletic_authority")!;
    // Oct 2026: E4/E5 (asserted_only, unsupported) and E6 (no grounding record) stay in the ledger, never in the payload.
    expect(aa.sources).toEqual({ grounded: ["E1"], site_only: ["E2"], nomila_supplied: ["E3"], not_support: [], unrecorded: [] });
    // State's merged `citedEvidence` would put E1 (grounded) and E6 (unrecorded) together. Not here.
    const stateMerged = findingsFromMia({ id: entryId, value, evidence_as_of: EVIDENCE_AS_OF }).find((f) => f.key === "mia.athletic_authority")!.citedEvidence!.map((e) => e.id);
    expect(stateMerged.sort()).toEqual(["E1", "E6"]);
    expect(aa.sources.grounded).not.toContain("E6");
    // Components: backed citations only — E4 (not_support), E6 (unrecorded) and E99 (dangling) are dropped.
    expect(aa.components[0]).toEqual({ key: "athletic_authority.signal_a", evidenceClass: "EVALUATED", confidence: "MEDIUM", rationale: "Component reason.", sources: ["E1"] });
    expect(aa.components[1]).toEqual({ key: "athletic_authority.signal_b", evidenceClass: "ASSUMED", confidence: null, rationale: null, sources: [] });
    const payload = JSON.stringify(v);
    for (const hidden of ["E99", "blog.example/rumour", "Unbacked claim", "team.example/bio"]) expect(payload).not.toContain(hidden);
    expect(v.assessment!.evidence.map((e) => [e.id, e.strength, e.domain])).toEqual([
      ["E1", "grounded", "governing.example"], ["E2", "site_only", "news.example"], ["E3", "nomila_supplied", null],
    ]);
    // Every id a count is drawn from is a row the payload carries.
    const counted = v.assessment!.dimensions.flatMap((d) => [...Object.values(d.sources).flat(), ...d.components.flatMap((c) => c.sources)]);
    expect(counted.every((id) => v.assessment!.evidence.some((e) => e.id === id))).toBe(true);
  });

  it("P5 a pre-#706 row (no lineage recorded) is unrecorded throughout, so no citation is sent — never upgraded to grounded", async () => {
    const b = await seedAthlete("Test Athlete");
    await seedRead(b, miaValue(MIXED, { lineage: false }));
    const w = await page(b);
    for (const d of w.assessment!.dimensions) {
      expect(d.sources).toEqual({ grounded: [], site_only: [], nomila_supplied: [], not_support: [], unrecorded: [] });
      expect(d.components[0].sources).toEqual([]);
    }
    expect(w.assessment!.evidence).toEqual([]);
  });

  it("S7: a row without findings degrades — hasReasons false, labels from State, no reasons or sources", async () => {
    const b = await seedAthlete("Test Athlete");
    await seedRead(b, miaValue(MIXED, { findings: false }));
    const w = await page(b);
    expect(w.pageState).toBe("assessed");
    expect(w.assessment!.hasReasons).toBe(false);
    expect(w.assessment!.evidence).toEqual([]);
    expect(w.assessment!.notes).toEqual({ strengths: [], constraints: [], missingEvidence: [], evaluationRisks: [] });
    for (const d of w.assessment!.dimensions) {
      expect(d).toMatchObject({ confidence: null, confidenceReason: null, rationale: null, components: [] });
      expect(Object.values(d.sources).flat()).toEqual([]);
      expect(typeof d.score).toBe("number");
    }
  });
});

// ── P6 D-1 ────────────────────────────────────────────────────────────────────

describe("P6 D-1: only an active, H1-eligible M.I.A. evaluation is 'updating'", () => {
  it("an active eligible run ⇒ updating (boundary off, and boundary on with resolved)", async () => {
    const a = await seedAthlete("Test Athlete"); await seedRun(a, { status: "running", snapshot: { snapshotId: "s1", digest: "d", evidenceAsOf: "x", unchanged: false } });
    expect((await page(a)).pageState).toBe("updating");
    await withEnv(IDENTITY_ON, async () => {
      const b = await seedAthlete("Test Athlete"); await setIdentity(b, "resolved"); await seedRun(b, { force: true });
      expect(await page(b)).toMatchObject({ pageState: "updating", inProgress: true });
    });
  });

  it("an H1-blocked run is not updating: identity NULL / pending / ambiguous, or a recorded identity_gate block", async () => withEnv(IDENTITY_ON, async () => {
    for (const ident of [null, "pending", "ambiguous", "failed"] as IdentitySeed[]) {
      const a = await seedAthlete("Test Athlete");
      if (ident !== null) await setIdentity(a, ident); await seedRun(a);
      const v = await page(a);
      expect(v.inProgress).toBe(false);
      expect(v.pageState).not.toBe("updating");
    }
    // Resolved now, but this run's snapshot already recorded the block (it ran before resolution): not updating.
    const b = await seedAthlete("Test Athlete"); await setIdentity(b, "resolved");
    await seedRun(b, { status: "running", snapshot: { blocked: "identity_gate", identity: null, trigger: "SIGNUP", force: false } });
    expect(await page(b)).toMatchObject({ pageState: "no_assessment", inProgress: false });
  }));

  it("a run that skipped, or found the evidence unchanged without force, is not updating", async () => {
    const a = await seedAthlete("Test Athlete"); await seedRun(a, { status: "running", snapshot: { skipped: "no resolvable identity" } });
    expect((await page(a)).pageState).toBe("no_assessment");
    const b = await seedAthlete("Test Athlete"); await seedRead(b, miaValue(MIXED)); await seedRun(b, { status: "running", snapshot: { snapshotId: "s", digest: "d", evidenceAsOf: "x", unchanged: true } });
    expect((await page(b)).inProgress).toBe(false);
    const c = await seedAthlete("Test Athlete"); await seedRead(c, miaValue(MIXED)); await seedRun(c, { status: "running", force: true, snapshot: { snapshotId: "s", digest: "d", evidenceAsOf: "x", unchanged: true } });
    expect((await page(c)).inProgress).toBe(true);
  });

  it("research (Q1–Q6) activity alone is not updating", async () => {
    for (const env of [{}, IDENTITY_ON]) await withEnv(env, async () => {
      const a = await seedAthlete("Test Athlete");
      if (env === IDENTITY_ON) await setIdentity(a, "resolved");
      await seedRun(a, { process: "research_refresh", status: "running", version: 3 });
      await db.insert(researchRuns).values({ athlete_id: a, domain: "achievements", trigger: "manual", status: "running" } as any);
      expect(await page(a)).toMatchObject({ pageState: "no_assessment", inProgress: false, assessment: null });
    });
  });

  it("a finished run never implies a new read: the ledger decides", async () => {
    const a = await seedAthlete("Test Athlete");
    await seedRun(a, { status: "done", snapshot: { snapshotId: "s", digest: "d", evidenceAsOf: "x", unchanged: false } });
    expect(await page(a)).toMatchObject({ pageState: "no_assessment", inProgress: false, assessment: null });

    const b = await seedAthlete("Test Athlete");
    const prior = await seedRead(b, miaValue(MIXED));
    await seedRun(b, { status: "done", snapshot: { snapshotId: "s", digest: "d", evidenceAsOf: "x", unchanged: false } });
    const v = await page(b);
    expect(v).toMatchObject({ pageState: "assessed", inProgress: false });
    expect(v.assessment!.entryId).toBe(prior);
  });
});

// ── P7 identity ───────────────────────────────────────────────────────────────

describe("P7 identity: null only with the boundary off; reason codes for D-3; no actions (D-2)", () => {
  it("boundary off ⇒ identity null even with an ambiguous determination stored, and the read is shown", async () => {
    const a = await seedAthlete("Test Athlete");
    await setIdentity(a, "ambiguous", { reason: "namesakes_unseparated" }); await seedRead(a, miaValue(MIXED));
    const v = await page(a);
    expect(v.identity).toBeNull();
    expect(v.pageState).toBe("assessed");
  });

  it("boundary on ⇒ E3's identity, with basis / reason / determinedAt; never confidence or the research run", async () => withEnv(IDENTITY_ON, async () => {
    const cases: Array<[IdentitySeed, Record<string, unknown>, MyIntelligenceIdentity]> = [
      [null, {}, { value: null, basis: null, reason: null, determinedAt: null }],
      ["pending", {}, { value: "pending", basis: null, reason: null, determinedAt: null }],
      ["ambiguous", { reason: "uncertain" }, { value: "ambiguous", basis: "q1", reason: "uncertain", determinedAt: "2026-09-25T10:00:00.000Z" }],
      ["ambiguous", { reason: "conflicts_athlete_statement" }, { value: "ambiguous", basis: "q1", reason: "conflicts_athlete_statement", determinedAt: "2026-09-25T10:00:00.000Z" }],
      ["ambiguous", { basis: "athlete_rejected" }, { value: "ambiguous", basis: "athlete_rejected", reason: null, determinedAt: "2026-09-25T10:00:00.000Z" }],
      ["failed", { reason: "no_public_match" }, { value: "failed", basis: "q1", reason: "no_public_match", determinedAt: "2026-09-25T10:00:00.000Z" }],
    ];
    for (const [value, detail, expected] of cases) {
      const a = await seedAthlete("Test Athlete");
      if (value !== null) await setIdentity(a, value, detail);
      const v = await page(a);
      expect(v.identity).toEqual(expected);
      const keys = new Set(entriesDeep(v).map(([k]) => k));
      for (const banned of ["confidence", "researchRunId", "actions", "action", "cta", "url", "confirmUrl"]) expect(keys.has(banned)).toBe(false);
    }
  }));
});

// ── P9 read-only ──────────────────────────────────────────────────────────────

describe("P9 read-only", () => {
  const ALL_ON = { ...IDENTITY_ON };

  it("every statement the read model issues is a SELECT (every read path on)", async () => withEnv(ALL_ON, async () => {
    const a = await seedAthlete("Test Athlete");
    await setIdentity(a, "resolved"); await seedRead(a, miaValue(MIXED)); await seedRun(a, { status: "running", snapshot: { snapshotId: "s", unchanged: false } });
    const q = jest.spyOn(client, "query"); const x = jest.spyOn(client, "exec");
    try {
      const v = await buildMyIntelligence(a);
      expect(v.inProgress).toBe(true);
      const statements = [...q.mock.calls, ...x.mock.calls].map((c) => String(c[0]));
      expect(statements.length).toBeGreaterThanOrEqual(8);   // identity + research status + ledger + runs + steps + requests + objectives ×2
      for (const s of statements) expect(s.trim()).toMatch(/^select\b/i);
    } finally { q.mockRestore(); x.mockRestore(); }
  }));

  it("the route serves under a READ ONLY session (which does refuse a write)", async () => withEnv(ALL_ON, async () => {
    const a = await seedAthlete("Test Athlete");
    await setIdentity(a, "pending"); await seedRead(a, miaValue(MIXED));
    const before = await db.select().from(intelligenceLedger).where(eq(intelligenceLedger.subject_id, a));
    await client.exec("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    try {
      await expect(db.update(intelligenceLedger).set({ confidence: "HIGH" }).where(eq(intelligenceLedger.subject_id, a))).rejects.toThrow(/read-only/i);
      const v = await page(a);
      expect(v.pageState).toBe("identity_pending");
      expect((await get("/overview", a)).status).toBe(200);
    } finally {
      await client.exec("SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE");
    }
    expect(await db.select().from(intelligenceLedger).where(eq(intelligenceLedger.subject_id, a))).toEqual(before);
  }));
});

// ── P10 auth ──────────────────────────────────────────────────────────────────

describe("P10 auth and tenancy", () => {
  it("401 without a session", async () => {
    const r = await get("/intelligence", null);
    expect(r.status).toBe(401);
  });

  it("an athlete reads only her own: another athlete's read, identity and run never appear", async () => {
    const mine = await seedAthlete("Test Athlete");
    const theirs = await seedAthlete("Other Athlete");
    const theirEntry = await seedRead(theirs, miaValue(MIXED, { score: 744 }));
    await seedRun(theirs);
    const v = await page(mine);
    expect(v.athleteId).toBe(mine);
    expect(v).toMatchObject({ pageState: "no_assessment", inProgress: false, assessment: null });
    const text = JSON.stringify(v);
    expect(text).not.toContain(theirs);
    expect(text).not.toContain(theirEntry);
    expect(entriesDeep(v).some(([, x]) => x === 744)).toBe(false);
    // And theirs is theirs.
    expect((await page(theirs)).assessment!.entryId).toBe(theirEntry);
  });
});

// ── P11 bridge ────────────────────────────────────────────────────────────────

describe("P11 bridge", () => {
  afterEach(() => jest.restoreAllMocks());

  it("null for every field (the Objectives and intelligence requests are retired)", async () => {
    const a = await seedAthlete("Test Athlete"); await seedRead(a, miaValue(MIXED));
    expect((await page(a)).bridge).toEqual({ waitingOnYou: null, goals: null, reviewCount: null });
  });
});
