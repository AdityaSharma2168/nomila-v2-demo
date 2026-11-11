/**
 * luxe story — "The Arc": an editorial vertical timeline. A thin gold hairline runs down the
 * left with 3–5 beats hung off it (year · where · line), staggered top-to-bottom on active, and
 * closes with one full-width italic Didone line — the card's hero moment. Mirrors the campaign
 * StoryCard's data shape only; the look is pure luxe (ink/bone, gold as the sole accent).
 */
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { LuxeShell, LuxeEyebrow, LuxeHairline } from "./Chrome";
import { Rise, RiseText } from "../Chrome";
import { LX } from "./theme";
import type { CardProps, StoryCardData } from "../types";

export function LuxeStoryCard({ data, active }: CardProps<StoryCardData>) {
  const closeDelay = 160 + Math.min(data.beats.length, 5) * 90 + 60;
  return (
    <LuxeShell bg={data.bg} active={active} justify="flex-start" watermark>
      <LuxeEyebrow delay={20}>{data.eyebrow}</LuxeEyebrow>

      <View style={styles.timeline}>
        {data.beats.map((b, i) => {
          const isLast = i === data.beats.length - 1;
          return (
            <Rise
              key={`${b.year}-${i}`}
              delay={160 + Math.min(i, 4) * 90}
              style={[styles.beat, isLast && styles.beatLast]}
            >
              <View style={styles.railCol}>
                <View style={[styles.node, b.current && styles.nodeCurrent]} />
                {!isLast && <View style={styles.railLine} />}
              </View>
              <View style={styles.beatContent}>
                <Text style={styles.year}>{b.year}</Text>
                <Text style={styles.where}>{b.where}</Text>
                <Text style={styles.line}>{b.line}</Text>
              </View>
            </Rise>
          );
        })}
      </View>

      <Rise delay={closeDelay - 30}><LuxeHairline /></Rise>
      <RiseText delay={closeDelay} style={styles.close}>{data.close}</RiseText>
    </LuxeShell>
  );
}

const styles = StyleSheet.create({
  timeline: { marginTop: 20 },

  beat: { flexDirection: "row", alignItems: "flex-start", paddingBottom: 30 },
  beatLast: { paddingBottom: 4 },

  railCol: { width: 18, alignItems: "center" },
  node: {
    width: 9, height: 9, borderRadius: 4.5, marginTop: 3,
    backgroundColor: "transparent", borderWidth: 1.3, borderColor: LX.champagne,
  },
  nodeCurrent: { backgroundColor: LX.or, borderColor: LX.or },
  railLine: { width: 1, flex: 1, minHeight: 28, backgroundColor: LX.hair, marginTop: 6 },

  beatContent: { flex: 1, paddingLeft: 16, paddingTop: 0 },
  year: {
    fontFamily: LX.sansMed, fontSize: 10.5, letterSpacing: 2.6,
    color: LX.champagne, textTransform: "uppercase",
  },
  where: {
    marginTop: 5, fontFamily: LX.didone, fontSize: 21, lineHeight: 24, color: LX.ivory,
  },
  line: {
    marginTop: 4, fontFamily: LX.didone, fontSize: 13, lineHeight: 18, color: LX.ivoryMut,
  },

  close: {
    marginTop: 18,
    fontFamily: LX.didoneItalic,
    fontStyle: "italic",
    fontSize: 25,
    lineHeight: 30,
    color: LX.ivory,
    letterSpacing: 0.2,
  },
});
