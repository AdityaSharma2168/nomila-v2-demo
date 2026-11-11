/**
 * statements.ts — athleteStatements(): the athlete's own words, as one shape (acquisition plan §2e). A read function,
 * not a table. Deterministic for the same rows and `now`.
 *
 * PROVENANCE (settled 3 Oct 2026):
 *   her_own      text Nomila holds from the athlete herself
 *                  media_assets.caption        her captions on connected platforms        medium "caption"
 *                  social_features profile.bio  latest bio per platform                   medium "bio"
 *                  athlete_asserted.said        live rows (not superseded, not retracted)  medium "conversation" | "form"
 *                  objective_events.said        her words when she acted on an Objective  medium "objective_review"
 *                  objectives.desired_state     an Objective she wrote or reworded        medium "objective"
 *   source_read  research_evidence kind athlete_statement, lineage source_read: verbatim words Research v3's targeted
 *                read found in an interview, feature, press conference or profile (medium as the read recorded it)
 *
 * PARTNER CONTENT (0.7): a connected caption is flagged `partner` when it was made under a deal (media_assets.deal_id),
 * is tagged to a brand (a content_brands row) or carries a disclosure marker (#ad, #sponsored, "paid partnership"). It
 * stays in HER WORDS because she published it, but it is a brand's message, not her own words: it may show a
 * partnership, never her values, standsFor or motivation (synthesize.ts tags it; validate.ts refuses it as their only
 * basis).
 *
 * NEVER a statement: a research quote whose speaker is not explicitly "athlete" (absent or unknown included), a quote
 * seen only through search grounding (any other lineage), a paraphrase (stored as a
 * narrative_claim), an uploaded or generated asset's caption, an identity-governance row (directives, disputes,
 * confirmations, approved statements), or anything from the retiring sources.
 *
 * Ranking (rules, IDENTITY_STATEMENTS): provenance weight + medium adjustment + recency + length sanity; ties by
 * newest, then id. Capped per topic (statements without topics are bucketed by medium) and in total.
 */
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "../../../db";
import { athleteAsserted, contentBrands, mediaAssets, objectiveEvents, researchEvidence, socialFeatures } from "../../../../shared/schema";
import { liveObjectives } from "../objective/store";
import { PROFILE_BIO_KEY } from "../social/profileBio";
import { IDENTITY_ADMISSIBILITY, IDENTITY_STATEMENTS, STATEMENT_TOPIC_OF_FIELD } from "./config";
import { refKey, type BasisRef, type StatementProvenance } from "./contract";
import { IDENTITY_GOVERNANCE_FIELDS } from "./governance";

type Db = typeof db;

export interface AthleteStatement {
  /** refKey(ref) — stable. */
  id: string;
  ref: BasisRef;
  text: string;
  provenance: StatementProvenance;
  /** caption · bio · conversation · form · objective · objective_review · or the read's medium (video, article, …). */
  medium: string;
  topics: string[];
  /** When she said / posted / published it, ISO. */
  at: string | null;
  /** How Nomila came to hold it (platform, permalink, outlet, source class, …). Detail only, never ranking input. */
  acquisition: Record<string, string | number | null>;
  /** Her stated intent (an Objective's wording or her words on one) — direction, never achievement. */
  intent: boolean;
  /** A caption published as partner content (a deal, a brand tag or a disclosure marker) — a brand's message, not hers. */
  partner?: boolean;
  /** Rules rank, 0–1+. */
  rank: number;
}

export interface AthleteStatementsOptions { topics?: string[]; limitPerTopic?: number; maxTotal?: number; now?: Date }

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** Paid-partnership disclosure in a caption: #ad, #sponsored or "paid partnership" (case-insensitive; brand-neutral). */
const DISCLOSURE = /(^|[^\p{L}\p{N}_])#(ad|sponsored)(?![\p{L}\p{N}_])|\bpaid partnership\b/iu;
export const hasDisclosureMarker = (caption: string): boolean => DISCLOSURE.test(caption);

/** The rules rank of one statement (exported for tests). */
export function rankStatement(s: Pick<AthleteStatement, "provenance" | "medium" | "text" | "at">, now: Date, cfg = IDENTITY_STATEMENTS): number {
  let r = (cfg.provenanceWeight[s.provenance] ?? 0) + (cfg.mediumAdjust[s.medium] ?? 0);
  if (s.at) {
    const days = (now.getTime() - new Date(s.at).getTime()) / 86_400_000;
    if (days <= cfg.recentDays) r += cfg.recentBonus;
    else if (days <= cfg.olderDays) r += cfg.olderBonus;
  }
  if (s.text.length < cfg.minChars || s.text.length > cfg.maxChars) r -= cfg.lengthPenalty;
  return Math.round(r * 1000) / 1000;
}

/** Order and cap (exported for tests): rank desc, newest first, id; ≤ limitPerTopic per bucket and ≤ maxTotal. */
export function selectStatements(all: AthleteStatement[], opts: { topics?: string[]; limitPerTopic: number; maxTotal: number }): AthleteStatement[] {
  const wanted = opts.topics?.length ? new Set(opts.topics) : null;
  const pool = wanted ? all.filter((s) => s.topics.some((t) => wanted.has(t))) : all;
  const sorted = [...pool].sort((a, b) => b.rank - a.rank || (b.at ?? "").localeCompare(a.at ?? "") || a.id.localeCompare(b.id));
  const used = new Map<string, number>();
  const seenText = new Set<string>();
  const out: AthleteStatement[] = [];
  for (const s of sorted) {
    if (out.length >= opts.maxTotal) break;
    const norm = s.text.toLowerCase();
    if (seenText.has(norm)) continue;
    const buckets = (s.topics.length ? s.topics.filter((t) => !wanted || wanted.has(t)) : [`medium:${s.medium}`]);
    if (!buckets.some((b) => (used.get(b) ?? 0) < opts.limitPerTopic)) continue;
    for (const b of buckets) used.set(b, (used.get(b) ?? 0) + 1);
    seenText.add(norm);
    out.push(s);
  }
  return out;
}

/** Every statement source, unranked and uncapped (exported for the envelope's tests). */
export async function gatherStatements(athleteId: string, now: Date, dbx: Db = db): Promise<AthleteStatement[]> {
  const C = IDENTITY_STATEMENTS;
  const [evidence, captions, bios, asserted, events, objectives] = await Promise.all([
    dbx.select().from(researchEvidence).where(and(
      eq(researchEvidence.athlete_id, athleteId), eq(researchEvidence.kind, "athlete_statement"),
      eq(researchEvidence.lineage_status, IDENTITY_ADMISSIBILITY.sourceReadLineage), eq(researchEvidence.suspect, false), isNull(researchEvidence.superseded_by),
    )),
    dbx.select({ id: mediaAssets.id, caption: mediaAssets.caption, deal_id: mediaAssets.deal_id, posted_at: mediaAssets.posted_at, platform: mediaAssets.platform, permalink: mediaAssets.permalink }).from(mediaAssets)
      .where(and(eq(mediaAssets.athlete_id, athleteId), eq(mediaAssets.origin, "connected"), isNotNull(mediaAssets.caption), isNull(mediaAssets.parent_media_id), isNull(mediaAssets.deleted_at)))
      .orderBy(desc(mediaAssets.posted_at), desc(mediaAssets.id)).limit(C.maxCaptionsScanned),
    dbx.select({ platform: socialFeatures.platform, value_json: socialFeatures.value_json, as_of: socialFeatures.as_of, source_class: socialFeatures.source_class }).from(socialFeatures)
      .where(and(eq(socialFeatures.athlete_id, athleteId), eq(socialFeatures.feature_key, PROFILE_BIO_KEY), inArray(socialFeatures.source_class, [...IDENTITY_ADMISSIBILITY.establishedSocialSourceClasses])))
      .orderBy(desc(socialFeatures.as_of)),
    dbx.select({ id: athleteAsserted.id, field: athleteAsserted.field, said: athleteAsserted.said, source: athleteAsserted.source, mode: athleteAsserted.mode, created_at: athleteAsserted.created_at }).from(athleteAsserted)
      .where(and(eq(athleteAsserted.athlete_id, athleteId), isNull(athleteAsserted.retracted_at), isNull(athleteAsserted.superseded_by), isNotNull(athleteAsserted.said))),
    dbx.select({ id: objectiveEvents.id, objective_id: objectiveEvents.objective_id, action: objectiveEvents.action, said: objectiveEvents.said, at: objectiveEvents.at }).from(objectiveEvents)
      .where(and(eq(objectiveEvents.athlete_id, athleteId), eq(objectiveEvents.actor_role, "athlete"), isNotNull(objectiveEvents.said)))
      .orderBy(desc(objectiveEvents.at), desc(objectiveEvents.id)).limit(C.maxEventsScanned),
    liveObjectives(dbx as any, athleteId),
  ]);

  // Captions tagged to a brand (content_brands) — one read for the scanned captions.
  const captionIds = captions.map((c) => c.id);
  const branded = new Set(captionIds.length
    ? (await dbx.select({ asset_id: contentBrands.asset_id }).from(contentBrands).where(inArray(contentBrands.asset_id, captionIds))).map((r) => r.asset_id)
    : []);

  const out: AthleteStatement[] = [];
  const push = (s: Omit<AthleteStatement, "id" | "rank">) => {
    const text = clean(s.text);
    if (!text) return;
    const full = { ...s, text, id: refKey(s.ref) };
    out.push({ ...full, rank: rankStatement(full, now) });
  };

  for (const e of evidence) {
    const c = (e.claim ?? {}) as Record<string, unknown>;
    const text = str(c.text);
    if (!text || c.speaker !== "athlete") continue;   // only words explicitly attributed to the athlete; absent/unknown never
    push({
      ref: { kind: "evidence", id: e.id }, text, provenance: "source_read", medium: str(c.medium) ?? "other",
      topics: Array.isArray(c.topics) ? [...new Set(c.topics.filter((t): t is string => typeof t === "string"))] : [],
      at: iso(e.published_at ?? e.retrieved_at),
      acquisition: {
        outlet: str(c.outlet), sourceTitle: str(c.sourceTitle), timestampSeconds: typeof c.timestampSeconds === "number" ? c.timestampSeconds : null,
        sourceUrl: e.source_url ?? null, sourceType: e.source_type ?? null, publishedAt: iso(e.published_at),
      },
      intent: false,
    });
  }
  for (const c of captions) {
    if (!c.caption?.trim()) continue;
    const partner = !!c.deal_id || branded.has(c.id) || hasDisclosureMarker(c.caption);
    push({ ref: { kind: "media_asset", id: c.id }, text: c.caption, provenance: "her_own", medium: "caption", topics: [], at: iso(c.posted_at), acquisition: { platform: c.platform, permalink: c.permalink ?? null }, intent: false, ...(partner ? { partner } : {}) });
  }
  const seenBio = new Set<string>();
  for (const b of bios) {
    const platform = b.platform ?? "all";
    if (seenBio.has(platform)) continue;   // latest per platform (rows are newest first)
    seenBio.add(platform);
    const text = str((b.value_json as { text?: unknown } | null)?.text);
    if (!text) continue;
    push({ ref: { kind: "social_feature", key: `${platform}.${PROFILE_BIO_KEY}` }, text, provenance: "her_own", medium: "bio", topics: [], at: iso(b.as_of), acquisition: { platform, sourceClass: b.source_class }, intent: false });
  }
  for (const a of asserted) {
    if ((IDENTITY_GOVERNANCE_FIELDS as readonly string[]).includes(a.field) || !a.said?.trim()) continue;
    const topic = STATEMENT_TOPIC_OF_FIELD[a.field] ?? null;
    const medium = (a.mode ?? (a.source === "settings" ? "form" : "chat")) === "form" ? "form" : "conversation";
    push({ ref: { kind: "said", source: "assertion", id: a.id }, text: a.said, provenance: "her_own", medium, topics: topic ? [topic] : [], at: iso(a.created_at), acquisition: { field: a.field, source: a.source, mode: a.mode ?? null }, intent: a.field === "direction" || a.field === "goal" || a.field === "secondary_goals" });
  }
  // An Objective she created carries her wording twice (the row and its `created` event): keep the Objective's.
  const wording = new Set(objectives.map((o) => `${o.id}|${clean(o.desiredState.value).toLowerCase()}`));
  for (const ev of events) {
    if (!ev.said?.trim() || wording.has(`${ev.objective_id}|${clean(ev.said).toLowerCase()}`)) continue;
    push({ ref: { kind: "said", source: "objective_event", id: ev.id }, text: ev.said, provenance: "her_own", medium: "objective_review", topics: ["ambition"], at: iso(ev.at), acquisition: { objectiveId: ev.objective_id, action: ev.action }, intent: true });
  }
  for (const o of objectives) {
    if (!(o.disposition === "modified" || o.desiredState.evidenceClass === "MEASURED")) continue;   // she wrote or reworded it
    push({ ref: { kind: "said", source: "objective", id: o.id }, text: o.desiredState.value, provenance: "her_own", medium: "objective", topics: ["ambition"], at: o.activatedAt ?? o.createdAt, acquisition: { objectiveId: o.id, domain: o.domain }, intent: true });
  }
  return out;
}

/** HER WORDS: the strongest few per topic, ranked and capped by rules. */
export async function athleteStatements(athleteId: string, opts: AthleteStatementsOptions = {}, dbx: Db = db): Promise<AthleteStatement[]> {
  const all = await gatherStatements(athleteId, opts.now ?? new Date(), dbx);
  return selectStatements(all, {
    topics: opts.topics, limitPerTopic: opts.limitPerTopic ?? IDENTITY_STATEMENTS.limitPerTopic, maxTotal: opts.maxTotal ?? IDENTITY_STATEMENTS.maxTotal,
  });
}
