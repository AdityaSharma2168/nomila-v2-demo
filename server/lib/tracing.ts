/**
 * tracing.ts — one place that decides whether model calls are observed, and where they go.
 *
 * ── WHY OBSERVABILITY AT ALL ────────────────────────────────────────────────
 * Fourteen model call sites across five providers and, until this file, nothing between
 * them. When a classification came out wrong there was no run to open; when the classifier
 * eval reported "±2–3% recall from Vertex 429s" there was no way to see the 429s. The
 * reasoning behind choosing Langfuse over masking and over the GCP-native stack is in
 * docs/plans/phase-1-observability.md §1 — the short version is that we run five providers
 * and Vertex-native logging sees two, which would have made the Narrator's three-model
 * bake-off unreadable and Studio's OpenRouter generation invisible.
 *
 * ── OFF BY DEFAULT, AND KILLABLE WITHOUT A DEPLOY ───────────────────────────
 * `LANGFUSE_TRACING` gates everything and defaults to false, matching MILA_VOICE_WEB and
 * STUDIO_ENABLED. It is a plain Cloud Run env var rather than a secret precisely so it can
 * be flipped during an incident:
 *
 *   gcloud run services update nomila-v2 --region=us-central1 \
 *     --update-env-vars LANGFUSE_TRACING=false
 *
 * Read through a getter rather than captured at module load, so the flag is live in tests
 * and a restart is not required to observe a change.
 *
 * ── WHAT LEAVES THE PROCESS ─────────────────────────────────────────────────
 * Full payloads: prompts and completions, which for us includes brand negotiation email,
 * chat turns and contract text. That exposure is accepted deliberately for now and is NOT
 * masked — see the plan doc. It is the reason self-hosting is a scheduled step rather than
 * a someday: the SDK and these spans do not change when the endpoint does.
 *
 * ── INITIALISATION ORDER ────────────────────────────────────────────────────
 * `startTracing()` must run before anything that creates spans. It is called at the very
 * top of server/index.ts for that reason. This is less fragile than typical OTel setups
 * because nothing here monkey-patches a library on import: the Kimi path uses an explicit
 * `observeOpenAI(client)` wrapper and the Gemini path uses explicit spans, so a late start
 * loses traces rather than breaking calls.
 */

import type { NodeSDK } from "@opentelemetry/sdk-node";
import type { LangfuseSpanProcessor } from "@langfuse/otel";
import { createLogger } from "../logger";

const logger = createLogger("tracing");

/** Live read, not captured at import — see the header. */
export function tracingEnabled(): boolean {
  if (process.env.LANGFUSE_TRACING?.trim().toLowerCase() !== "true") return false;
  // Fail closed on a half-configured deploy rather than throwing inside a model call.
  return Boolean(process.env.LANGFUSE_PUBLIC_KEY?.trim() && process.env.LANGFUSE_SECRET_KEY?.trim());
}

let sdk: NodeSDK | null = null;
let processor: LangfuseSpanProcessor | null = null;

/**
 * Start the OpenTelemetry pipeline. Idempotent, and a no-op when tracing is off.
 *
 * Never throws. An observability layer that can take the server down with it is a worse
 * problem than the blindness it was meant to fix, so a failure here logs and leaves the
 * process untraced.
 */
export function startTracing(): void {
  if (sdk) return;

  if (!tracingEnabled()) {
    const half = process.env.LANGFUSE_TRACING?.trim().toLowerCase() === "true";
    if (half) logger.warn("LANGFUSE_TRACING is on but keys are missing — tracing stays off");
    return;
  }

  try {
    // Required, not imported, and only once tracing is known to be ON. The OpenTelemetry SDK
    // pulls in a large dependency graph, and this module is imported by hot paths like
    // dealDetector purely for traceUnit — a static import would load all of it into every
    // caller, and into every test that touches them, for nothing. The type-only imports above
    // keep the annotations without emitting a require.
    const { NodeSDK } = require("@opentelemetry/sdk-node") as typeof import("@opentelemetry/sdk-node");
    const { LangfuseSpanProcessor } = require("@langfuse/otel") as typeof import("@langfuse/otel");
    processor = new LangfuseSpanProcessor();
    sdk = new NodeSDK({ spanProcessors: [processor] });
    sdk.start();
    logger.info({ baseUrl: process.env.LANGFUSE_BASE_URL ?? "(default)" }, "tracing started");
  } catch (err: any) {
    sdk = null;
    processor = null;
    logger.error({ error: err?.message?.slice(0, 200) }, "tracing failed to start — continuing untraced");
  }
}

/**
 * Run `fn` with every span started inside it tagged as the athlete's: Langfuse `userId` = her athlete id (plus
 * metadata.athlete_id), via the SDK's propagateAttributes, which rides the OpenTelemetry context into every async
 * continuation. This is what lets account deletion find and delete her traces (server/lib/privacy/langfuseTraces.ts).
 *
 * Applied at the two places an athlete enters: requireAuth (her requests) and traceUnit (any unit whose input names
 * an athleteId — workflow steps, detectDeal). Transparent when tracing is off or no athlete is known; never throws
 * on its own account and never runs `fn` twice.
 */
export function withTraceAthlete<T>(athleteId: string | null | undefined, fn: () => T): T {
  if (!athleteId || !tracingEnabled()) return fn();
  let propagate: ((params: { userId: string; metadata: Record<string, string> }, f: () => T) => T) | null = null;
  try {
    propagate = (require("@langfuse/tracing") as typeof import("@langfuse/tracing")).propagateAttributes as any;
  } catch (err: any) {
    logger.warn({ error: err?.message?.slice(0, 200) }, "propagateAttributes unavailable — trace left untagged");
  }
  return propagate ? propagate({ userId: athleteId, metadata: { athlete_id: athleteId } }, fn) : fn();
}

/**
 * Run `fn` as one TRACE — a unit of work, with every model call inside it as a child.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Two reasons, and the second is not optional.
 *
 * A trace should answer a question. "One message through detectDeal" answers *why did this
 * classify as NOISE* — the pre-filter verdict, the classify call, the confidence, the gate
 * decision, in order, in one view. A trace per model call answers nothing: it shows a
 * classification with no idea what preceded it or what was done with it.
 *
 * And `observeOpenAI`'s spans REQUIRE a parent. Verified against the live project: unrooted,
 * they export successfully and Langfuse v4 drops them silently — the export looks fine and
 * nothing is ingested. So without a root, every Kimi call in the codebase is invisible. The
 * Gemini path self-roots via `startObservation` and does not have this problem, which is
 * exactly why the gap went unnoticed until a Kimi call was traced on its own.
 *
 * ── SHAPE ───────────────────────────────────────────────────────────────────
 * `input` is the identifying handful — who and what, not the payload. The payload is on the
 * child generation already, and duplicating a contract or an email body onto the root would
 * double what we send for no added meaning. `output` is the RESULT, which is the thing you
 * actually scan a trace list for: skipped and why, or the deal it produced.
 *
 * Transparent when tracing is off: `fn` is called directly, so the disabled path costs one
 * boolean and behaves identically. Never changes what `fn` returns or throws.
 */
export async function traceUnit<T>(
  name: string,
  input: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  if (!tracingEnabled()) return fn();

  // Imported lazily so the disabled path does not pull the tracing SDK in at module load —
  // it keeps this file importable from anywhere without ordering concerns.
  const { startActiveObservation } = await import("@langfuse/tracing");

  // A unit that names its athlete tags its whole trace as hers (see withTraceAthlete).
  const athleteId = typeof input.athleteId === "string" ? input.athleteId : null;
  return withTraceAthlete(athleteId, () => startActiveObservation(name, async (span) => {
    span.update({ input });
    try {
      const result = await fn();
      span.update({ output: result as unknown });
      return result;
    } catch (err: any) {
      // Recorded and rethrown unchanged. A trace that hides the failure is worse than none,
      // and the caller's error handling must be unaffected by whether tracing is on.
      span.update({ output: { error: err?.message?.slice(0, 500) }, level: "ERROR" });
      throw err;
    }
  }));
}

/**
 * Wrap an Anthropic client so `messages.create` is recorded as a generation.
 *
 * Hand-rolled because Langfuse ships no Anthropic wrapper for JS — `@langfuse/openai` is
 * OpenAI-only, which is why Kimi gets `observeOpenAI` and this does not. Same Proxy shape as
 * the Gemini path in models.ts: intercept the one method we call, forward the rest untouched,
 * so a caller reaching for `messages.stream` still works and is simply untraced until it is
 * added here.
 *
 * It lives in this file rather than beside its caller, the Narrator (the Claude handle resolver
 * that also used it was deleted 4 Nov 2026). The Narrator is the reason it matters: its copy is
 * chosen by a bake-off across models, and comparing what each one actually returned is not
 * possible from logs.
 *
 * Cached in a WeakMap keyed on the client, because callers re-enter their accessor on every
 * call and the Narrator's bake-off does so once per option per model — allocating a Proxy per
 * request would be pure waste. Keying on the client rather than a module-level slot is what
 * keeps callers from ever handing each other the wrong wrapper.
 */
const _tracedAnthropic = new WeakMap<object, unknown>();

export function observeAnthropic<T extends { messages: { create: (...a: any[]) => any } }>(client: T): T {
  if (!tracingEnabled()) return client;
  const hit = _tracedAnthropic.get(client);
  if (hit) return hit as T;

  const tracedMessages = new Proxy(client.messages, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "create" || typeof value !== "function") return value;

      return async (params: any, ...rest: any[]) => {
        // Required lazily: startObservation is only needed on the traced path, and this file
        // is imported by modules that must stay cheap when tracing is off.
        const { startObservation } = require("@langfuse/tracing");
        const generation = startObservation(
          "anthropic.messages.create",
          {
            model: params?.model,
            input: params?.messages,
            modelParameters: {
              max_tokens:  params?.max_tokens ?? null,
              temperature: params?.temperature ?? null,
              // The system prompt — the field the prompt registry versions in step 1.4, and
              // the one that actually differs between the Narrator's bake-off entrants.
              system:      typeof params?.system === "string" ? params.system : null,
            },
          },
          { asType: "generation" },
        );
        try {
          const res = await value.call(target, params, ...rest);
          generation.update({
            // Anthropic returns content BLOCKS, not a string. Join the text ones rather than
            // stringifying the array, so the output pane shows prose and not JSON.
            output: Array.isArray(res?.content)
              ? res.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("")
              : null,
            usageDetails: {
              input:  res?.usage?.input_tokens  ?? 0,
              output: res?.usage?.output_tokens ?? 0,
              // Cache tokens are billed differently and are the whole point of prompt caching;
              // omitting them would make a cached call look as expensive as an uncached one.
              ...(res?.usage?.cache_read_input_tokens
                ? { cache_read_input_tokens: res.usage.cache_read_input_tokens } : {}),
              ...(res?.usage?.cache_creation_input_tokens
                ? { cache_creation_input_tokens: res.usage.cache_creation_input_tokens } : {}),
            },
          }).end();
          return res;
        } catch (err: any) {
          generation.update({ output: { error: err?.message?.slice(0, 500) }, level: "ERROR" }).end();
          throw err;
        }
      };
    },
  });

  const wrapped = new Proxy(client, {
    get(target, prop, receiver) {
      return prop === "messages" ? tracedMessages : Reflect.get(target, prop, receiver);
    },
  }) as T;
  _tracedAnthropic.set(client, wrapped);
  return wrapped;
}

/**
 * Record one Studio image/video generation.
 *
 * Separate from the text helpers because the useful numbers are different. There are no tokens
 * here — what you want when a generation looks wrong is the prompt, the model that served it,
 * how many assets came back, what it COST and how long it took. Cost especially: Studio spend is
 * per-asset and real, and `usageDetails` is where Langfuse aggregates it, so a video job that
 * quietly picks the audio SKU shows up in the same place as everything else.
 *
 * Output is the asset URLs and the cost, never the bytes.
 */
export async function traceGeneration<T extends { assets?: unknown[]; cost?: any; model?: string; provider?: string }>(
  input: { task: string; provider: string; model: string; prompt?: string; references?: number },
  fn: () => Promise<T>,
): Promise<T> {
  if (!tracingEnabled()) return fn();
  const { startObservation } = await import("@langfuse/tracing");

  const generation = startObservation(
    `studio.${input.task}`,
    { model: input.model, input: { prompt: input.prompt, references: input.references, provider: input.provider } },
    { asType: "generation" },
  );
  try {
    const res = await fn();
    const assets = (res?.assets ?? []) as Array<{ url?: string; mimeType?: string }>;
    generation.update({
      model: res?.model ?? input.model,
      output: assets.map((a) => ({ url: a?.url, mimeType: a?.mimeType })),
      usageDetails: { assets: assets.length },
      // Sent as the generation's own cost rather than a token count, which is what makes the
      // Langfuse cost column meaningful for a provider that never reports tokens.
      costDetails: typeof res?.cost?.amountUsd === "number" ? { total: res.cost.amountUsd } : undefined,
      metadata: { costBasis: res?.cost?.basis, provider: res?.provider ?? input.provider },
    }).end();
    return res;
  } catch (err: any) {
    // Unlike spend, failures ARE recorded: a timeout or a provider error is the thing you are
    // looking for when a generation never arrived, and costLog deliberately skips it.
    generation.update({
      output: { error: err?.message?.slice(0, 500) },
      metadata: { code: err?.code, provider: input.provider },
      level: "ERROR",
    }).end();
    throw err;
  }
}

/**
 * Push anything buffered. Worth calling before the process exits: spans are batched, so a
 * short-lived run (a cron tick, a script) can otherwise finish and lose everything it did.
 */
export async function flushTracing(): Promise<void> {
  if (!processor) return;
  try {
    await processor.forceFlush();
  } catch (err: any) {
    logger.warn({ error: err?.message?.slice(0, 200) }, "tracing flush failed");
  }
}
