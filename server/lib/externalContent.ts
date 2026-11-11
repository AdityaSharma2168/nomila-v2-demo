/**
 * lib/externalContent.ts — the ONE place a prompt wraps outside text in a tag (`<external_content>`, `<inputs>`).
 *
 * A wrapper tag only means something if the text inside cannot end it. A brand email (or a web page, a store
 * title, a visitor message) that contains `</external_content>` followed by instructions would otherwise close
 * the wrapper early and put those instructions outside it: a prompt-injection path. So every wrapper is built
 * here, and the text is escaped first: any opening or closing form of the wrapper's own tag inside the text is
 * replaced with a visible "[removed delimiter]" marker. Nothing else changes, so the text stays readable.
 *
 * HOW A TAG IS FOUND. Detection runs on a NORMALISED COPY of the text, never on the text itself; only the span a
 * match covers is replaced in the original, so ordinary text comes out byte-for-byte as it went in. The copy:
 *   - decodes HTML entities that spell a delimiter character (`&lt;`, `&#60;`, `&#x3c;`, `&sol;`, `&lowbar;`, …),
 *   - applies NFKC per character (fullwidth `＜`, small-form `﹤`, styled letters become plain ones),
 *   - drops characters a reader does not see: zero-width space/joiners, word joiner, BOM, soft hyphen, LRM/RLM,
 *     ALM, bidi embeddings/overrides/isolates, the combining grapheme joiner, variation selectors, tag characters.
 * A tag is then `<`, optional `/`, `\` or `//` (any mix, spaces allowed), the tag name in any case with `_`, `-`, a
 * space or nothing between its words, and, if a `>` follows within 200 characters with no new `<`, its attributes
 * and `>`. A tag left unclosed is still caught (only its start is replaced, so no text is lost).
 *
 * LINEAR TIME. The scan is a hand-written single pass, not a backtracking regex: every gap it skips is bounded
 * (16 characters), so a hostile input (`<` plus 200k spaces or zero-width characters) costs O(n). The perf tests in
 * externalContent.test.ts and externalFences.test.ts hold this under 50 ms at 200k characters.
 *
 * Same idea as the voice worker (nomila-co/mila-voice src/threadTool.ts), broader. The guard in
 * externalContent.test.ts fails if any other server file builds one of these wrappers by hand, or if Mila builds a
 * `<<<NAME>>>` fence (below) without fenceOpen/fenceClose and neutralizeFences.
 */

/** What a smuggled delimiter becomes. Visible, not silent, so a reader can tell text was removed. */
export const NEUTRALIZED_DELIMITER = "[removed delimiter]";

export const EXTERNAL_TAG = "external_content";

/** The most characters any one gap (spaces, slashes, separators) may span. Bounds the scan; keeps it linear. */
const MAX_GAP = 16;
/** How far past a tag name a closing `>` is looked for. */
const MAX_ATTRS = 200;

// ── The normalised copy ───────────────────────────────────────────────────────────────────────────────────────────

/** A normalised copy of a text as char codes: `c[k]` came from the original's [from[k], to[k]). */
interface Normalised {
  c: Uint16Array;
  len: number;
  from: Int32Array;
  to: Int32Array;
}

/** Characters a reader never sees; dropped from the copy. */
function invisible(c: number): boolean {
  return (
    c === 0x00ad || c === 0x034f || c === 0x061c || c === 0x180e ||
    (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2069) ||
    c === 0xfeff || (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0xe0000 && c <= 0xe007f) || (c >= 0xe0100 && c <= 0xe01ef)
  );
}

const NAMED: Record<string, number> = {
  lt: 60, gt: 62, sol: 47, bsol: 92, lowbar: 95, underbar: 95, hyphen: 45, dash: 45, minus: 45,
  nbsp: 32, tab: 32, newline: 10, amp: 38, lsaquo: 60, rsaquo: 62,
};

const nfkcCache = new Map<number, string>();
function nfkc(cp: number): string {
  let out = nfkcCache.get(cp);
  if (out === undefined) {
    out = String.fromCodePoint(cp).normalize("NFKC");
    if (nfkcCache.size < 8192) nfkcCache.set(cp, out);
  }
  return out;
}

const isDigit = (c: number) => c >= 48 && c <= 57;
const isHex = (c: number) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

/** An HTML entity at `i` (`&lt;`, `&#60;`, `&#x3C;`; the `;` optional): [decoded code point, length] or null. */
function entityAt(t: string, i: number): [number, number] | null {
  let j = i + 1;
  if (t.charCodeAt(j) === 35 /* # */) {
    j++;
    const x = t.charCodeAt(j);
    const hex = x === 120 || x === 88;
    if (hex) j++;
    const start = j;
    while (j < t.length && j - start < 8 && (hex ? isHex(t.charCodeAt(j)) : isDigit(t.charCodeAt(j)))) j++;
    if (j === start) return null;
    const cp = parseInt(t.slice(start, j), hex ? 16 : 10);
    if (!(cp > 0 && cp <= 0x10ffff)) return null;
    if (t.charCodeAt(j) === 59) j++;
    return [cp, j - i];
  }
  const start = j;
  while (j < t.length && j - start < 10 && isAlpha(t.charCodeAt(j))) j++;
  const cp = NAMED[t.slice(start, j).toLowerCase()];
  if (cp === undefined) return null;
  if (t.charCodeAt(j) === 59) j++;
  return [cp, j - i];
}

function normalise(t: string): Normalised {
  const n = t.length;
  // NFKC can expand a character; grow on demand.
  let cap = n + 16;
  let c = new Uint16Array(cap);
  let from = new Int32Array(cap);
  let to = new Int32Array(cap);
  let k = 0;
  const put = (code: number, a: number, b: number) => {
    if (k === cap) {
      cap *= 2;
      const c2 = new Uint16Array(cap); c2.set(c); c = c2;
      const f2 = new Int32Array(cap); f2.set(from); from = f2;
      const t2 = new Int32Array(cap); t2.set(to); to = t2;
    }
    c[k] = code; from[k] = a; to[k] = b; k++;
  };
  /** One code point from [a, b) of the original: dropped if invisible, else its NFKC form. */
  const putCp = (cp: number, a: number, b: number) => {
    if (cp < 0x80) return put(cp, a, b);
    if (invisible(cp)) return;
    const s = nfkc(cp);
    for (let u = 0; u < s.length; u++) {
      const code = s.charCodeAt(u);
      if (!invisible(code)) put(code, a, b);
    }
  };
  let i = 0;
  while (i < n) {
    const code = t.charCodeAt(i);
    if (code === 38 /* & */) {
      const e = entityAt(t, i);
      if (e) {
        putCp(e[0], i, i + e[1]);
        i += e[1];
        continue;
      }
    }
    if (code < 0x80) {
      put(code, i, i + 1);
      i++;
      continue;
    }
    const cp = t.codePointAt(i)!;
    const w = cp > 0xffff ? 2 : 1;
    putCp(cp, i, i + w);
    i += w;
  }
  return { c, len: k, from, to };
}

// ── Scanning helpers (all bounded) ────────────────────────────────────────────────────────────────────────────────

const LT = 60, GT = 62, SLASH = 47, BSLASH = 92, UNDER = 95, DASH = 45;

// Not Math.min: a global lookup inside a hot loop is slow under Jest's VM context (measured ~70 ms per 200k calls).
const minOf = (a: number, b: number) => (a < b ? a : b);

function isSpace(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
}
const isWordCode = (c: number) => isAlpha(c) || isDigit(c) || c === UNDER;
const lower = (c: number) => (c >= 65 && c <= 90 ? c + 32 : c);

function skipSpaces(n: Normalised, j: number): number {
  const stop = minOf(n.len, j + MAX_GAP);
  while (j < stop && isSpace(n.c[j])) j++;
  return j;
}

/** `/`, `\` or any short mix of them, with spaces: the closing-tag mark. */
function skipSlashes(n: Normalised, j: number): number {
  const stop = minOf(n.len, j + MAX_GAP);
  while (j < stop && (n.c[j] === SLASH || n.c[j] === BSLASH || isSpace(n.c[j]))) j++;
  return j;
}

/** The name's words (lower-case char codes) at `j`, any case, up to MAX_GAP of `_`, `-` or spaces between. End or -1. */
function matchName(n: Normalised, j: number, words: number[][]): number {
  for (let w = 0; w < words.length; w++) {
    if (w > 0) {
      const stop = minOf(n.len, j + MAX_GAP);
      while (j < stop && (n.c[j] === UNDER || n.c[j] === DASH || isSpace(n.c[j]))) j++;
    }
    const word = words[w];
    if (n.len - j < word.length) return -1;
    for (let x = 0; x < word.length; x++) if (lower(n.c[j + x]) !== word[x]) return -1;
    j += word.length;
  }
  return j < n.len && isWordCode(n.c[j]) ? -1 : j;
}

/** Replace the given normalised-index spans [a, b) in the original text. */
function replaceSpans(text: string, n: Normalised, spans: number[]): string {
  if (!spans.length) return text;
  const parts: string[] = [];
  let at = 0;
  for (let s = 0; s < spans.length; s += 2) {
    const start = n.from[spans[s]];
    const end = n.to[spans[s + 1] - 1];
    if (start < at) continue;
    parts.push(text.slice(at, start), NEUTRALIZED_DELIMITER);
    at = end;
  }
  parts.push(text.slice(at));
  return parts.join("");
}

/** True when nothing in `t` could spell a delimiter: ASCII with none of `<`, `&` (or `extra`). Skips normalising. */
function plainAscii(t: string, extra = -1): boolean {
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c >= 0x80 || c === LT || c === 38 || c === extra) return false;
  }
  return true;
}

const wordsOf = (name: string): number[][] =>
  name.toLowerCase().split(/[_-]/).filter(Boolean).map((w) => Array.from(w, (ch) => ch.charCodeAt(0)));

// ── Tags ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `text` with every opening or closing form of `<tag>` neutralised. Everything else is left exactly as it was. */
export function neutralizeDelimiter(text: string, tag: string = EXTERNAL_TAG): string {
  if (plainAscii(text)) return text;
  const words = wordsOf(tag);
  const n = normalise(text);
  const spans: number[] = [];
  for (let i = 0; i < n.len; i++) {
    if (n.c[i] !== LT) continue;
    const nameEnd = matchName(n, skipSlashes(n, skipSpaces(n, i + 1)), words);
    if (nameEnd < 0) continue;
    let end = nameEnd;
    const stop = minOf(n.len, nameEnd + MAX_ATTRS);
    for (let m = nameEnd; m < stop; m++) {
      if (n.c[m] === LT) break;
      if (n.c[m] === GT) {
        end = m + 1;
        break;
      }
    }
    spans.push(i, end);
    i = end - 1;
  }
  return replaceSpans(text, n, spans);
}

/** `text` inside `<tag attrs>…</tag>`, with any copy of the tag inside it neutralised first. */
export function wrapTagged(text: string, tag: string, attrs: Record<string, string> = {}, opts: { newlines?: boolean } = {}): string {
  const a = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${v.replace(/["<>&]/g, "")}"`)
    .join("");
  const nl = opts.newlines ? "\n" : "";
  return `<${tag}${a}>${nl}${neutralizeDelimiter(text, tag)}${nl}</${tag}>`;
}

/**
 * Outside text (email, brand research, web pages, visitors) wrapped as data the model must never obey.
 * null/undefined stay null: an absent field is not untrusted text.
 */
export function external(text: string | null | undefined, attrs: Record<string, string> = {}, opts: { newlines?: boolean } = {}): string | null {
  return text == null ? null : wrapTagged(text, EXTERNAL_TAG, attrs, opts);
}

/** A wrapper's opening / closing tag, for a module that exports its markers (tests match on them). Wrap with wrapTagged. */
export const tagOpen = (tag: string): string => `<${tag}>`;
export const tagClose = (tag: string): string => `</${tag}>`;

/**
 * The studio fence markers. Only studio/compile/fence.ts and templates.ts may use them, and only around text that
 * went through neutralizeDelimiter (the guard test holds both). Everyone else calls external().
 */
export const EXTERNAL_OPEN = `<${EXTERNAL_TAG}>`;
export const EXTERNAL_CLOSE = `</${EXTERNAL_TAG}>`;

// ── The `<<<NAME>>> … <<<END_NAME>>>` fence style ─────────────────────────────────────────────────────────────────
//
// Mila's older prompts fence data blocks with triple angle brackets instead of a tag. The same rule applies: text
// inside a fence must not be able to end it, or open a second one that reads like ours. Detection uses the same
// normalised copy and bounded gaps as tags, and only the BRACKETS are replaced, so the neighbouring word stays
// ("<<< see below" becomes "[removed delimiter] see below"):
//   - an opener: three `<` (spaces allowed between, `&lt;`, fullwidth, …) followed by a name, optionally after
//     `/` (`<<<END_ONBOARDING_CONTEXT`, `<< < CONTRACT`, `<<</ATTACHED`); the `<<<` and any slash are replaced;
//   - a closer: three `>` right after an upper-case name of 3+ characters (`END_TURN>>>`, `CONTRACT> >>`).
// A quoted-reply `>>>`, `>>>` after a lower-case word, `<<widget:…>>` and a `<<<` followed by a digit or symbol
// are left alone.

/** The end of three `<` (or `>`) starting at `i`, gaps of up to MAX_GAP spaces allowed between them; or -1. */
function tripleAt(n: Normalised, i: number, ch: number): number {
  let j = i;
  for (let count = 0; count < 3; count++) {
    if (count > 0) j = skipSpaces(n, j);
    if (j >= n.len || n.c[j] !== ch) return -1;
    j++;
  }
  return j;
}

const isUpperName = (c: number) => (c >= 65 && c <= 90) || isDigit(c) || c === UNDER;

/**
 * `text` with every `<<<NAME>>>`-style fence bracket run neutralised. Everything else is left exactly as it was.
 * `names`: the caller's own fence names (e.g. ["EMAIL"]); a closer after one of these is caught in ANY case
 * (`email >>>`), not only upper-case.
 */
export function neutralizeFences(text: string, opts: { names?: string[] } = {}): string {
  const own = new Set((opts.names ?? []).map((x) => x.toLowerCase()));
  if (plainAscii(text, GT)) return text;
  const n = normalise(text);
  const spans: number[] = [];
  for (let i = 0; i < n.len; i++) {
    const c = n.c[i];
    if (c === LT) {
      const end = tripleAt(n, i, LT);
      if (end < 0) continue;
      const nameAt = skipSlashes(n, skipSpaces(n, end));
      if (nameAt < n.len && (isAlpha(n.c[nameAt]) || n.c[nameAt] === UNDER)) {
        // Replace the brackets and any slash; keep the name. Trailing spaces stay with the name.
        let stop = nameAt;
        while (stop > end && isSpace(n.c[stop - 1])) stop--;
        spans.push(i, stop);
        i = stop - 1;
      }
    } else if (c === GT) {
      const end = tripleAt(n, i, GT);
      if (end < 0) continue;
      // Look back over spaces, then an upper-case name of at least 3 characters (bounded: 64).
      let k = i;
      const gapStop = i - MAX_GAP < 0 ? 0 : i - MAX_GAP;
      while (k > gapStop && isSpace(n.c[k - 1])) k--;
      let len = 0;
      while (k - len > 0 && len < 64 && isUpperName(n.c[k - len - 1])) len++;
      let hasLetter = false;
      for (let x = k - len; x < k; x++) if (n.c[x] >= 65 && n.c[x] <= 90) hasLetter = true;
      // A lower-case letter right before the name means it is the tail of an ordinary word ("okAYE>>>" is not a fence).
      const lowerBefore = k - len > 0 && n.c[k - len - 1] >= 97 && n.c[k - len - 1] <= 122;
      // One of the caller's own names, in any case ("email >>>").
      let ownName = false;
      if (own.size) {
        let w = 0;
        while (k - w > 0 && w < 64 && isWordCode(n.c[k - w - 1])) w++;
        let word = "";
        for (let x = k - w; x < k; x++) word += String.fromCharCode(lower(n.c[x]));
        for (const name of own) if (word === name || word.endsWith(name)) ownName = true;
      }
      if (ownName || (len >= 3 && hasLetter && !lowerBefore)) {
        spans.push(i, end);
        i = end - 1;
      }
    }
  }
  return replaceSpans(text, n, spans);
}

// ── `[LABEL …]` markers ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * `text` with every `[ … ]` label whose letters spell `letters` (case, spacing and punctuation ignored, on the same
 * normalised copy) neutralised: e.g. letters "pdfattachment" catches `[END PDF ATTACHMENT]`, `[ end  pdf-attachment ]`
 * and `[UNTRUSTED PDF ATTACHMENT — …]`. A label is `[` up to the next `]` within 200 characters with no `[` or
 * newline in between; each scan stops at the next `[`, so the pass is linear.
 */
export function neutralizeBracketLabels(text: string, letters: string): string {
  if (!/[[［]/.test(text) && !text.includes("&")) return text;
  const wantCodes = Array.from(letters.toLowerCase(), (ch) => ch.charCodeAt(0));
  const n = normalise(text);
  const spans: number[] = [];
  for (let i = 0; i < n.len; i++) {
    if (n.c[i] !== 91 /* [ */) continue;
    const stop = minOf(n.len, i + MAX_ATTRS);
    let end = -1;
    // Match `want` against the label's letters as they stream past (naive restart; `want` is a short fixed word).
    let matched = 0;
    let found = false;
    for (let m = i + 1; m < stop; m++) {
      const c = n.c[m];
      if (c === 91 || c === 10) break;
      if (c === 93 /* ] */) {
        end = m + 1;
        break;
      }
      if (found || !isAlpha(c)) continue;
      const l = lower(c);
      if (l === wantCodes[matched]) matched++;
      else matched = l === wantCodes[0] ? 1 : 0;
      if (matched === wantCodes.length) found = true;
    }
    if (end > 0 && found) {
      spans.push(i, end);
      i = end - 1;
    }
  }
  return replaceSpans(text, n, spans);
}

/** The opening marker of a `<<<NAME>>>` fence. Build fences with these, never with a `<<<` literal. */
export const fenceOpen = (name: string): string => `<<<${name}>>>`;
/** The closing marker of a `<<<NAME>>>` fence: `<<<END_NAME>>>`. */
export const fenceClose = (name: string): string => `<<<END_${name}>>>`;
