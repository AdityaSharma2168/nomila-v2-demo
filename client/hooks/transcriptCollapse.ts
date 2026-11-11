/**
 * transcriptCollapse.ts — what ONE live transcript update does to the message
 * list, as a pure decision.
 *
 * Extracted from use-mila-chat's `appendTranscript` so the rule can be tested
 * without React, RN or a room (repo convention: a `*Logic.ts` module beside its
 * test — see client/components/deals/week/weekLogic.ts). The hook keeps only the
 * `setMessages` application; every judgment about WHICH line an update belongs to
 * lives here.
 *
 * ── The problem this exists to solve ─────────────────────────────────────────
 * One spoken utterance does not arrive as one stream. It arrives as several, and
 * what they carry has changed under us twice:
 *   - Gemini opened three streams carrying IDENTICAL text (re-transcriptions of
 *     the same speech). Collapsing those needed an exact-match rule.
 *   - Grok opens a stream per PARTIAL, each carrying a longer prefix of the same
 *     sentence — "draft", "draft a", "draft a reply". Exact-match does not see
 *     those as related, so each one appended its own line and the athlete watched
 *     their sentence stack into a pyramid.
 * Both are the same event — the athlete said one thing — and both must render as
 * one line that updates in place and settles on the final transcript.
 *
 * ── Why prefixes are matched, when they deliberately were not ────────────────
 * The old rule was identical-text-only, because matching prefixes collapses "yes"
 * into "yes please" said quickly. That trade was made when repeats were the only
 * observed quirk. Growing partials make the other side of it far more expensive —
 * every utterance pyramids, rather than a rare double line — so prefixes match
 * now, and the WINDOW is what keeps the old worry small: a partial lands within
 * PARTIAL_MS of the one before it, and a genuine second utterance cannot.
 */

/** Structurally the same union as voiceSession's `TranscriptRole`, redeclared so
 *  this module pulls in nothing (the test runs under plain ts-jest/node). */
export type TranscriptRole = "user" | "assistant";

/** The fields of a transcript update this decision actually reads. */
export interface TranscriptInput {
  streamId: string;
  role: TranscriptRole;
  /** Already trimmed by the caller. */
  text: string;
  done: boolean;
}

/**
 * Live-transcript bookkeeping, carried between updates.
 *
 * `streamToId` maps a transcription stream to the message it is filling, so a
 * turn updates in place instead of appending a line per delta. `lastUser` is the
 * newest user line and the text it is currently showing — the anchor every
 * continuation is measured against.
 */
export interface TranscriptTracker {
  streamToId: Map<string, string>;
  lastUser: { id: string; text: string; at: number } | null;
}

export function createTranscriptTracker(): TranscriptTracker {
  return { streamToId: new Map(), lastUser: null };
}

/**
 * How long an identical user utterance is treated as a repeat of the one on
 * screen rather than a new turn. The re-transcription burst arrives together, so
 * this only has to be wide enough to cover it — not wide enough to swallow a real
 * repetition.
 */
export const USER_TRANSCRIPT_DEDUP_MS = 5_000;

/**
 * The same idea for a GROWING partial, on a much tighter window.
 *
 * Partials arrive back to back while the athlete is still talking, so this only
 * has to span the gap between two of them. It is kept well under the dedup window
 * because the prefix rule is the looser of the two: "yes" followed by "yes please"
 * a beat later really would collapse into one line, and the only thing keeping a
 * genuine second utterance safe is that it cannot land this fast.
 */
export const USER_TRANSCRIPT_PARTIAL_MS = 1_500;

/**
 * Words only, lowercased. Re-transcription re-cases and re-punctuates as it
 * revises — "draft a" becomes "Draft a reply." — so a raw string compare would
 * miss the continuation and open a new line, which is the bug itself.
 */
export const normalizeUtterance = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Is `shorter` a strict prefix of `longer`, counted in whole words?
 *
 * Word-boundary rather than raw `startsWith` so "draft" does not read as a prefix
 * of "drafting" — a different word is a different utterance.
 */
export function isStrictWordPrefix(shorter: string, longer: string) {
  const a = normalizeUtterance(shorter);
  const b = normalizeUtterance(longer);
  return a !== "" && a !== b && b.startsWith(`${a} `);
}

/**
 * Is `next` the same utterance as `prev`, still being transcribed?
 *
 * Identical text is the re-transcription burst; a word-boundary prefix in either
 * direction is a partial growing (or an out-of-order one arriving late).
 */
export function continuesUtterance(
  prev: string,
  next: string,
  elapsedMs: number,
) {
  const a = normalizeUtterance(prev);
  const b = normalizeUtterance(next);
  if (!a || !b) return false;
  if (a === b) return elapsedMs < USER_TRANSCRIPT_DEDUP_MS;
  if (isStrictWordPrefix(a, b) || isStrictWordPrefix(b, a)) {
    return elapsedMs < USER_TRANSCRIPT_PARTIAL_MS;
  }
  return false;
}

export type TranscriptPlan =
  /** Nothing to show — an empty stream. */
  | { kind: "ignore" }
  /**
   * Rewrite a line already on screen. `content: null` means LEAVE the text as it
   * is and only settle `streaming` — the late-close case below.
   */
  | { kind: "update"; id: string; content: string | null; streaming: boolean }
  /** A genuinely new turn. */
  | {
      kind: "append";
      id: string;
      role: TranscriptRole;
      content: string;
      streaming: boolean;
    };

/**
 * Decide what this update does, and advance `tx` to match.
 *
 * Mutates `tx` (it is a ref in the hook, and the decision and the bookkeeping
 * have to stay in step). `mintId` supplies the caller's monotonic id so a spoken
 * turn and a typed one can never collide on a list key.
 *
 * Three cases, in order:
 *  1. A stream we already know → update its message in place. This is the
 *     delta path: Mila's turn arrives as ~46 deltas over ~13s and the same
 *     message grows, rather than 46 messages appearing.
 *  2. A NEW user stream continuing the utterance already on screen → adopt that
 *     message, then fall into 1 so the adopted line is REWRITTEN with this text.
 *     Returning here instead — which is what the identical-text-only rule did —
 *     would pin the line to whatever the first partial said, and the athlete
 *     would watch "draft" sit there while they finished the sentence.
 *  3. Anything else → a new turn.
 */
export function planTranscriptUpdate(
  tx: TranscriptTracker,
  update: TranscriptInput,
  now: number,
  mintId: (role: TranscriptRole) => string,
): TranscriptPlan {
  const text = update.text.trim();
  // A stream that carried nothing has no turn to show. The server applies the
  // same rule before it writes, so this cannot diverge from what persists.
  if (!text) return { kind: "ignore" };

  let known = tx.streamToId.get(update.streamId);

  // 2 — a new stream continuing the utterance already on screen.
  if (
    !known &&
    update.role === "user" &&
    tx.lastUser &&
    continuesUtterance(tx.lastUser.text, text, now - tx.lastUser.at)
  ) {
    known = tx.lastUser.id;
    tx.streamToId.set(update.streamId, known);
  }

  // 1 — known stream: grow the message that is already on screen.
  if (known) {
    // Partial streams overlap, so an EARLIER one can close after a later one has
    // already grown the line — its terminal emit still carries the short text.
    // Taking it would rewind "draft a reply" to "draft" at the moment the athlete
    // stopped talking. It still gets to settle `streaming`; it just does not get
    // to shorten what is on screen.
    const stale =
      update.role === "user" &&
      tx.lastUser?.id === known &&
      isStrictWordPrefix(text, tx.lastUser.text);

    if (update.role === "user" && !stale) {
      tx.lastUser = { id: known, text, at: now };
    }
    return {
      kind: "update",
      id: known,
      content: stale ? null : text,
      streaming: !update.done,
    };
  }

  // 3 — a new turn.
  const id = mintId(update.role);
  tx.streamToId.set(update.streamId, id);
  if (update.role === "user") {
    tx.lastUser = { id, text, at: now };
  }
  return {
    kind: "append",
    id,
    role: update.role,
    content: text,
    streaming: !update.done,
  };
}
