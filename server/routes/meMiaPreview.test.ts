/**
 * routes/meMiaPreview.test.ts — GET/POST /me/mia-preview and the preview's labels on GET /me/intelligence, over HTTP
 * on PGlite (Express + the real routers; only auth and the evaluator boundary are replaced).
 *
 *   auth      401 without a session, on both verbs
 *   tenancy   the athlete comes from the session only: A computes and reads A's preview; B reads B's (none), never A's,
 *             and a body or query naming A changes nothing
 *   read      GET never reaches the provider (the evaluator throws if called)
 *   Home      /me/intelligence carries `preview` (preliminary + label) for a memory athlete, null for a legacy one
 *
 * Made-up athletes; no sport, school or person is assumed.
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
const callEvaluator = jest.fn();
jest.mock("../services/marketabilityBeta1Evaluator", () => {
  const actual = jest.requireActual("../services/marketabilityBeta1Evaluator");
  return { ...actual, callEvaluator: (...args: any[]) => callEvaluator(...args) };
});

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import meMiaPreviewRouter from "./meMiaPreview";
import meIntelligenceRouter from "./meIntelligence";
import "../workflow/definitions/index";
import { closeTestDb, db, initTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { athletes, memoryFacts } from "../../shared/schema";
import { MARKETABILITY_BETA1_FROZEN_PARAMS } from "../services/marketabilityBeta1FrozenParams";
import { BETA1_COHORTS_V0, BETA1_LOOKUPS_V1, BETA1_POLICY_V0, BETA1_PRIORS_V1, seedBeta1Params } from "../services/marketabilityBeta1Params";
import { BETA1_GOLDENS_PATH } from "../services/marketabilityBeta1Freeze";

jest.setTimeout(180_000);

const bundle = JSON.parse(readFileSync(BETA1_GOLDENS_PATH, "utf8")) as { athletes: { key: string }[] };
function frozenCall() {
  const raw = JSON.parse(readFileSync(join(__dirname, "..", "scripts", "calibration", "runs", "blind-eval-v2", "gemini", `${bundle.athletes[0].key}.dev37.raw.json`), "utf8").replace(/\r\n/g, "\n"));
  return { model: raw.model, modelVersion: raw.modelVersion ?? null, responseId: raw.responseId ?? null, latencyMs: 0, finishReason: raw.finishReason ?? null, truncated: false, usage: raw.usage ?? {}, costUsd: raw.costUsd ?? 0, text: raw.text, native: raw.native ?? {} };
}
/** A made-up facts-only answer citing the prompt's first fact id for every signal (M.I.A. is facts-only since 4 Nov 2026). */
function factsAnswerFor(prompt: string) {
  const id = /^- \[(F\d+|[0-9a-f-]{36})\]/m.exec(prompt)?.[1];
  const dims: any = {};
  for (const [d, sw] of Object.entries(MARKETABILITY_BETA1_FROZEN_PARAMS.config.subWeights as Record<string, Record<string, number>>)) {
    dims[d] = {};
    for (const k of Object.keys(sw)) dims[d][k] = id ? { status: "scored", score: 62, confidence: "MEDIUM", evidence_ids: [id], rationale: "From the facts." } : { status: "missing" };
  }
  const json = { athlete: { identity_confidence: "HIGH" }, marketability_summary: "From the facts.", evidence: id ? [{ id, claim: "c", source_url: "https://example.org/x" }] : [], dimensions: dims };
  return { ...frozenCall(), text: "```json\n" + JSON.stringify(json) + "\n```", native: {} };
}

const g = globalThis as any;
let server: Server; let base = "";
const call = async (method: "GET" | "POST", path: string, athleteId: string | null, body?: unknown) => {
  g.__TEST_ATHLETE_ID = athleteId;
  const r = await fetch(`${base}/api/v1/me${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => undefined) as any };
};

let A = ""; let B = ""; let legacy = "";

beforeAll(async () => {
  await initTestDb();
  await seedBeta1Params({ engine: MARKETABILITY_BETA1_FROZEN_PARAMS, lookups: BETA1_LOOKUPS_V1, policy: BETA1_POLICY_V0, priors: BETA1_PRIORS_V1, cohorts: BETA1_COHORTS_V0, activate: true, createdBy: "route-test" });
  const seed = async (name: string, sport: string) => {
    const [row] = await db.insert(athletes).values({ full_name: name, sport } as any).returning({ id: athletes.id });
    await db.insert(memoryFacts).values([
      { athlete_id: row.id, subject_kind: "athlete", subject_name: name, claim: `The athlete's name is ${name}.`, type: "said", source_ref: "onboarding/r#name", confidence: 1 },
      { athlete_id: row.id, subject_kind: "athlete", subject_name: name, claim: `${name} won a regional final.`, type: "found", source_url: "https://example.org/final", confidence: 0.8 },
    ] as any);
    return row.id;
  };
  A = await seed("Sam Reyes", "Soccer");
  B = await seed("Lee Okafor", "Tennis");
  legacy = await seedAthlete("Pat Legacy");

  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", meIntelligenceRouter);
  app.use("/api/v1/me", meMiaPreviewRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); await closeTestDb(); });
beforeEach(() => { callEvaluator.mockReset(); callEvaluator.mockImplementation(async (prompt: string) => factsAnswerFor(prompt)); });

test("401 without a session, on both verbs", async () => {
  expect((await call("GET", "/mia-preview", null)).status).toBe(401);
  expect((await call("POST", "/mia-preview", null)).status).toBe(401);
  expect(callEvaluator).not.toHaveBeenCalled();
});

test("GET before any compute: not assessed, preliminary, what would sharpen it — and never a provider call", async () => {
  callEvaluator.mockImplementation(() => { throw new Error("provider reached from a read"); });
  const r = await call("GET", "/mia-preview", A);
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ contract: "mia-preview/1", athleteId: A, status: "not_assessed", score: null, preliminary: true, label: "Preliminary — connect to sharpen" });
  expect(r.body.groups).toHaveLength(4);
});

test("tenancy: A computes A's preview; the athlete comes from the session, never the request", async () => {
  const r = await call("POST", `/mia-preview?athleteId=${B}`, A, { athleteId: B });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ athleteId: A, status: "ready", preliminary: true });
  expect(callEvaluator).toHaveBeenCalledTimes(1);
  expect(callEvaluator.mock.calls[0][0]).toContain("Sam Reyes");

  const forB = await call("GET", `/mia-preview?athleteId=${A}`, B);
  expect(forB.body).toMatchObject({ athleteId: B, status: "not_assessed", score: null });
  expect(JSON.stringify(forB.body)).not.toContain(A);

  const again = await call("GET", "/mia-preview", A);
  expect(again.body.score).toBe(r.body.score);
  expect(again.body.inputs.public).toHaveLength(1);
});

test("Home's read carries the preview's labels for a memory athlete, and null for a legacy one", async () => {
  const a = await call("GET", "/intelligence", A);
  expect(a.status).toBe(200);
  expect(a.body.assessment.score).toBeGreaterThan(0);
  expect(a.body.preview).toMatchObject({ preliminary: true, label: "Preliminary — connect to sharpen", inputs: { public: 1, measured: 0 } });
  const l = await call("GET", "/intelligence", legacy);
  expect(l.body.preview).toBeNull();
});
