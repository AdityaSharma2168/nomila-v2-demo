/** broadcast whyFits — co-brand lockup (brand logo/name × NomilaMark) over a scoreboard panel, a
 *  volt-numbered reasons list, and a footer line. Faithful port of broadcast.ts's `whyFitsCard`
 *  (.c-why / .why-cobrand / .why-lead / .why-list / .why-row / .why-foot). */
import React from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import { BroadcastPanel, BcKicker } from "./Chrome";
import { Rise, RiseText, NomilaMark } from "../Chrome";
import { BC } from "./theme";
import type { CardProps, WhyFitsCardData } from "../types";

export function BroadcastWhyFitsCard({ data, active }: CardProps<WhyFitsCardData>) {
  return (
    <BroadcastPanel active={active} bug="FIT" watermark contentStyle={{ paddingTop: 50, paddingBottom: 34 }}>
      <Rise delay={0} style={styles.cobrand}>
        {data.brand.logo ? (
          <View style={styles.logoChip}>
            <Image source={{ uri: data.brand.logo }} style={styles.logoImg} resizeMode="contain" />
          </View>
        ) : (
          <Text style={styles.brandName} numberOfLines={1}>{data.brand.name}</Text>
        )}
        <Text style={styles.cobrandX}>×</Text>
        <NomilaMark size={20} />
      </Rise>

      <BcKicker delay={60}>{data.eyebrow}</BcKicker>
      <RiseText delay={130} style={styles.lead}>{data.lead}</RiseText>

      <View style={styles.list}>
        {data.reasons.map((r, i) => (
          <Rise key={r.head} delay={200 + Math.min(i, 3) * 70} style={styles.row}>
            <Text style={styles.num}>{String(i + 1).padStart(2, "0")}</Text>
            <View style={styles.rowText}>
              <Text style={styles.head}>{r.head}</Text>
              <Text style={styles.insight}>{r.insight}</Text>
            </View>
          </Rise>
        ))}
      </View>

      <Rise delay={200 + data.reasons.length * 70 + 40} style={styles.foot}>
        <Text style={styles.footText} numberOfLines={1}>
          {data.brand.name}{data.brand.category ? ` · ${data.brand.category}` : ""}
          {data.confidence.level === "inferred" ? " · inferred from public signals" : ""}
        </Text>
      </Rise>
    </BroadcastPanel>
  );
}

const styles = StyleSheet.create({
  cobrand: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 14 },
  logoChip: {
    backgroundColor: "#FFFFFF", paddingHorizontal: 11, paddingVertical: 6,
    alignItems: "center", justifyContent: "center",
  },
  logoImg: { height: 18, width: 90 },
  brandName: {
    fontFamily: BC.condBold, fontSize: 14, letterSpacing: 1.4,
    textTransform: "uppercase", color: BC.paper,
  },
  cobrandX: { fontFamily: BC.cond, fontSize: 13, color: BC.mut },

  lead: {
    marginTop: 10, maxWidth: 290, fontFamily: BC.display, fontSize: 29, lineHeight: 32,
    textTransform: "uppercase", color: BC.paper, letterSpacing: 0.4,
  },

  list: { marginTop: 18, gap: 15 },
  row: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  num: {
    fontFamily: BC.display, fontSize: 15, lineHeight: 18, color: BC.volt,
    width: 22, paddingTop: 1,
  },
  rowText: { flex: 1 },
  head: {
    fontFamily: BC.condBold, fontSize: 12.5, letterSpacing: 1.2,
    textTransform: "uppercase", color: BC.paper,
  },
  insight: { marginTop: 3, fontFamily: BC.sans, fontSize: 12, lineHeight: 17, color: BC.mut },

  foot: { marginTop: "auto", paddingTop: 14 },
  footText: {
    fontFamily: BC.condBold, fontSize: 10, letterSpacing: 1.6,
    textTransform: "uppercase", color: BC.faint,
  },
});
