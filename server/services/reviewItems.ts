/**
 * reviewItems — the camera-roll intake's record of what each preview was scored as (media_review_items, 0131), behind
 * CAMERA_ROLL_INTAKE. Every function takes the athlete id first and never reaches past it.
 *
 *   recordScored   upsert one row per scored preview (kept, more or dropped — every one counts toward the day's cap)
 *   carryFor       the rows Import may carry over: tags + embedding, not scrubbed, of THIS session, by item id
 *   scrubSession   after Import (or Discard): tags, embedding, likeness and moderation set NULL — nothing about the
 *                  photos she did not pick stays behind; the row itself stays until the purge, so the cap still counts it
 *   countToday     previews scored since 00:00 UTC — the daily cap
 *   purgeOld       delete rows older than N hours (hers on every review call; everyone's from the media-enrich cron)
 *
 * The SERVER's own record is the only source a carry-over reads: nothing the phone sends back at Import is trusted as
 * a tag or a vector.
 */
import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { mediaReviewItems } from "../../shared/schema";
import type { ReviewItemKind } from "../../shared/cameraRollIntake";
import type { AssetTags } from "../lib/visionTag";

export interface ScoredPreview {
  itemId: string;
  kind: ReviewItemKind;
  tags: AssetTags | null;
  embedding: number[] | null;
  likeness: number | null;
  moderation: Record<string, unknown> | null;
  fit: number | null;
}

export async function recordScored(athleteId: string, sessionId: string, items: readonly ScoredPreview[]): Promise<void> {
  if (!items.length) return;
  await db.insert(mediaReviewItems).values(items.map((i) => ({
    athlete_id: athleteId, session_id: sessionId, item_id: i.itemId, kind: i.kind,
    tags: i.tags as never, embedding: i.embedding as never, likeness: i.likeness,
    moderation: i.moderation as never, fit: i.fit,
  }))).onConflictDoUpdate({
    target: [mediaReviewItems.athlete_id, mediaReviewItems.session_id, mediaReviewItems.item_id],
    set: {
      kind: sql`excluded.kind`, tags: sql`excluded.tags`, embedding: sql`excluded.embedding`,
      likeness: sql`excluded.likeness`, moderation: sql`excluded.moderation`, fit: sql`excluded.fit`, scrubbed_at: null,
    },
  });
}

export interface Carry {
  kind: ReviewItemKind;
  vision: Record<string, unknown>;
  embedding: number[];
  moderation: Record<string, unknown> | null;
}

export async function carryFor(athleteId: string, sessionId: string, itemIds: readonly string[]): Promise<Map<string, Carry>> {
  const out = new Map<string, Carry>();
  if (!itemIds.length) return out;
  const rows = await db.select().from(mediaReviewItems).where(and(
    eq(mediaReviewItems.athlete_id, athleteId),
    eq(mediaReviewItems.session_id, sessionId),
    inArray(mediaReviewItems.item_id, [...new Set(itemIds)]),
    isNull(mediaReviewItems.scrubbed_at),
  ));
  for (const r of rows) {
    const vision = r.tags as Record<string, unknown> | null;
    const embedding = r.embedding as unknown;
    if (!vision || typeof vision !== "object" || !Array.isArray(embedding) || !embedding.length) continue;
    out.set(r.item_id, {
      kind: r.kind === "video" ? "video" : "photo",
      vision, embedding: embedding as number[],
      moderation: (r.moderation as Record<string, unknown> | null) ?? null,
    });
  }
  return out;
}

export async function scrubSession(athleteId: string, sessionId: string): Promise<number> {
  const rows = await db.update(mediaReviewItems)
    .set({ tags: null, embedding: null, likeness: null, moderation: null, scrubbed_at: new Date() })
    .where(and(eq(mediaReviewItems.athlete_id, athleteId), eq(mediaReviewItems.session_id, sessionId), isNull(mediaReviewItems.scrubbed_at)))
    .returning({ id: mediaReviewItems.id });
  return rows.length;
}

export async function countToday(athleteId: string, now: Date = new Date()): Promise<number> {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(mediaReviewItems)
    .where(and(eq(mediaReviewItems.athlete_id, athleteId), gte(mediaReviewItems.created_at, midnight)));
  return Number(n);
}

/** Delete rows older than `hours`; one athlete's when given, everyone's otherwise. Returns how many went. */
export async function purgeOld(hours: number, athleteId?: string, now: Date = new Date()): Promise<number> {
  const before = new Date(now.getTime() - hours * 3_600_000);
  const rows = await db.delete(mediaReviewItems)
    .where(and(lt(mediaReviewItems.created_at, before), ...(athleteId ? [eq(mediaReviewItems.athlete_id, athleteId)] : [])))
    .returning({ id: mediaReviewItems.id });
  return rows.length;
}
