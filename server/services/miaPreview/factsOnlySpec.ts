/**
 * 0.4.0 (Oct 2026, first real run): facts about others are listed apart (CONTEXT — ABOUT OTHERS) and can never be the
 * only support for a signal or note; key_strengths / key_constraints / important_missing_data and the summary come
 * back tagged {text, dimension, evidence_ids} and are held in code (enforceFactsOnly): no personal care fact, no
 * context-only support, no strength / constraint / summary sentence about a missing dimension.
 *
 * miaPreview/factsOnlySpec.ts — the M.I.A. FACTS-ONLY evaluator (facts-eval-spec/0.4.0), for athletes on the new agent's
 * memory. Always on since 4 Nov 2026 (the flag MIA_FACTS_ONLY_EVALUATOR and the search-enabled evaluator are retired).
 *
 * WHY: the agent's research step (jobs/research.md 1.7.0) now gathers the evidence M.I.A. needs, so M.I.A. stops doing
 * its own web search. One research step feeds the score; the evaluator scores only from the facts Nomila holds.
 *
 * WHAT CHANGES against the frozen Beta.1 prompt (blind-eval-spec/0.2.1, marketabilityBeta1EvaluatorSpec.ts, untouched):
 *   - the model is called WITHOUT googleSearch (callEvaluator(prompt, { search: false }));
 *   - the v0.1 "RESEARCH PROCESS" section is removed and replaced with "Score only from the FACTS provided; mark a
 *     sub-signal missing when the facts don't support it.";
 *   - the four sentences that told the model to research or retrieve are reworded to point at the facts (each listed in
 *     FACTS_ONLY_SUBSTITUTIONS below, so the diff against the frozen text is exactly these and nothing else);
 *   - evidence IDs are Nomila's fact IDs (and platform:<platform> for the authoritative social block), not E1, E2 …;
 *   - two general lines of the removed section are kept, in SCORING BASIS: "Do not infer private commercial values
 *     unless explicitly published." and "If identity is uncertain, say so and reduce confidence." (owner, PR #896);
 *   - a FACTS-ONLY ADDITIONS block states the care rule (below).
 * The 8 dimensions, 44 sub-signals, scale, confidence rubric, evidence rules and output schema are the frozen text,
 * verbatim. The weights, params and ledger mapping are unchanged; only the evaluator and methodology versions move.
 *
 * THE CARE RULE IS CODE, NOT ONLY PROMPT (the owner's decisions): care facts come in two kinds (memory_facts.care_kind).
 *   personal  an injury or availability, leave or pregnancy, family as the athlete presents it → MOMENTUM only
 *   conduct   a confirmed controversy or an official finding → may inform brand_safety AND momentum (nothing else)
 * A care fact with no kind is personal (the stricter rule). The input builder (memoryAdapter.buildMemoryFactsSnapshot)
 * lists each kind under its own heading; enforceFactsOnly() below strips any care-fact citation outside what its kind
 * allows after the model answers, and a signal left with no valid evidence is marked missing — never scored on what it
 * may not use.
 *
 * Pure: no database, no provider. Nothing here names an athlete, sport, school or brand.
 */
import { BLIND_EVAL_SPEC, BLIND_EVAL_SPEC_V02_ADDITIONS, NO_AUTHORITATIVE_SOCIAL_DATA } from "../marketabilityBeta1EvaluatorSpec";
import { MARKETABILITY_BETA1_VERSION } from "../marketabilityBeta1";
import type { EvaluatorOutput } from "../marketabilityBeta1Evaluator";
import { MARKETABILITY_DIMENSIONS } from "../intelligence/types";

/** The dimensions a note may name (the eight M.I.A. dimensions). */
export const NOTE_DIMENSIONS: readonly string[] = MARKETABILITY_DIMENSIONS;
/** A summary sentence about no single dimension. */
export const OVERALL_DIMENSION = "overall";

/**
 * The version of the facts-only PROMPT TEXT, printed inside it ("FACTS-ONLY ADDITIONS (…)", "NOTES AND SUMMARY (…)").
 * 0.4.0 (first real run, Oct 2026): facts about others listed apart (CONTEXT — ABOUT OTHERS) and never the only support
 * for a signal or note; notes (key_strengths, key_constraints, important_missing_data) and the summary come back
 * tagged {text, dimension, evidence_ids} and are held to the care rule and to the scores (enforceFactsOnly).
 * Kept apart from the evaluator version below so a provider change never edits a word of the prompt.
 */
export const MIA_FACTS_PROMPT_VERSION = "facts-eval-spec/0.4.0";

/**
 * The facts-only evaluator version, recorded on every run it produces (mia_evaluation_runs.evaluator_version) and
 * folded into the snapshot digest (so a switch of provider re-evaluates rather than reusing the other provider's answer).
 *   0.4.0  Gemini, no tools, the prompt above (unchanged; the default provider).
 *   0.5.0  OpenAI, opt-in (the agent's reasoning tier, Responses API, low effort), no tools and no web search, the SAME prompt
 *          text (0.4.0), answered through a strict JSON schema of the same response shape (factsOnlyOpenAI.ts).
 *   x.y.1  (5 Nov 2026, PR #1221) each of 0.4.0, 0.5.0 and 0.6.0 with SHORT FACT REFERENCES: the facts block the evaluator
 *          is sent lists each fact as F1 … Fn (factRefs) instead of its full id, and code resolves them back
 *          (resolveFactRefs). The rubric text is unchanged (it still says 0.4.0 / 0.6.0 inside, and its digests stay
 *          pinned): only the run's recorded version moves, so a stored run shows which fact-id format it was shown.
 *          A run recorded x.y.0 saw full UUIDs.
 */
export const MIA_FACTS_EVALUATOR_VERSION = "facts-eval-spec/0.5.1";
export const MIA_FACTS_EVALUATOR_VERSION_GEMINI = "facts-eval-spec/0.4.1";
/** The methodology version on its ledger entries. Weights and mapping are Beta.1's; the evidence path is not. */
export const MIA_FACTS_METHODOLOGY_VERSION = `${MARKETABILITY_BETA1_VERSION}+facts.1`;
/** The Gemini facts-only conditions (0.4.0). The OpenAI conditions are written by factsOnlyOpenAI.ts with the model and effort. */
export const MIA_FACTS_EVALUATOR_CONDITIONS = "no-tools (facts only); thinking=default; temperature=1.0" as const;

export type MiaFactsEvaluatorProvider = "openai" | "gemini";
/**
 * Which provider scores facts-only runs: MIA_FACTS_EVALUATOR_PROVIDER=openai|gemini, default GEMINI (the owner's
 * decision, 10 Oct 2026, after the live check: M.I.A. stays on Gemini; OpenAI is an option behind this setting).
 * Only "openai" selects OpenAI; anything else (unset, empty, unknown) is Gemini.
 */
export function miaFactsEvaluatorProvider(): MiaFactsEvaluatorProvider {
  return process.env.MIA_FACTS_EVALUATOR_PROVIDER?.trim().toLowerCase() === "openai" ? "openai" : "gemini";
}
/**
 * facts-eval-spec/0.6.0 (Oct 2026): the 0.4.0 Gemini evaluator, unchanged but for one added paragraph (EVIDENCE LIST,
 * below) that tells it to return "evidence": [] instead of copying every cited fact back. In facts-only mode the
 * evaluator cites Nomila's own fact ids, so that echo repeated what Nomila already holds - and it was a large share of
 * the answer's output tokens. Code rebuilds the evidence list from the snapshot it sent (evidenceFromSnapshot), so the
 * run's judgements, the ledger's cited evidence and every reader keep the same shape. A new version, never an edit of
 * 0.4.0 (which stays the default). Prompt and evaluator version were the same string until short fact references
 * (0.6.1, below): the prompt text is still 0.6.0.
 */
export const MIA_FACTS_PROMPT_VERSION_NO_ECHO = "facts-eval-spec/0.6.0";
/** The run's recorded version for the 0.6.0 prompt: 0.6.1 since short fact references (above); the prompt text stays 0.6.0. */
export const MIA_FACTS_EVALUATOR_VERSION_GEMINI_NO_ECHO = "facts-eval-spec/0.6.1";

/**
 * MIA_FACTS_NO_EVIDENCE_ECHO=true selects 0.6.0 for the Gemini facts-only evaluator (default OFF; dev only until its
 * equivalence check passed). The opt-in OpenAI evaluator (0.5.0, a strict schema) is not affected.
 */
export function miaFactsNoEvidenceEcho(): boolean {
  return process.env.MIA_FACTS_NO_EVIDENCE_ECHO === "true";
}

/** The evaluator version a facts-only run records for a provider. */
export function miaFactsEvaluatorVersion(provider: MiaFactsEvaluatorProvider = miaFactsEvaluatorProvider()): string {
  if (provider !== "gemini") return MIA_FACTS_EVALUATOR_VERSION;
  return miaFactsNoEvidenceEcho() ? MIA_FACTS_EVALUATOR_VERSION_GEMINI_NO_ECHO : MIA_FACTS_EVALUATOR_VERSION_GEMINI;
}

// ── the evidence block (headings the builder writes and the orchestrator recognises) ──────────────────────────

/** The facts-only block always starts with this heading: it is how the evaluate step knows which prompt to send. */
export const FACTS_HEADING = "FACTS NOMILA HOLDS";
export const FACTS_LEAD = "Sourced facts Nomila's research found about this athlete. Each line starts with the fact's ID in brackets, then the claim, its source (title, URL and outlet type where known), its date and Nomila's confidence (0–1). Cite a fact by its ID.";
export const CARE_PERSONAL_HEADING = "CARE FACTS — PERSONAL (MOMENTUM ONLY)";
export const CARE_PERSONAL_LEAD = "Public, sourced but personal facts (an injury or availability, leave or pregnancy, family as the athlete presents it). Use them ONLY for the momentum sub-signals. Never cite or weigh them for brand_safety or for any other sub-signal.";
export const CARE_CONDUCT_HEADING = "CARE FACTS — CONDUCT (MAY INFORM BRAND SAFETY AND MOMENTUM)";
export const CARE_CONDUCT_LEAD = "Public, sourced facts about confirmed controversies or official findings. Use them only for brand_safety and the momentum sub-signals, never for any other sub-signal.";
export const CONTEXT_HEADING = "CONTEXT — ABOUT OTHERS: never a fact about this athlete";
export const CONTEXT_LEAD = "Sourced facts about other people, teams, schools, clubs, brands or events around the athlete. Background only: none of them is evidence about this athlete.";
export const NO_FACTS_LINE = "- (none)";

/** True when a stored snapshot block was built for the facts-only evaluator. */
export function isFactsOnlyBlock(block: string | null | undefined): boolean {
  return typeof block === "string" && block.startsWith(FACTS_HEADING);
}

/** Snapshot source classes for memory facts in a facts-only block (found = "web_researched", as memoryAdapter). */
export const FACT_SOURCE_CLASS = "web_researched";
/** Personal care facts (and care facts with no kind). The class name predates the split and is kept. */
export const CARE_SOURCE_CLASS = "web_researched_care";
export const CARE_CONDUCT_SOURCE_CLASS = "web_researched_care_conduct";
/** Facts about others (0.4.0): listed under CONTEXT — ABOUT OTHERS, never the only support for a signal or note. */
export const CONTEXT_SOURCE_CLASS = "web_researched_context";
export const MEMORY_PLATFORM = "memory";

/** Where each care kind may be cited: personal → the momentum dimension only; conduct → momentum and brand_safety. */
export const CARE_ALLOWED_DIMENSION = "momentum";
export const CONDUCT_ALLOWED_SIGNAL = "brand_fit.brand_safety";
export function careCitationAllowed(kind: "personal" | "conduct", dimension: string, key: string): boolean {
  if (dimension === CARE_ALLOWED_DIMENSION) return true;
  return kind === "conduct" && `${dimension}.${key}` === CONDUCT_ALLOWED_SIGNAL;
}

// ── the prompt ────────────────────────────────────────────────────────────────

const RESEARCH_SECTION_START = "RESEARCH PROCESS\n\n";
const RESEARCH_SECTION_END = "ATHLETE INTELLIGENCE SUMMARY\n\n";
export const FACTS_ONLY_SECTION = "SCORING BASIS\n\nScore only from the FACTS provided; mark a sub-signal missing when the facts don't support it.\n\nDo not infer private commercial values unless explicitly published.\n\nIf identity is uncertain, say so and reduce confidence.\n\n";

/**
 * The only other wording changes, each [frozen text, facts-only text]. A test pins that every frozen phrase exists
 * exactly once, so a change to the frozen spec can never make one silently stop applying.
 */
export const FACTS_ONLY_SUBSTITUTIONS: ReadonlyArray<readonly [string, string]> = [
  [
    "You must first research the athlete using public sources, build a coherent evidence-grounded understanding of the athlete, and then assess 44 marketability sub-signals.",
    "You are given the FACTS Nomila holds about the athlete. Build a coherent evidence-grounded understanding of the athlete from those facts, and then assess 44 marketability sub-signals.",
  ],
  [
    "Create evidence IDs E1, E2, E3...",
    "Use the ID shown in brackets before each FACT you rely on as its evidence ID; for AUTHORITATIVE SOCIAL DATA use platform:<platform> (for example platform:instagram). Never create an ID that is not shown.",
  ],
  [
    "credible public evidence you retrieve yourself",
    "credible public evidence in the FACTS provided",
  ],
];

export const FACTS_ONLY_ADDITIONS = `==================================================
FACTS-ONLY ADDITIONS (${MIA_FACTS_PROMPT_VERSION})
==================================================

FACTS

The block titled ${FACTS_HEADING} lists the sourced facts Nomila's research found about the athlete, each with its ID, source, date and Nomila's confidence (0–1). You have no search tool. Weigh each fact by its source, outlet and confidence as the rubric says, and add nothing the facts do not state.

CARE FACTS

Facts listed under ${CARE_PERSONAL_HEADING} are public and sourced but personal. Use them only for the MOMENTUM sub-signals. Never cite or weigh a personal care fact for brand_safety or for any other sub-signal.

Facts listed under ${CARE_CONDUCT_HEADING} are confirmed controversies or official findings. They may inform brand_safety and the MOMENTUM sub-signals, and nothing else. Do not penalize based only on unverified allegations: a conduct fact is a confirmed issue or an official finding, weighed as the brand_safety rubric says.

CONTEXT ABOUT OTHERS

Facts listed under ${CONTEXT_HEADING} are never evidence about this athlete (a teammate's deal or a team's sponsor is not the athlete's, and not being named in someone else's deal says nothing about the athlete); use them only as background.

NOTES AND SUMMARY (${MIA_FACTS_PROMPT_VERSION})

This replaces the output format of four fields; everything else in the OUTPUT format stands. Return "key_strengths", "key_constraints" and "important_missing_data" as arrays of objects, and "marketability_summary" as an array of sentence objects, each:

{ "text": "...", "dimension": "<dimension key>", "evidence_ids": [] }

"dimension" is the one dimension the note is about: ${NOTE_DIMENSIONS.join(", ")}. A summary sentence that is about no single dimension may use "overall". "evidence_ids" lists the fact IDs (or platform:<platform>) the note rests on, as in the dimensions. A strength or constraint must agree with your scores: never write one about a dimension whose sub-signals are mostly missing. Never rest a note or a summary sentence on a fact listed under ${CARE_PERSONAL_HEADING}: personal care facts stay out of every note and the summary.`;

function facts01(): string {
  const start = BLIND_EVAL_SPEC.indexOf(RESEARCH_SECTION_START);
  const end = BLIND_EVAL_SPEC.indexOf(RESEARCH_SECTION_END);
  if (start < 0 || end <= start) throw new Error("facts-only spec: the frozen RESEARCH PROCESS section was not found");
  let s = `${BLIND_EVAL_SPEC.slice(0, start)}${FACTS_ONLY_SECTION}${BLIND_EVAL_SPEC.slice(end)}`;
  for (const [from, to] of FACTS_ONLY_SUBSTITUTIONS.slice(0, 2)) s = s.replace(from, to);
  return s;
}

/** The facts-only rubric: the frozen v0.1 text minus RESEARCH PROCESS (and the listed rewordings), then the v0.2 additions. */
export const FACTS_ONLY_SPEC = facts01();
export const FACTS_ONLY_V02_ADDITIONS = BLIND_EVAL_SPEC_V02_ADDITIONS.replace(FACTS_ONLY_SUBSTITUTIONS[2][0], FACTS_ONLY_SUBSTITUTIONS[2][1]);

/** 0.6.0 only: the one paragraph added after the 0.4.0 FACTS-ONLY ADDITIONS (nothing else in the text changes). */
export const NO_EVIDENCE_ECHO_ADDITION = `EVIDENCE LIST (${MIA_FACTS_PROMPT_VERSION_NO_ECHO})

Nomila already holds every fact and platform you can cite, under the ID shown. Do not copy them into the "evidence" list: return "evidence": [] (an empty list) and cite each fact or platform only by its ID in "evidence_ids". This replaces the per-item evidence record in EVIDENCE RULES and in the OUTPUT format; everything else stands.`;

/**
 * The facts-only prompt: rubric + v0.2 additions + facts-only additions + the athlete + the facts block. `version`
 * 0.6.0 adds NO_EVIDENCE_ECHO_ADDITION after the facts-only additions; the default is the 0.4.0 text, byte for byte.
 */
export function factsOnlyPrompt(a: { name: string; sport: string }, block: string | null, version: string = MIA_FACTS_PROMPT_VERSION): string {
  const evidence = block && block.trim() ? factRefs(block.trim()).block : `${FACTS_HEADING}\n\n${FACTS_LEAD}\n${NO_FACTS_LINE}\n\n${NO_AUTHORITATIVE_SOCIAL_DATA}`;
  const additions = version === MIA_FACTS_PROMPT_VERSION_NO_ECHO ? `${FACTS_ONLY_ADDITIONS}\n\n${NO_EVIDENCE_ECHO_ADDITION}` : FACTS_ONLY_ADDITIONS;
  return `${FACTS_ONLY_SPEC}\n\n${FACTS_ONLY_V02_ADDITIONS}\n\n${additions}\n\nATHLETE TO EVALUATE\n\nName: ${a.name}\nSport: ${a.sport}\n\n${evidence}\n\nScore this athlete from the FACTS now, then return the JSON exactly as specified (all eight dimensions, all 44 sub-signals each scored or missing, the dimension assessments and the overall confidence). Return the JSON as one \`\`\`json fenced block.`;
}

// ── short fact references (4 Nov 2026) ──────────────────────────────────────────

/**
 * WHY: the stored block lists each fact under its full id (a UUID), and a model asked to copy 36-character ids back
 * does not do it reliably: a dev run cited "0f82fc1e" (the first 8 characters) for every fact, every citation was
 * unknown, every signal was demoted and the athlete ended "not assessed". So the PROMPT shows each fact under a short
 * reference instead, F1 … Fn in the order the block lists them, and code maps them back (resolveFactRefs) before the
 * answer is held to the contract. The stored snapshot block keeps the full ids (its digest, the evidence rebuild and
 * the lineage read them); the mapping is derived from that block, so it lives inside the run and is the same every
 * time the same snapshot is evaluated. The same pattern as the chat context's and the planner's F1/F2 fact keys.
 */
const FACT_LINE_ID = /^- \[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\] /i;

/** The block with each fact line's full id replaced by F1 … Fn (first listed first), and the map back to the full ids. */
export function factRefs(block: string | null): { block: string; refs: Map<string, string> } {
  const refs = new Map<string, string>();
  const byId = new Map<string, string>();
  const lines = String(block ?? "").split("\n").map((line) => {
    const m = FACT_LINE_ID.exec(line);
    if (!m) return line;
    const id = m[1].toLowerCase();
    let ref = byId.get(id);
    if (!ref) { ref = `F${refs.size + 1}`; refs.set(ref, id); byId.set(id, ref); }
    return `- [${ref}] ${line.slice(m[0].length)}`;
  });
  return { block: lines.join("\n"), refs };
}

const SHORT_REF = /^\s*\[?\s*(F\d+)\s*\]?\s*$/i;

/**
 * One cited id with a short reference resolved to its full fact id. A full id, a platform:<p> or anything else is
 * returned as it came (a full UUID still resolves downstream, so an answer written the old way keeps working). A short
 * reference the prompt never showed (F99) is returned as it came, and canonicalEvidenceId drops it as unknown.
 */
export function resolveFactRef(raw: string, refs: ReadonlyMap<string, string>): string {
  const ref = SHORT_REF.exec(String(raw ?? ""))?.[1]?.toUpperCase();
  return (ref && refs.get(ref)) || raw;
}

/** Counts of what resolveFactRefs did, kept with the run: short refs resolved, short refs the prompt never showed, full ids cited. */
export interface FactRefResolution { resolved: number; unknownRefs: number; fullIds: number }

/**
 * Resolve every short reference in a parsed answer (the signals' evidence_ids, the evidence list's ids and the tagged
 * notes') to the full fact id, before completeEvidence and enforceFactsOnly read them. Pure.
 */
export function resolveFactRefs(out: EvaluatorOutput, notes: TaggedNotes | undefined, refs: ReadonlyMap<string, string>): { output: EvaluatorOutput; notes: TaggedNotes | undefined; resolution: FactRefResolution } {
  const resolution: FactRefResolution = { resolved: 0, unknownRefs: 0, fullIds: 0 };
  const one = (raw: string): string => {
    const r = resolveFactRef(raw, refs);
    if (r !== raw) resolution.resolved++;
    else if (SHORT_REF.test(String(raw ?? ""))) resolution.unknownRefs++;
    else if (UUID.test(String(raw ?? ""))) resolution.fullIds++;
    return r;
  };
  const output: EvaluatorOutput = {
    ...out,
    judgements: out.judgements.map((j) => ({ ...j, evidenceIds: j.evidenceIds.map(one) })),
    evidence: out.evidence.map((e) => ({ ...e, id: resolveFactRef(String(e.id ?? ""), refs) })),
  };
  const notesOut = notes && {
    keyStrengths: notes.keyStrengths.map((n) => ({ ...n, evidenceIds: n.evidenceIds.map(one) })),
    keyConstraints: notes.keyConstraints.map((n) => ({ ...n, evidenceIds: n.evidenceIds.map(one) })),
    importantMissingData: notes.importantMissingData.map((n) => ({ ...n, evidenceIds: n.evidenceIds.map(one) })),
    summary: notes.summary ? notes.summary.map((n) => ({ ...n, evidenceIds: n.evidenceIds.map(one) })) : null,
  };
  return { output, notes: notesOut, resolution };
}

/** The exact facts-only evaluator text with the per-athlete values substituted out (the register's copy). */
export const CANONICAL_FACTS_EVALUATOR_TEXT = factsOnlyPrompt({ name: "<ATHLETE>", sport: "<SPORT>" }, null);
/** The same for 0.6.0 (the register's copy). */
export const CANONICAL_FACTS_EVALUATOR_TEXT_NO_ECHO = factsOnlyPrompt({ name: "<ATHLETE>", sport: "<SPORT>" }, null, MIA_FACTS_PROMPT_VERSION_NO_ECHO);

// ── enforcement (after the model answers) ─────────────────────────────────────

/** What the evaluate step may accept as evidence, read from the snapshot's own sources. */
export interface FactsOnlyAllowed {
  factIds: Set<string>;
  /** Care facts by kind: personal (and kind unknown) → momentum only; conduct → momentum and brand_safety. */
  careIds: Map<string, "personal" | "conduct">;
  /** Facts about others (CONTEXT — ABOUT OTHERS, 0.4.0): citable as background, never the only support. */
  contextIds: Set<string>;
  platforms: Set<string>;
}

/** From a snapshot's social_sources: memory facts it supplied (care and context apart) and the platforms in its authoritative block. */
export function allowedFromSources(sources: unknown): FactsOnlyAllowed {
  const out: FactsOnlyAllowed = { factIds: new Set(), careIds: new Map(), contextIds: new Set(), platforms: new Set() };
  for (const s of Array.isArray(sources) ? sources : []) {
    if (!s || typeof s.platform !== "string") continue;
    const id = String(s.accountId ?? "").toLowerCase();
    if (s.platform === MEMORY_PLATFORM) {
      if (s.sourceClass === FACT_SOURCE_CLASS) out.factIds.add(id);
      else if (s.sourceClass === CARE_SOURCE_CLASS) { out.factIds.add(id); out.careIds.set(id, "personal"); }
      else if (s.sourceClass === CARE_CONDUCT_SOURCE_CLASS) { out.factIds.add(id); out.careIds.set(id, "conduct"); }
      else if (s.sourceClass === CONTEXT_SOURCE_CLASS) { out.factIds.add(id); out.contextIds.add(id); }
    } else {
      out.platforms.add(s.platform.toLowerCase());
    }
  }
  return out;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** A cited id as Nomila knows it (a fact id, or platform:<p>), or null when it names nothing Nomila supplied. */
export function canonicalEvidenceId(raw: string, allowed: FactsOnlyAllowed): string | null {
  const uuid = UUID.exec(raw)?.[0]?.toLowerCase();
  if (uuid && allowed.factIds.has(uuid)) return uuid;
  const platform = /^\s*\[?\s*platform\s*:\s*([a-z0-9_]+)/i.exec(raw)?.[1]?.toLowerCase();
  if (platform && allowed.platforms.has(platform)) return `platform:${platform}`;
  return null;
}

// ── the rebuilt evidence list (0.6.0) ─────────────────────────────────────────

/** Nomila's outlet type (memory_facts.source_type) -> the frozen rubric's source_type vocabulary. */
export function rubricSourceType(outlet: string | null | undefined): string | null {
  if (!outlet) return null;
  return outlet === "official" || outlet === "major_media" ? outlet : "secondary";
}

const FACT_LINE = /^- \[([0-9a-f-]{36})\] (.*) — source: (.*); (?:dated (\d{4}-\d{2}-\d{2})|undated); confidence [\d.]+$/i;
const PLATFORM_LINE = /^- ([a-z0-9_]+) @\S+ — /i;

/**
 * 0.6.0: the evidence list the evaluator no longer writes, rebuilt from what Nomila sent - one item per cited id (in
 * first-cited order) that the snapshot's block lists. A fact line gives its claim, source title and URL and its date
 * (memoryAdapter.factLine's format); a platform line in AUTHORITATIVE SOCIAL DATA gives platform:<p> with source_type
 * "platform". `outletOf` gives a fact's outlet type (memory_facts.source_type), mapped to the rubric's vocabulary. Ids
 * the block does not list are left out (enforceFactsOnly drops them from the signals anyway). Pure.
 */
export function evidenceFromSnapshot(block: string | null, citedIds: string[], outletOf: (factId: string) => string | null = () => null): EvaluatorOutput["evidence"] {
  const facts = new Map<string, { claim: string; where: string; date: string | null }>();
  const platforms = new Map<string, { line: string; date: string | null }>();
  for (const line of String(block ?? "").split("\n")) {
    const f = FACT_LINE.exec(line);
    if (f) { facts.set(f[1].toLowerCase(), { claim: f[2], where: f[3], date: f[4] ?? null }); continue; }
    const p = PLATFORM_LINE.exec(line);
    if (p) platforms.set(p[1].toLowerCase(), { line: line.slice(2), date: /observed (\d{4}-\d{2}-\d{2})/.exec(line)?.[1] ?? null });
  }
  const out: EvaluatorOutput["evidence"] = [];
  const seen = new Set<string>();
  for (const raw of citedIds) {
    const uuid = UUID.exec(raw)?.[0]?.toLowerCase();
    const platform = /^\s*\[?\s*platform\s*:\s*([a-z0-9_]+)/i.exec(raw)?.[1]?.toLowerCase();
    if (uuid && facts.has(uuid)) {
      if (seen.has(uuid)) continue;
      seen.add(uuid);
      const f = facts.get(uuid)!;
      // "Title https://..." or "https://..." or a ref: the URL is the last http(s) token, the title what precedes it.
      const url = /(https?:\/\/\S+)$/.exec(f.where)?.[1] ?? null;
      const title = (url ? f.where.slice(0, -url.length) : f.where).trim();
      // The claim as the block lists it, without the " (about ...)" subject note the block adds to a context fact.
      const claim = f.claim.replace(/ \(about [^)]*\)$/, "");
      out.push({ id: uuid, claim, sourceTitle: title && title !== "-" ? title : null, sourceUrl: url, sourceType: rubricSourceType(outletOf(uuid)), date: f.date });
    } else if (platform && platforms.has(platform)) {
      const id = `platform:${platform}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const p = platforms.get(platform)!;
      out.push({ id, claim: p.line, sourceTitle: null, sourceUrl: null, sourceType: "platform", date: p.date });
    }
  }
  return out;
}

/** Every evidence id a parsed answer cites, in order: the signals' evidence_ids, then the notes' (0.4.0 tags). */
export function citedEvidenceIds(out: Pick<EvaluatorOutput, "judgements">, notes?: TaggedNotes): string[] {
  const ids = out.judgements.flatMap((j) => j.evidenceIds);
  if (notes) for (const n of [...notes.keyStrengths, ...notes.keyConstraints, ...notes.importantMissingData, ...(notes.summary ?? [])]) ids.push(...n.evidenceIds);
  return ids;
}

// ── notes (0.4.0) ─────────────────────────────────────────────────────────────

/** One tagged note or summary sentence as the 0.4.0 evaluator returns it. */
export interface TaggedNote {
  text: string;
  dimension: string | null;
  evidenceIds: string[];
}
export interface TaggedNotes {
  keyStrengths: TaggedNote[];
  keyConstraints: TaggedNote[];
  importantMissingData: TaggedNote[];
  /** Null when the summary came back as one plain string (untagged). */
  summary: TaggedNote[] | null;
}

const tagged = (v: unknown): TaggedNote[] => (Array.isArray(v) ? v : []).map((x: any) => (
  x && typeof x === "object"
    ? { text: typeof x.text === "string" ? x.text.trim() : "", dimension: typeof x.dimension === "string" ? x.dimension.trim().toLowerCase() : null, evidenceIds: Array.isArray(x.evidence_ids) ? x.evidence_ids.map(String) : [] }
    : { text: String(x ?? "").trim(), dimension: null, evidenceIds: [] }   // an untagged string note
)).filter((n) => n.text);

/** The tagged notes in a parsed facts-only answer (the raw JSON, before normalizeJudgements flattens them to text). */
export function notesFrom(json: any): TaggedNotes {
  return {
    keyStrengths: tagged(json?.key_strengths),
    keyConstraints: tagged(json?.key_constraints),
    importantMissingData: tagged(json?.important_missing_data),
    summary: Array.isArray(json?.marketability_summary) ? tagged(json.marketability_summary) : null,
  };
}

/**
 * A dimension is MISSING when at least this share of its sub-signals is missing — the same line at which Home and the
 * athlete state read a dimension as "unknown" (intelligence/state/build.ts IMPUTED_SHARE_FOR_UNKNOWN; a test pins them
 * equal). A strength or constraint about a missing dimension contradicts the scores.
 */
export const DIMENSION_MISSING_SHARE = 0.5;

/** The dimensions whose sub-signals are mostly missing, from the (enforced) judgements. */
export function missingDimensions(judgements: EvaluatorOutput["judgements"]): Set<string> {
  const by = new Map<string, { total: number; missing: number }>();
  for (const j of judgements) {
    const c = by.get(j.dimension) ?? { total: 0, missing: 0 };
    c.total++;
    if (j.status !== "scored") c.missing++;
    by.set(j.dimension, c);
  }
  return new Set([...by].filter(([, c]) => c.total > 0 && c.missing / c.total >= DIMENSION_MISSING_SHARE).map(([d]) => d));
}

export type NoteDropReason = "no_dimension" | "dimension_missing" | "personal_care" | "conduct_care" | "context_only";

/**
 * Why a note may not stand, or null when it may. The care rule for free text is STRICTER than for signals: a note (or
 * summary sentence) that cites a personal care fact is dropped whatever its dimension — the notes are athlete-facing
 * copy. A conduct care fact may back only a momentum or brand_fit note. A note whose valid evidence is all context
 * (facts about others) is dropped. Strengths, constraints and summary sentences about a missing dimension are dropped;
 * a missing-data note is ABOUT a gap, so a missing dimension is exactly where it belongs.
 */
export function noteDropReason(n: TaggedNote, kind: "strength" | "constraint" | "missing_data" | "summary", allowed: FactsOnlyAllowed, missing: ReadonlySet<string>): NoteDropReason | null {
  const okDimension = n.dimension != null && (NOTE_DIMENSIONS.includes(n.dimension) || (kind === "summary" && n.dimension === OVERALL_DIMENSION));
  if (!okDimension) return "no_dimension";
  const ids = n.evidenceIds.map((raw) => canonicalEvidenceId(raw, allowed)).filter((x): x is string => !!x);
  if (ids.some((id) => allowed.careIds.get(id) === "personal")) return "personal_care";
  if (ids.some((id) => allowed.careIds.get(id) === "conduct") && n.dimension !== CARE_ALLOWED_DIMENSION && n.dimension !== CONDUCT_ALLOWED_SIGNAL.split(".")[0]) return "conduct_care";
  if (ids.length && ids.every((id) => allowed.contextIds.has(id))) return "context_only";
  if (kind !== "missing_data" && n.dimension !== OVERALL_DIMENSION && missing.has(n.dimension!)) return "dimension_missing";
  return null;
}

export interface FactsOnlyEnforcement {
  /** Cited ids that named nothing Nomila supplied, per signal ("dimension.key"). */
  unknownIds: Record<string, string[]>;
  /** Care-fact ids removed from a signal their kind may not inform, per signal. */
  careRemoved: Record<string, string[]>;
  /** Signals the model scored that were left with no valid evidence, and so became missing. */
  demoted: string[];
  /** Signals the model scored on facts about others alone (0.4.0), and so became missing. */
  contextOnly: string[];
  /** Notes and summary sentences removed (0.4.0), with why — the text is not kept here, only where it was and why. */
  notesDropped: Array<{ field: "key_strengths" | "key_constraints" | "important_missing_data" | "marketability_summary"; index: number; dimension: string | null; reason: NoteDropReason | "untagged_summary" }>;
}

/**
 * 0.4.0 (the default Gemini evaluator): its "evidence" echo routinely leaves out some of the facts its signals and notes
 * cite (on real dev runs 16 and 26 cited ids had no entry), so those citations dangled and My Intelligence listed fewer
 * sources than were used. This completes the echo: every echoed item is kept as it came back, in its order, and each
 * `rebuilt` item (evidenceFromSnapshot: only ids the snapshot's block lists, so nothing Nomila did not send) whose id
 * the echo did not already carry is appended. The judgements are not touched and the score never reads this list; what
 * it changes is the source listing — the cited facts now have entries, and a signal that cites only the connected
 * platform block (platform:<p>, which the echo also drops) is labelled platform data instead of web research.
 * Returns the completed list and how many were added. Pure.
 */
export function completeEvidence(echoed: EvaluatorOutput["evidence"], rebuilt: EvaluatorOutput["evidence"]): { evidence: EvaluatorOutput["evidence"]; added: number } {
  // The echo may write an id in another form ("[<uuid>]", upper case): compare on the form the snapshot uses.
  const key = (raw: string) => {
    const uuid = UUID.exec(raw)?.[0]?.toLowerCase();
    const platform = /^\s*\[?\s*platform\s*:\s*([a-z0-9_]+)/i.exec(raw)?.[1]?.toLowerCase();
    return uuid ?? (platform ? `platform:${platform}` : raw);
  };
  const have = new Set(echoed.map((e) => key(String(e.id ?? ""))));
  const missing = rebuilt.filter((e) => !have.has(e.id));
  return { evidence: [...echoed, ...missing], added: missing.length };
}

/**
 * Hold the facts-only answer to its contract: every cited id must be a fact (or platform) Nomila supplied, written in
 * Nomila's form; personal care facts may support only momentum signals (so never brand_safety), conduct care facts only
 * momentum and brand_safety; a signal whose only valid evidence is facts about others is not supported; a scored
 * signal left with no valid evidence is missing, not scored on nothing. The evidence list keeps only the items that
 * name something supplied.
 *
 * THE NOTES (0.4.0, given `notes` from the raw answer): key_strengths, key_constraints, important_missing_data and the
 * summary are athlete-facing free text, held to the same rules (noteDropReason): each must name a dimension, none may
 * rest on a personal care fact, none on context alone, and no strength, constraint or summary sentence may be about a
 * missing dimension. The surviving texts replace the output's lists and summary; a summary that came back as one
 * untagged string is dropped (it cannot be checked). Without `notes` (the frozen evaluator) the notes are untouched.
 * Pure; returns the corrected output and what it changed (stored with the run, for the audit).
 */
export function enforceFactsOnly(out: EvaluatorOutput, allowed: FactsOnlyAllowed, notes?: TaggedNotes): { output: EvaluatorOutput; enforcement: FactsOnlyEnforcement } {
  const enforcement: FactsOnlyEnforcement = { unknownIds: {}, careRemoved: {}, demoted: [], contextOnly: [], notesDropped: [] };
  const judgements = out.judgements.map((j) => {
    const path = `${j.dimension}.${j.key}`;
    const ids: string[] = [];
    for (const raw of j.evidenceIds) {
      const id = canonicalEvidenceId(raw, allowed);
      if (!id) { (enforcement.unknownIds[path] ??= []).push(raw); continue; }
      const kind = allowed.careIds.get(id);
      if (kind && !careCitationAllowed(kind, j.dimension, j.key)) { (enforcement.careRemoved[path] ??= []).push(id); continue; }
      if (!ids.includes(id)) ids.push(id);
    }
    if (j.status === "scored" && !ids.length) {
      enforcement.demoted.push(path);
      return { ...j, status: "missing" as const, score: null, confidence: null, evidenceIds: [] };
    }
    if (j.status === "scored" && ids.every((id) => allowed.contextIds.has(id))) {
      // Facts about others are background: a score that rests on nothing else is not about this athlete.
      enforcement.contextOnly.push(path);
      return { ...j, status: "missing" as const, score: null, confidence: null, evidenceIds: [] };
    }
    return { ...j, evidenceIds: ids };
  });
  const evidence = out.evidence
    .map((e) => ({ ...e, id: canonicalEvidenceId(e.id, allowed) ?? "" }))
    .filter((e, i, all) => e.id && all.findIndex((x) => x.id === e.id) === i);
  if (!notes) return { output: { ...out, judgements, evidence }, enforcement };

  const missing = missingDimensions(judgements);
  const keep = (field: FactsOnlyEnforcement["notesDropped"][number]["field"], kind: Parameters<typeof noteDropReason>[1], list: TaggedNote[]): TaggedNote[] =>
    list.filter((n, index) => {
      const reason = noteDropReason(n, kind, allowed, missing);
      if (reason) enforcement.notesDropped.push({ field, index, dimension: n.dimension, reason });
      return !reason;
    });
  const keyStrengths = keep("key_strengths", "strength", notes.keyStrengths).map((n) => n.text);
  const keyConstraints = keep("key_constraints", "constraint", notes.keyConstraints).map((n) => n.text);
  const importantMissingData = keep("important_missing_data", "missing_data", notes.importantMissingData).map((n) => n.text);
  let summary: string | null = null;
  if (notes.summary) {
    const kept = keep("marketability_summary", "summary", notes.summary);
    summary = kept.length ? kept.map((n) => n.text).join(" ") : null;
  } else if (out.summary) {
    enforcement.notesDropped.push({ field: "marketability_summary", index: 0, dimension: null, reason: "untagged_summary" });
  }
  return {
    output: {
      ...out, judgements, evidence, keyStrengths, keyConstraints, importantMissingData,
      summary, summaryWords: summary ? summary.trim().split(/\s+/).length : 0,
    },
    enforcement,
  };
}
