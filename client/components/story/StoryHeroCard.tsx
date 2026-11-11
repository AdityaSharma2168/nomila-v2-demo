// Concept 0.4 · My Story S1 — the hero as a card, for a host that already has a header (the Brand tab's Story tab).
// The Me stack's My Story uses the full-bleed MeHero instead; both show the same statement and the same Why affordance.
//
//   photo      her best eligible photo (lib/myStoryLogic storyImagery), under the hero scrim; the blank ground when none.
//              The crop is anchored to the TOP of the image (a landscape post in a tall frame keeps its heads)
//   statement  the hero statement, exactly (throughline → essence → positioning.current, short), in display caps
//   why        "Why Nomila sees this" — the basis and the strength live in the sheet, never on the face

import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { Bold, BoldType } from "../../constants/theme";
import { SECTION } from "../../lib/myStoryLogic";
import { WhyButton } from "./MyStoryBody";
import { cachedSource } from "../../lib/imageCache";

export function StoryHeroCard({ photoUrl, statement, onWhy }: { photoUrl: string | null; statement: string; onWhy?: () => void }) {
  return (
    <View style={styles.card} testID="story-hero-card">
      {photoUrl
        ? <Image source={cachedSource(photoUrl)} style={StyleSheet.absoluteFill} cachePolicy="memory-disk" contentFit="cover" contentPosition="top" accessibilityIgnoresInvertColors />
        : <View style={[StyleSheet.absoluteFill, styles.blank]} />}
      <LinearGradient colors={[Bold.scrimTop, Bold.scrimClear, "rgba(0,0,0,0.2)", Bold.scrimDeep]} locations={[0, 0.26, 0.5, 1]} style={StyleSheet.absoluteFill} />
      <View style={styles.foot}>
        <Text style={styles.eyebrow}>{SECTION.hero.eyebrow}</Text>
        <Text style={styles.statement}>{statement}</Text>
        {onWhy ? <View style={styles.whyRow}><WhyButton onPress={onWhy} onHero /></View> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card:      { marginHorizontal: Bold.gutter, marginTop: 8, minHeight: 440, borderRadius: Bold.radius.card, overflow: "hidden", backgroundColor: Bold.ink, justifyContent: "flex-end" },
  blank:     { backgroundColor: Bold.heroBlank },
  foot:      { paddingHorizontal: Bold.gutter, paddingBottom: 18, paddingTop: 48, gap: 8 },
  eyebrow:   { ...BoldType.label, color: Bold.onDarkLabel },
  statement: { ...BoldType.displaySm, color: Bold.onDark },
  whyRow:    { flexDirection: "row", justifyContent: "flex-end", marginTop: 4 },
});
