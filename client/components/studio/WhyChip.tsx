/**
 * WhyChip — the minimal "why" (PR 6): a pill that opens the planner's reason for one item or Board
 * row — the capability-library entry it came from, why it fits, and what it beat, in her words
 * (agentLogic `reasonWords`). Nothing is fetched to open it. Renders nothing when there is no reason.
 * Shared by the Agent screen's plan card and the Board's rows so the two say the same thing.
 */
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";

export function WhyChip({ words }: { words: string | null | undefined }) {
  const [open, setOpen] = useState(false);
  if (!words) return null;
  return (
    <View>
      <Pressable
        style={[styles.chip, open && styles.chipOn]}
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Why this: ${words}`}
      >
        <Feather
          name="help-circle"
          size={11}
          color={open ? Colors.light.buttonText : Colors.light.text}
        />
        <Text style={[styles.txt, open && styles.txtOn]}>WHY</Text>
      </Pressable>
      {open ? <Text style={styles.words}>{words}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 5,
    minWidth: 120,
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    marginTop: 4,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  chipOn: {
    backgroundColor: Colors.light.text,
    borderColor: Colors.light.text,
  },
  txt: {
    flexShrink: 1,
    fontFamily: Fonts.bodySemiBold,
    fontSize: 11.5,
    fontWeight: "600",
    letterSpacing: 0.4,
    color: Colors.light.text,
  },
  txtOn: { color: Colors.light.buttonText },
  words: {
    marginTop: 4,
    fontFamily: Fonts.body,
    fontSize: 12.5,
    lineHeight: 17,
    color: Colors.light.textSecondary,
  },
});
