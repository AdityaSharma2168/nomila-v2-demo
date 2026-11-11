import {
  countTier,
  inventionLine,
  isRefused,
  makeItCta,
  REFUSED_CTA,
  makeButton,
  money,
  planTotal,
  timecodes,
  type PlanFrame,
} from "./planLogic";

const frame = (
  id: string,
  tier: PlanFrame["tier"],
  costUsd: number,
): PlanFrame => ({
  id,
  assetId: id,
  name: id,
  uri: null,
  tier,
  why: "",
  costUsd,
  label: "",
  note: null,
});

describe("the total", () => {
  it("adds nothing to nothing", () => {
    expect(planTotal([])).toBe(0);
  });

  it("does not leak float arithmetic into the price", () => {
    // 0.1 + 0.2 is 0.30000000000000004 in binary floating point, and a plan must never print that.
    const t = planTotal([
      frame("a", "invented", 0.1),
      frame("b", "invented", 0.2),
    ]);
    expect(t).toBe(0.3);
    expect(money(t)).toBe("$0.30");
  });

  it("stays free when every frame is untouched", () => {
    expect(
      planTotal([frame("a", "untouched", 0), frame("b", "untouched", 0)]),
    ).toBe(0);
  });
});

describe("money", () => {
  it("says free rather than $0.00, because zero is a different fact", () => {
    expect(money(0)).toBe("free");
  });

  it("shows the cent", () => {
    expect(money(0.07)).toBe("$0.07");
    expect(money(0.2)).toBe("$0.20");
  });
});

describe("the invention line", () => {
  it("leads with nothing invented when nothing is touched at all", () => {
    const line = inventionLine([
      frame("a", "untouched", 0),
      frame("b", "untouched", 0),
    ]);
    expect(line.invented).toBe(0);
    expect(line.headline).toBe("Nothing invented · free");
    expect(line.detail).toMatch(/cut and graded/);
  });

  it("still says nothing invented when frames are only fixed", () => {
    // A logo removed is not a fabrication, and conflating the two would make the strongest claim
    // this product can make unavailable whenever anything at all was done.
    const line = inventionLine([
      frame("a", "fixed", 0.04),
      frame("b", "untouched", 0),
    ]);
    expect(line.invented).toBe(0);
    expect(line.headline).toBe("Nothing invented · $0.04");
    expect(line.detail).toMatch(/1 of 2 frame has a fix/);
  });

  it("pluralises the fixed count", () => {
    const line = inventionLine([
      frame("a", "fixed", 0.04),
      frame("b", "fixed", 0.04),
    ]);
    expect(line.detail).toMatch(/2 of 2 frames have a fix/);
  });

  it("leads with the count and the price when anything is invented", () => {
    const line = inventionLine([
      frame("a", "invented", 0.13),
      frame("b", "invented", 0.06),
      frame("c", "untouched", 0),
    ]);
    expect(line.invented).toBe(2);
    expect(line.headline).toBe("2 of 3 frames invented · $0.19");
  });

  it("a refused plan names no price (PR 19, W-6)", () => {
    const frames = [frame("a", "invented", 0.13)];
    expect(inventionLine(frames, { refused: true })).toEqual({
      invented: 1,
      headline: "1 of 1 frames invented",
      detail: "Nothing is priced until this can run.",
    });
    expect(
      inventionLine([frame("a", "fixed", 0.27)], { refused: true }).headline,
    ).toBe("Nothing invented");
    // Not refused: today's line, price and all.
    expect(inventionLine(frames).headline).toBe(
      "1 of 1 frames invented · $0.13",
    );
  });

  it("refused is an ask or a blocker on a plan that cannot run — never one still being checked", () => {
    expect(
      isRefused({ canGenerate: false, askReason: "vague", blockers: [] }),
    ).toBe(true);
    expect(
      isRefused({ canGenerate: false, askReason: null, blockers: ["x"] }),
    ).toBe(true);
    expect(
      isRefused({ canGenerate: false, askReason: null, blockers: [] }),
    ).toBe(false);
    expect(
      isRefused({ canGenerate: true, askReason: null, blockers: [] }),
    ).toBe(false);
  });

  /**
   * ADI-R19-W2: "no path can leave her on a disabled Make it". ⚠️ MUTATION M-noDeadEnd: drop makeItCta's refused
   * branch — this reds by name.
   */
  it("a refused plan's button is never a disabled Make it — it is an enabled way back", () => {
    const plan = {
      jobCostUsd: null,
      canGenerate: false,
      frames: [frame("a", "invented", 0.13)],
    };
    expect(makeItCta(plan, { refused: true, busy: false })).toEqual({
      ...REFUSED_CTA,
      action: "back",
      disabled: false,
    });
    // Still being priced (not refused): today's words, disabled until the price is back.
    expect(makeItCta(plan, { refused: false, busy: false })).toEqual({
      label: "Make it",
      note: "Working out what this needs.",
      action: "make",
      disabled: true,
    });
    // Priced and makeable: today's button.
    expect(
      makeItCta(
        { ...plan, jobCostUsd: 0.13, canGenerate: true },
        { refused: false, busy: false },
      ),
    ).toMatchObject({
      label: "Approve and make it",
      action: "make",
      disabled: false,
    });
  });

  it("has something to say about an empty plan", () => {
    expect(inventionLine([]).headline).toBe("Nothing to make yet");
  });
});

describe("the button", () => {
  it("does not ask for approval when nothing is being spent", () => {
    // Asking to approve a free job teaches her to tap past the one screen that matters.
    const b = makeButton([frame("a", "untouched", 0)]);
    expect(b.label).toBe("Make it — free");
    expect(b.note).toMatch(/nothing to approve/);
  });

  it("asks for approval the moment a model is involved", () => {
    const b = makeButton([frame("a", "invented", 0.13)]);
    expect(b.label).toBe("Approve and make it");
    expect(b.note).toMatch(/only button that spends/);
  });

  it("asks for approval for a fix too, because a fix costs money", () => {
    expect(makeButton([frame("a", "fixed", 0.04)]).label).toBe(
      "Approve and make it",
    );
  });
});

describe("tiers", () => {
  const plan = [
    frame("a", "untouched", 0),
    frame("b", "fixed", 0.04),
    frame("c", "invented", 0.13),
    frame("d", "invented", 0.13),
  ];

  it("counts each tier apart from the others", () => {
    expect(countTier(plan, "untouched")).toBe(1);
    expect(countTier(plan, "fixed")).toBe(1);
    expect(countTier(plan, "invented")).toBe(2);
  });
});

describe("timecodes", () => {
  it("divides the clip evenly", () => {
    expect(timecodes(4, 8)).toEqual([
      { at: 0, dur: 2 },
      { at: 2, dur: 2 },
      { at: 4, dur: 2 },
      { at: 6, dur: 2 },
    ]);
  });

  it("handles a length that does not divide cleanly", () => {
    const tc = timecodes(3, 8);
    expect(tc.map((t) => t.at)).toEqual([0, 2.7, 5.3]);
  });

  it("returns nothing for an empty cut list rather than dividing by zero", () => {
    expect(timecodes(0)).toEqual([]);
    expect(timecodes(-1)).toEqual([]);
  });
});
