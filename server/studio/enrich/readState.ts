/**
 * studio/enrich/readState — what one clip's read looks like from the outside, and what it would cost.
 *
 * Pure: no db, no model, no clock of its own. Two callers share it so they can never disagree — the
 * Studio picker's list (studio/mediaList.ts, the Agent tray) and the shared media detail route
 * (routes/media.ts, MediaDetail) — and the read route (clipRead.ts) writes the state it reads.
 *
 * ─── THE STATE, exactly (PR 9.5, F22 B2/B4) ───────────────────────────────────────────────────
 *
 *   done      metadata.vision.beats is an ARRAY — the clip has been read as a clip. `beats` is its
 *             length (0 is a read that found no beats: still done, still not "unread").
 *   reading   metadata.clip_read.state = "reading" and its startedAt is younger than the stale bound.
 *   failed    metadata.clip_read.state = "failed" (the kick's outcome), OR a `reading` mark older than
 *             the stale bound (R-7: "read didn't finish" — a dead read never blocks the next), OR the
 *             shared brake `metadata.enrichment.abandoned_at` (oversize / attempts), which the batch
 *             would never retry either.
 *   at_cap    metadata.clip_read.state = "at_cap" — her day's reading budget refused it; the reason is
 *             the chunk's own refusal string, verbatim (D2).
 *   unread    none of the above: a video with poster tags (or none) and no clip read yet.
 *
 * A read is allowed from unread, failed and at_cap; refused from reading (one in flight) and done.
 */
import { clipReadStaleMs } from "./config";
import { estimateVideoTokens, usdOf } from "./videoCost";

export type ClipReadState =
  | { state: "unread"; quotedUsd: number }
  | { state: "reading"; quotedUsd: number; startedAt: string }
  | { state: "done"; beats: number }
  | { state: "failed"; quotedUsd: number; reason: string }
  | { state: "at_cap"; quotedUsd: number; reason: string };

/** What `metadata.clip_read` holds — written by clipRead.ts only, one key, via jsonb_set. */
export type ClipReadMark =
  | { state: "reading"; startedAt: string; quotedUsd: number }
  | { state: "failed"; at: string; reason: string; quotedUsd: number }
  | { state: "at_cap"; at: string; reason: string; quotedUsd: number }
  | { state: "done"; at: string; quotedUsd: number; billedUsd: number | null };

/** The reasons this module words itself. The at-cap reason is never one of these: it is the chunk's. */
export const READ_REASONS = {
  dead: "read didn't finish",
  oversize: "too big to read",
  attempts: "set aside after repeated failures",
  failed: "couldn't read this clip",
  notReady: "still processing — try again in a minute",
  runCap: "this run's reading budget is spent — try again in a minute",
} as const;

/**
 * The quote on the button (R-3): the same estimate the batch banks before a call, in dollars, rounded
 * to a tenth of a cent. A ceiling — the row books what Vertex reports.
 */
export function quoteClipReadUsd(durationSeconds: number | null): number {
  return Number(usdOf(estimateVideoTokens(durationSeconds)).toFixed(4));
}

/** The pieces of a row's metadata the state reads — so a list can select just these, not the embedding. */
export interface ReadInput {
  /** Beat count when `vision.beats` is an array, else null. */
  beats: number | null;
  clipRead: unknown;
  /** `metadata.enrichment.abandoned_reason`, or null. */
  abandonedReason: string | null;
  durationSeconds: number | null;
}

/** `ReadInput` off a whole metadata object (the detail route has the row). */
export function readInputOf(
  metadata: unknown,
  durationSeconds: number | null,
): ReadInput {
  const m = (metadata ?? {}) as Record<string, unknown>;
  const vision = m.vision as { beats?: unknown } | null | undefined;
  const beats = Array.isArray(vision?.beats) ? vision!.beats!.length : null;
  const enrichment = m.enrichment as
    | { abandoned_reason?: unknown }
    | null
    | undefined;
  return {
    beats,
    clipRead: m.clip_read ?? null,
    abandonedReason:
      typeof enrichment?.abandoned_reason === "string"
        ? enrichment.abandoned_reason
        : null,
    durationSeconds,
  };
}

const markOf = (raw: unknown): Partial<ClipReadMark> | null =>
  raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Partial<ClipReadMark>)
    : null;

/** The state, as the header defines it. `now` is the caller's clock (the route passes the request's). */
export function clipReadStateOf(input: ReadInput, now: Date): ClipReadState {
  if (input.beats !== null) return { state: "done", beats: input.beats };
  const quotedUsd = quoteClipReadUsd(input.durationSeconds);
  const mark = markOf(input.clipRead);
  if (mark?.state === "reading" && typeof mark.startedAt === "string") {
    const started = Date.parse(mark.startedAt);
    // ⚠️ MUTATION (clipRead.test): drop the age check — "a dead read stays reading forever" reds by name.
    if (
      Number.isFinite(started) &&
      now.getTime() - started <= clipReadStaleMs()
    )
      return { state: "reading", quotedUsd, startedAt: mark.startedAt };
    return { state: "failed", quotedUsd, reason: READ_REASONS.dead };
  }
  if (mark?.state === "at_cap" && typeof mark.reason === "string")
    return { state: "at_cap", quotedUsd, reason: mark.reason };
  if (mark?.state === "failed" && typeof mark.reason === "string")
    return { state: "failed", quotedUsd, reason: mark.reason };
  if (input.abandonedReason === "oversize")
    return { state: "failed", quotedUsd, reason: READ_REASONS.oversize };
  if (input.abandonedReason)
    return { state: "failed", quotedUsd, reason: READ_REASONS.attempts };
  return { state: "unread", quotedUsd };
}

/** Whether a new read may start from this state (the header's last line). */
export const canStartRead = (s: ClipReadState): boolean =>
  s.state === "unread" || s.state === "failed" || s.state === "at_cap";
