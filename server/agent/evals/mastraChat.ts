/**
 * agent/evals/mastraChat.ts — what live Mila's chat on Mastra is given, for the evals that play the chat without the
 * Mastra runtime (agent/evals/live.ts, evals/agent/mila-v2/run.ts). Pure: no model, no database, no Mastra runtime.
 *
 *   mastraChatSystem()   the system text a Mastra chat turn's model reads: the agent's instructions
 *                        (engine/mastra/runtime.ts: buildMilaInstructions({ surface: "chat", engine: "mastra" })), then the
 *                        playbooks message the skills processor adds on every step (engine/mastra/skills.ts
 *                        playbooksCatalog, the chat surface's playbooks for the tools offered). Mastra sends the two as
 *                        separate system messages; an eval with one instructions string joins them with a blank line.
 *   MASTRA_SKILL_TOOL_ARGS / mastraSkillTools()
 *                        the three playbook tools Mastra adds (skill · skill_read · skill_search: MASTRA_SKILL_TOOLS),
 *                        with our descriptions (MILA_SKILL_TOOL_DESCRIPTIONS) and Mastra's own argument shapes
 *                        (@mastra/core createSkillTools). mastraChat.test.ts pins the shapes to Mastra's, so a Mastra
 *                        upgrade that changes them fails here instead of drifting.
 */
import { z } from "zod";
import { buildMilaInstructions } from "../mila/build";
import { readSkillFrontMatter } from "../mila/load";
import { MASTRA_SKILL_TOOLS, MILA_SKILL_TOOL_DESCRIPTIONS, allowedSkillNames, playbooksCatalog } from "../engine/mastra/skills";
import type { AgentTool } from "../tools";

export type MastraSkillTool = (typeof MASTRA_SKILL_TOOLS)[number];

/** Mastra's argument shapes for its skill tools (@mastra/core workspace createSkillTools), mirrored for the evals. */
export const MASTRA_SKILL_TOOL_ARGS: Readonly<Record<MastraSkillTool, z.ZodObject<z.ZodRawShape>>> = {
  skill: z.object({ name: z.string().describe("The name or path of the skill to activate. Use the path when multiple skills share the same name.") }),
  skill_read: z.object({
    skillName: z.string().describe("The name or path of the skill. Use the path when multiple skills share the same name."),
    path: z.string().describe("Path to the file relative to the skill root (e.g. \"references/colors.md\", \"scripts/run.sh\")"),
    startLine: z.number().optional().describe("Starting line number (1-indexed). If omitted, starts from the beginning."),
    endLine: z.number().optional().describe("Ending line number (1-indexed, inclusive). If omitted, reads to the end."),
  }),
  skill_search: z.object({
    query: z.string().describe("The search query"),
    skillNames: z.array(z.string()).optional().describe("Optional list of skill names to search within"),
    topK: z.number().optional().describe("Maximum number of results to return (default: 5)"),
  }),
};

/** The skill tools as registry-shaped tools, for graders that look a tool up by name (never executed). */
export function mastraSkillTools(): AgentTool[] {
  return MASTRA_SKILL_TOOLS.map((name) => ({
    name, description: MILA_SKILL_TOOL_DESCRIPTIONS[name], kind: "ours", permission: "read", args: MASTRA_SKILL_TOOL_ARGS[name],
  }) as unknown as AgentTool);
}

/** The system text a Mastra chat turn's model reads, for a turn offered `offeredTools` (the chat job's, by default all). */
export function mastraChatSystem(offeredTools: readonly string[]): string {
  const names = allowedSkillNames({ surface: "chat", tools: offeredTools });
  return `${buildMilaInstructions({ surface: "chat", engine: "mastra" }).trimEnd()}\n\n${playbooksCatalog(names.map((n) => readSkillFrontMatter(n)))}`;
}
