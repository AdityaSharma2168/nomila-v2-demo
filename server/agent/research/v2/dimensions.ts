/**
 * agent/research/v2/dimensions.ts — which research fact topics feed which M.I.A. dimension (owner, 26 Oct 2026), built
 * on v2/plan.ts AIM_TOPICS. The dimension names are the M.I.A.'s own (services/intelligence/types.ts
 * MARKETABILITY_DIMENSIONS; their sub-signals are the active params' subWeights, marketabilityBeta1FrozenParams.ts),
 * grouped as Home's ring groups them (services/miaPreview/preview.ts MIA_GROUPS): Audience, Commercial, Brand,
 * Performance. The topics are the research vocabulary (research/schemas.ts FACT_TOPICS).
 *
 * It is a coverage map for RESEARCH, never an input to the score: the evaluator still decides which facts support
 * which sub-signal. Lean research uses it to (a) see which dimensions the first round left without a single fact and
 * ask one targeted follow-up query for each (cost-capped), and (b) report facts per dimension (the leanRun command).
 */
import { MARKETABILITY_DIMENSIONS, type MarketabilityDimension } from "../../../services/intelligence/types";
import { AIM_TOPICS, type EvidenceAim } from "./plan";

/**
 * Topic → dimension coverage. A topic may feed several dimensions (a media feature is cultural relevance and narrative).
 *   athletic_authority   results and honours (AIM_TOPICS.results + honours) + career, team, status — competition level,
 *                        results, rankings, national status, role, recency
 *   audience_scale       audience (AIM_TOPICS.audience) + demographics — reach, platform breadth, growth
 *   engagement_quality   engagement, social — engagement and reach efficiency (mostly measured: connected accounts)
 *   cultural_relevance   media (AIM_TOPICS.media) + search_trend, reputation, comparable — media volume and quality,
 *                        search interest, conversation, crossover
 *   narrative_power      story, identity, education, cause, media — distinctiveness, story depth, authenticity
 *   brand_fit            cause, identity, reputation, demographics, sponsor — categories, safety, values, geography
 *   commercial_proof     partners (AIM_TOPICS.partners) — verified commercial value, deals, brand quality, renewals
 *   momentum             upcoming (AIM_TOPICS.upcoming) + moment, audience_growth, search_trend, competition — trajectory
 */
export const DIMENSION_TOPICS: Record<MarketabilityDimension, readonly string[]> = {
  athletic_authority: [...AIM_TOPICS.results, ...AIM_TOPICS.honours, "career", "team", "status"],
  audience_scale: [...AIM_TOPICS.audience, "demographics"],
  engagement_quality: ["engagement", "social"],
  cultural_relevance: [...AIM_TOPICS.media, "search_trend", "reputation", "comparable"],
  narrative_power: ["story", "identity", "education", "cause", "media"],
  brand_fit: ["cause", "identity", "reputation", "demographics", "sponsor"],
  commercial_proof: [...AIM_TOPICS.partners],
  momentum: [...AIM_TOPICS.upcoming, "moment", "audience_growth", "search_trend", "competition"],
};

/** The evidence area a dimension's follow-up query aims at (v2/plan.ts leanFollowUpQueries words it). */
export const DIMENSION_FOLLOW_UP: Record<MarketabilityDimension, EvidenceAim> = {
  athletic_authority: "results",
  audience_scale: "audience",
  engagement_quality: "audience",
  cultural_relevance: "media",
  narrative_power: "media",
  brand_fit: "partners",
  commercial_proof: "partners",
  momentum: "upcoming",
};

/** Pure: facts per dimension (facts about the athlete only; a fact counts for every dimension its topic feeds). */
export function factsByDimension(facts: ReadonlyArray<{ topic?: string | null; subject_kind?: string; subjectKind?: string }>): Record<MarketabilityDimension, number> {
  const out = Object.fromEntries(MARKETABILITY_DIMENSIONS.map((d) => [d, 0])) as Record<MarketabilityDimension, number>;
  for (const f of facts) {
    if ((f.subject_kind ?? f.subjectKind ?? "athlete") !== "athlete") continue;
    for (const d of MARKETABILITY_DIMENSIONS) if (DIMENSION_TOPICS[d].includes(f.topic || "other")) out[d]++;
  }
  return out;
}

/** Pure: topic counts → dimension counts (for a summary that only has counts per topic). */
export function dimensionsOfTopicCounts(byTopic: Record<string, number>): Record<MarketabilityDimension, number> {
  const out = Object.fromEntries(MARKETABILITY_DIMENSIONS.map((d) => [d, 0])) as Record<MarketabilityDimension, number>;
  for (const [topic, n] of Object.entries(byTopic)) for (const d of MARKETABILITY_DIMENSIONS) if (DIMENSION_TOPICS[d].includes(topic)) out[d] += n;
  return out;
}

/** Pure: the dimensions with no fact, and the evidence areas (de-duplicated) one follow-up round should ask about. */
export function emptyDimensions(byDimension: Record<MarketabilityDimension, number>, only?: readonly EvidenceAim[] | null): { dimensions: MarketabilityDimension[]; aims: EvidenceAim[] } {
  const dimensions = MARKETABILITY_DIMENSIONS.filter((d) => byDimension[d] === 0 && (!only || only.includes(DIMENSION_FOLLOW_UP[d])));
  return { dimensions, aims: [...new Set(dimensions.map((d) => DIMENSION_FOLLOW_UP[d]))] };
}
