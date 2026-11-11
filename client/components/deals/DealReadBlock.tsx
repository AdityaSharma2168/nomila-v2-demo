// DealReadBlock — the four-line read on the deal letter (deals design §5 "The read: four lines instead of a score").
// Money · Fit · Risk · Goal, each one line with its plain source under it. It replaces "Why it's here" and "Nomila's
// take". The Money row opens Your rates when the screen passes `onMoney` (its minimum and suggested range live there).
// No score, no colour but ink — a Risk with a flag set gets the blue "needs you" rule. Bold / BoldType only.
import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import type { DealRead } from "../../../shared/deals";
import type { BoardItem } from "../../hooks/use-opportunity-board";
import { readRows, type ReadRow } from "./dealLetterLogic";
import { Bold, BoldType } from "../../constants/theme";

function Line({ row, onPress }: { row: ReadRow; onPress?: () => void }) {
  const body = (
    <>
      <Text style={styles.label}>{row.label}</Text>
      <View style={styles.text}>
        <Text style={styles.line}>{row.line}</Text>
        <Text style={styles.source}>{row.source}</Text>
      </View>
      {onPress ? <Feather name="chevron-right" size={18} color={Bold.quiet} /> : null}
    </>
  );
  const style = [styles.row, row.flagged && styles.flagged];
  if (!onPress) return <View style={style} testID={`read-${row.key}`} accessible accessibilityLabel={`${row.label}: ${row.line}. ${row.source}`}>{body}</View>;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [...style, pressed && styles.pressed]} accessibilityRole="button"
      accessibilityLabel={`${row.label}: ${row.line}. ${row.source}. Open your rates`} testID={`read-${row.key}`}>
      {body}
    </Pressable>
  );
}

export function DealReadBlock({ read, item, onMoney }: { read: DealRead; item: Pick<BoardItem, "brand">; onMoney?: () => void }) {
  const rows = readRows(read, item);
  return (
    <View style={styles.block} testID="deal-read">
      {rows.map((r) => <Line key={r.key} row={r} onPress={r.key === "money" ? onMoney : undefined} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  block:   { borderTopWidth: 1, borderTopColor: Bold.line },
  row:     { flexDirection: "row", alignItems: "flex-start", gap: 12, minHeight: 44, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: Bold.line },
  flagged: { borderLeftWidth: 3, borderLeftColor: Bold.blue, paddingLeft: 9 },
  pressed: { backgroundColor: Bold.ground },
  label:   { ...BoldType.label, color: Bold.ink, width: 52, paddingTop: 3 },
  text:    { flex: 1, gap: 2 },
  line:    { ...BoldType.read, color: Bold.ink },
  source:  { ...BoldType.caption, color: Bold.mute },
});
