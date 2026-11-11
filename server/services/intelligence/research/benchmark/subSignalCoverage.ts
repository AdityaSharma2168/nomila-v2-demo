/**
 * research/benchmark/subSignalCoverage.ts — which Beta.1 sub-signals research evidence COULD inform.
 *
 * A reporting map only (PROVISIONAL, for review — not a scoring rule and not a parameter; mirrors
 * ResearchSpec v1 §4.2): it says "this arm produced cited evidence of a kind or fact key the named
 * sub-signal draws on", so the two providers' evidence coverage can be compared per dimension. It
 * never produces a value. Sub-signals fed only by social features, connected data, commercial proof
 * or the signals lane are `research: none` so coverage is never overstated; audience-scale
 * sub-signals stay `none` because research follower counts are evidence only (decision 12 Sep 2026).
 */

import type { EvidenceKindV3 } from "../spec/researchSpecV1";
import type { EvidenceRecord } from "./types";

export interface SubSignalSource { factKeys?: string[]; kinds?: EvidenceKindV3[]; research: "primary" | "partial" | "none"; note?: string }

export const RESEARCH_SUBSIGNAL_COVERAGE: Record<string, SubSignalSource> = {
  "athletic_authority.competition_level":            { factKeys: ["affiliation", "sport"], research: "primary" },
  "athletic_authority.performance_results":          { factKeys: ["achievement", "ranking"], research: "primary" },
  "athletic_authority.rankings_recognition":         { factKeys: ["award", "ranking"], research: "primary" },
  "athletic_authority.national_international_status": { factKeys: ["national_team_participation"], research: "primary" },
  "athletic_authority.role_importance":              { factKeys: ["position"], research: "partial", note: "position only; role weight is a lookup" },
  "athletic_authority.achievement_recency":          { factKeys: ["achievement", "award"], kinds: ["career_event"], research: "primary", note: "dated achievements" },
  "audience_scale.cross_platform_effective_reach":   { research: "none" },
  "audience_scale.sport_level_audience_percentile":  { research: "none" },
  "audience_scale.audience_growth":                  { research: "none" },
  "audience_scale.platform_breadth":                 { kinds: ["social_handle"], research: "partial", note: "handles establish platform presence, not reach" },
  "engagement_quality.engagement_percentile":        { research: "none" },
  "engagement_quality.reach_efficiency":             { research: "none" },
  "engagement_quality.shares_saves_quality":         { research: "none" },
  "engagement_quality.video_retention":              { research: "none" },
  "engagement_quality.story_efficiency":             { research: "none" },
  "engagement_quality.audience_authenticity":        { research: "none", note: "documented concerns are S8 context, value needs platform data" },
  "cultural_relevance.media_volume_percentile":      { kinds: ["press_mention"], research: "partial", note: "counts need a cohort table" },
  "cultural_relevance.media_source_quality":         { kinds: ["press_mention"], research: "primary", note: "Nomila tiers from cited domains" },
  "cultural_relevance.search_interest":              { research: "none", note: "signals lane (Trends)" },
  "cultural_relevance.social_conversation":          { kinds: ["press_mention"], research: "partial", note: "documented moments" },
  "cultural_relevance.crossover_recognition":        { kinds: ["crossover_appearance", "press_mention"], research: "primary" },
  "narrative_power.distinctiveness":                 { kinds: ["narrative_claim"], research: "partial" },
  "narrative_power.story_depth":                     { kinds: ["narrative_claim"], research: "primary" },
  "narrative_power.evidence_authenticity":           { kinds: ["narrative_claim", "press_mention"], research: "partial", note: "cited share" },
  "narrative_power.media_resonance":                 { kinds: ["press_mention"], research: "partial" },
  "narrative_power.commercial_applicability":        { kinds: ["narrative_claim", "brand_mention"], research: "partial" },
  "narrative_power.durability":                      { factKeys: ["achievement"], kinds: ["press_mention"], research: "partial", note: "dated evidence span" },
  "brand_fit.category_breadth":                      { kinds: ["brand_mention"], research: "primary" },
  "brand_fit.brand_safety":                          { kinds: ["reputation_event"], research: "primary", note: "staged S9 evidence; score downstream" },
  "brand_fit.audience_attractiveness":               { research: "none" },
  "brand_fit.identity_values_coherence":             { kinds: ["narrative_claim"], research: "partial" },
  "brand_fit.content_versatility":                   { research: "none" },
  "brand_fit.geographic_relevance":                  { factKeys: ["hometown", "nationality", "affiliation"], research: "partial" },
  "commercial_proof.verified_commercial_value":      { research: "none", note: "proof channel only" },
  "commercial_proof.deal_frequency":                 { kinds: ["brand_mention"], research: "partial" },
  "commercial_proof.brand_quality":                  { kinds: ["brand_mention"], research: "partial", note: "taxonomy downstream" },
  "commercial_proof.renewals_repeat":                { kinds: ["brand_mention"], research: "partial", note: "dated repeat mentions" },
  "commercial_proof.campaign_performance":           { research: "none" },
  "commercial_proof.pricing_power":                  { factKeys: ["nil_mention"], kinds: ["brand_mention"], research: "partial" },
  "momentum.athletic_trajectory":                    { factKeys: ["achievement", "award", "affiliation"], kinds: ["career_event"], research: "primary" },
  "momentum.audience_growth":                        { research: "none" },
  "momentum.media_trajectory":                       { kinds: ["press_mention"], research: "partial", note: "dated press" },
  "momentum.search_social_trajectory":               { research: "none", note: "signals lane" },
  "momentum.commercial_acceleration":                { kinds: ["brand_mention", "career_event"], factKeys: ["nil_mention"], research: "partial" },
};

export const RESEARCH_INFORMABLE_SUBSIGNALS = Object.entries(RESEARCH_SUBSIGNAL_COVERAGE).filter(([, s]) => s.research !== "none").map(([k]) => k);

/** Sub-signals for which the arm has at least one cited, non-suspect evidence record of a listed key or kind. */
export function coveredSubSignals(evidence: EvidenceRecord[]): string[] {
  const cited = evidence.filter((e) => e.lineage === "cited" && !e.suspect);
  const keys = new Set(cited.map((e) => e.claimedFactKey).filter(Boolean) as string[]);
  const kinds = new Set(cited.map((e) => e.kind));
  return RESEARCH_INFORMABLE_SUBSIGNALS.filter((path) => {
    const s = RESEARCH_SUBSIGNAL_COVERAGE[path];
    return (s.factKeys ?? []).some((k) => keys.has(k)) || (s.kinds ?? []).some((k) => kinds.has(k));
  });
}
