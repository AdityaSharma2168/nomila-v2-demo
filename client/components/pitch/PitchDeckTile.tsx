import React from "react";
import { View, Text, Pressable, StyleSheet, Image } from "react-native";
import { Feather } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { Bold, Brand } from "../../constants/theme";
import { PitchAvatar } from "./PitchAvatar";
import { OpensPill } from "./OpensPill";
import { pitchStatusLabel, isNeedsRefresh } from "./pitchStatus";
import type { Pitch } from "../../hooks/use-pitches";
import { getApiUrl } from "../../lib/query-client";

/**
 * PitchDeckTile — a brand pitch as a dark mini-deck (used on the Studio shelf + Pitches grid).
 * The whole pitch, not one card: brand plaque + status dot, opens pill / stale badge, and the
 * brand name + status line on a bottom scrim. A single offset sliver behind reads as "a deck."
 */
export function PitchDeckTile({
  pitch,
  width = 150,
  onPress,
}: {
  pitch: Pitch;
  width?: number;
  onPress?: () => void;
}) {
  const height = Math.round((width * 4) / 3);
  // A hand-built deck carries its own cover card — show that rather than the placeholder gradient.
  const coverUri = pitch.coverPath ? `${getApiUrl()}${pitch.coverPath}` : null;
  const opened = pitch.status === "opened";
  const needsRefresh = isNeedsRefresh(pitch);

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [{ width }, pressed ? { opacity: 0.85 } : null]}>
      {/* deck slivers behind */}
      <View style={[styles.sliver, styles.sliverB, { height: height - 12 }]} />
      <View style={[styles.sliver, { height: height - 12 }]} />

      <View style={[styles.art, { width, height, borderColor: opened ? Bold.onDarkMute : "rgba(255,255,255,0.06)" }]}>
        <LinearGradient colors={["#1c1913", "#0d0b08"]} start={{ x: 0.2, y: 0 }} end={{ x: 0.9, y: 1 }} style={StyleSheet.absoluteFill} />
        {coverUri ? (
          <Image source={{ uri: coverUri }} style={styles.cover} resizeMode="cover" />
        ) : null}

        {/* plaque — only when there's no cover art; with a cover the deck identifies itself and the
            status is already carried by the opens pill + the status line on the scrim. */}
        {coverUri ? null : (
          <View style={styles.plaque}>
            <PitchAvatar pitch={pitch} size={30} ringColor={Brand.heroBg} />
          </View>
        )}

        {/* top-right badge */}
        {opened && pitch.opensCount > 0 ? (
          <View style={styles.tr}><OpensPill count={pitch.opensCount} compact /></View>
        ) : needsRefresh ? (
          <View style={[styles.tr, styles.staleBadge]}>
            <Feather name="refresh-cw" size={11} color={Bold.ink} />
          </View>
        ) : null}

        {/* bottom scrim */}
        <LinearGradient
          colors={["transparent", "rgba(13,11,8,0.5)", "rgba(13,11,8,0.92)"]}
          locations={[0, 0.45, 1]}
          style={styles.scrim}
        >
          <Text style={styles.name} numberOfLines={1}>{pitch.brandName}</Text>
          <Text
            style={[styles.meta, opened ? styles.metaGold : needsRefresh ? styles.metaAmber : null]}
            numberOfLines={1}
          >
            {pitchStatusLabel(pitch)}
          </Text>
        </LinearGradient>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cover: { position: "absolute", top: 0, left: 0, width: "100%", height: "100%" },
  sliver: {
    position: "absolute", top: 6, right: -4, width: 12, borderRadius: 8,
    backgroundColor: Brand.heroBg, opacity: 0.35,
  },
  sliverB: { right: -8, opacity: 0.18 },
  art: { borderRadius: 18, overflow: "hidden", borderWidth: 1, backgroundColor: Brand.heroBg },
  plaque: { position: "absolute", top: 10, left: 10, zIndex: 3 },
  tr: { position: "absolute", top: 10, right: 10, zIndex: 3 },
  staleBadge: {
    width: 22, height: 22, borderRadius: 11, backgroundColor: Bold.paper,
    alignItems: "center", justifyContent: "center",
  },
  scrim: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 11, paddingTop: 24, paddingBottom: 11 },
  name: { color: "#FFFFFF", fontSize: 15, fontWeight: "800", fontFamily: "Outfit_700Bold", letterSpacing: -0.2 },
  meta: { marginTop: 2, fontSize: 11, fontWeight: "600", fontFamily: "Outfit_500Medium", color: "rgba(243,238,228,0.72)" },
  metaGold: { color: "#F6C453", fontWeight: "700" },
  metaAmber: { color: "#F3B84A" },
});
