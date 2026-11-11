/** luxe content — "the work": a giant Didone hero stat (view count + unit), a serif-italic note,
 *  a gold hairline, then a grid of post thumbnails (Image tiles, each stamped with its own view
 *  count) — the #1 tile carries a small rouge-dot rank pill. Mirrors server/services/themes/luxe.ts
 *  `contentCard()` (the .didone-num hero + .lede note + .hairline + grid rhythm), adapted so every
 *  tile renders its own thumbnail (mobile "top posts" grid) rather than the web's number-only rest.
 */
import React from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { LuxeShell, LuxeEyebrow, LuxeHairline } from "./Chrome";
import { Rise, RiseText, Chip } from "../Chrome";
import { LX } from "./theme";
import type { CardProps, ContentCardData } from "../types";

const TILE_SCRIM: [string, string] = ["rgba(12,10,7,0.04)", "rgba(12,10,7,0.88)"];

export function LuxeContentCard({ data, active }: CardProps<ContentCardData>) {
  const unit = String(data.heroStat.label ?? "").split(" ")[0] || "views";
  const n3 = data.tiles.length === 3;

  return (
    <LuxeShell bg={data.bg} active={active} justify="flex-start">
      <LuxeEyebrow delay={20}>{data.eyebrow}</LuxeEyebrow>

      <Rise delay={120} style={styles.heroRow}>
        <RiseText delay={120} style={styles.heroNum}>{data.heroStat.value}</RiseText>
        <Text style={styles.heroUnit}>{unit}</Text>
      </Rise>

      {!!data.note && <RiseText delay={200} style={styles.note}>{data.note}</RiseText>}

      <Rise delay={260}><LuxeHairline /></Rise>

      <Rise delay={320} style={[styles.grid, n3 && styles.gridN3]}>
        {data.tiles.map((t, i) => (
          <View key={i} style={[styles.tile, n3 && i === 0 && styles.tileWide]}>
            {t.image
              ? <Image source={{ uri: t.image }} style={StyleSheet.absoluteFill} resizeMode="cover" />
              : <View style={[StyleSheet.absoluteFill, styles.tileNoir]} />}
            <LinearGradient colors={TILE_SCRIM} locations={[0.4, 1]} style={StyleSheet.absoluteFill} />
            {i === 0 && <Chip style={styles.rankChip}>No. 1</Chip>}
            <View style={styles.tileFoot}>
              <Text style={styles.tileStat}>{t.stat}</Text>
              <Text style={styles.tileLabel}>views</Text>
            </View>
          </View>
        ))}
      </Rise>
    </LuxeShell>
  );
}

const styles = StyleSheet.create({
  heroRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  heroNum: { fontFamily: LX.didone, fontSize: 84, lineHeight: 102, color: LX.ivory, includeFontPadding: false },
  heroUnit: { fontFamily: LX.didoneItalic, fontStyle: "italic", fontSize: 22, color: LX.champagne, marginBottom: 10 },

  note: { marginTop: 10, fontFamily: LX.didoneItalic, fontStyle: "italic", fontSize: 16, lineHeight: 22, color: LX.ivoryDim },

  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  gridN3: {},
  tile: {
    width: "48.5%",
    height: 148,
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: LX.hairDim,
    backgroundColor: LX.noir,
  },
  tileWide: { width: "100%", height: 168 },
  tileNoir: { backgroundColor: LX.noir },

  rankChip: {
    position: "absolute", top: 8, left: 8,
    backgroundColor: "rgba(12,10,7,0.55)", borderColor: LX.champagne,
  },

  tileFoot: { position: "absolute", left: 10, right: 8, bottom: 8 },
  tileStat: { fontFamily: LX.didoneItalic, fontStyle: "italic", fontSize: 21, color: LX.ivory },
  tileLabel: { marginTop: 2, fontFamily: LX.sansMed, fontSize: 8, letterSpacing: 1.6, textTransform: "uppercase", color: LX.ivoryMut },
});
