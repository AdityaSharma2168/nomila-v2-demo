/**
 * agentLogic.test.ts — the Agent screen's rules: what it sends, and what it hands the Board.
 *
 * The mapping from a plan to Board rows is the money-bearing part: the kind a row travels as decides
 * the model (motion → person → Veo; b-roll → object → seedance), and it is the SAME rows the screen
 * prices and the Board seeds from.
 */
import type { AgentPlanItem } from "../../hooks/use-studio";
import {
  agentRequest,
  buildSeed,
  clipCapRefusal,
  editChip,
  MAX_PICKED,
  PAN_HOLD_SEC,
  MAX_PRODUCTS,
  picksLeftOut,
  provenanceWords,
  productsLeftOut,
  holdRefusal,
  seedRowsFrom,
  planSeedExtras,
  type AgentForm,
  reasonWords,
} from "./agentLogic";
import { boardRequests } from "./storyboardRun";
import {
  backToPlan,
  boardQuote,
  boardSignature,
  boardWorkSignature,
  normalizeBoard,
  setStillSec,
} from "./storyboardLogic";

const item = (over: Partial<AgentPlanItem> = {}): AgentPlanItem => ({
  kind: "i2v",
  beat: "open on her",
  direction: "she turns toward the camera",
  assetId: "a1",
  thumbUrl: "https://signed.example/a1.jpg",
  athletePresent: true,
  sound: false,
  brandFlag: null,
  swapped: null,
  uncast: null,
  ...over,
});

const form = (over: Partial<AgentForm> = {}): AgentForm => ({
  prompt: "something for the new season",
  objective: "grow-following",
  aesthetic: "",
  picked: [],
  products: [],
  ...over,
});

describe("seedRowsFrom — the one mapping from a plan to Board rows", () => {
  /**
   * ⚠️ MUTATION: map i2v to `hasPerson: false` — the Board's own default. This reds, and nothing else
   * does.
   *
   * The server cast this row BECAUSE its vision tag says she is in it. Arriving as "not known to
   * carry her" would re-open B-roll on a photograph of her — a refusal seedance gives 6 times of 6.
   */
  it("an identity shot arrives as slight movement, marked as her", () => {
    const [row] = seedRowsFrom([item({ kind: "i2v" })], "n1", 2);
    expect(row).toMatchObject({ kind: "motion", hasPerson: true });
  });

  /**
   * ⚠️ MUTATION: drop items with no photo from the seed again (`if (!item.assetId) return []`). The
   * b-roll item then never reaches the Board, and this reds.
   *
   * B-roll is made from words: the server casts no photo for it and it is NOT left out. It arrives as
   * the photo-less b-roll row the Board's "Add a shot without a photo" makes, its direction the row's
   * sentence. A product keeps HER photo — image-to-video, so her actual product appears.
   */
  it("b-roll arrives as a photo-less row made from its direction; a product as YOUR PRODUCT with her photo", () => {
    const rows = seedRowsFrom(
      [
        item({
          kind: "broll",
          assetId: null,
          thumbUrl: null,
          athletePresent: null,
          direction: "rain beading on an empty bench",
        }),
        item({ kind: "product", assetId: "a3", athletePresent: false }),
      ],
      "n1",
      2,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      assetId: null,
      thumbUrl: null,
      prompt: "rain beading on an empty bench",
      kind: "broll",
      hasPerson: false,
    });
    // Re-pinned 22 Sep 2026: its own kind on the Board, the same object request as before.
    expect(rows[1]).toMatchObject({
      assetId: "a3",
      kind: "product",
      hasPerson: false,
    });
    // …and the estimate the screen makes asks for it as text-to-video: no reference at all.
    expect(boardRequests(rows, "grow-following")[0].request.references).toEqual(
      [],
    );
  });

  it("a photo-less item that is not b-roll is never a row — only b-roll can be made from words", () => {
    const rows = seedRowsFrom(
      [
        item({
          kind: "i2v",
          assetId: null,
          thumbUrl: null,
          athletePresent: null,
        }),
      ],
      "n1",
      2,
    );
    expect(rows).toEqual([]);
  });

  /**
   * ⚠️ MUTATION: seed every product as b-roll, whatever the tagger said — the code before device
   * check finding 4. This reds, and nothing else does.
   *
   * Her hand round the bottle is her in the frame. As b-roll the clip goes to seedance, which refuses
   * real people 6 of 6 — a paid-for piece that can only fail.
   */
  /**
   * ⚠️ RC-C1b-19 — MUTATION: seed a product as `broll` again (the code before 22 Sep 2026). This
   * reds. Found on device: a product pick arrived as "B-roll" with its photo attached — after b-roll
   * became words, a contradiction on the row, and one that read as a planner bug.
   */
  it("a product photo WITH her in it arrives as slight movement, marked as her — an untagged one is your product", () => {
    const rows = seedRowsFrom(
      [
        item({ kind: "product", assetId: "a1", athletePresent: true }),
        item({ kind: "product", assetId: "a2", athletePresent: null }),
      ],
      "n1",
      2,
    );
    expect(rows.map((r) => [r.kind, r.hasPerson])).toEqual([
      ["motion", true],
      ["product", false],
    ]);
  });

  /**
   * ⚠️ MUTATION: drop sound from the seed. This reds, and nothing else does.
   *
   * The estimate she saw was priced from these rows. A seed that lost sound would put a different,
   * silent clip on the Board than the one the plan recommended — and a cheaper number than hers.
   */
  it("an item the planner gave sound arrives on the Board with sound on — the others as they always did", () => {
    const rows = seedRowsFrom(
      [item({ sound: true }), item({ assetId: "a2", sound: false })],
      "n1",
      2,
    );
    expect(rows[0].audio).toBe(true);
    expect(rows[1]).not.toHaveProperty("audio");
    // …and the estimate prices it: the request the screen quotes asks for sound.
    expect(boardRequests(rows, "grow-following")[0].request.audio).toBe(true);
  });

  it("an item nothing fit is not a row — the Board gets only what can be made", () => {
    const rows = seedRowsFrom(
      [
        item(),
        item({
          assetId: null,
          thumbUrl: null,
          uncast: "Couldn't find a photo for this.",
        }),
      ],
      "n1",
      2,
    );
    expect(rows).toHaveLength(1);
  });

  it("carries the item's direction as the row's sentence, and keys that are never the asset id", () => {
    const rows = seedRowsFrom(
      [item({ assetId: "a1" }), item({ assetId: "a1" })],
      "n1",
      2,
    );
    expect(rows[0].prompt).toBe("she turns toward the camera");
    expect(rows.map((r) => r.key)).toEqual(["agent:n1:0", "agent:n1:1"]);
  });

  it("the rows the screen prices travel as the model their kind means", () => {
    const rows = seedRowsFrom(
      [
        item({ kind: "i2v", assetId: "a1" }),
        item({ kind: "product", assetId: "a2", athletePresent: false }),
      ],
      "n1",
      2,
    );
    const asked = boardRequests(rows, "showcase-product");
    expect(asked.map((a) => a.request.references)).toEqual([
      [{ assetId: "a1", role: "person" }],
      [{ assetId: "a2", role: "object" }],
    ]);
    // The objective she chose travels on every request the estimate makes.
    expect(asked.every((a) => a.request.objective === "showcase-product")).toBe(
      true,
    );
  });
});

describe("agentRequest", () => {
  it("sends her words trimmed, and only the optional fields she set", () => {
    const out = agentRequest(form({ prompt: "  a recap  " }));
    expect(out).toEqual({
      body: { prompt: "a recap", objective: "grow-following" },
    });
  });

  it("sends her picks, her products in her order, and how it should feel when she gave them", () => {
    const out = agentRequest(
      form({
        aesthetic: " warm, slow ",
        picked: ["p1"],
        products: ["b2", "b1"],
      }),
    );
    expect(out).toEqual({
      body: {
        prompt: "something for the new season",
        objective: "grow-following",
        aesthetic: "warm, slow",
        assetIds: ["p1"],
        productAssetIds: ["b2", "b1"],
      },
    });
  });

  it("says what is missing rather than sending", () => {
    expect(agentRequest(form({ prompt: "   " }))).toEqual({
      gap: "Say what you want made.",
    });
    expect(
      "gap" in
        agentRequest(
          form({
            picked: Array.from({ length: MAX_PICKED + 1 }, (_, i) => `p${i}`),
          }),
        ),
    ).toBe(true);
    expect(
      agentRequest(
        form({
          products: Array.from({ length: MAX_PRODUCTS + 1 }, (_, i) => `b${i}`),
        }),
      ),
    ).toEqual({ gap: `Pick up to ${MAX_PRODUCTS} products.` });
  });
});

describe("picksLeftOut", () => {
  /**
   * ⚠️ MUTATION: never report a pick (always null). This reds, and nothing else does.
   *
   * Since finding 6 the planner names the photo each item is made from, and may not use every photo
   * she picked. One it left out is named — never lost between her pick and the Board.
   */
  it("names how many of her picks the plan left out, and says nothing when all are in", () => {
    const items = [item({ assetId: "p1" }), item({ assetId: "x9" })];
    expect(picksLeftOut(["p1"], items)).toBeNull();
    expect(picksLeftOut(["p1", "p2", "p3"], items)).toBe(
      "2 of the 3 photos or videos you picked aren't in this plan — the plan didn't find a place for them.",
    );
  });

  /**
   * ⚠️ MUTATION: ignore `withoutHer` (report every left-out pick with the old sentence). This reds.
   *
   * The soccer ball she picked is not overlooked — no shot can be made from a photo she is not in, now
   * that b-roll is made from words. The old sentence sent her looking for a reason that did not exist;
   * this one gives the true reason and the one thing she can do.
   */
  it("says WHY a pick without her was left out, and what to do — the rest keep the old sentence", () => {
    const items = [item({ assetId: "p1" })];
    expect(picksLeftOut(["p1", "ball"], items, ["ball"])).toBe(
      "1 of the photos you picked doesn't have you in it. B-roll is made from words now, so it can't be " +
        "a shot of its own — the plan may still borrow from it for a scene. To show it exactly as it is, " +
        "add it under Your products.",
    );
    const mixed = picksLeftOut(["p1", "ball", "bottle", "p9"], items, [
      "ball",
      "bottle",
    ]);
    expect(mixed).toMatch(
      /^2 of the photos you picked don't have you in them\./,
    );
    expect(mixed).toMatch(/add them under Your products\./);
    expect(mixed).toMatch(
      /1 of the 4 photos or videos you picked isn't in this plan — the plan didn't find a place for it\.$/,
    );
    // A pick without her that the plan DID use (an older plan, say) is not reported at all.
    expect(
      picksLeftOut(["ball"], [item({ assetId: "ball" })], ["ball"]),
    ).toBeNull();
  });
});

describe("productsLeftOut", () => {
  const product = (assetId: string | null) =>
    item({ kind: "product", assetId, athletePresent: false });

  it("says nothing when every product she picked is in the plan", () => {
    expect(
      productsLeftOut(["b1", "b2"], [product("b1"), product("b2")]),
    ).toBeNull();
    expect(productsLeftOut([], [item()])).toBeNull();
  });

  it("names how many the plan left out — never lets one vanish", () => {
    expect(productsLeftOut(["b1", "b2", "b3"], [product("b2")])).toBe(
      "2 of the 3 products you picked aren't in this plan.",
    );
    expect(productsLeftOut(["b1"], [item()])).toMatch(
      /doesn't show your product/,
    );
  });

  it("does not count a product photo cast as a scene as the product being shown", () => {
    // Only a product ITEM shows a product; the same photo turning up any other way is not it.
    expect(
      productsLeftOut(["b1"], [item({ kind: "broll", assetId: "b1" })]),
    ).toMatch(/doesn't show your product/);
  });
});

describe("clipCapRefusal", () => {
  /**
   * ⚠️ MUTATION: count the rows and forget the videos she added. This reds, and nothing else does.
   */
  it("counts her added videos against the stitch's limit, not just the planned shots", () => {
    expect(clipCapRefusal(6, 6, 12)).toBeNull();
    expect(clipCapRefusal(6, 7, 12)).toMatch(
      /up to 12 clips — this plan makes 13/,
    );
  });

  it("does not refuse on a limit it has not read yet", () => {
    expect(clipCapRefusal(6, 20, null)).toBeNull();
  });
});

describe("buildSeed", () => {
  it("hands the Board the objective with the rows, so it can quote under it", () => {
    const rows = seedRowsFrom([item()], "n1", 2);
    const seed = buildSeed("n1", "recap", rows, [
      { assetId: "v1", posterUrl: null, beats: 0, cut: false },
    ]);
    expect(seed).toEqual({
      nonce: "n1",
      objective: "recap",
      rows,
      passthrough: [{ assetId: "v1", posterUrl: null }],
      planId: null,
    });
  });

  it("carries the stored plan's id when the plan was saved (PR 6, 6a3)", () => {
    const rows = seedRowsFrom([item()], "n1", 2);
    expect(buildSeed("n1", "recap", rows, [], "plan-7").planId).toBe("plan-7");
  });
});

// ─── A held photo in the plan (C1b) ─────────────────────────────────────────────────────────────

describe("seedRowsFrom — an image item is a still row, at the server's default hold", () => {
  const image = (over: Partial<AgentPlanItem> = {}) =>
    item({
      kind: "image",
      beat: "the bottle, close",
      direction: "her bottle on the bench, as it is",
      assetId: "a5",
      thumbUrl: "https://signed.example/a5.jpg",
      athletePresent: false,
      sound: false,
      ...over,
    });

  /** ⚠️ MUTATION (PR 14, R-5): return the held row alone in `withDirection` — "direction dropped on an image row" reds by name. */
  it("keeps the planner's direction on a held photo and on her own clip — as data, never as a prompt or a request", () => {
    const rows = seedRowsFrom(
      [
        image(),
        item({
          kind: "clip",
          assetId: "c1",
          mediaType: "clip",
          direction: "  her best sprint, whole  ",
        }),
      ],
      "n1",
      2,
    );
    expect(rows.map((r) => [r.kind, r.prompt, r.direction])).toEqual([
      ["still", "", "her bottle on the bench, as it is"],
      ["clip", "", "her best sprint, whole"],
    ]);
    expect(boardRequests(rows, "grow-following")).toEqual([]);
    // A blank direction adds no key at all.
    expect(
      "direction" in seedRowsFrom([image({ direction: "  " })], "n1", 2)[0],
    ).toBe(false);
  });

  /**
   * ⚠️ RC-C1b-15 — MUTATION: map an image item to a shot (`motion`, or `broll`) like every other
   * photo item. This reds — and so would her money: a shot is a request, a quote and a spend, and a
   * held photo is none of those.
   */
  it("arrives as a still row — the photo, its hold, no line, no sound — and asks for nothing", () => {
    const rows = seedRowsFrom([item({ kind: "i2v" }), image()], "n1", 2);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      key: "agent:n1:1",
      assetId: "a5",
      thumbUrl: "https://signed.example/a5.jpg",
      prompt: "",
      kind: "still",
      hasPerson: false,
      stillSec: 2,
      // The planner's direction, as data — no request reads it (PR 14, R-5).
      direction: "her bottle on the bench, as it is",
    });
    // The estimate prices only the shot: one request, and the still is $0 · held.
    const reqs = boardRequests(rows, "grow-following");
    expect(reqs.map((r) => r.key)).toEqual(["agent:n1:0"]);
    const est = boardQuote(
      rows,
      [{ key: "agent:n1:0", ceilingUsd: 0.63, expectedUsd: 0.42 }],
      [],
      null,
    );
    expect(est.priced).toBe(true);
    expect(est.ceilingUsd).toBeCloseTo(0.63, 6);
    expect(est.perRow[1].held).toBe(2);
    // And it takes a slot against the clip cap like any row.
    expect(clipCapRefusal(rows.length, 0, 2)).toBeNull();
    expect(clipCapRefusal(rows.length, 1, 2)).toMatch(/up to 2 clips/);
  });

  /**
   * ⚠️ RC-C1b-16 — MUTATION: drop `holdRefusal`, or seed an image item with a hold of our own when
   * the options have not arrived. This reds.
   */
  it("with no hold known yet it is not a row, and the screen waits rather than inventing one", () => {
    const items = [item({ kind: "i2v" }), image()];
    expect(seedRowsFrom(items, "n1", null)).toHaveLength(1);
    expect(holdRefusal(items, null)).toMatch(/how long a photo can be held/);
    expect(holdRefusal(items, 2)).toBeNull();
    expect(holdRefusal([item({ kind: "i2v" })], null)).toBeNull();
    // A held photo the caster could not place is a line on the screen, not a row — like any item.
    expect(
      seedRowsFrom([image({ assetId: null, uncast: "left out" })], "n1", 2),
    ).toEqual([]);
  });

  /**
   * The seed handoff, with a still in it (the picker PR's flow, pinned against C1b): the seed is
   * applied whole, the hold rides it, and "Back to the plan" goes straight back until she changes a
   * hold — then it asks. The quote key never moves for a hold; the work key does (the ruling).
   *
   * ⚠️ MUTATION: measure `holdsWork` with `boardSignature` instead of `boardWorkSignature`. This reds.
   */
  it("the hold rides the seed, and changing it on the Board is work the back link asks about", () => {
    const rows = seedRowsFrom([item({ kind: "i2v" }), image()], "n1", 2);
    const seed = buildSeed("n1", "recap", rows, []);
    expect(seed.rows[1].stillSec).toBe(2);
    // What the Board does on apply: normalise, then stamp "as the plan left it".
    const onBoard = normalizeBoard(seed.rows);
    expect(onBoard).toEqual(seed.rows);
    const seededAs = boardWorkSignature(onBoard, seed.objective);
    const untouched = backToPlan({
      available: true,
      running: false,
      holdsWork: boardWorkSignature(onBoard, seed.objective) !== seededAs,
    });
    expect(untouched).toBe("go");
    const held = setStillSec(onBoard, 1, 5, { minStillSec: 1, maxStillSec: 8 });
    expect(boardSignature(held, seed.objective)).toBe(
      boardSignature(onBoard, seed.objective),
    );
    const after = backToPlan({
      available: true,
      running: false,
      holdsWork: boardWorkSignature(held, seed.objective) !== seededAs,
    });
    expect(after).toBe("confirm");
  });
});

// ─── One of her clips in the plan (C2 Half B) ──────────────────────────────────────────────────

describe("seedRowsFrom — a clip item is a clip row, cut to its beat, its own sound kept when planned", () => {
  const clipItem = (over: Partial<AgentPlanItem> = {}) =>
    item({
      kind: "clip",
      beat: "her sprint, real",
      direction: "she sprints down the track",
      assetId: "c9",
      thumbUrl: "https://signed.example/c9.jpg",
      athletePresent: true,
      sound: true,
      mediaType: "clip",
      trim: { startSec: 3, endSec: 6.5 },
      durationSeconds: 6.5,
      ...over,
    });

  /**
   * ⚠️ MUTATION: map a clip item to a shot (`motion`) like an i2v item. This reds — and so would her
   * money: a shot is a request, a quote and a spend; her own clip is none of those.
   */
  it("arrives as a clip row — the clip, its window, its length, its sound, no line — and asks for nothing", () => {
    const rows = seedRowsFrom([item({ kind: "i2v" }), clipItem()], "n1", null);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      key: "agent:n1:1",
      assetId: "c9",
      thumbUrl: "https://signed.example/c9.jpg",
      prompt: "",
      kind: "clip",
      hasPerson: false,
      clipTrim: { startSec: 3, endSec: 6.5 },
      clipSec: 6.5,
      audio: true,
      // The planner's direction, as data — no request reads it (PR 14, R-5).
      direction: "she sprints down the track",
    });
    // With the mp4 signed it rides the row, so the Board can play the window.
    expect(
      seedRowsFrom(
        [clipItem({ videoUrl: "https://signed.example/c9.mp4" })],
        "n1",
        null,
      )[0],
    ).toMatchObject({ videoUrl: "https://signed.example/c9.mp4" });
    expect(boardRequests(rows, "grow-following").map((r) => r.key)).toEqual([
      "agent:n1:0",
    ]);
    const est = boardQuote(
      rows,
      [{ key: "agent:n1:0", ceilingUsd: 0.63, expectedUsd: 0.42 }],
      [],
      null,
    );
    expect(est.priced).toBe(true);
    expect(est.perRow[1].own).toEqual({ seconds: 3.5 });
    // It needs no hold from the options: it seeds with them unread, unlike a held photo.
    expect(holdRefusal([clipItem()], null)).toBeNull();
    // Whole, silent, unmeasured: the absent keys stay absent.
    expect(
      seedRowsFrom(
        [clipItem({ trim: null, durationSeconds: null, sound: false })],
        "n1",
        null,
      )[0],
    ).toEqual({
      key: "agent:n1:0",
      assetId: "c9",
      thumbUrl: "https://signed.example/c9.jpg",
      prompt: "",
      kind: "clip",
      hasPerson: false,
      direction: "she sprints down the track",
    });
    // Left out is a line on the screen, not a row.
    expect(
      seedRowsFrom(
        [clipItem({ assetId: null, uncast: "left out" })],
        "n1",
        null,
      ),
    ).toEqual([]);
  });
});

describe("seedRowsFrom — the planner's slots ride the row, only where the row may carry them", () => {
  /**
   * ⚠️ MUTATION: seed `shot` unfiltered. This reds — a photo row would carry a framing the server
   * refuses at the preview (prompts.ts `slotRefusal`).
   */
  it("a photo row keeps movement only; a photo-less b-roll row keeps all four; a held row keeps none", () => {
    const shot = {
      framing: "wide" as const,
      movement: "push-in" as const,
      lighting: "golden-hour" as const,
    };
    const [photo] = seedRowsFrom([item({ kind: "i2v", shot })], "n1", null);
    expect(photo.shot).toEqual({ movement: "push-in" });
    const [words] = seedRowsFrom(
      [
        item({
          kind: "broll",
          assetId: null,
          thumbUrl: null,
          athletePresent: null,
          shot,
        }),
      ],
      "n1",
      null,
    );
    expect(words.shot).toEqual(shot);
    const [only] = seedRowsFrom(
      [item({ kind: "i2v", shot: { framing: "wide" } })],
      "n1",
      null,
    );
    expect("shot" in only).toBe(false);
    const [none] = seedRowsFrom([item({ kind: "i2v" })], "n1", null);
    expect("shot" in none).toBe(false);
  });
});

// ─── A picked video with beats is CUT into the plan, not appended (enrichment fixes, 22 Sep 2026) ─

/**
 * ⚠️ MUTATION, red here by name: treat every video as passthrough — make `cutVideos` return [] —
 * "a video with beats left on CUT travels in assetIds after her photos" and "only as-is videos are
 * the Board's passthrough" red together.
 */
describe("agentRequest / buildSeed — a picked video with beats is cut into the plan; as-is stays passthrough", () => {
  const base = {
    prompt: "a recap of this week's training",
    objective: "recap" as const,
    aesthetic: "",
    picked: ["p1", "p2"],
    products: [],
  };
  const withBeats = { assetId: "v1", posterUrl: null, beats: 6, cut: true };
  const asIs = { assetId: "v2", posterUrl: null, beats: 6, cut: false };
  const unread = { assetId: "v3", posterUrl: null, beats: 0, cut: true };

  it("a video with beats left on CUT travels in assetIds after her photos; as-is and unread videos do not", () => {
    const req = agentRequest({ ...base, videos: [withBeats, asIs, unread] });
    expect("body" in req && req.body.assetIds).toEqual(["p1", "p2", "v1"]);
    const none = agentRequest({ ...base, picked: [], videos: [asIs, unread] });
    expect("body" in none && none.body.assetIds).toBeUndefined();
  });

  it("the pick cap is shared between photos and videos to cut, and says so", () => {
    const many = Array.from({ length: MAX_PICKED }, (_, i) => `p${i}`);
    const req = agentRequest({ ...base, picked: many, videos: [withBeats] });
    expect("gap" in req && req.gap).toMatch(/photos and videos to cut/);
    expect(
      "body" in agentRequest({ ...base, picked: many, videos: [asIs] }),
    ).toBe(true);
  });

  it("only as-is videos are the Board's passthrough — a cut video is already in the rows as its beats; an unread video is always as-is", () => {
    const seed = buildSeed("n1", "recap", [], [withBeats, asIs, unread]);
    expect(seed.passthrough).toEqual([
      { assetId: "v2", posterUrl: null },
      { assetId: "v3", posterUrl: null },
    ]);
  });

  it("a cut video the plan did not use is named among what was picked — photos or videos", () => {
    expect(picksLeftOut(["p1", "v1"], [item({ assetId: "p1" })], [])).toMatch(
      /1 of the 2 photos or videos you picked isn't in this plan/,
    );
  });
});

describe("provenanceWords — the plan card says where a cast row came from", () => {
  it("her upload is FILMED BY YOU, a generated row is MADE HERE; nothing cast, or an older server, says nothing", () => {
    expect(provenanceWords(item({ assetId: "c9", provenance: "camera" }))).toBe(
      "FILMED BY YOU",
    );
    expect(
      provenanceWords(item({ assetId: "c9", provenance: "made-here" })),
    ).toBe("MADE HERE");
    expect(provenanceWords(item({ assetId: "c9", provenance: "synced" }))).toBe(
      "FROM YOUR ACCOUNTS",
    );
    expect(provenanceWords(item({ assetId: null, provenance: "camera" }))).toBe(
      "",
    );
    expect(provenanceWords(item({ assetId: "c9" }))).toBe("");
  });

  /** ⚠️ MUTATION: ignore `platform` — a reel she posted reads FROM YOUR ACCOUNTS and this reds by name. */
  it("a reel she posted says FROM YOUR INSTAGRAM; any other synced platform keeps FROM YOUR ACCOUNTS (PR 4 B2b)", () => {
    expect(
      provenanceWords(
        item({ assetId: "r1", provenance: "synced", platform: "instagram" }),
      ),
    ).toBe("FROM YOUR INSTAGRAM");
    expect(
      provenanceWords(
        item({ assetId: "r1", provenance: "synced", platform: "tiktok" }),
      ),
    ).toBe("FROM YOUR ACCOUNTS");
    // The platform names an account only on a synced row: her upload is hers, whatever it says.
    expect(
      provenanceWords(
        item({ assetId: "r1", provenance: "camera", platform: "instagram" }),
      ),
    ).toBe("FILMED BY YOU");
  });
});

describe("editChip — the AI-edit chip on a clip card is the tagger's stored note, and nothing else (C3, D1)", () => {
  /** ⚠️ MUTATION: return the note for any kind — "a photo item never carries one" reds by name. */
  it("a cast clip with a note shows it; an as-is clip, a photo, and a left-out clip show none", () => {
    expect(
      editChip(
        item({ kind: "clip", mediaType: "clip", editNote: " tighten to her " }),
      ),
    ).toBe("tighten to her");
    expect(
      editChip(item({ kind: "clip", mediaType: "clip", editNote: null })),
    ).toBeNull();
    expect(
      editChip(item({ kind: "clip", mediaType: "clip", editNote: "   " })),
    ).toBeNull();
    expect(editChip(item({ kind: "clip", mediaType: "clip" }))).toBeNull(); // an older server
    expect(editChip(item({ kind: "i2v", editNote: "tighten" }))).toBeNull(); // a photo item never carries one
    expect(
      editChip(
        item({
          kind: "clip",
          assetId: null,
          uncast: "Couldn't use that clip here.",
          editNote: "x",
        }),
      ),
    ).toBeNull();
  });
});

describe("seedRowsFrom — a pushed-in image is a still row with its motion, held longer (C3, D2)", () => {
  /** ⚠️ MUTATION: seed a pan image as a dead still — "a pan image seeds a still row with stillMotion" reds by name. */
  it("a pan image seeds a still row with stillMotion pan at PAN_HOLD_SEC; a plain image is the dead still it always was; neither is priced", () => {
    const pan = item({
      kind: "image",
      assetId: "a7",
      thumbUrl: null,
      athletePresent: false,
      motion: "dolly",
    });
    const plain = item({
      kind: "image",
      assetId: "a8",
      thumbUrl: null,
      athletePresent: false,
      motion: null,
    });
    const rows = seedRowsFrom([pan, plain], "n2", 2);
    expect(rows[0]).toEqual({
      key: "agent:n2:0",
      assetId: "a7",
      thumbUrl: null,
      prompt: "",
      kind: "still",
      hasPerson: false,
      stillSec: PAN_HOLD_SEC,
      stillMotion: "dolly",
      direction: "she turns toward the camera",
    });
    expect(rows[1]).toEqual({
      key: "agent:n2:1",
      assetId: "a8",
      thumbUrl: null,
      prompt: "",
      kind: "still",
      hasPerson: false,
      stillSec: 2,
      direction: "she turns toward the camera",
    });
    expect(boardRequests(rows, "grow-following")).toEqual([]);
    expect(PAN_HOLD_SEC).toBeGreaterThanOrEqual(1);
    expect(PAN_HOLD_SEC).toBeLessThanOrEqual(8);
  });
});

describe("seedRowsFrom — any of the four moves, and the point it heads for (PR 6, 6a2)", () => {
  it("a zoom seeds its motion and its focus; a focus beside a push-in is dropped, as the server would refuse it", () => {
    const zoom = item({
      kind: "image",
      assetId: "a9",
      thumbUrl: null,
      athletePresent: true,
      motion: "zoom",
      focus: { x: 0.4, y: 0.3 },
    });
    const dolly = item({
      kind: "image",
      assetId: "a10",
      thumbUrl: null,
      athletePresent: true,
      motion: "dolly",
      focus: { x: 0.4, y: 0.3 },
    });
    const [z, d] = seedRowsFrom([zoom, dolly], "n3", 2);
    expect(z).toMatchObject({
      kind: "still",
      stillSec: PAN_HOLD_SEC,
      stillMotion: "zoom",
      stillFocus: { x: 0.4, y: 0.3 },
    });
    expect(d).toMatchObject({ stillMotion: "dolly" });
    expect(d).not.toHaveProperty("stillFocus");
  });
});

describe("reasonWords — the plan card's why (PR 6, 6a2)", () => {
  it("says why it fits, what it is and what it beat — in her words; nothing when there is no reason", () => {
    expect(
      reasonWords({
        entry: "clip.camera",
        fits: "her own sprint covers it",
        over: "i2v",
      }),
    ).toBe(
      "her own sprint covers it — your camera clip, over your photo brought to life.",
    );
    expect(reasonWords({ entry: "image.held", fits: "", over: null })).toBe(
      "A held photo.",
    );
    // A line the model already ended with a stop gets one stop, not two (read live, 6a2).
    expect(
      reasonWords({
        entry: "clip.camera",
        fits: "A strong close.",
        over: null,
      }),
    ).toBe("A strong close — your camera clip.");
    expect(reasonWords(null)).toBeNull();
    expect(reasonWords(undefined)).toBeNull();
  });
});

// ─── THE COMPOSER (PR 15, R-2 / D-2) ────────────────────────────────────────────────────────────

describe("seedRowsFrom with the composer — a dropped slot is named, never silent", () => {
  const shot = {
    framing: "low-angle" as const,
    movement: "crane" as const,
    lighting: "neon" as const,
    composition: "centered" as const,
    motion: "running" as const,
  };

  /** ⚠️ MUTATION: skip the dropped list in `withPlannedShot` — this reds by name. */
  it("a photo row silently drops framing — never: the photo row keeps movement and names the other four with their reasons", () => {
    const [photo] = seedRowsFrom(
      [item({ kind: "i2v", shot })],
      "n1",
      null,
      true,
    );
    expect(photo.shot).toEqual({ movement: "crane" });
    expect(photo.droppedSlots).toEqual([
      { slot: "framing", value: "low-angle", reason: "photo-decides" },
      { slot: "lighting", value: "neon", reason: "photo-decides" },
      { slot: "composition", value: "centered", reason: "photo-decides" },
      { slot: "motion", value: "running", reason: "in-her-sentence" },
    ]);
  });

  it("a photo-less b-roll row keeps all six and drops nothing", () => {
    const [words] = seedRowsFrom(
      [
        item({
          kind: "broll",
          assetId: null,
          thumbUrl: null,
          athletePresent: null,
          shot,
        }),
      ],
      "n1",
      null,
      true,
    );
    expect(words.shot).toEqual(shot);
    expect("droppedSlots" in words).toBe(false);
  });

  /**
   * ─── A HELD ROW GOES THROUGH THE SAME PATH (PR 15.1, R-3) ────────────────────────────────────
   *
   * `rowsOf` returned held photos and her own clips without `withPlannedShot`, so the cast item's
   * `shot` vanished there with no record and `nothing-filmed` could never be produced. A held row
   * still carries no slot and asks for nothing — that is correct and stays — but every drop is named.
   *
   * ⚠️ MUTATION: return the held rows without `withPlannedShot` (PR 15's code) — this reds by name.
   */
  it("a held row drops a capability with no reason — never: a held photo and her own clip name every slot as nothing-filmed", () => {
    // In canonical slot order, so the dropped list reads in that order too.
    const six = {
      framing: shot.framing,
      movement: shot.movement,
      lighting: shot.lighting,
      environment: "gym" as const,
      composition: shot.composition,
      motion: shot.motion,
    };
    const rows = seedRowsFrom(
      [
        item({
          kind: "image",
          assetId: "p5",
          athletePresent: false,
          shot: six,
        }),
        item({
          kind: "clip",
          assetId: "c9",
          mediaType: "clip",
          trim: { startSec: 1, endSec: 3 },
          durationSeconds: 6,
          shot: six,
        }),
      ],
      "n1",
      2,
      true,
    );
    expect(rows.map((r) => r.kind)).toEqual(["still", "clip"]);
    for (const r of rows) {
      expect(r).not.toHaveProperty("shot");
      expect(r.droppedSlots).toEqual(
        (
          [
            "framing",
            "movement",
            "lighting",
            "environment",
            "composition",
            "motion",
          ] as const
        ).map((slot) => ({ slot, value: six[slot], reason: "nothing-filmed" })),
      );
    }
    // A held row still asks for nothing.
    expect(boardRequests(rows, "grow-following", null, true)).toEqual([]);
    // And with the composer off, a held row is byte-identical to the one PR 15 seeded.
    const off = seedRowsFrom(
      [
        item({
          kind: "image",
          assetId: "p5",
          athletePresent: false,
          shot: six,
        }),
      ],
      "n1",
      2,
    );
    expect(off).toEqual(
      seedRowsFrom(
        [item({ kind: "image", assetId: "p5", athletePresent: false })],
        "n1",
        2,
      ),
    );
  });

  it("with the composer off nothing is named — the row is exactly as before", () => {
    const [photo] = seedRowsFrom([item({ kind: "i2v", shot })], "n1", null);
    expect("droppedSlots" in photo).toBe(false);
    // The Board filters by slot NAME — movement is a photo row's — and the value is the server's to
    // refuse; with the flag off the server never writes "crane" here (its legacy tables have no slot
    // for it), so this row is what a newer server would give an older client.
    expect(photo.shot).toEqual({ movement: "crane" });
  });
});

describe("planSeedExtras with the composer — the brief's reading rhythm rides the seed", () => {
  const answer = { look: null, music: null };
  const brief = {
    references: [
      {
        ref: "ref_1",
        role: "mood",
        intent: {
          editing_rhythm: {
            summary: "Quick cuts, punchy, on the beat.",
            tags: [],
            basis: "observed",
          },
        },
      },
    ],
  };

  it("carries the rhythm when the campaign names a pace, and nothing when it does not or when off", () => {
    expect(planSeedExtras(answer, false, brief)).toEqual({
      rhythm: { pace: "fast", matched: "quick cuts", ref: "ref_1" },
    });
    expect(planSeedExtras(answer, false, { references: [] })).toEqual({});
    expect(planSeedExtras(answer, false, null)).toEqual({});
    expect(planSeedExtras(answer, false)).toEqual({});
  });
});
