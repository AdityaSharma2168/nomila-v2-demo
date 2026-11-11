/**
 * blindEval/runBlindEval.ts — LOCAL EXPERIMENT (14 Sep 2026): blind athlete marketability evaluation by three providers under
 * identical inputs (name + sport + the frozen spec). Nothing from Nomila's tables, scores, targets or cohort files is read.
 * Raw text + provider-native grounding/citations + the parsed 44-signal JSON + model/latency/tokens/cost are frozen to disk
 * per athlete BEFORE any comparison. No production path is touched.
 *
 *   npx tsx --require dotenv/config server/scripts/calibration/blindEval/runBlindEval.ts --provider gemini|kimi|openai [--keys a,b] --run
 *
 * Provider conditions (recorded in every artifact):
 *   gemini  gemini-3.5-flash, Google Search grounding, DEFAULT thinking (this is a judgment task; no MINIMAL override), text output
 *   openai  gpt-5.4-mini, web_search tool + action.sources included, DEFAULT reasoning (no effort override), text output
 *   kimi    kimi-k2.6 on the Moonshot API with the builtin $web_search tool (loop until the model stops calling it), DEFAULT thinking
 */
import OpenAI from "openai";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { genai, GEMINI, KIMI } from "../../../lib/models";
import { OPENAI_RESEARCH_MODEL } from "../../../lib/research/providers/openaiWebSearch";
import { MARKETABILITY_BETA1_FROZEN_PARAMS } from "../../../services/marketabilityBeta1FrozenParams";
import { extractJson, normalizeJudgements } from "../../../services/marketabilityBeta1Evaluator";
import { BLIND_EVAL_ATHLETES, BLIND_EVAL_SPEC_VERSION, BLIND_EVAL_SPEC_V02_VERSION, blindEvalPrompt, blindEvalPromptV02, type BlindEvalAthlete } from "../../../services/marketabilityBeta1EvaluatorSpec";

export type Provider = "gemini" | "kimi" | "openai";
const RUNS_V01 = join(__dirname, "..", "runs", "blind-eval");
const RUNS_V02 = join(__dirname, "..", "runs", "blind-eval-v2");
export type SpecVersion = "v0.1" | "v0.2";
const RATES: Record<Provider, { perCallUsd: number; inPerM: number; outPerM: number; note: string }> = {
  gemini: { perCallUsd: 0.035, inPerM: 1.5, outPerM: 9.0, note: "benchmark cost model (gemini_direct); output includes thought tokens" },
  openai: { perCallUsd: 0.01, inPerM: 0.75, outPerM: 4.5, note: "benchmark cost model (openai_direct)" },
  kimi: { perCallUsd: 0, inPerM: 0.6, outPerM: 2.5, note: "approximate; Moonshot kimi-k2.6 list price not verified" },
};

export interface RawArtifact {
  specVersion: string; provider: Provider; model: string; modelVersion?: string | null; responseId?: string | null; athlete: BlindEvalAthlete; conditions: string;
  startedAt: string; latencyMs: number; attempts: number; finishReason: string | null; truncated: boolean;
  usage: { promptTokens: number | null; outputTokens: number | null; thoughtTokens: number | null; totalTokens: number | null; searchCalls: number | null };
  costUsd: number | null;
  text: string;
  native: unknown;   // provider-native grounding / citations / sources / search queries
  error: string | null;
}

// ─── JSON extraction + normalization (shared by all providers) ────────────────────────────────

export { extractJson };

export interface NormalizedSignalOut { dimension: string; key: string; status: "scored" | "missing"; score: number | null; confidence: "HIGH" | "MEDIUM" | "LOW" | null; evidenceIds: string[]; rationale: string | null; present: boolean }
export interface ParsedArtifact {
  specVersion: string; provider: Provider; athlete: BlindEvalAthlete; parseError: string | null;
  identityConfidence: string | null; summary: string | null; summaryWords: number;
  evidence: Array<{ id: string; claim: string | null; sourceTitle: string | null; sourceUrl: string | null; sourceType: string | null; date: string | null }>;
  signals: NormalizedSignalOut[];
  keyStrengths: string[]; keyConstraints: string[]; importantMissingData: string[]; identityOrEvidenceRisks: string[];
  /** v0.2 outputs (absent for v0.1 artifacts). */
  dimensionAssessments?: Record<string, { prose: string | null; confidence: "HIGH" | "MEDIUM" | "LOW" | null; confidenceReason: string | null }>;
  overallConfidence?: { level: "HIGH" | "MEDIUM" | "LOW" | null; explanation: string | null } | null;
  socialBlockSupplied?: boolean;
}

/**
 * The harness artifact wrapper. The JUDGEMENT PARSING itself is production code
 * (services/marketabilityBeta1Evaluator.ts): the cohort and a live athlete must be parsed identically or the
 * validation this freeze rests on would not transfer. Only the artifact envelope — provider, athlete, specVersion —
 * is harness-local, because only the harness runs more than one provider.
 */
export function normalizeParsed(provider: Provider, athlete: BlindEvalAthlete, json: any | null, parseError: string | null): ParsedArtifact {
  const out = normalizeJudgements(json, MARKETABILITY_BETA1_FROZEN_PARAMS.config.subWeights);
  return {
    specVersion: BLIND_EVAL_SPEC_VERSION, provider, athlete, parseError,
    dimensionAssessments: Object.keys(out.dimensionAssessments).length ? out.dimensionAssessments : undefined,
    overallConfidence: out.overallConfidence ?? undefined,
    identityConfidence: out.identityConfidence,
    summary: out.summary, summaryWords: out.summaryWords,
    evidence: out.evidence,
    signals: out.judgements,
    keyStrengths: out.keyStrengths, keyConstraints: out.keyConstraints,
    importantMissingData: out.importantMissingData, identityOrEvidenceRisks: out.identityOrEvidenceRisks,
  };
}

// ─── Providers ────────────────────────────────────────────────────────────────────────────────

type CallResult = Omit<RawArtifact, "specVersion" | "provider" | "athlete" | "conditions" | "startedAt" | "attempts">;

async function callGemini(prompt: string): Promise<CallResult> {
  const t0 = Date.now();
  const config: any = { tools: [{ googleSearch: {} }], temperature: 1.0, maxOutputTokens: 65536 };
  let r: any;
  try { r = await genai().models.generateContent({ model: GEMINI.flash, contents: [{ role: "user", parts: [{ text: prompt }] }], config }); }
  catch (e: any) {
    if (!/maxOutputTokens|max_output_tokens|65536/i.test(String(e?.message ?? e))) throw e;
    config.maxOutputTokens = 32768;   // model ceiling fallback, recorded in the artifact
    r = await genai().models.generateContent({ model: GEMINI.flash, contents: [{ role: "user", parts: [{ text: prompt }] }], config });
  }
  const cand = r.candidates?.[0]; const gm = cand?.groundingMetadata ?? {}; const u = r.usageMetadata ?? {};
  const outTok = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  return {
    model: GEMINI.flash, modelVersion: r.modelVersion ?? null, responseId: r.responseId ?? null, latencyMs: Date.now() - t0, finishReason: cand?.finishReason ?? null, truncated: cand?.finishReason === "MAX_TOKENS",
    usage: { promptTokens: u.promptTokenCount ?? null, outputTokens: u.candidatesTokenCount ?? null, thoughtTokens: u.thoughtsTokenCount ?? null, totalTokens: u.totalTokenCount ?? null, searchCalls: (gm.webSearchQueries ?? []).length },
    costUsd: RATES.gemini.perCallUsd + ((u.promptTokenCount ?? 0) / 1e6) * RATES.gemini.inPerM + (outTok / 1e6) * RATES.gemini.outPerM,
    text: r.text ?? "", native: { groundingChunks: gm.groundingChunks ?? [], groundingSupports: gm.groundingSupports ?? [], webSearchQueries: gm.webSearchQueries ?? [], config: { ...config, maxOutputTokens: config.maxOutputTokens, thinking: "default" } }, error: null,
  };
}

let _openai: OpenAI | null = null;
async function callOpenAI(prompt: string): Promise<CallResult> {
  const client = (_openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 600_000, maxRetries: 0 }));
  const t0 = Date.now();
  const r: any = await client.responses.create({ model: OPENAI_RESEARCH_MODEL, input: prompt, tools: [{ type: "web_search", search_context_size: "medium" } as any], include: ["web_search_call.action.sources" as any], max_output_tokens: 65536 } as any);
  let text = ""; const annotations: any[] = []; const sources: any[] = []; const searchQueries: string[] = [];
  for (const item of r.output ?? []) {
    if (item?.type === "web_search_call") { const a = item.action ?? {}; if (a.query) searchQueries.push(String(a.query)); for (const s of a.sources ?? []) sources.push({ url: s.url ?? null, title: s.title ?? null }); }
    if (item?.type === "message") for (const part of item.content ?? []) if (part?.type === "output_text") { text += (text ? "\n" : "") + part.text; annotations.push(...(part.annotations ?? [])); }
  }
  const u = r.usage ?? {};
  return {
    model: OPENAI_RESEARCH_MODEL, modelVersion: r.model ?? null, responseId: r.id ?? null, latencyMs: Date.now() - t0, finishReason: r.status === "incomplete" ? `incomplete:${r.incomplete_details?.reason ?? "unknown"}` : (r.status ?? null), truncated: r.status === "incomplete",
    usage: { promptTokens: u.input_tokens ?? null, outputTokens: u.output_tokens ?? null, thoughtTokens: u.output_tokens_details?.reasoning_tokens ?? null, totalTokens: u.total_tokens ?? null, searchCalls: searchQueries.length },
    costUsd: RATES.openai.perCallUsd + ((u.input_tokens ?? 0) / 1e6) * RATES.openai.inPerM + ((u.output_tokens ?? 0) / 1e6) * RATES.openai.outPerM,
    text, native: { annotations, sources, searchQueries, reasoning: "default" }, error: null,
  };
}

let _moonshot: OpenAI | null = null;
async function callKimi(prompt: string): Promise<CallResult> {
  const client = (_moonshot ??= new OpenAI({ apiKey: process.env.MOONSHOT_API_KEY, baseURL: process.env.KIMI_BASE_URL ?? "https://api.moonshot.ai/v1", timeout: 600_000, maxRetries: 0 }));
  const t0 = Date.now();
  const messages: any[] = [{ role: "user", content: prompt }];
  const searches: any[] = []; const usage = { in: 0, out: 0, reasoning: 0, total: 0 }; let finish: string | null = null; let text = ""; let rounds = 0; let reasoning = "";
  while (rounds++ < 12) {
    const r: any = await client.chat.completions.create({ model: KIMI.moonshotModel, messages, tools: [{ type: "builtin_function", function: { name: "$web_search" } }] as any, temperature: 1, max_tokens: 32768 } as any);
    const u = r.usage ?? {}; usage.in += u.prompt_tokens ?? 0; usage.out += u.completion_tokens ?? 0; usage.reasoning += u.completion_tokens_details?.reasoning_tokens ?? 0; usage.total += u.total_tokens ?? 0;
    const choice = r.choices?.[0]; finish = choice?.finish_reason ?? null; const msg = choice?.message ?? {};
    if (msg.reasoning_content) reasoning += String(msg.reasoning_content) + "\n";
    if (finish === "tool_calls" && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        const args = tc.function?.arguments ?? "{}"; searches.push({ round: rounds, arguments: args });
        // Moonshot builtin functions: the client echoes the call arguments back as the tool result and the server performs the search
        messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function?.name, content: args });
      }
      continue;
    }
    text = String(msg.content ?? ""); break;
  }
  return {
    model: KIMI.moonshotModel, modelVersion: null, responseId: null, latencyMs: Date.now() - t0, finishReason: finish, truncated: finish === "length",
    usage: { promptTokens: usage.in, outputTokens: usage.out, thoughtTokens: usage.reasoning || null, totalTokens: usage.total, searchCalls: searches.length },
    costUsd: (usage.in / 1e6) * RATES.kimi.inPerM + (usage.out / 1e6) * RATES.kimi.outPerM,
    text, native: { searches, rounds, reasoningContent: reasoning.slice(0, 20000), thinking: "default (Moonshot API)", webSearch: "$web_search builtin" }, error: null,
  };
}

const CONDITIONS: Record<Provider, string> = {
  gemini: "gemini-3.5-flash via Vertex; Google Search grounding; default thinking; temperature 1.0; text output with fenced JSON",
  openai: "gpt-5.4-mini Responses API; web_search (medium) + action.sources; default reasoning; text output with fenced JSON",
  kimi: "kimi-k2.6 via Moonshot API; builtin $web_search loop; default thinking; temperature 1; text output with fenced JSON",
};

async function runOne(provider: Provider, a: BlindEvalAthlete, spec: SpecVersion, socialBlock: string | null): Promise<{ raw: RawArtifact; parsed: ParsedArtifact }> {
  const prompt = spec === "v0.2" ? blindEvalPromptV02(a, socialBlock) : blindEvalPrompt(a);
  const call = provider === "gemini" ? callGemini : provider === "openai" ? callOpenAI : callKimi;
  const startedAt = new Date().toISOString();
  let attempts = 0; let last: CallResult | null = null; let json: any = null; let parseError: string | null = null;
  while (attempts < 2) {   // exactly one retry, only on truncation or unparseable JSON; the prompt never changes
    attempts++;
    try { last = await call(prompt); } catch (e: any) { last = { model: provider, latencyMs: 0, finishReason: null, truncated: false, usage: { promptTokens: null, outputTokens: null, thoughtTokens: null, totalTokens: null, searchCalls: null }, costUsd: null, text: "", native: null, error: String(e?.message ?? e).slice(0, 600) }; }
    if (last.error) continue;
    const ex = extractJson(last.text); json = ex.json; parseError = ex.error;
    if (!last.truncated && json) break;
  }
  const raw: RawArtifact = { specVersion: spec === "v0.2" ? BLIND_EVAL_SPEC_V02_VERSION : BLIND_EVAL_SPEC_VERSION, provider, athlete: a, conditions: CONDITIONS[provider] + (spec === "v0.2" ? `; spec v0.2 additions; social block ${socialBlock ? "supplied" : "none"}` : ""), startedAt, attempts, ...(last as CallResult), ...(spec === "v0.2" ? { promptSocialBlock: socialBlock } : {}) } as RawArtifact;
  const parsed = { ...normalizeParsed(provider, a, json, last?.error ? `provider error: ${last.error}` : parseError), specVersion: raw.specVersion, socialBlockSupplied: !!socialBlock };
  return { raw, parsed };
}

/** The development cohort as evaluator subjects: name + sport ONLY. Anchors, groups, hometowns and targets never leave this function. */
function cohortAthletes(name: string): BlindEvalAthlete[] {
  const file = join(__dirname, "..", `cohort.${name}.json`);
  if (!existsSync(file)) throw new Error(`no cohort file ${file}`);
  const raw = JSON.parse(readFileSync(file, "utf8")) as { athletes: Array<{ key: string; fullName: string; sport: string }> };
  const title = (v: string) => v.split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
  return raw.athletes.map((a) => ({ key: a.key, name: a.fullName, sport: title(a.sport) }));
}

function args() {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  return { provider: get("--provider") as Provider | undefined, spec: (get("--spec") ?? "v0.1") as SpecVersion, tag: get("--tag") ?? null, keys: (get("--keys") ?? "").split(",").map((s) => s.trim()).filter(Boolean), cohort: get("--cohort") ?? null, concurrency: Math.max(1, Number(get("--concurrency") ?? 1)), run: a.includes("--run") };
}

async function main() {
  const o = args();
  if (!o.provider || !["gemini", "kimi", "openai"].includes(o.provider)) throw new Error("--provider gemini|kimi|openai");
  const pool = o.cohort ? cohortAthletes(o.cohort) : [...BLIND_EVAL_ATHLETES];
  const athletes = o.keys.length ? pool.filter((x) => o.keys.includes(x.key)) : pool;
  const dir = join(o.spec === "v0.2" ? RUNS_V02 : RUNS_V01, o.provider); mkdirSync(dir, { recursive: true });
  const socialDir = join(RUNS_V02, "social");
  const socialFor = (a: BlindEvalAthlete): string | null => { if (o.spec !== "v0.2") return null; const f = join(socialDir, `${a.key}.txt`); if (!existsSync(f)) return null; const t = readFileSync(f, "utf8").trim(); return t || null; };
  console.log(`blind eval · ${o.spec === "v0.2" ? BLIND_EVAL_SPEC_V02_VERSION : BLIND_EVAL_SPEC_VERSION} · provider ${o.provider} · ${athletes.length} athlete(s) · ${CONDITIONS[o.provider]}${o.spec === "v0.2" ? ` · social blocks: ${athletes.filter((a) => socialFor(a)).map((a) => a.key).join(", ") || "none"}` : ""}`);
  if (!o.run) { console.log("dry run — add --run to call the provider"); return; }
  let spent = 0, done = 0;
  const queue = [...athletes];
  const worker = async () => {
    for (;;) {
      const a = queue.shift();
      if (!a) return;
      const suffix = o.tag ? `.${o.tag}` : "";   // a tagged repeat never overwrites the frozen run
      const rawPath = join(dir, `${a.key}${suffix}.raw.json`);
      if (existsSync(rawPath)) { console.log(`  ${a.key}: already saved, skipping (delete the file to redo)`); continue; }
      let raw: RawArtifact, parsed: ParsedArtifact;
      try { ({ raw, parsed } = await runOne(o.provider!, a, o.spec, socialFor(a))); }
      catch (err: any) { console.log(`  ${a.key}: FAILED ${err?.message ?? err}`); continue; }
      writeFileSync(rawPath, JSON.stringify(raw, null, 2));
      writeFileSync(join(dir, `${a.key}${suffix}.parsed.json`), JSON.stringify(parsed, null, 2));
      spent += raw.costUsd ?? 0; done += 1;
      const scored = parsed.signals.filter((s) => s.status === "scored").length;
      console.log(`  [${done}/${athletes.length}] ${a.key}: ${parsed.socialBlockSupplied ? "[social] " : ""}attempts=${raw.attempts} finish=${raw.finishReason} ${(raw.latencyMs / 1000).toFixed(0)}s tokens in/out/thought=${raw.usage.promptTokens}/${raw.usage.outputTokens}/${raw.usage.thoughtTokens ?? "-"} searches=${raw.usage.searchCalls ?? "-"} cost=$${raw.costUsd?.toFixed(3) ?? "?"} · parsed: ${parsed.parseError ?? "ok"} · scored ${scored}/44 · evidence ${parsed.evidence.length} · identity ${parsed.identityConfidence ?? "-"} · summary ${parsed.summaryWords}w${parsed.overallConfidence ? ` · overall conf ${parsed.overallConfidence.level}` : ""}${parsed.dimensionAssessments ? ` · dims ${Object.keys(parsed.dimensionAssessments).length}/8` : ""}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency, athletes.length) }, worker));
  console.log(`done · ${done}/${athletes.length} saved · $${spent.toFixed(2)}`);
}

if (require.main === module) main().then(() => process.exit(0)).catch((err) => { console.error(err?.message ?? err); process.exit(1); });
