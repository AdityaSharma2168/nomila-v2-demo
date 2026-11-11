/**
 * factsOnlyRefs.test.ts — the facts-only evaluator is shown each fact under a short reference (F1 … Fn), not its full
 * id, and code resolves the references back before the answer is held to the contract. Why: a dev run cited the first 8
 * characters of every UUID, every citation was unknown, and the athlete ended "not assessed".
 * Pure: no database, no provider. Made-up athletes only.
 *
 *   R1 the prompt lists F1 … Fn in block order, never a full fact id; the stored block is untouched
 *   R2 short references resolve to the full fact ids, and the signals stay scored through enforceFactsOnly
 *   R3 a reference the prompt never showed (and a truncated UUID) is dropped as unknown, and counted
 *   R4 an answer that cites full UUIDs (the old way) still works
 *   R5 a mixed answer (short refs, full ids, platform:<p>, brackets, lower case) resolves each kind
 *   R6 the map is per block (two runs never share references), a fact listed twice keeps one reference, and F0 / F01 /
 *      a reference past the last fact are unknown
 *   R7 runs record x.y.1 (they saw short references); the prompt text keeps its 0.4.0 / 0.6.0 versions
 */
jest.mock("../../db", () => ({ db: {} }));

import type { EvaluatorOutput } from "../marketabilityBeta1Evaluator";
import {
  CANONICAL_FACTS_EVALUATOR_TEXT, CANONICAL_FACTS_EVALUATOR_TEXT_NO_ECHO, FACT_SOURCE_CLASS, MEMORY_PLATFORM, MIA_FACTS_EVALUATOR_VERSION,
  MIA_FACTS_EVALUATOR_VERSION_GEMINI, MIA_FACTS_EVALUATOR_VERSION_GEMINI_NO_ECHO, MIA_FACTS_PROMPT_VERSION, MIA_FACTS_PROMPT_VERSION_NO_ECHO, allowedFromSources, enforceFactsOnly, factRefs, factsOnlyPrompt, resolveFactRefs, type TaggedNotes,
} from "./factsOnlySpec";
import { composeFactsOnlyBlock, type PreviewFact } from "./memoryAdapter";

const fact = (n: number, o: Partial<PreviewFact> = {}): PreviewFact => ({
  id: `0f82fc1e-0000-4000-8000-00000000000${n}`, type: "found", status: "active", claim: `Fact number ${n} about the athlete.`,
  subjectKind: "athlete", subjectName: "Sam Lee", sourceUrl: `https://news.example.com/story-${n}`, sourceRef: null, sourceTitle: `Story ${n}`,
  observedOn: "2026-05-0" + n, confidence: 0.9, sensitive: false, careKind: null, disputes: null, createdAt: "2026-10-01T00:00:00.000Z", ...o,
});
const accounts = [{ platform: "instagram", handle: "samlee", observedAt: "2026-10-20T00:00:00.000Z", source: "connected_verified", identityBasis: "athlete-connected account (OAuth)", identityConfidence: "HIGH", metrics: { followers: 12345 } }] as any;

const f1 = fact(1), f2 = fact(2), f3 = fact(3);
const block = composeFactsOnlyBlock(accounts, [f1, f2, f3], [], []);
const sources = [
  ...[f1, f2, f3].map((f) => ({ platform: MEMORY_PLATFORM, accountId: f.id, sourceClass: FACT_SOURCE_CLASS })),
  { platform: "instagram", accountId: "samlee" },
];
const allowed = allowedFromSources(sources);

const signal = (key: string, evidenceIds: string[]) => ({ dimension: "momentum", key, status: "scored" as const, score: 70, confidence: "MEDIUM", evidenceIds, rationale: "r" });
const output = (judgements: any[], evidence: any[] = []): EvaluatorOutput => ({ judgements, evidence, keyStrengths: [], keyConstraints: [], importantMissingData: [], summary: null, summaryWords: 0 } as any);
const noNotes = (): TaggedNotes => ({ keyStrengths: [], keyConstraints: [], importantMissingData: [], summary: null });

test("R1: the prompt shows F1 … Fn in block order and never a full fact id; the stored block keeps the ids", () => {
  const { block: shown, refs } = factRefs(block);
  expect([...refs]).toEqual([["F1", f1.id], ["F2", f2.id], ["F3", f3.id]]);
  expect(shown).toContain(`- [F1] ${f1.claim}`);
  expect(shown).toContain(`- [F3] ${f3.claim}`);
  const prompt = factsOnlyPrompt({ name: "Sam Lee", sport: "Soccer" }, block);
  for (const f of [f1, f2, f3]) expect(prompt).not.toContain(f.id);
  expect(prompt).toContain(`- [F2] ${f2.claim}`);
  expect(block).toContain(`- [${f1.id}] `);                                  // the snapshot block itself is untouched
  expect(factRefs(block).refs).toEqual(refs);                                 // the same block always gives the same map
  expect(factRefs(null)).toEqual({ block: "", refs: new Map() });
});

test("R2: short references resolve to the full ids and the signals stay scored", () => {
  const { refs } = factRefs(block);
  const notes: TaggedNotes = { ...noNotes(), keyStrengths: [{ text: "Strong recent form.", dimension: "momentum", evidenceIds: ["F2"] }] };
  const r = resolveFactRefs(output([signal("a", ["F1", "F3"]), signal("b", ["F2"])], [{ id: "F1", claim: "c" }]), notes, refs);
  expect(r.output.judgements.map((j) => j.evidenceIds)).toEqual([[f1.id, f3.id], [f2.id]]);
  expect(r.output.evidence[0].id).toBe(f1.id);
  expect(r.notes!.keyStrengths[0].evidenceIds).toEqual([f2.id]);
  expect(r.resolution).toEqual({ resolved: 4, unknownRefs: 0, fullIds: 0 });
  const held = enforceFactsOnly(r.output, allowed, r.notes);
  expect(held.output.judgements.every((j) => j.status === "scored")).toBe(true);
  expect(held.enforcement.unknownIds).toEqual({});
  expect(held.output.keyStrengths).toEqual(["Strong recent form."]);
});

test("R3: a reference the prompt never showed is dropped as unknown, and counted", () => {
  const { refs } = factRefs(block);
  const r = resolveFactRefs(output([signal("a", ["F9"]), signal("b", ["F1", "0f82fc1e"])]), noNotes(), refs);
  expect(r.resolution).toEqual({ resolved: 1, unknownRefs: 1, fullIds: 0 });
  const held = enforceFactsOnly(r.output, allowed, r.notes);
  expect(held.enforcement.unknownIds).toEqual({ "momentum.a": ["F9"], "momentum.b": ["0f82fc1e"] });
  expect(held.enforcement.demoted).toEqual(["momentum.a"]);                    // nothing valid left: missing, as today
  expect(held.output.judgements[1]).toMatchObject({ status: "scored", evidenceIds: [f1.id] });
});

test("R4: an answer citing full UUIDs (the old way) still works", () => {
  const { refs } = factRefs(block);
  const r = resolveFactRefs(output([signal("a", [f1.id, `[${f2.id.toUpperCase()}]`])]), noNotes(), refs);
  expect(r.resolution).toEqual({ resolved: 0, unknownRefs: 0, fullIds: 2 });
  const held = enforceFactsOnly(r.output, allowed, r.notes);
  expect(held.output.judgements[0]).toMatchObject({ status: "scored", evidenceIds: [f1.id, f2.id] });
});

test("R5: a mixed answer resolves each kind", () => {
  const { refs } = factRefs(block);
  const r = resolveFactRefs(output([signal("a", ["[F1]", f2.id, "platform:instagram", " f3 ", "F1", "F12"])]), noNotes(), refs);
  const held = enforceFactsOnly(r.output, allowed, r.notes);
  expect(held.output.judgements[0]).toMatchObject({ status: "scored", evidenceIds: [f1.id, f2.id, "platform:instagram", f3.id] });
  expect(held.enforcement.unknownIds).toEqual({ "momentum.a": ["F12"] });
  expect(r.resolution).toEqual({ resolved: 3, unknownRefs: 1, fullIds: 1 });
});

test("R6: the map is per block; a repeated fact keeps one reference; out-of-range references are unknown", () => {
  const other = composeFactsOnlyBlock(accounts, [f3, f1], [], []);
  expect([...factRefs(other).refs]).toEqual([["F1", f3.id], ["F2", f1.id]]);       // built from its own block, nothing carried over
  expect([...factRefs(block).refs]).toEqual([["F1", f1.id], ["F2", f2.id], ["F3", f3.id]]);
  const line = block.split("\n").find((l) => l.startsWith(`- [${f2.id}] `))!;
  const twice = factRefs(`${block}\n${line}`);
  expect(twice.refs.size).toBe(3);
  expect(twice.block.split("\n").filter((l) => l.startsWith("- [F2] "))).toHaveLength(2);
  const r = resolveFactRefs(output([signal("a", ["F0", "F01", "F4", "F2"])]), noNotes(), factRefs(block).refs);
  expect(r.resolution).toEqual({ resolved: 1, unknownRefs: 3, fullIds: 0 });
  expect(r.output.judgements[0].evidenceIds).toEqual(["F0", "F01", "F4", f2.id]);
});

test("R7: every run records the x.y.1 version (short references); the prompt text keeps 0.4.0 / 0.6.0", () => {
  expect([MIA_FACTS_EVALUATOR_VERSION_GEMINI, MIA_FACTS_EVALUATOR_VERSION, MIA_FACTS_EVALUATOR_VERSION_GEMINI_NO_ECHO])
    .toEqual(["facts-eval-spec/0.4.1", "facts-eval-spec/0.5.1", "facts-eval-spec/0.6.1"]);
  expect([MIA_FACTS_PROMPT_VERSION, MIA_FACTS_PROMPT_VERSION_NO_ECHO]).toEqual(["facts-eval-spec/0.4.0", "facts-eval-spec/0.6.0"]);
  expect(CANONICAL_FACTS_EVALUATOR_TEXT).toContain("FACTS-ONLY ADDITIONS (facts-eval-spec/0.4.0)");
  expect(CANONICAL_FACTS_EVALUATOR_TEXT_NO_ECHO).toContain("EVIDENCE LIST (facts-eval-spec/0.6.0)");
  expect(CANONICAL_FACTS_EVALUATOR_TEXT).not.toMatch(/0\.[456]\.1/);
});
