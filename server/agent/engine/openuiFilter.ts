/**
 * agent/engine/openuiFilter.ts (moved from agent/tf/, 5 Nov 2026; the Mastra turn uses it) — the app never receives generative-UI markup (design §6), first written for TrueForge's (gone, Mastra-only PR 3).
 *
 * With generative UI on, TrueForge told the model to fence OpenUI code in a ```openui block (trueforge-core
 * capabilities/builtins/OpenUI.ts @0.180.0, section "openui-markdown-fencing"). Only TrueForge's React UI rendered it;
 * our React Native app would show the code as text, and the Mastra turn keeps the filter in case a model still writes one. Whether the agent keeps generative UI is the owner's call, so the
 * chat endpoint is safe either way: every ```openui … ``` block is removed from the text, while it streams, and nothing
 * stands in for it (the newline that ends a block goes with it). An unclosed block is dropped to the end. Any other
 * text, other code fences included, passes through unchanged.
 *
 * Streaming: a chunk can end in the middle of "```openui". Text that could still be the start of a fence is held back
 * until the next chunk decides it (at most a few characters), so nothing of a fence ever reaches the app.
 */

const OPEN = "```openui";
const CLOSE = "```";

export interface OpenUiFilter {
  /** Text that is safe to show now. */
  push(chunk: string): string;
  /** The end of the message: whatever was held back and is not a fence. */
  flush(): string;
  /** How many openui blocks were removed so far. */
  readonly removed: number;
}

/** The longest suffix of `s` that is a proper prefix of `token` (a fence that may continue in the next chunk). */
function heldSuffix(s: string, token: string): number {
  for (let n = Math.min(token.length - 1, s.length); n > 0; n--) if (token.startsWith(s.slice(-n))) return n;
  return 0;
}

export function createOpenUiFilter(): OpenUiFilter {
  let buf = "";
  let inside = false;
  let removed = 0;
  /** The newline that ends a closing fence goes with the block, however the chunks fall. */
  let eatNewline = false;

  function drain(final: boolean): string {
    let out = "";
    for (;;) {
      if (!inside) {
        if (eatNewline && buf.length) { if (buf.startsWith("\n")) buf = buf.slice(1); eatNewline = false; }
        const at = buf.indexOf(OPEN);
        if (at >= 0) {
          out += buf.slice(0, at);
          buf = buf.slice(at + OPEN.length);
          inside = true;
          removed++;
          continue;
        }
        const keep = final ? 0 : heldSuffix(buf, OPEN);
        out += buf.slice(0, buf.length - keep);
        buf = buf.slice(buf.length - keep);
        return out;
      }
      const end = buf.indexOf(CLOSE);
      if (end >= 0) {
        buf = buf.slice(end + CLOSE.length);
        inside = false;
        eatNewline = true;
        continue;
      }
      // Inside a block: drop what we have, but keep a partial closing fence for the next chunk.
      const keep = final ? 0 : heldSuffix(buf, CLOSE);
      buf = buf.slice(buf.length - keep);
      if (final) inside = false;
      return out;
    }
  }

  return {
    push(chunk) { buf += chunk; return drain(false); },
    flush() { const out = drain(true); buf = ""; return out; },
    get removed() { return removed; },
  };
}

/** The whole text at once (a stored or final message). */
export function stripOpenUi(text: string): string {
  const f = createOpenUiFilter();
  return f.push(text) + f.flush();
}
