/**
 * MilaVoiceButton.tsx — the voice toggle inside the Ask Mila input pill.
 *
 * Deliberately shaped like the send button it sits beside: same 38px circle, a
 * frosted circle (Frost) when idle, and — like a ready send — a solid white
 * circle lifted softly off the glass when on (the Muse look, DESIGN.md §16: no
 * dark discs, no pink gradients, no ink edges). Matching its neighbour is what
 * keeps the bar looking like one control rather than two systems.
 *
 * ── No animation, on purpose ─────────────────────────────────────────────────
 * A pulse while listening is the obvious next thought. MilaSearchOverlay is built
 * on the legacy `Animated` API, and this project's rule is reanimated-only for
 * new code — so animating here would mean either breaking that rule or running
 * two animation systems inside one component. State reads off colour and icon
 * instead, which costs nothing and is legible on both surfaces.
 *
 * ── The four icons ───────────────────────────────────────────────────────────
 * mic (idle) · loader (connecting) · mic (listening, white lifted circle) ·
 * volume-2 (Mila speaking) · alert-circle (error). Feather throughout — never
 * emoji, per DESIGN.md.
 */

import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { N } from "../deals/opps/tokens";
import { Frost, SOFT_LIFT } from "./Frost";
import type { VoiceState } from "./useMilaVoice";

/** Icon + accessibility label per state. One table, so they cannot drift. */
const PRESENTATION: Record<
  VoiceState,
  { icon: React.ComponentProps<typeof Feather>["name"]; label: string }
> = {
  idle: { icon: "mic", label: "Start voice" },
  connecting: { icon: "loader", label: "Connecting voice" },
  listening: { icon: "mic", label: "Voice on — tap to stop" },
  speaking: { icon: "volume-2", label: "Mila is speaking — tap to stop" },
  error: { icon: "alert-circle", label: "Voice failed — tap to retry" },
};

export function MilaVoiceButton({
  state,
  onPress,
}: {
  state: VoiceState;
  onPress: () => void;
}) {
  const { icon, label } = PRESENTATION[state];
  const filled = state === "listening" || state === "speaking";
  const errored = state === "error";

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: filled }}
      style={({ pressed }) => pressed && { opacity: 0.8 }}
    >
      {filled ? (
        <View style={[styles.btn, styles.on]}>
          <Feather name={icon} size={18} color={N.ink900} />
        </View>
      ) : (
        <Frost radius={19} style={styles.btn}>
          <Feather
            name={icon}
            size={18}
            color={errored ? N.errorInk : N.ink700}
          />
        </Frost>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Mirrors the composer's round buttons in MilaSearchOverlay exactly — they sit side by side.
  btn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  // On: a solid white circle with the soft lift, like a ready send.
  on: {
    backgroundColor: N.white,
    ...SOFT_LIFT,
  },
});
