/**
 * chatMinimal.ts — what Mila's chat history is allowed to keep (decision 9 of the
 * approved email-storage design, 7 Oct 2026).
 *
 * Chat history must not become a back door for storing email. Two rules, both
 * applied at the moment a row is written to chat_messages:
 *
 *  1. Tool results are kept as REFERENCES only. A tool row stores the tool name,
 *     the ids it touched (deal / thread / provider ids) and a short whitelist of
 *     derived scalars (status, stage, amount…). Never a subject, a summary, a body
 *     or a draft. Tool rows are never replayed to the model (loadHistory) or shown
 *     to the athlete (getConversationMessages), so nothing downstream needs more.
 *     ALL tools are stubbed, not only the mail ones: a per-tool allow-list would
 *     silently start storing email the day a new tool returns some, and nothing
 *     reads tool rows anyway.
 *
 *  2. Long quotes in Mila's own reply are trimmed to a short excerpt before the
 *     reply is stored (see QUOTE_EXCERPT_CHARS for the cap and why).
 *
 * A draft_reply card persisted on the assistant row keeps everything except the
 * draft body: it is stored as `needsDraft`, the same shape the voice flow already
 * uses, so a reopened chat shows "Write draft" and regenerates on a tap instead of
 * replaying stored copy.
 *
 * Behind a flag (default off). The approved switch is MAILBOX_ZERO_RETENTION, which
 * lands with #798 and is not on main yet, so this reads its own MILA_CHAT_MINIMAL
 * as well: either one set to "true" turns it on. Pure functions; no DB.
 */

import type { MilaWidget } from "./types";

/** On when MILA_CHAT_MINIMAL or MAILBOX_ZERO_RETENTION is "true". Read at call time. */
export function chatMinimalEnabled(): boolean {
  const on = (v: string | undefined) => v?.trim().toLowerCase() === "true";
  return on(process.env.MILA_CHAT_MINIMAL) || on(process.env.MAILBOX_ZERO_RETENTION);
}

// ─── 1. Tool rows → references ──────────────────────────────────────────────

/** Keys whose values are identifiers: `id`, `deal_id`, `threadId`, `message_ids`… */
const ID_KEY = /^(id|ids|.*_id|.*_ids|.*Id|.*Ids)$/;
/** An identifier looks like one: no spaces, bounded. A name or sentence never passes. */
const ID_VALUE = /^[A-Za-z0-9._:@<>+=\/-]{1,128}$/;
/** Derived, non-prose fields worth keeping beside the ids. Enums, money, counts. */
const DERIVED_KEYS = new Set([
  "status",
  "stage",
  "deal_stage",
  "deal_type",
  "negotiation_state",
  "platform",
  "amount",
  "count",
  "total",
  "reply_intent",
  "sendable",
  "has_inbound",
]);
const DERIVED_STRING_MAX = 40;
const MAX_IDS = 50;

export interface ToolRowStub {
  tool: string;
  /** Marks the row as a reference, so a reader never mistakes it for the payload. */
  stubbed: true;
  ids: string[];
  fields: Record<string, string | number | boolean | null>;
  error?: true;
}

function collectIds(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 6 || out.size >= MAX_IDS || value == null) return;
  if (Array.isArray(value)) {
    for (const v of value) collectIds(v, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (ID_KEY.test(k)) {
      const vals = Array.isArray(v) ? v : [v];
      for (const x of vals) {
        if (out.size >= MAX_IDS) return;
        if (typeof x === "string" && ID_VALUE.test(x)) out.add(x);
        else if (typeof x === "number" && Number.isFinite(x)) out.add(String(x));
      }
    } else if (typeof v === "object") {
      collectIds(v, out, depth + 1);
    }
  }
}

/** Reduce one tool result to ids + derived scalars. Never throws. */
export function stubToolResult(tool: string, result: unknown): ToolRowStub {
  const ids = new Set<string>();
  collectIds(result, ids);
  const fields: ToolRowStub["fields"] = {};
  if (result && typeof result === "object" && !Array.isArray(result)) {
    for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
      if (!DERIVED_KEYS.has(k)) continue;
      if (typeof v === "number" || typeof v === "boolean" || v === null) fields[k] = v;
      else if (typeof v === "string" && v.length <= DERIVED_STRING_MAX && !/\n/.test(v)) fields[k] = v;
    }
  }
  const stub: ToolRowStub = { tool, stubbed: true, ids: [...ids], fields };
  if (result && typeof result === "object" && "error" in (result as object)) stub.error = true;
  return stub;
}

// ─── 2. Quotes in Mila's reply → short excerpts ─────────────────────────────

/**
 * 200 characters, roughly 30 English words: one or two sentences. Enough to keep
 * the point of what was quoted ("usage rights for 12 months, paid in two
 * installments"), never enough to rebuild an email. It is the size of the snippet
 * Gmail itself shows in a list view, and in line with the design's "about 25
 * words". Applied per quote, so a reply that quotes three short lines keeps them.
 */
export const QUOTE_EXCERPT_CHARS = 200;

function excerpt(s: string, cap: number): string {
  const flat = s.trim();
  if (flat.length <= cap) return flat;
  let cut = flat.slice(0, cap);
  const sp = cut.lastIndexOf(" ");
  if (sp > cap - 40) cut = cut.slice(0, sp);
  return cut.replace(/[\s,;:.-]+$/, "") + "…";
}

/**
 * Trim every long quote in an assistant reply: fenced blocks, markdown blockquote
 * runs, and "straight" or “curly” quoted spans. Mila's own sentences are untouched.
 */
export function trimQuotes(text: string, cap = QUOTE_EXCERPT_CHARS): string {
  if (!text) return text;
  let out = text;

  // Fenced blocks: ```lang\n…\n```
  out = out.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (m, lang: string, body: string) =>
    body.trim().length > cap ? "```" + lang + "\n" + excerpt(body, cap) + "\n```" : m,
  );

  // Blockquote runs: consecutive lines starting with ">".
  out = out.replace(/(^[ \t]*>.*(?:\r?\n[ \t]*>.*)*)/gm, (run: string) => {
    const body = run
      .split(/\r?\n/)
      .map((l) => l.replace(/^[ \t]*>[ \t]?/, ""))
      .join(" ")
      .replace(/\s+/g, " ");
    return body.trim().length > cap ? "> " + excerpt(body, cap) : run;
  });

  // Quoted spans. Curly quotes may span lines; straight quotes may too, but only
  // a span longer than the cap is touched, so a stray quote mark can't eat a reply.
  out = out.replace(/“([^”]+)”/g, (m, body: string) =>
    body.length > cap ? "“" + excerpt(body, cap) + "”" : m,
  );
  out = out.replace(/"([^"]+)"/g, (m, body: string) =>
    body.length > cap ? '"' + excerpt(body, cap) + '"' : m,
  );
  return out;
}

// ─── draft cards on the assistant row ───────────────────────────────────────

/**
 * The persisted copy of a turn's widget. A reply_action keeps its ids, gates and
 * params but drops the draft body: it is stored as `needsDraft` so a reopened chat
 * regenerates the draft on a tap (MilaReplyWidget's rehydrated path). A refusal is
 * a fixed app string and is kept. Every other widget is already scalar-only.
 */
export function widgetForStorage(widget: MilaWidget | null | undefined): MilaWidget | null {
  if (!widget) return null;
  if (widget.type !== "reply_action") return widget;
  const d = widget.data;
  if (d.draft === null) return widget;
  return {
    type: "reply_action",
    // sendable was true only if the structural gate held AND a draft existed; with
    // the body gone the structural half is what remains, and the client re-checks
    // the draft half once it has generated one.
    data: { ...d, draft: null, needsDraft: true },
  };
}
