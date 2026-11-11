/**
 * evals/agent/judge.ts — the model judge, ONLY for what code cannot decide about the Brief:
 *
 *   positioning_supported   is the big idea / verdict / positioning supported by the facts?
 *   no_unsupported_facts    is anything stated as fact that is not in the facts?
 *
 * Pass/fail per criterion with a one-line reason; no 1–10 scores. The judge runs on a DIFFERENT provider from the one
 * being graded: the agent thinks on OpenAI, the judge is Gemini on Vertex (server/lib/models.ts genai(), ADC). Claude
 * on Vertex would be preferred but is not wired in this repo (no @anthropic-ai/vertex-sdk; the Anthropic callers use
 * an API key). The prompt below is the exact text the owner reviews (Prompt Register).
 *
 * The provider call is injectable (JudgeCaller), so the CI test and --mock never reach Vertex.
 */
import type { CaseRecord, JudgeResult } from "./types";

export const JUDGE_PROMPT_ID = "agent-eval/brief-judge";
export const JUDGE_PROMPT_VERSION = "1.0.0";

export const JUDGE_SYSTEM_PROMPT = `You are an independent reviewer. Another AI system researched an athlete and wrote a Brief about them. You check the Brief against the facts research found. You do not search the web and you do not use your own knowledge of the athlete: the FACTS list is the only evidence. Each fact is what its source says.

Answer two questions, each with pass or fail and a one-line reason.

1. positioning_supported: Do the FACTS support the Brief's big idea, verdict and positioning (from, to, statement, pillars)?
   PASS when each of them rests on facts in the list, read reasonably. A judgement may go beyond the facts, but it must not contradict them or depend on something the list does not contain.
   FAIL when any of them rests on a claim that is not in the list, or contradicts the list.

2. no_unsupported_facts: Is anything in the Brief stated as fact that the FACTS list does not contain?
   Look at every statement presented as true about the athlete or the world: results, numbers, dates, teams, schools, sponsors and partners, audience sizes, events, current status. Check lines marked inference too. Clearly labelled estimates, opinions, recommendations and plans are not facts.
   PASS when every factual statement is in the list.
   FAIL when at least one is not. List each such statement, quoted briefly, in "statements".

Rules:
- No scores. Pass or fail only, with one line of reason (at most 30 words).
- Be strict about numbers, dates, teams, schools and sponsors. Be lenient about wording.
- A past or one-off sponsor stated as current is an unsupported fact.
- If the FACTS list is empty, any factual statement about the athlete fails question 2.

Return JSON only, matching the response schema.`;

export const JUDGE_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    positioning_supported: { type: "OBJECT", properties: { pass: { type: "BOOLEAN" }, reason: { type: "STRING" } }, required: ["pass", "reason"] },
    no_unsupported_facts: {
      type: "OBJECT",
      properties: { pass: { type: "BOOLEAN" }, reason: { type: "STRING" }, statements: { type: "ARRAY", items: { type: "STRING" } } },
      required: ["pass", "reason", "statements"],
    },
  },
  required: ["positioning_supported", "no_unsupported_facts"],
} as const;

/** The judge's user message: the athlete, the facts (with sources), and the Brief as it is stored. */
export function judgeInput(name: string, sport: string, r: CaseRecord): string {
  // Everything the Brief may rest on: what research found and what the athlete told us.
  const facts = r.facts.filter((f) => f.status === "active" || f.status === "disputed");
  const idx = new Map(facts.map((f, i) => [f.id, `F${i + 1}`]));
  const source = (f: (typeof facts)[number]) => (f.type === "said" ? "the athlete told us" : f.sourceUrl ?? f.sourceRef ?? "-");
  const lines = [
    `ATHLETE: ${name} (${sport})`,
    ``,
    `FACTS (${facts.length})`,
    ...(facts.length ? facts.map((f) => `${idx.get(f.id)} | ${f.claim}${f.status === "disputed" ? " (disputed)" : ""} | source: ${source(f)}`) : ["(none)"]),
    ``,
    `BRIEF`,
    ...(r.brief?.sections ?? []).flatMap((s) => [
      `## ${s.title}`,
      ...s.lines.map((l) => `- [${l.kind}${l.factIds.length ? `; cites ${l.factIds.map((id) => idx.get(id) ?? "?").join(", ")}` : ""}] ${l.text}`),
      ...(s.soWhat ? [`- [so what] ${s.soWhat}`] : []),
    ]),
  ];
  return lines.join("\n");
}

export interface JudgeCall {
  system: string;
  user: string;
  schema: typeof JUDGE_RESPONSE_SCHEMA;
}
export interface JudgeAnswer {
  json: unknown;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
}
export type JudgeCaller = (call: JudgeCall) => Promise<JudgeAnswer>;

/** Run the judge on one record. Never throws: a failure is a JudgeResult with `error`. */
export async function judgeBrief(name: string, sport: string, r: CaseRecord, call: JudgeCaller): Promise<JudgeResult> {
  const t0 = Date.now();
  try {
    const a = await call({ system: JUDGE_SYSTEM_PROMPT, user: judgeInput(name, sport, r), schema: JUDGE_RESPONSE_SCHEMA });
    const j = (a.json ?? {}) as any;
    const crit = (x: any) => ({ pass: x?.pass === true, reason: String(x?.reason ?? "").slice(0, 300) });
    if (typeof j?.positioning_supported?.pass !== "boolean" || typeof j?.no_unsupported_facts?.pass !== "boolean") throw new Error("judge returned no verdict");
    return {
      provider: a.provider, model: a.model, costMicroUsd: a.costMicroUsd, latencyMs: Date.now() - t0,
      positioning_supported: crit(j.positioning_supported),
      no_unsupported_facts: { ...crit(j.no_unsupported_facts), statements: (Array.isArray(j.no_unsupported_facts.statements) ? j.no_unsupported_facts.statements : []).map(String).slice(0, 20) },
    };
  } catch (err: any) {
    const fail = { pass: false, reason: "judge error" };
    return { provider: "-", model: "-", costMicroUsd: 0, latencyMs: Date.now() - t0, positioning_supported: fail, no_unsupported_facts: { ...fail, statements: [] }, error: String(err?.message ?? err).slice(0, 300) };
  }
}

/**
 * Judge price, USD per million tokens (thinking tokens bill as output). An ESTIMATE used for the budget and the
 * report; override with AGENT_EVAL_JUDGE_PRICE='{"inputPerMTok":2,"outputPerMTok":12}' when Vertex pricing changes.
 */
export function judgePrice(): { inputPerMTok: number; outputPerMTok: number } {
  try {
    const p = JSON.parse(process.env.AGENT_EVAL_JUDGE_PRICE ?? "");
    if (Number.isFinite(p?.inputPerMTok) && Number.isFinite(p?.outputPerMTok)) return p;
  } catch { /* default below */ }
  return { inputPerMTok: 2, outputPerMTok: 12 };
}

/** The real caller: Gemini on Vertex (ADC), temperature 0, JSON out. Loaded lazily so tests never import the SDK. */
export async function vertexGeminiJudge(): Promise<JudgeCaller> {
  const { genai, GEMINI } = await import("../../server/lib/models");
  const model = process.env.AGENT_EVAL_JUDGE_MODEL || GEMINI.pro;
  return async (call) => {
    const r: any = await genai().models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: call.user }] }],
      config: { systemInstruction: call.system, temperature: 0, maxOutputTokens: 4096, responseMimeType: "application/json", responseSchema: call.schema as any },
    });
    const u = r.usageMetadata ?? {};
    const inputTokens = Number(u.promptTokenCount ?? 0);
    const outputTokens = Number(u.candidatesTokenCount ?? 0) + Number(u.thoughtsTokenCount ?? 0);
    const p = judgePrice();
    let json: unknown = null;
    try { json = JSON.parse(String(r.text ?? "")); } catch { json = null; }
    return { json, provider: "vertex-gemini", model, inputTokens, outputTokens, costMicroUsd: Math.ceil((inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok)) };
  };
}
