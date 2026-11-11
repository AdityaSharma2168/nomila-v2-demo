/**
 * Frost — the soft frosted-glass surface of the Ask Mila overlay (owner direction, 8 Oct 2026:
 * "much like Muse" — no dark circles, no outlined pill). Used for her name label under the
 * floating avatar and for the round top-bar buttons.
 *
 * iOS: a real blur (expo-blur, already in the native build — BrandDealCard uses it) under a thin
 * white wash, so it reads milky rather than clear. Android: expo-blur's default method draws a
 * translucent tint instead of blurring (the experimental Dimezis blur is left off — it is costly
 * over a playing video), so the white wash is a touch stronger there. No border, no ink outline:
 * the edge is only a very soft diffuse lift (iOS/web; Android's elevation draws a hard grey ring
 * around a translucent surface, so it gets none).
 */
import React from "react";
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { SOFT_LIFT } from "./softLift";

export { SOFT_LIFT };

const WASH = Platform.OS === "android" ? "rgba(255,255,255,0.72)" : "rgba(255,255,255,0.45)";

export function Frost({
  radius,
  style,
  children,
  testID,
}: {
  radius: number;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
  testID?: string;
}) {
  return (
    <View style={[SOFT_LIFT, { borderRadius: radius }, style]} testID={testID}>
      {/* The glass is clipped on its own layer so the lift (on the outer view) isn't clipped. */}
      <View style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: "hidden" }]} pointerEvents="none">
        <BlurView intensity={40} tint="light" style={StyleSheet.absoluteFill} testID="frost-blur" />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: WASH }]} />
      </View>
      {children}
    </View>
  );
}
