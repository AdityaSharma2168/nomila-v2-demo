import React, { useEffect, useState } from "react";
import { View, Image, AccessibilityInfo, AppState, StyleSheet } from "react-native";
import { VideoView, useVideoPlayer } from "expo-video";

/**
 * MilaAvatar — Mila's animated character, five states, no Rive needed.
 *
 * States (final, approved):
 *   idle       — folded arms, one blink every 4s, mouth frozen; the default
 *   writing    — heads-down texting, thumbs tapping, glow rising from the phone
 *   speaking   — cream headset on, the mouth does the talking, hands gesture
 *   searching  — swiping a translucent screen, faint line-art athletes glide by
 *   generating — holding the thin pink pulse ring, a dot orbits it
 *
 * Usage:
 *   import { MilaAvatar, type MilaState } from "./MilaAvatar";
 *
 *   const state: MilaState =
 *     voiceState !== "idle" ? "speaking"   // from useMilaVoice()
 *     : isGenerating        ? "generating" // reply streaming / composing
 *     : isSearching         ? "searching"  // tool calls, scouting athletes
 *     : isWriting           ? "writing"    // drafting a message
 *     : "idle";
 *
 *   <MilaAvatar state={state} size={120} />
 *
 * Props:
 *   state  — which loop plays; changing it cuts cleanly to the new loop
 *   size   — diameter in px (default 120); rendered circular
 *   active — set false when she's not visible (the owning screen blurs, or the
 *            sheet/overlay she sits in hides) to pause her. App backgrounding
 *            is handled internally via AppState.
 *
 * Never empty: her still (mila-still.png) always sits underneath, filling the same circle, and the loop plays on top
 * of it. So she shows before the first frame decodes, when a browser blocks autoplay (iOS Safari without playsinline,
 * Low Power Mode, data saver) and under reduce motion — where only the still is drawn, no video view at all.
 * On web the <video> is muted (the player sets it before play) and playsInline, so mobile browsers allow autoplay.
 *
 * Assets: <repo-root>/assets/mila/mila-{idle,writing,speaking,searching,generating}.mp4 + mila-still.png
 * No new dependencies — uses expo-video, already in package.json.
 */
export type MilaState = "idle" | "writing" | "speaking" | "searching" | "generating";

const STATE_VIDEO: Record<MilaState, number> = {
  idle: require("../../../assets/mila/mila-idle.mp4"),
  writing: require("../../../assets/mila/mila-writing.mp4"),
  speaking: require("../../../assets/mila/mila-speaking.mp4"),
  searching: require("../../../assets/mila/mila-searching.mp4"),
  generating: require("../../../assets/mila/mila-generating.mp4"),
};

const MILA_STILL = require("../../../assets/mila/mila-still.png");

const STATE_LABEL: Record<MilaState, string> = {
  idle: "Mila is idle",
  writing: "Mila is writing",
  speaking: "Mila is speaking",
  searching: "Mila is searching",
  generating: "Mila is generating a reply",
};

function MilaVideo({
  source,
  size,
  active,
}: {
  source: number;
  size: number;
  active: boolean;
}) {
  // null = OS setting not yet read; she stays still until it is known.
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);
  const [appActive, setAppActive] = useState(true);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (mounted) setReduceMotion(v);
      })
      .catch(() => {
        if (mounted) setReduceMotion(false);
      });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setAppActive(s === "active"));
    return () => sub.remove();
  }, []);

  const player = useVideoPlayer(source, (p) => {
    p.loop = true;
    p.muted = true; // muted autoplay is always permitted
  });

  const shouldPlay = reduceMotion === false && appActive && active;

  useEffect(() => {
    if (shouldPlay) player.play();
    else player.pause();
  }, [shouldPlay, player]);

  // Reduce motion on: the still underneath is all she is — no video view drawn over it. (While the setting is still
  // being read the view is mounted but paused; it paints nothing until a frame decodes, so the still shows through.)
  if (reduceMotion === true) return null;

  return (
    <VideoView
      player={player}
      style={[StyleSheet.absoluteFill, { width: size, height: size, borderRadius: size / 2, backgroundColor: "transparent" }]}
      contentFit="cover"
      // Android's default SurfaceView ignores borderRadius and the parent's overflow clip, so the
      // circular mask would render as a square there. TextureView composites like a normal view.
      surfaceType="textureView"
      nativeControls={false}
      // Web only: without playsinline iOS Safari refuses to autoplay inline, so the circle stayed blank.
      playsInline
      fullscreenOptions={{ enable: false }}
      allowsPictureInPicture={false}
    />
  );
}

export function MilaAvatar({
  state,
  size = 120,
  active = true,
}: {
  state: MilaState;
  size?: number;
  active?: boolean;
}) {
  return (
    <View
      style={[styles.wrap, { width: size, height: size, borderRadius: size / 2 }]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={STATE_LABEL[state]}
    >
      {/* her still, always: shows until the loop's first frame, and stays if autoplay is blocked or motion is off */}
      <Image
        source={MILA_STILL}
        style={[StyleSheet.absoluteFill, { width: size, height: size, borderRadius: size / 2 }]}
        resizeMode="cover"
        accessibilityIgnoresInvertColors
        testID="mila-avatar-still"
      />
      {/* remount on state change: a clean cut to the new loop */}
      <MilaVideo key={state} source={STATE_VIDEO[state]} size={size} active={active} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    overflow: "hidden",
    backgroundColor: "transparent",
  },
});
