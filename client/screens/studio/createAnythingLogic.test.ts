import {
  afterAttach,
  autoFrame,
  autoMarkShape,
  autoOffAfterAttach,
  autoOffAfterReject,
  badgedFrame,
  canSend,
  canvasesIn,
  FRAME_ASK,
  FRAME_PICK,
  frameChoice,
  frameChoiceNeeded,
  frameCompanions,
  handOff,
  interpreterReads,
  productAddUnbound,
  READ_TIMEOUT_MS,
  readingOf,
  resolveSend,
  tapBadge,
  toggleFrame,
  whatIsMissing,
  type GateState,
  type Mark,
  type SendResolution,
} from "./createAnythingLogic";
import {
  askCopyFor,
  deriveIntent,
  deliverableFor,
  editShaped,
  MAX_ENGINE_REFERENCES,
  previewRequestFor,
  routeMarked,
  toEngineReferences,
  toReferences,
  type Attachment,
} from "../../lib/studio-contract";
import type {
  GenerationPreview,
  PreviewRequest,
  StudioClassification,
} from "../../hooks/use-studio";
// The server's classifier, for the acceptance-shaped cases: what classify answers to what the tray now sends.
import { route } from "../../../server/studio/classify";
import {
  ASK_DECISIONS,
  interpretable,
} from "../../../server/studio/interpret/eligibility";
import {
  checkAgainJob,
  composerAfterReject,
  type SheetJob,
  type WireAsset,
  type WireMaterial,
} from "./threadLogic";

const attach = (
  role: Attachment["role"],
  assetId: string | null = "a1",
): Attachment => ({
  id: `${role}-${assetId}`,
  role,
  name: role,
  uri: null,
  assetId,
});

const nothing: GateState = { attachments: [], carriedOn: false };
const state = (attachments: Attachment[], carriedOn = false): GateState => ({
  attachments,
  carriedOn,
});

describe("a named product", () => {
  it("asks when she names a specific one", () => {
    expect(whatIsMissing("put these sneakers on a shelf", nothing)).toBe(
      "product",
    );
    expect(whatIsMissing("shoot the necklace on a beach", nothing)).toBe(
      "product",
    );
    expect(whatIsMissing("a poster for this product", nothing)).toBe("product");
  });

  it("does not ask for a category, which can be invented freely", () => {
    // No determiner: she is describing a kind of thing, not a piece she owns.
    expect(whatIsMissing("a poster with sneakers in it", nothing)).toBeNull();
    expect(whatIsMissing("something with jewellery", nothing)).toBeNull();
  });

  it("does not read across a sentence boundary", () => {
    // "this" and "sneakers" are in different sentences and are not one phrase.
    expect(
      whatIsMissing("I love this. Draw some sneakers", nothing),
    ).toBeNull();
  });

  it("stops asking once the actual piece is attached", () => {
    expect(
      whatIsMissing(
        "put these sneakers on a shelf",
        state([attach("product")]),
      ),
    ).toBeNull();
  });

  it("treats carrying on as an answer, not a deferral", () => {
    expect(
      whatIsMissing("put these sneakers on a shelf", state([], true)),
    ).toBeNull();
  });

  it("is not satisfied by an unrelated attachment", () => {
    expect(
      whatIsMissing(
        "put these sneakers on a shelf",
        state([attach("inspiration")]),
      ),
    ).toBe("product");
  });
});

describe("her, in it", () => {
  it("asks when the prompt puts her in the frame", () => {
    expect(whatIsMissing("a photo of me on a rooftop", nothing)).toBe("photo");
    expect(whatIsMissing("put it on me", nothing)).toBe("photo");
    expect(whatIsMissing("me wearing it at dusk", nothing)).toBe("photo");
  });

  it("stops asking once a frame of hers is attached", () => {
    expect(
      whatIsMissing(
        "a photo of me on a rooftop",
        state([attach("source-frame")]),
      ),
    ).toBeNull();
  });

  it("is not satisfied by a product photo", () => {
    // A product shot is material for the job, never a photograph of her.
    expect(
      whatIsMissing("a photo of me on a rooftop", state([attach("product")])),
    ).toBe("photo");
  });

  it("says nothing about a scene with no person in it", () => {
    expect(whatIsMissing("a rooftop at dusk, city behind", nothing)).toBeNull();
  });
});

describe("a prompt short of two things", () => {
  const PROMPT = "put these sneakers on me";

  it("asks for the product first", () => {
    expect(whatIsMissing(PROMPT, nothing)).toBe("product");
  });

  it("reveals the second ask once the first is answered, instead of going quiet", () => {
    expect(whatIsMissing(PROMPT, state([attach("product")]))).toBe("photo");
  });

  it("is only finished when both have arrived", () => {
    expect(
      whatIsMissing(
        PROMPT,
        state([attach("product"), attach("source-frame", "a2")]),
      ),
    ).toBeNull();
  });

  it("walks the same path through afterAttach", () => {
    expect(afterAttach(PROMPT, state([attach("product")]))).toEqual({
      next: "ask",
      missing: "photo",
    });
    expect(
      afterAttach(
        PROMPT,
        state([attach("product"), attach("source-frame", "a2")]),
      ),
    ).toEqual({ next: "ready" });
  });
});

describe("attaching when nothing was blocked", () => {
  it("offers nothing, because she is only adding material", () => {
    expect(afterAttach(null, state([attach("inspiration")]))).toEqual({
      next: "nothing",
    });
  });

  it("never reports ready without a prompt that was stopped", () => {
    expect(afterAttach(null, nothing).next).not.toBe("ready");
  });
});

describe("the send button", () => {
  it("does nothing on an empty box", () => {
    expect(canSend("")).toBe(false);
    expect(canSend("   ")).toBe(false);
  });

  it("wakes up on real words", () => {
    expect(canSend("a poster for saturday")).toBe(true);
  });
});

describe("deriving the engine task", () => {
  const frame = { role: "source-frame" as const, assetId: "a1" };
  const product = { role: "product" as const, assetId: "a2" };
  const inspo = { role: "inspiration" as const, assetId: "a3" };

  it("sends motion to video whatever is attached", () => {
    expect(deriveIntent("video", [])).toBe("video.generate");
    expect(deriveIntent("video", [frame])).toBe("video.generate");
  });

  it("edits when there is a frame of hers to edit", () => {
    expect(deriveIntent("photo", [frame])).toBe("image.edit");
    expect(deriveIntent("carousel", [frame, product])).toBe("image.edit");
  });

  it("generates from nothing when she attached none of her own", () => {
    expect(deriveIntent("photo", [])).toBe("image.generate");
  });

  it("does not count a product or an inspiration as the thing being edited", () => {
    // Both are material for the job; neither is a photograph to edit.
    expect(deriveIntent("photo", [product])).toBe("image.generate");
    expect(deriveIntent("photo", [inspo])).toBe("image.generate");
    expect(deriveIntent("photo", [product, inspo])).toBe("image.generate");
  });

  it("pairs each format with a deliverable the intent can actually produce", () => {
    // Must agree with DELIVERABLES_FOR in use-studio, or the format she taps is a 400.
    expect(deliverableFor("video")).toBe("reel");
    expect(deliverableFor("photo")).toBe("post");
    expect(deliverableFor("carousel")).toBe("carousel");
    expect(deliverableFor("story")).toBe("story");
  });
});

describe("what a request can carry", () => {
  it("drops an attachment that has no asset row yet", () => {
    const refs = toReferences([
      attach("source-frame", "a1"),
      attach("product", null),
    ]);
    expect(refs).toEqual([{ role: "source-frame", assetId: "a1" }]);
  });

  it("keeps every role, including inspiration", () => {
    const refs = toReferences([
      attach("source-frame", "a1"),
      attach("product", "a2"),
      attach("inspiration", "a3"),
    ]);
    expect(refs.map((r) => r.role)).toEqual([
      "source-frame",
      "product",
      "inspiration",
    ]);
  });
});

describe("the tray does not survive a send", () => {
  // The generation-statelessness rule, at the one place this screen can break it. Every send is a
  // separate job; the thread is not. Before this, coming back from Make it and typing something
  // unrelated sent the previous piece's photographs along with it — which is how a likeness tagged
  // for one job ended up conditioning another.

  it("hands over what was attached and leaves the tray empty", () => {
    const tray = [attach("source-frame", "a1"), attach("product", "a2")];
    const { sent, tray: after } = handOff(tray);

    expect(sent.map((a) => a.assetId)).toEqual(["a1", "a2"]);
    expect(after).toEqual([]);
  });

  it("is empty after a send even when nothing was attached", () => {
    expect(handOff([]).tray).toEqual([]);
    expect(handOff([]).sent).toEqual([]);
  });

  it("hands over a SNAPSHOT, so emptying the tray cannot reach the job that left", () => {
    // The screen navigates and then clears in the same tick. If `sent` were the live array rather
    // than a copy, that clear would be racing the navigator for the job's own references.
    const tray = [attach("product", "a1")];
    const { sent } = handOff(tray);

    tray.length = 0;

    expect(sent).toHaveLength(1);
    expect(sent[0].assetId).toBe("a1");
  });
});

describe("editing changed nothing about this gate, and that is the assertion", () => {
  const frame: Attachment = {
    id: "1",
    role: "source-frame",
    name: "her.jpg",
    uri: null,
    assetId: "a1",
  };
  const state = (attachments: Attachment[] = []) => ({
    attachments,
    carriedOn: false,
  });

  /**
   * A short-circuit for edits was written into whatIsMissing and then removed, because a negative
   * control showed it was DEAD: every branch it could reach was already decided by `hasHer`. These
   * pin why, so nobody adds it back.
   */
  it("never asks for a photo on an edit, because an edit already has one attached", () => {
    // Not because the gate knows what an edit is — because `hasHer` is true by definition here.
    expect(whatIsMissing("take my jersey off", state([frame]))).toBeNull();
  });

  it("DOES ask when an edit phrase needs her and nothing is attached, which is correct", () => {
    // An edit with no photograph has nothing to edit. Suppressing this would be the gate going quiet
    // on the one case it exists for. ("my face" is what trips NEEDS_HER here — "take my jersey off"
    // does not match it at all, and falls through to a generate like any other unrecognised prompt.)
    expect(whatIsMissing("erase the mark on my face", state())).toBe("photo");
    expect(
      whatIsMissing("erase the mark on my face", state([frame])),
    ).toBeNull();
  });

  it("still asks for a PRODUCT on an edit — a different thing it cannot invent", () => {
    expect(
      whatIsMissing("replace the bottle with these sneakers", state([frame])),
    ).toBe("product");
  });
});

describe("an Object photo is a picture of the specific thing (replace with reference)", () => {
  const frame = attach("source-frame", "f1");
  const hoops = attach("object", "o1");

  it("stops asking once the thing is in the Object tile — the sentences replace with reference routes", () => {
    for (const prompt of [
      // R.4's sentence: "the earrings" is what trips the product question.
      "change the earrings in my ears to these gold hoops",
      // The corpus's own pointer sentence, and acceptance cell 4 ("the soccer ball … her jersey").
      "replace the bottle with these sneakers",
      "change the soccer ball to this one and make her jersey blue",
    ]) {
      expect({
        prompt,
        missing: whatIsMissing(prompt, state([frame])),
      }).toEqual({
        prompt,
        missing: "product",
      });
      expect({
        prompt,
        missing: whatIsMissing(prompt, state([frame, hoops])),
      }).toEqual({ prompt, missing: null });
    }
  });

  it("resolves the gated ask the moment the Object photo is attached — never the carry-on line", () => {
    const gated = "change the earrings in my ears to these gold hoops";
    expect(afterAttach(gated, state([frame, hoops]))).toEqual({
      next: "ready",
    });
  });

  it("is still not satisfied by an unrelated attachment", () => {
    expect(
      whatIsMissing(
        "put these sneakers on a shelf",
        state([attach("inspiration")]),
      ),
    ).toBe("product");
  });
});

describe("the EDITING badge — her mark, on and off (frame defaulting)", () => {
  const her = (assetId: string | null): Attachment =>
    attach("source-frame", assetId);
  const tray = [
    her("m1"),
    her("m2"),
    attach("product", "p1"),
    attach("object", "o1"),
  ];

  it("a tap on a photo of hers marks it", () => {
    expect(toggleFrame(tray, null, "m1")).toBe("m1");
  });

  it("a tap on the marked photo CLEARS it — the tray can hold references only", () => {
    expect(toggleFrame(tray, "m1", "m1")).toBeNull();
    // And on a single photo too: the case the old tray hid the badge on, and so could never clear.
    expect(toggleFrame([her("m1")], "m1", "m1")).toBeNull();
  });

  it("a tap on another photo of hers moves the mark there", () => {
    expect(toggleFrame(tray, "m1", "m2")).toBe("m2");
  });

  it("a product, an object, an upload in flight or a chip that has gone cannot take the mark — nothing moves", () => {
    expect(toggleFrame(tray, "m1", "p1")).toBe("m1");
    expect(toggleFrame(tray, null, "o1")).toBeNull();
    expect(toggleFrame([her(null), her("m1")], "m1", null)).toBe("m1");
    expect(toggleFrame(tray, "m2", "gone")).toBe("m2");
  });
});

describe("the frame ask — a marked photo beside other photos of her asks first (frame defaulting, F.4)", () => {
  const her = (assetId: string | null): Attachment =>
    attach("source-frame", assetId);
  const product = attach("product", "p1");
  const object = attach("object", "o1");
  const classified = (sentence: string, hasSourcePhoto: boolean) =>
    ({
      ...route(sentence, hasSourcePhoto),
      op: null,
      targets: [],
    }) as StudioClassification;

  it("asks only when a MARKED photo has another photo of her beside it", () => {
    expect(frameChoiceNeeded([her("m1"), her("m2")], "m2")).toBe(true);
    // An Edit-this output marked, with a library photo of her added.
    expect(frameChoiceNeeded([her("out"), her("m1")], "out")).toBe(true);
    // A photo still uploading is a photo of her all the same.
    expect(frameChoiceNeeded([her("m1"), her(null)], "m1")).toBe(true);
  });

  it("asks nothing with no mark, a mark alone, or a mark beside a product or an object", () => {
    expect(
      frameChoiceNeeded([her("m1"), her("m2"), her("m3"), her("m4")], null),
    ).toBe(false);
    expect(frameChoiceNeeded([her("m1")], "m1")).toBe(false);
    expect(frameChoiceNeeded([her("m1"), product, object], "m1")).toBe(false);
    // A mark that names nothing in the tray is no mark.
    expect(frameChoiceNeeded([her("m1"), her("m2")], "gone")).toBe(false);
  });

  it("EDIT sends the marked photo with the products and objects — the other photos of her come out, by her tap", () => {
    const tray = [her("m1"), product, her("m2"), object];
    expect(frameChoice(tray, "m2", "edit")).toEqual({
      tray: [product, her("m2"), object],
      frameAssetId: "m2",
    });
  });

  it("NEW sends the whole tray with no frame — the marked photo is her likeness too", () => {
    const tray = [her("m1"), product, her("m2")];
    const out = frameChoice(tray, "m2", "new");
    expect(out.tray).toBe(tray);
    expect(out.frameAssetId).toBeNull();
  });

  it("with no mark left by the time she answers, either answer is a new image from the tray as it is", () => {
    const tray = [her("m1"), her("m2")];
    expect(frameChoice(tray, null, "edit")).toEqual({
      tray,
      frameAssetId: null,
    });
    expect(frameChoice(tray, "gone", "new")).toEqual({
      tray,
      frameAssetId: null,
    });
  });

  it("her pack with one marked: NEW is a generate from all three; EDIT is an edit carrying no photo of her", () => {
    const sentence = "generate pic of me playing soccer";
    const tray = [her("m1"), her("m2"), her("m3")];
    expect(frameChoiceNeeded(tray, "m2")).toBe(true);

    const fresh = frameChoice(tray, "m2", "new");
    const gen = routeMarked(
      "photo",
      classified(sentence, false),
      sentence,
      fresh.tray,
      fresh.frameAssetId,
    );
    expect(gen.intent).toBe("image.generate");
    expect(
      toEngineReferences(
        fresh.tray,
        MAX_ENGINE_REFERENCES,
        gen.editBase,
      ).references.map((r) => r.role),
    ).toEqual(["person", "person", "person"]);

    const socks = "make the socks blue";
    const edit = frameChoice(tray, "m2", "edit");
    const routed = routeMarked(
      "photo",
      classified(socks, true),
      socks,
      edit.tray,
      edit.frameAssetId,
    );
    expect(routed.intent).toBe("image.edit");
    expect(routed.editBase?.assetId).toBe("m2");
    // Nothing left for refusedOnEdit to refuse.
    expect(
      toEngineReferences(edit.tray, MAX_ENGINE_REFERENCES, routed.editBase)
        .references,
    ).toEqual([]);
  });

  it("the code has its own sentence, never the catch-all", () => {
    expect(askCopyFor(FRAME_ASK)).not.toBe(askCopyFor("zzz"));
    expect(askCopyFor(FRAME_ASK)).toMatch(/new image from all of them/);
  });
});

// ─── Auto-mark (auto-mark, 2026-09-16) ────────────────────────────────────────────────────────────────────────────

/** What `POST /studio/classify` answers for her words, told there is a photo to edit — the real classifier. */
const asMarked = (sentence: string, objects = 0): StudioClassification =>
  ({
    ...route(sentence, true, { objects }),
    op: null,
    targets: [],
  }) as StudioClassification;
const her = (assetId: string | null): Attachment =>
  attach("source-frame", assetId);
const UNMARKED: Mark = { frameAssetId: null, autoOff: false };

describe("auto-mark — is her sentence edit-shaped (Adi's D1, S2)", () => {
  const shaped = (sentence: string, objects = 0) =>
    editShaped(true, asMarked(sentence, objects), sentence);

  it("⚠️ the deep sweep's sentences auto-badge UNTAPPED, because they now route (E2, E4)", () => {
    // Both reached the interpreter or a generate before this wave. Routing is what makes them
    // edit-shaped, so auto-mark badges her one You-photo with no tap — Adi's S2 treatment, arrived at
    // by fixing the ROUTE rather than by widening the client's list.
    for (const sentence of [
      "make the logo on my jersey adidas",
      "replace the nike logo to be adidas",
      "make my jersey adidas. make it blue.",
      "make my uniform, shoes and socks adidas. make them the color blue too.",
    ]) {
      expect({ sentence, shaped: shaped(sentence) }).toEqual({
        sentence,
        shaped: true,
      });
    }
  });

  it("a sentence the classifier ROUTES as an edit is edit-shaped", () => {
    for (const sentence of [
      "make the socks blue",
      "remove the soccer ball",
      "put me on a rooftop at dusk",
      "make this black and white",
      "add a soccer ball at my feet",
      "change my jersey to adidas",
    ]) {
      expect({ sentence, shaped: shaped(sentence) }).toEqual({
        sentence,
        shaped: true,
      });
    }
    expect(shaped("change my earrings to these gold hoops", 1)).toBe(true);
  });

  it("an ask whose code NAMES an edit is edit-shaped — the rules read an operation and declined only how", () => {
    for (const [sentence, reason] of [
      ["if there are any nike logos remove them", "conditional"],
      // "add sunglasses" stood here until wave A's V2 read a worn thing with no place at its anchor; a ball stands in.
      ["add a soccer ball", "add_unclear"],
      ["change my earrings to these gold hoops", "object_photo_missing"],
      // Since the preservation fixes (#488): a keep her change would break is still an edit she asked for.
      ["make it warmer but keep the background the same", "keep_conflict"],
    ] as const) {
      expect({
        sentence,
        reason: asMarked(sentence).reason,
        shaped: shaped(sentence),
      }).toEqual({ sentence, reason, shaped: true });
    }
  });

  it("the CATCH-ALL is never edit-shaped — the generates the rules cannot read stay generates (frame defaulting holds)", () => {
    for (const sentence of [
      "generate pic of me playing soccer",
      // ("generate a pic of me playing soccer" stood here until wave A's V3 made "pic" a new-image word — it is rule 0's
      // GENERATE now, pinned with the explicit generates below.)
      "me dunking in a stadium",
      "make me look like im at the beach",
      // ("take the logo off my sleeve" and "make the sky moodier" were LEDGERED here as a vocabulary follow-up; wave A's
      // V4 read both, and they are pinned as the auto-marked edits they are now, beside C2's send below.)
    ]) {
      expect({
        sentence,
        reason: asMarked(sentence).reason,
        shaped: shaped(sentence),
      }).toEqual({
        sentence,
        reason: "fast_path_declined",
        shaped: false,
      });
    }
  });

  it("a refusal of an edit to HER is not edit-shaped — marking only to refuse is worse than the new image", () => {
    // "make my jersey blue, dont change my face" used to be here: since the preservation fixes (#488, F-L5) it routes
    // with her keep beside it, and is pinned below as edit-shaped. These are still refusals of an edit to her.
    // ("add a water bottle from image 2 onto my head" stood first until wave A's G1 placed a bottle on her head; it is
    // pinned as edit-shaped below, and a substance on her skin stands in.)
    for (const sentence of [
      "put paint on my face",
      "put a crown on my head",
      "change my hair to blonde",
      "make my face thinner",
    ]) {
      expect({
        sentence,
        reason: asMarked(sentence).reason,
        shaped: shaped(sentence),
      }).toEqual({
        sentence,
        reason: expect.stringMatching(/^person_/),
        shaped: false,
      });
    }
  });

  it("a thing placed on a part of her routes since wave A's G1 — so it is edit-shaped, and auto-marked (F-L6, F-AM5)", () => {
    const sentence = "add a water bottle from image 2 onto my head";
    const answer = asMarked(sentence, 1);
    expect({
      path: answer.initialPath,
      steps: answer.steps.map((s) => [s.op, s.targets, s.value]),
      shaped: shaped(sentence, 1),
    }).toEqual({
      path: "FULL_IMAGE",
      steps: [["ADD_OBJECT", ["water bottle"], "onto my head"]],
      shaped: true,
    });
  });

  it("her keep beside a change routes since the preservation fixes (#488, F-L5) — so it is edit-shaped, and auto-marked", () => {
    for (const sentence of [
      "make my jersey blue, dont change my face",
      "make it warmer, dont change my face",
    ]) {
      const answer = route(sentence, true);
      expect({
        sentence,
        path: answer.initialPath,
        keep: answer.constraints,
        shaped: shaped(sentence),
      }).toEqual({
        sentence,
        path: "FULL_IMAGE",
        keep: [{ kind: "preserve_person" }],
        shaped: true,
      });
    }
  });

  it("an explicit generate is not edit-shaped — even with an edit verb in it, which the old verb list would have OR'd in", () => {
    for (const sentence of [
      "create an adidas ad featuring me",
      "make a b&w version of this photo",
      "create an adidas ad featuring me, remove any nike logos",
      "generate a pic of me playing soccer",
    ]) {
      expect({ sentence, shaped: shaped(sentence) }).toEqual({
        sentence,
        shaped: false,
      });
    }
  });

  // Was "ACCEPTED, pre-frame-defaulting parity: a generate phrasing with a background clause routes as the background edit
  // (G.4, new_pose_or_edit)" — F-AM4, until wave A's V3 made "pic" a new-image word (V5 pins the server side).
  it("an explicit generate with a background clause is ONE new image since wave A's V3 — not edit-shaped; with no article it is still the background edit", () => {
    const sentence =
      "generate a pic of me playing soccer and change the background to a stadium";
    expect(asMarked(sentence).initialPath).toBe("GENERATE");
    expect(shaped(sentence)).toBe(false);
    const bare =
      "generate pic of me playing soccer and change the background to a stadium";
    expect(asMarked(bare).initialPath).toBe("BACKGROUND");
    expect(shaped(bare)).toBe(true);
  });

  it("every ask code the server can send is decided here — a new one fails this until it is placed", () => {
    const EDIT = [
      "brand_change",
      "brand_removal",
      "compound_partial",
      "compound_conflict",
      "keep_conflict",
      "conditional",
      "add_unclear",
      "worn_add_unclear",
      "object_photo_missing",
      "too_many_changes",
      "headline_bounds",
      "look_unknown",
    ];
    const NOT = [
      "fast_path_declined",
      "person_target",
      "person_mentioned",
      "no_steps",
      "generate_not_permitted",
      // PR 19's asks (STUDIO_IMAGE_OPS). Not edit-shaped with the twin off: EXPO_PUBLIC_STUDIO_IMAGE_OPS places them
      // for auto-mark (studio-contract IMAGE_OPS_EDIT_ASKS; pinned in createAnythingLogic.imageOps.test).
      "vague",
      "style_reference_missing",
      "angle_unclear",
    ];
    expect([...Object.keys(ASK_DECISIONS)].sort()).toEqual(
      [...EDIT, ...NOT].sort(),
    );
    for (const reason of Object.keys(ASK_DECISIONS)) {
      const ask = {
        initialPath: "ASK",
        steps: [],
        reason,
        op: null,
        targets: [],
      } as StudioClassification;
      expect({
        reason,
        shaped: editShaped(true, ask, "whatever she said"),
      }).toEqual({ reason, shaped: EDIT.includes(reason) });
    }
    // A code this client has never heard of leaves her photo her likeness.
    expect(
      editShaped(
        true,
        {
          initialPath: "ASK",
          steps: [],
          reason: "zzz_new",
          op: null,
          targets: [],
        } as StudioClassification,
        "x",
      ),
    ).toBe(false);
  });

  it("with routing on and NO answer (in flight, or failed), nothing is edit-shaped", () => {
    expect(editShaped(true, undefined, "remove the soccer ball")).toBe(false);
  });

  it("with routing OFF, the verb list decides — the same fallback the plan takes", () => {
    expect(editShaped(false, undefined, "remove the soccer ball")).toBe(true);
    expect(editShaped(false, undefined, "take the logo off my sleeve")).toBe(
      true,
    );
    expect(editShaped(false, undefined, "make the socks blue")).toBe(false);
    expect(
      editShaped(false, undefined, "generate pic of me playing soccer"),
    ).toBe(false);
  });
});

describe("auto-mark — which photo, and when none (one plausible canvas)", () => {
  const product = attach("product", "p1");
  const object = attach("object", "o1");

  it("ONE photo of hers and an edit-shaped sentence badge that photo — beside a product or an object too", () => {
    expect(autoFrame([her("m1")], UNMARKED, true)).toBe("m1");
    expect(autoFrame([product, her("m1")], UNMARKED, true)).toBe("m1");
    expect(autoFrame([her("m1"), object], UNMARKED, true)).toBe("m1");
  });

  it("a sentence that is not edit-shaped badges nothing — the photo is her likeness", () => {
    expect(autoFrame([her("m1")], UNMARKED, false)).toBeNull();
  });

  it("two photos of her are never a silent pick — and a photo still uploading counts as one of them", () => {
    expect(autoFrame([her("m1"), her("m2")], UNMARKED, true)).toBeNull();
    expect(autoFrame([her("m1"), her(null)], UNMARKED, true)).toBeNull();
    expect(autoFrame([her(null)], UNMARKED, true)).toBeNull();
  });

  it("a video or a reel is not a canvas: it neither takes the badge nor counts against the photo beside it", () => {
    const types = { v1: "VIDEO", r1: "REELS", m1: "IMAGE" };
    expect(
      canvasesIn([her("v1"), her("r1"), her("m1")], types).map(
        (a) => a.assetId,
      ),
    ).toEqual(["m1"]);
    expect(autoFrame([her("v1"), her("m1")], UNMARKED, true, types)).toBe("m1");
    expect(autoFrame([her("v1")], UNMARKED, true, types)).toBeNull();
  });

  it("her mark always wins, and a badge she took off stays off", () => {
    expect(
      autoFrame([her("m1")], { frameAssetId: "m1", autoOff: false }, true),
    ).toBeNull();
    expect(
      badgedFrame([her("m1")], { frameAssetId: "m1", autoOff: false }, null),
    ).toBe("m1");
    expect(
      autoFrame([her("m1")], { frameAssetId: null, autoOff: true }, true),
    ).toBeNull();
  });

  it("C3: an add beside ONE product and no Object photo is auto-marked — the server binds the product, as it binds an Object photo", () => {
    // D5 (b) held this back until C3: the product then rode beside an invented thing. Post-C3 default (Adi, 2026-09-17):
    // auto-mark marks whenever the server can bind.
    const add = "add this bottle next to me";
    expect(productAddUnbound(asMarked(add), [her("m1"), product])).toBe(false);
    expect(autoMarkShape(true, asMarked(add), add, [her("m1"), product])).toBe(
      true,
    );
    expect(
      autoMarkShape(true, asMarked(add, 1), add, [her("m1"), object]),
    ).toBe(true);
    // An add it could not place is still an add, and the interpreter's reading binds the same product.
    //
    // ⚠️ THE SENTENCE MOVED, THE CASE DID NOT (wave D, card 5). "put this water bottle in my hand"
    // stood here until her hand became a place a hand-sized thing may be put — it ROUTES now, so it is
    // no longer an add the rules could not place. A place they still cannot read stands in its stead,
    // and the hand form's own routing is pinned server-side in classify.test.ts.
    const unplaced = "put this water bottle in my bag";
    expect(asMarked(unplaced).reason).toBe("add_unclear");
    expect(
      autoMarkShape(true, asMarked(unplaced), unplaced, [her("m1"), product]),
    ).toBe(true);
    // Adi's live hit, 2026-09-16: the bottle in the Product tile is marked exactly as in the Object tile.
    const live = "add a water bottle from image 2";
    expect(
      autoMarkShape(true, asMarked(live), live, [her("m1"), product]),
    ).toBe(autoMarkShape(true, asMarked(live, 1), live, [her("m1"), object]));
    expect(
      autoMarkShape(true, asMarked(live), live, [her("m1"), product]),
    ).toBe(true);
  });

  it("D5 (b), what C3 left of it: an add beside TWO products and no Object photo is not auto-marked — the server would ask which (decision 4)", () => {
    const two = [her("m1"), product, attach("product", "p2")];
    const add = "add this bottle next to me";
    expect(productAddUnbound(asMarked(add), two)).toBe(true);
    expect(autoMarkShape(true, asMarked(add), add, two)).toBe(false);
    const unplaced = "put this water bottle in my hand";
    expect(autoMarkShape(true, asMarked(unplaced), unplaced, two)).toBe(false);
    // An Object photo beside them is the thing: nothing to ask, so it marks.
    expect(autoMarkShape(true, asMarked(add, 1), add, [...two, object])).toBe(
      true,
    );
    // Not an add: products beside a recolour never stop it (the render-this-exact-object wart is ledgered, F-AM5).
    expect(
      autoMarkShape(
        true,
        asMarked("make the socks blue"),
        "make the socks blue",
        two,
      ),
    ).toBe(true);
  });
});

describe("auto-mark — her tap, and when auto-mark comes back (D3)", () => {
  it("a tap on the badge auto-mark put there takes it off, and auto-mark stays off", () => {
    const next = tapBadge([her("m1")], UNMARKED, "m1", "m1");
    expect(next).toEqual({ frameAssetId: null, autoOff: true });
    expect(autoFrame([her("m1")], next, true)).toBeNull();
  });

  it("a tap on HER badge takes it off the same way", () => {
    expect(
      tapBadge([her("m1")], { frameAssetId: "m1", autoOff: false }, null, "m1"),
    ).toEqual({ frameAssetId: null, autoOff: true });
  });

  it("a tap on a photo with no badge marks it — hers, as before", () => {
    expect(tapBadge([her("m1")], UNMARKED, null, "m1")).toEqual({
      frameAssetId: "m1",
      autoOff: false,
    });
    expect(
      tapBadge([her("m1")], { frameAssetId: null, autoOff: true }, null, "m1"),
    ).toEqual({ frameAssetId: "m1", autoOff: true });
  });

  it("a product, an upload in flight or a chip that has gone moves nothing", () => {
    const tray = [her("m1"), attach("product", "p1")];
    expect(tapBadge(tray, UNMARKED, "m1", "p1")).toBe(UNMARKED);
    expect(tapBadge(tray, UNMARKED, "m1", null)).toBe(UNMARKED);
    expect(tapBadge(tray, UNMARKED, "m1", "gone")).toBe(UNMARKED);
  });

  it("another photo of hers attached turns auto-mark back on; a product or an object does not", () => {
    expect(autoOffAfterAttach("source-frame", true)).toBe(false);
    expect(autoOffAfterAttach("product", true)).toBe(true);
    expect(autoOffAfterAttach("object", true)).toBe(true);
  });
});

describe("auto-mark — the send decides on the EXACT words sent", () => {
  /** The frame a SEND carries — and a failed expectation, not a type error, when it asked instead (AM.3's union). */
  const frameOf = (r: SendResolution<Attachment>): string | null => {
    if (r.kind !== "send")
      throw new Error(
        `expected a send, got ${r.kind === "ask" ? `the ${r.code} ask` : "an ad"}`,
      );
    return r.frameAssetId;
  };
  type State = {
    tray: Attachment[];
    mark: Mark;
    mediaTypes: Record<string, string>;
  };
  const stateOf = (tray: Attachment[], mark: Mark = UNMARKED): State => ({
    tray,
    mark,
    mediaTypes: {},
  });
  /** The classify one-shot, answered by the real classifier for whatever words it is asked about. */
  const realAsk = () =>
    jest.fn(async (text: string, objects: number) => asMarked(text, objects));

  it("RE-ASKS on the sentence sent — once, with its Object photo count — and that answer decides", async () => {
    const ask = realAsk();
    const s = stateOf([her("m1")]);
    const out = await resolveSend({
      text: "make the socks blue",
      routing: true,
      current: () => s,
      ask,
    });
    expect(ask.mock.calls).toEqual([["make the socks blue", 0]]);
    expect(out).toEqual({ kind: "send", tray: s.tray, frameAssetId: "m1" });

    // The badge a draft showed is not an input: the words sent are a generate, and nothing is marked.
    const ask2 = realAsk();
    const gen = await resolveSend({
      text: "generate pic of me playing soccer",
      routing: true,
      current: () => s,
      ask: ask2,
    });
    expect(ask2.mock.calls).toEqual([["generate pic of me playing soccer", 0]]);
    expect(frameOf(gen)).toBeNull();
  });

  it("the plan that follows an auto-marked send is an EDIT of that photo, and the photo travels as the frame, not a reference", async () => {
    const sentence = "make the socks blue";
    const tray = [her("m1"), attach("product", "p1")];
    const out = await resolveSend({
      text: sentence,
      routing: true,
      current: () => stateOf(tray),
      ask: realAsk(),
    });
    const routed = routeMarked(
      "photo",
      asMarked(sentence),
      sentence,
      out.tray,
      frameOf(out),
    );
    expect(routed.intent).toBe("image.edit");
    expect(routed.editBase?.assetId).toBe("m1");
    expect(
      toEngineReferences(
        out.tray,
        MAX_ENGINE_REFERENCES,
        routed.editBase,
      ).references.map((r) => r.role),
    ).toEqual(["product"]);
  });

  it("UNTAP THEN IMMEDIATE SEND plans a GENERATE — nothing is asked, so no in-flight answer can mark it", async () => {
    const sentence = "make the socks blue";
    const untapped = tapBadge([her("m1")], UNMARKED, "m1", "m1");
    const ask = realAsk();
    const out = await resolveSend({
      text: sentence,
      routing: true,
      current: () => stateOf([her("m1")], untapped),
      ask,
    });
    expect(ask).not.toHaveBeenCalled();
    expect(frameOf(out)).toBeNull();
    const routed = routeMarked(
      "photo",
      {
        ...route(sentence, false),
        op: null,
        targets: [],
      } as StudioClassification,
      sentence,
      out.tray,
      frameOf(out),
    );
    expect(routed.intent).toBe("image.generate");
  });

  it("an untap WHILE the send's question is in flight wins over its answer", async () => {
    let s = stateOf([her("m1")]);
    const ask = jest.fn(async (text: string, objects: number) => {
      s = { ...s, mark: tapBadge(s.tray, s.mark, "m1", "m1") };
      return asMarked(text, objects);
    });
    const out = await resolveSend({
      text: "make the socks blue",
      routing: true,
      current: () => s,
      ask,
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(frameOf(out)).toBeNull();
  });

  it("a photo she marks while it is in flight is the frame, whatever the answer", async () => {
    let s = stateOf([her("m1")]);
    const ask = jest.fn(async (text: string, objects: number) => {
      s = { ...s, mark: { frameAssetId: "m1", autoOff: false } };
      return asMarked(text, objects);
    });
    expect(
      frameOf(
        await resolveSend({
          text: "generate pic of me playing soccer",
          routing: true,
          current: () => s,
          ask,
        }),
      ),
    ).toBe("m1");
  });

  it("an Object photo attached while it is in flight voids the answer — it was for a different tray", async () => {
    let s = stateOf([her("m1")]);
    const ask = jest.fn(async (text: string, objects: number) => {
      s = { ...s, tray: [...s.tray, attach("object", "o1")] };
      return asMarked(text, objects);
    });
    expect(
      frameOf(
        await resolveSend({
          text: "change my earrings to these gold hoops",
          routing: true,
          current: () => s,
          ask,
        }),
      ),
    ).toBeNull();
  });

  it("a classifier that fails marks nothing — frame defaulting's answer", async () => {
    const ask = jest.fn(async () => {
      throw new Error("503");
    });
    expect(
      frameOf(
        await resolveSend({
          text: "remove the soccer ball",
          routing: true,
          current: () => stateOf([her("m1")]),
          ask,
        }),
      ),
    ).toBeNull();
  });

  it("asks nothing when it cannot matter: her mark, no photo of hers, or routing off (the verb list decides)", async () => {
    const ask = realAsk();
    expect(
      frameOf(
        await resolveSend({
          text: "generate pic of me playing soccer",
          routing: true,
          current: () =>
            stateOf([her("m1")], { frameAssetId: "m1", autoOff: false }),
          ask,
        }),
      ),
    ).toBe("m1");
    expect(
      frameOf(
        await resolveSend({
          text: "make the socks blue",
          routing: true,
          current: () => stateOf([attach("product", "p1")]),
          ask,
        }),
      ),
    ).toBeNull();
    expect(
      frameOf(
        await resolveSend({
          text: "remove the soccer ball",
          routing: false,
          current: () => stateOf([her("m1")]),
          ask,
        }),
      ),
    ).toBe("m1");
    expect(
      frameOf(
        await resolveSend({
          text: "make the socks blue",
          routing: false,
          current: () => stateOf([her("m1")]),
          ask,
        }),
      ),
    ).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("auto-mark — two or more photos of her, none marked: she says which (frame_pick, D4)", () => {
  type State = {
    tray: Attachment[];
    mark: Mark;
    mediaTypes: Record<string, string>;
  };
  const stateOf = (
    tray: Attachment[],
    mark: Mark = UNMARKED,
    mediaTypes: Record<string, string> = {},
  ): State => ({ tray, mark, mediaTypes });
  const realAsk = () =>
    jest.fn(async (text: string, objects: number) => asMarked(text, objects));
  const send = (text: string, s: State, ask = realAsk()) =>
    resolveSend({ text, routing: true, current: () => s, ask });

  it("words that ask for an edit ASK which photo — the tray goes with the question, and nothing is marked", async () => {
    const tray = [her("m1"), attach("product", "p1"), her("m2")];
    expect(await send("make the socks blue", stateOf(tray))).toEqual({
      kind: "ask",
      code: FRAME_PICK,
      tray,
    });
  });

  it("a photo of her still uploading is one of them", async () => {
    expect(
      (await send("remove the soccer ball", stateOf([her("m1"), her(null)])))
        .kind,
    ).toBe("ask");
  });

  it("words that are not edit-shaped ask nothing — a new image from all of them, exactly as frame defaulting made it", async () => {
    const tray = [her("m1"), her("m2"), her("m3")];
    // ("take the logo off my sleeve" was the third until wave A's V4 read it as a removal — with three photos it asks which, pinned below.)
    for (const text of [
      "generate pic of me playing soccer",
      "me dunking in a stadium",
      "make the grass moodier",
    ]) {
      expect({ text, out: await send(text, stateOf(tray)) }).toEqual({
        text,
        out: { kind: "send", tray, frameAssetId: null },
      });
    }
  });

  it("her mark answers it already (the frame ask, F.4, is hand's), and a badge she took off means no frame — no pick ask", async () => {
    const tray = [her("m1"), her("m2")];
    expect(
      await send(
        "make the socks blue",
        stateOf(tray, { frameAssetId: "m2", autoOff: false }),
      ),
    ).toEqual({ kind: "send", tray, frameAssetId: "m2" });
    expect(
      await send(
        "make the socks blue",
        stateOf(tray, { frameAssetId: null, autoOff: true }),
      ),
    ).toEqual({ kind: "send", tray, frameAssetId: null });
  });

  it("a video beside one photo of her is not a second canvas — the photo is auto-marked, nothing is asked", async () => {
    const tray = [her("v1"), her("m1")];
    expect(
      await send(
        "make the socks blue",
        stateOf(tray, UNMARKED, { v1: "VIDEO" }),
      ),
    ).toEqual({ kind: "send", tray, frameAssetId: "m1" });
  });

  it("once she taps one, EDIT sends that photo and the products — the others come out by her tap, as F.4's does", () => {
    const tray = [her("m1"), attach("product", "p1"), her("m2")];
    const mark = tapBadge(tray, UNMARKED, null, "m2");
    expect(mark).toEqual({ frameAssetId: "m2", autoOff: false });
    expect(frameChoice(tray, mark.frameAssetId, "edit")).toEqual({
      tray: [attach("product", "p1"), her("m2")],
      frameAssetId: "m2",
    });
    expect(frameChoice(tray, null, "new")).toEqual({
      tray,
      frameAssetId: null,
    });
  });

  it("the code has its own sentence — not the marked-photo one, and not the catch-all", () => {
    expect(askCopyFor(FRAME_PICK)).not.toBe(askCopyFor(FRAME_ASK));
    expect(askCopyFor(FRAME_PICK)).not.toBe(askCopyFor("zzz"));
    expect(askCopyFor(FRAME_PICK)).toMatch(/new image from all of them/);
  });
});

describe("auto-mark never re-reads a saved thread — Check again and Not what I meant replay exactly (frame defaulting, F.3)", () => {
  const SENTENCE = "make the socks blue";
  const okAsset = (): WireAsset => ({
    mediaType: "IMAGE",
    thumbUrl: "https://signed.example/t",
    url: null,
    approvalStatus: null,
    state: "ok",
  });
  const material = (frameAssetId: string | null): WireMaterial => ({
    promptEntryId: "p1",
    sent: [{ assetId: "m1", role: "source-frame" }],
    frameAssetId,
    carriedOn: false,
    format: "photo",
  });
  const job = (frameAssetId: string | null): SheetJob => ({
    key: "k",
    promptEntryId: "p1",
    prompt: SENTENCE,
    attachments: [{ ...her("m1"), role: "source-frame" }],
    frameAssetId,
    carriedOn: false,
    format: "photo",
  });
  const realAsk = () =>
    jest.fn(async (text: string, objects: number) => asMarked(text, objects));

  it("CHECK AGAIN of a plan sent with no frame is still no frame for an edit-shaped sentence — it never meets auto-mark", () => {
    expect(editShaped(true, asMarked(SENTENCE), SENTENCE)).toBe(true);
    expect(
      checkAgainJob(material(null), SENTENCE, { m1: okAsset() })?.frameAssetId,
    ).toBeNull();
  });

  it("CHECK AGAIN of an auto-marked plan replays its frame — it was stored as an ordinary frame", () => {
    expect(
      checkAgainJob(material("m1"), SENTENCE, { m1: okAsset() })?.frameAssetId,
    ).toBe("m1");
  });

  it("NOT WHAT I MEANT on a no-frame plan gives the tray back with auto-mark OFF — her next send is the same new image", async () => {
    const back = composerAfterReject(
      { draft: "", tray: [], frameAssetId: null },
      job(null),
    );
    expect(back.frameAssetId).toBeNull();
    const mark: Mark = {
      frameAssetId: back.frameAssetId,
      autoOff: autoOffAfterReject({ tray: [], autoOff: false }, job(null)),
    };
    expect(mark.autoOff).toBe(true);
    const ask = realAsk();
    const out = await resolveSend({
      text: back.draft,
      routing: true,
      current: () => ({ tray: back.tray, mark, mediaTypes: {} }),
      ask,
    });
    expect(ask).not.toHaveBeenCalled();
    expect(out).toEqual({ kind: "send", tray: back.tray, frameAssetId: null });
  });

  it("NOT WHAT I MEANT on an auto-marked plan gives its frame back as her mark", async () => {
    const back = composerAfterReject(
      { draft: "", tray: [], frameAssetId: null },
      job("m1"),
    );
    const mark: Mark = {
      frameAssetId: back.frameAssetId,
      autoOff: autoOffAfterReject({ tray: [], autoOff: false }, job("m1")),
    };
    expect(mark).toEqual({ frameAssetId: "m1", autoOff: false });
    expect(badgedFrame(back.tray, mark, null)).toBe("m1");
  });

  it("with a tray already in the composer nothing is given back, and auto-mark is as she left it", () => {
    expect(
      autoOffAfterReject({ tray: [her("m9")], autoOff: false }, job(null)),
    ).toBe(false);
    expect(
      autoOffAfterReject({ tray: [her("m9")], autoOff: true }, job("m1")),
    ).toBe(true);
  });

  it("a new photo of hers attached after the restore is a new question — two photos and edit-shaped words ask which", async () => {
    const back = composerAfterReject(
      { draft: "", tray: [], frameAssetId: null },
      job(null),
    );
    const mark: Mark = {
      frameAssetId: null,
      autoOff: autoOffAfterAttach("source-frame", true),
    };
    const tray = [...back.tray, her("m2")];
    expect(
      (
        await resolveSend({
          text: SENTENCE,
          routing: true,
          current: () => ({ tray, mark, mediaTypes: {} }),
          ask: realAsk(),
        })
      ).kind,
    ).toBe("ask");
  });
});

// ─── The catch-all through the interpreter: read once at send (C2, 2026-09-16) ────────────────────────────────────

describe("C2 — what the rules could not read, the interpreter reads once at send", () => {
  const frameOf = (r: SendResolution<Attachment>): string | null => {
    if (r.kind !== "send")
      throw new Error(
        `expected a send, got ${r.kind === "ask" ? `the ${r.code} ask` : "an ad"}`,
      );
    return r.frameAssetId;
  };
  const seedOf = (r: SendResolution<Attachment>) =>
    r.kind === "send" ? r.seed : undefined;
  type State = {
    tray: Attachment[];
    mark: Mark;
    mediaTypes: Record<string, string>;
  };
  const stateOf = (
    tray: Attachment[],
    mark: Mark = UNMARKED,
    mediaTypes: Record<string, string> = {},
  ): State => ({ tray, mark, mediaTypes });
  /** What classify answers at send with STUDIO_INTERPRETER on: the real classifier, and the server's own eligibility. */
  const withInterp = (sentence: string, objects = 0): StudioClassification => {
    const routed = route(sentence, true, { objects });
    return {
      ...asMarked(sentence, objects),
      interpretable: interpretable({
        enabled: true,
        nativeEdit: true,
        hasFrame: true,
        drawn: false,
        origin: "system",
        sentence,
        routed,
      }),
    };
  };
  const askInterp = () =>
    jest.fn(async (text: string, objects: number) => withInterp(text, objects));
  /** The same answer from a server whose interpreter is off: no `interpretable`. */
  const plainAsk = () =>
    jest.fn(async (text: string, objects: number) => asMarked(text, objects));

  // Scripted previews — the fields the send reads, in the server's shape.
  const READY: GenerationPreview = {
    previewId: "pv1",
    status: "ready",
    plan: null,
    references: [],
    cost: { amountUsd: 0.13, currency: "USD", basis: "estimated" },
    unpriced: false,
    blockers: [],
    warnings: [],
    verdict: { canGenerate: true, headline: "Ready", reason: null },
    unavailable: null,
  };
  const BLOCKED: GenerationPreview = {
    ...READY,
    previewId: "pv2",
    status: "blocked",
    cost: null,
    blockers: [
      {
        field: "direction",
        note: "We couldn't pin down exactly what to change from that.",
        severity: "blocking",
      },
    ],
    verdict: { canGenerate: false, headline: "Not yet", reason: "blocked" },
  };
  const LINES = {
    lines: [
      {
        kind: "change" as const,
        text: "remove the logo on the sleeve",
        source: "yours" as const,
      },
    ],
  };
  const frozen = (op: string) => ({
    job: {
      editIntent: {
        steps: [
          { op, targets: ["thing"], value: null, scope: "REGION" as const },
        ],
      },
    },
  });
  const PROPOSAL: GenerationPreview = {
    ...READY,
    interpretation: LINES,
    brief: frozen("REMOVE_OBJECT"),
  };
  const ADD_PROPOSAL: GenerationPreview = {
    ...READY,
    interpretation: LINES,
    brief: frozen("ADD_OBJECT"),
  };
  const NEW_IMAGE: GenerationPreview = { ...BLOCKED, newImage: true };
  const DECLINED: GenerationPreview = { ...BLOCKED };
  const NOT_FROZEN: GenerationPreview = {
    ...BLOCKED,
    interpretation: LINES,
    brief: frozen("REMOVE_OBJECT"),
  };
  const UNPRICED: GenerationPreview = {
    ...PROPOSAL,
    unpriced: true,
    cost: { amountUsd: 0, currency: "USD", basis: "estimated", unpriced: true },
  };

  // C2's own acceptance sentence until wave A's V4 read it as a removal; the grass's look is still no rule's.
  const CATCH_ALL = "make the grass moodier";

  it("a catch-all with one photo of hers: ONE reading, of the request her sheet builds — and a ready proposal marks the photo and travels as the seed", async () => {
    const tray = [her("m1")];
    const ask = askInterp();
    const preview = jest.fn<
      Promise<GenerationPreview>,
      [PreviewRequest, AbortSignal]
    >(async () => PROPOSAL);
    const out = await resolveSend({
      text: CATCH_ALL,
      routing: true,
      current: () => stateOf(tray),
      ask,
      interpreter: true,
      preview,
    });
    expect(withInterp(CATCH_ALL)).toMatchObject({
      initialPath: "ASK",
      reason: "fast_path_declined",
      interpretable: true,
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledTimes(1);
    // The sheet, opened with what the send carries, builds exactly this request — so it shows the seed, never asks again.
    const sheet = previewRequestFor({
      format: "photo",
      classification: withInterp(CATCH_ALL),
      direction: CATCH_ALL,
      attachments: tray,
      frameAssetId: "m1",
      interpreter: true,
    });
    expect(sheet.routed.interpreting).toBe(true);
    expect(preview.mock.calls[0][0]).toEqual(sheet.request);
    expect(JSON.stringify(preview.mock.calls[0][0])).toBe(
      JSON.stringify(sheet.request),
    );
    expect(sheet.request).toMatchObject({
      intent: "image.edit",
      sourceAssetId: "m1",
      direction: CATCH_ALL,
    });
    expect(out).toEqual({
      kind: "send",
      tray,
      frameAssetId: "m1",
      seed: { request: sheet.request, preview: PROPOSAL },
    });
  });

  it("the live dead-ends each get a reading — the catch-alls, and the auto-marked add asks (C4 folded in, Adi's D1)", async () => {
    const cases: [string, Attachment[], string][] = [
      [
        "make me hold the gatorade bottle from image 2",
        [her("m1"), attach("object", "o1")],
        "fast_path_declined",
      ],
      // ⚠️ "put the gatorade bottle in my hand" WAS this row until wave D card 5 gave her hand to a
      // hand-sized thing. It routes now, so it is not a dead end and cannot be a reading's case. A
      // ball keeps the shape AND the size guard: too large for a hand, so it still asks.
      [
        "add a ball in my hand",
        [her("m1"), attach("object", "o1")],
        "add_unclear",
      ],
      ["put me mid-air dunking", [her("m1")], "add_unclear"],
      // The control reads too — it is a catch-all — and a reading that is not a proposal leaves it a new image.
      ["generate pic of me playing soccer", [her("m1")], "fast_path_declined"],
    ];
    for (const [text, tray, reason] of cases) {
      const objects = tray.filter((a) => a.role === "object").length;
      expect({
        text,
        reason: withInterp(text, objects).reason,
        interpretable: withInterp(text, objects).interpretable,
      }).toEqual({ text, reason, interpretable: true });
      const read = jest.fn(async () => PROPOSAL);
      const marked = await resolveSend({
        text,
        routing: true,
        current: () => stateOf(tray),
        ask: askInterp(),
        interpreter: true,
        preview: read,
      });
      expect({
        text,
        calls: read.mock.calls.length,
        frame: frameOf(marked),
        seeded: !!seedOf(marked),
      }).toEqual({ text, calls: 1, frame: "m1", seeded: true });
      const declined = await resolveSend({
        text,
        routing: true,
        current: () => stateOf(tray),
        ask: askInterp(),
        interpreter: true,
        preview: async () => DECLINED,
      });
      expect({
        text,
        frame: frameOf(declined),
        seeded: !!seedOf(declined),
      }).toEqual({ text, frame: null, seeded: false });
    }
  });

  it("C2's cell 3 is the rules' edit since wave A's V2 — auto-marked at send, and never read", async () => {
    // "add in hoops from the second picture" was a live dead-end read here (add_unclear); its placed twin ran as a native edit.
    const text = "add in hoops from the second picture";
    const tray = [her("m1"), attach("object", "o1")];
    expect({
      path: withInterp(text, 1).initialPath,
      interpretable: withInterp(text, 1).interpretable,
    }).toEqual({ path: "FULL_IMAGE", interpretable: false });
    const preview = jest.fn(async () => PROPOSAL);
    const out = await resolveSend({
      text,
      routing: true,
      current: () => stateOf(tray),
      ask: askInterp(),
      interpreter: true,
      preview,
    });
    expect({
      calls: preview.mock.calls.length,
      frame: frameOf(out),
      seeded: !!seedOf(out),
    }).toEqual({ calls: 0, frame: "m1", seeded: false });
  });

  it("C2's cells 4 and 5 are the rules' edits since wave A's V4 — auto-marked at send, never read, and a pick ask with three photos", async () => {
    for (const [text, path] of [
      ["take the logo off my sleeve", "MASKED"],
      ["make the sky moodier", "FULL_IMAGE"],
    ] as const) {
      expect({
        text,
        path: withInterp(text).initialPath,
        interpretable: withInterp(text).interpretable,
        shaped: editShaped(true, withInterp(text), text),
      }).toEqual({ text, path, interpretable: false, shaped: true });
      const preview = jest.fn(async () => PROPOSAL);
      const out = await resolveSend({
        text,
        routing: true,
        current: () => stateOf([her("m1")]),
        ask: askInterp(),
        interpreter: true,
        preview,
      });
      expect({
        text,
        calls: preview.mock.calls.length,
        frame: frameOf(out),
        seeded: !!seedOf(out),
      }).toEqual({ text, calls: 0, frame: "m1", seeded: false });
    }
    const three = [her("m1"), her("m2"), her("m3")];
    const pick = await resolveSend({
      text: "take the logo off my sleeve",
      routing: true,
      current: () => stateOf(three),
      ask: askInterp(),
      interpreter: true,
      preview: jest.fn(async () => PROPOSAL),
    });
    expect(pick).toEqual({ kind: "ask", code: FRAME_PICK, tray: three });
  });

  it("every answer but a ready proposal is a NEW IMAGE — never an ask, never a seed", async () => {
    const tray = [her("m1")];
    const answers: [string, () => Promise<GenerationPreview>][] = [
      ["new_image", async () => NEW_IMAGE],
      ["no_proposal", async () => DECLINED],
      // Ready and spendable, but nothing the interpreter proposed — not a reading of her words, so not a mark.
      ["no_proposal (ready, uninterpreted)", async () => READY],
      ["not_ready", async () => NOT_FROZEN],
      ["not_ready (unpriced)", async () => UNPRICED],
      [
        "failed (detection 400)",
        async () => {
          throw new Error("We couldn't find the logo in that photo");
        },
      ],
    ];
    for (const [name, preview] of answers) {
      const out = await resolveSend({
        text: CATCH_ALL,
        routing: true,
        current: () => stateOf(tray),
        ask: askInterp(),
        interpreter: true,
        preview,
      });
      expect({ name, out }).toEqual({
        name,
        out: { kind: "send", tray, frameAssetId: null },
      });
    }
    expect(readingOf(NEW_IMAGE, tray)).toBe("new_image");
    expect(readingOf(DECLINED, tray)).toBe("no_proposal");
    expect(readingOf(READY, tray)).toBe("no_proposal");
    expect(readingOf(NOT_FROZEN, tray)).toBe("not_ready");
    expect(readingOf(UNPRICED, tray)).toBe("not_ready");
    expect(readingOf({ ...PROPOSAL, previewId: "" }, tray)).toBe("not_ready");
    expect(readingOf(null, tray)).toBe("failed");
    expect(readingOf(PROPOSAL, tray)).toBe("proposal");
  });

  it("an interpreted ADD with a product photo and no object photo is a new image (D5; Adi's D2) — with an object photo it is the proposal", async () => {
    const text = "make me hold the gatorade bottle from image 2";
    const product = [her("m1"), attach("product", "p1")];
    const object = [her("m1"), attach("object", "o1")];
    expect(readingOf(ADD_PROPOSAL, product)).toBe("add_unbound");
    expect(readingOf(ADD_PROPOSAL, object)).toBe("proposal");
    // A proposal that adds nothing is not D5's case, product or not.
    expect(readingOf(PROPOSAL, product)).toBe("proposal");
    const withProduct = await resolveSend({
      text,
      routing: true,
      current: () => stateOf(product),
      ask: askInterp(),
      interpreter: true,
      preview: async () => ADD_PROPOSAL,
    });
    expect(withProduct).toEqual({
      kind: "send",
      tray: product,
      frameAssetId: null,
    });
    const withObject = await resolveSend({
      text,
      routing: true,
      current: () => stateOf(object),
      ask: askInterp(),
      interpreter: true,
      preview: async () => ADD_PROPOSAL,
    });
    expect(frameOf(withObject)).toBe("m1");
  });

  it("C3: an interpreted ADD that PLACED her product is the proposal — the send reads what the server bound, never the tray", async () => {
    const withAdd = (objectAssetId: string | null): GenerationPreview => ({
      ...READY,
      interpretation: LINES,
      brief: {
        job: {
          editIntent: {
            steps: frozen("ADD_OBJECT").job.editIntent.steps,
            changes: [{ add: { objectAssetId } }],
          },
        },
      },
    });
    const product = [her("m1"), attach("product", "p1")];
    expect(readingOf(withAdd("p1"), product)).toBe("proposal");
    // The server bound nothing and a product travels: the add would invent its thing beside her product (D2).
    expect(readingOf(withAdd(null), product)).toBe("add_unbound");
    // No product travels: an invented add is not D2's case.
    expect(readingOf(withAdd(null), [her("m1")])).toBe("proposal");
    // Adi's live hit: the bottle in the Product tile, read at send, marks the photo and carries the seed.
    const text = "add a water bottle from image 2";
    const placed = withAdd("p1");
    const out = await resolveSend({
      text,
      routing: true,
      current: () => stateOf(product),
      ask: askInterp(),
      interpreter: true,
      preview: async () => placed,
    });
    expect(frameOf(out)).toBe("m1");
    expect(out.kind === "send" && out.seed?.preview).toBe(placed);
  });

  it("the send gives up at the cap: an answer that never comes is a new image, the call is aborted, and the working state ends", async () => {
    expect(READ_TIMEOUT_MS).toBe(20_000);
    let signal: AbortSignal | undefined;
    const reading: boolean[] = [];
    const out = await resolveSend({
      text: CATCH_ALL,
      routing: true,
      current: () => stateOf([her("m1")]),
      ask: askInterp(),
      interpreter: true,
      preview: (_request, s) => {
        signal = s;
        return new Promise<GenerationPreview>(() => {});
      },
      previewTimeoutMs: 5,
      onReading: (on) => reading.push(on),
    });
    expect(frameOf(out)).toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(reading).toEqual([true, false]);
  });

  it("the working state is on exactly while the reading is out — after the re-ask, never during it", async () => {
    const events: string[] = [];
    await resolveSend({
      text: CATCH_ALL,
      routing: true,
      current: () => stateOf([her("m1")]),
      ask: jest.fn(async (text: string, objects: number) => {
        events.push("ask");
        return withInterp(text, objects);
      }),
      interpreter: true,
      preview: async () => {
        events.push("preview");
        return PROPOSAL;
      },
      onReading: (on) => events.push(on ? "working" : "done"),
    });
    expect(events).toEqual(["ask", "working", "preview", "done"]);
  });

  it("a tap, an untap or any tray change while the reading is out throws the reading away", async () => {
    const during = async (
      change: (s: State) => State,
      answer: GenerationPreview = PROPOSAL,
    ) => {
      let s = stateOf([her("m1")]);
      const out = await resolveSend({
        text: CATCH_ALL,
        routing: true,
        current: () => s,
        ask: askInterp(),
        interpreter: true,
        preview: async () => {
          s = change(s);
          return answer;
        },
      });
      return {
        frame: frameOf(out),
        seeded: !!seedOf(out),
        tray: out.tray.map((a) => a.assetId),
      };
    };
    // Her tap marks the photo: hers wins, as a marked edit — no seed, the sheet reads it as she marked it.
    expect(
      await during((s) => ({
        ...s,
        mark: tapBadge(s.tray, s.mark, null, "m1"),
      })),
    ).toEqual({ frame: "m1", seeded: false, tray: ["m1"] });
    expect(
      await during(
        (s) => ({ ...s, mark: tapBadge(s.tray, s.mark, null, "m1") }),
        DECLINED,
      ),
    ).toEqual({ frame: "m1", seeded: false, tray: ["m1"] });
    // Auto-mark switched off (D3): a new image.
    expect(
      await during((s) => ({
        ...s,
        mark: { frameAssetId: null, autoOff: true },
      })),
    ).toEqual({ frame: null, seeded: false, tray: ["m1"] });
    // An Object photo attached: the reading was for a different tray.
    expect(
      await during((s) => ({
        ...s,
        tray: [...s.tray, attach("object", "o1")],
      })),
    ).toEqual({ frame: null, seeded: false, tray: ["m1", "o1"] });
    // The photo removed.
    expect(await during((s) => ({ ...s, tray: [] }))).toEqual({
      frame: null,
      seeded: false,
      tray: [],
    });
    // A second photo of hers: a new image — never the pick ask after a reading.
    expect(
      await during((s) => ({ ...s, tray: [...s.tray, her("m2")] })),
    ).toEqual({ frame: null, seeded: false, tray: ["m1", "m2"] });
    // A photo finishing its upload changes the chip's row: the tray changed.
    expect(
      await during((s) => ({
        ...s,
        tray: [...s.tray, attach("product", null)],
      })),
    ).toEqual({ frame: null, seeded: false, tray: ["m1", null] });
  });

  it("reads NOTHING — auto-mark's send exactly — with a flag off, her mark, auto-mark off, or a tray the send would ask about", async () => {
    const cases: {
      name: string;
      text: string;
      state: State;
      routing?: boolean;
      interpreter?: boolean;
      omitInterpreter?: true;
      ask?: () => jest.Mock;
    }[] = [
      {
        name: "interpreter off",
        text: CATCH_ALL,
        state: stateOf([her("m1")]),
        interpreter: false,
      },
      // A caller that passes a preview but never says the interpreter is on reads nothing.
      {
        name: "interpreter omitted",
        text: CATCH_ALL,
        state: stateOf([her("m1")]),
        omitInterpreter: true,
      },
      {
        name: "routing off",
        text: CATCH_ALL,
        state: stateOf([her("m1")]),
        routing: false,
      },
      // The server's interpreter is off: classify says not interpretable.
      {
        name: "not interpretable",
        text: CATCH_ALL,
        state: stateOf([her("m1")]),
        ask: plainAsk,
      },
      {
        name: "her mark",
        text: CATCH_ALL,
        state: stateOf([her("m1")], { frameAssetId: "m1", autoOff: false }),
      },
      {
        name: "auto-mark off",
        text: CATCH_ALL,
        state: stateOf([her("m1")], { frameAssetId: null, autoOff: true }),
      },
      {
        name: "two photos of hers",
        text: CATCH_ALL,
        state: stateOf([her("m1"), her("m2")]),
      },
      {
        name: "one still uploading",
        text: CATCH_ALL,
        state: stateOf([her("m1"), her(null)]),
      },
      {
        name: "a video beside it (F.4 asks first)",
        text: CATCH_ALL,
        state: stateOf([her("v1"), her("m1")], UNMARKED, { v1: "VIDEO" }),
      },
      {
        name: "no photo of hers",
        text: CATCH_ALL,
        state: stateOf([attach("object", "o1")]),
      },
      {
        name: "a routed edit",
        text: "make the socks blue",
        state: stateOf([her("m1")]),
      },
      {
        name: "a generate the rules read",
        text: "create a new image of me dunking",
        state: stateOf([her("m1")]),
      },
      {
        name: "her body",
        text: "make my arms bigger",
        state: stateOf([her("m1")]),
      },
      {
        name: "an ask the interpreter never takes",
        text: "change my earrings to these gold hoops",
        state: stateOf([her("m1")]),
      },
      // One product binds since C3, so it reads (pinned above); two products are what is left of D5 (b).
      {
        name: "an add beside two products, no object (D5)",
        text: "put the gatorade bottle in my hand",
        state: stateOf([
          her("m1"),
          attach("product", "p1"),
          attach("product", "p2"),
        ]),
      },
    ];
    for (const c of cases) {
      const preview = jest.fn(async () => PROPOSAL);
      const onReading = jest.fn();
      const run = (extra: object) =>
        resolveSend({
          text: c.text,
          routing: c.routing ?? true,
          current: () => c.state,
          ask: (c.ask ?? askInterp)(),
          ...extra,
        });
      const withIt = await run({
        ...(c.omitInterpreter ? {} : { interpreter: c.interpreter ?? true }),
        preview,
        onReading,
      });
      const without = await run({});
      expect({
        name: c.name,
        calls: preview.mock.calls.length,
        working: onReading.mock.calls.length,
        same: withIt,
      }).toEqual({ name: c.name, calls: 0, working: 0, same: without });
    }
  });

  it("an auto-marked ask the interpreter takes no longer ends in its ask: marked with a proposal, a new image without (C4)", async () => {
    const text = "put me mid-air dunking";
    const tray = [her("m1")];
    // Auto-mark alone marks it, and the sheet's interpreter could ask.
    expect(
      frameOf(
        await resolveSend({
          text,
          routing: true,
          current: () => stateOf(tray),
          ask: askInterp(),
        }),
      ),
    ).toBe("m1");
    expect(
      frameOf(
        await resolveSend({
          text,
          routing: true,
          current: () => stateOf(tray),
          ask: askInterp(),
          interpreter: true,
          preview: async () => DECLINED,
        }),
      ),
    ).toBeNull();
    expect(
      frameOf(
        await resolveSend({
          text,
          routing: true,
          current: () => stateOf(tray),
          ask: askInterp(),
          interpreter: true,
          preview: async () => PROPOSAL,
        }),
      ),
    ).toBe("m1");
  });

  it("interpreterReads names the photo, or nothing", () => {
    const tray = [her("m1")];
    const base = {
      interpreter: true,
      routing: true,
      answer: withInterp(CATCH_ALL),
      text: CATCH_ALL,
      tray,
      mark: UNMARKED,
    };
    expect(interpreterReads(base)).toBe("m1");
    expect(interpreterReads({ ...base, answer: undefined })).toBeNull();
    expect(
      interpreterReads({
        ...base,
        answer: { ...withInterp(CATCH_ALL), interpretable: undefined },
      }),
    ).toBeNull();
    expect(interpreterReads({ ...base, interpreter: false })).toBeNull();
    expect(interpreterReads({ ...base, routing: false })).toBeNull();
    // Every S2 ask the interpreter takes reads; one it never takes does not.
    for (const code of Object.keys(ASK_DECISIONS)) {
      const answer: StudioClassification = {
        op: null,
        targets: [],
        initialPath: "ASK",
        steps: [],
        reason: code,
        interpretable:
          ASK_DECISIONS[code as keyof typeof ASK_DECISIONS] === "interpret",
      };
      const reads =
        code === "fast_path_declined" ||
        (answer.interpretable === true && editShaped(true, answer, CATCH_ALL));
      expect({ code, photo: interpreterReads({ ...base, answer }) }).toEqual({
        code,
        photo: reads ? "m1" : null,
      });
    }
  });

  it("an edit-shaped ask whose reading declined keeps her photo (PR 19, W-4) — only a new-image reading drops it", async () => {
    // Her words ask about THIS photo; the interpreter declining, failing or being blocked means Mila asks on her
    // photo, never a new picture of her. Off, today's pinned answer (above): every non-proposal is a new image.
    const text = "put me mid-air dunking";
    const tray = [her("m1")];
    expect(editShaped(true, withInterp(text), text)).toBe(true);
    const answers: [string, () => Promise<GenerationPreview>, string | null][] =
      [
        ["no_proposal", async () => DECLINED, "m1"],
        ["not_ready", async () => NOT_FROZEN, "m1"],
        [
          "failed",
          async () => {
            throw new Error("the network");
          },
          "m1",
        ],
        ["new_image", async () => NEW_IMAGE, null],
      ];
    for (const [name, preview, frame] of answers) {
      const send = (imageOps: boolean) =>
        resolveSend({
          text,
          routing: true,
          current: () => stateOf(tray),
          ask: askInterp(),
          interpreter: true,
          preview,
          imageOps,
        });
      const on = await send(true);
      expect({ name, frame: frameOf(on), seeded: !!seedOf(on) }).toEqual({
        name,
        frame,
        seeded: false,
      });
      expect({ name, off: frameOf(await send(false)) }).toEqual({
        name,
        off: null,
      });
    }
    // A catch-all is not about this photo: its declined reading stays a new image with the flag on.
    const catchAll = await resolveSend({
      text: CATCH_ALL,
      routing: true,
      current: () => stateOf(tray),
      ask: askInterp(),
      interpreter: true,
      preview: async () => DECLINED,
      imageOps: true,
    });
    expect(frameOf(catchAll)).toBeNull();
  });
});

// ─── F-AM7 — a video "You" chip beside a marked photo (video V4) ────────────────────────────────
//
// Ledger: docs/probes/sweep-4-ledger.md, "A video 'You' beside a marked photo asks 'you marked one
// photo and added other photos of you'". The entry reads as though the ASK were the bug. It is not.
// The trace that settles it, on merged main `9e8bb55`:
//
//   role "source-frame"  →  ENGINE_ROLE  →  engine role "person"        (no media-type filter)
//   wire REFERENCE_ROLES →  resolveReferences → readOwnedImage          (no media-type filter)
//   server/studio/preview.ts:400  refusedOnEdit = mode === "edit" && person.length > 0
//
// So a clip tagged "You" on an edit BLOCKS the preview. `frameChoice("edit")` is what stops that
// today, by filtering the tray as she answers — which makes the ask load-bearing for a server
// contract. The three tests below are the three halves of the fix.
describe("F-AM7", () => {
  const VIDEO = { v1: "VIDEO" };

  describe("RC-AM7-a — the ask KEEPS firing for a clip", () => {
    /**
     * ⚠️ IF THIS EVER GOES GREEN WHILE `frameChoiceNeeded` FILTERS MOTION, the fix that was
     * withdrawn has been reintroduced and she is getting `refusedOnEdit` instead of a question.
     * Shown RED against exactly that build before it was written.
     */
    it("a marked photo beside a video of her still asks", () => {
      const tray = [attach("source-frame", "p1"), attach("source-frame", "v1")];
      expect(frameChoiceNeeded(tray, "p1")).toBe(true);
    });

    it("and answering `edit` still drops the clip, which is what keeps the server happy", () => {
      const tray = [attach("source-frame", "p1"), attach("source-frame", "v1")];
      const out = frameChoice(tray, "p1", "edit");
      expect(out.tray.map((a) => a.assetId)).toEqual(["p1"]);
      expect(out.frameAssetId).toBe("p1");
    });
  });

  describe("RC-AM7-b — the copy stops claiming 'photos' about a clip", () => {
    it("names what is actually beside the marked photo", () => {
      const photo = [
        attach("source-frame", "p1"),
        attach("source-frame", "p2"),
      ];
      const clip = [attach("source-frame", "p1"), attach("source-frame", "v1")];
      const both = [
        attach("source-frame", "p1"),
        attach("source-frame", "p2"),
        attach("source-frame", "v1"),
      ];
      expect(frameCompanions(photo, "p1", VIDEO)).toBe("photos");
      expect(frameCompanions(clip, "p1", VIDEO)).toBe("video");
      expect(frameCompanions(both, "p1", VIDEO)).toBe("mixed");
    });

    it("is null when nothing is being asked about", () => {
      expect(
        frameCompanions([attach("source-frame", "p1")], "p1", VIDEO),
      ).toBeNull();
      expect(
        frameCompanions([attach("source-frame", "p1")], null, VIDEO),
      ).toBeNull();
    });

    it("the clip's sentence does not say 'photos of you'", () => {
      const said = askCopyFor(FRAME_ASK, { companions: "video" });
      expect(said).toMatch(/video/i);
      expect(said).not.toMatch(/other photos of you/i);
    });

    it("every existing code is byte-identical with no option passed", () => {
      // The signature grew; not one shipped sentence moved.
      expect(askCopyFor(FRAME_ASK)).toBe(
        "You marked one photo to edit and added other photos of you. An edit only ever changes the marked photo, so the others wouldn't be used. Edit that one, or make a new image from all of them?",
      );
      expect(askCopyFor(FRAME_ASK, {})).toBe(askCopyFor(FRAME_ASK));
      expect(askCopyFor(FRAME_ASK, { companions: "photos" })).toBe(
        askCopyFor(FRAME_ASK),
      );
      // The option is read for this one code only.
      expect(askCopyFor(FRAME_PICK, { companions: "video" })).toBe(
        askCopyFor(FRAME_PICK),
      );
      expect(askCopyFor("fast_path_declined", { companions: "video" })).toBe(
        askCopyFor("fast_path_declined"),
      );
    });
  });

  describe("RC-AM7-c — a clip never travels as a person reference on an EDIT", () => {
    /**
     * THE DEFECT ITSELF: `canvasesIn` says a clip is never a canvas, `ENGINE_ROLE` says it is
     * always a `person`. Shown RED on main's logic, where the edit below sends one person ref —
     * the one that trips `refusedOnEdit` and blocks the whole preview.
     */
    it("sends zero person references, and says it dropped one", () => {
      const tray = [attach("source-frame", "p1"), attach("source-frame", "v1")];
      const base = tray[0];
      const out = toEngineReferences(tray, MAX_ENGINE_REFERENCES, base, VIDEO);
      expect(out.references.filter((r) => r.role === "person")).toEqual([]);
      expect(out.droppedMotionOnEdit).toBe(1);
    });

    it("the edit base itself is unaffected — it travels as the frame, not as a reference", () => {
      const tray = [attach("source-frame", "p1"), attach("source-frame", "v1")];
      const out = toEngineReferences(
        tray,
        MAX_ENGINE_REFERENCES,
        tray[0],
        VIDEO,
      );
      expect(out.references).toEqual([]);
      expect(out.droppedDuplicate).toBe(0);
    });

    it("a GENERATE is untouched — there is no edit to refuse it", () => {
      // Registered, not fixed: what the engine does with a clip in a person slot is untested, and
      // `refusedOnEdit` does not fire without an edit. Flagged to the engine-reference owner.
      const tray = [attach("source-frame", "p1"), attach("source-frame", "v1")];
      const out = toEngineReferences(tray, MAX_ENGINE_REFERENCES, null, VIDEO);
      expect(out.references.map((r) => r.assetId)).toEqual(["p1", "v1"]);
      expect(out.droppedMotionOnEdit).toBe(0);
    });

    it("with no media types known, nothing is dropped — every pre-video caller is unchanged", () => {
      const tray = [attach("source-frame", "p1"), attach("source-frame", "v1")];
      const out = toEngineReferences(tray, MAX_ENGINE_REFERENCES, tray[0]);
      expect(out.references.map((r) => r.assetId)).toEqual(["v1"]);
      expect(out.droppedMotionOnEdit).toBe(0);
    });

    it("a photo of her on an edit still travels — only motion is dropped", () => {
      const tray = [attach("source-frame", "p1"), attach("source-frame", "p2")];
      const out = toEngineReferences(
        tray,
        MAX_ENGINE_REFERENCES,
        tray[0],
        VIDEO,
      );
      expect(out.references.map((r) => r.assetId)).toEqual(["p2"]);
      expect(out.droppedMotionOnEdit).toBe(0);
    });
  });
});

// ─── F-AM7, the SHEET path (video V4, addendum) ─────────────────────────────────────────────────
//
// The composer answers the frame ask and `frameChoice("edit")` drops the clip, so the composer
// never reaches `refusedOnEdit`. The SHEET does not go through the ask: MakeItScreen and
// ThreadMakeIt hand a tray straight to `useGenerationPlan`, which builds its request with
// `previewRequestFor` — the same builder, a different caller. A clip tagged "You" in that tray
// travelled as a `person` reference and blocked the whole preview.
describe("F-AM7 · RC-AM7-d — the sheet path", () => {
  /** Exactly what useGenerationPlan passes (use-studio-pending.ts), minus the fields refs ignore. */
  const sheetRequest = (
    attachments: Attachment[],
    frameAssetId: string | null,
  ) =>
    previewRequestFor({
      format: "photo",
      classification: undefined,
      // A sentence the OFFLINE verb list recognises as an edit (`editBaseFor`), so this test does
      // not depend on the classifier: "make the socks blue" is precisely the sentence the server
      // routes and the verb list cannot see, and with `classification: undefined` it would plan a
      // generate and there would be no edit base to refuse.
      direction: "remove the ball",
      attachments,
      frameAssetId,
      interpreter: false,
    });

  it("a marked photo beside a video of her sends ZERO person references", () => {
    const tray = [
      attach("source-frame", "p1"),
      { ...attach("source-frame", "v1"), mediaType: "VIDEO" },
    ];
    const { refs, request } = sheetRequest(tray, "p1");

    // The edit is still an edit, on the photo she marked.
    expect(request.sourceAssetId).toBe("p1");
    // And it carries no likeness at all — which is what `refusedOnEdit` refuses.
    expect(refs.references.filter((r) => r.role === "person")).toEqual([]);
    expect(request.references ?? []).toEqual([]);
    expect(refs.droppedMotionOnEdit).toBe(1);
  });

  it("the tray carries the fact — no media-type map is passed, and none is needed", () => {
    // THE POINT OF B. `previewRequestFor` is called here exactly as MakeItScreen's route calls it,
    // with no `mediaTypes` argument, because MakeItScreen has no map to give and never will.
    const tray = [
      attach("source-frame", "p1"),
      { ...attach("source-frame", "v1"), mediaType: "REELS" },
    ];
    expect(sheetRequest(tray, "p1").refs.droppedMotionOnEdit).toBe(1);
  });

  it("a photo of hers in the same tray still travels — only motion is dropped", () => {
    const tray = [
      attach("source-frame", "p1"),
      attach("source-frame", "p2"),
      { ...attach("source-frame", "v1"), mediaType: "VIDEO" },
    ];
    const { refs } = sheetRequest(tray, "p1");
    expect(refs.references.map((r) => r.assetId)).toEqual(["p2"]);
    expect(refs.droppedMotionOnEdit).toBe(1);
  });

  it("a GENERATE is untouched — no edit, nothing to refuse", () => {
    const tray = [
      attach("source-frame", "p1"),
      { ...attach("source-frame", "v1"), mediaType: "VIDEO" },
    ];
    // No mark ⇒ no edit base ⇒ `refusedOnEdit` cannot fire, so nothing is dropped.
    const { refs, request } = sheetRequest(tray, null);
    expect(request.sourceAssetId).toBeUndefined();
    expect(refs.references.map((r) => r.assetId)).toEqual(["p1", "v1"]);
    expect(refs.droppedMotionOnEdit).toBe(0);
  });

  it("an attachment with no mediaType is unchanged — every tray that predates the field", () => {
    const tray = [attach("source-frame", "p1"), attach("source-frame", "p2")];
    expect(sheetRequest(tray, "p1").refs.droppedMotionOnEdit).toBe(0);
  });
});
