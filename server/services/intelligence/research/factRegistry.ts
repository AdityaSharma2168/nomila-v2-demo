/**
 * research/factRegistry.ts — the versioned Fact Registry (design §4.5, R8).
 *
 * The single source of truth for what a fact key IS: its value schema (zod, allow-listed
 * keys), cardinality, normalizer (the grouping / search form), resolver, freshness family,
 * whether the Signal Engine may consume it, whether a dispute on it blocks completeness, and
 * how the Record screen labels it. Nothing may write an athlete_facts row for a key that is
 * not here; every row is stamped with FACT_REGISTRY_VERSION.
 *
 * A new key or a changed schema/resolver bumps the version; older rows stay readable.
 *
 * v2 (Phase A Step 4, design step4-research-architecture-simplification.md §4, approved 13 Sep 2026):
 *   - `award`/`achievement`: `level` optional and nullable (the source often does not state it; Nomila may derive it
 *     later from the awarding body by lookup, never the provider); enum gains `pro` (professional leagues);
 *   - `national_team_participation`: `team` optional (the item itself establishes the national programme; `level` and
 *     `year` stay required so an omission is only accepted when the record is otherwise unambiguous); optional `event`/`result`;
 *   - new keys `endorsement` (commercial relationship; never commercial proof), `season_statistic` (context only) and
 *     `birth_year` (year only; the minor-policy input — item-mapping/1 already mapped to it).
 *   Every v1 value remains valid under v2 (tested); no relaxation adds meaning or infers a missing value.
 *
 * v3 (Concept 0.4 B1 — "What Nomila Knows" reads canonical Knowledge, not raw evidence):
 *   - new key `education` (institution required; program/degree/level/status/years optional) — a degree the research states
 *     lands as a fact only with an institution the item states or the same finding names (bound by persist, never invented);
 *   - `affiliation` gains optional `roleSince` / `roleSeason` beside the existing free-text `role` (captaincy from an
 *     official team/school or governing-body source); the normalizer is unchanged, so a role never splits an affiliation;
 *   - `national_team_participation` unchanged: `year` stays required (item-mapping/4 may take it from one explicit year in the finding).
 *   Every v2 value remains valid under v3 (tested).
 */

import { z } from "zod";
import type { FreshnessFamily, ResearchDomain } from "./registries";

export const FACT_REGISTRY_VERSION = "v3";

export type Cardinality = "single" | "multi" | "dated_multi";
export type ResolverKind = "authority_default" | "affiliation" | "dated_event" | "identity_signal";

export interface FactDefinition {
  key: string;
  schema: z.ZodTypeAny;
  cardinality: Cardinality;
  /** Canonical text for value_text: grouping key and search form. */
  normalizer: (value: any) => string;
  resolver: ResolverKind;
  freshnessFamily: FreshnessFamily;
  domain: ResearchDomain;
  scoring: { eligible: boolean; dimension?: string; note?: string };
  /** A dispute on this key holds the athlete at research_partial (R7). */
  blocking: boolean;
  display: { label: string; group: "identity" | "team" | "achievements" | "profile" | "commercial" };
}

const text = (max = 200) => z.string().trim().min(1).max(max);
const year = z.number().int().min(1900).max(2100);
/** Competition level as the source states it. v2 adds `pro`; `other` remains the only catch-all and unknown words are refused. */
export const LEVELS = ["international", "national", "conference", "regional", "school", "club", "pro", "other"] as const;
const LEVEL = z.enum(LEVELS);
export const DEAL_TYPES = ["sponsorship", "endorsement", "nil_deal", "collaboration", "ambassador", "other"] as const;

/** Lower-case, diacritics stripped, whitespace collapsed. */
export function normalizeText(v: unknown): string {
  return String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
/** Parenthesised abbreviation wins ("Atlantic Coast Conference (ACC)" → "acc"); else the normalized text. */
export function normalizeConference(v: unknown): string {
  const s = String(v ?? "");
  const m = /\(([A-Za-z0-9-]{2,12})\)\s*$/.exec(s);
  return normalizeText(m ? m[1] : s);
}

export const EDUCATION_LEVELS = ["high_school", "undergraduate", "graduate", "other"] as const;
const EDUCATION_VALUE = z.object({
  institution: text(160), program: text(160).nullable().optional(), degree: text(160).nullable().optional(), level: z.enum(EDUCATION_LEVELS).nullable().optional(),
  status: z.enum(["enrolled", "completed"]).nullable().optional(), startYear: year.nullable().optional(), endYear: year.nullable().optional(),
}).strict();

const AFFILIATION_VALUE = z.object({
  org: text(160), orgKind: z.enum(["school", "club", "pro", "national", "olympic"]), level: text(40).nullable().optional(),
  conference: text(120).nullable().optional(), role: text(80).nullable().optional(), position: text(80).nullable().optional(),
  roleSince: z.string().max(10).nullable().optional(), roleSeason: year.nullable().optional(),
  season: year.nullable().optional(), from: z.string().max(10).nullable().optional(), to: z.string().max(10).nullable().optional(),
  primary: z.boolean().optional(),
}).strict();

export const FACT_REGISTRY: Record<string, FactDefinition> = {
  name:            { key: "name", schema: z.object({ full: text(160), first: text(80).optional(), last: text(80).optional() }).strict(), cardinality: "single", normalizer: (v) => normalizeText(v.full), resolver: "authority_default", freshnessFamily: "identity", domain: "identity", scoring: { eligible: false }, blocking: true, display: { label: "Name", group: "identity" } },
  alias:           { key: "alias", schema: z.object({ text: text(120), kind: z.enum(["nickname", "maiden", "transliteration", "handle_name", "other"]) }).strict(), cardinality: "multi", normalizer: (v) => normalizeText(v.text), resolver: "authority_default", freshnessFamily: "identity", domain: "identity", scoring: { eligible: false }, blocking: false, display: { label: "Also known as", group: "identity" } },
  sport:           { key: "sport", schema: z.object({ sport: text(80), discipline: text(80).nullable().optional() }).strict(), cardinality: "multi", normalizer: (v) => normalizeText(v.sport), resolver: "authority_default", freshnessFamily: "identity", domain: "identity", scoring: { eligible: true, dimension: "athletic_authority", note: "cohort selection" }, blocking: true, display: { label: "Sport", group: "identity" } },
  position:        { key: "position", schema: z.object({ text: text(80) }).strict(), cardinality: "single", normalizer: (v) => normalizeText(v.text), resolver: "authority_default", freshnessFamily: "affiliations", domain: "profile", scoring: { eligible: false }, blocking: false, display: { label: "Position", group: "profile" } },
  event:           { key: "event", schema: z.object({ text: text(80) }).strict(), cardinality: "multi", normalizer: (v) => normalizeText(v.text), resolver: "authority_default", freshnessFamily: "affiliations", domain: "profile", scoring: { eligible: false }, blocking: false, display: { label: "Event", group: "profile" } },
  class_year:      { key: "class_year", schema: z.object({ label: text(60), season: year }).strict(), cardinality: "single", normalizer: (v) => `${normalizeText(v.label)} ${v.season}`, resolver: "authority_default", freshnessFamily: "affiliations", domain: "profile", scoring: { eligible: false }, blocking: false, display: { label: "Class year", group: "profile" } },
  graduation_year: { key: "graduation_year", schema: z.object({ year }).strict(), cardinality: "single", normalizer: (v) => String(v.year), resolver: "authority_default", freshnessFamily: "affiliations", domain: "profile", scoring: { eligible: true, dimension: "athletic_authority", note: "career stage" }, blocking: false, display: { label: "Graduation year", group: "profile" } },
  hometown:        { key: "hometown", schema: z.object({ city: text(80).nullable().optional(), region: text(80).nullable().optional(), country: text(80).nullable().optional() }).strict(), cardinality: "single", normalizer: (v) => normalizeText([v.city, v.region, v.country].filter(Boolean).join(" ")), resolver: "authority_default", freshnessFamily: "identity", domain: "identity", scoring: { eligible: false }, blocking: false, display: { label: "Hometown", group: "identity" } },
  nationality:     { key: "nationality", schema: z.object({ country: text(80) }).strict(), cardinality: "multi", normalizer: (v) => normalizeText(v.country), resolver: "authority_default", freshnessFamily: "identity", domain: "identity", scoring: { eligible: false }, blocking: false, display: { label: "Nationality", group: "identity" } },
  career_status:   { key: "career_status", schema: z.object({ status: z.enum(["active", "between_teams", "out_this_season", "retired"]) }).strict(), cardinality: "single", normalizer: (v) => v.status, resolver: "authority_default", freshnessFamily: "affiliations", domain: "affiliations", scoring: { eligible: true, dimension: "momentum", note: "gating" }, blocking: false, display: { label: "Career status", group: "team" } },
  affiliation:     { key: "affiliation", schema: AFFILIATION_VALUE, cardinality: "dated_multi", normalizer: (v) => `${normalizeText(v.org)} ${v.orgKind} ${v.season ?? v.from ?? ""}`.trim(), resolver: "affiliation", freshnessFamily: "affiliations", domain: "affiliations", scoring: { eligible: true, dimension: "athletic_authority", note: "competition level" }, blocking: true, display: { label: "Team", group: "team" } },
  achievement:     { key: "achievement", schema: z.object({ name: text(200), year: year.nullable().optional(), date: z.string().max(10).nullable().optional(), level: LEVEL.nullable().optional(), org: text(160).nullable().optional() }).strict(), cardinality: "dated_multi", normalizer: (v) => `${normalizeText(v.name)} ${v.year ?? v.date ?? ""}`.trim(), resolver: "dated_event", freshnessFamily: "achievements", domain: "achievements", scoring: { eligible: true, dimension: "athletic_authority" }, blocking: false, display: { label: "Achievement", group: "achievements" } },
  award:           { key: "award", schema: z.object({ name: text(200), year, org: text(160).nullable().optional(), level: LEVEL.nullable().optional() }).strict(), cardinality: "dated_multi", normalizer: (v) => `${normalizeText(v.name)} ${v.year}`, resolver: "dated_event", freshnessFamily: "achievements", domain: "achievements", scoring: { eligible: true, dimension: "athletic_authority" }, blocking: false, display: { label: "Award", group: "achievements" } },
  ranking:         { key: "ranking", schema: z.object({ body: text(120), rank: z.number().int().min(1), year, scope: text(80) }).strict(), cardinality: "dated_multi", normalizer: (v) => `${normalizeText(v.body)} ${normalizeText(v.scope)} ${v.year}`, resolver: "dated_event", freshnessFamily: "achievements", domain: "achievements", scoring: { eligible: true, dimension: "athletic_authority" }, blocking: false, display: { label: "Ranking", group: "achievements" } },
  national_team_participation: { key: "national_team_participation", schema: z.object({ team: text(120).nullable().optional(), level: text(40), year, role: text(80).nullable().optional(), event: text(160).nullable().optional(), result: text(120).nullable().optional() }).strict(), cardinality: "dated_multi", normalizer: (v) => `${normalizeText(v.team ?? "")} ${normalizeText(v.level)} ${v.year} ${normalizeText(v.event ?? "")}`.replace(/\s+/g, " ").trim(), resolver: "dated_event", freshnessFamily: "achievements", domain: "achievements", scoring: { eligible: true, dimension: "athletic_authority" }, blocking: false, display: { label: "National team", group: "achievements" } },
  nil_mention:     { key: "nil_mention", schema: z.object({ source: text(160), value: text(80), year: year.nullable().optional() }).strict(), cardinality: "dated_multi", normalizer: (v) => `${normalizeText(v.source)} ${normalizeText(v.value)}`, resolver: "dated_event", freshnessFamily: "brand_mentions", domain: "brand_mentions", scoring: { eligible: false, note: "never commercial_proof" }, blocking: false, display: { label: "NIL valuation mention", group: "commercial" } },
  // ── v2 additions ──
  birth_year:      { key: "birth_year", schema: z.object({ year }).strict(), cardinality: "single", normalizer: (v) => String(v.year), resolver: "authority_default", freshnessFamily: "identity", domain: "identity", scoring: { eligible: false, note: "minor-policy input only (year, never a date); never a scoring input" }, blocking: false, display: { label: "Birth year", group: "identity" } },
  endorsement:     { key: "endorsement", schema: z.object({ brand: text(160), dealType: z.enum(DEAL_TYPES), category: text(80).nullable().optional(), startDate: z.string().max(10).nullable().optional(), endDate: z.string().max(10).nullable().optional(), campaign: text(160).nullable().optional() }).strict(), cardinality: "dated_multi", normalizer: (v) => `${normalizeText(v.brand)} ${v.dealType} ${v.startDate ?? ""}`.trim(), resolver: "dated_event", freshnessFamily: "brand_mentions", domain: "brand_mentions", scoring: { eligible: false, note: "researched commercial relationship; commercial proof stays separate (connected/verified sources only)" }, blocking: false, display: { label: "Brand partnership", group: "commercial" } },
  // ── v3 additions ──
  education:       { key: "education", schema: EDUCATION_VALUE, cardinality: "multi", normalizer: (v) => `${normalizeText(v.institution)} ${normalizeText(v.degree ?? v.program ?? "")}`.trim(), resolver: "authority_default", freshnessFamily: "affiliations", domain: "profile", scoring: { eligible: false }, blocking: false, display: { label: "Education", group: "profile" } },
  season_statistic: { key: "season_statistic", schema: z.object({ metric: text(80), value: text(40), season: year, competition: text(120).nullable().optional() }).strict(), cardinality: "dated_multi", normalizer: (v) => `${normalizeText(v.metric)} ${v.season} ${normalizeText(v.competition ?? "")}`.trim(), resolver: "dated_event", freshnessFamily: "achievements", domain: "achievements", scoring: { eligible: false, note: "context and generation only; never a scoring input" }, blocking: false, display: { label: "Season statistic", group: "achievements" } },
};

export class RegistryError extends Error { constructor(m: string) { super(`fact_registry: ${m}`); this.name = "RegistryError"; } }

export function isRegisteredKey(key: string): boolean { return Object.prototype.hasOwnProperty.call(FACT_REGISTRY, key); }
export function getFactDefinition(key: string): FactDefinition {
  if (!isRegisteredKey(key)) throw new RegistryError(`unknown fact key "${key}" (registry ${FACT_REGISTRY_VERSION})`);
  return FACT_REGISTRY[key];
}
/** Parse a value against the key's schema; throws RegistryError with the zod issues. */
export function validateFactValue<T = any>(key: string, value: unknown): T {
  const def = getFactDefinition(key);
  const r = def.schema.safeParse(value);
  if (!r.success) throw new RegistryError(`${key}: ${r.error.issues.map((i) => `${i.path.join(".") || "value"} ${i.message}`).join("; ")}`);
  return r.data as T;
}
export function valueTextFor(key: string, value: any): string { return getFactDefinition(key).normalizer(value); }
export const BLOCKING_KEYS = Object.values(FACT_REGISTRY).filter((d) => d.blocking).map((d) => d.key);
