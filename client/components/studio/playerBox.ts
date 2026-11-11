/**
 * playerBox — how big a video may be drawn, as arithmetic.
 *
 * Pure, and in its own module rather than inside ClipPlayer.tsx, for the reason every other
 * *Logic file here gives: a StyleSheet cannot be tested, and a number that decides layout should
 * not be reachable only by looking at it on a phone. ClipPlayer applies what this returns.
 *
 * ─── THE BUG THIS EXISTS TO STOP ────────────────────────────────────────────────────────────────
 *
 * `width: "100%"` plus an `aspectRatio` is unbounded in the vertical direction, and for PORTRAIT
 * video it is catastrophic: on a ~390 pt phone a 9:16 box is 390 × 693, which is most of the
 * viewport for one clip. The stitched result and a clip preview both rendered that way — the
 * player stopped being an element in a layout and became the layout.
 *
 * ─── WHY THE CAP IS ON HEIGHT AND THE WIDTH IS DERIVED ──────────────────────────────────────────
 *
 * Height is what actually overflows; width is already bounded by the parent. But capping height
 * ALONE does not work: with a definite `width: "100%"`, Yoga gives width priority over
 * `aspectRatio`, so a `maxHeight` clamps the box and leaves it the WRONG SHAPE — the video then
 * letterboxes inside a container that is lying about its proportions.
 *
 * So `maxWidth` is derived from the height cap and the ratio. With both set, width settles at
 * `min(parent, maxWidth)` and height follows the ratio, never exceeding the cap. The shape is
 * preserved at every size, which is the property the tests below pin.
 */

/**
 * The tallest a player may be, in points.
 *
 * Chosen so a portrait clip, its caption and the controls under it fit on a phone without
 * scrolling the player out of view. It is a LAYOUT BUDGET, not a measurement — there is no device
 * here to measure on, and it is a prop so a surface with different room can say so.
 */
export const MAX_PLAYER_HEIGHT = 420;

export interface PlayerBox {
  /** width ÷ height. Passed straight to the style so the shape is never implicit. */
  aspectRatio: number;
  /** Derived from the height cap: the width at which the box would be exactly `maxHeight` tall. */
  maxWidth: number;
  maxHeight: number;
}

/**
 * The box for a video of this shape.
 *
 * `ratio` is width ÷ height — 9/16 portrait, 1 square, 16/9 landscape. A ratio that is not a
 * positive finite number falls back to portrait rather than producing a zero-sized or infinite
 * box: the caller is usually passing a value derived from a server response, and a bad one should
 * render something wrong-shaped rather than nothing at all.
 */
export function playerBox(
  ratio: number,
  maxHeight: number = MAX_PLAYER_HEIGHT,
): PlayerBox {
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 9 / 16;
  const safeHeight =
    Number.isFinite(maxHeight) && maxHeight > 0 ? maxHeight : MAX_PLAYER_HEIGHT;
  return {
    aspectRatio: safeRatio,
    maxWidth: safeHeight * safeRatio,
    maxHeight: safeHeight,
  };
}

/** The shapes a stitch can be made in, as ratios. Mirrors server/studio/video/spec.ts STITCH_TARGETS. */
export const TARGET_RATIO: Record<string, number> = {
  portrait: 1080 / 1920,
  square: 1,
  landscape: 1920 / 1080,
};

/**
 * The ratio for a stitch target name, defaulting to portrait.
 *
 * Portrait is the right default twice over: it is the Studio's own output shape, and it is the
 * NARROWEST of the three — so an unknown name produces the smallest box rather than the widest,
 * and a mistake here shrinks the layout instead of blowing it out again.
 */
export const ratioForTarget = (target: string | null | undefined): number =>
  (target && TARGET_RATIO[target]) || TARGET_RATIO.portrait;

// ─── What to draw for one asset ─────────────────────────────────────────────────────────────────

/** The fields any surface needs to decide how to show a piece of media. A subset of MediaItem. */
export interface PreviewSource {
  mediaType?: string | null;
  /** A still: a made poster, or the image an Instagram clip arrives as. Null for a fresh upload. */
  thumbUrl?: string | null;
  /** Real mp4 bytes, or null. `url` is NOT a substitute — for a video it may be a still. */
  videoUrl?: string | null;
}

/**
 * How a preview should be drawn.
 *
 *   image   there is a still — draw it. Costs nothing, and covers every Instagram clip.
 *   frame   it is a video with NO still — decode its first frame as the poster.
 *   empty   nothing to show: no still, no bytes.
 */
export type PreviewKind = "image" | "frame" | "empty";

/**
 * ⚠️ KEYED ON `thumbUrl`, NOT ON "IS A VIDEO".
 *
 * An Instagram clip arrives with a stored still and needs no decode; only a POSTER-LESS video does.
 * Deciding on media type instead would spin up a decoder for every tile that already has an image
 * to show — which is the cost a poster exists to avoid, paid on exactly the tiles that do not need
 * it.
 *
 * `frame` is why this exists at all. `gcs_thumb_path` is NULL from the moment an upload lands until
 * the media-poster cron next fires — MINUTES in production, and FOREVER on a laptop, where
 * processPosterBatch is not registered as an in-process cron and every in-process cron is gated on
 * NODE_ENV === "production". So a fresh upload is a blank tile everywhere; this closes that window.
 */
export function previewKind(src: PreviewSource): PreviewKind {
  if (src.thumbUrl) return "image";
  if (src.videoUrl) return "frame";
  return "empty";
}

/**
 * What the media library's preview box should be showing.
 *
 * ⚠️  A PURE SEAM ON PURPOSE. A decorative play glyph and a wired one render identically — which is
 * exactly how the library shipped with a button that did nothing for months, past every reviewer.
 * Putting the decision here makes "does this play" a question with an answer a test can hold,
 * rather than a property of markup that looks the same either way.
 *
 * `player` only ever appears for something with real mp4 bytes, so asking an IMAGE to play is not a
 * broken player — it is nothing at all.
 */
export type LibraryPreview = PreviewKind | "player";

export function libraryPreview(
  src: PreviewSource,
  playRequested: boolean,
): LibraryPreview {
  if (playRequested && src.videoUrl) return "player";
  return previewKind(src);
}

// ─── Filling a container with a <video> ─────────────────────────────────────────────────────────

/**
 * ⚠️  `StyleSheet.absoluteFill` DOES NOT SIZE A `<video>` ON WEB, and the failure is silent.
 *
 * `<video>` is a REPLACED element. For an absolutely-positioned replaced element with
 * `width: auto`, CSS resolves auto to the element's INTRINSIC size and then ignores the
 * over-constrained `right`/`bottom` — it does not stretch to its insets the way a non-replaced
 * element does. `absoluteFill` supplies only `position` and the four insets, and `expo-video`'s
 * web view passes the flattened style straight onto a raw DOM `<video>` (its `mapStyles` is
 * `StyleSheet.flatten` and nothing else).
 *
 * So a 1080×1920 clip rendered at 1080×1920 CSS pixels inside a 236×420 box, and the container's
 * `overflow: hidden` cropped a rectangle out of the middle of it. Measured in the browser:
 *
 *   box: { width: 1080, height: 1920, y: -113 }   ← the container is 236 × 420
 *
 * The native controls were never missing either: they sit at the bottom of a 1920 pt element,
 * about 1400 pt below the visible window, which is indistinguishable from having no controls.
 *
 * THIS WAS ALWAYS BROKEN AND WAS HIDDEN BY A BUG. Before the player was bounded, the frame was
 * `width: "100%"` of a desktop window — roughly 1940 × 3449 — which is LARGER than 1080 × 1920, so
 * the whole video and its controls fitted inside and it looked correct. Capping the box is what
 * made the pre-existing overflow visible.
 *
 * Explicit `width`/`height` are the fix: `auto` is what sends CSS to the intrinsic size, so giving
 * the element a definite size resolves it against the containing block instead. `objectFit`
 * (contentFit) then letterboxes within that box, which is what was wanted all along.
 */
export const VIDEO_FILL = {
  position: "absolute" as const,
  top: 0,
  left: 0,
  width: "100%" as const,
  height: "100%" as const,
};
