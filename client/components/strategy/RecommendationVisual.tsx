// RecommendationVisual — the image of a recommendation's photo card (DESIGN.md "Photo card", look B): the image
// full-bleed, a scrim from 40%, whatever the card lays at the foot (chips, the uppercase title). What the image is, in
// priority order:
//
//   brand      the brand's cover image (`visual.kind === "brand"`): the server sends it only for a move about a brand
//              whose research is confirmed and holds an image; the card's own photo of hers then opens the deck's page 2
//   her photo  one of her library photos through the ONE picker (`photoUrl` from lib/myStoryLogic cardPhotos /
//              detailPhoto): a different photo per card, never the screen's hero, no repeats on the screen
//   default    the CATEGORY DEFAULT when no eligible photo is left: the black ground, the category word outlined and
//              running off the bottom-right edge, its Feather icon top-left, and ONE blue geometric mark per category —
//              Impact a diagonal band · Positioning a dot grid · Audience rising bars · Commercial a corner block ·
//              Performance a chevron (react-native-svg)
//
// A platform item adds the platform's own mark (ui/LogoMark, 36) at the top right of whichever image it has. The domain's
// glyph and mark live in DOMAIN_ICON / DOMAIN_MARK (one place); domains carry NO colour of their own. Never a brand the
// record does not name, never a stock picture.

import React, { useState } from "react";
import { View, StyleSheet, type StyleProp, type ViewStyle, type LayoutChangeEvent } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Feather } from "@expo/vector-icons";
import Svg, { Circle, ClipPath, Defs, Polygon, Rect, Text as SvgText } from "react-native-svg";
import { LogoMark, LOGO_MARK_SIZES } from "../ui/LogoMark";
import type { VisualHint } from "../../hooks/use-recommendations";
import { domainLabel } from "../../lib/strategyLogic";
import { Bold, BoldType } from "../../constants/theme";
import { Photo } from "../ui/Photo";

type IconName = React.ComponentProps<typeof Feather>["name"];

/** ONE glyph per goal domain — the only place a domain's icon is written. A domain not listed takes the target. */
export const DOMAIN_ICON: Record<string, IconName> = {
  audience: "users", content: "film", positioning: "layers", commercial: "briefcase", impact: "heart",
  career: "award", relationships: "link-2", athletic: "activity", owned_venture: "box",
};
export type DomainMark = "impact" | "positioning" | "audience" | "commercial" | "performance";
/** The blue geometric mark a domain's category default draws — the five marks of the design, each domain mapped to one. */
export const DOMAIN_MARK: Record<string, DomainMark> = {
  impact: "impact", positioning: "positioning", audience: "audience", content: "audience",
  commercial: "commercial", owned_venture: "commercial", career: "performance", athletic: "performance", relationships: "performance",
};
export const domainTile = (domain: string | null | undefined): { icon: IconName; mark: DomainMark | null } =>
  ({ icon: (domain && DOMAIN_ICON[domain]) || "target", mark: (domain && DOMAIN_MARK[domain]) || null });

/** The mark, in a `w × h` box. It sits on the ink tile, so it takes the on-dark link colour (Bold.blue is ink since the one look). */
function Mark({ mark, w, h }: { mark: DomainMark; w: number; h: number }) {
  const blue = Bold.blueOnDark;
  if (mark === "impact") return <Polygon points={`${w * 0.62},0 ${w * 0.78},0 ${w * 0.3},${h} ${w * 0.14},${h}`} fill={blue} />;
  if (mark === "commercial") return <Rect x={w * 0.7} y={h * 0.45} width={w * 0.3} height={h * 0.55} fill={blue} />;
  if (mark === "performance") return <Polygon points={`${w * 0.4},${h * 0.2} ${w * 0.62},${h * 0.2} ${w * 0.88},${h * 0.55} ${w * 0.62},${h * 0.9} ${w * 0.4},${h * 0.9} ${w * 0.66},${h * 0.55}`} fill={blue} />;
  if (mark === "positioning") {
    const dots: React.ReactNode[] = [];
    for (let y = 7; y < h * 0.55; y += 14) for (let x = w * 0.55 + 7; x < w; x += 14) dots.push(<Circle key={`${x}-${y}`} cx={x} cy={y} r={2.2} fill={blue} />);
    return <>{dots}</>;
  }
  // audience: rising bars — 8px bars, 8px apart, clipped to the rising wedge
  const bars: React.ReactNode[] = [];
  for (let x = 0; x < w; x += 16) bars.push(<Rect key={x} x={x} y={0} width={8} height={h} fill={blue} clipPath="url(#rise)" />);
  return (
    <>
      <Defs><ClipPath id="rise"><Polygon points={`0,${h} 0,${h * 0.7} ${w},${h * 0.2} ${w},${h}`} /></ClipPath></Defs>
      {bars}
    </>
  );
}

/**
 * `word`: "bleed" (default, DESIGN.md §9) runs the outlined category word off the bottom-right edge, sized to the tile.
 * "inset" is the goal card's quieter word: about half the size, wholly inside the top-right corner, so it labels the
 * art without competing with the goal set in big type beneath it.
 */
export function CategoryDefault({ domain, height, word: wordMode = "bleed", style }: { domain: string | null | undefined; height: number; word?: "bleed" | "inset"; style?: StyleProp<ViewStyle> }) {
  const [w, setW] = useState(0);
  const t = domainTile(domain);
  const word = domainLabel(domain).toUpperCase();
  const onLayout = (e: LayoutChangeEvent) => setW(Math.round(e.nativeEvent.layout.width));
  const inset = wordMode === "inset";
  // The word's size follows the tile (64 at 200 high), as the design's does — a graphic, not typed. Inset: 24 at 150.
  const wordSize = Math.round(height * (inset ? 0.16 : 0.32));
  return (
    <View style={[StyleSheet.absoluteFill, styles.catd, style]} onLayout={onLayout} testID="visual-default">
      {w > 0 ? (
        <Svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} style={StyleSheet.absoluteFill} testID={t.mark ? `catd-${t.mark}` : "catd-plain"}>
          {t.mark ? <Mark mark={t.mark} w={w} h={height} /> : null}
          {word ? (
            <SvgText x={inset ? w - 14 : w + 6} y={inset ? 12 + wordSize * 0.8 : height + 2} textAnchor="end" fontFamily={BoldType.display.fontFamily} fontWeight="900" fontSize={wordSize} letterSpacing={inset ? 0 : -2} fill="none" stroke={Bold.wordOutline} strokeWidth={inset ? 1 : 1.2} testID={inset ? "catd-word-inset" : "catd-word"}>
              {word}
            </SvgText>
          ) : null}
        </Svg>
      ) : null}
      <View style={styles.catdIcon}><Feather name={t.icon} size={22} color={Bold.onDark} /></View>
    </View>
  );
}

/** The subject's logo alone on the blank ground — a brand, organisation or team card with no confirmed cover. */
export function LogoPanel({ logoUrl, name, site, style }: { logoUrl: string; name: string | null; site: string | null; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[StyleSheet.absoluteFill, styles.logoPanel, style]} testID="visual-logo-panel">
      <LogoMark logoUrl={logoUrl} domain={site} name={name ?? ""} size={LOGO_MARK_SIZES.lg} bold />
    </View>
  );
}

export function RecommendationVisual({ visual, photoUrl, height = 120, scrim = "card", style, children }: {
  visual: VisualHint;
  /** Her photo for this card, from the one picker; null draws the category default tile. */
  photoUrl: string | null;
  height?: number;
  /** The card's foot scrim (from 40%), or the hero's top-and-foot scrim (a detail screen's header). */
  scrim?: "card" | "hero" | "none";
  style?: StyleProp<ViewStyle>;
  /** What sits at the image's foot over the scrim: the chips, the uppercase title. */
  children?: React.ReactNode;
}) {
  // A brand / organisation / team card never takes her photo: the cover, else the logo panel, else the default.
  const image = visual.kind === "brand" ? visual.brandImageUrl : visual.kind === "logo" ? null : photoUrl;
  return (
    <View style={[styles.box, { height }, style]} testID={`visual-${visual.kind}`}>
      {image
        ? <Photo uri={image} style={StyleSheet.absoluteFill} testID={visual.kind === "brand" ? "visual-brand-image" : "visual-photo"} />
        : visual.kind === "logo" && visual.logoUrl
          ? <LogoPanel logoUrl={visual.logoUrl} name={visual.name} site={visual.site} />
          : <CategoryDefault domain={visual.domain} height={height} />}
      {scrim === "card" ? <LinearGradient colors={[Bold.scrimClear, Bold.cardScrim]} locations={[0.38, 1]} style={StyleSheet.absoluteFill} pointerEvents="none" /> : null}
      {scrim === "hero" ? <LinearGradient colors={[Bold.scrimTop, Bold.scrimClear, Bold.scrimMid, Bold.scrimFoot]} locations={[0, 0.32, 0.52, 1]} style={StyleSheet.absoluteFill} pointerEvents="none" /> : null}
      {visual.kind === "platform" ? <LogoMark platform={visual.platform} name={visual.platform} size={LOGO_MARK_SIZES.md} bold style={styles.platform} /> : null}
      {children ? <View style={styles.foot}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box:      { overflow: "hidden", justifyContent: "flex-end", backgroundColor: Bold.ink, borderRadius: Bold.radius.card },
  logoPanel: { backgroundColor: Bold.heroBlank, alignItems: "center", justifyContent: "center" },
  catd:     { backgroundColor: Bold.ink, overflow: "hidden" },
  catdIcon: { position: "absolute", top: 12, left: 12 },
  platform: { position: "absolute", top: 10, right: 10 },
  foot:     { padding: 12, gap: 7 },
});
