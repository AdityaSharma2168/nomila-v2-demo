/**
 * heroSlides — nomila.co's own hero photography, as the web frame's backdrop shows it (owner, 26 Oct 2026). The SAME
 * eight photos, order and object-position as the landing page's hero (landing/index.html, `img.hero-slide`), and the
 * same rotation: 8 photos × 5 s with a 1 s cross-fade, a 40 s loop.
 *
 * The files are NOT bundled: scripts/copy-web-frame-hero.js copies landing/assets/v2/hero-N-{960,1920}.webp into the
 * web export (dist/web-frame/) in the two web deploy workflows, so native builds never carry them and the browser
 * fetches them by URL, by width (srcset).
 */
export const HERO_DIR = "/web-frame";

/** One slide: the landing's file stem and its object-position, in the landing's order. */
export const HERO_SLIDES: readonly { stem: string; position: string }[] = [
  { stem: "hero-1", position: "30% 40%" },
  { stem: "hero-2", position: "55% 40%" },
  { stem: "hero-3", position: "50% 30%" },
  { stem: "hero-4", position: "50% 35%" },
  { stem: "hero-5", position: "40% 40%" },
  { stem: "hero-6", position: "45% 30%" },
  { stem: "hero-7", position: "55% 35%" },
  { stem: "hero-8", position: "50% 30%" },
];

/** The two widths the landing ships for each photo. */
export const HERO_WIDTHS = [960, 1920] as const;

/** The landing's timing: each photo holds 5 s, the loop is 40 s, the cross-fade 1 s (2.5% of the loop). */
export const HERO_SLIDE_SECONDS = 5;
export const HERO_LOOP_SECONDS = HERO_SLIDE_SECONDS * HERO_SLIDES.length;

export const heroSrc = (stem: string, w: number) => `${HERO_DIR}/${stem}-${w}.webp`;
export const heroSrcSet = (stem: string) => HERO_WIDTHS.map((w) => `${heroSrc(stem, w)} ${w}w`).join(", ");
