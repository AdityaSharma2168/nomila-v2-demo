/**
 * templates/registry — the published `prompts` row for a Studio template key, read directly (quality-scrappy piece 4,
 * ADI-QS-GO). Read-only against Mia's table, whose schema this never touches.
 *
 * Why not `resolvePrompt` (server/lib/promptRegistry.ts): it returns the body alone, and the frozen brief needs the
 * VERSION and HASH too, so a pass rate can be counted per version later. The query is the same one that function runs
 * — key and `status = 'published'`, at most one row by the partial unique index — and like it this degrades to "no
 * row" on any error, so an unreachable registry is the TS literal, never a failed quote.
 *
 * Cached for a minute, the registry's own TTL: publishing is seen on the next quote after that.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { createLogger } from "../../logger";

const logger = createLogger("studio-templates");
const TTL_MS = 60_000;

// A type alias, not an interface: drizzle's execute<T> wants a Record, which an interface is not assignable to.
export type PublishedRow = {
  body: string;
  version: number;
  hash: string;
};

const cache = new Map<string, { row: PublishedRow | null; at: number }>();

export async function publishedTemplate(
  key: string,
): Promise<PublishedRow | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.row;
  let row: PublishedRow | null = null;
  try {
    const res = await db.execute<PublishedRow>(
      sql`SELECT body, version, hash FROM prompts WHERE key = ${key} AND status = 'published' LIMIT 1`,
    );
    const rows =
      (res as unknown as { rows?: PublishedRow[] }).rows ??
      (res as unknown as PublishedRow[]);
    row = rows[0]?.body ? rows[0] : null;
  } catch (err) {
    logger.warn(
      {
        key,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      },
      "template registry read failed — using the literal",
    );
  }
  cache.set(key, { row, at: Date.now() });
  return row;
}

/** For tests and an explicit reload. */
export function clearTemplateCache(): void {
  cache.clear();
}
