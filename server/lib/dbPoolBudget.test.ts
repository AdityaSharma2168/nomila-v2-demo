/**
 * dbPoolBudget.test.ts — the Cloud SQL connection budget of each Cloud Run service, read from its YAML:
 *
 *   maxScale × (DB_POOL_MAX + MILA_MASTRA_POOL_MAX) ≤ the instance's cap
 *
 * The two pools are the only pg pools the server opens: the app pool (server/db.ts, DB_POOL_MAX; the workflow runner,
 * the crons, the minute ticks and pgAdvisoryLock all borrow from it) and Mastra's PostgresStore pool
 * (server/agent/engine/mastra/runtime.ts, MILA_MASTRA_POOL_MAX, built lazily on the first Mila turn). Mastra's
 * pool is counted whether or not Mastra is on, so switching the engine flag on the live service can never overrun the
 * instance.
 *
 * The caps (max_connections − 3 superuser-reserved − 2 for the deploy-time migrate proxy):
 *   prod nomila-prod-db  db-g1-small, no flags → max_connections 50 → cap 45.  4 × (7 + 4) = 44.
 *   dev  nomila-v2-db    db-g1-small, max_connections=100 (flag) → cap 95.   3 × (5 + 4) = 27.
 * Raising max_connections restarts the instance: change the flag first, then the cap here, then the pools.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { MASTRA_POOL_MAX_DEFAULT } from "../agent/engine/config";

const ROOT = join(__dirname, "..", "..");

/** The default DB_POOL_MAX server/db.ts uses on Cloud Run when the env is unset (prod 10, dev 5). */
const DB_POOL_FALLBACK = { prod: 10, dev: 5 } as const;

const SERVICES = [
  { file: "cloud-run-prod.yaml", env: "prod", cap: 45 },
  { file: "cloud-run-dev.yaml", env: "dev", cap: 95 },
] as const;

interface Budget { maxScale: number; dbPool: number; mastraPool: number; total: number }

function budgetOf(file: string, env: "prod" | "dev"): Budget {
  const svc = parse(readFileSync(join(ROOT, "gcp", file), "utf8"));
  const tmpl = svc.spec.template;
  const maxScale = Number(tmpl.metadata.annotations["autoscaling.knative.dev/maxScale"]);
  const vars = new Map<string, string>();
  for (const c of tmpl.spec.containers) for (const e of c.env ?? []) if (typeof e.value === "string") vars.set(e.name, e.value);
  const num = (name: string, fallback: number) => (vars.has(name) ? Number(vars.get(name)) : fallback);
  const dbPool = num("DB_POOL_MAX", DB_POOL_FALLBACK[env]);
  const mastraPool = num("MILA_MASTRA_POOL_MAX", MASTRA_POOL_MAX_DEFAULT);
  return { maxScale, dbPool, mastraPool, total: maxScale * (dbPool + mastraPool) };
}

describe("Cloud SQL connection budget", () => {
  it.each(SERVICES)("$file: maxScale × (DB_POOL_MAX + MILA_MASTRA_POOL_MAX) ≤ $cap", ({ file, env, cap }) => {
    const b = budgetOf(file, env);
    for (const n of [b.maxScale, b.dbPool, b.mastraPool]) expect(Number.isInteger(n) && n > 0).toBe(true);
    expect(b.total).toBeLessThanOrEqual(cap);
  });

  it("pins today's arithmetic (change it on purpose, with the instance's limit in view)", () => {
    expect(budgetOf("cloud-run-prod.yaml", "prod")).toEqual({ maxScale: 4, dbPool: 7, mastraPool: 4, total: 44 });
    expect(budgetOf("cloud-run-dev.yaml", "dev")).toEqual({ maxScale: 3, dbPool: 5, mastraPool: 4, total: 27 });
  });
});

describe("MILA_MASTRA_POOL_MAX", () => {
  const saved = process.env.MILA_MASTRA_POOL_MAX;
  afterEach(() => {
    if (saved === undefined) delete process.env.MILA_MASTRA_POOL_MAX;
    else process.env.MILA_MASTRA_POOL_MAX = saved;
  });

  it("defaults to 4 and reads a positive integer", async () => {
    const { MASTRA } = await import("../agent/engine/config");
    delete process.env.MILA_MASTRA_POOL_MAX;
    expect(MASTRA.poolMax).toBe(4);
    process.env.MILA_MASTRA_POOL_MAX = "2";
    expect(MASTRA.poolMax).toBe(2);
    process.env.MILA_MASTRA_POOL_MAX = "0";
    expect(MASTRA.poolMax).toBe(4);
    process.env.MILA_MASTRA_POOL_MAX = "nope";
    expect(MASTRA.poolMax).toBe(4);
  });
});
