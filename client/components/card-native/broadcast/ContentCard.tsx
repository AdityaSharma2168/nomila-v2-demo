/** broadcast content — "the tape": a red kicker, a wide No.-1 lead tile (flagged, huge volt hero
 *  stat) stacked over a row of smaller post tiles (each stamped with its own view count), and a
 *  closing tape-note. Mirrors broadcast.ts's `.k-tape` (contentCard): image + bottom veil + stat
 *  overlay per tile, red "flag" badge on the lead tile. RN can't clip-path the tile's notched
 *  corner — approximated with square corners, per the broadcast Chrome convention. */
import React from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { BroadcastPanel, BcKicker, NarrativeNote } from "./Chrome";
import { Rise } from "../Chrome";
import { BC } from "./theme";
import type { CardProps, ContentCardData } from "../types";

type TileData = ContentCardData["tiles"][number];

const VEIL: [string, string, string, string] = [
  "rgba(11,12,16,0)", "rgba(11,12,16,0.30)", "rgba(11,12,16,0.74)", "rgba(11,12,16,0.96)",
];
const VEIL_LOC: [number, number, number, number] = [0.16, 0.46, 0.74, 1];

function Tile({
  image, stat, label, main, half, delay,
}: { image: string | null; stat: string; label: string; main?: boolean; half?: boolean; delay: number }) {
  return (
    <Rise delay={delay} style={[styles.tile, main ? styles.tileMain : styles.tileSub, half && styles.tileSubHalf]}>
      {image
        ? (
          // Overflow-hidden frame + an over-tall image pinned to the top edge: emulates the web's
          // object-position:top center (cover, but crop the bottom, not both edges symmetrically) —
          // center-cropping was clipping faces oddly.
          <View style={styles.imageWrap} pointerEvents="none">
            <Image source={{ uri: image }} style={styles.image} resizeMode="cover" />
          </View>
        )
        : <View style={[StyleSheet.absoluteFill, styles.tileNoir]} />}
      <LinearGradient colors={VEIL} locations={VEIL_LOC} style={StyleSheet.absoluteFill} pointerEvents="none" />
      {main && (
        <View style={styles.flag}><Text style={styles.flagText}>No. 1 post</Text></View>
      )}
      <View style={styles.stat}>
        <Text style={main ? styles.vMain : styles.vSub} numberOfLines={1}>{stat}</Text>
        <Text style={styles.statLabel} numberOfLines={1}>{label}</Text>
      </View>
    </Rise>
  );
}

export function BroadcastContentCard({ data, active }: CardProps<ContentCardData>) {
  const [lead, ...rest] = data.tiles;
  // Tile-count guard: the web grid is 2 columns that wrap a lone extra tile onto its own row
  // (not stretched full-width). Cap at 3 subs and chunk into rows of (up to) 2 to match — so 1 or
  // 3 sub-tiles render sanely instead of assuming exactly 2.
  const subs: TileData[] = rest.slice(0, 3);
  const subRows: TileData[][] = [];
  for (let i = 0; i < subs.length; i += 2) subRows.push(subs.slice(i, i + 2));

  return (
    <BroadcastPanel active={active} bug="POSTS" contentStyle={{ paddingTop: 50, paddingBottom: 34 }}>
      <BcKicker red delay={10}>{data.eyebrow}</BcKicker>

      <View style={styles.tiles}>
        <Tile
          image={lead ? lead.image : null}
          stat={lead ? lead.stat : data.heroStat.value}
          label={data.heroStat.label}
          main
          delay={80}
        />
        {subRows.map((row, ri) => (
          <View key={ri} style={styles.subRow}>
            {row.map((t, i) => {
              const idx = ri * 2 + i;
              return (
                <Tile
                  key={idx}
                  image={t.image}
                  stat={t.stat}
                  label={`Views · No. ${idx + 2}`}
                  half={row.length === 1}
                  delay={150 + idx * 60}
                />
              );
            })}
          </View>
        ))}
      </View>

      <NarrativeNote delay={300}>{data.note}</NarrativeNote>
    </BroadcastPanel>
  );
}

const styles = StyleSheet.create({
  tiles:   { marginTop: 16, gap: 8 },
  subRow:  { flexDirection: "row", gap: 8 },

  tile:     { overflow: "hidden", backgroundColor: BC.panel },
  tileMain: { height: 200, width: "100%" },
  tileSub:  { height: 112, flex: 1 },
  // A lone tile in the last sub-row (1 or 3 total subs): hold it half-width instead of stretching.
  tileSubHalf: { flex: 0, width: "48.5%" },
  tileNoir: { backgroundColor: BC.panel2 },

  imageWrap: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, overflow: "hidden" },
  image:     { position: "absolute", top: 0, left: 0, right: 0, height: "130%" },

  flag: {
    position: "absolute", top: 0, left: 0, backgroundColor: BC.red,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  flagText: { fontFamily: BC.condBold, fontSize: 10, letterSpacing: 2, textTransform: "uppercase", color: BC.paper },

  stat: { position: "absolute", left: 12, right: 12, bottom: 10 },
  vMain: {
    fontFamily: BC.display, fontSize: 48, lineHeight: 64, color: BC.volt,
    includeFontPadding: false, textAlignVertical: "center",
  },
  vSub: {
    fontFamily: BC.display, fontSize: 26, lineHeight: 32, color: BC.volt,
    includeFontPadding: false, textAlignVertical: "center",
  },
  statLabel: {
    marginTop: 2, fontFamily: BC.condBold, fontSize: 11, letterSpacing: 2.2,
    textTransform: "uppercase", color: BC.paper,
  },
});
