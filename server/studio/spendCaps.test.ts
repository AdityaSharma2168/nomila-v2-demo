/**
 * spendCaps.test.ts — THE REFUSALS, and specifically the video ones nothing else can reach.
 *
 * ─── WHY THIS SUITE HAD TO EXIST ────────────────────────────────────────────────────────────────
 *
 * `routes/studio.generate.test.ts` already drives the money gate through the real door, and it is
 * the stronger test of the two for images. It could not test video at all: `assertRunnableInline`
 * threw for `video.generate` before the gate was consulted, so every video quote died upstream of
 * the thing under test. That left three caps that had never once been shown refusing a clip.
 *
 * So this suite calls the gate directly, with real quotes for the real video models, and asserts
 * the refusal TEXT — not merely that something threw. A guard that cannot be shown to refuse is not
 * a guard, and a refusal whose message omits the number you hit is a guard you cannot act on.
 *
 * THAT HOLD IS NOW GONE (video V3): a clip is queued for the detached runner rather than refused,
 * so this gate is on the real video path and these refusals are live rather than anticipatory. The
 * bet this suite was written on — land the caps first, so they are load-bearing the moment the hold
 * goes — is the one that paid: the hold was deleted and nothing here needed to change.
 *
 * ─── THE QUOTES ARE REAL ────────────────────────────────────────────────────────────────────────
 *
 * Every figure below comes from the live `estimate()` against the real price table, never a
 * hand-written number. That is deliberate: the failure this gate exists for is a quote that is
 * wrong, and a test that invents its own quote cannot see a price table move underneath it.
 */
jest.mock("../db", () => ({
  db: {},
  pool: { end: async () => {}, on: () => {} },
}));

import {
  assertPlanWithinCaps,
  assertSpendWithinCaps,
  DAY_CEILING_ENV,
  type PlanCaps,
  type SpendCaps,
  type SpendQuote,
} from "./spendCaps";
import { estimate } from "./router";
import {
  maxClipSeconds,
  maxDayUsd,
  maxJobUsd,
  supportedDurationsFor,
  HARD_MAX_CLIP_SECONDS,
  routeFor,
} from "./config";
import { GenerationError } from "./types";
import type { GenerationInputs } from "./types";

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const PROMPT: GenerationInputs = {
  prompt: "her, mid-stride, hard evening light",
};

/**
 * A real quote for a clip of `secs` seconds on whatever `video.generate` routes to today.
 *
 * ⚠️  THE AUDIO ARM IS ON UNLESS SOMETHING SAYS OTHERWISE. `pricing.wantsAudio` tests
 * `generateAudio !== false`, so an absent parameter buys the EXPENSIVE $0.40/s SKU — deliberately,
 * because over-quoting is the safe direction. Callers below therefore state the arm they mean:
 * `silentClip()` mirrors what studio/preview.ts actually sends (`generateAudio: false`), and the
 * worst-case cases pass `true` explicitly. Neither figure is left to a default nobody looked at.
 */
function videoQuote(
  secs: number,
  opts: Parameters<typeof estimate>[2] = {},
): SpendQuote {
  const plan = estimate(
    "video.generate",
    { ...PROMPT, durationSeconds: secs },
    opts,
  );
  return {
    task: "video.generate",
    model: plan.model,
    unpriced: plan.cost.unpriced === true,
    amountUsd: plan.cost.amountUsd,
  };
}

/** The clip the product actually orders: silent, on the $0.20/s arm preview.ts pins. */
const silentClip = (secs: number) =>
  videoQuote(secs, {
    providerParams: { parameters: { generateAudio: false } },
  });

/** Caps generous enough that only the one under test can fire. */
const openCaps = (over: Partial<SpendCaps> = {}): SpendCaps => ({
  approvedCostUsd: 1_000,
  maxJobUsd: 1_000,
  maxDayUsd: 1_000,
  spentTodayUsd: 0,
  ...over,
});

/** The message off a refusal, or a failure if it did not refuse at all. */
function refusalFrom(quote: SpendQuote, caps: SpendCaps): string {
  try {
    assertSpendWithinCaps(quote, caps);
  } catch (err) {
    expect(err).toBeInstanceOf(GenerationError);
    expect((err as GenerationError).code).toBe("invalid_input");
    return (err as GenerationError).message;
  }
  throw new Error("expected a refusal, and the gate allowed the job");
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("the numbers this PR pinned", () => {
  it("caps a clip at 8 seconds, because that is what Veo actually serves", () => {
    expect(routeFor("video.generate").model).toBe("veo-3.1-generate-001");
    expect(supportedDurationsFor("veo-3.1-generate-001")).toEqual([4, 6, 8]);
    expect(maxClipSeconds()).toBe(8);
  });

  it("keeps 60 as an absolute clamp no override can walk past", () => {
    expect(HARD_MAX_CLIP_SECONDS).toBe(60);
    // A model whose list says 30s is still clamped. This is the guard on the guard: every input to
    // maxClipSeconds() is an env var, so a typo must not be able to buy the $24.00 clip.
    process.env.STUDIO_VIDEO_DURATIONS_JSON = JSON.stringify({
      "veo-3.1-generate-001": [30, 90],
    });
    expect(maxClipSeconds()).toBe(HARD_MAX_CLIP_SECONDS);
  });

  it("puts the worst clip anyone can now request at $3.20, not $24.00", () => {
    // The with-audio SKU, which is the expensive arm, at the new 8s ceiling.
    const worst = videoQuote(maxClipSeconds(), {
      providerParams: { parameters: { generateAudio: true } },
    });
    expect(worst.amountUsd).toBeCloseTo(3.2, 5);

    // What the old MAX_CLIP_SECONDS = 60 would have quoted, and what the old placeholder cap of 30
    // would have let through. This is the hole, priced.
    const old = videoQuote(60, {
      providerParams: { parameters: { generateAudio: true } },
    });
    expect(old.amountUsd).toBeCloseTo(24.0, 5);
    expect(old.amountUsd!).toBeLessThan(30); // ...which is why the placeholder never fired.
  });

  it("sets the per-job cap to $10 and the daily ceiling to $25 by default", () => {
    delete process.env.STUDIO_MAX_JOB_USD;
    delete process.env.STUDIO_MAX_DAY_USD;
    expect(maxJobUsd()).toBe(10);
    expect(maxDayUsd()).toBe(25);
  });
});

describe("an unpriced model is REFUSED — never free, never zero", () => {
  /**
   * The live shape of the hazard. Seedance is registered, routable and has a price ENTRY, but its
   * tokens-per-second is not published, so pricing.ts returns `unpriced` — carrying `amountUsd: 0`,
   * because a CostEstimate must have a number. Read that number alone and Seedance is free.
   */
  it("refuses Seedance, which is unpriced today and quotes $0 while saying so", () => {
    const quote = videoQuote(8, { model: "bytedance/seedance-2.0" });
    expect(quote.unpriced).toBe(true);
    expect(quote.amountUsd).toBe(0); // ← the trap, asserted so nobody "fixes" it into meaning free

    expect(refusalFrom(quote, openCaps())).toMatch(
      /no price is configured for bytedance\/seedance-2\.0/,
    );
  });

  it("refuses an ABSENT price too — a null amount is not a zero one", () => {
    const quote: SpendQuote = {
      task: "video.generate",
      model: "brand/new-unpriced-video-model",
      unpriced: false, // not even flagged — there is simply no figure
      amountUsd: null,
    };
    expect(refusalFrom(quote, openCaps())).toMatch(
      /must never spend as if it were \$0/,
    );
  });

  it("refuses a model with no entry in the price table at all", () => {
    const quote = videoQuote(8, { model: "brand/never-heard-of-it" });
    expect(quote.unpriced).toBe(true);
    expect(refusalFrom(quote, openCaps())).toMatch(/no price is configured/);
  });

  /**
   * THE ORDERING CASE — and it took a revert check to get it honest.
   *
   * The first version of this set every cap to zero and asserted the unpriced message. It could not
   * fail: an unpriced quote carries `amountUsd: 0`, and `0 > 0` is false, so moving the unpriced
   * check to LAST still produced the unpriced message. A test that passes under the very mutation it
   * names is decoration.
   *
   * What actually pins the order is a quote that is unpriced AND carries a number over a cap. The
   * gate must still refuse for the PRICE, because "we could not compute this" is a different and
   * more serious answer than "this is too expensive" — the second implies we know what it costs.
   * Today pricing.ts always pairs `unpriced` with 0, so this is a contract on the gate rather than a
   * reachable state; the point is that it stays true if that ever stops being so.
   */
  it("refuses for being UNPRICED, not for being over a cap, when it is both", () => {
    const message = refusalFrom(
      {
        task: "video.generate",
        model: "bytedance/seedance-2.0",
        unpriced: true,
        amountUsd: 5,
      },
      openCaps({ approvedCostUsd: 1, maxJobUsd: 1, maxDayUsd: 1 }),
    );
    expect(message).toMatch(/no price is configured/);
    expect(message).not.toMatch(/per-job limit|daily ceiling|you approved/);
  });

  it("does not let an unpriced $0 slip past caps set as tight as they go", () => {
    // The companion fact, stated separately because it is the one that is actually reachable: an
    // unpriced estimate's $0 clears every numeric comparison, so the flag is the only thing
    // standing between Seedance and a free generation.
    const quote = videoQuote(8, { model: "bytedance/seedance-2.0" });
    expect(quote.amountUsd).toBe(0);
    expect(
      refusalFrom(
        quote,
        openCaps({ approvedCostUsd: 0, maxJobUsd: 0, maxDayUsd: 0 }),
      ),
    ).toMatch(/no price is configured/);
  });
});

describe("a job over the per-job cap is refused, with the quote AND the cap in the message", () => {
  it("names both figures", () => {
    const quote = videoQuote(8, {
      providerParams: { parameters: { generateAudio: true } },
    });
    expect(quote.amountUsd).toBeCloseTo(3.2, 5);

    const message = refusalFrom(quote, openCaps({ maxJobUsd: 1.5 }));
    expect(message).toContain("$3.20"); // the quote
    expect(message).toContain("$1.50"); // the cap it broke
    expect(message).toMatch(/per-job limit/);
  });

  it("binds UNDERNEATH her approval — an approval that says yes does not override it", () => {
    const quote = videoQuote(8, {
      providerParams: { parameters: { generateAudio: true } },
    });
    // She approved the full figure. The house cap is the thing that refuses.
    const message = refusalFrom(
      quote,
      openCaps({ approvedCostUsd: 3.2, maxJobUsd: 1.0 }),
    );
    expect(message).toMatch(/per-job limit/);
  });

  it("lets the same clip through once the cap is above it — the cap is what decided, not the clip", () => {
    const quote = videoQuote(8, {
      providerParams: { parameters: { generateAudio: true } },
    });
    expect(
      assertSpendWithinCaps(quote, openCaps({ maxJobUsd: 4 })),
    ).toBeCloseTo(3.2, 5);
  });

  it("at the default $10, refuses what the OLD 60s ceiling would have quoted", () => {
    delete process.env.STUDIO_MAX_JOB_USD;
    const old = videoQuote(60, {
      providerParams: { parameters: { generateAudio: true } },
    });
    const message = refusalFrom(
      old,
      openCaps({ approvedCostUsd: 24, maxJobUsd: maxJobUsd() }),
    );
    expect(message).toContain("$24.00");
    expect(message).toContain("$10.00");
  });
});

describe("the per-day ceiling refuses the Nth job", () => {
  /** A silent 8s clip on the no-audio SKU — what the preview actually orders. $1.60. */
  const clip = () => silentClip(8);

  it("quotes $1.60 for the clip these cases count in", () => {
    expect(clip().amountUsd).toBeCloseTo(1.6, 5);
  });

  it("allows the first fifteen and refuses the sixteenth against a $25 ceiling", () => {
    const caps = (spentTodayUsd: number) =>
      openCaps({ maxDayUsd: 25, spentTodayUsd });

    // 15 × $1.60 = $24.00, still under. The 16th would make $25.60.
    let spent = 0;
    for (let n = 1; n <= 15; n += 1) {
      spent += assertSpendWithinCaps(clip(), caps(spent));
    }
    expect(spent).toBeCloseTo(24.0, 5);

    const message = refusalFrom(clip(), caps(spent));
    expect(message).toMatch(/daily ceiling/);
    expect(message).toContain("$25.60"); // where the day would have landed
    expect(message).toContain("$25.00"); // the ceiling
    expect(message).toContain("$24.00"); // what was already spent
  });

  it("names the env var, so the person who hits it mid-probe has the knob", () => {
    const message = refusalFrom(
      clip(),
      openCaps({ maxDayUsd: 1, spentTodayUsd: 0 }),
    );
    expect(message).toContain(DAY_CEILING_ENV);
    expect(message).toMatch(/planned run/);
  });

  it("reads as a DAILY refusal, not as the per-job cap — they are different problems", () => {
    // Well under the per-job cap; it is the accumulated day that refuses.
    const message = refusalFrom(
      clip(),
      openCaps({ maxJobUsd: 10, maxDayUsd: 25, spentTodayUsd: 24.5 }),
    );
    expect(message).toMatch(/daily ceiling/);
    expect(message).not.toMatch(/per-job limit/);
  });

  it("counts the job being asked for, not only what is already spent", () => {
    // $24.50 spent is under $25. The refusal has to come from 24.50 + 1.60, or the ceiling is
    // always overshot by exactly one job.
    expect(() =>
      assertSpendWithinCaps(
        clip(),
        openCaps({ maxDayUsd: 25, spentTodayUsd: 24.5 }),
      ),
    ).toThrow(GenerationError);
  });

  it("allows a job that lands exactly ON the ceiling", () => {
    // Strictly greater-than refuses. A quote that fits precisely is not a runaway.
    expect(
      assertSpendWithinCaps(
        clip(),
        openCaps({ maxDayUsd: 25, spentTodayUsd: 23.4 }),
      ),
    ).toBeCloseTo(1.6, 5);
  });
});

describe("the gate still protects the athlete first", () => {
  it("refuses a quote that grew past what she approved, before any house cap is consulted", () => {
    const quote = silentClip(8);
    const message = refusalFrom(
      quote,
      openCaps({ approvedCostUsd: 0.5, maxJobUsd: 0.1 }),
    );
    // Her ceiling is the one that is named — it is checked first and it is the one she can act on.
    expect(message).toMatch(/you approved/);
    expect(message).not.toMatch(/per-job limit/);
  });

  it("returns the validated figure on the happy path, and it is the quote", () => {
    const quote = silentClip(4);
    expect(quote.amountUsd).toBeCloseTo(0.8, 5); // 4s × $0.20/s, no audio
    expect(assertSpendWithinCaps(quote, openCaps())).toBeCloseTo(0.8, 5);
  });

  it("leaves the image path exactly as it was — a normal generate still passes", () => {
    const plan = estimate("image.generate", PROMPT);
    const quote: SpendQuote = {
      task: "image.generate",
      model: plan.model,
      unpriced: plan.cost.unpriced === true,
      amountUsd: plan.cost.amountUsd,
    };
    delete process.env.STUDIO_MAX_JOB_USD;
    delete process.env.STUDIO_MAX_DAY_USD;
    expect(
      assertSpendWithinCaps(quote, {
        approvedCostUsd: quote.amountUsd!,
        maxJobUsd: maxJobUsd(),
        maxDayUsd: maxDayUsd(),
        spentTodayUsd: 0,
      }),
    ).toBe(quote.amountUsd);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ADMITTING A WHOLE PLAN
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Caps generous enough that only the one under test can fire. */
const openPlanCaps = (over: Partial<PlanCaps> = {}): PlanCaps => ({
  maxJobUsd: 1_000,
  maxDayUsd: 1_000,
  spentTodayUsd: 0,
  ...over,
});

/** The message off a plan refusal, or a failure if it admitted the plan. */
function planRefusalFrom(quotes: SpendQuote[], caps: PlanCaps): string {
  try {
    assertPlanWithinCaps(quotes, caps);
  } catch (err) {
    expect(err).toBeInstanceOf(GenerationError);
    expect((err as GenerationError).code).toBe("invalid_input");
    return (err as GenerationError).message;
  }
  throw new Error("expected a refusal, and the gate admitted the plan");
}

describe("THE CASE N SEPARATE GATES STRUCTURALLY CANNOT MAKE", () => {
  /**
   * ─── THIS IS THE WHOLE REASON THE FUNCTION EXISTS, SO IT IS TESTED TWICE OVER ────────────────
   *
   * Six clips, each $1.60 — every one of them comfortably under the $10 per-job cap, so the
   * existing gate has no objection to any of them taken alone. Against a day that already holds
   * $20.00 of a $25.00 ceiling, the plan costs $9.60 and cannot possibly fit.
   *
   * The first half of this describe block proves what happens WITHOUT plan admission, by running
   * the real per-job gate the way the storyboard's run loop does. It is not a hypothetical: three
   * clips get bought and the fourth refuses. That is the defect, priced.
   */
  const SIX = () => Array.from({ length: 6 }, () => silentClip(8));

  it("quotes $1.60 an item and $9.60 for the plan these cases count in", () => {
    const plan = SIX();
    expect(plan[0].amountUsd).toBeCloseTo(1.6, 5);
    expect(plan.reduce((n, q) => n + q.amountUsd!, 0)).toBeCloseTo(9.6, 5);
  });

  it("HALF-EXECUTES under the per-job gate alone: three bought, the fourth refused", () => {
    let spent = 20.0;
    const bought: number[] = [];
    let refusedAt = -1;

    SIX().forEach((quote, i) => {
      if (refusedAt !== -1) return; // the run loop would carry on; the arithmetic would not change
      try {
        spent += assertSpendWithinCaps(quote, {
          approvedCostUsd: quote.amountUsd!,
          maxJobUsd: 10,
          maxDayUsd: 25,
          spentTodayUsd: spent,
        });
        bought.push(i);
      } catch {
        refusedAt = i;
      }
    });

    // Money left for three of the six items she approved as one thing.
    expect(bought).toEqual([0, 1, 2]);
    expect(refusedAt).toBe(3);
    expect(spent).toBeCloseTo(24.8, 5);
  });

  it("admits NOTHING instead — the same six items, refused as a unit before any of them run", () => {
    const message = planRefusalFrom(
      SIX(),
      openPlanCaps({ maxJobUsd: 10, maxDayUsd: 25, spentTodayUsd: 20 }),
    );
    expect(message).toMatch(/daily ceiling/);
    expect(message).toContain("$9.60"); // what the plan costs together
    expect(message).toContain("$29.60"); // where the day would have landed
    expect(message).toContain("$25.00"); // the ceiling
    expect(message).toContain("$20.00"); // what was already spent
    expect(message).toMatch(/Nothing has been run/);
  });

  /**
   * ⚠️ THE MUTATION THIS SUITE IS WRITTEN AGAINST, NAMED SO IT CAN BE RUN.
   *
   * Replace `caps.spentTodayUsd + planTotal` with `caps.spentTodayUsd` in check 3 — that is, drop
   * the plan's own total from the comparison, which is precisely what calling the per-job gate N
   * times amounts to. Under that mutation `20 > 25` is false, the plan is admitted, and the test
   * above goes green while the defect it names is fully present.
   *
   * This case is what reds instead: the day is EMPTY, so `spentTodayUsd` alone is 0 under any
   * mutation and only the plan's own total can refuse it.
   *
   * ⚠️ AND IT IS NOT "SET EVERY CAP TO ZERO". That mutation is already documented one describe
   * block up as the one that proves nothing — it removes the discrimination rather than sharpening
   * it. Every cap here is a real figure and the plan is refused by arithmetic.
   */
  it("refuses a plan on its OWN total, with nothing spent today at all", () => {
    const message = planRefusalFrom(
      SIX(),
      openPlanCaps({ maxJobUsd: 10, maxDayUsd: 9, spentTodayUsd: 0 }),
    );
    expect(message).toMatch(/daily ceiling/);
    expect(message).toContain("$9.60");
    expect(message).toContain("$9.00");
    expect(message).toContain("$0.00"); // nothing spent, said plainly rather than omitted
  });

  it("admits the same plan once the ceiling is above it — the cap decided, not the plan", () => {
    expect(
      assertPlanWithinCaps(
        SIX(),
        openPlanCaps({ maxJobUsd: 10, maxDayUsd: 25, spentTodayUsd: 15 }),
      ),
    ).toBeCloseTo(9.6, 5);
  });

  it("admits a plan that lands exactly ON the ceiling", () => {
    // Strictly greater-than refuses, matching the single gate. 15.40 + 9.60 = 25.00 exactly.
    expect(
      assertPlanWithinCaps(
        SIX(),
        openPlanCaps({ maxJobUsd: 10, maxDayUsd: 25, spentTodayUsd: 15.4 }),
      ),
    ).toBeCloseTo(9.6, 5);
  });
});

describe("one bad item refuses the whole plan, and the message says which", () => {
  it("refuses an UNPRICED item, naming the model and the item's position", () => {
    const plan = [
      silentClip(8),
      videoQuote(8, { model: "bytedance/seedance-2.0" }),
      silentClip(8),
    ];
    expect(plan[1].unpriced).toBe(true);
    expect(plan[1].amountUsd).toBe(0); // ← contributes NOTHING to the sum. That is the trap.

    const message = planRefusalFrom(plan, openPlanCaps());
    expect(message).toMatch(
      /no price is configured for bytedance\/seedance-2\.0/,
    );
    expect(message).toContain("item 2 of 3");
  });

  /**
   * THE ORDERING CASE, and it is reachable rather than contractual.
   *
   * An unpriced item carries $0, so it adds nothing to the plan's total — which means a plan can be
   * over the daily ceiling on its OTHER items while also containing an unpriced one. The unpriced
   * refusal has to win: "we could not price part of this" is a different and more serious answer
   * than "this is too expensive", and the second implies we know what the whole thing costs.
   */
  it("refuses for being UNPRICED, not for the day ceiling, when it is both", () => {
    const message = planRefusalFrom(
      [silentClip(8), videoQuote(8, { model: "bytedance/seedance-2.0" })],
      openPlanCaps({ maxDayUsd: 1, spentTodayUsd: 0 }),
    );
    expect(message).toMatch(/no price is configured/);
    expect(message).not.toMatch(/daily ceiling|per-job limit/);
  });

  it("refuses ONE item over the per-job cap, ahead of the day ceiling", () => {
    // $3.20 — the with-audio 8s clip, the worst single item anyone can request.
    const loud = videoQuote(8, {
      providerParams: { parameters: { generateAudio: true } },
    });
    expect(loud.amountUsd).toBeCloseTo(3.2, 5);

    const message = planRefusalFrom(
      [silentClip(4), loud],
      // Over BOTH: the item breaks $1.50, and the plan's $4.00 breaks a $1.00 day.
      openPlanCaps({ maxJobUsd: 1.5, maxDayUsd: 1, spentTodayUsd: 0 }),
    );
    expect(message).toMatch(/per-job limit/);
    expect(message).not.toMatch(/daily ceiling/);
    expect(message).toContain("item 2 of 2");
    expect(message).toContain("$3.20"); // the item
    expect(message).toContain("$1.50"); // the cap it broke
  });

  it("names the env var on the day refusal, so the knob travels with the message", () => {
    const message = planRefusalFrom(
      [silentClip(8)],
      openPlanCaps({ maxDayUsd: 1, spentTodayUsd: 0 }),
    );
    expect(message).toContain(DAY_CEILING_ENV);
    expect(message).toMatch(/planned run/);
  });

  it("refuses an EMPTY plan rather than admitting it for $0.00", () => {
    // A sum of nothing is 0 and looks exactly like free — the trap `boardQuote.priced` exists for.
    expect(planRefusalFrom([], openPlanCaps())).toMatch(/nothing in this plan/);
  });

  it("admits a one-item plan, and returns that item's figure as the total", () => {
    expect(assertPlanWithinCaps([silentClip(4)], openPlanCaps())).toBeCloseTo(
      0.8,
      5,
    );
  });
});
