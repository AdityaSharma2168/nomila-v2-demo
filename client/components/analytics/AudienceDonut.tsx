import React from "react";
import { View, Text, StyleSheet } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { Fonts, Colors } from "../../constants/theme";

/**
 * Donut showing a single dominant share (e.g. primary gender %) over a track ring,
 * with the percentage + label centered. Pure react-native-svg, no chart lib.
 */
export function AudienceDonut({
  pct, label, size = 132, stroke = 14, color = Colors.light.primary,
}: {
  pct: number; label: string; size?: number; stroke?: number; color?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const dash = (clamped / 100) * c;

  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={Colors.light.border} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2} cy={size / 2} r={r}
          stroke={color} strokeWidth={stroke} fill="none" strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={styles.center}>
        <Text style={styles.pct}>{Math.round(clamped)}%</Text>
        <Text style={styles.label}>{label}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { position: "absolute", alignItems: "center" },
  pct:   { fontFamily: Fonts.display, fontSize: 28, color: Colors.light.text },
  label: { fontFamily: Fonts.bodySemiBold, fontSize: 10, color: Colors.light.textMuted, letterSpacing: 0.8, textTransform: "uppercase", marginTop: 2 },
});
