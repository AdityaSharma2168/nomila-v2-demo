/**
 * identityRecheck.db.test.ts — research on hold while the athlete's identity is open, and the identity re-check on new
 * evidence, on PGlite. No provider is reached: the runs are created through the real runner (startRun) and never
 * executed (the kick is a spy, background work is off). Made-up athletes only.
 *
 *   I1 pure: what counts as new identity evidence (a new / different school or handle; case, accents, "@" ignored)
 *   I2 no open "#identity" verdict ⇒ a no-op (nothing started); the flag off ⇒ "off"
 *   I3 an open verdict ⇒ one identity-topic lean refresh through the runner (created_by identity_recheck, topics
 *      ["identity"], aims []), kicked
 *   I4 the 24-hour cap: a second request is "recent"; across a window boundary still "recent"; after 24 hours it starts
 *   I5 two instances at once: one run, never two (the requests, and two starts that both raced past the 24-hour read)
 *   I6 the account-deletion fence ⇒ "deleting", nothing started
 *   I7 the cost caps: DAILY_RESEARCH_CAP_USD spent (the runner's hard stop) or unreadable ⇒ "daily_budget"; the refresh
 *      day cap ⇒ "daily_budget"
 *   I8 the routine refresh skips an open identity ("identity_open"): a scheduled requestResearchRefresh, the sweep's
 *      candidates, and refresh_research for any topic but identity — the identity topic runs; an operator's or
 *      script's deliberate run (trigger manual, the admin door) still starts
 *   I9 typed handles: her word (said facts) for a held athlete even when the re-check itself waits; a newer handle
 *      supersedes her older one for that platform (history kept)
 *   I10 a failed or canceled re-check still counts toward the 24 hours (the read agrees with the idempotency key)
 *   I11 her sign-up research or agent onboarding still running ⇒ research_running
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("../../lib/backgroundHost", () => ({ runsBackgroundWork: () => false }));   // kick is a no-op
jest.setTimeout(180_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { agentRuns, athletes, memoryFacts } from "../../../shared/schema";
import { workflowRuns } from "../../../shared/schemaWorkflow";
import "../../workflow/definitions/index";
import { hasOpenIdentityDispute, IDENTITY_RECHECK_CREATED_BY, newIdentityEvidence, recheckKey, requestIdentityRecheck } from "./identityRecheck";
import { LEAN_REFRESH_PROCESS, requestLeanRefresh } from "./leanRefresh";
import { refreshCandidates, requestResearchRefresh, sweepResearchRefresh, type RefreshStarter } from "./sweep";
import { researchRefreshAdminRouter } from "./routes";
import { researchTools } from "./tools";
import * as dailyCap from "../onboarding/dailyCap";
import { FOOTPRINT_SKILL_ID } from "../onboarding/dailyCap";

const env = process.env;
const HOUR = 3_600_000;
const kick = jest.fn();

let seq = 0;
async function athlete(opts: { open?: boolean; extra?: Record<string, unknown> } = {}): Promise<string> {
  seq++;
  const id = await seedAthlete("Robin Sample", { sport: "Rowing", status: "active", auth_id: `uid-ir-${seq}`, email: `robin${seq}@example.com`, ...(opts.extra ?? {}) } as any);
  if (opts.open) {
    await db.insert(memoryFacts).values({
      athlete_id: id, subject_kind: "athlete", subject_name: "Robin Sample", claim: "Research could not yet confirm which public profile belongs to Robin Sample (Rowing).",
      type: "made", source_ref: `agent_runs/00000000-0000-4000-8000-${String(seq).padStart(12, "0")}#identity`, source_title: "Nomila research", confidence: 0.5, status: "disputed",
    } as any);
  }
  return id;
}
const leanRuns = (id: string) => db.select().from(workflowRuns).where(and(eq(workflowRuns.athlete_id, id), eq(workflowRuns.process, LEAN_REFRESH_PROCESS)));

beforeAll(async () => { await initTestDb(); });
afterAll(async () => { process.env = env; await closeTestDb(); });
beforeEach(() => {
  process.env = { ...env, LEAN_SIGNUP_RESEARCH: "true" };
  for (const k of ["DAILY_RESEARCH_CAP_USD", "AGENT_RESEARCH_REFRESH", "AGENT_RESEARCH_REFRESH_COHORT", "AGENT_RESEARCH_REFRESH_DAY_CAP_USD", "AGENT_RESEARCH_REFRESH_RUN_CAP_USD"]) delete process.env[k];
  kick.mockClear();
});

test("I1: new identity evidence — a new or different school or handle; nothing when unchanged", () => {
  expect(newIdentityEvidence(null, { school: "Example State" })).toBe("school");
  expect(newIdentityEvidence({ school: "Example State" }, { school: "  example   STATE " })).toBeNull();
  expect(newIdentityEvidence({ school: "Example State" }, { school: "Example Tech" })).toBe("school");
  expect(newIdentityEvidence({ school: "Example State" }, { school: null })).toBeNull();     // omitted: never counts
  expect(newIdentityEvidence({ socials: { instagram: "robin" } }, { socials: { instagram: "@Robin" } })).toBeNull();
  expect(newIdentityEvidence({ socials: { instagram: "robin" } }, { socials: { tiktok: "robin" } })).toBe("handle");
  expect(newIdentityEvidence({ socials: {} }, { socials: { instagram: "robin.rows" } })).toBe("handle");
  expect(newIdentityEvidence({ school: "Example State", socials: { instagram: "robin" } }, { school: "Example State", socials: { instagram: "robin" } })).toBeNull();
});

test("I2: no open identity verdict ⇒ a no-op; the flag off ⇒ off", async () => {
  const settled = await athlete();
  // A superseded verdict is not open (research.ts isOpenIdentityFact).
  await db.insert(memoryFacts).values({ athlete_id: settled, subject_kind: "athlete", subject_name: "Robin Sample", claim: "old verdict", type: "made", source_ref: "agent_runs/x#identity", confidence: 0.5, status: "superseded" } as any);
  expect(await hasOpenIdentityDispute(settled)).toBe(false);
  expect(await requestIdentityRecheck(settled, "school", { kick })).toEqual({ started: false, reason: "no_open_dispute" });
  const held = await athlete({ open: true });
  delete process.env.LEAN_SIGNUP_RESEARCH;
  expect(await requestIdentityRecheck(held, "school", { kick })).toEqual({ started: false, reason: "off" });
  expect([...(await leanRuns(settled)), ...(await leanRuns(held))]).toEqual([]);
  expect(kick).not.toHaveBeenCalled();
});

test("I3: an open verdict ⇒ one identity-topic lean refresh through the runner, kicked", async () => {
  const id = await athlete({ open: true });
  expect(await hasOpenIdentityDispute(id)).toBe(true);
  const r = await requestIdentityRecheck(id, "account", { kick });
  expect(r).toMatchObject({ started: true });
  const runs = await leanRuns(id);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ created_by: IDENTITY_RECHECK_CREATED_BY, status: "running" });
  expect(runs[0].input).toMatchObject({ name: "Robin Sample", sport: "Rowing", topics: ["identity"], aims: [], evidence: "account" });
  expect(kick).toHaveBeenCalledWith((r as any).runId);
});

test("I4: at most once per 24 hours — recent within the window (across a key boundary), starts again after it", async () => {
  const id = await athlete({ open: true });
  const t0 = new Date();
  expect(await requestIdentityRecheck(id, "school", { now: t0, kick })).toMatchObject({ started: true });
  const [first] = await leanRuns(id);
  // A second piece of evidence while it runs: one at a time (the 24-hour read answers first).
  expect(await requestIdentityRecheck(id, "handle", { now: t0, kick })).toMatchObject({ started: false, reason: "recent" });
  await db.update(workflowRuns).set({ status: "done" }).where(eq(workflowRuns.id, first.id));
  // 23 hours on (another idempotency window): still within 24 hours of the last start.
  const later = new Date(t0.getTime() + 23 * HOUR);
  expect(recheckKey(id, later)).not.toBe(recheckKey(id, t0));
  const recent = await requestIdentityRecheck(id, "handle", { now: later, kick });
  expect(recent).toMatchObject({ started: false, reason: "recent" });
  expect(Date.parse((recent as any).nextAllowedAt)).toBe(first.started_at.getTime() + 24 * HOUR);
  // 25 hours on: a new re-check.
  expect(await requestIdentityRecheck(id, "handle", { now: new Date(t0.getTime() + 25 * HOUR), kick })).toMatchObject({ started: true });
  expect(await leanRuns(id)).toHaveLength(2);
});

test("I5: two instances at once ⇒ one run", async () => {
  const id = await athlete({ open: true });
  const now = new Date();
  const both = await Promise.all([
    requestIdentityRecheck(id, "school", { now, kick }),
    requestIdentityRecheck(id, "account", { now, kick }),
  ]);
  expect(both.filter((r) => r.started)).toHaveLength(1);
  expect(await leanRuns(id)).toHaveLength(1);

  // Two instances that BOTH passed the 24-hour read (it saw nothing): the idempotency key and the one-active-run index
  // still let only one start.
  const other = await athlete({ open: true });
  const key = recheckKey(other, now);
  const raced = await Promise.all([1, 2].map(() => requestLeanRefresh(other, ["identity"], { now, kick }, { identityRecheck: { idempotencyKey: key, evidence: "school" } })));
  expect(raced.filter((r) => r.started)).toHaveLength(1);
  expect(raced.find((r) => !r.started)).toMatchObject({ reason: "already_running" });
  expect(await leanRuns(other)).toHaveLength(1);
  // ...and with different keys (a window boundary between them), the one-active-run index alone.
  const third = await athlete({ open: true });
  const split = await Promise.all([0, 1].map((i) => requestLeanRefresh(third, ["identity"], { now, kick }, { identityRecheck: { idempotencyKey: `k-${third}-${i}`, evidence: "school" } })));
  expect(split.filter((r) => r.started)).toHaveLength(1);
  expect(await leanRuns(third)).toHaveLength(1);
});

test("I6: the account-deletion fence ⇒ deleting, nothing started", async () => {
  const id = await athlete({ open: true });
  await db.update(athletes).set({ deletion_requested_at: new Date() } as any).where(eq(athletes.id, id));
  expect(await requestIdentityRecheck(id, "account", { kick })).toEqual({ started: false, reason: "deleting" });
  expect(await leanRuns(id)).toEqual([]);
});

test("I7: the cost caps — the daily research cap (hard stop) and the refresh day cap", async () => {
  const id = await athlete({ open: true });
  // DAILY_RESEARCH_CAP_USD spent (the real read, dailyCap.ts: a footprint check counts for any athlete).
  process.env.DAILY_RESEARCH_CAP_USD = "1";
  await db.insert(agentRuns).values({ athlete_id: id, skill_id: FOOTPRINT_SKILL_ID, skill_version: "1", trigger: "event", provider: "openai", model: "m", effort: "low", status: "completed", cost_micro_usd: 1_000_000, started_at: new Date(), ended_at: new Date() } as any);
  expect(await requestIdentityRecheck(id, "school", { kick })).toMatchObject({ started: false, reason: "daily_budget" });
  // Its read failing ⇒ closed (the runner asks researchCapRefusal, which refuses on an unreadable budget).
  process.env.DAILY_RESEARCH_CAP_USD = "100";
  const spy = jest.spyOn(dailyCap, "researchCapRefusal").mockResolvedValueOnce({ reason: "cap_unreadable", nextAllowedAt: new Date(Date.now() + 300_000).toISOString() });
  expect(await requestIdentityRecheck(id, "school", { kick })).toMatchObject({ started: false, reason: "daily_budget" });
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
  expect(await leanRuns(id)).toEqual([]);
  await db.delete(agentRuns).where(eq(agentRuns.athlete_id, id));
  delete process.env.DAILY_RESEARCH_CAP_USD;
  // The research refresh day cap (AGENT_RESEARCH_REFRESH_DAY_CAP_USD): today's spend leaves no room for one run's cap.
  process.env.AGENT_RESEARCH_REFRESH_DAY_CAP_USD = "1"; process.env.AGENT_RESEARCH_REFRESH_RUN_CAP_USD = "1.5";
  expect(await requestIdentityRecheck(id, "school", { kick })).toMatchObject({ started: false, reason: "daily_budget" });
  process.env.AGENT_RESEARCH_REFRESH_DAY_CAP_USD = "10";
  await db.insert(agentRuns).values({ athlete_id: id, skill_id: "research/extract-all", skill_version: "1", trigger: "event", provider: "openai", model: "m", effort: "low", status: "completed", parent_ref: "research_refresh:x:lean_research", cost_micro_usd: 9_000_000, started_at: new Date(), ended_at: new Date() } as any);
  expect(await requestIdentityRecheck(id, "school", { kick })).toMatchObject({ started: false, reason: "daily_budget" });
  expect(await leanRuns(id)).toEqual([]);
  await db.delete(agentRuns).where(eq(agentRuns.athlete_id, id));
});

test("I9: a typed handle becomes her word (a said fact) for a held athlete, even while the re-check waits; newer supersedes older", async () => {
  const said = async (id: string) => (await db.select().from(memoryFacts).where(and(eq(memoryFacts.athlete_id, id), eq(memoryFacts.type, "said"))))
    .map((f) => ({ id: f.id, claim: f.claim, status: f.status, by: f.superseded_by }));
  const settled = await athlete();
  await requestIdentityRecheck(settled, "handle", { kick }, { typedHandles: { instagram: "@robin.rows" } });
  expect(await said(settled)).toEqual([]);   // nothing to re-check: nothing written
  const held = await athlete({ open: true });
  expect(await requestIdentityRecheck(held, "handle", { kick }, { typedHandles: { instagram: "@robin.rows", snapchat: "x" } })).toMatchObject({ started: true });
  expect(await said(held)).toEqual([expect.objectContaining({ claim: "Robin Sample's Instagram handle is @robin.rows.", status: "active", by: null })]);
  // The same words again: never twice.
  await requestIdentityRecheck(held, "handle", { now: new Date(Date.now() + 25 * HOUR), kick }, { typedHandles: { instagram: "robin.rows" } });
  expect(await said(held)).toHaveLength(1);
  // A different handle within the 24 hours: the re-check waits ("recent"), her word is still recorded, and it
  // supersedes her older one for Instagram (kept, linked), so research reads one handle per platform.
  expect(await requestIdentityRecheck(held, "handle", { kick }, { typedHandles: { instagram: "robin.rows.2" } })).toMatchObject({ started: false, reason: "recent" });
  const rows = await said(held);
  expect(rows).toHaveLength(2);
  const active = rows.filter((x) => x.status === "active");
  expect(active.map((x) => x.claim)).toEqual(["Robin Sample's Instagram handle is @robin.rows.2."]);
  expect(rows.find((x) => x.claim.endsWith("@robin.rows."))).toMatchObject({ status: "superseded", by: active[0].id });
});

test("I10: a failed or canceled re-check still counts toward the 24 hours", async () => {
  for (const status of ["failed", "canceled"] as const) {
    const id = await athlete({ open: true });
    const t0 = new Date();
    expect(await requestIdentityRecheck(id, "school", { now: t0, kick })).toMatchObject({ started: true });
    await db.update(workflowRuns).set({ status }).where(and(eq(workflowRuns.athlete_id, id), eq(workflowRuns.process, LEAN_REFRESH_PROCESS)));
    expect(await requestIdentityRecheck(id, "handle", { now: new Date(t0.getTime() + HOUR), kick })).toMatchObject({ started: false, reason: "recent" });
    expect(await requestIdentityRecheck(id, "handle", { now: new Date(t0.getTime() + 25 * HOUR), kick })).toMatchObject({ started: true });
  }
});

test("I8: the routine refresh skips an open identity at every door; the identity topic still runs", async () => {
  process.env.AGENT_RESEARCH_REFRESH = "true";
  const held = await athlete({ open: true });
  const settled = await athlete();
  const started: string[] = [];
  const start: RefreshStarter = async (o) => { started.push(o.athleteId); return { runId: `run-${started.length}`, created: true }; };

  // A scheduled start waits; an operator's / script's deliberate run (trigger manual) still starts.
  expect(await requestResearchRefresh(held, { trigger: "schedule", reason: "stale", kick: false }, { start })).toEqual({ started: false, reason: "identity_open" });
  expect(await requestResearchRefresh(held, { trigger: "manual", reason: "operator", kick: false }, { start })).toMatchObject({ started: true });
  expect(await requestResearchRefresh(settled, { trigger: "schedule", reason: "stale", kick: false }, { start })).toMatchObject({ started: true });

  // The admin door (manual) starts it.
  const app = express(); app.use(express.json()); app.use(researchRefreshAdminRouter);
  const server: Server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/agent/research-refresh/${held}`, { method: "POST" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ started: true });
  } finally { await new Promise<void>((r) => server.close(() => r())); }

  // The daily sweep: never a candidate.
  const ids = (await refreshCandidates(5000)).map((c) => c.athleteId);
  expect(ids).toContain(settled);
  expect(ids).not.toContain(held);
  process.env.AGENT_RESEARCH_REFRESH_COHORT = "true";
  started.length = 0;
  await sweepResearchRefresh({ start, limit: 100, scan: 5000 });
  expect(started).not.toContain(held);

  // refresh_research: refused for any topic but identity (an actionable refusal), started for identity.
  const [tool] = researchTools({ kick });
  const ctx = { athleteId: held, runId: "chat-run", skillId: "chat" } as any;
  for (const topics of [undefined, ["all"], ["partners"], ["identity", "partners"]]) {
    const r: any = await tool.execute!(ctx, topics ? { topics } : {});
    expect(r.status).toBe("error");
    expect(r.reason).toMatch(/"refused":"identity_open".*topics \["identity"\]/);
  }
  expect(await leanRuns(held)).toEqual([]);
  expect(await tool.execute!(ctx, { topics: ["identity"] })).toMatchObject({ status: "ok", started: true, topics: ["identity"] });
  expect(await leanRuns(held)).toHaveLength(1);
  // An athlete with no open identity: every topic as before.
  expect(await tool.execute!({ ...ctx, athleteId: settled }, { topics: ["partners"] })).toMatchObject({ status: "ok", started: true });
});

test("I11: her sign-up research or agent onboarding still running ⇒ research_running (it records its own verdict)", async () => {
  for (const process of ["signup_research", "agent_onboarding"]) {
    const id = await athlete({ open: true });
    await db.insert(workflowRuns).values({ athlete_id: id, process, definition_version: 1, active_scope: process, status: "running", input: {}, created_by: "test", started_at: new Date() } as any);
    expect(await requestIdentityRecheck(id, "school", { kick })).toEqual({ started: false, reason: "research_running" });
    expect(await leanRuns(id)).toEqual([]);
  }
});
