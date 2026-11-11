/**
 * MediaPicker — the card editor's photo/video source picker (Fable's spec). Two stacked areas inside
 * the editor sheet: "In this card" (the cleared, curated pool) above "Your library" (everything
 * synced + uploaded, photos AND videos, with a leading "+" camera-roll upload tile). Bounded by
 * construction — each area is a fixed-height horizontal rail; "See all" grows the library to a
 * 2-row band up to a hard cap. Picking any item (or finishing an upload) applies it to the card.
 */
import React, { useMemo, useState } from "react";
import { View, Text, Pressable, ScrollView, Image, ActivityIndicator, StyleSheet, Modal, SafeAreaView } from "react-native";
import { Feather } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import {
  useMyMedia, useUploadMediaBatch, pickFromCameraRoll, RightsAckRequired,
  type MediaItem, type MediaTypeFilter,
} from "../../hooks/use-media-library";
import { MediaLibraryView } from "../media/MediaLibraryView";
import { RightsAckPanel } from "../media/RightsAckPanel";
import type { CardImagePoolItem } from "../../hooks/use-card-editor";
import { Fonts, Colors, Brand } from "../../constants/theme";

const MUTED = "#9C968D";
const CAP = 48;                 // hard cap on library items shown inside the sheet
const COLLAPSED = 12;
const VIDEO_TYPES = ["VIDEO", "REELS"];
const isVideoItem = (m: MediaItem) => VIDEO_TYPES.includes(m.media_type);
const fmtDur = (s: number | null) => (s == null ? null : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

interface Props {
  accept: "photo" | "video";
  clearedPool: CardImagePoolItem[];      // photos (imagePool); empty for the video card
  selectedPath?: string;                 // staged override path → the checked tile
  currentGcsPath?: string;               // the card's current media → the "On card" tile
  onPick: (override: string | { path: string; poster?: string }, previewUrl: string, posterUrl?: string) => void;
}

export function MediaPicker({ accept, clearedPool, selectedPath, currentGcsPath, onPick }: Props) {
  const compat: MediaTypeFilter = accept === "video" ? "videos" : "photos";
  const [filter, setFilter] = useState<MediaTypeFilter | "all">(compat);
  const [expanded, setExpanded] = useState(false);
  const [ackAssets, setAckAssets] = useState<ImagePicker.ImagePickerAsset[] | null>(null);
  const [busy, setBusy] = useState(false);
  // "Uploading 3 of 12…" while a multi-select batch runs, then a final tally (failures included).
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [batchNote, setBatchNote] = useState<string | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);   // full searchable library (pick-mode)
  // Soft, non-blocking brand-safety note when a picked photo was flagged not-brand-ready. The photo
  // is still usable here (brand safety never removes a shot from the library) — brand decks handle
  // rival logos on their own, by excluding them from that deck's featured slots automatically.
  const [warn, setWarn] = useState<string | null>(null);

  const lib = useMyMedia(filter === "all" ? undefined : filter);
  const upload = useUploadMediaBatch();
  const items = useMemo(() => lib.data?.pages.flatMap((p) => p.items) ?? [], [lib.data]);
  const summary = lib.data?.pages[0]?.summary;

  const compatible = (m: MediaItem) => (accept === "video" ? isVideoItem(m) : !isVideoItem(m));

  function pickItem(m: MediaItem) {
    setWarn(m.enriched && m.brand_safe === false ? "Another brand may be visible here — it's still usable; brand decks handle logos automatically." : null);
    if (isVideoItem(m)) onPick({ path: m.gcs_path, poster: m.poster_gcs_path ?? undefined }, m.thumb_url ?? m.video_url ?? "", m.thumb_url ?? undefined);
    else onPick(m.gcs_path, m.url ?? "");
  }
  function pickCleared(p: CardImagePoolItem) { setWarn(null); onPick(p.gcsPath, p.url); }

  async function beginUpload() {
    const picked = await pickFromCameraRoll(accept, { multiple: true });
    if (!picked) return;
    setBatchNote(
      picked.truncated ? `Uploading the first ${picked.truncated.kept} of ${picked.truncated.picked} selected` : null
    );
    await runUpload(picked.assets, false);
  }
  async function runUpload(assets: ImagePicker.ImagePickerAsset[], ack: boolean) {
    setBusy(true);
    setProgress({ current: 0, total: assets.length });
    try {
      const result = await upload.mutateAsync({
        assets, ackRights: ack,
        onProgress: (p) => setProgress({ current: p.current, total: p.total }),
      });
      setAckAssets(null);
      if (result.succeeded.length) pickItem(result.succeeded[result.succeeded.length - 1]);   // last upload lands on the card
      if (assets.length > 1) {
        setBatchNote(`Added ${result.succeeded.length} of ${assets.length}${result.failed.length ? ` — ${result.failed.length} failed` : ""}`);
      }
    } catch (e) {
      if (e instanceof RightsAckRequired) setAckAssets(assets);   // show the one-time ack panel
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const shown = (expanded ? items.slice(0, CAP) : items.slice(0, COLLAPSED));
  const canExpand = items.length > COLLAPSED || (lib.hasNextPage ?? false);

  const tileNodes: React.ReactNode[] = [
    <UploadTile key="__up" busy={busy} onPress={beginUpload} label={accept === "video" ? "Add clip" : "Add photo"} />,
    ...shown.map((m) => {
      const dim = !compatible(m);
      const vid = isVideoItem(m);
      const sel = !!selectedPath && selectedPath === m.gcs_path;
      // don't try to load an mp4 as an image — posterless uploaded videos get a neutral placeholder tile
      const uri = vid ? (m.poster_gcs_path ? (m.thumb_url ?? "") : "") : (m.thumb_url ?? m.url ?? "");
      return (
        <Tile
          key={m.asset_id}
          uri={uri}
          isVideo={vid}
          duration={fmtDur(m.duration_seconds)}
          source={m.origin === "upload" ? "upload" : "instagram"}
          processing={!m.enriched}
          warn={m.enriched && m.brand_safe === false}
          selected={sel}
          onCard={!sel && !!currentGcsPath && currentGcsPath === m.gcs_path}
          dim={dim}
          onPress={dim ? undefined : () => pickItem(m)}
        />
      );
    }),
  ];
  if (expanded && lib.hasNextPage && items.length < CAP) {
    tileNodes.push(<MoreTile key="__more" label="Load more" onPress={() => lib.fetchNextPage()} loading={lib.isFetchingNextPage} />);
  } else if (!expanded && canExpand) {
    tileNodes.push(<MoreTile key="__see" label="Search all" onPress={() => setBrowseOpen(true)} />);
  }

  return (
    <View style={styles.wrap}>
      {/* Area 1 — cleared (photo cards only; the video card has no curated pool) */}
      {accept === "photo" && (
        <View style={styles.area}>
          <View style={styles.areaHead}>
            <Text style={styles.areaLabel}>In this card · {clearedPool.length}</Text>
            <View style={styles.clearedTag}><Feather name="shield" size={10} color={MUTED} /><Text style={styles.clearedTagTx}>Cleared</Text></View>
          </View>
          {clearedPool.length === 0 ? (
            <Text style={styles.emptyNote}>No cleared shots for this card yet — pick from your library below.</Text>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
              {clearedPool.map((p) => {
                const sel = !!selectedPath && selectedPath === p.gcsPath;
                return (
                  <Tile key={p.gcsPath} uri={p.url} selected={sel} onCard={!sel && !!currentGcsPath && currentGcsPath === p.gcsPath} onPress={() => pickCleared(p)} />
                );
              })}
            </ScrollView>
          )}
        </View>
      )}

      {/* Area 2 — your library */}
      <View style={styles.area}>
        <View style={styles.areaHead}>
          <Text style={styles.areaLabel}>Your library{summary ? ` · ${summary.total}` : ""}</Text>
          <Pressable onPress={() => setBrowseOpen(true)} hitSlop={6}>
            <Text style={styles.seeAll}>Search &amp; browse all →</Text>
          </Pressable>
        </View>

        {progress ? (
          <Text style={styles.emptyNote}>Uploading {progress.current} of {progress.total}…</Text>
        ) : batchNote ? (
          <Text style={styles.emptyNote}>{batchNote}</Text>
        ) : null}

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          <Chip label={`All${summary ? ` ${summary.total}` : ""}`} on={filter === "all"} onPress={() => setFilter("all")} />
          <Chip label={`Photos${summary ? ` ${summary.by_type.photos}` : ""}`} on={filter === "photos"} onPress={() => setFilter("photos")} />
          <Chip label={`Videos${summary ? ` ${summary.by_type.videos}` : ""}`} on={filter === "videos"} onPress={() => setFilter("videos")} />
        </ScrollView>

        {lib.isLoading ? (
          <View style={styles.loading}><ActivityIndicator color={Colors.light.primary} /></View>
        ) : items.length === 0 ? (
          <View style={styles.emptyRow}>
            <UploadTile busy={busy} onPress={beginUpload} label={accept === "video" ? "Add clip" : "Add photo"} />
            <Text style={styles.emptyNote}>Nothing here yet — add one from your camera roll.</Text>
          </View>
        ) : expanded ? (
          <TwoRowBand tiles={tileNodes} />
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>{tileNodes}</ScrollView>
        )}
      </View>

      {/* Soft brand-safety note — non-blocking, informational */}
      {warn && (
        <View style={styles.warnNote}>
          <Feather name="alert-triangle" size={13} color="#B77900" />
          <Text style={styles.warnTx}>{warn}</Text>
        </View>
      )}

      {/* One-time rights acknowledgment (inline, not an OS alert) — shared with the Studio library
          so both upload surfaces attest to identical wording. */}
      {ackAssets && (
        <RightsAckPanel
          busy={busy}
          onConfirm={() => runUpload(ackAssets, true)}
          onCancel={() => setAckAssets(null)}
        />
      )}

      {/* Full searchable library — pick-mode: tapping applies to the card (same as the rails). */}
      <Modal visible={browseOpen} animationType="slide" onRequestClose={() => setBrowseOpen(false)} presentationStyle="pageSheet">
        <SafeAreaView style={styles.browseSafe}>
          <View style={styles.browseHead}>
            <Text style={styles.browseTitle}>Your library</Text>
            <Pressable onPress={() => setBrowseOpen(false)} hitSlop={8}><Feather name="x" size={22} color={Colors.light.text} /></Pressable>
          </View>
          <MediaLibraryView accept={accept} onPick={(m) => { pickItem(m); setBrowseOpen(false); }} />
        </SafeAreaView>
      </Modal>
    </View>
  );
}

// ── 2-row horizontal band: chunk tiles into columns of 2 ──
function TwoRowBand({ tiles }: { tiles: React.ReactNode[] }) {
  const cols: React.ReactNode[][] = [];
  for (let i = 0; i < tiles.length; i += 2) cols.push(tiles.slice(i, i + 2));
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
      {cols.map((c, i) => <View key={i} style={styles.bandCol}>{c}</View>)}
    </ScrollView>
  );
}

function Tile({ uri, isVideo, duration, source, processing, warn, selected, onCard, dim, onPress }: {
  uri: string; isVideo?: boolean; duration?: string | null; source?: "upload" | "instagram";
  processing?: boolean; warn?: boolean; selected?: boolean; onCard?: boolean; dim?: boolean; onPress?: () => void;
}) {
  return (
    <Pressable disabled={!onPress} onPress={onPress} style={[styles.tile, selected && styles.tileSel, dim && styles.tileDim]}>
      {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
      {source && (
        <View style={[styles.srcBadge, source === "upload" ? styles.srcUpload : styles.srcIg]}>
          <Feather name={source === "upload" ? "arrow-up" : "instagram"} size={9} color="#FFFFFF" />
        </View>
      )}
      {warn && !selected && (
        <View style={styles.warnBadge}><Feather name="alert-triangle" size={9} color="#FFFFFF" /></View>
      )}
      {isVideo && <View style={styles.playDisc}><Feather name="play" size={11} color="#FFFFFF" /></View>}
      {isVideo && duration && <View style={styles.durPill}><Text style={styles.durTx}>{duration}</Text></View>}
      {processing && (
        <View style={styles.procBar}><ActivityIndicator size="small" color="#FFFFFF" /><Text style={styles.procTx}>Processing…</Text></View>
      )}
      {onCard && !processing && <View style={styles.onCardBar}><Text style={styles.onCardTx}>ON CARD</Text></View>}
      {selected && <View style={styles.check}><Feather name="check" size={12} color="#FFFFFF" /></View>}
    </Pressable>
  );
}

function UploadTile({ busy, onPress, label = "Add" }: { busy?: boolean; onPress: () => void; label?: string }) {
  return (
    <Pressable style={styles.uploadTile} onPress={onPress} disabled={busy}>
      {busy ? <ActivityIndicator color={Colors.light.primary} /> : (
        <><Feather name="plus" size={20} color={Colors.light.primary} /><Text style={styles.uploadTx}>{label}</Text></>
      )}
    </Pressable>
  );
}

function MoreTile({ label, onPress, loading }: { label: string; onPress: () => void; loading?: boolean }) {
  return (
    <Pressable style={styles.moreTile} onPress={onPress} disabled={loading}>
      {loading ? <ActivityIndicator color={MUTED} /> : (
        <><Feather name="chevron-right" size={18} color={MUTED} /><Text style={styles.moreTx}>{label}</Text></>
      )}
    </Pressable>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.chip, on && styles.chipOn]} onPress={onPress}>
      <Text style={[styles.chipTx, on && styles.chipTxOn]}>{label}</Text>
    </Pressable>
  );
}

const TILE_W = 80, TILE_H = 104;
const styles = StyleSheet.create({
  wrap: { gap: 14 },
  browseSafe: { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  browseHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 12 },
  browseTitle: { fontFamily: Fonts.heading, fontSize: 18, fontWeight: "700", color: Colors.light.text },
  area: { gap: 9 },
  areaHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  areaLabel: { fontFamily: Fonts.bodySemiBold, fontSize: 10.5, letterSpacing: 0.6, textTransform: "uppercase", color: MUTED },
  clearedTag: { flexDirection: "row", alignItems: "center", gap: 4 },
  clearedTagTx: { fontFamily: Fonts.bodySemiBold, fontSize: 10.5, color: MUTED },
  seeAll: { fontFamily: Fonts.bodySemiBold, fontSize: 12, color: Colors.light.primary },

  rail: { gap: 8, paddingRight: 4 },
  bandCol: { gap: 8 },
  loading: { height: TILE_H, alignItems: "center", justifyContent: "center" },
  emptyRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  emptyNote: { flex: 1, fontFamily: Fonts.body, fontSize: 12.5, color: MUTED, lineHeight: 17 },

  chipRow: { gap: 7, paddingRight: 4, paddingBottom: 2 },
  chip: { borderWidth: 1, borderColor: Colors.light.border, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: "#FFFFFF" },
  chipOn: { backgroundColor: Colors.light.text, borderColor: Colors.light.text },
  chipTx: { fontFamily: Fonts.bodySemiBold, fontSize: 11.5, color: Colors.light.textSecondary },
  chipTxOn: { color: "#FFFFFF" },

  tile: { width: TILE_W, height: TILE_H, borderRadius: 12, overflow: "hidden", borderWidth: 2, borderColor: "transparent", backgroundColor: Brand.heroBg },
  tileSel: { borderColor: Colors.light.primary },
  tileDim: { opacity: 0.4 },
  srcBadge: { position: "absolute", top: 5, left: 5, width: 16, height: 16, borderRadius: 8, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#FFFFFF" },
  srcUpload: { backgroundColor: "#2A2622" },
  srcIg: { backgroundColor: "#E1306C" },
  playDisc: { position: "absolute", top: "50%", left: "50%", marginTop: -13, marginLeft: -13, width: 26, height: 26, borderRadius: 13, backgroundColor: "rgba(13,11,8,0.45)", alignItems: "center", justifyContent: "center" },
  durPill: { position: "absolute", bottom: 5, right: 5, backgroundColor: "rgba(13,11,8,0.6)", borderRadius: 6, paddingHorizontal: 5, paddingVertical: 2 },
  durTx: { fontFamily: Fonts.bodySemiBold, fontSize: 9, color: "#FFFFFF" },
  procBar: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, paddingVertical: 4, backgroundColor: "rgba(13,11,8,0.55)" },
  procTx: { fontFamily: Fonts.bodySemiBold, fontSize: 9, color: "#FFFFFF" },
  onCardBar: { position: "absolute", left: 0, right: 0, bottom: 0, alignItems: "center", paddingVertical: 3, backgroundColor: "rgba(13,11,8,0.55)" },
  onCardTx: { fontFamily: Fonts.bodyBold, fontSize: 8.5, letterSpacing: 0.6, color: "#FFFFFF" },
  check: { position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: 11, backgroundColor: Colors.light.primary, alignItems: "center", justifyContent: "center" },

  uploadTile: { width: TILE_W, height: TILE_H, borderRadius: 12, borderWidth: 1.5, borderStyle: "dashed", borderColor: Colors.light.border, backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center", gap: 4 },
  uploadTx: { fontFamily: Fonts.bodySemiBold, fontSize: 10.5, color: Colors.light.textSecondary },
  moreTile: { width: TILE_W, height: TILE_H, borderRadius: 12, backgroundColor: Colors.light.backgroundDefault, alignItems: "center", justifyContent: "center", gap: 3 },
  moreTx: { fontFamily: Fonts.bodySemiBold, fontSize: 10.5, color: MUTED },

  warnBadge: { position: "absolute", top: 6, right: 6, width: 18, height: 18, borderRadius: 9, backgroundColor: "#B77900", alignItems: "center", justifyContent: "center" },
  warnNote: { flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: "#FBF3E2", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9 },
  warnTx: { flex: 1, fontFamily: Fonts.body, fontSize: 12, color: "#7A5200", lineHeight: 16 },
});
