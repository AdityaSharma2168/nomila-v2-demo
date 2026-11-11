/**
 * rollReview — the keep rules for "Review my camera roll".
 *
 * This is the module that decides what a young athlete is SHOWN as "we'd keep these", pre-ticked,
 * about her own photos. Every rule here is a promise: that a photo of someone else won't be
 * suggested to her, that a burst of twelve identical frames arrives as one, that content the
 * moderation gate flagged never reaches the grid at all, and that a photo is never dropped merely
 * because a model guessed a sponsor wouldn't love it. Each of those is silent when it breaks — the
 * grid still looks like a grid — so each one is asserted here rather than eyeballed on a device.
 */
import {
  reviewCandidates, rankOf, cosine, centroid, rollReviewConfig,
  type ReviewCandidate, type RollReviewConfig,
} from "./rollReview";
import type { AssetTags } from "./visionTag";
import type { ModerationVerdict } from "./moderation";

const CFG: RollReviewConfig = { ...rollReviewConfig(), keepCap: 6, shotTypeShare: 0.5 };

function tags(over: Partial<AssetTags> = {}): AssetTags {
  return {
    athlete_present: true,
    athlete_prominence: 0.8,
    shot_type: "portrait",
    description: "athlete on the court",
    brands_visible: [],
    aesthetic_quality: 0.8,
    brand_safe: true,
    setting: "gym", attire: "kit", vibe: "focused",
    hero_suitability: 0.8,
    disposition: "as_is",
    edit_note: "",
    reason: "Sharp, well-lit, she's the subject.",
    ...over,
  };
}

function cand(itemId: string, over: Partial<AssetTags> = {}, extra: Partial<ReviewCandidate> = {}): ReviewCandidate {
  return { itemId, tags: tags(over), embedding: null, likeness: null, ...extra };
}

const ids = (list: { itemId: string }[]) => list.map((e) => e.itemId);
const dropCode = (out: ReturnType<typeof reviewCandidates>, id: string) =>
  out.drop.find((d) => d.itemId === id)?.code;

describe("keep rules", () => {
  it("keeps a clean photo of the athlete", () => {
    const out = reviewCandidates([cand("a")], CFG);
    expect(ids(out.keep)).toEqual(["a"]);
    expect(out.drop).toHaveLength(0);
  });

  it("drops a photo she is not in, and one where she is a speck in the frame", () => {
    const out = reviewCandidates([
      cand("absent", { athlete_present: false }),
      cand("tiny", { athlete_prominence: 0.1 }),
      cand("edge", { athlete_prominence: CFG.minProminence }),   // exactly at the bar → kept
    ], CFG);

    expect(ids(out.keep)).toEqual(["edge"]);
    expect(dropCode(out, "absent")).toBe("not_present");
    expect(dropCode(out, "tiny")).toBe("too_small");
  });

  it("honours the vision pass's disposition — reject is out, crop and enhance are in", () => {
    const out = reviewCandidates([
      cand("rejected", { disposition: "reject" }),
      cand("croppable", { disposition: "crop" }),
      cand("fixable", { disposition: "enhance" }),
    ], CFG);

    expect(ids(out.keep).sort()).toEqual(["croppable", "fixable"]);
    expect(dropCode(out, "rejected")).toBe("disposition");
  });

  it("drops photos below the quality bar", () => {
    const out = reviewCandidates([
      cand("soft", { aesthetic_quality: 0.2 }),
      cand("ok", { aesthetic_quality: CFG.minAesthetic }),
    ], CFG);

    expect(ids(out.keep)).toEqual(["ok"]);
    expect(dropCode(out, "soft")).toBe("quality");
  });

  it("drops a face that isn't hers when the likeness proxy is available", () => {
    const out = reviewCandidates([
      cand("friend", {}, { likeness: 0.2 }),
      cand("her", {}, { likeness: 0.9 }),
    ], CFG);

    expect(ids(out.keep)).toEqual(["her"]);
    expect(dropCode(out, "friend")).toBe("likeness");
  });

  it("SKIPS the likeness rule entirely when there is no centroid (likeness null)", () => {
    // Under `likenessMinRefs` reference assets the route passes likeness: null for every item. The
    // rule must then be absent, not defaulted to 0 — a defaulted 0 would drop her whole roll.
    const out = reviewCandidates([cand("a", {}, { likeness: null }), cand("b", {}, { likeness: null })], CFG);
    expect(ids(out.keep).sort()).toEqual(["a", "b"]);
    expect(out.drop).toHaveLength(0);
  });

  it("RECORDS brand_safe but never drops on it", () => {
    // Rule 5, and the reason this module does not call heroScore: heroScore zeroes a
    // not-brand-safe asset. Her photo with a logo in shot is hers; it gets a note, not a deletion.
    const out = reviewCandidates([cand("a", { brand_safe: false, brands_visible: ["Gatorade"] })], CFG);
    expect(ids(out.keep)).toEqual(["a"]);
    expect(out.keep[0].tags.brand_safe).toBe(false);
    expect(out.keep[0].tags.brands_visible).toEqual(["Gatorade"]);
  });

  it("does not score an item the vision pass failed on", () => {
    const out = reviewCandidates([{ itemId: "x", tags: null, embedding: null, likeness: null }], CFG);
    expect(out.keep).toHaveLength(0);
    expect(dropCode(out, "x")).toBe("unscored");
  });
});

describe("the content gate", () => {
  it("drops a SafeSearch-blocked photo before any other rule can save it", () => {
    const out = reviewCandidates([
      cand("blocked", {}, { moderation: { blocked: true, categories: ["adult"], scores: null } }),
    ], CFG);
    expect(out.keep).toHaveLength(0);
    expect(dropCode(out, "blocked")).toBe("content");
  });

  it("FAILS CLOSED when the gate could not run", () => {
    // A silent Vision outage must never pre-tick hundreds of photos nobody screened. (The ordinary
    // one-at-a-time upload path fails OPEN instead — the asymmetry is documented in moderation.ts.)
    const out = reviewCandidates([
      cand("unknown", {}, { moderation: { blocked: false, categories: [], scores: null, error: "deadline exceeded" } }),
    ], CFG);
    expect(out.keep).toHaveLength(0);
    expect(dropCode(out, "unknown")).toBe("moderation_unavailable");
  });

  it("lets a clean verdict through", () => {
    const clean: ModerationVerdict = {
      blocked: false, categories: [],
      scores: { adult: "VERY_UNLIKELY", violence: "UNLIKELY", racy: "UNLIKELY", medical: "VERY_UNLIKELY", spoof: "VERY_UNLIKELY" },
    };
    const out = reviewCandidates([cand("a", {}, { moderation: clean })], CFG);
    expect(ids(out.keep)).toEqual(["a"]);
  });

  it("drops on the vision pass's own content_flags — and is inert when the field is absent", () => {
    // `content_flags` is being added to tagAsset on a parallel branch; this rule must behave
    // identically before and after that merge.
    const flagged = { ...tags(), content_flags: { sexual: true } } as AssetTags;
    const notFlagged = { ...tags(), content_flags: { drugs_or_alcohol: true } } as AssetTags;
    const out = reviewCandidates([
      { itemId: "sexual", tags: flagged, embedding: null, likeness: null },
      { itemId: "beer", tags: notFlagged, embedding: null, likeness: null },   // a note, not a decision
      cand("plain"),                                                          // no content_flags at all
    ], CFG);

    expect(dropCode(out, "sexual")).toBe("content");
    expect(ids(out.keep).sort()).toEqual(["beer", "plain"]);
  });
});

describe("burst collapse", () => {
  it("keeps only the best frame of a near-duplicate burst", () => {
    const burst = [1, 1, 0, 0];                    // three frames pointing the same way
    const out = reviewCandidates([
      cand("mid",  { hero_suitability: 0.6 }, { embedding: [...burst] }),
      cand("best", { hero_suitability: 0.95 }, { embedding: [1, 1.01, 0, 0] }),
      cand("worst",{ hero_suitability: 0.55 }, { embedding: [1.01, 1, 0, 0] }),
      cand("other",{ hero_suitability: 0.9 },  { embedding: [0, 0, 1, 1] }),   // a different photo
    ], CFG);

    expect(ids(out.keep).sort()).toEqual(["best", "other"]);
    expect(dropCode(out, "mid")).toBe("duplicate");
    expect(dropCode(out, "worst")).toBe("duplicate");
  });

  it("cannot collapse items with no embedding — they all survive", () => {
    const out = reviewCandidates([cand("a"), cand("b"), cand("c")], CFG);
    expect(out.keep).toHaveLength(3);
  });
});

describe("cap and diversity", () => {
  it("caps the keepers and sends the overflow to `more`, best first", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      cand(`p${i}`, { hero_suitability: 1 - i * 0.05, shot_type: i % 2 ? "portrait" : "action" }));
    const out = reviewCandidates(many, CFG);

    expect(out.keep).toHaveLength(CFG.keepCap);
    expect(out.more).toHaveLength(4);
    expect(out.keep[0].rank).toBeGreaterThanOrEqual(out.keep[1].rank);
    expect(out.more[0].rank).toBeLessThanOrEqual(out.keep[out.keep.length - 1].rank);
  });

  it("won't let one shot_type take more than its share of the cap", () => {
    // Nine portraits and two action shots, cap 6, share 0.5 ⇒ at most 3 portraits, and the action
    // shots must still get in even though every portrait outranks them.
    const items = [
      ...Array.from({ length: 9 }, (_, i) => cand(`portrait${i}`, { hero_suitability: 0.99, shot_type: "portrait" })),
      ...Array.from({ length: 2 }, (_, i) => cand(`action${i}`, { hero_suitability: 0.4, aesthetic_quality: 0.6, shot_type: "action" })),
    ];
    const out = reviewCandidates(items, CFG);

    const portraits = out.keep.filter((k) => k.tags.shot_type === "portrait");
    expect(portraits).toHaveLength(3);
    expect(ids(out.keep).filter((i) => i.startsWith("action")).sort()).toEqual(["action0", "action1"]);
    // The crowded-out portraits are still above the bar — they belong in "More good ones", not drop.
    expect(out.more.length).toBe(6);
    expect(out.drop).toHaveLength(0);
  });
});

describe("rank", () => {
  it("weights hero suitability, then quality, then prominence", () => {
    expect(rankOf(tags({ hero_suitability: 1, aesthetic_quality: 1, athlete_prominence: 1 }))).toBeCloseTo(1);
    expect(rankOf(tags({ hero_suitability: 1, aesthetic_quality: 0, athlete_prominence: 0 }))).toBeCloseTo(0.45);
    expect(rankOf(tags({ hero_suitability: 0, aesthetic_quality: 1, athlete_prominence: 0 }))).toBeCloseTo(0.30);
    expect(rankOf(tags({ hero_suitability: 0, aesthetic_quality: 0, athlete_prominence: 1 }))).toBeCloseTo(0.25);
  });

  it("does NOT zero a not-brand-safe or text_graphic photo the way heroScore does", () => {
    expect(rankOf(tags({ brand_safe: false }))).toBeGreaterThan(0.5);
    expect(rankOf(tags({ shot_type: "text_graphic" }))).toBeGreaterThan(0.5);
  });

  it("survives garbage from the model", () => {
    expect(rankOf(tags({ hero_suitability: NaN as unknown as number, aesthetic_quality: 5, athlete_prominence: -3 })))
      .toBeCloseTo(0.30);   // NaN→0, 5→1, -3→0
  });
});

describe("vector helpers", () => {
  it("cosine is 1 for identical, 0 for orthogonal", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([], [])).toBe(0);
  });

  it("centroid averages, and refuses an empty set", () => {
    expect(centroid([[0, 2], [2, 0]])).toEqual([1, 1]);
    expect(centroid([])).toBeNull();
  });
});

describe("config", () => {
  it("reads the ROLL_REVIEW_* env overrides at call time", () => {
    const before = process.env.ROLL_REVIEW_KEEP_CAP;
    process.env.ROLL_REVIEW_KEEP_CAP = "7";
    try { expect(rollReviewConfig().keepCap).toBe(7); }
    finally { if (before === undefined) delete process.env.ROLL_REVIEW_KEEP_CAP; else process.env.ROLL_REVIEW_KEEP_CAP = before; }
  });

  it("falls back to the documented defaults when the env is unset or junk", () => {
    const before = process.env.ROLL_REVIEW_DUP_COSINE;
    process.env.ROLL_REVIEW_DUP_COSINE = "not-a-number";
    try { expect(rollReviewConfig().dupCosine).toBe(0.92); }
    finally { if (before === undefined) delete process.env.ROLL_REVIEW_DUP_COSINE; else process.env.ROLL_REVIEW_DUP_COSINE = before; }
  });
});
