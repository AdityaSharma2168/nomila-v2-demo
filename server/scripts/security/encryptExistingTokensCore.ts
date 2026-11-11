/**
 * encryptExistingTokensCore — the testable half of encryptExistingTokens.ts.
 *
 * Two things, nothing else:
 *   1. connected_accounts rows that still hold a PLAIN-TEXT access/refresh token and are live
 *      (status pending / active / expired) → the token columns are re-written as TOKEN_KMS envelopes
 *      (server/lib/tokenCrypto.ts). Compare-and-set per row: a row whose token changed after it was read
 *      (a concurrent refresh) is skipped and picked up by the next run.
 *   2. Revoked (disconnected) rows that still hold ANY token → both token columns NULLed. Disconnect has
 *      emptied them since the revoke path learned to (routes/connections.ts); older revoked rows did not.
 *
 * Counts only: no token, envelope, or ciphertext is ever passed to `log`. The dry run reads, never writes,
 * and never calls KMS.
 */

import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { connectedAccounts } from "../../../shared/schema";
import { ENVELOPE_PREFIX, isSealed, sealTokenFieldsNow, type TokenFields } from "../../lib/tokenCrypto";

export interface TokenCounts {
  /** Live rows with at least one plain-text token — what --apply seals. */
  plainLiveRows:     number;
  /** …of which per column. */
  plainAccess:       number;
  plainRefresh:      number;
  /** Rows whose every stored token is already sealed. */
  sealedRows:        number;
  /** Revoked rows still holding a token (plain or sealed) — what --apply NULLs. */
  revokedWithTokens: number;
  /** Rows with no tokens at all. */
  emptyRows:         number;
}

const isPlain = (col: any) => and(isNotNull(col), sql`${col} <> ''`, sql`${col} NOT LIKE ${ENVELOPE_PREFIX + "%"}`);
const isSealedSql = (col: any) => sql`${col} LIKE ${ENVELOPE_PREFIX + "%"}`;
const n = (v: unknown) => Number(v ?? 0);

export async function countTokens(dbx: any): Promise<TokenCounts> {
  const a = connectedAccounts.access_token, r = connectedAccounts.refresh_token;
  const live = sql`coalesce(${connectedAccounts.status}, 'pending') <> 'revoked'`;
  const [row] = await dbx.select({
    plainLiveRows:     sql`count(*) filter (where ${live} and (${isPlain(a)} or ${isPlain(r)}))`,
    plainAccess:       sql`count(*) filter (where ${live} and ${isPlain(a)})`,
    plainRefresh:      sql`count(*) filter (where ${live} and ${isPlain(r)})`,
    sealedRows:        sql`count(*) filter (where (${a} is not null or ${r} is not null)
                                          and (${a} is null or ${isSealedSql(a)}) and (${r} is null or ${isSealedSql(r)}))`,
    revokedWithTokens: sql`count(*) filter (where ${connectedAccounts.status} = 'revoked' and (${a} is not null or ${r} is not null))`,
    emptyRows:         sql`count(*) filter (where ${a} is null and ${r} is null)`,
  }).from(connectedAccounts);
  return {
    plainLiveRows: n(row?.plainLiveRows), plainAccess: n(row?.plainAccess), plainRefresh: n(row?.plainRefresh),
    sealedRows: n(row?.sealedRows), revokedWithTokens: n(row?.revokedWithTokens), emptyRows: n(row?.emptyRows),
  };
}

export interface ApplyResult {
  revokedCleared: number;
  sealed:         number;
  /** Rows whose token changed between read and write (a concurrent refresh) — re-run to pick them up. */
  raced:          number;
}

export async function applyTokenEncryption(
  dbx: any,
  seal: <T extends TokenFields>(patch: T) => Promise<T> = sealTokenFieldsNow,
): Promise<ApplyResult> {
  const a = connectedAccounts.access_token, r = connectedAccounts.refresh_token;

  const cleared = await dbx.update(connectedAccounts)
    .set({ access_token: null, refresh_token: null })
    .where(and(eq(connectedAccounts.status, "revoked"), or(isNotNull(a), isNotNull(r))))
    .returning({ id: connectedAccounts.id });

  const rows: { id: string; access_token: string | null; refresh_token: string | null }[] = await dbx
    .select({ id: connectedAccounts.id, access_token: a, refresh_token: r })
    .from(connectedAccounts)
    .where(and(
      sql`coalesce(${connectedAccounts.status}, 'pending') <> 'revoked'`,
      or(isPlain(a), isPlain(r)),
    ));

  let sealed = 0, raced = 0;
  for (const row of rows) {
    const next = await seal({ access_token: row.access_token, refresh_token: row.refresh_token });
    if (next.access_token === row.access_token && next.refresh_token === row.refresh_token) continue;
    if ((next.access_token && !isSealed(next.access_token)) || (next.refresh_token && !isSealed(next.refresh_token))) {
      throw new Error(`seal returned an unsealed value for connection ${row.id} — stopping`);
    }
    // Compare-and-set on the values we read: a refresh that landed in between wins.
    const done = await dbx.update(connectedAccounts)
      .set({ access_token: next.access_token, refresh_token: next.refresh_token })
      .where(and(
        eq(connectedAccounts.id, row.id),
        sql`${a} is not distinct from ${row.access_token}`,
        sql`${r} is not distinct from ${row.refresh_token}`,
      ))
      .returning({ id: connectedAccounts.id });
    if (done.length) sealed++; else raced++;
  }
  return { revokedCleared: cleared.length, sealed, raced };
}

export function formatCounts(c: TokenCounts): string[] {
  return [
    `live rows with a plain-text token: ${c.plainLiveRows} (access ${c.plainAccess}, refresh ${c.plainRefresh})`,
    `rows already sealed: ${c.sealedRows}`,
    `revoked rows still holding a token: ${c.revokedWithTokens}`,
    `rows with no token: ${c.emptyRows}`,
  ];
}

export interface RunOptions {
  apply: boolean;
  log:   (line: string) => void;
  seal?: <T extends TokenFields>(patch: T) => Promise<T>;
}

/** The whole run: counts, then (only with apply) seal + clear, then counts again. Returns 1 when work remains. */
export async function runEncryptExistingTokens(dbx: any, opts: RunOptions): Promise<number> {
  const before = await countTokens(dbx);
  for (const line of formatCounts(before)) opts.log(line);
  if (!opts.apply) {
    opts.log("DRY-RUN — nothing written, KMS not called. Re-run with --apply.");
    return 0;
  }
  const res = await applyTokenEncryption(dbx, opts.seal);
  const after = await countTokens(dbx);
  opts.log(`APPLIED — ${res.sealed} row(s) sealed, ${res.revokedCleared} revoked row(s) emptied, ${res.raced} skipped (changed mid-run).`);
  for (const line of formatCounts(after)) opts.log(`after: ${line}`);
  return after.plainLiveRows > 0 || after.revokedWithTokens > 0 ? 1 : 0;
}
