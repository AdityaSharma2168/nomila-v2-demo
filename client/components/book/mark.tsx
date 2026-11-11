// The Nomila mark in the brand book (owner, 23 Oct 2026): the book drew no mark at all, so a page shared on its own
// said nothing about where it came from. Three treatments, copied from the Nomi Card renderer (server/services/
// kitRenderer.ts NOMILA_MARK / RINGS_ATMO):
//
//   <BookCardmark dark />        the mark + "Nomila · Brand book" — the cover's lockup, above her name
//   <BookFooter dark bottom />   a small mark + "Nomila" — every inside page's foot (part of the page, so a shared page
//                                carries it)
//   <RingsWatermark w h />       the mark's faint arc tracks, oversized off the page's foot-right — white pages only
//
// The four arc colours are the logo's, read from the ring's capitals (constants/ring.ts) — never written here.
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { Bold, BoldType, Ring } from "../../constants/theme";

const ARCS = [
  "M 17.7 88.14 A 50 50 0 1 1 99.3 31.0",
  "M 26.89 80.43 A 38 38 0 1 1 93.42 62.6",
  "M 36.08 72.71 A 26 26 0 1 1 72.71 75.92",
  "M 45.28 65.0 A 14 14 0 1 1 56.0 70.0",
] as const;
const RADII = [50, 38, 26, 14] as const;
/** The logo's arc colours, outer to inner: Audience, Commercial, Brand, Performance — each capital's first tone. */
const LOGO = Ring.capitals.map((c) => c.tones[0]);

/** The official mark: four concentric arcs over faint tracks, one origin (the landing-page logo). */
export function NomilaMark({ size = 26, dark }: { size?: number; dark?: boolean }) {
  const track = dark ? Bold.onDark : Bold.ink;
  return (
    <Svg width={size} height={size} viewBox="0 0 112 112" fill="none" accessibilityLabel="Nomila">
      {RADII.map((r) => <Circle key={r} cx={56} cy={56} r={r} stroke={track} strokeWidth={4} strokeOpacity={dark ? 0.12 : 0.1} />)}
      {ARCS.map((d, i) => <Path key={d} d={d} stroke={LOGO[i]} strokeWidth={5} strokeLinecap="round" fill="none" />)}
    </Svg>
  );
}

/** The cover's lockup: the mark + "Nomila · Brand book". */
export function BookCardmark({ label, dark }: { label: string; dark?: boolean }) {
  return (
    <View style={s.cardmark} testID="book-cardmark">
      <NomilaMark size={27} dark={dark} />
      <Text style={[s.cardmarkLabel, { color: dark ? Bold.onDark : Bold.ink }]}>{label}</Text>
    </View>
  );
}

/** A page's foot: a small mark + "Nomila", bottom-left (where the reader's bottom row has no button). */
export function BookFooter({ label, dark, bottom }: { label: string; dark?: boolean; bottom: number }) {
  return (
    <View style={[s.footer, { bottom }]} pointerEvents="none" testID="book-footer">
      <NomilaMark size={18} dark={dark} />
      <Text style={[s.footerLabel, { color: dark ? Bold.onDark : Bold.ink }]}>{label}</Text>
    </View>
  );
}

/** The mark's arc tracks, faint and oversized off the page's foot-right: texture on white pages, never over a photo. */
export function RingsWatermark({ w }: { w: number }) {
  const size = w * 1.2;
  return (
    <View style={[s.atmo, { width: size, height: size, right: -w * 0.38, bottom: -w * 0.15 }]} pointerEvents="none" testID="book-watermark">
      <Svg width={size} height={size} viewBox="0 0 112 112" fill="none">
        {RADII.map((r) => <Circle key={r} cx={56} cy={56} r={r} stroke={Bold.ink} strokeWidth={1.2} strokeOpacity={0.05} />)}
        <Path d={ARCS[0]} stroke={LOGO[0]} strokeWidth={1.4} strokeOpacity={0.14} strokeLinecap="round" fill="none" />
      </Svg>
    </View>
  );
}

const s = StyleSheet.create({
  cardmark:      { flexDirection: "row", alignItems: "center", gap: 9, marginBottom: 14 },
  cardmarkLabel: { ...BoldType.label, fontSize: 12.5, lineHeight: 16, letterSpacing: 3.2 },
  footer:        { position: "absolute", left: 18, flexDirection: "row", alignItems: "center", gap: 7 },
  footerLabel:   { ...BoldType.label, fontFamily: BoldType.display.fontFamily, letterSpacing: 3.4 },
  atmo:          { position: "absolute" },
});
