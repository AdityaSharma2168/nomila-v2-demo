/**
 * turn.test.ts — the adaptive onboarding's code-enforced rules (in-memory store, model mocked).
 *
 *   T1 nothing is asked before the reveal: connect / consent / goals / facts review / age band are held back
 *   T2 the reveal and insights rest on real, non-sensitive facts; ids the model invents are dropped
 *   T3 checkpoints advance from what was SHOWN, never from the model's claim; all met → done
 *   T4 corrections become "said" facts (old one superseded), removals are recorded and the fact kept as removed
 *   T5 goals are the plan's recommendations (the model never writes one): accept / edit = keep, and its held actions
 *      follow the goal; an own goal → memory_goals
 *   T16 goals are optional (done without one); the capability tap is a said fact; all "not now" → goal declined
 *   T6 never nag: a declined connection is re-offered at most once, after a gap; a connected one is never offered
 *   T7 the age band is optional and gates nothing; it is asked at most twice
 *   T8 capabilities are entry points from the catalog; no door is closed by age; unknown ids are dropped
 *   T9 a reused turn run returns the same cards without a second model call
 *   T14 onboarding 1.9.0: the rate card shows the Brief's ranges (understand 1.13.0), never numbers of the model's own;
 *       wide and "low" without connected data; held when the Brief has none
 *   T15 strengths and gaps come from the M.I.A. only: the preview's dimension-tagged strengths / gaps are in state on
 *       every ready turn; a strength / gap insight must name a dimension the M.I.A. concluded that way, or it is held
 */
jest.mock("../../db", () => ({ db: {} }));

import { FIXTURES, fakeResponses, type AthleteFixture } from "../../testUtils/agentModel";
import { setResponsesTransport } from "../research/llm";
import { createMemoryStore, type AgentStore } from "../research/store";
import { CAPABILITIES, CONNECTORS, CONSENT_ID } from "./catalog";
import { offerableConnectors, takeTurn, type TurnContext } from "./turn";
import type { MiaPreview } from "../../../shared/agent";

afterEach(() => setResponsesTransport(null));
const athleteId = "00000000-0000-4000-8000-0000000000bb";

const emptyCards = { quick_questions: [], rate_ranges: false, reveal: null, insights: [], fact_review: null, show_recommended_goals: false, connect: [], capabilities: [], consent: false, age_band: false, order: [] };
const answer = (cards: Record<string, unknown>, message = "Hi.", path = "move") => ({ json: { message, cards: { ...emptyCards, ...cards }, checkpoints_addressed: ["reveal", "consent", "goal"], path_note: path } });

async function setup(f: AthleteFixture, connected: string[] = []) {
  const store = createMemoryStore();
  const facts = await store.insertFacts(athleteId, f.pages.filter((p) => p.sensitivity !== "never").map((p) => ({
    subject: { kind: "athlete" as const, name: f.name }, claim: p.claim, type: "found" as const, source: { url: p.url, title: p.title },
    date: null, confidence: 0.9, runId: null, sensitive: p.sensitivity === "care",
  })));
  await store.setCheckpoint(athleteId, "wf1", "name_sport", { status: "done" });
  const ctx: TurnContext = { store, athleteId, scope: "wf1", athlete: { name: f.name, sport: f.sport }, connected };
  return { store, facts, ctx };
}

/** A recommendation as the plan step writes it (a pending decision, kind goal, skill plan). */
async function seedRecommendation(store: AgentStore, factId: string, over: { suggested?: string; valueConfidence?: string } = {}) {
  return store.insertDecision(athleteId, {
    runId: null, skillId: "plan", kind: "goal", suggested: over.suggested ?? "Land a first local partner", why: "Season start.",
    evidence: [{ kind: "fact", factId }],
    detail: { key: "R1", horizon: "now", value: { text: "Small, product plus a modest fee (estimate)", low: null, high: null, currency: null, drivers: [] }, valueConfidence: over.valueConfidence ?? "low", nextDecision: "Pick two local brands", gamePlan: ["Pitch two shops near you."] },
  });
}

const everything = (f: AthleteFixture) => ({
  reveal: { headline: `${f.name}, in brief`, highlights: [{ text: "Highlight one.", refs: ["f1"] }, { text: "Invented.", refs: ["f77"] }] },
  insights: [{ angle: "brand", text: "Results lead.", refs: ["f2"], mia_dimension: null }],
  fact_review: { refs: [] },
  show_recommended_goals: true,
  connect: CONNECTORS.map((c) => ({ connector_id: c.id, why: `Because ${c.service}.` })),
  capabilities: CAPABILITIES.map((c) => ({ capability_id: c.id, pitch: `Pitch ${c.id}` })).concat([{ capability_id: "teleport", pitch: "x" }]),
  consent: true,
  age_band: true,
  order: ["reveal", "insights"],
});

test("T1–T2: before the reveal nothing is asked; highlights rest only on real facts", async () => {
  const f = FIXTURES.college;
  const { ctx, facts, store } = await setup(f);
  await seedRecommendation(store, facts[0].id);
  // The model forgets the reveal but asks for everything: only the insight and capabilities may show.
  setResponsesTransport(fakeResponses(() => answer({ ...everything(f), reveal: null })));
  const t0 = await takeTurn(ctx, { message: null, actions: [], reply: true });
  expect(t0.cards.map((c) => c.kind)).toEqual(["insight", ...CAPABILITIES.map(() => "capability")]);
  expect(t0.held).toEqual(expect.arrayContaining(["facts review: held until the reveal is shown", "connect: held until the reveal is shown", "consent: held until the reveal is shown", "age band: held until the reveal is shown", "goal proposal: held until the reveal is shown"]));
  expect(t0.checkpoints.reveal.status).toBe("pending");

  // Next turn: the reveal comes; asks are allowed in the same turn, after it.
  setResponsesTransport(fakeResponses(() => answer(everything(f))));
  const t1 = await takeTurn(ctx, { message: "show me", actions: [], reply: true });
  expect(t1.cards[0].kind).toBe("reveal");
  const reveal = t1.cards[0].payload as any;
  expect(reveal.highlights).toHaveLength(1);                              // the invented ref is dropped
  expect(reveal.highlights[0].factIds).toEqual([facts[0].id]);
  expect(reveal.highlights[0].sources).toEqual([{ label: f.pages[0].title, url: f.pages[0].url }]);
  expect(t1.cards.map((c) => c.kind)).toEqual(expect.arrayContaining(["fact-review", "goal-proposal", "connect", "consent", "age-band"]));
  expect(t1.cards.every((c) => c.runId === t1.runId)).toBe(true);
  const reviewed = (t1.cards.find((c) => c.kind === "fact-review")!.payload as any).facts;
  expect(reviewed.length).toBeGreaterThan(0);
  for (const rf of reviewed) expect(rf.sensitivity).toBe(facts.find((x) => x.id === rf.factId)?.sensitive ? "care" : "none");
  expect(t1.cards.find((c) => c.kind === "insight")!.links).toEqual([{ label: "How I got this", target: { screen: "how-i-got-this", id: t1.runId } }]);
});

test("T2: care facts reach the model marked (care) but never the reveal; never-store facts do not exist", async () => {
  const f = FIXTURES.youth;                     // page 3 (a minor sibling) is never stored
  const { ctx, store } = await setup(f);
  const [care] = await store.insertFacts(athleteId, [{ subject: { kind: "athlete", name: f.name }, claim: `${f.name} missed the 2025 playoffs with a knee injury.`, type: "found", source: { url: "https://www.example-local-news.com/sports/vale-injury" }, date: "2025-10-01", confidence: 0.9, runId: null, sensitive: true }]);
  const t = fakeResponses(() => answer({ reveal: { headline: "h", highlights: [{ text: "Injury story.", refs: ["f3"] }, { text: "Team.", refs: ["f1"] }], standing: { text: "Coming back.", refs: ["f3"] }, windows: [] } }));
  setResponsesTransport(t);
  const r = await takeTurn(ctx, { message: null, actions: [], reply: true });
  expect(String(t.calls[0].input)).not.toContain("younger sibling");
  expect(String(t.calls[0].input)).toContain(`f3 | found (care) | ${care.claim}`);
  const reveal = r.cards.find((c) => c.kind === "reveal")!.payload as any;
  expect(reveal.highlights.map((h: any) => h.text)).toEqual(["Team."]);     // the care fact never leads
  expect(reveal.standing).toBeNull();
});

test("T3–T5–T8: checkpoints advance from what was shown; actions finish them; all met → done", async () => {
  const f = FIXTURES.pro;
  const { ctx, store, facts } = await setup(f);
  const rec = await seedRecommendation(store, facts[0].id);
  // A held action for the recommendation: it follows the goal when the athlete keeps it.
  const held = await store.insertDecision(athleteId, { runId: null, skillId: "plan", kind: "action", suggested: "Pitch a local shop", why: "w", evidence: [], parentDecisionId: rec.id, detail: { kind: "pitch", what: "Pitch a local shop", button: "send", dueOn: null, event: null, state: "to_start" } });
  const t = fakeResponses(() => answer(everything(f)));
  setResponsesTransport(t);
  const t0 = await takeTurn(ctx, { message: null, actions: [], reply: true });
  // The model sees the plan's recommendations, never writes its own.
  expect(stateIn(t.calls[0].input).plan).toMatchObject({ status: "not ready yet", recommended_goals: [{ goal: "Land a first local partner", horizon: "now", shown: false }] });
  expect(t0.checkpoints).toMatchObject({
    reveal: { status: "done" }, facts_review: { status: "done" }, capabilities: { status: "done" }, consent: { status: "offered" }, goal: { status: "offered" },
    connect_offers: { status: "done" },
  });
  expect(t0.done).toBe(false);
  // Capabilities: every catalog entry (no door closed by age), unknown ids dropped, each an entry point.
  const caps = t0.cards.filter((c) => c.kind === "capability").map((c) => (c.payload as any).capability);
  expect(caps.map((c: any) => c.id)).toEqual(CAPABILITIES.map((c) => c.id));
  expect(t0.held).toContain("capability: teleport not offered");

  const proposal = t0.cards.find((c) => c.kind === "goal-proposal")!.payload as any;
  expect(proposal).toMatchObject({ decisionId: rec.id, goal: "Land a first local partner", horizon: "now", value: expect.stringContaining("estimate"), nextDecision: "Pick two local brands", factIds: [facts[0].id] });

  // The athlete answers with taps only (no model call): consent, an edited goal, an own goal, a correction, a removal.
  setResponsesTransport(fakeResponses(() => { throw new Error("no model call expected"); }));
  const t1 = await takeTurn(ctx, { message: null, reply: false, actions: [
    { type: "consent", consentId: CONSENT_ID, response: "agree" },
    { type: "goal", decisionId: proposal.decisionId, response: "edit", text: "Land two local partners" },
    { type: "goal_add", text: "Grow my audience off the court" },
    { type: "fact_review", factId: facts[1].id, action: "correct", correction: "The footwear deal was signed in 2023." },
    { type: "fact_review", factId: facts[2].id, action: "remove", note: "not me" },
  ] });
  expect(t1.runId).toBeNull();
  expect(t1.errors).toEqual([]);
  expect(t1.done).toBe(true);

  const goals = await store.listGoals(athleteId);
  expect(goals.map((g) => [g.text, g.source, g.status])).toEqual([["Land two local partners", "proposed_accepted", "active"], ["Grow my audience off the court", "said", "active"]]);
  expect(goals[0]).toMatchObject({ horizon: "now", gamePlan: "Pitch two shops near you.", gamePlanBy: "mila", decisionId: rec.id });
  const decision = (await store.getDecision(athleteId, proposal.decisionId))!;
  expect(decision.response).toBe("edited");
  expect(decision.goalId).toBe(goals[0].id);                                   // the recommendation points at the goal it became
  expect((await store.getDecision(athleteId, held.id))!.goalId).toBe(goals[0].id);   // its held action follows the goal
  const after = new Map((await store.listFacts(athleteId)).map((x) => [x.id, x]));
  expect(after.get(facts[1].id)!.status).toBe("superseded");
  const said = after.get(after.get(facts[1].id)!.supersededBy!)!;
  expect(said).toMatchObject({ type: "said", claim: "The footwear deal was signed in 2023.", confidence: 1 });
  expect(after.get(facts[2].id)!.status).toBe("removed");                      // kept, never used again
  expect((store as any).dump().reviews.map((r: any) => r.action)).toEqual(["correct", "remove"]);
});

test("T4: a correction needs the athlete's words; another athlete's fact is not found", async () => {
  const f = FIXTURES.college;
  const { ctx, store } = await setup(f);
  const [other] = await store.insertFacts("00000000-0000-4000-8000-0000000000cc", [{ subject: { kind: "athlete", name: "Someone Else" }, claim: "x", type: "found", source: { url: "https://e.example" }, date: null, confidence: 1, runId: null }]);
  const facts = await store.listFacts(athleteId);
  const r = await takeTurn(ctx, { message: null, reply: false, actions: [
    { type: "fact_review", factId: facts[0].id, action: "correct", correction: "   " },
    { type: "fact_review", factId: other.id, action: "remove" },
  ] });
  expect(r.errors).toEqual(["a correction needs the athlete's words", `fact ${other.id} not found`]);
  expect((await store.getFacts("00000000-0000-4000-8000-0000000000cc", [other.id]))[0].status).toBe("active");
});

test("T6: never nag — a declined connection waits, is re-offered once, then never; connected ones are never offered", async () => {
  const f = FIXTURES.pro;
  const { ctx, store } = await setup(f, ["gmail"]);
  const ask = (ids: string[]) => setResponsesTransport(fakeResponses(() => answer({ reveal: { headline: "h", highlights: [{ text: "x", refs: ["f1"] }] }, connect: ids.map((id) => ({ connector_id: id, why: "better reason" })) })));
  ask(["instagram", "gmail"]);
  const t0 = await takeTurn(ctx, { message: null, actions: [], reply: true });
  expect(t0.cards.filter((c) => c.kind === "connect").map((c) => (c.payload as any).connectorId)).toEqual(["instagram"]);
  expect(t0.held).toContain("connect: gmail not offerable now");

  ask(["instagram"]);
  const t1 = await takeTurn(ctx, { message: "not now", actions: [{ type: "connect", connectorId: "instagram", response: "declined" }], reply: true });
  expect(t1.cards.some((c) => c.kind === "connect")).toBe(false);              // too soon after the last offer
  ask(["instagram"]);
  const t2 = await takeTurn(ctx, { message: "ok", actions: [], reply: true });
  expect(t2.cards.filter((c) => c.kind === "connect")).toHaveLength(1);         // one re-offer, with a better reason
  await takeTurn(ctx, { message: null, actions: [{ type: "connect", connectorId: "instagram", response: "declined" }], reply: false });
  for (let i = 0; i < 3; i++) {
    ask(["instagram"]);
    const t = await takeTurn(ctx, { message: "hm", actions: [], reply: true });
    expect(t.cards.some((c) => c.kind === "connect")).toBe(false);              // declined twice → never again
  }
  const cp = await store.getCheckpoints(athleteId, "wf1");
  expect(offerableConnectors(cp, ["gmail"], 99)).not.toContain("instagram");
  const offers = (await store.listDecisions(athleteId, { skillId: "onboarding" })).filter((d) => d.suggested === "Connect instagram");
  expect(offers.map((d) => d.response)).toEqual(["skipped", "skipped"]);
});

test("T7: the age band is optional, gates nothing, and is asked at most twice", async () => {
  const f = FIXTURES.youth;
  const { ctx, store } = await setup(f);
  const turnWith = (cards: Record<string, unknown>) => setResponsesTransport(fakeResponses(() => answer({ reveal: { headline: "h", highlights: [{ text: "x", refs: ["f1"] }] }, ...cards })));
  // Connect and consent show without any age band.
  turnWith({ connect: [{ connector_id: "instagram", why: "audience" }], consent: true, age_band: true });
  const t0 = await takeTurn(ctx, { message: null, actions: [], reply: true });
  expect(t0.cards.map((c) => c.kind)).toEqual(expect.arrayContaining(["connect", "consent", "age-band"]));
  expect(t0.checkpoints).not.toHaveProperty("age_band");
  turnWith({ age_band: true });
  expect((await takeTurn(ctx, { message: "?", actions: [], reply: true })).cards.some((c) => c.kind === "age-band")).toBe(true);
  turnWith({ age_band: true });
  expect((await takeTurn(ctx, { message: "?", actions: [], reply: true })).cards.some((c) => c.kind === "age-band")).toBe(false);
  // Answering it is a "said" fact; nothing changes in what is offered.
  await takeTurn(ctx, { message: null, actions: [{ type: "age_band", value: "under_18" }], reply: false });
  const said = (await store.listFacts(athleteId)).find((x) => x.source.ref?.endsWith("#age_band"))!;
  expect(said).toMatchObject({ type: "said", claim: `${f.name} is under 18.` });
  turnWith({ capabilities: CAPABILITIES.map((c) => ({ capability_id: c.id, pitch: "p" })) });
  const t3 = await takeTurn(ctx, { message: "what can you do", actions: [], reply: true });
  expect(t3.cards.filter((c) => c.kind === "capability").map((c) => (c.payload as any).capability.id)).toEqual(CAPABILITIES.map((c) => c.id));
});

test("T9: a reused turn run returns the same turn without a second model call", async () => {
  const f = FIXTURES.college;
  const { ctx, store } = await setup(f);
  const t = fakeResponses(() => answer({ reveal: { headline: "h", highlights: [{ text: "x", refs: ["f1"] }] } }));
  setResponsesTransport(t);
  const first = await takeTurn(ctx, { message: null, actions: [], reply: true });
  // Simulate a crash after the model call: the run is finished, then the same turn number is taken again.
  const runs = await store.listRunsByPrefix(athleteId, "workflow:wf1:turn:");
  expect(runs).toHaveLength(1);
  const again = await takeTurnAtSameNumber(store, ctx);
  expect(again.cards.map((c) => c.id)).toEqual(first.cards.map((c) => c.id));
  expect(t.calls).toHaveLength(1);
});

/** Re-run turn 0: hide the finished run from the turn count so the same parent ref is used again. */
async function takeTurnAtSameNumber(store: AgentStore, ctx: TurnContext) {
  const shadow: AgentStore = { ...store, listRunsByPrefix: async () => [] };
  return takeTurn({ ...ctx, store: shadow }, { message: null, actions: [], reply: true });
}

test("T10: the opening turn works from merged facts alone; the turn after the Brief sees its stage", async () => {
  const f = FIXTURES.college;
  const { ctx, store } = await setup(f);
  const t = fakeResponses(() => answer({ reveal: { headline: "h", highlights: [{ text: "x", refs: ["f1"] }] } }));
  setResponsesTransport(t);
  await takeTurn(ctx, { message: null, actions: [], reply: true, event: "Research is done. The Brief is still being written." });
  expect(String(t.calls[0].input)).toContain("BRIEF\n(no brief yet)");
  expect(String(t.calls[0].input)).toContain("EVENT: Research is done.");
  await store.writeBrief(athleteId, { summary: "S", runId: null, factIds: [], internal: { currentSponsors: [], pastSponsors: [] },
    sections: [{ key: "stage", title: "Career stage", text: "College junior", factIds: [], lines: [{ text: "College junior — roster.", kind: "inference", factIds: [] }] }] });
  await takeTurn(ctx, { message: null, actions: [], reply: true, turnKey: "insights", event: "The Brief is ready." });
  expect(String(t.calls[1].input)).toContain("## Career stage\n- College junior — roster.");
  expect(String(t.calls[1].input)).not.toContain("(no brief yet)");
});

test("T11: onboarding sees the Brief's rate logic (for early ranges) but never the internal read", async () => {
  const f = FIXTURES.pro;
  const { ctx, store } = await setup(f);
  await store.writeBrief(athleteId, { summary: "S", runId: null, factIds: [], internal: { currentSponsors: [], pastSponsors: [{ name: "INTERNAL PAST SPONSOR", factIds: [] }] },
    sections: [
      { key: "brand_now_next", title: "Brand", text: "b", factIds: [], lines: [{ text: "Brand line.", kind: "inference", factIds: [] }] },
      { key: "rate_logic", title: "Rate logic", text: "r", factIds: [], lines: [{ text: "RATE LINE about fees.", kind: "inference", factIds: [] }] },
    ] });
  const t = fakeResponses(() => answer({ reveal: { headline: "h", highlights: [{ text: "x", refs: ["f1"] }] } }));
  setResponsesTransport(t);
  await takeTurn(ctx, { message: null, actions: [], reply: true });
  const input = String(t.calls[0].input);
  expect(input).toContain("Brand line.");
  expect(input).toContain("RATE LINE about fees.");
  expect(input).not.toContain("INTERNAL PAST SPONSOR");
});

test("T12: while research runs only Mila's message and quick questions show; the reveal waits", async () => {
  const f = FIXTURES.college;
  const { ctx } = await setup(f);
  const t = fakeResponses(() => answer({
    quick_questions: [{ question: "Are you thinking about life after college sport yet?", options: ["Not yet", "A little", "Yes"], why: "It changes what I look for." }],
    reveal: { headline: "h", highlights: [{ text: "x", refs: ["f1"] }], standing: null, windows: [] },
    insights: [{ angle: "brand", text: "i", refs: ["f1"] }],
    capabilities: [{ capability_id: "deals", pitch: "p" }],
    rate_ranges: true,
  }, "I'm reading about your season now."));
  setResponsesTransport(t);
  const r = await takeTurn(ctx, { message: "hi", actions: [], reply: true, phase: "waiting" });
  expect(r.message).toBe("I'm reading about your season now.");
  expect(r.cards.map((c) => c.kind)).toEqual(["quick-question"]);
  expect((r.cards[0].payload as any).options).toEqual(["Not yet", "A little", "Yes"]);
  expect(r.held).toEqual(expect.arrayContaining(["reveal: held while research runs", "insight: held while research runs", "rate ranges: held while research runs"]));
  expect(r.checkpoints.reveal.status).toBe("pending");
  expect(String(t.calls[0].input)).toContain('"phase": "waiting (research is running)"');
});

/** The real MiaPreview shape (shared/agent.ts), as services/miaPreview serves it. */
function previewFixture(score: number): MiaPreview {
  const dims = (keys: [string, string]) => keys.map((key) => ({ key, score: 60, weight: 0.125, contribution: 7.5, state: "neutral" }));
  return {
    contract: "mia-preview/1", athleteId, status: "ready", score, scale: { min: 0, max: 850 },
    groups: [
      { key: "audience", name: "Audience", contribution: 15, score: 60, dimensions: dims(["audience_scale", "engagement_quality"]) },
      { key: "commercial", name: "Commercial", contribution: 15, score: 60, dimensions: dims(["commercial_proof", "brand_fit"]) },
      { key: "brand", name: "Brand", contribution: 15, score: 60, dimensions: dims(["narrative_power", "cultural_relevance"]) },
      { key: "performance", name: "Performance", contribution: 15, score: 60, dimensions: dims(["athletic_authority", "momentum"]) },
    ],
    assessment: null, preliminary: true, label: "Preliminary — connect to sharpen",
    confidence: { level: "MEDIUM", explanation: "Public evidence only." }, inputs: { public: [], measured: [] },
    sharpen: [{ kind: "connect", connector: "tiktok", service: "TikTok", reason: "measured_audience" }],
    evidenceAsOf: "2026-10-09T00:00:00.000Z", identity: { uncertain: false, factIds: [] }, provenance: null,
  };
}

test("T13: the reveal moment — the M.I.A. preview first (preliminary), then the headline idea, highlights, standing and windows", async () => {
  const { setMiaPreviewProvider } = await import("./miaPreview");
  const f = FIXTURES.pro;
  const { ctx, facts } = await setup(f);
  setMiaPreviewProvider(async () => previewFixture(611));
  try {
    const t = fakeResponses(() => answer({ reveal: {
      headline: "An all-star guard with a footwear partner already in place.",
      highlights: [{ text: "All-star in 2026.", refs: ["f3"] }, { text: "Multi-year footwear deal.", refs: ["f2"] }, { text: "Starting guard.", refs: ["f1"] }],
      standing: { text: "Established pro, rising.", refs: ["f1", "f3"] },
      windows: [{ text: "All-star weekend returns in February.", refs: ["f3"] }, { text: "No source.", refs: [] }],
    } }));
    setResponsesTransport(t);
    const r = await takeTurn(ctx, { message: null, actions: [], reply: true, turnKey: "opening" });
    expect(r.cards.slice(0, 2).map((c) => c.kind)).toEqual(["mia-preview", "reveal"]);
    expect((r.cards[0].payload as any).preview).toMatchObject({ score: 611, scale: { min: 0, max: 850 }, preliminary: true, label: "Preliminary — connect to sharpen" });
    expect((r.cards[0].payload as any).preview.sharpen[0]).toMatchObject({ kind: "connect", connector: "tiktok" });
    expect((r.cards[0].payload as any).note).toMatch(/Preliminary/);
    const reveal = r.cards[1].payload as any;
    expect(reveal.highlights).toHaveLength(3);
    expect(reveal.standing).toMatchObject({ text: "Established pro, rising.", factIds: [facts[0].id, facts[2].id] });
    expect(reveal.windows.map((w: any) => w.text)).toEqual(["All-star weekend returns in February."]);   // the unsourced window is dropped
    expect(String(t.calls[0].input)).toContain('"score": 611');
    expect(String(t.calls[0].input)).toContain('"preliminary": true');
  } finally {
    setMiaPreviewProvider(null);
  }
});

test("T13b: the preview never blocks the reveal — not ready ⇒ the reveal goes alone; ready later ⇒ shown once, in the next turn", async () => {
  const { setMiaPreviewProvider } = await import("./miaPreview");
  const f = FIXTURES.pro;
  const { ctx, store } = await setup(f);
  let ready = false;
  setMiaPreviewProvider(async () => (ready ? previewFixture(512) : null));
  try {
    setResponsesTransport(fakeResponses(() => answer({ reveal: { headline: "A headline.", highlights: [{ text: "Starting guard.", refs: ["f1"] }] } })));
    const first = await takeTurn(ctx, { message: null, actions: [], reply: true, turnKey: "opening" });
    expect(first.cards.map((c) => c.kind)).toEqual(["reveal"]);
    const offers = (await store.getCheckpoints(athleteId, "wf1")).reveal.offers;

    ready = true;
    setResponsesTransport(fakeResponses(() => answer({})));
    const second = await takeTurn(ctx, { message: null, actions: [], reply: true, turnKey: "insights" });
    expect(second.cards.map((c) => c.kind)).toEqual(["mia-preview"]);
    expect((second.cards[0].payload as any).preview).toMatchObject({ score: 512, preliminary: true });
    expect((await store.getCheckpoints(athleteId, "wf1")).reveal.offers).toBe(offers);   // the late card is not a second reveal

    setResponsesTransport(fakeResponses(() => answer({})));
    const third = await takeTurn(ctx, { message: "ok", actions: [], reply: true });
    expect(third.cards.some((c) => c.kind === "mia-preview")).toBe(false);              // shown once
  } finally {
    setMiaPreviewProvider(null);
  }
});

/** A preview whose read concluded audience_scale a strength, momentum a gap and brand_fit unknown. */
function previewWithRead(): MiaPreview {
  const p = previewFixture(560);
  const state: Record<string, "strength" | "gap" | "unknown"> = { audience_scale: "strength", momentum: "gap", brand_fit: "unknown" };
  const dimension = (key: string) => ({
    key, state: state[key] ?? ("neutral" as const), score: state[key] === "unknown" ? null : 60, confidence: "MEDIUM" as const, confidenceReason: null,
    rationale: key === "brand_fit" ? null : `Rationale for ${key}.`,
    components: key === "brand_fit" ? [{ key: "category_alignment", evidenceClass: "MISSING" as const, confidence: null, rationale: null, sources: [] }] : [],
    sources: { grounded: [], site_only: [], nomila_supplied: [], not_support: [], unrecorded: [] }, weight: 0.125, contribution: 7.5, signals: [],
  });
  return {
    ...p,
    assessment: {
      entryId: "e1", evidenceAsOf: "2026-10-09T00:00:00.000Z", createdAt: "2026-10-09T00:00:00.000Z", versions: { methodology: null, evaluator: null, params: null },
      score: 560, readState: "assessed", overall: { level: "MEDIUM", explanation: null }, confidenceBand: null, summary: null, hasReasons: true,
      dimensions: p.groups.flatMap((g) => g.dimensions.map((d) => dimension(d.key))), evidence: [],
      notes: { strengths: ["An overall strength."], constraints: ["An overall constraint."], missingEvidence: ["Audience demographics."], evaluationRisks: [] },
    },
  };
}

const stateIn = (input: unknown) => JSON.parse(/STATE\n([\s\S]*?)\n\nCONVERSATION SO FAR/.exec(String(input))![1]);

test("T15: strengths and gaps come from the M.I.A. only — tagged by dimension in state; an untagged strength / gap insight is held", async () => {
  const { setMiaPreviewProvider } = await import("./miaPreview");
  const f = FIXTURES.pro;
  const { ctx } = await setup(f);
  await ctx.store.setCheckpoint(athleteId, "wf1", "reveal", { status: "done" });
  // No M.I.A. read yet: a strength insight cannot be written from anything else.
  setResponsesTransport(fakeResponses(() => answer({ insights: [{ angle: "strength", text: "A strength.", refs: ["f1"], mia_dimension: "audience_scale" }] })));
  const none = await takeTurn(ctx, { message: null, actions: [], reply: true });
  expect(none.cards.some((c) => c.kind === "insight")).toBe(false);
  expect(none.held).toContain("strength insight not from an M.I.A. dimension");

  setMiaPreviewProvider(async () => previewWithRead());
  try {
    const t = fakeResponses(() => answer({ insights: [
      { angle: "strength", text: "Audience is the asset.", refs: ["f1"], mia_dimension: "audience_scale" },
      { angle: "strength", text: "Momentum is a strength.", refs: ["f1"], mia_dimension: "momentum" },    // the M.I.A. says gap
      { angle: "gap", text: "Momentum is the opening.", refs: ["f1"], mia_dimension: "momentum" },
      { angle: "gap", text: "Brand fit is unproven.", refs: ["f1"], mia_dimension: "brand_fit" },          // missing data
      { angle: "strength", text: "Untagged strength.", refs: ["f1"], mia_dimension: null },
      { angle: "timing", text: "Timing.", refs: ["f1"], mia_dimension: "audience_scale" },
    ] }));
    setResponsesTransport(t);
    const r = await takeTurn(ctx, { message: null, actions: [], reply: true, turnKey: "insights", event: "The Brief is ready." });
    expect(stateIn(t.calls[0].input).mia_preview).toMatchObject({
      shown: false,
      key_strengths: [{ dimension: "audience_scale", group: "audience", text: "Rationale for audience_scale." }],
      key_constraints: [{ dimension: "momentum", group: "performance", text: "Rationale for momentum." }],
      important_missing_data: [{ dimension: "brand_fit", group: "commercial", text: "Missing: category alignment." }],
      evaluator_notes: { key_strengths: ["An overall strength."], key_constraints: ["An overall constraint."], important_missing_data: ["Audience demographics."] },
    });
    const insights = r.cards.filter((c) => c.kind === "insight").map((c) => c.payload as any);
    expect(insights.map((i) => [i.angle, i.miaDimension])).toEqual([["strength", "audience_scale"], ["gap", "momentum"], ["gap", "brand_fit"], ["timing", null]]);
    expect(r.held.filter((h) => h.endsWith("not from an M.I.A. dimension"))).toHaveLength(2);

    // After the preview card is on screen, its strengths and gaps are still in state.
    const t2 = fakeResponses(() => answer({}));
    setResponsesTransport(t2);
    await takeTurn(ctx, { message: "ok", actions: [], reply: true });
    expect(stateIn(t2.calls[0].input).mia_preview).toMatchObject({ shown: true, key_strengths: [{ dimension: "audience_scale" }] });
  } finally {
    setMiaPreviewProvider(null);
  }
});

test("T14: the rate card shows the Brief's ranges — wide and low confidence without connected data, they sharpen when you connect; goal money carries a confidence", async () => {
  const f = FIXTURES.youth;
  const { ctx, store, facts } = await setup(f);
  await store.setCheckpoint(athleteId, "wf1", "reveal", { status: "done" });
  await seedRecommendation(store, facts[0].id, { valueConfidence: "high" });

  // No Brief ranges yet: the card is held, whatever the model asks.
  setResponsesTransport(fakeResponses(() => answer({ rate_ranges: true })));
  const r0 = await takeTurn(ctx, { message: "what could I charge?", actions: [], reply: true });
  expect(r0.cards.find((c) => c.kind === "rate-ranges")).toBeUndefined();
  expect(r0.held).toContain("rate ranges: the Brief has none yet");

  // The Brief's ranges (understand 1.13.0) are on its internal read: the card shows them, deal work before bookings.
  await store.writeBrief(athleteId, { summary: "S", runId: null, factIds: [], sections: [], internal: { currentSponsors: [], pastSponsors: [], rateRanges: [
    { rateType: "booking_video_call_30", low: 25, high: 75, currency: "USD", confidence: "high", drivers: ["fan demand"], factIds: [] },
    { rateType: "ig_post", low: 50, high: 400, currency: "USD", confidence: "high", drivers: ["local following", "school season"], factIds: [facts[0].id, "not-a-fact"] },
  ] } });
  const t = fakeResponses(() => answer({ rate_ranges: true, show_recommended_goals: true }));
  setResponsesTransport(t);
  const r = await takeTurn(ctx, { message: "what could I charge?", actions: [], reply: true });
  expect(String(t.calls[0].input)).toContain(`"rate_ranges": "ready (the Brief's)"`);
  const rates = r.cards.find((c) => c.kind === "rate-ranges")!.payload as any;
  expect(rates.items).toEqual([
    { deliverable: "Instagram feed post", low: 50, high: 400, currency: "USD", drivers: ["local following", "school season"] },
    { deliverable: "Video call · 30 min (suggested public price)", low: 25, high: 75, currency: "USD", drivers: ["fan demand"] },
  ]);
  expect(rates.factIds).toEqual([facts[0].id]);
  expect(rates).toMatchObject({ confidence: "low", sharpenWithConnect: true });     // the Brief said "high"; no connected data → low
  expect(rates.sharpenConnectors).toEqual(CONNECTORS.filter((c) => c.kind === "social" && !ctx.connected.includes(c.id)).map((c) => c.id));
  expect(rates.note).toMatch(/sharpen when you connect/);
  expect((r.cards.find((c) => c.kind === "goal-proposal")!.payload as any).valueConfidence).toBe("low");

  // With connected (measured) data, the model's confidence stands.
  await store.insertFacts(athleteId, [{ subject: { kind: "athlete", name: f.name }, claim: "Instagram has 2,400 followers.", type: "measured", source: { ref: "social_analytics_snapshots/s1#instagram.followers" }, date: "2026-10-01", confidence: 1, runId: null }]);
  await store.writeBrief(athleteId, { summary: "S", runId: null, factIds: [], sections: [], internal: { currentSponsors: [], pastSponsors: [], rateRanges: [
    { rateType: "ig_post", low: 120, high: 300, currency: "USD", confidence: "medium", drivers: ["measured reach"], factIds: [] },
    { rateType: "ig_reel", low: 200, high: 450, currency: "USD", confidence: "high", drivers: ["measured views"], factIds: [] },
  ] } });
  setResponsesTransport(fakeResponses(() => answer({ rate_ranges: true })));
  const r2 = await takeTurn(ctx, { message: "and now?", actions: [], reply: true });
  // The card carries the least certain of its ranges.
  expect((r2.cards.find((c) => c.kind === "rate-ranges")!.payload as any)).toMatchObject({ confidence: "medium", sharpenWithConnect: false, sharpenConnectors: [] });
});

test("T16: goals are optional — onboarding is done without one; the capability tap is a said fact; 'not now' on every recommendation declines the goal checkpoint", async () => {
  const f = FIXTURES.college;
  const { ctx, store, facts } = await setup(f);
  const rec = await seedRecommendation(store, facts[0].id);
  for (const cp of ["reveal", "facts_review", "connect_offers", "capabilities"] as const) await store.setCheckpoint(athleteId, "wf1", cp, { status: "done" });
  setResponsesTransport(fakeResponses(() => { throw new Error("no model call expected"); }));
  const r = await takeTurn(ctx, { message: null, reply: false, actions: [
    { type: "capability", capabilityId: "deals" },
    { type: "capability", capabilityId: "deals" },
    { type: "capability", capabilityId: "teleport" },
    { type: "goal", decisionId: rec.id, response: "skip", reason: "not this season" },
    { type: "consent", consentId: CONSENT_ID, response: "agree" },
  ] });
  expect(r.errors).toEqual(["unknown capability teleport"]);
  expect(r.done).toBe(true);                                                   // no goal held, and onboarding is done
  expect(r.checkpoints.goal.status).toBe("declined");
  expect(await store.listGoals(athleteId)).toEqual([]);
  expect((await store.getDecision(athleteId, rec.id))!).toMatchObject({ response: "skipped", responseReason: "not this season" });
  // Where the athlete wants to start: one said fact, whatever the number of taps.
  const intent = (await store.listFacts(athleteId)).filter((x) => (x.source.ref ?? "").includes("#capability:"));
  expect(intent.map((x) => [x.type, x.source.ref, x.claim])).toEqual([["said", "onboarding/wf1#capability:deals", `${f.name} chose where to start: "${CAPABILITIES[0].label}".`]]);
});

test("T17: ONBOARDING_STATE_AFTER_CONVERSATION moves STATE after the conversation; every section is byte-identical; the prefix holds across turns", async () => {
  const f = FIXTURES.pro;
  const inputsFor = async (flag: boolean) => {
    if (flag) process.env.ONBOARDING_STATE_AFTER_CONVERSATION = "true"; else delete process.env.ONBOARDING_STATE_AFTER_CONVERSATION;
    const { ctx } = await setup(f);
    const seen: string[] = [];
    setResponsesTransport(fakeResponses((body) => { seen.push(String(body.input)); return answer({}, "Hello there."); }));
    await takeTurn(ctx, { message: null, actions: [], reply: true, turnKey: "opening", event: "Research is done." });
    await takeTurn(ctx, { message: "What next?", actions: [], reply: true });
    return seen;
  };
  try {
    const off = await inputsFor(false);
    const on = await inputsFor(true);
    const sections = (s: string) => s.split(/\n(?=(?:STATE|CONVERSATION SO FAR|NOW)\n)/);
    for (const [o, n] of off.map((x, i) => [x, on[i]] as const)) {
      // Default (off): the order is the legacy one — FACTS, BRIEF, STATE, CONVERSATION, NOW.
      expect(o.indexOf("\nSTATE\n")).toBeLessThan(o.indexOf("\nCONVERSATION SO FAR\n"));
      // On: CONVERSATION before STATE, then NOW; the same sections, byte for byte, only reordered.
      expect(n.indexOf("\nCONVERSATION SO FAR\n")).toBeLessThan(n.indexOf("\nSTATE\n"));
      expect(n.indexOf("\nSTATE\n")).toBeLessThan(n.indexOf("\nNOW\n"));
      expect([...sections(n)].sort()).toEqual([...sections(o)].sort());
      expect(stateIn(o)).toBeTruthy();
    }
    // The point: with STATE last, turn 1's input up to STATE is a prefix of turn 2's (FACTS, BRIEF and the conversation
    // so far only grow); with STATE first, the prefix breaks at STATE (the turn number changes on every turn).
    const upToState = (s: string) => s.slice(0, s.indexOf("\nSTATE\n"));
    const historyStart = (s: string) => s.slice(0, s.indexOf("\nCONVERSATION SO FAR\n") + "\nCONVERSATION SO FAR\n".length);
    expect(on[1].startsWith(historyStart(on[0]))).toBe(true);
    expect(on[1].length).toBeGreaterThan(upToState(on[0]).length);
    expect(off[1].startsWith(upToState(off[0]))).toBe(true);
    expect(off[1].startsWith(off[0].slice(0, off[0].indexOf("\nCONVERSATION SO FAR\n")))).toBe(false);
  } finally {
    delete process.env.ONBOARDING_STATE_AFTER_CONVERSATION;
  }
});
