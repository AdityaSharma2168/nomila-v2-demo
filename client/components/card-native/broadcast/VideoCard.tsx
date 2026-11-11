/** broadcast video — "in motion": a full-bleed autoplaying/looping clip (only the active/centered
 *  card actually decodes+plays — expo-video, mirrored EXACTLY from the campaign VideoCard's
 *  playback logic: poster-until-active gating, autoplay/pause on `active`). Only the overlay
 *  chrome is restyled to broadcast — the pitch-black scrim, the volt kicker tick, a pulsing red
 *  "live" dot instead of the campaign's cardinal motion dot, Barlow-weight note copy. Faithful
 *  port of server/services/themes/broadcast.ts's `videoCard()` + `.k-video` CSS. */
import React, { useEffect } from "react";
import { View, Image, StyleSheet } from "react-native";
import { useVideoPlayer, VideoView } from "expo-video";
import { LinearGradient } from "expo-linear-gradient";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
} from "react-native-reanimated";
import { RiseText, useRiseKey } from "../Chrome";
import { BcKicker } from "./Chrome";
import { BC } from "./theme";
import type { CardProps, VideoCardData } from "../types";

// Mirrors the web's `.k-video .scrim` gradient (pitch-black top/bottom, clear through the middle).
const SCRIM: [string, string, string, string, string] = [
  "rgba(11,12,16,0.55)", "rgba(11,12,16,0.12)", "rgba(11,12,16,0.5)",
  "rgba(11,12,16,0.95)", "#0B0C10",
];
const SCRIM_LOC: [number, number, number, number, number] = [0, 0.3, 0.58, 0.84, 1];

/** Pulsing red "live" dot — approximates the web's `@keyframes vidpulse` box-shadow ring with a
 *  scaling/fading Reanimated ring behind a solid dot. */
function LiveDot() {
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1400, easing: Easing.out(Easing.ease) }),
        withTiming(0, { duration: 0 }),
      ),
      -1,
      false,
    );
  }, [pulse]);
  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + pulse.value * 1.7 }],
    opacity: (1 - pulse.value) * 0.55,
  }));
  return (
    <View style={styles.liveDotWrap} pointerEvents="none">
      <Animated.View style={[styles.liveDotRing, ringStyle]} />
      <View style={styles.liveDot} />
    </View>
  );
}

export function BroadcastVideoCard({ data, active }: CardProps<VideoCardData>) {
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
      <LinearGradient colors={SCRIM} locations={SCRIM_LOC} style={StyleSheet.absoluteFill} pointerEvents="none" />
      <LiveDot />

      <Animated.ScrollView
        style={StyleSheet.absoluteFill}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View key={playKey} style={{ gap: 6 }}>
          <BcKicker delay={40}>{data.eyebrow}</BcKicker>
          {!!data.note && <RiseText delay={140} style={styles.note}>{data.note}</RiseText>}
        </View>
      </Animated.ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    borderRadius: 6,
    overflow: "hidden",
    backgroundColor: BC.ink,
  },
  content: {
    flexGrow: 1,
    justifyContent: "flex-end",
    paddingHorizontal: 22,
    paddingTop: 40,
    paddingBottom: 30,
    gap: 6,
  },
  liveDotWrap: {
    position: "absolute",
    top: 20,
    right: 20,
    zIndex: 7,
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  liveDotRing: {
    position: "absolute",
    width: 11,
    height: 11,
    borderRadius: 5.5,
    borderWidth: 2,
    borderColor: BC.red,
  },
  liveDot: { width: 11, height: 11, borderRadius: 5.5, backgroundColor: BC.red },
  note: { fontFamily: BC.sansMed, fontSize: 15, lineHeight: 21, color: BC.paper },
});
