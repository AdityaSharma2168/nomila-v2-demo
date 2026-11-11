// Concept 0.4 · "Your platforms, measured" (DESIGN.md "Platforms measured", look B) — the measured level one tap under
// My Intelligence.
//
//   ‹ MY INTELLIGENCE, the title in display caps, the lede. One card per connected platform: the platform's mark
//   (ui/LogoMark — never a brand-colour tile), her handle, "as of <date>", three measured cells, and her audience as
//   plain bars (country · age · gender), each group captioned. A value the platform did not report says "not measured".
//   Nothing here is Nomila's opinion: no comparisons, no arrows, no tiers, no "× creator avg", no field names. Growth
//   (the existing analytics: reach, breakout posts, the follower history) sits behind one door at the foot.
//
// Reads GET /me/analytics (useAnalytics) and her connections (the handle); composition in lib/platformsMeasuredLogic.

import React from "react";
import { View, Text, ScrollView, SafeAreaView, StyleSheet, ActivityIndicator } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { toBrand } from "../../navigation/meNav";
import { useAnalytics } from "../../hooks/use-analytics";
import { useConnections } from "../../hooks/use-connections";
import { platformCards, type PlatformCard } from "../../lib/platformsMeasuredLogic";
import { Card, Row, StackHeader, IconTile, LogoMark } from "../../components/ui";
import { Bold, BoldType } from "../../constants/theme";

const COPY = {
  parent: "My Intelligence",
  title: "Your platforms, measured",
  lede: "What your connected accounts report, as measured, with the date of each reading. Nothing here is Nomila's opinion.",
  asOf: (d: string) => (d ? `as of ${d}` : ""),
  empty: "No readings yet. Connect an account and Nomila will take its first reading.",
  growth: { title: "Growth", meta: "Reach, breakout posts and the follower history, per platform" },
} as const;

export function PlatformsMeasuredScreen() {
  const navigation = useNavigation();
  const analytics = useAnalytics();
  const connections = useConnections();
  const cards = platformCards(analytics.platforms, connections.connections);

  return (
    <SafeAreaView style={styles.safe}>
      <StackHeader title={COPY.parent} bold />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>{COPY.title}</Text>
        <Text style={styles.lede}>{COPY.lede}</Text>
        {analytics.isLoading && !cards.length ? <ActivityIndicator style={{ marginTop: 20 }} color={Bold.ink} /> : null}
        {!analytics.isLoading && !cards.length ? <Text style={styles.empty} testID="platforms-empty">{COPY.empty}</Text> : null}
        {cards.map((c) => <PlatformCardView key={c.platform} card={c} />)}
        <Card bold style={styles.door}>
          <Row
            bold
            leading={<IconTile icon="activity" bold="black" />}
            value={COPY.growth.title} meta={COPY.growth.meta} last
            onPress={() => toBrand(navigation, "BrandOverview", { tab: "growth" })} accessibilityLabel={COPY.growth.title}
          />
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

function PlatformCardView({ card }: { card: PlatformCard }) {
  return (
    <Card bold style={styles.card} testID={`platform-${card.platform}`}>
      <View style={styles.head}>
        <LogoMark platform={card.platform} name={card.name} bold />
        <Text style={styles.handle} numberOfLines={1}>{card.handle ?? card.name}</Text>
        <Text style={styles.asOf} numberOfLines={2}>{card.handle ? `${card.name} · ` : ""}{COPY.asOf(card.asOf)}</Text>
      </View>
      <View style={styles.cells}>
        {card.cells.map((cell) => (
          <View key={cell.label} style={styles.cell} accessibilityLabel={`${cell.label}: ${cell.value}`}>
            <Text style={[styles.cellValue, !cell.measured && styles.cellNone]} numberOfLines={1} adjustsFontSizeToFit>{cell.value}</Text>
            <Text style={styles.cellLabel} numberOfLines={2}>{cell.label}</Text>
          </View>
        ))}
      </View>
      {card.distributions.map((d) => (
        <View key={d.title} style={styles.bars} accessibilityLabel={d.title}>
          <Text style={styles.barsTitle}>{d.title}</Text>
          {d.bars.map((b) => (
            <View key={b.key} style={styles.bar}>
              <Text style={styles.barKey} numberOfLines={1}>{b.key}</Text>
              <View style={styles.track}><View style={[styles.fill, { width: `${Math.max(0, Math.min(100, b.pct))}%` }]} /></View>
              <Text style={styles.barPct}>{b.pct}%</Text>
            </View>
          ))}
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  safe:      { flex: 1, backgroundColor: Bold.paper },
  content:   { paddingHorizontal: Bold.gutter, paddingBottom: 40, gap: 12 },
  title:     { ...BoldType.screenTitleSm, color: Bold.ink, paddingTop: 4 },
  lede:      { ...BoldType.lede, color: Bold.mute, marginTop: -4 },
  empty:     { ...BoldType.lede, color: Bold.mute },
  card:      { padding: 14, gap: 12 },
  head:      { flexDirection: "row", alignItems: "center", gap: 10 },
  handle:    { flexShrink: 1, ...BoldType.rowTitle, color: Bold.ink },
  asOf:      { flex: 1, ...BoldType.caption, color: Bold.mute, textAlign: "right" },
  cells:     { flexDirection: "row", gap: 8 },
  cell:      { flex: 1, backgroundColor: Bold.ground, borderRadius: Bold.radius.control, padding: 10, gap: 2 },
  cellValue: { ...BoldType.cellValue, color: Bold.ink },
  cellNone:  { ...BoldType.caption, color: Bold.quiet },
  cellLabel: { ...BoldType.caption, color: Bold.mute },
  bars:      { gap: 5 },
  barsTitle: { ...BoldType.caption, color: Bold.mute },
  bar:       { flexDirection: "row", alignItems: "center", gap: 8 },
  barKey:    { width: 92, ...BoldType.caption, color: Bold.ink2 },
  track:     { flex: 1, height: 6, borderRadius: 1, backgroundColor: Bold.ground, overflow: "hidden" },
  fill:      { height: 6, backgroundColor: Bold.ink },
  barPct:    { width: 34, textAlign: "right", ...BoldType.caption, fontWeight: "700", fontFamily: BoldType.rowTitle.fontFamily, color: Bold.ink },
  door:      {},
});
