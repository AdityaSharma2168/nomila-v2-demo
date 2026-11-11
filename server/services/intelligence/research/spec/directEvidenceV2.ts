/**
 * research/spec/directEvidenceV2.ts — `direct-evidence/2`: the item-centric provider contract (Step 2 of the
 * simplification, design `step4-research-architecture-simplification.md`, PR #448).
 *
 * The provider answers research-spec/1 ITEMS; Nomila assigns keys. Per query the provider receives only that query's
 * items, each with a small item-typed value shape (every field optional; unknown fields are kept as evidence), and
 * returns per item: status, findings (value · statement · as_of · sources) and the identity block. No registry fact
 * keys, evidence kinds, enums, tiers or cross-query shapes ever reach the provider. Deterministic mapping to registry
 * keys happens downstream in item-mapping/1. Research / Fact Mode only (grounding ON, bounded reasoning). Pure.
 */

import { HYBRID_MARKER } from "./directEvidenceV1";
import type { DirectClaimLineage, DirectSource, ProvenanceLevel } from "./directEvidenceV1";
import { MINOR_REQUEST_LINE, QUERIES, SECTIONS, type QueryDef, type RequestSubject, type Section, type SectionId } from "./researchSpecV1";
import { SOURCE_TYPES } from "../registries";

/** The outlet-type vocabulary the provider describes each source with (= research_evidence.source_type). A description, not a rating. */
export const OUTLET_TYPE_SHAPE = SOURCE_TYPES.join(" | ");
/** athlete_media: the medium and how the athlete takes part (generic; never a sport, school or person). */
export const MEDIA_MEDIUMS = ["video", "article", "podcast", "press_conference", "profile", "other"] as const;
export const MEDIA_PARTICIPATION = ["interview", "own_words", "profile", "mention"] as const;

export const DIRECT_EVIDENCE_V2_VERSION = "direct-evidence/2";
export const ITEM_STATUSES = ["found", "not_found", "conflicting", "not_applicable"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** Item-typed value shapes: field → short description shown to the provider. Every field optional. */
export const ITEM_SHAPES: Record<string, Record<string, string>> = {
  // S1
  full_name: { full: "full name", first: "first name", last: "last name" },
  aliases: { text: "the other name or nickname", type: "nickname | maiden | transliteration | handle | other" },
  birth_year: { year: "YYYY", date: "YYYY-MM-DD (adults only; never sought for a minor)" },
  nationality: { country: "country" },
  hometown: { city: "city", region: "state / region", country: "country" },
  sport_discipline: { sport: "sport", discipline: "discipline or event" },
  namesakes: { description: "who else this name refers to in the retrieved sources and how they differ" },
  // S2. Affiliations are teams the athlete competes for (Oct 2026): a job line on a school profile page (a camp counselor role) was read as a current team, so the shapes say what an affiliation is NOT. Wording only; the shape and its fields are unchanged.
  current_affiliation: { organization: "the team, club, school or national programme the athlete competes for as an athlete — never an employer, job, camp, clinic or programme they work or volunteer at", organization_type: "school | club | pro | national | olympic | other", league: "league or competition", level: "level or division as the source states it", conference: "conference", city: "city", country: "country", from: "YYYY or YYYY-MM-DD", to: "YYYY or YYYY-MM-DD or null if current", role: "the athlete's playing role on that team (starter, captain) — never a job title" },
  league_level_division: { league: "league or competition", level: "level or division as the source states it", conference: "conference" },
  market: { city: "city", country: "country" },
  past_affiliations: { organization: "a team, club, school or national programme the athlete competed for as an athlete — never an employer, job, camp or clinic", organization_type: "school | club | pro | national | olympic | other", league: "league or competition", level: "level or division", from: "YYYY", to: "YYYY" },
  position_role: { position: "position", role: "role (starter, captain, reserve)" },
  education_class_year: { class_year_label: "class year label (Freshman, Senior, ...)", season: "YYYY of that class year", graduation_year: "YYYY", degree: "degree or major" },
  national_team_programme: { team: "national team programme", age_group: "senior | U-23 | U-20 | U-17 | ...", year: "YYYY", role: "role" },
  // S3
  transfers_signings: { event: "what happened", organization: "team involved", date: "YYYY-MM-DD" },
  injuries: { event: "what happened", date: "YYYY-MM-DD", status: "status of the injury as the source states it (out for the season, returned to play, ...)" },
  milestones_selections: { event: "what happened", date: "YYYY-MM-DD" },
  retirement_comeback: { event: "what happened", date: "YYYY-MM-DD" },
  // S4
  results_titles: { name: "result or title", year: "YYYY", date: "YYYY-MM-DD", competition: "competition", organization: "team or body", scope: "international | national | conference | regional | school | club, only if the source states it" },
  records: { name: "record", year: "YYYY", scope: "as the source states it", value: "the record value" },
  season_statistics: { season: "YYYY or YYYY-YY", competition: "competition", metric: "statistic name", value: "value" },
  rankings: { body: "ranking body", rank: "numeric rank", year: "YYYY", scope: "what is ranked (class, position, ...)" },
  awards_selections: { name: "award or selection", year: "YYYY (one finding per year)", awarded_by: "awarding body", scope: "international | national | conference | regional | school | club, only if the source states it" },
  international_results: { team: "national team", competition: "competition", year: "YYYY", result: "result" },
  academic_honors: { name: "honor", year: "YYYY", awarded_by: "institution or body" },
  // S5
  national_coverage: { outlet: "outlet", headline: "headline", date: "YYYY-MM-DD" },
  regional_coverage: { outlet: "outlet", headline: "headline", date: "YYYY-MM-DD" },
  sport_specific_coverage: { outlet: "outlet", headline: "headline", date: "YYYY-MM-DD" },
  mainstream_coverage: { outlet: "outlet", headline: "headline", date: "YYYY-MM-DD" },
  viral_moments: { description: "what happened", date: "YYYY-MM-DD", platform: "platform" },
  appearances_outside_sport: { title: "programme, film, podcast, book or campaign", medium: "television | film | podcast | book | documentary | advertising | other", date: "YYYY-MM-DD" },
  social_conversation: { description: "what sources report", date: "YYYY-MM-DD", platform: "platform" },
  athlete_media: { title: "title of the video, article, episode or feature", outlet: "outlet or channel", outlet_type: OUTLET_TYPE_SHAPE, date: "YYYY-MM-DD", url: "direct URL of the page or video (not a search or redirect link)", medium: MEDIA_MEDIUMS.join(" | "), participation: `${MEDIA_PARTICIPATION.join(" | ")} (interview = the athlete is interviewed; own_words = the athlete speaks or writes in their own words; profile = a feature about the athlete; mention = named only)`, athlete_quote: "a short verbatim quote of the athlete shown in the source, if any" },
  // S6
  storylines: { text: "the storyline as the source states it", theme: "origin | adversity | comeback | first | other" },
  values_causes: { text: "the value, cause or advocacy as stated", organization: "organization if any" },
  foundations_positions: { text: "the foundation or public position as stated", organization: "organization if any" },
  brand_themes: { text: "the personal-brand theme as the source describes it" },
  signature_moments: { event: "the moment as the source states it", date: "YYYY-MM-DD", competition: "competition or occasion" },
  playing_style: { text: "the style as the source describes it", described_by: "who describes it (coach, scout, teammate, outlet)" },
  leadership_mentality: { text: "the leadership or mentality as the source describes it", described_by: "who describes it" },
  origin_background: { text: "the origin or background as the source states it" },
  motivations: { text: "the motivation as stated" },
  interests: { text: "the interest as stated" },
  associations: { text: "the association as the source states it", associated_with: "who or what the athlete is associated with" },
  // S7
  partnerships_deals: { brand: "brand", deal_type: "sponsorship | endorsement | nil_deal | collaboration | ambassador | other", category: "brand category", start: "YYYY-MM-DD", end: "YYYY-MM-DD or null", renewal: "true when a renewal or repeat", campaign: "campaign name", published_value: "value as published", currency: "currency" },
  deal_categories: { brand: "brand", category: "category" },
  deal_dates: { brand: "brand", start: "YYYY-MM-DD", end: "YYYY-MM-DD" },
  renewals_repeat: { brand: "brand", renewed: "true", date: "YYYY-MM-DD" },
  campaigns: { brand: "brand", campaign: "campaign name", date: "YYYY-MM-DD" },
  published_values: { brand: "brand", value: "value as published", currency: "currency" },
  representation: { agency: "agency", agent: "agent", since: "YYYY" },
  ventures: { name: "business, product or creative project", venture_type: "business | product_line | equity | creative | other", since: "YYYY" },
  third_party_valuations: { estimator: "who made the estimate", value: "the estimate as published", currency: "currency", year: "YYYY", basis: "what the estimate covers" },
  // S8
  official_accounts: { platform: "platform", handle: "handle", url: "profile URL" },
  verification_status: { platform: "platform", verified: "true | false as visible" },
  official_website: { url: "website URL" },
  follower_counts_as_stated: { platform: "platform", metric: "followers | subscribers | views | likes", value: "number exactly as the source states it", stated_on: "YYYY-MM-DD", stated_by: "who stated it" },
  content_formats: { description: "notable format or series", platform: "platform" },
  authenticity_concerns: { description: "the documented concern as stated", date: "YYYY-MM-DD" },
  // S9 (stages are the items themselves)
  reported_allegations: { event: "what was reported", date: "YYYY-MM-DD", reported_by: "who reported it" },
  official_findings_actions: { event: "the finding or action", body: "the body that acted", date: "YYYY-MM-DD", outcome: "as stated" },
  resolutions_outcomes: { event: "the resolution", date: "YYYY-MM-DD", outcome: "cleared | upheld | settled | served | other, as stated" },
};

/** Items research-spec/1 lists but the provider is NOT asked for: derived deterministically by Nomila. */
export const DERIVED_ITEMS: ReadonlySet<string> = new Set(["current_status"]);

export function itemsFor(query: QueryDef, sections: Section[]): { section: SectionId; id: string; text: string }[] {
  return sections.filter((s) => query.sections.includes(s.id)).flatMap((s) => s.items.filter((i) => !DERIVED_ITEMS.has(i.id)).map((i) => ({ section: s.id, id: i.id, text: i.text })));
}

export function contractForV2(query: QueryDef, sections: Section[]): string {
  const items = itemsFor(query, sections);
  const itemBlock = items.map((it) => {
    const shape = ITEM_SHAPES[it.id] ?? { text: "the finding as the source states it" };
    return `    "${it.id}": { "status": "found | not_found | conflicting | not_applicable", "reason": "not_applicable or conflicting only", "findings": [ { "value": { ${Object.entries(shape).map(([k, v]) => `"${k}": "${v}"`).join(", ")} }, "statement": "one sentence as the source states it", "as_of": "YYYY-MM-DD or null", "sources": [ { "url": "...", "title": "...", "published_at": "YYYY-MM-DD or null", "quote": "short verbatim passage", "outlet_type": "${OUTLET_TYPE_SHAPE}" } ] } ] }`;
  }).join(",\n");
  return `{
  "contract": "${DIRECT_EVIDENCE_V2_VERSION}", "query": "${query.id}",
  "identity": { "anchor_match": "matched | uncertain | not_resolved", "confidence": 0.0, "namesakes": [ { "description": "who else this name refers to in the sources you retrieved (omit if none)", "source_url": "..." } ] },
  "items": {
${itemBlock}
  }
}
Rules for values: include only fields a retrieved source states; omit the rest (never invent a field to complete the shape); one finding per distinct fact (one per award year, one per brand, one per alias); a number or date exactly as the source states it.`;
}

export const DIRECT_V2_OUTPUT_RULE_JSON =
  "Return your findings ONLY as a single JSON object following the direct-evidence/2 contract given in the request. Every finding must carry at least one source you actually retrieved (URL; title and publication date where visible; a short verbatim quote). The quote MUST be copied verbatim, character-for-character, from the retrieved source itself — never paraphrased, reconstructed, or copied from this prompt or contract; a finding whose quote is not a verbatim excerpt of a source you actually retrieved cannot be attributed and must be omitted. If you cannot attach a retrieved source to a finding, omit the finding and mark the item not_found. Prefer not_found over invention. Never rate, rank, tier or judge; describe. If the identity anchor cannot be matched with confidence, set anchor_match to not_resolved, return no findings, and mark every item not_found. Report every listed item id.";
export const DIRECT_V2_OUTPUT_RULE_HYBRID =
  `Respond in exactly two parts. PART 1 — FINDINGS: for each numbered item, write your factual findings in natural language, each statement attributed to the source you retrieved; this part must be search-grounded. Then a line containing only: ${HYBRID_MARKER} . PART 2 — one JSON object following the direct-evidence/2 contract given in the request. Every finding's sources[].quote MUST be copied verbatim, character-for-character, from your own PART 1 findings text above (the grounded prose) — never from a web page, table, or source snippet, and no longer than 200 characters. A finding whose quote is not a verbatim excerpt of PART 1 cannot be attributed; omit it and mark the item not_found instead. Prefer not_found over invention; never rate, rank, tier or judge; describe. If the identity anchor cannot be matched with confidence, say so in PART 1, set anchor_match to not_resolved, return no findings, and mark every item not_found. Report every listed item id.`;

/**
 * Projection of the frozen research-spec/1 query prose onto what the provider is responsible for researching:
 * every derived item's prompt phrase is removed from the prose exactly as it is worded in the frozen spec. The
 * underlying evidence items stay (transfers, injuries, milestones, retirement/comeback announcements); the
 * classification itself is Nomila's (`deriveCareerStatus`). research-spec/1 is untouched — it remains the
 * canonical statement of what Nomila needs to know; direct-evidence/2 defines what the provider is asked.
 * The phrase must be found (a silent no-op would ask the provider to classify) — tested.
 */
export const DERIVED_ITEM_PROSE_PROJECTIONS: ReadonlyArray<{ item: string; phrase: RegExp }> = [
  { item: "current_status", phrase: /current status \(active, injured or out this season, between\s+teams, retired\) with date and source; / },
];

/** The frozen query prose with the derived items projected out. Throws if a derived item's phrase is missing from the prose it belongs to. */
export function projectQueryProse(query: QueryDef, isMinor: boolean): string {
  let prose = query.text(isMinor);
  const askedSections = SECTIONS.filter((s) => query.sections.includes(s.id));
  for (const p of DERIVED_ITEM_PROSE_PROJECTIONS) {
    if (!askedSections.some((s) => s.items.some((i) => i.id === p.item))) continue;
    if (!p.phrase.test(prose)) throw new Error(`direct-evidence/2: derived item ${p.item} not found in the frozen prose of ${query.id}; the projection would silently ask the provider to classify`);
    prose = prose.replace(p.phrase, "");
  }
  return prose;
}

/** The request: the research-spec/1 head + the projected query prose (derived items never asked) + the v2 contract. Byte-identical for every provider. */
export function directRequestV2(subject: RequestSubject, query: QueryDef, sections: Section[], asOf: string): string {
  const head = [`Athlete identity anchor: ${subject.anchor}`, `Athlete: ${subject.fullName} — ${subject.sport}`, `As-of date: ${asOf}`, subject.isMinor ? MINOR_REQUEST_LINE : null].filter(Boolean).join("\n");
  return `${head}\n\n${projectQueryProse(query, subject.isMinor)}\n\nOutput contract (${DIRECT_EVIDENCE_V2_VERSION}):\n${contractForV2(query, sections)}`;
}

// ── parsing ──
export interface Finding {
  section: SectionId;
  item: string;
  value: Record<string, unknown>;
  statement: string | null;
  asOf: string | null;
  sources: DirectSource[];
  lineage: DirectClaimLineage;
}
export interface ItemResult { status: ItemStatus; reason: string | null; findings: Finding[] }
export interface ParsedDirectV2 { items: Partial<Record<string, ItemResult>>; identity: { anchorMatch: "matched" | "uncertain" | "not_resolved" | null; confidence: number | null; namesakes: { description: string; sourceUrl: string | null }[] }; parseError: string | null; unknownItems: string[] }

const isStatus = (v: unknown): v is ItemStatus => (ITEM_STATUSES as readonly string[]).includes(String(v));

export function parseDirectEvidenceV2(jsonText: string, query: QueryDef, sections: Section[]): ParsedDirectV2 {
  const empty = (error: string): ParsedDirectV2 => ({ items: {}, identity: { anchorMatch: null, confidence: null, namesakes: [] }, parseError: error, unknownItems: [] });
  const t = jsonText.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = t.indexOf("{"); const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return empty("no JSON object in the response");
  let j: any;
  try { j = JSON.parse(t.slice(start, end + 1)); } catch (e: any) { return empty(e.message); }
  if (!j || typeof j !== "object" || Array.isArray(j)) return empty("top-level JSON is not an object");
  const asked = new Map(itemsFor(query, sections).map((i) => [i.id, i.section]));
  const items: ParsedDirectV2["items"] = {};
  const unknownItems: string[] = [];
  for (const [id, v] of Object.entries((j.items && typeof j.items === "object" ? j.items : {}) as Record<string, any>)) {
    const section = asked.get(id.trim());
    if (!section) { unknownItems.push(id); continue; }
    if (!v || typeof v !== "object") continue;
    const findings: Finding[] = [];
    for (const f of Array.isArray(v.findings) ? v.findings : []) {
      if (!f || typeof f !== "object") continue;
      const value = f.value && typeof f.value === "object" && !Array.isArray(f.value) ? Object.fromEntries(Object.entries(f.value).filter(([, x]) => x != null && x !== "")) : {};
      const sources: DirectSource[] = (Array.isArray(f.sources) ? f.sources : []).filter((s: any) => s && typeof s.url === "string").map((s: any) => ({ url: String(s.url), title: typeof s.title === "string" ? s.title : null, publishedAt: typeof s.published_at === "string" && /^\d{4}-\d{2}-\d{2}/.test(s.published_at) ? s.published_at.slice(0, 10) : null, quote: typeof s.quote === "string" ? s.quote : "", ...(typeof s.outlet_type === "string" && s.outlet_type.trim() ? { outletType: s.outlet_type.trim().toLowerCase() } : {}) }));
      findings.push({ section, item: id.trim(), value, statement: typeof f.statement === "string" ? f.statement : null, asOf: typeof f.as_of === "string" && /^\d{4}/.test(f.as_of) ? f.as_of.slice(0, 10) : null, sources, lineage: { level: sources.length ? "asserted_only" : "unsupported", match: "none", boundChunkIds: [], boundSources: [], detail: sources.length ? "not yet validated" : "no source given", bindingMethod: "none" } });
    }
    items[id.trim()] = { status: isStatus(v.status) ? v.status : (findings.length ? "found" : "not_found"), reason: typeof v.reason === "string" ? v.reason.slice(0, 300) : null, findings };
  }
  return {
    items, unknownItems,
    identity: { anchorMatch: ["matched", "uncertain", "not_resolved"].includes(j.identity?.anchor_match) ? j.identity.anchor_match : null, confidence: typeof j.identity?.confidence === "number" ? j.identity.confidence : null, namesakes: Array.isArray(j.identity?.namesakes) ? j.identity.namesakes.filter((n: any) => n && typeof n.description === "string").map((n: any) => ({ description: String(n.description).slice(0, 300), sourceUrl: typeof n.source_url === "string" ? n.source_url : null })) : [] },
    parseError: null,
  };
}

/** Degenerate = unusable answer: malformed, no asked item reported, template echo, or zero findings although identity matched and sources were retrieved. A not_resolved identity with zero findings is a valid abstention. */
export function directDegenerateV2(parsed: ParsedDirectV2, nativeSources: number, askedItems: number): { degenerate: boolean; reason: string | null } {
  if (parsed.parseError) return { degenerate: true, reason: `malformed: ${parsed.parseError}` };
  const reported = Object.keys(parsed.items).length;
  if (askedItems && reported === 0) return { degenerate: true, reason: parsed.unknownItems.length ? `no reported item matched an asked item (${parsed.unknownItems.slice(0, 3).join(" | ")})` : "no items reported" };
  const findings = Object.values(parsed.items).reduce((a, i) => a + (i?.findings.length ?? 0), 0);
  const allNotFound = Object.values(parsed.items).every((i) => i?.status === "not_found");
  if (findings === 0 && parsed.identity.confidence === 0 && parsed.identity.anchorMatch !== "not_resolved" && allNotFound) return { degenerate: true, reason: "template echo: zero findings, identity confidence exactly 0.0, every item not_found" };
  if (findings === 0 && parsed.identity.anchorMatch === "matched" && nativeSources > 0) return { degenerate: true, reason: `zero findings although the identity was matched and ${nativeSources} sources were retrieved` };
  return { degenerate: false, reason: null };
}

/** Words that must never appear in a v2 contract or request (provider-facing vocabulary guard). */
export const FORBIDDEN_IN_V2_CONTRACT = [/\bfactKey\b/, /\bregistry\b/i, /\btier\b/i, /\bnil_mention\b/, /\breputation_event\b/, /\bsocial_metric_claim\b/, /\bnarrative_claim\b/, /\bevidence kind\b/i, /\bkind":/];
export { QUERIES, SECTIONS };
export type { ProvenanceLevel };
