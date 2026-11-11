// Concept 0.4 · Slice 2 "All eight areas" — explanation on demand. Canonical order, never sorted by score.
// Dimension numbers first appear here (O-3); an unknown area shows "—". Labels are State's conclusions as served, as
// words + a glyph: "A strength" / "A gap" / "Not enough evidence"; `neutral` gets no label (O-2). No colours per area
// (look B: the grey tile, an outlined chip, ink numbers).

import React from "react";
import { View, Text, ScrollView, SafeAreaView, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { MeStackParamList } from "../../navigation/MainTabNavigator";
import { useMeIntelligence } from "../../hooks/use-me-intelligence";
import { DIMENSIONS, dimensionIcon, dimensionName, dimensionScoreText, readDate, stateLabel } from "../../lib/myIntelligenceLogic";
import { StateGlyph } from "../../components/intelligence/Glyphs";
import { Card, Chip, StackHeader, IconTile } from "../../components/ui";
import { Bold, BoldType } from "../../constants/theme";

type NavProp = NativeStackNavigationProp<MeStackParamList, "IntelligenceAreas">;

const AREAS_COPY = { parent: "My Intelligence", title: "All eight areas" } as const;

export function IntelligenceAreasScreen() {
  const navigation = useNavigation<NavProp>();
  const q = useMeIntelligence();
  const a = q.data?.assessment ?? null;
  if (!a) {
    // Loading, or the read is no longer shown (withheld server-side): the landing carries that state's copy.
    return (
      <SafeAreaView style={styles.safe}>
        <StackHeader title={AREAS_COPY.parent} bold />
        <Text style={styles.title}>{AREAS_COPY.title}</Text>
        {q.data ? <Text style={[styles.lede, { padding: 20 }]}>Your read isn't available right now.</Text> : <ActivityIndicator style={{ marginTop: 20 }} color={Bold.ink} />}
      </SafeAreaView>
    );
  }
  const dims = DIMENSIONS.map((x) => a.dimensions.find((d) => d.key === x.key)).filter((d): d is NonNullable<typeof d> => !!d);
  return (
    <SafeAreaView style={styles.safe}>
      <StackHeader title={AREAS_COPY.parent} bold />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>{AREAS_COPY.title}</Text>
        <Text style={styles.lede}>From your read on {readDate(a.evidenceAsOf)}. Tap any area for Nomila's reasons and sources.</Text>
        <Card bold>
          {dims.map((d, i) => {
            const l = stateLabel(d.state);
            const n = dimensionScoreText(d);
            return (
              <Pressable
                key={d.key}
                style={({ pressed }) => [styles.row, i === dims.length - 1 && styles.last, pressed && styles.pressed]}
                onPress={() => navigation.navigate("IntelligenceArea", { key: d.key })}
                accessibilityRole="button"
                accessibilityLabel={`${dimensionName(d.key)}${l ? `, ${l.text}` : ""}, ${n === "—" ? "no score" : `${n} of 100`}`}
              >
                <IconTile icon={dimensionIcon(d.key) as React.ComponentProps<typeof Feather>["name"]} bold="grey" />
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={styles.name}>{dimensionName(d.key)}</Text>
                  {l ? <Chip bold="line" icon={<StateGlyph kind={l.glyph} />}>{l.text}</Chip> : null}
                </View>
                <Text style={[styles.num, n === "—" && styles.dash]}>{n}</Text>
                <Feather name="chevron-right" size={18} color={Bold.quiet} />
              </Pressable>
            );
          })}
        </Card>
        <Text style={styles.foot}>Scores are out of 100.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: Bold.paper },
  content: { paddingHorizontal: Bold.gutter, paddingBottom: 40, gap: 12 },
  title:   { ...BoldType.screenTitleSm, color: Bold.ink, paddingTop: 4, paddingHorizontal: 0 },
  lede:    { ...BoldType.lede, color: Bold.mute, marginTop: -4 },
  row:     { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: Bold.line },
  last:    { borderBottomWidth: 0 },
  pressed: { backgroundColor: Bold.ground },
  name:    { ...BoldType.rowTitle, color: Bold.ink },
  num:     { ...BoldType.goal, color: Bold.ink, minWidth: 34, textAlign: "right" },
  dash:    { color: Bold.quiet },
  foot:    { ...BoldType.caption, color: Bold.mute },
});
