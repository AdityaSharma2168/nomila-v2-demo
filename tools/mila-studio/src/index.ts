/**
 * tools/mila-studio/src/index.ts — the DEV-ONLY entry `npm run mila:studio` (tools/mila-studio, its own package) loads into
 * local Mastra Studio. Never imported by the server, never in the root install, server_dist or the image.
 *
 * Mila here is built from the SAME definition the engine serves, read from the generated catalogue (npm run catalogue
 * runs first, so it is current):
 *   instructions  docs/catalogue/prompt-register.json → mila.instructions.<surface> (buildMilaInstructions' exact text)
 *   tools         docs/catalogue/catalogue.json → the tools of one Mila pass (default "chat"), with their registry
 *                 descriptions and argument JSON Schemas
 * and NOTHING real behind it:
 *   model         a scripted model by default: no provider call, ever. A developer opts in to a real one with
 *                 STUDIO_MODEL=openai/<model> plus OPENAI_API_KEY exported in their own shell (no .env is read:
 *                 MASTRA_SKIP_DOTENV=1).
 *   athlete       a FAKE pass for the test athlete dd1a8a80-d31b-423a-a572-9d146716cb0f: no signature, no database.
 *   tools         stubs: every call returns a fixed "studio stub" result and reads or writes nothing.
 *   off           telemetry (MASTRA_TELEMETRY_DISABLED=1), storage, memory, observability, EE features; the server binds
 *                 to 127.0.0.1 only.
 *
 * In the scripted model, type `/tool <name> {json args}` to make Mila call a tool (it shows the stub's result), or
 * anything else to see the echo. tools/mila-studio/README.md says more.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";

process.env.MASTRA_TELEMETRY_DISABLED = "1";

export const TEST_ATHLETE_ID = "dd1a8a80-d31b-423a-a572-9d146716cb0f";
const PASS = (process.env.STUDIO_PASS || "chat").trim();

/** The fake pass: the shape of an athlete pass, for display only. It is never signed and nothing verifies it. */
export const FAKE_PASS = { athleteId: TEST_ATHLETE_ID, skillId: PASS, scopes: ["read", "draft", "propose", "act"], fake: true } as const;

/** The repo root: the first folder up from where mastra dev runs us (tools/mila-studio/.mastra, src/public) that holds the catalogue. */
function repoRoot(): string {
  for (const start of [process.env.MASTRA_PROJECT_ROOT, process.cwd()].filter((x): x is string => !!x)) {
    for (let d = resolve(start); ; d = dirname(d)) {
      if (existsSync(join(d, "docs", "catalogue", "catalogue.json"))) return d;
      if (dirname(d) === d) break;
    }
  }
  throw new Error("studio: docs/catalogue/catalogue.json not found — run npm run catalogue from the repo root");
}
const ROOT = repoRoot();
const readJson = (rel: string) => JSON.parse(readFileSync(join(ROOT, "docs", "catalogue", rel), "utf8"));

interface CatalogueTool { name: string; description: string; passes: string[]; permission: string; args: Record<string, unknown> }
const catalogue = readJson("catalogue.json") as { tools: CatalogueTool[]; core: { built: Array<{ surface: string; registerId: string }> } };
const register = readJson("prompt-register.json") as { entries: Array<{ id: string; text: string }> };

const surface = catalogue.core.built.some((b) => b.surface === PASS) ? PASS : "chat";
const instructions = register.entries.find((e) => e.id === `mila.instructions.${surface}`)?.text;
if (!instructions) throw new Error(`studio: no mila.instructions.${surface} in docs/catalogue/prompt-register.json — run npm run catalogue`);
const passTools = catalogue.tools.filter((t) => t.passes.includes(PASS));
if (!passTools.length) throw new Error(`studio: no tools for pass "${PASS}" in docs/catalogue/catalogue.json`);

/** One registry tool as a stub: its real name, description and argument schema; a fixed result; no I/O. */
function stubTool(t: CatalogueTool) {
  return createTool({
    id: t.name,
    description: t.description,
    inputSchema: t.args as never,
    execute: async (input: unknown) => JSON.stringify({
      status: "studio_stub",
      tool: t.name,
      permission: t.permission,
      athleteId: FAKE_PASS.athleteId,
      note: "Local Mastra Studio stub: nothing was read or written, no provider or database was called.",
      input: input ?? {},
    }),
  } as never);
}

// ─── the scripted model (AI SDK LanguageModelV2, no network) ─────────────────────────────────────────────────────

type Part = Record<string, unknown>;
type Prompt = Array<{ role: string; content: unknown }>;

const textOf = (content: unknown): string =>
  typeof content === "string" ? content
    : Array.isArray(content) ? content.map((p: any) => (p?.type === "text" ? p.text : "")).join("") : "";

/** What the scripted model does with a prompt: call a tool on `/tool name {args}`, describe a tool result, else echo. */
export function scriptedReply(prompt: Prompt, toolNames: string[]): { text: string } | { toolName: string; input: string } {
  const last = prompt[prompt.length - 1];
  if (last?.role === "tool") {
    const r = (Array.isArray(last.content) ? last.content : []).map((p: any) => {
      const out = p?.output;
      const value = out?.type === "text" ? out.value : JSON.stringify(out?.value ?? p?.result ?? null);
      return `${p?.toolName ?? "tool"} → ${String(value).slice(0, 600)}`;
    }).join("\n");
    return { text: `[scripted model, no provider call] The tool answered:\n${r}` };
  }
  const user = [...prompt].reverse().find((m) => m.role === "user");
  const said = textOf(user?.content).trim();
  const m = /^\/tool\s+([a-z_][a-z0-9_]*)\s*([\s\S]*)$/i.exec(said);
  if (m) {
    if (!toolNames.includes(m[1])) return { text: `[scripted model] No tool "${m[1]}" on the ${PASS} pass. Tools: ${toolNames.join(", ")}.` };
    const args = m[2].trim() || "{}";
    try { JSON.parse(args); } catch { return { text: `[scripted model] The arguments must be JSON, e.g. /tool ${m[1]} {}` }; }
    return { toolName: m[1], input: args };
  }
  return {
    text: `[scripted model, no provider call] You said: "${said.slice(0, 400)}". Mila's ${surface} instructions (${instructions!.length} chars) and ${toolNames.length} stubbed tools are loaded for the test athlete ${TEST_ATHLETE_ID}. Type /tool <name> {json} to call one.`,
  };
}

let calls = 0;
function scriptedModel() {
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const decide = (options: any) => scriptedReply(options.prompt as Prompt, Object.keys(options.tools ? Object.fromEntries((options.tools as any[]).map((t) => [t.name, t])) : {}));
  return {
    specificationVersion: "v2",
    provider: "studio",
    modelId: "scripted",
    supportedUrls: {},
    async doGenerate(options: any) {
      const r = decide(options);
      const content = "text" in r ? [{ type: "text", text: r.text }] : [{ type: "tool-call", toolCallId: `studio-${++calls}`, toolName: r.toolName, input: r.input }];
      return { content, finishReason: "text" in r ? "stop" : "tool-calls", usage, warnings: [] };
    },
    async doStream(options: any) {
      const r = decide(options);
      const parts: Part[] = [{ type: "stream-start", warnings: [] }, { type: "response-metadata", id: `studio-${++calls}`, modelId: "scripted", timestamp: new Date(0) }];
      if ("text" in r) parts.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: r.text }, { type: "text-end", id: "t" });
      else parts.push({ type: "tool-call", toolCallId: `studio-${calls}`, toolName: r.toolName, input: r.input });
      parts.push({ type: "finish", finishReason: "text" in r ? "stop" : "tool-calls", usage });
      return { stream: new ReadableStream<Part>({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
    },
  };
}

/** STUDIO_MODEL=openai/<id> with OPENAI_API_KEY exported: the developer's explicit opt-in to real provider calls. */
async function model(): Promise<unknown> {
  const id = process.env.STUDIO_MODEL?.trim();
  if (!id) return scriptedModel();
  const [provider, ...rest] = id.split("/");
  if (provider !== "openai" || !rest.length) throw new Error(`STUDIO_MODEL: unsupported "${id}" (openai/<model> only)`);
  if (!process.env.OPENAI_API_KEY) throw new Error("STUDIO_MODEL is set but OPENAI_API_KEY is not exported in this shell (no .env is read)");
  const { createOpenAI } = await import("@ai-sdk/openai");
  return createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(rest.join("/"));
}

const mila = new Agent({
  id: "mila",
  name: "Mila",
  description: `Mila (${PASS} pass, ${surface} instructions) for the fake test athlete ${TEST_ATHLETE_ID}. Tools are stubs; the model is ${process.env.STUDIO_MODEL ? process.env.STUDIO_MODEL : "scripted (no provider calls)"}.`,
  instructions,
  model: (await model()) as never,
  tools: Object.fromEntries(passTools.map((t) => [t.name, stubTool(t)])),
} as ConstructorParameters<typeof Agent>[0]);

export const mastra = new Mastra({
  agents: { mila },
  server: { host: "127.0.0.1", port: Number(process.env.STUDIO_PORT || 4111) },
  logger: false,
} as ConstructorParameters<typeof Mastra>[0]);
