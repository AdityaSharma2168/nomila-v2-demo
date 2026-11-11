/**
 * studio/garmentVocab — the closed set of nouns the segmenter is allowed to be asked for.
 *
 * ─── WHY THIS IS A WHITELIST AND NOT A HINT ────────────────────────────────────────────────────
 *
 * SAM-3's vocabulary is BRITTLE in a way that is invisible from our side. It answers a concrete
 * garment noun and returns an empty mask list for a near-synonym: "jersey" finds nothing on a crop
 * top, and "shirt" — the word a person is most likely to reach for — never works at all. There is
 * no error and no signal; the call succeeds, bills, and returns nothing.
 *
 * So the noun cannot be free text, and it cannot come from the athlete's own wording. It is chosen
 * by the Gemini detection pass FROM THE PHOTOGRAPH (studio/autoMask.ts), because that pass is the
 * one place that has both her instruction and the pixels, and it is then checked against this list
 * before it can reach a paid call.
 *
 * ─── THE LIST IS ALSO THE INJECTION BOUNDARY, WHICH IS THE OTHER HALF OF ITS JOB ────────────────
 *
 * `samNoun` rides on RegionFraction, and RegionFraction is a CLIENT wire type (studio/geometry.ts)
 * as well as a model output. Without a closed set, a crafted request body could put arbitrary text
 * into a third-party prompt on an athlete's photograph. Validation therefore lives in
 * `mapRegions` — the one choke point BOTH paths pass through — rather than only in the parser that
 * reads the model's answer. Neither a model nor a client is trusted here, which is the rule the
 * server conventions already state for ids.
 *
 * ⚠️ ─── THIS LIST IS INCOMPLETE AND KNOWN TO BE ────────────────────────────────────────────────
 *
 * It carries only the nouns that were confirmed against SAM-3 in the probe runs and reported: the
 * jersey/crop-top/sports-bra/jacket/tank-top set the detection prompt names, plus socks and shoes.
 * The FULL probe vocabulary table has not been transcribed here yet.
 *
 * That is safe rather than broken, and the reason is the fallback: a noun that is not on this list
 * is dropped, no segmentation runs, and the region composites through its rectangle exactly as it
 * does today (the fallback block in studio/composite.ts). An absent noun costs quality, never correctness,
 * and never money. So the failure mode of an incomplete list is "this garment did not get the
 * upgrade", which is the pre-feature behaviour.
 *
 * ADDING TO IT IS A DATA CHANGE, NOT A CODE CHANGE — but only add nouns actually observed to return
 * a mask. A guessed noun does not fail loudly; it bills $0.005 and returns nothing.
 */

/**
 * Nouns confirmed to return a mask. Lowercase, singular or plural exactly as SAM was asked.
 *
 * `socks` and `shoes` are PLURAL on purpose: the probes ran them that way, and both are things that
 * come in pairs and are detected as a pair. Do not "tidy" them to singular — the noun is a probed
 * string, not an English word, and the two are only accidentally related.
 */
export const GARMENT_NOUNS: readonly string[] = [
  "jersey",
  "crop top",
  "sports bra",
  "jacket",
  "tank top",
  "socks",
  "shoes",
  // MEASURED 2026-09-09 on job 1134b6f5's own frame, which is the job whose hem showed
  // axis-aligned notches because this word was on neither list: maskVsRegion 0.63, solidity 0.637,
  // fillOfCrop 0.066 — a good mask, in the same band as socks (0.70 / 0.53 on its two regions).
  // Singular "short" scored identically (0.63 / 0.638) and is NOT listed: the list's convention is
  // the word the garment is actually called, and detectionPrompt tells the model to use this
  // wording exactly.
  "shorts",
];

/**
 * Nouns confirmed NOT to work, kept so nobody re-adds them from intuition.
 *
 * Recorded rather than merely omitted because these are exactly the words a reasonable person
 * reaches for. "shirt" is the generic a human would pick for half this list and it returns nothing;
 * "top" and "uniform" are the same failure one step further out. Their absence from GARMENT_NOUNS
 * is a MEASUREMENT, not an oversight, and this constant is what says so.
 *
 * ⚠️ CONSULTED AT RUNTIME NOW, WHICH IT WAS NOT WHEN IT WAS WRITTEN. While GARMENT_NOUNS was the
 * only gate this list could not be reached: a closed whitelist cannot admit a word that is not on
 * it, so recording the zeros was for the reader. studio/objectVocab.ts opened the edit-side
 * vocabulary for NON-garments, and the first thing that makes reachable again is "shirt" — which is
 * not an unknown but a MEASUREMENT, returning nothing and billing for it. `normalizeObjectNoun`
 * therefore denies these outright. GARMENT_NOUNS is still the only ALLOW gate; this is now a deny
 * one.
 */
export const KNOWN_BAD_NOUNS: readonly string[] = ["shirt", "top", "uniform", "outfit", "clothes"];

const ALLOWED = new Set(GARMENT_NOUNS);

/**
 * An untrusted string → a noun the segmenter can be asked for, or null.
 *
 * Null is the ordinary answer and never an error: it means this region takes its rectangle. Case
 * and surrounding whitespace are normalized because a model returns "Crop Top" as readily as "crop
 * top" and that is not a vocabulary miss — but nothing else is coerced. No stemming, no plural
 * folding, no nearest-match: a noun that is close to a working one is not a working one, and
 * silently substituting would spend on a guess.
 */
export function normalizeGarmentNoun(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return ALLOWED.has(clean) ? clean : null;
}
