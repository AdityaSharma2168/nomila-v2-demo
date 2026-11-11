/** broadcast index — a scoreboard panel: giant volt M.I.A. score / max, a skewed red→volt meter, and the
 *  verdict. No tier chip (the legacy tier word is retired, owner decision 8 Oct 2026). */
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { BroadcastPanel, BcKicker, NarrativeNote } from "./Chrome";
import { RiseText, Rise, CountUp } from "../Chrome";
import { LinearGradient } from "expo-linear-gradient";
import Animated, { useAnimatedStyle, useSharedValue, withTiming, withDelay, Easing } from "react-native-reanimated";
import { BC } from "./theme";
import type { CardProps, IndexCardData } from "../types";

function ScoreMeter({ pct, active }: { pct: number; active: boolean }) {
  const w = useSharedValue(0);
  React.useEffect(() => {
    w.value = active
      ? withDelay(200, withTiming(Math.max(0, Math.min(100, pct)) / 100, { duration: 1100, easing: Easing.out(Easing.cubic) }))
      : withTiming(0, { duration: 120 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  const fill = useAnimatedStyle(() => ({ width: `${w.value * 100}%` }));
  return (
    <View style={styles.meter}>
      <Animated.View style={[styles.meterFillWrap, fill]}>
        <LinearGradient colors={[BC.redDeep, BC.red, BC.volt]} locations={[0, 0.55, 1]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
      </Animated.View>
    </View>
  );
}

export function BroadcastIndexCard({ data, active }: CardProps<IndexCardData>) {
  const pct = data.max ? (data.value / data.max) * 100 : 0;
  return (
    <BroadcastPanel active={active} bug="INDEX" contentStyle={styles.inner}>
      <View>
        <BcKicker delay={20}>{data.eyebrow}</BcKicker>
        <RiseText delay={90} style={styles.matchup}>
          M.I.A. — Nomila's read of her marketability, in a single number.
        </RiseText>
      </View>

      <View style={styles.megaWrap}>
        <Rise delay={150} style={styles.megaRow}>
          <CountUp value={data.value} active={active} style={styles.mega} />
          <Text style={styles.den}>/ {data.max}</Text>
        </Rise>
        <Rise delay={300} style={styles.meterLine}>
          <ScoreMeter pct={pct} active={active} />
          <View style={styles.scale}><Text style={styles.scaleN}>0</Text><Text style={styles.scaleN}>{data.max}</Text></View>
        </Rise>
        <NarrativeNote delay={380}>{data.verdict}</NarrativeNote>
      </View>
    </BroadcastPanel>
  );
}

const styles = StyleSheet.create({
  inner:   { paddingTop: 50, paddingBottom: 34 },
  matchup: { marginTop: 20, fontFamily: BC.cond, fontSize: 14, letterSpacing: 0.6, color: BC.mut, lineHeight: 19 },

  megaWrap: { marginTop: "auto" },
  megaRow:  { flexDirection: "row", alignItems: "baseline", gap: 10 },
  mega:     { fontFamily: BC.display, fontSize: 108, lineHeight: 148, includeFontPadding: false, textAlignVertical: "center", color: BC.volt, letterSpacing: 0.5 },
  den:      { fontFamily: BC.display, fontSize: 34, color: BC.faint },

  meterLine: { marginTop: 14 },

  meter:        { height: 14, backgroundColor: BC.track, overflow: "hidden", transform: [{ skewX: "-24deg" }] },
  meterFillWrap:{ position: "absolute", left: 0, top: 0, bottom: 0 },
  scale:        { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
  scaleN:       { fontFamily: BC.cond, fontSize: 12, letterSpacing: 1, color: BC.faint },

  foot: { marginTop: 24, fontFamily: BC.sans, fontSize: 13, lineHeight: 20, color: BC.mut, maxWidth: 280 },
});
