/**
 * agent/engine/mastra/runtime.ts — Mila on Mastra, as a LIBRARY inside our Express app (the only engine).
 *
 * Built once per process, on first use (Mastra is loaded lazily, so a process that runs no Mila turn never loads it):
 *   storage   PostgresStore on OUR database, Mastra's OWN schema (MILA_MASTRA_SCHEMA, default "mastra"), disableInit:
 *             the tables come from migrations/0147_mastra_engine.sql and are never created or altered at runtime. Its
 *             own small pool (MILA_MASTRA_POOL_MAX, default 4).
 *   memory    thread history only (MILA_MASTRA_HISTORY messages), thread = our mila_tf_sessions row id, resource = the
 *             athlete. Working memory, semantic recall, observational memory and generated titles are OFF (what Mila
 *             keeps about an athlete is OUR record, written through our tools and their tap; never engine memory).
 *   agent     ONE shared Mila: Mila's definition text (mila/build.ts, chat surface), in
 *             Mastra's words (engine "mastra": the playbook tool is Mastra's skill tool, mila/load.ts ENGINE_TERMS). The
 *             model is an @ai-sdk/openai provider instance (never a "provider/model" string). Tools are given per
 *             turn (tools.ts), never on the agent. Skills: Mila's playbooks as Mastra agent skills, resolved per
 *             request from the turn's scope (skills.ts milaSkillsResolver; Mastra adds skill / skill_read /
 *             skill_search itself).
 *   off       feature telemetry (MASTRA_TELEMETRY_DISABLED=1, also set in the Dockerfile); no EE features configured
 *             (no FGA provider, no licence key; @mastra/core itself ships EE code, none of it switched on); no
 *             observability exporter (our own Langfuse trace, trace.ts), no Mastra server routes mounted anywhere.
 */
import { buildMilaInstructions } from "../../mila/build";
import { MASTRA } from "../config";
import { milaSkillsProcessor, milaSkillsResolver } from "./skills";

export interface MastraRuntime {
  mastra: import("@mastra/core").Mastra;
  agent: import("@mastra/core/agent").Agent;
  memory: import("@mastra/memory").Memory;
  storage: import("@mastra/pg").PostgresStore;
  close(): Promise<void>;
}

let _rt: Promise<MastraRuntime> | null = null;

export function mastraRuntime(): Promise<MastraRuntime> {
  return (_rt ??= build().catch((err) => { _rt = null; throw err; }));
}

/** Tests and scripts: drop the cached runtime (closing its pool). */
export async function resetMastraRuntime(): Promise<void> {
  const rt = _rt;
  _rt = null;
  if (rt) await (await rt.catch(() => null))?.close();
}

/** "openai/<id>" → an @ai-sdk/openai provider instance with OPENAI_API_KEY. Anything else is refused. */
export async function modelFor(id: string): Promise<unknown> {
  const [provider, ...rest] = id.split("/");
  const name = rest.join("/");
  if (provider !== "openai" || !name) throw new Error(`MILA_MASTRA_MODEL: unsupported model "${id}" (openai/<model> only)`);
  if (!process.env.OPENAI_API_KEY) throw new Error("Mila on Mastra needs OPENAI_API_KEY");
  return (await import("@ai-sdk/openai")).createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(name);
}

/** The agent's definition: Mila's instructions in Mastra's words and her playbooks as agent skills (tests share it). */
export function milaAgentDefinition() {
  return {
    instructions: buildMilaInstructions({ surface: "chat", engine: "mastra" }),
    skills: milaSkillsResolver(),
    // In place of Mastra's own SkillsProcessor (same id): the playbooks listed, and the skill tools described, in our words.
    inputProcessors: [milaSkillsProcessor()],
  };
}

/** The memory options: history only, every automatic memory feature off (policy; pinned by engine tests). */
export function memoryOptions(lastMessages: number) {
  return {
    lastMessages,
    semanticRecall: false,
    generateTitle: false,
    workingMemory: { enabled: false },
    observationalMemory: false,
  } as const;
}

async function build(): Promise<MastraRuntime> {
  process.env.MASTRA_TELEMETRY_DISABLED = "1";
  if (!process.env.DATABASE_URL) throw new Error("Mila on Mastra needs DATABASE_URL");
  const [{ Mastra }, { Agent }, { Memory }, { PostgresStore }] = await Promise.all([
    import("@mastra/core"), import("@mastra/core/agent"), import("@mastra/memory"), import("@mastra/pg"),
  ]);
  const storage = new PostgresStore({
    id: "nomila-mastra", connectionString: process.env.DATABASE_URL, schemaName: MASTRA.schema, disableInit: true, max: MASTRA.poolMax,
  } as ConstructorParameters<typeof PostgresStore>[0]);
  const memory = new Memory({ storage, options: memoryOptions(MASTRA.history) } as ConstructorParameters<typeof Memory>[0]);
  const agent = new Agent({
    id: "mila",
    name: "Mila",
    ...milaAgentDefinition(),
    model: await modelFor(MASTRA.model),
    memory,
  } as ConstructorParameters<typeof Agent>[0]);
  const mastra = new Mastra({ agents: { mila: agent }, storage, logger: false } as ConstructorParameters<typeof Mastra>[0]);
  return {
    mastra, agent: mastra.getAgent("mila"), memory, storage,
    async close() { await (storage as unknown as { close?: () => Promise<void> }).close?.().catch(() => undefined); },
  };
}
