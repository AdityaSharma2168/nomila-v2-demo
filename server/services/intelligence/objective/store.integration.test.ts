/**
 * store.integration.test.ts — the live Objective against real tables (PGlite). PR3b-1.
 *
 *   P3  the row is a projection of its events: rebuild(events over created_snapshot) === the row
 *   P5  nothing here can update a set or an event, or delete anything
 *   T1  every read and write is scoped by athlete; a borrowed id resolves to nothing
 *   the database enforces the central invariant on its own (objectives_active_needs_yes)
 *   one row per proposal, ever (objectives_one_per_proposal)
 */
import { eq } from "drizzle-orm";
import { athletes, objectiveEvents, objectiveProposalSets, objectives, users } from "../../../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../../testUtils/pgliteDb";
import type { ObjectiveProposalSet } from "../contracts/objective";
import { ATHLETE_STATE_VERSION } from "../contracts/athleteState";
import { OPPORTUNITY_MAP_VERSION } from "../contracts/opportunity";
import type { EvidenceAsSeen } from "./context";
import * as store from "./store";

const T0 = "2026-09-21T00:00:00.000Z";
const ev = (value: string): any => ({ value, owner: "objectives", confidence: "MEDIUM", asOf: T0, evidenceClass: "EVALUATED", evidenceIds: [], rationale: "r", falsifiedBy: null });
const set = (athleteId: string): ObjectiveProposalSet => ({
  athleteId, asOf: T0, version: "objective-proposal/1.0.0", specVersion: "objective-eval-spec/1.0.1", stateAsOf: T0, opportunityMapAsOf: T0,
  proposals: [
    { key: "p-joint", desiredState: ev("A."), currentState: ev("a."), domain: "audience",
      provenance: { origin: "joint", fromOpportunities: [{ opportunityKey: "o1", how: "h" }], fromAthleteIntent: [{ statePath: "preferences[x]", how: "h" }], currentStateEvidence: [{ statePath: "findings[mia.x]", how: "h" }] },
      success: { observableCondition: "A is so." }, horizon: null, confidence: "MEDIUM" },
    { key: "p-nomila", desiredState: ev("B."), currentState: ev("b."), domain: "content",
      provenance: { origin: "nomila", fromOpportunities: [{ opportunityKey: "o2", how: "h" }], fromAthleteIntent: [], currentStateEvidence: [{ statePath: "findings[mia.y]", how: "h" }] },
      success: { observableCondition: "B is so." }, horizon: { kind: "period", period: "this_season", why: "w" }, confidence: "LOW" },
  ],
  notes: [], overallConfidence: "LOW",
});

let a1: string, a2: string, a3: string, u1: string;

/** The structured evidence a set was judged from (L0): a minimal State and map whose asOfs match the set's. */
const seenFor = (athleteId: string): EvidenceAsSeen => ({
  state: {
    athleteId, asOf: T0, version: ATHLETE_STATE_VERSION,
    identity: { name: "Test Athlete", sport: null, competitionContext: null, careerStatus: null },
    findings: [{ key: "mia.x", direction: "strength", basis: { value: 80, owner: "marketability", confidence: "HIGH", asOf: T0, evidenceClass: "MEASURED", evidenceIds: ["e"], sourceMethod: "t" }, evidence: [] },
               { key: "mia.y", direction: "neutral", basis: { value: 50, owner: "marketability", confidence: "HIGH", asOf: T0, evidenceClass: "MEASURED", evidenceIds: ["e"], sourceMethod: "t" }, evidence: [] }],
    audienceTrajectory: { value: null, owner: "athlete_intelligence", asOf: T0, evidenceClass: "MISSING", reason: "none" } as any,
    commercialPosition: { closedDeals: { value: 0, owner: "athlete_state", confidence: "HIGH", asOf: T0, evidenceClass: "MEASURED", evidenceIds: [], sourceMethod: "t" }, activeRelationships: { value: [], owner: "athlete_state", confidence: "HIGH", asOf: T0, evidenceClass: "MEASURED", evidenceIds: [], sourceMethod: "t" }, demonstratedEconomics: { value: null, owner: "athlete_state", asOf: T0, evidenceClass: "MISSING", reason: "none" } as any, pricingEvidence: "none", pipeline: { value: { detected: 0, negotiating: 0, rejected: 0, accepted: 0, completed: 0 }, owner: "athlete_state", confidence: "HIGH", asOf: T0, evidenceClass: "MEASURED", evidenceIds: [], sourceMethod: "t" }, inbound: [] },
    constraints: [], preferences: [{ subject: "x", stance: "wants", source: { source: "assertion", locator: "x", asOf: T0 } }],
    audience: [], contentPerformance: [], representation: null, dates: [], athleteNotes: [], materialGaps: [], overallConfidence: "LOW", sources: [],
  },
  map: {
    athleteId, asOf: T0, version: OPPORTUNITY_MAP_VERSION, specVersion: "opportunity-eval-spec/1.0.0", stateAsOf: T0,
    opportunities: [
      { key: "o1", kind: "GROW", domain: "audience", statement: { value: "The opening.", owner: "opportunity", confidence: "HIGH", asOf: T0, evidenceClass: "EVALUATED", evidenceIds: [], rationale: "r", falsifiedBy: null }, restsOn: [{ statePath: "findings[mia.x]", how: "h" }], impact: { level: "medium", claim: "c" }, feasibility: { level: "high", claim: "c" }, urgency: null, confidence: "HIGH" } as any,
      { key: "o2", kind: "GROW", domain: "content", statement: { value: "Another opening.", owner: "opportunity", confidence: "HIGH", asOf: T0, evidenceClass: "EVALUATED", evidenceIds: [], rationale: "r", falsifiedBy: null }, restsOn: [{ statePath: "findings[mia.y]", how: "h" }], impact: { level: "medium", claim: "c" }, feasibility: { level: "high", claim: "c" }, urgency: null, confidence: "HIGH" } as any,
    ],
    notes: [], inputs: { stateBlock: "" } as any, overallConfidence: "MEDIUM",
  },
});

const actor = () => ({ userId: u1, role: "athlete" as const });

beforeAll(async () => {
  await initTestDb();
  a1 = await seedAthlete("Athlete One"); a2 = await seedAthlete("Athlete Two"); a3 = await seedAthlete("Athlete Three");
  const [u] = await db.insert(users).values({ provider: "firebase", provider_uid: "uid-1" } as any).returning({ id: users.id });
  u1 = u!.id;
});
afterAll(async () => { await closeTestDb(); });

describe("evidence-as-seen (L0)", () => {
  it("refuses a set whose evidence does not match it, and persists the snapshot and map when it does", async () => {
    const a = await seedAthlete("Seen Athlete");
    const seen = seenFor(a);
    await expect(store.persistProposalSet(db as any, set(a), { canonicalSha256: "abc" }, { ...seen, state: { ...seen.state, asOf: "2026-01-01T00:00:00.000Z" } })).rejects.toThrow(/evidence-as-seen does not match/);
    await expect(store.persistProposalSet(db as any, set(a), { canonicalSha256: "abc" }, { ...seen, map: { ...seen.map, stateAsOf: "2026-01-01T00:00:00.000Z" } })).rejects.toThrow(/map.stateAsOf/);
    await expect(store.persistProposalSet(db as any, set(a), { canonicalSha256: "abc" }, { ...seen, state: { ...seen.state, athleteId: a2 } })).rejects.toThrow(/state is for athlete/);
    const setId = await store.persistProposalSet(db as any, set(a), { canonicalSha256: "abc" }, seen);
    const back = await store.evidenceAsSeen(db as any, a, setId);
    expect(back).toEqual(seen);
    expect(await store.evidenceAsSeen(db as any, a2, setId)).toBeNull();
  });
  it("every citation on every materialised Objective resolves against the persisted snapshot and map", async () => {
    const a = await seedAthlete("Seen Athlete 2");
    const setId = await store.persistProposalSet(db as any, set(a), { canonicalSha256: "abc" }, seenFor(a));
    const { created } = await store.materialiseProposalSet(db as any, a, setId, new Date(T0));
    const queue = await store.reviewQueueWithContext(db as any, a);
    expect(queue).toHaveLength(created.length);
    for (const q of queue) {
      expect(q.context.evidence.every((e) => e.line !== null)).toBe(true);
      expect(q.context.intent.every((e) => e.line !== null)).toBe(true);
      expect(q.context.opportunities.every((o) => o.statement !== null)).toBe(true);
    }
  });
});

describe("reconciliation 2.0 on the path (L1)", () => {
  it("materialised Objectives carry lineage computed from the persisted map, and the same set twice relates by tier A", async () => {
    const a = await seedAthlete("Lineage Athlete");
    const setId = await store.persistProposalSet(db as any, set(a), { canonicalSha256: "abc" }, seenFor(a));
    const first = await store.materialiseProposalSet(db as any, a, setId, new Date(T0));
    expect(first.created.map((o) => o.lineage)).toEqual([
      { domain: "audience", opportunityKeys: ["o1"], mapAsOf: T0, evidencePaths: ["findings[mia.x]"], intentPaths: ["preferences[x]"] },
      { domain: "content", opportunityKeys: ["o2"], mapAsOf: T0, evidencePaths: ["findings[mia.y]"], intentPaths: [] },
    ]);
    expect(await store.rebuild(db as any, a, first.created[0]!.id)).toEqual(await store.loadObjective(db as any, a, first.created[0]!.id));
    const second = await store.materialiseProposalSet(db as any, a, setId, new Date(Date.parse(T0) + 60_000));
    expect(second.created).toHaveLength(0);
    expect(second.proposals.map((p) => [p.relationship, p.verdict, p.candidates[0]!.tier])).toEqual([["continues", "continues → reaffirmed", "A"], ["continues", "continues → reaffirmed", "A"]]);
  });

  it("a proposal across two live Objectives is `spans`: events on both, no row, both untouched", async () => {
    const a = await seedAthlete("Spans Athlete");
    const setId = await store.persistProposalSet(db as any, set(a), { canonicalSha256: "abc" }, seenFor(a));
    const { created: [x, y] } = await store.materialiseProposalSet(db as any, a, setId, new Date(T0));
    await store.decide(db as any, a, x!.id, { action: "accept", actor: actor() }, new Date(Date.parse(T0) + 1000));
    await store.decide(db as any, a, y!.id, { action: "modify", actor: actor(), desiredState: "Mine, both at once." }, new Date(Date.parse(T0) + 2000));
    // a later set whose one proposal cites BOTH openings, in x's domain
    const consolidated: ObjectiveProposalSet = { ...set(a), asOf: new Date(Date.parse(T0) + 3000).toISOString(), proposals: [{
      key: "p-both", desiredState: ev("Both at once."), currentState: ev("now"), domain: "audience",
      provenance: { origin: "nomila", fromOpportunities: [{ opportunityKey: "o1", how: "h" }, { opportunityKey: "o2", how: "h" }], fromAthleteIntent: [], currentStateEvidence: [{ statePath: "findings[mia.x]", how: "h" }] },
      success: { observableCondition: "Both are so." }, horizon: null, confidence: "LOW" }] };
    // y is in the `content` domain; spans needs same-domain matches, so first make y's domain comparable by proposing in each
    const setId2 = await store.persistProposalSet(db as any, consolidated, { canonicalSha256: "abc" }, seenFor(a));
    const m = await store.materialiseProposalSet(db as any, a, setId2, new Date(Date.parse(T0) + 4000));
    // x is audience, y is content; lineage is not domain-gated, so one proposal over both openings spans both.
    expect(m.created).toHaveLength(0);
    expect(m.proposals[0]!.relationship).toBe("spans");
    expect(m.proposals[0]!.candidates.map((c) => [c.objectiveId, c.sameDomain]).sort()).toEqual([[x!.id, true], [y!.id, false]].sort());
    // Now a set with two audience-domain live Objectives on distinct ground, and one proposal over both
    const b = await seedAthlete("Spans Athlete B");
    const two: ObjectiveProposalSet = { ...set(b), proposals: [
      { ...set(b).proposals[0]!, key: "q1", domain: "audience", provenance: { ...set(b).proposals[0]!.provenance, fromOpportunities: [{ opportunityKey: "o1", how: "h" }], currentStateEvidence: [{ statePath: "findings[mia.x]", how: "h" }] } },
      { ...set(b).proposals[1]!, key: "q2", domain: "audience", desiredState: ev("Q two."), provenance: { ...set(b).proposals[1]!.provenance, fromOpportunities: [{ opportunityKey: "o2", how: "h" }], currentStateEvidence: [{ statePath: "findings[mia.y]", how: "h" }] } },
    ] };
    const sb = await store.persistProposalSet(db as any, two, { canonicalSha256: "abc" }, seenFor(b));
    const { created: [q1, q2] } = await store.materialiseProposalSet(db as any, b, sb, new Date(T0));
    await store.decide(db as any, b, q1!.id, { action: "accept", actor: actor() }, new Date(Date.parse(T0) + 1000));
    await store.decide(db as any, b, q2!.id, { action: "accept", actor: actor() }, new Date(Date.parse(T0) + 2000));
    const over: ObjectiveProposalSet = { ...two, asOf: new Date(Date.parse(T0) + 3000).toISOString(), proposals: [{ ...two.proposals[0]!, key: "q-both", desiredState: ev("Both q."), provenance: { ...two.proposals[0]!.provenance, fromOpportunities: [{ opportunityKey: "o1", how: "h" }, { opportunityKey: "o2", how: "h" }], currentStateEvidence: [{ statePath: "findings[mia.x]", how: "h" }, { statePath: "findings[mia.y]", how: "h" }] } }] };
    const so = await store.persistProposalSet(db as any, over, { canonicalSha256: "abc" }, seenFor(b));
    const ms = await store.materialiseProposalSet(db as any, b, so, new Date(Date.parse(T0) + 4000));
    expect(ms.created).toHaveLength(0);
    expect(ms.spans).toHaveLength(1);
    expect(ms.spans[0]!.proposalKey).toBe("q-both");
    expect([...ms.spans[0]!.objectiveIds].sort()).toEqual([q1!.id, q2!.id].sort());
    expect(ms.spans[0]!.strengths).toEqual([0.5, 0.5]);
    for (const id of [q1!.id, q2!.id]) {
      const row = await store.loadObjective(db as any, b, id);
      expect(row).toMatchObject({ disposition: "accepted", lifecycle: "active", desiredState: two.proposals[id === q1!.id ? 0 : 1]!.desiredState });
      const evs = await store.loadEvents(db as any, b, id);
      expect(evs.at(-1)).toMatchObject({ action: "spans_live", actor: { role: "system" }, delta: { proposalKey: "q-both", siblingObjectiveIds: [id === q1!.id ? q2!.id : q1!.id] } });
      expect(await store.rebuild(db as any, b, id)).toEqual(row);
    }
    expect((await store.liveObjectives(db as any, b)).map((o) => o.id).sort()).toEqual([q1!.id, q2!.id].sort());
  });

  it("two proposals over one live Objective is `splits`: reaffirmed twice, one splits_live event, no row", async () => {
    const a = await seedAthlete("Splits Athlete");
    const one: ObjectiveProposalSet = { ...set(a), proposals: [{ ...set(a).proposals[0]!, key: "wide", provenance: { ...set(a).proposals[0]!.provenance, fromOpportunities: [{ opportunityKey: "o1", how: "h" }, { opportunityKey: "o2", how: "h" }] } }] };
    const s1 = await store.persistProposalSet(db as any, one, { canonicalSha256: "abc" }, seenFor(a));
    const { created: [wide] } = await store.materialiseProposalSet(db as any, a, s1, new Date(T0));
    await store.decide(db as any, a, wide!.id, { action: "accept", actor: actor() }, new Date(Date.parse(T0) + 1000));
    const halves: ObjectiveProposalSet = { ...one, asOf: new Date(Date.parse(T0) + 2000).toISOString(), proposals: [
      { ...one.proposals[0]!, key: "half-1", desiredState: ev("Half one."), provenance: { ...one.proposals[0]!.provenance, fromOpportunities: [{ opportunityKey: "o1", how: "h" }] } },
      { ...one.proposals[0]!, key: "half-2", desiredState: ev("Half two."), provenance: { ...one.proposals[0]!.provenance, fromOpportunities: [{ opportunityKey: "o2", how: "h" }], currentStateEvidence: [{ statePath: "findings[mia.y]", how: "h" }] } },
    ] };
    const s2 = await store.persistProposalSet(db as any, halves, { canonicalSha256: "abc" }, seenFor(a));
    const m = await store.materialiseProposalSet(db as any, a, s2, new Date(Date.parse(T0) + 3000));
    expect(m.created).toHaveLength(0);
    expect(m.reaffirmed.map((r) => r.proposalKey)).toEqual(["half-1", "half-2"]);
    expect(m.splits).toEqual([{ objectiveId: wide!.id, proposalKeys: ["half-1", "half-2"] }]);
    // three system events land in the same instant; their order is not a claim
    expect((await store.loadEvents(db as any, a, wide!.id)).map((e) => e.action).sort()).toEqual(["accept", "presented", "reaffirmed_by_run", "reaffirmed_by_run", "splits_live"].sort());
    expect(await store.loadObjective(db as any, a, wide!.id)).toMatchObject({ disposition: "accepted", lifecycle: "active" });
  });

  it("refuses to materialise a set that carries no opportunity_map — lineage needs the evidence-as-seen", async () => {
    const a = await seedAthlete("No Map Athlete");
    const setId = await store.persistProposalSet(db as any, set(a), { canonicalSha256: "abc" }, seenFor(a));
    await db.update(objectiveProposalSets).set({ opportunity_map: null }).where(eq(objectiveProposalSets.id, setId));
    await expect(store.materialiseProposalSet(db as any, a, setId)).rejects.toThrow(/no opportunity_map/);
  });
});

describe("L2 — deferral on the path", () => {
  const t = (m: number) => new Date(Date.parse(T0) + m * 60_000);
  const daysLater = (d: number) => new Date(Date.parse(T0) + d * 86_400_000);

  it("an information deferral stays deferred across reruns — even when the evidence changed, which is recorded and triggers nothing", async () => {
    const a = await seedAthlete("Info Defer Athlete");
    const s1 = await store.persistProposalSet(db as any, set(a), { canonicalSha256: "abc" }, seenFor(a));
    const { created: [o] } = await store.materialiseProposalSet(db as any, a, s1, t(0));
    await store.decide(db as any, a, o!.id, { action: "defer", actor: actor(), said: "tell me more first", deferral: { kind: "information" } }, t(1));
    expect(await store.loadObjective(db as any, a, o!.id)).toMatchObject({ disposition: "deferred", deferral: { kind: "information", said: "tell me more first" } });
    // same evidence → reaffirm, evidenceChanged false
    const s2 = await store.persistProposalSet(db as any, { ...set(a), asOf: t(2).toISOString() }, { canonicalSha256: "abc" }, seenFor(a));
    const m2 = await store.materialiseProposalSet(db as any, a, s2, t(3));
    expect(m2.created).toHaveLength(0); expect(m2.reSurfaced).toHaveLength(0);
    expect(m2.proposals[0]!.verdict).toMatch(/stays deferred; evidence unchanged/);
    // changed evidence at its lineage path (findings[mia.x] score moves) → still reaffirm, evidenceChanged true
    const changed = seenFor(a); (changed.state.findings[0]!.basis as any).value = 12; changed.state.asOf = daysLater(5).toISOString(); changed.map.stateAsOf = changed.state.asOf; changed.map.asOf = changed.state.asOf;
    const s3 = await store.persistProposalSet(db as any, { ...set(a), asOf: daysLater(5).toISOString(), stateAsOf: changed.state.asOf, opportunityMapAsOf: changed.map.asOf }, { canonicalSha256: "abc" }, changed);
    const m3 = await store.materialiseProposalSet(db as any, a, s3, daysLater(6));
    expect(m3.created).toHaveLength(0); expect(m3.reSurfaced).toHaveLength(0);
    expect(m3.proposals[0]!.verdict).toMatch(/evidence CHANGED \(signal only\)/);
    const row = await store.loadObjective(db as any, a, o!.id);
    expect(row).toMatchObject({ disposition: "deferred", lifecycle: "proposed", deferral: { kind: "information" } });
    expect((await store.reviewQueue(db as any, a)).map((x) => x.id)).not.toContain(o!.id);
    const evs = await store.loadEvents(db as any, a, o!.id);
    expect(evs.map((e) => e.action)).toEqual(["presented", "defer", "reaffirmed_by_run", "reaffirmed_by_run"]);
    expect(evs[1]!.said).toBe("tell me more first");
    expect(evs[2]!.delta).toMatchObject({ evidenceChanged: false }); expect(evs[3]!.delta).toMatchObject({ evidenceChanged: true });
    expect(await store.rebuild(db as any, a, o!.id)).toEqual(row);
  });

  it("a pre-L2 deferral (no kind on the row) is read as information: stays deferred", async () => {
    const a = await seedAthlete("Legacy Defer Athlete");
    const s1 = await store.persistProposalSet(db as any, set(a), { canonicalSha256: "abc" }, seenFor(a));
    const { created: [o] } = await store.materialiseProposalSet(db as any, a, s1, t(0));
    await store.decide(db as any, a, o!.id, { action: "defer", actor: actor() }, t(1));
    await db.update(objectives).set({ deferral: null }).where(eq(objectives.id, o!.id)); // as a row deferred before L2 looks
    const s2 = await store.persistProposalSet(db as any, { ...set(a), asOf: t(2).toISOString() }, { canonicalSha256: "abc" }, seenFor(a));
    const m2 = await store.materialiseProposalSet(db as any, a, s2, daysLater(200));
    expect(m2.reSurfaced).toHaveLength(0); expect(m2.created).toHaveLength(0);
    expect(m2.proposals[0]!.verdict).toMatch(/information, pre-L2/);
    expect((await store.loadObjective(db as any, a, o!.id)).disposition).toBe("deferred");
  });

  it("a time deferral re-surfaces once its period has passed, and not before", async () => {
    const a = await seedAthlete("Time Defer Athlete");
    const s1 = await store.persistProposalSet(db as any, set(a), { canonicalSha256: "abc" }, seenFor(a));
    const { created: [o] } = await store.materialiseProposalSet(db as any, a, s1, t(0));
    await store.decide(db as any, a, o!.id, { action: "defer", actor: actor(), deferral: { kind: "time", period: "this_season" } }, t(1));
    const s2 = await store.persistProposalSet(db as any, { ...set(a), asOf: t(2).toISOString() }, { canonicalSha256: "abc" }, seenFor(a));
    expect((await store.materialiseProposalSet(db as any, a, s2, daysLater(89))).reSurfaced).toHaveLength(0);
    expect((await store.loadObjective(db as any, a, o!.id)).disposition).toBe("deferred");
    const s3 = await store.persistProposalSet(db as any, { ...set(a), asOf: t(3).toISOString() }, { canonicalSha256: "abc" }, seenFor(a));
    const m3 = await store.materialiseProposalSet(db as any, a, s3, daysLater(91));
    expect(m3.reSurfaced.map((r) => r.objectiveId)).toEqual([o!.id]); expect(m3.created).toHaveLength(0);
    const row = await store.loadObjective(db as any, a, o!.id);
    expect(row).toMatchObject({ disposition: "unreviewed", lifecycle: "proposed" }); expect(row.deferral).toBeUndefined();
    expect((await store.loadEvents(db as any, a, o!.id)).at(-1)).toMatchObject({ action: "re_surfaced", actor: { role: "system" }, delta: { because: "time_elapsed" } });
    expect((await store.reviewQueue(db as any, a)).map((x) => x.id)).toContain(o!.id);
    expect(await store.rebuild(db as any, a, o!.id)).toEqual(row);
  });

  it("an athlete deferral never re-surfaces by a run; her revisit brings it back with her as the actor", async () => {
    const a = await seedAthlete("Athlete Defer Athlete");
    const s1 = await store.persistProposalSet(db as any, set(a), { canonicalSha256: "abc" }, seenFor(a));
    const { created: [o] } = await store.materialiseProposalSet(db as any, a, s1, t(0));
    await store.decide(db as any, a, o!.id, { action: "defer", actor: actor(), deferral: { kind: "athlete" } }, t(1));
    const s2 = await store.persistProposalSet(db as any, { ...set(a), asOf: t(2).toISOString() }, { canonicalSha256: "abc" }, seenFor(a));
    expect((await store.materialiseProposalSet(db as any, a, s2, daysLater(400))).reSurfaced).toHaveLength(0);
    expect((await store.loadObjective(db as any, a, o!.id)).disposition).toBe("deferred");
    const back = await store.decide(db as any, a, o!.id, { action: "revisit", actor: actor() }, daysLater(401));
    expect(back).toMatchObject({ disposition: "unreviewed", lifecycle: "proposed" }); expect(back.deferral).toBeUndefined();
    expect((await store.loadEvents(db as any, a, o!.id)).at(-1)).toMatchObject({ action: "re_surfaced", actor: { userId: u1, role: "athlete" }, delta: { because: "athlete" } });
    expect((await store.reviewQueue(db as any, a)).map((x) => x.id)).toContain(o!.id);
    expect(await store.rebuild(db as any, a, o!.id)).toEqual(back);
    await expect(store.decide(db as any, a, o!.id, { action: "revisit", actor: actor() })).rejects.toThrow(/only a deferred/);
  });
});

describe("proposal set → objectives", () => {
  it("persists the set immutably and materialises one unreviewed row per proposal with a presented event", async () => {
    const setId = await store.persistProposalSet(db as any, set(a1), { canonicalSha256: "abc" }, seenFor(a1));
    const { created: rows } = await store.materialiseProposalSet(db as any, a1, setId, new Date(T0));
    expect(rows.map((r) => [r.fromProposal!.key, r.provenance.origin, r.disposition, r.lifecycle])).toEqual([
      ["p-joint", "joint", "unreviewed", "proposed"], ["p-nomila", "nomila", "unreviewed", "proposed"],
    ]);
    const events = await store.loadEvents(db as any, a1, rows[0]!.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "presented", actor: { userId: null, role: "system" }, delta: { setId } });
  });

  it("materialising the same set twice creates nothing the second time — every proposal reaffirms the queued row", async () => {
    const setId = await store.persistProposalSet(db as any, set(a3), { canonicalSha256: "abc" }, seenFor(a3));
    const first = await store.materialiseProposalSet(db as any, a3, setId, new Date(T0));
    const second = await store.materialiseProposalSet(db as any, a3, setId, new Date(Date.parse(T0) + 60_000));
    expect(first.created).toHaveLength(2);
    expect(second.created).toHaveLength(0);
    expect(second.reaffirmed.map((r) => r.objectiveId).sort()).toEqual(first.created.map((o) => o.id).sort());
    expect((await store.loadEvents(db as any, a3, first.created[0]!.id)).map((e) => e.action)).toEqual(["presented", "reaffirmed_by_run"]);
  });

  it("T1 — a set belongs to its athlete", async () => {
    const setId = await store.persistProposalSet(db as any, set(a1), { canonicalSha256: "abc" }, seenFor(a1));
    await expect(store.materialiseProposalSet(db as any, a2, setId)).rejects.toThrow(store.ObjectiveNotFound);
  });
});

// Each call uses a fresh athlete so reconciliation never folds one test's rows into another's.
async function fresh() {
  const a = await seedAthlete("Fresh Athlete");
  const setId = await store.persistProposalSet(db as any, set(a), { canonicalSha256: "abc" }, seenFor(a));
  const { created: [joint, nomila] } = await store.materialiseProposalSet(db as any, a, setId, new Date(T0));
  return { a, setId, joint: joint!, nomila: nomila! };
}

describe("decisions and the rebuild", () => {

  it("P3 — decline, accept, modify, abandon: the row equals the fold at every step", async () => {
    const { a, joint, nomila } = await fresh();
    const t = (m: number) => new Date(Date.parse(T0) + m * 60_000);
    await store.decide(db as any, a, joint.id, { action: "decline", actor: actor(), said: "no" }, t(1));
    expect(await store.rebuild(db as any, a, joint.id)).toEqual(await store.loadObjective(db as any, a, joint.id));
    await store.decide(db as any, a, joint.id, { action: "accept", actor: actor() }, t(2));
    expect(await store.rebuild(db as any, a, joint.id)).toEqual(await store.loadObjective(db as any, a, joint.id));
    const m = await store.decide(db as any, a, nomila.id, { action: "modify", actor: actor(), desiredState: "B, my way.", horizon: null, said: "mine" }, t(3));
    expect(m.desiredState).toMatchObject({ value: "B, my way.", owner: "athlete_intelligence", evidenceClass: "MEASURED" });
    expect(m.modifiedFrom).toEqual({ desiredState: "B.", at: t(3).toISOString() });
    expect(await store.rebuild(db as any, a, nomila.id)).toEqual(await store.loadObjective(db as any, a, nomila.id));
    await store.decide(db as any, a, nomila.id, { action: "abandon", actor: actor(), said: "done" }, t(4));
    const row = await store.loadObjective(db as any, a, nomila.id);
    expect(row).toMatchObject({ lifecycle: "abandoned", disposition: "modified" });
    expect(await store.rebuild(db as any, a, nomila.id)).toEqual(row);
    const events = await store.loadEvents(db as any, a, nomila.id);
    expect(events.map((e) => e.action)).toEqual(["presented", "modify", "abandon"]);
    expect(events[1]!.said).toBe("mine"); expect(events[1]!.actor).toEqual({ userId: u1, role: "athlete" });
  });

  it("an athlete-created objective replaces a declined proposal with lineage on both sides", async () => {
    const { a, joint } = await fresh();
    await store.decide(db as any, a, joint.id, { action: "decline", actor: actor(), said: "not that" });
    const mine = await store.createAthleteObjective(db as any, { athleteId: a, desiredState: "My own.", domain: "audience", observableCondition: "Seen.", start: "now", replaces: joint.id }, actor());
    expect(mine).toMatchObject({ disposition: "accepted", lifecycle: "active" });
    expect(mine.provenance).toMatchObject({ origin: "athlete", supersedes: joint.id });
    const old = await store.loadObjective(db as any, a, joint.id);
    expect(old).toMatchObject({ lifecycle: "superseded", supersededBy: mine.id, disposition: "declined" });
    expect(await store.rebuild(db as any, a, joint.id)).toEqual(old);
    expect(await store.rebuild(db as any, a, mine.id)).toEqual(await store.loadObjective(db as any, a, mine.id));

    // ATOMICITY: replacing an Objective that is already superseded is refused — and leaves no orphan successor.
    const before = (await db.select().from(objectives).where(eq(objectives.athlete_id, a))).length;
    await expect(store.createAthleteObjective(db as any, { athleteId: a, desiredState: "A second replacement.", domain: "audience", observableCondition: "Seen.", start: "now", replaces: joint.id }, actor())).rejects.toThrow();
    expect((await db.select().from(objectives).where(eq(objectives.athlete_id, a))).length).toBe(before);
    expect(await store.loadObjective(db as any, a, joint.id)).toEqual(old);
  });

  it("two concurrent replaces of one Objective: exactly one wins, the other rolls back whole (no orphan successor)", async () => {
    const { a, joint } = await fresh();
    await store.decide(db as any, a, joint.id, { action: "decline", actor: actor(), said: "not that" });
    const before = (await db.select().from(objectives).where(eq(objectives.athlete_id, a))).length;
    const replace = (text: string) => store.createAthleteObjective(db as any, { athleteId: a, desiredState: text, domain: "audience", observableCondition: "Seen.", start: "now", replaces: joint.id }, actor());
    const results = await Promise.allSettled([replace("First."), replace("Second.")]);
    const won = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof replace>>> => r.status === "fulfilled");
    expect(won).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    // One successor only, and it is the one the predecessor names.
    expect((await db.select().from(objectives).where(eq(objectives.athlete_id, a))).length).toBe(before + 1);
    expect(await store.loadObjective(db as any, a, joint.id)).toMatchObject({ lifecycle: "superseded", supersededBy: won[0]!.value.id });
  });

  it("a replace asks for one identity refresh, after the commit — never from inside the supersede", async () => {
    const refresh = jest.spyOn(require("../identityIntelligence/refresh"), "requestIdentityRefresh");
    try {
      const { a, joint } = await fresh();
      await store.decide(db as any, a, joint.id, { action: "decline", actor: actor(), said: "no" });
      refresh.mockClear();
      await store.createAthleteObjective(db as any, { athleteId: a, desiredState: "Mine.", domain: "audience", observableCondition: "Seen.", start: "now", replaces: joint.id }, actor());
      expect(refresh.mock.calls.map((c) => c[1])).toEqual(["objective created"]);
      // A plain decision still makes its own request.
      refresh.mockClear();
      const { a: b, nomila } = await fresh();
      await store.decide(db as any, b, nomila.id, { action: "accept", actor: actor() });
      expect(refresh.mock.calls.map((c) => c[1])).toEqual(["objective accept"]);
    } finally {
      refresh.mockRestore();
    }
  });

  it("T1 — a decision on another athlete's objective resolves to nothing", async () => {
    const { a, joint } = await fresh();
    await expect(store.decide(db as any, a2, joint.id, { action: "accept", actor: actor() })).rejects.toThrow(store.ObjectiveNotFound);
    await expect(store.loadObjective(db as any, a2, joint.id)).rejects.toThrow(store.ObjectiveNotFound);
    await expect(store.decide(db as any, a, joint.id, { action: "supersede", actor: actor(), supersededBy: "00000000-0000-0000-0000-000000000000" })).rejects.toThrow(store.ObjectiveNotFound);
  });

  it("a refused transition writes nothing", async () => {
    const { a, joint } = await fresh();
    await expect(store.decide(db as any, a, joint.id, { action: "abandon", actor: actor() })).rejects.toThrow(/requires lifecycle active/);
    expect(await store.loadEvents(db as any, a, joint.id)).toHaveLength(1);
  });
});

describe("reconciliation on the path, and the readers (PR3b-2)", () => {
  const t = (m: number) => new Date(Date.parse(T0) + m * 60_000);
  const daysLater = (d: number) => new Date(Date.parse(T0) + d * 86_400_000);

  it("a second run: live → reaffirmed (no row); deferred → stays deferred (L2); revisit then decline → recorded, not queued", async () => {
    const { a, setId, joint, nomila } = await fresh();
    await store.decide(db as any, a, joint.id, { action: "accept", actor: actor() }, t(1));
    await store.decide(db as any, a, nomila.id, { action: "defer", actor: actor() }, t(2));
    const again = await store.materialiseProposalSet(db as any, a, setId, t(3));
    expect(again.created).toHaveLength(0);
    // L2: a plain defer is an information deferral — it stays deferred and out of the queue
    expect(again.reSurfaced).toEqual([]);
    expect(again.reaffirmed.map((r) => r.objectiveId).sort()).toEqual([joint.id, nomila.id].sort());
    expect(await store.reviewQueue(db as any, a)).toEqual([]);
    expect((await store.liveObjectives(db as any, a)).map((o) => o.id)).toEqual([joint.id]);
    expect(await store.rebuild(db as any, a, nomila.id)).toEqual(await store.loadObjective(db as any, a, nomila.id));
    // she revisits, then declines; a further run inside the window is recorded, not shown
    await store.decide(db as any, a, nomila.id, { action: "revisit", actor: actor() }, t(4));
    await store.decide(db as any, a, nomila.id, { action: "decline", actor: actor(), said: "still no" }, t(5));
    const third = await store.materialiseProposalSet(db as any, a, setId, t(6));
    expect(third.repeatedDeclines.map((r) => r.objectiveId)).toEqual([nomila.id]);
    expect(await store.reviewQueue(db as any, a)).toEqual([]);
    expect((await store.loadEvents(db as any, a, nomila.id)).map((e) => e.action)).toEqual(["presented", "defer", "reaffirmed_by_run", "re_surfaced", "decline", "re_proposed_while_declined"]);
  });

  it("outside the decline window the proposal is shown again, once, with the earlier objective attached", async () => {
    const { a, joint, nomila } = await fresh();
    await store.decide(db as any, a, joint.id, { action: "decline", actor: actor() }, t(1));
    await store.decide(db as any, a, nomila.id, { action: "decline", actor: actor() }, t(1));
    // a real second run is a new persisted set; one row per (set, key) still holds
    const setId = await store.persistProposalSet(db as any, { ...set(a), asOf: daysLater(91).toISOString() }, { canonicalSha256: "abc" }, seenFor(a));
    const later = await store.materialiseProposalSet(db as any, a, setId, daysLater(91));
    expect(later.created).toHaveLength(2);
    const ev = await store.loadEvents(db as any, a, later.created[0]!.id);
    expect(ev[0]).toMatchObject({ action: "presented", delta: { setId, relatedObjectiveId: joint.id } });
  });

  it("the readers partition cleanly: live is active + yes; history is everything else, with events; queue is unreviewed", async () => {
    const { a, joint, nomila } = await fresh();
    await store.decide(db as any, a, joint.id, { action: "modify", actor: actor(), desiredState: "A, mine." }, t(1));
    const live = await store.liveObjectives(db as any, a);
    expect(live.map((o) => o.id)).toEqual([joint.id]);
    const history = await store.objectiveHistory(db as any, a);
    expect(history.map((o) => o.id)).toEqual([nomila.id]);
    expect(history[0]!.events.map((e) => e.action)).toEqual(["presented"]);
    expect((await store.reviewQueue(db as any, a)).map((o) => o.id)).toEqual([nomila.id]);
  });
});

describe("the database holds the line on its own", () => {
  it("refuses an active row without a yes, and a system event with a user", async () => {
    const [row] = await db.select().from(objectives).where(eq(objectives.athlete_id, a1)).limit(1);
    await expect(db.update(objectives).set({ lifecycle: "active", disposition: "unreviewed" }).where(eq(objectives.id, row!.id))).rejects.toThrow(/objectives_active_needs_yes/);
    await expect(db.insert(objectiveEvents).values({ objective_id: row!.id, athlete_id: a1, at: new Date(), actor_user_id: u1, actor_role: "system", action: "presented" } as any)).rejects.toThrow(/system_has_no_user/);
  });
});

describe("P5 — the store cannot destroy history", () => {
  it("exports nothing that deletes, and nothing that updates a set or an event", () => {
    const names = Object.keys(store);
    expect(names.filter((n) => /delete|remove|purge|truncate|updateEvent|updateSet|editSet/i.test(n))).toEqual([]);
  });
  it("athletes table is untouched by the module (sanity: seeds still there)", async () => {
    const rows = await db.select().from(athletes);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});
