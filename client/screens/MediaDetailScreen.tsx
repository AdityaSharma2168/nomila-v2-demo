import React, { useState } from "react";
import {
  View, Text, SafeAreaView, StatusBar, Pressable, StyleSheet, ScrollView, ActivityIndicator, Linking, Alert,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import type { StudioStackParamList } from "../navigation/MainTabNavigator";
import { useMediaDetail } from "../hooks/use-media-library";
import { useClipRead } from "../hooks/use-studio-media";
import { STUDIO_CLIP_READ } from "../lib/flags";
import { readAffordance, type ClipRead } from "./studio/clipReadLogic";
import { analyzedOf, analyzedPendingLabel } from "./mediaDetailLogic";
import { ClipPoster } from "../components/studio/ClipPoster";
import { ClipPlayer, MuteToggle } from "../components/studio/ClipPlayer";
import { libraryPreview } from "../components/studio/playerBox";
import { HapticPressable } from "../components/HapticPressable";
import { Bold, Brand, Colors, Fonts, Spacing } from "../constants/theme";

const SOURCE_LABEL: Record<string, string> = { connected: "Instagram", upload: "Upload", generated: "Generated", discovery: "Discovery" };
const DISPOSITION: Record<string, { label: string; tone: "good" | "warn" | "bad" }> = {
  as_is:   { label: "Kit-ready",          tone: "good" },
  crop:    { label: "Suggested: crop",    tone: "warn" },
  enhance: { label: "Suggested: enhance", tone: "warn" },
  reject:  { label: "Not recommended",    tone: "bad" },
};
// "warn" reads ink: the ring gold paints the M.I.A. score only (one look, 23 Oct 2026).
const TONE: Record<string, string> = { good: "#10B981", warn: Bold.ink, bad: "#EF4444" };

function fmtDate(iso?: string | null): string {
  if (!iso) return "";
  try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); } catch { return ""; }
}
function num(n?: number | null): string { return n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }

export function MediaDetailScreen() {
  const nav = useNavigation<NativeStackNavigationProp<StudioStackParamList>>();
  const route = useRoute<RouteProp<StudioStackParamList, "MediaDetail">>();
  const { detail, isLoading } = useMediaDetail(route.params.assetId);
  // Press-to-play. This box is also the IMAGE preview, so a player mounted for every asset would
  // decode a video on a screen that is usually showing a photo.
  const [playing, setPlaying] = useState(false);
  // Muted like the Studio preview: a review surface that starts making noise is one people mute at
  // the OS. Per-screen state, shared control — see MuteToggle.
  const [muted, setMuted] = useState(true);
  const soon = (label: string) => Alert.alert(label, "Coming soon.");

  const v = detail?.vision ?? null;
  const isVideo = detail?.media_type === "VIDEO" || detail?.media_type === "REELS" || !!detail?.video_url;
  // The clip's read state (PR 9.5): the server's, until a tap here moves it — then each state it passes through.
  const [readLocal, setReadLocal] = useState<ClipRead | null>(null);
  const read = readLocal ?? detail?.read ?? null;
  const clipRead = useClipRead();
  const affordance = readAffordance({ kind: isVideo ? "clip" : "photo", read }, STUDIO_CLIP_READ);
  const startRead = () => {
    if (!detail || !read || read.state === "done") return;
    // The ASSET id is the route's — `detail.id` is the source post's id, null on an upload.
    clipRead.mutate({ assetId: route.params.assetId, quotedUsd: read.quotedUsd, onRead: setReadLocal });
  };
  const disp = v ? DISPOSITION[v.disposition] ?? { label: v.disposition, tone: "warn" as const } : null;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.header}>
        <Pressable onPress={() => nav.goBack()} style={styles.icoBtn} hitSlop={10}>
          <Feather name="chevron-left" size={24} color={Colors.light.text} />
        </Pressable>
        <Text style={styles.title}>Media</Text>
        <View style={styles.icoBtn} />
      </View>

      {isLoading || !detail ? (
        <View style={styles.center}><ActivityIndicator color={Colors.light.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 44 }} showsVerticalScrollIndicator={false}>
          {/* preview */}
          {libraryPreview({ mediaType: detail.media_type, thumbUrl: detail.thumb_url, videoUrl: detail.video_url }, playing) === "player" ? (
            /* ⚠️ The mp4, never the poster. A still standing in for playback is indistinguishable from
               a broken player — the V7 symptom. Shaped SQUARE because this wire carries no width or
               height (media_assets stores both; GET /media does not serve them), and a library holds
               both orientations: contain then letterboxes either one rather than reducing a landscape
               clip to a 180pt strip. */
            <View testID="library-player" style={styles.playerWrap}>
              <ClipPlayer uri={detail.video_url!} ratio={1} maxHeight={320} muted={muted} />
              <MuteToggle muted={muted} onToggle={() => setMuted((m) => !m)} testID="library-mute" />
            </View>
          ) : (
          <View style={styles.preview}>
            {/* Poster when there is one, the clip's own first frame when there is not: an upload has no
                gcs_thumb_path until the media-poster cron fires — minutes in production, never on a
                laptop — so this box was empty for every clip just added. A STILL until she presses
                play; the button below is wired now. */}
            <ClipPoster source={{ mediaType: detail.media_type, thumbUrl: detail.thumb_url, videoUrl: detail.video_url }} style={StyleSheet.absoluteFill} icon="image" />
            <View style={styles.srcPill}>
              <Feather name={detail.origin === "connected" ? "instagram" : detail.origin === "upload" ? "upload" : detail.origin === "generated" ? "zap" : "compass"} size={11} color="#fff" />
              <Text style={styles.srcPillTxt}>{SOURCE_LABEL[detail.origin] ?? detail.origin}</Text>
            </View>
            {isVideo && detail.video_url ? <HapticPressable testID="library-play" style={styles.playBtn} onPress={() => setPlaying(true)} accessibilityRole="button" accessibilityLabel="Play this video"><Feather name="play" size={20} color="#fff" /></HapticPressable> : null}
          </View>
          )}

          {/* Pipeline status — analysis · embedding · (video) thumbnail, at a glance */}
          <StatusStrip
            analyzed={analyzedOf({ isVideo, vision: v, read })}
            analyzedPending={analyzedPendingLabel(isVideo, read)}
            embedded={!!detail.embedded}
            video={isVideo}
            posterReady={!!detail.poster_gcs_path}
          />
          {affordance ? (
            <View style={styles.readRow}>
              <Pressable testID="read-clip" style={[styles.readBtn, !affordance.tappable && styles.readBtnOff]} onPress={affordance.tappable ? startRead : undefined} disabled={!affordance.tappable} accessibilityRole="button" accessibilityState={{ disabled: !affordance.tappable, busy: affordance.state === "reading" }} accessibilityLabel={affordance.label}>
                <Feather name={affordance.state === "done" ? "check-circle" : affordance.state === "reading" ? "loader" : "film"} size={12} color={affordance.tappable ? "#fff" : Colors.light.textMuted} />
                <Text style={[styles.readBtnTxt, !affordance.tappable && styles.readBtnTxtOff]}>{affordance.label}</Text>
              </Pressable>
              {affordance.sub ? <Text style={styles.readSub}>{affordance.sub}</Text> : null}
            </View>
          ) : null}

          {!v ? (
            <View style={styles.analyzing}>
              <ActivityIndicator color={Colors.light.primary} />
              <Text style={styles.analyzingTxt}>Mila is still analysing this — check back in a moment.</Text>
            </View>
          ) : (
            <View style={styles.body}>
              {/* What Mila saw */}
              <View style={styles.eyebrowRow}>
                <Feather name="eye" size={13} color={Colors.light.primary} />
                <Text style={styles.eyebrow}>WHAT MILA SAW</Text>
              </View>
              <Text style={styles.desc}>{v.description}</Text>

              {/* facet chips */}
              <View style={styles.facets}>
                <Facet label="Shot" value={v.shot_type} filled />
                <Facet label="Setting" value={v.setting} />
                <Facet label="Attire" value={v.attire} />
                <Facet label="Vibe" value={v.vibe} />
              </View>

              {/* score meters */}
              <View style={styles.card}>
                <Meter label="Aesthetic" value={v.aesthetic_quality} color={Bold.ink} />
                <Meter label="Hero-ready" value={v.hero_suitability} color={Bold.ink} />
                <Meter label={v.athlete_present ? "Athlete prominence" : "Athlete not in frame"} value={v.athlete_present ? v.athlete_prominence : 0} color={Bold.ink} />
              </View>

              {/* brands identified */}
              {v.brands_visible && v.brands_visible.length > 0 ? (
                <View>
                  <Text style={styles.secLbl}>Brands identified</Text>
                  <View style={styles.brandRow}>
                    {v.brands_visible.map((b) => (
                      <View key={b} style={styles.brandChip}>
                        <View style={styles.brandMono}><Text style={styles.brandMonoTxt}>{b[0]?.toUpperCase()}</Text></View>
                        <Text style={styles.brandChipTxt}>{b}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              ) : null}

              {/* verdict: brand-safe + disposition */}
              <View style={styles.card}>
                <View style={styles.verdictRow}>
                  <Feather name={v.brand_safe ? "shield" : "alert-triangle"} size={16} color={v.brand_safe ? "#10B981" : Bold.ink} />
                  <Text style={styles.verdictTxt}>{v.brand_safe ? "Brand-safe" : "Flagged — review before sending"}</Text>
                </View>
                {disp ? (
                  <View style={styles.verdictRow}>
                    <View style={[styles.dispDot, { backgroundColor: TONE[disp.tone] }]} />
                    <Text style={[styles.verdictTxt, { color: TONE[disp.tone] }]}>{disp.label}</Text>
                  </View>
                ) : null}
                {v.reason ? <Text style={styles.reason}>{v.reason}</Text> : null}
                {v.edit_note && v.edit_note.toLowerCase() !== "none" ? <Text style={styles.editNote}>Suggested edit: {v.edit_note}</Text> : null}
              </View>

              {/* provenance */}
              <Text style={styles.secLbl}>Provenance</Text>
              <View style={styles.card}>
                <ProvRow k="Source" val={SOURCE_LABEL[detail.origin] ?? detail.origin} />
                {detail.posted_at ? <ProvRow k="Captured" val={fmtDate(detail.posted_at)} /> : null}
                {(detail.like_count != null || detail.reach != null || detail.saves != null) ? (
                  <ProvRow k="Performance" val={`${num(detail.like_count)} likes · ${num(detail.reach)} reach · ${num(detail.saves)} saves`} />
                ) : null}
                {detail.permalink ? (
                  <Pressable style={styles.linkRow} onPress={() => Linking.openURL(detail.permalink!)}>
                    <Feather name="external-link" size={14} color={Colors.light.primary} />
                    <Text style={styles.linkTxt}>View original post</Text>
                  </Pressable>
                ) : null}
              </View>

              {/* embedding capability */}
              <View style={styles.card}>
                <View style={styles.verdictRow}>
                  <Feather name={detail.embedded ? "check-circle" : "loader"} size={15} color={detail.embedded ? "#10B981" : Colors.light.textMuted} />
                  <Text style={styles.verdictTxt}>{detail.embedded ? "Embedded" : "Embedding…"}</Text>
                </View>
                <Text style={styles.reason}>Powers similarity search &amp; auto-curation.</Text>
                {detail.embedded ? (
                  <Pressable style={styles.findSimilar} onPress={() => soon("Find similar")}>
                    <Feather name="search" size={14} color={Colors.light.primary} />
                    <Text style={styles.findSimilarTxt}>Find similar</Text>
                  </Pressable>
                ) : null}
              </View>

              {/* corrections (hint) */}
              <View style={styles.corrections}>
                <Pressable style={styles.corrChip} onPress={() => soon("Override brand-safe")}><Text style={styles.corrTxt}>Override brand-safe</Text></Pressable>
                <Pressable style={styles.corrChip} onPress={() => soon("Re-tag")}><Text style={styles.corrTxt}>Re-tag</Text></Pressable>
                <Pressable style={styles.corrChip} onPress={() => soon("Force include")}><Text style={styles.corrTxt}>Force include</Text></Pressable>
              </View>
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function Facet({ label, value, filled }: { label: string; value?: string; filled?: boolean }) {
  if (!value) return null;
  return (
    <View style={[styles.facet, filled && styles.facetFilled]}>
      <Text style={[styles.facetK, filled && styles.facetKFilled]}>{label}</Text>
      <Text style={[styles.facetV, filled && styles.facetVFilled]}>{value}</Text>
    </View>
  );
}
function Meter({ label, value, color }: { label: string; value: number; color: string }) {
  const pct = Math.round((value ?? 0) * 100);
  return (
    <View style={styles.meterRow}>
      <Text style={styles.meterLabel} numberOfLines={1}>{label}</Text>
      <View style={styles.meterTrack}><View style={[styles.meterFill, { width: `${pct}%`, backgroundColor: color }]} /></View>
      <Text style={styles.meterPct}>{pct}%</Text>
    </View>
  );
}
function ProvRow({ k, val }: { k: string; val: string }) {
  return (
    <View style={styles.provRow}>
      <Text style={styles.provK}>{k}</Text>
      <Text style={styles.provV} numberOfLines={1}>{val}</Text>
    </View>
  );
}

/** At-a-glance processing state: analysis (vision) · embedding · (video only) thumbnail/poster. */
function StatusStrip({ analyzed, analyzedPending = "Analyzing…", embedded, video, posterReady }: { analyzed: boolean; analyzedPending?: string; embedded: boolean; video: boolean; posterReady: boolean }) {
  const items = [
    { key: "analyzed", done: analyzed, doneLabel: "Analyzed", pendLabel: analyzedPending },
    { key: "embedded", done: embedded, doneLabel: "Embedded", pendLabel: "Embedding…" },
    ...(video ? [{ key: "thumb", done: posterReady, doneLabel: "Thumbnail", pendLabel: "Generating…" }] : []),
  ];
  return (
    <View style={styles.statusStrip}>
      {items.map((it) => (
        <View key={it.key} style={[styles.statusPill, it.done ? styles.statusPillDone : styles.statusPillPending]}>
          <Feather name={it.done ? "check-circle" : "loader"} size={12} color={it.done ? "#10B981" : Colors.light.textMuted} />
          <Text style={[styles.statusPillTxt, { color: it.done ? "#0B7A54" : Colors.light.textMuted }]}>
            {it.done ? it.doneLabel : it.pendLabel}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm },
  icoBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, textAlign: "center", fontFamily: Fonts.heading, fontSize: 18, fontWeight: "700", color: Colors.light.text },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  preview: { marginHorizontal: Spacing.lg, height: 320, borderRadius: 20, overflow: "hidden", backgroundColor: Colors.light.backgroundSecondary },
  playerWrap: { marginHorizontal: Spacing.lg, position: "relative" },
  srcPill: { position: "absolute", top: 12, left: 12, flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "rgba(13,11,8,0.62)", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  srcPillTxt: { fontFamily: Fonts.bodyBold, fontSize: 11, fontWeight: "700", color: "#fff" },
  playBtn: { position: "absolute", top: "50%", left: "50%", marginLeft: -24, marginTop: -24, width: 48, height: 48, borderRadius: 24, backgroundColor: "rgba(13,11,8,0.55)", alignItems: "center", justifyContent: "center" },
  statusStrip: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: Spacing.lg, paddingTop: 12 },
  statusPill: { flexDirection: "row", alignItems: "center", gap: 5, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1 },
  statusPillDone: { backgroundColor: "#10B98114", borderColor: "#10B98133" },
  statusPillPending: { backgroundColor: Colors.light.backgroundSecondary, borderColor: Colors.light.border },
  statusPillTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 12, fontWeight: "600" },
  readRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingHorizontal: Spacing.lg, paddingTop: 10 },
  readBtn: { minWidth: 120, flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: Colors.light.text },
  readBtnOff: { backgroundColor: Colors.light.backgroundSecondary },
  readBtnTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 12, fontWeight: "600", color: "#fff" },
  readBtnTxtOff: { color: Colors.light.textMuted },
  readSub: { fontFamily: Fonts.body, fontSize: 12, color: Colors.light.textMuted, flexShrink: 1 },
  analyzing: { alignItems: "center", gap: 12, paddingVertical: 50, paddingHorizontal: 40 },
  analyzingTxt: { fontFamily: Fonts.body, fontSize: 14, color: Colors.light.textMuted, textAlign: "center" },
  body: { paddingHorizontal: Spacing.lg, paddingTop: 18, gap: 16 },
  eyebrowRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  eyebrow: { fontFamily: Fonts.bodyBold, fontSize: 11, letterSpacing: 1.4, color: Colors.light.primary, fontWeight: "700" },
  desc: { fontFamily: Fonts.display, fontSize: 19, lineHeight: 26, fontWeight: "700", color: Colors.light.text, marginTop: -8 },
  facets: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  facet: { backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 },
  facetFilled: { backgroundColor: Colors.light.text, borderColor: Colors.light.text },
  facetK: { fontFamily: Fonts.bodyBold, fontSize: 8.5, letterSpacing: 0.5, textTransform: "uppercase", color: Colors.light.textMuted, fontWeight: "700" },
  facetKFilled: { color: "rgba(255,255,255,0.6)" },
  facetV: { fontFamily: Fonts.bodySemiBold, fontSize: 13, fontWeight: "600", color: Colors.light.text, marginTop: 1 },
  facetVFilled: { color: "#fff", textTransform: "capitalize" },
  card: { backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border, borderRadius: 16, padding: 14, gap: 11 },
  meterRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  meterLabel: { fontFamily: Fonts.bodyMedium, fontSize: 12.5, color: Colors.light.textSecondary, width: 130 },
  meterTrack: { flex: 1, height: 7, borderRadius: 4, backgroundColor: Colors.light.backgroundSecondary, overflow: "hidden" },
  meterFill: { height: 7, borderRadius: 4 },
  meterPct: { fontFamily: Fonts.bodyBold, fontSize: 12, fontWeight: "700", color: Colors.light.text, width: 36, textAlign: "right" },
  secLbl: { fontFamily: Fonts.bodyBold, fontSize: 11, letterSpacing: 0.8, textTransform: "uppercase", color: Colors.light.textMuted, fontWeight: "700" },
  brandRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  brandChip: { flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border, borderRadius: 999, paddingLeft: 4, paddingRight: 12, paddingVertical: 4 },
  brandMono: { width: 24, height: 24, borderRadius: 12, backgroundColor: Brand.heroBg, alignItems: "center", justifyContent: "center" },
  brandMonoTxt: { fontFamily: Fonts.bodyBold, fontSize: 11, fontWeight: "800", color: "#F2E7CE" },
  brandChipTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 13, fontWeight: "600", color: Colors.light.text },
  verdictRow: { flexDirection: "row", alignItems: "center", gap: 9 },
  verdictTxt: { fontFamily: Fonts.bodyBold, fontSize: 14, fontWeight: "700", color: Colors.light.text },
  dispDot: { width: 16, height: 16, borderRadius: 8 },
  reason: { fontFamily: Fonts.body, fontSize: 13, lineHeight: 18, color: Colors.light.textSecondary },
  editNote: { fontFamily: Fonts.bodyMedium, fontSize: 12.5, color: Colors.light.textMuted, fontStyle: "italic" },
  provRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  provK: { fontFamily: Fonts.bodyMedium, fontSize: 13, color: Colors.light.textMuted },
  provV: { flex: 1, textAlign: "right", fontFamily: Fonts.bodySemiBold, fontSize: 13, fontWeight: "600", color: Colors.light.text },
  linkRow: { flexDirection: "row", alignItems: "center", gap: 7, paddingTop: 2 },
  linkTxt: { fontFamily: Fonts.bodyBold, fontSize: 13, fontWeight: "700", color: Colors.light.primary },
  findSimilar: { flexDirection: "row", alignItems: "center", gap: 7, alignSelf: "flex-start", backgroundColor: Colors.light.primaryLight, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 8, marginTop: 2 },
  findSimilarTxt: { fontFamily: Fonts.bodyBold, fontSize: 13, fontWeight: "700", color: Colors.light.primary },
  corrections: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 4 },
  corrChip: { backgroundColor: Colors.light.backgroundDefault, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  corrTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 12, fontWeight: "600", color: Colors.light.textSecondary },
});
