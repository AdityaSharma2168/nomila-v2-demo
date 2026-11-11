/**
 * miaPreview/factsOnlyInMemory.ts — the EXISTING facts-only M.I.A. scorer on facts held in memory only (nothing read
 * from or written to the snapshot, evaluation, or ledger tables). For the leanRun command's shadow mode: "what score
 * would these facts get", with no write anywhere.
 *
 * The same pieces, in the same order, as the live path:
 *   block     selectFactsOnlyInput (default, or topic-balanced) → measuredAccounts → composeFactsOnlyBlock, with the
 *             snapshot's sources listed exactly as buildMemoryFactsSnapshot lists them (and its subject post-check)
 *   prompt    factsOnlyPrompt (0.4.0, or 0.6.0 when MIA_FACTS_NO_EVIDENCE_ECHO) — the prompt text is not touched
 *   call      callEvaluator on the configured Gemini model and thinking (factsGeminiChoice), or the
 *             opt-in OpenAI call (MIA_FACTS_EVALUATOR_PROVIDER=openai)
 *   enforce   parseEvaluatorResponse → enforceFactsOnly (care, context, notes), one retry on a parse failure as the
 *             evaluate step's bounded retry does
 *   score     buildBeta1Dimensions → computeMarketabilityBeta1 with the active params (read only)
 */
import { callEvaluator, extractJson, factsGeminiChoice, parseEvaluatorResponse, type FactsGeminiChoice, type ProviderCall } from "../marketabilityBeta1Evaluator";
import { buildBeta1Dimensions } from "../marketabilityBeta1Freeze";
import { computeMarketabilityBeta1, type MarketabilityBeta1Input } from "../marketabilityBeta1";
import { createBeta1Normalizer } from "../marketabilityBeta1Normalization";
import { loadBeta1Params } from "../marketabilityBeta1Params";
import type { NormalizedSignal } from "../intelligence/types";
import {
  allowedFromSources, enforceFactsOnly, factRefs, factsOnlyPrompt, resolveFactRefs, miaFactsEvaluatorProvider, miaFactsEvaluatorVersion, notesFrom,
  CARE_CONDUCT_SOURCE_CLASS, CARE_SOURCE_CLASS, CONTEXT_SOURCE_CLASS, MIA_FACTS_EVALUATOR_VERSION_GEMINI_NO_ECHO, MIA_FACTS_PROMPT_VERSION_NO_ECHO, MIA_FACTS_PROMPT_VERSION,
} from "./factsOnlySpec";
import { callFactsEvaluatorOpenAI } from "./factsOnlyOpenAI";
import {
  composeFactsOnlyBlock, factsBlockSubjectViolations, measuredAccounts, selectFactsOnlyInput, FOUND_SOURCE_CLASS, MAX_PUBLIC_FACTS, measuredSourceClassOf,
  MEMORY_SOURCE_PLATFORM, aboutAthlete, type PreviewFact,
} from "./memoryAdapter";

export interface InMemoryScoreInput {
  athleteId: string;
  name: string;
  sport: string;
  facts: PreviewFact[];
  /** platform → handle of her connected accounts (the measured section's account names). */
  handles: Map<string, string>;
  balanced: boolean;
}

/** What went into the scorer: the counts per section and the public facts per topic (selected and cut). */
export interface ScorerInputSummary {
  publicAboutHer: number;
  publicSelected: number;
  publicCut: number;
  cap: number;
  selection: "default" | "topic_balanced";
  selectedByTopic: Record<string, number>;
  cutByTopic: Record<string, number>;
  care: number;
  context: number;
  measured: number;
  /** Measured readings from a platform's public API (a handle she confirmed), of `measured`. */
  measuredPublic: number;
  blockChars: number;
}

export interface InMemoryScore {
  status: "ok" | "failed";
  score: number | null;
  composite: number | null;
  confidence: number | null;
  scored: number | null;
  identityConfidence: string | null;
  provider: "gemini" | "openai";
  model: string;
  conditions: string;
  attempts: number;
  ms: number;
  costUsd: number;
  error: string | null;
  input: ScorerInputSummary;
}

/** The evaluator call (injectable for tests: no provider is reached). */
export type FactsCall = (prompt: string, subWeights: Record<string, Record<string, number>>, provider: "gemini" | "openai", gemini: FactsGeminiChoice) => Promise<ProviderCall & { conditions?: string }>;
const realCall: FactsCall = (prompt, subWeights, provider, gemini) =>
  provider === "openai" ? callFactsEvaluatorOpenAI(prompt, subWeights) : callEvaluator(prompt, { facts: gemini });

const countBy = (fs: PreviewFact[]) => fs.reduce<Record<string, number>>((a, f) => ({ ...a, [f.topic || "other"]: (a[f.topic || "other"] ?? 0) + 1 }), {});

/** Pure: the facts-only block and sources for these facts, as buildMemoryFactsSnapshot builds them. */
export function factsOnlyInputFor(i: Pick<InMemoryScoreInput, "name" | "facts" | "handles" | "balanced">) {
  const selected = selectFactsOnlyInput(i.facts, i.name, { balanced: i.balanced });
  const fromMemory = measuredAccounts(selected.measured, i.handles, new Set());
  const accounts = fromMemory.map((m) => m.account);
  const usedMeasured = fromMemory.flatMap((m) => m.facts);
  const block = composeFactsOnlyBlock(accounts, selected.public, selected.care, selected.context);
  const violations = factsBlockSubjectViolations(block, i.facts, i.name);
  if (violations.length) throw new Error(`M.I.A. facts block lists ${violations.length} fact(s) about another subject as the athlete's`);
  const sources = [
    ...accounts.map((a) => ({ platform: a.platform, accountId: a.handle, observedAt: a.observedAt, sourceClass: a.source })),
    ...usedMeasured.map((f) => ({ platform: MEMORY_SOURCE_PLATFORM, accountId: f.id, observedAt: f.createdAt, sourceClass: measuredSourceClassOf(f) })),
    ...selected.public.map((f) => ({ platform: MEMORY_SOURCE_PLATFORM, accountId: f.id, observedAt: f.createdAt, sourceClass: FOUND_SOURCE_CLASS })),
    ...selected.context.map((f) => ({ platform: MEMORY_SOURCE_PLATFORM, accountId: f.id, observedAt: f.createdAt, sourceClass: CONTEXT_SOURCE_CLASS })),
    ...selected.carePersonal.map((f) => ({ platform: MEMORY_SOURCE_PLATFORM, accountId: f.id, observedAt: f.createdAt, sourceClass: CARE_SOURCE_CLASS })),
    ...selected.careConduct.map((f) => ({ platform: MEMORY_SOURCE_PLATFORM, accountId: f.id, observedAt: f.createdAt, sourceClass: CARE_CONDUCT_SOURCE_CLASS })),
  ];
  const aboutHer = i.facts.filter((f) => f.status === "active" && f.type === "found" && f.topic !== "moment" && !f.sensitive && aboutAthlete(f, i.name));
  const chosen = new Set(selected.public.map((f) => f.id));
  const summary: ScorerInputSummary = {
    publicAboutHer: aboutHer.length, publicSelected: selected.public.length, publicCut: aboutHer.length - selected.public.length, cap: MAX_PUBLIC_FACTS,
    selection: i.balanced ? "topic_balanced" : "default", selectedByTopic: countBy(selected.public), cutByTopic: countBy(aboutHer.filter((f) => !chosen.has(f.id))),
    care: selected.care.length, context: selected.context.length, measured: usedMeasured.length,
    measuredPublic: usedMeasured.filter((f) => measuredSourceClassOf(f) !== "connected_verified").length, blockChars: block.length,
  };
  return { block, sources, summary };
}

export async function scoreFactsInMemory(i: InMemoryScoreInput, opts: { provider?: "gemini" | "openai"; gemini?: FactsGeminiChoice; call?: FactsCall; asOf?: string; params?: Awaited<ReturnType<typeof loadBeta1Params>> } = {}): Promise<InMemoryScore> {
  const provider = opts.provider ?? miaFactsEvaluatorProvider();
  const gemini = opts.gemini ?? factsGeminiChoice();
  const { block, sources, summary } = factsOnlyInputFor(i);
  const noEcho = provider === "gemini" && miaFactsEvaluatorVersion(provider) === MIA_FACTS_EVALUATOR_VERSION_GEMINI_NO_ECHO;
  const prompt = factsOnlyPrompt({ name: i.name, sport: i.sport }, block, noEcho ? MIA_FACTS_PROMPT_VERSION_NO_ECHO : MIA_FACTS_PROMPT_VERSION);
  const { params, bundle } = opts.params ?? await loadBeta1Params();
  const subWeights = params.config.subWeights;
  const call = opts.call ?? realCall;
  const base = { provider, model: provider === "openai" ? "openai" : gemini.model, conditions: "", attempts: 0, ms: 0, costUsd: 0, input: summary };
  let lastError: string | null = null;
  while (base.attempts < 2) {
    base.attempts++;
    const c = await call(prompt, subWeights, provider, gemini);
    base.ms += c.latencyMs; base.costUsd += c.costUsd; base.model = c.model; base.conditions = c.conditions ?? "";
    let out;
    try {
      if (c.finishReason === "refusal") throw Object.assign(new Error("the provider refused to answer"), { retryable: false });
      out = parseEvaluatorResponse(c.text, subWeights);
    } catch (err: any) {
      lastError = String(err?.message ?? err).slice(0, 300);
      if (err?.retryable) continue;   // a parse failure is asked once more, as the evaluate step's bounded retry does
      break;
    }
    const refs = resolveFactRefs(out, notesFrom(extractJson(c.text).json), factRefs(block).refs);
    const held = enforceFactsOnly(refs.output, allowedFromSources(sources), refs.notes).output;
    if (!held.judgements.some((j) => j.status === "scored")) { lastError = "no signal scored from the supplied facts"; break; }
    const normalizer = createBeta1Normalizer(bundle);
    const asOf = opts.asOf ?? new Date().toISOString();
    const dimensions = buildBeta1Dimensions({ signals: held.judgements } as any, i.sport, (p, s) => normalizer.prior(p as never, s as never) as NormalizedSignal, subWeights, asOf) as MarketabilityBeta1Input["dimensions"];
    const r = computeMarketabilityBeta1({ athleteId: i.athleteId, asOf, dimensions }, params);
    return {
      ...base, status: "ok", score: r.score, composite: r.composite, confidence: r.confidence, scored: held.judgements.filter((j) => j.status === "scored").length,
      identityConfidence: held.identityConfidence, error: null,
    };
  }
  return { ...base, status: "failed", score: null, composite: null, confidence: null, scored: null, identityConfidence: null, error: lastError };
}
