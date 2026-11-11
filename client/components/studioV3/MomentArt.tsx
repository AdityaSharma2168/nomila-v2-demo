// A moment's picture, never a bare date (design "Studio and Home, designed", 20 Oct 2026). In order:
//   1. the photo of the post already prepared for it (useKitPhoto, by its kit action);
//   2. an atmosphere image for it (hooks/use-moment-images: no people, chosen for the moment's kind and name);
//   3. its kind's card: a deep gradient in the kind's colours, the kind's glyph, and the kind's word as faint texture.
// The date rides on top as a small calendar chip (`chip`), so the date is information, not the picture.
// Used by Studio (feed, Ideas shelf) and Home (the Moments circle, the briefing's moment card).

import React from "react";
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Feather } from "@expo/vector-icons";
import { Accent, Bold, BoldType } from "../../constants/theme";
import { Photo } from "../ui/Photo";
import { useKitPhoto } from "../homeV3/useKitPhoto";
import { MOMENT_KIND_WORDS, momentCategoryOf, type StoryItem } from "../../lib/homeV3Logic";
import type { MomentCategory } from "../../../shared/plan";

type IconName = React.ComponentProps<typeof Feather>["name"];

const GLYPH: Record<MomentCategory, IconName> = {
  holiday_awareness: "sun",
  league: "award",
  cultural_trend: "trending-up",
  schedule: "calendar",
  partner_campaign: "briefcase",
};

export function MomentArt({ story, imageUrl, style, size = "tile", chip = true }: {
  story: StoryItem;
  /** Its atmosphere image, when the picker found one. */
  imageUrl?: string | null;
  style?: StyleProp<ViewStyle>;
  /** How much the card draws: a full-screen feed card, a shelf tile, or a small thumb / circle face. */
  size?: "full" | "tile" | "thumb";
  /** The calendar chip on top (off for the small faces). */
  chip?: boolean;
}) {
  const kitPhoto = useKitPhoto(story.kitActionId ?? null);
  const photo = kitPhoto ?? imageUrl ?? null;
  const cat = momentCategoryOf(story);
  const small = size === "thumb";
  return (
    <View style={[styles.wrap, style]} testID={`moment-art-${photo ? "photo" : "card"}`}>
      {photo ? (
        <Photo uri={photo} style={StyleSheet.absoluteFill} transition={0} />
      ) : (
        <LinearGradient colors={Accent.momentGround[cat] ?? Accent.momentGround.schedule} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill}>
          {small ? (
            <View style={styles.center}><Feather name={GLYPH[cat]} size={18} color={Bold.onDark} /></View>
          ) : (
            <>
              <Feather name={GLYPH[cat]} size={size === "full" ? 28 : 18} color={Bold.onDark} style={styles.glyph} />
              <Text style={[styles.texture, size === "full" && styles.textureFull]}>
                {(MOMENT_KIND_WORDS[cat] ?? "").toUpperCase()}
              </Text>
            </>
          )}
        </LinearGradient>
      )}
      {chip && !small && story.dateFace ? (
        <View style={[styles.chip, size === "full" && styles.chipFull]} testID="moment-art-date">
          {story.dateFace.top ? <Text style={styles.chipTop}>{story.dateFace.top}</Text> : null}
          <Text style={styles.chipBig}>{story.dateFace.big}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap:       { overflow: "hidden", backgroundColor: Accent.hero },
  center:     { flex: 1, alignItems: "center", justifyContent: "center" },
  glyph:      { position: "absolute", top: 14, left: 14 },
  // The kind's word as texture, oversized and running off the bottom-left edge.
  texture:    { ...BoldType.screenTitle, position: "absolute", left: -6, bottom: -14, fontSize: 64, lineHeight: 70, letterSpacing: -2, color: Accent.momentTexture, width: 900 },
  textureFull: { fontSize: 120, lineHeight: 128, bottom: "30%" },
  chip:       { position: "absolute", top: 10, right: 10, minWidth: 40, paddingVertical: 4, paddingHorizontal: 6, borderRadius: 10, backgroundColor: Bold.paper, alignItems: "center" },
  chipFull:   { top: 110, right: Bold.gutter, minWidth: 54, paddingVertical: 6 },
  chipTop:    { ...BoldType.chip, fontSize: 9, lineHeight: 11, letterSpacing: 0.9, color: Accent.pink },
  chipBig:    { ...BoldType.headedTitle, fontSize: 18, lineHeight: 21, color: Bold.ink },
});
