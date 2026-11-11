/**
 * leanRun.ts — run LEAN research (the signup_research v4 path) in SHADOW mode on chosen athletes and print what it
 * found and the score it would give. Writes NOTHING (agent/research/v2/leanShadow.ts): no fact, no run row, no score.
 * DEV database only (assertDevDatabase). The one command for every later comparison of the lean path.
 *
 *   npx tsx server/scripts/research/leanRun.ts --athletes "<name>,<name>|<id>" [options]
 *
 *   --athletes a,b,c        athlete ids or full names (dev database), comma-separated
 *   --model m[:effort]      the extract model (default: the skill's own, gpt-6.1-sol at low; LEAN_RESEARCH_EXTRACT_MODEL)
 *   --verify-model m[:e]    the verifier model (default: the skill's own, the fast tier at low)
 *   --scorer-model m[:t]    the M.I.A. scorer: a Gemini model with optional thinking (gemini-3.8-flash:low), or an OpenAI
 *                           model (gpt-…[:effort], the opt-in OpenAI evaluator). Default: as the service is configured
 *   --search openai|none    OpenAI web search after the free Wikidata discovery (default openai), or free sources only
 *   --runs N                runs per athlete (default 1)
 *   --concurrency N         runs at once (default 3)
 *   --max-usd X             stop starting runs once spent + reserved would pass X (default 2; each run reserves
 *                           LEAN_RUN_EST_USD, default 0.6, until it reports its real cost)
 *   --fresh                 score as a NEW sign-up: only her said and measured facts are kept from memory (default:
 *                           the live path — new facts de-duplicated against, and scored with, everything she holds)
 *   --selection balanced|default   the scorer's selection into its 60 public facts (default balanced: v4's)
 *   --dry                   no paid call: plan, free Wikidata discovery, fetch and rank only
 *   --json out.json         the full per-run reports (facts, pages, plan of writes, scorer input, score)
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { assertDevDatabase } from "../../lib/devDatabaseGuard";
import { leanShadowRun, type ShadowReport } from "../../agent/research/v2/leanShadow";
import { parseModelChoice, type LeanSearch } from "../../agent/research/v2/lean";
import { factsGeminiChoice, type FactsGeminiChoice } from "../../services/marketabilityBeta1Evaluator";
import { MARKETABILITY_DIMENSIONS } from "../../services/intelligence/types";

const argv = process.argv.slice(2);
const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (k: string) => argv.includes(k);

export function scorerFrom(raw: string | undefined): { provider: "gemini" | "openai"; gemini?: FactsGeminiChoice } | undefined {
  if (!raw) return undefined;
  const [model, level] = raw.split(":");
  if (/^gemini-/i.test(model)) {
    const t = (level ?? "").toLowerCase();
    return { provider: "gemini", gemini: { model, thinkingLevel: t === "low" || t === "medium" || t === "high" ? t : null } };
  }
  // The opt-in OpenAI evaluator reads its model and effort from its own settings (factsOnlyOpenAI.ts).
  process.env.MIA_FACTS_EVALUATOR_MODEL = model;
  if (level) process.env.MIA_FACTS_EVALUATOR_EFFORT = level;
  return { provider: "openai" };
}

async function resolveAthletes(list: string[]): Promise<Array<{ id: string; name: string; sport: string; stored: number | null }>> {
  const out: Array<{ id: string; name: string; sport: string; stored: number | null }> = [];
  for (const key of list) {
    const isId = /^[0-9a-f-]{36}$/i.test(key);
    const r: any = await db.execute(sql`
      select a.id, a.full_name as name, a.sport,
        (select (l.value->>'score')::int from intelligence_ledger l where l.subject_id = a.id and l.subject_type = 'athlete' and l.kind = 'ASSESSMENT'
           and l.owner = 'marketability' and l.superseded_by is null order by l.evidence_as_of desc limit 1) as stored
      from athletes a where ${isId ? sql`a.id = ${key}` : sql`lower(a.full_name) = lower(${key})`} order by a.created_at desc limit 1`);
    const row = (r.rows ?? r)[0];
    if (!row?.name || !row.sport) { console.log(`  skip ${key}: not on dev (or no name / sport)`); continue; }
    out.push({ id: row.id, name: row.name, sport: row.sport, stored: row.stored ?? null });
  }
  return out;
}

const s = (ms: number) => `${(ms / 1000).toFixed(0)}s`;
const d = (x: number) => `$${x.toFixed(3)}`;
const dims = (m: Record<string, number> | null) => (m ? MARKETABILITY_DIMENSIONS.map((k) => `${k.split("_").map((w) => w[0]).join("")}${m[k] ?? 0}`).join(" ") : "—");

function print(r: ShadowReport, run: number, stored: number | null) {
  const st = r.steps;
  console.log(`\n── ${r.athlete.name} (${r.athlete.sport}${r.athlete.team ? `, ${r.athlete.team}` : ""}) run ${run} — ${r.outcome}${r.unconfirmedReason ? `: ${r.unconfirmedReason}` : ""}`);
  console.log(`   facts: extracted ${r.facts.extracted} → checked ${r.facts.checked} → verified ${r.facts.verified} (verifier dropped ${r.facts.verifyDropped}; withheld ${r.facts.withheld})`);
  console.log(`   would write: ${r.wouldWrite.insert} new (${r.wouldWrite.disputed} disputed), ${r.wouldWrite.duplicates} duplicates of facts held, ${r.wouldWrite.dropped} refused`);
  console.log(`   by topic: ${JSON.stringify(r.facts.byTopic)}`);
  console.log(`   by dimension: ${dims(r.facts.byDimension)}   (aa athletic_authority · as audience_scale · eq engagement_quality · cr cultural_relevance · np narrative_power · bf brand_fit · cp commercial_proof · m momentum)`);
  console.log(`   sources: ${r.sources.distinct} cited · pages read ${r.sources.pagesRead} ${JSON.stringify(r.sources.byVia)} · Wikidata hits kept ${r.sources.wikidataHitsKept}/${r.sources.wikidataHitsSeen} · wrong-person pages ${r.sources.wrongPerson}`);
  console.log(`   follow-up: ${r.followUp.ran ? "ran" : "not run"} — ${r.followUp.reason}`);
  if (r.scorer.input) {
    const i = r.scorer.input;
    console.log(`   to the scorer (${i.selection}): ${i.publicSelected} of ${i.publicAboutHer} public facts (cap ${i.cap}, ${i.publicCut} cut), ${i.care} care, ${i.context} context, ${i.measured} measured (${i.measuredPublic ?? 0} public-platform; web-found audience numbers are public facts, never measured) · ${i.blockChars} chars`);
    console.log(`     selected by topic: ${JSON.stringify(i.selectedByTopic)}${i.publicCut ? `  cut: ${JSON.stringify(i.cutByTopic)}` : ""}`);
    console.log(`     selected by dimension: ${dims(r.scorer.inputByDimension)}`);
  }
  console.log(`   score: ${r.score.value ?? r.score.status}${r.score.error ? ` (${r.score.error})` : ""}${r.score.model ? ` · ${r.score.model}${r.score.conditions ? ` [${r.score.conditions}]` : ""}` : ""} · stored ${stored ?? "—"}`);
  console.log(`   time / cost: discovery ${s(st.discovery.ms)} ${d(st.discovery.usd)} · fetch ${s(st.fetch.ms)} · rank ${s(st.rank.ms)} · extract ${s(st.extract.ms)} ${d(st.extract.usd)} · verify ${s(st.verify.ms)} ${d(st.verify.usd)} · score ${s(st.score.ms)} ${d(st.score.usd)} · TOTAL ${s(r.total.ms)} ${d(r.total.usd)}`);
}

async function main() {
  const names = (arg("--athletes") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!names.length) { console.error("usage: leanRun.ts --athletes <ids|names> [--model m] [--scorer-model m] [--search openai|none] [--runs N] [--concurrency N] [--max-usd X] [--fresh] [--dry] [--json out]"); process.exit(2); }
  const search = (arg("--search") === "none" ? "none" : "openai") as LeanSearch;
  const runs = Math.max(1, Number(arg("--runs") ?? 1));
  const concurrency = Math.max(1, Number(arg("--concurrency") ?? 3));
  const maxUsd = Number(arg("--max-usd") ?? 2);
  const est = Number(process.env.LEAN_RUN_EST_USD ?? 0.6);
  const dry = flag("--dry");
  const scorer = scorerFrom(arg("--scorer-model"));
  const opts = {
    search, dry, fresh: flag("--fresh"), selection: (arg("--selection") === "default" ? "default" : "balanced") as "balanced" | "default",
    extractModel: parseModelChoice(arg("--model")), verifyModel: parseModelChoice(arg("--verify-model")), scorer,
  };
  console.log(`database: ${await assertDevDatabase()} (dev) · SHADOW: nothing is written`);
  const athletes = await resolveAthletes(names);
  const jobs = athletes.flatMap((a) => Array.from({ length: runs }, (_, i) => ({ a, run: i + 1 })));
  console.log(`lean research: ${athletes.length} athlete(s) × ${runs} run(s) · search ${search} · extract ${opts.extractModel ? `${opts.extractModel.model}:${opts.extractModel.effort}` : "skill default"} · scorer ${scorer?.gemini ? `${scorer.gemini.model}:${scorer.gemini.thinkingLevel ?? "default"}` : scorer?.provider ?? `${factsGeminiChoice().model} (service default)`} · selection ${opts.selection}${opts.fresh ? " · fresh" : ""}${dry ? " · DRY RUN (no paid call)" : ` · cap $${maxUsd} (reserve $${est}/run)`}`);
  let spent = 0, reserved = 0;
  const reports: Array<{ run: number; stored: number | null; report?: ShadowReport; error?: string }> = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      if (!dry && spent + reserved + est > maxUsd) { console.log(`  skip ${j.a.name} run ${j.run}: would pass the $${maxUsd} cap (spent $${spent.toFixed(2)}, reserved $${reserved.toFixed(2)})`); continue; }
      reserved += dry ? 0 : est;
      try {
        const r = await leanShadowRun(j.a, opts);
        spent += r.total.usd;
        print(r, j.run, j.a.stored);
        reports.push({ run: j.run, stored: j.a.stored, report: r });
      } catch (err: any) {
        console.log(`  ${j.a.name} run ${j.run} FAILED: ${String(err?.message ?? err).slice(0, 300)}`);
        reports.push({ run: j.run, stored: j.a.stored, error: String(err?.message ?? err).slice(0, 500) });
      } finally {
        reserved -= dry ? 0 : est;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  console.log(`\nSUMMARY (spent $${spent.toFixed(3)})`);
  console.log("athlete | run | outcome | verified | to scorer | score | stored | time | cost");
  for (const x of reports) {
    const r = x.report;
    console.log(r ? `${r.athlete.name} | ${x.run} | ${r.outcome} | ${r.facts.verified} | ${r.scorer.input?.publicSelected ?? "—"} | ${r.score.value ?? r.score.status} | ${x.stored ?? "—"} | ${s(r.total.ms)} | ${d(r.total.usd)}` : `? | ${x.run} | error | | | | | | ${x.error}`);
  }
  const out = arg("--json");
  if (out) {
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), options: { ...opts, runs, concurrency, maxUsd }, spentUsd: spent, reports: reports.map((x) => ({ run: x.run, stored: x.stored, error: x.error ?? null, ...(x.report ? { ...x.report, lean: { ...x.report.lean, rounds: x.report.lean.rounds.map((rd) => ({ ...rd, passages: rd.passages.map((p) => ({ id: p.id, url: p.url, chars: p.text.length })) })) } } : {}) })) }, null, 1));
    console.log(`JSON → ${out}`);
  }
}

if (require.main === module) main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
