// Variant B design tokens — ported from the Nomila design source (brand-tokens.jsx).
// A single `N` palette + a weight→fontFamily helper so the design JSX ports to
// React Native almost verbatim. Colors map to the existing theme where they
// already exist; the named cream/ink scales just make the port readable.

import { Bold, Fonts } from "../../../constants/theme";

// One look (owner, 22–23 Oct 2026): the names stay so the ported screens read unchanged, but the values are the look's —
// the cream scale is white and Bold's greys, and `pink` is the ONE raspberry action colour (Bold.act), not the ring pink.
export const N = {
  // brand
  pink: Bold.act,
  pinkLight: Bold.actSoft,
  // The ring colours paint the M.I.A. score only (one look, 23 Oct 2026): these historic names read ink and grey.
  blue: Bold.ink,
  blueLight: Bold.ground,
  green: Bold.ink,
  greenLight: Bold.ground,
  gold: Bold.ink,
  goldLight: Bold.ground,
  // surfaces
  heroBg: "#0D0B08",
  heroBg2: "#1A1F35",
  cardOnDark: "#131D35",
  cream100: Bold.paper,
  /** cream100 at zero alpha: the far end of a fade into the (white) ground. */
  cream100Clear: "rgba(255,255,255,0)",
  cream200: Bold.ground,
  cream300: Bold.line,
  cream400: Bold.line,
  white: "#FFFFFF",
  // ink
  ink900: Bold.ink,
  ink700: Bold.ink2,
  ink500: Bold.mute,
  ink300: "#9CA3AF",
  // status
  success: "#10B981",
  successInk: "#1A9960",
  warning: "#F59E0B",
  error: "#EF4444",
  errorInk: "#C2342F",
  goldInk: "#B57F0E",
} as const;

// The app ships the Outfit family as discrete weight files (custom fonts don't
// respond to fontWeight), so design weights must be mapped to a family name.
export function oppsFont(weight: number): string {
  if (weight >= 800) return Fonts.display;       // Outfit_800ExtraBold
  if (weight >= 700) return Fonts.bodyBold;      // Outfit_700Bold
  if (weight >= 600) return Fonts.bodySemiBold;  // Outfit_600SemiBold
  if (weight >= 500) return Fonts.bodyMedium;    // Outfit_500Medium
  return Fonts.body;                             // Outfit_400Regular
}
