/**
 * marketabilityBeta1Evaluator.ts — the production evaluator client: frozen prompt out, 44 judgements back.
 *
 * This is the only production path to a marketability provider call. It was lifted out of the calibration harness
 * (server/scripts/calibration/blindEval/runBlindEval.ts) unchanged in behaviour, for the reason ADR-017 gives: the
 * evaluator owns qualitative judgment, so the judgment path has to be production code under the freeze gates rather
 * than a script. The harness now imports these functions, so the 37-athlete development cohort and a live athlete are
 * parsed by the same code — a divergence there would silently invalidate the validation the freeze rests on.
 *
 * ONE PROVIDER, DELIBERATELY. The benchmark compared three; Gemini under Google Search grounding with default thinking
 * is the frozen condition that produced Spearman 0.887 against the development reference set. Adding a provider here
 * is not a config change, it is a new validation run.
 *
 * NO SEARCH (4 Nov 2026, "one search provider", owner decision): the search-enabled condition is RETIRED. Every
 * production call is the facts-only call — no googleSearch tool — so M.I.A. scores only from the facts research found
 * and stored. An athlete with no memory facts is not evaluated at all (the orchestrator skips her: "no facts yet").
 * EVALUATOR_VERSION / EVALUATOR_CONDITIONS stay: they label the frozen runs already stored.
 *
 * WHAT THIS MODULE DOES NOT DO: it does not decide, score, retry, persist, or know why it was called. It converts a
 * prompt into judgements and reports honestly when it could not. Everything else belongs to the orchestrator.
 */
import { createHash } from "node:crypto";
import { genai, GEMINI } from "../lib/models";
import { priceOf } from "../agent/models";
import { BLIND_EVAL_SPEC_V02_VERSION } from "./marketabilityBeta1EvaluatorSpec";

/** The frozen evaluator condition, recorded on every run so a result is always attributable to how it was produced. */
export const EVALUATOR_VERSION = BLIND_EVAL_SPEC_V02_VERSION;
export const EVALUATOR_PROVIDER = "gemini" as const;
export const EVALUATOR_CONDITIONS = "google-search-grounding; thinking=default; temperature=1.0" as const;

/** Benchmark cost model (gemini_direct). Output includes thought tokens, which is most of the cost on this task. */
const RATES = { perCallUsd: 0.035, inPerM: 1.5, outPerM: 9.0 };

export type Confidence = "HIGH" | "MEDIUM" | "LOW";
const CONF = new Set<string>(["HIGH", "MEDIUM", "LOW"]);

export interface Judgement {
  dimension: string;
  key: string;
  /** `missing` is a legitimate, expected answer — the evaluator is told to say so rather than guess. */
  status: "scored" | "missing";
  score: number | null;
  confidence: Confidence | null;
  evidenceIds: string[];
  rationale: string | null;
  /** Whether the evaluator returned a node for this signal at all, as opposed to omitting it. */
  present: boolean;
}

export interface EvaluatorOutput {
  judgements: Judgement[];
  identityConfidence: string | null;
  summary: string | null;
  summaryWords: number;
  evidence: Array<{ id: string; claim: string | null; sourceTitle: string | null; sourceUrl: string | null; sourceType: string | null; date: string | null }>;
  dimensionAssessments: Record<string, { prose: string | null; confidence: Confidence | null; confidenceReason: string | null }>;
  overallConfidence: { level: Confidence | null; explanation: string | null } | null;
  keyStrengths: string[];
  keyConstraints: string[];
  importantMissingData: string[];
  identityOrEvidenceRisks: string[];
}

/**
 * A response we cannot turn into an assessment.
 *
 * TWO SUBCLASSES, BECAUSE THEY WANT OPPOSITE HANDLING — and conflating them cost a real athlete an assessment. The
 * original reasoning was "the model produced that response and would produce it again", which is true of a refusal
 * and false of a formatting accident against a non-deterministic model.
 *
 * In the 43-athlete cohort run, one evaluation (Jimmer Fredette) returned a COMPLETE response — finishReason STOP,
 * not truncated, 26KB, properly closed fence — whose JSON contained `"rationale": His narrat…`, a single missing
 * opening quote. One character invalidated the document. A retry would almost certainly have produced valid JSON;
 * under the old classification no retry ever came, and the athlete simply has no assessment.
 */
export abstract class EvaluatorValidationError extends Error {
  /** Whether asking the same question again is likely to produce a different, usable answer. */
  abstract readonly retryable: boolean;
}

/**
 * The model returned something we could not parse — malformed JSON, or no JSON at all. RETRYABLE: the evaluator is
 * stochastic, so the next sample is very likely to be well-formed.
 *
 * "No JSON at all" is deliberately included even though it could also be a prose refusal, which would not benefit
 * from a retry. The asymmetry decides it: a wasted retry costs ~$0.21 and is bounded at two attempts, while
 * misclassifying a recoverable formatting failure as permanent loses the assessment entirely.
 *
 * NO REPAIR, EVER. Inserting the missing quote would be guessing at intent, and a repaired document is
 * indistinguishable from an untouched one — it produces a plausible assessment with nothing marking that anything
 * was altered. A retry produces a clean new sample with its own run row and attempt number.
 */
export class EvaluatorParseError extends EvaluatorValidationError {
  readonly retryable = true;
  constructor(message: string) { super(message); this.name = "EvaluatorParseError"; }
}

/**
 * The model answered, and its answer is unusable — it parsed, and not one signal came back scored. NOT RETRYABLE:
 * the evaluator considered the athlete and declined to score anything, and asking again buys the same refusal at
 * ~$0.21 a time. Scoring it anyway would renormalize a composite built entirely out of missingness.
 */
export class EvaluatorRefusedError extends EvaluatorValidationError {
  readonly retryable = false;
  constructor(message: string) { super(message); this.name = "EvaluatorRefusedError"; }
}

export interface ProviderCall {
  model: string;
  modelVersion: string | null;
  responseId: string | null;
  latencyMs: number;
  finishReason: string | null;
  truncated: boolean;
  usage: { promptTokens: number | null; outputTokens: number | null; thoughtTokens: number | null; totalTokens: number | null; searchCalls: number | null };
  costUsd: number;
  text: string;
  /** Provider-native grounding: chunks, supports and the queries it actually ran. Kept for auditability of claims. */
  native: unknown;
}

/** Pull the JSON object out of a grounded text response, which may or may not fence it. */
export function extractJson(text: string): { json: any | null; error: string | null } {
  const fence = /```json\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fence?.[1], text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)].filter((c): c is string => !!c && c.trim().startsWith("{"));
  for (const c of candidates) { try { return { json: JSON.parse(c), error: null }; } catch { /* try the next candidate */ } }
  return { json: null, error: candidates.length ? "JSON did not parse" : "no JSON object found" };
}

/**
 * Normalize a parsed response into exactly the judgement set the ACTIVE PARAMS define.
 *
 * The sub-weight map is passed in rather than imported so the keys we parse are by construction the keys we score: if
 * the params version changes the signal set, this function follows it in the same breath. A key the evaluator did not
 * answer becomes `missing` rather than absent — a silently dropped signal would renormalize its dimension without
 * anyone noticing, which is precisely the failure the structurally-private policy had to be made explicit to avoid.
 */
export function normalizeJudgements(json: any | null, subWeights: Record<string, Record<string, number>>): EvaluatorOutput {
  const judgements: Judgement[] = [];
  for (const [dimension, sub] of Object.entries(subWeights)) {
    for (const key of Object.keys(sub)) {
      const node = json?.dimensions?.[dimension]?.[key];
      const present = !!node && typeof node === "object";
      const rawScore = present ? node.score : null;
      const score = typeof rawScore === "number" && Number.isFinite(rawScore) ? Math.max(0, Math.min(100, rawScore)) : null;
      const status: "scored" | "missing" = present && node.status === "scored" && score != null ? "scored" : "missing";
      const conf = present && typeof node.confidence === "string" && CONF.has(node.confidence.toUpperCase()) ? (node.confidence.toUpperCase() as Confidence) : null;
      judgements.push({
        dimension, key, status,
        score: status === "scored" ? score : null,
        confidence: status === "scored" ? conf : null,
        evidenceIds: present && Array.isArray(node.evidence_ids) ? node.evidence_ids.map(String) : [],
        rationale: present && typeof node.rationale === "string" ? node.rationale : null,
        present,
      });
    }
  }

  // The facts-only evaluator (facts-eval-spec 0.4.0) returns notes and the summary as {text, dimension, evidence_ids}
  // objects; their text is read here (factsOnlySpec.enforceFactsOnly then holds them to their tags). The frozen
  // evaluator returns strings, read exactly as before.
  const textOf = (x: unknown) => (x && typeof x === "object" && typeof (x as any).text === "string" ? (x as any).text : String(x));
  const rawSummary = json?.marketability_summary;
  const summary = typeof rawSummary === "string" ? rawSummary
    : Array.isArray(rawSummary) ? rawSummary.map(textOf).filter((t: string) => t.trim()).join(" ") || null
    : null;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(textOf) : []);
  const dimensionAssessments: EvaluatorOutput["dimensionAssessments"] = {};
  for (const dimension of Object.keys(subWeights)) {
    const node = json?.dimension_assessments?.[dimension];
    if (node && typeof node === "object") {
      dimensionAssessments[dimension] = {
        prose: typeof node.prose === "string" ? node.prose : null,
        confidence: typeof node.confidence === "string" && CONF.has(node.confidence.toUpperCase()) ? (node.confidence.toUpperCase() as Confidence) : null,
        confidenceReason: typeof node.confidence_reason === "string" ? node.confidence_reason : null,
      };
    }
  }
  const oc = json?.overall_confidence;

  return {
    judgements,
    identityConfidence: typeof json?.athlete?.identity_confidence === "string" ? json.athlete.identity_confidence : null,
    summary,
    summaryWords: summary ? summary.trim().split(/\s+/).length : 0,
    evidence: Array.isArray(json?.evidence)
      ? json.evidence.map((e: any) => ({ id: String(e?.id ?? ""), claim: e?.claim ?? null, sourceTitle: e?.source_title ?? null, sourceUrl: e?.source_url ?? null, sourceType: e?.source_type ?? null, date: e?.published_or_observed_date ?? null }))
      : [],
    dimensionAssessments,
    overallConfidence: oc && typeof oc === "object"
      ? { level: typeof oc.level === "string" && CONF.has(oc.level.toUpperCase()) ? (oc.level.toUpperCase() as Confidence) : null, explanation: typeof oc.explanation === "string" ? oc.explanation : null }
      : null,
    keyStrengths: list(json?.key_strengths),
    keyConstraints: list(json?.key_constraints),
    importantMissingData: list(json?.important_missing_data),
    identityOrEvidenceRisks: list(json?.identity_or_evidence_risks),
  };
}

/**
 * Parse a raw response into judgements, or refuse.
 *
 * A response is unusable when it did not parse, or when not one signal came back scored. The second case matters: a
 * response that answered nothing would otherwise renormalize into a composite built entirely out of missing data, and
 * a score with no scored inputs is worse than no score — it looks like an assessment and is not one.
 */
export function parseEvaluatorResponse(text: string, subWeights: Record<string, Record<string, number>>): EvaluatorOutput {
  const { json, error } = extractJson(text);
  if (error) throw new EvaluatorParseError(error);
  const out = normalizeJudgements(json, subWeights);
  if (!out.judgements.some((j) => j.status === "scored")) throw new EvaluatorRefusedError("no signal came back scored");
  return out;
}

/** sha256 of the judgement set, so a stored result is traceable to the exact judgements that produced it. */
export function judgementsDigest(judgements: Judgement[]): string {
  const canonical = JSON.stringify(
    [...judgements]
      .sort((a, b) => `${a.dimension}.${a.key}`.localeCompare(`${b.dimension}.${b.key}`))
      .map((j) => [j.dimension, j.key, j.status, j.score, j.confidence]),
  );
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Call the facts-only evaluator (miaPreview/factsOnlySpec.ts): the frozen model's temperature and token ceiling with NO
 * tools, so it can only score from the facts in its prompt. Transport failures throw as-is, for the orchestrator to
 * retry. There is no search-enabled call any more (see the module note).
 *
 * The 65536 → 32768 fallback is a model ceiling, not a preference: a truncated response is a validation failure rather
 * than a cheaper answer. `truncated` is recorded either way so a run cut short is visible rather than inferred from a
 * thin judgement set.
 */
/**
 * The facts-only Gemini call's model and thinking. MIA_FACTS_GEMINI_MODEL (default GEMINI.flash, as today) and MIA_FACTS_GEMINI_THINKING (unset ⇒
 * the model's default thinking, as today; "low" | "medium" | "high" ⇒ thinkingConfig.thinkingLevel). E.g. the
 * search + score comparison's pick: MIA_FACTS_GEMINI_MODEL=gemini-3.8-flash, MIA_FACTS_GEMINI_THINKING=low.
 */
export interface FactsGeminiChoice { model: string; thinkingLevel: "low" | "medium" | "high" | null }
export function factsGeminiChoice(env: NodeJS.ProcessEnv = process.env): FactsGeminiChoice {
  const t = env.MIA_FACTS_GEMINI_THINKING?.trim().toLowerCase();
  return { model: env.MIA_FACTS_GEMINI_MODEL?.trim() || GEMINI.flash, thinkingLevel: t === "low" || t === "medium" || t === "high" ? t : null };
}
/** The conditions a facts-only Gemini run records when its model or thinking is not the default. */
export const factsGeminiConditions = (c: FactsGeminiChoice) => `no-tools (facts only); model=${c.model}; thinking=${c.thinkingLevel ?? "default"}; temperature=1.0`;

export async function callEvaluator(prompt: string, opts: { facts?: FactsGeminiChoice } = {}): Promise<ProviderCall & { conditions?: string }> {
  const t0 = Date.now();
  const config: any = { temperature: 1.0, maxOutputTokens: 65536 };
  // The configured model and thinking (defaults: GEMINI.flash, default thinking).
  const facts = opts.facts ?? factsGeminiChoice();
  const model = facts.model;
  if (facts.thinkingLevel) config.thinkingConfig = { thinkingLevel: facts.thinkingLevel };
  const custom = facts.model !== GEMINI.flash || !!facts.thinkingLevel;
  const contents = [{ role: "user", parts: [{ text: prompt }] }];
  let r: any;
  try {
    r = await genai().models.generateContent({ model, contents, config });
  } catch (e: any) {
    if (!/maxOutputTokens|max_output_tokens|65536/i.test(String(e?.message ?? e))) throw e;
    config.maxOutputTokens = 32768;
    r = await genai().models.generateContent({ model, contents, config });
  }

  const cand = r.candidates?.[0];
  const gm = cand?.groundingMetadata ?? {};
  const u = r.usageMetadata ?? {};
  const outTok = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  // The default call keeps its recorded rates; another model is priced from the agent's table (agent/models.ts).
  const rates = custom && model !== GEMINI.flash ? (() => { const p = priceOf(model); return { inPerM: p.inputPerMTok, outPerM: p.outputPerMTok }; })() : RATES;
  return {
    model,
    modelVersion: r.modelVersion ?? null,
    responseId: r.responseId ?? null,
    latencyMs: Date.now() - t0,
    finishReason: cand?.finishReason ?? null,
    truncated: cand?.finishReason === "MAX_TOKENS",
    usage: {
      promptTokens: u.promptTokenCount ?? null, outputTokens: u.candidatesTokenCount ?? null,
      thoughtTokens: u.thoughtsTokenCount ?? null, totalTokens: u.totalTokenCount ?? null,
      searchCalls: (gm.webSearchQueries ?? []).length,
    },
    costUsd: ((u.promptTokenCount ?? 0) / 1e6) * rates.inPerM + (outTok / 1e6) * rates.outPerM,
    text: r.text ?? "",
    native: { groundingChunks: gm.groundingChunks ?? [], groundingSupports: gm.groundingSupports ?? [], webSearchQueries: gm.webSearchQueries ?? [], config: { ...config, thinking: facts.thinkingLevel ?? "default" } },
    ...(custom ? { conditions: factsGeminiConditions(facts) } : {}),
  };
}
