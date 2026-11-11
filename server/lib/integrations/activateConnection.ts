/**
 * activateConnection — the ONE place an OAuth callback turns tokens into a connected_accounts row.
 *
 * The invariant (docs/plans/connection-identity-fix.md §3, migration 0071): a connection is the pair
 * (athlete, provider account) and has exactly one row for its whole life. Every provider's handleCallback
 * (gmail, outlook, instagram, tiktok, youtube, spotify) exchanges the code, fetches the profile, derives the
 * provider's stable account id, and then calls this — so the six callbacks cannot drift.
 *
 *   • A row for (athlete, platform, platform_user_id) already exists, in ANY status → update it in place:
 *     new tokens + expiry, GRANTED scopes, status active, platform_username refreshed, alias kept unless this
 *     connect supplied one, every sync cursor reset (last_fetched_at, gmail_history_id, sync_cursor → null, so
 *     the provider re-backfills), connected_at = now. The pending row this attempt created is deleted.
 *   • Otherwise → promote this attempt's pending row (first-ever connect for this account), or insert one if the
 *     pending row is gone.
 *
 * Runs in a transaction. connected_accounts_account_uq turns two racing callbacks for one account into one row:
 * the loser hits 23505, and the retry finds the winner's row and updates it.
 *
 * The returned id is the row the callback's follow-up work must use (onConnected, first_look, social_sync);
 * connectedAt is the connect generation that keys those runs.
 */

import { and, eq, ne } from "drizzle-orm";
import { db } from "../../db";
import { connectedAccounts } from "../../../shared/schema";
import { isUniqueViolation } from "../../services/intelligence/identity/users";
import { sealTokenFields } from "../tokenCrypto";
import type { ActivatedConnection } from "./types";

export const ACCOUNT_UNIQUE_INDEX = "connected_accounts_account_uq";

export interface ActivateConnectionInput {
  athleteId:        string;
  platform:         string;
  /** Alias supplied with THIS connect (from the signed state). Blank/undefined keeps an existing row's alias. */
  alias?:           string | null;
  /** The provider's stable account id. Required: a connect that cannot establish it must fail before here. */
  platformUserId:   string;
  platformUsername: string | null;
  accessToken:      string;
  refreshToken:     string | null;
  tokenExpiresAt:   Date | null;
  /** The scopes the provider says it GRANTED (fallback to the requested set only if it omits them). */
  scopes:           string;
  /** Provider-specific columns to write on activation (e.g. Instagram's legacy ig_page_id: null). */
  extra?:           Partial<typeof connectedAccounts.$inferInsert>;
  /** Tests only: runs inside the transaction after the lookups and before the write (forces the race path). */
  __beforeWrite?:   () => Promise<void>;
}

/** Thrown when a provider could not tell us which account the athlete connected. */
export class MissingAccountIdError extends Error {
  constructor(platform: string) {
    super(`Could not identify the ${platform} account — please try connecting again.`);
    this.name = "MissingAccountIdError";
  }
}

export async function activateConnection(input: ActivateConnectionInput): Promise<ActivatedConnection> {
  if (!input.platformUserId || !String(input.platformUserId).trim()) throw new MissingAccountIdError(input.platform);
  // TOKEN_KMS: seal once, before the transaction (the KMS call must not hold row locks); the race retry reuses it.
  const sealed = await sealTokenFields({ access_token: input.accessToken, refresh_token: input.refreshToken });
  input = { ...input, accessToken: sealed.access_token!, refreshToken: sealed.refresh_token ?? null };
  try {
    return await activateOnce(input);
  } catch (err) {
    // Lost a race with a concurrent callback for the same account: its row now exists, so the retry updates it.
    if (isUniqueViolation(err, ACCOUNT_UNIQUE_INDEX)) return activateOnce({ ...input, __beforeWrite: undefined });
    throw err;
  }
}

async function activateOnce(input: ActivateConnectionInput): Promise<ActivatedConnection> {
  const { athleteId, platform } = input;
  const alias       = input.alias?.trim() || null;
  const connectedAt = new Date();

  return db.transaction(async (tx) => {
    // This attempt's pending row (POST /connect/:platform inserted it; it carries connected_by_user_id).
    const [pending] = await tx
      .select({ id: connectedAccounts.id, connected_by_user_id: connectedAccounts.connected_by_user_id })
      .from(connectedAccounts)
      .where(and(
        eq(connectedAccounts.athlete_id, athleteId),
        eq(connectedAccounts.platform,   platform),
        eq(connectedAccounts.status,     "pending"),
        ...(alias ? [eq(connectedAccounts.alias, alias)] : []),
      ))
      .limit(1);

    // The account's one row, in any status (active, expired, revoked — or a pending row that already carries the id).
    const [existing] = await tx
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(and(
        eq(connectedAccounts.athlete_id,       athleteId),
        eq(connectedAccounts.platform,         platform),
        eq(connectedAccounts.platform_user_id, input.platformUserId),
        ...(pending ? [ne(connectedAccounts.id, pending.id)] : []),
      ))
      .limit(1)
      .for("update");

    if (input.__beforeWrite) await input.__beforeWrite();

    const values = {
      ...input.extra,
      status:            "active" as const,
      access_token:      input.accessToken,
      refresh_token:     input.refreshToken,
      token_expires_at:  input.tokenExpiresAt,
      platform_user_id:  input.platformUserId,
      platform_username: input.platformUsername,
      scopes:            input.scopes,
      // A reactivated row must re-backfill: Gmail reads a non-null last_fetched_at as "backfill done",
      // and an old history id / DM cursor would skip everything that arrived while it was disconnected.
      last_fetched_at:   null,
      gmail_history_id:  null,
      sync_cursor:       null,
      connected_at:      connectedAt,
    };

    if (existing) {
      if (pending) await tx.delete(connectedAccounts).where(eq(connectedAccounts.id, pending.id));
      await tx.update(connectedAccounts).set({
        ...values,
        ...(alias ? { alias } : {}),
        ...(pending?.connected_by_user_id ? { connected_by_user_id: pending.connected_by_user_id } : {}),
      }).where(eq(connectedAccounts.id, existing.id));
      return { connectionId: existing.id, connectedAt, reactivated: true };
    }

    if (pending) {
      await tx.update(connectedAccounts).set({ ...values, alias }).where(eq(connectedAccounts.id, pending.id));
      return { connectionId: pending.id, connectedAt, reactivated: false };
    }

    const [inserted] = await tx
      .insert(connectedAccounts)
      .values({ athlete_id: athleteId, platform, alias, ...values })
      .returning({ id: connectedAccounts.id });
    return { connectionId: inserted.id, connectedAt, reactivated: false };
  });
}
