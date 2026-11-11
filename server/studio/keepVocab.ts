/**
 * studio/keepVocab — HER KEEP, said beside an edit the rules read: "make it warmer, dont change anything
 * about me" (A3b, 2026-09-14; sweep-4 ledger F-L2; plan v1 §5).
 *
 * ─── WHAT MAIN DID WITH IT ───────────────────────────────────────────────────────────────────────────
 *
 * The interpreter reads her keep as `preserve_person` — but only on a sentence that ASKS. A sentence that
 * routes never reaches it, and the rules read her keep as whatever they read every other word as:
 *
 *   dropped      "make it warmer, dont change anything about me" → the look alone. Rules 3, 5, 1 and 4a
 *                read no region in it, so the keep went nowhere.
 *   a target     "make it golden hour, keep me the same" → RECOLOR [same], compiled "make the same
 *                golden". "the same" is a determiner phrase, so rule 3 stepped aside and rule 5 recoloured
 *                it. The same shape removed "the same" beside a cone.
 *   a value      "change the background to a beach but dont change me" → the setting "beach but dont
 *                change me". Rule 2's value runs to the end of the sentence.
 *   detection    every one of these sent her whole sentence, keep included, to detection as region text.
 *
 * So a keep this module recognizes is set aside BEFORE the rules read the sentence, and rides beside
 * their steps as the interpreter's own `preserve_person` — the version 2 intent, the keep sentence in the
 * prompt, the card's keep line (classify.ts, `route`). Never a target, never dropped, never region text.
 *
 * ─── ONLY ON A SENTENCE THAT ROUTES (Adi's Option A) — OR ONE REFUSED AS AN EDIT OF HER (F-L5) ────────
 *
 * `route` sets a keep aside only when her whole sentence already routes. A sentence that asks is the
 * interpreter's, as it was: its eligibility, R1's recorded cells and every ask's copy are untouched.
 *
 * One ask is not: the person refusal her keep itself caused (ledger F-L5, the preservation fixes, D1).
 * "make my jersey blue, dont change my face" was read whole — RECOLOR [jersey, face] — and the person
 * guard refused the face, so she heard "we don't edit people" about a sentence asking us NOT to. A person
 * code is never the interpreter's (studio/interpret/eligibility.ts), so no path reached it. Now, when the
 * rules refused her sentence as an edit of her and what is left once her keep is set aside routes, it
 * routes — her keep beside it, as above. What is left is read by the same rules and the same guard, so an
 * edit of her beside a keep ("make my arms bigger, dont change my face") is refused exactly as before.
 *
 * ─── A CLOSED SET, AS ONE WHOLE CLAUSE ───────────────────────────────────────────────────────────────
 *
 * Her keep counts only as a whole clause, first or last in her sentence, set off by punctuation or a
 * joiner ("and", "but", "just", "also", "please"). Anything else keeps what the rules did before —
 * pinned both ways in keepVocab.test.ts:
 *
 *   • a keep with nothing beside it ("keep me the same") — there is no edit to route;
 *   • a keep of a THING ("keep the jersey the same", "leave the background alone") — not her, and read
 *     by `readThingKeep` below (F-L4);
 *   • our own compiled words ("keep the person exactly as-is") — never hers;
 *   • a keep in the middle of a sentence, or any wording not below ("keep my smile").
 *
 * "keep everything else the same" is her keep too: the interpreter reads it so (its words for her count
 * "else" and "rest"), and the scope sentence every compile writes ("Keep everything else exactly as-is")
 * already keeps the rest. Absorbed, it adds only the keep sentence for her face, hair, body and pose.
 */

/**
 * THE KEEPS, as she types them — a regex fragment per wording, matched case-insensitively. "don't",
 * "don’t" and "do not" are all "dont"; "exactly" is optional where she can put it.
 */
const KEEP_WORDINGS: readonly string[] = [
  // "dont change me", "don't change anything about me", "do not change my face"
  String.raw`(?:don['’]?t|do\s+not)\s+change\s+(?:me|anything\s+about\s+me|my\s+(?:face|hair|body|pose))`,
  // "keep me the same", "keep me exactly the same", "keep me as i am", "keep me exactly as I am"
  String.raw`keep\s+me\s+(?:exactly\s+)?(?:the\s+same|as\s+i\s+am)`,
  // "keep everything else the same", "keep everything else exactly the same"
  String.raw`keep\s+everything\s+else\s+(?:exactly\s+)?the\s+same`,
  // "change nothing else"
  String.raw`change\s+nothing\s+else`,
  // "keep my face the same", "keep my hair exactly the same", "keep my pose as it is" (F-L5, D2)
  String.raw`keep\s+my\s+(?:face|hair|body|pose)\s+(?:exactly\s+)?(?:the\s+same|as\s+it\s+is)(?:\s+as\s+much\s+as\s+possible)?`,
  // "preserve my face", "preserve the face", "preserve my face as much as possible" (F-L5, D2)
  String.raw`preserve\s+(?:my|the)\s+(?:face|hair|body|pose)(?:\s+as\s+much\s+as\s+possible)?`,
];

const KEEP = `(?:${KEEP_WORDINGS.join("|")})`;

/** Words that join her keep to the rest of her sentence, and politeness around it. */
const JOINERS = String.raw`(?:(?:and|but|just|also|please)\s+)*`;

/** Her keep, LAST: "…, dont change anything about me", "… and keep me the same", "… but dont change me." */
const KEEP_LAST = new RegExp(
  String.raw`^(.*?[a-z0-9"'’)])[\s,.;:!—–-]+${JOINERS}\b${KEEP}(?:\s+please)?[\s.!]*$`,
  "i",
);

/** Her keep, FIRST: "dont change me, just make it warmer", "keep me the same and make it warmer". */
const KEEP_FIRST = new RegExp(
  String.raw`^\s*(?:please\s+)?${KEEP}\s*(?:[,.;:!—–-]|\s(?=(?:and|but|just|also)\b))\s*${JOINERS}(\S.*)$`,
  "i",
);

/**
 * Her sentence with her keep set aside — `rest` in her own words and casing — or null when it holds no
 * keep this module recognizes, or nothing but one. A keep at each end is read once each.
 */
export function readKeep(text: string): { rest: string } | null {
  let rest = text.trim();
  let found = false;
  const last = KEEP_LAST.exec(rest);
  if (last) {
    rest = last[1].trim();
    found = true;
  }
  const first = KEEP_FIRST.exec(rest);
  if (first) {
    rest = first[1].trim();
    found = true;
  }
  return found && /[a-z0-9]/i.test(rest) ? { rest } : null;
}

// ═══ A KEEP OF A THING (ledger F-L4; the preservation fixes, K2) ═══════════════════════════════════════

/**
 * ─── WHAT MAIN DID WITH IT ───────────────────────────────────────────────────────────────────────────
 *
 * No rule reads "keep", "leave … alone", "dont change" or "dont touch" — none leads a clause (classify.ts,
 * OPERATION_VERBS) — so a keep of a thing stayed inside the one clause a rule read, and that rule took its
 * noun as its own:
 *
 *   a target     "remove the cone but keep the ball" → REMOVE [cone, ball]: both removed. Rule 1 and rule
 *                4a claim every determiner phrase; rule 5 recoloured "make everything blue but keep my
 *                cleats" as the cleats ALONE.
 *   a value      "change the background to a beach but keep the bench" → the setting "beach but keep the
 *                bench". Rule 2's value runs to the end of the sentence.
 *   the change   "dont change the background, just make it warmer" → a background change.
 *   detection    her whole sentence, keep included, as region text — so the kept thing was looked for too.
 *
 * So a keep of a thing this module recognizes is set aside BEFORE the rules read the sentence, and the rules
 * read the rest (classify.ts, `route`). It rides beside nothing: the scope sentence every native compile
 * writes ("Keep everything else exactly as-is — change only the socks") already keeps it, as it keeps
 * everything she did not name. Where the rest would change the thing she kept — it names it, or it is a look
 * or a background, which change the whole photo — the sentence asks (`keep_conflict`). A keep line of its own
 * on the card and in the prompt is a follow-up (ledger F-L7).
 *
 * ─── A CLOSED SET, AS ONE WHOLE CLAUSE (D6) ──────────────────────────────────────────────────────────
 *
 * Four wordings, a determiner, and one to three words for the thing, first or last in her sentence, set off
 * as her keep is. Anything else keeps what the rules did before:
 *
 *   • a keep carrying a colour or a look ("keep the jersey red") — it may be an instruction, and reads as
 *     today (D6; classify.ts checks the value, since the colours are the rules' vocabulary);
 *   • her, or a part of her, as the thing ("keep my arms the same") — her keep is `readKeep`'s, and a part
 *     of her no rule may edit is the person guard's (classify.ts);
 *   • a thing that is not one phrase ("keep the ball and the cone", "keep the cone away");
 *   • a keep in the middle of a sentence.
 */

/** The thing she keeps: a determiner, then one to three words (`THING_WORD` below says which words). */
const THING = String.raw`(?:my|the|her)\s+([a-z][a-z'’-]*(?:\s+[a-z][a-z'’-]*){0,2}?)`;

/** How she says it stays — optional after "keep", required after "leave". */
const AS_IT_IS = String.raw`(?:exactly\s+)?(?:the\s+same|as\s+(?:it|they)\s+(?:is|are)|as\s+is|as-is|unchanged|untouched|alone|where\s+(?:it|they)\s+(?:is|are|was|were))`;

/** THE KEEPS OF A THING, as she types them (D6's four) — one capture group each, the thing. */
const THING_KEEP_WORDINGS: readonly string[] = [
  // "keep the jersey the same", "keep my cleats", "keep the ball where it is"
  String.raw`keep\s+${THING}(?:\s+${AS_IT_IS})?`,
  // "leave the cleats alone", "leave the background as it is"
  String.raw`leave\s+${THING}\s+${AS_IT_IS}`,
  // "dont change the cleats", "don't change my cleats", "do not change the bench"
  String.raw`(?:don['’]?t|do\s+not)\s+change\s+${THING}`,
  // "dont touch my cleats"
  String.raw`(?:don['’]?t|do\s+not)\s+touch\s+${THING}`,
];

/**
 * ─── A LIST SHE KEPT (wave A, V6; ledger F-L4) ─────────────────────────────────────────────────────────────
 *
 * "keep the ball, cone and bench, and remove the net" was read as a keep of the ball with a rest of "cone and bench,
 * and remove the net" — which leads no change, so #488 read no keep at all (a deliberate narrow) and rule 1 froze
 * REMOVE [ball, net]: the ball she kept, removed. A list is two to four things, each as a single keep reads one
 * (a determiner optional past the first), joined by commas and a final "and". It is read before the single thing,
 * in the same four wordings and at the same two ends, and every item must pass the single thing's word check.
 * What else a kept item may not be — her, a colour, our own preservation sentence — is `route`'s (classify.ts).
 */
const ITEM = String.raw`[a-z][a-z'’-]*(?:\s+[a-z][a-z'’-]*){0,2}?`;
const THING_LIST = String.raw`(?:my|the|her)\s+(${ITEM}(?:\s*,\s*(?:(?:my|the|her)\s+)?${ITEM}){0,2}\s*,?\s+and\s+(?:(?:my|the|her)\s+)?${ITEM})`;
const LIST_KEEP_WORDINGS: readonly string[] = [
  String.raw`keep\s+${THING_LIST}(?:\s+${AS_IT_IS})?`,
  String.raw`leave\s+${THING_LIST}\s+${AS_IT_IS}`,
  String.raw`(?:don['’]?t|do\s+not)\s+change\s+${THING_LIST}`,
  String.raw`(?:don['’]?t|do\s+not)\s+touch\s+${THING_LIST}`,
];

/** Her keep of a thing, LAST: "…but keep the ball", "…, leave the cleats alone". Groups: rest, thing. */
const THING_KEEP_LAST = THING_KEEP_WORDINGS.map(
  (w) =>
    new RegExp(
      String.raw`^(.*?[a-z0-9"'’)])[\s,.;:!—–-]+${JOINERS}\b${w}(?:\s+please)?[\s.!]*$`,
      "i",
    ),
);

/** Her keep of a thing, FIRST: "keep the jersey the same and make the socks blue". Groups: thing, rest. */
const THING_KEEP_FIRST = THING_KEEP_WORDINGS.map(
  (w) =>
    new RegExp(
      String.raw`^\s*(?:please\s+)?${w}\s*(?:[,.;:!—–-]|\s(?=(?:and|but|just|also)\b))\s*${JOINERS}(\S.*)$`,
      "i",
    ),
);

/** A list she kept, LAST and FIRST (V6) — the same shapes as a single thing's. */
const LIST_KEEP_LAST = LIST_KEEP_WORDINGS.map(
  (w) =>
    new RegExp(
      String.raw`^(.*?[a-z0-9"'’)])[\s,.;:!—–-]+${JOINERS}\b${w}(?:\s+please)?[\s.!]*$`,
      "i",
    ),
);
const LIST_KEEP_FIRST = LIST_KEEP_WORDINGS.map(
  (w) =>
    new RegExp(
      String.raw`^\s*(?:please\s+)?${w}\s*(?:[,.;:!—–-]|\s(?=(?:and|but|just|also)\b))\s*${JOINERS}(\S.*)$`,
      "i",
    ),
);

/**
 * Words a kept thing is never made of: joiners, pronouns, and the words that make "keep" an instruction
 * rather than a keep ("keep the cone AWAY", "keep the ball OUT of frame"), or say which thing she means only
 * beside another ("the ball AND the cone").
 */
const NOT_A_THING_WORD: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "my",
  "her",
  "his",
  "your",
  "their",
  "this",
  "that",
  "these",
  "those",
  "and",
  "or",
  "but",
  "then",
  "also",
  "just",
  "please",
  "so",
  "too",
  "still",
  "only",
  "it",
  "them",
  "me",
  "you",
  "us",
  "everything",
  "anything",
  "nothing",
  "else",
  "rest",
  "same",
  "exactly",
  "as",
  "is",
  "are",
  "was",
  "were",
  "be",
  "where",
  "when",
  "if",
  "to",
  "into",
  "onto",
  "on",
  "in",
  "at",
  "of",
  "off",
  "out",
  "up",
  "down",
  "away",
  "over",
  "under",
  "behind",
  "with",
  "without",
  "for",
  "from",
  "by",
  "near",
  "next",
  "there",
  "here",
  "more",
  "less",
]);

/**
 * Her sentence with a keep of a thing set aside — `rest` in her own words and casing, `thing` lowercased,
 * and `at` which end it was — or null when it holds none this module recognizes. One keep of a thing is
 * read, last before first.
 *
 * ⚠️ A KEEP FIRST IS ONLY THE CLAUSE, NOT THE LIST IT MAY START. "keep the ball, cone and bench, and remove the
 * net" reads a keep of the ball and a rest of "cone and bench, and remove the net" — whose removal would take
 * two things she kept. So a keep read first says so, and the caller holds the rest to leading a change of its
 * own (classify.ts, `keptThing`, by the rules' own verbs).
 */
export function readThingKeep(text: string): {
  rest: string;
  thing: string;
  at: "first" | "last";
  /** The kept things one by one — present only when she kept a list (V6). */
  things?: string[];
} | null {
  const said = text.trim();
  const found = (rest: string, thing: string, at: "first" | "last") => {
    const words = thing.toLowerCase().replace(/’/g, "'").split(/\s+/);
    if (words.some((w) => NOT_A_THING_WORD.has(w))) return null;
    if (!/[a-z0-9]/i.test(rest)) return null;
    return { rest: rest.trim(), thing: words.join(" "), at };
  };
  // A list: each item read as a single thing is, its determiner dropped. "thing" is the list as she said it.
  const foundList = (rest: string, list: string, at: "first" | "last") => {
    const said = list.toLowerCase().replace(/’/g, "'").replace(/\s+/g, " ");
    const items = said
      .split(/\s*,\s*(?:and\s+)?|\s+and\s+/)
      .map((item) => item.replace(/^(?:my|the|her)\s+/, ""));
    const each = items.map((item) => found(rest, item, at));
    if (items.length < 2 || each.some((e) => !e)) return null;
    return { rest: rest.trim(), thing: said, at, things: items };
  };
  for (const re of LIST_KEEP_LAST) {
    const m = re.exec(said);
    const got = m && foundList(m[1], m[2], "last");
    if (got) return got;
  }
  for (const re of THING_KEEP_LAST) {
    const m = re.exec(said);
    const got = m && found(m[1], m[2], "last");
    if (got) return got;
  }
  for (const re of LIST_KEEP_FIRST) {
    const m = re.exec(said);
    const got = m && foundList(m[2], m[1], "first");
    if (got) return got;
  }
  for (const re of THING_KEEP_FIRST) {
    const m = re.exec(said);
    const got = m && found(m[2], m[1], "first");
    if (got) return got;
  }
  return null;
}
