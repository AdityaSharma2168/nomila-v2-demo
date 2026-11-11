/**
 * devDatabaseGuard.test.ts — the dev-only scripts' startup check (devDatabaseGuard.ts): only the dev database passes,
 * whatever the URL looks like. The database is faked; nothing connects.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertDevDatabase, DEV_DATABASE, isDevDatabase, NotDevDatabaseError, PROD_ACK_FLAG, ProdAckRequiredError, requireProdAck, type Queryable } from "./devDatabaseGuard";

const answering = (name: unknown): Queryable & { sql: string[] } => {
  const sql: string[] = [];
  return { sql, async query(text: string) { sql.push(text); return { rows: [{ name }] }; } };
};

test("the dev database passes, and the server is asked (not the URL)", async () => {
  const q = answering(DEV_DATABASE);
  await expect(assertDevDatabase(q, {})).resolves.toBe("nomila_v2");
  expect(q.sql).toEqual(["SELECT current_database() AS name"]);
});

test("production through the local proxy is refused, though its URL says nothing about prod", async () => {
  // postgresql://…@localhost:5441/nomila — the case the old /prod/i URL test let through.
  await expect(assertDevDatabase(answering("nomila"), { DATABASE_URL: "postgresql://u:p@localhost:5441/nomila" })).rejects.toThrow(NotDevDatabaseError);
  await expect(assertDevDatabase(answering("nomila"), {})).rejects.toThrow(/connected to database "nomila", not the dev database "nomila_v2"/);
});

test("anything that is not exactly the dev database is refused", async () => {
  for (const name of ["postgres", "nomila_v2_copy", "NOMILA_V2", "", null, undefined, 42]) {
    await expect(assertDevDatabase(answering(name), {})).rejects.toThrow(NotDevDatabaseError);
  }
});

test("NODE_ENV=production is refused before the database is asked", async () => {
  const q = answering(DEV_DATABASE);
  await expect(assertDevDatabase(q, { NODE_ENV: "production" })).rejects.toThrow(/NODE_ENV is production/);
  expect(q.sql).toEqual([]);
});

test("a database that cannot be asked is refused, never assumed dev", async () => {
  const broken: Queryable = { async query() { throw new Error("connection refused"); } };
  await expect(assertDevDatabase(broken, {})).rejects.toThrow(/could not confirm the database is dev/);
  const empty: Queryable = { async query() { return { rows: [] }; } };
  await expect(assertDevDatabase(empty, {})).rejects.toThrow(NotDevDatabaseError);
});

test("no dev-only script still guards with the URL pattern; each one calls the helper", () => {
  const root = join(__dirname, "..", "..");
  const scripts = [
    "scripts/run-agent-eval.ts",
    "server/scripts/calibration/runDirectResearch.ts",
    "server/scripts/calibration/reprocessDirectLineage.ts",
    "server/scripts/calibration/blindEval/socialBlock.ts",
    "server/scripts/calibration/seedBeta1Params.ts",
  ];
  for (const s of scripts) {
    const src = readFileSync(join(root, s), "utf8");
    expect([s, /\/prod\/i\.test\(/.test(src)]).toEqual([s, false]);
    expect([s, src.includes("assertDevDatabase(")]).toEqual([s, true]);
  }
});

// ─── Prod-capable scripts: isDevDatabase / requireProdAck ────────────────────────────────────────────────────────

test("isDevDatabase: dev only for exactly nomila_v2; never throws; unknown is not dev", async () => {
  expect(await isDevDatabase(answering("nomila_v2"))).toEqual({ dev: true, name: "nomila_v2" });
  expect(await isDevDatabase(answering("nomila"))).toEqual({ dev: false, name: "nomila" });
  expect(await isDevDatabase(answering(null))).toEqual({ dev: false, name: null });
  const broken: Queryable = { async query() { throw new Error("connection refused"); } };
  expect(await isDevDatabase(broken)).toEqual({ dev: false, name: null });
});

test("requireProdAck: production through the proxy needs the flag", async () => {
  // postgresql://…@localhost:5441/nomila — the URL guess said "not prod"; the database says "nomila".
  await expect(requireProdAck(false, answering("nomila"))).rejects.toThrow(ProdAckRequiredError);
  await expect(requireProdAck(false, answering("nomila"))).rejects.toThrow(/database "nomila".*--i-know-this-is-prod/);
  await expect(requireProdAck(false, answering("anything_else"))).rejects.toThrow(ProdAckRequiredError);
  const broken: Queryable = { async query() { throw new Error("down"); } };
  await expect(requireProdAck(false, broken)).rejects.toThrow(/could not be identified/);
});

test("requireProdAck: with the flag it never refuses (the script then does what it always did); dev needs no flag", async () => {
  await expect(requireProdAck(true, answering("nomila"))).resolves.toEqual({ dev: false, name: "nomila" });
  const broken: Queryable = { async query() { throw new Error("down"); } };
  await expect(requireProdAck(true, broken)).resolves.toEqual({ dev: false, name: null });
  await expect(requireProdAck(false, answering("nomila_v2"))).resolves.toEqual({ dev: true, name: "nomila_v2" });
  expect(PROD_ACK_FLAG).toBe("--i-know-this-is-prod");
});

test("every prod-capable script asks the database, with its own --i-know-this-is-prod flag", () => {
  const root = join(__dirname, "..", "..");
  const scripts = [
    "server/scripts/privacy/purgeJunkSamples.ts",
    "server/scripts/privacy/purgeStoredBodies.ts",
    "server/scripts/privacy/purgeExpiredFinancialRecords.ts",
    "server/scripts/security/encryptExistingTokens.ts",
    "scripts/seed-injection-fixture.ts",
  ];
  for (const s of scripts) {
    const src = readFileSync(join(root, s), "utf8");
    expect([s, /requireProdAck\(allowProd, pool/.test(src)]).toEqual([s, true]);
  }
});
