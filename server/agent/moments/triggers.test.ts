/**
 * triggers.test.ts — what starts a moments scan, and the guards (in-memory store; the run starter is injected); and the
 * flag and its limits.
 *
 *   T1 off unless AGENT_MOMENTS is exactly "true" (nothing is read or started); "true" in the dev yaml, "false" in prod
 *   T2 nothing without a current Brief
 *   T3 at most one scan per athlete per 7 days (a failed run does not count, nor one stuck running for 2 hours); the
 *      run is moments_scan, scheduled, enqueued only (kick false) under the key moments:<athlete>:<day>
 *   T4 a starter failure is reported, never thrown
 *   T5 the caps: the design's defaults (run $0.25, week $0.50, 10 searches, 6,000 output tokens, 42 days); env tunes
 *      them, nonsense falls back
 */
jest.mock("../../db", () => ({ db: {} }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { createMemoryStore, type AgentStore } from "../research/store";
import { agentMomentsEnabled, MOMENTS } from "./config";
import { countsAsScan, requestMomentsScan, STALE_RUNNING_MS, type MomentsRunStarter } from "./triggers";

const A = "00000000-0000-4000-8000-0000000000aa";
const KEYS = ["AGENT_MOMENTS", "AGENT_MOMENTS_RUN_CAP_USD", "AGENT_MOMENTS_WEEK_CAP_USD", "AGENT_MOMENTS_MAX_SEARCHES", "AGENT_MOMENTS_MAX_OUTPUT_TOKENS", "AGENT_DAY_COST_CAP_USD"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const GCP = join(__dirname, "..", "..", "..", "gcp");
const envOf = (file: string) =>
  (parse(readFileSync(join(GCP, file), "utf8")).spec.template.spec.containers[0].env as { name: string; value?: string }[]);

function starter() {
  const calls: Array<Parameters<MomentsRunStarter>[0]> = [];
  const start: MomentsRunStarter = async (o) => { calls.push(o); return { runId: `wf-${calls.length}`, created: true }; };
  return { calls, start };
}
const brief = (store: AgentStore) => store.writeBrief(A, { summary: "S", sections: [], factIds: [], internal: { currentSponsors: [], pastSponsors: [] }, runId: null });
async function momentsRun(store: AgentStore, status: "completed" | "failed") {
  const id = await store.startRun({ athleteId: A, skillId: "moments", skillVersion: "1.0.0", trigger: "schedule", model: { provider: "openai", model: "m", effort: "medium" }, parentRef: null });
  await store.finishRun(A, id, { status, stopReason: null, cost: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, webSearchCalls: 0, microUsd: 1 }, steps: [], evidenceRead: [], output: null, error: null });
}

test("T1: off unless AGENT_MOMENTS is exactly \"true\"; on in the dev Cloud Run yaml only, off in prod, exactly once each", async () => {
  const { calls, start } = starter();
  for (const v of [undefined, "", "false", "TRUE", "1", "yes", " true"]) {
    if (v === undefined) delete process.env.AGENT_MOMENTS; else process.env.AGENT_MOMENTS = v;
    expect(agentMomentsEnabled()).toBe(false);
    expect(await requestMomentsScan(A, { reason: "x" }, { store: createMemoryStore(), start })).toEqual({ started: false, reason: "off" });
  }
  expect(calls).toHaveLength(0);
  process.env.AGENT_MOMENTS = "true";
  expect(agentMomentsEnabled()).toBe(true);
  // Stage 1 (owner, 25 Oct 2026): on in prod too.
  for (const [file, value] of [["cloud-run-dev.yaml", "true"], ["cloud-run-prod.yaml", "true"]]) {
    expect([file, envOf(file).filter((e) => e.name === "AGENT_MOMENTS")]).toEqual([file, [{ name: "AGENT_MOMENTS", value }]]);
  }
});

test("T2–T3: a Brief is needed; one scan per 7 days (failed runs do not count)", async () => {
  process.env.AGENT_MOMENTS = "true";
  const store = createMemoryStore();
  const { calls, start } = starter();
  expect(await requestMomentsScan(A, { reason: "weekly moments scan" }, { store, start })).toEqual({ started: false, reason: "no_brief" });
  await brief(store);
  await momentsRun(store, "failed");
  expect(await requestMomentsScan(A, { reason: "weekly moments scan", idempotencyKey: "k1" }, { store, start })).toEqual({ started: true, runId: "wf-1", joined: false });
  // Enqueue only: kick false (the workflow tick runs the scan, never the request that asked for it).
  expect(calls[0]).toEqual({ process: "moments_scan", athleteId: A, input: { trigger: "schedule", reason: "weekly moments scan" }, createdBy: "moments:schedule", idempotencyKey: "k1", kick: false });
  await momentsRun(store, "completed");
  expect(await requestMomentsScan(A, { reason: "weekly moments scan" }, { store, start })).toEqual({ started: false, reason: "weekly_cap" });
  // Eight days on, the next one may start.
  const later = new Date(Date.now() + 8 * 86_400_000);
  expect(await requestMomentsScan(A, { reason: "weekly moments scan", now: later }, { store, start })).toMatchObject({ started: true });
  // With no key given, one per athlete per day.
  expect(calls[1]).toMatchObject({ idempotencyKey: `moments:${A}:${later.toISOString().slice(0, 10)}`, kick: false });
  // A request while one is in flight joins it.
  const joining: MomentsRunStarter = async () => ({ runId: "wf-running", created: false });
  const fresh = createMemoryStore();
  await fresh.writeBrief(A, { summary: "S", sections: [], factIds: [], internal: { currentSponsors: [], pastSponsors: [] }, runId: null });
  expect(await requestMomentsScan(A, { reason: "x" }, { store: fresh, start: joining })).toEqual({ started: true, runId: "wf-running", joined: true });
});

test("T3b: a run stuck \"running\" for more than 2 hours crashed — it does not block the week's scan; a fresh one does", async () => {
  process.env.AGENT_MOMENTS = "true";
  const store = createMemoryStore();
  await brief(store);
  await store.startRun({ athleteId: A, skillId: "moments", skillVersion: "1.0.0", trigger: "schedule", model: { provider: "openai", model: "m", effort: "medium" }, parentRef: null });
  const { start } = starter();
  expect(await requestMomentsScan(A, { reason: "x" }, { store, start })).toEqual({ started: false, reason: "weekly_cap" });   // just started: running
  expect(countsAsScan({ status: "running", startedAt: new Date().toISOString() }, new Date())).toBe(true);
  const threeHours = new Date(Date.now() + 3 * 3_600_000);
  expect(await requestMomentsScan(A, { reason: "x", now: threeHours }, { store, start })).toMatchObject({ started: true });
  expect(countsAsScan({ status: "running", startedAt: "2026-10-10T10:00:00.000Z" }, new Date("2026-10-10T12:01:00.000Z"))).toBe(false);
  expect(countsAsScan({ status: "completed", startedAt: "2026-10-10T10:00:00.000Z" }, new Date("2026-10-10T12:01:00.000Z"))).toBe(true);
  expect(STALE_RUNNING_MS).toBe(2 * 3_600_000);
});

test("T4: a starter failure is reported, never thrown", async () => {
  process.env.AGENT_MOMENTS = "true";
  const store = createMemoryStore();
  await brief(store);
  expect(await requestMomentsScan(A, { reason: "x" }, { store, start: async () => { throw new Error("db down"); } })).toEqual({ started: false, reason: "error" });
});

test("T5: the caps — the design's defaults; env tunes them; nonsense, zero and negatives fall back", () => {
  expect({ run: MOMENTS.RUN_RESERVE_MICRO_USD, week: MOMENTS.WEEK_CAP_MICRO_USD, day: MOMENTS.DAY_CAP_MICRO_USD, searches: MOMENTS.MAX_SEARCHES, out: MOMENTS.MAX_OUTPUT_TOKENS, horizon: MOMENTS.HORIZON_DAYS, max: MOMENTS.MAX_MOMENTS, every: MOMENTS.SCAN_EVERY_DAYS })
    .toEqual({ run: 250_000, week: 500_000, day: 5_000_000, searches: 10, out: 6_000, horizon: 60, max: 12, every: 7 });
  process.env.AGENT_MOMENTS_RUN_CAP_USD = "0.1";
  process.env.AGENT_MOMENTS_WEEK_CAP_USD = "1";
  process.env.AGENT_MOMENTS_MAX_SEARCHES = "6";
  process.env.AGENT_MOMENTS_MAX_OUTPUT_TOKENS = "abc";
  expect([MOMENTS.RUN_RESERVE_MICRO_USD, MOMENTS.WEEK_CAP_MICRO_USD, MOMENTS.MAX_SEARCHES, MOMENTS.MAX_OUTPUT_TOKENS]).toEqual([100_000, 1_000_000, 6, 6_000]);
  process.env.AGENT_MOMENTS_RUN_CAP_USD = "0";
  process.env.AGENT_MOMENTS_MAX_SEARCHES = "-3";
  expect([MOMENTS.RUN_RESERVE_MICRO_USD, MOMENTS.MAX_SEARCHES]).toEqual([250_000, 10]);
});
