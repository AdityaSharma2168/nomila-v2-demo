/**
 * mergeCompact.test.ts — RESEARCH_MERGE_COMPACT (research/merge-compact 1.0.0): the merge answers by key and returns only
 * what it changes; code rebuilds the full merged fact before anything stores or reads it. On the in-memory store with
 * the model mocked (no provider is reached).
 *
 *   MC1 the same judgement answered compact writes exactly the facts the full answer writes (claims, sources, statuses,
 *       disputes, care, topic, subject, dates, identity fields) and stores the same full-shape run output
 *   MC2 the request: the compact skill (its own id and version, so the prompt cache and the trace say which ran) and the
 *       compact schema; flag off is the full merge, unchanged
 *   MC3 expandCompactMerge: a field not in `set` keeps the first PASS fact's value (a post never is the base), a set
 *       value wins, care follows the passes, a post-only fact keeps only what it set
 */
jest.mock("../../db", () => ({ db: {} }));

import { FIXTURES, fakeResponses, passAnswer, skillOf } from "../../testUtils/agentModel";
import { setResponsesTransport } from "./llm";
import { expandCompactMerge, mergePasses, searchPass, type JobContext, type PassFact } from "./research";
import { MERGE_COMPACT_SCHEMA, MERGE_SCHEMA } from "./schemas";
import { createMemoryStore } from "./store";

const athleteId = "00000000-0000-4000-8000-000000000002";
const ctx = (store = createMemoryStore()): JobContext => ({ store, athleteId, parentPrefix: "workflow:compact", today: "2026-10-09" });

afterEach(() => { setResponsesTransport(null); delete process.env.RESEARCH_MERGE_COMPACT; });

const f = FIXTURES.pro;
/** One judgement, written both ways. a1+b1 conflict with what the athlete said; a2 is re-worded; a3 duplicates e2. */
const FULL = {
  facts: [
    { from: ["a1", "b1"], subject_kind: "athlete", subject_name: f.name, claim: f.pages[0].claim, topic: "team", date: "2026-10", confidence: 0.95, sensitivity: "none", care_kind: "none", never_reason: "none", conflicts_with: "e1", duplicate_of: "", note: "club differs", field: "team", field_value: "a professional basketball club" },
    { from: ["a2"], subject_kind: "athlete", subject_name: f.name, claim: "Tomasz Reyes signed a multi-year footwear endorsement in 2024 (status unclear).", topic: "sponsor", date: "2024-03-01", confidence: 0.9, sensitivity: "care", care_kind: "personal", never_reason: "none", conflicts_with: "", duplicate_of: "", note: "", field: "none", field_value: "" },
    { from: ["a3", "b3"], subject_kind: "athlete", subject_name: f.name, claim: f.pages[2].claim, topic: "achievement", date: "2026-02-10", confidence: 0.9, sensitivity: "none", care_kind: "none", never_reason: "none", conflicts_with: "", duplicate_of: "e2", note: "", field: "none", field_value: "" },
  ],
  dropped: [{ key: "b2", reason: "same as a2" }],
  narrative: "Merged.",
};
const COMPACT = {
  facts: [
    { from: ["a1", "b1"], confidence: 0.95, set: [{ key: "conflicts_with", value: "e1" }, { key: "note", value: "club differs" }, { key: "field", value: "team" }, { key: "field_value", value: "a professional basketball club" }] },
    { from: ["a2"], confidence: 0.9, set: [{ key: "claim", value: "Tomasz Reyes signed a multi-year footwear endorsement in 2024 (status unclear)." }, { key: "sensitivity", value: "care" }, { key: "care_kind", value: "personal" }] },
    { from: ["a3", "b3"], confidence: 0.9, set: [{ key: "duplicate_of", value: "e2" }] },
  ],
  dropped: [{ key: "b2", reason: "same as a2" }],
  narrative: "Merged.",
};

async function runMerge(compact: boolean) {
  if (compact) process.env.RESEARCH_MERGE_COMPACT = "true"; else delete process.env.RESEARCH_MERGE_COMPACT;
  const store = createMemoryStore();
  await store.insertFacts(athleteId, [
    { subject: { kind: "athlete", name: f.name }, claim: `${f.name} plays for a club in another city.`, type: "said", source: { ref: "onboarding/x#correction" }, date: "2026-10-01", confidence: 1, runId: null },
    { subject: { kind: "athlete", name: f.name }, claim: `${f.name} was an all-star in 2026.`, type: "found", source: { url: "https://old.example.org/a" }, date: "2026-02-10", confidence: 0.9, runId: null },
  ]);
  const transport = fakeResponses((body) => (skillOf(body) === "research" ? passAnswer(f) : { json: compact ? COMPACT : FULL }));
  setResponsesTransport(transport);
  const c = ctx(store);
  const existing = await store.listFacts(athleteId);
  const a = await searchPass(c, { pass: "a", athlete: f, connectedSummary: "", existing });
  const b = await searchPass(c, { pass: "b", athlete: f, connectedSummary: "", existing });
  const m = await mergePasses(c, { athlete: f, a, b, existing });
  const run = await store.getRun(athleteId, m.runId);
  const facts = (await store.listFacts(athleteId)).map(({ id: _i, runId: _r, createdAt: _c, disputes, ...x }) => ({ ...x, disputes: disputes ? "set" : null }));
  return { m, run, facts, request: transport.calls[transport.calls.length - 1] };
}

test("MC1: the compact answer writes exactly the facts the full answer writes, and stores the same full output", async () => {
  const full = await runMerge(false);
  const compact = await runMerge(true);
  expect(compact.facts).toEqual(full.facts);
  expect(compact.m.inserted.map((x) => x.claim)).toEqual([f.pages[0].claim, "Tomasz Reyes signed a multi-year footwear endorsement in 2024 (status unclear)."]);
  expect(compact.m.duplicates).toBe(full.m.duplicates);
  expect(compact.m.dropped).toEqual(full.m.dropped);
  expect(compact.m.inserted[0].status).toBe("disputed");
  expect(compact.m.inserted[1]).toMatchObject({ sensitive: true, careKind: "personal", topic: "sponsor" });
  // The stored output is the full shape (every reader of the run sees what the full merge stores).
  expect((compact.run!.output as any).json).toEqual((full.run!.output as any).json);
});

test("MC2: flag on runs the compact skill and schema; flag off is the full merge, unchanged", async () => {
  const full = await runMerge(false);
  const compact = await runMerge(true);
  expect(skillOf(full.request)).toBe("research/merge");
  expect(full.request.text.format.schema).toEqual(MERGE_SCHEMA);
  expect(full.run!.skillId).toBe("research/merge");
  expect(skillOf(compact.request)).toBe("research/merge-compact");
  expect(compact.request.text.format.schema).toEqual(MERGE_COMPACT_SCHEMA);
  expect(compact.run!.skillId).toBe("research/merge-compact");
  expect(compact.request.instructions).toMatch(/return only what you change/);
  // Same input either way: only the instructions' output section and the schema differ.
  expect(compact.request.input).toBe(full.request.input);
});

test("MC3: expandCompactMerge — an unset field keeps the first pass fact's value, a set value wins, care follows the passes", () => {
  const pass = (key: string, o: Partial<PassFact> = {}): PassFact => ({
    key, subject_kind: "athlete", subject_name: "A B", claim: `claim ${key}`, topic: "career", source_url: `https://x.example/${key}`, source_title: "",
    source_type: "other", date: "2025", confidence: 0.8, care: false, careKind: null, ...o,
  });
  const byKey = new Map([["a1", pass("a1")], ["b4", pass("b4", { care: true, careKind: "personal", topic: "status", date: "2026-01" })]]);
  const out = expandCompactMerge({ facts: [
    { from: ["p1", "b4", "a1"], confidence: 0.7, set: [] },
    { from: ["a1"], confidence: 0.6, set: [{ key: "claim", value: "rewritten" }, { key: "topic", value: "team" }, { key: "subject_kind", value: "organization" }, { key: "subject_name", value: "Club" }, { key: "conflicts_with", value: "e2" }, { key: "note", value: "n" }] },
    { from: ["p2"], confidence: 0.9, set: [{ key: "claim", value: "From her own post." }, { key: "topic", value: "sponsor" }] },
  ], dropped: [], narrative: "x" }, byKey);
  expect(out.facts[0]).toEqual({
    from: ["p1", "b4", "a1"], subject_kind: "athlete", subject_name: "A B", claim: "claim b4", topic: "status", date: "2026-01", confidence: 0.7,
    sensitivity: "care", care_kind: "none", never_reason: "none", conflicts_with: "", duplicate_of: "", note: "", field: "none", field_value: "",
  });
  expect(out.facts[1]).toMatchObject({ claim: "rewritten", topic: "team", subject_kind: "organization", subject_name: "Club", date: "2025", sensitivity: "none", conflicts_with: "e2" });
  expect(out.facts[2]).toMatchObject({ claim: "From her own post.", topic: "sponsor", subject_kind: "athlete", subject_name: "", date: "" });
  expect(out.narrative).toBe("x");
});
