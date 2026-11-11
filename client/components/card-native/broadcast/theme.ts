/**
 * broadcast look — tokens, ported from server/services/themes/broadcast.ts (:root). A matchday /
 * scoreboard-graphics treatment: pitch-black panels, chalk-white text, VOLT green as the live
 * accent, matchday red for the aggressive marks, heavy Anton condensed caps + Barlow.
 *
 * Fonts: Anton (ultra-condensed scoreboard display) + Barlow Condensed + Barlow (all loaded in App.tsx).
 */
export const BC = {
  ink:     "#0B0C10",   // pitch black
  panel:   "#14161D",   // card panel
  panel2:  "#1B1E27",   // raised panel cell
  paper:   "#F2EFE6",   // chalk white
  mut:     "rgba(242,239,230,0.60)",
  faint:   "rgba(242,239,230,0.34)",
  line:    "rgba(242,239,230,0.14)",
  volt:    "#D8FF3E",   // scoreboard volt
  voltDim: "rgba(216,255,62,0.16)",
  red:     "#E4002B",   // matchday cardinal
  redDeep: "#8E0F22",
  track:   "rgba(242,239,230,0.10)",
  // Real broadcast faces.
  display: "Anton_400Regular",           // ultra-condensed scoreboard display
  cond:    "BarlowCondensed_600SemiBold",
  condBold:"BarlowCondensed_700Bold",
  sans:    "Barlow_400Regular",
  sansMed: "Barlow_500Medium",
};
