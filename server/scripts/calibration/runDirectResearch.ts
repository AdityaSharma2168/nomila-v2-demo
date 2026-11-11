/**
 * runDirectResearch.ts — DEV-ONLY calibration CLI for the direct research runner (Phase A Step 4, Slice 2). Since PR E2a it
 * runs the research_refresh v3 provider stage itself (research/v3Stage.ts via the skills binding runDirectCalibration):
 * one research_runs row per query, governIdentity false — the Q1 identity gate is OBSERVED (wouldGate), never enforced,
 * and no identity determination is ever written for a calibration athlete (design record §5.3, D9).
 *
 *   npx tsx --require dotenv/config server/scripts/calibration/runDirectResearch.ts                  # dry run: plan, no calls, no writes
 *   npx tsx --require dotenv/config server/scripts/calibration/runDirectResearch.ts --cohort dev37 --keys caitlin-clark,hannah-yu --run
 *
 * Allow-list: only athletes in the named cohort file (--cohort dev20 | dev37; the holdout guard refuses anything else). Each cohort entry is resolved to
 * an athletes row on the connected database by (full_name, sport) — created as a public/unclaimed row (status raw, no auth)
 * when absent, never updated. Writes happen only with --run AND RESEARCH_SUBSTRATE_WRITE=true in the environment (persist's
 * own flag); the connected database must be dev (server/lib/devDatabaseGuard.ts refuses any other). Targets/gold are never read.
 * Claimed/authenticated athlete rows (real accounts) are skipped unless --allow-claimed. --night-cap / --run-cap raise the
 * ledger caps for THIS calibration process only (the policy row is untouched): 37 athletes × 6 queries exceed the nightly default.
 */
import { and, sql } from "drizzle-orm";
import { db } from "../../db";
import { assertDevDatabase } from "../../lib/devDatabaseGuard";
import { athletes } from "../../../shared/schema";
import { runDirectCalibration } from "../../skills/researchRefresh";
import { QUERIES } from "../../services/intelligence/research/spec/researchSpecV1";
import { loadCohort, selectAthletes, type CohortName } from "./cohort";

function args() {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  return { cohort: (get("--cohort") ?? "dev20") as CohortName, run: a.includes("--run"), allowClaimed: a.includes("--allow-claimed"), nightCap: get("--night-cap") ? Number(get("--night-cap")) : undefined, runCap: get("--run-cap") ? Number(get("--run-cap")) : undefined, keys: (get("--keys") ?? "").split(",").map((s) => s.trim()).filter(Boolean), asOf: get("--as-of") };
}

/** Resolve a cohort entry to an athletes row: case-insensitive (full_name, sport) match first, else create a public/unclaimed row. */
async function ensureAthleteRow(fullName: string, sport: string): Promise<{ id: string; created: boolean; claimed: boolean }> {
  const [existing] = await db.select({ id: athletes.id, auth: athletes.auth_id, claimedAt: athletes.claimed_at }).from(athletes)
    .where(and(sql`lower(${athletes.full_name}) = lower(${fullName})`, sql`lower(coalesce(${athletes.sport}, '')) = lower(${sport})`)).limit(1);
  if (existing) return { id: existing.id, created: false, claimed: !!(existing.auth || existing.claimedAt) };
  const [row] = await db.insert(athletes).values({ full_name: fullName, sport }).returning({ id: athletes.id });
  return { id: row.id, created: true, claimed: false };
}

async function main() {
  const o = args();
  await assertDevDatabase();   // dev only: the connected database must be dev, before any write or spend
  const cohort = loadCohort(o.cohort);
  const selected = selectAthletes(cohort, o.keys);
  const asOf = o.asOf ? new Date(`${o.asOf}T00:00:00.000Z`) : new Date();
  console.log(`direct research · cohort ${cohort.version} · ${selected.length} athlete(s) · ${QUERIES.length} queries each (≤ ${QUERIES.length * 2} Gemini calls per athlete incl. retries) · as-of ${asOf.toISOString().slice(0, 10)}`);
  if (!o.run) { for (const a of selected) console.log(`  ${a.key}: ${a.fullName} — ${a.sport}${a.isMinor ? " (minor)" : ""}`); console.log("dry run — add --run (and RESEARCH_SUBSTRATE_WRITE=true) to research and persist on dev"); return; }
  if (process.env.RESEARCH_SUBSTRATE_WRITE !== "true") throw new Error("refusing: RESEARCH_SUBSTRATE_WRITE is not true (persist would write nothing)");
  for (const a of selected) {
    const { id, created, claimed } = await ensureAthleteRow(a.fullName, a.sport);
    console.log(`\n== ${a.key} → athlete ${id}${created ? " (created)" : ""}${claimed ? " (claimed/authenticated account)" : ""}`);
    // A claimed or authenticated athlete row is a real account: never researched by this calibration tool unless explicitly allowed.
    if (claimed && !o.allowClaimed) { console.log("  skipped: claimed/authenticated account (pass --allow-claimed to include)"); continue; }
    const plannerOverride = { ...(o.nightCap ? { maxLlmCallsPerNight: o.nightCap } : {}), ...(o.runCap ? { maxCallsPerRun: o.runCap } : {}) };
    const r = await runDirectCalibration({ athleteId: id, subject: { fullName: a.fullName, sport: a.sport, anchor: a.anchor, isMinor: !!a.isMinor }, trigger: "manual", asOf, plannerOverride });
    for (const q of r.queries) console.log(`  ${q.id}: ${q.completed ? "ok" : q.refused ? "refused" : "failed"} attempts=${q.attempts} findings=${q.findings} lineage=${JSON.stringify(q.lineage)} identity=${q.identity?.anchorMatch ?? "-"}/${q.identity?.confidence ?? "-"} ${((q.latencyMs ?? 0) / 1000).toFixed(1)}s`);
    console.log(`  runs ${r.runIds.join(",") || "-"} ${r.status} · claims ${r.claims} · minorActivated ${r.minorActivated} · careerStatus ${r.careerStatus.status ?? "unknown"} · evidence ${r.evidence} facts ${r.facts} refused ${r.refused} · identity gate (observed) ${r.wouldGate == null ? "-" : r.wouldGate ? "would hold Q2–Q6" : "would pass"}${r.error ? ` · error ${r.error}` : ""}`);
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err?.message ?? err); process.exit(1); });
