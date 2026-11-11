/**
 * studio/nativeIntent — FREEZING her classified intent at preview time, for a native edit.
 *
 * The PR N rule: the classified intent she approved a cost against is the intent that runs. So her
 * sentence is classified ONCE, here, when she is quoted, and the answer is frozen onto the brief the
 * approval points at. The generate route re-classifies as a GUARD — any disagreement refuses, and is
 * never resolved in either direction (routes/studio.ts, `nativeRecheck`).
 *
 * ─── THE WORDS ARE HER SENTENCE, AND NEVER `direction.statement` ─────────────────────────────────
 *
 * `directionFor` (studio/brief.ts) stamps the objective's boilerplate goal — with the brand's name
 * interpolated — as `set: "chosen", untrusted: false` when she typed nothing: the same values her own
 * words get, so nothing on the brief can tell the two apart (Q's coupling note, studio/qa/inspect.ts).
 * Classifying the statement would freeze an intent nobody asked for. So the words come from
 * `explicitAsk(input)` — the BriefInput she actually sent, her typed direction, empty when she typed
 * nothing — and an empty ask freezes nothing.
 *
 * ─── WHERE EACH CHANGE STRING COMES FROM (PR N, D2 option B) ─────────────────────────────────────
 *
 * Operation, targets and scope are the classifier's. So is the change, wherever the classifier's
 * `value` is complete: a design ("adidas logo"), a place ("beach at sunset"), a look ("black and
 * white"). For a RECOLOUR it is not — `firstMatch` keeps one colour token, so "black and green" is
 * "black", "light blue" is "blue", and "the jersey red and the shorts black" gives BOTH targets red.
 *
 * So a recolour's change comes from the target's own frozen region label: the per-region directive
 * detection wrote from her sentence, which is the SAME STRING the masked crop prompt already sends as
 * `CHANGE ONLY: <label>`. That is the property the whole choice rests on — N.1 and sweep #2 measure
 * the model, not a new compiler. ("black and green shorts" compiles back to Q5's exact prompt.)
 *
 * ─── AND IT IS ADMITTED ONLY ON TWO CONDITIONS, BOTH FAIL-CLOSED ─────────────────────────────────
 *
 *   • It must END with a target the classifier found — the label "red jersey" is the jersey's, the
 *     bare "red" detection sometimes collapses to is nobody's, and a label nobody owns is refused.
 *   • It must not be her sentence echoed back. When detection names no directive, autoMask falls back
 *     to `labelFor(instruction)` — her whole sentence, trimmed — and that string reaching the prompt is
 *     exactly the raw-sentence leak the classified intent exists to prevent. A recolour whose regions
 *     carry the echo refuses to freeze, by rule and not by accident (pinned in nativeIntent.test.ts).
 *
 * A refusal here is a BLOCKING gap on the preview, never a fallback to masked: with the flag on, a
 * linguistic intent routes native, and one that cannot be compiled does not spend at all.
 */
import {
  composedClauses,
  route,
  NOTHING_ATTACHED,
  type Attached,
  type EditStep,
} from "./classify";
import { labelFor } from "./autoMask";
import {
  explicitAsk,
  NO_EDIT_REGIONS_FIELD,
  type BriefInput,
  type BriefOrigin,
  type CreativeBrief,
  type EditRegion,
  type JobReference,
  type SourceAsset,
} from "./brief";
import {
  imageOpsEnabled,
  moveObjectEnabled,
  nativeEditEnabled,
  smallestImageSizeFor,
} from "./config";
import {
  canonicalConstraints,
  REGION_FREE_OPS,
  type EditConstraint,
  type FrozenEditIntent,
  type NativeChange,
} from "./nativeEdit";
import { sceneLast } from "./compile";
import { createLogger } from "../logger";

const logger = createLogger("studio/nativeIntent");

export type FreezeRefusalReason =
  /** Brand-authored text. The compiled instruction is unfenced, so only her own words may freeze. */
  | "untrusted_origin"
  /** She typed nothing. The brief's statement would be our boilerplate. */
  | "no_ask"
  /** The frame's dimensions were not measured, so neither the ratio nor the size can be pinned. */
  | "unmeasured_source"
  /** The classifier declined — ASK, with its own reason carried in `askReason`. */
  | "not_routed"
  /** She asked for a new image. That is a generate, not an edit of this photo. */
  | "generate_on_edit"
  /** A recolour's regions carry autoMask's fallback label — her sentence, echoed. */
  | "echoed_directive"
  /** A classified recolour target has no region label that ends with it. */
  | "unpaired_directive"
  /** One target, two different directives. */
  | "ambiguous_directive"
  /**
   * A MOVE whose thing detection did not find (wave B, card 2). The operation's precondition: a move's
   * thing is already in the frame, and that is the whole difference from an add. Never falls back to
   * one — see `moveRegion`.
   */
  | "move_target_absent"
  /**
   * A MOVE whose thing detection found TWICE — two balls, one noun. Which she meant is not guessed.
   * Distinguishing them needs per-instance targeting, which the single-noun target model does not
   * have; ledger F-WB3.
   */
  | "ambiguous_move"
  /** An operation that needs a value (design, replacement, place, look) was classified without one. */
  | "missing_value"
  /**
   * A region-free edit (an add) with STUDIO_NATIVE_EDIT off. There is no masked add and no other
   * path it may take, so it blocks — the fail-closed pattern PR N uses for a flag-off frozen intent.
   */
  | "native_edit_off"
  /**
   * An add with more than one OBJECT photo attached. One thing is added at a time, and which photo
   * is that thing is not guessed — the sentence names one thing, the tray holds two.
   *
   * And its mirror since composition (decision 4): two ADDS with an object photo attached. The tray
   * holds one photo, the sentence names two things, and which of them the photo shows is not guessed
   * either. `adds` says which case it is, so the note can be true of it.
   *
   * And since replace with reference, the same two answers for a replacement she pointed at a photo
   * for: two photos for one, or one photo read by it and by another change (an add, or a second
   * pointed replacement). `replaces` says so, so the note does not talk about adding.
   */
  | "ambiguous_object"
  /**
   * A replacement she pointed at her photo for ("change my earrings to these gold hoops") on any arm but
   * a derived native one — the flag off, or a box she drew. Only the native compile names her photo in
   * the instruction; the masked stack re-reads her sentence into each crop's label and the photo rides
   * along unaddressed. It blocks, the fail-closed pattern an add and a dropped word use.
   */
  | "reference_off_native"
  /**
   * A sentence rule ½ COMPOSED (classify.ts), on any arm but a native one — the flag off, or a box
   * she drew. On the masked stack detection re-reads her whole sentence into each crop's label and
   * the classifier's per-clause steps are ignored, so none of composition's guarantees hold there
   * (decision 6a). It blocks, the fail-closed pattern an add and a dropped word use.
   */
  | "compound_off_native"
  /**
   * A headline (PR T, DISPLAY_TEXT) on any arm but a native one — in practice a box she drew, since a lone
   * headline is otherwise region-free. Only the native compile writes it as q6-t1's banner across the top
   * of the frame; the masked stack would crop her box, send her sentence as the crop's direction and
   * composite the result back — semantics the template never anticipated. It blocks, the fail-closed
   * pattern `reference_off_native` uses.
   */
  | "text_off_native"
  /**
   * Constraints handed to the freeze that are not exactly the closed shapes an intent may carry
   * (studio/nativeEdit.ts, `EditConstraint`) — or the same one twice. Only our own code writes them
   * (the interpreter, I.1), so this is a defect caught, never her sentence refused; it blocks rather
   * than freezing the changes without the conditions she was shown.
   */
  | "invalid_constraints"
  /**
   * A brand change that DROPPED words she typed (B.1c) — "Nike Mercurials" as nike cleats — on any
   * arm but a derived native edit. Only the native compile honours the drop: on the masked stack,
   * detection re-reads her whole sentence into each crop's label, the dropped word reaches the model,
   * and no disclosure is shown. So it blocks, the fail-closed pattern an add uses with the flag off.
   */
  | "dropped_words_off_native";

export type FreezeResult =
  | { ok: true; intent: FrozenEditIntent }
  | {
      ok: false;
      reason: FreezeRefusalReason;
      askReason?: string;
      /** `ambiguous_object` only: how many things the sentence adds, when it is more than one. */
      adds?: number;
      /** `ambiguous_object` only: how many replacements point at her photo, when any do. */
      replaces?: number;
      /**
       * `ambiguous_object` only: how many PRODUCT photos stood where an Object photo would have (C3) — present
       * exactly when no Object photo was attached and it was her product photos the add could not choose between.
       */
      products?: number;
    };

/**
 * How many PLACEABLE photos a request carries — `route`'s `attached`, read off the references by ROLE
 * (R's contract), never by position. The freeze and the spend-time re-check read the brief's own,
 * server-resolved list; the preview route reads the list it is about to resolve, the same one.
 *
 * ─── ⚠️  THIS IS THE ONE DEFINITION. CARD 4 SHIPPED BROKEN BECAUSE IT WAS NOT. ──────────────────
 *
 * The count used to be `role === "object"` alone. Card 4 taught the FREEZE that her Product photo
 * stands where an Object photo would, and moved the two gates inside `freezeEditIntent` — but the
 * ROUTE counts with THIS function, and this one still said zero. So a live Product-tile replacement
 * asked at the entry and the composer fell back to a GENERATE: "1 of 1 frames invented", with only
 * the PRODUCT in BUILT FROM and her frame gone.
 *
 * The first proof missed it because it was a constructed call straight into the freeze, which never
 * touches this function. A fix proved below the entry point is not proved.
 *
 * So the rule lives here, once, and the freeze reads it rather than repeating it:
 *
 *   her Object photos, or — when the Object tile is EMPTY — her Product photos.
 *
 * Never both added together: two tiles holding one thing each is one thing, not two, and an add
 * already resolves the same way (C3, `placeable`).
 */
export function attachedIn(
  references: readonly { role: string }[] | null | undefined,
): Attached {
  const refs = references ?? [];
  const objects = refs.filter((r) => r.role === "object").length;
  // PR 19 (B): her Style references, for the look pointer. Only when there is one, so every other count keeps its
  // exact shape. The role is the engine's (`style_reference`, studio/reference/styleSpec.ts).
  const styles = refs.filter((r) => r.role === "style_reference").length;
  return {
    objects: objects || refs.filter((r) => r.role === "product").length,
    ...(styles ? { styles } : {}),
  };
}

/** Lowercased words, punctuation dropped — the space labels and targets are compared in. */
const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9#\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Singular and plural name one garment: "sock" and "socks", "shoe" and "shoes". */
const sameWord = (a: string, b: string): boolean =>
  a === b || a === `${b}s` || b === `${a}s` || a === `${b}es` || b === `${a}es`;

const ARTICLES = new Set(["a", "an", "the"]);

/**
 * The words of `label` before a trailing `target` — the colour, from "black and green shorts" — or
 * null when the label does not end with the target, or is nothing but the target.
 */
export function changeBefore(label: string, target: string): string | null {
  const l = words(label);
  const t = words(target);
  if (!t.length || l.length <= t.length) return null;
  const tail = l.slice(l.length - t.length);
  if (!tail.every((w, i) => sameWord(w, t[i]))) return null;
  const head = l.slice(0, l.length - t.length);
  while (head.length && ARTICLES.has(head[0])) head.shift();
  return head.length ? head.join(" ") : null;
}

/**
 * Does this region label NAME this target — "the soccer ball", "soccer ball", "ball"? (wave B, card 2)
 *
 * `changeBefore` answers the recolour's question, which is the opposite one: what the label says BESIDE
 * the target ("black and green" from "black and green shorts"), and it returns null when the label is
 * nothing but the target. A move asks only whether detection found the thing at all, so it accepts both
 * — the bare noun and the noun with words in front of it.
 */
function namesTarget(label: string, target: string): boolean {
  const l = words(label);
  const t = words(target);
  if (!t.length || l.length < t.length) return false;
  // ⚠️ THE LABEL MAY BE MORE SPECIFIC THAN HER WORD, AND USUALLY IS. Detection is asked for the
  // CONCRETE noun — "soccer ball" for the ball at her feet, "crop top" for what she called a jersey
  // (studio/autoMask.ts, `samNoun`) — so requiring the head to be nothing but articles refused the
  // ordinary case: her "ball" against a region labelled "the soccer ball".
  //
  // Ending with the target is the right test for this question, and its over-match is the behaviour
  // we want: a frame holding "soccer ball" AND "beach ball" matches her "ball" twice, which is
  // `ambiguous_move` — two of the thing, exactly as it should read.
  return l.slice(l.length - t.length).every((w, i) => sameWord(w, t[i]));
}

/**
 * The ONE region a move's thing is, or why it is not a move (wave B, card 2).
 *
 * ─── ⚠️ A MOVE THAT CANNOT FIND ITS THING IS NOT A MOVE, AND MUST NEVER BECOME AN ADD ──────────
 *
 * This is the whole difference between the two operations: an add's thing is not in the frame, a
 * move's is. So the evidence that it IS there — a detection region naming it — is not a nicety, it is
 * the operation's precondition. The failure this guards is the one ledger F-WA6 names and the reason
 * G1 refused to read a move as an add at all: run a move with nothing found and the model is told to
 * move a thing that is not there, which is how a SECOND one gets put down.
 *
 * Three answers, and the two refusals are deliberate rather than conservative:
 *
 *   none      `move_target_absent`. Detection ran and found nothing by that name — a mis-detection, a
 *             stale region set, or a thing she named that is not in this photograph. Falling back to an
 *             add here would be exactly the two-balls outcome; falling back to a full-frame move with
 *             no region would be asking the model to guess which thing she meant. She is asked instead.
 *   several   `ambiguous_move`. Two balls, and her noun names both. WHICH one she meant is not guessed —
 *             the same rule as two adds beside one photo (`ambiguous_object`), and the same reason.
 *             Ledger F-WB3: distinguishing them needs per-instance targeting, which the single-noun
 *             target model does not have.
 *   one       that region. The move runs.
 */
function moveRegion(
  target: string,
  regions: readonly EditRegion[],
): { ok: true; assumed?: boolean } | { reason: FreezeRefusalReason } {
  // ⚠️ BOTH FIELDS, AND READING ONLY THE LABEL WAS A BUG (ledger F-WB5, found in acceptance).
  //
  // `label` is the DIRECTIVE — `labelFor(directiveOf(e) ?? instruction)`, which is autoMask's own
  // multi-target fix — while the CONCRETE noun detection proposed lives in `samNoun`. So a frame whose
  // region is labelled with her move phrase and whose `samNoun` is exactly "soccer ball" was not found,
  // and the move refused on a photograph that plainly held the ball.
  //
  // The recolour path hides the same mistake and is why it went unnoticed: a recolour's directive
  // happens to END with the noun ("make the socks blue" → "blue socks" → ends with "socks"), so
  // label-matching is coincidentally right there and structurally wrong here.
  const found = regions.filter(
    (r) => namesTarget(r.label, target) || namesTarget(r.samNoun ?? "", target),
  );
  if (found.length === 1) return { ok: true };
  if (found.length > 1) return { reason: "ambiguous_move" };

  // ─── (d) THE CANDIDATE BY ELIMINATION — Adi, 2026-09-17, after acceptance (ledger F-WB5) ──────
  //
  // Nothing NAMES her thing. That was a refusal, and on the live frame it refused a move on a
  // photograph that plainly held the ball: detection returned one object-scope box and proposed no
  // `samNoun` at all (`found:1 scopes:["object"] nouns:[{reason:"absent"}]`).
  //
  // A missing noun is a MASK-QUALITY fact, not an identity one. `EditRegion`'s own doc says so: the
  // field "exists only to be handed to SAM-3" and its absence is "a supported state rather than a
  // gap". We know WHERE the thing is — we have the box, and the preview draws it — we merely lack the
  // word the segmenter would have tightened the mask with. Detection was ASKED for her thing, so one
  // box with no noun to confirm is evidence about her thing.
  //
  // ⚠️ "EXACTLY ONE" IS THE TWO-BALLS GUARD AND IT IS KEPT: two unnamed candidates still ask
  // `ambiguous_move`, and a frame with no regions at all still asks `move_target_absent`. What (d)
  // gives up is narrower and is named in the test: a region that named something ELSE used to refuse
  // by accident, because nothing distinguishes "no noun proposed" from "a noun that is not hers" on
  // the frozen record — `samNoun` is `undefined` for both (its own doc: "today the two are
  // indistinguishable downstream"). So the assumption is DISCLOSED rather than silent.
  //
  // ⚠️ AND THE DISCRIMINATOR IS `subjectNoun`, NOT SCOPE, because the frozen region has no `scope`:
  // it carries the label, the box, `samNoun?` and `subjectNoun?` and nothing else. Background is the
  // only other scope, `parseAutoMask` sets `subjectNoun` on it by construction, and the two nouns are
  // never set together — so "no subjectNoun" IS "object scope", with no new field and no migration.
  const unnamed = regions.filter((r) => !r.subjectNoun && !r.samNoun?.trim());
  if (unnamed.length === 1) return { ok: true, assumed: true };
  if (unnamed.length > 1) return { reason: "ambiguous_move" };
  return { reason: "move_target_absent" };
}

/**
 * A recolour target's change, from the one region label that is its own.
 *
 * ⚠️ THE COLOUR COMES FROM THE LABEL AND NOT FROM `step.value`, WHICH IS RIGHT AND WAS ALSO A TRAP.
 * "make the jersey red and the shorts black" carries ONE step with two targets and one value, so
 * `value` alone would give the shorts red too; the per-target colours are on detection's labels
 * ("red jersey", "black shorts").
 *
 * ⚠️ THE LABEL IS NO LONGER THE ONLY PLACE THE PAIRING LIVES (wave D, card 2). Where SHE paired a
 * colour to every target, the step carries `values` and the call site prefers it — see the branch
 * above. This function is reached for that sentence only when she did NOT pair, which is what it was
 * always written for; it is unchanged, and so is the `sole` guard below.
 *
 * ⚠️ AND IT IS NOT CONSULTED AT ALL FOR A PRONOUN-RESOLVED CLAUSE — see the `fromPronoun` branch at
 * the call site. A label's "change" is whatever precedes the target in the directive, so on the live
 * sentence the brand clause's own labels paired "adidas" as the RECOLOUR's colour for shoes and socks
 * ("adidas shoes" → "adidas"), and "uniform" paired nothing at all because detection had expanded it
 * into a jersey and shorts. Falling back only when nothing paired would therefore have recoloured two
 * garments "adidas" and been worse than the refusal it replaced.
 */
function recolourChange(
  target: string,
  regions: readonly EditRegion[],
  spoken: string | null = null,
  sole = false,
  said: string | null = null,
): { change: string } | { reason: FreezeRefusalReason } {
  const changes = [
    ...new Set(
      regions
        .map((r) => changeBefore(r.label, target))
        .filter((c): c is string => c !== null),
    ),
  ];
  // ─── K9: HER COLOUR, NOT THE DETECTOR'S (PR 19, STUDIO_IMAGE_OPS; `said` is set only with the flag on) ──────
  //
  // "make my jersey teal" compiled the detection LABEL's colour ("blue jersey" → "blue"): the label wins whenever it
  // pairs, below. For a single target she gave a colour to, a label now wins only where it says nothing she did not
  // — every word of it is one of hers, and it holds her whole colour. F-WB7's "black and green shorts" still wins
  // over her "black" (she said all three words); "blue" never wins over her "teal", nor "blue" over her "navy blue".
  // Anything else is her colour, verbatim from the step. ⚠️ MUTATION M-K9: prefer the label unconditionally.
  if (said !== null && sole && spoken?.trim()) {
    const hers = words(spoken);
    const saidWords = new Set(words(said));
    const fair = changes.filter((c) => {
      const w = words(c);
      return (
        w.every((x) => saidWords.has(x)) && hers.every((x) => w.includes(x))
      );
    });
    return { change: fair.length === 1 ? fair[0] : spoken.trim() };
  }
  if (changes.length === 1) return { change: changes[0] };
  // ─── HER WORD, WHEN NOTHING PAIRED AT ALL — F-WB7, pre-existing (the deep sweep, 2026-09-17) ────
  //
  // "add hoops to my ears and make my jersey red" refused `unpaired_directive` WITH THE JERSEY
  // DETECTED: routing was right and detection's directive for that box carried no colour, so nothing
  // paired. Bisected across pre-wave-A `29b2fc8`, main `7d12dbc` and this tip — identical on all
  // three, so it is pre-existing and not wave B's.
  //
  // ⚠️ A FALLBACK AND NOT AN OVERRIDE, AND THE DIFFERENCE IS MEASURED. The first attempt at this let
  // her word win whenever a step had ONE target, and it turned 8 cells red — because the label
  // legitimately carries MORE than she typed: "make the shorts black and green" pairs "black and
  // green" off the label while `value` is "black", and that fuller string is Q5's MEASURED prompt.
  // The label wins whenever it pairs. Her word is only for the case where there is nothing to lose.
  //
  // ⚠️ AND AMBIGUITY IS STILL AMBIGUITY. Two different directives on one target is a question her
  // single word cannot answer, so it still refuses. This fires only when the pairing found NOTHING.
  //
  // ⚠️ AND ONLY FOR A SINGLE-TARGET STEP — `sole`. This is the second condition and jest is what put
  // it there: sweep 3.1's guard is "make the jersey red and the shorts black" with detection writing
  // the bare colours ["red", "black"], which pair to NO target. That is ONE step, targets
  // [jersey, shorts], value "red" — so a fallback on her word would have given the jersey red and
  // THE SHORTS RED TOO, which is the exact defect that guard exists for. Her one word cannot be
  // distributed across several targets, so where there are several, an unpaired target still refuses.
  if (sole && !changes.length && spoken?.trim()) return { change: spoken.trim() };
  return {
    reason: changes.length ? "ambiguous_directive" : "unpaired_directive",
  };
}

/**
 * Classify her sentence and freeze the answer — or say precisely why it cannot be frozen.
 *
 * Pure: no network, no spend. `regions` are the ones detection derived from this same sentence and
 * the route has already frozen onto `source`; a recolour reads their labels and nothing else does.
 */
export function freezeEditIntent(input: {
  ask: string;
  origin: BriefOrigin;
  source: SourceAsset;
  /**
   * Her tagged references, server-resolved (routes/studio.ts, resolveReferences). An add reads its
   * `object` one — the photograph of the thing she wants put in the frame — or, with none, her one
   * `product` photo (C3); a replacement she pointed at a photo for ("these gold hoops") reads the
   * `object` one alone, and the classifier counts those. Nothing else reads these.
   */
  references?: readonly JobReference[];
  /**
   * Conditions on the whole edit, beside her changes (the interpreter, I.1): "keep me as I am", "no nike
   * logos anywhere". Frozen verbatim in canonical order, and they make the intent VERSION 2 — so an
   * instance that predates them refuses it rather than running the changes without them. Absent or empty,
   * the intent is version 1 and byte-identical to one frozen before constraints existed. They never touch
   * `ask`, `route` or a change: C carries the changes, and these ride beside it.
   */
  constraints?: readonly EditConstraint[];
}): FreezeResult {
  const { ask, origin, source } = input;
  if (origin !== "system") return { ok: false, reason: "untrusted_origin" };
  if (!ask.trim()) return { ok: false, reason: "no_ask" };
  if (!source.width || !source.height) {
    return { ok: false, reason: "unmeasured_source" };
  }
  const passed = canonicalConstraints(input.constraints ?? []);
  if (!passed) return { ok: false, reason: "invalid_constraints" };

  // THE OBJECT PHOTO, by ROLE — R's contract. The Object tile, or a second photo she resolved to
  // "object" when it was attached; never her own media, and never array position. Counted before the
  // classifier runs, because a sentence pointing at a photo reads differently with none attached.
  const objects = (input.references ?? []).filter((r) => r.role === "object");
  // ─── HER PRODUCT PHOTO IS THE THING, WHEN NO OBJECT PHOTO IS ATTACHED (C3; Adi's (c), 2026-09-17) ───────
  //
  // "add a water bottle from image 2" is one edit whichever tile the bottle went in, and she cannot be expected
  // to know the two tiles differ. So with no Object photo, her one Product photo is what an add places — bound
  // automatically, and said so before she pays (studio/compile/disclosure.ts, `placedProductNote`), because a
  // product photo of something else would otherwise be caught only in the render. One, as one Object photo is
  // one: two, and which of them is the thing is not guessed.
  //
  // ⚠️ AN ADD'S AND A POINTED REPLACEMENT'S (card 4 promotes the second; C3 shipped the first). Never a
  // brand's pieces: those are `brief.brand`'s material, not her references, and never reach here.
  //
  // The COUNT this resolves to is `attachedIn`'s, read below rather than recomputed — they agreed the
  // first time too, and the route did not, which is how card 4 shipped broken.
  const products = objects.length
    ? []
    : (input.references ?? []).filter((r) => r.role === "product");
  const placeable = objects.length ? objects : products;
  // ─── WHY `route` IS TOLD THE PLACEABLE COUNT, NOT THE OBJECT COUNT (card 4) ────────────────────────
  //
  // "replace the earrings with these gold hoops", hoops in the PRODUCT tile, asked her to attach them with
  // the Object tile — the photo she wanted used was already in the request. A product of hers worn in place
  // of what she has on is product placement, which is the thing the Product tile is FOR.
  //
  // The whole change is this argument: `attached.objects` is read in exactly ONE place in the classifier —
  // the `object_photo_missing` gate — and `reference: "object"` is set by exactly ONE rule, 3½. So handing
  // the placeable count in can reach a pointed replacement and NOTHING else: not an add, not a removal, not
  // a background, a look or a brand change. An add's behaviour is unmoved by construction, not by luck.
  //
  // `placeable` is already "the Object tile, or her Product photos when it is empty", and already refuses
  // two of either (`ambiguous_object` below). A replacement inherits that arithmetic rather than repeating it.
  const routed = route(ask, true, attachedIn(input.references));
  if (routed.initialPath === "ASK") {
    return { ok: false, reason: "not_routed", askReason: routed.reason };
  }
  if (routed.steps.some((s) => s.op === "GENERATE")) {
    return { ok: false, reason: "generate_on_edit" };
  }

  // HER KEEP, WHEN THE RULES READ IT BESIDE A SENTENCE THAT ROUTES (A3b; classify.ts, `route`): the same
  // `preserve_person` the interpreter hands in, frozen the same way — version 2, canonical order — and once,
  // whichever door it came through. The interpreter's C never carries a keep, so today they never meet.
  const ruled = (routed.constraints ?? []).filter(
    (c) => !passed.some((p) => p.kind === c.kind),
  );
  const constraints = ruled.length
    ? canonicalConstraints([...passed, ...ruled])
    : passed;
  if (!constraints) return { ok: false, reason: "invalid_constraints" };

  // THE ECHO RULE, checked before any label is paired: a recolour never rests on a detection pass
  // that fell back to her sentence, even when some other region's directive would have paired.
  //
  // ⚠️ SINCE COMPOSITION, "HER SENTENCE" IS WHAT DETECTION WAS GIVEN (decision 3). For a composed
  // sentence that is its region-bearing clauses, not the whole — so the fallback label is THOSE
  // words, and a check against the whole sentence alone would wave the echo through as a colour
  // ("make blue the socks" pairs "make blue the"). Both are checked; for every other sentence they
  // are one string.
  const recolours = routed.steps.some((s) => s.op === "RECOLOR");
  const detected = detectionTextFor(ask, { objects: objects.length });
  const echoes = new Set([
    labelFor(ask),
    ...(detected ? [labelFor(detected)] : []),
  ]);
  if (recolours && source.editRegions.some((r) => echoes.has(r.label.trim()))) {
    return { ok: false, reason: "echoed_directive" };
  }

  // ─── TWO ADDS AND AN OBJECT PHOTO: WHICH THING IT SHOWS IS NOT GUESSED (composition, decision 4) ─
  //
  // A composed sentence can add two things ("add a ball on the bench and add a bottle on the
  // grass"). With no photo both are invented and it runs (4a). With one, the loop below would hand
  // that photo to EVERY add — a ball photo pasted in as the bottle too — so it refuses first, the
  // same answer a lone add with two photos gets.
  //
  // Her product photo standing where an Object photo would (C3) is the same one photo, so it asks the same way.
  const adds = routed.steps.filter((s) => s.op === "ADD_OBJECT").length;
  if (adds > 1 && placeable.length) {
    return {
      ok: false,
      reason: "ambiguous_object",
      adds,
      ...(products.length ? { products: products.length } : {}),
    };
  }
  // ─── AND A REPLACEMENT SHE POINTED AT HER PHOTO FOR READS IT TOO (replace with reference) ─────────
  //
  // "add a ball on the bench and change my earrings to these gold hoops", one photo: the loop below
  // would hand it to the add AND to the replacement, a hoops photo pasted in as the ball. So would two
  // pointed replacements. Which change the photo is for is not guessed — the same answer as two adds.
  const replaces = routed.steps.filter((s) => s.reference === "object").length;
  if (replaces && adds + replaces > 1 && objects.length) {
    return {
      ok: false,
      reason: "ambiguous_object",
      replaces,
      ...(adds ? { adds } : {}),
    };
  }

  const changes: NativeChange[] = [];
  for (const step of routed.steps) {
    switch (step.op) {
      case "RECOLOR":
        for (const [i, target] of step.targets.entries()) {
          // ─── A PRONOUN-RESOLVED COLOUR IS HERS, AND THE LABELS ARE THE OTHER CLAUSE'S (F-WB6) ──────
          //
          // Live 2026-09-17: "make my uniform, shoes and socks adidas. make them the color blue too."
          // routed correctly and the freeze refused `unpaired_directive`, because a recolour's colour is
          // re-derived from detection's LABEL and she had said the colour once, about things named in
          // the clause before — so detection was never asked for a colour on any of them.
          //
          // ⚠️ AND A FALLBACK WOULD NOT HAVE BEEN ENOUGH. `changeBefore` returns whatever precedes the
          // target in the label, so the BRAND clause's labels paired "adidas" as this recolour's colour
          // for shoes and socks ("adidas shoes" → "adidas"), while "uniform" paired nothing because
          // detection had expanded it into a jersey and shorts. Consulting the labels at all is the bug
          // here: for this clause her word is the only place the colour exists, and the labels belong to
          // a different clause. So they are not consulted.
          if (step.fromPronoun && step.value?.trim()) {
            changes.push({ op: step.op, target, change: step.value.trim() });
            continue;
          }
          // ─── AND WHERE SHE PAIRED A COLOUR TO EACH THING, THAT PAIRING IS HERS (wave D, card 2) ─────
          //
          // "make the jersey red and the shorts black" blocked the real preview with the rephrase line,
          // because the per-target colours lived ONLY on detection's labels and detection wrote the bare
          // colours ["red", "black"], which pair to no target. She had named every colour explicitly and
          // was asked to say it again (acceptance B13, H5, R6).
          //
          // ⚠️ AHEAD OF THE LABELS, FOR THE SAME REASON `fromPronoun` IS — "consulting the labels at all
          // is the bug here". Where her sentence pairs, the label can only agree with her, restate her
          // more loosely, or be wrong; none of those is worth preferring over the words she typed. The
          // classifier sets `values` only when EVERY target got a colour of its own and none of them ran
          // on into a second colour (`perTargetColours`), so the label keeps every case where it is the
          // richer reading — F-WB7's "black and green" among them.
          //
          // ⚠️ AND IT CHANGES NOTHING WHERE SHE PAIRED NOTHING. `values` is absent on every other
          // sentence, and the two lines below are then exactly what they were.
          const hers = step.values?.[i]?.trim();
          if (hers) {
            changes.push({ op: step.op, target, change: hers });
            continue;
          }
          // Her colour as the last resort, never ahead of a directive that paired (F-WB7).
          const found = recolourChange(
            target,
            source.editRegions,
            step.value ?? null,
            step.targets.length === 1,
            // K9 (PR 19): her words, so a label may only ever say what she said.
            imageOpsEnabled() ? (routed.readAs ?? ask) : null,
          );
          if ("reason" in found) return { ok: false, reason: found.reason };
          changes.push({ op: step.op, target, change: found.change });
        }
        break;
      case "APPLY_DESIGN":
      case "REPLACE_OBJECT":
        if (!step.value?.trim()) return { ok: false, reason: "missing_value" };
        // ─── WHAT SHE POINTED AT IS HER PHOTO, FROZEN BY ITS ASSET ID (replace with reference) ────────
        //
        // "these gold hoops" is the photo she attached — the Object tile, or her one PRODUCT photo when
        // the Object tile is empty (card 4). The replacement carries that photo's id and the compile
        // names its image. One photo, as an add takes one: two, and which one she meant is not guessed.
        // None is unreachable — `route` asked, with the same count, above.
        //
        // ⚠️ THIS IS A SECOND GATE ON THE SAME QUESTION and it must move with the first. Card 4 changed
        // `route`'s count and this kept reading `objects`, so a Product-tile replacement routed and then
        // refused HERE with the same code — a refusal that no longer matched the rule that produced it.
        if (step.reference === "object") {
          if (!placeable.length) {
            return {
              ok: false,
              reason: "not_routed",
              askReason: "object_photo_missing",
            };
          }
          if (placeable.length > 1) {
            // `products` rides along when it is HER PRODUCT photos that are ambiguous, so the note can
            // name the tile she actually used. Without it the answer says "object photo" about two
            // photos in the Product tile — advice she has already followed (card 4; C3 does the same
            // for an add).
            return {
              ok: false,
              reason: "ambiguous_object",
              replaces: 1,
              ...(products.length > 1 ? { products: products.length } : {}),
            };
          }
        }
        for (const target of step.targets) {
          changes.push({
            op: step.op,
            target,
            change: step.value,
            ...(step.reference === "object"
              ? { object: { objectAssetId: placeable[0].mediaAssetId } }
              : {}),
            // K33 (PR 19): the unlisted brand, in her words, for the compile to fence.
            ...(step.brand ? { fenced: step.brand } : {}),
          });
        }
        break;
      case "REMOVE_OBJECT":
        for (const target of step.targets) {
          changes.push({ op: step.op, target, change: null });
        }
        break;
      case "MOVE_OBJECT": {
        // The thing is the step's first target and the destination is its value — rule 4¾ writes them
        // there, exactly as rule 4½ does for an add. The other targets are the surfaces the guard read.
        const [thing] = step.targets;
        if (!thing?.trim() || !step.value?.trim()) {
          return { ok: false, reason: "missing_value" };
        }
        // ⚠️ THE THING MUST BE IN THE FRAME, PROVEN BY DETECTION — the operation's precondition, not a
        // check on it. See `moveRegion` for why neither failure falls back to an add.
        const region = moveRegion(thing, source.editRegions);
        if ("reason" in region) return { ok: false, reason: region.reason };
        changes.push({
          op: step.op,
          target: thing,
          change: null,
          to: step.value,
          // Only when the thing was taken by elimination (F-WB5 (d)). Absent on every move whose
          // region NAMED her thing, and on every brief frozen before this existed.
          ...(region.assumed ? { assumedTarget: true } : {}),
        });
        break;
      }
      case "CHANGE_BACKGROUND":
      case "GLOBAL_STYLE":
      // PR 19: a relight's member and a camera's angle, read by the rules from a closed vocabulary — no region.
      case "RELIGHT":
      case "CAMERA":
      case "CROP":
      // The ad's brand logo: its value is the brand, from the rules' own list — no region.
      case "BRAND_MARK":
      // A headline's value is its words, which the classifier bounded and uppercased (PR T): nothing
      // comes from a region label, because a headline has none — detection never ran for one.
      case "DISPLAY_TEXT":
        // A background step's only target is the person it KEEPS, so it compiles to no target.
        if (!step.value?.trim()) return { ok: false, reason: "missing_value" };
        changes.push({
          op: step.op,
          target: null,
          change: step.value,
          // W-3: text she placed, in her words, fenced by the compile. Absent on every rule ⅛ headline.
          ...(step.placement ? { placement: step.placement } : {}),
          ...(step.fencedText ? { fenced: step.value } : {}),
        });
        break;
      case "ADD_OBJECT": {
        // The thing is the step's first target and the place is its value — rule 4½ writes them
        // there (the other targets are the surfaces the guard read). Nothing comes from a region
        // label: an add has no region, and detection never ran.
        const [thing] = step.targets;
        if (!thing?.trim() || !step.value?.trim()) {
          return { ok: false, reason: "missing_value" };
        }
        if (objects.length > 1)
          return { ok: false, reason: "ambiguous_object" };
        if (products.length > 1) {
          return {
            ok: false,
            reason: "ambiguous_object",
            products: products.length,
          };
        }
        // ─── `put` DECIDES HERE, AND NEVER FALLS INTO AN ADD ON A DETECTION MISS (D1, F-WB5 (d)) ────
        //
        // Live 2026-09-17, tapped: "put the ball on the ground" planned as an ADD and rendered a SECOND
        // ball, on a frame that already held two — `placedAdds: ["ball"]` in the QA line is the proof,
        // and she paid $0.271 for it. Detection had returned one region with its noun `absent`, so
        // nothing named her thing, and `put` took rule 4½'s add unchanged. (d) already answers exactly
        // that question for a move; it simply was not reached from here, because the add path never
        // called `moveRegion`. Now it does.
        //
        // ⚠️ AN OBJECT PHOTO SETTLES IT THE OTHER WAY, AND THAT IS WHY THIS IS NOT ONLY ABOUT THE VERB.
        // "put the gatorade bottle from image 2 on top of my head" names its source out loud — the
        // thing is not in the photograph, she has handed it to us, and it is an insertion however the
        // frame looks. So a bound placeable photo keeps the add, and only a bare `put` asks the frame.
        //
        // ⚠️ AND IT IS BEHIND `STUDIO_MOVE_OBJECT`. `put` becoming a move is card 2's operation arriving
        // by another door; with the flag off this is byte-identical to the add it has always been.
        if (moveObjectEnabled() && step.fromPut && !placeable.length) {
          const region = moveRegion(thing, source.editRegions);
          if ("reason" in region) return { ok: false, reason: region.reason };
          changes.push({
            op: "MOVE_OBJECT",
            target: thing,
            change: null,
            to: step.value,
            ...(region.assumed ? { assumedTarget: true } : {}),
          });
          break;
        }
        changes.push({
          op: step.op,
          target: null,
          change: null,
          add: {
            thing,
            place: step.value,
            objectAssetId: placeable[0]?.mediaAssetId ?? null,
            // R-22 (PR 19): the brand she named on the thing, fenced as data by the compile.
            ...(step.brand ? { brand: step.brand } : {}),
          },
        });
        break;
      }
      case "GENERATE":
        return { ok: false, reason: "generate_on_edit" };
    }
  }
  if (!changes.length) return { ok: false, reason: "unpaired_directive" };

  return {
    ok: true,
    intent: {
      // Version 2 exactly when constraints ride along (studio/nativeEdit.ts, `FrozenEditIntent.version`).
      version: constraints.length ? 2 : 1,
      initialPath: routed.initialPath,
      steps: routed.steps,
      // In the compile tier's order — background, then a headline, then a look, last (studio/compile/order.ts).
      changes: sceneLast(changes),
      imageSize: smallestImageSizeFor(source.width * source.height),
      ...(constraints.length ? { constraints } : {}),
    },
  };
}

// ─── The refusal, in words she can act on ───────────────────────────────────────────────────────

const REPHRASE =
  'We couldn\'t pin down exactly what to change from that. Name the thing and what it should become — like "make the socks blue and green".';

/**
 * A new image asked for on a photo — the freeze's refusal of a GENERATE on an edit (`generate_on_edit`), and the
 * interpreter's `new_image` answer (interpret/5, sweep-4 ledger F-I6). One meaning, one line, word for word.
 * ⚠️ PLACEHOLDER WORDING for `new_image`, the copy-review pile (Mia).
 */
const NEW_IMAGE_NOTE =
  "That asks for a new picture of you, not a change to this photo — start a new image instead.";

/**
 * The asks with a line of their own, in the client's own words (client/lib/studio-contract.ts,
 * askCopyFor): the three only a compound gets (classify.ts, `compose`), and since guard scope a
 * condition the classifier does not read (rule ¼).
 */
const ASK_NOTES: ReadonlyMap<string, string> = new Map([
  // A sentence pointing at a photo with none attached (replace with reference, classify.ts `route`).
  [
    "object_photo_missing",
    'Attach a photo of the thing you want with the Product or Object tile — or describe it instead, like "make my earrings gold".',
  ],
  [
    "conditional",
    'We can\'t do "if" yet — tell us the change directly, like "remove the nike logo".',
  ],
  // A worn add whose only problem is the words of its thing (classify.ts, PR M3.8).
  [
    "worn_add_unclear",
    'Say the item plainly and where it goes — "add gold hoops to my ears".',
  ],
  // A headline in rule ⅛'s shape whose words are out of bounds (classify.ts, PR T, N8).
  [
    "headline_bounds",
    "A headline can be up to four words and 24 characters, in plain letters and numbers, and can't use a brand's name or slogan. Try another line of your own.",
  ],
  // A look she named that we do not have (classify.ts, the style vocabulary V.4).
  [
    "look_unknown",
    "That look isn't one we know yet — try warmer, moodier, cinematic, vintage or black and white.",
  ],
  [
    "compound_partial",
    "We can do a few changes at once, but couldn't follow one part of that. Try each change on its own to find the part that needs rewording.",
  ],
  [
    "too_many_changes",
    "That's more than four changes in one go — split it into two edits.",
  ],
  // A keep of a thing her change would alter (classify.ts, K2). ⚠️ PLACEHOLDER WORDING, the copy-review pile.
  [
    "keep_conflict",
    "A look or a new background covers the whole photo, so it can't leave that part untouched. Name just the thing to change — \"make the socks blue\" — and everything you don't name stays as it is.",
  ],
  [
    "compound_conflict",
    "That asks for two things that can't both happen — two backgrounds, two looks, or a change to something it also removes. Pick the one you want and try again.",
  ],
  // The ad's own asks (studio/interpret/ad.ts and core.ts, the interpreter, I.4). v1 §3's wording where it
  // gave one; Mia signs the copy off. It says WHERE, because Create anything has no brand picker (M5).
  [
    "ad_needs_brand",
    "An ad for which brand? Name it — 'turn this into an adidas ad' — or start from Brand post and pick it.",
  ],
  [
    "ad_brand_mismatch",
    "That ad names a different brand from the one you picked, or more than one. Name the one brand it's for.",
  ],
  [
    "ad_too_many_changes",
    "Your changes plus the kit swap this ad needs come to more than four. Ask for fewer changes of your own, or make some first as their own edit.",
  ],
  // She asked for a new picture of her, not an edit of this photo — the interpreter's answer, never a route code.
  ["new_image", NEW_IMAGE_NOTE],
]);

/** The blocking note a refused freeze puts on her preview. Hers to read, so it names no internals. */
export function freezeRefusalNote(
  refusal: Extract<FreezeResult, { ok: false }>,
): string {
  switch (refusal.reason) {
    case "not_routed":
      // `person_mentioned` is the fall-through's name for the same answer (classify.ts,
      // declineReason) — a sentence naming only her body gets the refusal, not the rephrase.
      if (
        refusal.askReason === "person_target" ||
        refusal.askReason === "person_mentioned"
      ) {
        return "Studio doesn't change a person's face or body. Name something you're wearing or holding instead.";
      }
      // A sentence of several changes that still asks (classify.ts, rule ½). The rephrase would tell
      // her to name a thing — she named several. The client's lines for the same codes, verbatim
      // (client/lib/studio-contract.ts, askCopyFor), so the preview and the ask say the same thing.
      return ASK_NOTES.get(refusal.askReason ?? "") ?? REPHRASE;
    case "generate_on_edit":
      return NEW_IMAGE_NOTE;
    case "echoed_directive":
    case "unpaired_directive":
    case "ambiguous_directive":
    case "missing_value":
      return REPHRASE;
    // ─── THE TWO MOVE REFUSALS, EACH SAYING WHAT SHE CAN DO ABOUT IT (wave B, card 2) ───────────
    //
    // Neither line mentions detection, a region or a model, and each names the one thing she can
    // change. `move_target_absent` is as card 2 shipped it; `ambiguous_move` is Adi's wording, below.
    case "move_target_absent":
      // ⚠️ AND IT OFFERS THE NEW IMAGE (Adi, D1). A `put` that found nothing is the one shape where
      // "there is nothing here to move" and "make a new picture with it in" are the same answer, and
      // the old line's "or add it instead" pointed at the very ADD that rendered a second ball.
      //
      // ⚠️ APPROVE IS STILL DISABLED, and that half is NOT done here: every refused freeze becomes a
      // BLOCKING gap (`blockedBy`), so the offer is in the words and not yet in the button. Making it
      // approvable means a non-blocking severity on a preview with no frozen intent — the preview's
      // half, and the same surface D4 names. Ledgered rather than half-built.
      return "We couldn't find that in your photo, so there's nothing to move. Name something that's already in the picture, or start a new image with it in.";
    case "ambiguous_move":
      // ⚠️ ADI'S WORDING, APPROVED 2026-09-17, AND WHAT IT DELIBERATELY GIVES UP.
      //
      // F-WB3: two of the same thing, one noun, and only WHERE each one is tells them apart. The
      // target is a noun handed to detection, so "the one on the left" is not a thing the rules can
      // read — and this line must never invite it, which is the constraint card 2 shipped and this
      // keeps.
      //
      // What changed: card 2's line opened with "Try a photo with just the one". That was the only
      // half offering her something to do about the photograph in front of her, and it was bad
      // advice — she is editing THIS photo, so "use a different one" is not an action she can take
      // here. Cutting it leaves a line that names what we cannot do and one thing she can do
      // instead, and NOTHING she can do to this frame. That is the trade, made knowingly: a move we
      // genuinely cannot disambiguate should not pretend otherwise.
      //
      // The third option, weighed and not taken: ask for the distinguishing ATTRIBUTE rather than
      // the place ("the red one"), which keeps the target a noun. It is narrower than it sounds —
      // MAX_TARGET_WORDS is three, so "the red ball on the ground" does not fit, and detection has
      // to actually find whatever she names: "the red ball" plausibly, "the one on the left" never.
      // If it is ever built it belongs with a widened target, not in this string.
      return "There's more than one of those in your photo, so we can't tell which one to move. Name something there's only one of.";
    case "untrusted_origin":
    case "no_ask":
    case "unmeasured_source":
    case "invalid_constraints":
      return "We couldn't prepare this edit. Check the cost again.";
    case "native_edit_off":
      return "Adding something new to a photo isn't available yet, so this edit can't run. Nothing was spent.";
    case "ambiguous_object":
      // A replacement she pointed at a photo for reads the photo too (replace with reference), and the
      // add's two lines would be false of it: nothing is being added, and removing the photo would not
      // make the edit invent the thing — it would ask for it.
      if (refusal.replaces) {
        if (refusal.replaces + (refusal.adds ?? 0) > 1) {
          return "This takes more than one thing from attached photos, and which photo is for which change isn't clear. Make those changes one at a time.";
        }
        // Her PRODUCT photos standing where an Object photo would (card 4): the line has to name the tile
        // she used, or it reads as advice she has already taken.
        return refusal.products
          ? "More than one product photo is attached, and it isn't clear which one to use. Keep the one you want and check again."
          : "More than one object photo is attached, and it isn't clear which one to use. Keep the one you want and check again.";
      }
      // Her product photos standing where an Object photo would (C3): the same two cases, and the add's lines
      // would be false of them — "an object photo is attached" is not what she attached, and removing a product
      // from a brand's job is not the way past it. Placeholder copy, for the review pile.
      if (refusal.products) {
        return (refusal.adds ?? 1) > 1
          ? "This adds more than one thing, and a product photo is attached — which thing it shows isn't clear. Add them one at a time."
          : "More than one product photo is attached, and it isn't clear which one to add. Put the one you want added in the Object tile and check again.";
      }
      // Two cases, and each note is true only of its own: two photos for one thing, or one photo for
      // two things (composition). Neither is guessed at; each says how to get past it.
      return (refusal.adds ?? 1) > 1
        ? "This adds more than one thing, and an object photo is attached — which thing it shows isn't clear. Add them one at a time, or remove the photo and the edit will invent them."
        : "More than one object photo is attached, and an edit adds one thing at a time. Keep the one you want added and check again.";
    case "reference_off_native":
      return "Studio can't use an attached photo for a change here, so this edit can't run — describe it in words instead, like \"make my earrings gold\". Nothing was spent.";
    case "compound_off_native":
      return "Studio can't make more than one change at once here, so this edit can't run — try each change on its own. Nothing was spent.";
    case "text_off_native":
      return "Studio adds a headline across the top of the whole photo, never inside an area you marked, so this edit can't run — send it again without marking an area. Nothing was spent.";
    case "dropped_words_off_native":
      return 'Studio can\'t match a specific model or extra details here. Say it without them — "swap my cleats for nike".';
  }
}

/**
 * Does her sentence route as a brand change that DROPS words she typed (B.1c)? The same classifier
 * the freeze runs, over the same words — the question the entry below asks before any other arm.
 */
function asksToDropWords(ask: string, attached: Attached): boolean {
  if (!ask.trim()) return false;
  return route(ask, true, attached).steps.some((s) => s.dropped?.length);
}

/**
 * Does her sentence ROUTE as a composition — two or more clauses, each read by its own rule
 * (classify.ts, rule ½)? A composed sentence that asks anyway (the person guard refused one of its
 * steps) has no intent to freeze, and is left to the arms that answer every other ask.
 */
function asksToCompose(ask: string, attached: Attached): boolean {
  if (!ask.trim()) return false;
  const routed = route(ask, true, attached);
  // The words the rules read — her keep set aside, where they set it aside (A3b).
  return (
    routed.initialPath !== "ASK" &&
    composedClauses(routed.readAs ?? ask) !== null
  );
}

/**
 * Does her sentence point at a photo (replace with reference) — and so run native or not at all? The
 * refusal to block with when it does, on an arm that is not a derived native one; null when it does not.
 *
 * Two answers, each true of its case. With her Object photo attached it routes, and the masked stack
 * would ignore the photo: `reference_off_native`. With none, the sentence asks on every arm, and the
 * note is the ask's own line — so the flag-off product never runs "these gold hoops" as a description.
 */
function pointsAtHerPhoto(
  ask: string,
  attached: Attached,
): Extract<FreezeResult, { ok: false }> | null {
  if (!ask.trim()) return null;
  const routed = route(ask, true, attached);
  if (routed.initialPath === "ASK") {
    return routed.reason === "object_photo_missing"
      ? { ok: false, reason: "not_routed", askReason: "object_photo_missing" }
      : null;
  }
  return routed.steps.some((s) => s.reference === "object")
    ? { ok: false, reason: "reference_off_native" }
    : null;
}

/**
 * Does her sentence route with a headline (PR T)? The same classifier the freeze runs, over the same words —
 * so with STUDIO_DISPLAY_TEXT off no sentence does, and the arm that asks this moves nothing.
 */
function asksForHeadline(ask: string, attached: Attached): boolean {
  if (!ask.trim()) return false;
  return route(ask, true, attached).steps.some((s) => s.op === "DISPLAY_TEXT");
}

/**
 * A step detection has something to FIND for: a thing already in the frame. Not an add (its thing
 * is not there yet), and not a background or a look — those name no region, and compile from the
 * classifier's value alone.
 */
const findsARegion = (s: EditStep): boolean =>
  s.scope === "REGION" && !REGION_FREE_OPS.has(s.op);

/**
 * What detection reads of her sentence — or null when nothing in it has a region to find.
 *
 * The preview route's question before it spends on detection (routes/studio.ts), and the freeze's
 * when it checks for an echoed label (below). The same classifier the freeze runs, over the same
 * words. Three answers:
 *
 *   her sentence, as it came   every sentence rule ½ did not compose — one change, or an ask —
 *                              exactly as before composition existed. The same string, not a copy.
 *   null                       nothing to find: a lone add (PR C′), or a composed sentence none of
 *                              whose clauses names a thing in the frame ("add a soccer ball at her
 *                              feet and change the background to a stadium").
 *   the region-bearing clauses a composed sentence's clauses that name a thing in the frame, in her
 *                              words and her order, and nothing else (composition, decision 3).
 *
 * ─── WHY A COMPOSED SENTENCE IS NOT SENT WHOLE ──────────────────────────────────────────────────
 *
 * Detection reads its instruction the way the fast path used to: all of it, for one answer. Given B-c1
 * whole ("make her jersey blue and change the background to a stadium"), its background arm returns
 * ONE whole-frame region and nothing else (studio/autoMask.ts, the background short-circuit), so the
 * jersey has no label and the recolour cannot freeze. Given an add's place ("…at her feet"), its own
 * person rule refuses the whole preview over a ball that edits no one. Each clause's own rule already
 * read it; detection is asked only for the regions — the ones the recolour's colour is paired from.
 */
export function detectionTextFor(
  ask: string,
  attached: Attached = NOTHING_ATTACHED,
): string | null {
  if (!ask.trim()) return ask;
  const routed = route(ask, true, attached);
  if (routed.initialPath === "ASK") return ask;
  // Her keep, set aside where the rules read it (A3b): detection reads the words the rules read, so "keep
  // me the same" is never region text. Every other sentence is `ask`, the same string as before.
  const words = routed.readAs ?? ask;
  const clauses = composedClauses(words);
  if (clauses) {
    const bearing = clauses.filter((c) => c.steps.some(findsARegion));
    return bearing.length ? bearing.map((c) => c.text).join(" and ") : null;
  }
  return routed.steps.every((s) => REGION_FREE_OPS.has(s.op)) ? null : words;
}

/**
 * Does her sentence ask for an edit with NO REGION to find — an add, or a composed sentence whose
 * clauses name nothing in the frame?
 *
 * The preview route's question before it spends on detection: an add's thing is not in the frame,
 * so there is nothing to detect, and detection would either not find it or refuse on the place
 * ("on top of her head" names her). `detectionTextFor` has the whole answer; this is its null.
 */
export function asksForRegionFreeEdit(
  ask: string,
  attached: Attached = NOTHING_ATTACHED,
): boolean {
  if (!ask.trim()) return false;
  return detectionTextFor(ask, attached) === null;
}

/**
 * The preview route's one call: the brief, with her intent frozen onto it — or with a blocking gap
 * saying why it could not be — or exactly as it came in.
 *
 * EXACTLY AS IT CAME IN, as the same object, in three cases, and each is a rule rather than a gap:
 *
 *   • the flag is off         — flag-off briefs are byte-identical to the ones before this existed;
 *   • it is not an edit       — a generate has no frame and nothing to freeze;
 *   • she DREW the regions    — explicit spatial intent routes masked, permanently (the memo's
 *                               Routing decision). Native would discard the box she drew.
 *
 * A brief with no regions at all is left alone too: it already carries the "no edit regions" gap.
 *
 * ─── THE FOURTH CASE, "region-free": AN ADD (PR C′) ─────────────────────────────────────────────
 *
 * The route passes it when her sentence is an add, and for an add it skipped detection: the thing
 * is not in the frame, so there was nothing to find. That arm is below, and it is the only one that
 * acts with the flag OFF — because an add has no other path to fall back to, and a flag-off brief
 * left untouched would block on "mark the part of the photo you want changed", which is not true of
 * an add. The three arms above are exactly as they were.
 *
 * `input` is the BriefInput the brief was assembled from — the only place her typed words still
 * exist unmixed with our boilerplate. See the header.
 *
 * ⚠️ 2026-09-10 (B.1c): ONE sentence class no longer comes back as it went in with the flag off, or
 * with a box she drew — a brand change that dropped words she typed. It blocks instead (the first arm
 * below): only the native compile leaves the dropped word out of what the model reads. Every other
 * sentence is exactly as before on every arm.
 *
 * ⚠️ AND A SECOND CLASS SINCE COMPOSITION (decision 6a): a sentence rule ½ composed blocks the same
 * way, on the same arms, because only the native compile runs its clauses as the classifier read
 * them. Both classes asked before the PR that routed them, so no sentence that used to run is moved.
 *
 * ⚠️ AND A THIRD SINCE REPLACE WITH REFERENCE: a sentence pointing at her photo ("change my earrings
 * to these gold hoops") blocks on the same arms, attached or not (`pointsAtHerPhoto`). That one DID
 * run before: it froze a recolour of the earrings "gold", her photo sent and never named. It was a
 * misroute on every arm, and the flag-off arm now says so rather than running it.
 *
 * ⚠️ AND A FOURTH SINCE PR T: a headline (`text_off_native`), on a box she drew or the flag-off arm. It
 * reads the classifier's answer, so it exists only with STUDIO_DISPLAY_TEXT on; with it off no sentence
 * routes a headline, and every brief comes back from these arms exactly as it did before PR T.
 */
export function withNativeEditIntent(
  brief: CreativeBrief,
  input: BriefInput,
  opts: {
    regions: "derived" | "drawn" | "none" | "region-free";
    /**
     * The interpreter's conditions on the whole edit (I.1), frozen beside her changes — see
     * `freezeEditIntent`. Only a frozen intent carries them: on every arm that does not freeze, there is
     * nothing for them to ride on, and the interpreter never runs there (studio/interpret, eligibility).
     */
    constraints?: readonly EditConstraint[];
  },
): CreativeBrief {
  if (opts.regions === "region-free") {
    return withRegionFreeIntent(brief, input, opts.constraints);
  }
  // What she attached beside the frame, by role — the count her sentence is classified with everywhere
  // (classify.ts, `route`), read off the brief's own server-resolved references.
  const attached = attachedIn(brief.job.references);
  // ─── A BRAND CHANGE THAT DROPPED HER WORDS RUNS NATIVE, OR NOT AT ALL (B.1c) ──────────────────
  //
  // "swap the cleats for Nike Mercurials" routes as nike cleats with "mercurials" left out of the
  // value, disclosed on the preview. Both halves of that promise live on the native path: the
  // compiled instruction is built from the value, and the disclosure is read off the frozen steps. On
  // any other arm — the flag off, or a box she drew — the masked stack runs detection's labels, which
  // come from her whole sentence, and neither half holds. So those arms block rather than run it.
  // Every sentence that drops nothing reaches the arms below exactly as before.
  if (
    brief.job.mode === "edit" &&
    brief.job.source &&
    !(nativeEditEnabled() && opts.regions === "derived") &&
    asksToDropWords(explicitAsk(input), attached)
  ) {
    return blockedBy(brief, { ok: false, reason: "dropped_words_off_native" });
  }
  // ─── A COMPOSED SENTENCE RUNS NATIVE, OR NOT AT ALL (composition, decision 6a) ─────────────────
  //
  // Rule ½ reads each clause with its own rule, and only the native compile honours that: on the
  // masked stack detection re-reads her whole sentence into every crop's label and the classifier's
  // steps are ignored, so "make her jersey blue and remove the ball" could come back as B-p5's
  // darkened jersey again. So on the flag-off arm, and on a box she drew, a composed sentence blocks
  // — after the dropped-word check, whose note is the more specific one when both are true. Every
  // sentence rule ½ does not compose reaches the arms below exactly as before.
  if (
    brief.job.mode === "edit" &&
    brief.job.source &&
    !(nativeEditEnabled() && opts.regions === "derived") &&
    asksToCompose(explicitAsk(input), attached)
  ) {
    return blockedBy(brief, { ok: false, reason: "compound_off_native" });
  }
  // ─── A SENTENCE POINTING AT HER PHOTO RUNS NATIVE, OR NOT AT ALL (replace with reference) ─────────
  //
  // Only the native compile names her photo in the instruction ("replace the earrings with the gold
  // hoops from Image 2"). On the masked stack detection re-reads her sentence into each crop's label
  // and the photo rides along unaddressed, which is the misroute this PR ends. So on the flag-off arm
  // and on a box she drew, it blocks: `reference_off_native` with the photo attached, the ask's own
  // line without it. After the compound check, whose note is the more specific one when both are true.
  if (
    brief.job.mode === "edit" &&
    brief.job.source &&
    !(nativeEditEnabled() && opts.regions === "derived")
  ) {
    const pointing = pointsAtHerPhoto(explicitAsk(input), attached);
    if (pointing) return blockedBy(brief, pointing);
  }
  // ─── A HEADLINE RUNS NATIVE, OR NOT AT ALL (PR T) ─────────────────────────────────────────────────────
  //
  // Only the native compile writes a headline as one: q6-t1's banner across the top of the whole frame. On
  // the masked stack a box she drew is cropped, her sentence becomes the crop's direction, and whatever the
  // model draws inside the crop is composited back — semantics the template never anticipated. So on a box
  // she drew, and on the flag-off arm, it blocks. A lone headline reaches here only with a box: without
  // one it is region-free, and that arm blocks `native_edit_off` with the flag off. After the arms above,
  // whose notes are the more specific when both are true (a composed headline is `compound_off_native`).
  // With STUDIO_DISPLAY_TEXT off no sentence routes a headline, so every brief reaches the lines below
  // exactly as before.
  if (
    brief.job.mode === "edit" &&
    brief.job.source &&
    !(nativeEditEnabled() && opts.regions === "derived") &&
    asksForHeadline(explicitAsk(input), attached)
  ) {
    return blockedBy(brief, { ok: false, reason: "text_off_native" });
  }
  if (!nativeEditEnabled()) return brief;
  if (brief.job.mode !== "edit" || !brief.job.source) return brief;
  if (opts.regions !== "derived") return brief;

  const frozen = freezeEditIntent({
    ask: explicitAsk(input),
    origin: input.origin,
    source: brief.job.source,
    // Her attached photos, as the region-free arm passes them. An add reads them, and an add inside a
    // composed sentence freezes on THIS arm — beside a recolour, detection ran — so without them it
    // would ignore the Object photo she attached and invent the thing instead. A replacement she
    // pointed at her photo for always freezes here (it has a region), and reads them too.
    references: brief.job.references ?? [],
    constraints: opts.constraints,
  });
  if (frozen.ok) {
    return { ...brief, job: { ...brief.job, editIntent: frozen.intent } };
  }
  return blockedBy(brief, frozen);
}

/**
 * An add, frozen — or blocked, with a reason she can read. Never left to fall back to anything.
 *
 * ─── THE "NO EDIT REGIONS" GAP, AND WHY IT IS KEPT WHEN THE FREEZE SUCCEEDS ─────────────────────
 *
 * assembleBrief raises it for every edit with no regions, on the premise that such an edit
 * "degrades into a full re-render". For an add that premise is false: one full-frame call IS the
 * operation. But the gap is only waived where the waiver can be checked — `previewGeneration` skips
 * it on every read of a brief that carries a region-free native intent (studio/preview.ts). So a
 * brief that somehow lost its intent between the quote and the spend blocks again on this gap,
 * rather than running her sentence as a full re-render. Removing the gap here would make the brief's
 * safety depend on a field being present; keeping it makes it depend on the field being CHECKED.
 *
 * When the answer is a REFUSAL the gap is dropped: the refusal blocks on its own, and the gap's
 * surface copy ("mark the part of the photo you want changed") is the wrong thing to tell her about
 * an add.
 */
function withRegionFreeIntent(
  brief: CreativeBrief,
  input: BriefInput,
  constraints?: readonly EditConstraint[],
): CreativeBrief {
  if (brief.job.mode !== "edit" || !brief.job.source) return brief;
  const withoutRegionGap: CreativeBrief = {
    ...brief,
    gaps: brief.gaps.filter((g) => g.field !== NO_EDIT_REGIONS_FIELD),
  };
  if (!nativeEditEnabled()) {
    // A composed sentence says so (6a): "adding something new isn't available" would not be the
    // whole of it when the add has a second change beside it.
    return blockedBy(withoutRegionGap, {
      ok: false,
      reason: asksToCompose(
        explicitAsk(input),
        attachedIn(brief.job.references),
      )
        ? "compound_off_native"
        : "native_edit_off",
    });
  }

  const frozen = freezeEditIntent({
    ask: explicitAsk(input),
    origin: input.origin,
    source: brief.job.source,
    // `?? []` — the same defence every reader of this field keeps (see BriefJob.references).
    references: brief.job.references ?? [],
    constraints,
  });
  if (!frozen.ok) return blockedBy(withoutRegionGap, frozen);
  return { ...brief, job: { ...brief.job, editIntent: frozen.intent } };
}

/**
 * The brief, blocked on an ask the interpreter did not turn into a proposal (the interpreter, I.5) — her
 * sentence's own ask, the ad gate's, or the one C asked with. Nothing was frozen and detection never ran on
 * her sentence, so the brief carries the "no edit regions" gap; it is dropped, as the add's arm drops it,
 * because its copy ("mark the part of the photo you want changed") is not what she is being asked.
 */
export function blockedOnAsk(
  brief: CreativeBrief,
  askReason: string | undefined,
): CreativeBrief {
  return blockedBy(
    {
      ...brief,
      gaps: brief.gaps.filter((g) => g.field !== NO_EDIT_REGIONS_FIELD),
    },
    { ok: false, reason: "not_routed", askReason },
    INTERPRETER_ASK_LOG,
  );
}

/**
 * ─── TWO EVENTS FOR TWO THINGS THAT BLOCK A PREVIEW (wave A, G4; sweep-4 ledger F-CA7) ──────────────────────
 *
 * Both used to log `native_freeze_refused`, and both carry `reason: "not_routed"` when her sentence asked. But one
 * is a FREEZE that could not be made — a sentence the preview asked to freeze, refused — and the other is the
 * interpreter answering an ask with no proposal, where nothing was ever put to the freeze. C2's acceptance cell 3
 * was read as a refused freeze of an interpreter proposal off that one name; there was no proposal. So the
 * interpreter's ask has its own event and its own words, and every freeze refusal keeps its line byte for byte.
 */
const FREEZE_REFUSED_LOG = {
  event: "native_freeze_refused",
  msg: "native edit intent could not be frozen — the preview is blocked, nothing falls back",
} as const;
const INTERPRETER_ASK_LOG = {
  event: "interpreter_ask_blocked",
  msg: "the interpreter made no proposal for her ask — the preview is blocked on the ask, nothing was frozen",
} as const;

/** The brief, blocked on a refusal — logged by reason code, noted in words she can read. */
function blockedBy(
  brief: CreativeBrief,
  refusal: Extract<FreezeResult, { ok: false }>,
  log: { event: string; msg: string } = FREEZE_REFUSED_LOG,
): CreativeBrief {
  // Reason codes only. Her sentence and the labels detection wrote from it never reach a log line —
  // the rule classify.ts and detectRegions keep.
  logger.info(
    {
      event: log.event,
      athleteId: brief.athlete.athleteId,
      reason: refusal.reason,
      askReason: refusal.askReason ?? null,
    },
    log.msg,
  );
  return {
    ...brief,
    gaps: [
      ...brief.gaps,
      {
        field: "job.direction",
        note: freezeRefusalNote(refusal),
        severity: "blocking",
      },
    ],
  };
}
