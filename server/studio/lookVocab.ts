/**
 * studio/lookVocab — the LOOKS she can name, and whether her sentence is WHOLLY one (style vocabulary,
 * 2026-09-14).
 *
 * ─── TWO READERS, AND THE OLD ONE DOES NOT CHANGE BY A BYTE ──────────────────────────────────────────
 *
 * Rule 3 (classify.ts, `GLOBAL`) reads main's fifteen look words, permissively: any sentence carrying one
 * and naming no region is a whole-frame look. It stays exactly as it is, because this vocabulary's first
 * constraint is that no sentence which routes today routes differently.
 *
 * This module is the second reader, rule 5¾. It reads the WIDENED list, but only a sentence that is
 * nothing except a look, and it sits after every other rule, so the only sentences it can answer are
 * ones every rule declined. A sentence that routes on main never reaches it; neither does a clause of one.
 *
 * ─── WHY "WHOLLY", AND NOT RULE 3 WITH MORE WORDS ────────────────────────────────────────────────────
 *
 * Measured at $0 on main c4951e2, rule 3's grammar with the new words added would have:
 *
 *   • moved a routed sentence — "make it moodier and warmer" routes "warmer" today, and rule 3 keeps the
 *     FIRST look it finds, so it would have become "moodier";
 *   • dropped her keep — "make it moodier, dont change anything about me" asks today, and the interpreter
 *     reads it as the look AND "keep me", with the whole-photo line. Rule 3 ignores everything that is
 *     not a region, so it would have routed as a bare look. (Main already does this to its own words:
 *     "make it warmer, dont change anything about me" routes, and her keep is gone — recorded, and its
 *     own PR next.)
 *   • read her body as the photo — "make me softer" would have been a whole-frame grade.
 *
 * So a sentence is a look here only when every word of it is a look word or one of LOOK_SHAPE_WORDS:
 * the verbs that ask for one, the words for the photograph and for a look, a few small words and her
 * politeness. A pronoun for her, a negation, a keep, an amount ("slightly") or any other thing asks, and
 * the interpreter, which reads a whole sentence, gets the chance to read it.
 *
 * ─── A LOOK, AND THE WORDS FOR IT ────────────────────────────────────────────────────────────────────
 *
 * Every word she can use belongs to exactly one look ("moody" is the moodier look, "retro" the vintage
 * one), so the compile tier has one phrase per look (compile/looks.ts). What a step STORES is still her
 * word — rule 3's value has always been the word she typed — so her card says "Make it moody" and the
 * interpreter's M6 check (her own quote names the term) needs no change. Main's fifteen words are each
 * their own look and compile as themselves, so every prompt compiled before this compiles byte-identically.
 *
 * ⚠️ AN ALLOW-LIST, AND THE MISS DIRECTION IS THE SAFE ONE. A word that is not here is not a look, so its
 * sentence asks exactly as it does today. Nothing stems, fuzzy-matches or guesses: bare "warm" and "cool"
 * are out (slang — "make it look cool"), bare "film" and "lighter" too.
 *
 * ─── A LOOK WE DO NOT HAVE ASKS, AND SAYS SO (V.4) ───────────────────────────────────────────────────
 *
 * "give it a dreamy vibe" names a look — just not one of these. `unknownLookWord` finds that shape, so
 * the ask can say "that look isn't one we know yet" and name some that are (classify.ts, `look_unknown`),
 * rather than the catch-all's "name the thing and what it should become".
 */

/**
 * THE LOOKS, each with every word she can name it by — the look's own name first.
 *
 * Main's fifteen are each their own look (classify.ts, `GLOBAL`): the style card added no word to
 * "black and white", so "b&w" and "monochrome" stay the looks they were and compile as the words they
 * were. Two of them gained words: "higher contrast" is main's "more contrast", "retro" is its "vintage look".
 */
export const LOOKS = {
  // ── Main's fifteen (rule 3) ──
  "black and white": ["black and white"],
  "b&w": ["b&w"],
  monochrome: ["monochrome"],
  sepia: ["sepia"],
  "golden hour": ["golden hour"],
  "colour grade": ["colour grade"],
  "color grade": ["color grade"],
  grading: ["grading"],
  "film look": ["film look"],
  "vintage look": ["vintage look", "vintage", "retro"],
  warmer: ["warmer"],
  cooler: ["cooler"],
  brighter: ["brighter"],
  darker: ["darker"],
  "more contrast": ["more contrast", "higher contrast", "high contrast"],
  // ── The style vocabulary's seven ──
  moodier: ["moodier", "moody"],
  dramatic: ["dramatic"],
  softer: ["softer", "soft"],
  muted: ["muted", "faded"],
  vibrant: ["vibrant", "punchy", "punchier"],
  cinematic: ["cinematic"],
  editorial: ["editorial"],
} as const satisfies Record<string, readonly string[]>;

/** A look, by its own name. */
export type LookName = keyof typeof LOOKS;

/** Every word she can name a look by, lowercase. */
export const LOOK_WORDS: readonly string[] = Object.values(LOOKS).flat();

const LOOK_OF: ReadonlyMap<string, LookName> = new Map(
  (Object.entries(LOOKS) as [LookName, readonly string[]][]).flatMap(
    ([look, words]) => words.map((w) => [w, look] as const),
  ),
);

/** The look a word names — "moody" → "moodier" — or null for a word that names none. */
export function lookOf(word: string): LookName | null {
  return LOOK_OF.get(word.toLowerCase()) ?? null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Any look word, as whole words. Longest first, so "vintage look" is read before "vintage" and her value
 * is the longer form rule 3 would have stored. Global, so every look she names is seen.
 */
const LOOK_WORD_RE = new RegExp(
  `\\b(?:${[...LOOK_WORDS]
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join("|")})\\b`,
  "g",
);

/**
 * THE ONLY OTHER WORDS A LOOK SENTENCE MAY HOLD. Closed, because a word outside it is something the
 * sentence asks for beyond the look — a thing, her, a condition, an amount — and dropping it would be
 * the fast path losing part of what she said.
 *
 * ⚠️ NOT HERE ON PURPOSE: a word for her ("me", "her" — "make me softer" is not a look of the photo), a
 * negation or a keep ("dont", "not", "keep", "same" — the interpreter reads her keep; this rule would
 * drop it), and an amount ("slightly", "bit", "little", "much", "very" — per-look intensity is not built,
 * so "slightly warmer" asks rather than arriving as "warmer").
 */
export const LOOK_SHAPE_WORDS: ReadonlySet<string> = new Set([
  // The verbs that ask for a look.
  "make",
  "give",
  "turn",
  "add",
  "want",
  "wanna",
  "like",
  "feel",
  "look",
  "looks",
  "be",
  "is",
  // The photograph.
  "it",
  "this",
  "photo",
  "photograph",
  "image",
  "picture",
  "pic",
  "shot",
  "frame",
  "whole",
  "entire",
  "overall",
  "everything",
  // What a look is called.
  "vibe",
  "vibes",
  "feeling",
  "style",
  "tone",
  "tones",
  "mood",
  "aesthetic",
  "filter",
  "grade",
  "lighting",
  "light",
  "colour",
  "colours",
  "color",
  "colors",
  // Small words.
  "a",
  "an",
  "the",
  "of",
  "to",
  "and",
  "more",
  // Her politeness.
  "please",
  "pls",
  "plz",
  "can",
  "could",
  "would",
  "will",
  "you",
  "just",
  "i",
  "id",
  "so",
  "also",
  "now",
  "thanks",
  "thank",
]);

/** Lowercase, apostrophes dropped ("i'd" → "id"), the look words cut out and the rest as its words. */
function normalized(text: string): { looks: string[]; rest: string[] } {
  const lower = text.toLowerCase().replace(/['’]/g, "");
  return {
    looks: [...lower.matchAll(LOOK_WORD_RE)].map((m) => m[0]),
    rest: lower.replace(LOOK_WORD_RE, " ").match(/[a-z0-9]+/g) ?? [],
  };
}

/**
 * RULE 5¾'s reading: her look word, when the sentence is WHOLLY one look — or null.
 *
 * Wholly: every word is a look word or on LOOK_SHAPE_WORDS, and every look word names the SAME look
 * ("make it vintage and retro" is one; "make it moodier and more cinematic" is two, and asks — a
 * photograph has one look, and which she meant is not guessed). The value is the first look word, as
 * rule 3's is.
 *
 * Exported for the interpreter too (interpret/core.ts): a look of hers counts only when the words she
 * used for it are wholly a look, so "make the jersey look vintage" can never come back as a whole-photo
 * vintage look.
 */
export function readWhollyLook(text: string): string | null {
  const { looks, rest } = normalized(text);
  if (!looks.length) return null;
  if (new Set(looks.map((w) => lookOf(w))).size !== 1) return null;
  if (!rest.every((w) => LOOK_SHAPE_WORDS.has(w))) return null;
  return looks[0];
}

/**
 * What a look is CALLED, when it comes right after her word for it — "a dreamy VIBE", "a y2k AESTHETIC",
 * "a dreamy FILTER". Narrower than LOOK_SHAPE_WORDS on purpose: "light", "lighting" and the colour words
 * name things too ("add string lighting" is an object with no place), so they never mark a look here.
 */
const LOOK_NOUNS: ReadonlySet<string> = new Set([
  "look",
  "looks",
  "vibe",
  "vibes",
  "feel",
  "feeling",
  "aesthetic",
  "filter",
  "style",
  "mood",
  "tone",
  "tones",
  "grade",
]);

/**
 * THE LOOK SHE NAMED THAT WE DO NOT HAVE (V.4): her word, when the sentence is a look request in every
 * word but ONE, and that word sits right before a word for a look — "give it a dreamy vibe" → "dreamy",
 * "add a dreamy filter" → "dreamy". Null otherwise, and null whenever she named a look we do have.
 *
 * ⚠️ NARROW ON PURPOSE. "make it dreamy" is a look request too, but "make it" and one word is also "make
 * it bigger" and "make it pop" — words that name no look — so with no word for a look after it, the
 * sentence keeps the catch-all it has today, and the interpreter still reads it.
 */
export function unknownLookWord(text: string): string | null {
  const { looks, rest } = normalized(text);
  if (looks.length) return null;
  const unknown = rest.filter((w) => !LOOK_SHAPE_WORDS.has(w));
  if (unknown.length !== 1) return null;
  const after = rest[rest.indexOf(unknown[0]) + 1] ?? "";
  return LOOK_NOUNS.has(after) ? unknown[0] : null;
}
