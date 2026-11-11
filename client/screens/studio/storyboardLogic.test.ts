/**
 * The board's rules and its arithmetic.
 *
 * Two things are pinned here and they are different in kind. The RULES decide what she is allowed to
 * build; the ARITHMETIC decides what she is told it costs. The second is the one to be careful with:
 * every figure in it is a promise about money, and the module deliberately owns no price table so
 * that the promise can only ever be the server's own.
 */
import {
  approvalBlock,
  boardSignature,
  seedDecision,
  STALE_QUOTE_NOTE,
  boardGaps,
  boardProgress,
  boardQuote,
  brollRefusal,
  productRefusal,
  kindAllowed,
  motionRefusal,
  MAX_ROWS,
  moveRow,
  removeRow,
  setBridge,
  bridgeable,
  setKind,
  setPrompt,
  SLOT_LABELS,
  droppedSlotReason,
  seededRhythm,
  shotSlotValues,
  rowSignature,
  setShotSlot,
  slotValueLabel,
  slotsAllowed,
  slotsNote,
  type BoardLimits,
  type RowQuote,
  type StoryboardRow,
  BACK_TO_PLAN_NOTE,
  backToPlan,
  boardWorkSignature,
  heldPhotoRow,
  isStillRow,
  normalizeBoard,
  setAudio,
  setStillSec,
  setStillMotion,
  setStillFocus,
  focusFromTap,
  stillRefusal,
  cutAllowed,
  setCut,
  heldClipRow,
  cutVideos,
  asIsVideos,
  isClipRow,
  isHeldRow,
  clearClipTrim,
  clipPlays,
  clipRefusal,
} from "./storyboardLogic";

const row = (over: Partial<StoryboardRow> = {}): StoryboardRow => ({
  key: "k1",
  assetId: "a1",
  thumbUrl: null,
  prompt: "She walks into the light.",
  kind: "motion",
  hasPerson: true,
  ...over,
});

const board = (): StoryboardRow[] => [
  row({ key: "k1" }),
  row({ key: "k2" }),
  row({ key: "k3" }),
];

const LIMITS: BoardLimits = { maxJobUsd: 10 };
const q = (
  key: string,
  ceiling: number,
  expected: number,
  unpriced?: boolean,
): RowQuote => ({
  key,
  ceilingUsd: ceiling,
  expectedUsd: expected,
  ...(unpriced ? { unpriced } : {}),
});

// ─── The guard ──────────────────────────────────────────────────────────────────────────────────

describe("the person / b-roll guard", () => {
  /**
   * ⚠️ RC-S1 — MUTATION: make `brollRefusal` return null for a person row. This reds.
   *
   * B-roll routes to seedance, which refuses real-person image-to-video 6 of 6 by stated BytePlus
   * policy. Offering it on a photograph of her is offering a refusal she waits for.
   */
  it("b-roll is refused on a row that carries her, with a reason", () => {
    const reason = brollRefusal(row({ hasPerson: true }));
    expect(reason).toBeTruthy();
    // Her words, about the SHOT. Never the model's name or the provider's policy code.
    expect(reason).toMatch(/nobody in it/i);
    expect(reason).not.toMatch(/seedance|byteplus|policy|refus/i);
    expect(kindAllowed(row({ hasPerson: true }), "broll")).toBe(false);
  });

  /**
   * RE-PINNED 22 Sep 2026 (found on device): this held "b-roll is fine on a still she is not in".
   * B-roll is made from words now, so on ANY photo row it is refused — and the object shot that
   * photo-bearing b-roll used to be is `product`, fine on a photo she is not in.
   *
   * ⚠️ RC-C1b-20 — MUTATION: let `brollRefusal` return null on a photo row without her. This reds.
   */
  it("b-roll is refused on any photo row — your product is the object shot, and motion is always fine", () => {
    expect(brollRefusal(row({ hasPerson: false }))).toMatch(/made from words/);
    expect(kindAllowed(row({ hasPerson: false }), "broll")).toBe(false);
    expect(productRefusal(row({ hasPerson: false }))).toBeNull();
    expect(kindAllowed(row({ hasPerson: false }), "product")).toBe(true);
    // A product is nobody-in-it, for seedance's reason — and needs its photo.
    expect(productRefusal(row({ hasPerson: true }))).toMatch(/has you in it/);
    expect(kindAllowed(row({ assetId: null }), "product")).toBe(false);
    // Motion has no guard at all: a scene with nobody in it can still be asked to move.
    expect(kindAllowed(row({ hasPerson: false }), "motion")).toBe(true);
    expect(kindAllowed(row({ hasPerson: true }), "motion")).toBe(true);
  });

  /**
   * ⚠️ RC-S2 — MUTATION: make `setKind` clamp to "motion" instead of returning the board unchanged.
   * This reds.
   *
   * A silent rewrite generates a different board from the one on her screen, at a different price,
   * and she has no way to know it happened.
   */
  it("refusing a kind leaves the row untouched — it never clamps", () => {
    const rows = [row({ key: "k1", hasPerson: true, kind: "motion" })];
    const after = setKind(rows, 0, "broll");
    expect(after).toBe(rows); // the same array, not a rewritten copy
    expect(after[0].kind).toBe("motion");
  });

  it("sets a kind that IS allowed", () => {
    const rows = [row({ hasPerson: false, kind: "motion" })];
    expect(setKind(rows, 0, "product")[0].kind).toBe("product");
  });
});

// ─── Rows ───────────────────────────────────────────────────────────────────────────────────────

describe("rows", () => {
  it("edits a prompt without touching its neighbours", () => {
    const after = setPrompt(board(), 1, "A ball rolls to a stop.");
    expect(after[1].prompt).toBe("A ball rolls to a stop.");
    expect(after[0].prompt).toBe(board()[0].prompt);
  });

  it("asks for a bridge, and withdraws it by removing the key", () => {
    const on = setBridge(board(), 1, true);
    expect(on[1].bridgeRequested).toBe(true);
    expect("bridgeRequested" in setBridge(on, 1, false)[1]).toBe(false);
  });

  it("row 0 can never hold a bridge — there is nothing before it", () => {
    expect(setBridge(board(), 0, true)[0].bridgeRequested).toBeUndefined();
  });

  /**
   * ⚠️ RC-S5 — MUTATION: stop `normalizeBoard` clearing a row-0 bridge. This reds.
   *
   * A bridge into the first clip is a bridge from nothing. The timeline has the same invariant for
   * the same reason (`stitchLogic.normalize`), and this module keeps the field name so the handoff
   * renames nothing.
   */
  it("a bridge dragged to the front is cleared", () => {
    const bridged = setBridge(board(), 2, true);
    const moved = moveRow(bridged, 2, 0);
    expect(moved[0].key).toBe("k3");
    expect(moved[0].bridgeRequested).toBeUndefined();
  });

  /**
   * ⚠️ RC-S6's sibling. A row can reach position 0 by being dragged there OR by the row above it
   * being deleted — the second path is the one a reorder-only guard misses.
   */
  it("deleting the first row clears the bridge the second one inherits", () => {
    const bridged = setBridge(board(), 1, true);
    const after = removeRow(bridged, 0);
    expect(after[0].key).toBe("k2");
    expect(after[0].bridgeRequested).toBeUndefined();
  });

  /**
   * ⚠️ THE BRIDGE WEDGE. MUTATION: let `setBridge` ask for a bridge whatever the photos (drop the
   * `bridgeable` check). This reds.
   *
   * A bridge is generated from the previous still to this one, so beside a photo-less row (t2v b-roll,
   * made from words) no bridge request is ever built and no quote ever arrives. The ask used to be
   * held anyway, and boardQuote counted it missing — "Still working out what this board costs",
   * forever, with the button dead and nothing saying why. Now the ask is refused, and the board prices.
   */
  it("a bridge is never asked for beside a photo-less row — the board stays priceable", () => {
    const words = row({
      key: "t",
      assetId: null,
      kind: "broll",
      hasPerson: false,
      prompt: "Rain beading on an empty bench.",
    });
    for (const rows of [
      [row({ key: "k1" }), words],
      [words, row({ key: "k2" })],
    ]) {
      const asked = setBridge(rows, 1, true);
      expect(asked[1].bridgeRequested).toBeUndefined();
      expect(bridgeable(rows, 1)).toBe(false);
      const quote = boardQuote(
        asked,
        rows.map((r) => q(r.key, 0.63, 0.42)),
        [],
        LIMITS,
      );
      expect(quote.priced).toBe(true);
      expect(quote.refusal).toBeNull();
    }
    // Between two photos it is still hers to ask for.
    expect(bridgeable(board(), 1)).toBe(true);
  });

  it("a reorder that puts a photo-less row before a bridged join clears the ask", () => {
    const words = row({
      key: "t",
      assetId: null,
      kind: "broll",
      hasPerson: false,
    });
    const bridged = setBridge(
      [row({ key: "k1" }), row({ key: "k2" }), words],
      1,
      true,
    );
    expect(bridged[1].bridgeRequested).toBe(true);
    const moved = moveRow(bridged, 2, 1);
    expect(moved.map((r) => r.key)).toEqual(["k1", "t", "k2"]);
    expect(moved[2].bridgeRequested).toBeUndefined();
  });

  it("a move that goes nowhere returns the same board", () => {
    const b = board();
    expect(moveRow(b, 1, 1)).toBe(b);
  });
});

// ─── Gaps ───────────────────────────────────────────────────────────────────────────────────────

describe("boardGaps", () => {
  it("an empty board asks for a photo", () => {
    expect(boardGaps([]).join(" ")).toMatch(/add a photo/i);
  });

  it("counts blank prompts, and says it in her words", () => {
    const rows = [
      row({ key: "k1", prompt: "" }),
      row({ key: "k2", prompt: "  " }),
      row({ key: "k3" }),
    ];
    expect(boardGaps(rows).join(" ")).toContain("2 shots still need a line");
    expect(boardGaps([row({ prompt: "" })]).join(" ")).toContain(
      "One shot still needs",
    );
  });

  it("refuses more than a board holds", () => {
    const many = Array.from({ length: MAX_ROWS + 1 }, (_, i) =>
      row({ key: `k${i}` }),
    );
    expect(boardGaps(many).join(" ")).toContain(`up to ${MAX_ROWS}`);
  });

  /**
   * A kind can become impossible AFTER it was set — she tags the still as herself later. Reported,
   * never silently rewritten, on the same argument as `setKind`.
   */
  /**
   * A kind can stop being possible AFTER it was set — she tags the still as herself, or removes the
   * photo from a row that was slight-movement. Reported, never silently rewritten, on the same
   * argument as `setKind`.
   *
   * The wording covers BOTH guards. It used to say "set to b-roll but have you in them", which was
   * the only way a kind could go wrong when b-roll was the only guarded one.
   */
  it("reports a row whose kind stopped being possible, whichever guard it broke", () => {
    const personOnBroll = [row({ kind: "broll", hasPerson: true })];
    expect(boardGaps(personOnBroll).join(" ")).toContain(
      "a kind that doesn't fit",
    );
    const motionWithNoPhoto = [
      row({ kind: "motion", assetId: null, hasPerson: false }),
    ];
    expect(boardGaps(motionWithNoPhoto).join(" ")).toContain(
      "a kind that doesn't fit",
    );
  });

  it("a finished board has no gaps", () => {
    expect(boardGaps(board())).toEqual([]);
  });
});

// ─── The money ──────────────────────────────────────────────────────────────────────────────────

describe("boardQuote", () => {
  const clips = () => [
    q("k1", 0.63, 0.42),
    q("k2", 0.63, 0.42),
    q("k3", 0.63, 0.42),
  ];

  /**
   * ⚠️ RC-S7 — MUTATION: report the ceiling as the expected invoice (or vice versa). This reds.
   *
   * The probes' posture, kept: the adapter quotes the audio arm so an unverified flag can never
   * under-quote. Showing only the ceiling reads as a price rise; showing only the expected figure is
   * a promise the quote does not make.
   */
  it("ceiling and expected are different numbers, and both are sums of what it was handed", () => {
    const out = boardQuote(board(), clips(), [], LIMITS);
    expect(out.ceilingUsd).toBeCloseTo(1.89, 5);
    expect(out.expectedUsd).toBeCloseTo(1.26, 5);
    expect(out.ceilingUsd).toBeGreaterThan(out.expectedUsd);
    expect(out.refusal).toBeNull();
  });

  /**
   * ⚠️ RC-S6 — MUTATION: leave bridges out of the total. This reds.
   *
   * Four bridges are four choices she made; the number she approves has to contain them.
   */
  it("requested bridges are in the total, and un-asked joins cost nothing", () => {
    const withBridge = setBridge(board(), 1, true);
    const free = boardQuote(board(), clips(), [q("k2", 0.63, 0.42)], LIMITS);
    const paid = boardQuote(withBridge, clips(), [q("k2", 0.63, 0.42)], LIMITS);
    // The same bridge quote is available to both; only the one that ASKED pays for it.
    expect(free.ceilingUsd).toBeCloseTo(1.89, 5);
    expect(paid.ceilingUsd).toBeCloseTo(2.52, 5);
    expect(paid.perRow[1].bridge).not.toBeNull();
    expect(free.perRow[1].bridge).toBeNull();
  });

  it("matches quotes to rows BY KEY, so a reorder cannot re-point a price", () => {
    const reordered = moveRow(board(), 2, 0); // k3, k1, k2
    const out = boardQuote(
      reordered,
      [q("k1", 1, 1), q("k2", 2, 2), q("k3", 3, 3)],
      [],
      LIMITS,
    );
    expect(out.perRow.map((r) => r.key)).toEqual(["k3", "k1", "k2"]);
    expect(out.perRow.map((r) => r.clip!.ceilingUsd)).toEqual([3, 1, 2]);
    // P7: the total is order-independent.
    expect(out.ceilingUsd).toBe(6);
  });

  /**
   * ⚠️ RC-S3 — MUTATION: skip an unpriced row instead of blocking the board. This reds.
   *
   * `spendCaps` refuses an unpriced quote server-side. A board that dropped such a row from its
   * total would show her a number smaller than the one that runs.
   */
  it("one unpriced row blocks the whole board", () => {
    const out = boardQuote(
      board(),
      [q("k1", 0.63, 0.42), q("k2", 0, 0, true), q("k3", 0.63, 0.42)],
      [],
      LIMITS,
    );
    expect(out.refusal).toMatch(/can't price/i);
  });

  it("a row with no quote yet blocks it too, rather than counting as free", () => {
    const out = boardQuote(board(), [q("k1", 0.63, 0.42)], [], LIMITS);
    expect(out.refusal).toMatch(/working out what this board costs/i);
  });

  it("an asked-for bridge with no quote yet blocks it as well", () => {
    const out = boardQuote(setBridge(board(), 1, true), clips(), [], LIMITS);
    expect(out.refusal).toMatch(/working out what this board costs/i);
  });

  /**
   * ⚠️ RC-S4 — MUTATION: drop the cap comparison. This reds.
   *
   * Applied to the BOARD total, which is stricter than the server's per-job gate — deliberately: a
   * board is one decision to her however many jobs it is underneath.
   */
  it("a board over maxJobUsd refuses before anything runs, and names both numbers", () => {
    const out = boardQuote(board(), clips(), [], { maxJobUsd: 1 });
    expect(out.refusal).toContain("$1.89");
    expect(out.refusal).toContain("$1.00");
    expect(out.refusal).toMatch(/remove a shot or a transition/i);
  });

  it("refuses on the CEILING, not on the expected invoice", () => {
    // Expected is 1.26 and would pass a 1.50 cap; the ceiling is 1.89 and must not.
    const out = boardQuote(board(), clips(), [], { maxJobUsd: 1.5 });
    expect(out.refusal).toBeTruthy();
  });

  /**
   * ⚠️ ORDER OF REFUSALS. An unpriced board is refused BEFORE its total is compared to anything: a
   * total built from a quote that does not exist is a number with no meaning, and comparing it to a
   * cap would dress that up as a decision.
   */
  it("unpriced beats over-cap when a board is both", () => {
    const out = boardQuote(
      board(),
      [q("k1", 99, 99), q("k2", 0, 0, true), q("k3", 99, 99)],
      [],
      { maxJobUsd: 1 },
    );
    expect(out.refusal).toMatch(/can't price/i);
  });

  it("an empty board costs nothing and refuses nothing", () => {
    const out = boardQuote([], [], [], LIMITS);
    expect(out.ceilingUsd).toBe(0);
    expect(out.refusal).toBeNull();
  });

  /**
   * ─── THE CEILING IS ADMISSION'S, AND THERE IS NO FALLBACK ────────────────────────────────────
   *
   * It used to be PLACEHOLDER_MAX_JOB_USD — a number in the component, standing in for server config
   * no route carried. Admission's 200 now carries the real one, and until it lands there is none.
   */
  describe("the ceiling comes from admission", () => {
    /**
     * ⚠️ MUTATION: fall back to a number when admission has not answered — the placeholder coming
     * back as `limits ?? { maxJobUsd: 5 }`. This reds, and nothing else does.
     */
    it("a quoted board is not approvable until admission has said what the ceiling is", () => {
      const out = boardQuote(board(), clips(), [], null);
      expect(out.refusal).toMatch(/today's limits/);
      // The figures came from real quotes, so they may still be shown while the ceiling is asked.
      expect(out.priced).toBe(true);
    });

    /**
     * ⚠️ MUTATION: ignore `admissionRefusal`. This reds, and nothing else does.
     *
     * Admission knows what the client cannot: what is already spent today, whether a check expired,
     * whether this board already ran. When it says no, that sentence is the board's refusal.
     */
    it("admission's no is the board's refusal, in the server's own words", () => {
      const sentence =
        "Refusing to run this plan — 3 items quote $1.89 together, which would take today's total to $26.10, over the $25.00 daily ceiling (…).";
      expect(boardQuote(board(), clips(), [], null, sentence).refusal).toBe(
        sentence,
      );
    });

    it("an empty board needs no ceiling to be free", () => {
      expect(boardQuote([], [], [], null).refusal).toBeNull();
    });
  });
});

/**
 * ⚠️ FOUND ON DEVICE, not by a test. The panel rendered the refusal AND, three lines above it,
 * "$0.00 — usually about $0.00" beside two real shots. The refusal was right and the headline was a
 * lie, and the headline is what she reads first. A sum of nothing is 0 and looks exactly like free.
 */
describe("priced", () => {
  const clips = () => [
    q("k1", 0.63, 0.42),
    q("k2", 0.63, 0.42),
    q("k3", 0.63, 0.42),
  ];

  it("is false while any line is unquoted — a sum of nothing is not a price", () => {
    expect(boardQuote(board(), [], [], LIMITS).priced).toBe(false);
    expect(boardQuote(board(), [q("k1", 0.63, 0.42)], [], LIMITS).priced).toBe(
      false,
    );
  });

  it("is false when the server could not price a row", () => {
    const out = boardQuote(
      board(),
      [q("k1", 0.63, 0.42), q("k2", 0, 0, true), q("k3", 0.63, 0.42)],
      [],
      LIMITS,
    );
    expect(out.priced).toBe(false);
  });

  it("is false while an asked-for bridge is unquoted", () => {
    expect(
      boardQuote(setBridge(board(), 1, true), clips(), [], LIMITS).priced,
    ).toBe(false);
  });

  it("is true once every line has a real quote", () => {
    expect(boardQuote(board(), clips(), [], LIMITS).priced).toBe(true);
  });

  it("an EMPTY board is priced, and $0.00 is true for it", () => {
    const out = boardQuote([], [], [], LIMITS);
    expect(out.priced).toBe(true);
    expect(out.ceilingUsd).toBe(0);
  });

  it("stays true for a board that is merely too expensive", () => {
    // Over the cap is a refusal about MONEY, not about whether the money is known. The figures are
    // real and must still be shown — she cannot decide what to remove without seeing them.
    const out = boardQuote(board(), clips(), [], { maxJobUsd: 1 });
    expect(out.priced).toBe(true);
    expect(out.refusal).toBeTruthy();
  });
});

/**
 * ⚠️ FOUND BY PRESSING THE BUTTON. The board quoted $1.60, said "Ready", enabled the approve button,
 * and every piece refused on approval because video was switched off. The preview now says so
 * up front (server: `withVideoAvailability`), and this is the board half of that fix.
 */
describe("unavailable", () => {
  const clips = () => [
    q("k1", 0.63, 0.42),
    q("k2", 0.63, 0.42),
    q("k3", 0.63, 0.42),
  ];
  const off = (key: string): RowQuote => ({
    key,
    ceilingUsd: 0,
    expectedUsd: 0,
    unpriced: true,
    unavailable: "Video isn't switched on yet.",
  });

  /**
   * ⚠️ MUTATION: drop `unavailable` from the refusal chain, or put it after the cap check. This reds.
   *
   * "Still working out the cost" and "over the ceiling" are both answers to "what will this cost",
   * and neither is worth saying about a board that will not happen. It outranks them.
   */
  it("outranks every other refusal, and is said in the server's words", () => {
    const out = boardQuote(
      board(),
      [off("k1"), off("k2"), off("k3")],
      [],
      LIMITS,
    );
    expect(out.refusal).toBe("Video isn't switched on yet.");
  });

  it("outranks the cap even when the board is also too expensive", () => {
    const out = boardQuote(board(), [off("k1"), off("k2"), off("k3")], [], {
      maxJobUsd: 0.01,
    });
    expect(out.refusal).toBe("Video isn't switched on yet.");
    expect(out.refusal).not.toContain("ceiling");
  });

  it("renders no figure — a price for a job that will not happen is worse than none", () => {
    expect(
      boardQuote(board(), [off("k1"), off("k2"), off("k3")], [], LIMITS).priced,
    ).toBe(false);
  });

  /**
   * ⚠️ MUTATION: drop `&& unavailable === null` from `priced`. This reds — and ONLY through this
   * case, which is why it exists.
   *
   * The server sends `unavailable` together with `cost: null` and `unpriced: true` today, so the
   * `off()` fixtures above MASK the clause: they would report unpriced anyway. This quote carries a
   * real figure AND an unavailable reason, which the server does not currently produce — and the
   * module's contract is wider than today's one caller. If a preview ever quotes something it then
   * says is unavailable, the figure must still not be shown.
   */
  it("hides the figure even when the unavailable piece DID carry a price", () => {
    const pricedButOff: RowQuote = {
      key: "k2",
      ceilingUsd: 0.63,
      expectedUsd: 0.42,
      unavailable: "Video isn't switched on yet.",
    };
    const out = boardQuote(
      board(),
      [clips()[0], pricedButOff, clips()[2]],
      [],
      LIMITS,
    );
    expect(out.priced).toBe(false);
    expect(out.refusal).toBe("Video isn't switched on yet.");
  });

  it("one unavailable piece is enough, because they all hit the same wall", () => {
    const out = boardQuote(
      board(),
      [clips()[0], off("k2"), clips()[2]],
      [],
      LIMITS,
    );
    expect(out.refusal).toBe("Video isn't switched on yet.");
  });

  it("says nothing when every piece can run", () => {
    expect(boardQuote(board(), clips(), [], LIMITS).refusal).toBeNull();
  });
});

/**
 * ─── IMAGE-LESS ROWS: TEXT-TO-VIDEO (#6) ──────────────────────────────────────────────────────
 *
 * A shot made from her sentence alone. The chain tolerates zero references end to end — measured,
 * not assumed — and it costs the same as an i2v b-roll because seedance bills `w x h x frames /
 * 1024` and an input image is not a term in that.
 */
describe("a row with no photograph", () => {
  const textRow = (over: Partial<StoryboardRow> = {}): StoryboardRow =>
    row({
      assetId: null,
      thumbUrl: null,
      kind: "broll",
      hasPerson: false,
      ...over,
    });

  /**
   * ⚠️ MUTATION: let `brollRefusal` run its `hasPerson` check on an image-less row. This reds — and
   * the sentence it would print says "this photo", about a row that has none.
   */
  it("is b-roll eligible by definition, whatever hasPerson says", () => {
    expect(brollRefusal(textRow({ hasPerson: true }))).toBeNull();
    expect(kindAllowed(textRow({ hasPerson: true }), "broll")).toBe(true);
  });

  /**
   * ⚠️ MUTATION: make `motionRefusal` always return null. This reds.
   *
   * "Slight movement" is a beat performed BY a subject in a frame she supplied. With no frame there
   * is nothing to move, and the clip would be an invention rather than her photograph in motion.
   */
  it("cannot be slight movement — there is nothing to move", () => {
    const reason = motionRefusal(textRow());
    expect(reason).toMatch(/needs a photo to move/i);
    expect(kindAllowed(textRow(), "motion")).toBe(false);
    // And the refusal is a no-op, as everywhere else: never a silent rewrite.
    const rows = [textRow()];
    expect(setKind(rows, 0, "motion")).toBe(rows);
  });

  it("a row WITH a photo can be motion or your product — never b-roll, which is words", () => {
    expect(motionRefusal(row({ assetId: "a1" }))).toBeNull();
    expect(
      kindAllowed(row({ assetId: "a1", hasPerson: false }), "product"),
    ).toBe(true);
    expect(kindAllowed(row({ assetId: "a1", hasPerson: false }), "broll")).toBe(
      false,
    );
  });

  it("with nothing written in it, the board says so and quotes nothing", () => {
    // Its prompt is the ONLY content an image-less row has, so the existing blank-prompt gap is
    // exactly the right refusal — and a gap holds the whole board back from being priced.
    expect(boardGaps([textRow({ prompt: "" })]).join(" ")).toContain(
      "One shot still needs a line",
    );
  });

  it("with a sentence, it is a finished row", () => {
    expect(
      boardGaps([textRow({ prompt: "A ball on an empty pitch." })]),
    ).toEqual([]);
  });

  /**
   * ⚠️ THE MIXED BOARD. The sum logic should not care what kind a row is — but "should not care" is
   * how the kind got dropped on the way to the router in the first place, so it is pinned.
   *
   * $0.80 Veo motion + $0.3667 i2v b-roll + $0.3667 t2v b-roll = $1.5334.
   */
  it("quotes a mixed board of motion, i2v b-roll and t2v b-roll", () => {
    const rows: StoryboardRow[] = [
      row({ key: "k1", assetId: "a1", kind: "motion", hasPerson: true }),
      row({ key: "k2", assetId: "a2", kind: "broll", hasPerson: false }),
      textRow({ key: "k3", prompt: "A ball on an empty pitch." }),
    ];
    const out = boardQuote(
      rows,
      [q("k1", 0.8, 0.8), q("k2", 0.3667, 0.3667), q("k3", 0.3667, 0.3667)],
      [],
      { maxJobUsd: 10 },
    );
    expect(out.refusal).toBeNull();
    expect(out.priced).toBe(true);
    expect(out.ceilingUsd).toBeCloseTo(1.5334, 4);
  });
});

/**
 * ─── WHERE A BOARD IS ONCE IT HAS BEEN RUN (#3/#4) ────────────────────────────────────────────
 *
 * Phases come from `videoEntryLogic` rather than being restated here, so a board and the Video tab
 * cannot disagree about what "working" means.
 */
describe("boardProgress", () => {
  it("nothing asked for is not settled — there is nothing to be settled about", () => {
    const p = boardProgress([]);
    expect(p.settled).toBe(false);
    expect(p.hasClips).toBe(false);
  });

  it("counts what is made, what failed, and what is still moving", () => {
    const p = boardProgress(["ready", "failed", "working", "queued"]);
    expect(p).toMatchObject({
      total: 4,
      made: 1,
      failed: 1,
      working: 2,
      settled: false,
    });
  });

  /**
   * ⚠️ MUTATION: require `failed === 0` for `settled`. This reds.
   *
   * SETTLED IS NOT SUCCEEDED. A board whose pieces have all stopped — some made, some not — is
   * finished moving, and that is exactly when she should be offered what DID get made. Waiting for
   * every piece to succeed would strand a board on one refusal and throw away work already paid
   * for, which is the same reason the run does not stop on the first error.
   */
  it("is settled with failures in it, and still offers what was made", () => {
    const p = boardProgress(["ready", "failed", "ready"]);
    expect(p.settled).toBe(true);
    expect(p.made).toBe(2);
    expect(p.failed).toBe(1);
    expect(p.hasClips).toBe(true);
  });

  it("counts `unknown` as failed — a run we lost track of is not still coming", () => {
    // videoEntryLogic's `unknown` is the stalled verdict. Treating it as working would leave the
    // board spinning on something nothing will ever advance.
    const p = boardProgress(["unknown"]);
    expect(p.settled).toBe(true);
    expect(p.failed).toBe(1);
  });

  it("settled with nothing made offers no handoff", () => {
    const p = boardProgress(["failed", "failed"]);
    expect(p.settled).toBe(true);
    expect(p.hasClips).toBe(false);
  });
});

/**
 * MUTATION: let `setShotSlot` set a slot `slotsAllowed` does not list. "a refusal is a no-op" reds.
 * MUTATION: leave `shot: {}` behind when the last slot is cleared. "clearing the last slot" reds.
 */
describe("setShotSlot", () => {
  const slotRow = (over: Partial<StoryboardRow> = {}): StoryboardRow => ({
    key: "k1",
    assetId: null,
    thumbUrl: null,
    prompt: "An empty gym.",
    kind: "broll",
    hasPerson: false,
    ...over,
  });

  it("a row with no photo takes all four; a photo row takes movement alone", () => {
    expect(slotsAllowed(slotRow())).toEqual([
      "framing",
      "movement",
      "lighting",
      "environment",
    ]);
    expect(slotsAllowed(slotRow({ assetId: "a1" }))).toEqual(["movement"]);
  });

  it("sets a slot, and leaves every other row and slot alone", () => {
    const rows = [
      slotRow({ shot: { framing: "wide" } }),
      slotRow({ key: "k2" }),
    ];
    const next = setShotSlot(rows, 0, "lighting", "overcast");
    expect(next[0].shot).toEqual({ framing: "wide", lighting: "overcast" });
    expect(next[1]).toBe(rows[1]);
  });

  it("tapping the value it already has clears it, and so does null", () => {
    const rows = [slotRow({ shot: { framing: "wide", movement: "orbit" } })];
    expect(setShotSlot(rows, 0, "movement", "orbit")[0].shot).toEqual({
      framing: "wide",
    });
    expect(setShotSlot(rows, 0, "movement", null)[0].shot).toEqual({
      framing: "wide",
    });
  });

  it("clearing the last slot removes the KEY — never `shot: {}`", () => {
    const next = setShotSlot(
      [slotRow({ shot: { movement: "orbit" } })],
      0,
      "movement",
      null,
    );
    expect("shot" in next[0]).toBe(false);
  });

  it("a refusal is a no-op: a photo row asked for lighting is returned untouched", () => {
    const rows = [slotRow({ assetId: "a1" })];
    expect(setShotSlot(rows, 0, "lighting", "stadium")).toBe(rows);
    expect(setShotSlot(rows, 0, "movement", "tracking")[0].shot).toEqual({
      movement: "tracking",
    });
  });
});

describe("what the slots are called on the surface", () => {
  it("reads as her words, never the wire name", () => {
    expect(SLOT_LABELS.environment).toBe("Setting");
    expect(slotValueLabel("golden-hour")).toBe("Golden hour");
    expect(slotValueLabel("push-in")).toBe("Push in");
    expect(slotValueLabel("wide")).toBe("Wide");
  });

  // Explained, never hidden: a photo row says WHY three slots are not offered.
  it("a photo row explains the slots it does not offer; a text row has nothing to explain", () => {
    const base = {
      key: "k",
      thumbUrl: null,
      prompt: "",
      kind: "broll" as const,
      hasPerson: false,
    };
    expect(slotsNote({ ...base, assetId: "a1" })).toContain(
      "come from the photo",
    );
    expect(slotsNote({ ...base, assetId: null })).toBeNull();
  });
});

/**
 * ─── THE RE-QUOTE SIGNATURE — WHAT SHE TAPS MUST BE WHAT SHE PAYS FOR ──────────────────────────
 *
 * "Make the board" runs the previewIds the last quote stored, and the board only re-quotes when
 * this string changes. So a field that travels in the request but is missing here means she spends
 * against a preview frozen BEFORE her change. It happened: the shot slots were on the row and in
 * the request and not in the signature, she tapped Tracking, nothing re-quoted, and the job ran on
 * a brief with no `shot` key — found on the first real run, by reading the job row.
 *
 * MUTATION: drop `r.shot` from `rowSignature`. "a chip tap changes the signature" reds — that IS
 * the shipped bug.
 */
describe("rowSignature — every field the request reads re-quotes the board", () => {
  const sigRow = (over: Partial<StoryboardRow> = {}): StoryboardRow => ({
    key: "k1",
    assetId: null,
    thumbUrl: null,
    prompt: "An empty gym.",
    kind: "broll",
    hasPerson: false,
    ...over,
  });

  it("a chip tap changes the signature, and so does clearing it", () => {
    const bare = rowSignature([sigRow()]);
    const tapped = rowSignature(
      setShotSlot([sigRow()], 0, "movement", "tracking"),
    );
    expect(tapped).not.toBe(bare);
    const cleared = rowSignature(
      setShotSlot(
        setShotSlot([sigRow()], 0, "movement", "tracking"),
        0,
        "movement",
        null,
      ),
    );
    expect(cleared).toBe(bare);
  });

  it("every slot, and every value of it, is a different signature", () => {
    const seen = new Set<string>([rowSignature([sigRow()])]);
    const all = {
      framing: ["wide", "medium", "close"],
      movement: ["static", "push-in", "tracking", "orbit"],
      lighting: ["golden-hour", "stadium", "overcast", "warm-lamp"],
      environment: [
        "stadium",
        "training-ground",
        "gym",
        "locker-room",
        "street",
        "studio",
      ],
    } as const;
    let n = 1;
    for (const [slot, values] of Object.entries(all))
      for (const value of values) {
        seen.add(rowSignature([sigRow({ shot: { [slot]: value } })]));
        n++;
      }
    // `stadium` is a lighting AND an environment value — they must not collide.
    expect(seen.size).toBe(n);
  });

  it("the same spec tapped in a different order is the SAME signature — no needless re-quote", () => {
    const a = rowSignature([
      sigRow({ shot: { framing: "wide", lighting: "overcast" } }),
    ]);
    const b = rowSignature([
      sigRow({ shot: { lighting: "overcast", framing: "wide" } }),
    ]);
    expect(a).toBe(b);
  });

  it("still moves on everything it moved on before", () => {
    const base = rowSignature([sigRow()]);
    for (const over of [
      { key: "k2" },
      { assetId: "a1" },
      { prompt: "A different gym." },
      { kind: "motion" as const },
      { bridgeRequested: true },
    ])
      expect(rowSignature([sigRow(over)])).not.toBe(base);
    // …and NOT on what the request never reads: a thumbnail url is display only.
    expect(rowSignature([sigRow({ thumbUrl: "https://x/t.jpg" })])).toBe(base);
  });
});

/**
 * ─── THE QUOTE MUST BE FOR THE BOARD ON HER SCREEN ────────────────────────────────────────────────
 *
 * Between an edit and the re-quote landing — the debounce, then one preview per piece — the stored
 * previewIds authorise the board she HAD. The button used to stay live through that window, and a tap
 * spent the old previews: the run matched the old quote exactly and matched neither her screen nor
 * what she meant.
 */
describe("approvalBlock", () => {
  /**
   * ⚠️ MUTATION: drop the `quotedFor !== signature` check. This reds, and nothing else does.
   */
  it("an edit after the quote blocks approval until the board is re-quoted", () => {
    const before = board();
    const quotedFor = rowSignature(before);
    const after = setPrompt(before, 1, "She turns to the crowd instead.");

    // Mid-window: the quotes on hand are for `before`.
    expect(approvalBlock([], null, quotedFor, rowSignature(after))).toBe(
      STALE_QUOTE_NOTE,
    );
    // Nothing quoted at all is not a quote for this board either.
    expect(approvalBlock([], null, null, rowSignature(after))).toBe(
      STALE_QUOTE_NOTE,
    );
    // The re-quote lands, stamped for `after`: approvable again.
    expect(
      approvalBlock([], null, rowSignature(after), rowSignature(after)),
    ).toBeNull();
  });

  it("an untouched board is approvable exactly as before — gaps and refusals still come first", () => {
    const sig = rowSignature(board());
    expect(approvalBlock([], null, sig, sig)).toBeNull();
    expect(
      approvalBlock(["One shot still needs a line."], null, sig, sig),
    ).toBe("One shot still needs a line.");
    expect(approvalBlock([], "Over the ceiling.", sig, sig)).toBe(
      "Over the ceiling.",
    );
  });
});

describe("boardSignature — the Board's quote key carries what it is FOR", () => {
  /**
   * ⚠️ MUTATION: key the quote on the rows alone, dropping the objective. This reds, and nothing
   * else does.
   *
   * The objective is in every request the Board makes. A plan she built as "showcase-product" and
   * put on the Board must be priced — and run — as that, never re-priced as "grow-following".
   */
  it("a seeded board with another objective is a different quote", () => {
    const rows = board();
    expect(boardSignature(rows, "showcase-product")).not.toBe(
      boardSignature(rows, "grow-following"),
    );
  });

  it("still moves with every row field, whatever the objective", () => {
    const before = board();
    const after = setPrompt(before, 0, "A different first line.");
    expect(boardSignature(after, "recap")).not.toBe(
      boardSignature(before, "recap"),
    );
  });

  /**
   * ⚠️ MUTATION (PR 14): key the quote on rows and objective alone, dropping planId. This reds — and
   * a Board whose plan changed under it (the agent door's re-plan) would spend against a quote made
   * for the old plan's constraints. The chip-tap lesson: every field a request reads is in the key.
   */
  it("moves with the plan id the requests carry, and not with a held row's direction (no request reads it)", () => {
    const rows = board();
    expect(
      boardSignature(rows, "recap", "00000000-0000-4000-8000-000000000014"),
    ).not.toBe(boardSignature(rows, "recap", null));
    expect(boardSignature(rows, "recap", null)).toBe(
      boardSignature(rows, "recap"),
    );
    const held = rows.map((r) => ({ ...r, direction: "the planner's line" }));
    expect(boardSignature(held, "recap")).toBe(boardSignature(rows, "recap"));
  });
});

describe("seedDecision — what the Board does with a plan that has just arrived", () => {
  it("waits while a run is in progress, whatever is on the board", () => {
    expect(seedDecision(0, true)).toBe("wait");
    expect(seedDecision(3, true)).toBe("wait");
  });

  it("applies to an empty board, and asks before replacing her work", () => {
    expect(seedDecision(0, false)).toBe("apply");
    expect(seedDecision(3, false)).toBe("ask");
  });
});

// ─── "‹ Back to the plan" ────────────────────────────────────────────────────────────────────────
//
// REVERT CHECKS, red by name:
//   RC-A1  drop the running check        → "is not drawn while anything runs — a board popped mid-run would keep spending, unwatched"
//   RC-A2  drop the holds-work question  → "asks first when the board holds work since the seed"

describe("backToPlan — a pop, which ends this board", () => {
  it("is not drawn while anything runs — a board popped mid-run would keep spending, unwatched", () => {
    expect(
      backToPlan({ available: true, running: true, holdsWork: false }),
    ).toBe("hidden");
    expect(
      backToPlan({ available: true, running: true, holdsWork: true }),
    ).toBe("hidden");
  });

  it("is not drawn on a board that was not seeded here over the Agent screen", () => {
    expect(
      backToPlan({ available: false, running: false, holdsWork: false }),
    ).toBe("hidden");
  });

  it("goes straight back when the board is exactly as the plan left it", () => {
    expect(
      backToPlan({ available: true, running: false, holdsWork: false }),
    ).toBe("go");
  });

  it("asks first when the board holds work since the seed", () => {
    expect(
      backToPlan({ available: true, running: false, holdsWork: true }),
    ).toBe("confirm");
    expect(BACK_TO_PLAN_NOTE).toBe(
      "Going back leaves this board. What you made stays in your library.",
    );
  });
});

// ─── The money, with a still on the board ─────────────────────────────────────────────────────

describe("boardQuote with a still — $0, and not a missing quote", () => {
  const still = (key: string, stillSec = 2) =>
    heldPhotoRow(key, `asset-${key}`, null, stillSec);

  /**
   * ⚠️ RC-C1b-5 — MUTATION: count a still as a missing quote (drop the `r.held === null` term).
   * This reds.
   *
   * A still has no clip quote because it has no clip. Counting it as missing held every board with
   * a held photo on "Still working out what this board costs" — forever, since no quote will ever
   * arrive for it.
   */
  it("a board with a still still prices — the shots' quotes are the total, the still is $0 · held", () => {
    const rows = [row({ key: "k1" }), still("s", 3), row({ key: "k3" })];
    const out = boardQuote(
      rows,
      [q("k1", 0.63, 0.42), q("k3", 0.63, 0.42)],
      [],
      LIMITS,
    );
    expect(out.priced).toBe(true);
    expect(out.refusal).toBeNull();
    expect(out.ceilingUsd).toBeCloseTo(1.26, 6);
    expect(out.expectedUsd).toBeCloseTo(0.84, 6);
    expect(out.perRow[1]).toEqual({
      key: "s",
      clip: null,
      bridge: null,
      own: null,
      held: 3,
    });
    expect(out.perRow[0].held).toBeNull();
  });

  it("a shot's quote is still missing beside a still — the still does not excuse it", () => {
    const rows = [row({ key: "k1" }), still("s")];
    const out = boardQuote(rows, [], [], LIMITS);
    expect(out.priced).toBe(false);
    expect(out.refusal).toBe(
      "Still working out what this board costs — one moment.",
    );
  });

  it("an all-still board is $0.00, priced, and needs no ceiling — there is nothing to admit", () => {
    const out = boardQuote([still("a"), still("b", 5)], [], [], null);
    expect(out.priced).toBe(true);
    expect(out.refusal).toBeNull();
    expect(out.ceilingUsd).toBe(0);
    expect(out.expectedUsd).toBe(0);
    expect(out.perRow.map((r) => r.held)).toEqual([2, 5]);
    // The Agent estimate's shape — no bridges, no limits — prices the same way.
    expect(boardQuote([still("a")], [], [], null).priced).toBe(true);
  });
});

// ─── A held photo — a row that generates nothing ───────────────────────────────────────────────

describe("a still row — one of her photos, held, generating nothing", () => {
  const STILL_LIMITS = { minStillSec: 1, maxStillSec: 8 };
  const still = (key = "s1", stillSec = 2) =>
    heldPhotoRow(key, `asset-${key}`, null, stillSec);

  it("is made, not chosen — no prompt, no person, its hold on the row", () => {
    const s = still();
    expect(isStillRow(s)).toBe(true);
    expect(s).toMatchObject({
      kind: "still",
      prompt: "",
      hasPerson: false,
      stillSec: 2,
    });
    expect(stillRefusal(s)).toBeNull();
    expect(stillRefusal({ ...s, assetId: null })).not.toBeNull();
    expect(kindAllowed(s, "still")).toBe(true);
  });

  it("holds for what she chose, clamped to the server's bounds, and a shot ignores the chip", () => {
    const rows = [still(), row({ key: "k2" })];
    expect(setStillSec(rows, 0, 5, STILL_LIMITS)[0].stillSec).toBe(5);
    expect(setStillSec(rows, 0, 0, STILL_LIMITS)[0].stillSec).toBe(1);
    expect(setStillSec(rows, 0, 30, STILL_LIMITS)[0].stillSec).toBe(8);
    expect(setStillSec(rows, 0, NaN, STILL_LIMITS)).toBe(rows);
    expect(setStillSec(rows, 1, 5, STILL_LIMITS)[1]).toEqual(rows[1]);
  });

  it("is never re-kinded, and never gains a line, sound or a camera", () => {
    const rows = [still(), row({ key: "k2" })];
    expect(setKind(rows, 0, "motion")).toBe(rows);
    expect(setKind(rows, 1, "still")).toBe(rows);
    expect(setPrompt(rows, 0, "Hold on this.")[0].prompt).toBe("");
    expect("audio" in setAudio(rows, 0, true)[0]).toBe(false);
    expect(slotsAllowed(rows[0])).toEqual([]);
    expect(setShotSlot(rows, 0, "movement", "tracking")).toBe(rows);
  });

  /**
   * ⚠️ RC-C1b-1 — MUTATION: drop the two `isStillRow` terms from `bridgeable`. This reds.
   *
   * A still HAS a photo, so the asset check alone would let a bridge be generated into or out of
   * a held photo. The C1 rule is that no bridge touches a still — its joins are Cut or Fade only —
   * and it is enforced here, in `setBridge`, and again by `normalizeBoard` after a reorder.
   */
  it("a bridge never touches a still — not into it, not out of it, and a reorder strips one", () => {
    const into = [row({ key: "k1" }), still("s")];
    const outOf = [still("s"), row({ key: "k2" })];
    expect(bridgeable(into, 1)).toBe(false);
    expect(bridgeable(outOf, 1)).toBe(false);
    expect(setBridge(into, 1, true)[1].bridgeRequested).toBeUndefined();
    expect(setBridge(outOf, 1, true)[1].bridgeRequested).toBeUndefined();
    // Asked for between two shots, then a still is dragged between them: the ask is gone.
    const bridged = setBridge(
      [row({ key: "k1" }), row({ key: "k2" }), still("s")],
      1,
      true,
    );
    expect(bridged[1].bridgeRequested).toBe(true);
    const moved = moveRow(bridged, 2, 1);
    expect(moved.map((r) => r.key)).toEqual(["k1", "s", "k2"]);
    expect(moved[2].bridgeRequested).toBeUndefined();
    // And a seed that arrived with one beside a still loses it on normalisation.
    const seeded = [
      row({ key: "k1" }),
      { ...still("s"), bridgeRequested: true },
    ];
    expect(normalizeBoard(seeded)[1].bridgeRequested).toBeUndefined();
  });

  it("a Cut is hers only beside a still — and a reorder that moves the still away takes it back", () => {
    const rows = [
      row({ key: "k1" }),
      still("s"),
      row({ key: "k2" }),
      row({ key: "k3" }),
    ];
    expect(cutAllowed(rows, 1)).toBe(true); // into the still
    expect(cutAllowed(rows, 2)).toBe(true); // out of it
    expect(cutAllowed(rows, 3)).toBe(false); // two shots: the free fade or a bridge, as ever
    expect(cutAllowed(rows, 0)).toBe(false);
    expect(setCut(rows, 3, true)[3].cutIn).toBeUndefined();
    const cut = setCut(setCut(rows, 1, true), 2, true);
    expect(cut[1].cutIn).toBe(true);
    expect(cut[2].cutIn).toBe(true);
    expect("cutIn" in setCut(cut, 2, false)[2]).toBe(false);
    // The still dragged to the end: k2's join is between two shots again.
    const moved = moveRow(cut, 1, 3);
    expect(moved.map((r) => r.key)).toEqual(["k1", "k2", "k3", "s"]);
    expect(moved[1].cutIn).toBeUndefined();
    expect(moved[3].cutIn).toBe(true); // into the still, still allowed
    // And a Cut is work she would mind losing, but not something to re-quote.
    expect(rowSignature(cut)).toBe(rowSignature(rows));
    expect(boardWorkSignature(cut, "grow-following")).not.toBe(
      boardWorkSignature(rows, "grow-following"),
    );
  });

  it("needs no line — a board of stills has no gaps — and still counts toward the cap", () => {
    expect(boardGaps([still("a"), still("b")])).toEqual([]);
    expect(boardGaps([still("a"), row({ key: "k", prompt: "" })])).toEqual([
      "One shot still needs a line about what happens in it.",
    ]);
    const nine = Array.from({ length: MAX_ROWS + 1 }, (_, i) => still(`s${i}`));
    expect(boardGaps(nine)).toEqual([
      `${MAX_ROWS + 1} shots — a board holds up to ${MAX_ROWS}.`,
    ]);
  });

  /**
   * ⚠️ TWO SIGNATURES, ON PURPOSE. MUTATION: add `stillSec` to `rowSignature`, OR drop it from
   * `boardWorkSignature`. Either reds.
   *
   * No request reads a hold, so the quote key must not move when it changes (a re-quote would fetch
   * the same previews again for nothing). But a hold change IS work she would mind losing, so the
   * back-to-plan key must move. The two answer different questions and must not be unified.
   */
  it("a hold change leaves the quote key alone and moves the work key", () => {
    const rows = [still("s", 2), row({ key: "k2" })];
    const longer = setStillSec(rows, 0, 5, STILL_LIMITS);
    expect(rowSignature(longer)).toBe(rowSignature(rows));
    expect(boardSignature(longer, "grow-following")).toBe(
      boardSignature(rows, "grow-following"),
    );
    expect(boardWorkSignature(longer, "grow-following")).not.toBe(
      boardWorkSignature(rows, "grow-following"),
    );
    // And an edit the quote key sees, the work key sees too.
    const edited = setPrompt(rows, 1, "She turns to the camera.");
    expect(boardWorkSignature(edited, "grow-following")).not.toBe(
      boardWorkSignature(rows, "grow-following"),
    );
  });
});

// ─── One of her clips on the board (C2 Half B) ─────────────────────────────────────────────────

describe("a clip row — her own footage, placed, whole or cut to a beat", () => {
  const clip = (
    key = "c1",
    trim: { startSec: number; endSec: number } | null = {
      startSec: 3,
      endSec: 6.5,
    },
    keepSound = true,
  ) => heldClipRow(key, `clip-${key}`, null, trim, 6.5, keepSound);

  it("is placed, not chosen — no prompt, no person, its window, its length and its own sound on the row", () => {
    const c = clip();
    expect(isClipRow(c)).toBe(true);
    expect(isHeldRow(c)).toBe(true);
    expect(isHeldRow(row())).toBe(false);
    expect(c).toEqual({
      key: "c1",
      assetId: "clip-c1",
      thumbUrl: null,
      prompt: "",
      kind: "clip",
      hasPerson: false,
      clipTrim: { startSec: 3, endSec: 6.5 },
      clipSec: 6.5,
      audio: true,
    });
    // Whole, unmeasured, muted: no trim key, no length key, no audio key — absent, never false.
    expect(heldClipRow("c2", "x", null, null, null, false)).toEqual({
      key: "c2",
      assetId: "x",
      thumbUrl: null,
      prompt: "",
      kind: "clip",
      hasPerson: false,
    });
    expect(clipRefusal(c)).toBeNull();
    expect(clipRefusal({ ...c, assetId: null })).not.toBeNull();
    expect(kindAllowed(c, "clip")).toBe(true);
  });

  it("plays its window, else its length, else nothing known — and 'use the whole clip' drops the window", () => {
    expect(clipPlays(clip())).toBe(3.5);
    expect(clipPlays(clip("c1", null))).toBe(6.5);
    expect(
      clipPlays(heldClipRow("c", "x", null, null, null, false)),
    ).toBeNull();
    const rows = [clip(), row({ key: "k2" })];
    expect("clipTrim" in clearClipTrim(rows, 0)[0]).toBe(false);
    expect(clearClipTrim(rows, 1)[1]).toEqual(rows[1]);
  });

  /**
   * ⚠️ MUTATION: let `setKind` re-kind a clip row, or let `slotsAllowed` offer a clip a slot. Reds.
   */
  it("is never re-kinded, never gains a line or a camera — but its own sound can be kept or muted, free", () => {
    const rows = [clip(), row({ key: "k2" })];
    expect(setKind(rows, 0, "motion")).toBe(rows);
    expect(setKind(rows, 1, "clip")).toBe(rows);
    expect(setPrompt(rows, 0, "Hold on this.")[0].prompt).toBe("");
    expect(slotsAllowed(rows[0])).toEqual([]);
    expect(setShotSlot(rows, 0, "movement", "tracking")).toBe(rows);
    expect("audio" in setAudio(rows, 0, false)[0]).toBe(false);
    expect(setAudio(rows, 0, true)[0].audio).toBe(true);
  });

  /**
   * ⚠️ RULING 1, AGAIN — MUTATION: put `clipTrim` or a clip's `audio` into `rowSignature`. Reds.
   * No request reads them; the stitch does.
   */
  it("its window and its sound are edits, not quote terms — out of rowSignature, in boardWorkSignature", () => {
    const a = [
      clip("c1", { startSec: 0, endSec: 3 }, true),
      row({ key: "k2" }),
    ];
    const b = [
      clip("c1", { startSec: 3, endSec: 6.5 }, false),
      row({ key: "k2" }),
    ];
    expect(rowSignature(a)).toBe(rowSignature(b));
    expect(boardWorkSignature(a, "recap")).not.toBe(
      boardWorkSignature(b, "recap"),
    );
    // A shot's sound is still a quote term — the clip rule does not leak onto it.
    expect(rowSignature([row({ audio: true })])).not.toBe(
      rowSignature([row()]),
    );
  });

  it("no bridge touches it; beside it the join is Cut or Fade; it needs no line; it counts toward MAX_ROWS", () => {
    const rows = [row({ key: "k1" }), clip("c1"), row({ key: "k3" })];
    expect(bridgeable(rows, 1)).toBe(false);
    expect(bridgeable(rows, 2)).toBe(false);
    expect(cutAllowed(rows, 1)).toBe(true);
    expect(cutAllowed(rows, 2)).toBe(true);
    expect(setCut(rows, 2, true)[2].cutIn).toBe(true);
    expect(boardGaps(rows)).toEqual([]);
    expect(
      boardGaps(Array.from({ length: MAX_ROWS + 1 }, (_, i) => clip(`c${i}`))),
    ).toEqual([`${MAX_ROWS + 1} shots — a board holds up to ${MAX_ROWS}.`]);
  });

  /**
   * ⚠️ MUTATION: count a clip row among the `missing` quotes in `boardQuote`. This reds — and the
   * board would sit on "Still working out what this board costs" forever, exactly as a still did.
   */
  it("is a $0 line — its seconds of hers — and never a missing quote; a clip-only board is priced at $0.00", () => {
    const rows = [row({ key: "k1" }), clip("c1")];
    const q = boardQuote(
      rows,
      [{ key: "k1", ceilingUsd: 0.63, expectedUsd: 0.42 }],
      [],
      { maxJobUsd: 10 },
    );
    expect(q.priced).toBe(true);
    expect(q.perRow[1]).toMatchObject({
      clip: null,
      held: null,
      own: { seconds: 3.5 },
    });
    expect(q.ceilingUsd).toBeCloseTo(0.63, 6);
    const alone = boardQuote([clip("c1")], [], [], null);
    expect(alone.priced).toBe(true);
    expect(alone.ceilingUsd).toBe(0);
    expect(alone.refusal).toBeNull();
  });
});

/**
 * ⚠️ MUTATION, red here by name: add `r.videoUrl` to `rowSignature` (or to `boardWorkSignature`'s
 * edit list) — "two clip rows differing only in videoUrl are one signature" reds.
 */
describe("videoUrl on a clip row is display only — in neither signature", () => {
  it("two clip rows differing only in videoUrl are one signature, quote and work alike", () => {
    const plain = heldClipRow(
      "k",
      "c1",
      null,
      { startSec: 3, endSec: 6 },
      8,
      true,
    );
    const playable = heldClipRow(
      "k",
      "c1",
      null,
      { startSec: 3, endSec: 6 },
      8,
      true,
      "https://signed.example/c1.mp4",
    );
    expect(playable.videoUrl).toBe("https://signed.example/c1.mp4");
    expect(plain.videoUrl).toBeUndefined();
    expect(rowSignature([playable])).toBe(rowSignature([plain]));
    expect(boardWorkSignature([playable], "recap")).toBe(
      boardWorkSignature([plain], "recap"),
    );
  });

  it("cutVideos / asIsVideos split her picked videos by beats and her choice", () => {
    const vids = [
      { assetId: "a", posterUrl: null, beats: 3, cut: true },
      { assetId: "b", posterUrl: null, beats: 3, cut: false },
      { assetId: "c", posterUrl: "p", beats: 0, cut: true },
    ];
    expect(cutVideos(vids).map((v) => v.assetId)).toEqual(["a"]);
    expect(asIsVideos(vids)).toEqual([
      { assetId: "b", posterUrl: null },
      { assetId: "c", posterUrl: "p" },
    ]);
  });
});

describe("setStillMotion — a still's push-in, on a still row and no other (C3, D2)", () => {
  /** ⚠️ MUTATION: set it on any row — "a shot row is untouched" reds by name. */
  it("sets pan, clears it back to absent, and a shot row is untouched", () => {
    const rows = [
      heldPhotoRow("s", "p1", null, 2),
      row({ key: "k", assetId: "a-k" }),
    ];
    const on = setStillMotion(rows, 0, "dolly");
    expect(on[0].stillMotion).toBe("dolly");
    expect("stillMotion" in setStillMotion(on, 0, null)[0]).toBe(false);
    expect(setStillMotion(rows, 1, "dolly")[1]).toEqual(rows[1]);
    expect(heldPhotoRow("s", "p1", null, 4, "dolly").stillMotion).toBe("dolly");
    expect("stillMotion" in heldPhotoRow("s", "p1", null, 4, null)).toBe(false);
  });

  it("a push-in is an edit, not a request: it moves the work signature and not the quote key", () => {
    const rows = [
      heldPhotoRow("s", "p1", null, 2),
      row({ key: "k", assetId: "a-k" }),
    ];
    const on = setStillMotion(rows, 0, "dolly");
    expect(boardSignature(on, "grow-following")).toBe(
      boardSignature(rows, "grow-following"),
    );
    expect(boardWorkSignature(on, "grow-following")).not.toBe(
      boardWorkSignature(rows, "grow-following"),
    );
  });
});

describe("a move toward a point — setStillMotion keeps her point between moves that take one (PR 5, A1)", () => {
  const still = () => [
    heldPhotoRow("s", "p1", null, 3, "zoom"),
    row({ key: "k", assetId: "a-k" }),
  ];

  /**
   * ⚠️ MUTATION: setStillMotion keeps the point whatever the motion — "dropped on a push-in" reds by
   * name (the server would refuse the stitch body: a point beside a push-in does nothing).
   */
  it("the point survives zoom → punch → pan-across, and is dropped on a push-in or a dead still", () => {
    const tapped = setStillFocus(still(), 0, { x: 0.3, y: 0.25 });
    expect(tapped[0].stillFocus).toEqual({ x: 0.3, y: 0.25 });
    const punch = setStillMotion(tapped, 0, "punch");
    expect(punch[0]).toMatchObject({
      stillMotion: "punch",
      stillFocus: { x: 0.3, y: 0.25 },
    });
    expect(setStillMotion(punch, 0, "sweep")[0].stillFocus).toEqual({
      x: 0.3,
      y: 0.25,
    });
    expect("stillFocus" in setStillMotion(tapped, 0, "dolly")[0]).toBe(false);
    expect("stillFocus" in setStillMotion(tapped, 0, null)[0]).toBe(false);
  });

  it("a point is set only on a still whose motion takes one, clamped to the photo; null gives it back to the photo", () => {
    const rows = still();
    expect(setStillFocus(rows, 1, { x: 0.5, y: 0.5 })[1]).toEqual(rows[1]);
    const pushed = setStillMotion(rows, 0, "dolly");
    expect(setStillFocus(pushed, 0, { x: 0.5, y: 0.5 })[0]).toEqual(pushed[0]);
    expect(setStillFocus(rows, 0, { x: 1.4, y: -0.2 })[0].stillFocus).toEqual({
      x: 1,
      y: 0,
    });
    const set = setStillFocus(rows, 0, { x: 0.12345, y: 0.5 });
    expect(set[0].stillFocus).toEqual({ x: 0.123, y: 0.5 });
    expect("stillFocus" in setStillFocus(set, 0, null)[0]).toBe(false);
  });

  it("where a move heads is an edit, not a request: it moves the work signature and not the quote key", () => {
    const rows = still();
    const tapped = setStillFocus(rows, 0, { x: 0.3, y: 0.25 });
    expect(boardSignature(tapped, "grow-following")).toBe(
      boardSignature(rows, "grow-following"),
    );
    expect(boardWorkSignature(tapped, "grow-following")).not.toBe(
      boardWorkSignature(rows, "grow-following"),
    );
  });

  it("a tap lands on the photo as a fraction of the PHOTO, not of its letterboxed stage; a tap on the bars is nothing", () => {
    // A portrait photo contained in a 168-square stage: drawn 126 wide, 21 px bars either side.
    const drawn = { x: 21, y: 0, w: 126, h: 168 };
    expect(focusFromTap({ x: 21 + 63, y: 42 }, drawn)).toEqual({
      x: 0.5,
      y: 0.25,
    });
    expect(focusFromTap({ x: 10, y: 84 }, drawn)).toBeNull();
    expect(focusFromTap({ x: 84, y: 84 }, null)).toBeNull();
  });
});

// ─── THE COMPOSER'S SLOTS (PR 15, R-2, docs/probes/composer.md) ─────────────────────────────────

describe("the composer's slots — six on a photo-less row, a dropped one named", () => {
  const slotRow = (over: Partial<StoryboardRow> = {}): StoryboardRow => ({
    key: "k1",
    assetId: null,
    thumbUrl: null,
    prompt: "An empty gym.",
    kind: "broll",
    hasPerson: false,
    ...over,
  });

  it("with the composer on a photo-less row takes six slots; a photo row still movement alone; a held row none — and off is the four", () => {
    expect(slotsAllowed(slotRow(), true)).toEqual([
      "framing",
      "movement",
      "lighting",
      "environment",
      "composition",
      "motion",
    ]);
    expect(slotsAllowed(slotRow({ assetId: "a1" }), true)).toEqual([
      "movement",
    ]);
    expect(
      slotsAllowed(
        slotRow({ assetId: "a1", kind: "still", stillSec: 2 }),
        true,
      ),
    ).toEqual([]);
    expect(slotsAllowed(slotRow(), false)).toEqual([
      "framing",
      "movement",
      "lighting",
      "environment",
    ]);
    expect(slotsAllowed(slotRow())).toEqual(slotsAllowed(slotRow(), false));
  });

  /** ⚠️ MUTATION: return null for a photo row's framing — this reds by name. */
  it("a photo row silently drops framing — never: every dropped slot has a named reason", () => {
    const photo = slotRow({ assetId: "a1", kind: "motion", hasPerson: true });
    expect(droppedSlotReason(photo, "framing")).toBe("photo-decides");
    expect(droppedSlotReason(photo, "lighting")).toBe("photo-decides");
    expect(droppedSlotReason(photo, "environment")).toBe("photo-decides");
    expect(droppedSlotReason(photo, "composition")).toBe("photo-decides");
    expect(droppedSlotReason(photo, "motion")).toBe("in-her-sentence");
    expect(droppedSlotReason(photo, "movement")).toBeNull();
    const held = slotRow({ assetId: "a1", kind: "still", stillSec: 2 });
    expect(droppedSlotReason(held, "movement")).toBe("nothing-filmed");
    expect(droppedSlotReason(slotRow(), "framing")).toBeNull();
  });

  it("the chips offer the original values with the composer off and the whole vocabulary on", () => {
    expect(shotSlotValues("framing")).toEqual(["wide", "medium", "close"]);
    expect(shotSlotValues("composition")).toEqual([]);
    expect(shotSlotValues("framing", true)).toContain("low-angle");
    expect(shotSlotValues("movement", true)).toHaveLength(11);
    expect(shotSlotValues("lighting", true)).toHaveLength(13);
    expect(shotSlotValues("composition", true)).toHaveLength(7);
    expect(shotSlotValues("motion", true)).toHaveLength(8);
    expect(SLOT_LABELS.composition).toBe("Composition");
    expect(SLOT_LABELS.motion).toBe("Action");
  });

  it("setShotSlot takes a composer slot only with the composer on", () => {
    const rows = [slotRow()];
    expect(setShotSlot(rows, 0, "composition", "centered")).toBe(rows);
    expect(
      setShotSlot(rows, 0, "composition", "centered", true)[0].shot,
    ).toEqual({ composition: "centered" });
    expect(setShotSlot(rows, 0, "motion", "running", true)[0].shot).toEqual({
      motion: "running",
    });
  });

  it("a photo row's note says what the photo decides and what her sentence carries, with the composer on", () => {
    expect(slotsNote(slotRow({ assetId: "a1" }), true)).toBe(
      "Framing, light, setting and composition come from the photo; what you do is in your sentence.",
    );
    expect(slotsNote(slotRow({ assetId: "a1" }))).toBe(
      "Framing, light and setting come from the photo.",
    );
    expect(slotsNote(slotRow(), true)).toBeNull();
  });

  it("a seed's rhythm rides to the Board, and a seed without one gives null", () => {
    const r = { pace: "fast" as const, matched: "fast cuts", ref: "ref_1" };
    expect(seededRhythm({ rhythm: r })).toEqual(r);
    expect(seededRhythm({})).toBeNull();
    expect(seededRhythm({ rhythm: null })).toBeNull();
  });
});
