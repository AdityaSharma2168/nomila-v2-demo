/**
 * studio/subjectVocab — the closed set of nouns that name the thing an edit must PRESERVE.
 *
 * ─── WHY THIS IS NOT AN ENTRY IN garmentVocab.ts ───────────────────────────────────────────────
 *
 * The two vocabularies look identical — a short closed list of words handed to the same segmenter
 * through the same adapter — and they mean OPPOSITE THINGS to the composite:
 *
 *   a GARMENT noun says  "segment this, and edit INSIDE it"      (studio/garmentVocab.ts)
 *   a SUBJECT noun says  "segment this, and PRESERVE inside it"  (this file)
 *
 * One list holding both would be one `normalizeX` away from letting "jersey" reach the inversion
 * path — which pastes the new background everywhere EXCEPT the jersey — or letting "person" reach
 * the garment path, which paints the background over the athlete. Both are silent: the geometry is
 * valid, the leak guard passes, the mask is real, and the wrong half of the picture changes. The
 * separation is a correctness boundary and it is enforced by having two functions that cannot
 * return each other's words, not by a `polarity` field somebody has to remember to set.
 *
 * ─── THE SEPARATION IS NOW A POSITIONAL RULE, NOT A PAIR OF LISTS ─────────────────────────────
 *
 * The paragraph above describes the separation as two functions that cannot return each other's
 * words. That was true and it was not enough, because it only ever governed the NOUN FIELDS. A
 * detection naming target "her face" with no `samNoun` at all passed both vocabularies untouched,
 * took its rectangle, and re-rendered a box over her face — no mask, no leak guard, nothing to
 * report. The lists were complete and she was edited anyway.
 *
 * So the rule is now stated positionally and enforced where the position is known:
 *
 *     A PERSON MASK IS LEGAL ONLY AS AN INVERSION SOURCE.
 *
 * `parseDetections` (studio/autoMask.ts) short-circuits the background entry BEFORE the object
 * loop, which makes the two arms structurally distinct rather than merely differently-named: the
 * background arm is the only code that sets `subjectNoun`, and it is the only place a person may be
 * named. Everything past that short-circuit refuses any target or noun naming her
 * (`namesPerson`, studio/objectVocab.ts), whatever the word and whatever grammar it arrived in.
 *
 * That is what lets STUDIO_OBJECT_MASK be enabled. Not a longer deny list — a rule whose
 * correctness does not depend on the list being finished.
 *
 * ─── THE SAME INJECTION BOUNDARY garmentVocab.ts IS ────────────────────────────────────────────
 *
 * `subjectNoun` rides on RegionFraction, which is a CLIENT wire type as well as a model output, so
 * this word reaches a third-party prompt attached to an athlete's photograph. It is validated in
 * `mapRegions` — the choke point BOTH paths pass through — exactly as `samNoun` is, and for exactly
 * the same reason. Neither a model nor a client is trusted with it.
 *
 * ─── WHY ONLY ONE WORD ─────────────────────────────────────────────────────────────────────────
 *
 * "person" is what the first SAM probe segmented cleanly and it is the only subject this feature
 * has. The list is a list rather than a constant so that adding "dog" or "car" later is a data
 * change with a test, not a refactor — but the same rule garmentVocab.ts states applies here and
 * harder: only add a noun actually OBSERVED to return a mask. A guessed noun does not fail loudly,
 * it bills and returns nothing, and on THIS path an empty mask refuses her edit rather than
 * quietly taking the rectangle (studio/generate.ts — see the mask-type-dependent fallback rule).
 */

/**
 * Nouns confirmed to return a mask of the thing to preserve. Lowercase, exactly as SAM was asked.
 */
export const SUBJECT_NOUNS: readonly string[] = ["person"];

const ALLOWED = new Set(SUBJECT_NOUNS);

/**
 * An untrusted string → a subject noun the segmenter can be asked for, or null.
 *
 * Case and surrounding whitespace are normalized, because a model returns "Person" as readily as
 * "person" and that is not a vocabulary miss. Nothing else is coerced — no stemming, no plural
 * folding, no nearest match. "people", "subject", "athlete" and "human" are all null, and null is
 * the honest answer: a word close to a working one is not a working one.
 */
export function normalizeSubjectNoun(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return ALLOWED.has(clean) ? clean : null;
}
