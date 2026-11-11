// Concept 0.4 · Slice 2 — one area's detail (Level 2), with prev / next in canonical order and the evidence sheet (Level 3).
//
//   Header      the grey tile, the position eyebrow, the name in display caps, "86 of 100" (or "—"), State's label in
//               words + glyph
//   Reasoning   `rationale` verbatim, labelled "Nomila's interpretation" (O-11); S7 copy on an older row
//   How sure    the area's level in words (O-8) + `confidenceReason` verbatim
//   Looked at   components: label + status chip + rationale; never a component value (O-4)
//   Goals       her goals whose served `buildsOn` names this area (O-7 label)
//   Sources ›   the evidence sheet, grouped by the server's citation-strength buckets (O-5); a cite that does not support
//               the read is never shown or counted

import React, { useState } from "react";
import { View, Text, ScrollView, SafeAreaView, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { MeStackParamList } from "../../navigation/MainTabNavigator";
import { useMeIntelligence } from "../../hooks/use-me-intelligence";
import {
  COPY, DIMENSIONS, componentLabel, confidenceWord, dimensionIcon, dimensionName, dimensionPosition, dimensionScoreText,
  evidenceClassLabel, goalsFor, stateLabel, supportingSourceCount,
} from "../../lib/myIntelligenceLogic";
import { StateGlyph } from "../../components/intelligence/Glyphs";
import { EvidenceSheet } from "../../components/intelligence/EvidenceSheet";
import { Card, Button, Chip, StackHeader, IconTile, Eyebrow } from "../../components/ui";
import { Bold, BoldType } from "../../constants/theme";

type NavProp = NativeStackNavigationProp<MeStackParamList, "IntelligenceArea">;
type Feathers = React.ComponentProps<typeof Feather>["name"];

const AREA_COPY = {
  header: "My Intelligence",
  position: (pos: number, of: number) => `${pos} of ${of}`,
  howSure: "How sure",
  lookedAt: "What Nomila looked at",
  goals: "Your goals that build on this",
  unavailable: "Your read isn't available right now.",
} as const;

export function IntelligenceAreaScreen() {
  const navigation = useNavigation<NavProp>();
  const route = useRoute<RouteProp<MeStackParamList, "IntelligenceArea">>();
  const q = useMeIntelligence();
  const v = q.data;
  const a = v?.assessment ?? null;
  const d = a?.dimensions.find((x) => x.key === route.params.key) ?? null;
  const [sources, setSources] = useState(false);

  if (!v || !a || !d) {
    return (
      <SafeAreaView style={styles.safe}>
        <StackHeader title={AREA_COPY.header} bold />
        {v ? <Text style={[styles.body, { padding: 20 }]}>{AREA_COPY.unavailable}</Text> : <ActivityIndicator style={{ marginTop: 20 }} color={Bold.ink} />}
      </SafeAreaView>
    );
  }

  const pos = dimensionPosition(d.key);
  const go = (delta: number) => {
    const next = DIMENSIONS[(pos - 1 + delta + DIMENSIONS.length) % DIMENSIONS.length];
    navigation.setParams({ key: next.key });
  };
  const l = stateLabel(d.state);
  const n = dimensionScoreText(d);
  const goals = goalsFor(v, d.key);
  const count = supportingSourceCount(d.sources);
  const conf = confidenceWord(d.confidence);

  return (
    <SafeAreaView style={styles.safe}>
      <StackHeader
        title={AREA_COPY.header}
        bold
        right={
          <View style={styles.nav}>
            <Pressable onPress={() => go(-1)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Previous area"><Feather name="chevron-up" size={20} color={Bold.ink} /></Pressable>
            <Pressable onPress={() => go(1)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Next area"><Feather name="chevron-down" size={20} color={Bold.ink} /></Pressable>
          </View>
        }
      />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.head}>
          <IconTile icon={dimensionIcon(d.key) as Feathers} size={44} bold="grey" />
          <View style={{ flex: 1 }}>
            <Eyebrow>{AREA_COPY.position(pos, DIMENSIONS.length)}</Eyebrow>
            <Text style={styles.title}>{dimensionName(d.key)}</Text>
          </View>
        </View>
        <View style={styles.scoreRow}>
          <Text style={[styles.big, n === "—" && { color: Bold.quiet }]}>{n}</Text>
          {n !== "—" ? <Text style={styles.of}>of 100</Text> : null}
          {l ? <Chip bold="line" icon={<StateGlyph kind={l.glyph} />}>{l.text}</Chip> : null}
        </View>

        <View style={styles.hr} />
        {d.state === "unknown" ? <Text style={[styles.body, { marginBottom: 16 }]}>{COPY.unknownDetail}</Text> : null}

        {/* An unknown area with no reasoning says only the unknown copy above. */}
        {d.state === "unknown" && a.hasReasons && !d.rationale ? null : (
          <>
            <Eyebrow style={styles.sh}>{COPY.interpretation}</Eyebrow>
            {a.hasReasons && d.rationale ? (
              <>
                <Text style={styles.rationale}>{d.rationale}</Text>
                <Text style={styles.quiet}>{COPY.interpretationNote}</Text>
              </>
            ) : <Text style={styles.body}>{a.hasReasons ? "Nomila didn't record reasoning for this area." : COPY.reasonsNotSaved}</Text>}
          </>
        )}

        {conf ? (
          <>
            <Eyebrow style={[styles.sh, styles.gap]}>{AREA_COPY.howSure}</Eyebrow>
            <View style={styles.stateLine}>
              <Feather name="eye" size={16} color={Bold.mute} style={styles.stateIcon} />
              <Text style={styles.body}>{conf}.{d.confidenceReason ? ` "${d.confidenceReason}"` : ""}</Text>
            </View>
          </>
        ) : null}

        {d.components.length ? (
          <>
            <Eyebrow style={[styles.sh, styles.gap]}>{AREA_COPY.lookedAt}</Eyebrow>
            <Card bold>
              {d.components.map((c, i) => (
                <View key={c.key || i} style={[styles.comp, i === d.components.length - 1 && styles.last]}>
                  <View style={styles.compHead}>
                    <Text style={styles.compName}>{componentLabel(c.key)}</Text>
                    <Chip bold="line">{evidenceClassLabel(c.evidenceClass)}</Chip>
                  </View>
                  {c.rationale ? <Text style={styles.compWhy}>{c.rationale}</Text> : null}
                  {c.sources.length ? <Text style={styles.quiet}>{c.sources.length} {c.sources.length === 1 ? "source" : "sources"}</Text> : null}
                </View>
              ))}
            </Card>
          </>
        ) : null}

        {goals.length ? (
          <>
            <Eyebrow style={[styles.sh, styles.gap]}>{AREA_COPY.goals}</Eyebrow>
            <Card bold>
              {goals.map((g, i) => g.kind === "goal" ? (
                <View key={g.objectiveId} style={[styles.comp, i === goals.length - 1 && styles.last]}>
                  <Text style={styles.compName}>{g.title}</Text>
                  {g.earlier ? <Text style={styles.quiet}>{g.earlier}</Text> : null}
                </View>
              ) : null)}
            </Card>
          </>
        ) : null}

        <Button bold="small" onPress={() => setSources(true)} style={styles.sourcesBtn}>{a.hasReasons ? `Sources (${count})` : "Sources"}</Button>
      </ScrollView>

      {sources ? (
        <EvidenceSheet
          title={`Sources for ${dimensionName(d.key)}`}
          readOn={a.evidenceAsOf}
          sources={d.sources}
          evidence={a.evidence}
          hasReasons={a.hasReasons}
          onClose={() => setSources(false)}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:      { flex: 1, backgroundColor: Bold.paper },
  content:   { paddingHorizontal: Bold.gutter, paddingBottom: 40 },
  nav:       { flexDirection: "row", gap: 6 },
  head:      { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 4 },
  title:     { ...BoldType.screenTitleSm, color: Bold.ink },
  scoreRow:  { flexDirection: "row", alignItems: "baseline", gap: 10, marginTop: 12 },
  big:       { ...BoldType.bigNumber, color: Bold.ink },
  of:        { ...BoldType.caption, color: Bold.mute },
  hr:        { height: 2, backgroundColor: Bold.ink, marginVertical: 16 },
  sh:        { marginBottom: 8 },
  gap:       { marginTop: 20 },
  body:      { flex: 1, ...BoldType.body, color: Bold.ink2 },
  rationale: { ...BoldType.body, color: Bold.ink, borderLeftWidth: 2, borderLeftColor: Bold.line, paddingLeft: 10 },
  quiet:     { ...BoldType.caption, color: Bold.mute, marginTop: 6 },
  stateLine: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  stateIcon: { marginTop: 4 },
  comp:      { paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: Bold.line },
  last:      { borderBottomWidth: 0 },
  compHead:  { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  compName:  { flex: 1, ...BoldType.rowTitle, color: Bold.ink },
  compWhy:   { ...BoldType.lede, color: Bold.ink2, marginTop: 4 },
  sourcesBtn:{ alignSelf: "flex-start", marginTop: 20 },
});
