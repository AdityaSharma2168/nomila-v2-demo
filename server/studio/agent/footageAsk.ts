/**
 * studio/agent/footageAsk — does her sentence ask for HER OWN footage?
 *
 * Doctrine rule 3 (studio/agent/plan.ts) has said since 22 Sep 2026 that "when she asks for real,
 * live or her own footage, a CLIP line from her camera OUTRANKS a made-here line". Until this module
 * that condition lived in the model's reading of her sentence alone — nothing in code knew whether
 * it applied, so no fixture could hold it and no mutation could red it. This is the reading: a pure
 * predicate over her words, $0, no model. When it fires, the planner is TOLD, in one explicit line
 * (`OWN_FOOTAGE_LINE`), that the clause applies to this plan.
 *
 * ─── WHAT FIRES, AND WHAT MUST NOT ───────────────────────────────────────────────────────────────
 *
 *   fires     "use my real footage" · "using what I actually filmed" · "my own clips" · "the videos
 *             I uploaded" · "live footage" · "actual footage" · "raw clips" · "nothing made up" ·
 *             "nothing generated" · "no AI" · "don't generate anything"
 *   must not  "make me an ad" · "that feels like a REAL spot" (the adidas brief — `real` beside a
 *             noun that is not footage) · "go LIVE on Friday" · "in my own PHOTOS" (a photo is held,
 *             never footage; the clause is about clips)
 *
 * The footage nouns are closed on purpose: `real` and `live` are ordinary adjectives everywhere
 * else in a brief, and a word list that fired on them alone would put the camera clause on every
 * hype reel. Hers, entering a prompt about her own library — the same trust studio/agent/types.ts
 * gives `PlanAsk.prompt`. Read, never echoed: the line the planner receives is a constant.
 *
 * ⚠️ MUTATION (footageAsk.test, plan.test): return true always — "make me an ad" reds by name.
 */

/** The nouns that make a sentence about FOOTAGE. Photos are deliberately absent. */
const FOOTAGE = String.raw`(?:footage|clips?|videos?|vids?|recordings?|film)`;

const PATTERNS: readonly RegExp[] = [
  // "my real footage", "live footage", "my own clips", "actual match footage", "the raw clips"
  new RegExp(
    String.raw`\b(?:real|live|actual|own|raw|original|my|our|existing)\W+(?:\w+\W+){0,2}?${FOOTAGE}\b`,
    "i",
  ),
  // "what I actually filmed", "stuff I shot", "the clips that we recorded", "moments I captured"
  /\b(?:what|stuff|things?|clips?|videos?|footage|moments?|bits)\W+(?:that\W+)?(?:i|we)(?:'ve|\W+have)?\W+(?:actually\W+|already\W+|myself\W+)?(?:filmed|shot|recorded|captured|taped)\b/i,
  // "the videos I uploaded", "clips I added"
  new RegExp(
    String.raw`\b${FOOTAGE}\W+(?:that\W+)?(?:i|we)(?:'ve|\W+have)?\W+(?:already\W+)?(?:uploaded|added|gave\W+you|sent|put\W+in)\b`,
    "i",
  ),
  // "nothing made up", "nothing generated", "nothing fake", "nothing AI"
  /\bnothing\W+(?:made\W+up|generated|fake|ai|artificial)\b/i,
  // "no AI", "no generated clips", "no generation", "no fakes"
  /\bno\W+(?:ai|generated|generation|fakes?|synthetic)\b/i,
  // "don't generate anything", "do not make anything up", "never invent"
  /\b(?:not|don'?t|do\W+not|never|without)\W+(?:\w+\W+){0,2}?(?:generat(?:e|ed|ing)|make\W+(?:\w+\W+)?up|invent(?:ed|ing)?|fak(?:e|ing))\b/i,
];

/** True when her sentence asks for her own, real or live footage — see the header for the edges. */
export function asksForOwnFootage(prompt: string): boolean {
  const text = prompt.normalize("NFKC");
  return PATTERNS.some((re) => re.test(text));
}

/**
 * The one line the planner is given when she asked for her own footage — rule 3's conditional
 * clause, stated as a fact about THIS plan rather than left to the model's reading of her words.
 */
export const OWN_FOOTAGE_LINE =
  'she asked for HER OWN FOOTAGE: a CLIP line "from: her camera" outranks a "made here" line for ' +
  "any content it covers, a generated shot enters only for a genuine gap her camera does not cover, " +
  'and a made-here clip is never used unless she picked it; a "from: her instagram" line is hers ' +
  "too, and the order is her camera, then her instagram, then made here (doctrine rule 3).";
