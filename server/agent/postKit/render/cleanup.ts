/**
 * agent/postKit/render/cleanup.ts — superseded preview renders are cleaned up (POST /api/internal/post-kit-preview-cleanup-cron,
 * daily, behind AGENT_POST_KIT_PREVIEW_CLEANUP).
 *
 * A swap, a re-caption or a rebuild gives a kit a new render key, and publish.ts writes the new key's files under
 * athletes/<athlete>/studio/post-kit/<decision>/<key>/ as media_assets rows marked content_format "post_kit_preview". The
 * old key's rows and files stayed forever. Two phases, each scoped to one athlete at a time:
 *
 *   1. soft-delete   a preview row older than 24 h (created_at) whose key is not its kit's current preview key — the kit
 *                    gone, the decision gone, or the key swapped — gets deleted_at. A row the kit's current preview
 *                    names (an output or the cover) is never touched, whatever its path says. After the UPDATE the kits
 *                    are read AGAIN and any row a kit now names (or whose key became current in between) is restored.
 *   2. purge         a preview row soft-deleted more than 7 days ago has its files (gcs_path and its cover,
 *                    gcs_thumb_path) deleted from storage, and each path whose file is really gone is set to NULL ("no
 *                    pixels"; the row stays, as history). Kept, path and all, for a later pass:
 *                      - a file whose key is its kit's CURRENT preview key: request.ts writes the key before the render
 *                        job runs, and a re-render of that key writes to the very same path;
 *                      - a file a live row of hers still points at (a key re-published to the same path);
 *                      - a file whose delete failed.
 *
 * Fairness and bounds: the SQL that picks work already leaves out every row whose key is its kit's current key, so those
 * rows never fill a window; athletes are taken oldest stale row first (a processed athlete's rows leave the candidate set,
 * so nobody waits forever); at most MAX_ATHLETES athletes and MAX_ROWS_PER_ATHLETE rows per phase per pass, and a
 * wall-clock budget (default 240 s, inside the scheduler's 300 s deadline) after which the pass stops cleanly.
 *
 * Never touched: any row without the preview mark, any row whose path is not under its OWN athlete's post-kit space,
 * any path outside that space. Every read and write carries the athlete id. Nothing here calls a model. No migration and
 * no new index: the per-athlete reads use media_assets' existing athlete index.
 */
import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../../db";
import { mediaAssets, memoryDecisions } from "../../../../shared/schema";
import { removeObject } from "../../../lib/mediaStore";
import { POST_KIT_PREVIEW_FORMAT } from "../../../lib/previewAsset";
import { createLogger } from "../../../logger";
import { dbStore } from "../../research/dbStore";
import type { AgentStore } from "../../research/store";
import type { PostKitPreview } from "../../../../shared/postKit";
import { POST_KIT_PREVIEW_CLEANUP } from "../config";
import { currentPreview } from "./preview";

const logger = createLogger("agent/postKit/render/cleanup");

export interface PreviewCleanupDeps {
  now?: Date;
  store?: Pick<AgentStore, "getDecision">;
  /** True when the object is gone (deleted or already missing), false when the delete failed. */
  removeObject?: (gcsPath: string) => Promise<boolean>;
  /** Wall-clock budget for one pass (default POST_KIT_PREVIEW_CLEANUP.BUDGET_MS). */
  budgetMs?: number;
  /** The clock the budget is measured on (tests). */
  clock?: () => number;
  /** Overrides of MAX_ATHLETES / MAX_ROWS_PER_ATHLETE (tests). */
  maxAthletes?: number;
  maxRowsPerAthlete?: number;
}

export interface PreviewCleanupResult {
  athletes: number;
  softDeleted: number;
  /** Rows soft-deleted this pass and restored at once because their kit named them on the re-read. */
  restored: number;
  /** Rows whose every path is now NULL. */
  purged: number;
  filesDeleted: number;
  /** Files kept because their key is the kit's current preview key. */
  currentKept: number;
  /** Files kept because a live row of hers still points at them. */
  sharedKept: number;
  /** Files whose delete failed: kept for the next pass. */
  purgeFailed: number;
  /** Athletes whose pass threw: the rest went on. */
  failedAthletes: number;
  /** True when the wall-clock budget ran out before the work did. */
  stoppedEarly: boolean;
}

/** The athlete's own post-kit space. A path outside it is never this sweep's to touch. */
const spaceOf = (athleteId: string) => `athletes/${athleteId}/studio/post-kit/`;

/** The decision and key a preview path names — null unless it is under THIS athlete's post-kit space. */
export function previewPathParts(athleteId: string, path: string | null): { decisionId: string; key: string } | null {
  if (!path) return null;
  const space = spaceOf(athleteId);
  if (!path.startsWith(space)) return null;
  const m = /^([^/]+)\/([^/]+)\/[^/]+$/.exec(path.slice(space.length));
  return m ? { decisionId: m[1], key: m[2] } : null;
}

const isPreview = () => eq(mediaAssets.content_format, POST_KIT_PREVIEW_FORMAT);

/**
 * SQL: the row's key (path segment 6 of athletes/<a>/studio/post-kit/<decision>/<key>/<file>, read off gcs_path or, once
 * that is gone, the cover beside it) is NOT its own kit's current preview key. A pre-filter only, so current-key rows
 * never take a slot in a window; the JS check on currentPreview stays the authority.
 */
const notCurrentKey = (): SQL => {
  const path = sql`coalesce(${mediaAssets.gcs_path}, ${mediaAssets.gcs_thumb_path})`;
  return sql`NOT EXISTS (SELECT 1 FROM ${memoryDecisions} md WHERE md.athlete_id = ${mediaAssets.athlete_id}
    AND md.id::text = split_part(${path}, '/', 5)
    AND md.detail #>> '{prepared,postKit,preview,key}' = split_part(${path}, '/', 6))`;
};

const softCandidate = (cutoff: Date) => and(isPreview(), isNull(mediaAssets.deleted_at), lt(mediaAssets.created_at, cutoff), notCurrentKey());
const purgeCandidate = (cutoff: Date) => and(isPreview(), lt(mediaAssets.deleted_at, cutoff),
  or(isNotNull(mediaAssets.gcs_path), isNotNull(mediaAssets.gcs_thumb_path)), notCurrentKey());

class OutOfTime extends Error {}

/** One pass over every athlete with work. Each athlete is its own unit: one that throws does not stop the rest. */
export async function sweepPreviewCleanup(deps: PreviewCleanupDeps = {}): Promise<PreviewCleanupResult> {
  const now = deps.now ?? new Date();
  const clock = deps.clock ?? Date.now;
  const deadline = clock() + (deps.budgetMs ?? POST_KIT_PREVIEW_CLEANUP.BUDGET_MS);
  const inTime = () => { if (clock() >= deadline) throw new OutOfTime(); };
  const softCutoff = new Date(now.getTime() - POST_KIT_PREVIEW_CLEANUP.SOFT_DELETE_AFTER_MS);
  const purgeCutoff = new Date(now.getTime() - POST_KIT_PREVIEW_CLEANUP.PURGE_AFTER_MS);
  const out: PreviewCleanupResult = {
    athletes: 0, softDeleted: 0, restored: 0, purged: 0, filesDeleted: 0, currentKept: 0, sharedKept: 0, purgeFailed: 0,
    failedAthletes: 0, stoppedEarly: false,
  };

  // Oldest stale work first: an athlete processed today leaves the candidate set, so the queue moves.
  const oldest = sql`min(coalesce(${mediaAssets.deleted_at}, ${mediaAssets.created_at}))`;
  const rows = await db.select({ athleteId: mediaAssets.athlete_id }).from(mediaAssets)
    .where(or(softCandidate(softCutoff), purgeCandidate(purgeCutoff)))
    .groupBy(mediaAssets.athlete_id)
    .orderBy(asc(oldest), asc(mediaAssets.athlete_id))
    .limit(deps.maxAthletes ?? POST_KIT_PREVIEW_CLEANUP.MAX_ATHLETES);

  for (const { athleteId } of rows) {
    if (clock() >= deadline) { out.stoppedEarly = true; break; }
    out.athletes++;
    try {
      const s = await softDeleteSuperseded(athleteId, { ...deps, now }, softCutoff, inTime);
      out.softDeleted += s.softDeleted; out.restored += s.restored;
      const p = await purgeDeleted(athleteId, deps, purgeCutoff, inTime);
      out.purged += p.purged; out.filesDeleted += p.filesDeleted; out.currentKept += p.currentKept;
      out.sharedKept += p.sharedKept; out.purgeFailed += p.failed;
    } catch (err: any) {
      if (err instanceof OutOfTime) { out.stoppedEarly = true; break; }
      out.failedAthletes++;
      logger.warn({ athleteId, error: String(err?.message ?? err).slice(0, 200) }, "preview clean-up failed for one athlete");
    }
  }
  if (out.athletes) logger.info(out, "post-kit preview clean-up pass");
  return out;
}

/** A kit's current preview: its key, and the asset ids it names (outputs and cover). */
async function kitNow(store: Pick<AgentStore, "getDecision">, athleteId: string, decisionId: string): Promise<{ key: string | null; named: Set<string> }> {
  // Store-scoped to her: another athlete's decision is simply not found. A missing decision or kit means no current key.
  const preview: PostKitPreview | null = await currentPreview(store as AgentStore, athleteId, decisionId);
  return {
    key: preview?.key ?? null,
    named: new Set<string>([...(preview?.outputs ?? []).map((o) => o.assetId), ...(preview?.coverAssetId ? [preview.coverAssetId] : [])]),
  };
}

/** Phase 1 for one athlete: soft-delete her preview rows older than the cutoff whose key is not their kit's current key. */
export async function softDeleteSuperseded(athleteId: string, deps: PreviewCleanupDeps, cutoff: Date, inTime: () => void = () => {}): Promise<{ softDeleted: number; restored: number }> {
  const store = deps.store ?? dbStore;
  const now = deps.now ?? new Date();
  const rows = await db.select({ id: mediaAssets.id, gcsPath: mediaAssets.gcs_path }).from(mediaAssets)
    .where(and(eq(mediaAssets.athlete_id, athleteId), softCandidate(cutoff)))
    .orderBy(asc(mediaAssets.created_at), asc(mediaAssets.id))
    .limit(deps.maxRowsPerAthlete ?? POST_KIT_PREVIEW_CLEANUP.MAX_ROWS_PER_ATHLETE);

  const byDecision = new Map<string, Array<{ id: string; key: string }>>();
  for (const r of rows) {
    const parts = previewPathParts(athleteId, r.gcsPath);
    if (!parts) continue;   // not under her own post-kit space: never this sweep's
    if (!byDecision.has(parts.decisionId)) byDecision.set(parts.decisionId, []);
    byDecision.get(parts.decisionId)!.push({ id: r.id, key: parts.key });
  }

  const stale = new Map<string, { decisionId: string; key: string }>();
  for (const [decisionId, list] of byDecision) {
    inTime();
    const kit = await kitNow(store, athleteId, decisionId);
    for (const r of list) if (r.key !== kit.key && !kit.named.has(r.id)) stale.set(r.id, { decisionId, key: r.key });
  }
  if (!stale.size) return { softDeleted: 0, restored: 0 };
  const done = await db.update(mediaAssets).set({ deleted_at: now } as never)
    .where(and(eq(mediaAssets.athlete_id, athleteId), isPreview(), isNull(mediaAssets.deleted_at), inArray(mediaAssets.id, [...stale.keys()])))
    .returning({ id: mediaAssets.id });

  // Re-read every affected kit: a swap back (or a render landing) between the read and the UPDATE restores its rows.
  const affected = new Set(done.map((d) => stale.get(d.id)!.decisionId));
  const restore: string[] = [];
  for (const decisionId of affected) {
    const kit = await kitNow(store, athleteId, decisionId);
    for (const d of done) {
      const s = stale.get(d.id)!;
      if (s.decisionId === decisionId && (s.key === kit.key || kit.named.has(d.id))) restore.push(d.id);
    }
  }
  if (restore.length) {
    await db.update(mediaAssets).set({ deleted_at: null } as never)
      .where(and(eq(mediaAssets.athlete_id, athleteId), isPreview(), eq(mediaAssets.deleted_at, now), inArray(mediaAssets.id, restore)));
  }
  return { softDeleted: done.length - restore.length, restored: restore.length };
}

/** Phase 2 for one athlete: delete the files of her preview rows soft-deleted before the cutoff; let go of each gone path. */
export async function purgeDeleted(athleteId: string, deps: PreviewCleanupDeps, cutoff: Date, inTime: () => void = () => {}): Promise<{ purged: number; filesDeleted: number; currentKept: number; sharedKept: number; failed: number }> {
  const store = deps.store ?? dbStore;
  const remove = deps.removeObject ?? removeObject;
  const res = { purged: 0, filesDeleted: 0, currentKept: 0, sharedKept: 0, failed: 0 };
  const rows = await db.select({ id: mediaAssets.id, gcsPath: mediaAssets.gcs_path, thumbPath: mediaAssets.gcs_thumb_path }).from(mediaAssets)
    .where(and(eq(mediaAssets.athlete_id, athleteId), purgeCandidate(cutoff)))
    .orderBy(asc(mediaAssets.deleted_at), asc(mediaAssets.id))
    .limit(deps.maxRowsPerAthlete ?? POST_KIT_PREVIEW_CLEANUP.MAX_ROWS_PER_ATHLETE);

  // Only rows whose every path is under her post-kit space and names a decision and key; anything else is never touched.
  const work = rows.flatMap((r) => {
    const paths = [r.gcsPath, r.thumbPath].filter((p): p is string => !!p);
    const parts = paths.map((p) => previewPathParts(athleteId, p));
    if (!paths.length || parts.some((p) => !p)) return [];
    return [{ ...r, paths, decisionId: parts[0]!.decisionId, key: parts[0]!.key }];
  });
  if (!work.length) return res;

  // One lookup for every path still used by a live row of hers (her athlete index; her paths carry her id).
  const all = [...new Set(work.flatMap((w) => w.paths))];
  const liveRows = await db.select({ p: mediaAssets.gcs_path, t: mediaAssets.gcs_thumb_path }).from(mediaAssets)
    .where(and(eq(mediaAssets.athlete_id, athleteId), isNull(mediaAssets.deleted_at),
      or(inArray(mediaAssets.gcs_path, all), inArray(mediaAssets.gcs_thumb_path, all))));
  const live = new Set(liveRows.flatMap((l) => [l.p, l.t]).filter((p): p is string => !!p));

  const keys = new Map<string, string | null>();
  for (const w of work) {
    inTime();
    if (!keys.has(w.decisionId)) keys.set(w.decisionId, (await kitNow(store, athleteId, w.decisionId)).key);
    if (w.key === keys.get(w.decisionId)) { res.currentKept += w.paths.length; continue; }   // a re-render writes here

    const gone: { gcs_path?: null; gcs_thumb_path?: null } = {};
    for (const [col, path] of [["gcs_path", w.gcsPath], ["gcs_thumb_path", w.thumbPath]] as const) {
      if (!path) continue;
      if (live.has(path)) { res.sharedKept++; continue; }
      if (await remove(path)) { res.filesDeleted++; gone[col] = null; }
      else res.failed++;
    }
    if (!Object.keys(gone).length) continue;
    await db.update(mediaAssets).set(gone as never)
      .where(and(eq(mediaAssets.id, w.id), eq(mediaAssets.athlete_id, athleteId), isPreview(), isNotNull(mediaAssets.deleted_at)));
    const left = (w.gcsPath && !("gcs_path" in gone) ? 1 : 0) + (w.thumbPath && !("gcs_thumb_path" in gone) ? 1 : 0);
    if (!left) res.purged++;
  }
  return res;
}
