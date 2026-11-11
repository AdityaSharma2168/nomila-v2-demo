import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable, Image, Modal, FlatList, ActivityIndicator, Dimensions, Linking,
  type NativeSyntheticEvent, type NativeScrollEvent } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useVideoPlayer, VideoView } from "expo-video";
import { Fonts, Colors, Spacing, BorderRadius } from "../../constants/theme";
import { useMedia, type MediaItem } from "../../hooks/use-media";
import { PlatformIcon } from "../PlatformIcon";

const GAP  = 8;
const TILE = 104;
const PLATFORM_LABEL: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" };

/** Inline player for a top-performer mp4 (mounted only when we own the file, so the hook is safe).
 *  Portrait 9:16 frame sized to the screen — reels fill it edge-to-edge, like viewing on Instagram. */
function PostVideo({ url }: { url: string }) {
  const player = useVideoPlayer(url, (p) => { p.loop = true; p.play(); });
  return <VideoView player={player} style={styles.videoFull} contentFit="contain" nativeControls />;
}

/** A single post image shown at its natural aspect ratio (read on load), capped to the screen. */
function PostImage({ url }: { url: string }) {
  const [ar, setAr] = useState(1);   // width / height
  return (
    <Image
      source={{ uri: url }}
      style={[styles.mediaFrame, { height: frameH(ar) }]}
      resizeMode="contain"
      onLoad={(e) => { const s = e.nativeEvent.source; if (s?.width && s?.height) setAr(s.width / s.height); }}
    />
  );
}

/** Compact number: 5388394 -> 5.4M, 581143 -> 581k, 4321 -> 4.3k, 892 -> 892. */
function fmt(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "k";
  return String(n);
}

/** The athlete's own durable (re-hosted) posts for one platform — Top Performing + Most Recent rows. */
export function MediaGallery({ platform }: { platform?: string | null }) {
  const { items, top, summary, isLoading, error } = useMedia(platform ?? undefined);
  const [active, setActive]         = useState<MediaItem | null>(null);
  const [page, setPage]             = useState(0);
  const [carouselAr, setCarouselAr] = useState(1);   // carousels are uniform-aspect on IG; size to child 0

  const open   = (m: MediaItem) => { setPage(0); setCarouselAr(1); setActive(m); };
  const onPage = (e: NativeSyntheticEvent<NativeScrollEvent>) =>
    setPage(Math.round(e.nativeEvent.contentOffset.x / IMG_W));

  const renderTile = (m: MediaItem, showStat: boolean) => {
    const stat    = m.views ?? m.like_count;
    const isViews = m.views != null;
    return (
      <Pressable onPress={() => open(m)} style={styles.tile}>
        {m.thumb_url
          ? <Image source={{ uri: m.thumb_url }} style={styles.tileImg} />
          : <View style={[styles.tileImg, styles.empty]}><Feather name="image" size={18} color="#BBB" /></View>}
        {m.media_type === "CAROUSEL_ALBUM" && (
          <View style={styles.badge}><Feather name="copy" size={11} color="#fff" /></View>
        )}
        {(m.media_type === "VIDEO" || m.media_type === "REELS") && (
          <View style={styles.badge}><Feather name="play" size={11} color="#fff" /></View>
        )}
        {showStat && stat != null && (
          <View style={styles.statPill}>
            <Feather name={isViews ? "eye" : "heart"} size={9} color="#fff" />
            <Text style={styles.statPillText}>{fmt(stat)}</Text>
          </View>
        )}
      </Pressable>
    );
  };

  if (isLoading) return <View style={styles.state}><ActivityIndicator size="small" color={Colors.light.primary} /></View>;
  if (error || !items.length) return null;   // silent until there's something to show

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <Text style={styles.sectionLabel}>YOUR POSTS</Text>
        {!!summary && <Text style={styles.headCount}>{summary.total}</Text>}
      </View>
      {!!summary && <Text style={styles.statText}>{summary.by_type.photos} photos · {summary.by_type.videos} videos</Text>}

      {top.length > 0 && (
        <>
          <Text style={styles.rowLabel}>TOP PERFORMING</Text>
          <FlatList
            horizontal data={top} keyExtractor={(m) => `top-${m.id}`}
            showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}
            renderItem={({ item }) => renderTile(item, true)}
          />
        </>
      )}

      <Text style={styles.rowLabel}>MOST RECENT</Text>
      <FlatList
        horizontal data={items} keyExtractor={(m) => `recent-${m.id}`}
        showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}
        renderItem={({ item }) => renderTile(item, false)}
      />

      <Modal visible={!!active} transparent animationType="fade" onRequestClose={() => setActive(null)}>
        <View style={styles.overlay}>
          {/* backdrop sits BEHIND the sheet — tap anywhere outside to close. Never wraps the
              pager, so the horizontal swipe never fights a Pressable for the touch responder. */}
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setActive(null)} />
          {active && (
            <View style={styles.sheet} pointerEvents="box-none">
              <View style={styles.sheetHead}>
                <Text style={styles.sheetMeta} numberOfLines={1}>
                  {[
                    active.views != null ? `${fmt(active.views)} views` : null,
                    active.reach != null ? `${fmt(active.reach)} reach` : null,
                    `${fmt(active.like_count ?? 0)} likes`,
                    `${fmt(active.comments_count ?? 0)} comments`,
                    active.saves != null ? `${fmt(active.saves)} saves` : null,
                  ].filter(Boolean).join(" · ")}
                </Text>
                <Pressable onPress={() => setActive(null)} hitSlop={8}><Feather name="x" size={20} color="#9C968D" /></Pressable>
              </View>
              {active.media_type === "CAROUSEL_ALBUM" && active.children?.length ? (
                <>
                  <FlatList
                    data={active.children}
                    keyExtractor={(c) => c.id}
                    horizontal
                    pagingEnabled
                    showsHorizontalScrollIndicator={false}
                    onMomentumScrollEnd={onPage}
                    style={{ width: IMG_W, flexGrow: 0 }}
                    renderItem={({ item: c, index }) => (
                      <Image
                        source={c.url ? { uri: c.url } : undefined}
                        style={[styles.mediaFrame, { height: frameH(carouselAr) }]}
                        resizeMode="contain"
                        onLoad={index === 0 ? (e) => { const s = e.nativeEvent.source; if (s?.width && s?.height) setCarouselAr(s.width / s.height); } : undefined}
                      />
                    )}
                  />
                  <View style={styles.counter}>
                    <Text style={styles.counterText}>{page + 1} / {active.children.length}</Text>
                  </View>
                </>
              ) : active.video_url ? (
                <PostVideo key={active.id} url={active.video_url} />
              ) : active.url ? (
                <PostImage key={active.id} url={active.url} />
              ) : null}
              {!!active.caption && <Text style={styles.caption} numberOfLines={3}>{active.caption}</Text>}
              {!!active.permalink && (
                <Pressable style={styles.openBtn} onPress={() => Linking.openURL(active.permalink!)}>
                  <PlatformIcon platform={active.platform} color="#E8E3DC" size={14} />
                  <Text style={styles.openText}>
                    {active.media_type === "VIDEO" || active.media_type === "REELS" ? "Watch on " : "View on "}{PLATFORM_LABEL[active.platform] ?? "original"}
                  </Text>
                </Pressable>
              )}
            </View>
          )}
        </View>
      </Modal>
    </View>
  );
}

const IMG_W = Dimensions.get("window").width - Spacing.xl * 2;
// Portrait video frame: 9:16, as tall as fits (leaving room for header + caption), width derived.
const VIDEO_H = Math.min(Dimensions.get("window").height * 0.72, IMG_W * 16 / 9);
const VIDEO_W = VIDEO_H * 9 / 16;
// Image/carousel frame height from the image's aspect ratio (w/h), full width, capped to the screen.
const MAX_MEDIA_H = Dimensions.get("window").height * 0.72;
const frameH = (ar: number) => Math.min(IMG_W / (ar || 1), MAX_MEDIA_H);

const styles = StyleSheet.create({
  state: { paddingVertical: Spacing.lg, alignItems: "center" },
  card:  { backgroundColor: Colors.light.card, borderRadius: BorderRadius.lg, padding: Spacing.lg,
    shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 3, elevation: 2 },
  sectionLabel: { fontFamily: Fonts.bodySemiBold, fontSize: 11, color: Colors.light.textMuted, letterSpacing: 0.8 },
  headRow:   { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headCount: { fontFamily: Fonts.bodySemiBold, fontSize: 12, color: Colors.light.textMuted, fontVariant: ["tabular-nums"] },
  statText:  { fontFamily: Fonts.body, fontSize: 11, color: Colors.light.textMuted, marginTop: 2 },

  rowLabel: { fontFamily: Fonts.bodySemiBold, fontSize: 10, color: Colors.light.textMuted, letterSpacing: 0.6,
    marginTop: Spacing.lg, marginBottom: Spacing.sm },
  row:  { gap: GAP },
  tile: { width: TILE, height: TILE, position: "relative" },
  tileImg: { width: "100%", height: "100%", borderRadius: BorderRadius.sm, backgroundColor: Colors.light.backgroundSecondary },
  empty: { alignItems: "center", justifyContent: "center" },
  badge: { position: "absolute", top: 5, right: 5, width: 20, height: 20, borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center" },
  statPill: { position: "absolute", bottom: 5, left: 5, flexDirection: "row", alignItems: "center", gap: 3,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999, backgroundColor: "rgba(0,0,0,0.62)" },
  statPillText: { fontFamily: Fonts.bodySemiBold, fontSize: 10, color: "#fff", fontVariant: ["tabular-nums"] },

  overlay: { flex: 1, backgroundColor: "rgba(20,18,16,0.9)", justifyContent: "center", padding: Spacing.lg },
  sheet:   { alignItems: "center" },
  sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", width: IMG_W, marginBottom: Spacing.sm },
  sheetMeta: { fontFamily: Fonts.bodyMedium, fontSize: 12, color: "#E8E3DC", flex: 1, marginRight: Spacing.sm },
  mediaFrame: { width: IMG_W, borderRadius: BorderRadius.md, backgroundColor: "#000" },
  videoFull:  { width: VIDEO_W, height: VIDEO_H, borderRadius: BorderRadius.md, backgroundColor: "#000" },
  counter: { alignSelf: "center", marginTop: Spacing.sm, paddingHorizontal: 10, paddingVertical: 3,
    borderRadius: 999, backgroundColor: "rgba(255,255,255,0.14)" },
  counterText: { fontFamily: Fonts.bodyMedium, fontSize: 12, color: "#E8E3DC", fontVariant: ["tabular-nums"] },
  caption: { fontFamily: Fonts.body, fontSize: 13, color: "#E8E3DC", width: IMG_W, marginTop: Spacing.sm, lineHeight: 18 },
  openBtn: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", marginTop: Spacing.md,
    paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.14)" },
  openText: { fontFamily: Fonts.bodyMedium, fontSize: 13, color: "#E8E3DC" },
});
