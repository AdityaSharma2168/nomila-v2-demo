/**
 * AttachSheet — the ＋ inside the Create anything composer.
 *
 * ─── WHY A ＋ AND NOT A PILL ROW ────────────────────────────────────────────────────────────────
 * A permanent row of three pills sat above the input on every render, costing a whole row of the
 * screen, for something nobody touches before they have typed anything. ＋ is the universal grammar
 * for "add something" and costs an icon.
 *
 * ─── WHY THE TILES ARE ROLES, NOT SOURCES ──────────────────────────────────────────────────────
 * Camera / Library / Files would be a SOURCE taxonomy, and it would throw away the thing this app
 * knows that a camera-roll picker does not: a product has to be the actual piece. The source
 * choice — library, upload, a pasted link — still happens, in the picker that follows.
 */
import React from "react";
import { View, Text, Modal, Pressable, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { HapticPressable } from "../../components/HapticPressable";
import { Colors, Fonts, Spacing } from "../../constants/theme";
import { pickableRoles, type PickableRole } from "../../lib/studio-contract";
import { STUDIO_STYLE_SPEC } from "../../lib/flags";

// inspiration role retired from picker (D1); still dropped server-side — see toEngineReferences.
// Re-add here if a typed style slot lands.

/**
 * What a picker can actually produce. The role stays a valid member of `ReferenceRole` — the engine
 * still drops it defensively — but nothing in the UI can mint one any more, and this type is how
 * that is enforced rather than remembered: a re-added inspiration tile fails to COMPILE.
 *
 * Safe because attachments aren't persisted (local state + route params only; useStudioThreads is
 * a stub). If threads ever persist, inspiration becomes a legacy-draft case and the maps keyed on
 * this need a fallback, not Exclude.
 *
 * Re-exported from studio-contract rather than declared here: the LIST of pickable roles has to sit
 * somewhere this suite can reach (the client tests are pure logic, no renderer), and a type and its
 * only inhabitants belong together. Consumers keep importing it from this screen.
 */
export type { PickableRole };

/**
 * ─── THE THIRD TILE, AND WHY IT IS NOT A THIRD NAME FOR THE SAME THING ─────────────────────────
 *
 * One tile used to carry three meanings: the frame being edited, an identity anchor for a generate,
 * and an object library to pull a thing out of. The third had no tile at all, so a soccer ball had
 * nowhere to go but "Your media" — and a "Your media" attachment could become the frame being
 * edited. Sweep 7.2 watched exactly that: the ball was attached first and the edit targeted the
 * ball.
 *
 * `Object` gives that material a home, which removes the commonest way the frame inverted. It does
 * not, on its own, settle which of two photographs of HERS is the frame — that is the badge in the
 * tray (CreateAnythingScreen), and the two halves are the tile contract together.
 *
 * The first two tiles still carry two meanings between them, and that is deliberate rather than
 * unfinished: "the frame being edited" and "an identity anchor" are the SAME photograph, and which
 * one it is depends on the sentence she has not typed yet. The cutover moved that decision to her
 * words on purpose (studio/classify.ts). Splitting the tile would move it back to attach time.
 */
/**
 * ⚠️ TOTAL OVER `PickableRole`, WHICH IS THE POINT. A role she may mint with no tile beside it is a
 * role she cannot actually produce — the state `object` was in before this PR, and the reason a
 * soccer ball had nowhere to go but "Your media". As a `Record` that is a COMPILE error rather than
 * a screen with a missing button, which is the same discipline the `Exclude` above uses.
 */
const TILE_BY_ROLE: Record<PickableRole, {
  icon: React.ComponentProps<typeof Feather>["name"];
  label: string;
  note: string;
}> = {
  "source-frame": { icon: "image", label: "Your media", note: "Photos and footage you own" },
  product:        { icon: "tag",   label: "Product",    note: "The actual piece, in frame" },
  object:         { icon: "box",   label: "Object",     note: "A thing to put in the shot" },
  // PR 18, EXPO_PUBLIC_STUDIO_STYLE_SPEC only. Lists references she has already had read. The look comes
  // from that reading, never from sending the picture (see ReferenceRole in server/studio/brief.ts).
  style:          { icon: "aperture", label: "Style",   note: "A look you've had read" },
};

/** In the order the contract lists them, so the picker and the tests read the same sequence. */
const TILES = pickableRoles(STUDIO_STYLE_SPEC).map((role) => ({ role, ...TILE_BY_ROLE[role] }));

export function AttachSheet({
  visible, onClose, onPick,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (role: PickableRole) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        <Text style={styles.title}>Add something</Text>
        <View style={styles.tiles}>
          {TILES.map((t) => (
            <HapticPressable
              key={t.role}
              style={styles.tile}
              onPress={() => { onClose(); onPick(t.role); }}
              accessibilityRole="button"
              accessibilityLabel={`${t.label}. ${t.note}`}
            >
              <Feather name={t.icon} size={22} color={Colors.light.primary} />
              <Text style={styles.tileLabel}>{t.label}</Text>
              <Text style={styles.tileNote}>{t.note}</Text>
            </HapticPressable>
          ))}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(13,11,8,0.42)" },
  sheet: {
    backgroundColor: Colors.light.backgroundRoot,
    borderTopLeftRadius: 26, borderTopRightRadius: 26,
    paddingHorizontal: Spacing.xl, paddingTop: 10, paddingBottom: 34,
  },
  grabber: {
    width: 38, height: 4, borderRadius: 99,
    backgroundColor: Colors.light.backgroundTertiary, alignSelf: "center", marginBottom: 14,
  },
  title: {
    fontFamily: Fonts.display, fontSize: 19, fontWeight: "800",
    letterSpacing: -0.3, color: Colors.light.text, marginBottom: 12,
  },
  tiles: { flexDirection: "row", gap: 8 },
  tile: {
    flex: 1, minWidth: 0, alignItems: "center",
    backgroundColor: Colors.light.card,
    borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 16, paddingVertical: 15, paddingHorizontal: 10,
  },
  tileLabel: {
    fontFamily: Fonts.bodyBold, fontSize: 12.5, fontWeight: "700",
    color: Colors.light.text, marginTop: 9, textAlign: "center",
  },
  tileNote: {
    fontFamily: Fonts.body, fontSize: 10.5, lineHeight: 14,
    color: Colors.light.textMuted, marginTop: 4, textAlign: "center",
  },
});
