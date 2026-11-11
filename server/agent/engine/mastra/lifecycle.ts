/**
 * agent/engine/mastra/lifecycle.ts — an athlete's Mastra footprint, counted, deleted (account deletion phase 2:
 * services/privacy/accountDeletionSteps.ts purge_rows and verify) and exported (services/privacy/exportMastraData.ts),
 * all from the SAME athlete→thread mapping (athleteFootprintByTable).
 *
 * Mastra has no "delete resource" API, and its rows live in its own schema (MILA_MASTRA_SCHEMA, 0147), outside our
 * manifest. So this is plain SQL, without loading Mastra: every table in that schema with a resource column
 * ("resourceId" / "resource_id") is scoped where it names the athlete, every table with a thread column
 * ("threadId" / "thread_id") where it names one of their threads (Mastra's threads whose resource is the athlete, and
 * every one of OUR session row ids for them, since a Mastra thread id is a session row id), and mastra_threads /
 * mastra_resources rows by id. The tables are discovered from information_schema on each call, so a table a future
 * Mastra migration adds WITH a resource / thread column is covered (deleted, counted, exported) without a code change.
 * A table with neither column is invisible to this sweep: it must be on MASTRA_NOT_ATHLETE_TABLES below, with a reason,
 * or the schema guard (mastraSchemaGuard.migration.test.ts) fails. A database without the schema (before 0147) has
 * nothing.
 *
 * INVARIANT the sweep's OR-match relies on: Mastra never holds a row whose resource and thread belong to different
 * athletes. We keep it true from our side (agent/engine/mastra/guards.ts: a thread id is always one of the athlete's
 * own session row ids, a Mastra thread naming another resource is refused, input is text so no foreign message id
 * reaches Mastra; mastra#26216). The export does not rely on it: it matches exclusively (athleteFootprintByTable
 * { exclusive }), so even a violating row is deleted with her thread but never exported to her.
 *
 * Thread ids are collected BEFORE anything is deleted, and from our mila_tf_sessions too, so a delete sweep must run
 * before the manifest purge removes those rows (purge_rows calls it first; verify calls it again for stragglers).
 */
import { sql } from "drizzle-orm";
import { db } from "../../../db";
import { MASTRA } from "../config";

export const RESOURCE_COLS = ["resourceId", "resource_id"];
export const THREAD_COLS = ["threadId", "thread_id"];
const rowsOf = <T>(r: unknown): T[] => ((r as any)?.rows ?? r) as T[];

export async function schemaExists(schema: string): Promise<boolean> {
  const [r] = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = ${schema}`));
  return Number(r?.n ?? 0) > 0;
}

export async function keyedColumns(schema: string) {
  return rowsOf<{ table_name: string; column_name: string }>(await db.execute(sql`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = ${schema} AND column_name IN ('resourceId', 'resource_id', 'threadId', 'thread_id')
    ORDER BY table_name, column_name
  `));
}

/**
 * A schema / table name from information_schema, as a quoted identifier. drizzle's sql.identifier wraps a name in
 * double quotes WITHOUT escaping one inside it, so a discovered name is only used when it is a plain identifier; any
 * other name throws (loudly: a delete or an export must never silently skip a table, nor run text it did not mean).
 */
const PLAIN_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function safeIdent(name: string) {
  if (!PLAIN_IDENT.test(name)) throw new Error(`Mastra lifecycle: refusing a non-plain identifier ${JSON.stringify(name)}`);
  return sql.identifier(name);
}

/**
 * Their thread ids: Mastra's threads naming them, plus every session row of theirs (a thread id is a row id).
 * `exclusive` (the export): a session row id whose Mastra thread names ANOTHER resource is left out, since that
 * thread's rows are not provably theirs. The delete sweep keeps it (anything in a thread keyed by their session goes).
 */
export async function threadIds(schema: string, athleteId: string, exclusive = false): Promise<string[]> {
  const t = safeIdent(schema);
  const mastra = rowsOf<{ id: string }>(await db.execute(sql`SELECT id FROM ${t}.mastra_threads WHERE "resourceId" = ${athleteId}`));
  const ours = rowsOf<{ id: string }>(await db.execute(exclusive
    ? sql`SELECT s.id::text AS id FROM mila_tf_sessions s WHERE s.athlete_id = ${athleteId}::uuid
            AND NOT EXISTS (SELECT 1 FROM ${t}.mastra_threads m WHERE m.id = s.id::text AND m."resourceId" IS DISTINCT FROM ${athleteId})`
    : sql`SELECT id::text AS id FROM mila_tf_sessions WHERE athlete_id = ${athleteId}::uuid`));
  return [...new Set([...mastra, ...ours].map((r) => r.id))];
}

/**
 * Their condition per table, plus mastra_threads (by id) and mastra_resources (by id, even though it has neither
 * column). Every table with a resource / thread column is listed (with no condition when none applies). Shared by
 * sweep() (count / delete) and the export. Caller must have already confirmed the schema exists.
 *
 *   sweep (default)  a row matches on ANY of its resource / thread columns (OR): delete everything in their threads.
 *   exclusive        (the export) a row matches when a resource column names them, or it is in one of their threads
 *                    AND none of its resource columns names someone else; the threads are threadIds(exclusive). So a
 *                    row Mastra attributes to another athlete is never exported, even inside their thread.
 */
export async function athleteFootprintByTable(
  schema: string, athleteId: string, opts: { exclusive?: boolean } = {},
): Promise<Map<string, ReturnType<typeof sql>[]>> {
  const exclusive = !!opts.exclusive;
  const threads = await threadIds(schema, athleteId, exclusive);
  const threadList = threads.length ? sql.join(threads.map((id) => sql`${id}`), sql`, `) : null;
  const cols = new Map<string, { res: string[]; thr: string[] }>();
  for (const { table_name, column_name } of await keyedColumns(schema)) {
    safeIdent(table_name);
    const c = cols.get(table_name) ?? { res: [], thr: [] };
    if (RESOURCE_COLS.includes(column_name)) c.res.push(column_name);
    else if (THREAD_COLS.includes(column_name)) c.thr.push(column_name);
    cols.set(table_name, c);
  }
  const resIs = (c: string) => sql`${sql.identifier(c)}::text = ${athleteId}`;
  const thrIn = (c: string) => sql`${sql.identifier(c)}::text IN (${threadList!})`;
  const byTable = new Map<string, ReturnType<typeof sql>[]>();
  for (const [table, c] of cols) {
    // mastra_threads' own id is a thread id.
    const thr = table === "mastra_threads" ? [...c.thr, "id"] : c.thr;
    const conds: ReturnType<typeof sql>[] = c.res.map(resIs);
    if (threadList && thr.length) {
      if (!exclusive) conds.push(...thr.map(thrIn));
      else {
        const inThread = sql`(${sql.join(thr.map(thrIn), sql` OR `)})`;
        const noneOther = c.res.map((r) => sql`(${sql.identifier(r)} IS NULL OR ${resIs(r)})`);
        conds.push(noneOther.length ? sql`(${inThread} AND ${sql.join(noneOther, sql` AND `)})` : inThread);
      }
    }
    byTable.set(table, conds);
  }
  if (!cols.has("mastra_threads") && threadList) byTable.set("mastra_threads", [thrIn("id")]);
  byTable.set("mastra_resources", [...(byTable.get("mastra_resources") ?? []), sql`id = ${athleteId}`]);
  return byTable;
}

/**
 * Every table in Mastra's schema with NO resource / thread column, and why none of its rows is an athlete's data in
 * Nomila. The sweep cannot see these tables, so each is classified here; the schema guard test fails on any table that
 * is neither keyed nor listed (a new Mastra table must be classified before it reaches main), and on a listed table
 * that gains a key or disappears. "unused" means Nomila never enables the feature that writes it (runtime.ts: memory
 * is history only; no Mastra server, Studio, knowledge, evals, channels or schedules); if one is ever enabled, its
 * tables must be keyed to her first (e.g. knowledge records carry sourceThreadId) and removed from this list.
 */
const UNUSED = (what: string) => `Mastra ${what}: Nomila never enables it, so it holds no rows; would need keying to her before use.`;
const CONFIG = (what: string) => `Engine configuration (${what}), written only by Mastra's server / Studio, which Nomila never mounts; not about any athlete.`;
const LEASE = "Run coordination (run id, generation, owner process, lease time): no content, no athlete.";
export const MASTRA_NOT_ATHLETE_TABLES: Readonly<Record<string, string>> = {
  mastra_memory_run_fences: LEASE,
  mastra_workflow_run_owners: LEASE,
  mastra_knowledge_nodes: UNUSED("knowledge graph"),
  mastra_knowledge_records: UNUSED("knowledge graph (records carry sourceThreadId)"),
  mastra_knowledge_mentions: UNUSED("knowledge graph"),
  mastra_knowledge_node_scopes: UNUSED("knowledge graph"),
  mastra_knowledge_record_scopes: UNUSED("knowledge graph"),
  mastra_knowledge_scope_grants: UNUSED("knowledge graph"),
  mastra_knowledge_access_state: UNUSED("knowledge graph (access epoch counter)"),
  mastra_knowledge_scope_addresses: UNUSED("knowledge graph"),
  mastra_knowledge_node_addresses: UNUSED("knowledge graph"),
  mastra_knowledge_import_state: UNUSED("knowledge importers"),
  mastra_knowledge_import_runs: UNUSED("knowledge importers (runs carry transcriptThreadId)"),
  mastra_knowledge_proposals: UNUSED("knowledge proposals"),
  mastra_knowledge_activity: UNUSED("knowledge activity log (carries sourceThreadId)"),
  mastra_knowledge_semantic_outbox: UNUSED("knowledge semantic-index outbox"),
  mastra_scorer_definitions: CONFIG("scorer definitions"),
  mastra_scorer_definition_versions: CONFIG("scorer definition versions"),
  mastra_prompt_blocks: CONFIG("prompt blocks"),
  mastra_prompt_block_versions: CONFIG("prompt block versions"),
  mastra_agents: CONFIG("stored agents; Mila is defined in code"),
  mastra_agent_versions: CONFIG("stored agent versions"),
  mastra_mcp_clients: CONFIG("MCP clients"),
  mastra_mcp_client_versions: CONFIG("MCP client versions"),
  mastra_mcp_servers: CONFIG("MCP servers"),
  mastra_mcp_server_versions: CONFIG("MCP server versions"),
  mastra_workspaces: CONFIG("workspaces"),
  mastra_workspace_versions: CONFIG("workspace versions"),
  mastra_skills: CONFIG("stored skills; Mila's playbooks are in code"),
  mastra_skill_versions: CONFIG("stored skill versions"),
  mastra_skill_blobs: CONFIG("stored skill files"),
  mastra_tool_provider_connections: CONFIG("tool-provider connections"),
  mastra_workflow_definitions: CONFIG("stored workflow definitions"),
  mastra_channel_installations: CONFIG("channel installations"),
  mastra_channel_config: CONFIG("channel config"),
  mastra_favorites: CONFIG("Studio users' favourites"),
  mastra_datasets: UNUSED("eval datasets"),
  mastra_dataset_items: UNUSED("eval dataset items"),
  mastra_dataset_versions: UNUSED("eval dataset versions"),
  mastra_experiments: UNUSED("eval experiments"),
  mastra_experiment_results: UNUSED("eval experiment results"),
  mastra_schedules: UNUSED("schedules"),
  mastra_schedule_triggers: UNUSED("schedule triggers"),
};

type Op = "count" | "delete";

async function sweep(op: Op, athleteId: string, schema: string): Promise<Record<string, number>> {
  if (!(await schemaExists(schema))) return {};
  const out: Record<string, number> = {};
  const add = (k: string, n: number) => { if (n > 0) out[k] = (out[k] ?? 0) + n; };
  const run = async (table: string, where: ReturnType<typeof sql>) => {
    const target = sql`${safeIdent(schema)}.${safeIdent(table)}`;
    const [r] = rowsOf<{ n: number }>(await db.execute(op === "count"
      ? sql`SELECT count(*)::int AS n FROM ${target} WHERE ${where}`
      : sql`WITH d AS (DELETE FROM ${target} WHERE ${where} RETURNING 1) SELECT count(*)::int AS n FROM d`));
    add(table, Number(r?.n ?? 0));
  };
  const byTable = await athleteFootprintByTable(schema, athleteId);
  for (const [table, conds] of byTable) if (conds.length) await run(table, sql.join(conds, sql` OR `));
  return out;
}

/** Rows of theirs in Mastra's schema, per table (non-zero only). */
export function countMastraFootprint(athleteId: string, schema = MASTRA.schema): Promise<Record<string, number>> {
  return sweep("count", athleteId, schema);
}

/** Delete every row of theirs in Mastra's schema. Idempotent. Returns rows deleted per table (non-zero only). */
export function deleteMastraFootprint(athleteId: string, schema = MASTRA.schema): Promise<Record<string, number>> {
  return sweep("delete", athleteId, schema);
}
