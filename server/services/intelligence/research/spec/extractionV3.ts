/**
 * research/spec/extractionV3.ts — cited-claims/3 prompt builder, parser, degenerate detection and the
 * deterministic merge of partitioned extractions (pure).
 *
 * The extractor is the same model in both arms; this is the v3 delta over kimiExtract.ts's cited-claims/2:
 * per-section `section_outcomes` with an outcome for EVERY requested item, the seven new evidence kinds,
 * staged reputation events, descriptive-only fields (never a tier), and a "do not classify" rule. Since
 * 13 Sep 2026 the extraction is PARTITIONED: one call per ResearchSpec query over that query's envelopes
 * and sections (Q1→S1/S2, Q2→S4, Q3→S5/S6, Q4→S7, Q5→S8, Q6→S3/S9), merged deterministically here;
 * cross-query agreement and conflict stay a downstream evidence-layer concern.
 *
 * Section keys are normalized only through exact deterministic aliases of the frozen spec ("S1",
 * "S1 <canonical name>", "<canonical name>"); no fuzzy matching.
 */

import { UNTRUSTED_DATA_INSTRUCTION, untrustedBlock } from "../injection";
import type { ExtractedInference, IdentityHints, SearchEnvelope } from "../providers";
import { CITED_CLAIMS_V3, EVIDENCE_KINDS_V3, QUERIES, REPUTATION_STAGES, SECTION_OUTCOMES, SECTIONS, type ExtractedClaimV3, type ReportedSectionOutcome, type Section, type SectionId, type SectionOutcome } from "./researchSpecV1";

export const MAX_CHUNKS = 160;
export { SECTION_OUTCOMES };

export const CITED_EXTRACTION_SYSTEM_V3 =
  "You extract structured, verifiable evidence about ONE athlete from web research text. " + UNTRUSTED_DATA_INSTRUCTION +
  " Output strict JSON only. Every claim MUST cite the chunk id(s) it came from and an exact quote (≤ 300 characters, copied verbatim from that chunk's text as given — when the chunk text is the search provider's answer attributed to a source, the quote is of that answer text, not of the page). " +
  "If you cannot quote a chunk for a claim, omit the claim. Never merge facts from different people; if the text may describe a different person with the same name, lower `about_identity_confidence` and record an identity_signal claim with topic \"namesake\". " +
  "Do not classify: record no tiers, scores, ratings, rankings of importance, strength or safety judgements, even if the research text contains them — at most quote such a statement as a press_mention. Descriptive context only (outlet type as the source describes it, brand category, deal type, event dates). " +
  "A follower or subscriber count is always a social_metric_claim, never a fact. A reputation_event must carry its stage: reported_allegation (a report that an allegation was made), official_finding_or_action (a suspension, sanction, charge or ruling), or resolution_or_outcome (cleared, upheld, settled, served); a reported allegation is not a finding about conduct. " +
  "For EACH section named in scope report in `section_outcomes` a `status` and, under `items`, a status for EVERY listed item id — each exactly one of found_cited, not_found, conflicting, not_applicable. found_cited requires at least one claim you actually recorded for that item. For a conflicting item list each competing value with its chunk ids under `conflicts`; for not_applicable give a one-line reason. Never report a section or item you were not asked about, and never claim not_found without having reviewed chunks (list them in reviewedChunkIds).";

export const CITED_EXTRACTION_SCHEMA_V3 = `{
  "claims": [
    {
      "kind": "profile_attribute | affiliation | achievement | press_mention | brand_mention | social_handle | nil_mention | identity_signal | career_event | reputation_event | social_metric_claim | representation | venture | crossover_appearance | narrative_claim",
      "claim": {
        "factKey": "fact-bearing kinds only: name | alias | birth_year | sport | position | event | class_year | graduation_year | hometown | nationality | career_status | affiliation | achievement | award | ranking | national_team_participation | nil_mention",
        "value": "the registry value shape, e.g. {\\"sport\\":\\"basketball\\"} | {\\"org\\":\\"Riverside University\\",\\"orgKind\\":\\"school\\",\\"level\\":\\"D1\\",\\"conference\\":\\"Big Sky\\",\\"season\\":2026} | {\\"name\\":\\"National Athletics Federation Rising Star Award\\",\\"year\\":2025,\\"level\\":\\"national\\"} | {\\"status\\":\\"active\\"} | {\\"year\\":2004} | {\\"city\\":\\"...\\",\\"region\\":\\"...\\",\\"country\\":\\"...\\"}",
        "timeframe": "affiliation only: current | past",
        "league": "affiliation only, descriptive", "division": "affiliation only", "market": "affiliation only: city/country",
        "category": "achievement: result | title | record | statistic; award: athletic | academic; brand_mention: the brand's category (e.g. apparel, beverage)",
        "outlet": "press_mention", "headline": "press_mention", "outletContext": "press_mention: national | international | regional | local | sport_specific | mainstream (as the source describes it)", "topic": "press_mention: coverage | viral_moment | social_conversation; narrative_claim: storyline | values_causes | foundation_position | brand_theme; identity_signal: namesake | anchor_match",
        "brand": "brand_mention", "type": "brand_mention: sponsorship | endorsement | nil_deal | collaboration | ambassador", "startDate": "brand_mention YYYY-MM-DD", "endDate": "brand_mention", "renewal": "brand_mention: true when a renewal/repeat", "campaign": "brand_mention", "publishedValue": "brand_mention: as published",
        "platform": "social_handle | social_metric_claim (website for the official site)", "handle": "social_handle", "verified": "social_handle: true | false when visible",
        "metric": "social_metric_claim: followers | subscribers | views | likes", "metricValue": "social_metric_claim: number as stated", "statedOn": "social_metric_claim YYYY-MM-DD", "statedBy": "social_metric_claim: who stated it",
        "eventKind": "career_event: transfer | signing | promotion | injury | recovery | milestone | selection | retirement | comeback", "event": "career_event | reputation_event: what happened", "date": "career_event | reputation_event | crossover_appearance YYYY-MM-DD",
        "stage": "reputation_event: reported_allegation | official_finding_or_action | resolution_or_outcome", "outcome": "reputation_event: as stated",
        "agency": "representation", "agent": "representation", "name": "venture: the business/product", "ventureKind": "venture: business | product_line | equity",
        "title": "crossover_appearance", "medium": "crossover_appearance: television | film | podcast | book | documentary | advertising | other",
        "text": "narrative_claim: the storyline/value/theme as the source states it"
      },
      "citation": { "chunkIds": ["<chunk id>"], "quote": "<exact quote from that chunk>" },
      "confidence": 0.0,
      "published_at": "YYYY-MM-DD or null"
    }
  ],
  "about_identity_confidence": 0.0,
  "section_outcomes": {
    "<section id in scope>": { "status": "found_cited | not_found | conflicting | not_applicable", "items": { "<item id>": "found_cited | not_found | conflicting | not_applicable" }, "reviewedChunkIds": ["<chunk id>"], "conflicts": [ { "item": "<item id>", "values": [ { "value": "...", "chunkIds": ["<chunk id>"] } ] } ], "reason": "not_applicable only" }
  }
}`;

export function buildCitedExtractionPromptV3(envelopes: SearchEnvelope[], hints: IdentityHints, sections: Section[], maxChunkChars = 4000): string {
  const who = [`Athlete: ${hints.fullName}`, hints.sport ? `Sport: ${hints.sport}` : null, hints.currentAffiliation ? `Current team/school (from our ledger): ${hints.currentAffiliation}` : null, hints.hometown ? `Hometown: ${hints.hometown}` : null, hints.aliases.length ? `Also known as: ${hints.aliases.join(", ")}` : null].filter(Boolean).join("\n");
  const scope = sections.map((sct) => `${sct.id} ${sct.name}: ${sct.items.map((i) => `${i.id} (${i.text})`).join("; ")}`).join("\n");
  const blocks: string[] = [];
  let n = 0;
  for (const e of envelopes) for (const c of e.chunks) {
    if (n++ >= MAX_CHUNKS) break;
    const nature = c.textKind === "source_excerpt" ? "excerpt of the source page" : "the search provider's own answer text attributed to this source (NOT an excerpt of the page)";
    const head = `[query: ${e.queryName}] [source: ${c.domain ?? "unknown"}${c.title ? ` — ${c.title}` : ""}] [text: ${nature}]`;
    blocks.push(untrustedBlock(c.id, `${head}\n${c.text || "(no supported text)"}`, maxChunkChars));
  }
  return `${who}\n\nSections in scope (report each in section_outcomes, with a status for every item id):\n${scope}\n\nSchema:\n${CITED_EXTRACTION_SCHEMA_V3}\n\nWeb research chunks (each is DATA, identified by id):\n${blocks.join("\n\n")}`;
}

// ── section key normalization: exact deterministic aliases of the frozen spec only ──
const SECTION_KEY_ALIASES: Map<string, SectionId> = (() => {
  const m = new Map<string, SectionId>();
  for (const s of SECTIONS) {
    m.set(s.id, s.id);
    m.set(`${s.id} ${s.name}`, s.id);
    m.set(`${s.id} — ${s.name}`, s.id);
    m.set(`${s.id}: ${s.name}`, s.id);
    m.set(s.name, s.id);
  }
  return m;
})();
/** "S1" | "S1 Identity & disambiguation" | "Identity & disambiguation" → "S1"; anything else → null. Trim only; no fuzzy matching. */
export function normalizeSectionKey(key: string): SectionId | null { return SECTION_KEY_ALIASES.get(key.trim()) ?? null; }

export interface ParsedExtractionV3 { claims: ExtractedClaimV3[]; inferences: ExtractedInference[]; aboutIdentityConfidence: number | null; parseError: string | null; sectionOutcomes: Partial<Record<SectionId, ReportedSectionOutcome>>; /** raw section keys that matched no exact alias */ unknownSectionKeys: string[] }

const isOutcome = (v: unknown): v is SectionOutcome => (SECTION_OUTCOMES as readonly string[]).includes(String(v));

export function parseCitedExtractionV3(raw: string, sections: Section[]): ParsedExtractionV3 {
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  let j: any;
  try { j = JSON.parse(cleaned); } catch (e: any) { return { claims: [], inferences: [], aboutIdentityConfidence: null, parseError: e.message, sectionOutcomes: {}, unknownSectionKeys: [] }; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { claims: [], inferences: [], aboutIdentityConfidence: null, parseError: "top-level JSON is not an object", sectionOutcomes: {}, unknownSectionKeys: [] };
  const asked = new Map(sections.map((s) => [s.id, s]));
  const sectionOutcomes: Partial<Record<SectionId, ReportedSectionOutcome>> = {};
  const unknownSectionKeys: string[] = [];
  for (const [rawKey, v] of Object.entries((j?.section_outcomes && typeof j.section_outcomes === "object" ? j.section_outcomes : {}) as Record<string, any>)) {
    const id = normalizeSectionKey(rawKey);
    if (!id) { unknownSectionKeys.push(rawKey); continue; }
    const section = asked.get(id);
    if (!section || !v || typeof v !== "object") continue;
    const items: Record<string, SectionOutcome> = {};
    for (const it of section.items) { const o = v.items?.[it.id]; if (isOutcome(o)) items[it.id] = o; }
    const conflicts = Array.isArray(v.conflicts) ? v.conflicts.filter((c: any) => c && typeof c.item === "string" && Array.isArray(c.values)).map((c: any) => ({ item: String(c.item), values: c.values.filter((x: any) => x && typeof x.value === "string").map((x: any) => ({ value: String(x.value).slice(0, 300), chunkIds: Array.isArray(x.chunkIds) ? x.chunkIds.map(String).slice(0, 8) : [] })) })) : [];
    sectionOutcomes[section.id] = { status: isOutcome(v.status) ? v.status : "not_found", items, reviewedChunkIds: Array.isArray(v.reviewedChunkIds) ? v.reviewedChunkIds.map(String).slice(0, 128) : [], conflicts, reason: typeof v.reason === "string" ? v.reason.slice(0, 300) : null };
  }
  const claims: ExtractedClaimV3[] = [];
  for (const c of Array.isArray(j?.claims) ? j.claims : []) {
    if (!c || typeof c !== "object" || !(EVIDENCE_KINDS_V3 as readonly string[]).includes(c.kind) || !c.claim || typeof c.claim !== "object") continue;
    if (c.kind === "reputation_event" && !(REPUTATION_STAGES as readonly string[]).includes(String(c.claim.stage))) continue;   // an unstaged reputation claim is dropped, never a fact
    const cit = c.citation && Array.isArray(c.citation.chunkIds) && typeof c.citation.quote === "string" ? { chunkIds: c.citation.chunkIds.map(String).slice(0, 8), quote: String(c.citation.quote) } : null;
    claims.push({ kind: c.kind, claim: c.claim, citation: cit, confidence: typeof c.confidence === "number" ? c.confidence : undefined, publishedAt: typeof c.published_at === "string" && /^\d{4}-\d{2}-\d{2}/.test(c.published_at) ? c.published_at : null });
  }
  return { claims, inferences: [], aboutIdentityConfidence: typeof j?.about_identity_confidence === "number" ? j.about_identity_confidence : null, parseError: null, sectionOutcomes, unknownSectionKeys };
}

// ── degenerate detection (13 Sep 2026): an unusable extractor response is an infrastructure state, never an abstention ──
/** Chunk text below this is not "substantive evidence"; at or above it, a zero-claim extraction is degenerate. Harness constant, not a research parameter. */
export const SUBSTANTIVE_EVIDENCE_CHARS = 1500;

export interface DegenerateCheck { degenerate: boolean; reason: string | null }

export function degenerateReason(parsed: Pick<ParsedExtractionV3, "claims" | "aboutIdentityConfidence" | "parseError" | "sectionOutcomes" | "unknownSectionKeys">, envelopes: SearchEnvelope[], sections: Section[]): DegenerateCheck {
  const chars = envelopes.reduce((a, e) => a + e.chunks.reduce((b, c) => b + (c.text?.length ?? 0), 0), 0);
  const substantive = chars >= SUBSTANTIVE_EVIDENCE_CHARS;
  if (parsed.parseError) return { degenerate: true, reason: `malformed: ${parsed.parseError}` };
  const reported = Object.keys(parsed.sectionOutcomes).length;
  if (sections.length && reported === 0) return { degenerate: true, reason: parsed.unknownSectionKeys.length ? `no section outcome matched an exact alias (${parsed.unknownSectionKeys.slice(0, 3).join(" | ")})` : "no section_outcomes for any asked section" };
  const allItems = Object.values(parsed.sectionOutcomes).flatMap((o) => Object.values(o!.items));
  const allNotFound = allItems.length > 0 && allItems.every((x) => x === "not_found");
  if (parsed.claims.length === 0 && parsed.aboutIdentityConfidence === 0 && allNotFound) return { degenerate: true, reason: "template echo: zero claims, identity confidence exactly 0.0, every item not_found" };
  if (parsed.claims.length === 0 && substantive) return { degenerate: true, reason: `zero claims on substantive evidence (${chars} chars of chunk text)` };
  return { degenerate: false, reason: null };
}

// ── partitioned extraction: pure plan + merge ──
export interface Partition { queryId: string; queryName: string; sections: Section[]; envelopes: SearchEnvelope[] }

/** One partition per ResearchSpec query: that query's saved envelopes (matched by queryName) and its sections that are in scope. */
export function partitionPlan(envelopes: SearchEnvelope[], sections: Section[]): Partition[] {
  const asked = new Set(sections.map((s) => s.id));
  return QUERIES.map((q) => ({ queryId: q.id, queryName: q.name, sections: q.sections.filter((id) => asked.has(id)).map((id) => sections.find((s) => s.id === id)!), envelopes: envelopes.filter((e) => e.queryName === q.name) }));
}

export interface PartitionResult { queryId: string; queryName: string; sections: SectionId[]; envelopeIds: string[]; chunks: number; status: "ok" | "failed" | "degenerate" | "skipped"; reason: string | null; latencyMs: number | null; promptTokens: number | null; completionTokens: number | null; claims: number; parsed: ParsedExtractionV3 | null; raw: string | null; error: string | null }

export interface MergedExtraction { claims: ExtractedClaimV3[]; sectionOutcomes: Partial<Record<SectionId, ReportedSectionOutcome>>; aboutIdentityConfidence: number | null; identityConfidenceByPartition: Record<string, number | null>; unknownSectionKeys: string[]; partitionsOk: number; partitionsFailed: number; partitionsDegenerate: number; partitionsSkipped: number; /** sections whose partition failed or was degenerate: unknown, never an abstention */ sectionsUnavailable: SectionId[] }

/** Deterministic merge in query order: only OK partitions contribute (a failed or degenerate partition contributes no claims and no section outcome — its sections are unknown, never "not_found"); claims concatenated (chunk ids are already unique per envelope); each section reported by exactly one partition; identity confidence from the Q1 partition only when Q1 is ok, with every partition's value kept for the record. */
export function mergePartitions(results: PartitionResult[]): MergedExtraction {
  const ordered = [...results].sort((a, b) => a.queryId.localeCompare(b.queryId));
  const claims: ExtractedClaimV3[] = [];
  const sectionOutcomes: Partial<Record<SectionId, ReportedSectionOutcome>> = {};
  const identityConfidenceByPartition: Record<string, number | null> = {};
  const unknownSectionKeys: string[] = [];
  const sectionsUnavailable: SectionId[] = [];
  for (const r of ordered) {
    identityConfidenceByPartition[r.queryId] = r.parsed?.aboutIdentityConfidence ?? null;
    if (r.parsed) unknownSectionKeys.push(...r.parsed.unknownSectionKeys);
    if (r.status !== "ok" || !r.parsed) { if (r.status !== "skipped") sectionsUnavailable.push(...r.sections); continue; }
    claims.push(...r.parsed.claims);
    for (const id of r.sections) { const o = r.parsed.sectionOutcomes[id]; if (o && !(id in sectionOutcomes)) sectionOutcomes[id] = o; }
  }
  const q1 = ordered.find((r) => r.queryId === "Q1");
  return {
    claims, sectionOutcomes, aboutIdentityConfidence: q1?.status === "ok" ? q1.parsed?.aboutIdentityConfidence ?? null : null, identityConfidenceByPartition, unknownSectionKeys,
    partitionsOk: results.filter((r) => r.status === "ok").length, partitionsFailed: results.filter((r) => r.status === "failed").length, partitionsDegenerate: results.filter((r) => r.status === "degenerate").length, partitionsSkipped: results.filter((r) => r.status === "skipped").length,
    sectionsUnavailable,
  };
}


/** ARM-level degenerate rule (deterministic): the arm is degenerate when no partition succeeded, or when degenerate partitions
 *  are at least as many as successful ones AND the successful ones produced no claim at all. Otherwise the arm is usable and
 *  the degenerate partitions are listed (their sections unknown, eligible for partition-level re-extraction). */
export function armDegenerate(merged: MergedExtraction, results: Array<{ queryId: string; status: string; reason: string | null }>): { degenerate: boolean; reason: string | null } {
  const deg = results.filter((r) => r.status === "degenerate");
  const failed = results.some((r) => r.status === "failed");
  if (!deg.length || failed) return { degenerate: false, reason: null };
  const list = deg.map((r) => `${r.queryId}: ${r.reason}`).join("; ");
  if (merged.partitionsOk === 0 || (deg.length >= merged.partitionsOk && merged.claims.length === 0)) return { degenerate: true, reason: list };
  return { degenerate: false, reason: `partitions degenerate (sections unknown): ${list}` };
}

/** Rebuild the partition results of a SAVED partitioned extraction from its stored raw texts (deterministic re-parse, no call). */
export function rebuildPartitionsFromRaw(saved: Array<{ queryId: string; queryName: string; sections: SectionId[]; envelopeIds: string[]; chunks: number; status: string; reason: string | null; latencyMs: number | null; promptTokens: number | null; completionTokens: number | null; claims: number; raw: string | null; error: string | null }>, envelopes: SearchEnvelope[], sections: Section[]): PartitionResult[] {
  return saved.map((p) => {
    const secs = p.sections.map((id) => sections.find((s) => s.id === id)).filter((s): s is Section => !!s);
    if (p.raw == null || p.status === "skipped" || p.status === "failed") return { ...p, status: p.status as PartitionResult["status"], parsed: null };
    const parsed = parseCitedExtractionV3(p.raw, secs);
    const deg = degenerateReason(parsed, envelopes.filter((e) => p.envelopeIds.includes(e.id)), secs);
    return { ...p, status: deg.degenerate ? "degenerate" : "ok", reason: deg.reason, claims: parsed.claims.length, parsed };
  });
}

export const EXTRACTION_V3_REQUEST = (model: string, chunks: number, sections: Section[], mode: "single" | "partitioned" = "single") => ({ path: "chat.completions", params: { model, jsonMode: true, chunks, schemaVersion: CITED_CLAIMS_V3, sections: sections.map((s) => s.id), mode } });
