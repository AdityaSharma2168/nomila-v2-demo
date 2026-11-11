/**
 * reprocessKnowledge.ts — re-derive athletes' canonical facts from research Nomila ALREADY holds, with today's item
 * mapping + fact registry + resolver (services/intelligence/research/reprocessKnowledge.ts). No provider call, no new
 * evidence; original evidence rows are untouched; created facts keep the original evidence ids and timestamps and carry
 * a `reprocessed` provenance marker. Idempotent.
 *
 *   1. DRY-RUN (default; read-only DB session) — prints the plan per athlete, writes nothing:
 *        npx tsx --require dotenv/config server/scripts/intelligence/reprocessKnowledge.ts --all [--json]
 *        (or --athlete <uuid> [--athlete <uuid> …] / --athletes a,b / --ids-file <path>; see ../athleteSelection)
 *   2. REVIEW the printed (or --json) plan.
 *   3. APPLY — the same selection plus --apply. Athletes run one at a time; one failing is reported and the run goes on.
 *
 * (--dry-run is still accepted; it is the default.) Writing needs RESEARCH_SUBSTRATE_WRITE=true (the same gate as
 * every research write). The same act is available to an admin over HTTP:
 * POST /api/v1/admin/intelligence/athletes/:id/knowledge/reprocess { dryRun?: true }.
 */
import { readOnlyPgOptions } from "../opps/readOnly";
import { forEachAthlete, parseAthleteSelection, SELECTION_USAGE, type AthleteSelection } from "../athleteSelection";

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  if (apply && argv.includes("--dry-run")) throw new Error("choose --apply or --dry-run, not both");
  const dryRun = !apply;
  let selection: AthleteSelection;
  try { selection = parseAthleteSelection(argv); } catch (e: any) { throw new Error(`${e.message}\nusage: reprocessKnowledge.ts ${SELECTION_USAGE} [--apply] [--json]`); }
  // Read-only BEFORE anything loads server/db: node-postgres reads PGOPTIONS on every new connection.
  if (dryRun) process.env.PGOPTIONS = readOnlyPgOptions(process.env.PGOPTIONS);

  const { db } = await import("../../db");
  const { resolveAthletes } = await import("../athleteSelection");
  const { reprocessKnowledge } = await import("../../services/intelligence/research/reprocessKnowledge");
  const ids = await resolveAthletes(db, selection);
  const json = argv.includes("--json");
  if (!json) console.log(`${dryRun ? "DRY RUN — nothing written" : "APPLYING"} · ${ids.length} athlete(s)\n`);

  const outcomes = await forEachAthlete(ids, async (athleteId) => {
    const r = await reprocessKnowledge(athleteId, { dryRun });
    if (!r) throw new Error(`athlete ${athleteId} not found`);
    if (json) return r;
    console.log(`── ${athleteId} · ${dryRun ? "dry run" : r.wrote ? "written" : "nothing to write"} · ${r.version} · registry ${r.versions.registry} · resolver ${r.versions.resolver} · mapping ${r.versions.mapping}`);
    console.log(`payloads: ${r.payloads.examined} examined · ${r.payloads.remapped} re-mapped · ${r.payloads.skipped.length} skipped`);
    for (const s of r.payloads.skipped) console.log(`  skip payload ${s.payloadId.slice(0, 8)}: ${s.reason}`);
    console.log(`claims: ${r.counts.examined} examined · ${r.counts.created} created · ${r.counts.unchanged} unchanged · ${r.counts.refused} refused · ${r.counts.proposed} proposed`);
    for (const c of r.created) console.log(`  ${dryRun ? "would create" : "created"} ${c.factKey} "${c.valueText}" (${c.status}) from ${c.evidenceIds.map((e) => e.slice(0, 8)).join(",")} retrieved ${c.retrievedAt}${c.supersedes.length ? ` · supersedes ${c.supersedes.length}` : ""}`);
    for (const x of r.refused) console.log(`  refused ${x.factKey}${x.evidenceId ? ` (${x.evidenceId.slice(0, 8)})` : ""}: ${x.reason}`);
    for (const p of r.proposed) console.log(`  proposed ${p.factKey}: ${p.reason}`);
    return r;
  });

  if (json) { console.log(JSON.stringify(outcomes, null, 2)); process.exit(outcomes.some((o) => !o.ok) ? 1 : 0); }
  const failed = outcomes.filter((o) => !o.ok);
  const created = outcomes.reduce((n, o) => n + (o.result?.counts.created ?? 0), 0);
  console.log(`\nsummary: ${outcomes.length - failed.length} athlete(s) ok, ${failed.length} failed · facts ${dryRun ? "that would be created" : "created"} ${created}`);
  for (const f of failed) console.log(`  FAILED ${f.athlete_id}: ${f.error}`);
  if (dryRun) console.log("dry run: nothing written. Re-run with --apply to write.");
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
