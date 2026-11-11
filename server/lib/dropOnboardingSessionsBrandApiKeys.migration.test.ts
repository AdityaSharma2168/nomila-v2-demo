/**
 * dropOnboardingSessionsBrandApiKeys.migration.test.ts — 0090 drops the dead v1 tables onboarding_sessions and
 * brand_api_keys: applied to a database that still has both (the pre-0090 schema.ts shape) it leaves exactly the
 * tables a shared/schema.ts push creates, it re-runs as a no-op, it touches nothing else, and it is on
 * db-migrate.sh's list once, after 0088.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const NAME = "0090_drop_onboarding_sessions_brand_api_keys";
const FILE = readFileSync(join(ROOT, "migrations", `${NAME}.sql`), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string) => (await pg.query<any>(sql)).rows;
const tables = (pg: PGlite) => q(pg, `select table_name from information_schema.tables where table_schema='public' order by table_name`);

/** The pre-0090 shape, as the old shared/schema.ts declared both tables. */
const V1 = `
  CREATE TABLE onboarding_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), athlete_id uuid NOT NULL REFERENCES athletes(id),
    agent_type text NOT NULL, phase text NOT NULL, state jsonb NOT NULL, conversation_history jsonb,
    is_complete boolean DEFAULT false, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    expires_at timestamptz DEFAULT NOW() + INTERVAL '48 hours',
    CONSTRAINT onboarding_agent_type_check CHECK (agent_type IN ('onboarding','brand_story')));
  CREATE UNIQUE INDEX idx_onboarding_athlete_agent ON onboarding_sessions (athlete_id, agent_type);
  CREATE TABLE brand_api_keys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text NOT NULL UNIQUE, brand_id uuid NOT NULL,
    brand_name text NOT NULL, permissions jsonb NOT NULL DEFAULT '[]'::jsonb, rate_limit integer DEFAULT 60,
    webhook_url text, created_at timestamptz DEFAULT now());`;

describe("0090: the file is the schema", () => {
  it("on a database that still has both tables, leaves exactly the tables a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(V1);
    const a = (await got.query<{ id: string }>(`INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`)).rows[0].id;
    await got.query(`INSERT INTO onboarding_sessions (athlete_id, agent_type, phase, state) VALUES ($1, 'onboarding', 'start', '{}')`, [a]);
    await got.exec(FILE);
    expect(await tables(got)).toEqual(await tables(want));
    await want.close(); await got.close();
  }, 60_000);

  it("re-runs as a no-op (also on a database that never had them); keeps other rows; no CASCADE, no transaction control", async () => {
    const pg = await pushed();
    await pg.exec(FILE);
    await pg.exec(V1);
    await pg.query(`INSERT INTO athletes (full_name) VALUES ('kept')`);
    await pg.exec(FILE);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT full_name FROM athletes`)).toEqual([{ full_name: "kept" }]);

    const code = FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    expect(code).toBe("DROP TABLE IF EXISTS onboarding_sessions;\nDROP TABLE IF EXISTS brand_api_keys;");
    await pg.close();
  }, 60_000);

  it("is on db-migrate.sh's list exactly once, after 0088", () => {
    const list = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    const line = NAME + " \\";
    expect(list.filter((l) => l === line)).toHaveLength(1);
    expect(list.indexOf(line)).toBeGreaterThan(list.indexOf("0088_drop_inbox_threads_score \\"));
  });
});
