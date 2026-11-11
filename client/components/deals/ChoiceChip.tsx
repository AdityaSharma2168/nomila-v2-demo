// ChoiceChip · TopTabs — the two tappable choosers the deal screens share. Bold / BoldType only.
//
//   <ChoiceChip selected onPress count={4}>Gifting</ChoiceChip>   DESIGN.md §11 Chip "line" (12/700, 1.5px line, corner 4);
//                                                                 selected fills ink. A 44pt target by hit slop.
//   <TopTabs tabs={[{ key, label, count }]} active onChange />    DESIGN.md §11 Shell "Top tabs": 12/800 uppercase, 18
//                                                                 apart, a 3px ink underline on the active one.
import React from "react";
import { View, Text, Pressable, ScrollView, StyleSheet } from "react-native";
import { Bold, BoldType } from "../../constants/theme";
import { haptics } from "../../lib/haptics";

export function ChoiceChip({ children, selected, onPress, count, testID, accessibilityLabel }: {
  children: string;
  selected?: boolean;
  onPress: () => void;
  count?: number | null;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const text = count != null ? `${children} ${count}` : children;
  return (
    <Pressable
      onPress={() => { haptics.select(); onPress(); }}
      hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      accessibilityLabel={accessibilityLabel ?? text}
      style={({ pressed }) => [styles.chip, selected && styles.chipOn, pressed && styles.pressed]}
      testID={testID}
    >
      <Text style={[styles.chipText, selected && styles.chipTextOn]}>{text}</Text>
    </Pressable>
  );
}

export function ChipRow({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  );
}

export interface TopTab<K extends string> { key: K; label: string; count?: number | null }

export function TopTabs<K extends string>({ tabs, active, onChange, testID }: { tabs: ReadonlyArray<TopTab<K>>; active: K; onChange: (k: K) => void; testID?: string }) {
  return (
    <View style={styles.tabs} accessibilityRole="tablist" testID={testID}>
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <Pressable
            key={t.key}
            onPress={() => { if (!on) { haptics.select(); onChange(t.key); } }}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={t.count != null ? `${t.label}, ${t.count}` : t.label}
            style={styles.tab}
            testID={testID ? `${testID}-${t.key}` : undefined}
          >
            <Text style={[styles.tabText, on && styles.tabTextOn]}>{t.count != null ? `${t.label} ${t.count}` : t.label}</Text>
            <View style={[styles.underline, on && styles.underlineOn]} />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row:         { gap: 8, paddingVertical: 4 },
  chip:        { minHeight: 34, paddingHorizontal: 10, justifyContent: "center", borderWidth: 1.5, borderColor: Bold.ink, borderRadius: Bold.radius.control, backgroundColor: Bold.paper },
  chipOn:      { backgroundColor: Bold.ink },
  chipText:    { ...BoldType.chipLine, color: Bold.ink },
  chipTextOn:  { color: Bold.onDark },
  pressed:     { transform: [{ scale: Bold.pressScale }] },
  tabs:        { flexDirection: "row", gap: 18, borderBottomWidth: 1, borderBottomColor: Bold.line },
  tab:         { minHeight: 44, justifyContent: "flex-end" },
  tabText:     { ...BoldType.segment, color: Bold.quiet, paddingBottom: 8 },
  tabTextOn:   { color: Bold.ink },
  underline:   { height: 3, backgroundColor: "transparent" },
  underlineOn: { backgroundColor: Bold.ink },
});
