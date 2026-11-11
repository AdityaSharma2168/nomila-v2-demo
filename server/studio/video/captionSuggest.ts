/**
 * captionSuggest.ts — a caption she can start from, made by rule from the words already on her board.
 *
 * ─── $0, NO MODEL, SAME ANSWER EVERY TIME (PR 15, R-5, docs/probes/composer.md) ─────────────────
 *
 * The Board's row sentences are the only source. The first sentence is the opener, and the caption on
 * the first clip is its hook — so the suggestion is that sentence's leading clause, cut at a word
 * boundary to fit `CAPTION_MAX_CHARS`, and then judged by the same `normalizeCaptionText` the stitch
 * spec uses. What it cannot draw, it does not suggest: a clause that fails the character rule is null,
 * never "fixed".
 *
 * ─── NEVER A GENERIC CAPTION (Adi, D-3) ──────────────────────────────────────────────────────────
 *
 * With no sentence there is nothing to suggest, and the answer is null — the chip does not appear.
 * The objective is accepted and validated so the client sends one shape, but it never becomes words:
 * "Grow following" over her clip is exactly the caption this module exists to avoid. She always
 * types over whatever is suggested; this is a starting point, not a caption.
 *
 * Model-backed captions stay a card. There is no CapCut handoff and none is built (AUDIT2 F25(b)).
 */
import { CAPTION_MAX_CHARS, normalizeCaptionText } from "./captions";
import { MAX_FEEL_CHARS, MAX_FEEL_LINES } from "../music/suggest";

export interface CaptionSuggestion {
  /** The words, or null when her sentences give nothing a caption can be made from. */
  suggestion: string | null;
}

/** Where a sentence's leading clause ends: a sentence end, or the first hard break inside it. */
const CLAUSE_END = /[.!?]|\s[—–-]\s|;|:\s|,["”’']?\s/;

/** U+2026, allowed by captions.ts's ranges — the one mark a cut clause may end on. */
const ELLIPSIS = "…";

/**
 * The leading clause of one sentence as a caption, or null.
 *
 * Exported for the test that walks a corpus of sentences and proves every non-null answer passes
 * `normalizeCaptionText` — the bound is enforced by the same function that refuses a stored caption.
 */
export function captionFrom(sentence: string): string | null {
  const flat = sentence.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const at = flat.search(CLAUSE_END);
  let clause = (at > 0 ? flat.slice(0, at) : flat).trim();
  // A clause that opens on a quote or bracket and never closes it reads as a typo on a clip.
  clause = clause.replace(/^["'“‘(\[]+|["'”’)\]]+$/g, "").trim();
  if (!clause) return null;
  clause = clause.charAt(0).toUpperCase() + clause.slice(1);
  let points = Array.from(clause);
  if (points.length > CAPTION_MAX_CHARS) {
    // Cut at the last word boundary that leaves room for the ellipsis.
    const room = CAPTION_MAX_CHARS - 1;
    const head = points.slice(0, room).join("");
    const cut = head.lastIndexOf(" ");
    if (cut <= 0) return null;
    clause = head.slice(0, cut).replace(/[,;:\s]+$/g, "") + ELLIPSIS;
    points = Array.from(clause);
  }
  // Two words or fewer is a label, not a caption: "The gym" says nothing she would post.
  if (clause.replace(ELLIPSIS, "").trim().split(" ").length < 3) return null;
  return normalizeCaptionText(clause);
}

/**
 * The suggestion for a board: `feel` is the row sentences in row order (the same list the music
 * suggestion takes), `objective` the board's purpose. Pure.
 */
export function suggestCaption(
  body: unknown,
): CaptionSuggestion | { error: string } {
  const b = (body ?? {}) as { feel?: unknown; objective?: unknown };
  if (
    !Array.isArray(b.feel) ||
    b.feel.length > MAX_FEEL_LINES ||
    !b.feel.every((l): l is string => typeof l === "string") ||
    b.feel.join("").length > MAX_FEEL_CHARS
  ) {
    return {
      error: `feel is a list of up to ${MAX_FEEL_LINES} sentences, ${MAX_FEEL_CHARS} characters in all`,
    };
  }
  if (b.objective !== undefined && typeof b.objective !== "string") {
    return { error: "objective is a name" };
  }
  const first = (b.feel as string[]).find((l) => l.trim() !== "");
  if (first === undefined) return { suggestion: null };
  return { suggestion: captionFrom(first) };
}
