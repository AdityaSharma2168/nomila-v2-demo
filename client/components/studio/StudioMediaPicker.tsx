/**
 * StudioMediaPicker — ONE picker for the Studio: the Board's photos, the Agent's photos, products and
 * videos, and the Video tab's clips and stills.
 *
 * ─── WHAT IT IS ─────────────────────────────────────────────────────────────────────────────────
 *
 * A compact strip — the newest page of her library, drawn with the MOUNT'S OWN tile (`renderTile`), so
 * each strip looks exactly as it did — ending in "View more", which opens the whole library:
 *
 *   search        her words, sent when she SUBMITS (return key), never per keystroke — one embed each
 *   chips         Uploaded · Made here · From your accounts — only those the mount offers
 *   paging        past the first page, on scroll, through the server's keyset cursor
 *   upload        in place, through the app's one upload path and its one-time rights check
 *
 * ─── ⚠️  IT DECIDES NOTHING ABOUT SELECTION ─────────────────────────────────────────────────────
 *
 * The parent owns what is picked, in what order and up to what cap. The picker draws `selectedIds`
 * and reports every tap with the WHOLE row (`onPick`), so the Board still appends a row, the Agent
 * still toggles up to its cap and the Video tab still appends a position — each with the fields it
 * always read. What a list may hold is the server's (server/studio/mediaList.ts); what a mount offers,
 * the strip's pinning and the upload rule are mediaPickerLogic's, tested there.
 *
 * `context` is typed and reserved, not read: it is where caster-eligibility reasons will come in.
 *
 * DESIGN.md: pills at least 120px; cards radius `lg`, never below `xs`; no blur; Feather icons.
 */
import React, { memo, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { ImagePickerAsset } from "expo-image-picker";
import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import {
  pickFromCameraRoll,
  RightsAckRequired,
  useUploadMedia,
} from "../../hooks/use-media-library";
import {
  fetchStudioMediaRows,
  STUDIO_MEDIA_KEY,
  useStudioMedia,
  useStudioMediaSearch,
  type StudioMediaParams,
} from "../../hooks/use-studio-media";
import {
  markFor,
  ORIGIN_CHIP,
  originsFor,
  stripRows,
  uploadOutcome,
  type PickerContext,
  type PickerKind,
  type PickerOrigin,
  type PickerRow,
  tileLabel,
} from "../../screens/studio/mediaPickerLogic";
import { RightsAckPanel } from "../media/RightsAckPanel";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";
import { STUDIO_LIBRARY_FIELDS } from "../../lib/flags";

/** What a mount's tile is handed: its mark (see `markFor`), the tap, and whether taps are off. */
export interface PickerTileProps {
  mark: string | null;
  onPress: () => void;
  disabled: boolean;
}

export interface StudioMediaPickerProps {
  kind: PickerKind;
  /** Photos narrowed to what a stitch can hold (the Video tab's stills). */
  forStill?: boolean;
  /** What this mount may list — MOUNT_ORIGINS[context]. Its chips are this set. */
  origins: readonly PickerOrigin[];
  /** The parent's selection, in pick order. Omitted by mounts where each tap adds (Board, Video). */
  selectedIds?: readonly string[];
  /** Mark picks with their order ("1", "2") rather than a plain check. */
  numbered?: boolean;
  /** A tap, with the whole row. The parent decides what it means. */
  onPick: (row: PickerRow) => void;
  /** The strip's tile — the mount's own, so the strip looks as it did. */
  renderTile: (row: PickerRow, tile: PickerTileProps) => React.ReactNode;
  disabled?: boolean;
  /** Upload in place, of this kind, from inside "View more". */
  upload?: "photo" | "video";
  /** Rows per page. The Video tab asks 60 so its strip holds what /stitch/* held. */
  pageSize?: number;
  /** RESERVED — typed, not read in v1. */
  context: PickerContext;
  /** What the picker is for, in her words — the modal's title and the tiles' label. */
  label: string;
  empty?: string;
}

const NO_CHIPS: PickerOrigin[] = [];

function StudioMediaPickerImpl({
  kind,
  forStill = false,
  origins,
  selectedIds,
  numbered = false,
  onPick,
  renderTile,
  disabled = false,
  upload,
  pageSize = 24,
  label,
  empty = "Nothing here yet.",
}: StudioMediaPickerProps) {
  const params: StudioMediaParams = useMemo(
    () => ({ kind, origins, still: forStill, pageSize }),
    [kind, origins, forStill, pageSize],
  );
  const list = useStudioMedia(params);
  const firstPage = list.data?.pages[0]?.items;

  // Every row the picker has loaded, by id — what lets the strip draw a pick made further down.
  const seen = useRef(new Map<string, PickerRow>());
  for (const p of list.data?.pages ?? [])
    for (const r of p.items) seen.current.set(r.assetId, r);

  // Recomputed each render — a map over one page — because `seen` is a ref, not state.
  const strip = stripRows(firstPage ?? [], selectedIds, seen.current);

  const [open, setOpen] = useState(false);

  return (
    <View>
      {list.isLoading ? (
        <View style={styles.stripEmpty}>
          <ActivityIndicator size="small" color={Colors.light.primary} />
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.strip}>
            {list.isError ? (
              <Text style={styles.quiet}>Couldn&apos;t load your library.</Text>
            ) : strip.length === 0 ? (
              <Text style={styles.quiet}>{empty}</Text>
            ) : null}
            {strip.map((r) => (
              // PR 12: the label is drawn HERE, under the mount's own tile — one place, every mount
              // (`tileLabel` decides the words; null draws nothing, so with the flag off this is the
              // strip as it was).
              <View key={r.assetId}>
                {renderTile(r, {
                  mark: markFor(r.assetId, selectedIds, numbered),
                  onPress: () => onPick(r),
                  disabled,
                })}
                <TileLabel row={r} />
              </View>
            ))}
            <Pressable
              testID="media-picker-view-more"
              style={styles.more}
              onPress={() => setOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={`View more — ${label}`}
            >
              <Feather name="grid" size={16} color={Colors.light.primary} />
              <Text style={styles.moreTxt}>View more</Text>
            </Pressable>
          </View>
        </ScrollView>
      )}
      {open ? (
        <LibraryModal
          params={params}
          selectedIds={selectedIds}
          numbered={numbered}
          onPick={onPick}
          disabled={disabled}
          upload={upload}
          label={label}
          seen={seen.current}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </View>
  );
}

/**
 * Memoised: the Video tab re-renders five times a second while a clip plays, and nothing here depends
 * on the playhead. The mounts pass stable callbacks for exactly this reason.
 */
export const StudioMediaPicker = memo(StudioMediaPickerImpl);

// ─── "View more" ─────────────────────────────────────────────────────────────────────────────────

function LibraryModal({
  params,
  selectedIds,
  numbered,
  onPick,
  disabled,
  upload,
  label,
  seen,
  onClose,
}: {
  params: StudioMediaParams;
  selectedIds?: readonly string[];
  numbered: boolean;
  onPick: (row: PickerRow) => void;
  disabled: boolean;
  upload?: "photo" | "video";
  label: string;
  seen: Map<string, PickerRow>;
  onClose: () => void;
}) {
  const [chips, setChips] = useState<PickerOrigin[]>(NO_CHIPS);
  const [draft, setDraft] = useState("");
  /** The words she SUBMITTED — the only thing a search is ever sent for. */
  const [words, setWords] = useState("");
  /** On a mount where each tap adds (no selection to draw), what she has added from here. */
  const [added, setAdded] = useState<Set<string>>(() => new Set());

  const shown: StudioMediaParams = useMemo(
    () => ({ ...params, origins: originsFor(chips, params.origins) }),
    [params, chips],
  );
  const browse = useStudioMedia(shown, words === "");
  const found = useStudioMediaSearch({ ...shown, q: words }, words !== "");

  const rows: PickerRow[] = useMemo(() => {
    if (words !== "")
      return found.data && "items" in found.data ? found.data.items : [];
    return (browse.data?.pages ?? []).flatMap((p) => p.items);
  }, [words, found.data, browse.data]);
  for (const r of rows) seen.set(r.assetId, r);

  const unavailable =
    words !== "" && found.data && "unavailable" in found.data
      ? found.data.unavailable
      : null;
  const loading = words !== "" ? found.isLoading : browse.isLoading;

  const tap = (r: PickerRow) => {
    if (disabled) return;
    onPick(r);
    if (!selectedIds) setAdded((s) => new Set(s).add(r.assetId));
  };

  // ── Upload in place: the app's one path, its one rights check, then the server decides ──────────
  const qc = useQueryClient();
  const uploader = useUploadMedia();
  const [ackFor, setAckFor] = useState<ImagePickerAsset | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const send = async (asset: ImagePickerAsset, ackRights?: boolean) => {
    setNote(null);
    try {
      const item = await uploader.mutateAsync({ asset, ackRights });
      // Every list she can see it in: this picker's, and the Video tab's own lookups.
      await qc.invalidateQueries({ queryKey: [...STUDIO_MEDIA_KEY] });
      await qc.invalidateQueries({ queryKey: ["studio", "stitch"] });
      // The server says whether THIS mount can use it — never the register answer alone, and never by whether it
      // made the first page: that page is ranked and a fresh upload ranks last (quality-scrappy, Investigation 12).
      const listed = await fetchStudioMediaRows(params, [item.asset_id]);
      const out = uploadOutcome(
        item.asset_id,
        listed,
        params.still,
        asset.mimeType,
      );
      if ("pick" in out) tap(out.pick);
      else setNote(out.refusal);
    } catch (e) {
      if (e instanceof RightsAckRequired) setAckFor(asset);
      else setNote("That upload didn't go through. Nothing was added.");
    }
  };

  const onUpload = async () => {
    try {
      const picked = await pickFromCameraRoll(upload ?? "photo");
      if (picked?.assets.length) await send(picked.assets[0]);
    } catch {
      // Permission refused or the OS picker failed: nothing chosen, nothing to undo.
    }
  };

  const toggleChip = (o: PickerOrigin) =>
    setChips((c) => (c.includes(o) ? c.filter((x) => x !== o) : [...c, o]));

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.sheet}>
        <View style={styles.head}>
          <Text style={styles.title} numberOfLines={1}>
            {label}
          </Text>
          <Pressable
            testID="media-picker-close"
            onPress={onClose}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Feather name="x" size={20} color={Colors.light.text} />
          </Pressable>
        </View>

        <View style={styles.searchRow}>
          <Feather name="search" size={14} color={Colors.light.textMuted} />
          <TextInput
            testID="media-picker-search"
            style={styles.search}
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={() => setWords(draft.trim())}
            returnKeyType="search"
            placeholder="Search your library — press return"
            placeholderTextColor={Colors.light.textMuted}
            accessibilityLabel="Search your library"
          />
          {words !== "" ? (
            <Pressable
              testID="media-picker-clear"
              onPress={() => {
                setDraft("");
                setWords("");
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Clear the search"
            >
              <Feather
                name="x-circle"
                size={14}
                color={Colors.light.textMuted}
              />
            </Pressable>
          ) : null}
        </View>

        {params.origins.length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.chipsRow}
          >
            <View style={styles.chips}>
              {params.origins.map((o) => {
                const on = chips.includes(o);
                return (
                  <Pressable
                    key={o}
                    testID={`media-picker-chip-${o}`}
                    style={[styles.pill, on && styles.pillOn]}
                    onPress={() => toggleChip(o)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={ORIGIN_CHIP[o]}
                  >
                    <Text style={[styles.pillTxt, on && styles.pillTxtOn]}>
                      {ORIGIN_CHIP[o]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        ) : null}

        {ackFor ? (
          <RightsAckPanel
            busy={uploader.isPending}
            onConfirm={() => {
              const asset = ackFor;
              setAckFor(null);
              void send(asset, true);
            }}
            onCancel={() => setAckFor(null)}
          />
        ) : null}
        {note ? <Text style={styles.note}>{note}</Text> : null}
        {unavailable ? <Text style={styles.note}>{unavailable}</Text> : null}

        <FlatList
          testID="media-picker-grid"
          data={rows}
          keyExtractor={(r) => r.assetId}
          numColumns={3}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={styles.gridRow}
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (
              words === "" &&
              browse.hasNextPage &&
              !browse.isFetchingNextPage
            )
              void browse.fetchNextPage();
          }}
          ListHeaderComponent={
            upload ? (
              <Pressable
                testID="media-picker-upload"
                style={styles.upload}
                onPress={onUpload}
                disabled={uploader.isPending}
                accessibilityRole="button"
                accessibilityState={{ busy: uploader.isPending }}
                accessibilityLabel={
                  upload === "video" ? "Upload a video" : "Upload a photo"
                }
              >
                {uploader.isPending ? (
                  <ActivityIndicator
                    size="small"
                    color={Colors.light.primary}
                  />
                ) : (
                  <Feather
                    name="upload"
                    size={15}
                    color={Colors.light.primary}
                  />
                )}
                <Text style={styles.uploadTxt}>
                  {upload === "video" ? "Upload a video" : "Upload a photo"}
                </Text>
              </Pressable>
            ) : null
          }
          ListEmptyComponent={
            loading ? (
              <ActivityIndicator size="small" color={Colors.light.primary} />
            ) : unavailable ? null : (
              <Text style={styles.quiet}>
                {words !== ""
                  ? "Nothing matches that yet."
                  : "Nothing here yet."}
              </Text>
            )
          }
          ListFooterComponent={
            words === "" && browse.isFetchingNextPage ? (
              <ActivityIndicator size="small" color={Colors.light.primary} />
            ) : words !== "" && rows.length > 0 ? (
              <Text style={styles.quiet}>
                The closest matches. Clear the search to see everything.
              </Text>
            ) : null
          }
          renderItem={({ item }) => {
            const mark = markFor(item.assetId, selectedIds, numbered);
            const on = mark !== null || added.has(item.assetId);
            return (
              <Pressable
                testID={`media-picker-tile-${item.assetId}`}
                style={[
                  styles.cell,
                  on && styles.cellOn,
                  disabled && styles.off,
                ]}
                onPress={() => tap(item)}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityState={{ selected: on, disabled }}
                accessibilityLabel={label}
              >
                <CellImage row={item} />
                <TileLabel row={item} />
                {mark ? (
                  <View style={styles.mark}>
                    <Text style={styles.markTxt}>{mark}</Text>
                  </View>
                ) : on ? (
                  <View style={styles.mark}>
                    <Feather
                      name="check"
                      size={11}
                      color={Colors.light.buttonText}
                    />
                  </View>
                ) : null}
              </Pressable>
            );
          }}
        />

        <Pressable
          testID="media-picker-done"
          style={styles.done}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Done"
        >
          <Text style={styles.doneTxt}>Done</Text>
        </Pressable>
      </SafeAreaView>
    </Modal>
  );
}

/** A grid cell's picture: the photo's thumbnail, or a clip's poster — a plain mark before one exists. */
/** PR 12: what the tagger knows, in a line under the picture. Nothing when there is nothing to say. */
function TileLabel({ row }: { row: PickerRow }) {
  const text = tileLabel(row, STUDIO_LIBRARY_FIELDS);
  if (!text) return null;
  return (
    <Text
      style={[styles.tileLabel, row.tagged === false && styles.tileLabelQuiet]}
      numberOfLines={1}
      testID={`media-picker-label-${row.assetId}`}
    >
      {text}
    </Text>
  );
}

function CellImage({ row }: { row: PickerRow }) {
  const uri = row.kind === "photo" ? row.thumbUrl : row.posterUrl;
  if (uri) return <Image source={{ uri }} style={styles.cellImg} />;
  return (
    <View style={[styles.cellImg, styles.blank]}>
      <Feather name="film" size={16} color={Colors.light.textMuted} />
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { flexDirection: "row", gap: Spacing.xs, alignItems: "center" },
  stripEmpty: { paddingVertical: Spacing.lg, alignItems: "center" },
  quiet: {
    fontFamily: Fonts.body,
    fontSize: 12.5,
    color: Colors.light.textMuted,
    paddingVertical: Spacing.sm,
    paddingRight: Spacing.sm,
  },
  more: {
    width: 64,
    height: 76,
    borderRadius: BorderRadius.xs,
    borderWidth: 1,
    borderColor: Colors.light.border,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  moreTxt: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 10.5,
    fontWeight: "600",
    color: Colors.light.primary,
  },

  sheet: { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  title: {
    flex: 1,
    fontFamily: Fonts.heading,
    fontSize: 17,
    fontWeight: "700",
    color: Colors.light.text,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    marginHorizontal: Spacing.lg,
    paddingHorizontal: Spacing.md,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.light.border,
    backgroundColor: Colors.light.backgroundDefault,
  },
  search: {
    flex: 1,
    paddingVertical: 10,
    fontFamily: Fonts.body,
    fontSize: 14,
    color: Colors.light.text,
  },
  chipsRow: { flexGrow: 0, marginTop: Spacing.sm },
  chips: {
    flexDirection: "row",
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
  },
  pill: {
    minWidth: 120,
    alignItems: "center",
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  pillOn: {
    borderColor: Colors.light.primary,
    backgroundColor: Colors.light.primaryLight,
  },
  pillTxt: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 12.5,
    color: Colors.light.textSecondary,
  },
  pillTxtOn: { color: Colors.light.primary },
  note: {
    fontFamily: Fonts.body,
    fontSize: 12.5,
    lineHeight: 18,
    color: Colors.light.text,
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.sm,
  },
  grid: { padding: Spacing.lg, gap: Spacing.xs },
  gridRow: { gap: Spacing.xs },
  cell: {
    flex: 1 / 3,
    borderRadius: BorderRadius.xs,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "transparent",
  },
  cellOn: { borderColor: Colors.light.primary },
  off: { opacity: 0.5 },
  cellImg: { width: "100%", aspectRatio: 3 / 4 },
  tileLabel: {
    fontFamily: Fonts.body,
    fontSize: 10.5,
    color: Colors.light.text,
    paddingHorizontal: 4,
    paddingVertical: 2,
    maxWidth: 96,
  },
  tileLabelQuiet: { color: Colors.light.textMuted },
  blank: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.light.backgroundSecondary,
  },
  mark: {
    position: "absolute",
    top: 4,
    right: 4,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 999,
    backgroundColor: Colors.light.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  markTxt: {
    fontFamily: Fonts.bodyBold,
    fontSize: 10.5,
    fontWeight: "700",
    color: Colors.light.buttonText,
  },
  upload: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.sm,
    minWidth: 120,
    alignSelf: "flex-start",
    paddingHorizontal: Spacing.lg,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.light.primary,
    marginBottom: Spacing.sm,
  },
  uploadTxt: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 13,
    fontWeight: "600",
    color: Colors.light.primary,
  },
  done: {
    minWidth: 120,
    alignSelf: "center",
    alignItems: "center",
    paddingHorizontal: Spacing["2xl"],
    paddingVertical: 12,
    marginBottom: Spacing.lg,
    borderRadius: 999,
    backgroundColor: Colors.light.primary,
  },
  doneTxt: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 14,
    fontWeight: "600",
    color: Colors.light.buttonText,
  },
});
