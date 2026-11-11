// GoalVisual — a goal's image (Goals PR, "Goals in your words" §2, look B). What it draws comes from lib/goalLogic
// `GoalImagery` (built today by lib/agent/goalsLogic `goalImages`), one of:
//
//   subject       the subject's image full-bleed (a confirmed brand cover from a move under the goal)
//   channel       a strip of her own posts from the platform the goal names, the platform's mark top-right
//   performance   one of her action shots, full-bleed
//   typographic   the domain's category default (black ground, the blue mark, the outlined word) with a MINI RING: the
//                 eight bands, only the goal's capital in its two tones, the rest on the dark track. A goal CARD (`card`)
//                 draws no ring and the quieter inset word (owner, 7 Oct 2026: the ring was unexplained there)
//
// The foot scrim and whatever the card lays at the foot (chips, the goal) are the caller's, as RecommendationVisual's.

import React from "react";
import { View, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Path } from "react-native-svg";
import { CategoryDefault } from "./RecommendationVisual";
import { arcPath } from "../intelligence/IntelligenceRing";
import { LogoMark, LOGO_MARK_SIZES } from "../ui/LogoMark";
import { Photo } from "../ui/Photo";
import type { GoalImagery } from "../../lib/goalLogic";
import type { RingCapital } from "../../constants/ring";
import { Bold, Ring } from "../../constants/theme";

/** The eight bands, equal, from 12 o'clock clockwise; only `capital`'s two are coloured. */
export function MiniRing({ capital, size = 44, dark = true, style }: { capital: RingCapital; size?: number; dark?: boolean; style?: StyleProp<ViewStyle> }) {
  const stroke = Math.max(4, Math.round(size * 0.12));
  const r = (size - stroke) / 2;
  const c = size / 2;
  const span = 360 / 8;
  const bands = Ring.capitals.flatMap((cap) => cap.tones.map((tone, i) => ({ key: `${cap.key}-${i}`, color: cap.key === capital ? tone : dark ? Bold.lineOnDark : Bold.track, lit: cap.key === capital })));
  return (
    <View style={[{ width: size, height: size }, style]} accessibilityRole="image" accessibilityLabel={`Moves your ${Ring.capitals.find((x) => x.key === capital)?.name ?? ""} score`} testID={`mini-ring-${capital}`}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {bands.map((b, i) => (
          <Path key={b.key} d={arcPath(c, c, r, i * span + Ring.gapDeg / 2, (i + 1) * span - Ring.gapDeg / 2)} stroke={b.color} strokeWidth={stroke} fill="none" strokeLinecap="butt" testID={b.lit ? `mini-ring-lit-${b.key}` : undefined} />
        ))}
      </Svg>
    </View>
  );
}

export function GoalVisual({ imagery, domain, height = 150, scrim = true, card = false, style, children }: {
  imagery: GoalImagery;
  domain: string;
  height?: number;
  /** A goal CARD (Strategy's Goals tab and the full list): no mini ring, and the category word inset and quieter. */
  card?: boolean;
  /** The foot scrim under the caller's chips and goal line. */
  scrim?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}) {
  return (
    <View style={[styles.box, { height }, style]} testID={`goal-visual-${imagery.kind}`}>
      {imagery.kind === "subject" || imagery.kind === "performance" ? (
        <Photo uri={imagery.image} style={StyleSheet.absoluteFill} testID="goal-visual-image" />
      ) : imagery.kind === "channel" ? (
        <View style={[StyleSheet.absoluteFill, styles.strip]}>
          {imagery.images.map((u) => <Photo key={u} uri={u} style={styles.stripCell} testID="goal-visual-post" />)}
        </View>
      ) : (
        <>
          <CategoryDefault domain={domain} height={height} word={card ? "inset" : "bleed"} />
          {card ? null : <MiniRing capital={imagery.capital} size={Math.round(Math.min(56, height * 0.3))} style={styles.ring} />}
        </>
      )}
      {scrim && imagery.kind !== "typographic" ? <LinearGradient colors={[Bold.scrimClear, Bold.cardScrim]} locations={[0.38, 1]} style={StyleSheet.absoluteFill} pointerEvents="none" /> : null}
      {imagery.kind === "channel" ? <LogoMark platform={imagery.platform} name={imagery.platform} size={LOGO_MARK_SIZES.md} bold style={styles.platform} /> : null}
      {children ? <View style={styles.foot}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box:       { borderRadius: Bold.radius.card, overflow: "hidden", backgroundColor: Bold.ink },
  strip:     { flexDirection: "row", gap: 2 },
  stripCell: { flex: 1, height: "100%" },
  ring:      { position: "absolute", top: 12, right: 12 },
  platform:  { position: "absolute", top: 12, right: 12 },
  foot:      { position: "absolute", left: 0, right: 0, bottom: 0, padding: 14, gap: 8 },
});
