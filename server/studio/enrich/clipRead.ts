/**
 * studio/enrich/clipRead — ONE clip, read on demand (PR 9.5, F22 B2).
 *
 * Until this, a clip was read only when the batch worker's "next untagged for one athlete" happened
 * to reach it. This is the same read — the same predicate, the same model, the same booking against
 * her day (`metadata.enrich_spend`), the same compare-and-set write — narrowed to the one row she
 * asked for (`VideoEnrichOpts.assetId`, B1), and started by her tap instead of the cron.
 *
 * ─── ASYNC, BY EVIDENCE (R-6, ledger §2) ──────────────────────────────────────────────────────
 *
 * No measured p50 exists for a clip read; the call is bounded at 120 s and the mp4 goes to the model
 * inline. So the read does not sit in the request: the route marks the row `reading`, kicks the read
 * in-process (the edit batch's `kickEditTick` shape) and answers at once; the kick writes its outcome
 * on the row (`metadata.clip_read`, one key, jsonb_set — no table, no migration) and the client polls
 * the GET it already reads. One grace period is waited (`graceMs`) so the cheap refusals — at cap,
 * oversize, absent — come back in the same answer rather than one poll later.
 *
 * ─── ONE CAP GUARD (D2) ───────────────────────────────────────────────────────────────────────
 *
 * This module checks no cap. The chunk does (videoEnrichment.ts, the fenced per-clip check), and its
 * refusal string comes back here as the row's `daily_cap` outcome and is written, verbatim, as the
 * reason. Nothing throws to the client: every path answers a status and, where it refused, a reason.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import { mediaAssets } from "../../../shared/schema";
import { createLogger } from "../../logger";
import {
  canStartRead,
  clipReadStateOf,
  quoteClipReadUsd,
  READ_REASONS,
  readInputOf,
  type ClipReadMark,
  type ClipReadState,
} from "./readState";
import { DAILY_CAP_REFUSAL, type VideoEnrichResult } from "./videoEnrichment";

const logger = createLogger("studio-clip-read");

export type ClipReadAnswer =
  | { status: "not_found" }
  | { status: "not_video"; reason: string }
  | { status: "not_ready"; reason: string; quotedUsd: number }
  | { status: "already_read"; beats: number }
  | { status: "reading"; quotedUsd: number }
  | { status: "done"; beats: number; quotedUsd: number }
  | { status: "at_cap"; reason: string; quotedUsd: number }
  | { status: "failed"; reason: string; quotedUsd: number };

/** The chunk, for one clip — the product wires the serialised door in services/mediaEnrichment.ts. */
export type OneClipEnricher = (opts: {
  athleteId: string;
  assetId: string;
  /** The clock the day is read off — the route's request clock, forwarded. Test seam. */
  now?: () => Date;
}) => Promise<VideoEnrichResult>;

export interface StartClipReadInput {
  athleteId: string;
  assetId: string;
  enrich: OneClipEnricher;
  /** The request's clock. Test seam. */
  now?: () => Date;
  /** How long the answer waits for the kick before saying `reading`. Test seam; the route passes its default. */
  graceMs?: number;
}

/** The default grace: long enough for a refusal that loads no bytes, short enough to never be a read. */
export const CLIP_READ_GRACE_MS = 1_500;

type Row = {
  id: string;
  contentType: string | null;
  thumb: string | null;
  metadata: unknown;
  precise: number | null;
  whole: number | null;
};

async function herRow(athleteId: string, assetId: string): Promise<Row | null> {
  const [row] = await db
    .select({
      id: mediaAssets.id,
      contentType: mediaAssets.content_type,
      thumb: mediaAssets.gcs_thumb_path,
      metadata: mediaAssets.metadata,
      precise: mediaAssets.duration_seconds_precise,
      whole: mediaAssets.duration_seconds,
    })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.id, assetId),
        // ⚠️ MUTATION (clipRead.test): drop this — "another athlete's clip is not found" reds by name.
        eq(mediaAssets.athlete_id, athleteId),
        eq(mediaAssets.status, "stored"),
        isNull(mediaAssets.deleted_at),
        isNull(mediaAssets.parent_media_id),
      ),
    )
    .limit(1);
  return row ?? null;
}

const durationOf = (r: Row): number | null =>
  r.precise ?? (r.whole && r.whole > 0 ? r.whole : null);

/** Write the one key. The row's other keys — vision, embedding, enrichment, enrich_spend — are untouched. */
async function mark(id: string, m: ClipReadMark): Promise<void> {
  await db.execute(sql`
    UPDATE ${mediaAssets}
       SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{clip_read}', ${JSON.stringify(m)}::jsonb)
     WHERE id = ${id}`);
}

/** The state now, off a fresh read of the row. */
export async function readStateFor(
  athleteId: string,
  assetId: string,
  now: Date,
): Promise<ClipReadState | null> {
  const row = await herRow(athleteId, assetId);
  if (!row) return null;
  return clipReadStateOf(readInputOf(row.metadata, durationOf(row)), now);
}

const answerOf = (s: ClipReadState): ClipReadAnswer => {
  switch (s.state) {
    case "done":
      return { status: "done", beats: s.beats, quotedUsd: 0 };
    case "reading":
      return { status: "reading", quotedUsd: s.quotedUsd };
    case "at_cap":
      return { status: "at_cap", reason: s.reason, quotedUsd: s.quotedUsd };
    case "failed":
      return { status: "failed", reason: s.reason, quotedUsd: s.quotedUsd };
    case "unread":
      return {
        status: "failed",
        reason: READ_REASONS.failed,
        quotedUsd: s.quotedUsd,
      };
  }
};

/**
 * Start a read of her clip. Answers as the header says; `done` settles when the kick has written its
 * outcome (the route never awaits it past the grace; a test does).
 */
export async function startClipRead(
  input: StartClipReadInput,
): Promise<{ answer: ClipReadAnswer; done: Promise<void> }> {
  const { athleteId, assetId } = input;
  const now = input.now ?? (() => new Date());
  const settled = { done: Promise.resolve() };
  const row = await herRow(athleteId, assetId);
  if (!row) return { answer: { status: "not_found" }, done: settled.done };
  // ⚠️ MUTATION (clipRead.test): drop this — "image asset gets a read affordance" reds by name (server half).
  if (!(row.contentType ?? "").startsWith("video/"))
    return {
      answer: {
        status: "not_video",
        reason: "only a video can be read into beats",
      },
      done: settled.done,
    };
  const before = clipReadStateOf(
    readInputOf(row.metadata, durationOf(row)),
    now(),
  );
  if (before.state === "done")
    return {
      answer: { status: "already_read", beats: before.beats },
      done: settled.done,
    };
  if (!canStartRead(before))
    return { answer: answerOf(before), done: settled.done };
  // The batch predicate needs the poster (the transcode measured the duration the quote is from).
  const quotedUsd = quoteClipReadUsd(durationOf(row));
  if (!row.thumb)
    return {
      answer: { status: "not_ready", reason: READ_REASONS.notReady, quotedUsd },
      done: settled.done,
    };

  // ⚠️ MUTATION (clipRead.test): skip the quote — "clip read runs unquoted" reds by name.
  const startedAt = now().toISOString();
  await mark(row.id, { state: "reading", startedAt, quotedUsd });
  logger.info({ athleteId, assetId, quotedUsd }, "clip read started");

  const kicked = (async () => {
    let outcome: ClipReadMark;
    try {
      const r = await input.enrich({ athleteId, assetId, now });
      const o = r.outcomes.find((x) => x.id === assetId)?.outcome;
      const at = now().toISOString();
      if (o === "tagged")
        outcome = { state: "done", at, quotedUsd, billedUsd: r.spentUsd };
      else if (o === "daily_cap")
        outcome = { state: "at_cap", at, reason: DAILY_CAP_REFUSAL, quotedUsd };
      else if (o === "oversize_column" || o === "oversize_object")
        outcome = {
          state: "failed",
          at,
          reason: READ_REASONS.oversize,
          quotedUsd,
        };
      else if (o === undefined && r.capped)
        outcome = {
          state: "failed",
          at,
          reason: READ_REASONS.runCap,
          quotedUsd,
        };
      else if (o === undefined) {
        // Not a candidate any more: read by a concurrent pass (beats present now) or set aside.
        const after = await readStateFor(athleteId, assetId, now());
        outcome =
          after?.state === "done"
            ? { state: "done", at, quotedUsd, billedUsd: null }
            : {
                state: "failed",
                at,
                reason:
                  after?.state === "failed"
                    ? after.reason
                    : READ_REASONS.failed,
                quotedUsd,
              };
      } else if (o === "raced")
        outcome = { state: "done", at, quotedUsd, billedUsd: null };
      else
        outcome = {
          state: "failed",
          at,
          reason: READ_REASONS.failed,
          quotedUsd,
        };
      logger.info(
        { athleteId, assetId, outcome: o ?? null, state: outcome.state },
        "clip read finished",
      );
    } catch (err) {
      logger.warn({ err, athleteId, assetId }, "clip read kick failed");
      outcome = {
        state: "failed",
        at: now().toISOString(),
        reason: READ_REASONS.failed,
        quotedUsd,
      };
    }
    // ⚠️ MUTATION (clipRead.test): drop this write — "a dead read stays reading forever" (its second half).
    await mark(row.id, outcome);
  })();
  // Errors are logged above; the route never sees a throw, and a test awaits `done` for the outcome.
  const done = kicked.catch(() => undefined);

  const grace = input.graceMs ?? CLIP_READ_GRACE_MS;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    done,
    new Promise<void>((r) => {
      timer = setTimeout(r, grace);
    }),
  ]);
  clearTimeout(timer); // the kick finished first: nothing keeps the loop alive for the grace
  const after = await readStateFor(athleteId, assetId, now());
  return {
    answer: after
      ? after.state === "done"
        ? { status: "done", beats: after.beats, quotedUsd }
        : answerOf(after)
      : { status: "not_found" },
    done,
  };
}
