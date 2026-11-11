/**
 * fanSafety/fanBlocks.ts — the fans an athlete blocked (0154, table fan_blocks). Not tied to bookings: a block is "this
 * athlete × this person", keyed by keyed hashes of the person's email (and phone, when known), so every place a fan can
 * reach her — a booking request, a friend invite, a join token today, a Live later — asks the same question here.
 *
 *   isFanBlocked   the one check. Any live row whose email hash OR phone hash matches. Callers answer a blocked fan
 *                  with the SAME neutral reply as anyone else they'd refuse (no "you are blocked"), so a block can't be
 *                  discovered by probing.
 *   blockFan       idempotent: blocking someone already blocked returns their live row (and fills a phone hash it
 *                  lacked). Never takes a raw email or phone, only the hashes (bookings/tokens.ts emailHash / phoneHash).
 *   unblockFan     removed_at; the row stays as history. Blocking again later inserts a new row.
 *   listFanBlocks  her list: first name, when, where she blocked them. Never a hash, never contact details.
 *
 * Every function is scoped to her athlete id: another athlete's block is NOT_FOUND.
 */
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "../../db";
import { fanBlocks } from "../../../shared/schema";
import type { FanBlock } from "../../../shared/schema";
import type { FanBlockView } from "../../../shared/bookingsApi";

export type { FanBlockView };
export type FanBlockSource = FanBlockView["source"];

export interface FanKey { emailHash: string; phoneHash?: string | null }

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A hash we can match on: never the placeholder an Ask Mila request carries before its contact step. */
const usable = (h: string | null | undefined): h is string => typeof h === "string" && h.length > 0 && !h.startsWith("pending:");

export function fanBlockView(r: FanBlock): FanBlockView {
  return {
    id: r.id, firstName: r.first_name?.trim() || "A fan", source: r.source as FanBlockSource, bookingId: r.booking_id ?? null,
    reason: r.reason ?? null, blockedAt: r.created_at.toISOString(),
  };
}

/** Is this person blocked by this athlete? Email hash OR phone hash, live rows only. */
export async function isFanBlocked(athleteId: string, key: FanKey): Promise<boolean> {
  const matches = [usable(key.emailHash) ? eq(fanBlocks.email_hash, key.emailHash) : null, usable(key.phoneHash) ? eq(fanBlocks.phone_hash, key.phoneHash) : null]
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (!matches.length) return false;
  const [r] = await db.select({ id: fanBlocks.id }).from(fanBlocks)
    .where(and(eq(fanBlocks.athlete_id, athleteId), isNull(fanBlocks.removed_at), or(...matches))).limit(1);
  return !!r;
}

export interface BlockInput extends FanKey {
  firstName?: string | null;
  reason?: string | null;
  source: FanBlockSource;
  bookingId?: string | null;
}

/** Block this person for this athlete. Returns the live row (the existing one when they were already blocked). */
export async function blockFan(athleteId: string, input: BlockInput, now = new Date()): Promise<{ block: FanBlock; created: boolean }> {
  if (!usable(input.emailHash)) throw Object.assign(new Error("INVALID"), { code: "INVALID", detail: [{ field: "fan", problem: "no contact to block" }] });
  const live = async () => (await db.select().from(fanBlocks)
    .where(and(eq(fanBlocks.athlete_id, athleteId), eq(fanBlocks.email_hash, input.emailHash), isNull(fanBlocks.removed_at))).limit(1))[0];
  const existing = await live();
  if (existing) {
    if (!existing.phone_hash && usable(input.phoneHash)) {
      const [r] = await db.update(fanBlocks).set({ phone_hash: input.phoneHash }).where(eq(fanBlocks.id, existing.id)).returning();
      return { block: r, created: false };
    }
    return { block: existing, created: false };
  }
  const first = input.firstName?.trim().split(/\s+/)[0]?.slice(0, 40) || null;
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) || null : null;
  try {
    const [r] = await db.insert(fanBlocks).values({
      athlete_id: athleteId, email_hash: input.emailHash, phone_hash: usable(input.phoneHash) ? input.phoneHash : null,
      first_name: first, reason, source: input.source, booking_id: input.bookingId ?? null, created_at: now,
    }).returning();
    return { block: r, created: true };
  } catch (err: any) {
    // Two taps at once: uq_fan_blocks_live_email lets exactly one insert win; the other reads it.
    const again = await live();
    if (again) return { block: again, created: false };
    throw err;
  }
}

/** Lift one of her blocks. False when it isn't hers or was already lifted. */
export async function unblockFan(athleteId: string, blockId: unknown, now = new Date()): Promise<boolean> {
  if (typeof blockId !== "string" || !UUID.test(blockId)) return false;
  const rows = await db.update(fanBlocks).set({ removed_at: now })
    .where(and(eq(fanBlocks.id, blockId), eq(fanBlocks.athlete_id, athleteId), isNull(fanBlocks.removed_at))).returning({ id: fanBlocks.id });
  return rows.length > 0;
}

/** Her blocked fans, newest first. */
export async function listFanBlocks(athleteId: string): Promise<FanBlockView[]> {
  const rows = await db.select().from(fanBlocks).where(and(eq(fanBlocks.athlete_id, athleteId), isNull(fanBlocks.removed_at)))
    .orderBy(desc(fanBlocks.created_at)).limit(200);
  return rows.map(fanBlockView);
}
