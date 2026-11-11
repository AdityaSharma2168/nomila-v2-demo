import React from "react";
import { View, Text, StyleSheet } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { Fonts, Colors } from "../../constants/theme";

/**
 * A small metric dial — the ring FILL is a value scaled against a sensible band (so a 2.5%
 * engagement rate reads as a meaningful arc, not a sliver), while the center shows the TRUE value.
 */
export function MetricRing({
  fillPct, display, label, color = Colors.light.primary, size = 100, stroke = 10,
}: {
  fillPct: number; display: string; label: string; color?: string; size?: number; stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, fillPct));
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
        <Text style={styles.val}>{display}</Text>
        <Text style={styles.lbl}>{label}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { position: "absolute", alignItems: "center" },
  val: { fontFamily: Fonts.heading, fontSize: 19, color: Colors.light.text },
  lbl: { fontFamily: Fonts.bodySemiBold, fontSize: 8.5, color: Colors.light.textMuted, letterSpacing: 0.6, textTransform: "uppercase", marginTop: 1 },
});
