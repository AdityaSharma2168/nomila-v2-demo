import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Bold, Fonts, Colors, Spacing } from "../../constants/theme";

export type CategoryId = "ALL" | "PAID" | "MEDIA" | "EDITORIAL" | "GIFTING";

const FILTERS: { id: CategoryId; label: string; icon: any; color: string }[] = [
  // One look (23 Oct 2026): the selected filter fills ink — never a ring colour (those mean the score).
  { id: "ALL",       label: "All",       icon: "infinite-outline",   color: Bold.ink },
  { id: "PAID",      label: "Paid",      icon: "cash-outline",       color: Bold.ink },
  { id: "MEDIA",     label: "Media",     icon: "mic-outline",        color: Bold.ink },
  { id: "EDITORIAL", label: "Product review", icon: "newspaper-outline",  color: Bold.ink },
  { id: "GIFTING",   label: "Gifting",   icon: "gift-outline",       color: Bold.ink },
];

interface CategoryFilterProps {
  selected: CategoryId;
  onChange: (id: CategoryId) => void;
}

export function CategoryFilter({ selected, onChange }: CategoryFilterProps) {
  return (
    <View style={styles.row}>
      {FILTERS.map((f) => {
        const isSelected = f.id === selected;
        return (
          <Pressable key={f.id} style={styles.item} onPress={() => onChange(f.id)}>
            <View style={[
              styles.circle,
              { backgroundColor: f.color },
              isSelected && styles.circleSelected,
            ]}>
              <Ionicons name={f.icon} size={20} color={Colors.light.buttonText} />
            </View>
            <Text style={[styles.label, { color: isSelected ? f.color : "#AAAAAA" }]}>
              {f.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.xl,
    paddingVertical: 10,
  },
  item: {
    alignItems: "center",
    gap: 5,
  },
  circle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  circleSelected: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 4,
    elevation: 3,
  },
  label: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 11,
    letterSpacing: 0.5,
  },
});
