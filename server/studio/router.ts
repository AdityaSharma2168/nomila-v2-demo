/**
 * studio/router — the single door to generation.
 *
 *   generate(task, inputs, opts?)  → GenerationResult
 *   estimate(task, inputs, opts?)  → GenerationPlan      (cost WITHOUT generating)
 *
 * Call sites name a TASK, never a provider or a model. The provider/model behind each task comes
 * from studio/config.ts, so re-pointing image.generate at a different model is an env change and
 * every caller follows automatically.
 *
 * The estimate path is what backs the pre-generation check: the athlete sees the plan and the cost
 * before any billable call fires. `generate(..., { dryRun: true })` is the same thing through the
 * generate door, for callers that would rather branch on a flag than call a second function.
 */
import { createLogger } from "../logger";
import { traceGeneration } from "../lib/tracing";
import { routeFor } from "./config";
import { recordGeneration, safeRef, toCostBasis } from "./costLog";
import { orderBySlot } from "./refOrder";
import { openrouterAdapter } from "./adapters/openrouter";
import { vertexAdapter } from "./adapters/vertex";
import { falAdapter } from "./adapters/fal";
import { localAdapter } from "./adapters/local";
import {
  GenerationError,
  type GenerationAdapter, type GenerationInputs, type GenerationPlan, type GenerationResult,
  type GenerationTask, type ProviderName, type ProviderOpts,
} from "./types";

const logger = createLogger("studio/router");

const ADAPTERS: Record<ProviderName, GenerationAdapter> = {
  openrouter: openrouterAdapter,
  vertex:     vertexAdapter,
  fal:        falAdapter,
  // PR 19: in-process, and it serves image.crop alone (studio/adapters/local.ts).
  local:      localAdapter,
};

/** Resolve task → adapter + model, honouring opts overrides. Exported for tests and for the UI's
 *  "which model will run" line; makes no call and never touches the network. */
export function resolve(task: GenerationTask, opts: ProviderOpts = {}): { adapter: GenerationAdapter; model: string } {
  const route = routeFor(task);
  const providerName = opts.provider ?? route.provider;
  const adapter = ADAPTERS[providerName];
  if (!adapter) {
    throw new GenerationError(`Unknown provider "${providerName}" for ${task}`, "unknown_provider");
  }
  if (!adapter.supports(task)) {
    throw new GenerationError(`Provider "${providerName}" does not support ${task}`, "unsupported_task", providerName);
  }
  return { adapter, model: opts.model ?? route.model };
}

function validate(task: GenerationTask, inputs: GenerationInputs): void {
  if (!inputs?.prompt?.trim()) {
    throw new GenerationError(`${task} requires a non-empty prompt`, "invalid_input");
  }
  if (task === "image.edit" && !inputs.references?.length) {
    throw new GenerationError("image.edit requires at least one reference image", "invalid_input");
  }
  // Same claim as the edit guard: there is nothing to segment without an image. The adapter refuses
  // a URL reference on top of this (studio/adapters/fal.ts ①) — that one is a privacy rule and
  // belongs with the transport, this one is "the task is incoherent" and belongs at the door.
  if (task === "image.segment" && !inputs.references?.length) {
    throw new GenerationError("image.segment requires the image to segment", "invalid_input");
  }
  // PR 19: a crop without her photo or its planned window is incoherent, as an edit without a frame is.
  if (task === "image.crop" && (!inputs.references?.length || !inputs.crop)) {
    throw new GenerationError("image.crop requires the photo and its planned window", "invalid_input");
  }
  if (inputs.n !== undefined && (!Number.isInteger(inputs.n) || inputs.n < 1)) {
    throw new GenerationError("n must be a positive integer", "invalid_input");
  }
  if (inputs.durationSeconds !== undefined && inputs.durationSeconds <= 0) {
    throw new GenerationError("durationSeconds must be positive", "invalid_input");
  }
}

/**
 * What WOULD run and what it WOULD cost — no billable call, no network. Safe to call on every
 * keystroke of a prompt box.
 */
export function estimate(task: GenerationTask, inputs: GenerationInputs, opts: ProviderOpts = {}): GenerationPlan {
  validate(task, inputs);
  const { adapter, model } = resolve(task, opts);
  return {
    task,
    provider: adapter.name,
    model,
    inputs: {
      prompt: inputs.prompt,
      references: inputs.references?.length ?? 0,
      width: inputs.width, height: inputs.height,
      n: inputs.n ?? 1,
      durationSeconds: inputs.durationSeconds,
    },
    cost: adapter.estimate(task, inputs, model, opts),
  };
}

/**
 * Generate. With `opts.dryRun` this resolves the plan and returns a zero-asset result carrying the
 * ESTIMATED cost, so a caller can use one code path for "show me the price" and "do it".
 */
export async function generate(
  task: GenerationTask,
  inputs: GenerationInputs,
  opts: ProviderOpts = {},
): Promise<GenerationResult> {
  validate(task, inputs);
  const { adapter, model } = resolve(task, opts);

  if (opts.dryRun) {
    const plan = estimate(task, inputs, opts);
    const now = new Date().toISOString();
    logger.info({ task, provider: plan.provider, model, costUsd: plan.cost.amountUsd, unpriced: plan.cost.unpriced }, "dry run — no call made");
    return {
      task, provider: plan.provider, model,
      assets: [],
      cost: plan.cost,
      timings: { startedAt: now, completedAt: now, ms: 0 },
      raw: { dryRun: true, plan },
    };
  }

  if (opts.signal?.aborted) {
    throw new GenerationError("Generation aborted before it started", "aborted", adapter.name);
  }

  // Traced here for the same reason spend is logged here: this is the one door. Wrapping the
  // adapter call rather than the adapters covers Vertex and OpenRouter both, and covers whatever
  // provider is added next without anyone remembering to instrument it.
  //
  // Deliberately NOT around the provider's raw HTTP: generateVideo polls a job to completion, so
  // instrumenting the fetch would bury one generation under dozens of identical poll spans. One
  // span per generation is the unit anyone actually wants to read.
  const result = await traceGeneration(
    // Slots are deliberately NOT added here. `traceGeneration`'s input type lives in server/lib —
    // outside this lane — and the cost log already records them per generation, which is where an
    // audit of "what was this conditioned on" would actually look.
    { task, provider: adapter.name, model, prompt: inputs.prompt, references: inputs.references?.length ?? 0 },
    () => adapter.generate(task, inputs, model, opts),
  );

  // Instrumented HERE rather than in a wrapper so every caller is covered by construction — there is
  // no second door that generates without being counted. The cost and its basis are taken from what
  // the adapter returned and never recomputed, so a Vertex estimate stays flagged as an estimate.
  // Failures are not logged: OpenRouter bills image generation all-or-nothing, so a throw costs
  // nothing and would only pollute the per-model averages.
  if (!opts.noLog) {
    await recordGeneration({
      task,
      model: result.model,
      provider: result.provider,
      inputRefs: {
        count: inputs.references?.length ?? 0,
        ...(opts.refIds?.length ? { ids: opts.refIds } : {}),
        // Read off the refs the router is already holding, THROUGH THE SAME ordering the adapters
        // apply — a log line that listed them in caller order would disagree with the request it
        // claims to describe, and this line's whole value is being readable as evidence of what a
        // generation was conditioned on. Identity for an untyped caller, and absent entirely.
        ...(() => {
          const slots = orderBySlot(inputs.references ?? [])
            .map((r) => r.slot)
            .filter((slot): slot is NonNullable<typeof slot> => !!slot);
          return slots.length ? { slots } : {};
        })(),
      },
      outputRef: safeRef(result.assets[0]?.url) ?? (result.assets[0]?.bytes ? `bytes:${result.assets[0].bytes.byteLength}` : null),
      cost: result.cost.amountUsd,
      costBasis: toCostBasis(result.cost.basis),
      // Passed through UNCHANGED, for the same reason the basis is: it is the only field that
      // distinguishes a cost computed from returned tokens from one that fell back to the
      // pre-generation estimate. Both are basis "estimated"; only detail says which.
      detail: result.cost.detail ?? null,
      latencyMs: result.timings.ms,
      timestamp: result.timings.completedAt,
      // The join keys, off the caller (PR 11). The router knows none of them itself.
      attribution: opts.attribution,
    });
  }

  return result;
}

export type {
  GenerationTask, GenerationInputs, GenerationResult, GenerationPlan, ProviderOpts, ProviderName,
} from "./types";
export { GenerationError } from "./types";
