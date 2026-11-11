/**
 * thread/announce — VoiceOver hears the status line (iOS only).
 *
 * Android reads the status line through accessibilityLiveRegion="polite", and the web through aria-live (role=status);
 * iOS has no live regions, so the line is spoken with AccessibilityInfo.announceForAccessibility. Throttled so a quick
 * run of status parts is not read out one over another: a line is spoken only when its words change, at most once every
 * ANNOUNCE_MIN_GAP_MS; a change inside that gap is held and the NEWEST line is spoken when the gap ends (the ones it
 * replaced are dropped). Nothing is spoken for an empty line, and nothing waits past unmount.
 */
import { useEffect, useRef } from "react";
import { AccessibilityInfo, Platform } from "react-native";

export const ANNOUNCE_MIN_GAP_MS = 2000;

/** The throttle on its own (no React), so it tests with fake timers. */
export function createAnnouncer(say: (text: string) => void, gapMs = ANNOUNCE_MIN_GAP_MS, now: () => number = Date.now) {
  let lastText: string | null = null;
  let lastAt = -Infinity;
  let held: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const speak = (text: string) => {
    lastText = text;
    lastAt = now();
    say(text);
  };
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    held = null;
  };

  return {
    /** The line now on screen (null or "" when there is none). */
    update(raw: string | null | undefined) {
      const text = (raw ?? "").replace(/…$/, "").trim();
      if (!text) { clear(); lastText = null; return; }
      if (text === lastText && !held) return;
      if (text === lastText && held) { clear(); return; } // back to what was last spoken: nothing new to say
      const wait = lastAt + gapMs - now();
      if (wait <= 0) { clear(); speak(text); return; }
      held = text;
      if (!timer) timer = setTimeout(() => { timer = null; const h = held; held = null; if (h) speak(h); }, wait);
    },
    dispose: clear,
  };
}

/** Speaks `label` with VoiceOver when it changes (iOS only; throttled as above). `os` is Platform.OS (tests pass one). */
export function useStatusAnnouncement(label: string | null | undefined, os: string = Platform.OS): void {
  const ref = useRef<ReturnType<typeof createAnnouncer> | null>(null);
  if (os === "ios" && !ref.current) {
    ref.current = createAnnouncer((text) => AccessibilityInfo.announceForAccessibility(text));
  }
  useEffect(() => { ref.current?.update(label); }, [label]);
  useEffect(() => () => ref.current?.dispose(), []);
}
