/**
 * exportAthleteData.ts — her data as ONE JSON document, built from the manifest's export rules, plus her Mastra
 * engine footprint (exportMastraData.ts; owner-approved B2, 3 Nov 2026), which lives outside the manifest in its own
 * Postgres schema (see that file's header).
 *
 * v1 per the "Your data" design: a single JSON file (the phone saves / shares it). Media and contract FILES are not
 * inside it yet (a zip comes later); their rows, with dates and sources, are.
 *
 * Never included: access tokens and other credentials (the manifest omits them), other athletes' data (every query
 * is scoped by the manifest predicate, or by her athlete id / her own thread ids for Mastra; columns naming other
 * athletes are omitted), shared brand research (inbox_brands — only her own links to brands are exported) and
 * stored email / DM text (references only).
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";
import {
  ATHLETE_DATA_MANIFEST, DATA_CATEGORIES, athleteWhere, type DataCategory, type ManifestEntry,
} from "../../lib/athleteDataManifest";
import { resolveAthleteScope, rowsOf, type ResolvedScope } from "./athleteScope";
import { buildMastraExport, type MastraExport } from "./exportMastraData";

export const EXPORT_FORMAT = "nomila.athlete-data-export";
export const EXPORT_VERSION = 1;

export interface ExportedTable {
  mode: "rows" | "references";
  count: number;
  why?: string;
  rows: Record<string, unknown>[];
}

export interface AthleteExport {
  format: typeof EXPORT_FORMAT;
  version: number;
  generated_at: string;
  athlete_id: string;
  categories: Record<DataCategory, { label: string; description: string; tables: Record<string, ExportedTable> }>;
  /** Her Mila conversations on the Mastra engine (schema "mastra", outside the manifest): see exportMastraData.ts. */
  mastra_engine: MastraExport;
  not_included: Array<{ what: string; why: string }>;
}

const NOT_INCLUDED: AthleteExport["not_included"] = [
  { what: "Your email and DM text", why: "Nomila reads it live from Gmail, Outlook or Instagram and does not keep it. Any older message that still held text is listed by reference only (inbox_messages)." },
  { what: "Access tokens for your connected accounts", why: "They are credentials, not data about you." },
  { what: "Shared brand research", why: "Brand profiles are shared across Nomila; your own links to brands (deals, opportunities, brand fit, your brand cards) are included." },
  { what: "Other people's data", why: "Who viewed a card you shared, senders' names and addresses, and other athletes named in search results or campaigns are left out." },
  { what: "Photo, video, contract and brief files", why: "Their records are included; the files themselves will come as a separate download." },
];

async function tableExport(entry: ManifestEntry, scope: ResolvedScope): Promise<ExportedTable | null> {
  const rule = entry.export;
  if (rule.mode === "none") return null;
  const where = athleteWhere(entry, scope);
  const cols = rule.mode === "references"
    ? sql.join(rule.columns.map((c) => sql.identifier(c)), sql`, `)
    : sql`*`;
  let rows = rowsOf<Record<string, unknown>>(await db.execute(sql`SELECT ${cols} FROM ${entry.table} WHERE ${where}`));
  if (rule.mode === "rows") {
    const omit = new Set(rule.omit ?? []);
    rows = rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) if (!omit.has(k)) out[k] = v;
      return rule.redact ? rule.redact(out) : out;
    });
  }
  return { mode: rule.mode, count: rows.length, ...(rule.why ? { why: rule.why } : {}), rows };
}

/** null when the athlete does not exist. */
export async function buildAthleteExport(athleteId: string): Promise<AthleteExport | null> {
  const scope = await resolveAthleteScope(db, athleteId);
  if (!scope) return null;

  const categories = Object.fromEntries(
    (Object.keys(DATA_CATEGORIES) as DataCategory[]).map((c) => [c, { ...DATA_CATEGORIES[c], tables: {} as Record<string, ExportedTable> }]),
  ) as AthleteExport["categories"];
  const not_included = [...NOT_INCLUDED];

  for (const entry of ATHLETE_DATA_MANIFEST) {
    const t = await tableExport(entry, scope);
    if (t) categories[entry.category].tables[entry.name] = t;
    else if (entry.export.mode === "none") not_included.push({ what: entry.name, why: entry.export.why });
  }

  const mastra_engine = await buildMastraExport(athleteId);
  if (!mastra_engine.present) not_included.push({ what: `Mastra engine (schema "${mastra_engine.schema}")`, why: mastra_engine.note! });

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    generated_at: new Date().toISOString(),
    athlete_id: athleteId,
    categories,
    mastra_engine,
    not_included,
  };
}
