// Dark glass over a photo — the approved glass direction ("Icons and Glass", 20 Oct 2026): glass only on what floats
// (Studio's feed overlay and its Feed · Browse switch, Home's hero buttons). iOS: a real blur under a thin dark wash.
// Android: expo-blur draws a tinted stand-in, so the wash is stronger there. Reduce Transparency on: solid, no blur.

import React, { useEffect, useState } from "react";
import { AccessibilityInfo, Platform, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { Accent } from "../../constants/theme";

/** True while the OS asks for less transparency (iOS); false elsewhere or until known. */
export function useReduceTransparency(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceTransparencyEnabled?.().then((v) => { if (mounted) setOn(!!v); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.("reduceTransparencyChanged", (v: boolean) => setOn(!!v));
    return () => { mounted = false; sub?.remove?.(); };
  }, []);
  return on;
}

export function DarkGlass({ radius, style, children, testID, light }: {
  radius: number;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
  testID?: string;
  /** A lighter, clearer glass (buttons on a brand colour). */
  light?: boolean;
}) {
  const solid = useReduceTransparency();
  const wash = solid ? Accent.glassDarkSolid : light ? Accent.glassLight : Platform.OS === "android" ? Accent.glassDarkSolid : Accent.glassDark;
  return (
    <View style={[{ borderRadius: radius, borderWidth: StyleSheet.hairlineWidth, borderColor: Accent.glassEdge, overflow: "hidden" }, style]} testID={testID}>
      <View style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: "hidden" }]} pointerEvents="none">
        {solid ? null : <BlurView intensity={light ? 24 : 40} tint={light ? "light" : "dark"} style={StyleSheet.absoluteFill} />}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: wash }]} />
      </View>
      {children}
    </View>
  );
}
