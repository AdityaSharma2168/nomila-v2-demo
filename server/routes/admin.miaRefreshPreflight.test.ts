/**
 * admin.miaRefreshPreflight.test.ts — PR H2: the deliberate refresh paths ask the identity gate BEFORE enqueueing.
 *
 *   POST /mia/:athleteId/refresh   flag on + identity not resolved ⇒ 409 { held: "identity", identity: { value, reason } }
 *                                  and NOTHING enqueued; resolved, or flag off ⇒ today's 202 { runId, created }.
 *   miaRefreshCohort               the same preflight per athlete: held athletes are reported, not enqueued.
 *
 * requestEvaluation is spied (the enqueue boundary) so "nothing enqueued" is exact; the preflight itself is the real
 * one (miaIdentityPreflight → miaIdentityGate → readIdentityState on PGlite). The evaluator is never reached.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("../lib/auth", () => ({ requireAdmin: (req: any, _res: any, next: any) => { req.athleteId = "op-athlete"; next(); }, requireAuth: (_req: any, _res: any, next: any) => next(), requireFirebaseUser: (_req: any, _res: any, next: any) => next(), firebaseAuth: { verifyIdToken: jest.fn() } }));
jest.mock("../lib/notify", () => ({ notifyPromotion: jest.fn() }));
const requestEvaluation = jest.fn();
jest.mock("../services/marketabilityBeta1Orchestrator", () => {
  const actual = jest.requireActual("../services/marketabilityBeta1Orchestrator");
  return { ...actual, requestEvaluation: (...a: unknown[]) => requestEvaluation(...a) };
});
jest.mock("../services/marketabilityBeta1Evaluator", () => {
  const actual = jest.requireActual("../services/marketabilityBeta1Evaluator");
  return { ...actual, callEvaluator: () => { throw new Error("the evaluator must never be reached from a preflight test"); } };
});
jest.setTimeout(180_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { client, db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import { athleteResearchState, athletes } from "../../shared/schema";
import adminRouter from "./admin";
import { requestCohortRefresh } from "../scripts/intelligence/miaRefreshCohort";

const FLAGS = ["RESEARCH_SUBSTRATE_WRITE", "RESEARCH_REFRESH_ENABLED", "RESEARCH_REFRESH_PROVIDER"] as const;
const env = process.env;
const setFlags = (f: Record<string, string>) => { process.env = { ...env }; for (const k of FLAGS) delete process.env[k]; Object.assign(process.env, f); };
const FLAG_ON = { RESEARCH_REFRESH_ENABLED: "true", RESEARCH_SUBSTRATE_WRITE: "true", RESEARCH_REFRESH_PROVIDER: "direct" };

type IdentityCase = "no_row" | "NULL" | "pending" | "ambiguous" | "failed" | "resolved";
const CASES: IdentityCase[] = ["no_row", "NULL", "pending", "ambiguous", "failed", "resolved"];
const REASON: Partial<Record<IdentityCase, string>> = { ambiguous: "namesakes_unseparated", failed: "no_public_match" };

let seq = 0;
async function seed(identity: IdentityCase): Promise<string> {
  const [a] = await db.insert(athletes).values({ full_name: `Preflight Athlete ${++seq}`, sport: "soccer" } as any).returning({ id: athletes.id });
  if (identity !== "no_row") {
    const value = identity === "NULL" ? null : identity;
    await db.insert(athleteResearchState).values({
      athlete_id: a.id, identity_resolution: value,
      identity_resolution_detail: value === null ? null : ({ at: "2026-10-01T00:00:00.000Z", basis: "q1", ...(REASON[identity] ? { reason: REASON[identity] } : {}), previous: null } as any),
    } as any);
  }
  return a.id;
}

let server: Server; let base: string;
const post = async (path: string, body?: unknown) => { const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) as any }; };

beforeAll(async () => {
  await initTestDb();
  for (const f of ["0048_athlete_index.sql", "0051_identity_users.sql", "0052_identity_claim_sessions.sql"]) await client.exec(readFileSync(join(__dirname, "../../migrations", f), "utf8"));
  const app = express(); app.use(express.json()); app.use("/", adminRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { process.env = env; await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
beforeEach(() => { requestEvaluation.mockReset().mockResolvedValue({ runId: "run-1", created: true }); });
afterEach(() => { process.env = env; });

const TABLE = (["off", "on"] as const).flatMap((flag) => CASES.map((identity) => [flag, identity] as const));

describe("admin refresh: flag × identity", () => {
  test("covers 2 × 6 cases", () => { expect(TABLE).toHaveLength(12); });

  test.each(TABLE)("flag %s · identity %s", async (flag, identity) => {
    setFlags(flag === "on" ? FLAG_ON : {});
    const id = await seed(identity);
    const r = await post(`/mia/${id}/refresh`, { reason: "score looks wrong" });
    if (flag === "off" || identity === "resolved") {
      expect(r.status).toBe(202);
      expect(r.json).toEqual({ runId: "run-1", created: true, athleteId: id });
      expect(requestEvaluation).toHaveBeenCalledTimes(1);
      expect(requestEvaluation).toHaveBeenCalledWith({ athleteId: id, trigger: "USER_REQUESTED_REFRESH", force: true, reason: "score looks wrong", createdBy: "admin_manual_refresh" });
    } else {
      expect(r.status).toBe(409);
      expect(r.json).toMatchObject({
        held: "identity", athleteId: id,
        identity: { value: identity === "no_row" || identity === "NULL" ? null : identity, reason: REASON[identity] ?? null },
      });
      expect(r.json.error).toMatch(/held for identity/);
      expect(requestEvaluation).not.toHaveBeenCalled();               // nothing enqueued
    }
  });

  test("the existing 404 / 422 answers come first and are unchanged", async () => {
    setFlags(FLAG_ON);
    expect((await post(`/mia/00000000-0000-0000-0000-000000000000/refresh`)).status).toBe(404);
    const [noSport] = await db.insert(athletes).values({ full_name: "No Sport Preflight" } as any).returning({ id: athletes.id });
    expect((await post(`/mia/${noSport.id}/refresh`)).status).toBe(422);
    expect(requestEvaluation).not.toHaveBeenCalled();
  });
});

describe("cohort script: the same preflight per athlete", () => {
  test("flag on: held athletes are reported with their identity and NOT enqueued; resolved ones are", async () => {
    setFlags(FLAG_ON);
    const ids = Object.fromEntries(await Promise.all(CASES.map(async (c) => [c, await seed(c)] as const))) as Record<IdentityCase, string>;
    const out = await requestCohortRefresh(CASES.map((c) => ({ id: ids[c], name: c })));
    expect(requestEvaluation).toHaveBeenCalledTimes(1);
    expect(requestEvaluation).toHaveBeenCalledWith({ athleteId: ids.resolved, trigger: "USER_REQUESTED_REFRESH", force: true, reason: "diverse-athlete Objective validation cohort", createdBy: "cohort_validation" });
    for (const c of CASES) {
      const row = out.find((o) => o.athleteId === ids[c])!;
      if (c === "resolved") expect(row).toMatchObject({ requested: true, runId: "run-1" });
      else expect(row).toEqual({ athleteId: ids[c], name: c, requested: false, held: { held: "identity", identity: { value: c === "no_row" || c === "NULL" ? null : c, reason: REASON[c] ?? null } } });
    }
  });

  test("flag off: every athlete is enqueued, exactly as before", async () => {
    setFlags({});
    const ids = await Promise.all(CASES.map((c) => seed(c)));
    const out = await requestCohortRefresh(ids.map((id, i) => ({ id, name: CASES[i] })));
    expect(out.every((o) => o.requested)).toBe(true);
    expect(requestEvaluation).toHaveBeenCalledTimes(CASES.length);
  });
});
