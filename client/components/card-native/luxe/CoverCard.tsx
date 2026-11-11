/** luxe cover — Bodoni-stand-in name (first line caps, rest italic gold), meta sub, gold stats. */
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { LuxeShell, LuxeHairline } from "./Chrome";
import { RiseText, Rise, NomilaMark } from "../Chrome";
import { LX } from "./theme";
import type { CardProps, CoverCardData } from "../types";

export function LuxeCoverCard({ data, active }: CardProps<CoverCardData>) {
  const [first, ...rest] = data.nameLines;
  const restStr = rest.join(" ");
  return (
    <LuxeShell bg={data.image} active={active}>
      <Rise delay={20} style={styles.wordmark}>
        <NomilaMark size={22} />
        <Text style={styles.wordmarkText}>Nomi Card</Text>
      </Rise>
      <RiseText delay={150} style={styles.name}>
        <Text style={styles.cn1}>{(first ?? "").toUpperCase()}</Text>
        {restStr ? <Text style={styles.em}>{"\n" + restStr}</Text> : null}
      </RiseText>
      {!!data.meta && <RiseText delay={220} style={styles.sub}>{data.meta}</RiseText>}
      <Rise delay={290}><LuxeHairline /></Rise>
      {data.stats?.length > 0 && (
        <Rise delay={350} style={styles.metaRow}>
          {data.stats.map((s) => (
            <View key={s.label} style={styles.metaCol}>
              <Text style={styles.metaVal}>{s.value}</Text>
              <Text style={styles.metaLabel}>{s.label}</Text>
            </View>
          ))}
        </Rise>
      )}
    </LuxeShell>
  );
}

const styles = StyleSheet.create({
  wordmark:     { flexDirection: "row", alignItems: "center", gap: 9, marginBottom: 14 },
  wordmarkText: { fontFamily: LX.sans, fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: LX.or },

  name: { fontFamily: LX.didoneBold, fontSize: 58, lineHeight: 72, color: LX.ivory, letterSpacing: 0.5, includeFontPadding: false },
  cn1:  { fontFamily: LX.didoneBold, color: LX.ivory },
  em:   { fontFamily: LX.didoneItalic, fontStyle: "italic", color: LX.or },
  sub:  { marginTop: 14, fontFamily: LX.sans, fontSize: 10.5, letterSpacing: 2.4, textTransform: "uppercase", color: "rgba(244,238,226,0.92)" },
  metaRow:   { flexDirection: "row", alignItems: "flex-start", gap: 20, marginTop: 2 },
  metaCol:   {},
  metaVal:   { fontFamily: LX.didoneItalic, fontStyle: "italic", fontSize: 21, color: LX.or },
  metaLabel: { fontFamily: LX.sans, fontSize: 9, letterSpacing: 1.6, textTransform: "uppercase", color: LX.ivoryMut, marginTop: 3 },
});
