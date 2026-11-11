/**
 * agent/evals/live.ts — the PAID eval run's engine (`npm run evals:live`, scripts/evals-live.ts). Never in CI, never in
 * `npm test`: the script refuses under CI, prints the estimate and plays nothing until a person types "yes".
 *
 *   livePlan()           what one call per case sends: what live Mila on Mastra reads (evals/mastraChat.ts: the
 *                        Mastra agent's instructions and the chat surface's playbooks message), the chat skill's tools
 *                        as Mastra offers them (with the skill · skill_read · skill_search playbook tools), the chat
 *                        skill's model
 *   estimateLiveCost()   a pessimistic estimate from the request size and the model's price (models.ts priceOf)
 *   playToolChoice()     each tool-choice case as ONE model call — the athlete's question, no memory, no history — and
 *                        the model's first step graded by the offline grader (grade.ts, mode "first")
 *
 * The chat skill's tools are offered whether or not their flags are on: this grades selection, not rollout. The card
 * cases (offline/cardChoice.cases.ts) are listed but not played until #1193's card tools are registered here.
 */
import type { ModelChoice } from "../../../shared/agent";
import { createDefaultRegistry } from "../coreTools";
import { loadJob } from "../jobs";
import { costOf, modelFor, priceOf } from "../models";
import type { AgentModelProvider, ProviderFunctionTool } from "../provider";
import { specOf, strictJsonSchema, type AgentTool } from "../tools";
import { gradeToolChoice, type Grade, type ToolLookup } from "./offline/grade";
import { TOOL_CHOICE_CASES, type ToolCall, type ToolChoiceCase } from "./offline/toolChoice.cases";
import { mastraChatSystem, mastraSkillTools } from "./mastraChat";

export interface LivePlan {
  model: ModelChoice;
  instructions: string;
  functions: ProviderFunctionTool[];
  builtins: Array<NonNullable<AgentTool["builtin"]>>;
  lookup: ToolLookup;
}

export function livePlan(): LivePlan {
  const skill = loadJob("chat");
  const registry = createDefaultRegistry();
  const offered = skill.tools;
  const tools = offered.map((n) => registry.get(n)).filter((t): t is AgentTool => !!t);
  const skillTools = mastraSkillTools();
  const byName = new Map(skillTools.map((t) => [t.name, t]));
  return {
    model: modelFor(skill),
    instructions: mastraChatSystem(offered),
    functions: [
      ...tools.filter((t) => t.kind !== "builtin").map((t) => {
        const s = specOf(t);
        return { name: s.name, description: s.description, parameters: strictJsonSchema(s.schema), strict: true };
      }),
      // Mastra's own tools: its argument shapes have optional fields, sent as they are (not strict).
      ...skillTools.map((t) => { const s = specOf(t); return { name: s.name, description: s.description, parameters: s.schema, strict: false }; }),
    ],
    builtins: tools.filter((t) => t.kind === "builtin" && t.builtin).map((t) => t.builtin!),
    lookup: { get: (n) => byName.get(n) ?? registry.get(n), offered: [...offered, ...skillTools.map((t) => t.name)] },
  };
}

/** Output tokens a first step spends (reasoning + calls), assumed high so the estimate errs over. */
export const EST_OUTPUT_TOKENS_PER_CASE = 1500;
/** ~4 characters a token; the estimate rounds the request up by a quarter for the wire's own framing. */
const tokensOf = (chars: number) => Math.ceil((chars / 4) * 1.25);

export function estimateLiveCost(plan: Pick<LivePlan, "model" | "instructions" | "functions">, cases: readonly Pick<ToolChoiceCase, "question">[] = TOOL_CHOICE_CASES):
{ cases: number; inputTokensPerCase: number; outputTokensPerCase: number; usd: number; model: string } {
  const fixed = plan.instructions.length + JSON.stringify(plan.functions).length;
  const inputTokens = cases.reduce((n, c) => n + tokensOf(fixed + c.question.length), 0);
  const outputTokens = cases.length * EST_OUTPUT_TOKENS_PER_CASE;
  const p = priceOf(plan.model.model);
  const usd = (inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1e6;
  return { cases: cases.length, inputTokensPerCase: cases.length ? Math.round(inputTokens / cases.length) : 0, outputTokensPerCase: EST_OUTPUT_TOKENS_PER_CASE, usd, model: plan.model.model };
}

export interface LiveResult { id: string; calls: ToolCall[]; grade: Grade; microUsd: number }

/** One model call per case; the first step graded. A call whose arguments are not JSON is graded with {} (and fails its schema). */
export async function playToolChoice(provider: AgentModelProvider, plan: LivePlan, cases: readonly ToolChoiceCase[] = TOOL_CHOICE_CASES): Promise<LiveResult[]> {
  const out: LiveResult[] = [];
  for (const c of cases) {
    const turn = await provider.turn({
      model: plan.model, instructions: plan.instructions, input: [provider.userMessage(c.question)],
      functions: plan.functions, builtins: plan.builtins, cacheKey: "evals:live:tool-choice",
    });
    const calls: ToolCall[] = [
      ...turn.webSearches.map(() => ({ name: "web_search", args: {} })),
      ...turn.functionCalls.map((f) => {
        let args: Record<string, unknown> = {};
        try { const v = JSON.parse(f.arguments || "{}"); if (v && typeof v === "object") args = v; } catch { /* graded as {} */ }
        return { name: f.name, args };
      }),
    ];
    out.push({ id: c.id, calls, grade: gradeToolChoice(c, calls, plan.lookup, "first"), microUsd: costOf(plan.model.model, turn.usage).microUsd });
  }
  return out;
}
