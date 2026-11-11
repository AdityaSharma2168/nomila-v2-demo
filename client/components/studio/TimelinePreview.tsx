/**
 * TimelinePreview — the "watch what you're building" surface.
 *
 * ─── WHY IT OWNS ITS PLAYER, WHERE `ClipPlayer` OWNS ITS OWN ────────────────────────────────────
 *
 * A card plays one clip and is never told to do anything else. This is the opposite: its source
 * changes as she taps, it is seeked from outside on every frame of a scrub, and it has to stop at
 * an out-point. So it holds the player and draws through `PlayerSurface`, which is the view half of
 * `ClipPlayer` and nothing more. Every other surface still goes through `ClipPlayer` unchanged.
 *
 * ─── IT PLAYS THE REAL MP4. ALWAYS. ─────────────────────────────────────────────────────────────
 *
 * ⚠️  NO POSTER FALLBACK EVER REACHES THIS FILE. `ClipPoster` is for TILES — a strip, a track, a
 * grid — where a still is the honest thing to draw and a decoder per tile is the cost to avoid.
 * A preview showing a still instead of the video is the V7 symptom, and it is indistinguishable
 * from a broken player. When there is nothing selected this draws an EMPTY STATE, which is a
 * different claim: "nothing chosen", not "here is your clip".
 *
 * ─── A SEEK AND A LOAD ARE DIFFERENT, AND CONFUSING THEM RUINS THE SCRUB ────────────────────────
 *
 * A pan emits an update per frame. If every one of them called `replaceAsync`, dragging inside a
 * single clip would re-open that file dozens of times a second — a slideshow, not a scrub. So a
 * request for a source that is ALREADY LOADED is a bare `currentTime` write, and only a genuine
 * change of source pays for a load. Crossing a clip boundary is therefore the one expensive move
 * on this surface, deliberately and unavoidably.
 *
 * ─── THE TWO RACES ──────────────────────────────────────────────────────────────────────────────
 *
 * `replaceAsync` is asynchronous and `currentTime` only means anything once the new source is
 * `readyToPlay`. Both of the ways that bites are handled below and both are SILENT when wrong:
 * seeking too early lands on the outgoing item, and a load that finishes late seeks whatever is
 * loaded now. See `arrive` and the cleanup flag.
 *
 * DESIGN.md: radius `lg`; Feather icons; a floating control over media is the one sanctioned place
 * for a translucent overlay; every weight paired with its Outfit face.
 */
import React, { useEffect, useRef, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useVideoPlayer } from "expo-video";
import { MuteToggle, PlayerSurface } from "./ClipPlayer";
import { MAX_PLAYER_HEIGHT, playerBox } from "./playerBox";
import type { CaptionBand } from "../../hooks/use-studio-stitch";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";

/** What the preview has been asked to show. */
export interface PreviewSpec {
  /**
   * ⚠️  CHANGES ON EVERY REQUEST, INCLUDING FOR THE SAME CLIP — and that is the point.
   *
   * Tapping the clip that is already showing has to restart it, because "tap it again to watch it
   * again" is the first thing anyone tries. Keying the effect on the uri would make that a no-op,
   * and would also make every frame of a scrub inside one clip a no-op.
   */
  token: number;
  uri: string;
  /** SOURCE seconds — where to sit inside the original upload. */
  startSec: number;
  /** SOURCE seconds, or null to play to the end of the source. */
  endSec: number | null;
  /**
   * Whether this request wants playback, or only the frame.
   *
   * ⚠️  A SCRUB MUST NOT PLAY. A clip running on underneath a finger that is dragging is the same
   * failure as not seeking at all — the frame she is pointing at is gone by the time she looks.
   * So a scrub sets this false and the player is explicitly PAUSED, not merely left alone.
   */
  autoplay: boolean;
  /**
   * `uri` is one of her PHOTOS, held on the timeline — shown as the picture, fitted inside the frame
   * on the dark inset the way the stitch pads it, and never handed to the video player (it would
   * try to load a JPEG as a video and keep the frame it had). Absent means a clip.
   */
  still?: true;
}

export function TimelinePreview({
  spec,
  /** The shape she chose, so the box matches what the stitch will produce. */
  ratio,
  /**
   * Where playback has got to, in SOURCE seconds, so the playhead can follow it.
   *
   * ⚠️  THIS IS A REPORT, NOT A REQUEST. Whatever the caller does with it must never come back as a
   * new `spec` — see the playhead/seek split in TimelineBuilder. If progress produced a seek, every
   * tick would re-seek the player and playback would stutter or stall outright.
   */
  onProgress,
  /**
   * The caption on the clip being shown, as the SERVER drew it — see `useCaptionPreview`. Null when
   * the clip has none, or while the first one is being drawn.
   */
  caption,
  onPlayingChange,
  unmuteSignal = 0,
  clipMuted = false,
}: {
  /**
   * The clip being shown has been muted on the timeline. Its own sound is silenced here WITHOUT
   * touching the mute button's state: that button is about the session, this is about the clip, and
   * the music under the preview must keep playing either way.
   */
  clipMuted?: boolean;
  spec: PreviewSpec | null;
  ratio: number;
  onProgress?: (sourceSec: number) => void;
  caption?: CaptionBand | null;
  /**
   * Whether the preview is SOUNDING — playing, and not muted. What plays the music under it.
   *
   * ⚠️  A REPORT, like `onProgress`, and for the same reason it must never come back as a `spec`.
   * The music follows the picture; the picture never follows the music.
   */
  onPlayingChange?: (sounding: boolean) => void;
  /**
   * Bump this to UNMUTE. The preview starts muted (see below) because building a timeline is all
   * taps and scrubs — but the moment she picks music, silence is the wrong default: she chose a
   * sound in order to hear it. The bump comes from that tap, which is also the user gesture Chrome
   * wants before it will play anything audible.
   */
  unmuteSignal?: number;
}) {
  /**
   * ⚠️  STARTS MUTED, and that is a reversal of how this shipped at checkpoint 2.
   *
   * Two reasons. Building a timeline means tapping and scrubbing constantly, and a surface that
   * makes noise on every one of those is a surface people turn off at the OS. And Chrome will not
   * autoplay an unmuted video without a qualifying user gesture — our `play()` comes from a
   * `replaceAsync` continuation, which is detached from the tap — so unmuted-by-default did not
   * reliably play at all. Muted autoplay is always permitted.
   */
  const [muted, setMuted] = useState(true);

  const player = useVideoPlayer(null, (p) => {
    /*
     * ⚠️  NOT LOOPED, where ClipPlayer is. Looping is right for a few-second card playing
     * unattended; here it hides the out-point and would fight the playhead.
     */
    p.loop = false;
    p.muted = true;
    p.timeUpdateEventInterval = 0.2;
  });

  /**
   * ⚠️  THE MUTE LIVES IN ITS OWN EFFECT, AND THE LOAD PATH BELOW MAY NEVER WRITE `muted`.
   *
   * The bug this shape exists to prevent: she unmutes, scrubs across a clip boundary, and the
   * source swap silently re-asserts the default. Unmuting is a decision about the session, not
   * about the clip that happens to be loaded.
   */
  useEffect(() => {
    player.muted = muted || clipMuted;
  }, [player, muted, clipMuted]);

  // 0 is "never asked", so mounting does not unmute; only a real bump does.
  useEffect(() => {
    if (unmuteSignal > 0) setMuted(false);
  }, [unmuteSignal]);

  /** Read through refs: the listener below is registered once and would otherwise go stale. */
  const sounding = useRef(onPlayingChange);
  sounding.current = onPlayingChange;
  const mutedNow = useRef(muted);
  mutedNow.current = muted;
  const playingNow = useRef(false);

  useEffect(() => {
    const sub = player.addListener("playingChange", ({ isPlaying }) => {
      playingNow.current = isPlaying;
      sounding.current?.(isPlaying && !mutedNow.current);
    });
    return () => sub.remove();
  }, [player]);

  // The mute button is a second way for "sounding" to change while the picture keeps playing.
  useEffect(() => {
    sounding.current?.(playingNow.current && !muted);
  }, [muted]);

  // Gone is silent: a tab switch or an emptied timeline must not leave music playing over nothing.
  useEffect(() => () => sounding.current?.(false), []);

  /** A seek waiting for its source to become ready. Cleared the moment a newer request arrives. */
  const pending = useRef<PreviewSpec | null>(null);
  /** What is loaded and positioned now — what the out-point is read from. */
  const playing = useRef<PreviewSpec | null>(null);
  /** The uri the player currently holds, so a scrub inside one clip never pays for a load. */
  const loadedUri = useRef<string | null>(null);
  /** Read through a ref: the listeners below are registered once and would otherwise go stale. */
  const progress = useRef(onProgress);
  progress.current = onProgress;

  useEffect(() => {
    if (!spec) return;
    // A held photo is drawn below, not played. Whatever the player was doing stops, and nothing is
    // loaded into it — the next clip she taps loads as it always did.
    if (spec.still) {
      pending.current = null;
      playing.current = null;
      player.pause();
      return;
    }

    const arrive = () => {
      pending.current = null;
      playing.current = spec;
      player.currentTime = spec.startSec;
      if (spec.autoplay) player.play();
      else player.pause();
    };

    /*
     * SAME SOURCE → this is a seek, not a load. The whole difference between a scrub and a
     * slideshow. Note it does NOT touch `muted` — see the mute effect above.
     */
    if (loadedUri.current === spec.uri) {
      arrive();
      return;
    }

    let cancelled = false;
    pending.current = null;

    player
      .replaceAsync({ uri: spec.uri })
      .then(() => {
        /*
         * ⚠️  THE CANCELLATION IS THE WHOLE GUARD. Tap A then B quickly and A's load can finish
         * after B's replace; without this, B is seeked to A's in-point. A `uri !== previous` check
         * cannot do this job, because it cannot tell WHICH load just finished.
         */
        if (cancelled) return;
        loadedUri.current = spec.uri;
        // Already ready — replacing with a source the player still holds emits no statusChange,
        // so the pending seek would wait forever.
        if (player.status === "readyToPlay") arrive();
        else pending.current = spec;
      })
      .catch(() => {
        // A source that will not load is not a crash. The surface keeps the frame it had.
      });

    return () => {
      cancelled = true;
    };
  }, [player, spec, spec?.token]);

  useEffect(() => {
    const sub = player.addListener("statusChange", ({ status }) => {
      if (status !== "readyToPlay") return;
      const waiting = pending.current;
      if (!waiting) return;
      pending.current = null;
      playing.current = waiting;
      player.currentTime = waiting.startSec;
      if (waiting.autoplay) player.play();
      else player.pause();
    });
    return () => sub.remove();
  }, [player]);

  useEffect(() => {
    /*
     * The OUT-POINT, enforced here because expo-video has no in/out points — a trimmed position
     * would otherwise run on into footage she cut.
     */
    const sub = player.addListener("timeUpdate", ({ currentTime }) => {
      const at = playing.current;
      if (!at) return;
      if (at.endSec !== null && currentTime >= at.endSec) {
        player.pause();
        player.currentTime = at.endSec;
        progress.current?.(at.endSec);
        return;
      }
      progress.current?.(currentTime);
    });
    return () => sub.remove();
  }, [player]);

  useEffect(
    () => () => {
      /*
       * ⚠️  THE ONLY WAY TO STOP THE PROGRESS LOOP ON WEB, and without it every mount of this
       * surface leaks one for the life of the page.
       *
       * `timeUpdateEventInterval` is backed by a plain `setInterval` that is NOT tied to playback —
       * it fires whether the video is playing, paused, or has no source at all. And
       * `VideoPlayerWeb extends SharedObject` without defining `release()`, so releasing the player
       * does not clear it; the setter's own `clearInterval` is the only path that does. Each leaked
       * loop also retains the player and its media elements against collection, so a few tab
       * switches compound into real cost.
       *
       * Guarded: on native the player may already be released when this cleanup runs, and setting on a
       * released player throws NativeSharedObjectNotFoundException (a red-screen render error).
       */
      try { player.timeUpdateEventInterval = 0; } catch { /* released player */ }
    },
    [player],
  );

  if (!spec) {
    return (
      <View
        testID="preview-empty"
        style={[styles.empty, playerBox(ratio, MAX_PLAYER_HEIGHT)]}
        accessibilityRole="text"
        accessibilityLabel="Nothing to preview yet"
      >
        <Feather name="film" size={20} color={Colors.light.textQuiet} />
        <Text style={styles.emptyTxt}>Tap a clip to see it here</Text>
      </View>
    );
  }

  const band = caption ? (
    /*
     * Placed by PERCENTAGE of the frame, and stretched to fill that slot. The frame is the
     * target's shape and the band is the target's width, so the slot and the picture have the
     * same proportions by construction — "stretch" changes nothing here, and unlike "contain"
     * it cannot leave a gap if a rounding ever disagrees by a pixel.
     *
     * pointerEvents none: the native controls underneath have to stay usable. A bottom
     * caption does sit over them on web; the controls fade, the caption is what she is here
     * to look at.
     */
    <Image
      testID="preview-caption"
      source={{ uri: caption.uri }}
      resizeMode="stretch"
      accessibilityIgnoresInvertColors
      style={[
        styles.caption,
        {
          top: `${caption.top * 100}%`,
          height: `${caption.height * 100}%`,
        },
      ]}
    />
  ) : null;

  if (spec.still) {
    return (
      <View
        testID="preview-still"
        style={[styles.stillFrame, playerBox(ratio, MAX_PLAYER_HEIGHT)]}
      >
        <Image
          testID="preview-still-photo"
          source={{ uri: spec.uri }}
          resizeMode="contain"
          accessibilityLabel="Your photo, as it will be held in the video"
          style={StyleSheet.absoluteFill}
        />
        {band}
      </View>
    );
  }

  return (
    <View testID="preview-player" style={styles.stack}>
      <PlayerSurface
        player={player}
        ratio={ratio}
        maxHeight={MAX_PLAYER_HEIGHT}
      >
        {band}
      </PlayerSurface>
      <MuteToggle
        muted={muted}
        onToggle={() => setMuted((m) => !m)}
        testID="preview-mute"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { position: "relative" },
  caption: { position: "absolute", left: 0, right: 0, pointerEvents: "none" },
  // The player's own frame (ClipPlayer `frame`): the dark inset a video sits on (DESIGN.md).
  stillFrame: {
    width: "100%",
    alignSelf: "center",
    borderRadius: BorderRadius.lg,
    overflow: "hidden",
    backgroundColor: "#0D0B08",
  },
  empty: {
    width: "100%",
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.xs,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.light.backgroundSecondary,
  },
  emptyTxt: {
    fontFamily: Fonts.body,
    fontSize: 13,
    color: Colors.light.textMuted,
  },
});
