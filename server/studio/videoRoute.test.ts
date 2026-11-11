/**
 * videoRoute.test.ts — the per-shot video table, and the two things about it that cost money.
 *
 * The table itself is three entries and could be read off the source. What cannot be read off the
 * source, and is what this file is actually for:
 *
 *   1. adding it did not move `routes()`, so everything that existed before behaves identically;
 *   2. the size b-roll asks for is a size seedance-fast can be PRICED at — and 1080 is not, which
 *      is why 720 is forced rather than chosen.
 */
import {
  MODELS,
  priceFor,
  routes,
  videoOutputSizeFor,
  videoRouteFor,
  videoTierFor,
} from "./config";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("videoRouteFor", () => {
  /**
   * ⭐ The other half of revert check `three-way-routing-correct`. The first half — that
   * `shotTypeFor` answers identity/broll and never transition — is in video/shotType.test.ts.
   *
   * MUTATION: swap the identity and broll arms. Identity segments then route to seedance-2.0-fast,
   * which refuses real-person image-to-video 6 of 6 by stated BytePlus policy, and every clip of
   * the athlete becomes a job that fails at submission.
   */
  it("three-way-routing-correct: identity→Veo, b-roll→seedance-fast, transition→Kling", () => {
    // Vertex-native id, because the identity arm inherits routes()["video.generate"] and that route
    // already translates at the Vertex boundary. `google/veo-3.1` would mean the translation was
    // skipped and the submit would 404.
    expect(videoRouteFor("identity")).toEqual({
      provider: "vertex",
      model: "veo-3.1-generate-001",
    });
    expect(videoRouteFor("broll")).toEqual({
      provider: "openrouter",
      model: MODELS.seedanceFast,
    });
    expect(videoRouteFor("transition")).toEqual({
      provider: "openrouter",
      model: MODELS.kling,
    });
  });

  it("leaves routes()['video.generate'] exactly as it was — the additive property", () => {
    // A caller that knows nothing about shot types (the runner resuming an old row, a script, a
    // test written before any of this existed) must behave identically. If this reds, the new table
    // has reached into the old one.
    expect(routes()["video.generate"]).toEqual({
      provider: "vertex",
      model: "veo-3.1-generate-001",
    });
  });

  it("the identity arm IS the existing route, so the established env flip still works", () => {
    // Inherited rather than copied. A copy would mean STUDIO_VIDEO_PROVIDER moved the old route and
    // silently did not move the identity one, which is the failure mode of having two tables.
    process.env.STUDIO_VIDEO_PROVIDER = "openrouter";
    expect(videoRouteFor("identity")).toEqual({
      provider: "openrouter",
      model: MODELS.veo,
    });
    process.env.STUDIO_VIDEO_MODEL = "google/veo-9.9";
    expect(videoRouteFor("identity").model).toBe("google/veo-9.9");
  });

  it("b-roll and transition have their own knobs, read at call time", () => {
    process.env.STUDIO_VIDEO_BROLL_MODEL = "bytedance/seedance-9.9";
    expect(videoRouteFor("broll").model).toBe("bytedance/seedance-9.9");
    process.env.STUDIO_VIDEO_TRANSITION_PROVIDER = "vertex";
    expect(videoRouteFor("transition").provider).toBe("vertex");
  });
});

describe("videoOutputSizeFor", () => {
  it("gives b-roll 720 on the SHORT edge, whichever way up it is", () => {
    // 9:16 is what every video deliverable actually asks for today (compile/aspect.ts maps both
    // `clip` and `reel` to it), and the other two are here because the ratio is parsed rather than
    // looked up, so the table can change without this function needing to.
    expect(videoOutputSizeFor("broll", "9:16")).toEqual({
      width: 720,
      height: 1280,
    });
    expect(videoOutputSizeFor("broll", "16:9")).toEqual({
      width: 1280,
      height: 720,
    });
    expect(videoOutputSizeFor("broll", "1:1")).toEqual({
      width: 720,
      height: 720,
    });
    expect(videoOutputSizeFor("broll", "4:5")).toEqual({
      width: 720,
      height: 900,
    });
  });

  it("gives identity and transition NO pixels, which is an answer and not an omission", () => {
    // Veo and Kling both bill per_second, so pixels buy no accuracy in the quote — and Vertex's
    // video body sends aspectRatio and ignores width/height entirely, so carrying them would be
    // decoration a later reader could mistake for a request that was actually made.
    expect(videoOutputSizeFor("identity", "9:16")).toBeNull();
    expect(videoOutputSizeFor("transition", "9:16")).toBeNull();
  });

  it("fails CLOSED on a ratio it cannot parse", () => {
    // Null flows to `unpriced` and a refusal she can read, rather than to a guessed canvas that
    // quotes one resolution and buys another.
    for (const bad of [
      undefined,
      "",
      "portrait",
      "16x9",
      "0:16",
      "9:0",
      "9:16:1",
    ]) {
      expect(videoOutputSizeFor("broll", bad)).toBeNull();
    }
  });

  it("forces both edges EVEN, because yuv420p chroma siting needs it", () => {
    // 7:15 at a 721 short edge is the kind of thing that would otherwise produce an odd height and
    // surface as a deep encoder error rather than as a bad number.
    process.env.STUDIO_VIDEO_BROLL_SHORT_EDGE = "721";
    const size = videoOutputSizeFor("broll", "7:15")!;
    expect(size.width % 2).toBe(0);
    expect(size.height % 2).toBe(0);
  });
});

describe("the size b-roll asks for is a size it can be PRICED at", () => {
  /**
   * ⚠️ THIS IS WHY 720 AND NOT 1080, and it is a constraint rather than taste.
   *
   * seedance-2.0-fast's price table carries `sd` and `hd720` and nothing above, because the model
   * advertises supported_resolutions ["480p","720p"]. A 1080p request is unpriced — correctly,
   * since it is also unservable — and studio/spendCaps.ts REFUSES an unpriced quote. So asking for
   * 1080 would not produce an expensive b-roll segment; it would produce one that cannot be made.
   */
  it("720 lands in a band seedance-fast publishes a rate for", () => {
    const size = videoOutputSizeFor("broll", "9:16")!;
    expect(videoTierFor(size.width, size.height)).toBe("hd720");

    const price = priceFor(MODELS.seedanceFast);
    expect(price?.unit).toBe("per_video_token");
    if (price?.unit !== "per_video_token") throw new Error("unreachable");
    expect(price.usdPerTokenByTier.hd720).toBeGreaterThan(0);
  });

  it("1080 would NOT be — which is the whole reason the short edge is 720", () => {
    process.env.STUDIO_VIDEO_BROLL_SHORT_EDGE = "1080";
    const size = videoOutputSizeFor("broll", "9:16")!;
    expect(size).toEqual({ width: 1080, height: 1920 });
    expect(videoTierFor(size.width, size.height)).toBe("hd1080");

    const price = priceFor(MODELS.seedanceFast);
    if (price?.unit !== "per_video_token") throw new Error("unreachable");
    // No published rate for that band, and pricing.ts refuses to borrow a neighbour's.
    expect(price.usdPerTokenByTier.hd1080).toBeUndefined();
  });
});
