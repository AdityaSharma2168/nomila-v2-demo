/**
 * dropV1Tasks.migration.test.ts — 0089 drops the v1 `tasks` table, its LISTEN/NOTIFY trigger and the trigger's
 * function: applied to a database that still has all three (the shape createTriggers.ts left) it leaves exactly the
 * tables a shared/schema.ts push creates, it re-runs as a no-op (including once the table is gone), it touches no
 * other table, and it is on db-migrate.sh's list once, after 0088 — with the createTriggers step gone.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0089_drop_v1_tasks.sql"), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string) => (await pg.query<any>(sql)).rows;
const tables = (pg: PGlite) => q(pg, `select table_name from information_schema.tables where table_schema='public' order by table_name`);

/** The pre-0089 shape: the table from the old schema.ts plus what createTriggers.ts installed. */
const V1_TASKS = `
  CREATE TABLE tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), athlete_id uuid REFERENCES athletes(id), type text NOT NULL,
    status text DEFAULT 'pending', progress integer DEFAULT 0, result jsonb, error text,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    CONSTRAINT tasks_type_check CHECK (type IN ('research','deal_enrich','media_kit','brand_stories','delta_refresh')),
    CONSTRAINT tasks_status_check CHECK (status IN ('pending','running','completed','failed')));
  CREATE OR REPLACE FUNCTION notify_task_update() RETURNS TRIGGER AS $$
  BEGIN PERFORM pg_notify('task_progress', NEW.id::text); RETURN NEW; END; $$ LANGUAGE plpgsql;
  CREATE TRIGGER task_update_trigger AFTER INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION notify_task_update();`;

describe("0089: the file is the schema", () => {
  it("on a database that still has tasks + its trigger + function, leaves exactly the tables a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(V1_TASKS);
    const a = (await got.query<{ id: string }>(`INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`)).rows[0].id;
    await got.query(`INSERT INTO tasks (athlete_id, type, status) VALUES ($1, 'research', 'pending')`, [a]);
    expect((await tables(got)).some((t: any) => t.table_name === "tasks")).toBe(true);

    await got.exec(FILE);
    expect(await tables(got)).toEqual(await tables(want));
    expect(await q(got, `select 1 from pg_proc where proname = 'notify_task_update'`)).toEqual([]);
    expect(await q(got, `select 1 from pg_trigger where tgname = 'task_update_trigger'`)).toEqual([]);
    await want.close(); await got.close();
  }, 60_000);

  it("re-runs as a no-op (also on a database that never had tasks); keeps other rows; no transaction control", async () => {
    const pg = await pushed();
    await pg.exec(FILE);                        // fresh: nothing to drop
    await pg.exec(V1_TASKS);
    await pg.query(`INSERT INTO athletes (full_name) VALUES ('kept')`);
    await pg.exec(FILE);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT full_name FROM athletes`)).toEqual([{ full_name: "kept" }]);
    expect(await q(pg, `select to_regclass('public.tasks') as t`)).toEqual([{ t: null }]);

    const code = FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    expect(code).not.toMatch(/CASCADE/i);
    await pg.close();
  }, 60_000);

  it("is on db-migrate.sh's list exactly once, after 0088; the createTriggers step and script are gone", () => {
    const text = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
    const list = text.split(/\r?\n/).map((l) => l.trim());
    expect(list.filter((l) => l === "0089_drop_v1_tasks \\")).toHaveLength(1);
    expect(list.indexOf("0089_drop_v1_tasks \\")).toBeGreaterThan(list.indexOf("0088_drop_inbox_threads_score \\"));
    expect(list.filter((l) => !l.startsWith("#") && /createTriggers/.test(l))).toEqual([]);
    expect(existsSync(join(ROOT, "server", "scripts", "createTriggers.ts"))).toBe(false);
  });
});
