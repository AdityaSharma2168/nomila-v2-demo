/** broadcast fit — "why brands partner": full-bleed photo hero (the `.k-fit .bg` treatment, via
 *  `BroadcastHero`) + kicker + "Built for / your brand." Anton display headline (surname line in
 *  volt, mirroring `.k-fit h2 em`) + category chips (`.k-fit .cats`, rendered ghost) + two "why"
 *  lines (volt tick + copy, mirroring `.k-fit .why div`) + a volt, angular Partner CTA that calls
 *  `onShare` (native stand-in for `.k-fit .cta-btn` / `#ctaShare`). Faithful port of
 *  server/services/themes/broadcast.ts `fitCard()` + its `.k-fit` CSS. */
import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { BroadcastHero, BcKicker, BcChip } from "./Chrome";
import { Rise, RiseText } from "../Chrome";
import { BC } from "./theme";
import type { CardProps, FitCardData } from "../types";

export function BroadcastFitCard({
  data,
  active,
  onShare,
  firstName,
}: CardProps<FitCardData> & { onShare?: () => void; firstName?: string }) {
  const showBody = !!data.body && data.body !== data.lead;

  return (
    <BroadcastHero bg={data.image} active={active}>
      <BcKicker delay={10}>{data.eyebrow}</BcKicker>

      <RiseText delay={70} style={styles.h2}>
        Built for{"\n"}
        <Text style={styles.h2Volt}>your brand.</Text>
      </RiseText>

      <Rise delay={130} style={styles.cats}>
        {data.tags.map((t) => (
          <BcChip key={t} tone="ghost">
            {t}
          </BcChip>
        ))}
      </Rise>

      <Rise delay={190} style={styles.why}>
        <View style={styles.whyRow}>
          <View style={styles.whyTick} />
          <Text style={styles.whyText}>{data.lead}</Text>
        </View>
        {showBody && (
          <View style={styles.whyRow}>
            <View style={styles.whyTick} />
            <Text style={styles.whyText}>{data.body}</Text>
          </View>
        )}
      </Rise>

      <Rise delay={250}>
        <Pressable style={styles.cta} onPress={onShare} accessibilityRole="button">
          <Feather name="send" size={17} color={BC.ink} />
          <Text style={styles.ctaText}>Partner with {firstName ?? "her"}</Text>
        </Pressable>
        <Text style={styles.ctaSub}>Share this kit by text or email</Text>
      </Rise>
    </BroadcastHero>
  );
}

const styles = StyleSheet.create({
  h2: {
    marginTop: 8,
    fontFamily: BC.display,
    fontSize: 56,
    lineHeight: 74,
    textTransform: "uppercase",
    color: BC.paper,
    letterSpacing: 0.4,
  },
  h2Volt: { color: BC.volt },

  cats: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 16 },

  why: { marginTop: 18, gap: 9 },
  whyRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  whyTick: {
    width: 14,
    height: 2,
    marginTop: 7,
    backgroundColor: BC.volt,
    transform: [{ skewX: "-24deg" }],
  },
  whyText: { flex: 1, fontFamily: BC.sansMed, fontSize: 13.5, lineHeight: 19, color: BC.paper },

  cta: {
    marginTop: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 15,
    backgroundColor: BC.volt,
  },
  ctaText: {
    fontFamily: BC.display,
    fontSize: 17,
    lineHeight: 20,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: BC.ink,
  },
  ctaSub: {
    marginTop: 10,
    textAlign: "center",
    fontFamily: BC.cond,
    fontSize: 11.5,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    color: BC.mut,
  },
});
