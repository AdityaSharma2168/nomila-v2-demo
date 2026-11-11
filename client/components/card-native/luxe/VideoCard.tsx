/**
 * luxe video — "in motion": the couture grade/frame plate over a full-bleed autoplaying clip,
 * with a gold eyebrow and a closing Didone line (mirrors luxe.ts's videoCard: same chrome as the
 * other luxe cards, a still poster swapped for the clip). Video playback logic (useVideoPlayer +
 * VideoView, poster-until-active gating) is ported EXACTLY from the campaign VideoCard — only the
 * overlay chrome is restyled to luxe.
 */
import React, { useEffect } from "react";
import { View, Image, StyleSheet } from "react-native";
import { useVideoPlayer, VideoView } from "expo-video";
import { LinearGradient } from "expo-linear-gradient";
import Animated from "react-native-reanimated";
import { RiseText, useRiseKey } from "../Chrome";
import { LuxeEyebrow } from "./Chrome";
import { LX } from "./theme";
import type { CardProps, VideoCardData } from "../types";

const TOP_SCRIM: [string, string, string] = ["rgba(12,10,7,0.58)", "rgba(12,10,7,0.12)", "rgba(12,10,7,0)"];
const BOT_SCRIM: [string, string, string, string] = ["rgba(12,10,7,0)", "rgba(12,10,7,0.42)", "rgba(12,10,7,0.74)", "rgba(8,6,4,0.98)"];

export function LuxeVideoCard({ data, active }: CardProps<VideoCardData>) {
  const playKey = useRiseKey(active);
  const player = useVideoPlayer(data.videoUrl, (p) => {
    p.loop = true;
    p.muted = true;
  });

  // Only the centered card should actually be decoding/playing video.
  useEffect(() => {
    if (active) player.play();
    else player.pause();
  }, [active, player]);

  return (
    <View style={styles.card}>
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {data.posterUrl && !active ? (
          <Image source={{ uri: data.posterUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <VideoView
            player={player}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            nativeControls={false}
          />
        )}
      </View>

      <LinearGradient colors={TOP_SCRIM} locations={[0, 0.22, 0.4]} style={StyleSheet.absoluteFill} pointerEvents="none" />
      <LinearGradient colors={BOT_SCRIM} locations={[0.3, 0.48, 0.66, 1]} style={StyleSheet.absoluteFill} pointerEvents="none" />
      <View style={styles.frame} pointerEvents="none" />
      <View style={styles.motionDot} pointerEvents="none" />

      <Animated.ScrollView
        style={StyleSheet.absoluteFill}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        bounces
      >
        <View key={playKey} style={styles.riseWrap}>
          <LuxeEyebrow delay={40}>{data.eyebrow}</LuxeEyebrow>
          <RiseText delay={130} style={styles.note}>{data.note}</RiseText>
        </View>
      </Animated.ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { flex: 1, borderRadius: 24, overflow: "hidden", backgroundColor: LX.noir },
  frame: {
    position: "absolute", top: 11, left: 11, right: 11, bottom: 11,
    borderRadius: 18, borderWidth: 1, borderColor: LX.hairDim,
  },
  motionDot: {
    position: "absolute", top: 22, right: 22, zIndex: 7,
    width: 8, height: 8, borderRadius: 4, backgroundColor: LX.rouge,
  },
  content: { flexGrow: 1, justifyContent: "flex-end", paddingHorizontal: 24, paddingTop: 44, paddingBottom: 30 },
  riseWrap: { width: "100%" },
  note: { fontFamily: LX.didone, fontSize: 40, lineHeight: 50, letterSpacing: 0.4, color: LX.ivory, marginTop: 2, includeFontPadding: false },
});
