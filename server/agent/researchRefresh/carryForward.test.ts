/**
 * carryForward.test.ts — the research refresh's Brief rule and Mila's suggestion (owner design, 12 Oct 2026), on the
 * in-memory store with the model faked at the transport (no provider, no database).
 *
 *   C1 no material change: the strategy (thesis, positioning, pillars, narrative) is carried forward word for word; the
 *      fact sections refresh; the input carries CURRENT BRIEF and marks the refresh's facts NEW; no suggestion
 *   C2 a material change on a NEW fact with a different strategy: a suggestion (before / after / what changed / reason /
 *      the new facts); her Brief still carries her strategy — nothing changes until she taps
 *   C3 "material" resting only on facts the Brief already had (rewording): no suggestion
 *   C4 "material" but the same strategy: no suggestion
 *   S1 storeProposal: one per Understand run; a newer one closes an older one still waiting
 *   S2 Update: her strategy becomes the suggestion; answered once (a second tap is 409)
 *   S3 Edit it: the suggestion with the positioning line in her words, marked hers — the next refresh shows it as hers
 *      and carries it forward
 *   S4 Keep mine: nothing changes; the same suggestion on the same facts is not raised again; a further new fact raises it
 *   S5 announce: ONE Mila message with the card, recorded on the suggestion (Home's row opens that chat), and ONE push of
 *      kind mila_suggestion that opens it — asked again, no second message (the push keeps its own once-per-key rule)
 */
jest.mock("../../db", () => ({ db: {} }));

import type { MemoryFact } from "../../../shared/agent";
import { FIXTURES, fakeResponses } from "../../testUtils/agentModel";
import { setResponsesTransport } from "../research/llm";
import { createMemoryStore, type AgentStore } from "../research/store";
import { understand } from "../research/understand";
import { announceProposal, answerProposal, homeCandidate, openProposal, proposalCard, storeProposal, SuggestionError, SUGGESTION_COPY, type Announcer } from "./proposal";

afterEach(() => setResponsesTransport(null));
const athleteId = "00000000-0000-4000-8000-0000000000cc";
const f = FIXTURES.college;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Strategy = { bigIdea: string; statement: string; pillar: string };
const MINE: Strategy = { bigIdea: "A conference champion with a clear story.", statement: "Results first.", pillar: "Race days" };
const NEW: Strategy = { bigIdea: "A national-team swimmer with a growing following.", statement: "From conference champion to national team.", pillar: "Team USA training" };

const model = (s: Strategy, cf: unknown, factKey = "f1") => ({
  stage: { label: "College junior", band: "developing", confidence: 0.8, why: "Roster.", refs: [factKey] },
  thesis: { big_idea: s.bigIdea, verdict: "Marketable regionally today." },
  sections: [{ key: "brand_now_next", title: "Brand", lines: [{ text: `Fresh line (${factKey === "f1" ? "old" : "new"} facts).`, kind: "fact", refs: [factKey] }], so_what: "Lead with results." }],
  positioning: { from: "A name on a roster", to: "The face of the program", statement: s.statement, pillars: [{ name: "Performance", line: "Results", refs: [factKey] }], refs: [factKey] },
  content_pillars: [{ key: "P1", name: s.pillar, why_this_athlete: "The results are on record.", refs: [factKey] }],
  internal: { current_sponsors: [], past_sponsors: [], exclusivity_conflicts: [] },
  narrative: `${s.bigIdea} Narrative.`,
  carry_forward: cf,
});

async function seed(): Promise<{ store: AgentStore; facts: MemoryFact[] }> {
  const store = createMemoryStore();
  const facts = await store.insertFacts(athleteId, f.pages.map((p) => ({
    subject: { kind: "athlete" as const, name: f.name }, claim: p.claim, type: "found" as const, source: { url: p.url, title: p.title },
    date: null, confidence: 0.9, runId: null,
  })));
  await sleep(30);
  setResponsesTransport(fakeResponses(() => ({ json: model(MINE, null) })));
  await understand({ store, athleteId, parentPrefix: "workflow:first" }, { athlete: f, facts, gaps: [], ageBand: null });
  await sleep(30);
  return { store, facts };
}

async function newFact(store: AgentStore, claim: string): Promise<MemoryFact> {
  const [x] = await store.insertFacts(athleteId, [{ subject: { kind: "athlete", name: f.name }, claim, type: "found", source: { url: `https://example.org/${encodeURIComponent(claim.slice(0, 12))}`, title: "News" }, date: null, confidence: 0.9, runId: null }]);
  return x;
}

const strategyOfBrief = (b: { sections: Array<{ key: string; lines: Array<{ text: string }> }>; display: any; summary: string }) => ({
  bigIdea: b.sections.find((s) => s.key === "thesis")!.lines[0].text,
  statement: b.display.positioning.statement,
  pillar: b.display.contentPillars[0]?.name,
  summary: b.summary,
});

async function refresh(store: AgentStore, json: unknown, prefix: string) {
  const facts = await store.listFacts(athleteId);
  const t = fakeResponses(() => ({ json }));
  setResponsesTransport(t);
  const carry = await store.currentBrief(athleteId);
  const u = await understand({ store, athleteId, parentPrefix: prefix }, { athlete: f, facts, gaps: [], ageBand: null, carry });
  return { u, input: String(t.calls[0].input), facts };
}

test("C1: no material change — the strategy is carried word for word, the fact sections refresh, NEW is marked, no suggestion", async () => {
  const { store } = await seed();
  const added = await newFact(store, "Priya Natarajan set a school record in the 100 fly in October 2026.");
  // The model rewords the strategy but says nothing material happened: rewording never changes her strategy.
  const { u, input, facts } = await refresh(store, model({ ...NEW }, { material_change: false, kinds: [], reason: "", refs: [] }, "f4"), "workflow:c1");
  expect(input).toContain("CURRENT BRIEF (the athlete has it");
  expect(input).toContain(`- Big idea: ${MINE.bigIdea}`);
  const key = `f${facts.findIndex((x) => x.id === added.id) + 1}`;
  expect(input).toContain(`${key} (NEW) |`);
  expect(input).not.toContain("f1 (NEW)");
  expect(u.carried).toBe(true);
  expect(u.proposal).toBeNull();
  const b = (await store.currentBrief(athleteId))!;
  expect(strategyOfBrief(b)).toMatchObject({ bigIdea: MINE.bigIdea, statement: MINE.statement, pillar: MINE.pillar });
  expect(b.summary).toContain(MINE.bigIdea);
  // The fact sections are the fresh ones.
  expect(b.sections.find((s) => s.key === "brand_now_next")!.lines[0].text).toBe("Fresh line (new facts).");
});

test("C2: a material change on a NEW fact with a new strategy — a suggestion; her Brief still carries hers", async () => {
  const { store } = await seed();
  const added = await newFact(store, "Priya Natarajan was named to the national team in October 2026.");
  const facts = await store.listFacts(athleteId);
  const key = `f${facts.findIndex((x) => x.id === added.id) + 1}`;
  const { u } = await refresh(store, model(NEW, { material_change: true, kinds: ["new_team_or_level"], reason: "You made the national team.", refs: [key] }, key), "workflow:c2");
  expect(u.proposal).toMatchObject({ kinds: ["new_team_or_level"], reason: "You made the national team.", factIds: [added.id] });
  expect(u.proposal!.changed).toEqual(expect.arrayContaining(["thesis", "positioning", "pillars", "narrative"]));
  expect(u.proposal!.before.positioning!.statement).toBe(MINE.statement);
  expect(u.proposal!.after.positioning!.statement).toBe(NEW.statement);
  expect(strategyOfBrief((await store.currentBrief(athleteId))!)).toMatchObject({ bigIdea: MINE.bigIdea, statement: MINE.statement, pillar: MINE.pillar });
});

test("C3: 'material' resting only on facts the Brief already had (rewording) — no suggestion", async () => {
  const { store } = await seed();
  const { u } = await refresh(store, model(NEW, { material_change: true, kinds: ["other_material"], reason: "Sharper words.", refs: ["f1"] }), "workflow:c3");
  expect(u.proposal).toBeNull();
  expect(strategyOfBrief((await store.currentBrief(athleteId))!).statement).toBe(MINE.statement);
});

test("C4: 'material' on a new fact but the same strategy — no suggestion", async () => {
  const { store } = await seed();
  const added = await newFact(store, "Priya Natarajan transferred to a new university in October 2026.");
  const facts = await store.listFacts(athleteId);
  const key = `f${facts.findIndex((x) => x.id === added.id) + 1}`;
  const { u } = await refresh(store, model(MINE, { material_change: true, kinds: ["new_team_or_level"], reason: "New school.", refs: [key] }, "f1"), "workflow:c4");
  expect(u.proposal).toBeNull();
});

async function suggested(prefix: string, claim: string) {
  const { store } = await seed();
  const added = await newFact(store, claim);
  const facts = await store.listFacts(athleteId);
  const key = `f${facts.findIndex((x) => x.id === added.id) + 1}`;
  const { u } = await refresh(store, model(NEW, { material_change: true, kinds: ["new_team_or_level"], reason: "You made the national team.", refs: [key] }, key), prefix);
  const s = await storeProposal(store, athleteId, { understandRunId: u.runId, workflowRunId: "wf-1", draft: u.proposal! });
  if (!s.stored) throw new Error("not stored");
  return { store, u, decisionId: s.decisionId, added };
}

test("S1: one suggestion per Understand run; a newer one closes an older one still waiting; Home shows the open one", async () => {
  const { store, u, decisionId } = await suggested("workflow:s1", "Priya Natarajan was named to the national team in October 2026.");
  expect(await storeProposal(store, athleteId, { understandRunId: u.runId, workflowRunId: "wf-1", draft: u.proposal! })).toEqual({ stored: true, decisionId, created: false, superseded: 0 });
  const second = await storeProposal(store, athleteId, { understandRunId: "another-run", workflowRunId: "wf-2", draft: u.proposal! });
  expect(second).toMatchObject({ stored: true, created: true, superseded: 1 });
  expect((await store.getDecision(athleteId, decisionId))!.response).toBe("expired");
  const open = (await openProposal(store, athleteId))!;
  expect(open.id).toBe((second as { decisionId: string }).decisionId);
  expect(await homeCandidate(store, athleteId)).toMatchObject({ kind: "mila_suggestion", target: { screen: "mila", decisionId: open.id } });
  const card = await proposalCard(store, athleteId, open);
  expect(card).toMatchObject({ kind: "brief-proposal", payload: { buttons: ["update", "keep_mine", "edit"], answered: null, before: { statement: MINE.statement }, after: { statement: NEW.statement } } });
  expect((card.payload as { sources: Array<{ label: string }> }).sources[0]).toMatchObject({ label: "News" });
});

test("S2: Update — her strategy becomes the suggestion, once (a second tap is 409); Home's row goes", async () => {
  const { store, decisionId } = await suggested("workflow:s2", "Priya Natarajan was named to the national team in October 2026.");
  const r = await answerProposal(store, athleteId, decisionId, { response: "update" });
  expect(r.decision.response).toBe("accepted");
  const b = (await store.currentBrief(athleteId))!;
  expect(b.id).toBe(r.briefId);
  expect(strategyOfBrief(b)).toMatchObject({ bigIdea: NEW.bigIdea, statement: NEW.statement, pillar: NEW.pillar });
  await expect(answerProposal(store, athleteId, decisionId, { response: "update" })).rejects.toMatchObject({ status: 409 });
  expect(await homeCandidate(store, athleteId)).toBeNull();
});

test("S3: Edit it — the suggestion in her words, marked hers; the next refresh shows it as hers and carries it forward", async () => {
  const { store, decisionId } = await suggested("workflow:s3", "Priya Natarajan was named to the national team in October 2026.");
  await expect(answerProposal(store, athleteId, decisionId, { response: "edit", statement: "   " })).rejects.toBeInstanceOf(SuggestionError);
  const r = await answerProposal(store, athleteId, decisionId, { response: "edit", statement: "National-team swimmer, still a student first." });
  expect(r.decision.response).toBe("edited");
  const b = (await store.currentBrief(athleteId))!;
  expect(b.display!.positioning.statement).toBe("National-team swimmer, still a student first.");
  expect(b.display!.editedByAthlete!.fields).toEqual(["statement"]);
  expect(b.sections.find((s) => s.key === "positioning")!.lines.map((l) => l.text)).toContain("National-team swimmer, still a student first.");
  await sleep(30);
  const { input } = await refresh(store, model(NEW, { material_change: false, kinds: [], reason: "", refs: [] }), "workflow:s3b");
  expect(input).toContain("- Positioning statement: National-team swimmer, still a student first. (written by the athlete)");
  const after = (await store.currentBrief(athleteId))!;
  expect(after.display!.positioning.statement).toBe("National-team swimmer, still a student first.");
  expect(after.display!.editedByAthlete!.fields).toEqual(["statement"]);
});

test("S5: announce — one Mila message with the card (Home's row then opens that chat) and one mila_suggestion push", async () => {
  const { store, decisionId } = await suggested("workflow:s5", "Priya Natarajan was named to the national team in October 2026.");
  const posted: unknown[] = []; const pushes: any[] = [];
  const announcer: Announcer = { postSuggestion: async (_a, card) => { posted.push(card); return "chat-1"; }, push: async (_a, e) => { pushes.push(e); return { status: "sent" }; } };
  expect(await announceProposal(store, athleteId, decisionId, announcer)).toMatchObject({ conversationId: "chat-1" });
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ kind: "brief-proposal", payload: { decisionId } });
  expect(pushes[0]).toEqual({ kind: "mila_suggestion", dedupeKey: `mila_suggestion:${decisionId}`, title: SUGGESTION_COPY.pushTitle, body: SUGGESTION_COPY.pushBody, target: { screen: "mila", id: "chat-1" } });
  expect(await homeCandidate(store, athleteId)).toMatchObject({ target: { screen: "mila", conversationId: "chat-1", decisionId } });
  await announceProposal(store, athleteId, decisionId, announcer);
  expect(posted).toHaveLength(1);
  // Answered: nothing more is announced.
  await answerProposal(store, athleteId, decisionId, { response: "keep_mine" });
  await announceProposal(store, athleteId, decisionId, announcer);
  expect(pushes).toHaveLength(2);
});

test("S4: Keep mine — nothing changes; the same suggestion on the same facts is not raised again; a further new fact raises it", async () => {
  const { store, u, decisionId } = await suggested("workflow:s4", "Priya Natarajan was named to the national team in October 2026.");
  const r = await answerProposal(store, athleteId, decisionId, { response: "keep_mine" });
  expect(r).toMatchObject({ briefId: null, decision: { response: "skipped", responseReason: "keep_mine" } });
  expect(strategyOfBrief((await store.currentBrief(athleteId))!).statement).toBe(MINE.statement);
  expect(await storeProposal(store, athleteId, { understandRunId: "later-run", workflowRunId: "wf-3", draft: u.proposal! })).toEqual({ stored: false, reason: "kept_mine_same_facts" });
  const further = await newFact(store, "Priya Natarajan signed with a national swimwear brand in October 2026.");
  const raised = await storeProposal(store, athleteId, { understandRunId: "later-run-2", workflowRunId: "wf-4", draft: { ...u.proposal!, factIds: [...u.proposal!.factIds, further.id] } });
  expect(raised).toMatchObject({ stored: true, created: true });
});

test("C5: 'material' with no listed kind — no suggestion", async () => {
  const { store } = await seed();
  const added = await newFact(store, "Priya Natarajan was named to the national team in October 2026.");
  const facts = await store.listFacts(athleteId);
  const key = `f${facts.findIndex((x) => x.id === added.id) + 1}`;
  const { u } = await refresh(store, model(NEW, { material_change: true, kinds: [], reason: "Sharper words.", refs: [key] }, key), "workflow:c5");
  expect(u.proposal).toBeNull();
  expect(strategyOfBrief((await store.currentBrief(athleteId))!).statement).toBe(MINE.statement);
});

test("S6: her Edit lands while a refresh's model runs — the refresh carries her words, never the Brief it started from", async () => {
  const { store, decisionId } = await suggested("workflow:s6", "Priya Natarajan was named to the national team in October 2026.");
  await sleep(30);
  const facts = await store.listFacts(athleteId);
  const carry = await store.currentBrief(athleteId);
  setResponsesTransport(fakeResponses(async () => {
    await answerProposal(store, athleteId, decisionId, { response: "edit", statement: "My words, mid-refresh." });
    return { json: model(MINE, { material_change: false, kinds: [], reason: "", refs: [] }) };
  }));
  await understand({ store, athleteId, parentPrefix: "workflow:s6b" }, { athlete: f, facts, gaps: [], ageBand: null, carry });
  const b = (await store.currentBrief(athleteId))!;
  expect(b.display!.positioning.statement).toBe("My words, mid-refresh.");
  expect(b.display!.editedByAthlete!.fields).toEqual(["statement"]);
});

test("S7: after Edit it, an Update to a later suggestion replaces her statement — and it is no longer marked hers", async () => {
  const { store, decisionId, u } = await suggested("workflow:s7", "Priya Natarajan was named to the national team in October 2026.");
  await answerProposal(store, athleteId, decisionId, { response: "edit", statement: "Mine, in my words." });
  const later = await storeProposal(store, athleteId, { understandRunId: "later-run-s7", workflowRunId: "wf-s7", draft: { ...u.proposal!, factIds: [...u.proposal!.factIds, (await newFact(store, "Priya Natarajan won a national title in October 2026.")).id] } });
  if (!later.stored) throw new Error("not stored");
  await answerProposal(store, athleteId, later.decisionId, { response: "update" });
  const b = (await store.currentBrief(athleteId))!;
  expect(b.display!.positioning.statement).toBe(NEW.statement);
  expect(b.display!.editedByAthlete).toBeUndefined();
});
