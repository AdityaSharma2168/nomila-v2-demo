/**
 * The narrator's gate, pool and judge — the three steps between a model's raw copy and what
 * the athlete actually reads.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * These had zero coverage, and captions are about to reuse them. They are also the only thing
 * standing between a language model and a document a brand's partnerships lead sees, which
 * makes them the highest-consequence untested code in the service.
 *
 * The gate enforces the house law that copy may never restate a displayed fact and may never
 * name the athlete — the deck already says those things, and a model repeating them reads as
 * filler. The failure mode is silent: a violating line is not an error, it is just worse copy
 * that ships.
 *
 * ── WHAT IS MOCKED, AND WHY THAT IS HONEST ──────────────────────────────────
 * `applyGate` is exported and pure, so it is tested directly with no mocks at all.
 *
 * `poolOptions` and `judgeOrder` are private, and are deliberately NOT exported just to be
 * testable. They are exercised through `narrateKit`, the real entry point, which is the only
 * thing that proves the three steps compose in the right ORDER — gate each model, then pool,
 * then judge. Testing them in isolation would not catch an ordering mistake.
 *
 * Only the model boundary is faked. `NARRATOR_MODELS=gemini` narrows the bake-off to the one
 * provider that reaches `genai()`, so a single mock serves both the generator and the judge;
 * they are told apart by their prompts, which is how a reader tells them apart too.
 */

const generateContent = jest.fn();
jest.mock("../lib/models", () => ({
  genai: () => ({ models: { generateContent } }),
  GEMINI: { flash: "gemini-test-flash", flashLite: "gemini-test-lite", pro: "gemini-test-pro" },
  KIMI: { vertexModel: "kimi-test", moonshotModel: "kimi-test" },
}));
jest.mock("../logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

// One model only: keeps the bake-off on the mocked Gemini seam and off Anthropic/Kimi.
process.env.NARRATOR_MODELS = "gemini";

import { applyGate, narrateKit, type CardBrief, type KitCopy, type NarratorContext } from "./narrator";

// ─── helpers ────────────────────────────────────────────────────────────────

const brief = (over: Partial<CardBrief> = {}): CardBrief => ({
  card: "cover", label: "Cover", factsShown: [], slots: ["tagline"], intent: "punch", ...over,
});
const kit = (cards: KitCopy["cards"]): KitCopy => ({ cards });

/** A judge reply that picks index 0 everywhere — the identity case. */
const JUDGE_KEEPS_ORDER = JSON.stringify({ cover: { tagline: 0 } });

/** Routes by prompt: the judge announces itself as the EDITOR, the generator does not. */
function respond(gen: unknown, judge: string = JUDGE_KEEPS_ORDER) {
  generateContent.mockImplementation(async (params: any) => {
    const text = params?.contents?.[0]?.parts?.[0]?.text ?? "";
    return { text: text.includes("You are the EDITOR") ? judge : JSON.stringify(gen) };
  });
}

/**
 * A COMPLETE context. Every required field is present on purpose: `buildUserPrompt` reads
 * `signalHighlights` and `brandFitTags` unguarded, so a partial object cast into shape throws
 * inside prompt construction long before any assertion runs. Written out in full rather than
 * cast, so the compiler keeps this honest when the interface grows a field.
 */
const ctx = (): NarratorContext => ({
  name: "Mia Bhuta", sport: "Tennis", school: "Stanford",
  storyArc: "walk-on to starter",
  signalHighlights: ["38% women", "$14,000 in deals"],
  brandFitTags: ["apparel", "wellness"],
  commercial: "active",
});

beforeEach(() => { generateContent.mockReset(); });

// ─── the gate ───────────────────────────────────────────────────────────────

describe("applyGate — what may never reach the athlete", () => {
  it("drops a line that names the athlete, her sport or her school", () => {
    const { copy, report } = applyGate(
      kit([{ card: "cover", tagline: ["Mia plays to win", "Built for the long rally"] }]),
      [brief()],
      { properNouns: ["Mia Bhuta", "Tennis", "Stanford"] },
    );
    expect(copy.cards[0].tagline).toEqual(["Built for the long rally"]);
    expect(report.dropped).toBe(1);
  });

  it("drops a line that restates a number already displayed", () => {
    // The deck shows the figure; copy repeating it is filler, and this is the rule a model
    // told to sound impressive is most likely to break.
    const { copy } = applyGate(
      kit([{ card: "cover", tagline: ["38% women follow her", "An audience that shows up"] }]),
      [brief()],
      { numberSources: ["38% women"] },
    );
    expect(copy.cards[0].tagline).toEqual(["An audience that shows up"]);
  });

  it("drops a line past the slot's length budget", () => {
    // 34 for eyebrow is a real layout constraint, not a style preference: the card clips.
    const { copy } = applyGate(
      kit([{ card: "cover", eyebrow: ["x".repeat(35), "short one"], tagline: ["fine"] }]),
      [brief({ slots: ["eyebrow", "tagline"] })],
    );
    expect(copy.cards[0].eyebrow).toEqual(["short one"]);
  });

  it("no longer filters grade words — the mix card (and its sub-score labels) is retired", () => {
    // Legacy retirement P2-2 (owner decision 1, 8 Oct 2026): "elite"/"strong" were the mix card's sub-score labels.
    // With that card gone they are ordinary words on every card.
    const line = ["An elite return game"];
    const onCover = applyGate(kit([{ card: "cover", tagline: line }]), [brief()]);
    expect(onCover.copy.cards[0].tagline).toEqual(line);
  });

  it("keeps the LEAST-offending line when every option violates, and flags it", () => {
    // The safety valve, and the reason the gate cannot be a plain filter: a card with no copy
    // is a broken deck. Better a flagged line a human can fix than an empty slot.
    const { copy, report } = applyGate(
      kit([{ card: "cover", tagline: ["Mia Bhuta of Stanford Tennis", "Mia arrives"] }]),
      [brief()],
      { properNouns: ["Mia Bhuta", "Tennis", "Stanford"] },
    );
    expect(copy.cards[0].tagline).toEqual(["Mia arrives"]);   // 1 violation beats 3
    expect(report.flagged).toBe(1);
  });

  it("never leaves tagline undefined", () => {
    // tagline is the one REQUIRED slot; the `?? c.tagline` fallback exists for this, and a
    // regression there renders a card with a MISSING line rather than a bad one.
    const { copy } = applyGate(kit([{ card: "cover", tagline: [] }]), [brief()]);
    expect(Array.isArray(copy.cards[0].tagline)).toBe(true);
  });

  it("does not throw on a card the briefs never mentioned", () => {
    // briefs and copy can disagree — a model invents a card, or a brief is dropped. The gate
    // must degrade rather than take a whole kit down over one stray card.
    expect(() => applyGate(kit([{ card: "not-a-card", tagline: ["hello"] }]), [brief()])).not.toThrow();
  });
});

// ─── pool + judge, through the real entry point ─────────────────────────────

describe("narrateKit — gate, then pool, then judge", () => {
  it("dedupes identical options across models, case-insensitively", async () => {
    respond({ cards: [{ card: "cover", tagline: ["Built to last", "built to LAST", "Second wind"] }] });
    const out = await narrateKit(ctx(), [brief()]);
    expect(out?.cards[0].tagline).toEqual(["Built to last", "Second wind"]);
  });

  it("moves the judge's pick to index 0 and keeps the rest as alternates", async () => {
    // Index 0 is what the deck renders; the rest are what she can swap to. Order IS the
    // product here, which is why the judge may rank but never rewrite.
    respond(
      { cards: [{ card: "cover", tagline: ["First", "Second", "Third"] }] },
      JSON.stringify({ cover: { tagline: 2 } }),
    );
    const out = await narrateKit(ctx(), [brief()]);
    expect(out?.cards[0].tagline).toEqual(["Third", "First", "Second"]);
  });

  it("clamps an out-of-range index instead of producing undefined copy", async () => {
    respond(
      { cards: [{ card: "cover", tagline: ["First", "Second"] }] },
      JSON.stringify({ cover: { tagline: 99 } }),
    );
    const out = await narrateKit(ctx(), [brief()]);
    expect(out?.cards[0].tagline[0]).toBe("Second");
    expect(out?.cards[0].tagline).not.toContain(undefined);
  });

  it("falls back to pooled order when the judge returns unparseable JSON", async () => {
    // A judge failure must cost the RANKING, never the copy — she still gets a deck.
    respond({ cards: [{ card: "cover", tagline: ["First", "Second"] }] }, "not json at all");
    const out = await narrateKit(ctx(), [brief()]);
    expect(out?.cards[0].tagline).toEqual(["First", "Second"]);
  });

  it("returns null when every model fails, so the caller templates instead", async () => {
    generateContent.mockRejectedValue(new Error("vertex down"));
    expect(await narrateKit(ctx(), [brief()])).toBeNull();
  });

  it("gates BEFORE pooling — a violating line never becomes an alternate", async () => {
    // The ordering proof. If pooling ran first, the banned line would survive as an option
    // she could select, which is the exact failure this pipeline exists to prevent.
    respond({ cards: [{ card: "cover", tagline: ["Mia Bhuta arrives", "Reads the court early"] }] });
    const out = await narrateKit(ctx(), [brief()]);
    expect(out?.cards[0].tagline).toEqual(["Reads the court early"]);
  });

  it("only pools slots the brief actually declares", async () => {
    // A model returning an eyebrow for a card with no eyebrow slot must not invent one in
    // the layout.
    respond({ cards: [{ card: "cover", eyebrow: ["Unwanted"], tagline: ["Wanted"] }] });
    const out = await narrateKit(ctx(), [brief({ slots: ["tagline"] })]);
    expect(out?.cards[0].eyebrow).toBeUndefined();
  });
});

describe("her confirmed wording (brand_voice.avoid) — a hard drop, never 'least-offending'", () => {
  const AVOID = ["building between two worlds"];
  it("drops any option that uses her avoided wording, keeps the clean ones", () => {
    const { copy } = applyGate(kit([{ card: "cover", tagline: ["Building between two worlds, daily.", "Built for the long season."] }]), [brief()], { avoid: AVOID });
    expect(copy.cards[0].tagline).toEqual(["Built for the long season."]);
  });
  it("when every option uses it, the slot is left EMPTY (the assembler's template is used), not the least-offending line", () => {
    const { copy, report } = applyGate(kit([{ card: "cover", tagline: ["Building between two worlds.", "Still building between two worlds!"] }]), [brief()], { avoid: AVOID });
    expect(copy.cards[0].tagline).toEqual([]);
    expect(report.flagged).toBe(0);
  });
  it("no avoid list → the gate behaves exactly as before", () => {
    const k = kit([{ card: "cover", tagline: ["Building between two worlds."] }]);
    expect(applyGate(k, [brief()]).copy).toEqual(applyGate(k, [brief()], { avoid: [] }).copy);
  });
});
