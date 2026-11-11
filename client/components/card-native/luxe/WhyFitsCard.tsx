/** luxe whyFits — co-brand lockup (logo chip or serif namemark × the Nomila mark), a Didone lead,
 *  a numbered reasons list (gold italic numerals + head + insight), and a gold-hairline footer. */
import React from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import { LuxeShell, LuxeEyebrow } from "./Chrome";
import { RiseText, Rise, NomilaMark } from "../Chrome";
import { LX } from "./theme";
import type { CardProps, WhyFitsCardData } from "../types";

export function LuxeWhyFitsCard({ data, active }: CardProps<WhyFitsCardData>) {
  return (
    <LuxeShell bg={data.bg} active={active} justify="flex-start" watermark>
      <Rise delay={20} style={styles.cobrand}>
        {data.brand.logo ? (
          <View style={styles.logoChip}>
            <Image source={{ uri: data.brand.logo }} style={styles.logoImg} resizeMode="contain" />
          </View>
        ) : (
          <Text style={styles.brandName}>{data.brand.name}</Text>
        )}
        <Text style={styles.cobrandX}>×</Text>
        <NomilaMark size={18} />
      </Rise>

      <LuxeEyebrow delay={90}>{data.eyebrow}</LuxeEyebrow>

      <RiseText delay={160} style={styles.lead}>{data.lead}</RiseText>

      <Rise delay={230} style={styles.list}>
        {data.reasons.map((r, i) => (
          <View key={r.head} style={styles.row}>
            <Text style={styles.num}>{String(i + 1).padStart(2, "0")}</Text>
            <View style={styles.rowText}>
              <Text style={styles.head}>{r.head}</Text>
              <Text style={styles.insight}>{r.insight}</Text>
            </View>
          </View>
        ))}
      </Rise>

      <Rise delay={300} style={styles.foot}>
        <Text style={styles.footText}>
          {data.brand.name}{data.brand.category ? ` · ${data.brand.category}` : ""}
          {data.confidence.level === "inferred" ? " · inferred from public signals" : ""}
        </Text>
      </Rise>
    </LuxeShell>
  );
}

const styles = StyleSheet.create({
  cobrand: { flexDirection: "row", alignItems: "center", gap: 11, marginBottom: 14 },
  logoChip: { backgroundColor: "#FFFFFF", borderRadius: 3, paddingHorizontal: 11, paddingVertical: 5 },
  logoImg: { height: 17, width: 96 },
  brandName: { fontFamily: LX.didoneItalic, fontStyle: "italic", fontSize: 15, letterSpacing: 0.3, color: LX.ivory },
  cobrandX: { fontFamily: LX.sans, fontSize: 11, color: LX.champagne },

  lead: { marginTop: 2, marginBottom: 16, fontFamily: LX.didone, fontSize: 35, lineHeight: 44, color: LX.ivory, includeFontPadding: false },

  list: { gap: 14 },
  row: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  num: { fontFamily: LX.didoneItalic, fontStyle: "italic", fontSize: 14, color: LX.or, width: 20, paddingTop: 1 },
  rowText: { flex: 1 },
  head: { fontFamily: LX.sans, fontSize: 10, letterSpacing: 2.4, textTransform: "uppercase", color: LX.ivoryDim },
  insight: { marginTop: 4, fontFamily: LX.sans, fontSize: 11.5, lineHeight: 16.5, color: "rgba(244,238,226,0.72)" },

  foot: { marginTop: 14 },
  footText: { fontFamily: LX.sans, fontSize: 8.5, letterSpacing: 2.2, textTransform: "uppercase", color: "rgba(244,238,226,0.5)" },
});
