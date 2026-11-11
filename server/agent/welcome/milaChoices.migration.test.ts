/**
 * milaChoices.migration.test.ts — 0146 (what each athlete chose per Mila capability): on a database without its tables
 * it leaves exactly what a shared/schema.ts push creates, it re-runs as a no-op, it is additive only with no transaction
 * control and writes no rows, the expression index makes an athlete-wide (NULL account) choice unique too, deleting the
 * athlete takes the choices and their history, and it is on db-migrate.sh once, in number order (after 0145, before 0147).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0146_mila_choices.sql"), "utf8");
const TABLES = "('mila_choices','mila_choice_history')";

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<any>(sql, params)).rows;
const shape = async (pg: PGlite) => ({
  columns: await q(pg, `select table_name, column_name, data_type, udt_name, is_nullable, column_default from information_schema.columns
    where table_name in ${TABLES} order by 1, 2`),
  constraints: await q(pg, `select conrelid::regclass::text as t, conname, contype, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text in ${TABLES} order by 1, 2`),
  indexes: await q(pg, `select tablename, indexname, indexdef from pg_indexes where tablename in ${TABLES} order by 1, 2`),
});

describe("0146: the file is the schema", () => {
  it("on a database without them, leaves exactly what a schema.ts push creates; re-runs as a no-op", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec("DROP TABLE mila_choice_history; DROP TABLE mila_choices;");
    await got.exec(FILE);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    expect(await q(got, `select (select count(*) from mila_choices)::int as c, (select count(*) from mila_choice_history)::int as h`)).toEqual([{ c: 0, h: 0 }]);
    await want.close(); await got.close();
  }, 120_000);

  it("one choice per (athlete, capability, account) — NULL account included; the checks hold; deleting the athlete takes it all", async () => {
    const pg = await pushed();
    const a = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`))[0].id;
    const b = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Other') RETURNING id`))[0].id;
    const ins = (athlete: string, cap: string, acct: string | null, scope = acct ? "per_account" : "athlete", state = "never") =>
      q(pg, `INSERT INTO mila_choices (athlete_id, capability, account_ref, scope, state, via) VALUES ($1, $2, $3, $4, $5, 'me') RETURNING id`, [athlete, cap, acct, scope, state]);
    const [c] = await ins(a, "post_ideas", null);
    await expect(ins(a, "post_ideas", null)).rejects.toThrow();                     // NULL account is still one key
    await ins(b, "post_ideas", null);                                               // another athlete
    await ins(a, "draft_replies", "acct-1");
    await expect(ins(a, "draft_replies", "acct-1")).rejects.toThrow();
    await ins(a, "draft_replies", "acct-2");                                        // another account
    await expect(ins(a, "x", null, "athlete", "maybe")).rejects.toThrow();          // unknown state
    await expect(ins(a, "y", null, "per_account")).rejects.toThrow();               // per-account without an account
    await expect(ins(a, "z", null, "athlete", "enabled")).rejects.toThrow();        // a yes without its consent copy
    await q(pg, `INSERT INTO mila_choice_history (choice_id, athlete_id, capability, version, to_state, via, not_now_count) VALUES ($1, $2, 'post_ideas', 1, 'never', 'me', 0)`, [c.id, a]);
    await expect(q(pg, `INSERT INTO mila_choice_history (choice_id, athlete_id, capability, version, to_state, via, not_now_count) VALUES ($1, $2, 'post_ideas', 1, 'never', 'me', 0)`, [c.id, a])).rejects.toThrow();
    await q(pg, `DELETE FROM athletes WHERE id = $1`, [a]);
    expect(await q(pg, `select (select count(*) from mila_choices)::int as c, (select count(*) from mila_choice_history)::int as h`)).toEqual([{ c: 1, h: 0 }]);
    await pg.close();
  }, 120_000);

  it("is additive only, writes no rows and carries no transaction control", () => {
    const body = FILE.replace(/--[^\n]*/g, "").replace(/ON DELETE CASCADE/g, "");
    expect(body).not.toMatch(/\b(DROP|RENAME|UPDATE|DELETE|INSERT|BEGIN|COMMIT|ROLLBACK|ALTER|DO)\b/i);
  });

  it("is on db-migrate.sh exactly once, in number order (after 0145, before 0147)", () => {
    const sh = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
    expect(sh.match(/0146_mila_choices/g)).toHaveLength(1);
    expect(sh.indexOf("0146_mila_choices")).toBeGreaterThan(sh.indexOf("0145_account_deletion_two_phase"));
    expect(sh.indexOf("0146_mila_choices")).toBeLessThan(sh.indexOf("0147_mastra_engine"));
  });
});
