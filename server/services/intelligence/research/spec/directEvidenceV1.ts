/**
 * research/spec/directEvidenceV1.ts — `direct-evidence/1`: the provider-neutral structured evidence contract a
 * search-enabled research model returns DIRECTLY (path B; approved 13 Sep 2026), built on cited-claims/3 semantics.
 *
 * Research / Fact Mode only: grounding/search ON, the frozen research-spec/1 request text, the same sections, items,
 * four-way outcomes, evidence kinds, registry fact keys and value shapes, reputation stages and abstention preference.
 * No Kimi. Nomila still owns classification, canonicalization, the strict registry, resolution and scoring; the
 * provider returns observable, sourced evidence only.
 *
 * Output-format compilation is the ONLY per-provider difference, and it exists solely to preserve provenance that the
 * provider APIs expose differently: Gemini answers with factual research prose (grounded: chunks + supports attach to
 * it) followed by the JSON whose quotes are copied character-for-character from that prose, so each claim binds to a
 * grounding support by index (native_supported); OpenAI answers with the JSON alone and the harness requests the
 * search call's retrieved-source list, so each claim's URL is matched to a retrieved source (native_retrieved). The
 * Gemini prose is research/evidence prose only — never a precedent for downstream creative generation, which runs
 * with grounding OFF (architecture principle: grounding is task-dependent, not a global model setting). Pure.
 */

import type { SearchEnvelope } from "../providers";
import type { BindingMethod } from "./directLineage";
import { EVIDENCE_KINDS_V3, QUERIES, REPUTATION_STAGES, SECTION_OUTCOMES, SECTIONS, type ExtractedClaimV3, type QueryDef, type ReportedSectionOutcome, type Section, type SectionId, type SectionOutcome } from "./researchSpecV1";

export const DIRECT_EVIDENCE_VERSION = "direct-evidence/1";
export const HYBRID_MARKER = "===DIRECT-EVIDENCE-JSON===";

export type ProvenanceLevel = "native_supported" | "native_retrieved" | "asserted_only" | "unsupported" | "source_read";
export const PROVENANCE_LEVELS: readonly ProvenanceLevel[] = ["native_supported", "native_retrieved", "asserted_only", "unsupported"];
/** Acceptance policies reported side by side (never a production decision here). */
export type AcceptancePolicy = "strict" | "retrieved";
export const ACCEPTED_LEVELS: Record<AcceptancePolicy, readonly ProvenanceLevel[]> = { strict: ["native_supported"], retrieved: ["native_supported", "native_retrieved"] };

// ── the contract text (per query; the value-shape examples are those of cited-claims/3) ──
const VALUE_EXAMPLES = `{"sport":"basketball"} | {"org":"Riverside University","orgKind":"school","level":"D1","conference":"Big Sky","season":2026} | {"name":"National Athletics Federation Rising Star Award","year":2025,"level":"national"} | {"status":"active"} | {"year":2004} | {"city":"...","region":"...","country":"..."} | {"team":"Northgate RFC","level":"professional","year":2022} | {"body":"...","rank":3,"year":2024,"scope":"..."} | {"source":"NIL Valuation Service","value":"$1.2M","year":2025}`;
const DESCRIPTIVE_FIELDS = `"timeframe": "affiliation: current | past", "league": "affiliation, descriptive", "division": "affiliation", "market": "affiliation: city/country", "category": "achievement: result | title | record | statistic; award: athletic | academic; brand_mention: the brand's category", "outlet": "press_mention", "headline": "press_mention", "outletContext": "press_mention: national | international | regional | local | sport_specific | mainstream (as the source describes it)", "topic": "press_mention: coverage | viral_moment | social_conversation; narrative_claim: storyline | values_causes | foundation_position | brand_theme; identity_signal: namesake | anchor_match", "brand": "brand_mention", "type": "brand_mention: sponsorship | endorsement | nil_deal | collaboration | ambassador", "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD", "renewal": "brand_mention: true when a renewal/repeat", "campaign": "brand_mention", "publishedValue": "brand_mention: as published", "platform": "social_handle | social_metric_claim (website for the official site)", "handle": "social_handle", "verified": "social_handle: true | false when visible", "metric": "social_metric_claim: followers | subscribers | views | likes", "metricValue": "social_metric_claim: number as stated", "statedOn": "YYYY-MM-DD", "statedBy": "social_metric_claim: who stated it", "eventKind": "career_event: transfer | signing | promotion | injury | recovery | milestone | selection | retirement | comeback", "event": "career_event | reputation_event: what happened", "date": "YYYY-MM-DD", "stage": "reputation_event: reported_allegation | official_finding_or_action | resolution_or_outcome", "outcome": "reputation_event: as stated", "agency": "representation", "agent": "representation", "name": "venture: the business/product", "ventureKind": "venture: business | product_line | equity", "title": "crossover_appearance", "medium": "crossover_appearance: television | film | podcast | book | documentary | advertising | other", "text": "narrative_claim: the storyline/value/theme as the source states it"`;

export function contractFor(query: QueryDef, sections: Section[]): string {
  const secs = sections.filter((s) => query.sections.includes(s.id));
  return `{
  "contract": "${DIRECT_EVIDENCE_VERSION}", "query": "${query.id}",
  "identity": { "anchor_match": "matched | uncertain | not_resolved", "confidence": 0.0, "namesakes": [ { "description": "another person this name refers to in the sources you retrieved (omit the array entry if none)", "source_url": "..." } ] },
  "sections": {
${secs.map((s) => `    "${s.id}": { "status": "found_cited | not_found | conflicting | not_applicable", "items": { ${s.items.map((i) => `"${i.id}": "found_cited | not_found | conflicting | not_applicable"`).join(", ")} }, "reason": "not_applicable only", "conflicts": [ { "item": "<item id>", "values": [ { "value": "...", "source_url": "..." } ] } ] }`).join(",\n")}
  },
  "claims": [
    {
      "section": "${secs[0]?.id ?? "S1"}", "item": "<item id from the section above>",
      "kind": "${EVIDENCE_KINDS_V3.filter((k) => k !== "signal" && k !== "sentiment" && k !== "media_asset").join(" | ")}",
      "factKey": "fact-bearing kinds only: name | alias | birth_year | sport | position | event | class_year | graduation_year | hometown | nationality | career_status | affiliation | achievement | award | ranking | national_team_participation | nil_mention",
      "value": "the registry value shape, e.g. ${VALUE_EXAMPLES}",
      ${DESCRIPTIVE_FIELDS},
      "statement": "one sentence stating the fact as the source states it",
      "sources": [ { "url": "https://...", "title": "...", "published_at": "YYYY-MM-DD or null", "quote": "short verbatim passage" } ],
      "confidence": 0.0
    }
  ]
}`;
}

/** Output rules appended to the frozen system instruction. */
export const DIRECT_OUTPUT_RULE_JSON =
  "Return your findings ONLY as a single JSON object following the direct-evidence/1 contract given in the request. Every claim must carry at least one source you actually retrieved (URL; title and publication date where visible; a short verbatim quote). If you cannot attach a retrieved source to a claim, omit the claim and mark the item NOT FOUND. Prefer NOT FOUND over invention. If the identity anchor cannot be matched with confidence, set anchor_match to not_resolved, return no claims, and mark every item NOT FOUND. Report every listed item id in section items.";
export const DIRECT_OUTPUT_RULE_HYBRID =
  `Respond in exactly two parts. PART 1 — FINDINGS: for each numbered item, write your factual findings in natural language, each statement attributed to the source you retrieved; this part must be search-grounded. Then a line containing only: ${HYBRID_MARKER} . PART 2 — one JSON object following the direct-evidence/1 contract given in the request. Every claim's sources[].quote MUST be a short passage (<= 200 characters) copied character-for-character from your own PART 1 text (not from the web page), so the claim can be traced to the grounded findings. Prefer NOT FOUND over invention; if the identity anchor cannot be matched with confidence, say so in PART 1, set anchor_match to not_resolved, return no claims, and mark every item NOT FOUND. Report every listed item id in section items.`;

/** The request: the frozen research-spec/1 request minus its prose/status closing instruction, plus the contract. Byte-identical for every provider. */
export function directRequest(specRequest: string, query: QueryDef, sections: Section[]): string {
  const body = specRequest.replace(/\n\nFor each numbered category, list dated, sourced findings for each listed item, then give the status of each\nitem and of the category \(FOUND \/ NOT FOUND \/ CONFLICTING \/ NOT APPLICABLE\)\.$/, "");
  return `${body}\n\nOutput contract (${DIRECT_EVIDENCE_VERSION}):\n${contractFor(query, sections)}`;
}

// ── parsing ──
export interface DirectSource { url: string; title: string | null; publishedAt: string | null; quote: string; /** The model's description of the outlet in the SOURCE_TYPES vocabulary (direct-evidence/2 `outlet_type`); validated at persist. */ outletType?: string | null }
export interface DirectClaimLineage { level: ProvenanceLevel; match: "index_support" | "url_exact" | "url_normalized" | "none"; boundChunkIds: string[]; boundSources: Array<{ url: string; domain: string | null; title: string | null }>; detail: string | null; bindingMethod: BindingMethod }
/** A cited-claims/3 claim plus its direct-path provenance. `citation` holds the bound chunk ids (empty when unbound) and the provider's quote. */
export interface DirectClaim extends ExtractedClaimV3 { section: SectionId | null; item: string | null; statement: string | null; sources: DirectSource[]; lineage: DirectClaimLineage }
export interface DirectIdentity { anchorMatch: "matched" | "uncertain" | "not_resolved" | null; confidence: number | null; namesakes: Array<{ description: string; sourceUrl: string | null }> }
export interface ParsedDirect { claims: DirectClaim[]; sectionOutcomes: Partial<Record<SectionId, ReportedSectionOutcome>>; identity: DirectIdentity; parseError: string | null; unknownSectionKeys: string[] }

const isOutcome = (v: unknown): v is SectionOutcome => (SECTION_OUTCOMES as readonly string[]).includes(String(v));
const CLAIM_META = new Set(["section", "item", "kind", "statement", "sources", "confidence", "published_at", "publishedAt"]);

export function extractJsonObject(text: string): { json: string | null; error: string | null } {
  const t = text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = t.indexOf("{"); const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return { json: null, error: "no JSON object in the response" };
  return { json: t.slice(start, end + 1), error: null };
}

/** Split a hybrid response into prose and JSON text by the exact marker. */
export function splitHybrid(text: string): { prose: string; jsonText: string; markerFound: boolean } {
  const i = text.indexOf(HYBRID_MARKER);
  return i >= 0 ? { prose: text.slice(0, i), jsonText: text.slice(i + HYBRID_MARKER.length), markerFound: true } : { prose: "", jsonText: text, markerFound: false };
}

export function parseDirectEvidence(jsonText: string, sections: Section[]): ParsedDirect {
  const empty = (error: string): ParsedDirect => ({ claims: [], sectionOutcomes: {}, identity: { anchorMatch: null, confidence: null, namesakes: [] }, parseError: error, unknownSectionKeys: [] });
  const { json, error } = extractJsonObject(jsonText);
  if (!json) return empty(error!);
  let j: any;
  try { j = JSON.parse(json); } catch (e: any) { return empty(e.message); }
  if (!j || typeof j !== "object" || Array.isArray(j)) return empty("top-level JSON is not an object");
  const asked = new Map(sections.map((s) => [s.id, s]));
  const aliases = new Map<string, SectionId>();
  for (const s of SECTIONS) { aliases.set(s.id, s.id); aliases.set(`${s.id} ${s.name}`, s.id); aliases.set(s.name, s.id); }
  const sectionOutcomes: Partial<Record<SectionId, ReportedSectionOutcome>> = {};
  const unknownSectionKeys: string[] = [];
  for (const [rawKey, v] of Object.entries((j.sections && typeof j.sections === "object" ? j.sections : {}) as Record<string, any>)) {
    const id = aliases.get(rawKey.trim());
    if (!id) { unknownSectionKeys.push(rawKey); continue; }
    const section = asked.get(id);
    if (!section || !v || typeof v !== "object") continue;
    const items: Record<string, SectionOutcome> = {};
    for (const it of section.items) { const o = v.items?.[it.id]; if (isOutcome(o)) items[it.id] = o; }
    const conflicts = Array.isArray(v.conflicts) ? v.conflicts.filter((c: any) => c && typeof c.item === "string" && Array.isArray(c.values)).map((c: any) => ({ item: String(c.item), values: c.values.filter((x: any) => x && typeof x.value === "string").map((x: any) => ({ value: String(x.value).slice(0, 300), chunkIds: typeof x.source_url === "string" ? [x.source_url] : [] })) })) : [];
    sectionOutcomes[id] = { status: isOutcome(v.status) ? v.status : "not_found", items, reviewedChunkIds: [], conflicts, reason: typeof v.reason === "string" ? v.reason.slice(0, 300) : null };
  }
  const identity: DirectIdentity = {
    anchorMatch: ["matched", "uncertain", "not_resolved"].includes(j.identity?.anchor_match) ? j.identity.anchor_match : null,
    confidence: typeof j.identity?.confidence === "number" ? j.identity.confidence : null,
    namesakes: Array.isArray(j.identity?.namesakes) ? j.identity.namesakes.filter((n: any) => n && typeof n.description === "string").map((n: any) => ({ description: String(n.description).slice(0, 300), sourceUrl: typeof n.source_url === "string" ? n.source_url : null })) : [],
  };
  const claims: DirectClaim[] = [];
  for (const c of Array.isArray(j.claims) ? j.claims : []) {
    if (!c || typeof c !== "object" || !(EVIDENCE_KINDS_V3 as readonly string[]).includes(c.kind)) continue;
    if (c.kind === "reputation_event" && !(REPUTATION_STAGES as readonly string[]).includes(String(c.stage))) continue;
    const claim: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c)) if (!CLAIM_META.has(k) && v != null) claim[k] = v;
    if (typeof claim.factKey !== "string") delete claim.factKey;
    const sources: DirectSource[] = (Array.isArray(c.sources) ? c.sources : []).filter((s: any) => s && typeof s.url === "string").map((s: any) => ({ url: String(s.url), title: typeof s.title === "string" ? s.title : null, publishedAt: typeof s.published_at === "string" && /^\d{4}-\d{2}-\d{2}/.test(s.published_at) ? s.published_at.slice(0, 10) : null, quote: typeof s.quote === "string" ? s.quote : "" }));
    const sectionId = typeof c.section === "string" ? aliases.get(c.section.trim()) ?? null : null;
    claims.push({
      kind: c.kind, claim, citation: sources[0]?.quote ? { chunkIds: [], quote: sources[0].quote.slice(0, 300) } : null,
      confidence: typeof c.confidence === "number" ? c.confidence : undefined, publishedAt: sources.find((s) => s.publishedAt)?.publishedAt ?? null,
      section: sectionId, item: typeof c.item === "string" ? c.item : null, statement: typeof c.statement === "string" ? c.statement : null, sources,
      lineage: { level: sources.length ? "asserted_only" : "unsupported", match: "none", boundChunkIds: [], boundSources: [], detail: sources.length ? "not yet validated" : "no source given", bindingMethod: "none" },
    });
  }
  return { claims, sectionOutcomes, identity, parseError: null, unknownSectionKeys };
}

/** Degenerate = the provider answered but the answer is unusable (malformed, no section outcomes, template echo, zero claims while identity matched and sources were retrieved). A not_resolved identity with zero claims is a valid abstention. */
export function directDegenerate(parsed: ParsedDirect, nativeSources: number, sections: Section[]): { degenerate: boolean; reason: string | null } {
  if (parsed.parseError) return { degenerate: true, reason: `malformed: ${parsed.parseError}` };
  if (sections.length && Object.keys(parsed.sectionOutcomes).length === 0) return { degenerate: true, reason: parsed.unknownSectionKeys.length ? `no section outcome matched an exact alias (${parsed.unknownSectionKeys.slice(0, 3).join(" | ")})` : "no section_outcomes for any asked section" };
  const items = Object.values(parsed.sectionOutcomes).flatMap((o) => Object.values(o!.items));
  const allNotFound = items.length > 0 && items.every((x) => x === "not_found");
  if (parsed.claims.length === 0 && parsed.identity.confidence === 0 && parsed.identity.anchorMatch !== "not_resolved" && allNotFound) return { degenerate: true, reason: "template echo: zero claims, identity confidence exactly 0.0, every item not_found" };
  if (parsed.claims.length === 0 && parsed.identity.anchorMatch === "matched" && nativeSources > 0) return { degenerate: true, reason: `zero claims although the identity was matched and ${nativeSources} sources were retrieved` };
  return { degenerate: false, reason: null };
}

/** The six queries in order, for the harness. */
export const DIRECT_QUERIES: QueryDef[] = QUERIES;
export type { SearchEnvelope };
