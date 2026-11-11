/**
 * agent/citations.ts — inline web citations never reach the athlete's text. After a web search the model tends to
 * append "([site.com](https://…))" to a sentence, even when told not to (live chat eval, 10 Oct 2026). Sources belong on
 * "How I got this" (the run's web sources), so a citing skill's reply is cleaned in code:
 *
 *   "… eligibility. ([site.org](https://site.org/x)) What …"   →  "… eligibility. What …"
 *   "see [the guide](https://x.org/g) first"                   →  "see the guide first"
 *   "(https://x.org/g)" or "(x.org)"-style bare link groups    →  removed
 *
 * createCitationFilter does the same on a STREAM: it holds back text from a "(" or "[" until it can tell whether it is a
 * citation (closed, a newline, or too long to be one), so a citation is never streamed and then taken back.
 */

const LINK = String.raw`\[[^\]\n]{0,200}\]\(\s*https?:\/\/[^)\s]{1,2000}\s*\)`;
/** A parenthesised group made only of markdown links or bare URLs: "([a](u))", "([a](u), [b](v))", "(https://u)". */
const GROUP = new RegExp(String.raw`(?<!\])[ \t]*\(\s*(?:${LINK}|https?:\/\/[^)\s]+)(?:\s*[,;]\s*(?:${LINK}|https?:\/\/[^)\s]+))*\s*\)`, "g");
const BARE_LINK = new RegExp(String.raw`\[([^\]\n]{1,200})\]\(\s*https?:\/\/[^)\s]{1,2000}\s*\)`, "g");

export function stripInlineCitations(text: string): string {
  return text.replace(GROUP, "").replace(BARE_LINK, "$1").replace(/[ \t]+([.,;:!?])/g, "$1");
}

/** The longest stretch held back while deciding; anything longer is not a citation and is let through. */
const MAX_HOLD = 2400;

export interface CitationFilter {
  push(delta: string): void;
  /** Emit whatever is still held (end of a model call). */
  flush(): void;
}

/** Index of the ")" closing the "(" at `open`, or -1 when it has not arrived yet. */
function closeOf(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/**
 * For the bracket at the start of `s`: "wait" (could still become a citation), "plain" (it is not one: let the bracket
 * character through) or the length of the bracketed segment to clean (a link, or a group that closed).
 */
function decide(s: string): "wait" | "plain" | number {
  const tooLong = s.length > MAX_HOLD;
  if (s[0] === "[") {
    const close = s.indexOf("]");
    if (close === -1) return tooLong || s.includes("\n") ? "plain" : "wait";
    if (close + 1 >= s.length) return "wait";
    if (s[close + 1] !== "(") return "plain";
    const end = closeOf(s, close + 1);
    if (end === -1) return tooLong || s.slice(close).includes("\n") ? "plain" : "wait";
    return end + 1;
  }
  // "(": only a group that opens like a link or a URL can be a citation.
  const head = s.slice(1).trimStart();
  if (!head) return "wait";
  if (!/^(\[|https?:\/\/)/i.test(head)) return /^(h|ht|htt|http|https?:?\/?)$/i.test(head) ? "wait" : "plain";
  const end = closeOf(s, 0);
  if (end === -1) return tooLong || s.includes("\n") ? "plain" : "wait";
  return end + 1;
}

export function createCitationFilter(emit: (clean: string) => void): CitationFilter {
  let held = "";
  const out = (s: string) => { if (s) emit(s); };
  const drain = () => {
    while (held) {
      const at = held.search(/[([]/);
      if (at === -1) {
        // Trailing spaces wait: a "(" may follow, and a removed citation takes its space with it.
        const keep = held.replace(/[ \t]+$/, "");
        out(keep);
        held = held.slice(keep.length);
        return;
      }
      // Spaces right before a "(" wait with it, so a removed citation takes its space along.
      const lead = held.slice(0, at);
      const keep = held[at] === "(" ? lead.replace(/[ \t]+$/, "") : lead;
      out(keep);
      const spaces = lead.slice(keep.length);
      const rest = held.slice(at);
      const d = decide(rest);
      if (d === "wait") { held = spaces + rest; return; }
      if (d === "plain") { out(spaces + rest[0]); held = rest.slice(1); continue; }
      out(stripInlineCitations(spaces + rest.slice(0, d)));
      held = rest.slice(d);
    }
  };
  return {
    push(delta) { held += delta; drain(); },
    flush() { if (held) { out(stripInlineCitations(held)); held = ""; } },
  };
}
