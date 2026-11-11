import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../shared/schema";
import { createLogger } from "./logger";

const { Pool } = pg;
const logger = createLogger("db");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set — check Secret Manager or .env");
}

// Cloud SQL Auth Proxy (Cloud Run) uses Unix socket URLs containing "/cloudsql/"
const isCloudSQL   = process.env.DATABASE_URL.includes("/cloudsql/");
const isProduction = process.env.NODE_ENV === "production";

// Per-instance pool size. The constraint is maxScale × pool ≤ the Cloud SQL
// instance's max_connections, so the number lives next to maxScale in
// gcp/cloud-run-{dev,prod}.yaml as DB_POOL_MAX. The fallbacks below only apply
// when that env is unset (local scripts, a yaml that forgot it):
//   dev  nomila-v2-db    db-g1-small, max_connections=100 (flag), maxScale 3 → 5
//   prod nomila-prod-db  db-g1-small, no flag → tier default ≈50, maxScale 4 → 10
//        (the prod yaml sets 7 so Mastra's own pool fits: 4 × (7 + 4) = 44 ≤ 45;
//        server/lib/dbPoolBudget.test.ts pins the budget for both yamls)
// Both instances are db-g1-small; an earlier comment here assumed a
// db-n1-standard-2 with 200 connections for prod, which never existed.
const envPoolMax = Number(process.env.DB_POOL_MAX);
const poolMax =
  Number.isInteger(envPoolMax) && envPoolMax > 0
    ? envPoolMax
    : isCloudSQL ? (isProduction ? 10 : 5) : 5;

// Scripts (seed, migration) have no PORT; Cloud Run always sets PORT.
// Scripts need idleTimeoutMillis=0 so connections survive gaps between AI calls and DB writes.
const isScript = !process.env.PORT;

export const pool = new Pool({
  connectionString:            process.env.DATABASE_URL,
  max:                         poolMax,
  keepAlive:                   true,
  keepAliveInitialDelayMillis: 10_000,
  idleTimeoutMillis:           isScript ? 0 : 30_000,
  connectionTimeoutMillis:     10_000,
});

// Idle pooled connections can be dropped by the server / Cloud SQL Auth Proxy.
// Without this handler, node-postgres re-emits that as an uncaught 'error' on the
// idle client and crashes the process. pg-pool removes the broken client
// automatically; we just absorb the event and let the pool reconnect.
pool.on("error", (err) => {
  logger.warn({ err: err.message }, "idle db client error — pool will reconnect");
});

export const db = drizzle(pool, { schema });
