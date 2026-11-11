/**
 * referencePack — the copy that tells an athlete a piece can be built from SEVERAL photographs of her.
 *
 * Its own module, and not a few lines inside ReferencePicker.tsx, for the reason
 * createAnythingLogic.ts is its own module: jest's roots include client/ but only for pure-logic
 * `.test.ts` suites with no renderer, so a sentence that ships to her is only testable if it does not
 * arrive through react-native.
 */

/**
 * How many photographs of HERSELF one piece is built from.
 *
 * Mirrors CHARACTER_CAP in server/studio/config.ts, which is what actually refuses — this constant
 * only decides copy. If the two ever disagree the server wins and she gets a blocking gap on the cost
 * check instead of a sentence here: a worse version of the same answer, not a wrong one.
 *
 * It is not a restated literal on trust. referencePack.test.ts imports `refCapacityFor` from the
 * server and asserts this equals the real capacity for the model image.generate routes to, so moving
 * the server's number without moving this one is red.
 */
export const MAX_PERSON = 3;

/**
 * The consent boundary, stated to the one person who can honour it.
 *
 * ⚠️ NOT DECORATION. The person slot means ONE person: her. Nothing in the product verifies whose
 * face is in a photograph — the server re-reads every asset under HER athlete id, so the photo is
 * hers to use, but "hers" is not "of her". Several tiles made that ambiguity easy to reach for the
 * first time, so the sentence ships with them.
 */
export const PERSON_PACK_RULE =
  "Photos of you only — not a friend, not a teammate.";

/**
 * The line under the tiles once she has tagged a photo of herself.
 *
 * ─── WHY A PACK NEEDS COPY AT ALL ───────────────────────────────────────────────────────────────
 *
 * Nothing about "You" told her a second photo was worth adding. A capability nobody is told about is
 * not a feature: the plumbing has allowed several "You" tiles all along, and what was missing was the
 * ask.
 *
 * ⚠️ THE REASON IT GIVES IS THE MEASURED ONE, AND IT IS NOT "MORE IS BETTER". An earlier draft said
 * "different days and different angles hold your face better than one photo can". That is a claim
 * about COUNT, and the control run falsified it: ONE good upright photograph of her came back
 * recognisably her. What actually failed, six times out of six, was one SPECIFIC photograph — the
 * outlier of her library, with her face smallest in frame — and the same photograph inside a pack of
 * three came back as her, four times out of four.
 *
 * So the pack does not beat a good photograph. It stops a weak one from sinking the job, and that is
 * worth copy because she has no way to know which of her photographs is the weak one.
 * (docs/probes/reference-packs.md has the tally.)
 *
 * Over the cap it says what the server's blocking gap says, in her words, one screen earlier.
 */
export function personPackNote(count: number): string | null {
  if (count < 1) return null;
  if (count > MAX_PERSON)
    return `${count} photos of you — a piece is built from up to ${MAX_PERSON}. Remove one.`;
  if (count === MAX_PERSON)
    return `${MAX_PERSON} of ${MAX_PERSON} photos of you — a full set.`;
  return `${count} of ${MAX_PERSON} photos of you. More than one keeps a weaker photo from throwing off your face.`;
}

/**
 * The line under the tiles on a CLIP, where `personPackNote` may not be shown.
 *
 * ─── ⚠️  A CLIP IS BUILT FROM ONE FRAME, AND THAT IS THE ADAPTER RATHER THAN A CAP ──────────────
 *
 * Whichever reference sorts FIRST is the frame the clip starts from, on both providers and by
 * construction rather than by agreement:
 *
 *   Veo / Vertex     `submitVideoOperation` builds `instances[0] = { prompt, image }` from
 *                    `refParts[0]` and stops (server/studio/adapters/vertex.ts). Nothing else in the
 *                    array reaches the model at all.
 *   OpenRouter       `videoImageFields` makes the first reference `frame_images[0]` and the REST
 *                    `input_references` — style guidance, which does travel but does not pin a frame.
 *
 * ⚠️ SO THE TAIL'S FATE IS PROVIDER-DEPENDENT AND THIS SENTENCE MUST NOT DESCRIBE IT. A person-tagged
 * clip routes to Veo (`shotTypeFor` → identity), where a second likeness AND a tagged product are
 * both fetched, encoded and discarded; a clip with no person routes to seedance over OpenRouter,
 * where the same tail arrives as style references. "The others are ignored" is true on one arm and
 * false on the other, so it is not said. What IS true on both is which photo becomes the frame.
 *
 * ─── ⚠️  WHY `personPackNote` IS WRONG HERE, IN ALL THREE OF ITS CLAIMS ─────────────────────────
 *
 *   "of 3"           CHARACTER_CAP is the IMAGE models' number. No video model appears in
 *                    `defaultRefCapacities` (server/studio/config.ts), so a clip falls through to
 *                    DEFAULT_REF_CAPACITY and the server refuses at **2**, not 3.
 *   "keeps a weaker  measured on image.generate (docs/probes/reference-packs.md). Nothing has
 *    photo from…"    measured it in motion, and the mechanism cannot apply on the Veo arm, where the
 *                    second photograph never reaches the model.
 *   the invitation   asking for a photograph that gets discarded is exactly the "promise the model
 *                    will not keep" that the third reference tag was removed for.
 *
 * So this promises nothing and asks for nothing. It states which photo is load-bearing, because
 * removal is the only way she can change that — the tiles render in array order (`references.map`)
 * and `orderBySlot` preserves it within a slot.
 */
export function clipFrameNote(count: number): string | null {
  if (count < 1) return null;
  return count === 1
    ? "Your clip starts from this photo."
    : "Your clip starts from the first photo here.";
}

/**
 * The empty-state ask on a CLIP. Stands in for the sentence inside ReferencePicker's empty state,
 * which says "Up to three photos of you … and the product if there is one" — true for a still, and
 * two separate over-promises for a clip (see `clipFrameNote`: the cap is 2 on this path, and on the
 * Veo arm the product is discarded along with every extra likeness).
 *
 * ⚠️ IT ASKS FOR ONE PHOTO AND NAMES NO ROLE. Leaving the product out is a missing affordance — the
 * "Product" chip is still right there on every tile — and a missing affordance is the acceptable half
 * of that trade. Asking her for a product photograph that Veo will discard is not.
 *
 * ⚠️ THE IMAGE SENTENCE IS NOT MOVED IN HERE, though the symmetry would be nicer. It ships today from
 * inside the component and nothing pins it; relocating live image copy to tidy up a video card is how
 * a character goes missing from a sentence nobody was reviewing. It belongs here, when something is
 * actually changing it.
 */
export const CLIP_EMPTY_ASK =
  "The photo your clip starts from — the one where your face is clearest. " +
  "Describe the shot you want in the brief below.";
