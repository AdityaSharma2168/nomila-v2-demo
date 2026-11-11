/**
 * research/spec/canonicalize.ts — `claim-canonicalization/2`: deterministic, closed, schema-preserving
 * transformations between a parsed claim (cited-claims/3 or item-mapping) and the STRICT fact registry.
 *
 * /2 (registry v2, design §4): a whole value that is a JSON string is parsed when (and only when) it parses to an object;
 * an affiliation `seasons`/`years` range "YYYY-YYYY" splits into `from`/`to` when neither is present; closed aliases for
 * the new `pro` level and the `endorsement.dealType` enum; field aliases for the v2 keys. Idempotent: applying the
 * function to its own output changes nothing (tested).
 *
 * Only these kinds of rule exist: explicit unambiguous field aliases, closed enum alias tables, safe
 * season/year representations, removal of known non-semantic extra keys. A rule can never infer a
 * missing value, invent a fact, resolve an ambiguity, or strengthen a claim; anything a rule cannot
 * safely handle is left for the registry to refuse. Every application is recorded (rule id, raw value,
 * canonical value) so the provenance shows what was changed. Pure.
 */

export const CANONICALIZATION_VERSION = "claim-canonicalization/2";

export interface CanonicalizationResult { value: unknown; raw: unknown; applied: string[]; version: string }

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Keys the extractor habitually adds inside `value` that carry no meaning for the fact itself (provenance, prose, repeats of claim-level fields). Closed. */
const NON_SEMANTIC_KEYS = ["source", "sources", "sourceUrl", "url", "note", "notes", "confidence", "citation", "quote", "evidence", "context", "description", "asOf", "publishedAt", "published_at", "verified"];

/** Enum alias tables — closed, lower-cased exact matches after trimming. */
const LEVEL_ALIASES: Record<string, string> = {
  international: "international", world: "international", olympic: "international", olympics: "international", global: "international", continental: "international",
  national: "national", country: "national", "all-american": "national", "all american": "national",
  conference: "conference", league: "conference", "all-conference": "conference",
  regional: "regional", state: "regional", provincial: "regional", district: "regional", local: "regional",
  school: "school", college: "school", university: "school", collegiate: "school", "high school": "school", varsity: "school",
  club: "club", team: "club",
  pro: "pro", professional: "pro", "pro league": "pro", "professional league": "pro",
  other: "other",
};
const DEAL_TYPE_ALIASES: Record<string, string> = {
  sponsorship: "sponsorship", sponsor: "sponsorship", sponsored: "sponsorship", partnership: "sponsorship", partner: "sponsorship",
  endorsement: "endorsement", endorsed: "endorsement", endorser: "endorsement",
  nil_deal: "nil_deal", nil: "nil_deal", "nil deal": "nil_deal", "name, image and likeness": "nil_deal",
  collaboration: "collaboration", collab: "collaboration", "collaboration line": "collaboration",
  ambassador: "ambassador", "brand ambassador": "ambassador", ambassadorship: "ambassador",
  other: "other",
};
const ORG_KIND_ALIASES: Record<string, string> = {
  school: "school", university: "school", college: "school", "high school": "school", highschool: "school", academy: "school", collegiate: "school",
  club: "club", "youth club": "club", "club team": "club",
  pro: "pro", professional: "pro", "pro team": "pro", "professional team": "pro", franchise: "pro", team: "pro", league: "pro",
  national: "national", "national team": "national", "national_team": "national", country: "national",
  olympic: "olympic", olympics: "olympic", "olympic team": "olympic",
};
const CAREER_STATUS_ALIASES: Record<string, string> = {
  active: "active", playing: "active", current: "active", signed: "active",
  retired: "retired", retirement: "retired",
  out_this_season: "out_this_season", "out this season": "out_this_season", injured: "out_this_season", "out for season": "out_this_season", "out for the season": "out_this_season", "season-ending injury": "out_this_season",
  between_teams: "between_teams", "between teams": "between_teams", "free agent": "between_teams", unsigned: "between_teams", unattached: "between_teams", "without a club": "between_teams",
};
const ALIAS_KIND_ALIASES: Record<string, string> = { nickname: "nickname", nick: "nickname", maiden: "maiden", "maiden name": "maiden", transliteration: "transliteration", handle_name: "handle_name", "handle name": "handle_name", handle: "handle_name", other: "other" };

/** A season/year that is unambiguously a single four-digit year: 2026, "2026", "2025-26" → 2025 (the season's first year), "2025/2026" → 2025. */
function canonicalYear(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 1900 && v <= 2100) return v;
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = /^(\d{4})$/.exec(s); if (m) return Number(m[1]);
  // "2025-26" / "2025/2026": one season spanning two calendar years → its first year. "2024-2026" (a range of seasons) is ambiguous → null.
  m = /^(\d{4})\s*[-–/]\s*(\d{2}|\d{4})$/.exec(s);
  if (m) { const a = Number(m[1]); const b = m[2].length === 2 ? Math.floor(a / 100) * 100 + Number(m[2]) : Number(m[2]); return b === a + 1 ? a : null; }
  m = /^(\d{4})-\d{2}-\d{2}$/.exec(s); if (m) return Number(m[1]);
  return null;
}

/** Field alias tables per fact key: extractor field → registry field (unambiguous only). */
const FIELD_ALIASES: Record<string, Record<string, string>> = {
  name: { name: "full", full_name: "full", fullName: "full", firstName: "first", first_name: "first", lastName: "last", last_name: "last" },
  alias: { name: "text", alias: "text", value: "text", type: "kind" },
  sport: { name: "sport", text: "sport", event: "discipline" },
  position: { position: "text", name: "text", role: "text", value: "text" },
  event: { event: "text", name: "text", value: "text" },
  class_year: { classYear: "label", class_year: "label", year_label: "label", class: "label", year: "season" },
  graduation_year: { graduationYear: "year", graduation_year: "year", grad_year: "year", value: "year" },
  hometown: { town: "city", state: "region", province: "region", nation: "country" },
  nationality: { nationality: "country", text: "country", name: "country", value: "country" },
  career_status: { value: "status", text: "status", careerStatus: "status" },
  affiliation: { team: "org", organization: "org", organisation: "org", name: "org", club: "org", school: "org", kind: "orgKind", type: "orgKind", org_kind: "orgKind", year: "season", league: "conference", start: "from", end: "to", startDate: "from", endDate: "to" },
  achievement: { title: "name", achievement: "name", text: "name", season: "year", organization: "org", body: "org" },
  award: { title: "name", award: "name", text: "name", season: "year", organization: "org", body: "org", awardedBy: "org" },
  ranking: { rankingBody: "body", organization: "org_unused", ranker: "body", position: "rank", rank_value: "rank", season: "year", category: "scope", list: "scope" },
  national_team_participation: { programme: "team", program: "team", squad: "team", national_team: "team", nationalTeam: "team", ageGroup: "level", age_group: "level", season: "year", position: "role" },
  nil_mention: { estimator: "source", valuationSource: "source", valuation_source: "source", body: "source", valuation: "value", amount: "value", estimate: "value", season: "year" },
  // v2 keys
  birth_year: { birthYear: "year", birth_year: "year", born: "year", value: "year" },
  endorsement: { brand_name: "brand", brandName: "brand", company: "brand", deal_type: "dealType", type: "dealType", kind: "dealType", start: "startDate", start_date: "startDate", from: "startDate", end: "endDate", end_date: "endDate", to: "endDate", campaign_name: "campaign", campaignName: "campaign" },
  season_statistic: { stat: "metric", statistic: "metric", name: "metric", metric_name: "metric", year: "season", league: "competition", tournament: "competition" },
};

/** Value fields that must be a registry year. */
const YEAR_FIELDS: Record<string, string[]> = { class_year: ["season"], graduation_year: ["year"], affiliation: ["season"], achievement: ["year"], award: ["year"], ranking: ["year"], national_team_participation: ["year"], nil_mention: ["year"], birth_year: ["year"], season_statistic: ["season"] };
const ENUM_FIELDS: Record<string, Record<string, Record<string, string>>> = {
  affiliation: { orgKind: ORG_KIND_ALIASES },
  achievement: { level: LEVEL_ALIASES },
  award: { level: LEVEL_ALIASES },
  career_status: { status: CAREER_STATUS_ALIASES },
  alias: { kind: ALIAS_KIND_ALIASES },
  endorsement: { dealType: DEAL_TYPE_ALIASES },
};

/** /2: a whole value given as a JSON string is parsed only when it parses to a plain object; anything else is left as is. */
function parseJsonObject(raw: unknown): Obj | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t.startsWith("{")) return null;
  try { const p: unknown = JSON.parse(t); return isObj(p) ? p : null; } catch { return null; }
}

/** Canonicalize one fact-bearing claim's `value` for `factKey`. Non-object values and unknown keys pass through untouched. */
export function canonicalizeValue(factKey: string, raw: unknown): CanonicalizationResult {
  const applied: string[] = [];
  const parsed = parseJsonObject(raw);
  if (parsed) applied.push("json:parse");
  const source = parsed ?? raw;
  if (!isObj(source)) return { value: raw, raw, applied: [], version: CANONICALIZATION_VERSION };
  let v: Obj = { ...source };

  // 0. /2: an affiliation tenure "YYYY-YYYY" splits into from/to only when neither is present (a single season is handled by the year rule)
  if (factKey === "affiliation" && !("from" in v) && !("to" in v)) {
    for (const k of ["seasons", "years", "tenure", "period"]) {
      const m = typeof v[k] === "string" ? /^(\d{4})\s*[-\u2013]\s*(\d{4})$/.exec((v[k] as string).trim()) : null;
      if (m && Number(m[2]) >= Number(m[1])) { v.from = m[1]; v.to = m[2]; delete v[k]; applied.push(`seasons:${k}:${JSON.stringify(m[0])}->from/to`); break; }
    }
  }

  // 1. field aliases (only when the canonical field is absent, so nothing is overwritten)
  const aliases = FIELD_ALIASES[factKey] ?? {};
  for (const [from, to] of Object.entries(aliases)) {
    if (from in v && !(to in v) && !to.endsWith("_unused")) { v[to] = v[from]; delete v[from]; applied.push(`alias:${from}->${to}`); }
  }

  // 2. closed enum aliases
  for (const [field, table] of Object.entries(ENUM_FIELDS[factKey] ?? {})) {
    const s = str(v[field]);
    if (s != null) { const c = table[s.toLowerCase()]; if (c && c !== s) { v[field] = c; applied.push(`enum:${field}:${s}->${c}`); } }
  }

  // 3. year / season representations
  for (const field of YEAR_FIELDS[factKey] ?? []) {
    if (!(field in v) || v[field] == null) continue;
    const y = canonicalYear(v[field]);
    if (y != null && v[field] !== y) { applied.push(`year:${field}:${JSON.stringify(v[field])}->${y}`); v[field] = y; }
  }
  // ranking.rank: "#3" / "3rd" / "3" → 3
  if (factKey === "ranking" && typeof v.rank === "string") { const m = /^#?\s*(\d{1,4})(?:st|nd|rd|th)?$/i.exec(v.rank.trim()); if (m) { applied.push(`rank:${JSON.stringify(v.rank)}->${m[1]}`); v.rank = Number(m[1]); } }

  // 4. known non-semantic extra keys
  for (const k of NON_SEMANTIC_KEYS) if (k in v) { delete v[k]; applied.push(`drop:${k}`); }

  // 5. key-specific descriptive keys the extractor carries into the wrong value (closed list; removing them cannot change the fact)
  const DROP: Record<string, string[]> = {
    sport: ["level", "league", "team", "position", "gender", "country"],
    nationality: ["city", "region"],
    hometown: ["text"],   // a free-text location is refused, not parsed
    name: ["nickname", "aliases"],
    position: ["team", "sport"],
    class_year: ["school", "org"],
    graduation_year: ["school", "org"],
    career_status: ["date", "asOf", "team"],
    achievement: ["team", "sport", "category"],
    award: ["team", "sport", "category"],
    ranking: ["org_unused", "organization"],
    national_team_participation: ["sport", "tournament"],
    nil_mention: ["currency"],
  };
  for (const k of DROP[factKey] ?? []) if (k in v) { delete v[k]; applied.push(`drop:${k}`); }

  // A drop may never turn a non-empty value into an empty one (the registry would accept {} for an all-optional shape): leave it for refusal.
  if (Object.keys(v).length === 0 && Object.keys(source).length > 0) return { value: raw, raw, applied: [], version: CANONICALIZATION_VERSION };
  return { value: v, raw, applied, version: CANONICALIZATION_VERSION };
}
