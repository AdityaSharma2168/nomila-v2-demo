/**
 * studio/qa/cost — what an inspection cost, in dollars, and why that needed its own file.
 *
 * ─── ⚠️  studio/config.ts CANNOT PRICE THIS CALL, AND THAT IS NOT AN OVERSIGHT ─────────────────
 *
 * Every unit in `studio/config.ts`'s price table is about producing an IMAGE: `per_image_token`
 * priced on the tokens of the returned picture, `per_second` for video, `per_image` for a SAM mask.
 * A QA check is the other shape entirely — images go IN, a few hundred tokens of JSON come OUT —
 * and `priceFor()` has no unit that describes it. Asking it would return `unpriced`.
 *
 * So this file holds the second shape rather than widening the first. The alternative was adding a
 * `per_token_io` unit to `config.ts` and a `"image.inspect"` member to `GenerationTask`, which
 * reaches `routes()`, `routeFor`, `supports()` on all three adapters and the pricing table — a
 * change to the shipped generation path, for a stage that is observation-only. Not worth it, and
 * explicitly out of this PR's scope.
 *
 * The same reasoning keeps QA off `studio/router`: it calls `genai()` directly, which is what
 * `studio/autoMask.ts:78` already does for region detection. The probe memo notes that autoMask's
 * direct call is consequently INVISIBLE to the cost log — "anything that reports Studio spend from
 * the cost log is under-reporting by this amount". QA does not repeat that: every check returns its
 * own cost and the verdict carries the total, so the number is on the record beside the generation
 * it inspected.
 *
 * ─── THE RATES ARE CONFIGURABLE AND THEIR BASIS IS ALWAYS "estimated" ──────────────────────────
 *
 * `config.ts`'s own rule is that an estimate must never be displayed as a billed figure, and Vertex
 * reports tokens rather than dollars for these models. So every figure here is `estimated`, and it
 * says so on the record. A rate that moves is an env change, not a redeploy.
 */

import { recordGeneration } from "../costLog";
import type { GenerationAttribution } from "../types";

/** Gemini Flash, per token. Overridable so a price change is config, not a code change. */
const FLASH_IN = Number(
  process.env.STUDIO_QA_USD_PER_INPUT_TOKEN ?? 0.3 / 1_000_000,
);
const FLASH_OUT = Number(
  process.env.STUDIO_QA_USD_PER_OUTPUT_TOKEN ?? 2.5 / 1_000_000,
);

/**
 * One multimodal-embedding call. Flat per image, like SAM — the API bills per request, not per
 * token, so a token unit would be modelling something that does not exist.
 */
const EMBED_CALL = Number(process.env.STUDIO_QA_USD_PER_EMBED ?? 0.0001);

export interface QaSpend {
  usd: number;
  /** Always "estimated": Vertex reports tokens, we multiply. Never presented as a billed figure. */
  basis: "estimated";
  visionCalls: number;
  embedCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export const zeroSpend = (): QaSpend => ({
  usd: 0,
  basis: "estimated",
  visionCalls: 0,
  embedCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
});

/** A running total across the checks of one generation. Mutable on purpose — one per inspection. */
export class SpendMeter {
  private s: QaSpend = zeroSpend();

  vision(usage: { inputTokens: number; outputTokens: number } | null): void {
    this.s.visionCalls++;
    if (!usage) return;
    this.s.inputTokens += usage.inputTokens;
    this.s.outputTokens += usage.outputTokens;
  }

  embed(n = 1): void {
    this.s.embedCalls += n;
  }

  /**
   * A call whose usage the provider did not report still costs money. Counting it as $0 is the
   * "confident zero" config.ts refuses, so an unreported vision call is charged at a nominal token
   * estimate instead — deliberately a FLOOR, and flagged by the call count not matching the tokens.
   */
  total(): QaSpend {
    return {
      ...this.s,
      usd: Number(
        (
          this.s.inputTokens * FLASH_IN +
          this.s.outputTokens * FLASH_OUT +
          this.s.embedCalls * EMBED_CALL
        ).toFixed(6),
      ),
    };
  }
}

/**
 * ─── THE ONE DOOR, FOR SPEND THAT IS NOT A GENERATION (PR 11, R-2) ─────────────────────────────
 *
 * The paragraph above was true and is now half the story: QA still keeps its own meter, and the
 * total is still on the verdict, but "on the record beside the generation" meant on the ASSET, where
 * nothing that reads the cost log could see it. Every inspection, detection and recommendation now
 * also writes one line through `recordGeneration`, with a task name of its own and the join keys it
 * can know, so one report can say what a job cost end to end. The meter's arithmetic is unchanged:
 * the line carries the meter's figure, basis "estimated", and says so in `detail`.
 */
export interface OffRouterSpend {
  task: "image.inspect" | "clip.inspect" | "image.detect" | "edit.recommend";
  model: string;
  spend: QaSpend;
  latencyMs: number;
  /** Ids the call read — the asset(s) inspected, the photo detected on. Never a signed url. */
  inputRefs?: string[];
  attribution?: Partial<GenerationAttribution> | null;
}

/**
 * Write the line. Best-effort, and it CANNOT THROW: this runs after a call that has already spent
 * and, for QA, after a verdict that is already on the record. `recordGeneration` swallows the disk;
 * this swallows everything else (a verdict shaped by a stub, a meter that never ran), because a
 * logging failure that undid an inspection would be the arithmetic every file in qa/ refuses.
 */
export async function recordOffRouterSpend(s: OffRouterSpend): Promise<void> {
  try {
    const spend = s.spend ?? zeroSpend();
    await recordGeneration({
      task: s.task,
      model: s.model,
      // `genai()` is the Vertex client (server/lib/models.ts), so the provider is Vertex whichever
      // Gemini model the call named.
      provider: "vertex",
      inputRefs: {
        count: s.inputRefs?.length ?? 0,
        ...(s.inputRefs?.length ? { ids: s.inputRefs } : {}),
      },
      outputRef: null,
      cost: spend.usd ?? 0,
      costBasis: "estimated",
      detail: `qa/cost rates: ${spend.visionCalls ?? 0} vision (${spend.inputTokens ?? 0} in / ${spend.outputTokens ?? 0} out tokens) + ${spend.embedCalls ?? 0} embed`,
      latencyMs: s.latencyMs ?? 0,
      attribution: s.attribution ?? null,
    });
  } catch {
    // Deliberately silent: see above. The verdict, the mask or the recommendation already landed.
  }
}

/** One vision call's usage, priced at the rates above — for the callers that meter nothing else. */
export function spendForVision(
  usage: { inputTokens: number; outputTokens: number } | null,
): QaSpend {
  const m = new SpendMeter();
  m.vision(usage);
  return m.total();
}

/** Merge sub-totals — the verdict sums its checks without them knowing about each other. */
export function sumSpend(parts: (QaSpend | null | undefined)[]): QaSpend {
  const out = zeroSpend();
  for (const p of parts) {
    if (!p) continue;
    out.usd += p.usd;
    out.visionCalls += p.visionCalls;
    out.embedCalls += p.embedCalls;
    out.inputTokens += p.inputTokens;
    out.outputTokens += p.outputTokens;
  }
  out.usd = Number(out.usd.toFixed(6));
  return out;
}
