/**
 * ClipPlayer — a generated clip, played WHERE IT WAS MADE.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
 *
 * Studio has no player. `AssetViewer.tsx` handles images and contains no mention of video at all;
 * `ThreadCards.tsx` renders anything that is not an IMAGE as a film icon and a door out to
 * MediaDetail — the library's analysis screen — and `MadeShelf.tsx` does the same for its tiles. So
 * a clip currently bounces out of Studio the moment it is made, which makes watching the pipeline
 * in Studio pointless: the one thing you want to check is whether the clip is any good.
 *
 * ─── NO NEW DEPENDENCY ──────────────────────────────────────────────────────────────────────────
 *
 * `expo-video` is already in package.json and already used by screens/StudioScreen.tsx and the
 * three card-native VideoCards. `expo-av` is deprecated and is not used here.
 *
 * ─── IT PLAYS THE MP4, NOT A POSTER ─────────────────────────────────────────────────────────────
 *
 * Deliberate, and it is not an optimisation. A generated clip is written with NO poster
 * (studio/videoRunner.ts stores the asset and sets no thumb); posters are produced afterwards by a
 * cron worker (services/videoPoster.ts, driven by /api/internal/media-poster-cron). The job route
 * returns `url` and no `thumbUrl` at all. So at the moment a clip lands there is nothing to show
 * but the video itself, and anything built on a thumbnail would render an empty tile for however
 * long the cron takes.
 *
 * ⚠️ [verifiable only after flag-flip] That a real Veo mp4 decodes and plays. `STUDIO_VIDEO_ENABLED`
 * is off, so no clip exists to try. Device acceptance is Adi's.
 *
 * DESIGN.md: radius `lg`, never below `xs`; nothing blurred; controls are the platform's.
 */
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useVideoPlayer, VideoView, type VideoPlayer } from "expo-video";
import { HapticPressable } from "../HapticPressable";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";
import { MAX_PLAYER_HEIGHT, playerBox, VIDEO_FILL } from "./playerBox";

/**
 * The bounded, correctly-shaped box a video is drawn in — WITHOUT owning the player.
 *
 * ─── WHY THIS IS SEPARATE FROM `ClipPlayer` ─────────────────────────────────────────────────────
 *
 * `ClipPlayer` constructs its own player from a uri, which is exactly right for a card that plays
 * one clip and is never told to do anything else. A PREVIEW is the opposite: its source changes as
 * she taps, it is seeked from outside, and it has to be stopped at an out-point — all of which need
 * the player to be owned by the caller.
 *
 * So the view is extracted and `ClipPlayer` renders it. This is ADDITIVE: every existing caller
 * goes through `ClipPlayer` unchanged and draws exactly what it drew before. The alternative —
 * making `ClipPlayer` take a player — would have made every surface that shows a clip construct one
 * itself, which is the rewrite this split exists to avoid.
 */
export function PlayerSurface({
  player,
  ratio = 9 / 16,
  maxHeight,
  fill = false,
  radius,
  children,
}: {
  player: VideoPlayer;
  ratio?: number;
  maxHeight?: number;
  /**
   * Full-bleed instead of the bounded box: the frame fills its parent edge to edge, the video is
   * cropped to cover it, and there are NO native controls, fullscreen or picture-in-picture — for a
   * surface that draws its own buttons over the video (the Studio "For you" feed), where the
   * platform's transport would sit on top of them. Off by default, so every existing caller is
   * unchanged. `ratio` and `maxHeight` are ignored while it is on.
   */
  fill?: boolean;
  /** The bounded box's corner, when a surface's spec differs from this one's (look B cards and media: 6). */
  radius?: number;
  /**
   * Drawn INSIDE the frame, over the video — in practice a caption. The frame is the box the
   * stitch's target shape makes, so something placed in it by percentage sits where the engine
   * will put it.
   */
  children?: React.ReactNode;
}) {
  if (fill) {
    return (
      <View style={styles.fill}>
        <VideoView
          player={player}
          style={VIDEO_FILL}
          contentFit="cover"
          nativeControls={false}
          fullscreenOptions={{ enable: false }}
          allowsPictureInPicture={false}
        />
        {children}
      </View>
    );
  }
  return (
    <View style={[styles.frame, playerBox(ratio, maxHeight), radius !== undefined && { borderRadius: radius }]}>
      {/*
        VIDEO_FILL, not StyleSheet.absoluteFill — see playerBox.ts. A <video> is a replaced element
        and will render at its INTRINSIC size when width/height are auto, insets or no insets.
      */}
      <VideoView
        player={player}
        style={VIDEO_FILL}
        contentFit="contain"
        nativeControls
        /*
         * ⚠️  WITHOUT THIS, CHROME HAS NO FULLSCREEN BUTTON. expo-video's web view writes
         * `controlsList="nofullscreen"` unless `fullscreenOptions.enable` is true
         * (VideoView.web.js: `controlsList: props.fullscreenOptions?.enable ? undefined : 'nofullscreen'`;
         * SDK 55 removed the old `allowsFullscreen` prop),
         * and that attribute REMOVES the control from the native control set rather than merely
         * declining to add one. A portrait clip in a 236 pt box is exactly the case where watching
         * it full size matters most.
         */
        fullscreenOptions={{ enable: true }}
        allowsPictureInPicture
      />
      {children}
    </View>
  );
}

export function ClipPlayer({
  uri,
  /** 9:16 is what the engine makes (studio/config.ts, the vertical clip); overridable for a probe. */
  ratio = 9 / 16,
  /**
   * The tallest this player may be. See playerBox.ts for why the cap is on HEIGHT and the width is
   * derived from it — capping height alone leaves the box the wrong shape, because Yoga gives a
   * definite `width: "100%"` priority over `aspectRatio`.
   */
  maxHeight,
  /**
   * DEFAULTED TO TODAY'S VALUE, so every existing caller is byte-identical and only a caller with
   * a reason opts out.
   *
   * ⚠️  MUTED IS RIGHT FOR A CLIP AND WRONG FOR A STITCH. An observation surface that autoplays
   * and loops must not start making noise on its own — but the last stage of the stitch pipeline
   * is MUSIC, and a bed nobody can hear is a bed nobody can review. `nativeControls` means she
   * could unmute by hand; needing to is a review step that will quietly not happen.
   */
  muted = true,
}: {
  uri: string;
  ratio?: number;
  muted?: boolean;
  maxHeight?: number;
}) {
  const player = useVideoPlayer(uri, (p) => {
    // A few seconds of motion reads better repeated than played once and frozen.
    p.loop = true;
    p.muted = muted;
  });

  // Bounded, and centred once bounded — a capped box narrower than its column would otherwise sit
  // against the left edge with dead space beside it.
  return <PlayerSurface player={player} ratio={ratio} maxHeight={maxHeight} />;
}

/**
 * Mute, as a control you can SEE the state of.
 *
 * ⚠️  DELIBERATELY NOT ON `PlayerSurface`, which is a dumb box. Mute is a decision about one
 * viewing, and hanging state off the shared surface would have changed the stitch result's
 * behaviour as a side effect of changing a preview's. So each surface keeps its own state and they
 * share only the control — which is what stops two review surfaces drifting apart in how they look
 * and where the button is.
 *
 * Custom rather than the native transport's own: native controls auto-hide, so "am I about to make
 * noise" would not be visible at a glance, and they differ between web and iOS — the two places
 * this gets checked.
 */
export function MuteToggle({
  muted,
  onToggle,
  testID,
}: {
  muted: boolean;
  onToggle: () => void;
  testID: string;
}) {
  return (
    <HapticPressable
      testID={testID}
      style={styles.mute}
      onPress={onToggle}
      accessibilityRole="switch"
      accessibilityState={{ checked: !muted }}
      accessibilityLabel={muted ? "Unmute" : "Mute"}
      hitSlop={8}
    >
      <Feather
        name={muted ? "volume-x" : "volume-2"}
        size={15}
        color={Colors.light.onHero}
      />
    </HapticPressable>
  );
}

/** Where a clip was, with nothing to play — the object is gone, or was never stored. */
export function ClipMissing() {
  return (
    <View
      style={styles.missing}
      accessibilityRole="text"
      accessibilityLabel="Clip unavailable"
    >
      <Feather name="slash" size={16} color={Colors.light.tabIconDefault} />
      <Text style={styles.missingTxt}>No clip</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  mute: {
    position: "absolute",
    top: Spacing.sm,
    right: Spacing.sm,
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: BorderRadius.full,
    // The one sanctioned translucent overlay: a floating control over media. Not blurred.
    backgroundColor: "rgba(13,11,8,0.55)",
  },
  fill: {
    ...StyleSheet.absoluteFill,
    overflow: "hidden",
    backgroundColor: "#0D0B08",
  },
  frame: {
    width: "100%",
    alignSelf: "center",
    borderRadius: BorderRadius.lg,
    overflow: "hidden",
    // DESIGN.md: a video sits on the dark inset, the same #0D0B08 the score rings are paired with.
    backgroundColor: "#0D0B08",
  },
  missing: {
    width: "100%",
    alignSelf: "center",
    // The same cap as the player: a MISSING clip that is 693 pt tall is the same layout bug, and
    // it was the placeholder for the case where there is nothing to look at at all.
    maxWidth: MAX_PLAYER_HEIGHT * (9 / 16),
    maxHeight: MAX_PLAYER_HEIGHT,
    aspectRatio: 9 / 16,
    borderRadius: BorderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.xs,
    backgroundColor: Colors.light.backgroundSecondary,
  },
  missingTxt: {
    fontFamily: Fonts.body,
    fontSize: 13,
    color: Colors.light.textMuted,
  },
});
