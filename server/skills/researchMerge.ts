/**
 * researchMerge.ts — two pure rules that stop research from lowering a score by accident.
 *
 * Found on the first signup-time research run: an athlete with connected accounts was
 * re-scored from 653 to 557. Two causes, two rules:
 *
 *   1. mergeSocialSources — research used PUBLIC discovery data for social even when the
 *      athlete's CONNECTED analytics existed. Connected platforms now win; discovery only fills
 *      platforms the athlete has not connected. An athlete with nothing connected is still
 *      scored from discovery — waitlist signups who skipped step 5 keep a score.
 *
 *   2. unionResearch — extraction is nondeterministic: one run finds nine achievements, the
 *      next finds six, and the score falls with no new fact. Per LIST, the richest single run
 *      wins (fresh on a tie), so research never forgets what its best run found. NOT a set
 *      union across runs: tried live, it stacked near-duplicates ("ACC Champion" / "ACC
 *      Champions 2025") and scored an athlete Elite with 57 achievements. Richest-run is
 *      bounded by what one extraction produced. Scalars prefer the fresh value.
 *
 * Pure: no db, no model. Tested in researchMerge.test.ts.
 */

import type { SnapshotSocial } from "../services/snapshotSocial";

// ─── Social ───────────────────────────────────────────────────────────────────

const PLATFORMS = ["instagram", "tiktok", "x", "youtube"] as const;

/** Mirror of fetchSocialData/refreshScores' recomputeComputed, kept here so this module stays pure. */
export function recomputeComputedSocial(s: SnapshotSocial, dataTier: "connected" | "discovery"): NonNullable<SnapshotSocial["_computed"]> {
  const total = (s.instagram?.followers ?? 0) + (s.tiktok?.followers ?? 0) + (s.x?.followers ?? 0) + (s.youtube?.subscribers ?? 0);
  const rates = [s.instagram?.engagement_rate, s.tiktok?.engagement_rate, s.youtube?.engagement_rate, s.x?.engagement_rate]
    .filter((r): r is number => r !== undefined && r > 0);
  const avgEng = rates.length ? Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 100) / 100 : 0;
  const freq = Math.max(s.instagram?.posts_last_30d ?? 0, s.tiktok?.posts_last_30d ?? 0, s.youtube?.posts_last_30d ?? 0);
  const platformCount = [s.instagram, s.tiktok, s.x, s.youtube].filter(Boolean).length;
  const igE = s.instagram?.engagement_rate, tkE = s.tiktok?.engagement_rate;
  const cross = igE && tkE ? Math.round((Math.min(igE, tkE) / Math.max(igE, tkE)) * 100) / 100 : undefined;
  return {
    total_followers:            total > 0 ? total : undefined,
    avg_engagement_rate:        avgEng > 0 ? avgEng : undefined,
    content_frequency:          freq > 0 ? freq : undefined,
    platform_count:             platformCount > 0 ? platformCount : undefined,
    cross_platform_consistency: cross,
    data_tier:                  dataTier,
  };
}

/**
 * Connected platforms win; discovery fills the rest. Returns null when neither has anything.
 * data_tier is "connected" only when every platform present came from the connected source.
 */
export function mergeSocialSources(connected: SnapshotSocial | null | undefined, discovery: SnapshotSocial | null | undefined): SnapshotSocial | null {
  if (!connected && !discovery) return null;
  const out: SnapshotSocial = {};
  let any = false, allConnected = true;
  for (const p of PLATFORMS) {
    const c = connected?.[p];
    const d = discovery?.[p];
    if (c) { (out as any)[p] = c; any = true; }
    else if (d) { (out as any)[p] = d; any = true; allConnected = false; }
  }
  if (!any) return null;
  out._computed = recomputeComputedSocial(out, allConnected ? "connected" : "discovery");
  return out;
}

// ─── Research ─────────────────────────────────────────────────────────────────

export interface ResearchLists {
  profile: Record<string, string | null | undefined>;
  social_handles: Record<string, string | null | undefined>;
  achievements: Array<{ name: string; year?: string | null; level?: string | null }>;
  press_mentions: Array<{ outlet: string; headline: string; date?: string | null }>;
  brand_deals: Array<{ brand: string; type?: string | null; confidence?: number | string | null }>;
  nil_valuation_mentions: Array<{ source: string; value: string }>;
  media_assets: { images: unknown[]; videos: unknown[]; audio: unknown[] };
  story_arc: string | null;
  sentiment: { positive: number; negative: number } | null;
}

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const conf = (c: unknown) => (typeof c === "number" ? c : parseFloat(String(c ?? "0")) || 0);

/** Deduplicate one list by key (a run can repeat itself too), keeping the preferred duplicate. */
function dedupe<T>(list: T[] | undefined, key: (t: T) => string, pick?: (a: T, b: T) => T): T[] {
  const out = new Map<string, T>();
  for (const item of list ?? []) {
    const k = key(item);
    if (!k) continue;
    const existing = out.get(k);
    out.set(k, existing && pick ? pick(existing, item) : (existing ?? item));
  }
  return [...out.values()];
}

/** The richer of two lists after dedupe; fresh wins a tie. Bounded by one run's output. */
function richest<T>(prior: T[] | undefined, fresh: T[] | undefined, key: (t: T) => string, pick?: (a: T, b: T) => T): T[] {
  const p = dedupe(prior, key, pick);
  const f = dedupe(fresh, key, pick);
  return f.length >= p.length ? f : p;
}

/**
 * Fresh research, with any list the fresh run found LESS of replaced by the richest prior run's
 * list. Fresh scalars win when present. Never a union across runs — see the header.
 */
export function unionResearch<T extends ResearchLists>(prior: Partial<ResearchLists> | null | undefined, fresh: T): T {
  if (!prior) return fresh;
  const urlKey = (m: unknown) => norm((m as any)?.url);
  return {
    ...fresh,
    profile:        { ...(prior.profile ?? {}), ...Object.fromEntries(Object.entries(fresh.profile ?? {}).filter(([, v]) => v)) },
    social_handles: { ...(prior.social_handles ?? {}), ...Object.fromEntries(Object.entries(fresh.social_handles ?? {}).filter(([, v]) => v)) },
    achievements:   richest(prior.achievements, fresh.achievements, (a) => `${norm(a.name)}|${norm(a.year)}`),
    press_mentions: richest(prior.press_mentions, fresh.press_mentions, (p) => `${norm(p.outlet)}|${norm(p.headline)}`),
    brand_deals:    richest(prior.brand_deals, fresh.brand_deals, (b) => norm(b.brand), (a, b) => (conf(b.confidence) >= conf(a.confidence) ? b : a)),
    nil_valuation_mentions: richest(prior.nil_valuation_mentions, fresh.nil_valuation_mentions, (n) => `${norm(n.source)}|${norm(n.value)}`),
    media_assets: {
      images: richest(prior.media_assets?.images, fresh.media_assets?.images, urlKey),
      videos: richest(prior.media_assets?.videos, fresh.media_assets?.videos, urlKey),
      audio:  richest(prior.media_assets?.audio,  fresh.media_assets?.audio,  urlKey),
    },
    story_arc: fresh.story_arc ?? prior.story_arc ?? null,
    sentiment: fresh.sentiment ?? prior.sentiment ?? null,
  };
}
