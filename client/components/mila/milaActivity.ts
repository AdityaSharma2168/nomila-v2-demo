/**
 * milaActivity — what Mila is doing right now, read ONLY from signals the client really receives,
 * and how that shows: which avatar loop plays and what her status pill says.
 *
 * Signals (nothing else feeds this — no status is invented without one):
 *   voice  — useMilaVoice().state: "speaking" (her audio track is live), "listening" (the room is
 *            open, she's waiting on the athlete), "connecting" (joining the room)
 *   text   — useMilaChat().phase, from the reply stream itself (see ChatPhase): "thinking" before
 *            the first token and while the model decides a round, "tool" while the server runs a
 *            tool round (`status` event, phase "tool"), "writing" while answer tokens arrive
 *
 * Voice wins while a call is live: a spoken turn never runs the text stream, so the two never
 * compete in practice, and the call is the louder fact when they would.
 */
import { useEffect, useRef, useState } from "react";
import type { MilaState } from "./MilaAvatar";
import type { ChatPhase } from "../../hooks/use-mila-chat";
import type { VoiceState } from "./voiceSession";

export type MilaActivity =
  | "idle"
  | "thinking"
  | "looking"
  | "writing"
  | "connecting"
  | "listening"
  | "speaking";

/** The avatar loop for each activity. Listening/connecting rest on idle: her mouth only moves when she talks. */
export const ACTIVITY_AVATAR: Record<MilaActivity, MilaState> = {
  idle: "idle",
  thinking: "generating",
  looking: "searching",
  writing: "writing",
  connecting: "idle",
  listening: "idle",
  speaking: "speaking",
};

/** The status pill's words. Idle is just her name. */
export const ACTIVITY_LABEL: Record<MilaActivity, string> = {
  idle: "Mila",
  thinking: "Generating…",
  looking: "Looking things up…",
  writing: "Writing…",
  connecting: "Joining…",
  listening: "Listening",
  speaking: "Speaking",
};

export function activityFrom(voiceState: VoiceState, chatPhase: ChatPhase): MilaActivity {
  if (voiceState === "speaking") return "speaking";
  if (voiceState === "listening") return "listening";
  if (voiceState === "connecting") return "connecting";
  switch (chatPhase) {
    case "thinking":
      return "thinking";
    case "tool":
      return "looking";
    case "writing":
      return "writing";
    default:
      return "idle";
  }
}

/** Shortest time any shown state stays up, so a fast thinking→tool→thinking→writing run doesn't flicker. */
export const MIN_STATE_MS = 1200;

/**
 * The activity to SHOW: follows `target`, but never replaces what is on screen until it has been
 * up for `minMs`. A change that arrives sooner waits out the remainder, and only the latest target
 * is shown when it does — intermediate states that came and went inside the window are skipped.
 */
export function useHeldActivity(target: MilaActivity, minMs: number = MIN_STATE_MS): MilaActivity {
  const [shown, setShown] = useState<MilaActivity>(target);
  const shownAtRef = useRef<number>(Date.now());
  const latestRef = useRef<MilaActivity>(target);
  latestRef.current = target;

  useEffect(() => {
    if (target === shown) return undefined;
    const wait = Math.max(0, minMs - (Date.now() - shownAtRef.current));
    const t = setTimeout(() => {
      shownAtRef.current = Date.now();
      setShown(latestRef.current);
    }, wait);
    return () => clearTimeout(t);
  }, [target, shown, minMs]);

  return shown;
}
