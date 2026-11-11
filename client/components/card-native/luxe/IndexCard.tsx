/** luxe index — giant Didone M.I.A. score / max, gold meter, Jost verdict. No tier word (retired 8 Oct 2026). */
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { LuxeShell, LuxeEyebrow } from "./Chrome";
import { RiseText, Rise, AnimatedBar, CountUp } from "../Chrome";
import { LX } from "./theme";
import type { CardProps, IndexCardData } from "../types";

export function LuxeIndexCard({ data, active }: CardProps<IndexCardData>) {
  const pct = data.max ? (data.value / data.max) * 100 : 0;
  return (
    <LuxeShell bg={data.bg} active={active}>
      <LuxeEyebrow delay={20}>{data.eyebrow}</LuxeEyebrow>

      <Rise delay={140} style={styles.numRow}>
        <CountUp value={data.value} active={active} style={styles.num} />
        <Text style={styles.numSmall}>/ {data.max}</Text>
      </Rise>

      <Rise delay={300} style={styles.meterWrap}>
        <AnimatedBar pct={pct} color={LX.or} track="rgba(244,238,226,0.18)" active={active} height={2} />
        <View style={styles.scaleRow}>
          <Text style={styles.scale}>0</Text>
          <Text style={styles.scale}>{data.max}</Text>
        </View>
      </Rise>

      <RiseText delay={380} style={styles.lede}>{data.verdict}</RiseText>
    </LuxeShell>
  );
}

const styles = StyleSheet.create({
  numRow:   { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  num:      { fontFamily: LX.didone, fontSize: 96, lineHeight: 116, color: LX.ivory, includeFontPadding: false },
  numSmall: { fontFamily: LX.didoneItalic, fontStyle: "italic", fontSize: 24, color: LX.champagne, marginBottom: 14 },

  meterWrap: { marginTop: 18 },
  scaleRow:  { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
  scale:     { fontFamily: LX.sans, fontSize: 8.5, letterSpacing: 1.4, textTransform: "uppercase", color: LX.ivoryMut },

  lede: { marginTop: 14, fontFamily: LX.sans, fontSize: 12.5, letterSpacing: 1.6, lineHeight: 21, color: LX.ivoryDim },
});
