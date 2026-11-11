/**
 * compareV2.ts — today's sign-up research (v1: two web-search passes + merge) against the narrow pipeline (v2:
 * agent/research/v2), athlete by athlete, on the DEV database only.
 *
 *   npx tsx server/scripts/research/compareV2.ts --limit 10            # DRY RUN (default): no provider calls, no cost
 *   npx tsx server/scripts/research/compareV2.ts --limit 10 --run      # runs v2 where no shadow run exists yet (costs money)
 *   npx tsx server/scripts/research/compareV2.ts --athlete <uuid> --run
 *   … --run --cleaners readability,defuddle --json out.json   # each athlete once per cleaner on the same pages
 *   … --with-handles           sign-up as if the athlete had connected their accounts (default: name, sport, team only)
 *   … --moment refresh         the refresh case: full record, plan aimed at what it lacks (sign-up is the default)
 *   … --replay out.json        no search at all: each athlete's pages are the ones a previous --json run read (its
 *                              passageUrls), fetched, cleaned, ranked and extracted again with today's code. Only the
 *                              extract call costs money; recall is limited to what that run read.
 *   … --max-usd 3              stop starting new athletes once the run's total (models + search fees) reaches this
 *
 * SIGN-UP FIRST (the default): v2 gets only what sign-up has — name, sport and the team the athlete gave; the
 * athlete's research facts are never shown to it (only what they said). The table shows whether v2 confirmed identity
 * or honestly said it couldn't, next to what v1 kept.
 *
 * v1 side: the athlete's latest finished signup_research / agent_onboarding run — research_a/b/merge step outputs and
 * timings (facts per pass, facts merged, cost, wall time); with no such run, the facts it left in the record (active
 * found memory_facts, else legacy athlete_facts; cost and time unknown). --athletes <uuid>,<uuid> picks a list. v2 side: the athlete's research_v2_shadow run when one
 * exists (the dev shadow), else — only with --run — the pipeline run here, stored nowhere but this table (it never
 * writes the athlete's record or score).
 *
 * Dry run prints, per athlete, the v2 plan (its queries) and the estimated v2 cost, so the paid run can be approved
 * knowing its price. Real runs need the owner's OK (owner rule: provider calls cost money).
 */
import "../../workflow/definitions";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { athletes } from "../../../shared/schema";
import { workflowRuns, workflowSteps } from "../../../shared/schemaWorkflow";
import { assertDevDatabase } from "../../lib/devDatabaseGuard";
import { dbStore } from "../../agent/research/dbStore";
import { planQueries, type ResearchMoment } from "../../agent/research/v2/plan";
import { loadConnectedChannels } from "../../agent/research/connected";
import { readLegacyRow } from "../../services/intelligence/context/legacyAdapter";
import { readFileSync, writeFileSync } from "node:fs";
import { discoverProviderOf, V2, type CleanerId } from "../../agent/research/v2/config";
import { openaiDiscover, type DiscoverQuery } from "../../agent/research/v2/discover";
import { runNarrowResearch, type PipelineMetrics } from "../../agent/research/v2/pipeline";
import { webSearchCallMicroUsd } from "../../agent/models";

/** Same query → same results (discovery is paid once per athlete, and both cleaners see identical pages). */
function memoDiscover(inner: DiscoverQuery): DiscoverQuery {
  const cache = new Map<string, ReturnType<DiscoverQuery>>();
  return (q) => {
    if (cache.has(q)) return cache.get(q)!.then((r) => ({ ...r, costMicroUsd: 0, searchQueries: 0, searchFeeMicroUsd: 0 }));   // paid once, counted once
    // A search call that never answers must not stall the whole comparison: give up after 90s (recorded as an error).
    const p = Promise.race([inner(q), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("discovery timed out after 90s")), 90_000).unref())]);
    cache.set(q, p);
    return p;
  };
}


/** Estimate (micro-dollars) of one v2 run: OpenAI discovery calls (one billed web search + tokens each) + one extract call. */
export function estimateV2MicroUsd(queries: number): number {
  const perQuery = webSearchCallMicroUsd() + 1_000;   // one web_search call ($0.01) + ~5k in / ~1k out on the fast tier ≈ $0.001
  const extract = Math.round((V2.maxPassageChars / 4) * 2 + 6_000 * 10);   // gpt-6.1-sol: ~12k in × $2/M + ~6k out × $10/M
  return queries * perQuery + extract;
}

/** Unique per invocation: runSkill reuses a finished run with the same parentRef, so a fixed ref would hand a rerun
 *  the previous run's extract answer (26 Oct: the second comparison silently reused the first one's facts). */
const RUN_STAMP = new Date().toISOString().replace(/[-:.TZ]/g, "");
const pagesCell = (m: PipelineMetrics) => `${m.pagesFound}/${m.pagesFetched}/${m.pagesFollowed ?? 0}/${m.wholePages ?? 0}`;

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const usd = (micro: number) => `$${(micro / 1e6).toFixed(3)}`;
const secs = (ms: number) => `${Math.round(ms / 1000)}s`;

interface V1Row { runId: string; factsA: number; factsB: number; merged: number; costMicroUsd: number; ms: number; stored?: { from: string; facts: number; sources: number; claims: Array<{ claim: string; source_url: string | null; topic: string | null }> } }

const v1Cell = (v1: V1Row) => v1.stored ? `${v1.stored.facts} stored (${v1.stored.sources} sources, ${v1.stored.from})` : `${v1.factsA}/${v1.factsB}→${v1.merged}`;

/**
 * When no v1 run exists (dev has none), today's v1 OUTPUT is what it left in the record: active found facts
 * (memory_facts), else the legacy athlete_facts. Cost and time are unknown then (shown as "-").
 */
async function v1Stored(athleteId: string): Promise<V1Row | null> {
  const rowsOf = (r: any): any[] => r.rows ?? r;
  const mrows = rowsOf(await db.execute(sql`select claim, source_url, topic from memory_facts where athlete_id = ${athleteId} and type = 'found' and status = 'active'`));
  const base = { runId: "stored", factsA: 0, factsB: 0, costMicroUsd: 0, ms: 0 };
  if (mrows.length) return { ...base, merged: mrows.length, stored: { from: "memory_facts", facts: mrows.length, sources: new Set(mrows.map((r) => r.source_url).filter(Boolean)).size, claims: mrows } };
  const arows = rowsOf(await db.execute(sql`select fact_key, value_text, provenance from athlete_facts where athlete_id = ${athleteId} and valid_to is null`));
  if (!arows.length) return null;
  // Legacy provenance carries cited domains (often none: "uncited").
  const urlOf = (r: any): string | null => r.provenance?.source_url ?? r.provenance?.url ?? r.provenance?.domains?.[0] ?? null;
  return { ...base, merged: arows.length, stored: { from: "athlete_facts", facts: arows.length, sources: new Set(arows.map(urlOf).filter(Boolean)).size, claims: arows.map((r) => ({ claim: `${r.fact_key}: ${r.value_text ?? ""}`, source_url: urlOf(r), topic: null })) } };
}

/** Pure: does the cited passage text carry the claim (every number, and most content words)? A support check, not a quote. */
export function supportedBy(claim: string, sourceText: string): boolean {
  const t = sourceText.toLowerCase();
  const nums = claim.match(/\d+(?:[.,]\d+)?/g) ?? [];
  if (nums.some((n) => !t.includes(n.toLowerCase()))) return false;
  const words = claim.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length >= 4);
  if (!words.length) return true;
  return words.filter((w) => t.includes(w)).length / words.length >= 0.6;
}

async function v1For(athleteId: string): Promise<V1Row | null> {
  const [run] = await db.select().from(workflowRuns)
    .where(and(eq(workflowRuns.athlete_id, athleteId), inArray(workflowRuns.process, ["signup_research", "agent_onboarding"]), eq(workflowRuns.status, "done")))
    .orderBy(desc(workflowRuns.started_at)).limit(1);
  if (!run) return null;
  const steps = await db.select().from(workflowSteps).where(and(eq(workflowSteps.run_id, run.id), inArray(workflowSteps.step, ["research_a", "research_b", "research_merge"])));
  const out = (name: string) => (steps.find((s) => s.step === name)?.output ?? {}) as any;
  const times = steps.flatMap((s) => [s.started_at, s.finished_at]).filter(Boolean).map((d) => new Date(d as any).getTime());
  return {
    runId: run.id, factsA: Number(out("research_a").facts ?? 0), factsB: Number(out("research_b").facts ?? 0), merged: Number(out("research_merge").inserted ?? 0),
    costMicroUsd: Number(out("research_a").cost_micro_usd ?? 0) + Number(out("research_b").cost_micro_usd ?? 0) + Number(out("research_merge").cost_micro_usd ?? 0),
    ms: times.length ? Math.max(...times) - Math.min(...times) : 0,
  };
}

async function shadowFor(athleteId: string, moment: ResearchMoment): Promise<PipelineMetrics | null> {
  // Shadows record their moment in metrics; ones from before moments existed were sign-up shadows.
  const m = await latestShadow(athleteId);
  return m && (m.moment ?? "signup") === moment ? m : null;
}

async function latestShadow(athleteId: string): Promise<PipelineMetrics | null> {
  const [run] = await db.select().from(workflowRuns)
    .where(and(eq(workflowRuns.athlete_id, athleteId), eq(workflowRuns.process, "research_v2_shadow"), eq(workflowRuns.status, "done")))
    .orderBy(desc(workflowRuns.started_at)).limit(1);
  if (!run) return null;
  const [step] = await db.select().from(workflowSteps).where(and(eq(workflowSteps.run_id, run.id), eq(workflowSteps.step, "shadow")));
  return ((step?.output ?? {}) as any).metrics ?? null;
}

async function main(): Promise<void> {
  await assertDevDatabase();
  const run = process.argv.includes("--run");
  const limit = Math.min(Number(arg("--limit") ?? 10) || 10, 50);
  const one = arg("--athlete");
  const many = one ? [one] : (arg("--athletes") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const rows = many.length
    ? (await db.select({ id: athletes.id, name: athletes.full_name, sport: athletes.sport }).from(athletes).where(inArray(athletes.id, many)))
      .sort((x, y) => many.indexOf(x.id) - many.indexOf(y.id))
    : await db.select({ id: athletes.id, name: athletes.full_name, sport: athletes.sport }).from(athletes).orderBy(desc(athletes.created_at)).limit(limit * 3);
  const provider = discoverProviderOf();
  const moment: ResearchMoment = arg("--moment") === "refresh" ? "refresh" : "signup";
  const withHandles = moment === "refresh" || process.argv.includes("--with-handles");
  const today = new Date().toISOString().slice(0, 10);
  // --cleaners readability,defuddle: with --run, each athlete is run once per cleaner, fresh, on the SAME discovered
  // pages (discovery is shared; each cleaner fetches those URLs itself). Without it: the dev shadow, else one run.
  const cleaners = (arg("--cleaners") ?? "").split(",").map((c) => c.trim()).filter((c): c is CleanerId => c === "readability" || c === "defuddle");
  const jsonOut = arg("--json");
  const replay = arg("--replay");
  const replayUrls = new Map<string, string[]>(replay
    ? (JSON.parse(readFileSync(replay, "utf8")) as Array<{ athlete: { id: string }; passageUrls?: string[] }>).map((r) => [r.athlete.id, r.passageUrls ?? []])
    : []);
  const dump: unknown[] = [];
  console.log(`moment: ${moment}${moment === "signup" ? ` (name, sport, team${withHandles ? ", connected handles" : ""})` : " (full record)"}${cleaners.length ? ` · cleaners: ${cleaners.join(", ")}` : ""}`);
  const table: string[] = ["athlete | v1 facts (a/b→merged) | v1 cost | v1 time | v2 identity | v2 facts | v2 sources | v2 wrong-person | v2 neutral pages | v2 chars→model | v2 pages found/fetched/followed/whole | v2 searches (fee) | v2 cost | v2 time | status"];
  const maxMicroUsd = Math.round(Number(arg("--max-usd") ?? 0) * 1e6);
  let spentMicroUsd = 0;
  let shown = 0, estimate = 0;
  for (const a of rows) {
    if (shown >= limit) break;
    if (!a.name || !a.sport) continue;
    const v1 = (await v1For(a.id)) ?? (await v1Stored(a.id));
    if (!v1) continue;
    shown++;
    let m = await shadowFor(a.id, moment);
    let status = m ? "shadow" : "no v2 yet";
    // Only what this moment has: sign-up sees the team the athlete gave and what they said, never research facts.
    const team = (await readLegacyRow(a.id).catch(() => null))?.school ?? null;
    const handles = withHandles ? (await loadConnectedChannels(a.id).catch(() => [])).map((c) => c.handle).filter((h): h is string => !!h) : [];
    const allFacts = run || moment === "refresh" ? await dbStore.listFacts(a.id, ["active", "disputed"]) : [];
    const known = moment === "signup" ? allFacts.filter((f) => f.type === "said") : allFacts;
    if (run && maxMicroUsd && spentMicroUsd >= maxMicroUsd) { console.log(`spend cap ${usd(maxMicroUsd)} reached (${usd(spentMicroUsd)}): stopping`); break; }
    if (run && cleaners.length) {
      // Replay: the first planned query "finds" the earlier run's pages; the rest find nothing. No provider is called.
      let replayed = false;
      const discoverQuery: DiscoverQuery = replay
        ? async () => { const urls = replayed ? [] : replayUrls.get(a.id) ?? []; replayed = true; return { results: urls.map((url) => ({ url })), costMicroUsd: 0, searchQueries: 0, searchFeeMicroUsd: 0 }; }
        : memoDiscover(openaiDiscover());
      // Fetches are NOT shared: a shared response keeps the first caller's abort timer, so a later cleaner would read
      // already-aborted bodies (every page "timeout", and a read can hang). Each cleaner fetches the same URLs itself.
      for (const cleaner of cleaners) {
        console.log(`… ${a.id.slice(0, 8)} · ${cleaner}`);
        const out = await runNarrowResearch(
          { store: dbStore, athleteId: a.id, parentPrefix: `compare-v2:${cleaner}:${Date.now()}` },
          { athlete: { name: a.name, sport: a.sport }, team, handles, known, today, moment },
          { provider, discoverQuery, cleaner },
          `compare-v2:${cleaner}:${a.id}:${RUN_STAMP}`,
        );
        const mm = out.metrics;
        spentMicroUsd += mm.costMicroUsd.total;
        const textOf = (url: string) => out.passages.filter((p) => p.url === url).map((p) => p.text).join("\n\n");
        const facts = (out.result?.facts ?? []).map((f) => ({ claim: f.claim, topic: f.topic, source_url: f.source_url, source_type: f.source_type, date: f.date, confidence: f.confidence, supported: supportedBy(f.claim, textOf(f.source_url ?? "")) }));
        table.push([
          a.id.slice(0, 8), v1Cell(v1), v1.stored ? "-" : usd(v1.costMicroUsd), v1.stored ? "-" : secs(v1.ms),
          mm.outcome === "unconfirmed" ? `couldn't confirm (${mm.factsWithheld} withheld): ${mm.unconfirmedReason}` : mm.outcome,
          String(mm.factsKept), String(mm.distinctSources), String(mm.wrongPersonRejections), String(mm.neutralPages ?? 0), String(mm.passageChars), pagesCell(mm), `${mm.searchQueries ?? 0} (${usd(mm.searchFeeMicroUsd ?? 0)})`, usd(mm.costMicroUsd.total), secs(mm.ms.total), `run here · ${cleaner}`,
        ].join(" | "));
        dump.push({ athlete: { id: a.id, name: a.name, sport: a.sport, team }, cleaner, v1, metrics: mm, wrongPerson: out.wrongPerson, facts, identityQuestion: out.identityQuestion,
          passages: out.passages.map((p) => ({ id: p.id, url: p.url, unverified: !!p.unverified })),
          passageUrls: [...new Set(out.passages.map((p) => p.url))],
          dropped: out.result?.dropped ?? [], identity: out.result?.identity ?? null });
      }
      continue;
    }
    if (!m && run) {
      const out = await runNarrowResearch(
        { store: dbStore, athleteId: a.id, parentPrefix: `compare-v2:${Date.now()}` },
        { athlete: { name: a.name, sport: a.sport }, team, handles, known, today, moment },
        { provider, discoverQuery: openaiDiscover() },
        `compare-v2:${a.id}:${RUN_STAMP}`,
      );
      m = out.metrics;
      spentMicroUsd += m.costMicroUsd.total;
      status = "run here";
    }
    if (!m) {
      const plan = planQueries({ name: a.name, sport: a.sport, team, handles, today, moment, known });
      estimate += estimateV2MicroUsd(plan.length);
      console.log(`plan for ${a.id.slice(0, 8)}: ${plan.map((p) => p.q).join(" | ")}`);
    }
    table.push([
      a.id.slice(0, 8), v1Cell(v1), v1.stored ? "-" : usd(v1.costMicroUsd), v1.stored ? "-" : secs(v1.ms),
      m ? (m.outcome === "unconfirmed" ? `couldn't confirm (${m.factsWithheld} withheld): ${m.unconfirmedReason}` : m.outcome ?? (m.identityResolved ? "confirmed" : "unclear")) : "-",
      m ? String(m.factsKept) : "-", m ? String(m.distinctSources) : "-", m ? String(m.wrongPersonRejections) : "-", m ? String(m.neutralPages ?? 0) : "-",
      m ? String(m.passageChars) : "-", m ? pagesCell(m) : "-", m ? `${m.searchQueries ?? 0} (${usd(m.searchFeeMicroUsd ?? 0)})` : "-", m ? usd(m.costMicroUsd.total) : "-", m ? secs(m.ms.total) : "-", status,
    ].join(" | "));
  }
  console.log(table.join("\n"));
  if (run) console.log(`\ntotal spent this run: ${usd(spentMicroUsd)} (models + search fees at list price)`);
  if (jsonOut && dump.length) { writeFileSync(jsonOut, JSON.stringify(dump, null, 1)); console.log(`\nwrote ${dump.length} runs to ${jsonOut}`); }
  if (!run && cleaners.length > 1) estimate = Math.round(estimate * 1.6);   // discovery is shared; the extract call is per cleaner
  if (!run && estimate) console.log(`\nDRY RUN. Running v2 for the athletes above without a shadow would cost about ${usd(estimate)} (re-run with --run).`);
  process.exit(0);
}

main().catch((err) => { console.error(String(err?.message ?? err)); process.exit(1); });
