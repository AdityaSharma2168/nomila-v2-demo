/**
 * keepVocab.test.ts — her keep, beside an edit the rules read (A3b; sweep-4 ledger F-L2): set aside, frozen
 * beside the steps as `preserve_person`, never a target, never dropped, never region text — and only where
 * her sentence already routes (Adi's Option A).
 *
 * ⚠️ EVERY SENTENCE IS WRITTEN OUT BY HAND, and so is every sentence it must NOT move
 * (docs/runbooks/verifying-a-guard-bites.md). The 25 rows below are the whole of what A3b changes.
 *
 * The preservation fixes (2026-09-16) widen it by one condition: a sentence the rules refused as an edit of
 * her, because they read her keep as one, routes with her keep beside it (ledger F-L5, D1) — and the set reads
 * her face, hair, body or pose kept or preserved by name (D2).
 */
import { classifyFast, declineReason, route, validate } from "./classify";
import { readKeep, readThingKeep } from "./keepVocab";

/** What route() makes of a sentence with her photo, with her keep when it rides beside the steps. */
function read(text: string, photo = true): string {
  const r = route(text, photo);
  if (r.initialPath === "ASK") return `ASK ${r.reason}`;
  const steps = r.steps
    .map(
      (s) =>
        `${s.op}${s.targets.length ? `[${s.targets.join("|")}]` : ""}${s.value ? ` ${s.value}` : ""}`,
    )
    .join(" + ");
  return r.constraints?.length
    ? `${steps} +${r.constraints.map((c) => c.kind).join(",")}`
    : steps;
}

/** What the rules and their guard make of her WHOLE sentence, keep and all — `route` before any keep is set aside. */
function readWhole(text: string): string {
  const fast = classifyFast(text, true);
  if (!fast) return `ASK ${declineReason(text)}`;
  const r = validate(fast, true, text);
  if (r.initialPath === "ASK") return `ASK ${r.reason}`;
  return r.steps
    .map(
      (s) =>
        `${s.op}${s.targets.length ? `[${s.targets.join("|")}]` : ""}${s.value ? ` ${s.value}` : ""}`,
    )
    .join(" + ");
}

describe("readKeep — her keep, as one whole clause, first or last", () => {
  it("reads every wording in the set, and gives back the rest in her own words", () => {
    const cases: [string, string][] = [
      ["make it warmer, dont change anything about me", "make it warmer"],
      ["make it warmer, don't change anything about me", "make it warmer"],
      ["make it warmer, don’t change anything about me", "make it warmer"],
      ["make it warmer but do not change me", "make it warmer"],
      ["make it warmer, dont change my face", "make it warmer"],
      ["make it warmer, dont change my hair", "make it warmer"],
      ["make it warmer, dont change my body", "make it warmer"],
      ["make it warmer, dont change my pose", "make it warmer"],
      ["make it golden hour, keep me the same", "make it golden hour"],
      ["make it golden hour, keep me exactly the same", "make it golden hour"],
      ["make it warmer, keep me as I am", "make it warmer"],
      ["Make It Warmer, Keep Me Exactly As I Am.", "Make It Warmer"],
      [
        "make my jersey blue and keep everything else the same",
        "make my jersey blue",
      ],
      [
        "make my jersey blue, keep everything else exactly the same",
        "make my jersey blue",
      ],
      ["make the socks blue and change nothing else", "make the socks blue"],
      // Joined by a word, or by nothing but a space, and with her politeness around it.
      ["make it warmer and please keep me the same", "make it warmer"],
      ["make it warmer dont change me", "make it warmer"],
      ["make it warmer, dont change me please", "make it warmer"],
      // First, not last.
      ["dont change me, just make it warmer", "make it warmer"],
      ["keep me the same and make it warmer", "make it warmer"],
      // One at each end.
      ["dont change me, make it warmer, keep me the same", "make it warmer"],
      // Her face, hair, body or pose kept or preserved, by name (the preservation fixes, D2). The first was
      // pinned as NOT read below, until D2: its flip is intended. It still asks — see the route() pins.
      ["make it brighter, keep my face the same", "make it brighter"],
      ["make my jersey blue, keep my face the same", "make my jersey blue"],
      ["make it warmer, keep my hair exactly the same", "make it warmer"],
      ["make it warmer, keep my pose as it is", "make it warmer"],
      [
        "make it warmer, keep my body as it is as much as possible",
        "make it warmer",
      ],
      ["make it warmer, preserve my face", "make it warmer"],
      ["make my jersey blue but preserve the face", "make my jersey blue"],
      [
        "change the background to a beach, preserve my face as much as possible",
        "change the background to a beach",
      ],
      ["preserve the face, make it warmer", "make it warmer"],
    ];
    expect(cases.map(([s]) => [s, readKeep(s)?.rest ?? null])).toEqual(cases);
  });

  it("reads nothing where there is no edit beside her keep, or the keep is not hers, or not in the set", () => {
    for (const s of [
      // Her keep alone — nothing to route.
      "keep me the same",
      "dont change anything about me",
      "dont change my face",
      // A keep of a THING — not her (ledger F-L4).
      "keep the jersey the same and make the socks blue",
      "make the socks blue but keep the jersey the same",
      "dont change the background, just make it warmer",
      "make it warmer but leave the background alone",
      // Our own compiled words, never hers.
      "change the background to a beach at sunset, keep the person exactly as-is",
      "make the shorts black and green. Keep everything else exactly as-is — change only the shorts.",
      // Wordings not in the set, and a keep in the middle. ("make it brighter, keep my face the same" stood
      // here until D2 put "keep my face the same" in the set — its flip is intended.)
      "keep my smile, make it warmer",
      "make it warmer, preserve her face",
      "make it warmer, keep my face",
      "make it warmer, preserve my smile",
      // "within the reference image" is no hedge the set reads — her live sentence's keep, beside an edit.
      "make it warmer, preserve the face as much as possible within the reference image",
      "make it warmer, dont change me, and make the jersey blue",
      // "the same" that is not a keep at all.
      "make the jersey the same blue as the shorts",
      "make my socks the same colour as my jersey",
      "",
    ]) {
      expect({ s, keep: readKeep(s) }).toEqual({ s, keep: null });
    }
  });
});

describe("route() — her keep, beside an edit the rules read (A3b)", () => {
  it("moves exactly these 25 sentences, each route → route with her keep beside the steps", () => {
    // The whole of A3b's route diff, before and after written in the body. 12 were misreads that come out
    // clean — "the same" as a target (8: the three repros' mechanism) and her keep inside rule 2's value
    // (4); the other 13 read the same steps as before, and gain her keep.
    const cases: [string, string][] = [
      // Rule 3 — the look, her keep had been dropped.
      [
        "make it warmer, dont change anything about me",
        "GLOBAL_STYLE warmer +preserve_person",
      ],
      [
        "make it warmer, don't change anything about me",
        "GLOBAL_STYLE warmer +preserve_person",
      ],
      [
        "make it warmer but dont change me",
        "GLOBAL_STYLE warmer +preserve_person",
      ],
      [
        "make it warmer, keep me exactly as i am",
        "GLOBAL_STYLE warmer +preserve_person",
      ],
      [
        "dont change me, just make it warmer",
        "GLOBAL_STYLE warmer +preserve_person",
      ],
      // Rule 5 — "the same" had been the recolour's target: "make the same golden", "make the same black".
      [
        "make it golden hour, keep me the same",
        "GLOBAL_STYLE golden hour +preserve_person",
      ],
      [
        "make it black and white, keep me the same",
        "GLOBAL_STYLE black and white +preserve_person",
      ],
      [
        "make it black and white and keep everything else the same",
        "GLOBAL_STYLE black and white +preserve_person",
      ],
      [
        "make my jersey blue and keep me the same",
        "RECOLOR[jersey] blue +preserve_person",
      ],
      [
        "make my jersey blue, keep everything else the same",
        "RECOLOR[jersey] blue +preserve_person",
      ],
      [
        "make my jersey blue, dont change anything about me",
        "RECOLOR[jersey] blue +preserve_person",
      ],
      [
        "make my jersey red but keep me exactly as i am",
        "RECOLOR[jersey] red +preserve_person",
      ],
      // Rule 1 — "remove the same and fill the space…" beside the cone.
      [
        "remove the cone and keep me the same",
        "REMOVE_OBJECT[cone] +preserve_person",
      ],
      [
        "remove the cone, keep everything else the same",
        "REMOVE_OBJECT[cone] +preserve_person",
      ],
      [
        "remove the cone, dont change anything about me",
        "REMOVE_OBJECT[cone] +preserve_person",
      ],
      // Rule 4a — "add logo to the same".
      [
        "add the logo to my jersey, keep me the same",
        "APPLY_DESIGN[jersey] logo +preserve_person",
      ],
      [
        "put a nike logo on my shorts but dont change me",
        "APPLY_DESIGN[shorts] nike logo +preserve_person",
      ],
      // Rule 2 — her keep had been the setting: "change the background to beach but dont change me".
      [
        "change the background to a beach but dont change me",
        "CHANGE_BACKGROUND[person] beach +preserve_person",
      ],
      [
        "change the background to a stadium and keep me the same",
        "CHANGE_BACKGROUND[person] stadium +preserve_person",
      ],
      [
        "change the background to a beach and keep everything else the same",
        "CHANGE_BACKGROUND[person] beach +preserve_person",
      ],
      [
        "put me on a beach but dont change my face",
        "CHANGE_BACKGROUND[person] beach +preserve_person",
      ],
      [
        "change the background to a beach, dont change anything about me",
        "CHANGE_BACKGROUND[person] beach +preserve_person",
      ],
      [
        "change the background to a stadium, keep me exactly as i am",
        "CHANGE_BACKGROUND[person] stadium +preserve_person",
      ],
      // Rule ½ — a compound; her keep had been dropped.
      [
        "make her jersey blue and change the background to a stadium, keep me the same",
        "RECOLOR[jersey] blue + CHANGE_BACKGROUND[person] stadium +preserve_person",
      ],
      [
        "make it warmer and change the background to a beach, dont change anything about me",
        "GLOBAL_STYLE warmer + CHANGE_BACKGROUND[person] beach +preserve_person",
      ],
    ];
    expect(cases).toHaveLength(25);
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
    // And the rules read what is left: detection and the freeze read it too (nativeIntent.test.ts).
    expect(route("make it golden hour, keep me the same", true).readAs).toBe(
      "make it golden hour",
    );
  });

  it("asks where what is left asks — main removed 'the same' beside a pronoun (the fail-closed path)", () => {
    // Her sentence routed on main only because the rules read her keep as a thing: "remove it, keep me the
    // same" froze REMOVE_OBJECT [same] — "remove the same and fill the space where it was…". Set aside, what
    // is left is "remove it", which names nothing, so it asks, as "remove it" alone always has. Found while
    // writing A3b's revert checks; neither sentence was in the recon.
    const cases: [string, string][] = [
      ["remove it, keep me the same", "ASK fast_path_declined"],
      ["remove it and keep everything else the same", "ASK fast_path_declined"],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
  });

  it("leaves every ASK as it was — the interpreter's (Option A)", () => {
    const cases: [string, string][] = [
      // The interpreter reads these, look and keep together, as it did.
      [
        "make it moodier, dont change anything about me",
        "ASK fast_path_declined",
      ],
      ["make it warmer and keep me the same", "ASK fast_path_declined"],
      ["keep me the same and make it warmer", "ASK fast_path_declined"],
      [
        "add a soccer ball between my cleats, keep everything else the same",
        "ASK add_unclear",
      ],
      ["make the socks blue and change nothing else", "ASK compound_partial"],
      [
        "turn my socks into adidas ones please and keep me the same",
        "ASK brand_change",
      ],
      [
        "turn this into an adidas ad. dont change anything about me",
        "ASK brand_change",
      ],
      // D2 reads her keep in these, and they still ask: their ask is not a person refusal, so it stays the
      // interpreter's (D1). The first is the A3b pin D2 flipped at readKeep — at route() it does not move.
      ["make it brighter, keep my face the same", "ASK fast_path_declined"],
      ["make it warmer, dont change my pose", "ASK fast_path_declined"],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
  });

  // Renamed by the preservation fixes: its two F-L4 rows ("keep the jersey the same and make the socks blue")
  // are a keep of a thing now, set aside — see the K2 block below.
  it("leaves everything else as the rules read it — our own words, a comparison, no photo, a new image", () => {
    const cases: [string, string][] = [
      // Our compiled wording, not hers — main's reading, the keep not read.
      [
        "change the background to a beach at sunset, keep the person exactly as-is",
        "CHANGE_BACKGROUND[person] beach at sunset",
      ],
      // A comparison, not a keep.
      [
        "make the jersey the same blue as the shorts",
        "RECOLOR[jersey|same|shorts] blue",
      ],
      ["make it warmer", "GLOBAL_STYLE warmer"],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
    // With no photo there is no intent to ride — rule 0's new image, as before, and no keep beside it.
    const noPhoto = route(
      "make it warmer, dont change anything about me",
      false,
    );
    expect(noPhoto.steps.map((s) => s.op)).toEqual(["GENERATE"]);
    expect(noPhoto.constraints).toBeUndefined();
    expect(
      route("generate a new poster of me, dont change my face", true)
        .constraints,
    ).toBeUndefined();
  });
});

describe("route() — a person refusal her keep caused routes, her keep beside it (ledger F-L5)", () => {
  it("routes the ledger's four, and each the rules refused only because they read her keep as an edit of her", () => {
    // The whole of F-L5's route diff, before and after in the PR body. Read whole, each was refused by the
    // person guard (`person_target`) or the fall-through (`person_mentioned`): "my face" was a target beside
    // the jersey, and her keep broke the worn add's shape, so rule 5 recoloured her ears "gold".
    const cases: [string, string, string][] = [
      // The ledger's four.
      [
        "make it warmer, dont change my face",
        "ASK person_mentioned",
        "GLOBAL_STYLE warmer +preserve_person",
      ],
      [
        "make my jersey blue, dont change my face",
        "ASK person_target",
        "RECOLOR[jersey] blue +preserve_person",
      ],
      [
        "add gold hoops to my ears, dont change my face",
        "ASK person_target",
        "ADD_OBJECT[gold hoops] to my ears +preserve_person",
      ],
      [
        "add gold hoops to my ears, keep everything else the same",
        "ASK person_target",
        "ADD_OBJECT[gold hoops] to my ears +preserve_person",
      ],
      // The same class in the corpus: her hair, her body.
      [
        "make it warmer, dont change my hair",
        "ASK person_mentioned",
        "GLOBAL_STYLE warmer +preserve_person",
      ],
      [
        "make it warmer, dont change my body",
        "ASK person_mentioned",
        "GLOBAL_STYLE warmer +preserve_person",
      ],
      // D2's wordings, which asked the same way.
      [
        "make my jersey blue, keep my face the same",
        "ASK person_target",
        "RECOLOR[jersey] blue +preserve_person",
      ],
      [
        "make it warmer, preserve my face",
        "ASK person_mentioned",
        "GLOBAL_STYLE warmer +preserve_person",
      ],
      [
        "make my jersey blue but preserve the face",
        "ASK person_target",
        "RECOLOR[jersey] blue +preserve_person",
      ],
    ];
    // Main's answer still stands for the WHOLE sentence — the rules and the guard are unchanged, and only
    // `route` sets her keep aside.
    expect(cases.map(([s]) => [s, readWhole(s)])).toEqual(
      cases.map(([s, main]) => [s, main]),
    );
    expect(cases.map(([s]) => [s, read(s)])).toEqual(
      cases.map(([s, , now]) => [s, now]),
    );
    expect(route("make my jersey blue, dont change my face", true).readAs).toBe(
      "make my jersey blue",
    );
  });

  it("adds her keep beside a D2 wording where the sentence already routed (A3b's path)", () => {
    expect(
      read(
        "change the background to a beach, preserve my face as much as possible",
      ),
    ).toBe("CHANGE_BACKGROUND[person] beach +preserve_person");
  });

  it("refuses an edit of her beside her keep exactly as before — the rest is read by the same guard", () => {
    const cases: [string, string][] = [
      ["make my arms bigger, dont change my face", "ASK person_mentioned"],
      ["make my face thinner, dont change my hair", "ASK person_mentioned"],
      // The rest asks too, and not with a person code: her sentence keeps the code it always had, so a
      // sentence the rules refused never becomes one the interpreter may take (D1).
      ["remove it, dont change my face", "ASK person_target"],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
  });
});

describe("readThingKeep — a keep of a thing, as one whole clause, first or last (ledger F-L4, K2)", () => {
  it("reads each of the four wordings, and gives back the rest in her words, the thing, and which end", () => {
    const cases: [string, string, string, "first" | "last"][] = [
      // keep
      [
        "make the socks blue but keep the jersey the same",
        "make the socks blue",
        "jersey",
        "last",
      ],
      [
        "keep the jersey the same and make the socks blue",
        "make the socks blue",
        "jersey",
        "first",
      ],
      [
        "make the socks blue, keep my cleats",
        "make the socks blue",
        "cleats",
        "last",
      ],
      [
        "keep my cleats and make the socks blue",
        "make the socks blue",
        "cleats",
        "first",
      ],
      [
        "make the socks blue and keep my cleats as they are",
        "make the socks blue",
        "cleats",
        "last",
      ],
      [
        "remove the cone and keep the ball where it is",
        "remove the cone",
        "ball",
        "last",
      ],
      [
        "remove the goalpost but keep the ball",
        "remove the goalpost",
        "ball",
        "last",
      ],
      // leave … alone / as it is
      [
        "make the socks blue but leave the cleats alone",
        "make the socks blue",
        "cleats",
        "last",
      ],
      [
        "make it warmer but leave the background as it is",
        "make it warmer",
        "background",
        "last",
      ],
      // dont change
      [
        "make the socks blue but dont change the cleats",
        "make the socks blue",
        "cleats",
        "last",
      ],
      [
        "make the socks blue but don't change my red cleats",
        "make the socks blue",
        "red cleats",
        "last",
      ],
      [
        "dont change my cleats, make the socks blue",
        "make the socks blue",
        "cleats",
        "first",
      ],
      // dont touch
      [
        "make the socks blue but dont touch my cleats",
        "make the socks blue",
        "cleats",
        "last",
      ],
      [
        "make the socks blue but do not touch my cleats please",
        "make the socks blue",
        "cleats",
        "last",
      ],
    ];
    expect(cases.map(([s]) => [s, readThingKeep(s)])).toEqual(
      cases.map(([s, rest, thing, at]) => [s, { rest, thing, at }]),
    );
  });

  it("reads nothing that is not one thing kept, whole, at one end", () => {
    for (const s of [
      // A particle, a pronoun, everything else: not one thing kept. ("remove the net, keep the ball, cone and bench"
      // stood here until wave A's V6 read a list — its own block below.)
      "make the socks blue, keep the cone away",
      "make the socks blue, keep it",
      "make the socks blue and keep everything else the same",
      // "leave" needs its "alone" — "leave the cone" is not a keep.
      "remove the ball but leave the cone",
      // In the middle.
      "make the socks blue, keep my cleats, and remove the ball",
      // Nothing beside it.
      "keep the jersey the same",
      "",
    ]) {
      expect({ s, keep: readThingKeep(s) }).toEqual({ s, keep: null });
    }
  });
});

describe("route() — a keep of a thing is set aside, and the rest routes or asks (ledger F-L4, K2)", () => {
  it("routes the rest where the kept thing was a target, a value or a misread — never the thing she kept", () => {
    // Main, then the preservation fixes. Nothing rides beside the steps: the scope sentence every native compile
    // writes keeps what she did not name.
    const cases: [string, string, string][] = [
      // Rule 5 took it as a recolour target.
      [
        "keep the jersey the same and make the socks blue",
        "RECOLOR[jersey|same|socks] blue",
        "RECOLOR[socks] blue",
      ],
      [
        "make the socks blue but keep the jersey the same",
        "RECOLOR[socks|jersey|same] blue",
        "RECOLOR[socks] blue",
      ],
      [
        "make the socks blue, keep my cleats",
        "RECOLOR[socks|cleats] blue",
        "RECOLOR[socks] blue",
      ],
      [
        "keep my cleats and make the socks blue",
        "RECOLOR[cleats|socks] blue",
        "RECOLOR[socks] blue",
      ],
      [
        "make the socks blue and keep my cleats the same",
        "RECOLOR[socks|cleats|same] blue",
        "RECOLOR[socks] blue",
      ],
      [
        "make the socks blue but leave the cleats alone",
        "RECOLOR[socks|cleats alone] blue",
        "RECOLOR[socks] blue",
      ],
      [
        "make the socks blue but dont change the cleats",
        "RECOLOR[socks|cleats] blue",
        "RECOLOR[socks] blue",
      ],
      [
        "make the socks blue but dont touch my cleats",
        "RECOLOR[socks|cleats] blue",
        "RECOLOR[socks] blue",
      ],
      // Known remaining (ledger F-L4): the rest recolours the jersey alone — rule 5 never reads the determiner-less
      // "cleats" in it, so nothing names the kept thing and it does not ask. Pinned as it is.
      [
        "make the jersey and cleats blue but keep the cleats the same",
        "RECOLOR[jersey|cleats|same] blue",
        "RECOLOR[jersey] blue",
      ],
      // Rule 1 took it as a removal — both removed on main. The goalpost is Adi's live repro (asset c877f259).
      [
        "remove the goalpost but keep the ball",
        "REMOVE_OBJECT[goalpost|ball]",
        "REMOVE_OBJECT[goalpost]",
      ],
      [
        "remove the cone but keep the ball",
        "REMOVE_OBJECT[cone|ball]",
        "REMOVE_OBJECT[cone]",
      ],
      [
        "remove the cone and keep the ball where it is",
        "REMOVE_OBJECT[cone|ball where it]",
        "REMOVE_OBJECT[cone]",
      ],
      // Rule 4a took it as a surface for the logo.
      [
        "add a nike logo to my jersey but keep my shorts the same",
        "APPLY_DESIGN[jersey|shorts|same] nike logo",
        "APPLY_DESIGN[jersey] nike logo",
      ],
      // Asked on main, and the rest is a sentence the rules read.
      [
        "make the socks blue and keep my cleats as they are",
        "ASK person_target",
        "RECOLOR[socks] blue",
      ],
      [
        "dont change my cleats, make the socks blue",
        "ASK compound_partial",
        "RECOLOR[socks] blue",
      ],
      [
        "change my jersey to adidas but keep my cleats",
        "ASK brand_change",
        "REPLACE_OBJECT[jersey] adidas jersey",
      ],
      [
        "add a soccer ball between my cleats and keep the bench the same",
        "ASK add_unclear",
        "ADD_OBJECT[soccer ball] between my cleats",
      ],
    ];
    // Main's answer still stands for the WHOLE sentence: the rules are unchanged, only `route` sets the keep aside.
    expect(cases.map(([s]) => [s, readWhole(s)])).toEqual(
      cases.map(([s, main]) => [s, main]),
    );
    expect(cases.map(([s]) => [s, read(s)])).toEqual(
      cases.map(([s, , now]) => [s, now]),
    );
    // The rules read the rest, and so do detection and the freeze (nativeIntent.test.ts).
    expect(route("remove the goalpost but keep the ball", true).readAs).toBe(
      "remove the goalpost",
    );
    expect(
      route("remove the goalpost but keep the ball", true).constraints,
    ).toBeUndefined();
  });

  it("asks keep_conflict where the rest would change what she kept — a look, a background, or the thing itself", () => {
    const cases: [string, string][] = [
      // A look or a background changes the whole photo. On main: a background change, or the interpreter's ask.
      ["make it warmer but keep the background the same", "ASK keep_conflict"],
      ["make it warmer but leave the background alone", "ASK keep_conflict"],
      ["dont change the background, just make it warmer", "ASK keep_conflict"],
      [
        "change the background to a beach but keep the bench",
        "ASK keep_conflict",
      ],
      [
        "change the background to a stadium and keep the goal",
        "ASK keep_conflict",
      ],
      // A change that names the thing she kept.
      ["remove the ball but keep the ball", "ASK keep_conflict"],
      // The rest cannot be read — main recoloured the cleats ALONE.
      ["make everything blue but keep my cleats", "ASK keep_conflict"],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
  });

  it("sets her keep and a keep of a thing aside together, from either end", () => {
    expect(
      read("make the socks blue, keep my cleats, dont change my face"),
    ).toBe("RECOLOR[socks] blue +preserve_person");
    expect(
      read("make the socks blue, dont change my face, keep my cleats"),
    ).toBe("RECOLOR[socks] blue +preserve_person");
  });

  it("reads as today where it is not a keep of one thing, or the whole already asked and the rest asks too", () => {
    const cases: [string, string][] = [
      // A keep carrying a colour may be an instruction (D6).
      //
      // ⚠️ THIS PIN IS BLIND TO THE PER-TARGET COLOUR, AND ANOTHER ONE IS NOT (wave D, card 2). `read`
      // renders the step's op, targets and single `value`, so it says "blue" whichever colour the
      // JERSEY ends up rendered in — it stayed green through card 2, which changed exactly that. What
      // D6's "may be an instruction" reading means once it renders is pinned at the freeze instead:
      // nativeIntent.test.ts, "D6 — a keep carrying a colour is an instruction, and the COLOUR is what
      // moved" (socks→blue, jersey→red). Routing here, rendering there; neither alone is the answer.
      [
        "make the socks blue, keep the jersey red",
        "RECOLOR[socks|jersey] blue",
      ],
      ["make my kit blue but keep my cleats white", "ASK fast_path_declined"],
      // A list she kept, read first — #488's deliberate narrow ("REMOVE_OBJECT[ball|net]", the ball she kept removed)
      // until wave A's V6 read the list; its intended flip is pinned in V6's block below.
      // A particle, and her body as the thing.
      [
        "make the socks blue, keep the cone away",
        "RECOLOR[socks|cone away] blue",
      ],
      ["make the socks blue but keep my arms the same", "ASK person_target"],
      // Main asked, and what is left asks too: the interpreter's, as it was.
      [
        "replace the cone with a ball but keep the bench",
        "ASK fast_path_declined",
      ],
      // Our compiled words.
      [
        "Keep the original photograph's lighting, exposure, contrast, colour grade and scene exactly as they are.",
        "CHANGE_BACKGROUND[person]",
      ],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
    // With no photo, a new image, as before.
    expect(
      route("make the socks blue but keep my cleats", false).steps.map(
        (s) => s.op,
      ),
    ).toEqual(["GENERATE"]);
  });
});

// ─── WAVE A, V6 — A LIST SHE KEPT (ledger F-L4) ─────────────────────────────────────────────────────────────

describe("V6 — a list of kept things is read like one kept thing, item by item (wave A)", () => {
  it("reads a list first or last, in each of the four wordings", () => {
    const cases: [
      string,
      { rest: string; thing: string; at: "first" | "last"; things: string[] },
    ][] = [
      [
        "keep the ball, cone and bench, and remove the net",
        {
          rest: "remove the net",
          thing: "ball, cone and bench",
          at: "first",
          things: ["ball", "cone", "bench"],
        },
      ],
      [
        "remove the net, keep the ball, cone and bench",
        {
          rest: "remove the net",
          thing: "ball, cone and bench",
          at: "last",
          things: ["ball", "cone", "bench"],
        },
      ],
      [
        "keep the ball and the cone and remove the net",
        {
          rest: "remove the net",
          thing: "ball and the cone",
          at: "first",
          things: ["ball", "cone"],
        },
      ],
      [
        "remove the net and leave the ball, the cone and the bench alone",
        {
          rest: "remove the net",
          thing: "ball, the cone and the bench",
          at: "last",
          things: ["ball", "cone", "bench"],
        },
      ],
      [
        "dont touch my cleats and my socks, make the jersey blue",
        {
          rest: "make the jersey blue",
          thing: "cleats and my socks",
          at: "first",
          things: ["cleats", "socks"],
        },
      ],
    ];
    expect(cases.map(([s]) => [s, readThingKeep(s)])).toEqual(cases);
  });

  it("routes the rest, and removes or recolours nothing she kept", () => {
    const cases: [string, string, string][] = [
      // #488's pin was the first row's left column: the ball she kept, removed.
      [
        "keep the ball, cone and bench, and remove the net",
        "REMOVE_OBJECT[ball|net]",
        "REMOVE_OBJECT[net]",
      ],
      [
        "remove the net but keep the ball, cone and bench",
        "REMOVE_OBJECT[net|ball]",
        "REMOVE_OBJECT[net]",
      ],
      [
        "keep the ball and the cone and remove the net",
        "REMOVE_OBJECT[ball|cone|net]",
        "REMOVE_OBJECT[net]",
      ],
      [
        "keep the cone and bench and make the socks blue",
        "RECOLOR[cone|socks] blue",
        "RECOLOR[socks] blue",
      ],
    ];
    expect(cases.map(([s]) => [s, readWhole(s), read(s)])).toEqual(cases);
  });

  it("asks where the change would alter anything she kept — any item, or the whole photo", () => {
    expect(read("keep the ball and the cone and remove the cone")).toBe(
      "ASK keep_conflict",
    );
    expect(read("make it warmer but keep the ball and the cone")).toBe(
      "ASK keep_conflict",
    );
  });

  it("reads as today where any item is not a thing she can keep — her, or our own preservation sentence", () => {
    const cases: [string, string][] = [
      // Her arms among the kept things: no keep, and the guard reads her whole sentence as it did.
      ["keep the ball and my arms and remove the net", "ASK person_target"],
      // Our compiled preservation sentence is shaped like a list: a possessive and the scene words it keeps are never
      // her list (#488's guard, extended).
      [
        "make the socks blue. Keep the original photograph's lighting, exposure and contrast exactly as they are.",
        "RECOLOR[socks|original photograph s] blue",
      ],
      [
        "make the socks blue, keep the lighting and the contrast",
        "RECOLOR[socks|lighting|contrast] blue",
      ],
      // #488's compiled-line pins, held.
      [
        "change the background to a beach at sunset, keep the person exactly as-is",
        "CHANGE_BACKGROUND[person] beach at sunset",
      ],
      [
        "Keep the original photograph's lighting, exposure, contrast, colour grade and scene exactly as they are.",
        "CHANGE_BACKGROUND[person]",
      ],
      // Five things is past the list's bound: read as before.
      [
        "keep the ball, cone, bench, goal and flag and remove the net",
        "REMOVE_OBJECT[ball|net]",
      ],
      // A keep in the middle, as before.
      [
        "make the socks blue, keep my cleats, and remove the ball",
        "RECOLOR[socks|cleats] blue + REMOVE_OBJECT[ball]",
      ],
    ];
    expect(cases.map(([s]) => [s, read(s)])).toEqual(cases);
  });
});
