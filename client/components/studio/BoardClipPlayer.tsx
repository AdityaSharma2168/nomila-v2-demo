/**
 * BoardClipPlayer — one of her clips, played on the Board WITHIN ITS WINDOW.
 *
 * A Board clip row showed a static poster, and a row that says "9.5–14.5 s" could not be checked
 * without leaving the Board. This plays exactly that window: it seeks to `startSec` once the source
 * is ready, plays, and PAUSES at `endSec` — the out-point `TimelinePreview` enforces the same way,
 * because expo-video has no in/out points and a trimmed position would otherwise run on into
 * footage she cut. `token` restarts it: tapping the row again is "play it again".
 *
 * ─── WHY NOT `ClipPlayer`, AND WHY NOT `TimelinePreview` ───────────────────────────────────────
 *
 * `ClipPlayer` plays a whole clip from 0 and loops — right for a card, wrong for a window.
 * `TimelinePreview` owns the scrub/seek/caption/music machinery of the Video tab; a Board row wants
 * the out-point and nothing else. So this owns a player of its own (the pattern TimelinePreview
 * documents) and draws through `PlayerSurface`, the shared frame.
 *
 * Sound follows the ROW: a row whose sound is off plays muted. Chrome allows muted autoplay
 * always, and the tap that mounts this is the user gesture an unmuted play needs.
 */
import React, { useEffect, useRef } from "react";
import { useVideoPlayer } from "expo-video";
import { PlayerSurface } from "./ClipPlayer";

/**
 * A call on the player that may already be released. In a swiped feed, expo-video releases the native player when
 * the item unmounts, and a listener or cleanup that runs a moment later throws NativeSharedObjectNotFoundException
 * (a red-screen render error). Nothing is lost by skipping the call: the player is gone.
 */
function safe(call: () => void): void {
  try { call(); } catch { /* released player */ }
}

export interface BoardClipWindow {
  /** SOURCE seconds. */
  startSec: number;
  /** SOURCE seconds, or null to play to the end. */
  endSec: number | null;
}

export function BoardClipPlayer({
  uri,
  window,
  muted,
  token,
  ratio = 9 / 16,
  maxHeight,
  fill = false,
  radius,
}: {
  uri: string;
  window: BoardClipWindow;
  muted: boolean;
  /** Changes on every tap, so the same window plays again. */
  token: number;
  ratio?: number;
  maxHeight?: number;
  /** Full-bleed, cover-cropped, no native controls (PlayerSurface `fill`) — for a feed that draws its own buttons. */
  fill?: boolean;
  /** The bounded box's corner (PlayerSurface `radius`). */
  radius?: number;
}) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.muted = muted;
    p.timeUpdateEventInterval = 0.2;
  });
  /** What is being played now — what the out-point is read from. */
  const playing = useRef<BoardClipWindow | null>(null);

  useEffect(() => {
    safe(() => { player.muted = muted; });
  }, [player, muted]);

  // Start (or restart) the window: at once when the source is ready, else when it becomes so.
  useEffect(() => {
    const start = () => safe(() => {
      playing.current = window;
      player.currentTime = window.startSec;
      player.play();
    });
    if (player.status === "readyToPlay") {
      start();
      return;
    }
    const sub = player.addListener("statusChange", ({ status }) => {
      if (status === "readyToPlay") {
        sub.remove();
        start();
      }
    });
    return () => sub.remove();
  }, [player, window, token]);

  // The out-point.
  useEffect(() => {
    const sub = player.addListener("timeUpdate", ({ currentTime }) => {
      const at = playing.current;
      if (!at || at.endSec === null) return;
      if (currentTime >= at.endSec) {
        safe(() => {
          player.pause();
          player.currentTime = at.endSec!;
        });
      }
    });
    return () => sub.remove();
  }, [player]);

  // The progress loop is a plain setInterval on web and outlives the player — see TimelinePreview. Guarded: on
  // native the player may already be released by the time this cleanup runs, and setting on it is the crash above.
  useEffect(
    () => () => {
      safe(() => { player.timeUpdateEventInterval = 0; });
    },
    [player],
  );

  return <PlayerSurface player={player} ratio={ratio} maxHeight={maxHeight} fill={fill} radius={radius} />;
}
