/**
 * scene.test.ts — the new-image exit's probe, recorded under interpret/6 on the Q1 frame, through the core as it
 * ships (the new-image exit; sweep-4 ledger F-I6). No model is called: the replies ARE the fixture
 * (fixtures/scene.json) — run 1 of the probe that passed, Adi's run, ~$0.078 for both runs of 56 calls.
 *
 * Four sets, every sentence one that reaches the interpreter today:
 *
 *   A  must-flip   scene sentences — the four interpret/4 read as background edits (F-AM6), and eight that asked
 *   B  controls    twelve R1 cells whose outcome held across interpret/2, /3 and /4
 *   C  catch-alls  auto-mark's edit-shaped sentences the rules cannot read (F-AM1)
 *   D  held out    scene sentences no word of the prompt was fitted to
 *
 * The properties asserted hardest:
 *
 *   1. THE FOUR MISREADS ARE NEW IMAGES — never "change the background to …".
 *   2. NO CONTROL AND NO CATCH-ALL IS A NEW IMAGE, and none said `newImage`: the exit siphons no edit.
 *   3. EVERY CONTROL READS AS R1'S OWN REPLY DOES. "make it pop" is the one that has historically differed —
 *      invalid_slot here and declined there at interpret/5, 3 and 3 at n=6 (F-I5). At interpret/6 both recordings
 *      read it invalid_slot, so they now agree; it is asserted only as an ASK in both, because it is a coin and
 *      pinning either face would make this suite flake on the next re-record.
 *
 * ⚠️ ONE SAMPLE OF THE MODEL, as recorded.test.ts says of R1: what this pins is what the CORE does with these
 * replies. That the prompt makes the model give them was the probe's to measure (8/8 on the four, F-I6).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { route } from "../classify";
import { adPlan } from "./ad";
import { propose, type InterpretationInput } from "./core";
import { interpretableAsk } from "./eligibility";
import { PROMPT_VERSION } from "./prompt";
import type { Recording } from "./recorded";

const load = (name: string): Recording =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));
const scene = load("scene.json");
const r1 = load("r1.json");

type Entry = Recording["entries"][number];
const keyOf = (e: Entry) => `${e.sentence}${e.objects ? " [1 object]" : ""}`;

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

const readingOf = (rec: Recording, e: Entry) =>
  withDisplayText(() => {
    const input: InterpretationInput = {
      sentence: e.sentence,
      attached: { objects: e.objects },
      treatment: null,
      menu: rec.menu,
    };
    const out = propose(input, e.text, adPlan);
    return out.kind === "proposal"
      ? `C ${out.canonical}`
      : out.kind === "new_image"
        ? "NEW IMAGE"
        : `ASK ${out.outcome}`;
  });

const MISREADS = [
  "me on a beach",
  "make me look like im at the beach",
  "picture of me running on a track at sunset",
  "make a pic of me training in the gym",
];

/** Hand-written from this recording through the core at the commit that folded it in. */
const EXPECTED: [string, "A" | "B" | "C" | "D", string][] = [
  ["me on a beach", "A", "NEW IMAGE"],
  ["make me look like im at the beach", "A", "NEW IMAGE"],
  ["picture of me running on a track at sunset", "A", "NEW IMAGE"],
  ["make a pic of me training in the gym", "A", "NEW IMAGE"],
  ["generate pic of me playing soccer", "A", "NEW IMAGE"],
  ["put me mid-air dunking", "A", "NEW IMAGE"],
  ["me dunking in a stadium", "A", "NEW IMAGE"],
  ["a photo of me celebrating a goal in the rain", "A", "NEW IMAGE"],
  ["me holding a trophy on stage", "A", "NEW IMAGE"],
  ["me doing a bicycle kick in a packed stadium", "A", "NEW IMAGE"],
  ["me scoring a header in a cup final", "A", "NEW IMAGE"],
  ["a shot of me stretching before practice", "A", "NEW IMAGE"],
  [
    "change the scenery to a beach at sunset",
    "B",
    "C change the background to the beach at sunset",
  ],
  [
    "change my shoes to adidas and the background to a stadium",
    "B",
    "C change my shoes to adidas shoes, and change the background to the stadium",
  ],
  [
    "switch my jersey over to adidas",
    "B",
    "C change my jersey to an adidas jersey",
  ],
  [
    "make her jersey blue and give the socks some stripes",
    "B",
    "C make the jersey blue, and add stripes to the socks",
  ],
  [
    "no nike logos anywhere please, and make my socks white",
    "B",
    "C make the socks white",
  ],
  [
    "add a soccer ball between my cleats, keep everything else the same",
    "B",
    "C add a soccer ball between my cleats",
  ],
  ["add these gold hoops [1 object]", "B", "C add these gold hoops to my ears"],
  [
    "give me these gold hoops [1 object]",
    "B",
    "C add these gold hoops to my ears",
  ],
  ["put a baseball cap on my head", "B", "C add a cap on my head"],
  ["make it pop", "B", "ASK invalid_slot"],
  ["swap the ball for a basketball", "B", "ASK declined"],
  ["add a soccer ball", "B", "ASK invalid_slot"],
  ["take the logo off my sleeve", "C", "ASK invalid_slot"],
  ["make the sky moodier", "C", "ASK invalid_slot"],
  ["a picture of me surfing a big wave", "D", "NEW IMAGE"],
  ["me signing autographs after the game", "D", "NEW IMAGE"],
  ["me celebrating with my team in the locker room", "D", "NEW IMAGE"],
  ["a photo of me lifting weights", "D", "NEW IMAGE"],
];

/**
 * The recorded sentences a RULE reads since the recording, so the interpreter never sees them — each with the item that
 * claimed it and the operation it routes as. Their recorded readings above stay the recording's truth.
 */
const CLAIMED_BY_RULES = new Map<string, { item: string; op: string }>([
  // Wave A, V2: a worn thing with no place goes where it is worn — the interpreter's own recorded C said the same.
  ["add these gold hoops [1 object]", { item: "V2", op: "ADD_OBJECT" }],
  // Wave A, V3: "pic" is a new-image word — rule 0 claims it, as the interpreter's recorded answer already read it.
  ["make a pic of me training in the gym", { item: "V3", op: "GENERATE" }],
  // Wave A, V4: the two catch-alls the interpreter answered invalid_slot (F-CA2) are the rules' edits now.
  ["take the logo off my sleeve", { item: "V4", op: "REMOVE_OBJECT" }],
  ["make the sky moodier", { item: "V4", op: "RECOLOR" }],
]);

const entryFor = (rec: Recording, key: string) => {
  const e = rec.entries.find((x) => keyOf(x) === key && x.brand === null);
  if (!e) throw new Error(`no recorded reply for ${key}`);
  return e;
};

describe("the new-image exit's probe, recorded under interpret/6", () => {
  it("answers the prompt version the interpreter ships, on R1's model and menu", () => {
    expect(scene.promptVersion).toBe(PROMPT_VERSION);
    expect(PROMPT_VERSION).toBe("interpret/6");
    expect(scene.model).toBe("gemini-3.5-flash");
    expect(scene.menu).toEqual({ text: true, exclusion: true });
    expect(scene.menu).toEqual(r1.menu);
  });

  it("holds exactly the 30 calls pinned below — none added, none lost", () => {
    expect(scene.entries.map(keyOf)).toEqual(EXPECTED.map(([k]) => k));
  });

  it("sends only sentences that reach the interpreter today — a rule that claims one moves it out of this probe's reach (F-I7)", () => {
    withDisplayText(() => {
      for (const e of scene.entries) {
        const routed = route(e.sentence, true, { objects: e.objects });
        const claimed = CLAIMED_BY_RULES.get(keyOf(e));
        expect({
          key: keyOf(e),
          interpretable:
            routed.initialPath === "ASK" && interpretableAsk(routed.reason),
          op: claimed ? routed.steps[0]?.op : undefined,
        }).toEqual({
          key: keyOf(e),
          interpretable: !claimed,
          op: claimed?.op,
        });
      }
    });
  });

  it("claims nothing the recording does not hold", () => {
    for (const key of CLAIMED_BY_RULES.keys()) {
      expect(EXPECTED.map(([k]) => k)).toContain(key);
    }
  });

  it.each(EXPECTED)("%s (%s)", (key, _set, expected) => {
    expect(readingOf(scene, entryFor(scene, key))).toBe(expected);
  });

  it("reads the four interpret/4 misreads as new images — never the background edit (F-AM6)", () => {
    for (const sentence of MISREADS) {
      expect({
        sentence,
        reading: readingOf(scene, entryFor(scene, sentence)),
      }).toEqual({ sentence, reading: "NEW IMAGE" });
    }
  });

  it("reads no control and no catch-all as a new image — and none of them said newImage", () => {
    for (const [key, set] of EXPECTED) {
      if (set !== "B" && set !== "C") continue;
      const e = entryFor(scene, key);
      expect({
        key,
        reading: readingOf(scene, e),
        said: /"newImage"\s*:\s*true/.test(e.text),
      }).toEqual({
        key,
        reading: expect.not.stringMatching(/^NEW IMAGE$/),
        said: false,
      });
    }
  });

  it("reads every control as R1's own reply does — 'make it pop' excepted, a coin that is an ASK either way (F-I5)", () => {
    // ─── WHY "make it pop" IS EXCLUDED RATHER THAN PINNED ────────────────────────────────────────
    //
    // At interpret/5 this assertion read `expect(moved).toEqual(["make it pop"])` — it pinned the fact
    // that the two recordings DISAGREED on exactly that sentence, and that R1's face was "ASK declined".
    // At interpret/6 they agree (both invalid_slot), so that pin is false.
    //
    // Re-pinning it the other way would be worse than leaving it: the cell has read declined, proposed,
    // uncovered, proposed, declined and now invalid_slot across six recordings (F-I5). It is a coin, and
    // a test that pins a coin's face fails on the next re-record for no reason anybody can act on.
    //
    // So the property asserted is the one that is actually TRUE and load-bearing: every other control
    // reads identically across the two recordings, and "make it pop" is an ask in both — which is all
    // that matters to her, since both faces give her the same line.
    const COIN = "make it pop";
    const moved: string[] = [];
    for (const [key, set] of EXPECTED) {
      if (set !== "B" || key === COIN) continue;
      if (
        readingOf(scene, entryFor(scene, key)) !==
        readingOf(r1, entryFor(r1, key))
      ) {
        moved.push(key);
      }
    }
    expect(moved).toEqual([]);
    expect(readingOf(r1, entryFor(r1, COIN))).toMatch(/^ASK /);
    expect(readingOf(scene, entryFor(scene, COIN))).toMatch(/^ASK /);
  });
});
