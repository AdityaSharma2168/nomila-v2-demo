/**
 * exportMastraData.ts — the athlete's Mastra engine footprint added to her data export (owner-approved B2, 3 Nov
 * 2026), alongside the manifest's tables (exportAthleteData.ts). Mastra's rows are NOT a manifest table
 * (athleteDataManifest.ts's EXTERNAL_STORES note on the Mastra engine store): they live in their own Postgres schema
 * (MILA_MASTRA_SCHEMA, migrations/0147_mastra_engine.sql), keyed by thread / resource ids, not an athlete_id column.
 *
 * So this reads the SAME athlete→thread mapping account deletion purges them by (engine/mastra/lifecycle.ts
 * athleteFootprintByTable: a Mastra thread id is one of her mila_tf_sessions row ids; resource = her athlete id), and
 * the SAME dynamic table discovery (information_schema), so a table a future Mastra migration adds — her chat
 * threads and messages, working memory (mastra_resources.workingMemory) and observational memory, though both are
 * off by policy today (agent/engine/config.ts) — is exported without a code change. That automatic coverage is for tables keyed by resource or thread id; a
 * table with neither is classified by hand (lifecycle.ts MASTRA_NOT_ATHLETE_TABLES, enforced by the schema guard test). Tables
 * Mastra ships but Nomila never uses (its own tracing, scorers, workflows, notifications …) are discovered the same
 * way and simply come back empty: harmless, and consistent with what account deletion already sweeps.
 *
 * A database that predates 0147 (prod today) has no "mastra" schema: `present: false` and a plain note; nothing else
 * is read.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { MASTRA } from "../../agent/engine/config";
import { athleteFootprintByTable, safeIdent, schemaExists } from "../../agent/engine/mastra/lifecycle";

const rowsOf = <T>(r: unknown): T[] => ((r as any)?.rows ?? r) as T[];

export interface MastraExportTable {
  mode: "rows";
  count: number;
  rows: Record<string, unknown>[];
}

export interface MastraExport {
  schema: string;
  present: boolean;
  note?: string;
  tables: Record<string, MastraExportTable>;
}

/**
 * `present: false` (and a note) when Mastra's schema is not in this database.
 * SIZE: whole rows (SELECT *), unbounded and built in memory, the same as the manifest export it sits in. Fine for
 * dev-only Mastra today; FOLLOW-UP before a heavy user or prod: stream the whole export document (manifest included)
 * instead of a per-table cap, since a cap would truncate her right-of-access copy.
 */
export async function buildMastraExport(athleteId: string, schema: string = MASTRA.schema): Promise<MastraExport> {
  if (!(await schemaExists(schema))) {
    return {
      schema,
      present: false,
      note: `No "${schema}" schema in this database (migrations/0147_mastra_engine.sql has not run here, e.g. production today, or Mila's never run on the Mastra engine): nothing to export.`,
      tables: {},
    };
  }

  // exclusive: a row in her thread that Mastra attributes to another athlete is not hers to receive (the delete sweep
  // still removes it with her thread).
  const byTable = await athleteFootprintByTable(schema, athleteId, { exclusive: true });
  const tables: Record<string, MastraExportTable> = {};
  for (const table of [...byTable.keys()].sort()) {
    const conds = byTable.get(table)!;
    const target = sql`${safeIdent(schema)}.${safeIdent(table)}`;
    const rows = conds.length
      ? rowsOf<Record<string, unknown>>(await db.execute(sql`SELECT * FROM ${target} WHERE ${sql.join(conds, sql` OR `)}`))
      : [];
    tables[table] = { mode: "rows", count: rows.length, rows };
  }
  return { schema, present: true, tables };
}
