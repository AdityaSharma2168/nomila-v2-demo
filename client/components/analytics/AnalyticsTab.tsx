import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Image } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Bold, Fonts, Colors, Spacing, BorderRadius } from "../../constants/theme";
import { useAnalytics, useAnalyticsHistory, type AnalyticsSnapshot, type SnapshotMedia } from "../../hooks/use-analytics";
import { AudienceDonut } from "./AudienceDonut";
import { MetricRing } from "./MetricRing";
import { Sparkline } from "./Sparkline";
import { MediaGallery } from "../media/MediaGallery";
import { PlatformIcon } from "../PlatformIcon";

const PLATFORM_COLOR: Record<string, string> = {
  instagram: Colors.light.instagram, tiktok: Colors.light.tiktok, youtube: Colors.light.youtube,
};
const PLATFORM_LABEL: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" };
const GENDER_LABEL: Record<string, string> = { F: "Female", M: "Male", U: "Unknown", female: "Female", male: "Male", gender_other: "Other" };
const TRAFFIC_LABEL: Record<string, string> = {
  YT_SEARCH: "Search", RELATED_VIDEO: "Suggested", PLAYLIST: "Playlists", SUBSCRIBER: "Subscriptions",
  EXT_URL: "External", NO_LINK_OTHER: "Direct", NOTIFICATION: "Notifications", SHORTS: "Shorts feed", ADVERTISING: "Ads",
};

// ── formatting ──
function fmtCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (Math.abs(n) >= 1_000)     return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return n.toLocaleString();
}
const fmtPct = (n: number | null | undefined) => (n == null ? "—" : `${n.toFixed(1)}%`);
function fmtWatch(sec: number | null | undefined): string {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
// Ring fill = value ÷ band (band = the "excellent/top-tier" benchmark → a full ring means top-tier).
const ringFill = (v: number | null | undefined, band: number) => (v == null ? 0 : Math.min(100, (v / band) * 100));
// Grade by tier (benchmarks from research): ink at or above average, grey below. Never a ring colour — those mean the
// M.I.A. score (one look, 23 Oct 2026); the ring's fill already says how far she is.
function tierColor(v: number | null | undefined, avg: number, _excellent: number): string {
  if (v == null) return Colors.light.textMuted;
  if (v >= avg) return Bold.ink;
  return Bold.mute;
}

// ── Reach & virality (the hero story) ──
// A creator's real audience is everyone REACHED, not just followers — and reach is what converts to
// brand value (EMV = impressions × CPM). We surface reach/virality as the headline and label engagement
// comparatively so a credible 4.5% reads as the strength it is (≈3× the ~1.5% creator average).
const CREATOR_AVG_ENGAGEMENT = 1.5;        // 2026 creator median (Sprout/SearchLab) — the "×avg" baseline
const BREAKOUT_REACH_MULTIPLE = 2;         // reach ≥ 2× followers ⇒ majority non-follower (a breakout)

// The scale metric per platform: IG = unique reach; TikTok/YouTube = views.
function reachOf(m: SnapshotMedia): number | null {
  return m.insights?.reach ?? m.insights?.video_views ?? null;
}
function interactionsOf(m: SnapshotMedia): number | null {
  const ins = m.insights;
  if (ins?.total_interactions != null) return ins.total_interactions;
  const base = (m.like_count ?? 0) + (m.comments_count ?? 0) + (ins?.saved ?? 0) + (ins?.shares ?? 0);
  return base > 0 ? base : null;
}

interface ReachStats {
  isViews:     boolean;   // TikTok/YouTube measure "views"; IG measures "reached"
  totalReach:  number;
  peak:        number;
  multiple:    number | null;   // peak reach ÷ followers — the reach-to-follower flex
  breakoutN:   number;          // posts that broke past 2× followers
  postN:       number;
  series:      number[];        // per-post reach, oldest→newest (drives the spike sparkline)
  coreER:      number | null;   // engagement over CORE (non-breakout) content — the credible quality signal
}

// Everything derived from recent_media so the hero is self-contained (works whether or not the server
// has segmented core vs discovery). Mirrors the server's reach≥2×followers rule.
function computeReachStats(s: AnalyticsSnapshot, media: SnapshotMedia[]): ReachStats | null {
  const followers = s.followers ?? 0;
  const withReach = media
    .map((m) => ({ m, r: reachOf(m) }))
    .filter((x): x is { m: SnapshotMedia; r: number } => x.r != null && x.r > 0);
  if (!withReach.length) return null;

  const totalReach = withReach.reduce((a, x) => a + x.r, 0);
  const peak       = Math.max(...withReach.map((x) => x.r));
  const breakoutIds = new Set(
    followers > 0 ? withReach.filter((x) => x.r >= followers * BREAKOUT_REACH_MULTIPLE).map((x) => x.m.id) : [],
  );

  // Core engagement = interactions ÷ reach over non-breakout posts (how her real audience responds).
  let coreR = 0, coreI = 0;
  for (const { m, r } of withReach) {
    if (breakoutIds.has(m.id)) continue;
    const i = interactionsOf(m);
    if (i != null) { coreR += r; coreI += i; }
  }
  const coreER = coreR > 0 ? Math.round((coreI / coreR) * 1000) / 10 : (s.avg_engagement_rate ?? null);

  return {
    isViews:    s.platform !== "instagram",
    totalReach,
    peak,
    multiple:   followers > 0 ? peak / followers : null,
    breakoutN:  breakoutIds.size,
    postN:      withReach.length,
    series:     withReach.map((x) => x.r).reverse(),   // recent_media is newest-first → reverse for L→R time
    coreER,
  };
}
const fmtMultiple = (x: number) => (x >= 10 ? `${Math.round(x)}×` : `${x.toFixed(1).replace(/\.0$/, "")}×`);
// Label engagement against the creator median so a credible rate reads as the strength it is.
// Stays silent unless she's genuinely above average — no hollow "1× avg" brags.
function engMultiple(er: number | null | undefined): string | null {
  if (er == null || er <= 0) return null;
  const x = er / CREATOR_AVG_ENGAGEMENT;
  return x >= 1.15 ? `${fmtMultiple(x)} creator avg` : null;
}

// ── main ──
export function AnalyticsTab() {
  const { platforms, isLoading, error, refetch } = useAnalytics();
  const ordered = useMemo(
    () => [...platforms].sort((a, b) => (a.platform === "instagram" ? -1 : b.platform === "instagram" ? 1 : 0)),
    [platforms],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const active = selected ?? ordered[0]?.platform ?? null;
  const snapshot = ordered.find((p) => p.platform === active) ?? null;
  const { series, trends } = useAnalyticsHistory(active);
  // Hooks MUST run on every render in the same order — keep this above the early returns below and
  // guard the body for the null-snapshot case, rather than calling useMemo after a conditional return.
  const recent = snapshot?.raw_metrics?.recent_media ?? [];
  const stats = useMemo(() => (snapshot ? computeReachStats(snapshot, recent) : null), [snapshot, recent]);

  if (isLoading) return <View style={styles.stateBox}><ActivityIndicator size="small" color={Colors.light.primary} /></View>;
  if (error) {
    return (
      <View style={styles.stateBox}>
        <Feather name="alert-circle" size={20} color={Colors.light.error} />
        <Text style={styles.stateText}>Could not load analytics</Text>
        <Pressable style={styles.retryBtn} onPress={() => refetch()}><Text style={styles.retryText}>Retry</Text></Pressable>
      </View>
    );
  }
  if (!ordered.length || !snapshot) {
    return (
      <View style={styles.stateBox}>
        <View style={styles.emptyIcon}><Feather name="bar-chart-2" size={26} color="#AAAAAA" /></View>
        <Text style={styles.emptyTitle}>No analytics yet</Text>
        <Text style={styles.emptySub}>Connect Instagram, TikTok, or YouTube, then check back after the next sync.</Text>
      </View>
    );
  }

  const accent = PLATFORM_COLOR[active!] ?? Colors.light.primary;
  const yt = snapshot.raw_metrics?.youtube;
  const followerSeries = series.map((s) => s.followers ?? 0).filter((v) => v > 0);
  const growth = active === "youtube" ? (yt?.subs_net_30d ?? null) : (trends?.followers_7d ?? trends?.followers_30d ?? null);
  const growthIsCount = active === "youtube";
  const growthLabel = active === "youtube" ? "subs · 30d" : trends?.followers_7d != null ? "this week" : "this month";
  const top = bestPost(recent);
  const growthNode = growth != null && growth !== 0 ? (
    <View style={styles.growthChip}>
      <Feather name={growth > 0 ? "trending-up" : "trending-down"} size={12} color={growth > 0 ? "#1A9960" : "#C0492F"} />
      <Text style={[styles.growthText, { color: growth > 0 ? "#1A9960" : "#C0492F" }]}>
        {growth > 0 ? "+" : ""}{growthIsCount ? fmtCompact(growth) : `${growth}%`}
      </Text>
    </View>
  ) : null;

  return (
    <View style={styles.root}>
      {/* platform toggle */}
      {ordered.length > 1 && (
        <View style={styles.toggle}>
          {ordered.map((p) => {
            const on = p.platform === active;
            return (
              <Pressable key={p.platform} onPress={() => setSelected(p.platform)}
                style={[styles.toggleBtn, on && { backgroundColor: Colors.light.card, ...shadow }]}>
                <View style={{ opacity: on ? 1 : 0.45 }}>
                  <PlatformIcon platform={p.platform} color={PLATFORM_COLOR[p.platform] ?? Colors.light.text} size={15} />
                </View>
                <Text style={[styles.toggleText, on && { color: Colors.light.text }]}>{PLATFORM_LABEL[p.platform] ?? p.platform}</Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {/* ── Hero: reach & virality up top (falls back to follower count when no reach data) ── */}
      {stats ? (
        <ReachHero snapshot={snapshot} stats={stats} accent={accent} growthNode={growthNode} />
      ) : (
        <View style={styles.card}>
          <View style={styles.heroRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.handle}>@{deriveHandle(snapshot)}</Text>
              <Text style={styles.followers}>{fmtCompact(snapshot.followers)}</Text>
              <Text style={styles.followersLabel}>{active === "youtube" ? "subscribers" : "followers"}</Text>
            </View>
            <View style={styles.heroRight}>
              <View style={[styles.platformBadge, { backgroundColor: accent + "18" }]}>
                <PlatformIcon platform={active!} color={accent} size={22} />
              </View>
              {growthNode}
            </View>
          </View>
          {followerSeries.length >= 2 ? (
            <View style={styles.heroSpark}>
              <Sparkline values={followerSeries} color={accent} width={300} height={44} />
              <Text style={styles.heroSparkLbl}>{growthLabel}</Text>
            </View>
          ) : null}
        </View>
      )}

      {/* ── Performance (fused multi-metric card) ── */}
      <PerformanceCard snapshot={snapshot} accent={accent} coreER={stats?.coreER ?? null} />

      {/* ── Audience (one combined block) ── */}
      <AudienceBlock snapshot={snapshot} accent={accent} />

      {/* ── YouTube traffic sources ── */}
      {active === "youtube" && !!yt?.traffic?.length && (
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>WHERE VIEWS COME FROM</Text>
          <View style={styles.bars}>
            {yt.traffic.slice(0, 5).map((row) => (
              <View key={row.key} style={styles.barRow}>
                <Text style={[styles.barKey, { width: 88 }]} numberOfLines={1}>{TRAFFIC_LABEL[row.key] ?? row.key}</Text>
                <View style={styles.barTrack}><View style={[styles.barFill, { width: `${Math.max(4, row.pct)}%`, backgroundColor: accent }]} /></View>
                <Text style={styles.barPct}>{row.pct}%</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* ── Posts: top-post highlight (from snapshot media) or gallery fallback ── */}
      {top ? <TopPost media={top} others={recent.filter((m) => m.id !== top.id)} accent={accent} /> : <MediaGallery platform={active} />}

      <Text style={styles.updatedAt}>Updated {fmtAgo(snapshot.snapshot_date)}</Text>
    </View>
  );
}

// ── Reach & virality hero — the headline story: how many she reaches, not how many follow ──
function ReachHero({ snapshot: s, stats, accent, growthNode }: {
  snapshot: AnalyticsSnapshot; stats: ReachStats; accent: string; growthNode: React.ReactNode;
}) {
  const reachedWord = stats.isViews ? "views" : "reached";
  const followerWord = s.platform === "youtube" ? "subscribers" : "followers";
  const hasSpikes = stats.series.length >= 3;
  return (
    <View style={styles.card}>
      {/* handle + follower context (demoted) + platform badge */}
      <View style={styles.rhTop}>
        <View style={{ flex: 1 }}>
          <Text style={styles.handle}>@{deriveHandle(s)}</Text>
          <View style={styles.rhFollowerRow}>
            <Text style={styles.rhFollowerCount}>{fmtCompact(s.followers)} {followerWord}</Text>
            {growthNode}
          </View>
        </View>
        <View style={[styles.platformBadge, { backgroundColor: accent + "18" }]}>
          <PlatformIcon platform={s.platform} color={accent} size={22} />
        </View>
      </View>

      {/* the headline: total reach */}
      <View style={styles.rhHeadline}>
        <Text style={[styles.rhBigNum, { color: accent }]}>{fmtCompact(stats.totalReach)}</Text>
        <Text style={styles.rhBigLbl}>{stats.isViews ? "views" : "people reached"} · last {stats.postN} posts</Text>
      </View>

      {/* virality signature — per-post reach, spikes = breakouts */}
      {hasSpikes && (
        <View style={styles.rhSpark}>
          <Sparkline values={stats.series} color={accent} width={300} height={40} />
          <Text style={styles.rhSparkLbl}>reach per post</Text>
        </View>
      )}

      {/* the flex stats */}
      <View style={styles.rhStatsRow}>
        <ReachStat value={fmtCompact(stats.peak)} label={`peak ${stats.isViews ? "views" : reachedWord}`} accent={accent} />
        {stats.multiple != null && stats.multiple >= 1.5 && (
          <ReachStat value={fmtMultiple(stats.multiple)} label={`vs ${followerWord}`} accent={accent} highlight />
        )}
        {stats.breakoutN > 0 && (
          <ReachStat value={`${stats.breakoutN}`} label={stats.breakoutN === 1 ? "breakout post" : "breakout posts"} accent={accent} />
        )}
      </View>
    </View>
  );
}
function ReachStat({ value, label, accent, highlight }: { value: string; label: string; accent: string; highlight?: boolean }) {
  return (
    <View style={styles.rhStat}>
      <Text style={[styles.rhStatVal, highlight && { color: accent }]}>{value}</Text>
      <Text style={styles.rhStatLbl}>{label}</Text>
    </View>
  );
}

// Engagement ring + a comparative "N× creator avg" pill so the rate reads as a strength, not a small %.
function EngRing({ er, label, accent, avg, excellent }: {
  er: number | null | undefined; label: string; accent: string; avg: number; excellent: number;
}) {
  const cap = engMultiple(er);
  return (
    <View style={styles.engCol}>
      <MetricRing fillPct={ringFill(er, excellent)} display={fmtPct(er)} label={label} color={tierColor(er, avg, excellent)} />
      {cap ? (
        <View style={[styles.engCapPill, { backgroundColor: accent + "16" }]}>
          <Text style={[styles.engCapTxt, { color: accent }]}>{cap}</Text>
        </View>
      ) : null}
    </View>
  );
}

// ── Performance card — platform-specific fused metrics ──
function PerformanceCard({ snapshot: s, accent, coreER }: { snapshot: AnalyticsSnapshot; accent: string; coreER: number | null }) {
  if (s.platform === "youtube") {
    const yt = s.raw_metrics?.youtube;
    return (
      <View style={styles.card}>
        <View style={styles.rvRow}>
          <BigStat n={fmtCompact(s.avg_views_per_post)} label="Avg views / post" />
          <BigStat n={fmtCompact(yt?.views_30d ?? s.impressions)} label="Views · 30d" />
        </View>
        <View style={styles.perfRow}>
          <EngRing er={coreER ?? s.avg_engagement_rate} label="Engagement" accent={accent} avg={2.5} excellent={7} />
          <MetricRing fillPct={ringFill(yt?.avg_view_pct, 60)} display={yt?.avg_view_pct != null ? `${Math.round(yt.avg_view_pct)}%` : "—"} label="Retention" color={tierColor(yt?.avg_view_pct, 30, 60)} />
        </View>
        <View style={styles.perfFooter}>
          <Text style={styles.perfFooterTxt}>{fmtWatch(s.avg_watch_time_sec)} watch · {yt?.subs_net_30d != null ? `${yt.subs_net_30d >= 0 ? "+" : ""}${fmtCompact(yt.subs_net_30d)} subs 30d` : "—"}</Text>
        </View>
      </View>
    );
  }
  if (s.platform === "tiktok") {
    return (
      <View style={styles.card}>
        <View style={styles.rvRow}>
          <BigStat n={fmtCompact(s.avg_views_per_post)} label="Avg views / post" />
          <BigStat n={fmtCompact(s.total_likes)} label="Total likes" />
        </View>
        <View style={styles.perfRow}>
          <EngRing er={coreER ?? s.avg_engagement_rate} label="Engagement" accent={accent} avg={3.4} excellent={7} />
          <View style={styles.microGrid}>
            <Micro label="Posts" value={fmtCompact(s.post_count)} />
            <Micro label="Shares/post" value={fmtCompact(s.avg_shares_per_post)} />
          </View>
        </View>
        <View style={styles.perfFooter}>
          <Text style={styles.perfFooterTxt}>{s.content_frequency != null ? s.content_frequency.toFixed(1) : "—"} posts/week · {fmtCompact(s.following)} following</Text>
        </View>
      </View>
    );
  }
  // instagram — reach now lives in the hero; this card owns engagement & audience quality
  const eng = coreER ?? s.avg_engagement_rate;
  return (
    <View style={styles.card}>
      <Text style={styles.sectionLabel}>ENGAGEMENT & QUALITY</Text>
      <View style={styles.perfRow}>
        <EngRing er={eng} label="Engagement" accent={accent} avg={3} excellent={6} />
        <View style={styles.microGrid}>
          <Micro label="Saves/post" value={fmtCompact(s.avg_saves_per_post)} />
          <Micro label="Shares/post" value={fmtCompact(s.avg_shares_per_post)} />
          <Micro label="Link taps" value={fmtCompact(s.profile_views)} />
          <Micro label="Total likes" value={fmtCompact(s.total_likes)} />
        </View>
      </View>
      <View style={styles.perfFooter}>
        <Text style={styles.perfFooterTxt}>
          engagement of your core audience · {s.content_frequency != null ? s.content_frequency.toFixed(1) : "—"} posts/week
        </Text>
      </View>
    </View>
  );
}

function AudienceBlock({ snapshot: s, accent }: { snapshot: AnalyticsSnapshot; accent: string }) {
  const demo = s.raw_metrics?.demographics;
  const genderTop = demo?.gender?.[0];
  if (!genderTop && !demo?.country?.length) return null;
  return (
    <View style={styles.card}>
      <Text style={styles.sectionLabel}>AUDIENCE</Text>
      <View style={styles.audienceRow}>
        {genderTop && <AudienceDonut pct={genderTop.pct} label={GENDER_LABEL[genderTop.key] ?? genderTop.key} color={accent} size={112} stroke={12} />}
        <View style={styles.audienceMeta}>
          {genderTop && (
            <Text style={styles.audienceHeadline}>
              {genderTop.pct}% {GENDER_LABEL[genderTop.key] ?? genderTop.key}{s.top_audience_age_range ? ` · ${s.top_audience_age_range}` : ""}
            </Text>
          )}
          {(s.top_audience_country || s.top_audience_city) && (
            <View style={styles.locRow}>
              <Feather name="map-pin" size={12} color={Colors.light.textMuted} />
              <Text style={styles.locText}>{[s.top_audience_city, s.top_audience_country].filter(Boolean).join(" · ")}</Text>
            </View>
          )}
          {!!demo?.country?.length && (
            <View style={styles.bars}>
              {demo.country.slice(0, 3).map((row) => (
                <View key={row.key} style={styles.barRow}>
                  <Text style={styles.barKey}>{row.key}</Text>
                  <View style={styles.barTrack}><View style={[styles.barFill, { width: `${Math.max(4, row.pct)}%`, backgroundColor: accent }]} /></View>
                  <Text style={styles.barPct}>{row.pct}%</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

// ── small pieces ──
function BigStat({ n, label, sub, alignRight }: { n: string; label: string; sub?: string; alignRight?: boolean }) {
  return (
    <View style={[styles.rvItem, alignRight && { alignItems: "flex-end" }]}>
      <Text style={styles.rvNum}>{n}</Text>
      <Text style={styles.rvLbl}>{label}</Text>
      {sub ? <Text style={styles.rvSub}>{sub}</Text> : null}
    </View>
  );
}
function Micro({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.micro}>
      <Text style={styles.microVal}>{value}</Text>
      <Text style={styles.microLbl}>{label}</Text>
    </View>
  );
}
function TopPost({ media, others, accent }: { media: SnapshotMedia; others: SnapshotMedia[]; accent: string }) {
  const thumb = media.thumbnail_url ?? media.media_url;
  const ins = media.insights ?? {};
  const primary = ins.video_views != null ? { i: "eye" as const, v: ins.video_views } : ins.reach != null ? { i: "users" as const, v: ins.reach } : null;
  return (
    <View style={styles.card}>
      <Text style={styles.sectionLabel}>TOP RECENT POST</Text>
      <View style={styles.topPost}>
        {thumb ? <Image source={{ uri: thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <View style={[StyleSheet.absoluteFill, styles.topPh]} />}
        <View style={styles.topScrim} />
        <View style={[styles.topBadge, { backgroundColor: accent }]}><Text style={styles.topBadgeTxt}>Top post</Text></View>
        <View style={styles.topStats}>
          {primary ? <TStat icon={primary.i} v={fmtCompact(primary.v)} /> : null}
          {ins.saved != null ? <TStat icon="bookmark" v={fmtCompact(ins.saved)} /> : null}
          {ins.shares != null ? <TStat icon="send" v={fmtCompact(ins.shares)} /> : null}
        </View>
      </View>
      {others.length > 0 && (
        <View style={styles.recentStrip}>
          {others.slice(0, 3).map((m, i) => {
            const t = m.thumbnail_url ?? m.media_url;
            const v = m.insights?.video_views ?? m.insights?.reach ?? null;
            return (
              <View key={m.id ?? i} style={styles.recentThumb}>
                {t ? <Image source={{ uri: t }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
                {v != null ? <View style={styles.recentPill}><Feather name="eye" size={8} color="#fff" /><Text style={styles.recentPillTxt}>{fmtCompact(v)}</Text></View> : null}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}
function TStat({ icon, v }: { icon: React.ComponentProps<typeof Feather>["name"]; v: string }) {
  return (
    <View style={styles.tstat}><Feather name={icon} size={12} color="#fff" /><Text style={styles.tstatTxt}>{v}</Text></View>
  );
}

function bestPost(media: SnapshotMedia[]): SnapshotMedia | null {
  if (!media?.length) return null;
  const score = (m: SnapshotMedia) => m.insights?.total_interactions ?? m.insights?.video_views ?? m.insights?.reach ?? ((m.like_count ?? 0) + (m.comments_count ?? 0));
  return [...media].sort((a, b) => score(b) - score(a))[0] ?? null;
}
function deriveHandle(s: AnalyticsSnapshot): string {
  const acct = (s.raw_metrics as any)?.account;
  return acct?.username ?? acct?.display_name ?? "—";
}
function fmtAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const shadow = { shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 3, elevation: 2 };

const styles = StyleSheet.create({
  root: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.md, gap: Spacing.md },
  toggle: { flexDirection: "row", backgroundColor: Colors.light.backgroundSecondary, borderRadius: BorderRadius.full, padding: 4, gap: 4 },
  toggleBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: Spacing.sm, borderRadius: BorderRadius.full },
  toggleText: { fontFamily: Fonts.bodySemiBold, fontSize: 13, color: Colors.light.textMuted },
  card: { backgroundColor: Colors.light.card, borderRadius: BorderRadius.lg, padding: Spacing.lg, ...shadow },

  heroRow: { flexDirection: "row", alignItems: "flex-start" },
  handle: { fontFamily: Fonts.bodyMedium, fontSize: 13, color: Colors.light.textMuted },
  followers: { fontFamily: Fonts.display, fontSize: 36, color: Colors.light.text, marginTop: 2 },
  followersLabel: { fontFamily: Fonts.bodyMedium, fontSize: 12, color: Colors.light.textMuted },
  heroRight: { alignItems: "flex-end", gap: 8 },
  platformBadge: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  growthChip: { flexDirection: "row", alignItems: "center", gap: 4 },
  growthText: { fontFamily: Fonts.bodySemiBold, fontSize: 12 },
  heroSpark: { marginTop: Spacing.md, alignItems: "flex-start" },
  heroSparkLbl: { fontFamily: Fonts.bodyMedium, fontSize: 10.5, color: Colors.light.textMuted, marginTop: 4, letterSpacing: 0.3 },

  // reach & virality hero
  rhTop: { flexDirection: "row", alignItems: "flex-start" },
  rhFollowerRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 3 },
  rhFollowerCount: { fontFamily: Fonts.bodySemiBold, fontSize: 13, color: Colors.light.textSecondary },
  rhHeadline: { marginTop: Spacing.md },
  rhBigNum: { fontFamily: Fonts.display, fontSize: 46, lineHeight: 50 },
  rhBigLbl: { fontFamily: Fonts.bodyMedium, fontSize: 12.5, color: Colors.light.textMuted, marginTop: 2 },
  rhSpark: { marginTop: Spacing.md, alignItems: "flex-start" },
  rhSparkLbl: { fontFamily: Fonts.bodyMedium, fontSize: 10, color: Colors.light.textMuted, marginTop: 3, letterSpacing: 0.3 },
  rhStatsRow: { flexDirection: "row", gap: Spacing.sm, marginTop: Spacing.lg, borderTopWidth: 1, borderTopColor: Colors.light.borderLight, paddingTop: Spacing.md },
  rhStat: { flex: 1, alignItems: "center" },
  rhStatVal: { fontFamily: Fonts.display, fontSize: 22, color: Colors.light.text },
  rhStatLbl: { fontFamily: Fonts.bodyMedium, fontSize: 10.5, color: Colors.light.textMuted, marginTop: 2, textAlign: "center" },

  // engagement ring + comparative pill
  engCol: { alignItems: "center", gap: 6 },
  engCapPill: { borderRadius: BorderRadius.full, paddingHorizontal: 8, paddingVertical: 3 },
  engCapTxt: { fontFamily: Fonts.bodyBold, fontSize: 10.5, fontWeight: "700" },

  rvRow: { flexDirection: "row", justifyContent: "space-between" },
  rvItem: { flex: 1 },
  rvNum: { fontFamily: Fonts.display, fontSize: 26, color: Colors.light.text },
  rvLbl: { fontFamily: Fonts.bodySemiBold, fontSize: 11, color: Colors.light.textSecondary, marginTop: 1 },
  rvSub: { fontFamily: Fonts.body, fontSize: 10.5, color: Colors.light.textMuted },
  splitTrack: { height: 8, borderRadius: 4, backgroundColor: Colors.light.border, overflow: "hidden", marginTop: Spacing.md },
  splitFill: { height: 8, borderRadius: 4 },
  perfRow: { flexDirection: "row", alignItems: "center", gap: Spacing.lg, marginTop: Spacing.lg },
  microGrid: { flex: 1, flexDirection: "row", flexWrap: "wrap", gap: Spacing.md },
  micro: { flexBasis: "45%", flexGrow: 1 },
  microVal: { fontFamily: Fonts.headingSemiBold, fontSize: 16, color: Colors.light.text },
  microLbl: { fontFamily: Fonts.bodyMedium, fontSize: 10.5, color: Colors.light.textMuted, marginTop: 1 },
  perfFooter: { marginTop: Spacing.lg, borderTopWidth: 1, borderTopColor: Colors.light.borderLight, paddingTop: Spacing.sm },
  perfFooterTxt: { fontFamily: Fonts.bodyMedium, fontSize: 12, color: Colors.light.textMuted, textAlign: "center" },

  sectionLabel: { fontFamily: Fonts.bodySemiBold, fontSize: 11, color: Colors.light.textMuted, letterSpacing: 0.8, marginBottom: Spacing.md },
  audienceRow: { flexDirection: "row", alignItems: "center", gap: Spacing.lg },
  audienceMeta: { flex: 1, gap: 6 },
  audienceHeadline: { fontFamily: Fonts.headingSemiBold, fontSize: 16, color: Colors.light.text },
  locRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  locText: { fontFamily: Fonts.bodyMedium, fontSize: 13, color: Colors.light.textSecondary },
  bars: { marginTop: Spacing.sm, gap: Spacing.sm },
  barRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  barKey: { fontFamily: Fonts.bodySemiBold, fontSize: 12, color: Colors.light.textSecondary, width: 30 },
  barTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: Colors.light.border, overflow: "hidden" },
  barFill: { height: 8, borderRadius: 4 },
  barPct: { fontFamily: Fonts.bodyMedium, fontSize: 12, color: Colors.light.textMuted, width: 36, textAlign: "right" },

  topPost: { height: 220, borderRadius: BorderRadius.md, overflow: "hidden", backgroundColor: Colors.light.backgroundSecondary },
  topPh: { backgroundColor: Colors.light.backgroundSecondary },
  topScrim: { ...StyleSheet.absoluteFill, backgroundColor: "transparent", borderRadius: BorderRadius.md },
  topBadge: { position: "absolute", top: 10, left: 10, borderRadius: BorderRadius.full, paddingHorizontal: 9, paddingVertical: 3 },
  topBadgeTxt: { fontFamily: Fonts.bodyBold, fontSize: 10, fontWeight: "800", color: "#fff", letterSpacing: 0.3 },
  topStats: { position: "absolute", bottom: 10, left: 10, flexDirection: "row", gap: 8 },
  tstat: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "rgba(13,11,8,0.6)", borderRadius: BorderRadius.full, paddingHorizontal: 9, paddingVertical: 4 },
  tstatTxt: { fontFamily: Fonts.bodyBold, fontSize: 12, fontWeight: "700", color: "#fff" },
  recentStrip: { flexDirection: "row", gap: Spacing.sm, marginTop: Spacing.sm },
  recentThumb: { flex: 1, aspectRatio: 1, borderRadius: BorderRadius.sm, overflow: "hidden", backgroundColor: Colors.light.backgroundSecondary },
  recentPill: { position: "absolute", bottom: 4, left: 4, flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: "rgba(13,11,8,0.62)", borderRadius: BorderRadius.full, paddingHorizontal: 6, paddingVertical: 2 },
  recentPillTxt: { fontFamily: Fonts.bodyBold, fontSize: 9.5, fontWeight: "700", color: "#fff" },

  updatedAt: { fontFamily: Fonts.body, fontSize: 12, color: Colors.light.textMuted, textAlign: "center", marginTop: Spacing.xs },
  stateBox: { paddingVertical: Spacing["4xl"], alignItems: "center", gap: Spacing.md },
  stateText: { fontFamily: Fonts.bodyMedium, fontSize: 14, color: Colors.light.textSecondary },
  retryBtn: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm, borderRadius: BorderRadius.full, backgroundColor: Colors.light.primary },
  retryText: { fontFamily: Fonts.bodySemiBold, fontSize: 13, color: "#fff" },
  emptyIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.light.backgroundSecondary, alignItems: "center", justifyContent: "center" },
  emptyTitle: { fontFamily: Fonts.heading, fontSize: 16, color: Colors.light.text },
  emptySub: { fontFamily: Fonts.body, fontSize: 13, color: Colors.light.textMuted, textAlign: "center", paddingHorizontal: Spacing.xl },
});
