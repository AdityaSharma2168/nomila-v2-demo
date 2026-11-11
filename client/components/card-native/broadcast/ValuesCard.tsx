/** broadcast values — "what she stands for": athlete-authored causes, each a left-railed "plank"
 *  marked in matchday red under a volt-ticked kicker, with a self-reported provenance note when
 *  applicable. Mirrors broadcast.ts's `valuesCard(...)` + `.c-vals` / `.plank` / `.vals-note` /
 *  `.prov` CSS. */
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { BroadcastPanel, BcKicker, NarrativeNote } from "./Chrome";
import { RiseText, Rise } from "../Chrome";
import { BC } from "./theme";
import type { CardProps, ValuesCardData } from "../types";

export function BroadcastValuesCard({ data, active }: CardProps<ValuesCardData>) {
  const plankDelay = (i: number) => 150 + Math.min(i, 3) * 70;
  const noteDelay = 150 + data.planks.length * 70 + 40;

  return (
    <BroadcastPanel active={active} bug="VALUES" watermark contentStyle={{ paddingTop: 50, paddingBottom: 34 }}>
      <BcKicker delay={20}>{data.eyebrow}</BcKicker>
      <RiseText delay={90} style={styles.statement}>{data.statement}</RiseText>

      <View style={styles.planks}>
        {data.planks.map((p, i) => (
          <Rise key={p.name} delay={plankDelay(i)} style={styles.plank}>
            <Text style={styles.plankName} numberOfLines={1}>{p.name}</Text>
            {!!p.line && <Text style={styles.plankLine}>{p.line}</Text>}
          </Rise>
        ))}
      </View>

      <View style={styles.noteWrap}>
        <NarrativeNote delay={noteDelay}>{data.note}</NarrativeNote>
        {data.confidence.level === "self_reported" && (
          <Text style={styles.prov}>Self-declared — the athlete's own words, not a Nomila claim.</Text>
        )}
      </View>
    </BroadcastPanel>
  );
}

const styles = StyleSheet.create({
  statement: {
    marginTop: 12,
    fontFamily: BC.display,
    fontSize: 31,
    lineHeight: 37,
    includeFontPadding: false,
    textAlignVertical: "center",
    textTransform: "uppercase",
    color: BC.paper,
  },
  planks: { marginTop: 20, gap: 13 },
  plank: { borderLeftWidth: 3, borderLeftColor: BC.red, paddingLeft: 12 },
  plankName: {
    fontFamily: BC.condBold,
    fontSize: 12,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: BC.paper,
  },
  plankLine: { marginTop: 3, fontFamily: BC.sans, fontSize: 11, lineHeight: 15, color: BC.mut },
  noteWrap: { marginTop: "auto", paddingTop: 4 },
  prov: {
    marginTop: 8,
    fontFamily: BC.cond,
    fontSize: 9,
    letterSpacing: 1.3,
    textTransform: "uppercase",
    color: BC.faint,
  },
});
