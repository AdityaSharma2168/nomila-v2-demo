/**
 * agent/postKit/caption.ts — a post's caption, tags and shot list, read out of what the plan wrote. Pure: no database,
 * no model, no import past this file, so the plan's own checks (agent/plan/validate.ts) read a caption the same way the
 * kit does.
 *
 * plan 1.7.0 returns the three as fields of their own (shared/plan.ts PlanDeliverable caption / hashtags / shots) and
 * the kit takes those — a 1.7.0 deliverable's body is NEVER read for its caption, even when its caption is empty. A
 * post_brief written before it carries all three in one `body`, labelled however the model liked — "Caption: … Shots:
 * …", but also "Format: … Slide 1: … Caption draft: …" — and the reader before this one split only on a LINE starting
 * "Caption:" / "Copy:" / "Post text:", so every kit built from the second shape stored the whole production brief as its
 * caption.
 *
 * The structured field (1.7.0):
 *   captionField      the model's own caption, kept whole: only a LEADING "Caption:"-style label and wrapping quotes come
 *                     off — nothing is ever cut from the middle (a caption may say "Note:" or "Music:"). One whole-field
 *                     refusal: a "caption" that OPENS with a production label (Format:, Slide 1:, Frame 2:, Shot 3:,
 *                     Shots:, Shot list:, Cover:, Reel:, Carousel:, Hook:, On-screen text:, Overlay:, Audio:) is the brief
 *                     put in the wrong field, and reads as "" (no caption).
 *   splitTags         the caption's tags moved out: a closing run of tags goes whole; an inline tag with a letter in it
 *                     keeps its word ("Big #GameDay energy" → "Big GameDay energy") and its tag moves; a number-only tag
 *                     ("#23") is a number, not a tag, and stays
 *
 * An older body (before 1.7.0):
 *   partsOfBody       the body's labelled parts, in order (the text before the first label is the preamble)
 *   captionFromBody   the caption: the first caption-labelled part (of a "Caption options:" list, its first option);
 *                     else the preamble when every label is a shot or tag label (the old "words, then Shots:" shape);
 *                     else the whole text when there is no label at all; else "" (a brief with no caption label)
 *   shotListFromBody  the shot list: the shot-labelled parts, else the numbered slides / frames / scenes; "" for none
 *   hashtagsFromBody  the tags a body carries: a "Hashtags:" part's, then the caption's
 *
 * What is guaranteed for an older body, and what is not. Guaranteed: when the body's labels are among those listed
 * below, only text a caption label introduced reaches the caption — brief lines under those labels never do. Labels are
 * read at a line start in any case (after a bullet, a "1." list number, **bold**, or as a "## Caption" markdown heading
 * with or without a colon), and inline when they start with a capital ("… a hard rep. Caption draft: …"; a list number
 * before an inline label goes with it, so "1. Caption: … 2. Shots: …" leaves no stray "2."). NOT guaranteed: labels in
 * another language, or English labels not on the list, are not recognised — such a body reads as unlabelled, and an
 * unlabelled older body is read whole as the caption (it was asked for the caption first, and that was the old reader's
 * rule too). The list is closed: an older caption that says "Music: …" mid-line is cut there — rare, and a cut caption
 * is safer than a brief posted as one.
 *
 * Tags:
 *   hashtagsOf        the tags a text carries (NFC-normalised, letters with their accents), first spelling kept,
 *                     case-insensitively unique
 *   hashtagList       a structured list of tags made safe: NFC, "#" added when missing, spaces and hyphens dropped
 *                     ("#game-day" → "#gameday"), only letters, accents, digits and "_" after it, unique, at most `max`
 *   withTags          the caption as it is pasted: the words, then a blank line and the tags the words do not carry
 */

const CAPTION_WORDS = String.raw`(?:(?:draft|suggested|proposed|sample)\s+)?(?:caption|copy|post\s+(?:text|copy))(?:\s+(?:drafts?|text|ideas?|options?|copy))?(?:\s*\d+)?`;
const TAG_WORDS = String.raw`hashtags?|tags`;
const SHOT_WORDS = String.raw`shot\s+list|shots?|b-?roll|visuals?|footage|clips?`;
const SLIDE_WORDS = String.raw`(?:slide|frame|card|scene|shot|clip|story(?:\s+frame)?)\s*\d+`;
const BRIEF_WORDS = String.raw`format|slides|frames|cover(?:\s+(?:image|frame|photo|slide))?|on-?screen\s+text|text\s+overlay|overlay|audio|music|sound|hook|cta|call\s+to\s+action|timing|when\s+to\s+post|post\s+time|platform|length|duration|notes?|structure`;
/** Every label, longest alternatives first so "Slide 1" is read before "Slides" and "Shot list" before "Shots". */
const LABEL = `(${SLIDE_WORDS}|${CAPTION_WORDS}|${TAG_WORDS}|${SHOT_WORDS}|${BRIEF_WORDS})`;
/** An optional parenthesis after a label: "Slide 1 (cover):". */
const PAREN = String.raw`(?:\s*\([^)\n]{0,40}\))?`;
/** A list marker before a label: a bullet, or a list number ("1." / "2)"). */
const MARK = String.raw`(?:[-*•]|\d{1,2}[.)])`;
/** At a line start: any case, a list marker or bold around it, then ":" or a spaced dash ("Shots — …", never "Cover-up"). */
const LINE_LABEL = new RegExp(String.raw`^[ \t]*(?:${MARK}[ \t]*)?\**[ \t]*${LABEL}${PAREN}[ \t]*\**[ \t]*(?::|[\-–—](?=[ \t]))[ \t]*\**[ \t]*`, "gimu");
/** A markdown heading: "## Caption", "### Shots:" — the colon optional, the heading alone on its line or followed by ":". */
const HEADING_LABEL = new RegExp(String.raw`^[ \t]*#{1,6}[ \t]+\**${LABEL}${PAREN}\**[ \t]*(?::[ \t]*|[ \t]*$)`, "gimu");
/** Inline: after a space or a sentence's end (a list number before it goes with it), then ":". Capital first (below). */
const INLINE_LABEL = new RegExp(String.raw`(?<=[\s.!?…"”')\]])(?:\d{1,2}[.)][ \t]+)?\**${LABEL}${PAREN}\**[ \t]*:[ \t]*\**[ \t]*`, "giu");

const CAPTION_RE = new RegExp(`^(?:${CAPTION_WORDS})$`, "iu");
const TAG_RE = new RegExp(`^(?:${TAG_WORDS})$`, "iu");
const SHOT_RE = new RegExp(`^(?:${SHOT_WORDS})$`, "iu");
const SLIDE_RE = new RegExp(`^(?:${SLIDE_WORDS})$`, "iu");
/** A leading caption label on the structured field (captionField): only this comes off it. */
const LEADING_CAPTION_LABEL = new RegExp(String.raw`^\s*(?:${MARK}\s*)?\**\s*(?:#{1,6}\s+)?${CAPTION_WORDS}${PAREN}\s*\**\s*(?::|[\-–—](?=\s))\s*\**\s*`, "iu");
/** A production label opening the structured field: the brief put where the caption goes (captionField). */
const OPENS_WITH_BRIEF = /^\s*(?:[-*•]\s*)?\**\s*(?:format|reel|carousel|hook|on-?screen\s+text|overlay|audio|cover|shots?|shot\s+list|(?:slide|frame|shot)\s*\d+)\s*(?:\([^)\n]{0,40}\))?\s*\**\s*:/iu;

/** One tag: "#", then letters (with their combining accents), digits or "_". */
const TAG = /#[\p{L}\p{M}\p{N}_]+/gu;
const nfc = (s: string) => s.normalize("NFC");

export type BodyLabel = "caption" | "hashtags" | "shots" | "slide" | "brief";

export interface BodyPart {
  label: BodyLabel;
  text: string;
}

export interface BodyParts {
  /** The text before the first label ("" when the body opens with one). */
  preamble: string;
  parts: BodyPart[];
}

const kindOf = (word: string): BodyLabel => {
  const w = word.replace(/\s+/g, " ").trim();
  if (CAPTION_RE.test(w)) return "caption";
  if (TAG_RE.test(w)) return "hashtags";
  if (SLIDE_RE.test(w)) return "slide";
  if (SHOT_RE.test(w)) return "shots";
  return "brief";
};

/** Wrapping quotes off: "“Four weeks out.” #tag" → "Four weeks out. #tag" (the tags after the quote stay). */
function unquote(t: string): string {
  const quoted = /^["“”']([^"“”]*)["“”'](\s+(?:#[\p{L}\p{M}\p{N}_]+\s*)+)?$/u.exec(t);
  return quoted ? [quoted[1].trim(), (quoted[2] ?? "").trim()].filter(Boolean).join(" ") : t;
}

/** A part's words: trimmed, wrapping quotes and stray bold markers off, runs of blank lines folded. */
function tidy(text: string): string {
  return unquote(text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().replace(/^\*+|\*+$/g, "").trim());
}

/** Of a list of options ("1. … 2. …", or bullets), the first; any other text as it is. */
function firstOption(text: string): string {
  const numbered = /^1[.)]\s+([\s\S]*?)(?:\s+2[.)]\s[\s\S]*)?$/u.exec(text);
  if (numbered) return tidy(numbered[1]);
  const bulleted = /^[-*•]\s+([^\n]*)(?:\n\s*[-*•]\s[\s\S]*)?$/u.exec(text);
  return bulleted ? tidy(bulleted[1]) : text;
}

/** The body's labelled parts, in the order they appear. */
export function partsOfBody(body: string): BodyParts {
  const text = nfc(body.replace(/\r\n?/g, "\n"));
  const hits: Array<{ at: number; end: number; label: BodyLabel }> = [];
  const add = (at: number, end: number, word: string) => {
    if (hits.some((h) => at < h.end && h.at < end)) return; // the same label, already read another way
    hits.push({ at, end, label: kindOf(word) });
  };
  for (const m of text.matchAll(HEADING_LABEL)) add(m.index!, m.index! + m[0].length, m[1]);
  for (const m of text.matchAll(LINE_LABEL)) add(m.index!, m.index! + m[0].length, m[1]);
  for (const m of text.matchAll(INLINE_LABEL)) {
    if (!/^\p{Lu}/u.test(m[1])) continue;
    add(m.index!, m.index! + m[0].length, m[1]);
  }
  hits.sort((a, b) => a.at - b.at);
  const parts = hits.map((h, i) => ({ label: h.label, text: tidy(text.slice(h.end, i + 1 < hits.length ? hits[i + 1].at : text.length)) }));
  return { preamble: tidy(text.slice(0, hits.length ? hits[0].at : text.length)), parts };
}

/** The caption an older body carries, or "" when it is a brief with no caption in it (see the header). */
export function captionFromBody(body: string): string {
  const { preamble, parts } = partsOfBody(body);
  if (!parts.length) return preamble;
  const caption = parts.find((p) => p.label === "caption" && p.text);
  if (caption) return firstOption(caption.text);
  return parts.every((p) => p.label === "shots" || p.label === "hashtags") ? preamble : "";
}

/** The shot list a body carries, on one line, or "". */
export function shotListFromBody(body: string): string {
  const { parts } = partsOfBody(body);
  const line = (s: string) => s.replace(/\s+/g, " ").trim();
  const shots = parts.filter((p) => p.label === "shots" && p.text).map((p) => line(p.text));
  if (shots.length) return shots.join(" ");
  return parts.filter((p) => p.label === "slide" && p.text).map((p) => line(p.text).replace(/[.;,]+$/, "")).join("; ");
}

/**
 * The structured caption (plan 1.7.0) as the model wrote it, kept whole: a leading caption label and wrapping quotes
 * off, "" for one that opens with a production label (see the header). Never cut mid-text.
 */
export function captionField(text: string): string {
  const t = nfc(text.replace(/\r\n?/g, "\n")).trim();
  if (OPENS_WITH_BRIEF.test(t)) return "";
  return tidy(t.replace(LEADING_CAPTION_LABEL, ""));
}

/** The caption's tags moved out (see the header): the words left, and the tags in the order they appeared. */
export function splitTags(caption: string): { words: string; tags: string[] } {
  const tags: string[] = [];
  const lines = nfc(caption).split("\n");
  // The closing run: tags-only last lines, then the tags that end the last line with words.
  while (lines.length && lines[lines.length - 1].trim() && lines[lines.length - 1].replace(TAG, "").trim() === "") {
    tags.unshift(...(lines.pop()!.match(TAG) ?? []));
  }
  let text = lines.join("\n");
  const end = /(?:\s+#[\p{L}\p{M}\p{N}_]+)+\s*$/u.exec(text);
  if (end && /\p{L}/u.test(end[0])) { tags.unshift(...(end[0].match(TAG) ?? [])); text = text.slice(0, end.index); }
  // Inline tags with a letter: the word stays, the tag moves (ahead of the closing run: the order they appeared in).
  // Number-only tags ("#23") stay as written.
  const inline: string[] = [];
  text = text.replace(TAG, (t) => (/\p{L}/u.test(t) ? (inline.push(t), t.slice(1)) : t));
  return { words: text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), tags: hashtagsOf([...inline, ...tags].join(" ")) };
}

/** The tags a text carries, first spelling kept, case-insensitively unique. */
export function hashtagsOf(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of nfc(text).matchAll(TAG)) {
    const k = m[0].toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(m[0]); }
  }
  return out;
}

/** The tags a body carries: a "Hashtags:" part's first, then the caption's own. */
export function hashtagsFromBody(body: string): string[] {
  const tagParts = partsOfBody(body).parts.filter((p) => p.label === "hashtags").map((p) => p.text);
  return hashtagsOf([...tagParts, captionFromBody(body)].join(" "));
}

/** A structured list of tags made safe (see the header), at most `max`. */
export function hashtagList(values: unknown, max: number): string[] {
  const words = (Array.isArray(values) ? values : [])
    .filter((v): v is string => typeof v === "string")
    .map((v) => nfc(v).trim().replace(/^#+/, "").replace(/[\s\-‐‑–—]+/gu, ""))
    .filter((w) => /^[\p{L}\p{M}\p{N}_]+$/u.test(w));
  return hashtagsOf(words.map((w) => `#${w}`).join(" ")).slice(0, max);
}

/** The caption as it is pasted: the words, then (after a blank line) every tag the words do not already carry. */
export function withTags(words: string, tags: readonly string[]): string {
  const carried = new Set(hashtagsOf(words).map((t) => t.toLowerCase()));
  const rest = tags.filter((t) => !carried.has(t.toLowerCase()));
  return [words.trim(), rest.join(" ")].filter(Boolean).join("\n\n");
}
