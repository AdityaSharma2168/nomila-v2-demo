/**
 * llm.ts — bounded concurrency for model calls, at the call primitive.
 *
 * Design decision, from docs/llm-concurrency-spec.md and unchanged: the gate lives at the
 * PRIMITIVE (`lib/kimi.ts`), not at each fan-out site. Every caller and every unbounded
 * `Promise.all` is then throttled with no changes of its own — they simply queue. The
 * alternative, bounding each fan-out, means finding all of them and finding them again every
 * time someone adds one.
 *
 * ── THE PROBLEM IT SOLVES ───────────────────────────────────────────────────
 * A Gmail push carrying N messages fans out `Promise.allSettled(messages.map(detectDeal))`,
 * and each `detectDeal` makes up to three Kimi calls (classify, summarize, score). Several
 * mailboxes receiving mail at the same moment multiply that against ONE shared Vertex quota
 * with no coordination. The result is a 429 cascade, and 429s here do not merely retry — a
 * failed classify defaults to NOISE, so throttling silently becomes misclassification.
 *
 * It is already measurable: `docs/plans/deal-classifier-precision.md` records that "Vertex 429
 * rate-limits caused a handful of failed calls per run (default → NOISE), so exact recall
 * carries ±2–3%." The eval is being distorted by the thing this file bounds.
 *
 * ── WHY A HAND-ROLLED SEMAPHORE AND NOT p-limit ─────────────────────────────
 * `p-limit` is already in package.json and unused. It is also ESM-only from v7, and this
 * server bundles to CJS with `--packages=external`, so it stays a runtime `require`. Node 22
 * can `require()` an ESM module; **Node 20 cannot**, and the Dockerfile and CI both pin Node 20
 * while local development runs 22. Using it would work on every developer machine and throw
 * ERR_REQUIRE_ESM in the container — a failure that only appears in production.
 *
 * So: twenty lines, no dependency, no module-format risk. The spec allowed for exactly this
 * ("a tiny in-process semaphore (≈ p-limit) … no external dependency required").
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * It bounds a burst; it does not make one faster. Onboarding a 200-email mailbox still drains
 * through the gate. Throughput is a durable queue's job (Cloud Tasks → worker), which is
 * phase 2 and deliberately not this. The gate is also PER PROCESS: with Cloud Run at
 * maxScale 3 the real ceiling is three times the limit set here, which is why the defaults are
 * conservative and env-tunable rather than sized to the full quota.
 */

import { createLogger } from "../logger";

const logger = createLogger("llm-gate");

export interface Gate {
  /** Run `fn` once a slot is free. Rejections propagate; the slot is always released. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** In-flight count — for logging and tests, not for control flow. */
  readonly active: number;
  /** Queued-and-waiting count — for logging and tests. */
  readonly pending: number;
}

/**
 * A FIFO semaphore.
 *
 * FIFO matters: LIFO would let a steady arrival rate starve the oldest waiter indefinitely,
 * and the oldest waiter here is usually the earliest message in a burst — the one whose
 * webhook is closest to timing out.
 *
 * `limit < 1` is treated as 1 rather than as "unbounded", because the plausible way to get a
 * zero here is a mistyped env var, and an unbounded gate silently reinstates the bug this
 * file exists to fix.
 */
export function createGate(limit: number, label = "gate"): Gate {
  const max = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  const queue: Array<() => void> = [];
  let active = 0;

  function release(): void {
    active--;
    const next = queue.shift();
    if (next) next();
  }

  return {
    get active() { return active; },
    get pending() { return queue.length; },

    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active >= max) {
        // Log only when a burst actually forms, so the quiet path stays silent.
        if (queue.length === 0) logger.info({ label, max }, "llm gate saturated — queueing");
        await new Promise<void>((resolve) => queue.push(resolve));
      }
      active++;
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

/**
 * Vertex-hosted Kimi — classify, score, summarize, group, extract. The busy one.
 *
 * Sized conservatively on purpose. The true safe value is
 * `provider requests/min ÷ 60 × average call seconds`, and we have not measured the quota;
 * starting low and raising it on evidence is the cheap direction to be wrong in. Remember to
 * multiply by instance count: maxScale 3 means this is 24 concurrent calls in the worst case,
 * not 8.
 */
export const kimiGate = createGate(Number(process.env.KIMI_MAX_CONCURRENCY ?? 8), "kimi");

/**
 * Moonshot-hosted Kimi — `kimiSearch` only, and only from the research pipeline.
 *
 * A SEPARATE gate because it is a separate provider with a separate quota and its own billing.
 * Sharing one gate across two quotas would make research back-pressure the deal pipeline for
 * no reason.
 */
export const moonshotGate = createGate(Number(process.env.MOONSHOT_MAX_CONCURRENCY ?? 4), "moonshot");

/**
 * Vertex-hosted Gemini — and the one that matters most, because the fleet is migrating here.
 *
 * The spec this file implements was written when classification ran on Kimi. It does not any
 * more: `dealDetector.classifyMessage` moved to `GEMINI.flash`, and that is the call made on
 * EVERY inbound message — so the per-message fan-out a Gmail push creates now lands mostly on
 * Gemini, not on the Kimi gate above. Gating Kimi alone would have bounded the shrinking half
 * of the problem and left the growing half open.
 *
 * A separate gate from Kimi's because they are separate Vertex quotas (Kimi is MaaS through
 * the openapi endpoint, Gemini is the native API), and back-pressuring one on the other's
 * saturation would be wrong.
 *
 * WIRED SO FAR: `dealDetector.classifyMessage` — the per-message call, the burst driver, and
 * the one where a 429 does real damage (exhausted retries return llm_error and the message is
 * skipped). Still UNGATED and worth doing next, roughly in order of how much they fan out:
 * `researchAthlete` (5 parallel grounded searches), `narrator` (3 models in parallel),
 * `researchBrand`, then the single-shot callers — `visionTag`, `brandImage`, `shotList`,
 * `contractExtract`, `voice/brandNarration`, `studio/adapters/vertex`.
 *
 * `mila/gemini.ts` is deliberately last and should be treated like `kimiStream`: it streams to
 * a person who is waiting, and a slot held for the length of an answer is a different problem
 * from a slot held for a classification.
 */
export const geminiGate = createGate(Number(process.env.GEMINI_MAX_CONCURRENCY ?? 8), "gemini");

/**
 * How many inbound messages are processed at once — a DIFFERENT resource from the three above.
 *
 * The model gates bound what `detectDeal` *asks a provider to do*. They do not bound how many
 * `detectDeal` calls are in flight, and an in-flight one costs more than its model call: it
 * holds database connections across several reads and writes, and it holds the message body in
 * memory. `Promise.allSettled(messages.map(detectDeal))` in the Gmail webhook and the Instagram
 * sync is unbounded, so a 200-message backfill starts 200 of those at once and they all queue
 * on the model gates while still holding everything else.
 *
 * The binding constraint here is Postgres, not provider quota. `server/db.ts` sizes the pool at
 * 20 connections in production, and Cloud Run runs up to 3 instances — so an unbounded burst
 * races the pool long before it races Vertex. Sized well below the pool on purpose: a webhook
 * must leave connections for everything else the process is serving.
 *
 * Shared by both entry points deliberately. Gmail and Instagram DMs land in the same tables
 * through the same function, so giving them separate budgets would just let them exhaust the
 * pool together.
 */
export const messageGate = createGate(Number(process.env.MESSAGE_MAX_CONCURRENCY ?? 5), "message");
