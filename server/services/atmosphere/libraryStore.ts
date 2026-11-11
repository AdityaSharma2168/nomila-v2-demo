/**
 * atmosphere/libraryStore.ts — writes to the SHARED atmosphere library (0120) for the import scripts: which
 * photos are already in it (and their current `active` flag, to sync against the list), and add one stored photo
 * or flip an existing one's `active`. Shared data: no athlete id anywhere here.
 */
import { inArray, and, eq } from "drizzle-orm";
import { db, pool } from "../../db";
import { saveBuffer } from "../../lib/mediaStore";
import { atmosphereLibrary } from "../../../shared/schema";
import { objectBase, type LibraryEntry, type LibrarySource } from "./library";

/**
 * The (source, id) pairs among `photos` already in the library, as `"<source>:<id>"` → the row's current `active`
 * flag. Scoped by source so an Unsplash id can never shadow a same-looking Pexels one. A run skips a present photo
 * it would otherwise download, but still compares its `active` flag against the list (see fill-atmosphere-library.ts).
 */
export async function presentRows(photos: ReadonlyArray<{ source: LibrarySource; id: string }>): Promise<Map<string, boolean>> {
  if (!photos.length) return new Map();
  const sources = [...new Set(photos.map((p) => p.source))];
  const ids = [...new Set(photos.map((p) => p.id))];
  const rows = await db.select({ source: atmosphereLibrary.source, id: atmosphereLibrary.source_id, active: atmosphereLibrary.active }).from(atmosphereLibrary)
    .where(and(inArray(atmosphereLibrary.source, sources), inArray(atmosphereLibrary.source_id, ids)));
  return new Map(rows.map((r) => [`${r.source}:${r.id}`, r.active] as const));
}

/** Flip an existing row's `active` flag to match the list (never re-downloads or re-uploads the photo itself). */
export async function setActive(source: LibrarySource, id: string, active: boolean): Promise<void> {
  await db.update(atmosphereLibrary).set({ active, updated_at: new Date() })
    .where(and(eq(atmosphereLibrary.source, source), eq(atmosphereLibrary.source_id, id)));
}

/** Upload the WebP copy to atmosphere/shared/<group>/<id>.webp and record it. */
export async function addPhoto(p: {
  entry: LibraryEntry; id: string; webp: { bytes: Buffer; width: number; height: number };
  checkResult: Record<string, unknown>; curated: boolean;
}): Promise<{ gcs_path: string }> {
  const saved = await saveBuffer(p.webp.bytes, objectBase(p.entry, p.id), "image/webp");
  if ("skipped" in saved) throw new Error(`${p.id}: too large to store`);
  await db.insert(atmosphereLibrary).values({
    source: p.entry.source, source_id: p.id, source_url: p.entry.page,
    photographer: p.entry.photographer ?? null, photographer_url: p.entry.photographerUrl ?? null, licence: p.entry.licence,
    category: p.entry.category, sport: p.entry.sport ?? null, purposes: p.entry.purposes, tags: p.entry.tags,
    gcs_path: saved.gcs_path, content_type: saved.content_type, width: p.webp.width, height: p.webp.height, bytes: saved.bytes,
    check_result: { ...p.checkResult, title: p.entry.title ?? null }, curated: p.curated, active: true,
  }).onConflictDoNothing();
  return { gcs_path: saved.gcs_path };
}

export async function close(): Promise<void> { await pool.end(); }
