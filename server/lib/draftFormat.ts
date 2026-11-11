/**
 * draftFormat.ts — deterministic framing for AI reply drafts.
 *
 * The LLM only writes the letter body. Everything the athlete actually signs —
 * greeting, closing, signature — is composed here in code so every draft is a
 * complete, sendable email regardless of what the model does. sanitizeDraftBody
 * strips the failure modes we've seen in raw model output (subject lines,
 * self-added greetings/sign-offs, placeholders, leaked internal analysis).
 */

export interface ReplySignaturePref {
  sign_off?: string; // "Best", "Thanks", "Go Dawgs" — comma appended automatically
  name?: string;     // how the athlete signs their name
}

const DEFAULT_SIGN_OFF = "Best";

// A plausible human first name: letters (incl. accented), inner ' - . allowed.
const NAME_TOKEN_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’.-]*$/;

/** Extract a usable first name from an email display name ("Sarah Lee", "Lee, Sarah"). */
export function firstNameFrom(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(/^["']+|["']+$/g, "").trim();
  if (!s || s.includes("@")) return null; // email address, not a name
  // "Last, First" ordering — take the part after the comma
  const commaIdx = s.indexOf(",");
  if (commaIdx !== -1) {
    const after = s.slice(commaIdx + 1).trim();
    if (after) s = after;
  }
  const first = s.split(/\s+/)[0].replace(/[.,]+$/, "");
  if (first.length < 2 || !NAME_TOKEN_RE.test(first)) return null;
  return first[0].toUpperCase() + first.slice(1);
}

/** "Hi Sarah," → "Hi Acme team," → "Hi there," */
export function buildGreeting(opts: {
  senderName?: string | null;
  brandName?: string | null;
}): string {
  const first = firstNameFrom(opts.senderName);
  if (first) return `Hi ${first},`;
  const brand = opts.brandName?.trim();
  if (brand) return `Hi ${brand} team,`;
  return "Hi there,";
}

/** Closing + signature from the athlete's saved preference, e.g. "Best,\nJordan". */
export function buildSignature(
  pref: ReplySignaturePref | null | undefined,
  fallbackFullName?: string | null,
): string {
  const signOff =
    (pref?.sign_off ?? "").trim().replace(/[,\s]+$/, "") || DEFAULT_SIGN_OFF;
  const name =
    (pref?.name ?? "").trim() || firstNameFrom(fallbackFullName) || "";
  return name ? `${signOff},\n${name}` : `${signOff},`;
}

// ─── Body sanitation ─────────────────────────────────────────────────────────

const SUBJECT_LINE_RE = /^\s*(subject|re)\s*:/i;

// A greeting the model added despite instructions — only matched as the first
// non-empty line, and only when the whole line is just the salutation.
const GREETING_LINE_RE =
  /^\s*(hi|hey|hello|dear|good\s+(morning|afternoon|evening))\b[^.!?]{0,50}[,!:—–-]?\s*$/i;

// The same greeting run INTO the first sentence rather than sitting on its own
// line — "Hi Jenn! Thank you so much for reaching out." GREETING_LINE_RE is
// anchored to the whole line, so it never matched this shape and the salutation
// survived to be stacked under the code-composed one, producing a doubled
// greeting ("Hi Jennifer," / "Hi Jenn! …") in a real send.
//
// Deliberately much stricter than GREETING_LINE_RE. Between the greeting word and
// the separator it allows ONLY name-shaped tokens — capitalized words, or a short
// list of collective addresses — never arbitrary prose. An earlier attempt allowed
// any non-sentence-ending text there and happily turned
//   "Hi rates for social posts vary by scope, so let me explain."
// into "So let me explain.", eating real body copy. Requiring a separator AND a
// following word AND capitalized name tokens keeps it to genuine salutations.
// Case-sensitive on the name tokens on purpose, hence the explicit [Hh] pairs.
// Applied to the first content line only.
const GREETING_PREFIX_RE =
  /^\s*(?:[Hh]i|[Hh]ey|[Hh]ello|[Dd]ear|[Gg]ood\s+(?:[Mm]orning|[Aa]fternoon|[Ee]vening))(?:\s+(?:[A-Z][\w'’.-]*|there|team|all|everyone|folks)){0,3}\s*[,!:—–-]\s+(?=\S)/;

// A closing the model added despite instructions — only matched in the trailing
// block of short lines (see below), never mid-body.
const SIGNOFF_LINE_RE =
  /^\s*(best|best regards|best wishes|kind regards|warm regards|warmest regards|warmly|regards|sincerely|sincerely yours|thanks|thanks again|thanks so much|thank you|many thanks|cheers|respectfully|all the best|take care|talk soon)\s*[,!.]?\s*$/i;

// Internal machinery that must never reach a brand's inbox.
const INTERNAL_LINE_RE =
  /m\.?\s?i\.?\s?a\.?\s*(score|analysis|assessment)|leverage analysis|internal (note|analysis|recommendation)|deal assessment|drafted (by|with) (ai|an assistant)/i;

// Template placeholders the model sometimes emits instead of real values.
const PLACEHOLDER_RE =
  /\[\s*(your\s+|the\s+|athlete'?s?\s+)?(full\s+)?(name|brand|company|date|time|amount|rate|email|phone|signature|city|school|sport|handle|username|deliverables?|contact)(\s+name)?\s*\]|\{\{[^}]*\}\}/gi;

const TRAILING_BLOCK_MAX_LEN = 40; // sign-off/name lines are short

// ─── Hard-wrap reflow ────────────────────────────────────────────────────────
//
// Kimi hard-wraps its prose at ~72-75 columns. We send text/plain, so those breaks
// are real newlines that every mail client renders literally — and a phone then wraps
// the 75-char line AGAIN, which is the ragged spacing seen in sent replies:
//
//   It’s great to meet you, and I appreciate you following up! As I told Jenn &
//   the team, I really admire the brand and Gorjana’s personal story. Your
//   brand values are aligned with mine.
//
// Reflowing here (rather than at send) fixes the text the athlete reviews, the Gmail
// draft, and the sent mail from one place, and leaves paragraph structure intact.
//
// Rejoining is deliberately CONSERVATIVE. Leaving a line wrapped is merely the status
// quo; wrongly joining two lines destroys information — an address becomes prose, a
// rate table becomes a run-on. So all four signals of a mid-sentence wrap must agree:
//
//   1. the line is long enough to have HIT a wrap column (a short line was a choice);
//   2. it does not end in terminal punctuation — a wrap cuts a sentence mid-flight, so
//      ". ! ? : ;" means the author ended that line deliberately;
//   3. the next line resumes in LOWERCASE, as a broken sentence does — while a new list
//      item, a name, a city, a dollar row or a sign-off does not;
//   4. neither side is a list item or a URL.
//
// Signal 2 alone saves the cases that hurt most: "…whenever you are ready." can never
// swallow the address block beneath it, and "…described in your note." can never eat a
// rate table. Signal 3 saves unmarked lists ("Full usage rights for 6 months") and
// sign-offs this module's SIGNOFF_LINE_RE doesn't recognise ("Warm wishes,").
//
// The cost is under-joining — a continuation opening with a proper noun stays wrapped.
// That is the safe direction to be wrong in: the text is merely as ragged as before.
const WRAP_COLUMN_MIN = 60;
const LIST_MARKER_RE = /^\s*(?:[-*•·◦‣▪—–>»→✓+#|]|\(?\d+[.)]|[a-z][.)])\s+/i;
const ENDS_SENTENCE_RE = /[.!?:;]["'’”)\]]*$/;
// A lowercase letter (incl. accented) — the shape of a broken sentence resuming.
const CONTINUES_RE = /^[a-zà-öø-ÿ]/;
// Never join across a URL: a link on its own line is deliberate, and a model-wrapped
// URL would have a space inserted into the middle of it.
const URL_RE = /(?:https?:\/\/|www\.)\S*$|^\s*(?:https?:\/\/|www\.)/i;

export function reflowHardWraps(text: string): string {
  const out: string[] = [];
  // Normalise first, so a stray \r neither counts toward the wrap column nor survives
  // into the output. sanitizeDraftBody already does this; the export is callable alone.
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const prev = out[out.length - 1];
    const joinable =
      prev !== undefined &&
      prev.trim() !== "" &&
      line.trim() !== "" &&
      prev.length >= WRAP_COLUMN_MIN &&
      !ENDS_SENTENCE_RE.test(prev.trimEnd()) &&
      CONTINUES_RE.test(line.trimStart()) &&
      !LIST_MARKER_RE.test(prev) &&
      !LIST_MARKER_RE.test(line) &&
      !URL_RE.test(prev.trimEnd()) &&
      !URL_RE.test(line);
    // The joined line stays long, so the rest of the wrapped paragraph keeps folding
    // into it — a 4-line wrapped paragraph collapses to one, blank lines still break.
    if (joinable) out[out.length - 1] = `${prev.trimEnd()} ${line.trim()}`;
    else out.push(line);
  }
  return out.join("\n");
}

/**
 * Clean a raw LLM draft body. Removes subject lines, a leading greeting, a
 * trailing sign-off block, placeholders, markdown emphasis, and any line that
 * leaks internal analysis. Returns a trimmed body with single blank lines
 * between paragraphs.
 */
export function sanitizeDraftBody(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n");

  // Markdown the model shouldn't use in a plain-text email
  text = text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1");

  // Strip placeholders, then collapse the double spaces they leave behind
  text = text.replace(PLACEHOLDER_RE, "").replace(/[ \t]{2,}/g, " ");

  let lines = text.split("\n").map((l) => l.replace(/[ \t]+$/, ""));

  // Drop internal-analysis lines anywhere
  lines = lines.filter((l) => !INTERNAL_LINE_RE.test(l));

  // Drop leading blank/subject lines, then a leading greeting line
  while (lines.length > 0) {
    const head = lines[0].trim();
    if (head === "" || SUBJECT_LINE_RE.test(head)) {
      lines.shift();
      continue;
    }
    if (GREETING_LINE_RE.test(head)) {
      lines.shift();
    } else if (GREETING_PREFIX_RE.test(head)) {
      // Salutation run into the first sentence — strip just the prefix and keep
      // the sentence, re-capitalizing what is now the opening word.
      const rest = head.replace(GREETING_PREFIX_RE, "");
      lines[0] = rest.charAt(0).toUpperCase() + rest.slice(1);
    }
    break;
  }

  // Trailing block: consecutive short lines at the end. If any of them is a
  // sign-off, drop it and everything after it (the name lines under it).
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  let blockStart = end;
  while (
    blockStart > 0 &&
    lines[blockStart - 1].trim() !== "" &&
    lines[blockStart - 1].trim().length <= TRAILING_BLOCK_MAX_LEN
  ) {
    blockStart--;
  }
  for (let i = blockStart; i < end; i++) {
    if (SIGNOFF_LINE_RE.test(lines[i])) {
      lines = lines.slice(0, i);
      break;
    }
  }

  return reflowHardWraps(
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

/** Final email: greeting + body + signature, single blank line between parts. */
export function assembleReplyEmail(opts: {
  greeting: string;
  body: string;
  signature: string;
}): string {
  return [opts.greeting, opts.body.trim(), opts.signature]
    .filter((part) => part.length > 0)
    .join("\n\n");
}
