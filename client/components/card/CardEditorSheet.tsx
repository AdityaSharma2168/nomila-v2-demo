/**
 * CardEditorSheet — ALL of one card's edits in a single sheet (Fable's consolidation). Tap a card
 * in the spread → this rises with the REAL card rendered large and live at the top, and its
 * editable bits as controls below: tap a line → Mila's takes slide up as inline chips (or "write
 * your own"); tap the photo control → your cleared shots slide up as an inline strip. As you pick,
 * the real card above updates instantly. No options list, no full-screen copy picker, no
 * full-screen photo swap — those three collapse here. Edits stage live; the deck's Publish commits.
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  Modal, View, Text, Pressable, ScrollView, TextInput, StyleSheet,
  Platform, UIManager, LayoutAnimation,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { CardView } from "../card-native/looks";
import { MediaPicker } from "./MediaPicker";
import { T } from "../card-native/Chrome";
import type { Card } from "../card-native/types";
import type { CardEditorCard, CardImagePoolItem } from "../../hooks/use-card-editor";
import { Fonts, Colors, Brand, Spacing } from "../../constants/theme";

type MediaOverride = string | { path: string; poster?: string };

const MUTED = "#9C968D";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
// Animate the next layout pass (used when the picker opens/closes so the preview shrink eases).
const animateNext = () => LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);

function labelForField(field: string): string {
  const spaced = field.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

type StagedCopy = { text: string; pick?: number };

interface Props {
  card:          CardEditorCard;
  /** The athlete's chosen look — the preview renders in it so it matches the real card. */
  theme?:        string;
  /** The real, typed card data — rendered live as the preview (edits applied on top). */
  rich?:         Card;
  imagePool:     CardImagePoolItem[];
  /** Current staged/published copy for THIS card, keyed by field (pick omitted ⇒ custom text). */
  copyByField:   Record<string, StagedCopy>;
  imageOverride: MediaOverride | undefined;   // staged media swap: gcsPath (photo) | {path,poster} (video)
  isCover:       boolean;
  hasEdits:      boolean;
  onSetCopy:     (field: string, val: StagedCopy | null) => void;   // null clears back to Mila's
  onSetImage:    (val: MediaOverride) => void;
  onReset:       () => void;
  onHide:        () => void;
  onClose:       () => void;
  /** Step to the previous/next card in the deck without leaving the sheet — undefined at the ends. */
  onPrev?:       () => void;
  onNext?:       () => void;
  /** Deck position for the "3 of 9" readout (index is 0-based). */
  position?:     { index: number; total: number };
}

type Active = { kind: "copy"; field: string } | { kind: "photo" } | null;

export function CardEditorSheet({
  card, theme, rich, imagePool, copyByField, imageOverride, isCover, hasEdits,
  onSetCopy, onSetImage, onReset, onHide, onClose, onPrev, onNext, position,
}: Props) {
  const [active, setActive]           = useState<Active>(null);
  const [writingCustom, setWriting]   = useState(false);
  const [custom, setCustom]           = useState("");
  // Signed preview URL for a media pick made THIS session (library/upload items aren't in imagePool).
  const [livePreview, setLivePreview] = useState<{ url: string; poster?: string } | null>(null);

  // Stepping to another card keeps the sheet mounted (no close/reopen), so reset the per-card UI
  // state — which line/photo strip is open, any half-written custom text — when the card changes.
  useEffect(() => {
    setActive(null);
    setWriting(false);
    setCustom("");
    setLivePreview(null);
  }, [card.id]);

  // A card is media-swappable if it actually shows one — cover/fit carry an `image`, most cards a
  // background `bg`, the video card a `videoUrl`. Read the real (rich) card since the editor payload
  // only exposes cover/fit images.
  const accept: "photo" | "video" = rich?.type === "video" ? "video" : "photo";
  const isMediaLed = rich
    ? "image" in rich || "bg" in rich || "videoUrl" in rich
    : card.image !== null;
  const selectedPath = typeof imageOverride === "string" ? imageOverride : imageOverride?.path;

  // The live preview card = real data with this card's staged copy + media applied on top.
  const previewCard = useMemo<Card | undefined>(() => {
    if (!rich) return undefined;
    const edited: any = { ...rich };
    Object.entries(copyByField).forEach(([field, v]) => { edited[field] = v.text; });
    // resolve a preview url: this-session pick, else a cleared-pool override (in imagePool); a
    // persisted library override needs none — `rich` (the served kit) already reflects it.
    const url = livePreview?.url ?? (typeof imageOverride === "string" ? imagePool.find((p) => p.gcsPath === imageOverride)?.url : undefined);
    if (url) {
      if (edited.type === "video") edited.posterUrl = livePreview?.poster ?? url;
      else if ("image" in edited) edited.image = url;
      else if ("bg" in edited) edited.bg = url;
    }
    return edited as Card;
  }, [rich, copyByField, imageOverride, imagePool, livePreview]);

  function handlePick(override: MediaOverride, previewUrl: string, posterUrl?: string) {
    setLivePreview({ url: previewUrl, poster: posterUrl });
    onSetImage(override);
  }

  function enterField(field: string) {
    animateNext();
    const staged = copyByField[field];
    const f = card.editable.find((x) => x.field === field);
    const noAlternates = !f || f.alternates.length === 0;
    const isCustom = (!!staged && staged.pick === undefined) || noAlternates;   // free-text ⇒ open the writer
    setActive({ kind: "copy", field });
    setWriting(isCustom);
    setCustom(isCustom ? (staged?.text ?? "") : "");
  }

  const activeField = active?.kind === "copy" ? card.editable.find((f) => f.field === active.field) : undefined;

  return (
    <Modal transparent statusBarTranslucent animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.container}>
        <Pressable style={styles.backdrop} onPress={onClose} />

        <View style={styles.sheet}>
          <View style={styles.handle} />

          <View style={styles.header}>
            <View style={styles.headerTx}>
              <Text style={styles.eyebrow}>
                {position ? `Editing · ${position.index + 1} of ${position.total}` : "Editing"}
              </Text>
              <Text style={styles.title} numberOfLines={1}>{card.title}</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={8} style={styles.closeBtn}>
              <Feather name="x" size={18} color={MUTED} />
            </Pressable>
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.body}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* ── The real card, live — flanked by prev/next arrows to step through the deck ── */}
            {previewCard && (
              <View style={styles.previewWrap}>
                <View style={[styles.previewCard, active?.kind === "photo" && styles.previewCardShrink]} pointerEvents="none">
                  <CardView card={previewCard} active theme={theme} />
                </View>
                {position && position.total > 1 && (
                  <>
                    <Pressable
                      onPress={onPrev}
                      disabled={!onPrev}
                      hitSlop={10}
                      style={[styles.navEdge, styles.navEdgeL, !onPrev && styles.navBtnOff]}
                      accessibilityLabel="Edit previous card"
                    >
                      <Feather name="chevron-left" size={22} color={onPrev ? Colors.light.text : "#C9C3BC"} />
                    </Pressable>
                    <Pressable
                      onPress={onNext}
                      disabled={!onNext}
                      hitSlop={10}
                      style={[styles.navEdge, styles.navEdgeR, !onNext && styles.navBtnOff]}
                      accessibilityLabel="Edit next card"
                    >
                      <Feather name="chevron-right" size={22} color={onNext ? Colors.light.text : "#C9C3BC"} />
                    </Pressable>
                  </>
                )}
              </View>
            )}

            <Text style={styles.hint}>Pick a line or swap the photo — your card updates as you go.</Text>

            {/* ── Controls ── */}
            <View style={styles.controls}>
              {isMediaLed && (
                <Pressable
                  style={[styles.ctrl, active?.kind === "photo" && styles.ctrlOn]}
                  onPress={() => { animateNext(); setActive(active?.kind === "photo" ? null : { kind: "photo" }); }}
                >
                  <View style={styles.ctrlIcon}><Feather name={accept === "video" ? "video" : "camera"} size={15} color={Colors.light.text} /></View>
                  <View style={styles.ctrlTx}>
                    <Text style={styles.ctrlTitle}>{accept === "video" ? "Video" : "Photo"}</Text>
                    <Text style={styles.ctrlSub} numberOfLines={1}>
                      {imageOverride ? "Swapped — tap to change" : accept === "video" ? "Swap the clip — library or camera roll" : "Swap it — cleared shots, library or camera roll"}
                    </Text>
                  </View>
                  <Feather name="chevron-right" size={16} color={MUTED} />
                </Pressable>
              )}

              {card.editable.map((f) => {
                const val = copyByField[f.field]?.text ?? f.value;
                const isActive = active?.kind === "copy" && active.field === f.field;
                const edited = !!copyByField[f.field];
                return (
                  <Pressable key={f.field} style={[styles.ctrl, isActive && styles.ctrlOn]} onPress={() => enterField(f.field)}>
                    <View style={styles.ctrlIcon}><Feather name="edit-2" size={15} color={Colors.light.text} /></View>
                    <View style={styles.ctrlTx}>
                      <View style={styles.ctrlTitleRow}>
                        <Text style={styles.ctrlTitle}>{labelForField(f.field)}</Text>
                        {edited && <View style={styles.editedDot} />}
                      </View>
                      <Text style={styles.ctrlSub} numberOfLines={1}>{val ? `"${val}"` : "Tap to write one"}</Text>
                    </View>
                    <Feather name="chevron-right" size={16} color={MUTED} />
                  </Pressable>
                );
              })}
            </View>

            {/* ── Context strip: Mila's takes (copy) ── */}
            {active?.kind === "copy" && activeField && (
              <View style={styles.strip}>
                <Text style={styles.stripLabel}>{activeField.alternates.length ? "Mila's takes" : "Your line"}</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow} keyboardShouldPersistTaps="handled">
                  {activeField.alternates.map((alt, i) => {
                    const sel = !writingCustom && copyByField[active.field]?.pick === i;
                    return (
                      <Pressable
                        key={i}
                        style={[styles.chip, sel && styles.chipSel]}
                        onPress={() => { setWriting(false); onSetCopy(active.field, { text: alt, pick: i }); }}
                      >
                        <Text style={[styles.chipText, sel && styles.chipTextSel]} numberOfLines={3}>{alt}</Text>
                      </Pressable>
                    );
                  })}
                  <Pressable
                    style={[styles.customChip, writingCustom && styles.customChipOn]}
                    onPress={() => { setWriting(true); setCustom(copyByField[active.field]?.pick === undefined ? (copyByField[active.field]?.text ?? "") : ""); }}
                  >
                    <Feather name="edit-2" size={12} color={writingCustom ? "#FFFFFF" : Colors.light.primary} />
                    <Text style={[styles.customChipText, writingCustom && styles.chipTextSel]}>Write your own</Text>
                  </Pressable>
                </ScrollView>

                {writingCustom && (
                  <TextInput
                    style={styles.customInput}
                    value={custom}
                    onChangeText={(t) => { setCustom(t); onSetCopy(active.field, { text: t }); }}
                    placeholder="Say it your way…"
                    placeholderTextColor="#C5BFB8"
                    multiline
                    autoFocus
                  />
                )}

                {!!copyByField[active.field] && (
                  <Pressable style={styles.revert} onPress={() => { onSetCopy(active.field, null); setWriting(false); }} hitSlop={6}>
                    <Feather name="rotate-ccw" size={12} color={MUTED} />
                    <Text style={styles.revertText}>Back to Mila's original</Text>
                  </Pressable>
                )}
              </View>
            )}

            {/* ── The media picker: cleared pool + your library + camera-roll upload ── */}
            {active?.kind === "photo" && (
              <View style={styles.strip}>
                <MediaPicker accept={accept} clearedPool={imagePool} selectedPath={selectedPath} currentGcsPath={card.mediaGcsPath ?? undefined} onPick={handlePick} />
              </View>
            )}

            {/* ── Footer ── */}
            <View style={styles.footer}>
              {hasEdits && (
                <Pressable style={styles.footBtn} onPress={onReset}>
                  <Feather name="rotate-ccw" size={14} color={Colors.light.textSecondary} />
                  <Text style={styles.footBtnText}>Reset to Mila's pick</Text>
                </Pressable>
              )}
              {!isCover && (
                <Pressable style={styles.footBtn} onPress={onHide}>
                  <Feather name="eye-off" size={14} color={Colors.light.textSecondary} />
                  <Text style={styles.footBtnText}>Hide this card</Text>
                </Pressable>
              )}
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "flex-end" },
  backdrop:  { ...StyleSheet.absoluteFill, backgroundColor: "rgba(42,38,34,0.5)" },
  sheet: {
    backgroundColor: Colors.light.card, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingTop: 10, maxHeight: "92%",
  },
  handle: { width: 40, height: 4.5, backgroundColor: Colors.light.border, borderRadius: 3, alignSelf: "center", marginBottom: Spacing.sm },

  header: {
    flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: Spacing.md,
    paddingHorizontal: Spacing.xl, paddingBottom: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.light.borderLight,
  },
  headerTx: { flex: 1, minWidth: 0 },
  eyebrow:  { fontFamily: Fonts.bodySemiBold, fontSize: 10.5, letterSpacing: 0.6, textTransform: "uppercase", color: MUTED },
  title:    { fontFamily: Fonts.headingSemiBold, fontSize: 17, color: Colors.light.text, marginTop: 2 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: Colors.light.backgroundDefault, alignItems: "center", justifyContent: "center" },

  // Prev/next arrows floating on the card's sides, vertically centered on the preview.
  navEdge: {
    position: "absolute", top: "50%", marginTop: -19, width: 38, height: 38, borderRadius: 19,
    backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: Colors.light.border,
    alignItems: "center", justifyContent: "center",
    shadowColor: "#0D0B08", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 8, elevation: 5,
  },
  navEdgeL:  { left: 0 },
  navEdgeR:  { right: 0 },
  navBtnOff: { opacity: 0.4 },

  scroll: { flexShrink: 1 },
  body:   { paddingHorizontal: Spacing.xl, paddingTop: Spacing.md, paddingBottom: Spacing["2xl"], gap: 14 },

  // Live real-card preview
  previewWrap: { alignItems: "center" },
  previewCard: {
    width: "62%", aspectRatio: 354 / 618, borderRadius: 20, overflow: "hidden", backgroundColor: T.ink,
    shadowColor: "#0D0B08", shadowOffset: { width: 0, height: 14 }, shadowOpacity: 0.32, shadowRadius: 20, elevation: 10,
  },
  previewCardShrink: { width: "48%" },   // make room for the picker when it's open
  hint: { fontFamily: Fonts.body, fontSize: 12, color: MUTED, textAlign: "center", marginTop: -2 },

  // Controls
  controls: { gap: 8 },
  ctrl: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: "#FFFFFF", borderWidth: 1.5, borderColor: Colors.light.border, borderRadius: 16, padding: 12,
  },
  ctrlOn:   { borderColor: Colors.light.primary, backgroundColor: "#FFF9FC" },
  ctrlIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: Colors.light.backgroundDefault, alignItems: "center", justifyContent: "center" },
  ctrlTx:   { flex: 1, minWidth: 0 },
  ctrlTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  ctrlTitle: { fontFamily: Fonts.bodyBold, fontSize: 13.5, color: Colors.light.text },
  editedDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: Colors.light.primary },
  ctrlSub:   { fontFamily: Fonts.body, fontSize: 11.5, color: MUTED, marginTop: 1 },

  // Context strip
  strip: { gap: 9, backgroundColor: Colors.light.backgroundDefault, borderRadius: 18, padding: 12 },
  stripLabel: { fontFamily: Fonts.bodySemiBold, fontSize: 10.5, letterSpacing: 0.6, textTransform: "uppercase", color: MUTED },
  chipRow: { gap: 8, paddingRight: 4 },
  chip: {
    maxWidth: 230, borderWidth: 1.5, borderColor: Colors.light.border, borderRadius: 14,
    backgroundColor: "#FFFFFF", paddingHorizontal: 12, paddingVertical: 9, justifyContent: "center",
  },
  chipSel:     { borderColor: Colors.light.primary, backgroundColor: "#FFF9FC" },
  chipText:    { fontFamily: Fonts.body, fontSize: 12.5, lineHeight: 17, color: Colors.light.text },
  chipTextSel: { color: "#FFFFFF" },
  customChip: {
    flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1.5, borderColor: Colors.light.primary,
    borderRadius: 14, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: "#FFF9FC", alignSelf: "center",
  },
  customChipOn:   { backgroundColor: Colors.light.primary },
  customChipText: { fontFamily: Fonts.bodySemiBold, fontSize: 12.5, color: Colors.light.primary },

  customInput: {
    fontFamily: Fonts.body, fontSize: 14, color: Colors.light.text, lineHeight: 20,
    backgroundColor: "#FFFFFF", borderWidth: 1.4, borderColor: Colors.light.border, borderRadius: 14,
    padding: 12, minHeight: 66, textAlignVertical: "top",
  },
  revert:     { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", paddingTop: 2 },
  revertText: { fontFamily: Fonts.bodySemiBold, fontSize: 12, color: MUTED },

  filterRow: { gap: 7, paddingRight: 4 },
  filterChip: { borderWidth: 1, borderColor: Colors.light.border, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: "#FFFFFF" },
  filterChipOn: { backgroundColor: Colors.light.text, borderColor: Colors.light.text },
  filterChipText: { fontFamily: Fonts.bodySemiBold, fontSize: 11.5, color: Colors.light.textSecondary, textTransform: "capitalize" },
  filterChipTextOn: { color: "#FFFFFF" },
  thumbRow: { gap: 8, paddingRight: 4, paddingTop: 2 },
  thumb: { width: 80, height: 104, borderRadius: 12, overflow: "hidden", borderWidth: 2, borderColor: "transparent", backgroundColor: Brand.heroBg },
  thumbSel: { borderColor: Colors.light.primary },
  thumbCheck: { position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: 11, backgroundColor: Colors.light.primary, alignItems: "center", justifyContent: "center" },
  emptyShots: { fontFamily: Fonts.body, fontSize: 12.5, color: MUTED, paddingVertical: 8 },
  clearedNote: { fontFamily: Fonts.body, fontSize: 11, color: MUTED },

  footer: { flexDirection: "row", flexWrap: "wrap", gap: 10, paddingTop: 4 },
  footBtn: {
    flexDirection: "row", alignItems: "center", gap: 7, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 999, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: "#FFFFFF",
  },
  footBtnText: { fontFamily: Fonts.bodySemiBold, fontSize: 13, color: Colors.light.textSecondary },
});
