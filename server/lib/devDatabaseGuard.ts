/**
 * devDatabaseGuard.ts — the one check every DEV-ONLY script runs at startup, before any write or paid call: the database
 * it is actually connected to must be the dev database.
 *
 * Why not look at DATABASE_URL: the old check (`/prod/i.test(DATABASE_URL)`) passes the production database reached
 * through the local Cloud SQL proxy (postgresql://…@localhost:5441/nomila), whose URL says nothing about production. The
 * server is asked instead: `SELECT current_database()` must equal DEV_DATABASE ("nomila_v2"; production's is "nomila").
 * An allow-list, so an unknown database is refused too. NODE_ENV=production is refused before the database is asked.
 *
 * Scripts that are MEANT to be able to run on production (the privacy and security scripts, the injection fixture) use
 * the other pair below instead: `isDevDatabase` asks the same question without throwing, and `requireProdAck` refuses
 * any database that is not dev unless the person passed --i-know-this-is-prod. Same direction of caution: a database
 * that cannot be identified counts as production.
 */

export const DEV_DATABASE = "nomila_v2";

/** The part of a pg Pool / Client this needs. */
export interface Queryable {
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export class NotDevDatabaseError extends Error {
  constructor(message: string) { super(message); this.name = "NotDevDatabaseError"; }
}

/**
 * Throws NotDevDatabaseError unless the connected database is the dev database. `client` defaults to server/db's pool,
 * imported lazily so a script can load its env first. Returns the database name it checked.
 */
export async function assertDevDatabase(client?: Queryable, env: Record<string, string | undefined> = process.env): Promise<string> {
  if (env.NODE_ENV === "production") throw new NotDevDatabaseError("refusing: NODE_ENV is production; this script runs against the dev database only");
  const q: Queryable = client ?? ((await import("../db")).pool as unknown as Queryable);
  let name: unknown;
  try {
    const r = await q.query("SELECT current_database() AS name");
    name = r.rows[0]?.name;
  } catch (err: any) {
    throw new NotDevDatabaseError(`refusing: could not confirm the database is dev (${String(err?.message ?? err).slice(0, 120)})`);
  }
  if (name !== DEV_DATABASE) {
    throw new NotDevDatabaseError(`refusing: connected to database "${String(name)}", not the dev database "${DEV_DATABASE}"`);
  }
  return name;
}

// ─── Prod-capable scripts ─────────────────────────────────────────────────────────────────────────────────────────

export const PROD_ACK_FLAG = "--i-know-this-is-prod";

export class ProdAckRequiredError extends Error {
  constructor(message: string) { super(message); this.name = "ProdAckRequiredError"; }
}

/**
 * Which database is this, asked of the server? `dev` only when current_database() is exactly DEV_DATABASE. Never throws:
 * a query that fails or answers nothing gives { dev: false, name: null } — unknown is treated as production.
 */
export async function isDevDatabase(client?: Queryable): Promise<{ dev: boolean; name: string | null }> {
  try {
    const q: Queryable = client ?? ((await import("../db")).pool as unknown as Queryable);
    const r = await q.query("SELECT current_database() AS name");
    const name = r.rows[0]?.name;
    return typeof name === "string" ? { dev: name === DEV_DATABASE, name } : { dev: false, name: null };
  } catch {
    return { dev: false, name: null };
  }
}

/**
 * For a script that may run on production, but only on purpose: anything that is not the dev database needs
 * --i-know-this-is-prod (`allowProd`). Throws ProdAckRequiredError otherwise. With the flag, it never refuses — what the
 * script then does is unchanged. Returns what it found, so the script can print it.
 */
export async function requireProdAck(allowProd: boolean, client?: Queryable): Promise<{ dev: boolean; name: string | null }> {
  const found = await isDevDatabase(client);
  if (!found.dev && !allowProd) {
    const what = found.name === null ? "a database that could not be identified" : `database "${found.name}"`;
    throw new ProdAckRequiredError(`refusing to run: connected to ${what}, which is not the dev database "${DEV_DATABASE}" — treated as production. Re-run with ${PROD_ACK_FLAG} if it is meant to be.`);
  }
  return found;
}
