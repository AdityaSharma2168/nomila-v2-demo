/**
 * dealsSignedAt.migration.test.ts — 0094 adds deals.signed_at / signed_source (+ CHECK) and two receipt verbs:
 * applied to a database without them it leaves exactly what a shared/schema.ts push creates, re-runs as a no-op,
 * keeps every row, only widens agent_actions verbs, and is on db-migrate.sh's list once, after 0090.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0094_deals_signed_at.sql"), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string) => (await pg.query<any>(sql)).rows;
const columns = (pg: PGlite, table: string) => q(pg,
  `select column_name, data_type, is_nullable from information_schema.columns where table_name='${table}' order by column_name`);
const checks = (pg: PGlite, table: string) => q(pg,
  `select conname, pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_class t on t.oid = c.conrelid where t.relname='${table}' and c.contype='c' order by conname`);

/** The pre-0094 shape: no signed columns, the old verb list. */
async function pre(pg: PGlite) {
  await pg.exec(`ALTER TABLE deals DROP CONSTRAINT deals_signed_check; ALTER TABLE deals DROP COLUMN signed_at; ALTER TABLE deals DROP COLUMN signed_source;
    ALTER TABLE agent_actions DROP CONSTRAINT agent_actions_action_check;
    ALTER TABLE agent_actions ADD CONSTRAINT agent_actions_action_check CHECK (action IN ('file','auto_decline','reclassify','mute_sender','reopen','auto_archive','profile_write'));`);
}

describe("0094: the file is the schema", () => {
  it("leaves exactly the columns and checks a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await pre(got);
    await got.exec(FILE);
    expect(await columns(got, "deals")).toEqual(await columns(want, "deals"));
    expect(await checks(got, "deals")).toEqual(await checks(want, "deals"));
    expect(await checks(got, "agent_actions")).toEqual(await checks(want, "agent_actions"));
    await want.close(); await got.close();
  }, 60_000);

  it("re-runs as a no-op, keeps rows, enforces signed_at ⇔ signed_source, and accepts the new verbs", async () => {
    const pg = await pushed();
    await pre(pg);
    const a = (await pg.query<{ id: string }>(`INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`)).rows[0].id;
    await pg.query(`INSERT INTO deals (athlete_id, brand_name, status) VALUES ($1, 'kept', 'accepted')`, [a]);
    await pg.query(`INSERT INTO agent_actions (athlete_id, action) VALUES ($1, 'auto_archive')`, [a]);
    await pg.exec(FILE);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT brand_name, status, signed_at, signed_source FROM deals`)).toEqual([{ brand_name: "kept", status: "accepted", signed_at: null, signed_source: null }]);
    await expect(pg.query(`UPDATE deals SET signed_at = now()`)).rejects.toThrow();
    await expect(pg.query(`UPDATE deals SET signed_at = now(), signed_source = 'model'`)).rejects.toThrow();
    await pg.query(`UPDATE deals SET signed_at = now(), signed_source = 'confirmed'`);
    await pg.query(`INSERT INTO agent_actions (athlete_id, action) VALUES ($1, 'confirm_signed'), ($1, 'split_deal')`, [a]);
    expect((await q(pg, `SELECT count(*)::int AS n FROM agent_actions`))[0].n).toBe(3);
    const code = FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK)\b/i);
    await pg.close();
  }, 60_000);

  it("is on db-migrate.sh's list exactly once, after 0090", () => {
    const list = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(list.filter((l) => l === "0094_deals_signed_at \\")).toHaveLength(1);
    expect(list.indexOf("0094_deals_signed_at \\")).toBeGreaterThan(list.indexOf("0090_drop_onboarding_sessions_brand_api_keys \\"));
  });
});
