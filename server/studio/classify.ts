/**
 * studio/classify — what she asked for, as an OPERATION. Never as a path.
 *
 * ─── WHY THE VERB LIST HAD TO GO ───────────────────────────────────────────────────────────────
 *
 * Routing lives in `deriveIntent`/`editBaseFor` (client/lib/studio-contract.ts), which forks on a
 * list of edit verbs. A test matrix retired that idea outright: "change the color of X to red",
 * "make X red", "recolor X red" and "edit X to be red" produce IDENTICAL model output. Four
 * sentences, four different verbs, one picture. The verb is not a weak signal that wants a longer
 * list — it carries no signal at all, and every word added to that list is a word that changes
 * routing without changing the ask.
 *
 * What separates those four from "put me on a rooftop at dusk" is not the verb. It is whether a
 * photograph is being CHANGED or a photograph is being MADE.
 *
 * ─── THE TWO RULES THIS MODULE EXISTS TO ENFORCE ───────────────────────────────────────────────
 *
 * ① THE CLASSIFIER NEVER PICKS A PATH. It picks an operation; a separate table maps operation to
 *   path. A path is an implementation fact — does SAM run, is the frame re-rendered, is the
 *   composite byte-exact outside the mask. An operation is a fact about HER SENTENCE. Tied
 *   together, every pipeline change has to be re-litigated against every phrasing. Kept apart,
 *   moving RECOLOR off the full-image path is one row of a table and this file does not move.
 *
 * ② GENERATE IS DESTRUCTIVE AND IS THEREFORE NEVER AN AMBIGUITY DEFAULT. It does not edit a
 *   photograph, it replaces one. Every other operation is recoverable — a bad recolor is a bad
 *   picture sitting beside the original. A GENERATE that should have been an edit is the original,
 *   gone. When the answer is unclear the answer is MASKED or ASK.
 *
 * This module is the gate for ② and nothing else yet. It is pure, it is not wired into
 * `deriveIntent`, and deleting it changes no behaviour.
 *
 * ─── WHY IT IS SERVER-SIDE, WHICH IS A TRUST DECISION AND NOT A LAYOUT ONE ─────────────────────
 *
 * The gate guards a destructive action: replacing the source frame she uploaded. A guard in
 * client/lib holds only for callers that come through the client — a retry, a background job, or
 * any future API arrives at the server with the guard already behind it. That is a convention, not
 * an invariant, and this is the file where the difference matters most.
 *
 * It also keeps ONE rule in ONE runtime. The person guard (studio/objectVocab.ts, enforced in
 * `parseDetections`) is already server-side; a classifier-side person check living in the client
 * would be the same invariant enforced in two places, which is the exact thing the positional rule
 * was designed to remove.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { createLogger } from "../logger";
import {
  displayTextEnabled,
  imageOpsEnabled,
  moveObjectEnabled,
} from "./config";
import {
  normalizeWords,
  POINTED_LOOK,
  asksForAd,
  readBrandMark,
  readCamera,
  readCrop,
  readLookPointer,
  readPose,
  readRelight,
  ANGLE_SUGGESTIONS,
  NAMES_A_HOLD,
  readAngleUnclear,
  readHoldAdd,
  readsFramePlace,
  readsQuotedAdd,
  readTextAdd,
  withDefaultPlace,
  readVague,
  readWeather,
  VAGUE_SUGGESTIONS,
} from "./imageOps";
import { GARMENT_NOUNS, KNOWN_BAD_NOUNS } from "./garmentVocab";
import { readKeep, readThingKeep } from "./keepVocab";
import { lookOf, readWhollyLook, unknownLookWord } from "./lookVocab";
import type { EditConstraint } from "./nativeEdit";
import {
  namesPerson,
  namesWornItem,
  stripTrailingModifiers,
  wornGoesOn,
  wornDefaultPlace,
  WORN_ITEMS,
  WORN_PLACE_PREPOSITIONS,
} from "./objectVocab";

const logger = createLogger("studio/classify");

/**
 * The nine operations. Closed set — the classifier may return nothing else.
 *
 *   RECOLOR            an existing region keeps its geometry and changes hue/tone
 *   APPLY_DESIGN       graphic content is added or replaced on a region (logo, text, number, print)
 *   REPLACE_OBJECT     a thing becomes a DIFFERENT thing, not the same thing recolored
 *   REMOVE_OBJECT      a thing is deleted and the space behind it filled
 *   ADD_OBJECT         a thing NOT in the frame yet is put somewhere in it — "a soccer ball between
 *                      my cleats". The only operation with no region to find: the thing does not
 *                      exist in the photograph until the edit makes it. See rule 4½.
 *   DISPLAY_TEXT       a headline across the top of the photo — "OWN THE MOMENT" (PR T, Mia's M1). Text
 *                      ON the frame, not on a region of it, which is APPLY_DESIGN's: no target, and its
 *                      value is the words. Native only, and only behind STUDIO_DISPLAY_TEXT. Rule ⅛.
 *   CHANGE_BACKGROUND  everything except the subject changes; the subject is preserved
 *   GLOBAL_STYLE       whole-frame look — grade, lighting, black and white — with no region target
 *   GENERATE           a net-new image from references
 *
 * GENERATE is a member because it is a real thing to ask for, not because it is ever a fallback.
 * It is the only member that destroys its input, and `allowedOps` is what keeps it out of reach of
 * every sentence that did not plainly ask for it.
 */
export type EditOperation =
  | "RECOLOR"
  | "APPLY_DESIGN"
  | "REPLACE_OBJECT"
  | "REMOVE_OBJECT"
  | "ADD_OBJECT"
  | "MOVE_OBJECT"
  | "DISPLAY_TEXT"
  | "CHANGE_BACKGROUND"
  | "GLOBAL_STYLE"
  // PR 19 (STUDIO_IMAGE_OPS): a lighting change and a camera angle, each one native edit of the whole frame.
  | "RELIGHT"
  | "CAMERA"
  // PR 19 (S-7): a window of her own pixels — reformat (R-10) and a tighter reframe (R-11). No model: image.crop.
  | "CROP"
  // PR 19 (ADI-R19-W3's logo rec): an ad's brand logo, like a watermark, where it stays visible. Written by the ad
  // treatment only; read from "add the <brand> logo as a watermark".
  | "BRAND_MARK"
  | "GENERATE";

/**
 * A sentence that plainly asks for a NEW ARTIFACT, and nothing weaker.
 *
 * Three parts, each load-bearing:
 *
 *   a creation verb    generate | create | render | design | make
 *   an INDEFINITE      a | an | another | new — THE WHOLE DISCRIMINATOR. "make THE socks blue"
 *                      names something already in the frame; "make A poster" names something that
 *                      does not exist yet. This is why `make` can head both a recolor and a
 *                      generate, and why no verb list can ever separate the two.
 *   an artifact noun   image | photo | picture | shot | poster | graphic | render | asset, plus the
 *                      DELIVERABLE names below. She has to say what is being made; without it
 *                      "make a red one" is an edit.
 *
 * ─── THE NOUN LIST NAMES DELIVERABLES, NOT JUST FILE TYPES ─────────────────────────────────────
 *
 * The original eight are all words for "a picture". Nobody asks for a picture. "create an adidas ad
 * featuring me" was an ASK — not because the gate read it as an edit, but because `ad` was not a
 * word this list knew, so the sentence matched nothing and GENERATE was never offered. Same for
 * campaign, post, story, reel, banner, flyer, thumbnail and creative: every one of them is a thing
 * she can plainly ask to have MADE, and four of them (post, story, reel, ad) are already members of
 * BriefDeliverable, so the product's own vocabulary named them before this regex did.
 *
 * ⚠️ THIS WIDENS THE NOUN AND NOTHING ELSE. The verb and the indefinite are untouched, so every
 * sentence added here still has to be "<creation verb> <a|an|another|new> … <noun>". "make the post
 * brighter" stays an edit because `the` is not an indefinite; "add a logo to the banner" stays an
 * edit because `add` is not a creation verb. The asymmetry in the warning below is unchanged and it
 * is why the list grows one vetted word at a time rather than becoming a category test.
 *
 * `[^.]{0,40}` is a bounded window that stops at a sentence period — the same shape
 * NAMES_AN_EDIT_SPLIT uses in studio-contract.ts, and for the same reason: it lets the three parts
 * sit apart ("create me another moody poster") without letting two adjacent sentences read as one.
 *
 * ⚠️ DELIBERATELY NARROW, AND THE ASYMMETRY IS THE POINT. A false negative costs her one round
 * trip: she gets an edit, sees it was not what she meant, says it again more plainly. A false
 * positive costs her the photograph. Those are not comparable, so this errs hard toward the
 * recoverable side. Widen it against a test matrix, never to rescue one awkward sentence.
 *
 * ─── "PHOTOGRAPH", 2026-09-16 (the preservation fixes, D3; sweep-4 ledger F-L8) ────────────────────────
 *
 * `photo` was on the list and `photograph` was not, and the word boundary keeps one from matching the other.
 * Live on Adi's acceptance: "generate a professional sports photograph of her … packed stadium behind her …"
 * with her photos in the tray read as an EDIT — rule 2 took "behind her" and froze a background change to
 * "net" — and her other photos refused the edit. The same sentence saying "photo" generated. One word, the
 * same word: every sentence it adds is one "photo" already read, and so is its false positive — "make a black
 * and white version of this photograph" is a new image, as "…of this photo" has always been. Pinned both
 * ways in classify.test.ts. The rest of the new-image words she types (pic, headshot, portrait, photoshoot,
 * a plural "photos" with no article) are the follow-up card, one vetted word at a time.
 *
 * ─── THAT CARD, 2026-09-17 (wave A, V3; ledger F-L8) ─────────────────────────────────────────────────────────
 *
 * pic, pics, headshot, portrait, photoshoot and photos join the noun list, and a PLURAL gets its own arm, because a
 * plural takes no "a": "generate professional sports photos of her" names an artifact as plainly as "…a photo of her"
 * does. The arm keeps the discriminator's spirit — nothing between the verb and the noun may point at something she
 * has ("the", "my", "these", "it"), and `make` counts only as "make me …", so "make photos brighter" and "make my
 * photos brighter" stay edits. The same known wrong answer as "photograph": "make a black and white version of this
 * pic" is a new image, as "…of this photo" has always been — named and pinned. Not here: "generate pic of me …" with
 * no article (a singular without its indefinite), and the plurals headshots, portraits and photoshoots.
 */
export const EXPLICIT_GENERATE = new RegExp(
  [
    // A creation verb, an indefinite, and an artifact noun.
    String.raw`\b(generate|create|render|design|make)\s+(me\s+)?(a|an|another|new)\b[^.]{0,40}\b(image|photos?|photographs?|picture|pics?|headshot|portrait|photoshoot|shot|poster|graphic|render|asset|ads|ad|campaign|post|story|reel|banner|flyer|thumbnail|creative)\b`,
    // A plural takes no "a" (wave A, V3): a creation verb — `make` only as "make me" — an optional quantifier, up to
    // three words that point at nothing she has, and photos, pics or photographs.
    String.raw`\b(?:generate|create|render|design|make\s+me)\s+(?:(?:some|more|few|a\s+few|a\s+couple\s+of|a\s+set\s+of|two|three|four|five|six|\d+)\s+)?(?:(?!(?:the|this|that|these|those|my|her|his|their|our|your|its|it)\b)[a-z-]+\s+){0,3}(?:photos|pics|photographs)\b`,
  ].join("|"),
  "i",
);

/**
 * The operations a request is ALLOWED to resolve to. The classifier chooses within this set and can
 * never choose outside it.
 *
 * A GATE RATHER THAN A HINT, and it runs BEFORE any classification, because rule ② is only a
 * guarantee if the unsafe answer is unrepresentable. A prompt asking a model to prefer MASKED is a
 * request. An enum it cannot emit GENERATE from is a fact — this array is injected into the LLM
 * schema as the op enum (§5), so on a request with a source photo and no explicit new-image ask,
 * GENERATE is not a token the model is able to produce.
 *
 * ─── THE TWO CASES ─────────────────────────────────────────────────────────────────────────────
 *
 * NO SOURCE PHOTO. There is nothing to edit, so GENERATE is not a risk — it is the only coherent
 * answer, and it is returned ALONE rather than alongside the edit operations. An edit operation
 * chosen here would reach the edit pipeline with no base and become a 400.
 *
 * WITH A SOURCE PHOTO. Every edit operation is available; GENERATE only if she said so. This is the
 * case that closes the open bug. "make the socks blue" carries no verb from studio-contract.ts's
 * list, so `editBaseFor` returns null, `engineIntentFor` falls through to `image.generate`, and the
 * frame is replaced. Here it simply cannot: the sentence does not match EXPLICIT_GENERATE, so
 * GENERATE is absent from the returned set, so no downstream stage can pick it however the sentence
 * is read.
 *
 * ⚠️ `hasSourcePhoto` IS THE GUARD, NOT THE TEXT. The regex only ever ADDS GENERATE back to a set
 * that already excludes it. Removing the `hasSourcePhoto` fork does not leave a slightly weaker
 * check behind — it removes the guard altogether, which is what classify.test.ts pins by reverting
 * it.
 */
export function allowedOps(
  hasSourcePhoto: boolean,
  text: string,
): EditOperation[] {
  if (!hasSourcePhoto) return ["GENERATE"];
  const base: EditOperation[] = [
    "RECOLOR",
    "APPLY_DESIGN",
    "REPLACE_OBJECT",
    "REMOVE_OBJECT",
    "ADD_OBJECT",
    // A move only behind its switch (wave B, card 2), on the headline's precedent: off, it is outside
    // this set exactly as it is outside `route`.
    ...(moveObjectEnabled() ? (["MOVE_OBJECT"] as const) : []),
    // A headline only behind its switch (PR T): off, it is outside this set as it is outside `route`.
    ...(displayTextEnabled() ? (["DISPLAY_TEXT"] as const) : []),
    "CHANGE_BACKGROUND",
    "GLOBAL_STYLE",
    // PR 19, behind its switch: off, both are outside this set as they are outside `route`.
    ...(imageOpsEnabled()
      ? (["RELIGHT", "CAMERA", "CROP", "BRAND_MARK"] as const)
      : []),
  ];
  return EXPLICIT_GENERATE.test(text) ? [...base, "GENERATE"] : base;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE ROUTING TABLE, AND THE DETERMINISTIC FAST PATH THAT FEEDS IT
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** Where an operation is actually performed. The classifier never names one of these. */
export type EditPath =
  | "FULL_IMAGE"
  | "MASKED"
  | "BACKGROUND"
  | "GENERATE"
  | "ASK";

/**
 * OPERATION → PATH. Rule ① made concrete, and the only place the two vocabularies meet.
 *
 * Every future path change is an edit to this object. "Recolors should go full-image" is one row,
 * not a classifier change, not a prompt change, and not a new verb — which is the entire reason the
 * classifier was made to answer a question about her sentence rather than about our pipeline.
 *
 * RECOLOR AND GLOBAL_STYLE SHARE FULL_IMAGE, and that is worth saying out loud because it looks
 * like a mistake. They differ in prompt template, not in path: a recolor names a region in the
 * preservation prompt and a grade does not. Two rows, one path, no branch.
 *
 * ⚠️ AND THE CLAIM BEHIND `RECOLOR: "FULL_IMAGE"` IS NOW FALSIFIED ON REAL OUTPUT — 2026-09-09.
 *
 * The original handoff held that recolors belong on the full-image path. That was never measured;
 * it has now been tested, and it is wrong. The same recolor run with `STUDIO_GARMENT_MASK=false`
 * produced visible rectangle edges, hard boundaries at the top of each region, and a misaligned
 * crop — structural damage, not a seam. This is the THIRD independent result finding masked better
 * than no-mask (see the geometry investigation, which also retired the "recolors work better
 * without SAM" matrix as invalid).
 *
 * The claim is DEAD, not merely unproven. Nothing dispatches on this row yet — the cutover threads
 * only `ASK` into `runStudioGeneration`, never a path — so the table is inert here and no behaviour
 * follows from it today. But whoever wires path dispatch is the person this note is for: moving
 * RECOLOR to FULL_IMAGE at that point would reintroduce a failure that has now been seen three
 * times on real frames. Move it to MASKED then, or measure it again first.
 *
 * ⚠️ ─── 2026-09-10: RETIRED, NOT REFUTED — AND THE DISPATCH QUESTION IT WAITED ON IS DECIDED ─────
 *
 * The run above had STUDIO_GARMENT_MASK=false, and that flag never selected a full-frame path: it
 * still cropped and pasted back, on a rectangle. Full-frame itself was measured later, in the probe
 * memo's Q5 (1008px) and Q5L (4000px) arms, and the memo's "Routing decision" section records the
 * outcome: an edit her SENTENCE describes runs as one native full-frame call behind
 * STUDIO_NATIVE_EDIT (studio/nativeEdit.ts), and a box she DRAWS routes masked, permanently. Neither
 * record overwrites this note — that is the convention. This table is unchanged by the decision: it
 * still describes the flag-off product, and with the flag on the dispatch reads the frozen intent
 * rather than this row.
 *
 * ⚠️ ─── AND THAT VERDICT IS ABOUT RECOLOR, NOT ABOUT FULL_IMAGE. SCOPE IT WHEN YOU CITE IT. ────
 *
 * The measurement above compares two ways of doing the SAME job on an operation that HAS a region:
 * masked preserves everything outside it byte-exact, full-image regenerates those pixels and gets
 * nothing back for them. On that comparison full-image is strictly worse, and that is why the claim
 * is dead FOR RECOLOR.
 *
 * It says nothing about an operation with NO region to preserve. Adding an object that is not in
 * the frame yet has no surroundings to keep byte-exact, because there is no box to be outside of —
 * so "the re-render bought nothing" is not the trade being made there, and this evidence does not
 * transfer. A region-free operation on FULL_IMAGE has its own cost, and it is a different one: the
 * whole frame including HER is the model's output, with no composite guarantee behind it. Weigh
 * that on its own terms; do not settle it by pointing at this paragraph.
 *
 * ⚠️ AND SO DO BACKGROUND AND MASKED — TWO ROWS OVER ONE IMPLEMENTATION. There is no separate
 * background pipeline to go looking for. Both run `runMaskedEdit` (studio/generate.ts), both call
 * `masksForCrop` and `pasteBack`, and the ONLY difference is data: a background region carries a
 * `subjectNoun` and a whole-frame box, `polarityFor` reads that into `maskPolarity:
 * "preserve-inside"` (studio/segment.ts), and the composite inverts the mask in one line
 * (studio/composite.ts, the `invertMask` call in the mask block).
 *
 * They are separate ROWS because they are separate operations to her — "change my socks" and "put
 * me in a stadium" are not the same request — and separate rows are what let the two diverge later
 * without touching the classifier. But anyone reading this table and then grepping for background
 * control flow will not find any, and that is the expected outcome rather than a missing piece.
 */
export const ROUTE: Record<EditOperation, EditPath> = {
  RECOLOR: "FULL_IMAGE",
  GLOBAL_STYLE: "FULL_IMAGE",
  // ─── ADD_OBJECT IS NATIVE-ONLY. THERE IS NO MASKED ADD, AND THIS ROW DOES NOT CREATE ONE. ─────
  //
  // FULL_IMAGE because that is what an add IS: one call over the whole frame, with no region to
  // crop, because the thing being added is not in the photograph to be found. It is the region-free
  // case the note above says to weigh on its own terms, and the probe weighed it — Q1, 6/6, frame
  // held within ~4 excess once the ratio is pinned (docs/probes/2026-09-09-model-native-probe.md).
  //
  // ⚠️ THE ROW IS NOT A LICENCE TO RUN AN ADD ON THE LEGACY FULL-IMAGE PROMPT. The preview never
  // runs detection for an add, and with STUDIO_NATIVE_EDIT off it BLOCKS rather than sending her
  // sentence through buildPrompt (studio/nativeIntent.ts, the region-free arm). The only thing that
  // makes an add runnable is a frozen native intent, and the preview checks that on every read.
  ADD_OBJECT: "FULL_IMAGE",
  // PR 19: the ad's brand logo over the photo, like a watermark — one call over the whole frame, as a headline is.
  BRAND_MARK: "FULL_IMAGE",
  // ─── DISPLAY_TEXT IS NATIVE-ONLY TOO, FOR THE ADD'S REASON (PR T) ────────────────────────────────
  //
  // A headline has no region to crop: it is not in the frame until the edit writes it, across the top.
  // It is region-free (studio/nativeEdit.ts, REGION_FREE_OPS), so the preview never runs detection for
  // it, and with STUDIO_NATIVE_EDIT off it blocks exactly as an add does. The row is where it would run,
  // not a licence to run it anywhere else.
  DISPLAY_TEXT: "FULL_IMAGE",
  APPLY_DESIGN: "MASKED",
  REPLACE_OBJECT: "MASKED",
  REMOVE_OBJECT: "MASKED",
  // ─── A MOVE IS REGION-BEARING, WHICH IS THE ONLY CLAIM THIS ROW MAKES (wave B, card 2) ────────
  //
  // MASKED because the thing IS in the frame: detection has something to find, and that is what
  // separates a move from an add. It shares REMOVE_OBJECT's row for the same reason it shares its
  // shape — a move is that thing gone from A and standing at B.
  //
  // ⚠️ AND IT RUNS FULL-FRAME TODAY, LIKE EVERY OTHER OPERATION, because this table is inert with
  // STUDIO_NATIVE_EDIT on: the dispatch reads the frozen intent, never a row here. The row is where
  // a move WOULD run if the masked arm card 1 is about is ever built, not where it runs now.
  MOVE_OBJECT: "MASKED",
  CHANGE_BACKGROUND: "BACKGROUND",
  // PR 19: region-free, whole-frame, one native call — FULL_IMAGE, the look's row, so no client mirror changes.
  RELIGHT: "FULL_IMAGE",
  CAMERA: "FULL_IMAGE",
  // The whole frame, cut — never a model call: the preview plans image.crop for a lone CROP (studio/preview.ts).
  CROP: "FULL_IMAGE",
  GENERATE: "GENERATE",
};

/**
 * The order steps must RUN in, which is not the order she said them.
 *
 * ⚠️ FULL-IMAGE BEFORE MASKED, AND THIS IS A DATA-LOSS RULE RATHER THAN A PREFERENCE. A masked
 * composite pastes pixels into a fixed frame. A full-image re-render regenerates that frame. Run
 * them the other way round and the re-render destroys the composite — "make my jersey a blue adidas
 * kit" comes back as a blue jersey with no adidas on it, and nothing in the pipeline reports a
 * problem because both steps succeeded.
 *
 * ASK sits at 9 so a denied step sorts last wherever it appears; it never runs at all.
 */
export const PATH_ORDER: Record<EditPath, number> = {
  FULL_IMAGE: 0,
  BACKGROUND: 1,
  MASKED: 2,
  GENERATE: 3,
  ASK: 9,
};

/** REGION edits inside a target, SUBJECT_INVERSE edits around her, GLOBAL edits the whole frame. */
export type EditScope = "REGION" | "SUBJECT_INVERSE" | "GLOBAL";

export interface EditStep {
  op: EditOperation;
  /**
   * Short, literal, visible noun phrases a segmentation model could find. Never "the look".
   *
   * ⚠️ ON AN ADD, `targets[0]` IS THE THING BEING ADDED, and the rest are the SURFACES it lands on —
   * not "things to segment" (an add is never segmented) but "things this step touches or creates",
   * which is the question the person guard asks of every step. See rule 4½.
   */
  targets: string[];
  /**
   * What the target should become — "red", "adidas logo", "packed stadium". Null for a removal.
   * On an add: WHERE it goes, as she said it — "on the grass".
   */
  value: string | null;
  /**
   * HER COLOUR FOR EACH TARGET, ALIGNED TO `targets` — rule 5 only (wave D, card 2).
   *
   * Rule 5's `value` is `firstMatch` over the whole sentence: ONE colour, however many things she
   * named. So "make the jersey red and the shorts black" carried `RECOLOR [jersey, shorts] "red"`,
   * the pairing existed nowhere in the routing, and the freeze had to recover it from detection's
   * labels ("red jersey", "black shorts"). Live, detection wrote the BARE colours ["red", "black"],
   * which pair to no target, and the preview blocked with the rephrase line — she had named every
   * colour explicitly and was asked to say it again (acceptance B13, H5, R6).
   *
   * This is that pairing, from HER sentence, set only where she gave EVERY target a colour of its
   * own (`perTargetColours`). `targets` and `value` are untouched: the step's shape, its reading and
   * its route are exactly what they were, and this rides beside them for the freeze to prefer.
   *
   * ⚠️ ABSENT IS THE NORMAL CASE AND MEANS "SHE PAIRED NOTHING". One colour over several targets
   * ("make the jersey and the shorts black") is not this shape and must never become it — see
   * `perTargetColours`, and the `sole` guard in studio/nativeIntent.ts that it protects.
   *
   * ⚠️ AND IT IS INSIDE THE DRIFT GATE. A field that decides which colour each garment becomes may
   * not sit outside the quote-vs-spend re-check, so `intentsAgree` (studio/nativeEdit.ts) and
   * `stepKey`/`claimKey` (studio/interpret/canonical.ts) all read it. `fromPronoun` and `fromPut`
   * are outside it because they record HOW a step was read; this records WHAT it renders.
   */
  values?: string[];
  scope: EditScope;
  /**
   * TRUE when an ADD was headed by `put` — the one add verb that is equally a MOVE (D-2b).
   *
   * Rule 4¾'s own note says why it cannot be settled here: "put the ball on the ground" is a move if
   * the ball is already in the photograph and an insertion if it is not, and that is a fact about the
   * PHOTOGRAPH, which the classifier never sees. So the verb is recorded and the FREEZE decides, where
   * detection's regions are (studio/nativeIntent.ts, the ADD_OBJECT case).
   *
   * Absent on `add`, `place` and `stick`: "add a ball" is an insertion whatever is in the frame, and
   * the other two are ledgered as the same question rather than folded in.
   */
  fromPut?: true;
  /**
   * TRUE when this step's targets came from resolving a bare `them` against an earlier clause
   * (`resolvePronounClauses`, F-WB6). Absent on every step she named her things in directly.
   *
   * ⚠️ IT EXISTS BECAUSE THE FREEZE TAKES A RECOLOUR'S COLOUR FROM DETECTION'S LABEL, NOT FROM
   * `value` (studio/nativeIntent.ts, `recolourChange`) — which is right for "make the jersey red and
   * the shorts black", where the per-target colours only exist on the labels. It cannot work for a
   * pronoun: she said the colour ONCE, about things named in the clause before, so detection was
   * never asked for a colour on any of them and no label pairs one. Found live on 2026-09-17, after
   * the route-level cells passed — the freeze refused `unpaired_directive` while routing was correct.
   *
   * So this marks the one case where her own word is the only place the colour exists, and the freeze
   * may fall back to it. Nothing else changes: an unpaired recolour she named directly still refuses.
   */
  fromPronoun?: true;
  /**
   * What her sentence named that `value` leaves OUT — a brand change's model name or a word it cannot
   * read ("mercurials" in "swap the cleats for Nike Mercurials"), rule 4c only (2026-09-10, B.1c).
   * Never compiled into an instruction, always disclosed on the preview before she pays. Absent when
   * nothing was dropped, which is every other step.
   */
  dropped?: string[];
  /**
   * "object" when what a REPLACE_OBJECT becomes is the thing in the photo she ATTACHED — "change my
   * earrings to THESE gold hoops" (rule 3½, replace with reference). `value` still names it in her
   * words; this says it is hers, not ours to invent. Absent on every other step. `route` asks when no
   * Object photo is attached, and the freeze points the compiled clause at the one that is.
   */
  reference?: "object" | "style";
  /** DISPLAY_TEXT only (W-3, STUDIO_IMAGE_OPS): where the text goes. Absent is rule ⅛'s top banner. */
  placement?: "top" | "bottom" | "middle";
  /** DISPLAY_TEXT only (W-3): `value` is her words verbatim, fenced as data when compiled. */
  fencedText?: true;
  /**
   * A brand in HER words, fenced verbatim when compiled (PR 19, STUDIO_IMAGE_OPS): a brand the rules do not list,
   * on a garment swap (K33, R-18), or any brand named on an add (R-22 — "add a nike ball on the grass" is an add of
   * a ball, the brand beside it as data, never APPLY_DESIGN). Absent on every other step.
   */
  brand?: string;
}

/**
 * What the request carries beside the frame, as far as the classifier needs to know: how many OBJECT
 * photos (R's role — the Object tile, or a photo she resolved to "object"). One reading depends on it,
 * a replacement she points at a photo for (rule 3½), and nothing else does.
 *
 * ⚠️ A COUNT, AND THE CALLER'S, LIKE `hasSourcePhoto`. The route that spends re-derives it from the
 * frozen brief's own references (routes/studio.ts); the client's count only decides whether a preview
 * is asked for. A client that overstates it gets a preview that refuses at the freeze; one that
 * understates it gets the ask. Neither can reach a replacement pointing at a photo that isn't there.
 */
export interface Attached {
  objects: number;
  /**
   * Her STYLE references (PR 19, the look pointer): "match this look" points at one. Absent reads as none, so every
   * caller that predates it is unchanged.
   */
  styles?: number;
}

/** Nothing attached beside the frame — the default, and the side a missing count errs to. */
export const NOTHING_ATTACHED: Attached = { objects: 0 };

/**
 * What the fast path read. Steps only: `confidence` and `ambiguity` were deleted as one unit with `validate`'s two
 * floors and their `low_confidence*` asks (K8, ADI-R19 R-19) — the fast path always emitted 1 and null, so the floors
 * never fired, and `route` calls no model that could ever make them bite.
 */
export interface Classification {
  /** Ordered, and capped at MAX_STEPS — the pipeline's own MAX_EDIT_CALLS. */
  steps: EditStep[];
}

export interface Routed {
  /**
   * The path the job STARTS on — the first step's, after ordering.
   *
   * ⚠️ NAMED `initialPath` AND NOT `path` DELIBERATELY. Every step carries its own op and `ROUTE`
   * maps it, so a multi-step job has a path PER STEP and no single one. A field called `path`
   * reads as "the path", which is true for every deterministic case (single-step, or rule 4c's
   * brand change — one REPLACE_OBJECT step per item, so one op and one path) and quietly
   * false for the multi-step ones — the kind of thing a documented convention loses to a field
   * name. Callers wanting a specific step's path read `ROUTE[step.op]`.
   */
  initialPath: EditPath;
  steps: EditStep[];
  /** Why this was denied, when it was. Absent on a routed answer. */
  reason?: string;
  /**
   * Her keep, set aside from a sentence that routes (A3b, `route`): `preserve_person`, frozen beside the
   * steps as the interpreter's own constraint. Absent on every other answer, so they are unchanged.
   */
  constraints?: readonly EditConstraint[];
  /**
   * The words the rules read once her keep (A3b), or a keep of a thing (K2), was set aside — what detection
   * and the freeze read.
   */
  readAs?: string;
  /**
   * The `vague` ask's op chips (PR 19, R-6): sentences the rules read on their own, offered for her to tap into her
   * draft. Absent on every other answer.
   */
  suggestions?: readonly string[];
}

/** The pipeline's ceiling on edit calls (studio: MAX_EDIT_CALLS). A classification cannot exceed it. */
export const MAX_STEPS = 4;

// ─── The vocabulary the fast path matches on ───────────────────────────────────────────────────

export const COLOR =
  /\b(red|blue|green|yellow|orange|purple|violet|pink|black|white|gr[ae]y|brown|tan|beige|cream|navy|teal|cyan|magenta|maroon|crimson|scarlet|burgundy|gold(en)?|silver|bronze|lime|olive|mint|lavender|turquoise|indigo|coral|salmon|peach|charcoal|ivory|khaki)\b/i;
export const COLOR_MOD =
  /\b(light|dark|bright|deep|pale|neon|pastel|matte|metallic|hot|electric|off)\b/i;
export const HEX = /#[0-9a-f]{3,8}\b/i;

/**
 * HER COLOUR AS SHE SAID IT — the finish adjective included (wave D, card 4 / A15).
 *
 * "make my cleats matte black" froze the value `"black"`. "matte" is already on COLOR_MOD — it is why
 * the TARGET phrase stops before it — but rule 5's value was `firstMatch(colours, COLOR)`, the colour
 * word alone. So her adjective was read and then dropped, and because the compiled PROMPT carries her
 * whole sentence, the prompt and the frozen step disagreed about what was being made. Only the step
 * is queryable, so the disagreement was invisible until it was measured (acceptance A15).
 *
 * ⚠️ ONE MODIFIER, IMMEDIATELY BEFORE THE COLOUR. Not a second one ("bright matte black"), and not a
 * second COLOUR ("black and green") — that is a different discriminator, and it is not taken here.
 */
export const COLOUR_PHRASE = new RegExp(
  `\\b(?:(?:${COLOR_MOD.source.replace(/^\\b\(|\)\\b$/g, "")})\\s+)?(?:${COLOR.source.replace(/^\\b\(|\)\\b$/g, "")})\\b`,
  "i",
);

/**
 * K9's colour, with STUDIO_IMAGE_OPS on (PR 19): COLOUR_PHRASE, and a SECOND colour word right after the first —
 * "navy blue", "royal blue" is not one ("royal" is no colour), "sky blue" neither. "make the jersey navy blue" froze
 * "navy": the colour phrase stopped at one colour word, so her second word was read and dropped. Two colours joined
 * by "and" are still two ("black and green" is rule 5's F-WB7 case, read off the label), and a hex is unchanged.
 */
export const COLOUR_PHRASE_WIDE = new RegExp(
  `${COLOUR_PHRASE.source}(?:\\s+(?:${COLOR.source.replace(/^\\b\(|\)\\b$/g, "")})\\b)?`,
  "i",
);

/**
 * ─── A COLOUR WORD THAT IS PART OF A THING'S NAME IS NOT A COLOUR TO APPLY (wave A, G3) ─────────────────────
 *
 * "me walking the red carpet at an awards show" froze RECOLOR [awards show] "red": rule 5 saw "red", took the only
 * phrase it could extract ("the red carpet" ends at its colour), and a region detection will never find was to be
 * recoloured (sweep-4 ledger F-AM3). "me holding a gold medal on the podium" recoloured the podium gold. In each the
 * colour word names the thing — a red carpet is not a carpet made red.
 *
 * So rule 5 reads its colour OUTSIDE these compounds, and only rule 5 does: rule 2's setting ("put me on the red
 * carpet"), rule 3's look ("make it golden hour"), a brand change's descriptors and an add's thing read her words as
 * before. A sentence whose only colours are inside them is not a recolour, and asks — the interpreter's.
 *
 * ⚠️ A CLOSED LIST, NOT AN ADJACENCY RULE. "a colour followed by a noun is that noun's" needs to know which next word
 * is a noun: "make my headband pink too", "make the socks red now" put a word no stop list holds right after the
 * colour, and adjacency would stop recolouring them. A compound not on this list reads exactly as it did.
 *
 * ⚠️ NOT "golden hour", though it is the same shape. Rule 3 owns it as a look, and her keep beside it depends on rule
 * 5 reading it: A3b sets "keep me the same" aside only where her WHOLE sentence routes, and "make it golden hour, keep
 * me the same" routes whole only as RECOLOR [same] "golden" (measured: on the list, it asks and her keep is lost). Its
 * misreads on a region ("make the beach golden hour") are ledgered, not taken here.
 */
const COLOUR_COMPOUNDS =
  /\b(?:red carpets?|red cards?|yellow cards?|green screens?|white house|gold medals?|silver medals?|bronze medals?|black belts?)\b/gi;

/** Her words with the colour compounds taken out — what rule 5 reads its colour from. */
function outsideColourCompounds(text: string): string {
  return text.replace(COLOUR_COMPOUNDS, " ");
}
export const DESIGN =
  /\b(logo|swoosh|badge|crest|emblem|text|number|name|font|stripes?|pattern|print|graphic|sponsor|brand(ing)?|decal|patch|typeface|design|kit)\b/i;
export const BRANDS =
  /\b(adidas|nike|puma|under ?armour|new balance|reebok|jordan|umbro|kappa|castore|hummel|mizuno|asics|fila)\b/i;

/**
 * Is this, whole, a brand on BRANDS as the rules read one — lowercased, "nike", "new balance"? (the
 * interpreter, I.1)
 *
 * Exported so a frozen intent's `exclude_marks { brand }` names a brand in the rules' own vocabulary and
 * nothing else (studio/nativeEdit.ts, `EditConstraint`). ADDITIVE: no rule here reads it.
 */
export function isBrandName(s: string): boolean {
  const m = BRANDS.exec(s);
  return !!m && m.index === 0 && m[0].toLowerCase() === s;
}
const BG = /\b(background|backdrop|setting|scene|behind (me|her|him|them))\b/i;
/**
 * A BLUR OF THE BACKGROUND, WHICH IS A TREATMENT OF IT AND NOT A REPLACEMENT (wave D, card 4 / A14).
 *
 * "blur the background" already ROUTED — `CHANGE_BACKGROUND [person]` — and died at the freeze with
 * `missing_value`, because rule 2's value is a place after to/in/at/on/into and a blur names no
 * place. She was told to rephrase a sentence the rules had read correctly.
 *
 * There is no blur among the nine operations and this does not add one. A blur keeps the subject and
 * changes everything else, which is CHANGE_BACKGROUND's own contract (SUBJECT_INVERSE) — the
 * difference from a stadium is what the background BECOMES, and that is the value's job.
 */
const BG_BLUR = /\b(blur|blurred|blurry|bokeh)\b/i;

/** The one value that names a treatment rather than a place. The compile tier branches on it. */
export const BACKGROUND_BLURRED = "blurred";
const BG_PLACE =
  /\b(put|place|drop|set)\s+(me|her|him|them|us)\s+(in|at|on)\b/i;
/**
 * A removal verb. "take X off" (wave A, V4): "take the logo off my sleeve" is a removal as plainly as "take off the
 * logo" — a determiner, one to three words that are not a lone pronoun ("take it off" is not read), then "off".
 */
export const REMOVE =
  /\b(remove|delete|erase|take (out|off)|take\s+(?:(?:the|my|her|his|their|our|your|its|a|an|this|that|these|those)\s+)?(?!(?:me|myself|him|them|us|you|it)\s)(?!off\b)[a-z-]+(?:\s+(?!off\b)[a-z-]+){0,2}\s+off|get rid of)\b/i;
/**
 * A condition on the picture — "if there are any", "if there's one", "if any" (rule ¼). The spellings
 * she types without an apostrophe are hers too: "theres". Nothing else that contains "if".
 */
const CONDITIONAL =
  /\bif\s+(?:there\s+(?:are|is|were)\b|there['’]?s\b|theres\b|any\b)/i;
export const GLOBAL =
  /\b(black and white|b&w|monochrome|sepia|golden hour|colou?r grade|grading|film look|vintage look|warmer|cooler|brighter|darker|more contrast)\b/i;

/**
 * Words that introduce a noun phrase. The anchor the whole extractor hangs off.
 *
 * ⚠️ "it" IS NOT HERE, AND THAT ABSENCE IS THE RULE WORKING RATHER THAN A GAP. "make it black and
 * white" has no determiner, so it yields no target, so rule 3 fires and it is a global grade. A
 * pronoun refers to the whole frame; a determiner introduces a thing in it. That distinction is
 * doing the work that a list of "global-ish" phrasings would otherwise have to do badly.
 */
export const DETERMINERS = [
  "the",
  "a",
  "an",
  "my",
  "her",
  "his",
  "their",
  "our",
  "your",
  "its",
];

/**
 * Nouns that name the PICTURE or an abstraction, never a region inside it.
 *
 * Without this, "make the photo black and white" extracts a target of "photo", so rule 3 cannot
 * fire (it requires no target), rule 5 sees "black" and "white", and the whole frame is classified
 * as a RECOLOR of a region called "photo". A whole-frame word read as a region is the exact shape
 * of mistake the scope enum exists to prevent.
 *
 * It also states, as data, the line the spec draws in prose: targets are things a segmentation
 * model could find, "not 'the look', not 'the vibe'".
 *
 * ⚠️ CONSULTED FROM RULES 3 AND 5 ONLY, NEVER FROM RULE 2. Rule 2 matches the BG regex on the
 * sentence itself, so "change the background to a beach" routes on the word "background" and never
 * asks this set anything. Wiring the filter in earlier would be how "background" stops being a real
 * target and a background edit quietly loses the thing it is about.
 */
export const META_NOUNS = new Set([
  "color",
  "colour",
  "photo",
  "image",
  "picture",
  "shot",
  "frame",
  "look",
  "vibe",
  "style",
  "tone",
]);

/**
 * Words that END a noun phrase. Prepositions, conjunctions, copulas and the colour vocabulary.
 *
 * "get rid of the cone behind me" must yield "cone", not "cone behind me": a target is handed to a
 * segmentation model, and "cone behind me" is a sentence about a cone rather than a name for one.
 * Colours stop a phrase for the same reason — in "make the socks blue", "blue" is the value, not
 * part of what is being segmented.
 */
const PHRASE_STOP = new Set([
  "to",
  "for",
  "with",
  "behind",
  "in",
  "on",
  "at",
  "and",
  "or",
  "of",
  "from",
  "into",
  "onto",
  "under",
  "over",
  "beside",
  "near",
  "is",
  "are",
  "be",
  "been",
  "look",
  "looks",
  "looking",
  "instead",
  "please",
  "so",
  "that",
  "which",
  "but",
]);

/** At most three words, matching the noun bound the segmenter vocabulary already enforces. */
export const MAX_TARGET_WORDS = 3;

/**
 * Her sentence as lowercase tokens — words, hex colours, AND the punctuation between clauses.
 *
 * ⚠️ THE PUNCTUATION IS KEPT SO A PHRASE CAN END ON IT. The tokenizer used to match words only, so
 * a comma or a full stop simply vanished and a noun phrase walked straight across it: "add a soccer
 * ball to the image, place it in the middle of my cleats" extracted "image place it", and "…into the
 * first one. place it…" extracted "first one place". Both are the next CLAUSE glued onto a noun, and
 * `targets` is what a segmenter is handed. A phrase names one thing inside one clause; this is what
 * lets it know where the clause stopped.
 */
const TOKEN = /[a-z][a-z-]*|#[0-9a-f]{3,8}|[.,;:!?]/gi;
const PUNCTUATION = /^[.,;:!?]$/;

/**
 * ─── A PHOTO NAMED BY ITS NUMBER IS THE SAME POINTER AS ONE NAMED BY ITS ORDINAL (wave A, V1) ───────────────
 *
 * The tokenizer keeps no digits, so "the hoops in image 2" reached the rules as "the hoops in image" — a photo with
 * no ordinal, which rule 3½ does not read as hers (only "in the second image" was), and which an add read as the
 * FRAME ("in image" is "in the image"). The number is read off her raw words first: "image 2" is "second image",
 * "photo 1" "first photo", "picture 3" "third picture", any other single digit "other". Every rule that reads a
 * photo pointer (`sourceAt`, `frameRefAt`, `attachedPhotoAt`) then reads one family. "first" stays the frame, as
 * Mia's "change my earrings in the first picture to these gold hoops" has it.
 *
 * ⚠️ ONLY A DIGIT RIGHT AFTER A PHOTO NOUN. "number 10", "the 8 and nike logo" and "2nd" (tokenized "nd", ledgered)
 * are untouched, and anywhere a pointer is not read the extra word changes nothing: "image" is a META noun either way.
 */
const PHOTO_NUMBER = /\b(image|photo|picture|pic)\s*#?\s*([1-9])\b/gi;
const NUMBER_ORDINALS = ["", "first", "second", "third"];

function tokenize(text: string): string[] {
  const pointers = text.replace(
    PHOTO_NUMBER,
    (_, noun: string, n: string) =>
      `${NUMBER_ORDINALS[Number(n)] ?? "other"} ${noun}`,
  );
  return pointers.toLowerCase().match(TOKEN) ?? [];
}

/** One extracted phrase, WITH the word that introduced it. See `logFallThrough` for why. */
export interface TargetPhrase {
  /** "the", "my", "her" — kept because possessive and definite may not mean the same thing. */
  determiner: string;
  /** The noun phrase itself, lowercase, determiner stripped. */
  phrase: string;
}

/**
 * Her sentence → the noun phrases in it, deterministically.
 *
 * DETERMINER-ANCHORED, because a determiner is the one reliable signal that a thing in the picture
 * is being named, and it needs no vocabulary of nouns to find. A noun list here would be the closed
 * garment vocabulary all over again — brittle, silent when it misses, and load-bearing.
 *
 * ⚠️ IT DECLINES RATHER THAN GUESSES, and that is correct precisely because the fall-through is
 * ASK. A fast path that returns a wrong target confidently is worse than one that returns nothing:
 * nothing costs a clarifying question, wrong costs an edit to the wrong part of her photograph.
 */
export function extractTargets(text: string): TargetPhrase[] {
  return scanTargets(text, false) ?? [];
}

/**
 * The prepositions a removal names where its thing IS with (wave A, V4): "remove the logo FROM my sleeve", "…ON the
 * sleeve", "take the logo OFF my sleeve".
 */
const REMOVAL_PLACE_PREPS: ReadonlySet<string> = new Set(["on", "from", "off"]);

/**
 * Rule 1's targets: `extractTargets`, with WHERE a removed thing is read as its place (wave A, V4) — or null when a
 * place runs on into a list and which phrases are places is not guessed.
 *
 * ─── "REMOVE THE LOGO FROM MY SLEEVE" FROZE REMOVE [logo, sleeve] ────────────────────────────────────────────
 *
 * Rule 1 claims every phrase, and the freeze compiles one change per target: "remove the logo…", and "remove the
 * sleeve and fill the space where it was". "remove the logo from the photograph" removed the photograph. A phrase
 * right after on, from or off, right after a phrase this kept, says where that thing is. So it is not kept — with
 * the guard's exceptions intact:
 *   • a place that names her stays a target ("remove the tattoo on my arm" is her arm, and the guard refuses), unless
 *     the thing is worn — decision 2's own reading above, which takes "off" too ("take the cap off my head");
 *   • a place that runs on into a list — "remove the swoosh from the ball and the bench" — could be two places or a
 *     place and a second removal. Not guessed: rule 1 declines (null), and the sentence asks.
 * Only rule 1 reads places this way; every other rule's targets are `extractTargets`, unchanged.
 */
function removalTargets(text: string): TargetPhrase[] | null {
  return scanTargets(text, true);
}

function scanTargets(text: string, removal: boolean): TargetPhrase[] | null {
  const words = tokenize(text);
  const out: TargetPhrase[] = [];
  // The last phrase kept, and the index of its last word — what the location reading below needs.
  let last: { phrase: string; end: number } | null = null;
  // The index of the last word of a removal's place (V4), to see a list run on from it.
  let placeEnd = -1;
  for (let i = 0; i < words.length; i++) {
    if (!DETERMINERS.includes(words[i])) continue;
    if (removal && placeEnd === i - 2 && words[i - 1] === "and") return null;
    const determiner = words[i];
    const phrase: string[] = [];
    for (
      let j = i + 1;
      j < words.length && phrase.length < MAX_TARGET_WORDS;
      j++
    ) {
      const w = words[j];
      if (PUNCTUATION.test(w)) break;
      if (PHRASE_STOP.has(w) || DETERMINERS.includes(w)) break;
      if (COLOR.test(w) || COLOR_MOD.test(w) || HEX.test(w)) break;
      phrase.push(w);
    }
    // ⚠️ STRIPPED SO THE HEAD IS A NOUN. "make her arm bigger" extracts "arm bigger", whose head is
    // "bigger", and the person guard then reads a body edit as an ordinary object. The same strip
    // runs inside `namesPerson` — this one keeps the TARGET clean (SAM is handed whatever is in
    // `targets`, and "arm bigger" is not a thing a segmenter can find), that one keeps the GUARD
    // correct for callers that never come through here.
    const head = stripTrailingModifiers(phrase);
    if (!head.length) continue;
    // ─── WHERE A WORN THING IS, NOT A SECOND THING TO CHANGE (guard scope, decision 2) ───────────
    //
    // "change the earrings in my ears to gold" named two phrases, and the guard refused the sentence
    // over the second: RECOLOR [earrings, ears] is an edit to her ears. But "my ears" there says WHERE
    // the earrings are, and "change the earrings to gold" routes. So a phrase naming her that follows
    // a worn thing and a location preposition is the thing's location, and is not kept as a target.
    //
    // ⚠️ EVERY CONDITION IS LOAD-BEARING. The thing before the preposition must be a phrase this
    // extractor KEPT, ending on the word right before it — so the worn thing is always still a target
    // and no rule is left with nothing ("make these hoops on my ears black and white" keeps "ears",
    // or rule 3 would read an empty target list as a whole-frame look). It must be on WORN_ITEMS, a
    // closed list — "the tattoo on my arm" is her arm. And only the location goes: "…and my arms"
    // has no preposition, so it is a target, and the guard refuses the sentence as before.
    //
    // "around" and "through" do not END a phrase (PHRASE_STOP has neither), so "the chain around my
    // neck" arrives as the phrase "chain around" with "my neck" right behind it. The same reading takes
    // that shape too, and gives the kept target back its own name — "chain". Reachable only where the
    // next phrase names her, which made the sentence ask before; nothing that routed can move.
    const hers = namesPerson(head.join(" "));
    const afterPrep =
      last !== null &&
      last.end === i - 2 &&
      LOCATION_PREPS.has(words[i - 1]) &&
      namesWornItem(last.phrase);
    const tookPrep =
      last !== null &&
      last.end === i - 1 &&
      LOCATION_PREPS.has(words[i - 1]) &&
      namesWornItem(last.phrase.split(" ").slice(0, -1).join(" "));
    if (hers && (afterPrep || tookPrep)) {
      if (tookPrep && last) {
        const thing = last.phrase.split(" ").slice(0, -1).join(" ");
        out[out.length - 1] = { ...out[out.length - 1], phrase: thing };
      }
      last = null;
      if (removal) placeEnd = i + phrase.length;
      continue;
    }
    // ─── WHERE A REMOVED THING IS (V4, `removalTargets`) ───────────────────────────────────────────────────────
    //
    // "on" and "from" end a phrase; "off" does not, so "the logo off my sleeve" arrives as "logo off" with "my
    // sleeve" right behind it — the kept target gets its own name back, as "chain around" does above.
    const placed =
      removal &&
      !hers &&
      last !== null &&
      ((last.end === i - 2 && REMOVAL_PLACE_PREPS.has(words[i - 1])) ||
        (last.end === i - 1 &&
          words[i - 1] === "off" &&
          last.phrase.split(" ").length > 1 &&
          last.phrase.endsWith(" off")));
    if (placed && last) {
      if (last.end === i - 1) {
        const thing = last.phrase.split(" ").slice(0, -1).join(" ");
        out[out.length - 1] = { ...out[out.length - 1], phrase: thing };
      }
      last = null;
      placeEnd = i + phrase.length;
      continue;
    }
    out.push({ determiner, phrase: head.join(" ") });
    last = { phrase: head.join(" "), end: i + phrase.length };
  }
  return out;
}

// WORN_ITEMS and `namesWornItem` live in studio/objectVocab.ts, beside `namesPerson`: detection reads
// the same closed list when it decides whether a target names her (guard scope, the live-path fix).

/** The prepositions that say where on her a worn thing is — "in my ears", "around my neck". */
const LOCATION_PREPS: ReadonlySet<string> = new Set([
  "in",
  "on",
  "from",
  // "take the cap off my head" is "remove the cap from my head" (wave A, V4).
  "off",
  "around",
  "through",
]);

/**
 * The prepositions an add lands a thing ON her with — rule 4½'s surface ones and the ones a worn thing
 * sits in: "gold hoops TO my ears", "a watch ON my wrist", "these hoops IN my ears". Exported because the
 * native compiler words a worn add from the same words (studio/compile/templates.ts).
 */
export const ONTO_HER_PREPS: ReadonlySet<string> = new Set([
  "to",
  "onto",
  "on",
  "into",
  "in",
  "around",
  "through",
]);

/**
 * Does her sentence ADD something she would wear ONTO her — "add gold hoops to my ears", "put a stud
 * through my eyebrow", "add earrings to me"? (guard scope, G.3, 2026-09-10; a copy question only since
 * PR M3)
 *
 * G.3 asked every one of these `add_onto_body`, because D1 was Mia's. Since M3 rule 3¾b routes the ones
 * whose thing it reads onto a place that thing is worn on (`parseWornAdd`), so by the time
 * `declineReason` asks this, the sentence did NOT route: a piercing place, or a word beside the thing the
 * rule does not read. It chooses the words of the refusal and nothing else.
 *
 * Rule 4½'s own shape, read for this one question: the sentence LEADS with an add verb (past "please"
 * and rule 3¾b's "can you", so "can you put a stud through my eyebrow" gets the line the plain form
 * gets), the THING right after it is a WORN_ITEMS word, and — past a source ("from the second image") or
 * the frame ("to the first picture"), which rule 4½ consumes the same way — the next word is one of
 * ONTO_HER_PREPS, then her: a lone pronoun ("to me", "on her") or a phrase naming her ("in my ears").
 *
 * The worn word must be the THING. "add a logo to the watch on my wrist" puts a logo on a watch she
 * wears — a design on a worn thing, which decision 2 routes — and it must not read as a watch put onto
 * her. "add a tattoo on my arm" is not worn, so it keeps the guard's own person line.
 */
export function addsWornOntoHer(text: string): boolean {
  const t = tokenize(text);
  let i = pastPoliteness(t);
  if (!ADD_VERBS.has(t[i])) return false;
  i = pastAddParticle(t, i + 1);
  if (ADD_DETERMINERS.has(t[i])) i++;
  const thing: string[] = [];
  while (
    thing.length <= MAX_TARGET_WORDS &&
    isWord(t[i]) &&
    !ENDS_AN_ADD_PHRASE.has(t[i]) &&
    !ONTO_HER_PREPS.has(t[i]) &&
    !ADD_DETERMINERS.has(t[i])
  ) {
    thing.push(t[i]);
    i++;
  }
  if (!thing.length || !namesWornItem(thing.join(" "))) return false;
  i = sourceAt(t, i) ?? i;
  i = frameRefAt(t, i) ?? i;
  if (!ONTO_HER_PREPS.has(t[i])) return false;
  return herAt(t, i + 1) !== null;
}

/**
 * Her, at `i`, as the place a worn thing goes: a lone pronoun ("to me", "on her"), which has no words, or
 * a phrase that names her ("my left ear") — at most three words, a determiner before them dropped. Null
 * when what is there does not name her.
 */
function herAt(
  t: string[],
  i: number,
): { words: string[] | null; next: number } | null {
  // "to her" is her; "to her ears" is a phrase that names her — "her" is both.
  const determines =
    DETERMINERS.includes(t[i]) &&
    isWord(t[i + 1]) &&
    !PHRASE_STOP.has(t[i + 1]);
  if (OBJECT_PRONOUNS.has(t[i]) && !determines) {
    return { words: null, next: i + 1 };
  }
  let j = i;
  if (DETERMINERS.includes(t[j])) j++;
  const words: string[] = [];
  while (
    words.length < MAX_TARGET_WORDS &&
    isWord(t[j]) &&
    !PHRASE_STOP.has(t[j]) &&
    !DETERMINERS.includes(t[j])
  ) {
    words.push(t[j]);
    j++;
  }
  return words.length && namesPerson(words.join(" "))
    ? { words, next: j }
    : null;
}

/**
 * The words that may stand before a worn place's head: which side, which finger — and nothing else.
 */
const WORN_PLACE_SIDES: ReadonlySet<string> = new Set([
  "left",
  "right",
  "both",
  "upper",
  "lower",
  "ring",
  "index",
  "middle",
  "pinky",
  "little",
]);

/**
 * The part of her a worn thing's place names — "ear" in "my left ear" — or null when a word before it
 * says anything but WHICH one (PR M3, worn adds).
 *
 * ⚠️ A WORN PLACE NEVER DESCRIBES HER BODY. Her place reaches the compiled instruction ("worn on the
 * person's left wrist"), so "put a watch on my tattooed wrist" would ask the model for "the person's
 * tattooed wrist", and "a hat on my bald head" for a bald head — a body edit riding in on a worn add. So the
 * words before the head are a closed list (WORN_PLACE_SIDES), and anything else is not a worn place: the
 * rule declines, and the guard reads her wrist. The "s" a possessive leaves ("the statue's head") is not
 * on the list either.
 */
function wornPlaceHead(words: readonly string[]): string | null {
  const head = words.at(-1);
  return head && words.slice(0, -1).every((w) => WORN_PLACE_SIDES.has(w))
    ? head
    : null;
}

/**
 * The part of her a frozen add's place puts its thing ON — "ears" in "to my ears", "wrist" in "on my left
 * wrist" — or null for every other place (PR M3, worn adds).
 *
 * The compile tier's question (studio/compile/templates.ts): a worn add is worded "worn in the person's
 * ears", and every other add keeps its spatial wording. It reads the place with the classifier's own
 * reading of her, so the two cannot disagree about which places are hers. The whole place must be one
 * preposition that lands a thing on her, then her and nothing else, and its last word a place a worn
 * thing goes (WORN_PLACE_PREPOSITIONS). So "at her feet" (spatial), "on top of her head" (a place on top
 * of her), "on the grass beside her right foot" (two places) and "on me" (her, but no part of her) are
 * null, and compile exactly as they did.
 */
export function wornLocationOf(place: string): string | null {
  const t = tokenize(place);
  if (!ONTO_HER_PREPS.has(t[0])) return null;
  const her = herAt(t, 1);
  if (!her?.words || her.next !== t.length) return null;
  const head = wornPlaceHead(her.words);
  return head && WORN_PLACE_PREPOSITIONS.has(head) ? head : null;
}

/** The phrases rules 3 and 5 count as real regions — everything extracted, minus the meta nouns. */
function regionTargets(text: string): TargetPhrase[] {
  return extractTargets(text).filter((t) => {
    const head = t.phrase.split(" ").at(-1) ?? "";
    return !META_NOUNS.has(head);
  });
}

/**
 * ─── EACH TARGET'S OWN COLOUR, WHEN EVERY ONE OF THEM HAS ONE (wave D, card 2) ──────────────────────────────
 *
 * "make the jersey red and the shorts black" carried ONE step — `RECOLOR [jersey, shorts] "red"` — because rule
 * 5's value is `firstMatch` over the whole sentence: one colour, however many things she named. The pairing
 * existed nowhere in the routing, so the freeze had to recover it from detection's labels, and where detection
 * wrote the bare colours instead — which is what it did live — nothing paired and the preview blocked with the
 * rephrase line (acceptance B13, H5, R6).
 *
 * So where SHE paired a colour to each thing, the routing says so. Rule 5 still emits ONE step with the same
 * targets and the same value; this rides beside them as `values`, and the freeze prefers it over the labels
 * (studio/nativeIntent.ts). The step is NOT split: the freeze already emits one change per target whatever the
 * step shape, native compiles every change into ONE call (compile/assemble.ts), and a second step would change
 * the classification SHAPE that composition's decision 2a pins compare.
 *
 * ─── FAIL-CLOSED, AND THAT IS THE WHOLE SAFETY ARGUMENT ─────────────────────────────────────────────────────
 *
 * This reader does not decide the targets — `regionTargets` still does, unchanged. It only offers a colour for
 * each, and its phrase sequence must reproduce that list EXACTLY or it returns null and rule 5 emits precisely
 * what it always did. Every disagreement, of any kind, is a no-op rather than a different reading: the worn
 * location `regionTargets` drops ("the earrings in my ears"), a META noun it filters ("the color blue"), a
 * colour compound whose words this reads past ("the red carpet") — each makes the sequences differ, and nothing
 * pairs.
 *
 * ⚠️ ONE COLOUR AND SEVERAL TARGETS IS NOT THIS SHAPE, AND MUST NOT BECOME IT. "make the jersey and the shorts
 * black" has one colour, and "jersey" is followed by "and" — no pairing, so the single multi-target step
 * survives untouched. That is sweep 3.1's sentence, and the freeze's `sole` guard (studio/nativeIntent.ts,
 * `recolourChange`) is written against exactly that step shape: pairing it would give the jersey black AND the
 * shorts black from a reading she never gave, which is the defect the guard exists for.
 *
 * ⚠️ AND A TWO-TONE DECLINES THE WHOLE SENTENCE. "make the shorts black and green and the socks white" would
 * read "black" for the shorts and hand it to the freeze, silently dropping the "and green" that detection's
 * label carries today — F-WB7 measured that loss at 8 red cells when her word was let win too eagerly. A colour
 * that runs on into a second colour is a different discriminator with its own card, so this reader stops rather
 * than takes half of it.
 *
 * ⚠️ AND THE COLOUR COMPOUNDS ARE TAKEN OUT FIRST, as rule 5 takes them out of its own value (G3): "a gold
 * medal" names a thing, and its colour is not a colour to apply.
 *
 * Exported because studio/interpret/canonical.ts must predict what the rules will read back from C. It CALLS
 * this rather than copying rule 5's expression — the round trip already copies one value expression, and a
 * second copy is the one nobody updates.
 */
export function perTargetColours(
  text: string,
  targets: readonly string[],
): string[] | null {
  // One target is `sole`'s case and has no pairing to express; the fallback the freeze already has is right.
  if (targets.length < 2) return null;
  const words = tokenize(outsideColourCompounds(text));
  const phrases: string[] = [];
  const colours: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (!DETERMINERS.includes(words[i])) continue;
    // The phrase, read exactly as `scanTargets` reads it — same stops, same strip, same word bound.
    const phrase: string[] = [];
    let j = i + 1;
    for (; j < words.length && phrase.length < MAX_TARGET_WORDS; j++) {
      const w = words[j];
      if (PUNCTUATION.test(w)) break;
      if (PHRASE_STOP.has(w) || DETERMINERS.includes(w)) break;
      if (COLOR.test(w) || COLOR_MOD.test(w) || HEX.test(w)) break;
      phrase.push(w);
    }
    const head = stripTrailingModifiers(phrase);
    if (!head.length) continue;
    phrases.push(head.join(" "));
    const colour = colourAt(words, j);
    if (colour === null) return null;
    colours.push(colour);
  }
  // The reader must have seen HER targets, in her order, each with a colour of its own.
  //
  // ⚠️ THE LENGTH TEST GUARDS THE SHORTER DIRECTION ONLY, AND IT IS UNEXERCISED — say so rather than
  // let it read as load-bearing. Where this reader sees MORE phrases than `regionTargets` kept (a META
  // noun, a worn location) the comparison below catches it on its own: the extra phrase is compared
  // against `undefined` and differs. Where it sees FEWER, that comparison would pass on a prefix and
  // `values` would come back SHORTER than `targets`, which the freeze would read as "no colour for the
  // last one". Measured on the whole 8,533-sentence corpus with this line deleted: 24 steps carry
  // `values` and NONE is misaligned, so no sentence reaches it today (revert check RC6 comes back all
  // green, which is the finding, not a pass). It stays because the alignment is the contract.
  if (phrases.length !== targets.length) return null;
  if (phrases.some((p, k) => p !== targets[k])) return null;
  if (colours.some((c) => !c)) return null;
  return colours;
}

/**
 * Her colour for the thing whose name just ended at `j` — COLOUR_PHRASE's shape, "" where there is none, and
 * NULL where it runs on into a second colour and this reader must decline the whole sentence.
 *
 * ⚠️ COLOUR_PHRASE'S SHAPE EXACTLY, AND NOT A LOOSER ONE. One modifier at most, immediately before the colour
 * ("matte black", A15) — so a target's `values` entry and the step's own `value` are the same expression read
 * at two places, and a sentence with one target and one colour cannot disagree with itself.
 */
function colourAt(words: readonly string[], j: number): string | null {
  const runsOn = (k: number) =>
    (words[k] === "and" || words[k] === "or") &&
    !!words[k + 1] &&
    (COLOR.test(words[k + 1]) ||
      COLOR_MOD.test(words[k + 1]) ||
      HEX.test(words[k + 1]));
  if (j >= words.length) return "";
  if (HEX.test(words[j])) return runsOn(j + 1) ? null : words[j];
  // K9 (PR 19, STUDIO_IMAGE_OPS): COLOUR_PHRASE_WIDE's second colour word, read the same way here so a target's
  // `values` entry and the step's `value` stay one expression read at two places ("navy blue" on both).
  if (
    imageOpsEnabled() &&
    COLOR.test(words[j]) &&
    words[j + 1] &&
    COLOR.test(words[j + 1])
  ) {
    return runsOn(j + 2) ? null : `${words[j]} ${words[j + 1]}`;
  }
  if (COLOR.test(words[j])) return runsOn(j + 1) ? null : words[j];
  if (COLOR_MOD.test(words[j]) && words[j + 1] && COLOR.test(words[j + 1])) {
    return runsOn(j + 2) ? null : `${words[j]} ${words[j + 1]}`;
  }
  // A finish adjective with no colour after it ("make the cleats matte") is not a colour, and neither is
  // anything else — "and", a preposition, the end of her sentence.
  return "";
}

/** The first match of a pattern, lowercased — the value a step carries. */
function firstMatch(text: string, re: RegExp): string | null {
  return text.match(re)?.[0]?.toLowerCase() ?? null;
}

// ─── Stage 1: the deterministic fast path ──────────────────────────────────────────────────────

/**
 * High precision only. Anything it is not sure about returns null and becomes an ASK.
 *
 * ─── RULE ORDER IS LOAD-BEARING, AND TWO CASES PROVE IT ────────────────────────────────────────
 *
 * Both are in the golden set and both would misroute under a different order:
 *
 *   "get rid of the cone behind me"  BG matches "behind me". REMOVE runs first, so it is a removal.
 *                                    Reorder and a cone becomes a background replacement.
 *   "make it golden hour"            COLOR matches "gold(en)?". GLOBAL runs first, so it is a
 *                                    grade. Reorder and a time-of-day look becomes a recolor.
 *
 * ⚠️ RULE 4 BEFORE RULE 5 IS THE ENTIRE RECOLOR-VS-DESIGN DISTINCTION, and it is a fall-through
 * rather than a classification: a design or brand token ANYWHERE disqualifies the pure-recolor
 * shortcut, because "change my jersey to adidas" mentions no colour and means a graphic, while
 * "make my jersey a blue adidas kit" means both and is two steps. The fast path cannot tell apply
 * from replace, so it declines instead of guessing — which is why "adidas" reaching rule 5 and
 * being called a RECOLOR is the failure this ordering exists to prevent.
 *
 * ⚠️ 2026-09-10: apply-versus-replace is now DECIDED for the bare-brand sentence (rule 4c's note):
 * "change my jersey to adidas" routes as a REPLACE. So is the one with a descriptor: "make my jersey
 * a blue adidas kit" is ONE REPLACE whose value is "blue adidas jersey" — not two steps, and neither
 * half dropped. The ordering point is unchanged — a brand token still never reaches rule 5.
 */
export function classifyFast(
  text: string,
  hasSourcePhoto: boolean,
): Classification | null {
  const one = (step: EditStep): Classification => ({
    steps: [step],
  });

  // ─── RULE 0: GENERATE, AND ONLY WHERE THE GATE ALREADY PERMITS IT ──────────────────────────
  //
  // `allowedOps` decides whether GENERATE is LEGAL. Something still has to SELECT it, and with no
  // LLM stage this is the only place left that can — without this rule "generate a new poster of
  // me" falls through to ASK and net-new generation has no route at all.
  //
  // ⚠️ IT DOES NOT WEAKEN THE GATE, AND THE REASON IS THAT IT MAKES NO DECISION OF ITS OWN. The
  // condition is membership in the set the gate returned, nothing more. GENERATE is in that set
  // only when there is no source photo, or when EXPLICIT_GENERATE matched her sentence — so this
  // rule cannot select GENERATE in any case where commit 1 withheld it. It surfaces the gate's
  // answer; it does not form a second opinion.
  //
  // FIRST, because the alternative is being wrong. "generate a new poster of me" would otherwise
  // reach rule 2 or rule 5 on an incidental token and be classified as an edit to a photograph
  // that is not being edited. The hard invariant in `validate` re-checks the same condition
  // afterwards regardless, so the ordering is a correctness fix and not the safety property.
  const allowed = allowedOps(hasSourcePhoto, text);
  if (allowed.includes("GENERATE")) {
    // ─── AN AD OF HER PHOTO IS AN EDIT OF IT (ADI-R19-W3; STUDIO_IMAGE_OPS) ──────────────────────────────────
    // "make an ad for adidas" is EXPLICIT_GENERATE's shape ("ad" is on its noun list), so with her photo attached rule 0
    // made a new image of her. It falls through to the asks instead, exactly as "make this an ad for adidas" always
    // has — the interpreter's ad treatment reads it (interpret/ad.ts), an edit of her photo, one image. No photo: rule
    // 0's GENERATE, as today. ⚠️ MUTATION M-adGenerate: drop this line — "an ad of her photo is never rule 0's
    // generate" reds by name.
    if (imageOpsEnabled() && hasSourcePhoto && asksForAd(text)) return null;
    return one({ op: "GENERATE", targets: [], value: null, scope: "GLOBAL" });
  }

  // ─── PR 19'S WHOLE-SENTENCE READERS (STUDIO_IMAGE_OPS; studio/imageOps.ts) ──────────────────────────
  //
  // Before every other rule, because each is a closed shape for her WHOLE sentence and three of them replace a
  // misreading a later rule makes today: "change the lighting to golden hour" was RECOLOR [lighting] "golden",
  // "put me in the middle of the frame" was a background called "middle of the frame", and "add 'shop now' at
  // the bottom" was an object called "shop now" (R-25). Off, none of this runs.
  if (imageOpsEnabled()) {
    // Pose, action or expression → GENERATE (R-8). `validate` lets exactly this reading past the hard invariant.
    if (readPose(text)) {
      return one({ op: "GENERATE", targets: [], value: null, scope: "GLOBAL" });
    }
    const light = readRelight(text);
    if (light) {
      return one({ op: "RELIGHT", targets: [], value: light, scope: "GLOBAL" });
    }
    const angle = readCamera(text);
    if (angle) {
      return one({ op: "CAMERA", targets: [], value: angle, scope: "GLOBAL" });
    }
    // The ad's brand logo as a watermark — a brand the rules list only (a mark they know). ⚠️ MUTATION M-mark: drop
    // this — "add the adidas logo as a watermark is BRAND_MARK" reds by name.
    const marked = readBrandMark(text);
    if (marked && isBrandName(marked)) {
      return one({
        op: "BRAND_MARK",
        targets: [],
        value: marked,
        scope: "GLOBAL",
      });
    }
    // A crop: an aspect she posts at, or a tighter window (S-7). "zoom out" is not one — extend is faded.
    const crop = readCrop(text);
    if (crop) {
      return one({ op: "CROP", targets: [], value: crop, scope: "GLOBAL" });
    }
    // Weather is a background: the subject kept, the place kept, the weather changed (R-9).
    const weather = readWeather(text);
    if (weather) {
      return one({
        op: "CHANGE_BACKGROUND",
        targets: ["person"],
        value: weather,
        scope: "SUBJECT_INVERSE",
      });
    }
    // The look pointer (B): the attached style reference's look, through the spec-driven arm. `routeWords` asks
    // `style_reference_missing` when none is attached — the object pointer's pattern.
    if (readLookPointer(text)) {
      return one({
        op: "GLOBAL_STYLE",
        targets: [],
        value: POINTED_LOOK,
        scope: "GLOBAL",
        reference: "style",
      });
    }
    // These ask: `declineReason` names `vague`; the other two fall to the code their words already earn.
    // W-5: "change the angle" with no angle asks, with angle chips (`declineReason` names it).
    if (readAngleUnclear(text)) return null;
    // W-3: her quoted words as text on the photo — top, bottom or middle — fenced verbatim. Behind the headline's own
    // switch (STUDIO_DISPLAY_TEXT) as rule ⅛ is; words past the headline's bounds ask, as rule ⅛'s do.
    const said = displayTextEnabled() ? readTextAdd(text) : null;
    if (said) {
      if (headlineBound(said.words.toUpperCase())) return null;
      return one({
        op: "DISPLAY_TEXT",
        targets: [],
        value: said.words,
        scope: "GLOBAL",
        placement: said.placement,
        fencedText: true,
      });
    }
    // W-4: holding a thing is an add in her hand. One she cannot hold that way asks (add_unclear), never a generate.
    const hold = readHoldAdd(text);
    if (hold) {
      const inHand = parseAddObject(hold);
      if (inHand) {
        return one({
          op: "ADD_OBJECT",
          targets: [inHand.thing, ...inHand.surfaces],
          value: inHand.place,
          scope: "REGION",
        });
      }
      return null;
    }
    if (NAMES_A_HOLD.test(text)) return null;
    // M-2 (fixed): a quoted add that is none of the above asks — but ONLY a single clause, never rule ⅛'s exact shape
    // and never a compound, which are theirs to read (f6b391c7 asked on both, and so on the typed ad op's own sentence).
    const oneClause = !/,|\band\b/i.test(
      text.replace(/["“'‘][^"“”'‘’]*["”'’]/g, " "),
    );
    if (
      readVague(text) ||
      (readsQuotedAdd(text) && !readHeadline(text) && oneClause) ||
      readsFramePlace(text)
    ) {
      return null;
    }
  }

  // ─── RULE ⅛ — A HEADLINE, IN ONE STRICT SHAPE (the text op, PR T) ────────────────────────────────
  //
  // `add the headline "OWN THE MOMENT" across the top` is ONE DISPLAY_TEXT step: no target, her words as
  // its value (`readHeadline` has the shape). Only with STUDIO_DISPLAY_TEXT on (N4). Off, this rule is not
  // here, and the sentence asks below exactly as it did before PR T — `add_unclear`, rule 4½'s.
  //
  // ⚠️ HERE, BEFORE EVERY RULE THAT READS HER WORDS — NOT AFTER RULE 3½, WHERE PLAN V2 PUT IT. The plan's
  // reason for its place holds: it must come before rule 4, whose DESIGN list has "text". But the words
  // in her quotes are a headline, not an instruction, and every rule from ¼ to 5 reads them as one.
  // Measured on main (db76dc2, $0): "REMOVE ALL DOUBT" routes REMOVE_OBJECT [headline remove all, top]
  // (rule 1); "SET THE SCENE" and "BEHIND ME" route a background change (rule 2); "IF ANY" asks
  // `conditional` (rule ¼); "SEE RED" routes RECOLOR [headline see, top] red (rule 5). The shape is
  // anchored at both ends, so reading it first takes no sentence another rule reads correctly.
  //
  // AFTER RULE 0: a new image is the gate's answer, and with no photo there is nothing to write on. A
  // headline whose own words make EXPLICIT_GENERATE's shape ("MAKE A NEW POST") is still claimed there,
  // as on main, and the freeze refuses a GENERATE on a photo (`generate_on_edit`), so it never runs.
  //
  // Inside a compound it is reached per clause — rule ½ reads each clause with this function — so a
  // headline beside a background or a kit swap composes like any other change.
  if (displayTextEnabled()) {
    const words = readHeadline(text);
    if (words) {
      // ⚠️ WORDS OUT OF BOUNDS ASK (N8, `headlineBound`); THEY NEVER FALL THROUGH. Her sentence is this
      // rule's shape, so every rule below would read her headline as an instruction — "RED IS THE NEW
      // BLACK" is a recolour of [headline red, top] to rule 5.
      if (headlineBound(words)) return null;
      return one({
        op: "DISPLAY_TEXT",
        targets: [],
        value: words,
        scope: "GLOBAL",
      });
    }
  }

  // ─── RULE ¼ — A CONDITIONAL IS NOT READ (guard scope, 2026-09-10) ──────────────────────────────
  //
  // Mia's (d): "…i dont want any nike logos showing in this so if there are any remove them" froze
  // REMOVE_OBJECT [uniform] on 0cf9ae9 — rule 1 saw "remove", took the only determiner phrase in the
  // sentence ("my uniform", since "any nike logos" has none and "them" is a pronoun), and would have
  // compiled "remove the uniform". Composed beside a clause it could read, the whole sentence ROUTED.
  // The same destructive-compile class composition closed for two clauses, arriving through one.
  //
  // A condition is something no rule here reads — "remove it if it is there" is a question about the
  // picture, and every rule answers as if it were an instruction. So a sentence carrying one of these
  // markers is unreadable, and it asks with its own code. Narrow on purpose: the markers Mia used and
  // their spellings, nothing that merely contains "if" ("make the socks blue if possible" is a
  // politeness, and routes as before).
  //
  // AFTER RULE 0, like composition: a new image never reads a clause, and the gate's answer is the
  // gate's. BEFORE RULE ½, so a compound carrying a condition asks whole — each clause meets this
  // rule again on its own inside `compose`, which is what names the code.
  if (CONDITIONAL.test(text)) return null;

  // (G.3's early exit for an add of something she wears, onto her, stood here and asked `add_onto_body`:
  // D1 was Mia's to decide. She decided it — M3, worn items onto her are allowed — and rule 3¾b below
  // reads those sentences now, clause by clause. PR M3.)

  // ─── RULE ½ — A SENTENCE OF DIFFERENT CHANGES IS COMPOSED, ONE CLAUSE PER RULE (composition) ────
  //
  // Every rule below reads ONE change and claims every noun phrase in the WHOLE sentence. So a
  // sentence with two different changes routed as whichever rule matched first, and that rule took
  // the other change's nouns as its own. Sweep #3 retrieved what was actually sent
  // (docs/probes/sweep-3-part-b-findings.md, the addendum): "make her jersey blue and remove the
  // cleats" froze REMOVE [jersey, cleats] and compiled "remove the jersey" (Vertex IMAGE_SAFETY);
  // B-p5 compiled the same words and she PAID for a darkened jersey; rule 2 dropped the recolour from
  // "…and change the background to a stadium" and took the place from "at her feet".
  //
  // Composition PR 1 split the sentence (`splitClauses`) and ASKED here. PR 2 dispatches instead:
  // each clause goes through the rules below ON ITS OWN, so a rule sees only its own clause's nouns,
  // and the clauses' steps are handed on together to the unchanged `validate` — whose person guard
  // reads every step, so a body edit in any clause still refuses the whole sentence. What still asks,
  // and with which code, is `compose`'s.
  //
  // AFTER RULE 0, because GENERATE never composes — and because only here is a source photo certain
  // (with none, rule 0 has already returned), which is what `compose` assumes.
  const composed = compose(text);
  if (composed) {
    return composed.kind === "steps"
      ? { steps: composed.steps }
      : null;
  }

  // RULE 1 — removal. First, because REMOVE and BG overlap on "behind me".
  if (REMOVE.test(text)) {
    // Where a removed thing is, is not a second thing to remove (V4, `removalTargets`).
    const targets = (removalTargets(text) ?? [])
      .filter((t) => !META_NOUNS.has(t.phrase.split(" ").at(-1) ?? ""))
      .map((t) => t.phrase);
    // No target means no removal anyone can perform. "remove it" is a question, not an instruction.
    if (!targets.length) return null;
    return one({ op: "REMOVE_OBJECT", targets, value: null, scope: "REGION" });
  }

  // RULE 2 — the setting. Matches the sentence, never the extracted targets: see META_NOUNS.
  //
  // Targets are ["person"] and not "background", because this is the INVERSION path — the thing
  // named is the thing PRESERVED. That is also why the person guard has a CHANGE_BACKGROUND
  // exception at all: on this arm, naming her is not a leak, it is the whole mechanism.
  // W-4: "add a cone behind me" is an ADD whose place is behind her, not a background change.
  const addLed = /^\s*(?:please\s+)?(?:add|put|place|stick)\b/i.test(text);
  if (imageOpsEnabled() && addLed && BG.test(text)) {
    const behind = parseAddObject(text);
    if (behind) {
      return one({
        op: "ADD_OBJECT",
        targets: [behind.thing, ...behind.surfaces],
        value: behind.place,
        scope: "REGION",
      });
    }
  }

  if (BG.test(text) || BG_PLACE.test(text)) {
    // ⚠️ THE BACKGROUND AS A PLACE IS NOT A BACKGROUND CHANGE, AND IT ASKS (sweep #4, F-I2).
    //
    // "Add a large banner across the top of the background that reads GET LOUD in bold white capital
    // letters" matched the word, took its value from the first to/in/at/on/into phrase anywhere in
    // the sentence, and compiled "change the background to bold white capital letters" — a ready
    // preview for a replacement she never asked for. Whether a sentence failed closed (no such phrase,
    // so no value) or open (one) came down to one preposition.
    //
    // It ASKS rather than falling through, because what lies below is worse: rule 4½ cannot place
    // "across the top of…", and rule 5 reads the colour in "white letters" as a recolour of
    // [banner, top, …] — measured with the setting noun swapped out.
    if (namesBackgroundOnlyAsPlace(text)) return null;
    // The article ENDS AT A WORD BOUNDARY. Without the \b, "a" is tried first and matches the start of
    // any word: "to an arena" read "n arena", "to athletics track" "thletics track" (wave-1 fixes).
    const place = text.match(
      /\b(?:to|in|at|on|into)\s+(?:(?:a|an|the)\b)?\s*([a-z][a-z -]{0,40})/i,
    )?.[1];
    // Her place, or — where she named none — a blur of it. A place WINS: "change the background to a
    // blurred stadium" is a stadium, and takes the ordinary template branch because the value is not
    // `blurred` whole.
    const named = place?.trim().toLowerCase();
    return one({
      op: "CHANGE_BACKGROUND",
      targets: ["person"],
      value: named ?? (BG_BLUR.test(text) ? BACKGROUND_BLURRED : null),
      scope: "SUBJECT_INVERSE",
    });
  }

  // RULE 3 — a whole-frame look, and only when nothing in the frame was named.
  if (GLOBAL.test(text) && !regionTargets(text).length) {
    return one({
      op: "GLOBAL_STYLE",
      targets: [],
      value: firstMatch(text, GLOBAL),
      scope: "GLOBAL",
    });
  }

  // ─── RULE 3½ — A REPLACEMENT SHE POINTS AT A PHOTO FOR (replace with reference, 2026-09-11) ─────────
  //
  // "change my earrings to these gold hoops" is the founder's own use case, and it routed as RECOLOR
  // [earrings] "gold": "hoops" dropped, and the hoops photo she attached sent in the manifest and never
  // named in the instruction. "these", "this", "those" and "that" point at something she can see and
  // the sentence cannot say. With her Object photo attached that is the photo, so this is ONE
  // REPLACE_OBJECT of the thing she has for the thing in it, marked `reference: "object"`, and the
  // compiled clause names the image ("replace the earrings with the gold hoops from Image 2").
  //
  // BEFORE RULE 4, so a brand word inside what she points at ("these nike ones") is not read as a brand
  // change that drops "these" (rule 4c's degrade would, and disclose "not these specifically"). BEFORE
  // RULE 5, which would read "gold" as a recolour and drop the rest — the misroute this exists to end.
  // After rules 1 to 3: a removal, a background and a look each read their own sentences as before.
  //
  // ⚠️ A POINTER IT CANNOT READ ASKS; it never falls through to a rule that would drop it. Past this
  // line rule 4c drops "these" and rule 5 drops the noun, and either way her photo is ignored without a
  // word. That is deictic silently degraded to descriptive, which this PR exists to rule out.
  //
  // What is attached is not known here: this reads her words. With no Object photo, `route` asks.
  const pointed = readPointedReplacement(text);
  if (pointed === "unread") return null;
  if (pointed) {
    return one({
      op: "REPLACE_OBJECT",
      targets: [pointed.target],
      value: pointed.thing,
      scope: "REGION",
      reference: "object",
    });
  }

  // ─── RULE 3¾b — A THING SHE WEARS, ADDED ONTO HER (PR M3, Mia's M3) ──────────────────────────────
  //
  // "add these gold hoops to my ears" asked from the day adds existed: rule 4½'s surface was her ears, so
  // the person guard refused it — D1, Mia's call. She made it: worn items onto her are allowed, and body
  // modification never is. So an add of a thing on WORN_ITEMS, onto a part of her that thing is WORN on,
  // is ONE ADD_OBJECT whose only target is the thing. Her place is consumed as where it is worn — the
  // `value`, never a target — so the person guard reads the thing, as decision 2 reads "the earrings in my
  // ears". Her Object photo is the thing, as any add's is; with none, the edit invents it and says so.
  //
  // ⚠️ THE PLACE MUST BE THE THING'S OWN (objectVocab.ts, WORN_PLACES — N5). A ring goes on a finger, not
  // a lip: "add a ring to my lip" is not this rule's, so rule 4½ reads her lip as a surface and the guard
  // refuses it, as before. Of the piercings, only the NOSE routes here — a ring or a stud in it, which Mia
  // opened as pierced jewelry (M3.9). No worn thing's places hold a lip, an eyebrow or a navel.
  //
  // BEFORE RULE 4, so a brand on the thing is its brand: "put an adidas cap on my head" is a cap, and rule
  // 4a would read it as a design placed on her head. AFTER RULE ½, so a compound's add is read in its own
  // clause. After rules 1 to 3½, whose sentences never start with an add verb. `parseWornAdd` has the shape.
  const worn = parseWornAdd(text);
  if (worn) {
    return one({
      op: "ADD_OBJECT",
      targets: [worn.thing],
      value: worn.place,
      scope: "REGION",
    });
  }
  // ─── AND ONE IT COULD NOT READ ASKS WITH ITS OWN LINE, NOT THE PERSON LINE (PR M3.8) ────────────
  //
  // "add small gold hoops to my ears" is this rule's sentence with a word it does not read. Past this line
  // rule 4½ reads her ears as a surface and the guard answers "we don't edit people" — false of hoops, and
  // the plain sentence routes. It asks, as it did; only the code changes (`worn_add_unclear`). Here, before
  // rule 4, for the same reason the rule is: "a nike baseball cap" is not a design on her head.
  if (addsAnUnreadWornThing(text)) return null;

  // ─── RULE 4 — DESIGN AND BRAND, SPLIT IN TWO ───────────────────────────────────────────────
  //
  // It used to decline outright, on the theory that a design token signals a hard case. That theory
  // was wrong and it cost an entire operation: APPLY_DESIGN had NO ROUTE AT ALL, so every "add an
  // adidas logo to the jersey" became an ASK. For a NIL product that is the branding path — logos,
  // sponsor marks, jersey numbers — and it was 100% unreachable.
  //
  // A design token signals the APPLY_DESIGN OPERATION. Only some of those are hard, and the hard
  // ones are identifiable: they are the sentences with no verb saying what to DO with the design.
  // R-22 (STUDIO_IMAGE_OPS): a brand word on an add is data about the thing, not a design on a region. "add this
  // nike ball on the ground next to me" was APPLY_DESIGN [ground next] "this nike ball" — a misroute on the typed
  // door too, whose product op writes exactly that sentence. Read as the add without the brand, the brand beside it.
  if (imageOpsEnabled()) {
    const branded = readBrandedAdd(text);
    if (branded) return one(branded);
  }

  if (DESIGN.test(text) || BRANDS.test(text)) {
    // 4a — an explicit instruction to place a design ON something. Deterministic, no model needed.
    const step = applyDesignStep(text);
    if (step) return one(step);
    // ─── 4c — A BRAND CHANGE, AND IT IS A REPLACE (2026-09-10, a product decision) ─────────────
    //
    // 4b below declined "change my jersey to adidas" as branding-versus-kit, undecidable from the
    // sentence. Mia decided it (relayed by Adi): brand transformation is core product — an athlete
    // building a campaign concept for a pitch swaps her kit, the A3.2 use case — and the risk
    // control is the clearance state machine downstream, not a decline here. So the sentence with NO
    // design word takes the kit reading: each item becomes that brand's version of itself,
    // REPLACE_OBJECT, "adidas jersey". The logo reading is not lost; it has its own phrasing, and 4a
    // above already took it ("add an adidas logo to the jersey"). A design word on the value side is
    // APPLY_DESIGN; a bare brand as the whole value is a REPLACE. `parseBrandChange` has the shape.
    const brandSteps = parseBrandChange(text);
    if (brandSteps)
      return { steps: brandSteps };
    // 4b — a bare design or brand token with no placement verb. Still declines, and this is the
    // case rule 4 was actually written for: "change my jersey to adidas" is genuinely ambiguous
    // between adidas BRANDING and an adidas-STYLE kit, and picking one silently is how she gets a
    // whole new kit when she asked for a logo. Design-beats-colour survives here too — "make my
    // jersey a blue adidas kit" has no placement verb, so it declines rather than fast-pathing as
    // a recolor that quietly drops the adidas half.
    //
    // ⚠️ 2026-09-10: 4c above now claims BOTH examples, by the decision in its note — the blue
    // adidas kit as one REPLACE carrying its colour, so design-beats-colour still holds without a
    // decline: nothing reaches rule 5 and nothing is dropped. What still reaches 4b is a brand
    // sentence 4c could not read — a colour inside an item, a fifth item, a negation ("…to adidas
    // without stripes"), a second brand, anything left over. (A model name no longer does: B.1c
    // routes "swap the cleats for Nike Mercurials" as nike cleats, the model dropped and disclosed.)
    return null;
  }

  // K33 (PR 19, STUDIO_IMAGE_OPS): rule 4 above runs only on a sentence naming a DESIGN or a BRANDS word, and a brand
  // the rules do not list is neither — "swap my jersey to lululemon" never reached 4c. So 4c reads it here, and its
  // answer is taken only when it read an unlisted brand (`brand` on every step): no other sentence changes.
  if (imageOpsEnabled()) {
    const unlisted = parseBrandChange(text);
    if (unlisted?.every((s) => !!s.brand)) return { steps: unlisted };
  }

  // ─── RULE 4½ — ADD_OBJECT: A THING THAT IS NOT IN THE FRAME YET, PUT SOMEWHERE IN IT ────────────
  //
  // AFTER RULE 4, AND THAT POSITION IS THE WHOLE APPLY_DESIGN BOUNDARY. Any design or brand token
  // anywhere in the sentence has already been taken by rule 4 — parsed as a design, or declined — so
  // "add the nike logo to my shirt" can never reach here. What arrives is an add of a THING.
  //
  // BEFORE RULE 5, because an add can carry a colour that belongs to the thing: "add a red ball on
  // the bench" is not a recolor of anything, and rule 5 would read it as one if it could.
  // ─── RULE 4¾ — MOVE_OBJECT: A THING ALREADY IN THE FRAME, PUT SOMEWHERE ELSE IN IT ────────────
  //
  // BEFORE RULE 4½, and the order costs nothing today because no move verb is an add verb — the two
  // parsers can never both claim a sentence. It sits here anyway so that the day `put` or `place` is
  // read as a move at the classifier, the more specific reading is already the one that runs.
  //
  // ⚠️ BEHIND ITS FLAG, AT THE RULE (studio/config.ts, `moveObjectEnabled`), on PR T's precedent: off,
  // this is not here, "move the ball to the ground" asks `fast_path_declined` exactly as on main, and
  // the flag-off corpus diff is zero rows rather than "routes, then refuses".
  //
  // ⚠️ THE THING IS A TARGET AND THE DESTINATION IS THE VALUE, which is the shape that makes a move
  // region-bearing: detection is asked to FIND the thing, and a move that cannot find it is not a move
  // (studio/nativeIntent.ts refuses it rather than putting a second one down).
  if (moveObjectEnabled()) {
    const move = parseMoveObject(text);
    if (move) {
      return one({
        op: "MOVE_OBJECT",
        targets: [move.thing, ...move.surfaces],
        value: move.place,
        scope: "REGION",
      });
    }
  }

  const add = parseAddObject(text);
  if (add) {
    return one({
      op: "ADD_OBJECT",
      targets: [add.thing, ...add.surfaces],
      value: add.place,
      scope: "REGION",
      // `put` is an add HERE and may become a move at the freeze, which is the only place that can
      // know whether the thing is already in the photograph (D-2b; ledger F-WB5 (d) extended).
      ...(add.put ? { fromPut: true as const } : {}),
    });
  }
  // W-4 (STUDIO_IMAGE_OPS): an add with no place — "add a ball", "add a trophy" — is still an add: beside her
  // (PLACELESS_PLACE). It used to ask, and the ask could become a new image.
  if (imageOpsEnabled()) {
    const placed = withDefaultPlace(text);
    const beside = placed ? parseAddObject(placed) : null;
    if (beside) {
      return one({
        op: "ADD_OBJECT",
        targets: [beside.thing, ...beside.surfaces],
        value: beside.place,
        scope: "REGION",
      });
    }
  }

  // RULE 5 — colour on a named region. Reachable only because rule 4 already declined. The colour is read outside
  // a thing's own name — "the red carpet", "a gold medal" (G3, COLOUR_COMPOUNDS).
  const targets = regionTargets(text);
  const colours = outsideColourCompounds(text);
  if ((COLOR.test(colours) || HEX.test(text)) && targets.length) {
    const phrases = targets.map((t) => t.phrase);
    // Each thing with the colour SHE gave it, where she gave every one of them its own (card 2). The step
    // is otherwise untouched — same op, same targets, same value, same scope, same route — and absent
    // where she paired nothing, which is every sentence that reads as it did.
    const values = perTargetColours(text, phrases);
    return one({
      op: "RECOLOR",
      targets: phrases,
      // Her colour as she said it — "matte black", not "black" (A15).
      value:
        firstMatch(text, HEX) ??
        firstMatch(colours, imageOpsEnabled() ? COLOUR_PHRASE_WIDE : COLOUR_PHRASE),
      scope: "REGION",
      ...(values ? { values } : {}),
    });
  }

  // ─── RULE 5½ — THE SKY'S LOOK (wave A, V4; sweep-4 ledger F-CA2, F-AM1) ────────────────────────────────
  //
  // "make the sky moodier" named a region and a look, and no rule read both: rule 3 steps aside for any region, rule
  // 5 needs a colour, rule 5¾ a sentence that is wholly a look. So it fell to the catch-all, and the interpreter's
  // look on the sky came back invalid_slot — a new photograph of her instead of her sky. A look on the sky is a
  // change of its tone: RECOLOR [sky] with her look word, paired by detection like every recolour ("moodier sky").
  //
  // ⚠️ ONLY "THE SKY", AND ONLY A WHOLE LOOK. The rest of her sentence must be rule 5¾'s wholly-a-look, so "make the
  // sky and the grass moodier" asks, and a look on any other region — the jersey, her — is not read here. After rule
  // 5: a colour on the sky is still a colour. Whether SAM masks a sky well on the flag-off path is unmeasured
  // (ledgered); the native path reads no mask.
  const skyLook = readSkyLook(text);
  if (skyLook) {
    return one({
      op: "RECOLOR",
      targets: ["sky"],
      value: skyLook,
      scope: "REGION",
    });
  }

  // ─── RULE 5¾ — A SENTENCE THAT IS WHOLLY A LOOK (style vocabulary, 2026-09-14) ─────────────────────
  //
  // "make it moodier", "give it a cinematic look", "moody vibe": one GLOBAL_STYLE step whose value is
  // her look word. The widened list is studio/lookVocab.ts's, and so is the reading — every word of the
  // sentence a look word or one of the few words a look request is made of, and every look word one look.
  //
  // ⚠️ LAST, SO NO SENTENCE THAT ROUTES TODAY CAN ROUTE DIFFERENTLY. It is reached only where every rule
  // above declined, and rule ½ reads each clause with this function, so it only ever adds a reading to a
  // clause that had none — and a compound with an unread clause asked. Rule 3 keeps main's fifteen words
  // and its permissive grammar byte for byte; the widened words live here, where widening cannot move
  // "make it moodier and warmer" (rule 3 still says "warmer" — main's first-look-wins, recorded for its
  // own fix) or route "make it moodier, dont change anything about me" without her keep.
  const look = readWhollyLook(text);
  if (look) {
    return one({
      op: "GLOBAL_STYLE",
      targets: [],
      value: look,
      scope: "GLOBAL",
    });
  }

  // RULE 6 — not sure. The honest answer, and the one that cannot destroy a photograph.
  return null;
}

/** Her look word when her sentence is "the sky" and wholly a look besides — rule 5½ — or null. */
function readSkyLook(text: string): string | null {
  const sky = /\bthe\s+sky\b/gi;
  const found = text.match(sky);
  if (found?.length !== 1) return null;
  return readWhollyLook(text.replace(sky, " "));
}

/** Verbs that place a design ON a thing: "add a logo TO the jersey". */
const ADD_VERB = /\b(add|put|place|stick)\b/i;
/** The ditransitive verb: "GIVE the socks a striped pattern" — target first, no preposition. */
const GIVE_VERB = /\b(give|gives)\b/i;
/** What separates the design from the thing it goes on, in the prepositional construction. */
const PLACEMENT_PREP = /\b(to|onto|on)\b/i;

/** A phrase with any leading determiner removed — the value as she would say it. */
function withoutDeterminer(raw: string): string {
  const clean = raw.trim().replace(/\s+/g, " ");
  const [first, ...rest] = clean.split(" ");
  return rest.length && DETERMINERS.includes(first.toLowerCase())
    ? rest.join(" ")
    : clean;
}

/**
 * "add a logo to the jersey" → the step, or null when neither construction parses cleanly.
 *
 * ─── THE SPLIT IS WHAT MAKES `targets` CORRECT, NOT A TIDINESS PASS ────────────────────────────
 *
 * `extractTargets` finds BOTH noun phrases in "add an adidas logo to the jersey" — "adidas logo"
 * AND "jersey" — because both are introduced by a determiner and it has no way to know which one
 * is being placed on which. Handing that straight through would put "adidas logo" in `targets`,
 * and `targets` is what SAM is asked to segment. It would go looking for an adidas logo in a
 * photograph that does not have one yet, which is the whole point of the request.
 *
 * So the construction decides: the design is the VALUE and the thing it lands on is the TARGET.
 *
 * ⚠️ IT DECLINES RATHER THAN GUESSES, same rule as everywhere else in the fast path. No
 * preposition, no target, or a design token on the wrong side of the split, and this returns null
 * so 4b takes it to ASK. A wrong target here is a mask over the wrong part of her photograph.
 */
/**
 * R-22 (PR 19, STUDIO_IMAGE_OPS): an add whose thing carries a brand — "add a nike ball between my cleats", the typed
 * product op's "add this nike ball on the ground next to me" — read as the add of the THING, with the brand kept
 * beside it in her words for the compile to fence as data. Only a brand right after the add's determiner, only one
 * brand, and never a design ("add a nike logo to my sleeve" stays APPLY_DESIGN: its thing is a mark). An add the
 * rules cannot place without the brand ("add a nike ball") cannot be placed with it either, and asks as it would.
 */
const BRANDED_ADD =
  /\b(?:add|put|place|stick)\s+(?:a|an|the|this|these|that|those|my|some)\s+/i;
function readBrandedAdd(text: string): EditStep | null {
  const m = BRANDED_ADD.exec(text);
  if (!m) return null;
  const at = m.index + m[0].length;
  const b = BRANDS.exec(text.slice(at));
  if (!b || b.index !== 0) return null;
  const verbatim = text.slice(at, at + b[0].length);
  const rest = `${text.slice(0, at)}${text.slice(at + b[0].length).replace(/^[\s-]+/, "")}`;
  if (BRANDS.test(rest)) return null;
  // W-4: a placeless brand add ("add a nike ball") is beside her, as any placeless add is.
  const placed = withDefaultPlace(rest);
  const add = parseAddObject(rest) ?? (placed ? parseAddObject(placed) : null);
  if (!add || DESIGN.test(add.thing)) return null;
  return {
    op: "ADD_OBJECT",
    targets: [add.thing, ...add.surfaces],
    value: add.place,
    scope: "REGION",
    brand: verbatim,
    ...(add.put ? { fromPut: true as const } : {}),
  };
}

function applyDesignStep(text: string): EditStep | null {
  const design = (t: string) => DESIGN.test(t) || BRANDS.test(t);
  const step = (targets: string[], value: string): EditStep | null =>
    targets.length && value
      ? { op: "APPLY_DESIGN", targets, value, scope: "REGION" }
      : null;

  // ─── PREPOSITIONAL: add <value> to <target> ────────────────────────────────────────────────
  const add = ADD_VERB.exec(text);
  if (add) {
    const after = text.slice(add.index + add[0].length);
    const prep = PLACEMENT_PREP.exec(after);
    if (prep) {
      const valueSide = after.slice(0, prep.index);
      const targetSide = after.slice(prep.index + prep[0].length);
      // The design token must be on the VALUE side. "add a stripe to the logo" puts it on the
      // target side, which is a different request and not one this parse understands.
      if (design(valueSide) && !design(targetSide)) {
        const targets = regionTargets(targetSide).map((t) => t.phrase);
        return step(targets, withoutDeterminer(valueSide));
      }
    }
  }

  // ─── DITRANSITIVE: give <target> <value> ───────────────────────────────────────────────────
  //
  // Target FIRST and no preposition to split on, so this is a genuinely separate parse rather than
  // another verb in the list above. "give the socks a striped pattern" is a natural phrasing and
  // the prepositional parse cannot see it at all.
  const give = GIVE_VERB.exec(text);
  if (give) {
    const phrases = extractTargets(text.slice(give.index + give[0].length));
    // Exactly the shape this construction has: the thing, then the design. Anything else — one
    // phrase, or a design word on the target — is ambiguous and goes to 4b.
    if (phrases.length >= 2) {
      const target = phrases[0];
      const value = phrases[phrases.length - 1];
      if (design(value.phrase) && !design(target.phrase)) {
        return step([target.phrase], value.phrase);
      }
    }
  }

  return null;
}

// ─── Rule 4½'s parse: add <thing> <preposition> <place> ─────────────────────────────────────────

/** The verbs that put a thing into the frame — the same four rule 4a places a design with. */
const ADD_VERBS = new Set(["add", "put", "place", "stick"]);

/**
 * THE MOVE VERBS — a thing already in the frame, put somewhere else in it (wave B, card 2; ledger F-WA6).
 *
 * ⚠️ `put` IS NOT HERE, AND THAT IS THE WHOLE DESIGN. "put" heads a real add whenever the thing is not in
 * the frame yet — "put the gatorade bottle from image 2 on top of my head" is an add with its source named
 * out loud — and no rule can know which it is, because that is a fact about the PHOTOGRAPH and not about
 * her sentence. So `put` stays rule 4½'s add at the classifier, its route unchanged, and the freeze decides
 * (studio/nativeIntent.ts): definite thing, no source photo named or attached, and detection found it.
 * These three verbs say it themselves, so they need no evidence and read here.
 */
const MOVE_VERBS = new Set(["move", "shift", "slide"]);

/** A pronoun standing for a THING she already named — the fronted move's slot ("move IT closer"). */
const THING_PRONOUNS: ReadonlySet<string> = new Set(["it", "them", "they"]);

/**
 * Where an added thing goes. ADD-ONLY — rule 4a's PLACEMENT_PREP is deliberately NOT this list.
 *
 * Widening the shared one would move APPLY_DESIGN's value/target split too: "add a sponsor patch at
 * the top of the sleeve" would stop being an ASK and start routing with targets [top, sleeve].
 * classify.test.ts pins that sentence as still asking.
 *
 * ⚠️ SURFACE PREPOSITIONS LAND THE THING *ON* THE PLACE, SO THE PLACE IS A TARGET. The thing touches
 * it — a tattoo on her arm is an edit to her arm — and a target is exactly what the person guard in
 * `validate` reads. That is how the guard applies to an add UNCHANGED: nothing about the guard knows
 * what an add is; the parse just hands it every surface the step touches.
 *
 * (This note's example was "a hat on her head" until PR M3. A thing she WEARS, onto a part of her it is
 * worn on, is rule 3¾b's now and never reaches this parse; everything else onto her still does.)
 */
export const ADD_SURFACE_PREPS: readonly (readonly string[])[] = [
  ["onto"],
  ["on"],
  ["to"],
  ["into"],
];

/**
 * "IN", AND ONLY INTO HER HAND (wave D, card 5; Q8's item 2).
 *
 * "add a phone in my hand" is the sentence people type, and the classifier read no place from it —
 * `in` was on none of its add-preposition lists, so the parse found nothing and the sentence asked
 * `add_unclear`, while "near my hand" had routed all along.
 *
 * ⚠️ ITS OWN LIST, AND NOT AN ENTRY ON `ADD_SURFACE_PREPS`, FOR TWO REASONS. Admitting `in` as a
 * surface everywhere would make "add a ball in the net" an edit to the net. And `ADD_SURFACE_PREPS`
 * is spread into the interpreter's menu (`interpret/menu.ts`, ADD_PREPOSITIONS), which the prompt
 * renders verbatim — so an entry here would reorder that list and change the prompt's TEXT, which
 * costs a version bump and a fixture re-record for a set that did not change. The menu already
 * offered `in` from another list; what was missing was the classifier reading it back.
 */
const IN_HAND_PREPS: readonly (readonly string[])[] = [["in"]];

/**
 * SPATIAL PREPOSITIONS PUT THE THING *NEAR* THE PLACE, SO THE PLACE IS NOT A TARGET. Nothing at the
 * place is touched: a ball between her cleats changes neither the cleats nor her, and a bottle on
 * top of her head is Q1's positive control (q1-e), CLEAN. So these route even when the place names
 * her — the asymmetry with "on her head", accepted in D1 (and since PR M3, a worn thing ON her head is
 * rule 3¾b's; a thing that is not worn, on her, still asks).
 *
 * Q1 measured four of them — between, at, beside, on top of — 6/6. "next to" and "in the middle of"
 * are the §7.1 phrasings that ASKed live. Multi-word entries match before their first word does
 * ("on top of" before "on"), which is what keeps q1-e spatial rather than a surface of "top".
 */
export const ADD_SPATIAL_PREPS: readonly (readonly string[])[] = [
  ["in", "the", "middle", "of"],
  ["on", "top", "of"],
  ["next", "to"],
  ["between"],
  ["beside"],
  ["at"],
];

/**
 * ─── A PART OF HER NAMED AS WHERE A THING GOES, NOT AS WHAT CHANGES (wave A, G1; sweep-4 ledger F-L6) ──────
 *
 * "add a water bottle onto my head" was refused ("we don't edit people") and "…on top of my head" routed: one
 * preposition made her head a SURFACE, so the guard read it as a target, and the other made it a place.
 * A bottle on her head edits neither the bottle nor her; Q1 measured exactly that sentence clean (q1-e). So a
 * phrase naming a part of her, after one of these closed prepositions, is WHERE the thing goes. Adi's bound
 * (2026-09-17), both sides closed:
 *
 *   near, by, behind, in front of, toward(s), close to
 *       never touch her, so any part of her — or her, by pronoun ("in front of me"). These read ONLY her: "near
 *       the bench" asks as it did. (Rule 4½'s spatial ones — at, beside, next to, on top of, between — already
 *       never made a surface.)
 *   on, onto, to
 *       land the thing ON her, so only a part a thing rests on: HER_RESTING_PLACES. "put paint on my face" and "add
 *       a towel to my arm" keep the guard's refusal — a substance on her skin is an edit of her.
 *
 * ⚠️ NEVER FOR THESE THINGS, whatever the preposition — each keeps the refusal it had:
 *   • a body modification (BODY_MODS): "add a tattoo on my arm", "add a scar near my eye" are edits of her body;
 *   • a thing she wears (WORN_ITEMS): rule 3¾b's own table says which part of her each goes on, and a piercing is
 *     a worn thing onto a place not its own ("add a stud to my head" must not arrive as a placement);
 *   • a costume piece, or a word that means more than one thing, that M3 kept OFF WORN_ITEMS so it asks onto her
 *     (N6: crown, tiara, mask, shades — NOT_PLACED_ON_HER). A crown on her head is worn, not balanced; D1's own
 *     example of the side that stays refused, pinned across classify.test.ts;
 *   • a thing that names her.
 * And the part is named with nothing before it but which one ("my left foot"), as a worn place is
 * (`wornPlaceHead`): "near my tattooed arm" would carry a description of her body into the instruction.
 *
 * ⚠️ NOT ON THE INTERPRETER'S MENU. ADD_PREPOSITIONS (interpret/menu.ts) is built from the two lists above this
 * note and its words are in the prompt; these live apart so interpret/5's text does not move. Its `addOk` still
 * refuses a place naming her for anything not worn — the interpreter reads these sentences as it did.
 */
export const HER_PLACEMENT_PREPS: readonly (readonly string[])[] = [
  ["in", "front", "of"],
  ["close", "to"],
  ["toward"],
  ["towards"],
  ["near"],
  ["by"],
  ["behind"],
];

/**
 * "CLOSER TO my feet" is a MOVE, not a place (G1). "put the ball closer to my feet" was refused as an edit of her:
 * "closer" read as a word of the thing, "to my feet" as a surface. A comparative measures from where the thing
 * already is, and no rule reads a move — as an add it would put a SECOND ball down. So it ends the thing and is
 * read as no place: the sentence asks `add_unclear` (the interpreter's), never the person line and never an add.
 */
const MOVE_PREPS: readonly (readonly string[])[] = [["closer", "to"]];

/**
 * ─── WHERE A MOVE PUTS THE THING, AS AGAINST WHERE THE THING ALREADY IS (wave B, card 2; Adi's call) ──────
 *
 * A preposition after a moved thing is genuinely two sentences in English, and they want opposite readings:
 *
 *   move the ball ON THE GROUND closer to my feet    "on the ground" says WHICH ball — she has two
 *   move the ball TO THE GROUND                      "to the ground" says where it goes
 *
 * Read the first as a destination and the answer is the mangle F-WA3 is about: main's shape gave
 * `MOVE [ball, "ground closer"]` to "on the ground closer to my feet". So the two lists are split by what
 * the preposition MEANS rather than by where it sits:
 *
 *   DIRECTIONAL  to, onto, into, toward(s), closer to, next to, beside, between, on top of, in the middle of
 *                — a destination. A move REQUIRES one; with none, the sentence asks rather than guessing.
 *   LOCATIVE     on, in, at, by — where the thing already is. Consumed and dropped before the destination
 *                is read, the same way `sourceAt` and `frameRefAt` are consumed and dropped.
 *
 * ⚠️ THE IDENTIFICATION IS DROPPED, NOT CARRIED INTO THE TARGET, and that is deliberate. "ball on the
 * ground" is four words against MAX_TARGET_WORDS' three, and a target is what DETECTION is handed — a
 * phrase it cannot find is worse than a noun it can. So the target stays "ball", and the case her phrase
 * was disambiguating (two balls) is caught where the evidence actually is: the freeze sees two regions
 * matching and asks, rather than moving whichever one came back first (studio/nativeIntent.ts).
 *
 * ⚠️ `on` IS LOCATIVE HERE AND A SURFACE FOR AN ADD, and the asymmetry is the operation's. "add a ball on
 * the bench" has to mean the bench is where it lands, because the ball is not in the frame yet and there
 * is nowhere else it could be. "move the ball on the bench" has somewhere else it could be, so it does not.
 */
const MOVE_DIRECTIONAL_PREPS: readonly (readonly string[])[] = [
  ["in", "the", "middle", "of"],
  ["on", "top", "of"],
  ["closer", "to"],
  ["next", "to"],
  ["toward"],
  ["towards"],
  ["between"],
  ["beside"],
  ["onto"],
  ["into"],
  ["to"],
];

/** Where the moved thing ALREADY is — consumed and dropped, never the destination and never a target. */
const MOVE_LOCATIVE_PREPS: readonly (readonly string[])[] = [
  ["on"],
  ["in"],
  ["at"],
  ["by"],
];

/** The parts of her a thing can be put ON without touching her skin — G1's contact prepositions reach only these. */
export const HER_RESTING_PLACES: ReadonlySet<string> = new Set([
  "head",
  "foot",
  "feet",
  "shoulder",
  "shoulders",
  "lap",
  // ⚠️ A HAND IS THE ONE RESTING PLACE WITH A SIZE GUARD ON WHAT MAY GO THERE — see HAND_SIZED.
  "hand",
  "hands",
]);

/** Her hands: the resting places whose contents are guarded by size. */
const HER_HANDS: ReadonlySet<string> = new Set(["hand", "hands"]);

/**
 * WHAT MAY BE PUT IN HER HAND — a closed list, and a RISK DECISION rather than a finding (wave D,
 * card 5; docs/probes/hand-add.md, Adi's verdict 2026-09-18).
 *
 * Q8 rendered one-hand objects into her hand 7/7 across hand states and both wordings. The ball was
 * the only object that failed anywhere — it grew a third arm — so the list is drawn around the
 * objects that passed.
 *
 * ⚠️ AND THE PROBE IS EXPLICIT THAT THIS IS COARSER THAN ITS OWN EVIDENCE, which is worth carrying
 * here rather than leaving in the document. 2 of the ball's 4 cells were CLEAN, both on a free hand
 * with "in" — so this is a choice not to ship a coin flip on the one object that ever failed, not a
 * finding that a ball in a hand cannot be rendered. The two failures also had DIFFERENT causes (one
 * the "to" wording, one an occupied hand), so a guard keyed on size alone is a proxy for both.
 * Anyone widening this list should read that section before concluding the model could not do it.
 */
const HAND_SIZED: ReadonlySet<string> = new Set([
  "phone",
  "phones",
  "bottle",
  "bottles",
  "water bottle",
  "water bottles",
  "can",
  "cans",
  "cup",
  "cups",
  "drink",
  "drinks",
  "keys",
  "medal",
  "medals",
]);

/** Is this thing small enough to be put in her hand? Its last word, or its last two. */
function handSized(thing: readonly string[]): boolean {
  const last = thing[thing.length - 1] ?? "";
  const pair = thing.slice(-2).join(" ");
  return HAND_SIZED.has(pair) || HAND_SIZED.has(last);
}

/** M3's N6 words (objectVocab.ts, WORN_ITEMS' note): kept off the worn list so they ask onto her, and never placed. */
const NOT_PLACED_ON_HER: ReadonlySet<string> = new Set([
  "crown",
  "crowns",
  "tiara",
  "tiaras",
  "mask",
  "masks",
  "shades",
]);

/** A thing that may be placed by her (G1) — not worn, not a costume piece, not a change to her body, not her. */
function placeableByHer(thing: readonly string[]): boolean {
  const words = thing.join(" ");
  return (
    !namesWornItem(words) &&
    !NOT_PLACED_ON_HER.has(thing[thing.length - 1]) &&
    !namesPerson(words) &&
    !thing.some(
      (w, k) => BODY_MODS.has(w) || BODY_MODS.has(`${w} ${thing[k + 1]}`),
    )
  );
}

/** A part of her, named with nothing before it but which one — "my left foot" → its words — or null. */
function herPart(words: readonly string[]): boolean {
  return (
    namesPerson(words.join(" ")) &&
    wornPlaceHead(words) !== null &&
    !OBJECT_PRONOUNS.has(words[0])
  );
}

/** A place can chain — "on the grass beside her right foot" (q1-c). Bounded, and declined past it. */
const MAX_PLACE_SEGMENTS = 2;

/**
 * Where the thing comes FROM — "from the second image". Not a place, and not the thing: it names the
 * attached photograph, which the request carries in the object slot whatever the sentence says.
 */
const SOURCE_ORDINALS = new Set([
  "first",
  "second",
  "third",
  "other",
  "last",
  "attached",
]);
const SOURCE_NOUNS = new Set([
  "image",
  "photo",
  "picture",
  "pic",
  "attachment",
  "reference",
  "ref",
  "upload",
  "one",
]);

/**
 * What it goes INTO — "to the image", "into the first one". Names the frame, not a place in it. Read
 * as a place, "add a soccer ball to the image" would route with the place "to the image": a no-place
 * add wearing a preposition, which D2 does not ship.
 */
const FRAME_REF_PREPS = new Set(["to", "into", "in", "onto", "on"]);
const FRAME_ORDINALS = new Set(["first", "original", "main"]);

/** Words that may introduce the thing or the place. DETERMINERS, plus the demonstratives. */
const ADD_DETERMINERS = new Set([
  ...DETERMINERS,
  "this",
  "that",
  "these",
  "those",
  "some",
]);

/**
 * A place named by a pronoun — "on me", "next to her". Read as the person, never as a word: the
 * guard's list has no "me", and "add a tattoo on me" must reach it as what it is. Exported because
 * the native compiler turns the same words into "the person" (studio/nativeEdit.ts).
 */
export const OBJECT_PRONOUNS: ReadonlySet<string> = new Set([
  "me",
  "myself",
  "her",
  "herself",
  "him",
  "himself",
  "them",
  "themselves",
  "us",
  "you",
  "yourself",
]);

/**
 * Words that end the thing or a place. Every preposition — the ones the parse understands AND the
 * ones it does not, so "add a ball near my feet" stops at "near" and declines rather than adding a
 * "ball near my feet" — plus the conjunctions that start a second instruction.
 */
const ENDS_AN_ADD_PHRASE = new Set([
  "to",
  "onto",
  "on",
  "into",
  "in",
  "at",
  "next",
  "between",
  "beside",
  "near",
  "behind",
  "under",
  "over",
  "above",
  "below",
  "around",
  "inside",
  "against",
  "by",
  "from",
  "for",
  "with",
  "and",
  "or",
  "then",
  "so",
  "but",
  "which",
  "please",
]);

/** A thing that is no thing — "add it", "put something on the bench". */
export const VAGUE_NOUNS = new Set([
  "it",
  "one",
  "ones",
  "something",
  "anything",
  "thing",
  "things",
  "stuff",
]);

const isWord = (w: string | undefined): w is string =>
  w !== undefined && /^[a-z][a-z-]*$/.test(w);

/** Rule 4½'s reading of a sentence: the thing, the place, and every surface the thing lands on. */
export interface AddObjectParse {
  /** What is being added, determiner stripped — "soccer ball". */
  thing: string;
  /** Where, from its preposition on, in her words — "on the grass". */
  place: string;
  /** The places the thing lands ON. "person" for a pronoun. The person guard reads these. */
  surfaces: string[];
  /**
   * TRUE when she led with `put` — the one add verb that is equally a MOVE, and the reason rule 4¾'s
   * note says its question belongs to the freeze (D-2b). `add`, `place` and `stick` are not marked:
   * "add a ball" is an insertion whatever is in the frame, and `place`/`stick` are ledgered as the same
   * question rather than folded in, because each is its own behaviour change on its own sentences.
   */
  put?: true;
}

/**
 * A noun phrase at `i`: one optional determiner, then 1..max plain words. Too long is null. `endsAt` ends it early
 * — the thing, at a G1 preposition that is not already a word ending it ("closer to", "toward").
 */
function addPhraseAt(
  t: string[],
  i: number,
  max: number,
  endsAt: (k: number) => boolean = () => false,
): { words: string[]; next: number } | null {
  if (ADD_DETERMINERS.has(t[i])) i++;
  const words: string[] = [];
  while (
    isWord(t[i]) &&
    !ENDS_AN_ADD_PHRASE.has(t[i]) &&
    !ADD_DETERMINERS.has(t[i]) &&
    !endsAt(i)
  ) {
    words.push(t[i]);
    i++;
    // Declined, never truncated: a four-word thing cut to three is a different thing.
    if (words.length > max) return null;
  }
  return words.length ? { words, next: i } : null;
}

/** The multi-word preposition in `preps` that starts at `i`, longest first — or null. */
function prepAt(
  t: string[],
  i: number,
  preps: readonly (readonly string[])[],
): readonly string[] | null {
  const matches = preps.filter((p) => p.every((w, k) => t[i + k] === w));
  return matches.sort((a, b) => b.length - a.length)[0] ?? null;
}

/**
 * One placement: a preposition and what it names — "on the grass", "on her head", "next to me".
 * `surface` is the named place when the preposition lands the thing ON it, and null when it only
 * puts the thing near it.
 *
 * ⚠️ A LONE PRONOUN IS THE PERSON, WHICHEVER WAY THE PHRASE PARSE READ IT. "me" is a plain word to
 * `addPhraseAt`, so "on me" parses as a noun phrase ["me"] — and `namesPerson("me")` is false, the
 * guard's list having "her" and no "me". Measured: "put a hat on me" ROUTED before this check. "her"
 * is the other half: "on her head" is a determiner and a noun, "on her" is the person, and only the
 * phrase parse failing tells them apart.
 */
function addSegmentAt(
  t: string[],
  i: number,
  thing: readonly string[],
  moving = false,
): { surface: string | null; next: number } | null {
  const surfacePrep = moving
    ? prepAt(t, i, MOVE_DIRECTIONAL_PREPS)
    : (prepAt(t, i, ADD_SURFACE_PREPS) ?? prepAt(t, i, IN_HAND_PREPS));
  const spatialPrep = moving
    ? prepAt(t, i, MOVE_DIRECTIONAL_PREPS)
    : prepAt(t, i, ADD_SPATIAL_PREPS);
  const movePrep = prepAt(t, i, MOVE_PREPS);
  // ─── "CLOSER TO" IS NO PLACE FOR AN ADD AND THE DESTINATION FOR A MOVE (G1; wave B, card 2) ───
  //
  // G1 made a comparative end the thing and read no place, and said why in one line: "a comparative
  // measures from where the thing already is, and as an add it would put down a SECOND ball". That is
  // an argument about the ADD, not about the words — for a move, where the thing already is, is
  // exactly the right thing to measure from, and "closer to my feet" is the whole instruction.
  //
  // It reads like one of G1's NON-CONTACT prepositions, because that is what it is: moving a ball
  // closer to her feet never puts it ON her, so it takes any part of her, under the same bounds
  // (`placeableByHer`, `herPart`) and with no surface recorded.
  if (movePrep && !moving) return null;
  // G1's non-contact prepositions, where no list above reads a longer one: they read only her.
  const herPrep =
    moving &&
    movePrep &&
    movePrep.length > (prepAt(t, i, HER_PLACEMENT_PREPS)?.length ?? 0)
      ? movePrep
      : prepAt(t, i, HER_PLACEMENT_PREPS);
  if (
    herPrep &&
    herPrep.length > (surfacePrep?.length ?? 0) &&
    herPrep.length > (spatialPrep?.length ?? 0)
  ) {
    const j = i + herPrep.length;
    if (!placeableByHer(thing)) return null;
    const her = addPhraseAt(t, j, MAX_TARGET_WORDS);
    if (!her)
      return OBJECT_PRONOUNS.has(t[j]) ? { surface: null, next: j + 1 } : null;
    if (her.words.length === 1 && OBJECT_PRONOUNS.has(her.words[0])) {
      return { surface: null, next: her.next };
    }
    return herPart(her.words) ? { surface: null, next: her.next } : null;
  }
  // Longest wins across both lists: "on top of" (spatial) over "on" (surface).
  const spatial =
    !!spatialPrep && spatialPrep.length >= (surfacePrep?.length ?? 0);
  const prep = spatial ? spatialPrep : surfacePrep;
  if (!prep) return null;
  const j = i + prep.length;
  const noun = addPhraseAt(t, j, MAX_TARGET_WORDS);
  const lonePronoun = noun
    ? noun.words.length === 1 && OBJECT_PRONOUNS.has(noun.words[0])
    : OBJECT_PRONOUNS.has(t[j]);
  if (lonePronoun) {
    return { surface: spatial ? null : "person", next: j + 1 };
  }
  if (!noun) return null;
  // A place that names the photograph is no place in it: "on the photo" is the frame.
  if (META_NOUNS.has(noun.words[noun.words.length - 1])) return null;
  // G1: on, onto or to a part of her a thing rests on is where it goes — "onto my head", "to my feet".
  // And since card 5, "in my hand" — the one place reached by `in`, and the one with a size guard.
  const place = noun.words[noun.words.length - 1];
  const inHand = !spatial && prep[0] === "in";
  // G1's three contact prepositions reach every resting place, exactly as they did. `in` and `into`
  // reach ONE — her hand — so no other part of her changes how it reads.
  const contact =
    prep[0] === "on" || prep[0] === "onto" || prep[0] === "to";
  const held = (inHand || prep[0] === "into") && HER_HANDS.has(place);
  const restsOnHer =
    !spatial &&
    (contact || held) &&
    herPart(noun.words) &&
    HER_RESTING_PLACES.has(place) &&
    placeableByHer(thing) &&
    // A hand takes only what a hand holds; every other resting place is unguarded as before.
    (!HER_HANDS.has(place) || handSized(thing));
  // `in` is the in-hand reading and NOTHING ELSE. Anywhere else it is no place at all — the same
  // answer the parser gave when the word was on no list, so no sentence but a hand's can move.
  if (inHand && !restsOnHer) return null;
  return {
    surface: spatial || restsOnHer ? null : noun.words.join(" "),
    next: noun.next,
  };
}

/** The whole place — one placement, or two chained ("on the grass beside her right foot"). */
function addPlaceAt(
  t: string[],
  i: number,
  thing: readonly string[],
  moving = false,
): { words: string[]; surfaces: string[]; next: number } | null {
  const surfaces: string[] = [];
  let next = i;
  for (let n = 0; n < MAX_PLACE_SEGMENTS; n++) {
    const segment = addSegmentAt(t, next, thing, moving);
    if (!segment) break;
    if (segment.surface) surfaces.push(segment.surface);
    next = segment.next;
  }
  if (next === i) return null;
  return { words: t.slice(i, next), surfaces, next };
}

/**
 * "from the second image" at `i` → the index after it, or null. And "IN the second image" (wave A, V1): an attached
 * photo named after "in" is where the thing comes from too — `attachedPhotoAt`'s reading, so only an attached
 * ordinal or an attachment noun. "in the first picture" and "in the image" are the frame, `frameRefAt`'s.
 */
/**
 * Where a moved thing ALREADY is, at `i` → the index after it, or null (wave B, card 2).
 *
 * Consumed and DROPPED by `parsePlacement`, exactly as `sourceAt` and `frameRefAt` are: it says which
 * thing she means, and the thing's own noun is what detection is handed. See MOVE_LOCATIVE_PREPS for
 * why "on the ground" identifies for a move and lands for an add.
 */
function moveLocativeAt(t: string[], i: number): number | null {
  const prep = prepAt(t, i, MOVE_LOCATIVE_PREPS);
  if (!prep) return null;
  // ⚠️ THE SAME TERMINATOR THE THING TAKES. Without it "the ground" ran on into "ground closer" and ate
  // the destination's own first word, so "move the ball on the ground closer to my feet" came back as a
  // move to "to my feet". A phrase with no stop walks into the next preposition — the identical failure
  // the tokenizer keeps punctuation for (see TOKEN).
  const noun = addPhraseAt(
    t,
    i + prep.length,
    MAX_TARGET_WORDS,
    (k) =>
      prepAt(t, k, MOVE_DIRECTIONAL_PREPS) !== null || MOVE_VERBS.has(t[k]),
  );
  // A pronoun is not something she is identifying the thing BY — "move the ball on me" is not this.
  if (
    !noun ||
    (noun.words.length === 1 && OBJECT_PRONOUNS.has(noun.words[0]))
  ) {
    return null;
  }
  return noun.next;
}

function sourceAt(t: string[], i: number): number | null {
  if (t[i] === "in") return attachedPhotoAt(t, i);
  if (t[i] !== "from") return null;
  let j = i + 1;
  if (ADD_DETERMINERS.has(t[j])) j++;
  if (SOURCE_ORDINALS.has(t[j])) j++;
  return SOURCE_NOUNS.has(t[j]) ? j + 1 : null;
}

/** "to the image", "into the first one" at `i` → the index after it, or null. */
function frameRefAt(t: string[], i: number): number | null {
  if (!FRAME_REF_PREPS.has(t[i])) return null;
  let j = i + 1;
  if (ADD_DETERMINERS.has(t[j])) j++;
  const ordinal = FRAME_ORDINALS.has(t[j]);
  if (ordinal) j++;
  if (META_NOUNS.has(t[j]) || t[j] === "pic" || (ordinal && t[j] === "one")) {
    return j + 1;
  }
  return null;
}

/**
 * The second clause that carries the place — ", place it …", ". place it …", "and put it …".
 *
 * The G3 sentence and §7.1's fourth phrasing both put the place there, the second across a FULL STOP.
 * That is a deliberate, narrow crossing: the new sentence must be exactly "place/put it", and "it"
 * is the thing the first sentence added. Nothing else walks across a boundary.
 */
function continuationAt(t: string[], i: number): number | null {
  let j = i;
  if (t[j] === "," || t[j] === "." || t[j] === ";") j++;
  while (t[j] === "and" || t[j] === "then") j++;
  return (t[j] === "place" || t[j] === "put") && t[j + 1] === "it"
    ? j + 2
    : null;
}

/**
 * "put a water bottle on the grass" → the thing, the place and the surfaces, or null.
 *
 * ─── ITS OWN PARSE, AND NOT `extractTargets` ───────────────────────────────────────────────────
 *
 * `extractTargets` stops a phrase at a colour, because in RECOLOR the colour is the value — and that
 * stop is load-bearing there. Here the colour belongs to the thing: "add a red ball" extracts
 * NOTHING through it, and "place this ball" is not anchored at all ("this" is not one of its
 * determiners). So an add reads its own spans, and RECOLOR's rules stay exactly as they are.
 *
 * ─── IT DECLINES RATHER THAN GUESSES, LIKE EVERY OTHER RULE ────────────────────────────────────
 *
 * The verb must LEAD the sentence ("please" aside), so "make the socks blue and add a ball on the
 * bench" is never half-read as an add. A place is REQUIRED — an add with no place was never measured
 * (every Q1 cell named one), so "the model picks the spot" is not something this ships. And nothing
 * may be left over: a second instruction the parse did not read is the fast path dropping half of
 * what she said.
 *
 * ─── THE SHAPE ─────────────────────────────────────────────────────────────────────────────────
 *
 *   <verb> <thing> [from <the second image>] [into <the first one>] [, place it] <place> [from …]
 *
 * Every optional part is consumed and dropped: where the thing comes FROM is the attachment's job,
 * not the sentence's; what it goes INTO is the frame, which the request already is. Only the thing
 * and the place reach the intent.
 */
export function parseAddObject(text: string): AddObjectParse | null {
  return parsePlacement(text, ADD_VERBS, false);
}

/**
 * RULE 4¾'s PARSE — `<move verb> <the thing> <preposition> <place>` (wave B, card 2; ledger F-WA6).
 *
 * The same grammar as rule 4½'s add, with two differences and no third:
 *
 *   the verb   move, shift, slide — never `put`, which is rule 4½'s and whose move-or-add question is
 *              the FREEZE's, because it is a fact about the photograph (studio/nativeIntent.ts).
 *   the place  "closer to" is a destination here and no place there (`addSegmentAt`), which is the one
 *              line G1 wrote for a move that did not exist yet.
 *
 * Everything else is shared verbatim rather than copied — the thing's bound, the surfaces, the source
 * and frame pointers consumed and dropped, the "nothing may be left over" rule. A second parser that
 * drifts from the first is how "add" and "move" would come to disagree about what a place is.
 */
export function parseMoveObject(text: string): AddObjectParse | null {
  return parsePlacement(text, MOVE_VERBS, true) ?? parseFrontedMove(text);
}

/**
 * ─── A MOVE WHOSE THING IS NAMED BEFORE THE VERB: "for the ball on the ground, move it closer to my
 * feet" (wave B, card 2; Adi's call, 2026-09-17) ───────────────────────────────────────────────────
 *
 * The shape the G2 card's live repro is written in, and the reason it is worth its own reading: she
 * names the thing first BECAUSE there are two of them — "the ball in the air" was the first sentence's,
 * and this one is about the other. Every rule here wants the verb to lead, so without this the clause is
 * one no rule reads and the whole sentence asks `compound_partial`.
 *
 *   for <the thing> [where it already is] [,] <move verb> <it|them> <destination>
 *
 * ⚠️ BOUNDED AT BOTH ENDS, DELIBERATELY. The topic must be introduced by `for` — a bare fronted phrase
 * ("the ball on the ground, move it …") collides with rule 5's determiner-phrase reading, which claims
 * every such phrase as a region. And the verb's own thing slot must be a PRONOUN: "for the ball, move
 * the cone closer" names two different things and is not this sentence, so it declines rather than
 * guessing which she meant.
 *
 * ⚠️ IT ADDS NO NEW PLACE GRAMMAR. The destination is read by `parsePlacement` itself, over the text from
 * the verb on, with the pronoun swapped for the topic's own words — so a fronted move and a plain one
 * cannot come to disagree about what a destination is.
 */
function parseFrontedMove(text: string): AddObjectParse | null {
  const t = tokenize(text);
  let i = 0;
  while (t[i] === "please") i++;
  if (t[i] !== "for") return null;
  i++;

  const topic = addPhraseAt(
    t,
    i,
    MAX_TARGET_WORDS,
    (k) => MOVE_VERBS.has(t[k]) || prepAt(t, k, MOVE_LOCATIVE_PREPS) !== null,
  );
  if (!topic) return null;
  const head = stripTrailingModifiers(topic.words).at(-1);
  if (
    !head ||
    VAGUE_NOUNS.has(head) ||
    META_NOUNS.has(head) ||
    OBJECT_PRONOUNS.has(head)
  ) {
    return null;
  }
  i = topic.next;
  // Where it already is, identifying WHICH one — dropped, as it is on the plain form.
  i = moveLocativeAt(t, i) ?? i;
  while (i < t.length && PUNCTUATION.test(t[i])) i++;

  if (!MOVE_VERBS.has(t[i])) return null;
  const verb = t[i];
  // ⚠️ A THING PRONOUN, NOT `OBJECT_PRONOUNS` — that set is her (me, her, him, us, you) and has no
  // "it" at all, which is precisely the word this sentence turns on. A move's topic is a thing.
  if (!THING_PRONOUNS.has(t[i + 1])) return null;

  // The rest, read as the plain form with her topic back in the pronoun's place — one grammar, not two.
  const rest = `${verb} the ${topic.words.join(" ")} ${t.slice(i + 2).join(" ")}`;
  const read = parsePlacement(rest, MOVE_VERBS, true);
  return read && read.thing === topic.words.join(" ") ? read : null;
}

function parsePlacement(
  text: string,
  verbs: ReadonlySet<string>,
  moving: boolean,
): AddObjectParse | null {
  const t = tokenize(text);
  let i = 0;
  while (t[i] === "please") i++;
  if (!verbs.has(t[i])) return null;
  const led = t[i];
  i++;

  // G1: "the ball CLOSE TO my feet", "…CLOSER TO…" — a placement's or a move's first word is not a word of the thing.
  const thing = addPhraseAt(
    t,
    i,
    MAX_TARGET_WORDS,
    (k) =>
      prepAt(t, k, HER_PLACEMENT_PREPS) !== null ||
      prepAt(t, k, MOVE_PREPS) !== null,
  );
  if (!thing) return null;
  const head = stripTrailingModifiers(thing.words).at(-1);
  if (
    !head ||
    VAGUE_NOUNS.has(head) ||
    META_NOUNS.has(head) ||
    OBJECT_PRONOUNS.has(head)
  ) {
    return null;
  }
  i = thing.next;

  i = sourceAt(t, i) ?? i;
  i = frameRefAt(t, i) ?? i;
  i = continuationAt(t, i) ?? i;
  // WHERE IT ALREADY IS, before where it goes — a move only, and dropped (MOVE_LOCATIVE_PREPS).
  if (moving) i = moveLocativeAt(t, i) ?? i;

  const place = addPlaceAt(t, i, thing.words, moving);
  if (!place) return null;
  i = place.next;
  // "onto the grass from the second image" — the source can trail the place too.
  i = sourceAt(t, i) ?? i;

  while (i < t.length && (PUNCTUATION.test(t[i]) || t[i] === "please")) i++;
  if (i < t.length) return null;

  return {
    thing: thing.words.join(" "),
    place: place.words.join(" "),
    surfaces: place.surfaces,
    // `put` only — see AddObjectParse.put. A move's own parse never reaches here with it.
    ...(led === "put" && !moving ? { put: true as const } : {}),
  };
}

// ─── Rule 3¾b's parse: [can you] <add verb> <worn thing> <onto her> <her> (PR M3) ────────────────

/**
 * "can you", "could you", "would you" — a question she means as the instruction. Mia's own phrasing ("can
 * you add these earrings to my ears") asked `person_mentioned` before M3, because the verb did not lead.
 */
const POLITE_ASKS: ReadonlySet<string> = new Set(["can", "could", "would"]);

/**
 * Where her verb is, past "please" and one "can/could/would you" — the index the three readers of an add
 * onto her start from (rule 3¾b's parse, `addsWornOntoHer`, `addsABodyMod`), so the polite form of a
 * sentence is read, and refused, exactly as the plain one is.
 */
function pastPoliteness(t: string[]): number {
  let i = 0;
  while (t[i] === "please") i++;
  if (POLITE_ASKS.has(t[i]) && t[i + 1] === "you") {
    i += 2;
    while (t[i] === "please") i++;
  }
  return i;
}

/**
 * "add IN hoops" — "in" right after her add verb is a particle, not a place (wave A, V2): the index of the thing. Read
 * by the three readers of a worn add onto her, so "add in hoops" routes, asks and refuses as "add hoops" does. Not by
 * rule 4½: an add of a thing she does not wear still needs its place said (D2).
 */
function pastAddParticle(t: string[], i: number): number {
  return t[i] === "in" ? i + 1 : i;
}

/** Nothing left but punctuation and "please" — the end of what she asked. */
function endsAt(t: string[], i: number): boolean {
  while (i < t.length && (PUNCTUATION.test(t[i]) || t[i] === "please")) i++;
  return i === t.length;
}

/** Rule 3¾b's reading: the thing she wears, and where on her it goes. */
export interface WornAddParse {
  /** The worn thing, determiner stripped — "gold hoops", "nike headband". The step's only target. */
  thing: string;
  /** Where on her, from its preposition on, in her words — "to my ears", "on me". Never a target. */
  place: string;
}

/**
 * The worn thing at `i`: an optional determiner, then descriptors and at most one brand, then its head —
 * a WORN_ITEMS word, or two ("hair tie"). At most three words, declined past that rather than cut.
 *
 * ⚠️ NOTHING ELSE MAY BE IN IT, AND THAT IS WHAT KEEPS A BODY MODIFICATION OUT. The descriptors are rule
 * 4c's closed list (`isDescriptor`: colours, colour modifiers, five style words). Any other word before
 * the head — "tattoo choker", "nose ring", "small gold hoops" — is not this rule's, and the rules below
 * read the sentence exactly as they did before it.
 */
function wornThingAt(
  t: string[],
  i: number,
): { words: string[]; next: number } | null {
  if (ADD_DETERMINERS.has(t[i])) i++;
  const words: string[] = [];
  while (
    isWord(t[i]) &&
    !ENDS_AN_ADD_PHRASE.has(t[i]) &&
    !ONTO_HER_PREPS.has(t[i]) &&
    !ADD_DETERMINERS.has(t[i])
  ) {
    words.push(t[i]);
    i++;
    if (words.length > MAX_TARGET_WORDS) return null;
  }
  const headLength = wornHeadLength(words);
  if (!headLength) return null;
  const modifiers = words.slice(0, words.length - headLength);
  let brands = 0;
  for (let k = 0; k < modifiers.length; ) {
    const brand = brandAt(modifiers, k);
    if (brand) {
      brands++;
      k = brand.next;
    } else if (isDescriptor(modifiers[k])) {
      k++;
    } else {
      return null;
    }
  }
  return brands > 1 ? null : { words, next: i };
}

/** How many of a thing's last words are its WORN_ITEMS head: 2 for "hair tie", 1 for "hoops", 0 for none. */
function wornHeadLength(words: readonly string[]): number {
  if (words.length > 1 && WORN_ITEMS.includes(words.slice(-2).join(" "))) {
    return 2;
  }
  return WORN_ITEMS.includes(words.at(-1) ?? "") ? 1 : 0;
}

/**
 * "add these gold hoops to my ears" → the worn thing and where on her it goes, or null.
 *
 * ─── THE SHAPE ─────────────────────────────────────────────────────────────────────────────────
 *
 *   [please] [can|could|would you] [please] <add|put|place|stick> <worn thing> [from the second image]
 *   [to the first picture] <to|onto|on|into|in|around|through> <her> [from the second image]
 *
 *   worn thing  `wornThingAt`: descriptors and one brand, then a WORN_ITEMS head
 *   her         a lone pronoun ("on me", "to her"), or a phrase naming a part of her the thing is
 *               worn on (objectVocab.ts, WORN_PLACES) — "my ears" for earrings, never "my lips" —
 *               with nothing before it but which one ("my left ear"; `wornPlaceHead`)
 *
 * Nothing may be left over, as in rule 4½: "…to my ears, keep everything else the same" is not read.
 * Where the thing comes FROM is the attachment's job, consumed and dropped the way rule 4½ drops it.
 *
 * Every sentence it reads asked before PR M3 (`add_onto_body`, `person_target` or `person_mentioned`),
 * so it moves nothing that routed.
 */
export function parseWornAdd(text: string): WornAddParse | null {
  const t = tokenize(text);
  let i = pastPoliteness(t);
  if (!ADD_VERBS.has(t[i])) return null;
  const thing = wornThingAt(t, pastAddParticle(t, i + 1));
  if (!thing) return null;
  i = thing.next;
  i = sourceAt(t, i) ?? i;
  i = frameRefAt(t, i) ?? i;
  // ─── NO PLACE: WHERE THAT THING IS WORN (wave A, V2) ────────────────────────────────────────────────
  //
  // "add in hoops from the second picture" named no place, asked `add_unclear`, and C2 made it a new photograph.
  // A worn thing's anchor (objectVocab.ts, WORN_DEFAULT_PLACES) is its place, said as she would say it — "in my
  // ears" — so the step, the card and the compiled clause are exactly those of "add hoops to my ears".
  if (endsAt(t, i)) {
    const anchor = wornDefaultPlace(thing.words.join(" "));
    const prep = anchor && WORN_PLACE_PREPOSITIONS.get(anchor);
    return anchor && prep
      ? { thing: thing.words.join(" "), place: `${prep} my ${anchor}` }
      : null;
  }
  if (!ONTO_HER_PREPS.has(t[i])) return null;
  const from = i;
  const her = herAt(t, i + 1);
  if (!her) return null;
  // A lone pronoun is her, and the thing goes where it is worn. A part of her must be one the thing is
  // worn ON (N5), with nothing before it but which one — "my left ear", never "my tattooed wrist".
  if (her.words) {
    const head = wornPlaceHead(her.words);
    if (!head || !wornGoesOn(thing.words.join(" "), head)) return null;
  }
  const to = her.next;
  i = sourceAt(t, to) ?? to;
  while (i < t.length && (PUNCTUATION.test(t[i]) || t[i] === "please")) i++;
  if (i < t.length) return null;
  return { thing: thing.words.join(" "), place: t.slice(from, to).join(" ") };
}

/**
 * Is her sentence a worn add that rule 3¾b could not read ONLY because of the words of its thing — "add
 * small gold hoops to my ears", "put a baseball cap on my head", a second brand, a fourth word? (PR M3.8)
 *
 * Those asked with the person line ("we don't edit people… not a body"), which is false of them: the
 * same sentence said plainly routes. So they ask `worn_add_unclear`, whose line says to say it plainly.
 *
 * The rule's own shape with the thing read loosely — any plain words before a WORN_ITEMS head. Everything
 * else must be what the rule accepts: a place that is the thing's own, naming only which one (or her, by
 * pronoun), and nothing left over.
 *
 * ⚠️ NEVER WHERE THE PERSON LINE IS TRUE. A word before the head that names her ("a nose ring") or a body
 * modification ("a tattoo choker") keeps it, and so does every refusal the rule makes on the PLACE: one
 * outside the thing's own (a piercing, "a watch on my neck") or one that describes her body ("my tattooed
 * wrist"). Words left over after the place keep it too — they can carry a second change, and one to her.
 * This only takes the sentences whose one problem is words she can simply leave out.
 */
function addsAnUnreadWornThing(text: string): boolean {
  if (parseWornAdd(text)) return false;
  const t = tokenize(text);
  let i = pastPoliteness(t);
  if (!ADD_VERBS.has(t[i])) return false;
  i = pastAddParticle(t, i + 1);
  if (ADD_DETERMINERS.has(t[i])) i++;
  const thing: string[] = [];
  while (
    isWord(t[i]) &&
    !ENDS_AN_ADD_PHRASE.has(t[i]) &&
    !ONTO_HER_PREPS.has(t[i]) &&
    !ADD_DETERMINERS.has(t[i])
  ) {
    thing.push(t[i]);
    i++;
  }
  const headLength = wornHeadLength(thing);
  if (!headLength) return false;
  const modifiers = thing.slice(0, thing.length - headLength);
  if (
    modifiers.some(
      (w, k) =>
        namesPerson(w) ||
        BODY_MODS.has(w) ||
        BODY_MODS.has(`${w} ${modifiers[k + 1]}`),
    )
  ) {
    return false;
  }
  i = sourceAt(t, i) ?? i;
  i = frameRefAt(t, i) ?? i;
  // With no place, the thing's anchor is its place (V2) — so its words are its only problem.
  if (endsAt(t, i)) return wornDefaultPlace(thing.join(" ")) !== null;
  if (!ONTO_HER_PREPS.has(t[i])) return false;
  const her = herAt(t, i + 1);
  if (!her) return false;
  if (her.words) {
    const head = wornPlaceHead(her.words);
    if (!head || !wornGoesOn(thing.join(" "), head)) return false;
  }
  i = sourceAt(t, her.next) ?? her.next;
  while (i < t.length && (PUNCTUATION.test(t[i]) || t[i] === "please")) i++;
  return i === t.length;
}

// ─── Rule 2's boundary: the background named as a place (sweep #4, F-I2) ────────────────────────

/** The nouns BG names the setting with. Its other arm, "behind me", is a change of setting by construction. */
export const BG_NOUNS = new Set(["background", "backdrop", "setting", "scene"]);
const BG_BEHIND = /\bbehind (me|her|him|them)\b/i;

/**
 * Where the lead verb's object ends: every word that ends an add's thing, and the prepositions an add
 * names a place with that its parse does not know ("across the top of…"). NOT "of": "the colour of
 * the background" is one thing, and it is the background.
 */
const OBJECT_ENDS = new Set([
  ...ENDS_AN_ADD_PHRASE,
  "across",
  "along",
  "beneath",
  "underneath",
  "through",
  "throughout",
  "within",
  "atop",
  "upon",
  "that",
]);

/**
 * Does her sentence name the background only as a PLACE — never as the thing that changes?
 *
 * The test is the lead verb's OBJECT: the words after it, up to the first preposition. A setting noun
 * inside it ("change the background…", "make the colour of the background…", "add a beach scene") is
 * her changing the setting, and rule 2 reads the sentence exactly as before. An object that is
 * something else, with a setting noun after it ("add a banner … of the background"), is a change that
 * happens IN the setting.
 *
 * It only ever answers "not rule 2's", and it answers only where the answer is certain — every other
 * sentence goes on to rule 2 unchanged:
 *   • a lead word that is not a change verb has no object to find;
 *   • an empty object ("change to a beach background") may be one whose setting IS the value;
 *   • an object that starts with a pronoun ("make me stand in a stadium scene") may be her being put
 *     somewhere, and "her" is a determiner as often as it is her;
 *   • "put me in…" (BG_PLACE) and "…behind me" (BG's own arm) change the setting by construction.
 */
function namesBackgroundOnlyAsPlace(text: string): boolean {
  if (BG_PLACE.test(text) || BG_BEHIND.test(text)) return false;
  const t = tokenize(text);
  let i = 0;
  while (t[i] === "please") i++;
  if (!OPERATION_VERBS.has(t[i])) return false;
  const object: string[] = [];
  for (i++; isWord(t[i]) && !OBJECT_ENDS.has(t[i]); i++) object.push(t[i]);
  if (!object.length || OBJECT_PRONOUNS.has(object[0])) return false;
  if (object.some((w) => BG_NOUNS.has(w))) return false;
  return t.slice(i).some((w) => BG_NOUNS.has(w));
}

// ─── Rule 4c's parse: <verb> <items> to <brand> ─────────────────────────────────────────────────

/** The verbs a brand change is said with. `make` alone takes no link word: "make my socks nike". */
/**
 * ⚠️ `replace` AND `with` JOINED ON 2026-09-17 (deep sweep E1), AND THE ORDERING IS WHAT MAKES IT SAFE.
 *
 * "replace the nike logo to be adidas" refused live. Measured, the gap was never the plural — "change
 * the nike logos to adidas" and "make the logos adidas" both routed already, and so did "change the
 * nike logo TO BE adidas". It was this verb: `replace` was the one replacement word rule 4c never read.
 *
 * It cannot steal a pointed replacement, because RULE 3½ ALREADY CLAIMED IT (line ~1211, before rule 4):
 * "replace the earrings with these gold hoops" is read there, photo and all, and only sentences 3½
 * declined reach here. And rule 4c's own parse requires a BRAND in the value, so "replace the ball with
 * the one in image 2" still never matches it.
 */
const BRAND_VERBS = new Set([
  "change",
  "turn",
  "switch",
  "swap",
  "make",
  "replace",
]);
/** What joins the items to the brand — "to adidas", "into an adidas one", "for adidas ones". */
const BRAND_LINKS = new Set(["to", "into", "for", "with"]);
/** "…and shoes ALL to be adidas", "change BOTH my socks and shoes to nike". */
const BRAND_QUANTIFIERS = new Set(["all", "both"]);
/**
 * What may follow the brand in place of the item's own noun: "adidas ONES" (the items again, by
 * pronoun) and "a blue adidas KIT" — a brand's kit, whatever the item. The value always names the
 * ITEM ("blue adidas jersey"), so the head she used never changes what is replaced.
 */
const BRAND_HEADS = new Set(["one", "ones", "kit"]);

/** Plain style words a brand change may carry beside its colours — "a VINTAGE adidas kit". */
const STYLE_WORDS = new Set(["retro", "vintage", "classic", "plain", "modern"]);

/** A regex's match covering the WHOLE word — COLOR.test("all-black") is true at the hyphen. */
const wholly = (re: RegExp, w: string) => re.exec(w)?.[0].toLowerCase() === w;

/**
 * A plain descriptor: a colour, a colour modifier, a style word, or a hyphenated run of them —
 * "blue", "light", "all-black", "black-and-white", "off-white", "vintage".
 *
 * ─── THE REFUSAL BOUNDARY IS THIS FUNCTION (2026-09-10) ─────────────────────────────────────────
 *
 * A brand change may carry words beside the brand — "make my jersey a blue adidas kit" — and they
 * ride into the value verbatim (Mia's decision covers a brand transformation WITH a descriptor). The
 * line between a descriptor and a model name is not one a rule can see: "Mercurials" and "Classic"
 * are both just a word beside a brand. So the descriptors are a CLOSED list and every other word is
 * left over, and the sentence asks. A model name is refused not because it is recognised but because
 * it is not — the only direction this can fail safe.
 *
 * ⚠️ B.1c (2026-09-10, Adi's product call): a word off the list no longer asks — it is DROPPED from
 * the value and disclosed on the preview (`isDroppable`), so "Nike Mercurials" gets nike cleats, not
 * a refusal. This list still decides what is KEPT: the model name is dropped because it is not
 * recognised, which is still the direction that fails safe — nothing unread reaches the model.
 */
export function isDescriptor(w: string | undefined): w is string {
  if (!isWord(w)) return false;
  const parts = w.split("-");
  const plain = (p: string) =>
    wholly(COLOR, p) || wholly(COLOR_MOD, p) || STYLE_WORDS.has(p);
  // "all" and "and" only JOIN a compound's parts: "all-black", "black-and-white".
  const joins = (p: string) => parts.length > 1 && (p === "all" || p === "and");
  return parts.some(plain) && parts.every((p) => plain(p) || joins(p));
}

/** At most this many descriptor words in one value — "bright black and white adidas" asks. */
export const MAX_DESCRIPTOR_WORDS = 3;

/**
 * At most this many dropped words — "mercurial superfly elite" drops, a fourth asks. The same bound
 * every target has: past it, what was dropped is most of what she said.
 */
const MAX_DROPPED_WORDS = 3;

/** Words that turn the rest around. Dropping "without" would give her the stripes she refused. */
export const NEGATIONS = new Set([
  "no",
  "not",
  "without",
  "except",
  "minus",
  "never",
]);

/**
 * A word a brand change may DROP from its value, with disclosure (B.1c): a plain word that is not a
 * descriptor, the brand or a head — a model name ("mercurials"), a word it cannot read ("glitchy").
 *
 * ⚠️ NOT EVERY UNREAD WORD. A word that joins or starts another clause ("and", "with", "the"), a
 * pronoun, and a negation are not droppable, so the sentence still asks: dropping those would lose a
 * second instruction or invert the first, and no disclosure makes that honest.
 */
const isDroppable = (w: string | undefined): w is string =>
  isWord(w) &&
  w.length > 1 &&
  !PHRASE_STOP.has(w) &&
  !DETERMINERS.includes(w) &&
  !BRAND_QUANTIFIERS.has(w) &&
  !OBJECT_PRONOUNS.has(w) &&
  !NEGATIONS.has(w);

/** The brand whose words start at `i` — "adidas", "new balance" — or null. Whole tokens only. */
function brandAt(
  t: string[],
  i: number,
): { brand: string; next: number } | null {
  const m = BRANDS.exec(t.slice(i).join(" "));
  if (!m || m.index !== 0) return null;
  const brand = m[0].toLowerCase();
  const next = i + brand.split(" ").length;
  // "adidas-branded" is one token, and the regex would take its first half. A brand is whole tokens.
  return t.slice(i, next).join(" ") === brand ? { brand, next } : null;
}

/**
 * One word of an item: a plain word, and none of the words that end one.
 *
 * ─── A DEMONSTRATIVE IS NEVER A WORD OF AN ITEM (I.0, 2026-09-12) ──────────────────────────────────
 *
 * "turn this into an adidas ad" ROUTED on d90efda: "this" is not a determiner, so it was read as the
 * item itself, and the sentence froze REPLACE_OBJECT ["this"] "adidas this", compiling "replace the
 * this with adidas this" — a ready preview, and if she approved it, a paid edit of nothing she named.
 * "change this jersey to adidas" did the same with "this jersey", and "change my socks and these to
 * adidas" replaced "these" beside the socks. "that" never did: it is in PHRASE_STOP.
 *
 * A demonstrative points at something the sentence cannot say. Rule 3½ reads it as the photo she
 * attached (POINTERS), rule 4½ as a determiner on the thing she adds; nothing reads it as a thing in
 * the frame. So here it ends the item, and a sentence whose item is one — or starts with one, or has
 * one in its list — asks rather than guessing which thing she means. It becomes an ASK, never a
 * different route: "change this jersey to adidas" is not read as "my jersey" either.
 */
const isItemWord = (w: string | undefined): w is string =>
  isWord(w) &&
  // The "s" a possessive leaves behind: "my jersey's logo" is declined, never read as "jersey s logo".
  w.length > 1 &&
  !PHRASE_STOP.has(w) &&
  !DETERMINERS.includes(w) &&
  !POINTERS.has(w) &&
  !BRAND_QUANTIFIERS.has(w) &&
  !COLOR.test(w) &&
  !COLOR_MOD.test(w);

/** "jersey" and "jersey", "cleat" and "cleats" — the one item named again after the brand. */
const sameNoun = (a: string | undefined, b: string | undefined): boolean =>
  !!a && !!b && (a === b || a === `${b}s` || b === `${a}s`);

/** Words a K33 brand can never be: a garment, a worn thing, a person, a vague or meta noun, a head (R-18 (a)). */
const NOT_A_BRAND: ReadonlySet<string> = new Set([
  ...GARMENT_NOUNS,
  ...KNOWN_BAD_NOUNS,
  "be",
  "same",
  "different",
  "new",
  "other",
  "another",
  "something",
  "anything",
]);
function isUnlistedBrand(w: string | undefined, ownHead: string | undefined): w is string {
  return (
    isDroppable(w) &&
    /^[a-z][a-z0-9'-]*$/.test(w) &&
    !isDescriptor(w) &&
    !COLOR_MOD.test(w) &&
    !BRAND_HEADS.has(w) &&
    !META_NOUNS.has(w) &&
    !VAGUE_NOUNS.has(w) &&
    !NOT_A_BRAND.has(w) &&
    !sameNoun(w, ownHead) &&
    !namesWornItem(w) &&
    !namesPerson(w)
  );
}

/** Her own spelling of a word the tokens lowercased — "Lululemon", not "lululemon" — for the fence. */
function verbatimWord(text: string, word: string): string {
  const m = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").exec(text);
  return m ? m[0] : word;
}

/**
 * One item: an optional determiner, then one to three words. A brand may LEAD it — "my nike
 * jersey", the brand it is now — and is kept in the target, which names WHICH jersey, but never in
 * the value. Anywhere else a brand ends the item, which is how "make my socks nike" finds its brand.
 */
function brandItemAt(
  t: string[],
  i: number,
): { target: string; thing: string; next: number } | null {
  if (DETERMINERS.includes(t[i])) i++;
  const words: string[] = [];
  const now = brandAt(t, i);
  if (now) {
    words.push(...t.slice(i, now.next));
    i = now.next;
  }
  const start = words.length;
  while (isItemWord(t[i]) && !brandAt(t, i)) {
    words.push(t[i]);
    i++;
  }
  // Declined, never truncated — the same bound every target has.
  if (words.length > MAX_TARGET_WORDS) return null;
  const thing = words.slice(start);
  const head = thing.at(-1);
  if (
    !head ||
    VAGUE_NOUNS.has(head) ||
    META_NOUNS.has(head) ||
    OBJECT_PRONOUNS.has(head)
  ) {
    return null;
  }
  // ─── AND A PLACE AFTER THE ITEM IS WHERE IT IS, NOT PART OF IT (deep sweep E2) ────────────────
  //
  // "make the logo ON MY JERSEY adidas" bypassed this rule entirely and reached the interpreter, which
  // proposed an ADD of "your words" and tripped C3's product-referent gate. The mark is the item; the
  // garment is only where it sits. Exactly the reading V4 gave rule 1 ("remove the logo FROM my sleeve"
  // is the logo, not the sleeve) and rule 5, and rule 4c never got it.
  //
  // ⚠️ CONSUMED AND DROPPED, NOT MADE A TARGET. Detection is handed "logo" and finds the logo; adding
  // "jersey" would ask it to change the garment too, which is the mangle V4 closed. Her words keep the
  // place — nothing here rewrites her sentence — and only the TARGET is narrowed.
  //
  // `LOCATION_PREPS` is V4's own closed list, so the two readings cannot drift apart. Bounded by
  // `MAX_TARGET_WORDS` like every other phrase, and declined rather than truncated.
  let next = i;
  if (LOCATION_PREPS.has(t[next])) {
    let j = next + 1;
    if (DETERMINERS.includes(t[j])) j++;
    const place: string[] = [];
    while (place.length < MAX_TARGET_WORDS && isItemWord(t[j]) && !brandAt(t, j)) {
      place.push(t[j]);
      j++;
    }
    // Only when it actually read a place. "make the logo on adidas" names no garment and is left alone.
    if (place.length) next = j;
  }
  return { target: words.join(" "), thing: thing.join(" "), next };
}

/**
 * "change my uniform, socks, and shoes all to be adidas" → one REPLACE_OBJECT step per item, or null.
 *
 * ─── THE SHAPE ─────────────────────────────────────────────────────────────────────────────────
 *
 *   [please] <verb> [all|both] <item> [, <item>]… [and <item>] [all|both] <to|into|for> [be]
 *   [a|an] [descriptors] <brand> [descriptors] [one|ones|kit|<the one item's own noun>]
 *
 * `make` takes no link word. The verb must LEAD, like rule 4½'s. Nothing may be left over.
 *
 * Descriptors (2026-09-10) are the closed list `isDescriptor` reads — colours, their modifiers,
 * colour compounds, five style words — at most three, and they ride into the value verbatim:
 * "make my jersey a blue adidas kit" → "blue adidas jersey".
 *
 * ─── THE DEGRADE, WITH DISCLOSURE (B.1c) ───────────────────────────────────────────────────────
 *
 * Any other plain word in the value — a model name, a word it cannot read — is DROPPED: "swap the
 * cleats for Nike Mercurials" → "nike cleats", `dropped: ["mercurials"]`; "a weird glitchy adidas
 * kit" → "adidas jersey", `dropped: ["weird", "glitchy"]`. The value never carries a dropped word, so
 * the compiled instruction cannot; the preview discloses it before she pays (nativeEdit.ts,
 * `droppedWordsNote`), and a degraded change runs NATIVE only (nativeIntent.ts) because only the
 * native compile honours the drop. Only with a brand in the VALUE: no brand, and it asks.
 *
 * ⚠️ AND IT IS KNOWN TO DROP A DIFFERENT THING, NOT ONLY A MODEL: "my jersey to an adidas hoodie"
 * drops "hoodie" and makes an adidas jersey. Telling a model from a product noun needs a vocabulary
 * this module does not have (garmentVocab.ts is the segmenter's nine words) — recorded as Adi's call,
 * and the disclosure names the word either way.
 *
 * ─── ONE STEP PER ITEM, BECAUSE THE FREEZE GIVES A STEP ONE VALUE ──────────────────────────────
 *
 * The native freeze writes a step's single `value` onto every target in it (studio/nativeIntent.ts),
 * so one step over [uniform, socks, shoes] could only say "adidas uniform" for all three. Each item
 * is its own step and names its own replacement — "adidas socks" for the socks — and the native
 * compiler's existing REPLACE clause says it back: "replace the socks with adidas socks".
 *
 * ─── ALL OF IT OR NONE OF IT ───────────────────────────────────────────────────────────────────
 *
 * Its own list reader, and not `extractTargets`: that one anchors on determiners, so "my uniform,
 * socks, and shoes" yields ["uniform"] and the socks and shoes silently vanish. Here every token is
 * read or the sentence declines — an item that does not parse, a colour INSIDE an item ("my red
 * socks": which socks, or which colour?), a negation, a second brand, a fourth dropped word, a fifth
 * item, a second instruction. A decline costs her one sentence, and 4b's copy says which; a partial
 * costs her a kit that is a third adidas, quoted and approved as the whole thing. (A dropped word is
 * not a partial of the ITEMS — every item is still changed — and it is disclosed, never silent.)
 *
 * THE CAP IS HERE, NOT IN `validate`, whose `.slice(0, MAX_STEPS)` would drop a fifth item without
 * a word. MAX_STEPS is the pipeline's own ceiling on calls, so four is the most one sentence can ask.
 *
 * The person guard needs nothing from this parse: every item is a target, and `validate` reads every
 * target. "change my jersey and my arms to adidas" asks — the whole sentence, never just the jersey.
 */
export function parseBrandChange(text: string): EditStep[] | null {
  const t = tokenize(text);
  let i = 0;
  while (t[i] === "please") i++;
  const verb = t[i];
  if (!BRAND_VERBS.has(verb)) return null;
  i++;
  if (BRAND_QUANTIFIERS.has(t[i])) i++;

  const items: { target: string; thing: string }[] = [];
  for (;;) {
    const item = brandItemAt(t, i);
    if (!item) return null;
    items.push(item);
    i = item.next;
    let j = i;
    if (t[j] === ",") j++;
    if (t[j] === "and") j++;
    if (j === i) break;
    i = j;
  }
  if (items.length > MAX_STEPS) return null;

  if (BRAND_QUANTIFIERS.has(t[i])) i++;
  if (verb !== "make") {
    if (!BRAND_LINKS.has(t[i])) return null;
    i++;
    if (t[i] === "be") i++;
  }
  if (t[i] === "a" || t[i] === "an") i++;

  // ─── THE VALUE, WORD BY WORD, TO THE END OF THE SENTENCE ─────────────────────────────────────
  //
  // Each word is one of four things, and anything else asks:
  //   the brand       exactly one — a second ("a nike adidas kit") is not guessed between
  //   a descriptor    kept verbatim, where she put it (B.1b)
  //   the head        "kit", "one(s)" or the one item's own noun, as the LAST word
  //   droppable       a model name or a word it cannot read — dropped from the value and
  //                   disclosed on the preview (B.1c); never compiled into the instruction
  const ownHead =
    items.length === 1 ? items[0].thing.split(" ").at(-1) : undefined;
  const ends = (j: number) =>
    t.slice(j).every((w) => PUNCTUATION.test(w) || w === "please");
  const kept: string[] = [];
  // K33 (PR 19): a brand the rules do not list, in her words — fenced verbatim at compile, never refused.
  let unlisted: string | null = null;
  const dropped: string[] = [];
  let brand: string | null = null;
  let descriptors = 0;
  while (!ends(i)) {
    const b = brandAt(t, i);
    if (b) {
      if (brand) return null;
      brand = b.brand;
      kept.push(b.brand);
      i = b.next;
      continue;
    }
    // E1–E3 (PR 19, STUDIO_IMAGE_OPS): "make the uniform white AND adidas" — "and" also joins her colour to the
    // BRAND, and reads as "white adidas uniform". Dropped, not kept: "and" is a joiner, not a word of the kit.
    if (
      imageOpsEnabled() &&
      !brand &&
      t[i] === "and" &&
      isDescriptor(kept.at(-1)) &&
      brandAt(t, i + 1)
    ) {
      i++;
      continue;
    }
    // "all" and "and" join two descriptors — "all black", "black and white" — and nothing else.
    const joiner =
      (t[i] === "all" || (t[i] === "and" && isDescriptor(kept.at(-1)))) &&
      isDescriptor(t[i + 1]);
    if (isDescriptor(t[i]) || joiner) {
      kept.push(t[i]);
      descriptors++;
      i++;
      continue;
    }
    if (
      brand &&
      ends(i + 1) &&
      (BRAND_HEADS.has(t[i]) || sameNoun(t[i], ownHead))
    ) {
      i++;
      continue;
    }
    // K33 (PR 19, STUDIO_IMAGE_OPS; ADI K33 ruling, R-18 (a)): a swap to a brand the rules do not list routes, and
    // the model may invent that brand's look — never "can't be read as a change". One word, after a link verb
    // ("swap my jersey TO lululemon"; `make` is excluded, where an adjective would read as a brand), and not a word
    // any vocabulary names as something else. The residual is accepted by ruling: "to hoodie" reads as a brand.
    if (
      imageOpsEnabled() &&
      !brand &&
      verb !== "make" &&
      isUnlistedBrand(t[i], ownHead)
    ) {
      brand = t[i];
      unlisted = t[i];
      kept.push(t[i]);
      i++;
      continue;
    }
    if (!isDroppable(t[i])) return null;
    dropped.push(t[i]);
    i++;
  }
  // No brand in the VALUE and it is not a brand change — whatever else it says asks, all or
  // nothing. The degrade is for a brand she named, never a pass-through for words it cannot read.
  if (!brand) return null;
  // Declined, never truncated: a value cut short is a different kit from the one she described.
  if (descriptors > MAX_DESCRIPTOR_WORDS) return null;
  if (dropped.length > MAX_DROPPED_WORDS) return null;

  return items.map(({ target, thing }) => ({
    op: "REPLACE_OBJECT" as const,
    targets: [target],
    // Her descriptors and the brand verbatim and in her order, then the ITEM — "blue adidas
    // jersey". What it could not read is NOT here; it rides beside the value as `dropped`, for the
    // preview to disclose, and never reaches the compiled instruction.
    value: [...kept, thing].join(" "),
    scope: "REGION" as const,
    ...(dropped.length ? { dropped: [...dropped] } : {}),
    ...(unlisted ? { brand: verbatimWord(text, unlisted) } : {}),
  }));
}

// ─── Rule 3½'s parse: <verb> <thing> <to|with|for|into> <this|these|those|that> [what] ──────────

/**
 * The verbs a replacement is said with: rule 4c's five, and "replace". `make` takes no link word, as it
 * does in 4c — "make my earrings these gold hoops".
 */
const REPLACE_VERBS: ReadonlySet<string> = new Set([...BRAND_VERBS, "replace"]);

/** What joins the thing she has to the thing in her photo: "to these", "with this", "for those", "into that". */
const REPLACE_LINKS: ReadonlySet<string> = new Set([
  "to",
  "with",
  "for",
  "into",
]);

/** The words that point at something she can see and the sentence cannot say: the photo she attached. */
export const POINTERS: ReadonlySet<string> = new Set([
  "this",
  "these",
  "that",
  "those",
]);

/**
 * Ordinals that name an ATTACHED photo — "the gold hoops in the SECOND image". Not "first": in her
 * sentences that is the frame (Mia's "change my earrings in the first picture to these gold hoops").
 */
const ATTACHED_ORDINALS: ReadonlySet<string> = new Set([
  "second",
  "third",
  "other",
  "last",
  "attached",
]);

/** Nouns that can only name an attachment, so they need no ordinal — "the one from the attachment". */
const ATTACHMENT_NOUNS: ReadonlySet<string> = new Set([
  "attachment",
  "reference",
  "ref",
  "upload",
]);

/** A head that names the thing again by pronoun — "this ONE", "these nike ONES". Her target's noun stands in. */
const ONE_HEADS: ReadonlySet<string> = new Set(["one", "ones"]);

/**
 * Heads that name a property or the picture, not a thing: "these colours", "this look", "this photo".
 * Taking a colour or a look from her photo is a different request from putting its thing in the frame.
 */
const PROPERTY_HEADS: ReadonlySet<string> = new Set([
  ...META_NOUNS,
  "colors",
  "colours",
  "looks",
  "styles",
  "tones",
  "vibes",
]);

/** The setting, which rule 2 reads. Never a thing to replace from her photo here. */
const SETTING_HEADS: ReadonlySet<string> = new Set([
  "background",
  "backdrop",
  "setting",
  "scene",
]);

/** Rule 3½'s reading: the thing she has, and what it becomes — the thing in the photo she attached. */
export interface PointedReplacement {
  /** What she has, in the frame — "earrings". A target: what detection finds and the guard reads. */
  target: string;
  /**
   * What it becomes, in her words — "gold hoops". When she only pointed ("this one", "these") it is her
   * target's own noun, so the compiled clause always names a thing a model can find in her photo:
   * "replace the soccer ball with the soccer ball from Image 2".
   */
  thing: string;
}

/**
 * The thing she has, as one phrase: a determiner, then one to three words, as `extractTargets` reads
 * them (a colour ends it). A list of two is not this — which of them the photo shows is not guessed.
 */
function pointedTargetAt(
  t: string[],
  i: number,
): { words: string[]; next: number } | null {
  if (!DETERMINERS.includes(t[i])) return null;
  i++;
  const words: string[] = [];
  while (
    isWord(t[i]) &&
    !PHRASE_STOP.has(t[i]) &&
    !DETERMINERS.includes(t[i]) &&
    !POINTERS.has(t[i]) &&
    !COLOR.test(t[i]) &&
    !COLOR_MOD.test(t[i])
  ) {
    words.push(t[i]);
    i++;
    if (words.length > MAX_TARGET_WORDS) return null;
  }
  const head = words.at(-1);
  if (
    !head ||
    PROPERTY_HEADS.has(head) ||
    SETTING_HEADS.has(head) ||
    VAGUE_NOUNS.has(head) ||
    OBJECT_PRONOUNS.has(head)
  ) {
    return null;
  }
  return { words, next: i };
}

/**
 * Where on her a worn thing is — "the earrings IN MY EARS", "the chain AROUND MY NECK" — read as its
 * location and consumed, the target keeping only the thing (guard scope's decision 2, which
 * `extractTargets` applies to every other rule; replace with reference, R.4). Null when what follows
 * is not that: the thing must be on WORN_ITEMS, a closed list, and the place must name her — "the
 * tattoo on my arm" is her arm, and stays exactly as it was.
 *
 * "around" and "through" do not END a phrase (PHRASE_STOP has neither), so "the chain around my neck"
 * reaches here as the target "chain around"; the location reading gives the target its own name back.
 */
function wornLocationAt(
  t: string[],
  target: { words: string[]; next: number },
): { words: string[]; next: number } | null {
  let words = target.words;
  let i = target.next;
  if (LOCATION_PREPS.has(t[i])) {
    i++;
  } else if (words.length > 1 && LOCATION_PREPS.has(words[words.length - 1])) {
    words = words.slice(0, -1);
  } else {
    return null;
  }
  if (!namesWornItem(words.join(" "))) return null;
  if (!DETERMINERS.includes(t[i])) return null;
  let j = i + 1;
  const place: string[] = [];
  while (
    isWord(t[j]) &&
    !PHRASE_STOP.has(t[j]) &&
    !DETERMINERS.includes(t[j]) &&
    !POINTERS.has(t[j])
  ) {
    place.push(t[j]);
    j++;
    if (place.length > MAX_TARGET_WORDS) return null;
  }
  if (!place.length || !namesPerson(place.join(" "))) return null;
  return { words, next: j };
}

/**
 * The start of a pointed replacement — her verb leading, the thing she has, where it is on her or in
 * the frame, and the link — with the index of what comes after. Null when her sentence does not start
 * that way.
 */
function pointerPrefixAt(
  t: string[],
): { verb: string; target: string[]; next: number } | null {
  let i = 0;
  while (t[i] === "please") i++;
  const verb = t[i];
  if (!REPLACE_VERBS.has(verb)) return null;
  let target = pointedTargetAt(t, i + 1);
  if (!target) return null;
  // "in my ears" — WHERE on her the worn thing is (R.4): its location, never a second target.
  target = wornLocationAt(t, target) ?? target;
  i = target.next;
  // "in the first picture" — WHERE the thing is. That is the frame, which the request already is.
  if (t[i] === "in" || t[i] === "on") i = frameRefAt(t, i) ?? i;
  if (REPLACE_LINKS.has(t[i])) i++;
  else if (verb !== "make") return null;
  return { verb, target: target.words, next: i };
}

/** "in the second image", "from the attachment" at `i` — her attached photo, named — or null. */
function attachedPhotoAt(t: string[], i: number): number | null {
  if (t[i] !== "in" && t[i] !== "from") return null;
  let j = i + 1;
  if (ADD_DETERMINERS.has(t[j])) j++;
  if (ATTACHMENT_NOUNS.has(t[j])) return j + 1;
  if (!ATTACHED_ORDINALS.has(t[j])) return null;
  j++;
  return SOURCE_NOUNS.has(t[j]) ? j + 1 : null;
}

/**
 * A list of things she has, then a pointer — "change my socks and shoes to these nike ones". One photo,
 * two things; which it shows is not guessed. Read from right after the list's first phrase.
 */
function listThenPointerAt(t: string[], i: number): boolean {
  if (t[i] !== "," && t[i] !== "and") return false;
  let j = i;
  while (
    t[j] === "," ||
    t[j] === "and" ||
    DETERMINERS.includes(t[j]) ||
    (isWord(t[j]) && !PHRASE_STOP.has(t[j]) && !POINTERS.has(t[j]))
  ) {
    j++;
  }
  return REPLACE_LINKS.has(t[j]) && POINTERS.has(t[j + 1]);
}

/** Her target, as a noun: a leading brand and leading colours dropped — "nike cleats" → "cleats". */
function ownNoun(words: string[]): string[] {
  let k = brandAt(words, 0)?.next ?? 0;
  while (k < words.length - 1 && isDescriptor(words[k])) k++;
  return words.slice(k);
}

/**
 * Her sentence → the replacement she points at, or "unread" when it points at her photo in a way this
 * cannot read, or null when it does not point at all.
 *
 * ─── THE SHAPES (the deictic patterns, verbatim, for the interpreter to inherit) ────────────────
 *
 *   [please] <verb> <the thing> [in the first picture] <link> <this|these|those|that> [<what>]
 *            [from|in the second image]
 *   [please] <verb> <the thing> [in the first picture] <link> the <what> <in|from> the
 *            <second|third|other|last|attached> <image|photo|picture|pic|one>
 *            (or "the attachment", "the reference", "the upload")
 *
 *   verbs  change, turn, switch, swap, make, replace — `make` needs no link ("make my X these Y")
 *   links  to, with, for, into
 *   what   0-3 words, her words verbatim: colours and a brand ride along ("these nike ones")
 *
 * "this one" / "these ones" / nothing at all → her target's noun ("the soccer ball").
 *
 * ─── IT ASKS RATHER THAN DROP HER POINTER ────────────────────────────────────────────────────────
 *
 * Once the sentence has pointed at her photo, anything this cannot read is "unread", and the fast path
 * asks: words left over, more than three words of what, a property ("these colours"), a design or brand
 * mark ("this logo" — putting a mark on is APPLY_DESIGN's), or a list of things she has ("my socks and
 * shoes to these"). Every one of those routed or asked before this rule; none of them may now route
 * with her pointer dropped. What does NOT point is not this rule's, and reaches the rules below exactly
 * as it always has: "change my earrings to gold hoops" is a description, and still a recolour.
 */
function readPointedReplacement(
  text: string,
): PointedReplacement | "unread" | null {
  const t = tokenize(text);
  const prefix = pointerPrefixAt(t);
  if (!prefix) {
    // "change my socks and shoes to these…" — the list stopped the prefix, and the pointer is still hers.
    let v = 0;
    while (t[v] === "please") v++;
    const first = REPLACE_VERBS.has(t[v]) ? pointedTargetAt(t, v + 1) : null;
    return first && listThenPointerAt(t, first.next) ? "unread" : null;
  }
  let i = prefix.next;
  let pointed = false;
  if (POINTERS.has(t[i])) {
    pointed = true;
    i++;
  } else if (ADD_DETERMINERS.has(t[i])) {
    i++;
  } else {
    return null;
  }
  const what: string[] = [];
  while (
    isWord(t[i]) &&
    !PHRASE_STOP.has(t[i]) &&
    !ADD_DETERMINERS.has(t[i]) &&
    !OBJECT_PRONOUNS.has(t[i])
  ) {
    what.push(t[i]);
    i++;
  }
  const photo = attachedPhotoAt(t, i);
  // "change my earrings to the gold hoops" names no photo: it is a description, and not this rule's.
  if (!pointed && photo === null) return null;
  if (photo !== null) i = photo;
  while (i < t.length && (PUNCTUATION.test(t[i]) || t[i] === "please")) i++;

  // From here the sentence points at her photo, so what this cannot read asks.
  if (i < t.length || what.length > MAX_TARGET_WORDS) return "unread";
  const head = what.at(-1);
  if (
    head &&
    (PROPERTY_HEADS.has(head) ||
      (VAGUE_NOUNS.has(head) && !ONE_HEADS.has(head)))
  ) {
    return "unread";
  }
  if (DESIGN.test(what.join(" ")) || DESIGN.test(prefix.target.join(" "))) {
    return "unread";
  }
  const own = ownNoun(prefix.target);
  const thing = !head
    ? own
    : ONE_HEADS.has(head)
      ? [...what.slice(0, -1), ...own]
      : what;
  return { target: prefix.target.join(" "), thing: thing.join(" ") };
}

/**
 * Rule 3½'s reading, for callers that want the parse alone — null for "unread" and for a sentence that
 * does not point (the fast path asks on the first and reads the second as it always has).
 */
export function parseReplaceWithReference(
  text: string,
): PointedReplacement | null {
  const read = readPointedReplacement(text);
  return read === "unread" ? null : read;
}

// ─── Rule ⅛'s shape: a headline, and nothing looser (the text op, PR T) ─────────────────────────

/**
 * THE ONE SENTENCE A HEADLINE IS READ FROM: `add the headline "<her words>" across the top`.
 *
 * Case aside, the frame is fixed — add, the headline, across the top — with nothing before it and nothing
 * after it: no "please", no "put", no "the text", no full stop. Her words go in double quotes, straight or
 * curly (a phone types curly ones). One placement, the top banner: the one text-only shape that was
 * measured (q6-t1, studio/compile/templates.ts).
 *
 * ⚠️ STRICT ON PURPOSE. #433's natural sentences — "add a banner that says GET LOUD", "add the text GET
 * LOUD", q6-t1's own sentence — keep asking exactly as they do, and none of their pins flip. They are
 * the interpreter's to read, and it renders exactly this shape (plan v2, §5), so her typed headline and
 * the interpreter's face one reader, and one set of bounds.
 *
 * Read off her RAW sentence, never the tokens: the tokenizer drops quotes and digits, and a headline
 * needs both.
 */
const HEADLINE =
  /^\s*add\s+the\s+headline\s+["“]([^"“”]*)["”]\s+across\s+the\s+top\s*$/i;

/**
 * Her headline's words as the banner will write them — or null when her sentence is not rule ⅛'s shape.
 *
 * Uppercased, because the banner is "bold white capital letters" and the words she quoted are what it
 * reads; a curly apostrophe made straight; a run of spaces made one. Nothing else about them changes.
 */
export function readHeadline(text: string): string | null {
  const quoted = HEADLINE.exec(text)?.[1];
  if (quoted === undefined) return null;
  const words = quoted
    .replace(/’/g, "'")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .toUpperCase();
  return words || null;
}

/** Which bound a headline's words break (N8) — the first, in the order `headlineBound` checks them. */
export type HeadlineBound =
  | "words"
  | "length"
  | "characters"
  | "brand"
  | "tagline";

/** Short display text: the reach of q6-t1's measurement (two words; q6-t2's three). Long copy is unmeasured. */
export const MAX_HEADLINE_WORDS = 4;
export const MAX_HEADLINE_CHARACTERS = 24;
/** Capitals, digits, spaces and the plainest punctuation. Nothing a model could read as markup. */
const HEADLINE_CHARACTERS = /^[A-Z0-9 !?&'.-]+$/;

/**
 * TAGLINES NO HEADLINE MAY CARRY (N8; Mia's M1: "no trademarked taglines until she clears them"). A closed
 * starter list, not a trademark search: the taglines of the brands BRANDS names, then the most familiar
 * outside sport — the "i'm lovin' it" class. Matched as whole words anywhere in her headline, apostrophes
 * and punctuation dropped (`namesATagline`). Hand-pinned in classify.test.ts; a deletion there is red.
 *
 * ⚠️ A GUARD ON WORDS, NOT ON MEANING. A reworded slogan ("nothing is impossible") is not on it and
 * routes. Widening it is a list edit, reviewed like any other.
 */
export const HEADLINE_TAGLINES: readonly string[] = [
  // The brands on BRANDS.
  "just do it", // Nike
  // Nike's others, since R1: interpret/2 suggested "FIND YOUR GREATNESS" for a nike ad (the interpreter, I.4).
  "find your greatness", // Nike
  "believe in something", // Nike
  "dream crazy", // Nike
  "you cant stop us", // Nike
  "impossible is nothing", // adidas
  "forever faster", // Puma
  "only see great", // Puma
  "i will what i want", // Under Armour
  "rule yourself", // Under Armour
  "protect this house", // Under Armour
  "the only way is through", // Under Armour
  "fearlessly independent", // New Balance
  "be more human", // Reebok
  "i am what i am", // Reebok
  "sound mind sound body", // ASICS
  "reach beyond", // Mizuno
  "better never stops", // Castore
  // The most familiar outside sport.
  "im lovin it", // McDonald's
  "im loving it", // McDonald's
  "think different", // Apple
  "because youre worth it", // L'Oréal
  "open happiness", // Coca-Cola
  "taste the feeling", // Coca-Cola
  "gives you wings", // Red Bull
  "have it your way", // Burger King
  "finger lickin good", // KFC
  "finger licking good", // KFC
  "eat fresh", // Subway
  "is it in you", // Gatorade
  "be like mike", // Gatorade
  "obey your thirst", // Sprite
  "got milk", // the milk campaign
  "breakfast of champions", // Wheaties
];

/** Words as the deny-list is compared in: lowercase, apostrophes dropped, other punctuation a space. */
const taglineWords = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);

/** Does her headline carry a tagline from the deny-list — its words, in order, anywhere in hers? */
function namesATagline(words: string): boolean {
  const w = taglineWords(words);
  return HEADLINE_TAGLINES.some((line) => {
    const t = taglineWords(line);
    for (let i = 0; i + t.length <= w.length; i++) {
      if (t.every((word, k) => w[i + k] === word)) return true;
    }
    return false;
  });
}

/**
 * The bound her headline's words break — or null when they are within every one (N8, PR T, T.2).
 *
 * Enforced HERE, by the rule, so her typed headline and the interpreter's suggested one (plan v2, §3 and
 * C-8) face the same guard: at most four words and 24 characters; capitals, digits and ! ? & ' . - only; no
 * word from BRANDS — a brand's name as display text is a mark, and the brand vocabulary is the check; and
 * no tagline from the deny-list above. A headline that breaks one ASKS (`headline_bounds`), whole.
 */
export function headlineBound(words: string): HeadlineBound | null {
  if (words.split(" ").length > MAX_HEADLINE_WORDS) return "words";
  if (words.length > MAX_HEADLINE_CHARACTERS) return "length";
  if (!HEADLINE_CHARACTERS.test(words)) return "characters";
  if (BRANDS.test(words)) return "brand";
  if (namesATagline(words)) return "tagline";
  return null;
}

// ─── Rule ½'s scan: where one change ends and the next begins (composition PR 1) ───────────────

/** What may join two clauses — the only places a sentence is ever cut (the composition plan). */
const CLAUSE_JOINERS = new Set([",", ".", ";", "and", "then", "also"]);

/**
 * A FULL STOP ENDS A SENTENCE WHATEVER LEADS THE NEXT ONE (wave B, C3a; sweep-4 ledger F-WA1).
 *
 * The joiners above cut only when an operation verb follows, which is right for a comma — ", socks, and
 * shoes" is one list, not three clauses. It is wrong for a full stop. She typed two sentences; the second
 * is a second thing to say however it begins, and `for the cone on the ground make it blue` begins with
 * `for`. Read as one clause, rule 1 claimed every phrase across the stop and REMOVED the cone she asked to
 * have recoloured — measured on main `2dc602e`:
 *
 *   remove the ball in the air. for the cone on the ground make it blue
 *     before   REMOVE_OBJECT [ball, air, cone]
 *     after    RECOLOR [cone, "ground make it"] "blue" + REMOVE_OBJECT [ball, air]
 *
 * ⚠️ THE FULL STOP ONLY — `,` AND `;` KEEP THE VERB TEST. A semicolon joins clauses of one sentence and a
 * comma joins items of one list, so widening to either would cut "change my uniform, socks, and shoes all
 * to be adidas" into three, which is the thing the verb test exists to prevent.
 *
 * ⚠️ AND `!` AND `?` DO NOT CUT EITHER — NOT BY CHOICE HERE, BUT BECAUSE THEY ARE NOT JOINERS. `TOKEN`
 * emits them, but `CLAUSE_JOINERS` has never held them, so the loop below skips them before this is ever
 * consulted: "remove the cone! for the ball on the ground make it blue" reads as one clause, exactly as on
 * main. An earlier draft of this note claimed otherwise and jest caught it. Widening `CLAUSE_JOINERS` also
 * widens the run the loop consumes, which is a second behaviour on every sentence — so it is ledgered
 * (F-WB2) rather than folded in, and the measured corpus for this commit is the full stop's.
 *
 * ⚠️ AND THE CUT ALONE LOSES SENTENCES THE OLD GREED HAPPENED TO SERVE. A second sentence that carries no
 * verb of its own is now a clause no rule reads, and on its own that turned 24 corpus cells from routing to
 * asking — "make the socks blue. thanks" among them. What makes the cut safe is the drop in `compose`
 * below, which is built with it and not after it.
 */
const SENTENCE_STOPS: ReadonlySet<string> = new Set([".", "!", "?"]);

/**
 * Verbs that LEAD a change: the ones the rules already read — rule 4½'s adds, rule 4c's brand verbs,
 * 4a's `give`, rule 2's "drop/set me in" — plus the recolour verbs rule 5 never needed, because it
 * reads colours rather than verbs. A removal is REMOVE itself, read at the token (`operationAt`).
 */
export const OPERATION_VERBS = new Set([
  ...ADD_VERBS,
  ...BRAND_VERBS,
  "give",
  "drop",
  "set",
  "replace",
  "recolor",
  "recolour",
  "color",
  "colour",
  "paint",
  "dye",
]);

/** The verb leading a change at token `i` — every removal verb reads as "remove" — or null. */
function operationAt(t: string[], i: number): string | null {
  // REMOVE, not a restatement of it: "take off" and "get rid of" are more than one token.
  // Six tokens: "take the nike logo off" (V4) is one verb, like "get rid of".
  if (REMOVE.exec(t.slice(i, i + 6).join(" "))?.index === 0) return "remove";
  // ⚠️ THE MOVE VERBS ARE READ HERE AND NOT PUT ON `OPERATION_VERBS`, because that set is a module
  // constant and this is the flag's other half. `clausesOf` is shared by every sentence, so a move verb
  // joining it unconditionally would cut clauses in compounds that have nothing to do with the move op —
  // and the flag-off corpus diff has to be zero rows (studio/config.ts, `moveObjectEnabled`).
  if (moveObjectEnabled() && MOVE_VERBS.has(t[i])) return t[i];
  return OPERATION_VERBS.has(t[i]) ? t[i] : null;
}

/**
 * A TRAILING CLAUSE THAT ASKS FOR NOTHING — the drop the stop boundary needs, as a CLOSED LIST.
 *
 * ─── THE PROBLEM IT ANSWERS ────────────────────────────────────────────────────────────────────
 *
 * Cutting at a full stop makes a clause of every trailing sentence, and most of them are not requests:
 * "thanks", or our own compiled scope line echoed back at us. `compose` asks the whole sentence when any
 * clause is unread, so each of those breaks an edit that routes today — measured on main `2dc602e`, the
 * cut alone moved 24 corpus cells from routing to asking, "make the socks blue. thanks" among them.
 *
 * ─── ⚠️ AND IT HAS TO BE A CLOSED LIST, BECAUSE THE OBVIOUS TEST IS UNSAFE — MEASURED, NOT FEARED ──
 *
 * The first version of this asked the opposite question: does the clause name a change — an operation verb
 * anywhere in it (`operationAt`), or a colour? If not, drop it. It reads as the more general test and it is
 * strictly worse, because it is only ever as good as the verbs the rules already have. Built that way, it
 * silently dropped THE VERY SENTENCE THIS WAVE EXISTS FOR:
 *
 *   remove the ball in the air. for the ball on the ground move it closer to my feet.
 *     → REMOVE_OBJECT [ball, air]                    ← the move, gone, with nothing said
 *
 * `move` is not an operation verb yet, so a clause asking for a move looked exactly like "thanks". A
 * negative test fails toward dropping what it does not recognize; a positive one fails toward asking. Every
 * other choice on this path is made on that asymmetry and so is this one: an unrecognized tail costs her one
 * ask, and an unrecognized REQUEST costs her the thing she asked for — and she pays for the picture either way.
 *
 * ─── WHAT IS ON THE LIST, AND WHY A LEADING WORD IS ENOUGH ─────────────────────────────────────
 *
 * A clause is set aside only when it LEADS with one of these. Nothing she is asking to have changed begins
 * "keep" or "thanks", and every rule here reads a verb at the front of a clause — so the first word is
 * where the difference already lives, and matching further in would start guessing.
 *
 *   keep, leave, preserve, dont/don't/do not   a keep. The ones `readKeep` and `readThingKeep` recognize are
 *                                             already set aside before the rules run (A3b, K2); this catches
 *                                             the rest, our own compiled words among them — "Keep the person
 *                                             exactly as-is", which F-WA4 records the keep vocabulary as
 *                                             deliberately NOT reading.
 *   thanks, thank you, cheers, please, ta      courtesy. The only class of the 24 that is typed English.
 *
 * ⚠️ NOT THE PER-CLAUSE REFUSAL C3b IS FOR. A clause that asks for a change and is refused stays the whole
 * sentence's ask, exactly as composition's d1 has it. Surfacing THAT drop — the `Routed` field, the
 * disclosure line — is the next commit's, and this one must not pre-empt it by dropping something she
 * should be told about.
 */
const ASKS_FOR_NOTHING =
  /^\s*(?:keep|leave|preserve|don['’]?t|do\s+not|thanks?|thank\s+you|cheers|please|ta)\b/i;

/** One clause: her words, cut from her sentence, and the verb that leads it. */
interface Clause {
  text: string;
  verb: string;
}

/**
 * Her sentence → its clauses. One clause when nothing after the first verb leads a second change.
 *
 * ─── A CUT IS A JOINER RUN FOLLOWED BY A VERB, AND NOTHING ELSE ─────────────────────────────────
 *
 * ", and remove the ball" is a second clause; ", socks, and shoes" is one list, because no verb
 * follows the joiner — which is what keeps rule 4c's items ("change my uniform, socks, and shoes all
 * to be adidas") and rule 5's two targets ("make her jersey blue and her socks red") one clause each.
 * The run itself belongs to neither side, so each clause starts at its own verb, which is where
 * rule 4½ and rule 4c need the verb to be.
 *
 * ⚠️ "PLACE IT" / "PUT IT" AFTER AN ADD IS WHERE THE THING GOES, NOT A SECOND THING TO DO. C′'s
 * sentences ("add the soccer ball from the second image, place it between her cleats") keep rule
 * 4½'s continuation (`continuationAt`). ONLY after an add: "remove the ball and put it on the bench"
 * is two changes, and read as one it removes the bench.
 *
 * A clause is her own words, sliced from her sentence by the offsets the tokens were found at, so
 * digits, apostrophes and case survive into whatever reads a clause next.
 */
function clausesOf(text: string): Clause[] {
  const found = [...text.matchAll(TOKEN)];
  const t = found.map((m) => m[0].toLowerCase());
  const at = (i: number) => found[i].index ?? 0;
  const first = t.findIndex((_, i) => operationAt(t, i) !== null);
  if (first < 0) return [{ text, verb: "" }];

  const clauses: Clause[] = [];
  let start = 0;
  let verb = operationAt(t, first) ?? "";
  for (let i = first + 1; i < t.length; i++) {
    if (!CLAUSE_JOINERS.has(t[i])) continue;
    let j = i;
    while (CLAUSE_JOINERS.has(t[j]) || t[j] === "please") j++;
    const next = operationAt(t, j);
    // A stop she typed, with a word after it: her second sentence, whether or not a verb leads it.
    const stopped =
      j < t.length && t.slice(i, j).some((p) => SENTENCE_STOPS.has(p));
    if (!next && !stopped) continue;
    const placesTheAdd =
      ADD_VERBS.has(verb) &&
      (t[j] === "place" || t[j] === "put") &&
      t[j + 1] === "it";
    if (placesTheAdd) continue;
    clauses.push({ text: text.slice(start, at(i)).trim(), verb });
    start = at(j);
    // No verb when the stop is what cut: the clause leads none, and an empty verb is the truth about it.
    // `readClauses`'s all-removals short-circuit reads this, and a clause with no verb is correctly not one.
    verb = next ?? "";
    i = j;
  }
  clauses.push({ text: text.slice(start).trim(), verb });
  return clauses;
}

/** Her sentence → its clauses, in her words and her order. The split composition dispatches over. */
export function splitClauses(text: string): string[] {
  return clausesOf(text).map((c) => c.text);
}

/** One clause, read on its own: her words, and what the rules made of them — null when no rule could. */
interface ReadClause {
  text: string;
  read: Classification | null;
}

/**
 * The clauses of a sentence that asks for DIFFERENT changes, each classified on its own — or null
 * when it asks for one change, however many times she says it.
 *
 * ─── ONE CHANGE, SAID TWICE, STILL ROUTES — BY THE RULE THAT ALREADY READS ALL OF IT ───────────
 *
 * Each clause is classified on its own, by the rules below — no second copy of them. If every clause
 * is the same operation AND that operation's rule reads every clause of the whole sentence, the
 * sentence goes on to the rules exactly as it did before composition existed:
 *
 *   all removals   rule 1 claims every noun in the sentence, which is right when every clause
 *                  removes. Read by VERB, so a clause that points back is kept too — "remove the ball
 *                  and then delete it", whose second clause alone has no target.
 *   all recolours  rule 5 claims every region, and the freeze pairs each with its own colour from
 *                  detection — B-c2 compiled "make the jersey blue, and make the socks red".
 *
 * ⚠️ AND THAT FALL-THROUGH STAYS NOW THAT COMPOSITION ROUTES (decision 2a). Dispatching "make her
 * jersey blue and make her socks red" would turn B-c2's one RECOLOR step into two — a change to a
 * sentence that routes correctly, which composition's proof obligation forbids.
 *
 * ⚠️ ASSUMES A SOURCE PHOTO. Only reached past rule 0, where there is one; with none, rule 0 has
 * already claimed the whole sentence as GENERATE, which never composes.
 */
/**
 * A BARE `them` IN A LATER CLAUSE IS THE THINGS SHE JUST NAMED (wave B, F-WB6).
 *
 * ─── THE SENTENCE THIS IS FOR, AND WHAT WAS ALREADY TRUE ────────────────────────────────────────
 *
 * "make my uniform, shoes and socks adidas. make them the color blue too." asked `compound_partial` on
 * pre-wave-A `29b2fc8`, on main `7d12dbc` and on this branch before this commit — byte-identical, so
 * it is a missing READING and never a regression (ledger F-WB6, measured on three trees). The brand
 * compound alone routes, and the same sentence with a NOUN second clause routes; only the pronoun was
 * unread. The full stop is not involved either: `CLAUSE_JOINERS` has held "." since before wave A and
 * cuts whenever an operation verb follows, so the `and`-joined form asked identically.
 *
 * ─── A TEXT REWRITE, BEFORE CLASSIFICATION, AND NOT A NEW TARGET KIND ───────────────────────────
 *
 * `them` is replaced in her clause's WORDS and the clause is read again. So rule 5, `validate` and the
 * step shape never learn about pronouns, and nothing downstream can receive a target no rule resolved.
 * `readAs` is the precedent: rewriting what a later stage sees is how this file already hands detection
 * and the compile tier a sentence they can read.
 *
 * ⚠️ THE DETERMINER IS REPEATED, AND IT IS LOAD-BEARING. Rule 5 reads a multi-target list only when
 * every target carries its own — measured:
 *
 *   "make the uniform, shoes and socks blue"          → RECOLOR[uniform]              ← two targets LOST
 *   "make the uniform, the shoes and the socks blue"  → RECOLOR[uniform|shoes|socks]
 *
 * A plain join would have silently dropped two of her three garments, which is composition's decision
 * d1 reached by accident. RV-w6b is the check that keeps this honest.
 *
 * ⚠️ AND THE ANTECEDENT'S OPERATION IS A CLOSED LIST, because one of them names HER. Measured:
 * `CHANGE_BACKGROUND`'s step target is `person` ("change the background to a stadium" →
 * `CHANGE_BACKGROUND[person]=stadium`), so a background antecedent would turn "make them blue" into a
 * recolour OF THE ATHLETE. `GLOBAL_STYLE` carries no target at all. Only the operations whose target is
 * a thing IN the frame that she is changing may be an antecedent; everything else resolves nothing and
 * the sentence asks exactly as it does today.
 *
 * ⚠️ `it` IS NOT ON THE TABLE, and that is Adi's scope call rather than an omission. `it` already means
 * the photograph: 75 corpus cells route "make it warmer / moodier / golden hour" as `GLOBAL_STYLE`.
 * Reading `it` as "the things she just named" would put all 75 behind a colour-vs-look discriminator,
 * which is its own decision. So "make my jersey adidas. make it blue." still asks, deliberately.
 *
 * `these` and `those` are left alone too: in this corpus they are DETERMINERS with their own family
 * ("make these cleats pink adidas" → `brand_change`), not bare pronouns.
 */
const PLURAL_ANTECEDENT_PRONOUN = "them";

/**
 * AND `it`, UNDER ONE EXTRA CONDITION — Adi's call, 2026-09-17 (deep sweep E4), overriding F-WB6's fence.
 *
 * `it` was held back because it already means THE PHOTOGRAPH: 75 corpus cells route "make it warmer /
 * moodier / golden hour" as `GLOBAL_STYLE`. The condition that makes it safe is the VALUE, not the
 * pronoun — a colour is never a look — so an `it` clause is resolved only when the re-read comes back a
 * RECOLOUR, and a look-valued clause is left exactly as it was.
 *
 * ⚠️ AND THE 75 ARE NEVER EVEN REACHED, which is the stronger half of the argument. The resolver only
 * fires on an UNREAD clause, and "make it warmer" READS on its own — so in "make my socks blue. make it
 * warmer." clause 2 is already a look and the resolver never sees it. The RECOLOUR test is the belt
 * beside that brace: it is what keeps a future look word out if one ever failed to read.
 */
const SINGULAR_ANTECEDENT_PRONOUN = "it";

/**
 * The operations whose target names a thing in the frame she is changing. See the note above.
 *
 * ⚠️ `ADD_OBJECT` IS ONE OF THEM SINCE WAVE D (card 1's sibling, card 3). "add a headband and make it
 * red" asked `compound_partial`: the second clause does not read alone — "make it red" is not a
 * sentence the rules can answer — so the resolver DID fire, looked back for an antecedent, and found
 * none, because the only earlier clause was an add. The thing she just asked for is as much a thing
 * in the frame as one she is recolouring; it is simply a thing the edit is about to put there.
 *
 * The fences are unchanged and both still hold: `CHANGE_BACKGROUND` is still absent, so its `person`
 * target can never become a recolour of her (RV-w6c), and E4's rule that an `it` clause must re-read
 * wholly as a RECOLOUR still keeps the 75 GLOBAL_STYLE cells out — those read on their own and the
 * resolver never sees them.
 */
const ANTECEDENT_OPS: ReadonlySet<EditOperation> = new Set([
  "RECOLOR",
  "REPLACE_OBJECT",
  "APPLY_DESIGN",
  "ADD_OBJECT",
]);

/** "the socks", "the socks and the shoes", "the uniform, the shoes and the socks". */
function determinedList(targets: readonly string[]): string {
  const each = targets.map((t) => `the ${t}`);
  if (each.length === 1) return each[0];
  return `${each.slice(0, -1).join(", ")} and ${each[each.length - 1]}`;
}

/**
 * Every clause read so far, resolved: an unread clause whose words contain a bare `them` is re-read with
 * that word replaced by the nearest EARLIER clause's targets. Returns the clauses unchanged when nothing
 * resolves — including when the re-read still does not read, which is the fail-closed half.
 */
function resolvePronounClauses(read: ReadClause[]): ReadClause[] {
  return read.map((clause, i) => {
    if (clause.read) return clause;
    const words: string[] = clause.text.toLowerCase().match(TOKEN) ?? [];
    const pronoun = words.includes(PLURAL_ANTECEDENT_PRONOUN)
      ? PLURAL_ANTECEDENT_PRONOUN
      : words.includes(SINGULAR_ANTECEDENT_PRONOUN)
        ? SINGULAR_ANTECEDENT_PRONOUN
        : null;
    if (!pronoun) return clause;
    // The nearest earlier clause that named things — never a later one, and never this one.
    let targets: string[] = [];
    for (let j = i - 1; j >= 0 && !targets.length; j--) {
      targets = [
        ...new Set(
          (read[j].read?.steps ?? [])
            .filter((s) => ANTECEDENT_OPS.has(s.op))
            .flatMap((s) => s.targets),
        ),
      ];
    }
    if (!targets.length) return clause;
    const rewritten = clause.text.replace(
      new RegExp(`\\b${pronoun}\\b`, "i"),
      determinedList(targets),
    );
    const reread = classifyFast(rewritten, true);
    if (!reread) return clause;
    // `it` ONLY WHERE THE VALUE IS A COLOUR — see SINGULAR_ANTECEDENT_PRONOUN. A look keeps meaning the
    // photograph, so a clause that re-reads as anything but a recolour is handed back untouched.
    //
    // ⚠️ AND IT IS DEFENCE IN DEPTH WITH NO LIVE CASE TODAY — measured, not assumed, so nobody reads it
    // as load-bearing. A look word reaches this line by neither route: "make it vintage" READS on its
    // own as a GLOBAL_STYLE, so the resolver never fires on it, and "make the jersey vintage" — the
    // substitution — does not read at all, so the re-read is null and the clause is returned above.
    // There is currently no sentence for which this test is what stops the resolution. It stays because
    // it is the stated fence (Adi's condition was the VALUE) and because a future look word that fails
    // to read alone would arrive here; RV-e4c is recorded as UNEXERCISABLE rather than passing.
    if (
      pronoun === SINGULAR_ANTECEDENT_PRONOUN &&
      !reread.steps.every((step) => step.op === "RECOLOR")
    ) {
      return clause;
    }
    // Her words stay on the clause; only what the rules READ from it changes. The card and any log line
    // quote her, not our substitution.
    //
    // ⚠️ AND THE STEPS ARE MARKED. The freeze re-derives a recolour's colour from detection's LABEL, and
    // for a pronoun clause no label can carry it — she said the colour once, about things named earlier,
    // so detection was never asked for a colour on any of them. `fromPronoun` is what lets the freeze
    // fall back to her own word, and it is the difference between this routing and this WORKING.
    return {
      ...clause,
      read: {
        ...reread,
        steps: reread.steps.map((step) => ({ ...step, fromPronoun: true as const })),
      },
    };
  });
}

function readClauses(text: string): ReadClause[] | null {
  // ─── A KEEP OR A THANK-YOU IS SET ASIDE FIRST, BEFORE ANY OF THIS READS THE SENTENCE'S SHAPE ──
  //
  // The companion to the sentence-stop boundary in `clausesOf`: the cut makes a clause of every trailing
  // sentence, and `ASKS_FOR_NOTHING` says which of those she was not asking anything with.
  //
  // ⚠️ HERE AND NOT IN `compose`, AND THE DIFFERENCE IS MEASURABLE. Built in `compose` it ran AFTER the
  // two short-circuits below, so a courtesy tail decided whether the sentence composed at all: "make the
  // jersey red, and make the shorts black. Keep everything else exactly as-is" went from ONE multi-target
  // recolour to TWO steps, because the unread third clause broke `oneChange` before anything dropped it.
  // A clause she is not asking anything with must not be able to change that, so it is gone before the
  // question is asked — and the sentence composes exactly as the same words without the tail would.
  //
  // ⚠️ TRAILING ONLY — HER FIRST CLAUSE IS NEVER DROPPED, AND jest FOUND WHY. Dropping a leading keep
  // reintroduced F-L4, the defect K2 closed: "dont change my cleats, make the socks blue" lost its first
  // clause, fell below two, and returned null — and null does not mean "read the clause that is left", it
  // means "the rules read the WHOLE text". So rule 5 saw the whole sentence again and recoloured the
  // cleats she had just said not to change, where main asks `compound_partial`. A keep she LEADS with is
  // the keep vocabulary's (`readKeep`, `readThingKeep`, set aside before the rules run); the clauses this
  // boundary newly created are the trailing ones, so those are the only ones it may set aside.
  //
  // ⚠️ AND FALLING BELOW TWO IS THEN SAFE. With only her first clause left this returns null and the rules
  // read the whole text — which for "make the socks blue. thanks" is exactly what they read on main, since
  // "thanks" leads no operation verb and never cut a clause there either.
  const clauses = clausesOf(text).filter(
    (c, i) => i === 0 || !ASKS_FOR_NOTHING.test(c.text),
  );
  if (clauses.length < 2) return null;
  if (clauses.every((c) => c.verb === "remove")) return null;
  const read = clauses.map((c) => ({
    text: c.text,
    read: classifyFast(c.text, true),
  }));
  const ops = new Set(
    read.flatMap((c) => c.read?.steps.map((s) => s.op) ?? []),
  );
  const oneChange =
    read.every((c) => c.read) &&
    ops.size === 1 &&
    (ops.has("REMOVE_OBJECT") || ops.has("RECOLOR"));
  if (oneChange) return null;
  // ⚠️ AFTER the short-circuit, never before it, and the two can never interact: `oneChange` requires
  // EVERY clause to have read, and the resolver only ever fires on one that did not. Running it first
  // could make a sentence collapse to whole-text reading that does not collapse today — which for
  // "make the socks blue. make them red." would mean rule 5 re-reading the whole sentence and keeping
  // one colour. Ordered this way, that is unrepresentable rather than merely avoided.
  return resolvePronounClauses(read);
}

/**
 * The clauses of a sentence that asks for DIFFERENT changes, in her words and her order — or null
 * when it asks for one change, however many times she says it (see `readClauses`).
 */
export function compoundClauses(text: string): string[] | null {
  return readClauses(text)?.map((c) => c.text) ?? null;
}

/** One clause of a composed sentence: her words, and the steps its own rule read from them. */
export interface ComposedClause {
  text: string;
  steps: EditStep[];
}

/** Rule ½'s answer: the composed steps (and the clauses they came from), or the code it asks with. */
type Composition =
  | { kind: "steps"; clauses: ComposedClause[]; steps: EditStep[] }
  | { kind: "ask"; reason: DeclineReason };

/**
 * A sentence of DIFFERENT changes → every clause's own steps, in her order — or why it asks. Null
 * when the sentence is one change, which the rules read whole, exactly as before (`readClauses`).
 *
 * The steps go on to `validate` unchanged in every respect but one: they came from one clause each.
 * So the person guard reads every step of every clause, the GENERATE invariant re-runs, and
 * `orderSteps` puts them in run order as it does for any multi-step answer — rule 4c's the precedent.
 *
 * ─── WHAT STILL ASKS, AND THE CODE EACH ONE GETS — EACH TRUE OF THE SENTENCE IT ANSWERS ─────────
 *
 *   too_many_changes   more than MAX_STEPS steps across the clauses — one brand clause alone can be
 *                      four. Asked up front, because `validate`'s `.slice(0, MAX_STEPS)` would drop
 *                      the rest without a word. Counted over the clauses it could read, so a clause
 *                      it could not read never hides how many the others asked for.
 *   compound_conflict  two backgrounds, or two looks. Rule 2 and rule 3 each read ONE value, and she
 *                      asked for two of the thing a photograph has one of. Which one is not guessed.
 *                      Two headlines too (PR T): one headline per image, across the top.
 *                      And a REMOVAL of something another clause also changes ("make her jersey blue
 *                      and remove the jersey") — `removesWhatAnotherChanges`.
 *   the clause's own   a clause no rule reads keeps the code it gets on its own (decision d1): "make my
 *                      arms bigger" is `person_mentioned` inside a compound too, so she hears the
 *                      person refusal rather than an invitation to reword it, and "add a soccer ball"
 *                      with no place is still `add_unclear`. Only the catch-all becomes…
 *   compound_partial   …one part of a sentence it could otherwise read. Dropping that part would be
 *                      the fast path losing some of what she said, which is the all-or-nothing rule.
 *
 * Two adds, two brand changes and two designs are NOT a conflict — each names its own thing — so
 * they compose. (Two adds with an object photo attached refuse at the freeze: which add the photo is
 * of is not guessed. studio/nativeIntent.ts, `ambiguous_object`.)
 */
function compose(text: string): Composition | null {
  const clauses = readClauses(text);
  if (!clauses) return null;
  const steps = clauses.flatMap((c) => c.read?.steps ?? []);
  if (steps.length > MAX_STEPS) {
    return { kind: "ask", reason: "too_many_changes" };
  }
  const twoOf = (op: EditOperation) =>
    steps.filter((s) => s.op === op).length > 1;
  if (
    twoOf("CHANGE_BACKGROUND") ||
    twoOf("GLOBAL_STYLE") ||
    twoOf("DISPLAY_TEXT") ||
    removesWhatAnotherChanges(clauses)
  ) {
    return { kind: "ask", reason: "compound_conflict" };
  }
  const unread = clauses.find((c) => !c.read);
  if (unread) {
    // ─── A CONDITION IS A PROPERTY OF THE SENTENCE, NOT OF A CLAUSE (wave B, C3a) ──────────────
    //
    // `declineReason` checks this function BEFORE its own conditional guard, so a compound's clause code
    // hides the "if" — and the guard's own note says why that is the wrong way round: the advice she
    // needs is "we can't do if yet", not the brand line about spelling out numbers.
    //
    // It surfaced here because C3a's stop boundary made a compound of a sentence that was one clause
    // before. Adi's live sentence, measured on main `2dc602e`:
    //
    //   change my uniform so that its a black adidas uniform. i dont want any nike logos showing in
    //   this so if there are any remove them
    //     before   ASK `conditional`     — one clause; the whole-sentence guard answered
    //     the cut   ASK `brand_change`   — clause 1's own code, and the "if" never mentioned
    //     with this ASK `conditional`    — as before
    //
    // ⚠️ IT CAN ONLY EVER CHANGE A CODE, NEVER A ROUTE. It sits inside the arm that has already decided
    // this sentence asks, so no sentence routes differently for it.
    if (CONDITIONAL.test(text)) return { kind: "ask", reason: "conditional" };
    const own = declineReason(unread.text);
    return {
      kind: "ask",
      reason: own === "fast_path_declined" ? "compound_partial" : own,
    };
  }
  return {
    kind: "steps",
    clauses: clauses.map((c) => ({ text: c.text, steps: c.read?.steps ?? [] })),
    steps,
  };
}

/**
 * Two targets naming one thing: the same words, or the shorter is the longer's tail — "the ball" is
 * "the soccer ball" — with a plural's "s" not counted on the noun. "tennis ball" and "soccer ball" are
 * two things.
 */
function sameThing(a: string, b: string): boolean {
  const x = a.split(" ");
  const y = b.split(" ");
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const tail = long.slice(long.length - short.length);
  return short.every((w, k) =>
    k === short.length - 1 ? sameNoun(w, tail[k]) : w === tail[k],
  );
}

/**
 * Does one clause REMOVE a thing another clause also changes — "make her jersey blue and remove the
 * jersey"? Composition's d2, extended (Adi, 2026-09-10): she would pay for a change that is deleted in
 * the same call, and no one wants that output. Which she meant is not guessed, so it asks.
 *
 * "Changes" is any target another clause's step reads — a recolour, a design, a replacement, another
 * removal, an add's thing or the surface it lands on — except a background's, whose only target is
 * the person it KEEPS. A target that names her is left to the person guard in `validate`, whose
 * refusal is the truer answer ("make my arm red and remove my arm" is person_target, as alone).
 */
function removesWhatAnotherChanges(clauses: ReadClause[]): boolean {
  const touched = (c: ReadClause) =>
    (c.read?.steps ?? [])
      .filter((s) => s.op !== "CHANGE_BACKGROUND")
      .flatMap((s) => s.targets);
  return clauses.some((c, i) =>
    (c.read?.steps ?? [])
      .filter((s) => s.op === "REMOVE_OBJECT")
      .flatMap((s) => s.targets)
      .filter((removed) => !namesPerson(removed))
      .some((removed) =>
        clauses.some(
          (other, j) =>
            j !== i && touched(other).some((t) => sameThing(removed, t)),
        ),
      ),
  );
}

/**
 * The clauses of a sentence rule ½ COMPOSED — her words and each one's own steps, in her order — or
 * null when rule ½ did not compose it: one change (read whole by the rules, as ever), or a compound
 * that asks. The same answer `classifyFast` acts on, with a source photo, which every caller has.
 *
 * For the stages after the classifier that must treat a composed sentence as what it is: the freeze,
 * where a composed intent runs native or not at all (studio/nativeIntent.ts), and the preview route,
 * where detection reads only the clauses that name something in the frame.
 *
 * ⚠️ NULL WHEN RULE 0 CLAIMS THE SENTENCE. A new image never composes, and a sentence EXPLICIT_GENERATE
 * matches never reaches rule ½ — so this must not answer for one either, or it would describe a
 * composition `route` never made.
 */
export function composedClauses(text: string): ComposedClause[] | null {
  if (EXPLICIT_GENERATE.test(text)) return null;
  const composed = compose(text);
  return composed?.kind === "steps" ? composed.clauses : null;
}

// ─── Stage 2: post-validation. Nothing reaches a path without passing this. ────────────────────

/**
 * ⚠️ WHY THERE IS NO LLM STAGE, WHICH IS A DECISION AND NOT AN OMISSION.
 *
 * The fall-through is ASK: deterministic, free, always correct, and every ASK is a logged example
 * of exactly what the fast path is missing. A model classifier benchmarked at ~90% on the golden
 * set means roughly one misroute in ten IN THE LAYER THAT CHOOSES WHETHER TO DESTROY A SOURCE
 * PHOTO. A clarifying question costs a round trip; a misroute costs the photograph.
 *
 * If one is built later it is cheaper than it looks: `detectRegions` (studio/autoMask.ts) already
 * spends a Gemini flash call at temperature 0 with a JSON schema, and already asks for `target`,
 * `directive` and `scope`. Classification would be three more fields on a call we pay for today —
 * though it would move the routing decision INSIDE detection, which currently runs only once
 * something else has already decided this is an edit.
 */
const ASK_ONLY: Pick<Routed, "initialPath" | "steps"> = {
  initialPath: "ASK",
  steps: [],
};

/** An ASK with its code. Nothing else rides on it (K8: `ambiguity` and `confidence` deleted). */
function ask(reason: string): Routed {
  return { ...ASK_ONLY, reason };
}

/**
 * Body words that are ALSO the name of a part of a thing — a shoe's toe box is "the toe of my cleats".
 *
 * Denied since 2026-09-10 (studio/objectVocab.ts, G.1): "make my toes pink" froze RECOLOR [toes] and
 * edited her. But "make the toe of my cleats white" routed before the widening and routes after it —
 * the one sentence shape the widening could have broken, pinned both ways in classify.test.ts.
 *
 * ⚠️ ONLY THESE FOUR, NEVER THE OLD LIST. `back` and `chest` have the same double sense and have always
 * been denied bare ("the back of my jersey" asks today); logFallThrough's note says why that question
 * is answered against counts, not here. This reading exists so that denying four NEW words does not
 * move a sentence that routed — not to reopen the old ones.
 */
const PART_OF_A_THING: ReadonlySet<string> = new Set([
  "toe",
  "toes",
  "nail",
  "nails",
]);

/** Articles only. "MY toe of…" is not English, and "my toe" is hers. */
const ARTICLES: ReadonlySet<string> = new Set(["the", "a", "an"]);

/**
 * Is this target a part of a THING in her sentence — "the toe of my cleats" — and so not a part of her?
 *
 * EVERY time the target's words appear, they must read "<the|a|an> <target> of [determiner] <owner>",
 * where the owner is a plain noun phrase that does not name her and is not a pronoun. One possessed
 * mention anywhere ("…the toe of my cleats and my toe white") and it is hers. No mention at all (a
 * target the text does not spell out) and it is hers. Every doubt denies.
 *
 * Positive evidence of a thing is what exempts, never the absence of a possessive: "make the toes pink"
 * has no "my" and is still refused — in a barefoot photograph the toes are hers.
 */
function namesAPartOfAThing(target: string, text: string): boolean {
  const words = target.split(" ");
  const head = words.at(-1);
  if (!head || !PART_OF_A_THING.has(head)) return false;
  const t = tokenize(text);
  let seen = 0;
  for (let i = 0; i + words.length <= t.length; i++) {
    if (!words.every((w, k) => t[i + k] === w)) continue;
    seen++;
    if (!ARTICLES.has(t[i - 1])) return false;
    let j = i + words.length;
    if (t[j] !== "of") return false;
    j++;
    if (DETERMINERS.includes(t[j])) j++;
    const owner: string[] = [];
    while (
      owner.length < MAX_TARGET_WORDS &&
      isWord(t[j]) &&
      !PHRASE_STOP.has(t[j]) &&
      !DETERMINERS.includes(t[j]) &&
      !COLOR.test(t[j]) &&
      !COLOR_MOD.test(t[j])
    ) {
      owner.push(t[j]);
      j++;
    }
    if (
      !owner.length ||
      OBJECT_PRONOUNS.has(owner[0]) ||
      namesPerson(owner.join(" "))
    ) {
      return false;
    }
  }
  return seen > 0;
}

/**
 * The guards, applied to whatever produced the classification.
 *
 * Order matters here too, and for a duller reason than in the fast path: the cheapest and most
 * absolute denial goes first, so a person target is refused before anything reasons about
 * ordering.
 */
export function validate(
  c: Classification,
  hasSourcePhoto: boolean,
  text: string,
  sink?: DiagnosticSink,
): Routed {
  // ─── THE PERSON GUARD, AT CLASSIFICATION TIME ──────────────────────────────────────────────
  //
  // The same rule parseDetections enforces, on the same implementation — `namesPerson` is imported,
  // not restated. Two copies of a safety rule is two rules, and the second one is the one nobody
  // updates. A person target is legal ONLY on CHANGE_BACKGROUND, the arm that inverts.
  //
  // ⚠️ ONE READING NARROWS IT, AND ONLY FOR WORDS THE GUARD DID NOT DENY BEFORE 2026-09-10:
  // `namesAPartOfAThing` — "the toe of my cleats" is the cleats', not hers. See its note.
  for (const step of c.steps) {
    const person = step.targets.find(
      (t) => namesPerson(t) && !namesAPartOfAThing(t, text),
    );
    if (person && step.op !== "CHANGE_BACKGROUND") {
      logPersonDenial(text, person, sink);
      return ask("person_target");
    }
    // A replacement's thing is what goes INTO the photo, where the thing it replaces was: "change my
    // earrings to these ears" edits her as surely as a target naming her would (replace with
    // reference). Only a pointed replacement: rule 4c's value is always the brand's version of the
    // item itself, which its own targets already answer for.
    if (step.reference === "object" && step.value && namesPerson(step.value)) {
      logPersonDenial(text, step.value, sink);
      return ask("person_target");
    }
  }

  // ─── THE HARD INVARIANT, RE-ASSERTED AFTER EVERY BRANCH ────────────────────────────────────
  //
  // Independent of which stage produced the steps, and of what the gate returned
  // earlier in the request. Checked here because this is the last place before a path is named, and
  // a rule that is only enforced where it was first computed is a rule with a hole in it.
  if (
    c.steps.some((s) => s.op === "GENERATE") &&
    hasSourcePhoto &&
    !EXPLICIT_GENERATE.test(text) &&
    // PR 19 (R-8): a pose is a new picture of her by ruling, and her approval of it is the spend gate.
    !(imageOpsEnabled() && readPose(text))
  ) {
    return ask("generate_not_permitted");
  }

  const steps = orderSteps(c.steps).slice(0, MAX_STEPS);
  if (!steps.length) return ask("no_steps");
  return {
    initialPath: ROUTE[steps[0].op],
    steps,
  };
}

/**
 * Steps in the order they must RUN. Stable within a path, so her stated order survives among peers.
 *
 * `Array.prototype.sort` is specified stable, which is what keeps "make my jersey a blue adidas
 * kit" as RECOLOR then APPLY_DESIGN rather than reshuffling two steps that share a path.
 *
 * ⚠️ 2026-09-10: that sentence no longer produces two steps — rule 4c routes it as ONE REPLACE,
 * "blue adidas jersey". The stability point stands; it is what keeps a brand change's items in her
 * order ("uniform, socks, and shoes"), all of them REPLACE_OBJECT on one path.
 */
export function orderSteps(steps: EditStep[]): EditStep[] {
  return [...steps].sort(
    (a, b) => PATH_ORDER[ROUTE[a.op]] - PATH_ORDER[ROUTE[b.op]],
  );
}

/**
 * The two codes that refuse an edit of HER — the guard's (`validate`) and the fall-through's (`declineReason`).
 * The only asks her keep may be set aside from (`route`, ledger F-L5): every other ask is the interpreter's.
 */
const PERSON_REFUSALS: ReadonlySet<string> = new Set([
  "person_target",
  "person_mentioned",
]);

/**
 * The whole classifier: fast path, then guards. Fall-through is ASK.
 *
 * Pure apart from the diagnostic log lines, and wired to nothing — `deriveIntent` still routes
 * the product. This is the shape the PR 2 cutover calls.
 *
 * `attached` is what the request carries beside the frame (see `Attached`). It is read after the
 * guards, and only by a replacement she pointed at a photo for — every other sentence routes exactly
 * as it does without it.
 */
export function route(
  text: string,
  hasSourcePhoto: boolean,
  attached: Attached = NOTHING_ATTACHED,
): Routed {
  const passes: Pass[] = [];
  // PR 19 (R-7): the closed typo and slang maps, before any rule reads her words — "make the jersy red" is the
  // jersey, "the kicks" are her shoes. Where a map changed a word and the sentence routes, `readAs` carries the
  // mapped words, so detection and the freeze read what the rules read (nativeIntent.ts reads `readAs`).
  const words = imageOpsEnabled() ? normalizeWords(text) : text;
  const read = decide(words, hasSourcePhoto, attached, passes);
  // One line per decision (see `Diagnostic`): the pass whose answer she gets writes at info; the others,
  // read and set aside, at debug. A routed answer has no line — nothing was refused.
  for (const p of passes) {
    if (!p.diag) continue;
    if (p.routed === read) note(p.diag.fields, p.diag.msg);
    else note({ ...p.diag.fields, superseded: true }, p.diag.msg, "debug");
  }
  return words !== text && read.initialPath !== "ASK" && !read.readAs
    ? { ...read, readAs: words }
    : read;
}

/** `route`'s reading, with every pass collected — `route` alone writes the log. */
function decide(
  text: string,
  hasSourcePhoto: boolean,
  attached: Attached,
  passes: Pass[],
): Routed {
  const routed = routeWords(text, hasSourcePhoto, attached, passes);
  // ─── HER KEEP, BESIDE AN EDIT THE RULES READ (A3b, 2026-09-14; ledger F-L2) ────────────────────────
  //
  // "make it warmer, dont change anything about me" routed as the look alone, her keep gone; "make it golden
  // hour, keep me the same" routed as RECOLOR [same] — "make the same golden". The interpreter reads her
  // keep as `preserve_person`, but only on a sentence that asks, and these route. So a keep studio/keepVocab.ts
  // recognizes is set aside, the rules read the rest, and `preserve_person` rides beside their steps — the
  // interpreter's constraint, frozen as its version 2 intent (nativeIntent.ts). `readAs` is the rest: what
  // detection and the freeze read too, so her keep is never region text either.
  //
  // ⚠️ ONLY WHERE HER SENTENCE ALREADY ROUTES, AS AN EDIT (Adi's Option A). An ask stays the interpreter's,
  // exactly as it was — its eligibility, R1's cells, every ask's copy. A GENERATE, or a sentence with no
  // photo, has no intent for a constraint to ride. And if the rest ASKS, so does the sentence: whatever
  // routed must have read her keep as something, and that reading is the bug — "remove it, keep me the
  // same" removed "the same" (keepVocab.test.ts, the fail-closed path).
  //
  // ─── AND WHERE THE RULES REFUSED IT AS AN EDIT OF HER (ledger F-L5; the preservation fixes, D1) ────────
  //
  // "make my jersey blue, dont change my face" was RECOLOR [jersey, face] read whole, and the person guard
  // refused the face: she heard "we don't edit people" about a sentence asking us not to. A person code is
  // never the interpreter's, so nothing reached it. Where the rules refused her sentence as an edit of her
  // and the rest routes, it routes, her keep beside it. ONLY the person codes (D1): every other ask is
  // still the interpreter's. And where the rest asks too, her sentence asks with the code it always had —
  // an edit of her beside her keep ("make my arms bigger, dont change my face") is refused as before.
  //
  // ─── AND A KEEP OF A THING (ledger F-L4; the preservation fixes, K2) ─────────────────────────────────
  //
  // "remove the cone but keep the ball" froze REMOVE [cone, ball]; "make everything blue but keep my cleats"
  // recoloured the cleats alone; "dont change the background, just make it warmer" was a background change.
  // No rule reads "keep", so the rule that read her sentence took the kept thing as its own. So a keep of a
  // thing studio/keepVocab.ts recognizes is set aside too, and the rules read the rest: "remove the cone".
  // Nothing rides beside it — the scope sentence every native compile writes already keeps what she did not
  // name (a keep line of its own is ledger F-L7). `readAs` is the rest, so detection never looks for it.
  //
  // ⚠️ IT ASKS (`keep_conflict`) WHERE THE REST WOULD CHANGE WHAT SHE KEPT: a step naming the thing, or a look
  // or a background, which change the whole photo — or where the rules read her whole sentence and the rest
  // is one they cannot read ("make everything blue"). Never an interpreter code (D7): it has no way yet to
  // carry her keep. Where her whole sentence ALREADY asked and the rest asks too, it asks as it did.
  if (!hasSourcePhoto || routed.steps.some((s) => s.op === "GENERATE")) {
    return routed;
  }
  // Her keep and a keep of a thing, each set aside once, from either end of her sentence.
  let words = text;
  const keep = readKeep(words);
  if (keep) words = keep.rest;
  const thing = keptThing(words);
  if (thing) words = thing.rest;
  const after = thing && !keep ? readKeep(words) : null;
  if (after) words = after.rest;
  const hers = !!(keep ?? after);

  if (!thing) {
    if (!hers) return routed;
    if (
      routed.initialPath === "ASK" &&
      !PERSON_REFUSALS.has(routed.reason ?? "")
    ) {
      return routed;
    }
    const rest = routeWords(words, hasSourcePhoto, attached, passes);
    if (rest.initialPath === "ASK") {
      return routed.initialPath === "ASK" ? routed : rest;
    }
    return {
      ...rest,
      constraints: [{ kind: "preserve_person" }],
      readAs: words,
    };
  }

  const rest = routeWords(words, hasSourcePhoto, attached, passes);
  if (rest.initialPath === "ASK") {
    if (routed.initialPath === "ASK") return routed;
    return PERSON_REFUSALS.has(rest.reason ?? "") ? rest : keepConflict();
  }
  // Every thing she kept — one, or each of a list (V6).
  const changesIt = rest.steps.some(
    (s) =>
      WHOLE_PHOTO_OPS.has(s.op) ||
      s.targets.some((t) => thing.things.some((k) => sameThing(t, k))),
  );
  if (changesIt) return keepConflict();
  return {
    ...rest,
    ...(hers ? { constraints: [{ kind: "preserve_person" as const }] } : {}),
    readAs: words,
  };
}

/** Operations that change the whole photograph — a look, and a background — so they change a kept thing too. */
const WHOLE_PHOTO_OPS: ReadonlySet<EditOperation> = new Set([
  "GLOBAL_STYLE",
  "CHANGE_BACKGROUND",
  "RELIGHT",
  "CAMERA",
  "CROP",
]);

/**
 * A keep of a thing in her words (keepVocab.ts, `readThingKeep`) — or null where the rules' vocabulary says
 * it is not one: her, or a part of her (her keep is `readKeep`'s, and her body the guard's); a thing
 * carrying a colour or a look, which may be an instruction ("keep the jersey red" — D6: read as today); or a
 * keep read first whose rest leads no change ("keep the ball and remove" is not a list she kept).
 *
 * ─── A LIST SHE KEPT, EVERY ITEM HELD THE SAME (wave A, V6) ─────────────────────────────────────────────────
 *
 * "keep the ball, cone and bench, and remove the net" is read now as the three things kept (keepVocab.ts), and the
 * rest "remove the net" routes. Each item passes every check a single thing does — one failing, and nothing is kept,
 * so the sentence reads as it did. And a list is never our own preservation sentence, which is shaped exactly like
 * one: "Keep the original photograph's lighting, exposure, contrast, colour grade and scene exactly as they are."
 * (compile/preservation.ts) is not her keep (#488's guard). So a kept list may carry no possessive and no scene
 * property the clause names.
 */
function keptThing(
  words: string,
): { rest: string; thing: string; things: string[] } | null {
  const kept = readThingKeep(words);
  if (!kept) return null;
  // Read first, what follows must lead a change of its own — not run on a list she kept (keepVocab.ts).
  if (kept.at === "first") {
    const t = tokenize(kept.rest);
    if (operationAt(t, pastPoliteness(t)) === null) return null;
  }
  const things = kept.things ?? [kept.thing];
  for (const thing of things) {
    const parts = thing.split(" ");
    if (namesPerson(thing) || parts.some((w) => namesPerson(w))) return null;
    const last = parts[parts.length - 1];
    if (
      COLOR.test(last) ||
      COLOR_MOD.test(last) ||
      HEX.test(last) ||
      GLOBAL.test(last) ||
      lookOf(last)
    ) {
      return null;
    }
    if (
      kept.things &&
      (parts.some((w) => /['’]/.test(w)) ||
        SCENE_PROPERTY_WORDS.has(last) ||
        operationAt(parts, 0) !== null)
    ) {
      return null;
    }
  }
  return { rest: kept.rest, thing: kept.thing, things };
}

/** The words our preservation sentence keeps (compile/preservation.ts) — never an item of a list she kept (V6). */
const SCENE_PROPERTY_WORDS: ReadonlySet<string> = new Set([
  "lighting",
  "exposure",
  "contrast",
  "grade",
  "scene",
]);

/** The ask when her change would alter what she kept, or cannot be read beside it (K2). Codes only in the log. */
function keepConflict(): Routed {
  // Through `note`, as every classifier line is (auto-mark, AM.1): a composer's draft call writes nothing, a shape call is tagged.
  note(
    { event: "keep_conflict" },
    "classifier asked: the change would alter a thing she kept, or could not be read beside it",
  );
  return ask("keep_conflict");
}

/** What the rules make of her words, read whole — `route` before her keep is set aside. */
function routeWords(
  text: string,
  hasSourcePhoto: boolean,
  attached: Attached,
  passes: Pass[],
): Routed {
  const pass = (routed: Routed, diag: Diagnostic | null): Routed => {
    passes.push({ routed, diag });
    return routed;
  };
  let diag: Diagnostic | null = null;
  const sink: DiagnosticSink = (d) => {
    diag = d;
  };
  const fast = classifyFast(text, hasSourcePhoto);
  if (!fast) {
    const reason = declineReason(text);
    logFallThrough(text, reason, sink);
    return pass(
      reason === "vague"
        ? { ...ask(reason), suggestions: VAGUE_SUGGESTIONS }
        : reason === "angle_unclear"
          ? { ...ask(reason), suggestions: ANGLE_SUGGESTIONS }
          : ask(reason),
      diag,
    );
  }
  const routed = validate(fast, hasSourcePhoto, text, sink);
  // ─── "THESE GOLD HOOPS", AND NO PHOTO OF THEM (replace with reference) ─────────────────────────────
  //
  // She pointed at something, and nothing is attached to point at. Read as the words alone it would be
  // a description — "gold hoops" — which is not what she said: she said THESE. So it asks, and the
  // answer says how to show us or how to say it instead. There is no invented arm, unlike an add's
  // (studio/compile/disclosure.ts, inventedObjectNote): an add names a thing any ball can be, and
  // "these" names one she has.
  //
  // AFTER the guards, so a refusal that no photo could change is the one she hears: "change my arm to
  // this one" is the person line, not an invitation to attach something.
  if (
    routed.initialPath !== "ASK" &&
    routed.steps.some((s) => s.reference === "object") &&
    attached.objects < 1
  ) {
    return pass(
      ask("object_photo_missing"),
      {
        fields: { event: "object_photo_missing" },
        msg: "classifier asked for the photo her sentence points at",
      },
    );
  }
  // ─── "MATCH THIS LOOK", AND NO STYLE REFERENCE (PR 19, B) ──────────────────────────────────────────
  //
  // The look pointer's twin of the object pointer above: she pointed at a picture's look, and no Style reference
  // is attached for the look to come from. A look is hers only when her words or her picture name it (M6), so it
  // asks — `style_reference_missing` — and never guesses a grade.
  if (
    routed.initialPath !== "ASK" &&
    routed.steps.some((s) => s.reference === "style") &&
    (attached.styles ?? 0) < 1
  ) {
    return pass(ask("style_reference_missing"), {
      fields: { event: "style_reference_missing" },
      msg: "classifier asked for the style reference her sentence points at",
    });
  }
  return pass(routed, diag);
}

/**
 * Which "no" a fall-through is — a code the screen turns into the right sentence (PR C′, C.4).
 *
 * ─── WHY THE FALL-THROUGH NEEDED MORE THAN ONE CODE ────────────────────────────────────────────
 *
 * Every sentence the fast path could not read came back as `fast_path_declined`, and the screen
 * rendered one catch-all for all of them ("name the thing and what it should become"). Measured on
 * the 2026-09-09 G checks, that one sentence answered three different declines:
 *
 *   "add a soccer ball…"       an add it could not place — she did name the thing; she needs the
 *                              working phrasing, and to know preservation is automatic.
 *   "make my arms bigger"      her body. NOT the person guard: the fast path declined before
 *                              `validate` ever ran, so the guard never saw it (objectVocab.ts's
 *                              trailing-modifier note records the same coincidence). The honest
 *                              answer is "we don't change bodies", and rephrasing cannot change it.
 *   "change my jersey to adidas"  a brand change, which rule 4b declines on purpose.
 *
 * ⚠️ 2026-09-10: the third one now ROUTES (rule 4c, a product decision). `brand_change` is kept for
 * the brand sentences 4c still cannot read — the case it was always the name for, one rule later.
 * And a removal that names a brand is split out of it as `brand_removal` (the first check below):
 * its copy had been teaching her how to switch brands when she had asked to take a logo off.
 *
 * ⚠️ IT NEVER DECIDES WHETHER A SENTENCE ROUTES. It runs only after `classifyFast` returned null —
 * the answer is ASK before this is called and ASK after, whatever it says. It reads the same
 * vocabulary the rules read and the same `namesPerson` the guard imports, and it chooses nothing
 * but the words of the refusal. The guard itself is `validate`, unchanged; `person_target` stays its
 * code, and `person_mentioned` is a separate one so the logs can still tell "the guard refused a
 * routed step" from "the fast path could not read a sentence about her".
 */
/**
 * Changes TO her body, never things she wears or holds — PR M3's closed BODY_MODS list. Mia's M3 allows
 * worn items onto her, and says body modification is never allowed; these are what `declineReason`
 * gives the person line to when no place on her is named. Plurals beside singulars, because the check
 * is an exact match on a word; "six pack" is a head of two words, and "six-pack" one token.
 */
export const BODY_MODS: ReadonlySet<string> = new Set([
  "tattoo",
  "tattoos",
  "scar",
  "scars",
  "muscle",
  "muscles",
  "abs",
  "six pack",
  "six-pack",
  "freckles",
  "piercing",
  "piercings",
  "wrinkles",
  "mole",
  "moles",
  "birthmark",
  "birthmarks",
]);

/**
 * Does her sentence ADD, PUT or GIVE her a body modification — "add a tattoo", "give me abs", "can you add
 * muscles"? The thing is read as an add's is: from the word after the verb (after "me" or "her" for
 * `give`), to the first word that ends it. A BODY_MODS word in it, or "six pack", and the answer is yes.
 * A copy question only: `declineReason` asks it after `classifyFast` has already returned null.
 */
function addsABodyMod(text: string): boolean {
  const t = tokenize(text);
  let i = pastPoliteness(t);
  const gives = t[i] === "give" || t[i] === "gives";
  if (!ADD_VERBS.has(t[i]) && !gives) return false;
  i++;
  if (gives && OBJECT_PRONOUNS.has(t[i])) i++;
  if (ADD_DETERMINERS.has(t[i])) i++;
  const thing: string[] = [];
  while (
    isWord(t[i]) &&
    !ENDS_AN_ADD_PHRASE.has(t[i]) &&
    !ADD_DETERMINERS.has(t[i])
  ) {
    thing.push(t[i]);
    i++;
  }
  return thing.some(
    (w, k) => BODY_MODS.has(w) || BODY_MODS.has(`${w} ${thing[k + 1]}`),
  );
}

export type DeclineReason =
  | "fast_path_declined"
  | "add_unclear"
  | "person_mentioned"
  | "brand_change"
  | "brand_removal"
  | "compound_partial"
  | "compound_conflict"
  | "too_many_changes"
  | "conditional"
  | "worn_add_unclear"
  | "headline_bounds"
  | "look_unknown"
  // PR 19 (R-6): "make it pop" — better, with nothing named to change. The ask carries op chips.
  | "vague"
  // PR 19 (W-5): "change the angle", no angle named — asks, with angle chips.
  | "angle_unclear";

export function declineReason(text: string): DeclineReason {
  // PR 19: first — "make it pop" names nothing to change (R-6), so no check below is true of it.
  if (imageOpsEnabled() && readVague(text)) return "vague";
  // W-5: a camera change with no angle; W-4: a hold the add rule could not place is still an add, asked about.
  if (imageOpsEnabled() && readAngleUnclear(text)) return "angle_unclear";
  if (imageOpsEnabled() && NAMES_A_HOLD.test(text)) return "add_unclear";
  // ─── A HEADLINE IN RULE ⅛'S SHAPE, WHOSE WORDS ARE OUT OF BOUNDS (PR T, N8) ────────────────────────
  //
  // First, before the compound check: the shape is her WHOLE sentence, so nothing below is true of it —
  // "IF ANY DOUBT REMAINS HERE" would be told about "if", and "WE RUN THIS CITY TONIGHT" to say where it
  // goes (`add_unclear`). Only with the switch on; off, rule ⅛ is not there and the code is main's. A
  // compound's headline clause reaches this from `compose`, so there the clause's own code wins too.
  if (displayTextEnabled()) {
    const words = readHeadline(text);
    if (words && headlineBound(words)) return "headline_bounds";
  }
  // ─── A COMPOUND RULE ½ COULD NOT COMPOSE (composition, 2026-09-10) ──────────────────────────────
  //
  // First, because every check below reads ONE of her changes and answers for the whole sentence.
  // That is sweep #3's F2: "add a soccer ball at her feet and make her jersey blue" was told "we
  // don't edit people", about a sentence that edits no one, because the recolour's rule 5 claimed
  // "her feet" and the guard refused it. `compose` reads clause by clause, so its code is true of the
  // part that stopped it — including the person refusal, when that part is a body edit (d1).
  //
  // PR 1's `compound_pending` ("one change per sentence right now") is retired: composition routes
  // those sentences, and every compound that still asks gets one of the codes `compose` names.
  const composed = compose(text);
  if (composed?.kind === "ask") return composed.reason;
  // ─── A CONDITION, WHICH RULE ¼ DOES NOT READ (guard scope, 2026-09-10) ──────────────────────────
  //
  // Before the brand checks, because Mia's (d) names two brands AND a removal: brand_removal would
  // otherwise teach her to spell out numbers, about a sentence whose problem is the "if".
  if (CONDITIONAL.test(text)) return "conditional";
  // ─── A WORN ADD WHOSE ONLY PROBLEM IS THE WORDS OF ITS THING (PR M3.8) ────────────────────────────
  //
  // "add small gold hoops to my ears", "put a baseball cap on my head": the thing she wears, onto its own
  // place — and a word the rule does not read. The plain sentence routes, so the line says to say it
  // plainly, never "we don't edit people". Before the person arm below, which answers every other worn
  // add that did not route; `addsAnUnreadWornThing` keeps the person line wherever it is true.
  if (addsAnUnreadWornThing(text)) return "worn_add_unclear";
  // ─── AN ADD OF SOMETHING SHE WEARS, ONTO A PART OF HER RULE 3¾b DID NOT READ (PR M3) ─────────────
  //
  // G.3 answered every one of these `add_onto_body` — "a call we haven't made yet". M3 made the call, and
  // rule 3¾b routes the ones it reads; the arm above takes the ones stopped only by the words of their
  // thing (M3.8). What reaches here is a change to her: a place that is not the thing's own ("put a stud
  // through my eyebrow" — a piercing Mia has not opened), one that describes her body, or a thing named
  // after a part of her. Each gets the person line, as rule 4½'s guard answers the same sentences said
  // with a preposition it reads ("…to my eyebrow"). Before the brand checks: "put a nike stud through my
  // eyebrow" is the same question.
  if (addsWornOntoHer(text)) return "person_mentioned";
  // ─── A BODY MODIFICATION, WITH NO PLACE ON HER NAMED (PR M3) ─────────────────────────────────────
  //
  // "add a tattoo on my arm" has always had the person line — the guard refused her arm. "add a
  // tattoo", "add muscles" and "add abs" named no place, so they asked `add_unclear`, whose copy invites
  // her to say where it goes, and "give me abs" got the catch-all. Both answers suggest a rephrasing
  // exists; for a change to her body none does. So they get the person line too. Before the brand
  // checks: "add a nike tattoo" is a tattoo, not a brand change.
  if (addsABodyMod(text)) return "person_mentioned";
  // ─── A REMOVAL THAT NAMES A BRAND, WHICH RULE 1 FOUND NOTHING IN (2026-09-10) ─────────────────
  //
  // "remove the 8 and nike logo" ASKed live as brand_change, and brand_change's copy teaches how to
  // SWITCH a brand — the wrong answer to a removal. Rule 1 claims every removal it can find a target
  // in, so a removal that reaches here had none: digits are not tokens, so "the" introduced nothing
  // before "and", and "nike logo" has no determiner. The brand never caused the decline; it only
  // chose the copy. So a removal gets its own code and its own line, and brand_change keeps meaning
  // a change. Checked first, because the brand_change test below would take it.
  //
  // A CODE, NOT A POLICY. It decides nothing — this runs after classifyFast already returned null —
  // and "remove the nike logo" routes today exactly as it did. Whether a brand's mark may be
  // removed at all is Mia's call, not something this line knows.
  if (BRANDS.test(text) && REMOVE.test(text)) return "brand_removal";
  // A brand with no add or give construction, that rule 4c could not read either: "change my red
  // socks to nike", "change my jersey to adidas without stripes" — rule 4b's own decline.
  if (BRANDS.test(text) && !ADD_VERB.test(text) && !GIVE_VERB.test(text)) {
    return "brand_change";
  }
  // ─── A LOOK SHE NAMED THAT WE DO NOT HAVE (style vocabulary, V.4) ───────────────────────────────────
  //
  // "give it a dreamy vibe", "a y2k aesthetic", "add a dreamy filter": a look request in every word but
  // one, and that one right before a word for a look (studio/lookVocab.ts, `unknownLookWord`). She named a
  // look, so the catch-all — "name the thing and what it should become" — is false of it, and so is the
  // add's "say where it goes" about a filter. Its own line names some looks we have. Never a brand or a
  // design word, as the add below is guarded: "give it a nike look" is a brand's business and "a logo
  // look" rule 4's, not looks we lack. Never a word for her: "skin tone" and "hair style" are about her,
  // and a list of looks to try is the wrong answer to them. Each keeps the answer it had.
  const lookWord = unknownLookWord(text);
  if (
    lookWord &&
    !namesPerson(lookWord) &&
    !DESIGN.test(text) &&
    !BRANDS.test(text)
  ) {
    return "look_unknown";
  }
  // An add of a thing that rule 4½ could not parse — no place, a place it does not know, or a second
  // instruction after it. A design or brand token is rule 4's business, not an add's.
  const t = tokenize(text);
  let i = 0;
  while (t[i] === "please") i++;
  if (ADD_VERBS.has(t[i]) && !DESIGN.test(text) && !BRANDS.test(text)) {
    return "add_unclear";
  }
  // Every region the sentence names is her. One garment among them and it is not this case.
  const named = regionTargets(text);
  if (named.length && named.every((n) => namesPerson(n.phrase))) {
    return "person_mentioned";
  }
  return "fast_path_declined";
}

// ─── The diagnostics, and the open question they exist to answer ───────────────────────────────

/**
 * THE DETERMINER QUESTION, RECORDED AS TWO TOKENS AND NOTHING ELSE.
 *
 * ⚠️ HER SENTENCE IS NOT LOGGED, and that is the same rule `detectRegions` keeps: a brief's
 * direction can arrive from an inbox message or a brand email, so an instruction is untrusted text
 * that does not belong in a log line. The reason code and the extracted tokens are enough.
 *
 * ─── THE QUESTION THESE TWO FIELDS EXIST TO ANSWER ─────────────────────────────────────────────
 *
 * "back", "front", "chest", "shoulder", "sleeve" and "waist" are body words that are ALSO garment
 * regions, and in this product the garment reading is the common one. "put a number 10 on the back"
 * is a core NIL request, and a person guard that reads "the back" as her body would refuse it every
 * time.
 *
 * The likely discriminator is the determiner: "HER back" is her, "THE back" of a jersey is a
 * garment region. `namesPerson` cannot see it — it receives the phrase with the determiner already
 * stripped, by design, because on the samNoun path "her body" and "the body" are equally her.
 *
 * ⚠️ NOT FIXED HERE, ON PURPOSE. A rule invented from intuition about which determiner means what
 * would be exactly the guesswork the positional invariant replaced. The determiner is recorded
 * beside the phrase, and the rule is written later against counts rather than against a hunch. Two
 * short tokens answer that question as well as the whole sentence would, and carry none of it.
 */
// ─── WHY A CALL WAS MADE, WHEN IT WAS NOT THE ANSWER SHE IS SHOWN (auto-mark, 2026-09-16) ──────────────────
//
// Create anything asks this classifier two questions of its own before a plan exists, both to decide whether
// one attached photo of hers is the frame (client/screens/studio/createAnythingLogic.ts):
//
//   draft  while she types — the EDITING badge follows her words. A partial sentence ("make the socks") is not
//          a request, and a fall-through logged for it would read as one the screen declined.
//   shape  at send, on the exact sentence she sent — is it edit-shaped. Complete, but she is shown nothing from
//          it: the plan's own classify call, untagged, is the answer she sees.
//
// So a DRAFT call logs nothing, and a SHAPE call's lines carry `purpose: "shape"`. Every other caller — the plan,
// the preview, the freeze, the spend-time re-check — logs exactly as before. The answer never depends on it.

/** Why a classify call was made, when it is not a routing decision she is shown. */
export type ClassifyPurpose = "draft" | "shape";
export const CLASSIFY_PURPOSES: readonly ClassifyPurpose[] = ["draft", "shape"];

/** Set for the length of one synchronous `route` call by `routeAs`, and read only by `note`. */
const purposeOfCall = new AsyncLocalStorage<ClassifyPurpose>();

/** `route`, with its log lines kept out (draft) or tagged (shape). Absent purpose is `route` itself. */
export function routeAs(
  purpose: ClassifyPurpose | undefined,
  text: string,
  hasSourcePhoto: boolean,
  attached: Attached = NOTHING_ATTACHED,
): Routed {
  if (!purpose) return route(text, hasSourcePhoto, attached);
  return purposeOfCall.run(purpose, () =>
    route(text, hasSourcePhoto, attached),
  );
}

/** Every diagnostic line the classifier writes goes through here — see the note above. */
function note(
  fields: Record<string, unknown>,
  msg: string,
  level: "info" | "debug" = "info",
): void {
  const purpose = purposeOfCall.getStore();
  if (purpose === "draft") return;
  logger[level](purpose ? { ...fields, purpose } : fields, msg);
}

// ─── ONE LINE PER DECISION (PR 9, commit 0b — the PR 1 log-noise flag) ──────────────────────────────
//
// `route` reads a sentence more than once: whole, then with her keep set aside, then with a kept thing
// set aside. Until PR 9 every pass wrote its own refusal line the moment it refused, so "make my jersey
// blue, dont change my face" logged `person_target` — and then ROUTED, as RECOLOR beside her keep. The
// line said the guard refused her; the answer said it did not. And a sentence that asks after two passes
// logged the same refusal twice.
//
// So a pass no longer writes: it hands its one diagnostic back (`Diagnostic`, through a `DiagnosticSink`),
// and `route` writes exactly the line of the pass whose answer she gets, at info. A pass another one
// superseded goes out at debug, `superseded: true`, so a reading of the rules is never lost, only kept
// off the decision log. `validate` called alone (a test, a caller outside `route`) still writes at once —
// no sink, no change.
//
// ⚠️ MUTATION: write the pass's line the moment it refuses (call `note` in `logPersonDenial` whether or not
// a sink was given) — "person_target logged on a routed sentence" reds by name (classifyPurpose.test).
interface Diagnostic {
  fields: Record<string, unknown>;
  msg: string;
}
type DiagnosticSink = (d: Diagnostic) => void;

/** One reading of some words by the rules: its answer, and the one line it would have written. */
interface Pass {
  routed: Routed;
  diag: Diagnostic | null;
}

/** Hand the line to the sink when there is one; write it now when there is not. */
function emit(d: Diagnostic, sink?: DiagnosticSink): void {
  if (sink) sink(d);
  else note(d.fields, d.msg);
}

function logFallThrough(
  text: string,
  reason: DeclineReason,
  sink?: DiagnosticSink,
): void {
  emit(
    {
      fields: {
        event: "fast_path_declined",
        // Which "no" the screen was told — a code, like everything else on this line.
        reason,
        targets: extractTargets(text).map((t) => ({
          determiner: t.determiner,
          phrase: t.phrase,
        })),
      },
      msg: "classifier fell through to ASK",
    },
    sink,
  );
}

function logPersonDenial(
  text: string,
  phrase: string,
  sink?: DiagnosticSink,
): void {
  const match = extractTargets(text).find((t) => t.phrase === phrase);
  emit(
    {
      fields: {
        event: "person_target",
        phrase,
        // Null when the target came from somewhere other than an extracted phrase, which is itself
        // worth knowing — it means the guard fired on something this extractor cannot explain.
        determiner: match?.determiner ?? null,
      },
      msg: "classifier denied a person target",
    },
    sink,
  );
}
