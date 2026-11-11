/**
 * milaSurface — the one card and row look for every surface inside Ask Mila (owner direction, 8 Oct 2026, "much like
 * Muse"; DESIGN.md §16): a light paper surface, one rounded corner, the very soft lift (softLift), and NO border — no
 * ink edge, no outline. Cards Mila shows in the chat, the rows of the saved-chats list and the ＋ sheet's tiles all
 * spread this, so the conversation reads as one family with the frosted header and composer.
 *
 * Android gets no lift (its elevation draws a hard grey ring — see Frost), so there the card keeps a hairline in the
 * lightest line colour instead, just enough that a white card does not dissolve into the ground.
 */
import { Platform, StyleSheet, type ViewStyle } from "react-native";
import { SOFT_LIFT } from "./softLift";
import { Bold } from "../../constants/theme";

/** Every Mila card and row uses this corner. */
export const MILA_CARD_RADIUS = 18;

export const MILA_CARD: ViewStyle = {
  backgroundColor: Bold.paper,
  borderRadius: MILA_CARD_RADIUS,
  ...SOFT_LIFT,
  ...(Platform.OS === "android" ? { borderWidth: StyleSheet.hairlineWidth, borderColor: Bold.line } : null),
};
