/**
 * ReferencePicker — where an athlete says what a piece is built FROM, and what each photo is for.
 *
 * Two tags, and both put a thing IN the picture: her likeness, and the product. That is the whole
 * vocabulary now.
 *
 * ─── THERE WAS A THIRD TAG AND IT WAS REMOVED ───────────────────────────────────────────────────
 *
 * "A look" let her add a mood board or a competitor's ad as a style reference, under a caption that
 * read "We'll take the look — never the people." The routing behind it worked exactly as designed;
 * the model did not honour it, and faces leaked. A promise the model will not keep is worse than no
 * feature, because she would have chosen the photo believing it.
 *
 * Style direction now belongs in THE BRIEF — the free-text box on this screen, which already
 * carries her words into the prompt. "Golden hour, shot on film, summer campaign" is direction we
 * can actually deliver, and it claims nothing about a photograph of somebody else.
 *
 * ─── NO DEFAULT TAG ─────────────────────────────────────────────────────────────────────────────
 *
 * An untagged tile is not an error and is not pre-filled. It renders visibly incomplete and holds
 * the cost check back with a hint, which is exactly how an unlabelled mask region already behaves
 * one section up (CampaignWorkspaceScreen's `canCheck`). One tap is cheaper than guessing on her
 * behalf what a photo is for.
 *
 * ─── UPLOADS ONLY ───────────────────────────────────────────────────────────────────────────────
 *
 * The library is filtered to `source: "upload"`. Ingested Instagram media keeps its EXIF
 * orientation flag; an upload is straightened in place on the way in (routes/media.ts →
 * studio/orient.ts), so a reference picked here is upright by construction.
 *
 * NOTHING HERE IS TRUSTED WITH IDENTITY. Only an `assetId` and a tag leave this component. The
 * server re-reads the row under her own athlete id and takes the storage path from THAT, so a
 * modified client cannot point a generation at a photo that is not hers.
 */
import React, { useMemo, useState } from "react";
import {
  View, Text, Image, ScrollView, Pressable, StyleSheet, TextInput, ActivityIndicator,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import {
  useMyMedia, useUploadMediaBatch, pickFromCameraRoll, RightsAckRequired, type MediaItem,
} from "../../hooks/use-media-library";
import { RightsAckPanel } from "../media/RightsAckPanel";
import type { StudioReference, StudioReferenceRole } from "../../hooks/use-studio";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";
import { CLIP_EMPTY_ASK, clipFrameNote, PERSON_PACK_RULE, personPackNote } from "./referencePack";

/** One chosen reference, plus the thumbnail needed to render it. */
export interface DraftReference {
  assetId: string;
  /** Null until she taps a tag. NOT defaulted — see the module header. */
  role: StudioReferenceRole | null;
  label: string;
  thumbUrl: string | null;
}

/** Ready to send: tagged only. The server refuses an untagged one, so this never invents a role. */
export function toStudioReferences(drafts: DraftReference[]): StudioReference[] {
  return drafts
    .filter((d): d is DraftReference & { role: StudioReferenceRole } => d.role !== null)
    .map((d) => ({
      assetId: d.assetId,
      role: d.role,
      ...(d.label.trim() ? { label: d.label.trim() } : {}),
    }));
}

/** True while any tile still has no tag — the workspace holds the cost check back on this. */
export const hasUntagged = (drafts: DraftReference[]): boolean => drafts.some((d) => d.role === null);

/**
 * The still's empty-state ask, unchanged. A const rather than inline JSX only so that it sits beside
 * the clip's and the branch reads as one choice between two sentences.
 *
 * ⚠️ NOT MOVED INTO referencePack.ts, where CLIP_EMPTY_ASK lives and where this belongs. That module
 * exists so a sentence that ships to her is testable without a renderer, and this one has never been
 * pinned. Relocating live image copy to tidy up a video card is how a character goes missing from a
 * sentence nobody was reviewing; it can move when something is actually changing it.
 */
const STILL_EMPTY_ASK =
  "Up to three photos of you — the ones where your face is clearest — and the product if there is one. " +
  "Describe the look you want in the brief below.";

/** Mirrors MAX_LABEL_LEN in server/studio/geometry.ts, which the route re-checks. */
const MAX_LABEL = 60;

type IconName = React.ComponentProps<typeof Feather>["name"];

const ROLES: { value: StudioReferenceRole; label: string; icon: IconName }[] = [
  { value: "person",  label: "You",     icon: "user" },
  { value: "product", label: "Product", icon: "tag" },
];

const ROLE_BY_VALUE = Object.fromEntries(ROLES.map((r) => [r.value, r])) as Record<
  StudioReferenceRole, (typeof ROLES)[number]
>;

export function ReferencePicker({
  references, onChange, clip = false, justThese, onJustThese,
}: {
  references: DraftReference[];
  onChange: (next: DraftReference[]) => void;
  /**
   * "Just these" (PR 17, R-3): when the parent passes BOTH, a toggle renders under the pack note —
   * her word that her identity pack may not top up the person slots. A caller that passes neither
   * renders exactly what it rendered before. ⚠️ MUTATION (IdentityPackSheet.test, client half of
   * "pack surface renders with STUDIO_IDENTITY_PACK off"): the parent gates on the flag, not this file.
   */
  justThese?: boolean;
  onJustThese?: (v: boolean) => void;
  /**
   * This picker is choosing what a CLIP is built from rather than a still.
   *
   * ⚠️ IT CHANGES THE COPY AND NOTHING ELSE. Same tags, same tiles, same library, same payload — the
   * engine derives the task from the deliverable and has never needed this component to know it. What
   * it cannot derive is the SENTENCE: a still is built from a pack and a clip from one frame, so the
   * ask and the note are the two things that have to differ. referencePack.ts has why each of the
   * still's three claims is false in motion.
   *
   * Defaults to false, so every caller that does not pass it renders exactly what it rendered before.
   */
  clip?: boolean;
}) {
  // Uploads only — see the module header. Ingested media keeps its EXIF flag.
  const { data, isLoading } = useMyMedia("photos", { source: "upload" });
  const upload = useUploadMediaBatch();
  const [ackAssets, setAckAssets] = useState<ImagePicker.ImagePickerAsset[] | null>(null);
  // "Uploading 3 of 12…" while a multi-select batch runs, then a final tally (failures included).
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [batchNote, setBatchNote] = useState<string | null>(null);

  const library = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const chosen = new Set(references.map((r) => r.assetId));
  const personCount = references.filter((r) => r.role === "person").length;
  // ⚠️ THE TWO NOTES COUNT DIFFERENT THINGS, and that is not an inconsistency. The pack note is about
  // how many photographs of HER a still carries. The clip note is about which reference becomes the
  // frame, and the frame is the first reference of ANY role — so it counts the tiles, not her.
  const note = clip ? clipFrameNote(references.length) : personPackNote(personCount);

  // Adds several items in one go — building the array off the CURRENT `references` once, rather
  // than calling a single-item `add` per item in a loop, which would race: each call would read
  // the same stale `references` prop before the parent re-rendered and only the last would stick.
  const addMany = (items: Pick<MediaItem, "asset_id" | "thumb_url">[]) => {
    const fresh = items.filter((it) => !chosen.has(it.asset_id));
    if (!fresh.length) return;
    onChange([
      ...references,
      ...fresh.map((item) => ({ assetId: item.asset_id, role: null, label: "", thumbUrl: item.thumb_url })),
    ]);
  };
  const add = (item: Pick<MediaItem, "asset_id" | "thumb_url">) => addMany([item]);

  const patch = (assetId: string, over: Partial<DraftReference>) =>
    onChange(references.map((r) => (r.assetId === assetId ? { ...r, ...over } : r)));

  const remove = (assetId: string) => onChange(references.filter((r) => r.assetId !== assetId));

  const runUpload = async (assets: ImagePicker.ImagePickerAsset[], ackRights: boolean) => {
    setProgress({ current: 0, total: assets.length });
    try {
      const result = await upload.mutateAsync({
        assets, ackRights,
        onProgress: (p) => setProgress({ current: p.current, total: p.total }),
      });
      setAckAssets(null);
      addMany(result.succeeded);   // fresh uploads land straight on the list, still untagged
      setBatchNote(
        assets.length > 1
          ? `Added ${result.succeeded.length} of ${assets.length}${result.failed.length ? ` — ${result.failed.length} failed` : ""}`
          : null
      );
    } catch (e) {
      // The one-time rights attestation, answered inline — Alert.alert is a no-op on web.
      if (e instanceof RightsAckRequired) setAckAssets(assets);
    } finally {
      setProgress(null);
    }
  };

  const onUpload = async () => {
    const picked = await pickFromCameraRoll("photo", { multiple: true });
    if (!picked) return;
    setBatchNote(
      picked.truncated ? `Uploading the first ${picked.truncated.kept} of ${picked.truncated.picked} selected` : null
    );
    await runUpload(picked.assets, false);
  };

  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <Text style={styles.eyebrow}>WHAT IT&apos;S BUILT FROM</Text>
        <Pressable onPress={onUpload} style={styles.addBtn} disabled={upload.isPending} hitSlop={6}>
          {upload.isPending
            ? <ActivityIndicator size="small" color={Colors.light.primary} />
            : <Feather name="plus" size={15} color={Colors.light.primary} />}
          <Text style={styles.addBtnTxt}>Add a photo</Text>
        </Pressable>
      </View>

      {ackAssets ? (
        <View style={styles.ackWrap}>
          <RightsAckPanel
            busy={upload.isPending}
            onConfirm={() => runUpload(ackAssets, true)}
            onCancel={() => setAckAssets(null)}
          />
        </View>
      ) : null}

      {progress ? (
        <Text style={styles.batchNote}>Uploading {progress.current} of {progress.total}…</Text>
      ) : batchNote ? (
        <Text style={styles.batchNote}>{batchNote}</Text>
      ) : null}

      {references.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Add the photos this should be built from.</Text>
          <Text style={styles.emptyBody}>
            {clip ? CLIP_EMPTY_ASK : STILL_EMPTY_ASK}
          </Text>
        </View>
      ) : (
        <View style={styles.list}>
          {references.map((r) => (
            <ReferenceTile
              key={r.assetId}
              draft={r}
              onRole={(role) => patch(r.assetId, { role })}
              onLabel={(label) => patch(r.assetId, { label })}
              onRemove={() => remove(r.assetId)}
            />
          ))}
          {note || personCount > 0 ? (
            <View style={styles.packNote}>
              {note ? <Text style={styles.packNoteTxt}>{note}</Text> : null}
              {/* ⚠️ THE CONSENT BOUNDARY IS GATED ON HER OWN TILES, NEVER ON THE NOTE.
                  On a still the two coincide exactly — personPackNote is non-null precisely when
                  personCount > 0 — so this renders bit-for-bit what it did before. On a clip they come
                  apart: clipFrameNote speaks for a product-only tray too, while the boundary is only
                  ever about the person slot. Left coupled, it would have dropped the sentence from a
                  clip built from one photograph of her — the one place it must appear. */}
              {personCount > 0 ? <Text style={styles.packNoteRule}>{PERSON_PACK_RULE}</Text> : null}
            </View>
          ) : null}
          {onJustThese ? (
            <Pressable
              onPress={() => onJustThese(!justThese)}
              style={[styles.justThese, justThese && styles.justTheseOn]}
              accessibilityRole="switch"
              accessibilityState={{ checked: !!justThese }}
              testID="pack-just-these"
            >
              <Feather name={justThese ? "check-circle" : "circle"} size={13} color={justThese ? Colors.light.primary : Colors.light.textMuted} />
              <Text style={[styles.justTheseTxt, justThese && styles.justTheseTxtOn]}>Just these photos — don&apos;t add from my pack</Text>
            </Pressable>
          ) : null}
        </View>
      )}

      {/* Her uploaded photos, to pick from without leaving the screen. */}
      <Text style={styles.libLabel}>YOUR UPLOADS</Text>
      {isLoading ? (
        <View style={styles.libEmpty}><ActivityIndicator size="small" color={Colors.light.primary} /></View>
      ) : library.length === 0 ? (
        <View style={styles.libEmpty}>
          <Text style={styles.emptyBody}>Nothing uploaded yet — add a photo above.</Text>
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.libRow}>
          {library.slice(0, 24).map((m) => {
            const picked = chosen.has(m.asset_id);
            return (
              <Pressable
                key={m.asset_id}
                style={[styles.libTile, picked ? styles.libTileOn : null]}
                onPress={() => add(m)}
                disabled={picked}
                accessibilityRole="button"
                accessibilityState={{ disabled: picked, selected: picked }}
              >
                {m.thumb_url ? <Image source={{ uri: m.thumb_url }} style={styles.libImg} resizeMode="cover" /> : null}
                {picked ? (
                  <View style={styles.libCheck}>
                    <Feather name="check" size={12} color={Colors.light.buttonText} />
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

/**
 * One reference, and the tap that decides what it contributes.
 *
 * This was a two-group layout — INGREDIENTS against THE VIBE — because a look reference contributed
 * something categorically different from the other two and that had to be visible. With the look
 * reference gone both remaining tags do the same kind of thing, so a single row is the honest
 * shape: inventing a hierarchy between "you" and "product" would be decoration.
 */
function ReferenceTile({
  draft, onRole, onLabel, onRemove,
}: {
  draft: DraftReference;
  onRole: (role: StudioReferenceRole) => void;
  onLabel: (label: string) => void;
  onRemove: () => void;
}) {
  const untagged = draft.role === null;

  return (
    <View style={[styles.tile, untagged ? styles.tileUntagged : null]}>
      <View style={styles.tileTop}>
        <View style={styles.thumbWrap}>
          {draft.thumbUrl ? (
            <Image source={{ uri: draft.thumbUrl }} style={styles.thumb} resizeMode="cover" />
          ) : (
            <View style={[styles.thumb, styles.thumbEmpty]}>
              <Feather name="image" size={16} color={Colors.light.textMuted} />
            </View>
          )}
        </View>

        <View style={{ flex: 1, gap: 8 }}>
          <Text style={untagged ? styles.tileHintOn : styles.tileHint}>
            {untagged ? "What is this photo for?" : ROLE_BY_VALUE[draft.role!].label}
          </Text>
          <View style={styles.chipRow}>
            {ROLES.map((r) => (
              <RoleChip key={r.value} spec={r} active={draft.role === r.value} onPress={() => onRole(r.value)} />
            ))}
          </View>
        </View>

        <Pressable onPress={onRemove} hitSlop={8} accessibilityRole="button" accessibilityLabel="Remove this reference">
          <Feather name="x" size={16} color={Colors.light.textMuted} />
        </Pressable>
      </View>

      <TextInput
        style={styles.labelInput}
        value={draft.label}
        onChangeText={onLabel}
        placeholder={draft.role === "product" ? "What is it? e.g. the M charm" : "Optional note"}
        placeholderTextColor={Colors.light.textMuted}
        maxLength={MAX_LABEL}
      />
    </View>
  );
}

function RoleChip({
  spec, active, onPress,
}: {
  spec: (typeof ROLES)[number]; active: boolean; onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.chip, active ? styles.chipOn : null]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Feather name={spec.icon} size={13} color={active ? Colors.light.primary : Colors.light.textMuted} />
      <Text style={[styles.chipTxt, active ? styles.chipTxtOn : null]}>{spec.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.xl },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  eyebrow: {
    fontFamily: Fonts.bodyBold, fontSize: 10.5, letterSpacing: 1.4, fontWeight: "700",
    color: Colors.light.textMuted,
  },
  addBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    minHeight: 32, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.full, backgroundColor: Colors.light.primaryLight,
  },
  addBtnTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 12.5, fontWeight: "600", color: Colors.light.primary },

  ackWrap: { marginBottom: Spacing.md },
  batchNote: { fontFamily: Fonts.bodyMedium, fontSize: 12, color: Colors.light.textMuted, marginBottom: Spacing.md },

  empty: {
    padding: Spacing.lg, gap: 4,
    backgroundColor: Colors.light.card, borderRadius: BorderRadius.lg,
    borderWidth: 1, borderStyle: "dashed", borderColor: Colors.light.border,
  },
  emptyTitle: { fontFamily: Fonts.bodySemiBold, fontSize: 13.5, fontWeight: "600", color: Colors.light.text },
  emptyBody: { fontFamily: Fonts.body, fontSize: 12, lineHeight: 17, color: Colors.light.textMuted },

  list: { gap: 10 },
  packNote: { paddingHorizontal: 2, gap: 2 },
  packNoteTxt: { fontFamily: Fonts.bodyMedium, fontSize: 12, lineHeight: 17, color: Colors.light.text },
  packNoteRule: { fontFamily: Fonts.body, fontSize: 11.5, lineHeight: 16, color: Colors.light.textMuted },
  justThese: {
    flexDirection: "row", alignItems: "center", gap: 7, alignSelf: "flex-start", minWidth: 120,
    marginTop: 10, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
    borderWidth: 1, borderColor: Colors.light.border, backgroundColor: Colors.light.card,
  },
  justTheseOn: { borderColor: Colors.light.primary, backgroundColor: Colors.light.primaryLight },
  justTheseTxt: { fontFamily: Fonts.bodyMedium, fontSize: 12, fontWeight: "500", color: Colors.light.textMuted },
  justTheseTxtOn: { color: Colors.light.primary },
  tile: {
    padding: Spacing.lg, gap: 10,
    backgroundColor: Colors.light.card, borderRadius: BorderRadius.lg,
    borderWidth: 1, borderColor: Colors.light.border,
  },
  // Visibly incomplete, never red: an untagged tile is a step not taken, not a mistake.
  tileUntagged: { borderStyle: "dashed", borderColor: Colors.light.primary },
  tileTop: { flexDirection: "row", alignItems: "flex-start", gap: 12 },

  thumbWrap: { width: 64 },
  thumb: { width: 64, height: 80, borderRadius: BorderRadius.xs, backgroundColor: Colors.light.backgroundSecondary },
  thumbEmpty: { alignItems: "center", justifyContent: "center" },

  tileHint: { fontFamily: Fonts.bodySemiBold, fontSize: 13.5, fontWeight: "600", color: Colors.light.text },
  tileHintOn: { fontFamily: Fonts.bodyBold, fontSize: 13.5, fontWeight: "700", color: Colors.light.primary },

  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 5,
    minHeight: 32, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.full, backgroundColor: Colors.light.backgroundRoot,
    borderWidth: 1, borderColor: Colors.light.border,
  },
  chipOn: { backgroundColor: Colors.light.primaryLight, borderColor: Colors.light.primary },
  chipTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 12.5, fontWeight: "600", color: Colors.light.textMuted },
  chipTxtOn: { fontFamily: Fonts.bodyBold, fontWeight: "700", color: Colors.light.primary },

  labelInput: {
    minHeight: 38, paddingHorizontal: Spacing.md, paddingVertical: 8,
    backgroundColor: Colors.light.backgroundRoot, borderRadius: BorderRadius.xs,
    borderWidth: 1, borderColor: Colors.light.borderLight,
    fontFamily: Fonts.body, fontSize: 13, color: Colors.light.text,
  },

  libLabel: {
    fontFamily: Fonts.bodyBold, fontSize: 9.5, letterSpacing: 1.1, fontWeight: "700",
    color: Colors.light.textMuted, marginTop: Spacing.lg, marginBottom: 8,
  },
  libEmpty: {
    height: 72, alignItems: "center", justifyContent: "center",
    backgroundColor: Colors.light.card, borderRadius: BorderRadius.lg,
    borderWidth: 1, borderStyle: "dashed", borderColor: Colors.light.border,
  },
  libRow: { gap: 8, paddingVertical: 2 },
  libTile: {
    width: 64, height: 80, borderRadius: BorderRadius.xs, overflow: "hidden",
    backgroundColor: Colors.light.backgroundSecondary, borderWidth: 2, borderColor: "transparent",
  },
  libTileOn: { borderColor: Colors.light.primary, opacity: 0.5 },
  libImg: { width: "100%", height: "100%" },
  libCheck: {
    position: "absolute", top: 4, right: 4, width: 18, height: 18, borderRadius: 9,
    alignItems: "center", justifyContent: "center", backgroundColor: Colors.light.primary,
  },
});
