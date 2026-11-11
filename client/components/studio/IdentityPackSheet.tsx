/**
 * IdentityPackSheet — her identity PACK: 10–15 photographs of her, chosen by her (PR 17, R-2).
 *
 * ─── WHAT IT SHOWS, AND WHAT IT NEVER CLAIMS ────────────────────────────────────────────────────
 *
 * Her photographs, each judged by the server's pack gate: a refused tile says WHY ("made here",
 * "not you", "no face", "still reading") and cannot be picked. The pack's standing is the server's
 * one sentence (`profile.standing`) — "not yet measured", "measured, not asserted", "control did
 * not pass" — shown as written. No score, no distance, no threshold, and no word of pass/fail about
 * her face: the calibration's numbers stay on the record.
 *
 * "Measure" spends (face boxes + embeds, quoted on GET profile); the button says the number first,
 * and pressing it is her go. Nothing here loops or retries.
 *
 * ─── ADD PHOTOS ────────────────────────────────────────────────────────────────────────────────
 *
 * The same upload the library and the reference picker use — `pickFromCameraRoll` (multiple),
 * `useUploadMediaBatch`, and the SAME rights attestation panel (`RightsAckPanel`) when the server
 * asks for it. An upload lands in the list as "Still reading" (the tagger has not seen it yet) and
 * is NEVER auto-picked: she picks it once it is readable. ⚠️ MUTATIONS (IdentityPackSheet.test):
 * "an uploaded photo is auto-picked into the pack" — push the upload's ids into `picked`;
 * "an unread upload can be picked" — drop the `eligible` guard in `toggle`.
 *
 * ─── OFF IS NOTHING ────────────────────────────────────────────────────────────────────────────
 *
 * With EXPO_PUBLIC_STUDIO_IDENTITY_PACK off this renders null before any hook runs — no query, no
 * QueryClient lookup. ⚠️ MUTATION (IdentityPackSheet.test): drop the flag check — "pack surface
 * renders with STUDIO_IDENTITY_PACK off" reds by name.
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useQueryClient } from "@tanstack/react-query";
import { Colors, Fonts, Spacing, Bold } from "../../constants/theme";
import { STUDIO_IDENTITY_PACK } from "../../lib/flags";
import {
  pickFromCameraRoll,
  RightsAckRequired,
  useUploadMediaBatch,
} from "../../hooks/use-media-library";
import { RightsAckPanel } from "../media/RightsAckPanel";
import {
  IDENTITY_KEY,
  useCalibratePack,
  useIdentityCandidates,
  useIdentityProfile,
  useSavePack,
  type CandidateWire,
} from "../../hooks/use-identity-pack";

interface Props {
  visible: boolean;
  onClose: () => void;
}

/** The flag is decided here, BEFORE any hook runs. Off, this mounts nothing. */
export function IdentityPackSheet(props: Props) {
  if (!STUDIO_IDENTITY_PACK) return null;
  return <IdentityPackSheetLive {...props} />;
}

/** What the tile says under a photo that cannot be picked, in two words. */
export function refusalWord(refusal: string | null): string | null {
  switch (refusal) {
    case null:
      return null;
    case "generated":
      return "Made here";
    case "not_you":
      return "Not you";
    case "likeness_no_face":
      return "No face";
    case "rejected":
      return "Set aside";
    case "face_partial":
      return "Partly visible";
    case "reference_unread":
      return "Still reading";
    case "reference_read_failed":
      return "Couldn't read";
    case "reference_read_capped":
      return "Couldn't read";
    default:
      return "Not usable";
  }
}

function IdentityPackSheetLive({ visible, onClose }: Props) {
  const profile = useIdentityProfile(visible);
  const candidates = useIdentityCandidates(visible);
  const save = useSavePack();
  const calibrate = useCalibratePack();

  const qc = useQueryClient();
  const upload = useUploadMediaBatch();
  const [ackAssets, setAckAssets] = useState<
    ImagePicker.ImagePickerAsset[] | null
  >(null);
  const [uploadNote, setUploadNote] = useState<string | null>(null);

  const saved = profile.data?.profile;
  const [picked, setPicked] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  // Her saved pack seeds the selection each time the sheet opens; her edits are session-only.
  useEffect(() => {
    if (!visible) return;
    setPicked(saved?.pack.map((e) => e.assetId) ?? []);
    setDirty(false);
  }, [visible, saved]);

  const max = saved?.max ?? 15;
  const min = saved?.min ?? 10;
  const toggle = (c: CandidateWire) => {
    if (!c.eligible) return;
    setDirty(true);
    setPicked((cur) =>
      cur.includes(c.assetId)
        ? cur.filter((id) => id !== c.assetId)
        : cur.length >= max
          ? cur
          : [...cur, c.assetId],
    );
  };

  /**
   * Uploads land in the list and NOWHERE ELSE: `picked` is untouched here. A fresh row is unread
   * until the tagger runs, and the gate says so on its tile; she picks it when it is readable.
   */
  const runUpload = async (
    assets: ImagePicker.ImagePickerAsset[],
    ackRights: boolean,
  ) => {
    try {
      const result = await upload.mutateAsync({ assets, ackRights });
      setAckAssets(null);
      setUploadNote(
        `Added ${result.succeeded.length} of ${assets.length}${result.failed.length ? ` — ${result.failed.length} failed` : ""}. New photos show as "Still reading" until they've been read; pick them then.`,
      );
      await qc.invalidateQueries({ queryKey: IDENTITY_KEY });
    } catch (e) {
      // The one-time rights attestation, answered inline — the same panel the library upload uses.
      if (e instanceof RightsAckRequired) setAckAssets(assets);
      else
        setUploadNote(
          e instanceof Error ? e.message : "Couldn't upload those.",
        );
    }
  };
  const onAddPhotos = async () => {
    const pickedNow = await pickFromCameraRoll("photo", { multiple: true });
    if (!pickedNow) return;
    setUploadNote(
      pickedNow.truncated
        ? `Uploading the first ${pickedNow.truncated.kept} of ${pickedNow.truncated.picked} selected`
        : null,
    );
    await runUpload(pickedNow.assets, false);
  };

  const refused = useMemo(
    () => new Map((save.data?.refused ?? []).map((r) => [r.assetId, r.reason])),
    [save.data],
  );
  const quote = profile.data?.quote.usd ?? null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.safe} testID="identity-pack-sheet">
        <View style={styles.head}>
          <View style={{ flex: 1 }}>
            <Text style={styles.eyebrow}>YOUR LIKENESS PACK</Text>
            <Text style={styles.title}>Photos of you</Text>
          </View>
          <Pressable
            onPress={onClose}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={styles.close}
          >
            <Feather name="x" size={20} color={Colors.light.text} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.lede}>
            Pick {min} to {max} photos where your face is clear. When you make
            something of yourself with fewer than three photos attached, the
            best of these fill in. Photos of you only — not a friend, not a
            teammate.
          </Text>

          {/* The standing, exactly as the server says it — never a pass/fail word about her face. */}
          {saved ? (
            <View style={styles.standing} testID="pack-standing">
              <Feather
                name="info"
                size={13}
                color={Colors.light.textSecondary}
              />
              <Text style={styles.standingTxt}>{saved.standing}</Text>
            </View>
          ) : null}

          <View style={styles.row}>
            <Pressable
              onPress={onAddPhotos}
              disabled={upload.isPending}
              style={[
                styles.pill,
                styles.pillGhost,
                styles.pillInline,
                upload.isPending && styles.pillOff,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Add photos"
              testID="pack-add-photos"
            >
              {upload.isPending ? (
                <ActivityIndicator size="small" color={Colors.light.primary} />
              ) : (
                <Text style={[styles.pillTxt, styles.pillGhostTxt]}>
                  Add photos
                </Text>
              )}
            </Pressable>
          </View>
          {ackAssets ? (
            <View style={styles.ack}>
              <RightsAckPanel
                busy={upload.isPending}
                onConfirm={() => runUpload(ackAssets, true)}
                onCancel={() => setAckAssets(null)}
              />
            </View>
          ) : null}
          {uploadNote ? (
            <Text style={styles.note} testID="pack-upload-note">
              {uploadNote}
            </Text>
          ) : null}

          <View style={styles.row}>
            <Text style={styles.count} testID="pack-count">
              {picked.length} of {max} picked
            </Text>
            <Pressable
              onPress={() => save.mutate({ assetIds: picked })}
              disabled={!dirty || save.isPending}
              style={[
                styles.pill,
                (!dirty || save.isPending) && styles.pillOff,
              ]}
              accessibilityRole="button"
              testID="pack-save"
            >
              {save.isPending ? (
                <ActivityIndicator
                  size="small"
                  color={Colors.light.buttonText}
                />
              ) : (
                <Text style={styles.pillTxt}>Save pack</Text>
              )}
            </Pressable>
          </View>
          {save.error ? (
            <Text style={styles.err}>{save.error.message}</Text>
          ) : null}
          {save.data?.partialAdmitted ? (
            <Text style={styles.note}>
              Fewer than {min} clear faces, so partly visible ones filled in.
              The profile says so.
            </Text>
          ) : null}
          {save.data?.nudge ? (
            <Text style={styles.note} testID="pack-nudge">
              {save.data.nudge}
            </Text>
          ) : null}
          {save.data?.overCap.length ? (
            <Text style={styles.note}>Only the first {max} were kept.</Text>
          ) : null}

          {candidates.isLoading ? (
            <ActivityIndicator
              style={{ marginTop: 24 }}
              color={Colors.light.primary}
            />
          ) : (
            <View style={styles.grid}>
              {(candidates.data?.candidates ?? []).map((c) => {
                const on = picked.includes(c.assetId);
                const word = refusalWord(c.refusal);
                const why = refused.get(c.assetId) ?? c.reason;
                return (
                  <Pressable
                    key={c.assetId}
                    onPress={() => toggle(c)}
                    style={[
                      styles.tile,
                      on && styles.tileOn,
                      !c.eligible && styles.tileOff,
                    ]}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on, disabled: !c.eligible }}
                    accessibilityLabel={
                      why
                        ? `Not usable: ${why}`
                        : on
                          ? "In your pack"
                          : "Add to your pack"
                    }
                    testID={`pack-tile-${c.assetId}`}
                  >
                    <Image source={{ uri: c.thumbUrl }} style={styles.img} />
                    {on ? (
                      <View style={styles.check}>
                        <Feather
                          name="check"
                          size={12}
                          color={Colors.light.buttonText}
                        />
                      </View>
                    ) : null}
                    {word && c.refusal !== "face_partial" ? (
                      <View style={styles.badge}>
                        <Text style={styles.badgeTxt}>{word}</Text>
                      </View>
                    ) : word ? (
                      <View style={[styles.badge, styles.badgeSoft]}>
                        <Text style={styles.badgeTxt}>{word}</Text>
                      </View>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          )}

          {saved && saved.pack.length > 0 ? (
            <View style={styles.measure}>
              <Text style={styles.label}>MEASURE</Text>
              <Text style={styles.muted}>
                Compares your pack photos with each other and records how far
                your own face moves between them. It costs about{" "}
                {quote === null ? "—" : `$${quote.toFixed(4)}`} and nothing
                decides anything from it: the number stays on the record.
              </Text>
              <Pressable
                onPress={() => calibrate.mutate()}
                disabled={calibrate.isPending || dirty}
                style={[
                  styles.pill,
                  styles.pillGhost,
                  (calibrate.isPending || dirty) && styles.pillOff,
                ]}
                accessibilityRole="button"
                testID="pack-measure"
              >
                {calibrate.isPending ? (
                  <ActivityIndicator
                    size="small"
                    color={Colors.light.primary}
                  />
                ) : (
                  <Text style={[styles.pillTxt, styles.pillGhostTxt]}>
                    {quote === null
                      ? "Measure"
                      : `Measure · $${quote.toFixed(4)}`}
                  </Text>
                )}
              </Pressable>
              {dirty ? (
                <Text style={styles.note}>Save the pack first.</Text>
              ) : null}
              {calibrate.error ? (
                <Text style={styles.err}>{calibrate.error.message}</Text>
              ) : null}
              {calibrate.data ? (
                <Text style={styles.note}>
                  Measured {calibrate.data.measured.faces} of{" "}
                  {calibrate.data.measured.photos} faces across{" "}
                  {calibrate.data.measured.pairs} pairs. Recorded, not asserted.
                </Text>
              ) : null}
            </View>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const TILE = 104;
const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.light.backgroundRoot,
    paddingTop: 54,
  },
  head: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: Spacing.lg,
    paddingBottom: 12,
  },
  eyebrow: {
    fontFamily: Fonts.bodyBold,
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 1.4,
    color: Colors.light.textMuted,
  },
  title: {
    fontFamily: Fonts.headingSemiBold,
    fontSize: 26,
    fontWeight: "600",
    color: Colors.light.text,
    marginTop: 2,
  },
  close: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.light.card,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  body: { paddingHorizontal: Spacing.lg, paddingBottom: 48 },
  lede: {
    fontFamily: Fonts.body,
    fontSize: 13.5,
    lineHeight: 19,
    color: Colors.light.textSecondary,
  },
  standing: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-start",
    marginTop: 14,
    padding: 12,
    borderRadius: 16,
    backgroundColor: Colors.light.backgroundDefault,
  },
  standingTxt: {
    flex: 1,
    fontFamily: Fonts.bodyMedium,
    fontSize: 12.5,
    lineHeight: 17,
    fontWeight: "500",
    color: Colors.light.textSecondary,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 16,
  },
  count: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 13,
    fontWeight: "600",
    color: Colors.light.text,
  },
  pill: {
    minWidth: 120,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: Colors.light.primary,
  },
  pillOff: { opacity: 0.45 },
  pillTxt: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 13,
    fontWeight: "600",
    color: Colors.light.buttonText,
  },
  pillGhost: {
    backgroundColor: Colors.light.card,
    borderWidth: 1,
    borderColor: Colors.light.border,
    alignSelf: "flex-start",
    marginTop: 10,
  },
  pillGhostTxt: { color: Colors.light.primary },
  pillInline: { marginTop: 0 },
  ack: { marginTop: 12 },
  err: {
    marginTop: 8,
    fontFamily: Fonts.body,
    fontSize: 12,
    color: Colors.light.primary,
  },
  note: {
    marginTop: 8,
    fontFamily: Fonts.body,
    fontSize: 12,
    lineHeight: 17,
    color: Colors.light.textMuted,
  },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14 },
  tile: {
    width: TILE,
    height: TILE,
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "transparent",
    backgroundColor: Colors.light.backgroundDefault,
  },
  tileOn: { borderColor: Colors.light.primary },
  tileOff: { opacity: 0.55 },
  img: { width: "100%", height: "100%" },
  check: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: Colors.light.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    position: "absolute",
    left: 6,
    bottom: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: "rgba(13,11,8,0.78)",
  },
  badgeSoft: { backgroundColor: "rgba(13,11,8,0.5)" },
  badgeTxt: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 10,
    fontWeight: "600",
    color: Bold.onDark,
  },
  measure: { marginTop: 26 },
  label: {
    fontFamily: Fonts.bodyBold,
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 1.4,
    color: Colors.light.textMuted,
    marginBottom: 8,
  },
  muted: {
    fontFamily: Fonts.body,
    fontSize: 12.5,
    lineHeight: 18,
    color: Colors.light.textMuted,
  },
});
