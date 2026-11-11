/**
 * social/retention.ts — TTL deletion of raw payloads (decision D2).
 *
 * A payload row carries retained_until, computed at insert from the versioned retention
 * parameter (180 days connected, 90 days public, alpha). This deletes rows past it.
 * Observations, distributions and features reference payloads with ON DELETE SET NULL and
 * survive; only the raw envelope goes. Runs at the end of the nightly cron when the flag is on.
 */

import { lt, and, isNotNull } from "drizzle-orm";
import { db } from "../../../db";
import { rawSourcePayloads } from "../../../../shared/schema";
import { createLogger } from "../../../logger";

const logger = createLogger("social-substrate");

export async function enforceRawRetention(now: Date = new Date()): Promise<{ deleted: number }> {
  const rows = await db.delete(rawSourcePayloads)
    .where(and(isNotNull(rawSourcePayloads.retained_until), lt(rawSourcePayloads.retained_until, now)))
    .returning({ id: rawSourcePayloads.id });
  if (rows.length) logger.info({ deleted: rows.length }, "raw payload retention");
  return { deleted: rows.length };
}
