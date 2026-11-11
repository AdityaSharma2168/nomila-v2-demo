/**
 * agentEvalGraders.test.ts — the agent eval's graders, judge parsing, report diff and case files, on RECORDED fixtures.
 *
 * CI-safe by construction: no provider (the fake transport answers every model call, the judge caller is a stub),
 * no database (the in-memory store; server/db is mocked so nothing can connect). Fixtures: evals/agent/fixtures/
 * (a FICTIONAL athlete; regenerate with `npx tsx evals/agent/fixtures/record-fixtures.ts`).
 *
 *   G1  the good recording passes every code grader
 *   G2  the bad recording: each grader catches its planted defect
 *   G3  matching: alternatives, groups, word boundaries, thousands separators
 *   G4  the judge: verdicts parsed, a broken answer is an error (never a pass), the input carries facts with sources
 *   G5  the diff: better / worse / same, with noise tolerance on cost and latency
 *   G6  the real case files load: unique ids, reviewed false, 5–10 sourced facts (identity-only cases excepted)
 *   G7  a fresh mock run of the fixture case (runCase → graders) passes, and the budget stops a run that cannot afford a stage
 *   (G8–G11, the harness chat stage, went with the harness: Mila's chat runs on Mastra only, and its eval is
 *   evals/agent/mila-v2 and server/agent/evals/offline.)
 *   G12 the post-kit cases load: made-up libraries, unreviewed, brands only as "$partner" / "$rival", the design's edge
 *       cases all present
 *   G13 a fresh mock run of every post-kit case (the real builder, in memory, a scripted re-rank) passes every grader
 *   G14 the post-kit graders catch their planted defects: an unsafe asset shown and picked, the generation flag wrong, a
 *       trim past its clip, an order that is not the kit's, a failed build, a cost over the cap
 *   G-PR1/2 the plan-ready cases load and pass on a mock run; the graders catch a wrong number, a lost reason, an
 *       invented cause and "posted"
 *   G15 the moments cases load: made-up athletes (none shares a name with another case), unreviewed, a golden list each,
 *       relative dates; a case date resolves on the run's day
 *   G16 a fresh mock run of every moments case (the app's runMomentsScan, in memory) passes every moments grader
 *   G17 the moments graders catch their planted defects: an unseen page, a duplicate, a passed moment left active, a
 *       date outside the window, an incomplete candidate post, a pronoun / key / "AI", a retire that did not happen, too
 *       few moments, a missed golden moment, a must-not hit, a scan over its reserve
 */
jest.mock("../server/db", () => ({ db: {} }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setResponsesTransport } from "../server/agent/research/llm";
import { createMemoryStore } from "../server/agent/research/store";
import { gradeCase, matches } from "../evals/agent/graders";
import { judgeBrief, judgeInput, JUDGE_SYSTEM_PROMPT } from "../evals/agent/judge";
import { loadCases } from "../evals/agent/loadCases";
import { mockJudge, mockMia, mockTransportFor } from "../evals/agent/mock";
import { diffReports } from "../evals/agent/report";
import { Budget, runCase, stagesFor } from "../evals/agent/runCase";
import type { CaseRecord, EvalCase, GraderResult } from "../evals/agent/types";
import { gradeMomentsCase } from "../evals/agent/moments/graders";
import { loadMomentsCases } from "../evals/agent/moments/loadMomentsCases";
import { momentsMockTransport } from "../evals/agent/moments/mock";
import { caseDate, runMomentsCase } from "../evals/agent/moments/runMomentsCase";
import type { MomentsRecord } from "../evals/agent/moments/types";
import { gradePostKitCase } from "../evals/agent/postKit/graders";
import { loadPostKitCases } from "../evals/agent/postKit/loadPostKitCases";
import { runPostKitCase } from "../evals/agent/postKit/runPostKitCase";
import { gradePlanReadyCase, loadPlanReadyCases, runPlanReadyCase } from "../evals/agent/planReady/stage";

const FIX = join(__dirname, "..", "evals", "agent", "fixtures");
const read = <T>(f: string): T => JSON.parse(readFileSync(join(FIX, f), "utf8")) as T;
const fixtureCase = read<EvalCase>("fixture-case.json");
const good = read<CaseRecord>("record.good.json");
const bad = read<CaseRecord>("record.bad.json");
const OPTS = { costCapMicroUsd: 2_000_000, foreignNames: ["Someone Else Entirely"] };
const byName = (rs: GraderResult[]) => Object.fromEntries(rs.map((r) => [r.grader, r]));

afterEach(() => setResponsesTransport(null));

test("G1: the good recording passes every code grader", () => {
  const g = byName(gradeCase(fixtureCase, good, OPTS));
  for (const name of ["schema_valid", "facts_sourced", "caps", "never_content", "expected_recall", "must_not", "identity", "copy_rules", "onboarding_flow", "mia_preview", "content_pillars", "plan", "judge_positioning_supported", "judge_no_unsupported_facts", "cost"]) {
    expect([name, g[name].status]).toEqual([name, "pass"]);
  }
  expect(g.expected_recall.score).toBe(1);
  expect(g.latency.status).toBe("info");
});

test("G2: the bad recording — each grader catches its planted defect", () => {
  const g = byName(gradeCase(fixtureCase, bad, OPTS));
  expect(g.caps.status).toBe("fail");
  expect(g.caps.summary).toMatch(/research_a: 12 searches \(cap 10\)/);
  expect(g.schema_valid.status).toBe("fail");
  expect(JSON.stringify(g.schema_valid.details)).toMatch(/confidence: expected number/);
  expect(g.never_content.status).toBe("fail");
  expect(g.facts_sourced.status).toBe("fail");
  expect(JSON.stringify(g.facts_sourced.details)).toContain("unseen.example.net");
  expect(g.expected_recall.status).toBe("fail");
  expect(g.expected_recall.score).toBe(0.4);
  expect(g.must_not.status).toBe("fail");
  const kinds = (g.must_not.details as Array<{ kind: string; severity: string }>).map((d) => `${d.kind}/${d.severity}`);
  expect(kinds).toEqual(expect.arrayContaining(["contact/fail", "invented_sponsor/fail", "wrong_person/fail", "family/warn"]));
  expect(g.identity.status).toBe("fail");
  expect(g.identity.summary).toMatch(/resolved=true but the #identity flag is set/);
  expect(g.copy_rules.status).toBe("fail");
  const rules = (g.copy_rules.details as Array<{ rule: string }>).map((d) => d.rule);
  expect(rules).toEqual(expect.arrayContaining(["gendered_pronoun", "key_or_tag"]));
  expect(g.onboarding_flow.status).toBe("fail");
  expect(g.mia_preview.status).toBe("fail");
  expect(g.cost.status).toBe("fail");
  expect(g.judge_no_unsupported_facts.status).toBe("fail");
  expect(g.judge_positioning_supported.status).toBe("pass");
  expect(g.plan.status).toBe("fail");
  expect(g.plan.summary).toMatch(/action due after its event/);
  expect(g.content_pillars.status).toBe("fail");
  expect(g.content_pillars.summary).toMatch(/1 content pillar\(s\) \(2–4 wanted\); pillar without facts: One pillar/);
});

test("G2d: understand 1.11.0 — the good recording has 2–4 pillars on facts and a content direction; no search outside research", () => {
  expect(good.brief!.contentPillars!.length).toBeGreaterThanOrEqual(2);
  expect(good.brief!.sections.find((s) => s.key === "content_direction")!.soWhat).toBeTruthy();
  expect(good.runs.find((r) => r.role === "understand")!.webSearchCalls).toBe(0);
  const r: CaseRecord = JSON.parse(JSON.stringify(good));
  r.runs.find((x) => x.role === "understand")!.webSearchCalls = 2;                   // the old context scan
  expect(byName(gradeCase(fixtureCase, r, OPTS)).caps.summary).toMatch(/understand: 2 searches \(cap 0\)/);
  const noDirection: CaseRecord = JSON.parse(JSON.stringify(good));
  noDirection.brief!.sections = noDirection.brief!.sections.filter((s) => s.key !== "content_direction");
  expect(byName(gradeCase(fixtureCase, noDirection, OPTS)).content_pillars.summary).toMatch(/no content_direction section/);
  const old: CaseRecord = JSON.parse(JSON.stringify(good));
  delete old.brief!.contentPillars;
  expect(byName(gradeCase(fixtureCase, old, OPTS)).content_pillars.status).toBe("skip");     // a record from before 1.11.0
});

test("G2b: family names alone are a warning, not a failure; another case's athlete name in copy fails", () => {
  const r: CaseRecord = JSON.parse(JSON.stringify(good));
  r.turns[0].message += " Jamie Ellery will be proud.";
  expect(byName(gradeCase(fixtureCase, r, OPTS)).must_not.status).toBe("warn");
  r.brief!.sections[0].lines.push({ text: "Compare Someone Else Entirely's path.", kind: "inference", factIds: [] });
  expect(byName(gradeCase(fixtureCase, r, OPTS)).copy_rules.summary).toMatch(/other_case_name/);
});

test("G2c: a stage that never finished is skipped, not failed", () => {
  const r: CaseRecord = { ...JSON.parse(JSON.stringify(good)), stagesDone: ["research"], stopped: { reason: "budget", detail: "x" } };
  const g = byName(gradeCase(fixtureCase, r, OPTS));
  expect(g.onboarding_flow.status).toBe("skip");
  expect(g.mia_preview.status).toBe("skip");
  expect(g.plan.status).toBe("skip");
});

test("G3: matching", () => {
  expect(matches("Won the 100-metre final in Paris in 2024", ["100m|100-metre", "2024|Paris"])).toBe(true);
  expect(matches("Won the 100-metre final", ["100m|100-metre", "2024|Paris"])).toBe(false);
  expect(matches("rushed for 6,559 yards", "6559")).toBe(true);
  expect(matches("a sprinter", "sprint")).toBe(false);
  expect(matches("USC Trojans guard", "USC|Southern California")).toBe(true);
  expect(matches("Paralympian since 2004", "Olympian")).toBe(false);
  expect(matches("Signed a $10M deal", "$10m")).toBe(true);
});

test("G4: the judge — verdicts parsed; a broken answer is an error, never a pass; the input carries the facts", async () => {
  const ok = await judgeBrief("Rowan Ellery", "rowing", good, mockJudge);
  expect(ok.positioning_supported.pass).toBe(true);
  expect(ok.error).toBeUndefined();
  const broken = await judgeBrief("Rowan Ellery", "rowing", good, async () => ({ json: { nope: 1 }, provider: "x", model: "x", inputTokens: 1, outputTokens: 1, costMicroUsd: 1 }));
  expect(broken.error).toMatch(/no verdict/);
  expect(broken.no_unsupported_facts.pass).toBe(false);
  const thrown = await judgeBrief("Rowan Ellery", "rowing", good, async () => { throw new Error("vertex down"); });
  expect(thrown.error).toBe("vertex down");
  const input = judgeInput("Rowan Ellery", "rowing", good);
  expect(input).toContain("single sculls");
  expect(input).toContain("source: https://www.example-rowing-federation.org/results/2025-nationals");
  expect(input).toContain("the athlete told us");
  expect(JUDGE_SYSTEM_PROMPT).toMatch(/No scores/);
});

test("G5: the diff — better, worse, same; cost noise within 10% is the same", () => {
  const mk = (graders: GraderResult[]) => ({ cases: [{ id: "c", reviewed: false, description: "", stopped: null, costUsd: 0, judgeUsd: 0, wallMs: 0, graders }] });
  const before = mk([
    { grader: "expected_recall", status: "fail", summary: "", score: 0.4, higherIsBetter: true },
    { grader: "caps", status: "pass", summary: "" },
    { grader: "cost", status: "pass", summary: "", score: 1.0, higherIsBetter: false },
    { grader: "latency", status: "info", summary: "", score: 300, higherIsBetter: false },
  ]);
  const after = mk([
    { grader: "expected_recall", status: "pass", summary: "", score: 0.8, higherIsBetter: true },
    { grader: "caps", status: "fail", summary: "" },
    { grader: "cost", status: "pass", summary: "", score: 1.05, higherIsBetter: false },
    { grader: "latency", status: "info", summary: "", score: 200, higherIsBetter: false },
  ]);
  const d = Object.fromEntries(diffReports(before, after).map((x) => [x.grader, x.verdict]));
  expect(d).toEqual({ expected_recall: "better", caps: "worse", cost: "same", latency: "better" });
});

test("G6: the real case files load and follow the rules", () => {
  const cases = loadCases();
  expect(cases.length).toBeGreaterThanOrEqual(8);
  for (const c of cases) {
    expect([c.id, c.reviewed]).toEqual([c.id, false]);
    if (c.expected.identity !== "disputed") {
      expect(c.expected.facts.length).toBeGreaterThanOrEqual(5);
      expect(c.expected.facts.length).toBeLessThanOrEqual(10);
    }
    for (const f of c.expected.facts) expect(f.source_url).toMatch(/^https:\/\//);
    expect(c.must_not.length).toBeGreaterThan(0);
  }
  expect(cases.some((c) => c.expected.identity === "disputed")).toBe(true);
  expect(cases.some((c) => c.must_not.some((m) => m.kind === "wrong_person"))).toBe(true);
});

test("G7: a fresh mock run of the fixture case passes every grader; the budget stops what it cannot afford", async () => {
  setResponsesTransport(mockTransportFor(fixtureCase));
  const deps = (budgetUsd: number) => ({
    mode: "mock" as const, store: createMemoryStore(), createAthlete: async () => "00000000-0000-4000-8000-0000000000aa",
    mia: mockMia(fixtureCase), judge: mockJudge, budget: new Budget(Math.round(budgetUsd * 1e6)), onboardingCapMicroUsd: 2_000_000, log: () => undefined, today: "2026-10-09",
  });
  const { record } = await runCase(fixtureCase, stagesFor(null), deps(10));
  expect(record.stopped).toBeNull();
  expect(record.runs.map((r) => r.role).sort()).toEqual(["merge", "plan", "research_a", "research_b", "turn:insights", "turn:opening", "understand"]);
  // The plan step wrote a plan from the record's facts (the cost of one run is measured here too).
  expect(record.plan).toMatchObject({ status: "planned" });
  expect(record.plan!.recommended.length).toBeGreaterThan(0);
  expect(record.runs.find((r) => r.role === "plan")!.costMicroUsd).toBeGreaterThan(0);
  const fails = gradeCase(fixtureCase, record, OPTS).filter((g) => g.status === "fail");
  expect(fails).toEqual([]);

  const poor = await runCase(fixtureCase, stagesFor(null), deps(0.5));
  expect(poor.record.stopped?.reason).toBe("budget");
  expect(poor.record.runs).toEqual([]);
});

// ─── The moments stage ─────────────────────────────────────────────────────────────────────────────────────────────

const momentsCases = loadMomentsCases();
const momentsByName = (rs: GraderResult[]) => Object.fromEntries(rs.map((r) => [r.grader, r]));
async function mockMoments(id: string): Promise<MomentsRecord> {
  const c = momentsCases.find((x) => x.id === id)!;
  setResponsesTransport(momentsMockTransport(c, c.mock_today));
  return runMomentsCase(c, { mode: "mock", today: c.mock_today });
}

test("G15: the moments cases load — made-up athletes, unreviewed, a golden list each, relative dates", () => {
  expect(momentsCases.length).toBeGreaterThanOrEqual(4);
  const names = momentsCases.map((c) => c.athlete.name.toLowerCase());
  expect(new Set(names).size).toBe(names.length);
  const others = loadCases().map((c) => c.input.name.toLowerCase());
  for (const c of momentsCases) {
    expect([c.id, c.reviewed]).toEqual([c.id, false]);
    expect(others).not.toContain(c.athlete.name.toLowerCase());
    expect(c.expect.golden.length).toBeGreaterThan(0);
    expect([c.expect.min_moments, c.expect.max_moments]).toEqual([3, 5]);
  }
  expect(caseDate("+6", "2026-10-28")).toBe("2026-11-03");
  expect(caseDate("-5", "2026-03-02")).toBe("2026-02-25");
  expect(caseDate("2026-11", "2026-10-10")).toBe("2026-11");
});

test("G16: a fresh mock run of every moments case passes every moments grader", async () => {
  for (const c of momentsCases) {
    const r = await mockMoments(c.id);
    expect([c.id, r.status, r.error ?? null]).toEqual([c.id, "scanned", null]);
    const g = gradeMomentsCase(c, r);
    expect([c.id, g.filter((x) => x.status === "fail" || x.status === "warn").map((x) => `${x.grader}: ${x.summary}`)]).toEqual([c.id, []]);
  }
}, 60_000);

test("G17: the moments graders catch their planted defects", async () => {
  const c = momentsCases.find((x) => x.id === "m01-college-home-season")!;
  const base = await mockMoments(c.id);
  const bad: MomentsRecord = JSON.parse(JSON.stringify(base));
  const written = bad.moments.find((m) => m.id === bad.applied!.written[0])!;
  const sourced = bad.moments.find((m) => bad.applied!.written.includes(m.id) && m.sourceUrl)!;
  sourced.sourceUrl = "https://unseen.example/page";                                  // a page no search saw
  written.date = "2099-01-01";                                                       // outside the window
  bad.moments.push({ ...bad.moments.find((m) => m.caseKey === "m1")!, id: "dup-0000" });   // the opener twice
  bad.moments.find((m) => m.caseKey === "m2")!.status = "active";                    // passed, left active; and a retire undone
  const cand = bad.candidates.find((x) => x.response === "pending")!;
  cand.idea.angle = "";
  cand.idea.hook = "She will love this AI pick (F2).";
  bad.run!.costMicroUsd = 400_000;
  const g = momentsByName(gradeMomentsCase(c, bad));
  expect(g.moments_sourced.status).toBe("fail");
  expect(JSON.stringify(g.moments_sourced.details)).toContain("unseen.example");
  expect(g.moments_window.summary).toMatch(/2099-01-01 is outside .*; Fall media day: passed .* but still active/);
  expect(g.moments_dedupe.status).toBe("fail");
  expect(g.moments_store.summary).toMatch(/m2 should be retired \(is active\)/);
  expect(g.moments_kit.summary).toMatch(/no angle/);
  expect(g.copy_rules.status).toBe("fail");
  expect((g.copy_rules.details as Array<{ rule: string }>).map((d) => d.rule).sort()).toEqual(["ai_or_brain", "gendered_pronoun", "key"]);
  expect(g.cost.summary).toMatch(/\$0\.400 over the \$0\.25 reserve/);

  // Too few moments; a missed golden moment (a warning until reviewed, a failure after); a must-not hit; a failed scan.
  const thin: MomentsRecord = JSON.parse(JSON.stringify(base));
  thin.applied!.written = [];
  thin.applied!.linked = [];
  const t = momentsByName(gradeMomentsCase(c, thin));
  expect(t.moments_count).toMatchObject({ status: "fail", score: 1 });
  expect(t.moments_recall).toMatchObject({ status: "warn", score: 0.5 });
  expect(momentsByName(gradeMomentsCase({ ...c, reviewed: true }, thin)).moments_recall.status).toBe("fail");
  const hit: MomentsRecord = JSON.parse(JSON.stringify(base));
  hit.candidates.find((x) => x.response === "pending")!.idea.angle = "Swap the cup for Summit Espresso.";
  expect(momentsByName(gradeMomentsCase(c, hit)).must_not.status).toBe("fail");
  const failed: MomentsRecord = { ...JSON.parse(JSON.stringify(base)), status: "error", error: "provider down", run: null, applied: null };
  const f = momentsByName(gradeMomentsCase(c, failed));
  expect(f.schema_valid).toMatchObject({ status: "fail", summary: "the scan failed: provider down" });
  expect(f.moments_count.status).toBe("skip");
});

// ─── The post-kit stage (evals/agent/postKit): made-up libraries, the real builder in memory ──────────────────────

test("G12: the post-kit cases load — made-up libraries, unreviewed, no brand named, every key they name exists", () => {
  const cases = loadPostKitCases();
  expect(cases.length).toBeGreaterThanOrEqual(10);
  expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  for (const c of cases) expect({ id: c.id, reviewed: c.reviewed }).toEqual({ id: c.id, reviewed: false });
  // The edge cases the design names are all covered.
  const ids = cases.map((c) => c.id).join(" ");
  for (const w of ["no-media", "only-photos", "long-video", "brand-unsafe", "made-here", "partner-rival", "never-use", "nothing-fits"]) expect(ids).toContain(w);
});

test("G13: a fresh mock run of every post-kit case (the real builder, in memory) passes every code grader", async () => {
  for (const c of loadPostKitCases()) {
    const record = await runPostKitCase(c, "mock");
    const failed = gradePostKitCase(c, record).filter((g) => g.status === "fail").map((g) => `${g.grader}: ${g.summary}`);
    expect({ id: c.id, failed }).toEqual({ id: c.id, failed: [] });
    // No media: no call is made at all.
    if (!c.library.length) expect(record.calls).toBe(0);
  }
});

test("G14: the post-kit graders catch their planted defects", async () => {
  const c = loadPostKitCases().find((x) => x.id === "pk04-brand-unsafe-decoy")!;
  const good = await runPostKitCase(c, "mock");
  const fails = (r: typeof good) => gradePostKitCase(c, r).filter((g) => g.status === "fail").map((g) => g.grader);
  expect(fails(good)).toEqual([]);
  const unsafeId = Object.entries(good.keyOf).find(([, k]) => k === "unsafe_party")![0];
  const kit = good.kit!;
  // An unsafe asset in the kit (and shown to the re-rank), the generation flag wrong, a trim past the clip, a bad order.
  const planted = {
    ...good, shown: [...good.shown, "unsafe_party"],
    kit: {
      ...kit,
      assets: [{ assetId: unsafeId, mediaType: "clip" as const, clip: { startSec: 0, endSec: 40, from: "opening" as const }, durationSec: 20, provenance: "camera" as const }],
      aiGenerationNeeded: { value: true, reason: "x" },
      treatmentPlan: { ...kit.treatmentPlan, order: ["someone-else"], trims: [{ assetId: unsafeId, startSec: 0, endSec: 40 }] },
    },
  };
  expect(fails(planted)).toEqual(["safety_floor", "expected_pick", "ai_flag", "treatment"]);
  expect(fails({ ...good, error: "boom", kit: null })).toEqual(["built"]);
  expect(fails({ ...good, costMicroUsd: 1_000_000 })).toEqual(["cost"]);
});

// ─── The plan-ready stage (evals/agent/planReady): Mila's follow-up line from the facts object ───────────────────

test("G-PR1: the plan-ready cases load (5, reviewed after the first live run) and a fresh mock run of each (the real plan/ready skill, in memory) passes every grader", async () => {
  const cases = loadPlanReadyCases();
  expect(cases.map((c) => c.id)).toEqual(["pr01-all-good", "pr02-needs-media", "pr03-held", "pr04-unchanged", "pr05-skipped-budget"]);
  for (const c of cases) {
    expect(c.reviewed).toBe(true);                                             // read against a live run, 12 Oct
    const r = await runPlanReadyCase(c, "mock");
    expect({ id: c.id, line: r.line, failed: gradePlanReadyCase(c, r).filter((g) => g.status === "fail").map((g) => `${g.grader}: ${g.summary}`) })
      .toEqual({ id: c.id, line: c.mock_line, failed: [] });
  }
});

test("G-PR2: the plan-ready graders catch a wrong number, a lost reason, an invented cause and a claim that something went out", () => {
  const c = loadPlanReadyCases().find((x) => x.id === "pr02-needs-media")!;
  const fails = (line: string) => gradePlanReadyCase(c, { caseId: c.id, mode: "mock", line, costMicroUsd: 0 }).filter((g) => g.status === "fail").map((g) => g.grader);
  expect(fails(c.mock_line)).toEqual([]);
  expect(fails("I planned 4 posts for this week. 2 kits are ready; the story needs a clip of you talking to camera.")).toEqual(["checks", "numbers"]);
  expect(fails("I planned 3 posts for this week. 2 kits are ready; the story's kit is still on its way.")).toEqual(["reason_kept"]);
  expect(fails("I planned 3 posts for this week. 2 kits are ready; the story ran over this week's budget, it needs a clip of you talking to camera.")).toEqual(["no_invented"]);
  expect(fails("I posted 3 posts for you. 2 kits are ready; the story needs a clip of you talking to camera.")).toEqual(["checks", "no_invented"]);   // the production checks refuse "posted" too
});
