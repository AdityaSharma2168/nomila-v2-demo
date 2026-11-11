/**
 * factsOnly.test.ts — the M.I.A. FACTS-ONLY evaluator (facts-eval-spec/0.4.0), its pure parts. No database (db mocked
 * as {}), no provider (the Gemini client is mocked: the call is inspected, never made). Made-up athletes only.
 *
 *   F1 the prompt: the frozen rubric minus RESEARCH PROCESS (replaced by the facts-only rule), the listed rewordings
 *      and nothing else — every dimension, sub-signal, the scale, confidence rubric, evidence rules and output schema
 *      are the frozen text; the frozen Beta.1 prompt itself is untouched
 *   F2 the call goes out WITHOUT googleSearch, priced without the grounding charge; the frozen call still has it
 *   F3 the input builder: fact IDs first; care facts only under their kind's heading (PERSONAL — momentum only;
 *      CONDUCT — may inform brand safety and momentum), never among the ordinary facts; a care fact with no kind is
 *      personal; care selection obeys the same status rules
 *   F4 THE CARE RULE IN CODE: a PERSONAL care fact cited for brand_safety (or any non-momentum signal) is removed, and
 *      a signal left with nothing valid becomes missing; momentum may use it. A CONDUCT care fact may inform
 *      brand_safety and momentum, nothing else. Ids Nomila never supplied are not evidence
 *   F5 lineage: a cited fact id is Nomila-supplied research (web_researched), a platform id is the supplied block
 *   F6 the flag is off by default; the frozen digest is byte-identical, the facts-only digest is distinct
 *   F7 (0.4.0) facts about others: listed apart under CONTEXT — ABOUT OTHERS, never among the athlete's facts (and a
 *      post-check catches a block that does); a signal resting on context alone becomes missing
 *   F8 (0.4.0) the notes: tagged {text, dimension, evidence_ids}; a note resting on a personal care fact is dropped, as
 *      is one with no dimension, one on context alone, and a strength / constraint / summary sentence about a missing
 *      dimension (a missing-data note there is kept); an untagged summary is dropped; the frozen path is untouched
 *   F9 one measured source: the latest reading per metric
 */
jest.mock("../../db", () => ({ db: {} }));
const generateContent = jest.fn();
jest.mock("../../lib/models", () => ({ genai: () => ({ models: { generateContent } }), GEMINI: { flash: "gemini-test-flash" } }));

import { createHash } from "node:crypto";
import { BLIND_EVAL_SPEC, BLIND_EVAL_SPEC_V02_ADDITIONS, CANONICAL_EVALUATOR_TEXT, BLIND_EVAL_SPEC_V02_CANONICAL_SHA256 } from "../marketabilityBeta1EvaluatorSpec";
import { MARKETABILITY_BETA1_FROZEN_PARAMS } from "../marketabilityBeta1FrozenParams";
import { callEvaluator, normalizeJudgements, type EvaluatorOutput } from "../marketabilityBeta1Evaluator";
import { snapshotDigest } from "../marketabilityBeta1Snapshot";
import { classifyCitation, groundingContextFor, judgementSourceOf } from "../marketabilityCitationLineage";
import {
  CANONICAL_FACTS_EVALUATOR_TEXT, CARE_CONDUCT_HEADING, CARE_CONDUCT_SOURCE_CLASS, CARE_PERSONAL_HEADING, CARE_SOURCE_CLASS,
  FACT_SOURCE_CLASS, FACTS_HEADING, FACTS_ONLY_SECTION,
  FACTS_ONLY_SPEC, FACTS_ONLY_SUBSTITUTIONS, FACTS_ONLY_V02_ADDITIONS, MIA_FACTS_EVALUATOR_VERSION, MIA_FACTS_METHODOLOGY_VERSION, MIA_FACTS_PROMPT_VERSION,
  allowedFromSources, enforceFactsOnly, factsOnlyPrompt, isFactsOnlyBlock,
  CONTEXT_HEADING, CONTEXT_SOURCE_CLASS, DIMENSION_MISSING_SHARE, missingDimensions, notesFrom,
} from "./factsOnlySpec";
import {
  composeFactsOnlyBlock, factsBlockSubjectViolations, FOUND_SOURCE_CLASS, latestMeasuredPerMetric, MAX_CARE_FACTS, selectFactsOnlyInput, type PreviewFact,
} from "./memoryAdapter";
import { isAboutAthlete } from "../../../shared/agent";
import { IMPUTED_SHARE_FOR_UNKNOWN } from "../intelligence/state/build";

const SUB = MARKETABILITY_BETA1_FROZEN_PARAMS.config.subWeights as Record<string, Record<string, number>>;

let n = 0;
const fact = (p: Partial<PreviewFact>): PreviewFact => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, type: "found", status: "active", claim: "A claim.",
  subjectKind: "athlete", subjectName: "Rowan Vale", sourceUrl: "https://example.org/a", sourceRef: null, sourceTitle: "Example",
  observedOn: "2026-09-01", confidence: 0.8, sensitive: false, disputes: null, createdAt: `2026-10-0${(n % 9) + 1}T00:00:00.000Z`, ...p,
});

describe("F1: the facts-only prompt", () => {
  test("RESEARCH PROCESS is gone, replaced by the facts-only rule; the athlete line asks to score from the facts", () => {
    expect(BLIND_EVAL_SPEC).toContain("RESEARCH PROCESS");
    expect(FACTS_ONLY_SPEC).not.toContain("RESEARCH PROCESS");
    expect(FACTS_ONLY_SPEC).not.toMatch(/Before scoring, research enough/);
    expect(FACTS_ONLY_SPEC).toContain("Score only from the FACTS provided; mark a sub-signal missing when the facts don't support it.");
    // Two general lines of the removed section are kept (owner); the search-result-count line is not.
    expect(FACTS_ONLY_SPEC).toContain("Do not infer private commercial values unless explicitly published.");
    expect(FACTS_ONLY_SPEC).toContain("If identity is uncertain, say so and reduce confidence.");
    expect(FACTS_ONLY_SPEC).not.toMatch(/search-result counts/);
    const p = factsOnlyPrompt({ name: "Rowan Vale", sport: "Track and field" }, null);
    expect(p).toContain("Name: Rowan Vale\nSport: Track and field");
    expect(p).toMatch(/Score this athlete from the FACTS now/);
    expect(p).not.toMatch(/Research this athlete now/);
    expect(p).not.toMatch(/retrieve yourself/);
    expect(p).toContain(FACTS_HEADING);
  });

  test("every frozen phrase it rewords exists exactly once, and nothing else differs from the frozen text", () => {
    const frozen = `${BLIND_EVAL_SPEC}\n${BLIND_EVAL_SPEC_V02_ADDITIONS}`;
    for (const [from] of FACTS_ONLY_SUBSTITUTIONS) expect(frozen.split(from)).toHaveLength(2);
    // Rebuild the facts-only rubric from the frozen text by the stated edits only.
    const start = BLIND_EVAL_SPEC.indexOf("RESEARCH PROCESS\n\n");
    const end = BLIND_EVAL_SPEC.indexOf("ATHLETE INTELLIGENCE SUMMARY\n\n");
    let rebuilt = `${BLIND_EVAL_SPEC.slice(0, start)}${FACTS_ONLY_SECTION}${BLIND_EVAL_SPEC.slice(end)}`;
    rebuilt = rebuilt.replace(FACTS_ONLY_SUBSTITUTIONS[0][0], FACTS_ONLY_SUBSTITUTIONS[0][1]).replace(FACTS_ONLY_SUBSTITUTIONS[1][0], FACTS_ONLY_SUBSTITUTIONS[1][1]);
    expect(FACTS_ONLY_SPEC).toBe(rebuilt);
    expect(FACTS_ONLY_V02_ADDITIONS).toBe(BLIND_EVAL_SPEC_V02_ADDITIONS.replace(FACTS_ONLY_SUBSTITUTIONS[2][0], FACTS_ONLY_SUBSTITUTIONS[2][1]));
  });

  test("the 8 dimensions, 44 sub-signals, scale, confidence rubric, evidence rules and output schema are the frozen text", () => {
    const from = (s: string, a: string, b?: string) => s.slice(s.indexOf(a), b ? s.indexOf(b) : undefined);
    // Scale through the end of the evidence rules (only the evidence-ID line is reworded), and the output schema.
    expect(from(FACTS_ONLY_SPEC, "SCORING SCALE", FACTS_ONLY_SUBSTITUTIONS[1][1])).toBe(from(BLIND_EVAL_SPEC, "SCORING SCALE", "Create evidence IDs"));
    expect(FACTS_ONLY_SPEC).not.toContain("Create evidence IDs");
    expect(from(FACTS_ONLY_SPEC, "For each evidence item store:")).toBe(from(BLIND_EVAL_SPEC, "For each evidence item store:"));
    expect(from(FACTS_ONLY_V02_ADDITIONS, "CONFIDENCE RUBRIC", "EVALUATED SOCIAL JUDGMENTS")).toBe(from(BLIND_EVAL_SPEC_V02_ADDITIONS, "CONFIDENCE RUBRIC", "EVALUATED SOCIAL JUDGMENTS"));
    expect(from(FACTS_ONLY_V02_ADDITIONS, "OUTPUT ADDITIONS")).toBe(from(BLIND_EVAL_SPEC_V02_ADDITIONS, "OUTPUT ADDITIONS"));
    const keys = Object.entries(SUB).flatMap(([, s]) => Object.keys(s));
    expect(keys).toHaveLength(44);   // the 44 sub-signals (audience_growth is one in each of two dimensions)
    for (const k of keys) expect(FACTS_ONLY_SPEC).toContain(`${k} — `);
  });

  test("the frozen Beta.1 prompt is untouched (its pinned digest still holds) and the facts-only text is its own", () => {
    expect(createHash("sha256").update(CANONICAL_EVALUATOR_TEXT, "utf8").digest("hex")).toBe(BLIND_EVAL_SPEC_V02_CANONICAL_SHA256);
    expect(CANONICAL_FACTS_EVALUATOR_TEXT).not.toBe(CANONICAL_EVALUATOR_TEXT);
    expect(MIA_FACTS_EVALUATOR_VERSION).not.toBe("blind-eval-spec/0.2.1");
    expect(MIA_FACTS_METHODOLOGY_VERSION).toBe("v1.0.1-beta.1+facts.1");
    expect(CANONICAL_FACTS_EVALUATOR_TEXT).toMatch(/Never cite or weigh a personal care fact for brand_safety/);
    expect(CANONICAL_FACTS_EVALUATOR_TEXT).toMatch(/CONDUCT \(MAY INFORM BRAND SAFETY AND MOMENTUM\) are confirmed controversies or official findings\. They may inform brand_safety/);
  });
});

describe("F2: the call has no search tool", () => {
  beforeEach(() => generateContent.mockReset().mockResolvedValue({
    candidates: [{ finishReason: "STOP", groundingMetadata: {} }], usageMetadata: { promptTokenCount: 10_000, candidatesTokenCount: 7_000, thoughtsTokenCount: 10_000 }, text: "{}",
  }));

  test("no tools at all, same temperature and ceiling, no grounding charge", async () => {
    const call = await callEvaluator("prompt");
    const { config } = generateContent.mock.calls[0][0];
    expect(config.tools).toBeUndefined();
    expect(config).toMatchObject({ temperature: 1.0, maxOutputTokens: 65536 });
    expect(call.costUsd).toBeCloseTo(0.015 + 0.153, 6);
  });

  test("there is no search-enabled call any more (retired 4 Nov 2026): every call, any option, has no tools", async () => {
    await callEvaluator("prompt", {} as any);
    await callEvaluator("prompt", { search: true } as any);
    for (const c of generateContent.mock.calls) expect(c[0].config.tools).toBeUndefined();
  });
});

describe("F3: the input builder", () => {
  test("facts are cited by ID; each care kind appears only under its own heading; no kind ⇒ personal", () => {
    const plain = fact({ claim: "Starts for a college team." });
    const personal = fact({ claim: "Missed six weeks with an injury this season.", sensitive: true, careKind: "personal", confidence: 0.99 });
    const unkinded = fact({ claim: "Is on parental leave this season.", sensitive: true, careKind: null, confidence: 0.9 });
    const conduct = fact({ claim: "Was fined by the league after an official review.", sensitive: true, careKind: "conduct", confidence: 0.95 });
    const sel = selectFactsOnlyInput([plain, personal, unkinded, conduct], "Rowan Vale");
    expect(sel.public.map((f) => f.id)).toEqual([plain.id]);
    expect(sel.carePersonal.map((f) => f.id)).toEqual([personal.id, unkinded.id]);
    expect(sel.careConduct.map((f) => f.id)).toEqual([conduct.id]);
    const block = composeFactsOnlyBlock([], sel.public, sel.care);
    expect(isFactsOnlyBlock(block)).toBe(true);
    expect(block).toContain(`- [${plain.id}] Starts for a college team.`);
    const personalAt = block.indexOf(CARE_PERSONAL_HEADING);
    const conductAt = block.indexOf(CARE_CONDUCT_HEADING);
    expect(personalAt).toBeGreaterThan(0);
    expect(conductAt).toBeGreaterThan(personalAt);
    const firstCare = Math.min(personalAt, conductAt);
    for (const c of ["Missed six weeks", "parental leave", "fined by the league"]) expect(block.slice(0, firstCare)).not.toContain(c);
    const personalSection = block.slice(personalAt, conductAt);
    expect(personalSection).toContain("Missed six weeks");
    expect(personalSection).toContain("parental leave");
    expect(personalSection).not.toContain("fined by the league");
    expect(block.slice(conductAt)).toContain("fined by the league");
    expect(block.slice(conductAt)).not.toContain("Missed six weeks");
    expect(block).toContain("No authoritative platform data is available");
  });

  test("no care facts ⇒ no care section; care selection keeps only active FOUND care facts, capped", () => {
    const none = composeFactsOnlyBlock([], [fact({})], []);
    expect(none).not.toContain(CARE_PERSONAL_HEADING);
    expect(none).not.toContain(CARE_CONDUCT_HEADING);
    expect(composeFactsOnlyBlock([], [], [fact({ sensitive: true, careKind: "conduct" })])).not.toContain(CARE_PERSONAL_HEADING);
    const said = fact({ type: "said", sensitive: true, sourceUrl: null, sourceRef: "onboarding/x#family" });
    const disputed = fact({ sensitive: true, status: "disputed" });
    const removed = fact({ sensitive: true, status: "removed" });
    const many = Array.from({ length: MAX_CARE_FACTS + 4 }, () => fact({ sensitive: true }));
    const sel = selectFactsOnlyInput([said, disputed, removed, ...many], "Rowan Vale");
    expect(sel.care).toHaveLength(MAX_CARE_FACTS);
    expect(sel.care.map((f) => f.id)).not.toEqual(expect.arrayContaining([said.id, disputed.id, removed.id]));
    expect(sel.public).toHaveLength(0);
  });

  test("dated moments (topic moment, the moments scan's content calendar) are never evaluator input", () => {
    const own = fact({ claim: "Rowan Vale won the national title.", topic: "achievement" });
    const moment = fact({ claim: "The home opener is on 18 October.", subjectKind: "event", subjectName: "Home opener", topic: "moment" });
    const aboutHer = fact({ claim: "Rowan Vale races the season opener on 20 October.", topic: "moment" });
    const careMoment = fact({ claim: "A memorial race is on 25 October.", subjectKind: "event", subjectName: "Memorial race", topic: "moment", sensitive: true });
    const oldEvent = fact({ claim: "The league final is in November.", subjectKind: "event", subjectName: "League final", topic: "upcoming" });
    const sel = selectFactsOnlyInput([own, moment, aboutHer, careMoment, oldEvent], "Rowan Vale");
    const ids = [...sel.public, ...sel.context, ...sel.care].map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining([own.id, oldEvent.id]));
    for (const m of [moment, aboutHer, careMoment]) expect(ids).not.toContain(m.id);
  });

  test("the source classes the snapshot records match the adapter's", () => {
    expect(FACT_SOURCE_CLASS).toBe(FOUND_SOURCE_CLASS);
    expect(CARE_SOURCE_CLASS).not.toBe(FOUND_SOURCE_CLASS);
  });
});

/** A parsed answer with every signal scored and citing `ids`, plus per-signal overrides. */
function answer(ids: string[], over: Record<string, string[]> = {}): EvaluatorOutput {
  const dims: any = {};
  for (const [d, s] of Object.entries(SUB)) {
    dims[d] = {};
    for (const k of Object.keys(s)) dims[d][k] = { status: "scored", score: 60, confidence: "MEDIUM", evidence_ids: over[`${d}.${k}`] ?? ids, rationale: "r" };
  }
  return normalizeJudgements({ dimensions: dims, evidence: [...ids, ...Object.values(over).flat()].map((id) => ({ id, claim: "c" })) }, SUB);
}

describe("F4: the care rule, enforced in code", () => {
  const pub = "00000000-0000-4000-8000-0000000000aa";
  const care = "00000000-0000-4000-8000-0000000000cc";       // personal
  const conduct = "00000000-0000-4000-8000-0000000000dd";    // conduct
  const allowed = allowedFromSources([
    { platform: "memory", accountId: pub, sourceClass: FACT_SOURCE_CLASS },
    { platform: "memory", accountId: care, sourceClass: CARE_SOURCE_CLASS },
    { platform: "memory", accountId: conduct, sourceClass: CARE_CONDUCT_SOURCE_CLASS },
    { platform: "instagram", accountId: "made_up_handle", sourceClass: "connected_verified" },
  ]);
  const j = (o: EvaluatorOutput, path: string) => o.judgements.find((x) => `${x.dimension}.${x.key}` === path)!;

  test("brand_safety citing only a PERSONAL care fact ⇒ the care id is removed and the signal is missing", () => {
    const { output, enforcement } = enforceFactsOnly(answer([pub], { "brand_fit.brand_safety": [care] }), allowed);
    expect(j(output, "brand_fit.brand_safety")).toMatchObject({ status: "missing", score: null, evidenceIds: [] });
    expect(enforcement.careRemoved["brand_fit.brand_safety"]).toEqual([care]);
    expect(enforcement.demoted).toEqual(["brand_fit.brand_safety"]);
  });

  test("brand_safety citing a personal care fact AND a plain fact keeps only the plain fact", () => {
    const { output } = enforceFactsOnly(answer([pub], { "brand_fit.brand_safety": [care, pub] }), allowed);
    expect(j(output, "brand_fit.brand_safety")).toMatchObject({ status: "scored", evidenceIds: [pub] });
  });

  test("CONDUCT care facts may inform brand_safety and momentum, and nothing else", () => {
    const { output, enforcement } = enforceFactsOnly(answer([pub], {
      "brand_fit.brand_safety": [conduct], "momentum.media_trajectory": [conduct],
      "brand_fit.category_breadth": [conduct], "narrative_power.distinctiveness": [conduct, pub],
    }), allowed);
    expect(j(output, "brand_fit.brand_safety")).toMatchObject({ status: "scored", evidenceIds: [conduct] });
    expect(j(output, "momentum.media_trajectory")).toMatchObject({ status: "scored", evidenceIds: [conduct] });
    expect(j(output, "brand_fit.category_breadth")).toMatchObject({ status: "missing", evidenceIds: [] });
    expect(j(output, "narrative_power.distinctiveness")).toMatchObject({ status: "scored", evidenceIds: [pub] });
    expect(enforcement.careRemoved).toEqual({ "brand_fit.category_breadth": [conduct], "narrative_power.distinctiveness": [conduct] });
  });

  test("a care source with no recognised kind class is not trusted as conduct", () => {
    const a = allowedFromSources([{ platform: "memory", accountId: care, sourceClass: CARE_SOURCE_CLASS }]);
    expect(a.careIds.get(care)).toBe("personal");
  });

  test("momentum may use a personal care fact; any other dimension may not", () => {
    const { output } = enforceFactsOnly(answer([pub], { "momentum.athletic_trajectory": [care], "athletic_authority.role_importance": [care] }), allowed);
    expect(j(output, "momentum.athletic_trajectory")).toMatchObject({ status: "scored", evidenceIds: [care] });
    expect(j(output, "athletic_authority.role_importance").status).toBe("missing");
  });

  test("ids Nomila never supplied are not evidence; supplied ids are canonicalised; the evidence list follows", () => {
    const { output, enforcement } = enforceFactsOnly(answer([`[${pub.toUpperCase()}]`, "E7"], { "audience_scale.platform_breadth": ["platform: Instagram"], "audience_scale.audience_growth": ["E9"] }), allowed);
    expect(j(output, "athletic_authority.competition_level").evidenceIds).toEqual([pub]);
    expect(j(output, "audience_scale.platform_breadth").evidenceIds).toEqual(["platform:instagram"]);
    expect(j(output, "audience_scale.audience_growth").status).toBe("missing");
    expect(enforcement.unknownIds["athletic_authority.competition_level"]).toEqual(["E7"]);
    expect(output.evidence.map((e) => e.id).sort()).toEqual([pub, "platform:instagram"].sort());
  });
});

describe("F5: lineage of a facts-only citation", () => {
  const pub = "00000000-0000-4000-8000-0000000000ab";
  const snap = {
    social_block: composeFactsOnlyBlock([], [fact({ id: pub })], []),
    social_sources: [{ platform: "memory", accountId: pub, sourceClass: FACT_SOURCE_CLASS }, { platform: "instagram", accountId: "made_up_handle", sourceClass: "connected_verified" }],
  };
  const ctx = groundingContextFor({ text: "", native: { groundingChunks: [], groundingSupports: [] } }, snap)!;

  test("a cited fact id or platform id is Nomila-supplied; a researched fact makes the signal web_researched", () => {
    expect(classifyCitation({ id: pub, claim: "c", sourceUrl: "https://example.org/a" } as any, ctx)).toMatchObject({ level: "nomila_supplied", match: "snapshot" });
    expect(classifyCitation({ id: "platform:instagram", claim: "c", sourceUrl: null } as any, ctx)).toMatchObject({ level: "nomila_supplied" });
    const evidence = [pub, "platform:instagram"].map((id) => ({ id, claim: "c", lineage: classifyCitation({ id } as any, ctx) })) as any;
    const sourceOf = judgementSourceOf(evidence, ["connected_verified"], ctx.suppliedFacts);
    expect(sourceOf({ evidenceIds: [pub] })).toBe("web_researched");
    expect(sourceOf({ evidenceIds: ["platform:instagram"] })).toBe("connected_verified");
  });

  test("a frozen-evaluator snapshot gets no supplied-fact context (classification unchanged)", () => {
    const frozen = groundingContextFor({ text: "", native: {} }, { social_block: "AUTHORITATIVE SOCIAL DATA\n\nx", social_sources: snap.social_sources })!;
    expect(frozen.suppliedFacts).toBeUndefined();
  });
});

describe("F6: digest", () => {

  test("the frozen digest is byte-identical; the same block for the facts-only evaluator digests differently", () => {
    const i = { name: "Rowan Vale", sport: "Track and field", socialBlock: "block" };
    expect(snapshotDigest(i)).toBe(createHash("sha256").update(JSON.stringify({ name: i.name, sport: i.sport, socialBlock: i.socialBlock }), "utf8").digest("hex"));
    expect(snapshotDigest({ ...i, evaluator: MIA_FACTS_EVALUATOR_VERSION })).not.toBe(snapshotDigest(i));
  });
});

describe("F7: facts about others (0.4.0)", () => {
  test("isAboutAthlete: the athlete's own subject (name variants included) vs anyone or anything else", () => {
    expect(isAboutAthlete({ kind: "athlete", name: "Rowan Vale" }, "Rowan Vale")).toBe(true);
    expect(isAboutAthlete({ kind: "athlete", name: "rowan vale" }, "Rowan Q. Vale")).toBe(true);
    expect(isAboutAthlete({ kind: "athlete", name: "" }, "Rowan Vale")).toBe(true);
    expect(isAboutAthlete({ kind: "athlete", name: "Casey Teammate" }, "Rowan Vale")).toBe(false);
    expect(isAboutAthlete({ kind: "person", name: "Rowan Vale" }, "Rowan Vale")).toBe(false);
    for (const kind of ["organization", "brand", "event", "other"]) expect(isAboutAthlete({ kind, name: "Example Club" }, "Rowan Vale")).toBe(false);
  });

  test("context facts go under CONTEXT — ABOUT OTHERS only; the post-check finds none among hers", () => {
    const own = fact({ claim: "Rowan Vale is the team captain." });
    const teammate = fact({ claim: "Casey Teammate signed with Example Brand.", subjectKind: "person", subjectName: "Casey Teammate" });
    const club = fact({ claim: "Example Club lists Example Brand as a club sponsor.", subjectKind: "organization", subjectName: "Example Club" });
    const mislabelled = fact({ claim: "Jordan Other set a record.", subjectKind: "athlete", subjectName: "Jordan Other" });
    const sel = selectFactsOnlyInput([own, teammate, club, mislabelled], "Rowan Vale");
    expect(sel.public.map((f) => f.id)).toEqual([own.id]);
    expect(sel.context.map((f) => f.id).sort()).toEqual([teammate.id, club.id, mislabelled.id].sort());
    const block = composeFactsOnlyBlock([], sel.public, sel.care, sel.context);
    const contextAt = block.indexOf(CONTEXT_HEADING);
    expect(CONTEXT_HEADING).toBe("CONTEXT — ABOUT OTHERS: never a fact about this athlete");
    expect(contextAt).toBeGreaterThan(block.indexOf(FACTS_HEADING));
    for (const c of ["Casey Teammate signed", "club sponsor", "Jordan Other"]) {
      expect(block.slice(0, contextAt)).not.toContain(c);
      expect(block.slice(contextAt)).toContain(c);
    }
    expect(factsBlockSubjectViolations(block, [own, teammate, club, mislabelled], "Rowan Vale")).toEqual([]);
    // A block that did list a teammate's fact among hers is caught.
    const bad = composeFactsOnlyBlock([], [own, teammate], [], []);
    expect(factsBlockSubjectViolations(bad, [own, teammate], "Rowan Vale")).toEqual([teammate.id]);
  });

  test("a signal resting on context alone becomes missing; context beside her own fact is kept", () => {
    const pub = "00000000-0000-4000-8000-0000000000a1";
    const ctx = "00000000-0000-4000-8000-0000000000c1";
    const allowed = allowedFromSources([
      { platform: "memory", accountId: pub, sourceClass: FACT_SOURCE_CLASS },
      { platform: "memory", accountId: ctx, sourceClass: CONTEXT_SOURCE_CLASS },
    ]);
    expect(allowed.contextIds.has(ctx)).toBe(true);
    const { output, enforcement } = enforceFactsOnly(answer([pub], { "momentum.commercial_acceleration": [ctx], "commercial_proof.brand_quality": [ctx, pub] }), allowed);
    const j = (path: string) => output.judgements.find((x) => `${x.dimension}.${x.key}` === path)!;
    expect(j("momentum.commercial_acceleration")).toMatchObject({ status: "missing", evidenceIds: [] });
    expect(j("commercial_proof.brand_quality")).toMatchObject({ status: "scored", evidenceIds: [ctx, pub] });
    expect(enforcement.contextOnly).toEqual(["momentum.commercial_acceleration"]);
  });

  test("the prompt names the context rule", () => {
    expect(CANONICAL_FACTS_EVALUATOR_TEXT).toContain(`Facts listed under ${CONTEXT_HEADING} are never evidence about this athlete`);
    expect(CANONICAL_FACTS_EVALUATOR_TEXT).toMatch(/not being named in someone else's deal says nothing about the athlete/);
  });
});

describe("F8: the notes (0.4.0)", () => {
  const pub = "00000000-0000-4000-8000-0000000000b1";
  const care = "00000000-0000-4000-8000-0000000000b2";      // personal
  const conduct = "00000000-0000-4000-8000-0000000000b3";
  const ctx = "00000000-0000-4000-8000-0000000000b4";
  const allowed = allowedFromSources([
    { platform: "memory", accountId: pub, sourceClass: FACT_SOURCE_CLASS },
    { platform: "memory", accountId: care, sourceClass: CARE_SOURCE_CLASS },
    { platform: "memory", accountId: conduct, sourceClass: CARE_CONDUCT_SOURCE_CLASS },
    { platform: "memory", accountId: ctx, sourceClass: CONTEXT_SOURCE_CLASS },
  ]);
  /** An answer where every momentum signal is missing (so momentum is a MISSING dimension), with tagged notes. */
  function withNotes(notes: Record<string, unknown>): { out: EvaluatorOutput; json: any } {
    const dims: any = {};
    for (const [d, s] of Object.entries(SUB)) {
      dims[d] = {};
      for (const k of Object.keys(s)) dims[d][k] = d === "momentum" ? { status: "missing", score: null, evidence_ids: [] } : { status: "scored", score: 60, confidence: "MEDIUM", evidence_ids: [pub], rationale: "r" };
    }
    const json = { dimensions: dims, evidence: [{ id: pub, claim: "c" }], ...notes };
    return { out: normalizeJudgements(json, SUB), json };
  }
  const note = (text: string, dimension: string | null, evidence_ids: string[] = [pub]) => ({ text, dimension, evidence_ids });

  test("the dimension-missing line is the athlete state's 'unknown' line", () => {
    expect(DIMENSION_MISSING_SHARE).toBe(IMPUTED_SHARE_FOR_UNKNOWN);
  });

  test("each note must name a dimension, rest on no personal care fact and no context alone, and agree with the scores", () => {
    const { out, json } = withNotes({
      key_strengths: [
        note("Proven leadership on a top team.", "athletic_authority"),
        note("Excellent momentum this season.", "momentum"),                      // momentum is missing
        note("Draws on a family story.", "narrative_power", [care]),               // personal care
        note("A clean record.", "brand_fit", [conduct]),                           // conduct may back brand_fit
        note("No dimension named.", null),
        note("Unknown dimension.", "vibes"),
        "an untagged string note",
      ],
      key_constraints: [
        note("Was left out of a teammate's deal.", "commercial_proof", [ctx]),     // context alone
        note("Modest audience.", "audience_scale"),
        note("A conduct fact used for reach.", "audience_scale", [conduct]),       // conduct outside its dimensions
      ],
      important_missing_data: [
        note("No momentum evidence yet.", "momentum", []),                          // a gap note on a missing dimension: kept
        note("A personal detail is missing.", "momentum", [care]),
      ],
      marketability_summary: [
        note("A leader on a top team.", "athletic_authority"),
        note("Momentum is accelerating.", "momentum"),
        note("Overall a credible profile.", "overall", []),
        note("Inspired by family.", "overall", [care]),
      ],
    });
    // normalizeJudgements reads the text of tagged notes (never "[object Object]").
    expect(out.keyStrengths[0]).toBe("Proven leadership on a top team.");
    expect(out.summary).toContain("Momentum is accelerating.");
    const { output, enforcement } = enforceFactsOnly(out, allowed, notesFrom(json));
    expect(output.keyStrengths).toEqual(["Proven leadership on a top team.", "A clean record."]);
    expect(output.keyConstraints).toEqual(["Modest audience."]);
    expect(output.importantMissingData).toEqual(["No momentum evidence yet."]);
    expect(output.summary).toBe("A leader on a top team. Overall a credible profile.");
    expect(output.summaryWords).toBe(10);
    const reasons = enforcement.notesDropped.map((d) => `${d.field}:${d.reason}`);
    expect(reasons).toEqual(expect.arrayContaining([
      "key_strengths:dimension_missing", "key_strengths:personal_care", "key_strengths:no_dimension",
      "key_constraints:context_only", "key_constraints:conduct_care", "important_missing_data:personal_care",
      "marketability_summary:dimension_missing", "marketability_summary:personal_care",
    ]));
    expect(enforcement.notesDropped.filter((d) => d.reason === "no_dimension")).toHaveLength(3);
    // The audit keeps where and why, never the dropped text.
    expect(JSON.stringify(enforcement)).not.toContain("family");
  });

  test("an untagged summary is dropped (it cannot be checked); without notes the frozen path is untouched", () => {
    const { out, json } = withNotes({ marketability_summary: "One plain paragraph.", key_strengths: ["plain"] });
    const held = enforceFactsOnly(out, allowed, notesFrom(json));
    expect(held.output.summary).toBeNull();
    expect(held.output.keyStrengths).toEqual([]);
    expect(held.enforcement.notesDropped).toEqual(expect.arrayContaining([expect.objectContaining({ field: "marketability_summary", reason: "untagged_summary" })]));
    const frozen = enforceFactsOnly(out, allowed);
    expect(frozen.output.summary).toBe("One plain paragraph.");
    expect(frozen.output.keyStrengths).toEqual(["plain"]);
  });

  test("missingDimensions: half or more of a dimension's sub-signals missing", () => {
    const { out } = withNotes({});
    expect([...missingDimensions(out.judgements)]).toEqual(["momentum"]);
  });

  test("the prompt asks for tagged notes, prompt text version 0.4.0 (unchanged by the 0.5.0 provider move)", () => {
    expect(MIA_FACTS_PROMPT_VERSION).toBe("facts-eval-spec/0.4.0");
    expect(MIA_FACTS_EVALUATOR_VERSION).toBe("facts-eval-spec/0.5.1");
    expect(CANONICAL_FACTS_EVALUATOR_TEXT).toContain(`NOTES AND SUMMARY (${MIA_FACTS_PROMPT_VERSION})`);
    expect(CANONICAL_FACTS_EVALUATOR_TEXT).toContain(`FACTS-ONLY ADDITIONS (${MIA_FACTS_PROMPT_VERSION})`);
    expect(CANONICAL_FACTS_EVALUATOR_TEXT).not.toContain("0.5.0");
    expect(CANONICAL_FACTS_EVALUATOR_TEXT).toContain('{ "text": "...", "dimension": "<dimension key>", "evidence_ids": [] }');
    expect(CANONICAL_FACTS_EVALUATOR_TEXT).toMatch(/Never rest a note or a summary sentence on a fact listed under CARE FACTS — PERSONAL/);
  });
});

describe("F9: one measured source", () => {
  test("latest reading per metric, by observed date then when recorded; refs without a metric are left out", () => {
    const m = (ref: string, observedOn: string, createdAt: string) => fact({ type: "measured", sourceUrl: null, sourceRef: ref, observedOn, createdAt });
    const old = m("social_analytics_snapshots/s1#instagram.avg_engagement_rate", "2026-09-01", "2026-09-01T00:00:00.000Z");
    const now = m("social_analytics_snapshots/s2#instagram.avg_engagement_rate", "2026-10-01", "2026-10-01T00:00:00.000Z");
    const sameDayLater = m("social_analytics_snapshots/s3#instagram.followers", "2026-10-01", "2026-10-01T02:00:00.000Z");
    const sameDayEarlier = m("social_analytics_snapshots/s4#instagram.followers", "2026-10-01", "2026-10-01T01:00:00.000Z");
    const noMetric = m("social_analytics_snapshots/s5", "2026-10-02", "2026-10-02T00:00:00.000Z");
    const ids = latestMeasuredPerMetric([old, now, sameDayEarlier, sameDayLater, noMetric]).map((f) => f.id);
    expect(ids.sort()).toEqual([now.id, sameDayLater.id].sort());
    const sel = selectFactsOnlyInput([old, now], "Rowan Vale");
    expect(sel.measured.map((f) => f.id)).toEqual([now.id]);
  });
});
