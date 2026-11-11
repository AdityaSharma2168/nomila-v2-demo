import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Brand } from "../../constants/theme";

/** The gold "N opens" pill — the quiet echo of "a brand is looking." */
export function OpensPill({ count, compact = false }: { count: number; compact?: boolean }) {
  return (
    <View style={[styles.pill, compact && styles.compact]}>
      <Feather name="eye" size={compact ? 9 : 11} color="#8A6A12" />
      <Text style={[styles.txt, compact && styles.txtCompact]}>
        {count}
        {compact ? "" : count === 1 ? " open" : " opens"}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#F4ECDB",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  compact: { paddingHorizontal: 6, paddingVertical: 1 },
  txt: { color: "#8A6A12", fontSize: 11, fontWeight: "800", fontFamily: "Outfit_700Bold" },
  txtCompact: { fontSize: 10 },
});

export const GOLD_INK = "#8A6A12";
export const GOLD_SOFT = "#F4ECDB";
export { Brand };
