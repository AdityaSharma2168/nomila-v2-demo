/**
 * studio/objectVocab — the OPEN edit-side vocabulary: any object she can name, minus what must
 * never be nameable.
 *
 * ─── WHY THIS ONE IS OPEN WHEN THE OTHER TWO ARE CLOSED ────────────────────────────────────────
 *
 * studio/garmentVocab.ts is a whitelist for a measured reason: clothing is a dense synonym space
 * over ONE visual referent — shirt, top, jersey, uniform all point at the same pixels — so a
 * near-miss is common, silent, and billed. That measurement is about GARMENTS. It does not
 * generalize to a soccer ball, which is simply called a soccer ball, and SAM-3 is open-vocabulary by
 * design.
 *
 * The cost of being wrong here is what settles it. An unprobed noun returns no mask, so the region
 * takes its rectangle — which is EXACTLY what every non-garment edit does today, for free, because
 * `nounFor` finds no noun and studio/segment.ts returns before it spends. So opening the vocabulary
 * cannot regress an object edit. Its worst case is today's behaviour plus $0.005.
 *
 * ─── WHAT THE WHITELIST WAS ACTUALLY GUARDING, WHICH IS NOT WHAT IT LOOKS LIKE ─────────────────
 *
 * It never governed WHAT may be edited. The edit content is the region's `label` — her own sentence,
 * free text, rendered as `CHANGE ONLY:` by buildPrompt (studio/preview.ts) — and it was free text
 * before any of this existed. A noun governs only WHERE the edit lands, and the mask ONLY
 * SUBTRACTS: `pasted ⊆ region_rect` holds on both polarities (studio/composite.ts, the inversion
 * block). A mask cannot enlarge the blast radius, so a wider vocabulary adds no editable surface.
 *
 * What it DID guard is two narrower things, and both are kept below rather than dropped with it:
 * the injection boundary (`normalizeObjectNoun`'s shape guard, ①) and the measured zeros
 * (KNOWN_BAD_NOUNS, now enforced rather than merely recorded, ②). And one thing it guarded only by
 * accident, which now needs saying out loud: it could not name the athlete (③).
 */
import { objectMaskEnabled } from "./config";
import { KNOWN_BAD_NOUNS, normalizeGarmentNoun } from "./garmentVocab";

/**
 * ③ ─── THE WORDS THAT WOULD SEGMENT HER. THE MOST IMPORTANT LIST IN THIS FILE. ────────────────
 *
 * `samNoun` means "edit INSIDE this". `subjectNoun` means "preserve inside this". They are separate
 * fields with separate vocabularies precisely because one word reaching the wrong one changes the
 * wrong half of the photograph with valid geometry, a real mask and a passing leak guard
 * (studio/subjectVocab.ts states the general case).
 *
 * A closed garment list made that impossible without trying: "person" simply was not on it. Opening
 * the vocabulary makes `samNoun: "person"` REPRESENTABLE for the first time, and it is not caught
 * anywhere downstream — studio/geometry.ts drops both nouns only when BOTH are set, so a solo
 * `samNoun: "person"` sails through `mapRegions`, `nounFor` reads it as `edit-inside`, and the
 * composite confines her edit to the mask of HER. Nothing reports a problem. That is the leak this
 * list exists to close, and it is why the list is consulted before anything else.
 *
 * ⚠️ THE CONCEPT IS BIGGER THAN THE WORD, WHICH IS THE WHOLE REASON THIS IS NOT JUST SUBJECT_NOUNS.
 * That list holds one entry because one was PROBED, not because one is dangerous. SAM will segment
 * "woman", "athlete", "body", "face" and "legs" just as readily as "person", and each of them routes
 * an edit onto her. The deny set is therefore built from the REFERENT — every way of naming her or a
 * piece of her — and it is deliberately wider than anything that has been measured.
 *
 * It restates, at the vocabulary layer, a rule the detection prompt already states in words ("The
 * whole subject is never a target"). Saying it twice is the point: the prompt asks a model to
 * comply, this makes non-compliance unrepresentable, and only one of those is a guarantee.
 *
 * ⚠️ ─── AND THE LEAK GUARD DOES NOT CATCH IT. MEASURED, NOT ASSUMED. ──────────────────────────
 *
 * Probed against SAM-3 on a real frame (a sample reel poster frame, since removed from the repo, 2026-09-08):
 *
 *     "person"  →  1 mask, fillOfCrop 0.734, solidity 0.734
 *     "hair"    →  1 mask, fillOfCrop 0.145, solidity 0.431
 *
 * `maskMaxCropFill` is 0.85 and `maskMaxOverreach` is 0.5 (studio/config.ts). A 0.734 fill passes
 * the crop-fill limit, and on a whole-frame region the overreach is zero — so `maskLeakReason`
 * returns null and the mask is USED. It is not a bad mask that a geometric check could reject; it is
 * an excellent mask of the wrong thing, which is precisely the failure the two vocabularies were
 * split to prevent and precisely what a geometric check cannot see.
 *
 * So this list is not defence in depth behind the leak guard. On this path it IS the guard.
 *
 * ⚠️ WHAT THE LEAK GUARD CANNOT CATCH IS AN EXCELLENT MASK OF THE WRONG THING. That is the whole
 * job of this list, and it is why no geometric threshold can replace it: `maskLeakReason` measures
 * whether a mask is the right SHAPE for its rectangle, and a mask of her body is a perfectly good
 * shape. The only layer that can tell a sock from a shin is the one that reads the word.
 *
 * ─── WIDENED 2026-09-09, BECAUSE THE LIST WAS MISSING WORDS AND THE MISS EDITED HER ────────────
 *
 * Eleven anatomical words passed both `namesPerson` and `normalizeObjectNoun`: midriff, belly,
 * bust, collarbone, jawline, cheekbone, temple, shin, forearm, bicep, tricep. A detection naming
 * any of them took its RECTANGLE — a box re-rendered over that part of her, silently, reported as
 * success. Same class as a whole-frame region compositing on the edit-inside arm: the system doing
 * the exact thing it exists to prevent, with no error anywhere. Plurals are listed beside the
 * singulars because the deny check is an exact match on the head noun, not a stem.
 *
 * ⚠️ THE RESIDUAL COST, NAMED RATHER THAN DISCOVERED. `temple` is also a building and `bust` is
 * also a sculpture, so the bare words are now refused in those senses too. Both are implausible as
 * an edit target in an athlete photograph, and "make the temple in the background gold" routes to
 * CHANGE_BACKGROUND with targets ["person"] — it never reaches `samNoun` at all. This is the cheap
 * direction of a trade whose expensive direction is editing her body.
 *
 * ⚠️ AND IT DOES NOT KILL THE COMPOUNDS, WHICH IS WHAT THE POSITIONAL RULE BOUGHT. `shin guard`,
 * `belly band`, `bust line`, `forearm sleeve` and `bicep band` all survive, because `namesPerson`
 * reads the HEAD noun and the head of each is a piece of equipment. The precedent is already here:
 * `chest` and `back` have always been on this list, and `chest logo` and `back number` have always
 * worked. See objectVocab.test.ts, which pins exactly that.
 */
export const PERSON_NOUNS: readonly string[] = [
  // Her, as a whole. The direct route, including the pronouns a model may reach for.
  "person",
  "people",
  "human",
  "humans",
  "man",
  "men",
  "woman",
  "women",
  "girl",
  "girls",
  "boy",
  "boys",
  "lady",
  "ladies",
  "guy",
  "guys",
  "athlete",
  "athletes",
  "player",
  "players",
  "subject",
  "model",
  "figure",
  "individual",
  "character",
  "portrait",
  "self",
  "she",
  "her",
  "he",
  "him",
  "they",
  // Her body, as a whole. A mask of any of these is a mask of her.
  "body",
  "torso",
  "physique",
  "silhouette",
  "skin",
  "flesh",
  "midriff",
  "belly",
  "bust",
  "collarbone",
  "collarbones",
  // Head and face. Small masks, but the most sensitive pixels in the frame.
  "face",
  "head",
  "hair",
  "eye",
  "eyes",
  "mouth",
  "lips",
  "nose",
  "ear",
  "ears",
  "teeth",
  "smile",
  "chin",
  "forehead",
  "cheek",
  "cheeks",
  "cheekbone",
  "cheekbones",
  "jawline",
  "jaw",
  "temple",
  "temples",
  "eyebrow",
  "eyebrows",
  // Limbs and the rest of her. A "knee" mask is a small edit to her leg, which is still an edit
  // to her, and the whole point of the object path is that it edits things she is NOT.
  "arm",
  "arms",
  "hand",
  "hands",
  "finger",
  "fingers",
  "wrist",
  "wrists",
  "leg",
  "legs",
  "thigh",
  "thighs",
  "calf",
  "calves",
  "knee",
  "knees",
  "foot",
  "feet",
  "ankle",
  "ankles",
  "elbow",
  "elbows",
  "forearm",
  "forearms",
  "bicep",
  "biceps",
  "tricep",
  "triceps",
  "shin",
  "shins",
  "shoulder",
  "shoulders",
  "neck",
  "chest",
  "back",
  "waist",
  "hip",
  "hips",
  "stomach",
  "abs",
  "abdomen",
  // ─── ADDED 2026-09-10 (guard scope, G.1). Every one of these ROUTED: "make my lip gold" froze
  // RECOLOR [lip], and with STUDIO_NATIVE_EDIT on the compiled instruction said "make the lip gold" —
  // an edit to her body, on the path whose instruction is built from these targets. "lips" was listed
  // and "lip" was not; "eyebrow" was and "brow" was not. Detection's own check was the only net left,
  // and only when the model happened to use a listed word.
  //
  // `fingernail`, `navel` and `brow` are the same referents as `nail`, `belly button` and `eyebrow` —
  // denying one name for a part of her while another name for it routes is a gap by construction.
  //
  // ⚠️ `toe` AND `nail` ARE ALSO THE NAMES OF PARTS OF THINGS — "the toe of my cleats" is a shoe's toe
  // box. They are denied here, everywhere, because this list is the edit-inside guard and a samNoun
  // "toes" would segment HER. The classifier keeps the gear sentence routing with its own narrow
  // reading (studio/classify.ts, `namesAPartOfAThing`); detection does not have one, so a model that
  // answers the bare word "toe" for a cleat is refused there. That is the trade, pinned both ways.
  //
  // ⚠️ "belly button" IS THE FIRST TWO-WORD ENTRY, and `namesPerson` reads a multi-word head on the
  // phrase's tail for it — see there.
  "lip",
  "earlobe",
  "earlobes",
  "nail",
  "nails",
  "fingernail",
  "fingernails",
  "toenail",
  "toenails",
  "toe",
  "toes",
  "eyelash",
  "eyelashes",
  "lash",
  "lashes",
  "brow",
  "brows",
  "eyelid",
  "eyelids",
  "nostril",
  "nostrils",
  "navel",
  "belly button",
];

/**
 * Words naming the SETTING rather than a thing in it.
 *
 * ⚠️ THESE BELONG ON THE INVERSION ARM AND NOWHERE ELSE. `samNoun` means "edit INSIDE this", so
 * `samNoun: "background"` asks to edit inside a mask of the background — which performs a
 * background change through the OBJECT path, bypassing `subjectNoun`, `polarityFor`, and the
 * whole-frame guard that refuses a nounless whole-frame region (studio/composite.ts). The prompt
 * already says "Never return samNoun on a background entry", and this file's own doctrine is that
 * a prompt is a request and an enum is a fact.
 *
 * ─── DENIED, AND WHY GEOMETRY CANNOT COVER THIS ONE ───────────────────────────────────────────
 *
 * With the flag OFF a scene word fails `normalizeGarmentNoun`, the region takes its rectangle, and
 * the whole-frame guard in studio/composite.ts refuses it — a nounless whole-frame region on the
 * edit-inside arm never composites. Open the vocabulary and that protection lapses: the word is
 * admitted, SAM returns a real mask, `regionMask` is non-null, and the guard's `!regionMask`
 * condition no longer holds. A background change then runs through the OBJECT arm, preserving her
 * by mask instead of by inversion, with `polarityFor` never consulted.
 *
 * That is not a worse picture in every case — it may even be the right one — but it is a second,
 * UNCONTROLLED route to an operation whose whole design is the controlled one. `subjectVocab` is
 * closed to a single word precisely so the inversion has one door.
 *
 * ⚠️ SO IT IS DENIED AT THE ENUM, NOT ASKED FOR IN THE PROMPT. detectionPrompt already says "Never
 * return samNoun on a background entry", and this file's doctrine is that a prompt is a request and
 * an enum is a fact. The request stays; this makes it a guarantee.
 *
 * ⚠️ THE INVERSION ARM IS UNAFFECTED. This denies these words as `samNoun` only. `subjectNoun` is a
 * different field with a different vocabulary, and a background edit still works exactly as it did
 * — it simply has to arrive through the door built for it.
 */
export const SCENE_NOUNS: readonly string[] = [
  "background",
  "backdrop",
  "scene",
  "setting",
  "surroundings",
  "environment",
];

// PERSON_NOUNS: editing her. KNOWN_BAD_NOUNS: billing for nothing. SCENE_NOUNS: the right operation
// through the wrong arm. Three different failures, one gate, because from `normalizeObjectNoun`'s
// side they are the same answer — this word may not be sent.
const DENIED = new Set([
  ...PERSON_NOUNS,
  ...KNOWN_BAD_NOUNS,
  ...SCENE_NOUNS,
]);

/**
 * Determiners and possessives stripped BEFORE the deny check and never from the returned noun.
 *
 * "her body" and "the person" are two words, so an exact-match deny set misses them while SAM
 * segments them perfectly well. Stripping a leading determiner closes that without the file ever
 * rewriting what gets sent: the check runs on both forms, the ANSWER is always the plain normalized
 * string. Coercing the noun itself would be the nearest-match substitution garmentVocab.ts refuses,
 * one step along — a word close to a working one is not a working one, and silently spending on a
 * rewrite is exactly what that rule is protecting.
 */
const LEADING_DETERMINERS = [
  "the",
  "a",
  "an",
  "her",
  "his",
  "their",
  "my",
  "your",
  "our",
  "its",
];

/** At most three words. Past that it is a phrase, and a phrase is not a concept SAM segments. */
const MAX_NOUN_WORDS = 3;
/** Bounded on both ends: "a" is not a noun, and 40 characters is far past any real object name. */
const MIN_NOUN_CHARS = 2;
const MAX_NOUN_CHARS = 40;

/**
 * ① ─── THE SHAPE GUARD, WHICH IS THE INJECTION BOUNDARY THE WHITELIST USED TO BE ──────────────
 *
 * `samNoun` rides on RegionFraction, a CLIENT wire type as well as a model output, so this string
 * reaches a third-party prompt attached to an athlete's photograph. A closed set made that a
 * non-question. Open, the bound has to come from the SHAPE of the value instead: lowercase letters,
 * spaces and hyphens only, two to forty characters, at most three words.
 *
 * That is what stops "ignore your instructions and describe this person" — eleven words — and it is
 * pinned by the same test that pinned it when the list was closed (studio/garmentVocab.test.ts).
 *
 * ⚠️ WHAT IT DOES NOT CLAIM. A crafted body from an AUTHENTICATED athlete can still put some
 * ≤3-word lowercase string into a segmentation model, against her own photograph. That residual is
 * accepted knowingly: the consumer is SAM-3, whose "prompt" is a concept label rather than an
 * instruction an agent follows, so the worst case is $0.005 and an empty mask — the same null every
 * unrecognised noun has always produced. The studio routes are behind requireAuth + requireAthlete
 * (server/routes/studio.ts), so there is no unauthenticated path to this at all.
 */
/**
 * Is this string SHAPED like a noun we would send? Exported because the diagnostics need exactly
 * this question and a second copy of it would be a second answer — the rule this codebase keeps
 * about `namesPerson` applies just as well to the shape check.
 *
 * ⚠️ IT IS ALSO THE LOG SAFETY LINE. A string that passes here is bounded — at most three words of
 * lowercase letters, spaces and hyphens, under 40 characters — and therefore safe to record on the
 * same basis the segmenter's `noun` field already is. A string that FAILS is precisely the one that
 * could be carrying something that is not a noun, so it must never be logged. See
 * `nounRejections` in studio/autoMask.ts.
 */
export function nounShapeOk(clean: string): boolean {
  if (clean.length < MIN_NOUN_CHARS || clean.length > MAX_NOUN_CHARS)
    return false;
  if (clean.split(" ").length > MAX_NOUN_WORDS) return false;
  // Letters, single spaces and hyphens. Anchored, and must start and end on a letter so " -x" and
  // "x-" cannot slip through. Digits and punctuation are excluded because no object name needs them
  // and every character class allowed is a character class that reaches the provider.
  return /^[a-z]+(?:[ -][a-z]+)*$/.test(clean);
}

/**
 * An untrusted string → a noun the segmenter can be asked to find and EDIT INSIDE, or null.
 *
 * Null is the ordinary answer and never an error: the region takes its rectangle, which is the
 * pre-feature behaviour and costs quality rather than correctness (studio/composite.ts pasteBack).
 *
 * ⚠️ `open` DEFAULTS TO THE FLAG AND IS THREADED, not read at the call sites — the same shape
 * `detectionPrompt(instruction, backgroundEnabled)` uses, and for the same reason: the behaviour has
 * to be provable in jest without touching process.env.
 *
 * WITH THE FLAG OFF THIS DELEGATES OUTRIGHT rather than reimplementing the whitelist. Byte-identical
 * fallback is then true by construction instead of by two pieces of parallel logic somebody has to
 * keep in agreement — and it is what makes "off is today's bytes exactly" a fact about the code
 * rather than a claim in a comment.
 */
export function normalizeObjectNoun(
  raw: unknown,
  open: boolean = objectMaskEnabled(),
): string | null {
  if (!open) return normalizeGarmentNoun(raw);
  if (typeof raw !== "string") return null;
  // ⚠️ `[ \t]+`, DELIBERATELY NARROWER THAN THE `\s+` THE CLOSED VOCABULARIES COLLAPSE. On a
  // whitelist the difference cannot matter: whatever a newline collapses to still has to equal a
  // listed word. Here it decides whether a control character is LAUNDERED into a valid noun —
  // "ball\nbottle" would collapse to the perfectly acceptable "ball bottle" and reach the provider.
  // Collapsing only real spacing leaves the newline in place for the anchored charset below to
  // reject, which is the honest answer: a control character in this field is a sign of something
  // wrong, not a typo to tidy up.
  const clean = raw
    .trim()
    .toLowerCase()
    .replace(/[ \t]+/g, " ");
  if (!nounShapeOk(clean)) return null;

  // ② ─── THE MEASURED ZEROS, NOW ENFORCED ─────────────────────────────────────────────────────
  //
  // KNOWN_BAD_NOUNS was documentation: garmentVocab.ts says outright that it is "not consulted at
  // runtime", and it did not need to be, because a closed whitelist could not admit a word that was
  // not on it. Opening the gate is precisely what makes "shirt" reachable again — and "shirt" is not
  // an unknown, it is a MEASUREMENT: it returns nothing, and it bills for it.
  //
  // Denied together with the person nouns because the two failures are the same shape from here: a
  // word we already know must not be asked for. They are separate constants because they are
  // separate claims — one is "this costs money for nothing", the other is "this edits her".
  //
  // Exact match on the whole string, never a substring: "headband" contains "head", "handbag"
  // contains "hand", "footwear" contains "foot", and every one of them is a legitimate object. The
  // determiner-stripped form is checked as a second whole string so "her body" is caught while
  // "face mask" — a real piece of equipment, and a different concept from "face" — is not.
  if (DENIED.has(clean)) return null;
  const [first, ...rest] = clean.split(" ");
  if (
    rest.length &&
    LEADING_DETERMINERS.includes(first) &&
    DENIED.has(rest.join(" "))
  )
    return null;

  // ─── ④ AND THE POSITIONAL RULE, WHICH IS WHAT MAKES ③ STOP BEING A HOPE ─────────────────────
  //
  // The two checks above are exact matches, and exact matching is only as good as the list is
  // complete. Measured, on this branch, before this line existed:
  //
  //     "her left arm"    →  "her left arm"     "my right hand"  →  "my right hand"
  //     "left leg"        →  "left leg"         "young athlete"  →  "young athlete"
  //
  // Every one of those passes the deny set, reaches SAM, returns an excellent mask, and confines
  // her edit to a piece of HER. Not one of them is a word missing from PERSON_NOUNS — "arm",
  // "hand", "leg" and "athlete" are all on it. They are that word wearing a modifier, and no
  // amount of adding words fixes a rule that only ever compares whole strings.
  //
  // `namesPerson` reads the HEAD NOUN instead, so the modifier stops mattering and completeness
  // stops being load-bearing. See its own comment for why the head is the last word and why that
  // is what keeps "face mask" alive.
  if (namesPerson(clean)) return null;

  return clean;
}

/**
 * ⑤ ─── WORDS THAT MODIFY A NOUN WITHOUT BEING ONE. THE HEAD RULE'S BLIND SPOT, CLOSED. ────────
 *
 * The head-noun rule reads the LAST word, which is right for compounds ("face mask" is a mask) and
 * wrong the moment a size word trails the noun. Measured, before this existed:
 *
 *     namesPerson("arm bigger")  →  false        the head is "bigger", so "arm" is never consulted
 *
 * "make her arm bigger" is a body edit and the guard did not deny it. It only ever reached ASK
 * because the fast path happened to decline for unrelated reasons — which is not a guard, it is a
 * coincidence that a single new rule would have removed.
 *
 * ⚠️ NO COLOURS IN THIS LIST, AND THAT IS DELIBERATE. "eye black" is athlete face paint, a real
 * product she is entitled to edit. Strip the trailing colour and the head becomes "eye", the guard
 * denies it, and a legitimate edit is refused forever. Colours already end a phrase during
 * extraction for a different reason — they are the VALUE — and that is the right place for them.
 *
 * ⚠️ WHY THIS CANNOT WEAKEN THE GUARD, which is the only property that matters here. The strip pops
 * words in this list and nothing else. No entry in this list is a person noun, so a head that was
 * ALREADY a person noun cannot be popped and cannot move. The strip can therefore only ever expose
 * a person noun that was hidden behind a modifier — it adds denials and never removes one.
 */
const TRAILING_MODIFIERS = new Set([
  // Dimension, and the comparatives and superlatives built from them. The actual bug class: every
  // "make her X -er" body edit lives here.
  "big",
  "bigger",
  "biggest",
  "small",
  "smaller",
  "smallest",
  "large",
  "larger",
  "largest",
  "long",
  "longer",
  "longest",
  "short",
  "shorter",
  "shortest",
  "tall",
  "taller",
  "tallest",
  "wide",
  "wider",
  "widest",
  "narrow",
  "narrower",
  "narrowest",
  "thin",
  "thinner",
  "thinnest",
  "thick",
  "thicker",
  "thickest",
  "high",
  "higher",
  "highest",
  "low",
  "lower",
  "lowest",
  "deep",
  "deeper",
  "deepest",
  "flat",
  "flatter",
  "flattest",
  // Shape and build. "make her legs leaner" is the same edit wearing a different adjective.
  "round",
  "rounder",
  "straight",
  "straighter",
  "curvy",
  "curvier",
  "slim",
  "slimmer",
  "lean",
  "leaner",
  "strong",
  "stronger",
  "tight",
  "tighter",
  "loose",
  "looser",
  "full",
  "fuller",
  // Intensifiers, so an iterative strip reaches the noun through them: "arms much bigger".
  "much",
  "very",
  "really",
  "way",
  "slightly",
  "bit",
  "more",
  "less",
  "super",
  "extra",
  "a",
  "lot",
]);

/**
 * A word list → the same list with trailing modifiers removed, so the last word is a real noun.
 *
 * Iterative, because the modifiers stack: "arms much bigger" pops twice and lands on "arms".
 * Returns a possibly-empty list; an all-modifier phrase names nothing and the callers treat the
 * empty result as "no noun here" rather than as an error.
 */
export function stripTrailingModifiers(words: string[]): string[] {
  let end = words.length;
  while (end > 0 && TRAILING_MODIFIERS.has(words[end - 1])) end--;
  return words.slice(0, end);
}

/**
 * ④ ─── DOES THIS PHRASE NAME HER? THE POSITIONAL RULE, AND THE ONE IMPLEMENTATION OF IT. ──────
 *
 * `normalizeObjectNoun` above answers "may this noun be segmented and edited inside". This answers
 * the broader question the routing layer asks: does this string, whatever grammar it arrived in,
 * NAME THE ATHLETE OR A PIECE OF HER. Both callers need the same answer, so there is one function:
 * the edit-side normalizer here, and `parseDetections` (studio/autoMask.ts), which refuses a whole
 * detection whose TARGET names her — free text like "her face", which never reaches a noun field
 * at all.
 *
 * ─── WHY THE HEAD NOUN, AND WHY THAT IS NOT A HEURISTIC ────────────────────────────────────────
 *
 * English puts the head of a noun phrase LAST, and the head is what the phrase denotes. That single
 * fact does all the work here and it cuts in both directions at once:
 *
 *     "her left arm"   head "arm"      → her.       A modifier cannot make a body part not one.
 *     "the athlete's"  head "athlete"  → her.
 *     "face mask"      head "mask"     → equipment. A mask is a mask however it is described.
 *     "knee pad"       head "pad"      → equipment.
 *     "shin guard"     head "guard"    → equipment.
 *
 * A word-boundary regex over PERSON_NOUNS — the obvious implementation — gets the left column right
 * and the right column WRONG: `\bface\b` matches "face mask", and denying a face mask is denying a
 * real piece of equipment she is entitled to edit. The existing tests pin exactly those compounds
 * as allowed, and they are pinned because that class of false positive is the reason the closed
 * vocabulary was uncomfortable in the first place.
 *
 * ⚠️ NOT A PARSER, AND IT DOES NOT NEED TO BE. It takes the last word, not a syntactic head. That
 * is wrong for a postmodified phrase ("the back of her hand" → "hand", correctly denied by luck;
 * "a photo of the athlete" → "athlete", denied where the phrase is arguably about the photo). Both
 * errors land on the SAFE side — a refusal she can rephrase, never an edit to her body — and the
 * input is a short SAM-ready target, not prose, so the constructions this gets wrong are close to
 * absent in practice. The direction of the error is the design; the grammar is not.
 */
export function namesPerson(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  // The same narrow whitespace collapse normalizeObjectNoun uses, and for the same reason: a
  // control character must not be laundered into a clean word. Possessives are stripped per word
  // ("athlete's" → "athlete") because the possessive is grammar, not part of the noun.
  const raw_words = raw
    .trim()
    .toLowerCase()
    .replace(/[ \t]+/g, " ")
    .split(" ")
    .map((w) => w.replace(/['\u2019]s?$/, "").replace(/[^a-z-]/g, ""))
    .filter(Boolean);
  // ⚠️ STRIPPED HERE AND NOT ONLY IN THE CALLER. This function is the safety boundary — it also
  // guards the hand-drawn path and raw model output, neither of which passes through the
  // classifier's extractor — so it must not depend on someone else having cleaned the input first.
  const words = stripTrailingModifiers(raw_words);
  if (!words.length) return false;

  const PERSON = new Set(PERSON_NOUNS);
  // The whole phrase, and the phrase minus a leading determiner. Redundant today — every entry in
  // PERSON_NOUNS is one word, so the head check below subsumes both — and kept because the list is
  // data: the day "upper body" is added, this is what stops it being silently unenforceable.
  const phrase = words.join(" ");
  if (PERSON.has(phrase)) return true;
  if (
    words.length > 1 &&
    LEADING_DETERMINERS.includes(words[0]) &&
    PERSON.has(words.slice(1).join(" "))
  ) {
    return true;
  }
  // ⚠️ 2026-09-10: THAT DAY CAME, AND THE TWO CHECKS ABOVE WERE NOT ENOUGH. "belly button" is a head of
  // two words, and a modifier in front of it ("my pierced belly button") defeats a whole-phrase match
  // exactly the way "her left arm" defeated the exact-match deny set. So a multi-word head is read on
  // the phrase's TAIL — the head rule below, for a head longer than one word. "belly button piercing"
  // still passes: its tail is the piercing.
  for (let n = 2; n <= Math.min(MAX_NOUN_WORDS, words.length); n++) {
    if (PERSON.has(words.slice(-n).join(" "))) return true;
  }
  // The head. This is the rule; everything above is a special case of it.
  return PERSON.has(words[words.length - 1]);
}

/**
 * THINGS SHE WEARS ON A PART OF HERSELF — the closed list that decides when a part of her named beside
 * one of them is where it IS rather than a thing to edit (guard scope, 2026-09-10). Jewelry, bands and
 * gloves: Adi's ten, and the words that name the same things — "gold hoops" and "studs" are earrings, a
 * pendant and a choker are necklaces, a bangle and an anklet are bracelets.
 *
 * Three readers, one list — the rule this file keeps for `namesPerson`:
 *   • the classifier's location reading (studio/classify.ts, `extractTargets`): "change the earrings in
 *     my ears to gold" keeps "earrings" and drops "my ears" as their location, so it routes as "change
 *     the earrings to gold" does;
 *   • detection's person check (studio/autoMask.ts, `parseDetections`, via `namesAWornThing`): the model
 *     copies her words into `target` — "the earrings in my ears", measured live — and the head rule read
 *     that as her ears and refused the preview of a sentence the classifier had already routed;
 *   • since PR M3, the classifier's worn add (studio/classify.ts, rule 3¾b): "add these gold hoops to my
 *     ears" puts a thing on this list onto a part of her it is worn on (WORN_PLACES, below).
 *
 * ⚠️ CLOSED, BECAUSE IT RELAXES A GUARD. Every word here makes a part of her that FOLLOWS it read as a
 * location, and lets the thing be added onto her. A word is added on purpose or not at all, and
 * objectVocab.test.ts holds the list word for word.
 *
 * ⚠️ HEADWEAR AND EYEWEAR SINCE PR M3 (the plan's N6). They were left off on purpose while "add a hat on
 * her head" was D1's own example; Mia's M3 allowed worn items onto her, so hat, cap, beanie, visor,
 * helmet, bandana, sunglasses, glasses, eyeglasses and goggles joined. NOT crown, tiara, mask or shades:
 * costume pieces, or a word that means more than one thing ("shades"), and each still asks.
 */
export const WORN_ITEMS: readonly string[] = [
  "earring",
  "earrings",
  "hoop",
  "hoops",
  "stud",
  "studs",
  "necklace",
  "necklaces",
  "pendant",
  "pendants",
  "choker",
  "chokers",
  "chain",
  "chains",
  "watch",
  "watches",
  "bracelet",
  "bracelets",
  "bangle",
  "bangles",
  "anklet",
  "anklets",
  "ring",
  "rings",
  "headband",
  "headbands",
  "hairband",
  "hairbands",
  "hair tie",
  "hair ties",
  "scrunchie",
  "scrunchies",
  "glove",
  "gloves",
  "wristband",
  "wristbands",
  "sweatband",
  "sweatbands",
  // Headwear and eyewear — PR M3, N6.
  "hat",
  "hats",
  "cap",
  "caps",
  "beanie",
  "beanies",
  "visor",
  "visors",
  "helmet",
  "helmets",
  "bandana",
  "bandanas",
  "sunglasses",
  "glasses",
  "eyeglasses",
  "goggles",
  // Worn on the arm and at the neck — wave D, card 4 / J7. An armband is the captain's band a
  // footballer wears on the upper arm, which is why `arm` becomes a DEFAULT anchor here for the
  // first time: every earlier arm-worn thing (a watch, a bracelet) means the wrist when said bare.
  "armband",
  "armbands",
  "scarf",
  "scarves",
];

const WORN = new Set(WORN_ITEMS);

/** Does this phrase name a worn thing by its head — "earrings", "gold hoops", "pink hair tie"? */
export function namesWornItem(phrase: string): boolean {
  const w = phrase.toLowerCase().split(" ").filter(Boolean);
  return WORN.has(w.slice(-2).join(" ")) || WORN.has(w.at(-1) ?? "");
}

/**
 * THE PARTS OF HER A WORN THING GOES ON, and the word it is worn with there (PR M3, worn adds — the
 * plan's N5 locations). The compiled clause reads "add the gold hoops from Image 2, worn IN the person's
 * ears": earrings go in ears, a ring or a stud in a nose (M3.9), a chain goes around a neck, and
 * everything else is worn ON its place.
 *
 * Her own preposition is never the clause's. She says "add gold hoops TO my ears", and "place it to the
 * person's ears" is not a sentence a model should have to read. The place decides the word.
 *
 * ⚠️ CLOSED, AND EVERY WORD IS ON PERSON_NOUNS. A place on this list is a part of her, which is what makes
 * a clause naming one a WORN add rather than a spatial one (studio/compile/templates.ts). "ear" is read
 * as the same place as "ears" — one earring goes in one ear.
 */
export const WORN_PLACE_PREPOSITIONS: ReadonlyMap<
  string,
  "in" | "around" | "on"
> = new Map([
  ["ear", "in"],
  ["ears", "in"],
  ["neck", "around"],
  ["wrist", "on"],
  ["wrists", "on"],
  ["arm", "on"],
  ["arms", "on"],
  ["finger", "on"],
  ["fingers", "on"],
  ["hand", "on"],
  ["hands", "on"],
  ["ankle", "on"],
  ["ankles", "on"],
  ["head", "on"],
  ["hair", "on"],
  ["face", "on"],
  ["eyes", "on"],
  // Pierced jewelry, M3.9: a ring or a stud is worn IN a nose, as an earring is in an ear.
  ["nose", "in"],
]);

const EARS = ["ear", "ears"];
const NECK = ["neck"];
const WRIST_ARM = ["wrist", "wrists", "arm", "arms"];
// An armband is worn ON THE ARM and never on a wrist — its own list, and the first whose default is
// an arm (wave D, J7). A sleeve is deliberately NOT here: V4 reads it as a garment location.
const ARM = ["arm", "arms"];
const ANKLE = ["ankle", "ankles"];
// Pierced jewelry, M3.9 (Mia): a stud goes in an ear or a nose, a ring on a finger or a hand or in a nose.
const STUDS = ["ear", "ears", "nose"];
const RINGS = ["finger", "fingers", "hand", "hands", "nose"];
const HANDS = ["hand", "hands"];
const HEAD_HAIR = ["head", "hair"];
const HEAD = ["head"];
const FACE_EYES_HEAD = ["face", "eyes", "head"];

/**
 * WHERE EACH WORN THING GOES ON HER, AND NOWHERE ELSE (PR M3, the plan's N5). Earrings go in ears, a
 * necklace around a neck, a watch on a wrist or an arm, a ring on a finger or a hand, an anklet on an
 * ankle, gloves on hands, a headband on a head or in hair, a hat on a head, and sunglasses on a face, over
 * the eyes or up on a head.
 *
 * ⚠️ THIS IS WHAT DECIDES WHICH PIERCINGS ROUTE. A place outside the thing's own list is not rule 3¾b's
 * (studio/classify.ts), so it asks with the person line. Mia opened pierced jewelry in the NOSE (M3.9):
 * "add a ring to my nose" and "put a stud in my nose" route, because a ring and a stud list the nose. No
 * list holds a lip, an eyebrow, a navel or a tongue, so those still ask — and so does a hoop or an
 * earring in her nose, which only a ring or a stud is opened for.
 *
 * Keyed by every word on WORN_ITEMS, and objectVocab.test.ts holds the table by hand: a worn word with no
 * places could never be added, and a place added here is a new part of her a thing can be put on.
 */
export const WORN_PLACES: ReadonlyMap<string, readonly string[]> = new Map([
  ["earring", EARS],
  ["earrings", EARS],
  ["hoop", EARS],
  ["hoops", EARS],
  ["stud", STUDS],
  ["studs", STUDS],
  ["necklace", NECK],
  ["necklaces", NECK],
  ["pendant", NECK],
  ["pendants", NECK],
  ["choker", NECK],
  ["chokers", NECK],
  ["chain", NECK],
  ["chains", NECK],
  ["watch", WRIST_ARM],
  ["watches", WRIST_ARM],
  ["bracelet", WRIST_ARM],
  ["bracelets", WRIST_ARM],
  ["bangle", WRIST_ARM],
  ["bangles", WRIST_ARM],
  ["wristband", WRIST_ARM],
  ["wristbands", WRIST_ARM],
  ["sweatband", WRIST_ARM],
  ["sweatbands", WRIST_ARM],
  ["armband", ARM],
  ["armbands", ARM],
  ["scarf", NECK],
  ["scarves", NECK],
  ["ring", RINGS],
  ["rings", RINGS],
  ["anklet", ANKLE],
  ["anklets", ANKLE],
  ["glove", HANDS],
  ["gloves", HANDS],
  ["headband", HEAD_HAIR],
  ["headbands", HEAD_HAIR],
  ["hairband", HEAD_HAIR],
  ["hairbands", HEAD_HAIR],
  ["hair tie", HEAD_HAIR],
  ["hair ties", HEAD_HAIR],
  ["scrunchie", HEAD_HAIR],
  ["scrunchies", HEAD_HAIR],
  ["hat", HEAD],
  ["hats", HEAD],
  ["cap", HEAD],
  ["caps", HEAD],
  ["beanie", HEAD],
  ["beanies", HEAD],
  ["visor", HEAD],
  ["visors", HEAD],
  ["helmet", HEAD],
  ["helmets", HEAD],
  ["bandana", HEAD],
  ["bandanas", HEAD],
  ["sunglasses", FACE_EYES_HEAD],
  ["glasses", FACE_EYES_HEAD],
  ["eyeglasses", FACE_EYES_HEAD],
  ["goggles", FACE_EYES_HEAD],
]);

/**
 * Does this worn thing go on this part of her — "gold hoops" in "ears", a "watch" on a "wrist"? Read by
 * the thing's head, as `namesWornItem` reads it: a two-word head ("hair tie") before a one-word one.
 */
export function wornGoesOn(thing: string, place: string): boolean {
  const w = thing.toLowerCase().split(" ").filter(Boolean);
  const places =
    WORN_PLACES.get(w.slice(-2).join(" ")) ?? WORN_PLACES.get(w.at(-1) ?? "");
  return places?.includes(place) ?? false;
}

/**
 * WHERE A WORN THING GOES WHEN SHE NAMES NO PLACE — its anchor (wave A, V2; sweep-4 ledger F-CA7). "add in hoops from
 * the second picture" asked `add_unclear`, and C2 made it a new photograph of her; "add the hoops from image 2 to my
 * ears" ran as a native edit and held her frame. A thing she wears has one obvious place, so "add hoops" is "add hoops
 * to my ears", said plainly.
 *
 * ⚠️ CLOSED, KEYED BY EVERY WORN_ITEMS WORD, AND EVERY ANCHOR ONE OF THAT WORD'S OWN WORN_PLACES — objectVocab.test.ts
 * holds both by hand. A thing with more than one place takes the first a person means by it bare: a watch on a wrist,
 * a ring on a finger, sunglasses on a face, a scrunchie in hair. Plurals take a plural place where one exists.
 */
export const WORN_DEFAULT_PLACES: ReadonlyMap<string, string> = new Map([
  ["earring", "ear"],
  ["earrings", "ears"],
  ["hoop", "ear"],
  ["hoops", "ears"],
  ["stud", "ear"],
  ["studs", "ears"],
  ["necklace", "neck"],
  ["necklaces", "neck"],
  ["pendant", "neck"],
  ["pendants", "neck"],
  ["choker", "neck"],
  ["chokers", "neck"],
  ["chain", "neck"],
  ["chains", "neck"],
  ["watch", "wrist"],
  ["watches", "wrists"],
  ["bracelet", "wrist"],
  ["bracelets", "wrists"],
  ["bangle", "wrist"],
  ["bangles", "wrists"],
  ["wristband", "wrist"],
  ["wristbands", "wrists"],
  ["sweatband", "wrist"],
  ["sweatbands", "wrists"],
  ["armband", "arm"],
  ["armbands", "arms"],
  ["scarf", "neck"],
  ["scarves", "neck"],
  ["ring", "finger"],
  ["rings", "fingers"],
  ["anklet", "ankle"],
  ["anklets", "ankles"],
  ["glove", "hand"],
  ["gloves", "hands"],
  ["headband", "head"],
  ["headbands", "head"],
  ["hairband", "hair"],
  ["hairbands", "hair"],
  ["hair tie", "hair"],
  ["hair ties", "hair"],
  ["scrunchie", "hair"],
  ["scrunchies", "hair"],
  ["hat", "head"],
  ["hats", "head"],
  ["cap", "head"],
  ["caps", "head"],
  ["beanie", "head"],
  ["beanies", "head"],
  ["visor", "head"],
  ["visors", "head"],
  ["helmet", "head"],
  ["helmets", "head"],
  ["bandana", "head"],
  ["bandanas", "head"],
  ["sunglasses", "face"],
  ["glasses", "face"],
  ["eyeglasses", "face"],
  ["goggles", "face"],
]);

/** A worn thing's anchor, read by its head as `wornGoesOn` reads it — "gold hoops" → "ears" — or null. */
export function wornDefaultPlace(thing: string): string | null {
  const w = thing.toLowerCase().split(" ").filter(Boolean);
  return (
    WORN_DEFAULT_PLACES.get(w.slice(-2).join(" ")) ??
    WORN_DEFAULT_PLACES.get(w.at(-1) ?? "") ??
    null
  );
}

/** Words that end a target's LEADING noun phrase — past one is where the thing is, or something else. */
const ENDS_LEADING_PHRASE: ReadonlySet<string> = new Set([
  "in",
  "on",
  "from",
  "around",
  "through",
  "at",
  "near",
  "by",
  "over",
  "under",
  "behind",
  "beside",
  "between",
  "inside",
  "against",
  "of",
  "with",
  "to",
  "onto",
  "into",
  "and",
  "or",
]);

/**
 * Does a detection TARGET name a worn thing, whatever it says about where — "the earrings in my ears",
 * "earring on her left ear", "gold hoops"? (guard scope, the live-path fix, 2026-09-10)
 *
 * ─── WHY THE HEAD RULE WAS WRONG HERE, AND ONLY HERE ─────────────────────────────────────────────
 *
 * `namesPerson` reads the LAST word, and says so: postmodified phrases are its known blind spot ("the
 * back of her hand" → "hand"). Its errors were meant to land on the safe side, and on this one they
 * landed on the founder's sentence. Detection is told `target` is "the thing named in the request", so
 * given "change the earrings in my ears to gold" it copied the request: measured on the Gorjana frame,
 * target "the earrings in my ears" — the same box and the same directive ("gold earrings") as the
 * sentence without "in my ears", whose target was "earrings". Read by its last word, that is "ears",
 * and the preview refused a sentence the classifier had already routed as RECOLOR [earrings].
 *
 * So a target is read by its LEADING noun phrase, the words before the first preposition or joiner —
 * where English puts the thing a postmodified phrase is about — and it names a worn thing when that
 * phrase's head is on WORN_ITEMS. Everything after is where it is.
 *
 * ⚠️ IT CAN ONLY EXEMPT A WORN THING, NEVER WIDEN WHAT NAMES HER. A leading phrase that names her —
 * "ears", "her left ear", "ring finger" (head: finger), "watch face" (head: face) — is not worn, so the
 * head rule decides exactly as before. And it is the TARGET only: a samNoun is what SAM segments, a
 * noun and never a phrase with a location, and it keeps the plain check.
 */
export function namesAWornThing(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  // The same word cleaning `namesPerson` does: narrow whitespace, possessives and punctuation per word.
  const words = raw
    .trim()
    .toLowerCase()
    .replace(/[ \t]+/g, " ")
    .split(" ")
    .map((w) => w.replace(/['’]s?$/, "").replace(/[^a-z-]/g, ""))
    .filter(Boolean);
  let i = LEADING_DETERMINERS.includes(words[0]) ? 1 : 0;
  const lead: string[] = [];
  while (i < words.length && !ENDS_LEADING_PHRASE.has(words[i])) {
    lead.push(words[i]);
    i++;
  }
  return lead.length > 0 && namesWornItem(lead.join(" "));
}

/**
 * WHY A PROPOSED `samNoun` WAS NOT USED — the question the whitelist was silently carrying.
 *
 * ─── WHY THIS CANNOT BE ANSWERED BY INSPECTION ─────────────────────────────────────────────────
 *
 * Normalization happens BEFORE the region is stored, and a rejected noun is stored as ABSENT. So
 * every run has discarded the evidence: all 7 of the 48 nounless regions measured on 2026-09-09 had
 * SOME proposed noun that was never recorded, and there is no way to recover what it was or why it
 * failed. The closed vocabulary's guarantee — "every noun on the list was probed to work" — cannot
 * be restored by reading the code, only by measuring what the model actually proposes.
 *
 * Six outcomes, because a bare list of rejected words separates none of them:
 *
 *   absent       no samNoun proposed at all. DISTINCT from proposed-and-rejected, and today the two
 *                are indistinguishable downstream — both are simply a region with no noun.
 *   person       `namesPerson`. Unreachable at the call site today, because the parser refuses a
 *                person target before it normalizes — included so that a future REORDERING shows up
 *                as a count instead of disappearing.
 *   known_bad    a measured zero (KNOWN_BAD_NOUNS), denied before it can bill.
 *   scene        names the setting, not a thing in it. See SCENE_NOUNS.
 *   shape        failed `nounShapeOk` — too long, too many words, illegal characters.
 *   not_garment  ⚠️ THE BUCKET THIS EXISTS FOR. Passes the open path and fails the closed one, so it
 *                is exactly what flipping STUDIO_OBJECT_MASK would newly admit. Its size and its
 *                contents are the zero-rate question.
 *   accepted     used as-is.
 */
export type NounVerdict =
  | "absent"
  | "person"
  | "known_bad"
  | "scene"
  | "shape"
  | "not_garment"
  | "accepted";

export function classifyNoun(raw: unknown, open: boolean): NounVerdict {
  if (typeof raw !== "string" || !raw.trim()) return "absent";
  const clean = raw.trim().toLowerCase().replace(/[ \t]+/g, " ");

  // Order is by SPECIFICITY, not by where the rejection happens: a word can be several of these at
  // once and the most informative name is the one worth counting.
  if (namesPerson(clean)) return "person";
  if (KNOWN_BAD_NOUNS.includes(clean)) return "known_bad";
  if (SCENE_NOUNS.includes(clean)) return "scene";
  if (!nounShapeOk(clean)) return "shape";
  if (normalizeGarmentNoun(clean)) return "accepted";
  // Passes open, fails closed. With the flag off this is a rectangle today and a mask tomorrow.
  return normalizeObjectNoun(clean, true) ? (open ? "accepted" : "not_garment") : "shape";
}
