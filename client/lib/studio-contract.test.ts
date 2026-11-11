/**
 * The translation from HER vocabulary to the ENGINE's.
 *
 * ─── WHY THESE TESTS EXIST ─────────────────────────────────────────────────────────────────────
 * Two of them guard failures that are INVISIBLE at runtime, which is the whole reason they are
 * pinned here rather than left to the manual run:
 *
 *   A DROPPED BASE IMAGE. If a photograph she attached fails to become a `person` reference, the
 *   job still succeeds — it just generates from the text alone and returns somebody who is not her.
 *   Nothing errors. `attachedInCreateAnything` is the test that would have caught it.
 *
 *   A LEAKED image.edit. The server refuses an edit with no measured region, so an intent that
 *   drifts back to `image.edit` turns every generation from these screens into a blocked verdict.
 */
import {
  MAX_ENGINE_REFERENCES, ROLE_LABELS, askCopyFor, editBaseFor, engineIntentFor, objectiveFor,
  PICKABLE_ROLES, frameCandidates, frameFor, markedFrame, nextFrameAssetId, objectPhotosIn,
  isMotion, previewRequestFor, routeMarked, routeWithServer, seededPreview, sourceFrameFor, toEngineReferences, trayLabelFor,
  type Attachment, type ReferenceRole, type StudioFormat,
  numberRepeatedNames,
} from "./studio-contract";
import type { GenerationPreview, StudioClassification, StudioEditPath } from "../hooks/use-studio";
// The server's classifier, for one test: the decline copy's examples must route (see its note).
import { route } from "../../server/studio/classify";

const attach = (
  role: ReferenceRole,
  assetId: string | null,
  name = role,
): Attachment => ({ id: `${role}:${assetId}`, role, name, uri: null, assetId });

describe("toEngineReferences", () => {
  it("maps a photo of her to the engine's person role", () => {
    const { references } = toEngineReferences([attach("source-frame", "a1")]);
    expect(references).toEqual([{ assetId: "a1", role: "person" }]);
  });

  it("maps a product to the engine's product role", () => {
    const { references } = toEngineReferences([attach("product", "p1")]);
    expect(references).toEqual([{ assetId: "p1", role: "product" }]);
  });

  /**
   * The role has no engine equivalent and an unknown role is a 400, so it cannot ride along. It is
   * counted rather than silently discarded — the Make it screen owes her the sentence.
   */
  it("drops an inspiration reference and says how many went", () => {
    const out = toEngineReferences([
      attach("source-frame", "a1"),
      attach("inspiration", "i1"),
      attach("inspiration", "i2"),
    ]);
    expect(out.references).toEqual([{ assetId: "a1", role: "person" }]);
    expect(out.droppedInspiration).toBe(2);
  });

  it("never emits a role the server would refuse", () => {
    const out = toEngineReferences([
      attach("source-frame", "a1"), attach("product", "p1"), attach("inspiration", "i1"),
    ]);
    for (const r of out.references) expect(["person", "product"]).toContain(r.role);
  });

  it("drops an attachment that has no asset row yet", () => {
    const out = toEngineReferences([attach("source-frame", null), attach("product", "p1")]);
    expect(out.references).toEqual([{ assetId: "p1", role: "product" }]);
    expect(out.droppedUnresolved).toBe(1);
  });

  /**
   * The tray keys chips by `${role}:${assetId}`, so one photograph attached as both "your media"
   * and "product" is two chips and one asset. The server refuses a repeated assetId outright, so
   * the first occurrence wins here rather than the request earning a 400.
   */
  it("de-duplicates one photo attached under two roles, keeping the first", () => {
    const out = toEngineReferences([attach("source-frame", "same"), attach("product", "same")]);
    expect(out.references).toEqual([{ assetId: "same", role: "person" }]);
    expect(out.droppedDuplicate).toBe(1);
  });

  it("trims at the ceiling and counts what it trimmed", () => {
    const many = Array.from({ length: MAX_ENGINE_REFERENCES + 2 }, (_, i) =>
      attach("source-frame", `a${i}`));
    const out = toEngineReferences(many);
    expect(out.references).toHaveLength(MAX_ENGINE_REFERENCES);
    expect(out.droppedOverCap).toBe(2);
  });

  it("preserves tray order", () => {
    const out = toEngineReferences([
      attach("product", "p1"), attach("source-frame", "a1"), attach("product", "p2"),
    ]);
    expect(out.references.map((r) => r.assetId)).toEqual(["p1", "a1", "p2"]);
  });

  it("returns nothing to send for an empty tray, which is legal", () => {
    const out = toEngineReferences([]);
    expect(out.references).toEqual([]);
    expect(out.droppedInspiration).toBe(0);
  });

  /**
   * ─── THE PRE-CODE 2 GUARD ────────────────────────────────────────────────────────────────────
   * A photograph picked through the ＋ tray's "Your media" tile carries role `source-frame` and an
   * `assetId` straight off `MediaItem.asset_id` (CreateAnythingScreen's addAttachment). If that
   * ever stops becoming a `person` reference, reference-conditioned generation silently degrades
   * to text-only and the athlete gets a stranger back. Pinned exactly as that screen builds it.
   */
  it("attachedInCreateAnything: a photo from the tray becomes a person reference", () => {
    const fromTray: Attachment = {
      id: "source-frame:11111111-1111-4111-8111-111111111111",
      role: "source-frame",
      name: "action",
      uri: "https://example.test/thumb.jpg",
      assetId: "11111111-1111-4111-8111-111111111111",
    };
    const { references, droppedInspiration, droppedUnresolved } = toEngineReferences([fromTray]);
    expect(references).toEqual([
      { assetId: "11111111-1111-4111-8111-111111111111", role: "person" },
    ]);
    expect(droppedInspiration + droppedUnresolved).toBe(0);
  });
});

describe("engineIntentFor — the instruction decides, not the attachment", () => {
  const frame = (assetId: string | null = "a1"): Attachment => ({
    id: "1", role: "source-frame", name: "her.jpg", uri: "file://her.jpg", assetId,
  });
  const product = (): Attachment => ({ id: "2", role: "product", name: "p.jpg", uri: "file://p.jpg", assetId: "p1" });

  it("routes an edit VERB with her photo to image.edit — the door this opens", () => {
    expect(engineIntentFor("photo", "remove the soccer ball", [frame()])).toBe("image.edit");
    expect(engineIntentFor("photo", "take the logo off my sleeve", [frame()])).toBe("image.edit");
    expect(engineIntentFor("photo", "change my jersey to red", [frame()])).toBe("image.edit");
    expect(engineIntentFor("photo", "crop the guy in the background out", [frame()])).toBe("image.edit");
  });

  it("reads a separated particle, and still tells 'take me out' from 'take my jersey off'", () => {
    // English puts the object in the middle of a phrasal verb, and the pronoun after the verb is the
    // whole difference between an edit and a scene.
    expect(engineIntentFor("photo", "take my jersey off", [frame()])).toBe("image.edit");
    expect(engineIntentFor("photo", "take me out to the training pitch at sunrise", [frame()])).toBe("image.generate");
  });

  it("routes a NEW SCENE with the same photo to image.generate — the role collision, resolved", () => {
    // Identical attachment, identical role. Only the sentence differs, and it is the only thing that
    // CAN differ: in Create anything a source-frame means "this is me", and in CampaignWorkspace it
    // means "the frame being edited". See the note on engineIntentFor.
    expect(engineIntentFor("photo", "put me on a rooftop at dusk, city behind me", [frame()])).toBe("image.generate");
    expect(engineIntentFor("photo", "a poster for the last game, bold type", [frame()])).toBe("image.generate");
    expect(engineIntentFor("photo", "make something that reads as mine", [frame()])).toBe("image.generate");
  });

  it("needs BOTH — a verb with nothing attached has nothing to edit", () => {
    expect(engineIntentFor("photo", "remove the soccer ball", [])).toBe("image.generate");
    expect(engineIntentFor("photo", "remove the soccer ball", [product()])).toBe("image.generate");
  });

  it("will not edit an attachment that has no row yet", () => {
    // Still uploading: there is no media_assets id for the server to resolve under her athlete.
    expect(engineIntentFor("photo", "remove the ball", [frame(null)])).toBe("image.generate");
  });

  it("keeps motion on video.generate whatever the sentence says", () => {
    expect(engineIntentFor("video", "remove the ball", [frame()])).toBe("video.generate");
  });

  it("falls back to generate with no instruction at all — today's behaviour, unchanged", () => {
    expect(engineIntentFor("photo")).toBe("image.generate");
    expect(engineIntentFor("photo", undefined, [frame()])).toBe("image.generate");
  });
});

describe("editBaseFor + toEngineReferences — the base does not travel twice", () => {
  const frame = (assetId: string): Attachment => ({
    id: assetId, role: "source-frame", name: "her.jpg", uri: null, assetId,
  });
  const product = (assetId: string): Attachment => ({
    id: assetId, role: "product", name: "p.jpg", uri: null, assetId,
  });

  it("excludes the edit base from the reference list", () => {
    // It is the frame being CHANGED, not material to change it toward. Sending it twice pays its
    // input tokens twice and tells the model the picture it is editing is also a likeness to render
    // from — the role collision reasserting itself one layer down.
    const attachments = [frame("base"), product("prod")];
    const base = editBaseFor("remove the ball", attachments);
    expect(base?.assetId).toBe("base");

    const refs = toEngineReferences(attachments, MAX_ENGINE_REFERENCES, base);
    expect(refs.references.map((r) => r.assetId)).toEqual(["prod"]);
    // And it is NOT reported as dropped: nothing was dropped, it is travelling as sourceAssetId.
    expect(refs.droppedDuplicate).toBe(0);
  });

  it("still counts a genuine duplicate as dropped", () => {
    const attachments = [frame("base"), product("dup"), product("dup")];
    const refs = toEngineReferences(attachments, MAX_ENGINE_REFERENCES, editBaseFor("remove the ball", attachments));
    expect(refs.droppedDuplicate).toBe(1);
  });

  it("sends her photo AS a reference when this is a generate", () => {
    // No edit base ⇒ the source-frame maps to `person` exactly as it always did, and the whole
    // reference-conditioned generate path is untouched.
    const attachments = [frame("base")];
    expect(editBaseFor("put me on a rooftop", attachments)).toBeNull();
    const refs = toEngineReferences(attachments, MAX_ENGINE_REFERENCES, null);
    expect(refs.references).toEqual([{ assetId: "base", role: "person" }]);
  });
});

describe("engineIntentFor", () => {
  it("routes motion to video.generate", () => {
    expect(engineIntentFor("video")).toBe("video.generate");
  });

  it("routes every still to image.generate", () => {
    expect(engineIntentFor("photo")).toBe("image.generate");
    expect(engineIntentFor("carousel")).toBe("image.generate");
    expect(engineIntentFor("story")).toBe("image.generate");
  });

  /**
   * The guard that keeps these screens generating at all. An `image.edit` needs a sourceAssetId and
   * a measured region; neither Create anything nor Setup can supply one, so an edit routed out of
   * them is a 400 or a permanently blocked verdict. Roles are mapped before this is reached, which
   * is what makes the edit branch unreachable rather than merely unused.
   */
  it("never routes to image.edit, whatever the format", () => {
    const formats: StudioFormat[] = ["photo", "carousel", "video", "story"];
    for (const f of formats) expect(engineIntentFor(f)).not.toBe("image.edit");
  });
});

describe("objectiveFor", () => {
  it("shows the partner's product when there is a brand on the job", () => {
    expect(objectiveFor(42)).toBe("showcase-product");
  });

  it("grows her own following when there is not", () => {
    expect(objectiveFor(null)).toBe("grow-following");
    expect(objectiveFor(undefined)).toBe("grow-following");
  });

  it("treats brand id zero as a brand rather than as absent", () => {
    expect(objectiveFor(0)).toBe("showcase-product");
  });
});

// ─── The routing cutover ────────────────────────────────────────────────────────────────────────

describe("sourceFrameFor — the CANDIDATE question, not the picking", () => {
  const frame = (assetId: string | null): Attachment => ({
    id: `f:${assetId}`, role: "source-frame", name: "her.jpg", uri: null, assetId,
  });
  const product = (assetId: string): Attachment => ({
    id: assetId, role: "product", name: "p.jpg", uri: null, assetId,
  });

  it("finds her frame WITHOUT asking anything about her sentence", () => {
    // The whole reason it exists. `editBaseFor` cannot answer this for "make the socks blue" —
    // there is no edit verb in it — and the server-routed edit still needs a base to run on.
    expect(sourceFrameFor([frame("base")])?.assetId).toBe("base");
  });

  it("ignores an attachment with no asset row, which has nothing to point at", () => {
    expect(sourceFrameFor([frame(null)])).toBeNull();
  });

  it("still answers yes/no with several candidates — WHICH one is frameFor's question now", () => {
    // Retained deliberately. This function feeds `hasSourcePhoto`, where the answer is a boolean
    // and the identity of the photograph is irrelevant. What it must no longer do is DECIDE the
    // frame — see the 7.2 block below for the behaviour that moved out.
    expect(sourceFrameFor([frame("one"), frame("two")])).not.toBeNull();
  });

  it("never returns a product or an inspiration", () => {
    expect(sourceFrameFor([product("p")])).toBeNull();
  });
});

describe("editBaseFor is UNCHANGED by the extraction — the gate is still the gate", () => {
  const frame = (assetId: string): Attachment => ({
    id: assetId, role: "source-frame", name: "her.jpg", uri: null, assetId,
  });

  /**
   * ⚠️ THE POINT OF THIS BLOCK. `sourceFrameFor` came OUT of `editBaseFor`, and the constraint on
   * the cutover is that the old gate stays in and keeps working for a full release — it is
   * defence-in-depth for as long as both paths are live, and it is deleted only after. A refactor
   * that quietly widened it would remove the gate while looking like a tidy-up.
   */
  it("still requires an edit verb, not merely an attached photograph", () => {
    expect(editBaseFor("make the socks blue", [frame("base")])).toBeNull();
    expect(editBaseFor("put me on a rooftop at dusk", [frame("base")])).toBeNull();
  });

  it("still fires on the verbs it always fired on", () => {
    expect(editBaseFor("remove the ball", [frame("base")])?.assetId).toBe("base");
    expect(editBaseFor("take the logo off my sleeve", [frame("base")])?.assetId).toBe("base");
  });

  it("still returns null with no instruction at all", () => {
    expect(editBaseFor(undefined, [frame("base")])).toBeNull();
  });
});

describe("routeWithServer — the cutover decision", () => {
  const frame = (assetId: string | null = "base"): Attachment => ({
    id: `f:${assetId}`, role: "source-frame", name: "her.jpg", uri: null, assetId,
  });

  const answer = (
    initialPath: StudioEditPath,
    over: Partial<StudioClassification> = {},
  ): StudioClassification => ({
    op: initialPath === "ASK" ? null : "RECOLOR",
    targets: initialPath === "ASK" ? [] : ["socks"],
    initialPath,
    steps: [],
    ...over,
  });

  it("THE BUG: 'make the socks blue' becomes an edit on her frame", () => {
    // The sentence the whole cutover is named for. The old path returns image.generate for it
    // because NAMES_AN_EDIT has no "make"; the server says FULL_IMAGE, so it is an edit.
    const out = routeWithServer("photo", answer("FULL_IMAGE"), "make the socks blue", [frame()]);
    expect(out.intent).toBe("image.edit");
    expect(out.editBase?.assetId).toBe("base");
    expect(out.askReason).toBeNull();
  });

  it("treats every edit path as an edit — FULL_IMAGE, MASKED and BACKGROUND alike", () => {
    for (const path of ["FULL_IMAGE", "MASKED", "BACKGROUND"] as StudioEditPath[]) {
      expect(routeWithServer("photo", answer(path), "whatever", [frame()]).intent).toBe("image.edit");
    }
  });

  it("routes GENERATE to a generate, with no base travelling", () => {
    const out = routeWithServer("photo", answer("GENERATE"), "make me a new poster", [frame()]);
    expect(out.intent).toBe("image.generate");
    expect(out.editBase).toBeNull();
  });

  /**
   * ⚠️ THE MONOTONICITY PROPERTY, WHICH IS THE SAFETY ARGUMENT FOR SHIPPING THIS.
   *
   * The two gates are OR'd, so the set of sentences reaching `image.generate` can only SHRINK at
   * this flag. An edit that should have been a generate costs her a round trip; a generate that
   * should have been an edit costs her the photograph. Those are not comparable, so every case
   * where the cutover is wrong has to land on the recoverable side BY CONSTRUCTION rather than by
   * our having thought of it.
   */
  it("never generates where the OLD verb list would have edited", () => {
    // The server says GENERATE. The old list says edit ("remove" is on it). The edit wins.
    const out = routeWithServer("photo", answer("GENERATE"), "remove the ball", [frame()]);
    expect(out.intent).toBe("image.edit");
    expect(out.editBase?.assetId).toBe("base");
  });

  it("holds that property across every path the server can answer with", () => {
    const paths: StudioEditPath[] = ["FULL_IMAGE", "MASKED", "BACKGROUND", "GENERATE", "ASK"];
    for (const path of paths) {
      const oldWouldEdit = editBaseFor("remove the ball", [frame()]) !== null;
      const out = routeWithServer("photo", answer(path), "remove the ball", [frame()]);
      // Whatever the server said, this sentence never comes back as a generate that runs.
      const generatesAndRuns = out.intent === "image.generate" && out.askReason === null;
      expect({ path, oldWouldEdit, generatesAndRuns }).toEqual({
        path,
        oldWouldEdit: true,
        generatesAndRuns: false,
      });
    }
  });

  it("carries the ASK reason through instead of routing on it", () => {
    const out = routeWithServer(
      "photo",
      answer("ASK", { reason: "person_target" }),
      "make my hair red",
      [frame()],
    );
    expect(out.askReason).toBe("person_target");
  });

  it("distinguishes the two ASK reasons rather than flattening them", () => {
    const person = routeWithServer("photo", answer("ASK", { reason: "person_target" }), "x", [frame()]);
    const declined = routeWithServer("photo", answer("ASK", { reason: "fast_path_declined" }), "x", [frame()]);
    expect(person.askReason).not.toBe(declined.askReason);
  });

  it("names an ASK with no reason rather than reporting no ASK at all", () => {
    const out = routeWithServer("photo", answer("ASK", { reason: undefined }), "x", [frame()]);
    expect(out.askReason).toBe("unspecified");
  });

  /**
   * ⚠️ NO ANSWER MUST BE TODAY'S BEHAVIOUR, NOT A NEW ONE.
   *
   * `classification` is undefined while the round trip is in flight, when it FAILED, and when the
   * flag is off. A classifier we cannot reach must not be able to change what happens — least of
   * all by defaulting to the one answer that replaces her photograph.
   */
  it("falls back to the verb list exactly when there is no answer", () => {
    expect(routeWithServer("photo", undefined, "make the socks blue", [frame()]).intent)
      .toBe(engineIntentFor("photo", "make the socks blue", [frame()]));
    expect(routeWithServer("photo", undefined, "remove the ball", [frame()]).intent)
      .toBe(engineIntentFor("photo", "remove the ball", [frame()]));
    expect(routeWithServer("photo", undefined, "remove the ball", [frame()]).editBase?.assetId)
      .toBe("base");
  });

  it("never asks about motion — an edit is stills-only", () => {
    const out = routeWithServer("video", answer("FULL_IMAGE"), "make the socks blue", [frame()]);
    expect(out.intent).toBe("video.generate");
    expect(out.editBase).toBeNull();
  });

  it("falls back to a generate when the server says edit but no frame has an asset row", () => {
    // An edit with no base is not an edit — the server refuses it — so it must not travel as one.
    const out = routeWithServer("photo", answer("FULL_IMAGE"), "make the socks blue", [frame(null)]);
    expect(out.intent).toBe("image.generate");
    expect(out.editBase).toBeNull();
  });
});

describe("askCopyFor — a reason code is not a sentence", () => {
  /**
   * The last place the classifier's work can be thrown away. `person_target` is a refusal no
   * rephrasing changes; `fast_path_declined` is a question rephrasing answers. Telling her the same
   * thing for both sends her to rewrite a sentence that was never the problem.
   */
  it("says something DIFFERENT for a refusal than for a question", () => {
    expect(askCopyFor("person_target")).not.toBe(askCopyFor("fast_path_declined"));
  });

  it("does not tell her to rephrase when the answer is no", () => {
    // A person target is refused however it is worded. Copy that invites another go would be a lie.
    expect(askCopyFor("person_target")).toMatch(/don't edit people/i);
  });

  it("invites another sentence when the classifier simply could not read it", () => {
    expect(askCopyFor("fast_path_declined")).toMatch(
      /couldn't tell what to change/i,
    );
  });

  it("falls back to the QUESTION, never an apology, for a reason it has not learned", () => {
    // An unknown code is one the server added and this screen has not caught up with. It is far
    // more likely to mean "we did not understand" than "we refuse", and the question is the answer
    // that leaves her with something to do.
    //
    // Asserted as a SHAPE rather than as string equality with `fast_path_declined`: that one names
    // examples ("the socks blue"), and an unknown reason is exactly the case where we do not know
    // that naming a thing is what she got wrong. Pinning them identical would forbid the fallback
    // from ever being more careful than the case it borrows from.
    expect(askCopyFor("some_future_reason")).toMatch(
      /couldn't tell what to change/i,
    );
    expect(askCopyFor("some_future_reason")).toMatch(/name the thing/i);
  });

  it("never renders the raw code at her", () => {
    for (const r of [
      "person_target",
      "fast_path_declined",
      "no_steps",
      "compound_partial",
      "too_many_changes",
      "compound_conflict",
      "conditional",
      "object_photo_missing",
      "worn_add_unclear",
      "frame_with_likeness",
      "keep_conflict",
      "zzz",
    ]) {
      expect(askCopyFor(r)).not.toContain("_");
    }
  });

  // ─── PR C′, C.4 — the three declines that shared one sentence ─────────────────────────────────
  //
  // Each code below is what the server sends for a real sentence, pinned in
  // server/studio/classify.test.ts ("C.4 — which 'no'"):
  //   "make my arms bigger"          → person_mentioned
  //   "add a soccer ball"            → add_unclear
  //   "change my jersey to adidas"   → brand_change
  // So sentence → code is proven there and code → copy here, and each case's copy is reachable.
  //
  // ⚠️ 2026-09-10: "change my jersey to adidas" ROUTES now (the brand decision, rule 4c), and so do
  // "make my jersey a blue adidas kit" and, since B.1c, a model name ("swap the cleats for Nike
  // Mercurials", disclosed). The brand_change code stays, reached by a colour inside an item — "change
  // my red socks to nike"; its copy is below.
  const C4 = ["person_mentioned", "add_unclear", "brand_change"];

  it("gives each of the three its own sentence — none of them is the catch-all any more", () => {
    const copies = C4.map((code) => askCopyFor(code));
    expect(new Set(copies).size).toBe(3);
    for (const c of copies) {
      expect(c).not.toBe(askCopyFor("fast_path_declined"));
      expect(c).not.toMatch(/not sure what to change/i);
      expect(c).not.toContain("_");
    }
  });

  it("refuses a body edit honestly — the guard's answer, and no invitation to rephrase", () => {
    expect(askCopyFor("person_mentioned")).toBe(askCopyFor("person_target"));
    expect(askCopyFor("person_mentioned")).toMatch(/don't edit people/i);
    expect(askCopyFor("person_mentioned")).not.toMatch(/\btry\b/i);
  });

  it("teaches an add the working phrasing, and says preservation is automatic", () => {
    const copy = askCopyFor("add_unclear");
    expect(copy).toMatch(/where it goes/i);
    expect(copy).toContain("add a soccer ball between my cleats");
    expect(copy).toMatch(/automatic/i);
  });

  // ─── 2026-09-10 — THE BRAND DECISION: the copy says what is true now ───────────────────────────
  //
  // This block used to pin "says plainly that a brand change is not done from a sentence". Brand
  // changes route now (server/studio/classify.ts, rule 4c), so that sentence became false — the one
  // thing this copy may never be. It is replaced, not loosened: the copy is now held to TEACH, and
  // every phrasing it teaches is run through the server's own classifier below.

  /**
   * The quoted PHRASINGS a copy teaches — what she is told to type. A single quoted word is a mention
   * ("give each one its own "the""), not a phrasing, so only quotes with a space in them count.
   */
  const examplesIn = (copy: string) =>
    [...copy.matchAll(/"([^"]+)"/g)]
      .map((m) => m[1])
      .filter((q) => q.includes(" "));

  it("leads with the one-item form, says a colour can come with it, and names what still won't route", () => {
    // B.2b: the one-item form first, descriptors (B.1b) second, the four-item list as the extra. It
    // no longer says Studio won't do a brand change — and since B.1c it must not say Studio refuses a
    // model name either (one routes as its brand, disclosed); what it names is what still asks.
    const copy = askCopyFor("brand_change");
    expect(copy).not.toMatch(/isn't something Studio does/i);
    expect(copy).not.toMatch(/Mercurials|model name/i);
    expect(examplesIn(copy)[0]).toBe("change my jersey to adidas");
    expect(copy).toContain("make my jersey a blue adidas kit");
    expect(copy).toMatch(/up to four/i);
    // Composition made "one brand and one change per sentence" false: a second CHANGE routes now. What
    // still asks is a second brand inside one change, and that is what the copy names — both halves
    // run through the server's classifier, so the sentence she is told cannot drift from the rule.
    expect(copy).not.toMatch(/one change per sentence/i);
    expect(copy).toMatch(/each change can name one brand/i);
    expect(
      route("change my jersey to adidas and make the socks white", true)
        .initialPath,
    ).not.toBe("ASK");
    expect(route("change my jersey to a nike adidas kit", true).reason).toBe(
      "brand_change",
    );
  });

  it("gives a removal naming a brand its own line — never the switching copy, and it names the real fix", () => {
    // "remove the 8 and nike logo" (live, 2026-09-10) → brand_removal, pinned in classify.test.ts. She
    // DID name both things; what stopped it was the digit, and "nike logo" having no "the" of its own.
    const copy = askCopyFor("brand_removal");
    expect(copy).not.toBe(askCopyFor("brand_change"));
    expect(copy).not.toBe(askCopyFor("fast_path_declined"));
    expect(copy).not.toMatch(/another brand|switch/i);
    expect(copy).toMatch(/spell out numbers rather than typing the digit/i);
    expect(copy).toContain('its own "the"');
    expect(copy).not.toContain("_");
  });

  it("asks nothing of two different changes any more — composition routes them, so there is no copy to render (composition)", () => {
    // PR 1 answered both "one change per sentence right now". The server composes them now (rule ½,
    // pinned in classify.test.ts): no reason on the wire, so the screen has nothing to say.
    for (const text of [
      "make her jersey blue and remove the ball",
      // Sweep #3's F2 — told "we don't edit people" on main, about a sentence that edits no one.
      "add a soccer ball at her feet and make her jersey blue",
    ]) {
      const out = route(text, true);
      expect({ text, path: out.initialPath, reason: out.reason }).toEqual({
        text,
        path: "FULL_IMAGE",
        reason: undefined,
      });
    }
  });

  it("gives each compound that still asks its own true line — reached from her sentence, never the catch-all (composition)", () => {
    const table: [string, string, string][] = [
      // One part it could not read, of a sentence whose other part it could.
      [
        "make the socks blue and make it pop",
        "compound_partial",
        "We can do a few changes at once, but couldn't follow one part of that. Try each change on its own to find the part that needs rewording.",
      ],
      // A four-item brand clause and a removal: five steps.
      [
        "change my jersey, shorts, socks and shoes to adidas and remove the ball",
        "too_many_changes",
        "That's more than four changes in one go — split it into two edits.",
      ],
      // Two looks.
      [
        "make it black and white and make it warmer",
        "compound_conflict",
        "That asks for two things that can't both happen — two backgrounds, two looks, or a change to something it also removes. Pick the one you want and try again.",
      ],
    ];
    const copies = table.map(([text, reason, line]) => {
      const out = route(text, true);
      expect({ text, reason: out.reason }).toEqual({ text, reason });
      const copy = askCopyFor(out.reason ?? "");
      expect({ text, copy }).toEqual({ text, copy: line });
      expect(copy).not.toBe(askCopyFor("fast_path_declined"));
      expect(copy).not.toBe(askCopyFor("person_target"));
      expect(copy).not.toContain("_");
      // Nothing to teach: the part to reword is hers to find, so it quotes no phrasing to test.
      expect(examplesIn(copy)).toEqual([]);
      return copy;
    });
    expect(new Set(copies).size).toBe(3);
    // The conflict line is true of its third case too: a change to something the sentence removes.
    expect(
      askCopyFor(
        route("make her jersey blue and remove the jersey", true).reason ?? "",
      ),
    ).toBe(copies[2]);
    // PR 1's "one change per sentence right now" is retired with its code: no server sends it, and a
    // client that still received it would show the question every unknown code gets.
    expect(askCopyFor("compound_pending")).toBe(
      askCopyFor("some_future_reason"),
    );
  });

  it("says a condition is a gap, not her fault — and teaches a phrasing that routes (guard scope, rule ¼)", () => {
    // Mia's (d), first clause verbatim: 0cf9ae9 froze it as REMOVE_OBJECT [uniform]. It asks now, and
    // its line must not be the catch-all (she named the thing) or the brand lecture (it was the "if").
    const d =
      "change my uniform so that its a black adidas uniform. i dont want any nike logos showing in this so if there are any remove them";
    const copy = askCopyFor(route(d, true).reason ?? "");
    expect(copy).toBe(
      'We can\'t do "if" yet — tell us the change directly, like "remove the nike logo".',
    );
    expect(copy).not.toBe(askCopyFor("fast_path_declined"));
    expect(copy).not.toBe(askCopyFor("brand_change"));
    expect(copy).not.toBe(askCopyFor("brand_removal"));
    expect(copy).not.toContain("_");
    // Every phrasing it teaches routes, through the server's own classifier.
    expect(examplesIn(copy)).toEqual(["remove the nike logo"]);
    for (const example of examplesIn(copy)) {
      expect(route(example, true).initialPath).not.toBe("ASK");
    }
  });

  it("retires G.3's 'a call we haven't made yet' — earrings onto her route, and a piercing keeps the person line (PR M3)", () => {
    // G.3 told "add gold hoops to my ears" that adding onto her body was a call not made. Mia made it
    // (M3): both sentences route now, so there is no ask and no copy to show.
    for (const text of [
      "add gold hoops to my ears",
      "put these gold hoops in my ears",
    ]) {
      expect({ text, path: route(text, true).initialPath }).toEqual({
        text,
        path: "FULL_IMAGE",
      });
    }
    // The code is retired: a server that still sent it gets the question every unknown code gets.
    expect(askCopyFor("add_onto_body")).toBe(askCopyFor("some_future_reason"));
    // A stud through her eyebrow is no worn add — a piercing Mia has not opened — and it asks with the
    // person line, which is true of it. So does a tattoo, which is not worn at all. (The stud was in her
    // nose here until M3.9 opened the nose.)
    for (const text of [
      "put a stud through my eyebrow",
      "add a tattoo on my arm",
    ]) {
      expect({
        text,
        copy: askCopyFor(route(text, true).reason ?? ""),
      }).toEqual({ text, copy: askCopyFor("person_target") });
    }
  });

  it("tells her to say an unread worn item plainly — never the person line, and its example routes (PR M3.8)", () => {
    // "add small gold hoops to my ears" and "put a baseball cap on my head" asked with the person line
    // until M3.8 — false of hoops and a cap, since the plain sentence routes.
    const copies = [
      "add small gold hoops to my ears",
      "put a baseball cap on my head",
    ].map((text) => askCopyFor(route(text, true).reason ?? ""));
    expect(copies[0]).toBe(copies[1]);
    const copy = copies[0];
    expect(copy).toBe(
      'Say the item plainly and where it goes — "add gold hoops to my ears".',
    );
    expect(copy).not.toBe(askCopyFor("person_target"));
    expect(copy).not.toMatch(/don't edit people/i);
    expect(copy).not.toBe(askCopyFor("add_unclear"));
    expect(copy).not.toContain("_");
    expect(examplesIn(copy)).toEqual(["add gold hoops to my ears"]);
    for (const example of examplesIn(copy)) {
      expect(route(example, true).initialPath).not.toBe("ASK");
    }
    // A piercing Mia has not opened keeps the person line (the nose's was here until M3.9).
    expect(askCopyFor(route("add a ring to my lip", true).reason ?? "")).toBe(
      askCopyFor("person_target"),
    );
  });

  it("tells her a look she named isn't one we know yet — and every look it names routes (style vocabulary, V.4)", () => {
    // "give it a dreamy vibe" got the catch-all ("name the thing"), and "add a dreamy filter" add_unclear's
    // "say where it goes". She named a look; the line says that look is not one we have, and which are.
    const copies = ["give it a dreamy vibe", "add a dreamy filter"].map(
      (text) => askCopyFor(route(text, true).reason ?? ""),
    );
    expect(copies[0]).toBe(copies[1]);
    const copy = copies[0];
    expect(copy).toBe(
      "That look isn't one we know yet — try warmer, moodier, cinematic, vintage or black and white.",
    );
    expect(copy).not.toBe(askCopyFor("fast_path_declined"));
    expect(copy).not.toBe(askCopyFor("add_unclear"));
    expect(copy).not.toContain("_");
    // The looks it names, read off the line itself, each through the server's own classifier: "make it
    // <look>" is one whole-frame look carrying that word. A look that stops routing is red here.
    const named = copy.slice(copy.indexOf("try ") + 4, -1).split(/, | or /);
    expect(named).toEqual([
      "warmer",
      "moodier",
      "cinematic",
      "vintage",
      "black and white",
    ]);
    for (const look of named) {
      const out = route(`make it ${look}`, true);
      expect({ look, steps: out.steps }).toEqual({
        look,
        steps: [
          { op: "GLOBAL_STYLE", targets: [], value: look, scope: "GLOBAL" },
        ],
      });
    }
  });

  it("tells her a change would alter what she kept — reached from her sentence, and its example routes (the preservation fixes, K2)", () => {
    // A keep of a thing is set aside by the server (server/studio/classify.ts, `route`); where the change beside
    // it would alter the thing — a look or a background changes the whole photo — the sentence asks this code.
    // It is not the conflict line: she asked for one change and one keep, not two changes.
    const copies = [
      "make it warmer but keep the background the same",
      "make everything blue but keep my cleats",
    ].map((text) => askCopyFor(route(text, true).reason ?? ""));
    expect(copies[0]).toBe(copies[1]);
    const copy = copies[0];
    expect(copy).toBe(
      "A look or a new background covers the whole photo, so it can't leave that part untouched. Name just the thing to change — \"make the socks blue\" — and everything you don't name stays as it is.",
    );
    expect(copy).not.toBe(askCopyFor("compound_conflict"));
    expect(copy).not.toBe(askCopyFor("fast_path_declined"));
    expect(copy).not.toContain("_");
    // Its one example, read out of the copy, through the server's own classifier.
    expect(examplesIn(copy)).toEqual(["make the socks blue"]);
    expect(
      route("make the socks blue", true).steps.map((s) => [
        s.op,
        s.targets,
        s.value,
      ]),
    ).toEqual([["RECOLOR", ["socks"], "blue"]]);
  });

  it("gives a placeless body modification the person line, not 'say where it goes' (PR M3, BODY_MODS)", () => {
    // On bccaf2b "add a tattoo" got add_unclear's copy, which invites her to name a place — and the place
    // she named would be refused as her body. The person line is true of it, and invites nothing.
    for (const text of ["add a tattoo", "add muscles", "give me abs"]) {
      const copy = askCopyFor(route(text, true).reason ?? "");
      expect({ text, copy }).toEqual({
        text,
        copy: askCopyFor("person_target"),
      });
      expect(copy).not.toBe(askCopyFor("add_unclear"));
    }
  });

  it("gives a body-edit clause inside a compound the person refusal back — true of that part, and no invitation to reword (d1)", () => {
    // PR 1 told this "one change per sentence", which invited her to send "make my arms bigger" on
    // its own — to be refused then. The clause's own code wins now, and its copy is the refusal.
    const copy = askCopyFor(
      route("add a soccer ball at her feet and make my arms bigger", true)
        .reason ?? "",
    );
    expect(copy).toBe(askCopyFor("person_target"));
    expect(copy).toMatch(/don't edit people/i);
    expect(copy).not.toMatch(/\btry\b/i);
  });

  it("teaches only phrasings that ROUTE — every example, read out of the copy, through the server's classifier", () => {
    // The one import from server/ in this file, and on purpose: a teaching sentence is true only if
    // its example works, and reading the examples out of the copy itself means the words she is shown
    // and the sentences tested cannot drift apart. Every example is pinned: a new one without a row
    // here fails, so no example reaches her untested.
    const expected: Record<string, [string, string[], string | null][]> = {
      "change my jersey to adidas": [
        ["REPLACE_OBJECT", ["jersey"], "adidas jersey"],
      ],
      "make my jersey a blue adidas kit": [
        ["REPLACE_OBJECT", ["jersey"], "blue adidas jersey"],
      ],
      // Both things removed — the removal copy's "its own the" is what keeps the logo in.
      "remove the number eight and the nike logo": [
        ["REMOVE_OBJECT", ["number eight", "nike logo"], null],
      ],
    };
    const taught = [
      ...examplesIn(askCopyFor("brand_change")),
      ...examplesIn(askCopyFor("brand_removal")),
    ];
    expect(taught).toEqual(Object.keys(expected));
    for (const example of taught) {
      expect({
        example,
        steps: route(example, true).steps.map((s) => [
          s.op,
          s.targets,
          s.value,
        ]),
      }).toEqual({ example, steps: expected[example] });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE TRAY LABEL — NO ENGINE ENUM REACHES HER, IN ANY STATE
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("trayLabelFor", () => {
  const ROLES: ReferenceRole[] = ["source-frame", "product", "inspiration"];

  it("names the shot when vision has tagged it", () => {
    expect(trayLabelFor("portrait", "source-frame")).toBe("Portrait");
    expect(trayLabelFor("action", "source-frame")).toBe("Action");
    expect(trayLabelFor("lifestyle", "source-frame")).toBe("Lifestyle");
    expect(trayLabelFor("group", "source-frame")).toBe("Group");
  });

  it("translates the vision words nobody says out loud", () => {
    // The half a `?? role`-only fix would have left leaking: this one IS a raw token and it renders
    // the moment the cron catches up, so it needs translating rather than defaulting.
    expect(trayLabelFor("text_graphic", "source-frame")).toBe("Graphic");
    expect(trayLabelFor("other", "source-frame")).toBe("Photo");
  });

  it("falls back to HER word for the role while the asset is still untagged", () => {
    // The observed bug, stated as its acceptance: this is the ~90-second window between ingest and
    // the enrichment cron, and it used to render "source-frame".
    expect(trayLabelFor(null, "source-frame")).toBe("Your media");
    expect(trayLabelFor(undefined, "source-frame")).toBe("Your media");
    expect(trayLabelFor("", "source-frame")).toBe("Your media");
    expect(trayLabelFor("   ", "source-frame")).toBe("Your media");
    expect(trayLabelFor(null, "product")).toBe("Product");
  });

  it("normalises case and whitespace the way the tag might arrive", () => {
    expect(trayLabelFor("  ACTION  ", "source-frame")).toBe("Action");
    expect(trayLabelFor("Text_Graphic", "product")).toBe("Graphic");
  });

  it("falls back rather than echoing a shot_type it does not recognise", () => {
    // A new value added to visionTag's schema must not arrive in the tray verbatim.
    expect(trayLabelFor("wide_establishing", "source-frame")).toBe("Your media");
    expect(trayLabelFor("détourage", "product")).toBe("Product");
  });

  /**
   * ⚠️ THE ONE THAT MATTERS. Every other assertion here names an input and its expected output, so
   * all of them would still pass if a NEW role were added with no label — the leak would simply be
   * unreachable from any test that did not think to name it. This asserts the property instead:
   * whatever the state, the output is never an engine token.
   */
  it("cannot return an engine enum, over every role × every tag state", () => {
    const TAG_STATES = [
      null, undefined, "", "   ",
      "portrait", "action", "lifestyle", "group", "text_graphic", "other",
      "wide_establishing", "SOURCE-FRAME", "source-frame", "product",
    ];
    for (const role of ROLES) {
      for (const tag of TAG_STATES) {
        const label = trayLabelFor(tag, role);
        expect(label).toBeTruthy();
        // No role token, and no snake_case — both are shapes only our own vocabulary has.
        expect(ROLES).not.toContain(label);
        expect(label).not.toMatch(/[_-]/);
        // A label is something she could read aloud: starts capitalised, no lone lowercase token.
        expect(label).toMatch(/^[A-Z]/);
      }
    }
  });

  it("labels every member of ReferenceRole — a role with no label is the hole this closes", () => {
    // Hand-written, not derived from Object.keys(ROLE_LABELS): a map compared against itself
    // reports green no matter what is missing from it.
    expect(ROLE_LABELS["source-frame"]).toBe("Your media");
    expect(ROLE_LABELS.product).toBe("Product");
    expect(ROLE_LABELS.inspiration).toBe("Inspiration");
    expect(ROLE_LABELS.object).toBe("Object");
    // PR 18: the Style tile's role (EXPO_PUBLIC_STUDIO_STYLE_SPEC), named here as this test requires.
    expect(ROLE_LABELS.style).toBe("Style");
    expect(Object.keys(ROLE_LABELS).sort())
      .toEqual(["inspiration", "object", "product", "source-frame", "style"]);
  });
});

// ─── R.1 — the frame is HER MARK, never tray order ──────────────────────────────────────────────

/**
 * SWEEP 7.2, AS A TEST.
 *
 * Two attachments, both "Your media": a soccer ball and her photograph. The ball was tapped first.
 * Before this, `sourceFrameFor` returned the ball, `sourceAssetId` was the ball, the edit targeted
 * the ball, and her photograph travelled as a `person` reference — the model was told the ball was
 * the frame. Reproduced on 2026-09-09 with "make the socks yellow", which routes where 7.2's own
 * sentence still ASKs.
 *
 * The fix is not a better guess about which photograph is a ball. It is that the frame stops being
 * derivable from array position at all.
 */
describe("R.1 — the reference cannot displace the frame", () => {
  const ball = (): Attachment => ({
    id: "ball", role: "source-frame", name: "ball.jpg", uri: null, assetId: "b-ball",
  });
  const her = (): Attachment => ({
    id: "her", role: "source-frame", name: "her.jpg", uri: null, assetId: "a-her",
  });

  it("takes HER MARK even when the other photograph was attached first", () => {
    const tray = [ball(), her()];
    expect(frameFor(tray, "a-her")?.name).toBe("her.jpg");
    // The inversion, stated as the thing that no longer happens.
    expect(frameFor(tray, "a-her")?.name).not.toBe("ball.jpg");
  });

  it("routes the EDIT onto the marked photograph, not the first one", () => {
    const answer: StudioClassification = {
      op: "RECOLOR", targets: ["socks"], initialPath: "FULL_IMAGE" as StudioEditPath,
      steps: [],
    };
    const out = routeWithServer("photo", answer, "make the socks yellow", [ball(), her()], "a-her");
    expect(out.intent).toBe("image.edit");
    expect(out.editBase?.assetId).toBe("a-her");
  });

  it("leaves the ball as a reference rather than as the frame", () => {
    const tray = [ball(), her()];
    const base = frameFor(tray, "a-her");
    const { references } = toEngineReferences(tray, MAX_ENGINE_REFERENCES, base);
    expect(references.map((r) => r.assetId)).toEqual(["b-ball"]);
  });

  it("ignores a mark that names an attachment which cannot be a base", () => {
    // Still uploading — no row to point at, so it is not a candidate and the mark cannot stick.
    const uploading: Attachment = {
      id: "x", role: "source-frame", name: "her.jpg", uri: null, assetId: null,
    };
    expect(frameFor([uploading, ball()], "nothing-like-this")?.assetId).toBe("b-ball");
  });

  it("falls back to the first candidate when nothing is marked — today's behaviour, unchanged", () => {
    // The compatibility shim, pinned so a later reader does not mistake it for the contract. It
    // exists because "no frame" routes an edit to GENERATE, which is the expensive direction.
    expect(frameFor([ball(), her()], null)?.assetId).toBe("b-ball");
  });

  it("frameCandidates is media of HERS with a row, in tray order", () => {
    const product: Attachment = {
      id: "p", role: "product", name: "p.jpg", uri: null, assetId: "p1",
    };
    expect(frameCandidates([ball(), product, her()]).map((a) => a.assetId))
      .toEqual(["b-ball", "a-her"]);
  });
});

describe("R.1 — nextFrameAssetId: the mark stays still while the tray moves", () => {
  const a = (assetId: string, role: ReferenceRole = "source-frame"): Attachment => ({
    id: assetId, role, name: `${assetId}.jpg`, uri: null, assetId,
  });

  it("marks NOTHING when nothing is marked — attaching a photo of hers is not marking it", () => {
    // Frame defaulting, 2026-09-16. This used to answer "one": her first photograph became the
    // frame on attach, which is how a pack of her photos could only ever plan as an edit.
    expect(nextFrameAssetId([a("one")], null)).toBeNull();
    expect(nextFrameAssetId([a("one"), a("two"), a("three")], null)).toBeNull();
  });

  it("DOES NOT MOVE when a second photograph is attached — the invariant", () => {
    expect(nextFrameAssetId([a("one"), a("two")], "one")).toBe("one");
  });

  it("does not move when a product is attached either", () => {
    expect(nextFrameAssetId([a("one"), a("p", "product")], "one")).toBe("one");
  });

  it("does NOT move on when the marked photograph is removed — no other photo becomes the frame", () => {
    // Frame defaulting: this used to answer "two", which is the "× moves the EDITING badge to the
    // next photo" half of the bug — she could not get to a tray with no frame in it.
    expect(nextFrameAssetId([a("two")], "one")).toBeNull();
  });

  it("goes null when the last candidate is removed, so the screen stops calling it an edit", () => {
    expect(nextFrameAssetId([a("p", "product")], "one")).toBeNull();
    expect(nextFrameAssetId([], "one")).toBeNull();
  });

  it("never returns an id that is not a candidate — and promotes nothing in its place", () => {
    expect(nextFrameAssetId([a("one")], "deleted-long-ago")).toBeNull();
  });
});

describe("frame defaulting — the frame is only ever the photograph she marked", () => {
  const her = (assetId: string | null): Attachment => ({
    id: `source-frame:${assetId}`,
    role: "source-frame",
    name: "her.jpg",
    uri: null,
    assetId,
  });
  const product: Attachment = {
    id: "product:p1",
    role: "product",
    name: "p.jpg",
    uri: null,
    assetId: "p1",
  };
  const pack = [her("m1"), her("m2"), her("m3")];
  const answer = (
    initialPath: StudioEditPath,
    over: Partial<StudioClassification> = {},
  ): StudioClassification => ({
    op: initialPath === "ASK" ? null : "RECOLOR",
    targets: [],
    initialPath,
    steps: [],
    ...over,
  });

  it("markedFrame: the marked photo, or null — never the first one standing in", () => {
    expect(markedFrame(pack, "m2")?.assetId).toBe("m2");
    expect(markedFrame(pack, null)).toBeNull();
    expect(markedFrame(pack, "gone")).toBeNull();
    // A product cannot be the frame, and a photo still uploading has no row to be one.
    expect(markedFrame([product], "p1")).toBeNull();
    expect(markedFrame([her(null), her("m1")], null)).toBeNull();
    // `frameFor` keeps its shim for direct callers — the contrast is the point.
    expect(frameFor(pack, null)?.assetId).toBe("m1");
  });

  it('THE BUG: her pack and "generate pic of me playing soccer" is a GENERATE from all three', () => {
    const sentence = "generate pic of me playing soccer";
    // What the classify call is told, and what the server's own classifier answers to it.
    const hasSourcePhoto = markedFrame(pack, null) !== null;
    expect(hasSourcePhoto).toBe(false);
    const classified = route(sentence, hasSourcePhoto);
    expect(classified.initialPath).toBe("GENERATE");
    // Told there WAS a photo to edit — what the tray used to send — the same words ask instead.
    expect(route(sentence, true).initialPath).toBe("ASK");

    const out = routeMarked("photo", answer("GENERATE"), sentence, pack, null);
    expect(out).toEqual({
      intent: "image.generate",
      editBase: null,
      askReason: null,
    });
    const { references } = toEngineReferences(
      pack,
      MAX_ENGINE_REFERENCES,
      out.editBase,
    );
    expect(references).toEqual([
      { assetId: "m1", role: "person" },
      { assetId: "m2", role: "person" },
      { assetId: "m3", role: "person" },
    ]);
  });

  it("with nothing marked, an edit answer cannot find a frame — the shim has nothing to reach", () => {
    const out = routeMarked(
      "photo",
      answer("FULL_IMAGE"),
      "make the socks blue",
      [her("m1")],
      null,
    );
    expect(out.intent).toBe("image.generate");
    expect(out.editBase).toBeNull();
    // routeWithServer over the whole tray is unchanged: it still falls back to the first photo.
    expect(
      routeWithServer(
        "photo",
        answer("FULL_IMAGE"),
        "make the socks blue",
        [her("m1")],
        null,
      ).editBase?.assetId,
    ).toBe("m1");
  });

  it("with a mark, it is exactly routeWithServer's edit of that photo — the rest stay references", () => {
    const tray = [her("m1"), product, her("m2")];
    const out = routeMarked(
      "photo",
      answer("FULL_IMAGE"),
      "make the socks blue",
      tray,
      "m2",
    );
    expect(out).toEqual(
      routeWithServer(
        "photo",
        answer("FULL_IMAGE"),
        "make the socks blue",
        tray,
        "m2",
      ),
    );
    expect(out.intent).toBe("image.edit");
    expect(out.editBase?.assetId).toBe("m2");
    // The unmarked photo of her still travels, as a person — the case the tray now asks about.
    expect(
      toEngineReferences(tray, MAX_ENGINE_REFERENCES, out.editBase).references,
    ).toEqual([
      { assetId: "m1", role: "person" },
      { assetId: "p1", role: "product" },
    ]);
  });

  it("with no classifier answer (routing off), the verb list edits only a marked photo", () => {
    expect(
      routeMarked("photo", undefined, "remove the ball", [her("m1")], null)
        .intent,
    ).toBe("image.generate");
    const marked = routeMarked(
      "photo",
      undefined,
      "remove the ball",
      [her("m1")],
      "m1",
    );
    expect(marked.intent).toBe("image.edit");
    expect(marked.editBase?.assetId).toBe("m1");
  });

  it("the interpreter takes an ask only over a marked photo", () => {
    const ask = answer("ASK", {
      reason: "fast_path_declined",
      interpretable: true,
    });
    const unmarked = routeMarked(
      "photo",
      ask,
      "make it pop",
      [her("m1")],
      null,
      true,
    );
    expect(unmarked.interpreting).toBeUndefined();
    expect(unmarked.askReason).toBe("fast_path_declined");
    const marked = routeMarked(
      "photo",
      ask,
      "make it pop",
      [her("m1")],
      "m1",
      true,
    );
    expect(marked).toEqual({
      intent: "image.edit",
      editBase: her("m1"),
      askReason: null,
      interpreting: true,
    });
  });

  it("a mark that names nothing in the tray is no frame", () => {
    expect(
      routeMarked("photo", answer("MASKED"), "remove the ball", pack, "gone")
        .editBase,
    ).toBeNull();
  });
});

// ─── R.3 — the tile contract ────────────────────────────────────────────────────────────────────

/**
 * ONE TILE USED TO CARRY THREE MEANINGS, and the third had no tile at all.
 *
 * The frame being edited, an identity anchor, and an object library to pull a thing out of. With
 * no Object tile a soccer ball had nowhere to go but "Your media" — and a "Your media" attachment
 * could become the frame being edited, which is sweep 7.2 in one sentence.
 *
 * These assertions are hand-written rather than derived from the constants they check. A test that
 * iterates the list it protects reports green when the list shrinks; the runbook has three measured
 * instances of exactly that, one of which survived deleting "socks" from GARMENT_NOUNS.
 */
describe("R.3 — every role a picker can mint has somewhere to go", () => {
  it("offers a tile for material, so a ball is never tagged as a photo of her", () => {
    expect(PICKABLE_ROLES).toContain("object");
  });

  it("offers exactly these three, named one at a time", () => {
    expect([...PICKABLE_ROLES].sort()).toEqual(["object", "product", "source-frame"]);
  });

  it("never offers a look reference — the promise it made was not one we could keep", () => {
    expect(PICKABLE_ROLES).not.toContain("inspiration");
  });

  it("routes every pickable role to an engine role — a tile that drops is a silent no-op", () => {
    // `inspiration` is the one role that legitimately maps to null, and it is not pickable. Any
    // OTHER null here is a tile she can tap that produces nothing in the request.
    for (const role of PICKABLE_ROLES) {
      const { references } = toEngineReferences([attach(role, `asset-${role}`)]);
      expect(references).toHaveLength(1);
    }
    // The hand-written half: the loop above passes vacuously if PICKABLE_ROLES is emptied.
    expect(PICKABLE_ROLES).toHaveLength(3);
  });
});

// ─── R.4 — where the photograph GOES once the classifier has spoken ─────────────────────────────

/**
 * The server decides GENERATE-or-EDIT (studio.classify.test.ts pins that). This is the half that
 * decides what happens to her photograph afterwards, and the two failures are not symmetrical:
 *
 *   On a GENERATE it must become her IDENTITY — role `person`, the character slot. Dropped, the job
 *   still succeeds and returns somebody who is not her, with nothing logged.
 *   On an EDIT it must become the FRAME — `sourceAssetId`, and not also a reference, because a
 *   likeness on an edit is refused outright by the engine (preview.ts refusedOnEdit).
 */
describe("R.4 — the attached photograph lands in the right place on each side of the line", () => {
  const her = (): Attachment => ({
    id: "her", role: "source-frame", name: "her.jpg", uri: null, assetId: "a-her",
  });
  const answer = (initialPath: StudioEditPath): StudioClassification => ({
    op: initialPath === "GENERATE" ? "GENERATE" : "RECOLOR",
    targets: [],
    initialPath,
    steps: [],
  });

  it("GENERATE: her photo travels as a person reference, and nothing is being edited", () => {
    const tray = [her()];
    const out = routeWithServer("photo", answer("GENERATE"), "create an adidas ad featuring me", tray, "a-her");
    expect(out.intent).toBe("image.generate");
    expect(out.editBase).toBeNull();

    const { references } = toEngineReferences(tray, MAX_ENGINE_REFERENCES, out.editBase);
    expect(references).toEqual([{ assetId: "a-her", role: "person" }]);
  });

  it("EDIT: her photo is the frame and does NOT also travel as a reference", () => {
    // Sending it twice pays its input tokens twice AND tells the model the picture it is editing
    // is a likeness to render from — the collision reasserting itself one layer down.
    const tray = [her()];
    const out = routeWithServer("photo", answer("BACKGROUND"), "put me on a rooftop at dusk", tray, "a-her");
    expect(out.intent).toBe("image.edit");
    expect(out.editBase?.assetId).toBe("a-her");

    const { references } = toEngineReferences(tray, MAX_ENGINE_REFERENCES, out.editBase);
    expect(references).toEqual([]);
  });

  it("a generate carries the OBJECT beside her, in its own role", () => {
    // Generate-with-reference is not identity-only: "create an adidas ad featuring me" with a ball
    // attached should reach the model as her likeness AND the ball, in two different slots.
    const ball: Attachment = {
      id: "ball", role: "object", name: "ball.jpg", uri: null, assetId: "b-ball",
    };
    const tray = [her(), ball];
    const out = routeWithServer("photo", answer("GENERATE"), "create an adidas ad featuring me", tray, "a-her");
    const { references } = toEngineReferences(tray, MAX_ENGINE_REFERENCES, out.editBase);
    expect(references).toEqual([
      { assetId: "a-her", role: "person" },
      { assetId: "b-ball", role: "object" },
    ]);
  });
});

describe("replace with reference — she points at a photo; the tray says whether there is one", () => {
  const FOUNDER = "change my earrings to these gold hoops";

  it("asks for the photo, or for the words — and the example it teaches routes as what it says", () => {
    const copy = askCopyFor("object_photo_missing");
    expect(copy).toBe(
      'Attach a photo of the thing you want with the Product or Object tile — or describe it instead, like "make my earrings gold".',
    );
    // Reached from her sentence with nothing attached, through the server's own classifier.
    expect(route(FOUNDER, true).reason).toBe("object_photo_missing");
    // The example routes, and routes as its own words: gold earrings.
    const [example] = [...copy.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const out = route(example, true);
    expect(out.steps.map((s) => [s.op, s.targets, s.value])).toEqual([
      ["RECOLOR", ["earrings"], "gold"],
    ]);
    // NOT the obvious one, which routes as gold earrings with "hoops" dropped — the copy would teach
    // her a sentence that does not do what it says.
    expect(route("change my earrings to gold hoops", true).steps[0].value).toBe(
      "gold",
    );
    expect(copy).not.toContain("gold hoops");
  });

  // ⚠️ RE-PINNED BY CARD 4; the title used to say "never a product". It counts a product NOW when the
  // Object tile is empty, because the server's `attachedIn` does — and the two disagreeing is what sent
  // a live Product-tile replacement to a GENERATE: the composer told /studio/classify there were zero
  // object photos, the server asked on that number, and the send fell back to a new image.
  it("counts the PLACEABLE photos that GO — a product only when the Object tile is empty, never an unresolved upload, never one photo twice", () => {
    expect(objectPhotosIn([])).toBe(0);
    expect(objectPhotosIn([attach("object", "hoops")])).toBe(1);
    // CARD 4: her product stands where an Object photo would when there is no Object photo.
    expect(
      objectPhotosIn([attach("product", "boot"), attach("source-frame", "me")]),
    ).toBe(1);
    // Still uploading: nothing to point at yet.
    expect(objectPhotosIn([attach("object", null)])).toBe(0);
    // One photo tagged twice goes once, as the first role it was given.
    expect(
      objectPhotosIn([attach("object", "same"), attach("object", "same")]),
    ).toBe(1);
    // The same asset in both tiles is ONE photo, and the Object role it resolved to wins.
    expect(
      objectPhotosIn([attach("product", "same"), attach("object", "same")]),
    ).toBe(1);
    expect(
      objectPhotosIn([attach("object", "hoops"), attach("object", "ball")]),
    ).toBe(2);
    // NEVER SUMMED: an Object photo present means products do not count at all, so two tiles holding
    // one thing each is one thing.
    expect(
      objectPhotosIn([attach("object", "hoops"), attach("product", "boot")]),
    ).toBe(1);
    // Two products and no Object photo is two — the which-one ask, not a silent pick.
    expect(
      objectPhotosIn([attach("product", "boot"), attach("product", "cap")]),
    ).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// PR T — A HEADLINE WHOSE WORDS ARE OUT OF BOUNDS GETS ITS OWN LINE (N8)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("askCopyFor — a new image the interpreter answered (the new-image exit)", () => {
  it("is the server's new-image line, word for word — never the catch-all, and never the marked-photo question", () => {
    // server/studio/nativeIntent.ts, NEW_IMAGE_NOTE — pinned there too.
    const LINE =
      "That asks for a new picture of you, not a change to this photo — start a new image instead.";
    expect(askCopyFor("new_image")).toBe(LINE);
    for (const other of [
      "fast_path_declined",
      "some_future_reason",
      "generate_not_permitted",
      "frame_with_likeness",
    ]) {
      expect(askCopyFor("new_image")).not.toBe(askCopyFor(other));
    }
  });
});

describe("askCopyFor — an out-of-bounds headline (PR T, T.2)", () => {
  const LINE =
    "A headline can be up to four words and 24 characters, in plain letters and numbers, and can't use a brand's name or slogan. Try another line of your own.";
  const saved = process.env.STUDIO_DISPLAY_TEXT;
  afterEach(() => {
    if (saved === undefined) delete process.env.STUDIO_DISPLAY_TEXT;
    else process.env.STUDIO_DISPLAY_TEXT = saved;
  });

  it("says what was wrong with her words — never 'say where it goes', the catch-all, or the person line", () => {
    expect(askCopyFor("headline_bounds")).toBe(LINE);
    for (const other of [
      "add_unclear",
      "fast_path_declined",
      "person_target",
    ]) {
      expect(askCopyFor("headline_bounds")).not.toBe(askCopyFor(other));
    }
    expect(LINE).not.toContain("_");
    // Her sentence was the right shape, so the line teaches no phrasing: no quoted example to route.
    expect([...LINE.matchAll(/"([^"]+)"/g)]).toEqual([]);
  });

  it("is reached from her sentence with the switch on — and off, the same sentence gets main's code and copy", () => {
    const text = 'add the headline "WE RUN THIS CITY TONIGHT" across the top';
    process.env.STUDIO_DISPLAY_TEXT = "true";
    expect(askCopyFor(route(text, true).reason ?? "")).toBe(LINE);
    delete process.env.STUDIO_DISPLAY_TEXT;
    expect(route(text, true).reason).toBe("add_unclear");
    expect(askCopyFor(route(text, true).reason ?? "")).toBe(
      askCopyFor("add_unclear"),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// CATCH-ALL THROUGH THE INTERPRETER — ONE BUILDER FOR THE PREVIEW REQUEST (CA.1)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("previewRequestFor — the check's body, built in one place for the hook and the send", () => {
  const ask = (reason: string, interpretable: boolean): StudioClassification => ({
    op: null,
    targets: [],
    initialPath: "ASK",
    steps: [],
    reason,
    interpretable,
  });
  const edit: StudioClassification = {
    op: "RECOLOR",
    targets: ["socks"],
    initialPath: "FULL_IMAGE",
    steps: [{ op: "RECOLOR", targets: ["socks"], value: "blue", scope: "REGION" }],
  };
  const tray = [attach("source-frame", "me"), attach("product", "boot")];
  const job = (over: Partial<Parameters<typeof previewRequestFor>[0]>) =>
    previewRequestFor({
      format: "photo",
      classification: undefined,
      direction: "make the socks blue",
      attachments: tray,
      frameAssetId: null,
      interpreter: false,
      ...over,
    });

  it("with no mark: a new image from the whole tray, her photo a likeness, no base — keys in the hook's order", () => {
    const { routed, request } = job({ classification: edit });
    expect(routed.editBase).toBeNull();
    expect(JSON.stringify(request)).toBe(
      JSON.stringify({
        intent: "image.generate",
        deliverable: "post",
        objective: "grow-following",
        direction: "make the socks blue",
        brandId: null,
        references: [
          { assetId: "me", role: "person" },
          { assetId: "boot", role: "product" },
        ],
      }),
    );
  });

  it("with her mark and an edit: the base travels as sourceAssetId and never also as a reference", () => {
    const { routed, refs, request } = job({ classification: edit, frameAssetId: "me" });
    expect(routed.editBase?.assetId).toBe("me");
    expect(refs.references).toEqual([{ assetId: "boot", role: "product" }]);
    expect(JSON.stringify(request)).toBe(
      JSON.stringify({
        intent: "image.edit",
        deliverable: "post",
        objective: "grow-following",
        direction: "make the socks blue",
        brandId: null,
        references: [{ assetId: "boot", role: "product" }],
        sourceAssetId: "me",
      }),
    );
  });

  it("an interpretable ask over her mark is an interpreted edit only with the interpreter on — off, it is today's ask", () => {
    const on = job({
      classification: ask("fast_path_declined", true),
      direction: "take the logo off my sleeve",
      frameAssetId: "me",
      interpreter: true,
    });
    expect(on.routed.interpreting).toBe(true);
    expect(on.routed.askReason).toBeNull();
    expect(on.request.intent).toBe("image.edit");
    expect(on.request.sourceAssetId).toBe("me");

    const off = job({
      classification: ask("fast_path_declined", true),
      direction: "take the logo off my sleeve",
      frameAssetId: "me",
      interpreter: false,
    });
    expect(off.routed.interpreting).toBeUndefined();
    expect(off.routed.askReason).toBe("fast_path_declined");
  });

  it("trims her words and leaves out what is empty; a brand sets the objective; regions only once she drew some", () => {
    const blank = job({ direction: "   ", attachments: [] });
    expect(blank.request).toEqual({
      intent: "image.generate",
      deliverable: "post",
      objective: "grow-following",
      brandId: null,
    });
    const branded = job({ direction: "  make the socks blue ", brandId: 7, regions: [] });
    expect(branded.request.direction).toBe("make the socks blue");
    expect(branded.request.objective).toBe("showcase-product");
    expect(branded.request.brandId).toBe(7);
    expect("regions" in branded.request).toBe(false);
    const region = { label: "socks", left: 0.1, top: 0.2, width: 0.3, height: 0.4 };
    const drawn = job({ classification: edit, frameAssetId: "me", regions: [region] });
    expect(drawn.request.regions).toEqual([region]);
  });
});

describe("seededPreview — the sheet shows what the send checked only for exactly that request (C2)", () => {
  const tray = [attach("source-frame", "me")];
  const ask: StudioClassification = {
    op: null, targets: [], initialPath: "ASK", steps: [],
    reason: "fast_path_declined", interpretable: true,
  };
  const built = (over: Partial<Parameters<typeof previewRequestFor>[0]> = {}) =>
    previewRequestFor({
      format: "photo", classification: ask, direction: "take the logo off my sleeve",
      attachments: tray, frameAssetId: "me", interpreter: true, ...over,
    }).request;
  const preview: GenerationPreview = {
    previewId: "pv-seed", status: "ready", plan: null, references: [], cost: null, unpriced: false,
    blockers: [], warnings: [], verdict: { canGenerate: true, headline: "Ready", reason: null }, unavailable: null,
    interpretation: { lines: [{ kind: "change", text: "remove the logo on the sleeve", source: "yours" }] },
  };

  it("the request the send built, rebuilt by the sheet from what the send carried, is the seed's — so it is shown", () => {
    const seed = { request: built(), preview };
    expect(seededPreview(seed, built())).toBe(preview);
    // A copy through the wire shape (a navigation param) is still the same request.
    expect(seededPreview(JSON.parse(JSON.stringify(seed)), built())).toEqual(preview);
  });

  it("any other request asks as it always did — no seed, her mask correction, another frame, other words, another tray", () => {
    const seed = { request: built(), preview };
    expect(seededPreview(null, built())).toBeNull();
    expect(seededPreview(undefined, built())).toBeNull();
    const region = { label: "sleeve", left: 0.1, top: 0.1, width: 0.2, height: 0.2 };
    expect(seededPreview(seed, built({ regions: [region] }))).toBeNull();
    expect(seededPreview(seed, built({ frameAssetId: null }))).toBeNull();
    expect(seededPreview(seed, built({ direction: "make the sky moodier" }))).toBeNull();
    expect(seededPreview(seed, built({ attachments: [...tray, attach("object", "o1")] }))).toBeNull();
  });

  it("the interpreter OFF can build the same body — so the hook reads a seed only once the check may run, which an ask never may", () => {
    // The verb list reads "take … off" as an edit of her marked photo, so the body is byte-identical…
    const off = previewRequestFor({
      format: "photo", classification: ask, direction: "take the logo off my sleeve",
      attachments: tray, frameAssetId: "me", interpreter: false,
    });
    expect(off.request).toEqual(built());
    // …but it is an ASK there, and `useGenerationPlan` computes the seed only when `ready` — which needs no askReason.
    expect(off.routed.askReason).toBe("fast_path_declined");
    expect(off.routed.interpreting).toBeUndefined();
  });
});

describe("numberRepeatedNames — the BUILT FROM strip's plural-You row (wave C card 2)", () => {
  const b = (name: string) => ({ assetId: name.toLowerCase(), name });

  it("leaves a name that appears once completely alone", () => {
    // The common case by far: one photo of her, one product. A lone tile must never grow a "1".
    expect(numberRepeatedNames([b("You"), b("Product")]).map((x) => x.name)).toEqual([
      "You",
      "Product",
    ]);
  });

  it("numbers a pack of three photos of her — the defect this exists for", () => {
    // Three tiles all captioned YOU, and a screen reader saying "You. Open it." three times over three
    // different thumbnails. MAX_PERSON is 3, so this is the ordinary shape of a reference pack.
    expect(
      numberRepeatedNames([b("You"), b("You"), b("You")]).map((x) => x.name),
    ).toEqual(["You 1", "You 2", "You 3"]);
  });

  it("numbers per name, so a repeat does not drag an unrelated single into being numbered", () => {
    expect(
      numberRepeatedNames([b("You"), b("Object"), b("Object")]).map((x) => x.name),
    ).toEqual(["You", "Object 1", "Object 2"]);
  });

  it("keeps the caller's order, because it is the engine's reference order", () => {
    // The strip is fed in slot order (studio/refOrder.ts), which is the order the prompt's manifest
    // numbers the images in. "You 2" and "Image 2" have to be the same photograph, so this must never
    // sort, group or otherwise reorder its input.
    const out = numberRepeatedNames([
      { assetId: "a", name: "You" },
      { assetId: "b", name: "Product" },
      { assetId: "c", name: "You" },
    ]);
    expect(out.map((x) => x.assetId)).toEqual(["a", "b", "c"]);
    expect(out.map((x) => x.name)).toEqual(["You 1", "Product", "You 2"]);
  });

  it("does not mutate its input", () => {
    // The strip's source array is read again by the hook that built it.
    const input = [b("You"), b("You")];
    numberRepeatedNames(input);
    expect(input.map((x) => x.name)).toEqual(["You", "You"]);
  });

  it("carries every other field through untouched", () => {
    const out = numberRepeatedNames([
      { assetId: "x", name: "You", uri: "file://1", role: "person" },
      { assetId: "y", name: "You", uri: "file://2", role: "person" },
    ]);
    expect(out[1]).toEqual({
      assetId: "y",
      name: "You 2",
      uri: "file://2",
      role: "person",
    });
  });
});

describe("isMotion — the attachment first, the map second (F-AM7, video V4)", () => {
  const a = (assetId: string | null, mediaType?: string | null) => ({ assetId, mediaType });

  it("reads the attachment, with no map at all — the sheet path has none", () => {
    expect(isMotion(a("v1", "VIDEO"))).toBe(true);
    expect(isMotion(a("v1", "REELS"))).toBe(true);
    expect(isMotion(a("p1", "IMAGE"))).toBe(false);
  });

  it("falls back to the map for an attachment that predates the field", () => {
    // A tray rehydrated from stored material carries no mediaType; CreateAnythingScreen's map
    // still knows. Without this the fix would re-open the hole for exactly those trays.
    expect(isMotion(a("v1"), { v1: "VIDEO" })).toBe(true);
    expect(isMotion(a("p1"), { p1: "IMAGE" })).toBe(false);
  });

  it("knows nothing ⇒ not motion, which is the safe reading for every caller here", () => {
    // `canvasesIn` excludes an unidentified attachment from being a canvas; dropping a photograph
    // of hers from an edit's references because we could not identify it is the worse mistake.
    expect(isMotion(a("unknown"))).toBe(false);
    expect(isMotion(a(null))).toBe(false);
    expect(isMotion(a(null, "VIDEO"))).toBe(true);
  });
});
