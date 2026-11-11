/**
 * pgliteDb.ts — in-memory Postgres test double for server/db.
 *
 * Suites swap it in with `jest.mock("../db", () => require("../testUtils/pgliteDb"))`.
 * PGlite is a real Postgres (WASM) running inside the jest worker: real SQL,
 * real constraints, real drizzle queries — and zero connection to Cloud SQL.
 * initTestDb() pushes shared/schema.ts into it via drizzle-kit, so the test
 * schema can never drift from the app schema.
 *
 * Not a *.test.ts file, so jest doesn't collect it as a suite.
 */

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../../shared/schema";

// pg_trgm is loaded so suites can apply the Athlete Index migration (0048) verbatim.
export const client = new PGlite({ extensions: { pg_trgm } });
export const db = drizzle(client, { schema });

// Shape-compatible stand-in for server/db's pool export (nothing to pool here).
export const pool = { end: async () => {}, on: () => {} };

let ready: Promise<void> | null = null;

export function initTestDb(): Promise<void> {
  ready ??= (async () => {
    // generateMigration(empty → schema) is pure (no introspection, no spinner,
    // no process.exit on error — unlike drizzle-kit's pushSchema, which dies
    // opaquely inside jest workers). It returns plain DDL strings to execute.
    const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
    const statements = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson(schema),
    );
    for (const statement of statements) await client.exec(statement);
  })();
  return ready;
}

export async function closeTestDb(): Promise<void> {
  await client.close();
}

// ─── Seed helpers ─────────────────────────────────────────────────────────────

export async function seedAthlete(fullName = "Test Athlete", extra: Partial<typeof schema.athletes.$inferInsert> = {}): Promise<string> {
  const [row] = await db
    .insert(schema.athletes)
    .values({ full_name: fullName, ...extra } as any)
    .returning({ id: schema.athletes.id });
  return row.id;
}

let seededAccountSeq = 0;

export async function seedConnection(params: {
  athleteId: string;
  platform?: string;
  email?: string;
  status?: string;
  /**
   * The provider's stable account id. Defaults to a generated, unique, non-null id — every real connect has one
   * (0071's connected_accounts_account_uq is keyed on it). Pass the same id twice for the same athlete+platform
   * and the unique index refuses the second row, exactly as production does. Pass null for a legacy/pending row.
   */
  platformUserId?: string | null;
  scopes?: string | null;
  connectedAt?: Date | null;
  alias?: string | null;
  createdAt?: Date;
}): Promise<string> {
  const status = params.status ?? "active";
  const [row] = await db
    .insert(schema.connectedAccounts)
    .values({
      athlete_id:        params.athleteId,
      platform:          params.platform ?? "gmail",
      status,
      alias:             params.alias ?? null,
      platform_username: params.email ?? "athlete@example.com",
      platform_user_id:  params.platformUserId === undefined ? `test-account-${++seededAccountSeq}-${Date.now()}` : params.platformUserId,
      scopes:            params.scopes ?? null,
      connected_at:      params.connectedAt === undefined ? (status === "pending" ? null : new Date()) : params.connectedAt,
      access_token:      "test-access-token",
      // Far-future expiry so refreshTokenIfNeeded never hits the network.
      token_expires_at:  new Date(Date.now() + 60 * 60 * 1000),
      ...(params.createdAt ? { created_at: params.createdAt } : {}),
    } as any)
    .returning({ id: schema.connectedAccounts.id });
  return row.id;
}
