/**
 * studio/compile/manifest — which image is which: the reference manifest, and the number her object
 * photograph (an add's, or a replacement's) is addressed by.
 *
 * The planner decides WHAT is sent and in what order (studio/preview.ts, `referencesFor`: the slots,
 * the caps, the refusals). This file only says, in the prompt, what each of those images is for —
 * numbered against that same array, so "Image 3" is the third image the adapter sends.
 */
import type { CreativeBrief, JobReference } from "../brief";
import type { FrozenEditIntent } from "../nativeEdit";
import type { PlannedReference } from "../preview";

/**
 * The frame's manifest line on a native edit.
 *
 * The masked path's line promises that every pixel outside the marked regions survives, which is
 * true of a composite and false here — there are no marked regions, and the whole frame is the
 * model's output. This one claims only what the instruction below it asks for.
 */
export const NATIVE_FRAME_LINE =
  "THE FRAME being edited — the photograph to change. Anything the instruction does not name stays as it is.";

/**
 * HER LIKENESS — one block for every photograph of her in the request, however many there are.
 *
 * ─── WHY THIS IS ONE BLOCK AND NOT N LINES ──────────────────────────────────────────────────────
 *
 * It used to be one line per image, and three photographs of one athlete therefore produced three
 * consecutive sentences each reading "This is the person to render; her face, hair and build come
 * from this image." Nothing anywhere said they were the same woman. The model's own documented
 * multi-image example ("these people") means DIFFERENT people, so the most natural reading of what
 * we were sending was three people, and the renderer had to guess which one to draw.
 *
 * Measured, 2026-09-15, two poses through the real router (docs/plans/studio-generation-identity-plan.md):
 * three bound photographs beat one photograph in Adi's blind pick in both poses, twice, across a
 * reshuffle. The held-out embedding distances agreed (portrait 0.3681 → 0.3254, action 0.4561 →
 * 0.3764) but they are NOT the evidence — that instrument failed its own control in the same run, a
 * stranger scoring 0.3584 inside the same-person band. The eye is the acceptance bar here, and the
 * numbers are context.
 *
 * ⚠️ THE WORDING IS THE WORDING THAT WAS MEASURED. This is the probe's `bound3` arm verbatim, down
 * to "They show ONE person, not three." Changing a clause makes the measurement above a statement
 * about a prompt we no longer send — recapture the goldens and re-run the probe, or leave it alone.
 *
 * ─── WHAT WENT, AND WHAT ARRIVED ────────────────────────────────────────────────────────────────
 *
 * GONE: "Match the angle of the output to the angle of this reference." Three references have three
 * angles, so with a pack the instruction is not merely unhelpful but incoherent — and on a single
 * reference it CONTRADICTS her direction outright whenever she asks for a pose the photograph is not
 * in ("put me mid-air"). The model then has to disobey one of the two. It was measured alone
 * (`noangle1`: action distance 0.4561 → 0.4177, portrait marginally worse) and it never won a blind
 * pick in either pose, so it is not a substitute for the pack — it is a sentence that was costing us
 * on action and buying nothing on portrait.
 *
 * ARRIVED: the scene release — "Take nothing else from these photographs: not their backgrounds,
 * their clothing, their lighting or their framing." A reference is a face, not a mood board, and this
 * is the same scoping the object line has carried all along, word for word. It rode INSIDE the
 * measured `bound3` wording; it has not been measured on its own, and on the single-photograph line
 * it is an extrapolation from that arm rather than a result.
 *
 * ─── AND "clothing" IS AN ADDITION TO THE MEASURED WORDING, ON ITS OWN EVIDENCE (wave B, (b)) ────
 *
 * `bound3`'s release shipped without the word and `struct1`'s had it ("not its background, clothing,
 * lighting or framing"). Probe 2's renders say which was right: the action direction named no
 * wardrobe at all, and **4 of 4 action cells put her in the pack's maroon kit — with its adidas
 * trefoil** (docs/probes/framing-identity-stranger.md, "the wardrobe leaks from the references").
 * An unrequested competitor mark riding in on a person reference is the same NIL class as the
 * mixed-marks findings, reached by a route that has nothing to do with a brand job.
 *
 * ⚠️ SO THE WARNING ABOVE NOW HAS AN EXCEPTION, AND THIS IS IT. The identity measurement (three
 * bound photographs beating one, twice, across a reshuffle) was made on the wording WITHOUT
 * "clothing". This commit adds one word to the release clause and recaptures the goldens; it does not
 * re-run that probe, and it does not claim the blind pick still holds. The re-measure is probe 2's
 * own harness (/Users/adi/pfi/probe2.ts) and it is Adi's to run. What a garment reference is FOR is
 * unaffected: an object or product line names the thing to take, out loud, and this clause scopes
 * only the photographs of HER.
 */
export function likenessBlock(numbers: number[]): string {
  const which = imagesLabel(numbers);
  if (numbers.length < 2) {
    // NO NAME. The photograph is the identity — saying whose it is adds nothing the model can use
    // and everything it can print. See buildPrompt's note (studio/preview.ts); this line was the
    // second half of the same leak, and the closer half, because it sits beside "the person to
    // render".
    //
    // "come from this image" is soft on its own — it describes where features originate without
    // asking for them back unchanged, and a re-render drifts — which is what the sentence after it
    // is for.
    return `${which} — HER LIKENESS. This is the person to render; her face, hair and build come from this image. Preserve her exact face and features — the output must be recognisably the same person. Take nothing else from this photograph: not its background, its clothing, its lighting or its framing.`;
  }
  const count = COUNT_WORD[numbers.length] ?? String(numbers.length);
  return (
    `${which} — HER LIKENESS: ${count} photographs of the SAME person — her — taken on different days, in ` +
    `different light and from different angles. They show ONE person, not ${count}. Build her identity from ` +
    "all of them together: her face, hair and build come from these images. Preserve her exact face and " +
    "features — the output must be recognisably the same person. Take nothing else from these photographs: " +
    "not their backgrounds, their clothing, their lighting or their framing."
  );
}

const COUNT_WORD: Record<number, string> = {
  1: "one",
  2: "two",
  3: "three",
  4: "four",
  5: "five",
};

/**
 * "Image 2", "Images 1 and 2", "Images 1–3", "Images 1, 3 and 4".
 *
 * ⚠️ IT NEVER CLAIMS A RANGE IT DOES NOT HAVE. `referencesFor` sorts by slot, so character
 * references are contiguous today and the range form is what renders — but this file's whole
 * contract is that a number in the prompt is the number of an image in the request, and "Images
 * 1–3" over a set that skips 2 would break exactly that. The gap form is not decoration; it is what
 * keeps the block honest if the planner's ordering ever changes.
 */
function imagesLabel(numbers: number[]): string {
  if (numbers.length === 1) return `Image ${numbers[0]}`;
  const contiguous = numbers.every(
    (n, i) => i === 0 || n === numbers[i - 1] + 1,
  );
  if (contiguous && numbers.length > 2)
    return `Images ${numbers[0]}–${numbers[numbers.length - 1]}`;
  const head = numbers.slice(0, -1).join(", ");
  return `Images ${head} and ${numbers[numbers.length - 1]}`;
}

/**
 * The reference manifest — what each attached image is FOR.
 *
 * Everything else about role handling is enforced in our own code: the role survives to the
 * adapter, slotFor is a total switch, the caps refuse, and the parts leave in slot order. None of
 * that reaches inside the model. This block is what tells it what it is looking at, and it is
 * prose, so it can be disobeyed.
 *
 * ─── IT USED TO CARRY A GUARANTEE IT COULD NOT KEEP ─────────────────────────────────────────────
 *
 * A style line here used to read "Do NOT copy any person, face, body, hair or clothing from it",
 * with a standing rule underneath saying no person may be taken from a style image. That was the
 * enforcement half of the look-reference feature, and gemini-3-pro-image ignored it — faces leaked,
 * observed live. The feature is gone (see ReferenceRole in studio/brief.ts) and so is the sentence:
 * continuing to write an instruction we have watched fail, in a file that reads as the contract,
 * is how a best-effort mitigation gets mistaken later for a control.
 *
 * The style line that remains is about ART DIRECTION and claims nothing it cannot deliver. It still
 * discourages literal reproduction, which is the part with real steering value, and it makes no
 * statement about people.
 *
 * THE NUMBERING MUST STAY TRUE. "Image 3" is only meaningful if it names the third image in the
 * request. It does, by construction: this enumerates the same array, in the same order, that
 * plannedInputs (studio/preview.ts) hands to the adapter, and both adapters place references in slot
 * order before the prompt part. Never reorder one without the other.
 *
 * It is no longer one LINE per image, though: the character references collapse into a single block
 * addressing all of them at once ("Images 1–3 — HER LIKENESS: …"), because that is the one case
 * where several images are one thing. The numbers inside that block are still their real positions —
 * `imagesLabel` renders exactly the set it is given and will not invent a range across a gap.
 */
export function referenceManifest(
  brief: CreativeBrief,
  references: PlannedReference[],
  /**
   * What the frame line claims. The default is the masked path's, and it is TRUE there — a composite
   * keeps every pixel outside the marked regions. A native edit has no marked regions and passes
   * NATIVE_FRAME_LINE instead, which claims only what its instruction asks for.
   */
  frameLine = "THE FRAME being edited. Every pixel outside the marked regions stays exactly as it is.",
  /**
   * The stored path of the Product photo an add PLACES (C3; `placedPhoto`), or nothing. Only a native edit
   * passes it, and it is the one product that reads the OBJECT line — see the object arm below.
   */
  placedProduct?: string,
): string | null {
  if (!references.length) return null;

  // The character references travel as ONE block (likenessBlock). These are their image numbers, in
  // request order, and the block is emitted in the place the first of them would have taken — so the
  // numbering below and around it stays the numbering the adapter sends.
  const characterNumbers = references
    .map((r, i) => (r.slot === "character" ? i + 1 : 0))
    .filter((n) => n > 0);
  const firstCharacter = references.findIndex((r) => r.slot === "character");

  const lines = references.map((r, i): string | null => {
    const n = `Image ${i + 1}`;
    switch (r.slot) {
      case "frame":
        return `${n} — ${frameLine}`;
      case "character":
        // ONE BLOCK FOR ALL OF THEM, emitted at the first character reference and skipped at the
        // rest — see `likenessBlock`. Every other case is one line per image; this is the one place
        // where several images describe a single thing, and saying so is the whole point.
        return i === firstCharacter ? likenessBlock(characterNumbers) : null;
      case "object":
        // ⚠️ THE ONE ARM THAT READS THE ROLE RATHER THAN THE SLOT, and it has to. `product` and
        // `object` both land here, and the sentence is the only thing distinguishing them — a
        // product is the piece the job is ABOUT, an object is a thing to PUT IN the frame. Keying
        // this on the slot alone would tell the model a ball she wants placed between her cleats
        // is the subject of the photograph.
        //
        // A replacement's photo (replace with reference) reads this same line, word for word, on
        // purpose: its thing is put in the frame where the one it replaces was, and that is "the
        // position the instruction names" — "replace the earrings with the gold hoops from Image 2".
        //
        // AND SO DOES THE ONE PRODUCT AN ADD PLACES (C3; Adi's decision 3, 2026-09-17). With no Object photo
        // attached, her Product photo is the thing she is adding, so in this request it IS a thing to put in
        // the frame — the line that says so, Q1's measured shape, word for word. Every other product, and
        // every brand piece, keeps the PRODUCT line: nothing in the instruction places it.
        return r.role === "object" ||
          (r.role === "product" && !!placedProduct && r.ref === placedProduct)
          ? `${n} — THE OBJECT to place in the frame: "${r.label}". Take the object from this image and render it into the scene, in the position the instruction names. Render this exact object — do not substitute it, restyle it or redesign it. Nothing else about this image carries over: not its background, its lighting or its framing.`
          : `${n} — PRODUCT: "${r.label}". Render this exact object. Do not substitute it, restyle it or redesign it.`;
      case "style":
        return `${n} — ART DIRECTION ("${r.label}"). Reference for colour, light, styling and composition. Do not reproduce it.`;
    }
  });

  return `REFERENCES — the images attached to this request, in order. Each has exactly one job, and only that job:\n${lines.filter((l): l is string => l !== null).join("\n")}`;
}

/**
 * Her photograph the intent places, as the brief carries it — the Object photo an add or a replacement names,
 * or, for an add, the Product photo that stands in for one when none is attached (C3) — or undefined when no
 * change names one or the brief does not carry it.
 *
 * One photo for the whole intent: the freeze never lets two changes read one photo
 * (studio/nativeIntent.ts, `ambiguous_object`).
 */
export function placedPhoto(
  brief: CreativeBrief,
  intent: FrozenEditIntent,
): JobReference | undefined {
  const change = intent.changes.find(
    (c) => c.add?.objectAssetId || c.object?.objectAssetId,
  );
  const assetId = change?.add?.objectAssetId ?? change?.object?.objectAssetId;
  if (!change || !assetId) return undefined;
  // Either tile, for an add (C3) and now for a pointed replacement too (card 4): with no Object photo the
  // freeze binds her one Product photo as the incoming thing, so the role it resolves under is either.
  const roles = ["object", "product"];
  return (brief.job.references ?? []).find(
    (r) => roles.includes(r.role) && r.mediaAssetId === assetId,
  );
}

/**
 * Which "Image N" her object photograph is — the one an add places, or the one a replacement takes
 * its thing from (replace with reference) — as its position in the array the manifest numbers and the
 * adapter sends; or undefined when no change names one or it is not in the request.
 *
 * ⚠️ NEVER ASSUMED TO BE 2. Frame first, then her other object-slot material in the order `hers`
 * lists it — a PRODUCT she tagged sorts ahead of an object (referencesFor), so with a product on the
 * job the ball is Image 3, and an instruction still saying "Image 2" would tell the model to place
 * the product. The asset id is frozen; the number is derived here, from the same planned array.
 *
 * Since C3 the photo an add places may be her Product photo, found under its own role — so a brand piece,
 * planned as a product after hers, is never mistaken for it.
 */
export function objectImageNumber(
  brief: CreativeBrief,
  references: PlannedReference[],
  intent: FrozenEditIntent,
): number | undefined {
  const photo = placedPhoto(brief, intent);
  if (!photo) return undefined;
  const index = references.findIndex(
    (r) => r.role === photo.role && r.ref === photo.ref,
  );
  return index >= 0 ? index + 1 : undefined;
}
