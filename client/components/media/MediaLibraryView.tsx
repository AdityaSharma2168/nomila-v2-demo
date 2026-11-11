import React, { useEffect, useMemo, useState } from "react";
import {
  View, Text, Pressable, StyleSheet, TextInput, FlatList, Image, ActivityIndicator, useWindowDimensions, RefreshControl,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import {
  useMyMedia, useUploadMediaBatch, pickFromCameraRoll, RightsAckRequired,
  type MediaItem, type MediaTypeFilter,
} from "../../hooks/use-media-library";
import { cameraRollReviewAvailable } from "../../hooks/use-camera-roll-review";
import { RightsAckPanel } from "./RightsAckPanel";
import { CAMERA_ROLL_INTAKE, STUDIO_LIBRARY_FIELDS } from "../../lib/flags";
import { libraryTileLabel } from "../../screens/mediaLibraryLogic";
import { Bold, Colors, Fonts, Spacing } from "../../constants/theme";
import { Photo } from "../ui/Photo";

/**
 * MediaLibraryView — the athlete's full library UI (search · type/source filters · grid · upload),
 * reused in two contexts: the standalone Studio screen (tap → `onOpenDetail`) and the card editor's
 * "browse all" picker (tap → `onPick`, returning the selection to the card). `accept` locks it to a
 * card-compatible media type.
 */
const TYPES: { key: MediaTypeFilter; label: string }[] = [
  { key: undefined, label: "All" },
  { key: "photos",  label: "Photos" },
  { key: "videos",  label: "Videos" },
];
const SOURCES: { key: string; label: string; icon: React.ComponentProps<typeof Feather>["name"] }[] = [
  { key: "all",       label: "All",       icon: "grid" },
  { key: "connected", label: "Instagram", icon: "instagram" },
  { key: "upload",    label: "Uploads",   icon: "upload" },
  { key: "generated", label: "Generated", icon: "zap" },
  { key: "discovery", label: "Discovery", icon: "compass" },
];

function sourceIcon(origin: string): React.ComponentProps<typeof Feather>["name"] {
  return origin === "connected" ? "instagram" : origin === "upload" ? "upload" : origin === "generated" ? "zap" : "compass";
}
function fmtDur(s: number | null): string {
  if (s == null) return "";
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

export function MediaLibraryView({
  onPick,
  onOpenDetail,
  onReviewCameraRoll,
  accept,
}: {
  onPick?: (m: MediaItem) => void;
  onOpenDetail?: (assetId: string) => void;
  /**
   * Opens "Review my camera roll". Optional on purpose: the standalone library screen passes a
   * navigation callback, the card editor's embedded picker does not — leaving a modal picker
   * mid-pick to run a 500-photo review is not something to offer there. Absent ⇒ no button. The
   * button also hides on web, where expo-media-library has nothing to read.
   */
  onReviewCameraRoll?: () => void;
  accept?: "photo" | "video";
}) {
  const { width } = useWindowDimensions();
  const lockType = !!accept;

  const [type, setType] = useState<MediaTypeFilter>(accept === "video" ? "videos" : accept === "photo" ? "photos" : undefined);
  const [source, setSource] = useState<string>("all");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { const t = setTimeout(() => setQ(qInput), 300); return () => clearTimeout(t); }, [qInput]);

  const lib = useMyMedia(type, { source, q });
  const upload = useUploadMediaBatch();
  const items = useMemo(() => lib.data?.pages.flatMap((p) => p.items) ?? [], [lib.data]);
  const summary = lib.data?.pages[0]?.summary;

  // Pull-to-refresh — re-fetch the library so freshly uploaded/enriched media appears without a reload.
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => {
    setRefreshing(true);
    try { await lib.refetch(); } finally { setRefreshing(false); }
  };

  const gap = 4;
  const pad = Spacing.lg;
  const size = Math.floor((width - pad * 2 - gap * 2) / 3);

  // The assets waiting on the one-time rights ack — set when the mint answers 428.
  const [ackAssets, setAckAssets] = useState<ImagePicker.ImagePickerAsset[] | null>(null);
  // "Uploading 3 of 12…" while a multi-select batch is running.
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  // The final tally once a multi-select batch finishes (single uploads stay silent, as before).
  const [batchNote, setBatchNote] = useState<string | null>(null);

  const runUpload = async (assets: ImagePicker.ImagePickerAsset[], ackRights: boolean) => {
    setProgress({ current: 0, total: assets.length });
    try {
      const result = await upload.mutateAsync({
        assets, ackRights,
        onProgress: (p) => setProgress({ current: p.current, total: p.total }),
      });
      setAckAssets(null);
      if (result.succeeded.length && onPick) onPick(result.succeeded[result.succeeded.length - 1]);
      setBatchNote(
        assets.length > 1
          ? `Uploaded ${result.succeeded.length} of ${assets.length}${result.failed.length ? ` — ${result.failed.length} failed` : ""}`
          : null
      );
    } catch (e) {
      if (e instanceof RightsAckRequired) setAckAssets(assets);   // show the inline ack panel
    } finally {
      setProgress(null);
    }
  };

  const onUpload = async () => {
    const picked = await pickFromCameraRoll(accept ?? "all", { multiple: true });
    if (!picked) return;
    setBatchNote(
      picked.truncated ? `Uploading the first ${picked.truncated.kept} of ${picked.truncated.picked} selected` : null
    );
    await runUpload(picked.assets, false);
  };

  return (
    <View style={{ flex: 1 }}>
      {/* search + upload */}
      <View style={styles.topRow}>
        <View style={styles.search}>
          <Feather name="search" size={16} color={Colors.light.textMuted} />
          <TextInput
            value={qInput}
            onChangeText={setQInput}
            placeholder="Search — “beach”, “Nike”, “action”…"
            placeholderTextColor={Colors.light.textMuted}
            style={styles.searchInput}
            autoCapitalize="none"
          />
          {qInput ? <Pressable onPress={() => setQInput("")} hitSlop={8}><Feather name="x" size={16} color={Colors.light.textMuted} /></Pressable> : null}
        </View>
        {onReviewCameraRoll && cameraRollReviewAvailable ? (
          <Pressable
            onPress={onReviewCameraRoll}
            style={styles.reviewBtn}
            accessibilityRole="button"
            accessibilityLabel={CAMERA_ROLL_INTAKE ? "Add from camera roll" : "Review my camera roll"}
          >
            <Feather name={CAMERA_ROLL_INTAKE ? "image" : "check-square"} size={17} color={Colors.light.text} />
          </Pressable>
        ) : null}
        <Pressable onPress={onUpload} style={styles.uploadBtn} disabled={upload.isPending}>
          {upload.isPending ? <ActivityIndicator size="small" color="#fff" /> : <Feather name="plus" size={18} color="#fff" />}
        </Pressable>
      </View>

      {/* One-time rights acknowledgment (inline, not an OS alert — Alert.alert is a no-op on web) */}
      {ackAssets && (
        <View style={styles.ackWrap}>
          <RightsAckPanel
            busy={upload.isPending}
            onConfirm={() => runUpload(ackAssets, true)}
            onCancel={() => setAckAssets(null)}
          />
        </View>
      )}

      {progress ? (
        <Text style={styles.summary}>Uploading {progress.current} of {progress.total}…</Text>
      ) : batchNote ? (
        <Text style={styles.summary}>{batchNote}</Text>
      ) : null}

      {summary ? (
        <Text style={styles.summary}>{summary.total} items · {summary.by_type.photos} photos · {summary.by_type.videos} clips</Text>
      ) : null}

      {!lockType ? (
        <View style={styles.tabs}>
          {TYPES.map((t) => {
            const on = type === t.key;
            return (
              <Pressable key={t.label} onPress={() => setType(t.key)} style={[styles.tab, on && styles.tabOn]}>
                <Text style={[styles.tabTxt, on && styles.tabTxtOn]}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        data={SOURCES}
        keyExtractor={(s) => s.key}
        // A horizontal FlatList is a ScrollView, and ScrollView's base style is
        // { flexGrow: 1, flexShrink: 1 } — so in this column it SHRINKS to make room for the grid
        // below (which grows) and ends up about half a chip tall. The row above (`tabs`) is a plain
        // View, which is why that one always looked right and this one did not. #323 set flexGrow
        // to 0, which is the View default and not what ScrollView overrides — the row stayed
        // clipped. The shrink is the culprit; see chipRow.
        style={styles.chipRow}
        contentContainerStyle={styles.chips}
        renderItem={({ item: s }) => {
          const on = source === s.key;
          return (
            <Pressable onPress={() => setSource(s.key)} style={[styles.chip, on && styles.chipOn]}>
              <Feather name={s.icon} size={12} color={on ? Colors.light.backgroundRoot : Colors.light.textSecondary} />
              <Text style={[styles.chipTxt, on && styles.chipTxtOn]}>{s.label}</Text>
            </Pressable>
          );
        }}
      />

      <FlatList
        data={items}
        keyExtractor={(m) => m.asset_id}
        numColumns={3}
        columnWrapperStyle={{ gap, paddingHorizontal: pad }}
        contentContainerStyle={{ gap, paddingTop: 8, paddingBottom: 40 }}
        onEndReachedThreshold={0.5}
        onEndReached={() => { if (lib.hasNextPage && !lib.isFetchingNextPage) lib.fetchNextPage(); }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.light.primary} colors={[Colors.light.primary]} />
        }
        ListEmptyComponent={
          lib.isLoading ? (
            <View style={styles.empty}><ActivityIndicator color={Colors.light.primary} /></View>
          ) : (
            <View style={styles.empty}>
              <Feather name="image" size={26} color={Colors.light.textMuted} />
              <Text style={styles.emptyTxt}>{q ? "Nothing matches that." : "No media yet — upload to get started."}</Text>
            </View>
          )
        }
        ListFooterComponent={lib.isFetchingNextPage ? <View style={styles.footer}><ActivityIndicator color={Colors.light.primary} /></View> : null}
        renderItem={({ item: m }) => (
          <MediaGridTile item={m} size={size} onPress={() => (onPick ? onPick(m) : onOpenDetail?.(m.asset_id))} />
        )}
      />
    </View>
  );
}

function MediaGridTile({ item, size, onPress }: { item: MediaItem; size: number; onPress: () => void }) {
  const isVideo = item.media_type === "VIDEO" || item.media_type === "REELS" || !!item.video_url;
  // thumb_url is an IMAGE or null — the API decides (routes/media.ts shapeItems): a made poster,
  // the stored still an Instagram clip arrives as, or null for an uploaded video whose poster is
  // not made yet. The old client-side guard (`poster_gcs_path` required for videos) was written
  // for that last case and hid every Instagram clip as well — 203 grey tiles on one library.
  const showThumb = !!item.thumb_url;
  // PR 12 lane 3: who is in it and the shot, in the picker's own words — null with the flag off,
  // on a video, or when the server sent nothing (an older server): the tile exactly as before.
  const label = libraryTileLabel(item, STUDIO_LIBRARY_FIELDS);
  return (
    <Pressable style={[styles.tile, { width: size, height: size }]} onPress={onPress}>
      {showThumb ? (
        <Photo uri={item.thumb_url!} style={StyleSheet.absoluteFill} transition={0} />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.tilePh, styles.tilePhCenter]}>
          {isVideo ? <Feather name="video" size={22} color="#B8B0A6" /> : null}
        </View>
      )}
      <View style={styles.srcBadge}><Feather name={sourceIcon(item.origin)} size={10} color="#fff" /></View>
      {item.enriched && item.brand_safe === false ? (
        <View style={styles.caution}><Feather name="alert-triangle" size={9} color={Bold.onDark} /></View>
      ) : null}
      {isVideo && item.duration_seconds != null ? (
        <View style={styles.dur}><Feather name="play" size={8} color="#fff" /><Text style={styles.durTxt}>{fmtDur(item.duration_seconds)}</Text></View>
      ) : null}
      {!item.enriched ? (
        <View style={styles.processing}><Feather name="clock" size={13} color="#fff" /><Text style={styles.processingTxt}>Processing</Text></View>
      ) : null}
      {label ? (
        <View style={styles.label} testID={`media-tile-label-${item.asset_id}`}><Text style={styles.labelTxt} numberOfLines={1}>{label}</Text></View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  topRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: Spacing.lg },
  search: {
    flex: 1, flexDirection: "row", alignItems: "center", gap: 9, height: 44, borderRadius: 999, paddingHorizontal: 15,
    backgroundColor: Colors.light.backgroundDefault, borderWidth: 1, borderColor: Colors.light.borderLight,
  },
  searchInput: { flex: 1, fontFamily: Fonts.body, fontSize: 14, color: Colors.light.text, padding: 0 },
  uploadBtn: { width: 44, height: 44, borderRadius: 14, backgroundColor: Colors.light.primary, alignItems: "center", justifyContent: "center" },
  reviewBtn: {
    width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center",
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
  },
  ackWrap: { paddingHorizontal: Spacing.lg, paddingTop: 12 },
  summary: { fontFamily: Fonts.bodyMedium, fontSize: 12.5, color: Colors.light.textMuted, paddingHorizontal: Spacing.lg, paddingTop: 10 },
  tabs: { flexDirection: "row", gap: 8, paddingHorizontal: Spacing.lg, paddingTop: 12 },
  tab: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border },
  tabOn: { backgroundColor: Colors.light.text, borderColor: Colors.light.text },
  tabTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 12.5, fontWeight: "600", color: Colors.light.textSecondary },
  tabTxtOn: { color: Colors.light.backgroundRoot },
  /**
   * flexShrink:0 is the fix — ScrollView sets flexShrink:1 on itself, so without this the grid
   * squeezes the row. flexGrow:0 undoes ScrollView's flexGrow:1 so the row never stretches either.
   * Content height, always.
   */
  chipRow: { flexGrow: 0, flexShrink: 0 },
  chips: { gap: 7, paddingHorizontal: Spacing.lg, paddingTop: 10, paddingBottom: 2 },
  chip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 11, paddingVertical: 6, borderRadius: 999, backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border },
  chipOn: { backgroundColor: Colors.light.text, borderColor: Colors.light.text },
  chipTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 12, fontWeight: "600", color: Colors.light.textSecondary },
  chipTxtOn: { color: Colors.light.backgroundRoot },
  tile: { borderRadius: 10, overflow: "hidden", backgroundColor: Colors.light.backgroundSecondary },
  tilePh: { backgroundColor: Colors.light.backgroundSecondary },
  tilePhCenter: { alignItems: "center", justifyContent: "center" },
  srcBadge: { position: "absolute", top: 5, left: 5, width: 20, height: 20, borderRadius: 10, backgroundColor: "rgba(13,11,8,0.62)", alignItems: "center", justifyContent: "center" },
  caution: { position: "absolute", top: 5, right: 5, width: 18, height: 18, borderRadius: 9, backgroundColor: Bold.ink, alignItems: "center", justifyContent: "center" },
  dur: { position: "absolute", bottom: 5, right: 5, flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: "rgba(13,11,8,0.7)", borderRadius: 6, paddingHorizontal: 5, paddingVertical: 2 },
  durTxt: { fontFamily: Fonts.bodyBold, fontSize: 9.5, fontWeight: "700", color: "#fff" },
  processing: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(13,11,8,0.5)", alignItems: "center", justifyContent: "center", gap: 4 },
  processingTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 10, fontWeight: "600", color: "#fff" },
  label: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 6, paddingVertical: 3, backgroundColor: "rgba(13,11,8,0.62)" },
  labelTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 10, fontWeight: "600", color: "#fff" },
  empty: { alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 70, width: "100%" },
  emptyTxt: { fontFamily: Fonts.bodyMedium, fontSize: 14, color: Colors.light.textMuted },
  footer: { paddingVertical: 20, alignItems: "center" },
});
