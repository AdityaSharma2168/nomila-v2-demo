/**
 * use-clip-durations — how long her clips actually are, measured here because the database mostly
 * does not know.
 *
 * ─── WHY THE CLIENT HAS TO MEASURE AT ALL ───────────────────────────────────────────────────────
 *
 * `media_assets.duration_seconds` is written ONLY when the client sent one at upload
 * (`routes/media.ts` — from the image picker's `asset.duration`) and it is an INTEGER column. So it
 * is NULL for every clip that arrived any other way, and rounded for the rest. A track laid out in
 * proportion to duration cannot be built on that, and a trim handle on a 7-second span of a
 * 7.4-second clip cannot reach the last 0.4 s.
 *
 * ⚠️  THIS STAYS AFTER THE SERVER-SIDE FIX LANDS. A parallel card is adding ffprobe-at-upload and a
 * backfill; neither can reach a row that has not been probed yet, and a fresh upload is exactly the
 * clip she is most likely to be editing. This is the fallback rung of `resolveDuration`'s ladder
 * (measured → wire → unknown), not a workaround waiting to be deleted.
 *
 * ─── THE ARITHMETIC IS NOT HERE, AND NEITHER IS THE MEASURING ──────────────────────────────────
 *
 * This is the three-lines-of-state half: which clips to ask about, how many at once, and what has
 * been learned. `timelineGeometry.ts` decides what a duration MEANS, and `measureDuration.ts` knows
 * how to get one out of whatever runtime this is — which is not the same on web as on a phone, and
 * getting that wrong made this whole hook a no-op in Chrome for a while.
 */
import { useEffect, useRef, useState } from "react";
import { measureDuration, type DurationProbe } from "./measureDuration";

/** Anything with bytes we could decode. A subset of `ClipChoice` and of `MediaItem`. */
export interface MeasurableClip {
  assetId: string;
  videoUrl: string | null;
  /**
   * A duration the caller ALREADY has, from the wire's precise column.
   *
   * ⚠️  THIS IS NOT THIS HOOK RANKING THE LADDER — that is `resolveDuration`'s job. It is the
   * caller saying "do not spend a load on this one". A clip the server has already probed needs no
   * decoder, and opening one would be paying twice for the same number.
   */
  knownSec?: number | null;
}

/**
 * How many decoders may be open at once.
 *
 * ⚠️  A DECODER PER CLIP IS NOT FREE, and this hook is fed a whole timeline. Twelve simultaneous
 * probes on a phone is the same class of cost `ClipPoster` exists to avoid paying on a grid. Four
 * keeps the window short without measuring one clip at a time; a probe settles and frees its slot,
 * and the effect re-runs to start the next.
 */
export const MAX_CONCURRENT_PROBES = 4;

/**
 * How long to wait before giving up on one clip.
 *
 * ⚠️  WITHOUT THIS A SILENT PROBE HOLDS ITS SLOT FOREVER. A dead url, a codec the browser will not
 * open, or a stalled network answers nothing at all rather than answering an error — and four of
 * those means no clip is ever measured again for the life of the screen. Giving up resolves to
 * "unknown", which the ladder already renders honestly.
 */
export const MEASURE_TIMEOUT_MS = 8_000;

/**
 * Measure every clip we have bytes for, once, and report what has been learned so far.
 *
 * Returns a map keyed by asset id — partial by construction. A caller renders what it has and the
 * map fills in; nothing waits on it, because `resolveDuration` already has an answer for a clip
 * that has not been measured yet.
 */
export function useClipDurations(clips: MeasurableClip[]): Map<string, number> {
  const [measured, setMeasured] = useState<Map<string, number>>(new Map());
  /** Bumped by every settle, so a freed slot re-runs the effect. */
  const [settled, setSettled] = useState(0);

  /** Asset ids we will not try again — measured, errored, or unopenable. */
  const done = useRef<Set<string>>(new Set());
  /** Decoders open right now. Also exactly what unmount has to release. */
  const open = useRef<Map<string, DurationProbe>>(new Map());

  /*
   * Keyed on the WORK, not on the array. A parent that rebuilds its clip list every render — which
   * is every parent — would otherwise restart every decoder on every keystroke.
   */
  const wanted = clips
    .filter((c) => !!c.videoUrl)
    .map((c) => `${c.assetId}\u0000${c.videoUrl}\u0000${c.knownSec ?? ""}`)
    .sort()
    .join("\u0001");

  /*
   * The list is READ THROUGH A REF rather than depended on.
   *
   * Not a way around the exhaustive-deps rule — it is what the effect actually wants. `wanted` is
   * this list's identity, so when the set of clips meaningfully changes the effect re-runs and
   * re-reads the ref; when a parent merely rebuilds the same array, nothing restarts. Listing
   * `clips` as a dependency would tear down and re-create every decoder on every render.
   */
  const latest = useRef<MeasurableClip[]>(clips);
  latest.current = clips;

  useEffect(() => {
    for (const clip of latest.current) {
      if (open.current.size >= MAX_CONCURRENT_PROBES) break;
      if (!clip.videoUrl) continue;
      // Already answered by the server — see `knownSec`.
      if (typeof clip.knownSec === "number" && clip.knownSec > 0) continue;
      if (done.current.has(clip.assetId) || open.current.has(clip.assetId)) {
        continue;
      }

      const probe = measureDuration(clip.videoUrl);
      open.current.set(clip.assetId, probe);
      const timer = setTimeout(() => probe.cancel(), MEASURE_TIMEOUT_MS);

      void probe.promise.then((seconds) => {
        clearTimeout(timer);
        // Guarded: unmount can beat this here, and a cancel resolves the same promise.
        if (open.current.get(clip.assetId) !== probe) return;
        open.current.delete(clip.assetId);
        done.current.add(clip.assetId);
        if (seconds !== null) {
          setMeasured((m) => new Map(m).set(clip.assetId, seconds));
        }
        // Frees a slot, which is what re-runs this effect to start the next clip.
        setSettled((n) => n + 1);
      });
    }
    // `wanted` is the clip list's identity; `settled` re-runs this when a concurrency slot frees.
  }, [wanted, settled]);

  // Release on unmount. A decoder outliving its screen is the leak this whole file could become.
  useEffect(
    () => () => {
      for (const probe of open.current.values()) probe.cancel();
      open.current.clear();
    },
    [],
  );

  return measured;
}
