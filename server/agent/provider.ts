/**
 * agent/provider.ts — what the harness needs from a model provider, and nothing more.
 *
 * One model call = one `turn`: instructions + the conversation so far (provider-native items) + the tools on offer →
 * streamed text, the function calls the model made, the web searches it ran, and its usage. The harness never builds a
 * provider-native item itself; it asks the provider for one (userMessage / assistantMessage / toolOutput), so a second
 * provider is a second file, not a change to the loop.
 */
import type { BuiltinToolName, JsonSchema, ModelChoice, ModelProvider } from "../../shared/agent";
import type { ModelUsage } from "./models";

export interface ProviderFunctionTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** The schema is strict-ready (tools.ts strictJsonSchema): the provider may enforce it (OpenAI `strict: true`). */
  strict?: boolean;
}

export interface ProviderTurnRequest {
  model: ModelChoice;
  /** The stable prefix (base rules + skill procedure). Kept first and identical across a skill's runs for caching. */
  instructions: string;
  /** Provider-native items, built only through this provider's helpers. */
  input: unknown[];
  functions: ProviderFunctionTool[];
  builtins: BuiltinToolName[];
  /** Prompt-cache routing key (no athlete data in it). */
  cacheKey?: string;
  signal?: AbortSignal;
  /** Called with each streamed text delta. */
  onText?: (delta: string) => void;
}

export interface ProviderFunctionCall {
  callId: string;
  name: string;
  /** Raw JSON string, as the model produced it. The harness parses and validates it. */
  arguments: string;
}

export interface ProviderWebSearch {
  queries: string[];
  sources: Array<{ url: string; title?: string }>;
}

export interface ProviderTurnResult {
  text: string;
  functionCalls: ProviderFunctionCall[];
  webSearches: ProviderWebSearch[];
  usage: ModelUsage;
  /** Everything the model output this turn, to append to `input` before the next turn (reasoning, calls, text). */
  outputItems: unknown[];
  responseId?: string;
}

export interface AgentModelProvider {
  id: ModelProvider;
  turn(req: ProviderTurnRequest): Promise<ProviderTurnResult>;
  userMessage(text: string): unknown;
  assistantMessage(text: string): unknown;
  toolOutput(callId: string, output: string): unknown;
}
