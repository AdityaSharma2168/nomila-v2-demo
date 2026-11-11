/**
 * migrationsGuard.test.ts — a static guard on the hand-written migration files (process rule adopted 11 Sep 2026 after the
 * production migration incident: a chained "dry-run" wrapped in an outer BEGIN … ROLLBACK was committed by the inner
 * COMMIT of 0040/0042, and everything after autocommitted).
 *
 *   • every migration file that carries its own transaction control (BEGIN; / COMMIT; / ROLLBACK; / START TRANSACTION)
 *     must be on the allow-list below — so anyone composing files sees which ones cannot be wrapped;
 *   • a file may not mix the two: a file on the allow-list must open AND close its own transaction;
 *   • non-transactional DDL (CREATE INDEX CONCURRENTLY, VACUUM, ALTER TYPE … ADD VALUE) is listed too — it cannot run inside
 *     any transaction, so a wrapped dry-run of such a file fails or lies.
 * Migration validation is per file, with the runner's own mechanism; production commands need explicit approval.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..", "migrations");

/**
 * Files that manage their own transaction. Adding a file here is a design decision, not a convenience. Empty since
 * the legacy retirement (P3-2): the only two, 0040 / 0042 (scoring_weights inserts), were deleted with the table (0127).
 */
const OWN_TRANSACTION: string[] = [];
/**
 * Files with non-transactional DDL (CREATE INDEX CONCURRENTLY …): no BEGIN/COMMIT of their own, run by db-migrate.sh with
 * plain `psql -f`, and dry-run PLAINLY against dev (never wrapped). Adding a file here is a design decision too.
 */
const NON_TRANSACTIONAL: string[] = ["0150_platform_spend_indexes.sql"];

const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
/** Top-level transaction statements only: `BEGIN;` / `START TRANSACTION;` / `COMMIT;` / `ROLLBACK;` — not the BEGIN … END of a DO $$ block. */
const txStatements = (sql: string) => stripComments(sql).match(/^\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;/gim) ?? [];
const nonTransactional = (sql: string) => stripComments(sql).match(/\b(CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY|DROP\s+INDEX\s+CONCURRENTLY|VACUUM|ALTER\s+TYPE\s+\w+\s+ADD\s+VALUE)\b/gi) ?? [];

const files = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

describe("hand-written migrations: transaction control is explicit and visible", () => {
  it("scans the numbered files", () => { expect(files.length).toBeGreaterThan(10); });

  for (const f of files) {
    it(`${f}`, () => {
      const sql = readFileSync(join(DIR, f), "utf8");
      const tx = txStatements(sql).map((s) => s.trim().replace(/\s+/g, " ").toUpperCase());
      if (OWN_TRANSACTION.includes(f)) {
        expect(tx.some((s) => /^(BEGIN|START TRANSACTION)/.test(s))).toBe(true);
        expect(tx.some((s) => /^COMMIT/.test(s))).toBe(true);
      } else {
        expect(tx).toEqual([]);   // a file with its own BEGIN/COMMIT must be added to OWN_TRANSACTION deliberately
      }
      if (NON_TRANSACTIONAL.includes(f)) {
        expect(tx).toEqual([]);                          // never wrapped: CONCURRENTLY cannot run inside a transaction
        expect(nonTransactional(sql).length).toBeGreaterThan(0);
      } else {
        expect(nonTransactional(sql)).toEqual([]);       // list such a file in NON_TRANSACTIONAL deliberately
      }
    });
  }
});
