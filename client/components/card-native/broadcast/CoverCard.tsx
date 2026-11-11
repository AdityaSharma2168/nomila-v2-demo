/** broadcast cover — full-bleed hero, wordmark top, Anton name (surname in volt with a red slash),
 *  a red lower-third meta banner, the hook, and a stats ticker along the bottom edge. */
import React from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import { RiseText, Rise, NomilaMark, useRiseKey } from "../Chrome";
import { Ticker } from "./Chrome";
import { LinearGradient } from "expo-linear-gradient";
import { BC } from "./theme";
import type { CardProps, CoverCardData } from "../types";

const SCRIM: [string, string, string, string, string, string] = [
  "rgba(11,12,16,0.66)", "rgba(11,12,16,0.14)", "rgba(11,12,16,0.24)",
  "rgba(11,12,16,0.74)", "rgba(11,12,16,0.95)", "#0B0C10",
];
const SCRIM_LOC: [number, number, number, number, number, number] = [0, 0.22, 0.4, 0.6, 0.8, 1];

export function BroadcastCoverCard({ data, active }: CardProps<CoverCardData>) {
  const [first, ...rest] = data.nameLines;
  const surname = rest.join(" ").trim();
  const playKey = useRiseKey(active ?? true);

  return (
    <View style={styles.card}>
      {data.image
        ? <Image source={{ uri: data.image }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        : <View style={[StyleSheet.absoluteFill, { backgroundColor: BC.ink }]} />}
      <LinearGradient colors={SCRIM} locations={SCRIM_LOC} style={StyleSheet.absoluteFill} pointerEvents="none" />

      <View style={styles.frame} key={playKey}>
        {/* top row */}
        <View style={styles.top}>
          <View style={styles.wordmark}>
            <NomilaMark size={24} />
            <Text style={styles.wordmarkLabel}>Nomi Card</Text>
          </View>
        </View>

        {/* bottom stack */}
        <View style={styles.bottom}>
          <RiseText delay={140} style={styles.name}>{(first ?? "").toUpperCase()}</RiseText>
          {!!surname && (
            <Rise delay={180} style={styles.row2Wrap}>
              <View style={styles.row2Slash} />
              <Text style={styles.row2}>{surname.toUpperCase()}</Text>
            </Rise>
          )}
          {!!data.meta && (
            <Rise delay={240} style={styles.lowerThird}>
              <Text style={styles.lowerText} numberOfLines={1}>{data.meta.replace(/·/g, "  /  ")}</Text>
            </Rise>
          )}
          {!!data.hook && <RiseText delay={300} style={styles.hook}>{data.hook}</RiseText>}
        </View>
      </View>

      {/* ticker — scoreboard marquee */}
      {data.stats?.length > 0 && <Ticker stats={data.stats} />}
    </View>
  );
}

const styles = StyleSheet.create({
  card:  { flex: 1, borderRadius: 6, overflow: "hidden", backgroundColor: BC.ink },
  frame: { flex: 1, justifyContent: "space-between", paddingHorizontal: 18, paddingTop: 30, paddingBottom: 46 },

  top:       { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  wordmark:  { flexDirection: "row", alignItems: "center", gap: 9 },
  wordmarkLabel: { fontFamily: BC.condBold, fontSize: 12, letterSpacing: 2.6, textTransform: "uppercase", color: BC.paper },
  kitTag:    { borderWidth: 1, borderColor: BC.line, backgroundColor: "rgba(11,12,16,0.55)", paddingHorizontal: 9, paddingVertical: 4 },
  kitTagText:{ fontFamily: BC.condBold, fontSize: 10, letterSpacing: 2.6, textTransform: "uppercase", color: BC.paper },

  bottom:  {},
  name:    { fontFamily: BC.display, fontSize: 64, lineHeight: 84, textTransform: "uppercase", color: BC.paper, letterSpacing: 0.5 },
  row2Wrap:{ alignSelf: "flex-start", marginTop: -2 },
  row2Slash:{ position: "absolute", left: -6, right: -14, top: "44%", height: 14, backgroundColor: BC.red, transform: [{ skewX: "-24deg" }] },
  row2:    { fontFamily: BC.display, fontSize: 64, lineHeight: 84, textTransform: "uppercase", color: BC.volt, letterSpacing: 0.5 },

  lowerThird: { alignSelf: "flex-start", backgroundColor: BC.red, paddingHorizontal: 16, paddingVertical: 7, marginTop: 12 },
  lowerText:  { fontFamily: BC.condBold, fontSize: 14, letterSpacing: 1.2, textTransform: "uppercase", color: BC.paper },

  hook: { marginTop: 12, fontFamily: BC.sansMed, fontSize: 15, lineHeight: 21, color: BC.paper },

  ticker: {
    position: "absolute", left: 0, right: 0, bottom: 0, height: 30,
    backgroundColor: "#0B0C10", borderTopWidth: 1, borderTopColor: BC.line,
    flexDirection: "row", alignItems: "center", paddingHorizontal: 14, overflow: "hidden",
  },
  tickItem:  { fontFamily: BC.cond, fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: BC.mut },
  tickVal:   { fontFamily: BC.condBold, color: BC.volt },
  tickSlash: { color: BC.red },
});
