/**
 * verifyDeletion.ts — DRY RUN, READ-ONLY: what of one athlete would REMAIN after DELETE /api/v1/me/account?
 *
 *   npx tsx --require dotenv/config server/scripts/privacy/verifyDeletion.ts --athlete <uuid> [--no-storage] [--json]
 *       [--connect-account <acct_…>] [--brand-email <address>]
 *
 * Run it before the account is deleted (what the delete would miss) and after (what it did miss). It reads the
 * LIVE database, not shared/schema.ts, so it catches drift between the migrations and the manifest:
 *
 *   1. Covered rows: her rows in every manifest table (deleted by the account delete; listed for scale).
 *   2. Uncovered tables: any live table with an athlete-id column, or a foreign key into a manifest table, that is
 *      not in the manifest — with her row count. These rows would REMAIN (or block the delete).
 *   3. Delete-order hazards: a live NO ACTION / RESTRICT foreign key between manifest tables that the manifest
 *      orders parent-first. The delete transaction would fail on it.
 *   4. Residual references without a foreign key (jsonb / arrays naming her id) in tables the delete leaves alone
 *      (informational), and shared rows the delete SCRUBS (SCRUBBED_REFERENCES: research_planner_runs) — before the
 *      delete these are what it will scrub; after it, any mention left is a leftover.
 *   5. Storage: objects under her GCS prefixes, plus paths her rows name outside them (list only, never delete).
 *   6. Blockers and receipts: payments that would refuse the delete; any account_deletion receipt for her.
 *   7. Financial records (retention category financial_record): no financial_ledger_records row and no
 *      payment_events payload may carry her athlete id, her deal ids, her Stripe Connect account id or a brand email
 *      from her payments; and the live financial_ledger_records table may hold only its de-identified columns.
 *      Before the delete these come from her live rows (payloads that match are what the delete will minimize);
 *      after it, her athlete id and deal ids come from the receipt, and the Connect account id / brand email —
 *      which Nomila no longer holds — can be supplied with --connect-account <acct_…> / --brand-email <address>.
 *
 * READ-ONLY by construction: every pooled session is put into default_transaction_read_only before any query, so a
 * write a future edit might add fails instead of running. No provider is called; GCS is only listed.
 * Exit code: 0 when nothing would remain, 1 when something would (or the check itself failed).
 */

import { sql } from "drizzle-orm";
import { db, pool } from "../../db";
import {
  ATHLETE_DATA_MANIFEST, ATHLETE_STORAGE_COLUMNS, SCRUBBED_REFERENCES, athleteWhere, deleteOrderOf, manifestEntry,
} from "../../lib/athleteDataManifest";
import { resolveAthleteScope, rowsOf, type ResolvedScope } from "../../services/privacy/athleteScope";
import { PAYMENT_STATES_IN_FLIGHT, DELETION_PROCESS } from "../../services/privacy/deleteAthleteAccount";
import { athleteStoragePrefixes, stragglers, type StoragePath } from "../../lib/privacy/storagePurge";
import { gcsObjectStore } from "../../lib/privacy/objectStore";
import { herFinancialIdentifiers, textContainsAny } from "../../lib/privacy/financialRecords";

/** The only columns financial_ledger_records may have (0087). */
const LEDGER_COLUMNS = new Set([
  "id", "kind", "status", "deal_value_cents", "commission_cents", "processing_fee_cents", "brand_total_cents", "currency",
  "stripe_payment_intent_id", "stripe_charge_id", "stripe_transfer_id", "stripe_refund_id",
  "payment_created_at", "deidentified_at", "retention_category",
]);

pool.on("connect", (client: any) => {
  client.query("SET default_transaction_read_only = on").catch((err: unknown) => {
    console.error("could not make the session read-only", err);
    process.exit(1);
  });
});

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANIFEST = new Set(ATHLETE_DATA_MANIFEST.map((e) => e.name));
const q = async <T = any>(query: any): Promise<T[]> => rowsOf<T>(await db.execute(query));

/** Jsonb / array columns in tables the delete leaves alone that can name an athlete id without a foreign key. */
const RESIDUAL_REFERENCES: Array<{ table: string; column: string }> = [
  // research_planner_runs is scrubbed by the delete: checked through SCRUBBED_REFERENCES, not here.
  { table: "payment_events",        column: "payload" },
  // Other athletes' rows that can list her (kept with THEIR data, reported so the owner can decide).
  { table: "athlete_index_matches", column: "candidates" },
  { table: "campaigns",             column: "participant_athlete_ids" },
];

interface Report {
  athlete_id: string;
  athlete_exists: boolean;
  user_ids: string[];
  covered_rows: Record<string, number>;
  would_remain: {
    uncovered_tables: Array<{ table: string; via: string; rows: number | null }>;
    order_hazards: string[];
    residual_references: Array<{ table: string; column: string; rows: number }>;
    /** After a delete only: shared rows still naming her that the delete should have scrubbed. */
    unscrubbed_references: Array<{ table: string; rows: number }>;
    storage: Array<{ bucket: string; path: string; why: string }>;
  };
  blockers: { payments_in_flight: number };
  financial_records: {
    identifiers_checked: { athlete_id: boolean; deal_ids: number; connect_account_ids: number; brand_emails: number };
    ledger_rows_naming_her: number;
    payment_events_naming_her: number;
    unexpected_ledger_columns: string[];
  };
  /** Before a delete: shared rows the delete will scrub her id out of. */
  will_scrub: Record<string, number>;
  receipts: Array<{ id: string; status: string; started_at: string; last_error: string | null }>;
  notes: string[];
}

async function main(): Promise<number> {
  const athleteId = arg("--athlete");
  if (!athleteId || !UUID.test(athleteId)) {
    console.error("usage: verifyDeletion.ts --athlete <uuid> [--no-storage] [--json] [--connect-account <acct_…>] [--brand-email <address>]");
    return 1;
  }
  const notes: string[] = [];

  // Scope. After a delete the athlete row is gone: take her sign-in users from the receipt.
  const receipts = await q<{ id: string; status: string; started_at: string; last_error: string | null; input: any }>(sql`
    SELECT id, status, started_at::text, last_error, input FROM workflow_runs
    WHERE process = ${DELETION_PROCESS} AND input->>'subject_athlete_id' = ${athleteId} ORDER BY started_at DESC
  `);
  const resolved = await resolveAthleteScope(db, athleteId);
  const scope: ResolvedScope = resolved ?? {
    athleteId, authId: null,
    userIds: (receipts[0]?.input?.user_ids as string[] | undefined) ?? [],
  };
  if (!resolved) notes.push(receipts.length ? "athlete row is gone (deleted); checking for leftovers" : "athlete row not found and no deletion receipt");

  // 1. Covered rows.
  const covered_rows: Record<string, number> = {};
  for (const e of ATHLETE_DATA_MANIFEST) {
    const [r] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${e.table} WHERE ${athleteWhere(e, scope)}`);
    if (Number(r.n) > 0) covered_rows[e.name] = Number(r.n);
  }
  // After a delete, anything still covered remains.
  const leftoverCovered = resolved ? [] : Object.entries(covered_rows).map(([t, n]) => ({ table: t, via: "manifest predicate (still present after delete)", rows: n }));

  // 2. Uncovered live tables.
  const athleteCols = await q<{ table_name: string; column_name: string }>(sql`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name ~ '(^|_)athlete_id$'
      AND table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE')
  `);
  const liveFks = await q<{ child: string; parent: string; cols: string; deltype: string }>(sql`
    SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
           (SELECT string_agg(a.attname, ',') FROM unnest(c.conkey) k JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) AS cols,
           c.confdeltype::text AS deltype
    FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
  `);
  const strip = (t: string) => t.replace(/^public\./, "").replace(/"/g, "");
  const uncovered: Report["would_remain"]["uncovered_tables"] = [...leftoverCovered];
  for (const { table_name, column_name } of athleteCols) {
    if (MANIFEST.has(table_name)) continue;
    const [r] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table_name)} WHERE ${sql.identifier(column_name)}::text = ${athleteId}`);
    uncovered.push({ table: table_name, via: `column ${column_name}`, rows: Number(r.n) });
  }
  for (const fk of liveFks) {
    const child = strip(fk.child); const parent = strip(fk.parent);
    if (MANIFEST.has(child) || !MANIFEST.has(parent)) continue;
    const parentEntry = manifestEntry(parent);
    let n: number | null = null;
    if (!fk.cols.includes(",")) {
      const [r] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.identifier(child)} WHERE ${sql.identifier(fk.cols)} IN (SELECT "id" FROM ${parentEntry.table} WHERE ${athleteWhere(parentEntry, scope)})`);
      n = Number(r.n);
    }
    uncovered.push({ table: child, via: `FK ${fk.cols} → ${parent} (on delete ${fk.deltype})`, rows: n });
  }

  // 3. Live delete-order hazards (a = no action, r = restrict).
  const order_hazards: string[] = [];
  for (const fk of liveFks) {
    const child = strip(fk.child); const parent = strip(fk.parent);
    if (child === parent || !MANIFEST.has(child) || !MANIFEST.has(parent)) continue;
    if ((fk.deltype === "a" || fk.deltype === "r") && deleteOrderOf(child) > deleteOrderOf(parent)) {
      order_hazards.push(`${child}.${fk.cols} → ${parent}: the manifest deletes the parent first; the live FK is ${fk.deltype === "a" ? "NO ACTION" : "RESTRICT"}`);
    }
  }

  // 4. Residual references.
  const residual_references: Report["would_remain"]["residual_references"] = [];
  const liveTables = new Set((await q<{ t: string }>(sql`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public'`)).map((r) => r.t));
  for (const ref of RESIDUAL_REFERENCES) {
    if (!liveTables.has(ref.table)) continue;
    const owned = MANIFEST.has(ref.table) ? sql` AND NOT (${athleteWhere(manifestEntry(ref.table), scope)})` : sql``;
    const [r] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.identifier(ref.table)} WHERE ${sql.identifier(ref.column)}::text LIKE ${"%" + athleteId + "%"}${owned}`);
    if (Number(r.n) > 0) residual_references.push({ ...ref, rows: Number(r.n) });
  }
  const will_scrub: Record<string, number> = {};
  const unscrubbed_references: Report["would_remain"]["unscrubbed_references"] = [];
  for (const ref of SCRUBBED_REFERENCES) {
    if (!liveTables.has(ref.table)) continue;
    const mentions = sql.join(ref.columns.map((c) => sql`${sql.identifier(c)}::text LIKE ${"%" + athleteId + "%"}`), sql` OR `);
    const [r] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.identifier(ref.table)} WHERE ${mentions}`);
    if (Number(r.n) === 0) continue;
    if (resolved) will_scrub[ref.table] = Number(r.n);
    else unscrubbed_references.push({ table: ref.table, rows: Number(r.n) });
  }

  // 5. Storage (list only).
  const storage: Report["would_remain"]["storage"] = [];
  if (flag("--no-storage")) notes.push("storage not checked (--no-storage)");
  else {
    const store = gcsObjectStore();
    const explicit: StoragePath[] = [];
    for (const c of ATHLETE_STORAGE_COLUMNS) {
      const e = manifestEntry(c.table);
      for (const r of await q<{ p: string }>(sql`SELECT ${sql.identifier(c.column)} AS p FROM ${e.table} WHERE ${athleteWhere(e, scope)} AND ${sql.identifier(c.column)} IS NOT NULL`)) {
        explicit.push({ bucket: c.bucket(), path: r.p });
      }
    }
    for (const { bucket, prefix } of athleteStoragePrefixes(athleteId)) {
      try {
        const names = await store.list(bucket, prefix);
        // Before the delete these would be purged; after it, they remain.
        if (!resolved) for (const name of names) storage.push({ bucket, path: name, why: `still under ${prefix} after delete` });
        else if (names.length) notes.push(`${names.length} object(s) under gs://${bucket}/${prefix} would be purged`);
      } catch (err: any) {
        storage.push({ bucket, path: prefix, why: `could not list: ${String(err?.message ?? err).slice(0, 120)}` });
      }
    }
    const extra = stragglers(athleteId, explicit);
    if (extra.length) notes.push(`${extra.length} legacy path(s) outside her prefixes would be deleted one by one`);
  }

  // 6. Blockers.
  const [inFlight] = await q<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM payments
    WHERE athlete_id = ${athleteId}::uuid AND status IN (${sql.join(PAYMENT_STATES_IN_FLIGHT.map((s) => sql`${s}`), sql`, `)})
  `);

  // 7. Financial records.
  const fin = resolved ? await herFinancialIdentifiers(db, athleteId) : null;
  const dealIds: string[] = resolved
    ? (await q<{ id: string }>(sql`SELECT id::text FROM deals WHERE athlete_id = ${athleteId}::uuid`)).map((d) => d.id)
    : ((receipts[0]?.input?.deal_ids as string[] | undefined) ?? []);
  const connectIds = [...new Set([...(fin?.connectAccountIds ?? []), ...(arg("--connect-account") ? [arg("--connect-account")!] : [])])];
  const brandEmails = [...new Set([...(fin?.brandEmails ?? []), ...(arg("--brand-email") ? [arg("--brand-email")!] : [])])];
  if (!resolved && !receipts[0]?.input?.deal_ids) notes.push("financial records: the receipt predates deal_ids — deal ids not checked");
  if (!resolved && !connectIds.length) notes.push("financial records: no --connect-account given — Connect account id not checked");
  if (!resolved && !brandEmails.length) notes.push("financial records: no --brand-email given — brand email not checked");
  const needles = [athleteId, ...dealIds, ...connectIds, ...brandEmails];
  const ledgerCols = (await q<{ c: string }>(sql`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'financial_ledger_records'`)).map((r) => r.c);
  const [ledgerHits] = ledgerCols.length
    ? await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM financial_ledger_records f WHERE ${textContainsAny(sql`to_jsonb(f)`, needles)}`)
    : [{ n: 0 }];
  const [eventHits] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM payment_events WHERE payload IS NOT NULL AND ${textContainsAny(sql`payload`, needles)}`);
  if (!ledgerCols.length) notes.push("financial_ledger_records does not exist on this database yet (0087 not applied)");
  if (resolved && Number(eventHits.n) > 0) notes.push(`${eventHits.n} payment_events payload(s) name her; the delete will cut them to the whitelist`);
  const financial_records: Report["financial_records"] = {
    identifiers_checked: { athlete_id: true, deal_ids: dealIds.length, connect_account_ids: connectIds.length, brand_emails: brandEmails.length },
    ledger_rows_naming_her: Number(ledgerHits.n),
    payment_events_naming_her: Number(eventHits.n),
    unexpected_ledger_columns: ledgerCols.filter((c) => !LEDGER_COLUMNS.has(c)),
  };

  const report: Report = {
    athlete_id: athleteId,
    athlete_exists: !!resolved,
    user_ids: scope.userIds,
    covered_rows,
    would_remain: { uncovered_tables: uncovered, order_hazards, residual_references, unscrubbed_references, storage },
    blockers: { payments_in_flight: Number(inFlight.n) },
    financial_records,
    will_scrub,
    receipts: receipts.map(({ input: _input, ...r }) => r),
    notes,
  };

  if (flag("--json")) console.log(JSON.stringify(report, null, 2));
  else printReport(report);

  const finLeft = financial_records.ledger_rows_naming_her > 0 || financial_records.unexpected_ledger_columns.length > 0
    || (!resolved && financial_records.payment_events_naming_her > 0);
  const remains = uncovered.some((u) => u.rows !== 0) || order_hazards.length > 0 || storage.length > 0 || finLeft
    || unscrubbed_references.length > 0;
  return remains ? 1 : 0;
}

function printReport(r: Report): void {
  const total = Object.values(r.covered_rows).reduce((a, b) => a + b, 0);
  console.log(`verifyDeletion (dry run, read-only) — athlete ${r.athlete_id} ${r.athlete_exists ? "(exists)" : "(not found)"}`);
  console.log(`\n1. Manifest rows ${r.athlete_exists ? "the delete would remove" : "still present"}: ${total} across ${Object.keys(r.covered_rows).length} tables`);
  for (const [t, n] of Object.entries(r.covered_rows)) console.log(`   ${t.padEnd(32)} ${n}`);
  const w = r.would_remain;
  console.log(`\n2. Would remain — tables outside the manifest: ${w.uncovered_tables.length || "none"}`);
  for (const u of w.uncovered_tables) console.log(`   ${u.table} via ${u.via}: ${u.rows ?? "?"} row(s)`);
  console.log(`\n3. Delete-order hazards on the live schema: ${w.order_hazards.length || "none"}`);
  for (const h of w.order_hazards) console.log(`   ${h}`);
  console.log(`\n4. Residual references (no FK): ${w.residual_references.length || "none"}`);
  for (const x of w.residual_references) console.log(`   ${x.table}.${x.column}: ${x.rows} row(s) mention her id`);
  for (const [t, n] of Object.entries(r.will_scrub)) console.log(`   ${t}: ${n} shared row(s) mention her id — the delete scrubs them`);
  for (const x of w.unscrubbed_references) console.log(`   ${x.table}: ${x.rows} shared row(s) STILL mention her id (should have been scrubbed)`);
  console.log(`\n5. Storage that would remain: ${w.storage.length || "none"}`);
  for (const x of w.storage) console.log(`   gs://${x.bucket}/${x.path} — ${x.why}`);
  console.log(`\n6. Blockers: ${r.blockers.payments_in_flight} payment(s) holding money${r.blockers.payments_in_flight ? " — the delete would be refused (409)" : ""}`);
  console.log(`   Receipts: ${r.receipts.length ? r.receipts.map((x) => `${x.id} ${x.status} ${x.started_at}${x.last_error ? ` (${x.last_error})` : ""}`).join("; ") : "none"}`);
  const f = r.financial_records;
  console.log(`
7. Financial records (financial_record): ledger rows naming her ${f.ledger_rows_naming_her}; payment_events payloads naming her ${f.payment_events_naming_her}${r.athlete_exists && f.payment_events_naming_her ? " (minimized by the delete)" : ""}`);
  console.log(`   checked: athlete id, ${f.identifiers_checked.deal_ids} deal id(s), ${f.identifiers_checked.connect_account_ids} Connect account id(s), ${f.identifiers_checked.brand_emails} brand email(s)`);
  if (f.unexpected_ledger_columns.length) console.log(`   UNEXPECTED ledger columns: ${f.unexpected_ledger_columns.join(", ")}`);
  if (r.notes.length) console.log(`\nNotes:\n${r.notes.map((n) => `   - ${n}`).join("\n")}`);
}

main()
  .then((code) => pool.end().then(() => process.exit(code)))
  .catch((err) => {
    console.error("verifyDeletion failed:", err);
    pool.end().finally(() => process.exit(1));
  });
