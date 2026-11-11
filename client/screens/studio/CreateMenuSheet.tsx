/**
 * CreateMenuSheet — the ＋ on the Studio masthead.
 *
 * WHAT THE FORK IS. The first three doors divide on WHO THE WORK IS FOR, not on how the engine will
 * make it. That is the deliberate difference from `components/studio/IntentPicker`, which asks the
 * athlete to choose image.generate / image.edit / video.generate — a question about the engine that
 * she has no way to answer and no reason to care about.
 *
 * Audience is the branch that actually changes what happens downstream: whether the work has to be
 * cleared with somebody, and whether it counts against a deal. On those three doors the engine task
 * is DERIVED — `engineIntentFor()` in lib/studio-contract, off the format she picks — and she never
 * names it. (This comment used to point at `deriveIntent()`, which would have chosen image.edit
 * when she attached a frame of her own. That function is dead: nothing but its tests calls it, and
 * `engineIntentFor` deliberately never returns image.edit, because none of these three doors has a
 * mask editor and an edit with no measured region is a permanently blocked verdict.)
 *
 * ─── AND ONE DOOR THAT IS A VERB ───────────────────────────────────────────────────────────────
 *
 * "Edit a photo" breaks the audience rule, honestly and on purpose. It is the one thing the fork
 * above cannot express: a bounded change to a photograph she already has, owed to nobody, where
 * the frame survives and only the marked part moves. It sits BELOW THE RULE with "Create anything"
 * rather than among the three, because like that one it is unconstrained by audience.
 *
 * It is also the only door that does not lead to the new surface. It opens CampaignWorkspaceScreen
 * — the older, denser workspace that carries the mask editor — which was built, tested and correct
 * but had become unreachable when this sheet replaced the ＋ menu: nothing opened it, so every
 * photo operation fell through to the generate path and came back a full re-render. Matching it to
 * this surface's design is a later, separate job; a working edit behind an off-style screen beats
 * a missing one.
 *
 * Pitch decks reuse the existing CreatePitchFlow rather than getting a Studio equivalent; it is a
 * finished surface and this sheet is only a door onto it.
 */
import React from "react";
import { View, Text, Modal, Pressable, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { HapticPressable } from "../../components/HapticPressable";
import { Colors, Fonts, Spacing } from "../../constants/theme";

export type CreateDoor = "brand" | "personal" | "pitch" | "anything";

interface Door {
  key: CreateDoor;
  icon: React.ComponentProps<typeof Feather>["name"];
  title: string;
  sub: string;
  /** The one door that is owed to somebody. Leads the list and carries the accent. */
  primary?: boolean;
}

const DOORS: Door[] = [
  { key: "brand",    icon: "briefcase", title: "Brand posts",    sub: "For a brand. Binds to a deliverable when there is one.", primary: true },
  // Back by Adi's call (23 Sep 2026): the door stays; it opens Create anything (PersonalPostScreen is gone).
  { key: "personal", icon: "image",     title: "Personal posts", sub: "Yours. Nothing to clear with anyone." },
  { key: "pitch",    icon: "edit-3",    title: "Pitch decks",    sub: "A tailored deck for any brand." },
];

/** Under the rule, apart from the three above: nothing constrains these and nobody asked for them. */
const ANYTHING: Door = {
  key: "anything", icon: "zap", title: "Create anything", sub: "Say it in your own words. I make it.",
};

/**
 * The narrower verb, so it sits under the broad one. `crop` is the icon IntentPicker gave this same
 * door, kept so the two front doors do not name the same thing differently.
 *
 * The sub-line says what a masked edit IS, because that is the part that was missing: with no door
 * for it, "change one thing in this photo" was being typed into flows that can only generate.
 */
export function CreateMenuSheet({
  visible, onClose, onPick,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (door: CreateDoor) => void;
}) {
  const row = (d: Door) => (
    <HapticPressable
      key={d.key}
      style={[styles.door, d.primary && styles.doorPrimary]}
      onPress={() => { onClose(); onPick(d.key); }}
      accessibilityRole="button"
      accessibilityLabel={`${d.title}. ${d.sub}`}
    >
      <View style={styles.doorIcon}>
        <Feather name={d.icon} size={17} color={Colors.light.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.doorTitle}>{d.title}</Text>
        <Text style={styles.doorSub}>{d.sub}</Text>
      </View>
      <Feather name="chevron-right" size={15} color={Colors.light.tabIconDefault} />
    </HapticPressable>
  );

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        <Text style={styles.title}>Make something</Text>
        <View style={styles.doors}>
          {DOORS.map(row)}
          <View style={styles.rule} />
          {row(ANYTHING)}
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
  doors: { gap: 7 },
  door: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: Colors.light.card,
    borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 15, padding: 13,
  },
  doorPrimary: { borderWidth: 2, borderColor: Colors.light.primary, backgroundColor: Colors.light.primaryLight },
  doorIcon: {
    width: 34, height: 34, borderRadius: 12,
    backgroundColor: Colors.light.primaryLight,
    alignItems: "center", justifyContent: "center",
  },
  doorTitle: { fontFamily: Fonts.bodyBold, fontSize: 14.5, fontWeight: "700", color: Colors.light.text },
  doorSub: { fontFamily: Fonts.body, fontSize: 11.5, color: Colors.light.textMuted, marginTop: 1 },
  rule: { height: 1, backgroundColor: Colors.light.border, marginVertical: 5 },
});
