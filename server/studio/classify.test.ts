/**
 * The generate gate — rule ②, as a test rather than as a promise.
 *
 * GENERATE is the one operation that destroys its input. Every assertion here is about making it
 * UNREACHABLE from a sentence that did not plainly ask for it, which is a different and much
 * stronger claim than making it unlikely.
 *
 * The golden texts are inlined rather than imported. `allowedOps` is step 1 of the build order and
 * is deliberately standalone — the golden set arrives with the classifier itself, and a test that
 * imported it would make the gate un-mergeable until the rest of the classifier existed.
 */
import {
  allowedOps,
  classifyFast,
  composedClauses,
  compoundClauses,
  extractTargets,
  headlineBound,
  orderSteps,
  parseAddObject,
  parseBrandChange,
  parseReplaceWithReference,
  parseWornAdd,
  readHeadline,
  route,
  splitClauses,
  validate,
  wornLocationOf,
  HEADLINE_TAGLINES,
  MAX_HEADLINE_CHARACTERS,
  MAX_HEADLINE_WORDS,
  ROUTE,
  type Classification,
  type EditOperation,
  type EditPath,
  type EditStep,
} from "./classify";
import { namesPerson, normalizeObjectNoun, PERSON_NOUNS } from "./objectVocab";
import { displayTextEnabled } from "./config";

/** Every op except GENERATE, in the order `allowedOps` returns them. */
const EDIT_OPS: EditOperation[] = [
  "RECOLOR",
  "APPLY_DESIGN",
  "REPLACE_OBJECT",
  "REMOVE_OBJECT",
  "ADD_OBJECT",
  "CHANGE_BACKGROUND",
  "GLOBAL_STYLE",
];

/**
 * The golden set's sentences, minus the one explicit new-image ask.
 *
 * These are the requests the matrix was built from, and the point of listing all of them rather
 * than a representative handful is that the bug was PHRASING-SPECIFIC: "make the socks blue"
 * routed to GENERATE while "recolor the socks red" did not, and nothing about the two asks
 * differs. A gate that holds for one and not the other is the bug wearing a new hat.
 */
const NOT_A_GENERATE_ASK = [
  "change the color of the socks to red",
  "make the socks blue",
  "recolor the socks red",
  "edit the socks to be red",
  "turn the shorts #1a2b3c",
  "change my jersey to blue",
  "change my jersey to adidas",
  "add an adidas logo to the jersey",
  "put a number 10 on the back",
  "give the socks a striped pattern",
  "swap the cleats for white ones",
  "swap the cleats for Nike Mercurials",
  "remove the water bottle",
  "get rid of the cone behind me",
  "put me in a stadium",
  "change the background to a beach",
  "make it black and white",
  "make it golden hour",
  "make her look taller",
  "change the person to a man",
  "make it pop",
  "make my jersey a blue adidas kit",
];

describe("allowedOps — GENERATE is unreachable unless she asked for it", () => {
  it("never offers GENERATE for a source-photo edit, across every golden phrasing", () => {
    // §3's assertion, stated as the spec states it: this is checked in a test, not in review.
    for (const text of NOT_A_GENERATE_ASK) {
      expect(allowedOps(true, text)).not.toContain("GENERATE");
    }
  });

  it("excludes GENERATE for the three sentences named in the card", () => {
    // Called out separately from the sweep above because these are the acceptance criteria, and a
    // sweep that silently lost an entry would still pass. "make the socks blue" is the open bug.
    expect(allowedOps(true, "make the socks blue")).not.toContain("GENERATE");
    expect(allowedOps(true, "turn the jersey blue")).not.toContain("GENERATE");
    expect(allowedOps(true, "make it black and white")).not.toContain(
      "GENERATE",
    );
  });

  it("offers exactly the seven edit operations when GENERATE is withheld", () => {
    // Not just "GENERATE is absent" — the set is pinned whole. A gate that withheld GENERATE by
    // also dropping CHANGE_BACKGROUND would pass every assertion above and break the product.
    expect(allowedOps(true, "make the socks blue")).toEqual(EDIT_OPS);
  });

  it("offers GENERATE when she plainly asked for a new image", () => {
    expect(allowedOps(true, "generate a new poster of me")).toContain(
      "GENERATE",
    );
    expect(allowedOps(true, "generate a new poster of me")).toEqual([
      ...EDIT_OPS,
      "GENERATE",
    ]);
  });

  it("reads the artifact noun, not just the verb — the indefinite is the discriminator", () => {
    // "make" heads both a recolor and a generate. What separates them is "A poster" naming
    // something that does not exist yet against "THE socks" naming something already in frame.
    expect(allowedOps(true, "make me a new poster")).toContain("GENERATE");
    expect(allowedOps(true, "make the poster brighter")).not.toContain(
      "GENERATE",
    );
    // An indefinite with no artifact noun is an edit: "a red one" is a colour, not a deliverable.
    expect(allowedOps(true, "make the cleats a red one")).not.toContain(
      "GENERATE",
    );
  });

  // ─── A.3 — THE DELIVERABLE NOUNS ────────────────────────────────────────────────────────────

  it("routes every deliverable noun the list gained, named one at a time", () => {
    // Written out rather than looped over a constant. A loop that reads the noun list cannot see a
    // DELETION from it — it iterates one fewer time and reports green, the exact shape that let
    // "socks" fall out of GARMENT_NOUNS with 884 tests passing.
    expect(allowedOps(true, "create an adidas ad featuring me")).toContain("GENERATE");
    expect(allowedOps(true, "create a new ads concept for me")).toContain("GENERATE");
    expect(allowedOps(true, "create a campaign for adidas")).toContain("GENERATE");
    expect(allowedOps(true, "make me a post for launch day")).toContain("GENERATE");
    expect(allowedOps(true, "create a story for tomorrow")).toContain("GENERATE");
    expect(allowedOps(true, "generate a reel cover")).toContain("GENERATE");
    expect(allowedOps(true, "design a banner for the team page")).toContain("GENERATE");
    expect(allowedOps(true, "make a flyer for the clinic")).toContain("GENERATE");
    expect(allowedOps(true, "create a thumbnail for the video")).toContain("GENERATE");
    expect(allowedOps(true, "design a new creative for the drop")).toContain("GENERATE");
  });

  it("still offers the whole edit set alongside — widening the noun withdraws nothing", () => {
    // The failure this catches is a regex edit that makes GENERATE reachable by dropping an edit
    // operation, which every "toContain(GENERATE)" assertion above would pass straight through.
    expect(allowedOps(true, "create an adidas ad featuring me")).toEqual([...EDIT_OPS, "GENERATE"]);
  });

  it("the new nouns need the construction too — a bare noun with a photo is still an edit", () => {
    // ⚠️ THE GATE IS THE CONSTRUCTION, NOT THE WORD. Each of these contains a noun this commit
    // added and none of them asks for a new artifact, so GENERATE must stay out of reach. If
    // widening the list had loosened anything else, this is where it shows.
    expect(allowedOps(true, "make the ad brighter")).not.toContain("GENERATE");
    expect(allowedOps(true, "crop the post to square")).not.toContain("GENERATE");
    expect(allowedOps(true, "change the banner to adidas")).not.toContain("GENERATE");
    expect(allowedOps(true, "remove the logo from the flyer")).not.toContain("GENERATE");
    expect(allowedOps(true, "make the thumbnail sharper")).not.toContain("GENERATE");
    expect(allowedOps(true, "add a swoosh to the reel cover")).not.toContain("GENERATE");
    // The determiner is still the discriminator: THE story is one that exists.
    expect(allowedOps(true, "make the story black and white")).not.toContain("GENERATE");
  });

  it("reads 'photograph' as it reads 'photo' — Adi's live sentence, and the false positive the two share (the preservation fixes, D3)", () => {
    // Written out, one sentence at a time. Live on acceptance: with her photos in the tray this sentence was an
    // EDIT — a background change to "net" — and her other photos refused it. Her keep at the end is not why.
    const live =
      "generate a professional sports photograph of her striking the ball into the net, mid-shot with her leg extended at the moment of contact, in her uniform, goalkeeper diving, packed stadium behind her, golden hour light, sharp focus on her face. preserve the face as much as possible within the reference image.";
    expect(allowedOps(true, live)).toContain("GENERATE");
    expect(route(live, true).steps.map((s) => s.op)).toEqual(["GENERATE"]);
    expect(route(live, false).steps.map((s) => s.op)).toEqual(["GENERATE"]);
    for (const text of [
      "generate a professional sports photograph of her",
      "create a photograph of me on a beach",
      "make me a new photograph for the launch",
      "design a new photograph for the drop",
    ]) {
      expect({ text, ops: allowedOps(true, text) }).toEqual({
        text,
        ops: [...EDIT_OPS, "GENERATE"],
      });
    }
    // The construction still gates it: no indefinite, a definite, no creation verb. ("generate two photographs of
    // me" stood here as the no-indefinite case until wave A's V3 gave a plural its own arm — a plural takes no "a" —
    // and is pinned as a new image in V3's block; a singular with no article still gates.)
    for (const text of [
      "generate photograph of me",
      "make the photograph brighter",
      "give the whole photograph this look: black and white.",
      "remove the logo from the photograph",
    ]) {
      expect({ text, ops: allowedOps(true, text) }).toEqual({
        text,
        ops: EDIT_OPS,
      });
    }
    // The false positive "photo" already had, and "photograph" shares: a version of this photo is a new image.
    expect(
      allowedOps(true, "make a black and white version of this photo"),
    ).toContain("GENERATE");
    expect(
      allowedOps(true, "make a black and white version of this photograph"),
    ).toContain("GENERATE");
    // The follow-up card's words (ledger F-L8) were pinned here as "not yet", so each would be added on purpose —
    // wave A's V3 added them (its own block, at the end of this file). What the card still leaves out stays pinned.
    for (const text of [
      "generate pic of me playing soccer",
      "generate headshots of me",
      "make photos brighter",
    ]) {
      expect({ text, ops: allowedOps(true, text) }).toEqual({
        text,
        ops: EDIT_OPS,
      });
    }
  });

  it("does not match a deliverable noun buried inside a longer word", () => {
    // "ad" is two letters and lives inside adidas, shade, ready, gradient. Word boundaries are the
    // only thing keeping "make me a new adidas kit" out of GENERATE, and that sentence is an edit
    // she will type.
    expect(allowedOps(true, "make me a new adidas kit")).not.toContain("GENERATE");
    expect(allowedOps(true, "give me a new gradient")).not.toContain("GENERATE");
    expect(allowedOps(true, "make a new shade of blue")).not.toContain("GENERATE");
  });

  it("returns exactly ['GENERATE'] when there is no source photo", () => {
    // Alone, not alongside the edit ops: an edit operation chosen here reaches the edit pipeline
    // with no base and becomes a 400.
    expect(allowedOps(false, "make the socks blue")).toEqual(["GENERATE"]);
    expect(allowedOps(false, "generate a new poster of me")).toEqual([
      "GENERATE",
    ]);
    expect(allowedOps(false, "")).toEqual(["GENERATE"]);
  });
});

describe("the guard is hasSourcePhoto, and the text only ever adds GENERATE back", () => {
  it("proves the fork is load-bearing: the same sentence differs only by the photo", () => {
    // ─── THIS IS THE REVERT CHECK, EXPRESSED AS AN INVARIANT ──────────────────────────────────
    //
    // The card asks for the `hasSourcePhoto` guard to be reverted by hand and the suite confirmed
    // red. That was done and it fails (see the commit message). Pinning it here as well means the
    // guard cannot be removed LATER without a red suite — a one-time manual check proves the test
    // bites today, this proves it keeps biting.
    //
    // Deleting the `if (!hasSourcePhoto)` line makes every sentence take the source-photo branch,
    // so a no-photo request returns the six edit ops instead of ['GENERATE'] and this fails.
    for (const text of NOT_A_GENERATE_ASK) {
      expect(allowedOps(false, text)).toEqual(["GENERATE"]);
      expect(allowedOps(true, text)).not.toEqual(["GENERATE"]);
    }
  });

  it("holds the hard invariant from §6b: GENERATE requires no photo, or an explicit ask", () => {
    // Stated once, over both axes, as the property it actually is. Anything that ever puts GENERATE
    // in the set without one of those two conditions is a violation of rule ②, whatever the route.
    for (const text of [
      ...NOT_A_GENERATE_ASK,
      "generate a new poster of me",
      "make me a new render",
    ]) {
      for (const hasPhoto of [true, false]) {
        const ops = allowedOps(hasPhoto, text);
        if (ops.includes("GENERATE")) {
          expect(
            !hasPhoto || /\b(generate|create|render|design|make)\b/i.test(text),
          ).toBe(true);
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE CLASSIFIER CORE
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The golden set, verbatim from the spec, with one column added: whether the DETERMINISTIC path is
 * expected to resolve it. The split is the ship rule — 100% on the deterministic cases, and the
 * rest are ASK by design now that there is no LLM stage.
 */
const GOLDEN: {
  text: string;
  hasPhoto: boolean;
  op?: EditOperation;
  path: EditPath;
  fast: boolean;
  /** Pinned only where the fast path derives one. Weak, and asserted BECAUSE it is weak. */
  value?: string | null;
}[] = [
  // ─── Deterministic. These must be 100%. ──────────────────────────────────────────────────────
  {
    text: "change the color of the socks to red",
    hasPhoto: true,
    op: "RECOLOR",
    path: "FULL_IMAGE",
    fast: true,
  },
  {
    text: "make the socks blue",
    hasPhoto: true,
    op: "RECOLOR",
    path: "FULL_IMAGE",
    fast: true,
  },
  {
    text: "recolor the socks red",
    hasPhoto: true,
    op: "RECOLOR",
    path: "FULL_IMAGE",
    fast: true,
  },
  {
    text: "edit the socks to be red",
    hasPhoto: true,
    op: "RECOLOR",
    path: "FULL_IMAGE",
    fast: true,
  },
  {
    text: "turn the shorts #1a2b3c",
    hasPhoto: true,
    op: "RECOLOR",
    path: "FULL_IMAGE",
    fast: true,
  },
  {
    text: "change my jersey to blue",
    hasPhoto: true,
    op: "RECOLOR",
    path: "FULL_IMAGE",
    fast: true,
  },
  {
    text: "swap the cleats for white ones",
    hasPhoto: true,
    op: "RECOLOR",
    path: "FULL_IMAGE",
    fast: true,
  },
  {
    text: "remove the water bottle",
    hasPhoto: true,
    op: "REMOVE_OBJECT",
    path: "MASKED",
    fast: true,
  },
  {
    text: "get rid of the cone behind me",
    hasPhoto: true,
    op: "REMOVE_OBJECT",
    path: "MASKED",
    fast: true,
  },
  {
    text: "put me in a stadium",
    hasPhoto: true,
    op: "CHANGE_BACKGROUND",
    path: "BACKGROUND",
    fast: true,
    value: "stadium",
  },
  {
    text: "change the background to a beach",
    hasPhoto: true,
    op: "CHANGE_BACKGROUND",
    path: "BACKGROUND",
    fast: true,
    value: "beach",
  },
  {
    text: "make it black and white",
    hasPhoto: true,
    op: "GLOBAL_STYLE",
    path: "FULL_IMAGE",
    fast: true,
  },
  {
    text: "make it golden hour",
    hasPhoto: true,
    op: "GLOBAL_STYLE",
    path: "FULL_IMAGE",
    fast: true,
  },
  {
    text: "make the socks blue",
    hasPhoto: false,
    op: "GENERATE",
    path: "GENERATE",
    fast: true,
  },

  // ─── 2026-09-10: a brand change ROUTES (rule 4c, a product decision). This was the fall-through's
  // first entry until then — the kit reading, now decided, as a REPLACE of the jersey.
  {
    text: "change my jersey to adidas",
    hasPhoto: true,
    op: "REPLACE_OBJECT",
    path: "MASKED",
    fast: true,
    value: "adidas jersey",
  },

  // ─── Fall-through. ASK, because there is no LLM stage and ASK is the safe answer. ────────────
  {
    text: "add an adidas logo to the jersey",
    hasPhoto: true,
    op: "APPLY_DESIGN",
    path: "MASKED",
    fast: true,
  },
  // ⚠️ STILL ASK, BUT NOT FOR THE REASON IT USED TO BE. Rule 4a now parses this, so it reaches
  // `validate` and the PERSON GUARD denies it on "the back" — where before it never got past rule
  // 4 at all. Same path, different cause, and the cause is pinned below so the shift is visible
  // rather than incidental. "the back" is genuinely ambiguous between the jersey's back panel and
  // hers, and a false ASK costs a clarifying question while a false allow edits her body.
  {
    text: "put a number 10 on the back",
    hasPhoto: true,
    path: "ASK",
    fast: false,
  },
  {
    text: "give the socks a striped pattern",
    hasPhoto: true,
    op: "APPLY_DESIGN",
    path: "MASKED",
    fast: true,
  },
  // ─── 2026-09-10 (B.1c): REVERSED — a model name routes as its brand, the model dropped from the
  // value and disclosed on the preview (Adi's product call: the brand vibe, not a refusal).
  {
    text: "swap the cleats for Nike Mercurials",
    hasPhoto: true,
    op: "REPLACE_OBJECT",
    path: "MASKED",
    fast: true,
    value: "nike cleats",
  },
  // ─── 2026-09-10: a brand change WITH A DESCRIPTOR routes too (rule 4c) — one REPLACE whose value
  // carries the colour verbatim, so neither half of what she asked is dropped.
  {
    text: "make my jersey a blue adidas kit",
    hasPhoto: true,
    op: "REPLACE_OBJECT",
    path: "MASKED",
    fast: true,
    value: "blue adidas jersey",
  },
  // Deterministic again as of rule 0: `allowedOps` permits GENERATE here because the sentence
  // matched EXPLICIT_GENERATE, and rule 0 selects exactly what the gate permitted — no second
  // opinion, and nothing that can reach GENERATE where commit 1 withheld it.
  {
    text: "generate a new poster of me",
    hasPhoto: true,
    op: "GENERATE",
    path: "GENERATE",
    fast: true,
  },
  { text: "make her look taller", hasPhoto: true, path: "ASK", fast: false },
  {
    text: "change the person to a man",
    hasPhoto: true,
    path: "ASK",
    fast: false,
  },
  { text: "make it pop", hasPhoto: true, path: "ASK", fast: false },
];

describe("the golden set", () => {
  it("resolves 100% of the deterministic cases to the right op AND the right path", () => {
    // The ship rule. Not "most of them" and not "the ones we remembered" — every case the fast path
    // claims, with its op and its resolved path both pinned, because an op that routes to the wrong
    // path is exactly as broken as the wrong op.
    for (const c of GOLDEN.filter((g) => g.fast)) {
      const out = route(c.text, c.hasPhoto);
      expect({
        text: c.text,
        op: out.steps[0]?.op,
        path: out.initialPath,
      }).toEqual({
        text: c.text,
        op: c.op,
        path: c.path,
      });
      // ⚠️ PINNED EVEN THOUGH THE EXTRACTION IS CRUDE. `value` is a regex grabbing what follows a
      // preposition, and it is weak — which is exactly why it is asserted. An unpinned field drifts
      // silently, and PR 2 wires this: a failing test then beats a mysterious stadium.
      if (c.value !== undefined) expect(out.steps[0]?.value).toBe(c.value);
    }
  });

  it("sends every non-deterministic case to ASK rather than guessing", () => {
    for (const c of GOLDEN.filter((g) => !g.fast)) {
      const out = route(c.text, c.hasPhoto);
      expect({ text: c.text, path: out.initialPath }).toEqual({
        text: c.text,
        path: "ASK",
      });
    }
  });

  it("never lets a fall-through become a destructive path", () => {
    // ASK is the only safe fall-through. This pins that it stays the fall-through — a future stage
    // that resolved these to GENERATE or FULL_IMAGE would be re-rendering a frame on a guess.
    for (const c of GOLDEN.filter((g) => !g.fast)) {
      expect(["GENERATE", "FULL_IMAGE", "BACKGROUND", "MASKED"]).not.toContain(
        route(c.text, c.hasPhoto).initialPath,
      );
    }
  });
});

describe("rule order is load-bearing — these fail if the rules are reordered", () => {
  it("REMOVE beats BG: 'get rid of the cone behind me' is a removal, not a background swap", () => {
    // BG matches "behind me". Rule 1 runs first, so the cone is removed. Move rule 2 above rule 1
    // and this sentence replaces her entire background instead of deleting a cone.
    const out = route("get rid of the cone behind me", true);
    expect(out.steps[0].op).toBe("REMOVE_OBJECT");
    expect(out.steps[0].targets).toEqual(["cone"]);
    expect(out.initialPath).toBe("MASKED");
  });

  it("GLOBAL beats COLOR: 'make it golden hour' is a grade, not a recolor", () => {
    // COLOR matches gold(en)?. Rule 3 runs first, so it is a whole-frame look. Move rule 5 above
    // rule 3 and a time-of-day grade becomes a region recolor — of a region nobody named.
    const out = route("make it golden hour", true);
    expect(out.steps[0].op).toBe("GLOBAL_STYLE");
    expect(out.steps[0].scope).toBe("GLOBAL");
    expect(out.steps[0].targets).toEqual([]);
  });

  it("DESIGN beats COLOR — the recolor-vs-design distinction, in one assertion", () => {
    // ─── THE TEST THE CARD ASKS FOR BY NAME ────────────────────────────────────────────────────
    //
    // "change my jersey to adidas" contains a target and no colour, so rule 5 would not fire on it
    // anyway. "make my jersey a blue adidas kit" is the one that matters: it contains BOTH, rule 5
    // would happily call it a RECOLOR of "jersey" to "blue", and that answer silently drops the
    // adidas half of what she asked for. Rule 4 declining is what prevents it.
    //
    // ⚠️ 2026-09-10: rule 4 no longer declines it — 4c routes it as ONE REPLACE carrying the colour
    // (the brand decision, with a descriptor). The property this test is named for is unchanged and
    // now asserted positively: never a RECOLOR, and BOTH halves in the one value.
    expect(
      classifyFast("make my jersey a blue adidas kit", true)?.steps,
    ).toEqual([
      {
        op: "REPLACE_OBJECT",
        targets: ["jersey"],
        value: "blue adidas jersey",
        scope: "REGION",
      },
    ]);
    expect(
      route("make my jersey a blue adidas kit", true).steps.map((s) => s.op),
    ).not.toContain("RECOLOR");

    // And the colour-only twin still fast-paths, so rule 4 is disqualifying the design case rather
    // than disabling rule 5 outright.
    expect(route("make my jersey blue", true).steps[0].op).toBe("RECOLOR");
  });

  it("META_NOUNS is consulted by rules 3 and 5 but never by rule 2", () => {
    // "the photo" is not a region, so a grade naming it is still a grade rather than a recolor of
    // something called "photo".
    expect(route("make the photo black and white", true).steps[0].op).toBe(
      "GLOBAL_STYLE",
    );
    // ...but "background" must stay a real word for rule 2, which matches the SENTENCE and never
    // asks META_NOUNS anything. If the filter ran earlier this would lose its route.
    expect(route("change the background to a beach", true).initialPath).toBe(
      "BACKGROUND",
    );
  });
});

describe("step ordering — full-image before masked, because the frame is regenerated", () => {
  const recolor: EditStep = {
    op: "RECOLOR",
    targets: ["jersey"],
    value: "blue",
    scope: "REGION",
  };
  const design: EditStep = {
    op: "APPLY_DESIGN",
    targets: ["jersey"],
    value: "adidas branding",
    scope: "REGION",
  };

  it("puts RECOLOR before APPLY_DESIGN however they arrive", () => {
    // ─── THE OTHER TEST THE CARD ASKS FOR BY NAME ──────────────────────────────────────────────
    //
    // A masked composite pastes pixels into a fixed frame; a later full-image re-render regenerates
    // that frame and destroys them. Run these in the stated order and the adidas mark is applied to
    // a jersey that is then re-rendered blue WITHOUT it — two successful steps and a wrong picture.
    expect(orderSteps([design, recolor]).map((s) => s.op)).toEqual([
      "RECOLOR",
      "APPLY_DESIGN",
    ]);
    expect(orderSteps([recolor, design]).map((s) => s.op)).toEqual([
      "RECOLOR",
      "APPLY_DESIGN",
    ]);
  });

  it("sorts by PATH, not by op, so a table edit moves the order with it", () => {
    // The ordering reads ROUTE rather than hardcoding operations. Moving RECOLOR to MASKED in the
    // table would change this ordering automatically, which is the point of rule ①.
    expect(orderSteps([design, recolor]).map((s) => ROUTE[s.op])).toEqual([
      "FULL_IMAGE",
      "MASKED",
    ]);
  });

  it("is stable among steps sharing a path, so her stated order survives", () => {
    const a: EditStep = {
      op: "REMOVE_OBJECT",
      targets: ["cone"],
      value: null,
      scope: "REGION",
    };
    const b: EditStep = {
      op: "REPLACE_OBJECT",
      targets: ["cleats"],
      value: "nike",
      scope: "REGION",
    };
    expect(orderSteps([a, b]).map((s) => s.op)).toEqual([
      "REMOVE_OBJECT",
      "REPLACE_OBJECT",
    ]);
    expect(orderSteps([b, a]).map((s) => s.op)).toEqual([
      "REPLACE_OBJECT",
      "REMOVE_OBJECT",
    ]);
  });
});

describe("the person guard at classification time — one implementation, imported", () => {
  const step = (op: EditOperation, targets: string[]): Classification => ({
    steps: [
      {
        op,
        targets,
        value: "x",
        scope: op === "CHANGE_BACKGROUND" ? "SUBJECT_INVERSE" : "REGION",
      },
    ],
  });
  const NON_BACKGROUND: EditOperation[] = [
    "RECOLOR",
    "APPLY_DESIGN",
    "REPLACE_OBJECT",
    "REMOVE_OBJECT",
    "ADD_OBJECT",
    "GLOBAL_STYLE",
    "GENERATE",
  ];

  it("denies every person term on every non-CHANGE_BACKGROUND op", () => {
    // The table the card asks for. Cross product, not a sample — the guard's whole claim is that
    // there is no combination of word and operation that gets through.
    for (const word of PERSON_NOUNS) {
      for (const op of NON_BACKGROUND) {
        const out = validate(step(op, [word]), false, "generate a new image");
        expect({ word, op, path: out.initialPath, reason: out.reason }).toEqual(
          {
            word,
            op,
            path: "ASK",
            reason: "person_target",
          },
        );
      }
    }
  });

  it("denies her named with a modifier, because it reuses namesPerson rather than a second list", () => {
    // Proves the import is real. These phrases are not in PERSON_NOUNS; they are caught by the
    // head-noun rule from commit 2, so a second implementation here would fail this.
    for (const phrase of [
      "her left arm",
      "my right hand",
      "the tall player",
      "young athlete",
    ]) {
      expect(validate(step("RECOLOR", [phrase]), true, "x").reason).toBe(
        "person_target",
      );
    }
  });

  it("closes at the OPERATION layer too, because there is ONE namesPerson and not two", () => {
    // ⚠️ THE PAYOFF FROM REFUSING TO WRITE A SECOND IMPLEMENTATION. `validate` imports the same
    // `namesPerson` the vocabulary uses, so widening PERSON_NOUNS on 2026-09-09 tightened the
    // classifier for free and in the same commit.
    //
    // Before: "make my bicep red" produced RECOLOR with targets ["bicep"], resolved to FULL_IMAGE,
    // and re-rendered the frame to change a part of her body. After: it never routes.
    //
    // Two copies of this rule would have meant fixing it twice and discovering the second copy
    // months later, which is the failure mode the single-implementation argument is about.
    const out = route("make my bicep red", true);
    expect(out.initialPath).toBe("ASK");
    expect(out.reason).toBe("person_target");
  });

  it("ALLOWS a person target on CHANGE_BACKGROUND, which is the whole exception", () => {
    const out = validate(
      step("CHANGE_BACKGROUND", ["person"]),
      true,
      "put me in a stadium",
    );
    expect(out.initialPath).toBe("BACKGROUND");
    expect(out.steps[0].scope).toBe("SUBJECT_INVERSE");
  });

  it("leaves ordinary object targets alone", () => {
    expect(validate(step("RECOLOR", ["socks"]), true, "x").initialPath).toBe(
      "FULL_IMAGE",
    );
    expect(
      validate(step("REMOVE_OBJECT", ["water bottle"]), true, "x").initialPath,
    ).toBe("MASKED");
  });
});

describe("the hard invariant — GENERATE needs no photo, or an explicit ask", () => {
  const gen = (): Classification => ({
    steps: [{ op: "GENERATE", targets: [], value: null, scope: "GLOBAL" }],
  });

  it("refuses GENERATE with a source photo and no explicit phrase", () => {
    const out = validate(gen(), true, "make the socks blue");
    expect(out.initialPath).toBe("ASK");
    expect(out.reason).toBe("generate_not_permitted");
  });

  it("permits it when she asked explicitly", () => {
    expect(
      validate(gen(), true, "generate a new poster of me").initialPath,
    ).toBe("GENERATE");
  });

  it("permits it when there is no photo to destroy", () => {
    expect(validate(gen(), false, "make the socks blue").initialPath).toBe(
      "GENERATE",
    );
  });
});

describe("target extraction declines rather than guessing", () => {
  it("stops a phrase at a preposition, so a target is a name and not a sentence", () => {
    expect(
      extractTargets("get rid of the cone behind me").map((t) => t.phrase),
    ).toEqual(["cone"]);
  });

  it("stops at a colour, because the colour is the value and not part of the thing", () => {
    expect(extractTargets("make the socks blue").map((t) => t.phrase)).toEqual([
      "socks",
    ]);
  });

  it("finds nothing when a pronoun stands in for the frame", () => {
    // The tell that the determiner rule is sound rather than convenient.
    expect(extractTargets("make it black and white")).toEqual([]);
    expect(extractTargets("make it pop")).toEqual([]);
  });

  it("keeps the determiner beside the phrase, which is what the diagnostics are for", () => {
    expect(extractTargets("put a number 10 on the back")).toEqual([
      { determiner: "a", phrase: "number" },
      { determiner: "the", phrase: "back" },
    ]);
    expect(extractTargets("change my jersey to blue")).toEqual([
      { determiner: "my", phrase: "jersey" },
    ]);
  });

  it("ends a phrase at a comma — the next clause is not part of the noun (§7.3)", () => {
    // Measured before the fix: "image place it" and "second image place". Both are the following
    // clause glued onto a noun, and `targets` is what a segmenter is handed.
    expect(
      extractTargets(
        "add a soccer ball to the image, place it in the middle of my cleats",
      ).map((t) => t.phrase),
    ).toEqual(["soccer ball", "image", "middle", "cleats"]);
    expect(
      extractTargets(
        "add the soccer ball from the second image, place it between her cleats",
      ).map((t) => t.phrase),
    ).toEqual(["soccer ball", "second image", "cleats"]);
  });

  it("ends a phrase at a full stop, so it cannot walk into the next sentence (§7.3)", () => {
    // §7.1's fourth phrasing. Before the fix the first sentence's last noun took the second
    // sentence's verb: "first one place".
    expect(
      extractTargets(
        "add the soccer ball from the second image into the first one. place it in the middle of the cleats.",
      ).map((t) => t.phrase),
    ).toEqual(["soccer ball", "second image", "first one", "middle", "cleats"]);
    // And it reaches routing, not just the extractor: this used to REMOVE_OBJECT a target called
    // "water bottle thanks", which is the thing a segmenter would have been asked to find.
    expect(
      route("remove the water bottle. thanks", true).steps[0]?.targets,
    ).toEqual(["water bottle"]);
  });

  it("caps a phrase at three words, matching the segmenter's own noun bound", () => {
    // ⚠️ THIS USED TO EXPECT ["big"], AND THAT WAS THE BUG WEARING A PASSING TEST. The phrase
    // stopped at the colour, leaving a lone adjective as the target — and `targets` is what SAM is
    // asked to segment, so the pipeline went looking for "big". Now the trailing-modifier strip
    // empties it, no target is found, and rule 1 declines to ASK. Strictly better: a clarifying
    // question instead of a mask around an adjective.
    expect(
      extractTargets("remove the big red water bottle thing").map(
        (t) => t.phrase,
      ),
    ).toEqual([]);
    expect(
      extractTargets("remove the small water bottle").map((t) => t.phrase),
    ).toEqual(["small water bottle"]);
  });
});

describe("rule 4a — APPLY_DESIGN has a route, and the value/target split is what makes it correct", () => {
  it("routes the prepositional construction and puts the design in VALUE, not targets", () => {
    // ─── THE ASSERTION THIS WHOLE RULE EXISTS FOR ──────────────────────────────────────────────
    //
    // `extractTargets` finds BOTH "adidas logo" and "jersey" — both are determiner-introduced and
    // it cannot know which is placed on which. Handing that through would put "adidas logo" into
    // `targets`, and `targets` is what SAM is asked to segment: it would go hunting for an adidas
    // logo in a photograph that does not have one yet, which is the entire request.
    const out = route("add an adidas logo to the jersey", true);
    expect(out.steps[0].op).toBe("APPLY_DESIGN");
    expect(out.initialPath).toBe("MASKED");
    expect(out.steps[0].targets).toEqual(["jersey"]);
    expect(out.steps[0].targets).not.toContain("adidas logo");
    expect(out.steps[0].value).toBe("adidas logo");
    expect(out.steps[0].scope).toBe("REGION");
  });

  it("routes every placement verb, not just 'add'", () => {
    for (const text of [
      "add a logo to the jersey",
      "put a sponsor mark on the jersey",
      "place a badge on the jersey",
      "stick a patch on the jersey",
    ]) {
      const out = route(text, true);
      expect({
        text,
        op: out.steps[0]?.op,
        targets: out.steps[0]?.targets,
      }).toEqual({
        text,
        op: "APPLY_DESIGN",
        targets: ["jersey"],
      });
    }
  });

  it("routes the ditransitive construction, which has no preposition to split on", () => {
    // "give <target> <value>" puts the target FIRST. The prepositional parse cannot see it at all,
    // which is why this is a separate parse rather than another verb in the list.
    const socks = route("give the socks a striped pattern", true);
    expect(socks.steps[0].op).toBe("APPLY_DESIGN");
    expect(socks.steps[0].targets).toEqual(["socks"]);
    expect(socks.steps[0].value).toBe("striped pattern");

    const jersey = route("give the jersey an adidas logo", true);
    expect(jersey.steps[0].targets).toEqual(["jersey"]);
    expect(jersey.steps[0].value).toBe("adidas logo");
  });

  it("declines to 4b when the design token is on the TARGET side", () => {
    // "add a stripe to the logo" is a different request — it edits a logo that already exists —
    // and this parse does not understand it. Declining is the honest answer.
    expect(classifyFast("add a stripe to the logo", true)).toBeNull();
  });

  it("declines to 4b with no placement verb — the case rule 4 was actually written for", () => {
    // Genuinely ambiguous between adidas BRANDING and an adidas-STYLE kit. Picking one silently is
    // how she gets a whole new kit when she asked for a logo.
    //
    // ⚠️ 2026-09-10: that ambiguity is DECIDED for "change my jersey to adidas", which routes now
    // (rule 4c — pinned in its own block). 4b is still the answer for the brand sentence 4c cannot
    // read: a colour inside an item — which socks, or which colour? (This test named the Mercurials
    // until B.1c routed a model name as its brand.)
    expect(classifyFast("change my red socks to nike", true)).toBeNull();
    expect(route("change my red socks to nike", true).initialPath).toBe("ASK");
  });

  it("still lets design beat colour — the precedence rule 4a must not break", () => {
    // No placement verb, so 4b declines rather than rule 5 calling it a RECOLOR of "jersey" to
    // "blue" and silently dropping the adidas half of what she asked for.
    //
    // ⚠️ 2026-09-10: 4c claims it now, whole — so the precedence holds by routing rather than by
    // declining: rule 5 still never sees it, and the value keeps the colour AND the brand.
    const out = route("make my jersey a blue adidas kit", true);
    expect(out.steps.map((s) => s.op)).not.toContain("RECOLOR");
    expect(out.steps.map((s) => s.value)).toEqual(["blue adidas jersey"]);
  });

  it("reaches the person guard now instead of declining before it", () => {
    // ⚠️ THE BEHAVIOUR CHANGE WORTH SEEING. These used to stop at rule 4 and never be examined.
    // They now parse, reach `validate`, and are denied on the TARGET — same ASK, different and far
    // better reason, because the guard is what should be refusing an edit to her body.
    for (const text of [
      "add a logo to the chest",
      "put a number 10 on the back",
    ]) {
      const out = route(text, true);
      expect({ text, path: out.initialPath, reason: out.reason }).toEqual({
        text,
        path: "ASK",
        reason: "person_target",
      });
    }
  });
});

describe("rule 4½ — ADD_OBJECT: a thing not in the frame yet, put somewhere in it (PR C′)", () => {
  it("routes an add of a thing, native-only, with the thing first and the place as the value", () => {
    const out = route("put a water bottle on the grass", true);
    expect(out.initialPath).toBe("FULL_IMAGE");
    expect(out.steps).toEqual([
      {
        op: "ADD_OBJECT",
        // The thing, then every surface it lands ON — the guard reads both.
        targets: ["water bottle", "grass"],
        value: "on the grass",
        scope: "REGION",
        // ⚠️ SHE LED WITH `put`, AND THE MARKER IS WHY THIS STEP CAN STILL BECOME A MOVE (D1). The
        // ROUTE is unchanged — still an add, still these targets and this value — and the marker only
        // tells the freeze which verb she used, because whether the thing is already in the photograph
        // is a fact only detection's regions can settle. An `add` sentence carries no marker.
        fromPut: true,
      },
    ]);
  });

  it("keeps the colour with the thing — an add is not a recolor of anything", () => {
    const out = route("add a red ball on the bench", true);
    expect(out.steps[0]?.op).toBe("ADD_OBJECT");
    expect(out.steps[0]?.targets[0]).toBe("red ball");
  });

  describe("THE APPLY_DESIGN BOUNDARY — a design or brand token is never an add", () => {
    it("'add the nike logo to my shirt' stays APPLY_DESIGN", () => {
      const out = route("add the nike logo to my shirt", true);
      expect(out.steps[0]?.op).toBe("APPLY_DESIGN");
      expect(out.steps[0]?.targets).toEqual(["shirt"]);
      expect(out.steps[0]?.value).toBe("nike logo");
    });

    it("and it is the RULE ORDER that keeps it there — the add parse alone would claim it", () => {
      // What makes the test above able to fail. The parse reads "the nike logo" as a perfectly good
      // thing; only rule 4 running first keeps a brand's mark out of ADD_OBJECT.
      expect(parseAddObject("add the nike logo to my shirt")).not.toBeNull();
    });

    it("the shared PLACEMENT_PREP is untouched: 'add a sponsor patch at the top of the sleeve' still asks", () => {
      // D3. An add-only placement list, because widening the shared one moves APPLY_DESIGN's split
      // and would route this with targets [top, sleeve].
      const out = route("add a sponsor patch at the top of the sleeve", true);
      expect(out.initialPath).toBe("ASK");
      expect(out.steps).toEqual([]);
    });
  });

  describe("THE PERSON GUARD, UNCHANGED — the add hands it the thing and every surface it touches", () => {
    it("asks when the THING is a person", () => {
      const out = route("add a girl on the bench", true);
      expect({ path: out.initialPath, reason: out.reason }).toEqual({
        path: "ASK",
        reason: "person_target",
      });
    });

    it("asks when the thing lands ON her — a tattoo on her arm, a crown on her head (D1's side that stays)", () => {
      for (const text of [
        "add a tattoo on my arm",
        "add a crown on my head",
        "add muscles to my arms",
      ]) {
        const out = route(text, true);
        expect({ text, path: out.initialPath, reason: out.reason }).toEqual({
          text,
          path: "ASK",
          reason: "person_target",
        });
      }
      // D1's own example, "add a hat on her head", was here until PR M3: a hat is worn (N6), so it is
      // rule 3¾b's now — an add of the hat, her head consumed as where it is worn.
      expect(route("add a hat on her head", true).steps[0]?.targets).toEqual([
        "hat",
      ]);
    });

    it("reads a lone pronoun as the person — 'on me' is her, though the guard's list has no 'me'", () => {
      // Measured: "put a hat on me" ROUTED before the pronoun check, as ADD_OBJECT with targets ["hat",
      // "me"]. A hat is worn since PR M3 (rule 3¾b's), so a thing she does not wear stands in for it.
      expect(namesPerson("me")).toBe(false);
      const out = route("put a sticker on me", true);
      expect({ path: out.initialPath, reason: out.reason }).toEqual({
        path: "ASK",
        reason: "person_target",
      });
    });

    it("leaves a surface that is not her alone", () => {
      expect(route("put a water bottle on the grass", true).initialPath).toBe(
        "FULL_IMAGE",
      );
    });
  });

  describe("IT DECLINES RATHER THAN GUESSES", () => {
    it("asks for an add with no place — a no-place add was never measured (D2)", () => {
      expect(parseAddObject("add a soccer ball")).toBeNull();
      expect(route("add a soccer ball", true).initialPath).toBe("ASK");
    });

    it("asks when something is left over — a second instruction it did not read", () => {
      expect(
        parseAddObject("add a ball on the bench and make it pop"),
      ).toBeNull();
      expect(
        parseAddObject(
          "add a soccer ball between my cleats, keep everything else the same",
        ),
      ).toBeNull();
    });

    it("asks for a place it does not understand rather than folding it into the thing", () => {
      // Not "ball near the bench": every preposition ends the thing, known or not. (This was "near my feet"
      // until wave A's G1, which reads "near" before a part of her as where the thing goes — and only there.)
      expect(parseAddObject("add a ball near the bench")).toBeNull();
    });

    it("asks for no thing, a vague thing, or a thing too long to be a name", () => {
      expect(parseAddObject("put it on the bench")).toBeNull();
      expect(parseAddObject("add something on the bench")).toBeNull();
      expect(
        parseAddObject(
          "add a large insulated gatorade water bottle on the bench",
        ),
      ).toBeNull();
    });

    it("only reads an add that LEADS the sentence, so half an instruction is never an add", () => {
      const text = "make the socks blue and add a ball on the bench";
      // The parse still reads only an add that leads: the whole sentence is not an add.
      expect(parseAddObject(text)).toBeNull();
      // And the sentence is never HALF-read. Main read it as RECOLOR [socks, ball, bench]; since
      // composition (rule ½) each half goes through its own rule, so the add is read as an add from
      // its own clause — which it leads — and the recolour keeps its socks.
      expect(
        route(text, true).steps.map((s) => [s.op, s.targets, s.value]),
      ).toEqual([
        ["RECOLOR", ["socks"], "blue"],
        ["ADD_OBJECT", ["ball", "bench"], "on the bench"],
      ]);
    });
  });
});

describe("C.2 — placement language: the sentences that asked live now parse", () => {
  const parsed = (text: string) => {
    const p = parseAddObject(text);
    return p && { thing: p.thing, place: p.place, surfaces: p.surfaces };
  };

  it("routes all four §7.1 phrasings, each to its own thing and place", () => {
    expect(
      parsed(
        "add a soccer ball to the image, place it in the middle of my cleats",
      ),
    ).toEqual({
      thing: "soccer ball",
      place: "in the middle of my cleats",
      surfaces: [],
    });
    expect(parsed("add a soccer ball at her feet")).toEqual({
      thing: "soccer ball",
      place: "at her feet",
      surfaces: [],
    });
    expect(parsed("put a water bottle on the grass next to me")).toEqual({
      thing: "water bottle",
      place: "on the grass next to me",
      surfaces: ["grass"],
    });
    // Across a FULL STOP, and only as "place it" — the one crossing continuationAt allows.
    expect(
      parsed(
        "add the soccer ball from the second image into the first one. place it in the middle of the cleats.",
      ),
    ).toEqual({
      thing: "soccer ball",
      place: "in the middle of the cleats",
      surfaces: [],
    });
  });

  it("never lets §7.3's junk reach an add — every one of those strings is gone from thing and targets", () => {
    const JUNK = [
      "image place it",
      "first one place",
      "grass next",
      "middle",
      "feet",
      "her feet",
    ];
    for (const text of [
      "add a soccer ball to the image, place it in the middle of my cleats",
      "add a soccer ball at her feet",
      "put a water bottle on the grass next to me",
      "add the soccer ball from the second image into the first one. place it in the middle of the cleats.",
    ]) {
      const step = route(text, true).steps[0];
      expect(step?.op).toBe("ADD_OBJECT");
      for (const junk of JUNK) {
        expect({ text, junk, in: step?.targets.includes(junk) }).toEqual({
          text,
          junk,
          in: false,
        });
      }
    }
  });

  it("routes Q1's prompts — the ones the probe measured 6/6", () => {
    for (const text of [
      "add the soccer ball from the second image, place it between her cleats",
      "place this ball at her feet",
      "put the soccer ball from the second image on the grass beside her right foot",
      "place the water bottle from the second image on top of her head",
    ]) {
      const out = route(text, true);
      expect({ text, path: out.initialPath, op: out.steps[0]?.op }).toEqual({
        text,
        path: "FULL_IMAGE",
        op: "ADD_OBJECT",
      });
    }
  });

  describe("D1, THE SPATIAL SIDE — near her is not on her", () => {
    it("routes the bottle on top of her head — Q1's positive control, CLEAN in the probe", () => {
      const out = route(
        "place the water bottle from the second image on top of her head",
        true,
      );
      expect(out.steps[0]).toEqual({
        op: "ADD_OBJECT",
        // The thing only: "on top of" puts it NEAR her head, so her head is not a target.
        targets: ["water bottle"],
        value: "on top of her head",
        scope: "REGION",
      });
    });

    it("routes a place that names her when the thing only goes near her", () => {
      expect(route("add a soccer ball at her feet", true).initialPath).toBe(
        "FULL_IMAGE",
      );
      expect(route("add a ball next to her", true).initialPath).toBe(
        "FULL_IMAGE",
      );
    });

    it("still asks for the pinned other side: on her head, on my arm, into her hands", () => {
      // On her head: a crown, which is not worn (N6). The hat pinned here until PR M3 is rule 3¾b's.
      for (const text of [
        "add a crown on her head",
        "add a tattoo on my arm",
        "put the ball into her hands",
      ]) {
        expect({ text, reason: route(text, true).reason }).toEqual({
          text,
          reason: "person_target",
        });
      }
      // …and "into" lands ON a place that is not her like any other surface.
      expect(
        route("put the ball into the net", true).steps[0]?.targets,
      ).toEqual(["ball", "net"]);
    });
  });

  it("takes where the thing comes FROM, before or after the place, and drops it", () => {
    expect(parsed("put the ball on the grass from the second image")).toEqual({
      thing: "ball",
      place: "on the grass",
      surfaces: ["grass"],
    });
  });

  it("asks when the only 'place' names the photograph — that is a no-place add (D2)", () => {
    // C.1's surface-only parse read "to the image" as a place and ROUTED this; the frame reference
    // is consumed now, so the add has no place and asks.
    expect(parsed("add a soccer ball to the image")).toBeNull();
    expect(route("add a soccer ball to the image", true).initialPath).toBe(
      "ASK",
    );
    expect(parsed("add a ball on the photo")).toBeNull();
    // After "place it" the frame reference has already had its turn, so only the place's own check
    // can refuse this — the case that makes that check a guard rather than a duplicate.
    expect(parsed("add a ball, place it on the photo")).toBeNull();
  });

  it("crosses a full stop ONLY as 'place it' — any other second sentence is left over, and asks", () => {
    expect(parsed("add a soccer ball. place it at my feet")).not.toBeNull();
    expect(parsed("add a soccer ball at my feet. make it pop")).toBeNull();
  });
});

describe("rule 4c — a brand change routes as a REPLACE, one step per item, all of it or none (2026-09-10)", () => {
  /** Each step as [op, targets, value, scope] — the four fields the spend-time re-check compares. */
  const steps = (text: string) =>
    route(text, true).steps.map((s) => [s.op, s.targets, s.value, s.scope]);
  const declined = { initialPath: "ASK", steps: [], reason: "brand_change" };

  it("routes the G2 sentence as a REPLACE of the jersey — the kit reading, by decision", () => {
    expect(route("change my jersey to adidas", true)).toEqual({
      initialPath: "MASKED",
      steps: [
        {
          op: "REPLACE_OBJECT",
          targets: ["jersey"],
          value: "adidas jersey",
          scope: "REGION",
        },
      ],
    });
  });

  it("reads EVERY item of the screenshot sentence — where the determiner reader keeps one of three", () => {
    const text = "change my uniform, socks, and shoes all to be adidas";
    // Why 4c has its own list reader: `extractTargets` anchors on determiners, and only the uniform
    // has one. Read that way, the socks and the shoes would vanish without a word.
    expect(extractTargets(text).map((t) => t.phrase)).toEqual(["uniform"]);
    expect(steps(text)).toEqual([
      ["REPLACE_OBJECT", ["uniform"], "adidas uniform", "REGION"],
      ["REPLACE_OBJECT", ["socks"], "adidas socks", "REGION"],
      ["REPLACE_OBJECT", ["shoes"], "adidas shoes", "REGION"],
    ]);
    expect(route(text, true).initialPath).toBe("MASKED");
  });

  it("reads each construction the same way — the verb, the link, the article, the item named again", () => {
    const table: [string, [string, string][]][] = [
      ["turn my kit into an adidas one", [["kit", "adidas kit"]]],
      ["switch my cleats to puma", [["cleats", "puma cleats"]]],
      ["make my socks nike", [["socks", "nike socks"]]],
      ["swap my cleats for adidas ones", [["cleats", "adidas cleats"]]],
      ["change my jersey to an adidas jersey", [["jersey", "adidas jersey"]]],
      [
        "please change the socks and the shoes to new balance.",
        [
          ["socks", "new balance socks"],
          ["shoes", "new balance shoes"],
        ],
      ],
      [
        "change both my socks and shoes to nike",
        [
          ["socks", "nike socks"],
          ["shoes", "nike shoes"],
        ],
      ],
    ];
    for (const [text, items] of table) {
      expect({ text, steps: steps(text) }).toEqual({
        text,
        steps: items.map(([target, value]) => [
          "REPLACE_OBJECT",
          [target],
          value,
          "REGION",
        ]),
      });
    }
  });

  it("keeps the brand it is NOW in the target, which names which jersey, and out of the value", () => {
    expect(steps("change my nike jersey to adidas")).toEqual([
      ["REPLACE_OBJECT", ["nike jersey"], "adidas jersey", "REGION"],
    ]);
    // A brand with no thing after it is no item — which of her things is "my nike"?
    expect(parseBrandChange("change my nike to adidas")).toBeNull();
  });

  it("NO SILENT PARTIAL — one item that does not read declines the whole sentence", () => {
    // A colour inside the third item, and a four-word item. A reader that skipped the bad item
    // would route [jersey, socks] and quote her for two-thirds of what she asked; this one asks.
    for (const text of [
      "change my jersey, socks and my lucky red shoes to adidas",
      "change my jersey and my old worn training shoes to adidas",
    ]) {
      expect({ text, parsed: parseBrandChange(text) }).toEqual({
        text,
        parsed: null,
      });
      expect(route(text, true)).toMatchObject(declined);
    }
  });

  it("THE CAP DECLINES LOUDLY — four items route, a fifth asks rather than being dropped", () => {
    expect(
      steps("change my jersey, shorts, socks and shoes to adidas"),
    ).toHaveLength(4);
    // `validate` would slice a fifth item off without a word; the parse refuses it first.
    const five = "change my jersey, shorts, socks, shoes and gloves to adidas";
    expect(parseBrandChange(five)).toBeNull();
    expect(route(five, true)).toMatchObject(declined);
  });

  it("reads the whole sentence or none of it — anything left over asks", () => {
    for (const text of [
      // (B.1b pinned "…to an adidas hoodie" here as a different thing. Since B.1c "hoodie" is a word it
      // cannot read and is DROPPED with disclosure — the flagged class, pinned in the degrade test.)
      // A possessive, not guessed at.
      "change my jersey's logo to adidas",
      // The verb must lead, as rule 4½'s does.
      "can you change my jersey to adidas",
    ]) {
      expect({ text, parsed: parseBrandChange(text) }).toEqual({
        text,
        parsed: null,
      });
      expect({ text, path: route(text, true).initialPath }).toEqual({
        text,
        path: "ASK",
      });
    }
    // A second instruction — after the brand, and after a descriptor. 4c still reads NONE of either
    // sentence: it is all-or-nothing, and "and make the socks white" is not an item. What changed is
    // that composition (rule ½) now reads each clause with its own rule, so these two ROUTE — a
    // REPLACE from 4c's clause and a RECOLOR from rule 5's. That route() assertion moved to the
    // composition block ("4c's clause composes"), said there in full; it is not dropped.
    for (const text of [
      "change my jersey to adidas and make the socks white",
      "change my jersey to adidas blue and make the socks white",
    ]) {
      expect({ text, parsed: parseBrandChange(text) }).toEqual({
        text,
        parsed: null,
      });
    }
  });

  it("CARRIES ITS DESCRIPTORS WHOLE — 'a blue adidas kit' is one REPLACE whose value says what she said", () => {
    // Mia's decision covers a brand transformation with a descriptor. Not two edits, not a colour
    // dropped: the descriptor rides into the value verbatim, where she put it, and the value names the
    // ITEM ("jersey") whatever head she used ("kit", "one", or none).
    const table: [string, [string, string][]][] = [
      ["make my jersey a blue adidas kit", [["jersey", "blue adidas jersey"]]],
      [
        "change my jersey to an all-black nike kit",
        [["jersey", "all-black nike jersey"]],
      ],
      ["make my jersey adidas blue", [["jersey", "adidas blue jersey"]]],
      [
        "change my jersey to an adidas all-white kit",
        [["jersey", "adidas all-white jersey"]],
      ],
      [
        "change my jersey to a vintage adidas kit",
        [["jersey", "vintage adidas jersey"]],
      ],
      ["change my jersey to an adidas kit", [["jersey", "adidas jersey"]]],
      [
        "change my nike jersey to a light blue adidas jersey",
        [["nike jersey", "light blue adidas jersey"]],
      ],
      [
        "change my socks and shoes to black and white nike ones",
        [
          ["socks", "black and white nike socks"],
          ["shoes", "black and white nike shoes"],
        ],
      ],
    ];
    for (const [text, items] of table) {
      expect({ text, steps: steps(text) }).toEqual({
        text,
        steps: items.map(([target, value]) => [
          "REPLACE_OBJECT",
          [target],
          value,
          "REGION",
        ]),
      });
    }
  });

  // ─── B.1c (2026-09-10): a model name DEGRADES WITH DISCLOSURE — it no longer asks ──────────────
  //
  // REVERSED from B.1b, which pinned these three as asking. Adi's product call: a sentence naming a
  // specific model gets the brand vibe, not a refusal — matching the model was never possible anyway.
  // The unreadable words are dropped from the VALUE only, ride beside it as `dropped`, and the preview
  // discloses them (nativeEdit.ts, droppedWordsNote); the instruction never carries them.
  it("DEGRADES a model name to brand + item, the dropped words beside the value — never in it", () => {
    const withDropped = (text: string) =>
      route(text, true).steps.map((s) => [s.targets, s.value, s.dropped]);
    const table: [string, [string[], string, string[] | undefined][]][] = [
      [
        "swap the cleats for Nike Mercurials",
        [[["cleats"], "nike cleats", ["mercurials"]]],
      ],
      [
        "change my cleats to nike phantom",
        [[["cleats"], "nike cleats", ["phantom"]]],
      ],
      // Adi's pinned case: descriptors verbatim, the brand routes, unknown words drop.
      [
        "change my jersey to a weird glitchy adidas kit",
        [[["jersey"], "adidas jersey", ["weird", "glitchy"]]],
      ],
      // A descriptor survives beside a dropped word: "blue" is kept, "sky" is not a descriptor.
      [
        "change my jersey to a sky blue adidas kit",
        [[["jersey"], "blue adidas jersey", ["sky"]]],
      ],
      // The brand it is now stays in the target; the dropped model never reaches the value.
      [
        "change my nike jersey to adidas mercurial",
        [[["nike jersey"], "adidas jersey", ["mercurial"]]],
      ],
      // PER ITEM: each step carries its own dropped words, for the disclosure to list.
      [
        "change my socks and shoes to nike elite ones",
        [
          [["socks"], "nike socks", ["elite"]],
          [["shoes"], "nike shoes", ["elite"]],
        ],
      ],
      // ⚠️ THE FLAGGED CLASS, pinned so a change of mind is a visible edit: a product noun is dropped
      // like a model name — an adidas JERSEY, "hoodie" disclosed. A model and a noun look the same to a
      // rule with no noun vocabulary. Adi's call.
      [
        "change my jersey to an adidas hoodie",
        [[["jersey"], "adidas jersey", ["hoodie"]]],
      ],
    ];
    for (const [text, items] of table) {
      expect({ text, steps: withDropped(text) }).toEqual({
        text,
        steps: items,
      });
    }
    // And nothing is dropped from a value that reads whole: no `dropped` field at all.
    expect(
      route("make my jersey a blue adidas kit", true).steps[0],
    ).not.toHaveProperty("dropped");
  });

  it("degrades ONLY with a brand in the value — no brand, and unreadable words still ask", () => {
    // Not a general unknown-token pass-through: the degrade is for a brand she named.
    expect(
      route("change my jersey to a weird glitchy kit", true).initialPath,
    ).toBe("ASK");
    // A brand in the ITEM is the brand it is now, not the one it becomes — still no brand in the value.
    expect(route("change my nike jersey to a weird kit", true)).toMatchObject(
      declined,
    );
  });

  it("still asks where dropping would change what she asked — a negation, a second brand, a fourth word, a second clause", () => {
    for (const text of [
      // Dropping "without" would give her the stripes she refused.
      "change my jersey to adidas without stripes",
      // Which brand? Not guessed between.
      "change my jersey to a nike adidas kit",
      // Four dropped words: past the bound, most of what she said would be gone.
      "change my jersey to a mercurial superfly elite pro adidas kit",
    ]) {
      expect({ text, parsed: parseBrandChange(text) }).toEqual({
        text,
        parsed: null,
      });
      expect(route(text, true)).toMatchObject(declined);
    }
    // A second instruction is not a model name; "and" is not droppable, so 4c still reads none of it.
    // Composition does — each clause through its own rule, pinned in the composition block.
    const twoChanges = "change my jersey to adidas and make the socks white";
    expect(parseBrandChange(twoChanges)).toBeNull();
    expect(
      route(twoChanges, true).steps.find((s) => s.op === "REPLACE_OBJECT"),
    ).not.toHaveProperty("dropped");
  });

  it("bounds the descriptors — three words route, a fourth asks rather than being cut", () => {
    expect(steps("change my jersey to a black and white adidas kit")).toEqual([
      ["REPLACE_OBJECT", ["jersey"], "black and white adidas jersey", "REGION"],
    ]);
    const four = "change my jersey to a bright black and white adidas kit";
    expect(parseBrandChange(four)).toBeNull();
    expect(route(four, true)).toMatchObject(declined);
  });

  it("reads descriptors in the VALUE only — a colour inside an item still asks", () => {
    // "my red socks" — which socks, or the colour to keep? Not a descriptor of the new kit.
    expect(parseBrandChange("change my red socks to nike")).toBeNull();
    expect(route("change my red socks to nike", true)).toMatchObject(declined);
  });

  it("the person guard reads every item — one of her among them and the WHOLE sentence asks", () => {
    const text = "change my jersey and my arms to adidas";
    // The parse reads both; `validate` refuses the step on her arms, and with it the sentence.
    expect(parseBrandChange(text)?.map((s) => s.targets[0])).toEqual([
      "jersey",
      "arms",
    ]);
    expect(route(text, true)).toMatchObject({
      initialPath: "ASK",
      steps: [],
      reason: "person_target",
    });
  });

  it("moves nothing but brand sentences — 4a's logo, a brandless design and a recolour are as they were", () => {
    expect(steps("add an adidas logo to the jersey")).toEqual([
      ["APPLY_DESIGN", ["jersey"], "adidas logo", "REGION"],
    ]);
    // No brand, so 4c has nothing to read: still 4b's decline, still the catch-all.
    expect(route("change my jersey to a striped pattern", true)).toMatchObject({
      initialPath: "ASK",
      reason: "fast_path_declined",
    });
    expect(steps("change my jersey to blue")).toEqual([
      ["RECOLOR", ["jersey"], "blue", "REGION"],
    ]);
  });
});

describe("C.4 — which 'no': the fall-through says which decline it is, and still only ASKs", () => {
  const reasonFor = (text: string) => {
    const out = route(text, true);
    return { path: out.initialPath, reason: out.reason };
  };

  it("an edit to her body the fast path could not read is person_mentioned — not the guard, and not the catch-all", () => {
    // The G1 sentence. The sweep recorded "person guard fires"; it never did — the fast path
    // declines before `validate` runs. Measured on main: fast_path_declined.
    expect(reasonFor("make my arms bigger")).toEqual({
      path: "ASK",
      reason: "person_mentioned",
    });
    expect(reasonFor("change the person to a man").reason).toBe(
      "person_mentioned",
    );
  });

  it("a brand change the fast path still cannot read is brand_change", () => {
    // "change my jersey to adidas" was this test's first sentence, "make my jersey a blue adidas kit"
    // its second, and the Mercurials its third. All route now (rule 4c, B.1b, B.1c — pinned in 4c's
    // block); brand_change is the code for the brand sentences 4c declines.
    expect(reasonFor("change my jersey to adidas without stripes")).toEqual({
      path: "ASK",
      reason: "brand_change",
    });
    expect(reasonFor("change my red socks to nike").reason).toBe(
      "brand_change",
    );
  });

  it("a removal naming a brand is brand_removal — the live sentence, and why it declined at all", () => {
    // Live, 2026-09-10 ~12:07: this ASKed as brand_change, and brand_change's copy teaches SWITCHING.
    expect(reasonFor("remove the 8 and nike logo")).toEqual({
      path: "ASK",
      reason: "brand_removal",
    });
    // The wrinkle: the brand did not cause the decline. Digits are not tokens, so "the" introduced
    // nothing before "and", and "nike logo" has no determiner — rule 1 found no target at all.
    expect(extractTargets("remove the 8 and nike logo")).toEqual([]);
    // A CODE, NOT A POLICY: a brand mark rule 1 can read is still removed exactly as on main.
    expect(route("remove the nike logo", true).steps).toEqual([
      {
        op: "REMOVE_OBJECT",
        targets: ["nike logo"],
        value: null,
        scope: "REGION",
      },
    ]);
  });

  it("WHY the removal copy asks for 'its own the' — rule 1 reads only a thing with a determiner", () => {
    // A PRE-EXISTING rule-1 partial (identical on main), pinned as a characterisation, not approved:
    // spelling the number out is not enough on its own. "the eight" is read, "nike logo" has no "the"
    // of its own, and the removal ROUTES — the eight alone, the logo dropped without a word. So
    // brand_removal's copy asks for both fixes and its example has both. Shared-determiner lists are
    // deferred to the composition work; when this starts removing the logo too, revisit that copy.
    expect(route("remove the eight and nike logo", true).steps).toEqual([
      { op: "REMOVE_OBJECT", targets: ["eight"], value: null, scope: "REGION" },
    ]);
    expect(
      route("remove the number eight and the nike logo", true).steps[0].targets,
    ).toEqual(["number eight", "nike logo"]);
  });

  it("moves brand only — a removal that names no brand keeps the catch-all", () => {
    expect(reasonFor("remove it").reason).toBe("fast_path_declined");
    expect(reasonFor("remove the 8").reason).toBe("fast_path_declined");
  });

  it("an add it could not place is add_unclear — including the one with her own 'keep everything else'", () => {
    expect(reasonFor("add a soccer ball")).toEqual({
      path: "ASK",
      reason: "add_unclear",
    });
    expect(
      reasonFor(
        "add a soccer ball between my cleats, keep everything else the same",
      ).reason,
    ).toBe("add_unclear");
  });

  it("keeps the catch-all for a sentence it genuinely could not read", () => {
    expect(reasonFor("do something cool with this").reason).toBe(
      "fast_path_declined",
    );
    expect(reasonFor("make it pop").reason).toBe("fast_path_declined");
    // One garment among the regions and it is not a body edit — the generic question, not a refusal.
    expect(reasonFor("make my arm and my jersey bigger").reason).toBe(
      "fast_path_declined",
    );
    // An add carrying a design or brand token is rule 4's business, not an unplaced add.
    expect(reasonFor("add a nike ball between my cleats").reason).toBe(
      "fast_path_declined",
    );
  });

  it("leaves the guard's own code alone — a routed step on her body is still person_target", () => {
    expect(reasonFor("make my bicep red").reason).toBe("person_target");
    // A crown, not the hat pinned here until PR M3 — a hat on her head is a worn add now (rule 3¾b).
    expect(reasonFor("add a crown on her head").reason).toBe("person_target");
  });
});

// ─── RULE ½ — composition: the clause split, and each clause through its own rule ───────────────

describe("rule ½ — a sentence of different changes is composed, one clause per rule; one change said twice still routes whole (composition)", () => {
  /** Each step as [op, targets, value]. */
  const steps = (text: string) =>
    route(text, true).steps.map((s) => [s.op, s.targets, s.value]);
  /** An ask with nothing frozen, for the code named. */
  const asks = (reason: string) => ({
    initialPath: "ASK",
    steps: [],
    reason,
  });

  it("cuts where a joiner run meets a verb — her words and case, the joiners on neither side", () => {
    expect(
      splitClauses("Remove the soccer ball, and make her jersey blue."),
    ).toEqual(["Remove the soccer ball", "make her jersey blue."]);
    expect(
      splitClauses(
        "make her jersey blue, add a soccer ball at her feet, and change the background to a stadium",
      ),
    ).toEqual([
      "make her jersey blue",
      "add a soccer ball at her feet",
      "change the background to a stadium",
    ]);
    // Across a full stop, with "also" and "please" in the run.
    expect(
      splitClauses(
        "add a soccer ball at her feet. Also please make her jersey blue.",
      ),
    ).toEqual(["add a soccer ball at her feet", "make her jersey blue."]);
    // A removal verb of more than one word leads a clause too.
    expect(
      splitClauses("make the socks blue, then get rid of the cone"),
    ).toEqual(["make the socks blue", "get rid of the cone"]);
  });

  it("never cuts a list — no verb follows the joiner, so 4c's items and rule 5's targets are one clause", () => {
    for (const text of [
      "change my uniform, socks, and shoes all to be adidas",
      "make her jersey blue and her socks red",
      "change my socks and shoes to black and white nike ones",
      // What comes before her first verb stays with it.
      "I love this photo, make the socks blue",
    ]) {
      expect(splitClauses(text)).toEqual([text]);
    }
  });

  it("reads 'place it' / 'put it' after an add as where the thing goes — C′'s sentences are one clause", () => {
    for (const text of [
      "add the soccer ball from the second image, place it between her cleats",
      "add a soccer ball to the image, place it in the middle of my cleats",
      "add the soccer ball from the second image into the first one. place it in the middle of the cleats.",
    ]) {
      expect(splitClauses(text)).toEqual([text]);
      expect(route(text, true).steps.map((s) => s.op)).toEqual(["ADD_OBJECT"]);
    }
  });

  it("reads 'put it' after anything but an add as a second change", () => {
    // Read as one clause, rule 1 takes the bench as a second thing to remove (main did). As its own
    // clause, "put it on the bench" is an add of a thing she never named, and asks as that — the
    // clause's own code (d1), whose copy asks her to say what it is.
    const moved = "remove the ball and put it on the bench";
    expect(splitClauses(moved)).toEqual([
      "remove the ball",
      "put it on the bench",
    ]);
    expect(route(moved, true)).toMatchObject(asks("add_unclear"));
  });

  it("composes different changes — each clause read by its own rule, so no rule claims another clause's nouns", () => {
    // What main did (c06e768): rule 1 took the jersey as a second removal; rule 2 dropped the
    // recolour; rule 5 took the ball and the bench as recolours. PR 1 asked. Now each clause is read
    // alone, and the steps come back in run order (`orderSteps`: full-image, background, masked).
    const table: [string, [string, string[], string | null][]][] = [
      [
        "make her jersey blue and remove the ball",
        [
          ["RECOLOR", ["jersey"], "blue"],
          ["REMOVE_OBJECT", ["ball"], null],
        ],
      ],
      [
        "make her jersey blue and change the background to a stadium",
        [
          ["RECOLOR", ["jersey"], "blue"],
          ["CHANGE_BACKGROUND", ["person"], "stadium"],
        ],
      ],
      [
        "make the socks blue and add a ball on the bench",
        [
          ["RECOLOR", ["socks"], "blue"],
          ["ADD_OBJECT", ["ball", "bench"], "on the bench"],
        ],
      ],
    ];
    for (const [text, expected] of table) {
      expect({ text, steps: steps(text) }).toEqual({ text, steps: expected });
      expect(compoundClauses(text)).toHaveLength(2);
    }
    // THE REGRESSION PIN (the composition plan): the repro, B-c4 and B-p5 remove exactly what she
    // named for removal, and the jersey is recoloured — never removed.
    for (const [text, removedOnly] of [
      ["make her jersey blue and remove the ball", "ball"],
      ["make her jersey blue and remove the cleats", "cleats"],
      ["Remove the soccer ball, and make her jersey blue.", "soccer ball"],
    ]) {
      const out = route(text, true).steps;
      expect({
        text,
        removed: out
          .filter((s) => s.op === "REMOVE_OBJECT")
          .flatMap((s) => s.targets),
        recoloured: out
          .filter((s) => s.op === "RECOLOR")
          .flatMap((s) => s.targets),
      }).toEqual({ text, removed: [removedOnly], recoloured: ["jersey"] });
    }
  });

  it("composes 4c's clause with another — 4c still reads none of the sentence, each clause reads its own", () => {
    // 4c's "reads the whole sentence or none of it" pinned these two as ASK until composition; its
    // parse-level assertion stays there (parseBrandChange is still null on both). Moved here, openly.
    expect(
      steps("change my jersey to adidas and make the socks white"),
    ).toEqual([
      ["RECOLOR", ["socks"], "white"],
      ["REPLACE_OBJECT", ["jersey"], "adidas jersey"],
    ]);
    expect(
      steps("change my jersey to adidas blue and make the socks white"),
    ).toEqual([
      ["RECOLOR", ["socks"], "white"],
      ["REPLACE_OBJECT", ["jersey"], "adidas blue jersey"],
    ]);
    // The shared verb (plan §4.5): "make" leads 4c's clause and rule 5's, and the split never cuts a
    // list, so each clause reaches the rule that reads it.
    expect(steps("make my socks nike and make the jersey blue")).toEqual([
      ["RECOLOR", ["jersey"], "blue"],
      ["REPLACE_OBJECT", ["socks"], "nike socks"],
    ]);
  });

  it("carries B.1c's dropped words on a composed brand step — the disclosure still has something to read", () => {
    // droppedWordsNote and asksToDropWords both read steps (studio/nativeEdit.ts, nativeIntent.ts), so
    // a brand clause that drops a model name inside a compound is disclosed exactly as it is alone.
    expect(
      route("swap the cleats for Nike Mercurials and remove the ball", true)
        .steps,
    ).toEqual([
      {
        op: "REPLACE_OBJECT",
        targets: ["cleats"],
        value: "nike cleats",
        scope: "REGION",
        dropped: ["mercurials"],
      },
      { op: "REMOVE_OBJECT", targets: ["ball"], value: null, scope: "REGION" },
    ]);
  });

  it("the person guard reads every composed step — a body edit in any clause refuses the whole sentence", () => {
    // `validate` is unchanged: a clause that READS as a step on her body is the guard's own refusal.
    // (The second clause was "add a hat on her head" until PR M3; a hat is worn, and a crown is not.)
    for (const text of [
      "add a soccer ball at her feet and make my arms red",
      "add a crown on her head and make the socks blue",
      "make the socks blue and remove my arm",
    ]) {
      expect({ text, out: route(text, true) }).toMatchObject({
        text,
        out: asks("person_target"),
      });
    }
    // And the place of a spatial add is still not a target: "at her feet" puts the ball NEAR her.
    expect(
      route("add a soccer ball at her feet and make the socks blue", true)
        .initialPath,
    ).toBe("FULL_IMAGE");
  });

  it("an unreadable clause keeps its OWN decline code (d1) — the body edit gets the person refusal back", () => {
    // PR 1 answered all of these "one change per sentence". Each clause below asks as it does alone,
    // so the copy is true of the part that stopped it.
    const table: [string, string, string][] = [
      // The one d1 was for: a clause about her body, which no rephrasing fixes.
      [
        "add a soccer ball at her feet and make my arms bigger",
        "make my arms bigger",
        "person_mentioned",
      ],
      // An add with no place.
      [
        "add a soccer ball and make the socks blue",
        "add a soccer ball",
        "add_unclear",
      ],
      // A removal naming a brand that rule 1 found nothing in (F10's sentence).
      [
        "make the socks blue and remove the 8 and nike logo",
        "remove the 8 and nike logo",
        "brand_removal",
      ],
      // A brand change 4c could not read — a colour inside the item.
      [
        "change my red socks to nike and remove the ball",
        "change my red socks to nike",
        "brand_change",
      ],
    ];
    for (const [text, clause, reason] of table) {
      expect(route(clause, true).reason).toBe(reason);
      expect({ text, out: route(text, true) }).toMatchObject({
        text,
        out: asks(reason),
      });
    }
  });

  it("only the catch-all becomes compound_partial — a part it could not read, of a sentence it otherwise could", () => {
    // Main recoloured the socks and dropped "make it pop" without a word.
    expect(classifyFast("make it pop", true)).toBeNull();
    expect(route("make it pop", true).reason).toBe("fast_path_declined");
    for (const text of [
      "make the socks blue and make it pop",
      "add a ball on the bench and make it pop",
      // PR 1's known over-ask, kept: "change nothing" leads a clause no rule reads.
      "make the socks blue and change nothing else",
    ]) {
      expect({ text, out: route(text, true) }).toMatchObject({
        text,
        out: asks("compound_partial"),
      });
    }
  });

  it("asks too_many_changes UP FRONT past four steps across the clauses — never cut by validate", () => {
    // 4c's clause is four steps, the removal a fifth. `validate` would slice the fifth off silently.
    expect(
      route(
        "change my jersey, shorts, socks and shoes to adidas and remove the ball",
        true,
      ),
    ).toMatchObject(asks("too_many_changes"));
    // Four is the cap, and four routes: three items and a removal (the acceptance's free sentence).
    expect(
      steps(
        "change my uniform, socks, and shoes all to be adidas and remove the ball",
      ),
    ).toEqual([
      ["REPLACE_OBJECT", ["uniform"], "adidas uniform"],
      ["REPLACE_OBJECT", ["socks"], "adidas socks"],
      ["REPLACE_OBJECT", ["shoes"], "adidas shoes"],
      ["REMOVE_OBJECT", ["ball"], null],
    ]);
    // A fifth ITEM is 4c's own decline, so the clause's own code answers (d1) — its copy says four.
    expect(
      route(
        "change my jersey, shorts, socks, shoes and gloves to adidas and remove the ball",
        true,
      ),
    ).toMatchObject(asks("brand_change"));
  });

  it("asks compound_conflict for two backgrounds or two looks — which one she meant is not guessed (d2)", () => {
    for (const text of [
      // Rule 3 keeps the first look; main dropped "warmer".
      "make it black and white and make it warmer",
      "change the background to a beach and change the background to a stadium",
    ]) {
      expect({ text, out: route(text, true) }).toMatchObject({
        text,
        out: asks("compound_conflict"),
      });
    }
    // One of each is not a conflict.
    expect(
      steps("change the background to a beach and make it black and white"),
    ).toEqual([
      ["GLOBAL_STYLE", [], "black and white"],
      ["CHANGE_BACKGROUND", ["person"], "beach"],
    ]);
  });

  it("asks compound_conflict for a removal of something another clause also changes — she would pay for a change deleted in the same call (d2, extended)", () => {
    // 991aaef asked all of these as compound_pending; before this rule the first composed to
    // [RECOLOR jersey, REMOVE jersey] and compiled "…remove the jersey…" beside its own recolour.
    for (const text of [
      "make her jersey blue and remove the jersey",
      // Either order, and a plural's "s" on the noun is the same thing.
      "remove the cleat and make the cleats red",
      // The shorter names the longer's tail: "the ball" is the soccer ball.
      "remove the soccer ball and make the ball red",
      // An add's thing, or the surface it lands on, is changed too.
      "remove the ball and add a ball on the bench",
      "remove the bench and put a water bottle on the bench",
    ]) {
      expect({ text, out: route(text, true) }).toMatchObject({
        text,
        out: asks("compound_conflict"),
      });
    }
    // BOUNDED: a removal of a DIFFERENT thing still composes — two balls are two things.
    expect(
      steps("remove the tennis ball and make the soccer ball red"),
    ).toEqual([
      ["RECOLOR", ["soccer ball"], "red"],
      ["REMOVE_OBJECT", ["tennis ball"], null],
    ]);
    // A background's only target is the person it KEEPS — never a thing it changes.
    expect(
      route("remove the cleats and change the background to a stadium", true)
        .initialPath,
    ).not.toBe("ASK");
    // Her body is the guard's answer, not a conflict: the person refusal is the truer one.
    expect(route("make my arm red and remove my arm", true)).toMatchObject(
      asks("person_target"),
    );
  });

  it("routes one recolour said twice exactly as the one-verb sentence does", () => {
    // Rule 5 claims every region, and the freeze pairs each with its own colour.
    expect(steps("make her jersey blue and make her socks red")).toEqual(
      steps("make her jersey blue and her socks red"),
    );
    expect(steps("make her jersey blue and make her socks red")).toEqual([
      ["RECOLOR", ["jersey", "socks"], "blue"],
    ]);
    expect(
      steps("change the socks to red and change the shoes to white"),
    ).toEqual([["RECOLOR", ["socks", "shoes"], "red"]]);
    expect(steps("make the jersey blue and change the socks to red")).toEqual([
      ["RECOLOR", ["jersey", "socks"], "blue"],
    ]);
  });

  it("routes one removal said twice — rule 1 claims every noun, which is right when every clause removes", () => {
    expect(steps("remove the ball and remove the cone")).toEqual([
      ["REMOVE_OBJECT", ["ball", "cone"], null],
    ]);
    expect(steps("remove the ball and delete the cone")).toEqual([
      ["REMOVE_OBJECT", ["ball", "cone"], null],
    ]);
  });

  it("keeps a removal that points back — read by verb, because its second clause alone has no target", () => {
    const text = "remove the ball and then delete it";
    expect(splitClauses(text)).toEqual(["remove the ball", "delete it"]);
    expect(classifyFast("delete it", true)).toBeNull();
    expect(steps(text)).toEqual([["REMOVE_OBJECT", ["ball"], null]]);
  });

  it("composes two adds — each names its own thing, so it is no conflict (4a)", () => {
    // 4½ reads one thing per clause; main's rule 5 recoloured the ball, the bench and the grass red,
    // and PR 1 asked. Two adds with an object photo attached refuse at the freeze (nativeIntent.ts).
    expect(
      steps("add a ball on the bench and add a red bottle on the grass"),
    ).toEqual([
      ["ADD_OBJECT", ["ball", "bench"], "on the bench"],
      ["ADD_OBJECT", ["red bottle", "grass"], "on the grass"],
    ]);
  });

  it("leaves GENERATE alone — rule 0 runs first, and a new image never composes", () => {
    const text = "make a new poster of me and add a stadium background";
    expect(splitClauses(text)).toHaveLength(2);
    expect(route(text, true).steps.map((s) => s.op)).toEqual(["GENERATE"]);
    expect(route(text, false).steps.map((s) => s.op)).toEqual(["GENERATE"]);
  });
});

// ─── THE INVARIANT — every sentence that asked on main still asks ───────────────────────────────

/**
 * Every one of these ASKED on main (246a98c, PR N) — verified by running main's own `route()` over
 * this exact list in a worktree, not inferred. Reason codes may differ on this branch; routing may
 * not, except where rule 4½ claims a sentence ON PURPOSE (CLAIMED_BY_ADD, below) — or rule 4c does,
 * by the 2026-09-10 brand decision (CLAIMED_BY_BRAND).
 *
 * The brand section at the end was verified the same way against dc7bfb4 (#387, main after C′):
 * all of it ASKed there, every one as brand_change.
 */
const ASKED_ON_MAIN = [
  // The G checks, and the sentence that ASKed live on 2026-09-09.
  "add a soccer ball to the image, place it in the middle of my cleats",
  "make my arms bigger",
  "change my jersey to adidas",
  // §7.1's four dead phrasings (the first is the G3 sentence above).
  "add a soccer ball at her feet",
  "put a water bottle on the grass next to me",
  "add the soccer ball from the second image into the first one. place it in the middle of the cleats.",
  // Q1's prompts.
  "add the soccer ball from the second image, place it between her cleats",
  "place this ball at her feet",
  "put the soccer ball from the second image on the grass beside her right foot",
  "place the water bottle from the second image on top of her head",
  // Adds of a thing onto something that is not her.
  "put a water bottle on the grass",
  // The golden set's fall-through, and the person denials.
  "make her look taller",
  "change the person to a man",
  "make it pop",
  "swap the cleats for Nike Mercurials",
  "make my jersey a blue adidas kit",
  "put a number 10 on the back",
  "add a logo to the chest",
  "add a stripe to the logo",
  "remove it",
  "make my bicep red",
  "do something cool with this",
  // Adds that must stay ASK: the person guard's side of D1, D2, D3, and the parse declining.
  "add a sponsor patch at the top of the sleeve",
  "add a soccer ball",
  "add a hat on her head",
  "add a tattoo on my arm",
  "add a girl next to me",
  "put a hat on me",
  "add a girl on the bench",
  "add a crown on my head",
  "add muscles to my arms",
  "add a ball near my feet",
  "add a ball on the bench and make it pop",
  "add a large insulated gatorade water bottle on the bench",
  "add something between my cleats",
  "put it between my cleats",
  "add a soccer ball between my cleats, keep everything else the same",
  "add a nike ball between my cleats",
  // ─── 2026-09-10, the brand decision (rule 4c) ─────────────────────────────────────────────────
  // The live declines, verbatim: the before-screenshot's sentence, and the ~12:07 removal. The
  // screenshot read "unfiorm"; the typo was ours, not product input, so the corrected spelling is the
  // one pinned here and everywhere (Adi). "change my jersey to adidas" (G2) is the third, above.
  "change my uniform, socks, and shoes all to be adidas",
  "remove the 8 and nike logo",
  // What 4c claims besides: each construction once, and the brand_change copy's own example.
  "change my jersey, socks and shoes to adidas",
  "change my jersey, shorts, socks and shoes to adidas",
  "change my nike jersey to adidas",
  "turn my kit into an adidas one",
  "switch my cleats to puma",
  "make my socks nike",
  "swap my cleats for adidas ones",
  "change my jersey to an adidas jersey",
  "please change the socks and the shoes to new balance.",
  "change both my socks and shoes to nike",
  // Found by B.4's diff — main's route() against this branch's over every quoted string in the
  // Studio test files: the two other sentences 4c claims. autoMask's docblock example (the sentence
  // that once failed on seven boxes), and the generate gate's banner, which is still no generate.
  "Change my uniform, socks and shoes to adidas",
  "change the banner to adidas",
  // Descriptors (2026-09-10, the second decision): a brand change carrying plain descriptors routes,
  // the value verbatim. The first two were pinned here as must-not-claim until then.
  "change my jersey to an adidas kit",
  "make my jersey adidas blue",
  "change my jersey to an all-black nike kit",
  "change my jersey to an adidas all-white kit",
  "change my jersey to a vintage adidas kit",
  "change my nike jersey to a light blue adidas jersey",
  "change my socks and shoes to black and white nike ones",
  "change my jersey to a black and white adidas kit",
  // The degrade (2026-09-10, B.1c — Adi's call, a reversal): a word it cannot read beside a brand is
  // DROPPED with disclosure, not refused. The golden set's Mercurials (above) and the first three
  // here were pinned as must-not-claim until then; the hoodie is the flagged class.
  "change my cleats to nike phantom",
  "change my jersey to a sky blue adidas kit",
  "change my jersey to an adidas hoodie",
  "change my jersey to a weird glitchy adidas kit",
  "change my socks and shoes to nike elite ones",
  "change my nike jersey to adidas mercurial",
  // What 4c must NOT claim: a fifth item, a colour INSIDE an item, an over-long item, anything left
  // over, a negation, a second brand, a fourth dropped word or descriptor, unreadable words with no
  // brand in the value, a pronoun where the item should be, and her arms among the items.
  "change my jersey to adidas and make the socks white",
  "change my jersey to adidas blue and make the socks white",
  "change my jersey, shorts, socks, shoes and gloves to adidas",
  "change my jersey, socks and my lucky red shoes to adidas",
  "change my red socks to nike",
  "change my jersey and my old worn training shoes to adidas",
  "change my jersey to a bright black and white adidas kit",
  "change my jersey to adidas without stripes",
  "change my jersey to a nike adidas kit",
  "change my jersey to a mercurial superfly elite pro adidas kit",
  "change my jersey to a weird glitchy kit",
  "change my nike jersey to a weird kit",
  "change my jersey and my arms to adidas",
  "change my jersey's logo to adidas",
  "can you change my jersey to adidas",
  "change my nike to adidas",
];

/** The ones rule 4½ claims on purpose. Each is ADD_OBJECT now; every other entry must still ASK. */
const CLAIMED_BY_ADD = new Set([
  "put a water bottle on the grass",
  // C.2 — the G3 sentence, the rest of §7.1, and Q1's prompts.
  "add a soccer ball to the image, place it in the middle of my cleats",
  "add a soccer ball at her feet",
  "put a water bottle on the grass next to me",
  "add the soccer ball from the second image into the first one. place it in the middle of the cleats.",
  "add the soccer ball from the second image, place it between her cleats",
  "place this ball at her feet",
  "put the soccer ball from the second image on the grass beside her right foot",
  "place the water bottle from the second image on top of her head",
]);

/**
 * The ones rule 3¾b claims on purpose (PR M3, Mia's M3), with the steps each routes as: D1's two hat
 * sentences. A hat is worn since N6, so each is one add of the hat, her head (or her, by pronoun) consumed
 * as where it is worn. Every other entry must still ASK.
 */
const CLAIMED_BY_WORN_ADD = new Map<
  string,
  [EditOperation, string[], string | null][]
>([
  ["add a hat on her head", [["ADD_OBJECT", ["hat"], "on her head"]]],
  ["put a hat on me", [["ADD_OBJECT", ["hat"], "on me"]]],
]);

/**
 * The ones G1 claims on purpose (wave A, 2026-09-17, Adi's bound): a part of her named as where a thing goes, after
 * a closed non-contact preposition. Every other entry must still ASK — D1's crown and tattoo among them.
 */
const CLAIMED_BY_PLACEMENT = new Map<
  string,
  [EditOperation, string[], string | null][]
>([["add a ball near my feet", [["ADD_OBJECT", ["ball"], "near my feet"]]]]);

/**
 * The ones rule 4c claims on purpose (2026-09-10, the brand decision), with how many items each
 * names. Each is REPLACE_OBJECT in every step, ONE STEP PER ITEM — so the count is the no-partial
 * rule asserted over every claimed sentence, not just the ones its own block picked. Every other
 * entry must still ASK.
 */
const CLAIMED_BY_BRAND = new Map<string, number>([
  ["change my jersey to adidas", 1],
  ["change my uniform, socks, and shoes all to be adidas", 3],
  ["change my jersey, socks and shoes to adidas", 3],
  ["change my jersey, shorts, socks and shoes to adidas", 4],
  ["change my nike jersey to adidas", 1],
  ["turn my kit into an adidas one", 1],
  ["switch my cleats to puma", 1],
  ["make my socks nike", 1],
  ["swap my cleats for adidas ones", 1],
  ["change my jersey to an adidas jersey", 1],
  ["please change the socks and the shoes to new balance.", 2],
  ["change both my socks and shoes to nike", 2],
  ["Change my uniform, socks and shoes to adidas", 3],
  ["change the banner to adidas", 1],
  // Descriptors (2026-09-10): the golden set's blue adidas kit, and the section above.
  ["make my jersey a blue adidas kit", 1],
  ["change my jersey to an adidas kit", 1],
  ["make my jersey adidas blue", 1],
  ["change my jersey to an all-black nike kit", 1],
  ["change my jersey to an adidas all-white kit", 1],
  ["change my jersey to a vintage adidas kit", 1],
  ["change my nike jersey to a light blue adidas jersey", 1],
  ["change my socks and shoes to black and white nike ones", 2],
  ["change my jersey to a black and white adidas kit", 1],
  // The degrade (B.1c): the golden set's Mercurials, and the section above.
  ["swap the cleats for Nike Mercurials", 1],
  ["change my cleats to nike phantom", 1],
  ["change my jersey to a sky blue adidas kit", 1],
  ["change my jersey to an adidas hoodie", 1],
  ["change my jersey to a weird glitchy adidas kit", 1],
  ["change my socks and shoes to nike elite ones", 2],
  ["change my nike jersey to adidas mercurial", 1],
]);

/**
 * The ones composition claims on purpose (rule ½, composition PR 2): every sentence that ASKED on
 * 991aaef — main with PR 1, where every compound of different changes asked — and routes now, with
 * the steps it routes as, [op, targets, value] per step, in run order.
 *
 * EXACTLY B.4's diff, compared mechanically: 991aaef's route() against this branch's over every
 * quoted string in the Studio test files, each with and without a source photo. Nothing else changed
 * routing — no route changed its steps, and nothing changed without a photo — so this is the whole
 * of what composition moved from ASK to a route. Each is a compound (`compoundClauses` reads two or
 * more clauses), and none is a same-change sentence: those still route whole, as before (2a).
 */
const CLAIMED_BY_COMPOSITION = new Map<
  string,
  [EditOperation, string[], string | null][]
>([
  // Sweep #3's twelve misroutes (addendum), each composed as she asked it.
  [
    "make her jersey blue and change the background to a stadium",
    [
      ["RECOLOR", ["jersey"], "blue"],
      ["CHANGE_BACKGROUND", ["person"], "stadium"],
    ],
  ],
  [
    "make her jersey blue and remove the water bottle",
    [
      ["RECOLOR", ["jersey"], "blue"],
      ["REMOVE_OBJECT", ["water bottle"], null],
    ],
  ],
  [
    "make her jersey blue and remove the cleats",
    [
      ["RECOLOR", ["jersey"], "blue"],
      ["REMOVE_OBJECT", ["cleats"], null],
    ],
  ],
  [
    "remove the cleats and change the background to a stadium",
    [
      ["CHANGE_BACKGROUND", ["person"], "stadium"],
      ["REMOVE_OBJECT", ["cleats"], null],
    ],
  ],
  [
    "make her jersey blue and add a lightning bolt design to her socks",
    [
      ["RECOLOR", ["jersey"], "blue"],
      ["APPLY_DESIGN", ["socks"], "lightning bolt design"],
    ],
  ],
  [
    "make her jersey blue, add a soccer ball at her feet, and change the background to a stadium",
    [
      ["RECOLOR", ["jersey"], "blue"],
      ["ADD_OBJECT", ["soccer ball"], "at her feet"],
      ["CHANGE_BACKGROUND", ["person"], "stadium"],
    ],
  ],
  [
    "remove the soccer ball, make her jersey blue, and change the background to a stadium",
    [
      ["RECOLOR", ["jersey"], "blue"],
      ["CHANGE_BACKGROUND", ["person"], "stadium"],
      ["REMOVE_OBJECT", ["soccer ball"], null],
    ],
  ],
  [
    "add a soccer ball at her feet, then change the background to a stadium",
    [
      ["ADD_OBJECT", ["soccer ball"], "at her feet"],
      ["CHANGE_BACKGROUND", ["person"], "stadium"],
    ],
  ],
  [
    "Add a soccer ball at the person's feet, and change the background to a packed stadium at night.",
    [
      ["ADD_OBJECT", ["soccer ball"], "at the person s feet"],
      ["CHANGE_BACKGROUND", ["person"], "packed stadium at night"],
    ],
  ],
  [
    "Remove the soccer ball, and change the background to a packed stadium at night.",
    [
      ["CHANGE_BACKGROUND", ["person"], "packed stadium at night"],
      ["REMOVE_OBJECT", ["soccer ball"], null],
    ],
  ],
  [
    "Remove the soccer ball, and make her jersey blue.",
    [
      ["RECOLOR", ["jersey"], "blue"],
      ["REMOVE_OBJECT", ["soccer ball"], null],
    ],
  ],
  [
    "make her jersey blue and remove the ball",
    [
      ["RECOLOR", ["jersey"], "blue"],
      ["REMOVE_OBJECT", ["ball"], null],
    ],
  ],
  // Sweep #3's F2 sentences — told "we don't edit people" on main, "one change per sentence" on PR 1.
  [
    "add a soccer ball at her feet and make her jersey blue",
    [
      ["ADD_OBJECT", ["soccer ball"], "at her feet"],
      ["RECOLOR", ["jersey"], "blue"],
    ],
  ],
  [
    "add a soccer ball at her feet and remove the nike logo",
    [
      ["ADD_OBJECT", ["soccer ball"], "at her feet"],
      ["REMOVE_OBJECT", ["nike logo"], null],
    ],
  ],
  [
    "add a soccer ball at her feet and add a water bottle next to her",
    [
      ["ADD_OBJECT", ["soccer ball"], "at her feet"],
      ["ADD_OBJECT", ["water bottle"], "next to her"],
    ],
  ],
  [
    "add a soccer ball at her feet. Also make her jersey blue.",
    [
      ["ADD_OBJECT", ["soccer ball"], "at her feet"],
      ["RECOLOR", ["jersey"], "blue"],
    ],
  ],
  [
    "add a soccer ball at her feet. Also please make her jersey blue.",
    [
      ["ADD_OBJECT", ["soccer ball"], "at her feet"],
      ["RECOLOR", ["jersey"], "blue"],
    ],
  ],
  // The rest of PR 1's asks: another clause's nouns claimed, or two adds read as recolours.
  [
    "make the socks blue and add a ball on the bench",
    [
      ["RECOLOR", ["socks"], "blue"],
      ["ADD_OBJECT", ["ball", "bench"], "on the bench"],
    ],
  ],
  [
    "make the socks blue, then get rid of the cone",
    [
      ["RECOLOR", ["socks"], "blue"],
      ["REMOVE_OBJECT", ["cone"], null],
    ],
  ],
  [
    "add a ball on the bench and add a red bottle on the grass",
    [
      ["ADD_OBJECT", ["ball", "bench"], "on the bench"],
      ["ADD_OBJECT", ["red bottle", "grass"], "on the grass"],
    ],
  ],
  // 4c's must-not-claim rows, which 4c still does not claim (plan §4.2): each clause its own rule.
  [
    "change my jersey to adidas and make the socks white",
    [
      ["RECOLOR", ["socks"], "white"],
      ["REPLACE_OBJECT", ["jersey"], "adidas jersey"],
    ],
  ],
  [
    "change my jersey to adidas blue and make the socks white",
    [
      ["RECOLOR", ["socks"], "white"],
      ["REPLACE_OBJECT", ["jersey"], "adidas blue jersey"],
    ],
  ],
  // This PR's own pins — the shared verb, a composed drop, the cap, one background and one look.
  [
    "make my socks nike and make the jersey blue",
    [
      ["RECOLOR", ["jersey"], "blue"],
      ["REPLACE_OBJECT", ["socks"], "nike socks"],
    ],
  ],
  [
    "swap the cleats for Nike Mercurials and remove the ball",
    [
      ["REPLACE_OBJECT", ["cleats"], "nike cleats"],
      ["REMOVE_OBJECT", ["ball"], null],
    ],
  ],
  [
    "change my uniform, socks, and shoes all to be adidas and remove the ball",
    [
      ["REPLACE_OBJECT", ["uniform"], "adidas uniform"],
      ["REPLACE_OBJECT", ["socks"], "adidas socks"],
      ["REPLACE_OBJECT", ["shoes"], "adidas shoes"],
      ["REMOVE_OBJECT", ["ball"], null],
    ],
  ],
  [
    "change the background to a beach and make it black and white",
    [
      ["GLOBAL_STYLE", [], "black and white"],
      ["CHANGE_BACKGROUND", ["person"], "beach"],
    ],
  ],
  [
    "add a soccer ball at her feet and make the socks blue",
    [
      ["ADD_OBJECT", ["soccer ball"], "at her feet"],
      ["RECOLOR", ["socks"], "blue"],
    ],
  ],
  // H.6's boundary: a removal of a DIFFERENT thing is no conflict, and composes.
  [
    "remove the tennis ball and make the soccer ball red",
    [
      ["RECOLOR", ["soccer ball"], "red"],
      ["REMOVE_OBJECT", ["tennis ball"], null],
    ],
  ],
  // H.3's pins (nativeIntent.test.ts, studio.native.test.ts): the acceptance's add-combo, the echo
  // sentence, and B-c12's region-bearing clauses as detection is given them.
  [
    "add a soccer ball at her feet and change the background to a packed stadium at night",
    [
      ["ADD_OBJECT", ["soccer ball"], "at her feet"],
      ["CHANGE_BACKGROUND", ["person"], "packed stadium at night"],
    ],
  ],
  [
    "make blue the socks and change the background to a stadium",
    [
      ["RECOLOR", ["socks"], "blue"],
      ["CHANGE_BACKGROUND", ["person"], "stadium"],
    ],
  ],
  [
    "remove the soccer ball and make her jersey blue",
    [
      ["RECOLOR", ["jersey"], "blue"],
      ["REMOVE_OBJECT", ["soccer ball"], null],
    ],
  ],
  // ─── NOT SENTENCES SHE TYPES: compiled instructions the pins assert, which the diff's corpus reads
  // as sentences. Listed because the diff is mechanical. Each clause routes exactly as it does ALONE on
  // 991aaef — "…and fill the space where it was…" is rule 1's own reading of that clause ("space where
  // it" a second target), "give the whole photograph this look" rule 5's — so composition adds no
  // reading of its own; it only stops asking. None is a phrasing the product teaches or expects.
  [
    "add a soccer ball, place it at the person's feet, and change the background to packed stadium at night.",
    [
      ["ADD_OBJECT", ["soccer ball"], "at the person s feet"],
      ["CHANGE_BACKGROUND", ["person"], "packed stadium at night"],
    ],
  ],
  [
    "add a ball, place it on the bench, and add a red bottle, place it on the grass.",
    [
      ["ADD_OBJECT", ["ball", "bench"], "on the bench"],
      ["ADD_OBJECT", ["red bottle", "grass"], "on the grass"],
    ],
  ],
  [
    "change the background to beach, and give the whole photograph this look: black and white.",
    [
      ["RECOLOR", ["whole photograph this"], "black"],
      ["CHANGE_BACKGROUND", ["person"], "beach"],
    ],
  ],
  [
    "make the jersey blue, and remove the soccer ball and fill the space where it was with what naturally lies behind it, and change the background to stadium.",
    [
      ["RECOLOR", ["jersey"], "blue"],
      ["CHANGE_BACKGROUND", ["person"], "stadium"],
      ["REMOVE_OBJECT", ["soccer ball", "space where it"], null],
    ],
  ],
  [
    "remove the cleats and fill the space where it was with what naturally lies behind it, and change the background to stadium.",
    [
      ["CHANGE_BACKGROUND", ["person"], "stadium"],
      ["REMOVE_OBJECT", ["cleats", "space where it"], null],
    ],
  ],
  [
    "remove the soccer ball and fill the space where it was with what naturally lies behind it, and change the background to packed stadium at night.",
    [
      ["CHANGE_BACKGROUND", ["person"], "packed stadium at night"],
      ["REMOVE_OBJECT", ["soccer ball", "space where it"], null],
    ],
  ],
]);

describe("THE INVARIANT — nothing that asked on main routes now, except what ADD_OBJECT, 4c, composition and the worn add claim on purpose", () => {
  it("every sentence that asked on main still asks, or is an add, a brand change, a composed sentence or a worn add a PR meant to route", () => {
    for (const text of ASKED_ON_MAIN) {
      const out = route(text, true);
      if (CLAIMED_BY_COMPOSITION.has(text)) {
        expect({
          text,
          steps: out.steps.map((s) => [s.op, s.targets, s.value]),
        }).toEqual({ text, steps: CLAIMED_BY_COMPOSITION.get(text) });
      } else if (CLAIMED_BY_PLACEMENT.has(text)) {
        expect({
          text,
          path: out.initialPath,
          steps: out.steps.map((s) => [s.op, s.targets, s.value]),
        }).toEqual({
          text,
          path: "FULL_IMAGE",
          steps: CLAIMED_BY_PLACEMENT.get(text),
        });
      } else if (CLAIMED_BY_WORN_ADD.has(text)) {
        expect({
          text,
          path: out.initialPath,
          steps: out.steps.map((s) => [s.op, s.targets, s.value]),
        }).toEqual({
          text,
          path: "FULL_IMAGE",
          steps: CLAIMED_BY_WORN_ADD.get(text),
        });
      } else if (CLAIMED_BY_ADD.has(text)) {
        expect({ text, path: out.initialPath, op: out.steps[0]?.op }).toEqual({
          text,
          path: "FULL_IMAGE",
          op: "ADD_OBJECT",
        });
      } else if (CLAIMED_BY_BRAND.has(text)) {
        expect({
          text,
          path: out.initialPath,
          ops: [...new Set(out.steps.map((s) => s.op))],
          items: out.steps.length,
        }).toEqual({
          text,
          path: "MASKED",
          ops: ["REPLACE_OBJECT"],
          items: CLAIMED_BY_BRAND.get(text),
        });
      } else {
        expect({ text, path: out.initialPath }).toEqual({ text, path: "ASK" });
      }
    }
  });

  it("claims nothing that was not on the list — the exemption cannot outgrow the evidence", () => {
    for (const text of CLAIMED_BY_ADD) expect(ASKED_ON_MAIN).toContain(text);
    for (const text of CLAIMED_BY_BRAND.keys()) {
      expect(ASKED_ON_MAIN).toContain(text);
    }
    for (const text of CLAIMED_BY_WORN_ADD.keys()) {
      expect(ASKED_ON_MAIN).toContain(text);
    }
    for (const text of CLAIMED_BY_PLACEMENT.keys()) {
      expect(ASKED_ON_MAIN).toContain(text);
    }
  });

  it("THE PERSON GUARD'S SENTENCES STILL ASK, for the guard's own reasons — this PR moves brand only", () => {
    // Asserted by name and by reason, beside the invariant's path check: the G1 sentence, D1's two
    // body-surface adds, and the one brand sentence with her arms among its items. D1's hat was the
    // second add until PR M3 made it a worn add (CLAIMED_BY_WORN_ADD); a crown, not worn, stands in.
    expect(
      [
        "make my arms bigger",
        "add a tattoo on my arm",
        "add a crown on my head",
        "change my jersey and my arms to adidas",
      ].map((text) => {
        const out = route(text, true);
        return [text, out.initialPath, out.reason];
      }),
    ).toEqual([
      ["make my arms bigger", "ASK", "person_mentioned"],
      ["add a tattoo on my arm", "ASK", "person_target"],
      ["add a crown on my head", "ASK", "person_target"],
      ["change my jersey and my arms to adidas", "ASK", "person_target"],
    ]);
  });
});

// ─── THE INVARIANT, COMPOSITION PR 1 — rule ½ only ever turns a MISROUTE into an ASK ─────────────

/**
 * Every sentence that ROUTED on main (c06e768) and ASKS since rule ½ — which is exactly B.4's diff:
 * main's route() against this branch's over every quoted string in the Studio test files, each with
 * and without a source photo. Nothing else changed routing: no ASK routes now, no route changed its
 * steps, and nothing changed without a photo. (Eight sentences that already asked changed only their
 * reason, to compound_pending; twelve once sweep #3's F2 pins joined the corpus.)
 *
 * The value is what main routed it as, recorded from that diff — not asserted here, since main's
 * classifier is not in this tree. It is why each may ask: every one is a misroute — another clause's
 * noun claimed as a removal or a recolour, a change dropped, a place read from the wrong clause.
 */
const ASKS_SINCE_COMPOSITION_1 = new Map<string, string>([
  ["make her jersey blue and remove the ball", "REMOVE_OBJECT [jersey, ball]"],
  [
    "Remove the soccer ball, and make her jersey blue.",
    "REMOVE_OBJECT [soccer ball, jersey]",
  ],
  [
    "make her jersey blue and change the background to a stadium",
    "CHANGE_BACKGROUND stadium — the recolour dropped",
  ],
  [
    "make her jersey blue, add a soccer ball at her feet, and change the background to a stadium",
    'CHANGE_BACKGROUND "her feet" — the recolour and the add dropped',
  ],
  [
    "make the socks blue and add a ball on the bench",
    "RECOLOR [socks, ball, bench]",
  ],
  [
    "make the socks blue, then get rid of the cone",
    "REMOVE_OBJECT [socks, cone]",
  ],
  ["remove the ball and put it on the bench", "REMOVE_OBJECT [ball, bench]"],
  [
    "add a ball on the bench and add a red bottle on the grass",
    "RECOLOR [ball, bench, grass] red — neither add",
  ],
  [
    "make it black and white and make it warmer",
    'GLOBAL_STYLE "black and white" — "warmer" dropped',
  ],
  [
    "make the socks blue and make it pop",
    'RECOLOR [socks] — "make it pop" dropped without a word',
  ],
  // Sweep #3's other eight, which its pins (below) bring into the corpus — each as the addendum's
  // retrieved prompt has it, and as main's route() still routes it.
  [
    "make her jersey blue and remove the water bottle",
    "REMOVE_OBJECT [jersey, water bottle] (B-c3)",
  ],
  [
    "make her jersey blue and remove the cleats",
    "REMOVE_OBJECT [jersey, cleats] (B-c4, IMAGE_SAFETY)",
  ],
  [
    "remove the cleats and change the background to a stadium",
    "REMOVE_OBJECT [cleats, background, stadium] (B-c6)",
  ],
  [
    "make her jersey blue and add a lightning bolt design to her socks",
    "APPLY_DESIGN [socks] — the recolour dropped (B-c10)",
  ],
  [
    "remove the soccer ball, make her jersey blue, and change the background to a stadium",
    "REMOVE_OBJECT [soccer ball, jersey, background, stadium] (B-c12, IMAGE_SAFETY)",
  ],
  [
    "add a soccer ball at her feet, then change the background to a stadium",
    'CHANGE_BACKGROUND "her feet" — the add dropped (B-c14)',
  ],
  [
    "Add a soccer ball at the person's feet, and change the background to a packed stadium at night.",
    'CHANGE_BACKGROUND "person" — the add dropped (B-p1)',
  ],
  [
    "Remove the soccer ball, and change the background to a packed stadium at night.",
    "REMOVE_OBJECT [soccer ball, background, packed stadium] (B-p4)",
  ],
]);

/**
 * Compound-SHAPED sentences that route correctly on main and must route IDENTICALLY now, step for
 * step: a joiner in every one, and one change in each. The diff above shows none of them moved; this
 * pins them so that stays true. [op, targets, value] per step.
 */
const STILL_ROUTES_ACROSS_CLAUSES = new Map<
  string,
  [EditOperation, string[], string | null][]
>([
  // Acceptance, on the Q1 frame: 4c's list, C′'s add, and a recolour said twice.
  [
    "change my uniform, socks, and shoes all to be adidas",
    [
      ["REPLACE_OBJECT", ["uniform"], "adidas uniform"],
      ["REPLACE_OBJECT", ["socks"], "adidas socks"],
      ["REPLACE_OBJECT", ["shoes"], "adidas shoes"],
    ],
  ],
  [
    "add the soccer ball from the second image, place it between her cleats",
    [["ADD_OBJECT", ["soccer ball"], "between her cleats"]],
  ],
  [
    "make her jersey blue and make her socks red",
    [["RECOLOR", ["jersey", "socks"], "blue"]],
  ],
  // One verb, two targets — B-c2, whose compiled prompt was right.
  [
    "make her jersey blue and her socks red",
    [["RECOLOR", ["jersey", "socks"], "blue"]],
  ],
  // One change, said with a second verb.
  [
    "change the socks to red and change the shoes to white",
    [["RECOLOR", ["socks", "shoes"], "red"]],
  ],
  [
    "make the jersey blue and change the socks to red",
    [["RECOLOR", ["jersey", "socks"], "blue"]],
  ],
  [
    "remove the ball and remove the cone",
    [["REMOVE_OBJECT", ["ball", "cone"], null]],
  ],
  [
    "remove the ball and delete the cone",
    [["REMOVE_OBJECT", ["ball", "cone"], null]],
  ],
  ["remove the ball and then delete it", [["REMOVE_OBJECT", ["ball"], null]]],
  // C′'s other continuations, across a comma and a full stop.
  [
    "add a soccer ball to the image, place it in the middle of my cleats",
    [["ADD_OBJECT", ["soccer ball"], "in the middle of my cleats"]],
  ],
  [
    "add the soccer ball from the second image into the first one. place it in the middle of the cleats.",
    [["ADD_OBJECT", ["soccer ball"], "in the middle of the cleats"]],
  ],
  // 4c's lists, with a comma and "and" in each.
  [
    "change my jersey, shorts, socks and shoes to adidas",
    [
      ["REPLACE_OBJECT", ["jersey"], "adidas jersey"],
      ["REPLACE_OBJECT", ["shorts"], "adidas shorts"],
      ["REPLACE_OBJECT", ["socks"], "adidas socks"],
      ["REPLACE_OBJECT", ["shoes"], "adidas shoes"],
    ],
  ],
  [
    "change my socks and shoes to black and white nike ones",
    [
      ["REPLACE_OBJECT", ["socks"], "black and white nike socks"],
      ["REPLACE_OBJECT", ["shoes"], "black and white nike shoes"],
    ],
  ],
  // One removal of two things — the brand_removal copy's own example.
  [
    "remove the number eight and the nike logo",
    [["REMOVE_OBJECT", ["number eight", "nike logo"], null]],
  ],
  // What comes before her first verb, and a new image, which never composes.
  ["I love this photo, make the socks blue", [["RECOLOR", ["socks"], "blue"]]],
  [
    "make a new poster of me and add a stadium background",
    [["GENERATE", [], null]],
  ],
]);

/**
 * Every sentence PR 1 asked that composition does NOT route, with the code it asks with now. Together
 * with CLAIMED_BY_COMPOSITION this covers ASKS_SINCE_COMPOSITION_1 exactly, one or the other.
 */
const STILL_ASKS_AFTER_COMPOSITION = new Map<string, string>([
  // Two looks: rule 3 reads one value.
  ["make it black and white and make it warmer", "compound_conflict"],
  // "make it pop" is a clause no rule reads, and only the catch-all becomes compound_partial.
  ["make the socks blue and make it pop", "compound_partial"],
  // "put it on the bench", on its own, is an add of a thing she never named (d1).
  ["remove the ball and put it on the bench", "add_unclear"],
]);

/**
 * Sentences 991aaef ASKED that neither ASKED_ON_MAIN nor ASKS_SINCE_COMPOSITION_1 lists — sweep #3's
 * F2 sentences (person_target / add_unclear on c06e768, compound_pending on 991aaef, per PR 1's diff)
 * and this PR's own compound pins. Each verified by the diff harness running 991aaef's route() over
 * this exact list: every one ASKED there as compound_pending. It is the evidence composition's claims
 * are checked against, so a claim cannot be added without saying where the ask was seen.
 */
const ASKED_ON_COMPOSITION_1 = [
  "add a soccer ball at her feet and make her jersey blue",
  "add a soccer ball at her feet and remove the nike logo",
  "add a soccer ball at her feet and add a water bottle next to her",
  "add a soccer ball at her feet. Also make her jersey blue.",
  "add a soccer ball at her feet. Also please make her jersey blue.",
  "make my socks nike and make the jersey blue",
  "swap the cleats for Nike Mercurials and remove the ball",
  "change my uniform, socks, and shoes all to be adidas and remove the ball",
  "change the background to a beach and make it black and white",
  "add a soccer ball at her feet and make the socks blue",
  "add a soccer ball at her feet and change the background to a packed stadium at night",
  "make blue the socks and change the background to a stadium",
  "remove the soccer ball and make her jersey blue",
  "add a soccer ball, place it at the person's feet, and change the background to packed stadium at night.",
  "add a ball, place it on the bench, and add a red bottle, place it on the grass.",
  "change the background to beach, and give the whole photograph this look: black and white.",
  "make the jersey blue, and remove the soccer ball and fill the space where it was with what naturally lies behind it, and change the background to stadium.",
  "remove the cleats and fill the space where it was with what naturally lies behind it, and change the background to stadium.",
  "remove the soccer ball and fill the space where it was with what naturally lies behind it, and change the background to packed stadium at night.",
  "remove the tennis ball and make the soccer ball red",
];

describe("THE INVARIANT, COMPOSITION PR 2 — only an ask becomes a route, and every route is untouched", () => {
  it("composes every sentence it claims exactly as listed, step for step", () => {
    for (const [text, expected] of CLAIMED_BY_COMPOSITION) {
      expect({
        text,
        steps: route(text, true).steps.map((s) => [s.op, s.targets, s.value]),
      }).toEqual({ text, steps: expected });
    }
  });

  it("claims nothing that did not ask before it — the exemption cannot outgrow the evidence", () => {
    const askedBefore = new Set([
      ...ASKED_ON_MAIN,
      ...ASKS_SINCE_COMPOSITION_1.keys(),
      ...ASKED_ON_COMPOSITION_1,
    ]);
    for (const text of CLAIMED_BY_COMPOSITION.keys()) {
      expect({ text, askedBefore: askedBefore.has(text) }).toEqual({
        text,
        askedBefore: true,
      });
      // And only a compound: a sentence of one clause is read whole by the rules, as ever.
      expect({
        text,
        compound: (compoundClauses(text)?.length ?? 0) > 1,
      }).toEqual({ text, compound: true });
    }
    // No composed sentence is one a same-change rule already routed (2a): those are pinned below as
    // routing exactly as before, and the two lists do not meet.
    for (const text of CLAIMED_BY_COMPOSITION.keys()) {
      expect(STILL_ROUTES_ACROSS_CLAUSES.has(text)).toBe(false);
    }
  });

  it("every sentence PR 1 asked is composed now, or still asks — with the code true of it", () => {
    for (const text of ASKS_SINCE_COMPOSITION_1.keys()) {
      const out = route(text, true);
      if (CLAIMED_BY_COMPOSITION.has(text)) {
        expect(STILL_ASKS_AFTER_COMPOSITION.has(text)).toBe(false);
        expect({ text, path: out.initialPath === "ASK" }).toEqual({
          text,
          path: false,
        });
      } else {
        expect({ text, path: out.initialPath, reason: out.reason }).toEqual({
          text,
          path: "ASK",
          reason: STILL_ASKS_AFTER_COMPOSITION.get(text),
        });
      }
    }
    for (const text of STILL_ASKS_AFTER_COMPOSITION.keys()) {
      expect(ASKS_SINCE_COMPOSITION_1.has(text)).toBe(true);
    }
  });
});

describe("THE INVARIANT, COMPOSITION PR 1 — only a misroute becomes an ask; every correct route is untouched", () => {
  it("routes every compound-shaped sentence that was right on main exactly as before, step for step", () => {
    for (const [text, expected] of STILL_ROUTES_ACROSS_CLAUSES) {
      expect({
        text,
        steps: route(text, true).steps.map((s) => [s.op, s.targets, s.value]),
      }).toEqual({ text, steps: expected });
    }
  });
});

// ─── SWEEP #3 — the findings' sentences, pinned (docs/probes/sweep-3-part-b-findings.md) ─────────

/**
 * Every Part B sentence that ROUTED WRONG on main, with its cell, its job and what was compiled — the
 * addendum's retrieved prompts (studio_generation_previews.plan->inputs->prompt). B-c3 ran no job;
 * its freeze is the addendum's route() of the sentence. The last row is the repro from the removal-
 * claims-everything bug, and the acceptance sentence on the Q1 frame.
 */
const SWEEP_3_MISROUTES: [
  cell: string,
  job: string,
  sentence: string,
  sent: string,
][] = [
  [
    "B-c1",
    "d03eb070",
    "make her jersey blue and change the background to a stadium",
    "change the background to stadium — the recolour dropped",
  ],
  [
    "B-c3",
    "—",
    "make her jersey blue and remove the water bottle",
    "froze remove [jersey, water bottle]",
  ],
  [
    "B-c4",
    "f115eefa",
    "make her jersey blue and remove the cleats",
    "remove the jersey … remove the cleats — IMAGE_SAFETY",
  ],
  [
    "B-c6",
    "7fdbbdab",
    "remove the cleats and change the background to a stadium",
    "remove the cleats, the background and the stadium",
  ],
  [
    "B-c10",
    "5f5f4a2a",
    "make her jersey blue and add a lightning bolt design to her socks",
    "add lightning bolt design to the socks — the recolour dropped",
  ],
  [
    "B-c11",
    "bd9ceaea",
    "make her jersey blue, add a soccer ball at her feet, and change the background to a stadium",
    "change the background to her feet",
  ],
  [
    "B-c12",
    "235d7377",
    "remove the soccer ball, make her jersey blue, and change the background to a stadium",
    "remove the soccer ball, the jersey, the background and the stadium — IMAGE_SAFETY",
  ],
  [
    "B-c14",
    "02ab0844",
    "add a soccer ball at her feet, then change the background to a stadium",
    "change the background to her feet",
  ],
  [
    "B-p1",
    "d320bb2d",
    "Add a soccer ball at the person's feet, and change the background to a packed stadium at night.",
    "change the background to person",
  ],
  [
    "B-p4",
    "c2c62376",
    "Remove the soccer ball, and change the background to a packed stadium at night.",
    "remove the soccer ball, the background and the packed stadium",
  ],
  [
    "B-p5",
    "95ab99ff",
    "Remove the soccer ball, and make her jersey blue.",
    "remove the soccer ball … remove the jersey — and she paid for it",
  ],
  [
    "repro",
    "—",
    "make her jersey blue and remove the ball",
    "froze remove [jersey, ball]",
  ],
];

describe("SWEEP #3 — every sentence that compiled the wrong instruction now routes as what she asked (composition)", () => {
  it("composes all twelve — each change from its own clause, none of another clause's nouns claimed", () => {
    // PR 1 asked all twelve. Each now routes as CLAIMED_BY_COMPOSITION lists it, and none of the
    // addendum's failure shapes survives: no removal of the jersey, the background or the stadium
    // (rule 1 claiming every noun), and no background whose place came from another clause ("her
    // feet", "person" — rule 2 reading the sentence's first phrase). Compiled-instruction pins for the
    // same sentences are in nativeIntent.test.ts.
    for (const [cell, , sentence] of SWEEP_3_MISROUTES) {
      const out = route(sentence, true);
      expect({
        cell,
        steps: out.steps.map((s) => [s.op, s.targets, s.value]),
      }).toEqual({ cell, steps: CLAIMED_BY_COMPOSITION.get(sentence) });
      expect({
        cell,
        removedWrongly: out.steps
          .filter((s) => s.op === "REMOVE_OBJECT")
          .flatMap((s) => s.targets)
          .filter((t) => /jersey|background|stadium/.test(t)),
        placesFromAnotherClause: out.steps
          .filter((s) => s.op === "CHANGE_BACKGROUND")
          .map((s) => s.value)
          .filter((v) => !/stadium/.test(v ?? "")),
      }).toEqual({ cell, removedWrongly: [], placesFromAnotherClause: [] });
    }
  });

  it("F2 — the person refusal no longer answers sentences that edit no one, and they route", () => {
    // Main told each of these "we don't edit people": the recolour's or removal's rule claimed "her
    // feet" as a target and the guard refused it. B-c9 asked add_unclear, with the junk target
    // "water bottle next". PR 1 told all four "one change per sentence". They route now: "at her
    // feet" is an add's spatial place, read by the add's own rule, never a target. The findings
    // record B-c13 only as "two sentences ('also')", so its row is that shape, not her verbatim words.
    for (const [cell, sentence] of [
      ["B-c7", "add a soccer ball at her feet and make her jersey blue"],
      ["B-c8", "add a soccer ball at her feet and remove the nike logo"],
      [
        "B-c9",
        "add a soccer ball at her feet and add a water bottle next to her",
      ],
      ["B-c13", "add a soccer ball at her feet. Also make her jersey blue."],
    ]) {
      const out = route(sentence, true);
      expect({
        cell,
        reason: out.reason,
        steps: out.steps.map((s) => [s.op, s.targets, s.value]),
      }).toEqual({
        cell,
        reason: undefined,
        steps: CLAIMED_BY_COMPOSITION.get(sentence),
      });
    }
  });

  it("still routes B-c2, the one Part B sentence whose compiled prompt was right", () => {
    // "make the jersey blue, and make the socks red" — one operation, two targets (1ae8803f).
    expect(
      route("make her jersey blue and her socks red", true).steps.map((s) => [
        s.op,
        s.targets,
      ]),
    ).toEqual([["RECOLOR", ["jersey", "socks"]]]);
  });
});

describe("trailing modifiers — the head has to be a noun for the guard to see it", () => {
  it("finds the noun under a comparative, which the head rule alone could not", () => {
    // Measured before this existed: namesPerson("arm bigger") was FALSE, because the head was
    // "bigger". "make her arm bigger" is a body edit and the guard did not deny it.
    expect(namesPerson("arm bigger")).toBe(true);
    expect(namesPerson("arm")).toBe(true);
    expect(namesPerson("face mask")).toBe(false);
  });

  it("strips through stacked intensifiers", () => {
    for (const p of [
      "arms much bigger",
      "legs longer",
      "her thighs slightly slimmer",
      "chest way wider",
    ]) {
      expect(namesPerson(p)).toBe(true);
    }
  });

  it("does NOT strip colours, because 'eye black' is a real product", () => {
    // A colour is a VALUE, and extraction already ends a phrase on one. Stripping it here would
    // make the head "eye", deny athlete face paint forever, and there would be no way to ask for it.
    expect(namesPerson("eye black")).toBe(false);
    expect(normalizeObjectNoun("eye black", true)).toBe("eye black");
  });

  it("leaves every pinned compound alone", () => {
    for (const p of [
      "face mask",
      "knee pad",
      "shin guard",
      "arm sleeve",
      "hand wrap",
      "body spray",
      "hair tie",
    ]) {
      expect(namesPerson(p)).toBe(false);
    }
  });

  it("cannot narrow the guard — an all-modifier phrase names nothing", () => {
    // The monotonicity property: the strip only pops words in the modifier list, no person noun is
    // in that list, so a head that was already a person noun cannot move. It adds denials only.
    expect(namesPerson("bigger")).toBe(false);
    expect(namesPerson("much bigger")).toBe(false);
  });

  it("keeps targets clean for SAM, not just the guard correct", () => {
    expect(extractTargets("make her arm bigger").map((t) => t.phrase)).toEqual([
      "arm",
    ]);
    expect(
      extractTargets("remove the water bottle").map((t) => t.phrase),
    ).toEqual(["water bottle"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// GUARD SCOPE (2026-09-10) — Mia's four sentences, and the guard's boundary on both sides
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Every sentence that ROUTED on 0cf9ae9 (main, composition 2 in) and ASKS since this PR — the route()
 * diff of 0cf9ae9 against this branch over every quoted string in the Studio test files. The value is
 * what 0cf9ae9 routed it as (recorded from that diff; main's classifier is not in this tree) and the
 * code it asks with now. Every one is a misroute: an edit to her body, or a clause stripped to a
 * removal of the wrong thing.
 */
const ASKS_SINCE_GUARD_SCOPE = new Map<string, [string, string]>([
  // ─── G.1: a body word the deny set did not have. Each compiled into a native instruction. ───────
  ["make my lip gold", ["RECOLOR [lip]", "person_target"]],
  ["make my earlobes gold", ["RECOLOR [earlobes]", "person_target"]],
  ["make my nails pink", ["RECOLOR [nails]", "person_target"]],
  ["make my fingernails pink", ["RECOLOR [fingernails]", "person_target"]],
  ["paint my toenails pink", ["RECOLOR [toenails]", "person_target"]],
  ["make my toes pink", ["RECOLOR [toes]", "person_target"]],
  ["make the toes pink", ["RECOLOR [toes]", "person_target"]],
  // The gear reading's other side: one possessed mention and the toe is hers. 0cf9ae9 recoloured it.
  [
    "make the toe of my cleats and my toe white",
    ["RECOLOR [toe, cleats, toe]", "person_target"],
  ],
  ["make her nails red", ["RECOLOR [nails]", "person_target"]],
  ["make my eyelashes black", ["RECOLOR [eyelashes]", "person_target"]],
  ["make my lashes black", ["RECOLOR [lashes]", "person_target"]],
  ["make my brows red", ["RECOLOR [brows]", "person_target"]],
  ["make my eyelids gold", ["RECOLOR [eyelids]", "person_target"]],
  ["make my nostrils red", ["RECOLOR [nostrils]", "person_target"]],
  ["make my belly button gold", ["RECOLOR [belly button]", "person_target"]],
  ["make my navel gold", ["RECOLOR [navel]", "person_target"]],
  // ─── Rule ¼: a condition, stripped by rule 1 to a removal of whatever noun it could find. ────────
  // Mia's (d), first clause verbatim — and composed beside a clause the rules could read, it ROUTED.
  [
    "change my uniform so that its a black adidas uniform. i dont want any nike logos showing in this so if there are any remove them",
    ["REMOVE_OBJECT [uniform]", "conditional"],
  ],
  [
    "change my uniform so that its a black adidas uniform. i dont want any nike logos showing in this so if there are any remove them. also make my cleats pink",
    ["RECOLOR [cleats] + REMOVE_OBJECT [uniform]", "conditional"],
  ],
  [
    "make my socks blue, and if there are any logos remove them",
    ["REMOVE_OBJECT [socks]", "conditional"],
  ],
  // The condition glued onto the target: a noun no segmenter can find.
  [
    "remove the ball if there is one",
    ["REMOVE_OBJECT [ball if there]", "conditional"],
  ],
  [
    "remove the ball if there's one",
    ["REMOVE_OBJECT [ball if there]", "conditional"],
  ],
  [
    "remove the ball if theres one",
    ["REMOVE_OBJECT [ball if theres]", "conditional"],
  ],
  [
    "remove the nike logos if any",
    ["REMOVE_OBJECT [nike logos if]", "conditional"],
  ],
  [
    "remove the ball and remove the logos if there are any",
    ["REMOVE_OBJECT [ball, logos if there]", "conditional"],
  ],
]);

describe("GUARD SCOPE, G.1 — a part of her the deny set did not name now asks, and the gear sentence still routes", () => {
  it("refuses every body edit that routed on 0cf9ae9, with the guard's own code", () => {
    for (const [text, [, reason]] of ASKS_SINCE_GUARD_SCOPE) {
      if (reason !== "person_target") continue;
      const out = route(text, true);
      expect({ text, path: out.initialPath, reason: out.reason }).toEqual({
        text,
        path: "ASK",
        reason,
      });
    }
  });

  it("keeps 'the toe of my cleats' routing exactly as it did — toe is denied, a part of a THING is not hers", () => {
    // Decision 1 (Adi): deny a toe or a nail she possesses, keep the cleat's. What 0cf9ae9 routed,
    // step for step — the widening moves none of these.
    for (const [text, steps] of [
      [
        "make the toe of my cleats white",
        [["RECOLOR", ["toe", "cleats"], "white"]],
      ],
      [
        "make the toes of my cleats white",
        [["RECOLOR", ["toes", "cleats"], "white"]],
      ],
      [
        "make the toe of her cleats white",
        [["RECOLOR", ["toe", "cleats"], "white"]],
      ],
      [
        "remove the toe of my cleats",
        [["REMOVE_OBJECT", ["toe", "cleats"], null]],
      ],
      [
        "make the toe cap of my cleats white",
        [["RECOLOR", ["toe cap", "cleats"], "white"]],
      ],
    ] as [string, [string, string[], string | null][]][]) {
      expect({
        text,
        steps: route(text, true).steps.map((s) => [s.op, s.targets, s.value]),
      }).toEqual({ text, steps });
    }
  });

  it("…and refuses the toe whenever the sentence gives it to her, or does not say whose it is", () => {
    // Positive evidence of a thing is what exempts — never the absence of a possessive. "the toes"
    // with no "of" is hers in a barefoot frame; a part of her foot is hers; one possessed mention
    // anywhere in the sentence and the whole target is hers.
    for (const text of [
      "make my toes pink",
      "make the toes pink",
      "make the toe of my foot white",
      "make the toes of her feet pink",
      "make the toe of my cleats and my toe white",
      "make the nails red",
    ]) {
      const out = route(text, true);
      expect({ text, path: out.initialPath, reason: out.reason }).toEqual({
        text,
        path: "ASK",
        reason: "person_target",
      });
    }
  });

  it("keeps hair denied and a hair tie editable — the head noun decides, as ever", () => {
    // Hair is her likeness (a SAM 'hair' mask is a mask of her: 0.145 fill, measured 2026-09-08), so
    // it stays on the list; what she wears IN her hair is named by its own head noun and passes.
    expect(route("make my hair pink", true).reason).toBe("person_target");
    expect(
      route("make my hair tie pink", true).steps.map((s) => [s.op, s.targets]),
    ).toEqual([["RECOLOR", ["hair tie"]]]);
  });

  it("still refuses the two body sentences the PR brief names — nothing here reopens them", () => {
    expect(
      ["make my arms bigger", "add a tattoo on my arm"].map((text) => {
        const out = route(text, true);
        return [text, out.initialPath, out.reason];
      }),
    ).toEqual([
      ["make my arms bigger", "ASK", "person_mentioned"],
      ["add a tattoo on my arm", "ASK", "person_target"],
    ]);
  });
});

describe("GUARD SCOPE, rule ¼ — a condition on the picture is not read, so it cannot be stripped to a removal", () => {
  it("asks for every conditional sentence that routed on 0cf9ae9 — each a removal of the wrong thing", () => {
    for (const [text, [, reason]] of ASKS_SINCE_GUARD_SCOPE) {
      if (reason !== "conditional") continue;
      const out = route(text, true);
      expect({ text, path: out.initialPath, reason: out.reason }).toEqual({
        text,
        path: "ASK",
        reason,
      });
    }
  });

  it("asks Mia's whole (d) with the code true of it — the condition, not the brand lecture", () => {
    // 0cf9ae9: brand_change, from the second clause ("pink and adidas", still unread — the brand
    // rule's widening, recorded in the PR body). The first clause is unread now too, and it comes
    // first, so its own code answers.
    const d =
      "change my uniform so that its a black adidas uniform. i dont want any nike logos showing in this so if there are any remove them. also make my cleats pink and adidas";
    const out = route(d, true);
    expect({ path: out.initialPath, reason: out.reason }).toEqual({
      path: "ASK",
      reason: "conditional",
    });
    // And a removal with no target still asks — with the same code, not the catch-all.
    expect(route("remove any logos if there are any", true).reason).toBe(
      "conditional",
    );
  });

  it("reads only the markers, never a bare 'if' — a politeness routes as before", () => {
    expect(
      route("make the socks blue if possible", true).steps.map((s) => [
        s.op,
        s.targets,
        s.value,
      ]),
    ).toEqual([["RECOLOR", ["socks"], "blue"]]);
  });

  it("leaves a new image alone — rule 0 runs first, and the gate's answer is the gate's", () => {
    expect(
      route(
        "generate a new poster of me, if there are any logos keep them",
        true,
      ).steps[0]?.op,
    ).toBe("GENERATE");
  });
});

/**
 * Sentences that ASKED on 0cf9ae9 and ROUTE since the location reading (decision 2), step for step. Each
 * named a worn thing and then WHERE on her it is, and the guard refused the whole sentence over the
 * "where". Every one also appears in ASKED_ON_0CF9AE9, and every one routes exactly as its twin without
 * the location phrase does (WORN_LOCATION_TWINS) — the reading adds no edit that was not already asked
 * for.
 */
const CLAIMED_BY_WORN_LOCATION = new Map<
  string,
  [string, string[], string | null][]
>([
  // The PR brief's own sentence.
  [
    "change the earrings in my ears to gold",
    [["RECOLOR", ["earrings"], "gold"]],
  ],
  ["remove the watch from my wrist", [["REMOVE_OBJECT", ["watch"], null]]],
  [
    "change the necklace on my neck to gold",
    [["RECOLOR", ["necklace"], "gold"]],
  ],
  // "around" and "through" do not end a phrase, so these arrive as "chain around" / "stud through".
  [
    "change the chain around my neck to silver",
    [["RECOLOR", ["chain"], "silver"]],
  ],
  ["change the stud through my nose to gold", [["RECOLOR", ["stud"], "gold"]]],
  [
    "remove the bracelet from my wrist",
    [["REMOVE_OBJECT", ["bracelet"], null]],
  ],
  ["make the headband on my head pink", [["RECOLOR", ["headband"], "pink"]]],
  ["make the hair tie in my hair pink", [["RECOLOR", ["hair tie"], "pink"]]],
  ["make the gloves on my hands black", [["RECOLOR", ["gloves"], "black"]]],
  ["make the wristband on my wrist blue", [["RECOLOR", ["wristband"], "blue"]]],
  ["make the ring on my finger gold", [["RECOLOR", ["ring"], "gold"]]],
  [
    "change the earrings in my left ear to gold",
    [["RECOLOR", ["earrings"], "gold"]],
  ],
  [
    "change the earrings in my ears and the necklace on my neck to gold",
    [["RECOLOR", ["earrings", "necklace"], "gold"]],
  ],
  // A design on a worn thing, where it is on her: as "add a logo to my watch" routes.
  [
    "add a logo to the watch on my wrist",
    [["APPLY_DESIGN", ["watch"], "logo"]],
  ],
]);

/** Each claimed sentence without its location phrase — which already routed on 0cf9ae9. */
const WORN_LOCATION_TWINS = new Map<string, string>([
  ["change the earrings in my ears to gold", "change the earrings to gold"],
  ["remove the watch from my wrist", "remove the watch"],
  ["change the necklace on my neck to gold", "change the necklace to gold"],
  ["change the chain around my neck to silver", "change the chain to silver"],
  ["change the stud through my nose to gold", "change the stud to gold"],
  ["remove the bracelet from my wrist", "remove the bracelet"],
  ["make the headband on my head pink", "make the headband pink"],
  ["make the hair tie in my hair pink", "make the hair tie pink"],
  ["make the gloves on my hands black", "make the gloves black"],
  ["make the wristband on my wrist blue", "make the wristband blue"],
  ["make the ring on my finger gold", "make the ring gold"],
  ["change the earrings in my left ear to gold", "change the earrings to gold"],
  [
    "change the earrings in my ears and the necklace on my neck to gold",
    "change the earrings and the necklace to gold",
  ],
  ["add a logo to the watch on my wrist", "add a logo to the watch"],
]);

/**
 * Sentences 0cf9ae9 ASKED, verified by the diff harness running 0cf9ae9's route() over the corpus (every
 * one ASK(person_target) there). The evidence the location reading's claims are checked against.
 */
const ASKED_ON_0CF9AE9 = [
  "change the earrings in my ears to gold",
  "remove the watch from my wrist",
  "change the necklace on my neck to gold",
  "change the chain around my neck to silver",
  "change the stud through my nose to gold",
  "remove the bracelet from my wrist",
  "make the headband on my head pink",
  "make the hair tie in my hair pink",
  "make the gloves on my hands black",
  "make the wristband on my wrist blue",
  "make the ring on my finger gold",
  "change the earrings in my left ear to gold",
  "change the earrings in my ears and the necklace on my neck to gold",
  "add a logo to the watch on my wrist",
];

describe("GUARD SCOPE, decision 2 — where a worn thing is on her is its location, not a second target", () => {
  it("routes every sentence it claims exactly as listed, step for step", () => {
    for (const [text, expected] of CLAIMED_BY_WORN_LOCATION) {
      expect({
        text,
        steps: route(text, true).steps.map((s) => [s.op, s.targets, s.value]),
      }).toEqual({ text, steps: expected });
    }
  });

  it("routes each exactly as its twin without the location does — no edit that could not already be asked for", () => {
    for (const [text, twin] of WORN_LOCATION_TWINS) {
      const key = (s: string) =>
        route(s, true).steps.map((x) => [x.op, x.targets, x.value, x.scope]);
      expect({ text, steps: key(text) }).toEqual({ text, steps: key(twin) });
    }
    expect([...WORN_LOCATION_TWINS.keys()].sort()).toEqual(
      [...CLAIMED_BY_WORN_LOCATION.keys()].sort(),
    );
  });

  it("claims nothing that did not ask on 0cf9ae9 — the exemption cannot outgrow the evidence", () => {
    for (const text of CLAIMED_BY_WORN_LOCATION.keys()) {
      expect({ text, askedBefore: ASKED_ON_0CF9AE9.includes(text) }).toEqual({
        text,
        askedBefore: true,
      });
    }
  });

  it("keeps the location out of the targets SAM and the compiler are handed", () => {
    expect(
      extractTargets("change the earrings in my ears to gold").map(
        (t) => t.phrase,
      ),
    ).toEqual(["earrings"]);
    expect(
      extractTargets("change the chain around my neck to silver").map(
        (t) => t.phrase,
      ),
    ).toEqual(["chain"]);
  });

  it("still refuses her wherever she is a TARGET — not worn, not a location, or not on the list", () => {
    for (const text of [
      // Not worn: a tattoo on her arm is her arm.
      "remove the tattoo on my arm",
      // Not on the list, on purpose (N6): a crown is a costume piece. The hat pinned here until PR M3 is
      // on the list now, and routes (see the PR M3 block, C-9).
      "change the crown on my head to red",
      // No preposition — her ears are a second thing to change.
      "change the earrings and my ears to gold",
      "make my ears gold",
      // The location goes; a second target naming her stays.
      "change the earrings in my ears and my arms to gold",
      "make the ring on my finger and my nails gold",
      "change the necklace around my neck and my arms to gold",
      // The worn thing is not a phrase the extractor kept ("these" introduces none), so her ears stay
      // a target — or rule 3 would read the empty list as a whole-frame look and route a grade.
      "make these hoops on my ears black and white",
    ]) {
      const out = route(text, true);
      expect({ text, path: out.initialPath, reason: out.reason }).toEqual({
        text,
        path: "ASK",
        reason: "person_target",
      });
    }
  });

  it("reads a location only straight after the worn thing — a word between them and she is a target", () => {
    // The conservative bound, pinned so the adjacency condition has a test that can fail. "on my hands"
    // after "black" is read as naming her, as 0cf9ae9 read it; "make the gloves on my hands black"
    // (claimed above) is the phrasing that routes.
    const out = route("make the gloves black on my hands", true);
    expect({ path: out.initialPath, reason: out.reason }).toEqual({
      path: "ASK",
      reason: "person_target",
    });
  });

  it("leaves a thing around a thing alone — 'around' is not a new phrase boundary everywhere", () => {
    // What 0cf9ae9 routed, unchanged: the reading only acts where the next phrase names her.
    for (const [text, steps] of [
      [
        "remove the fence around the field",
        [["REMOVE_OBJECT", ["fence around", "field"], null]],
      ],
      [
        "remove the chain around the post",
        [["REMOVE_OBJECT", ["chain around", "post"], null]],
      ],
    ] as [string, [string, string[], string | null][]][]) {
      expect({
        text,
        steps: route(text, true).steps.map((s) => [s.op, s.targets, s.value]),
      }).toEqual({ text, steps });
    }
  });

  it("leaves an add onto her to rule 3¾b, which consumes her place the same way (PR M3 — this asked as D1 until Mia's M3)", () => {
    for (const [text, steps] of [
      [
        "add gold hoops to my ears",
        [["ADD_OBJECT", ["gold hoops"], "to my ears"]],
      ],
      ["put a watch on my wrist", [["ADD_OBJECT", ["watch"], "on my wrist"]]],
    ] as [string, [string, string[], string | null][]][]) {
      expect({
        text,
        steps: route(text, true).steps.map((s) => [s.op, s.targets, s.value]),
      }).toEqual({ text, steps });
    }
  });
});

describe("GUARD SCOPE, G.3 — an add of something she wears onto her asks with a line that is true of it", () => {
  it("routes every add G.3 asked as add_onto_body — alone, by pronoun, in a compound — since Mia's M3 (PR M3)", () => {
    // Each ASKed on 0cf9ae9 as person_target ("we don't edit people… not a body"), then as add_onto_body
    // ("a call we haven't made yet") until M3 made the call. Each is rule 3¾b's now: one ADD_OBJECT of the
    // thing, her place its value and never a target.
    const table: [string, [string, string[], string | null][]][] = [
      [
        "add gold hoops to my ears",
        [["ADD_OBJECT", ["gold hoops"], "to my ears"]],
      ],
      ["put a watch on my wrist", [["ADD_OBJECT", ["watch"], "on my wrist"]]],
      [
        "add a necklace on my neck",
        [["ADD_OBJECT", ["necklace"], "on my neck"]],
      ],
      ["add gloves to my hands", [["ADD_OBJECT", ["gloves"], "to my hands"]]],
      ["add earrings to me", [["ADD_OBJECT", ["earrings"], "to me"]]],
      ["add earrings to her", [["ADD_OBJECT", ["earrings"], "to her"]]],
      [
        "add earrings to her ears",
        [["ADD_OBJECT", ["earrings"], "to her ears"]],
      ],
      [
        "place the ring on her finger",
        [["ADD_OBJECT", ["ring"], "on her finger"]],
      ],
      [
        "add a hair tie in my hair",
        [["ADD_OBJECT", ["hair tie"], "in my hair"]],
      ],
      // Rule 5 read this one as RECOLOR [ears] before G.3 — an add, misread, then refused as a body edit.
      [
        "put these gold hoops in my ears",
        [["ADD_OBJECT", ["gold hoops"], "in my ears"]],
      ],
      // A brand beside it does not make it a brand change: the rule runs before rule 4.
      [
        "add a nike headband to my head",
        [["ADD_OBJECT", ["nike headband"], "to my head"]],
      ],
      // Her Object photo's phrasing (consumed, as rule 4½ consumes it).
      [
        "add a watch from the second image to my wrist",
        [["ADD_OBJECT", ["watch"], "to my wrist"]],
      ],
      // Inside a compound, each clause by its own rule; both run full-image, so her order stands.
      [
        "add gold hoops to my ears and make the socks blue",
        [
          ["ADD_OBJECT", ["gold hoops"], "to my ears"],
          ["RECOLOR", ["socks"], "blue"],
        ],
      ],
      [
        "make the socks blue and add gold hoops to my ears",
        [
          ["RECOLOR", ["socks"], "blue"],
          ["ADD_OBJECT", ["gold hoops"], "to my ears"],
        ],
      ],
    ];
    for (const [text, steps] of table) {
      const out = route(text, true);
      expect({
        text,
        path: out.initialPath,
        steps: out.steps.map((s) => [s.op, s.targets, s.value]),
      }).toEqual({ text, path: "FULL_IMAGE", steps });
    }
  });

  it("keeps the person line for what she does not wear — a tattoo, a crown and muscles", () => {
    // WORN_ITEMS decides. D1's own hat ("add a hat on her head", "put a hat on me") was here until PR M3
    // put headwear on it (N6): both are worn adds now (CLAIMED_BY_WORN_ADD). A crown is not (N6).
    for (const text of [
      "add a tattoo on my arm",
      "add a crown on my head",
      "add muscles to my arms",
      "put a crown on me",
    ]) {
      expect({ text, reason: route(text, true).reason }).toEqual({
        text,
        reason: "person_target",
      });
    }
  });

  // Kept add_unclear "pending Mia's exact words" for (c) until wave A's V2 (Adi's brief, 2026-09-17): a worn thing with
  // no place goes where it is worn, and a word the rule does not read asks worn_add_unclear, as it does with a place.
  it("reads a worn add that names no place on her at its anchor — (c)'s candidates, since V2", () => {
    const out = (text: string) => {
      const r = route(text, true);
      return r.initialPath === "ASK"
        ? r.reason
        : r.steps.map((s) => [s.op, s.targets, s.value]);
    };
    expect(
      [
        "add gold hoop earrings",
        "add these gold hoops",
        "add these gold hoops to the first picture",
      ].map((text) => [text, out(text)]),
    ).toEqual([
      ["add gold hoop earrings", "worn_add_unclear"],
      ["add these gold hoops", [["ADD_OBJECT", ["gold hoops"], "in my ears"]]],
      [
        "add these gold hoops to the first picture",
        [["ADD_OBJECT", ["gold hoops"], "in my ears"]],
      ],
    ]);
  });

  it("leaves every add that routed exactly as it was — near her is not on her, and a table is not her", () => {
    for (const [text, steps] of [
      [
        "put the earrings next to her",
        [["ADD_OBJECT", ["earrings"], "next to her"]],
      ],
      [
        "put my earrings on the table",
        [["ADD_OBJECT", ["earrings", "table"], "on the table"]],
      ],
      [
        "add a soccer ball at her feet",
        [["ADD_OBJECT", ["soccer ball"], "at her feet"]],
      ],
    ] as [string, [string, string[], string | null][]][]) {
      expect({
        text,
        steps: route(text, true).steps.map((s) => [s.op, s.targets, s.value]),
      }).toEqual({ text, steps });
    }
  });
});

describe("GUARD SCOPE — the acceptance sentences, pinned as they route (Adi drives the cells)", () => {
  it("routes the paid cell's sentence as a recolour of the earrings — before G.2 it died at the 8px floor", () => {
    expect(
      route("make my earrings gold", true).steps.map((s) => [
        s.op,
        s.targets,
        s.value,
      ]),
    ).toEqual([["RECOLOR", ["earrings"], "gold"]]);
  });

  it("reads 'gold hoops' as the colour alone — 'hoops' is dropped, pinned as it is, not as it should be", () => {
    // Said as a DESCRIPTION, with no pointer, rule 5 takes the colour word and the noun after it is
    // lost, silently. Pointed at a photo ("…to THESE gold hoops") it is rule 3½'s since replace with
    // reference, below; the descriptive sentence is untouched by that PR, on purpose.
    expect(
      route("make my earrings gold hoops", true).steps.map((s) => [
        s.op,
        s.targets,
        s.value,
      ]),
    ).toEqual([["RECOLOR", ["earrings"], "gold"]]);
  });
});

// ─── SWEEP #4, F-I2 — the background named as a PLACE asks; rule 2 only turns a misroute into an ASK ─

/** Q6's two sentences (docs/probes/sweep-4-ledger.md), verbatim — the probe sent them to the model. */
const Q6_T1 =
  "Add a large banner across the top of the background that reads GET LOUD in bold white capital letters. Keep the person, her pose, clothing, lighting and everything else exactly as they are.";
const Q6_T2 =
  "Add a small adidas logo with the words IMPOSSIBLE IS NOTHING beneath it in the upper right corner of the background. Keep everything else exactly as it is.";

/**
 * Every sentence that ROUTED on main (b9ad08b) and ASKS since F-I2 — the route diff's whole moved set,
 * main's route() against this branch's over every quoted string in the Studio test files, each with
 * and without a source photo. Nothing else moved: no ASK routes now, no route changed its steps, and
 * no sentence already in the corpus moved at all — these five are the pins below, and nothing more.
 *
 * The value is what main routed it as, recorded from that diff. Each is a background "change" to a
 * phrase lifted from elsewhere in her sentence, or to nothing: a misroute in every case.
 */
const ASKS_SINCE_F_I2 = new Map<string, string>([
  [Q6_T1, 'CHANGE_BACKGROUND "bold white capital letters"'],
  [Q6_T2, 'CHANGE_BACKGROUND "upper right corner of the background"'],
  [
    "Add a banner across the top of the background that says GET LOUD in white letters",
    'CHANGE_BACKGROUND "white letters"',
  ],
  ["add a GET LOUD banner to the background", 'CHANGE_BACKGROUND "background"'],
  [
    "Add a banner across the top of the background that says GET LOUD",
    "CHANGE_BACKGROUND with no value — sweep #4's half-extract, refused only at the freeze",
  ],
]);

describe("SWEEP #4, F-I2 — the background named as a PLACE is not a background change, and asks", () => {
  it("Q6's two sentences stop routing as background replacements — each asks, with the reason its words earn", () => {
    expect(
      [Q6_T1, Q6_T2].map((text) => {
        const out = route(text, true);
        return [out.initialPath, out.reason, out.steps];
      }),
    ).toEqual([
      ["ASK", "add_unclear", []],
      ["ASK", "fast_path_declined", []],
    ]);
  });

  it("every sentence the diff moved asks now — and it was a misroute on main, each value recorded above", () => {
    for (const text of ASKS_SINCE_F_I2.keys()) {
      const out = route(text, true);
      expect({ text, path: out.initialPath, steps: out.steps }).toEqual({
        text,
        path: "ASK",
        steps: [],
      });
    }
  });

  it("a BLUR of the background carries a value, and it is a treatment rather than a place (wave D, card 4 / A14)", () => {
    // "blur the background" already ROUTED and died at the FREEZE with `missing_value`: rule 2's
    // value is a place after to/in/at/on/into, and a blur names no place. She was told to rephrase a
    // sentence the rules had read correctly (acceptance A14).
    for (const text of [
      "blur the background",
      "blur out the background",
      "make the background blurry",
    ]) {
      expect({ text, steps: route(text, true).steps }).toEqual({
        text,
        steps: [
          {
            op: "CHANGE_BACKGROUND",
            targets: ["person"],
            value: "blurred",
            scope: "SUBJECT_INVERSE",
          },
        ],
      });
    }
    // ⚠️ A PLACE WINS. "a blurred stadium" is a stadium, and its value is not `blurred` whole — so it
    // takes the ordinary template branch and compiles as the replacement it is.
    expect(route("change the background to a blurred stadium", true).steps).toEqual(
      [
        {
          op: "CHANGE_BACKGROUND",
          targets: ["person"],
          value: "blurred stadium",
          scope: "SUBJECT_INVERSE",
        },
      ],
    );
  });

  it("the setting as the THING still routes exactly as main did — rule 2 is reached, step for step", () => {
    // main's own output, recorded from base b9ad08b. The null values are the freeze's to refuse
    // (missing_value), as on main; F-I2 moves none of them.
    for (const [text, steps] of [
      [
        "change the background to a beach",
        [["CHANGE_BACKGROUND", ["person"], "beach"]],
      ],
      [
        "change the colour of the background to blue",
        [["CHANGE_BACKGROUND", ["person"], "blue"]],
      ],
      [
        "change to a beach background",
        [["CHANGE_BACKGROUND", ["person"], "beach background"]],
      ],
      [
        "make the background a beach",
        [["CHANGE_BACKGROUND", ["person"], null]],
      ],
      ["add a beach scene", [["CHANGE_BACKGROUND", ["person"], null]]],
      ["put a stadium behind me", [["CHANGE_BACKGROUND", ["person"], null]]],
      ["put me in a stadium", [["CHANGE_BACKGROUND", ["person"], "stadium"]]],
      [
        "set the scene at a beach",
        [["CHANGE_BACKGROUND", ["person"], "beach"]],
      ],
      [
        "give the background a sunset glow",
        [["CHANGE_BACKGROUND", ["person"], null]],
      ],
      [
        "make me stand in a stadium scene",
        [["CHANGE_BACKGROUND", ["person"], "stadium scene"]],
      ],
    ] as [string, [string, string[], string | null][]][]) {
      expect({
        text,
        steps: route(text, true).steps.map((s) => [s.op, s.targets, s.value]),
      }).toEqual({ text, steps });
    }
  });
});

// ─── WAVE-1 FIXES — rule 2's article is a whole word, so a setting keeps its first letters ─────────

/**
 * Every setting rule 2 read with its first letters eaten on main (8603f24), and what main routed it as.
 *
 * Rule 2's value regex took an optional article with no word boundary after it, and tries "a" first. So
 * "to an arena" matched the "a" of "an", skipped no space, and captured "n arena" — the preview quoted,
 * and the model was sent, "change the background to n arena". A setting that only BEGINS with those
 * letters lost them the same way, article or not: "thletics track", "ater stage". Measured at $0 on main.
 */
const EATEN_ON_MAIN: [text: string, value: string, main: string][] = [
  ["change the background to an arena", "arena", "n arena"],
  [
    "change the background to athletics track",
    "athletics track",
    "thletics track",
  ],
  ["change the background to theater stage", "theater stage", "ater stage"],
  [
    "change the background to their locker room",
    "their locker room",
    "ir locker room",
  ],
  [
    "change the background to an empty arena at night",
    "empty arena at night",
    "n empty arena at night",
  ],
  // The sentence's first word is the preposition.
  ["In an arena behind me", "arena behind me", "n arena behind me"],
  ["At an aquarium, set the scene", "aquarium", "n aquarium"],
  ["Change The Background To An Arena", "arena", "n arena"],
  // Punctuation beside the setting.
  ["change the background to an arena.", "arena", "n arena"],
  ["change the background to an arena, please", "arena", "n arena"],
  ["(change the background to an arena)", "arena", "n arena"],
  ["set the scene at an airport", "airport", "n airport"],
  // More than one space, and whitespace that is not a space — main's tab case kept one letter.
  ["change the background to  an   arena", "arena", "n   arena"],
  [
    "change the background to   athletics track",
    "athletics track",
    "thletics track",
  ],
  ["change the background\tto\tan\tarena", "arena", "n"],
];

/** An article that IS a word still goes, and a hyphen does not end one. main routed these the same. */
const READ_RIGHT_ON_MAIN: [text: string, value: string][] = [
  ["change the background to a beach", "beach"],
  ["change the background to the arena", "arena"],
  ["change the background to a-frame cabin", "a-frame cabin"],
];

describe("WAVE-1 — rule 2's article ends at a word boundary, so a setting keeps its first letters", () => {
  it('the recorded repro routes the whole setting — main routed it as "n arena"', () => {
    expect(
      route("change the background to an arena", true).steps.map((s) => [
        s.op,
        s.targets,
        s.value,
      ]),
    ).toEqual([["CHANGE_BACKGROUND", ["person"], "arena"]]);
  });

  it("at the sentence's start, beside punctuation, and across more than one space or a tab", () => {
    expect(
      EATEN_ON_MAIN.map(([text]) => [
        text,
        route(text, true).steps.map((s) => [s.op, s.value]),
      ]),
    ).toEqual(
      EATEN_ON_MAIN.map(([text, value]) => [
        text,
        [["CHANGE_BACKGROUND", value]],
      ]),
    );
  });

  it("an article that is a word is still dropped, and a hyphenated setting is read whole — as on main", () => {
    expect(
      READ_RIGHT_ON_MAIN.map(([text]) => [
        text,
        route(text, true).steps.map((s) => [s.op, s.value]),
      ]),
    ).toEqual(
      READ_RIGHT_ON_MAIN.map(([text, value]) => [
        text,
        [["CHANGE_BACKGROUND", value]],
      ]),
    );
  });
});

// ─── REPLACE WITH REFERENCE, R.1 — a replacement she points at her photo for (2026-09-11) ─────────

/** Her Object photo attached — the Object tile. */
const ONE_PHOTO = { objects: 1 };

type PinnedStep = [EditOperation, string[], string | null, string | null];
const pinned = (steps: EditStep[]): PinnedStep[] =>
  steps.map((s) => [s.op, s.targets, s.value, s.reference ?? null]);

/**
 * Every sentence rule 3½ claims, as it routes with her Object photo attached, beside what main
 * (728357b) routed it as — recorded from the route() diff, not asserted here (main's classifier is not
 * in this tree). Every one ROUTED on main as a recolour or a brand change that dropped her pointer, or
 * ASKED. No correct route is on this list: that is the proof obligation, amended for this PR (Adi,
 * 2026-09-11), because the founder's own sentence was one of the misroutes.
 */
const CLAIMED_BY_REFERENCE = new Map<
  string,
  { steps: PinnedStep[]; main: string }
>([
  // The founder's sentence, Mia's verbatim (b), and the brief's four shapes.
  [
    "change my earrings to these gold hoops",
    {
      steps: [["REPLACE_OBJECT", ["earrings"], "gold hoops", "object"]],
      main: "RECOLOR [earrings] gold — hoops dropped, her photo never named",
    },
  ],
  [
    "change my earrings in the first picture to these gold hoops",
    {
      steps: [["REPLACE_OBJECT", ["earrings"], "gold hoops", "object"]],
      main: "RECOLOR [earrings] gold",
    },
  ],
  [
    "change my earrings to this gold hoop",
    {
      steps: [["REPLACE_OBJECT", ["earrings"], "gold hoop", "object"]],
      main: "RECOLOR [earrings] gold",
    },
  ],
  [
    "replace my earrings with these gold hoops",
    {
      steps: [["REPLACE_OBJECT", ["earrings"], "gold hoops", "object"]],
      main: "RECOLOR [earrings] gold",
    },
  ],
  [
    "change my earrings to the gold hoops in the second image",
    {
      steps: [["REPLACE_OBJECT", ["earrings"], "gold hoops", "object"]],
      main: "RECOLOR [earrings] gold",
    },
  ],
  [
    "change my earrings to these gold hoops from the second photo",
    {
      steps: [["REPLACE_OBJECT", ["earrings"], "gold hoops", "object"]],
      main: "RECOLOR [earrings] gold",
    },
  ],
  [
    "please change my earrings to these gold hoops.",
    {
      steps: [["REPLACE_OBJECT", ["earrings"], "gold hoops", "object"]],
      main: "RECOLOR [earrings] gold",
    },
  ],
  [
    "change my earrings to the hoops from the second photo",
    {
      steps: [["REPLACE_OBJECT", ["earrings"], "hoops", "object"]],
      main: "ASK fast_path_declined",
    },
  ],
  [
    "change the earrings to the ones from the attachment",
    {
      steps: [["REPLACE_OBJECT", ["earrings"], "earrings", "object"]],
      main: "ASK fast_path_declined",
    },
  ],
  // Only pointed: "this one", "this", "these" — her target's noun is the thing.
  [
    "change the soccer ball to this one",
    {
      steps: [["REPLACE_OBJECT", ["soccer ball"], "soccer ball", "object"]],
      main: "ASK fast_path_declined",
    },
  ],
  [
    "replace the soccer ball with this one",
    {
      steps: [["REPLACE_OBJECT", ["soccer ball"], "soccer ball", "object"]],
      main: "ASK fast_path_declined",
    },
  ],
  [
    "replace the ball with this",
    {
      steps: [["REPLACE_OBJECT", ["ball"], "ball", "object"]],
      main: "ASK fast_path_declined",
    },
  ],
  [
    "change the ball to that one",
    {
      steps: [["REPLACE_OBJECT", ["ball"], "ball", "object"]],
      main: "ASK fast_path_declined",
    },
  ],
  [
    "change the ball to the one in the second image",
    {
      steps: [["REPLACE_OBJECT", ["ball"], "ball", "object"]],
      main: "ASK fast_path_declined",
    },
  ],
  [
    "change my earrings to these",
    {
      steps: [["REPLACE_OBJECT", ["earrings"], "earrings", "object"]],
      main: "ASK fast_path_declined",
    },
  ],
  [
    "switch my earrings with these",
    {
      steps: [["REPLACE_OBJECT", ["earrings"], "earrings", "object"]],
      main: "ASK fast_path_declined",
    },
  ],
  // D2's measured same-class misroutes: swap…for, turn…into, make my X these Y, brand + pointer.
  [
    "swap my earrings for these gold hoops",
    {
      steps: [["REPLACE_OBJECT", ["earrings"], "gold hoops", "object"]],
      main: "RECOLOR [earrings] gold",
    },
  ],
  [
    "swap the ball for this one",
    {
      steps: [["REPLACE_OBJECT", ["ball"], "ball", "object"]],
      main: "ASK fast_path_declined",
    },
  ],
  [
    "turn my earrings into these gold hoops",
    {
      steps: [["REPLACE_OBJECT", ["earrings"], "gold hoops", "object"]],
      main: "RECOLOR [earrings] gold",
    },
  ],
  [
    "make my earrings these gold hoops",
    {
      steps: [["REPLACE_OBJECT", ["earrings"], "gold hoops", "object"]],
      main: 'RECOLOR ["earrings these"] gold — "these" inside the target',
    },
  ],
  [
    "change my cleats to these nike ones",
    {
      steps: [["REPLACE_OBJECT", ["cleats"], "nike cleats", "object"]],
      main: 'REPLACE [cleats] "nike cleats", dropped "these" — "not these specifically"',
    },
  ],
  [
    "change my jersey to this adidas one",
    {
      steps: [["REPLACE_OBJECT", ["jersey"], "adidas jersey", "object"]],
      main: 'REPLACE [jersey] "adidas jersey", dropped "this"',
    },
  ],
  [
    "change my nike cleats to these",
    {
      steps: [["REPLACE_OBJECT", ["nike cleats"], "cleats", "object"]],
      main: "ASK brand_change",
    },
  ],
  // The one deictic sentence already in the corpus (createAnythingLogic.test.ts).
  [
    "replace the bottle with these sneakers",
    {
      steps: [["REPLACE_OBJECT", ["bottle"], "sneakers", "object"]],
      main: "ASK fast_path_declined",
    },
  ],
]);

/**
 * Sentences that point at her photo in a way rule 3½ cannot read. They ASK, with a photo or without,
 * and never route with the pointer dropped. Main's routing beside each: three of them routed.
 */
const POINTER_UNREAD = new Map<string, string>([
  [
    "change my earrings to these gold hoops I bought",
    "RECOLOR [earrings] gold",
  ],
  [
    "change my socks and shoes to these nike ones",
    'REPLACE [socks] + [shoes] as nike, dropped "these"',
  ],
  [
    "change my jersey to this adidas design",
    'REPLACE [jersey] "adidas jersey", dropped "this", "design"',
  ],
  ["change my jersey to this design", "ASK fast_path_declined"],
  ["change my jersey to this logo", "ASK fast_path_declined"],
  ["change my socks to these colours", "ASK fast_path_declined"],
]);

/** Not rule 3½'s: no pointer, or another rule's sentence. Each routes exactly as it did on main. */
const NOT_POINTED = new Map<string, PinnedStep[]>([
  // Descriptions — the teaching copy's own example is here, and routes as what it says.
  ["make my earrings gold", [["RECOLOR", ["earrings"], "gold", null]]],
  [
    "change my earrings to gold hoops",
    [["RECOLOR", ["earrings"], "gold", null]],
  ],
  [
    "change my earrings to the gold hoops",
    [["RECOLOR", ["earrings"], "gold", null]],
  ],
  ["make my earrings gold hoops", [["RECOLOR", ["earrings"], "gold", null]]],
  [
    "change my necklace to a gold chain",
    [["RECOLOR", ["necklace"], "gold", null]],
  ],
  ["swap the cleats for white ones", [["RECOLOR", ["cleats"], "white", null]]],
  [
    "change the earrings in my ears to gold",
    [["RECOLOR", ["earrings"], "gold", null]],
  ],
  // A pointer that is not at a replacement: a place, a shoot, the whole photo, the background.
  [
    "put a water bottle next to this cone",
    [["ADD_OBJECT", ["water bottle"], "next to this cone", null]],
  ],
  [
    "change my socks to red for this shoot",
    [["RECOLOR", ["socks"], "red", null]],
  ],
  [
    "make this photo black and white",
    [["GLOBAL_STYLE", [], "black and white", null]],
  ],
  [
    "change the background to this one",
    [["CHANGE_BACKGROUND", ["person"], "this one", null]],
  ],
]);

describe("REPLACE WITH REFERENCE, R.1 — a replacement she points at her photo for routes with the photo, and asks without it", () => {
  it("routes every claimed sentence as ONE replacement marked for her photo, when one is attached", () => {
    for (const [text, { steps }] of CLAIMED_BY_REFERENCE) {
      const out = route(text, true, ONE_PHOTO);
      expect({ text, path: out.initialPath, steps: pinned(out.steps) }).toEqual(
        { text, path: "MASKED", steps },
      );
    }
  });

  it("ASKS for the photo on every one of them when none is attached — never a description in its place", () => {
    for (const text of CLAIMED_BY_REFERENCE.keys()) {
      for (const out of [
        route(text, true),
        route(text, true, { objects: 0 }),
      ]) {
        expect({ text, path: out.initialPath, reason: out.reason }).toEqual({
          text,
          path: "ASK",
          reason: "object_photo_missing",
        });
      }
    }
  });

  it("counts the photo, not its presence: two photos route too — which one is the thing is the freeze's to refuse", () => {
    expect(
      pinned(
        route("change my earrings to these gold hoops", true, { objects: 2 })
          .steps,
      ),
    ).toEqual([["REPLACE_OBJECT", ["earrings"], "gold hoops", "object"]]);
  });

  it("ASKS on a pointer it cannot read — with or without a photo — and never drops it", () => {
    for (const text of POINTER_UNREAD.keys()) {
      for (const attached of [{ objects: 0 }, ONE_PHOTO]) {
        const out = route(text, true, attached);
        expect({
          text,
          objects: attached.objects,
          path: out.initialPath,
        }).toEqual({
          text,
          objects: attached.objects,
          path: "ASK",
        });
        expect(out.reason).not.toBe("object_photo_missing");
      }
    }
  });

  it("leaves every sentence that does not point exactly as it routed — with or without a photo", () => {
    for (const [text, steps] of NOT_POINTED) {
      for (const attached of [{ objects: 0 }, ONE_PHOTO]) {
        expect({
          text,
          steps: pinned(route(text, true, attached).steps),
        }).toEqual({
          text,
          steps,
        });
      }
    }
  });

  it("refuses a replacement that names her with the person line, photo or not — no photo could change that answer", () => {
    for (const text of [
      "change my arm to this one",
      "change my face to this one",
      "change my hair to these braids",
      // The thing she points at names her: it goes INTO the photo where the earrings were.
      "change my earrings to these ears",
      "change the ball to this person",
    ]) {
      for (const attached of [{ objects: 0 }, ONE_PHOTO]) {
        const out = route(text, true, attached);
        expect({ text, reason: out.reason }).toEqual({
          text,
          reason: "person_target",
        });
      }
    }
  });

  it("composes a pointed replacement beside another change, and asks the whole sentence when the photo is missing", () => {
    const text = "change the soccer ball to this one and make her jersey blue";
    expect(pinned(route(text, true, ONE_PHOTO).steps)).toEqual([
      ["RECOLOR", ["jersey"], "blue", null],
      ["REPLACE_OBJECT", ["soccer ball"], "soccer ball", "object"],
    ]);
    expect(compoundClauses(text)).toEqual([
      "change the soccer ball to this one",
      "make her jersey blue",
    ]);
    expect(route(text, true).reason).toBe("object_photo_missing");
    // The recolour clause alone is untouched by the count.
    expect(route("make her jersey blue", true, ONE_PHOTO)).toEqual(
      route("make her jersey blue", true),
    );
  });

  it("reads what she points at as a thing a model can find in her photo", () => {
    expect(
      parseReplaceWithReference("change my earrings to these gold hoops"),
    ).toEqual({
      target: "earrings",
      thing: "gold hoops",
    });
    // "one"/"ones" and a bare pointer name her target's noun — a brand or a colour on it dropped.
    expect(
      parseReplaceWithReference("change the soccer ball to this one"),
    ).toEqual({
      target: "soccer ball",
      thing: "soccer ball",
    });
    expect(
      parseReplaceWithReference("change my cleats to these nike ones"),
    ).toEqual({
      target: "cleats",
      thing: "nike cleats",
    });
    expect(parseReplaceWithReference("change my nike cleats to these")).toEqual(
      {
        target: "nike cleats",
        thing: "cleats",
      },
    );
    // "first" is the frame, never the photo she attached.
    expect(
      parseReplaceWithReference(
        "change my earrings to the gold hoops in the first picture",
      ),
    ).toBeNull();
    // A description is not this rule's.
    expect(
      parseReplaceWithReference("change my earrings to gold hoops"),
    ).toBeNull();
  });

  it("classifies with nothing attached when the caller says nothing — the side that asks", () => {
    expect(route("change my earrings to these gold hoops", true)).toEqual(
      route("change my earrings to these gold hoops", true, { objects: 0 }),
    );
    // And a new image is still a new image: rule 0 comes first, photo or not.
    expect(
      route("change my earrings to these gold hoops", false, ONE_PHOTO).steps[0]
        .op,
    ).toBe("GENERATE");
  });
});

// ─── REPLACE WITH REFERENCE, R.4 — where on her a worn thing is, is its location (decision 2) ─────

describe("REPLACE WITH REFERENCE, R.4 — 'the earrings in my ears' is the earrings, and where they are", () => {
  /**
   * Main's route() beside each, recorded from the diff (not asserted — main's classifier is not in this
   * tree): the founder's shape routed as a gold recolour of the earrings; the others asked, or were a
   * recolour with her pointer dropped.
   */
  const LOCATED = new Map<string, { steps: PinnedStep[]; main: string }>([
    [
      "change the earrings in my ears to these gold hoops",
      {
        steps: [["REPLACE_OBJECT", ["earrings"], "gold hoops", "object"]],
        main: "RECOLOR [earrings] gold",
      },
    ],
    [
      "change the watch on my wrist to this one",
      {
        steps: [["REPLACE_OBJECT", ["watch"], "watch", "object"]],
        main: "ASK fast_path_declined",
      },
    ],
    [
      "change the chain around my neck to this one",
      {
        steps: [["REPLACE_OBJECT", ["chain"], "chain", "object"]],
        main: "ASK fast_path_declined",
      },
    ],
    [
      "change the necklace around my neck to this gold one",
      {
        steps: [["REPLACE_OBJECT", ["necklace"], "gold necklace", "object"]],
        main: "RECOLOR [necklace] gold",
      },
    ],
  ]);

  it("routes each as ONE replacement of the worn thing, with her photo — her ears, wrist and neck consumed", () => {
    for (const [text, { steps }] of LOCATED) {
      expect({
        text,
        steps: pinned(route(text, true, ONE_PHOTO).steps),
      }).toEqual({ text, steps });
    }
  });

  it("routes each exactly as its twin without the location — the phrase only says where", () => {
    const twin = (text: string) =>
      text.replace(/ (in|on|around) my (ears|wrist|neck)/, "");
    for (const text of LOCATED.keys()) {
      expect(twin(text)).not.toBe(text);
      expect({ text, steps: route(text, true, ONE_PHOTO).steps }).toEqual({
        text,
        steps: route(twin(text), true, ONE_PHOTO).steps,
      });
    }
  });

  it("asks for the photo on each when none is attached — like every pointed replacement", () => {
    for (const text of LOCATED.keys()) {
      expect({ text, reason: route(text, true).reason }).toEqual({
        text,
        reason: "object_photo_missing",
      });
    }
  });

  it("keeps the person guard's boundary: a thing that is not worn, her own ears, and ears as the thing all ask", () => {
    const table: [string, string][] = [
      // Not on WORN_ITEMS: "on my arm" is not consumed, so it is not read, and asks as on main.
      ["change the tattoo on my arm to this one", "fast_path_declined"],
      // A worn thing placed somewhere that is NOT her is not located on her: "on the table" says WHICH
      // watch, and consuming it could replace the one on her wrist instead. It asks.
      ["change the watch on the table to this one", "fast_path_declined"],
      // No worn thing before the place — her ears ARE the target.
      ["change my ears to these gold hoops", "person_target"],
      // The location consumed, and what she points at names her: it goes into the photo where the
      // earrings were.
      ["change the earrings in my ears to these ears", "person_target"],
    ];
    for (const [text, reason] of table) {
      for (const attached of [{ objects: 0 }, ONE_PHOTO]) {
        const out = route(text, true, attached);
        expect({ text, path: out.initialPath, reason: out.reason }).toEqual({
          text,
          path: "ASK",
          reason,
        });
      }
    }
  });
});

// ─── I.0 — a demonstrative is never a brand change's item; rule 4c only turns a misroute into an ASK ─

/**
 * Every sentence the I.0 probe diff moved — main (d90efda) against this branch, each with no Object photo
 * and with one, the same answer both ways. Each ROUTED on main with a demonstrative read as the item or
 * as part of one, and each asks now. The value is main's step, recorded from that diff. None of them is
 * in the corpus: the corpus diff (3,497 strings × photo × Object-photo count) moved nothing until these
 * pins were added.
 */
const ASKS_SINCE_I0 = new Map<string, string>([
  // The demonstrative as the whole item.
  [
    "turn this into an adidas ad",
    'REPLACE ["this"] "adidas this", "ad" dropped',
  ],
  ["turn this into a nike ad", 'REPLACE ["this"] "nike this", "ad" dropped'],
  ["make this a nike ad", 'REPLACE ["this"] "nike this", "ad" dropped'],
  [
    "change this to an adidas ad",
    'REPLACE ["this"] "adidas this", "ad" dropped',
  ],
  [
    "turn this into an adidas poster",
    'REPLACE ["this"] "adidas this", "poster" dropped',
  ],
  [
    "turn this into an adidas campaign",
    'REPLACE ["this"] "adidas this", "campaign" dropped',
  ],
  ["switch this to adidas", 'REPLACE ["this"] "adidas this"'],
  ["turn this into adidas", 'REPLACE ["this"] "adidas this"'],
  ["change this to adidas", 'REPLACE ["this"] "adidas this"'],
  ["please change this to adidas", 'REPLACE ["this"] "adidas this"'],
  ["make this nike", 'REPLACE ["this"] "nike this"'],
  ["swap this for nike", 'REPLACE ["this"] "nike this"'],
  ["make this a blue adidas kit", 'REPLACE ["this"] "blue adidas this"'],
  ["change this to a black adidas one", 'REPLACE ["this"] "black adidas this"'],
  ["change these to nike", 'REPLACE ["these"] "nike these"'],
  ["change both these to nike", 'REPLACE ["these"] "nike these"'],
  ["change these all to adidas", 'REPLACE ["these"] "adidas these"'],
  ["turn these into adidas ones", 'REPLACE ["these"] "adidas these"'],
  ["make those adidas", 'REPLACE ["those"] "adidas those"'],
  ["switch those for puma", 'REPLACE ["those"] "puma those"'],
  // The demonstrative leading the item.
  [
    "change this jersey to adidas",
    'REPLACE ["this jersey"] "adidas this jersey"',
  ],
  ["make these socks nike", 'REPLACE ["these socks"] "nike these socks"'],
  [
    "swap those cleats for adidas",
    'REPLACE ["those cleats"] "adidas those cleats"',
  ],
  [
    "make these cleats pink adidas",
    'REPLACE ["these cleats"] "pink adidas these cleats"',
  ],
  [
    "change these shoes to nike ones",
    'REPLACE ["these shoes"] "nike these shoes"',
  ],
  // A demonstrative in the list, or after the item.
  [
    "change my socks and these to adidas",
    'REPLACE [socks] + REPLACE ["these"] "adidas these"',
  ],
  [
    "change my socks and those shoes to nike",
    'REPLACE [socks] + REPLACE ["those shoes"] "nike those shoes"',
  ],
  [
    "change my jersey, this and my socks to nike",
    'REPLACE [jersey] + REPLACE ["this"] "nike this" + REPLACE [socks]',
  ],
  [
    "change my jersey this time to adidas",
    'REPLACE ["jersey this time"] "adidas jersey this time"',
  ],
  // Composed beside another change — the clause is read by rule 4c on its own, so it routed too.
  [
    "turn this into an adidas ad and make my socks blue",
    'RECOLOR [socks] + REPLACE ["this"] "adidas this"',
  ],
  [
    "make my socks blue and change this to adidas",
    'RECOLOR [socks] + REPLACE ["this"] "adidas this"',
  ],
  [
    "remove the ball and turn this into a nike ad",
    'REMOVE [ball] + REPLACE ["this"] "nike this"',
  ],
]);

describe("I.0 — a demonstrative is never a brand change's item, so the sentence asks instead of replacing 'this'", () => {
  it("every sentence the probe diff moved asks now, with brand_change's code — photo attached or not", () => {
    for (const text of ASKS_SINCE_I0.keys()) {
      for (const objects of [0, 1]) {
        const out = route(text, true, { objects });
        expect({
          text,
          objects,
          path: out.initialPath,
          reason: out.reason,
          steps: out.steps,
        }).toEqual({
          text,
          objects,
          path: "ASK",
          reason: "brand_change",
          steps: [],
        });
      }
    }
  });

  it("rule 4c's own parse reads none of the single-change ones — the item reader stops at the demonstrative", () => {
    for (const text of ASKS_SINCE_I0.keys()) {
      if (splitClauses(text).length > 1) continue;
      expect({ text, parsed: parseBrandChange(text) }).toEqual({
        text,
        parsed: null,
      });
    }
  });

  it("a brand change whose items are things she named routes exactly as main did, step for step", () => {
    // main's own output, recorded from base d90efda.
    const table: [
      string,
      [string, string[], string | null, string[] | null][],
    ][] = [
      [
        "change my jersey to adidas",
        [["REPLACE_OBJECT", ["jersey"], "adidas jersey", null]],
      ],
      [
        "make my socks nike",
        [["REPLACE_OBJECT", ["socks"], "nike socks", null]],
      ],
      [
        "change my nike jersey to adidas",
        [["REPLACE_OBJECT", ["nike jersey"], "adidas jersey", null]],
      ],
      [
        "make my jersey a blue adidas kit",
        [["REPLACE_OBJECT", ["jersey"], "blue adidas jersey", null]],
      ],
      [
        "change my uniform to a black adidas uniform",
        [["REPLACE_OBJECT", ["uniform"], "black adidas uniform", null]],
      ],
      [
        "change my uniform, socks, and shoes all to be adidas",
        [
          ["REPLACE_OBJECT", ["uniform"], "adidas uniform", null],
          ["REPLACE_OBJECT", ["socks"], "adidas socks", null],
          ["REPLACE_OBJECT", ["shoes"], "adidas shoes", null],
        ],
      ],
      [
        "swap the cleats for Nike Mercurials",
        [["REPLACE_OBJECT", ["cleats"], "nike cleats", ["mercurials"]]],
      ],
      // A demonstrative AFTER the link is the value side, not an item — dropped and disclosed there
      // (B.1c), as on main. Not this change's; recorded in the PR as known remaining.
      [
        "switch my cleats for nike like these",
        [["REPLACE_OBJECT", ["cleats"], "nike cleats", ["like", "these"]]],
      ],
    ];
    for (const [text, steps] of table) {
      expect({
        text,
        steps: route(text, true).steps.map((s) => [
          s.op,
          s.targets,
          s.value,
          s.dropped ?? null,
        ]),
      }).toEqual({ text, steps });
    }
  });

  it("what a demonstrative means to the other rules is untouched — her photo, an add's thing, a shoot, the whole picture", () => {
    // Rule 3½: it points at her Object photo.
    for (const [text, target, value] of [
      ["change my cleats to these nike ones", "cleats", "nike cleats"],
      ["change the soccer ball to this one", "soccer ball", "soccer ball"],
      ["make my earrings these gold hoops", "earrings", "gold hoops"],
    ] as const) {
      expect({ text, steps: route(text, true, ONE_PHOTO).steps }).toEqual({
        text,
        steps: [
          {
            op: "REPLACE_OBJECT",
            targets: [target],
            value,
            scope: "REGION",
            reference: "object",
          },
        ],
      });
    }
    // Rule 4½: a determiner on the thing she adds. Rules 5 and 3: the shoot, the whole photo.
    expect(
      route("add this ball on the bench", true).steps.map((s) => [
        s.op,
        s.targets,
        s.value,
      ]),
    ).toEqual([["ADD_OBJECT", ["ball", "bench"], "on the bench"]]);
    expect(
      route("make the socks red for this shoot", true).steps.map((s) => [
        s.op,
        s.targets,
        s.value,
      ]),
    ).toEqual([["RECOLOR", ["socks"], "red"]]);
    expect(
      route("make this photo black and white", true).steps.map((s) => [
        s.op,
        s.value,
      ]),
    ).toEqual([["GLOBAL_STYLE", "black and white"]]);
  });

  it("'that' never was an item — it has always ended a phrase — and still asks", () => {
    const out = route("turn that jersey into an adidas one", true);
    expect([out.initialPath, out.reason]).toEqual(["ASK", "brand_change"]);
  });
});

// ─── PR M3 (worn adds) — a worn place, read back for the compile tier ────────────────────────────

describe("wornLocationOf — the part of her a frozen add puts its thing on, read with the classifier's own reading (PR M3)", () => {
  it("reads a place that is one onto-her preposition, then a part of her a worn thing goes on", () => {
    const table: [string, string][] = [
      ["to my ears", "ears"],
      ["in my left ear", "ear"],
      ["around my neck", "neck"],
      ["on my left wrist", "wrist"],
      ["on her finger", "finger"],
      ["in my hair", "hair"],
      ["onto her head", "head"],
      ["through my ears", "ears"],
      // Pierced jewelry, M3.9: a ring or a stud is worn in her nose.
      ["in my nose", "nose"],
    ];
    for (const [place, location] of table) {
      expect({ place, at: wornLocationOf(place) }).toEqual({
        place,
        at: location,
      });
    }
  });

  it("is null for every place an add already routed with — so their wording cannot move", () => {
    for (const place of [
      // Spatial: near her, not on her (Q1's measured places).
      "at her feet",
      "on top of her head",
      "between her cleats",
      "next to her",
      "in the middle of my cleats",
      "on the grass beside her right foot",
      // Her, but no part of her.
      "on me",
      "to her",
      // A surface that is not her.
      "on the grass",
      "into the net",
      // A part of her no worn thing goes on (the nose was one until M3.9), and a possessive not hers.
      "to my lip",
      "on my feet",
      "on the statue's head",
    ]) {
      expect({ place, at: wornLocationOf(place) }).toEqual({ place, at: null });
    }
  });
});

// ─── PR M3 — rule 3¾b: a thing she wears, added onto a part of her it is worn on ─────────────────

describe("RULE 3¾b — a thing she wears, added onto a part of her it is worn on, is one ADD_OBJECT of the thing (PR M3, Mia's M3)", () => {
  /** Each step as [op, targets, value]. */
  const steps = (text: string) =>
    route(text, true).steps.map((s) => [s.op, s.targets, s.value]);

  it("routes founder sentence 3 and Mia's 'can you' phrasing — the thing the only target, her place its value", () => {
    const table: [string, [string, string[], string | null][]][] = [
      [
        "add these gold hoops to my ears",
        [["ADD_OBJECT", ["gold hoops"], "to my ears"]],
      ],
      [
        "can you add these earrings to my ears",
        [["ADD_OBJECT", ["earrings"], "to my ears"]],
      ],
      [
        "could you put a watch on my wrist please",
        [["ADD_OBJECT", ["watch"], "on my wrist"]],
      ],
      [
        "would you please add a gold chain around my neck?",
        [["ADD_OBJECT", ["gold chain"], "around my neck"]],
      ],
      [
        "please add a silver ring to my ring finger",
        [["ADD_OBJECT", ["silver ring"], "to my ring finger"]],
      ],
      [
        "put an anklet on my left ankle",
        [["ADD_OBJECT", ["anklet"], "on my left ankle"]],
      ],
      [
        "stick a pink scrunchie in my hair",
        [["ADD_OBJECT", ["pink scrunchie"], "in my hair"]],
      ],
      // Where the thing comes from, before or after the place: the attachment's, and dropped.
      [
        "add the earrings from the second image to my ears",
        [["ADD_OBJECT", ["earrings"], "to my ears"]],
      ],
      [
        "put the hoops in my ears from the second image",
        [["ADD_OBJECT", ["hoops"], "in my ears"]],
      ],
    ];
    for (const [text, expected] of table) {
      expect({ text, steps: steps(text) }).toEqual({ text, steps: expected });
      // An Object photo decides what the thing looks like, not whether it routes (nativeIntent.test.ts).
      expect(route(text, true, { objects: 1 })).toEqual(route(text, true));
    }
  });

  it("hands the guard the thing and never her place — where rule 4½ would hand it her ears", () => {
    const text = "add these gold hoops to my ears";
    // Rule 4½'s reading of the same words makes her ears a surface, which the guard refuses. That is the
    // reading D1 lived on; rule 3¾b comes first, and its only target is the hoops.
    expect(parseAddObject(text)?.surfaces).toEqual(["ears"]);
    expect(parseWornAdd(text)).toEqual({
      thing: "gold hoops",
      place: "to my ears",
    });
    expect(route(text, true).steps[0]?.targets).toEqual(["gold hoops"]);
    expect(namesPerson("gold hoops")).toBe(false);
  });

  it("reads a lone pronoun as her, and the thing goes where it is worn", () => {
    expect(steps("put these earrings on me")).toEqual([
      ["ADD_OBJECT", ["earrings"], "on me"],
    ]);
    expect(steps("add a watch to her")).toEqual([
      ["ADD_OBJECT", ["watch"], "to her"],
    ]);
  });

  it("ASKS with the person line when the place is not the thing's own (N5) — a piercing Mia has not opened never routes", () => {
    // A ring is worn on a finger, a stud in an ear — and since M3.9 either in a nose, the one piercing Mia
    // opened (its pins are in the M3.9 block; "add a ring to my nose" and "put a stud in my nose" were
    // here until then). On her lip, eyebrow or navel it is still a piercing no worn thing's places hold,
    // and only a ring or a stud goes in a nose. The same things on the wrong part of her ask too.
    const table: [string, string][] = [
      // The polite form is refused as the plain one is (M3.6; pinned on the nose until M3.9 opened it).
      ["can you put a stud through my eyebrow", "person_mentioned"],
      ["put a hoop in my nose", "person_mentioned"],
      ["add a nose ring to my nose", "person_target"],
      ["add a ring to my lip", "person_target"],
      ["put a stud through my eyebrow", "person_mentioned"],
      ["add a ring in my belly button", "person_mentioned"],
      ["put earrings on my lips", "person_target"],
      ["add a necklace to my wrist", "person_target"],
      ["put a watch on my neck", "person_target"],
      ["add gloves to my feet", "person_target"],
    ];
    for (const [text, reason] of table) {
      const out = route(text, true);
      expect({
        text,
        parsed: parseWornAdd(text),
        path: out.initialPath,
        reason: out.reason,
      }).toEqual({
        text,
        parsed: null,
        path: "ASK",
        reason,
      });
    }
  });

  it("declines anything else in the thing, or after the place — and the sentence asks (its code: the M3.8 block)", () => {
    for (const text of [
      // A word beside the thing that is not a descriptor or a brand: a body word, a body modification, a size.
      "add a nose ring to my finger",
      "add a tattoo choker to my neck",
      "add small gold hoops to my ears",
      // Two brands, or a thing too long to be a name.
      "add a nike adidas headband to my head",
      "add a large gold hoop earring to my ear",
      // Not an add verb leading the sentence.
      "give me gold hoops",
      "i want gold hoops in my ears",
    ]) {
      expect({ text, parsed: parseWornAdd(text) }).toEqual({
        text,
        parsed: null,
      });
      expect({ text, path: route(text, true).initialPath }).toEqual({
        text,
        path: "ASK",
      });
    }
    // Something left over — her keep. The parse still declines it; `route` sets her keep aside, and what is
    // left is this rule's sentence (ledger F-L5, the preservation fixes: it asked `person_target` until then).
    const kept = "add gold hoops to my ears, keep everything else the same";
    expect(parseWornAdd(kept)).toBeNull();
    expect(route(kept, true).steps.map((s) => [s.op, s.targets])).toEqual([
      ["ADD_OBJECT", ["gold hoops"]],
    ]);
  });

  it("reads nothing that is not onto her — every add rule 4½ routed routes exactly as it did", () => {
    for (const [text, expected] of [
      [
        "put my earrings on the table",
        [["ADD_OBJECT", ["earrings", "table"], "on the table"]],
      ],
      [
        "put the earrings next to her",
        [["ADD_OBJECT", ["earrings"], "next to her"]],
      ],
      [
        "put a watch on the bench",
        [["ADD_OBJECT", ["watch", "bench"], "on the bench"]],
      ],
      [
        "place the water bottle from the second image on top of her head",
        [["ADD_OBJECT", ["water bottle"], "on top of her head"]],
      ],
    ] as [string, [string, string[], string | null][]][]) {
      expect({ text, parsed: parseWornAdd(text) }).toEqual({
        text,
        parsed: null,
      });
      expect({ text, steps: steps(text) }).toEqual({ text, steps: expected });
    }
    // A design on a worn thing is still rule 4a's: the headband is the target, the logo the value.
    expect(steps("put a nike logo on my headband")).toEqual([
      ["APPLY_DESIGN", ["headband"], "nike logo"],
    ]);
  });
});

describe("PR M3, N6 — headwear and eyewear are worn: onto her head or face they route, and where they are is their location", () => {
  /** Each step as [op, targets, value]. */
  const steps = (text: string) =>
    route(text, true).steps.map((s) => [s.op, s.targets, s.value]);

  it("routes a hat, a cap, a helmet or sunglasses onto the part of her they are worn on", () => {
    const table: [string, [string, string[], string | null][]][] = [
      ["put a hat on my head", [["ADD_OBJECT", ["hat"], "on my head"]]],
      ["add a beanie to my head", [["ADD_OBJECT", ["beanie"], "to my head"]]],
      ["put a visor on her head", [["ADD_OBJECT", ["visor"], "on her head"]]],
      ["put a helmet on my head", [["ADD_OBJECT", ["helmet"], "on my head"]]],
      [
        "add a red bandana to my head",
        [["ADD_OBJECT", ["red bandana"], "to my head"]],
      ],
      [
        "put sunglasses on my face",
        [["ADD_OBJECT", ["sunglasses"], "on my face"]],
      ],
      [
        "put black sunglasses on my head",
        [["ADD_OBJECT", ["black sunglasses"], "on my head"]],
      ],
      ["add glasses to my eyes", [["ADD_OBJECT", ["glasses"], "to my eyes"]]],
      ["put goggles on my face", [["ADD_OBJECT", ["goggles"], "on my face"]]],
      ["put a hat on me", [["ADD_OBJECT", ["hat"], "on me"]]],
    ];
    for (const [text, expected] of table) {
      expect({ text, steps: steps(text) }).toEqual({ text, steps: expected });
    }
  });

  it("reads 'put an adidas cap on my head' as a cap — rule 3¾b runs before rule 4, which read a design on her head", () => {
    // On bccaf2b rule 4a split it as APPLY_DESIGN [head] "adidas cap", and the guard refused her head.
    expect(steps("put an adidas cap on my head")).toEqual([
      ["ADD_OBJECT", ["adidas cap"], "on my head"],
    ]);
    expect(steps("can you put a nike hat on my head")).toEqual([
      ["ADD_OBJECT", ["nike hat"], "on my head"],
    ]);
  });

  it("asks when the place is not the thing's own — a hat on her face, sunglasses in her ears", () => {
    for (const [text, reason] of [
      ["put a hat on my face", "person_target"],
      ["put sunglasses on my ears", "person_target"],
      ["add a cap to my arm", "person_target"],
      ["put a cap in my hair", "person_mentioned"],
    ]) {
      const out = route(text, true);
      expect({ text, path: out.initialPath, reason: out.reason }).toEqual({
        text,
        path: "ASK",
        reason,
      });
    }
  });

  it("keeps a crown, a tiara, a mask and shades off the list (N6) — onto her they ask with the person line", () => {
    for (const text of [
      "add a crown on my head",
      "put a tiara on my head",
      "put a mask on my face",
      "put shades on my face",
    ]) {
      expect({ text, reason: route(text, true).reason }).toEqual({
        text,
        reason: "person_target",
      });
    }
  });

  it("reads where headwear and eyewear are as their location, everywhere decision 2 reads it (C-9)", () => {
    // Each asked on bccaf2b (her head or face a second target) and routes now exactly as its twin
    // without the location does: a change to the hat, never to her.
    const twins: [string, string, [string, string[], string | null][]][] = [
      [
        "change the hat on my head to red",
        "change the hat to red",
        [["RECOLOR", ["hat"], "red"]],
      ],
      [
        "change the sunglasses on my face to black",
        "change the sunglasses to black",
        [["RECOLOR", ["sunglasses"], "black"]],
      ],
      [
        "remove the cap from my head",
        "remove the cap",
        [["REMOVE_OBJECT", ["cap"], null]],
      ],
      [
        "add a logo to the cap on my head",
        "add a logo to the cap",
        [["APPLY_DESIGN", ["cap"], "logo"]],
      ],
    ];
    for (const [text, twin, expected] of twins) {
      expect({ text, steps: steps(text) }).toEqual({ text, steps: expected });
      expect({ text, steps: steps(text) }).toEqual({
        text,
        steps: steps(twin),
      });
    }
    // A crown is not worn, so her head stays a target and the guard refuses it.
    expect(route("change the crown on my head to red", true).reason).toBe(
      "person_target",
    );
  });
});

describe("PR M3 — a body modification asks with the person line, placed or not (BODY_MODS)", () => {
  it("gives a placeless one the person line — never 'say where it goes', never the catch-all", () => {
    // On bccaf2b: add_unclear ("To add something, say what it is and where it goes"), or
    // fast_path_declined for "give". Each is a change to her body, and no rephrasing makes it one Studio
    // does.
    for (const text of [
      "add a tattoo",
      "add muscles",
      "add abs",
      "give me abs",
      "add a scar",
      "add freckles",
      "add a six pack",
      "give me a six-pack",
      "add some wrinkles",
      "add a mole",
      "add a birthmark",
      "add a piercing",
      "give me bigger muscles",
      "can you add a tattoo",
      "add a nike tattoo",
    ]) {
      const out = route(text, true);
      expect({ text, path: out.initialPath, reason: out.reason }).toEqual({
        text,
        path: "ASK",
        reason: "person_mentioned",
      });
    }
  });

  it("gives it to the clause inside a compound too — the clause's own code wins (d1)", () => {
    expect(route("add a tattoo and make the socks blue", true).reason).toBe(
      "person_mentioned",
    );
  });

  it("leaves a placed one on the guard's own code — it named her, and the guard refused her", () => {
    for (const text of [
      "add a tattoo on my arm",
      "add muscles to my arms",
      "add a scar to my face",
      "add abs to my stomach",
      "add freckles to my face",
    ]) {
      expect({ text, reason: route(text, true).reason }).toEqual({
        text,
        reason: "person_target",
      });
    }
  });

  it("keeps add_unclear for a placeless add of a thing — a ball is not her body", () => {
    // "add gold hoop earrings" stood here beside the ball until wave A's V2: a worn thing with no place asks for its
    // unread word (worn_add_unclear) — still not the person line.
    expect(
      ["add a soccer ball", "add gold hoop earrings"].map((text) => [
        text,
        route(text, true).reason,
      ]),
    ).toEqual([
      ["add a soccer ball", "add_unclear"],
      ["add gold hoop earrings", "worn_add_unclear"],
    ]);
  });
});

describe("PR M3 — a worn place says WHICH part of her, never what her body is like", () => {
  it("routes a side or a finger before the place — left, right, both, upper, ring", () => {
    for (const [text, expected] of [
      [
        "add a gold hoop to my left ear",
        [["ADD_OBJECT", ["gold hoop"], "to my left ear"]],
      ],
      [
        "put a watch on my right wrist",
        [["ADD_OBJECT", ["watch"], "on my right wrist"]],
      ],
      [
        "put a bracelet on my upper arm",
        [["ADD_OBJECT", ["bracelet"], "on my upper arm"]],
      ],
      ["put rings on both hands", [["ADD_OBJECT", ["rings"], "on both hands"]]],
      [
        "add a ring to my left ring finger",
        [["ADD_OBJECT", ["ring"], "to my left ring finger"]],
      ],
    ] as [string, [string, string[], string | null][]][]) {
      expect({
        text,
        steps: route(text, true).steps.map((s) => [s.op, s.targets, s.value]),
      }).toEqual({ text, steps: expected });
    }
  });

  it("declines a word that describes her body there — the compiled place would ask the model for it — and the guard refuses", () => {
    // "worn on the person's tattooed wrist" would be a body edit riding in on a worn add.
    for (const text of [
      "put a watch on my tattooed wrist",
      "put a hat on my bald head",
      "add earrings to my pierced ears",
      "put a ring on my swollen finger",
      "put a hat on the statue's head",
    ]) {
      const out = route(text, true);
      expect({
        text,
        parsed: parseWornAdd(text),
        path: out.initialPath,
        reason: out.reason,
      }).toEqual({ text, parsed: null, path: "ASK", reason: "person_target" });
    }
    // The compile tier reads places the same way, so it could not word one as worn either.
    expect(wornLocationOf("on my tattooed wrist")).toBeNull();
    expect(wornLocationOf("on my left wrist")).toBe("wrist");
  });
});

describe("PR M3.8 — a worn add it could not read asks worn_add_unclear, never the person line", () => {
  it("gives 'small gold hoops' and 'a baseball cap' their own line — the plain sentence routes, so 'we don't edit people' would be false", () => {
    for (const text of [
      "add small gold hoops to my ears",
      "put a baseball cap on my head",
      // The same class: a word beside the thing, two brands, a fourth word, another preposition, a
      // polite form, a pronoun place, a brand beside the unread word.
      "add gold hoop earrings to my ears",
      "add a pearl necklace around my neck",
      "add a nike adidas headband to my head",
      "add a large gold hoop earring to my ear",
      "put small gold hoops in my ears",
      "can you put a baseball cap on my head",
      "put a baseball cap on me",
      "put a nike baseball cap on my head",
    ]) {
      const out = route(text, true);
      expect({
        text,
        path: out.initialPath,
        steps: out.steps,
        reason: out.reason,
      }).toEqual({
        text,
        path: "ASK",
        steps: [],
        reason: "worn_add_unclear",
      });
    }
    // Said plainly, each routes — which is what the line tells her.
    for (const text of ["add gold hoops to my ears", "put a cap on my head"]) {
      expect({ text, path: route(text, true).initialPath }).toEqual({
        text,
        path: "FULL_IMAGE",
      });
    }
  });

  it("gives it to the clause inside a compound too — the clause's own code wins (d1)", () => {
    expect(
      route("add small gold hoops to my ears and make the socks blue", true)
        .reason,
    ).toBe("worn_add_unclear");
  });

  it("keeps every person case exactly as it was — a piercing, a wrong place, her body in the place or the thing", () => {
    const table: [string, string][] = [
      // A piercing place Mia has not opened, and a worn thing on the wrong part of her (N5). (A ring or a
      // stud in her nose was here until M3.9 opened it; hoops in her nose are still not.)
      ["add a ring to my lip", "person_target"],
      ["put a stud through my eyebrow", "person_mentioned"],
      ["add small gold hoops to my nose", "person_target"],
      ["put a watch on my neck", "person_target"],
      ["put a cap in my hair", "person_mentioned"],
      // A place that describes her body (M3.7).
      ["put a watch on my tattooed wrist", "person_target"],
      ["add earrings to my pierced ears", "person_target"],
      // A thing named after a part of her, or a body modification.
      ["add a nose ring to my finger", "person_target"],
      ["add a tattoo choker to my neck", "person_target"],
      // Body modification, placed and placeless (M3.4).
      ["add a tattoo on my arm", "person_target"],
      ["add a tattoo", "person_mentioned"],
      ["add muscles", "person_mentioned"],
    ];
    for (const [text, reason] of table) {
      expect({ text, reason: route(text, true).reason }).toEqual({
        text,
        reason,
      });
    }
  });

  it("leaves words after the place to the rules below, as before — they can carry a second change", () => {
    // Known remaining (PR M3's body): rule 5 reads "gold" as a recolour of her ears here and the guard
    // refuses it — still true of the WHOLE sentence. Changed on purpose by the preservation fixes (ledger
    // F-L5): the refusal came from her keep, so `route` sets it aside and the worn add routes beside it.
    const text = "add gold hoops to my ears, keep everything else the same";
    const whole = classifyFast(text, true);
    expect(whole && validate(whole, true, text).reason).toBe("person_target");
    const routed = route(text, true);
    expect(routed.steps.map((s) => [s.op, s.targets, s.value])).toEqual([
      ["ADD_OBJECT", ["gold hoops"], "to my ears"],
    ]);
    expect(routed.constraints).toEqual([{ kind: "preserve_person" }]);
  });
});

describe("PR M3.9 — pierced jewelry in her nose: a ring or a stud routes as a worn add (Mia opened it)", () => {
  /** Each step as [op, targets, value]. */
  const steps = (text: string) =>
    route(text, true).steps.map((s) => [s.op, s.targets, s.value]);

  it("routes a ring or a stud in her nose — the thing the only target, her nose where it is worn", () => {
    // Each asked with the person line until M3.9: the nose was no place a ring or a stud is worn.
    const table: [string, [string, string[], string | null][]][] = [
      ["add a ring to my nose", [["ADD_OBJECT", ["ring"], "to my nose"]]],
      ["put a stud in my nose", [["ADD_OBJECT", ["stud"], "in my nose"]]],
      [
        "can you put a ring in my nose",
        [["ADD_OBJECT", ["ring"], "in my nose"]],
      ],
      [
        "add a gold ring to my nose",
        [["ADD_OBJECT", ["gold ring"], "to my nose"]],
      ],
      [
        "add a nike stud to my nose",
        [["ADD_OBJECT", ["nike stud"], "to my nose"]],
      ],
      [
        "make the socks blue and add a ring to my nose",
        [
          ["RECOLOR", ["socks"], "blue"],
          ["ADD_OBJECT", ["ring"], "to my nose"],
        ],
      ],
    ];
    for (const [text, expected] of table) {
      expect({ text, steps: steps(text) }).toEqual({ text, steps: expected });
      // Her Object photo is the ring; it decides what the ring looks like, never whether it routes.
      expect(route(text, true, { objects: 1 })).toEqual(route(text, true));
    }
  });

  it("opens only the nose, and only for a ring or a stud — every other piercing still asks with the person line", () => {
    const table: [string, string][] = [
      // Other piercing places.
      ["add a ring to my lip", "person_target"],
      ["put a stud through my eyebrow", "person_mentioned"],
      ["add a ring in my belly button", "person_mentioned"],
      // Other worn things in her nose — a hoop or an earring is not opened.
      ["put a hoop in my nose", "person_mentioned"],
      ["add earrings to my nose", "person_target"],
      ["add small gold hoops to my nose", "person_target"],
      // A piercing itself is a body modification, wherever it goes.
      ["add a piercing to my nose", "person_target"],
      // Known remaining (Adi's call): the thing named after her nose is not read, and keeps the line.
      ["add a nose ring to my nose", "person_target"],
    ];
    for (const [text, reason] of table) {
      const out = route(text, true);
      expect({ text, path: out.initialPath, reason: out.reason }).toEqual({
        text,
        path: "ASK",
        reason,
      });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// PR T — THE TEXT OP (DISPLAY_TEXT): a headline on her photo, in one strict shape, behind its own switch
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** The switch as the rest of this file found it, put back after every test that flips it. */
const DISPLAY_TEXT_ENV = process.env.STUDIO_DISPLAY_TEXT;
const restoreDisplayText = () => {
  if (DISPLAY_TEXT_ENV === undefined) delete process.env.STUDIO_DISPLAY_TEXT;
  else process.env.STUDIO_DISPLAY_TEXT = DISPLAY_TEXT_ENV;
};

describe("PR T, T.4 — STUDIO_DISPLAY_TEXT is its own switch, and it is OFF unless it says exactly 'true' (N4)", () => {
  afterEach(restoreDisplayText);

  it("is off when unset, and for every value but 'true' — and the native switch does not turn it on", () => {
    delete process.env.STUDIO_DISPLAY_TEXT;
    expect(displayTextEnabled()).toBe(false);
    for (const v of ["", "1", "TRUE", "True", "yes", "on", "false"]) {
      process.env.STUDIO_DISPLAY_TEXT = v;
      expect({ v, on: displayTextEnabled() }).toEqual({ v, on: false });
    }
    delete process.env.STUDIO_DISPLAY_TEXT;
    const native = process.env.STUDIO_NATIVE_EDIT;
    process.env.STUDIO_NATIVE_EDIT = "true";
    expect(displayTextEnabled()).toBe(false);
    if (native === undefined) delete process.env.STUDIO_NATIVE_EDIT;
    else process.env.STUDIO_NATIVE_EDIT = native;
    process.env.STUDIO_DISPLAY_TEXT = "true";
    expect(displayTextEnabled()).toBe(true);
  });

  it("is read at call time, never captured at load — flipping it back needs no restart", () => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
    expect(displayTextEnabled()).toBe(true);
    delete process.env.STUDIO_DISPLAY_TEXT;
    expect(displayTextEnabled()).toBe(false);
  });
});

// ─── PR T, T.1 — rule ⅛: the one headline shape, read only with the switch on ────────────────────

/** The acceptance sentence (Adi previews it live), and the plan's card line in her words. */
const HEADLINE = 'add the headline "OWN THE MOMENT" across the top';

/** What route() answers with the switch in each state — the one variable these tests move. */
function routeWith(on: boolean, text: string, photo = true) {
  if (on) process.env.STUDIO_DISPLAY_TEXT = "true";
  else delete process.env.STUDIO_DISPLAY_TEXT;
  try {
    return route(text, photo);
  } finally {
    restoreDisplayText();
  }
}

type TextPin = [EditOperation, string[], string | null, string];
const textPins = (steps: EditStep[]): TextPin[] =>
  steps.map((s) => [s.op, s.targets, s.value, s.scope]);

describe("PR T, T.1 — rule ⅛ reads ONE strict shape, only behind STUDIO_DISPLAY_TEXT", () => {
  afterEach(restoreDisplayText);

  it("routes the acceptance sentence as ONE headline with the switch on — and off, asks exactly as main did", () => {
    const on = routeWith(true, HEADLINE);
    expect({
      path: on.initialPath,
      reason: on.reason,
      steps: textPins(on.steps),
    }).toEqual({
      path: "FULL_IMAGE",
      reason: undefined,
      steps: [["DISPLAY_TEXT", [], "OWN THE MOMENT", "GLOBAL"]],
    });
    // Main (db76dc2) asked this with rule 4½'s code; the switch off is main's answer, whole.
    expect(routeWith(false, HEADLINE)).toEqual({
      initialPath: "ASK",
      steps: [],
      reason: "add_unclear",
    });
    // With no photo rule 0 claims every sentence, as it does on main, whatever the switch says.
    expect(routeWith(true, HEADLINE, false).steps.map((s) => s.op)).toEqual([
      "GENERATE",
    ]);
  });

  it("reads her words as the banner will write them: uppercased, curly quotes and apostrophes, spaces made one", () => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
    const table: [string, string][] = [
      [HEADLINE, "OWN THE MOMENT"],
      ['Add the headline "OWN THE MOMENT" across the top', "OWN THE MOMENT"],
      ["ADD THE HEADLINE “OWN THE MOMENT” ACROSS THE TOP", "OWN THE MOMENT"],
      ['add the headline "own the moment" across the top', "OWN THE MOMENT"],
      ["add the headline “don’t stop” across the top", "DON'T STOP"],
      ['  add  the headline "  GET   LOUD " across the top  ', "GET LOUD"],
      ['add the headline "NUMBER 8" across the top', "NUMBER 8"],
    ];
    for (const [text, words] of table) {
      expect({ text, read: readHeadline(text) }).toEqual({ text, read: words });
      expect({ text, steps: textPins(route(text, true).steps) }).toEqual({
        text,
        steps: [["DISPLAY_TEXT", [], words, "GLOBAL"]],
      });
    }
  });

  it("reads nothing looser — #433's banner sentences ask exactly as they do with it off, and none of their pins flip", () => {
    // The explicit assertion the PR owes: for every sentence here, route() with the switch ON is
    // deep-equal to route() with it OFF, and both ask. Q6's two sentences and every sentence F-I2's
    // diff moved (ASKS_SINCE_F_I2, above) are #433's pins; the rest are the looser phrasings.
    const looser = [
      ...ASKS_SINCE_F_I2.keys(),
      "add the text GET LOUD across the top",
      "add the text GET LOUD",
      'add the text "GET LOUD" across the top',
      'add the words "GET LOUD" across the top',
      "add a banner that says GET LOUD",
      "add a banner across the top that says GET LOUD",
      'please add the headline "GET LOUD" across the top',
      'put the headline "GET LOUD" across the top',
      'add the headline "GET LOUD" across the top.',
      'add the headline "GET LOUD"',
      'add the headline "GET LOUD" across the bottom',
      'add a headline "GET LOUD" across the top',
      "add the headline GET LOUD across the top",
      "add the headline 'GET LOUD' across the top",
      'add the headline "" across the top',
      'add the headline "   " across the top',
    ];
    expect(looser).toContain(Q6_T1);
    expect(looser).toContain(Q6_T2);
    for (const text of looser) {
      expect(readHeadline(text)).toBeNull();
      const on = routeWith(true, text);
      expect({ text, on }).toEqual({ text, on: routeWith(false, text) });
      expect({ text, path: on.initialPath }).toEqual({ text, path: "ASK" });
    }
    // And #433's own pins, re-asserted with the switch on: the reasons its describe block names.
    process.env.STUDIO_DISPLAY_TEXT = "true";
    expect([Q6_T1, Q6_T2].map((text) => route(text, true).reason)).toEqual([
      "add_unclear",
      "fast_path_declined",
    ]);
  });

  it("claims the shape BEFORE any rule reads her quoted words — main's misreads of them, pinned both ways", () => {
    // Off: what main (db76dc2) does with each, recorded from its route() — every one a rule reading her
    // headline as an instruction. On: the headline, whole.
    const table: [string, string][] = [
      ["REMOVE ALL DOUBT", "REMOVE_OBJECT headline remove all|top"],
      ["TAKE OFF", "REMOVE_OBJECT headline take|top"],
      ["SET THE SCENE", "CHANGE_BACKGROUND person"],
      ["BEHIND ME", "CHANGE_BACKGROUND person"],
      ["NO BACKGROUND NOISE", "CHANGE_BACKGROUND person"],
      ["IF ANY", "ASK conditional"],
      ["SEE RED", "RECOLOR headline see|top"],
      ["GOLDEN HOUR", "RECOLOR headline|top"],
      ["RUN AND CHANGE", "ASK add_unclear"],
    ];
    const read = (r: ReturnType<typeof route>) =>
      r.initialPath === "ASK"
        ? `ASK ${r.reason}`
        : r.steps.map((s) => `${s.op} ${s.targets.join("|")}`).join(" + ");
    for (const [words, main] of table) {
      const text = `add the headline "${words}" across the top`;
      expect({ text, off: read(routeWith(false, text)) }).toEqual({
        text,
        off: main,
      });
      expect({ text, on: textPins(routeWith(true, text).steps) }).toEqual({
        text,
        on: [["DISPLAY_TEXT", [], words, "GLOBAL"]],
      });
    }
  });

  it("leaves rule 0 the gate's: a headline whose own words ask for a new image is still that ask, as on main (known)", () => {
    // "make a new post" is EXPLICIT_GENERATE's shape, and rule 0 runs first. The freeze refuses a GENERATE
    // on a photo (nativeIntent.test.ts pins it), so this never runs as one; recorded, not fixed here.
    const text = 'add the headline "MAKE A NEW POST" across the top';
    expect(routeWith(true, text).steps.map((s) => s.op)).toEqual(["GENERATE"]);
    expect(routeWith(false, text).steps.map((s) => s.op)).toEqual(["GENERATE"]);
  });

  it("composes a headline beside another change, each clause read by its own rule — cell 1a's C among them", () => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
    const table: [string, TextPin[]][] = [
      [
        `change the background to a stadium and ${HEADLINE}`,
        [
          ["DISPLAY_TEXT", [], "OWN THE MOMENT", "GLOBAL"],
          ["CHANGE_BACKGROUND", ["person"], "stadium", "SUBJECT_INVERSE"],
        ],
      ],
      [
        `change my jersey to an adidas jersey, change my socks to adidas socks, change my cleats to adidas cleats, and ${HEADLINE}`,
        [
          ["DISPLAY_TEXT", [], "OWN THE MOMENT", "GLOBAL"],
          ["REPLACE_OBJECT", ["jersey"], "adidas jersey", "REGION"],
          ["REPLACE_OBJECT", ["socks"], "adidas socks", "REGION"],
          ["REPLACE_OBJECT", ["cleats"], "adidas cleats", "REGION"],
        ],
      ],
      [
        `make it black and white and ${HEADLINE}`,
        [
          ["GLOBAL_STYLE", [], "black and white", "GLOBAL"],
          ["DISPLAY_TEXT", [], "OWN THE MOMENT", "GLOBAL"],
        ],
      ],
    ];
    for (const [text, steps] of table) {
      expect({ text, steps: textPins(route(text, true).steps) }).toEqual({
        text,
        steps,
      });
      // Off, each asks as main did: the headline clause is rule 4½'s `add_unclear`.
      expect({ text, off: routeWith(false, text).reason }).toEqual({
        text,
        off: "add_unclear",
      });
      process.env.STUDIO_DISPLAY_TEXT = "true";
    }
  });

  it("puts DISPLAY_TEXT in the allowed set only with the switch on — off, the set is main's to the letter", () => {
    delete process.env.STUDIO_DISPLAY_TEXT;
    expect(allowedOps(true, HEADLINE)).toEqual(EDIT_OPS);
    process.env.STUDIO_DISPLAY_TEXT = "true";
    expect(allowedOps(true, HEADLINE)).toEqual([
      "RECOLOR",
      "APPLY_DESIGN",
      "REPLACE_OBJECT",
      "REMOVE_OBJECT",
      "ADD_OBJECT",
      "DISPLAY_TEXT",
      "CHANGE_BACKGROUND",
      "GLOBAL_STYLE",
    ]);
    expect(allowedOps(false, HEADLINE)).toEqual(["GENERATE"]);
  });

  it("is refused by the person guard like every op but a background, if a target ever named her", () => {
    // By construction a headline has no target. The guard's claim is every word on every op but the
    // inversion, so the new op is in the cross product too.
    for (const word of PERSON_NOUNS) {
      const out = validate(
        {
          steps: [
            {
              op: "DISPLAY_TEXT",
              targets: [word],
              value: "GET LOUD",
              scope: "GLOBAL",
            },
          ],
        },
        true,
        HEADLINE,
      );
      expect({ word, reason: out.reason }).toEqual({
        word,
        reason: "person_target",
      });
    }
  });
});

// ─── PR T, T.2 — the bounds (N8): enforced by the rule, so her headline and the interpreter's face one guard ─

/** Her sentence, in rule ⅛'s shape, around these words. */
const headlineOf = (words: string) =>
  `add the headline "${words}" across the top`;

describe("PR T, T.2 — a headline's words are bounded by the rule itself, and out of bounds ASKS (N8)", () => {
  beforeEach(() => {
    process.env.STUDIO_DISPLAY_TEXT = "true";
  });
  afterEach(restoreDisplayText);

  /** Routed → its words; asked → the code. The two outcomes a bound can move a headline between. */
  const outcome = (words: string) => {
    const out = route(headlineOf(words), true);
    return out.initialPath === "ASK"
      ? `ASK ${out.reason}`
      : textPins(out.steps)
          .map(([op, , value]) => `${op} ${value}`)
          .join(" + ");
  };

  it("holds it to four words and 24 characters — the fifth word and the 25th character ask", () => {
    // Hand-written beside the constants they pin.
    expect([MAX_HEADLINE_WORDS, MAX_HEADLINE_CHARACTERS]).toEqual([4, 24]);
    const table: [string, string, string | null][] = [
      ["ONE TWO THREE FOUR", "DISPLAY_TEXT ONE TWO THREE FOUR", null],
      ["WE RUN THIS CITY TONIGHT", "ASK headline_bounds", "words"],
      [
        "CHAMPIONSHIP SEASON 2026",
        "DISPLAY_TEXT CHAMPIONSHIP SEASON 2026",
        null,
      ],
      ["CHAMPIONSHIP SEASONS 2026", "ASK headline_bounds", "length"],
      ["ABCDEFGHIJKLMNOPQRSTUVWXYZ", "ASK headline_bounds", "length"],
    ];
    for (const [words, want, bound] of table) {
      expect({
        words,
        got: outcome(words),
        bound: headlineBound(words),
      }).toEqual({
        words,
        got: want,
        bound,
      });
    }
  });

  it("takes capitals, digits and ! ? & ' . - only — nothing a model could read as markup", () => {
    const table: [string, string][] = [
      ["ROCK & ROLL!", "DISPLAY_TEXT ROCK & ROLL!"],
      ["DON'T STOP.", "DISPLAY_TEXT DON'T STOP."],
      ["WHY NOT US?", "DISPLAY_TEXT WHY NOT US?"],
      ["NO. 8 ALL-IN", "DISPLAY_TEXT NO. 8 ALL-IN"],
      ["WIN, TOGETHER", "ASK headline_bounds"],
      ["GO/NO GO", "ASK headline_bounds"],
      ["#1 FAN", "ASK headline_bounds"],
      ["ÉLAN", "ASK headline_bounds"],
      ["GO <B>BIG</B>", "ASK headline_bounds"],
    ];
    for (const [words, want] of table) {
      expect({ words, got: outcome(words) }).toEqual({ words, got: want });
    }
    expect(headlineBound("WIN, TOGETHER")).toBe("characters");
  });

  it("carries no brand's name — the BRANDS vocabulary is the check, whole words, any case", () => {
    for (const words of [
      "NIKE FOREVER",
      "ADIDAS ALL DAY",
      "GO PUMA",
      "UNDER ARMOUR",
      "FIND A NEW BALANCE",
      "air jordan",
    ]) {
      expect({
        words,
        got: outcome(words),
        bound: headlineBound(words.toUpperCase()),
      }).toEqual({
        words,
        got: "ASK headline_bounds",
        bound: "brand",
      });
    }
    // Whole words only: a brand's letters inside another word are not its name.
    expect(outcome("NIKELAND")).toBe("DISPLAY_TEXT NIKELAND");
  });

  it("carries no tagline on the deny-list — hand-written here, matched as whole words anywhere in it", () => {
    // Hand-written, not looped over the constant: deleting a line from HEADLINE_TAGLINES must be red.
    expect(HEADLINE_TAGLINES).toEqual([
      "just do it",
      "find your greatness",
      "believe in something",
      "dream crazy",
      "you cant stop us",
      "impossible is nothing",
      "forever faster",
      "only see great",
      "i will what i want",
      "rule yourself",
      "protect this house",
      "the only way is through",
      "fearlessly independent",
      "be more human",
      "i am what i am",
      "sound mind sound body",
      "reach beyond",
      "better never stops",
      "im lovin it",
      "im loving it",
      "think different",
      "because youre worth it",
      "open happiness",
      "taste the feeling",
      "gives you wings",
      "have it your way",
      "finger lickin good",
      "finger licking good",
      "eat fresh",
      "is it in you",
      "be like mike",
      "obey your thirst",
      "got milk",
      "breakfast of champions",
    ]);
    for (const words of [
      "JUST DO IT",
      "just do it now",
      "IMPOSSIBLE IS NOTHING",
      "I'M LOVIN' IT",
      "i’m lovin’ it",
      "IM LOVING IT",
      "THINK DIFFERENT",
      "GOT MILK?",
      "FOREVER FASTER",
      "PROTECT THIS HOUSE",
      // Since R1 (the interpreter, I.4): what interpret/2 suggested for a nike ad.
      "FIND YOUR GREATNESS",
      "YOU CAN'T STOP US",
    ]) {
      expect({
        words,
        got: outcome(words),
        bound: headlineBound(readHeadline(headlineOf(words)) ?? ""),
      }).toEqual({
        words,
        got: "ASK headline_bounds",
        bound: "tagline",
      });
    }
    // A guard on words, not on meaning: near misses and a reworded slogan route (known, recorded).
    for (const words of [
      "JUST DO THIS",
      "NOTHING IS IMPOSSIBLE",
      "FASTER FOREVER",
    ]) {
      expect({ words, got: outcome(words) }).toEqual({
        words,
        got: `DISPLAY_TEXT ${words}`,
      });
    }
  });

  it("asks WHOLE when out of bounds — it never falls through to a rule that reads her words; off, main's answer", () => {
    // Five words with a colour in them: rule 5 reads it as a recolour on main, and would here too if the
    // bound only declined the headline and let the sentence fall through.
    const text = headlineOf("RED IS THE NEW BLACK");
    expect(routeWith(true, text).reason).toBe("headline_bounds");
    expect(routeWith(false, text).steps.map((s) => [s.op, s.value])).toEqual([
      ["RECOLOR", "red"],
    ]);
    // The whole sentence is the shape, so no other code is true of it — "if" is her headline's.
    expect(
      routeWith(true, headlineOf("IF ANY DOUBT REMAINS HERE")).reason,
    ).toBe("headline_bounds");
    expect(
      routeWith(false, headlineOf("IF ANY DOUBT REMAINS HERE")).reason,
    ).toBe("conditional");
    // Off, an out-of-bounds headline asks with main's code, whichever it was.
    expect(
      [headlineOf("WE RUN THIS CITY TONIGHT"), headlineOf("NIKE FOREVER")].map(
        (t) => routeWith(false, t).reason,
      ),
    ).toEqual(["add_unclear", "fast_path_declined"]);
  });

  it("refuses two headlines in one sentence as a conflict — one headline per image", () => {
    for (const text of [
      `${headlineOf("OWN THE MOMENT")} and ${headlineOf("GET LOUD")}`,
      `${headlineOf("OWN IT")}, change the background to a stadium, and ${headlineOf("GET LOUD")}`,
      `${headlineOf("GET LOUD")} and ${headlineOf("GET LOUD")}`,
    ]) {
      const on = routeWith(true, text);
      expect({ text, path: on.initialPath, reason: on.reason }).toEqual({
        text,
        path: "ASK",
        reason: "compound_conflict",
      });
      expect({ text, off: routeWith(false, text).reason }).toEqual({
        text,
        off: "add_unclear",
      });
    }
  });

  it("gives an out-of-bounds headline inside a compound its own code — the clause's, as composition's d1 does", () => {
    const text = `change the background to a stadium and ${headlineOf("WE RUN THIS CITY TONIGHT")}`;
    expect(routeWith(true, text).reason).toBe("headline_bounds");
    expect(routeWith(false, text).reason).toBe("add_unclear");
  });
});

// ─── WAVE A, G1 — A PART OF HER NAMED AS WHERE A THING GOES (sweep-4 ledger F-L6) ──────────────────────────

describe("G1 — a part of her after a closed preposition is where a thing goes, not a thing to change (wave A)", () => {
  const read = (text: string) => {
    const out = route(text, true);
    return out.initialPath === "ASK"
      ? `ASK ${out.reason}`
      : out.steps
          .map((s) => `${s.op}[${s.targets.join("|")}] ${s.value}`)
          .join(" + ");
  };

  it("routes the live sentences as adds, the place kept in her words and never a target", () => {
    const cases: [string, string][] = [
      // Live 2026-09-16/17: refused "we don't edit people", while "on top of my head" routed.
      [
        "add a water bottle onto my head",
        "ADD_OBJECT[water bottle] onto my head",
      ],
      ["add a water bottle on my head", "ADD_OBJECT[water bottle] on my head"],
      // The control that always routed, unchanged.
      [
        "add a water bottle on top of my head",
        "ADD_OBJECT[water bottle] on top of my head",
      ],
      // Contact onto a part a thing rests on.
      [
        "add a soccer ball onto my foot",
        "ADD_OBJECT[soccer ball] onto my foot",
      ],
      ["add a towel on my shoulder", "ADD_OBJECT[towel] on my shoulder"],
      [
        "put a water bottle on my left shoulder",
        "ADD_OBJECT[water bottle] on my left shoulder",
      ],
      // Non-contact, onto any part of her or her by pronoun — and read ONLY before her.
      [
        "add a soccer ball near my feet",
        "ADD_OBJECT[soccer ball] near my feet",
      ],
      ["add a soccer ball by my feet", "ADD_OBJECT[soccer ball] by my feet"],
      [
        "add a soccer ball in front of me",
        "ADD_OBJECT[soccer ball] in front of me",
      ],
      [
        "add a water bottle behind my head",
        "ADD_OBJECT[water bottle] behind my head",
      ],
      ["put a cone towards my feet", "ADD_OBJECT[cone] towards my feet"],
      ["add a ball close to my feet", "ADD_OBJECT[ball] close to my feet"],
      ["add a ball near the bench", "ASK add_unclear"],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
  });

  it("keeps the real guard: an edit of her, a thing onto her skin, a body modification, a costume piece", () => {
    const cases: [string, string][] = [
      ["make my head smaller", "ASK person_mentioned"],
      ["remove my feet", "ASK person_target"],
      ["change my feet to blue", "ASK person_target"],
      // Contact onto a part a thing does not rest on: a substance or a thing on her skin is an edit of her.
      ["put paint on my face", "ASK person_target"],
      ["add a towel to my arm", "ASK person_target"],
      ["put a sticker on me", "ASK person_target"],
      // A body modification is never placed, near her or on her.
      ["add a tattoo on my arm", "ASK person_target"],
      ["add a tattoo onto my foot", "ASK person_target"],
      ["add a scar near my eye", "ASK person_mentioned"],
      // M3's N6: a crown, a tiara, a mask and shades are kept off the worn list so they ask onto her.
      ["add a crown on my head", "ASK person_target"],
      ["add a crown on her head", "ASK person_target"],
      ["put a tiara on my head", "ASK person_target"],
      // A worn thing onto a place not its own stays rule 3¾b's refusal — never a placement.
      ["add a stud to my head", "ASK person_target"],
      // Her body described: only which one may stand before the part.
      ["add a ball near my tattooed arm", "ASK add_unclear"],
      // A thing that names her.
      ["add a girl on my shoulder", "ASK person_target"],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
  });

  it("reads 'closer to' as a move no rule reads — never the person line, and never an add of a second ball", () => {
    expect(read("put the ball closer to my feet")).toBe("ASK add_unclear");
    expect(parseAddObject("put the ball closer to my feet")).toBeNull();
  });

  it("leaves the live move sentence the interpreter's, and asks about the part it cannot read (wave B, C3a)", () => {
    const one = route("for the ball on the ground move it closer to my feet", true);
    expect([one.initialPath, one.reason]).toEqual(["ASK", "fast_path_declined"]);
    // ⚠️ WAVE A PINNED THIS AS `person_target`, AND C3a'S STOP BOUNDARY IS WHY IT MOVED. Rule 1 used to
    // claim every noun across the full stop — "my feet" among them — so a sentence that edits no one was
    // refused as an edit of HER. The stop now ends the clause, so the removal is read on its own and the
    // move clause is the only part no rule reads: she is told we could not follow one part, not that we
    // do not edit people. It is still an ask, because a move is still no operation (ledger F-WA6, card 2).
    expect(
      read(
        "remove the ball in the air. for the ball on the ground move it closer to my feet.",
      ),
    ).toBe("ASK compound_partial");
  });

  it("keeps a thing she wears on rule 3¾b's reading, and a place in a chain", () => {
    expect(read("add a hat onto my head")).toBe("ADD_OBJECT[hat] onto my head");
    expect(read("put a water bottle on the grass near my feet")).toBe(
      "ADD_OBJECT[water bottle|grass] on the grass near my feet",
    );
  });
});

// ─── WAVE A, G3 — A COLOUR WORD INSIDE A THING'S NAME IS NOT A RECOLOUR (sweep-4 ledger F-AM3) ─────────────

describe("G3 — rule 5 reads its colour outside a closed list of compound names (wave A)", () => {
  const read = (text: string) => {
    const out = route(text, true);
    return out.initialPath === "ASK"
      ? `ASK ${out.reason}`
      : out.steps
          .map((s) => `${s.op}[${s.targets.join("|")}] ${s.value}`)
          .join(" + ");
  };

  it("asks rather than recolour a region detection cannot find — the scene sentences are the interpreter's", () => {
    const cases: [string, string][] = [
      // Live (F-AM3): RECOLOR [awards show] "red" on main.
      ["me walking the red carpet at an awards show", "ASK fast_path_declined"],
      // RECOLOR [podium] "gold" on main.
      ["me holding a gold medal on the podium", "ASK fast_path_declined"],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
  });

  it("reads a colour beside a compound, and every compound where another rule reads it, exactly as before", () => {
    const cases: [string, string][] = [
      // A colour outside the compound is still the recolour's.
      ["make my jersey blue on the red carpet", "RECOLOR[jersey] blue"],
      ["make the podium gold", "RECOLOR[podium] gold"],
      ["make the medal gold", "RECOLOR[medal] gold"],
      // Rule 2 and rule 4½ read the compound as her place and her thing's surface.
      ["put me on the red carpet", "CHANGE_BACKGROUND[person] red carpet"],
      ["put me at the white house", "CHANGE_BACKGROUND[person] white house"],
      [
        "put the jersey on the red carpet",
        "ADD_OBJECT[jersey|red carpet] on the red carpet",
      ],
      // Adjacency would have stopped these; the list does not.
      ["make my headband pink too", "RECOLOR[headband] pink"],
      ["make the socks red now", "RECOLOR[socks] red"],
      // Rule 3 owns "golden hour", and her keep beside it routes only because the whole sentence does — so it is
      // not on the list (measured: on it, this asked and her keep was lost).
      ["make it golden hour", "GLOBAL_STYLE[] golden hour"],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
    const keep = route("make it golden hour, keep me the same", true);
    expect([keep.steps.map((s) => [s.op, s.value]), keep.constraints]).toEqual([
      [["GLOBAL_STYLE", "golden hour"]],
      [{ kind: "preserve_person" }],
    ]);
  });
});

// ─── WAVE A, V1 — A PHOTO NAMED BY NUMBER OR BY ORDINAL IS ONE POINTER (sweep-4 ledger F-CA7) ──────────────

describe("V1 — 'image 2' and 'the second picture' read as the same photo, wherever a pointer is read (wave A)", () => {
  const read = (text: string, objects = 1) => {
    const out = route(text, true, { objects });
    return out.initialPath === "ASK"
      ? `ASK ${out.reason}`
      : out.steps
          .map(
            (s) =>
              `${s.op}[${s.targets.join("|")}] ${s.value}${s.reference ? "@" + s.reference : ""}`,
          )
          .join(" + ");
  };

  it("reads a numbered photo in a replacement she points at, as the ordinal already was", () => {
    const cases: [string, string][] = [
      [
        "change my earrings to the hoops in the second picture",
        "REPLACE_OBJECT[earrings] hoops@object",
      ],
      [
        "change my earrings to the hoops in image 2",
        "REPLACE_OBJECT[earrings] hoops@object",
      ],
      [
        "change my earrings to the hoops from image 2",
        "REPLACE_OBJECT[earrings] hoops@object",
      ],
      [
        "change my earrings to the hoops in picture 2",
        "REPLACE_OBJECT[earrings] hoops@object",
      ],
      [
        "replace the ball with the one from image 2",
        "REPLACE_OBJECT[ball] ball@object",
      ],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
    // With no Object photo it asks for one, as the ordinal form does.
    expect(read("change my earrings to the hoops in image 2", 0)).toBe(
      "ASK object_photo_missing",
    );
  });

  it("reads 'in the second picture' after an add's thing as where it comes from, as 'from' already was", () => {
    const cases: [string, string][] = [
      [
        "add the hoops in the second picture to my ears",
        "ADD_OBJECT[hoops] to my ears",
      ],
      [
        "add the hoops from the second picture to my ears",
        "ADD_OBJECT[hoops] to my ears",
      ],
      ["add the hoops from image 2 to my ears", "ADD_OBJECT[hoops] to my ears"],
      ["add the hoops in image 2 to my ears", "ADD_OBJECT[hoops] to my ears"],
      [
        "put the ball in the second photo on the bench",
        "ADD_OBJECT[ball|bench] on the bench",
      ],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
  });

  it("keeps the first picture the frame, and every digit that is not a photo's number where it was", () => {
    const cases: [string, string][] = [
      // Mia's sentence: "the first picture" is where the earrings are — her frame.
      [
        "change my earrings in the first picture to these gold hoops",
        "REPLACE_OBJECT[earrings] gold hoops@object",
      ],
      ["put a number 10 on the back", "ASK person_target"],
      ["remove the 8 and nike logo", "ASK brand_removal"],
      // "2nd" reaches the rules as "nd" — ledgered, unread as before.
      ["add the hoops from the 2nd picture to my ears", "ASK add_unclear"],
      // No rule reads "hold".
      [
        "make me hold the gatorade bottle from image 2",
        "ASK fast_path_declined",
      ],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
  });
});

// ─── WAVE A, V2 — A WORN THING WITH NO PLACE GOES WHERE IT IS WORN (sweep-4 ledger F-CA7) ───────────────────

describe("V2 — a place-less worn add is read at its thing's anchor, and 'add in' is 'add' (wave A)", () => {
  const read = (text: string) => {
    const out = route(text, true, { objects: 1 });
    return out.initialPath === "ASK"
      ? `ASK ${out.reason}`
      : out.steps
          .map((s) => `${s.op}[${s.targets.join("|")}] ${s.value}`)
          .join(" + ");
  };

  it("routes C2's acceptance cell 3 as the edit its placed twin already was", () => {
    expect(read("add in hoops from the second picture")).toBe(
      "ADD_OBJECT[hoops] in my ears",
    );
    expect(read("add the hoops from image 2 to my ears")).toBe(
      "ADD_OBJECT[hoops] to my ears",
    );
  });

  it("takes each thing's own anchor, with that place's own preposition", () => {
    const cases: [string, string][] = [
      ["add hoops", "ADD_OBJECT[hoops] in my ears"],
      ["add in hoops", "ADD_OBJECT[hoops] in my ears"],
      ["add a gold hoop", "ADD_OBJECT[gold hoop] in my ear"],
      ["add a cap", "ADD_OBJECT[cap] on my head"],
      ["add a nike cap", "ADD_OBJECT[nike cap] on my head"],
      ["add sunglasses", "ADD_OBJECT[sunglasses] on my face"],
      ["add a necklace", "ADD_OBJECT[necklace] around my neck"],
      ["put a watch", "ADD_OBJECT[watch] on my wrist"],
      ["add gloves", "ADD_OBJECT[gloves] on my hands"],
      ["add a scrunchie", "ADD_OBJECT[scrunchie] on my hair"],
      ["can you add a ring please", "ADD_OBJECT[ring] on my finger"],
      [
        "add these gold hoops from the second picture",
        "ADD_OBJECT[gold hoops] in my ears",
      ],
      [
        "add in the hoops from image 2 to my ears",
        "ADD_OBJECT[hoops] to my ears",
      ],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
  });

  it("asks as before for everything that is not a worn thing it can read", () => {
    const cases: [string, string][] = [
      // Not worn: an add still needs its place (D2), "add in" or not.
      ["add a soccer ball", "ASK add_unclear"],
      ["add in a soccer ball at my feet", "ASK add_unclear"],
      // N6: a crown is not worn.
      ["add a crown", "ASK add_unclear"],
      ["add a tattoo", "ASK person_mentioned"],
      // A word the rule does not read: the worn line, with or without a place.
      ["add small gold hoops", "ASK worn_add_unclear"],
      ["add in small gold hoops to my ears", "ASK worn_add_unclear"],
      // A place that is not the thing's own keeps the person line — the guard's code where rule 4½ reads the add,
      // the fall-through's where it does not ("add in" is not rule 4½'s); one line on the screen.
      ["add a watch on my neck", "ASK person_target"],
      ["add in a watch on my neck", "ASK person_mentioned"],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
  });
});

// ─── WAVE A, V3 — THE REST OF THE NEW-IMAGE WORDS (sweep-4 ledger F-L8) ────────────────────────────────────

describe("V3 — pic, headshot, portrait, photoshoot and plural photos name a new image, and nothing pointing at hers does (wave A)", () => {
  const generates = (text: string) =>
    allowedOps(true, text).includes("GENERATE") &&
    route(text, true).steps.every((s) => s.op === "GENERATE");

  it("reads the card's sentences as new images", () => {
    for (const text of [
      "generate a pic of me playing soccer",
      "generate a headshot of me",
      "create a portrait of me in a stadium",
      "make me a professional photoshoot",
      "make a pic of me training in the gym",
      // A plural takes no "a".
      "generate professional sports photos of her",
      "create photos of me in a stadium",
      "generate pics of me at the beach",
      "generate 3 photos of me dunking",
      "generate two photographs of me",
      "make me some photos of me dunking",
    ]) {
      expect({ text, generates: generates(text) }).toEqual({
        text,
        generates: true,
      });
    }
  });

  it("leaves every plural that points at her photos an edit — and 'make' counts only as 'make me'", () => {
    for (const text of [
      "make photos brighter",
      "make my photos brighter",
      "make the photos warmer",
      "make these pics black and white",
      "make some photos of me",
      "make the portrait brighter",
      "make it a portrait",
      "make this a headshot",
      "generate pic of me playing soccer",
    ]) {
      expect({ text, ops: allowedOps(true, text) }).toEqual({
        text,
        ops: EDIT_OPS,
      });
    }
  });

  it("names the wrong answer it shares with 'photo': a version of this pic is a new image", () => {
    expect(
      route("make a black and white version of this pic", true).steps.map(
        (s) => s.op,
      ),
    ).toEqual(["GENERATE"]);
  });
});

// ─── WAVE A, V4 — TAKE X OFF, WHERE A REMOVED THING IS, AND THE SKY'S LOOK (ledger F-CA2, F-AM1) ─────────────

describe("V4 — a removal reads where its thing is as a place, 'take X off' is a removal, and the sky takes a look (wave A)", () => {
  const read = (text: string) => {
    const out = route(text, true);
    return out.initialPath === "ASK"
      ? `ASK ${out.reason}`
      : out.steps
          .map(
            (s) =>
              `${s.op}[${s.targets.join("|")}]${s.value === null ? "" : ` ${s.value}`}`,
          )
          .join(" + ");
  };

  it("reads 'take X off Y' as the removal of X — C2's acceptance cell 4", () => {
    const cases: [string, string][] = [
      ["take the logo off my sleeve", "REMOVE_OBJECT[logo]"],
      ["take the logo off", "REMOVE_OBJECT[logo]"],
      ["take off the logo", "REMOVE_OBJECT[logo]"],
      ["take the nike logo off my shirt", "REMOVE_OBJECT[nike logo]"],
      // A worn thing's place on her is where it is — "remove the cap from my head" routes the same way.
      ["take the hat off my head", "REMOVE_OBJECT[hat]"],
      ["remove the cap from my head", "REMOVE_OBJECT[cap]"],
      [
        "make the socks blue and take the logo off my sleeve",
        "RECOLOR[socks] blue + REMOVE_OBJECT[logo]",
      ],
      // A lone pronoun is not read.
      ["take it off", "ASK fast_path_declined"],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
  });

  it("never removes the place a removed thing is on — the freeze compiled 'remove the sleeve' from these", () => {
    const cases: [string, string][] = [
      ["remove the logo from my sleeve", "REMOVE_OBJECT[logo]"],
      ["remove the logo on the sleeve", "REMOVE_OBJECT[logo]"],
      ["remove the nike swoosh on my shorts", "REMOVE_OBJECT[nike swoosh]"],
      ["remove the logo from the photograph", "REMOVE_OBJECT[logo]"],
      ["remove the ball from the grass", "REMOVE_OBJECT[ball]"],
      // A recolour of the sleeve beside it is no longer a conflict: the sleeve is not removed.
      [
        "make my sleeve blue and remove the logo on my sleeve",
        "RECOLOR[sleeve] blue + REMOVE_OBJECT[logo]",
      ],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
  });

  it("keeps the guard's side and asks where a place runs on into a list", () => {
    const cases: [string, string][] = [
      // A place naming her stays a target, and the guard refuses.
      ["remove the tattoo on my arm", "ASK person_target"],
      ["take the tattoo off my arm", "ASK person_target"],
      ["remove the ball on my foot", "ASK person_target"],
      // Two places, or a place and a second removal: not guessed.
      ["remove the swoosh from the ball and the bench", "ASK fast_path_declined"],
      ["remove the stripes on the socks and the logo", "ASK fast_path_declined"],
      // Only on, from and off: "in" is ledgered, and "behind me" was never a phrase.
      ["remove the ball in the air", "REMOVE_OBJECT[ball|air]"],
      ["remove the cone behind me", "REMOVE_OBJECT[cone]"],
      // A removal naming no place is untouched.
      ["remove the ball and the cone", "REMOVE_OBJECT[ball|cone]"],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
  });

  it("reads a whole look on the sky as the sky's recolour — C2's acceptance cell 5 — and nothing wider", () => {
    const cases: [string, string][] = [
      ["make the sky moodier", "RECOLOR[sky] moodier"],
      ["make the sky look moodier", "RECOLOR[sky] moodier"],
      ["make the sky darker", "RECOLOR[sky] darker"],
      ["make the sky more dramatic", "RECOLOR[sky] dramatic"],
      // A colour on the sky is still rule 5's.
      ["make the sky blue", "RECOLOR[sky] blue"],
      ["make the sky golden hour", "RECOLOR[sky] golden"],
      // Another region, or the sky beside one, is not read.
      ["make the grass moodier", "ASK fast_path_declined"],
      ["make the sky and the grass moodier", "ASK fast_path_declined"],
      ["make the jersey moodier", "ASK fast_path_declined"],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
  });
});

// ─── WAVE A, V5 — AN EXPLICIT GENERATE CLAIMS ITS COMPOUND (sweep-4 ledger F-AM4) ──────────────────────────

describe("V5 — the explicit-generate head wins a compound, and the trailing change is the generate's direction (wave A)", () => {
  const COMPOUND =
    "generate a pic of me playing soccer and change the background to a stadium";

  it("reads the live compound as ONE new image, with a photo and without — never the background edit", () => {
    // F-AM4, accepted as pre-frame-defaulting parity: CHANGE_BACKGROUND "stadium", the generate half dropped. Rule 0
    // reads EXPLICIT_GENERATE over the whole sentence before composition; "pic" was the only missing piece (V3).
    for (const photo of [true, false]) {
      expect({
        photo,
        ops: route(COMPOUND, photo).steps.map((s) => s.op),
      }).toEqual({ photo, ops: ["GENERATE"] });
    }
    expect(composedClauses(COMPOUND)).toBeNull();
  });

  it("never composes a generate an operation verb heads — the clause reader would split it, and composedClauses answers null", () => {
    // RV-V5a missed on COMPOUND: "generate" is no operation verb, so the clause reader never splits it and
    // composedClauses' EXPLICIT_GENERATE guard was not load-bearing there. "make" is one — without the guard this
    // sentence reads as two clauses, GENERATE and REMOVE_OBJECT, a composition `route` never made.
    const VERB_HEADED = "make a pic of me playing soccer and remove the cone";
    for (const photo of [true, false]) {
      expect({
        photo,
        ops: route(VERB_HEADED, photo).steps.map((s) => s.op),
      }).toEqual({ photo, ops: ["GENERATE"] });
    }
    expect(composedClauses(VERB_HEADED)).toBeNull();
  });

  it("takes every compound an explicit generate heads the same way — whatever the trailing change is", () => {
    for (const text of [
      "generate a photo of me dunking, then remove the cone",
      "create a portrait of me in a stadium and make my jersey blue",
      "make me some photos of me dunking and change the background to a beach",
    ]) {
      expect({
        text,
        ops: route(text, true).steps.map((s) => s.op),
      }).toEqual({ text, ops: ["GENERATE"] });
    }
  });

  it("leaves the article-less compound the background edit main made it — V3's article-less singular, ledgered", () => {
    expect(
      route(
        "generate pic of me playing soccer and change the background to a stadium",
        true,
      ).steps.map((s) => [s.op, s.value]),
    ).toEqual([["CHANGE_BACKGROUND", "stadium"]]);
  });
});

// ─── WAVE B, C3a — A FULL STOP ENDS A CLAUSE, AND A TRAILING KEEP OR THANK-YOU IS SET ASIDE ─────────────
//
// The G2 card's first half (sweep-4 ledger F-WA1). `clausesOf` cut only at a joiner followed by an
// operation verb, so a second sentence leading with anything else — "for the cone on the ground…" — was
// never cut, and rule 1 claimed every noun across the stop. The cut alone moved 24 corpus cells from
// routing to asking, so it ships with the drop that makes it safe, and both are pinned together here.

describe("C3a — the sentence-stop boundary and the trailing drop (wave B)", () => {
  const read = (text: string) => {
    const out = route(text, true);
    return out.initialPath === "ASK"
      ? `ASK ${out.reason}`
      : out.steps
          .map(
            (s) =>
              `${s.op}[${s.targets.join("|")}]${s.value ? ` ${s.value}` : ""}`,
          )
          .join(" + ");
  };

  it("cuts at a full stop whatever leads the next sentence — F-WA1's cone is recoloured, not removed", () => {
    // Main `2dc602e` froze REMOVE_OBJECT [ball, air, cone]: the cone she asked to have made blue was
    // REMOVED, because "for" leads no operation verb and the clause never ended.
    expect(
      read(
        "remove the ball in the air. for the cone on the ground make it blue",
      ),
    ).toBe("RECOLOR[cone|ground make it] blue + REMOVE_OBJECT[ball|air]");
  });

  it("cuts at the full stop ONLY — never a comma, and not ! or ?, which are not joiners", () => {
    // ⚠️ `!` AND `?` READ AS MAIN READS THEM, and an earlier draft of the boundary's own note claimed they
    // cut. They are emitted by `TOKEN` but have never been in `CLAUSE_JOINERS`, so the loop skips them
    // before the stop test is reached. Ledgered as F-WB2, not folded in: widening the joiner set widens
    // the run the loop consumes, which is a second behaviour on every sentence.
    expect(
      read("remove the cone! for the ball on the ground make it blue"),
    ).toBe("REMOVE_OBJECT[cone|ball]");
    // A comma joins a list, and the verb test is what keeps rule 4c's items one clause.
    expect(read("change my uniform, socks, and shoes all to be adidas")).toBe(
      "REPLACE_OBJECT[uniform] adidas uniform + REPLACE_OBJECT[socks] adidas socks + REPLACE_OBJECT[shoes] adidas shoes",
    );
  });

  it("holds an edit whose second sentence is only a thank-you", () => {
    // The one class of the cut's 24 route→ask cells that is typed English.
    expect(read("make the socks blue. thanks")).toBe("RECOLOR[socks] blue");
    expect(read("make the socks blue. cheers")).toBe("RECOLOR[socks] blue");
  });

  it("holds an edit whose second sentence is our own scope line echoed back", () => {
    expect(
      read("make the socks blue. Keep everything else exactly as-is"),
    ).toBe("RECOLOR[socks] blue");
    // ⚠️ THE DROP PREVENTS THE ASK; IT DOES NOT TIDY RULE 5. With only her first clause left this returns
    // null, and null means the rules read the WHOLE text — so "original photograph s" is still claimed as
    // a second target, byte-identical to main `2dc602e`. That is F-WA4's class and not this commit's.
    expect(
      read(
        "make the socks blue. Keep the original photograph's lighting, exposure and contrast exactly as they are.",
      ),
    ).toBe("RECOLOR[socks|original photograph s] blue");
  });

  it("NEVER drops a clause that asks for an operation the rules do not have yet", () => {
    // ⚠️ THE GUARD ON THE WHOLE DESIGN, and it is why the drop is a closed list rather than "does this
    // clause name a change". Built as the negative test — no operation verb, no colour, so drop it — this
    // sentence routed as REMOVE_OBJECT [ball, air] with the MOVE silently gone, because `move` is not an
    // operation verb. A clause asking for a move must look nothing like "thanks".
    expect(
      read(
        "remove the ball in the air. for the ball on the ground move it closer to my feet.",
      ),
    ).toBe("ASK compound_partial");
  });

  it("NEVER drops her FIRST clause — the keep-first sentence K2 fixed stays fixed", () => {
    // ⚠️ FOUND BY jest, NOT BY READING THE CODE. Dropping a leading keep left one clause, which returns
    // null — and null means "the rules read the WHOLE text", not "read the clause that is left". Rule 5
    // then saw the whole sentence again and recoloured the cleats she had just said not to change, which
    // is F-L4 exactly, the defect K2 closed.
    // K2 sets this keep aside before the rules run, so `readAs` is the rest and the cleats are never a
    // target. The first build of the drop took her leading clause instead and the answer became
    // RECOLOR [cleats, socks] — the cleats recoloured. Both rows are main `2dc602e`'s, exactly.
    const kept = route("dont change my cleats, make the socks blue", true);
    expect([
      read("dont change my cleats, make the socks blue"),
      kept.readAs,
    ]).toEqual(["RECOLOR[socks] blue", "make the socks blue"]);
    expect(read("keep the jersey the same and make the socks blue")).toBe(
      "RECOLOR[socks] blue",
    );
  });

  it("keeps the 'if' advice on a compound the boundary newly made — Adi's live sentence", () => {
    // `declineReason` checks `compose` before its own conditional guard, so a clause code hid the "if"
    // once the stop made this two clauses: `brand_change` teaches her to spell out numbers, about a
    // sentence whose problem is the condition. Same answer as main `2dc602e`.
    expect(
      read(
        "change my uniform so that its a black adidas uniform. i dont want any nike logos showing in this so if there are any remove them",
      ),
    ).toBe("ASK conditional");
  });

  it("asks where a second sentence points BACK at the first — the boundary's own cost, ledgered", () => {
    // An elliptical continuation has no verb of its own, and the old greed served it by accident: main
    // read REMOVE_OBJECT [ball, air] — which removes "the air" as a second target (F-WA3's ledgered
    // residue), so the ask is the better of the two answers. The interpreter reads it (`+i`).
    expect(read("remove the ball. it is in the air")).toBe(
      "ASK compound_partial",
    );
  });

  it("leaves a sentence with no stop exactly as it was", () => {
    expect(read("remove the cone and make my jersey blue")).toBe(
      "RECOLOR[jersey] blue + REMOVE_OBJECT[cone]",
    );
    expect(read("make her jersey blue and her socks red")).toBe(
      "RECOLOR[jersey|socks] blue",
    );
  });
});

// ─── WAVE B, CARD 2 — MOVE_OBJECT: A THING ALREADY IN THE FRAME, PUT SOMEWHERE ELSE IN IT ──────────────
//
// Ledger F-WA6: "a move has no rule", and G1 left `MOVE_PREPS` as the one line written for an operation
// that did not exist — "closer to" ended the thing and read no place, because as an ADD it would have put
// down a second ball. Behind STUDIO_MOVE_OBJECT, on the headline's precedent (PR T).

describe("card 2 — the move op (wave B)", () => {
  const read = (text: string, on = true) => {
    const saved = process.env.STUDIO_MOVE_OBJECT;
    if (on) process.env.STUDIO_MOVE_OBJECT = "true";
    else delete process.env.STUDIO_MOVE_OBJECT;
    try {
      const out = route(text, true);
      return out.initialPath === "ASK"
        ? `ASK ${out.reason}`
        : out.steps
            .map((s) => `${s.op}[${s.targets.join("|")}] ${s.value}`)
            .join(" + ");
    } finally {
      if (saved === undefined) delete process.env.STUDIO_MOVE_OBJECT;
      else process.env.STUDIO_MOVE_OBJECT = saved;
    }
  };

  it("reads a move led by its own verb", () => {
    expect(read("move the ball closer to my feet")).toBe(
      "MOVE_OBJECT[ball] closer to my feet",
    );
    // No surfaces: a move's destination is a PLACE, not a thing the edit also touches. An add records
    // one because it lands ON the thing it names; a move puts its thing near or at one.
    expect(read("move the cone to the bench")).toBe(
      "MOVE_OBJECT[cone] to the bench",
    );
    expect(read("shift the ball to the left")).toBe(
      "MOVE_OBJECT[ball] to the left",
    );
    expect(read("slide the cone next to my feet")).toBe(
      "MOVE_OBJECT[cone] next to my feet",
    );
  });

  it("reads where the thing ALREADY is as which one she means, never as where it goes", () => {
    // Adi's call, 2026-09-17. A locative (on/in/at/by) identifies and is dropped; a directional
    // (to/onto/closer to/next to/toward) is the destination and is required. Read the other way round
    // this came back as MOVE [ball, "ground closer"] to "on the ground closer to my feet" — F-WA3's mangle.
    expect(read("move the ball on the ground closer to my feet")).toBe(
      "MOVE_OBJECT[ball] closer to my feet",
    );
    // With no directional at all there is no destination, so it is not a move and the sentence asks.
    expect(read("move the ball on the ground")).toBe("ASK fast_path_declined");
  });

  it("reads a move whose thing is named before the verb — the G2 repro's clause", () => {
    expect(read("for the ball on the ground move it closer to my feet")).toBe(
      "MOVE_OBJECT[ball] closer to my feet",
    );
    expect(read("for the ball on the ground, move it closer to my feet")).toBe(
      "MOVE_OBJECT[ball] closer to my feet",
    );
    // Bounded: `for` must introduce it — a bare fronted phrase collides with rule 5's reading — and the
    // verb's own slot must be a pronoun, or she named two different things and it is not this sentence.
    expect(read("the ball on the ground move it closer to my feet")).toBe(
      "ASK fast_path_declined",
    );
    expect(read("for the ball, move the cone closer to my feet")).toBe(
      "ASK fast_path_declined",
    );
  });

  it("leaves `put` an add — its move-or-add question is the freeze's, not a rule's", () => {
    // "put the gatorade bottle from image 2 on top of my head" is an add with its source named out loud,
    // and no rule can tell that from a move: whether the thing is in the frame is a fact about the
    // PHOTOGRAPH. So `put` is not a move verb, and these are byte-identical with the flag either way.
    for (const on of [true, false]) {
      expect(read("put the soccer ball on the ground", on)).toBe(
        "ADD_OBJECT[soccer ball|ground] on the ground",
      );
      expect(read("put the ball closer to my feet", on)).toBe(
        "ASK add_unclear",
      );
    }
  });

  it("is INERT with the flag off — every sentence reads exactly as it does on main", () => {
    for (const text of [
      "move the ball closer to my feet",
      "move the cone to the bench",
      "shift the ball to the left",
      "for the ball on the ground move it closer to my feet",
      "move the ball on the ground closer to my feet",
    ]) {
      expect([text, read(text, false)]).toEqual([
        text,
        "ASK fast_path_declined",
      ]);
    }
  });

  it("does not cut a clause at a move verb with the flag off, and does with it on", () => {
    // The flag's other half: `operationAt` reads the move verbs only when it is on, because
    // CLAUSE_JOINERS' verb test is shared by every sentence in the product.
    // Off, no cut: rule 1 claims every noun across "and move", the bench among them.
    expect(read("remove the cone and move the ball to the bench", false)).toBe(
      "REMOVE_OBJECT[cone|ball|bench] null",
    );
    expect(read("remove the cone and move the ball to the bench")).toBe(
      "REMOVE_OBJECT[cone] null + MOVE_OBJECT[ball] to the bench",
    );
  });

  it("asks where one noun names two instances — F-WB3, by design", () => {
    // The G2 card's lead repro, end to end. Both clauses target `ball` and `removesWhatAnotherChanges`
    // fires, because there are TWO balls and the only thing telling them apart is where each one is.
    // A target is a noun handed to detection; per-instance targeting is not in the model. The
    // progression is the win, and it is what this pins:
    //   main  ASK person_target  →  C3a  ASK compound_partial  →  card 2  ASK compound_conflict
    expect(
      read(
        "remove the ball in the air. for the ball on the ground move it closer to my feet.",
      ),
    ).toBe("ASK compound_conflict");
  });
});

// ─── F-WB6 — A BARE `them` TAKES THE THINGS SHE JUST NAMED (wave B) ────────────────────────────────────────

describe("F-WB6 — a bare `them` in a later clause is the things she just named", () => {
  const read = (text: string) => {
    const out = route(text, true);
    return out.initialPath === "ASK"
      ? `ASK ${out.reason}`
      : out.steps
          .map(
            (s) =>
              `${s.op}[${s.targets.join("|")}]${s.value ? "=" + s.value : ""}`,
          )
          .join(" + ");
  };

  /**
   * ⚠️ THE CORPUS CANNOT EVIDENCE THIS ONE, so these cells ARE the evidence. Measured before the fix:
   * the whole plural-pronoun population of the 8,203-sentence corpus is 8 cells and not one is this
   * shape — six are demonstrative determiners with their own `brand_change` family, one routes, and the
   * last leads its sentence with no antecedent. So a corpus diff proves only that nothing broke, and
   * these hand-written cells are what say the reading works (ledger F-WB6).
   */
  /** All three garments recoloured, and all three re-branded — the live sentence's whole answer. */
  const both =
    "RECOLOR[uniform|shoes|socks]=blue + REPLACE_OBJECT[uniform]=adidas uniform + " +
    "REPLACE_OBJECT[shoes]=adidas shoes + REPLACE_OBJECT[socks]=adidas socks";

  it("routes both live forms, with EVERY garment she named in the recolour", () => {
    // Live 2026-09-17, raised in acceptance as a gating regression and measured not to be one: this
    // asked `compound_partial` on pre-wave-A 29b2fc8, on main 7d12dbc and on this branch before the fix.
    expect(
      read(
        "make my uniform, shoes and socks adidas. make them the color blue too.",
      ),
    ).toBe(both);
    // ⚠️ ALL THREE TARGETS, and that is the assertion this test exists for. Rule 5 reads a list only
    // when every target carries its own determiner, so the rewrite emits "the uniform, the shoes and
    // the socks" — a plain join reads RECOLOR[uniform] alone and loses two of her garments silently.
    expect(
      read("make my uniform, shoes and socks adidas. make them blue too."),
    ).toBe(both);
  });

  it("the full stop was never the cause — the and-joined form reads the same", () => {
    // `CLAUSE_JOINERS` has held "." since before wave A and cuts whenever an operation verb follows,
    // and "make" is one. So this asked identically before the fix and routes identically after it.
    expect(
      read("make my uniform, shoes and socks adidas and make them blue"),
    ).toBe(both);
  });

  it("two things, and one thing, resolve the same way", () => {
    expect(read("make the socks and shoes adidas. make them blue.")).toBe(
      "RECOLOR[socks|shoes]=blue + REPLACE_OBJECT[socks]=adidas socks + REPLACE_OBJECT[shoes]=adidas shoes",
    );
    // A single antecedent still resolves: "them" for one thing is loose English, and she plainly means
    // the jersey. Nothing is guessed — the target came from the clause before it.
    expect(read("change my jersey to adidas. make them blue.")).toBe(
      "RECOLOR[jersey]=blue + REPLACE_OBJECT[jersey]=adidas jersey",
    );
  });

  it("`replace X with <brand>` reads too — the link, not only the verb (E1)", () => {
    // RV-e1b found this missing: removing `with` from BRAND_LINKS flipped NOTHING, because every E1
    // pin used the "to be" form. A revert check that flips nothing is a pin that is not there.
    expect(read("replace the nike logo with adidas")).toBe(
      "REPLACE_OBJECT[nike logo]=adidas logo",
    );
    expect(read("replace my jersey with adidas")).toBe(
      "REPLACE_OBJECT[jersey]=adidas jersey",
    );
    // ⚠️ AND RULE 3½ STILL OWNS A POINTED REPLACEMENT — the photo, not the brand word, decides. With
    // NO photo attached (this helper attaches none) a pointer asks, exactly as it did before E1; the
    // attached case is pinned through the freeze in nativeIntent.test.ts, where references exist.
    expect(read("replace the earrings with these adidas hoops")).toBe(
      "ASK object_photo_missing",
    );
  });

  it("⚠️ `it` resolves for a COLOUR and never for a look — the fence moved to the VALUE (E4)", () => {
    // 75 corpus cells route "make it warmer / moodier / golden hour" as a LOOK, which is why `it` was
    // held back when F-WB6 shipped. Adi lifted the fence on 2026-09-17 with the discriminator that
    // makes it safe: the VALUE. A colour is never a look, so an `it` clause resolves only when the
    // re-read comes back a RECOLOUR — and the look family is untouched. Measured across every `it`
    // sentence in the corpus: 141 sentences, 423 cells, 295 routing, and ZERO routing cells moved.
    // These three are that family.
    expect(read("make it warmer")).toBe("GLOBAL_STYLE[]=warmer");
    expect(read("change the background to a stadium and make it moodier")).toBe(
      "GLOBAL_STYLE[]=moodier + CHANGE_BACKGROUND[person]=stadium",
    );
    expect(read("make my socks blue. make it warmer.")).toBe(
      "RECOLOR[socks]=blue + GLOBAL_STYLE[]=warmer",
    );
    // And the singular twin of the live sentence RESOLVES now — its value is a colour. It used to be
    // pinned here as asking; that was the fence, and this is what replaced it.
    expect(read("make my jersey adidas. make it blue.")).toBe(
      "RECOLOR[jersey]=blue + REPLACE_OBJECT[jersey]=adidas jersey",
    );
    // ⚠️ AND A LOOK AFTER THE SAME BRAND CLAUSE STILL MEANS THE PHOTOGRAPH, which is the pair that
    // makes the discriminator visible: same sentence shape, different value, different answer.
    expect(read("make my jersey adidas. make it golden hour.")).toBe(
      "GLOBAL_STYLE[]=golden hour + REPLACE_OBJECT[jersey]=adidas jersey",
    );
  });

  it("reaches the thing she just ADDED — a thing about to be in the frame is a thing in it (wave D, card 3)", () => {
    // "add a headband and make it red" asked `compound_partial`: clause 2 does not read alone, so the
    // resolver fired and found no antecedent, because the only earlier clause was an ADD. Her headband
    // is as much a thing in the frame as one she is recolouring — the edit is simply about to put it
    // there. Acceptance B6.
    expect(read("add a headband and make it red")).toBe(
      'ADD_OBJECT[headband]=on my head + RECOLOR[headband]=red',
    );
    // `them` reads the same list, so the plural form comes with it.
    expect(read("add hoops to my ears and make them gold")).toBe(
      'ADD_OBJECT[hoops]=to my ears + RECOLOR[hoops]=gold',
    );
    // ⚠️ AND A LOOK STILL MEANS THE PHOTOGRAPH, not the thing she just added. "make it warmer" READS
    // on its own (rule 5¾), so the resolver never fires on it and composition routes the two clauses
    // as the different operations they are — unchanged on both sides of this card's corpus diff.
    expect(read("add a headband and make it warmer")).toBe(
      "ADD_OBJECT[headband]=on my head + GLOBAL_STYLE[]=warmer",
    );
  });

  it("⚠️ never resolves against an antecedent that names HER", () => {
    // `CHANGE_BACKGROUND`'s step target is `person`, so a background antecedent would rewrite "make
    // them blue" into a recolour OF THE ATHLETE. `GLOBAL_STYLE` carries no target at all. The
    // antecedent allow-list is what makes both unrepresentable, and this is its test.
    expect(read("change the background to a stadium. make them blue.")).toBe(
      "ASK compound_partial",
    );
    expect(read("make it warmer. make them blue.")).toBe(
      "ASK compound_partial",
    );
  });

  it("leaves the demonstrative family exactly where it was", () => {
    // `these` and `those` are DETERMINERS here, not bare pronouns, and they have their own reason.
    for (const text of [
      "make these cleats pink adidas",
      "make these socks nike",
      "make those adidas",
      "turn these into adidas ones",
    ]) {
      expect({ text, read: read(text) }).toEqual({
        text,
        read: "ASK brand_change",
      });
    }
    expect(read("make these hoops on my ears black and white")).toBe(
      "ASK person_target",
    );
    // Unchanged from main, where it reads the same: a demonstrative before a plural noun is a
    // determiner, and "pics" sends the whole photograph's look.
    expect(read("make these pics black and white")).toBe(
      "GLOBAL_STYLE[]=black and white",
    );
  });

  it("a bare `them` LEADING the sentence has no antecedent, and is left asking", () => {
    expect(read("make them yellow because the brand asked")).toBe(
      "ASK fast_path_declined",
    );
  });
});

// ─── WAVE D, CARD 4 / J7 — WORN ON THE ARM AND AT THE NECK ──────────────────────────────────────────

describe("J7 — an armband and a scarf are worn things, and an armband's place is the ARM", () => {
  const read = (text: string) => {
    const out = route(text, true);
    return out.initialPath === "ASK"
      ? `ASK ${out.reason}`
      : out.steps
          .map((s) => `${s.op}[${s.targets.join("|")}]=${s.value}`)
          .join(" + ");
  };

  it("routes a bare armband and a bare scarf to the part of her each is worn on", () => {
    // Both asked `add_unclear` before: neither word was on WORN_ITEMS, so rule 3¾b never claimed
    // them and an add with no place said has nothing to anchor (acceptance J7).
    expect(read("add an armband")).toBe('ADD_OBJECT[armband]=on my arm');
    expect(read("add a scarf")).toBe('ADD_OBJECT[scarf]=around my neck');
    // She may say the place herself, and it is consumed as the place rather than kept as a target.
    expect(read("add an armband on my arm")).toBe(
      'ADD_OBJECT[armband]=on my arm',
    );
  });

  it("⚠️ a sleeve is still a LOCATION, not a worn thing — V4's reading is untouched", () => {
    // "sleeve" was deliberately left off WORN_ITEMS: V4 reads a phrase after on/from/off as where a
    // removed thing IS, and a sleeve on the list would make it a thing to remove instead.
    expect(read("remove the logo from my sleeve")).toBe(
      "REMOVE_OBJECT[logo]=null",
    );
  });

  it("⚠️ and a captain's armband is still the INTERPRETER's, by design", () => {
    // `TOKEN` carries no apostrophe, so "captain's" arrives as two words, and "captain" is not on
    // rule 4c's descriptor list — which is closed to COLOURS and style words on purpose, because the
    // line between a descriptor and a model name is not one a rule can see. So the sentence asks
    // `worn_add_unclear`, which `ASK_DECISIONS` sends to the interpreter: exactly the deferral M3
    // wrote that code for. What this card changed is that the paraphrase it comes back with now has
    // somewhere to land.
    expect(read("add a captain's armband")).toBe("ASK worn_add_unclear");
  });
});

// ─── WAVE D, CARD 4 / A15 — HER COLOUR AS SHE SAID IT ───────────────────────────────────────────────

describe("A15 — a finish adjective survives into the RECOLOR value", () => {
  const valueOf = (text: string) => route(text, true).steps[0]?.value ?? null;

  it("keeps the modifier she put in front of the colour", () => {
    // "matte" is already on COLOR_MOD — it is why the TARGET phrase stops before it — but the value
    // was the bare colour, so her adjective was read and then dropped. The compiled PROMPT carried
    // her whole phrase, so the prompt and the frozen step disagreed (acceptance A15).
    expect(valueOf("make my cleats matte black")).toBe("matte black");
    expect(valueOf("make the socks light blue")).toBe("light blue");
    expect(valueOf("make the jersey metallic gold")).toBe("metallic gold");
  });

  it("leaves a bare colour, a hex and a TWO-TONE value exactly as they were", () => {
    expect(valueOf("make the socks blue")).toBe("blue");
    expect(valueOf("make the jersey #ff0000")).toBe("#ff0000");
    // ⚠️ TWO COLOURS IS A DIFFERENT DISCRIMINATOR AND IS NOT TAKEN HERE. "black and green" still
    // freezes "black"; A3/R5 stay open, and closing them interacts with the per-target split.
    expect(valueOf("make the shorts black and green")).toBe("black");
  });
});

// ─── WAVE D, CARD 5 — A THING IN HER HAND ───────────────────────────────────────────────────────────

describe("card 5 — an object may be put IN her hand, if a hand is the size of it", () => {
  const read = (text: string) => {
    const out = route(text, true);
    return out.initialPath === "ASK"
      ? `ASK ${out.reason}`
      : out.steps
          .map((s) => `${s.op}[${s.targets.join("|")}]=${s.value}`)
          .join(" + ");
  };

  it("routes a hand-sized thing into her hand, by every wording that reaches it", () => {
    // Q8 rendered one-hand objects 7/7 across hand states and both wordings. "in" was the blocker:
    // it was on no add-preposition list, so the sentence people actually type asked `add_unclear`
    // while `near my hand` had routed all along.
    expect(read("add a phone in my hand")).toBe('ADD_OBJECT[phone]=in my hand');
    expect(read("add a phone to my hand")).toBe('ADD_OBJECT[phone]=to my hand');
    expect(read("add a water bottle in my hands")).toBe(
      'ADD_OBJECT[water bottle]=in my hands',
    );
    // Already routed before this card, by a non-contact preposition — and still does.
    expect(read("add a phone near my hand")).toBe(
      'ADD_OBJECT[phone]=near my hand',
    );
  });

  it("⚠️ refuses a large or two-handed thing, exactly as it did — the size guard", () => {
    // The ball was the only object that ever failed in Q8, and it grew a third arm. The probe is
    // explicit that 2 of its 4 cells were CLEAN, so this is a decision not to ship a coin flip
    // rather than a finding that it cannot be rendered — see HAND_SIZED's note before widening it.
    expect(read("add a ball in my hand")).toBe("ASK add_unclear");
    expect(read("add a ball to my hand")).toBe("ASK person_target");
    expect(read("add a trophy in my hand")).toBe("ASK add_unclear");
  });

  it("⚠️ `in` is the in-hand reading and NOTHING else — no other place changed", () => {
    // Admitting "in" as a surface everywhere would make this an edit to the net. It is admitted only
    // for her hand, and every other "in …" returns no place — the same answer the parser gave when
    // the word was on no list at all.
    expect(read("add a ball in the net")).toBe("ASK add_unclear");
    // A longer spatial preposition still wins over the one-word surface.
    expect(read("add a ball in the middle of the field")).toBe(
      'ADD_OBJECT[ball]=in the middle of the field',
    );
    // The other resting places are unguarded, as before — only a HAND asks about size.
    expect(read("add a hat on my head")).toBe('ADD_OBJECT[hat]=on my head');
  });
});

// ─── WAVE D, CARD 2 — THE COLOUR SHE GAVE EACH THING ────────────────────────────────────────────────

/**
 * Rule 5's `value` is `firstMatch` over the whole sentence: ONE colour, however many things she named.
 * So "make the jersey red and the shorts black" carried `RECOLOR [jersey, shorts] "red"`, the pairing
 * existed nowhere in the routing, and the freeze had to recover it from detection's labels. Live,
 * detection wrote the bare colours ["red","black"], which pair to no target, and the preview blocked
 * with the rephrase line — she had named every colour explicitly (acceptance B13, H5, R6).
 *
 * ⚠️ THE STEP IS NOT SPLIT, AND THAT IS THE DESIGN. `op`, `targets`, `value` and `scope` are byte for
 * byte what they were; `values` rides beside them. Every one of composition's decision-2a pins compares
 * a PROJECTION of [op, targets, value] (classify.test.ts, the two INVARIANT describes above, and C3a's
 * "leaves a sentence with no stop exactly as it was"), so 2a is not engaged and needs no overturning.
 * The freeze already emitted one change per target whatever the step shape, and native compiles every
 * change into ONE call — two steps were never two renders.
 */
describe("WAVE D, CARD 2 — a multi-target recolour carries the colour she gave each target", () => {
  const read = (text: string) => {
    const s = route(text, true).steps[0];
    return s ? [s.op, s.targets, s.value, s.values ?? null] : null;
  };

  it("pairs each target with its own colour, and leaves the step's shape untouched", () => {
    expect(read("make the jersey red and the shorts black")).toEqual([
      "RECOLOR",
      ["jersey", "shorts"],
      "red",
      ["red", "black"],
    ]);
    // B13 and H5 — three targets, three colours, still ONE step.
    expect(
      read("make the jersey red and the shorts black and the socks white"),
    ).toEqual([
      "RECOLOR",
      ["jersey", "shorts", "socks"],
      "red",
      ["red", "black", "white"],
    ]);
    // Her possessive, and the verb said twice — the same reading either way (B-c2).
    expect(read("make her jersey blue and her socks red")).toEqual([
      "RECOLOR",
      ["jersey", "socks"],
      "blue",
      ["blue", "red"],
    ]);
    expect(read("make the jersey blue, and make the socks red")).toEqual([
      "RECOLOR",
      ["jersey", "socks"],
      "blue",
      ["blue", "red"],
    ]);
  });

  it("reads each colour as COLOUR_PHRASE does — the modifier included (A15), and a hex", () => {
    // The same expression at both places: `value` and every `values` entry are one modifier at most,
    // immediately before the colour. A sentence with one target cannot disagree with itself.
    expect(
      read("make the jersey light blue and the shorts matte black"),
    ).toEqual([
      "RECOLOR",
      ["jersey", "shorts"],
      "light blue",
      ["light blue", "matte black"],
    ]);
    expect(read("make the jersey #ff0000 and the shorts black")).toEqual([
      "RECOLOR",
      ["jersey", "shorts"],
      "#ff0000",
      ["#ff0000", "black"],
    ]);
  });

  it("⚠️ ONE COLOUR OVER SEVERAL TARGETS IS NOT THIS SHAPE — sweep 3.1's A2, unmoved", () => {
    // The reader needs a colour after EVERY target and "and" is not one, so nothing pairs and the
    // single multi-target step is exactly what it was. This is the step shape the freeze's `sole`
    // guard is written against: pairing it would give the shorts black off a reading she never gave.
    expect(read("make the jersey and the shorts black")).toEqual([
      "RECOLOR",
      ["jersey", "shorts"],
      "black",
      null,
    ]);
    // A2 is decided: "shorts" without its own determiner is dropped, one target, and unchanged here.
    expect(read("make the jersey and shorts black")).toEqual([
      "RECOLOR",
      ["jersey"],
      "black",
      null,
    ]);
  });

  it("⚠️ and a TWO-TONE declines the WHOLE sentence rather than taking half of it", () => {
    // "make the shorts black and green" is one target — below the floor of two — and its label carries
    // "black and green" where the step's value carries "black" (F-WB7's measured 8 red cells, Q5's
    // prompt). Combined with a second target, pairing would read "black" for the shorts and silently
    // drop her "and green". A colour that runs on into a second colour is A3/R5's discriminator and its
    // own card, so this reader stops — and the labels keep the sentence, exactly as today.
    expect(read("make the shorts black and green")).toEqual([
      "RECOLOR",
      ["shorts"],
      "black",
      null,
    ]);
    expect(read("make the shorts black and green and the socks white")).toEqual(
      ["RECOLOR", ["shorts", "socks"], "black", null],
    );
  });

  it("⚠️ fail-closed: a target with no colour of its own pairs NOTHING, for any of them", () => {
    // Every disagreement is a no-op rather than a different reading.
    expect(read("make the jersey red and the shorts")).toEqual([
      "RECOLOR",
      ["jersey", "shorts"],
      "red",
      null,
    ]);
    // A single target never pairs: that is `sole`'s case, and the freeze's own fallback is right there.
    expect(read("make the socks blue")).toEqual([
      "RECOLOR",
      ["socks"],
      "blue",
      null,
    ]);
    // A phrase `regionTargets` DROPS — the worn location (decision 2) — makes the sequences differ, so
    // the reader declines rather than pairing a colour onto a target list it does not recognise.
    expect(read("change the earrings in my ears to gold")).toEqual([
      "RECOLOR",
      ["earrings"],
      "gold",
      null,
    ]);
  });

  it("⚠️ G3's compounds still decline, and a pronoun clause pairs nothing", () => {
    // The colour compounds are taken out before this reads, as rule 5 takes them out of its own value.
    expect(
      route("me walking the red carpet at an awards show", true).initialPath,
    ).toBe("ASK");
    // F-WB6: "make them the color blue too" — she said the colour ONCE, about things named in the
    // clause before. `fromPronoun` is what lets the freeze use her word, and `values` stays out of it.
    const pronoun = route(
      "make my uniform, shoes and socks adidas. make them the color blue too.",
      true,
    ).steps.find((s) => s.op === "RECOLOR");
    expect(pronoun?.values).toBeUndefined();
    expect(pronoun?.fromPronoun).toBe(true);
  });
});
