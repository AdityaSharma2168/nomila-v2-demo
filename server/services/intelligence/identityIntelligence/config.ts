/**
 * config.ts — every threshold and word list Identity Intelligence uses, in one place (Concept 0.4, Part B; 0.2).
 *
 * Nothing here names a person, sport, school or heritage. The numbers are starting values to be tuned on the golden
 * set (server/scripts/intelligence/identityGolden.ts), never inferred from one athlete.
 */

/** IDENTITY_INTELLIGENCE_ENABLED — default OFF. Off ⇒ GET /me/story answers `unavailable`. */
export function identityIntelligenceEnabled(): boolean {
  return process.env.IDENTITY_INTELLIGENCE_ENABLED === "true";
}

/**
 * Admissibility policy identity-admissibility/0.2 — the generic tier rules (contract Part B, "Confidence tiers").
 * 0.2: `source_read` (Research v3's targeted read — the page or video WAS read) counts as a retrieved lineage, and the
 * athlete's own verbatim words found by that read (`athlete_statement`) are Reported: her expression as published.
 */
export const IDENTITY_ADMISSIBILITY = {
  /** Source types whose naming of a claim counts towards independent corroboration. */
  reputableSourceTypes: ["official_governing_body", "official_team_or_school", "major_news", "reference", "regional_news"] as readonly string[],
  /** Source types that are Established on their own when the claim is directly supported by a retrieved page. */
  establishedSourceTypes: ["official_governing_body", "official_team_or_school", "major_news", "reference"] as readonly string[],
  /** Lineage that binds the claim to a retrieved page of the cited source. */
  establishedLineages: ["native_supported"] as readonly string[],
  /** Lineage meaning a page of the source WAS retrieved (weaker: the exact page may be unproven). */
  retrievedLineages: ["native_supported", "native_retrieved", "cited", "source_read"] as readonly string[],
  /** Research v3's targeted read. Only this lineage makes an `athlete_statement` her words; search-grounded never does. */
  sourceReadLineage: "source_read",
  /** One retrieved source of these types is Reported. */
  reportedSourceTypes: ["official_governing_body", "official_team_or_school", "major_news", "reference", "regional_news", "athlete_authored_public"] as readonly string[],
  /** N: independent reputable registrable domains naming one claim. */
  minIndependentDomains: 2,
  /** Measurements from these social source classes are Established. */
  establishedSocialSourceClasses: ["connected_verified", "platform_public"] as readonly string[],
  /** Deal statuses that make a deal an earned commercial record. */
  earnedDealStatuses: ["accepted", "completed"] as readonly string[],
};

/** Envelope caps (0.2: contract §3 sections A–I). */
export const IDENTITY_ENVELOPE = {
  /** Characters kept per basis text (facts, evidence). */
  maxTextChars: 280,
  /** Characters kept per HER WORDS item. */
  maxStatementChars: 400,
  /** Unconfirmed claims surfaced as open questions, at most. */
  maxUnresolved: 6,
  /** A. ESTABLISHED / B. REPORTED: the most salient N shown to the model (the rest stay in the claim list). */
  maxEstablished: 40,
  maxReported: 30,
  /** G. MEASURED AUDIENCE: buckets kept per distribution (top geographies, ages, genders). */
  maxAudienceBuckets: 3,
  /** I. PRE-ASSEMBLED and the other rules-composed parts. */
  maxProofPoints: 10,
  maxSignatureMoments: 6,
  maxValuesEvidence: 8,
  maxCauses: 6,
  maxInterests: 8,
  maxAssociations: 8,
  maxAmbitions: 8,
  maxGuardrails: 20,
  maxVoiceThemes: 6,
  maxVoiceTone: 4,
  maxSignatureCues: 6,
};

/**
 * athleteStatements() — HER WORDS, ranked deterministically and capped (contract §3 C: "strongest 3–5 per topic").
 * Statements without topics (captions, bios, what she said to Nomila) are bucketed by medium, so one kind never crowds
 * out the rest.
 */
export const IDENTITY_STATEMENTS = {
  limitPerTopic: 4,
  maxTotal: 24,
  /** Rows scanned per source before ranking. */
  maxCaptionsScanned: 60,
  maxEventsScanned: 40,
  /** Ranking: provenance weight + medium adjustment + recency + length sanity. */
  provenanceWeight: { source_read: 0.5, her_own: 0.4 } as Record<string, number>,
  mediumAdjust: { caption: -0.1, bio: 0.05, conversation: 0.05, form: 0.05 } as Record<string, number>,
  recentDays: 365,
  recentBonus: 0.2,
  olderDays: 1095,
  olderBonus: 0.1,
  minChars: 15,
  maxChars: 600,
  lengthPenalty: 0.3,
};

/** Asserted fields whose `said` is identity expression, mapped to a statement topic. Governance fields never count. */
export const STATEMENT_TOPIC_OF_FIELD: Record<string, string | null> = {
  hometown: "origin", direction: "ambition", goal: "ambition", secondary_goals: "ambition", brands_causes: "values",
  hobbies: "interests", brand_voice: "style", note: null, nickname: null, position: null, sport: null, school: null,
  affiliations: null, career_status: null, class_year: null, brands_wanted: null, never_post: null, cadence: null,
};

/** Rank step (rules): salience annotation of basis items, 0–1. */
export const IDENTITY_SALIENCE = {
  base: 0.3,
  athleteAuthority: 0.2,
  /** The item's claim is supported by more than one basis. */
  convergence: 0.2,
  /** Dated within `recentDays`. */
  recent: 0.1,
  recentDays: 365,
  /** Established items rank above Reported ones. */
  established: 0.1,
  /** State findings (M.I.A. strengths) — salience only, never content. */
  stateFinding: 0.5,
};

/**
 * IDENTITY_SUFFICIENCY — the semantic rule: a statement needs at least one Established item that says who the athlete
 * is as an athlete, and at least one admissible item from a different kind of source. Below it: no generated
 * statement, the learning state, open questions only.
 */
export const IDENTITY_SUFFICIENCY = {
  minAthleticIdentityItems: 1,
  minOtherKindItems: 1,
  /** Fact keys (athlete_facts / mapped evidence) that say who she is as an athlete. */
  athleticFactKeys: ["sport", "affiliation", "national_team_participation"] as readonly string[],
  /** Asserted fields that say who she is as an athlete. */
  athleticAssertedFields: ["sport", "school", "affiliations"] as readonly string[],
};

/** What the rules pre-assemble as proof points and signature moments (contract §1 Credibility / Narrative). */
export const IDENTITY_PROOF = {
  /** Fact keys that are proof points, with the proof kind each one is. */
  proofFactKinds: {
    award: "honour", achievement: "honour", ranking: "honour", national_team_participation: "national_team",
    education: "education", endorsement: "partnership",
  } as Record<string, string>,
  /** An affiliation whose role names one of these is a captaincy proof point. */
  captaincyRoles: ["captain", "co-captain"] as readonly string[],
  /** career_event kinds that are signature moments. */
  signatureEventKinds: ["signature"] as readonly string[],
  /** An honour whose own text contains one of these words is also a "first" (a signature moment). */
  firstWords: ["first", "only", "record", "youngest", "historic", "history-making"] as readonly string[],
  /** Honour-tier labels, not historic "firsts" (matched case-insensitively, whole words). Removed before any "first" check
   *  here and in the validator's superlative rule. */
  tierLabels: ["first team", "first-team", "1st team", "first xi", "first-class", "first-round"] as readonly string[],
  /** Audience features that are proof points (measured reach). */
  audienceProofFeatures: ["followers_latest"] as readonly string[],
};

/** Synthesis call (one constrained call; no tools, no search). */
export const IDENTITY_SYNTHESIS = {
  temperature: 0.2,
  /** The model thinks by default and its thinking counts against this budget: 4096 left no room for the answer (the first
   * real run returned no JSON twice). Same ceiling the M.I.A. evaluator falls back to on this model. */
  maxOutputTokens: 32768,
  /** Repair attempts after a validation failure. The contract allows exactly one. */
  repairAttempts: 1,
};

/**
 * Validation policy (identity-validation/1). The validator checks contracts and hard invariants only — structure,
 * citations, provenance, claim strength, the athlete's authority and the structural governance rules. Whether a
 * statement is supported by what it cites is a question of MEANING, taught by the prompt; no word list polices it.
 */
export const IDENTITY_VALIDATION = {
  /** A sanity ceiling on every synthesised text (catches a runaway answer; not a presentation limit). */
  textCeiling: 400,
};

/**
 * Output length and count TARGETS, written into the prompt. Under identity-validation/1 the validator enforces only the
 * HARD ones (marked): the essence's short form and the pillar label (fixed UI slots) and the counts (data shape);
 * everything else is guidance — a surface truncates at a sentence boundary. `question` is a rules-part limit (compose.ts).
 */
export const IDENTITY_LIMITS = {
  essenceShort: 60,   // HARD
  essenceLong: 140,
  positioningShort: 90,
  positioningLong: 200,
  /** The contract gives ONE limit for standsFor; it applies to both of its forms. */
  standsFor: 90,
  throughlineShort: 90,
  throughlineLong: 200,
  chapter: 120,
  pillarLabelWords: 2,   // HARD
  pillarDefinition: 110,
  maxPillars: 5,   // HARD
  /** "each needs at least two supporting items" — proof ∪ basis. */
  minPillarSupport: 2,
  differentiator: 120,
  maxDifferentiators: 3,   // HARD
  /** values / personality: items ≤ 3 words each, 2–4 of them (fewer when the evidence is thin). */
  traitWords: 3,
  maxValues: 4,   // HARD
  maxPersonality: 4,   // HARD
  mediaFraming: 200,
  imageGap: 200,
  /** Not in the contract. */
  athleticStyle: 160,
  origin: 120,
  motivation: 200,
  community: 80,
  maxCommunities: 4,   // HARD
  question: 120,
};
