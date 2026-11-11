/**
 * socialFromAnalytics.ts — the athlete's best social row per platform, in the snapshot's SnapshotSocial shape.
 *
 * Moved out of skills/refreshScores.ts when the nightly legacy re-score was retired (legacy retirement P2-4,
 * 8 Oct 2026): research still writes `athlete_snapshots.social` from the CONNECTED analytics when they exist (public
 * discovery only fills the gaps), and first-look reads that snapshot. Byte for byte the code it was.
 */
import type { SocialAnalyticsSnapshot } from "../../shared/schema";
import type { SnapshotSocial, SnapshotSocialPlatform } from "../services/snapshotSocial";

// Mirror of fetchSocialData.recomputeComputed so scoring reads the same _computed shape.
function recomputeComputed(s: SnapshotSocial, dataTier: "connected" | "discovery"): NonNullable<SnapshotSocial["_computed"]> {
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

// ── Source-precedence resolver ─────────────────────────────────────────────────
// A platform can have rows from multiple provenances (connected/discovery/…).
// Pick the highest-fidelity source among *current* rows; a higher-fidelity source
// wins even if slightly older, but only within FRESH_DAYS — so a disconnected
// platform (stale connected row) correctly falls through to a fresh discovery row.
const SOURCE_FIDELITY: Record<string, number> = { connected: 4, provider: 3, discovery: 2, research: 1 };
const FRESH_DAYS = 45;

// Analytics `source` column → the per-platform source label scoring/UI understand.
function platformSourceLabel(source: string, platform: string): NonNullable<SnapshotSocialPlatform["source"]> {
  if (source === "connected" || source === "provider") return "connected";
  return platform === "youtube" ? "data_api" : "business_discovery";
}

/** Best row per platform: highest fidelity among fresh rows (tie → newest); else newest overall. */
function pickBestPerPlatform(rows: SocialAnalyticsSnapshot[]): Record<string, SocialAnalyticsSnapshot> {
  const cutoff = new Date(Date.now() - FRESH_DAYS * 864e5).toISOString().slice(0, 10);
  const byPlatform: Record<string, SocialAnalyticsSnapshot[]> = {};
  for (const r of rows) (byPlatform[r.platform] ??= []).push(r);   // rows arrive newest-first

  const best: Record<string, SocialAnalyticsSnapshot> = {};
  for (const [platform, prows] of Object.entries(byPlatform)) {
    const fresh = prows.filter((r) => (r.snapshot_day as string) >= cutoff);
    const pool = fresh.length ? fresh : prows;
    let pick = pool[0];                                            // newest in pool
    for (const r of pool) {
      if ((SOURCE_FIDELITY[r.source] ?? 0) > (SOURCE_FIDELITY[pick.source] ?? 0)) pick = r;  // strict > keeps newest on ties
    }
    best[platform] = pick;
  }
  return best;
}

/** Best-source row per platform → SnapshotSocial (labelled by provenance). Exported so research
 *  records the athlete's CONNECTED social when it exists, not public discovery data. */
export function buildSocialFromAnalytics(rows: SocialAnalyticsSnapshot[]): SnapshotSocial {
  const best = pickBestPerPlatform(rows);

  const social: SnapshotSocial = {};
  let allConnected = true;
  for (const [platform, row] of Object.entries(best)) {
    if (row.source !== "connected") allConnected = false;
    const p: SnapshotSocialPlatform = {
      followers:       row.followers ?? 0,
      engagement_rate: row.avg_engagement_rate ?? 0,
      posts_last_30d:  row.posts_last_30d ?? 0,
      verified:        row.is_verified ?? false,
      source:          platformSourceLabel(row.source, platform),
      fetched_at:      row.snapshot_date ? new Date(row.snapshot_date as unknown as string).toISOString() : undefined,
    };
    if      (platform === "instagram") social.instagram = p;
    else if (platform === "tiktok")    social.tiktok    = p;
    else if (platform === "x")         social.x         = p;
    else if (platform === "youtube")   social.youtube   = { ...p, subscribers: row.followers ?? 0 };
  }
  social._computed = recomputeComputed(social, allConnected ? "connected" : "discovery");
  return social;
}
