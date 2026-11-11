// IntelligenceRing — THE ring for her M.I.A. (DESIGN.md §10, look B, Oct 2026): eight SVG arcs from 12 o'clock
// clockwise, Audience → Commercial → Brand → Performance, two tones per capital, each band's length its stored
// contribution, 2.6° gaps, butt caps, stroke ≈ 9% of the diameter, the neutral track for the rest; the number inside.
//
//   <IntelligenceRing score={608} bands={ringBands(a)} />              on white: track #E9E9E7, the number in ink
//   <IntelligenceRing score={608} bands dark glow size={156} />        on the black block: white number, a soft glow under
//                                                                      the arcs (two wider low-opacity copies — SVG blur
//                                                                      filters are not relied on in react-native-svg)
//   <IntelligenceRing score={608} />                                   no stored contributions (an older server): one ink
//                                                                      arc of the score's share of 850
//   <IntelligenceRing score={null} />                                  an empty track, no number
//   <RingLegend />  <RingLegend dark />                                the capital legend: two dots, the name, the pair
//
// Shared on purpose: Home's black score block, My Intelligence's white score card and Me's card all draw this one. No
// ticks, no tiers, no trend. The band order and colours come from constants/ring.ts through lib/myIntelligenceLogic.

import React from "react";
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Path, Circle } from "react-native-svg";
import { Bold, BoldType, Ring } from "../../constants/theme";
import { ringFraction } from "../../lib/strategyLogic";
import { ringArcs, type RingBand } from "../../lib/myIntelligenceLogic";

/** One arc path from `a0` to `a1` degrees, clockwise from 12 o'clock. */
export function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const pt = (a: number) => { const t = ((a - 90) * Math.PI) / 180; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; };
  const [x0, y0] = pt(a0);
  const [x1, y1] = pt(a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function IntelligenceRing({ score, bands, size = 96, dark, glow, quiet, outOf = "of 850", style }: {
  score: number | null | undefined;
  bands?: RingBand[];
  size?: number;
  dark?: boolean;
  /** On black: the soft glow under the arcs. */
  glow?: boolean;
  /** An early read: the number in mute. */
  quiet?: boolean;
  /** The small line under the number. */
  outOf?: string | null;
  style?: StyleProp<ViewStyle>;
}) {
  const stroke = Math.max(6, Math.round(size * Ring.strokeRatio));
  const inset = dark && glow ? 6 : 0;
  const r = (size - stroke) / 2 - inset;
  const cx = size / 2;
  const banded = !!bands && bands.length > 0;
  const { arcs, track } = banded ? ringArcs(bands!) : { arcs: [], track: null };
  const fraction = ringFraction(score);
  const label = score != null ? `M.I.A. ${Math.round(score)} out of 850${banded ? `, ${arcs.length} bands` : ""}` : "M.I.A. not ready yet";
  const trackColor = dark ? Bold.lineOnDark : Bold.track;
  const inkColor = dark ? Bold.onDark : Bold.ink;
  const gap = Ring.gapDeg;
  const drawn = arcs.filter((a) => a.end > a.start);

  return (
    <View style={[{ width: size, height: size }, style]} accessibilityRole="image" accessibilityLabel={label} testID="intelligence-ring">
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {dark && glow ? drawn.map((a) => (
          <React.Fragment key={`glow-${a.key}`}>
            <Path d={arcPath(cx, cx, r, a.start, a.end)} stroke={a.color} strokeWidth={stroke + 10} strokeOpacity={0.16} fill="none" strokeLinecap="butt" />
            <Path d={arcPath(cx, cx, r, a.start, a.end)} stroke={a.color} strokeWidth={stroke + 4} strokeOpacity={0.32} fill="none" strokeLinecap="butt" />
          </React.Fragment>
        )) : null}
        {banded ? (
          <>
            {track ? <Path d={arcPath(cx, cx, r, track.start, track.end)} stroke={trackColor} strokeWidth={stroke} fill="none" strokeLinecap="butt" testID="ring-track" /> : null}
            {drawn.map((a) => (
              <Path key={a.key} d={arcPath(cx, cx, r, a.start, a.end)} stroke={a.color} strokeWidth={stroke} fill="none" strokeLinecap="butt" opacity={quiet ? 0.55 : 1} testID={`ring-arc-${a.key}`} />
            ))}
          </>
        ) : (
          <>
            <Circle cx={cx} cy={cx} r={r} fill="none" stroke={trackColor} strokeWidth={stroke} testID="ring-track" />
            {fraction > 0 ? (
              <Path d={arcPath(cx, cx, r, gap / 2, Math.max(gap / 2, fraction * 360 - gap / 2))} stroke={inkColor} strokeWidth={stroke} fill="none" strokeLinecap="butt" opacity={quiet ? 0.55 : 1} testID="ring-single" />
            ) : null}
          </>
        )}
      </Svg>
      <View style={styles.centre} pointerEvents="none">
        {score != null ? (
          <>
            {/* The number scales with the ring — a graphic's size, not a typed one. */}
            <Text style={[styles.score, { fontSize: Math.round(size * 0.3), lineHeight: Math.round(size * 0.32), letterSpacing: -Math.round(size * 0.012), color: quiet ? (dark ? Bold.onDarkMute : Bold.mute) : inkColor }]}>{Math.round(score)}</Text>
            {outOf ? <Text style={[styles.outOf, { color: dark ? Bold.onDarkMute : Bold.mute }]}>{outOf}</Text> : null}
          </>
        ) : null}
      </View>
    </View>
  );
}

/** The capital legend: two dots (the capital's tones), the capital in caps, the two dimensions it pairs. */
export function RingLegend({ dark, style }: { dark?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.legend, style]} testID="ring-legend">
      {Ring.capitals.map((c) => (
        <View key={c.key} style={styles.legendRow} accessibilityLabel={`${c.name}: ${c.sub}`}>
          <View style={styles.dots}>
            {c.tones.map((t) => <View key={t} style={[styles.dot, { backgroundColor: t }]} />)}
          </View>
          <View style={styles.legendText}>
            <Text style={[styles.legendName, dark && styles.legendNameDark]}>{c.name}</Text>
            <Text style={[styles.legendSub, dark && styles.legendSubDark]}>{c.sub}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  centre:         { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  score:          { fontFamily: BoldType.display.fontFamily },
  outOf:          { ...BoldType.outOf, marginTop: 1 },
  legend:         { flexDirection: "row", flexWrap: "wrap", rowGap: 6, columnGap: 10 },
  legendRow:      { flexDirection: "row", alignItems: "center", gap: 7, width: "47%", minWidth: 140 },
  dots:           { flexDirection: "row", gap: 2 },
  dot:            { width: 9, height: 9, borderRadius: 2 },
  legendText:     { flex: 1, minWidth: 0 },
  legendName:     { ...BoldType.label, letterSpacing: 0.66, color: Bold.ink },
  legendNameDark: { color: Bold.onDark },
  legendSub:      { ...BoldType.sigMeta, color: Bold.mute },
  legendSubDark:  { color: Bold.onDarkMute },
});
