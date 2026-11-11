/**
 * luxe achievements — "the record": one hero honor at size (Didone name, thin gold outline pill
 * for the year + badge, a muted serif detail line) over a quiet dated ledger. Gold is the only
 * accent; no icons, no chips — just hairlines and restraint.
 */
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { LuxeShell, LuxeEyebrow, LuxeHairline } from "./Chrome";
import { Rise, RiseText } from "../Chrome";
import { LX } from "./theme";
import type { CardProps, AchievementsCardData } from "../types";

export function LuxeAchievementsCard({ data, active }: CardProps<AchievementsCardData>) {
  const ledgerDelay = 340 + Math.min(data.entries.length, 5) * 55;
  return (
    <LuxeShell bg={data.bg} active={active} justify="flex-start" watermark>
      <LuxeEyebrow delay={20}>{data.eyebrow}</LuxeEyebrow>

      <RiseText delay={110} style={styles.heroName}>{data.heroEntry.name}</RiseText>

      {!!(data.heroEntry.year || data.heroEntry.badge) && (
        <Rise delay={180} style={styles.pill}>
          <Text style={styles.pillText}>
            {[data.heroEntry.year, data.heroEntry.badge].filter(Boolean).join("  ·  ")}
          </Text>
        </Rise>
      )}

      {!!data.heroEntry.detail && (
        <RiseText delay={240} style={styles.heroDetail}>{data.heroEntry.detail}</RiseText>
      )}

      <Rise delay={300}><LuxeHairline /></Rise>

      <View style={styles.ledger}>
        {data.entries.map((e, i) => (
          <Rise key={`${e.year}-${e.name}`} delay={340 + Math.min(i, 5) * 55} style={styles.row}>
            <Text style={styles.rowYear}>{e.year}</Text>
            <Text style={styles.rowName} numberOfLines={2}>{e.name}</Text>
            {!!e.level && <Text style={styles.rowLevel}>{e.level}</Text>}
          </Rise>
        ))}
      </View>

      {!!data.footnote && (
        <RiseText delay={ledgerDelay + 80} style={styles.foot}>{data.footnote}</RiseText>
      )}
    </LuxeShell>
  );
}

const styles = StyleSheet.create({
  heroName: {
    marginTop: 6,
    fontFamily: LX.didone,
    fontSize: 40,
    lineHeight: 50,
    includeFontPadding: false,
    color: LX.ivory,
    letterSpacing: 0.3,
  },
  pill: {
    alignSelf: "flex-start",
    marginTop: 16,
    borderWidth: 1,
    borderColor: LX.hair,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  pillText: {
    fontFamily: LX.sansMed,
    fontSize: 10,
    letterSpacing: 2,
    textTransform: "uppercase",
    color: LX.or,
  },
  heroDetail: {
    marginTop: 12,
    fontFamily: LX.didoneItalic,
    fontStyle: "italic",
    fontSize: 14,
    lineHeight: 20,
    color: LX.ivoryMut,
  },
  ledger: { marginTop: 4 },
  row: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: LX.hairDim,
  },
  rowYear: {
    width: 44,
    fontFamily: LX.sans,
    fontSize: 11,
    letterSpacing: 0.5,
    color: LX.champagne,
  },
  rowName: {
    flex: 1,
    fontFamily: LX.didone,
    fontSize: 15,
    lineHeight: 19,
    color: LX.ivory,
  },
  rowLevel: {
    fontFamily: LX.sans,
    fontSize: 8.5,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    color: LX.ivoryMut,
  },
  foot: {
    marginTop: 18,
    fontFamily: LX.sans,
    fontSize: 9.5,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    color: LX.ivoryMut,
  },
});
