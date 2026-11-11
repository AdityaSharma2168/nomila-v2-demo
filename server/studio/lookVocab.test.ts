/**
 * lookVocab.test.ts — the looks she can name, rule 5¾, which reads a sentence that is wholly one, and the
 * honest ask for a look she named that we do not have (`look_unknown`, V.4).
 *
 * ⚠️ EVERY WORD AND SENTENCE BELOW IS WRITTEN OUT BY HAND. A suite that iterates LOOKS and asserts each
 * entry resolves cannot see a deletion — shrink the list and it iterates fewer times and reports green
 * (docs/runbooks/verifying-a-guard-bites.md, the GARMENT_NOUNS lesson). Removing a word goes red here.
 */
import { GLOBAL, route } from "./classify";
import {
  LOOK_WORDS,
  LOOKS,
  lookOf,
  readWhollyLook,
  unknownLookWord,
  type LookName,
} from "./lookVocab";

/** What route() makes of a sentence with her photo: "ASK <code>", or each step as "OP value". */
function read(text: string): string {
  const r = route(text, true);
  if (r.initialPath === "ASK") return `ASK ${r.reason}`;
  return r.steps
    .map((s) => `${s.op}${s.value ? ` ${s.value}` : ""}`)
    .join(" + ");
}

describe("the looks — every word, and the look it names", () => {
  it("has main's fifteen and the style vocabulary's seven, and no other look", () => {
    expect(Object.keys(LOOKS).sort()).toEqual(
      [
        "black and white",
        "b&w",
        "monochrome",
        "sepia",
        "golden hour",
        "colour grade",
        "color grade",
        "grading",
        "film look",
        "vintage look",
        "warmer",
        "cooler",
        "brighter",
        "darker",
        "more contrast",
        "moodier",
        "dramatic",
        "softer",
        "muted",
        "vibrant",
        "cinematic",
        "editorial",
      ].sort(),
    );
  });

  it("maps every word she can use to exactly one look", () => {
    const words: [string, LookName][] = [
      ["black and white", "black and white"],
      ["b&w", "b&w"],
      ["monochrome", "monochrome"],
      ["sepia", "sepia"],
      ["golden hour", "golden hour"],
      ["colour grade", "colour grade"],
      ["color grade", "color grade"],
      ["grading", "grading"],
      ["film look", "film look"],
      ["vintage look", "vintage look"],
      ["vintage", "vintage look"],
      ["retro", "vintage look"],
      ["warmer", "warmer"],
      ["cooler", "cooler"],
      ["brighter", "brighter"],
      ["darker", "darker"],
      ["more contrast", "more contrast"],
      ["higher contrast", "more contrast"],
      ["high contrast", "more contrast"],
      ["moodier", "moodier"],
      ["moody", "moodier"],
      ["dramatic", "dramatic"],
      ["softer", "softer"],
      ["soft", "softer"],
      ["muted", "muted"],
      ["faded", "muted"],
      ["vibrant", "vibrant"],
      ["punchy", "vibrant"],
      ["punchier", "vibrant"],
      ["cinematic", "cinematic"],
      ["editorial", "editorial"],
    ];
    expect(words.map(([w]) => [w, lookOf(w)])).toEqual(words);
    // And no word beyond those: a word added without a row above is red here.
    expect([...LOOK_WORDS].sort()).toEqual(words.map(([w]) => w).sort());
  });

  it("keeps main's fifteen words each their own look, so each compiles as the word it always did", () => {
    for (const w of [
      "black and white",
      "b&w",
      "monochrome",
      "sepia",
      "golden hour",
      "colour grade",
      "color grade",
      "grading",
      "film look",
      "vintage look",
      "warmer",
      "cooler",
      "brighter",
      "darker",
      "more contrast",
    ]) {
      expect({ w, look: lookOf(w) }).toEqual({ w, look: w });
    }
  });

  it("leaves rule 3's own list byte-identical to main — the widened words are rule 5¾'s", () => {
    expect(GLOBAL.source).toBe(
      "\\b(black and white|b&w|monochrome|sepia|golden hour|colou?r grade|grading|film look|vintage look|warmer|cooler|brighter|darker|more contrast)\\b",
    );
    expect(GLOBAL.flags).toBe("i");
  });

  it("names no look for the words it leaves out on purpose", () => {
    for (const w of [
      "warm",
      "cool",
      "film",
      "lighter",
      "dark",
      "pop",
      "better",
      "dreamy",
      "slightly warmer",
    ]) {
      expect({ w, look: lookOf(w) }).toEqual({ w, look: null });
    }
  });
});

describe("readWhollyLook — a sentence that is nothing but one look", () => {
  it("reads her look word from every shape a look request takes", () => {
    const cases: [string, string][] = [
      ["make it moodier", "moodier"],
      ["Make It MOODIER!", "moodier"],
      ["give it a cinematic look", "cinematic"],
      ["moody vibe", "moody"],
      ["give it a retro feel", "retro"],
      ["make it look more cinematic", "cinematic"],
      ["make it feel moodier", "moodier"],
      ["i'd like it moodier", "moodier"],
      ["can you make it more cinematic please", "cinematic"],
      ["make the whole photo moodier", "moodier"],
      ["make the colors more vibrant", "vibrant"],
      ["make the lighting softer", "softer"],
      ["give it soft lighting", "soft"],
      ["add a vintage filter", "vintage"],
      ["make it higher contrast", "higher contrast"],
      // The longer word first, as rule 3 would store it.
      ["give it a vintage look", "vintage look"],
      // Two words for ONE look are one look.
      ["make it vintage and retro", "vintage"],
    ];
    expect(cases.map(([s]) => [s, readWhollyLook(s)])).toEqual(cases);
  });

  it("reads nothing when the sentence asks for anything beyond the look", () => {
    for (const s of [
      // Two looks — a photograph has one, and which she meant is not guessed.
      "make it moodier and more cinematic",
      "make it moody and dramatic",
      // Her — a look of the photo is not a change to her.
      "make me softer",
      "make me look cinematic",
      "make her look more dramatic",
      // Her keep, or a negation — the interpreter reads those; this rule would drop them.
      "make it moodier, dont change anything about me",
      "make it moodier but keep me the same",
      "make it cinematic but not too dark",
      // An amount — per-look intensity is not built, so it asks rather than arriving as the look.
      "make it slightly moodier",
      "make it a bit more cinematic",
      // A thing in the photo.
      "make the jersey vintage",
      "make the sky dramatic",
      "make it cinematic like a movie poster",
      // No look at all.
      "make it pop",
      "make it better",
      "make it dreamy",
      "",
    ]) {
      expect({ s, look: readWhollyLook(s) }).toEqual({ s, look: null });
    }
  });
});

describe("rule 5¾ in route() — the widened words route, and nothing that routes today moves", () => {
  it("routes every new word as one whole-frame look carrying her word", () => {
    const cases: [string, string][] = [
      ["make it moodier", "GLOBAL_STYLE moodier"],
      ["make it moody", "GLOBAL_STYLE moody"],
      ["make it more dramatic", "GLOBAL_STYLE dramatic"],
      ["make it softer", "GLOBAL_STYLE softer"],
      ["make it soft", "GLOBAL_STYLE soft"],
      ["make it muted", "GLOBAL_STYLE muted"],
      ["make it faded", "GLOBAL_STYLE faded"],
      ["make it more vibrant", "GLOBAL_STYLE vibrant"],
      ["make it punchy", "GLOBAL_STYLE punchy"],
      ["make it punchier", "GLOBAL_STYLE punchier"],
      ["make it more cinematic", "GLOBAL_STYLE cinematic"],
      ["make it editorial", "GLOBAL_STYLE editorial"],
      ["make it vintage", "GLOBAL_STYLE vintage"],
      ["make it retro", "GLOBAL_STYLE retro"],
      ["make it higher contrast", "GLOBAL_STYLE higher contrast"],
      ["make it high contrast", "GLOBAL_STYLE high contrast"],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
    expect(route("make it moodier", true).initialPath).toBe("FULL_IMAGE");
  });

  it("routes the phrasings rule 3 never read — the look nouns, and main's own words behind an article", () => {
    const cases: [string, string][] = [
      ["give it a cinematic look", "GLOBAL_STYLE cinematic"],
      ["give it a moody vibe", "GLOBAL_STYLE moody"],
      ["cinematic vibe", "GLOBAL_STYLE cinematic"],
      ["make it look cinematic", "GLOBAL_STYLE cinematic"],
      ["i want it moodier", "GLOBAL_STYLE moodier"],
      ["give it softer light", "GLOBAL_STYLE softer"],
      // Main's words, which asked: "look" ends a noun phrase, so rule 3 saw a region called "vintage".
      ["give it a vintage look", "GLOBAL_STYLE vintage look"],
      ["give it a film look", "GLOBAL_STYLE film look"],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
  });

  it("composes a look beside a change to a thing, and asks for two looks", () => {
    expect(read("make her jersey blue and make it more cinematic")).toBe(
      "RECOLOR blue + GLOBAL_STYLE cinematic",
    );
    // Run order, as main's "…and make it warmer" routes; the freeze puts the background first.
    expect(read("change the background to a stadium and make it moodier")).toBe(
      "GLOBAL_STYLE moodier + CHANGE_BACKGROUND stadium",
    );
    // Two clauses, two looks: rule ½'s conflict — which one is not guessed.
    expect(read("make it warmer, and make it moodier")).toBe(
      "ASK compound_conflict",
    );
  });

  it("keeps main's routing where rule 3 already read the sentence — first look wins (a known fail-open, its own fix PR)", () => {
    // Rule 3 is unchanged and runs first, so these route exactly as on main: the first of MAIN's words,
    // the other look dropped. Changing that is a route → ASK change; this PR makes none. The fix
    // (two looks in one clause → compound_conflict) is recorded with both repros.
    expect(read("make it moodier and warmer")).toBe("GLOBAL_STYLE warmer");
    expect(read("make it warmer and moodier")).toBe("GLOBAL_STYLE warmer");
    expect(read("make it warmer and brighter")).toBe("GLOBAL_STYLE warmer");
    // ⚠️ THE ONE PIN THIS BRANCH CHANGES ON PURPOSE (A3b, ledger F-L2). Rule 3 still reads the look — the
    // same step as on main — but her keep no longer goes nowhere: it rides beside the step as
    // `preserve_person` (studio/keepVocab.ts). Until A3b this pinned main's reading, her keep not read.
    expect(read("make it warmer, dont change anything about me")).toBe(
      "GLOBAL_STYLE warmer",
    );
    expect(
      route("make it warmer, dont change anything about me", true).constraints,
    ).toEqual([{ kind: "preserve_person" }]);
  });

  it("asks, as on main, where the sentence names her, keeps her, or asks for more than the look", () => {
    const cases: [string, string][] = [
      // Her keep stays for the interpreter to read — this is the interpretable ask it always was.
      [
        "make it moodier, dont change anything about me",
        "ASK fast_path_declined",
      ],
      ["make me softer", "ASK fast_path_declined"],
      ["make me look softer", "ASK fast_path_declined"],
      ["make me look cinematic", "ASK fast_path_declined"],
      ["make her look more dramatic", "ASK fast_path_declined"],
      ["make my skin softer", "ASK fast_path_declined"],
      ["make my face softer", "ASK fast_path_declined"],
      ["make my pose more dramatic", "ASK fast_path_declined"],
      ["make my hair vintage", "ASK fast_path_declined"],
      ["make the jersey vintage", "ASK fast_path_declined"],
      ["make the jersey faded", "ASK fast_path_declined"],
      // "make the sky dramatic" stood here until wave A's V4 read a look on the sky as its recolour (classify.test.ts).
      ["make the grass dramatic", "ASK fast_path_declined"],
      ["make it moodier and more cinematic", "ASK fast_path_declined"],
      ["make it slightly moodier", "ASK fast_path_declined"],
      ["make it pop", "ASK fast_path_declined"],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
  });

  it("never takes a sentence another rule reads — a brand's retro kit is still the brand's", () => {
    expect(read("change my jersey to a retro nike jersey")).toBe(
      "REPLACE_OBJECT retro nike jersey",
    );
    expect(read("make the background moodier")).toBe("CHANGE_BACKGROUND");
  });
});

describe("unknownLookWord — a look she named that we do not have (V.4)", () => {
  it("finds her word when it sits right before a word for a look", () => {
    const cases: [string, string][] = [
      ["give it a dreamy vibe", "dreamy"],
      ["dreamy vibe", "dreamy"],
      ["give it a y2k aesthetic", "y2k"],
      ["add a dreamy filter", "dreamy"],
      ["give it a warm tone", "warm"],
      ["can you give it a 90s look please", "90s"],
    ];
    expect(cases.map(([s]) => [s, unknownLookWord(s)])).toEqual(cases);
  });

  it("finds nothing where she named no look, named one we have, or asked for more", () => {
    for (const s of [
      // No word for a look after hers — "make it" and a word is also "make it bigger".
      "make it pop",
      "make it better",
      "make it dreamy",
      "make it look dreamy",
      "make it look better",
      // A look we have.
      "give it a moody vibe",
      // Her, and two words it cannot read.
      "give me a dreamy look",
      "give it a dreamy vibe and a warm tone",
      // "lighting" names a thing too.
      "add string lighting",
      "",
    ]) {
      expect({ s, word: unknownLookWord(s) }).toEqual({ s, word: null });
    }
  });
});

describe("look_unknown in route() — the honest ask, and nothing else moves (V.4)", () => {
  it("asks look_unknown for a look she named that we do not have", () => {
    const cases: [string, string][] = [
      ["give it a dreamy vibe", "ASK look_unknown"],
      ["give it a y2k aesthetic", "ASK look_unknown"],
      // add_unclear's line told her to say where a filter goes.
      ["add a dreamy filter", "ASK look_unknown"],
      // Inside a compound, the clause's own code (composition's d1), not compound_partial.
      ["make her jersey blue and give it a dreamy vibe", "ASK look_unknown"],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
  });

  it("keeps every answer it had where she named no look, named herself, or a brand or design did", () => {
    const cases: [string, string][] = [
      // A word for her is not a look we lack — a list of looks to try is the wrong answer to it.
      ["skin tone", "ASK fast_path_declined"],
      ["hair style", "ASK fast_path_declined"],
      ["give it a face look", "ASK person_mentioned"],
      ["make it pop", "ASK fast_path_declined"],
      ["make it dreamy", "ASK fast_path_declined"],
      ["make it look better", "ASK fast_path_declined"],
      ["give me a dreamy look", "ASK fast_path_declined"],
      ["give it a nike look", "ASK fast_path_declined"],
      ["give it a logo look", "ASK fast_path_declined"],
      ["add string lighting", "ASK add_unclear"],
      ["make it look like a nike commercial", "ASK brand_change"],
      ["give it a moody vibe", "GLOBAL_STYLE moody"],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
  });
});
