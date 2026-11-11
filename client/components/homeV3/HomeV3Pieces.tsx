// Home v3's admin pieces (EXPO_PUBLIC_HOME_V3; the "Alive" framework's Admin row + Checklist sheet). Each draws what
// lib/homeV3Logic gives it and hands taps up; nothing here fetches or decides. (Mila's briefing is MilaBriefing.tsx.)
//
//   AdminRowView    the one blocking item on a warm ground, its button, and "+N more" → the checklist
//   ChecklistBody   "x of y done", a green bar, then every setup item with one pink pill (done ones ticked in green),
//                   inside the screen gutter

import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Accent, Bold, BoldType, Fonts } from "../../constants/theme";
import { HOME_V3_COPY, checklistProgress, type AdminRow, type SetupItem } from "../../lib/homeV3Logic";

export function AdminRowView({ row, onItem, onMore }: { row: AdminRow; onItem: (item: SetupItem) => void; onMore: () => void }) {
  return (
    <View style={styles.admin} testID="home-v3-admin">
      <Pressable onPress={() => onItem(row.item)} style={styles.adminMain} accessibilityRole="button" accessibilityLabel={`${row.item.title}. ${row.item.button}`} testID="home-v3-admin-item">
        <Feather name="alert-circle" size={16} color={Bold.ink} />
        <Text style={styles.adminText} numberOfLines={2}>{row.item.title}</Text>
      </Pressable>
      {row.more > 0 ? (
        <Pressable onPress={onMore} hitSlop={8} accessibilityRole="button" testID="home-v3-admin-more">
          <Text style={styles.adminMore}>{HOME_V3_COPY.checklist.more(row.more)}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function ChecklistBody({ items, onItem }: { items: ReadonlyArray<SetupItem>; onItem: (item: SetupItem) => void }) {
  const p = checklistProgress(items);
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  return (
    <View style={styles.checklist} testID="home-v3-checklist">
      <Text style={styles.progress}>{HOME_V3_COPY.checklist.progress(p.done, p.total)}</Text>
      <View style={styles.bar}><View style={[styles.barFill, { width: `${pct}%` }]} /></View>
      {items.map((i) => (
        <View key={i.id} style={styles.check} testID={`home-v3-check-${i.id}`}>
          <View style={[styles.tick, i.done && styles.tickDone]}>{i.done ? <Feather name="check" size={12} color={Bold.onDark} /> : null}</View>
          <Text style={[styles.checkText, i.done && styles.checkDone]} numberOfLines={2}>{i.title}</Text>
          {!i.done ? (
            <Pressable onPress={() => onItem(i)} hitSlop={8} style={({ pressed }) => [styles.checkGo, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={`${i.button}: ${i.title}`}>
              <Text style={styles.checkGoText}>{i.button}</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  pressed:     { transform: [{ scale: Bold.pressScale }] },
  admin:       { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: Bold.gutter, marginTop: 10, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, backgroundColor: Bold.ground, borderWidth: 1, borderColor: Bold.line },
  adminMain:   { flex: 1, flexDirection: "row", alignItems: "center", gap: 8 },
  adminText:   { ...BoldType.rowMeta, fontFamily: Fonts.bodySemiBold, color: Bold.ink, flexShrink: 1 },
  adminMore:   { ...BoldType.link, color: Accent.pinkDeep },
  checklist:   { paddingHorizontal: Bold.gutter },
  progress:    { ...BoldType.rowMeta, color: Bold.mute, marginTop: 10 },
  bar:         { height: 4, borderRadius: 2, backgroundColor: Bold.track, overflow: "hidden", marginTop: 6, marginBottom: 6 },
  barFill:     { height: 4, borderRadius: 2, backgroundColor: Accent.green },
  check:       { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 52, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: Bold.line },
  tick:        { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: Bold.line, alignItems: "center", justifyContent: "center" },
  tickDone:    { backgroundColor: Accent.green, borderColor: Accent.green },
  checkText:   { ...BoldType.rowMeta, color: Bold.ink, flex: 1 },
  checkDone:   { color: Bold.mute, textDecorationLine: "line-through" },
  checkGo:     { height: 30, paddingHorizontal: 14, borderRadius: 15, backgroundColor: Accent.pink, alignItems: "center", justifyContent: "center" },
  checkGoText: { ...BoldType.buttonSmall, color: Bold.onDark },
});
