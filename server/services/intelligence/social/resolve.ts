/**
 * social/resolve.ts — source precedence at the metric and window level (Step 1 design §6).
 *
 * For one (entity, metric) the resolver looks at every observation at or before as_of, grouped
 * by source class, and walks the authority order
 *     connected_verified > platform_public > web_researched > imputed
 * taking the first class that has an observation FRESH enough for that class. Lower classes are
 * ignored for calculation but stay in the table; the decision is recorded so a feature can
 * explain itself. `inferred` never competes here — it is a feature, not an observation.
 * No candidate of any class → null. Unknown stays unknown; there is no zero.
 *
 * Pure: takes rows, returns a decision.
 */

import type { SourceClass } from "../types";

export const AUTHORITY: SourceClass[] = ["connected_verified", "platform_public", "web_researched", "imputed"];

export interface ResolvableObservation {
  id?: number | string;
  entityType: string;
  entityId: string;
  entityTime?: string | null;
  entityFormat?: string | null;
  metricKey: string;
  value: number;
  sourceClass: SourceClass;
  sourceMethod: string;
  observedAt: string;
  windowStart?: string | null;
  windowEnd?: string | null;
}

export interface FreshnessDays { connected_verified: number; platform_public: number; web_researched: number; imputed: number }

export interface Resolution {
  value: number;
  observedAt: string;
  sourceClass: SourceClass;
  sourceMethod: string;
  observationId?: number | string;
  /** Candidate counts per class, and which classes were skipped for staleness. */
  candidates: Partial<Record<SourceClass, number>>;
  staleSkipped: SourceClass[];
}

const ms = (iso: string) => new Date(iso).getTime();

/** Latest observation at or before `at`, by authority with freshness. */
export function resolveLatest(obs: ResolvableObservation[], at: string, freshness: FreshnessDays): Resolution | null {
  const atMs = ms(at);
  const byClass = new Map<SourceClass, ResolvableObservation[]>();
  for (const o of obs) {
    if (ms(o.observedAt) > atMs) continue;
    if (o.sourceClass === "inferred") continue;
    (byClass.get(o.sourceClass) ?? byClass.set(o.sourceClass, []).get(o.sourceClass)!).push(o);
  }
  const candidates: Partial<Record<SourceClass, number>> = {};
  for (const [c, list] of byClass) candidates[c] = list.length;
  const staleSkipped: SourceClass[] = [];
  for (const cls of AUTHORITY) {
    const list = byClass.get(cls);
    if (!list?.length) continue;
    const latest = list.reduce((a, b) => (ms(b.observedAt) > ms(a.observedAt) ? b : a));
    const maxAge = ((freshness as unknown as Record<string, number>)[cls] ?? 0) * 86_400_000;
    if (atMs - ms(latest.observedAt) > maxAge) { staleSkipped.push(cls); continue; }
    return { value: latest.value, observedAt: latest.observedAt, sourceClass: cls, sourceMethod: latest.sourceMethod, observationId: latest.id, candidates, staleSkipped };
  }
  return null;
}

/**
 * The observation nearest to `at` (at or before, else the first after) within `toleranceDays`,
 * for growth calculations. Authority applies within the tolerance band; freshness does not, since
 * we are deliberately looking into the past.
 */
export function resolveNearest(obs: ResolvableObservation[], at: string, toleranceDays: number): Resolution | null {
  const atMs = ms(at), tol = toleranceDays * 86_400_000;
  const inBand = obs.filter((o) => o.sourceClass !== "inferred" && Math.abs(ms(o.observedAt) - atMs) <= tol);
  if (!inBand.length) return null;
  const candidates: Partial<Record<SourceClass, number>> = {};
  for (const o of inBand) candidates[o.sourceClass] = (candidates[o.sourceClass] ?? 0) + 1;
  for (const cls of AUTHORITY) {
    const list = inBand.filter((o) => o.sourceClass === cls);
    if (!list.length) continue;
    const best = list.reduce((a, b) => (Math.abs(ms(b.observedAt) - atMs) < Math.abs(ms(a.observedAt) - atMs) ? b : a));
    return { value: best.value, observedAt: best.observedAt, sourceClass: cls, sourceMethod: best.sourceMethod, observationId: best.id, candidates, staleSkipped: [] };
  }
  return null;
}

/** Group observations by (entityType, entityId, metricKey). */
export function groupByEntityMetric(obs: ResolvableObservation[]): Map<string, ResolvableObservation[]> {
  const m = new Map<string, ResolvableObservation[]>();
  for (const o of obs) {
    const k = `${o.entityType}|${o.entityId}|${o.metricKey}`;
    (m.get(k) ?? m.set(k, []).get(k)!).push(o);
  }
  return m;
}

/** The lowest authority among a set of classes (the conservative summary a feature carries). */
export function lowestAuthority(classes: SourceClass[]): SourceClass {
  let worst = 0;
  for (const c of classes) { const i = AUTHORITY.indexOf(c); if (i > worst) worst = i; }
  return AUTHORITY[worst] ?? "imputed";
}
