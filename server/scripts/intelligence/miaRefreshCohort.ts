/**
 * miaRefreshCohort.ts — refresh M.I.A. for a named cohort through the existing workflow, and record the provenance.
 *
 * The same trigger the admin manual-refresh route uses (`requestEvaluation`, force: true): a workflow run the dev
 * runner executes. Nothing about the evaluator, its params or the evidence changes. For each athlete this prints the
 * live row BEFORE, waits for the run to supersede it, and prints the live row AFTER, so an experiment can say exactly
 * which assessment fed State. Athletes whose refresh does not land within the wait are reported, not retried.
 *
 * PR H2: the same identity preflight as the admin route, BEFORE enqueueing. With identity resolution on, an athlete
 * whose public identity is not resolved is reported as held (with the identity value and reason) and NOT enqueued —
 * never a run that silently blocks. Flag off ⇒ nothing is held, exactly as before.
 *
 *   npx tsx --require dotenv/config server/scripts/intelligence/miaRefreshCohort.ts --athletes "A,B,C" [--wait-min 12]
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db";
import { athletes, intelligenceLedger } from "../../../shared/schema";
// Registers every workflow definition (the server does this at boot; a script must too, or startRun refuses the process).
import "../../workflow/definitions/index";
import { miaIdentityPreflight, requestEvaluation, type MiaIdentityPreflight } from "../../services/marketabilityBeta1Orchestrator";

async function liveRow(athleteId: string) {
  const [r] = await db.select({ id: intelligenceLedger.id, created_at: intelligenceLedger.created_at, run: intelligenceLedger.evaluation_run_id, value: intelligenceLedger.value })
    .from(intelligenceLedger)
    .where(and(eq(intelligenceLedger.subject_id, athleteId), eq(intelligenceLedger.owner, "marketability"), eq(intelligenceLedger.kind, "ASSESSMENT"), isNull(intelligenceLedger.superseded_by)))
    .orderBy(desc(intelligenceLedger.created_at)).limit(1);
  return r ?? null;
}

export type CohortRequest =
  | { athleteId: string; name: string; requested: true; runId: string; created: boolean }
  | { athleteId: string; name: string; requested: false; held: Exclude<MiaIdentityPreflight, { held: false }> };

/** Preflight each athlete, then enqueue only the ones the identity gate would let evaluate. */
export async function requestCohortRefresh(rows: { id: string; name: string }[]): Promise<CohortRequest[]> {
  const out: CohortRequest[] = [];
  for (const r of rows) {
    const pre = await miaIdentityPreflight(r.id);
    if (pre.held) { out.push({ athleteId: r.id, name: r.name, requested: false, held: pre }); continue; }
    const { runId, created } = await requestEvaluation({ athleteId: r.id, trigger: "USER_REQUESTED_REFRESH", force: true, reason: "diverse-athlete Objective validation cohort", createdBy: "cohort_validation" });
    out.push({ athleteId: r.id, name: r.name, requested: true, runId, created });
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const names = (arg("--athletes") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const waitMin = Number(arg("--wait-min") ?? 12);
  if (!names.length) throw new Error("--athletes \"A,B\" is required");

  const rows = await db.select({ id: athletes.id, name: athletes.full_name, sport: athletes.sport }).from(athletes).where(inArray(athletes.full_name, names));
  const missing = names.filter((n) => !rows.some((r) => r.name === n));
  if (missing.length) throw new Error(`not found: ${missing.join(", ")}`);

  const before = new Map<string, Awaited<ReturnType<typeof liveRow>>>();
  for (const r of rows) {
    if (!r.sport) throw new Error(`${r.name} has no sport; the evaluator will not guess`);
    before.set(r.id, await liveRow(r.id));
  }
  const requests = await requestCohortRefresh(rows);
  for (const q of requests) {
    if (q.requested) console.log(`${q.name.padEnd(18)} before ${before.get(q.athleteId)?.id.slice(0, 8) ?? "—"}  run ${q.runId.slice(0, 8)} created=${q.created}`);
    else console.log(`${q.name.padEnd(18)} HELD for identity (${q.held.identity.value ?? "NULL"}${q.held.identity.reason ? `: ${q.held.identity.reason}` : ""}) — not enqueued`);
  }
  const waiting = rows.filter((r) => requests.some((q) => q.athleteId === r.id && q.requested));

  const deadline = Date.now() + waitMin * 60_000;
  const done = new Set<string>();
  while (Date.now() < deadline && done.size < waiting.length) {
    await new Promise((res) => setTimeout(res, 20_000));
    for (const r of waiting) {
      if (done.has(r.id)) continue;
      const now = await liveRow(r.id);
      if (now && now.id !== before.get(r.id)?.id) {
        done.add(r.id);
        const v = now.value as any;
        console.log(`  ✓ ${r.name.padEnd(18)} live ${now.id.slice(0, 8)} created ${now.created_at.toISOString().slice(0, 16)} run ${now.run?.slice(0, 8)}  findings=${Array.isArray(v?.findings)} evidence=${Array.isArray(v?.evidence)} dims=${Array.isArray(v?.dimensions) ? v.dimensions.length : 0}`);
      }
    }
  }
  for (const r of waiting) if (!done.has(r.id)) console.log(`  ✗ ${r.name}: no new live row within ${waitMin} min (run still pending or failed) — before ${before.get(r.id)?.id.slice(0, 8)}`);
  process.exit(done.size === rows.length ? 0 : 1);
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
