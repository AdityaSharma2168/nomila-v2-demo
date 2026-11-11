/**
 * WebFrame — the web app's frame (EXPO_PUBLIC_WEB_V2, in a browser). Off: renders its children untouched (native, and any
 * build without the switch).
 *
 * On, window ≥ WEB_FRAME_WIDE_MIN (768): the app sits in its phone-width column (WEB_FRAME_MAX_WIDTH) with soft rounded
 * corners and a soft lift, sized to the window's height less a small margin, over nomila.co's own hero photography —
 * the landing's eight photos, placement and 40 s cross-fade — blurred under a light scrim, and
 * the NOMILA wordmark top left in white, as on the landing (owner-approved design, 26 Oct 2026; the wordmark only from
 * WEB_FRAME_WORDMARK_MIN, where it clears the column). With reduced motion:
 * one photo, no cross-fade, and the other seven are never fetched.
 *
 * On, window < 768: exactly as before — the column is the whole width, no frame, no photo.
 *
 * The column renders at once whatever the photos are doing: the backdrop is absolutely positioned behind it (no layout
 * shift), only the first photo loads with the page, and the rest get their sources after the window's load event (the
 * landing's own pattern). The photos are plain <img> elements served from the web export (heroSlides.ts) — this branch
 * only ever renders on web, so native never touches them.
 *
 * The tree keeps the same shape at every width (backdrop and wordmark are null below 768, never removed from the
 * order), so resizing across 768 never remounts the app.
 */
import React, { useEffect, useState } from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Bold, BoldType, Colors } from "../../constants/theme";
import { NomilaMark } from "../book/mark";
import { HERO_LOOP_SECONDS, HERO_SLIDES, HERO_SLIDE_SECONDS, heroSrc, heroSrcSet } from "./heroSlides";

export const WEB_FRAME_MAX_WIDTH = 480;
/** From this window width up, the column is framed over the photo backdrop; below it the app fills the window. */
export const WEB_FRAME_WIDE_MIN = 768;
/** The wordmark (left 32, ~140 wide) needs a side margin of ~200 to clear the column; between 768 and this it is left out. */
export const WEB_FRAME_WORDMARK_MIN = 880;
/** The framed column: its corner, and the margin above and below it. */
export const WEB_FRAME_RADIUS = 24;
export const WEB_FRAME_MARGIN = 24;
/** How far the backdrop photos are blurred. */
export const WEB_FRAME_BLUR = 14;

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

function mediaQuery(): MediaQueryList | null {
  try {
    const w = (globalThis as any).window;
    return typeof w?.matchMedia === "function" ? (w.matchMedia(REDUCE_QUERY) as MediaQueryList) : null;
  } catch {
    return null;
  }
}

/** The browser's reduced-motion setting, read synchronously on first render (so a reduced page never starts a fade). */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => !!mediaQuery()?.matches);
  useEffect(() => {
    const mq = mediaQuery();
    if (!mq?.addEventListener) return;
    const on = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** True once the page has finished loading (the landing's cue for slides 2–8). */
function useAfterPageLoad(enabled: boolean): boolean {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!enabled || loaded) return;
    const w = (globalThis as any).window;
    const doc = (globalThis as any).document;
    if (!doc || doc.readyState === "complete" || typeof w?.addEventListener !== "function") {
      setLoaded(true);
      return;
    }
    const on = () => setLoaded(true);
    w.addEventListener("load", on);
    return () => w.removeEventListener("load", on);
  }, [enabled, loaded]);
  return loaded;
}

// The landing's rotation (landing/index.html `.hero-slide` / `@keyframes heroslide`), under its own names.
const DELAY = (i: number) => HERO_SLIDE_SECONDS * i - 1;
const FADE_CSS =
  `@keyframes nwfslide{0%{opacity:0;transform:scale(1.06);}2.5%{opacity:1;}15%{opacity:1;}17.5%{opacity:0;transform:scale(1);}100%{opacity:0;transform:scale(1);}}` +
  `.nwf-slide{animation:nwfslide ${HERO_LOOP_SECONDS}s linear infinite both;}` +
  HERO_SLIDES.map((_, i) => `.nwf-s${i}{animation-delay:${DELAY(i)}s;}`).join("") +
  `@media ${REDUCE_QUERY}{.nwf-slide{animation:none;}}`;

const IMG_STYLE = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block",
  filter: `blur(${WEB_FRAME_BLUR}px)`,
} as const;

const SCRIM_STYLE = {
  position: "absolute",
  inset: 0,
  // Light (owner, 26 Oct 2026: the photos should show through), roughly half the landing hero's scrim; plus a soft
  // shade in the top-left corner only, under the wordmark, so white on the lightest photo stays ≥ 4.5:1 (measured ≥ 5.3:1
  // across all eight at 1280×800 and 1024×768).
  backgroundImage:
    "radial-gradient(ellipse 480px 240px at 0 0, rgba(8,8,8,0.42), rgba(8,8,8,0) 100%), " +
    "linear-gradient(180deg, rgba(8,8,8,0.33) 0%, rgba(8,8,8,0.25) 38%, rgba(8,8,8,0.28) 70%, rgba(8,8,8,0.40) 100%)",
} as const;

/** The landing's photos, blurred, behind the column. Web DOM only (rendered only when the frame is on). */
function HeroBackdrop() {
  const reduced = usePrefersReducedMotion();
  const loadRest = useAfterPageLoad(!reduced);
  const slides = reduced ? HERO_SLIDES.slice(0, 1) : HERO_SLIDES;
  return (
    <View style={styles.backdrop} pointerEvents="none" aria-hidden testID="web-frame-backdrop">
      {reduced ? null : <style>{FADE_CSS}</style>}
      {/* Scaled a touch past the window so the blur's soft edge never shows. */}
      <div style={{ position: "absolute", inset: 0, transform: "scale(1.08)" }}>
        {slides.map((s, i) => {
          const live = i === 0 || loadRest;
          return (
            <img
              key={s.stem}
              className={reduced ? undefined : `nwf-slide nwf-s${i}`}
              src={live ? heroSrc(s.stem, 1920) : undefined}
              srcSet={live ? heroSrcSet(s.stem) : undefined}
              // Blurred at 14 px, half the window's width in pixels is indistinguishable from full: a 1x laptop takes
              // the 960, a 2x one (or a window wider than 1920) the 1920.
              sizes="50vw"
              alt=""
              decoding="async"
              {...(i === 0 ? { fetchPriority: "high" } : {})}
              style={{ ...IMG_STYLE, objectPosition: s.position, opacity: reduced || i === 0 ? 1 : 0 }}
            />
          );
        })}
      </div>
      {/* A light scrim (the photos show through), the wordmark corner shaded. */}
      <div style={SCRIM_STYLE} />
    </View>
  );
}

/** The landing's wordmark: the mark + NOMILA, 15 / 900, .34em, white. */
function Wordmark() {
  return (
    <View style={styles.wordmark} pointerEvents="none" testID="web-frame-wordmark">
      <NomilaMark size={32} dark />
      <Text style={styles.wordmarkText}>NOMILA</Text>
    </View>
  );
}

export function WebFrame({ on, children }: { on: boolean; children: React.ReactNode }) {
  const { width } = useWindowDimensions();
  if (!on) return <>{children}</>;
  const wide = width >= WEB_FRAME_WIDE_MIN;
  return (
    <View style={wide ? styles.pageWide : styles.page} testID="web-frame">
      {wide ? <HeroBackdrop /> : null}
      {width >= WEB_FRAME_WORDMARK_MIN ? <Wordmark /> : null}
      <View style={wide ? styles.columnWide : styles.column} testID="web-frame-column">{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Narrow: the page around the column is the app's light ground; the column is the whole width, so a phone-width
  // window is pixel-for-pixel what it was.
  page: { flex: 1, backgroundColor: Bold.ground, alignItems: "center" },
  column: {
    flex: 1,
    width: "100%",
    maxWidth: WEB_FRAME_MAX_WIDTH,
    backgroundColor: Colors.light.backgroundRoot,
    overflow: "hidden",
  },
  // Wide: the landing hero's black ground (shown until the first photo arrives), the column inset from top and bottom.
  pageWide: {
    flex: 1,
    backgroundColor: "#0E0E0E",
    alignItems: "center",
    paddingVertical: WEB_FRAME_MARGIN,
    overflow: "hidden",
  },
  columnWide: {
    flex: 1,
    width: "100%",
    maxWidth: WEB_FRAME_MAX_WIDTH,
    backgroundColor: Colors.light.backgroundRoot,
    overflow: "hidden",
    borderRadius: WEB_FRAME_RADIUS,
    // A soft lift off the dark backdrop: one wide diffuse shadow and a close one for the edge (no border).
    boxShadow: "0 24px 64px rgba(0,0,0,0.45), 0 2px 10px rgba(0,0,0,0.25)",
  },
  backdrop: { ...StyleSheet.absoluteFill, overflow: "hidden" },
  wordmark: { position: "absolute", top: 28, left: 32, flexDirection: "row", alignItems: "center", gap: 10 },
  wordmarkText: { ...BoldType.wordmark, fontSize: 15, lineHeight: 18, letterSpacing: 15 * 0.34, color: Bold.onDark },
});
