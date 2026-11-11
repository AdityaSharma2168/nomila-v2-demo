/**
 * research/spec/itemMapping.ts — `item-mapping/1`: deterministic mapping from direct-evidence/2 findings (research-spec/1
 * items) to Nomila evidence claims and registry candidates (design §2–§4, PR #448).
 *
 * The provider never chose a key; this table does. Every finding becomes exactly one or more evidence claims (kind +
 * value) that the existing derivation (claim-canonicalization/1 → strict registry → resolver) consumes unchanged:
 *   - mapped   — the item has an approved registry key and the value fields map 1:1 (a years[] array splits into N dated claims);
 *   - partial  — mapped, but fields the registry has no home for are carried in the claim beside `value` (kept as evidence);
 *   - unmapped — no approved registry key yet (commercial relationships until `endorsement` exists, statistics, narrative,
 *                media, presence, reputation): stored as evidence only, never a registry candidate.
 * No inference, no defaults that add meaning, no LLM. `career_status` is never mapped from a provider finding; it is
 * derived by `deriveCareerStatus` — in this slice only `retired`, from explicit cited retirement language. Scoring boundary: only `mapped`/`partial`
 * claims with an approved key can ever become facts; everything else is evidence for context and generation.
 */

import { normalizeText } from "../factRegistry";
import type { DirectClaim } from "./directEvidenceV1";
import type { Finding } from "./directEvidenceV2";
import type { EvidenceKindV3 } from "./researchSpecV1";

export const ITEM_MAPPING_VERSION = "item-mapping/5";   // /2: registry v2 keys (endorsement, season_statistic), alias defaults/splits, explicit-language career status; /3: graduation_year mapped (D7); /4: registry v3 — education, national-team year from one explicit year, captaincy annotation (Concept 0.4 B1); /5: identity-source items (athlete_media, signature moments, style / leadership / origin / motivation / interests / association topics)
export type RegistryStatus = "mapped" | "partial" | "unmapped";
/** Evidence kind for findings that have no registry key (kept in research_evidence as sourced evidence). */
export const RESEARCH_FINDING_KIND = "research_finding" as const;
export type MappedKind = EvidenceKindV3 | typeof RESEARCH_FINDING_KIND;

export interface MappedClaim extends Omit<DirectClaim, "kind"> { kind: MappedKind; item: string; registryStatus: RegistryStatus; mappingVersion: string; unmappedFields: string[] }

const s = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined);
const yearOf = (v: unknown): number | undefined => { const m = /^(\d{4})/.exec(String(v ?? "")); return m ? Number(m[1]) : undefined; };
const bool = (v: unknown): boolean | undefined => (v === true || v === "true" ? true : v === false || v === "false" ? false : undefined);
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));

interface Mapping {
  kind: MappedKind;
  /** /5: the kind chosen from the finding's own value (athlete_media: a podcast is a crossover appearance). Defaults to `kind`. */
  kindOf?: (v: Record<string, unknown>) => MappedKind; factKey?: string; value?: (v: Record<string, unknown>, f: Finding) => Record<string, unknown> | Record<string, unknown>[]; extra?: (v: Record<string, unknown>) => Record<string, unknown>; fields: string[];
  /** Further registry keys the SAME finding states (e.g. a class-year finding that also gives the graduation year). Each yields its own
   *  claim with the finding's provenance, only when its value is usable; the item falls back to evidence only when no key is usable. */
  also?: Array<Required<Pick<Mapping, "factKey" | "value">> & Pick<Mapping, "extra">>;
}

const ORG_KIND: Record<string, string> = { school: "school", club: "club", pro: "pro", national: "national", olympic: "olympic" };
const affiliation = (timeframe: "current" | "past"): Mapping => ({
  kind: "affiliation", factKey: "affiliation", fields: ["organization", "organization_type", "league", "level", "conference", "city", "country", "from", "to", "role"],
  value: (v) => clean({ org: s(v.organization), orgKind: ORG_KIND[String(v.organization_type ?? "").toLowerCase()], level: s(v.level), conference: s(v.conference), role: s(v.role), from: s(v.from), to: s(v.to), season: timeframe === "current" && !v.from ? yearOf(v.as_of) : undefined }),
  extra: (v) => clean({ timeframe, league: s(v.league), market: [s(v.city), s(v.country)].filter(Boolean).join(", ") || undefined }),
});
/** One dated claim per year when the provider returned several years in one finding (deterministic split, no meaning added). */
const perYear = (v: Record<string, unknown>, build: (year: number | undefined) => Record<string, unknown>): Record<string, unknown>[] => {
  const years = Array.isArray(v.years) ? v.years.map(yearOf).filter((y): y is number => !!y) : [];
  if (years.length) return years.map((y) => build(y));
  return [build(yearOf(v.year))];
};
const level = (v: Record<string, unknown>) => s(v.scope);   // only when the source stated it; never inferred

/** Marker on an `education` claim with no institution of its own: persist may bind it to a current school affiliation the finding names. */
export const INSTITUTION_REF = "current_school_affiliation" as const;

/** Explicit four-digit years in a text, excluding a birth / class-of / graduation year ("born 2007", "class of 2026"). */
const YEAR_IN_TEXT = /(?<!\d)(19\d{2}|20\d{2})(?!\d)/g;
const NOT_PARTICIPATION_YEAR = /\b(?:born|birth|class of|graduat\w*)\W+(?:in\W+)?$/i;
function explicitYears(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(YEAR_IN_TEXT)) if (!NOT_PARTICIPATION_YEAR.test(text.slice(Math.max(0, m.index! - 24), m.index))) out.add(Number(m[1]));
  return [...out];
}

/**
 * /4: the participation year of a national-team finding. The item's own `year` first; else exactly ONE explicit year
 * written in the finding's other value fields (team / event / competition — the dated tournament); else exactly one in
 * its statement. Two different years, or none, leave it missing and the registry refuses. Never the publication or as-of date.
 */
export function participationYear(v: Record<string, unknown>, statement: string | null): number | undefined {
  const own = yearOf(v.year);
  if (own) return own;
  const fromValue = explicitYears(Object.entries(v).filter(([k, x]) => k !== "as_of" && typeof x === "string").map(([, x]) => x as string).join(" | "));
  if (fromValue.length) return fromValue.length === 1 ? fromValue[0] : undefined;
  const fromStatement = explicitYears(statement ?? "");
  return fromStatement.length === 1 ? fromStatement[0] : undefined;
}

// ── /4: captaincy and affiliation binding (pure; persist applies them because only it knows the source type and current facts) ──

export interface Captaincy { role: string; roleSince?: string; roleSeason?: number }
const CAPTAIN = /\b(co[- ]?captain|vice[- ]captain|captain)s?\b/i;
/** Former, removed, hedged or negated captaincy is not a current role. */
const NOT_A_CAPTAINCY = /\b(former|formerly|ex-captain|stripped|steps? down|stepped down|removed|relinquish\w*|no longer|not|never|could|might|expected to|set to|candidate|rumou?r\w*|consider\w*|possib\w*)\b/i;

/** Generic captaincy language in a milestone event ("Named team captain", "co-captain for 2026"). The role is the matched word; no team is read here. */
export function captaincyOf(event: string | undefined, date: string | undefined): Captaincy | null {
  const t = event ?? "";
  const m = CAPTAIN.exec(t);
  if (!m || NOT_A_CAPTAINCY.test(t)) return null;
  const role = m[1].toLowerCase().replace(/\s+/, "-").replace(/^co(?=captain)/, "co-");
  const years = explicitYears(t);
  return clean({ role, roleSince: date && /^\d{4}(-\d{2}){0,2}$/.test(date) ? date : undefined, roleSeason: years.length === 1 ? years[0] : undefined }) as unknown as Captaincy;
}

/** Org-type words that do not distinguish one organisation from another (never a team, school, league or place name). */
const GENERIC_ORG_WORDS = new Set(["the", "of", "at", "and", "university", "college", "school", "high", "academy", "institute", "club", "team", "athletics", "athletic", "fc", "sc", "cf", "afc", "women", "womens", "men", "mens", "national", "varsity", "sports"]);
const distinctiveWords = (org: string) => normalizeText(org).split(" ").filter((w) => w.length > 1 && !GENERIC_ORG_WORDS.has(w));

/** A current affiliation and the source domains that established it (its fact provenance, or the bound chunk of a same-run claim). */
export interface CurrentAffiliation { id: string; value: { org: string; orgKind: string } & Record<string, unknown>; domains?: string[] }
const oneOf = (as: CurrentAffiliation[]): CurrentAffiliation | null => {
  const distinct = new Map(as.map((a) => [`${normalizeText(a.value.org)}|${a.value.orgKind}`, a] as const));
  return distinct.size === 1 ? [...distinct.values()][0] : null;
};
/**
 * The ONE current affiliation a piece of evidence is about:
 *   1. domain first — the evidence comes from a domain that established exactly one current affiliation (its own team/school
 *      site), so no name is needed ("Named team captain" on the school's site);
 *   2. else name — at least one distinctive (non-generic) word of the org name appears in the text, so a dropped nickname
 *      ("Riverton" for "Riverton Hawks") still matches.
 * None, or several distinct affiliations at the deciding step → null (ambiguity never maps).
 */
export function affiliationNamedIn(text: string, current: CurrentAffiliation[], orgKinds?: readonly string[], sourceDomain?: string | null): CurrentAffiliation | null {
  const eligible = current.filter((a) => !orgKinds || orgKinds.includes(a.value.orgKind));
  const byDomain = sourceDomain ? eligible.filter((a) => (a.domains ?? []).includes(sourceDomain)) : [];
  if (byDomain.length) return oneOf(byDomain);
  const words = new Set(normalizeText(text).split(" "));
  return oneOf(eligible.filter((a) => distinctiveWords(a.value.org).some((w) => words.has(w))));
}

/** Source types whose captaincy statement may set an affiliation role (tier 1–2: the governing body or the team/school itself). */
export const ROLE_SOURCE_TYPES: readonly string[] = ["official_governing_body", "official_team_or_school"];

/**
 * A `captaincy` annotation becomes the role of a CURRENT affiliation fact only when the finding's lineage is
 * `native_supported`, its source is an official team/school or governing-body source, and the evidence is about exactly one
 * current affiliation (its source domain established it, else the event names it — `affiliationNamedIn`). The result is that affiliation's value plus the role — the resolver then establishes it (tier ≤ 2)
 * over the same-org row. Anything else returns null and the event stays evidence only.
 */
export function captaincyAffiliation(claim: Record<string, unknown>, lineage: string, sourceType: string, current: CurrentAffiliation[], sourceDomain?: string | null): { factId: string; org: string; value: Record<string, unknown> } | null {
  const cap = claim.captaincy as Captaincy | undefined;
  if (!cap || typeof cap.role !== "string") return null;
  if (lineage !== "native_supported" || !ROLE_SOURCE_TYPES.includes(sourceType)) return null;
  const aff = affiliationNamedIn(String(claim.event ?? ""), current, undefined, sourceDomain);
  if (!aff) return null;
  const { primary: _primary, ...rest } = aff.value;
  return { factId: aff.id, org: aff.value.org, value: clean({ ...rest, role: cap.role, roleSince: cap.roleSince, roleSeason: cap.roleSeason }) };
}

/** /5 athlete_media vocabularies (generic). An unknown medium is `other`; an unknown participation is left out (never guessed). */
const MEDIUMS = new Set(["video", "article", "podcast", "press_conference", "profile", "other"]);
const PARTICIPATION = new Set(["interview", "own_words", "profile", "mention"]);
const lc = (v: unknown) => s(v)?.toLowerCase().replace(/[\s-]+/g, "_");
export const mediaMedium = (v: unknown): string | undefined => { const m = lc(v); return m ? (MEDIUMS.has(m) ? m : "other") : undefined; };
export const mediaParticipation = (v: unknown): string | undefined => { const p = lc(v); return p && PARTICIPATION.has(p) ? p : undefined; };
/**
 * athlete_media → evidence. A quote the provider saw through search grounding is NEVER stored as the athlete's words: only the
 * fact that the source quotes the athlete is kept (`athleteQuoted`), which raises that source's priority for the targeted read.
 */
const athleteMedia = (v: Record<string, unknown>) => clean({
  topic: "athlete_media", outlet: s(v.outlet), outletType: lc(v.outlet_type), title: s(v.title), headline: s(v.title), date: s(v.date), url: s(v.url),
  medium: mediaMedium(v.medium), participation: mediaParticipation(v.participation), athleteQuoted: s(v.athlete_quote) ? true : undefined,
});
const narrative = (topic: string, by?: string) => (v: Record<string, unknown>) => clean({ topic, text: s(v.text), ...(by ? { [by === "described_by" ? "describedBy" : "associatedWith"]: s(v[by]) } : {}) });

export const ITEM_MAPPINGS: Record<string, Mapping> = {
  // S1
  full_name: { kind: "profile_attribute", factKey: "name", fields: ["full", "first", "last"], value: (v) => clean({ full: s(v.full), first: s(v.first), last: s(v.last) }) },
  // /2: a bundled `aliases[]` splits into one claim per alias; the kind defaults to `nickname` ONLY because the item itself is `aliases` (design §4)
  aliases: { kind: "profile_attribute", factKey: "alias", fields: ["text", "type", "aliases"], value: (v) => {
    const list: unknown[] = Array.isArray(v.aliases) ? v.aliases : Array.isArray(v.text) ? v.text : [v];
    return list.map((a) => { const o = a && typeof a === "object" ? (a as Record<string, unknown>) : { text: a }; const t = s(o.type); return clean({ text: s(o.text), kind: t === "handle" ? "handle_name" : (t ?? "nickname") }); });
  } },
  birth_year: { kind: "profile_attribute", factKey: "birth_year", fields: ["year", "date"], value: (v) => clean({ year: yearOf(v.year ?? v.date) }) },
  nationality: { kind: "profile_attribute", factKey: "nationality", fields: ["country"], value: (v) => clean({ country: s(v.country) }) },
  hometown: { kind: "profile_attribute", factKey: "hometown", fields: ["city", "region", "country"], value: (v) => clean({ city: s(v.city), region: s(v.region), country: s(v.country) }) },
  sport_discipline: { kind: "profile_attribute", factKey: "sport", fields: ["sport", "discipline"], value: (v) => clean({ sport: s(v.sport), discipline: s(v.discipline) }) },
  namesakes: { kind: "identity_signal", fields: ["description"], extra: (v) => clean({ topic: "namesake", text: s(v.description) }) },
  // S2
  current_affiliation: affiliation("current"),
  past_affiliations: affiliation("past"),
  league_level_division: { kind: RESEARCH_FINDING_KIND, fields: ["league", "level", "conference"] },
  market: { kind: RESEARCH_FINDING_KIND, fields: ["city", "country"] },
  position_role: { kind: "profile_attribute", factKey: "position", fields: ["position", "role"], value: (v) => clean({ text: s(v.position) }), extra: (v) => clean({ role: s(v.role) }) },
  // D7 (#709): the graduation year is its own registry key (`graduation_year`), no longer only an `extra` beside class_year
  // class_year keeps its own rule: `season` only from the item's explicit season field (never the as-of year or a label guess).
  // /4: the stated degree also becomes an `education` claim. Its institution is the item's own or, failing that, bound by
  // persist to the athlete's current school affiliation ONLY when this finding names it (`institutionRef`); otherwise refused.
  education_class_year: { kind: "profile_attribute", factKey: "class_year", fields: ["class_year_label", "season", "graduation_year", "degree", "institution"], value: (v) => (s(v.class_year_label) ? clean({ label: s(v.class_year_label), season: yearOf(v.season) }) : {}), extra: (v) => clean({ degree: s(v.degree) }),
    also: [
      { factKey: "graduation_year", value: (v) => clean({ year: yearOf(v.graduation_year) }) },
      { factKey: "education", value: (v) => (s(v.degree) ? clean({ institution: s(v.institution), degree: s(v.degree) }) : {}), extra: (v) => (s(v.institution) ? {} : { institutionRef: INSTITUTION_REF }) },
    ] },
  national_team_programme: { kind: "affiliation", factKey: "national_team_participation", fields: ["team", "age_group", "year", "role", "event"], value: (v, f) => clean({ team: s(v.team), level: s(v.age_group), year: participationYear(v, f.statement), role: s(v.role), event: s(v.event) }) },
  // S3 (career_status is DERIVED, never mapped from the provider)
  transfers_signings: { kind: "career_event", fields: ["event", "organization", "date"], extra: (v) => clean({ eventKind: "transfer", event: s(v.event), organization: s(v.organization), date: s(v.date) }) },
  injuries: { kind: "career_event", fields: ["event", "date", "status"], extra: (v) => clean({ eventKind: "injury", event: s(v.event), date: s(v.date), status: s(v.status) }) },
  // /4: a captaincy named in the event is annotated (`captaincy`); persist alone decides whether it becomes the role of a current affiliation
  milestones_selections: { kind: "career_event", fields: ["event", "date"], extra: (v) => clean({ eventKind: "milestone", event: s(v.event), date: s(v.date), captaincy: captaincyOf(s(v.event), s(v.date)) ?? undefined }) },
  retirement_comeback: { kind: "career_event", fields: ["event", "date"], extra: (v) => { const r = classifyRetirementLanguage(String(v.event ?? "")); return clean({ eventKind: r === "ambiguous" ? "retirement_comeback" : r, event: s(v.event), date: s(v.date) }); } },
  // S4
  results_titles: { kind: "achievement", factKey: "achievement", fields: ["name", "year", "date", "competition", "organization", "scope"], value: (v) => perYear(v, (y) => clean({ name: s(v.name), year: y, date: s(v.date), level: level(v), org: s(v.organization) })), extra: (v) => clean({ category: "result", competition: s(v.competition) }) },
  records: { kind: "achievement", factKey: "achievement", fields: ["name", "year", "scope", "value"], value: (v) => perYear(v, (y) => clean({ name: s(v.name), year: y, level: level(v) })), extra: (v) => clean({ category: "record", recordValue: s(v.value) }) },
  season_statistics: { kind: "achievement", factKey: "season_statistic", fields: ["season", "competition", "metric", "value"], value: (v) => clean({ metric: s(v.metric), value: s(v.value), season: yearOf(v.season), competition: s(v.competition) }) },
  rankings: { kind: "achievement", factKey: "ranking", fields: ["body", "rank", "year", "scope"], value: (v) => clean({ body: s(v.body), rank: typeof v.rank === "number" ? v.rank : Number(String(v.rank ?? "").replace(/[^0-9]/g, "")) || undefined, year: yearOf(v.year), scope: s(v.scope) }) },
  awards_selections: { kind: "achievement", factKey: "award", fields: ["name", "year", "awarded_by", "scope"], value: (v) => perYear(v, (y) => clean({ name: s(v.name), year: y, org: s(v.awarded_by), level: level(v) })), extra: () => ({ category: "athletic" }) },
  international_results: { kind: "achievement", factKey: "national_team_participation", fields: ["team", "competition", "year", "result"], value: (v, f) => clean({ team: s(v.team), level: s(v.competition), year: participationYear(v, f.statement) }), extra: (v) => clean({ result: s(v.result) }) },
  academic_honors: { kind: "achievement", factKey: "award", fields: ["name", "year", "awarded_by"], value: (v) => perYear(v, (y) => clean({ name: s(v.name), year: y, org: s(v.awarded_by), level: "school" })), extra: () => ({ category: "academic" }) },
  // S5 — evidence only
  national_coverage: { kind: "press_mention", fields: ["outlet", "headline", "date"], extra: (v) => clean({ outlet: s(v.outlet), headline: s(v.headline), outletContext: "national", topic: "coverage" }) },
  regional_coverage: { kind: "press_mention", fields: ["outlet", "headline", "date"], extra: (v) => clean({ outlet: s(v.outlet), headline: s(v.headline), outletContext: "regional", topic: "coverage" }) },
  sport_specific_coverage: { kind: "press_mention", fields: ["outlet", "headline", "date"], extra: (v) => clean({ outlet: s(v.outlet), headline: s(v.headline), outletContext: "sport_specific", topic: "coverage" }) },
  mainstream_coverage: { kind: "press_mention", fields: ["outlet", "headline", "date"], extra: (v) => clean({ outlet: s(v.outlet), headline: s(v.headline), outletContext: "mainstream", topic: "coverage" }) },
  viral_moments: { kind: "press_mention", fields: ["description", "date", "platform"], extra: (v) => clean({ headline: s(v.description), topic: "viral_moment", platform: s(v.platform) }) },
  appearances_outside_sport: { kind: "crossover_appearance", fields: ["title", "medium", "date"], extra: (v) => clean({ title: s(v.title), medium: s(v.medium), date: s(v.date) }) },
  social_conversation: { kind: "press_mention", fields: ["description", "date", "platform"], extra: (v) => clean({ headline: s(v.description), topic: "social_conversation", platform: s(v.platform) }) },
  athlete_media: { kind: "press_mention", kindOf: (v) => (mediaMedium(v.medium) === "podcast" ? "crossover_appearance" : "press_mention"), fields: ["title", "outlet", "outlet_type", "date", "url", "medium", "participation", "athlete_quote"], extra: athleteMedia },
  // S6 — evidence only
  storylines: { kind: "narrative_claim", fields: ["text", "theme"], extra: (v) => clean({ topic: "storyline", text: s(v.text), theme: s(v.theme) }) },
  values_causes: { kind: "narrative_claim", fields: ["text", "organization"], extra: (v) => clean({ topic: "values_causes", text: s(v.text), organization: s(v.organization) }) },
  foundations_positions: { kind: "narrative_claim", fields: ["text", "organization"], extra: (v) => clean({ topic: "foundation_position", text: s(v.text), organization: s(v.organization) }) },
  brand_themes: { kind: "narrative_claim", fields: ["text"], extra: (v) => clean({ topic: "brand_theme", text: s(v.text) }) },
  signature_moments: { kind: "career_event", fields: ["event", "date", "competition"], extra: (v) => clean({ eventKind: "signature", event: s(v.event), date: s(v.date), competition: s(v.competition) }) },
  playing_style: { kind: "narrative_claim", fields: ["text", "described_by"], extra: narrative("playing_style", "described_by") },
  leadership_mentality: { kind: "narrative_claim", fields: ["text", "described_by"], extra: narrative("leadership", "described_by") },
  origin_background: { kind: "narrative_claim", fields: ["text"], extra: narrative("origin") },
  motivations: { kind: "narrative_claim", fields: ["text"], extra: narrative("motivation") },
  interests: { kind: "narrative_claim", fields: ["text"], extra: narrative("interests") },
  associations: { kind: "narrative_claim", fields: ["text", "associated_with"], extra: narrative("association", "associated_with") },
  // S7 — commercial relationships → registry v2 `endorsement` (never commercial proof, never nil_mention); valuations → nil_mention
  partnerships_deals: { kind: "brand_mention", factKey: "endorsement", fields: ["brand", "deal_type", "category", "start", "end", "renewal", "campaign", "published_value", "currency"], value: (v) => clean({ brand: s(v.brand), dealType: s(v.deal_type), category: s(v.category), startDate: s(v.start), endDate: s(v.end), campaign: s(v.campaign) }), extra: (v) => clean({ brand: s(v.brand), type: s(v.deal_type), renewal: bool(v.renewal), publishedValue: s(v.published_value), currency: s(v.currency) }) },
  deal_categories: { kind: RESEARCH_FINDING_KIND, fields: ["brand", "category"] },
  deal_dates: { kind: RESEARCH_FINDING_KIND, fields: ["brand", "start", "end"] },
  renewals_repeat: { kind: RESEARCH_FINDING_KIND, fields: ["brand", "renewed", "date"] },
  campaigns: { kind: RESEARCH_FINDING_KIND, fields: ["brand", "campaign", "date"] },
  published_values: { kind: RESEARCH_FINDING_KIND, fields: ["brand", "value", "currency"] },
  representation: { kind: "representation", fields: ["agency", "agent", "since"], extra: (v) => clean({ agency: s(v.agency), agent: s(v.agent), since: s(v.since) }) },
  ventures: { kind: "venture", fields: ["name", "venture_type", "since"], extra: (v) => clean({ name: s(v.name), ventureKind: s(v.venture_type), since: s(v.since) }) },
  third_party_valuations: { kind: "nil_mention", factKey: "nil_mention", fields: ["estimator", "value", "currency", "year", "basis"], value: (v) => clean({ source: s(v.estimator), value: [s(v.currency), s(v.value)].filter(Boolean).join(" ") || undefined, year: yearOf(v.year) }), extra: (v) => clean({ basis: s(v.basis) }) },
  // S8 — evidence only; follower counts are never a fact or a signal
  official_accounts: { kind: "social_handle", fields: ["platform", "handle", "url"], extra: (v) => clean({ platform: s(v.platform), handle: s(v.handle), url: s(v.url) }) },
  verification_status: { kind: "social_handle", fields: ["platform", "verified"], extra: (v) => clean({ platform: s(v.platform), verified: bool(v.verified) }) },
  official_website: { kind: "social_handle", fields: ["url"], extra: (v) => clean({ platform: "website", handle: s(v.url), url: s(v.url) }) },
  follower_counts_as_stated: { kind: "social_metric_claim", fields: ["platform", "metric", "value", "stated_on", "stated_by"], extra: (v) => clean({ platform: s(v.platform), metric: s(v.metric), metricValue: s(v.value), statedOn: s(v.stated_on), statedBy: s(v.stated_by) }) },
  content_formats: { kind: RESEARCH_FINDING_KIND, fields: ["description", "platform"] },
  authenticity_concerns: { kind: RESEARCH_FINDING_KIND, fields: ["description", "date"] },
  // S9 — staged reputation evidence; never a fact
  reported_allegations: { kind: "reputation_event", fields: ["event", "date", "reported_by"], extra: (v) => clean({ stage: "reported_allegation", event: s(v.event), date: s(v.date), reportedBy: s(v.reported_by) }) },
  official_findings_actions: { kind: "reputation_event", fields: ["event", "body", "date", "outcome"], extra: (v) => clean({ stage: "official_finding_or_action", event: s(v.event), body: s(v.body), date: s(v.date), outcome: s(v.outcome) }) },
  resolutions_outcomes: { kind: "reputation_event", fields: ["event", "date", "outcome"], extra: (v) => clean({ stage: "resolution_or_outcome", event: s(v.event), date: s(v.date), outcome: s(v.outcome) }) },
};

/** Map one finding to one or more claims. Deterministic; unknown items become research_finding evidence. */
export function mapFinding(f: Finding): MappedClaim[] {
  const m = ITEM_MAPPINGS[f.item];
  const base = { section: f.section, item: f.item, statement: f.statement, sources: f.sources, lineage: f.lineage, citation: f.lineage.boundChunkIds.length || f.sources[0]?.quote ? { chunkIds: f.lineage.boundChunkIds, quote: (f.sources[0]?.quote ?? "").slice(0, 300) } : null, confidence: undefined as number | undefined, publishedAt: f.sources.find((x) => x.publishedAt)?.publishedAt ?? null, mappingVersion: ITEM_MAPPING_VERSION };
  if (!m) return [{ ...base, kind: RESEARCH_FINDING_KIND, claim: { item: f.item, value: f.value, asOf: f.asOf }, registryStatus: "unmapped", unmappedFields: Object.keys(f.value) }];
  const known = new Set(m.fields);
  const unmappedFields = Object.keys(f.value).filter((k) => !known.has(k));
  const extra = m.extra ? m.extra({ ...f.value, as_of: f.asOf }) : {};
  const leftover = Object.fromEntries(Object.entries(f.value).filter(([k]) => !known.has(k)));
  if (!m.factKey) return [{ ...base, kind: m.kindOf ? m.kindOf(f.value) : m.kind, claim: { ...extra, ...(m.kind === RESEARCH_FINDING_KIND ? { item: f.item, value: f.value } : {}), ...(Object.keys(leftover).length ? { unmapped: leftover } : {}), asOf: f.asOf }, registryStatus: "unmapped", unmappedFields }];
  const input = { ...f.value, as_of: f.asOf };
  const out: MappedClaim[] = [];
  for (const k of [{ factKey: m.factKey, value: m.value, extra: m.extra }, ...(m.also ?? [])]) {
    const values = k.value ? k.value(input, f) : {};
    const usable = (Array.isArray(values) ? values : [values]).filter((v) => Object.keys(v).length > 0);
    const kExtra = k.extra ? k.extra(input) : {};
    const partial = unmappedFields.length > 0 || Object.keys(kExtra).length > 0;
    for (const v of usable) out.push({ ...base, kind: m.kind, claim: { factKey: k.factKey, value: v, ...kExtra, ...(Object.keys(leftover).length ? { unmapped: leftover } : {}) }, registryStatus: partial ? "partial" : "mapped", unmappedFields });
  }
  if (!out.length) return [{ ...base, kind: RESEARCH_FINDING_KIND, claim: { item: f.item, value: f.value, asOf: f.asOf, intendedFactKey: m.factKey }, registryStatus: "unmapped", unmappedFields: Object.keys(f.value) }];
  return out;
}

export function mapFindings(findings: Finding[]): MappedClaim[] { return findings.flatMap(mapFinding); }

// ── career status: derived, never asked ───────────────────────────────────────

/** Lineage levels whose evidence may drive a derived classification (accepted provenance; asserted_only/unsupported never do). */
const ACCEPTED_FOR_DERIVATION = new Set(["native_supported", "native_retrieved"]);

export type RetirementReading = "retirement" | "comeback" | "ambiguous";

/** Explicit comeback language (checked first: "came out of retirement" contains "retirement"). */
const COMEBACK = /\b(comeback|come back|came back|came out of retirement|coming out of retirement|out of retirement|return(?:s|ed|ing)? (?:to|from)|unretir\w*|revers(?:e|es|ed|ing) (?:his|her|their) retirement)\b/i;
/** Explicit retirement language: retired / retires / retiring / retirement / announced retirement / retired from … */
const RETIREMENT = /\b(retire[sd]?|retiring|retirement|called time on (?:his|her|their) career|hung up (?:his|her|their) (?:boots|cleats|skates|spikes|gloves|jersey))\b/i;
/** Hedged, future, negated or speculative wording → ambiguous, never retired. */
const HEDGE = /\b(consider(?:s|ing|ed)?|contemplat\w*|mull(?:s|ing|ed)?|weigh(?:s|ing|ed)?|rumou?r\w*|speculat\w*|reportedly|might|may|could|possib\w*|hint(?:s|ed|ing)?|teas(?:e|es|ed|ing)|unclear|undecided|uncertain|den(?:y|ies|ied|ying)|dismiss\w*|refut\w*|no plans?|not (?:yet )?retir\w*|isn'?t retir\w*|hasn'?t retired|has not retired|won'?t retire|will (?:not|never) retire|expected to|set to|plans? to|intends? to|will retire|would retire|to retire (?:at|after|following|when)|farewell|final season|last season|one more (?:season|year)|at the end of (?:the|this|his|her|their) (?:season|year|contract)|after (?:this|the|next) season|open to|linked with|in talks|questions? (?:about|over)|future)\b/i;
/** "retired her number / jersey" is a team honour, not a career status. */
const NUMBER_RETIRED = /\b(?:number|jersey|shirt|no\.?\s*\d+)\b[^.]{0,40}\bretired\b|\bretired? (?:his|her|their|the) (?:number|jersey|shirt)\b/i;

/**
 * Deterministic reading of one retirement/comeback statement. Only explicit language counts; anything hedged, future,
 * negated, speculative, or about a retired jersey number is `ambiguous`. No age, inactivity, club-history or
 * last-known-team reasoning exists here — those never reach this function.
 */
export function classifyRetirementLanguage(text: string): RetirementReading {
  const t = String(text ?? "");
  if (!t.trim() || NUMBER_RETIRED.test(t) || HEDGE.test(t)) return "ambiguous";
  if (COMEBACK.test(t)) return "comeback";
  if (RETIREMENT.test(t)) return "retirement";
  return "ambiguous";
}

export type DerivedCareerStatus = { status: "retired" | null; basis: string | null };

/**
 * career_status derived under the approved Step 3 rule ONLY: explicit retirement language in an accepted
 * (native_supported / native_retrieved) `retirement_comeback` finding ⇒ `retired`; everything else ⇒ unknown (null).
 * The most recent dated retirement/comeback finding is the one read; if it is not explicit retirement the status is
 * unknown — an explicit comeback, a season-ending injury, a current affiliation with no end, a former affiliation,
 * age, inactivity and historic career language all leave the status unknown in this slice. Those candidate rules
 * are methodology decisions to be taken separately, not part of the registry/canonicalization implementation.
 */
export function deriveCareerStatus(findings: Finding[]): DerivedCareerStatus {
  const accepted = findings.filter((f) => ACCEPTED_FOR_DERIVATION.has(f.lineage.level));
  const events = accepted
    .filter((f) => f.item === "retirement_comeback" && (s(f.value.event) || s(f.statement)))
    .map((f) => ({ date: s(f.value.date) ?? "", text: [s(f.value.event), s(f.statement)].filter(Boolean).join(" ") }))
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!events.length) return { status: null, basis: null };
  const e = events[0];
  const reading = classifyRetirementLanguage(e.text);
  const basis = `retirement_comeback${e.date ? ` ${e.date}` : ""}: ${e.text.slice(0, 160)}`;
  if (reading === "retirement") return { status: "retired", basis };
  return { status: null, basis: `${reading === "comeback" ? "comeback (not derived in this slice)" : "ambiguous"} ${basis}` };
}
