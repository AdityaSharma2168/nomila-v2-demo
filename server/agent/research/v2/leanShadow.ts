/**
 * agent/research/v2/leanShadow.ts — LEAN research in SHADOW mode: the same code path signup_research v4 runs
 * (runLeanResearch → planFactWrites → the facts-only M.I.A. scorer), with NOTHING written anywhere — no fact, no
 * agent_runs row, no snapshot, evaluation or ledger row, no workflow run. The model calls go straight to the provider
 * (extractAll.directModelCall), the search through the existing openai_search provider (no row either), and the score
 * through services/miaPreview/factsOnlyInMemory.ts. What it would have written is computed by the same pure planner
 * the live step uses (leanSave.planFactWrites) and reported.
 *
 * Reads only: the athlete row (name, sport, team via the sanctioned legacyAdapter reader), her facts, her connected
 * accounts' handles and readings, and the active M.I.A. params. server/scripts/research/leanRun.ts is the command.
 *
 *   fresh      score as a NEW sign-up would be scored: only what she said and her measured numbers are kept from her
 *              memory, so the lean record stands alone (comparable with a quick score for a new sign-up). Off: the live
 *              path exactly — the new facts are de-duplicated against, and scored together with, everything she holds.
 *   selection  "balanced" (what v4 uses for a lean athlete while LEAN_SIGNUP_RESEARCH is on) or "default".
 */
import { randomUUID } from "node:crypto";
import type { MemoryFact, ModelChoice } from "../../../../shared/agent";
import { dbStore } from "../dbStore";
import { loadConnectedChannels } from "../connected";
import { readLegacyRow } from "../../../services/intelligence/context/legacyAdapter";
import { loadMemoryFacts, type PreviewFact } from "../../../services/miaPreview/memoryAdapter";
import { scoreFactsInMemory, type FactsCall, type InMemoryScore } from "../../../services/miaPreview/factsOnlyInMemory";
import type { FactsGeminiChoice } from "../../../services/marketabilityBeta1Evaluator";
import type { MarketabilityDimension } from "../../../services/intelligence/types";
import { openaiDiscover, type DiscoverQuery } from "./discover";
import { directModelCall, type LeanModelCall } from "./extractAll";
import { runLeanResearch, type LeanResult, type LeanSearch } from "./lean";
import { planFactWrites, type FactWritePlan } from "./leanSave";
import { dimensionsOfTopicCounts } from "./dimensions";
import type { WikidataGet } from "./wikidata";

export interface ShadowOptions {
  search: LeanSearch;
  dry: boolean;
  fresh: boolean;
  selection: "balanced" | "default";
  extractModel?: ModelChoice | null;
  verifyModel?: ModelChoice | null;
  scorer?: { provider: "gemini" | "openai"; gemini?: FactsGeminiChoice };
  today?: string;
}
export interface ShadowDeps {
  call?: LeanModelCall;
  discoverQuery?: DiscoverQuery | null;
  wikidataGet?: WikidataGet;
  fetchImpl?: typeof fetch;
  scoreCall?: FactsCall;
  scoreParams?: NonNullable<Parameters<typeof scoreFactsInMemory>[1]>["params"];
}

export interface ShadowStep { ms: number; usd: number }
export interface ShadowReport {
  athlete: { id: string; name: string; sport: string; team: string | null };
  outcome: LeanResult["outcome"];
  unconfirmedReason: string | null;
  facts: { extracted: number; checked: number; verified: number; verifyDropped: number; withheld: number; byTopic: Record<string, number>; byDimension: Record<MarketabilityDimension, number> };
  wouldWrite: { insert: number; disputed: number; duplicates: number; dropped: number };
  sources: { distinct: number; pagesRead: number; byVia: Record<string, number>; wikidataHitsKept: number; wikidataHitsSeen: number; wrongPerson: number };
  followUp: LeanResult["followUp"];
  scorer: { input: InMemoryScore["input"] | null; inputByDimension: Record<MarketabilityDimension, number> | null } ;
  score: { status: "ok" | "failed" | "withheld_identity" | "skipped_dry"; value: number | null; confidence: number | null; scored: number | null; model: string | null; conditions: string | null; error: string | null };
  steps: { discovery: ShadowStep; fetch: ShadowStep; rank: ShadowStep; extract: ShadowStep; verify: ShadowStep; score: ShadowStep };
  total: ShadowStep;
  models: { extract: string | null; verify: string | null };
  lean: LeanResult;
  plan: FactWritePlan;
}

const usd = (micro: number) => Math.round(micro) / 1e6;

/** A planned write → the fact the scorer would read (an id of its own; nothing is stored). */
function previewOf(w: FactWritePlan["writes"][number], now: string): PreviewFact {
  const f = w.fact;
  return {
    id: randomUUID(), type: f.type, status: f.status ?? "active", claim: f.claim, subjectKind: f.subject.kind, subjectName: f.subject.name ?? "",
    sourceUrl: f.source.url ?? null, sourceRef: f.source.ref ?? null, sourceTitle: f.source.title ?? null, observedOn: f.date, confidence: f.confidence,
    sensitive: !!f.sensitive, careKind: f.sensitive ? f.careKind ?? "personal" : null, disputes: f.disputes ?? null, createdAt: now, topic: f.topic ?? null,
  };
}

export async function leanShadowRun(a: { id: string; name: string; sport: string }, o: ShadowOptions, d: ShadowDeps = {}): Promise<ShadowReport> {
  const t0 = Date.now();
  const team = (await readLegacyRow(a.id).catch(() => null))?.school ?? null;
  const channels = await loadConnectedChannels(a.id).catch(() => []);
  const held = await dbStore.listFacts(a.id, ["active", "disputed"]);
  const known: MemoryFact[] = o.fresh ? held.filter((f) => f.type === "said") : held;
  const discoverQuery = d.discoverQuery !== undefined ? d.discoverQuery : o.search === "openai" ? openaiDiscover() : null;
  const lean = await runLeanResearch(
    { athlete: { name: a.name, sport: a.sport }, team, handles: channels.map((c) => c.handle).filter((h): h is string => !!h), known, today: o.today ?? new Date().toISOString().slice(0, 10), moment: "signup" },
    { call: d.call ?? directModelCall(), discoverQuery, wikidataGet: d.wikidataGet, fetchImpl: d.fetchImpl, extractModel: o.extractModel ?? null, verifyModel: o.verifyModel ?? null, dryRun: o.dry },
  );
  const plan = planFactWrites(known, lean.facts, { name: a.name, sport: a.sport }, null);

  let score: ShadowReport["score"] = { status: o.dry ? "skipped_dry" : "withheld_identity", value: null, confidence: null, scored: null, model: null, conditions: null, error: null };
  let scorer: ShadowReport["scorer"] = { input: null, inputByDimension: null };
  let scoreStep: ShadowStep = { ms: 0, usd: 0 };
  if (!o.dry && lean.outcome === "confirmed") {
    const now = new Date().toISOString();
    const memory = (await loadMemoryFacts(a.id, ["active"])).filter((f) => !o.fresh || f.type === "measured" || f.type === "said");
    const disputedNow = new Set(plan.writes.flatMap((w) => (w.conflictsWith && w.conflictsWith.type !== "said" ? [w.conflictsWith.id] : [])));
    const facts = [...memory.filter((f) => !disputedNow.has(f.id)), ...plan.writes.map((w) => previewOf(w, now))];
    const handles = new Map(channels.filter((c) => c.handle).map((c) => [c.platform, String(c.handle).replace(/^@+/, "")] as const));
    const s = await scoreFactsInMemory({ athleteId: a.id, name: a.name, sport: a.sport, facts, handles, balanced: o.selection === "balanced" },
      { ...(o.scorer ? { provider: o.scorer.provider, gemini: o.scorer.gemini } : {}), ...(d.scoreCall ? { call: d.scoreCall } : {}), ...(d.scoreParams ? { params: d.scoreParams } : {}) });
    score = { status: s.status, value: s.score, confidence: s.confidence, scored: s.scored, model: s.model, conditions: s.conditions || null, error: s.error };
    scorer = { input: s.input, inputByDimension: dimensionsOfTopicCounts(s.input.selectedByTopic) };
    scoreStep = { ms: s.ms, usd: Math.round(s.costUsd * 1e6) / 1e6 };
  }
  const steps: ShadowReport["steps"] = {
    discovery: { ms: lean.ms.wikidata + lean.ms.search, usd: usd(lean.costMicroUsd.search) },
    fetch: { ms: lean.ms.fetch, usd: 0 },
    rank: { ms: lean.ms.rank, usd: 0 },
    extract: { ms: lean.ms.extract, usd: usd(lean.costMicroUsd.extract) },
    verify: { ms: lean.ms.verify, usd: usd(lean.costMicroUsd.verify) },
    score: scoreStep,
  };
  const byVia = lean.pages.reduce<Record<string, number>>((m, p) => ({ ...m, [p.via]: (m[p.via] ?? 0) + 1 }), {});
  return {
    athlete: { id: a.id, name: a.name, sport: a.sport, team },
    outcome: lean.outcome, unconfirmedReason: lean.unconfirmedReason,
    facts: {
      extracted: lean.rounds.reduce((n, r) => n + r.extracted, 0), checked: lean.rounds.reduce((n, r) => n + r.checked, 0), verified: lean.facts.length,
      verifyDropped: lean.rounds.reduce((n, r) => n + r.verifyDropped.length, 0), withheld: lean.withheld, byTopic: lean.byTopic.topics, byDimension: lean.byDimension,
    },
    wouldWrite: { insert: plan.writes.length, disputed: plan.conflicts, duplicates: plan.duplicates.length, dropped: plan.dropped.length },
    sources: { distinct: lean.sources.length, pagesRead: lean.pages.length, byVia, wikidataHitsKept: lean.wikidata.hits.filter((h) => h.kept).length, wikidataHitsSeen: lean.wikidata.hits.length, wrongPerson: lean.wrongPerson.length },
    followUp: lean.followUp, scorer, score, steps,
    total: { ms: Date.now() - t0, usd: Math.round(Object.values(steps).reduce((s, x) => s + x.usd, 0) * 1e6) / 1e6 },
    models: { extract: lean.models.extract ? `${lean.models.extract.model}:${lean.models.extract.effort}` : null, verify: lean.models.verify ? `${lean.models.verify.model}:${lean.models.verify.effort}` : null },
    lean, plan,
  };
}
