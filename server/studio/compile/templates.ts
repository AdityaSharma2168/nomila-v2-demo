/**
 * studio/compile/templates — one change as one clause: each operation's instruction shape, in a
 * registry keyed by operation (`CLAUSE_TEMPLATES`).
 */
import {
  BACKGROUND_BLURRED,
  OBJECT_PRONOUNS,
  ONTO_HER_PREPS,
  wornLocationOf,
  type EditOperation,
} from "../classify";
import type { NativeChange } from "../nativeEdit";
import { namesWornItem, WORN_PLACE_PREPOSITIONS } from "../objectVocab";
import type { CameraAngle, LightMember } from "../imageOps";
import { EXTERNAL_CLOSE, EXTERNAL_OPEN } from "./fence";
import { neutralizeDelimiter as n } from "../../lib/externalContent";
import type { GeminiImageDialect } from "./geminiDialect";
import { lookPhrase } from "./looks";
import { CAMERA_PHRASES, LIGHTING_PHRASES, STYLE_LOOK_CLAUSE } from "./style";

/**
 * A brand in HER words, fenced as data inside the clause (PR 19: K33's unlisted brand, R-22's brand on an add). The
 * markers are written whatever STUDIO_STYLE_SPEC says: the field exists only with STUDIO_IMAGE_OPS on, so a brief
 * without it compiles byte-for-byte as before. The first case-insensitive occurrence is fenced, verbatim.
 */
export function fenceSpan(text: string, span: string | undefined): string {
  if (!span) return text;
  const at = text.toLowerCase().indexOf(span.toLowerCase());
  if (at < 0) return text;
  // Any copy of the tag in her text is neutralised, so the span cannot be closed early or a second fence forged.
  return `${n(text.slice(0, at))}${EXTERNAL_OPEN}${n(span)}${EXTERNAL_CLOSE}${n(text.slice(at + span.length))}`;
}

/** An add's thing as the clause names it: the brand she gave it in front, when she gave one (R-22). */
export function addedThing(add: { thing: string; brand?: string }): string {
  return add.brand ? `${add.brand} ${add.thing}` : add.thing;
}

/** "a soccer ball", "an orange cone". Good enough for a noun she typed; a wrong article is not a wrong edit. */
export function withIndefinite(thing: string): string {
  return `${/^[aeiou]/.test(thing) ? "an" : "a"} ${thing}`;
}

const POSSESSIVES = new Set(["my", "his", "their", "your", "our"]);

/**
 * What the person is called inside a place. The model reads "the person's" and "the person"; her own card
 * reads "your" and "you" (studio/compile/describe.ts, the interpreter's I.1). One reading of which words
 * are her, two ways of saying them.
 */
export interface PersonWords {
  possessive: string;
  person: string;
}

/** The model's words for her — the default, and the only words any compiled prompt uses. */
const THE_PERSON: PersonWords = {
  possessive: "the person's",
  person: "the person",
};

/**
 * Her place, as the model should read it — the person named as "the person", never as "me" or "her".
 *
 * "in the middle of my cleats" is her sentence, and "my" in a prompt is whoever wrote the prompt.
 * Q1 wrote "her", which assumes a gender this compiler has no business assuming. "the person's"
 * says the same thing about a one-person frame without either problem.
 *
 * "her" is both words: a possessive before a noun ("her right foot"), the person at the end of the
 * place or before the next preposition ("next to her"). The parse's own pronoun set decides the
 * rest, so the two files cannot disagree about which words are her.
 *
 * `words` is who she is called: the model's words unless a caller says otherwise — the card she reads
 * says "your" (describe.ts).
 */
export function spatialPlace(
  place: string,
  words: PersonWords = THE_PERSON,
): string {
  const w = place.split(/\s+/).filter(Boolean);
  const PREP_WORDS = new Set([
    "on",
    "onto",
    "to",
    "into",
    "in",
    "at",
    "next",
    "between",
    "beside",
  ]);
  return w
    .map((word, k) => {
      if (word === "her") {
        const next = w[k + 1];
        return next && !PREP_WORDS.has(next) ? words.possessive : words.person;
      }
      if (POSSESSIVES.has(word)) return words.possessive;
      if (OBJECT_PRONOUNS.has(word)) return words.person;
      return word;
    })
    .join(" ");
}

/**
 * Her place, when a worn thing goes ON a part of her — "to my ears" → "in the person's ears", "around my
 * neck" → "around the person's neck", "on me" → "by the person" — or null for every other place (PR M3,
 * worn adds).
 *
 * The preposition is the place's, never hers (studio/objectVocab.ts, WORN_PLACE_PREPOSITIONS). Which
 * places count is the classifier's reading of her (classify.ts, `wornLocationOf`), so a spatial place that
 * names her — "at her feet", "on top of her head" — is null here and keeps Q1's measured wording.
 *
 * Exported, with `words`, for her card (describe.ts): "worn in your ears". Every prompt keeps the default.
 */
export function wornPlace(
  place: string,
  words: PersonWords = THE_PERSON,
): string | null {
  const w = place.split(/\s+/).filter(Boolean);
  // Onto HER, by a lone pronoun — "put these earrings on me": worn by the person, wherever that thing is
  // worn. Only rule 3¾b routes this shape; rule 4½'s guard refuses an add whose surface is her, and "next
  // to her" or "beside me" start with a word that does not land a thing on her.
  if (w.length === 2 && ONTO_HER_PREPS.has(w[0]) && OBJECT_PRONOUNS.has(w[1])) {
    return `by ${words.person}`;
  }
  const location = wornLocationOf(place);
  if (!location) return null;
  return `${WORN_PLACE_PREPOSITIONS.get(location)} ${spatialPlace(w.slice(1).join(" "), words)}`;
}

/**
 * An add's worn place — `wornPlace` — only when its THING is worn; null for everything else (wave A, G1).
 *
 * Until G1 only rule 3¾b routed a place onto a part of her a worn thing goes on, so the place alone decided.
 * G1 routes a bottle "onto my head" — a place on that table — and it is not worn: it is placed, and keeps the
 * spatial wording ("place it onto the person's head"). Exported for her card, which asks the same question.
 */
export function wornAddPlace(
  add: { thing: string; place: string },
  words: PersonWords = THE_PERSON,
): string | null {
  return namesWornItem(add.thing) ? wornPlace(add.place, words) : null;
}

/**
 * THE FRAMING LINE — a placed add keeps the frame it was given (wave B, addition (a)).
 *
 * ─── WHAT MEASURED THIS, AND WHAT IT DOES NOT COVER ─────────────────────────────────────────────
 *
 * Probe 1b (docs/probes/framing-identity-stranger.md): on a tight full-body frame whose subject
 * already touches the top edge, "add a water bottle on top of my head" reframed **4 of 4** — content
 * 11-13% smaller and pushed 4-5% down (Δscale 0.8651-0.8931), reproducing 1a's single positive to the
 * third decimal against a 2% threshold and a 0.3% instrument floor. All four renders DID place the
 * bottle upright on her head, so the instruction was obeyed; the reframe is the price of obeying it.
 * The predictor is neither the operation nor the wording — it is **whether the place she named has
 * room in the frame she gave**: the same sentence on a frame with headroom is 0 of 2 at Δscale 1.000.
 *
 * ⚠️ IT IS THIS TEMPLATE'S, NOT THE PRESERVATION CLAUSE'S. 1a measured 30 renders she had already
 * paid for: 0 of 12 backgrounds and 18 of 19 adds hold the frame with no line at all. A sentence that
 * fires on the minority of renders is worse than no sentence, so the blanket clause is dead and this
 * one rides on the operation whose positive exists (compile/preservation.ts keeps its five properties).
 *
 * ⚠️ THE WORDING IS UNMEASURED. 1b authorises A LINE at 4/4; nothing has measured THESE WORDS. It
 * names the trade-off out loud — let the thing be cut off by the edge rather than shrink the
 * photograph — because the four renders prove the model will otherwise pay for the placement with the
 * frame, and a line that only says "keep the framing" leaves it no third option. The re-measure is the
 * four cells the probe already paid for (/Users/adi/pfi/probe1b.ts, $0.5376).
 */
export const ADD_FRAMING_LINE =
  "Keep the photograph's framing exactly as it is: do not zoom out, crop or rescale what is already " +
  "in the frame to make room — if the place named runs past the frame's edge, let the added thing be " +
  "cut off by the edge instead.";

/**
 * The things an intent adds AT A PLACE — the predicate `ADD_FRAMING_LINE` fires on, and the one the QA
 * stage's content-bounds observation fires on (studio/qa/framing.ts).
 *
 * ⚠️ ONE PREDICATE, TWO CALLERS, ON PURPOSE. The line and the check must be about the same renders or
 * the record says "the frame moved" about prompts that never carried the line. Sharing the function is
 * what makes that impossible rather than merely unlikely.
 *
 * A WORN add is excluded, and that exclusion is the measurement: a worn place is on her body, which is
 * inside the frame's content bounds by construction, and the nineteenth add — worn hoops, `f226a375`,
 * made by the running product mid-probe — measured Δscale 1.0025. Only a spatial place can lie outside
 * the bounds, so only a spatial place gets the line.
 */
export function placedAdds(
  changes: readonly Pick<NativeChange, "op" | "add">[],
): string[] {
  return changes.flatMap((c) =>
    c.op === "ADD_OBJECT" && c.add && !wornAddPlace(c.add) ? [c.add.thing] : [],
  );
}

/**
 * A worn thing with no photo, as the clause names it: "gold hoops", "a watch". The worn list's plurals all
 * end in "s" and its singulars none do (objectVocab.ts, WORN_ITEMS), so "a gold hoops" is never written.
 * Exported for her card, which names it the same way (describe.ts).
 */
export function wornThing(thing: string): string {
  return thing.endsWith("s") ? thing : withIndefinite(thing);
}

/**
 * Where the compiled instruction may point. The object photograph's number in the manifest, which
 * only the planner knows — the frozen intent names the ASSET, and the order is derived at plan time
 * (studio/refOrder.ts). Absent, an add or a replacement is addressed as "the object image" rather
 * than by number.
 */
export interface NativeAddressing {
  objectImage?: number;
  /**
   * A style reference drives the look (PR 18). Set only by buildNativePrompt, only when the brief carries a
   * renderable style spec. Absent, GLOBAL_STYLE compiles through LOOKS exactly as it always has.
   */
  styleLook?: boolean;
  /**
   * The Gemini 3 Pro Image dialect (quality-scrappy piece 7, STUDIO_DIALECTS; compile/geminiDialect.ts). Set only by
   * buildNativePrompt, only when the call goes to that model. Absent, every clause is today's, byte for byte.
   */
  dialect?: GeminiImageDialect;
}

/** Her object photograph, as the instruction names it: "Image 2", or "the object image" unnumbered. */
function objectImageName(addressing: NativeAddressing): string {
  return addressing.objectImage
    ? `Image ${addressing.objectImage}`
    : "the object image";
}

/**
 * One change as a clause. Lowercase and imperative — the shape of the prompt Q5 measured.
 *
 * `addressing` is read by an add and by a replacement with her photo: it is where the planner put
 * her object photo.
 */
export type ClauseTemplate = (
  c: NativeChange,
  addressing: NativeAddressing,
) => string;

/** Every operation a native edit compiles: all of them but GENERATE, which is not an edit. */
export type EditTemplateOp = Exclude<EditOperation, "GENERATE">;

/**
 * THE TEMPLATES, ONE PER OPERATION.
 *
 * Addressed by operation, so adding or changing one operation's clause is an edit to its own entry
 * and touches no other; studio/compile/golden.test.ts then says exactly which fixtures that moved.
 * A Record over every edit operation, so an operation with no template is a compile error here, which
 * is what the total switch this replaced guaranteed.
 */
export const CLAUSE_TEMPLATES: Readonly<
  Record<EditTemplateOp, ClauseTemplate>
> = {
  RECOLOR: (c) => `make the ${c.target} ${c.change}`,
  APPLY_DESIGN: (c) => `add ${c.change} to the ${c.target}`,
  REPLACE_OBJECT: (c, addressing) => {
    if (!c.object)
      return `replace the ${c.target} with ${fenceSpan(c.change ?? "", c.fenced)}`;
    // With her photo (replace with reference): the thing she named, from the image the manifest
    // numbers — "replace the earrings with the gold hoops from Image 2". The add's measured shape
    // (Q1: "add the soccer ball from the second image"), and naming the thing says WHICH object to
    // take from a busy photo: a product shot of hoops worn on a model is also an ear, hair and a face.
    return `replace the ${c.target} with the ${c.change} from ${objectImageName(addressing)}`;
  },
  REMOVE_OBJECT: (c) =>
    `remove the ${c.target} and fill the space where it was with what naturally lies behind it`,
  // ─── A MOVE IS THE REMOVAL AND THE ADD SAID AS ONE SENTENCE (wave B, card 2) ──────────────────
  //
  // ⚠️ "THE SAME ONE ... NOT A SECOND" IS THE LOAD-BEARING HALF OF THIS STRING, and it is what the
  // two-balls incident bought. Compiled as two clauses — a removal here, an add there — nothing ties
  // them to one object, `PATH_ORDER` runs the add BEFORE the removal, and the add's own disclosure
  // says the model will invent the thing. One clause naming one object cannot come apart that way.
  //
  // It borrows the removal's fill wording verbatim rather than paraphrasing it, because the hole the
  // thing leaves behind is the same problem in both operations and only one of them should own the
  // sentence that solves it.
  MOVE_OBJECT: (c) => {
    if (!c.to) throw new Error("a MOVE_OBJECT change without its destination");
    return (
      `move the ${c.target} ${spatialPlace(c.to)} — the same ${c.target} that is already in the ` +
      `photograph, not a second one — and fill the space where it was with what naturally lies behind it`
    );
  },
  ADD_OBJECT: (c, addressing) => {
    if (!c.add) throw new Error("an ADD_OBJECT change without its add");
    // A thing she wears, onto a part of her (PR M3): "add the gold hoops from Image 2, worn in the
    // person's ears", or with no photo "add gold hoops, worn in the person's ears". The add's own two
    // shapes with "worn" in place of "place it": her "to" never becomes "place it to the person's ears".
    // Unmeasured wording — M3's acceptance cell measures it.
    const worn = wornAddPlace(c.add);
    // R-22 (PR 19): the thing with her brand fenced in front — "a <external_content>nike</external_content> ball".
    const named = (t: string) => fenceSpan(t, c.add?.brand);
    const thing = addedThing(c.add);
    if (worn) {
      return c.add.objectAssetId
        ? `add the ${named(thing)} from ${objectImageName(addressing)}, worn ${worn}`
        : `add ${named(wornThing(thing))}, worn ${worn}`;
    }
    const place = spatialPlace(c.add.place);
    // Q1's two shapes. With her photo: "add the soccer ball from the second image, place it between
    // her cleats" (q1-a) — here "from Image 2", the manifest's own numbering. Without: "add a soccer
    // ball at her feet" (q1-d), and the model invents the object.
    if (!c.add.objectAssetId) {
      return `add ${named(withIndefinite(thing))}, place it ${place}`;
    }
    return `add the ${named(thing)} from ${objectImageName(addressing)}, place it ${place}`;
  },
  // ─── A HEADLINE: q6-t1'S MEASURED WORDS, VERBATIM (PR T, sweep #4's F-T) ─────────────────────────
  //
  // The one text-only shape that was measured: "Add a large banner across the top of the background that
  // reads GET LOUD in bold white capital letters" — CLEAN at 1:1, legible and correctly spelled
  // (docs/probes/sweep-4-ledger.md). Here in the compile tier's lowercase imperative, her words where
  // GET LOUD was, unquoted as the probe sent them. q6-t2's corner-and-logo shape is not a template: it
  // drew a different adidas mark from q3-b's, which Mia flagged for recalibration.
  // W-3: her placed text says where, and her words ride fenced as data. Neither field is on a rule ⅛ headline, so its
  // bytes are unchanged.
  //
  // The dialect's rule 4 (quality-scrappy piece 7): her words QUOTED — the fence, when there is one, inside the quotes —
  // and the face named, which is the template's field (DEFAULT_TEXT_FONT unless a published row names another).
  DISPLAY_TEXT: (c, addressing) =>
    addressing.dialect
      ? `add a large banner across the ${c.placement ?? "top"} of the background that reads "${fenceSpan(c.change ?? "", c.fenced)}" in white capital letters, set in ${addressing.dialect.font}`
      : `add a large banner across the ${c.placement ?? "top"} of the background that reads ${fenceSpan(c.change ?? "", c.fenced)} in bold white capital letters`,
  // A blur is a TREATMENT of the background, not a replacement of it, so it gets its own line rather
  // than "change the background to blurred" (wave D, card 4 / A14). The one value that branches.
  CHANGE_BACKGROUND: (c) =>
    c.change === BACKGROUND_BLURRED
      ? "blur the background, keeping the subject sharp and exactly as it is"
      : `change the background to ${c.change}`,
  // Her word is stored; the phrase of the look it names is sent (compile/looks.ts, the style vocabulary).
  // Main's fifteen looks' phrases are their own words, so every earlier look prompt is byte-identical.
  //
  // The SPEC-DRIVEN ARM (PR 18, R-4): with a style reference on the brief, the look is the reference's, described
  // in the fenced block after the instruction (compile/style.ts). The closed-LOOKS arm below it is untouched.
  // ⚠️ MUTATION (compile/style.test "the closed-LOOKS arm changes when a spec is present elsewhere").
  GLOBAL_STYLE: (c, addressing) =>
    addressing.styleLook
      ? STYLE_LOOK_CLAUSE
      : `give the whole photograph this look: ${lookPhrase(c.change)}`,
  // PR 19 — L-A, the wording LIGHT-1 measures against today's look arm (W0) and L-B. The light moves: its direction,
  // colour and softness and the shadows it casts (assemble.ts's scope sentence says so), never the frame or her.
  // PR 19 (S-7): never sent to a model — image.crop is cut in-process (studio/adapters/local.ts) — but the router's
  // one door takes a prompt for every task, and this one says what the job did.
  CROP: (c) =>
    c.change === "zoom"
      ? "crop in closer, centred, keeping the photograph's own shape"
      : `crop the photograph to ${c.change}, centred`,
  RELIGHT: (c) =>
    `relight the photograph with ${LIGHTING_PHRASES[c.change as LightMember]}`,
  // PR 19 (R-13) — the style vocabulary's own angle phrase. A camera move re-photographs the same moment: her pose,
  // face and clothing and the place are the scope sentence's to keep (assemble.ts), and CAM-1's rubric checks them.
  CAMERA: (c) =>
    `show this same moment from a new camera position — ${CAMERA_PHRASES[c.change as CameraAngle]}`,
  // PR 19 (ADI-R19-W3's logo rec): the ad's brand logo, like a watermark — where it reads best, never on her or the
  // headline. The brand is a word the rules list (BRANDS), so it is never her free text and is not fenced.
  BRAND_MARK: (c) =>
    `add the ${c.change} logo as a small, clean brand mark over the photograph, like a watermark — in a corner or along the top or bottom edge, wherever it stays clearly visible against what is behind it; never on the person or anything they wear, and never over a headline`,
};

/** One change as a clause, by its operation's template. */
export function clauseFor(
  c: NativeChange,
  addressing: NativeAddressing,
): string {
  // Unreachable: readNativeIntent refuses a GENERATE change, and freezeEditIntent never writes one.
  // GENERATE has no template by type, so it cannot be given one by accident.
  if (c.op === "GENERATE") {
    throw new Error("GENERATE is not an edit and never compiles as one");
  }
  return CLAUSE_TEMPLATES[c.op](c, addressing);
}
