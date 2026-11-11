/**
 * joinLogic — which join a position gets, and why. The composer's one rule (PR 15, R-1).
 *
 * Pure, like every Board module. No model, no fetch, $0: a join is decided from what the Board
 * already knows about the two rows either side of it, and every decision carries a REASON — one
 * short, stable word from a closed set, so two stitches of the same board can be diffed by their
 * reasons and the ledger can say why each cut is a cut (docs/probes/composer.md). The reason is for
 * the log and for Adi; nothing on the surface shows it.
 *
 * ─── THE PRECEDENCE, IN ONE PLACE ───────────────────────────────────────────────────────────────
 *
 *   position 0            cut     nothing before it to fade from (the server refuses a fade there)
 *   her Cut tap           cut     always wins over every input below
 *   a bridge's own edges  cut     the bridge arrives at this row's still; a fade would blur the
 *   a clip after its      cut     one join that was paid to be seamless (boardStitch's rule)
 *     own bridge
 *   a continuation        cut     the same source on both sides — two beats of one clip, or a
 *                                 photo then its own animation: the frames already match, and a
 *                                 fade between matching frames is a smear
 *   on the beat           cut     a track is chosen and the edit is cut on its beat: a crossfade
 *                                 has no single instant, so it cannot land on a beat (beatLogic
 *                                 says so for stills; this says it for every join)
 *   the reading's rhythm  cut / fade   fast → cut, slow → fade (rhythmLogic, conservative)
 *   the default           fade    today's DEFAULT_CROSSFADE_SEC, exactly as before
 *
 * Only "her Cut", "continuation", "on the beat" and "rhythm" are new. Everything above them is the
 * rule the Board already had, restated here so there is one function that decides.
 */

export type JoinKind = "cut" | "fade";

export type JoinReason =
  | "position-0"
  | "her-cut"
  | "bridge-edge"
  | "after-own-bridge"
  | "continuation"
  | "on-beat"
  | "rhythm-fast"
  | "rhythm-slow"
  | "default-fade";

export type Rhythm = "fast" | "slow";

export interface JoinInput {
  /** Position in the timeline; 0 is the first clip. */
  index: number;
  /** Her Cut tap on the row this join leads into (`StoryboardRow.cutIn`). */
  cutIn: boolean;
  /** What this position is: a generated bridge's own edges are always cuts. */
  piece: "still" | "own" | "clip" | "bridge" | "passthrough";
  /** This clip follows the bridge that was generated into it. */
  afterOwnBridge: boolean;
  /** The position before this one comes from the same source asset. */
  continuation: boolean;
  /** A track with a beat grid is chosen and the edit is cut on its beat. */
  onBeat: boolean;
  /** The reference reading's pace, when it was unambiguous — else null. */
  rhythm: Rhythm | null;
}

export interface JoinDecision {
  kind: JoinKind;
  reason: JoinReason;
}

const cut = (reason: JoinReason): JoinDecision => ({ kind: "cut", reason });
const fade = (reason: JoinReason): JoinDecision => ({ kind: "fade", reason });

export function chooseJoin(input: JoinInput): JoinDecision {
  if (input.index === 0) return cut("position-0");
  // ⚠️ MUTATION (joinLogic.test): move this below `onBeat` — "her explicit Cut is overridden" reds.
  if (input.cutIn) return cut("her-cut");
  // ⚠️ MUTATION: drop either bridge line — "a generated bridge's join is overridden" reds.
  if (input.piece === "bridge") return cut("bridge-edge");
  if (input.afterOwnBridge) return cut("after-own-bridge");
  if (input.continuation) return cut("continuation");
  // ⚠️ MUTATION: drop this line — "on-beat toggle ignored at a cut" reds.
  if (input.onBeat) return cut("on-beat");
  // ⚠️ MUTATION: drop these — "editing_rhythm never chooses a join" reds.
  if (input.rhythm === "fast") return cut("rhythm-fast");
  if (input.rhythm === "slow") return fade("rhythm-slow");
  return fade("default-fade");
}
