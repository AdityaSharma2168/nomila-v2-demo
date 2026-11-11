/**
 * agent/research/schemas.ts — the strict JSON response schemas for the research, merge, understand, onboarding, plan
 * and moments skills (OpenAI Structured Outputs: every object closes additionalProperties and lists every key as required;
 * "optional" is a null). The schema shapes the answer; the skill's markdown is the judgement.
 */
import type { JsonSchema } from "../../../shared/agent";
import { SUBJECT_KINDS, GOAL_DOMAINS, GOAL_HORIZONS, GOAL_REPEATS, IDENTITY_FIELDS, ONBOARDING_CHECKPOINTS } from "../../../shared/agent";
import { CARE_KIND_VALUES, NEVER_REASONS, SENSITIVITIES } from "./privacy";
import { POST_FORMATS } from "../../../shared/postKit";
import { PLAYBOOK_POST_FORMATS } from "../../../shared/playbook";
import { RATE_TYPES } from "../../../shared/deals";
import {
  GOAL_NOTE_SUGGESTIONS, MISSING_UNLOCKS, MOMENT_CATEGORIES, MOMENT_RETIRE_WHYS, PLAN_ACTION_KINDS, PLAN_BUTTONS, PLAN_CONTRACT, PLAN_DELIVERABLE_TYPES, PLAN_STAGE_BANDS,
  VALUE_CONFIDENCES,
} from "../../../shared/plan";

const str = { type: "string" } as const;
const num = { type: "number" } as const;
const bool = { type: "boolean" } as const;
const strArr = { type: "array", items: str } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({
  type: "object", additionalProperties: false, properties, required: Object.keys(properties),
});
const arr = (items: unknown): JsonSchema => ({ type: "array", items });
const nullable = (s: JsonSchema): JsonSchema => ({ anyOf: [s, { type: "null" }] });
/** An array with a maximum length (Structured Outputs supports maxItems); code enforces the same cap. */
const arrMax = (max: number, items: unknown): JsonSchema => ({ type: "array", items, maxItems: max });

export const FACT_TOPICS = [
  "identity", "career", "competition", "achievement", "stats", "team", "education", "sponsor", "business", "media",
  "cause", "social", "upcoming", "context",
  // research 1.7.0 (M.I.A. evidence): role and representation fold into career/team; these are the new evidence kinds.
  "audience_growth", "engagement", "demographics", "search_trend", "conversation", "comparable", "story", "reputation",
  "status", "commerce",
  // research 1.11.0: a dated moment (an upcoming event, fixture, competition or milestone), filed as an event fact. The
  // one moments store (agent/moments): research seeds it, the weekly moments scan refreshes and retires it.
  "moment",
  "other",
] as const;

/** The outlet type of a fact's source (research 1.7.0): judges authority in the merge. */
export const SOURCE_TYPES = ["official", "major_media", "trade", "local", "social", "other"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

const subjectKind = { type: "string", enum: [...SUBJECT_KINDS] };
const sensitivity = { type: "string", enum: [...SENSITIVITIES] };
const neverReason = { type: "string", enum: [...NEVER_REASONS] };
const careKind = { type: "string", enum: [...CARE_KIND_VALUES] };
const topic = { type: "string", enum: [...FACT_TOPICS] };
const sourceType = { type: "string", enum: [...SOURCE_TYPES] };
const identityField = { type: "string", enum: [...IDENTITY_FIELDS, "none"] };

export const RESEARCH_PASS_SCHEMA: JsonSchema = obj({
  identity: obj({ resolved: bool, description: str, ambiguity: str }),
  facts: arrMax(30, obj({
    subject_kind: subjectKind, subject_name: str, claim: str, topic,
    source_url: str, source_title: str, source_type: sourceType, date: str, confidence: num, sensitivity,
    care_kind: careKind, never_reason: neverReason,
  })),
  gaps: strArr,
  narrative: str,
});

export const MERGE_SCHEMA: JsonSchema = obj({
  facts: arrMax(60, obj({
    from: strArr, subject_kind: subjectKind, subject_name: str, claim: str, topic, date: str, confidence: num,
    sensitivity, care_kind: careKind, never_reason: neverReason, conflicts_with: str, duplicate_of: str, note: str,
    // research/merge 1.9.0: the identity field an identity fact about the athlete states ("none" otherwise), and its value.
    field: identityField, field_value: str,
  })),
  dropped: arr(obj({ key: str, reason: str })),
  narrative: str,
});

/**
 * research/merge-compact 1.0.0 (flag RESEARCH_MERGE_COMPACT): the same merged facts, answered by key. Each fact names its
 * pass-fact (and post) keys, its confidence, and a `set` list holding ONLY the fields it changes from the FIRST pass
 * fact named in `from` (empty when it keeps them all) — each entry typed, so an enum field still only takes its enum.
 * Code rebuilds the full MERGE_SCHEMA fact before anything else reads it (research.ts expandCompactMerge), so the
 * stored run and every reader see the same shape as the full merge.
 */
export const MERGE_COMPACT_SET_TEXT_KEYS = ["claim", "subject_name", "date", "conflicts_with", "duplicate_of", "note", "field_value"] as const;
const setEntry = (keys: readonly string[], value: unknown) => obj({ key: { type: "string", enum: [...keys] }, value });
export const MERGE_COMPACT_SCHEMA: JsonSchema = obj({
  facts: arrMax(60, obj({
    from: strArr,
    confidence: num,
    set: arr({ anyOf: [
      setEntry(MERGE_COMPACT_SET_TEXT_KEYS, str),
      setEntry(["subject_kind"], subjectKind),
      setEntry(["topic"], topic),
      setEntry(["sensitivity"], sensitivity),
      setEntry(["care_kind"], careKind),
      setEntry(["never_reason"], neverReason),
      setEntry(["field"], identityField),
    ] }),
  })),
  dropped: arr(obj({ key: str, reason: str })),
  narrative: str,
});

/** understand 1.11.0 adds content_direction (the content style today, and where it should head). */
export const BRIEF_SECTION_KEYS = [
  "brand_now_next", "commercial_readiness", "rate_logic", "context_timing", "content_direction", "risks_upside",
  "could_not_confirm", "refresh_cadence",
] as const;
export type BriefSectionKey = (typeof BRIEF_SECTION_KEYS)[number];

export const STAGE_BANDS = ["early", "developing", "established", "elite", "retired", "unclear"] as const;
export type StageBand = (typeof STAGE_BANDS)[number];

/**
 * understand 1.12.0: the kinds of change that make a carried-forward Brief's thesis, positioning, pillars or narrative
 * worth re-proposing (owner rule, 12 Oct 2026). Rewording alone is never one.
 */
export const MATERIAL_CHANGE_KINDS = ["new_team_or_level", "audience_shift", "new_partner", "injury_or_comeback", "other_material"] as const;
export type MaterialChangeKind = (typeof MATERIAL_CHANGE_KINDS)[number];

export const UNDERSTAND_SCHEMA: JsonSchema = obj({
  stage: obj({ label: str, band: { type: "string", enum: [...STAGE_BANDS] }, confidence: num, why: str, refs: strArr }),
  thesis: obj({ big_idea: str, verdict: str }),
  sections: arr(obj({
    key: { type: "string", enum: [...BRIEF_SECTION_KEYS] },
    title: str,
    lines: arr(obj({ text: str, kind: { type: "string", enum: ["fact", "inference"] }, refs: strArr })),
    so_what: str,
  })),
  positioning: obj({
    from: str, to: str, statement: str,
    pillars: arr(obj({ name: str, line: str, refs: strArr })),
    refs: strArr,
  }),
  // understand 1.11.0: the short context scan is gone (the moments store holds what is coming up), and the content
  // pillars arrive: 2–4 themes the athlete can always post about, each resting on fact keys.
  content_pillars: arrMax(4, obj({ key: str, name: str, why_this_athlete: str, refs: strArr })),
  internal: obj({
    // understand 1.10.0: `since` — the start a fact's claim states (YYYY or YYYY-MM), or null; never inferred.
    current_sponsors: arr(obj({ name: str, refs: strArr, since: nullable(str) })),
    past_sponsors: arr(obj({ name: str, refs: strArr, since: nullable(str) })),
    // understand 1.9.0: exclusivity and category conflicts, each with what it blocks and the fact keys it rests on.
    exclusivity_conflicts: arr(obj({ what: str, blocks: strArr, refs: strArr })),
  }),
  narrative: str,
  // understand 1.13.0: the suggested rate range per kind of work that fits her (shared/deals.ts RATE_TYPES), the numbers
  // behind the rate_logic section. Code re-checks every range (low ≤ high, above zero, a known type, refs) and stores
  // them as her suggested rates (services/rates.ts saveBriefRanges, source "brief").
  rate_ranges: arrMax(RATE_TYPES.length, obj({
    rate_type: { type: "string", enum: [...RATE_TYPES] }, low: num, high: num, currency: str,
    confidence: { type: "string", enum: ["low", "medium", "high"] }, drivers: strArr, refs: strArr,
  })),
  // understand 1.12.0 (the research refresh): with a CURRENT BRIEF in the input, whether the facts MATERIALLY changed
  // what the thesis, positioning, pillars or narrative should say. null when there is no current Brief (a first Brief).
  carry_forward: nullable(obj({
    material_change: bool,
    kinds: arr({ type: "string", enum: [...MATERIAL_CHANGE_KINDS] }),
    reason: str,
    refs: strArr,
  })),
});

/**
 * The plan step (skill plan, contract plan/1): recommended goals, a game plan per goal and this week's actions. Every
 * field is required; "none" is null or []. Code re-checks every cap and reference (agent/plan/validate.ts).
 */
const nullStr = nullable(str);
const nullNum = nullable(num);
const enumOf = (values: readonly string[]) => ({ type: "string", enum: [...values] });
export const PLAN_SCHEMA: JsonSchema = obj({
  contract: { type: "string", enum: [PLAN_CONTRACT] },
  stage_read: obj({ band: enumOf(PLAN_STAGE_BANDS), why: str }),
  recommended_goals: arrMax(3, obj({
    key: str, goal: str, horizon: enumOf(GOAL_HORIZONS), domain: enumOf(GOAL_DOMAINS), why_now: str,
    value: obj({ text: str, low: nullNum, high: nullNum, currency: nullStr, drivers: strArr }),
    value_confidence: enumOf(VALUE_CONFIDENCES), next_decision: str,
    // plan 1.5.0: once, or the one trigger that brings a fresh action each time it happens (a standing suggestion).
    repeats: enumOf(GOAL_REPEATS),
    fact_keys: strArr, similar_to_goal_id: nullStr,
  })),
  game_plans: arr(obj({ goal_ref: str, domain: enumOf(GOAL_DOMAINS), lines: arrMax(2, str), kept_athlete_text: bool })),
  actions: arr(obj({
    goal_ref: str, kind: enumOf(PLAN_ACTION_KINDS), what: str, why: str, due_on: nullStr, event_ref: nullStr,
    button: enumOf(PLAN_BUTTONS),
    deliverable: obj({
      type: enumOf(PLAN_DELIVERABLE_TYPES), title: str, body: str,
      target: nullable(obj({ subject_kind: enumOf(["brand", "organization", "person", "other"]), name: str })),
      platform: nullStr, thread_ref: nullStr, connector: nullStr,
      // plan 1.7.0: a post_brief's caption, tags and shots as their own fields (null / [] for every other type) — the
      // body used to carry all three, and the kit stored the whole brief as the caption.
      caption: nullStr, hashtags: strArr, shots: strArr,
    }),
    fact_keys: strArr,
    // plan 1.3.0, the idea bank: the idea behind a post (null for any other kind), the bank idea it reuses (I-key) or
    // the missed idea it adapts (X-key), and the content pillar an evergreen post serves (P-key).
    post: nullable(obj({ hook: str, format: enumOf(POST_FORMATS), show: str, caption_angle: str, avoid: str, media_needs: str })),
    idea_ref: nullStr, pillar_ref: nullStr,
  })),
  goal_notes: arr(obj({ goal_id: str, suggest: enumOf(GOAL_NOTE_SUGGESTIONS), why: str })),
  missing: arr(obj({ text: str, unlocks: enumOf(MISSING_UNLOCKS), connector: nullStr })),
  // plan 1.3.0: ideas not used this week — skip one not worth doing (I-key), or adapt a missed one to a later event
  // (X-key + E-key, with its new timing).
  idea_moves: arr(obj({ idea_ref: str, move: enumOf(["skip", "adapt"]), event_ref: nullStr, timing: nullStr, why: str })),
  // plan 1.5.0: the week's one number of posts (stories apart), the target it moves toward, and one line of why.
  week: obj({ posts: num, target: nullNum, stories: num, why: str }),
  path_note: str,
});

/**
 * The weekly moments scan (skill moments, agent/moments): every real, dated moment in the window, up to twelve, ranked
 * best first, each with its why-now and ONE angle with a hook (moments 1.2.0: the plan picks format, platform, timing
 * and the shot list), the keys it rests on (F = a fact of the athlete's, D = a deal, M = a moment already in the store)
 * and the M-key it refreshes; and the existing moments to retire. Code re-checks every date, source and key.
 */
export const MOMENTS_SCHEMA: JsonSchema = obj({
  moments: arrMax(12, obj({
    name: str, description: str, date: str, date_precision: enumOf(["day", "month"]), category: enumOf(MOMENT_CATEGORIES),
    why_now: str, source_url: str, source_title: str, confidence: num, based_on: strArr, refreshes: nullStr,
    // moments: the research privacy rule (none | care | never) — never is not stored; care is stored with no post.
    sensitivity, never_reason: neverReason,
    idea: obj({ hook: str, angle: str }),
  })),
  // moments: why a moment on file is retired. passed | cancelled | moved | wrong retire the fact; not_worth_a_post
  // keeps the fact and expires only its candidate post.
  retire: arr(obj({ key: str, why: enumOf(MOMENT_RETIRE_WHYS), reason: str })),
  path_note: str,
});

/**
 * The shared content playbook (skill playbook, agent/playbook): lasting best-practice guidance for ONE
 * (sport, stage, platform) key — formats, hooks, ideal length, default cadence, cross-platform reuse, sources — never
 * a dated item (a trend belongs to the weekly moments scan, not here). Code re-checks every cap and the no-date rule.
 */
export const PLAYBOOK_SCHEMA: JsonSchema = obj({
  formats: arrMax(6, obj({ name: str, post_format: enumOf(PLAYBOOK_POST_FORMATS), when_to_use: str })),
  hooks: arrMax(8, str),
  ideal_length_sec: obj({ min: num, max: num }),
  // playbook 1.2.0: posts a week is a growth target (never stories), with its format mix and a stories range beside it.
  cadence: obj({
    posts_per_week: obj({ min: num, max: num }),
    format_mix: obj({ reel: num, carousel: num, feed: num }),
    stories_per_week: obj({ min: num, max: num }),
  }),
  cross_platform_reuse: arrMax(6, obj({ from: str, to: str, rule: str })),
  sources: arrMax(10, obj({ url: str, title: str })),
  path_note: str,
});

/** The default display order (the model may reorder): the reveal moment, then insights → rate ranges → connect → goals → capabilities. */
export const TURN_CARD_KINDS = ["quick_questions", "reveal", "insights", "rate_ranges", "connect", "goal_proposals", "capabilities", "fact_review", "consent", "age_band"] as const;
export type TurnCardKind = (typeof TURN_CARD_KINDS)[number];

export const ONBOARDING_TURN_SCHEMA: JsonSchema = obj({
  message: str,
  cards: obj({
    quick_questions: arrMax(3, obj({ question: str, options: arrMax(4, str), why: str })),
    reveal: nullable(obj({
      headline: str, highlights: arrMax(5, obj({ text: str, refs: strArr })),
      standing: nullable(obj({ text: str, refs: strArr })), windows: arrMax(4, obj({ text: str, refs: strArr })),
    })),
    // Onboarding 1.9.0: whether to show her suggested rate ranges. The numbers are the Brief's (understand 1.13.0,
    // BriefInternal.rateRanges): code fills the card from them; the model never writes a range here.
    rate_ranges: bool,
    // mia_dimension: the M.I.A. dimension a strength / gap insight comes from (state.mia_preview); null for other angles.
    insights: arr(obj({ angle: { type: "string", enum: ["brand", "strength", "gap", "timing", "opportunity"] }, text: str, refs: strArr, mia_dimension: nullable(str) })),
    fact_review: nullable(obj({ refs: strArr })),
    // Onboarding 1.8.0: goals are the plan run's recommendations (state.recommended_goals); the turn only says whether
    // to show the ones not shown yet. The model never writes a goal here.
    show_recommended_goals: bool,
    connect: arr(obj({ connector_id: str, why: str })),
    capabilities: arr(obj({ capability_id: str, pitch: str })),
    consent: bool,
    age_band: bool,
    order: arr({ type: "string", enum: [...TURN_CARD_KINDS] }),
  }),
  checkpoints_addressed: arr({ type: "string", enum: [...ONBOARDING_CHECKPOINTS] }),
  path_note: str,
});
