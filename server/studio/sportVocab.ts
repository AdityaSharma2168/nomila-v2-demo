/**
 * studio/sportVocab — does HER SENTENCE name a sport?
 *
 * One question, asked for one reason: `assembleBrief` injects her profile into every generate as
 * `Register: <tier> · <segment> · <sport>`, and when the sentence names a different sport the two
 * contradict each other inside the same prompt. This module is what lets the assembler tell the
 * difference between "she did not say, so the profile fills it in" and "she said, and the profile
 * must step aside".
 *
 * ─── WHY THE PRECEDENCE IS RESOLVED HERE AND NOT ASKED OF THE MODEL ────────────────────────────
 *
 * The obvious alternative is a sentence in the prompt — "where the direction conflicts with the
 * register, follow the direction". That is a REQUEST, and it is unassertable: there is no value the
 * assembled prompt could take that would tell you whether the rule held, so a test around it can
 * report success while measuring nothing (docs/runbooks/verifying-a-guard-bites.md). Resolving it
 * in assembly makes the rule a pure function of two strings, so the prompt either carries the
 * contradiction or it does not, and a unit test can see which — without paying for a generation.
 *
 * It is also the only version that was ever going to work. Measured 2026-09-09 on a live generate
 * (job e4814552): profile `Basketball`, direction `create an adidas soccer ad featuring me`. The
 * model did not ignore the direction — it OBEYED BOTH, putting her on a basketball court holding a
 * basketball with a soccer ball at her feet and captioning it "Wait, soccer? … Trying something
 * new. #basketball #soccer". Asking it more firmly to prefer one input is asking it to discard
 * context we chose to hand it. The fix is to stop handing it.
 *
 * ─── AN ALLOW-LIST, AND THE MISS DIRECTION IS THE SAFE ONE ─────────────────────────────────────
 *
 * A sport not on this list reads as "she named no sport", so the profile stays and behaviour is
 * exactly what it is today. A false positive is the expensive direction — it silently drops real
 * context from her brief — so nothing here stems, fuzzy-matches or guesses. Adding a sport is a
 * one-line data change; the list can only ever grow with words we chose.
 *
 * ⚠️ IT ONLY EVER FIRES ON A GENERATE. `buildPrompt` renders the register under
 * `job.mode === "generate"` and nowhere else, so an edit never consults this. That is what makes
 * the equipment reading below acceptable rather than a defect: "add a soccer ball to my jersey" is
 * an edit and never reaches here.
 *
 * ⚠️ EQUIPMENT COUNTS AS NAMING THE SPORT, DELIBERATELY. "create a poster with a soccer ball"
 * matches `soccer`. On a generate that is the right answer — the picture being made is a soccer
 * picture, and asserting a different sport beside it is the contradiction this module exists to
 * remove. Narrowing it to sport-as-modifier would be inventing a rule with no failing case behind
 * it, which is how `extractTargets` grew the problems recorded in classify.ts.
 */

/**
 * The sports a direction may name. Lowercase, matched on word boundaries.
 *
 * Mirrors the vetted list in server/voice/brandProfile.ts (`SPOKEN_SPORTS`) rather than importing
 * it: that one is an allow-list for reading a researched brand's categories aloud on a phone call,
 * and it is owned by the voice lane. Two lists with one shape and two owners is the same call
 * garmentVocab.ts and subjectVocab.ts already make, and for the same reason — a shared list means
 * a change made for one caller silently re-tunes the other.
 */
export const SPORT_NOUNS: readonly string[] = [
  // Multi-word first is a readability choice only; `namesSport` sorts by length itself.
  "track and field",
  "cross country",
  "beach volleyball",
  "flag football",
  "field hockey",
  "ice hockey",
  "water polo",
  "football",
  "basketball",
  "baseball",
  "softball",
  "soccer",
  "volleyball",
  "hockey",
  "lacrosse",
  "tennis",
  "golf",
  "swimming",
  "diving",
  "gymnastics",
  "wrestling",
  "rowing",
  "running",
  "cycling",
  "skiing",
  "snowboarding",
  "surfing",
  "skateboarding",
  "climbing",
  "rugby",
  "cricket",
  "boxing",
  "mma",
  "crossfit",
  "weightlifting",
  "powerlifting",
  "triathlon",
  "esports",
  "equestrian",
  "sailing",
  "fencing",
  "squash",
];

/**
 * LONGEST FIRST, and this is correctness rather than tidiness.
 *
 * "beach volleyball" contains "volleyball" and "field hockey" contains "hockey". Scanning in list
 * order would return the shorter word for a sentence that named the longer one, and the caller uses
 * the answer to decide what to suppress — so the wrong half of a two-word sport is a wrong answer,
 * not a rounding error.
 */
const BY_LENGTH: readonly string[] = [...SPORT_NOUNS].sort((a, b) => b.length - a.length);

/** Word-boundary match, so "squash" is a sport and "squashed" is not. */
function mentions(text: string, sport: string): boolean {
  const escaped = sport.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

/**
 * The sport this text names, or null.
 *
 * Null means "she named no sport we recognise", which the assembler reads as permission for the
 * profile to fill the gap — the pre-existing behaviour, unchanged. A non-null answer is the
 * assembler's signal that the sentence has already answered the question the profile would answer.
 *
 * The FIRST sport in the text wins when several appear, by position rather than by list order, so
 * "a soccer ad, not a basketball one" resolves to soccer. Ranking two named sports is a real
 * question with no evidence behind it yet; taking the leading one keeps the answer stable and
 * readable instead of arbitrary.
 */
export function namesSport(text: unknown): string | null {
  if (typeof text !== "string" || !text.trim()) return null;

  let best: { sport: string; at: number } | null = null;
  for (const sport of BY_LENGTH) {
    if (!mentions(text, sport)) continue;
    const at = text.toLowerCase().indexOf(sport);
    // A longer sport starting at the same place as a shorter one is the "beach volleyball" case —
    // BY_LENGTH reaches it first, and `<` keeps it rather than letting "volleyball" displace it.
    if (!best || at < best.at) best = { sport, at };
  }
  return best?.sport ?? null;
}
