/**
 * scripts/calibration/providerBenchmarkReport.ts — build the side-by-side and aggregate comparison
 * from stored benchmark artifacts (no provider calls, no database).
 *
 *   npx tsx server/scripts/calibration/providerBenchmarkReport.ts --as-of 2026-09-13 [--out dir]
 *
 * Writes report.md, report.json and ledger.csv next to the artifacts. Every ledger row keeps, per
 * provider: found, lineage, confidence, source URL/domain/type/tier, published date and quote,
 * plus agreement, conflict and abstention (decision 12 Sep 2026).
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aggregate, compareAthlete } from "../../services/intelligence/research/benchmark/compare";
import { ledgerCsv, renderAggregate, renderAthlete } from "../../services/intelligence/research/benchmark/report";
import type { ArmRun, AthleteComparison, DerivedArm } from "../../services/intelligence/research/benchmark/types";
import { DEFAULT_RESEARCH_POLICY } from "../../services/intelligence/research/policy";
import { normalizeSavedArm } from "../../services/intelligence/research/benchmark/recovery";
import { loadCohort, loadGold, loadTargets, RUNS_DIR } from "./cohort";

function main() {
  const a = process.argv.slice(2);
  const get = (flag: string) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : undefined; };
  const asOf = get("--as-of");
  if (!asOf) throw new Error("--as-of <YYYY-MM-DD> is required");
  const directAsOf = get("--direct-as-of");
  const dir = join(get("--out") ?? RUNS_DIR, asOf);
  if (!existsSync(dir)) throw new Error(`no artifacts under ${dir}`);
  const directDir = directAsOf ? join(get("--out") ?? RUNS_DIR, `${directAsOf}-direct`) : null;
  if (directDir && !existsSync(directDir)) throw new Error(`no direct artifacts under ${directDir}`);
  const cohort = loadCohort();
  const gold = loadGold();
  const targets = loadTargets();   // evaluation layer: never touched by the harness
  const comparisons: AthleteComparison[] = [];
  for (const athlete of cohort.athletes) {
    const adir = join(dir, athlete.key);
    const ddir = directDir ? join(directDir, athlete.key) : null;
    if (!existsSync(adir) && !(ddir && existsSync(ddir))) continue;
    const stored = [adir, ddir].filter((d): d is string => !!d && existsSync(d)).flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(d, f), "utf8")) as { arm: ArmRun; derived: DerivedArm }));
    if (!stored.length) continue;
    // Stored derivations are reused (a minor's artifact cannot be re-derived from redacted text).
    const byProvider = new Map(stored.map((s) => [s.arm.provider, s.derived]));
    comparisons.push({ ...compareAthlete(athlete, stored.map((s) => normalizeSavedArm(s.arm)), gold.get(athlete.key) ?? null, DEFAULT_RESEARCH_POLICY, (arm) => byProvider.get(arm.provider)!), targetScore: targets.get(athlete.key) ?? null });
  }
  if (!comparisons.length) throw new Error("no athlete artifacts found");
  const agg = aggregate(comparisons, asOf);
  const md = [`# Research provider benchmark — path A as of ${asOf}${directAsOf ? ` · path B (direct) as of ${directAsOf}` : ""}`, directAsOf ? "PROVISIONAL / NON-CONTEMPORANEOUS: path A (provider search → Kimi) and path B (direct provider research) were run on different dates from different searches; small factual differences must not be attributed to architecture. Provenance levels are evidence about API capability, not a provider score." : "", renderAggregate(agg), "", "## Per athlete", "", ...comparisons.map(renderAthlete)].join("\n\n");
  const outDir = directDir ?? dir;
  const stem = directDir ? "four-path-report" : "report";
  writeFileSync(join(outDir, `${stem}.md`), md);
  writeFileSync(join(outDir, `${stem}.json`), JSON.stringify({ aggregate: agg, athletes: comparisons, asOf, directAsOf }, null, 2));
  writeFileSync(join(outDir, directDir ? "four-path-ledger.csv" : "ledger.csv"), ledgerCsv(comparisons.flatMap((c) => c.ledger), agg.providers));
  console.log(md);
  console.log(`\nwritten: ${join(outDir, `${stem}.md`)}, ${stem}.json, ledger csv`);
}

if (require.main === module) { try { main(); } catch (err: any) { console.error(err?.message ?? err); process.exit(1); } }
