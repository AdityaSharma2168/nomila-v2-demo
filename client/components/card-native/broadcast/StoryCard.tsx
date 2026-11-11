/** broadcast story — a hairline-rule timeline of beats (Anton year + where/line pairs) closed by a
 *  big volt Anton verdict line. Mirrors broadcast.ts's `.c-story` / `.story-rail` / `.beat` /
 *  `.story-close` CSS (no dot-rail like the campaign look — the web's dashed divider becomes a solid
 *  hairline here since RN's `borderStyle: "dashed"` renders solid on Android). */
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { BroadcastPanel, BcKicker } from "./Chrome";
import { RiseText, Rise } from "../Chrome";
import { BC } from "./theme";
import type { CardProps, StoryCardData } from "../types";

export function BroadcastStoryCard({ data, active }: CardProps<StoryCardData>) {
  return (
    <BroadcastPanel active={active} bug="STORY" watermark contentStyle={{ paddingTop: 50, paddingBottom: 34 }}>
      <BcKicker delay={20}>{data.eyebrow}</BcKicker>

      <View style={styles.rail}>
        {data.beats.map((b, i) => (
          <Rise
            key={`${b.year}-${i}`}
            delay={90 + Math.min(i, 4) * 60}
            style={[styles.beat, i === 0 && styles.beatFirst]}
          >
            <Text style={[styles.beatYr, b.current && styles.beatYrNow]}>{b.year}</Text>
            <View style={styles.beatTx}>
              <Text style={styles.beatWhere} numberOfLines={1}>{b.where}</Text>
              <Text style={styles.beatLine}>{b.line}</Text>
            </View>
          </Rise>
        ))}
      </View>

      <RiseText delay={90 + data.beats.length * 60 + 60} style={styles.close}>
        {data.close}
      </RiseText>
    </BroadcastPanel>
  );
}

const styles = StyleSheet.create({
  rail: { marginTop: 18 },
  beat: {
    flexDirection: "row",
    gap: 12,
    alignItems: "flex-start",
    paddingVertical: 10,
    borderTopWidth: 1,
    // Dashed borderStyle renders solid on Android — use a solid hairline instead.
    borderTopColor: BC.line,
  },
  beatFirst: { borderTopWidth: 0 },
  beatYr: {
    width: 44,
    fontFamily: BC.display,
    fontSize: 15,
    lineHeight: 18,
    includeFontPadding: false,
    textAlignVertical: "center",
    color: BC.faint,
  },
  beatYrNow: { color: BC.volt },
  beatTx: { flex: 1 },
  beatWhere: {
    fontFamily: BC.condBold,
    fontSize: 9.5,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: BC.mut,
  },
  beatLine: {
    marginTop: 2,
    fontFamily: BC.sansMed,
    fontSize: 12.5,
    lineHeight: 17,
    color: BC.paper,
  },
  close: {
    marginTop: "auto",
    paddingTop: 16,
    fontFamily: BC.display,
    fontSize: 23,
    lineHeight: 27,
    includeFontPadding: false,
    textAlignVertical: "center",
    letterSpacing: 0.3,
    textTransform: "uppercase",
    color: BC.volt,
  },
});
