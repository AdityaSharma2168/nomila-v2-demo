/**
 * mila/build.ts — Mila's definition (draft, 25 Oct 2026) assembled into ONE instruction string for the engine
 * (the Mastra agent's `instructions`; Mastra is the only engine since Mastra-only PR 3).
 *
 *   buildMilaInstructions({ surface: "chat" })   instructions/00-identity … 60-playbooks-index, then surfaces/<surface>.md,
 *                                                 in Mastra's words (engine/mastra/runtime.ts, and the chat job
 *                                                 jobs/chat.yaml)
 *   readPlaybook("deals")                         one playbook (skills/deals/SKILL.md), as Mastra's skill tool serves it
 *
 * Reading and cleaning the files is load.ts's job (the one loader for Mila's text); this file keeps the API its
 * importers use. Order is the file-name order, so the stable part comes first and caches; the athlete's CONTEXT is NOT
 * here (it travels with each turn). HTML comments are authoring notes and are stripped. The exact built text goes into
 * the Prompt Register before anything ships (prompt-register rule).
 */
import { createHash } from "node:crypto";
import { MILA_DIR, cleanSection, coreFiles, listSkillNames, readCore, readSkill, readSurface, type MilaTextEngine } from "./load";

export { MILA_DIR, cleanSection, coreFiles };

export const MILA_SURFACES = ["chat", "voice", "public", "waitlist"] as const;
export type MilaSurface = (typeof MILA_SURFACES)[number];
export const MILA_PLAYBOOKS = ["deals", "bookings", "documents", "public-page", "onboarding"] as const;
/**
 * Playbooks a surface sends itself instead of listing them in the chat's index (60-playbooks-index): the waitlist's
 * (waitlist/turn.ts sends it on the session's first turn; the skill "waitlist" includes the same text and scopes the
 * waitlist pass's tools).
 */
export const MILA_SURFACE_PLAYBOOKS = ["waitlist"] as const;
export type MilaPlaybook = (typeof MILA_PLAYBOOKS)[number] | (typeof MILA_SURFACE_PLAYBOOKS)[number];

/**
 * Which core files each surface uses. The public page is a different role (Nomila's assistant answering visitors,
 * never the athlete's agent), so it takes only the identity line; its full rule list stays code-built
 * (server/mila/public/prompt.ts) until it moves here in stage 2.
 */
export const SURFACE_CORE: Record<MilaSurface, "all" | string[]> = {
  chat: "all",
  voice: "all",
  public: ["00-identity.md"],
  // The landing's Mila-hosted waitlist (MILA_TF_WAITLIST): Mila as the athlete's own agent, so the whole definition.
  waitlist: "all",
};

/**
 * `engine` renders the files' engine terms (load.ts ENGINE_TERMS): "mastra", the only one (the Mastra agent's
 * instructions, engine/mastra/runtime.ts, and every job's, jobs.ts loadJob).
 */
export function buildMilaInstructions(opts: { surface: MilaSurface; dir?: string; engine?: MilaTextEngine }): string {
  const dir = opts.dir ?? MILA_DIR;
  const engine = opts.engine ?? "mastra";
  const wanted = SURFACE_CORE[opts.surface];
  const files = coreFiles(dir).filter((f) => wanted === "all" || wanted.includes(f));
  const parts = files.map((f) => readCore(f, dir, engine));
  parts.push(readSurface(opts.surface, dir, engine));
  return parts.filter(Boolean).join("\n\n") + "\n";
}

/** One playbook as served (skills/<name>/SKILL.md, front-matter and authoring comments out), as Mastra's skill tool serves it. */
export function readPlaybook(name: MilaPlaybook, dir: string = MILA_DIR): string {
  return readSkill(name, dir);
}

/** Every playbook's name (skills/<name>/SKILL.md), sorted: what Mastra's skill tool serves (engine/mastra/skills.ts), read from the folder, never a list in code. */
export function listPlaybooks(dir: string = MILA_DIR): string[] {
  return listSkillNames(dir);
}

/** A rough token count (about four characters per token), for budgets and the review page. */
export function approxTokens(text: string): number {
  return Math.round(text.length / 4);
}

export function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
