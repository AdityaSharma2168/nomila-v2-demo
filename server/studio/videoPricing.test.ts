/**
 * videoPricing.test.ts — the money-gate blocker, from both sides.
 *
 * ─── WHAT WAS ACTUALLY BROKEN ──────────────────────────────────────────────────────────────────
 *
 * `plannedInputs` set `aspectRatio` for a video brief and never set `width`/`height`. That was
 * invisible while every clip went to Veo, which bills `per_second`. The moment b-roll routes to
 * seedance — which bills `per_video_token`, and whose quote needs pixels for BOTH the token count
 * and the per-token rate — a b-roll segment becomes `unpriced`, and `studio/spendCaps.ts` REFUSES
 * an unpriced quote by design. Not an expensive segment: an impossible one.
 *
 * So this file asserts BOTH directions rather than only the fix. Without the refusal arm, "b-roll
 * quotes a number" is a claim about arithmetic; with it, it is a claim about a gate that would
 * otherwise have shut.
 */
// preview.ts -> brief.ts -> server/db, which wants a DATABASE_URL at import time. Nothing here
// touches the database; the same stub generate.test.ts uses.
jest.mock("../db", () => ({
  db: {},
  pool: { end: async () => {}, on: () => {} },
}));

import { priceFor, videoOutputSizeFor } from "./config";
import { estimateCost } from "./pricing";
import { plannedInputs, previewGeneration } from "./preview";
import { assertSpendWithinCaps } from "./spendCaps";
import type { CreativeBrief } from "./brief";
import type { GenerationInputs } from "./types";

function makeBrief(over: Partial<CreativeBrief["job"]> = {}): CreativeBrief {
  return {
    briefId: "brief-1",
    createdAt: "2026-09-19T00:00:00.000Z",
    job: {
      origin: "system",
      objective: "grow-following",
      deliverable: "clip",
      mode: "generate",
      source: null,
      direction: {
        set: "chosen",
        statement: "An empty stadium at dusk, floodlights on.",
        untrusted: false,
        featuredPieces: [],
      },
      ...over,
    },
    athlete: {
      athleteId: "athlete-1",
      identity: {
        name: "Test Spike Athlete",
        firstName: "Test",
        identityLine: "Soccer · Example · National Team",
        sport: "soccer",
        org: "Example",
        division: "D1",
        conference: "Example Conference",
        segment: "college",
        tier: "Established",
        marqueeTag: "National Team",
      },
      voice: {
        storyArc: "A defender who kept choosing the harder programme.",
        highlights: [],
      },
      audience: {
        descriptor: "women 18-24 · top market US",
        ageRange: "18-24",
        topCity: "Exampleton",
        topMarket: "US",
        share: 66,
      },
      aesthetic: { register: "Established · college · soccer", notes: [] },
      goal: "Grow her audience with something that reads as hers",
      commercialState: "undisclosed",
    },
    brand: null,
    gaps: [],
  } as unknown as CreativeBrief;
}

/** No references at all — "an empty stadium at dusk" has no photograph behind it. */
const brollBrief = (over: Partial<CreativeBrief["job"]> = {}) =>
  makeBrief(over);

/** Her likeness on the job, which is what makes a segment an identity shot. */
const identityBrief = (over: Partial<CreativeBrief["job"]> = {}) =>
  makeBrief({
    ...over,
    references: [
      {
        role: "person",
        ref: "athletes/a/uploads/her.jpg",
        mediaAssetId: "11111111-1111-4111-8111-111111111111",
        label: "me",
      },
    ],
  } as Partial<CreativeBrief["job"]>);

describe("a b-roll clip is routed, sized and priced", () => {
  it("plans seedance-fast at 720x1280, which is what makes it quotable", () => {
    const planned = plannedInputs(brollBrief());
    expect(planned.task).toBe("video.generate");
    expect(planned.shotType).toBe("broll");
    expect(planned.videoRoute).toEqual({
      provider: "openrouter",
      model: "bytedance/seedance-2.0-fast",
    });
    expect(planned.inputs.width).toBe(720);
    expect(planned.inputs.height).toBe(1280);
    expect(planned.inputs.aspectRatio).toBe("9:16");
  });

  /**
   * ⭐⭐ REVERT CHECK `broll-is-priceable` — the headline of Track B.
   *
   * MUTATION: drop `...(videoSize ?? {})` from the inputs built in `plannedInputs`. The quote
   * becomes `unpriced`, `assertSpendWithinCaps` throws, and the first half reds by name.
   *
   * BOTH ARMS ARE IN THIS TEST. The second half re-prices the SAME inputs with the pixels removed
   * and drives the real spend gate with the result — so the refusal being prevented is demonstrated
   * rather than described. Without it, the first half is a claim about arithmetic; with it, it is a
   * claim about a gate that would otherwise have shut on every b-roll clip ever made.
   */
  it("broll-is-priceable: it quotes a real figure, and would be REFUSED without the pixels", () => {
    const preview = previewGeneration(brollBrief());

    // ── THE FIX ──
    expect(preview.unpriced).toBe(false);
    expect(preview.cost).not.toBeNull();
    expect(preview.cost!.amountUsd).toBeGreaterThan(0);
    // And the gate lets it through at the figure it was quoted.
    expect(() =>
      assertSpendWithinCaps(
        {
          task: "video.generate",
          model: preview.plan!.model,
          unpriced: preview.unpriced,
          amountUsd: preview.cost!.amountUsd,
        },
        {
          approvedCostUsd: preview.cost!.amountUsd,
          maxJobUsd: 10,
          maxDayUsd: 100,
          spentTodayUsd: 0,
        },
      ),
    ).not.toThrow();

    // ── WHAT IT WOULD HAVE BEEN ──
    const {
      width: _w,
      height: _h,
      ...noPixels
    } = plannedInputs(brollBrief()).inputs as GenerationInputs;
    const blind = estimateCost(noPixels, "bytedance/seedance-2.0-fast");
    expect(blind.unpriced).toBe(true);
    expect(() =>
      assertSpendWithinCaps(
        {
          task: "video.generate",
          model: "bytedance/seedance-2.0-fast",
          unpriced: true,
          amountUsd: blind.amountUsd,
        },
        {
          approvedCostUsd: 1,
          maxJobUsd: 10,
          maxDayUsd: 100,
          spentTodayUsd: 0,
        },
      ),
    ).toThrow(/price/i);
  });

  it("the figure is the published arithmetic, and 6s reproduces a real invoice", () => {
    // frames = 24 x secs + 1 · tokens = ceil(w x h x frames / 1024) · usd = tokens x rate.
    // At 4s: 97 frames, 87,300 tokens, $0.3667.
    const four = previewGeneration(brollBrief());
    expect(four.cost!.amountUsd).toBeCloseTo(0.3667, 4);
    expect(four.cost!.detail).toContain("720x1280");
    expect(four.cost!.detail).toContain("hd720");

    // At 6s: 145 frames, 130,500 tokens, $0.5481 — which is what the bake-off was INVOICED for a
    // 6s seedance-2.0-fast clip. The arithmetic is checkable against a receipt, not only against
    // this repo's own code.
    const six = previewGeneration(brollBrief({ durationSeconds: 6 }));
    expect(six.cost!.amountUsd).toBeCloseTo(0.5481, 4);
  });

  /**
   * ⭐ REVERT CHECK `routing-and-price-agree`.
   *
   * MUTATION: set the inputs' pixels from something OTHER than `videoOutputSizeFor` — e.g. hardcode
   * 480x854 while the size function still says 720x1280. That is the silent under-quote: the wire
   * asks for one resolution and the quote was computed for another.
   *
   * ⚠️ WHY THIS CHECK EARNS ITS KEEP BESIDE `broll-is-priceable`, measured rather than argued:
   * under that mutation `broll-is-priceable` STILL PASSES (3 failed / 5 passed, and it is not one
   * of the three). The quote is still a number and the gate still lets it through — it is simply
   * the wrong number. A suite with only the priceable check would have called that green.
   */
  it("routing-and-price-agree: the tier that was quoted is the size that reaches the wire", () => {
    // studio/adapters/openrouter.ts sends `size: "${width}x${height}"` from these same two numbers,
    // so the resolution that picked the rate is the resolution the request buys.
    const planned = plannedInputs(brollBrief());
    const size = videoOutputSizeFor("broll", planned.inputs.aspectRatio)!;
    expect({
      width: planned.inputs.width,
      height: planned.inputs.height,
    }).toEqual(size);

    const price = priceFor("bytedance/seedance-2.0-fast");
    if (price?.unit !== "per_video_token") throw new Error("unreachable");
    expect(price.usdPerTokenByTier.hd720).toBe(0.0000042);
    expect(planned.inputs.aspectRatio).toBe("9:16");
  });
});

describe("an identity clip is untouched by any of this", () => {
  it("still routes to Veo, still bills per second, and still carries NO pixels", () => {
    const planned = plannedInputs(identityBrief());
    expect(planned.shotType).toBe("identity");
    expect(planned.videoRoute).toEqual({
      provider: "vertex",
      model: "veo-3.1-generate-001",
    });
    // The property that makes this commit additive: an identity clip's inputs are byte-identical
    // to what they were before shot routing existed. Veo bills per_second and the Vertex body
    // sends aspectRatio, so pixels here would be decoration.
    expect(planned.inputs.width).toBeUndefined();
    expect(planned.inputs.height).toBeUndefined();
  });

  it("quotes $0.80 for the 4s default — 4s x $0.20/s, the no-audio arm", () => {
    const preview = previewGeneration(identityBrief());
    expect(preview.unpriced).toBe(false);
    expect(preview.cost!.amountUsd).toBeCloseTo(0.8, 4);
    expect(preview.cost!.detail).toContain("no-audio");
  });
});

describe("the duration check follows the ROUTED model", () => {
  it("lets b-roll have a 5s clip, which Veo cannot serve and seedance can", () => {
    // Veo serves 4/6/8; seedance-fast serves 4..15. Checking a b-roll clip against Veo's list — as
    // this did before the model was threaded through — would refuse a segment the provider it is
    // actually going to would have served.
    const preview = previewGeneration(brollBrief({ durationSeconds: 5 }));
    expect(preview.blockers.map((b) => b.field)).not.toContain(
      "durationSeconds",
    );
    expect(preview.unpriced).toBe(false);
  });

  it("still refuses 5s on an identity clip, because Veo genuinely cannot serve it", () => {
    const preview = previewGeneration(identityBrief({ durationSeconds: 5 }));
    expect(preview.blockers.map((b) => b.field)).toContain("durationSeconds");
  });
});
