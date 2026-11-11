// haptics.ts — one place for tactile feedback across the app.
//
// Rather than importing expo-haptics and picking a feedback style in every button,
// call one of these semantic helpers (or use <HapticPressable>, which calls `tap()`
// for you). This keeps the vocabulary consistent — a "tap" always feels the same
// everywhere — and gives us a single seam to tune intensity or disable haptics later
// (e.g. a user setting).
//
// All helpers are fire-and-forget and NEVER throw: on web, in Expo Go without the
// native module, or on a device with haptics off, they quietly no-op. Do not await
// them — haptics are cosmetic and must never block or fail an interaction.

import { Platform } from "react-native";
import * as Haptics from "expo-haptics";

// Haptics are iOS/Android only. On web (and SSR) the native module isn't present.
const SUPPORTED = Platform.OS === "ios" || Platform.OS === "android";

function safe(run: () => Promise<unknown>): void {
  if (!SUPPORTED) return;
  // Swallow everything — a missing module or a busy motor must not surface an error.
  try {
    void run().catch(() => {});
  } catch {
    /* no-op */
  }
}

/** A light tap — the default for any ordinary button / row press. */
export function tap(): void {
  safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}

/** A firmer press — for a primary / committing action (send, accept, confirm). */
export function press(): void {
  safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
}

/** A selection tick — for toggles, tab switches, segmented controls, chips. */
export function select(): void {
  safe(() => Haptics.selectionAsync());
}

/** Success notification — a completed, positive outcome (sent, filed, saved). */
export function success(): void {
  safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
}

/** Warning notification — a reversible caution (undo target, set-aside). */
export function warning(): void {
  safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
}

/** Error notification — a failed or blocked action. */
export function error(): void {
  safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
}

/** Namespaced export for call sites that prefer `haptics.tap()`. */
export const haptics = { tap, press, select, success, warning, error };
