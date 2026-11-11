/**
 * MilaVoiceBar.tsx — the "your mic is hot" banner above the Ask Mila input.
 *
 * The mic toggle alone was not enough signal. A 38px button changing colour is
 * the same kind of change as the send button changing colour, and "is it hearing
 * me right now" is the one question a voice product must never leave ambiguous.
 * So the live state is carried by several simultaneous changes, not one: this bar
 * appears in the composer's place, a filled dot and a word name the state, and an
 * explicit End voice button exists where none did before.
 *
 * ── The look (owner direction, 8 Oct 2026, "much like Muse"; DESIGN.md §16) ─────
 * A frosted bar (Frost) with the soft lift, like the composer it stands in for and
 * the header's label — no pink ground, no outline, no dark pill. The state words
 * are the header's own (ACTIVITY_LABEL in milaActivity: "Joining…", "Listening",
 * "Speaking"), so the bar and the label above never say two different things. The
 * live dot is the one accent (blue, DESIGN.md's "Active" colour); End voice is a
 * white button lifted off the glass.
 *
 * ── Why no animation ─────────────────────────────────────────────────────────
 * A pulsing dot is the obvious idiom and it is deliberately not used. This
 * project is reanimated-only for new code, MilaSearchOverlay is built entirely on
 * the legacy Animated API, and reanimated on web additionally depends on the
 * worklets babel plugin resolving correctly in a bundle that currently works.
 * Trading a working demo for a pulse is a bad trade, and the signal does not
 * need it: redundant cues in different visual channels (position, colour,
 * shape, text) are harder to miss than one moving one. If the dot ever animates,
 * it should be reanimated inside THIS file, which owns no legacy Animated.
 *
 * ── One bar, not two ─────────────────────────────────────────────────────────
 * While voice is live this bar REPLACES the composer (variant "composer"): the
 * composer's corner, in its place. It used to stack above the pill, which cost the
 * thread a row, showed two mics, and left a keyboard affordance open in a mode that
 * is spoken — the review's "you could not see anything". The "Mic off" receipt
 * keeps the banner shape above the returned composer.
 *
 * ── Ending is a control, not an inference ────────────────────────────────────
 * "End voice" is a real button, min-width 120, because unlike the mic toggle it IS
 * a standalone CTA rather than an icon affordance inside the input pill. And when
 * it is over, the bar does not simply vanish — vanishing is not a message. It says
 * "Mic off" for a few seconds first (see `justEnded` in useMilaVoice), so the
 * athlete is TOLD the mic closed rather than left to infer it from a control that
 * disappeared.
 */

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { N, oppsFont } from "../deals/opps/tokens";
import { Bold } from "../../constants/theme";
import { Frost, SOFT_LIFT } from "./Frost";
import { ACTIVITY_LABEL, activityFrom } from "./milaActivity";
import type { VoiceState } from "./useMilaVoice";

/** What each live state is called — the header label's words. Errors are rendered by
 *  the overlay's own status line, so they are not named here. */
function liveLabel(state: VoiceState): string | undefined {
  if (state !== "connecting" && state !== "listening" && state !== "speaking") return undefined;
  return ACTIVITY_LABEL[activityFrom(state, "idle")];
}

/** The composer's corner (MilaSearchOverlay) — the live bar stands in for it. */
const COMPOSER_RADIUS = 26;
const BANNER_RADIUS = 18;

export function MilaVoiceBar({
  state,
  justEnded,
  onEnd,
  variant = "banner",
  audioBlocked = false,
  onResumeAudio,
}: {
  state: VoiceState;
  justEnded: boolean;
  onEnd: () => void;
  /**
   * Web only: the browser is holding Mila's audio back. The state word gives way
   * to a "Tap to hear Mila" control — a tap is the only thing that lifts the block,
   * so the bar offers one rather than letting her talk to silence.
   */
  audioBlocked?: boolean;
  onResumeAudio?: () => void;
  /** "composer": the live bar stands in for the input pill (pill height, no margin). */
  variant?: "banner" | "composer";
}) {
  const label = liveLabel(state);
  const live = Boolean(label);

  // Nothing to say: not live, and not just finished.
  if (!live && !justEnded) return null;

  // The post-session state: mic is off, and it says so.
  if (!live) {
    return (
      <View accessibilityLiveRegion="polite">
        <Frost radius={BANNER_RADIUS} style={[styles.bar, styles.barOff]}>
          <Feather name="mic-off" size={14} color={N.ink500} />
          <Text style={styles.labelOff}>Mic off</Text>
        </Frost>
      </View>
    );
  }

  const composer = variant === "composer";
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityLabel={`Voice is on. ${label}.`}
    >
      <Frost
        radius={composer ? COMPOSER_RADIUS : BANNER_RADIUS}
        style={[styles.bar, composer && styles.barComposer]}
        testID="mila-voice-bar"
      >
        {/* Cue 1: a filled dot in the one accent nothing else on this bar uses. */}
        <View style={styles.dot} />
        {/* Cue 2: the state, in words — the same words as the header's label. Unless
            her audio is blocked: then the one useful thing to say is how to hear her. */}
        {audioBlocked && onResumeAudio ? (
          <Pressable
            onPress={onResumeAudio}
            accessibilityRole="button"
            accessibilityLabel="Tap to hear Mila"
            testID="mila-voice-hear"
            style={({ pressed }) => [styles.hearBtn, pressed && { opacity: 0.7 }]}
          >
            <Feather name="volume-2" size={15} color={N.ink900} />
            <Text style={[styles.label, composer && styles.labelComposer]}>Tap to hear Mila</Text>
          </Pressable>
        ) : (
          <Text style={[styles.label, composer && styles.labelComposer]}>{label}</Text>
        )}
        {/* Cue 3: a control that only exists while the mic is live. */}
        <Pressable
          onPress={onEnd}
          accessibilityRole="button"
          accessibilityLabel="End voice session"
          style={({ pressed }) => [styles.endBtn, composer && styles.endBtnComposer, pressed && { opacity: 0.85 }]}
        >
          <Feather name="mic-off" size={15} color={N.ink900} />
          <Text style={[styles.endLabel, composer && styles.endLabelComposer]}>End voice</Text>
        </Pressable>
      </Frost>
    </View>
  );
}

const styles = StyleSheet.create({
  // Frost carries the glass, the corner and the soft lift — no border, no ground colour.
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 14,
    paddingRight: 6,
    paddingVertical: 6,
    marginBottom: 10,
  },
  // Standing in for the input pill: in its place, no gap below. Taller than the input
  // pill it replaces: while live this bar IS the only control on screen, so it earns
  // the room — 60 high, a 40 End button, a 15pt state word.
  barComposer: {
    height: 60,
    marginBottom: 0,
    paddingLeft: 18,
    paddingRight: 10,
    paddingVertical: 0,
  },
  labelComposer: { fontSize: 15 },
  endBtnComposer: { height: 40, minWidth: 132, paddingHorizontal: 18, borderRadius: 20 },
  endLabelComposer: { fontSize: 14 },
  // Off state is deliberately quiet — it is a receipt, not an alert.
  barOff: {
    paddingVertical: 8,
    paddingRight: 14,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: Bold.blue,
  },
  label: {
    flex: 1,
    fontFamily: oppsFont(600),
    fontSize: 13,
    color: N.ink900,
  },
  hearBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 34,
  },
  labelOff: {
    fontFamily: oppsFont(500),
    fontSize: 13,
    color: N.ink500,
  },
  // A white button lifted off the glass: a standalone CTA (min-width 120), never a dark pill.
  endBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minWidth: 120,
    height: 34,
    paddingHorizontal: 16,
    borderRadius: 17,
    backgroundColor: N.white,
    ...SOFT_LIFT,
  },
  endLabel: {
    fontFamily: oppsFont(600),
    fontSize: 13,
    color: N.ink900,
  },
});
