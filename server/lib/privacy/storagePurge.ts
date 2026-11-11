/**
 * storagePurge.ts — delete every GCS object that belongs to an athlete, after her rows are gone.
 *
 * Walks ATHLETE_STORAGE (the prefixes) plus any explicit path that lies outside them (legacy layouts), each list
 * and delete retried with backoff. Never throws: the result says what went and what did not, and the caller
 * writes it into the deletion receipt.
 */

import { ATHLETE_STORAGE } from "../athleteDataManifest";
import type { ObjectStore } from "./objectStore";

export interface StoragePath { bucket: string; path: string }

export interface StoragePurgeResult {
  ok: boolean;
  prefixes: Array<{ bucket: string; prefix: string; deleted: number; failed: string[]; listError?: string }>;
  objects:  Array<{ bucket: string; path: string; ok: boolean; error?: string }>;
}

export interface RetryOptions { attempts?: number; backoffMs?: number }

async function withRetry<T>(fn: () => Promise<T>, { attempts = 3, backoffMs = 250 }: RetryOptions): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      last = err;
      if (i < attempts - 1 && backoffMs > 0) await new Promise((r) => setTimeout(r, backoffMs * 2 ** i));
    }
  }
  throw last;
}

const msg = (err: unknown) => String((err as any)?.message ?? err).slice(0, 160);

/** The prefixes that hold her objects, resolved to bucket + prefix. */
export function athleteStoragePrefixes(athleteId: string): Array<{ bucket: string; prefix: string }> {
  return ATHLETE_STORAGE.map((p) => ({ bucket: p.bucket(), prefix: p.prefix(athleteId) }));
}

/** Explicit paths not already covered by one of her prefixes in the same bucket. */
export function stragglers(athleteId: string, paths: StoragePath[]): StoragePath[] {
  const prefixes = athleteStoragePrefixes(athleteId);
  const seen = new Set<string>();
  return paths.filter((p) => {
    const key = `${p.bucket}/${p.path}`;
    if (!p.path || seen.has(key)) return false;
    seen.add(key);
    return !prefixes.some((x) => x.bucket === p.bucket && p.path.startsWith(x.prefix));
  });
}

export async function purgeAthleteStorage(
  athleteId: string,
  explicitPaths: StoragePath[],
  store: ObjectStore,
  retry: RetryOptions = {},
): Promise<StoragePurgeResult> {
  const result: StoragePurgeResult = { ok: true, prefixes: [], objects: [] };

  for (const { bucket, prefix } of athleteStoragePrefixes(athleteId)) {
    const row: StoragePurgeResult["prefixes"][number] = { bucket, prefix, deleted: 0, failed: [] };
    try {
      const names = await withRetry(() => store.list(bucket, prefix), retry);
      for (const name of names) {
        try { await withRetry(() => store.remove(bucket, name), retry); row.deleted++; }
        catch { row.failed.push(name); }
      }
    } catch (err) {
      row.listError = msg(err);
    }
    if (row.failed.length || row.listError) result.ok = false;
    // The receipt is capped (8 KB): keep the first failures, the count says how many.
    if (row.failed.length > 20) row.failed = [...row.failed.slice(0, 20), `… and ${row.failed.length - 20} more`];
    result.prefixes.push(row);
  }

  for (const p of stragglers(athleteId, explicitPaths)) {
    try { await withRetry(() => store.remove(p.bucket, p.path), retry); result.objects.push({ ...p, ok: true }); }
    catch (err) { result.ok = false; result.objects.push({ ...p, ok: false, error: msg(err) }); }
  }
  return result;
}
