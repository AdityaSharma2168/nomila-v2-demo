/**
 * evals/agent/mila-v2/run.ts — the Mila v2 model test (owner-approved 26 Oct 2026, budget $8).
 *
 * Each scenario in scenarios.json is one athlete turn: the definition's instructions as the system prompt, then
 * CONTEXT (contexts.json, written out from the scenario's one-line context) and the athlete's message. Each reply is
 * graded pass/fail on the scenario's listed rubric checks (README.md, R1–R9) by a model judge that sees the rubric,
 * the scenario's own pass/fail lines and the reply, never which model wrote it. A scenario passes a run only if every
 * listed check passes; pass^k = it passed all k runs.
 *
 * Configurations (--configs, default: every v2-* config):
 *   v2-sol              Mila v2 (server/agent/mila, chat surface) on gpt-6.1-sol, reasoning effort low
 *   v2-luna             Mila v2 on gpt-6-luna, reasoning effort low
 *   v2-gemini           Mila v2 on gemini-3.8-flash, Vertex (global), thinkingLevel LOW
 *   v2-deepseek-think   Mila v2 on DeepSeek V4.1 Flash, Vertex MaaS (global, OpenAI-compatible chat completions),
 *                       chat_template_kwargs {thinking: true, reasoning_effort: "low"}
 *   v2-deepseek-nothink the same with thinking off (reference only)
 *   today-sol           Mila's chat as live Mila on Mastra reads it (server/agent/evals/mastraChat.ts: the Mastra agent's
 *                       instructions and the chat surface's playbooks message), on gpt-6.1-sol, effort low
 *
 * Settings are symmetric across models (rerun approved 26 Oct 2026, budget $5): the same max output tokens (reasoning
 * included) for every model, no sampling overrides (each vendor's default), plain-text replies, one harness-level retry
 * policy (3 attempts on 429/5xx/timeout/network, SDK retries off) and one 180 s timeout per call. Each record says
 * whether a failure was the harness (call error, judge output unparseable) or the model (empty or truncated reply).
 *
 * Tools: by default none are attached (no tools are connected to mila-dev yet), so a reply that claims to have looked
 * something up, saved or sent it is graded as a failure of R2/R4. With --tools, every model gets the read-only tools
 * the definition itself tells Mila to use (Mastra's playbook tools skill · skill_read · skill_search, the ones its text
 * names, and cite_facts) with stub results (the playbook tools return the real playbook text; cite_facts returns ok) in
 * a loop of at most 4 rounds; the judge then uses prompt 1.2.0, whose only change from 1.0.0 is the sentence saying
 * which tools were connected. (1.1.0 named get_playbook, TrueForge's playbook tool; it went with TrueForge, Mastra-only
 * PR 3, and 1.1.0 stays only as the text 1.2.0 is built from.) Without the tools, a model that follows "read the playbook
 * first" literally can emit its raw tool-call syntax as the reply (DeepSeek V4.1 Flash does: "<|DSML| invoke ...>").
 *
 * Live only, never in CI (it calls OpenAI and Vertex). The same guards as `npm run evals:live` (refuseToRun): it
 * refuses under CI, on a deployed service or with NODE_ENV=production, prints the estimate and plays nothing until a
 * person at a terminal types "yes" (no TTY: nothing runs). Credentials: OPENAI_API_KEY from the environment or from the
 * file named by DOTENV_PATH (loaded silently, never printed); Vertex through ADC. Hard budget: --budget (USD, default
 * 5): a turn starts only while what was spent, plus every running turn's estimate, plus its own still fits. Next to
 * the judge, each reply also gets the scenario's deterministic text checks (checks.ts, from flows.json), the same ones
 * the offline run grades in CI. Writes raw records (JSONL) and a markdown report to --out (default ./mila-v2-out).
 *
 *   npm run evals:live:mila-v2 [-- --runs 3 --configs v2-sol,v2-luna --only id1,id2 --budget 5 --out <dir>]
 *   (the npm script defaults to --configs v2-sol --runs 1 --budget 5; a flag given after -- wins)
 *
 * The judge prompt below is the exact text for the Prompt Register (agent-eval/mila-v2-judge 1.0.0). The judge is
 * GLM-5.2 on Vertex MaaS (zai-org/glm-5.2-maas): a third model family, so no candidate is graded by its own vendor.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import OpenAI from "openai";
import { GoogleAuth } from "google-auth-library";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { MILA_PLAYBOOKS, buildMilaInstructions, readPlaybook, type MilaPlaybook } from "../../../server/agent/mila/build";
import { loadJob } from "../../../server/agent/jobs";
import { MASTRA_SKILL_TOOL_ARGS, mastraChatSystem } from "../../../server/agent/evals/mastraChat";
import { MASTRA_SKILL_TOOLS, MILA_SKILL_TOOL_DESCRIPTIONS } from "../../../server/agent/engine/mastra/skills";
import { zodToJsonSchema } from "../../../server/agent/tools";

// ---------- inputs ----------

// The scenarios, their CONTEXT, the rubric and the turn input live in scenarios.ts (the offline runner, flows.ts, reads
// the same ones).
import { RUBRIC, SCENARIOS, TODAY, contextBlock, rubricFromReadme, userTurn, type Scenario } from "./scenarios";
import { TEXT_CHECKS, gradeTurn, type CheckResult, type FlowExpect, type FlowWorld } from "./checks";
export { TODAY, contextBlock, rubricFromReadme, userTurn };

/** The deterministic checks per scenario (flows.json): the live run applies their text checks to real replies too. */
const FLOWS: Record<string, { expect: FlowExpect; world?: FlowWorld }> = JSON.parse(readFileSync(join(__dirname, "flows.json"), "utf8")).flows;
export function liveChecks(s: Scenario, reply: string): CheckResult[] {
  const f = FLOWS[s.id];
  return f ? gradeTurn(f.expect, { text: reply, calls: [], cards: [], input: userTurn(s) }, f.world ?? {}, TEXT_CHECKS) : [];
}

// ---------- models ----------

interface Usage { input: number; cached: number; output: number; reasoning: number }
interface Price { in: number; cached: number; out: number }
/** List prices per 1M tokens, standard pay-as-you-go, global endpoint where it applies (sources in the results note). */
const PRICES: Record<string, Price> = {
  "gpt-6.1-sol": { in: 2, cached: 0.1, out: 10 }, // OpenAI model page; cache writes billed 1.25x input (not counted here)
  "gpt-6-luna": { in: 0.1, cached: 0.01, out: 0.5 },
  "gemini-3.8-flash": { in: 0.75, cached: 0.075, out: 3.75 }, // Vertex pricing, through 31 Dec 2026 (output incl. thinking)
  "deepseek-ai/deepseek-v4.1-flash-maas": { in: 0.3, cached: 0.03, out: 1.2 }, // Vertex pricing, MaaS
  "zai-org/glm-5.2-maas": { in: 1.4, cached: 0.14, out: 4.4 }, // Vertex pricing, MaaS
};
/** Gemini 3.8 Flash list price from 1 Jan 2027 (Vertex pricing page), reported alongside. */
export const GEMINI_2027: Price = { in: 1.5, cached: 0.15, out: 7.5 };
export function costUsd(model: string, u: Usage, p: Price = PRICES[model]): number {
  return ((u.input - u.cached) * p.in + u.cached * p.cached + u.output * p.out) / 1e6; // output includes reasoning
}

/** Same for every model: room for low-effort reasoning plus a reply; a hit is recorded as truncation (model fault). */
export const MAX_OUTPUT_TOKENS = 8000;
const TIMEOUT_MS = 180_000;
const ATTEMPTS = 3;

type Provider = "openai" | "gemini" | "vertex-chat";
interface Config { id: string; model: string; provider: Provider; effort?: string; extra?: Record<string, unknown>; system: () => string }
const v2 = () => buildMilaInstructions({ surface: "chat" });
const CONFIGS: Config[] = [
  { id: "v2-sol", model: "gpt-6.1-sol", provider: "openai", effort: "low", system: v2 },
  { id: "v2-luna", model: "gpt-6-luna", provider: "openai", effort: "low", system: v2 },
  { id: "v2-gemini", model: "gemini-3.8-flash", provider: "gemini", effort: "LOW", system: v2 },
  { id: "v2-deepseek-think", model: "deepseek-ai/deepseek-v4.1-flash-maas", provider: "vertex-chat", effort: "low",
    extra: { chat_template_kwargs: { thinking: true, reasoning_effort: "low" } }, system: v2 },
  { id: "v2-deepseek-nothink", model: "deepseek-ai/deepseek-v4.1-flash-maas", provider: "vertex-chat",
    extra: { chat_template_kwargs: { thinking: false } }, system: v2 },
  { id: "today-sol", model: "gpt-6.1-sol", provider: "openai", effort: "low", system: () => mastraChatSystem(loadJob("chat").tools) },
];

function loadEnvSilently(): void {
  const p = process.env.DOTENV_PATH;
  if (process.env.OPENAI_API_KEY || !p || !existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^OPENAI_API_KEY=(.*)$/.exec(line);
    if (m) process.env.OPENAI_API_KEY = m[1].trim().replace(/^["']|["']$/g, "");
  }
}

const PROJECT = "gamechanger-pocket-agent";
let openai: OpenAI | null = null;
const oa = () => (openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: TIMEOUT_MS, maxRetries: 0 }));
let gem: GoogleGenAI | null = null;
const gm = () => (gem ??= new GoogleGenAI({ vertexai: true, project: PROJECT, location: "global" }));
const gauth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const VERTEX_URL = `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global/endpoints/openapi/chat/completions`;

export interface CallResult { text: string; usage: Usage; ms: number; finish: string; attempts: number }

/** Retry policy shared by every provider: 3 attempts on rate limits, server errors, timeouts and network errors. */
function retryable(e: unknown): boolean {
  const s = String((e as any)?.status ?? (e as any)?.code ?? "");
  const m = String((e as Error)?.message ?? e);
  return /^(429|5\d\d)$/.test(s) || /\b(429|5\d\d)\b|timeout|timed out|aborted|ECONNRESET|ETIMEDOUT|fetch failed|socket|upstream|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded/i.test(m);
}
async function withRetry(fn: () => Promise<Omit<CallResult, "attempts" | "ms">>): Promise<CallResult> {
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now();
    try {
      const r = await fn();
      return { ...r, ms: Date.now() - t0, attempts: attempt };
    } catch (e) {
      if (attempt >= ATTEMPTS || !retryable(e)) throw e;
      await new Promise((res) => setTimeout(res, 3000 * attempt));
    }
  }
}

async function callOpenAI(model: string, effort: string | undefined, system: string, user: string): Promise<CallResult> {
  return withRetry(async () => {
    const r: any = await (oa().responses as any).create({
      model,
      instructions: system,
      input: [{ role: "user", content: user }],
      max_output_tokens: MAX_OUTPUT_TOKENS,
      ...(effort ? { reasoning: { effort } } : {}),
      store: false,
    });
    const u = r.usage ?? {};
    return {
      text: String(r.output_text ?? ""),
      finish: r.status === "incomplete" ? `incomplete:${r.incomplete_details?.reason ?? "?"}` : String(r.status ?? "completed"),
      usage: { input: u.input_tokens ?? 0, cached: u.input_tokens_details?.cached_tokens ?? 0, output: u.output_tokens ?? 0, reasoning: u.output_tokens_details?.reasoning_tokens ?? 0 },
    };
  });
}

async function callGemini(model: string, level: string, system: string, user: string): Promise<CallResult> {
  return withRetry(async () => {
    const r: any = await gm().models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: user }] }],
      config: {
        systemInstruction: system,
        thinkingConfig: { thinkingLevel: level as ThinkingLevel },
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      },
    });
    const u = r.usageMetadata ?? {};
    const thoughts = u.thoughtsTokenCount ?? 0;
    return {
      text: String(r.text ?? ""),
      finish: String(r.candidates?.[0]?.finishReason ?? "?"),
      usage: { input: u.promptTokenCount ?? 0, cached: u.cachedContentTokenCount ?? 0, output: (u.candidatesTokenCount ?? 0) + thoughts, reasoning: thoughts },
    };
  });
}

/** Vertex MaaS OpenAI-compatible chat completions (DeepSeek candidates and the GLM judge). */
async function callVertexChat(model: string, system: string, user: string, extra: Record<string, unknown> = {}, maxTokens = MAX_OUTPUT_TOKENS): Promise<CallResult> {
  return withRetry(async () => {
    const token = await gauth.getAccessToken();
    const res = await fetch(VERTEX_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: maxTokens, ...extra }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) { const err: any = new Error(`vertex ${res.status}: ${(await res.text()).slice(0, 300)}`); err.status = res.status; throw err; }
    // Vertex MaaS sometimes answers 200 with a plain-text "upstream connect error" body: retryable, not a model reply.
    const raw = await res.text();
    let j: any;
    try { j = JSON.parse(raw); } catch { throw new Error(`vertex upstream non-JSON body: ${raw.slice(0, 120)}`); }
    const u = j.usage ?? {};
    let text = String(j.choices?.[0]?.message?.content ?? "");
    // Vertex's DeepSeek V3.1 shape puts thinking inline before "</think>" (MaaS thinking guide); keep only the answer.
    if (text.includes("</think>")) text = text.slice(text.lastIndexOf("</think>") + 8).trimStart();
    return {
      text,
      finish: String(j.choices?.[0]?.finish_reason ?? "?"),
      usage: {
        input: u.prompt_tokens ?? 0, cached: u.prompt_tokens_details?.cached_tokens ?? 0, output: u.completion_tokens ?? 0,
        reasoning: u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens ?? 0,
      },
    };
  });
}

// ---------- stub tools (--tools) ----------

interface ToolDef { name: string; description: string; parameters: Record<string, unknown>; strict?: boolean }
const CITE_FACTS_STUB: ToolDef = {
  name: "cite_facts",
  description: "Cite, once, the facts from CONTEXT that your answer states about the athlete, so they can open \"How I got this\". Read-only.",
  parameters: { type: "object", additionalProperties: false, properties: { facts: { type: "array", items: { type: "string" } } }, required: ["facts"] },
};
/** Mastra's playbook tools (skill · skill_read · skill_search: our descriptions, Mastra's argument shapes) and cite_facts. */
export const STUB_TOOLS: ToolDef[] = [
  ...MASTRA_SKILL_TOOLS.map((name) => ({ name, description: MILA_SKILL_TOOL_DESCRIPTIONS[name], parameters: zodToJsonSchema(MASTRA_SKILL_TOOL_ARGS[name]) as Record<string, unknown>, strict: false })),
  CITE_FACTS_STUB,
];
const stubToolsFor = (_c: Config): ToolDef[] => STUB_TOOLS;
const MAX_TOOL_ROUNDS = 4;
const isPlaybook = (n: string): n is MilaPlaybook => (MILA_PLAYBOOKS as readonly string[]).includes(n);
const noPlaybook = (n: string) => JSON.stringify({ status: "error", error: `no playbook named "${n}"; names: ${MILA_PLAYBOOKS.join(", ")}` });
export function runStubTool(name: string, args: any): string {
  if (name === "skill") {
    const n = String(args?.name ?? args?.area ?? "");
    return isPlaybook(n) ? readPlaybook(n) : noPlaybook(n);
  }
  if (name === "skill_read") {
    const n = String(args?.skillName ?? "");
    if (!isPlaybook(n)) return noPlaybook(n);
    const lines = readPlaybook(n).split("\n");
    const from = Math.max(1, Number(args?.startLine) || 1), to = Math.min(lines.length, Number(args?.endLine) || lines.length);
    return lines.slice(from - 1, to).join("\n");
  }
  if (name === "skill_search") {
    const q = String(args?.query ?? "").toLowerCase();
    const names = (Array.isArray(args?.skillNames) ? args.skillNames : MILA_PLAYBOOKS).filter((x: string) => isPlaybook(x)) as MilaPlaybook[];
    const hits = names.flatMap((n) => readPlaybook(n).split("\n").filter((l) => q && l.toLowerCase().includes(q)).map((l) => `${n}: ${l.trim()}`));
    return hits.slice(0, Number(args?.topK) || 5).join("\n") || "No matches.";
  }
  if (name === "cite_facts") return JSON.stringify({ status: "ok" });
  return JSON.stringify({ status: "error", error: `no tool named ${name}` });
}
function parseArgs(a: unknown): any { if (typeof a !== "string") return a ?? {}; try { return JSON.parse(a); } catch { return {}; } }
const addUsage = (a: Usage, b: Usage): Usage => ({ input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output, reasoning: a.reasoning + b.reasoning });
const PARA = String.fromCharCode(10, 10);
const ZERO: Usage = { input: 0, cached: 0, output: 0, reasoning: 0 };

/** One turn with stub tools, per provider; usage and latency summed over rounds. Each round has the shared retry policy. */
async function toolTurn(c: Config, system: string, user: string): Promise<CallResult & { toolCalls: string[] }> {
  const t0 = Date.now();
  let usage = ZERO, attempts = 0;
  const toolCalls: string[] = [];
  const texts: string[] = []; // what the athlete sees: assistant text from every round, in order
  if (c.provider === "openai") {
    const input: any[] = [{ role: "user", content: user }];
    const tools = stubToolsFor(c).map((d) => ({ type: "function", name: d.name, description: d.description, parameters: d.parameters, strict: d.strict ?? true }));
    for (let round = 0; ; round++) {
      let raw: any;
      const r = await withRetry(async () => {
        raw = await (oa().responses as any).create({
          model: c.model, instructions: system, input, tools, max_output_tokens: MAX_OUTPUT_TOKENS,
          ...(c.effort ? { reasoning: { effort: c.effort } } : {}), store: false, include: ["reasoning.encrypted_content"],
        });
        const u = raw.usage ?? {};
        return { text: String(raw.output_text ?? ""), finish: raw.status === "incomplete" ? `incomplete:${raw.incomplete_details?.reason ?? "?"}` : String(raw.status ?? "completed"),
          usage: { input: u.input_tokens ?? 0, cached: u.input_tokens_details?.cached_tokens ?? 0, output: u.output_tokens ?? 0, reasoning: u.output_tokens_details?.reasoning_tokens ?? 0 } };
      });
      usage = addUsage(usage, r.usage); attempts += r.attempts; if (r.text.trim()) texts.push(r.text.trim());
      const calls = (raw.output ?? []).filter((o: any) => o.type === "function_call");
      if (!calls.length || round >= MAX_TOOL_ROUNDS) return { ...r, text: texts.join(PARA), usage, attempts, ms: Date.now() - t0, toolCalls, finish: calls.length ? "tool-loop-limit" : r.finish };
      input.push(...raw.output);
      for (const fc of calls) { toolCalls.push(fc.name); input.push({ type: "function_call_output", call_id: fc.call_id, output: runStubTool(fc.name, parseArgs(fc.arguments)) }); }
    }
  }
  if (c.provider === "gemini") {
    const contents: any[] = [{ role: "user", parts: [{ text: user }] }];
    const tools = [{ functionDeclarations: stubToolsFor(c).map((d) => ({ name: d.name, description: d.description, parametersJsonSchema: d.parameters })) }];
    for (let round = 0; ; round++) {
      let raw: any;
      const r = await withRetry(async () => {
        raw = await gm().models.generateContent({ model: c.model, contents, config: { systemInstruction: system, tools, thinkingConfig: { thinkingLevel: (c.effort ?? "LOW") as ThinkingLevel }, maxOutputTokens: MAX_OUTPUT_TOKENS, abortSignal: AbortSignal.timeout(TIMEOUT_MS) } });
        const u = raw.usageMetadata ?? {};
        const thoughts = u.thoughtsTokenCount ?? 0;
        return { text: String(raw.text ?? ""), finish: String(raw.candidates?.[0]?.finishReason ?? "?"),
          usage: { input: u.promptTokenCount ?? 0, cached: u.cachedContentTokenCount ?? 0, output: (u.candidatesTokenCount ?? 0) + thoughts, reasoning: thoughts } };
      });
      usage = addUsage(usage, r.usage); attempts += r.attempts; if (r.text.trim()) texts.push(r.text.trim());
      const calls: any[] = raw.functionCalls ?? [];
      if (!calls.length || round >= MAX_TOOL_ROUNDS) return { ...r, text: texts.join(PARA), usage, attempts, ms: Date.now() - t0, toolCalls, finish: calls.length ? "tool-loop-limit" : r.finish };
      contents.push(raw.candidates[0].content);
      contents.push({ role: "user", parts: calls.map((fc) => { toolCalls.push(fc.name); return { functionResponse: { id: fc.id, name: fc.name, response: { output: runStubTool(fc.name, fc.args) } } }; }) });
    }
  }
  const messages: any[] = [{ role: "system", content: system }, { role: "user", content: user }];
  const tools = stubToolsFor(c).map((d) => ({ type: "function", function: { name: d.name, description: d.description, parameters: d.parameters } }));
  for (let round = 0; ; round++) {
    let msg: any;
    const r = await withRetry(async () => {
      const token = await gauth.getAccessToken();
      const res = await fetch(VERTEX_URL, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: c.model, messages, tools, max_tokens: MAX_OUTPUT_TOKENS, ...c.extra }), signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) { const err: any = new Error(`vertex ${res.status}: ${(await res.text()).slice(0, 300)}`); err.status = res.status; throw err; }
      const raw = await res.text();
      let j: any;
      try { j = JSON.parse(raw); } catch { throw new Error(`vertex upstream non-JSON body: ${raw.slice(0, 120)}`); }
      msg = j.choices?.[0]?.message ?? {};
      const u = j.usage ?? {};
      let text = String(msg.content ?? "");
      if (text.includes("</think>")) text = text.slice(text.lastIndexOf("</think>") + 8).trimStart();
      return { text, finish: String(j.choices?.[0]?.finish_reason ?? "?"),
        usage: { input: u.prompt_tokens ?? 0, cached: u.prompt_tokens_details?.cached_tokens ?? 0, output: u.completion_tokens ?? 0, reasoning: u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens ?? 0 } };
    });
    usage = addUsage(usage, r.usage); attempts += r.attempts; if (r.text.trim()) texts.push(r.text.trim());
    const calls: any[] = msg.tool_calls ?? [];
    if (!calls.length || round >= MAX_TOOL_ROUNDS) return { ...r, text: texts.join(PARA), usage, attempts, ms: Date.now() - t0, toolCalls, finish: calls.length ? "tool-loop-limit" : r.finish };
    // DeepSeek thinking guide: with tools, reasoning_content must be passed back in later requests.
    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls, ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}) });
    for (const tc of calls) { toolCalls.push(tc.function?.name); messages.push({ role: "tool", tool_call_id: tc.id, content: runStubTool(tc.function?.name, parseArgs(tc.function?.arguments)) }); }
  }
}

let USE_TOOLS = false;

function callCandidate(c: Config, system: string, user: string): Promise<CallResult & { toolCalls?: string[] }> {
  if (USE_TOOLS) return toolTurn(c, system, user);
  if (c.provider === "openai") return callOpenAI(c.model, c.effort, system, user);
  if (c.provider === "gemini") return callGemini(c.model, c.effort ?? "LOW", system, user);
  return callVertexChat(c.model, system, user, c.extra);
}

// ---------- judge ----------

export const JUDGE_PROMPT_ID = "agent-eval/mila-v2-judge";
export const JUDGE_PROMPT_VERSION = "1.0.0"; // 1.2.0 with --tools (JUDGE_SYSTEM_PROMPT_TOOLS_MASTRA)
export const JUDGE_MODEL = "zai-org/glm-5.2-maas";
/** GLM-5.2 thinks by default on Vertex MaaS (as GLM 4.7/5: "Reasoning is enabled by default"); left on. */
export const JUDGE_EFFORT = "default (thinking on)";
const JUDGE_MAX_TOKENS = 16000;

export const JUDGE_SYSTEM_PROMPT = `You are an independent reviewer grading one reply from Mila, an athlete's agent inside the app Nomila. You see the rubric checks that apply to this scenario, the scenario (who the athlete is, what CONTEXT held, what they asked, what a pass looks like and what fails), and Mila's reply. You do not know which system wrote the reply.

Grade each listed check pass or fail, with a reason of at most 30 words that quotes the reply when it fails.

Rules:
- Grade only the listed checks, using each check's PASSES/FAILS lines. The scenario's own pass and fail lines say what those checks mean here: a reply that does what the scenario's fail line describes fails the check it relates to.
- CONTEXT is the only evidence about the athlete. Any fact, number, result, partner, time or brand detail about the athlete or a named brand that CONTEXT does not hold is invented (R2), unless clearly framed as a question, an example placeholder or general knowledge about the world. Facts about Nomila itself are product knowledge Mila is given, not invented: the M.I.A. is Nomila's marketability score on a 0 to 850 scale; Nomila has Deals, Studio, a public page, Bookings, Money and settings areas.
- No tools were connected for this turn. A reply that says it looked something up, saved, sent, booked or researched something as done is a claim, not an action: grade it against R2 or R4 as a false claim.
- Advice and judgement are allowed; invented facts are not. Be strict about numbers and money. Be lenient about wording and style unless a check is about it.
- Gendered words for Mila, or the athlete called "he" or "she", fail R9 when R9 is listed.

Return JSON only, matching the schema.`;

/** agent-eval/mila-v2-judge 1.1.0: 1.0.0 with only the "No tools were connected" sentence replaced. Not used any more
 * (it named get_playbook, which went with TrueForge); 1.2.0 is built from it. */
export const JUDGE_SYSTEM_PROMPT_TOOLS = JUDGE_SYSTEM_PROMPT.replace(
  "- No tools were connected for this turn. A reply that says it looked something up, saved, sent, booked or researched something as done is a claim, not an action: grade it against R2 or R4 as a false claim.",
  "- Only two read-only tools were connected for this turn: get_playbook (returns an area's rules) and cite_facts (records which CONTEXT facts the answer rests on). Reading a playbook or citing facts is real. A reply that says it looked anything else up, saved, sent, booked or researched something as done is a claim, not an action: grade it against R2 or R4 as a false claim.",
);
if (JUDGE_SYSTEM_PROMPT_TOOLS === JUDGE_SYSTEM_PROMPT) throw new Error("judge 1.1.0 replacement did not apply");

/** agent-eval/mila-v2-judge 1.2.0: 1.1.0 with the playbook tool named as Mastra's (used with --tools). */
export const JUDGE_SYSTEM_PROMPT_TOOLS_MASTRA = JUDGE_SYSTEM_PROMPT_TOOLS.replace(
  "Only two read-only tools were connected for this turn: get_playbook (returns an area's rules)",
  "Only these read-only tools were connected for this turn: skill, skill_read and skill_search (load or search an area's playbook)",
);
if (JUDGE_SYSTEM_PROMPT_TOOLS_MASTRA === JUDGE_SYSTEM_PROMPT_TOOLS) throw new Error("judge 1.2.0 replacement did not apply");

const JUDGE_SCHEMA = {
  name: "mila_v2_grade",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      checks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: { id: { type: "string" }, pass: { type: "boolean" }, reason: { type: "string" } },
          required: ["id", "pass", "reason"],
        },
      },
    },
    required: ["checks"],
  },
};
const JUDGE_EXTRA = { response_format: { type: "json_schema", json_schema: JUDGE_SCHEMA } };

/** Parse the judge's JSON; tolerate a fenced block. Throws (a harness fault) when it is not the schema. */
export function parseGrade(text: string, ids: string[] = []): { checks: Array<{ id: string; pass: boolean; reason: string }> } {
  const m = /\{[\s\S]*\}/.exec(text);
  const j = JSON.parse(m ? m[0] : text);
  if (!Array.isArray(j?.checks)) throw new Error("judge JSON has no checks array");
  for (const id of ids) {
    const g = j.checks.find((x: any) => x?.id === id);
    if (!g || typeof g.pass !== "boolean") throw new Error(`judge gave no verdict for ${id}`);
    if (!g.pass && String(g.reason ?? "").replace(/[\s'"`.]/g, "").length < 8) throw new Error(`judge failed ${id} with no reason`);
  }
  return j;
}

export function judgeInput(s: Scenario, reply: string): string {
  return [
    "CHECKS THAT APPLY",
    ...s.checks.map((c) => RUBRIC[c] ?? c),
    "",
    "SCENARIO",
    `Athlete: ${s.athlete}`,
    `What CONTEXT held:\n${contextBlock(s)}`,
    `Message: ${s.message ?? "(none: a moment turn, APP UPDATES says which)"}`,
    `A pass looks like: ${s.pass}`,
    `Fails when: ${s.fail}`,
    "",
    "MILA'S REPLY",
    reply || "(empty reply)",
  ].join("\n");
}

// ---------- run ----------

interface Rec {
  config: string; model: string; scenario: string; run: number; reply: string; usage: Usage; ms: number; cost: number;
  finish?: string; attempts?: number; judgeMs?: number; toolCalls?: string[];
  grade: Array<{ id: string; pass: boolean; reason: string }>; pass: boolean; judgeCost: number;
  /** The deterministic text checks (checks.ts) on the reply; a turn passes only if these pass too. */
  checks?: CheckResult[];
  /** harness: a call error or unparseable judge output (retried on the next run); model: empty or truncated reply (graded as is). */
  fault?: "harness" | "model"; error?: string;
}

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.lastIndexOf(`--${name}`); // the last one wins: npm script defaults, then the person's flags
  return i > 0 ? process.argv[i + 1] : dflt;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

/** Pessimistic cost of one turn (candidate + judge), from the request sizes and list prices: the budget reserves it. */
export function estimateTurnUsd(c: Pick<Config, "model">, system: string, user: string, judgeChars: number): number {
  const tok = (chars: number) => Math.ceil((chars / 4) * 1.25);
  const p = PRICES[c.model], j = PRICES[JUDGE_MODEL];
  return (tok(system.length + user.length) * p.in + 3000 * p.out + tok(JUDGE_SYSTEM_PROMPT.length + judgeChars) * j.in + 6000 * j.out) / 1e6;
}

/**
 * The paid run's guards, as `npm run evals:live` (scripts/evals-live.ts): never under CI, never on a deployed service
 * or with NODE_ENV=production (dev credentials, a developer's terminal), and nothing is called until a person at a
 * terminal types "yes" to the printed estimate. No flag skips the question.
 */
export function refuseToRun(env: Record<string, string | undefined> = process.env): string | null {
  if (env.CI) return "paid runs never run in CI.";
  if (env.NODE_ENV === "production" || env.K_SERVICE) return "dev only: never with NODE_ENV=production or on a deployed service.";
  return null;
}

async function main(): Promise<void> {
  const refused = refuseToRun();
  if (refused) { console.error(`mila-v2 live eval: ${refused}`); process.exit(2); }
  // The waitlist scenarios' input builders import server/db, which needs a URL to load; nothing here queries it.
  process.env.DATABASE_URL ??= "postgres://mila-v2-live@127.0.0.1:1/none";
  loadEnvSilently();
  const runs = Number(arg("runs", "3"));
  USE_TOOLS = process.argv.includes("--tools");
  const budget = Number(arg("budget", "5"));
  const out = arg("out", "./mila-v2-out")!;
  const only = arg("only")?.split(",");
  const configs = CONFIGS.filter((c) => (arg("configs") ? arg("configs")!.split(",").includes(c.id) : c.id.startsWith("v2-")));
  const scenarios = SCENARIOS.filter((s) => !only || only.includes(s.id));
  mkdirSync(out, { recursive: true });
  const jsonl = join(out, "records.jsonl");
  const done = new Set<string>();
  const recs: Rec[] = [];
  if (existsSync(jsonl)) for (const l of readFileSync(jsonl, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l) as Rec; if (!r.error) { recs.push(r); done.add(`${r.config}|${r.scenario}|${r.run}`); } }
  let spent = recs.reduce((a, r) => a + r.cost + r.judgeCost, 0);

  const systems = Object.fromEntries(configs.map((c) => [c.id, c.system()]));
  for (const c of configs) console.log(`${c.id}: system ${systems[c.id].length} chars (~${Math.round(systems[c.id].length / 4)} tokens)`);

  const jobs = configs.flatMap((c) => Array.from({ length: runs }, (_, k) => k + 1).flatMap((run) => scenarios.map((s) => ({ c, s, run }))))
    .filter((j) => !done.has(`${j.c.id}|${j.s.id}|${j.run}`));
  const est = (j: (typeof jobs)[number]) => estimateTurnUsd(j.c, systems[j.c.id], userTurn(j.s), judgeInput(j.s, "x".repeat(2000)).length);
  const estimate = jobs.reduce((a, j) => a + est(j), 0);
  console.log(`${jobs.length} turns to run (${scenarios.length} scenarios × ${runs} runs × ${configs.map((c) => c.id).join(", ")}); spent so far $${spent.toFixed(3)}; budget $${budget} (hard: a turn starts only if its estimate still fits)`);
  console.log(`Estimated cost: about $${estimate.toFixed(2)} (an over-estimate). Report: ${join(out, "summary.md")}`);
  if (!jobs.length) return;
  if (!process.stdin.isTTY) { console.error("mila-v2 live eval: needs a person at a terminal to confirm; nothing was run."); process.exit(2); }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Spend up to $${Math.min(estimate, budget - spent).toFixed(2)} on ${jobs.length} live turns? Type "yes" to run: `)).trim().toLowerCase();
  rl.close();
  if (answer !== "yes") { console.log("Nothing was run."); return; }
  let reserved = 0;

  await pool(jobs, 4, async (job) => {
    const { c, s, run } = job;
    const hold = est(job);
    if (spent + reserved + hold > budget) return;
    reserved += hold;
    const rec: Rec = { config: c.id, model: c.model, scenario: s.id, run, reply: "", usage: { input: 0, cached: 0, output: 0, reasoning: 0 }, ms: 0, cost: 0, grade: [], pass: false, judgeCost: 0 };
    let stage = "candidate";
    try {
      const r = await callCandidate(c, systems[c.id], userTurn(s));
      stage = "judge";
      Object.assign(rec, { reply: r.text, usage: r.usage, ms: r.ms, cost: costUsd(c.model, r.usage), finish: r.finish, attempts: r.attempts, toolCalls: r.toolCalls });
      spent += rec.cost;
      if (!r.text.trim() || /length|MAX_TOKENS|incomplete|tool-loop-limit/i.test(r.finish) || /DSML|<tool_call>/.test(r.text)) rec.fault = "model";
      let parsed: { checks: Rec["grade"] } | null = null;
      let lastErr = "";
      for (let k = 0; k < 3 && !parsed; k++) {
        const judgeSystem = !USE_TOOLS ? JUDGE_SYSTEM_PROMPT : JUDGE_SYSTEM_PROMPT_TOOLS_MASTRA;
        const j = await callVertexChat(JUDGE_MODEL, judgeSystem, judgeInput(s, r.text), JUDGE_EXTRA, JUDGE_MAX_TOKENS);
        rec.judgeCost += costUsd(JUDGE_MODEL, j.usage);
        rec.judgeMs = j.ms;
        spent += costUsd(JUDGE_MODEL, j.usage);
        try { parsed = parseGrade(j.text, s.checks); } catch (e) { lastErr = `judge output not parseable (${j.finish}): ${(e as Error).message}`; }
      }
      if (!parsed) throw new Error(lastErr);
      rec.grade = s.checks.map((id) => parsed.checks.find((g) => g.id === id) ?? { id, pass: false, reason: "judge gave no verdict" });
      rec.checks = liveChecks(s, r.text);
      rec.pass = rec.grade.every((g) => g.pass) && rec.checks.every((x) => x.pass);
    } catch (e) {
      rec.error = `${stage}: ${(e as Error).message}`.slice(0, 300);
      rec.fault = "harness";
    } finally {
      reserved -= hold;
    }
    appendFileSync(jsonl, JSON.stringify(rec) + "\n");
    if (!rec.error) recs.push(rec);
    console.log(`${c.id} ${s.id} #${run}: ${rec.error ? "HARNESS ERROR " + rec.error : rec.fault === "model" ? "MODEL FAULT (" + rec.finish + ") " + (rec.pass ? "pass" : "FAIL") : rec.pass ? "pass" : "FAIL " + [...rec.grade.filter((g) => !g.pass).map((g) => g.id), ...(rec.checks ?? []).filter((x) => !x.pass).map((x) => x.check)].join(",")} ($${spent.toFixed(3)})`);
  });

  writeFileSync(join(out, "summary.md"), summarize(recs, configs.map((c) => c.id), scenarios, runs, spent));
  console.log(`done; spent $${spent.toFixed(3)}; summary at ${join(out, "summary.md")}`);
}

function pct(n: number, d: number): string { return d ? `${Math.round((100 * n) / d)}%` : "-"; }
function quantile(xs: number[], q: number): number { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; }

export function summarize(recs: Rec[], configs: string[], scenarios: Scenario[], runs: number, spent: number): string {
  const L: string[] = [`# Mila v2 model test — results`, ``, `${scenarios.length} scenarios × ${runs} runs per configuration; judge ${JUDGE_MODEL} (${JUDGE_EFFORT}, Vertex MaaS), blind to the model. Max output ${MAX_OUTPUT_TOKENS} tokens for every model. Total spend $${spent.toFixed(2)}. Tool calling not tested (no tools attached).`, ``];
  L.push(`| Config | pass^${runs} (scenarios) | pass@1 (turns) | ${Object.keys(RUBRIC).join(" | ")} | tokens in / cached / out (reasoning) per turn | cost / 1k turns | p50 / p95 latency | model faults (empty/truncated) |`);
  L.push(`|---|---|---|${Object.keys(RUBRIC).map(() => "---").join("|")}|---|---|---|---|`);
  for (const c of configs) {
    const rs = recs.filter((r) => r.config === c);
    const byS = scenarios.map((s) => rs.filter((r) => r.scenario === s.id));
    const passK = byS.filter((x) => x.length === runs && x.every((r) => r.pass)).length;
    const perCheck = Object.keys(RUBRIC).map((id) => {
      const relevant = scenarios.filter((s) => s.checks.includes(id));
      if (!relevant.length) return "-";
      const ok = relevant.filter((s) => { const x = rs.filter((r) => r.scenario === s.id); return x.length === runs && x.every((r) => r.grade.find((g) => g.id === id)?.pass); }).length;
      return `${ok}/${relevant.length}`;
    });
    const n = rs.length || 1;
    const avg = (f: (r: Rec) => number) => Math.round(rs.reduce((a, r) => a + f(r), 0) / n);
    const cost1k = (rs.reduce((a, r) => a + r.cost, 0) / n) * 1000;
    const cost1k27 = rs[0]?.model === "gemini-3.8-flash" ? ` ($${((rs.reduce((a, r) => a + costUsd(r.model, r.usage, GEMINI_2027), 0) / n) * 1000).toFixed(2)} from Jan 2027)` : "";
    const modelFaults = rs.filter((r) => r.fault === "model").length;
    L.push(`| ${c} | ${passK}/${scenarios.length} | ${pct(rs.filter((r) => r.pass).length, rs.length)} | ${perCheck.join(" | ")} | ${avg((r) => r.usage.input)} / ${avg((r) => r.usage.cached)} / ${avg((r) => r.usage.output)} (${avg((r) => r.usage.reasoning)}) | $${cost1k.toFixed(2)}${cost1k27} | ${(quantile(rs.map((r) => r.ms), 0.5) / 1000).toFixed(1)}s / ${(quantile(rs.map((r) => r.ms), 0.95) / 1000).toFixed(1)}s | ${modelFaults} |`);
  }
  L.push(``, `Per-check cells: scenarios where that check passed in all ${runs} runs / scenarios that list it.`, ``, `## Per scenario (runs passed)`, ``);
  L.push(`| Scenario | checks | ${configs.join(" | ")} |`, `|---|---|${configs.map(() => "---").join("|")}|`);
  for (const s of scenarios) L.push(`| ${s.id} | ${s.checks.join(",")} | ${configs.map((c) => { const x = recs.filter((r) => r.config === c && r.scenario === s.id); return `${x.filter((r) => r.pass).length}/${x.length}`; }).join(" | ")} |`);
  L.push(``, `## Failures (judge reasons, and the deterministic checks of checks.ts)`, ``);
  for (const r of recs.filter((r) => !r.pass)) {
    L.push(`### ${r.config} · ${r.scenario} · run ${r.run}`, ...r.grade.filter((g) => !g.pass).map((g) => `- **${g.id}**: ${g.reason}`),
      ...(r.checks ?? []).filter((x) => !x.pass).map((x) => `- **${x.check}** (deterministic): ${x.problems.join("; ")}`), ``, "> " + r.reply.replace(/\n+/g, "\n> "), ``);
  }
  return L.join("\n") + "\n";
}

if (require.main === module) main().catch((e) => { console.error((e as Error).message); process.exit(1); });
