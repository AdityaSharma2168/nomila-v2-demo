/**
 * studio/interpret/menu — the CLOSED MENU the interpreter fills, and the checks each slot must pass
 * (the interpreter, I.2; plan v1 §2, v2 §3).
 *
 * ─── A PARAPHRASER INTO THE RULES' GRAMMAR, SO THE MENU IS THE RULES' OWN VOCABULARY ─────────────────
 *
 * The interpreter never writes an edit. It fills typed slots from this menu, and deterministic code
 * turns them into a canonical sentence C in words `route()` already reads (canonical.ts). So every
 * vocabulary below is imported from the classifier, the object vocabulary or the look vocabulary, never
 * restated: a colour is a word rule 5 reads, a look is a word rules 3 and 5¾ read, a brand is on BRANDS,
 * a worn place is one WORN_PLACES gives that thing. A slot the rules could not read is refused HERE,
 * before C exists — and the round trip refuses it again after, so neither check has to be the only one.
 *
 *   recolor       { target, colour }                       make the <target> <colour>
 *   remove        { target }                               remove the <target>
 *   brand_swap    { item, descriptors, brand }             change my <item> to a <descriptors> <brand> <item>
 *   pointed_swap  { target, what }   her Object photo only  change the <target> to these <what>
 *   add           { thing, preposition, place }            add a <thing> <preposition> <place>
 *   design        { design, target }                       add a <design> to the <target>
 *   background    { setting }                              change the background to the <setting>
 *   look          { term }           HER WORDS ONLY (M6)   make it <term>
 *   text          { content }        STUDIO_DISPLAY_TEXT   add the headline "<CONTENT>" across the top
 *
 * Plus the closed constraints (studio/nativeEdit.ts, `EditConstraint`), which ride beside C.
 *
 * ─── WHAT A SLOT MAY NEVER HOLD ──────────────────────────────────────────────────────────────────────
 *
 * Her: no pronoun, no word naming a part of her (PERSON_NOUNS, via `namesPerson`) — except where a worn
 * thing goes on the part of her that thing is worn on (M3, `wornGoesOn`). No body modification in any
 * slot (M3's BODY_MODS). No joiner, verb or negation, which is how a second instruction would be
 * smuggled into one slot ("jersey and remove the ball"). And every free slot is held to the rules' own
 * bounds: three words for a thing, 40 characters for a setting (rule 2's), four words and 24 characters
 * for a headline (rule ⅛'s, enforced by `headlineBound` itself).
 */
import {
  ADD_SPATIAL_PREPS,
  ADD_SURFACE_PREPS,
  BG_NOUNS,
  BODY_MODS,
  BRANDS,
  COLOR,
  COLOR_MOD,
  DESIGN,
  DETERMINERS,
  HEX,
  MAX_DESCRIPTOR_WORDS,
  MAX_TARGET_WORDS,
  META_NOUNS,
  NEGATIONS,
  OBJECT_PRONOUNS,
  ONTO_HER_PREPS,
  OPERATION_VERBS,
  POINTERS,
  REMOVE,
  VAGUE_NOUNS,
  headlineBound,
  isBrandName,
  isDescriptor,
} from "../classify";
import { LOOK_WORDS, lookOf } from "../lookVocab";
import {
  namesPerson,
  namesWornItem,
  wornGoesOn,
  WORN_ITEMS,
} from "../objectVocab";

// ─── The kinds ─────────────────────────────────────────────────────────────────────────────────────

export type EditKind =
  | "recolor"
  | "remove"
  | "brand_swap"
  | "pointed_swap"
  | "add"
  | "design"
  | "background"
  | "look"
  | "text"
  // PR 19 (ADI-R19-W3's logo rec): the ad's brand logo, like a watermark. CODE's alone (ad.ts, like a kit swap): it is
  // NOT in EDIT_KINDS, so the model is never offered it and a reply that names it is refused (reply.ts).
  | "brand_mark";

export const EDIT_KINDS: readonly EditKind[] = [
  "recolor",
  "remove",
  "brand_swap",
  "pointed_swap",
  "add",
  "design",
  "background",
  "look",
  "text",
];

/**
 * Where an edit came from (plan v2 §2):
 *
 *   yours      her words asked for it — every edit a reply may make on its own
 *   suggested  we propose it for a treatment she named (an ad) — a headline or a background, never a
 *              look (M6) and never a change to a thing
 *   brand      required by the ad's brand — a kit swap (M2). CODE assembles these from what the photo
 *              shows (studio/interpret/ad.ts); a model reply can never say "brand".
 */
export type EditSource = "yours" | "suggested" | "brand";

/** The two sources a model reply may use. "brand" is code's alone. */
export const REPLY_SOURCES: readonly EditSource[] = ["yours", "suggested"];

/** The kinds a treatment may SUGGEST: a headline and a background (M1, v2 §4). Never a look (M6). */
export const SUGGESTIBLE: ReadonlySet<EditKind> = new Set([
  "text",
  "background",
]);

export type Edit =
  | { kind: "recolor"; target: string; colour: string }
  | { kind: "remove"; target: string }
  | { kind: "brand_swap"; item: string; descriptors: string[]; brand: string }
  | { kind: "pointed_swap"; target: string; what: string }
  | { kind: "add"; thing: string; preposition: string; place: string }
  | { kind: "design"; design: string; target: string }
  | { kind: "background"; setting: string }
  | { kind: "look"; term: string }
  | { kind: "text"; content: string }
  | { kind: "brand_mark"; brand: string };

/** An edit and where it came from. A brand-required swap also says whose marks it swaps away. */
export type SourcedEdit = Edit & {
  source: EditSource;
  /** On a brand-required swap only: the ad's brand, and the brands whose marks were on this item. */
  reason?: { brand: string; away: string[] };
};

// ─── The vocabularies, from the rules ──────────────────────────────────────────────────────────────

/**
 * Main's look words that are not terms a look can be given as: "b&w" is not a word, and "colour grade",
 * "color grade" and "grading" name the act, not the look (v1 §3). The rules still read all four.
 */
const NOT_A_TERM: ReadonlySet<string> = new Set([
  "b&w",
  "colour grade",
  "color grade",
  "grading",
]);

/**
 * THE LOOKS — every word the rules name a look by (studio/lookVocab.ts, LOOK_WORDS), less NOT_A_TERM:
 * v1 §3's eleven and the style vocabulary's sixteen (V.3). Read off the vocabulary, not restated, so a
 * look the rules gain is on the menu with nothing to edit here — and prompt.test.ts's hash pin makes
 * that a PROMPT_VERSION bump, because the prompt names every term.
 *
 * Her WORD, not the look's name: "moody" is a term as well as "moodier", so the model can hand back
 * the word she used and M6's check (her quote names the term) reads it as it is. C is "make it moody",
 * and the compile tier sends the moodier look's phrase (compile/looks.ts). interpret/menu.test.ts pins
 * the list by hand and round-trips every term, so a word the rules stop reading goes red there rather
 * than rendering a C that routes as something else.
 */
export const LOOK_TERMS: readonly string[] = LOOK_WORDS.filter(
  (w) => !NOT_A_TERM.has(w),
);

/**
 * WHAT A MARK CAN BE ON, as `visibleMarks` reports it — a closed garment and footwear list, head to feet,
 * so a kit swap lists her items in the order she wears them ("jersey, socks and cleats"). "other" is
 * a mark on anything else (a ball, a bag, a sign), which is perception only and never swapped (C-7).
 */
export const SWAP_ITEMS: readonly string[] = [
  "cap",
  "hat",
  "headband",
  "jersey",
  "shirt",
  "top",
  "tank top",
  "crop top",
  "sports bra",
  "jacket",
  "hoodie",
  "gloves",
  "shorts",
  "pants",
  "leggings",
  "socks",
  "cleats",
  "shoes",
  "boots",
  "sneakers",
];

/** The brands a slot may name: every word BRANDS reads, as `isBrandName` holds it (lowercase). */
export const BRAND_WORDS: readonly string[] = [
  "adidas",
  "nike",
  "puma",
  "under armour",
  "new balance",
  "reebok",
  "jordan",
  "umbro",
  "kappa",
  "castore",
  "hummel",
  "mizuno",
  "asics",
  "fila",
];

/** What an ad is called — the ad gate's words, and what a treatment span must quote (v1 §3). */
export const AD_WORDS =
  /\b(ad|ads|advert|adverts|advertisement|advertisements|campaign|campaigns|commercial|commercials)\b/i;

/**
 * The prepositions an add is placed with: rule 4½'s surface and spatial ones and the ones a worn thing
 * sits in (classify.ts). A worn add must use one of ONTO_HER_PREPS; any other add, one of the rest.
 */
export const ADD_PREPOSITIONS: readonly string[] = [
  ...new Set([
    ...ADD_SURFACE_PREPS.map((p) => p.join(" ")),
    ...ADD_SPATIAL_PREPS.map((p) => p.join(" ")),
    ...ONTO_HER_PREPS,
  ]),
];

/**
 * Words that TURN a sentence around — the negation tripwire (v1 §2). Classify's own NEGATIONS, plus
 * the contractions she types without an apostrophe or with one (compared with it removed). Inside an
 * `edit` span any of these asks: dropping "without stripes" would give her the stripes she refused.
 */
export const TRIPWIRE: ReadonlySet<string> = new Set([
  ...NEGATIONS,
  "dont",
  "doesnt",
  "didnt",
  "cant",
  "cannot",
  "wont",
  "isnt",
  "arent",
  "shouldnt",
  "wouldnt",
  "nothing",
  "none",
  "nor",
  "neither",
  "unless",
]);

/**
 * THE ONLY WORDS A `filler` SPAN MAY HOLD — politeness, wanting, and the joiners between her changes.
 * Closed, because a filler span is words the interpreter says carry no change; if it could hold any
 * word, "and remove the ball" marked as filler would launder a fifth change past the count.
 */
export const FILLER: ReadonlySet<string> = new Set([
  "please",
  "pls",
  "plz",
  "can",
  "could",
  "would",
  "will",
  "you",
  "also",
  "and",
  // A joiner like "and" (R1, "turn this into a puma ad BUT dont change my face"). It carries no change of
  // its own, and a filler span still holds nothing but these words — so "but not the socks" cannot be
  // filler, and its "not" still meets the tripwire wherever it is read.
  "but",
  "then",
  "just",
  "uh",
  "um",
  "umm",
  "so",
  "ok",
  "okay",
  "hey",
  "hi",
  "i",
  "id",
  "im",
  "want",
  "wanna",
  "like",
  "love",
  "need",
  "thanks",
  "thank",
  "lol",
  "maybe",
  "actually",
  "yeah",
  "yes",
  "now",
  "too",
  "for",
  "me",
  "to",
]);

/** Subject pronouns, which name someone as surely as OBJECT_PRONOUNS do. */
const SUBJECT_PRONOUNS: ReadonlySet<string> = new Set([
  "i",
  "she",
  "he",
  "they",
  "we",
  "it",
]);

/** Words that join or start another instruction — never inside one slot. */
const JOINERS: ReadonlySet<string> = new Set([
  "and",
  "or",
  "then",
  "also",
  "but",
  "plus",
]);

/** Verbs a slot must never carry: the rules' operation verbs, the removal verbs, and "keep". */
const VERBS: ReadonlySet<string> = new Set([
  ...OPERATION_VERBS,
  "remove",
  "delete",
  "erase",
  "take",
  "rid",
  "keep",
  "leave",
  "turn",
]);

// ─── Words ─────────────────────────────────────────────────────────────────────────────────────────

/** Her sentence's words, lowercase, apostrophes dropped ("don't" → "dont"), digits kept. */
export function wordsOf(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/['’]/g, "")
      .match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []
  );
}

/** Lowercase letters, one space or hyphen between words — the only shape a free slot may have. */
const SLOT_SHAPE = /^[a-z]+(?:[ -][a-z]+)*$/;

const wholly = (re: RegExp, w: string) => re.exec(w)?.[0].toLowerCase() === w;

const isColourWord = (w: string) =>
  wholly(COLOR, w) || wholly(COLOR_MOD, w) || wholly(HEX, w);

/** Is this a brand as BRANDS reads it, anywhere in the phrase? */
const hasBrand = (s: string) => BRANDS.test(s);

/** How many brands BRANDS reads in the phrase — rule 3¾b allows a worn thing one. */
const brandCount = (s: string) =>
  (s.match(new RegExp(BRANDS.source, "gi")) ?? []).length;

/** A phrase's words that name her body, a pronoun, a verb, a joiner or a negation — any of them is a smuggle. */
function smuggles(words: readonly string[]): boolean {
  return words.some(
    (w, k) =>
      OBJECT_PRONOUNS.has(w) ||
      SUBJECT_PRONOUNS.has(w) ||
      POINTERS.has(w) ||
      JOINERS.has(w) ||
      VERBS.has(w) ||
      TRIPWIRE.has(w) ||
      BODY_MODS.has(w) ||
      BODY_MODS.has(`${w} ${words[k + 1]}`),
  );
}

// ─── The slot checks ───────────────────────────────────────────────────────────────────────────────

/**
 * A thing in the photo, as a target: 1–3 words of the slot's shape, no determiner (C adds its own), no
 * colour (rule 5 stops a phrase at one), no smuggle, not her, not the photograph or the setting, not a
 * vague word. `design: false` also refuses a design or brand word — rule 4 would claim the sentence.
 */
export function targetOk(
  target: string,
  opts: { design: boolean } = { design: false },
): boolean {
  if (!SLOT_SHAPE.test(target)) return false;
  const w = target.split(" ");
  const head = w.at(-1) ?? "";
  return (
    w.length <= MAX_TARGET_WORDS &&
    !DETERMINERS.includes(w[0]) &&
    !w.some(isColourWord) &&
    !smuggles(w) &&
    !namesPerson(target) &&
    !META_NOUNS.has(head) &&
    !VAGUE_NOUNS.has(head) &&
    !w.some((x) => BG_NOUNS.has(x)) &&
    (opts.design || (!DESIGN.test(target) && !hasBrand(target)))
  );
}

/** A colour rule 5 reads: colour words and their modifiers, "and" only between two, at least one colour. */
export function colourOk(colour: string): boolean {
  const w = colour.split(" ");
  if (!w.length || w.length > MAX_TARGET_WORDS) return false;
  const ok = w.every(
    (x, k) =>
      isColourWord(x) ||
      (x === "and" && k > 0 && k < w.length - 1 && isColourWord(w[k - 1])),
  );
  return ok && w.some((x) => wholly(COLOR, x) || wholly(HEX, x));
}

/** A brand swap's words beside the brand: rule 4c's closed descriptors, at most three, no brand among them. */
export function descriptorsOk(descriptors: readonly string[]): boolean {
  return (
    descriptors.length <= MAX_DESCRIPTOR_WORDS &&
    descriptors.every((d) => isDescriptor(d) && !hasBrand(d))
  );
}

/** A design rule 4a places: 1–3 words, at least one a design or brand word, no smuggle, not her. */
export function designOk(design: string): boolean {
  if (!SLOT_SHAPE.test(design)) return false;
  const w = design.split(" ");
  return (
    w.length <= MAX_TARGET_WORDS &&
    !DETERMINERS.includes(w[0]) &&
    (DESIGN.test(design) || hasBrand(design)) &&
    !smuggles(w) &&
    !namesPerson(design)
  );
}

/**
 * What she points at in her Object photo: 1–3 words, colours and one brand may ride along (rule 3½'s
 * "these nike ones"), no design word (rule 3½ refuses one), no smuggle, not her.
 */
export function pointedWhatOk(what: string): boolean {
  if (!SLOT_SHAPE.test(what)) return false;
  const w = what.split(" ");
  const head = w.at(-1) ?? "";
  return (
    w.length <= MAX_TARGET_WORDS &&
    !DETERMINERS.includes(w[0]) &&
    !DESIGN.test(what) &&
    !smuggles(w) &&
    !namesPerson(what) &&
    !META_NOUNS.has(head) &&
    !VAGUE_NOUNS.has(head)
  );
}

/**
 * A setting rule 2 reads in full: at most 40 characters of lowercase words (its value regex captures
 * `[a-z -]{0,40}` after one letter), no leading article (C adds "the"), no verb, joiner or negation,
 * and nobody in it — Studio never adds a person (the product rule), so no word naming one.
 */
export function settingOk(setting: string): boolean {
  if (!SLOT_SHAPE.test(setting) || setting.length > 40) return false;
  const w = setting.split(" ");
  return (
    !["a", "an", "the"].includes(w[0]) &&
    !w.some(
      (x) =>
        OBJECT_PRONOUNS.has(x) ||
        SUBJECT_PRONOUNS.has(x) ||
        JOINERS.has(x) ||
        VERBS.has(x) ||
        TRIPWIRE.has(x) ||
        BODY_MODS.has(x) ||
        namesPerson(x),
    ) &&
    !REMOVE.test(setting)
  );
}

/** A look the rules read: a term on the menu, and a word that names a look (studio/lookVocab.ts). */
export const lookOk = (term: string) =>
  LOOK_TERMS.includes(term) && lookOf(term) !== null;

/** A headline within rule ⅛'s own bounds (N8) — `headlineBound` is the rule's, not a copy. */
export const textOk = (content: string) =>
  content.length > 0 && headlineBound(content) === null;

/**
 * An add: a thing, a preposition and a place, each checked as the rules read them.
 *
 *   thing   1–3 words; colours may ride along (rule 4½ keeps them). Not her, no body modification,
 *           no smuggle. A worn thing may carry one brand (rule 3¾b reads "an adidas cap"); any other
 *           thing may not carry a design or brand word — rule 4 would read it as a design.
 *   place   an optional determiner and 1–3 words, or a lone pronoun. It may name a part of her only
 *           when the thing is worn and the part is one that thing is worn on (M3, N5, `wornGoesOn`), and
 *           a lone pronoun only for a worn thing ("put these earrings on me").
 */
export function addOk(
  thing: string,
  preposition: string,
  place: string,
): boolean {
  if (!SLOT_SHAPE.test(thing) || !SLOT_SHAPE.test(place)) return false;
  const tw = thing.split(" ");
  const worn = namesWornItem(thing);
  if (
    tw.length > MAX_TARGET_WORDS ||
    DETERMINERS.includes(tw[0]) ||
    smuggles(tw) ||
    namesPerson(thing) ||
    VAGUE_NOUNS.has(tw.at(-1) ?? "") ||
    META_NOUNS.has(tw.at(-1) ?? "")
  ) {
    return false;
  }
  if (worn) {
    // Rule 3¾b's own grammar for the thing (classify.ts, `wornThingAt`): before its WORN_ITEMS name, only
    // descriptors (`isDescriptor`) and at most one brand. "small gold hoops" and "baseball cap" (R1) are
    // not that, so C would ask `worn_add_unclear` — refused here, as a slot, before C is ever rendered.
    if (brandCount(thing) > 1 || DESIGN.test(thing)) return false;
    const head = WORN_ITEMS.includes(tw.slice(-2).join(" ")) ? 2 : 1;
    const before = tw
      .slice(0, tw.length - head)
      .join(" ")
      .replace(new RegExp(BRANDS.source, "gi"), " ")
      .split(" ")
      .filter(Boolean);
    if (!before.every((w) => isDescriptor(w))) return false;
  } else if (DESIGN.test(thing) || hasBrand(thing)) {
    return false;
  }
  if (!ADD_PREPOSITIONS.includes(preposition)) return false;

  const pw = place.split(" ");
  // A lone pronoun: her, as the place — a worn thing only, onto her (rule 3¾b).
  if (pw.length === 1 && OBJECT_PRONOUNS.has(pw[0])) {
    return worn && ONTO_HER_PREPS.has(preposition);
  }
  const words = DETERMINERS.includes(pw[0]) ? pw.slice(1) : pw;
  if (!words.length || words.length > MAX_TARGET_WORDS) return false;
  if (
    words.some(
      (x) =>
        OBJECT_PRONOUNS.has(x) ||
        SUBJECT_PRONOUNS.has(x) ||
        JOINERS.has(x) ||
        VERBS.has(x) ||
        TRIPWIRE.has(x) ||
        BODY_MODS.has(x),
    ) ||
    META_NOUNS.has(words.at(-1) ?? "")
  ) {
    return false;
  }
  if (namesPerson(words.join(" "))) {
    // Her, as the place: only a worn thing, onto her, on a part of her it is worn on.
    return (
      worn &&
      ONTO_HER_PREPS.has(preposition) &&
      wornGoesOn(thing, words.at(-1) ?? "")
    );
  }
  return true;
}

/** Is this brand one a slot may name — whole, lowercase, on BRANDS? */
export const brandOk = (brand: string) => isBrandName(brand);

/**
 * One edit's slots, checked — or false. `objects` is how many Object photos she attached: a pointed swap
 * needs one (v1's "a pointed swap with no Object photo" asks).
 */
export function editOk(e: Edit, objects: number): boolean {
  switch (e.kind) {
    case "recolor":
      return targetOk(e.target) && colourOk(e.colour);
    case "remove":
      // A removal may name a brand's mark — rule 1 runs before rule 4 and reads "remove the nike logo".
      return targetOk(e.target, { design: true });
    case "brand_swap":
      // Rule 4c IS rule 4, so an item may be a design word ("my kit") — but never carry a brand itself.
      return (
        targetOk(e.item, { design: true }) &&
        !hasBrand(e.item) &&
        descriptorsOk(e.descriptors) &&
        brandOk(e.brand)
      );
    case "pointed_swap":
      return objects >= 1 && targetOk(e.target) && pointedWhatOk(e.what);
    case "add":
      return addOk(e.thing, e.preposition, e.place);
    case "design":
      return designOk(e.design) && targetOk(e.target);
    case "background":
      return settingOk(e.setting);
    case "look":
      return lookOk(e.term);
    case "text":
      return textOk(e.content);
    case "brand_mark":
      return brandOk(e.brand);
  }
}

/**
 * The thing an edit changes, for "one change per thing" — two edits of the same thing are not guessed
 * between. A background, a look and a headline are each one per image (rule ½'s compound_conflict).
 */
export function editKey(e: Edit): string {
  switch (e.kind) {
    case "recolor":
    case "remove":
    case "pointed_swap":
    case "design":
      return `thing:${e.target}`;
    case "brand_swap":
      return `thing:${e.item}`;
    case "add":
      return `add:${e.thing}`;
    case "background":
    case "look":
    case "text":
    case "brand_mark":
      return e.kind;
  }
}
