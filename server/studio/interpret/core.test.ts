/**
 * core.test.ts — the pure interpreter: a reply in, a proposal or an ask out (the interpreter, I.2).
 * No network, no rows: every reply below is hand-written JSON, as a transport would hand it over.
 *
 * Two halves:
 *
 *   1. PROPOSALS — replies to real asks become the canonical sentence C, and C routes.
 *   2. ADVERSARIAL REPLIES — each one aimed at ONE check, and each must ask. This is the fail-closed
 *      proof: a reply that could get past a check would become a preview she can pay for. Every fixture
 *      names the check it bites and asserts the outcome that check returns, so a check switched off is
 *      a red here, not a silent pass through the next one.
 */
import { NOTHING_ATTACHED, route } from "../classify";
import { roundTrip } from "./canonical";
import {
  fitToCap,
  propose,
  provenanceFor,
  type AdTreatment,
  type InterpretationInput,
  type TreatmentPlan,
} from "./core";
import type { SourcedEdit } from "./menu";
import type { FrozenEditIntent } from "../nativeEdit";

// ─── Material ──────────────────────────────────────────────────────────────────────────────────────

const input = (
  sentence: string,
  over: Partial<InterpretationInput> = {},
): InterpretationInput => ({
  sentence,
  attached: NOTHING_ATTACHED,
  treatment: null,
  menu: { text: false, exclusion: false },
  ...over,
});

const ADIDAS: AdTreatment = {
  brand: "adidas",
  category: "Athletic Apparel",
  profile: null,
  register: null,
  swapTo: "adidas",
  competitors: ["nike", "puma"],
};

const span = (
  quote: string,
  reads: string,
  edits: number[] = [],
  constraints: number[] = [],
) => ({ quote, reads, edits, constraints });

const reply = (o: Record<string, unknown>) =>
  JSON.stringify({
    decline: false,
    spans: [],
    edits: [],
    constraints: [],
    visibleMarks: [],
    ...o,
  });

const yours = (e: Record<string, unknown>) => ({ ...e, source: "yours" });
const suggested = (e: Record<string, unknown>) => ({
  ...e,
  source: "suggested",
});

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

/** The four founder-sentence neighbourhoods, and what each one asks today. */
const WORN = "add small gold hoops to my ears";
const PARTIAL = "make her jersey blue and give the socks some stripes";
const SENTENCE_4 =
  "change my uniform so that its a black adidas uniform. i dont want any nike logos showing in this so if there are any remove them. also make my cleats pink and adidas";
const AD_1A = "turn this into an adidas ad. dont change anything about me";
const BRAND = "switch my jersey over to adidas";

describe("today, each of these asks — the only sentences the interpreter ever sees", () => {
  it.each([
    [WORN, { objects: 1 }, "worn_add_unclear"],
    [PARTIAL, NOTHING_ATTACHED, "compound_partial"],
    [SENTENCE_4, NOTHING_ATTACHED, "conditional"],
    [AD_1A, NOTHING_ATTACHED, "brand_change"],
    [BRAND, NOTHING_ATTACHED, "brand_change"],
  ])("%s", (sentence, attached, reason) => {
    expect(route(sentence, true, attached)).toMatchObject({
      initialPath: "ASK",
      reason,
    });
  });
});

// ─── 1. Proposals ──────────────────────────────────────────────────────────────────────────────────

describe("a reply to an ask becomes C — words the rules already read — and C routes", () => {
  it("a worn add she described with a word the rule does not read (M3.8's descriptors)", () => {
    const out = propose(
      input(WORN, { attached: { objects: 1 } }),
      reply({
        spans: [span(WORN, "edit", [0])],
        edits: [
          yours({
            kind: "add",
            thing: "gold hoops",
            preposition: "to",
            place: "my ears",
          }),
        ],
      }),
    );
    expect(out).toMatchObject({
      kind: "proposal",
      canonical: "add these gold hoops to my ears",
      steps: [
        { op: "ADD_OBJECT", targets: ["gold hoops"], value: "to my ears" },
      ],
    });
  });

  it("a compound with one part the rules could not read — the part they read is kept as they read it", () => {
    const out = propose(
      input(PARTIAL),
      reply({
        spans: [
          span("make her jersey blue", "edit", [0]),
          span("and", "filler"),
          span("give the socks some stripes", "edit", [1]),
        ],
        edits: [
          yours({ kind: "recolor", target: "jersey", colour: "blue" }),
          yours({ kind: "design", design: "stripes", target: "socks" }),
        ],
      }),
    );
    expect(out).toMatchObject({
      kind: "proposal",
      canonical: "make the jersey blue, and add stripes to the socks",
    });
  });

  it("sentence 4 — two swaps of hers, and the conditional as an exclusion, never a removal (F-R)", () => {
    const out = propose(
      input(SENTENCE_4, { menu: { text: false, exclusion: true } }),
      reply({
        spans: [
          span("change my uniform so that its a black adidas uniform", "edit", [
            0,
          ]),
          span(
            "i dont want any nike logos showing in this so if there are any remove them",
            "constraint",
            [],
            [0],
          ),
          span("also", "filler"),
          span("make my cleats pink and adidas", "edit", [1]),
        ],
        edits: [
          yours({
            kind: "brand_swap",
            item: "uniform",
            descriptors: ["black"],
            brand: "adidas",
          }),
          yours({
            kind: "brand_swap",
            item: "cleats",
            descriptors: ["pink"],
            brand: "adidas",
          }),
        ],
        constraints: [{ kind: "exclude_marks", brand: "nike" }],
      }),
    );
    expect(out).toMatchObject({
      kind: "proposal",
      canonical:
        "change my uniform to a black adidas uniform, and change my cleats to pink adidas cleats",
      constraints: [{ kind: "exclude_marks", brand: "nike", source: "yours" }],
    });
  });

  it("an ad — our headline and background as suggestions, her person kept, no look (M6)", () => {
    const out = withDisplayText(() =>
      propose(
        input(AD_1A, {
          treatment: ADIDAS,
          menu: { text: true, exclusion: false },
        }),
        reply({
          spans: [
            span("turn this into an adidas ad.", "treatment"),
            span("dont change anything about me", "constraint", [], [0]),
          ],
          edits: [
            suggested({ kind: "text", content: "OWN THE MOMENT" }),
            suggested({ kind: "background", setting: "stadium at night" }),
          ],
          constraints: [{ kind: "preserve_person" }],
          visibleMarks: [{ brand: "nike", item: "jersey" }],
        }),
      ),
    );
    expect(out).toMatchObject({
      kind: "proposal",
      canonical:
        'add the headline "OWN THE MOMENT" across the top, and change the background to the stadium at night',
      constraints: [{ kind: "preserve_person", source: "yours" }],
      visibleMarks: [{ brand: "nike", item: "jersey" }],
    });
  });

  it("an ad keeps her even when she did not say so — preserve_person, ours to suggest", () => {
    const out = propose(
      input("turn this into an adidas ad", { treatment: ADIDAS }),
      reply({
        spans: [span("turn this into an adidas ad", "treatment")],
        edits: [suggested({ kind: "background", setting: "stadium at night" })],
      }),
    );
    expect(out).toMatchObject({
      kind: "proposal",
      constraints: [{ kind: "preserve_person", source: "suggested" }],
    });
  });

  it("a brand change the rules could not read — rule 4c's canonical shape", () => {
    const out = propose(
      input(BRAND),
      reply({
        spans: [span(BRAND, "edit", [0])],
        edits: [
          yours({
            kind: "brand_swap",
            item: "jersey",
            descriptors: [],
            brand: "adidas",
          }),
        ],
      }),
    );
    expect(out).toMatchObject({
      kind: "proposal",
      canonical: "change my jersey to an adidas jersey",
    });
  });
});

describe("a newly valid look round-trips — the menu reads the rules' widened list (style vocabulary, V.3)", () => {
  // Acceptance cell 4. Rule 5¾ reads only a sentence that is wholly a look, so her keep makes this ask —
  // an ask the interpreter may take — and the look and "keep me" both come back.
  const MOODY_KEEP = "make it moodier, dont change anything about me";

  it("asks today, with a code the interpreter may take", () => {
    expect(route(MOODY_KEEP, true)).toMatchObject({
      initialPath: "ASK",
      reason: "fast_path_declined",
    });
  });

  it("reads 'moodier' and her keep: C is 'make it moodier', which rule 5¾ routes, and preserve_person rides beside it", () => {
    const out = propose(
      input(MOODY_KEEP),
      reply({
        spans: [
          span("make it moodier,", "edit", [0]),
          span("dont change anything about me", "constraint", [], [0]),
        ],
        edits: [yours({ kind: "look", term: "moodier" })],
        constraints: [{ kind: "preserve_person" }],
      }),
    );
    expect(out).toMatchObject({
      kind: "proposal",
      canonical: "make it moodier",
      steps: [
        {
          op: "GLOBAL_STYLE",
          targets: [],
          value: "moodier",
          scope: "GLOBAL",
        },
      ],
      constraints: [{ kind: "preserve_person", source: "yours" }],
    });
  });

  it("keeps her own word for a look: 'moody' stays 'moody' in C, so M6's check reads it as it is", () => {
    const S = "give it a moody vibe and keep me the same";
    expect(route(S, true).initialPath).toBe("ASK");
    const out = propose(
      input(S),
      reply({
        spans: [
          span("give it a moody vibe", "edit", [0]),
          span("and", "filler"),
          span("keep me the same", "constraint", [], [0]),
        ],
        edits: [yours({ kind: "look", term: "moody" })],
        constraints: [{ kind: "preserve_person" }],
      }),
    );
    expect(out).toMatchObject({
      kind: "proposal",
      canonical: "make it moody",
      steps: [{ op: "GLOBAL_STYLE", value: "moody" }],
    });
    // The look's name for it is not her word, so a reply that swapped it in is not hers (M6).
    expect(
      propose(
        input(S),
        reply({
          spans: [
            span("give it a moody vibe", "edit", [0]),
            span("and", "filler"),
            span("keep me the same", "constraint", [], [0]),
          ],
          edits: [yours({ kind: "look", term: "moodier" })],
          constraints: [{ kind: "preserve_person" }],
        }),
      ),
    ).toMatchObject({ kind: "ask", outcome: "invalid_slot" });
  });
});

// ─── 2. Adversarial replies — each bites ONE check ─────────────────────────────────────────────────

describe("an adversarial reply never becomes a proposal — each is caught by the check it is aimed at", () => {
  const one = (edit: Record<string, unknown>, sentence = BRAND) =>
    reply({ spans: [span(sentence, "edit", [0])], edits: [yours(edit)] });

  it("SCHEMA — GENERATE, an unknown kind, 'brand' as a source, a constraint carrying a step, a non-brand exclusion", () => {
    for (const bad of [
      one({ kind: "generate" }),
      one({
        kind: "recolor",
        target: "jersey",
        colour: "blue",
        op: "REMOVE_OBJECT",
      }),
      reply({
        spans: [span(BRAND, "edit", [0])],
        edits: [
          {
            kind: "brand_swap",
            item: "jersey",
            brand: "adidas",
            source: "brand",
          },
        ],
      }),
      reply({
        spans: [span(BRAND, "constraint", [], [0])],
        constraints: [
          { kind: "preserve_person", op: "REMOVE_OBJECT", targets: ["jersey"] },
        ],
      }),
      reply({
        spans: [span(BRAND, "constraint", [], [0])],
        constraints: [{ kind: "exclude_marks", brand: "the person" }],
      }),
      "not json at all",
      "```json\n{}\n```",
    ]) {
      expect(propose(input(BRAND), bad)).toEqual({
        kind: "ask",
        outcome: "unparseable",
        askReason: null,
      });
    }
  });

  it("DECLINE — the model may say no", () => {
    expect(propose(input(BRAND), reply({ decline: true }))).toMatchObject({
      outcome: "declined",
    });
  });

  const FIVE =
    "recolor it all: jersey blue, socks red, shorts white, cleats black, cap green";
  const fiveSpans = [
    "recolor it all: jersey blue",
    "socks red",
    "shorts white",
    "cleats black",
    "cap green",
  ];
  const fiveEdits = [
    ["jersey", "blue"],
    ["socks", "red"],
    ["shorts", "white"],
    ["cleats", "black"],
    ["cap", "green"],
  ].map(([target, colour]) => yours({ kind: "recolor", target, colour }));

  it("THE CAP — five changes of hers ask; it never keeps four and drops one", () => {
    const out = propose(
      input(FIVE),
      reply({
        spans: fiveSpans.map((q, i) => span(q, "edit", [i])),
        edits: fiveEdits,
      }),
    );
    expect(out).toEqual({
      kind: "ask",
      outcome: "too_many_changes",
      askReason: "too_many_changes",
    });
  });

  it("COVERAGE — four edits for a five-change sentence: the fifth is unread, so it asks", () => {
    const out = propose(
      input(FIVE),
      reply({
        spans: fiveSpans.slice(0, 4).map((q, i) => span(q, "edit", [i])),
        edits: fiveEdits.slice(0, 4),
      }),
    );
    expect(out).toMatchObject({ outcome: "uncovered" });
  });

  it("COVERAGE — a quote that is not her words", () => {
    expect(
      propose(
        input(BRAND),
        reply({
          spans: [span("switch my jersey to adidas", "edit", [0])],
          edits: [
            yours({
              kind: "brand_swap",
              item: "jersey",
              descriptors: [],
              brand: "adidas",
            }),
          ],
        }),
      ),
    ).toMatchObject({ outcome: "uncovered" });
  });

  it("COVERAGE — a change laundered as filler, an unreadable part, an edit of hers with no quote", () => {
    const S = "make the jersey blue and remove the ball";
    expect(
      propose(
        input(S),
        reply({
          spans: [
            span("make the jersey blue", "edit", [0]),
            span("and remove the ball", "filler"),
          ],
          edits: [yours({ kind: "recolor", target: "jersey", colour: "blue" })],
        }),
      ),
    ).toMatchObject({ outcome: "uncovered" });
    expect(
      propose(
        input(S),
        reply({
          spans: [
            span("make the jersey blue", "edit", [0]),
            span("and remove the ball", "unreadable"),
          ],
          edits: [yours({ kind: "recolor", target: "jersey", colour: "blue" })],
        }),
      ),
    ).toMatchObject({ outcome: "uncovered" });
    expect(
      propose(
        input(S),
        reply({
          spans: [span(S, "edit", [0])],
          edits: [
            yours({ kind: "recolor", target: "jersey", colour: "blue" }),
            yours({ kind: "remove", target: "ball" }),
          ],
        }),
      ),
    ).toMatchObject({ outcome: "uncovered" });
  });

  it("COVERAGE — a treatment where the ad gate found none", () => {
    expect(
      propose(
        input("turn this into an adidas ad"),
        reply({
          spans: [span("turn this into an adidas ad", "treatment")],
          edits: [suggested({ kind: "background", setting: "stadium" })],
        }),
      ),
    ).toMatchObject({ outcome: "uncovered" });
  });

  it("TRIPWIRE — a negation inside an edit: dropping 'without stripes' would give her the stripes", () => {
    const S = "change my jersey to adidas without stripes";
    expect(
      propose(
        input(S),
        one(
          {
            kind: "brand_swap",
            item: "jersey",
            descriptors: [],
            brand: "adidas",
          },
          S,
        ),
      ),
    ).toMatchObject({ outcome: "negation" });
  });

  it("SLOTS — her body, a joiner smuggled into a target, a colour off the list, over-long values", () => {
    for (const edit of [
      { kind: "recolor", target: "arms", colour: "blue" },
      { kind: "recolor", target: "jersey and ball", colour: "blue" },
      { kind: "recolor", target: "jersey", colour: "sparkly" },
      { kind: "recolor", target: "one big long target", colour: "blue" },
      {
        kind: "background",
        setting: "stadium at night under the floodlights here",
      },
      { kind: "background", setting: "stadium with her in it" },
    ]) {
      expect({ edit, out: propose(input(BRAND), one(edit)) }).toMatchObject({
        edit,
        out: { outcome: "invalid_slot" },
      });
    }
  });

  it("SLOTS — a pointed swap with no Object photo attached", () => {
    const S = "change my earrings to these gold hoops";
    expect(
      propose(
        input(S),
        one(
          { kind: "pointed_swap", target: "earrings", what: "gold hoops" },
          S,
        ),
      ),
    ).toMatchObject({ outcome: "invalid_slot" });
  });

  it("SLOTS — two backgrounds: a photograph has one", () => {
    const S = "change the background to a beach and a stadium";
    expect(
      propose(
        input(S),
        reply({
          spans: [span(S, "edit", [0, 1])],
          edits: [
            yours({ kind: "background", setting: "beach" }),
            yours({ kind: "background", setting: "stadium" }),
          ],
        }),
      ),
    ).toMatchObject({ outcome: "invalid_slot" });
  });

  it("SLOTS (M6) — a look we suggest, and a look whose term is not in her words", () => {
    expect(
      propose(
        input(AD_1A, { treatment: ADIDAS }),
        reply({
          spans: [
            span("turn this into an adidas ad.", "treatment"),
            span("dont change anything about me", "constraint", [], [0]),
          ],
          edits: [suggested({ kind: "look", term: "warmer" })],
          constraints: [{ kind: "preserve_person" }],
        }),
      ),
    ).toMatchObject({ outcome: "invalid_slot" });
    const S = "make it feel like summer";
    expect(
      propose(input(S), one({ kind: "look", term: "warmer" }, S)),
    ).toMatchObject({ outcome: "invalid_slot" });
  });

  it("SLOTS (the style vocabulary) — a look whose words name a thing: 'make the jersey look vintage' is not a whole-photo look", () => {
    // R1's reply to this sentence reached for "vintage" as a nike swap (M6 refused the brand). With
    // "vintage" on the menu, a whole-photo look would pass every other check and grade her, the grass and
    // the sky for a jersey. Her words for a look must be wholly one (studio/lookVocab.ts).
    for (const [S, quote, term] of [
      [
        "can you make the jersey look vintage",
        "make the jersey look vintage",
        "vintage",
      ],
      ["make the sky dramatic", "make the sky dramatic", "dramatic"],
      ["make my face softer", "make my face softer", "softer"],
    ]) {
      const filler = S.slice(0, S.indexOf(quote)).trim();
      const out = propose(
        input(S),
        reply({
          spans: [
            ...(filler ? [span(filler, "filler")] : []),
            span(quote, "edit", [0]),
          ],
          edits: [yours({ kind: "look", term })],
        }),
      );
      expect({ S, out }).toMatchObject({
        S,
        out: { kind: "ask", outcome: "invalid_slot" },
      });
    }
  });

  it("SLOTS — a brand swap the model suggests, or one naming a brand she never named", () => {
    expect(
      propose(
        input(AD_1A, { treatment: ADIDAS }),
        reply({
          spans: [
            span("turn this into an adidas ad.", "treatment"),
            span("dont change anything about me", "constraint", [], [0]),
          ],
          edits: [
            suggested({
              kind: "brand_swap",
              item: "jersey",
              descriptors: [],
              brand: "adidas",
            }),
          ],
          constraints: [{ kind: "preserve_person" }],
        }),
      ),
    ).toMatchObject({ outcome: "invalid_slot" });
    expect(
      propose(
        input(BRAND),
        one({
          kind: "brand_swap",
          item: "jersey",
          descriptors: [],
          brand: "nike",
        }),
      ),
    ).toMatchObject({ outcome: "invalid_slot" });
  });

  it("SLOTS — a headline over the rule's bounds, a tagline, a brand's name, or with the switch off", () => {
    const S = 'put "X" at the top';
    const on = { menu: { text: true, exclusion: false } };
    for (const content of [
      "WE RUN THIS CITY TONIGHT",
      "JUST DO IT",
      "ADIDAS FOREVER",
    ]) {
      const said = `put "${content}" at the top`;
      expect({
        content,
        out: propose(input(said, on), one({ kind: "text", content }, said)),
      }).toMatchObject({ content, out: { outcome: "invalid_slot" } });
    }
    expect(
      propose(
        input('put "X" at the top'),
        one({ kind: "text", content: "X" }, S),
      ),
    ).toMatchObject({ outcome: "invalid_slot" });
  });

  it("SLOTS (M3) — a worn add outside its thing's places, and a body modification", () => {
    const LIP = "stick a ring on my lip";
    expect(
      propose(
        input(LIP),
        one(
          { kind: "add", thing: "ring", preposition: "on", place: "my lip" },
          LIP,
        ),
      ),
    ).toMatchObject({ outcome: "invalid_slot" });
    const TAT = "give me a tattoo on my arm";
    expect(
      propose(
        input(TAT),
        one(
          { kind: "add", thing: "tattoo", preposition: "on", place: "my arm" },
          TAT,
        ),
      ),
    ).toMatchObject({ outcome: "invalid_slot" });
  });

  it("EXCLUSION — asks until R2 clears it (M4's engineering gate)", () => {
    const out = propose(
      input(SENTENCE_4),
      reply({
        spans: [
          span("change my uniform so that its a black adidas uniform", "edit", [
            0,
          ]),
          span(
            "i dont want any nike logos showing in this so if there are any remove them",
            "constraint",
            [],
            [0],
          ),
          span("also", "filler"),
          span("make my cleats pink and adidas", "edit", [1]),
        ],
        edits: [
          yours({
            kind: "brand_swap",
            item: "uniform",
            descriptors: ["black"],
            brand: "adidas",
          }),
          yours({
            kind: "brand_swap",
            item: "cleats",
            descriptors: ["pink"],
            brand: "adidas",
          }),
        ],
        constraints: [{ kind: "exclude_marks", brand: "nike" }],
      }),
    );
    expect(out).toMatchObject({ outcome: "exclusion_uncleared" });
  });

  it("FIRST CLAIM — the rules read 'make her jersey blue'; a reply re-reading it, all in her words, asks", () => {
    // Every word is hers and every slot is in bounds, so no other check sees it: one span reads the
    // whole sentence as the SOCKS blue and stripes on the JERSEY. C routes; the rules' own reading of
    // "make her jersey blue" is missing from it.
    const out = propose(
      input(PARTIAL),
      reply({
        spans: [span(PARTIAL, "edit", [0, 1])],
        edits: [
          yours({ kind: "recolor", target: "socks", colour: "blue" }),
          yours({ kind: "design", design: "stripes", target: "jersey" }),
        ],
      }),
    );
    expect(out).toMatchObject({ outcome: "first_claim" });
  });

  it("ROUND TRIP — a headline whose own words split C into clauses no rule reads that way", () => {
    // Every slot is in bounds and each clause routes alone; only C, read whole, comes back different:
    // "…AND MAKE IT" inside her quotes is a joiner and a verb to rule ½.
    const S = 'make it warmer and put "RUN AND MAKE IT" at the top';
    const out = withDisplayText(() =>
      propose(
        input(S, { menu: { text: true, exclusion: false } }),
        reply({
          spans: [
            span("make it warmer", "edit", [0]),
            span("and", "filler"),
            span('put "RUN AND MAKE IT" at the top', "edit", [1]),
          ],
          edits: [
            yours({ kind: "look", term: "warmer" }),
            yours({ kind: "text", content: "RUN AND MAKE IT" }),
          ],
        }),
      ),
    );
    expect(out).toMatchObject({ outcome: "round_trip_mismatch" });
  });

  it("ROUND TRIP — each clause must MEAN its edit: a slot the rules read as something else asks", () => {
    // The slot checks refuse both before C exists (menu.ts); the round trip refuses them again after, so
    // neither check is the only one. Measured at $0: each clause routes — as something else.
    expect(
      roundTrip(
        [{ kind: "recolor", target: "jersey and socks", colour: "blue" }],
        NOTHING_ATTACHED,
      ),
    ).toEqual({ ok: false, outcome: "round_trip_mismatch" }); // the jersey alone
    expect(
      roundTrip(
        [{ kind: "recolor", target: "background", colour: "blue" }],
        NOTHING_ATTACHED,
      ),
    ).toEqual({ ok: false, outcome: "round_trip_mismatch" }); // a background change
  });

  it("⚠️ ROUND TRIP — two recolours survive card 2's per-target colours", () => {
    // C renders a recolour as "make the <target> <colour>", so a sentence of only recolours gives every
    // target a colour of its own and rule 5 pairs them — exactly as it would for the same sentence
    // typed. `stepKey` compares `values`, so a `whole` that did not predict them would fail EVERY
    // multi-recolour round trip and take the interpreter's answer down with it. The prediction is made
    // by CALLING the classifier's reader, never by copying rule 5's expression a second time.
    const trip = roundTrip(
      [
        { kind: "recolor", target: "jersey", colour: "red" },
        { kind: "recolor", target: "shorts", colour: "black" },
      ],
      NOTHING_ATTACHED,
    );
    expect(trip).toMatchObject({
      ok: true,
      canonical: "make the jersey red, and make the shorts black",
    });
    expect(trip.ok && trip.routed.steps).toEqual([
      {
        op: "RECOLOR",
        targets: ["jersey", "shorts"],
        value: "red",
        scope: "REGION",
        values: ["red", "black"],
      },
    ]);
  });

  it("ROUND TRIP — C asking on a guard answers with C's own code, the truer line", () => {
    expect(
      roundTrip(
        [{ kind: "recolor", target: "arm", colour: "red" }],
        NOTHING_ATTACHED,
      ),
    ).toEqual({ ok: false, outcome: "guarded", code: "person_target" });
    expect(
      roundTrip(
        [{ kind: "pointed_swap", target: "earrings", what: "gold hoops" }],
        NOTHING_ATTACHED,
      ),
    ).toEqual({ ok: false, outcome: "guarded", code: "object_photo_missing" });
  });
});

// ─── The cap, by priority (v2 §4, C-2) ─────────────────────────────────────────────────────────────

describe("fitting four — her changes, then the brand's, then a headline, then a background", () => {
  const e = (kind: string, n = 0): SourcedEdit =>
    ({
      kind: "remove",
      target: `${kind} ${n}`,
      source: kind === "hers" ? "yours" : "brand",
    }) as SourcedEdit;
  const headline = {
    kind: "text",
    content: "OWN IT",
    source: "suggested",
  } as SourcedEdit;
  const background = {
    kind: "background",
    setting: "stadium",
    source: "suggested",
  } as SourcedEdit;

  it("drops the background first, then the headline", () => {
    expect(
      fitToCap(
        [e("hers")],
        [e("brand", 1), e("brand", 2)],
        headline,
        background,
      ),
    ).toEqual([e("hers"), e("brand", 1), e("brand", 2), headline]);
    expect(
      fitToCap(
        [e("hers")],
        [e("brand", 1), e("brand", 2), e("brand", 3)],
        headline,
        background,
      ),
    ).toEqual([e("hers"), e("brand", 1), e("brand", 2), e("brand", 3)]);
    expect(fitToCap([], [e("brand", 1)], headline, background)).toEqual([
      e("brand", 1),
      headline,
      background,
    ]);
  });

  it("asks when her changes and the brand's required swaps alone pass four — none is dropped", () => {
    expect(
      fitToCap(
        [e("hers"), e("hers", 1)],
        [e("brand", 1), e("brand", 2), e("brand", 3)],
        null,
        null,
      ),
    ).toBeNull();
    expect(
      fitToCap(
        [],
        [1, 2, 3, 4, 5].map((n) => e("brand", n)),
        null,
        null,
      ),
    ).toBeNull();
  });

  it("says too many in an ad's own words when the ad's plan passes four", () => {
    const required = [1, 2, 3, 4, 5].map(
      (n): SourcedEdit => ({
        kind: "brand_swap",
        item: ["jersey", "shorts", "socks", "cleats", "cap"][n - 1],
        descriptors: [],
        brand: "adidas",
        source: "brand",
      }),
    );
    const plan = (): TreatmentPlan => ({
      required,
      headline: null,
      background: null,
    });
    expect(
      propose(
        input(AD_1A, { treatment: ADIDAS }),
        reply({
          spans: [
            span("turn this into an adidas ad.", "treatment"),
            span("dont change anything about me", "constraint", [], [0]),
          ],
          constraints: [{ kind: "preserve_person" }],
        }),
        plan,
      ),
    ).toEqual({
      kind: "ask",
      outcome: "too_many_changes",
      askReason: "ad_too_many_changes",
    });
  });
});

// ─── Provenance for the card ───────────────────────────────────────────────────────────────────────

describe("provenance tags the frozen changes from the edits that made them — never their words", () => {
  it("tags each change and constraint, and carries a brand swap's reason", () => {
    const edits: SourcedEdit[] = [
      {
        kind: "brand_swap",
        item: "jersey",
        descriptors: [],
        brand: "adidas",
        source: "brand",
        reason: { brand: "adidas", away: ["nike"] },
      },
      { kind: "text", content: "OWN THE MOMENT", source: "suggested" },
    ];
    const intent = {
      version: 2,
      initialPath: "FULL_IMAGE",
      steps: [],
      changes: [
        { op: "REPLACE_OBJECT", target: "jersey", change: "adidas jersey" },
        { op: "DISPLAY_TEXT", target: null, change: "OWN THE MOMENT" },
      ],
      imageSize: "2K",
      constraints: [{ kind: "preserve_person" }],
    } as FrozenEditIntent;
    expect(
      provenanceFor(intent, {
        kind: "proposal",
        canonical: "",
        edits,
        constraints: [{ kind: "preserve_person", source: "yours" }],
        spans: [],
        visibleMarks: [],
        steps: [],
      }),
    ).toEqual({
      changes: [
        { source: "brand", reason: { brand: "adidas", away: ["nike"] } },
        { source: "suggested" },
      ],
      constraints: ["yours"],
    });
  });
});

// ─── "Your words" must be true ─────────────────────────────────────────────────────────────────────

describe("an edit of hers holds only her words — the one exception is a worn thing's own place (M3)", () => {
  const S = "make it pop";
  it("asks when a reply gives her a change to something she never named", () => {
    expect(
      propose(
        input(S),
        reply({
          spans: [span(S, "edit", [0])],
          edits: [yours({ kind: "recolor", target: "jersey", colour: "red" })],
        }),
      ),
    ).toMatchObject({ outcome: "invalid_slot" });
  });

  it("asks when a reply invents where an add goes — the model never picks the spot (D2)", () => {
    const ADD = "add a soccer ball";
    expect(
      propose(
        input(ADD),
        reply({
          spans: [span(ADD, "edit", [0])],
          edits: [
            yours({
              kind: "add",
              thing: "soccer ball",
              preposition: "at",
              place: "my feet",
            }),
          ],
        }),
      ),
    ).toMatchObject({ outcome: "invalid_slot" });
  });

  it("reads 'give me these gold hoops' as hers, in her ears — earrings are worn there (cell 3)", () => {
    const GIVE = "give me these gold hoops";
    expect(
      propose(
        input(GIVE, { attached: { objects: 1 } }),
        reply({
          spans: [span(GIVE, "edit", [0])],
          edits: [
            yours({
              kind: "add",
              thing: "gold hoops",
              preposition: "to",
              place: "my ears",
            }),
          ],
        }),
      ),
    ).toMatchObject({
      kind: "proposal",
      canonical: "add these gold hoops to my ears",
    });
  });

  it("asks cell 3's second phrasing under EVERY reading — the tripwire wins (Adi, 2026-09-14)", () => {
    // "i dont have earrings in this one": its "dont" describes the photo, and nothing may tell that from
    // "dont change". Filler cannot hold it, an edit cannot carry a negation, and it keeps nothing.
    const S = "i dont have earrings in this one, add these gold hoops";
    const add = yours({
      kind: "add",
      thing: "gold hoops",
      preposition: "to",
      place: "my ears",
    });
    const ONE = { objects: 1 };
    const tail = span("add these gold hoops", "edit", [0]);
    const head = "i dont have earrings in this one,";
    const outcome = (spans: unknown[], constraints: unknown[] = []) =>
      propose(
        input(S, { attached: ONE }),
        reply({ spans, edits: [add], constraints }),
      );
    expect(outcome([span(head, "filler"), tail])).toMatchObject({
      outcome: "uncovered",
    });
    expect(outcome([span(S, "edit", [0])])).toMatchObject({
      outcome: "negation",
    });
    expect(
      outcome(
        [span(head, "constraint", [], [0]), tail],
        [{ kind: "preserve_person" }],
      ),
    ).toMatchObject({ outcome: "invalid_slot" });
    // The primary phrasing still interprets — the test above ("give me these gold hoops").
  });

  it("reads 'keep everything else the same' as keeping her too (v1 §5)", () => {
    const KEEP =
      "add a soccer ball between my cleats, keep everything else the same";
    const out = propose(
      input(KEEP),
      reply({
        spans: [
          span("add a soccer ball between my cleats", "edit", [0]),
          span("keep everything else the same", "constraint", [], [0]),
        ],
        edits: [
          yours({
            kind: "add",
            thing: "soccer ball",
            preposition: "between",
            place: "my cleats",
          }),
        ],
        constraints: [{ kind: "preserve_person" }],
      }),
    );
    expect(out).toMatchObject({
      kind: "proposal",
      canonical: "add a soccer ball between my cleats",
      constraints: [{ kind: "preserve_person", source: "yours" }],
    });
  });
});

describe("'but' joins like 'and' — and still cannot carry a change (R1)", () => {
  const PUMA = "turn this into a puma ad but dont change my face";
  const PUMA_AD = { ...ADIDAS, brand: "puma", swapTo: "puma" };

  it("reads a treatment, a 'but', and her keep", () => {
    const out = propose(
      input(PUMA, { treatment: PUMA_AD }),
      reply({
        spans: [
          span("turn this into a puma ad", "treatment"),
          span("but", "filler"),
          span("dont change my face", "constraint", [], [0]),
        ],
        edits: [suggested({ kind: "background", setting: "stadium at night" })],
        constraints: [{ kind: "preserve_person" }],
      }),
    );
    expect(out).toMatchObject({
      kind: "proposal",
      constraints: [{ kind: "preserve_person", source: "yours" }],
    });
  });

  it("never lets 'but not the socks' be filler", () => {
    const S = "make the jersey blue but not the socks";
    expect(
      propose(
        input(S),
        reply({
          spans: [
            span("make the jersey blue", "edit", [0]),
            span("but not the socks", "filler"),
          ],
          edits: [yours({ kind: "recolor", target: "jersey", colour: "blue" })],
        }),
      ),
    ).toMatchObject({ outcome: "uncovered" });
  });
});

// ─── A refused suggestion is dropped alone (ledger F-I5, wave-3 fixes) ─────────────────────────────

describe("a suggestion the rules refuse is dropped ALONE — the rest of the reply stands (ledger F-I5)", () => {
  const PUMA = "turn this into a puma ad but dont change my face";
  const PUMA_AD = { ...ADIDAS, brand: "puma", swapTo: "puma" };
  const TEXT_ON = { menu: { text: true, exclusion: false } };
  const pumaReply = (edits: unknown[]) =>
    reply({
      spans: [
        span("turn this into a puma ad", "treatment"),
        span("but", "filler"),
        span("dont change my face", "constraint", [], [0]),
      ],
      edits,
      constraints: [{ kind: "preserve_person" }],
    });
  const puma = (
    edits: unknown[],
    over: Partial<InterpretationInput> = TEXT_ON,
  ) =>
    withDisplayText(() =>
      propose(input(PUMA, { treatment: PUMA_AD, ...over }), pumaReply(edits)),
    );
  const STADIUM = suggested({
    kind: "background",
    setting: "stadium under bright lights",
  });

  it("drops Puma's own slogan and keeps her keep and the suggested background — the recorded case", () => {
    // R1's reply, every run from interpret/2 to interpret/5: until this, the deny-list's refusal of one suggested
    // headline asked for the whole reply.
    const out = puma([
      suggested({ kind: "text", content: "FOREVER FASTER" }),
      STADIUM,
    ]);
    expect(out).toMatchObject({
      kind: "proposal",
      canonical: "change the background to the stadium under bright lights",
      edits: [{ kind: "background", source: "suggested" }],
      constraints: [{ kind: "preserve_person", source: "yours" }],
    });
    expect(JSON.stringify(out)).not.toMatch(/forever faster/i);
  });

  it("drops a suggestion refused on ANY of its bounds — a headline's words, length, characters, brand or tagline, and a setting", () => {
    for (const content of [
      "WE RUN THIS CITY TONIGHT", // five words
      "UNSTOPPABLE AND UNBREAKABLE", // 27 characters
      "OWN THE FIELD #1", // a character rule ⅛ does not allow (case is not one: the reply's read capitalizes)
      "PUMA FOREVER", // a brand's name
      "JUST DO IT", // another brand's tagline
    ]) {
      const out = puma([suggested({ kind: "text", content }), STADIUM]);
      expect({ content, out }).toMatchObject({
        content,
        out: {
          kind: "proposal",
          canonical: "change the background to the stadium under bright lights",
        },
      });
    }
    for (const setting of [
      "stadium with her in it",
      "stadium at night under the floodlights here",
    ]) {
      const out = puma([
        suggested({ kind: "text", content: "OWN THE FIELD" }),
        suggested({ kind: "background", setting }),
      ]);
      expect({ setting, out }).toMatchObject({
        setting,
        out: {
          kind: "proposal",
          canonical: 'add the headline "OWN THE FIELD" across the top',
        },
      });
    }
  });

  it("renumbers her spans when a refused suggestion came before her edit", () => {
    const S = "turn this into an adidas ad and make the socks white";
    const out = withDisplayText(() =>
      propose(
        input(S, { treatment: ADIDAS, ...TEXT_ON }),
        reply({
          spans: [
            span("turn this into an adidas ad", "treatment"),
            span("and", "filler"),
            span("make the socks white", "edit", [1]),
          ],
          edits: [
            suggested({ kind: "text", content: "JUST DO IT" }),
            yours({ kind: "recolor", target: "socks", colour: "white" }),
          ],
        }),
      ),
    );
    if (out.kind !== "proposal") throw new Error(JSON.stringify(out));
    expect(out.canonical).toBe("make the socks white");
    expect(out.edits.map((e) => [e.kind, e.source])).toEqual([
      ["recolor", "yours"],
    ]);
    expect(out.spans.map((s) => s.edits)).toEqual([[], [], [0]]);
  });

  it("still asks invalid_slot when nothing is left once it drops — never a relabelled decline", () => {
    expect(
      puma([suggested({ kind: "text", content: "FOREVER FASTER" })]),
    ).toEqual({ kind: "ask", outcome: "invalid_slot", askReason: null });
  });

  it("still asks, WHOLE, for a suggestion the model had no business making", () => {
    // Two headlines, one refused: a refused suggestion still counts as one of its kind.
    expect(
      puma([
        suggested({ kind: "text", content: "FOREVER FASTER" }),
        suggested({ kind: "text", content: "OWN THE FIELD" }),
        STADIUM,
      ]),
    ).toMatchObject({ kind: "ask", outcome: "invalid_slot" });
    // A headline suggested with the text switch off is off the menu, not out of bounds.
    expect(
      puma([suggested({ kind: "text", content: "FOREVER FASTER" }), STADIUM], {
        menu: { text: false, exclusion: false },
      }),
    ).toMatchObject({ kind: "ask", outcome: "invalid_slot" });
    // A suggestion where she asked for no ad at all (M1).
    const S = "make the socks white";
    expect(
      withDisplayText(() =>
        propose(
          input(S, TEXT_ON),
          reply({
            spans: [span(S, "edit", [0])],
            edits: [
              yours({ kind: "recolor", target: "socks", colour: "white" }),
              suggested({ kind: "text", content: "JUST DO IT" }),
            ],
          }),
        ),
      ),
    ).toMatchObject({ kind: "ask", outcome: "invalid_slot" });
    // A look suggested for an ad is never a suggestion at all (M6) — "SLOTS (M6)" above still asks it.
  });
});

// ─── The new-image exit (interpret/5) ──────────────────────────────────────────────────────────────

describe("a new image is an answer — never a refusal, never an edit (the new-image exit)", () => {
  const SCENE = "me on a beach";
  const NEW = reply({ newImage: true });

  it("answers new_image, alone, on a call that is not an ad — no C, no steps, nothing to build", () => {
    expect(propose(input(SCENE), NEW)).toEqual({ kind: "new_image" });
  });

  it("reads no span — nothing is built from a new image, so the model's working is not held to her words", () => {
    // On any edit this span is `uncovered`: it is not her words.
    expect(
      propose(
        input(SCENE),
        reply({
          newImage: true,
          spans: [span("a picture of somebody else", "unreadable")],
        }),
      ),
    ).toEqual({ kind: "new_image" });
  });

  it("changes nothing when false or absent — the same proposal, the same decline", () => {
    const edit = {
      spans: [span(BRAND, "edit", [0])],
      edits: [
        yours({
          kind: "brand_swap",
          item: "jersey",
          descriptors: [],
          brand: "adidas",
        }),
      ],
    };
    const proposal = propose(input(BRAND), reply(edit));
    expect(proposal).toMatchObject({ kind: "proposal" });
    expect(propose(input(BRAND), reply({ ...edit, newImage: false }))).toEqual(
      proposal,
    );
    expect(
      propose(input(BRAND), reply({ decline: true, newImage: false })),
    ).toEqual(propose(input(BRAND), reply({ decline: true })));
  });

  it("SCHEMA — true beside a decline, an edit or a constraint says two things; a non-boolean is not an answer", () => {
    for (const bad of [
      reply({ newImage: true, decline: true }),
      reply({
        newImage: true,
        spans: [span(SCENE, "edit", [0])],
        edits: [yours({ kind: "background", setting: "beach" })],
      }),
      reply({
        newImage: true,
        spans: [span(SCENE, "constraint", [], [0])],
        constraints: [{ kind: "preserve_person" }],
      }),
      reply({ newImage: "true" }),
      reply({ newImage: 1 }),
    ]) {
      expect(propose(input(SCENE), bad)).toEqual({
        kind: "ask",
        outcome: "unparseable",
        askReason: null,
      });
    }
  });

  it("is never the answer beside an ad — an ad is an edit of this photograph (M1): invalid_slot", () => {
    expect(
      propose(input("turn this into an adidas ad", { treatment: ADIDAS }), NEW),
    ).toEqual({ kind: "ask", outcome: "invalid_slot", askReason: null });
  });

  it("is the prompt's to give: interpret/4's misread still proposes if a model says it (F-AM6) — the checks never judged it", () => {
    expect(
      propose(
        input(SCENE),
        reply({
          spans: [span(SCENE, "edit", [0])],
          edits: [yours({ kind: "background", setting: "beach" })],
        }),
      ),
    ).toMatchObject({
      kind: "proposal",
      canonical: "change the background to the beach",
    });
  });
});
