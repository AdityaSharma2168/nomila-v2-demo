/**
 * The pack copy — the sentences under the "You" tiles.
 *
 * It is one function and four branches, and it is pinned because two of those sentences are promises
 * about the product rather than decoration: the cap she is told about must be the cap the server
 * enforces, and the consent boundary must actually be said. A silently reworded note is how a
 * boundary stops being stated without anyone noticing.
 */
import {
  CLIP_EMPTY_ASK,
  clipFrameNote,
  MAX_PERSON,
  PERSON_PACK_RULE,
  personPackNote,
} from "./referencePack";
// The SERVER's number, imported rather than restated. studio/config.ts has one import of its own (a
// type) and reads nothing but process.env, so a client suite can hold it — the same door
// studio-contract.test.ts already opens to run the real classifier from a client test.
import { refCapacityFor } from "../../../server/studio/config";

describe("personPackNote", () => {
  it("says nothing until she has tagged a photo of herself", () => {
    // The empty state already carries the ask; a count of zero would be a second, quieter copy of it.
    expect(personPackNote(0)).toBeNull();
  });

  it("asks for more while there is room, and names the ceiling", () => {
    expect(personPackNote(1)).toContain(`1 of ${MAX_PERSON} photos of you`);
    expect(personPackNote(2)).toContain(`2 of ${MAX_PERSON} photos of you`);
    // The REASON to add another, and it must be the MEASURED one. "Different days and different
    // angles hold your face better than one photo can" was the first draft and the control run
    // falsified it: one good photograph is enough, and what fails is a weak photograph. The pack's
    // real job is to stop that weak one from sinking the job.
    expect(personPackNote(1)).toContain(
      "keeps a weaker photo from throwing off your face",
    );
    expect(personPackNote(1)).not.toMatch(/better than one photo/);
  });

  it("stops asking at a full set", () => {
    const note = personPackNote(MAX_PERSON)!;
    expect(note).toContain("a full set");
    expect(note).not.toContain("keeps a weaker photo");
  });

  it("over the cap, says what the server's blocking gap says, one screen earlier", () => {
    // server/studio/preview.ts: "4 photos of you — a piece can be built from up to 3. Remove one and
    // check again." Neither sentence may claim the MODEL imposed this; the cap is ours.
    const note = personPackNote(MAX_PERSON + 1)!;
    expect(note).toContain(`a piece is built from up to ${MAX_PERSON}`);
    expect(note).toContain("Remove one");
    expect(note).not.toContain("this model");
  });

  it("mirrors the server's CHARACTER_CAP — checked against it, not restated", () => {
    // The copy promises a ceiling; the server enforces one. A restated literal lets the two drift
    // apart silently, and then she is told "3 of 3" by a product that accepts five or refuses at two.
    // So this reads the real capacity for the model image.generate routes to, pinned by name: an env
    // override for some other model must not be able to make it green.
    expect(MAX_PERSON).toBe(refCapacityFor("gemini-3-pro-image").character);
    expect(MAX_PERSON).toBe(3);
  });

  it("states the consent boundary in words, because nothing else does", () => {
    // No check anywhere verifies whose face is in a reference. This sentence is the whole control.
    expect(PERSON_PACK_RULE).toMatch(/only/i);
    expect(PERSON_PACK_RULE).toMatch(/not a friend/i);
  });
});

/**
 * The CLIP copy, pinned for the same reason the still copy is: these sentences are promises about the
 * product, and the whole point of the clip pair is that it promises LESS. A reworded note that quietly
 * invited a pack again would put the discarded-photograph promise straight back — and on the Veo arm
 * that promise is not merely unmeasured, it is false.
 */
describe("clipFrameNote", () => {
  it("says nothing with no references", () => {
    expect(clipFrameNote(0)).toBeNull();
  });

  it("names the frame at one, and WHICH photo is the frame above one", () => {
    // It speaks at one too, unlike personPackNote's ask: "this photo is what the clip starts from" is
    // new information about a clip, not a restatement of the tile.
    expect(clipFrameNote(1)).toBe("Your clip starts from this photo.");
    // Above one the only thing she can act on is order, and order is changed by removal — so the
    // sentence has to say WHICH. "One photo is used" would be true and useless.
    expect(clipFrameNote(2)).toContain("the first photo here");
    expect(clipFrameNote(5)).toContain("the first photo here");
  });

  it("never describes what happens to the tail, because that is provider-dependent", () => {
    // ⚠️ THE CLAIM THIS SUITE EXISTS TO FORBID. On Veo the tail is discarded (`refParts[0]` only);
    // over OpenRouter the same tail arrives as `input_references` and does influence the clip. A
    // sentence asserting either one is false on the other arm, and which arm she is on is decided by
    // whether she tagged a person at all — something this component cannot see the routing for.
    for (const n of [1, 2, 3, 4]) {
      const note = clipFrameNote(n)!;
      expect(note).not.toMatch(
        /ignored|discarded|unused|won't be used|not used/i,
      );
    }
  });

  it("carries none of the still copy's three claims", () => {
    for (const n of [1, 2, 3, 4]) {
      const note = clipFrameNote(n)!;
      // ① The cap. CHARACTER_CAP is the IMAGE models' number; no video model is in
      //    defaultRefCapacities, so a clip falls to DEFAULT_REF_CAPACITY and the server refuses at 2.
      //    Naming 3 would state a ceiling that does not exist on this path.
      expect(note).not.toContain(String(MAX_PERSON));
      expect(note).not.toMatch(/of \d+ photos/);
      // ② The measured reason — measured on image.generate, and inapplicable on the arm a
      //    person-tagged clip actually routes to.
      expect(note).not.toContain("keeps a weaker photo");
      // ③ The invitation. A photograph asked for and then discarded is the promise the model will not
      //    keep, which is why the third reference tag was removed.
      expect(note).not.toMatch(/\bmore\b|\badd\b/i);
    }
  });

  it("is not the server's cap refusal wearing different clothes", () => {
    // At three the server's own blocking gap lands on top of this. They may coexist — one is about
    // the frame, the other about the ceiling — but they may not be the same sentence twice.
    const note = clipFrameNote(3)!;
    expect(note).not.toContain("Remove one");
    expect(note).not.toContain("this model");
  });
});

describe("CLIP_EMPTY_ASK", () => {
  it("asks for one photo where the still copy asks for three", () => {
    // ReferencePicker's own empty state says "Up to three photos of you", which is true for a still
    // and a ceiling that does not exist for a clip. This replaces it on the video arm.
    expect(CLIP_EMPTY_ASK).toContain("The photo your clip starts from");
    expect(CLIP_EMPTY_ASK).not.toMatch(/three|up to|\d/i);
  });

  it("asks for no product, because Veo discards it along with every extra likeness", () => {
    // A missing affordance, deliberately — the "Product" chip is still on every tile. Asking her for a
    // product photograph that `refParts[0]` will throw away is the half of the trade that is not
    // acceptable. If the Vertex adapter ever carries a tail, this sentence is the one to revisit.
    expect(CLIP_EMPTY_ASK).not.toMatch(/product/i);
  });
});
