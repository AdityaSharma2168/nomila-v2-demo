/**
 * studio/refOrder — the one place that decides what order references leave in.
 *
 * ─── WHY THIS IS A MODULE AND NOT TWO SORTS ─────────────────────────────────────────────────────
 *
 * The prompt's reference manifest (studio/preview.ts) numbers its lines against the reference array
 * — "Image 2 — HER LIKENESS" is a claim about the second image in the request. That claim is only
 * true if every adapter places references in the same order the planner listed them. Two adapters
 * each with their own sort is two places for that to drift, and the failure would be silent and
 * expensive: the manifest would name her likeness while pointing at a brand's campaign photograph.
 *
 * So the order lives here, once, and both adapters call it.
 *
 * ─── WHY ORDER AT ALL, WHEN THE ROLE NOW SURVIVES ───────────────────────────────────────────────
 *
 * Because the provider has no typed reference field to survive INTO. `:generateContent` takes plain
 * image parts (see the RefSlot docstring in studio/types.ts, which records how that was verified
 * against @google/genai 2.7.0). Position plus the manifest label IS the addressing scheme — it is
 * what we have instead of a slot, not a decoration on top of one.
 *
 * The difference from before is where the order comes FROM. It used to be insertion order, which
 * meant a caller shuffling its array silently changed what the model thought each image was. Now it
 * is derived from the slot, so a shuffled array produces the identical request.
 */
import type { ImageRef, RefSlot } from "./types";

/**
 * Frame first, then identity, then the things that must render correctly, then the look.
 *
 * The frame leads because for an edit it is the thing the output has to stay continuous with —
 * everything else is a modifier on it. Style trails because it is the only slot whose contribution
 * is meant to be diffuse rather than literal.
 */
export const SLOT_ORDER: RefSlot[] = ["frame", "character", "object", "style"];

const rank = (slot: RefSlot | undefined): number => {
  const i = slot ? SLOT_ORDER.indexOf(slot) : -1;
  // An UNTYPED reference sorts last rather than first. A caller that set no slots gets its original
  // order back unchanged (every rank is equal, and the sort is stable); a caller that set SOME
  // slots is telling us the typed ones are the ones it reasoned about, so an untyped straggler must
  // not be able to land in front of the frame.
  return i === -1 ? SLOT_ORDER.length : i;
};

/**
 * References in slot order. STABLE — two references in the same slot keep the order the planner
 * gave them, which is what lets the manifest say "PRODUCT: the charm" about a specific one of three
 * product shots.
 *
 * Returns a new array; the input is never mutated, because `inputs.references` is read again by
 * pricing and by the cost log after the adapter has built its body.
 */
export function orderBySlot(refs: readonly ImageRef[]): ImageRef[] {
  return refs.map((ref, i) => ({ ref, i }))
    .sort((a, b) => rank(a.ref.slot) - rank(b.ref.slot) || a.i - b.i)
    .map(({ ref }) => ref);
}
