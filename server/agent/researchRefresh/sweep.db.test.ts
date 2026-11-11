/**
 * sweep.db.test.ts — who gets an agent research refresh, on a real (PGlite) Postgres. The run starter is faked (no
 * workflow, no provider): this pins the selection and the guards.
 *
 *   W1 AGENT_RESEARCH_REFRESH off: a one-athlete request refuses ("off"); the sweep starts nothing
 *   W2 the refresh on, the COHORT off: the one-athlete request starts; the sweep starts nothing (owner: Mia first)
 *   W3 both on: real users with no agent research are due (never researched first); an athlete marked for the agent
 *      onboarding and never researched waits for it; one with no sign-in is not a candidate; fresh research is not due
 *      unless her name, sport or team changed since her last refresh; at most `limit` a sweep
 *   W4 the day cap: today's refresh spend leaves no room for one more refresh's cap ⇒ nothing starts
 *   W5 the cron door: 401 without the secret; with it, the sweep's answer
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { agentRuns, memoryFacts } from "../../../shared/schema";
import { workflowRuns, workflowSteps } from "../../../shared/schemaWorkflow";
import { RESEARCH_REFRESH_PROCESS } from "./config";
import { requestResearchRefresh, sweepResearchRefresh, type RefreshStarter } from "./sweep";
import { researchRefreshCronRouter } from "./routes";

const FLAGS = ["AGENT_RESEARCH_REFRESH", "AGENT_RESEARCH_REFRESH_COHORT"];
const now = new Date("2026-10-12T10:00:00.000Z");
const DAY = 86_400_000;
let started: Array<{ athleteId: string; trigger: string; idempotencyKey?: string }> = [];
const start: RefreshStarter = async (o) => { started.push({ athleteId: o.athleteId, trigger: o.input.trigger, idempotencyKey: o.idempotencyKey }); return { runId: `run-${started.length}`, created: true }; };

const ids: Record<string, string> = {};
async function merged(athleteId: string, at: Date, skillId = "research/merge") {
  await db.insert(agentRuns).values({ athlete_id: athleteId, skill_id: skillId, skill_version: "1", trigger: "event", provider: "openai", model: "m", effort: "high", status: "completed", started_at: at, ended_at: at });
}

beforeAll(async () => {
  await initTestDb();
  const user = (name: string, extra: Record<string, unknown> = {}) => seedAthlete(name, { sport: "Rowing", status: "active", auth_id: `uid-${name}`, ...extra } as any);
  ids.never = await user("Never Researched");
  ids.agentFront = await user("Agent Front", { agent_onboarding_required: true });
  ids.noSignIn = await seedAthlete("No Sign In", { sport: "Rowing", status: "active" } as any);
  ids.stale = await user("Stale Research");
  await merged(ids.stale, new Date(now.getTime() - 45 * DAY));
  ids.fresh = await user("Fresh Research");
  // Researched through the compact merge (RESEARCH_MERGE_COMPACT): it counts as her last research all the same.
  await merged(ids.fresh, new Date(now.getTime() - 3 * DAY), "research/merge-compact");
  ids.moved = await user("Moved Team");
  await merged(ids.moved, new Date(now.getTime() - 3 * DAY));
  // Her last refresh recorded team "Old Club"; her memory now says "New Club".
  const [run] = await db.insert(workflowRuns).values({ athlete_id: ids.moved, process: RESEARCH_REFRESH_PROCESS, definition_version: 1, active_scope: RESEARCH_REFRESH_PROCESS, status: "done", started_at: new Date(now.getTime() - 3 * DAY) }).returning();
  await db.insert(workflowSteps).values({ run_id: run.id, step: "finish", ordinal: 4, kind: "code", status: "done", output: { anchor: { name: "Moved Team", sport: "Rowing", team: "Old Club" } } });
  await db.insert(memoryFacts).values({ athlete_id: ids.moved, subject_kind: "athlete", subject_name: "Moved Team", claim: "Moved Team rows for New Club.", type: "said", source_ref: "chat#1", source_title: "You told us", confidence: 1, field: "team", field_value: "New Club" } as any);
});
afterAll(closeTestDb);
beforeEach(() => { started = []; for (const k of FLAGS) delete process.env[k]; });
afterAll(() => { for (const k of FLAGS) delete process.env[k]; });

test("W1: the refresh off — a one-athlete request refuses; the sweep starts nothing", async () => {
  expect(await requestResearchRefresh(ids.never, { trigger: "manual", reason: "operator", now }, { start })).toEqual({ started: false, reason: "off" });
  expect(await sweepResearchRefresh({ now, start })).toMatchObject({ enabled: false, cohort: false, started: 0 });
  expect(started).toEqual([]);
});

test("W2: the refresh on, the cohort off — one athlete starts; the sweep starts nothing", async () => {
  process.env.AGENT_RESEARCH_REFRESH = "true";
  expect(await requestResearchRefresh(ids.never, { trigger: "manual", reason: "operator", now, kick: false }, { start })).toEqual({ started: true, runId: "run-1", created: true });
  expect(await sweepResearchRefresh({ now, start })).toMatchObject({ enabled: true, cohort: false, checked: 0, started: 0 });
  expect(started.map((s) => s.athleteId)).toEqual([ids.never]);
});

test("W3: both on — due athletes, never-researched first; onboarding first for an agent-front athlete; anchors; the per-sweep cap", async () => {
  process.env.AGENT_RESEARCH_REFRESH = "true";
  process.env.AGENT_RESEARCH_REFRESH_COHORT = "true";
  const r = await sweepResearchRefresh({ now, start, limit: 10 });
  const who = started.map((s) => s.athleteId);
  expect(who).toEqual(expect.arrayContaining([ids.never, ids.stale, ids.moved]));
  expect(who).not.toContain(ids.agentFront);
  expect(who).not.toContain(ids.noSignIn);
  expect(who).not.toContain(ids.fresh);
  expect(who.indexOf(ids.never)).toBeLessThan(who.indexOf(ids.stale));
  expect(started.find((s) => s.athleteId === ids.moved)).toMatchObject({ trigger: "anchor", idempotencyKey: `research_refresh:anchor:${ids.moved}:2026-10-12` });
  expect(started.find((s) => s.athleteId === ids.stale)).toMatchObject({ trigger: "schedule" });
  expect(r).toMatchObject({ started: 3, stale: 2, anchor: 1, skipped: { awaiting_onboarding: 1 } });

  started = [];
  expect(await sweepResearchRefresh({ now, start, limit: 1 })).toMatchObject({ started: 1 });
  expect(started).toHaveLength(1);
});

test("W4: the day cap — today's refresh spend leaves no room for one more refresh ⇒ nothing starts", async () => {
  process.env.AGENT_RESEARCH_REFRESH = "true";
  process.env.AGENT_RESEARCH_REFRESH_COHORT = "true";
  await db.insert(agentRuns).values({ athlete_id: ids.fresh, skill_id: "research", skill_version: "1", trigger: "event", provider: "openai", model: "m", effort: "high", status: "completed", parent_ref: "research_refresh:x:research_a", cost_micro_usd: 9_000_000, started_at: now, ended_at: now });
  expect(await requestResearchRefresh(ids.never, { trigger: "manual", reason: "operator", now }, { start })).toEqual({ started: false, reason: "day_cap" });
  expect(await sweepResearchRefresh({ now, start })).toMatchObject({ started: 0, skipped: { day_cap: 1 } });
  expect(started).toEqual([]);
});

test("W5: the cron door — 401 without the secret; with it, the sweep's answer", async () => {
  const app = express(); app.use(express.json());
  app.use(researchRefreshCronRouter((req) => req.header("x-cron-secret") === "s", async () => ({ enabled: false, cohort: false, checked: 0, started: 0, stale: 0, anchor: 0, skipped: {} })));
  const server: Server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/internal/agent-research-refresh-cron`;
  try {
    expect((await fetch(base, { method: "POST" })).status).toBe(401);
    const ok = await fetch(base, { method: "POST", headers: { "x-cron-secret": "s" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, enabled: false, cohort: false, started: 0 });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
