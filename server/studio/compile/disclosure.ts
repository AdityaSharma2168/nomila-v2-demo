/**
 * studio/compile/disclosure — what she is told, before she pays, when the compiled instruction is less
 * than what she asked for: a thing the model will invent, or words a brand change left out — or rests on
 * an assumption made for her: her product photo as the thing an add places (C3).
 *
 * All are read off the FROZEN intent, so the preview and the generate leg say the same thing, and
 * all go on the preview as `degraded` warnings (studio/preview.ts, previewGeneration). Information,
 * not a refusal.
 */
import type { CreativeBrief } from "../brief";
import type { FrozenEditIntent } from "../nativeEdit";
import { placedPhoto } from "./manifest";
import { listOf } from "./text";

/**
 * What she is told when an add has NO object photo attached — or null when it has one.
 *
 * It still routes: q1-d measured that the model invents a plausible object with no reference. But
 * it is a DIFFERENT object — Q1's reference reproduced BOLYN on the ball and the Gatorade G on the
 * bottle, and the no-reference cell did not — so the preview says so before she pays, as a
 * `degraded` warning beside the resolution note. Information, not a refusal.
 *
 * ⚠️ EVERY THING IT WILL INVENT, since composition can add two (decision 4a). Naming only the first
 * would leave the second invented without a word — and "attach it with the Object tile" would be the
 * wrong advice for two, because one photo beside two adds refuses (`ambiguous_object`).
 */
export function inventedObjectNote(intent: FrozenEditIntent): string | null {
  const things = intent.changes.flatMap((c) =>
    c.add && !c.add.objectAssetId ? [`the ${c.add.thing}`] : [],
  );
  if (!things.length) return null;
  if (things.length === 1) {
    return (
      `No photo of ${things[0]} is attached, so the edit will invent one. ` +
      "To add yours, attach it with the Object tile."
    );
  }
  return (
    `No photos of ${listOf(things)} are attached, so the edit will invent them. ` +
    "To use your own, add them one at a time with the Object tile."
  );
}

/**
 * What she is told when an add places her PRODUCT photo as its thing (C3) — or null when it does not.
 *
 * ─── THE CARD NOTE, ADI'S (c) (2026-09-17) ──────────────────────────────────────────────────────────
 *
 * With no Object photo attached, the freeze binds her one Product photo as the thing she is adding
 * (studio/nativeIntent.ts). That is right when the product IS the thing — "add a water bottle" with the bottle
 * in the Product tile — and wrong when it is something else: a brand's sneakers beside "add a water bottle"
 * would be pasted in as the bottle. Nothing on our side can tell those apart (the client sends no label, and
 * the photo is never read), so the assumption is disclosed BEFORE she pays, and the render is never the first
 * place she finds out. The product's standing rule: a thing we decided for her is said, not hidden.
 *
 * Read off the frozen intent and the brief's own references, like the others, so the preview says exactly what
 * will run. An add that places an Object photo, invents its thing, or a replacement, says nothing here.
 *
 * Copy reviewed and approved by Adi, wave C card 2. "We'll use" rather than "will be used" — the assumption is
 * ours and is owned in the first person; "Product" is capitalised because it is the name of the tile she has to
 * find to correct it.
 */
export function placedProductNote(
  brief: CreativeBrief,
  intent: FrozenEditIntent,
): string | null {
  if (placedPhoto(brief, intent)?.role !== "product") return null;
  // An add names its thing on `add`; a pointed replacement names it as the change's `change` — what the
  // target BECOMES, "gold hoops" from "these gold hoops" (classify.ts rule 3½). Both are the thing her product photo will be used
  // as, so both get the same sentence (card 4 promotes the replacement; C3 shipped the add).
  const placed = intent.changes.find(
    (c) => c.add?.objectAssetId || c.object?.objectAssetId,
  );
  const thing = placed?.add?.thing ?? placed?.change;
  if (!thing) return null;
  // Worded around her noun's number: "the gold hoops" and "the water bottle" read the same sentence.
  return (
    `We'll use your Product photo as the ${thing}. ` +
    "If it shows something else, put the right photo in the Object tile and check again."
  );
}

/**
 * What she is told when a MOVE's thing was found by elimination — or null when it was named (F-WB5 (d)).
 *
 * ─── THE ASSUMPTION IS SAID, NOT HIDDEN — THE SAME RULE `placedProductNote` FOLLOWS ─────────────────
 *
 * Detection returned exactly one region and proposed no noun to confirm it with, so the freeze took that
 * region as her thing rather than refusing the move (studio/nativeIntent.ts, `moveRegion`). That is right
 * when the box IS her thing — which is what detection was asked for — and wrong when it found something
 * else. Nothing on the frozen record separates those two: `samNoun` is `undefined` both when detection
 * proposed no noun and when the noun it proposed was rejected, which that field's own doc says out loud.
 *
 * So she is told BEFORE she pays, and the render is never the first place she finds out. The preview also
 * DRAWS the region, so this sentence names in words what she can already see marked.
 *
 * Placeholder copy, for the review pile — the shape is what matters: it names her thing, says what we
 * assumed, and gives her the one action that changes it.
 */
export function assumedMoveNote(intent: FrozenEditIntent): string | null {
  const moved = intent.changes.find(
    (c) => c.op === "MOVE_OBJECT" && c.assumedTarget,
  );
  if (!moved?.target) return null;
  return (
    `We couldn't confirm which thing in your photo is the ${moved.target}, so the edit will move the ` +
    "one thing we found. If that's not it, mark it yourself and check the cost again."
  );
}

/**
 * What she is told when a brand change DROPPED words she typed — or null when it dropped none.
 *
 * B.1c (2026-09-10): "swap the cleats for Nike Mercurials" routes as nike cleats, the model name left
 * out of the value (studio/classify.ts, rule 4c). Leaving it out is only honest if she knows before she
 * pays, so this goes on the preview as a `degraded` warning beside the resolution note — the same
 * mechanism, no new UI. Read off the FROZEN steps, so the preview and the generate leg say the same.
 *
 * The steps of one brand change share their dropped words (the value tail is one phrase), so they are
 * listed once, after every item's result: "this will be nike socks and nike shoes, not elite
 * specifically".
 */
export function droppedWordsNote(intent: FrozenEditIntent): string | null {
  const degraded = intent.steps.filter((s) => s.dropped?.length && s.value);
  if (!degraded.length) return null;
  const results = listOf(degraded.map((s) => s.value as string));
  const words = [...new Set(degraded.flatMap((s) => s.dropped ?? []))];
  return (
    "Specific models and details can't be matched — " +
    `this will be ${results}, not ${words.join(" ")} specifically.`
  );
}

/**
 * What she is told when a look of HERS rides beside "keep me as I am" — or null otherwise (the
 * interpreter, I.1; Mia's M6, plan v2 §7).
 *
 * She asked for the grade and she asked to be kept, and both hold: the grade applies, because she asked
 * for it (a look is only ever from her words, never our suggestion), and it covers the whole photograph —
 * her included. `preserve_person` keeps her face, hair, body and pose; it cannot keep the light on them
 * out of a whole-frame grade. So the preview says so before she pays, as a `degraded` warning beside the
 * others. Read off the frozen intent, so a version 1 intent — which carries no constraint — never says it.
 */
export function lookCoversHerNote(intent: FrozenEditIntent): string | null {
  const keepsHer = (intent.constraints ?? []).some(
    (c) => c.kind === "preserve_person",
  );
  const looks = intent.changes.some((c) => c.op === "GLOBAL_STYLE");
  return keepsHer && looks
    ? "This look covers the whole photo, you included."
    : null;
}
