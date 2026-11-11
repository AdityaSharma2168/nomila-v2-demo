/**
 * shotType.ts — what KIND of segment this is, which is the only thing that decides the model.
 *
 * ─── DERIVED, NOT STORED, NOT PICKED, NOT GUESSED ──────────────────────────────────────────────
 *
 * The signal is a fact the planner already produces: does this brief carry a reference whose role
 * is `person`? `referencesFor` types every reference it emits (studio/preview.ts), so "is the
 * athlete in this shot" is already answered by the time anything needs to route.
 *
 * Three things this deliberately is NOT:
 *
 *   NOT a new field on CreativeBrief. A stored shot type is a second source of truth that can
 *     disagree with the references it was derived from, and every brief already frozen in
 *     studio_generation_previews would lack it.
 *   NOT a user picker. She is choosing a SHOT, not a model; "seedance-2.0-fast" is not a decision
 *     anybody outside this repo should have to make, and the wrong answer is a refusal at the
 *     provider or a 2.2x overcharge.
 *   NOT a classifier over her sentence. That is the move wave-d warns about — a keyword list for
 *     "which beat does this want" invents a vocabulary that then has to be kept in sync with the
 *     rules that read it back.
 *
 * ─── WHY THE ROUTING IS A CONSTRAINT AND NOT A PREFERENCE ──────────────────────────────────────
 *
 * Seedance REFUSES real-person image-to-video. Six of six V2b cells came back
 * `InputImageSensitiveContentDetected.PrivacyInformation` — a stated BytePlus policy, both tiers,
 * all three frames, including the strongest portrait in the corpus. So "identity goes to Veo and
 * b-roll goes to seedance-fast" is not a quality judgement that could be revisited on price; one
 * side of it is a route that structurally cannot take this input class.
 *
 * ⚠️ AND THE INFERENCE PREVENTS BOTH BAD OUTCOMES, which is the argument for doing it here rather
 * than leaving it to a caller: a person-referenced segment sent to Seedance is a refusal she paid
 * nothing for and waited on anyway, and a b-roll segment sent to Veo costs $0.20/s against
 * $0.0914/s for a clip with no face in it.
 */

// TYPE-ONLY. studio/preview.ts imports this module for routing, so a value import would be a
// runtime cycle; `import type` is erased and the vocabulary is still shared rather than restated.
import type { PlannedReference } from "../preview";

/**
 * The three kinds of segment, and the models they belong to — DECLARED IN studio/types.ts and
 * re-exported here so this module reads as the home of the vocabulary it decides.
 *
 * ⚠️ IT HAD TO MOVE, and the reason is worth keeping where someone might try to move it back.
 * studio/config.ts needs it for the route table, and this file imports `PlannedReference` from
 * studio/preview.ts — so declaring it here put preview.ts into the import graph of everything that
 * reaches config.ts. stitchRunner.test.ts's "no spend surface" guard reds on exactly that: its walk
 * reads import specifiers out of the SOURCE and does not care that `import type` is erased, which
 * is the conservative and correct reading, because a type import is one refactor from being a value
 * import. studio/types.ts imports nothing, so the vocabulary lives there and no graph grows.
 *
 * `transition` is LIVE for bridges (V10, #532) but is never returned BY THIS FUNCTION — the brief's
 * frozen last frame selects it in studio/preview.ts `plannedInputs` (see below). The test enumerates
 * every subset of the role union to prove `shotTypeFor` cannot return it, rather than asserting it once.
 */
export type { ShotType } from "../types";
import type { ShotType } from "../types";

/**
 * Which kind of segment this brief's references describe.
 *
 * ─── ⚠️  WHY `transition` IS NOT RETURNED HERE, THOUGH BRIDGES ARE LIVE ──────────────────────────
 *
 * A transition is a clip that STARTS at the end of one segment and ARRIVES at the start of the
 * next. That needs a first frame and a LAST frame, and a last frame is not something you can see in
 * a reference list — so this function, which reads references only, never returns it.
 *
 * V10 (#532) closed the gap from the other side. The brief now carries a frozen `lastFrame`, and
 * `plannedInputs` (studio/preview.ts) selects `transition` on that SECOND signal before this function
 * is consulted; the OpenRouter adapter sends it as `frame_images` with `frame_type: "last_frame"`,
 * and the bridge routes to Kling (docs/probes/kling-first-last.md). Vertex's `submitVideoOperation`
 * still never sends a last frame (studio/adapters/vertex.ts) — which is why the last frame beats
 * identity there: on the Veo arm it would be dropped, and an ordinary clip billed as a bridge.
 */
export function shotTypeFor(
  references: readonly Pick<PlannedReference, "role">[],
): ShotType {
  // `person` is the athlete's own likeness, tagged by her on the job and typed by the planner. A
  // `source-frame`, a `product`, an `object` or a brand's `brand-imagery` is not a person, and a
  // clip built from those alone has no face to hold.
  return references.some((r) => r.role === "person") ? "identity" : "broll";
}
