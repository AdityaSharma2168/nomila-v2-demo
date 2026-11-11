/** broadcast achievements — "the record": one hero honor (prestige-ranked — the marquee credential,
 *  not just the highest level) at size, plus a dated ledger of the next few. Anton names/years,
 *  volt kicker tick, red badge chip. Mirrors broadcast.ts's .c-ach / .ach-hero / .ach-rows CSS. */
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { BroadcastPanel, BcKicker, BcChip, NarrativeNote } from "./Chrome";
import { Rise } from "../Chrome";
import { BC } from "./theme";
import type { CardProps, AchievementsCardData } from "../types";

export function BroadcastAchievementsCard({ data, active }: CardProps<AchievementsCardData>) {
  return (
    <BroadcastPanel active={active} bug="RECORD" watermark contentStyle={{ paddingTop: 50, paddingBottom: 34 }}>
      <BcKicker delay={10}>{data.eyebrow}</BcKicker>

      <Rise delay={80} style={styles.hero}>
        {!!data.heroEntry.badge && (
          <View style={styles.badgeWrap}>
            <BcChip tone="red">{data.heroEntry.badge}</BcChip>
          </View>
        )}
        <Text style={styles.heroName}>{data.heroEntry.name}</Text>
        <Text style={styles.heroMeta}>
          {[data.heroEntry.year, data.heroEntry.detail].filter(Boolean).join("  /  ")}
        </Text>
      </Rise>

      <View style={styles.rows}>
        {data.entries.map((e, i) => (
          <React.Fragment key={`${e.year}-${e.name}`}>
            {/* Explicit hairline divider (not a border) so the ledger rule renders as a consistent
                1px line across platforms/pixel densities. */}
            <View style={styles.divider} />
            <Rise delay={150 + Math.min(i, 3) * 60} style={styles.row}>
              <Text style={styles.rowYr}>{e.year}</Text>
              <Text style={styles.rowName} numberOfLines={2}>{e.name}</Text>
              {!!e.level && <Text style={styles.rowLevel} numberOfLines={1}>{e.level}</Text>}
            </Rise>
          </React.Fragment>
        ))}
        {data.entries.length > 0 && <View style={styles.divider} />}
      </View>

      <View style={styles.footWrap}>
        <NarrativeNote delay={150 + Math.min(data.entries.length, 4) * 60 + 60}>{data.footnote}</NarrativeNote>
      </View>
    </BroadcastPanel>
  );
}

const styles = StyleSheet.create({
  hero: { marginTop: 16 },
  badgeWrap: { marginBottom: 12 },
  heroName: {
    fontFamily: BC.display,
    fontSize: 34,
    lineHeight: 40,
    includeFontPadding: false,
    textAlignVertical: "center",
    textTransform: "uppercase",
    color: BC.paper,
    letterSpacing: 0.4,
  },
  heroMeta: {
    marginTop: 8,
    fontFamily: BC.cond,
    fontSize: 11,
    letterSpacing: 2,
    textTransform: "uppercase",
    color: BC.mut,
  },

  rows: { marginTop: 20 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: BC.line },
  row: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 10,
    paddingVertical: 9,
  },
  rowYr: {
    width: 40,
    fontFamily: BC.display,
    fontSize: 14,
    lineHeight: 16,
    includeFontPadding: false,
    textAlignVertical: "center",
    color: BC.faint,
  },
  rowName: { flex: 1, fontFamily: BC.sansMed, fontSize: 12, lineHeight: 16, color: BC.paper },
  rowLevel: {
    fontFamily: BC.cond,
    fontSize: 10,
    letterSpacing: 1.6,
    textTransform: "uppercase",
    color: BC.mut,
  },

  footWrap: { marginTop: "auto" },
});
