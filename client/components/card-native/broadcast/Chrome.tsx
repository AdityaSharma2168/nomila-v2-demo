/**
 * broadcast primitives — two shell types + the shared broadcast marks. `BroadcastPanel` is the dark
 * scoreboard panel (with an optional giant rotated "bug" watermark) that most cards sit in;
 * `BroadcastHero` is the full-bleed photo card (cover / fit / video). Plus the skewed volt kicker
 * tick, chips, and the red slash divider. Reuses the theme-agnostic stagger (Rise/useRiseKey) from
 * the campaign Chrome. Mirrors broadcast.ts's .card / .card.panel / .card-inner / .kicker / .bug /
 * .chip / .slashline CSS. (RN can't clip-path the notched corners — approximated with square
 * corners, which suits the angular look.)
 */
import React, { useEffect, useState } from "react";
import { View, Text, Image, StyleSheet, type LayoutChangeEvent } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing } from "react-native-reanimated";
import { Rise, useRiseKey, RingsWatermark } from "../Chrome";
import { BC } from "./theme";

const HERO_SCRIM: [string, string, string, string, string, string] = [
  "rgba(11,12,16,0.66)", "rgba(11,12,16,0.14)", "rgba(11,12,16,0.24)",
  "rgba(11,12,16,0.74)", "rgba(11,12,16,0.95)", "#0B0C10",
];
const HERO_LOC: [number, number, number, number, number, number] = [0, 0.22, 0.4, 0.6, 0.8, 1];

/** The dark scoreboard panel — content scrolls; an optional huge rotated word sits behind as a bug. */
export function BroadcastPanel({
  active, bug, watermark, children, contentStyle,
}: { active?: boolean; bug?: string; /** The faint paper-white rings watermark (the Nomila mark treatment). */ watermark?: boolean; children: React.ReactNode; contentStyle?: any }) {
  const playKey = useRiseKey(active ?? true);
  return (
    <View style={styles.card}>
      {/* Panel = vertical gradient + a faint diagonal hatch (the web's photo-less scoreboard texture,
          NOT a flat grey — that flatness read as "empty"). */}
      <LinearGradient colors={["#12141B", "#0B0C10"]} locations={[0, 0.72]} style={StyleSheet.absoluteFill} pointerEvents="none" />
      {watermark ? <RingsWatermark color={BC.paper} opacity={0.1} /> : null}
      {!!bug && (
        <View style={styles.bugWrap} pointerEvents="none">
          <Text style={styles.bug} numberOfLines={1}>{bug}</Text>
        </View>
      )}
      <Animated.ScrollView
        style={StyleSheet.absoluteFill}
        contentContainerStyle={[styles.inner, contentStyle]}
        showsVerticalScrollIndicator={false}
        bounces
      >
        <View key={playKey} style={styles.riseWrap}>{children}</View>
      </Animated.ScrollView>
    </View>
  );
}

/** The full-bleed photo card (cover / fit / video) — photo + broadcast scrim + bottom content. */
export function BroadcastHero({
  bg, active, children,
}: { bg?: string | null; active?: boolean; children: React.ReactNode }) {
  const playKey = useRiseKey(active ?? true);
  return (
    <View style={styles.card}>
      {bg
        ? <Image source={{ uri: bg }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        : <View style={[StyleSheet.absoluteFill, { backgroundColor: BC.ink }]} />}
      <LinearGradient colors={HERO_SCRIM} locations={HERO_LOC} style={StyleSheet.absoluteFill} pointerEvents="none" />
      <Animated.ScrollView
        style={StyleSheet.absoluteFill}
        contentContainerStyle={styles.heroContent}
        showsVerticalScrollIndicator={false}
        bounces
      >
        <View key={playKey} style={styles.riseWrap}>{children}</View>
      </Animated.ScrollView>
    </View>
  );
}

/** Kicker — a skewed volt (or red) tick + spaced condensed caps. */
export function BcKicker({ children, red, delay = 40 }: { children: React.ReactNode; red?: boolean; delay?: number }) {
  return (
    <Rise delay={delay} style={styles.kickerRow}>
      <View style={[styles.kickerTick, red && styles.kickerTickRed]} />
      <Text style={styles.kickerText} numberOfLines={1}>{children}</Text>
    </Rise>
  );
}

/** A red diagonal-hatch slash divider. */
export function SlashLine({ style }: { style?: any }) {
  return <View style={[styles.slash, style]} />;
}

/** A chip — red (filled) or ghost (outline). */
export function BcChip({ children, tone = "red" }: { children: React.ReactNode; tone?: "red" | "ghost" }) {
  return (
    <View style={[styles.chip, tone === "red" ? styles.chipRed : styles.chipGhost]}>
      <Text style={[styles.chipText, tone === "red" ? styles.chipTextRed : styles.chipTextGhost]}>{children}</Text>
    </View>
  );
}

/** Designed body copy — a volt-dim block with a skewed lead rail + brighter text (replaces the flat
 *  grey paragraphs that read as "bland"). Use for verdicts / notes / closers. */
export function NarrativeNote({ children, red, delay = 0 }: { children: React.ReactNode; red?: boolean; delay?: number }) {
  return (
    <Rise delay={delay} style={styles.note}>
      <View style={[styles.noteRail, red && styles.noteRailRed]} />
      <Text style={styles.noteText}>{children}</Text>
    </Rise>
  );
}

/** The scoreboard ticker — a seamless marquee of stats (duplicated row, looped translateX). */
export function Ticker({ stats }: { stats: Array<{ value: string; label: string }> }) {
  const [w, setW] = useState(0);
  const x = useSharedValue(0);
  useEffect(() => {
    if (w <= 0) return;
    x.value = 0;
    x.value = withRepeat(withTiming(-w, { duration: Math.max(6000, w * 26), easing: Easing.linear }), -1, false);
  }, [w, x]);
  const track = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const onLayout = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width);
  const Row = ({ measure }: { measure?: boolean }) => (
    <View style={styles.tickRow} onLayout={measure ? onLayout : undefined}>
      {stats.map((s, i) => (
        <Text key={`${measure ? "a" : "b"}-${i}`} style={styles.tickItem} numberOfLines={1}>
          <Text style={styles.tickVal}>{s.value}</Text> {s.label.toUpperCase()}  <Text style={styles.tickSlash}>/</Text>{"  "}
        </Text>
      ))}
    </View>
  );
  return (
    <View style={styles.ticker}>
      <Animated.View style={[styles.tickTrack, track]}>
        <Row measure />
        <Row />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { flex: 1, borderRadius: 6, overflow: "hidden", backgroundColor: BC.ink },
  inner:       { flexGrow: 1, paddingHorizontal: 22, paddingTop: 46, paddingBottom: 30 },
  heroContent: { flexGrow: 1, justifyContent: "flex-end", paddingHorizontal: 18, paddingTop: 40, paddingBottom: 22 },
  riseWrap:    { width: "100%" },

  // Giant rotated "bug" watermark down the right edge (approximates the web's outline text).
  bugWrap: { position: "absolute", right: -30, top: 70, alignItems: "center", justifyContent: "center" },
  bug: {
    fontFamily: BC.display, fontSize: 150, letterSpacing: 3, textTransform: "uppercase",
    color: "rgba(242,239,230,0.09)", transform: [{ rotate: "90deg" }],
  },

  kickerRow:    { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 },
  kickerTick:   { width: 16, height: 2, backgroundColor: BC.volt, transform: [{ skewX: "-24deg" }] },
  kickerTickRed:{ backgroundColor: BC.red },
  kickerText:   { fontFamily: BC.cond, fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: BC.mut },

  slash: { height: 3, backgroundColor: BC.red, opacity: 0.9 },

  chip: { alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 2 },
  chipRed:   { backgroundColor: BC.red },
  chipGhost: { backgroundColor: "transparent", borderWidth: 1, borderColor: BC.line },
  chipText:  { fontFamily: BC.condBold, fontSize: 12, letterSpacing: 1, textTransform: "uppercase" },
  chipTextRed:   { color: BC.paper },
  chipTextGhost: { color: BC.mut },

  // Narrative note — designed body copy (not flat grey)
  note:        { flexDirection: "row", gap: 11, backgroundColor: BC.voltDim, paddingVertical: 12, paddingHorizontal: 13, marginTop: 16 },
  noteRail:    { width: 3, alignSelf: "stretch", backgroundColor: BC.volt, transform: [{ skewX: "-10deg" }] },
  noteRailRed: { backgroundColor: BC.red },
  noteText:    { flex: 1, fontFamily: BC.sansMed, fontSize: 13, lineHeight: 19, color: BC.paper },

  // Ticker marquee
  ticker:   { position: "absolute", left: 0, right: 0, bottom: 0, height: 30, backgroundColor: "#0B0C10", borderTopWidth: 1, borderTopColor: BC.line, justifyContent: "center", overflow: "hidden" },
  tickTrack:{ flexDirection: "row" },
  tickRow:  { flexDirection: "row", paddingHorizontal: 7 },
  tickItem: { fontFamily: BC.cond, fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: BC.mut, paddingHorizontal: 7 },
  tickVal:  { fontFamily: BC.condBold, color: BC.volt },
  tickSlash:{ color: BC.red },
});
