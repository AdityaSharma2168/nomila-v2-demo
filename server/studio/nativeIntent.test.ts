/**
 * nativeIntent.test.ts — freezing her classified intent at preview time. Pure: no network, no rows.
 *
 * The properties asserted hardest:
 *
 *   1. THE WORDS ARE HER SENTENCE. The freeze classifies `explicitAsk(input)` and never the brief's
 *      `direction.statement`, which `directionFor` fills with our own boilerplate when she typed
 *      nothing (Q's coupling note, studio/qa/inspect.ts). Both directions are pinned below.
 *   2. A recolour's change comes from the target's OWN region label — so "black and green" survives
 *      where the classifier's `value` keeps "black", and "the jersey red and the shorts black" gives
 *      each target its own colour rather than both red (PR N, D2 option B).
 *   3. THE ECHO FALLBACK REFUSES, BY RULE. When detection names no directive autoMask stamps her whole
 *      sentence on the region as its label. The test that pins it uses a sentence whose echo WOULD
 *      pair if the rule were gone — so the refusal is the rule's doing, not an accident of pairing.
 *   4. Flag off, not an edit, or a box she DREW: the brief comes back as the SAME object.
 */
// brief.ts reads the database at assembly; this suite never assembles, so the module is stubbed.
jest.mock("../db", () => ({
  db: {},
  pool: { end: async () => {}, on: () => {} },
}));

import {
  asksForRegionFreeEdit,
  changeBefore,
  detectionTextFor,
  freezeEditIntent,
  freezeRefusalNote,
  withNativeEditIntent,
} from "./nativeIntent";
import { compileNativeInstruction, intentsAgree } from "./nativeEdit";
import { ADD_FRAMING_LINE, assumedMoveNote } from "./compile";
import { labelFor } from "./autoMask";
import { route } from "./classify";
import {
  NO_EDIT_REGIONS_FIELD,
  type BriefGap,
  type BriefInput,
  type CreativeBrief,
  type EditRegion,
  type SourceAsset,
} from "./brief";

/** Q5's measured prompt, verbatim — see nativeEdit.test.ts. */
const Q5_SHORTS =
  "make the shorts black and green. Keep everything else exactly as-is — change only the shorts.";

const region = (label: string, over: Partial<EditRegion> = {}): EditRegion => ({
  label,
  left: 1652,
  top: 3546,
  width: 588,
  height: 582,
  ...over,
});

/** 5581e882's shape — N.1's 4000px source — with whatever regions detection wrote. */
const source = (
  editRegions: EditRegion[],
  dims = { width: 4000, height: 6000 },
): SourceAsset => ({
  mediaAssetId: "asset-1",
  ref: "athletes/synthetic/frame.jpg",
  ...dims,
  editRegions,
});

const freeze = (
  ask: string,
  regions: EditRegion[],
  dims?: { width: number; height: number },
) => freezeEditIntent({ ask, origin: "system", source: source(regions, dims) });

describe("a recolour freezes the target's OWN directive — the string the masked crop already sends", () => {
  it("keeps both colours for N.1's shorts, and compiles back to Q5's exact prompt", () => {
    // The label detection actually wrote on 5581e882 (probe memo, Q5L).
    const frozen = freeze("make the shorts black and green", [
      region("black and green shorts"),
    ]);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);

    expect(frozen.intent.changes).toEqual([
      { op: "RECOLOR", target: "shorts", change: "black and green" },
    ]);
    // The classifier's own value is "black" — the loss option B exists to route around.
    expect(frozen.intent.steps[0].value).toBe("black");
    expect(compileNativeInstruction(frozen.intent).startsWith(Q5_SHORTS)).toBe(
      true,
    );
  });

  it("reads two socks' identical directives as one change", () => {
    const frozen = freeze("make the socks blue and green", [
      region("blue and green socks", {
        left: 1764,
        top: 4866,
        width: 200,
        height: 198,
      }),
      region("blue and green socks", {
        left: 2224,
        top: 4728,
        width: 220,
        height: 198,
      }),
    ]);
    expect(frozen.ok && frozen.intent.changes).toEqual([
      { op: "RECOLOR", target: "socks", change: "blue and green" },
    ]);
  });

  it("gives each of two targets its own colour, where the classifier's value gives both red", () => {
    const frozen = freeze("make the jersey red and the shorts black", [
      region("red jersey"),
      region("black shorts", { top: 4200 }),
    ]);
    expect(
      route("make the jersey red and the shorts black", true).steps[0].value,
    ).toBe("red");
    expect(frozen.ok && frozen.intent.changes).toEqual([
      { op: "RECOLOR", target: "jersey", change: "red" },
      { op: "RECOLOR", target: "shorts", change: "black" },
    ]);
  });

  // ─── CARD 2 — HER SENTENCE SUPPLIES THE PAIRING, AND THE LABELS ARE NO LONGER THE ONLY PLACE ──────
  //
  // ⚠️ THIS IS THE DEFECT THAT BLOCKED THE REAL PREVIEW (acceptance B13, H5, R6). She named every
  // colour explicitly and was told "We couldn't pin down exactly what to change from that", because the
  // per-target colours existed ONLY on detection's labels and detection wrote the bare colours. Rule 5
  // now carries `values` beside the SAME single step, and the freeze prefers it over the labels.
  describe("CARD 2 — each target takes the colour she gave IT", () => {
    it("freezes the live shape sweep 3.1 recorded — BARE colours, and no refusal", () => {
      // The exact regions detection returned live: a colour each, naming no target at all. Before card
      // 2 this was `unpaired_directive` and the preview blocked with the rephrase line.
      const frozen = freeze("make the jersey red and the shorts black", [
        region("red"),
        region("black", { top: 4200 }),
      ]);
      expect(frozen.ok && frozen.intent.changes).toEqual([
        { op: "RECOLOR", target: "jersey", change: "red" },
        { op: "RECOLOR", target: "shorts", change: "black" },
      ]);
    });

    it("three targets too — B13 and H5's sentence, which blocked the same way", () => {
      const frozen = freeze(
        "make the jersey red and the shorts black and the socks white",
        [
          region("red"),
          region("black", { top: 4200 }),
          region("white", { top: 4800 }),
        ],
      );
      expect(frozen.ok && frozen.intent.changes).toEqual([
        { op: "RECOLOR", target: "jersey", change: "red" },
        { op: "RECOLOR", target: "shorts", change: "black" },
        { op: "RECOLOR", target: "socks", change: "white" },
      ]);
    });

    it("⚠️ and HER word beats a label that pairs a DIFFERENT colour", () => {
      // The point of the change, stated where it can go red: these labels pair cleanly, and they
      // disagree with her. She typed the colours — "consulting the labels at all is the bug here"
      // (F-WB6's wording, and the `fromPronoun` precedent this copies).
      const frozen = freeze("make the jersey red and the shorts black", [
        region("blue jersey"),
        region("green shorts", { top: 4200 }),
      ]);
      expect(frozen.ok && frozen.intent.changes).toEqual([
        { op: "RECOLOR", target: "jersey", change: "red" },
        { op: "RECOLOR", target: "shorts", change: "black" },
      ]);
    });

    it("keeps her colour PHRASE per target, and a hex (A15)", () => {
      const phrases = freeze(
        "make the jersey light blue and the shorts matte black",
        [region("blue jersey"), region("black shorts", { top: 4200 })],
      );
      expect(phrases.ok && phrases.intent.changes).toEqual([
        { op: "RECOLOR", target: "jersey", change: "light blue" },
        { op: "RECOLOR", target: "shorts", change: "matte black" },
      ]);
      const hex = freeze("make the jersey #ff0000 and the shorts black", [
        region("red jersey"),
        region("black shorts", { top: 4200 }),
      ]);
      expect(hex.ok && hex.intent.changes).toEqual([
        { op: "RECOLOR", target: "jersey", change: "#ff0000" },
        { op: "RECOLOR", target: "shorts", change: "black" },
      ]);
    });

    it("⚠️ and a TWO-TONE keeps the LABEL, which carries more than she typed (F-WB7)", () => {
      // "make the shorts black and green" pairs "black and green" off the label while the step's value
      // is "black", and that fuller string is Q5's MEASURED prompt. So the reader DECLINES a sentence
      // whose target colour runs on into a second colour rather than pairing half of it — the two-tone
      // is its own discriminator and its own card. Both targets still get the right change here, and
      // both of them come from the labels.
      const ask = "make the shorts black and green and the socks white";
      expect(route(ask, true).steps[0].values).toBeUndefined();
      const frozen = freeze(ask, [
        region("black and green shorts"),
        region("white socks", { top: 4200 }),
      ]);
      expect(frozen.ok && frozen.intent.changes).toEqual([
        { op: "RECOLOR", target: "shorts", change: "black and green" },
        { op: "RECOLOR", target: "socks", change: "white" },
      ]);
    });

    it("⚠️ D6 — a keep carrying a colour is an instruction, and the COLOUR is what moved", () => {
      // "make the socks blue, keep the jersey red" (D6, ratified: read as today, Adi 2026-09-18). The
      // ROUTING pin for this sentence lives in keepVocab.test.ts and compares "RECOLOR[socks|jersey]
      // blue" — it is BLIND to the per-target colour and stays green whichever colour the jersey
      // becomes. THIS is the pin that catches it: before card 2 the jersey took the label's blue, and
      // now it takes the red she typed, which is what "may be an instruction" means once it renders.
      const frozen = freeze("make the socks blue, keep the jersey red", [
        region("blue socks"),
        region("blue jersey", { top: 4200 }),
      ]);
      expect(frozen.ok && frozen.intent.changes).toEqual([
        { op: "RECOLOR", target: "socks", change: "blue" },
        { op: "RECOLOR", target: "jersey", change: "red" },
      ]);
    });
  });

  it("REFUSES a directive that names no target — sweep 3.1's guard, in its real domain", () => {
    // ⚠️ REWRITTEN BY CARD 2, NOT LOOSENED. This guard was pinned with "make the jersey red and the
    // shorts black" and the bare labels ["red","black"], and that sentence now freezes — correctly,
    // because SHE supplied the pairing and refusing it was the defect (the describe above).
    //
    // The guard's real domain is the sentence where she did NOT pair: ONE colour over two targets.
    // Rule 5 emits one step, `values` is absent (the reader needs a colour after every target, and
    // "and" is not one), `sole` is false, and a label no target owns is still not guessed at — her
    // single word cannot be distributed across two garments. Same refusal, same reason, now on the
    // sentence that actually asks the question.
    expect(
      route("make the jersey and the shorts black", true).steps[0].values,
    ).toBeUndefined();
    expect(
      freeze("make the jersey and the shorts black", [
        region("black"),
        region("black", { top: 4200 }),
      ]),
    ).toEqual({
      ok: false,
      reason: "unpaired_directive",
    });
  });

  it("REFUSES one target with two different directives", () => {
    expect(
      freeze("make the socks blue", [
        region("blue socks"),
        region("green socks"),
      ]),
    ).toEqual({
      ok: false,
      reason: "ambiguous_directive",
    });
  });
});

describe("THE ECHO FALLBACK — a recolour on her sentence echoed back refuses to freeze", () => {
  // A recolour whose sentence ENDS with its target, so autoMask's echo label — the whole sentence —
  // would pair with that target if nothing refused it, and the compiled change would be her
  // sentence ("i want blue on the"). That is the raw-sentence leak the classified intent exists to
  // stop, arriving through the one door a label opens.
  const ASK = "i want blue on the socks";

  it("uses a sentence the classifier routes as a recolour of that target", () => {
    const r = route(ASK, true);
    expect(r.steps).toEqual([
      { op: "RECOLOR", targets: ["socks"], value: "blue", scope: "REGION" },
    ]);
  });

  it("WOULD pair without the rule — so the refusal below is not incidental", () => {
    expect(changeBefore(labelFor(ASK), "socks")).toBe("i want blue on the");
  });

  it("refuses, freezes nothing, and blocks with a note she can act on", () => {
    const frozen = freeze(ASK, [region(labelFor(ASK))]);
    expect(frozen).toEqual({ ok: false, reason: "echoed_directive" });
    expect(
      freezeRefusalNote(frozen as Extract<typeof frozen, { ok: false }>),
    ).toMatch(/Name the thing and what it should become/);
  });

  it("refuses even when another region's directive would have paired", () => {
    // Fail-closed on the WHOLE pass: a recolour never rests on a detection that fell back anywhere.
    expect(freeze(ASK, [region("blue socks"), region(labelFor(ASK))])).toEqual({
      ok: false,
      reason: "echoed_directive",
    });
  });

  it("does not hold a DESIGN hostage to it — a design's change is the classifier's value, not a label", () => {
    // Sweep 2.1's label WAS the whole instruction. A design never reads labels, so an echo there
    // leaks nothing and does not refuse; the change is "number 10", from the classifier.
    const ask = "put a number 10 on the jersey";
    const frozen = freeze(ask, [region(labelFor(ask))]);
    expect(frozen.ok && frozen.intent.changes).toEqual([
      { op: "APPLY_DESIGN", target: "jersey", change: "number 10" },
    ]);
  });
});

describe("every gate still decides before anything is frozen", () => {
  it("an ASK freezes nothing, and carries the classifier's reason", () => {
    expect(freeze("do something cool with this", [region("x")])).toEqual({
      ok: false,
      reason: "not_routed",
      askReason: "fast_path_declined",
    });
  });

  it("Q6's banner and logo sentences freeze nothing — neither compiles 'change the background to …' (sweep #4, F-I2)", () => {
    // On b9ad08b both froze CHANGE_BACKGROUND and compiled "change the background to bold white
    // capital letters" and "…to upper right corner of the background": a ready preview for a
    // replacement she never asked for. The background is where each change goes, not the change.
    const t1 =
      "Add a large banner across the top of the background that reads GET LOUD in bold white capital letters. Keep the person, her pose, clothing, lighting and everything else exactly as they are.";
    const t2 =
      "Add a small adidas logo with the words IMPOSSIBLE IS NOTHING beneath it in the upper right corner of the background. Keep everything else exactly as it is.";
    // What detection returned for sweep #4's banner sentence: one background region, subject kept.
    const background = region("background", {
      left: 0,
      top: 0,
      width: 1008,
      height: 1476,
      subjectNoun: "person",
    });
    const dims = { width: 1008, height: 1476 };
    expect([t1, t2].map((ask) => freeze(ask, [background], dims))).toEqual([
      { ok: false, reason: "not_routed", askReason: "add_unclear" },
      { ok: false, reason: "not_routed", askReason: "fast_path_declined" },
    ]);
  });

  it("'turn this into an adidas ad' freezes nothing — on d90efda it compiled 'replace the this with adidas this' (I.0)", () => {
    // Rule 4c read the demonstrative as the item. A replacement's change is the classifier's value, so
    // whatever region detection found, the freeze took target "this" and value "adidas this", and the
    // preview was ready to spend on it. Same for "this jersey".
    const kit = region("adidas kit");
    expect(
      ["turn this into an adidas ad", "change this jersey to adidas"].map(
        (ask) => freeze(ask, [kit]),
      ),
    ).toEqual([
      { ok: false, reason: "not_routed", askReason: "brand_change" },
      { ok: false, reason: "not_routed", askReason: "brand_change" },
    ]);
  });

  it("a sentence naming only her body gets the refusal too, not the rephrase (C.4)", () => {
    const frozen = freeze("make my arms bigger", [region("arms")]);
    expect(frozen).toEqual({
      ok: false,
      reason: "not_routed",
      askReason: "person_mentioned",
    });
    expect(
      freezeRefusalNote(frozen as Extract<typeof frozen, { ok: false }>),
    ).toMatch(/doesn't change a person's face or body/);
  });

  it("two different changes freeze BOTH, each from its own clause — the recolour's colour from its own label (composition)", () => {
    // Rule ½ (classify.ts). PR 1 froze nothing here; composition reads each clause with its own rule.
    const frozen = freeze("make her jersey blue and remove the ball", [
      region("blue jersey"),
      region("ball", { top: 4200 }),
    ]);
    expect(frozen.ok && frozen.intent.changes).toEqual([
      { op: "RECOLOR", target: "jersey", change: "blue" },
      { op: "REMOVE_OBJECT", target: "ball", change: null },
    ]);
  });

  it("a compound that still asks blocks with the client's own line for its code — never the rephrase (composition)", () => {
    // freezeRefusalNote and askCopyFor (client/lib/studio-contract.ts) render the same codes on two
    // surfaces; the preview must not tell her "name the thing" about a sentence that named several.
    const table: [string, string, string][] = [
      [
        "make the socks blue and make it pop",
        "compound_partial",
        "We can do a few changes at once, but couldn't follow one part of that. Try each change on its own to find the part that needs rewording.",
      ],
      [
        "change my jersey, shorts, socks and shoes to adidas and remove the ball",
        "too_many_changes",
        "That's more than four changes in one go — split it into two edits.",
      ],
      [
        "change the background to a beach and change the background to a stadium",
        "compound_conflict",
        "That asks for two things that can't both happen — two backgrounds, two looks, or a change to something it also removes. Pick the one you want and try again.",
      ],
      [
        "make her jersey blue and remove the jersey",
        "compound_conflict",
        "That asks for two things that can't both happen — two backgrounds, two looks, or a change to something it also removes. Pick the one you want and try again.",
      ],
    ];
    for (const [ask, askReason, note] of table) {
      const frozen = freeze(ask, [region("blue socks")]);
      expect({ ask, frozen }).toEqual({
        ask,
        frozen: { ok: false, reason: "not_routed", askReason },
      });
      expect({
        ask,
        note: freezeRefusalNote(
          frozen as Extract<typeof frozen, { ok: false }>,
        ),
      }).toEqual({ ask, note });
    }
    // A clause's own code keeps its own note: a body-edit clause is the person refusal here too (d1).
    const body = freeze(
      "add a soccer ball at her feet and make my arms bigger",
      [],
    );
    expect(
      freezeRefusalNote(body as Extract<typeof body, { ok: false }>),
    ).toMatch(/doesn't change a person's face or body/);
  });

  it("a condition blocks with the client's own line — never 'remove the uniform', never the rephrase (guard scope, rule ¼)", () => {
    // Mia's (d), first clause verbatim. On 0cf9ae9 this froze REMOVE_OBJECT [uniform] and compiled
    // "remove the uniform"; with a readable clause beside it, the whole sentence routed.
    const frozen = freeze(
      "change my uniform so that its a black adidas uniform. i dont want any nike logos showing in this so if there are any remove them",
      [region("uniform")],
    );
    expect(frozen).toEqual({
      ok: false,
      reason: "not_routed",
      askReason: "conditional",
    });
    expect(
      freezeRefusalNote(frozen as Extract<typeof frozen, { ok: false }>),
    ).toBe(
      'We can\'t do "if" yet — tell us the change directly, like "remove the nike logo".',
    );
  });

  it("an add of something she wears onto her FREEZES as an add — G.3 blocked it with add_onto_body until Mia's M3 (PR M3)", () => {
    const frozen = freeze("add gold hoops to my ears", []);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    // The thing and where it is worn, as rule 3¾b read them; no photo attached, so the edit invents it.
    expect(frozen.intent.changes).toEqual([
      {
        op: "ADD_OBJECT",
        target: null,
        change: null,
        add: { thing: "gold hoops", place: "to my ears", objectAssetId: null },
      },
    ]);
    expect(compileNativeInstruction(frozen.intent)).toBe(
      "add gold hoops, worn in the person's ears. " +
        "Keep everything else exactly as-is — only add the gold hoops. " +
        "Keep the original photograph's lighting, exposure, contrast, colour grade and scene exactly as they are.",
    );
    // A piercing Mia has not opened is not a worn add: no worn thing goes through an eyebrow, so it blocks
    // with the person note. (This was "put a stud in my nose" until M3.9 opened the nose — see below.)
    const eyebrow = freeze("put a stud through my eyebrow", []);
    expect(eyebrow).toEqual({
      ok: false,
      reason: "not_routed",
      askReason: "person_mentioned",
    });
    expect(
      freezeRefusalNote(eyebrow as Extract<typeof eyebrow, { ok: false }>),
    ).toMatch(/doesn't change a person's face or body/);
  });

  it("pierced jewelry in her nose FREEZES as a worn add, worded 'worn in the person's nose' (PR M3.9)", () => {
    const frozen = freeze("put a stud in my nose", []);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    expect(frozen.intent.changes[0].add).toEqual({
      thing: "stud",
      place: "in my nose",
      objectAssetId: null,
    });
    expect(compileNativeInstruction(frozen.intent)).toBe(
      "add a stud, worn in the person's nose. " +
        "Keep everything else exactly as-is — only add the stud. " +
        "Keep the original photograph's lighting, exposure, contrast, colour grade and scene exactly as they are.",
    );
  });

  it("a placeless body modification blocks with the person note — never the rephrase (PR M3, BODY_MODS)", () => {
    for (const ask of ["add a tattoo", "add muscles", "give me abs"]) {
      const frozen = freeze(ask, []);
      expect({ ask, frozen }).toEqual({
        ask,
        frozen: {
          ok: false,
          reason: "not_routed",
          askReason: "person_mentioned",
        },
      });
      expect(
        freezeRefusalNote(frozen as Extract<typeof frozen, { ok: false }>),
      ).toMatch(/doesn't change a person's face or body/);
    }
  });

  it("a worn add it could not read blocks with its own line — 'say it plainly', never the person note (PR M3.8)", () => {
    for (const ask of [
      "add small gold hoops to my ears",
      "put a baseball cap on my head",
    ]) {
      const frozen = freeze(ask, []);
      expect({ ask, frozen }).toEqual({
        ask,
        frozen: {
          ok: false,
          reason: "not_routed",
          askReason: "worn_add_unclear",
        },
      });
      const note = freezeRefusalNote(
        frozen as Extract<typeof frozen, { ok: false }>,
      );
      expect(note).toBe(
        'Say the item plainly and where it goes — "add gold hoops to my ears".',
      );
      expect(note).not.toMatch(/doesn't change a person's face or body/);
    }
  });

  it("a look she named that we don't have blocks with its own line — never the rephrase (style vocabulary, V.4)", () => {
    // The client's line for the code, word for word (client/lib/studio-contract.ts, askCopyFor), so the
    // preview and the ask say the same thing.
    for (const ask of ["give it a dreamy vibe", "add a dreamy filter"]) {
      const frozen = freeze(ask, []);
      expect({ ask, frozen }).toEqual({
        ask,
        frozen: { ok: false, reason: "not_routed", askReason: "look_unknown" },
      });
      const note = freezeRefusalNote(
        frozen as Extract<typeof frozen, { ok: false }>,
      );
      expect(note).toBe(
        "That look isn't one we know yet — try warmer, moodier, cinematic, vintage or black and white.",
      );
    }
  });

  it("a new image the interpreter answered blocks with the new-image line — the same words a GENERATE on a photo gets (the new-image exit)", () => {
    // The client's line for the code, word for word (client/lib/studio-contract.ts, askCopyFor("new_image")).
    const line =
      "That asks for a new picture of you, not a change to this photo — start a new image instead.";
    expect(
      freezeRefusalNote({
        ok: false,
        reason: "not_routed",
        askReason: "new_image",
      }),
    ).toBe(line);
    expect(freezeRefusalNote({ ok: false, reason: "generate_on_edit" })).toBe(
      line,
    );
  });

  it("a worn add takes her Object photo as the thing, and refuses two — the add's own rules (PR M3)", () => {
    const withPhotos = (n: number) =>
      freezeEditIntent({
        ask: "add these gold hoops to my ears",
        origin: "system",
        source: source([]),
        references: Array.from({ length: n }, (_, k) => ({
          role: "object" as const,
          ref: `athletes/synthetic/hoops-${k}.png`,
          mediaAssetId: `hoops-${k}`,
        })),
      });
    const one = withPhotos(1);
    expect(one.ok && one.intent.changes[0].add).toEqual({
      thing: "gold hoops",
      place: "to my ears",
      objectAssetId: "hoops-0",
    });
    expect(withPhotos(2)).toEqual({ ok: false, reason: "ambiguous_object" });
  });

  it("freezes a replacement pointing at 'image 2' as the one pointing at 'the second picture' — the same instruction (wave A, V1)", () => {
    const compiled = (ask: string) => {
      const frozen = freezeEditIntent({
        ask,
        origin: "system",
        source: source([region("hoops earrings")]),
        references: [
          {
            role: "object" as const,
            ref: "athletes/synthetic/hoops.png",
            mediaAssetId: "hoops-0",
          },
        ],
      });
      if (!frozen.ok) throw new Error(`${ask}: ${frozen.reason}`);
      return compileNativeInstruction(frozen.intent, { objectImage: 2 });
    };
    expect(compiled("change my earrings to the hoops in image 2")).toBe(
      compiled("change my earrings to the hoops in the second picture"),
    );
    expect(compiled("change my earrings to the hoops in image 2")).toMatch(
      /^replace the earrings with the hoops from Image 2\./,
    );
  });

  it("freezes a worn add with no place exactly as her placed twin — C2's cell 3 compiles as the edit that held her frame (wave A, V2)", () => {
    const compiled = (ask: string) => {
      const frozen = freezeEditIntent({
        ask,
        origin: "system",
        source: source([]),
        references: [
          {
            role: "object" as const,
            ref: "athletes/synthetic/hoops.png",
            mediaAssetId: "hoops-0",
          },
        ],
      });
      if (!frozen.ok) throw new Error(`${ask}: ${frozen.reason}`);
      return compileNativeInstruction(frozen.intent, { objectImage: 2 });
    };
    expect(compiled("add in hoops from the second picture")).toBe(
      compiled("add the hoops from image 2 to my ears"),
    );
    expect(compiled("add in hoops from the second picture")).toMatch(
      /^add the hoops from Image 2, worn in the person's ears\./,
    );
  });

  it("compiles a removal from her sleeve as the logo alone — never 'remove the sleeve' (wave A, V4)", () => {
    const compiled = (ask: string) => {
      const frozen = freeze(ask, [region("logo")]);
      if (!frozen.ok) throw new Error(`${ask}: ${frozen.reason}`);
      return compileNativeInstruction(frozen.intent);
    };
    for (const ask of [
      "remove the logo from my sleeve",
      "take the logo off my sleeve",
    ]) {
      expect({ ask, instruction: compiled(ask) }).toEqual({
        ask,
        instruction: compiled("remove the logo"),
      });
    }
    expect(compiled("take the logo off my sleeve")).not.toMatch(/sleeve/);
  });

  it("refuses to freeze an explicit generate's compound as an edit — it is a new image (wave A, V5)", () => {
    expect(
      freeze(
        "generate a pic of me playing soccer and change the background to a stadium",
        [],
      ),
    ).toEqual({ ok: false, reason: "generate_on_edit" });
  });

  it("compiles sweep #3's two 'remove the jersey' prompts as what she asked — B-p5, which she paid for, and B-c4", () => {
    // Main froze REMOVE [soccer ball, jersey] and REMOVE [jersey, cleats] and compiled "remove the
    // jersey" into both (docs/probes/sweep-3-part-b-findings.md, addendum); PR 1 froze nothing. Both
    // operations now, and the jersey is recoloured, never removed. B-c2's compiled prompt is the answer
    // key for the shape — "make the jersey blue, and …" then the scope sentence naming both targets.
    const regions = [
      region("soccer ball"),
      region("blue jersey", { top: 2400 }),
      region("cleats", { top: 5200 }),
    ];
    const compiled = (ask: string) => {
      const frozen = freeze(ask, regions);
      if (!frozen.ok) throw new Error(`${ask}: ${frozen.reason}`);
      return compileNativeInstruction(frozen.intent);
    };
    const KEEP_SCENE =
      "Keep the original photograph's lighting, exposure, contrast, colour grade and scene exactly as they are.";
    expect(compiled("Remove the soccer ball, and make her jersey blue.")).toBe(
      "make the jersey blue, and remove the soccer ball and fill the space where it was with what naturally lies behind it. " +
        "Keep everything else exactly as-is — change only the jersey and the soccer ball. " +
        KEEP_SCENE,
    );
    expect(compiled("make her jersey blue and remove the cleats")).toBe(
      "make the jersey blue, and remove the cleats and fill the space where it was with what naturally lies behind it. " +
        "Keep everything else exactly as-is — change only the jersey and the cleats. " +
        KEEP_SCENE,
    );
    for (const ask of [
      "Remove the soccer ball, and make her jersey blue.",
      "make her jersey blue and remove the cleats",
    ]) {
      expect(compiled(ask)).not.toContain("remove the jersey");
    }
  });

  it("the person guard fires, and says so in words she can read", () => {
    const frozen = freeze("make my hair red", [region("red hair")]);
    expect(frozen).toEqual({
      ok: false,
      reason: "not_routed",
      askReason: "person_target",
    });
    expect(
      freezeRefusalNote(frozen as Extract<typeof frozen, { ok: false }>),
    ).toMatch(/doesn't change a person/);
  });

  it("an explicit request for a new image is a generate, not a native edit", () => {
    expect(freeze("create a new poster of me", [region("x")])).toEqual({
      ok: false,
      reason: "generate_on_edit",
    });
  });

  it("refuses brand-authored text, an empty ask and an unmeasured frame", () => {
    const src = source([region("black and green shorts")]);
    expect(
      freezeEditIntent({
        ask: "make the shorts black and green",
        origin: "inbound",
        source: src,
      }),
    ).toEqual({ ok: false, reason: "untrusted_origin" });
    expect(
      freezeEditIntent({ ask: "   ", origin: "system", source: src }),
    ).toEqual({ ok: false, reason: "no_ask" });
    expect(
      freezeEditIntent({
        ask: "make the shorts black and green",
        origin: "system",
        source: { ...src, width: null, height: null },
      }),
    ).toEqual({ ok: false, reason: "unmeasured_source" });
  });
});

describe("the other operations freeze the classifier's own value", () => {
  it("a background keeps no target and carries the place", () => {
    const frozen = freeze("change the background to a beach at sunset", [
      region("beach at sunset", {
        left: 0,
        top: 0,
        width: 4000,
        height: 6000,
        subjectNoun: "person",
      }),
    ]);
    expect(frozen.ok && frozen.intent.changes).toEqual([
      { op: "CHANGE_BACKGROUND", target: null, change: "beach at sunset" },
    ]);
  });

  it('a setting whose article main ate compiles whole — main sent "change the background to n arena" (wave-1 fixes)', () => {
    const frozen = freeze("change the background to an arena", []);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    expect(frozen.intent.changes).toEqual([
      { op: "CHANGE_BACKGROUND", target: null, change: "arena" },
    ]);
    expect(compileNativeInstruction(frozen.intent)).toBe(
      "change the background to arena. " +
        "Keep the person exactly as-is — change only the background. " +
        "Keep the original photograph's lighting, exposure, contrast and colour grade exactly as they are.",
    );
  });

  it("a removal names its target and no change", () => {
    const frozen = freeze("remove the ball", [region("remove the ball")]);
    expect(frozen.ok && frozen.intent.changes).toEqual([
      { op: "REMOVE_OBJECT", target: "ball", change: null },
    ]);
  });
});

describe("a brand change freezes per N's contract — the classifier's items and values, no label read (2026-09-10)", () => {
  /** afc78262's dimensions — the Q1 frame, and the acceptance frame for this change. */
  const Q1_FRAME = { width: 1008, height: 1476 };
  const KEEP =
    "Keep the original photograph's lighting, exposure, contrast, colour grade and scene exactly as they are.";

  it("freezes one REPLACE and compiles to the REPLACE clause the compiler already had", () => {
    const ask = "change my jersey to adidas";
    const frozen = freeze(ask, [region("adidas jersey")], Q1_FRAME);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);

    expect(frozen.intent.changes).toEqual([
      { op: "REPLACE_OBJECT", target: "jersey", change: "adidas jersey" },
    ]);
    expect(compileNativeInstruction(frozen.intent)).toBe(
      "replace the jersey with adidas jersey. Keep everything else exactly as-is — change only the jersey. " +
        KEEP,
    );
    // The spend-time re-check reproduces it, so a quote on this sentence can be spent.
    expect(intentsAgree(frozen.intent, route(ask, true))).toBe(true);
  });

  it("the screenshot sentence: every item a clause of ONE call, each naming its own replacement", () => {
    const ask = "change my uniform, socks, and shoes all to be adidas";
    const frozen = freeze(
      ask,
      [
        region("adidas uniform"),
        region("adidas socks"),
        region("adidas shoes"),
      ],
      Q1_FRAME,
    );
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);

    expect(compileNativeInstruction(frozen.intent)).toBe(
      "replace the uniform with adidas uniform, and replace the socks with adidas socks, and replace the shoes with adidas shoes. " +
        "Keep everything else exactly as-is — change only the uniform, the socks and the shoes. " +
        KEEP,
    );
    expect(intentsAgree(frozen.intent, route(ask, true))).toBe(true);
  });

  it("a descriptor rides into the compiled instruction verbatim — it says what she said", () => {
    const ask = "make my jersey a blue adidas kit";
    const frozen = freeze(ask, [region("blue adidas jersey")], Q1_FRAME);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);

    expect(compileNativeInstruction(frozen.intent)).toBe(
      "replace the jersey with blue adidas jersey. Keep everything else exactly as-is — change only the jersey. " +
        KEEP,
    );
    expect(intentsAgree(frozen.intent, route(ask, true))).toBe(true);
  });

  it("B.1c — a model name is DROPPED from the compiled instruction: 'mercurial' never reaches the model", () => {
    const ask = "swap the cleats for Nike Mercurials";
    // Detection's label may well carry the model — it re-reads her sentence. The native freeze reads
    // no label for a REPLACE, so the label cannot put it back.
    const frozen = freeze(ask, [region("nike mercurial cleats")], Q1_FRAME);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);

    expect(frozen.intent.changes).toEqual([
      { op: "REPLACE_OBJECT", target: "cleats", change: "nike cleats" },
    ]);
    const instruction = compileNativeInstruction(frozen.intent);
    expect(instruction).toBe(
      "replace the cleats with nike cleats. Keep everything else exactly as-is — change only the cleats. " +
        KEEP,
    );
    expect(instruction).not.toMatch(/mercurial/i);
    // …and the dropped word is frozen beside the value, for the preview to disclose.
    expect(frozen.intent.steps[0].dropped).toEqual(["mercurials"]);
    expect(intentsAgree(frozen.intent, route(ask, true))).toBe(true);
  });

  it("reads no region label — detection finding fewer items than she named drops none of hers", () => {
    // Detection is a second reading of the sentence and can come back short. On the native path the
    // items come from the classifier, so all three are applied whatever detection found.
    const frozen = freeze(
      "change my uniform, socks, and shoes all to be adidas",
      [region("adidas uniform")],
      Q1_FRAME,
    );
    expect(frozen.ok && frozen.intent.changes.map((c) => c.target)).toEqual([
      "uniform",
      "socks",
      "shoes",
    ]);
  });
});

describe("an add freezes the thing and the place — no region, no label, nothing detected (PR C′)", () => {
  it("takes the thing from the step's first target and the place from its value", () => {
    const frozen = freeze("put a water bottle on the grass", [], {
      width: 1008,
      height: 1476,
    });
    expect(frozen.ok && frozen.intent.changes).toEqual([
      {
        op: "ADD_OBJECT",
        target: null,
        change: null,
        add: {
          thing: "water bottle",
          place: "on the grass",
          objectAssetId: null,
        },
      },
    ]);
    expect(frozen.ok && frozen.intent.imageSize).toBe("2K");
  });

  it("freezes the G3 sentence — the one that ASKed live — and compiles it to a spatial instruction", () => {
    const G3 =
      "add a soccer ball to the image, place it in the middle of my cleats";
    const frozen = freeze(G3, [], { width: 1008, height: 1476 });
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    // Frozen in her words; compiled with the person named neutrally. The frame reference ("to the
    // image") and the second clause's "place it" are consumed, never compiled.
    expect(frozen.intent.changes[0].add).toEqual({
      thing: "soccer ball",
      place: "in the middle of my cleats",
      objectAssetId: null,
    });
    expect(compileNativeInstruction(frozen.intent)).toBe(
      "add a soccer ball, place it in the middle of the person's cleats. " +
        "Keep everything else exactly as-is — only add the soccer ball. " +
        "Keep the original photograph's lighting, exposure, contrast, colour grade and scene exactly as they are. " +
        ADD_FRAMING_LINE,
    );
  });

  describe("C.3 — the object photo is frozen by its ROLE, and only one may be the thing", () => {
    const ASK =
      "add the soccer ball from the second image, place it between her cleats";
    const ref = (role: "person" | "product" | "object", id: string) => ({
      role,
      ref: `athletes/synthetic/${id}.jpg`,
      mediaAssetId: id,
    });
    const freezeWith = (references: ReturnType<typeof ref>[]) =>
      freezeEditIntent({
        ask: ASK,
        origin: "system",
        source: source([], { width: 1008, height: 1476 }),
        references,
      });

    it("freezes the object photo's asset id onto the add", () => {
      const frozen = freezeWith([ref("object", "ball-asset")]);
      expect(frozen.ok && frozen.intent.changes[0].add?.objectAssetId).toBe(
        "ball-asset",
      );
    });

    it("binds her lone PRODUCT photo when no Object photo is attached — it is the thing she is adding (C3)", () => {
      // Until C3 this froze NO object: the product rode along as "render this exact object" while the
      // instruction invented the ball. Now the add places the photo she attached, whichever tile it went in.
      const frozen = freezeWith([ref("product", "boot-asset")]);
      expect(frozen.ok && frozen.intent.changes[0].add?.objectAssetId).toBe(
        "boot-asset",
      );
    });

    it("an Object photo beside a product is the thing — the product rides along, never placed (C3)", () => {
      for (const references of [
        [ref("object", "ball-asset"), ref("product", "boot-asset")],
        [ref("product", "boot-asset"), ref("object", "ball-asset")],
      ]) {
        const frozen = freezeWith(references);
        expect(frozen.ok && frozen.intent.changes[0].add?.objectAssetId).toBe(
          "ball-asset",
        );
      }
    });

    it("a photo of HER is never an add's thing — only a product stands in for an Object photo (C3)", () => {
      const alone = freezeWith([ref("person", "me-asset")]);
      expect(alone.ok && alone.intent.changes[0].add?.objectAssetId).toBe(null);
      const beside = freezeWith([
        ref("person", "me-asset"),
        ref("product", "boot-asset"),
      ]);
      expect(beside.ok && beside.intent.changes[0].add?.objectAssetId).toBe(
        "boot-asset",
      );
    });

    it("REFUSES two product photos and no Object photo — which one is the thing is not guessed (C3)", () => {
      const frozen = freezeWith([
        ref("product", "boot-asset"),
        ref("product", "bottle-asset"),
      ]);
      expect(frozen).toEqual({
        ok: false,
        reason: "ambiguous_object",
        products: 2,
      });
      const note = freezeRefusalNote(
        frozen as Extract<typeof frozen, { ok: false }>,
      );
      expect(note).toBe(
        "More than one product photo is attached, and it isn't clear which one to add. Put the one you want added in the Object tile and check again.",
      );
      // With an Object photo attached there is nothing to choose between: it is the thing.
      expect(
        freezeWith([
          ref("product", "boot-asset"),
          ref("product", "bottle-asset"),
          ref("object", "ball-asset"),
        ]).ok,
      ).toBe(true);
    });

    it("REFUSES two object photos — which one is the ball is not guessed", () => {
      const frozen = freezeWith([
        ref("object", "ball-asset"),
        ref("object", "bottle-asset"),
      ]);
      expect(frozen).toEqual({ ok: false, reason: "ambiguous_object" });
      expect(
        freezeRefusalNote(frozen as Extract<typeof frozen, { ok: false }>),
      ).toMatch(/More than one object photo/);
    });

    // ─── Composition's two adds (decision 4 and 4a) ─────────────────────────────────────────────
    const TWO_ADDS =
      "add a ball on the bench and add a red bottle on the grass";
    const freezeTwoAdds = (references: ReturnType<typeof ref>[]) =>
      freezeEditIntent({
        ask: TWO_ADDS,
        origin: "system",
        source: source([], { width: 1008, height: 1476 }),
        references,
      });

    it("REFUSES two adds with one object photo — which thing it shows is not guessed (decision 4)", () => {
      // Without the refusal every add would take the one photo: a ball photo pasted in as the bottle.
      const frozen = freezeTwoAdds([ref("object", "ball-asset")]);
      expect(frozen).toEqual({
        ok: false,
        reason: "ambiguous_object",
        adds: 2,
      });
      // Its own note — the two-photo line ("More than one object photo is attached") would be false.
      const note = freezeRefusalNote(
        frozen as Extract<typeof frozen, { ok: false }>,
      );
      expect(note).toBe(
        "This adds more than one thing, and an object photo is attached — which thing it shows isn't clear. Add them one at a time, or remove the photo and the edit will invent them.",
      );
      expect(note).not.toMatch(/More than one object photo/);
    });

    it("freezes two adds with NO photo — each invented, each in its own place (4a)", () => {
      const frozen = freezeTwoAdds([]);
      expect(frozen.ok && frozen.intent.changes.map((c) => c.add)).toEqual([
        { thing: "ball", place: "on the bench", objectAssetId: null },
        { thing: "red bottle", place: "on the grass", objectAssetId: null },
      ]);
    });

    it("REFUSES two adds with one product photo, as with one Object photo (C3; Adi's decision 5)", () => {
      // Until C3 a product was no object and two adds beside one froze, both invented. It is the thing now,
      // and one photo for two things is not guessed.
      const frozen = freezeTwoAdds([ref("product", "boot-asset")]);
      expect(frozen).toEqual({
        ok: false,
        reason: "ambiguous_object",
        adds: 2,
        products: 1,
      });
      expect(
        freezeRefusalNote(frozen as Extract<typeof frozen, { ok: false }>),
      ).toBe(
        "This adds more than one thing, and a product photo is attached — which thing it shows isn't clear. Add them one at a time.",
      );
    });

    // ⚠️ THIS PIN ASSERTED THE OPPOSITE UNTIL CARD 4, and its name said so: "a product is not one
    // (C3's scope)". C3 scoped the Product tile to adds and left replacements asking; card 4 is the
    // card that scope deferred. A product of hers worn in place of what she has on is product
    // placement, which is what the Product tile is for — so the freeze binds it, as it does for an add.
    it("a replacement she pointed at a photo for reads her PRODUCT photo too (card 4)", () => {
      const frozen = freezeEditIntent({
        ask: "change my earrings to these gold hoops",
        origin: "system",
        source: source([region("gold earrings")], {
          width: 1008,
          height: 1476,
        }),
        references: [ref("product", "hoops-asset")],
      });
      expect(frozen.ok).toBe(true);
      expect(frozen.ok && frozen.intent.changes).toEqual([
        {
          op: "REPLACE_OBJECT",
          target: "earrings",
          change: "gold hoops",
          object: { objectAssetId: "hoops-asset" },
        },
      ]);
    });

    it("Adi's live hits, 2026-09-16: the water bottle in the Product tile is placed exactly as in the Object tile", () => {
      for (const ask of [
        "add the water bottle from image 2 next to me",
        "add a water bottle next to me",
        "put this water bottle next to me",
      ]) {
        const bound = (role: "product" | "object") => {
          const frozen = freezeEditIntent({
            ask,
            origin: "system",
            source: source([], { width: 1008, height: 1476 }),
            references: [ref(role, "bottle-asset")],
          });
          if (!frozen.ok) throw new Error(`${ask}: ${frozen.reason}`);
          return frozen.intent;
        };
        expect(bound("product")).toEqual(bound("object"));
        expect(bound("product").changes[0].add?.objectAssetId).toBe(
          "bottle-asset",
        );
      }
    });
  });

  it("an add onto her never freezes — the person guard decided first", () => {
    // A crown: not worn (N6). The hat pinned here until PR M3 is a worn add, and freezes as one.
    const frozen = freeze("add a crown on her head", []);
    expect(frozen).toEqual({
      ok: false,
      reason: "not_routed",
      askReason: "person_target",
    });
  });
});

describe("C.5 — Q1's measured prompts are the spec: each one's sentence compiles back to its shape", () => {
  /**
   * Q1's five cells (studioModelNativeProbe.ts, DIRECT_CELLS), 6/6 CLEAN. Each sentence below is the
   * cell's own prompt, frozen and compiled the way the product does it, and the expected string is
   * that prompt re-worded in EXACTLY these ways and no others:
   *
   *   "from the second image"  → "from Image 2"     the manifest's own numbering (Image 1 is the frame)
   *   "her"                    → "the person's"     the compiler does not assume a gender
   *   the verb                 → "add …, place it"  one shape for every add verb (q1-a's own)
   *
   * followed by the add's scope sentence and N's preservation clause, unwaived. Anything else that
   * moves in these strings is a change to the prompt the probe measured, and has to be made on purpose.
   */
  // A placed add's instruction ends with the framing line (wave B, addition (a); compile/templates.ts
  // has what measured it). Every string in this block is a prompt the probe measured, so the line is
  // imported rather than retyped: a reword moves the prompt and these pins together or not at all.
  const SCOPE_AND_CLAUSE = (thing: string) =>
    `Keep everything else exactly as-is — only add the ${thing}. ` +
    "Keep the original photograph's lighting, exposure, contrast, colour grade and scene exactly as they are. " +
    ADD_FRAMING_LINE;
  const withBall = [
    {
      role: "object" as const,
      ref: "athletes/synthetic/ball.png",
      mediaAssetId: "ball",
    },
  ];
  const compiled = (ask: string, references: typeof withBall = []) => {
    const frozen = freezeEditIntent({
      ask,
      origin: "system",
      source: source([], { width: 1008, height: 1476 }),
      references,
    });
    if (!frozen.ok) throw new Error(`${ask}: ${frozen.reason}`);
    return compileNativeInstruction(frozen.intent, {
      objectImage: references.length ? 2 : undefined,
    });
  };

  it("q1-a — the acceptance (1) sentence", () => {
    expect(
      compiled(
        "add the soccer ball from the second image, place it between her cleats",
        withBall,
      ),
    ).toBe(
      "add the soccer ball from Image 2, place it between the person's cleats. " +
        SCOPE_AND_CLAUSE("soccer ball"),
    );
  });

  it("q1-b", () => {
    expect(compiled("place this ball at her feet", withBall)).toBe(
      "add the ball from Image 2, place it at the person's feet. " +
        SCOPE_AND_CLAUSE("ball"),
    );
  });

  it("q1-c — a two-part place", () => {
    expect(
      compiled(
        "put the soccer ball from the second image on the grass beside her right foot",
        withBall,
      ),
    ).toBe(
      "add the soccer ball from Image 2, place it on the grass beside the person's right foot. " +
        SCOPE_AND_CLAUSE("soccer ball"),
    );
  });

  it("q1-d — no reference: the object is invented, and the indefinite says so", () => {
    expect(compiled("add a soccer ball at her feet")).toBe(
      "add a soccer ball, place it at the person's feet. " +
        SCOPE_AND_CLAUSE("soccer ball"),
    );
  });

  it("q1-e — the positive control, acceptance (2)", () => {
    expect(
      compiled(
        "place the water bottle from the second image on top of her head",
        withBall,
      ),
    ).toBe(
      "add the water bottle from Image 2, place it on top of the person's head. " +
        SCOPE_AND_CLAUSE("water bottle"),
    );
  });
});

describe("THE COMPILED CALL FOR A COMPOSED SENTENCE — sweep #3's answer key (composition, decisions 5 and 5a)", () => {
  /**
   * Each Part B sentence, frozen and compiled the way the product does it. The addendum's retrieved
   * prompts are the answer key: B-c2's shape ("make the jersey blue, and make the socks red. Keep
   * everything else exactly as-is — change only the jersey and the socks.") for the changes to
   * things, and each operation's own clause for the rest — now ALL of her changes, where Part B sent
   * one. Regions are what detection would label from each sentence's region-bearing clauses.
   */
  const compiled = (ask: string, labels: string[] = []) => {
    const frozen = freeze(
      ask,
      labels.map((l, i) => region(l, { top: 1000 + i * 900 })),
      { width: 1008, height: 1476 },
    );
    if (!frozen.ok) throw new Error(`${ask}: ${frozen.reason}`);
    return {
      intent: frozen.intent,
      text: compileNativeInstruction(frozen.intent),
    };
  };
  const KEEP_LIGHT =
    "Keep the original photograph's lighting, exposure, contrast and colour grade exactly as they are.";

  it("B-c1 compiles the recolour AND the background — main sent 'change the background to stadium' alone", () => {
    expect(
      compiled("make her jersey blue and change the background to a stadium", [
        "blue jersey",
      ]).text,
    ).toBe(
      "make the jersey blue, and change the background to stadium. " +
        "Keep everything else exactly as-is — change only the jersey and the background. " +
        KEEP_LIGHT,
    );
  });

  it("B-p1 compiles the add AND the background — never 'the background to person' (or 'to her feet')", () => {
    const { text } = compiled(
      "Add a soccer ball at the person's feet, and change the background to a packed stadium at night.",
    );
    expect(text).toBe(
      "add a soccer ball, place it at the person s feet, and change the background to packed stadium at night. " +
        "Keep everything else exactly as-is — change only the added soccer ball and the background. " +
        `${KEEP_LIGHT} ${ADD_FRAMING_LINE}`,
    );
    expect(text).not.toMatch(/background to (person|her feet)/);
    // The acceptance's add-combo, in her own phrasing.
    expect(
      compiled(
        "add a soccer ball at her feet and change the background to a packed stadium at night",
      ).text,
    ).toBe(
      "add a soccer ball, place it at the person's feet, and change the background to packed stadium at night. " +
        "Keep everything else exactly as-is — change only the added soccer ball and the background. " +
        `${KEEP_LIGHT} ${ADD_FRAMING_LINE}`,
    );
  });

  it("B-c11 compiles all three — main sent 'change the background to her feet'", () => {
    expect(
      compiled(
        "make her jersey blue, add a soccer ball at her feet, and change the background to a stadium",
        ["blue jersey"],
      ).text,
    ).toBe(
      "make the jersey blue, and add a soccer ball, place it at the person's feet, and change the background to stadium. " +
        "Keep everything else exactly as-is — change only the jersey, the added soccer ball and the background. " +
        `${KEEP_LIGHT} ${ADD_FRAMING_LINE}`,
    );
  });

  it("puts the background LAST in the compiled call — and leaves the steps in run order (5a)", () => {
    // `orderSteps` runs the background (BACKGROUND path) before a removal (MASKED); the compiled call
    // reads it last. The spend-time re-check compares steps, so they are exactly route()'s.
    for (const [ask, labels, expected] of [
      [
        "remove the cleats and change the background to a stadium",
        ["cleats"],
        "remove the cleats and fill the space where it was with what naturally lies behind it, and change the background to stadium. " +
          "Keep everything else exactly as-is — change only the cleats and the background. " +
          KEEP_LIGHT,
      ],
      // B-p4 — "night" reaches the model now; rule 1 used to claim it as a removal.
      [
        "Remove the soccer ball, and change the background to a packed stadium at night.",
        ["soccer ball"],
        "remove the soccer ball and fill the space where it was with what naturally lies behind it, and change the background to packed stadium at night. " +
          "Keep everything else exactly as-is — change only the soccer ball and the background. " +
          KEEP_LIGHT,
      ],
      // B-c12 — three changes, IMAGE_SAFETY on main after "remove the jersey".
      [
        "remove the soccer ball, make her jersey blue, and change the background to a stadium",
        ["soccer ball", "blue jersey"],
        "make the jersey blue, and remove the soccer ball and fill the space where it was with what naturally lies behind it, and change the background to stadium. " +
          "Keep everything else exactly as-is — change only the jersey, the soccer ball and the background. " +
          KEEP_LIGHT,
      ],
    ] as [string, string[], string][]) {
      const { intent, text } = compiled(ask, labels);
      expect({ ask, text }).toEqual({ ask, text: expected });
      expect(text).not.toMatch(/remove the (jersey|background|stadium)/);
      expect(intent.steps).toEqual(route(ask, true).steps);
      expect(intentsAgree(intent, route(ask, true))).toBe(true);
    }
    expect(
      compiled("remove the cleats and change the background to a stadium", [
        "cleats",
      ]).intent.steps.map((s) => s.op),
    ).toEqual(["CHANGE_BACKGROUND", "REMOVE_OBJECT"]);
  });

  it("puts a look after the background, and two adds each in its own place", () => {
    expect(
      compiled("change the background to a beach and make it black and white")
        .text,
    ).toBe(
      "change the background to beach, and give the whole photograph this look: black and white. " +
        "Keep everything else exactly as-is — change only the background and the overall look.",
    );
    expect(
      compiled("add a ball on the bench and add a red bottle on the grass")
        .text,
    ).toBe(
      "add a ball, place it on the bench, and add a red bottle, place it on the grass. " +
        "Keep everything else exactly as-is — only add the ball and the red bottle. " +
        "Keep the original photograph's lighting, exposure, contrast, colour grade and scene exactly as they are. " +
        // TWO adds, ONE framing line: it is a fact about the frame, not about each thing going into it.
        ADD_FRAMING_LINE,
    );
  });
});

describe("asksForRegionFreeEdit — the preview route's question before it spends on detection", () => {
  it("is true for an add, and only an add", () => {
    expect(asksForRegionFreeEdit("put a water bottle on the grass")).toBe(true);
    expect(asksForRegionFreeEdit("make the shorts black and green")).toBe(
      false,
    );
    expect(asksForRegionFreeEdit("change the background to a beach")).toBe(
      false,
    );
  });

  it("is false for an add the classifier refused, and for nothing at all", () => {
    // Refused adds still go the detection way — the freeze then blocks them on the refusal. (A crown,
    // not the hat pinned here until PR M3: a worn add routes, and is region-free like any add.)
    expect(asksForRegionFreeEdit("add a crown on her head")).toBe(false);
    expect(asksForRegionFreeEdit("add a soccer ball")).toBe(false);
    expect(asksForRegionFreeEdit("   ")).toBe(false);
    expect(asksForRegionFreeEdit("add a hat on her head")).toBe(true);
  });

  it("is true for a composed sentence none of whose clauses names a thing in the frame (composition)", () => {
    expect(
      asksForRegionFreeEdit(
        "add a soccer ball at her feet and change the background to a packed stadium at night",
      ),
    ).toBe(true);
    expect(
      asksForRegionFreeEdit(
        "add a ball on the bench and add a red bottle on the grass",
      ),
    ).toBe(true);
    // One clause that names a thing, and detection is asked for it.
    expect(
      asksForRegionFreeEdit(
        "make her jersey blue and change the background to a stadium",
      ),
    ).toBe(false);
  });
});

describe("detectionTextFor — detection reads only the clauses that name a thing in the frame (composition, decision 3)", () => {
  it("sends every sentence rule ½ did not compose EXACTLY as it came — the same string", () => {
    for (const ask of [
      "make the shorts black and green",
      "change the background to a beach",
      "make it black and white",
      "remove the ball and remove the cone",
      "make her jersey blue and her socks red",
      "change my uniform, socks, and shoes all to be adidas",
      // An ask is sent whole, as every ask was: the freeze refuses it on the classifier's own code.
      // (A crown; the hat here until PR M3 is a worn add, so that compound composes now.)
      "do something cool with this",
      "add a crown on her head and make the socks blue",
    ]) {
      expect(detectionTextFor(ask)).toBe(ask);
    }
    expect(detectionTextFor("")).toBe("");
    // A lone add has nothing to find (PR C′).
    expect(detectionTextFor("put a water bottle on the grass")).toBeNull();
  });

  it("sends a composed sentence's region-bearing clauses, in her words and order, and nothing else", () => {
    const table: [string, string | null][] = [
      // B-c1: given whole, detection's background arm would return the frame and drop the jersey.
      [
        "make her jersey blue and change the background to a stadium",
        "make her jersey blue",
      ],
      // B-c11: the add's place ("at her feet") never reaches detection's person rule.
      [
        "make her jersey blue, add a soccer ball at her feet, and change the background to a stadium",
        "make her jersey blue",
      ],
      // B-c7 — the F2 sentence.
      [
        "add a soccer ball at her feet and make her jersey blue",
        "make her jersey blue",
      ],
      // B-c12: two clauses name things in the frame; the background does not.
      [
        "remove the soccer ball, make her jersey blue, and change the background to a stadium",
        "remove the soccer ball and make her jersey blue",
      ],
      // Every clause names something: all of them, glued with "and".
      [
        "change my uniform, socks, and shoes all to be adidas and remove the ball",
        "change my uniform, socks, and shoes all to be adidas and remove the ball",
      ],
      // Nothing to find.
      [
        "add a soccer ball at her feet and change the background to a packed stadium at night",
        null,
      ],
      ["change the background to a beach and make it black and white", null],
    ];
    for (const [ask, detected] of table) {
      expect({ ask, detected: detectionTextFor(ask) }).toEqual({
        ask,
        detected,
      });
    }
  });

  it("checks the echo against what detection was GIVEN — a composed recolour on its clause's echo refuses", () => {
    // "make blue the socks" is a clause whose echo WOULD pair — changeBefore(label, "socks") reads
    // "make blue the" as a colour — so the refusal is the rule's doing, not an accident of pairing.
    const ask = "make blue the socks and change the background to a stadium";
    expect(detectionTextFor(ask)).toBe("make blue the socks");
    expect(changeBefore(labelFor("make blue the socks"), "socks")).toBe(
      "make blue the",
    );
    expect(freeze(ask, [region(labelFor("make blue the socks"))])).toEqual({
      ok: false,
      reason: "echoed_directive",
    });
    // Its own directive freezes, beside the background from the classifier's value.
    const clean = freeze(ask, [region("blue socks")]);
    expect(clean.ok && clean.intent.changes).toEqual([
      { op: "RECOLOR", target: "socks", change: "blue" },
      { op: "CHANGE_BACKGROUND", target: null, change: "stadium" },
    ]);
  });
});

describe("the quoted size is frozen with the intent", () => {
  it("4K on a 24 MP frame, 2K on the 1.5 MP one — smallestImageSizeFor, by rule (PR N, D1)", () => {
    const big = freeze("make the shorts black and green", [
      region("black and green shorts"),
    ]);
    const small = freeze(
      "make the shorts black and green",
      [region("black and green shorts")],
      { width: 1008, height: 1476 },
    );
    expect(big.ok && big.intent.imageSize).toBe("4K");
    expect(small.ok && small.intent.imageSize).toBe("2K");
  });
});

describe("changeBefore — a label's change, only when the label ends with the target", () => {
  it("takes the words before the target, tolerating a plural and a leading article", () => {
    expect(changeBefore("white sports bra", "sports bra")).toBe("white");
    expect(changeBefore("blue and green socks", "sock")).toBe("blue and green");
    expect(changeBefore("a red jersey", "jersey")).toBe("red");
  });

  it("returns null for a bare value, the target alone, or the target anywhere but the end", () => {
    expect(changeBefore("red", "jersey")).toBeNull();
    expect(changeBefore("socks", "socks")).toBeNull();
    expect(changeBefore("jersey in red", "jersey")).toBeNull();
  });
});

// ─── The route's one call ───────────────────────────────────────────────────────────────────────

const SENTENCE = "make the shorts black and green";

function editBrief(statement: string): CreativeBrief {
  return {
    briefId: "b",
    createdAt: "2026-09-10T00:00:00.000Z",
    job: {
      origin: "system",
      objective: "grow-following",
      deliverable: "post",
      mode: "edit",
      source: source([region("black and green shorts")]),
      direction: {
        set: "chosen",
        statement,
        untrusted: false,
        featuredPieces: [],
      },
      references: [],
    },
    athlete: { athleteId: "athlete-1" },
    brand: null,
    gaps: [],
  } as unknown as CreativeBrief;
}

const input = (direction?: string): BriefInput => ({
  athleteId: "athlete-1",
  origin: "system",
  objective: "grow-following",
  deliverable: "post",
  mode: "edit",
  direction,
});

describe("withNativeEditIntent — the preview route's one call", () => {
  afterEach(() => {
    delete process.env.STUDIO_NATIVE_EDIT;
  });

  it("returns the SAME brief with the flag off — flag-off briefs are byte-identical", () => {
    const b = editBrief(SENTENCE);
    expect(
      withNativeEditIntent(b, input(SENTENCE), { regions: "derived" }),
    ).toBe(b);
  });

  it("leaves a box she DREW alone with the flag on — explicit spatial intent routes masked", () => {
    process.env.STUDIO_NATIVE_EDIT = "true";
    const b = editBrief(SENTENCE);
    expect(withNativeEditIntent(b, input(SENTENCE), { regions: "drawn" })).toBe(
      b,
    );
    expect(withNativeEditIntent(b, input(SENTENCE), { regions: "none" })).toBe(
      b,
    );
  });

  it("freezes the intent onto the brief for a sentence detection derived regions from", () => {
    process.env.STUDIO_NATIVE_EDIT = "true";
    const out = withNativeEditIntent(editBrief(SENTENCE), input(SENTENCE), {
      regions: "derived",
    });
    expect(out.job.editIntent?.changes).toEqual([
      { op: "RECOLOR", target: "shorts", change: "black and green" },
    ]);
    expect(out.gaps).toEqual([]);
  });

  it("blocks — never falls back — when the freeze refuses", () => {
    process.env.STUDIO_NATIVE_EDIT = "true";
    const b = editBrief("do something cool with this");
    const out = withNativeEditIntent(b, input("do something cool with this"), {
      regions: "derived",
    });
    expect(out.job.editIntent).toBeUndefined();
    expect(out.gaps).toEqual([
      expect.objectContaining({ field: "job.direction", severity: "blocking" }),
    ]);
  });

  describe("B.1c — a brand change that DROPPED her words runs native, or not at all", () => {
    const MODEL = "swap the cleats for Nike Mercurials";
    const blocking = {
      field: "job.direction",
      note: 'Studio can\'t match a specific model or extra details here. Say it without them — "swap my cleats for nike".',
      severity: "blocking",
    };

    it("freezes natively — flag on, regions derived — carrying the dropped words for the preview", () => {
      process.env.STUDIO_NATIVE_EDIT = "true";
      const out = withNativeEditIntent(editBrief(MODEL), input(MODEL), {
        regions: "derived",
      });
      expect(out.job.editIntent?.changes).toEqual([
        { op: "REPLACE_OBJECT", target: "cleats", change: "nike cleats" },
      ]);
      expect(out.job.editIntent?.steps[0].dropped).toEqual(["mercurials"]);
      expect(out.gaps).toEqual([]);
    });

    it("BLOCKS with the flag off — the masked stack would put the model back in front of the model", () => {
      const out = withNativeEditIntent(editBrief(MODEL), input(MODEL), {
        regions: "derived",
      });
      expect(out.job.editIntent).toBeUndefined();
      expect(out.gaps).toEqual([blocking]);
    });

    it("BLOCKS on a box she drew, even with the flag on — a drawn box runs masked", () => {
      process.env.STUDIO_NATIVE_EDIT = "true";
      const out = withNativeEditIntent(editBrief(MODEL), input(MODEL), {
        regions: "drawn",
      });
      expect(out.gaps).toEqual([blocking]);
    });

    it("moves nothing that drops nothing — a whole brand change is the SAME brief with the flag off", () => {
      const WHOLE = "change my jersey to adidas";
      const b = editBrief(WHOLE);
      expect(
        withNativeEditIntent(b, input(WHOLE), { regions: "derived" }),
      ).toBe(b);
      process.env.STUDIO_NATIVE_EDIT = "true";
      expect(withNativeEditIntent(b, input(WHOLE), { regions: "drawn" })).toBe(
        b,
      );
    });
  });

  describe("THE REGION-FREE ARM — an add, measured and never detected (PR C′)", () => {
    const ADD = "put a water bottle on the grass";
    const NO_REGIONS: BriefGap = {
      field: NO_EDIT_REGIONS_FIELD,
      note: "No edit regions measured, …",
      severity: "blocking",
    };
    /** What assembleBrief hands back for an add: the frame measured, no regions, the gap raised. */
    const addBrief = (): CreativeBrief => {
      const b = editBrief(ADD);
      return {
        ...b,
        job: { ...b.job, source: source([], { width: 1008, height: 1476 }) },
        gaps: [NO_REGIONS],
      };
    };

    it("BLOCKS with the flag off — there is no masked add, and nothing falls back", () => {
      const out = withNativeEditIntent(addBrief(), input(ADD), {
        regions: "region-free",
      });
      expect(out.job.editIntent).toBeUndefined();
      // Its own honest note, and NOT the no-regions gap — whose surface copy is "mark the part of
      // the photo you want changed", which is not true of an add.
      expect(out.gaps).toEqual([
        {
          field: "job.direction",
          note: freezeRefusalNote({ ok: false, reason: "native_edit_off" }),
          severity: "blocking",
        },
      ]);
    });

    it("freezes the add with the flag on — and KEEPS the no-regions gap for the preview to waive", () => {
      process.env.STUDIO_NATIVE_EDIT = "true";
      const out = withNativeEditIntent(addBrief(), input(ADD), {
        regions: "region-free",
      });
      expect(out.job.editIntent?.changes[0]?.op).toBe("ADD_OBJECT");
      // Kept, so a brief that loses its intent blocks again. The waiver is previewGeneration's, read
      // off the frozen intent on every call (studio/preview.ts, waivedByIntent).
      expect(out.gaps).toEqual([NO_REGIONS]);
    });

    it("blocks on the refusal, not on the region gap, when the freeze refuses", () => {
      process.env.STUDIO_NATIVE_EDIT = "true";
      // A crown on her head refuses (not worn, N6); the hat here until PR M3 freezes as a worn add.
      const out = withNativeEditIntent(
        addBrief(),
        input("add a crown on her head"),
        { regions: "region-free" },
      );
      expect(out.job.editIntent).toBeUndefined();
      expect(out.gaps.map((g) => g.field)).toEqual(["job.direction"]);
    });
  });

  describe("COMPOSITION — a composed sentence runs native or not at all (6a), and its add takes her Object photo", () => {
    const COMPOSED = "add a soccer ball at her feet and make her jersey blue";
    const LONE_ADD = "add a soccer ball at her feet";
    const BALL = {
      role: "object" as const,
      ref: "athletes/synthetic/ball.png",
      mediaAssetId: "ball-asset",
    };
    /** What assembleBrief hands back when detection found the jersey, with her ball photo attached. */
    const composedBrief = (references = [BALL]): CreativeBrief => {
      const b = editBrief(COMPOSED);
      return {
        ...b,
        job: {
          ...b.job,
          source: source([region("blue jersey")], {
            width: 1008,
            height: 1476,
          }),
          references,
        },
      };
    };
    const blockedWith = (reason: "compound_off_native") => [
      {
        field: "job.direction",
        note: freezeRefusalNote({ ok: false, reason }),
        severity: "blocking",
      },
    ];

    it("THE DERIVED ARM PASSES HER PHOTOS — an add inside a compound takes her Object photo, same as a lone add", () => {
      process.env.STUDIO_NATIVE_EDIT = "true";
      // Beside a recolour detection ran, so the composed sentence freezes on the DERIVED arm. That arm
      // used to call the freeze without her references, and the add invented a ball she had attached.
      const composed = withNativeEditIntent(composedBrief(), input(COMPOSED), {
        regions: "derived",
      });
      expect(composed.job.editIntent?.changes).toEqual([
        {
          op: "ADD_OBJECT",
          target: null,
          change: null,
          add: {
            thing: "soccer ball",
            place: "at her feet",
            objectAssetId: "ball-asset",
          },
        },
        { op: "RECOLOR", target: "jersey", change: "blue" },
      ]);
      // The lone add, on its own arm, freezes the same photo for the same thing.
      const lone = withNativeEditIntent(
        { ...composedBrief(), gaps: [] },
        input(LONE_ADD),
        { regions: "region-free" },
      );
      expect(lone.job.editIntent?.changes[0].add).toEqual(
        composed.job.editIntent?.changes[0].add,
      );
    });

    it("BLOCKS with the flag off — the masked stack would re-read her whole sentence", () => {
      const out = withNativeEditIntent(composedBrief(), input(COMPOSED), {
        regions: "derived",
      });
      expect(out.job.editIntent).toBeUndefined();
      expect(out.gaps).toEqual(blockedWith("compound_off_native"));
    });

    it("BLOCKS on a box she drew, even with the flag on — a drawn box runs masked", () => {
      process.env.STUDIO_NATIVE_EDIT = "true";
      const out = withNativeEditIntent(composedBrief(), input(COMPOSED), {
        regions: "drawn",
      });
      expect(out.gaps).toEqual(blockedWith("compound_off_native"));
    });

    it("BLOCKS a composed region-free sentence with the flag off in its own words, not the add's", () => {
      const TWO_ADDS =
        "add a ball on the bench and add a red bottle on the grass";
      const out = withNativeEditIntent(
        { ...composedBrief([]), gaps: [] },
        input(TWO_ADDS),
        { regions: "region-free" },
      );
      expect(out.gaps).toEqual(blockedWith("compound_off_native"));
    });

    it("says so honestly — one change at a time, and nothing was spent", () => {
      expect(
        freezeRefusalNote({ ok: false, reason: "compound_off_native" }),
      ).toBe(
        "Studio can't make more than one change at once here, so this edit can't run — try each change on its own. Nothing was spent.",
      );
    });

    it("keeps B.1c's note for a composed brand clause that dropped her words — the more specific of the two (plan §4.4)", () => {
      const MODEL = "swap the cleats for Nike Mercurials and remove the ball";
      const out = withNativeEditIntent(editBrief(MODEL), input(MODEL), {
        regions: "derived",
      });
      expect(out.gaps).toEqual([
        {
          field: "job.direction",
          note: freezeRefusalNote({
            ok: false,
            reason: "dropped_words_off_native",
          }),
          severity: "blocking",
        },
      ]);
      // And with the flag on it freezes, carrying the dropped words for the disclosure.
      process.env.STUDIO_NATIVE_EDIT = "true";
      const native = withNativeEditIntent(editBrief(MODEL), input(MODEL), {
        regions: "derived",
      });
      expect(native.job.editIntent?.steps[0].dropped).toEqual(["mercurials"]);
    });

    it("moves nothing it does not compose — a composed sentence that ASKS anyway is left like every other ask", () => {
      // The person guard refuses a composed step, so there is no intent: flag off, the SAME brief —
      // exactly what "do something cool with this" gets. (A crown; the hat here until PR M3 is worn.)
      const ASKS = "add a crown on her head and make the socks blue";
      expect(route(ASKS, true).initialPath).toBe("ASK");
      const b = editBrief(ASKS);
      expect(withNativeEditIntent(b, input(ASKS), { regions: "derived" })).toBe(
        b,
      );
    });
  });

  describe("THE HARD CONSTRAINT — the words are explicitAsk(input), never direction.statement", () => {
    it("freezes from her typed words even when the statement says something else", () => {
      process.env.STUDIO_NATIVE_EDIT = "true";
      // The statement is directionFor's boilerplate; her input is the sentence.
      const b = editBrief(
        "Grow her audience with something that reads as hers, not as an ad",
      );
      const out = withNativeEditIntent(b, input(SENTENCE), {
        regions: "derived",
      });
      expect(out.job.editIntent?.steps[0].targets).toEqual(["shorts"]);
    });

    it("freezes NOTHING when she typed nothing, however routable the statement looks", () => {
      process.env.STUDIO_NATIVE_EDIT = "true";
      const b = editBrief(SENTENCE); // a statement that WOULD classify as a recolour
      const out = withNativeEditIntent(b, input(undefined), {
        regions: "derived",
      });
      expect(out.job.editIntent).toBeUndefined();
      expect(out.gaps.some((g) => g.severity === "blocking")).toBe(true);
    });
  });
});

// ─── REPLACE WITH REFERENCE, R.1 — the freeze takes her Object photo, by role, for what she pointed at ──

describe("REPLACE WITH REFERENCE, R.1 — the freeze takes her Object photo by role, for the replacement she pointed at", () => {
  const FOUNDER = "change my earrings to these gold hoops";
  const HOOPS = {
    role: "object" as const,
    ref: "athletes/synthetic/hoops.png",
    mediaAssetId: "hoops-asset",
  };
  const BALL = {
    role: "object" as const,
    ref: "athletes/synthetic/ball.png",
    mediaAssetId: "ball-asset",
  };
  const BOOT = {
    role: "product" as const,
    ref: "athletes/synthetic/boot.png",
    mediaAssetId: "boot-asset",
  };
  const TEACHING =
    'Attach a photo of the thing you want with the Product or Object tile — or describe it instead, like "make my earrings gold".';
  const freezeWith = (
    ask: string,
    references: (typeof HOOPS | typeof BOOT)[],
    regions: EditRegion[] = [],
  ) =>
    freezeEditIntent({
      ask,
      origin: "system",
      source: source(regions, { width: 1008, height: 1476 }),
      references,
    });
  const noteOf = (frozen: ReturnType<typeof freezeWith>) =>
    freezeRefusalNote(frozen as Extract<typeof frozen, { ok: false }>);

  it("freezes the Object photo's asset id onto the replacement, and marks the step as hers", () => {
    const frozen = freezeWith(FOUNDER, [HOOPS]);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    expect(frozen.intent.changes).toEqual([
      {
        op: "REPLACE_OBJECT",
        target: "earrings",
        change: "gold hoops",
        object: { objectAssetId: "hoops-asset" },
      },
    ]);
    expect(frozen.intent.steps[0].reference).toBe("object");
    // No region label read: the change is her words, and the photo is what they point at.
    expect(compileNativeInstruction(frozen.intent)).toMatch(
      /^replace the earrings with the gold hoops from the object image\. /,
    );
  });

  it("ASKS with no photo — the teaching line, never a description frozen in its place", () => {
    const frozen = freezeWith(FOUNDER, []);
    expect(frozen).toEqual({
      ok: false,
      reason: "not_routed",
      askReason: "object_photo_missing",
    });
    expect(noteOf(frozen)).toBe(TEACHING);
  });

  // ⚠️ FLIPPED BY CARD 4. This read "counts a PRODUCT photo as no photo of the thing — the role
  // decides, not the slot", and asserted the ask. The role still decides; what changed is which roles
  // count. With the Object tile empty her one product IS the thing, bound automatically and disclosed
  // before she pays — the same pattern C3 shipped for an add.
  it("takes her PRODUCT photo as the thing when the Object tile is empty (card 4)", () => {
    const frozen = freezeWith(FOUNDER, [BOOT]);
    expect(frozen.ok).toBe(true);
    expect(frozen.ok && frozen.intent.changes).toEqual([
      {
        op: "REPLACE_OBJECT",
        target: "earrings",
        change: "gold hoops",
        object: { objectAssetId: BOOT.mediaAssetId },
      },
    ]);
  });

  it("still asks when NEITHER tile has a photo — the pointer has nothing to point at (card 4)", () => {
    expect(freezeWith(FOUNDER, [])).toEqual({
      ok: false,
      reason: "not_routed",
      askReason: "object_photo_missing",
    });
  });

  it("REFUSES two object photos — which one is the hoops is not guessed — in words about choosing, not adding", () => {
    const frozen = freezeWith(FOUNDER, [HOOPS, BALL]);
    expect(frozen).toEqual({
      ok: false,
      reason: "ambiguous_object",
      replaces: 1,
    });
    expect(noteOf(frozen)).toBe(
      "More than one object photo is attached, and it isn't clear which one to use. Keep the one you want and check again.",
    );
    expect(noteOf(frozen)).not.toMatch(/add/i);
  });

  it("REFUSES one photo read by two changes — an add beside it, or a second pointed replacement", () => {
    const withAdd = freezeWith(
      "add a soccer ball at her feet and change my earrings to these gold hoops",
      [HOOPS],
    );
    expect(withAdd).toEqual({
      ok: false,
      reason: "ambiguous_object",
      replaces: 1,
      adds: 1,
    });
    const twoPointed = freezeWith(
      "change my earrings to these gold hoops and change the soccer ball to this one",
      [HOOPS],
    );
    expect(twoPointed).toEqual({
      ok: false,
      reason: "ambiguous_object",
      replaces: 2,
    });
    // One line for both, true of each — and not the add's "remove the photo and the edit will invent
    // them", which is false of a replacement: without the photo it asks.
    for (const f of [withAdd, twoPointed]) {
      expect(noteOf(f)).toBe(
        "This takes more than one thing from attached photos, and which photo is for which change isn't clear. Make those changes one at a time.",
      );
    }
  });

  it("hands the photo to the pointed replacement only — a brand change beside it names its brand, not her photo", () => {
    const frozen = freezeWith(
      "change my jersey to adidas and change the soccer ball to this one",
      [BALL],
    );
    expect(frozen.ok && frozen.intent.changes).toEqual([
      { op: "REPLACE_OBJECT", target: "jersey", change: "adidas jersey" },
      {
        op: "REPLACE_OBJECT",
        target: "soccer ball",
        change: "soccer ball",
        object: { objectAssetId: "ball-asset" },
      },
    ]);
  });

  it("freezes a pointed replacement inside a compound, the recolour's colour from its own label", () => {
    const frozen = freezeWith(
      "change the soccer ball to this one and make her jersey blue",
      [BALL],
      [region("blue jersey")],
    );
    expect(frozen.ok && frozen.intent.changes).toEqual([
      { op: "RECOLOR", target: "jersey", change: "blue" },
      {
        op: "REPLACE_OBJECT",
        target: "soccer ball",
        change: "soccer ball",
        object: { objectAssetId: "ball-asset" },
      },
    ]);
  });

  it("asks detection for what the photo decides — the pointed thing is in the frame, so it is detected", () => {
    const COMPOUND =
      "change the soccer ball to this one and make her jersey blue";
    expect(detectionTextFor(FOUNDER, { objects: 1 })).toBe(FOUNDER);
    expect(detectionTextFor(COMPOUND, { objects: 1 })).toBe(
      "change the soccer ball to this one and make her jersey blue",
    );
    // With no photo the sentence asks, and asks are sent as they came — like every other ask.
    expect(detectionTextFor(COMPOUND)).toBe(COMPOUND);
  });

  describe("withNativeEditIntent — native, or not at all", () => {
    afterEach(() => {
      delete process.env.STUDIO_NATIVE_EDIT;
    });
    const pointedBrief = (references: (typeof HOOPS)[] = [HOOPS]) => {
      const b = editBrief(FOUNDER);
      return {
        ...b,
        job: {
          ...b.job,
          source: source([region("gold hoop earrings")], {
            width: 1008,
            height: 1476,
          }),
          references,
        },
      } as CreativeBrief;
    };
    const blockedWith = (note: string) => [
      { field: "job.direction", note, severity: "blocking" },
    ];
    const OFF_NATIVE =
      "Studio can't use an attached photo for a change here, so this edit can't run — describe it in words instead, like \"make my earrings gold\". Nothing was spent.";

    it("freezes on the derived arm with the flag on — her photo carried into the intent", () => {
      process.env.STUDIO_NATIVE_EDIT = "true";
      const out = withNativeEditIntent(pointedBrief(), input(FOUNDER), {
        regions: "derived",
      });
      expect(out.job.editIntent?.changes[0].object).toEqual({
        objectAssetId: "hoops-asset",
      });
      expect(out.gaps).toEqual([]);
    });

    it("BLOCKS with the flag off — the masked stack would send her photo and never name it", () => {
      const out = withNativeEditIntent(pointedBrief(), input(FOUNDER), {
        regions: "derived",
      });
      expect(out.job.editIntent).toBeUndefined();
      expect(out.gaps).toEqual(blockedWith(OFF_NATIVE));
      expect(
        freezeRefusalNote({ ok: false, reason: "reference_off_native" }),
      ).toBe(OFF_NATIVE);
    });

    it("BLOCKS on a box she drew, even with the flag on — a drawn box runs masked", () => {
      process.env.STUDIO_NATIVE_EDIT = "true";
      const out = withNativeEditIntent(pointedBrief(), input(FOUNDER), {
        regions: "drawn",
      });
      expect(out.gaps).toEqual(blockedWith(OFF_NATIVE));
    });

    it("BLOCKS with the teaching line when no photo is attached — on every arm, so nothing runs it as a description", () => {
      for (const flag of [undefined, "true"]) {
        if (flag) process.env.STUDIO_NATIVE_EDIT = flag;
        for (const regions of ["derived", "drawn"] as const) {
          const out = withNativeEditIntent(pointedBrief([]), input(FOUNDER), {
            regions,
          });
          expect({ flag, regions, gaps: out.gaps }).toEqual({
            flag,
            regions,
            gaps: blockedWith(TEACHING),
          });
        }
      }
    });

    it("keeps the compound's note for a composed sentence that points — the more specific of the two", () => {
      const COMPOUND =
        "change the soccer ball to this one and make her jersey blue";
      const out = withNativeEditIntent(
        { ...pointedBrief([BALL] as (typeof HOOPS)[]) },
        input(COMPOUND),
        { regions: "derived" },
      );
      expect(out.gaps).toEqual(
        blockedWith(
          freezeRefusalNote({ ok: false, reason: "compound_off_native" }),
        ),
      );
    });

    it("moves nothing that does not point — a description is the SAME brief with the flag off", () => {
      const DESCRIBED = "change my earrings to gold hoops";
      const b = editBrief(DESCRIBED);
      expect(
        withNativeEditIntent(b, input(DESCRIBED), { regions: "derived" }),
      ).toBe(b);
    });
  });
});

// ─── PR T, T.1 — a headline freezes with no region, and only behind its switch ────────────────────

describe("PR T, T.1 — a headline freezes with no region and nothing detected, only behind STUDIO_DISPLAY_TEXT", () => {
  const HEADLINE = 'add the headline "OWN THE MOMENT" across the top';
  const saved = process.env.STUDIO_DISPLAY_TEXT;
  afterEach(() => {
    if (saved === undefined) delete process.env.STUDIO_DISPLAY_TEXT;
    else process.env.STUDIO_DISPLAY_TEXT = saved;
    delete process.env.STUDIO_NATIVE_EDIT;
  });

  it("freezes ONE headline, her words as its change — and detection is asked nothing for it", () => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
    expect(freeze(HEADLINE, [], { width: 1008, height: 1476 })).toEqual({
      ok: true,
      intent: {
        version: 1,
        initialPath: "FULL_IMAGE",
        steps: [
          {
            op: "DISPLAY_TEXT",
            targets: [],
            value: "OWN THE MOMENT",
            scope: "GLOBAL",
          },
        ],
        changes: [
          { op: "DISPLAY_TEXT", target: null, change: "OWN THE MOMENT" },
        ],
        imageSize: "2K",
      },
    });
    // The preview route's question before it spends on detection: the op names no region.
    expect(detectionTextFor(HEADLINE)).toBeNull();
    expect(asksForRegionFreeEdit(HEADLINE)).toBe(true);
  });

  it("with the switch OFF, freezes nothing and asks as main did — detection reads her sentence, as it does for any ask", () => {
    delete process.env.STUDIO_DISPLAY_TEXT;
    expect(freeze(HEADLINE, [region("thing")])).toEqual({
      ok: false,
      reason: "not_routed",
      askReason: "add_unclear",
    });
    expect(detectionTextFor(HEADLINE)).toBe(HEADLINE);
    expect(asksForRegionFreeEdit(HEADLINE)).toBe(false);
  });

  it("sends detection a kit swap's clause beside it, and never the headline's", () => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
    expect(
      detectionTextFor(`change my jersey to an adidas jersey and ${HEADLINE}`),
    ).toBe("change my jersey to an adidas jersey");
    expect(
      detectionTextFor(`change the background to a stadium and ${HEADLINE}`),
    ).toBeNull();
  });

  it("refuses a headline whose own words make the generate ask — rule 0 claims it, and a GENERATE on a photo never freezes", () => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
    expect(
      freeze('add the headline "MAKE A NEW POST" across the top', [
        region("thing"),
      ]),
    ).toEqual({ ok: false, reason: "generate_on_edit" });
  });

  it("freezes on the region-free arm with the native switch on, and blocks as an add does with it off — there is no masked headline", () => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
    const b = editBrief(HEADLINE);
    const measured = { ...b, job: { ...b.job, source: source([]) } };
    delete process.env.STUDIO_NATIVE_EDIT;
    const off = withNativeEditIntent(measured, input(HEADLINE), {
      regions: "region-free",
    });
    expect(off.job.editIntent).toBeUndefined();
    expect(off.gaps).toEqual([
      {
        field: "job.direction",
        note: freezeRefusalNote({ ok: false, reason: "native_edit_off" }),
        severity: "blocking",
      },
    ]);
    process.env.STUDIO_NATIVE_EDIT = "true";
    const on = withNativeEditIntent(measured, input(HEADLINE), {
      regions: "region-free",
    });
    expect(on.job.editIntent?.changes).toEqual([
      { op: "DISPLAY_TEXT", target: null, change: "OWN THE MOMENT" },
    ]);
    expect(on.gaps).toEqual([]);
  });

  it("reproduces at spend time only while the switch is on — off, the re-check asks and the frozen headline does not agree", () => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
    const frozen = freeze(HEADLINE, []);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    expect(intentsAgree(frozen.intent, route(HEADLINE, true))).toBe(true);
    delete process.env.STUDIO_DISPLAY_TEXT;
    expect(route(HEADLINE, true).initialPath).toBe("ASK");
    expect(intentsAgree(frozen.intent, route(HEADLINE, true))).toBe(false);
  });
});

// ─── PR T, T.2 — an out-of-bounds headline blocks with its own line ───────────────────────────────

describe("PR T, T.2 — an out-of-bounds headline freezes nothing, and says what was wrong with the words", () => {
  const saved = process.env.STUDIO_DISPLAY_TEXT;
  afterEach(() => {
    if (saved === undefined) delete process.env.STUDIO_DISPLAY_TEXT;
    else process.env.STUDIO_DISPLAY_TEXT = saved;
  });

  it("refuses each bound with headline_bounds, and the note is the client's line verbatim", () => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
    for (const words of [
      "WE RUN THIS CITY TONIGHT",
      "CHAMPIONSHIP SEASONS 2026",
      "WIN, TOGETHER",
      "NIKE FOREVER",
      "JUST DO IT",
    ]) {
      const refused = freeze(`add the headline "${words}" across the top`, [
        region("thing"),
      ]);
      expect({ words, refused }).toEqual({
        words,
        refused: {
          ok: false,
          reason: "not_routed",
          askReason: "headline_bounds",
        },
      });
    }
    // client/lib/studio-contract.ts, askCopyFor("headline_bounds") — the same words, pinned there too.
    expect(
      freezeRefusalNote({
        ok: false,
        reason: "not_routed",
        askReason: "headline_bounds",
      }),
    ).toBe(
      "A headline can be up to four words and 24 characters, in plain letters and numbers, and can't use a brand's name or slogan. Try another line of your own.",
    );
  });

  it("refuses two headlines as a conflict, with the conflict's own line", () => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
    const refused = freeze(
      'add the headline "OWN THE MOMENT" across the top and add the headline "GET LOUD" across the top',
      [],
    );
    expect(refused).toEqual({
      ok: false,
      reason: "not_routed",
      askReason: "compound_conflict",
    });
  });
});

// ─── PR T, T.6 — a headline runs native, or not at all ─────────────────────────────────────────────

describe("PR T, T.6 — a headline on a box she drew BLOCKS (text_off_native), the attached-photo pattern", () => {
  const HEADLINE = 'add the headline "OWN THE MOMENT" across the top';
  const NOTE =
    "Studio adds a headline across the top of the whole photo, never inside an area you marked, so this edit can't run — send it again without marking an area. Nothing was spent.";
  const blockedWith = (note: string) => [
    { field: "job.direction", note, severity: "blocking" },
  ];
  const saved = process.env.STUDIO_DISPLAY_TEXT;
  afterEach(() => {
    if (saved === undefined) delete process.env.STUDIO_DISPLAY_TEXT;
    else process.env.STUDIO_DISPLAY_TEXT = saved;
    delete process.env.STUDIO_NATIVE_EDIT;
  });

  it("BLOCKS on a box she drew, with the native switch on or off — the masked stack would crop and composite a banner", () => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
    for (const native of [undefined, "true"]) {
      if (native) process.env.STUDIO_NATIVE_EDIT = native;
      else delete process.env.STUDIO_NATIVE_EDIT;
      const out = withNativeEditIntent(editBrief(HEADLINE), input(HEADLINE), {
        regions: "drawn",
      });
      expect({ native, intent: out.job.editIntent, gaps: out.gaps }).toEqual({
        native,
        intent: undefined,
        gaps: blockedWith(NOTE),
      });
    }
    expect(freezeRefusalNote({ ok: false, reason: "text_off_native" })).toBe(
      NOTE,
    );
  });

  it("with STUDIO_DISPLAY_TEXT off, returns the SAME brief for a box she drew — the sentence and its arm are main's", () => {
    delete process.env.STUDIO_DISPLAY_TEXT;
    process.env.STUDIO_NATIVE_EDIT = "true";
    const b = editBrief(HEADLINE);
    expect(withNativeEditIntent(b, input(HEADLINE), { regions: "drawn" })).toBe(
      b,
    );
  });

  it("keeps the compound's note for a composed headline on a box — the more specific of the two", () => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
    process.env.STUDIO_NATIVE_EDIT = "true";
    const COMPOUND = `change the background to a stadium and ${HEADLINE}`;
    const out = withNativeEditIntent(editBrief(COMPOUND), input(COMPOUND), {
      regions: "drawn",
    });
    expect(out.gaps).toEqual(
      blockedWith(
        freezeRefusalNote({ ok: false, reason: "compound_off_native" }),
      ),
    );
  });

  it("lets the derived native arm through untouched — a kit swap beside a headline freezes both", () => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
    process.env.STUDIO_NATIVE_EDIT = "true";
    const SWAP = `change my jersey to an adidas jersey and ${HEADLINE}`;
    const out = withNativeEditIntent(editBrief(SWAP), input(SWAP), {
      regions: "derived",
    });
    expect(out.job.editIntent?.changes.map((c) => c.op)).toEqual([
      "REPLACE_OBJECT",
      "DISPLAY_TEXT",
    ]);
    expect(out.gaps).toEqual([]);
  });
});

// ─── The interpreter's constraints, frozen beside her changes (I.1) ─────────────────────────────

describe("constraints freeze beside the changes — version 2 with them, version 1 byte-identical without (the interpreter, I.1)", () => {
  afterEach(() => {
    delete process.env.STUDIO_NATIVE_EDIT;
  });

  const SHORTS = [region("black and green shorts")];

  it("freezes version 1 with no constraints key when none ride — the intent every earlier preview froze", () => {
    const plain = freeze(SENTENCE, SHORTS);
    const none = freezeEditIntent({
      ask: SENTENCE,
      origin: "system",
      source: source(SHORTS),
      constraints: [],
    });
    if (!plain.ok || !none.ok) throw new Error("both must freeze");
    expect(JSON.stringify(none.intent)).toBe(JSON.stringify(plain.intent));
    expect(plain.intent.version).toBe(1);
    expect("constraints" in plain.intent).toBe(false);
  });

  it("freezes version 2 carrying them in canonical order — and the steps and changes are the sentence's alone", () => {
    const plain = freeze(SENTENCE, SHORTS);
    const kept = freezeEditIntent({
      ask: SENTENCE,
      origin: "system",
      source: source(SHORTS),
      constraints: [
        { kind: "exclude_marks", brand: "nike" },
        { kind: "preserve_person" },
      ],
    });
    if (!plain.ok || !kept.ok) throw new Error("both must freeze");
    expect(kept.intent.version).toBe(2);
    expect(kept.intent.constraints).toEqual([
      { kind: "preserve_person" },
      { kind: "exclude_marks", brand: "nike" },
    ]);
    expect(kept.intent.steps).toEqual(plain.intent.steps);
    expect(kept.intent.changes).toEqual(plain.intent.changes);
  });

  it("refuses constraints that are not exactly the closed shapes — it never freezes the changes without them", () => {
    const cases: Record<string, unknown[]> = {
      "a constraint carrying a step": [
        { kind: "preserve_person", op: "REMOVE_OBJECT", targets: ["jersey"] },
      ],
      "an exclusion of her": [{ kind: "exclude_marks", brand: "the person" }],
      "the same one twice": [
        { kind: "preserve_person" },
        { kind: "preserve_person" },
      ],
      "an unknown kind": [{ kind: "keep_background" }],
    };
    for (const [name, constraints] of Object.entries(cases)) {
      const r = freezeEditIntent({
        ask: SENTENCE,
        origin: "system",
        source: source(SHORTS),
        constraints: constraints as never,
      });
      expect({ name, r }).toEqual({
        name,
        r: { ok: false, reason: "invalid_constraints" },
      });
    }
  });

  it("carries them through the route's one call — on the derived arm and on the region-free one", () => {
    process.env.STUDIO_NATIVE_EDIT = "true";
    const derived = withNativeEditIntent(editBrief(SENTENCE), input(SENTENCE), {
      regions: "derived",
      constraints: [{ kind: "preserve_person" }],
    });
    expect(derived.job.editIntent?.version).toBe(2);
    expect(derived.job.editIntent?.constraints).toEqual([
      { kind: "preserve_person" },
    ]);
    const ADD = "add a soccer ball at her feet";
    const free = withNativeEditIntent(editBrief(ADD), input(ADD), {
      regions: "region-free",
      constraints: [{ kind: "preserve_person" }],
    });
    expect(free.job.editIntent?.version).toBe(2);
    expect(free.job.editIntent?.changes.map((c) => c.op)).toEqual([
      "ADD_OBJECT",
    ]);
  });
});

// ─── Her keep, beside an edit the rules read (A3b; sweep-4 ledger F-L2) ─────────────────────────────

describe("her keep beside a sentence that routes freezes as preserve_person — never a target, never region text (A3b)", () => {
  const KEEP =
    "Keep the person's face, hair, body and pose exactly as they are.";

  it("freezes the three repros as their look, version 2, with the keep sentence — never 'make the same golden'", () => {
    for (const [ask, look] of [
      ["make it warmer, dont change anything about me", "warmer"],
      ["make it golden hour, keep me the same", "golden hour"],
      ["make it black and white, keep me the same", "black and white"],
    ]) {
      const frozen = freeze(ask, []);
      if (!frozen.ok) throw new Error(`"${ask}" refused: ${frozen.reason}`);
      expect({
        ask,
        version: frozen.intent.version,
        changes: frozen.intent.changes,
        constraints: frozen.intent.constraints,
      }).toEqual({
        ask,
        version: 2,
        changes: [{ op: "GLOBAL_STYLE", target: null, change: look }],
        constraints: [{ kind: "preserve_person" }],
      });
      const text = compileNativeInstruction(frozen.intent);
      expect({ ask, keeps: text.endsWith(KEEP) }).toEqual({ ask, keeps: true });
      expect({ ask, same: /the same/.test(text) }).toEqual({
        ask,
        same: false,
      });
    }
  });

  it("removes the cone, and only the cone — main compiled 'remove the same' beside it", () => {
    const frozen = freeze("remove the cone and keep me the same", [
      region("cone"),
    ]);
    if (!frozen.ok) throw new Error(`refused: ${frozen.reason}`);
    expect(frozen.intent.changes).toEqual([
      { op: "REMOVE_OBJECT", target: "cone", change: null },
    ]);
    expect(frozen.intent.constraints).toEqual([{ kind: "preserve_person" }]);
  });

  it("sends detection only the words the rules read — her keep is never region text", () => {
    expect(detectionTextFor("make my jersey blue and keep me the same")).toBe(
      "make my jersey blue",
    );
    expect(
      detectionTextFor("remove the cone, dont change anything about me"),
    ).toBe("remove the cone");
    expect(
      detectionTextFor(
        "make her jersey blue and change the background to a stadium, keep me the same",
      ),
    ).toBe("make her jersey blue");
    // An ask is the interpreter's, and is sent as it came, as before.
    expect(
      detectionTextFor("make it moodier, dont change anything about me"),
    ).toBe("make it moodier, dont change anything about me");
  });

  it("still refuses a recolour whose region echoes her whole sentence OR the words the rules read", () => {
    const ask = "make my jersey blue and keep me the same";
    for (const label of [labelFor(ask), labelFor("make my jersey blue")]) {
      expect({ label, frozen: freeze(ask, [region(label)]) }).toEqual({
        label,
        frozen: { ok: false, reason: "echoed_directive" },
      });
    }
    const frozen = freeze(ask, [region("blue jersey")]);
    if (!frozen.ok) throw new Error(`refused: ${frozen.reason}`);
    expect(frozen.intent.changes).toEqual([
      { op: "RECOLOR", target: "jersey", change: "blue" },
    ]);
    expect(frozen.intent.constraints).toEqual([{ kind: "preserve_person" }]);
  });

  it("freezes her keep once, whichever door it came through, beside any constraint the interpreter hands in", () => {
    const ask = "make it warmer, dont change anything about me";
    const once = freezeEditIntent({
      ask,
      origin: "system",
      source: source([]),
      constraints: [{ kind: "preserve_person" }],
    });
    if (!once.ok) throw new Error(`refused: ${once.reason}`);
    expect(once.intent.constraints).toEqual([{ kind: "preserve_person" }]);
    const beside = freezeEditIntent({
      ask,
      origin: "system",
      source: source([]),
      constraints: [{ kind: "exclude_marks", brand: "nike" }],
    });
    if (!beside.ok) throw new Error(`refused: ${beside.reason}`);
    expect(beside.intent.constraints).toEqual([
      { kind: "preserve_person" },
      { kind: "exclude_marks", brand: "nike" },
    ]);
  });

  it("agrees with itself at the spend — the re-check reads the same words", () => {
    const ask = "make it golden hour, keep me the same";
    const frozen = freeze(ask, []);
    if (!frozen.ok) throw new Error(`refused: ${frozen.reason}`);
    expect(intentsAgree(frozen.intent, route(ask, true))).toBe(true);
  });

  it("leaves a sentence that asks exactly as it was — no intent, her keep the interpreter's (Option A)", () => {
    expect(
      freeze("make it moodier, dont change anything about me", []),
    ).toEqual({
      ok: false,
      reason: "not_routed",
      askReason: "fast_path_declined",
    });
    // D2 reads "keep my face the same", and this still asks: a non-person ask stays the interpreter's (D1).
    expect(freeze("make it brighter, keep my face the same", [])).toEqual({
      ok: false,
      reason: "not_routed",
      askReason: "fast_path_declined",
    });
  });
});

// ─── A person refusal her keep caused (ledger F-L5; the preservation fixes, D1/D2) ───────────────────

describe("a sentence the rules refused as an edit of her, because of her keep, freezes with her keep beside it (F-L5)", () => {
  const KEEP =
    "Keep the person's face, hair, body and pose exactly as they are.";

  it("freezes the ledger's four as their edit, version 2, with the keep sentence — nothing of her a target", () => {
    const cases: [string, EditRegion[], unknown[]][] = [
      [
        "make it warmer, dont change my face",
        [],
        [{ op: "GLOBAL_STYLE", target: null, change: "warmer" }],
      ],
      [
        "make my jersey blue, dont change my face",
        [region("blue jersey")],
        [{ op: "RECOLOR", target: "jersey", change: "blue" }],
      ],
      [
        "add gold hoops to my ears, dont change my face",
        [],
        [
          {
            op: "ADD_OBJECT",
            target: null,
            change: null,
            add: {
              thing: "gold hoops",
              place: "to my ears",
              objectAssetId: null,
            },
          },
        ],
      ],
      [
        "add gold hoops to my ears, keep everything else the same",
        [],
        [
          {
            op: "ADD_OBJECT",
            target: null,
            change: null,
            add: {
              thing: "gold hoops",
              place: "to my ears",
              objectAssetId: null,
            },
          },
        ],
      ],
    ];
    for (const [ask, regions, changes] of cases) {
      const frozen = freeze(ask, regions);
      if (!frozen.ok) throw new Error(`"${ask}" refused: ${frozen.reason}`);
      expect({
        ask,
        version: frozen.intent.version,
        changes: frozen.intent.changes,
        constraints: frozen.intent.constraints,
      }).toEqual({
        ask,
        version: 2,
        changes,
        constraints: [{ kind: "preserve_person" }],
      });
      const text = compileNativeInstruction(frozen.intent);
      expect({ ask, keeps: text.endsWith(KEEP) }).toEqual({ ask, keeps: true });
      expect({ ask, face: /\bface\b(?!, hair)/.test(text) }).toEqual({
        ask,
        face: false,
      });
      expect({
        ask,
        agrees: intentsAgree(frozen.intent, route(ask, true)),
      }).toEqual({ ask, agrees: true });
    }
  });

  it("sends detection only the words the rules read — her face is never region text", () => {
    expect(detectionTextFor("make my jersey blue, dont change my face")).toBe(
      "make my jersey blue",
    );
    expect(detectionTextFor("make my jersey blue but preserve the face")).toBe(
      "make my jersey blue",
    );
    // An edit of her beside her keep asks as it did, and is sent as it came.
    expect(detectionTextFor("make my arms bigger, dont change my face")).toBe(
      "make my arms bigger, dont change my face",
    );
  });

  it("still refuses an edit of her beside her keep, with the person code it always had", () => {
    expect(freeze("make my arms bigger, dont change my face", [])).toEqual({
      ok: false,
      reason: "not_routed",
      askReason: "person_mentioned",
    });
  });
});

// ─── A keep of a thing (ledger F-L4; the preservation fixes, K2) ───────────────────────────────────────

describe("a keep of a thing is set aside: the rest freezes as if she had said it alone, and a conflict asks (F-L4, K2)", () => {
  it("freezes, detects and compiles 'remove the goalpost but keep the ball' exactly as 'remove the goalpost' — Adi's live repro", () => {
    // Asset c877f259: main froze REMOVE [goalpost, ball], removed both, and detection — handed her whole sentence
    // — returned no mask, so the job ran full-frame and the lighting drifted. "remove the goalpost" alone held.
    // Every $0 input to that difference is now the clean sentence's, byte for byte.
    const kept = "remove the goalpost but keep the ball";
    const clean = "remove the goalpost";
    expect(detectionTextFor(kept)).toBe(detectionTextFor(clean));
    expect(detectionTextFor(kept)).toBe("remove the goalpost");
    const a = freeze(kept, [region("goalpost")]);
    const b = freeze(clean, [region("goalpost")]);
    if (!a.ok || !b.ok) throw new Error("a remove of the goalpost refused");
    expect(a.intent).toEqual(b.intent);
    expect(a.intent.changes).toEqual([
      { op: "REMOVE_OBJECT", target: "goalpost", change: null },
    ]);
    expect(compileNativeInstruction(a.intent)).toBe(
      compileNativeInstruction(b.intent),
    );
    expect(compileNativeInstruction(a.intent)).not.toMatch(/\bball\b/);
    expect(intentsAgree(a.intent, route(kept, true))).toBe(true);
  });

  it("recolours the socks and only the socks — main refused this unpaired, or recoloured the jersey she kept", () => {
    const ask = "make the socks blue but keep the jersey the same";
    expect(detectionTextFor(ask)).toBe("make the socks blue");
    const frozen = freeze(ask, [region("blue socks")]);
    if (!frozen.ok) throw new Error(`refused: ${frozen.reason}`);
    expect(frozen.intent.version).toBe(1);
    expect(frozen.intent.changes).toEqual([
      { op: "RECOLOR", target: "socks", change: "blue" },
    ]);
    expect(compileNativeInstruction(frozen.intent)).not.toMatch(/jersey|same/);
  });

  it("refuses a conflict with the ask's own line — never a background change of 'the background' she kept", () => {
    for (const ask of [
      "make it warmer but keep the background the same",
      "dont change the background, just make it warmer",
      "make everything blue but keep my cleats",
    ]) {
      const frozen = freeze(ask, []);
      expect({ ask, frozen }).toEqual({
        ask,
        frozen: { ok: false, reason: "not_routed", askReason: "keep_conflict" },
      });
      expect(
        freezeRefusalNote(frozen as Extract<typeof frozen, { ok: false }>),
      ).toBe(
        "A look or a new background covers the whole photo, so it can't leave that part untouched. Name just the thing to change — \"make the socks blue\" — and everything you don't name stays as it is.",
      );
    }
  });
});

// ─── WAVE B, CARD 2 — THE MOVE'S PRECONDITION: ITS THING IS ALREADY IN THE FRAME ───────────────────────
//
// An add's thing is not in the photograph; a move's is. That is the whole difference between the two
// operations, so the evidence for it — a detection region naming the thing — is the operation's
// precondition rather than a check on it. Ledger F-WA6 (a move has no rule) and F-WB3 (two instances).

describe("card 2 — a move freezes only when detection found its thing (wave B)", () => {
  const moving = <T>(fn: () => T): T => {
    const saved = process.env.STUDIO_MOVE_OBJECT;
    process.env.STUDIO_MOVE_OBJECT = "true";
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env.STUDIO_MOVE_OBJECT;
      else process.env.STUDIO_MOVE_OBJECT = saved;
    }
  };
  const move = (ask: string, regions: EditRegion[]) =>
    moving(() => freeze(ask, regions));

  it("freezes the move when exactly one region names the thing", () => {
    const frozen = move("move the ball closer to my feet", [region("ball")]);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    expect(frozen.intent.changes).toEqual([
      {
        op: "MOVE_OBJECT",
        target: "ball",
        change: null,
        to: "closer to my feet",
      },
    ]);
  });

  it("pairs her word with detection's CONCRETE noun, which is the ordinary case", () => {
    // autoMask asks for the concrete noun — "soccer ball" for the ball at her feet — so a label that is
    // MORE specific than her word is what detection normally returns. Requiring the label's head to be
    // nothing but articles refused this, which is every real move.
    const frozen = move("move the ball closer to my feet", [
      region("the soccer ball"),
    ]);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    expect(frozen.intent.changes[0].target).toBe("ball");
  });

  it("finds the thing by detection's CONCRETE NOUN, not only by the label — F-WB5 (a)", () => {
    // ⚠️ THE LABEL IS THE DIRECTIVE. `parseAutoMask` sets `label = labelFor(directiveOf(e) ?? instruction)`,
    // and the concrete noun goes to `samNoun`. Reading only the label refused a move on a frame whose
    // region named her thing perfectly — found in acceptance 2026-09-17 (ledger F-WB5).
    const frozen = move("move the ball closer to my feet", [
      region("closer to my feet", { samNoun: "soccer ball" }),
    ]);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    expect(frozen.intent.changes[0].target).toBe("ball");
    // Named, so nothing was assumed and she is told nothing.
    expect(frozen.intent.changes[0].assumedTarget).toBeUndefined();
    expect(assumedMoveNote(frozen.intent)).toBeNull();
  });

  it("REFUSES rather than falling back to an add when detection found NO region at all", () => {
    // ⚠️ THE TWO-BALLS GUARD. An add here would put a second ball down — the outcome the op exists to
    // prevent — and a full-frame move with no region would ask the model to guess which thing she meant.
    const out = move("move the ball closer to my feet", []);
    expect(out.ok ? "froze" : out.reason).toBe("move_target_absent");
  });

  it("takes the ONE unnamed region as the thing, and says so before she pays — F-WB5 (d)", () => {
    // The live acceptance frame: `found:1 scopes:["object"] nouns:[{reason:"absent"}]`. One box, no noun
    // to confirm it with, on a photograph that plainly held the ball. A missing `samNoun` is a
    // MASK-QUALITY fact — the field "exists only to be handed to SAM-3" — not evidence that her thing is
    // not there, and detection was ASKED for her thing.
    const frozen = move("move the ball closer to my feet", [
      region("the ball closer to my feet"),
    ]);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    expect(frozen.intent.changes[0]).toMatchObject({
      op: "MOVE_OBJECT",
      target: "ball",
      to: "closer to my feet",
      assumedTarget: true,
    });
    // ⚠️ AND THE ASSUMPTION IS DISCLOSED. This is the whole difference between (d) and guessing.
    expect(assumedMoveNote(frozen.intent)).toMatch(
      /couldn't confirm|mark it yourself/,
    );
  });

  it("⚠️ THE TRADE (d) MAKES: a region that named something ELSE is now assumed, not refused", () => {
    // Adi's call, 2026-09-17, and it is a real cost rather than a side effect. Nothing on the frozen
    // record separates "detection proposed no noun" from "the noun it proposed was rejected" —
    // `samNoun` is `undefined` for both, which that field's own doc states. So a single region cannot
    // be told apart from a single WRONG region, and (d) treats both as the candidate. What makes that
    // acceptable is that she is told, and the preview draws the region she is being offered.
    const frozen = move("move the ball closer to my feet", [region("cone")]);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    expect(frozen.intent.changes[0].assumedTarget).toBe(true);
    expect(assumedMoveNote(frozen.intent)).toBeTruthy();
  });

  it("keeps the two-balls guard on unnamed regions too — two candidates still ask", () => {
    // "Exactly one" is the guard, and this is it: two boxes with no noun between them is the same
    // question F-WB3 records, and it is not guessed.
    // ⚠️ NEITHER LABEL MAY NAME HER THING, or this stops testing (d). An earlier draft used
    // "the other ball" as the second label — which ENDS WITH "ball", so `namesTarget` matched it and
    // the sentence froze by NAME on one region, proving nothing about the unnamed path.
    const out = move("move the ball closer to my feet", [
      region("the ball closer to my feet"),
      region("over by the bench"),
    ]);
    expect(out.ok ? "froze" : out.reason).toBe("ambiguous_move");
  });

  it("REFUSES where one noun names two of them — F-WB3, never a guess", () => {
    const out = move("move the ball closer to my feet", [
      region("soccer ball"),
      region("beach ball"),
    ]);
    expect(out.ok ? "froze" : out.reason).toBe("ambiguous_move");
  });

  it("gives each refusal a line that names what she can change", () => {
    for (const reason of ["move_target_absent", "ambiguous_move"] as const) {
      const note = freezeRefusalNote({ ok: false, reason });
      expect(note).not.toMatch(/detect|region|model|mask/i);
      expect(note.length).toBeGreaterThan(40);
    }
  });
});

// ─── F-WB6 THROUGH THE FREEZE — THE ENTRY POINT THE ROUTE-LEVEL CELLS SKIPPED ─────────────────────────

/**
 * ⚠️ WHY THIS EXISTS, AND IT IS THE SAME MISTAKE TWICE IN ONE WAVE.
 *
 * F-WB6's first cells called `route()` only. Routing was correct and the feature did not work: the
 * FREEZE takes a recolour's colour from detection's LABEL (`recolourChange`), never from `step.value`,
 * and for a pronoun clause no label can carry it — she said the colour once, about things named in the
 * clause before, so detection was never asked for a colour on any of them. Live on 2026-09-17:
 *
 *   found:6 (jersey, shorts, socks x2, shoes x2, all accepted)
 *   native_freeze_refused  reason: "unpaired_directive"  askReason: null
 *   preview: blocked, blockers:1, costUsd:0.6616
 *
 * A route-level cell cannot see that, exactly as RV-w6d could not see a guard it had not moved. So the
 * regression cell goes through `freezeEditIntent` with the LABELS DETECTION ACTUALLY RETURNED — the
 * brand directives, carrying no colour anywhere.
 */
describe("F-WB6 through the FULL freeze — her colour survives when no label carries it", () => {
  /** What detection returned live: six garments, each labelled with the BRAND directive, no colour. */
  const brandLabels = [
    region("adidas jersey", { samNoun: "jersey" }),
    region("adidas shorts", { samNoun: "shorts" }),
    region("adidas socks", { samNoun: "socks" }),
    region("adidas socks", { samNoun: "socks" }),
    region("adidas shoes", { samNoun: "shoes" }),
    region("adidas shoes", { samNoun: "shoes" }),
  ];

  it("freezes the live sentence instead of refusing unpaired_directive", () => {
    const frozen = freeze(
      "make my uniform, shoes and socks adidas. make them the color blue too.",
      brandLabels,
    );
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    // Her colour, from her own word, on every garment the pronoun resolved to.
    const recolours = frozen.intent.changes.filter((c) => c.op === "RECOLOR");
    expect(recolours.length).toBeGreaterThan(0);
    for (const c of recolours) expect(c.change).toBe("blue");
    // And the brand clause still froze from the labels, as it always did.
    expect(
      frozen.intent.changes.some(
        (c) => c.op === "REPLACE_OBJECT" && c.change?.includes("adidas"),
      ),
    ).toBe(true);
  });

  it("⚠️ a recolour she named DIRECTLY still reads its colour off the LABEL — the guard is untouched", () => {
    // The `fromPronoun` branch is scoped for exactly this reason: a recolour she named her things in
    // directly still takes its per-target colour from detection's directive, which is the whole point
    // of `recolourChange` and what makes "make the jersey red and the shorts black" work.
    const frozen = freeze("make the socks blue", [
      region("blue socks", { samNoun: "socks" }),
    ]);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    expect(frozen.intent.changes).toEqual([
      { op: "RECOLOR", target: "socks", change: "blue" },
    ]);
  });

  it("⚠️ ONE target and nothing paired: her colour is used — F-WB7, and this cell used to refuse", () => {
    // This assertion CHANGED with F-WB7 and is the only one that did. It used to pin
    // `unpaired_directive` here. A recolour of ONE thing, where detection's directive carried no
    // colour, has nothing to pair and nothing to distribute — her word is the colour, and refusing was
    // costing her the edit. sweep 3.1's guard is untouched because it has TWO targets; see below.
    const frozen = freeze("make the socks blue", [
      region("socks", { samNoun: "socks" }),
    ]);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    expect(frozen.intent.changes).toEqual([
      { op: "RECOLOR", target: "socks", change: "blue" },
    ]);
  });

  it("⚠️ an AMBIGUOUS pairing is still ambiguous, on the path that reads labels", () => {
    const out = freeze("make the socks blue", [
      region("red socks", { samNoun: "socks" }),
      region("green socks", { samNoun: "socks" }),
    ]);
    expect(out.ok ? "froze" : out.reason).toBe("ambiguous_directive");
  });
});

// ─── F-WB7 — ADD + RECOLOR COMPOUNDS THROUGH THE FULL FREEZE (the deep sweep, 2026-09-17) ─────────────

/**
 * ⚠️ THE LIVE SHAPE, AND WHY THESE GO THROUGH `freezeEditIntent` AND NOT `route()`.
 *
 * "add hoops to my ears and make my jersey red" routed correctly and the FREEZE refused
 * `unpaired_directive` with the jersey detected (17:07:29). Both halves work alone — cell 24 adds the
 * hoops, and "make my jersey red" recolours — so only the compound failed, and only below the route.
 * A route-level pin could not have seen it, which is the third time in this wave that mattered.
 *
 * Bisected across pre-wave-A `29b2fc8`, main `7d12dbc` and this branch's tip: **identical on all
 * three**, so it is pre-existing and not wave B's. The freeze fix (F-WB6) could not have moved it —
 * `fromPronoun` fires only on a pronoun-resolved step and this compound has none.
 *
 * The regions carry the label detection actually returned: the bare noun, with NO colour anywhere.
 */
describe("F-WB7 — an add beside a recolour freezes, and the colour is hers", () => {
  const bare = (noun: string) => region(noun, { samNoun: noun });

  it("freezes the live compound instead of refusing unpaired_directive", () => {
    const frozen = freeze("add hoops to my ears and make my jersey red", [
      bare("jersey"),
    ]);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    expect(frozen.intent.changes).toEqual([
      {
        op: "ADD_OBJECT",
        target: null,
        change: null,
        add: { thing: "hoops", place: "to my ears", objectAssetId: null },
      },
      { op: "RECOLOR", target: "jersey", change: "red" },
    ]);
  });

  it("and its siblings: another worn add beside a recolour, and an add beside a BRAND change", () => {
    const headband = freeze("add a headband and make my socks blue", [
      bare("socks"),
    ]);
    if (!headband.ok)
      throw new Error(`expected a freeze, got ${headband.reason}`);
    expect(headband.intent.changes[1]).toEqual({
      op: "RECOLOR",
      target: "socks",
      change: "blue",
    });

    // ⚠️ A BRAND CHANGE TAKES A DIFFERENT PATH — `REPLACE_OBJECT` reads `step.value`, never a label —
    // so this one never depended on the pairing and is here to prove the add does not disturb it.
    const brand = freeze("add hoops and make the jersey adidas", [
      bare("jersey"),
    ]);
    if (!brand.ok) throw new Error(`expected a freeze, got ${brand.reason}`);
    expect(brand.intent.changes[1]).toEqual({
      op: "REPLACE_OBJECT",
      target: "jersey",
      change: "adidas jersey",
    });
  });

  it("⚠️ and sweep 3.1's guard is untouched — TWO targets and ONE colour still refuse", () => {
    // The second condition on the fallback, and jest is what put it there: "make the jersey and the
    // shorts black" is ONE step with two targets and the single value "black", so her word cannot be
    // distributed. A fallback without the target count would have made BOTH garments black off a
    // reading she never gave — the exact defect that guard exists for.
    //
    // ⚠️ REWRITTEN BY CARD 2, NOT LOOSENED. The sentence pinned here was "make the jersey red and the
    // shorts black", which now freezes because SHE paired a colour to each garment (`values`, rule 5)
    // and refusing it was the defect B13/H5/R6 recorded. `sole` is what this guard is about, and it is
    // still false here, so the fallback is still shut — on the sentence that actually asks it.
    expect(
      freeze("make the jersey and the shorts black", [
        region("black"),
        region("black", { top: 4200 }),
      ]),
    ).toEqual({ ok: false, reason: "unpaired_directive" });
  });
});

// ─── D1 — `put` DECIDES AT THE FREEZE, AND NEVER RENDERS A SECOND BALL (wave B, deep sweep) ───────────

/**
 * ⚠️ THE INCIDENT, AND WHY EVERY CELL HERE GOES THROUGH `freezeEditIntent`.
 *
 * Live 2026-09-17, tapped: "put the ball on the ground" was planned as an ADD and rendered a SECOND
 * ball, on a frame that already held two. `placedAdds: ["ball"]` on the QA line is the proof, and she
 * paid $0.271 for it. Detection had returned ONE region whose noun was `absent`, so nothing named her
 * thing, and `put` took rule 4½'s add unchanged — F-WB5's (d) answers exactly that question for a
 * move and simply was not reached, because the add path never called `moveRegion`.
 *
 * route() cannot see any of this: the sentence routes as an ADD either way, and the decision is the
 * freeze's because only the freeze has detection's regions. Third time in this wave that mattered.
 */
describe("D1 — a bare `put` asks the frame, and only an object photo keeps it an add", () => {
  const putting = <T>(fn: () => T): T => {
    const saved = process.env.STUDIO_MOVE_OBJECT;
    process.env.STUDIO_MOVE_OBJECT = "true";
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env.STUDIO_MOVE_OBJECT;
      else process.env.STUDIO_MOVE_OBJECT = saved;
    }
  };
  const put = (ask: string, regions: EditRegion[]) =>
    putting(() => freeze(ask, regions));
  const LIVE = "put the ball on the ground";

  it("ONE region with no noun: a MOVE of that region, disclosed — never an ADD", () => {
    // The live shape. The label is detection's directive, carrying no noun of its own.
    const frozen = put(LIVE, [region("the ball on the ground")]);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    expect(frozen.intent.changes).toEqual([
      {
        op: "MOVE_OBJECT",
        target: "ball",
        change: null,
        to: "on the ground",
        assumedTarget: true,
      },
    ]);
    // ⚠️ THE DISCLOSURE IS THE PRICE OF THE ASSUMPTION, and this is the assertion that keeps it.
    expect(assumedMoveNote(frozen.intent)).toBeTruthy();
    // And nothing anywhere is an add, which is the whole incident.
    expect(frozen.intent.changes.some((c) => c.op === "ADD_OBJECT")).toBe(
      false,
    );
  });

  it("ONE region that NAMES the ball: a MOVE with nothing assumed and nothing said", () => {
    const frozen = put(LIVE, [region("ball", { samNoun: "soccer ball" })]);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    expect(frozen.intent.changes[0]).toMatchObject({
      op: "MOVE_OBJECT",
      target: "ball",
      to: "on the ground",
    });
    expect(frozen.intent.changes[0].assumedTarget).toBeUndefined();
    expect(assumedMoveNote(frozen.intent)).toBeNull();
  });

  it("TWO candidates ask rather than guess — the live frame held two balls", () => {
    // F-WB3's constraint: a target is a NOUN, so "the one on the ground" is not something the rules
    // can read, and which of the two she meant is not guessed. Both shapes ask: two unnamed regions,
    // and two that each name a ball.
    expect(
      put(LIVE, [region("first thing"), region("second thing")]).ok
        ? "froze"
        : "ambiguous_move",
    ).toBe("ambiguous_move");
    const named = put(LIVE, [
      region("soccer ball", { samNoun: "soccer ball" }),
      region("beach ball", { samNoun: "beach ball" }),
    ]);
    expect(named.ok ? "froze" : named.reason).toBe("ambiguous_move");
  });

  it("NO regions: it refuses and offers a new image — it does not add one", () => {
    const out = put(LIVE, []);
    expect(out.ok ? "froze" : out.reason).toBe("move_target_absent");
    if (out.ok) throw new Error("expected a refusal");
    expect(freezeRefusalNote(out)).toMatch(/start a new image/);
    // ⚠️ The old line said "or add it instead", pointing at the very ADD that rendered a second ball.
    expect(freezeRefusalNote(out)).not.toMatch(/add it instead/);
  });

  it("⚠️ an OBJECT PHOTO settles it the other way — that `put` is still an add", () => {
    // "put the gatorade bottle from image 2 on top of my head" names its source out loud: the thing is
    // not in the photograph, she handed it to us, and it is an insertion however the frame looks. This
    // is why the branch is not about the verb alone.
    const frozen = putting(() =>
      freezeEditIntent({
        ask: "put the water bottle on the grass",
        origin: "system",
        source: source([region("the water bottle on the grass")]),
        references: [
          {
            role: "object" as const,
            ref: "athletes/synthetic/bottle.png",
            mediaAssetId: "obj-1",
          },
        ],
      }),
    );
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    expect(frozen.intent.changes[0]).toMatchObject({
      op: "ADD_OBJECT",
      add: { thing: "water bottle", objectAssetId: "obj-1" },
    });
  });

  it("⚠️ FLAG OFF is the add it has always been, byte for byte", () => {
    const frozen = freeze(LIVE, [region("the ball on the ground")]);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    expect(frozen.intent.changes).toEqual([
      {
        op: "ADD_OBJECT",
        target: null,
        change: null,
        add: { thing: "ball", place: "on the ground", objectAssetId: null },
      },
    ]);
  });

  it("⚠️ and `add` is untouched — it is an insertion whatever the frame holds", () => {
    const frozen = put("add a ball on the ground", [
      region("the ball on the ground"),
    ]);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    expect(frozen.intent.changes[0].op).toBe("ADD_OBJECT");
  });
});

// ─── THE DEEP SWEEP'S E-SERIES, THROUGH THE FULL FREEZE (wave B) ──────────────────────────────────────

describe("E1/E2 — a mark swap freezes, and a brand on a mark is a brand", () => {
  const mark = (label: string, noun: string) =>
    region(label, { samNoun: noun });

  it("the live sentence freezes: `replace` is a brand verb now (E1)", () => {
    // It was never the plural — "change the nike logos to adidas" already routed, and so did "change
    // the nike logo TO BE adidas". `replace` was the one replacement word rule 4c never read.
    const frozen = freeze("replace the nike logos to be adidas", [
      mark("nike logos", "logo"),
    ]);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    expect(frozen.intent.changes).toEqual([
      { op: "REPLACE_OBJECT", target: "nike logos", change: "adidas logos" },
    ]);
  });

  it("a place after the mark is WHERE it is, never a second target (E2)", () => {
    // "make the logo ON MY JERSEY adidas" bypassed the rule entirely and reached the interpreter,
    // which proposed an ADD and tripped C3's product gate. The mark is the item; the garment is only
    // where it sits — V4's reading, which rule 4c never had.
    const frozen = freeze("make the logo on my jersey adidas", [
      mark("logo", "logo"),
    ]);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    expect(frozen.intent.changes).toEqual([
      { op: "REPLACE_OBJECT", target: "logo", change: "adidas logo" },
    ]);
    // ⚠️ AND THE GARMENT IS NOT A TARGET. Handing detection "jersey" too would change the garment —
    // the mangle V4 closed for rule 1.
    expect(frozen.intent.changes.some((c) => c.target === "jersey")).toBe(
      false,
    );
  });

  it("⚠️ a SWAP, not an add — and no product-referent ask even with a photo attached (E2)", () => {
    // The interpreter had proposed an ADD of "your words", which tripped C3's product gate. A
    // REPLACE_OBJECT compiles as a replacement and the product gate fires only on adds, so routing it
    // correctly is what closes the gate — nothing in C3 needed changing.
    const frozen = freezeEditIntent({
      ask: "make the logo on my jersey adidas",
      origin: "system",
      source: source([mark("logo", "logo")]),
      references: [
        {
          role: "product" as const,
          ref: "athletes/synthetic/bottle.png",
          mediaAssetId: "prod-1",
        },
      ],
    });
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    expect(frozen.intent.changes[0].op).toBe("REPLACE_OBJECT");
    expect(frozen.intent.changes.some((c) => c.op === "ADD_OBJECT")).toBe(
      false,
    );
  });
});

describe("E4 — a bare `it` takes the previous clause's targets, but only for a COLOUR", () => {
  it("the live sentence freezes with her colour on the jersey", () => {
    const frozen = freeze("make my jersey adidas. make it blue.", [
      region("adidas jersey", { samNoun: "jersey" }),
    ]);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    expect(frozen.intent.changes).toEqual([
      { op: "RECOLOR", target: "jersey", change: "blue" },
      { op: "REPLACE_OBJECT", target: "jersey", change: "adidas jersey" },
    ]);
  });

  it("⚠️ a LOOK still means the photograph — the 75 GLOBAL_STYLE cells are untouched", () => {
    // Two guards, and the first is that a look clause READS on its own, so the resolver never sees it.
    // The second is the recolour test inside the resolver. Measured across every `it` sentence in the
    // corpus: 141 sentences, 423 cells, 295 of them routing, and ZERO routing cells moved.
    const frozen = freeze("make my socks blue. make it warmer.", [
      region("blue socks", { samNoun: "socks" }),
    ]);
    if (!frozen.ok) throw new Error(`expected a freeze, got ${frozen.reason}`);
    expect(frozen.intent.changes.map((c) => c.op)).toEqual([
      "RECOLOR",
      "GLOBAL_STYLE",
    ]);
    // And a look after a brand change keeps being a look, not a recolour of the jersey.
    const look = freeze("make my jersey adidas. make it golden hour.", [
      region("adidas jersey", { samNoun: "jersey" }),
    ]);
    if (!look.ok) throw new Error(`expected a freeze, got ${look.reason}`);
    expect(look.intent.changes.some((c) => c.op === "GLOBAL_STYLE")).toBe(true);
    expect(look.intent.changes.some((c) => c.op === "RECOLOR")).toBe(false);
  });
});
