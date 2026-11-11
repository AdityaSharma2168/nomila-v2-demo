/**
 * factsOnlyNoEcho.test.ts — facts-eval-spec/0.6.0 (MIA_FACTS_NO_EVIDENCE_ECHO): the Gemini facts-only evaluator stops
 * copying the facts it cites into its "evidence" list; code rebuilds that list from the snapshot it sent. Pure: no
 * database, no provider.
 *
 *   NE1 0.4.0 stays the default and byte-identical (its digest is pinned); 0.6.0 is 0.4.0 plus ONE paragraph
 *   NE2 the version follows the flag on Gemini only; the OpenAI evaluator (0.5.0) is untouched
 *   NE3 evidenceFromSnapshot rebuilds one item per cited id the block lists — the fact's own claim, source and date,
 *       its outlet type in the rubric's words, and platform:<p> for the authoritative block — in first-cited order
 *   NE4 the rebuilt list keeps the lineage and the dangling-id check the ledger runs (groundCitations) as they were
 */
jest.mock("../../db", () => ({ db: {} }));

import { createHash } from "node:crypto";
import { groundCitations, groundingContextFor } from "../marketabilityCitationLineage";
import {
  CANONICAL_FACTS_EVALUATOR_TEXT, CANONICAL_FACTS_EVALUATOR_TEXT_NO_ECHO, FACTS_ONLY_ADDITIONS, FACT_SOURCE_CLASS, MEMORY_PLATFORM,
  MIA_FACTS_EVALUATOR_VERSION, MIA_FACTS_PROMPT_VERSION, MIA_FACTS_PROMPT_VERSION_NO_ECHO, NO_EVIDENCE_ECHO_ADDITION,
  citedEvidenceIds, evidenceFromSnapshot, factsOnlyPrompt, miaFactsEvaluatorVersion, rubricSourceType,
} from "./factsOnlySpec";
import { composeFactsOnlyBlock, type PreviewFact } from "./memoryAdapter";
import { evidenceFor } from "../marketabilityLedgerMapping";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

afterEach(() => { delete process.env.MIA_FACTS_NO_EVIDENCE_ECHO; delete process.env.MIA_FACTS_EVALUATOR_PROVIDER; });

test("NE1: 0.4.0 is unchanged and the default; 0.6.0 adds exactly one paragraph", () => {
  // The 0.4.0 text as it was before 0.6.0 existed. A change here edits a frozen, versioned prompt: make a new version.
  expect(sha(CANONICAL_FACTS_EVALUATOR_TEXT)).toBe("f58b80f1280ad5edd7a646c0eb6fee45b15bbbdea2e549becb61d2836d483056");
  expect(factsOnlyPrompt({ name: "A", sport: "B" }, null)).toBe(factsOnlyPrompt({ name: "A", sport: "B" }, null, MIA_FACTS_PROMPT_VERSION));
  expect(CANONICAL_FACTS_EVALUATOR_TEXT_NO_ECHO).toBe(CANONICAL_FACTS_EVALUATOR_TEXT.replace(FACTS_ONLY_ADDITIONS, `${FACTS_ONLY_ADDITIONS}\n\n${NO_EVIDENCE_ECHO_ADDITION}`));
  expect(sha(CANONICAL_FACTS_EVALUATOR_TEXT_NO_ECHO)).toBe("6f74b86df85d8e1afa7985bed1e31ba840ded1e36467a78ef6fa6bf98746761e");
  expect(NO_EVIDENCE_ECHO_ADDITION).toContain(`EVIDENCE LIST (${MIA_FACTS_PROMPT_VERSION_NO_ECHO})`);
  expect(NO_EVIDENCE_ECHO_ADDITION).toContain('return "evidence": []');
  expect(CANONICAL_FACTS_EVALUATOR_TEXT).not.toContain("EVIDENCE LIST");
});

test("NE2: the flag selects 0.6.0 on Gemini only", () => {
  expect(miaFactsEvaluatorVersion("gemini")).toBe("facts-eval-spec/0.4.1");
  process.env.MIA_FACTS_NO_EVIDENCE_ECHO = "true";
  expect(miaFactsEvaluatorVersion("gemini")).toBe("facts-eval-spec/0.6.1");
  expect(miaFactsEvaluatorVersion()).toBe("facts-eval-spec/0.6.1");
  expect(miaFactsEvaluatorVersion("openai")).toBe(MIA_FACTS_EVALUATOR_VERSION);
  process.env.MIA_FACTS_NO_EVIDENCE_ECHO = "1";
  expect(miaFactsEvaluatorVersion("gemini")).toBe("facts-eval-spec/0.4.1");
});

const fact = (n: number, o: Partial<PreviewFact> = {}): PreviewFact => ({
  id: `00000000-0000-4000-8000-00000000000${n}`, type: "found", status: "active", claim: `Fact number ${n} about the athlete.`,
  subjectKind: "athlete", subjectName: "Sam Lee", sourceUrl: `https://news.example.com/story-${n}`, sourceRef: null, sourceTitle: `Story ${n}`,
  observedOn: "2026-05-0" + n, confidence: 0.9, sensitive: false, careKind: null, disputes: null, createdAt: "2026-10-01T00:00:00.000Z", ...o,
});

const accounts = [{ platform: "instagram", handle: "samlee", observedAt: "2026-10-20T00:00:00.000Z", source: "connected_verified", identityBasis: "athlete-connected account (OAuth)", identityConfidence: "HIGH", metrics: { followers: 12345 } }] as any;

test("NE3: the evidence list is rebuilt from the block, one item per cited id, in first-cited order", () => {
  const f1 = fact(1), f2 = fact(2, { sourceUrl: null, sourceRef: "onboarding/x#said", sourceTitle: null, observedOn: null }), f3 = fact(3, { subjectKind: "organization", subjectName: "City FC" });
  const block = composeFactsOnlyBlock(accounts, [f1, f2], [], [f3]);
  const outlet = (id: string) => (id === f1.id ? "official" : id === f3.id ? "local" : null);
  const ev = evidenceFromSnapshot(block, [f3.id, "platform:instagram", f1.id, `[${f1.id}]`, f2.id, "E7", "platform:tiktok"], outlet);
  expect(ev.map((e) => e.id)).toEqual([f3.id, "platform:instagram", f1.id, f2.id]);
  expect(ev[0]).toEqual({ id: f3.id, claim: f3.claim, sourceTitle: "Story 3", sourceUrl: "https://news.example.com/story-3", sourceType: "secondary", date: "2026-05-03" });
  expect(ev[1]).toMatchObject({ id: "platform:instagram", sourceType: "platform", sourceUrl: null, date: "2026-10-20" });
  expect(ev[1].claim).toMatch(/^instagram @samlee — /);
  expect(ev[2]).toEqual({ id: f1.id, claim: f1.claim, sourceTitle: "Story 1", sourceUrl: "https://news.example.com/story-1", sourceType: "official", date: "2026-05-01" });
  expect(ev[3]).toEqual({ id: f2.id, claim: f2.claim, sourceTitle: "onboarding/x#said", sourceUrl: null, sourceType: null, date: null });
  expect(rubricSourceType("major_media")).toBe("major_media");
  expect(rubricSourceType("social")).toBe("secondary");
  expect(rubricSourceType(null)).toBeNull();
  // The notes' citations count too (0.4.0 tags them).
  const ids = citedEvidenceIds({ judgements: [{ evidenceIds: ["a"] } as any] }, { keyStrengths: [{ text: "x", dimension: "momentum", evidenceIds: ["b"] }], keyConstraints: [], importantMissingData: [], summary: null });
  expect(ids).toEqual(["a", "b"]);
});

test("NE4: the rebuilt list keeps every supplied citation resolvable and Nomila-supplied, as the echo did", () => {
  const f1 = fact(1), f2 = fact(2);
  const block = composeFactsOnlyBlock(accounts, [f1, f2], [], []);
  const sources = [
    { platform: "instagram", accountId: "samlee", sourceClass: "connected_verified" },
    { platform: MEMORY_PLATFORM, accountId: f1.id, sourceClass: FACT_SOURCE_CLASS },
    { platform: MEMORY_PLATFORM, accountId: f2.id, sourceClass: FACT_SOURCE_CLASS },
  ];
  const ctx = groundingContextFor({ text: "", native: { groundingChunks: [], groundingSupports: [] } }, { social_block: block, social_sources: sources });
  const evidence = evidenceFor({ evidence: evidenceFromSnapshot(block, [f1.id, "platform:instagram"]) });
  const finding = { key: "momentum", value: 50, confidence: null, rationale: null, citedEvidence: [f1.id, "platform:instagram"], components: [] } as any;
  const g = groundCitations([finding], evidence, ctx);
  expect(g.findings[0].citedEvidence).toEqual([f1.id, "platform:instagram"]);
  expect(g.findings[0].danglingEvidence).toBeUndefined();
  expect(g.evidence.map((e) => e.lineage?.level)).toEqual(["nomila_supplied", "nomila_supplied"]);
});
