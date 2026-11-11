// HapticPressable — a drop-in replacement for RN's <Pressable> that fires a haptic
// on press. This is the "common way" to add tactile feedback without editing every
// onPress: swap `Pressable` → `HapticPressable` in a shared building block (a card, a
// tab bar, a CTA) and every press through it gets feedback for free.
//
// Usage:
//   <HapticPressable onPress={doThing}>…</HapticPressable>            // light tap
//   <HapticPressable haptic="press" onPress={send}>…</HapticPressable> // firmer, for commits
//   <HapticPressable haptic="none" onPress={…}>…</HapticPressable>     // opt out (e.g. scroll gestures)
//
// The haptic fires BEFORE onPress so the tactile response feels immediate, and it can
// never interfere with the handler (the helpers are fire-and-forget no-throw).

import React from "react";
import { Pressable, type PressableProps, type GestureResponderEvent } from "react-native";
import * as H from "../lib/haptics";

export type HapticKind = "tap" | "press" | "select" | "none";

export interface HapticPressableProps extends PressableProps {
  /** Which feedback to fire on press. Default: "tap" (a light tap). "none" opts out. */
  haptic?: HapticKind;
}

function fire(kind: HapticKind): void {
  if (kind === "tap") H.tap();
  else if (kind === "press") H.press();
  else if (kind === "select") H.select();
}

export function HapticPressable({ haptic = "tap", onPress, ...rest }: HapticPressableProps) {
  const handlePress = React.useCallback(
    (e: GestureResponderEvent) => {
      fire(haptic);
      onPress?.(e);
    },
    [haptic, onPress],
  );
  return <Pressable onPress={handlePress} {...rest} />;
}
