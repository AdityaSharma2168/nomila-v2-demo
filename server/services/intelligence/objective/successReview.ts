/**
 * objective/successReview.ts — Slice 3 A: is her success line awaiting her answer after she rewrote the goal?
 * (slice3-a-design.md). Pure; DERIVED at read from the Objective's own events; never stored as a status.
 *
 * THE ATHLETE'S CURRENT GOVERNED DIRECTION OUTRANKS NOMILA'S HISTORICAL INTERPRETATION OF IT. Nomila's "how we'll
 * know" line was written for the wording she has since changed. It is awaiting her when her wording was modified and
 *   - the saved assessment of her CURRENT wording says `needs_review`, or failed (`unassessed`), or does not exist
 *     (her legacy edits), and
 *   - she has not answered for that wording: a `modify` carrying `success` (a line she supplies in the same edit as
 *     new wording IS her answer for it), or `success_confirmed` naming that wording.
 * A typo edit (assessed by rule) carries forward the answer state of the wording it corrected.
 * While awaiting, the Brain is not shown the old line (brain/inputBlock.ts). History keeps it.
 */
import type { Objective, ObjectiveEvent } from "../contracts/objectiveEntity";
import { changeAssessmentsFrom } from "./currentBasis";

export type SuccessReview =
  | { reason: "needs_review"; why: string; objectiveQuote: string; successQuote: string }
  | { reason: "unassessed" | "not_assessed" };

const ORIGINAL = "\u0000original"; // the wording before any modify — never equal to a modified Objective's wording

/** Null when nothing is awaiting her; otherwise why it is. */
export function successReview(o: Objective, events: ObjectiveEvent[]): SuccessReview | null {
  if (!o.modifiedFrom) return null;
  const answered = new Set<string>();
  let wording = ORIGINAL;
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    if (e.action === "modify") {
      if (e.delta?.desiredState) wording = e.delta.desiredState.to;
      if (e.delta?.success) answered.add(wording);
    }
    if (e.action === "success_confirmed" && e.delta?.successConfirmed) answered.add(e.delta.successConfirmed.forWording);
  }
  const assessments = changeAssessmentsFrom(events);
  let current = o.desiredState.value;
  for (let hops = 0; hops <= assessments.length; hops++) {
    if (answered.has(current)) return null;
    const a = [...assessments].reverse().find((x) => x.wording === current);
    if (!a) return { reason: "not_assessed" };
    const r = a.result;
    if (r.status === "unassessed") return { reason: "unassessed" };
    if (r.by === "rule") {
      if (a.previousWasOriginal) return null; // a typo fix of the wording the line was written for
      current = a.previousWording;
      continue;
    }
    const s = r.assessment.success;
    return s.verdict === "fits" ? null : { reason: "needs_review", why: s.reason, objectiveQuote: s.objectiveQuote, successQuote: s.successQuote };
  }
  return { reason: "not_assessed" }; // a cycle of rule results — fail closed
}
