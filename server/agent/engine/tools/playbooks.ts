/**
 * agent/engine/tools/playbooks.ts — one of Mila's playbooks as served, with its version. It held get_playbook, the
 * playbook tool TrueForge's turns used over /mcp (moved from agent/mcp/, 5 Nov 2026); that tool went with TrueForge
 * (Mastra-only PR 3). On Mastra the playbooks are Mastra's own agent skills (engine/mastra/skills.ts), whose served
 * text is this same text (mila/load.ts readSkill; served.golden.json pins it).
 */
import { digestOf, readPlaybook, type MilaPlaybook } from "../../mila/build";

/** One playbook's text and version (the first 12 hex of its digest; line endings normalised so a checkout can't change it). */
export function loadPlaybook(name: string): { name: string; version: string; text: string } {
  const text = readPlaybook(name as MilaPlaybook).replace(/\r\n/g, "\n");
  return { name, version: digestOf(text).slice(0, 12), text };
}
