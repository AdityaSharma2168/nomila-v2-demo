import React from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import { Brand } from "../../constants/theme";
import { PitchStatusDot } from "./PitchStatusDot";
import { brandLogoUri } from "../../lib/brand-logo";
import type { Pitch } from "../../hooks/use-pitches";

/** Brand plaque: logo (or initials) on the dark hero ink, with the status dot pinned bottom-right. */
export function PitchAvatar({
  pitch,
  size = 40,
  ringColor = "#FFFFFF",
}: {
  pitch: Pick<Pitch, "brandName" | "brandLogo" | "brandDomain" | "status" | "stale">;
  size?: number;
  ringColor?: string;
}) {
  const logo = brandLogoUri(pitch.brandLogo, pitch.brandDomain);
  const initials = pitch.brandName
    .replace(/[^A-Za-z0-9 ]/g, "")
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const dotSize = Math.round(size * 0.3);
  return (
    <View style={{ width: size, height: size }}>
      <View style={[styles.tile, { width: size, height: size, borderRadius: size * 0.26 }]}>
        {logo ? (
          // contain, not cover: brand logos are usually WIDE wordmarks, and cover crops them to the
          // middle few letters ("gorjana" becomes "or"). Inset slightly so the mark never touches the edge.
          <Image source={{ uri: logo }} style={{ width: "82%", height: "82%" }} resizeMode="contain" />
        ) : (
          <Text style={[styles.initials, { fontSize: size * 0.38 }]}>{initials || "?"}</Text>
        )}
      </View>
      <View style={{ position: "absolute", right: -dotSize * 0.28, bottom: -dotSize * 0.28 }}>
        <PitchStatusDot status={pitch.status} stale={pitch.stale} size={dotSize} borderColor={ringColor} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    backgroundColor: Brand.heroBg,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  initials: {
    color: "#F2E7CE",
    fontFamily: "Outfit_700Bold",
    fontWeight: "800",
  },
});
