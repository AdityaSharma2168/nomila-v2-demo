import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Fonts, Colors, BorderRadius, Bold } from "../../constants/theme";
import { AnchoredMenu, type AnchoredMenuItem } from "./AnchoredMenu";

// Deal lifecycle stages, in dropdown order. Mutually-exclusive status filters
// (kept in sync with the per-card status pill labels in DealCard).
export type StageKey = "all" | "new" | "negotiating" | "accepted" | "completed" | "declined" | "archived";

export const STAGES: { key: StageKey; label: string }[] = [
  { key: "all",         label: "All" },
  { key: "new",         label: "New" },
  { key: "negotiating", label: "Negotiating" },
  { key: "accepted",    label: "Accepted" },
  { key: "completed",   label: "Completed" },
  { key: "declined",    label: "Declined" },
  { key: "archived",    label: "Archived" },
];

interface StageDropdownProps {
  stage:    StageKey;
  counts:   Record<StageKey, number>;
  onChange: (s: StageKey) => void;
}

/**
 * The deal-stage selector that replaces the old "Needs Action" header + chips.
 * An anchored dropdown (via AnchoredMenu): the trigger shows the active stage +
 * its count; the menu lists every stage with its own count and a check on the
 * active one.
 */
export function StageDropdown({ stage, counts, onChange }: StageDropdownProps) {
  const current = STAGES.find((s) => s.key === stage) ?? STAGES[0];

  const items: AnchoredMenuItem[] = STAGES.map((s) => ({
    key:     s.key,
    label:   s.label,
    count:   counts[s.key] ?? 0,
    active:  s.key === stage,
    onPress: () => onChange(s.key),
  }));

  return (
    <AnchoredMenu
      align="left"
      minWidth={220}
      items={items}
      trigger={(open) => (
        <View style={styles.trigger}>
          <Text style={styles.triggerLabel}>{current.label}</Text>
          <View style={styles.countBadge}>
            <Text style={styles.countText}>{counts[stage] ?? 0}</Text>
          </View>
          <Feather name={open ? "chevron-up" : "chevron-down"} size={16} color={Colors.light.text} />
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  trigger: { flexDirection: "row", alignItems: "center", gap: 8 },
  triggerLabel: {
    fontFamily: Fonts.heading,
    fontSize: 22,
    color: Colors.light.text,
    letterSpacing: -0.2,
  },
  countBadge: {
    backgroundColor: Bold.actSoft,
    borderRadius: BorderRadius.full,
    minWidth: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 7,
  },
  countText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 11,
    color: Colors.light.primary,
    letterSpacing: 0.5,
  },
});
