// StackHeader — the top of every PUSHED screen: back chevron, centred title, one right slot.
// Tab roots keep their own left-aligned title; this is not for them.
//
//   <StackHeader title="Rates" />
//   <StackHeader title="Deck" dark right={<IconButton …/>} />
//   <StackHeader title="Your plan" bold />      look B (DESIGN.md, Oct 2026): ‹ and the PARENT's name in caps at the
//                                               left (11/800, .16em), no centred title — the screen draws its own
//                                               display title beneath
//   <StackHeader title="Your plan" bold dark />  the same bar in white, riding over a deck or a photo (Deck's topBar
//                                               slot). 52 high, 16 gutter (DESIGN.md §11 Shell). The screen's root is a
//                                               SafeAreaView, so the bar always sits below the status bar — never under it.

import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { haptics } from "../../lib/haptics";
import { Colors, Fonts, Spacing, Bold, BoldType } from "../../constants/theme";

const C = Colors.light;

export function StackHeader({ title, right, dark, bold, onBack }: {
  title:   string;
  right?:  React.ReactNode;
  /** On the hero ground (the Deck, a photo): ink becomes onHero / onDark. The screen paints the ground. */
  dark?:   boolean;
  /** Look B: the back label at the left. */
  bold?:   boolean;
  /** Default: navigation.goBack(). */
  onBack?: () => void;
}) {
  const navigation = useNavigation();
  const back = onBack ?? (() => navigation.goBack());
  if (bold) {
    const ink = dark ? Bold.onDark : Bold.ink;
    return (
      <View style={styles.headerBold} testID="stack-header">
        <Pressable
          hitSlop={10}
          style={({ pressed }) => [styles.backBold, pressed && styles.pressed]}
          onPress={() => { haptics.press(); back(); }}
          accessibilityRole="button"
          accessibilityLabel="Back"
          testID="stack-header-back"
        >
          <Feather name="chevron-left" size={18} color={ink} />
          <Text style={[styles.backLabel, { color: ink }]} numberOfLines={1}>{title}</Text>
        </Pressable>
        <View style={styles.sideRight}>{right ?? null}</View>
      </View>
    );
  }
  const ink = dark ? C.onHero : C.text;
  return (
    <View style={styles.header}>
      <Pressable hitSlop={10} style={styles.side} onPress={back} accessibilityRole="button" accessibilityLabel="Back">
        <Feather name="chevron-left" size={24} color={ink} />
      </Pressable>
      <Text style={[styles.title, { color: ink }]} numberOfLines={1}>{title}</Text>
      <View style={[styles.side, styles.sideRight]}>{right ?? null}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  header:     { flexDirection: "row", alignItems: "center", paddingHorizontal: Spacing.xl, paddingTop: 14, paddingBottom: Spacing.sm },
  side:       { width: 32, alignItems: "flex-start", justifyContent: "center" },
  sideRight:  { alignItems: "flex-end" },
  title:      { flex: 1, textAlign: "center", fontFamily: Fonts.headingSemiBold, fontSize: 18, lineHeight: 24 },
  headerBold: { height: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: Bold.gutter },
  backBold:   { flexDirection: "row", alignItems: "center", gap: 2, minHeight: 44, flexShrink: 1 },
  backLabel:  { ...BoldType.backLabel, color: Bold.ink },
  pressed:    { opacity: 0.7 },
});
