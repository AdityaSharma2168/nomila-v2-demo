/**
 * playerBox.test.ts — the size constraint, pinned as arithmetic.
 *
 * A StyleSheet cannot be tested and a phone is not available here, so the numbers that decide
 * layout live in a pure module and are asserted. The property that matters is not "there is a
 * cap" but "the cap holds AND the shape survives it" — capping one dimension is easy and is
 * exactly the version that produces a correctly-sized box of the wrong proportions.
 */
import {
  MAX_PLAYER_HEIGHT,
  playerBox,
  previewKind,
  ratioForTarget,
  TARGET_RATIO,
  VIDEO_FILL,
  libraryPreview,
} from "./playerBox";

/** What Yoga settles on, given a parent width, a maxWidth, a maxHeight and an aspectRatio. */
function laidOut(parentWidth: number, box: ReturnType<typeof playerBox>) {
  const width = Math.min(parentWidth, box.maxWidth);
  return { width, height: width / box.aspectRatio };
}

const PHONE = 390 - 32; // a phone column, minus DESIGN.md's 16pt gutters

describe("playerBox", () => {
  it("bounds the height of a PORTRAIT video — the case that blew the layout out", () => {
    // ⚠️ THE REGRESSION. `width: "100%"` + aspectRatio 9/16 on a phone column is 358 × 636 — most
    // of the viewport for one clip, which is what the stitched result and the clip preview both
    // rendered as.
    const unbounded = PHONE / (9 / 16);
    expect(unbounded).toBeGreaterThan(600);

    const laid = laidOut(PHONE, playerBox(TARGET_RATIO.portrait));
    expect(laid.height).toBeLessThanOrEqual(MAX_PLAYER_HEIGHT);
    expect(laid.height).toBeLessThan(unbounded);
  });

  it("KEEPS THE SHAPE while bounding it — the half a height cap alone gets wrong", () => {
    // ⚠️ THE REVERT CHECK FOR THE DERIVED WIDTH. Dropping `maxWidth` and keeping only `maxHeight`
    // still produces a box inside the cap, so a test that only asserted the height would pass —
    // but Yoga gives a definite `width: "100%"` priority over `aspectRatio`, so the box ends up
    // 358 × 420, which is 0.85 and not 0.5625. The video then letterboxes inside a container that
    // is lying about its proportions.
    for (const [name, ratio] of Object.entries(TARGET_RATIO)) {
      const laid = laidOut(PHONE, playerBox(ratio));
      expect(laid.width / laid.height).toBeCloseTo(ratio, 5);
      expect(laid.height).toBeLessThanOrEqual(MAX_PLAYER_HEIGHT + 0.001);
      expect(laid.width).toBeLessThanOrEqual(PHONE + 0.001);
      expect(name).toBeTruthy();
    }
  });

  it("lets a LANDSCAPE video stay bounded by the column, not by the height cap", () => {
    // 16:9 in a 358pt column is 201pt tall — nowhere near the cap, and it must not be padded up to
    // it. The cap is a ceiling, not a size.
    const laid = laidOut(PHONE, playerBox(TARGET_RATIO.landscape));
    expect(laid.width).toBe(PHONE);
    expect(laid.height).toBeCloseTo(PHONE / (16 / 9), 5);
    expect(laid.height).toBeLessThan(MAX_PLAYER_HEIGHT);
  });

  it("derives maxWidth from the height cap, so moving the cap moves both", () => {
    // If maxWidth were a typed constant it would drift from the cap the moment one of them moved.
    const half = playerBox(TARGET_RATIO.portrait, MAX_PLAYER_HEIGHT / 2);
    const full = playerBox(TARGET_RATIO.portrait);
    expect(half.maxWidth).toBeCloseTo(full.maxWidth / 2, 5);
    expect(half.maxHeight).toBe(MAX_PLAYER_HEIGHT / 2);
  });

  it("falls back to portrait on a ratio it cannot use, rather than rendering nothing", () => {
    // These arrive from a server response or a stored target name. A zero or a NaN must produce a
    // wrong-shaped box, not a zero-sized or infinite one.
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(playerBox(bad).aspectRatio).toBe(9 / 16);
      expect(playerBox(TARGET_RATIO.portrait, bad).maxHeight).toBe(
        MAX_PLAYER_HEIGHT,
      );
    }
  });
});

describe("ratioForTarget", () => {
  it("maps each shape she can choose", () => {
    expect(ratioForTarget("portrait")).toBeCloseTo(1080 / 1920, 5);
    expect(ratioForTarget("square")).toBe(1);
    expect(ratioForTarget("landscape")).toBeCloseTo(1920 / 1080, 5);
  });

  it("defaults to the NARROWEST shape on anything it does not know", () => {
    // Portrait twice over: it is the Studio's own output shape, and it is the narrowest — so an
    // unknown name shrinks the layout rather than blowing it out again, which is the failure this
    // whole module exists to stop.
    for (const unknown of [null, undefined, "", "cinemascope"]) {
      expect(ratioForTarget(unknown)).toBe(TARGET_RATIO.portrait);
    }
    expect(TARGET_RATIO.portrait).toBeLessThan(TARGET_RATIO.square);
    expect(TARGET_RATIO.portrait).toBeLessThan(TARGET_RATIO.landscape);
  });

  it("agrees with the server's own target list", () => {
    // Mirrors server/studio/video/spec.ts STITCH_TARGETS. A shape the server accepts and this does
    // not would render in the wrong box; the names are asserted so the two lists cannot diverge
    // silently.
    expect(Object.keys(TARGET_RATIO).sort()).toEqual([
      "landscape",
      "portrait",
      "square",
    ]);
  });
});

// ─── What to draw for one asset ─────────────────────────────────────────────────────────────────

describe("previewKind", () => {
  it("draws the STILL whenever there is one, even for a video", () => {
    // ⚠️ THE REVERT CHECK FOR THE DECODE BUDGET. Keying on "is a video" instead of "has a still"
    // spins up a decoder for every tile that already has an image — which is precisely the cost a
    // poster exists to avoid, paid on the tiles that least need it. Every Instagram clip arrives
    // with a stored still and must take this branch.
    expect(
      previewKind({
        mediaType: "VIDEO",
        thumbUrl: "https://x/poster.jpg",
        videoUrl: "https://x/clip.mp4",
      }),
    ).toBe("image");
    expect(
      previewKind({ mediaType: "IMAGE", thumbUrl: "https://x/p.jpg" }),
    ).toBe("image");
  });

  it("falls back to the first FRAME only when a video has no still", () => {
    // The gap this whole component exists for: gcs_thumb_path is NULL from upload until the
    // media-poster cron fires — minutes in production, never on a laptop.
    expect(
      previewKind({
        mediaType: "VIDEO",
        thumbUrl: null,
        videoUrl: "https://x/clip.mp4",
      }),
    ).toBe("frame");
  });

  it("is EMPTY when there is nothing to show — never a frame of nothing", () => {
    // A video row with no bytes is one we never rehosted. Handing expo-video a null is a crash,
    // and handing it the `url` (which for a video may be a still) is a decoder on an image.
    expect(
      previewKind({ mediaType: "VIDEO", thumbUrl: null, videoUrl: null }),
    ).toBe("empty");
    expect(previewKind({})).toBe("empty");
    expect(
      previewKind({ mediaType: "IMAGE", thumbUrl: null, videoUrl: null }),
    ).toBe("empty");
  });

  it("never asks for a decode it could have avoided", () => {
    // Stated as the invariant rather than as three cases: `frame` is reachable ONLY with no still
    // and real bytes. Any other shape must be image or empty.
    const urls = [null, "https://x/a"];
    for (const thumbUrl of urls) {
      for (const videoUrl of urls) {
        const kind = previewKind({ mediaType: "VIDEO", thumbUrl, videoUrl });
        if (kind === "frame") {
          expect(thumbUrl).toBeNull();
          expect(videoUrl).not.toBeNull();
        }
      }
    }
  });
});

// ─── Filling a container with a <video> ─────────────────────────────────────────────────────────

describe("VIDEO_FILL", () => {
  it("sets an EXPLICIT width and height, because insets alone do not size a <video>", () => {
    // ⚠️ THE REVERT CHECK FOR THE REGRESSION. `<video>` is a REPLACED element: with width/height
    // auto, CSS resolves them to the INTRINSIC size and ignores the over-constrained right/bottom,
    // so `StyleSheet.absoluteFill` — position plus four insets and nothing else — leaves a 1080x1920
    // clip rendering at 1080x1920 CSS pixels inside whatever box it was given.
    //
    // Measured in Chrome before the fix, in a 236 x 420 container:
    //   { width: 1080, height: 1920, y: -113 }
    //
    // Dropping either of these two properties restores that. The assertion is on the STYLE rather
    // than on rendering because there is no browser in this repo to measure a layout in — and a
    // render test in jsdom would not have caught it either, since jsdom has no layout engine.
    expect(VIDEO_FILL.width).toBe("100%");
    expect(VIDEO_FILL.height).toBe("100%");
  });

  it("still positions absolutely, so it overlays the frame's placeholder", () => {
    expect(VIDEO_FILL.position).toBe("absolute");
    expect(VIDEO_FILL.top).toBe(0);
    expect(VIDEO_FILL.left).toBe(0);
  });

  it("does NOT rely on right/bottom — the two an over-constrained replaced element drops", () => {
    // Stated as an absence, deliberately: adding them back would look like belt-and-braces and
    // would be the exact combination that silently does nothing for a replaced element. Width and
    // height are what carry the sizing; the insets only place it.
    expect("right" in VIDEO_FILL).toBe(false);
    expect("bottom" in VIDEO_FILL).toBe(false);
  });
});

// ─── The player's contract with expo-video's web view ───────────────────────────────────────────

describe("ClipPlayer's VideoView props", () => {
  // Structural, and honest about being so: these are JSX props on a third-party view whose effect
  // is a DOM attribute. There is no browser here to observe the rendered <video> in, and jsdom has
  // no layout or media engine, so the source is what can be pinned. Same posture the stitch lease
  // suite takes when it asserts its own SQL still contains FOR UPDATE SKIP LOCKED.
  /**
   * ⚠️  COMMENTS STRIPPED FIRST, and that is not tidiness — it is the difference between a test and
   * a test-shaped thing. The first version matched /allowsFullscreen/ against the raw file and
   * PASSED WITH THE PROP DELETED, because the doc comment above the prop explains what it is for
   * and contains the word. A source assertion that can match its own prose asserts nothing. Caught
   * by running the mutation it names, which is the only way this kind of test is worth anything.
   */
  const src = require("fs")
    .readFileSync(require.resolve("./ClipPlayer.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  it("asks for fullscreen, or Chrome strips the button from the control set", () => {
    // expo-video writes controlsList="nofullscreen" unless fullscreenOptions.enable is true, and that
    // attribute REMOVES the control rather than declining to add one. Dropping the prop is a
    // silent loss of a control nobody would think to test for. Anchored to a whole line, so it
    // matches the JSX PROP and not any sentence that happens to name it.
    // (SDK 55 removed `allowsFullscreen`; the prop is `fullscreenOptions={{ enable: true }}` now.)
    expect(src).toMatch(/^\s*fullscreenOptions=\{\{\s*enable:\s*true\s*\}\}\s*$/m);
    expect(src).not.toMatch(/allowsFullscreen/);
  });

  it("uses VIDEO_FILL rather than StyleSheet.absoluteFill", () => {
    // The regression this file documents: absoluteFill leaves a replaced element at intrinsic size.
    expect(src).toMatch(/style=\{VIDEO_FILL\}/);
    expect(src).not.toMatch(/style=\{StyleSheet\.absoluteFill\}/);
  });

  it("keeps the native controls", () => {
    expect(src).toMatch(/nativeControls/);
  });
});

describe("what the media library's preview box shows", () => {
  const video = { mediaType: "VIDEO", thumbUrl: "t.jpg", videoUrl: "v.mp4" };
  const photo = { mediaType: "IMAGE", thumbUrl: "t.jpg", videoUrl: null };

  it("shows the still until play is asked for", () => {
    // Press-to-play, not an inline player: this box is also the IMAGE preview, and a player mounted
    // for every asset would decode a video on a screen that is usually showing a photo.
    expect(libraryPreview(video, false)).toBe("image");
  });

  it("⚠️ becomes a PLAYER once play is asked for", () => {
    // The check that could not be made against markup: a decorative glyph and a wired one render
    // identically, which is how this shipped doing nothing for months.
    expect(libraryPreview(video, true)).toBe("player");
  });

  it("⚠️ an IMAGE never becomes a player, however many times it is asked", () => {
    expect(libraryPreview(photo, true)).toBe("image");
    expect(libraryPreview({ mediaType: "IMAGE", videoUrl: null }, true)).toBe(
      "empty",
    );
  });

  it("a poster-less video still shows its own first frame until played", () => {
    expect(
      libraryPreview({ mediaType: "VIDEO", videoUrl: "v.mp4" }, false),
    ).toBe("frame");
    expect(
      libraryPreview({ mediaType: "VIDEO", videoUrl: "v.mp4" }, true),
    ).toBe("player");
  });
});
