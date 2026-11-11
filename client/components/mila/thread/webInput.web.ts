/**
 * thread/webInput (web): the two things a browser does differently from the app.
 *
 * 1. The on-screen keyboard (iOS Safari, Android Chrome) shrinks the VISUAL viewport, not the page, so a composer pinned
 *    to the bottom of the page sits under the keyboard. React Native's KeyboardAvoidingView does nothing on web. The
 *    covered height is the layout viewport less the visual one (window.innerHeight − visualViewport.height − its top
 *    offset); the screen pads its bottom by it while the keyboard is up. Desktop browsers: always 0.
 *
 * 2. Focus. The browser's own outline on the text field is taken off (it drew a box inside the frosted pill), and the
 *    design's ring (DESIGN.md §14; raspberry, the one accent, thin, offset 2) goes on the pill instead — only when focus came from the
 *    keyboard (Tab), as :focus-visible would decide. A click or a tap into the field draws no ring.
 */
import { useEffect, useState } from "react";
import type { TextStyle } from "react-native";

type VV = { height: number; offsetTop: number; addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void };

function viewport(): { vv: VV | null; innerHeight: number } {
  const w = globalThis as unknown as { visualViewport?: VV; innerHeight?: number };
  return { vv: w.visualViewport ?? null, innerHeight: typeof w.innerHeight === "number" ? w.innerHeight : 0 };
}

/** The height the keyboard covers at the bottom of the page, in CSS pixels (0 when none). */
export function keyboardInsetNow(): number {
  const { vv, innerHeight } = viewport();
  if (!vv || !innerHeight) return 0;
  const covered = Math.round(innerHeight - vv.height - vv.offsetTop);
  // Under ~80px is browser chrome moving (the URL bar), not a keyboard.
  return covered > 80 ? covered : 0;
}

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(keyboardInsetNow);
  useEffect(() => {
    const { vv } = viewport();
    if (!vv) return undefined;
    const on = () => setInset(keyboardInsetNow());
    vv.addEventListener("resize", on);
    vv.addEventListener("scroll", on);
    return () => {
      vv.removeEventListener("resize", on);
      vv.removeEventListener("scroll", on);
    };
  }, []);
  return inset;
}

// The last input modality on the page: a key press (Tab) means keyboard navigation; a pointer means a mouse or a finger.
let lastWasKeyboard = false;
let listening = false;
function listen() {
  const d = (globalThis as { document?: Document }).document;
  if (listening || !d?.addEventListener) return;
  listening = true;
  d.addEventListener("keydown", (e: KeyboardEvent) => { if (!e.metaKey && !e.altKey && !e.ctrlKey) lastWasKeyboard = true; }, true);
  d.addEventListener("pointerdown", () => { lastWasKeyboard = false; }, true);
  d.addEventListener("mousedown", () => { lastWasKeyboard = false; }, true);
  d.addEventListener("touchstart", () => { lastWasKeyboard = false; }, true);
}

export function useFocusRing(): { focusRing: boolean; onFocus: () => void; onBlur: () => void } {
  const [focusRing, setFocusRing] = useState(false);
  useEffect(listen, []);
  return {
    focusRing,
    onFocus: () => setFocusRing(lastWasKeyboard),
    onBlur: () => setFocusRing(false),
  };
}

/** react-native-web passes these through to the <textarea>: no browser outline (the pill carries the ring). */
export const NO_OUTLINE = { outlineStyle: "none", outlineWidth: 0 } as unknown as TextStyle;
