/**
 * athleteSelection.ts — the one way a data script picks its athletes. Standing rule: no fix is hand-applied to one
 * athlete or brand; a script runs the same algorithm over every athlete (dry-run first), or over a reviewed list.
 *
 *   --all                         every athlete row (ordered by id, so runs are repeatable)
 *   --athlete <uuid>              one athlete; repeatable, and comma lists are accepted (--athlete a,b)
 *   --athletes a,b,c              same as a comma list
 *   --ids-file <path>             one id per line; `#` comments and blank lines are ignored
 *
 * Exactly one source of truth: --all cannot be combined with ids. Pure parsing here; `resolveAthletes` is the only
 * read, a single SELECT of athlete ids. No imports from server/db so a dry-run can set PGOPTIONS first.
 */
import { readFileSync } from "node:fs";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AthleteSelection = { all: true; ids: [] } | { all: false; ids: string[] };

export const SELECTION_USAGE = "--all | --athlete <uuid> [--athlete <uuid> …] | --athletes a,b | --ids-file <path>";

/** Parse the selection flags; throws with a usage line when the selection is empty, mixed, or malformed. */
export function parseAthleteSelection(argv: string[], readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): AthleteSelection {
  const values = (k: string) => argv.flatMap((v, i) => (v === k && argv[i + 1] && !argv[i + 1].startsWith("--") ? [argv[i + 1]] : []));
  const ids = [
    ...[...values("--athlete"), ...values("--athletes")].flatMap((v) => v.split(",")),
    ...values("--ids-file").flatMap((p) => readFile(p).split(/\r?\n/).map((l) => l.replace(/#.*/, ""))),
  ].map((s) => s.trim()).filter(Boolean);
  const all = argv.includes("--all");
  if (all && ids.length) throw new Error(`choose either --all or a list of athletes, not both (${SELECTION_USAGE})`);
  if (all) return { all: true, ids: [] };
  const bad = ids.filter((id) => !UUID_RE.test(id));
  if (bad.length) throw new Error(`not an athlete uuid: ${bad.join(", ")}`);
  if (!ids.length) throw new Error(`no athletes selected (${SELECTION_USAGE})`);
  return { all: false, ids: [...new Set(ids.map((s) => s.toLowerCase()))] };
}

/** The athlete ids a selection names. `--all` reads every athlete row; a list is checked against the table. */
export async function resolveAthletes(dbx: any, sel: AthleteSelection): Promise<string[]> {
  const { athletes } = await import("../../shared/schema");
  const { asc, inArray } = await import("drizzle-orm");
  if (sel.all) return (await dbx.select({ id: athletes.id }).from(athletes).orderBy(asc(athletes.id))).map((r: { id: string }) => r.id);
  const found = new Set<string>((await dbx.select({ id: athletes.id }).from(athletes).where(inArray(athletes.id, sel.ids))).map((r: { id: string }) => r.id));
  const missing = sel.ids.filter((id) => !found.has(id));
  if (missing.length) throw new Error(`athlete(s) not found: ${missing.join(", ")}`);
  return sel.ids;
}

export interface AthleteOutcome<T> { athlete_id: string; ok: boolean; result?: T; error?: string }

/**
 * Run `fn` for each athlete in turn (never in parallel), isolating failures: one athlete's error is recorded and the
 * run moves on. Each call is expected to do its own per-athlete transaction.
 */
export async function forEachAthlete<T>(ids: string[], fn: (athleteId: string, i: number) => Promise<T>): Promise<AthleteOutcome<T>[]> {
  const out: AthleteOutcome<T>[] = [];
  for (let i = 0; i < ids.length; i++) {
    try { out.push({ athlete_id: ids[i], ok: true, result: await fn(ids[i], i) }); }
    catch (e: any) { out.push({ athlete_id: ids[i], ok: false, error: e?.message ?? String(e) }); }
  }
  return out;
}
