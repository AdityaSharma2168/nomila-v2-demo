/**
 * IntentPicker — the Studio front door. Replaces the masthead ＋ menu when STUDIO_ENABLED is on.
 *
 * WHAT IT IS NOT: a launcher for parallel workspaces. There is ONE CampaignWorkspaceScreen, and
 * three of these four buttons open it with different parameters — engine, mode, which references
 * it will demand, which cost basis the preview shows. The fork happens here so the workspace never
 * has to ask what kind of job it is holding.
 *
 * WHAT IS AND ISN'T A BRANCH
 *   branch     the ENGINE + MODE pair: new image / edit a photo / new video.
 *   parameter  the FORMAT (post · story · reel · ad · carousel · clip) and brand tailoring. Those
 *              live inside the workspace as pills. Forking a screen per format would give us six
 *              screens that differ by an aspect ratio.
 *
 * NO VIDEO-EDIT ARM. That is not an omission. The pixel-faithful edit path is a masked composite
 * and has no motion equivalent, so the engine refuses `edit` + a video deliverable outright rather
 * than downgrading it to a full re-render — the exact failure the edit/generate fork exists to
 * prevent. Offering the button and then refusing it would be worse than not offering it.
 *
 * Pitch deck NAVIGATES ONLY. It opens the existing CreatePitchFlow — the same call the old ＋ menu
 * made — and touches no deck-engine code. It is here because the picker replaces the ＋ menu, and
 * the menu's "New pitch" item is the one entry on it that works today; dropping it would make the
 * front door worse to add a feature behind a flag.
 */
import React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import type { StudioIntent } from "../../hooks/use-studio";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";

type IconName = React.ComponentProps<typeof Feather>["name"];

type Choice =
  | { kind: "intent"; intent: StudioIntent; label: string; blurb: string; icon: IconName }
  | { kind: "deck"; label: string; blurb: string; icon: IconName };

const CHOICES: Choice[] = [
  { kind: "intent", intent: "image.generate", label: "New image",    blurb: "A still, made from scratch",           icon: "image" },
  { kind: "intent", intent: "image.edit",     label: "Edit a photo", blurb: "Change one thing in a shot you own",   icon: "crop" },
  { kind: "intent", intent: "video.generate", label: "New video",    blurb: "A few seconds of motion",              icon: "video" },
  { kind: "deck",                             label: "Pitch deck",   blurb: "A tailored deck for any brand",        icon: "edit-3" },
];

export function IntentPicker({
  visible, onClose, onPickIntent, onPickDeck,
}: {
  visible: boolean;
  onClose: () => void;
  onPickIntent: (intent: StudioIntent) => void;
  onPickDeck: () => void;
}) {
  const choose = (c: Choice) => {
    onClose();
    if (c.kind === "deck") onPickDeck();
    else onPickIntent(c.intent);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Stop propagation so a tap inside the sheet doesn't dismiss it. */}
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>What are you making?</Text>

          {CHOICES.map((c, i) => (
            <React.Fragment key={c.kind === "deck" ? "deck" : c.intent}>
              {/* The deck sits below a rule — it goes somewhere else entirely. */}
              {c.kind === "deck" ? <View style={styles.divider} /> : i > 0 ? <View style={styles.hair} /> : null}
              <Pressable style={styles.row} onPress={() => choose(c)}>
                <View style={styles.icon}>
                  <Feather name={c.icon} size={17} color={Colors.light.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>{c.label}</Text>
                  <Text style={styles.blurb}>{c.blurb}</Text>
                </View>
                <Feather name="chevron-right" size={17} color={Colors.light.textMuted} />
              </Pressable>
            </React.Fragment>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(10,8,7,0.42)" },
  sheet: {
    backgroundColor: Colors.light.card,
    borderTopLeftRadius: BorderRadius.lg, borderTopRightRadius: BorderRadius.lg,
    borderWidth: 1, borderColor: Colors.light.border,
    paddingTop: Spacing.lg, paddingBottom: Spacing["3xl"], paddingHorizontal: Spacing.sm,
  },
  title: {
    fontFamily: Fonts.display, fontSize: 20, fontWeight: "800", letterSpacing: -0.4,
    color: Colors.light.text, paddingHorizontal: Spacing.lg, paddingBottom: Spacing.md,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 13, paddingHorizontal: Spacing.lg, paddingVertical: 13 },
  icon: {
    width: 40, height: 40, borderRadius: BorderRadius.xs,
    alignItems: "center", justifyContent: "center", backgroundColor: Colors.light.primaryLight,
  },
  label: { fontFamily: Fonts.bodyBold, fontSize: 15.5, fontWeight: "700", color: Colors.light.text },
  blurb: { fontFamily: Fonts.body, fontSize: 12.5, color: Colors.light.textMuted, marginTop: 1 },
  hair: { height: 1, backgroundColor: Colors.light.borderLight, marginHorizontal: Spacing.lg },
  divider: { height: 1, backgroundColor: Colors.light.border, marginHorizontal: Spacing.lg, marginVertical: Spacing.sm },
});
