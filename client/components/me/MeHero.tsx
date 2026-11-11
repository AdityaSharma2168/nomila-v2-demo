// Concept 0.4 · the full-bleed photo hero shared by Home, Me, What Nomila Knows, My Story and My Intelligence (DESIGN.md
// "Hero", look B, Oct 2026).
//
//   photo      her own photo edge to edge (or the blank ground when there is none), under the top-and-foot scrim
//   top row    the shell's bar in white: the NOMILA wordmark (900, .34em) and `topRight` (Home: the gear + her avatar);
//              a pushed screen replaces the wordmark with ‹ and the PARENT's name in caps (`backLabel`) and nothing else
//   foot       greeting + title as ONE uppercase display block ("Good / morning, / Mia") · eyebrow · title · subtitle
//              (a string renders as the hero line, 17/600) · then `children`
//
// Theme tokens and BoldType roles only; no literal colours, no ad-hoc sizes.

import React from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, type StyleProp, type ViewStyle } from "react-native";
import { Image as CachedImage } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { Feather } from "@expo/vector-icons";
import { haptics } from "../../lib/haptics";
import { Bold, BoldType } from "../../constants/theme";
import { cachedSource } from "../../lib/imageCache";

export interface MeHeroProps {
  photoUrl: string | null;
  /**
   * A stable id for the photo (its asset id). Media urls are signed per request, so the url changes on every launch;
   * the disk cache keys on this instead, and a photo seen before draws at once.
   */
  photoKey?: string | null;
  onBack?: () => void;
  /** The parent's name, in caps beside the back chevron ("Home", "Your plan"). Default "Home". */
  backLabel?: string;
  /** Home / Me: the greeting line that leads the display block ("Good morning,"). */
  greeting?: string | null;
  /** A section eyebrow ("My story"); uppercase by transform, never typed so. */
  eyebrow?: string | null;
  title?: string | null;
  /** The display size: the 40 hero (Home, My Intelligence) or the 28 one (a long statement, a title over a photo). */
  titleSize?: "display" | "sm";
  /** A line (or lines) under the title. Strings render in the hero line style. */
  subtitle?: React.ReactNode;
  loading?: boolean;
  /** The height of the photo; content taller than this grows it. */
  minHeight?: number;
  /** A screen's own photo element in place of the default centred cover (My Story anchors its crop to the top). */
  photo?: React.ReactNode;
  /** The deeper foot scrim (a long statement over the photo). */
  deep?: boolean;
  /** The top row's right slot (Home: the shell's gear + pressable avatar). A pushed screen has none. */
  topRight?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

export function MeHero({ photoUrl, photoKey, onBack, backLabel = "Home", greeting, eyebrow, title, titleSize = "display", subtitle, loading, minHeight = 340, photo, deep, topRight, style, children }: MeHeroProps) {
  const display = [greeting, title].filter((s): s is string => !!s && s.trim().length > 0).join("\n");
  return (
    <View style={[styles.hero, { minHeight }, style]} testID="me-hero">
      {photoUrl
        ? photo ?? (
          <CachedImage
            source={cachedSource(photoUrl, photoKey)}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={120}
            accessibilityIgnoresInvertColors
          />
        )
        : <View style={[StyleSheet.absoluteFill, styles.blank]} testID="me-hero-blank" />}
      <LinearGradient
        colors={[Bold.scrimTop, Bold.scrimClear, deep ? "rgba(0,0,0,0.2)" : Bold.scrimMid, deep ? Bold.scrimDeep : Bold.scrimFoot]}
        locations={deep ? [0, 0.26, 0.5, 1] : [0, 0.32, 0.52, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      <View style={styles.top}>
        {onBack ? (
          <Pressable onPress={() => { haptics.press(); onBack(); }} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back" style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
            <Feather name="chevron-left" size={18} color={Bold.onDark} />
            <Text style={styles.backLabel} numberOfLines={1}>{backLabel}</Text>
          </Pressable>
        ) : (
          <Text style={styles.wordmark}>NOMILA</Text>
        )}
        {topRight ?? null}
      </View>

      <View style={styles.foot}>
        {loading ? <ActivityIndicator color={Bold.onDark} /> : (
          <>
            {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
            {display ? <Text style={[styles.title, titleSize === "sm" && styles.titleSm]}>{display}</Text> : null}
            {typeof subtitle === "string" ? <Text style={styles.subtitle}>{subtitle}</Text> : subtitle ?? null}
          </>
        )}
        {children}
      </View>
    </View>
  );
}

/** A line in the hero's line style, for screens that pass several (Me's identity lines). */
export function MeHeroLine({ children, muted, strong }: { children: React.ReactNode; muted?: boolean; strong?: boolean }) {
  return <Text style={[styles.subtitleSmall, strong && styles.subtitle, muted && styles.subtitleMuted]}>{children}</Text>;
}

const styles = StyleSheet.create({
  hero:          { backgroundColor: Bold.ink, justifyContent: "space-between", overflow: "hidden" },
  blank:         { backgroundColor: Bold.heroBlank },
  top:           { height: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: Bold.gutter },
  back:          { flexDirection: "row", alignItems: "center", gap: 2, minHeight: 44, flexShrink: 1 },
  backLabel:     { ...BoldType.backLabel, color: Bold.onDark },
  pressed:       { opacity: 0.7 },
  wordmark:      { ...BoldType.wordmark, color: Bold.onDark },
  foot:          { paddingHorizontal: Bold.gutter, paddingBottom: 18, paddingTop: 32, gap: 8 },
  eyebrow:       { ...BoldType.label, color: Bold.onDarkLabel },
  title:         { ...BoldType.display, color: Bold.onDark },
  titleSm:       { ...BoldType.displaySm },
  subtitle:      { ...BoldType.heroLine, color: Bold.onDarkSoft },
  subtitleSmall: { ...BoldType.heroLineSmall, color: Bold.onDarkSoft },
  subtitleMuted: { opacity: 0.7 },
});
