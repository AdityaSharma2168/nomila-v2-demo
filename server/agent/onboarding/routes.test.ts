/**
 * routes.test.ts — the onboarding API end to end on Express + PGlite, with the model mocked (no provider is reached).
 *
 *   A1 start → research (two passes) → merge → understand → opening turn run in the background; the run parks on the
 *      conversation; the state shows the reveal; facts carry sources and their run; the brief carries sources per line
 *   A2 the conversation finishes when every REQUIRED checkpoint is met (taps only; no goal needed), the workflow runs
 *      `finish`, cost is summed
 *   A3 resumable: start again returns the same run; state is readable at any point
 *   A4 tenancy: another athlete sees nothing of this onboarding — no state, facts, runs, "how I got this" or fact taps
 *   A5 privacy: another athlete's private data (measured numbers, rates, internal scores, deals, goals) never reaches
 *      this athlete's model inputs or API outputs
 *   A6 validation: name and sport are required; the internal read is never returned
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { closeTestDb, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { FIXTURES, fakeResponses, passAnswer, skillOf, type FakeTransport } from "../../testUtils/agentModel";
import { setResponsesTransport } from "../research/llm";
import { dbStore } from "../research/dbStore";
import { getRun } from "../../workflow/runner";
import { CONSENT_ID } from "./catalog";
import { agentOnboardingRouter } from "./routes";

let server: Server;
let base = "";
let athleteA = "";
let athleteB = "";
let transport: FakeTransport;
const f = FIXTURES.college;

const B_PRIVATE = ["987,654", "31415", "SECRET-DEAL-TERMS", "secret goal of B", "Rival Private"];
/** A dated moment research Pass B finds (research 1.11.0: an event fact, topic "moment"). */
const SEASON = {
  subject_kind: "event", subject_name: "Season opener", claim: "The college swim season opens in October.", topic: "moment",
  source_url: "https://example-swim-calendar.org/2026", source_title: "Calendar", source_type: "official", date: "2026-10", confidence: 0.9,
  sensitivity: "none", care_kind: "none", never_reason: "none",
};

function model(): FakeTransport {
  return fakeResponses((body) => {
    const skill = skillOf(body);
    // Research 1.11.0 seeds the moments store: Pass B files the season opener as a dated event fact (topic "moment").
    if (skill === "research") {
      const a = passAnswer(f, { extra: [SEASON] });
      return { ...a, sources: [...a.sources!, { url: SEASON.source_url, title: SEASON.source_title }] };
    }
    if (skill === "research/merge") {
      return { json: { facts: [
        ...f.pages.map((p, i) => ({ from: [`a${i + 1}`, `b${i + 1}`], subject_kind: "athlete", subject_name: f.name, claim: p.claim, topic: p.topic, date: p.date, confidence: 0.9, sensitive: false, conflicts_with: "", duplicate_of: "", note: "" })),
        { from: [`a${f.pages.length + 1}`], subject_kind: "event", subject_name: SEASON.subject_name, claim: SEASON.claim, topic: "moment", date: SEASON.date, confidence: 0.9, sensitive: false, conflicts_with: "", duplicate_of: "", note: "" },
      ], dropped: [], narrative: "Merged." } };
    }
    if (skill === "understand") {
      // Understand 1.11.0 does not search: the timing cites the moment research seeded (its f-key from the input).
      const season = /^(f\d+) \|[^\n]*The college swim season opens in October/m.exec(String(body.input))![1];
      return {
        json: {
          stage: { label: "College junior", band: "developing", confidence: 0.8, why: "Roster and results.", refs: ["f3"] },
          thesis: { big_idea: "A champion with a story.", verdict: "Marketable regionally." },
          sections: [{ key: "brand_now_next", title: "Brand", lines: [{ text: "Conference champion in 2026.", kind: "fact", refs: ["f4"] }], so_what: "Lead with results." },
                     { key: "context_timing", title: "Timing", lines: [{ text: "The season opens soon.", kind: "fact", refs: [season] }], so_what: "Plan for it." }],
          positioning: { from: "a", to: "b", statement: "Results first, story close behind.", pillars: [], refs: [] },
          content_pillars: [{ key: "P1", name: "Race days", why_this_athlete: "A conference title on record.", refs: ["f4"] }],
          internal: { current_sponsors: [], past_sponsors: [{ name: "INTERNAL-PAST-SPONSOR", refs: [] }] },
          narrative: "A champion with a story; marketable regionally.",
        },
      };
    }
    // onboarding turns. The opening turn's insight rests on a key no fact has (code drops it); the insights turn's on the
    // season moment research seeded.
    const input = String(body.input);
    const insightRef = /The Brief is ready/.test(input) ? (/^(f\d+) \|[^\n]*The college swim season opens in October/m.exec(input)?.[1] ?? "f99") : "f99";
    return { json: {
      message: "Here's what I found.",
      cards: {
        reveal: { headline: `${f.name}, at a glance`, highlights: [{ text: "Conference champion.", refs: ["f4"] }] },
        insights: [{ angle: "timing", text: "Season opens soon.", refs: [insightRef] }],
        fact_review: { refs: [] },
        // Goals come from the plan step (off here: AGENT_PLAN unset), so there is nothing to show — and nothing waits for it.
        show_recommended_goals: true,
        connect: [{ connector_id: "instagram", why: "Measure your real audience." }, { connector_id: "tiktok", why: "x" }, { connector_id: "youtube", why: "x" }, { connector_id: "gmail", why: "x" }, { connector_id: "outlook", why: "x" }],
        capabilities: [{ capability_id: "deals", pitch: "Deals." }],
        consent: true, age_band: false, order: [],
      },
      checkpoints_addressed: [], path_note: "reveal first",
    } };
  });
}

async function call(as: string, method: string, path: string, body?: unknown) {
  (globalThis as any).__TEST_ATHLETE_ID = as;
  const res = await fetch(`${base}/api/v1/me${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

async function waitFor(as: string, pred: (s: any) => boolean, ms = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const s = await call(as, "GET", "/agent/onboarding");
    if (pred(s.body)) return s.body;
    if (Date.now() - t0 > ms) throw new Error(`timeout; last state ${s.text.slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  await initTestDb();
  athleteA = await seedAthlete(f.name);
  athleteB = await seedAthlete("Rival Private");
  // Athlete B's private data — none of it may ever reach athlete A.
  await dbStore.insertFacts(athleteB, [
    { subject: { kind: "athlete", name: "Rival Private" }, claim: "Rival Private has 987,654 followers.", type: "measured", source: { ref: "social_analytics_snapshots/x#instagram.followers" }, date: "2026-10-01", confidence: 1, runId: null },
    { subject: { kind: "athlete", name: "Rival Private" }, claim: "Rival Private charges 31415 per post.", type: "said", source: { ref: "onboarding/x#rates" }, date: "2026-10-01", confidence: 1, runId: null },
  ]);
  await dbStore.writeBrief(athleteB, { summary: "B", sections: [], factIds: [], runId: null, internal: { currentSponsors: [{ name: "SECRET-DEAL-TERMS", factIds: [] }], pastSponsors: [{ name: "31415", factIds: [] }] } });
  await dbStore.insertGoal(athleteB, { text: "secret goal of B", source: "said", decisionId: null });
  await dbStore.insertDecision(athleteB, { runId: null, skillId: "deals", suggested: "Counter SECRET-DEAL-TERMS", why: "31415", evidence: [] });

  transport = model();
  setResponsesTransport(transport);
  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", agentOnboardingRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  setResponsesTransport(null);
  await new Promise((r) => server.close(r));
  await closeTestDb();
});

let runId = "";

test("A6: name and sport are required", async () => {
  expect((await call(athleteA, "POST", "/agent/onboarding/start", { name: f.name })).status).toBe(400);
  // athleteA is seeded plain (agent_onboarding_required defaults false, an "existing athlete"): no run yet, and not required.
  expect((await call(athleteA, "GET", "/agent/onboarding")).body).toEqual({ started: false, required: false });
});

test("A7: existing vs new athletes with no run yet (fix/existing-users-skip-onboarding)", async () => {
  // Existing: agent_onboarding_required defaults false — a fresh read is "not required" with no run, so the client
  // reads this as done and opens straight into the app. Never starts a run: no background research here.
  const existingAthlete = await seedAthlete("Existing Athlete");
  expect((await call(existingAthlete, "GET", "/agent/onboarding")).body).toEqual({ started: false, required: false });

  // New: created through the agent front (or opted in) — agent_onboarding_required true, no run yet ⇒ required true,
  // so the client draws the name + sport screen.
  const newAthlete = await seedAthlete("New Front Athlete", { agent_onboarding_required: true });
  expect((await call(newAthlete, "GET", "/agent/onboarding")).body).toEqual({ started: false, required: true });
});

test("A1: start → background research → the conversation opens with the reveal", async () => {
  const s = await call(athleteA, "POST", "/agent/onboarding/start", { name: f.name, sport: f.sport });
  expect(s.status).toBe(202);
  runId = s.body.runId;
  // Resumable: starting again joins the same run (A3).
  const again = await call(athleteA, "POST", "/agent/onboarding/start", { name: f.name, sport: f.sport });
  expect(again).toMatchObject({ status: 200, body: { runId, created: false } });

  const state = await waitFor(athleteA, (b) => b.waitingOn === "conversation");
  expect(state.progress).toBeNull();
  expect(state.briefPending).toBe(false);
  expect(state.passes.map((p: any) => p.status)).toEqual(["done", "done"]);
  // Live research events: the sources each pass read and what it found, with their sources.
  expect(state.events.filter((e: any) => e.kind === "reading").length).toBeGreaterThan(0);
  expect(state.events.filter((e: any) => e.kind === "discovery").map((e: any) => e.text)).toEqual(expect.arrayContaining(f.pages.map((p) => p.claim)));
  expect(state.events.filter((e: any) => e.kind === "pass_done").map((e: any) => e.pass).sort()).toEqual(["a", "b"]);
  // Turn 0 is the reveal, straight after the merge; the insights arrive in their own turn once the Brief is written.
  expect(state.turns).toHaveLength(2);
  const kinds = state.turns[0].cards.map((c: any) => c.kind);
  expect(kinds[0]).toBe("reveal");
  expect(kinds).toEqual(expect.arrayContaining(["fact-review", "connect", "capability", "consent"]));
  expect(kinds).not.toContain("goal-proposal");                                   // the turn never writes a goal itself
  expect(kinds).not.toContain("insight");                                         // it rests on no fact the athlete has
  const later = state.turns[1].cards.map((c: any) => c.kind);
  expect(later).toContain("insight");
  expect(later).not.toEqual(expect.arrayContaining(["fact-review"]));             // a system turn does not repeat what is on screen
  expect(later).not.toContain("goal-proposal");
  expect(later).not.toContain("consent");
  expect(state.checkpoints).toMatchObject({ name_sport: "done", reveal: "done", facts_review: "done", connect_offers: "done", capabilities: "done", consent: "offered" });
  // A7: already started — `started: true`, and `required` (the no-run-yet field) plays no part once a run exists.
  expect(state.started).toBe(true);
  expect(state).not.toHaveProperty("required");

  // Two passes in parallel, the merge, the reveal turn, then Understand and the insights turn — six model calls, no more.
  expect(transport.calls.map(skillOf)).toEqual(["research", "research", "research/merge", "onboarding", "understand", "onboarding"]);

  const facts = (await call(athleteA, "GET", "/agent/onboarding/facts")).body.facts;
  const found = facts.filter((x: any) => x.type === "found");
  expect(found.length).toBe(f.pages.length + 1);                                   // + the season moment research seeded
  for (const x of found) { expect(x.sources[0].url).toMatch(/^https:\/\//); expect(x.runId).toBeTruthy(); }
  expect(facts.filter((x: any) => x.type === "said").map((x: any) => x.claim)).toEqual([`The athlete's name is ${f.name}.`, `${f.name}'s sport is ${f.sport}.`]);
  // 0115: research and merge store each fact's topic and its source's outlet type; research 1.11.0 files a dated
  // moment as an event fact under "moment" (the one moments store), and Understand writes no fact of its own.
  const merged = found.filter((x: any) => x.claim !== "The college swim season opens in October.");
  expect(merged.map((x: any) => [x.topic, x.sourceType])).toEqual(f.pages.map((p) => [p.topic, "official"]));
  // The subject filter: the season moment (about an event) is about others, never the athlete's own record.
  const season = facts.find((x: any) => x.claim === "The college swim season opens in October.");
  expect(season).toMatchObject({ about: "others", topic: "moment" });
  expect(found.filter((x: any) => x.runId === season.runId).length).toBe(f.pages.length + 1);   // all from the merge run
  const own = (await call(athleteA, "GET", "/agent/onboarding/facts?subject=athlete")).body.facts;
  const others = (await call(athleteA, "GET", "/agent/onboarding/facts?subject=others")).body.facts;
  expect(own.every((x: any) => x.about === "athlete")).toBe(true);
  expect(own.map((x: any) => x.id)).not.toContain(season.id);
  expect(others.map((x: any) => x.id)).toEqual([season.id]);
  expect(own.length + others.length).toBe(facts.length);
  expect((await call(athleteA, "GET", "/agent/onboarding/facts?subject=everyone")).status).toBe(400);

  const brief = (await call(athleteA, "GET", "/agent/onboarding/brief"));
  const bnn = brief.body.brief.sections.find((s: any) => s.key === "brand_now_next");
  expect(bnn.lines[0].sources[0].url).toBe(f.pages[1].url);
  expect(brief.text).not.toMatch(/INTERNAL-PAST-SPONSOR|criteria|pastSponsors/);   // A6: the internal read never leaves
  // The stage and positioning as Understand returned them, for the Scouting report hero.
  expect(brief.body.brief.display).toMatchObject({
    stage: { label: "College junior", band: "developing", confidence: 0.8, why: "Roster and results." },
    positioning: { statement: "Results first, story close behind." },
  });

  const how = await call(athleteA, "GET", `/agent/how/runs/${found[0].runId}`);
  expect(how.status).toBe(200);
  expect(how.body.card.skillId).toBe("research/merge");
  const passRun = (await dbStore.listRunsByPrefix(athleteA, `workflow:${runId}:research_a`))[0];
  const howPass = await call(athleteA, "GET", `/agent/how/runs/${passRun.id}`);
  expect(howPass.body.trace.searches[0].sources.map((x: any) => x.url)).toContain(f.pages[0].url);
  const howFact = await call(athleteA, "GET", `/agent/how/facts/${found[0].id}`);
  expect(howFact.body.fact.sources[0].url).toBe(found[0].sources[0].url);
}, 60_000);

test("A4: tenancy — another athlete sees nothing of this onboarding", async () => {
  expect((await call(athleteB, "GET", "/agent/onboarding")).body).toEqual({ started: false, required: false });
  expect((await call(athleteB, "POST", "/agent/onboarding/turn", { message: "hi" })).status).toBe(404);
  const aFacts = (await call(athleteA, "GET", "/agent/onboarding/facts")).body.facts;
  const bFacts = (await call(athleteB, "GET", "/agent/onboarding/facts")).body.facts;
  expect(bFacts.some((x: any) => aFacts.some((y: any) => y.id === x.id))).toBe(false);
  expect((await call(athleteB, "GET", `/agent/how/runs/${aFacts.find((x: any) => x.runId).runId}`)).status).toBe(404);
  expect((await call(athleteB, "GET", `/agent/how/facts/${aFacts[0].id}`)).status).toBe(404);
  expect((await call(athleteB, "GET", "/agent/onboarding/brief")).body.brief.summary).toBe("B");
});

test("A2: taps finish the checkpoints — no goal needed; the workflow finishes and sums its cost", async () => {
  const facts = (await call(athleteA, "GET", "/agent/onboarding/facts")).body.facts;
  // A fact of athlete B's cannot be touched through A's session.
  const bFact = (await dbStore.listFacts(athleteB))[0];
  const r = await call(athleteA, "POST", "/agent/onboarding/turn", { reply: false, actions: [
    { type: "consent", consentId: CONSENT_ID, response: "agree" },
    { type: "fact_review", factId: facts.find((x: any) => x.type === "found").id, action: "confirm" },
    { type: "fact_review", factId: bFact.id, action: "remove" },
  ] });
  expect(r.status).toBe(200);
  expect(r.body.done).toBe(true);
  expect(r.body.problems).toEqual([`fact ${bFact.id} not found`]);
  expect((await dbStore.getFacts(athleteB, [bFact.id]))[0].status).toBe("active");

  const run = await getRun(runId);
  expect(run!.run.status).toBe("done");
  const finish = run!.steps.find((s) => s.step === "finish")!.output as any;
  expect(finish.cost_micro_usd).toBeGreaterThan(0);
  expect(finish.path[0]).toMatch(/^0:/);
  // Goals are optional (onboarding 1.8.0): done with none held, the goal checkpoint still tracked.
  expect((await call(athleteA, "GET", "/agent/onboarding/goals")).body.goals).toEqual([]);
  expect(r.body.checkpoints.goal).toBe("pending");
}, 60_000);

test("A5: another athlete's private data never reaches this athlete's model inputs or outputs", async () => {
  const sent = JSON.stringify(transport.calls);
  for (const secret of B_PRIVATE) expect(sent).not.toContain(secret);
  const outputs = [
    await call(athleteA, "GET", "/agent/onboarding"), await call(athleteA, "GET", "/agent/onboarding/facts"),
    await call(athleteA, "GET", "/agent/onboarding/brief"), await call(athleteA, "GET", "/agent/onboarding/goals"),
  ].map((x) => x.text).join("\n");
  for (const secret of B_PRIVATE) expect(outputs).not.toContain(secret);
});

test("A8: an opt-in run, or an athlete who already finished onboarding, is optional — a launch never holds them", async () => {
  const { db } = await import("../../db");
  const { workflowRuns } = await import("../../../shared/schemaWorkflow");
  const run = (athleteId: string, process: string, status: string, input: Record<string, unknown>) =>
    db.insert(workflowRuns).values({ athlete_id: athleteId, process, definition_version: 3, active_scope: process, status, input, created_by: "athlete" });

  // Finished the earlier onboarding, then later started the conversation (the "Meet Mila" entry before input carried optIn).
  const veteran = await seedAthlete("Veteran Athlete", { agent_onboarding_required: true });
  await run(veteran, "onboarding", "done", {});
  await run(veteran, "agent_onboarding", "waiting", { name: "Veteran Athlete", sport: "soccer" });
  expect((await call(veteran, "GET", "/agent/onboarding")).body).toMatchObject({ started: true, done: false, optional: true });

  // An opt-in run records it in its input.
  const optedIn = await seedAthlete("Opted In Athlete", { agent_onboarding_required: true });
  await run(optedIn, "agent_onboarding", "waiting", { name: "Opted In Athlete", sport: "tennis", optIn: true });
  expect((await call(optedIn, "GET", "/agent/onboarding")).body).toMatchObject({ started: true, optional: true });

  // A genuinely new sign-up mid-conversation is still held.
  const fresh = await seedAthlete("Fresh Signup", { agent_onboarding_required: true });
  await run(fresh, "agent_onboarding", "waiting", { name: "Fresh Signup", sport: "golf" });
  expect((await call(fresh, "GET", "/agent/onboarding")).body).toMatchObject({ started: true, optional: false });
});
