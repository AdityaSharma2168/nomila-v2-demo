/**
 * factsOnlyEvidenceComplete.test.ts — the default facts-only evaluator (facts-eval-spec/0.4.0, Gemini) echoes an
 * "evidence" list that leaves out some of the facts it cites; the orchestrator completes it from the snapshot it sent.
 * Pure: no database, no provider. Made-up athletes only.
 *
 *   EC1 the 0.4.0 prompt text is unchanged (its digest is pinned): the fix is code after the answer, not prompt
 *   EC2 evidenceFromSnapshot rebuilds one item per cited id the block lists, in first-cited order; ids the block does
 *       not list are never invented
 *   EC3 completeEvidence keeps every echoed item as it came back and appends only the cited ids the echo left out
 *       (an echo written as "[<UUID>]" or "PLATFORM:instagram" still counts as present)
 *   EC4 completing the list leaves the enforced judgements (and their digest) identical, and the citations that
 *       dangled now resolve, Nomila-supplied
 */
jest.mock("../../db", () => ({ db: {} }));

import { createHash } from "node:crypto";
import { judgementsDigest, type EvaluatorOutput } from "../marketabilityBeta1Evaluator";
import { groundCitations, groundingContextFor } from "../marketabilityCitationLineage";
import { evidenceFor } from "../marketabilityLedgerMapping";
import {
  CANONICAL_FACTS_EVALUATOR_TEXT, FACT_SOURCE_CLASS, MEMORY_PLATFORM,
  allowedFromSources, citedEvidenceIds, completeEvidence, enforceFactsOnly, evidenceFromSnapshot, rubricSourceType,
} from "./factsOnlySpec";
import { composeFactsOnlyBlock, type PreviewFact } from "./memoryAdapter";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const fact = (n: number, o: Partial<PreviewFact> = {}): PreviewFact => ({
  id: `00000000-0000-4000-8000-00000000000${n}`, type: "found", status: "active", claim: `Fact number ${n} about the athlete.`,
  subjectKind: "athlete", subjectName: "Sam Lee", sourceUrl: `https://news.example.com/story-${n}`, sourceRef: null, sourceTitle: `Story ${n}`,
  observedOn: "2026-05-0" + n, confidence: 0.9, sensitive: false, careKind: null, disputes: null, createdAt: "2026-10-01T00:00:00.000Z", ...o,
});

const accounts = [{ platform: "instagram", handle: "samlee", observedAt: "2026-10-20T00:00:00.000Z", source: "connected_verified", identityBasis: "athlete-connected account (OAuth)", identityConfidence: "HIGH", metrics: { followers: 12345 } }] as any;

test("EC1: the 0.4.0 prompt text is unchanged", () => {
  expect(sha(CANONICAL_FACTS_EVALUATOR_TEXT)).toBe("f58b80f1280ad5edd7a646c0eb6fee45b15bbbdea2e549becb61d2836d483056");
});

test("EC2: the evidence list is rebuilt from the block, one item per cited id, in first-cited order", () => {
  const f1 = fact(1), f2 = fact(2, { sourceUrl: null, sourceRef: "onboarding/x#said", sourceTitle: null, observedOn: null }), f3 = fact(3, { subjectKind: "organization", subjectName: "City FC" });
  const block = composeFactsOnlyBlock(accounts, [f1, f2], [], [f3]);
  const outlet = (id: string) => (id === f1.id ? "official" : id === f3.id ? "local" : null);
  const unknown = "00000000-0000-4000-8000-000000000009";   // a well-formed id Nomila never sent
  const ev = evidenceFromSnapshot(block, [f3.id, "platform:instagram", f1.id, `[${f1.id}]`, f2.id, "E7", unknown, "platform:tiktok"], outlet);
  expect(ev.map((e) => e.id)).toEqual([f3.id, "platform:instagram", f1.id, f2.id]);
  expect(ev[0]).toEqual({ id: f3.id, claim: f3.claim, sourceTitle: "Story 3", sourceUrl: "https://news.example.com/story-3", sourceType: "secondary", date: "2026-05-03" });
  expect(ev[1]).toMatchObject({ id: "platform:instagram", sourceType: "platform", sourceUrl: null, date: "2026-10-20" });
  expect(ev[2]).toEqual({ id: f1.id, claim: f1.claim, sourceTitle: "Story 1", sourceUrl: "https://news.example.com/story-1", sourceType: "official", date: "2026-05-01" });
  expect(ev[3]).toEqual({ id: f2.id, claim: f2.claim, sourceTitle: "onboarding/x#said", sourceUrl: null, sourceType: null, date: null });
  expect(rubricSourceType("major_media")).toBe("major_media");
  expect(rubricSourceType("social")).toBe("secondary");
  expect(rubricSourceType(null)).toBeNull();
  // The notes' citations count too (0.4.0 tags them).
  const ids = citedEvidenceIds({ judgements: [{ evidenceIds: ["a"] } as any] }, { keyStrengths: [{ text: "x", dimension: "momentum", evidenceIds: ["b"] }], keyConstraints: [], importantMissingData: [], summary: [{ text: "y", dimension: "overall", evidenceIds: ["c"] }] });
  expect(ids).toEqual(["a", "b", "c"]);
});

test("EC3: completing keeps the echo as it came and appends only what it left out", () => {
  const f1 = fact(1), f2 = fact(2), f3 = fact(3);
  const block = composeFactsOnlyBlock(accounts, [f1, f2, f3], [], []);
  const rebuilt = evidenceFromSnapshot(block, [f1.id, f2.id, "platform:instagram", f3.id]);
  const echoed: EvaluatorOutput["evidence"] = [
    { id: `[${f2.id.toUpperCase()}]`, claim: "The model's own wording.", sourceTitle: "T", sourceUrl: "https://x.example/2", sourceType: "major_media", date: null },
    { id: "PLATFORM:instagram", claim: "followers", sourceTitle: null, sourceUrl: null, sourceType: "platform", date: null },
  ];
  const { evidence, added } = completeEvidence(echoed, rebuilt);
  expect(added).toBe(2);
  expect(evidence.slice(0, 2)).toEqual(echoed);                     // the echoed items, untouched, first
  expect(evidence.slice(2).map((e) => e.id)).toEqual([f1.id, f3.id]);  // then the omitted ones, in cited order
  expect(evidence[2]).toMatchObject({ claim: f1.claim, sourceUrl: f1.sourceUrl });
  // Nothing to add when the echo is complete; nothing at all when nothing the block lists was cited.
  expect(completeEvidence(rebuilt, rebuilt)).toEqual({ evidence: rebuilt, added: 0 });
  expect(completeEvidence(echoed, [])).toEqual({ evidence: echoed, added: 0 });
});

test("EC4: the judgements are identical; the dangling citations resolve", () => {
  const f1 = fact(1), f2 = fact(2);
  const block = composeFactsOnlyBlock(accounts, [f1, f2], [], []);
  const sources = [
    { platform: "instagram", accountId: "samlee", sourceClass: "connected_verified" },
    { platform: MEMORY_PLATFORM, accountId: f1.id, sourceClass: FACT_SOURCE_CLASS },
    { platform: MEMORY_PLATFORM, accountId: f2.id, sourceClass: FACT_SOURCE_CLASS },
  ];
  const signal = (key: string, ids: string[]) => ({ dimension: "momentum", key, status: "scored" as const, score: 60, confidence: "MEDIUM", rationale: "r", evidenceIds: ids });
  const out = {
    judgements: [signal("a", [f1.id, f2.id]), signal("b", ["platform:instagram"])],
    // The echo carries f1 only: f2 and the platform block are cited but have no entry.
    evidence: [{ id: f1.id, claim: "c", sourceTitle: null, sourceUrl: "https://news.example.com/story-1", sourceType: "secondary", date: null }],
  } as unknown as EvaluatorOutput;
  const allowed = allowedFromSources(sources);
  const before = enforceFactsOnly(out, allowed).output;
  const c = completeEvidence(out.evidence, evidenceFromSnapshot(block, citedEvidenceIds(out)));
  const after = enforceFactsOnly({ ...out, evidence: c.evidence }, allowed).output;
  expect(c.added).toBe(2);
  expect(after.judgements).toEqual(before.judgements);
  expect(judgementsDigest(after.judgements)).toBe(judgementsDigest(before.judgements));

  const ctx = groundingContextFor({ text: "", native: { groundingChunks: [], groundingSupports: [] } }, { social_block: block, social_sources: sources });
  const findings = [{ key: "momentum", value: 50, confidence: null, rationale: null, citedEvidence: [f1.id, f2.id, "platform:instagram"], components: [] }] as any;
  expect(groundCitations(findings, evidenceFor(before), ctx).findings[0].danglingEvidence).toEqual([f2.id, "platform:instagram"].sort());
  const g = groundCitations(findings, evidenceFor(after), ctx);
  expect(g.findings[0].danglingEvidence).toBeUndefined();
  expect(g.findings[0].citedEvidence).toEqual([f1.id, f2.id, "platform:instagram"]);
  expect(g.evidence.every((e) => e.lineage?.level === "nomila_supplied")).toBe(true);
});
