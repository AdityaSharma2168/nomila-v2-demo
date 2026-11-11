/**
 * inboxBodySha256.migration.test.ts — 0086 is the schema: the column the file adds equals what a shared/schema.ts
 * push creates, it re-runs as a no-op, it is additive (one nullable column, nothing else), it leaves existing rows
 * NULL, and it is on db-migrate.sh's list once, right after 0085. Also pins the fingerprint helper's definition.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";
import { bodySha256 } from "../../shared/bodyHash";
import { inboxBodyFingerprint } from "./inboxBodyFingerprint";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0086_inbox_messages_body_sha256.sql"), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string) => (await pg.query<any>(sql)).rows;
const column = (pg: PGlite) => q(pg,
  `select column_name, data_type, is_nullable, column_default from information_schema.columns
    where table_name='inbox_messages' and column_name='body_sha256'`);

describe("0086: the file is the schema", () => {
  it("adds exactly the column a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(`ALTER TABLE inbox_messages DROP COLUMN body_sha256;`);
    expect(await column(got)).toEqual([]);
    await got.exec(FILE);
    expect(await column(got)).toEqual(await column(want));
    expect(await column(got)).toEqual([{ column_name: "body_sha256", data_type: "text", is_nullable: "YES", column_default: null }]);
    await want.close(); await got.close();
  }, 60_000);

  it("re-runs as a no-op; additive only; no transaction control; existing rows stay NULL", async () => {
    const pg = await pushed();
    await pg.exec(`ALTER TABLE inbox_messages DROP COLUMN body_sha256;`);
    const a = (await pg.query<{ id: string }>(`INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`)).rows[0].id;
    const t = (await pg.query<{ id: string }>(`INSERT INTO inbox_threads (athlete_id) VALUES ($1) RETURNING id`, [a])).rows[0].id;
    await pg.query(`INSERT INTO inbox_messages (thread_id, athlete_id, direction, body) VALUES ($1, $2, 'inbound', 'hello')`, [t, a]);

    await pg.exec(FILE);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT body, body_sha256 FROM inbox_messages`)).toEqual([{ body: "hello", body_sha256: null }]);

    const code = FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    expect(code).toBe("ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS body_sha256 text;");
    await pg.close();
  }, 60_000);

  it("is on db-migrate.sh's list exactly once, right after 0085", () => {
    const list = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(list.filter((l) => l === "0086_inbox_messages_body_sha256 \\")).toHaveLength(1);
    expect(list.indexOf("0086_inbox_messages_body_sha256 \\")).toBe(list.indexOf("0085_outlook_subscriptions \\") + 1);
  });
});

describe("inboxBodyFingerprint", () => {
  it("is SHA-256 (lowercase hex) of the trimmed text; null stays null", () => {
    expect(inboxBodyFingerprint("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(inboxBodyFingerprint("  abc\r\n\r\n")).toBe(bodySha256("abc"));
    expect(inboxBodyFingerprint(null)).toBeNull();
    expect(inboxBodyFingerprint(undefined)).toBeNull();
  });
});
