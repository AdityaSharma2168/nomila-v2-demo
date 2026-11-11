/**
 * brandBookOverrides.migration.test.ts — 0149 (her choices beside the brand book): on a database without the column it
 * leaves exactly what a shared/schema.ts push creates; the one-time carry moves a line she picked or wrote (its text is
 * not its first option) into overrides and nothing else; a re-run touches nothing; no transaction control; it is on
 * db-migrate.sh exactly once, after 0148.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0149_brand_book_overrides.sql"), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<any>(sql, params)).rows;
const columns = (pg: PGlite) => q(pg, "select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'brand_books' order by 1");

const book = (pages: unknown[]) => JSON.stringify({ contract: "brand-book/2", version: 1, generatedAt: "2026-11-01T00:00:00Z", firstName: "Test", pages });

describe("0149: her choices beside the brand book", () => {
  it("adds the column a schema push has, carries her existing choices once, and re-runs as a no-op", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec("ALTER TABLE brand_books DROP COLUMN overrides;");
    const [{ id: a }] = await q(got, "INSERT INTO athletes (full_name) VALUES ('Test Athlete A') RETURNING id");
    const [{ id: b }] = await q(got, "INSERT INTO athletes (full_name) VALUES ('Test Athlete B') RETURNING id");
    const [{ id: c }] = await q(got, "INSERT INTO athletes (full_name) VALUES ('Test Athlete C') RETURNING id");
    await got.query("INSERT INTO brand_books (athlete_id, version, status, data) VALUES ($1, 1, 'ready', $2::jsonb)", [a, book([
      { id: "cover", lines: { line: { text: "Second.", options: ["First.", "Second."] }, eyebrow: { text: "Tag", options: ["Tag", "Other"] } } },
      { id: "pillars", lines: { "pillar.0.name": { text: "Her own words", options: ["Engine name", "Her own words"] } } },
    ])]);
    await got.query("INSERT INTO brand_books (athlete_id, version, status, data) VALUES ($1, 1, 'ready', $2::jsonb)", [b, book([
      { id: "cover", lines: { line: { text: "First.", options: ["First.", "Second."] } } },
      // A malformed page with no id: skipped (a null key would abort the whole migration).
      { lines: { line: { text: "Stray.", options: ["Other."] } } },
    ])]);
    await got.query("INSERT INTO brand_books (athlete_id, version, status) VALUES ($1, 1, 'building')", [c]);

    await got.exec(FILE);
    expect(await columns(got)).toEqual(await columns(want));
    const rows = async () => Object.fromEntries((await q(got, "select athlete_id, overrides from brand_books")).map((r) => [r.athlete_id, r.overrides]));
    expect(await rows()).toEqual({
      [a]: { copy: { "cover.line": { text: "Second." }, "pillars.pillar.0.name": { text: "Her own words" } } },
      [b]: { copy: {} },
      [c]: null,
    });

    // A choice made after the carry is never overwritten by a re-run.
    await got.query(`UPDATE brand_books SET overrides = '{"copy":{"cover.line":{"text":"First.","pick":0}}}'::jsonb WHERE athlete_id = $1`, [a]);
    await got.exec(FILE);
    expect((await rows())[a]).toEqual({ copy: { "cover.line": { text: "First.", pick: 0 } } });
    await want.close(); await got.close();
  }, 120_000);

  it("carries no transaction control and never drops anything", () => {
    const body = FILE.replace(/--[^\n]*/g, "");
    expect(body).not.toMatch(/\b(DROP|RENAME|DELETE|BEGIN|COMMIT|ROLLBACK|TRUNCATE)\b/i);
  });

  it("is on db-migrate.sh exactly once, after 0148", () => {
    const sh = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
    expect(sh.match(/0149_brand_book_overrides/g)).toHaveLength(1);
    expect(sh.indexOf("0149_brand_book_overrides")).toBeGreaterThan(sh.indexOf("0148_workflow_step_lease"));
  });
});
