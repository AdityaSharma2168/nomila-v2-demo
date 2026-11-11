/**
 * understand.test.ts — the Understand skill's plumbing and safety (in-memory store, model mocked).
 *
 *   U1 sensitive and removed facts never reach the model; the model sees short keys, never ids
 *   U2 refs map back to fact ids; a "fact" line with no valid ref becomes an inference; a line showing a score is dropped
 *   U3 understand 1.11.0 (register R2): no context scan — the dated moments already in the facts (event facts) are listed
 *      under DATED MOMENTS (today on, soonest first, a month-only date marked) and the timing section cites them like
 *      any other fact; Understand writes no fact of its own
 *   U4 the internal read (sponsors current vs past) is stored apart and never in the brief shown; no hidden scores and
 *      no strengths-and-gaps section are stored even if a model returns them (the M.I.A. is the only score and the
 *      only source of strengths and gaps)
 *   U7 the stage and the positioning are stored as returned (display), keys stripped, refs mapped to fact ids
 *   U5 stage comes from the evidence, with confidence; youth, college and pro fixtures each get their own
 *   U6 the request: high effort, no tools (no web search), the brief schema
 *   U8 a sponsor resting only on facts about others (a club's sponsor) is never listed as the athlete's own
 *   U9 understand 1.10.0: a partner's `since` is kept only as YYYY / YYYY-MM whose year a backing fact's claim states
 *   U10 understand 1.11.0 (register R4): content pillars are kept only on a real fact, with no score, at most four,
 *      renumbered, keys stripped, stored with the display fields; the content_direction section is stored with its
 *      lines and so-what
 *   U11 understand 1.11.0 (register R4): the athlete's active goals go in under GOALS; none on a first Brief
 *   U14 understand 1.13.0: her own agreed deals in Nomila go in under NOMILA DEALS (D-keys, never fact keys)
 *   U15 the suggested rate ranges: a known rate type, positive low ≤ high and a driver, refs mapped (unknown dropped),
 *       "low" without measured facts; kept on the internal read (never the Brief shown) and stored as her rates
 *   U16 a failed store never fails the Brief; no ranges, nothing stored
 *   U17 her deal fees are private: a sentence naming one leaves the thesis, positioning, content pillars and narrative
 *   U18 her saved preferences go in under PREFERENCES (active only), with her never-use names
 *   U19 a never-use name is never quoted in anything she reads (the sentence naming it is removed)
 *   U20 understand 1.14.0: rates carry forward — a refresh reads CURRENT RATES (her ranges); a first Brief never does
 *   U21 understand 1.15.0: WHAT WORKS FOR THIS ATHLETE goes in when a line rests on 3+ posts (leads marked); else no block
 *   U22 understand 1.16.0: PLAYBOOK FORMATS (the formats her playbook recommends, per platform she is on) goes in when
 *       there are any; else no block. playbookFormatsOf reads a playbook's mix, formats and stories
 */
jest.mock("../../db", () => ({ db: {} }));

import type { MemoryFact, Preference } from "../../../shared/agent";
import { FIXTURES, fakeResponses, type AthleteFixture } from "../../testUtils/agentModel";
import { setResponsesTransport } from "./llm";
import { createMemoryStore } from "./store";
import { briefableFacts, MAX_CONTENT_PILLARS, MAX_RANGE_HIGH, moneyAmountsIn, rateRangesFrom, redactFees, statedSince, stripKeys, understand } from "./understand";
import type { NomilaDeal } from "./nomilaDeals";
import type { WhatWorks } from "../learning/core";
import { playbookFormatsOf } from "../playbook/read";

afterEach(() => setResponsesTransport(null));
const athleteId = "00000000-0000-4000-8000-0000000000aa";

async function seed(f: AthleteFixture) {
  const store = createMemoryStore();
  const facts = await store.insertFacts(athleteId, f.pages.filter((p) => p.sensitivity !== "never").map((p) => ({
    subject: { kind: "athlete" as const, name: f.name }, claim: p.claim, type: "found" as const, source: { url: p.url, title: p.title },
    date: p.date.length === 4 ? `${p.date}-01-01` : p.date.length === 7 ? `${p.date}-01` : p.date, confidence: 0.9, runId: null, sensitive: p.sensitivity === "care",
  })));
  return { store, facts };
}

const brief = (stage: { label: string; band: string }, over: Record<string, unknown> = {}) => ({
  stage: { ...stage, confidence: 0.8, why: "From the roster and results.", refs: ["f1"] },
  thesis: { big_idea: "A rising name with a clear story.", verdict: "Marketable locally today; regional upside." },
  sections: [
    { key: "brand_now_next", title: "Brand", lines: [{ text: "Starter on the team this season.", kind: "fact", refs: ["f1"] }, { text: "Unsupported claim stated as fact.", kind: "fact", refs: ["f99"] }], so_what: "Lead with performance." },
    { key: "commercial_readiness", title: "CR", lines: [{ text: "Audience reach scored 7/10.", kind: "inference", refs: ["f1"] }, { text: "Results are the strongest asset.", kind: "inference", refs: ["f2"] }], so_what: "Build on results." },
    // Retired in understand 1.7.0 (strengths and gaps come from the M.I.A.): a stray one is never stored.
    { key: "strengths_gaps", title: "S&G", lines: [{ text: "A stray strengths line.", kind: "inference", refs: ["f2"] }], so_what: "Stray." },
    { key: "context_timing", title: "Timing", lines: [{ text: "Championship season starts next month.", kind: "fact", refs: ["f4"] }], so_what: "Plan around it." },
    { key: "content_direction", title: "Content", lines: [{ text: "Posts race-day clips most weeks (f2).", kind: "fact", refs: ["f2"] }], so_what: "Shift toward the training story behind the results." },
  ],
  positioning: { from: "A name on a roster", to: "The face of the program (f2)", statement: "Results first.", pillars: [{ name: "Performance", line: "Results", refs: ["f2"] }, { name: "Community", line: "Local", refs: [] }, { name: "Craft", line: "Training", refs: [] }], refs: ["f1"] },
  content_pillars: [
    { key: "P1", name: "Training and the work (f1)", why_this_athlete: "The roster and results show the hours.", refs: ["f1"] },
    { key: "P2", name: "No fact behind it", why_this_athlete: "Invented.", refs: [] },
    { key: "P3", name: "Race days", why_this_athlete: "A conference title on record.", refs: ["f2", "f99"] },
    { key: "P4", name: "Content rated 9/10", why_this_athlete: "A score.", refs: ["f2"] },
    { key: "P5", name: "Campus life", why_this_athlete: "A junior on the team.", refs: ["f1"] },
    { key: "P6", name: "Local partners", why_this_athlete: "A one-off regional campaign.", refs: ["f3"] },
    { key: "P7", name: "A fifth real one", why_this_athlete: "Past the cap.", refs: ["f2"] },
  ],
  internal: {
    current_sponsors: [], past_sponsors: [{ name: "a regional shop", refs: ["f3"] }],
    // Retired in understand 1.7.0: a model that still returns them stores nothing of them.
    criteria: [{ name: "audience_reach", score: 7, confidence: 0.6, why: "Small but engaged.", refs: ["f1"] }],
    rate_notes: "Estimate only: small local ranges.",
    // Understand 1.9.0: kept only with words, something it blocks and a real fact; never with a score in it.
    exclusivity_conflicts: [
      { what: "x", blocks: ["y"], refs: [] },
      { what: "The team's apparel partner (f3) holds the apparel category.", blocks: ["other apparel brands"], refs: ["f3", "f99"] },
      { what: "Conflict risk rated 8/10.", blocks: ["anything"], refs: ["f1"] },
      { what: "Nothing blocked.", blocks: [], refs: ["f1"] },
    ],
  },
  narrative: "Narrative paragraph.",
  ...over,
});

test("U1: never-store facts do not exist to reach the model; the model sees keys not ids", async () => {
  const f = FIXTURES.youth;
  const { store, facts } = await seed(f);
  const t = fakeResponses(() => ({ json: brief({ label: "High school varsity", band: "early" }), sources: [{ url: "https://example-league-calendar.org/2026" }] }));
  setResponsesTransport(t);
  await understand({ store, athleteId, parentPrefix: "workflow:u1" }, { athlete: f, facts, gaps: [], ageBand: "under_18" });
  const input = String(t.calls[0].input);
  expect(input).not.toContain("younger sibling");                 // the sensitive page
  for (const x of facts) expect(input).not.toContain(x.id);
  expect(input).toContain("f1 |");
  expect(input).toContain("AGE BAND (self-declared): under_18");
});

test("U2–U4: refs map to ids, unsupported fact lines are downgraded, score lines dropped, the timing reads the dated moments, internal kept apart", async () => {
  const f = FIXTURES.college;
  const { store, facts } = await seed(f);
  // The moments store: an upcoming moment research seeded (f4), and one already past (never listed as coming up).
  const [moment, past] = await store.insertFacts(athleteId, [
    { subject: { kind: "event", name: "Championship season" }, claim: "The championship season starts in November 2026.", type: "found", source: { url: "https://example-league-calendar.org/2026" }, date: "2026-11-01", datePrecision: "month", confidence: 0.9, runId: null, topic: "moment" },
    { subject: { kind: "event", name: "Preseason scrimmage" }, claim: "The preseason scrimmage was on 2 October 2026.", type: "found", source: { url: "https://example-league-calendar.org/scrimmage" }, date: "2026-10-02", confidence: 0.9, runId: null, topic: "moment" },
  ]);
  const given = [...facts, moment, past];
  const t = fakeResponses(() => ({ json: brief({ label: "College junior", band: "developing" }) }));
  setResponsesTransport(t);
  const r = await understand({ store, athleteId, parentPrefix: "workflow:u2", today: "2026-10-10" }, { athlete: f, facts: given, gaps: ["eligibility"], ageBand: null });
  const input = String(t.calls[0].input);
  expect(input).toContain("DATED MOMENTS (event facts above, today or later, soonest first)\n- f4 | 2026-11-01 (month only) | Championship season\n");
  expect(input).not.toMatch(/- f5 \| 2026-10-02/);                                    // a past moment is not coming up

  const bnn = r.brief.sections.find((s) => s.key === "brand_now_next")!;
  expect(bnn.lines[0]).toEqual({ text: "Starter on the team this season.", kind: "fact", factIds: [facts[0].id] });
  expect(bnn.lines[1].kind).toBe("inference");                                  // no valid ref → never shown as fact
  expect(r.downgraded).toBe(1);
  expect(bnn.text).toContain("So what: Lead with performance.");

  const cr = r.brief.sections.find((s) => s.key === "commercial_readiness")!;
  expect(cr.lines.map((l) => l.text)).toEqual(["Results are the strongest asset."]);   // the score line is gone
  expect(r.droppedLines).toBe(1);
  expect(r.brief.sections.map((s) => s.key)).not.toContain("strengths_gaps");          // M.I.A. owns strengths and gaps

  // Understand writes no fact of its own (no context scan): the timing line cites the moment research seeded.
  expect((await store.listFacts(athleteId)).filter((x) => x.runId === r.runId)).toEqual([]);
  const timing = r.brief.sections.find((s) => s.key === "context_timing")!;
  expect(timing.lines[0]).toMatchObject({ kind: "fact", factIds: [moment.id] });

  // Everything the brief rests on is a real fact with a source.
  const all = new Map((await store.listFacts(athleteId)).map((x) => [x.id, x]));
  for (const id of r.brief.factIds) expect(all.get(id)!.source.url ?? all.get(id)!.source.ref).toBeTruthy();

  // The internal read is stored, but never part of the brief shown.
  const shown = JSON.stringify(await store.currentBrief(athleteId));
  expect(shown).not.toMatch(/criteria|audience_reach|rate_notes|past_sponsors|regional shop|7\/10/);
  const internal = (await store.currentBriefInternal(athleteId)) as any;
  expect(internal.pastSponsors).toEqual([{ name: "a regional shop", factIds: [facts[2].id] }]);
  expect(internal.currentSponsors).toEqual([]);
  // Understand 1.9.0: the conflicts, keys stripped, refs mapped (unknown dropped); the empty, unsourced and scored ones gone.
  expect(internal.exclusivityConflicts).toEqual([{ what: "The team's apparel partner holds the apparel category.", blocks: ["other apparel brands"], factIds: [facts[2].id] }]);
  // No hidden scores, and nothing else the 1.6 internal read held.
  expect(Object.keys(internal).sort()).toEqual(["currentSponsors", "exclusivityConflicts", "narrative", "pastSponsors"]);
  expect(JSON.stringify(internal)).not.toMatch(/criteria|score|rate|stage|8\/10/i);
});

test("U7: stage and positioning are stored as returned (display), keys stripped, refs mapped to fact ids", async () => {
  const f = FIXTURES.college;
  const { store, facts } = await seed(f);
  setResponsesTransport(fakeResponses(() => ({ json: brief({ label: "College junior", band: "developing" }), sources: [] })));
  const r = await understand({ store, athleteId, parentPrefix: "workflow:u7" }, { athlete: f, facts, gaps: [], ageBand: null });
  const want = {
    stage: { label: "College junior", band: "developing", confidence: 0.8, why: "From the roster and results.", factIds: [facts[0].id] },
    positioning: {
      from: "A name on a roster", to: "The face of the program", statement: "Results first.",
      pillars: [{ name: "Performance", line: "Results", factIds: [facts[1].id] }, { name: "Community", line: "Local", factIds: [] }, { name: "Craft", line: "Training", factIds: [] }],
      factIds: [facts[0].id],
    },
    contentPillars: [
      { key: "P1", name: "Training and the work", whyThisAthlete: "The roster and results show the hours.", factIds: [facts[0].id] },
      { key: "P2", name: "Race days", whyThisAthlete: "A conference title on record.", factIds: [facts[1].id] },
      { key: "P3", name: "Campus life", whyThisAthlete: "A junior on the team.", factIds: [facts[0].id] },
      { key: "P4", name: "Local partners", whyThisAthlete: "A one-off regional campaign.", factIds: [facts[2].id] },
    ],
  };
  expect(r.brief.display).toEqual(want);
  expect((await store.currentBrief(athleteId))!.display).toEqual(want);
  // The per-section so-what is stored on each section, as returned.
  expect(r.brief.sections.find((s) => s.key === "context_timing")!.soWhat).toBe("Plan around it.");
});

test.each([
  ["youth", "High school varsity outside hitter", "early"],
  ["college", "College junior, conference champion", "developing"],
  ["pro", "Professional guard, all-star", "established"],
] as const)("U5: %s — stage from the evidence, with confidence, shown in the brief", async (which, label, band) => {
  const f = FIXTURES[which];
  const { store, facts } = await seed(f);
  setResponsesTransport(fakeResponses(() => ({ json: brief({ label, band }), sources: [] })));
  const r = await understand({ store, athleteId, parentPrefix: `workflow:u5-${which}` }, { athlete: f, facts, gaps: [], ageBand: f.ageBand });
  expect(r.stage).toMatchObject({ label, band, confidence: 0.8, factIds: [facts[0].id] });
  expect(r.brief.sections.find((s) => s.key === "stage")!.text).toContain(label);
  expect(r.brief.sections[0].key).toBe("thesis");                                // verdict first
});

test("U6: high effort, no tools (no web search), the brief schema", async () => {
  const f = FIXTURES.pro;
  const { store, facts } = await seed(f);
  const t = fakeResponses(() => ({ json: brief({ label: "Pro", band: "established" }) }));
  setResponsesTransport(t);
  await understand({ store, athleteId, parentPrefix: "workflow:u6" }, { athlete: f, facts: facts as MemoryFact[], gaps: [], ageBand: null });
  expect(t.calls[0].reasoning.effort).toBe("high");
  expect(t.calls[0].tools).toBeUndefined();
  expect(t.calls[0].max_tool_calls).toBeUndefined();
  expect(t.calls[0].include).toBeUndefined();
  expect(t.calls[0].prompt_cache_key).toBe("nomila:understand@1.16.0");
  expect(t.calls[0].text.format.name).toBe("understand_brief");
  expect(JSON.stringify(t.calls[0].text.format.schema)).not.toContain("context_facts");
});

test("keys never reach athlete-visible text", () => {
  expect(stripKeys("Strong base (f10, f11, f33) for growth.")).toBe("Strong base for growth.");
  expect(stripKeys("f4's exact date is disputed.")).toBe("the exact date is disputed.");
  expect(stripKeys("Season windows [c1 and c2] matter.")).toBe("Season windows matter.");
  expect(stripKeys("Played 224 games for the f-team.")).toBe("Played 224 games for the f-team.");
  // Inline markdown citations are not shown either: a line's sources are its refs.
  expect(stripKeys("Finals are in December ([example.org](https://example.org/x)) (c2).")).toBe("Finals are in December.");
});

test("U8: a team, school or club's sponsor is never listed as the athlete's own sponsor (code guard on the internal read)", async () => {
  const f = FIXTURES.college;
  const { store, facts } = await seed(f);
  const [club] = await store.insertFacts(athleteId, [{
    subject: { kind: "organization", name: "Example University Athletics" }, claim: "Example University Athletics lists Example Kit Co. as its apparel sponsor.",
    type: "found", source: { url: "https://example-university-athletics.edu/sponsors" }, date: null, confidence: 0.9, runId: null,
  }]);
  const all = [...facts, club];
  setResponsesTransport(fakeResponses(() => ({
    json: brief({ label: "College junior", band: "developing" }, {
      internal: { current_sponsors: [{ name: "Example Kit Co.", refs: ["f4"] }], past_sponsors: [{ name: "a regional shop", refs: ["f3"] }] },
    }),
    sources: [{ url: "https://example-league-calendar.org/2026" }],
  })));
  const r = await understand({ store, athleteId, parentPrefix: "workflow:u8" }, { athlete: f, facts: all, gaps: [], ageBand: null });
  const internal = (await store.currentBriefInternal(athleteId)) as any;
  expect(internal.currentSponsors).toEqual([]);                                     // the club's sponsor is not hers
  expect(internal.pastSponsors).toEqual([{ name: "a regional shop", factIds: [facts[2].id] }]);
  expect(r.othersSponsors).toBe(1);
});

test("U9: a partner's start is kept only when a fact it rests on states it (never inferred), and stored only when known", async () => {
  const claim = (c: string) => [{ claim: c }];
  expect(statedSince("2023", claim("Signed with Brand A in 2023."))).toBe("2023");
  expect(statedSince("2023-05", claim("Has worked with Brand A since May 2023."))).toBe("2023-05");
  expect(statedSince("2022", claim("Brand A renewed in 2023."))).toBeNull();       // the year is not in any claim: inferred
  expect(statedSince("2023-13", claim("Signed in 2023."))).toBeNull();             // not a real month
  expect(statedSince("May 2023", claim("Signed in May 2023."))).toBeNull();        // not YYYY or YYYY-MM
  expect(statedSince(null, claim("Signed in 2023."))).toBeNull();
  expect(statedSince("2023", [])).toBeNull();                                      // no fact behind it

  const f = FIXTURES.college;
  const { store, facts } = await seed(f);
  const [deal] = await store.insertFacts(athleteId, [{
    subject: { kind: "athlete", name: f.name }, claim: `${f.name} has been an ambassador for Example Shoe Co. since 2024.`,
    type: "found", source: { url: "https://example-shoe.example/ambassadors" }, date: "2026-03-01", confidence: 0.9, runId: null,
  }]);
  const all = [...facts, deal];
  const dealKey = `f${briefableFacts(all).findIndex((x) => x.id === deal.id) + 1}`;
  setResponsesTransport(fakeResponses(() => ({
    json: brief({ label: "College junior", band: "developing" }, {
      internal: {
        current_sponsors: [{ name: "Example Shoe Co.", refs: [dealKey], since: "2024" }],
        past_sponsors: [{ name: "a regional shop", refs: ["f3"], since: "2019" }],
        exclusivity_conflicts: [],
      },
    }),
    sources: [{ url: "https://example-league-calendar.org/2026" }],
  })));
  await understand({ store, athleteId, parentPrefix: "workflow:u9" }, { athlete: f, facts: all, gaps: [], ageBand: null });
  const internal = (await store.currentBriefInternal(athleteId)) as any;
  expect(internal.currentSponsors).toEqual([{ name: "Example Shoe Co.", factIds: [deal.id], since: "2024" }]);
  expect(internal.pastSponsors).toEqual([{ name: "a regional shop", factIds: [facts[2].id] }]);   // 2019 is in no claim: dropped
});

test("U10: content pillars — on a real fact, no score, at most four, renumbered; the content direction section stored", async () => {
  const f = FIXTURES.college;
  const { store, facts } = await seed(f);
  setResponsesTransport(fakeResponses(() => ({ json: brief({ label: "College junior", band: "developing" }) })));
  const r = await understand({ store, athleteId, parentPrefix: "workflow:u10" }, { athlete: f, facts, gaps: [], ageBand: null });
  expect(MAX_CONTENT_PILLARS).toBe(4);
  expect(r.contentPillars.map((p) => [p.key, p.name])).toEqual([["P1", "Training and the work"], ["P2", "Race days"], ["P3", "Campus life"], ["P4", "Local partners"]]);
  expect(r.contentPillars[1].factIds).toEqual([facts[1].id]);                       // the unknown key is dropped, the pillar kept
  expect(r.droppedPillars).toBe(3);                                                  // no fact; a score; past the cap
  expect((await store.currentBrief(athleteId))!.display!.contentPillars).toEqual(r.contentPillars);
  const direction = r.brief.sections.find((s) => s.key === "content_direction")!;
  expect(direction).toMatchObject({
    title: "Content: today → direction", soWhat: "Shift toward the training story behind the results.",
    lines: [{ text: "Posts race-day clips most weeks.", kind: "fact", factIds: [facts[1].id] }],
  });
  // Sections keep the skill's order: timing, then the content direction, then risks.
  const keys = r.brief.sections.map((s) => s.key);
  expect(keys.indexOf("content_direction")).toBeGreaterThan(keys.indexOf("context_timing"));
});

test("U10b: a model that returns no pillars stores none (never invented by code)", async () => {
  const f = FIXTURES.youth;
  const { store, facts } = await seed(f);
  setResponsesTransport(fakeResponses(() => ({ json: brief({ label: "High school varsity", band: "early" }, { content_pillars: [] }) })));
  const r = await understand({ store, athleteId, parentPrefix: "workflow:u10b" }, { athlete: f, facts, gaps: [], ageBand: "under_18" });
  expect(r.contentPillars).toEqual([]);
  expect(r.droppedPillars).toBe(0);
  expect(r.brief.display!.contentPillars).toEqual([]);
});

test("U11: the athlete's active goals go in under GOALS; none on a first Brief", async () => {
  const f = FIXTURES.pro;
  const { store, facts } = await seed(f);
  const t = fakeResponses(() => ({ json: brief({ label: "Pro", band: "established" }) }));
  setResponsesTransport(t);
  await understand({ store, athleteId, parentPrefix: "workflow:u11a" }, { athlete: f, facts, gaps: [], ageBand: null });
  expect(String(t.calls[0].input)).toContain("GOALS (held by the athlete)\n- (none yet)\n");

  const active = await store.insertGoal(athleteId, { text: "Grow my audience  this season", source: "said", decisionId: null, horizon: "now", domain: "audience" });
  const paused = await store.insertGoal(athleteId, { text: "PAUSED-GOAL", source: "said", decisionId: null });
  await store.updateGoal(athleteId, paused.id, { status: "paused" });
  await understand({ store, athleteId, parentPrefix: "workflow:u11b" }, { athlete: f, facts, gaps: [], ageBand: null, goals: await store.listGoals(athleteId) });
  const input = String(t.calls[1].input);
  expect(input).toContain("GOALS (held by the athlete)\nG1 | Grow my audience this season | domain audience | horizon now\n");
  expect(input).not.toContain("PAUSED-GOAL");
  expect(input).not.toContain(active.id);                                           // keys, never ids
});

test("U12: a pillar never rests on a care fact — care refs are removed, and a pillar left with none is dropped", async () => {
  const f = FIXTURES.college;
  const { store, facts } = await seed(f);
  const [care] = await store.insertFacts(athleteId, [{
    subject: { kind: "athlete", name: f.name }, claim: `${f.name} returned from a shoulder injury in 2026.`, type: "found", source: { url: "https://example.org/injury" },
    date: "2026-03-01", confidence: 0.9, runId: null, sensitive: true, careKind: "personal",
  }]);
  const all = [...facts, care];
  const careKey = `f${briefableFacts(all).findIndex((x) => x.id === care.id) + 1}`;
  setResponsesTransport(fakeResponses(() => ({
    json: brief({ label: "College junior", band: "developing" }, {
      content_pillars: [
        { key: "P1", name: "The comeback", why_this_athlete: "Back from injury.", refs: [careKey] },
        { key: "P2", name: "Race days", why_this_athlete: "A title on record.", refs: [careKey, "f2"] },
        { key: "P3", name: "Training", why_this_athlete: "The hours.", refs: ["f1"] },
      ],
    }),
  })));
  const r = await understand({ store, athleteId, parentPrefix: "workflow:u12" }, { athlete: f, facts: all, gaps: [], ageBand: null });
  expect(r.contentPillars).toEqual([
    { key: "P1", name: "Race days", whyThisAthlete: "A title on record.", factIds: [facts[1].id] },
    { key: "P2", name: "Training", whyThisAthlete: "The hours.", factIds: [facts[0].id] },
  ]);
  expect(r.droppedPillars).toBe(1);
  expect(JSON.stringify(r.brief.display)).not.toContain(care.id);
});

test("U13: mid-month — a month-only moment in the current month is still listed under DATED MOMENTS", async () => {
  const f = FIXTURES.college;
  const { store, facts } = await seed(f);
  const [month, ended] = await store.insertFacts(athleteId, [
    { subject: { kind: "event", name: "Rivalry month" }, claim: "October 2026 is rivalry month.", type: "found", source: { url: "https://example.org/rivalry" }, date: "2026-10-01", datePrecision: "month", confidence: 0.8, runId: null, topic: "moment" },
    { subject: { kind: "event", name: "September cup" }, claim: "The September cup.", type: "found", source: { url: "https://example.org/sept" }, date: "2026-09-01", datePrecision: "month", confidence: 0.8, runId: null, topic: "moment" },
  ]);
  const all = [...facts, month, ended];
  const t = fakeResponses(() => ({ json: brief({ label: "College junior", band: "developing" }) }));
  setResponsesTransport(t);
  await understand({ store, athleteId, parentPrefix: "workflow:u13", today: "2026-10-15" }, { athlete: f, facts: all, gaps: [], ageBand: null });
  const input = String(t.calls[0].input);
  expect(input).toMatch(/- f\d+ \| 2026-10-01 \(month only\) \| Rivalry month/);
  expect(input).not.toMatch(/- f\d+ \| 2026-09-01 \(month only\) \| September cup/);
});

// ── understand 1.13.0: the Brief decides her suggested rate ranges ─────────────────────────────────────────────────

const deal = (over: Partial<NomilaDeal> = {}): NomilaDeal => ({
  brand: "A regional outfitter", dealType: "social_post", deliverables: ["2x Reel"], fee: { amount: 1500, currency: "USD", basis: "contract_schedule" },
  productOnly: false, commissionOnly: false, date: "2026-05-01", confirmedBy: "signed_contract", ...over,
});

test("U14: NOMILA DEALS go in (D-keys, never fact keys); none → said so", async () => {
  const f = FIXTURES.college;
  const { store, facts } = await seed(f);
  const t = fakeResponses(() => ({ json: brief({ label: "College junior", band: "developing" }) }));
  setResponsesTransport(t);
  await understand({ store, athleteId, parentPrefix: "workflow:u14a" }, { athlete: f, facts, gaps: [], ageBand: null });
  expect(String(t.calls[0].input)).toMatch(/NOMILA DEALS \([^\n]*\)\n- \(none yet\)/);

  await understand({ store, athleteId, parentPrefix: "workflow:u14b" }, {
    athlete: f, facts, gaps: [], ageBand: null,
    nomilaDeals: [deal(), deal({ brand: "A local cafe", dealType: "other", deliverables: [], fee: null, productOnly: true, confirmedBy: "email_only", date: "2026-03-02" })],
  });
  const input = String(t.calls[1].input);
  expect(input).toContain("D1 | A regional outfitter | type social_post | deliverables 2x Reel | fee 1500 USD (contract schedule) | date 2026-05-01 | signed contract");
  expect(input).toContain("D2 | A local cafe | type other | deliverables not recorded | product only, no fee | date 2026-03-02 | email only, not signed");
});

test("U15: rate ranges — known type, positive low ≤ high, a driver; refs mapped (unknown dropped); low confidence without measured data; stored as her suggested rates", async () => {
  const f = FIXTURES.college;
  const { store, facts } = await seed(f);
  const saved: any[] = [];
  const saveRateRanges = jest.fn(async (id: string, ranges: any[], meta: { runId: string }) => { saved.push({ id, ranges, meta }); return { saved: ranges.map((r) => r.rateType) }; });
  setResponsesTransport(fakeResponses(() => ({ json: brief({ label: "College junior", band: "developing" }, { rate_ranges: [
    { rate_type: "ig_post", low: 150.4, high: 600, currency: "usd", confidence: "high", drivers: ["local audience (f1)", "conference title", "rated 9/10"], refs: ["f1", "f99"] },
    { rate_type: "ig_post", low: 1, high: 2, currency: "USD", confidence: "low", drivers: ["a second ig_post"], refs: [] },       // one per type
    { rate_type: "tv_commercial", low: 100, high: 200, currency: "USD", confidence: "low", drivers: ["x"], refs: [] },           // unknown type
    { rate_type: "ig_reel", low: 500, high: 100, currency: "USD", confidence: "low", drivers: ["x"], refs: [] },                // high < low
    { rate_type: "ig_story", low: 0, high: 100, currency: "USD", confidence: "low", drivers: ["x"], refs: [] },                 // not positive
    { rate_type: "camp_clinic", low: 200, high: 800, currency: "USD", confidence: "low", drivers: [], refs: ["f2"] },            // no driver
    { rate_type: "booking_video_call_30", low: 25, high: 75, currency: "dollars", confidence: "medium", drivers: ["fan demand"], refs: ["f2"] },
  ] }) })));
  const r = await understand({ store, athleteId, parentPrefix: "workflow:u15" }, { athlete: f, facts, gaps: [], ageBand: null, saveRateRanges });
  const want = [
    { rateType: "ig_post", low: 150, high: 600, currency: "USD", confidence: "low", drivers: ["local audience", "conference title"], factIds: [facts[0].id] },
    { rateType: "booking_video_call_30", low: 25, high: 75, currency: "USD", confidence: "low", drivers: ["fan demand"], factIds: [facts[1].id] },
  ];
  expect(r.rateRanges).toEqual(want);
  expect(r.droppedRanges).toBe(5);
  expect(r.rateRangesSaved).toEqual(["ig_post", "booking_video_call_30"]);
  expect(saved).toEqual([{ id: athleteId, ranges: want, meta: { runId: r.runId } }]);
  expect(((await store.currentBriefInternal(athleteId)) as any).rateRanges).toEqual(want);
  // Never on the Brief shown.
  expect(JSON.stringify(await store.currentBrief(athleteId))).not.toMatch(/rateRanges|ig_post/);

  // With measured (connected-account) facts, the Brief's confidence stands.
  const [m] = await store.insertFacts(athleteId, [{ subject: { kind: "athlete", name: f.name }, claim: "Instagram has 2,400 followers.", type: "measured", source: { ref: "social_analytics_snapshots/s1#instagram.followers" }, date: "2026-10-01", confidence: 1, runId: null }]);
  setResponsesTransport(fakeResponses(() => ({ json: brief({ label: "College junior", band: "developing" }, { rate_ranges: [
    { rate_type: "ig_reel", low: 200, high: 450, currency: "USD", confidence: "medium", drivers: ["measured reach"], refs: [] },
  ] }) })));
  const r2 = await understand({ store, athleteId, parentPrefix: "workflow:u15b" }, { athlete: f, facts: [...facts, m], gaps: [], ageBand: null, saveRateRanges });
  expect(r2.rateRanges[0].confidence).toBe("medium");
});

test("U16: a failed store never fails the Brief; no ranges → nothing stored", async () => {
  const f = FIXTURES.college;
  const { store, facts } = await seed(f);
  const failing = jest.fn(async () => { throw new Error("db down"); });
  setResponsesTransport(fakeResponses(() => ({ json: brief({ label: "College junior", band: "developing" }, { rate_ranges: [
    { rate_type: "ig_post", low: 100, high: 300, currency: "USD", confidence: "low", drivers: ["local audience"], refs: [] },
  ] }) })));
  const r = await understand({ store, athleteId, parentPrefix: "workflow:u16" }, { athlete: f, facts, gaps: [], ageBand: null, saveRateRanges: failing });
  expect(r.brief.id).toBeTruthy();
  expect(r.rateRangesSaved).toBeNull();

  const none = jest.fn(async () => ({ saved: [] }));
  setResponsesTransport(fakeResponses(() => ({ json: brief({ label: "College junior", band: "developing" }, { rate_ranges: [] }) })));
  const r2 = await understand({ store, athleteId, parentPrefix: "workflow:u16b" }, { athlete: f, facts, gaps: [], ageBand: null, saveRateRanges: none });
  expect(none).not.toHaveBeenCalled();
  expect(r2.rateRangesSaved).toEqual([]);
});

test("U17: her deal fees are private — a sentence naming one leaves the thesis, positioning, content pillars and narrative", async () => {
  const f = FIXTURES.college;
  const { store, facts } = await seed(f);
  setResponsesTransport(fakeResponses(() => ({ json: brief({ label: "College junior", band: "developing" }, {
    thesis: { big_idea: "A rising name with a clear story.", verdict: "Marketable locally today. Her last partner paid $1,500 for two Reels." },
    positioning: { from: "A name on a roster", to: "A paid creator at $1.5k a campaign", statement: "Results first.", pillars: [{ name: "Performance", line: "Results", refs: ["f2"] }], refs: ["f1"] },
    content_pillars: [{ key: "P1", name: "Training", why_this_athlete: "The hours. Worth 1500 USD to brands.", refs: ["f1"] }],
    narrative: "You are building something real. A signed deal at $1,500 proves it. Keep going.",
    sections: [{ key: "rate_logic", title: "Rate logic", lines: [{ text: "A signed contract at $1,500 for two Reels is one data point.", kind: "inference", refs: [] }], so_what: "One deal is not a price." }],
  }) })));
  const r = await understand({ store, athleteId, parentPrefix: "workflow:u17" }, { athlete: f, facts, gaps: [], ageBand: null, nomilaDeals: [deal()], saveRateRanges: async () => ({ saved: [] }) });
  const shown = r.brief;
  expect(shown.sections.find((s) => s.key === "thesis")!.lines.map((l) => l.text)).toEqual(["A rising name with a clear story.", "Marketable locally today."]);
  expect(shown.display!.positioning.to).toBe("");
  expect(shown.display!.contentPillars![0].whyThisAthlete).toBe("The hours.");
  expect(shown.summary).toBe("You are building something real. Keep going.");
  // The private rate analysis may use the fee.
  expect(shown.sections.find((s) => s.key === "rate_logic")!.lines[0].text).toContain("$1,500");
  expect(r.feeRedactions).toBe(4);
});

test("fee redaction reads money, not bare numbers", () => {
  expect(moneyAmountsIn("Signed for $1,500 in 2026, then 2k dollars, then 750 USD, and €3.5k.")).toEqual([1500, 2000, 750, 3500]);
  expect(redactFees("Won 1500 meters in 2026. Paid $1500.", [1500])).toEqual({ text: "Won 1500 meters in 2026.", redacted: 1 });
  expect(redactFees("Nothing here.", [])).toEqual({ text: "Nothing here.", redacted: 0 });
  expect(rateRangesFrom([{ rate_type: "licensing", low: 1, high: MAX_RANGE_HIGH + 1, drivers: ["x"] }], () => [], { hasMeasured: true }).kept).toEqual([]);
});

const pref = (kind: Preference["kind"], statement: string, status: Preference["status"] = "active"): Preference => ({
  id: `p-${statement.length}-${kind}`, athleteId, kind, statement, source: "said", status, runId: null, createdAt: "2026-10-01T00:00:00.000Z",
});

test("U18: her saved preferences go in under PREFERENCES (active only, never-use names listed); none → said so", async () => {
  const f = FIXTURES.college;
  const { store, facts } = await seed(f);
  const t = fakeResponses(() => ({ json: brief({ label: "College junior", band: "developing" }) }));
  setResponsesTransport(t);
  await understand({ store, athleteId, parentPrefix: "workflow:u18a" }, { athlete: f, facts, gaps: [], ageBand: null });
  expect(String(t.calls[0].input)).toContain("PREFERENCES (the athlete's own standing directions)\n- (none)\n");

  await understand({ store, athleteId, parentPrefix: "workflow:u18b" }, { athlete: f, facts, gaps: [], ageBand: null, preferences: [
    pref("standing_rule", "Only outdoor and training brands."),
    pref("avoid", "Never use: Example Rival Co, Sample Drinks"),
    pref("style", "A retired style.", "retired"),
  ] });
  const input = String(t.calls[1].input);
  expect(input).toContain("PREFERENCES (the athlete's own standing directions)\n- standing_rule: Only outdoor and training brands.\n- avoid: Never use: Example Rival Co, Sample Drinks\nNever use these names anywhere: Example Rival Co, Sample Drinks\n");
  expect(input).not.toContain("A retired style.");
});

test("U19: a never-use name is never quoted in text she reads — removed from the thesis, stage, sections, pillars, conflicts, drivers and narrative", async () => {
  const f = FIXTURES.college;
  const { store, facts } = await seed(f);
  setResponsesTransport(fakeResponses(() => ({ json: brief({ label: "College junior", band: "developing" }, {
    thesis: { big_idea: "A rising name with a clear story.", verdict: "Marketable locally today. Example Rival Co would be a fit." },
    sections: [
      { key: "commercial_readiness", title: "CR", lines: [{ text: "Results are the strongest asset.", kind: "inference", refs: ["f2"] }, { text: "Example Rival Co sponsors the league.", kind: "fact", refs: ["f3"] }], so_what: "Build on results. Skip example rival co." },
      { key: "risks_upside", title: "Risks", lines: [{ text: "Your wish for outdoor brands only narrows the field.", kind: "inference", refs: [] }], so_what: "Name the trade-off." },
    ],
    content_pillars: [{ key: "P1", name: "Training", why_this_athlete: "The hours.", refs: ["f1"] }, { key: "P2", name: "Sample Drinks days", why_this_athlete: "x", refs: ["f2"] }],
    internal: { current_sponsors: [], past_sponsors: [], exclusivity_conflicts: [{ what: "Example Rival Co holds the category.", blocks: ["drinks"], refs: ["f3"] }] },
    rate_ranges: [{ rate_type: "ig_post", low: 100, high: 300, currency: "USD", confidence: "low", drivers: ["local audience", "Sample Drinks interest"], refs: [] }],
    narrative: "You are building something real. Sample Drinks is not for you. Keep going.",
  }) })));
  const r = await understand({ store, athleteId, parentPrefix: "workflow:u19" }, {
    athlete: f, facts, gaps: [], ageBand: null, preferences: [pref("avoid", "Never use: Example Rival Co, Sample Drinks")], saveRateRanges: async () => ({ saved: [] }),
  });
  const everything = JSON.stringify({ brief: r.brief, internal: await store.currentBriefInternal(athleteId) });
  expect(everything).not.toMatch(/Example Rival Co|Sample Drinks/i);
  expect(r.brief.sections.find((s) => s.key === "commercial_readiness")!.lines.map((l) => l.text)).toEqual(["Results are the strongest asset."]);
  expect(r.brief.sections.find((s) => s.key === "commercial_readiness")!.soWhat).toBe("Build on results.");
  // A preference that narrows the field is named plainly, not hidden.
  expect(r.brief.sections.find((s) => s.key === "risks_upside")!.lines[0].text).toMatch(/outdoor brands only/);
  expect(r.contentPillars.map((p) => p.name)).toEqual(["Training"]);
  expect(r.rateRanges[0].drivers).toEqual(["local audience"]);
  expect(r.brief.summary).toBe("You are building something real. Keep going.");
  expect(r.neverRedactions).toBeGreaterThanOrEqual(7);
});

test("U20: understand 1.14.0 — rates carry forward: a refresh reads CURRENT RATES (the ranges she has); a first Brief never does", async () => {
  const f = FIXTURES.college;
  const { store, facts } = await seed(f);
  const ranges = [{ rate_type: "ig_reel", low: 100, high: 300, currency: "USD", confidence: "low", drivers: ["local reach", "no connected account yet"], refs: ["f1"] }];
  const t = fakeResponses(() => ({ json: brief({ label: "College junior", band: "developing" }, { rate_ranges: ranges }) }));
  setResponsesTransport(t);
  await understand({ store, athleteId, parentPrefix: "workflow:u20a" }, { athlete: f, facts, gaps: [], ageBand: null, saveRateRanges: async () => ({ saved: ["ig_reel"] }) });
  expect(String(t.calls[0].input)).not.toContain("CURRENT RATES");

  // The refresh: the current Brief carried, its ranges read off the internal read.
  const carry = (await store.currentBrief(athleteId))!;
  await understand({ store, athleteId, parentPrefix: "workflow:u20b" }, { athlete: f, facts, gaps: [], ageBand: null, carry, saveRateRanges: async () => ({ saved: ["ig_reel"] }) });
  const input = String(t.calls[1].input);
  expect(input).toMatch(/CURRENT RATES \(the suggested ranges the athlete already has: return each as it stands unless a NEW fact materially changes it\)\n- ig_reel \| 100-300 USD \| confidence low \| drivers: local reach; no connected account yet/);

  // Given explicitly, those are the ones read; none → said so.
  await understand({ store, athleteId, parentPrefix: "workflow:u20c" }, { athlete: f, facts, gaps: [], ageBand: null, carry, currentRates: [], saveRateRanges: async () => ({ saved: [] }) });
  expect(String(t.calls[2].input)).toMatch(/CURRENT RATES \([^\n]*\)\n- \(none yet\)/);
});

test("U21: understand 1.15.0 — WHAT WORKS FOR THIS ATHLETE goes in when a line rests on 3+ posts, leads marked; otherwise left out", async () => {
  const f = FIXTURES.college;
  const { store, facts } = await seed(f);
  const t = fakeResponses(() => ({ json: brief({ label: "College junior", band: "developing" }) }));
  setResponsesTransport(t);
  const ww = (lines: WhatWorks["lines"]): WhatWorks => ({ contract: "what-works/1", athleteId, asOf: "2026-10-10T00:00:00.000Z", timeZone: null, windowDays: 90, leadsAt: 8, minSample: 5, posts: 14, baselines: {}, lines });
  const reel = { dimension: "platform_format" as const, key: "instagram/reel", label: "Instagram reel", n: 10, leads: true, metrics: { save_count: { ratio: 2.06, n: 10 } } };
  const story = { dimension: "platform_format" as const, key: "instagram/story", label: "Instagram story", n: 4, leads: false, metrics: { reach: { ratio: 0.8, n: 4 } } };
  const thin = { dimension: "pillar" as const, key: "family", label: "Family", n: 2, leads: false, metrics: { reach: { ratio: 4, n: 2 } } };
  const run = (k: string, whatWorks: WhatWorks | null | undefined) => understand({ store, athleteId, parentPrefix: `workflow:u21${k}` }, { athlete: f, facts, gaps: [], ageBand: null, whatWorks, saveRateRanges: async () => ({ saved: [] }) });

  await run("a", ww([reel, story, thin]));
  const input = String(t.calls[0].input);
  expect(input).toContain(`WHAT WORKS FOR THIS ATHLETE (the athlete's own posts in the last 90 days, each against their usual on that platform; "leads" = 8 or more posts, else an early sign)\n- Instagram reel | saves 2× the athlete's usual | 10 posts | leads\n- Instagram story | reach 0.8× the athlete's usual | 4 posts | early sign`);
  expect(input).not.toContain("Family");

  // Nothing resting on 3 posts, null (the learning loop off) or absent: no block at all, the input reads as before.
  for (const [k, w] of [["b", ww([thin])], ["c", null], ["d", undefined]] as const) {
    await run(k, w);
    expect(String(t.calls.at(-1)!.input)).not.toContain("WHAT WORKS FOR THIS ATHLETE");
  }
});

test("U22: understand 1.16.0 — PLAYBOOK FORMATS goes in when her playbook recommends formats; otherwise left out", async () => {
  const f = FIXTURES.college;
  const { store, facts } = await seed(f);
  const t = fakeResponses(() => ({ json: brief({ label: "College junior", band: "developing" }) }));
  setResponsesTransport(t);
  const run = (k: string, playbookFormats: Array<{ platform: string; formats: string[] }> | null | undefined) =>
    understand({ store, athleteId, parentPrefix: `workflow:u22${k}` }, { athlete: f, facts, gaps: [], ageBand: null, playbookFormats, saveRateRanges: async () => ({ saved: [] }) });

  await run("a", [{ platform: "instagram", formats: ["carousel", "feed", "reel", "story"] }, { platform: "tiktok", formats: ["reel"] }]);
  expect(String(t.calls[0].input)).toContain("PLAYBOOK FORMATS (what Nomila's playbook recommends the athlete posts, per platform they are on)\n- instagram: carousel, feed, reel, story\n- tiktok: reel");
  for (const [k, pf] of [["b", []], ["c", null], ["d", undefined]] as const) {
    await run(k, pf as any);
    expect(String(t.calls.at(-1)!.input)).not.toContain("PLAYBOOK FORMATS");
  }

  // The format mix (posts a week > 0), the formats it lists (never "other") and stories a week; no playbook → left out.
  const config = (over: Record<string, unknown>) => ({ formats: [], hooks: [], idealLengthSec: { min: 7, max: 30 }, crossPlatformReuse: [], sources: [], refreshedAt: "2026-10-01", cadence: { postsPerWeek: { min: 3, max: 4 } }, ...over }) as any;
  expect(playbookFormatsOf([
    { platform: "instagram", config: config({ cadence: { postsPerWeek: { min: 3, max: 4 }, formatMix: { reel: 2, carousel: 1, feed: 0 }, storiesPerWeek: { min: 3, max: 7 } } }) },
    { platform: "tiktok", config: config({ formats: [{ name: "short vertical", postFormat: "reel", whenToUse: "x" }, { name: "odd", postFormat: "other", whenToUse: "y" }] }) },
    { platform: "youtube", config: null },
  ])).toEqual([{ platform: "instagram", formats: ["carousel", "reel", "story"] }, { platform: "tiktok", formats: ["reel"] }]);
});
