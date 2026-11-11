/**
 * MilaHeader — Mila floating at the top centre of the Ask Mila overlay, the whole time: her
 * avatar, and under it a soft frosted-glass label — just "Mila" when she's free, and two lines
 * while she works ("Mila" / "Generating…"); screen readers hear "Mila: Generating…".
 *
 * Look (owner direction 8 Oct 2026, "much like Muse"; DESIGN.md §16 records the exception): no ring
 * or dark edge on her circle — only a very soft lift; no outlined pill — a frosted label (Frost);
 * nothing outlined in ink.
 *
 * It floats OVER the transcript (absolute, owned by the overlay's body), so messages scroll
 * underneath it: behind her the transcript is blurred (iOS) under a translucent cream wash that
 * fades to clear at the header's foot, so text slides under her softly instead of colliding. It
 * takes no touches (pointerEvents "none") — drags on it still scroll the transcript, and the top
 * bar's buttons sit above it, outside its box.
 *
 * Size: large (96) on the empty state and while voice is live, smaller (64) in a typed
 * conversation — eased between the two, or snapped when the OS asks for reduced motion.
 *
 * Accessibility: one element whose label is the status. Android announces changes politely
 * through the live region; iOS has no live regions, so it announces only the step from idle into
 * work (once per reply) — the held activity already caps how often anything changes at all.
 */
import React, { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { BlurView } from "expo-blur";
import { Frost, SOFT_LIFT } from "./Frost";
import { MilaAvatar } from "./MilaAvatar";
import { ACTIVITY_AVATAR, ACTIVITY_LABEL, type MilaActivity } from "./milaActivity";
import { N, oppsFont } from "../deals/opps/tokens";

export const HEADER_AVATAR_LARGE = 96;
export const HEADER_AVATAR_SMALL = 64;
/** How far the backdrop's fade runs past the label, so text eases out rather than cutting off. */
const FADE = 28;

export function MilaHeader({
  activity,
  compact,
  active,
  onHeight,
  announce = true,
}: {
  /** What she's doing — already held (useHeldActivity), so it doesn't flicker. */
  activity: MilaActivity;
  /** true in a typed conversation: the smaller size (the overlay keeps her large while voice is live). */
  compact: boolean;
  /** false while the overlay is closed: her loop pauses. */
  active: boolean;
  /** The header's height without the fade — the transcript pads its top by this. */
  onHeight?: (h: number) => void;
  /** iOS: say the label once when she starts working (default). Chat v2 speaks its own status line instead. */
  announce?: boolean;
}) {
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => { if (mounted) setReduceMotion(v); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => { mounted = false; sub.remove(); };
  }, []);

  // Size is animated on the JS driver (width/height can't go native); the avatar itself renders
  // once at the large size and is scaled, so the video never re-lays out mid-ease.
  const size = useRef(new Animated.Value(compact ? HEADER_AVATAR_SMALL : HEADER_AVATAR_LARGE)).current;
  useEffect(() => {
    const to = compact ? HEADER_AVATAR_SMALL : HEADER_AVATAR_LARGE;
    if (reduceMotion) { size.setValue(to); return undefined; }
    const anim = Animated.timing(size, {
      toValue: to,
      duration: 250, // DESIGN.md §7 "normal"
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    anim.start();
    return () => anim.stop();
  }, [compact, reduceMotion, size]);
  const scale = size.interpolate({
    inputRange: [HEADER_AVATAR_SMALL, HEADER_AVATAR_LARGE],
    outputRange: [HEADER_AVATAR_SMALL / HEADER_AVATAR_LARGE, 1],
  });

  const label = ACTIVITY_LABEL[activity];

  // iOS: say it once when she starts working on something; never per step.
  const prevRef = useRef<MilaActivity>(activity);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = activity;
    if (Platform.OS !== "ios" || !active || !announce) return;
    if (prev === "idle" && activity !== "idle") AccessibilityInfo.announceForAccessibility(label);
  }, [activity, active, label, announce]);

  // The inner height also places the backdrop's blur and where its wash starts to fade.
  const [innerH, setInnerH] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    setInnerH(h);
    onHeight?.(h);
  };
  const working = activity !== "idle";
  // Where the fade starts, as a fraction of the whole backdrop (inner + FADE).
  const fadeFrom = innerH > 0 ? innerH / (innerH + FADE) : 0.78;

  return (
    <View style={styles.wrap} pointerEvents="none" testID="mila-header">
      {/* Behind her: the transcript blurred (iOS; a light tint on Android) down to the label's foot… */}
      {innerH > 0 ? (
        <BlurView intensity={14} tint="light" style={[styles.blur, { height: innerH }]} testID="mila-header-blur" />
      ) : null}
      {/* …under a translucent cream wash that eases to clear, hiding the blur's lower edge. */}
      <LinearGradient
        colors={["rgba(255,255,255,0.86)", "rgba(255,255,255,0.66)", "rgba(255,255,255,0)" /* the white ground */]}
        locations={[0, fadeFrom, 1]}
        style={StyleSheet.absoluteFill}
      />
      <View
        style={styles.inner}
        onLayout={onLayout}
        accessible
        accessibilityRole="text"
        accessibilityLabel={working ? `Mila: ${label}` : label}
        accessibilityLiveRegion="polite"
        testID="mila-header-status"
      >
        <Animated.View style={[styles.avatarBox, { width: size, height: size }]}>
          <Animated.View style={[styles.avatarLift, { transform: [{ scale }] }]}>
            <MilaAvatar state={ACTIVITY_AVATAR[activity]} size={HEADER_AVATAR_LARGE} active={active} />
          </Animated.View>
        </Animated.View>
        <Frost radius={working ? 16 : 14} style={[styles.label, working && styles.labelWorking]} testID="mila-label">
          <Text style={styles.name} numberOfLines={1} testID="mila-name">Mila</Text>
          {working ? (
            <Text style={styles.status} numberOfLines={1} testID="mila-status">{label}</Text>
          ) : null}
        </Frost>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingBottom: FADE,
  },
  blur: { position: "absolute", top: 0, left: 0, right: 0 },
  inner: { alignItems: "center", paddingTop: 4, paddingBottom: 6 },
  // Centres the large avatar inside the animated box; the overflow is the scaled-away margin.
  avatarBox: { alignItems: "center", justifyContent: "center", overflow: "visible" },
  // No ring, no dark edge: a plain circle with only a very soft lift (iOS/web — see Frost for why
  // Android gets none). The lift sits on this outer circle because the avatar clips itself to its
  // circle. The cream fill shows for the instant before her first frame.
  avatarLift: {
    width: HEADER_AVATAR_LARGE,
    height: HEADER_AVATAR_LARGE,
    borderRadius: HEADER_AVATAR_LARGE / 2,
    backgroundColor: N.cream100,
    ...SOFT_LIFT,
  },
  label: {
    marginTop: 8,
    minHeight: 28,
    paddingHorizontal: 14,
    paddingVertical: 5,
    alignItems: "center",
    justifyContent: "center",
  },
  labelWorking: { paddingVertical: 6, paddingHorizontal: 16 },
  name: {
    fontFamily: oppsFont(700),
    fontSize: 13,
    color: N.ink900,
  },
  status: {
    marginTop: 1,
    fontFamily: oppsFont(400),
    fontSize: 12,
    color: N.ink500,
  },
});
