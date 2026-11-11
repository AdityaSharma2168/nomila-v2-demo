/**
 * KeyframesShell — Pipeline 2 (generate-from-keyframes), and it is a SHELL.
 *
 * videoEntryLogic.ts named two product pipelines when V4 decided an entry is a VIDEO rather than a
 * generation result. V7 builds the first one. This is the second, standing in for itself so the
 * two-pipeline shape is visible on the surface rather than only in a comment.
 *
 * ⚠️ ─── IT MUST BE OBVIOUSLY UNBUILT ──────────────────────────────────────────────────────────────
 *
 * A placeholder that looks functional is worse than no placeholder: it invites a bug report about
 * a feature that does not exist, and it invites the next person to wire "just the button". So there
 * is no input, no control that could be pressed, no route, no flag and no state — it renders what
 * it will be and says plainly that it is not built.
 *
 * When it IS built it reuses everything Pipeline 1 does: `videoEntry` for the phase, `VideoEntry`
 * and `ClipPlayer` for the render, and its own adapter beside `videoEntryFromJob`. That reuse is
 * the claim V4 made and V7 tested; this file exists partly to keep it visible.
 */
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";

export function KeyframesShell() {
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Feather name="layers" size={16} color={Colors.light.textMuted} />
        <Text style={styles.title}>Generate from keyframes</Text>
      </View>
      <Text style={styles.body}>
        Pick a first and last frame and have the motion between them made for
        you.
      </Text>
      <View style={styles.tag}>
        <Text style={styles.tagTxt}>Not built yet</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: Spacing.xs,
    padding: Spacing.md,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.light.card,
    borderWidth: 1,
    borderColor: Colors.light.border,
    // Dashed, so it reads as an outline of something rather than as a thing.
    borderStyle: "dashed",
  },
  head: { flexDirection: "row", alignItems: "center", gap: Spacing.xs },
  title: {
    fontFamily: Fonts.headingSemiBold,
    fontWeight: "600",
    fontSize: 14,
    color: Colors.light.textSecondary,
  },
  body: {
    fontFamily: Fonts.body,
    fontSize: 13,
    color: Colors.light.textMuted,
  },
  tag: {
    alignSelf: "flex-start",
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.light.backgroundSecondary,
  },
  tagTxt: {
    fontFamily: Fonts.bodyMedium,
    fontWeight: "500",
    fontSize: 11,
    color: Colors.light.textQuiet,
  },
});
