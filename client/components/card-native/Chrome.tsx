/**
 * card-native — the shared primitives every look composes: the rise stagger, animated meters/counters, the photo
 * backdrop + scrim, the Nomila mark (and its cardmark lockup) and the rings watermark. `T` holds the dark-editorial
 * tokens the first look (the retired "campaign") was drawn in; the editor sheet, the mini tiles and the Luxe and
 * Broadcast looks still read some of them. The looks themselves live in nomila/, luxe/ and broadcast/.
 *
 * Font note: the real display faces are now loaded (App.tsx). `T.displayItalic` (Archivo Narrow
 * Bold Italic) is the condensed-black-italic "mega" treatment; `T.serifFamily` (Instrument Serif
 * Italic) is the serif tagline. Both ARE italic faces — never pair them with fontStyle:"italic".
 */
import React, { useEffect, useState } from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import Svg, { Circle as SvgCircle, Path as SvgPath } from "react-native-svg";
import { LinearGradient } from "expo-linear-gradient";
import Animated, {
  FadeInUp,
  Easing,
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
} from "react-native-reanimated";
import { Fonts } from "../../constants/theme";

// ─── Tokens (campaign :root vars) ───────────────────────────────────────────────
export const T = {
  ink: "#0C0D10",
  ink2: "#16181D",
  // One look: the card's ink on black is white (was a cream "bone").
  bone: "#FFFFFF",
  boneDim: "rgba(255,255,255,0.62)",
  cardinal: "#E0243E",
  cardinalDeep: "#9E1226",
  line: "rgba(255,255,255,0.16)",
  radius: 24,
  // Real display faces (loaded in App.tsx). The campaign look is condensed-black-italic — Archivo
  // Narrow Bold, the closest static match to the web's font-stretch:62.5%/900 Archivo — over
  // Instrument Serif italic taglines. `serifFamily` and `displayItalic` ARE the italic faces, so
  // styles using them must NOT also set fontStyle:"italic" (real italic + faux-slant = mangled).
  display:       "ArchivoNarrow_700Bold",
  displayItalic: "ArchivoNarrow_700Bold_Italic",
  serif:         "InstrumentSerif_400Regular",
  serifFamily:   "InstrumentSerif_400Regular_Italic",
};

// ─── Rise stagger: content remounts (bumping `playKey`) whenever a card becomes active, which
//     replays every child's `entering` animation — reanimated's entering/exiting only fires on
//     mount, native + web/RNW both. Same trick as the RNW spike. ──
export function useRiseKey(active: boolean): number {
  const [key, setKey] = useState(0);
  useEffect(() => {
    if (active) setKey((k) => k + 1);
  }, [active]);
  return key;
}

const riseEnter = (delay: number) => FadeInUp.delay(delay).springify().damping(17).mass(0.7);

export function Rise({
  delay = 0,
  style,
  children,
}: {
  delay?: number;
  style?: any;
  children: React.ReactNode;
}) {
  return <Animated.View entering={riseEnter(delay)} style={style}>{children}</Animated.View>;
}

export function RiseText({ delay = 0, style, children }: { delay?: number; style?: any; children: React.ReactNode }) {
  return <Animated.Text entering={riseEnter(delay)} style={style}>{children}</Animated.Text>;
}

// ─── Kicker — the eyebrow row with the cardinal dash (".kicker::before") ────────
export function Kicker({ children, delay = 0, style }: { children: React.ReactNode; delay?: number; style?: any }) {
  return (
    <Rise delay={delay} style={[styles.kickerRow, style]}>
      <View style={styles.kickerDash} />
      <Text style={styles.kickerText} numberOfLines={1}>{children}</Text>
    </Rise>
  );
}

// ─── The official Nomila mark — four concentric arcs (facets) over faint tracks, one origin.
//     Faithful port of the web themes' NOMILA_MARK SVG (the landing-page logo). `track` inks the faint tracks for
//     the ground the mark sits on (white on a photo or black, ink on the Nomila look's white). ──
export function NomilaMark({ size = 26, track = T.bone, trackOpacity = 0.1 }: { size?: number; track?: string; trackOpacity?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 112 112" fill="none">
      <SvgCircle cx={56} cy={56} r={50} stroke={track} strokeWidth={4} strokeOpacity={trackOpacity} />
      <SvgCircle cx={56} cy={56} r={38} stroke={track} strokeWidth={4} strokeOpacity={trackOpacity} />
      <SvgCircle cx={56} cy={56} r={26} stroke={track} strokeWidth={4} strokeOpacity={trackOpacity} />
      <SvgCircle cx={56} cy={56} r={14} stroke={track} strokeWidth={4} strokeOpacity={trackOpacity} />
      <SvgPath d="M 17.7 88.14 A 50 50 0 1 1 99.3 31.0"   stroke="#2D8EFF" strokeWidth={5} strokeLinecap="round" fill="none" />
      <SvgPath d="M 26.89 80.43 A 38 38 0 1 1 93.42 62.6" stroke="#2DC87C" strokeWidth={5} strokeLinecap="round" fill="none" />
      <SvgPath d="M 36.08 72.71 A 26 26 0 1 1 72.71 75.92" stroke="#E84591" strokeWidth={5} strokeLinecap="round" fill="none" />
      <SvgPath d="M 45.28 65.0 A 14 14 0 1 1 56.0 70.0"   stroke="#E8A215" strokeWidth={5} strokeLinecap="round" fill="none" />
    </Svg>
  );
}

// ─── The faint rings watermark — the mark's four tracks, large, bleeding off the card's top-right corner, behind
//     the text-led cards. Every look carries it (owner, 23 Oct 2026) in its own palette: ink on Nomila's white,
//     champagne on Luxe, paper white on Broadcast. Non-interactive; sits under the card's content. ──
export function RingsWatermark({ color, opacity, size = 330 }: { color: string; opacity: number; size?: number }) {
  return (
    <View pointerEvents="none" style={[styles.watermark, { width: size, height: size, right: -size * 0.36, top: -size * 0.3 }]}>
      <Svg width={size} height={size} viewBox="0 0 112 112" fill="none">
        {[50, 38, 26, 14].map((r) => (
          <SvgCircle key={r} cx={56} cy={56} r={r} stroke={color} strokeWidth={1.4} strokeOpacity={opacity} />
        ))}
      </Svg>
    </View>
  );
}

// ─── Cardmark — the mark + a spaced label ("Nomi Card"), the cover's top-left brand lockup
//     (".cardmark" on the web). This is the brand signature; it replaces the old text-only
//     "Athlete Media Kit" strip. ──
export function CardMark({ label = "Nomi Card", size = 26 }: { label?: string; size?: number }) {
  return (
    <View style={styles.cardmark}>
      <NomilaMark size={size} />
      <Text style={styles.cardmarkLabel}>{label}</Text>
    </View>
  );
}

// ─── Serif-italic tagline line (".serif-line") ──────────────────────────────────
export function SerifLine({ delay = 0, style, children }: { delay?: number; style?: any; children: React.ReactNode }) {
  return <RiseText delay={delay} style={[styles.serifLine, style]}>{children}</RiseText>;
}

// ─── Chip (".chip" / ".chip.red") ───────────────────────────────────────────────
export function Chip({ children, tone = "line", style }: { children: React.ReactNode; tone?: "line" | "red"; style?: any }) {
  return (
    <View style={[styles.chip, tone === "red" && styles.chipRed, style]}>
      <Text style={[styles.chipText, tone === "red" && styles.chipTextRed]}>{children}</Text>
    </View>
  );
}

// ─── Backdrop — photo + scrim, or the photo-less "atmosphere" fallback (".atmo") ─
const SCRIM_STOPS: Record<string, { colors: [string, string, ...string[]]; locations: [number, number, ...number[]] }> = {
  bottom: { colors: ["rgba(12,13,16,0.5)", "rgba(12,13,16,0)", "rgba(12,13,16,0)", "rgba(12,13,16,0.72)", "rgba(12,13,16,0.97)"], locations: [0, 0.22, 0.34, 0.6, 1] },
  heavy:  { colors: ["rgba(12,13,16,0.72)", "rgba(12,13,16,0.82)", "rgba(12,13,16,0.94)"], locations: [0, 0.45, 1] },
  index:  { colors: ["rgba(12,13,16,0.55)", "rgba(12,13,16,0.28)", "rgba(12,13,16,0.66)", "rgba(12,13,16,0.96)"], locations: [0, 0.34, 0.68, 1] },
};
export type ScrimVariant = keyof typeof SCRIM_STOPS;

export function Backdrop({ uri, scrim = "heavy" }: { uri?: string | null; scrim?: ScrimVariant }) {
  if (!uri) {
    return (
      <View style={StyleSheet.absoluteFill}>
        <View style={[StyleSheet.absoluteFill, { backgroundColor: T.ink }]} />
        <LinearGradient
          colors={["rgba(224,36,62,0.16)", "rgba(224,36,62,0)"]}
          start={{ x: 0.88, y: -0.1 }}
          end={{ x: 0.2, y: 0.65 }}
          style={StyleSheet.absoluteFill}
        />
      </View>
    );
  }
  const stops = SCRIM_STOPS[scrim];
  return (
    <View style={StyleSheet.absoluteFill}>
      <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
      <LinearGradient colors={stops.colors} locations={stops.locations} style={StyleSheet.absoluteFill} />
    </View>
  );
}

// ─── The card frame every card type renders inside: fixed-size, rounded, with a per-card
//     ScrollView so tall content (payments/story/achievements) scrolls INSTEAD OF CLIPPING —
//     the founder's #1 WebView-poster bug. The backdrop sits behind the ScrollView (untouched
//     by scrolling); `justify` controls whether short content pins to the bottom (photo-led
//     cards) or flows from the top (list-led cards). ──
export function CardShell({
  bg,
  scrim = "heavy",
  justify = "flex-end",
  active,
  children,
  contentStyle,
  topLeft,
}: {
  bg?: string | null;
  scrim?: ScrimVariant;
  justify?: "flex-end" | "flex-start";
  /** When given, the whole content subtree remounts each time this flips true — replaying every
   *  child's `entering` (rise) animation, so the stagger plays again on every swipe-in, not just
   *  the deck's first paint. Omit for cards that manage their own remount (e.g. AudienceCard). */
  active?: boolean;
  children: React.ReactNode;
  contentStyle?: any;
  /** A node pinned top-left over the backdrop, OUTSIDE the scroll flow (non-interactive) —
   *  the cover's Nomila cardmark lives here (web `.cardmark` is `position:absolute; top; left`). */
  topLeft?: React.ReactNode;
}) {
  const playKey = useRiseKey(active ?? true);
  return (
    <View style={styles.shell}>
      <Backdrop uri={bg} scrim={scrim} />
      <Animated.ScrollView
        style={StyleSheet.absoluteFill}
        contentContainerStyle={[styles.shellContent, { justifyContent: justify }, contentStyle]}
        showsVerticalScrollIndicator={false}
        bounces
      >
        <View key={playKey} style={styles.riseWrap}>{children}</View>
      </Animated.ScrollView>
      {topLeft ? <View style={styles.shellTopLeft} pointerEvents="none">{topLeft}</View> : null}
    </View>
  );
}

// ─── Animated fill bar (index meter / mix bars / audience geo / rate range) ─────
export function AnimatedBar({
  pct,
  color = T.bone,
  track = "rgba(255,255,255,0.14)",
  active,
  delay = 0,
  height = 7,
  dashed = false,
  dashColor = "rgba(224,36,62,0.75)",
}: {
  pct: number;
  color?: string;
  track?: string;
  active: boolean;
  delay?: number;
  height?: number;
  dashed?: boolean;
  /** Border colour of the empty/dashed "open" variant (defaults to the campaign cardinal). */
  dashColor?: string;
}) {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = active
      ? withDelay(delay, withTiming(Math.max(0, Math.min(100, pct)) / 100, { duration: 900, easing: Easing.out(Easing.cubic) }))
      : withTiming(0, { duration: 120 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  const fillStyle = useAnimatedStyle(() => ({ width: `${progress.value * 100}%`, backgroundColor: color }));
  if (dashed) {
    return <View style={[styles.barTrackDashed, { height, borderColor: dashColor }]} />;
  }
  return (
    <View style={[styles.barTrack, { height, backgroundColor: track, borderRadius: height / 2 }]}>
      <Animated.View style={[styles.barFill, { height, borderRadius: height / 2 }, fillStyle]} />
    </View>
  );
}

// ─── Count-up number (the web's data-count counters — index score, mix values, audience share) ─
export function CountUp({
  value,
  active,
  duration = 900,
  suffix = "",
  style,
}: {
  value: number;
  active: boolean;
  duration?: number;
  suffix?: string;
  style?: any;
}) {
  const [display, setDisplay] = useState(active ? 0 : value);
  useEffect(() => {
    if (!active) { setDisplay(value); return; }
    let raf = 0;
    setDisplay(0);
    const t0 = Date.now();
    const step = () => {
      const p = Math.min((Date.now() - t0) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(value * eased));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, value, duration]);
  return <Text style={style}>{display}{suffix}</Text>;
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    borderRadius: T.radius,
    overflow: "hidden",
    backgroundColor: T.ink,
  },
  shellContent: {
    flexGrow: 1,
    paddingHorizontal: 22,
    paddingTop: 40,
    paddingBottom: 30,
  },
  riseWrap: { width: "100%" },
  watermark: { position: "absolute" },
  shellTopLeft: { position: "absolute", top: 22, left: 21 },
  cardmark: { flexDirection: "row", alignItems: "center", gap: 9 },
  cardmarkLabel: {
    fontFamily: Fonts.bodyBold,
    fontSize: 12,
    letterSpacing: 2.6,
    textTransform: "uppercase",
    color: T.bone,
  },
  kickerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  kickerDash: { width: 16, height: 2, borderRadius: 2, backgroundColor: T.cardinal },
  kickerText: {
    fontFamily: Fonts.bodyBold,
    fontSize: 10.5,
    letterSpacing: 2,
    textTransform: "uppercase",
    color: T.boneDim,
  },
  serifLine: {
    fontFamily: T.serifFamily,
    fontSize: 20,
    lineHeight: 24,
    color: T.bone,
  },
  chip: {
    alignSelf: "flex-start",
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: T.line,
    backgroundColor: "rgba(12,13,16,0.42)",
  },
  chipRed: { backgroundColor: T.cardinal, borderColor: T.cardinal },
  chipText: {
    fontFamily: Fonts.bodyBold,
    fontSize: 9.5,
    letterSpacing: 1.6,
    textTransform: "uppercase",
    color: T.bone,
  },
  chipTextRed: { color: "#FFFFFF" },
  barTrack: { width: "100%", overflow: "hidden" },
  barFill: {},
  barTrackDashed: {
    width: "100%",
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: "rgba(224,36,62,0.75)",
    borderStyle: "dashed",
  },
});
