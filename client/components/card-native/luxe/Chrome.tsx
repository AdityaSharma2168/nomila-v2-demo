/**
 * luxe primitives — the couture "plate" (photo + cinematic grade scrims + hairline frame + a
 * per-card ScrollView) and the eyebrow/hairline bits. Reuses the theme-agnostic stagger logic
 * (Rise / useRiseKey) from the campaign Chrome; only the look is luxe. Mirrors luxe.ts's .card /
 * .grade / .frame / .content / .eyebrow / .hairline CSS.
 */
import React from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Animated from "react-native-reanimated";
import { Rise, useRiseKey, RingsWatermark } from "../Chrome";
import { LX } from "./theme";

const TOP_SCRIM: [string, string, string]              = ["rgba(12,10,7,0.58)", "rgba(12,10,7,0.12)", "rgba(12,10,7,0)"];
const BOT_SCRIM: [string, string, string, string]      = ["rgba(12,10,7,0)", "rgba(12,10,7,0.42)", "rgba(12,10,7,0.74)", "rgba(8,6,4,0.98)"];

export function LuxeShell({
  bg, active, justify = "flex-end", watermark, children,
}: {
  bg?: string | null;
  active?: boolean;
  justify?: "flex-end" | "flex-start";
  /** The faint champagne rings watermark (the Nomila mark treatment, every look — 23 Oct 2026). */
  watermark?: boolean;
  children: React.ReactNode;
}) {
  const playKey = useRiseKey(active ?? true);
  return (
    <View style={styles.card}>
      {bg
        ? <Image source={{ uri: bg }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        : <View style={[StyleSheet.absoluteFill, styles.noir]} />}
      <LinearGradient colors={TOP_SCRIM} locations={[0, 0.22, 0.4]} style={StyleSheet.absoluteFill} pointerEvents="none" />
      <LinearGradient colors={BOT_SCRIM} locations={[0.3, 0.48, 0.66, 1]} style={StyleSheet.absoluteFill} pointerEvents="none" />
      <View style={styles.frame} pointerEvents="none" />
      {watermark ? <RingsWatermark color={LX.champagne} opacity={0.24} /> : null}
      <Animated.ScrollView
        style={StyleSheet.absoluteFill}
        contentContainerStyle={[styles.content, { justifyContent: justify }]}
        showsVerticalScrollIndicator={false}
        bounces
      >
        <View key={playKey} style={styles.riseWrap}>{children}</View>
      </Animated.ScrollView>
    </View>
  );
}

export function LuxeEyebrow({ children, delay = 40 }: { children: React.ReactNode; delay?: number }) {
  return (
    <Rise delay={delay} style={styles.eyebrowRow}>
      <View style={styles.eyebrowDash} />
      <Text style={styles.eyebrowText} numberOfLines={1}>{children}</Text>
    </Rise>
  );
}

export function LuxeHairline() {
  return <View style={styles.hairline} />;
}

const styles = StyleSheet.create({
  card: { flex: 1, borderRadius: 24, overflow: "hidden", backgroundColor: LX.noir },
  noir: { backgroundColor: LX.noir },
  frame: {
    position: "absolute", top: 11, left: 11, right: 11, bottom: 11,
    borderRadius: 18, borderWidth: 1, borderColor: LX.hairDim,
  },
  content: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 44, paddingBottom: 30 },
  riseWrap: { width: "100%" },

  eyebrowRow:  { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 },
  eyebrowDash: { width: 26, height: 1, backgroundColor: LX.hair },
  eyebrowText: { fontFamily: LX.sans, fontSize: 9, letterSpacing: 3.4, textTransform: "uppercase", color: LX.or },

  hairline: { width: "100%", height: 1, backgroundColor: LX.hair, opacity: 0.7, marginVertical: 14 },
});
