/**
 * build.ts — compose an AthleteState from intelligence Nomila already owns.
 *
 * Reads only. No provider calls, no research, no new tables, no evaluator. Every value either comes from a system
 * that already produced it, is counted here from rows that already exist, or is MISSING.
 *
 * WHY THERE IS NO MODEL CALL HERE. M.I.A. has already judged marketability, the social substrate has already
 * measured distribution, and the commercial record already knows what was transacted. Paying a model to reinterpret
 * all of that would produce a second opinion with no rubric and no parity gate, and would make the boundary between
 * "what is true" and "what we recommend" impossible to inspect. New judgment begins at Opportunity.
 *
 * WHAT THE DATA ACTUALLY SUPPORTS. The persisted M.I.A. row carries dimension scores, confidences, per-signal
 * imputation flags, a summary, and `importantMissingData`. It does NOT carry per-dimension rationale, and `drivers`
 * is empty for every athlete in the ledger — both were declared in the retired contracts/commercial.ts and are absent
 * from the data.
 * So findings here are structural: a dimension, a score, a confidence, how much of it was imputed, and pointers to
 * the signals. The language belongs to Opportunity.
 *
 * ATHLETE-AGNOSTIC BY CONSTRUCTION. There are no sport, level, school, audience-size, career-stage or
 * commercial-history assumptions anywhere below. The only numeric thresholds are the two band edges used to call a
 * dimension high or low, they are declared constants applied to every athlete identically, and a dimension whose
 * evidence is mostly imputed is never called a gap regardless of its score.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  athleteAffiliations,
  athleteAsserted,
  athletes,
  deals,
  inboxThreads,
  intelligenceLedger,
  socialAudienceDistributions,
  socialFeatures,
} from "../../../../shared/schema";
import { validateAthleteState } from "./validate";
import {
  ATHLETE_STATE_VERSION,
  type AthleteState,
  type CommercialPosition,
  type EvidenceRef,
  type StateAudience,
  type StateConstraint,
  type StateContentPerformance,
  type StateDate,
  type StateFinding,
  type StateInboundSignal,
  type StatePreference,
  type StateRepresentation,
} from "../contracts/athleteState";
import type { ConfidenceLevel, MeasuredValue, MissingValue, ValueOwner } from "../contracts/provenance";
import { citationStrength, type LedgerEvidenceCitation } from "../contracts/intelligenceLedger";

/**
 * Band edges for calling a dimension high or low, on M.I.A.'s own 0-100 dimension scale.
 *
 * Declared parameters, not empirical findings — they are one versioned choice applied identically to every athlete,
 * and they are here rather than inline so that changing them is a visible act. P-4.
 */
export const STATE_BANDS = { strengthAtOrAbove: 75, gapAtOrBelow: 45 } as const;

/**
 * A dimension resting mostly on imputed signals reports `unknown`, never `gap`.
 *
 * P-8: a low score built from priors is a statement about our evidence, not about the athlete. An emerging athlete
 * with no measured audience must not be diagnosed as commercially weak on that account.
 */
export const IMPUTED_SHARE_FOR_UNKNOWN = 0.5;

/** Statuses that represent money actually agreed, shared with the Rate evidence block for the same reason. */
const EARNED_STATUSES = ["accepted", "completed"] as const;

const CONF_ORDER: Record<ConfidenceLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
const weakest = (xs: ConfidenceLevel[]): ConfidenceLevel =>
  xs.length ? xs.reduce((a, b) => (CONF_ORDER[b] < CONF_ORDER[a] ? b : a)) : "LOW";

/**
 * Read a confidence from whatever shape its source used, and band it onto the shared ordinal vocabulary.
 *
 * The sources genuinely disagree, and this is not tidiness: the persisted M.I.A. row carries dimension confidence as
 * a 0-100 number, `identityConfidence` as the bare string "HIGH", and `overallConfidence` as an OBJECT
 * `{ level, explanation }`. A reader that assumed a number silently returned LOW for every athlete in the ledger —
 * a whole-cohort error that no type check catches, because the column is jsonb.
 */
export function bandConfidence(raw: unknown): ConfidenceLevel {
  if (raw && typeof raw === "object" && "level" in (raw as any)) return bandConfidence((raw as any).level);
  if (typeof raw === "string") {
    const up = raw.toUpperCase();
    return up === "HIGH" || up === "MEDIUM" || up === "LOW" ? (up as ConfidenceLevel) : "LOW";
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) return "LOW";
  const v = raw <= 1 ? raw * 100 : raw;
  return v >= 75 ? "HIGH" : v >= 50 ? "MEDIUM" : "LOW";
}

/**
 * `evidenceIds` and `sourceMethod` are required by the contract and are not ceremony: they are what lets a reader
 * get from a number in State back to the row that produced it, which is the whole point of composing rather than
 * copying.
 */
const measured = <T,>(
  value: T, owner: ValueOwner, confidence: ConfidenceLevel, asOf: string,
  evidenceIds: string[], sourceMethod: string,
): MeasuredValue<T> => ({ value, owner, confidence, asOf, evidenceClass: "MEASURED", evidenceIds, sourceMethod });

/** MissingValue deliberately carries no confidence — there is nothing to be confident about. */
const missing = (owner: ValueOwner, reason: string, asOf: string): MissingValue => ({
  value: null, owner, asOf, evidenceClass: "MISSING", reason,
});

/** A MISSING basis contributes LOW: absence cannot raise our confidence in the whole. */
const confidenceOf = (b: MeasuredValue<unknown> | MissingValue): ConfidenceLevel =>
  b.evidenceClass === "MEASURED" ? b.confidence : "LOW";

export interface BuildStateOptions {
  /** Overrides "now" so a composed state is reproducible in tests. */
  asOf?: Date;
}

/**
 * Compose the state. Returns null only when the athlete does not exist — every other absence is represented inside
 * the state rather than by refusing to produce one.
 */
export async function buildAthleteState(
  db: PgDatabase<any, any, any>,
  athleteId: string,
  opts: BuildStateOptions = {},
): Promise<AthleteState | null> {
  const now = (opts.asOf ?? new Date()).toISOString();

  const [athlete] = await db.select({
    id: athletes.id, full_name: athletes.full_name, sport: athletes.sport, career_status: athletes.career_status,
    goal_archetype: athletes.goal_archetype, secondary_goals: athletes.secondary_goals,
    deal_preferences: athletes.deal_preferences, claimed_at: athletes.claimed_at, created_at: athletes.created_at,
  }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!athlete) return null;

  const [miaRow] = await db.select({
    id: intelligenceLedger.id, value: intelligenceLedger.value, evidence_as_of: intelligenceLedger.evidence_as_of,
  }).from(intelligenceLedger).where(and(
    eq(intelligenceLedger.subject_id, athleteId),
    eq(intelligenceLedger.owner, "marketability"),
    eq(intelligenceLedger.kind, "ASSESSMENT"),
    isNull(intelligenceLedger.superseded_by),
  )).orderBy(desc(intelligenceLedger.created_at)).limit(1);

  const affiliations = await db.select().from(athleteAffiliations)
    .where(eq(athleteAffiliations.athlete_id, athleteId));

  const assertions = await db.select().from(athleteAsserted).where(and(
    eq(athleteAsserted.athlete_id, athleteId),
    isNull(athleteAsserted.superseded_by),
    isNull(athleteAsserted.retracted_at),
  ));

  const dealRows = await db.select({
    id: deals.id, brand_name: deals.brand_name, status: deals.status,
    amount: deals.amount, amount_cash: deals.amount_cash, deal_type: deals.deal_type, term_end: deals.term_end,
  }).from(deals).where(eq(deals.athlete_id, athleteId));
  // 1.3.0: deals carrying a contract she uploaded — whether it created the deal or was filed onto one the inbox found —
  // read only for the exclusivity SHE confirmed (contractExclusivityFrom).
  const contractRows = await db.select({
    id: deals.id, brand_name: deals.brand_name, status: deals.status, term_end: deals.term_end, raw_data: deals.raw_data, created_at: deals.created_at,
  }).from(deals).where(and(eq(deals.athlete_id, athleteId), sql`${deals.raw_data} ? 'contract'`));

  // The athlete's OWN inbox, classified. Interest, never a deal — projected as a capped, compact signal list.
  const threadRows = await db.select({
    id: inboxThreads.id, classification: inboxThreads.classification,
    last_message_at: inboxThreads.last_message_at, status: inboxThreads.status,
  }).from(inboxThreads).where(eq(inboxThreads.athlete_id, athleteId)).orderBy(desc(inboxThreads.last_message_at)).limit(400);

  // Audience composition: latest observation per platform, top buckets only. The table holds thousands of rows;
  // State holds one line per platform and points back.
  const distRows = await db.select({
    id: socialAudienceDistributions.id, platform: socialAudienceDistributions.platform,
    dimension: socialAudienceDistributions.dimension, bucket: socialAudienceDistributions.bucket,
    pct: socialAudienceDistributions.pct, observed_at: socialAudienceDistributions.observed_at,
  }).from(socialAudienceDistributions).where(eq(socialAudienceDistributions.athlete_id, athleteId));

  const feats = await db.select({
    platform: socialFeatures.platform, feature_key: socialFeatures.feature_key,
    value: socialFeatures.value, value_json: socialFeatures.value_json, as_of: socialFeatures.as_of,
    imputed: socialFeatures.imputed, confidence: socialFeatures.confidence,
  }).from(socialFeatures).where(eq(socialFeatures.athlete_id, athleteId));

  const findings = miaRow ? findingsFromMia(miaRow) : [];
  const audienceTrajectory = audienceTrajectoryFrom(feats, now);
  const inbound = inboundFrom(threadRows);

  const state: AthleteState = {
    athleteId,
    asOf: now,
    version: ATHLETE_STATE_VERSION,
    identity: {
      name: athlete.full_name,
      sport: athlete.sport ?? null,
      competitionContext: competitionContextFrom(affiliations),
      careerStatus: athlete.career_status ?? null,
    },
    findings,
    audienceTrajectory,
    commercialPosition: commercialPositionFrom(dealRows, feats, now, inbound),
    constraints: [...constraintsFrom(assertions, now), ...contractExclusivityFrom(contractRows as any, now)],
    preferences: [...onboardingPreferencesFrom(athlete), ...preferencesFrom(assertions)],
    audience: audienceFrom(distRows, feats),
    contentPerformance: contentPerformanceFrom(feats),
    representation: representationFrom(athlete, now),
    dates: datesFrom(dealRows, affiliations, inbound, now),
    athleteNotes: notesFrom(assertions, now),
    ...directionOf(assertions, now),
    materialGaps: Array.isArray((miaRow?.value as any)?.importantMissingData)
      ? ((miaRow!.value as any).importantMissingData as unknown[]).filter((x): x is string => typeof x === "string")
      : [],
    overallConfidence: weakest([
      // `overallConfidence` is the evaluator's own stated level; the numeric `confidence` is its fallback.
      miaRow ? bandConfidence((miaRow.value as any)?.overallConfidence ?? (miaRow.value as any)?.confidence) : "LOW",
      findings.length ? weakest(findings.map((f) => confidenceOf(f.basis))) : "LOW",
    ]),
    sources: [
      { owner: "marketability", present: !!miaRow, asOf: miaRow?.evidence_as_of?.toISOString() ?? null },
      { owner: "athlete_intelligence", present: feats.length > 0, asOf: latestAsOf(feats) },
      { owner: "athlete_state", present: true, asOf: now },
    ],
  };

  // ON THE PATH, NOT BESIDE IT. A state that fails its own invariants is not returned — the Rate lesson.
  const problems = validateAthleteState(state);
  if (problems.length) throw new Error(`AthleteState invalid for ${athleteId}: ${problems.join("; ")}`);
  return state;
}

/**
 * One finding per M.I.A. dimension.
 *
 * Every dimension is reported, including the middling ones: a diagnosis that lists only extremes hides the fact that
 * most of an athlete is unremarkable, and Opportunity needs the whole picture to decide what to MAINTAIN.
 */
export function findingsFromMia(row: { id: string; value: unknown; evidence_as_of: Date | null }): StateFinding[] {
  const v = row.value as any;
  const dims: any[] = Array.isArray(v?.dimensions) ? v.dimensions : [];
  const asOf = row.evidence_as_of?.toISOString() ?? new Date(0).toISOString();

  // The generic projection, where the row was written under the corrected contract. Older rows carry `dimensions`
  // alone and degrade to the thin shape — the ledger is immutable, so history is not rewritten to fill it in.
  const findingsByKey = new Map<string, any>(
    (Array.isArray(v?.findings) ? v.findings : []).map((f: any) => [String(f?.key), f]),
  );
  const citations = new Map<string, any>(
    (Array.isArray(v?.evidence) ? v.evidence : []).map((e: any) => [String(e?.id), e]),
  );

  return dims.map((d) => {
    const signals: any[] = Array.isArray(d?.signals) ? d.signals : [];
    const imputed = signals.filter((s) => s?.imputed).length;
    const total = signals.length;
    const share = total ? imputed / total : 1;
    const score = typeof d?.score === "number" ? d.score : null;
    const confidence = bandConfidence(d?.confidence);

    // Order matters: an evidence-poor dimension is `unknown` whatever it scored, and reversing the first two checks
    // is how a dimension built from priors becomes a diagnosed weakness. A measured score that falls between the
    // bands is `neutral` — we know, and it is unremarkable — never `unknown`, which would claim we had not looked.
    const direction: StateFinding["direction"] =
      score === null || share >= IMPUTED_SHARE_FOR_UNKNOWN ? "unknown"
        : score >= STATE_BANDS.strengthAtOrAbove ? "strength"
          : score <= STATE_BANDS.gapAtOrBelow ? "gap"
            : "neutral";

    const evidence: EvidenceRef[] = signals.slice(0, 8).map((s) => ({
      source: "mia" as const,
      locator: `${row.id}#${String(s?.key ?? d?.dimension ?? "")}`,
      asOf: typeof s?.asOf === "string" ? s.asOf : asOf,
    }));

    // Everything below this line is the evaluator's, carried unchanged. State adds `direction` and nothing else.
    const lf = findingsByKey.get(String(d?.dimension ?? ""));
    const resolved: LedgerEvidenceCitation[] = (lf?.citedEvidence ?? []).map((id: string) => citations.get(String(id))).filter(Boolean);
    // Split by STRENGTH (contracts/intelligenceLedger.ts `citationStrength`), so no reader can take a weaker lineage
    // for a direct one: grounded (direct) and lineage-unrecorded rows (written before 1.5.0) stay in `citedEvidence`;
    // a site-only domain match and Nomila's own supplied data each get their own list; asserted_only / unsupported
    // are carried apart as NOT support and never reach `rationale.evidenceIds`.
    const by = (k: string) => resolved.filter((e) => citationStrength(e) === k);
    const cited = resolved.filter((e) => ["grounded", "unrecorded"].includes(citationStrength(e)));
    const siteOnly = by("site_only");
    const nomilaSupplied = by("nomila_supplied");
    const notRetrieved = by("not_support");
    const dangling: string[] = Array.isArray(lf?.danglingEvidence) ? lf.danglingEvidence.map(String) : [];

    return {
      key: `mia.${String(d?.dimension ?? "unknown")}`,
      direction,
      ...(lf?.rationale
        ? {
            rationale: {
              value: String(lf.rationale),
              // The owner is marketability, not athlete_state. State is reading this judgment, not making it.
              owner: "marketability" as const,
              confidence: (lf.confidence as ConfidenceLevel) ?? confidence,
              asOf,
              evidenceClass: "EVALUATED" as const,
              evidenceIds: ((lf.citedEvidence ?? []) as string[]).filter((id) => !notRetrieved.some((e) => e.id === id)),
              rationale: String(lf.confidenceReason ?? lf.rationale),
              falsifiedBy: null,
            },
          }
        : {}),
      ...(lf?.confidenceReason ? { confidenceReason: String(lf.confidenceReason) } : {}),
      ...(cited.length ? { citedEvidence: cited } : {}),
      ...(siteOnly.length ? { siteOnlyCitations: siteOnly } : {}),
      ...(nomilaSupplied.length ? { nomilaSuppliedCitations: nomilaSupplied } : {}),
      ...(notRetrieved.length ? { unsupportedCitations: notRetrieved } : {}),
      ...(dangling.length ? { danglingEvidence: dangling } : {}),
      ...(Array.isArray(lf?.components) && lf.components.length
        ? {
            components: lf.components.map((c: any) => ({
              key: String(c?.key ?? ""),
              value: c?.value ?? null,
              evidenceClass: String(c?.evidenceClass ?? "EVALUATED"),
              confidence: c?.confidence ?? null,
              rationale: c?.rationale ?? null,
            })),
          }
        : {}),
      // The score keeps `marketability` as its owner. State is reading it, not making it.
      basis: score === null
        ? missing("marketability", "dimension score absent", asOf)
        : measured(score, "marketability", confidence, asOf, evidence.map((e) => e.locator), "mia.dimension_score"),
      imputedShare: total ? { imputed, total } : undefined,
      evidence: evidence.length ? evidence : [{ source: "mia", locator: row.id, asOf }],
    };
  });
}

/**
 * Direction of travel OF THE AUDIENCE. Follower growth, and nothing wider.
 *
 * The name is the point. This reads `followers_growth_pct` and nothing else, so it cannot speak to athletic
 * trajectory, commercial trajectory or career trajectory — an athlete whose audience is cooling may be having the
 * best season of their life. Calling it `trajectory` invited exactly the misreading that a downstream strategy
 * layer would make once and never question.
 *
 * MISSING when nothing is measured: an athlete without connected accounts has no observable audience trajectory,
 * and "steady" would be a fabrication dressed as a reading.
 */
export function audienceTrajectoryFrom(
  feats: Array<{ platform: string | null; feature_key: string; value: unknown; as_of: Date | null }>,
  now: string,
): AthleteState["audienceTrajectory"] {
  const growth = feats.filter((f) => f.feature_key === "followers_growth_pct")
    .map((f) => Number(f.value)).filter((n) => Number.isFinite(n));
  if (!growth.length) return missing("athlete_intelligence", "no growth measurement on any platform", now);

  const mean = growth.reduce((a, b) => a + b, 0) / growth.length;
  const value = mean > 1 ? "rising" : mean < -1 ? "cooling" : "steady";
  return measured(value, "athlete_intelligence", "MEDIUM", latestAsOf(feats) ?? now,
    growth.map((_, i) => `social.followers_growth_pct[${i}]`), "mean_followers_growth_pct") as AthleteState["audienceTrajectory"];
}

/** What the market actually paid. Counted here, so `athlete_state` is a legitimate MEASURED owner. */
export function commercialPositionFrom(
  dealRows: Array<{ id: string; brand_name: string; status: string | null; amount: unknown; amount_cash: unknown }>,
  feats: Array<{ feature_key: string }>,
  now: string,
  inbound: StateInboundSignal[] = [],
): CommercialPosition {
  // Distinct states, distinct counts. `detected` is contact, not commerce.
  const count = (st: string) => dealRows.filter((d) => d.status === st).length;
  const pipeline = { detected: count("detected"), negotiating: count("negotiating"), rejected: count("rejected"), accepted: count("accepted"), completed: count("completed") };
  const earned = dealRows.filter((d) => d.status && (EARNED_STATUSES as readonly string[]).includes(d.status));
  const amounts = earned.map((d) => Number(d.amount)).filter((n) => Number.isFinite(n) && n > 0);
  const cash = earned.map((d) => Number(d.amount_cash)).filter((n) => Number.isFinite(n));
  const totalAmt = amounts.reduce((a, b) => a + b, 0);
  const totalCash = cash.reduce((a, b) => a + b, 0);

  return {
    closedDeals: measured(earned.length, "athlete_state", "HIGH", now, earned.map((d) => d.id), "count_deals_at_earned_status"),
    activeRelationships: measured([...new Set(earned.map((d) => d.brand_name))], "athlete_state", "HIGH", now,
      earned.map((d) => d.id), "distinct_brand_at_earned_status"),
    demonstratedEconomics: amounts.length
      ? measured({ low: Math.min(...amounts), high: Math.max(...amounts), currency: "USD" as const }, "athlete_state", "HIGH", now,
        earned.map((d) => d.id), "min_max_closed_deal_amount")
      : missing("athlete_state", "no closed deal carries an amount", now),
    cashShare: totalAmt > 0 ? measured(totalCash / totalAmt, "athlete_state", "HIGH", now, earned.map((d) => d.id), "cash_over_total_closed") : undefined,
    // KNOWN WEAKNESS, recorded rather than expanded here because nothing consumes it yet. "connected_measurement"
    // fires on the existence of ANY social feature, and the existence of a follower count is not evidence about
    // price. PR4 owns rateability and should either narrow this to features that bear on pricing or drop the middle
    // band entirely. Left as-is deliberately: it drives no behaviour in PR1.
    pricingEvidence: amounts.length ? "athlete_transactions"
      : feats.length ? "connected_measurement"
        : "none",
    pipeline: measured(pipeline, "athlete_state", "HIGH", now, dealRows.map((d) => d.id), "count_deals_by_status"),
    inbound,
  };
}

/**
 * Onboarding intent, LABELLED. The athlete selected these from a fixed set at a point in time. That is evidence of
 * intent — she actually said it — and it is not a current strategic objective. The label is what keeps a downstream
 * reader from promoting "grow_my_following (onboarding choice)" into "her objective is audience growth".
 */
export function onboardingPreferencesFrom(a: {
  goal_archetype?: string | null; secondary_goals?: unknown; claimed_at?: Date | null; created_at?: Date | null;
}): StatePreference[] {
  const at = (a.claimed_at ?? a.created_at)?.toISOString() ?? null;
  const out: StatePreference[] = [];
  const push = (value: string, locator: string) => out.push({
    subject: `onboarding_goal.${value}`,
    stance: "wants",
    source: { source: "onboarding", locator, asOf: at ?? new Date(0).toISOString() },
    note: value,
    recordedAs: { method: "onboarding_v1_choice", at },
  });
  if (typeof a.goal_archetype === "string" && a.goal_archetype.trim()) push(a.goal_archetype, "athletes.goal_archetype");
  const secondary = Array.isArray(a.secondary_goals) ? a.secondary_goals : [];
  secondary.forEach((g, i) => { if (typeof g === "string" && g.trim() && g !== a.goal_archetype) push(g, `athletes.secondary_goals[${i}]`); });
  return out;
}

/** The athlete's classified inbox as a compact signal list. Most recent first, capped, never an amount. */
export function inboundFrom(
  threads: Array<{ id: string; classification: unknown; last_message_at: Date | null; status: string | null }>,
  cap = 12,
): StateInboundSignal[] {
  const out: StateInboundSignal[] = [];
  for (const t of threads) {
    const c = (t.classification ?? null) as any;
    if (!c || typeof c !== "object" || typeof c.category !== "string" || !c.category) continue;
    const counterparty = [c.brand_name, c.advertiser].find((x) => typeof x === "string" && x.trim()) ?? null;
    const deadline = typeof c.deadline === "string" && !Number.isNaN(Date.parse(c.deadline)) ? c.deadline : null;
    out.push({
      category: String(c.category),
      counterparty: counterparty ? String(counterparty) : null,
      deadline,
      confidence: typeof c.confidence === "number" ? c.confidence : null,
      lastMessageAt: t.last_message_at?.toISOString() ?? new Date(0).toISOString(),
      threadStatus: t.status ?? null,
      evidence: { source: "inbox", locator: t.id, asOf: t.last_message_at?.toISOString() ?? new Date(0).toISOString() },
    });
    if (out.length >= cap) break;
  }
  return out;
}

/** Latest composition per platform, top buckets only. */
export function audienceFrom(
  dist: Array<{ id: string | number; platform: string | null; dimension: string; bucket: string; pct: unknown; observed_at: Date | null }>,
  feats: Array<{ platform: string | null; feature_key: string; value: unknown; as_of: Date | null }>,
): StateAudience[] {
  const byPlat = new Map<string, typeof dist>();
  for (const r of dist) { if (!r.platform) continue; byPlat.set(r.platform, [...(byPlat.get(r.platform) ?? []), r]); }
  const out: StateAudience[] = [];
  for (const [platform, rows] of byPlat) {
    const latest = Math.max(...rows.map((r) => r.observed_at?.getTime() ?? 0));
    const cur = rows.filter((r) => (r.observed_at?.getTime() ?? 0) === latest);
    const top = (dim: string) => cur.filter((r) => r.dimension === dim).map((r) => ({ bucket: r.bucket, pct: Number(r.pct), id: r.id }))
      .filter((b) => Number.isFinite(b.pct)).sort((a, b) => b.pct - a.pct);
    const country = top("country")[0], age = top("age")[0], gender = top("gender");
    // Several rows per key exist over time; the LATEST observation is the one that describes the audience now.
    const fl = latestFirst(feats).find((f) => f.platform === platform && f.feature_key === "followers_latest");
    const asOf = new Date(latest || 0).toISOString();
    out.push({
      platform,
      followers: fl && Number.isFinite(Number(fl.value))
        ? measured(Number(fl.value), "athlete_intelligence", "HIGH", fl.as_of?.toISOString() ?? asOf, [`${platform}.followers_latest`], "social_features")
        : missing("athlete_intelligence", "no follower measurement", asOf),
      ...(country ? { topCountry: { bucket: country.bucket, pct: country.pct } } : {}),
      ...(age ? { topAge: { bucket: age.bucket, pct: age.pct } } : {}),
      ...(gender.length ? { gender: gender.map((g) => ({ bucket: g.bucket, pct: g.pct })) } : {}),
      asOf,
      evidence: [country, age, ...gender].filter(Boolean).slice(0, 6).map((b: any) => ({ source: "social" as const, locator: `${platform}.audience#${b.id}`, asOf })),
    });
  }
  return out.sort((a, b) => a.platform.localeCompare(b.platform));
}

/** Format and cadence performance per platform, from computed features. */
export function contentPerformanceFrom(
  feats: Array<{ platform: string | null; feature_key: string; value: unknown; value_json?: unknown; as_of: Date | null }>,
): StateContentPerformance[] {
  const plats = [...new Set(feats.map((f) => f.platform).filter((p): p is string => !!p))].sort();
  const out: StateContentPerformance[] = [];
  for (const platform of plats) {
    const mine = latestFirst(feats).filter((f) => f.platform === platform);
    const num = (k: string) => { const f = mine.find((x) => x.feature_key === k); const v = Number(f?.value); return f && Number.isFinite(v) ? v : undefined; };
    const json = (k: string) => { const f = mine.find((x) => x.feature_key === k) as any; return f?.value_json ?? undefined; };
    const keys = ["posts_per_week", "days_since_last_post", "format_mix", "reach_median_by_format", "top_decile_share", "breakout_rate"];
    if (!keys.some((k) => mine.some((x) => x.feature_key === k))) continue;
    const asOf = latestAsOf(mine) ?? new Date(0).toISOString();
    out.push({
      platform,
      postsPerWeek: num("posts_per_week"), daysSinceLastPost: num("days_since_last_post"),
      formatMix: json("format_mix"), reachMedianByFormat: json("reach_median_by_format"),
      topDecileShare: num("top_decile_share"), breakoutRate: num("breakout_rate"),
      asOf,
      evidence: keys.filter((k) => mine.some((x) => x.feature_key === k)).map((k) => ({ source: "social" as const, locator: `${platform}.${k}`, asOf })),
    });
  }
  return out;
}

/** Floors, agent, agency — as stated. A floor is not a market value. */
export function representationFrom(a: { deal_preferences?: unknown }, now: string): StateRepresentation | null {
  const p = (a.deal_preferences ?? null) as any;
  if (!p || typeof p !== "object") return null;
  const floors = Object.entries((p.minimum_rates ?? {}) as Record<string, unknown>)
    .map(([key, v]) => ({ key, amount: Number(v) })).filter((f) => Number.isFinite(f.amount) && f.amount > 0)
    .sort((x, y) => x.key.localeCompare(y.key));
  const agent = typeof p.agent_name === "string" && p.agent_name.trim() ? p.agent_name : null;
  const agency = typeof p.agency_name === "string" && p.agency_name.trim() ? p.agency_name : null;
  if (!floors.length && !agent && !agency) return null;
  return { agent, agency, floors, evidence: { source: "assertion", locator: "athletes.deal_preferences", asOf: now } };
}

/** Only populated real-world dates, each carrying what it means. Sorted ascending. */
export function datesFrom(
  dealRows: Array<{ id: string; brand_name: string; status: string | null; term_end?: unknown }>,
  affiliations: Array<{ id: string; org_name: string; started_on?: unknown; ended_on: unknown }>,
  inbound: StateInboundSignal[],
  now: string,
): StateDate[] {
  const out: StateDate[] = [];
  const iso = (d: unknown) => (typeof d === "string" && !Number.isNaN(Date.parse(d)) ? d : d instanceof Date ? d.toISOString().slice(0, 10) : null);
  for (const d of dealRows) {
    const t = iso(d.term_end);
    if (t && (d.status === "accepted" || d.status === "completed" || d.status === "negotiating")) {
      out.push({ kind: "deal_term_end", date: t, subject: `${d.brand_name} (${d.status})`, evidence: { source: "deals", locator: d.id, asOf: now } });
    }
  }
  for (const a of affiliations.filter((x) => !x.ended_on)) {
    const t = iso(a.started_on);
    if (t) out.push({ kind: "affiliation_started", date: t, subject: a.org_name, evidence: { source: "affiliation", locator: a.id, asOf: now } });
  }
  for (const i of inbound) {
    if (i.deadline) out.push({ kind: "inbound_deadline", date: i.deadline, subject: `${i.counterparty ?? "inbound"} (${i.category})`, evidence: i.evidence });
  }
  return out.sort((x, y) => x.date.localeCompare(y.date));
}

/**
 * 1.3.0 — how State reads each field of the asserted vocabulary (server/mila/onboarding.ts ASSERTED_FIELDS), BY TYPE.
 * Before 1.3.0 State matched field NAMES against patterns, which silently dropped `never_post` (the one "what I don't
 * want" field), `brands_causes`, `hobbies` and every free `note`. Fields absent here keep the old name-matching
 * fallback, so nothing that reached State before stops reaching it. Identity fields are projected elsewhere and
 * `cadence` / `brand_voice` have no State reader by design; they are listed as `none` so the choice is explicit.
 */
export const ASSERTED_AS: Record<string, "constraint" | "want" | "interest" | "note" | "direction" | "none"> = {
  never_post: "constraint",
  goal: "want", secondary_goals: "want", brands_wanted: "want",
  brands_causes: "interest", hobbies: "interest",
  note: "note",
  direction: "direction",   // 1.4.0: her direction — its own class; never a preference, a constraint or a note
  cadence: "none", brand_voice: "none",
  position: "none", class_year: "none", hometown: "none", sport: "none", school: "none",
  affiliations: "none", career_status: "none", nickname: "none",
  // Concept 0.4: her governance of the synthesised identity — read by Identity Intelligence only.
  "identity.preferred_emphasis": "none", "identity.de_emphasize": "none", "identity.preferred_language": "none",
  "identity.avoid_language": "none", "identity.approved_statement": "none", dispute: "none", claim_confirmation: "none",
  // Brand imagery pipeline: her "Confirm this is [brand]" answer — about a brand's identity, never about her.
  brand_identity: "none",
};

/** 1.3.0. Her free notes, verbatim, cited to the assertion. Nothing is inferred from them. */
/** 1.4.0. Her current direction (the live `direction` assertion), verbatim — or nothing. */
export function directionOf(
  assertions: Array<{ id: string; field: string; value: unknown; said: string | null; created_at: Date | null }>,
  now: string,
): { athleteDirection?: AthleteState["athleteDirection"] } {
  const a = assertions.find((x) => ASSERTED_AS[x.field] === "direction");
  const v = a?.value as unknown;
  const statement = typeof v === "string" ? v.trim() : v && typeof v === "object" && typeof (v as any).text === "string" ? (v as any).text.trim() : "";
  if (!a || !statement) return {};
  return { athleteDirection: {
    statement,
    ...(a.said && a.said.trim() !== statement ? { said: a.said.trim() } : {}),
    source: { source: "assertion" as const, locator: a.id, asOf: a.created_at?.toISOString() ?? now },
  } };
}

export function notesFrom(
  assertions: Array<{ id: string; field: string; value: unknown; said: string | null; created_at: Date | null }>,
  now: string,
): Array<{ text: string; said?: string; source: { source: "assertion"; locator: string; asOf: string } }> {
  // A note is stored as a plain string or as { text } (the onboarding/chat writers use the latter — the live Mia trace
  // found it; the first synthetic test only covered the string and so missed her real note).
  const textOf = (v: unknown): string | null =>
    typeof v === "string" ? v.trim() || null
    : v && typeof v === "object" && typeof (v as any).text === "string" ? (v as any).text.trim() || null
    : null;
  return assertions
    .filter((a) => ASSERTED_AS[a.field] === "note" && textOf(a.value) !== null)
    .map((a) => {
      const text = textOf(a.value)!;
      return {
        text,
        ...(a.said && a.said.trim() !== text ? { said: a.said.trim() } : {}),
        source: { source: "assertion" as const, locator: a.id, asOf: a.created_at?.toISOString() ?? now },
      };
    });
}

/**
 * 1.3.0. Contract exclusivity SHE VERIFIED. Read from a deal carrying a contract she uploaded and reviewed: her
 * review must have confirmed the clause (`raw_data.confirmed.exclusivity === true`). Her word is the authority — the
 * extraction only supplies the scope text when it found one. An extracted-but-unconfirmed clause is not a bound — it is
 * a reading she has not checked — so it is not projected. Interpretation stays in the contract path; State only reads
 * its confirmed result.
 */
export function contractExclusivityFrom(
  rows: Array<{ id: string; brand_name: string | null; status: string | null; term_end: unknown; raw_data: any; created_at: Date | null }>,
  now: string,
): StateConstraint[] {
  const out: StateConstraint[] = [];
  const iso = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : v instanceof Date ? v.toISOString().slice(0, 10) : null);
  for (const d of rows) {
    if (d.status !== "accepted" && d.status !== "negotiating") continue;
    const ex = d.raw_data?.contract?.exclusivity ?? null;
    const confirmed = d.raw_data?.confirmed?.exclusivity;
    if (confirmed !== true) continue;
    const at = typeof d.raw_data?.confirmed?.at === "string" ? d.raw_data.confirmed.at : d.created_at?.toISOString() ?? now;
    out.push({
      key: `contract.${d.id}.exclusivity`,
      kind: "exclusivity",
      basis: measured(
        { brand: d.brand_name ?? null, scope: typeof ex?.scope === "string" ? ex.scope : null, status: d.status, termEnd: iso(d.term_end) },
        "athlete_intelligence", "HIGH", at, [d.id], "contract_upload_confirmed_by_athlete",
      ),
      evidence: [{ source: "deals", locator: d.id, asOf: at }],
    });
  }
  return out;
}

/**
 * Bounds on what may be recommended.
 *
 * Only what is recorded. Nomila does not today represent season windows, eligibility rules or exclusivity terms as
 * structured data, so most athletes will have few or no constraints here — and an empty list means "we have not
 * recorded any", never "there are none".
 */
export function constraintsFrom(
  assertions: Array<{ id: string; field: string; value: unknown; created_at: Date | null }>,
  now: string,
): StateConstraint[] {
  const out: StateConstraint[] = [];

  // Affiliations are deliberately NOT read here. Being at a university, on a roster or at a club is context, not a
  // bound on what Nomila may recommend; it lives in identity.competitionContext. The constraints such an
  // affiliation may imply — a season window, an eligibility rule, a sponsor exclusivity — are not represented in
  // Nomila today, and an empty list is the truthful report of that rather than an invented restriction.
  for (const a of assertions.filter((x) => ASSERTED_AS[x.field] === "constraint" || (!(x.field in ASSERTED_AS) && /availab|constraint|schedule|eligib/i.test(x.field)))) {
    out.push({
      key: `asserted.${a.field}`,
      kind: a.field,
      basis: measured(a.value, "athlete_intelligence", "HIGH", a.created_at?.toISOString() ?? now, [a.id], "athlete_asserted"),
      evidence: [{ source: "assertion", locator: a.field, asOf: a.created_at?.toISOString() ?? now }],
    });
  }
  return out;
}

/**
 * What the athlete has said they want.
 *
 * Recorded verbatim in stance and note, never reconciled against what Nomila thinks is attractive. Keeping these
 * apart is what lets a downstream surface say "this could be valuable, but you told me you do not want it" instead
 * of silently dropping the recommendation or silently overriding the athlete.
 */
export function preferencesFrom(
  assertions: Array<{ field: string; value: unknown; said: string | null; created_at: Date | null }>,
): StatePreference[] {
  const out: StatePreference[] = [];
  for (const a of assertions) {
    // 1.3.0: a field the vocabulary TYPES is read by its type; only an untyped field falls back to name matching.
    const typed = ASSERTED_AS[a.field];
    if (typed !== undefined && typed !== "want" && typed !== "interest") continue;
    if (typed === undefined && !/prefer|want|avoid|refus|wont|won_t|interest|goal/i.test(a.field)) continue;
    const raw = typeof a.value === "string" ? a.value : JSON.stringify(a.value ?? null);
    out.push({
      subject: a.field,
      // Stance is read from the field's own vocabulary; nothing is inferred from the free text, because guessing an
      // athlete's willingness from prose is exactly the kind of judgment State is not entitled to make. Brands and
      // causes she loves, and what she does off the field, are interests — `open`, never read as a wish to partner.
      stance: typed === "interest" ? "open" : /avoid|refus|wont|won_t/i.test(a.field) ? "avoids" : /want|goal|interest/i.test(a.field) ? "wants" : "open",
      source: { source: "assertion", locator: a.field, asOf: a.created_at?.toISOString() ?? new Date(0).toISOString() },
      note: a.said ?? (typeof raw === "string" && raw.length < 300 ? raw : undefined),
    });
  }
  return out;
}

/** Primary affiliation, in whatever vocabulary the sport uses. Never coerced into a division or a league. */
export function competitionContextFrom(
  affiliations: Array<{ org_name: string; level: string | null; is_primary: boolean; ended_on: unknown }>,
): string | null {
  const live = affiliations.filter((a) => !a.ended_on);
  const primary = live.find((a) => a.is_primary) ?? live[0];
  if (!primary) return null;
  return [primary.org_name, primary.level].filter(Boolean).join(" · ") || null;
}

/** Newest observation first, so a `find` by key returns the current value rather than the oldest row. */
function latestFirst<T extends { as_of: Date | null }>(feats: T[]): T[] {
  return [...feats].sort((a, b) => (b.as_of?.getTime() ?? 0) - (a.as_of?.getTime() ?? 0));
}

function latestAsOf(feats: Array<{ as_of?: Date | null }>): string | null {
  const ts = feats.map((f) => f.as_of?.getTime()).filter((t): t is number => typeof t === "number");
  return ts.length ? new Date(Math.max(...ts)).toISOString() : null;
}
