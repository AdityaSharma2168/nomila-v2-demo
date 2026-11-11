import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  SafeAreaView,
  StatusBar,
  ScrollView,
  RefreshControl,
  Modal,
  ActivityIndicator,
  Alert,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { BrandStackParamList } from "../navigation/MainTabNavigator";
import { useAuth } from "../lib/auth-context";
import {
  useShares,
  useShareAnalytics,
  useRevokeShare,
  useAthleteOpensByDay,
  type ShareListItem,
  type ShareOpen,
} from "../hooks/use-card";
import { Bold, Fonts, Colors, Brand, Spacing } from "../constants/theme";

// ─── The scout's notebook — "Track opens" analytics ────────────────────────────
// Editorial headlines, a dot-per-open strip, and per-share dwell — a share read
// as a sales signal (Spec 6: "analytics = headline feature").

// "Sealed" reads ink on grey: the ring gold paints the M.I.A. score only (one look, 23 Oct 2026).
const GOLD      = Bold.ink;
const GOLD_SOFT = Bold.ground;
const WARN_INK  = Bold.ink;
const ROSE_INK  = "#C23577";

type SignalsNavProp = NativeStackNavigationProp<BrandStackParamList, "Signals">;

// ── Formatting helpers ──
const ORDINALS = ["zeroth", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth"];
function ordinalWord(n: number): string {
  return ORDINALS[n] ?? `${n}th`;
}
function ordinalPlural(n: number): string {
  const w = ordinalWord(n);
  return w.endsWith("th") ? w + "s" : w + "s"; // "thirds", "fourths"…
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60)      return "just now";
  const m = s / 60;
  if (m < 60)      return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24)      return `${Math.floor(h)}h ago`;
  const d = h / 24;
  if (d < 7)       return `${Math.floor(d)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDwell(ms: number | undefined): string {
  const v = Math.max(0, Math.round((ms ?? 0) / 1000));
  if (v === 0) return "—";
  if (v < 60)  return `${v}s`;
  const m = Math.floor(v / 60), s = v % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function initialsFor(share: ShareListItem): string {
  const src = share.recipient || share.label || "";
  const parts = src.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

function shareTitle(share: ShareListItem): string {
  return share.recipient || share.label || (share.scope === "public" ? "Your public card" : "Tracked link");
}

function shareBlurb(share: ShareListItem): string {
  const sealed = share.mode === "snapshot";
  if (share.opens === 0) {
    return sealed ? "Sealed and sent — not opened yet." : "Sent — waiting on the first open.";
  }
  const dwell = sealed ? "the sealed version" : "your latest";
  if (share.opens === 1) return `Opened ${dwell} once.`;
  return `Opened ${dwell} ${share.opens}× — last ${timeAgo(share.lastOpened).replace(" ago", " ago")}.`;
}

export function SignalsScreen() {
  const navigation      = useNavigation<SignalsNavProp>();
  const { athlete }     = useAuth();
  const athleteId       = athlete?.id;
  const { shares, totalOpens, isLoading, refetch } = useShares(athleteId);
  const { byDay, refetch: refetchByDay } = useAthleteOpensByDay(athleteId, 14);

  const [selected, setSelected] = useState<ShareListItem | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = async () => {
    setRefreshing(true);
    try { await Promise.all([refetch(), refetchByDay()]); } finally { setRefreshing(false); }
  };

  // ── Derived headline stats ──
  const withOpens   = shares.filter((s) => s.opens > 0);
  const reading     = withOpens.length;
  const topShare    = useMemo(
    () => shares.reduce<ShareListItem | null>((best, s) => (!best || s.opens > best.opens ? s : best), null),
    [shares],
  );
  const lastOpenedIso = useMemo(
    () => shares.map((s) => s.lastOpened).filter(Boolean).sort().slice(-1)[0] ?? null,
    [shares],
  );

  const headline = useMemo(() => {
    if (!topShare || topShare.opens === 0) return { lead: "Quiet week", accent: "so far." };
    const who = topShare.recipient || topShare.label || "Someone";
    if (topShare.opens === 1) return { lead: `${who} took`, accent: "a first look." };
    return { lead: `${who} came back`, accent: `for ${ordinalPlural(topShare.opens)}.` };
  }, [topShare]);

  const headlineSub = useMemo(() => {
    if (totalOpens === 0) return "No opens yet — your links are out there. The first read usually lands within a day of sending.";
    const linkWord = shares.length === 1 ? "link" : "links";
    const last = lastOpenedIso ? ` Last opened ${timeAgo(lastOpenedIso)}.` : "";
    return `${totalOpens} open${totalOpens === 1 ? "" : "s"} across ${shares.length} ${linkWord}.${last}`;
  }, [totalOpens, shares.length, lastOpenedIso]);

  // ── 14-day dot strip — exact: 1 dot = 1 real open, on the day it actually happened ──
  const strip = useMemo(() => buildStrip(byDay), [byDay]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor={Colors.light.backgroundRoot} />

      {/* Header */}
      <View style={styles.header}>
        <Pressable hitSlop={8} style={styles.headerSide} onPress={() => navigation.goBack()} accessibilityLabel="Back">
          <Feather name="chevron-left" size={22} color="#9C968D" />
        </Pressable>
        <Text style={styles.screenTitle}>Card signals</Text>
        <View style={styles.headerSide} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#9C968D" />}
      >
        {isLoading && shares.length === 0 ? (
          <View style={styles.loading}><ActivityIndicator color={Colors.light.primary} /></View>
        ) : (
          <>
            {/* Scout's-notebook headline */}
            <View style={styles.hero}>
              <View style={styles.heroTop}>
                <View style={styles.monoRing}><Text style={styles.monoRingText}>N</Text></View>
                <Text style={styles.eyebrow}>This week's headline</Text>
              </View>
              <Text style={styles.heroHeadline}>
                {headline.lead} <Text style={styles.heroAccent}>{headline.accent}</Text>
              </Text>
              <Text style={styles.heroSub}>{headlineSub}</Text>
              {topShare && topShare.mode === "snapshot" && topShare.opens > 0 && (
                <View style={styles.heroTags}>
                  <View style={[styles.tag, styles.tagGold]}>
                    <Text style={styles.tagGoldText}>Sealed link{topShare.recipient ? ` · ${topShare.recipient}` : ""}</Text>
                  </View>
                  <View style={[styles.tag, styles.tagRose]}>
                    <Text style={styles.tagRoseText}>Reads like interest</Text>
                  </View>
                </View>
              )}
            </View>

            {/* Stat tiles */}
            <View style={styles.tiles}>
              <Tile value={String(totalOpens)} label="Opens" />
              <Tile value={String(shares.length)} label="Links out" />
              <Tile value={String(reading)} label="Reading" />
            </View>

            {/* Dot-per-open strip */}
            <View style={styles.stripCard}>
              <View style={styles.stripHead}>
                <Text style={styles.eyebrow}>Last 14 days</Text>
                <Text style={styles.stripHint}>1 dot = 1 open</Text>
              </View>
              <View style={styles.dayStrip}>
                {strip.map((col, i) => (
                  <View key={i} style={styles.dayCol}>
                    {col.count === 0 ? (
                      <View style={[styles.dot, styles.dotEmpty]} />
                    ) : (
                      Array.from({ length: Math.min(col.count, 5) }).map((_, j) => (
                        <View key={j} style={[styles.dot, col.today && styles.dotToday]} />
                      ))
                    )}
                  </View>
                ))}
              </View>
              <View style={styles.dayLabels}>
                {strip.map((col, i) => (
                  <Text key={i} style={[styles.dayLabel, col.today && styles.dayLabelToday]}>{col.label}</Text>
                ))}
              </View>
            </View>

            {/* Every signal */}
            <Text style={[styles.eyebrow, styles.sectionH]}>Every signal</Text>
            {shares.length === 0 ? (
              <View style={styles.empty}>
                <Feather name="radio" size={22} color="#C5BFB8" />
                <Text style={styles.emptyText}>No shares yet. Send your card and every open shows up here.</Text>
              </View>
            ) : (
              <View style={styles.feed}>
                {shares.map((s) => (
                  <Pressable key={s.id} style={styles.sigRow} onPress={() => setSelected(s)}>
                    <View style={[styles.sigAv, s.scope === "public" ? styles.sigAvPub : styles.sigAvInk]}>
                      {s.scope === "public"
                        ? <Feather name="globe" size={16} color={Colors.light.primary} />
                        : <Text style={styles.sigAvText}>{initialsFor(s) || "•"}</Text>}
                      {s.mode === "snapshot" && (
                        <View style={styles.sealedDot}><Feather name="lock" size={7} color="#FFFFFF" /></View>
                      )}
                    </View>
                    <View style={styles.sigTx}>
                      <View style={styles.sigL1}>
                        <Text style={styles.sigName} numberOfLines={1}>{shareTitle(s)}</Text>
                        {s.revoked
                          ? <View style={styles.pillOff}><Text style={styles.pillOffText}>Off</Text></View>
                          : s.opens > 0 && <View style={styles.pillS}><Text style={styles.pillSText}>{s.opens} open{s.opens === 1 ? "" : "s"}</Text></View>}
                      </View>
                      <Text style={styles.sigL2} numberOfLines={2}>{shareBlurb(s)}</Text>
                    </View>
                    <Text style={styles.sigWhen}>{s.lastOpened ? timeAgo(s.lastOpened) : timeAgo(s.createdAt)}</Text>
                  </Pressable>
                ))}
              </View>
            )}

            <Text style={styles.foot}>Every sealed link keeps a copy of exactly what they saw — a rate quoted is a rate kept.</Text>
          </>
        )}
      </ScrollView>

      {selected && (
        <ShareAnalyticsSheet
          share={selected}
          athleteId={athleteId}
          onClose={() => setSelected(null)}
        />
      )}
    </SafeAreaView>
  );
}

// ─── Per-share analytics sheet ─────────────────────────────────────────────────

function ShareAnalyticsSheet({
  share, athleteId, onClose,
}: { share: ShareListItem; athleteId: string | undefined; onClose: () => void }) {
  const { analytics, isLoading } = useShareAnalytics(share.id);
  const revoke = useRevokeShare(athleteId);
  const [revoked, setRevoked] = useState(share.revoked);

  const opens = analytics?.opens ?? share.opens;
  const sealed = share.mode === "snapshot";

  const headline = useMemo(() => {
    const who = share.recipient || share.label || "This link";
    if (opens === 0) return `${who} hasn't opened it yet.`;
    if (opens === 1) return `${who} opened it once.`;
    return `${who} opened it ${opens}×.`;
  }, [share, opens]);

  function confirmRevoke() {
    Alert.alert(
      "Turn this link off?",
      "Anyone who opens it will see a turned-off screen. This can't be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Turn off", style: "destructive",
          onPress: () => revoke.mutate(share.id, {
            onSuccess: () => setRevoked(true),
            onError:   () => Alert.alert("Couldn't turn it off", "Please try again."),
          }),
        },
      ],
    );
  }

  return (
    <Modal transparent statusBarTranslucent animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.sheetContainer}>
        <Pressable style={styles.sheetBackdrop} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.handle} />

          {/* Header */}
          <View style={styles.sheetHeader}>
            <View style={[styles.sigAv, share.scope === "public" ? styles.sigAvPub : styles.sigAvInk]}>
              {share.scope === "public"
                ? <Feather name="globe" size={16} color={Colors.light.primary} />
                : <Text style={styles.sigAvText}>{initialsFor(share) || "•"}</Text>}
              {sealed && <View style={styles.sealedDot}><Feather name="lock" size={7} color="#FFFFFF" /></View>}
            </View>
            <View style={styles.sheetHeaderMeta}>
              <Text style={styles.sheetTitle} numberOfLines={1}>{shareTitle(share)}</Text>
              <Text style={styles.sheetSub}>
                {sealed ? "Sealed version" : "Always current"}{share.tailoring === "brand" ? " · tailored" : ""}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={8} style={styles.closeBtn}>
              <Feather name="x" size={18} color="#9C968D" />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.sheetScroll} showsVerticalScrollIndicator={false}>
            {/* Editorial headline */}
            <Text style={styles.analyticsHeadline}>{headline}</Text>

            {isLoading && !analytics ? (
              <View style={styles.loading}><ActivityIndicator color={Colors.light.primary} /></View>
            ) : (
              <>
                {/* Stat tiles */}
                <View style={styles.tiles}>
                  <Tile value={String(analytics?.opens ?? share.opens)} label="Opens" />
                  <Tile value={String(analytics?.viewers ?? 0)} label="Viewers" />
                  <Tile value={String(analytics?.forwards ?? 0)} label="Forwards" />
                </View>
                <View style={[styles.tiles, { marginTop: 9 }]}>
                  <Tile value={formatDwell(analytics?.avgDwellMs)} label="Avg time on card" wide />
                </View>

                {/* Dot-per-open row — one dot per REAL open (◇ = a forwarded open) */}
                {opens > 0 && (
                  <View style={styles.stripCard}>
                    <View style={styles.stripHead}>
                      <Text style={styles.eyebrow}>Every open</Text>
                      <Text style={styles.stripHint}>
                        1 dot = 1 open{(analytics?.forwards ?? 0) > 0 ? " · ◇ forward" : ""}
                      </Text>
                    </View>
                    <View style={styles.openDots}>
                      {openDotsFor(analytics?.timeline, opens).map((o, i) => (
                        <View
                          key={i}
                          style={[styles.dot, sealed && styles.dotSealed, o.isForward && styles.dotForward]}
                        />
                      ))}
                    </View>
                    {analytics?.timeline?.length ? (
                      <Text style={styles.forwardNote}>{openStripCaption(analytics.timeline)}</Text>
                    ) : analytics?.forwards ? (
                      <Text style={styles.forwardNote}>
                        {analytics.forwards} of these came from a forward — someone passed your link on.
                      </Text>
                    ) : null}
                  </View>
                )}
              </>
            )}

            {/* Revoke */}
            {revoked ? (
              <View style={styles.revokedRow}>
                <Feather name="slash" size={14} color="#9C968D" />
                <Text style={styles.revokedText}>This link is turned off.</Text>
              </View>
            ) : (
              <Pressable style={styles.revokeBtn} onPress={confirmRevoke} disabled={revoke.isPending}>
                {revoke.isPending
                  ? <ActivityIndicator size="small" color={Colors.light.destructive} />
                  : <>
                      <Feather name="slash" size={14} color={Colors.light.destructive} />
                      <Text style={styles.revokeText}>Turn this link off</Text>
                    </>}
              </Pressable>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// The exact per-open dots: prefer the real timeline (each open, forward-marked); if it's
// missing (older shares / not yet loaded) fall back to `opens` plain dots. Cap at 60.
function openDotsFor(timeline: ShareOpen[] | undefined, opens: number): ShareOpen[] {
  const src = timeline?.length
    ? timeline
    : Array.from({ length: opens }, () => ({ at: "", isForward: false, dwellMs: null }));
  return src.slice(-60);
}

// A precise, human caption from the real open times: first/most-recent + forward count.
function openStripCaption(timeline: ShareOpen[]): string {
  const first = timeline[0]?.at;
  const last  = timeline[timeline.length - 1]?.at;
  const fwd   = timeline.filter((o) => o.isForward).length;
  const parts: string[] = [];
  if (timeline.length === 1) parts.push(`Opened ${timeAgo(last)}.`);
  else                       parts.push(`First opened ${timeAgo(first)}, most recently ${timeAgo(last)}.`);
  if (fwd) parts.push(`${fwd} ${fwd === 1 ? "open was" : "opens were"} a forward — someone passed your link on.`);
  return parts.join(" ");
}

function Tile({ value, label, wide }: { value: string; label: string; wide?: boolean }) {
  return (
    <View style={[styles.tile, wide && styles.tileWide]}>
      <Text style={styles.tileValue}>{value}</Text>
      <Text style={styles.tileLabel}>{label}</Text>
    </View>
  );
}

// Build 14 day-columns and place each day's REAL open count (from card-opens/byDay) on it.
function buildStrip(byDay: { day: string; opens: number }[]): { label: string; count: number; today: boolean }[] {
  const DAYS = 14;
  const counts = new Map(byDay.map((d) => [d.day, d.opens]));
  const key = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Array.from({ length: DAYS }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() - (DAYS - 1 - i));
    return {
      label: d.toLocaleDateString(undefined, { weekday: "narrow" }),
      count: counts.get(key(d)) ?? 0,
      today: i === DAYS - 1,
    };
  });
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.light.backgroundRoot },

  // Header
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: Spacing.xl, paddingTop: 14, paddingBottom: Spacing.sm,
  },
  headerSide:  { width: 32, alignItems: "flex-start" },
  screenTitle: { flex: 1, textAlign: "center", fontFamily: Fonts.headingSemiBold, fontSize: 18, color: Colors.light.text },

  scroll:  { paddingBottom: 28 },
  loading: { paddingVertical: 40, alignItems: "center" },

  eyebrow: {
    fontFamily: Fonts.bodySemiBold, fontSize: 11, color: "#9C968D",
    letterSpacing: 0.8, textTransform: "uppercase",
  },

  // Hero (scout's notebook)
  hero: {
    marginHorizontal: Spacing.xl, marginTop: 10,
    borderRadius: 26, padding: 18,
    backgroundColor: Colors.light.card,
    ...cardShadow(),
  },
  heroTop:  { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 10 },
  monoRing: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: Colors.light.primary,
    alignItems: "center", justifyContent: "center",
  },
  monoRingText: { fontFamily: Fonts.bodyBold, fontSize: 17, color: "#FFFFFF" },
  heroHeadline: { fontFamily: Fonts.heading, fontSize: 22, lineHeight: 26, color: Colors.light.text, letterSpacing: -0.4 },
  heroAccent:   { color: Colors.light.primary },
  heroSub:      { fontFamily: Fonts.body, fontSize: 13, lineHeight: 20, color: Colors.light.textSecondary, marginTop: 7 },
  heroTags:     { flexDirection: "row", gap: 7, marginTop: 12, flexWrap: "wrap" },
  tag:          { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1 },
  tagGold:      { backgroundColor: GOLD_SOFT, borderColor: Bold.line },
  tagGoldText:  { fontFamily: Fonts.bodySemiBold, fontSize: 10, letterSpacing: 0.5, textTransform: "uppercase", color: WARN_INK },
  tagRose:      { backgroundColor: Colors.light.primaryLight, borderColor: "rgba(200,50,90,0.25)" },
  tagRoseText:  { fontFamily: Fonts.bodySemiBold, fontSize: 10, letterSpacing: 0.5, textTransform: "uppercase", color: ROSE_INK },

  // Tiles
  tiles: { flexDirection: "row", gap: 9, marginHorizontal: Spacing.xl, marginTop: 12 },
  tile: {
    flex: 1, borderRadius: 18, backgroundColor: Colors.light.card,
    paddingVertical: 12, paddingHorizontal: 8, alignItems: "center",
    ...cardShadow(0.05, 8, 2),
  },
  tileWide:   { alignItems: "flex-start", paddingHorizontal: 16 },
  tileValue:  { fontFamily: Fonts.bodyBold, fontSize: 21, color: Colors.light.text, letterSpacing: -0.2 },
  tileLabel:  { fontFamily: Fonts.bodySemiBold, fontSize: 9, letterSpacing: 0.8, textTransform: "uppercase", color: "#9C968D", marginTop: 4 },

  // Dot strip
  stripCard: {
    marginHorizontal: Spacing.xl, marginTop: 12, borderRadius: 18,
    backgroundColor: Colors.light.card, padding: 15, ...cardShadow(0.05, 8, 2),
  },
  stripHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginBottom: 11 },
  stripHint: { fontFamily: Fonts.body, fontSize: 10, color: "#9C968D" },
  dayStrip:  { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", height: 44 },
  dayCol:    { width: 14, flexDirection: "column-reverse", alignItems: "center", gap: 3 },
  dot:       { width: 7, height: 7, borderRadius: 4, backgroundColor: Colors.light.primary },
  dotEmpty:  { width: 4, height: 4, borderRadius: 2, backgroundColor: "transparent", borderWidth: 1.2, borderColor: Colors.light.primaryLight },
  dotToday:  { backgroundColor: "#B01D66" },
  dotSealed: { backgroundColor: GOLD },
  dotForward: { backgroundColor: "transparent", borderWidth: 1.4, borderColor: "#B01D66" },
  dayLabels: { flexDirection: "row", justifyContent: "space-between", marginTop: 6 },
  dayLabel:  { width: 14, textAlign: "center", fontFamily: Fonts.bodyMedium, fontSize: 8.5, color: "#9C968D" },
  dayLabelToday: { color: Colors.light.primary, fontFamily: Fonts.bodyBold },

  openDots: { flexDirection: "row", flexWrap: "wrap", gap: 6 },

  // Feed
  sectionH: { marginHorizontal: Spacing.xl, marginTop: 18 },
  feed: {
    marginHorizontal: Spacing.xl, marginTop: 10, borderRadius: 18, overflow: "hidden",
    backgroundColor: Colors.light.card, ...cardShadow(0.05, 8, 2),
  },
  sigRow: {
    flexDirection: "row", gap: 12, padding: 15, alignItems: "flex-start",
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.light.borderLight,
  },
  sigAv: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  sigAvInk:  { backgroundColor: Brand.heroBg },
  sigAvPub:  { backgroundColor: Colors.light.primaryLight },
  sigAvText: { fontFamily: Fonts.bodyBold, fontSize: 14, color: "#F6F1EA" },
  sealedDot: {
    position: "absolute", right: -2, bottom: -2, width: 15, height: 15, borderRadius: 8,
    backgroundColor: GOLD, borderWidth: 2, borderColor: "#FFFFFF", alignItems: "center", justifyContent: "center",
  },
  sigTx:   { flex: 1, minWidth: 0, gap: 3 },
  sigL1:   { flexDirection: "row", alignItems: "center", gap: 8 },
  sigName: { fontFamily: Fonts.bodySemiBold, fontSize: 14, color: Colors.light.text, flexShrink: 1 },
  pillS:      { backgroundColor: Colors.light.primaryLight, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  pillSText:  { fontFamily: Fonts.bodyBold, fontSize: 8.5, letterSpacing: 0.4, textTransform: "uppercase", color: ROSE_INK },
  pillOff:     { backgroundColor: Colors.light.backgroundSecondary, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  pillOffText: { fontFamily: Fonts.bodyBold, fontSize: 8.5, letterSpacing: 0.4, textTransform: "uppercase", color: "#9C968D" },
  sigL2:   { fontFamily: Fonts.body, fontSize: 12, lineHeight: 17, color: Colors.light.textSecondary },
  sigWhen: { fontFamily: Fonts.body, fontSize: 10.5, color: "#9C968D", marginTop: 3 },

  foot: {
    fontFamily: Fonts.body, fontSize: 12, fontStyle: "italic", color: "#9C968D",
    textAlign: "center", paddingHorizontal: 30, marginTop: 16, lineHeight: 18,
  },

  empty: { alignItems: "center", gap: 10, paddingVertical: 30, paddingHorizontal: Spacing.xl },
  emptyText: { fontFamily: Fonts.body, fontSize: 13, color: "#9C968D", textAlign: "center", lineHeight: 19 },

  // Analytics sheet
  sheetContainer: { flex: 1, justifyContent: "flex-end" },
  sheetBackdrop:  { ...StyleSheet.absoluteFill, backgroundColor: "rgba(42,38,34,0.45)" },
  sheet: {
    backgroundColor: Colors.light.card, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingTop: 10, maxHeight: "86%",
  },
  handle: { width: 40, height: 4.5, backgroundColor: Colors.light.border, borderRadius: 3, alignSelf: "center", marginBottom: Spacing.md },
  sheetHeader: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: Spacing.xl, paddingBottom: Spacing.lg,
    borderBottomWidth: 1, borderBottomColor: Colors.light.borderLight,
  },
  sheetHeaderMeta: { flex: 1, gap: 2 },
  sheetTitle: { fontFamily: Fonts.headingSemiBold, fontSize: 16, color: Colors.light.text },
  sheetSub:   { fontFamily: Fonts.body, fontSize: 12, color: "#9C968D" },
  closeBtn: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: Colors.light.backgroundDefault,
    alignItems: "center", justifyContent: "center",
  },
  sheetScroll: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.lg, paddingBottom: 32 },
  analyticsHeadline: {
    fontFamily: Fonts.heading, fontSize: 20, lineHeight: 25, color: Colors.light.text,
    letterSpacing: -0.3, marginBottom: 4,
  },
  forwardNote: { fontFamily: Fonts.body, fontSize: 12, color: Colors.light.textSecondary, marginTop: 10, lineHeight: 17 },

  revokeBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7,
    height: 46, borderRadius: 999, borderWidth: 1, borderColor: "rgba(220,38,38,0.35)",
    backgroundColor: "#FFF5F5", marginTop: 18,
  },
  revokeText: { fontFamily: Fonts.bodySemiBold, fontSize: 13.5, color: Colors.light.destructive },
  revokedRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7,
    marginTop: 18, paddingVertical: 12,
  },
  revokedText: { fontFamily: Fonts.bodyMedium, fontSize: 13, color: "#9C968D" },
});

function cardShadow(opacity = 0.06, radius = 16, offsetY = 4) {
  return {
    shadowColor: "#1A1A1A",
    shadowOffset: { width: 0, height: offsetY },
    shadowOpacity: opacity,
    shadowRadius: radius / 2,
    elevation: 3,
  };
}
