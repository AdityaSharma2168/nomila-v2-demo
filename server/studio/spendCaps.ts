/**
 * studio/spendCaps — the money gate, as one function that can be made to refuse.
 *
 * ─── WHY THIS IS A MODULE AND NOT FOUR `if`s IN runStudioGeneration ─────────────────────────────
 *
 * It was four `if`s in runStudioGeneration, and for the image path that was fine: every one of them
 * is reachable there and `routes/studio.generate.test.ts` drives all of them through the real door.
 *
 * For VIDEO it was not fine, and the reason was an ordering fact worth stating plainly:
 *
 *     generate.ts   assertRunnableInline(preview.plan.task)   ← threw for video.generate
 *     generate.ts   the money checks                          ← never reached for video
 *
 * The caps sat DOWNSTREAM of the hold on video. So while the hold was in place no test could show
 * them refusing a clip — the throw fired first and the gate was dead code for that task. A guard
 * whose refusal cannot be demonstrated is not a guard; it is a comment that happens to compile.
 * (The same lesson rc-e.sh taught: a test that cannot fail proves nothing.)
 *
 * Extracting the checks here changed nothing about when they run — runStudioGeneration calls this
 * at exactly the point it used to do the work inline — but it made them callable with a video
 * quote, which is what lets spendCaps.test.ts prove each refusal fires. The guards therefore held
 * INDEPENDENTLY of the hold above them.
 *
 * ── AND THAT IS NO LONGER HYPOTHETICAL ──────────────────────────────────────────────────────────
 *
 * `assertRunnableInline` is GONE (video V3): a clip is now queued for the detached runner instead of
 * refused, and every cap in this file is on its path for real. The order the extraction was betting
 * on held exactly as written — the hold was deleted and not one line here had to change. What this
 * file does NOT do is decide whether video runs at all; that is `studioEnabled` and the route.
 *
 * ─── NO CLOCK, NO DATABASE, NO LOGGER ──────────────────────────────────────────────────────────
 *
 * Everything the gate needs arrives as an argument, including the day's running total. That is what
 * makes "the ceiling refuses the Nth job" a deterministic unit test rather than a fixture that has
 * to insert rows and hope. The caller does the reading; this does the deciding.
 */
import { overCeiling } from "./previewStore";
import { GenerationError, MAX_PLAN_ITEMS } from "./types";
import type { GenerationTask } from "./types";

/**
 * The freshly derived quote, as the gate needs to see it.
 *
 * `amountUsd` is nullable ON PURPOSE. A preview with no cost object at all and a preview carrying
 * `unpriced: true` are different states in studio/preview.ts, and both have to mean REFUSE here.
 * Collapsing them to a number would require inventing one, and the number that would get invented
 * is zero — which is the whole failure this gate exists to make impossible.
 */
export interface SpendQuote {
  task: GenerationTask;
  /** The routed model, for the refusal message. Never used to decide anything. */
  model: string;
  /**
   * studio/pricing.ts's verdict that it could not compute a price.
   *
   * ⚠️  AN `unpriced` ESTIMATE CARRIES `amountUsd: 0` (pricing.ts:52-54). That is deliberate there —
   * a `CostEstimate` has to have a number — and it is precisely why this flag has to be checked
   * BEFORE the amount and can never be folded into it. Read the amount alone and an unpriced model
   * is a free one.
   */
  unpriced: boolean;
  amountUsd: number | null;
}

/**
 * The four limits, all resolved by the caller.
 *
 * `spentTodayUsd` is passed in rather than read here so the gate stays pure — see the header. The
 * caller gets it from studio/jobs.ts, scoped to the athlete.
 */
export interface SpendCaps {
  /** The figure she was shown and agreed to, read back off our own preview row. */
  approvedCostUsd: number;
  /** studio/config.ts maxJobUsd(). */
  maxJobUsd: number;
  /** studio/config.ts maxDayUsd(). */
  maxDayUsd: number;
  /** studio/jobs.ts spentTodayUsd(athleteId) — this athlete's rolling 24h total. */
  spentTodayUsd: number;
}

/**
 * The limits a WHOLE PLAN is admitted against, all resolved by the caller.
 *
 * ─── ⚠️  THERE IS NO `approvedCostUsd` HERE, AND ITS ABSENCE IS THE POINT ───────────────────────
 *
 * `SpendCaps` has one because `assertSpendWithinCaps` runs at SPEND time, against a figure a person
 * has already been shown and agreed to. This runs BEFORE approval — it is the check that decides
 * whether a plan may be put in front of her to approve at all. There is no approved figure yet, and
 * inventing one would be the forgery previewStore.ts's header describes.
 *
 * The two gates therefore stack rather than duplicate: this one asks "may this plan be offered as a
 * unit", and `assertSpendWithinCaps` still runs per item at spend time with the figure off that
 * item's own preview row. Neither replaces the other.
 */
/**
 * ONE ITEM OF A PLAN, as the admission gate needs to see it — which is strictly less than
 * `SpendQuote`.
 *
 * ⚠️ DELIBERATELY NARROWER, and `task` is the reason. Neither gate in this file has ever read it:
 * it rides on `SpendQuote` for the log line at the call site. Requiring it here would force the
 * plan route to produce a `GenerationTask` for a row that stores one inside an advisory jsonb
 * column — which is to say, to INVENT one when the read came back without it. A type that asks for
 * a field nobody reads is a type that teaches callers to make things up.
 *
 * `model` is nullable for the same honesty: it is used in one refusal message and nowhere else, and
 * a preview that never routed has no model to name. A `SpendQuote` satisfies this as it stands.
 */
export type PlanItemQuote = {
  /** Named in the unpriced refusal, and used to decide nothing. Null ⇒ nothing was routed. */
  model: string | null;
} & Pick<SpendQuote, "unpriced" | "amountUsd">;

export interface PlanCaps {
  /** studio/config.ts maxJobUsd(). Applied to EACH ITEM, never to the plan's total — see below. */
  maxJobUsd: number;
  /** studio/config.ts maxDayUsd(). */
  maxDayUsd: number;
  /** studio/jobs.ts spentTodayUsd(athleteId) — this athlete's rolling 24h total. */
  spentTodayUsd: number;
}

/**
 * The Agent planner's cap, re-exported so a reader of the money gate finds it without a second
 * import. It is DECLARED in studio/types.ts — that file imports nothing, and this one reaches the
 * database through previewStore — beside `MAX_ADMIT_PIECES`, with the note on why the two are
 * different bounds and must not be merged again.
 */
export { MAX_PLAN_ITEMS };

/** The env var the day ceiling reads, named in the refusal so the knob travels with the message. */
export const DAY_CEILING_ENV = "STUDIO_MAX_DAY_USD";

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Refuse, or return. Throws `GenerationError(..., "invalid_input")`, which routes/studio.ts maps to
 * a 409 carrying the message verbatim.
 *
 * ─── THE ORDER IS THE DESIGN ───────────────────────────────────────────────────────────────────
 *
 * Four checks, ordered by who each one protects, cheapest and most absolute first:
 *
 *   1. UNPRICED — protects against spending an unknown amount. There is no figure to compare to any
 *      ceiling, so no later check is meaningful. Must be first, and must not be reorderable: with
 *      `amountUsd: 0` underneath it, an unpriced model passes every numeric comparison below.
 *   2. HER APPROVAL — protects the athlete. The quote may not have grown past what she agreed to.
 *   3. THE PER-JOB CAP — protects the company from one runaway job, and binds even when her
 *      approval says otherwise, because the approval path itself is a thing that can have a bug.
 *   4. THE PER-DAY CEILING — protects the company from many cheap jobs, which is the runaway this
 *      project can actually produce. Last because it is the only one that needs a database read.
 *
 * Every refusal names both sides of its comparison. A cap in a log and not in the message is a cap
 * the person who hit it has to go and look up.
 *
 * Returns the figure it validated. That is not a convenience — it is the only number downstream is
 * entitled to treat as checked, and handing it back means the closing log line reports what the gate
 * approved rather than re-reading a nullable field the gate has already had opinions about.
 */
export function assertSpendWithinCaps(
  quote: SpendQuote,
  caps: SpendCaps,
): number {
  // 1. An unknown cost must never spend as if it were $0.
  if (quote.unpriced || quote.amountUsd === null) {
    throw new GenerationError(
      `Refusing to generate — no price is configured for ${quote.model}, so there is nothing to ` +
        "check the approved figure against. An unknown cost must never spend as if it were $0.",
      "invalid_input",
    );
  }

  const amount = quote.amountUsd;

  // 2. Her approval. The message is previewStore's, not a second copy of it — `overCeiling` is the
  //    one writer of "you approved $X", shared with the route's own pre-flight refusal.
  if (amount > caps.approvedCostUsd) {
    throw overCeiling(amount, caps.approvedCostUsd);
  }

  // 3. The house limit for ONE job, underneath her approval.
  if (Number.isFinite(caps.maxJobUsd) && amount > caps.maxJobUsd) {
    throw new GenerationError(
      `Refusing to generate — this quotes ${usd(amount)}, over the ${usd(caps.maxJobUsd)} per-job limit.`,
      "invalid_input",
    );
  }

  // 4. The house limit for the DAY. Named as a daily ceiling, with the knob, because the person who
  //    meets it mid-probe needs to know both that it is not the per-job cap and how to raise it.
  const dayTotal = caps.spentTodayUsd + amount;
  if (Number.isFinite(caps.maxDayUsd) && dayTotal > caps.maxDayUsd) {
    throw new GenerationError(
      `Refusing to generate — this quotes ${usd(amount)}, which would take today's total to ` +
        `${usd(dayTotal)}, over the ${usd(caps.maxDayUsd)} daily ceiling ` +
        `(${usd(caps.spentTodayUsd)} already spent in the last 24h). ` +
        `Raise ${DAY_CEILING_ENV} for a planned run, or wait for the window to roll.`,
      "invalid_input",
    );
  }

  return amount;
}

/**
 * ADMIT A WHOLE PLAN, OR REFUSE ALL OF IT. The gate above, asked once about N items at a time.
 *
 * ─── THE FAILURE THIS EXISTS FOR, AND WHY N CALLS TO THE GATE ABOVE CANNOT CATCH IT ────────────
 *
 * `assertSpendWithinCaps` is a gate on ONE job, and it is consulted at the moment that job spends.
 * Run a six-item plan through it and you get six independent decisions taken six times, in order,
 * with money leaving between each one. Every item can be under the per-job cap and the plan can
 * still walk through the daily ceiling partway down the list — and by then items one to three have
 * already been bought. She approved a plan; she got a third of one and a refusal.
 *
 * That is not hypothetical and it is not new to the Agent tab. It is what the storyboard DID until
 * it was wired here: `boardQuote` compared the board's total to `maxJobUsd` on the CLIENT, against a
 * placeholder constant, and never consulted the day ceiling at all; `runBoard` then looped the
 * pieces, catching per piece and CARRYING ON past a failure. A board that tripped the day ceiling
 * on its fourth clip still asked for its fifth and sixth. (It now admits the whole board first —
 * client/screens/studio/storyboardRun.ts `runBoardPieces`.)
 *
 * So the sum is taken ONCE, before anything is approved, and the answer is about the plan rather
 * than about any item in it.
 *
 * ─── ⚠️  IT IS ADMISSION, NOT A RESERVATION ────────────────────────────────────────────────────
 *
 * Nothing here holds the money it counted. Between this returning and the last item spending,
 * another tab, another device or the storyboard itself can put a job on the same athlete's day.
 * This NARROWS the window from "N spends wide" to "one decision wide"; it does not close it.
 * Closing it needs a reservation row — a write, and therefore a migration — which is deliberately
 * not here. A caller must not read a successful return as a guarantee that the plan will complete.
 *
 * ─── WHAT IS DELIBERATELY NOT CHECKED ──────────────────────────────────────────────────────────
 *
 * The plan's TOTAL against `maxJobUsd`. The storyboard applies that rule on the client, knowing it
 * is stricter than the server, because a board is one decision to her however many jobs it is
 * underneath (client/screens/studio/storyboardLogic.ts, `BoardLimits`). That is a product opinion
 * about what a person should be asked to agree to in one go, and it belongs in one place. Copying
 * it here would make two, and the first time they disagreed the surface would show one ceiling and
 * the server would enforce another.
 *
 * ─── THE ORDER IS THE DESIGN, FOR THE REASONS THE GATE ABOVE GIVES ─────────────────────────────
 *
 *   0. EMPTY — a plan with no items is not a plan. Refused before anything is summed, because the
 *      sum of nothing is 0 and $0.00 is indistinguishable from free.
 *   1. UNPRICED — any one item. Must be first among the numeric checks for exactly the reason it is
 *      first above: an unpriced estimate carries `amountUsd: 0` (pricing.ts), so it contributes
 *      nothing to the total and clears every comparison below it. One unknown price poisons the
 *      whole sum, so it refuses the whole plan.
 *   2. THE PER-ITEM CAP — one runaway item. Named separately from the day ceiling because it is a
 *      different problem with a different fix: remove THAT item, rather than shorten the plan.
 *   3. THE PER-DAY CEILING — the plan's total, against what is already spent.
 *
 * Every refusal names the ITEM BY POSITION, 1-based, in the order the caller passed them — which is
 * the order the plan is rendered in, so "item 3 of 6" is a thing she can point at. Never an id: a
 * preview uuid in a refusal is a string nobody can act on.
 *
 * Returns the admitted total. Same reasoning as the single gate returning its amount: it is the
 * only figure downstream is entitled to treat as checked.
 */
export function assertPlanWithinCaps(
  quotes: readonly PlanItemQuote[],
  caps: PlanCaps,
): number {
  const n = quotes.length;

  // 0. Nothing to admit.
  if (n === 0) {
    throw new GenerationError(
      "There is nothing in this plan to run.",
      "invalid_input",
    );
  }

  const at = (i: number) => `item ${i + 1} of ${n}`;

  // 1. One unknown price makes the total meaningless — see the ordering note above.
  const unpricedAt = quotes.findIndex(
    (q) => q.unpriced || q.amountUsd === null,
  );
  if (unpricedAt !== -1) {
    throw new GenerationError(
      `Refusing to run this plan — no price is configured for ` +
        `${quotes[unpricedAt].model ?? "that model"} (${at(unpricedAt)}), so there is nothing to ` +
        `check the plan's ` +
        "total against. An unknown cost must never spend as if it were $0.",
      "invalid_input",
    );
  }

  // 2. One item over the house limit for a single job, before the plan is judged as a whole.
  if (Number.isFinite(caps.maxJobUsd)) {
    const overAt = quotes.findIndex((q) => q.amountUsd! > caps.maxJobUsd);
    if (overAt !== -1) {
      throw new GenerationError(
        `Refusing to run this plan — ${at(overAt)} quotes ` +
          `${usd(quotes[overAt].amountUsd!)}, over the ${usd(caps.maxJobUsd)} per-job limit. ` +
          "Remove that item.",
        "invalid_input",
      );
    }
  }

  const planTotal = quotes.reduce((sum, q) => sum + q.amountUsd!, 0);

  // 3. The whole plan against the day. The check N separate calls structurally cannot make.
  const dayTotal = caps.spentTodayUsd + planTotal;
  if (Number.isFinite(caps.maxDayUsd) && dayTotal > caps.maxDayUsd) {
    throw new GenerationError(
      `Refusing to run this plan — ${n} item${n === 1 ? "" : "s"} quote ` +
        `${usd(planTotal)} together, which would take today's total to ${usd(dayTotal)}, over the ` +
        `${usd(caps.maxDayUsd)} daily ceiling (${usd(caps.spentTodayUsd)} already spent in the ` +
        `last 24h). Nothing has been run. Shorten the plan, raise ${DAY_CEILING_ENV} for a planned ` +
        "run, or wait for the window to roll.",
      "invalid_input",
    );
  }

  return planTotal;
}
