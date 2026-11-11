/**
 * agent/evals/offline/grade.ts — the graders the offline evals and the paid run share. Pure: structure and selection,
 * never wording. A grade is { pass, problems } with one plain line per problem.
 *
 *   gradeToolChoice   a turn's tool calls against a ToolChoiceCase: every tool real and offered to the chat skill,
 *                     every argument valid under the tool's own schema, the first call and its arguments, the musts,
 *                     the nevers, the order. mode "first" (a live model's FIRST step) grades the first call only.
 *   gradeCardChoice   a turn's card tool calls against a CardEvalCase: the right tool, the right card for it, every
 *                     accepted headline inside the budget, a refused one retried; "none" = no card at all
 */
import type { AgentTool } from "../../tools";
import { CARD_HEADLINE_MAX, CARD_TOOL_CARDS, type CardChoiceOutput, type CardEvalCase } from "./cardChoice.cases";
import type { ToolCall, ToolChoiceCase } from "./toolChoice.cases";

export interface Grade { pass: boolean; problems: string[] }

export interface ToolLookup {
  /** A registered tool by name (ToolRegistry.get). */
  get(name: string): AgentTool | undefined;
  /** The tools the chat skill lists (loadJob("chat").tools). */
  offered: readonly string[];
}

export function gradeToolChoice(c: ToolChoiceCase, calls: readonly ToolCall[], tools: ToolLookup, mode: "turn" | "first" = "turn"): Grade {
  const problems: string[] = [];
  const graded = mode === "first" ? calls.slice(0, 1) : calls;
  if (!graded.length) return { pass: false, problems: ["no tool was called"] };
  for (const call of graded) {
    const t = tools.get(call.name);
    if (!t) { problems.push(`${call.name}: no such tool`); continue; }
    if (!tools.offered.includes(call.name)) problems.push(`${call.name}: not offered to the chat skill`);
    if (t.kind !== "builtin") {
      const parsed = t.args.safeParse(call.args);
      if (!parsed.success) problems.push(`${call.name}: arguments invalid (${parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ")})`);
    }
  }
  const first = graded[0];
  if (!c.expect.first.includes(first.name)) problems.push(`first call ${first.name}, expected one of ${c.expect.first.join(", ")}`);
  else for (const [k, allowed] of Object.entries(c.expect.firstArgs ?? {})) {
    if (!allowed.includes(first.args[k])) problems.push(`first call ${k} = ${JSON.stringify(first.args[k])}, expected one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}`);
  }
  const names = graded.map((x) => x.name);
  for (const n of c.expect.never) if (names.includes(n)) problems.push(`${n} must never be called here`);
  if (mode === "turn") {
    for (const n of c.expect.must ?? []) if (!names.includes(n)) problems.push(`${n} was never called`);
    for (const [a, b] of c.expect.order ?? []) {
      const ia = names.indexOf(a);
      const ib = names.indexOf(b);
      if (ia >= 0 && ib >= 0 && ia > ib) problems.push(`${a} must come before ${b}`);
    }
  }
  return { pass: problems.length === 0, problems };
}

export function gradeCardChoice(c: CardEvalCase, out: CardChoiceOutput): Grade {
  const problems: string[] = [];
  const accepted = out.calls.filter((x) => !x.refused);
  if (c.expect.tool === "none") {
    if (out.calls.length) problems.push(`expected words only, got ${out.calls.map((x) => x.tool).join(", ")}`);
    return { pass: problems.length === 0, problems };
  }
  if (!accepted.length) problems.push(`no card was made (expected ${c.expect.tool})`);
  for (const x of out.calls) {
    if (x.tool !== c.expect.tool) problems.push(`called ${x.tool}, expected ${c.expect.tool}`);
    if (!CARD_TOOL_CARDS[x.tool]?.includes(x.card)) problems.push(`${x.tool} cannot make a ${x.card} card`);
    if (x.card !== c.expect.card) problems.push(`made a ${x.card} card, expected ${c.expect.card}`);
    const long = x.headline.length > CARD_HEADLINE_MAX;
    if (long && !x.refused) problems.push(`headline over ${CARD_HEADLINE_MAX} characters was accepted`);
    if (!long && x.refused === "headline_too_long") problems.push("a headline inside the budget was refused");
  }
  if (out.calls.some((x) => x.refused) && out.calls[out.calls.length - 1]?.refused) problems.push("a refused card was never retried");
  if (accepted.length > 1) problems.push(`${accepted.length} cards for one answer`);
  return { pass: problems.length === 0, problems };
}
