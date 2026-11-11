/**
 * research/spec/researchSpecV1.ts — the code mirror of docs/architecture/phase-a/step4-research-spec-v1.md,
 * frozen as `research-spec/1` (12 Sep 2026).
 *
 * Provider-neutral: the system instruction, the nine sections with their requested items, the six queries and
 * the request compiler produce the SAME text for every provider; `compileSystemInstruction` applies the only
 * permitted per-provider difference (the tool's name). Item coverage is derived deterministically from cited
 * claims by the predicates here, next to what the extractor reports. Pure; no provider, no database.
 */

import type { ExtractedClaim } from "../providers";
import { EVIDENCE_KINDS } from "../registries";

/** research-spec/1.1 (Oct 2026): additive identity-source items (athlete_media, signature moments, playing style, leadership,
 *  origin, motivations, interests, associations; creative ventures) in the existing sections and queries — no query added. */
export const RESEARCH_SPEC_VERSION = "research-spec/1.1";
export const CITED_CLAIMS_V3 = "cited-claims/3";

export const SECTION_OUTCOMES = ["found_cited", "not_found", "conflicting", "not_applicable"] as const;
export type SectionOutcome = (typeof SECTION_OUTCOMES)[number];

export const SECTION_IDS = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

/** Evidence kinds of cited-claims/3: the registry's closed list plus the seven benchmark kinds (in-memory only until the substrate adopts them). */
export const EVIDENCE_KINDS_V3 = [...EVIDENCE_KINDS, "career_event", "reputation_event", "social_metric_claim", "representation", "venture", "crossover_appearance", "narrative_claim", "athlete_statement"] as const;
export type EvidenceKindV3 = (typeof EVIDENCE_KINDS_V3)[number];
/** A cited-claims/3 claim: the v2 shape with the widened kind vocabulary. */
export type ExtractedClaimV3 = Omit<ExtractedClaim, "kind"> & { kind: EvidenceKindV3 };
/** Kinds that can never become a fact or a quantitative signal. */
export const EVIDENCE_ONLY_KINDS: readonly EvidenceKindV3[] = ["social_metric_claim", "reputation_event", "narrative_claim", "crossover_appearance", "career_event", "representation", "venture", "athlete_statement"];
export const REPUTATION_STAGES = ["reported_allegation", "official_finding_or_action", "resolution_or_outcome"] as const;
export type ReputationStage = (typeof REPUTATION_STAGES)[number];

/** The evidence record shape the item predicates see (a subset of benchmark EvidenceRecord). */
export interface ClaimView { kind: string; claimedFactKey: string | null; claim: Record<string, unknown>; cited: boolean }

export interface RequestedItem {
  id: string; text: string; /** null ⇒ derived coverage follows the reported outcome only. */ predicate: ((c: ClaimView) => boolean) | null;
  /** The item's evidence is ACCEPTED by the query that asks it (v3AcceptanceDomains) but never makes that query a covering query of
   *  the item's domain (SPEC_V1_DOMAIN_QUERIES): planning and settling stay as they were (e.g. a career-long signature moment asked in Q3). */
  acceptOnly?: true;
}
export interface Section { id: SectionId; name: string; items: RequestedItem[] }

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const has = (c: ClaimView, f: string) => s(c.claim[f]).length > 0 || (typeof c.claim[f] === "number") || c.claim[f] === true;
const key = (c: ClaimView, ...keys: string[]) => c.claimedFactKey != null && keys.includes(c.claimedFactKey);
const kind = (c: ClaimView, ...kinds: string[]) => kinds.includes(c.kind);
const field = (c: ClaimView, f: string, ...vals: string[]) => vals.includes(s(c.claim[f]).toLowerCase());

export const SECTIONS: Section[] = [
  { id: "S1", name: "Identity & disambiguation", items: [
    { id: "full_name", text: "full legal/known name", predicate: (c) => key(c, "name") },
    { id: "aliases", text: "other names, nicknames", predicate: (c) => key(c, "alias") },
    { id: "birth_year", text: "birth year or date (adults); minors: birth year or age band only, no exact date of birth sought", predicate: (c) => key(c, "birth_year") },
    { id: "nationality", text: "nationality", predicate: (c) => key(c, "nationality") },
    { id: "hometown", text: "hometown (city/region; never a home or street address)", predicate: (c) => key(c, "hometown") },
    { id: "sport_discipline", text: "sport and discipline/event", predicate: (c) => key(c, "sport", "event") },
    { id: "namesakes", text: "other people with this name seen in sources and how they were told apart", predicate: (c) => kind(c, "identity_signal") && field(c, "topic", "namesake") },
  ] },
  { id: "S2", name: "Biography & affiliations", items: [
    { id: "current_affiliation", text: "current team/club/school/organization", predicate: (c) => key(c, "affiliation") && !field(c, "timeframe", "past") },
    { id: "league_level_division", text: "league, level, division, conference of the current affiliation", predicate: (c) => key(c, "affiliation") && (has(c, "league") || has(c, "division") || has(c, "levelDescription") || s((c.claim.value as any)?.conference).length > 0 || s((c.claim.value as any)?.level).length > 0) },
    { id: "market", text: "city/country of the current affiliation", predicate: (c) => key(c, "affiliation") && has(c, "market") },
    { id: "past_affiliations", text: "past teams with years", predicate: (c) => key(c, "affiliation") && field(c, "timeframe", "past") },
    { id: "position_role", text: "position, role (starter, captain)", predicate: (c) => key(c, "position") },
    { id: "education_class_year", text: "class year, degree, graduation year", predicate: (c) => key(c, "class_year", "graduation_year") },
    { id: "national_team_programme", text: "national team programme and age group", predicate: (c) => key(c, "national_team_participation") },
  ] },
  { id: "S3", name: "Career status & recent trajectory", items: [
    { id: "current_status", text: "active / injured or out this season / between teams / retired, with date", predicate: (c) => key(c, "career_status") },
    { id: "transfers_signings", text: "transfers, signings, promotions in the last 12 months", predicate: (c) => kind(c, "career_event") && field(c, "eventKind", "transfer", "signing", "promotion") },
    { id: "injuries", text: "injuries, recoveries in the last 12 months", predicate: (c) => kind(c, "career_event") && field(c, "eventKind", "injury", "recovery") },
    { id: "milestones_selections", text: "milestones, major selections in the last 12 months", predicate: (c) => kind(c, "career_event") && field(c, "eventKind", "milestone", "selection") },
    { id: "retirement_comeback", text: "retirement or comeback announcements", predicate: (c) => kind(c, "career_event") && field(c, "eventKind", "retirement", "comeback") },
  ] },
  { id: "S4", name: "Performance & honors", items: [
    { id: "results_titles", text: "results, titles", predicate: (c) => key(c, "achievement") && (field(c, "category", "result", "title") || !has(c, "category")) },
    { id: "records", text: "records set", predicate: (c) => key(c, "achievement") && field(c, "category", "record") },
    { id: "season_statistics", text: "season statistics", predicate: (c) => key(c, "achievement") && field(c, "category", "statistic") },
    { id: "rankings", text: "rankings by named bodies", predicate: (c) => key(c, "ranking") },
    { id: "awards_selections", text: "awards, all-conference/all-league/all-star selections", predicate: (c) => key(c, "award") && !field(c, "category", "academic") },
    { id: "international_results", text: "national-team caps and international results", predicate: (c) => key(c, "national_team_participation") || (key(c, "achievement") && s((c.claim.value as any)?.level).toLowerCase() === "international") },
    { id: "academic_honors", text: "academic honors", predicate: (c) => key(c, "award") && field(c, "category", "academic") },
  ] },
  { id: "S5", name: "Media coverage & cultural footprint", items: [
    { id: "national_coverage", text: "national/international coverage (outlet, headline, date)", predicate: (c) => kind(c, "press_mention") && field(c, "outletContext", "national", "international") },
    { id: "regional_coverage", text: "regional/local coverage", predicate: (c) => kind(c, "press_mention") && field(c, "outletContext", "regional", "local") },
    { id: "sport_specific_coverage", text: "sport-specific outlets", predicate: (c) => kind(c, "press_mention") && field(c, "outletContext", "sport_specific") },
    { id: "mainstream_coverage", text: "mainstream/non-sport outlets", predicate: (c) => kind(c, "press_mention") && field(c, "outletContext", "mainstream") },
    { id: "viral_moments", text: "documented viral moments", predicate: (c) => kind(c, "press_mention") && field(c, "topic", "viral_moment") },
    { id: "appearances_outside_sport", text: "television, entertainment, podcasts, books, documentaries, advertising as talent", predicate: (c) => kind(c, "crossover_appearance") },
    { id: "social_conversation", text: "trending/meme/social conversation as reported by sources", predicate: (c) => kind(c, "press_mention") && field(c, "topic", "social_conversation") },
    { id: "athlete_media", text: "media in which the athlete is the subject or takes part: video interviews and features, written interviews, long-form profiles, podcasts, press conferences, team/league/federation features, media profiles, brand-produced features (outlet, outlet type, title, date, URL, medium, participation)", predicate: (c) => (kind(c, "press_mention") && field(c, "topic", "athlete_media")) || (kind(c, "crossover_appearance") && has(c, "participation")) },
  ] },
  { id: "S6", name: "Narrative & public identity", items: [
    { id: "storylines", text: "reported storylines (origin, adversity, comeback, firsts)", predicate: (c) => kind(c, "narrative_claim") && field(c, "topic", "storyline") },
    { id: "values_causes", text: "stated values, causes, advocacy", predicate: (c) => kind(c, "narrative_claim") && field(c, "topic", "values_causes") },
    { id: "foundations_positions", text: "foundations, public positions", predicate: (c) => kind(c, "narrative_claim") && field(c, "topic", "foundation_position") },
    { id: "brand_themes", text: "recurring personal-brand themes as described by sources", predicate: (c) => kind(c, "narrative_claim") && field(c, "topic", "brand_theme") },
    { id: "signature_moments", text: "signature moments across the whole career (defining performances, goals, games, wins, firsts), with date", predicate: (c) => kind(c, "career_event") && field(c, "eventKind", "signature"), acceptOnly: true },
    { id: "playing_style", text: "playing or competing style as coaches, scouts and press describe it", predicate: (c) => kind(c, "narrative_claim") && field(c, "topic", "playing_style") },
    { id: "leadership_mentality", text: "leadership and mentality as coaches, teammates and press describe them", predicate: (c) => kind(c, "narrative_claim") && field(c, "topic", "leadership") },
    { id: "origin_background", text: "origin and background (where and how the athlete started, family or community background as publicly reported)", predicate: (c) => kind(c, "narrative_claim") && field(c, "topic", "origin") },
    { id: "motivations", text: "motivations the athlete or sources state (why they compete, who they do it for)", predicate: (c) => kind(c, "narrative_claim") && field(c, "topic", "motivation") },
    { id: "interests", text: "interests outside the sport (hobbies, study, music, fashion, causes they follow)", predicate: (c) => kind(c, "narrative_claim") && field(c, "topic", "interests") },
    { id: "associations", text: "recurring public and media associations (people, shows, communities, causes or brands the athlete is repeatedly linked with in coverage)", predicate: (c) => kind(c, "narrative_claim") && field(c, "topic", "association") },
  ] },
  { id: "S7", name: "Commercial relationships", items: [
    { id: "partnerships_deals", text: "brand partnerships, endorsements, NIL deals, collaborations", predicate: (c) => kind(c, "brand_mention") },
    { id: "deal_categories", text: "category of each brand/deal", predicate: (c) => kind(c, "brand_mention") && has(c, "category") },
    { id: "deal_dates", text: "start, end dates", predicate: (c) => kind(c, "brand_mention") && (has(c, "startDate") || has(c, "endDate")) },
    { id: "renewals_repeat", text: "renewals, repeat partnerships", predicate: (c) => kind(c, "brand_mention") && c.claim.renewal === true },
    { id: "campaigns", text: "campaign names", predicate: (c) => kind(c, "brand_mention") && has(c, "campaign") },
    { id: "published_values", text: "published deal values", predicate: (c) => kind(c, "brand_mention") && has(c, "publishedValue") },
    { id: "representation", text: "agency, agent", predicate: (c) => kind(c, "representation") },
    { id: "ventures", text: "own businesses, product lines, equity deals, creative ventures and projects", predicate: (c) => kind(c, "venture") },
    { id: "third_party_valuations", text: "valuations (On3 and similar) as estimates with the estimator named", predicate: (c) => key(c, "nil_mention") },
  ] },
  { id: "S8", name: "Public & social presence", items: [
    { id: "official_accounts", text: "official accounts per platform (handle)", predicate: (c) => kind(c, "social_handle") && !field(c, "platform", "website") },
    { id: "verification_status", text: "verified status where visible", predicate: (c) => kind(c, "social_handle") && typeof c.claim.verified === "boolean" },
    { id: "official_website", text: "official website", predicate: (c) => kind(c, "social_handle") && field(c, "platform", "website") },
    { id: "follower_counts_as_stated", text: "follower/subscriber counts exactly as a source stated them, with source and date", predicate: (c) => kind(c, "social_metric_claim") },
    { id: "content_formats", text: "notable content formats, series", predicate: null },
    { id: "authenticity_concerns", text: "documented audience-authenticity concerns", predicate: null },
  ] },
  { id: "S9", name: "Reputation & brand safety", items: [
    { id: "reported_allegations", text: "reported allegations or claims (source, date)", predicate: (c) => kind(c, "reputation_event") && field(c, "stage", "reported_allegation") },
    { id: "official_findings_actions", text: "official findings or actions: suspensions, sanctions, charges, rulings (source, date)", predicate: (c) => kind(c, "reputation_event") && field(c, "stage", "official_finding_or_action") },
    { id: "resolutions_outcomes", text: "resolutions or outcomes: cleared, upheld, settled, served (source, date)", predicate: (c) => kind(c, "reputation_event") && field(c, "stage", "resolution_or_outcome") },
  ] },
];

export const sectionById = (id: SectionId): Section => SECTIONS.find((x) => x.id === id)!;

/** Sections asked for an athlete. Since the 13 Sep 2026 correction the SAME nine sections are asked for a minor (S9 narrowly framed); minor status is data minimization, not a reduced research model. */
export function sectionsFor(_isMinor: boolean): Section[] { return [...SECTIONS]; }

/** Kind (+ claimed fact key) → section. Null for kinds outside the spec (signals). */
export function sectionOf(kindName: string, claimedFactKey: string | null): SectionId | null {
  if (claimedFactKey) {
    if (["name", "alias", "birth_year", "nationality", "hometown", "sport", "event"].includes(claimedFactKey)) return "S1";
    if (["affiliation", "position", "class_year", "graduation_year", "national_team_participation"].includes(claimedFactKey)) return "S2";
    if (claimedFactKey === "career_status") return "S3";
    if (["achievement", "award", "ranking"].includes(claimedFactKey)) return "S4";
    if (["nil_mention", "representation"].includes(claimedFactKey)) return "S7";
  }
  switch (kindName) {
    case "identity_signal": return "S1";
    case "profile_attribute": return "S1";
    case "affiliation": return "S2";
    case "career_event": return "S3";
    case "achievement": return "S4";
    case "press_mention": case "media_asset": case "crossover_appearance": return "S5";
    case "narrative_claim": case "sentiment": case "athlete_statement": return "S6";
    case "brand_mention": case "nil_mention": case "representation": case "venture": return "S7";
    case "social_handle": case "social_metric_claim": return "S8";
    case "reputation_event": return "S9";
    default: return null;
  }
}

/** Legacy research domain for the seven new kinds (the substrate's KIND_DOMAIN covers the rest). */
export const NEW_KIND_DOMAIN: Record<string, "profile" | "press" | "social_handles" | "brand_mentions" | "narrative"> = {
  career_event: "profile", reputation_event: "press", social_metric_claim: "social_handles", representation: "brand_mentions", venture: "brand_mentions", crossover_appearance: "press", narrative_claim: "narrative",
  athlete_statement: "narrative",
};

// ── outcomes ──────────────────────────────────────────────────────────────────

export interface ReportedSectionOutcome { status: SectionOutcome; items: Record<string, SectionOutcome>; reviewedChunkIds: string[]; conflicts: Array<{ item: string; values: Array<{ value: string; chunkIds: string[] }> }>; reason: string | null }

/** Deterministic section status from item outcomes (§2.3). */
export function deriveSectionStatus(items: Record<string, SectionOutcome>): SectionOutcome {
  const v = Object.values(items);
  if (!v.length) return "not_found";
  if (v.includes("conflicting")) return "conflicting";
  if (v.includes("found_cited")) return "found_cited";
  if (v.every((x) => x === "not_applicable")) return "not_applicable";
  return "not_found";
}

export interface ItemCoverage { item: string; reported: SectionOutcome | null; derived: "found_cited" | "not_found" | null; agree: boolean | null }
export interface SectionCoverage { section: SectionId; reportedStatus: SectionOutcome | null; derivedStatus: SectionOutcome; items: ItemCoverage[]; found: number; requested: number; coverage: number }

/** Item coverage: derived from cited claims by the predicates, alongside what the extractor reported. */
export function sectionCoverage(section: Section, claims: ClaimView[], reported: ReportedSectionOutcome | undefined): SectionCoverage {
  const cited = claims.filter((c) => c.cited);
  const items: ItemCoverage[] = section.items.map((it) => {
    const rep = reported?.items?.[it.id] ?? null;
    const derived: ItemCoverage["derived"] = it.predicate ? (cited.some(it.predicate) ? "found_cited" : "not_found") : null;
    const agree = rep == null || derived == null ? null : (rep === "found_cited") === (derived === "found_cited");
    return { item: it.id, reported: rep, derived, agree };
  });
  // Found = derived found where a predicate exists; else the reported outcome.
  const found = items.filter((i) => (i.derived ?? i.reported) === "found_cited").length;
  const effective: Record<string, SectionOutcome> = {};
  for (const i of items) effective[i.item] = i.derived === "found_cited" ? "found_cited" : (i.reported && i.reported !== "found_cited" ? i.reported : (i.derived ?? i.reported ?? "not_found"));
  return { section: section.id, reportedStatus: reported?.status ?? null, derivedStatus: deriveSectionStatus(effective), items, found, requested: section.items.length, coverage: Math.round((found / section.items.length) * 1000) / 1000 };
}

// ── the frozen instructions (§5) ──────────────────────────────────────────────

export const SYSTEM_INSTRUCTION =
  "You are a sports research analyst collecting verified, sourced evidence about ONE athlete for an athlete profile. " +
  "Always use web search to find current information; never answer from memory. The athlete is identified by the identity anchor in the request. " +
  "If sources may describe a different person with the same name, keep them apart, say so, and do not merge them; if you cannot confidently match the anchor, report that the identity could not be resolved. " +
  "Attribute every statement to a specific source with its URL and, when visible, its publication date. Report only what sources state. Do not estimate, extrapolate, or fill gaps; a third-party estimate must be labelled as an estimate from the named source. " +
  "Describe, do not rate: do not assign quality tiers, scores, rankings of importance, strength or safety judgements to sources, outlets, brands, stories or the athlete — report the observable facts (who, what, where, when, which outlet, which brand, which category) and leave any classification to the reader. " +
  "For every evidence category and every listed item you are asked about, end with exactly one status: FOUND (with cited evidence), NOT FOUND (you searched and found nothing reliable), CONFLICTING (credible sources disagree — report each position with its source), or NOT APPLICABLE (the item does not apply to this athlete — give the reason). " +
  "Omitting a category or an item is not allowed; saying NOT FOUND is always acceptable.";

/** The only permitted per-provider difference: the name of the search tool. */
export function compileSystemInstruction(provider: "gemini" | "openai" | string): string {
  return provider === "gemini" ? SYSTEM_INSTRUCTION.replace("Always use web search", "Always use Google Search") : SYSTEM_INSTRUCTION;
}

export const MINOR_REQUEST_LINE =
  "This athlete is a minor. Collect the same publicly sourced athletic, team, performance, media, narrative, commercial and social information as for any athlete, with data minimization: do not seek or report a home or street address, personal phone number, personal e-mail, private family or contact details, or an exact date of birth (a birth year or age band from a reliable public source is sufficient); report no rumors or unsourced allegations.";

export const QUERY_IDS = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"] as const;
export type QueryId = (typeof QUERY_IDS)[number];
export interface QueryDef { id: QueryId; name: string; sections: SectionId[]; text: (isMinor: boolean) => string }

const Q1_ADULT = `1. Identity — items: full name; other names or nicknames; birth year or date; nationality; hometown; sport and
   discipline; other people with this name that appear in sources and how they differ from the anchor.
2. Biography and affiliations — items: current team, club, school or organization; its league, level, division
   and conference; its city/country; past teams with years; position and role (starter, captain); class year,
   degree or graduation year; national team programme and age group.`;
/** Minor (corrected 13 Sep 2026): same items as an adult, minimized — birth year or age band rather than an exact date of birth; hometown at city/region level, never a home or street address. */
const Q1_MINOR = `1. Identity — items: full name; other names or nicknames; birth year or age band (not an exact date of birth);
   nationality; hometown (city or region, never a home or street address); sport and discipline; other people
   with this name that appear in sources and how they differ from the anchor.
2. Biography and affiliations — items: current team, club, school or organization; its league, level, division
   and conference; its city/country; past teams with years; position and role (starter, captain); class year,
   degree or graduation year; national team programme and age group.`;
const Q2 = `3. Performance and honors — items: results and titles; records; season statistics; rankings by named ranking
   bodies; awards and all-conference / all-league / all-star selections; national-team caps and international
   results (Olympics, world championships); academic honors. Give the season or year and the competition level
   as the source states it for each finding.`;
const Q3 = `4. Media coverage — items: national/international outlets; regional/local outlets; sport-specific outlets;
   mainstream/non-sport outlets. For each finding give outlet, headline and date; describe the outlet type, do
   not rate it.
5. Cultural footprint — items: documented viral moments; appearances outside sport (television, entertainment,
   podcasts, books, documentaries, advertising as talent); social conversation (trending, memes) as reported by
   sources; media in which the athlete is the subject or takes part — video interviews and features (for example
   on YouTube), written interviews, long-form profiles, podcasts, press conferences, team, league or federation
   features, media profiles and brand-produced features. For each media item give the outlet, the kind of outlet,
   the title, the date, the direct URL of the page or video, the medium, and whether the athlete is interviewed,
   speaks or writes in their own words, is profiled, or is only mentioned.
6. Narrative and public identity — items: storylines reported about the athlete (origin, adversity, comeback,
   firsts); stated values, causes, advocacy; foundations and public positions; recurring personal-brand themes
   as sources describe them; signature moments across the whole career; playing or competing style, and
   leadership and mentality, as coaches, scouts, teammates and press describe them; origin and background;
   motivations; interests outside the sport; recurring public and media associations. Quote the source; do not
   write a biography or judge the story's strength.`;
const Q4 = `7. Commercial relationships — items: brand partnerships, endorsements, NIL deals, collaborations and ambassador
   roles (brand and deal type); the category of each brand; start and end dates; renewals or repeat
   partnerships; campaign names; published deal values; representation (agency, agent); own businesses, product
   lines, equity deals, creative ventures or projects; third-party valuations (for example On3) reported separately as estimates naming the
   estimator — they are not deals. Do not rate brands.`;
const Q5 = `8. Public and social presence — items: official accounts per platform (handle); whether each is verified, where
   visible; official website; follower or subscriber counts exactly as stated by a source, with the source and
   the date of the statement; notable content formats or series; documented concerns about audience
   authenticity.`;
const Q6_STATUS = `9. Career status and recent developments — items: current status (active, injured or out this season, between
   teams, retired) with date and source; transfers, signings or promotions in the last 12 months; injuries or
   recoveries in the last 12 months; milestones or major selections in the last 12 months; retirement or
   comeback announcements. Give a date for each event.`;
const Q6_REPUTATION = `10. Reputation — items, kept strictly apart: reported allegations or claims; official findings or actions
    (suspensions, sanctions, charges, rulings); resolutions or outcomes (cleared, upheld, settled, served). For
    each give the source and date and say which of the three it is. A reported allegation is not a finding.
    NOT FOUND is an expected result; do not speculate, do not report allegations without a source, and do not
    give any safety or risk judgement.`;
/** Minor: S9 still runs, narrowly framed around documented, materially relevant public matters; no rumors, no unsourced allegations, no speculation. */
const Q6_REPUTATION_MINOR = `10. Reputation — for this minor athlete report only documented, materially relevant public matters: official
    eligibility rulings; suspensions; governing-body findings; doping findings; disciplinary actions; documented
    legal outcomes; significant, well-sourced public-conduct incidents. Keep strictly apart: reported allegations
    or claims; official findings or actions; resolutions or outcomes — each with source and date, saying which of
    the three it is. A reported allegation is not a finding. NOT FOUND is the expected result; report no rumors,
    no unsourced allegations, no speculative material, and no safety or risk judgement.`;

export const QUERIES: QueryDef[] = [
  { id: "Q1", name: "Identity + Biography + Affiliations", sections: ["S1", "S2"], text: (isMinor) => (isMinor ? Q1_MINOR : Q1_ADULT) },
  { id: "Q2", name: "Performance + Honors", sections: ["S4"], text: () => Q2 },
  { id: "Q3", name: "Media Coverage + Cultural Footprint + Narrative", sections: ["S5", "S6"], text: () => Q3 },
  { id: "Q4", name: "Commercial + Brand + Representation", sections: ["S7"], text: () => Q4 },
  { id: "Q5", name: "Public + Social Presence", sections: ["S8"], text: () => Q5 },
  { id: "Q6", name: "Recent Developments + Reputation", sections: ["S3", "S9"], text: (isMinor) => `${Q6_STATUS}\n${isMinor ? Q6_REPUTATION_MINOR : Q6_REPUTATION}` },
];

export interface RequestSubject { fullName: string; sport: string; anchor: string; isMinor: boolean }

/** The request text for one query — byte-for-byte identical for every provider (§5.2). */
export function compileRequest(subject: RequestSubject, query: QueryDef, asOf: string): string {
  const head = [`Athlete identity anchor: ${subject.anchor}`, `Athlete: ${subject.fullName} — ${subject.sport}`, `As-of date: ${asOf}`, subject.isMinor ? MINOR_REQUEST_LINE : null].filter(Boolean).join("\n");
  return `${head}\n\n${query.text(subject.isMinor)}\n\nFor each numbered category, list dated, sourced findings for each listed item, then give the status of each\nitem and of the category (FOUND / NOT FOUND / CONFLICTING / NOT APPLICABLE).`;
}

/** Words the spec must never send to a provider (§4.3); tested. */
export const FORBIDDEN_IN_REQUESTS = [/\bM\.?I\.?A\.?\b/, /\btarget score\b/i, /\bdimension\b/i, /\bweight/i, /\bcohort\b/i, /\bholdout\b/i, /\btier\s*\d/i, /\bcalibration\b/i];
