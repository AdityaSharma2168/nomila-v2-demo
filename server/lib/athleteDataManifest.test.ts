/**
 * The guard that keeps delete, export, "Your data" and Mila's memory from drifting apart: every table in
 * shared/schema.ts is either in ATHLETE_DATA_MANIFEST or in NOT_ATHLETE_DATA with a reason, every table that
 * carries an athlete id (or a foreign key into an athlete-keyed table) is in the manifest, and the manifest's
 * array order is a delete order no foreign key can trip. Pure: reads the drizzle table definitions, no database.
 */

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../shared/schema";
import {
  ATHLETE_DATA_MANIFEST, NOT_ATHLETE_DATA, DATA_CATEGORIES, ATHLETE_STORAGE_COLUMNS, SCRUBBED_REFERENCES,
  deleteOrderOf, readsFrom, manifestEntry,
} from "./athleteDataManifest";

type Config = ReturnType<typeof getTableConfig>;
const TABLES: Config[] = Object.values(schema).filter((v) => is(v as any, PgTable)).map((t) => getTableConfig(t as PgTable));
const CONFIG = new Map(TABLES.map((c) => [c.name, c]));
const MANIFEST = new Set(ATHLETE_DATA_MANIFEST.map((e) => e.name));

const fksOf = (c: Config) => c.foreignKeys.map((fk) => {
  const r = fk.reference();
  return { columns: r.columns.map((x) => x.name), parent: getTableConfig(r.foreignTable).name, onDelete: fk.onDelete ?? "no action" };
});
const ATHLETE_COLUMN = /(^|_)athlete_id$/;

describe("athlete data manifest — coverage", () => {
  it("names each table once, and each name is the drizzle table's SQL name", () => {
    expect(MANIFEST.size).toBe(ATHLETE_DATA_MANIFEST.length);
    for (const e of ATHLETE_DATA_MANIFEST) expect(getTableConfig(e.table).name).toBe(e.name);
  });

  it("classifies every table in shared/schema.ts: manifest or NOT_ATHLETE_DATA (with a reason), never both", () => {
    const unclassified = TABLES.map((c) => c.name).filter((n) => !MANIFEST.has(n) && !(n in NOT_ATHLETE_DATA));
    expect(unclassified).toEqual([]);
    expect(Object.keys(NOT_ATHLETE_DATA).filter((n) => MANIFEST.has(n))).toEqual([]);
    for (const [n, v] of Object.entries(NOT_ATHLETE_DATA)) {
      expect(CONFIG.has(n)).toBe(true);
      expect(v.reason.length).toBeGreaterThan(20);
    }
  });

  it("FAILS when a table with an athlete_id column is missing from the manifest", () => {
    const missing = TABLES.filter((c) => c.columns.some((col) => ATHLETE_COLUMN.test(col.name)) && !MANIFEST.has(c.name)).map((c) => c.name);
    expect(missing).toEqual([]);
  });

  it("FAILS when a table with a foreign key into an athlete-keyed table is missing from the manifest", () => {
    const missing = TABLES.filter((c) => fksOf(c).some((fk) => MANIFEST.has(fk.parent)) && !MANIFEST.has(c.name)).map((c) => c.name);
    expect(missing).toEqual([]);
  });

  it("puts every entry in a known category", () => {
    for (const e of ATHLETE_DATA_MANIFEST) expect(Object.keys(DATA_CATEGORIES)).toContain(e.category);
  });
});

describe("athlete data manifest — keys", () => {
  it("keys every entry by a real column (athlete column, or a column with a FK to its manifest parent)", () => {
    for (const e of ATHLETE_DATA_MANIFEST) {
      const c = CONFIG.get(e.name)!;
      const cols = new Set(c.columns.map((x) => x.name));
      if (e.key.by === "athlete_column") expect([e.name, cols.has(e.key.column)]).toEqual([e.name, true]);
      if (e.key.by === "parent") {
        const { column, parent } = e.key;
        expect(MANIFEST.has(parent)).toBe(true);
        expect([e.name, fksOf(c).some((fk) => fk.columns.length === 1 && fk.columns[0] === column && fk.parent === parent)]).toEqual([e.name, true]);
      }
    }
  });

  it("keys every table that has an athlete_id column by that column (or a custom predicate that covers it)", () => {
    for (const e of ATHLETE_DATA_MANIFEST) {
      const hasAthleteId = CONFIG.get(e.name)!.columns.some((x) => x.name === "athlete_id");
      if (hasAthleteId && e.key.by === "parent") throw new Error(`${e.name} has athlete_id but is keyed through ${e.key.parent}`);
    }
  });
});

describe("athlete data manifest — delete order", () => {
  it("deletes a child before its parent for every NO ACTION / RESTRICT / CASCADE foreign key between manifest tables", () => {
    const violations: string[] = [];
    for (const e of ATHLETE_DATA_MANIFEST) {
      for (const fk of fksOf(CONFIG.get(e.name)!)) {
        if (fk.parent === e.name || !MANIFEST.has(fk.parent) || fk.onDelete === "set null") continue;
        if (deleteOrderOf(e.name) > deleteOrderOf(fk.parent)) violations.push(`${e.name}.${fk.columns.join(",")} → ${fk.parent} (${fk.onDelete})`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("deletes an entry before every table its predicate reads", () => {
    const violations: string[] = [];
    for (const e of ATHLETE_DATA_MANIFEST) {
      for (const dep of readsFrom(e)) {
        manifestEntry(dep);
        if (deleteOrderOf(e.name) >= deleteOrderOf(dep) && dep !== e.name) violations.push(`${e.name} reads ${dep}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("athlete data manifest — export + retention", () => {
  it("never exports a secret column", () => {
    // A column named token (push_devices.token) or ending _token, and a jsonb column that carries device credentials
    // (push_sends.tickets: Expo ticket ids keyed to phones), as well as anything named secret / password.
    const SECRET = /(^|_)token$|secret|password|client_state_hash|^tickets$/;
    for (const e of ATHLETE_DATA_MANIFEST) {
      const secrets = CONFIG.get(e.name)!.columns.map((x) => x.name).filter((n) => SECRET.test(n));
      const r = e.export;
      const exported = r.mode === "none" ? [] : r.mode === "references" ? r.columns : secrets.filter((n) => !(r.omit ?? []).includes(n));
      expect([e.name, exported.filter((n) => SECRET.test(n))]).toEqual([e.name, []]);
    }
  });

  it("names only real columns in omit / references, and gives every non-row export a reason", () => {
    for (const e of ATHLETE_DATA_MANIFEST) {
      const cols = new Set(CONFIG.get(e.name)!.columns.map((x) => x.name));
      const r = e.export;
      const named = r.mode === "rows" ? r.omit ?? [] : r.mode === "references" ? r.columns : [];
      expect([e.name, named.filter((n) => !cols.has(n))]).toEqual([e.name, []]);
      if (r.mode !== "rows") expect(r.why.length).toBeGreaterThan(10);
    }
  });

  it("exports no stored email text (inbox_messages is references-only, thread subjects and sender names omitted)", () => {
    const m = manifestEntry("inbox_messages").export;
    expect(m.mode).toBe("references");
    if (m.mode === "references") for (const c of ["subject", "body", "sender_email", "sender_name", "attachments"]) expect(m.columns).not.toContain(c);
    const t = manifestEntry("inbox_threads").export;
    expect(t.mode === "rows" && t.omit).toContain("subject");
  });

  it("justifies anything kept", () => {
    for (const e of ATHLETE_DATA_MANIFEST) if (e.retention === "keep") expect(e.keptBecause?.length ?? 0).toBeGreaterThan(20);
  });

  it("points every storage column at a manifest table's real column", () => {
    for (const s of ATHLETE_STORAGE_COLUMNS) {
      expect(MANIFEST.has(s.table)).toBe(true);
      expect(CONFIG.get(s.table)!.columns.map((x) => x.name)).toContain(s.column);
    }
  });
});

describe("athlete data manifest — financial records", () => {
  it("keeps nothing indefinitely: every NOT_ATHLETE_DATA table is shared, a financial_record or a deletion_record", () => {
    for (const [n, v] of Object.entries(NOT_ATHLETE_DATA)) expect([n, ["shared", "financial_record", "deletion_record"].includes(v.retention)]).toEqual([n, true]);
    expect(NOT_ATHLETE_DATA.payment_events.retention).toBe("financial_record");
    expect(NOT_ATHLETE_DATA.financial_ledger_records.retention).toBe("financial_record");
    // Only the deletion ledger is a deletion_record, and it has no athlete column.
    expect(Object.entries(NOT_ATHLETE_DATA).filter(([, v]) => v.retention === "deletion_record").map(([n]) => n)).toEqual(["account_deletion_items"]);
  });

  it("financial_ledger_records has exactly the de-identified columns and no foreign key", () => {
    const c = CONFIG.get("financial_ledger_records")!;
    expect(c.columns.map((x) => x.name).sort()).toEqual([
      "brand_total_cents", "commission_cents", "currency", "deal_value_cents", "deidentified_at", "id", "kind",
      "payment_created_at", "processing_fee_cents", "refunded_cents", "retention_category", "status",
      "stripe_charge_id", "stripe_dispute_id", "stripe_payment_intent_id", "stripe_refund_id", "stripe_transfer_id",
      "stripe_transfer_reversal_id",
    ]);
    expect(c.foreignKeys).toEqual([]);
  });
});

describe("athlete data manifest — scrubbed shared rows", () => {
  it("scrubs only NOT_ATHLETE_DATA tables, by real jsonb columns", () => {
    for (const ref of SCRUBBED_REFERENCES) {
      expect(ref.table in NOT_ATHLETE_DATA).toBe(true);
      const cols = new Map(CONFIG.get(ref.table)!.columns.map((c) => [c.name, c.getSQLType()]));
      for (const c of ref.columns) expect([ref.table, c, cols.get(c)]).toEqual([ref.table, c, "jsonb"]);
      if (ref.dropArrayEntries) expect(ref.columns).toContain(ref.dropArrayEntries.column);
    }
    expect(SCRUBBED_REFERENCES.map((r) => r.table)).toContain("research_planner_runs");
  });
});
