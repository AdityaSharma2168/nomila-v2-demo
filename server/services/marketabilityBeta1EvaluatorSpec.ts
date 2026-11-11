/**
 * marketabilityBeta1EvaluatorSpec.ts — the FROZEN M.I.A. Beta.1 evaluator specification.
 *
 * This is methodology, and it lives in production code because the production evaluator service sends exactly this text.
 * Calibration and analysis tooling under server/scripts/ imports FROM here; the dependency never runs the other way.
 *
 * The evaluator receives ONLY athlete name + sport + this specification (plus an authoritative social block where one is
 * available). No Nomila data, scores, targets, cohort ranks, calibration labels or other-provider outputs ever enter the
 * prompt. BLIND_EVAL_SPEC is the founder's v0.1 text verbatim; BLIND_EVAL_SPEC_V02_ADDITIONS carries the evidence-based
 * confidence rubric, the eight dimension assessments, overall confidence, the authoritative social block and the v0.2.1
 * clarification permitting evaluated social judgements from public evidence.
 *
 * FROZEN (14 Sep 2026, validated on the 37-athlete development cohort: Spearman 0.889, median absolute error 52).
 * Any edit to the delivered text — including the output instruction and the no-authoritative-data fallback — changes
 * Beta.1 methodology and MUST bump BLIND_EVAL_SPEC_V02_VERSION. CANONICAL_EVALUATOR_TEXT below is digest-pinned to make
 * that impossible to do by accident; see marketabilityBeta1EvaluatorSpec.test.ts.
 */

export const BLIND_EVAL_SPEC_VERSION = "blind-eval-spec/0.1";

export interface BlindEvalAthlete { key: string; name: string; sport: string }
export const BLIND_EVAL_ATHLETES: readonly BlindEvalAthlete[] = [
  { key: "cristiano-ronaldo", name: "Cristiano Ronaldo", sport: "Soccer" },
  { key: "caitlin-clark", name: "Caitlin Clark", sport: "Basketball" },
  { key: "ilona-maher", name: "Ilona Maher", sport: "Rugby" },
  { key: "ben-shelton", name: "Ben Shelton", sport: "Tennis" },
  { key: "bethany-hamilton", name: "Bethany Hamilton", sport: "Surfing" },
  { key: "mia-bhuta", name: "Mia Bhuta", sport: "Soccer" },
  { key: "zippy-fish", name: "Zippy Fish", sport: "Australian Rules Football" },
  { key: "riya-mehta", name: "Riya Mehta", sport: "Gymnastics" },
];

export const BLIND_EVAL_SPEC = `NOMILA M.I.A. — BLIND ATHLETE MARKETABILITY EVALUATION SPEC v0.1

ROLE

You are evaluating the commercial marketability of an athlete.

You must first research the athlete using public sources, build a coherent evidence-grounded understanding of the athlete, and then assess 44 marketability sub-signals.

You are NOT predicting athletic talent alone.
You are NOT estimating future earnings directly.
You are evaluating current athlete marketability as a combination of:

- athletic authority
- audience scale
- engagement quality
- cultural relevance
- narrative power
- brand fit
- commercial proof
- momentum

IMPORTANT

Do not optimize toward any expected final score.
You have not been given a target score.
Do not assume famous athlete = maximum marketability.
Do not assume elite athlete = high marketability.
Do not assume smaller audience = low overall marketability.
Do not fill missing quantitative social data with invented numbers.

RESEARCH PROCESS

Before scoring, research enough to understand:

1. identity and current career status
2. team / league / competition level
3. major recent and historical athletic achievements
4. national/international representation
5. role and importance within sport/team
6. public audience and social presence
7. media coverage and cultural footprint
8. distinctive personal story and public identity
9. brand relationships and endorsements
10. evidence of commercial demand or repeat partnerships
11. recent trajectory and momentum
12. major reputation or brand-safety issues

Prefer, in order:

1. connected or first-party platform data if explicitly available
2. official athlete/team/league/federation/platform sources
3. high-quality major media
4. reputable secondary sources
5. other public web evidence

Do not treat search-result counts as real-world frequency.

Do not infer private commercial values unless explicitly published.

If identity is uncertain, say so and reduce confidence.

ATHLETE INTELLIGENCE SUMMARY

First produce a concise 150–250 word marketability summary covering:

- current athletic standing
- audience/social position
- cultural relevance
- distinctive narrative
- brand/commercial position
- recent momentum
- major missing information or uncertainty

The summary must be descriptive, not a score justification written backward from an expected result.

SCORING SCALE

Every sub-signal is scored 0–100.

Interpret the scale consistently:

0–19   = very weak / essentially absent
20–39  = weak
40–59  = moderate / ordinary
60–74  = strong
75–89  = very strong
90–100 = exceptional / category-leading

Use the full range.

A score of 50 is NOT a default for missing data.

If there is insufficient evidence, return:
status = "missing"
score = null

Do not fabricate a neutral score.

CONFIDENCE

For each scored sub-signal return confidence as:
HIGH / MEDIUM / LOW

Base confidence on:
- identity certainty
- source quality
- evidence sufficiency
- evidence consistency
- freshness

Do not output artificial probabilities such as 97%.

For each signal cite the most relevant evidence IDs.

==================================================
1. ATHLETIC AUTHORITY
==================================================

competition_level — 25%
How prestigious and competitive is the athlete's current/relevant sporting environment?

100 = world/Olympic/top global professional level
80–90 = major professional / elite international
60–79 = high-level college / national / strong professional tier
40–59 = regional / developmental / ordinary college
20–39 = lower competitive level
0–19 = little meaningful competitive standing

performance_results — 25%
Quality of actual competitive performance, emphasizing recent relevant results.

100 = dominant/world-leading results
80–90 = elite major results
60–79 = strong high-level results
40–59 = respectable but not distinguished
20–39 = limited high-level success
0–19 = little performance evidence

rankings_recognition — 15%
Formal rankings, major awards, honors and recognized standing.

national_international_status — 15%
National team, international representation, Olympic/world-level recognition.

role_importance — 10%
Captaincy, starter/key-player status, centrality to team or sport.

achievement_recency — 10%
How current and commercially relevant the athlete's meaningful achievements are.

==================================================
2. AUDIENCE SCALE
==================================================

cross_platform_effective_reach — 50%
Real public audience scale across meaningful platforms.

Use authoritative/publicly observable metrics where available.
Do not invent reach from fame.

sport_level_audience_percentile — 25%
How large the athlete's audience appears relative to comparable athletes in the same sport/level/stage.

audience_growth — 15%
Evidence of recent audience expansion.
If no reliable longitudinal evidence exists, mark missing.

platform_breadth — 10%
Meaningful presence across multiple platforms, not simply account existence.

==================================================
3. ENGAGEMENT QUALITY
==================================================

engagement_percentile — 30%
Quality of audience interaction relative to audience size.

reach_efficiency — 25%
Ability of content to reach meaningfully beyond or within follower base.

shares_saves_quality — 15%
Evidence of high-value interactions such as shares/saves.

video_retention — 10%
Evidence of strong video completion/retention.

story_efficiency — 10%
Story reach/interaction effectiveness.

audience_authenticity — 10%
Evidence that audience quality is genuine and commercially useful.

IMPORTANT:
If reliable platform metrics are unavailable, do not infer detailed engagement metrics from general popularity.
Mark missing where appropriate.

==================================================
4. CULTURAL RELEVANCE
==================================================

media_volume_percentile — 30%
Breadth and persistence of meaningful media attention.

Do NOT count returned search results mechanically.
Judge the observed cultural/media footprint.

media_source_quality — 20%
Quality/prestige of outlets covering the athlete.

search_interest — 20%
Evidence of broader public curiosity or search demand.

social_conversation — 15%
Evidence that the athlete generates public conversation beyond their own posting.

crossover_recognition — 15%
Recognition outside the athlete's immediate sport.

==================================================
5. NARRATIVE POWER
==================================================

distinctiveness — 25%
How differentiated and memorable the athlete's story/identity is.

100 = exceptionally distinctive, instantly articulable story
75–89 = clearly differentiated story
60–74 = meaningful differentiation
40–59 = some story elements but relatively common
20–39 = weak differentiation
0–19 = no meaningful narrative distinction

story_depth — 20%
How much substance and dimensionality exists behind the story.

evidence_authenticity — 20%
How genuinely supported the narrative is by real life, behavior, history and credible evidence.

media_resonance — 15%
Whether media/public coverage actually responds to and amplifies the narrative.

commercial_applicability — 10%
How naturally the story can support brand campaigns without feeling forced.

durability — 10%
Whether the narrative can remain relevant beyond a short-lived event.

==================================================
6. BRAND FIT
==================================================

category_breadth — 25%
Breadth of credible brand categories the athlete could naturally represent.

brand_safety — 20%
Suitability for mainstream brand partnerships.

Do not penalize based only on unverified allegations.
Consider confirmed serious issues, official findings, repeated controversy, or clear brand risk.

audience_attractiveness — 20%
Commercial attractiveness of the athlete's likely audience.

identity_values_coherence — 15%
Clarity and consistency of the athlete's identity, values and public persona.

content_versatility — 10%
Ability to support multiple kinds of brand/content campaigns.

geographic_relevance — 10%
Commercial usefulness of the athlete's geographic audience/relevance.

==================================================
7. COMMERCIAL PROOF
==================================================

verified_commercial_value — 30%
Evidence of actual meaningful commercial value.

Only score strongly when there is credible evidence of meaningful paid commercial activity.
Do not infer dollar value from fame alone.

deal_frequency — 20%
Evidence of repeated brand/commercial demand.

Do not use number of search results as deal frequency.

brand_quality — 15%
Prestige and strategic quality of confirmed brand partners.

renewals_repeat — 15%
Evidence brands renew, repeat or deepen relationships.

campaign_performance — 10%
Evidence campaigns actually performed well.

pricing_power — 10%
Evidence that the athlete commands premium economics.

If commercial economics/performance are not publicly supported, mark missing.

==================================================
8. MOMENTUM
==================================================

athletic_trajectory — 30%
Direction of sporting performance/visibility.

audience_growth — 25%
Actual recent audience growth if reliable evidence exists.

media_trajectory — 20%
Whether media visibility is clearly accelerating, stable or declining.

search_social_trajectory — 15%
Whether public attention/search/social interest is clearly rising.

commercial_acceleration — 10%
Whether brand/commercial activity is visibly accelerating.

==================================================
EVIDENCE RULES

For every score:

- cite 1–5 evidence IDs
- include a one-sentence rationale
- distinguish fact from interpretation
- do not cite evidence that does not actually support the signal
- do not reuse one fact across many signals unless it genuinely supports each one
- do not fabricate social analytics
- do not treat missing evidence as negative evidence

Create evidence IDs E1, E2, E3...

For each evidence item store:

{
  "id": "E1",
  "claim": "...",
  "source_title": "...",
  "source_url": "...",
  "source_type": "official | platform | major_media | secondary",
  "published_or_observed_date": "...",
  "retrieved_at": "...",
  "notes": "..."
}

OUTPUT

Return structured JSON:

{
  "athlete": {
    "name": "",
    "sport": "",
    "identity_confidence": "HIGH|MEDIUM|LOW"
  },

  "marketability_summary": "",

  "evidence": [...],

  "dimensions": {
    "athletic_authority": {
      "competition_level": {
        "status": "scored|missing",
        "score": 0-100|null,
        "confidence": "HIGH|MEDIUM|LOW",
        "evidence_ids": [],
        "rationale": ""
      },
      ...
    }
  },

  "key_strengths": [],
  "key_constraints": [],
  "important_missing_data": [],
  "identity_or_evidence_risks": []
}

DO NOT:
- calculate a final MIA score
- calculate dimension weighted totals
- infer missing quantitative metrics
- compare against a target athlete
- attempt to match an expected ranking`;

/** The only per-athlete text. Identical shape for every provider. */
export function blindEvalPrompt(a: BlindEvalAthlete): string {
  return `${BLIND_EVAL_SPEC}\n\nATHLETE TO EVALUATE\n\nName: ${a.name}\nSport: ${a.sport}\n\nResearch this athlete now, then return the JSON exactly as specified (all eight dimensions, all 44 sub-signals, each either scored or missing). Return the JSON as one \`\`\`json fenced block.`;
}

/**
 * v0.2 ADDITIONS (founder, 14 Sep 2026). The v0.1 rubric text above is unchanged and is sent verbatim; these paragraphs are
 * appended after it. They add outputs (dimension prose + confidence, overall confidence), the evidence-based confidence
 * rubric, and one optional input (an authoritative social-data block). Nothing else changes.
 */
export const BLIND_EVAL_SPEC_V02_VERSION = "blind-eval-spec/0.2.1";
export const BLIND_EVAL_SPEC_V02_ADDITIONS = `==================================================
ADDITIONS (v0.2) — the rubric above is unchanged; the following add outputs and one optional input
==================================================

CONFIDENCE RUBRIC (evidence-based)

Confidence measures confidence in the accuracy of the signal assessment, not confidence that cited facts exist. A highly subjective signal can still be HIGH confidence when evidence strongly supports the assessment. A numerical metric should be LOW or MISSING when the underlying metric is unavailable, even if the athlete is famous. Do not turn these labels into percentages.

HIGH
- Athlete identity is clear.
- Evidence directly supports the judgment.
- Evidence is authoritative and/or well corroborated.
- Evidence is sufficiently current for this signal.
- There is enough information that materially better public research would be unlikely to change the assessment substantially.

MEDIUM
- Identity is reasonably clear.
- Evidence supports the general judgment but is incomplete, indirect, older, or only partially corroborated.
- Better data could meaningfully move the score.

LOW
- Identity or applicability is uncertain, evidence is sparse/indirect, or important information is unavailable.
- The score is necessarily tentative and could change substantially with better information.

MISSING
- There isn't enough evidence to make the judgment responsibly.

Apply this rubric to every sub-signal confidence, to each dimension confidence, and to the overall confidence.

DIMENSION ASSESSMENTS

For each of the 8 dimensions, after assessing its sub-signals, write a 2–4 sentence prose interpretation: what the evidence says about this dimension, in plain language an athlete could read, descriptive rather than a justification of a number. Then give the dimension a confidence of HIGH, MEDIUM or LOW under the rubric above, with a one-sentence evidence-based reason. Do not compute a dimension score or any weighted total.

OVERALL CONFIDENCE

Give an overall confidence of HIGH, MEDIUM or LOW for the marketability assessment as a whole, with a 2–3 sentence explanation that names what better information would change most. Do not compute a final MIA score.

AUTHORITATIVE SOCIAL DATA (optional input)

When a block titled AUTHORITATIVE SOCIAL DATA is supplied with the athlete, its metrics are measured facts from the platform (a connected account or platform discovery), each with its observation date and the basis and confidence of the account identity resolution. Treat them as authoritative: use them for the audience and engagement sub-signals they cover, do not contradict or replace them with web estimates, and cite them as evidence items with source_type "platform". Metrics NOT in the block remain subject to the rules above: credible researched public evidence (for example publicly reported follower counts) may inform an evaluated Audience Scale judgment at a confidence appropriate to that evidence, but never invent unavailable metrics (Story performance, retention, saves/shares, private reach, demographics). If the block states that a platform is not available, do not guess it. A connected account is never itself a score bonus; it only changes what is known.

EVALUATED SOCIAL JUDGMENTS FROM PUBLIC EVIDENCE (v0.2.1 clarification)

Audience and engagement sub-signals may be scored as evaluated judgments from credible public evidence you retrieve yourself (publicly visible likes, comments and views on posts, reported follower or subscriber counts, documented reach of specific content), at a confidence appropriate to that evidence, typically MEDIUM or LOW. Do not mark such a signal missing merely because it is social or because a private metric would be more precise. Only signals that require private data (Story performance, saves and shares rates, private reach, retention, audience demographics) remain MISSING when no authoritative data is supplied.

OUTPUT ADDITIONS

Add these fields to the JSON, alongside everything already specified:

  "dimension_assessments": {
    "athletic_authority": { "prose": "2–4 sentences", "confidence": "HIGH|MEDIUM|LOW", "confidence_reason": "one sentence" },
    ... one entry for each of the 8 dimensions ...
  },
  "overall_confidence": { "level": "HIGH|MEDIUM|LOW", "explanation": "2–3 sentences" }`;

/**
 * The block sent when no platform data resolved. Exported with its text unchanged so the memory adapter
 * (services/miaPreview/memoryAdapter.ts) states exactly the same thing ahead of its public-facts section.
 */
export const NO_AUTHORITATIVE_SOCIAL_DATA = "AUTHORITATIVE SOCIAL DATA\n\nNo authoritative platform data is available for this athlete. Instagram, YouTube, TikTok and X: not available.";

/** v0.2 prompt: the v0.1 spec verbatim + the v0.2 additions + (optional) the authoritative social block + the athlete line. */
export function blindEvalPromptV02(a: BlindEvalAthlete, socialBlock: string | null): string {
  const social = socialBlock && socialBlock.trim() ? `\n\n${socialBlock.trim()}` : `\n\n${NO_AUTHORITATIVE_SOCIAL_DATA}`;
  return `${BLIND_EVAL_SPEC}\n\n${BLIND_EVAL_SPEC_V02_ADDITIONS}\n\nATHLETE TO EVALUATE\n\nName: ${a.name}\nSport: ${a.sport}${social}\n\nResearch this athlete now, then return the JSON exactly as specified (all eight dimensions, all 44 sub-signals each scored or missing, the dimension assessments and the overall confidence). Return the JSON as one \`\`\`json fenced block.`;
}


/**
 * The exact evaluator text that DEFINES Beta.1: the real prompt with only the per-athlete values substituted out.
 * Built by the same function the runner calls, so there is one code path and no parallel definition to drift. It covers
 * the spec, the v0.2 additions, the v0.2.1 clarification, the no-authoritative-data fallback and the required-output
 * instruction; it excludes only name, sport and a supplied social block (evidence, guarded by the artifact digests).
 */
export const CANONICAL_EVALUATOR_TEXT = blindEvalPromptV02({ key: "canonical", name: "<ATHLETE>", sport: "<SPORT>" }, null);

/**
 * SHA-256 of CANONICAL_EVALUATOR_TEXT, computed BEFORE this module was moved out of server/scripts/calibration/blindEval/
 * so the relocation had to prove itself byte-preserving.
 *
 * If a test fails on this constant, the evaluator text changed. Do NOT paste in the new digest: that silently redefines
 * frozen methodology. Review the prompt diff and either restore the Beta.1 text, or deliberately bump the evaluator
 * version and regenerate the freeze metadata (goldens included).
 */
export const BLIND_EVAL_SPEC_V02_CANONICAL_SHA256 = "167e6c50cfa4cfbe41bd1707db1ddcd3c914051c6675e7301dac53fd4e63d609";
