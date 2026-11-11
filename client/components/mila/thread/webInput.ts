/**
 * thread/webInput (iOS / Android): nothing to do. The keyboard is handled by the screen's KeyboardAvoidingView (as the
 * old chat), and there is no browser focus outline. The web build takes webInput.web.ts instead; the two export the
 * same names, so the views never branch on the platform for these.
 */
import type { TextStyle } from "react-native";

/** How far the on-screen keyboard covers the bottom of the page (web only; native: 0). */
export function useKeyboardInset(): number {
  return 0;
}

/** Whether the composer has keyboard focus that should draw the design's focus ring (web only; native: never). */
export function useFocusRing(): { focusRing: boolean; onFocus: () => void; onBlur: () => void } {
  return { focusRing: false, onFocus: noop, onBlur: noop };
}

/** The style that takes the browser's own outline off the text field (web only; native: none). */
export const NO_OUTLINE: TextStyle = {};

function noop() {}
