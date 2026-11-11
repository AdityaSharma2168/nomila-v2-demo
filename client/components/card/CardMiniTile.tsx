/**
 * CardMiniTile — a recognizable miniature of a deck card for the editor "spread".
 * NOT a live render of the real card (perf + legibility): instead each type shows ONE real piece
 * of the athlete's data, oversized, in the card's own dark language (ink bg, bone text, condensed
 * italic). Built from the typed `MediaKitData` card (`rich`) when we have it; falls back to a
 * type-styled tile from just {type, title, image} for hidden/library cards we don't.
 */
import React from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { T } from "../card-native/Chrome";
import type { Card } from "../card-native/types";


// Short, plain label per type (what the card IS, in the athlete's words).
const LABEL: Record<string, string> = {
  cover: "Cover", index: "Marketability", mix: "The mix", audience: "Audience",
  content: "Top posts", video: "Motion", rates: "Rates", payments: "Packages",
  whyFits: "Why it fits", story: "Story", values: "Values", achievements: "Honors", fit: "The fit",
};

function photoFrom(type: string, image: string | null, rich?: Card): string | null {
  if (image) return image;
  if (!rich) return null;
  if (rich.type === "cover" || rich.type === "fit") return rich.image ?? null;
  if (rich.type === "content") return rich.tiles.find((t) => t.image)?.image ?? null;
  if (rich.type === "video")   return rich.posterUrl ?? null;
  return null;
}

function words(s: string | undefined, n: number): string {
  return (s ?? "").trim().split(/\s+/).slice(0, n).join(" ");
}

export function CardMiniTile({
  rich, type, title, image, accent,
}: {
  rich?: Card;
  type: string;
  title: string;
  image: string | null;
  /** pink edge on the money card (fit / whyFits) */
  accent?: boolean;
}) {
  const label = LABEL[type] ?? title;
  const photo = photoFrom(type, image, rich);

  return (
    <View style={[styles.tile, accent && styles.tileAccent]}>
      {/* ── Backdrop: real photo, else the card's atmospheric dark ── */}
      {photo ? (
        <>
          <Image source={{ uri: photo }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          <LinearGradient
            colors={["rgba(12,13,16,0)", "rgba(12,13,16,0.15)", "rgba(12,13,16,0.9)"]}
            locations={[0, 0.45, 1]}
            style={StyleSheet.absoluteFill}
          />
        </>
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.atmo]} />
      )}

      {/* ── The one big datum ── */}
      <View style={styles.body} pointerEvents="none">{datum(type, rich)}</View>

      {/* ── Label foot ── */}
      <Text style={styles.label} numberOfLines={1}>{label}</Text>
      {type === "video" && (
        <View style={styles.playDot}><Feather name="play" size={11} color={T.ink} /></View>
      )}
    </View>
  );
}

// The oversized real datum per type.
function datum(type: string, rich?: Card): React.ReactNode {
  if (rich) {
    switch (rich.type) {
      case "index":
        return <Text style={styles.big}>{rich.value}</Text>;
      case "audience":
        return <Text style={styles.big}>{rich.stats?.[0]?.n ?? rich.headline}</Text>;
      case "values":
        return (
          <View style={styles.chips}>
            {rich.planks.slice(0, 3).map((p) => (
              <View key={p.name} style={styles.chip}><Text style={styles.chipText} numberOfLines={1}>{p.name}</Text></View>
            ))}
          </View>
        );
      case "story":
        return (
          <View style={styles.quoteWrap}>
            <Text style={styles.quoteMark}>“</Text>
            <Text style={styles.quoteText} numberOfLines={2}>
              {words(rich.beats?.find((b) => b.current)?.line ?? rich.beats?.[0]?.line ?? rich.close, 5)}…
            </Text>
          </View>
        );
      case "achievements":
        return (
          <View style={styles.medalWrap}>
            <Feather name="award" size={26} color={T.bone} />
            <Text style={styles.medalText} numberOfLines={2}>{rich.heroEntry?.name ?? "Honors"}</Text>
          </View>
        );
      case "whyFits":
        return <Text style={styles.fitName} numberOfLines={2}>{rich.brand?.name ?? "Why it fits"}</Text>;
      // photo-led types render on the backdrop alone (cover/content/video/fit)
      case "cover": case "content": case "video": case "fit":
        return null;
    }
  }
  // Fallback (no rich data) — a quiet type glyph so the tile still reads as a card, not an icon row.
  return <Feather name={glyphFor(type)} size={24} color="rgba(243,238,228,0.5)" />;
}

function glyphFor(type: string): keyof typeof Feather.glyphMap {
  switch (type) {
    case "index":                  return "bar-chart-2";
    case "audience":               return "users";
    case "story":                  return "book-open";
    case "values":                 return "heart";
    case "achievements":           return "award";
    case "whyFits": case "fit":    return "star";
    case "content":                return "grid";
    case "video":                  return "play";
    default:                       return "layers";
  }
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: T.ink,
    justifyContent: "flex-end",
  },
  tileAccent: { borderWidth: 1.5, borderColor: T.cardinal },
  atmo: { backgroundColor: T.ink2 },
  body: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    padding: 8,
  },
  label: {
    fontFamily: "Outfit_700Bold",
    fontSize: 9,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: "rgba(243,238,228,0.82)",
    paddingHorizontal: 9,
    paddingBottom: 8,
  },
  // big number / money
  big:      { fontFamily: T.displayItalic, fontSize: 40, color: T.bone, letterSpacing: -1 },
  // values chips
  chips: { gap: 4, alignItems: "center" },
  chip:  { borderWidth: 1, borderColor: "rgba(243,238,228,0.28)", borderRadius: 99, paddingHorizontal: 8, paddingVertical: 3 },
  chipText: { fontFamily: "Outfit_600SemiBold", fontSize: 9, color: T.bone, textTransform: "uppercase", letterSpacing: 0.4 },
  // story quote
  quoteWrap: { alignItems: "center" },
  quoteMark: { fontFamily: T.serifFamily, fontSize: 34, color: T.cardinal, lineHeight: 34 },
  quoteText: { fontFamily: T.serifFamily, fontSize: 12, color: T.bone, textAlign: "center", marginTop: -2 },
  // achievements
  medalWrap: { alignItems: "center", gap: 6 },
  medalText: { fontFamily: "Outfit_700Bold", fontSize: 10, color: T.bone, textAlign: "center" },
  // whyFits
  fitName: { fontFamily: T.displayItalic, fontSize: 18, color: T.bone, textAlign: "center", textTransform: "uppercase" },
  // video play
  playDot: {
    position: "absolute", top: 8, right: 8, width: 22, height: 22, borderRadius: 11,
    backgroundColor: "rgba(243,238,228,0.92)", alignItems: "center", justifyContent: "center",
  },
});
