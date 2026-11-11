/**
 * SOFT_LIFT — the Muse look's very soft, wide, low shadow (owner direction, 8 Oct 2026): lifts a Mila surface without
 * drawing an edge. Not on Android, where elevation draws a hard grey ring around a translucent or round surface.
 * Kept apart from Frost.tsx so surfaces that only need the lift (the tab bar's Mila) don't pull in expo-blur.
 */
import { Platform, type ViewStyle } from "react-native";

export const SOFT_LIFT: ViewStyle =
  Platform.select<ViewStyle>({
    web: { boxShadow: "0px 6px 20px rgba(26, 26, 26, 0.06)" } as ViewStyle,
    ios: {
      shadowColor: "#1A1A1A",
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.07,
      shadowRadius: 12,
    },
    default: {},
  }) ?? {};

/**
 * CARD_LIFT — the card system v2's stronger, two-layer lift (decision 6, design "Mila card designs" v2.2):
 * 0 1 2 / .06 + 0 12 32 / .11, so a card stands out from Mila's words. iOS: opacity .11, radius 16. Android: none (the
 * card keeps its hairline and the ground-tinted media band does the separating).
 */
export const CARD_LIFT: ViewStyle =
  Platform.select<ViewStyle>({
    web: { boxShadow: "0px 1px 2px rgba(14, 14, 14, 0.06), 0px 12px 32px rgba(14, 14, 14, 0.11)" } as ViewStyle,
    ios: { shadowColor: "#0E0E0E", shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.11, shadowRadius: 16 },
    default: {},
  }) ?? {};
