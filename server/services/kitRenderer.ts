/**
 * kitRenderer — turns a theme-agnostic `MediaKitData` (from mediaKitService) into the shareable, swipeable HTML card
 * stack, in one of the three deck looks (shared/deckLooks, owner decision 23 Oct 2026):
 *
 *   nomila     the app's one look — the DEFAULT                (themes/nomila.ts)
 *   luxe       premium / lifestyle / fashion brands             (themes/luxe.ts)
 *   broadcast  sports, beverage and energy brands               (themes/broadcast.ts)
 *
 * Brand-facing kits are public links → server-rendered HTML (no app needed). `kit.tokens.theme` (or an explicit
 * `theme`) picks the look; a retired look (campaign, immersive) or an unknown one renders in Nomila, so a deck or a
 * frozen snapshot saved with one still opens.
 */
import type { MediaKitData } from "./mediaKitService";
import { DECK_LOOKS, resolveDeckLook, type DeckLook } from "../../shared/deckLooks";
import { renderBroadcast } from "./themes/broadcast";
import { renderLuxe } from "./themes/luxe";
import { renderNomila } from "./themes/nomila";

type Kit = MediaKitData;

type ThemeRenderer = (kit: Kit) => string;
const THEMES: Record<DeckLook, ThemeRenderer> = { nomila: renderNomila, luxe: renderLuxe, broadcast: renderBroadcast };
export function listThemes(): string[] { return Object.keys(THEMES); }
/** The looks she can pick: all three (23 Oct 2026). */
export const PICKABLE_THEMES: readonly string[] = DECK_LOOKS;
export function listPickableThemes(): string[] { return [...PICKABLE_THEMES]; }

// The native shell (Nomi Card screen) renders its own top bar + bottom action bar around the WebView,
// so the deck's OWN prev/share/next buttons + swipe caption + toasts are redundant chrome — every
// theme has its own class names for these (each theme's CSS/JS is a faithful, separately-maintained
// prototype, so the selectors aren't shared). `?chrome=none` hides just this chrome per theme; the
// swipe/drag gesture, the progress segments and the card content itself are untouched.
const CHROME_HIDE_SELECTORS: Record<DeckLook, string[]> = {
  nomila:    [".actions", ".stage-cap", ".toast"],
  broadcast: [".actions", ".page-hint", ".toast"],
  luxe:      [".actions", ".stage-caption", ".toast"],
};

export interface RenderKitHtmlOpts {
  chrome?: string;   // "none" → hide the deck's internal action bar + swipe caption + toasts
}

export function renderKitHtml(kit: Kit, theme?: string, opts?: RenderKitHtmlOpts): string {
  const t = resolveDeckLook(theme || kit.tokens?.theme);
  let html = THEMES[t](kit);
  // iOS WKWebView STALLS the entire inline stylesheet on a blocking font `@import` (external fetch),
  // so the card renders completely unstyled in the app's WebView. Move any font @import out of the
  // <style> and into non-blocking <link>s in the <head> — inline styles then apply immediately, fonts
  // stream in after (display=swap). Single serve-path fix → covers every theme.
  const fonts: string[] = [];
  html = html.replace(/\s*@import url\((['"]?)([^)'"]+)\1\);?/g, (_m, _q, url) => { fonts.push(url); return ""; });
  if (fonts.length) {
    const links = `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`
      + fonts.map((u) => `<link rel="stylesheet" href="${u}">`).join("");
    html = html.replace("</head>", `${links}</head>`);
  }
  if (opts?.chrome === "none") {
    // Without its own action bar a look no longer needs the room reserved for it at the foot of each card.
    const room = t === "luxe" ? ".content{padding-bottom:44px !important;}"
      : t === "nomila" ? ".inner,.aud-panel{padding-bottom:30px !important;}" : "";
    const style = `<style>${CHROME_HIDE_SELECTORS[t].join(",")}{display:none !important;}${room}</style>`;
    html = html.replace("</head>", `${style}</head>`);
  }
  return html;
}
