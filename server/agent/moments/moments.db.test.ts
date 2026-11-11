/**
 * moments.db.test.ts — the weekly moments scan on PGlite: the moments_scan workflow on the real Postgres runner, the
 * dbStore's in-place refresh, the deals source, the daily sweep and its cron route. The model is faked (no provider is
 * reached); AGENT_MOMENTS is turned on per test where a test needs it.
 *
 *   D1 dbStore.refreshFact: same id, the claim, source, date and run replaced, the old URL kept as also-seen; never
 *      another athlete's fact, never a superseded one
 *   D2 the deals source: the athlete's live, signed and recently ended deals with the brand's category — never another
 *      athlete's, never a long-dead one, never an amount
 *   D3 requestMomentsScan only ENQUEUES moments_scan (kick false, key moments:<athlete>:<day>); the tick runs the scan; moments and candidate posts land in
 *      memory_facts / memory_decisions; the agent run is skill moments with the workflow's parent ref
 *   D4 the sweep: athletes with a current Brief and no scan in 7 days get one; a recent scan is skipped; off → nothing
 *   D5 POST /api/internal/moments-scan-cron: the secret; off → enabled:false and nothing started; a failure is a 500
 *   D6 onboarding v2: the first moments scan as a workflow step before Understand (no Brief needed), counted in the
 *      onboarding's cost, off without the flag, a failure recorded never thrown; v1 runs keep v1
 *   D1b confirmedFactIds: the latest review per fact decides
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { deals, inboxBrands, memoryDecisions } from "../../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { fakeResponses, skillOf, type FakeTransport } from "../../testUtils/agentModel";
import { getDefinition } from "../../workflow/registry";
import { getRun, tick } from "../../workflow/runner";
import { setResponsesTransport } from "../research/llm";
import { dbStore } from "../research/dbStore";
import { momentsCronRouter } from "./routes";
import { dbMomentsSources } from "./sources";
import { requestMomentsScan, sweepMomentsScan, type MomentsRunStarter } from "./triggers";
import "./workflow";

let A = "";
let B = "";
let C = "";
let transport: FakeTransport;
const saved = process.env.AGENT_MOMENTS;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const brief = (id: string) => dbStore.writeBrief(id, { summary: "S", sections: [], factIds: [], internal: { currentSponsors: [], pastSponsors: [] }, runId: null });

beforeAll(async () => {
  await initTestDb();
  A = await seedAthlete("Pat Example");
  B = await seedAthlete("Rival Private");
  C = await seedAthlete("No Brief Yet");
  await dbStore.insertFacts(A, [
    { subject: { kind: "athlete", name: "Pat Example" }, claim: "The athlete's name is Pat Example.", type: "said", source: { ref: "onboarding/wf#name" }, date: day(0), confidence: 1, runId: null },
    { subject: { kind: "event", name: "Home opener" }, claim: "The home opener is coming up.", type: "found", source: { url: "https://example.org/schedule" }, date: day(8), confidence: 0.8, runId: null, topic: "moment" },
  ]);
  await brief(A);
  await brief(B);
  transport = fakeResponses((body) => {
    if (skillOf(body) !== "moments") throw new Error(`unexpected skill ${skillOf(body)}`);
    const input = String(body.input);
    const m1 = /^(M\d+) \|[^\n]*Home opener/m.exec(input)?.[1] ?? null;
    return {
      sources: [{ url: "https://example.org/opener-news", title: "News" }, { url: "https://example.org/awareness", title: "Awareness" }], queries: ["q"],
      json: {
        moments: [
          { name: "Home opener", description: "The home opener draws a sell-out crowd.", date: day(8), date_precision: "day", category: "schedule", why_now: "The first home game.", source_url: "https://example.org/opener-news", source_title: "News", confidence: 0.9, based_on: [], refreshes: m1,
            idea: { hook: "Home again.", angle: "Home." } },
          { name: "Awareness week", description: "An awareness week starts soon.", date: day(12), date_precision: "day", category: "holiday_awareness", why_now: "Fits the club's work.", source_url: "https://example.org/awareness", source_title: "Awareness", confidence: 0.8, based_on: [], refreshes: null,
            idea: { hook: "Look after each other.", angle: "Care." } },
        ],
        retire: [], path_note: "p",
      },
    };
  });
  setResponsesTransport(transport);
}, 120_000);

afterAll(async () => {
  setResponsesTransport(null);
  if (saved === undefined) delete process.env.AGENT_MOMENTS; else process.env.AGENT_MOMENTS = saved;
  await closeTestDb();
});

test("D1: refreshFact keeps the id, replaces claim / source / date / run, keeps the old URL; scoped and active only", async () => {
  const [f] = await dbStore.insertFacts(A, [{ subject: { kind: "event", name: "Regatta" }, claim: "The regatta is in November.", type: "found", source: { url: "https://example.org/regatta", title: "Old" }, date: "2026-11-01", datePrecision: "month", confidence: 0.6, runId: null, topic: "moment" }]);
  expect(await dbStore.refreshFact(B, f.id, { claim: "taken", source: { url: "https://example.org/x" }, date: null, confidence: 1, runId: null })).toBeNull();
  const r = await dbStore.refreshFact(A, f.id, { claim: "The regatta is on 14 November 2026 ([news](https://example.org/n)).", source: { url: "https://example.org/regatta-2026?utm_source=openai", title: "New" }, sourceType: null, date: "2026-11-14", datePrecision: "day", confidence: 0.9, runId: null });
  expect(r).toMatchObject({ id: f.id, claim: "The regatta is on 14 November 2026.", source: { url: "https://example.org/regatta-2026", title: "New" }, date: "2026-11-14", datePrecision: "day", confidence: 0.9, alsoSeenAt: [{ url: "https://example.org/regatta", title: "Old" }], topic: "moment", status: "active" });
  await dbStore.setFactStatus(A, f.id, "superseded");
  expect(await dbStore.refreshFact(A, f.id, { claim: "again", source: { url: "https://example.org/x" }, date: null, confidence: 1, runId: null })).toBeNull();
  // A junk new URL never loses the source: the previous page (now also-seen) stands in for it, as on insert.
  const [e] = await dbStore.insertFacts(A, [{ subject: { kind: "event", name: "E" }, claim: "E.", type: "found", source: { url: "https://example.org/e" }, date: null, confidence: 0.5, runId: null }]);
  expect(await dbStore.refreshFact(A, e.id, { claim: "E again.", source: { url: "javascript:alert(1)" }, date: null, confidence: 0.5, runId: null })).toMatchObject({ source: { url: "https://example.org/e" }, alsoSeenAt: [] });
  // No source left at all is refused, and the row is unchanged.
  const [g] = await dbStore.insertFacts(A, [{ subject: { kind: "event", name: "G" }, claim: "G.", type: "found", source: { ref: "deals/x" }, date: null, confidence: 0.5, runId: null }]);
  await expect(dbStore.refreshFact(A, g.id, { claim: "G again.", source: {}, date: null, confidence: 0.5, runId: null })).rejects.toThrow(/source_required/);
  expect((await dbStore.getFacts(A, [g.id]))[0]).toMatchObject({ claim: "G.", source: { ref: "deals/x" } });
});

test("D2: the deals source — live, signed and recently ended deals with the brand's category; nothing of another athlete", async () => {
  const [brand] = await db.insert(inboxBrands).values({ name: "Acme Hydration", category: "beverage" } as any).returning({ id: inboxBrands.id });
  await db.insert(deals).values([
    { athlete_id: A, brand_name: "Acme Hydration", brand_id: brand.id, status: "accepted", term_start: day(-10), term_end: day(60), amount: "5000" },
    { athlete_id: A, brand_name: "Signed Co", status: "completed", signed_at: new Date(), signed_source: "confirmed" },
    { athlete_id: A, brand_name: "Recently Ended", status: "completed", term_end: day(-30) },
    { athlete_id: A, brand_name: "Long Dead", status: "rejected", term_end: day(-200) },
    { athlete_id: A, brand_name: "Just Detected", status: "detected" },
    { athlete_id: B, brand_name: "Rival Private Deal", status: "accepted" },
  ] as any);
  const got = await dbMomentsSources.deals(A, day(0));
  expect(got.map((d) => d.brand).sort()).toEqual(["Acme Hydration", "Recently Ended", "Signed Co"]);
  expect(got.find((d) => d.brand === "Acme Hydration")).toMatchObject({ category: "beverage", status: "accepted", termStart: day(-10), termEnd: day(60), signed: false });
  expect(got.find((d) => d.brand === "Signed Co")!.signed).toBe(true);
  expect(JSON.stringify(got)).not.toMatch(/5000|amount/);
});

test("D3: a request only enqueues moments_scan; the workflow tick runs the scan and writes the store", async () => {
  process.env.AGENT_MOMENTS = "true";
  const r = await requestMomentsScan(A, { reason: "weekly moments scan" });
  expect(r).toMatchObject({ started: true, joined: false });
  // Enqueued, not run: no model call yet, the scan step waits for the tick.
  let wf = (await getRun((r as any).runId))!;
  expect([wf.run.status, wf.run.idempotency_key]).toEqual(["running", `moments:${A}:${new Date().toISOString().slice(0, 10)}`]);
  expect(wf.steps.map((s) => [s.step, s.status])).toEqual([["scan", "ready"]]);
  expect(transport.calls).toHaveLength(0);
  // The same request again today joins the same run.
  expect(await requestMomentsScan(A, { reason: "weekly moments scan" })).toMatchObject({ started: true, runId: (r as any).runId, joined: true });
  await tick();
  wf = (await getRun((r as any).runId))!;
  expect(wf.run.status).toBe("done");
  expect(wf.steps.map((s) => [s.step, s.status])).toEqual([["scan", "done"]]);
  expect(wf.steps[0].output).toMatchObject({ status: "scanned", written: 1, refreshed: 1, held: 0 });
  expect(transport.calls.map(skillOf)).toEqual(["moments"]);

  const facts = await dbStore.listFacts(A, ["active"]);
  const opener = facts.filter((f) => f.subject.name === "Home opener");
  expect(opener).toHaveLength(1);                                                    // refreshed, never duplicated
  expect(opener[0]).toMatchObject({ claim: "The home opener draws a sell-out crowd.", source: { url: "https://example.org/opener-news" }, alsoSeenAt: [{ url: "https://example.org/schedule" }] });
  const week = facts.find((f) => f.subject.name === "Awareness week")!;
  expect(week).toMatchObject({ subject: { kind: "event" }, topic: "moment", type: "found", date: day(12), datePrecision: "day" });
  const rows = await db.select().from(memoryDecisions).where(eq(memoryDecisions.athlete_id, A));
  // The idea bank's entries (detail.kind "idea") are filed beside the moments; this checks the moments.
  const candidates = rows.filter((d) => d.skill_id === "moments" && (d.detail as any)?.kind !== "idea");
  expect(candidates.map((d) => [d.kind, d.response, (d.detail as any).kind, (d.detail as any).name, (d.detail as any).rank])).toEqual([
    ["other", "pending", "moment", "Home opener", 1], ["other", "pending", "moment", "Awareness week", 2],
  ]);
  const run = (await dbStore.listRunsSince(A, { since: new Date(Date.now() - 60_000).toISOString(), skillId: "moments" }))[0];
  expect(run).toMatchObject({ skillVersion: "1.2.0", trigger: "schedule", status: "completed", parentRef: `workflow:${(r as any).runId}:scan`, model: { provider: "openai", model: "gpt-6-luna" } });
  expect(run.cost.webSearchCalls).toBe(1);
  // Nothing of A's reached anyone else.
  expect(await dbStore.listFacts(B)).toEqual([]);
}, 60_000);

test("D4: the sweep — a scan for each athlete with a Brief and none in 7 days; a recent one is skipped; off starts nothing", async () => {
  const started: string[] = [];
  const start: MomentsRunStarter = async (o) => {
    expect([o.kick, o.idempotencyKey]).toEqual([false, `moments:${o.athleteId}:${new Date().toISOString().slice(0, 10)}`]);
    started.push(o.athleteId);
    return { runId: `wf-${started.length}`, created: true };
  };
  process.env.AGENT_MOMENTS = "false";
  expect(await sweepMomentsScan({ start })).toEqual({ checked: 0, started: 0, skipped: {} });
  process.env.AGENT_MOMENTS = "true";
  const out = await sweepMomentsScan({ start });
  expect(out).toEqual({ checked: 2, started: 1, skipped: { recent: 1 } });        // A scanned in D3; C has no Brief
  expect(started).toEqual([B]);
});

test("D5: the cron route — the secret, the flag, a failure", async () => {
  const app = express();
  app.use(express.json());
  const calls: number[] = [];
  app.use(momentsCronRouter((req) => req.headers["x-cron-secret"] === "s3cret", async () => { calls.push(1); return { checked: 2, started: 1, skipped: { recent: 1 } }; }));
  const broken = express();
  broken.use(momentsCronRouter(() => true, async () => { throw new Error("db down"); }));
  const servers: Server[] = [app.listen(0), broken.listen(0)];
  const url = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/internal/moments-scan-cron`;
  try {
    expect((await fetch(url(servers[0]), { method: "POST" })).status).toBe(401);
    expect((await fetch(url(servers[0]), { method: "POST", headers: { "x-cron-secret": "wrong" } })).status).toBe(401);
    expect(calls).toEqual([]);
    process.env.AGENT_MOMENTS = "true";
    const on = await fetch(url(servers[0]), { method: "POST", headers: { "x-cron-secret": "s3cret" } });
    expect(await on.json()).toEqual({ ok: true, enabled: true, checked: 2, started: 1, skipped: { recent: 1 } });
    const failed = await fetch(url(servers[1]), { method: "POST" });
    expect([failed.status, await failed.json()]).toEqual([500, { error: "Internal server error" }]);
    // Off: the real sweep answers enabled:false and starts nothing.
    process.env.AGENT_MOMENTS = "false";
    const real = express();
    real.use(momentsCronRouter(() => true));
    servers.push(real.listen(0));
    expect(await (await fetch(url(servers[2]), { method: "POST" })).json()).toEqual({ ok: true, enabled: false, checked: 0, started: 0, skipped: {} });
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
  }
});

test("D6: onboarding v2 runs the first moments scan between the reveal and Understand — before any Brief, inside the onboarding's cap, best-effort", async () => {
  const { MOMENTS_STEP } = await import("../onboarding/workflow");
  expect(getDefinition("agent_onboarding", 2).steps.map((s) => s.name)).toEqual(["research_a", "research_b", "research_merge", "opening", "moments", "understand", "mia_preview", "insights", "conversation", "finish"]);
  expect(getDefinition("agent_onboarding", 1).steps.map((s) => s.name)).not.toContain("moments");   // runs on v1 keep v1
  // v3: the M.I.A. preview runs beside the reveal, right after the merge; moments still before Understand. v4 (the
  // default) has the same shape; its research steps reuse a fresh sign-up research (onboardingV4.test.ts).
  for (const v of [getDefinition("agent_onboarding", 3), getDefinition("agent_onboarding")]) {
    expect(v.steps.map((s) => `${s.ordinal}:${s.name}`)).toEqual([
      "0:research_a", "0:research_b", "1:research_merge", "2:opening", "2:mia_preview", "3:moments", "4:understand", "5:insights", "6:conversation", "7:finish",
    ]);
  }
  expect(getDefinition("agent_onboarding").version).toBe(4);
  const E = await seedAthlete("New Athlete");
  const ctx = (runId: string) => ({ runId, athleteId: E, runInput: { name: "New Athlete", sport: "rowing" }, outputs: {}, attempt: 1 }) as any;
  process.env.AGENT_MOMENTS = "false";
  expect(await MOMENTS_STEP.run!(ctx("wf-onb-off"))).toEqual({ status: "off" });
  process.env.AGENT_MOMENTS = "true";
  expect(await dbStore.currentBrief(E)).toBeNull();
  const out = await MOMENTS_STEP.run!(ctx("wf-onb"));
  expect(out).toMatchObject({ status: "scanned", written: 2 });
  const run = (await dbStore.listRunsByPrefix(E, "workflow:wf-onb:moments"))[0];
  expect(run).toMatchObject({ skillId: "moments", trigger: "event", status: "completed" });
  expect((await dbStore.costByParentPrefix(E, "workflow:wf-onb")).microUsd).toBe(run.cost.microUsd);   // counts toward the onboarding
  // A failure is recorded on the step and never fails the onboarding.
  setResponsesTransport(fakeResponses(() => { throw new Error("provider down"); }));
  try {
    expect(await MOMENTS_STEP.run!(ctx("wf-onb-2"))).toMatchObject({ status: "failed" });
  } finally {
    setResponsesTransport(transport);
  }
}, 60_000);

test("D1b: confirmedFactIds — facts whose latest review is a confirm; a later dispute or removal ends it; scoped", async () => {
  const [a, b, c] = await dbStore.insertFacts(A, ["one", "two", "three"].map((x) => ({ subject: { kind: "event" as const, name: x }, claim: `${x}.`, type: "found" as const, source: { url: `https://example.org/${x}` }, date: null, confidence: 0.5, runId: null })));
  const review = (factId: string, action: "confirm" | "dispute") => dbStore.insertReview(A, { factId, action, correction: null, replacementFactId: null, note: null });
  await review(a.id, "confirm");
  await review(b.id, "confirm");
  await new Promise((r) => setTimeout(r, 5));
  await review(b.id, "dispute");
  const ids = await dbStore.confirmedFactIds(A);
  expect(ids.has(a.id)).toBe(true);
  expect(ids.has(b.id)).toBe(false);
  expect(ids.has(c.id)).toBe(false);
  expect((await dbStore.confirmedFactIds(B)).size).toBe(0);
});
