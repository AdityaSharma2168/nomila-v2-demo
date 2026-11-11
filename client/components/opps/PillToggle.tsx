// Opportunities' section toggle on the v3 surfaces (EXPO_PUBLIC_HOME_V3): two soft pills, each with what needs her as a
// count ("Deals 4 · Bookings 1"). Text only — no illustrations here (owner, 20 Oct 2026: 3D art lives on Me, Create and
// empty states; this is a work screen). The count is a pink chip only when something needs her.

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Accent, Bold, BoldType, Shadows } from "../../constants/theme";
import { haptics } from "../../lib/haptics";
import { pillLabel, type PillTab } from "./oppsTabs";

export function PillToggle<K extends string>({ tabs, active, onChange, testID }: { tabs: ReadonlyArray<PillTab<K>>; active: K; onChange: (k: K) => void; testID?: string }) {
  return (
    <View style={styles.track} accessibilityRole="tablist" testID={testID}>
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <Pressable key={t.key} onPress={() => { if (!on) { haptics.select(); onChange(t.key); } }} accessibilityRole="tab" accessibilityState={{ selected: on }}
            accessibilityLabel={pillLabel(t)} style={[styles.pill, on && styles.pillOn]} testID={testID ? `${testID}-${t.key}` : undefined} hitSlop={4}>
            <Text style={[styles.label, on && styles.labelOn]}>{t.label}</Text>
            {t.count ? <View style={styles.count}><Text style={styles.countText}>{t.count > 99 ? "99+" : t.count}</Text></View> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: "row", alignSelf: "flex-start", backgroundColor: Bold.ground, borderRadius: 999, padding: 4, gap: 4, marginTop: 4, marginBottom: 6 },
  pill: { flexDirection: "row", alignItems: "center", gap: 6, height: 38, paddingHorizontal: 16, borderRadius: 999 },
  pillOn: { backgroundColor: Bold.paper, ...Shadows.card },
  label: { ...BoldType.h4, color: Bold.mute },
  labelOn: { color: Bold.ink },
  count: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, backgroundColor: Accent.pink, alignItems: "center", justifyContent: "center" },
  countText: { fontSize: 11, lineHeight: 13, fontWeight: "800", color: Bold.paper, fontVariant: ["tabular-nums"] },
});
