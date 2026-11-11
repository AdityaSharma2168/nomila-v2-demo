/** luxe values — "The Planks": a manifesto statement set big in Didone, then a stacked column of
 *  named pillars (gold small-caps name + a quiet serif line), hairline-divided. One hero moment,
 *  then restraint. */
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { LuxeShell, LuxeEyebrow, LuxeHairline } from "./Chrome";
import { RiseText, Rise } from "../Chrome";
import { LX } from "./theme";
import type { CardProps, ValuesCardData } from "../types";

export function LuxeValuesCard({ data, active }: CardProps<ValuesCardData>) {
  const plankDelay = (i: number) => 260 + Math.min(i, 3) * 90;
  const noteDelay = 260 + data.planks.length * 90 + 60;

  return (
    <LuxeShell bg={data.bg} active={active} justify="flex-start" watermark>
      <LuxeEyebrow delay={20}>{data.eyebrow}</LuxeEyebrow>

      <RiseText delay={140} style={styles.statement}>{data.statement}</RiseText>

      <Rise delay={220}><LuxeHairline /></Rise>

      <View style={styles.planks}>
        {data.planks.map((p, i) => (
          <Rise key={p.name} delay={plankDelay(i)} style={styles.plank}>
            {i > 0 && <View style={styles.plankRule} />}
            <Text style={styles.plankName} numberOfLines={1}>{p.name.toUpperCase()}</Text>
            {!!p.line && <Text style={styles.plankLine}>{p.line}</Text>}
          </Rise>
        ))}
      </View>

      {!!data.note && (
        <RiseText delay={noteDelay} style={styles.note}>{data.note}</RiseText>
      )}
    </LuxeShell>
  );
}

const styles = StyleSheet.create({
  statement: {
    marginTop: 4,
    fontFamily: LX.didone,
    fontSize: 34,
    lineHeight: 43,
    includeFontPadding: false,
    color: LX.ivory,
    letterSpacing: 0.2,
  },
  planks: { marginTop: 4 },
  plank: { paddingTop: 16, paddingBottom: 2 },
  plankRule: {
    height: 1,
    backgroundColor: LX.hairDim,
    marginBottom: 16,
  },
  plankName: {
    fontFamily: LX.sansMed,
    fontSize: 11,
    letterSpacing: 2.6,
    textTransform: "uppercase",
    color: LX.champagne,
  },
  plankLine: {
    marginTop: 6,
    fontFamily: LX.didone,
    fontSize: 14.5,
    lineHeight: 20,
    color: LX.ivoryDim,
  },
  note: {
    marginTop: 22,
    fontFamily: LX.didoneItalic,
    fontStyle: "italic",
    fontSize: 14,
    lineHeight: 19,
    color: LX.ivoryMut,
  },
});
