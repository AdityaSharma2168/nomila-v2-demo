/**
 * nomila look — primitives (owner decision, 23 Oct 2026: the app's one look on the public documents). Mirrors
 * server/services/themes/nomila.ts card for card. DESIGN.md is the source: white ground, Outfit only through the
 * BoldType roles, ONE raspberry highlight per card, tiles at corner 16, photo-led full-bleed covers under the §2c
 * scrims, the M.I.A. card dark, and the Nomila mark treatment (cardmark, rings watermark, logo × mark lockup).
 *
 *   NomilaPaper   the white text-led card (optional rings watermark), content flowing from the top
 *   NomilaPhoto   the full-bleed photo card under a scrim, content at the foot
 *   NLabel · NCaption · NChip · Cobrand
 *
 * Reuses the theme-agnostic stagger (Rise / useRiseKey) from the shared Chrome, and the brand book's mark and rings
 * watermark (components/book/mark.tsx) so the book and the deck carry the identical Nomila treatment.
 */
import React, { useState } from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Animated from "react-native-reanimated";
import { Rise, useRiseKey } from "../Chrome";
import { NomilaMark, RingsWatermark } from "../../book/mark";
import { Bold, BoldType } from "../../../constants/theme";

export const NM = {
  ink: Bold.ink, ink2: Bold.ink2, mute: Bold.mute, quiet: Bold.quiet, line: Bold.line, ground: Bold.ground,
  paper: Bold.paper, track: Bold.track, act: Bold.act, actSoft: Bold.actSoft, onDark: Bold.onDark,
  onDarkLabel: Bold.onDarkLabel, onDarkMute: Bold.onDarkMute, lineOnDark: Bold.lineOnDark, blank: Bold.heroBlank,
  radius: Bold.radius.card,
};

/** The card types the Nomila look draws on white (the rest are photo-led or the dark M.I.A. card). The deck's
 *  progress segments read ink on these and white on the others. */
export const NOMILA_LIGHT_TYPES: ReadonlySet<string> = new Set([
  "audience", "content", "whyFits", "story", "values", "achievements", "activationPlan",
]);

// DESIGN.md §2c: photo hero top .45 → clear at 32% → .08 at 52% → foot .78 (deep .86 for a long statement).
const SCRIMS = {
  hero: { colors: ["rgba(0,0,0,0.45)", "rgba(0,0,0,0)", "rgba(0,0,0,0.08)", "rgba(0,0,0,0.86)"], locations: [0, 0.32, 0.52, 1] },
  deep: { colors: ["rgba(0,0,0,0.45)", "rgba(0,0,0,0.1)", "rgba(0,0,0,0.55)", "rgba(0,0,0,0.9)"], locations: [0, 0.3, 0.58, 1] },
} as const;

export function NomilaPaper({ active, watermark, children, contentStyle }: {
  active?: boolean; watermark?: boolean; children: React.ReactNode; contentStyle?: any;
}) {
  const playKey = useRiseKey(active ?? true);
  const [w, setW] = useState(0);
  return (
    <View style={[styles.card, styles.paper]} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {watermark && w > 0 ? <RingsWatermark w={w} /> : null}
      <Animated.ScrollView
        style={StyleSheet.absoluteFill}
        contentContainerStyle={[styles.content, contentStyle]}
        showsVerticalScrollIndicator={false}
        bounces
      >
        <View key={playKey} style={styles.riseWrap}>{children}</View>
      </Animated.ScrollView>
    </View>
  );
}

export function NomilaPhoto({ uri, active, scrim = "hero", children, top }: {
  uri?: string | null; active?: boolean; scrim?: keyof typeof SCRIMS; children: React.ReactNode; top?: React.ReactNode;
}) {
  const playKey = useRiseKey(active ?? true);
  const s = SCRIMS[scrim];
  return (
    <View style={[styles.card, styles.blank]}>
      {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
      <LinearGradient colors={s.colors as unknown as [string, string, ...string[]]} locations={s.locations as unknown as [number, number, ...number[]]} style={StyleSheet.absoluteFill} pointerEvents="none" />
      <Animated.ScrollView
        style={StyleSheet.absoluteFill}
        contentContainerStyle={[styles.content, styles.foot]}
        showsVerticalScrollIndicator={false}
        bounces
      >
        <View key={playKey} style={styles.riseWrap}>{children}</View>
      </Animated.ScrollView>
      {top ? <View style={styles.top} pointerEvents="none">{top}</View> : null}
    </View>
  );
}

export function NLabel({ children, onDark, delay = 0, style }: { children: React.ReactNode; onDark?: boolean; delay?: number; style?: any }) {
  return (
    <Rise delay={delay}>
      <Text style={[styles.label, onDark && styles.labelOnDark, style]} numberOfLines={2}>{children}</Text>
    </Rise>
  );
}

export function NChip({ children, tone = "ground" }: { children: React.ReactNode; tone?: "ground" | "white" | "act" }) {
  return (
    <View style={[styles.chip, tone === "white" && styles.chipWhite, tone === "act" && styles.chipAct]}>
      <Text style={[styles.chipText, tone === "act" && styles.chipTextAct]}>{children}</Text>
    </View>
  );
}

/** The brand logo × Nomila mark lockup (why she fits, the concept). */
export function Cobrand({ brand, onDark, delay = 0 }: { brand: { name: string; logo?: string | null }; onDark?: boolean; delay?: number }) {
  return (
    <Rise delay={delay} style={styles.cobrand}>
      {brand.logo ? (
        <View style={[styles.logoChip, onDark && styles.logoChipOnDark]}>
          <Image source={{ uri: brand.logo }} style={styles.logoImg} resizeMode="contain" accessibilityLabel={brand.name} />
        </View>
      ) : (
        <Text style={[styles.namemark, onDark && { color: NM.onDark }]}>{brand.name}</Text>
      )}
      <Text style={[styles.cobrandX, onDark && { color: NM.onDarkLabel }]}>×</Text>
      <NomilaMark size={24} dark={onDark} />
    </Rise>
  );
}

const styles = StyleSheet.create({
  card: { flex: 1, borderRadius: NM.radius, overflow: "hidden" },
  paper: { backgroundColor: NM.paper, borderWidth: 1, borderColor: NM.line },
  blank: { backgroundColor: NM.blank },
  content: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 40, paddingBottom: 28 },
  foot: { justifyContent: "flex-end" },
  riseWrap: { width: "100%" },
  top: { position: "absolute", top: 32, left: 22, right: 22 },

  label: { ...BoldType.label, color: NM.mute },
  labelOnDark: { color: NM.onDarkLabel },

  chip: { alignSelf: "flex-start", height: 24, paddingHorizontal: 11, borderRadius: 999, justifyContent: "center", backgroundColor: NM.ground },
  chipWhite: { backgroundColor: NM.paper },
  chipAct: { backgroundColor: NM.act },
  chipText: { ...BoldType.chip, color: NM.ink },
  chipTextAct: { color: NM.onDark },

  cobrand: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 16 },
  logoChip: { height: 36, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: NM.line, backgroundColor: NM.paper, justifyContent: "center" },
  logoChipOnDark: { borderColor: "transparent" },
  logoImg: { height: 20, width: 96 },
  namemark: { ...BoldType.section, color: NM.ink },
  cobrandX: { ...BoldType.rowTitle, color: NM.quiet },
});
