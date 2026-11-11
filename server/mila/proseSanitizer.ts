/**
 * proseSanitizer.ts — deterministic backstop that strips the grounding-citation
 * leak patterns out of Mila's PROSE. Prompt guidance alone failed live.
 *
 * Two tiers:
 *   - Bracketed UUIDs and bracketed tool names are stripped inline as they close.
 *   - Numbered footnotes ("[4]") are held and stripped at finalize(). The old loop has
 *     no web grounding (the MILA_WEB_SEARCH spike was deleted 2 Nov 2026), so an [n]
 *     is never a real citation.
 */

// ── Global patterns (for whole-string replace) ──────────────────────────────
const BRACKETED_UUID =
  /\[[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\]/gi;
const BRACKETED_TOOL =
  /\[(get_score|get_deal|list_deals|get_brand|get_brand_fit|list_tasks_threads)[^\]]*\]/g;
const NUMBERED_FOOTNOTE = /\s?\[\d{1,2}\]/g;

// ── Anchored patterns (to classify one "[...]" token) ───────────────────────
const IS_UUID =
  /^\[[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\]$/i;
const IS_TOOL =
  /^\[(get_score|get_deal|list_deals|get_brand|get_brand_fit|list_tasks_threads)[^\]]*\]$/;
const IS_FOOTNOTE = /^\[\d{1,2}\]$/;

// ── Widget directive ────────────────────────────────────────────────────────
// The model declares the card to render at the very end of its answer, e.g.
// "<<widget:deal_list:id1,id2>>" / "<<widget:deal_card:id>>" / "<<widget:score>>".
// It is captured here and STRIPPED from the visible prose (machine-only). The loop
// validates the declared ids against the turn's deal pool before rendering.
const DIRECTIVE_RE =
  /<<\s*widget\s*:\s*(deal_list|deal_card|score)(?:\s*:\s*([^>]*))?\s*>>/gi;

export interface WidgetDirective {
  widget: "deal_list" | "deal_card" | "score";
  ids: string[]; // empty for score
}

/** Collapse doubled spaces and a space left before punctuation after a removal. */
const tidy = (s: string): string =>
  s.replace(/ {2,}/g, " ").replace(/ +([.,;:!?])/g, "$1");

/** Strip all three leak shapes (id/tool + numbered footnotes) and tidy. */
export function stripLeakBrackets(text: string): string {
  return tidy(
    text
      .replace(BRACKETED_UUID, "")
      .replace(BRACKETED_TOOL, "")
      .replace(NUMBERED_FOOTNOTE, ""),
  );
}

/**
 * Streaming stripper for one turn. `push` emits the text that's safe now — id/tool
 * brackets already stripped, footnotes + unclosed brackets held back. `finalize`
 * is called once the stream ends and flushes the held tail with every leak shape
 * stripped.
 */
export class StreamingLeakStripper {
  private buf = "";
  /** The widget the model declared this turn, captured at finalize(). null if none
   *  (or malformed) — the loop then falls back to the prose/question heuristic. */
  directive: WidgetDirective | null = null;

  /** Feed model text; return the portion safe to emit now. */
  push(text: string): string {
    this.buf += text;
    let out = "";
    let i = 0;
    while (i < this.buf.length) {
      const bracket = this.buf.indexOf("[", i);
      const angle = this.buf.indexOf("<<", i);

      // A "<<" widget directive: hold from it to the end (parsed at finalize),
      // trimming trailing whitespace before it so the answer doesn't end on a
      // stray space/newline once the directive is stripped.
      if (angle !== -1 && (bracket === -1 || angle < bracket)) {
        out += this.buf.slice(i, angle).replace(/\s+$/, "");
        i = angle;
        break;
      }

      if (bracket === -1) {
        // No opener ahead — emit the rest, but hold a trailing lone "<" (it could
        // start a "<<" directive next chunk), plus the whitespace right before it
        // so a space ahead of a split directive doesn't leak.
        let end = this.buf.length;
        if (this.buf[end - 1] === "<") {
          end -= 1;
          while (end > i && /\s/.test(this.buf[end - 1])) end -= 1;
        }
        out += this.buf.slice(i, end);
        i = end;
        break;
      }

      const open = bracket;
      const close = this.buf.indexOf("]", open);
      if (close === -1) {
        out += this.buf.slice(i, open); // hold from the unclosed "["
        i = open;
        break;
      }
      const token = this.buf.slice(open, close + 1);
      if (IS_UUID.test(token) || IS_TOOL.test(token)) {
        out += this.buf.slice(i, open); // never legit → drop the token
        i = close + 1;
        if (this.buf[i] === " ") i += 1; // eat one trailing space it left behind
      } else if (IS_FOOTNOTE.test(token)) {
        // Held until finalize. Hold from any whitespace before it, so the
        // footnote strip's \s? can take it too.
        let hold = open;
        while (hold > i && this.buf[hold - 1] === " ") hold -= 1;
        out += this.buf.slice(i, hold);
        i = hold;
        break;
      } else {
        out += this.buf.slice(i, close + 1); // some other bracket → keep it
        i = close + 1;
      }
    }
    this.buf = this.buf.slice(i);
    return out;
  }

  /** Stream ended. Capture + strip the widget directive from the held tail, then
   *  flush it with every leak shape (id/tool and footnotes) stripped. */
  finalize(): string {
    const rest = this.buf;
    this.buf = "";
    if (!rest) return "";
    const cleaned = stripLeakBrackets(this.captureDirective(rest));
    return cleaned.replace(/\s+$/, ""); // trim any whitespace the directive left
  }

  /** Capture the LAST valid directive into `this.directive` and strip every
   *  directive (plus any truncated trailing "<<…") out of the text. */
  private captureDirective(text: string): string {
    const matches = [...text.matchAll(DIRECTIVE_RE)];
    if (matches.length) {
      const m = matches[matches.length - 1];
      this.directive = {
        widget: m[1].toLowerCase() as WidgetDirective["widget"],
        ids: (m[2] ?? "")
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      };
    }
    return text.replace(DIRECTIVE_RE, "").replace(/<<[\s\S]*$/, "");
  }
}
