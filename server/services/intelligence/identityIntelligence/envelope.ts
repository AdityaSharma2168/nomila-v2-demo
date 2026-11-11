/**
 * envelope.ts — gather one athlete's candidate material, tier it, rank it and lay it out in the contract's input
 * sections A–I, deterministically (Identity Intelligence 0.2, contract §3).
 *
 * READ FROM (and only from):
 *   athlete_facts        current / historical (Established); disputed (Unconfirmed)
 *   research_evidence    non-suspect, not superseded; tier from lineage + source type (claims.ts). `athlete_statement`
 *                        rows reach the envelope only through athleteStatements() (HER WORDS)
 *   athlete_asserted     live rows: identity content (Established, athlete authority), her direction, voice and
 *                        never-post lists, and her governance (directives, denials, confirmations, approved statements)
 *   objectives           live (active, she said yes) — HER DIRECTION, verbatim
 *   athleteStatements()  HER WORDS: her_own (captions, bios, said) and source_read (the targeted read's verbatim quotes)
 *   athlete_snapshots    First Look, the LATEST snapshot PER PLATFORM — NEVER the `research` blob
 *   social_features      connected / platform-public audience measurements (Established)
 *   deals                earned (accepted / completed) commercial records (Established), with any exclusivity
 *   intelligence_ledger  the latest marketability row, COMPACT ONLY: the dimension conclusions (direction) and the key
 *                        strengths / constraints strings — salience only, never content
 *
 * EXCLUDED BY CONSTRUCTION (nothing here reads them): athletes_current (story_arc), media_kits,
 * brand_fit_narratives, athlete_snapshots.research (the legacy blob), athlete_affiliations (found rows without a
 * fact_id are legacy; the rest are already facts or her own `affiliations` assertion), M.I.A. prose (summary,
 * rationale paragraphs) and citations. Unconfirmed items are never shown to the model (only open questions).
 *
 * Sections (contract §3; alias prefixes in contract.ts SECTION_PREFIX):
 *   A ESTABLISHED  E1…  ·  B REPORTED  R1…  ·  C HER WORDS  W1…  ·  D HER DIRECTION  D1…  ·  E HER DIRECTIVES (text)
 *   F SELF-PRESENTATION  S1…  ·  G MEASURED AUDIENCE  M1…  ·  H MARKETABILITY CONTEXT  H1…  ·  I PRE-ASSEMBLED  P1…
 * The rules parts (compose.ts composeRules) are computed here, BEFORE the call; proof points and signature moments
 * become section I and are cited, never rewritten.
 *
 * inputVersion = sha256 of the canonical envelope (items with their sections, statements, First Look, directives,
 * governance, the raw values the rules parts read, the M.I.A. compact) plus the contract/policy/prompt versions.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../../db";
import {
  athleteAsserted, athleteFacts, athleteSnapshots, deals, intelligenceLedger, researchEvidence, socialFeatures,
} from "../../../../shared/schema";
import { ASSERTED_FIELDS, displayAssertedValue, fromLedgerValue, type AssertedField, type AssertedFieldSpec } from "../../../mila/onboarding";
import type { FirstLook } from "../../../skills/firstLook";
import { canonicalJson } from "../params";
import { FACT_REGISTRY, isRegisteredKey, valueTextFor } from "../research/factRegistry";
import { liveObjectives } from "../objective/store";
import { findingsFromMia } from "../state/build";
import { assessClaims, normaliseText, sourceTierOfEvidence, sourceTierOfFact, type AthleteVerdicts } from "./claims";
import { IDENTITY_ADMISSIBILITY, IDENTITY_ENVELOPE, IDENTITY_SALIENCE, IDENTITY_STATEMENTS, IDENTITY_SUFFICIENCY } from "./config";
import {
  IDENTITY_ADMISSIBILITY_POLICY, IDENTITY_INTELLIGENCE_CONTRACT, IDENTITY_SYNTHESIS_PROMPT, parseBasisRef, refKey,
  type ApprovedStatement, type BasisItem, type BasisRef, type ClaimAssessment, type IdentityDirectives, type IdentityRulesParts,
} from "./contract";
import { composeRules } from "./compose";
import { IDENTITY_LIST_FIELDS } from "./governance";
import { gatherStatements, selectStatements, type AthleteStatement } from "./statements";

type Db = typeof db;

export interface FirstLookEntry {
  snapshotId: string; platform: string; themes: string[]; tone: string[];
  interests: string[]; recurringPhrases: string[]; causesMentioned: string[]; computedAt: string | null;
}
export interface AudienceRow { key: string; platform: string; feature: string; value: number | null; json: unknown; asOf: string | null }
export interface MiaCompact { entryId: string; dimensions: Array<{ key: string; direction: string }>; strengths: string[]; constraints: string[] }

export interface IdentityEnvelope {
  athleteId: string;
  items: BasisItem[];
  claims: ClaimAssessment[];
  directives: IdentityDirectives;
  approvedStatements: Array<ApprovedStatement & { assertionId: string }>;
  verdicts: AthleteVerdicts;
  /** Disputes naming a knowledge entry id rather than a basis ref — kept for unresolved[], never matched by text. */
  entryDisputes: Array<{ assertionId: string; entryId: string; said: string | null }>;
  objectives: Array<{ id: string; value: string; athleteAuthored: boolean; domain: string }>;
  /** Her `direction` assertion — how she wants to be understood, verbatim. */
  howToBeUnderstood: { assertionId: string; value: string; said: string | null } | null;
  firstLooks: FirstLookEntry[];
  /** HER WORDS, ranked and capped (athleteStatements()). */
  statements: AthleteStatement[];
  /** Raw values the rules parts read. */
  facts: Array<{ id: string; key: string; value: unknown; status: string }>;
  evidence: Array<{ id: string; kind: string; claim: Record<string, unknown> }>;
  asserted: Record<string, { id: string; raw: unknown }>;
  deals: Array<{ id: string; brand: string; dealType: string | null; exclusivity: string | null }>;
  audience: AudienceRow[];
  mia: MiaCompact | null;
  /** The marketability ledger row read for salience, if any. */
  miaEntryId: string | null;
  /** The (a)/(b) parts, computed before the call. */
  rules: IdentityRulesParts;
  evidenceAsOf: string;
  inputVersion: string;
}
export type EnvelopeCore = Omit<IdentityEnvelope, "rules" | "evidenceAsOf" | "inputVersion">;

/** Asserted fields that say something about who she is (identity content). Governance and style fields are not content. */
const CONTENT_ASSERTED_FIELDS: readonly string[] = [
  "position", "class_year", "hometown", "sport", "school", "affiliations", "career_status", "nickname", "note",
  "brands_causes", "hobbies", "direction",
];
/** Asserted fields the rules parts read but that are not content items. */
const RULE_ASSERTED_FIELDS: readonly string[] = ["brand_voice", "never_post"];
/** Evidence kinds that never describe who she is (identity plumbing, sentiment, handles) — and her statements, which
 *  arrive through athleteStatements() only. */
const NON_CONTENT_EVIDENCE_KINDS: readonly string[] = ["identity_signal", "social_handle", "signal", "sentiment", "media_asset", "research_finding", "athlete_statement"];
/** Facts never shown to the model: her name (the model never names the athlete) and her birth year (minor policy). */
const NON_CONTENT_FACT_KEYS: readonly string[] = ["name", "birth_year"];
/** Fields read off a free-text evidence claim, in this order. The outlet is NOT text: it is the source (shown apart), so
 *  the same story from two outlets groups as one claim. */
const EVIDENCE_TEXT_FIELDS = ["headline", "event", "text", "statement", "name", "title", "brand", "campaign", "item"];
/** G. MEASURED AUDIENCE — the features read (numeric or json). */
export const AUDIENCE_FEATURES: readonly string[] = [
  "followers_latest", "engagement_per_follower_median", "audience_country_distribution", "audience_age_distribution", "audience_gender_share",
];

const cap = (s: string, n: number = IDENTITY_ENVELOPE.maxTextChars) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const strings = (xs: unknown, n: number, max = 80): string[] => (Array.isArray(xs) ? xs : []).filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().slice(0, max)).slice(0, n);

/** A readable line from a structured value: its primitive leaves, in order. */
export function renderValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return v.map(renderValue).filter(Boolean).join(", ");
  return Object.values(v as Record<string, unknown>).filter((x) => x != null && typeof x !== "object" && String(x).trim() !== "").map(String).join(", ");
}

const labelOf = (factKey: string) => (isRegisteredKey(factKey) ? FACT_REGISTRY[factKey].display.label : factKey.replace(/_/g, " "));

function factClaimKey(factKey: string, value: unknown, valueText?: string): string {
  if (valueText) return `fact:${factKey}:${valueText}`;
  try { return `fact:${factKey}:${valueTextFor(factKey, value)}`; } catch { return `fact:${factKey}:${normaliseText(renderValue(value))}`; }
}

function evidenceText(kind: string, claim: Record<string, unknown>): string {
  if (typeof claim.factKey === "string" && claim.value !== undefined) return `${labelOf(claim.factKey)}: ${renderValue(claim.value)}`;
  const parts = EVIDENCE_TEXT_FIELDS.map((f) => claim[f]).filter((x): x is string => typeof x === "string" && x.trim() !== "");
  return parts.length ? parts.join(" — ") : `${kind.replace(/_/g, " ")}: ${renderValue(claim)}`;
}

const item = (ref: BasisRef, text: string, sourceTier: BasisItem["sourceTier"], extra: Partial<BasisItem> = {}, max?: number): BasisItem => ({
  key: refKey(ref), ref, text: cap(text.replace(/\s+/g, " ").trim(), max), sourceTier, tier: sourceTier, claimKey: null,
  athleteAuthority: false, athleticIdentity: false, asOf: null, salience: 0, ...extra,
});

/** One audience row as a readable line. */
export function audienceText(platform: string, feature: string, value: number | null, json: unknown): string {
  const buckets = (Array.isArray(json) ? json : []).slice(0, IDENTITY_ENVELOPE.maxAudienceBuckets)
    .map((r: any) => `${String(r?.bucket ?? "?")}${typeof r?.pct === "number" ? ` ${Math.round(r.pct)}%` : ""}`).join(", ");
  switch (feature) {
    case "followers_latest": return `${platform} followers: ${value}`;
    case "engagement_per_follower_median": return `${platform} engagement per follower (median): ${value}`;
    case "audience_country_distribution": return `${platform} audience, top geographies: ${buckets || "—"}`;
    case "audience_age_distribution": return `${platform} audience, top age groups: ${buckets || "—"}`;
    case "audience_gender_share": return `${platform} audience, gender: ${buckets || "—"}`;
    default: return `${platform} ${feature.replace(/_/g, " ")}: ${value ?? renderValue(json)}`;
  }
}

/** Gather, tier, group, rank, compose the rules parts, and assign sections. Deterministic for the same rows. */
export async function buildIdentityEnvelope(athleteId: string, now: Date = new Date(), dbx: Db = db): Promise<IdentityEnvelope> {
  const P = IDENTITY_ADMISSIBILITY;
  const flPlatform = sql`${athleteSnapshots.first_look}->>'platform'`;
  const [facts, evidence, asserted, objectives, statementPool, snapshots, features, earned, mia] = await Promise.all([
    dbx.select().from(athleteFacts).where(and(eq(athleteFacts.athlete_id, athleteId), inArray(athleteFacts.status, ["current", "historical", "disputed"]))),
    dbx.select().from(researchEvidence).where(and(eq(researchEvidence.athlete_id, athleteId), eq(researchEvidence.suspect, false), isNull(researchEvidence.superseded_by))),
    dbx.select().from(athleteAsserted).where(and(eq(athleteAsserted.athlete_id, athleteId), isNull(athleteAsserted.retracted_at), isNull(athleteAsserted.superseded_by))).orderBy(desc(athleteAsserted.created_at)),
    liveObjectives(dbx as any, athleteId),
    gatherStatements(athleteId, now, dbx),
    // The LATEST First Look per platform (not the newest N rows): one row per platform, newest first within it.
    dbx.selectDistinctOn([flPlatform], { id: athleteSnapshots.id, first_look: athleteSnapshots.first_look, created_at: athleteSnapshots.created_at }).from(athleteSnapshots)
      .where(and(eq(athleteSnapshots.athlete_id, athleteId), sql`${athleteSnapshots.first_look} IS NOT NULL`, sql`${flPlatform} IS NOT NULL`))
      .orderBy(flPlatform, desc(athleteSnapshots.created_at), desc(athleteSnapshots.id)),
    dbx.select().from(socialFeatures).where(and(eq(socialFeatures.athlete_id, athleteId), inArray(socialFeatures.feature_key, [...AUDIENCE_FEATURES]),
      inArray(socialFeatures.source_class, [...P.establishedSocialSourceClasses]), eq(socialFeatures.imputed, false))).orderBy(desc(socialFeatures.as_of), desc(socialFeatures.id)),
    dbx.select({ id: deals.id, brand_name: deals.brand_name, deal_type: deals.deal_type, status: deals.status, detected_at: deals.detected_at, created_at: deals.created_at, raw_data: deals.raw_data }).from(deals)
      .where(and(eq(deals.athlete_id, athleteId), inArray(deals.status, [...P.earnedDealStatuses]))),
    dbx.select({ id: intelligenceLedger.id, value: intelligenceLedger.value, evidence_as_of: intelligenceLedger.evidence_as_of }).from(intelligenceLedger)
      .where(and(eq(intelligenceLedger.subject_id, athleteId), eq(intelligenceLedger.owner, "marketability"), eq(intelligenceLedger.kind, "ASSESSMENT"), isNull(intelligenceLedger.superseded_by)))
      .orderBy(desc(intelligenceLedger.created_at)).limit(1),
  ]);

  const items: BasisItem[] = [];

  // ── A/B canonical facts ──
  const factRows: IdentityEnvelope["facts"] = [];
  for (const f of facts) {
    if (NON_CONTENT_FACT_KEYS.includes(f.fact_key)) continue;
    const tier = sourceTierOfFact(f.status);
    const prov = (f.provenance ?? {}) as { domains?: string[] };
    factRows.push({ id: f.id, key: f.fact_key, value: f.value, status: f.status });
    items.push(item({ kind: "fact", id: f.id }, `${labelOf(f.fact_key)}: ${renderValue(f.value)}`, tier, {
      claimKey: factClaimKey(f.fact_key, f.value, f.value_text),
      athleteAuthority: f.origin === "athlete_asserted" || f.origin === "athlete_proof",
      athleticIdentity: IDENTITY_SUFFICIENCY.athleticFactKeys.includes(f.fact_key),
      asOf: iso(f.observed_at ?? f.retrieved_at),
      source: { status: f.status, domain: prov.domains?.[0] ?? null },
    }));
  }

  // ── A/B research evidence (her statements excluded: they come in through HER WORDS) ──
  const evidenceRows: IdentityEnvelope["evidence"] = [];
  for (const e of evidence) {
    if (NON_CONTENT_EVIDENCE_KINDS.includes(e.kind)) continue;
    const claim = (e.claim ?? {}) as Record<string, unknown>;
    const factKey = typeof claim.factKey === "string" ? claim.factKey : null;
    const text = evidenceText(e.kind, claim);
    evidenceRows.push({ id: e.id, kind: e.kind, claim });
    items.push(item({ kind: "evidence", id: e.id }, text, sourceTierOfEvidence({ lineage: e.lineage_status, sourceType: e.source_type, kind: e.kind }), {
      claimKey: factKey && claim.value !== undefined ? factClaimKey(factKey, claim.value) : `text:${normaliseText(text)}`,
      athleticIdentity: !!factKey && IDENTITY_SUFFICIENCY.athleticFactKeys.includes(factKey),
      asOf: iso(e.published_at ?? e.retrieved_at),
      source: { type: e.source_type, domain: e.source_domain, lineage: e.lineage_status, url: e.source_url },
    }));
  }

  // ── her assertions: content, direction, voice, governance, verdicts ──
  const directives: IdentityDirectives = { preferredEmphasis: [], deEmphasize: [], preferredLanguage: [], avoidLanguage: [] };
  const approvedStatements: IdentityEnvelope["approvedStatements"] = [];
  const denied = new Set<string>(); const confirmed = new Set<string>();
  const entryDisputes: IdentityEnvelope["entryDisputes"] = [];
  const assertedRaw: IdentityEnvelope["asserted"] = {};
  let howToBeUnderstood: IdentityEnvelope["howToBeUnderstood"] = null;
  const seenSingle = new Set<string>();
  for (const a of asserted) {
    if (!(a.field in ASSERTED_FIELDS)) continue;
    const field = a.field as AssertedField;
    const spec = ASSERTED_FIELDS[field] as AssertedFieldSpec;
    const raw = fromLedgerValue(field, a.value);
    if (raw === null) continue;
    if ((IDENTITY_LIST_FIELDS as readonly string[]).includes(field)) {
      if (seenSingle.has(field)) continue; seenSingle.add(field);
      const list = raw as string[];
      if (field === "identity.preferred_emphasis") directives.preferredEmphasis = list;
      else if (field === "identity.de_emphasize") directives.deEmphasize = list;
      else if (field === "identity.preferred_language") directives.preferredLanguage = list;
      else directives.avoidLanguage.push(...list);
      continue;
    }
    if (RULE_ASSERTED_FIELDS.includes(field)) {
      if (seenSingle.has(field)) continue; seenSingle.add(field);
      assertedRaw[field] = { id: a.id, raw };
      if (field === "brand_voice") {
        const avoid = (raw as { avoid?: string[] }).avoid;
        if (Array.isArray(avoid)) directives.avoidLanguage.push(...avoid.filter((x) => typeof x === "string"));
      }
      continue;
    }
    if (field === "identity.approved_statement") {
      const v = raw as ApprovedStatement;
      if (!approvedStatements.some((s) => s.target === v.target)) approvedStatements.push({ ...v, assertionId: a.id });
      continue;
    }
    if (field === "claim_confirmation") {
      const v = raw as { ref: unknown; answer: string };
      const r = parseBasisRef(v.ref);
      if (r) (v.answer === "no" ? denied : confirmed).add(refKey(r));
      continue;
    }
    if (field === "dispute") {
      const v = raw as { entryRef: unknown; said?: string };
      const r = typeof v.entryRef === "string" ? null : parseBasisRef(v.entryRef);
      if (r) denied.add(refKey(r));
      else if (typeof v.entryRef === "string") entryDisputes.push({ assertionId: a.id, entryId: v.entryRef, said: v.said ?? null });
      continue;
    }
    if (!CONTENT_ASSERTED_FIELDS.includes(field) || seenSingle.has(field)) continue;
    seenSingle.add(field);
    assertedRaw[field] = { id: a.id, raw };
    if (field === "direction") {
      const value = displayAssertedValue(raw).trim();
      if (!value) continue;
      howToBeUnderstood = { assertionId: a.id, value, said: a.said && a.said.trim() !== value ? a.said.trim() : null };
      items.push(item({ kind: "assertion", id: a.id }, `How the athlete wants to be understood (intent, not a title): ${value}`, "established", {
        athleteAuthority: true, asOf: iso(a.created_at), section: "direction", intent: true,
      }));
      continue;
    }
    items.push(item({ kind: "assertion", id: a.id }, `${spec.label} (the athlete said): ${displayAssertedValue(raw)}`, "established", {
      athleteAuthority: true,
      athleticIdentity: IDENTITY_SUFFICIENCY.athleticAssertedFields.includes(field),
      asOf: iso(a.created_at),
    }));
  }
  // Confirmation never overrides denial (precedence: denial > directive > confirmation).
  for (const k of denied) confirmed.delete(k);
  directives.avoidLanguage = [...new Set(directives.avoidLanguage.map((s) => s.trim()).filter(Boolean))];

  // ── D. HER DIRECTION: Objectives, verbatim ──
  const objs: IdentityEnvelope["objectives"] = [];
  for (const o of objectives) {
    const athleteAuthored = o.disposition === "modified" || o.desiredState.evidenceClass === "MEASURED";
    objs.push({ id: o.id, value: o.desiredState.value, athleteAuthored, domain: o.domain });
    items.push(item({ kind: "objective", id: o.id }, `The athlete's ${o.domain.replace(/_/g, " ")} goal (intent, not a title): ${o.desiredState.value}`, "established", {
      athleteAuthority: true, asOf: o.activatedAt ?? o.createdAt, section: "direction", intent: true,
    }));
  }

  // ── C. HER WORDS ──
  const statements = selectStatements(statementPool, { limitPerTopic: IDENTITY_STATEMENTS.limitPerTopic, maxTotal: IDENTITY_STATEMENTS.maxTotal });
  for (const s of statements) {
    // Tier: what she told Nomila directly is her own record (Established); a caption, a bio or a quote a read found is
    // her expression as published (Reported).
    const direct = s.ref.kind === "said";
    const tier = s.ref.kind === "evidence" ? sourceTierOfEvidence({ lineage: P.sourceReadLineage, sourceType: String(s.acquisition.sourceType ?? ""), kind: "athlete_statement" }) : direct ? "established" : "reported";
    items.push(item(s.ref, s.text, tier, {
      athleteAuthority: direct, asOf: s.at, section: "her_words", intent: s.intent,
      statement: {
        provenance: s.provenance, medium: s.medium, topics: s.topics,
        outlet: (s.acquisition.outlet as string | null | undefined) ?? null, platform: (s.acquisition.platform as string | null | undefined) ?? null,
        timestampSeconds: typeof s.acquisition.timestampSeconds === "number" ? s.acquisition.timestampSeconds : null,
        ...(s.partner ? { partner: true } : {}),
      },
      ...(s.ref.kind === "evidence" ? { source: { type: String(s.acquisition.sourceType ?? "") || null, lineage: P.sourceReadLineage, url: (s.acquisition.sourceUrl as string | null) ?? null } } : {}),
    }, IDENTITY_ENVELOPE.maxStatementChars));
  }

  // ── F. SELF-PRESENTATION: First Look, latest per platform ──
  const firstLooks: FirstLookEntry[] = [];
  for (const s of snapshots) {
    const fl = s.first_look as FirstLook | null;
    if (!fl?.platform || firstLooks.some((x) => x.platform === fl.platform)) continue;
    const e: FirstLookEntry = {
      snapshotId: s.id, platform: fl.platform, themes: strings(fl.themes, 8), tone: strings(fl.tone, 6),
      interests: strings(fl.interests, 6, 40), recurringPhrases: strings(fl.recurring_phrases, 5), causesMentioned: strings(fl.causes_mentioned, 5, 60),
      computedAt: fl.computed_at ?? iso(s.created_at),
    };
    firstLooks.push(e);
    const parts = [
      e.themes.length ? `themes ${e.themes.join(", ")}` : null, e.tone.length ? `tone ${e.tone.join(", ")}` : null,
      e.interests.length ? `interests ${e.interests.join(", ")}` : null, e.recurringPhrases.length ? `recurring phrases ${e.recurringPhrases.map((p) => `"${p}"`).join(", ")}` : null,
      e.causesMentioned.length ? `causes mentioned ${e.causesMentioned.join(", ")}` : null,
    ].filter(Boolean);
    if (!parts.length) continue;
    items.push(item({ kind: "first_look", snapshotId: s.id, platform: fl.platform }, `How the athlete shows up on ${fl.platform}: ${parts.join("; ")}`, "reported", {
      asOf: e.computedAt, section: "self_presentation",
    }, 600));
  }
  firstLooks.sort((a, b) => a.platform.localeCompare(b.platform));

  // ── G. MEASURED AUDIENCE (latest per platform + feature) ──
  const audience: AudienceRow[] = [];
  for (const f of features) {
    const key = `${f.platform ?? "all"}.${f.feature_key}`;
    if (audience.some((x) => x.key === key)) continue;
    const value = f.value == null ? null : Number(f.value);
    if (value == null && f.value_json == null) continue;
    audience.push({ key, platform: f.platform ?? "all", feature: f.feature_key, value, json: f.value_json ?? null, asOf: iso(f.as_of) });
    items.push(item({ kind: "social_feature", key }, audienceText(f.platform ?? "all platforms", f.feature_key, value, f.value_json), "established", {
      asOf: iso(f.as_of), section: "audience",
    }));
  }
  audience.sort((a, b) => a.key.localeCompare(b.key));

  // ── earned deals (partnership proof points) ──
  const dealRows: IdentityEnvelope["deals"] = [];
  for (const d of earned) {
    const raw = (d.raw_data ?? {}) as { contract?: { exclusivity?: { exists?: unknown; scope?: unknown } }; confirmed?: { exclusivity?: unknown } };
    const ex = raw.contract?.exclusivity;
    const exclusive = raw.confirmed?.exclusivity === true || ex?.exists === true;
    dealRows.push({ id: d.id, brand: d.brand_name, dealType: d.deal_type ?? null, exclusivity: exclusive ? (typeof ex?.scope === "string" && ex.scope.trim() ? ex.scope.trim().slice(0, 160) : "exclusive") : null });
    items.push(item({ kind: "deal", id: d.id }, `Brand partnership: ${d.brand_name}${d.deal_type ? ` (${d.deal_type.replace(/_/g, " ")})` : ""}`, "established", {
      asOf: iso(d.detected_at ?? d.created_at),
    }));
  }
  dealRows.sort((a, b) => a.id.localeCompare(b.id));

  // ── H. MARKETABILITY CONTEXT: compact only — salience, never content ──
  const miaRow = mia[0] ?? null;
  let miaCompact: MiaCompact | null = null;
  if (miaRow) {
    const notes = ((miaRow.value as any)?.notes ?? {}) as Record<string, unknown>;
    miaCompact = {
      entryId: miaRow.id,
      dimensions: findingsFromMia(miaRow).map((f) => ({ key: f.key, direction: f.direction })),
      strengths: strings(notes.strengths, 5, 160), constraints: strings(notes.constraints, 5, 160),
    };
    const asOf = iso(miaRow.evidence_as_of);
    const word: Record<string, string> = { strength: "a strength", gap: "an area to grow", neutral: "neither a strength nor a gap", unknown: "not yet known" };
    for (const d of miaCompact.dimensions) {
      items.push(item({ kind: "state_finding", key: d.key }, `Marketability assessment: ${d.key.replace(/^mia\./, "").replace(/_/g, " ")} reads as ${word[d.direction] ?? d.direction}`, "salience", {
        asOf, salience: d.direction === "strength" ? IDENTITY_SALIENCE.stateFinding : 0, section: "marketability",
      }));
    }
    miaCompact.strengths.forEach((s, n) => items.push(item({ kind: "state_finding", key: `mia.note.strength.${n + 1}` }, `Key strength (assessment): ${s}`, "salience", { asOf, salience: IDENTITY_SALIENCE.stateFinding, section: "marketability" })));
    miaCompact.constraints.forEach((s, n) => items.push(item({ kind: "state_finding", key: `mia.note.constraint.${n + 1}` }, `Key constraint (assessment): ${s}`, "salience", { asOf, salience: 0, section: "marketability" })));
  }

  // ── claims, tiers, salience ──
  const verdicts: AthleteVerdicts = { denied, confirmed };
  const claims = assessClaims(items, verdicts);
  rank(items, now);

  const core: EnvelopeCore = {
    athleteId, items, claims, directives, approvedStatements: approvedStatements.sort((a, b) => a.target.localeCompare(b.target)),
    verdicts, entryDisputes, objectives: objs.sort((a, b) => a.id.localeCompare(b.id)), howToBeUnderstood, firstLooks, statements,
    facts: factRows.sort((a, b) => a.id.localeCompare(b.id)), evidence: evidenceRows.sort((a, b) => a.id.localeCompare(b.id)),
    asserted: assertedRaw, deals: dealRows, audience, mia: miaCompact, miaEntryId: miaRow?.id ?? null,
  };

  // ── the rules parts, BEFORE the call; proof points and signature moments become section I ──
  const rules = composeRules(core);
  const preAssembled = new Set([...rules.signatureMoments, ...rules.proofPoints].map((p) => p.key));
  for (const i of items) if (preAssembled.has(i.key)) i.section = "pre_assembled";
  for (const i of items) if (!i.section && (i.tier === "established" || i.tier === "reported")) i.section = i.tier;

  const content = items.filter((i) => i.sourceTier !== "salience" && i.asOf);
  const evidenceAsOf = content.length ? content.map((i) => i.asOf!).sort().at(-1)! : now.toISOString();
  items.sort((a, b) => a.key.localeCompare(b.key));
  const env = { ...core, rules, evidenceAsOf };
  return { ...env, inputVersion: inputVersionOf(env) };
}

/** Rank (rules): salience 0–1 from athlete authority, convergence, recency and tier. M.I.A. contributes ranking only. */
export function rank(items: BasisItem[], now: Date): void {
  const S = IDENTITY_SALIENCE;
  const groupSize = new Map<string, number>();
  for (const i of items) if (i.claimKey) groupSize.set(i.claimKey, (groupSize.get(i.claimKey) ?? 0) + 1);
  for (const i of items) {
    if (i.sourceTier === "salience") continue;
    let s = S.base;
    if (i.athleteAuthority) s += S.athleteAuthority;
    if (i.claimKey && (groupSize.get(i.claimKey) ?? 0) > 1) s += S.convergence;
    if (i.asOf && now.getTime() - new Date(i.asOf).getTime() <= S.recentDays * 86_400_000) s += S.recent;
    if (i.tier === "established") s += S.established;
    i.salience = Math.round(Math.min(1, s) * 100) / 100;
  }
}

/** sha256 of the canonical envelope 0.2. Salience (recency moves daily) and ranks are deliberately not part of it. */
export function inputVersionOf(env: Omit<IdentityEnvelope, "inputVersion">): string {
  const canonical = {
    versions: { contract: IDENTITY_INTELLIGENCE_CONTRACT, policy: IDENTITY_ADMISSIBILITY_POLICY, prompt: IDENTITY_SYNTHESIS_PROMPT },
    items: env.items.map((i) => [i.key, i.text, i.sourceTier, i.tier, i.section ?? null, i.intent ?? false]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    statements: env.statements.map((s) => [s.id, s.provenance, s.medium, s.topics, s.partner ?? false]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    directives: env.directives,
    approved: env.approvedStatements.map((s) => [s.assertionId, s.target, s.text, s.basisDigest]),
    denied: [...env.verdicts.denied].sort(),
    confirmed: [...env.verdicts.confirmed].sort(),
    entryDisputes: env.entryDisputes.map((d) => [d.assertionId, d.entryId]).sort(),
    objectives: env.objectives.map((o) => [o.id, o.value, o.athleteAuthored, o.domain]),
    howToBeUnderstood: env.howToBeUnderstood,
    firstLooks: env.firstLooks.map((f) => [f.snapshotId, f.platform, f.themes, f.tone, f.interests, f.recurringPhrases, f.causesMentioned]),
    asserted: Object.keys(env.asserted).sort().map((k) => [k, env.asserted[k].id, env.asserted[k].raw]),
    deals: env.deals,
    audience: env.audience.map((a) => [a.key, a.value, a.json]),
    mia: env.mia,
  };
  return createHash("sha256").update(canonicalJson(canonical)).digest("hex");
}
