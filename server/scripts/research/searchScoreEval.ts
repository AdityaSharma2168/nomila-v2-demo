/**
 * searchScoreEval.ts — quick search + M.I.A. score, compared fairly across Vertex models (DEV database only).
 * The setups, the grader and the prices are described in searchScoreEval.lib.ts.
 *
 *   npx tsx server/scripts/research/searchScoreEval.ts                    # DRY RUN (default): plan + cost estimate; no DB, no provider calls
 *   npx tsx server/scripts/research/searchScoreEval.ts --run              # paid: needs the owner's OK (provider calls cost money)
 *   … --athletes "Mia Bhuta,Hannah Yu"   (default: the five in DEFAULT_ATHLETES)
 *   … --runs 2                            runs per athlete per setup (default 2)
 *   … --max-usd 20                        stop starting new athlete-runs once spend (incl. grading) reaches this (default 20)
 *   … --json out.json                     every run's record (replies' scores, facts, steps, grades)
 *
 * DEEPSEEK_SEARCH_BACKEND=on adds DeepSeek's Search API as a search_web tool for setup 2 (key: Secret Manager
 * DEEPSEEK_API_KEY). OFF by default and not part of the approved run.
 *
 * Read-only on the database: athletes, their memory facts (said + measured + found anchor) and the stored M.I.A. score.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { and, eq, ilike } from "drizzle-orm";
import { GoogleAuth } from "google-auth-library";
import { db } from "../../db";
import { athletes, connectedAccounts } from "../../../shared/schema";
import { assertDevDatabase } from "../../lib/devDatabaseGuard";
import { genai } from "../../lib/models";
import { fetchAndClean } from "../../agent/research/v2/fetchClean";
import { V2 } from "../../agent/research/v2/config";
import { loadBeta1Params } from "../../services/marketabilityBeta1Params";
import { createBeta1Normalizer } from "../../services/marketabilityBeta1Normalization";
import { getMarketability } from "../../services/marketabilityBeta1Orchestrator";
import { composeBlock, loadMemoryFacts, measuredAccounts, selectPreviewFacts } from "../../services/miaPreview/memoryAdapter";
import {
  DEEPSEEK_MODEL, ESTIMATE_ASSUMPTIONS, GEMINI_MODEL, GRADER_MODEL, PRICES, estimateRunUsd, frozenPrompt, grade,
  runCost, runDeepSeekLoop, runGeminiOneCall, runMs, summarise,
  type AthleteCase, type ChatResult, type GeminiResult, type Providers, type ScoringContext, type SetupRun, type Usage, type WikidataHit,
} from "./searchScoreEval.lib";

export const DEFAULT_ATHLETES = ["Mia Bhuta", "Hannah Yu", "Caitlin Clark", "Moh Bility", "Ellie Lebe"];
const PROJECT = "gamechanger-pocket-agent";
const VERTEX_CHAT_URL = `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global/endpoints/openapi/chat/completions`;

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
const flag = (name: string) => process.argv.includes(name);

// ── real providers ────────────────────────────────────────────────────────────

const gauth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

async function gemini(req: Parameters<Providers["gemini"]>[0]): Promise<GeminiResult> {
  const t0 = Date.now();
  const config: any = { temperature: 1.0, maxOutputTokens: 65536, thinkingConfig: { thinkingLevel: req.thinkingLevel } };
  if (req.system) config.systemInstruction = req.system;
  if (req.search) config.tools = [{ googleSearch: {} }];
  const r: any = await genai().models.generateContent({ model: req.model, contents: [{ role: "user", parts: [{ text: req.user }] }], config });
  const u = r.usageMetadata ?? {};
  const gm = r.candidates?.[0]?.groundingMetadata ?? {};
  const usage: Usage = {
    input: u.promptTokenCount ?? 0, cached: u.cachedContentTokenCount ?? 0, output: u.candidatesTokenCount ?? 0, thinking: u.thoughtsTokenCount ?? 0,
    searches: (gm.webSearchQueries ?? []).length, toolCalls: 0,
  };
  return {
    text: r.text ?? "", usage, ms: Date.now() - t0,
    native: {
      chunks: (gm.groundingChunks ?? []).map((c: any) => ({ uri: String(c.web?.uri ?? ""), title: String(c.web?.title ?? "") })),
      supports: (gm.groundingSupports ?? []).map((s: any) => ({ text: String(s.segment?.text ?? ""), chunks: s.groundingChunkIndices ?? [] })),
      queries: gm.webSearchQueries ?? [],
    },
  };
}

/** At most this many DeepSeek calls in flight (owner, 26 Oct: fewer parallel calls, fewer connection drops). */
const DEEPSEEK_CONCURRENCY = Number(process.env.SEARCH_SCORE_DEEPSEEK_CONCURRENCY ?? 2);
let dsActive = 0; const dsWaiting: Array<() => void> = [];
async function withDeepSeekSlot<T>(model: string, fn: () => Promise<T>): Promise<T> {
  if (!model.startsWith("deepseek")) return fn();
  if (dsActive >= DEEPSEEK_CONCURRENCY) await new Promise<void>((r) => dsWaiting.push(r));
  dsActive++;
  try { return await fn(); } finally { dsActive--; dsWaiting.shift()?.(); }
}

async function vertexChat(req: Parameters<Providers["vertexChat"]>[0]): Promise<ChatResult> {
  return withDeepSeekSlot(req.model, () => vertexChatOnce(req));
}

async function vertexChatOnce(req: Parameters<Providers["vertexChat"]>[0]): Promise<ChatResult> {
  const t0 = Date.now();
  // Verified 26 Oct 2026: on Vertex MaaS, DeepSeek V4.1 Flash thinks only with chat_template_kwargs.thinking=true (the
  // default is OFF; `thinking: {type: "enabled"}` is ignored). Reasoning tokens are counted inside completion_tokens.
  // reasoning_effort (DeepSeek's documented levels) rides in chat_template_kwargs, the vLLM shape Vertex serves; probed
  // 26 Oct 2026: accepted without error (on a tiny probe the thinking length barely moved, so the full runs record it).
  const body: any = { model: req.model, messages: req.messages, max_tokens: req.maxTokens, chat_template_kwargs: { thinking: req.thinking, ...(req.thinking && req.effort ? { reasoning_effort: req.effort } : {}) } };
  if (req.tools?.length) body.tools = req.tools;
  // Long answers (a 44-signal JSON with thinking takes 4–6 minutes) outlive Node fetch's 300 s wait for response
  // headers, so calls without tools STREAM: headers arrive at once and the text is assembled from the chunks.
  const stream = !req.tools?.length;
  if (stream) { body.stream = true; body.stream_options = { include_usage: true }; }
  if (req.json) body.response_format = { type: "json_object" };
  for (let attempt = 0; ; attempt++) {
    // A fresh token each attempt (the auth library refreshes it before expiry).
    const token = await gauth.getAccessToken();
    let res: Response;
    try {
      res = await fetch(VERTEX_CHAT_URL, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "x-goog-user-project": PROJECT }, body: JSON.stringify(body), signal: AbortSignal.timeout(Number(process.env.SEARCH_SCORE_CHAT_TIMEOUT_MS ?? 900_000)) });
    } catch (e: any) {
      // Connection-level failure ("fetch failed": reset, DNS, TLS): retry with backoff like a 5xx.
      if (attempt < 3) { if (process.env.SEARCH_SCORE_DEBUG) console.log(`[debug retry ${req.model}] ${String(e?.cause?.code ?? e?.message ?? e)}`); await new Promise((r) => setTimeout(r, 5000 * (attempt + 1))); continue; }
      throw e;
    }
    if (!res.ok) {
      if (attempt < 3 && (res.status === 429 || res.status >= 500)) { await new Promise((r) => setTimeout(r, 5000 * (attempt + 1))); continue; }
      throw new Error(`vertex ${req.model} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    if (stream) {
      let content = ""; let reasoning = ""; let finish: string | null = null; let su: any = {};
      const dec = new TextDecoder(); let buf = "";
      for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const ev = JSON.parse(data);
            const ch = ev.choices?.[0];
            if (ch?.delta?.content) content += ch.delta.content;
            if (ch?.delta?.reasoning_content) reasoning += ch.delta.reasoning_content;
            if (ch?.finish_reason) finish = ch.finish_reason;
            if (ev.usage) su = ev.usage;
          } catch { /* partial or non-JSON keep-alive line */ }
        }
      }
      if (process.env.SEARCH_SCORE_DEBUG) console.log(`[debug stream ${req.model}] finish=${finish} content=${content.length}c reasoning=${reasoning.length}c usage=${JSON.stringify({ p: su.prompt_tokens, c: su.completion_tokens })}`);
      // When the answer text holds no JSON but the reasoning ends with it, take it from there.
      if (!/\{[\s\S]*\}/.test(content) && /\{[\s\S]*\}/.test(reasoning)) content = reasoning.slice(reasoning.indexOf("{"));
      return {
        message: { content },
        usage: { input: su.prompt_tokens ?? 0, cached: su.prompt_tokens_details?.cached_tokens ?? 0, output: su.completion_tokens ?? 0, thinking: 0, searches: 0, toolCalls: 0 },
        ms: Date.now() - t0,
      };
    }
    const j: any = await res.json();
    const u = j.usage ?? {};
    if (process.env.SEARCH_SCORE_DEBUG) { const m = j.choices?.[0]?.message ?? {}; console.log(`[debug chat ${req.model}] finish=${j.choices?.[0]?.finish_reason} content=${(m.content ?? "").length}c reasoning=${(m.reasoning_content ?? "").length}c tools=${(m.tool_calls ?? []).length} usage=${JSON.stringify({ p: u.prompt_tokens, c: u.completion_tokens })}`); }
    const msg = j.choices?.[0]?.message ?? {};
    const noJsonInContent = !/\{[\s\S]*\}/.test(msg.content ?? "") && !(msg.tool_calls ?? []).length;
    return {
      message: { content: noJsonInContent && /\{[\s\S]*\}/.test(msg.reasoning_content ?? "") ? String(msg.reasoning_content).slice(String(msg.reasoning_content).indexOf("{")) : msg.content ?? null, reasoning_content: msg.reasoning_content ?? undefined, tool_calls: j.choices?.[0]?.message?.tool_calls ?? undefined },
      usage: { input: u.prompt_tokens ?? 0, cached: u.prompt_tokens_details?.cached_tokens ?? 0, output: u.completion_tokens ?? 0, thinking: 0, searches: 0, toolCalls: 0 },
      ms: Date.now() - t0,
    };
  }
}

async function fetchPages(urls: string[]) {
  const out = await fetchAndClean(urls, fetch, { cleaner: "defuddle" });
  return out.map((o) => ({ url: o.page?.url ?? o.url, title: o.page?.title ?? "", text: o.page?.text ?? "", skipped: o.skipped }));
}

/** Wikidata (CC0, free): search, then the claims that anchor an athlete. Labels for referenced items in one more call. */
const WD = "https://www.wikidata.org/w/api.php";
const WD_PROPS: Record<string, string> = { P641: "sport", P54: "member of sports team", P69: "educated at", P413: "position played", P27: "country of citizenship", P1532: "country for sport", P569: "date of birth" };
async function wdGet(params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams({ format: "json", origin: "*", ...params });
  const res = await fetch(`${WD}?${qs}`, { headers: { "user-agent": V2.userAgent }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`wikidata ${res.status}`);
  return res.json();
}
export async function wikidata(query: string): Promise<WikidataHit[]> {
  const s = await wdGet({ action: "wbsearchentities", search: query, language: "en", limit: "5", type: "item" });
  const ids: string[] = (s.search ?? []).map((x: any) => x.id);
  if (!ids.length) return [];
  const e = await wdGet({ action: "wbgetentities", ids: ids.join("|"), props: "labels|descriptions|claims|sitelinks", languages: "en" });
  const refIds = new Set<string>();
  const valueOf = (c: any) => c?.mainsnak?.datavalue?.value;
  for (const id of ids) for (const p of Object.keys(WD_PROPS)) for (const c of e.entities?.[id]?.claims?.[p] ?? []) { const v = valueOf(c); if (v?.id) refIds.add(v.id); }
  const labels = new Map<string, string>();
  const ref = [...refIds].slice(0, 50);
  if (ref.length) { const l = await wdGet({ action: "wbgetentities", ids: ref.join("|"), props: "labels", languages: "en" }); for (const id of ref) labels.set(id, l.entities?.[id]?.labels?.en?.value ?? id); }
  return ids.map((id) => {
    const ent = e.entities?.[id] ?? {};
    const facts: string[] = [];
    for (const [p, name] of Object.entries(WD_PROPS)) for (const c of (ent.claims?.[p] ?? []).slice(0, 6)) {
      const v = valueOf(c); const shown = v?.id ? labels.get(v.id) ?? v.id : v?.time ? String(v.time).slice(1, 11) : typeof v === "string" ? v : null;
      if (shown) facts.push(`${name}: ${shown}`);
    }
    const site = valueOf((ent.claims?.P856 ?? [])[0]);
    const title = ent.sitelinks?.enwiki?.title;
    return { id, label: ent.labels?.en?.value ?? "", description: ent.descriptions?.en?.value ?? "", officialWebsite: typeof site === "string" ? site : null, enwiki: title ? `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}` : null, facts };
  });
}

/** DeepSeek Search API (OFF unless DEEPSEEK_SEARCH_BACKEND=on). The key is read from Secret Manager into memory only. */
function deepseekSearchProvider(): Providers["deepseekSearch"] {
  if (process.env.DEEPSEEK_SEARCH_BACKEND !== "on") return undefined;
  let key = "";
  try { key = execFileSync("gcloud", ["secrets", "versions", "access", "latest", "--secret=DEEPSEEK_API_KEY", `--project=${PROJECT}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: process.platform === "win32" }).trim(); } catch { /* reported below */ }
  if (!key) throw new Error("DEEPSEEK_SEARCH_BACKEND=on but Secret Manager secret DEEPSEEK_API_KEY is missing or unreadable — create it (see the PR) or leave the backend off");
  return async (query) => {
    const res = await fetch("https://api.deepseek.com/v1/tools/search", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: query.slice(0, 128), count: 8, need_content: false }), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`deepseek search ${res.status}`);
    const j: any = await res.json();
    return (j.results ?? j.data ?? []).map((r: any) => ({ title: String(r.title ?? ""), url: String(r.url ?? ""), summary: String(r.summary ?? r.snippet ?? "") }));
  };
}

/** The real providers (Vertex Gemini + MaaS chat, our fetcher, Wikidata; DeepSeek Search only when switched on). */
export function realProviders(): Providers {
  return { gemini, vertexChat, fetchPages, wikidata, deepseekSearch: deepseekSearchProvider() };
}

// ── athletes (dev DB, read-only) ───────────────────────────────────────────────

async function loadCase(name: string): Promise<AthleteCase | null> {
  const rows = await db.select({ id: athletes.id, name: athletes.full_name, sport: athletes.sport }).from(athletes).where(ilike(athletes.full_name, name));
  // Several dev rows can share a name: prefer the one with a stored M.I.A. score.
  let pick: (typeof rows)[number] | null = null; let ref: Awaited<ReturnType<typeof getMarketability>> = null;
  for (const r of rows) { const m = await getMarketability(r.id); if (m) { pick = r; ref = m; break; } pick ??= r; }
  if (!pick?.name || !pick.sport) return null;
  const facts = await loadMemoryFacts(pick.id, ["active"]);
  const said = facts.filter((f) => f.type === "said").map((f) => f.claim);
  const { public: pub, measured } = selectPreviewFacts(facts);
  const conns = await db.select({ platform: connectedAccounts.platform, username: connectedAccounts.platform_username }).from(connectedAccounts)
    .where(and(eq(connectedAccounts.athlete_id, pick.id), eq(connectedAccounts.status, "active")));
  const handles = new Map(conns.filter((c) => c.username).map((c) => [c.platform, String(c.username).replace(/^@+/, "")]));
  const accounts = measuredAccounts(measured, handles, new Set()).map((m) => m.account);
  return {
    id: pick.id, name: pick.name, sport: pick.sport, said, accounts, socialBlock: composeBlock(accounts, []),
    reference: { score: ref?.score ?? null, anchor: [...said, ...pub.filter((f) => f.subjectKind === "athlete").slice(0, 12).map((f) => f.claim)] },
  };
}

function placeholderCase(name: string): AthleteCase {
  return { id: "dry-run", name, sport: "<sport>", said: ["<said facts>"], accounts: [], socialBlock: null, reference: { score: null, anchor: [] } };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const names = (arg("--athletes") ?? DEFAULT_ATHLETES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const runs = Number(arg("--runs") ?? 2);
  const maxUsd = Number(arg("--max-usd") ?? 20);
  const paid = flag("--run");
  const setups = (arg("--setups") ?? "gemini_one_call,deepseek_loop_low,deepseek_loop_off").split(",").map((s) => s.trim());

  // Prompt sizes for the estimate come from the real prompt texts (≈ 4 characters a token).
  const ph = placeholderCase("Placeholder Athlete");
  const tok = (s: string) => Math.ceil(s.length / 4);
  const est = estimateRunUsd({ frozen: tok(frozenPrompt(ph)), factsOnly: 0, skill: 0 }, names.length, runs);
  const partB = { gemini_one_call: est.perAthleteRun.gemini_one_call, deepseek_loop: est.perAthleteRun.deepseek_loop };
  const total = (partB.gemini_one_call + partB.deepseek_loop) * names.length * runs;
  console.log(`PART B: ${names.length} athletes × ${runs} runs × setups [gemini_one_call, deepseek_loop] (setup 3 is replaced by Part A, scorerHeadToHead.ts)`);
  console.log(`  models: ${GEMINI_MODEL} (low thinking, Google Search grounding) · ${DEEPSEEK_MODEL} (thinking on, Wikidata + our fetcher) · grader ${GRADER_MODEL}`);
  console.log(`  DeepSeek Search backend: ${process.env.DEEPSEEK_SEARCH_BACKEND === "on" ? "ON" : "off (default)"}`);
  console.log(`  prices (Jan 2027 list): Gemini 3.8 Flash $${PRICES["gemini-3.8-flash"].in}/$${PRICES["gemini-3.8-flash"].out} per 1M · grounding $${PRICES.groundingPerQuery}/query · DeepSeek $${PRICES[DEEPSEEK_MODEL].in}/$${PRICES[DEEPSEEK_MODEL].out} · GLM-5.2 $${PRICES[GRADER_MODEL].in}/$${PRICES[GRADER_MODEL].out}`);
  for (const [k, v] of Object.entries(partB)) console.log(`    ${k.padEnd(20)} $${v.toFixed(3)} per athlete-run (incl. grading)`);
  console.log(`  ESTIMATED TOTAL: $${total.toFixed(2)} (cap --max-usd ${maxUsd}); assumptions: ${JSON.stringify(ESTIMATE_ASSUMPTIONS)}`);
  if (!paid) { console.log("\nDRY RUN — no database reads, no provider calls. Add --run (owner's OK required) to run."); return; }

  await assertDevDatabase();
  const { params, bundle } = await loadBeta1Params();
  const normalizer = createBeta1Normalizer(bundle);
  const ctx: ScoringContext = { params, subWeights: params.config.subWeights, prior: (p, s) => normalizer.prior(p as never, s as never) as any };
  const providers = realProviders();

  const cases: AthleteCase[] = [];
  for (const n of names) { const c = await loadCase(n); if (c) cases.push(c); else console.log(`skip: no dev athlete named "${n}"`); }
  const all: SetupRun[] = [];
  let spent = 0;
  const asOf = new Date().toISOString();
  outer: for (let run = 1; run <= runs; run++) {
    for (const a of cases) {
      if (spent >= maxUsd) { console.log(`STOP: spend $${spent.toFixed(2)} reached --max-usd ${maxUsd}`); break outer; }
      const safe = <T,>(p: Promise<T>, label: string) => p.catch((e) => { console.log(`  ${a.name} ${label}: ${String(e?.message ?? e).slice(0, 200)}`); return null; });
      const batch = (await Promise.all([
        setups.includes("gemini_one_call") ? safe(runGeminiOneCall(providers, a, ctx, run, asOf), "gemini_one_call") : null,
        setups.includes("deepseek_loop") ? safe(runDeepSeekLoop(providers, a, ctx, run, asOf, "default"), "deepseek_loop") : null,
        setups.includes("deepseek_loop_low") ? safe(runDeepSeekLoop(providers, a, ctx, run, asOf, "low"), "deepseek_loop_low") : null,
        setups.includes("deepseek_loop_off") ? safe(runDeepSeekLoop(providers, a, ctx, run, asOf, "off"), "deepseek_loop_off") : null,
      ])).filter((x): x is SetupRun => !!x);
      for (const r of batch) {
        r.grade = await safe(grade(providers, a, r), `grade ${r.setup}`);
        spent += runCost(r) + (r.grade?.costUsd ?? 0);
      }
      all.push(...batch);
      for (const r of batch) console.log(`  run ${run} ${a.name.padEnd(16)} ${r.setup.padEnd(16)} score ${r.result?.score ?? "—"} (ref ${a.reference.score ?? "—"}) · ${(runMs(r) / 1000).toFixed(0)}s · $${runCost(r).toFixed(3)}${r.error ? ` · ERROR ${r.error}` : ""}${r.grade?.wrongPerson === true ? " · WRONG PERSON" : ""}`);
    }
  }
  console.log("\nSUMMARY (cost per run excludes grading)");
  for (const s of summarise(all, cases)) {
    console.log(`  ${s.setup.padEnd(16)} runs ${s.runs} failed ${s.failed} · |Δ vs stored| ${s.meanAbsDelta?.toFixed(0) ?? "—"} · spread ${s.meanSpread?.toFixed(0) ?? "—"} · wrong person ${s.wrongPerson} · unsupported facts ${s.unsupported} · ${(s.meanMs / 1000).toFixed(0)}s · $${s.meanCostUsd.toFixed(3)}`);
  }
  console.log(`PART B SPENT: $${spent.toFixed(2)} (incl. grading)`);
  const out = arg("--json");
  if (out) writeFileSync(out, JSON.stringify({ cases: cases.map((c) => ({ name: c.name, sport: c.sport, reference: c.reference.score })), runs: all, spent }, null, 1));
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
