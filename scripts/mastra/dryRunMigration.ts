/**
 * scripts/mastra/dryRunMigration.ts — DRY RUN of migrations/0147_mastra_engine.sql against the DEV database: the file
 * inside BEGIN … ROLLBACK (the migration dry-run rule), then what it would have created, then nothing kept.
 * Refuses any database whose name is not nomila_v2 (dev). Never prints the connection string or any secret: every
 * error goes out through redact(), which removes the URL's credentials and the password itself, wherever they appear.
 *
 *   DOTENV_PATH=<dev .env> PROXY_PORT=5440 npx tsx scripts/mastra/dryRunMigration.ts
 *
 * DATABASE_URL comes from the environment or DOTENV_PATH (default: this checkout's .env); with PROXY_PORT set, the
 * host/port are replaced by a local Cloud SQL Auth Proxy (127.0.0.1:<port>).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import dotenv from "dotenv";
import pg from "pg";
import { MASTRA_MIGRATION_FILE } from "../../server/agent/engine/mastra/ddl";

/** The connection string's password, once read (so redact() can remove it even outside a URL). */
let secret: string | null = null;

/** An error's text with every connection string's credentials and the password removed. Exported for the test. */
export function redact(text: string, password: string | null = secret): string {
  let out = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, "$1***@");
  if (password) for (const p of new Set([password, encodeURIComponent(password)])) if (p) out = out.split(p).join("***");
  return out;
}

async function main() {
  const envFile = process.env.DOTENV_PATH ?? join(process.cwd(), ".env");
  if (!process.env.DATABASE_URL && existsSync(envFile)) dotenv.config({ path: envFile, quiet: true } as dotenv.DotenvConfigOptions);
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  let url: URL;
  try { url = new URL(process.env.DATABASE_URL); } catch { throw new Error("DATABASE_URL is not a valid URL"); }  // never echo the input
  secret = url.password ? decodeURIComponent(url.password) : null;
  if (url.pathname !== "/nomila_v2") throw new Error("refusing: not the dev database nomila_v2");
  if (process.env.PROXY_PORT) { url.hostname = "127.0.0.1"; url.port = process.env.PROXY_PORT; url.searchParams.delete("host"); url.searchParams.delete("sslmode"); }
  const sql = readFileSync(join(__dirname, "..", "..", "migrations", MASTRA_MIGRATION_FILE), "utf8");
  const c = new pg.Client({ connectionString: url.toString() });
  await c.connect();
  try {
    const count = async (schema: string) => Number((await c.query(`select count(*)::int n from information_schema.tables where table_schema = $1`, [schema])).rows[0].n);
    // 0147's own columns on mila_tf_sessions (running_run_id, running_at, last_engine).
    const ours = async () => Number((await c.query(`select count(*)::int n from information_schema.columns where table_schema = 'public' and table_name = 'mila_tf_sessions' and column_name in ('running_run_id', 'running_at', 'last_engine')`)).rows[0].n);
    const before = { mastra: await count("mastra"), mastra_poc: await count("mastra_poc"), public: await count("public"), sessionColumns: await ours() };
    const t0 = Date.now();
    await c.query("BEGIN");
    await c.query(sql);
    await c.query(sql);   // re-run inside the same transaction: must be a no-op
    const inside = { mastra: await count("mastra"), mastra_poc: await count("mastra_poc"), public: await count("public"), sessionColumns: await ours() };
    await c.query("ROLLBACK");
    const after = { mastra: await count("mastra"), mastra_poc: await count("mastra_poc"), public: await count("public"), sessionColumns: await ours() };
    console.log(JSON.stringify({ mode: "dry-run (rolled back)", file: MASTRA_MIGRATION_FILE, ms: Date.now() - t0, before, inside, after }));
  } catch (e: any) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}
if (require.main === module) main().catch((e) => { console.error("FAILED", redact(String(e?.message ?? e))); process.exit(1); });
