/**
 * recorded.test.ts — R1's replies, recorded under interpret/5 on the Q1 frame, through the core as it ships
 * (the interpreter, I.3 fixtures; plan v1 §7, "Recorded replies"). No model is called: the replies ARE the
 * fixture (fixtures/r1.json), recorded by server/scripts/studioInterpreterRecord.ts — Adi's run, ~$0.06.
 * Re-recorded in full for the style vocabulary (V.3), and again for the new-image exit (interpret/5): a reply
 * to one prompt is not evidence about another, however few of its words moved.
 *
 * The properties asserted hardest:
 *
 *   1. A RECORDING ANSWERS ONLY ITS OWN PROMPT VERSION. Bump PROMPT_VERSION and this is red until R1 is
 *      recorded again — a recording never drifts silently under a prompt it did not answer.
 *   2. EVERY RECORDED READING IS PINNED, BY HAND: the proposal's C, or the ask's outcome, sentence by
 *      sentence. A core change that moves any of them is red here, named.
 *   3. EVERY PROPOSAL FREEZES — C with its constraints, as the preview would freeze it.
 *
 * ⚠️ ONE SAMPLE OF THE MODEL, NOT THE MODEL. Two interpret/3 runs on the same frame at temperature 0 read
 * 4 of these 42 sentences to a different outcome, and 9 to a different C (sweep-4 ledger, F-I5). From
 * interpret/3's recording to this one, 11 cells moved — 4 in outcome, 7 in C alone — and every one is the
 * MODEL's reply: each interpret/4 reply reads the same through main's core (c4951e2) as through this one,
 * and this core reads every interpret/3 reply exactly as the table it replaced (sweep-4 ledger, F-L3).
 * What this pins is what the CORE does with these replies — never what the model will say next time.
 *
 * interpret/4 → interpret/5 (sweep-4 ledger, F-I6): an ad's prompt is byte for byte interpret/4's, and every ad
 * call's input tokens are too, 10/10. 34 cells read the same; 4 differ in C alone, all ads — which items the model
 * saw a Nike mark on, and so which suggestion the cap drops — so the prompt had no part in them; 4 differ in
 * outcome, every one a cell that already moved between earlier recordings (F-I5, F-L3). No call answered a new
 * image, and none said `newImage`.
 */
// The freeze's module reads the database at brief assembly; this suite never assembles.
jest.mock("../../db", () => ({
  db: {},
  pool: { end: async () => {}, on: () => {} },
}));

import { readFileSync } from "fs";
import { join } from "path";
import { route } from "../classify";
import { compileNativeInstruction } from "../nativeEdit";
import { freezeEditIntent } from "../nativeIntent";
import { adPlan, adTreatment } from "./ad";
import { frozenConstraints, propose, type InterpretationInput } from "./core";
import { PROMPT_VERSION } from "./prompt";
import type { Recording } from "./recorded";

const recording: Recording = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "r1.json"), "utf8"),
);

/** One recorded call, named as the record script prints it. */
const keyOf = (e: Recording["entries"][number]) =>
  `${e.sentence}${e.brand ? ` [${e.brand} ad]` : ""}${e.objects ? " [1 object]" : ""}`;

/** Each recorded call, as the record script made it: the ad's treatment as the product assembles it. */
const inputOf = (e: Recording["entries"][number]): InterpretationInput => ({
  sentence: e.sentence,
  attached: { objects: e.objects },
  treatment: e.brand ? adTreatment(e.brand, "Athletic Apparel") : null,
  menu: recording.menu,
});

/** Hand-written from this recording through the core at the commit that folded it in. */
/**
 * ─── ⚠️  RE-PINNED AT interpret/6 (wave C card 3). WHAT MOVED, AND WHICH PART WAS THE CARD ──────
 *
 * THE BACKGROUNDS ARE THE CARD, and the result is unambiguous. At interpret/5 every one of the ten ad
 * cells suggested a stadium — nine of them the identical "stadium under bright lights" — across adidas,
 * nike and puma. At interpret/6 NONE of them is a stadium, and the setting now varies BY BRAND:
 *
 *     adidas   modern training facility · training pitch at sunset · urban concrete pitch at dusk
 *     nike     misty training pitch at dawn  (both nike cells, identically)
 *     puma     modern training pitch under floodlights
 *
 * Stable within a brand, different across brands, which is exactly what rule 3a asks for.
 *
 * THE SWAP LISTS AND ONE HEADLINE ALSO MOVED, AND THAT IS NOT THE CARD. Which items a cell swaps comes
 * from `kitSwaps` over `visibleMarks` — what the model reports SEEING on her — and a suggested headline
 * is a suggestion. Neither is touched by this card, and both have moved on every previous re-record
 * (the comments below already said "no cleats mark seen this time"). One sample of the model, as the
 * header says. Do not read a swap-list change here as a rule change.
 */
const EXPECTED: [string, string][] = [
  [
    "turn this into an adidas ad. dont change anything about me [adidas ad]",
    // interpret/6: cleats seen rather than socks this time (variance); the background is the card's.
    'C change my jersey to an adidas jersey, change my cleats to adidas cleats, add the headline "OWN THE PITCH" across the top, and change the background to the modern training facility',
  ],
  [
    "turn this into an ad. dont change anything about me [adidas ad]",
    // interpret/6: two marks seen rather than three, so the cap had room for the suggested background.
    'C change my jersey to an adidas jersey, change my cleats to adidas cleats, add the headline "READY FOR MORE" across the top, and change the background to the modern training facility',
  ],
  [
    "make this an adidas ad [adidas ad]",
    'C change my jersey to an adidas jersey, change my cleats to adidas cleats, add the headline "OWN THE PITCH" across the top, and change the background to the modern training facility',
  ],
  [
    "turn this into a nike ad [nike ad]",
    // interpret/6: nike's own setting, and the SAME one its other cell gets — stable within a brand.
    'C add the headline "RISE TO THE CHALLENGE" across the top, and change the background to the misty training pitch at dawn',
  ],
  [
    "can you turn this into an adidas campaign shot and keep me the same [adidas ad]",
    // interpret/6: two marks seen rather than three, so the background fits under the cap again.
    'C change my jersey to an adidas jersey, change my cleats to adidas cleats, add the headline "OWN THE PITCH" across the top, and change the background to the modern training facility',
  ],
  [
    "turn this into an adidas ad and make it warmer [adidas ad]",
    // interpret/5, C only: the socks' mark seen, so her look and three swaps are four, and the headline dropped.
    "C make it warmer, change my jersey to an adidas jersey, change my socks to adidas socks, and change my cleats to adidas cleats",
  ],
  [
    "turn this into an adidas ad with the headline OWN THE MOMENT [adidas ad]",
    // interpret/6: HER headline stands, as always; two marks seen, so the suggested background fits.
    'C add the headline "OWN THE MOMENT" across the top, change my jersey to an adidas jersey, change my cleats to adidas cleats, and change the background to the urban concrete pitch at dusk',
  ],
  [
    "turn this into a puma ad but dont change my face [puma ad]",
    // Wave-3 fixes (ledger F-I5): the reply's "FOREVER FASTER" is Puma's own slogan, refused and dropped alone —
    // this cell asked `invalid_slot` until then. The swaps and the suggested background stand.
    "C change my jersey to a puma jersey, change my socks to puma socks, change my cleats to puma cleats, and change the background to the modern training pitch under floodlights",
  ],
  [
    "make it look like a nike commercial [nike ad]",
    // interpret/6: a different suggested headline (variance), and nike's own setting again.
    'C add the headline "RISE ABOVE" across the top, and change the background to the misty training pitch at dawn',
  ],
  [
    "turn this into an ad [adidas ad]",
    'C change my jersey to an adidas jersey, change my cleats to adidas cleats, add the headline "READY FOR MORE" across the top, and change the background to the modern training facility',
  ],
  [
    "change my uniform so that its a black adidas uniform. i dont want any nike logos showing in this so if there are any remove them. also make my cleats pink and adidas",
    "C change my uniform to a black adidas uniform, and change my cleats to pink adidas cleats",
  ],
  [
    "change my uniform to black adidas and i dont want any nike logos anywhere",
    "C change my uniform to a black adidas uniform",
  ],
  // interpret/5: one pink adidas swap, as interpret/2 and /3 read it — interpret/4 split a recolour and a swap of the
  // same cleats, which the one-change-per-thing check refuses.
  [
    "make my cleats pink and adidas",
    "C change my cleats to pink adidas cleats",
  ],
  [
    "change my uniform so that its a black adidas uniform",
    "C change my uniform to a black adidas uniform",
  ],
  ["if there are any nike logos remove them", "ASK declined"],
  [
    "no nike logos anywhere please, and make my socks white",
    "C make the socks white",
  ],
  ["give me these gold hoops [1 object]", "C add these gold hoops to my ears"],
  [
    "i dont have earrings in this one, add these gold hoops [1 object]",
    // interpret/6: `negation` where interpret/5 read `uncovered`. NOT this card — a non-ad prompt is
    // byte-identical across the two versions and its hash is pinned as unchanged (prompt.test.ts), so
    // this is the model, reading "i dont have earrings in this one" as the negation it is. Both are
    // asks and she gets the same line either way.
    "ASK negation",
  ],
  ["add these gold hoops [1 object]", "C add these gold hoops to my ears"],
  ["can you give me these earrings [1 object]", "ASK declined"],
  [
    "add small gold hoops to my ears [1 object]",
    "C add these gold hoops to my ears",
  ],
  ["put a baseball cap on my head", "C add a cap on my head"],
  [
    "add a soccer ball between my cleats, keep everything else the same",
    "C add a soccer ball between my cleats",
  ],
  // interpret/5: interpret/4's reading ("change nothing else" as filler, uncovered) — and a stray "source" key on
  // each visible mark, which the strict read refuses first. 1 of 160 interpret/5 replies; she hears the same ask.
  ["make the socks blue and change nothing else", "ASK unparseable"],
  [
    "add a banner that says GET LOUD",
    'C add the headline "GET LOUD" across the top',
  ],
  [
    "put the text OWN IT across the top",
    'C add the headline "OWN IT" across the top',
  ],
  [
    "add the headline OWN THE MOMENT",
    'C add the headline "OWN THE MOMENT" across the top',
  ],
  ["change my red socks to nike", "C change my socks to red nike socks"],
  ["change my jersey to adidas without stripes", "ASK declined"],
  // interpret/5: the same unreadable span, with `decline` false — uncovered, the other of the two asks (F-I5).
  ["make my jersey a nike adidas kit", "ASK uncovered"],
  ["remove the 8 and nike logo", "ASK invalid_slot"],
  ["add a soccer ball", "ASK invalid_slot"],
  [
    "make her jersey blue and give the socks some stripes",
    "C make the jersey blue, and add stripes to the socks",
  ],
  ["switch my jersey over to adidas", "C change my jersey to an adidas jersey"],
  [
    "change the scenery to a beach at sunset",
    "C change the background to the beach at sunset",
  ],
  // interpret/6: `invalid_slot`. This cell is the known 50/50 — scene.json read it invalid_slot at
  // interpret/5 while R1 read it declined, 3 and 3 at n=6 (F-I5). Both are asks, the same line for her.
  // At interpret/6 the two recordings AGREE, which is one more sample of the coin, not a fix.
  ["make it pop", "ASK invalid_slot"],
  // interpret/5: a decline. This cell has read declined, proposed, uncovered, proposed and now declined (F-I5).
  ["i want my jersey in adidas colours", "ASK declined"],
  ["give me a nike swoosh on my shorts", "ASK invalid_slot"],
  [
    "turn my socks into adidas ones please and keep me the same",
    "C change my socks to adidas socks",
  ],
  ["can you make the jersey look vintage", "ASK invalid_slot"],
  ["swap the ball for a basketball", "ASK declined"],
  [
    "change my shoes to adidas and the background to a stadium",
    "C change my shoes to adidas shoes, and change the background to the stadium",
  ],
];

function withDisplayText<T>(fn: () => T): T {
  const saved = process.env.STUDIO_DISPLAY_TEXT;
  process.env.STUDIO_DISPLAY_TEXT = "true";
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.STUDIO_DISPLAY_TEXT;
    else process.env.STUDIO_DISPLAY_TEXT = saved;
  }
}

const readingOf = (e: Recording["entries"][number]) =>
  withDisplayText(() => {
    const out = propose(inputOf(e), e.text, adPlan);
    return out.kind === "proposal"
      ? `C ${out.canonical}`
      : out.kind === "new_image"
        ? "NEW IMAGE"
        : `ASK ${out.outcome}`;
  });

describe("R1, recorded under interpret/6", () => {
  it("answers the prompt version the interpreter ships — re-record R1 when it moves", () => {
    expect(recording.promptVersion).toBe(PROMPT_VERSION);
    expect(PROMPT_VERSION).toBe("interpret/6");
    expect(recording.model).toBe("gemini-3.5-flash");
    // Recorded with a headline on the menu and the exclusion cleared — the menu acceptance runs.
    expect(recording.menu).toEqual({ text: true, exclusion: true });
  });

  it("holds exactly the 42 calls pinned below — none added, none lost", () => {
    expect(recording.entries.map(keyOf)).toEqual(EXPECTED.map(([k]) => k));
  });

  it.each(EXPECTED)("%s", (key, expected) => {
    const e = recording.entries.find((x) => keyOf(x) === key);
    if (!e) throw new Error(`no recorded reply for ${key}`);
    expect(readingOf(e)).toBe(expected);
  });

  it("freezes every proposal — C and its constraints, as the preview would", () => {
    withDisplayText(() => {
      for (const e of recording.entries) {
        const out = propose(inputOf(e), e.text, adPlan);
        if (out.kind !== "proposal") continue;
        // Detection's stand-in: one region per step with a thing in the frame, labelled as detection
        // labels one — a recolour's colour and thing, anything else its thing.
        const regions = route(out.canonical, true, inputOf(e).attached)
          .steps.filter(
            (s) =>
              s.scope === "REGION" &&
              ![
                "ADD_OBJECT",
                "CHANGE_BACKGROUND",
                "GLOBAL_STYLE",
                "DISPLAY_TEXT",
              ].includes(s.op),
          )
          .map((s, i) => ({
            label:
              s.op === "RECOLOR" && s.value
                ? `${s.value} ${s.targets.join(" ")}`
                : s.targets.join(" "),
            left: 400 + i * 700,
            top: 3500,
            width: 600,
            height: 600,
          }));
        const frozen = freezeEditIntent({
          ask: out.canonical,
          origin: "system",
          source: {
            mediaAssetId: "asset-1",
            ref: "athletes/synthetic/frame.jpg",
            width: 4000,
            height: 6000,
            editRegions: regions,
          },
          references: e.objects
            ? [
                {
                  role: "object",
                  ref: "athletes/synthetic/object.jpg",
                  mediaAssetId: "asset-2",
                },
              ]
            : [],
          constraints: frozenConstraints(out.constraints),
        });
        expect({ key: keyOf(e), ok: frozen.ok }).toEqual({
          key: keyOf(e),
          ok: true,
        });
      }
    });
  });

  it("answers no call with a new image — every R1 sentence is an edit or an ad, and none said newImage (the new-image exit)", () => {
    for (const e of recording.entries) {
      expect({ key: keyOf(e), reading: readingOf(e) }).not.toEqual({
        key: keyOf(e),
        reading: "NEW IMAGE",
      });
      expect({
        key: keyOf(e),
        said: /"newImage"\s*:\s*true/.test(e.text),
      }).toEqual({
        key: keyOf(e),
        said: false,
      });
    }
  });

  it("cell 3: the primary phrasing interprets, and the second asks — the tripwire wins", () => {
    const find = (s: string) =>
      recording.entries.find((x) => x.sentence === s && x.objects === 1)!;
    expect(readingOf(find("give me these gold hoops"))).toBe(
      "C add these gold hoops to my ears",
    );
    expect(
      readingOf(find("i dont have earrings in this one, add these gold hoops")),
    ).toMatch(/^ASK /);
  });

  it("swaps only what the reply SAW a competitor's mark on — every ad cell, and nothing for nike on her nike kit (M2)", () => {
    // The kit swap is code's, assembled from the marks the model reports (interpret/ad.ts), never a
    // reflex: which items vary run to run only as the model's perception does (the socks, F-I5). A
    // required swap is never dropped for the cap — the suggested background is.
    withDisplayText(() => {
      const checked: [string, string[]][] = [];
      for (const e of recording.entries.filter((x) => x.brand)) {
        const input = inputOf(e);
        const out = propose(input, e.text, adPlan);
        if (out.kind !== "proposal") continue;
        const marks = JSON.parse(e.text).visibleMarks as {
          brand: string;
          item: string;
        }[];
        const seen = marks
          .filter(
            (m) =>
              input.treatment?.competitors.includes(m.brand) &&
              m.item !== "other",
          )
          .map((m) => m.item);
        const swapped = out.edits
          .filter((x) => x.source === "brand")
          .map((x) => (x.kind === "brand_swap" ? x.item : x.kind));
        expect({ key: keyOf(e), swapped: [...swapped].sort() }).toEqual({
          key: keyOf(e),
          swapped: [...new Set(seen)].sort(),
        });
        checked.push([keyOf(e), swapped]);
      }
      // Hand-written beside the loop: all ten ad cells propose (the puma one since its refused slogan drops alone,
      // F-I5), and the two nike ones swap nothing — the kit on this frame is already nike.
      expect(checked).toHaveLength(10);
      expect(checked.filter(([, s]) => s.length === 0).map(([k]) => k)).toEqual(
        [
          "turn this into a nike ad [nike ad]",
          "make it look like a nike commercial [nike ad]",
        ],
      );
    });
  });

  it("Puma's own slogan still comes back — the deny-list refuses it, it is dropped ALONE, and it reaches no compiled output", () => {
    // interpret/3's prompt forbids a brand's slogan, and interpret/4 and /5 keep that line word for word (an ad's
    // prompt is interpret/4's byte for byte); the model suggested it anyway, in every R1 run so far — five of five,
    // interpret/2 to interpret/5 (F-I5, F-L3, F-I6).
    // The rule's bound (`headlineBound`, the deny-list) is what holds, not the prompt. Until the wave-3 fixes a
    // refused suggestion asked for the WHOLE reply, and she lost her keep and the brand's swaps with it (F-I5's
    // open item). Now the suggestion alone goes — and the regression this pins is that it goes EVERYWHERE: not in
    // C, not in the proposal, not in the frozen intent, not in the instruction the model would be sent.
    const e = recording.entries.find(
      (x) => x.sentence === "turn this into a puma ad but dont change my face",
    )!;
    expect(e.text).toContain("FOREVER FASTER");

    withDisplayText(() => {
      const out = propose(inputOf(e), e.text, adPlan);
      if (out.kind !== "proposal")
        throw new Error(`expected a proposal, got ${JSON.stringify(out)}`);
      // interpret/6: THREE swaps, not two — the model saw a socks mark this time as well as the jersey
      // and cleats. `kitSwaps` is per item over `visibleMarks` and moves between recordings; it is not
      // what this test is about. What this test is about is unchanged: the slogan is refused and dropped
      // ALONE, and every other edit — including the suggested background — survives it.
      expect(out.edits.map((x) => [x.kind, x.source])).toEqual([
        ["brand_swap", "brand"],
        ["brand_swap", "brand"],
        ["brand_swap", "brand"],
        ["background", "suggested"],
      ]);
      // Her keep stands, as hers; the exclusion the ad requires stands, as the brand's.
      expect(out.constraints).toEqual([
        { kind: "preserve_person", source: "yours" },
        { kind: "exclude_marks", brand: "nike", source: "brand" },
      ]);
      expect(JSON.stringify(out)).not.toMatch(/forever faster/i);

      const frozen = freezeEditIntent({
        ask: out.canonical,
        origin: "system",
        source: {
          mediaAssetId: "asset-1",
          ref: "athletes/synthetic/frame.jpg",
          width: 4000,
          height: 6000,
          editRegions: [
            { label: "jersey", left: 400, top: 3500, width: 600, height: 600 },
            { label: "cleats", left: 1100, top: 3500, width: 600, height: 600 },
          ],
        },
        references: [],
        constraints: frozenConstraints(out.constraints),
      });
      if (!frozen.ok)
        throw new Error(
          `expected a frozen intent, got ${JSON.stringify(frozen)}`,
        );
      expect(frozen.intent.changes.map((c) => c.op)).not.toContain(
        "DISPLAY_TEXT",
      );
      expect(JSON.stringify(frozen.intent)).not.toMatch(/forever faster/i);
      expect(compileNativeInstruction(frozen.intent)).not.toMatch(
        /forever faster/i,
      );
    });
  });
});
