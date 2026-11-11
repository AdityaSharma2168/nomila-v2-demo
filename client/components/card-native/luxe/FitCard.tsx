/** luxe fit — "the invitation": heavy-graded photo lead, Didone lead line, gold-hairline chips,
 *  and a couture gold CTA (native: opens the existing Share flow via `onShare`, wired by the deck).
 *  Faithful port of server/services/themes/luxe.ts `fitCard()` + its `.didone-xl` / `.chip` / `.cta`
 *  CSS — same photo-led "closer" treatment as the campaign FitCard, luxe dress. */
import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Feather } from "@expo/vector-icons";
import { LuxeShell, LuxeEyebrow } from "./Chrome";
import { RiseText, Rise } from "../Chrome";
import { LX } from "./theme";
import type { CardProps, FitCardData } from "../types";

export function LuxeFitCard({
  data,
  active,
  onShare,
  firstName,
}: CardProps<FitCardData> & { onShare?: () => void; firstName?: string }) {
  return (
    <LuxeShell bg={data.image} active={active}>
      <LuxeEyebrow delay={20}>{data.eyebrow}</LuxeEyebrow>
      <RiseText delay={110} style={styles.lead}>
        {data.lead}
      </RiseText>
      {!!data.body && (
        <RiseText delay={180} style={styles.body}>
          {data.body}
        </RiseText>
      )}
      {data.tags?.length > 0 && (
        <Rise delay={250} style={styles.chips}>
          {data.tags.map((t) => (
            <View key={t} style={styles.chip}>
              <Text style={styles.chipText}>{t}</Text>
            </View>
          ))}
        </Rise>
      )}
      <Rise delay={320}>
        <Pressable onPress={onShare} accessibilityRole="button" style={styles.ctaWrap}>
          <LinearGradient
            colors={["#B08D50", LX.or, "#B08D50"]}
            locations={[0, 0.45, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.cta}
          >
            <Feather name="send" size={14} color="#191307" />
            <Text style={styles.ctaText}>Partner with {firstName ?? "her"}</Text>
          </LinearGradient>
        </Pressable>
        <Text style={styles.ctaSub}>Share this kit by text or email</Text>
      </Rise>
    </LuxeShell>
  );
}

const styles = StyleSheet.create({
  lead: {
    fontFamily: LX.didone,
    fontSize: 36,
    lineHeight: 45,
    includeFontPadding: false,
    letterSpacing: 0.3,
    color: LX.ivory,
  },
  body: {
    marginTop: 12,
    fontFamily: LX.sans,
    fontSize: 12.5,
    lineHeight: 20,
    letterSpacing: 1.6,
    color: LX.ivoryDim,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14 },
  chip: {
    borderWidth: 1,
    borderColor: LX.hair,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 7,
    backgroundColor: "rgba(12,10,7,0.45)",
  },
  chipText: {
    fontFamily: LX.didoneItalic,
    fontStyle: "italic",
    fontSize: 13.5,
    letterSpacing: 0.6,
    color: LX.ivory,
  },
  ctaWrap: { marginTop: 18 },
  cta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 999,
  },
  ctaText: {
    fontFamily: LX.sansMed,
    fontSize: 11,
    letterSpacing: 4.4,
    textTransform: "uppercase",
    color: "#191307",
  },
  ctaSub: {
    marginTop: 11,
    textAlign: "center",
    fontFamily: LX.sans,
    fontSize: 9,
    letterSpacing: 2.7,
    textTransform: "uppercase",
    color: LX.ivoryMut,
  },
});
