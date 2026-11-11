import React from "react";
import { View, Text, Image, Pressable, StyleSheet } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Bold, Brand, Fonts } from "../../constants/theme";

/**
 * PublicCardTile — the athlete's LIVE public Nomi Card, shown as a peer tile at the head of the
 * cards shelf (same footprint as PitchDeckTile). Distinguished as the source/root: a green "Live"
 * chip instead of a pitch status dot, the current look in the scrim, the real card cover as bg.
 * Tapping opens the card (Brand tab) to view / edit / switch look.
 */
export function PublicCardTile({
  width = 120,
  coverImage,
  lookName,
  onPress,
}: {
  width?: number;
  coverImage?: string | null;
  lookName?: string | null;
  onPress?: () => void;
}) {
  const height = Math.round((width * 4) / 3);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [{ width }, pressed ? { opacity: 0.85 } : null]}>
      <View style={[styles.sliver, styles.sliverB, { height: height - 12 }]} />
      <View style={[styles.sliver, { height: height - 12 }]} />
      <View style={[styles.art, { width, height }]}>
        {coverImage ? (
          <Image source={{ uri: coverImage }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <LinearGradient colors={["#2a1420", "#0d0b08"]} start={{ x: 0.2, y: 0 }} end={{ x: 0.9, y: 1 }} style={StyleSheet.absoluteFill} />
        )}
        <View style={styles.liveChip}>
          <View style={styles.liveDot} />
          <Text style={styles.liveTxt}>Live</Text>
        </View>
        <LinearGradient colors={["transparent", "rgba(13,11,8,0.5)", "rgba(13,11,8,0.92)"]} locations={[0, 0.45, 1]} style={styles.scrim}>
          <Text style={styles.name} numberOfLines={1}>Your card</Text>
          <Text style={styles.meta} numberOfLines={1}>{lookName ? `${lookName} · Public` : "Public profile"}</Text>
        </LinearGradient>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sliver: { position: "absolute", top: 6, right: -4, width: 12, borderRadius: 8, backgroundColor: Brand.heroBg, opacity: 0.35 },
  sliverB: { right: -8, opacity: 0.18 },
  art: { borderRadius: 18, overflow: "hidden", borderWidth: 1, borderColor: Bold.onDarkMute, backgroundColor: Brand.heroBg },
  liveChip: { position: "absolute", top: 10, left: 10, zIndex: 3, flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "rgba(255,255,255,0.18)", borderRadius: 999, paddingHorizontal: 7, paddingVertical: 3 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: Bold.onDark },
  liveTxt: { fontFamily: Fonts.bodyBold, fontSize: 9.5, fontWeight: "800", color: Bold.onDark, letterSpacing: 0.3, textTransform: "uppercase" },
  scrim: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 11, paddingTop: 24, paddingBottom: 11 },
  name: { color: "#FFFFFF", fontSize: 14, fontWeight: "800", fontFamily: "Outfit_700Bold", letterSpacing: -0.2 },
  meta: { marginTop: 2, fontSize: 10.5, fontWeight: "600", fontFamily: "Outfit_500Medium", color: "rgba(243,238,228,0.8)" },
});
