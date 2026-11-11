import React, { useMemo, useState } from "react";
import {
  View, Text, ScrollView, SafeAreaView, StatusBar, Pressable, StyleSheet,
  TextInput, useWindowDimensions, RefreshControl,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import type { StudioStackParamList } from "../navigation/MainTabNavigator";
import { useAuth } from "../lib/auth-context";
import { useMyPitches, type Pitch } from "../hooks/use-pitches";
import { PitchDeckTile } from "../components/pitch/PitchDeckTile";
import { isNeedsRefresh } from "../components/pitch/pitchStatus";
import { Colors, Fonts, Spacing } from "../constants/theme";

type Filter = "all" | "opened" | "ready" | "sent" | "stale";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all",    label: "All" },
  { key: "opened", label: "◆ Opened" },
  { key: "ready",  label: "Ready" },
  { key: "sent",   label: "Sent" },
  { key: "stale",  label: "Needs refresh" },
];

function matchesFilter(p: Pitch, f: Filter): boolean {
  if (f === "all") return true;
  if (f === "stale") return isNeedsRefresh(p);
  if (f === "sent") return p.status === "sent" || p.status === "opened";
  return p.status === f;
}

export function PitchesListScreen() {
  const nav = useNavigation<NativeStackNavigationProp<StudioStackParamList>>();
  const route = useRoute<RouteProp<StudioStackParamList, "PitchesList">>();
  const { athlete } = useAuth();
  const { pitches, isLoading, refetch } = useMyPitches(athlete?.id);
  const { width } = useWindowDimensions();

  const initialFilter = route.params?.initialFilter;
  const [filter, setFilter] = useState<Filter>(
    initialFilter && FILTERS.some((f) => f.key === initialFilter) ? (initialFilter as Filter) : "all",
  );
  const [q, setQ] = useState("");

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return pitches.filter(
      (p) => matchesFilter(p, filter) && (!needle || p.brandName.toLowerCase().includes(needle)),
    );
  }, [pitches, filter, q]);

  const gap = Spacing.lg;
  const tileW = Math.floor((width - Spacing.xl * 2 - gap) / 2);

  const counts = useMemo(() => ({
    opened: pitches.filter((p) => p.status === "opened").length,
    stale:  pitches.filter(isNeedsRefresh).length,
  }), [pitches]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      {/* header */}
      <View style={styles.header}>
        <Pressable onPress={() => nav.goBack()} style={styles.back} hitSlop={10}>
          <Feather name="chevron-left" size={24} color={Colors.light.text} />
        </Pressable>
        <Text style={styles.title}>Pitches</Text>
        <View style={styles.back} />
      </View>

      {/* search */}
      <View style={styles.search}>
        <Feather name="search" size={16} color={Colors.light.textMuted} />
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search brands"
          placeholderTextColor={Colors.light.textMuted}
          style={styles.searchInput}
          autoCapitalize="none"
        />
      </View>

      {/* filter chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipScroll}
        contentContainerStyle={styles.chips}
      >
        {FILTERS.map((f) => {
          const on = filter === f.key;
          const count = f.key === "opened" ? counts.opened : f.key === "stale" ? counts.stale : 0;
          return (
            <Pressable key={f.key} onPress={() => setFilter(f.key)} style={[styles.chip, on && styles.chipOn]}>
              <Text style={[styles.chipTxt, on && styles.chipTxtOn]}>{f.label}</Text>
              {count > 0 ? <Text style={[styles.chipCt, on && styles.chipCtOn]}>{count}</Text> : null}
            </Pressable>
          );
        })}
      </ScrollView>

      <ScrollView
        contentContainerStyle={styles.grid}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} tintColor={Colors.light.primary} />}
      >
        {shown.length === 0 ? (
          <View style={styles.empty}>
            <Feather name="inbox" size={28} color={Colors.light.textMuted} />
            <Text style={styles.emptyTxt}>
              {pitches.length === 0 ? "No pitches yet." : "Nothing matches that."}
            </Text>
          </View>
        ) : (
          shown.map((p) => (
            <PitchDeckTile
              key={p.brandId}
              pitch={p}
              width={tileW}
              onPress={() => nav.navigate("PitchDetail", { brandId: p.brandId, brandName: p.brandName })}
            />
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm },
  back: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, textAlign: "center", fontFamily: Fonts.heading, fontSize: 18, fontWeight: "700", color: Colors.light.text },
  search: {
    flexDirection: "row", alignItems: "center", gap: 9, marginHorizontal: Spacing.xl, height: 44,
    borderRadius: 999, paddingHorizontal: 15, backgroundColor: Colors.light.backgroundDefault,
    borderWidth: 1, borderColor: Colors.light.borderLight,
  },
  searchInput: { flex: 1, fontFamily: Fonts.body, fontSize: 14, color: Colors.light.text, padding: 0 },
  // A horizontal ScrollView grows to fill the column on web unless told not to; the chips keep their own height.
  chipScroll: { flexGrow: 0 },
  chips: { gap: 7, paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md, alignItems: "center" },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7,
    borderWidth: 1, borderColor: Colors.light.border, backgroundColor: Colors.light.card,
  },
  chipOn: { backgroundColor: Colors.light.text, borderColor: Colors.light.text },
  chipTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 12, fontWeight: "600", color: Colors.light.textSecondary },
  chipTxtOn: { color: Colors.light.backgroundRoot },
  chipCt: { fontFamily: Fonts.bodyBold, fontSize: 10, fontWeight: "800", color: Colors.light.textMuted },
  chipCtOn: { color: Colors.light.backgroundRoot },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.lg, paddingHorizontal: Spacing.xl, paddingBottom: 40 },
  empty: { width: "100%", alignItems: "center", gap: 10, paddingVertical: 60 },
  emptyTxt: { fontFamily: Fonts.bodyMedium, fontSize: 14, color: Colors.light.textMuted },
});
