/**
 * encryptExistingTokens.ts — seal the OAuth tokens already stored in connected_accounts (TOKEN_KMS).
 *
 *   npx tsx server/scripts/security/encryptExistingTokens.ts [--env <path/.env>]
 *   ... --apply                  write: seal plain-text tokens on live rows, NULL tokens on revoked rows
 *   ... --i-know-this-is-prod    required whenever DATABASE_URL looks like production OR the connected database is not
 *                                the dev database (asked of the server: current_database() must be "nomila_v2")
 *
 * WHY: OAuth tokens were stored as plain text (design note "Mailbox Owns Correspondence" §12). New writes
 * are sealed once TOKEN_KMS=true; this converts the rows written before, and empties revoked rows that
 * kept a token from before disconnect learned to drop it. Run it AFTER the service runs with TOKEN_KMS=true
 * (so nothing new lands in plain text behind it). Re-runnable: sealed rows are skipped.
 *
 * SAFE BY CONSTRUCTION:
 *   - DRY-RUN BY DEFAULT and read-only: without --apply the DB session is opened with PGOPTIONS
 *     `-c default_transaction_read_only=on` BEFORE the pool loads, the run aborts unless
 *     `SHOW default_transaction_read_only` answers `on`, and KMS is never called.
 *   - Counts only — no token, envelope or ciphertext is ever printed.
 *   - --apply needs KMS_TOKEN_KEY (the same cryptoKey the service uses) and ADC that may `encrypt` with it
 *     (roles/cloudkms.cryptoKeyEncrypter is enough; this script never decrypts).
 *   - Compare-and-set per row: a token refreshed mid-run is left for the next run.
 *   - The same prod guard as the privacy scripts (purgeJunkSamplesCore.describeDbTarget).
 *
 * Run by a person only: tests exercise ./encryptExistingTokensCore on PGlite and never import this.
 */

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { readOnlyPgOptions } from "../opps/readOnly";
import { requireProdAck, type Queryable } from "../../lib/devDatabaseGuard";
import { describeDbTarget } from "../privacy/purgeJunkSamplesCore";
import { runEncryptExistingTokens } from "./encryptExistingTokensCore";

const USAGE = "usage: encryptExistingTokens.ts [--env path] [--apply] [--i-know-this-is-prod]";
const KNOWN = new Set(["--env", "--apply", "--i-know-this-is-prod"]);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const e = argv.indexOf("--env");
  const envPath = e >= 0 ? argv[e + 1] : undefined;
  const unknown = argv.filter((a, i) => !KNOWN.has(a) && !(e >= 0 && i === e + 1));
  if (unknown.length || (e >= 0 && !envPath)) {
    console.error(`unknown or incomplete arguments\n${USAGE}`);
    process.exit(2);
  }
  const apply = argv.includes("--apply");
  const allowProd = argv.includes("--i-know-this-is-prod");

  loadEnv({ path: resolve(envPath ?? ".env") });

  const target = describeDbTarget(process.env.DATABASE_URL);
  console.log(`target: ${target.label}`);
  if (target.looksLikeProd && !allowProd) {
    console.error("refusing to run: DATABASE_URL looks like production. Re-run with --i-know-this-is-prod if it is meant to be.");
    process.exit(1);
  }
  if (apply && !process.env.KMS_TOKEN_KEY?.trim()) {
    console.error("refusing to apply: KMS_TOKEN_KEY is not set (pass the same cryptoKey the service uses).");
    process.exit(1);
  }

  if (!apply) process.env.PGOPTIONS = readOnlyPgOptions(process.env.PGOPTIONS);

  const { db, pool } = await import("../../db");
  // The URL guess above cannot see production behind the local proxy (…@localhost:5441/nomila): ask the database
  // itself. Anything that is not the dev database needs --i-know-this-is-prod (server/lib/devDatabaseGuard.ts).
  try { await requireProdAck(allowProd, pool as unknown as Queryable); }
  catch (err: any) { console.error(err?.message ?? err); await pool.end(); process.exit(1); }
  const { sql } = await import("drizzle-orm");
  try {
    if (!apply) {
      const ro = await db.execute(sql`SHOW default_transaction_read_only`);
      const value = String((ro as any).rows?.[0]?.default_transaction_read_only ?? "");
      if (value !== "on") {
        console.error(`refusing to run: the DB session is not read-only (default_transaction_read_only=${value || "?"})`);
        process.exit(1);
      }
    }
    process.exitCode = await runEncryptExistingTokens(db, { apply, log: (line) => console.log(line) });
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // tokenCrypto's messages never carry token material, so they print. Anything else (a DB error can quote
  // the failed query's parameters, i.e. tokens) prints its name and code only.
  const safe = err?.name === "TokenCryptoError" ? String(err.message) : `${err?.name ?? "Error"}${err?.code ? ` (code ${err.code})` : ""}`;
  console.error(`failed: ${safe}`);
  process.exit(1);
});
