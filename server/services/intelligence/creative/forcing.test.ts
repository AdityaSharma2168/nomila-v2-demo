/**
 * creative/forcing.test.ts — the six offline forcing cases of campaign-creative-seam-checkpoint.md §18, plus the
 * pressure tests on the contract. No provider, no DB, no Studio mutation. Synthetic athlete; recorded #649/#652
 * artifacts are read only where the case says so.
 */
import { describe, expect, it } from "@jest/globals";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Commission } from "../planner/creativeBoundary";
import { NOT_INTENT_FIELDS, intentKey, type CreativeIntent } from "./contract";
import { deriveIntentState, fulfilmentOf, intentFromAthleteAsk, intentFromCommission, intentsFromCampaignSpec, type Downstream, type SpecDeliverable, type SpecForIntents } from "./intents";
import { briefInputFrom, type ConfirmedInterpretation } from "./toBriefInput";

const now = "2026-09-27T12:00:00Z";
const keysDeep = (x: unknown, acc: string[] = []): string[] => { if (Array.isArray(x)) x.forEach((v) => keysDeep(v, acc)); else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) { acc.push(k); keysDeep(v, acc); } return acc; };
const noSolution = (i: CreativeIntent) => { for (const f of NOT_INTENT_FIELDS) expect(keysDeep(i)).not.toContain(f); };
const confirmed = (goal: ConfirmedInterpretation["proposal"]["brief"]["objective"]["goal"], carrier: ConfirmedInterpretation["carrier"] = null): ConfirmedInterpretation => ({ proposal: { brief: { objective: { goal } } }, confirmedAt: now, carrier });
const empty: Downstream = { proposals: [], plans: [], jobs: [], assets: [] };

describe("Case 1 — planner Commission → CreativeIntent → (confirmed) → BriefInput", () => {
  // the #652 Case A material "Northfield Partnership Pitch Deck" written as the Commission the planner would emit under 0.2.0
  const commission: Commission = { purpose: "A piece that introduces her programme with Northfield to the CSR departments she will approach", audienceRole: "CSR decision-makers at global brands", channelOrFormatClass: "written", timing: "before the first approach", constraints: ["no logos of current partners", "her words about Northfield, not ours"], why: "the approach needs one piece to point at" };
  const intent = intentFromCommission(commission, { athleteId: "ath-1", outreachPlanId: "op-1", recommendationId: "rec_9feaeb54fb19c6b1", index: 0, now });
  it("purpose, why, audience, constraints cross; nothing conceptual does; lineage points at the plan and the Recommendation; no objective exists", () => {
    expect(intent).toMatchObject({ source: { kind: "planner", ref: "outreach_plan[op-1]#0" }, purpose: commission.purpose, why: commission.why, audienceRole: commission.audienceRole, brandId: null, format: { class: "written", fixedBy: "planner", quantity: null }, lineage: { outreachPlanId: "op-1", recommendationId: "rec_9feaeb54fb19c6b1" } });
    expect(intent.constraints).toEqual([{ text: "no logos of current partners", source: "planner" }, { text: "her words about Northfield, not ours", source: "planner" }]);
    noSolution(intent);
    expect(briefInputFrom(intent, null)).toMatchObject({ ok: false, refused: expect.stringContaining("no confirmed interpretation") });
  });
  it("the objective comes from the confirmed interpretation, not the Commission — and a written piece has no Studio job (contract mismatch recorded)", () => {
    const out = briefInputFrom(intent, confirmed("announce"));
    expect(out).toMatchObject({ ok: false, refused: expect.stringContaining('"written" is not a Studio deliverable') });
    const asPost = intentFromCommission({ ...commission, channelOrFormatClass: "carousel" }, { athleteId: "ath-1", outreachPlanId: "op-1", recommendationId: "rec_9feaeb54fb19c6b1", index: 1, now });
    const ok = briefInputFrom(asPost, confirmed("announce", { planId: "plan-1", tone: ["warm"], style: null, energy: null, constraints: [], concept: "her Northfield story, in her voice", aesthetic: null, objective: null, references: [] }));
    expect(ok).toMatchObject({ ok: true, input: { athleteId: "ath-1", brandId: null, origin: "system", objective: "announce", deliverable: "carousel", mode: "generate", campaign: { planId: "plan-1" } } });
  });
});

describe("Case 2 — direct athlete request", () => {
  const ask = "Make a post about today's win";
  const intent = intentFromAthleteAsk(ask, { athleteId: "ath-1", askRef: "mila:turn:abc", moment: { asOf: "2026-09-27", ref: "ctx[0]" }, now });
  it("her words verbatim; the moment by reference; the format fixed only because she said post; no campaign, recommendation, planner or brand; no objective", () => {
    expect(intent).toMatchObject({ source: { kind: "athlete", ref: "mila:turn:abc" }, purpose: ask, why: null, brandId: null, ask: { verbatim: ask, moment: { ref: "ctx[0]" } }, format: { class: "post", quantity: 1, fixedBy: "athlete" }, lineage: {} });
    noSolution(intent);
    expect(intentFromAthleteAsk("Do something for the team", { athleteId: "ath-1", askRef: "t2", moment: null, now }).format).toEqual({ class: null, quantity: null, dueOn: null, fixedBy: null });
    expect(intentFromAthleteAsk("Post-game thoughts, please", { athleteId: "ath-1", askRef: "t3", moment: null, now }).format.class).toBeNull(); // "post-game" names no deliverable — left for confirmation
    expect(intentFromAthleteAsk("Two reels from the away trip", { athleteId: "ath-1", askRef: "t4", moment: null, now }).format.class).toBe("reel");
    expect(intentFromAthleteAsk("Something about my storyline this season", { athleteId: "ath-1", askRef: "t5", moment: null, now }).format.class).toBeNull();
  });
  it("reproduces the recorded #649 direct-door BriefInput only after a confirmed interpretation", () => {
    const rec = join(__dirname, "../../../../docs/audits/artifacts/brain-context-experiment-1/ci-boundary/slice/shape/case5-direct-creative-request.json");
    const expected = existsSync(rec) ? JSON.parse(readFileSync(rec, "utf8")).established_by_the_ask : { origin: "system", objective: "recap", deliverable: "post", mode: "generate", brandId: null };
    const out = briefInputFrom(intent, confirmed("recap"));
    expect(out.ok).toBe(true);
    // the recorded #649 mapping carried `origin: "system"` because BriefOrigin had no athlete value then; 0072 closed that gap
    if (out.ok) { expect(out.input).toMatchObject({ origin: "athlete", objective: expected.objective, deliverable: expected.deliverable, mode: expected.mode, brandId: expected.brandId }); expect(expected.origin).toBe("system"); }
  });
});

const spec = (version: number, over: Partial<SpecForIntents> = {}): SpecForIntents => ({ campaignId: "camp-1", athleteId: "ath-1", version, purpose: "six posts over the gorjana term", brandIds: [42], constraints: [{ text: "no competing jewellery in frame", source: "contract" }], ...over });
const del = (id: string, over: Partial<SpecDeliverable> = {}): SpecDeliverable => ({ id, category: "content", contentFormat: "post", quantity: 1, dueOn: "2026-11-01", sourceQuote: null, brandId: null, dealDeliverableId: `dd-${id}`, ...over });

describe("Case 3 — single-asset campaign", () => {
  const { created } = intentsFromCampaignSpec(spec(1, { purpose: "one hero video for the launch" }), [del("d1", { contentFormat: "reel", sourceQuote: "one hero video for the spring launch", quantity: 1 })], [], now);
  it("exactly one intent; contractual format fixed; campaign/spec/deliverable lineage; the brief is inbound with the contract's words; fulfilment derives from the asset", () => {
    expect(created).toHaveLength(1);
    const i = created[0];
    expect(i).toMatchObject({ source: { kind: "campaign", ref: "campaign[camp-1]" }, purpose: "one hero video for the spring launch", why: "one hero video for the launch", brandId: 42, format: { class: "reel", quantity: 1, dueOn: "2026-11-01", fixedBy: "contract" }, lineage: { campaignId: "camp-1", specVersion: 1, campaignDeliverableId: "d1", dealDeliverableId: "dd-d1", unit: 1 } });
    noSolution(i);
    const out = briefInputFrom(i, confirmed("announce"));
    expect(out).toMatchObject({ ok: true, input: { origin: "inbound", ask: { ask: "one hero video for the spring launch" }, deliverable: "reel", brandId: 42, objective: "announce" } });
    const d: Downstream = { proposals: [{ intentId: i.id, confirmedAt: now }], plans: [{ id: "p1", creativeIntentId: i.id, parentPlanId: null, version: 1 }], jobs: [{ id: "j1", creativeIntentId: i.id, status: "succeeded" }], assets: [{ id: "a1", generationJobId: "j1", approvalStatus: "approved", postedAt: null }] };
    expect(deriveIntentState(i, d)).toBe("cleared");
    expect(fulfilmentOf(created, d)).toEqual({ fulfilled: 1, of: 1 });
  });
});

describe("Case 4 — multi-asset campaign, then spec v2", () => {
  const v1 = intentsFromCampaignSpec(spec(1), [del("d1"), del("d2", { contentFormat: "reel" }), del("d3", { contentFormat: "story" })], [], now);
  it("three intents, one campaign id, each with its spec version and deliverable id; a shared interpretation is referenced by the plans, not by collapsing the intents", () => {
    expect(v1.created.map((i) => [i.lineage.campaignDeliverableId, i.lineage.specVersion, i.format.class])).toEqual([["d1", 1, "post"], ["d2", 1, "reel"], ["d3", 1, "story"]]);
    expect(new Set(v1.created.map((i) => i.lineage.campaignId)).size).toBe(1);
    expect(new Set(v1.created.map(intentKey)).size).toBe(3);
    // the shared campaign-level interpretation: one carrier (from the first confirmed plan) reused by each intent's brief — three briefs, one concept, three intents
    const carrier = { planId: "plan-shared", tone: ["bright"], style: "editorial", energy: "calm", constraints: [], concept: "the term as one story", aesthetic: null, objective: null, references: [] };
    const briefs = v1.created.map((i) => briefInputFrom(i, confirmed("showcase-product", carrier)));
    expect(briefs.every((b) => b.ok && b.input.campaign?.concept === "the term as one story")).toBe(true);
    expect(new Set(briefs.map((b) => (b.ok ? b.input.deliverable : ""))).size).toBe(3);
  });
  it("spec v2 adds one deliverable: exactly one new intent; the earlier three keep specVersion 1; nothing is rewritten", () => {
    const v2 = intentsFromCampaignSpec(spec(2), [del("d1"), del("d2", { contentFormat: "reel" }), del("d3", { contentFormat: "story" }), del("d4", { contentFormat: "clip" })], v1.created, now);
    expect(v2.created).toHaveLength(1);
    expect(v2.created[0].lineage).toMatchObject({ campaignDeliverableId: "d4", specVersion: 2 });
    expect(v2.kept).toEqual(v1.created);
    expect(v2.kept.every((i) => i.lineage.specVersion === 1)).toBe(true);
    // a quantity-2 deliverable is two intents, two units
    const q = intentsFromCampaignSpec(spec(1, { campaignId: "camp-q" }), [del("dq", { quantity: 2 })], [], now).created;
    expect(q.map((i) => i.lineage.unit)).toEqual([1, 2]);
  });
});

describe("Case 5 — mixed campaign", () => {
  it("only content deliverables become intents; the appearance stays a campaign deliverable; creative intelligence never sees the whole campaign", () => {
    const { created } = intentsFromCampaignSpec(spec(1), [del("c1"), del("c2", { contentFormat: "reel" }), del("x1", { category: "access", contentFormat: undefined, sourceQuote: "one appearance at the spring launch" })], [], now);
    expect(created.map((i) => i.lineage.campaignDeliverableId)).toEqual(["c1", "c2"]);
    expect(JSON.stringify(created)).not.toContain("appearance");
  });
});

describe("Case 6 — revision at one stage does not reopen another", () => {
  const i = intentsFromCampaignSpec(spec(1), [del("d1")], [], now).created[0];
  it("A. interpretation rejected → a new proposal for the same intent; B. plan regenerated → parent/version under the same intent; C. asset rejected → asset-level only — the intent id and the spec version never move", () => {
    const A: Downstream = { ...empty, proposals: [{ intentId: i.id, confirmedAt: null }, { intentId: i.id, confirmedAt: now }] };
    expect(deriveIntentState(i, A)).toBe("confirmed");
    const B: Downstream = { ...A, plans: [{ id: "p1", creativeIntentId: i.id, parentPlanId: null, version: 1 }, { id: "p2", creativeIntentId: i.id, parentPlanId: "p1", version: 2 }] };
    expect(deriveIntentState(i, B)).toBe("confirmed");
    const C: Downstream = { ...B, jobs: [{ id: "j1", creativeIntentId: i.id, status: "succeeded" }, { id: "j2", creativeIntentId: i.id, status: "running" }], assets: [{ id: "a1", generationJobId: "j1", approvalStatus: "rejected", postedAt: null }] };
    expect(deriveIntentState(i, C)).toBe("produced");   // a rejected asset exists; a regeneration is running; nothing upstream changed
    expect(i.lineage.specVersion).toBe(1);
    expect(intentKey(i)).toBe("campaign:camp-1:d1:1");
  });
});

describe("pressure tests on the contract", () => {
  it("status: every lifecycle question is answered by downstream records; the intent keeps only `withdrawnAt`", () => {
    const i = intentFromAthleteAsk("Make a reel", { athleteId: "ath-1", askRef: "t", moment: null, now });
    expect(Object.keys(i)).not.toContain("status");
    expect(deriveIntentState(i, empty)).toBe("open");
    expect(deriveIntentState(i, { ...empty, proposals: [{ intentId: i.id, confirmedAt: null }] })).toBe("interpreted");
    expect(deriveIntentState(i, { ...empty, jobs: [{ id: "j", creativeIntentId: i.id, status: "queued" }] })).toBe("in_production");
    expect(deriveIntentState(i, { ...empty, jobs: [{ id: "j", creativeIntentId: i.id, status: "succeeded" }], assets: [{ id: "a", generationJobId: "j", approvalStatus: "approved", postedAt: "2026-10-01" }] })).toBe("published");
    expect(deriveIntentState({ ...i, withdrawnAt: now }, { ...empty, jobs: [{ id: "j", creativeIntentId: i.id, status: "running" }] })).toBe("withdrawn");
  });
  it("format.fixedBy: contract for campaign, planner only when the commission named a class, athlete only when she named a deliverable", () => {
    expect(intentsFromCampaignSpec(spec(1), [del("d")], [], now).created[0].format.fixedBy).toBe("contract");
    expect(intentFromCommission({ purpose: "p", audienceRole: "a", channelOrFormatClass: null, timing: null, constraints: [], why: "w" }, { athleteId: "x", outreachPlanId: "o", recommendationId: "r", index: 0, now }).format.fixedBy).toBeNull();
    expect(intentFromCommission({ purpose: "p", audienceRole: "a", channelOrFormatClass: "instagram", timing: null, constraints: [], why: "w" }, { athleteId: "x", outreachPlanId: "o", recommendationId: "r", index: 0, now })).toMatchObject({ format: { class: null, fixedBy: null }, channel: "instagram" });
  });
  it("lineage: strategic context is referenced, never copied — no Objective text, no Recommendation `what`, no campaign spec body on the intent", () => {
    const i = intentsFromCampaignSpec(spec(1), [del("d")], [], now).created[0];
    expect(keysDeep(i)).not.toEqual(expect.arrayContaining(["deliverables", "period", "endsRef", "evidence"]));
    expect(i.why).toBe("six posts over the gorjana term"); // one sentence, by copy — the only strategic text carried
  });
});
