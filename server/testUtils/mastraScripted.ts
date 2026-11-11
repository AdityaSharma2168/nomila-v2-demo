/**
 * testUtils/mastraScripted.ts — TESTS ONLY: a scripted language model for Mastra (AI SDK LanguageModelV3 shape)
 * and a Mastra runtime on an in-memory store. No provider, no network, no database: a test can run the REAL Mastra
 * Agent loop (memory, tool calls, our tools' execute) with model output it controls.
 *
 * Each model call (one per agent step) takes the next scripted step: tool calls, or text. The prompt each call received
 * is kept, so a test can see what Mastra replayed from memory, and so are the names and descriptions of the tools it was offered.
 */
export type ScriptedStep = (
  | { tools: Array<{ name: string; args: Record<string, unknown>; id?: string }> }
  | { text: string | string[] }
) & {
  /** A slow step: the model call waits this long first (ending early, with an error, when the turn is aborted). */
  delayMs?: number;
  /** This step's usage (default MOCK_USAGE). */
  usage?: typeof MOCK_USAGE;
};

export const MOCK_USAGE = { inputTokens: { total: 1000, noCache: 200, cacheRead: 800, cacheWrite: 0 }, outputTokens: { total: 50, text: 40, reasoning: 10 } };

export function scriptedModel(steps: ScriptedStep[]) {
  let n = 0;
  const prompts: unknown[] = [];
  const toolNames: string[][] = [];
  const toolDescriptions: Array<Record<string, string>> = [];
  /** The provider options each call received (what Mastra passed on from agent.stream: store:false, the effort). */
  const providerOptions: unknown[] = [];
  const model = {
    specificationVersion: "v3", provider: "test", modelId: "scripted", supportedUrls: {},
    async doGenerate() { throw new Error("scriptedModel: generate is not used"); },
    async doStream(opts: { prompt: unknown; abortSignal?: AbortSignal; tools?: Array<{ name?: string; description?: string }>; providerOptions?: unknown }) {
      prompts.push(opts.prompt);
      providerOptions.push(opts.providerOptions);
      toolNames.push((opts.tools ?? []).map((t) => String(t?.name)).sort());
      toolDescriptions.push(Object.fromEntries((opts.tools ?? []).map((t) => [String(t?.name), String(t?.description ?? "")])));
      const s = steps[Math.min(n, steps.length - 1)];
      const i = n++;
      if (s.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const signal = opts.abortSignal;
          if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
          const t = setTimeout(resolve, s.delayMs);
          signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason ?? new Error("aborted")); }, { once: true });
        });
      }
      const usage = s.usage ?? MOCK_USAGE;
      const parts: unknown[] = [{ type: "stream-start", warnings: [] }];
      if ("tools" in s) {
        s.tools.forEach((t, k) => parts.push({ type: "tool-call", toolCallId: t.id ?? `call_${i}_${k}`, toolName: t.name, input: JSON.stringify(t.args) }));
        parts.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage });
      } else {
        parts.push({ type: "text-start", id: `t${i}` });
        for (const chunk of Array.isArray(s.text) ? s.text : [s.text]) parts.push({ type: "text-delta", id: `t${i}`, delta: chunk });
        parts.push({ type: "text-end", id: `t${i}` }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
      }
      return { stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
    },
  };
  return { model, prompts, toolNames, toolDescriptions, providerOptions, get calls() { return n; } };
}

/**
 * A real Mastra Agent + Memory on an in-memory store, with the given model. Same memory options as the runtime.
 * `mila: true`: the runtime's own definition (Mila's Mastra instructions and her playbooks as agent skills).
 */
export async function testRuntime(model: unknown, opts: { mila?: boolean } = {}) {
  process.env.MASTRA_TELEMETRY_DISABLED = "1";
  const [{ Mastra }, { Agent }, { Memory }, { InMemoryStore }, { memoryOptions }] = await Promise.all([
    import("@mastra/core"), import("@mastra/core/agent"), import("@mastra/memory"), import("@mastra/core/storage"), import("../agent/engine/mastra/runtime"),
  ]);
  const definition = opts.mila ? (await import("../agent/engine/mastra/runtime")).milaAgentDefinition() : { instructions: "test instructions" };
  const storage = new InMemoryStore({ id: "test" } as never);
  const memory = new Memory({ storage, options: memoryOptions(40) } as never);
  const agent = new Agent({ id: "mila", name: "Mila", ...definition, model, memory } as never);
  const mastra = new Mastra({ agents: { mila: agent }, storage, logger: false } as never);
  return { mastra, agent: mastra.getAgent("mila"), memory, storage };
}
