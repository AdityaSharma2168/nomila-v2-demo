/**
 * scorerHeadToHead.ts — Part A of the search + score comparison: the EXISTING facts-only M.I.A. scorer (prompt and
 * enforcement unchanged) on FROZEN inputs, gemini-3.8-flash (low thinking) vs deepseek-v4.1-flash-maas (thinking on).
 *
 *   npx tsx server/scripts/research/scorerHeadToHead.ts                 # DRY RUN (default): plan + estimate; no provider calls
 *       (reads dev; athletes without memory facts are left out of the estimate until --run builds their paid evidence)
 *   npx tsx server/scripts/research/scorerHeadToHead.ts --run --json a.json --max-usd 10
 *   … --runs 3   runs per model (default 3)   … --grade-runs 3  graded runs per model per athlete (default 3)
 *   … --frozen f.json   where the frozen inputs are written once and reused (default scorer-h2h-frozen.json)
 *
 * FROZEN INPUT = exactly what prod's facts-only scorer reads where a record exists: buildMemoryFactsSnapshot (active found
 * facts, care and context facts, the latest measured reading per metric — connected accounts and Business Discovery
 * numbers reach M.I.A. only as measured memory facts). Built once per athlete, written to a file, reused for every call.
 * Nothing Google-grounded.
 * Athletes: the owner's five (DEFAULT_PICKS). Only athletes with memory facts have a facts-only record on dev (Mia
 * Bhuta, Hannah Yu); the others get frozen evidence from free storable sources (buildFreeEvidence). Reference = the
 * stored M.I.A. score (for the others, produced by the older search-enabled evaluator on different evidence).
 *
 * Grader: GLM-5.2 on Vertex (a third family). The v2 extract call that builds free evidence writes its run log (agent_runs)
 * on dev, as compareV2 does; nothing else is written.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { athletes, intelligenceLedger, memoryFacts } from "../../../shared/schema";
import { assertDevDatabase } from "../../lib/devDatabaseGuard";
import { dbStore } from "../../agent/research/dbStore";
import { runNarrowResearch } from "../../agent/research/v2/pipeline";
import type { DiscoverQuery } from "../../agent/research/v2/discover";
import { loadBeta1Params } from "../../services/marketabilityBeta1Params";
import { createBeta1Normalizer } from "../../services/marketabilityBeta1Normalization";
import { buildMemoryFactsSnapshot, type PreviewFact } from "../../services/miaPreview/memoryAdapter";
import { factsOnlyPrompt } from "../../services/miaPreview/factsOnlySpec";
import {
  DEEPSEEK_MODEL, GEMINI_MODEL, GRADER_MODEL, costUsd, factsBlockFor, gradeRationales, scoreFactsOnly, zeroUsage,
  type AthleteCase, type FactsOnlyScore, type RationaleGrade, type ScorerId, type ScoringContext,
} from "./searchScoreEval.lib";
import { realProviders, wikidata } from "./searchScoreEval";

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }

export type Tier = "pro" | "college" | "youth" | "mid" | "thin";

/**
 * The owner's five (26 Oct 2026): one pro, one college, one youth, one mid-level, one thin-coverage — named here only to
 * choose the comparison set (an eval script, not product code).
 */
export const DEFAULT_PICKS: Array<{ name: string; tier: Tier }> = [
  { name: "Caitlin Clark", tier: "pro" }, { name: "Mia Bhuta", tier: "college" }, { name: "Hannah Yu", tier: "youth" },
  { name: "Jordyn Listro", tier: "mid" }, { name: "Riya Mehta", tier: "thin" },
];

interface FrozenCase { a: AthleteCase; block: string; sources: any[]; tier: Tier; foundFacts: number; measured: number; origin: string }

/** Wikidata as the ONLY discovery source (free, CC0): the athlete's entity pages (English Wikipedia, official website). */
function wikidataDiscover(name: string): DiscoverQuery {
  let done = false;
  return async () => {
    if (done) return { results: [], costMicroUsd: 0, searchQueries: 0, searchFeeMicroUsd: 0 };
    done = true;
    const hits = await wikidata(name).catch(() => []);
    const results = hits.filter((h) => h.label.toLowerCase() === name.toLowerCase())
      .flatMap((h) => [h.enwiki, h.officialWebsite].filter((u): u is string => !!u).map((url) => ({ url, title: h.label, snippet: h.description })));
    return { results, costMicroUsd: 0, searchQueries: 0, searchFeeMicroUsd: 0 };
  };
}

const fact = (a: { name: string }, claim: string, url: string | null, title: string | null, date: string | null, confidence: number): PreviewFact => ({
  id: randomUUID(), type: "found", status: "active", claim, subjectKind: "athlete", subjectName: a.name, sourceUrl: url, sourceRef: null,
  sourceTitle: title, observedOn: date, confidence, sensitive: false, careKind: null, disputes: null, createdAt: new Date().toISOString(), topic: null,
});

/**
 * An athlete with no facts-only record (no memory facts): evidence from sources we may store, built ONCE and frozen —
 *   Wikidata claims (CC0) about the matching entity; pages Wikidata links (English Wikipedia, official site) fetched by our
 *   fetcher (robots.txt respected, Defuddle), identity-checked and extracted by the EXISTING v2 pipeline and extract skill
 *   (gpt-6.1-sol: a third family to both scorers); and the athlete's current stored legacy facts (athlete_facts).
 * Nothing Google-grounded.
 */
async function buildFreeEvidence(a: { id: string; name: string; sport: string }): Promise<{ facts: PreviewFact[]; extractCostMicroUsd: number }> {
  const facts: PreviewFact[] = [];
  const hits = (await wikidata(a.name).catch(() => [])).filter((h) => h.label.toLowerCase() === a.name.toLowerCase());
  for (const h of hits.slice(0, 1)) for (const f of h.facts) facts.push(fact(a, `Wikidata lists ${a.name}'s ${f}.`, `https://www.wikidata.org/wiki/${h.id}`, "Wikidata", null, 0.9));
  let extractCostMicroUsd = 0;
  if (hits.length) {
    const out = await runNarrowResearch(
      { store: dbStore, athleteId: a.id, parentPrefix: `scorer-h2h:${Date.now()}` },
      { athlete: { name: a.name, sport: a.sport }, team: null, handles: [], known: [], today: new Date().toISOString().slice(0, 10), moment: "signup" },
      { provider: "openai_search" as any, discoverQuery: wikidataDiscover(a.name), cleaner: "defuddle" },
      `scorer-h2h:${a.id}`,
    );
    extractCostMicroUsd = out.metrics.costMicroUsd.total;
    for (const f of out.result?.facts ?? []) {
      const p = fact(a, f.claim, f.source_url, f.source_title || null, f.date || null, f.confidence);
      if (f.subject_kind !== "athlete") { p.subjectKind = f.subject_kind; p.subjectName = f.subject_name; }
      if (f.care) { p.sensitive = true; p.careKind = f.careKind === "conduct" ? "conduct" : "personal"; }
      facts.push(p);
    }
  }
  const legacy: any = await db.execute(sql`select fact_key, value_text, provenance, observed_at from athlete_facts where athlete_id = ${a.id} and status = 'current' order by fact_key`);
  for (const r of legacy.rows ?? legacy) {
    const url = r.provenance?.url ?? r.provenance?.source_url ?? null;
    facts.push(fact(a, `Nomila's record: ${String(r.fact_key).replace(/_/g, " ")} — ${r.value_text}.`, typeof url === "string" ? url : null, "Nomila record (legacy)", r.observed_at ? new Date(r.observed_at).toISOString().slice(0, 10) : null, 0.7));
  }
  return { facts, extractCostMicroUsd };
}

/** paid=false (dry run): no provider calls — athletes needing paid free-evidence extraction are skipped and nothing is written. */
async function frozenCases(picks: Array<{ name: string; tier: Tier }>, frozenPath: string, paid: boolean): Promise<{ cases: FrozenCase[]; buildCostUsd: number }> {
  if (existsSync(frozenPath)) {
    const saved = JSON.parse(readFileSync(frozenPath, "utf8"));
    console.log(`  reusing frozen inputs from ${frozenPath} (built ${saved.builtAt})`);
    return { cases: saved.cases, buildCostUsd: 0 };
  }
  const cases: FrozenCase[] = [];
  let micro = 0;
  let skippedPaid = 0;
  for (const pk of picks) {
    const r: any = await db.execute(sql`
      select a.id, a.full_name as name, a.sport,
        (select (l.value->>'score')::int from ${intelligenceLedger} l where l.subject_id = a.id and l.subject_type = 'athlete' and l.kind = 'ASSESSMENT'
          and l.owner = 'marketability' and l.superseded_by is null order by l.evidence_as_of desc limit 1) as score,
        exists (select 1 from ${memoryFacts} m where m.athlete_id = a.id and m.status = 'active' and m.type = 'found') as memory
      from ${athletes} a where lower(a.full_name) = lower(${pk.name}) order by a.created_at desc limit 1`);
    const row = (r.rows ?? r)[0];
    if (!row?.name || !row.sport) { console.log(`  skip ${pk.name}: not on dev`); continue; }
    const a: AthleteCase = { id: row.id, name: row.name, sport: row.sport, said: [], accounts: [], socialBlock: null, reference: { score: row.score ?? null, anchor: [] } };
    if (row.memory) {
      const snap = await buildMemoryFactsSnapshot(row.id, "USER_REQUESTED_REFRESH");
      if (!snap) { console.log(`  skip ${pk.name}: no snapshot`); continue; }
      if (!snap.socialBlock) { console.log(`  skip ${pk.name}: empty block`); continue; }
      cases.push({ a, block: snap.socialBlock, sources: snap.socialSources as any[], tier: pk.tier, foundFacts: snap.inputs.publicFactIds.length, measured: snap.inputs.measuredFactIds.length, origin: "stored facts-only record (buildMemoryFactsSnapshot, as prod)" });
    } else if (!paid) {
      console.log(`  skip ${pk.name} in the dry run: free evidence needs the paid v2 extract (built once on --run)`);
      skippedPaid++;
      continue;
    } else {
      const ev = await buildFreeEvidence(row);
      micro += ev.extractCostMicroUsd;
      const { block, sources } = factsBlockFor(a, ev.facts);
      cases.push({ a, block, sources, tier: pk.tier, foundFacts: ev.facts.filter((f) => f.subjectKind === "athlete" && !f.sensitive).length, measured: 0, origin: "free storable sources (Wikidata + Wikidata-linked pages via our fetcher + v2 extract) + stored legacy facts" });
    }
    const c = cases[cases.length - 1];
    console.log(`  frozen ${pk.tier.padEnd(7)} ${row.name.padEnd(16)} ${c.foundFacts} facts · ${c.measured} measured · ${c.block.length} chars · ref ${row.score ?? "—"}`);
  }
  if (!skippedPaid) writeFileSync(frozenPath, JSON.stringify({ builtAt: new Date().toISOString(), cases }, null, 1));
  return { cases, buildCostUsd: micro / 1e6 };
}

interface RunRow { athlete: string; tier: Tier; scorer: ScorerId; run: number; ref: number | null; score: number | null; error: string | null; ms: number; input: number; output: number; costUsd: number; attempts: number; parseFailures: number; enforcement: FactsOnlyScore["enforcement"]; scored: number | null; summary?: string | null; grade?: RationaleGrade | null }

async function main() {
  const frozenPath = arg("--frozen") ?? "scorer-h2h-frozen.json";
  const runs = Number(arg("--runs") ?? 3);
  const gradeRuns = Number(arg("--grade-runs") ?? 3);
  const maxUsd = Number(arg("--max-usd") ?? 10);
  const paid = process.argv.includes("--run");
  const scorers = (arg("--scorers") ?? "gemini-3.8-flash,deepseek-v4.1-flash").split(",").map((s) => s.trim()) as ScorerId[];
  await assertDevDatabase();
  const only = arg("--only")?.toLowerCase();
  const built = await frozenCases(DEFAULT_PICKS, frozenPath, paid);
  const cases = only ? built.cases.filter((c) => c.a.name.toLowerCase() === only) : built.cases;
  const buildCostUsd = built.buildCostUsd;
  const avgPrompt = cases.reduce((s, c) => s + factsOnlyPrompt({ name: c.a.name, sport: c.a.sport }, c.block).length / 4, 0) / Math.max(1, cases.length);
  const g = costUsd(GEMINI_MODEL, { ...zeroUsage(), input: avgPrompt, output: 7_000, thinking: 2_000 });
  const d = costUsd(DEEPSEEK_MODEL, { ...zeroUsage(), input: avgPrompt, output: 7_000, thinking: 6_000 });
  const gr = costUsd(GRADER_MODEL, { ...zeroUsage(), input: avgPrompt * 0.6 + 4_000, output: 800 });
  const est = cases.length * (runs * (g + d) + gradeRuns * 2 * gr);
  console.log(`PART A: ${cases.length} athletes × ${runs} runs × [gemini-3.8-flash low, deepseek-v4.1-flash thinking] · grader ${GRADER_MODEL} on ${gradeRuns} run(s) per model`);
  console.log(`  avg prompt ≈ ${Math.round(avgPrompt)} tokens · est per call: gemini $${g.toFixed(3)} deepseek $${d.toFixed(3)} grade $${gr.toFixed(3)} · ESTIMATED TOTAL $${est.toFixed(2)} (cap $${maxUsd})`);
  console.log(`  building the frozen inputs cost $${buildCostUsd.toFixed(3)} (v2 extract on Wikidata-linked pages)`);
  if (!paid) { console.log("DRY RUN — add --run to call the scorers."); return; }

  const { params, bundle } = await loadBeta1Params();
  const normalizer = createBeta1Normalizer(bundle);
  const ctx: ScoringContext = { params, subWeights: params.config.subWeights, prior: (p, s) => normalizer.prior(p as never, s as never) as any };
  const providers = realProviders();
  const asOf = new Date().toISOString();
  const rows: RunRow[] = [];
  let spent = buildCostUsd;
  outer: for (let run = 1; run <= runs; run++) {
    if (spent >= maxUsd) { console.log(`STOP: spent $${spent.toFixed(2)} ≥ cap`); break outer; }
    // All athletes in parallel; both models per athlete at once.
    await Promise.all(cases.map(async (c) => {
      await Promise.all(scorers.map(async (scorer) => {
        let s: FactsOnlyScore | null = null; let err: string | null = null;
        try { s = await scoreFactsOnly(providers, c.a, c.block, c.sources, scorer, ctx, asOf); } catch (e: any) { err = String(e?.message ?? e).slice(0, 200); }
        const row: RunRow = {
          athlete: c.a.name, tier: c.tier, scorer, run, ref: c.a.reference.score, score: s?.result?.score ?? null, error: s?.error ?? err,
          ms: s?.step.ms ?? 0, input: s?.step.usage.input ?? 0, output: s?.step.usage.output ?? 0, costUsd: s?.step.costUsd ?? 0,
          attempts: s?.attempts ?? 0, parseFailures: s?.parseFailures ?? 0, enforcement: s?.enforcement ?? null, scored: s?.result?.scored ?? null,
          summary: s?.out?.summary ?? null,
        };
        spent += row.costUsd;
        if (s?.out && run <= gradeRuns) {
          row.grade = await gradeRationales(providers, c.a, c.block, s.out).catch(() => null);
          spent += row.grade?.costUsd ?? 0;
        }
        rows.push(row);
        console.log(`  r${run} ${c.tier.padEnd(7)} ${c.a.name.padEnd(16)} ${scorer.padEnd(20)} ${row.score ?? "—"} (ref ${row.ref ?? "—"}) ${(row.ms / 1000).toFixed(0)}s $${row.costUsd.toFixed(3)} scored ${row.scored ?? "—"}${row.error ? ` ERR ${row.error}` : ""}${row.grade ? ` unsupported ${row.grade.unsupported.length}/${row.grade.statements}` : ""}`);
      }));
    }));
  }
  console.log(`PART A SPENT $${spent.toFixed(2)}`);
  const out = arg("--json");
  if (out) writeFileSync(out, JSON.stringify({ cases: cases.map((c) => ({ name: c.a.name, sport: c.a.sport, tier: c.tier, ref: c.a.reference.score, foundFacts: c.foundFacts, measured: c.measured, blockChars: c.block.length, origin: c.origin })), rows, spent }, null, 1));
}

if (require.main === module) main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
