// The brand book reader's motion — all drawn by the phone (or browser), $0, and all still under Reduce Motion
// ("Templates and motion" §5): a slow zoom on hero photos, lines that rise in as a page arrives, the score counting up,
// bars drawing in. Built on React Native's Animated (transform/opacity on the native driver; bar widths on JS).
import React, { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, type StyleProp, type ViewStyle, type ImageStyle } from "react-native";

/** True when the phone asks for reduced motion (kept live: the setting can change while the book is open). */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled?.().then((v) => { if (alive) setReduce(!!v); }).catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener?.("reduceMotionChanged", (v: boolean) => setReduce(!!v));
    return () => { alive = false; sub?.remove?.(); };
  }, []);
  return reduce;
}

/** 0 → 1 each time a page becomes the one on screen (1 at once under Reduce Motion). */
export function useArrival(active: boolean, reduce: boolean): Animated.Value {
  const v = useRef(new Animated.Value(active || reduce ? 1 : 0)).current;
  useEffect(() => {
    if (reduce) { v.setValue(1); return; }
    if (!active) { v.setValue(0); return; }
    v.setValue(0);
    const a = Animated.timing(v, { toValue: 1, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [active, reduce, v]);
  return v;
}

/** A line that rises in as its page arrives; `order` staggers lines down the page. */
export function Reveal({ arrival, order = 0, style, children }: { arrival: Animated.Value; order?: number; style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  const start = Math.min(0.6, order * 0.12);
  const t = arrival.interpolate({ inputRange: [0, start, Math.min(1, start + 0.4), 1], outputRange: [0, 0, 1, 1] });
  return (
    <Animated.View style={[style, { opacity: t, transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }] }]}>
      {children}
    </Animated.View>
  );
}

/** A hero photo that drifts closer, slowly, while its page is on screen (a still photo under Reduce Motion). */
export function KenBurns({ uri, active, reduce, style }: { uri: string; active: boolean; reduce: boolean; style?: StyleProp<ImageStyle> }) {
  const s = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reduce || !active) { s.setValue(1); return; }
    const a = Animated.timing(s, { toValue: 1.07, duration: 14000, easing: Easing.inOut(Easing.quad), useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [active, reduce, s]);
  return <Animated.Image source={{ uri }} resizeMode="cover" style={[style, { transform: [{ scale: s }] }]} accessibilityIgnoresInvertColors />;
}

/** A number that counts up to its value when its page arrives. */
export function useCountUp(target: number, active: boolean, reduce: boolean, duration = 1100): number {
  const [n, setN] = useState(reduce ? target : 0);
  useEffect(() => {
    if (reduce || !active) { setN(reduce ? target : 0); return; }
    const v = new Animated.Value(0);
    const id = v.addListener(({ value }) => setN(Math.round(value)));
    const a = Animated.timing(v, { toValue: target, duration, easing: Easing.out(Easing.cubic), useNativeDriver: false });
    a.start();
    return () => { a.stop(); v.removeListener(id); };
  }, [target, active, reduce, duration]);
  return n;
}

/** A bar that draws in to its share (0–100) when its page arrives. */
export function GrowBar({ pct, color, active, reduce, delay = 0, style }: { pct: number; color: string; active: boolean; reduce: boolean; delay?: number; style?: StyleProp<ViewStyle> }) {
  const w = useRef(new Animated.Value(reduce ? pct : 0)).current;
  useEffect(() => {
    if (reduce) { w.setValue(pct); return; }
    if (!active) { w.setValue(0); return; }
    const a = Animated.timing(w, { toValue: pct, duration: 900, delay, easing: Easing.out(Easing.cubic), useNativeDriver: false });
    a.start();
    return () => a.stop();
  }, [pct, active, reduce, delay, w]);
  return <Animated.View style={[style, { backgroundColor: color, width: w.interpolate({ inputRange: [0, 100], outputRange: ["0%", "100%"] }) }]} />;
}
