/**
 * purgeJunkSamplesCore — strip stored message content from existing `file` receipts.
 *
 * Until this change, logAutoHandledJunk copied the filed message's sender, subject and the
 * opening of its body into `agent_actions.payload` (sample_from / sample_subject /
 * sample_body) as a "training sample". No screen ever showed them — the Filtered list shows
 * brand_name, the reason and the date — and keeping Gmail content as a corpus is exactly
 * what Google's Limited Use policy forbids. New receipts no longer carry them; this removes
 * them from the rows already written.
 *
 * The core never reads a sample's VALUE: counts are computed in SQL and the update removes
 * the keys with the jsonb `-` operator, so no message content passes through this process.
 *
 * No imports from server/db: the CLI decides the session (read-only for the dry run) before
 * the pool module loads, and the test hands in a PGlite drizzle instance.
 */

import { sql, type SQL } from "drizzle-orm";

/** Every payload key logAutoHandledJunk ever wrote that carried message content. */
export const SAMPLE_KEYS = ["sample_from", "sample_subject", "sample_body"] as const;

export type PurgeScope = { athleteId: string } | { all: true };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KEYS_ARRAY = sql.raw(`array[${SAMPLE_KEYS.map((k) => `'${k}'`).join(", ")}]::text[]`);

function scopeFilter(scope: PurgeScope): SQL {
  const base = sql`action = 'file' and payload ?| ${KEYS_ARRAY}`;
  return "athleteId" in scope ? sql`${base} and athlete_id = ${scope.athleteId}` : base;
}

export interface SampleCounts {
  /** Receipts that still hold at least one sample key. */
  receipts: number;
  /** Distinct athletes those receipts belong to. */
  athletes: number;
  /** How many receipts hold each key (a receipt can hold several). */
  byKey:    Record<(typeof SAMPLE_KEYS)[number], number>;
}

/** Counts only — never a value. Safe under a read-only session. */
export async function countJunkSamples(dbx: any, scope: PurgeScope): Promise<SampleCounts> {
  const res = await dbx.execute(sql`
    select count(*)::int                                          as receipts,
           count(distinct athlete_id)::int                        as athletes,
           count(*) filter (where payload ? 'sample_from')::int    as sample_from,
           count(*) filter (where payload ? 'sample_subject')::int as sample_subject,
           count(*) filter (where payload ? 'sample_body')::int    as sample_body
      from agent_actions
     where ${scopeFilter(scope)}
  `);
  const r = ((res as any).rows ?? res)[0] ?? {};
  return {
    receipts: Number(r.receipts ?? 0),
    athletes: Number(r.athletes ?? 0),
    byKey: {
      sample_from:    Number(r.sample_from ?? 0),
      sample_subject: Number(r.sample_subject ?? 0),
      sample_body:    Number(r.sample_body ?? 0),
    },
  };
}

/**
 * Remove every sample key from the scoped receipts. Only `payload` changes — the receipt
 * itself (action, reason, brand_name, category, external_message_id…) stays, so the
 * Filtered list and the redelivery idempotency gate keep working. Returns rows updated.
 */
export async function purgeJunkSamples(dbx: any, scope: PurgeScope): Promise<number> {
  const res = await dbx.execute(sql`
    update agent_actions
       set payload = payload - ${KEYS_ARRAY}
     where ${scopeFilter(scope)}
  `);
  return Number((res as any).rowCount ?? (res as any).affectedRows ?? 0);
}

// ─── CLI argument + target checks (pure, so they are tested without a database) ───────

export interface PurgeArgs {
  apply:      boolean;
  scope:      PurgeScope | null;
  allowProd:  boolean;
  envPath:    string | undefined;
}

export function parsePurgeArgs(argv: string[]): { ok: true; args: PurgeArgs } | { ok: false; error: string } {
  const has = (k: string) => argv.includes(k);
  const i = argv.indexOf("--athlete");
  const athleteId = i >= 0 ? argv[i + 1] : undefined;
  const e = argv.indexOf("--env");
  const envPath = e >= 0 ? argv[e + 1] : undefined;

  if (i >= 0 && (!athleteId || !UUID_RE.test(athleteId))) return { ok: false, error: "--athlete needs a uuid" };
  if (athleteId && has("--all")) return { ok: false, error: "pass --athlete <uuid> or --all, not both" };

  const scope: PurgeScope | null = athleteId ? { athleteId } : has("--all") ? { all: true } : null;
  const apply = has("--apply");
  if (apply && !scope) return { ok: false, error: "--apply needs an explicit scope: --athlete <uuid> or --all" };

  return { ok: true, args: { apply, scope, allowProd: has("--i-know-this-is-prod"), envPath } };
}

/**
 * Does DATABASE_URL look like production? The same rules as scripts/seed-injection-fixture.ts
 * (describeTarget): a Cloud SQL socket URL is what Cloud Run uses, 5440 is this project's
 * prod proxy port (scripts/db-migrate.sh), and an unparseable URL is treated as prod. Added:
 * any host or database name containing "prod" (nomila-prod-db / NOMILA_PROD_DATABASE_URL in
 * deploy-prod.yml). Conservative by design — a false "prod" only asks for the extra flag.
 * A local proxy URL cannot say which instance is behind it (5440 is also used to reach dev),
 * so the CLI always prints the target and a person confirms it.
 */
export function describeDbTarget(raw: string | undefined): { label: string; looksLikeProd: boolean } {
  const url = raw ?? "";
  if (!url) return { label: "DATABASE_URL is not set", looksLikeProd: true };
  if (url.includes("/cloudsql/")) {
    const dbName = url.split("?")[0].split("/").pop() || "unknown";
    return { label: `Cloud SQL socket — database "${dbName}"`, looksLikeProd: true };
  }
  try {
    const u = new URL(url);
    const port = u.port || "5432";
    const dbName = u.pathname.replace(/^\//, "");
    return {
      label: `${u.hostname}:${port} — database "${dbName}"`,
      looksLikeProd: port === "5440" || /prod/i.test(u.hostname) || /prod/i.test(dbName),
    };
  } catch {
    return { label: "unparseable DATABASE_URL", looksLikeProd: true };
  }
}
