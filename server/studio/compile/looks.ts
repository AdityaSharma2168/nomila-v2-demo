/**
 * studio/compile/looks — what a look SAYS to the model: one phrase per look (style vocabulary, V.2).
 *
 * ─── HER WORD IS STORED; HER LOOK'S PHRASE IS SENT ───────────────────────────────────────────────────
 *
 * A GLOBAL_STYLE change carries her word ("moody"), as a look's value always has — rule 3 stores the word
 * she typed, and her card reads it back ("Make it moody"). The instruction reads the LOOK that word names
 * (studio/lookVocab.ts), so "moody" and "moodier" send one phrase, and the compile surface is one entry per
 * look rather than one per word.
 *
 * ─── MAIN'S FIFTEEN SEND THEIR OWN WORD, BYTE FOR BYTE ───────────────────────────────────────────────
 *
 * "give the whole photograph this look: warmer" is what a native look has sent since it shipped, and the
 * goldens pin it. Each of main's fifteen looks' phrase is its own name, so every one of those prompts
 * compiles byte-identically — "retro" now sends main's "vintage look" and "higher contrast" main's "more
 * contrast". A change no look knows (none is written today) also compiles as itself, exactly as it did.
 *
 * ─── THE SEVEN NEW PHRASES: COLOUR AND TONE, NOTHING ELSE ────────────────────────────────────────────
 *
 * Each is the look's name, then what it means in a colour grade's own terms — shadows, contrast,
 * saturation, colour. Never light moved, the person re-posed or the frame re-cut: the scope sentence
 * keeps everything where and what it is, and a grade is all it may change. "across the full frame" in
 * the cinematic phrase is there to keep letterbox bars out of a word that invites them. Approved by Adi
 * (2026-09-14). UNMEASURED except where acceptance measures them: "moodier" alone, "cinematic" in a
 * compound.
 */
import { lookOf, type LookName } from "../lookVocab";

/** ONE PHRASE PER LOOK. A Record over every look, so a look with no phrase does not build. */
export const LOOK_PHRASES: Readonly<Record<LookName, string>> = {
  // ── Main's fifteen: the word itself, as it has always been sent ──
  "black and white": "black and white",
  "b&w": "b&w",
  monochrome: "monochrome",
  sepia: "sepia",
  "golden hour": "golden hour",
  "colour grade": "colour grade",
  "color grade": "color grade",
  grading: "grading",
  "film look": "film look",
  "vintage look": "vintage look",
  warmer: "warmer",
  cooler: "cooler",
  brighter: "brighter",
  darker: "darker",
  "more contrast": "more contrast",
  // ── The style vocabulary's seven ──
  moodier:
    "moodier — darker overall, with deeper shadows and more subdued colour",
  dramatic:
    "more dramatic — stronger contrast between highlights and shadows, with deeper, richer colour",
  softer:
    "softer — gentler contrast, lifted shadows and a smooth, diffused glow, with every detail kept sharp",
  muted: "muted — softer, less saturated colour with gently faded blacks",
  vibrant: "more vibrant — richer, more saturated colour with lively contrast",
  cinematic:
    "cinematic — a film-style colour grade across the full frame: rich contrast, deep shadows and a restrained, filmic palette",
  editorial:
    "editorial — a clean, polished magazine-style grade: crisp contrast, true-to-life colour and bright, even tones",
};

/**
 * What a look's change sends: the phrase of the look her word names — or, for a word no look knows, the
 * word itself, exactly as the template sent every change before this table existed.
 */
export function lookPhrase(change: string | null): string {
  const look = change === null ? null : lookOf(change);
  return look ? LOOK_PHRASES[look] : `${change}`;
}
