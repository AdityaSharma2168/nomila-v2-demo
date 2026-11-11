/**
 * ClipPoster — a STILL for a clip that has no poster yet.
 *
 * ─── WHY THIS IS NOT ONLY A LOCAL WORKAROUND ────────────────────────────────────────────────────
 *
 * `media_assets.gcs_thumb_path` is NULL from the moment an upload lands until the media-poster
 * cron next fires. That window is MINUTES IN PRODUCTION and it never closes on a laptop, where
 * `processPosterBatch` is not registered as an in-process cron at all and every in-process cron is
 * gated on `NODE_ENV === "production"`. So a freshly-uploaded clip is a blank filmstrip tile on
 * every device, and this closes that window everywhere rather than papering over a dev gap.
 *
 * ─── IT IS A STILL, AND MUST NEVER BECOME A PLAYER ──────────────────────────────────────────────
 *
 * Muted at construction, never played, no controls. `ClipPoster` and `ClipPlayer` look similar and
 * are opposites: one must not play and the other must. They are deliberately separate components
 * rather than one behind a flag, because the flag is how a strip of ten tiles ends up all playing
 * at once.
 *
 * ─── WHERE IT MAY BE USED, AND WHERE IT MAY NOT ─────────────────────────────────────────────────
 *
 * ⚠️  NOT IN THE MEDIA-LIBRARY GRID. A grid decodes one video per tile across a long, scrolling
 * list, which is the exact cost a poster exists to avoid — paid on every tile, including the ones
 * that already have an image. The grid stays poster-reliant: blank locally, postered in production.
 * That is honest rather than uniform.
 *
 * Used where there are a handful of tiles and the first frame is the point: the Studio clips strip,
 * and the MediaDetail preview.
 */
import React from "react";
import { StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { Feather } from "@expo/vector-icons";
import { useVideoPlayer, VideoView } from "expo-video";
import { Colors } from "../../constants/theme";
import { previewKind, VIDEO_FILL, type PreviewSource } from "./playerBox";

export function ClipPoster({
  source,
  style,
  /** Drawn while a frame is still decoding, and for `empty`. */
  icon = "film",
  contentFit = "cover",
}: {
  source: PreviewSource;
  style?: object;
  icon?: React.ComponentProps<typeof Feather>["name"];
  contentFit?: "cover" | "contain";
}) {
  const kind = previewKind(source);

  return (
    <View style={[styles.box, style]}>
      {/*
        The placeholder sits UNDERNEATH rather than instead of, and that is not belt-and-braces.
        expo-video renders nothing until the first frame is decoded, so a poster-less tile is
        blank-then-frame — and on a cold library that blank is what most tiles show first.
      */}
      <View style={styles.ph}>
        <Feather name={icon} size={18} color={Colors.light.textQuiet} />
      </View>

      {kind === "image" ? (
        <Image
          source={{ uri: source.thumbUrl! }}
          style={StyleSheet.absoluteFill}
          contentFit={contentFit}
        />
      ) : kind === "frame" ? (
        <FirstFrame uri={source.videoUrl!} contentFit={contentFit} />
      ) : null}
    </View>
  );
}

/**
 * One paused frame of a video.
 *
 * Its own component so the player hook is only ever mounted for the `frame` case — a hook called
 * unconditionally in `ClipPoster` would construct a decoder for every tile that already has an
 * image, which is the whole cost this is trying not to pay.
 */
function FirstFrame({
  uri,
  contentFit,
}: {
  uri: string;
  contentFit: "cover" | "contain";
}) {
  const player = useVideoPlayer(uri, (p) => {
    // Muted and NOT played. A strip of tiles that all start making noise is worse than ten blanks.
    p.muted = true;
    p.loop = false;
    // Some platforms decode nothing until a position is requested; asking for 0 is what makes the
    // first frame appear without ever entering a playing state.
    p.currentTime = 0;
  });

  return (
    <VideoView
      player={player}
      // VIDEO_FILL, not absoluteFill: a <video> renders at its intrinsic size otherwise, which on
      // a 92 pt tile means a 1080 pt element cropped to a thumbnail-sized window of one corner.
      style={VIDEO_FILL}
      contentFit={contentFit}
      nativeControls={false}
      // A still must not offer either of these — both are routes back into playing.
      fullscreenOptions={{ enable: false }}
      allowsPictureInPicture={false}
    />
  );
}

const styles = StyleSheet.create({
  box: {
    overflow: "hidden",
    backgroundColor: Colors.light.backgroundSecondary,
  },
  ph: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
});
