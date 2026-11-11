/**
 * agent/engine/mastra/skills.ts — Mila's playbooks as Mastra's NATIVE agent skills (owner, 3 Nov
 * 2026). TrueForge's get_playbook tool went with TrueForge (Mastra-only PR 3): these are the only way to a playbook.
 *
 *   source    server/agent/mila/skills ONLY (mila/load.ts listSkillNames), as INLINE skills (@mastra/core/skills
 *             createSkill): no LocalSkillSource and no path, so Mastra never touches the file system for a skill and
 *             nothing outside that folder (the job prompts under server/agent/jobs above all) can be listed, searched
 *             or read. Mastra's skill_read reads only inside an inline skill (inline/<name>/SKILL.md).
 *   body      the instructions ARE readSkill(name), the one loader and cleanSection (served.golden.json pins the
 *             text); Mastra trims it. The description is the
 *             SKILL.md front-matter's (model-facing: the Prompt Register). nomila.yaml never reaches the model.
 *   per turn  a dynamic resolver (Agent `skills`), from the requestContext turn.ts builds server-side
 *             (SKILLS_CONTEXT_KEY): the turn's surface and the names of the tools its pass can see. A skill is offered
 *             when its nomila.yaml `surfaces` has that surface and its `flag` is on (flagOn). No scope in the context
 *             (anything but our turn) ⇒ no skills (fails closed).
 *   tools     Mastra adds skill / skill_read / skill_search itself (Agent.listSkillTools). They read our own
 *             instructions only, never anything of the athlete's, and change nothing: read-only. Their results are our
 *             instructions, so they are not fenced as outside data. Their display rules
 *             (display.ts) show a fixed status line and no output, so no skill text reaches the client stream.
 *   wording   OURS, not Mastra's (calm wording). Mastra's own SkillsProcessor would add an XML catalog and a second
 *             system message starting "IMPORTANT: Skills are NOT tools…". An agent whose inputProcessors include a
 *             processor with the id "skills-processor" gets no SkillsProcessor of its own (@mastra/core 1.79.0
 *             Agent.getSkillsProcessors / hasEagerSkillsProcessor), so milaSkillsProcessor takes that id and adds ONE
 *             system message in our words (playbooksCatalog) and, through processInputStep's supported `tools` result
 *             (as Mastra's own SkillSearchProcessor uses it), gives the three skill tools our descriptions
 *             (MILA_SKILL_TOOL_DESCRIPTIONS). Their argument descriptions and result texts (e.g. `Skill "x" not found.
 *             Available skills: …`) stay Mastra's. All of it is model-facing: the Prompt Register.
 */
import { wrapTagged } from "../../../lib/externalContent";
import { MILA_DIR, MILA_SKILL_SURFACES, listSkillNames, readSidecar, readSkill, readSkillFrontMatter, type MilaSkillSidecar } from "../../mila/load";

/** The tools Mastra adds for agent skills (@mastra/core workspace/skills/tools.ts createSkillTools). */
export const MASTRA_SKILL_TOOLS = ["skill", "skill_read", "skill_search"] as const;

/** The requestContext key carrying the turn's skill scope (set by turn.ts from server-side values only). */
export const SKILLS_CONTEXT_KEY = "nomila.milaSkills";

export type MilaSkillSurface = (typeof MILA_SKILL_SURFACES)[number];
export interface MilaSkillScope {
  surface: MilaSkillSurface;
  /** The tools the turn's pass can see (engine/tools/registry.ts visibleTools): what a skill's flag is checked against. */
  tools: readonly string[];
}

/** The surface of a Mastra turn: the waitlist pass, a turn Mila starts herself (isolated: proactive), or the chat. */
export function turnSurface(p: { skillId: string; isolated?: boolean; waitlistSkillId: string }): MilaSkillSurface {
  if (p.skillId === p.waitlistSkillId) return "waitlist";
  if (p.isolated) return "proactive";
  return "chat";
}

/**
 * A skill's flag (nomila.yaml `flag`, "the flag the playbook's tools sit behind") is on when it is null, or when one of
 * the skill's own tools is visible this turn: a tool's `enabled()` IS its flag, so a retired flag (always on) and a
 * live one (MILA_TF_WAITLIST) both read right, from one place. A flagged skill that names no tools reads the flag
 * itself (only the exact string "true").
 */
export function flagOn(sc: Pick<MilaSkillSidecar, "flag" | "tools">, visibleTools: readonly string[]): boolean {
  if (sc.flag === null) return true;
  if (sc.tools.length) return sc.tools.some((t) => visibleTools.includes(t));
  return process.env[sc.flag] === "true";
}

/** The skills one turn is offered, by name (sorted): its surface, its flags. */
export function allowedSkillNames(scope: MilaSkillScope, dir: string = MILA_DIR): string[] {
  return listSkillNames(dir).filter((name) => {
    const sc = readSidecar(name, dir);
    return sc.surfaces.includes(scope.surface) && flagOn(sc, scope.tools);
  });
}

/** The offered skills as Mastra inline skills: front-matter name + description, the served body (readSkill). */
export async function milaSkillsFor(scope: MilaSkillScope, dir: string = MILA_DIR) {
  const { createSkill } = await import("@mastra/core/skills");
  return allowedSkillNames(scope, dir).map((name) => {
    const fm = readSkillFrontMatter(name, dir);
    return createSkill({ name: fm.name, description: fm.description, instructions: readSkill(name, dir) });
  });
}

type ContextReader = { get(key: string): unknown } | undefined;

/** The scope in a requestContext, or null when it is missing or not one turn.ts would write. */
export function scopeFrom(requestContext: ContextReader): MilaSkillScope | null {
  const v = requestContext?.get(SKILLS_CONTEXT_KEY) as Partial<MilaSkillScope> | undefined;
  if (!v || typeof v !== "object") return null;
  if (!(MILA_SKILL_SURFACES as readonly unknown[]).includes(v.surface)) return null;
  if (!Array.isArray(v.tools) || !v.tools.every((t) => typeof t === "string")) return null;
  return { surface: v.surface as MilaSkillSurface, tools: v.tools };
}

/** The Agent's `skills`: per request, the turn's skills; none without a scope. */
export function milaSkillsResolver(dir: string = MILA_DIR) {
  return async ({ requestContext }: { requestContext: ContextReader }) => {
    const scope = scopeFrom(requestContext);
    return scope ? milaSkillsFor(scope, dir) : [];
  };
}

// ─── our wording, in place of Mastra's SkillsProcessor text (model-facing: the Prompt Register) ───────────────────

/** The id Mastra checks: with a processor of this id configured, the agent adds no SkillsProcessor of its own. */
export const SKILLS_PROCESSOR_ID = "skills-processor";

/** The first line of the playbooks message. */
export const PLAYBOOKS_LEAD =
  "Your playbooks are listed below. Load one with the skill tool when you start that kind of work; they are instructions, not actions, so give a playbook's name to the skill tool rather than calling it.";

/** The three skill tools' descriptions, in our words. */
export const MILA_SKILL_TOOL_DESCRIPTIONS: Readonly<Record<(typeof MASTRA_SKILL_TOOLS)[number], string>> = {
  skill: "Load one of your playbooks by name: the full instructions for one area of your work. Free; reads nothing about the athlete. " +
    "Use when you start a kind of work whose playbook you have not loaded in this conversation; don't reload one you already have.",
  skill_read: "Read some lines of a playbook again: skillName is the playbook, path is SKILL.md, startLine and endLine pick the lines. " +
    "Use only when you need one part again; the skill tool loads a playbook whole.",
  skill_search: "Search the text of your playbooks for one detail. Use only when you need a specific rule and don't know which playbook has it.",
};

/** The one system message listing a turn's playbooks: the lead line, then each name and description, sorted by name. */
export function playbooksCatalog(skills: ReadonlyArray<{ name: string; description: string }>): string {
  const lines = [...skills].sort((a, b) => a.name.localeCompare(b.name)).map((s) => `- ${s.name}: ${s.description}`);
  return `${PLAYBOOKS_LEAD}\n\n${wrapTagged(lines.join("\n"), "available_playbooks", {}, { newlines: true })}`;
}

/** A copy of a tool (every own property, enumerable or not, and its prototype) with another description. */
function withDescription<T extends object>(tool: T, description: string): T {
  return Object.create(Object.getPrototypeOf(tool), {
    ...Object.getOwnPropertyDescriptors(tool),
    description: { value: description, enumerable: true, writable: true, configurable: true },
  });
}

type SystemAdder = { addSystem(m: { role: "system"; content: string }): unknown };

/**
 * The agent's skills processor (Agent `inputProcessors`, id "skills-processor"): on every step of a turn with skills,
 * our one catalog message and our skill-tool descriptions. A turn without skills (no scope, none allowed) gets
 * nothing, and Mastra adds no skill tools to it either (the resolver returned none).
 */
export function milaSkillsProcessor(dir: string = MILA_DIR) {
  return {
    id: SKILLS_PROCESSOR_ID,
    name: "Mila playbooks",
    async processInputStep(args: { messageList: SystemAdder; requestContext?: ContextReader; tools?: Record<string, unknown> }) {
      const scope = scopeFrom(args.requestContext);
      const names = scope ? allowedSkillNames(scope, dir) : [];
      if (!names.length) return undefined;
      args.messageList.addSystem({ role: "system", content: playbooksCatalog(names.map((n) => readSkillFrontMatter(n, dir))) });
      if (!args.tools) return undefined;
      const tools: Record<string, unknown> = { ...args.tools };
      for (const t of MASTRA_SKILL_TOOLS) {
        const tool = tools[t];
        if (tool && typeof tool === "object") tools[t] = withDescription(tool, MILA_SKILL_TOOL_DESCRIPTIONS[t]);
      }
      return { tools };
    },
  };
}
