/**
 * studio/nativeEdit — one full-frame Nano Pro call, compiled from a FROZEN intent.
 *
 * ─── WHAT A NATIVE EDIT IS ─────────────────────────────────────────────────────────────────────
 *
 * The full source frame in the frame slot, the references per the role contract (studio/refOrder.ts),
 * `aspectRatio` pinned from the source's own dimensions, and an instruction compiled from her
 * CLASSIFIED intent — one provider call, one complete regenerated image. No detection box reaches the
 * model, no SAM, no crop, no paste-back. The decision and the evidence behind it are in
 * docs/probes/2026-09-09-model-native-probe.md, "Q5L" and "Routing decision".
 *
 * This is the PURE half: the frozen shape, and the check that a brief's intent is one we can run. The
 * freeze — which has to read her sentence and the detection labels — is studio/nativeIntent.ts, so
 * the engine (studio/preview.ts) can import this without importing the detection client.
 *
 * ─── THE COMPILER IS studio/compile/ ────────────────────────────────────────────────────────────
 *
 * What a frozen intent compiles INTO — the instruction, the preservation clause, the manifest, the
 * canvas ratio, the disclosures — is the compile tier, and every output of it is pinned byte-for-byte
 * by studio/compile/golden.test.ts. The names it used to export from here still resolve from here
 * (the re-export below), so no importer changed when it moved.
 *
 * ─── THE RESOLUTION RULE: ACCEPT, RECORD, AND TELL HER BEFORE SHE PAYS (PR N, N.3) ───────────────
 *
 * A native edit is the model's own canvas, not the source's pixels. The size is requested by rule —
 * `smallestImageSizeFor(source pixels)`, which is 4K for anything over ~16.8 MP — and on a 4000x6000
 * frame 4K returns 3392x5056: 71% of the source's pixels, for $0.24 where 2K would have returned
 * ~1696x2528 (18%) for $0.1344. That loss is ACCEPTED, and it is never a surprise:
 *
 *   • she is told on the preview, as a `degraded` warning, whenever the tier returns fewer pixels
 *     than her photo has (`nativeResolutionNote`, below);
 *   • the record carries all three numbers — the source dimensions in `generation_jobs.brief.job
 *     .source`, the tier in `generation_jobs.brief.job.editIntent.imageSize`, and the output's
 *     MEASURED dimensions on its `media_assets` row (studio/generate.ts) — so the fidelity split is
 *     one join away for the pricing conversation, and never reconstructed from a cost column.
 *
 * The follow-up lever is output-side upscaling — the parked upscaling request, now with a reason. It
 * is named here, not built.
 */
import {
  isBrandName,
  ROUTE,
  type EditOperation,
  type EditPath,
  type EditStep,
  type Routed,
} from "./classify";
import { imageSizePixels, isImageSize, type ImageSizeName } from "./config";
import { CAMERA_ANGLES, CROP_VALUES, LIGHT_MEMBERS } from "./imageOps";
import type { CreativeBrief } from "./brief";

export {
  NATIVE_FRAME_LINE,
  NATIVE_PRESERVATION,
  compileNativeInstruction,
  droppedWordsNote,
  inventedObjectNote,
  preservationClause,
  spatialPlace,
  type NativeAddressing,
} from "./compile";

/** One clause of the compiled instruction — one thing changed. */
export interface NativeChange {
  op: EditOperation;
  /**
   * A target the CLASSIFIER extracted from her sentence — never free text. Null for the operations
   * that name no region: a background change (whose only target is the person it keeps), a
   * whole-frame look, an add (whose thing is not in the frame to be targeted), and a headline.
   */
  target: string | null;
  /**
   * What it becomes. Null for a removal and an add. On a headline (DISPLAY_TEXT), the words it reads, as
   * the classifier bounded and uppercased them. Where each operation's comes from: studio/nativeIntent.ts.
   */
  change: string | null;
  /** ADD_OBJECT only, and required there. Absent on every other operation. */
  add?: NativeAdd;
  /**
   * MOVE_OBJECT only, and required there: WHERE the thing goes, in her words, from its preposition on —
   * "closer to my feet", "on the ground". `target` is the thing, which is already in the frame; this is
   * the only operation with both a target and a destination.
   *
   * ⚠️ ITS OWN FIELD RATHER THAN `change`, because a move changes nothing ABOUT the thing — that is the
   * property that makes it a move and not a replacement, and it is the one the compiled clause has to say
   * out loud ("the same one, not a second"). Reusing `change` would make a move indistinguishable from a
   * replacement at every place that reads this object, which is how the two-balls incident happens twice.
   */
  to?: string;
  /**
   * MOVE_OBJECT only, and only when the thing was found BY ELIMINATION rather than by name — exactly
   * one region, carrying no noun to confirm it with (studio/nativeIntent.ts, `moveRegion`; ledger
   * F-WB5 (d), Adi 2026-09-17). Read by the disclosure so she is told the assumption BEFORE she pays.
   *
   * Absent on every move whose region named her thing, and on every brief frozen before this existed —
   * which is what `undefined` is for. Nothing in the compiled prompt reads it: the instruction is
   * byte-identical either way, because the model is not the one making the assumption.
   */
  assumedTarget?: boolean;
  /**
   * REPLACE_OBJECT only, and only when she pointed at a photo she attached: "change my earrings to
   * THESE gold hoops" (replace with reference). `change` is still the thing she named ("gold hoops");
   * this says it is the one in her photo. Absent on every other change, which is every brief stored
   * before this existed.
   */
  object?: NativeObject;
  /**
   * REPLACE_OBJECT only (PR 19, K33): the brand the rules do not list, in HER words, inside `change` — "lululemon" in
   * "lululemon jersey". The compile fences exactly this span as data, verbatim. Absent on every other change.
   */
  fenced?: string;
  /** DISPLAY_TEXT only (W-3): where the text goes; absent is rule ⅛'s top banner, byte-for-byte. */
  placement?: "top" | "bottom" | "middle";
}

/**
 * The photograph a replacement comes FROM: her Object photo (replace with reference).
 *
 * The add's `objectAssetId` can be null, and then the model invents the thing (probe q1-d). This one
 * cannot. A replacement she pointed at a photo for has no invented arm: with no photo attached the
 * sentence asks (studio/classify.ts, `object_photo_missing`) and never gets this far.
 */
export interface NativeObject {
  /** The media_assets id of the attached OBJECT photograph. */
  objectAssetId: string;
}

/**
 * What an add puts in the frame, where, and the photograph it comes from — PR C′.
 *
 * Its own shape rather than `target`/`change` stretched to fit, because neither word is true of an
 * add: nothing in the frame is the target, and nothing in it becomes anything.
 */
export interface NativeAdd {
  /** The thing, as the classifier parsed it, determiner stripped — "soccer ball". */
  thing: string;
  /** Where, from its preposition on, in her words — "on the grass". Compiled as spatial language. */
  place: string;
  /**
   * The media_assets id of the attached OBJECT photograph, or null when none is attached — the model
   * then invents the object (probe q1-d: a plausible ball, a DIFFERENT ball). The preview says so.
   */
  objectAssetId: string | null;
  /**
   * The brand she named on the thing (PR 19, R-22) — "nike" in "add a nike ball between my cleats" — in her words,
   * fenced as data by the compile, never read as a design. Absent on every add before it.
   */
  brand?: string;
}

/**
 * Operations with NO REGION, by definition rather than by omission. An add's thing is not in the
 * frame, so there is nothing for detection to find and nothing for a mask to bound. Nor is a headline
 * (PR T): its words are written across the top of the photo, and name nothing in it.
 */
export const REGION_FREE_OPS: ReadonlySet<EditOperation> = new Set([
  "ADD_OBJECT",
  "DISPLAY_TEXT",
  // PR 19: a relight and a camera angle name nothing in the frame, so detection has nothing to find ($0 beyond the
  // one edit). Only STUDIO_IMAGE_OPS's rules produce them, so with the flag off no brief carries one.
  "RELIGHT",
  "CAMERA",
  // A crop finds nothing in the frame: it cuts it (S-7).
  "CROP",
  // The ad's brand logo, like a watermark: nothing in the frame to find.
  "BRAND_MARK",
]);

/**
 * ⚠️ MOVE_OBJECT IS DELIBERATELY NOT REGION-FREE, AND THAT IS THE OPERATION'S WHOLE PREMISE. Its thing
 * is ALREADY in the frame — that is what separates it from the add it would otherwise be — so detection
 * has something to find, and a move that could not find it is not a move. Adding it here would let one
 * freeze with no region at all, which is the "put down a second ball" outcome the op exists to prevent.
 */

/**
 * Operations a native intent needs no region for: an add and a headline, and a background or a look —
 * both compiled from the classifier's value alone, never from a region label (studio/nativeIntent.ts).
 *
 * WIDER THAN `REGION_FREE_OPS`, and the difference is where detection is asked. The route sends a
 * LONE background or look to detection exactly as it did before composition, so its brief has
 * regions and never raises the gap this answers. Only a composed sentence none of whose clauses names
 * a thing in the frame — "add a soccer ball at her feet and change the background to a stadium" —
 * reaches the preview with no regions and a background in its intent (routes/studio.ts, decision 3).
 */
const NEEDS_NO_REGION: ReadonlySet<EditOperation> = new Set([
  ...REGION_FREE_OPS,
  "CHANGE_BACKGROUND",
  "GLOBAL_STYLE",
]);

/**
 * Does this intent need no region at all? True only when EVERY change needs none — one recolour
 * beside an add would still need its own region, and must not ride the add's exemption.
 */
export function isRegionFree(intent: FrozenEditIntent): boolean {
  return (
    intent.changes.length > 0 &&
    intent.changes.every((c) => NEEDS_NO_REGION.has(c.op))
  );
}

/**
 * A condition on the WHOLE edit, riding beside its changes — never a change itself (the interpreter,
 * I.1; plan v1 §9 C, A11).
 *
 *   preserve_person           "don't change anything about me" — her face, hair, body and pose, and
 *                             NOT her clothing (Mia's M2): a kit swap beside it is still a swap.
 *   exclude_marks { brand }   "i don't want any nike logos showing" — no mark of that brand anywhere in
 *                             the photograph. An exclusion, never a removal: F-R measured a tiny logo's
 *                             removal skipped silently in a compound and failing alone.
 *
 * ─── THE ONE INTERPRETER OUTPUT THAT DOES NOT PASS THROUGH THE RULES, SO IT IS CLOSED IN SHAPE ─────
 *
 * Every change in a frozen intent is what `route()` read from a sentence. These are not: the rules
 * have no words for "keep me" or "no nike anywhere", so the interpreter's reading of them is frozen as
 * data. What keeps that safe is the shape. Each kind is exactly its keys and nothing more — no op, no
 * target, no value, no step — and it can only ADD a sentence of restraint to the compiled prompt: a keep
 * sentence, or a DO NOT (studio/compile/constraints.ts). It can never make the model change something.
 * `readNativeIntent` refuses any constraint that is not exactly one of these.
 *
 * `brand` is a word on the classifier's BRANDS list, lowercased as the rules read it ("nike", "new
 * balance") — `isBrandName` — so it names a brand the way a brand change names one.
 */
export type EditConstraint =
  | { kind: "preserve_person" }
  | { kind: "exclude_marks"; brand: string };

/** A constraint is well-formed when it is exactly one closed shape — its keys, and nothing else. */
function constraintIsWellFormed(c: unknown): c is EditConstraint {
  if (!c || typeof c !== "object" || Array.isArray(c)) return false;
  const k = c as Record<string, unknown>;
  const keys = Object.keys(k).sort().join(",");
  switch (k.kind) {
    case "preserve_person":
      return keys === "kind";
    case "exclude_marks":
      return (
        keys === "brand,kind" &&
        typeof k.brand === "string" &&
        isBrandName(k.brand)
      );
    default:
      return false;
  }
}

/** The one order constraints are frozen in: keeping her first, then each brand's exclusion by name. */
function constraintKey(c: EditConstraint): string {
  return c.kind === "preserve_person" ? "0" : `1:${c.brand}`;
}

/**
 * Her constraints as a frozen intent stores them — or null when they cannot be: not a list, an entry
 * that is not exactly one closed shape, or the same constraint twice. An empty list is `[]`, and a
 * frozen intent carrying none stays version 1 (`freezeEditIntent`).
 */
export function canonicalConstraints(
  raw: readonly unknown[],
): EditConstraint[] | null {
  if (!raw.every(constraintIsWellFormed)) return null;
  const sorted = [...(raw as EditConstraint[])].sort((a, b) =>
    constraintKey(a).localeCompare(constraintKey(b)),
  );
  const keys = sorted.map(constraintKey);
  if (new Set(keys).size !== keys.length) return null;
  return sorted.map((c) =>
    c.kind === "preserve_person"
      ? { kind: "preserve_person" }
      : { kind: "exclude_marks", brand: c.brand },
  );
}

/**
 * The intent a native edit runs on, FROZEN when she was quoted and replayed at spend time.
 *
 * It rides on the brief (`BriefJob.editIntent`), so it lands in `studio_generation_previews.brief`
 * with the approval and in `generation_jobs.brief` with the job — the record of what was asked now
 * also says what was classified and at what size it was quoted.
 */
export interface FrozenEditIntent {
  /**
   * A brief frozen under a different shape does not run native — it refuses.
   *
   * ─── VERSION 2 IS AN INTENT THAT CARRIES CONSTRAINTS, AND NOTHING ELSE (the interpreter, I.1) ────
   *
   * Every intent with no constraints is version 1 and byte-identical to one frozen before they existed.
   * One that carries them is version 2, so an instance that predates them — mid-deploy, inside the
   * 30-minute approval window — reads "an edit intent of an unknown version" and refuses, rather than
   * running the changes and silently dropping the "keep me as I am" she was quoted with. Deploy skew
   * fails closed, the way PR T's headline does.
   */
  version: 1 | 2;
  /** The classifier's answer to HER sentence, verbatim — what the generate route's re-check must reproduce. */
  initialPath: EditPath;
  steps: EditStep[];
  /** One clause per classified target, compiled at freeze time. The instruction is built from these alone. */
  changes: NativeChange[];
  /**
   * The output tier she was QUOTED: `smallestImageSizeFor(source pixels)`, frozen so the size that
   * runs is the size she approved. 4K on a 24 MP frame returns 3392x5056 for $0.24; 2K would have
   * been ~1696x2528 for $0.1344. Kept on the job record beside the source dimensions so that split is
   * queryable data for the pricing conversation, not something reconstructed from a cost column.
   */
  imageSize: ImageSizeName;
  /**
   * Version 2 only, and required there: the closed conditions on the whole edit (`EditConstraint`), in
   * canonical order. Absent on every version 1 intent — which is every intent frozen without them.
   */
  constraints?: EditConstraint[];
}

/**
 * What she is told, before she pays, when a native edit will come back smaller than her photo — or
 * null when it will not. Megapixels, whole numbers: the figure is a floor (see `imageSizePixels`), and
 * a decimal would claim a precision the model's canvas does not have.
 *
 * Null when the tier covers the frame (every source up to ~16.8 MP) and when the frame was never
 * measured — a warning built on a guessed size would be the surprise it exists to prevent.
 */
export function nativeResolutionNote(
  intent: FrozenEditIntent,
  source: { width: number | null; height: number | null },
): string | null {
  if (!source.width || !source.height) return null;
  const sourcePx = source.width * source.height;
  const outPx = imageSizePixels(intent.imageSize);
  if (outPx >= sourcePx) return null;
  const mp = (px: number) => Math.round(px / 1e6);
  return (
    `An edit comes back at about ${mp(outPx)} megapixels, and your photo is ${mp(sourcePx)} — ` +
    "so the edited version will be smaller than the original."
  );
}

// ─── Reading an intent back off a brief ─────────────────────────────────────────────────────────

export type NativeIntentRead =
  | { kind: "none" }
  | { kind: "native"; intent: FrozenEditIntent }
  /**
   * A brief carries SOMETHING under `editIntent` that cannot be run. Refused, never ignored:
   * ignoring it would run the masked path on a brief that was quoted as a native edit.
   */
  | { kind: "invalid"; reason: string };

const isEditOp = (op: unknown): op is EditOperation =>
  typeof op === "string" && op in ROUTE && op !== "GENERATE";

const text = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

/** A change is well-formed when it has exactly the fields its operation compiles from. */
function changeIsWellFormed(c: Partial<NativeChange> | null): boolean {
  if (!c || !isEditOp(c.op)) return false;
  // A replacement's photo is the replacement's alone. On anything else it is a field no template
  // reads, pointing at an image the instruction never names.
  if (c.object !== undefined && c.op !== "REPLACE_OBJECT") return false;
  // A destination is the move's alone, on the same argument: elsewhere it is a field no template reads,
  // naming a place the instruction never mentions.
  if (c.to !== undefined && c.op !== "MOVE_OBJECT") return false;
  if (
    c.placement !== undefined &&
    (c.op !== "DISPLAY_TEXT" ||
      !["top", "bottom", "middle"].includes(c.placement))
  )
    return false;
  // A fenced span is a replacement's brand (K33) or a headline's words (W-3), and it must be a span of its change.
  if (c.fenced !== undefined) {
    if (
      (c.op !== "REPLACE_OBJECT" && c.op !== "DISPLAY_TEXT") ||
      !text(c.fenced)
    )
      return false;
    if (!(c.change ?? "").toLowerCase().includes(c.fenced.toLowerCase()))
      return false;
  }
  switch (c.op) {
    case "RECOLOR":
    case "APPLY_DESIGN":
      return text(c.target) && text(c.change);
    case "REPLACE_OBJECT":
      return (
        text(c.target) &&
        text(c.change) &&
        (c.object === undefined || text(c.object?.objectAssetId))
      );
    case "REMOVE_OBJECT":
      return text(c.target) && c.change === null;
    // ⚠️ THE ONLY OPERATION WITH BOTH A TARGET AND A DESTINATION, and it needs both: the thing it moves
    // and where it goes. Its `change` is null because a move changes nothing ABOUT the thing — that is
    // the property separating it from a replacement. Without this case the switch's `default` read every
    // frozen move as invalid, and the preview refused it with "saved in a form we can't run any more";
    // golden.test.ts's operation-coverage pin is what caught it.
    case "MOVE_OBJECT":
      return text(c.target) && c.change === null && text(c.to);
    case "CHANGE_BACKGROUND":
    case "GLOBAL_STYLE":
    case "DISPLAY_TEXT":
      return c.target === null && text(c.change);
    // PR 19: a member of a closed vocabulary, never free text — the template looks its phrase up.
    case "RELIGHT":
      return (
        c.target === null &&
        (LIGHT_MEMBERS as readonly string[]).includes(c.change ?? "")
      );
    case "CAMERA":
      return (
        c.target === null &&
        (CAMERA_ANGLES as readonly string[]).includes(c.change ?? "")
      );
    case "CROP":
      return (
        c.target === null &&
        (CROP_VALUES as readonly string[]).includes(c.change ?? "")
      );
    // PR 19: the ad's brand logo — a brand the rules list, never free text (the template writes it unfenced).
    case "BRAND_MARK":
      return c.target === null && isBrandName(c.change ?? "");
    case "ADD_OBJECT":
      return (
        c.target === null &&
        c.change === null &&
        !!c.add &&
        text(c.add.thing) &&
        text(c.add.place) &&
        (c.add.objectAssetId === null || text(c.add.objectAssetId)) &&
        (c.add.brand === undefined || text(c.add.brand))
      );
    default:
      return false;
  }
}

/**
 * The frozen intent on this brief, if it has one — and whether it can run.
 *
 * Reads the BRIEF alone, the same property `editCropsFor` relies on: the preview and the generate
 * leg plan from one frozen object, so they cannot disagree about whether a job is native.
 */
export function readNativeIntent(brief: CreativeBrief): NativeIntentRead {
  const raw = (brief.job as { editIntent?: unknown }).editIntent;
  if (raw === undefined || raw === null) return { kind: "none" };

  const invalid = (reason: string): NativeIntentRead => ({
    kind: "invalid",
    reason,
  });
  const i = raw as Partial<FrozenEditIntent>;
  if (brief.job.mode !== "edit" || !brief.job.source) {
    return invalid("an edit intent on a brief with no frame to edit");
  }
  if (i.version !== 1 && i.version !== 2) {
    return invalid("an edit intent of an unknown version");
  }
  // Version 1 is an intent with no constraints — a constraint on one would be read by this instance and
  // IGNORED by an older one, which is the silent drop version 2 exists to prevent. Version 2 is an intent
  // WITH them: at least one, each exactly a closed shape, in canonical order, none twice.
  if (i.version === 1 && i.constraints !== undefined) {
    return invalid("constraints on a version 1 intent");
  }
  if (i.version === 2) {
    const canonical = Array.isArray(i.constraints)
      ? canonicalConstraints(i.constraints)
      : null;
    if (
      !canonical?.length ||
      JSON.stringify(canonical) !== JSON.stringify(i.constraints)
    ) {
      return invalid("a version 2 intent without well-formed constraints");
    }
  }
  if (!isImageSize(i.imageSize)) return invalid("no quoted output size");
  if (
    !Array.isArray(i.steps) ||
    !i.steps.length ||
    !i.steps.every((s) => isEditOp(s?.op))
  ) {
    return invalid("no runnable steps");
  }
  if (
    !Array.isArray(i.changes) ||
    !i.changes.length ||
    !i.changes.every(changeIsWellFormed)
  ) {
    return invalid("no well-formed changes");
  }
  // An add or a replacement that names an object photo must name one THIS brief carries, as an
  // object. Otherwise the instruction would point at an image the request does not send — or at one
  // sent for another job.
  //
  // An add's may instead be her PRODUCT photo — the freeze's own rule, re-read (C3; nativeIntent.ts): only
  // when the brief carries no Object photo and exactly one product. Card 4 gives a pointed REPLACEMENT the
  // same rule, so both arms read `placeable`.
  //
  // ⚠️ THE REPLACEMENT ARM READ `objects` ALONE UNTIL CARD 4, and it is the LAST of five places that
  // counted this question separately. Card 4's first pass moved two (inside the freeze) and the live run
  // asked at the entry; widening `attachedIn` fixed the entry and the request got this far instead — and
  // was refused HERE with "saved in a form we can't run any more", because the intent the freeze had just
  // bound to a product was then re-read as naming a photo the brief does not carry.
  //
  // A validator that disagrees with the thing it validates is worse than no validator: it turns a correct
  // intent into a blocked preview with a message about staleness that is false.
  const references = brief.job.references ?? [];
  const objects = references.filter((r) => r.role === "object");
  const products = references.filter((r) => r.role === "product");
  const placeable = objects.length
    ? objects
    : products.length === 1
      ? products
      : [];
  const unmatched = i.changes.some((c) => {
    const id = c.add?.objectAssetId ?? c.object?.objectAssetId;
    return !!id && !placeable.some((r) => r.mediaAssetId === id);
  });
  if (unmatched) return invalid("an object photo the brief does not carry");
  return { kind: "native", intent: i as FrozenEditIntent };
}

/**
 * Does a fresh classification reproduce the frozen one?
 *
 * The generate route re-classifies at spend time and refuses on any difference — the path, or any
 * step's operation, targets, value or scope, whether it points at her photo (replace with
 * reference), or the colour it gives each target (card 2). A frozen intent is only worth freezing if
 * drift between the quote and the spend is caught rather than resolved in either direction.
 *
 * ⚠️ `values` IS IN THE KEY BECAUSE IT DECIDES WHAT RENDERS (wave D, card 2). It is the per-target
 * colour of a multi-target recolour — which garment becomes which colour — and this function promises
 * to refuse on any difference. A field that changes the picture and sits outside the gate is drift
 * that nobody catches; `fromPronoun` and `fromPut` stay outside it because they record how a step was
 * READ, and a step read differently to the same op/targets/value/scope renders the same.
 *
 * ⚠️ AND IT IS WHY AN OLD QUOTE FOR A MULTI-VALUE RECOLOUR REFUSES ONCE, RATHER THAN SPENDING ON THE
 * WRONG COLOURS. An intent frozen before card 2 carries no `values` and the re-check now derives them,
 * so it drifts and she is asked to re-quote — the correct answer, because the render it would have
 * produced is the one card 2 exists to fix.
 */
export function intentsAgree(
  frozen: FrozenEditIntent,
  recheck: Routed,
): boolean {
  if (recheck.initialPath !== frozen.initialPath) return false;
  const key = (steps: readonly EditStep[]) =>
    JSON.stringify(
      steps.map((s) => [
        s.op,
        s.targets,
        s.value,
        s.scope,
        s.reference ?? null,
        s.values ?? null,
        // PR 19: her brand renders fenced into the clause (K33, R-22), so it sits inside the gate. Null on every step
        // that predates it, on both sides, so no earlier comparison changes.
        s.brand ?? null,
        // W-3: where her text goes, and that it is hers verbatim, decide what renders.
        s.placement ?? null,
        s.fencedText ?? null,
      ]),
    );
  return key(frozen.steps) === key(recheck.steps);
}
