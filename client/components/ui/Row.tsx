// Row — one fact or one item, inside a Card or a Sheet.
//
//   <Row label value meta leading trailing chevron onPress last />
//   <Row bold …>   look B (DESIGN.md, Oct 2026): 40 leading slot at corner 4, title 15/700, meta 13/400 mute, a 1px line
//
// Three slots: text on the left (label above value, meta under it), an optional leading tile,
// and a trailing slot that reads in this order when combined: chip · value column · button ·
// chevron. Rows never carry a background; the Card owns edges, the Row owns its hairline.

import React from "react";
import { View, Text, Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Colors, Fonts, Spacing, Bold, BoldType } from "../../constants/theme";

const C = Colors.light;

export interface RowProps {
  /** 12 · 500 · quiet, above the value. */
  label?:     string;
  /** 15 · 600 · ink. Pass `empty` to render the placeholder style instead. */
  value?:     string | null;
  /** What to show when value is empty ("Add it", "Not yet"). */
  empty?:     string;
  /** 11 · quiet, under the value. */
  meta?:      string;
  /** A 36×36 tile (ui/IconTile, ui/LogoMark, one of her photos). An older 34 tile sits centred in the slot. */
  leading?:   React.ReactNode;
  /** Chip, value column, button. */
  trailing?:  React.ReactNode;
  /** Draw the › affordance. Default: true when onPress is set. */
  chevron?:   boolean;
  /** A link-out row shows ↗ instead of ›. */
  external?:  boolean;
  onPress?:   () => void;
  /** Last row in its Card: no hairline. */
  last?:      boolean;
  /** Max lines for the value. Default 2; a list of deliverables passes more. */
  lines?:     number;
  /** Override the text block (money rows, two-line values). */
  children?:  React.ReactNode;
  /** Look B. */
  bold?:      boolean;
  style?:     StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

export function Row({ label, value, empty = "Not yet", meta, leading, trailing, chevron, external, onPress, last, lines = 2, children, bold, style, accessibilityLabel }: RowProps) {
  const isEmpty = value === null || value === undefined || value === "";
  const showChevron = chevron ?? !!onPress;
  const inner = (
    <>
      {leading ? <View style={[styles.leading, bold && styles.leadingBold]}>{leading}</View> : null}
      <View style={styles.text}>
        {children ?? (
          <>
            {label ? <Text style={[styles.label, bold && styles.labelBold]}>{label}</Text> : null}
            <Text style={[styles.value, bold && styles.valueBold, isEmpty && (bold ? styles.valueEmptyBold : styles.valueEmpty)]} numberOfLines={lines}>{isEmpty ? empty : value}</Text>
            {meta ? <Text style={[styles.meta, bold && styles.metaBold]} numberOfLines={bold ? 2 : 1}>{meta}</Text> : null}
          </>
        )}
      </View>
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
      {showChevron ? <Feather name={external ? "arrow-up-right" : "chevron-right"} size={bold ? 18 : 16} color={bold ? Bold.quiet : "#C5BFB8"} /> : null}
    </>
  );
  const rowStyle = [styles.row, bold && styles.rowBold, last && styles.last, style];
  if (onPress) {
    return (
      <Pressable style={({ pressed }) => [rowStyle, pressed && (bold ? styles.pressedBold : styles.pressed)]} onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? (label ? `${label}: ${value ?? empty}` : value ?? undefined)}>
        {inner}
      </Pressable>
    );
  }
  return <View style={rowStyle}>{inner}</View>;
}

/** A right-aligned number with a small line under it (rates, money): the value column. */
export function ValueColumn({ value, sub }: { value: string; sub?: string }) {
  return (
    <View style={styles.valueCol}>
      <Text style={styles.valueColMain}>{value}</Text>
      {sub ? <Text style={styles.valueColSub}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row:          { flexDirection: "row", alignItems: "center", gap: Spacing.md, paddingVertical: Spacing.md, paddingHorizontal: Spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.borderLight },
  rowBold:      { paddingVertical: Spacing.md, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: Bold.line },
  last:         { borderBottomWidth: 0 },
  pressed:      { backgroundColor: C.backgroundDefault },
  pressedBold:  { backgroundColor: Bold.ground },
  leading:      { width: 36, height: 36, borderRadius: 10, overflow: "hidden", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  leadingBold:  { width: 40, height: 40, borderRadius: Bold.radius.control },
  text:         { flex: 1, minWidth: 0, gap: 1 },
  label:        { fontFamily: Fonts.bodyMedium, fontSize: 12, color: C.textQuiet, letterSpacing: 0.2 },
  labelBold:    { ...BoldType.caption, color: Bold.mute },
  value:        { fontFamily: Fonts.bodySemiBold, fontSize: 15, lineHeight: 20, color: C.text },
  valueBold:    { ...BoldType.rowTitle, color: Bold.ink },
  valueEmpty:   { fontFamily: Fonts.body, color: "#B8B1A8" },
  valueEmptyBold:{ ...BoldType.body, color: Bold.quiet },
  meta:         { fontFamily: Fonts.body, fontSize: 11, color: C.textQuiet },
  metaBold:     { ...BoldType.rowMeta, color: Bold.mute },
  trailing:     { flexShrink: 0, alignItems: "flex-end" },
  valueCol:     { alignItems: "flex-end" },
  valueColMain: { fontFamily: Fonts.bodySemiBold, fontSize: 15, color: C.text, fontVariant: ["tabular-nums"] },
  valueColSub:  { fontFamily: Fonts.body, fontSize: 11, color: C.textQuiet, marginTop: 1 },
});
