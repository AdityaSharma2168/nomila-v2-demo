/**
 * studio/preview — the pre-generation check. What will run, what it will cost, and whether we are
 * allowed to run it at all, decided BEFORE a billable call exists.
 *
 * Two functions, and the difference between them is the whole design:
 *
 *   previewGeneration(brief)  — RENDERS a verdict. Never throws for a foreseeable refusal, because
 *                               the UI needs to show the athlete *why* something is blocked, and a
 *                               thrown error gives it a string where it needs a list. Makes no
 *                               network call and spends nothing.
 *   runGeneration(brief)      — ENFORCES it. Re-derives the gate and throws before reaching the
 *                               router. This is defence in depth: a caller that skipped the preview,
 *                               or acted on a stale one, still cannot spend on a blocked job.
 *
 * The preview is advisory; the generate boundary is enforcement. Re-deriving rather than trusting a
 * preview token means there is no staleness window and nothing to issue, store or expire — if the
 * brief changed between the two calls, the second check catches it.
 *
 * MONEY IS ALWAYS AN ESTIMATE HERE. A preview has not run anything, so it cannot hold a billed
 * figure — see EstimatedCost. `basis` is carried verbatim from the adapter and never recomputed,
 * the same rule router.generate() follows.
 */
import { randomUUID } from "crypto";
import { estimate, generate, resolve } from "./router";
import {
  dialectsEnabled,
  imageSizeParams,
  maxEditCalls,
  maxVideoBytes,
  refCapacityFor,
  routeFor,
  smallestImageSizeFor,
  styleSpecEnabled,
  supportedDurationsFor,
  videoBytesPerSecond,
  type ImageSizeName,
  type RefCapacity,
  videoOutputSizeFor,
  videoRouteFor,
  type TaskRoute,
} from "./config";
import { plannedCropWindow } from "./crop";
import {
  dialectFor,
  payloadOf,
  payloadViolations,
  targetFor,
} from "./compile/targets/manifest";
import { shotTypeFor } from "./video/shotType";
import {
  isPromptRefusal,
  videoPromptFor,
  type ShotBeat,
} from "./video/prompts";
import type { EditPath } from "./classify";
import { coversMostOfFrame, planCrops, type PlannedCrop } from "./composite";
import { scaleCost } from "./pricing";
import {
  isRegionFree,
  nativeResolutionNote,
  readNativeIntent,
  type NativeIntentRead,
} from "./nativeEdit";
import {
  aspectFor,
  buildNativePrompt,
  droppedWordsNote,
  inventedObjectNote,
  lookCoversHerNote,
  assumedMoveNote,
  placedProductNote,
} from "./compile";
import { buildPrompt } from "./compile/image";
import { imageTemplateKey } from "./templates/resolve";
import {
  DEFAULT_TEXT_FONT,
  type GeminiImageDialect,
} from "./compile/geminiDialect";
import { renderableStyle } from "./compile/style";
import { STYLE_UNREAD_COPY } from "./reference/styleSpec";
import {
  blockingGaps,
  NO_EDIT_REGIONS_FIELD,
  type BriefDeliverable,
  type BriefGap,
  type CreativeBrief,
  type ReferenceRole,
} from "./brief";
import { MIN_REGION_PX } from "./geometry";
import { createLogger } from "../logger";
import {
  GenerationError,
  type CostEstimate,
  type GenerationInputs,
  type GenerationPlan,
  type GenerationResult,
  type GenerationTask,
  type ImageRef,
  type ProviderOpts,
  type RefSlot,
  type ShotType,
} from "./types";

// Moved to the compile tier (studio/compile/), and still exported from here for every importer.
export { buildNativePrompt, nearestAspect } from "./compile";

const logger = createLogger("studio/preview");

// ─── Cost, narrowed ─────────────────────────────────────────────────────────────────────────────

/**
 * A cost figure that has NOT been billed.
 *
 * The narrowing is the point: assigning a `basis: "reported"` estimate to a preview is a compile
 * error rather than a bug someone finds in a screenshot. `unpriced` is hoisted onto the preview
 * separately, because a UI reading `amountUsd` alone would render $0.00 for "we have no price for
 * this model" — the exact failure studio/pricing.ts exists to prevent.
 */
export type EstimatedCost = CostEstimate & { basis: "estimated" };

/** The runtime half of the guarantee above. Adapters promise "estimated"; this checks they kept it. */
function asEstimated(cost: CostEstimate): EstimatedCost {
  if (cost.basis !== "estimated") {
    throw new GenerationError(
      `pre-generation cost came back as "${cost.basis}" — a preview must never carry a billed figure`,
      "provider_error",
    );
  }
  return cost as EstimatedCost;
}

// ─── The preview ────────────────────────────────────────────────────────────────────────────────

export type PreviewStatus = "ready" | "blocked";

/**
 * A reference the generation will use, named by its role.
 *
 * `ref` is stored form — a GCS path for owned media, an https url for brand imagery. It is NOT
 * fetched during a preview (nothing here touches the network), and `estimate()` only ever reads the
 * COUNT of references, never their contents. Turning a path into something a provider can actually
 * read is the caller's job at run time — see `PreviewOptions.resolveReference`.
 */
export interface PlannedReference {
  /**
   * Where this reference came from and what it contributes.
   *
   * Four values across two sources, and the split matters when you change this list. `source-frame`,
   * `product` and `brand-imagery` are DERIVED from the brief (the edit's frame, a brand's per-piece
   * SKU photo, a brand's own gallery). `person` and `product` are TAGGED BY HER on the job.
   * `product` deliberately means the same thing on both sides and keeps its existing name — a
   * rename would invalidate every brief already frozen in studio_generation_previews.
   *
   * `influence` was a fifth value and was cut with the look-reference feature (see ReferenceRole in
   * studio/brief.ts). A brief frozen while it existed can still carry one; `slotFor` no longer
   * accepts it, so referencesFor drops such a reference rather than routing it — the conservative
   * answer for a role we have stopped standing behind.
   */
  role: "source-frame" | "person" | "product" | "object" | "brand-imagery";
  ref: string;
  label: string;
  /** Where it lands in the request. Derived from `role` by slotFor, never set by hand. */
  slot: RefSlot;
}

export interface GenerationPreview {
  previewId: string;
  createdAt: string;

  status: PreviewStatus;
  /** The full brief, verbatim — the UI renders athlete, brand and job from this without a second call. */
  brief: CreativeBrief;

  /** The resolved route. Null when the job was blocked before routing could be attempted. */
  plan: GenerationPlan | null;
  /** The references that would go in, by role. */
  references: PlannedReference[];

  /** Hoisted from plan.cost so there is one place to read money from. Null when nothing was routed. */
  cost: EstimatedCost | null;
  /** True ⇒ no price is configured for this model. Show "unknown", never $0. */
  unpriced: boolean;

  blockers: BriefGap[];
  warnings: BriefGap[];

  /** Derived, so the refusal copy lives in one place instead of in every surface. */
  verdict: {
    canGenerate: boolean;
    headline: string;
    reason: string | null;
  };
}

export interface PreviewOptions extends ProviderOpts {
  /**
   * WHICH PATH THIS JOB TAKES, CHOSEN RATHER THAN DEDUCED.
   *
   * It used to be inferred from brief shape — `crops?.length ? runMaskedEdit : runGeneration` — so
   * "whole-frame re-render" was not a decision anyone made, it was what happened when
   * `editCropsFor` came back empty. That is fine while the shape and the intent cannot disagree,
   * and wrong the moment a classifier picks a path for a brief that could have been cropped.
   *
   * Omitted is the ordinary case and keeps the deduction exactly as it was, so nothing that does
   * not pass this changes at all.
   *
   * ⚠️ IT CHANGES WHAT "NO CROPS" MEANS, which is the one risk in threading it. See the blocker in
   * `plannedInputs`.
   */
  path?: EditPath;
  /**
   * Why the classifier declined, when `path` is ASK. Carried so the refusal can say which kind of
   * "no" this is — `person_target` and `fast_path_declined` are different answers and want
   * different UI. Meaningless for every other path.
   */
  askReason?: string;
  /**
   * Audio doubles the Veo rate ($0.40/s vs $0.20/s) and the deck's video bed is motion-only, so this
   * defaults to OFF. Set it true deliberately, not by omission.
   *
   * It travels as `providerParams.parameters.generateAudio` — the verified Vertex wire field — rather
   * than as a normalized input, because `GenerationInputs.generateAudio` does not exist. That path is
   * also what pricing reads: studio/pricing resolves the Veo SKU from this exact key, so the arm we
   * quote is the arm the request buys, and a silent clip now quotes at $0.20/s rather than at 2x that.
   */
  generateAudio?: boolean;
  /**
   * Which identity beat a clip asks for — `static` (default) or `pose`. Video only.
   *
   * An OPTION rather than a classification of her sentence, on purpose. "Which beat does this ask
   * for" is a classification problem, and inventing a keyword list for it is the move wave-d warns
   * about. `static` is the measured-safest: V2b calls it "the strictest face test — least motion,
   * most face", and a static beat cannot disagree with its frame, which is what voided V2's easy
   * cell. Rides here beside `generateAudio`, which is the same seam. (`durationSeconds` was a
   * third, and is on the brief now — ledger D3: an option the spend leg replays without is quoted
   * and then lost.)
   */
  shotBeat?: ShotBeat;
  /**
   * THE MODEL A CLIP'S PROMPT IS WRITTEN FOR, on the RUN leg only (quality-scrappy, ADI-QS-GO R6; ledger D1).
   *
   * The runner re-derives the prompt from the frozen brief (videoRunner `inputsFor`) but dispatches on the job ROW's
   * model. A prompt in a model's own dialect therefore has to be chosen from the ROW's model there, never from
   * `videoRouteFor` — which reads the env NOW, and would compile for model A and send to model B the moment an env
   * moved between the quote and the run. At the quote this is absent and the quote's own route decides; that route IS
   * what the row is written from (jobs.ts `createGenerationJob`), so the two legs choose the same dialect by
   * construction. Read only behind STUDIO_DIALECTS: with the flag off it changes nothing.
   */
  dialectModel?: string;
  /** How many reference images to send at most. Keeps a request payload sane. */
  maxReferences?: number;
  /**
   * Turns a stored `ref` into something a provider can read — signing a GCS path, or fetching bytes.
   * Only used by runGeneration; a preview never resolves anything. Defaults to passing the ref
   * through as a url, which is already correct for brand imagery (real https urls) and wrong for a
   * GCS path — so a caller generating from owned media MUST supply one.
   */
  resolveReference?: (r: PlannedReference) => Promise<ImageRef> | ImageRef;
  /**
   * WHICH CROP THIS CALL IS FOR — set only by studio/generate.ts, once per region, and never by a
   * preview.
   *
   * A masked edit is one provider call per region, and each call shows the model a different CROP.
   * This selects which one the PROMPT describes, because a prompt that named the whole frame's
   * coordinates would be describing a picture the model cannot see (see buildPrompt's crop arm).
   *
   * ─── IT MUST NOT MOVE ANYTHING THAT COSTS MONEY, AND IT DOES NOT ────────────────────────────
   *
   * The task, the references, the image SIZE and the cost are all derived from the frozen brief
   * alone and are identical for every value of this field, including undefined. That is what lets
   * previewGeneration (which never sets it) and the per-region generate calls (which always do)
   * agree about the quote by construction rather than by agreement — and it is asserted directly in
   * preview.test.ts, because a size that drifted between the two would mean the quote and the spend
   * were for different jobs and the approved ceiling guarded neither.
   */
  cropIndex?: number;
}

const DEFAULT_CLIP_SECONDS = 4;

/** Deliverables that are motion. Everything else is a still. */
const VIDEO_DELIVERABLES = new Set<BriefDeliverable>(["clip", "reel"]);

// ─── brief → router inputs ──────────────────────────────────────────────────────────────────────

/** A blocker that is about ROUTING rather than about missing data. Same type, so callers read one list. */
const routingBlocker = (field: string, note: string): BriefGap => ({
  field,
  note,
  severity: "blocking",
});

/**
 * Which task this brief is. The edit/generate fork decides it, and nothing else may.
 *
 * A video EDIT is not supported: the masked-composite path the spike validated is image-only, and
 * there is no equivalent for motion. That combination is refused rather than quietly downgraded to
 * a full re-render, which is the exact failure mode the fork exists to prevent.
 */
function taskFor(brief: CreativeBrief): {
  task: GenerationTask | null;
  blocker: BriefGap | null;
} {
  const { mode, deliverable } = brief.job;
  const isVideo = VIDEO_DELIVERABLES.has(deliverable);
  if (mode === "edit") {
    if (isVideo) {
      return {
        task: null,
        blocker: routingBlocker(
          "job.deliverable",
          `Editing a "${deliverable}" is not supported — the pixel-faithful edit path is image-only. Generate it as a new clip, or edit a still instead.`,
        ),
      };
    }
    // PR 19 (S-7): a frozen CROP is her pixels cut in-process — its own task, $0, the local adapter. Read off the
    // brief like everything here, so the quote and the run cannot disagree about which task this is.
    if (isCropOnly(brief)) return { task: "image.crop", blocker: null };
    return { task: "image.edit", blocker: null };
  }
  return { task: isVideo ? "video.generate" : "image.generate", blocker: null };
}

/**
 * Role → provider slot. A total switch over a closed union rather than a map with a default: adding
 * a role without deciding where it lands is a compile error, not a reference that quietly inherits
 * "character".
 *
 * `style` now has exactly one occupant — the brand's own cover and gallery imagery — and that is a
 * deliberate decision rather than a leftover. See the note on referencesFor.
 */
export function slotFor(role: PlannedReference["role"]): RefSlot {
  switch (role) {
    case "source-frame":
      return "frame";
    case "person":
      return "character";
    case "product":
      return "object";
    // Same slot as `product` and a different manifest line — see referenceManifest (studio/compile/
    // manifest.ts). The slot is WHERE it goes; the role is WHAT it is for, and only one of those the
    // provider can see.
    case "object":
      return "object";
    case "brand-imagery":
      return "style";
  }
}

/**
 * Her tagged role → the planner's role. Identity today; the two vocabularies are free to diverge.
 *
 * ⚠️ `style_reference` IS NOT A KEY, AND THAT ABSENCE IS R-8 (PR 18). The filter in referencesFor keeps only a
 * role that is a key here, so a style reference is never planned, never gets a slot, and not one byte of its
 * image reaches the model. Its READING rides the brief instead (`JobReference.style`, compile/style.ts). The
 * look role was cut because pixels in a style slot leaked faces (studio/brief.ts, ReferenceRole).
 * ⚠️ MUTATION (edit/engine.style.test and routes/studio.style.test "a raw style image is forwarded to the
 * model"): add it here.
 */
type PlannedHerRole = Exclude<ReferenceRole, "style_reference">;
const PLANNED_ROLE: Record<PlannedHerRole, PlannedReference["role"]> = {
  person: "person",
  product: "product",
  object: "object",
};

const plan = (
  role: PlannedReference["role"],
  ref: string,
  label: string,
): PlannedReference => ({ role, ref, label, slot: slotFor(role) });

/**
 * The references, in SLOT order, capped per slot.
 *
 * ─── ORDER IS A CONSEQUENCE, NOT A SIGNAL ───────────────────────────────────────────────────────
 *
 * It still matters — the prompt's reference manifest numbers against this array, so "Image 3" has
 * to be the third thing the adapter sends — but it is DERIVED from the slot rather than being the
 * only thing carrying the meaning. Previously an adapter could only infer a reference's purpose
 * from where it happened to sit.
 *
 *   frame  →  character  →  object  →  style
 *
 * ─── WHY THE BRAND'S IMAGERY KEPT ITS STYLE SLOT WHEN THE LOOK REFERENCE WAS CUT ────────────────
 *
 * These are not the same decision, and collapsing them would have been the wrong call.
 *
 * The look reference was cut because of a PROMISE: the picker told the athlete "we'll take the look
 * — never the people", and on gemini-3-pro-image that sentence is false. Brand cover and gallery
 * imagery makes no promise to anyone. She never tags it, never sees it, and is told nothing about
 * it — it is internal art direction the brief has always carried.
 *
 * Reverting it to untyped would give up two real things for nothing: deterministic placement (it
 * cannot drift into the position the manifest describes as her likeness) and a manifest line that
 * tells the model what the image is FOR. Before this work it travelled in the same undifferentiated
 * list as the source frame, which is strictly worse than where it sits now.
 *
 * What DID change with the cut is the wording. The manifest no longer tells the model that no
 * person may come out of a style image, because that is the instruction we just watched it ignore
 * and we should not keep writing it as though it holds.
 *
 * ─── HER REFERENCES REFUSE; THE BRAND'S TAIL IS SLICED ──────────────────────────────────────────
 *
 * Over a slot's capacity, what SHE tagged is a blocking gap with a sentence she can act on —
 * silently dropping the fourth photo of herself means generating something that no longer looks
 * like her while telling her it used four references. What the BRAND contributed is art-direction
 * filler and is sliced, because refusing to generate because a brand has nine gallery photos would
 * be absurd.
 */
/**
 * A style reference's own refusals (PR 18). Each is a blocking gap she reads, never a silent drop: "her
 * references refuse", as the note on referencesFor says. With no style reference on the brief this is [], so
 * every brief that predates the role plans exactly as before.
 */
function styleBlockers(brief: CreativeBrief): BriefGap[] {
  const style = (brief.job.references ?? []).filter(
    (r) => r.role === "style_reference",
  );
  if (!style.length) return [];
  const gap = (note: string): BriefGap => ({
    field: "job.references",
    note,
    severity: "blocking",
  });
  // Flag off means flag off (R-12): a brief frozen while it was on does not run with it off.
  if (!styleSpecEnabled())
    return [gap("Style references are switched off right now.")];
  if (style.length > 1)
    return [gap("One style reference at a time. Remove one and check again.")];
  const spec = style[0].style;
  if (!spec) return [gap(STYLE_UNREAD_COPY)];
  // Frozen under a derivation compile no longer renders: refused, never re-derived (ADI-GO18 G1).
  if (!renderableStyle(spec))
    return [
      gap(
        "This check was saved in a form we can't run any more — check the cost again.",
      ),
    ];
  // On an edit the reference drives the LOOK, so an edit that changes no look has nothing for it to shape.
  if (brief.job.mode === "edit") {
    const native = readNativeIntent(brief);
    const looks =
      native.kind === "native" &&
      native.intent.changes.some((c) => c.op === "GLOBAL_STYLE");
    if (!looks)
      return [
        gap(
          "A style reference changes the whole photo's look, and this edit doesn't change the look. Remove the style reference, or ask for a look change too.",
        ),
      ];
  }
  return [];
}

function referencesFor(
  brief: CreativeBrief,
  caps: RefCapacity,
): { references: PlannedReference[]; blockers: BriefGap[] } {
  const blockers: BriefGap[] = [];
  blockers.push(...styleBlockers(brief));
  // `?? []` — a brief frozen before this field existed. The role filter is the same defence one
  // layer on: a brief frozen while `influence` was a role still carries one, and it is DROPPED
  // rather than routed, because we no longer stand behind where it would go.
  const job = (brief.job.references ?? []).filter(
    (r) => r.role in PLANNED_ROLE,
  );

  const tagged = (role: PlannedHerRole) =>
    job
      .filter((r) => r.role === role)
      .map((r, i) =>
        plan(PLANNED_ROLE[role], r.ref, r.label?.trim() || `${role} ${i + 1}`),
      );

  const person = tagged("person");
  const product = tagged("product");
  const object = tagged("object");

  /**
   * A LIKENESS HAS NO BUSINESS ON AN EDIT, and this is the structural half of that.
   *
   * An edit is a bounded retouch of a frame that must otherwise survive bit-identical. A `person`
   * reference on one produces two instructions that contradict each other outright: the opening
   * line says change nothing but the marked region, and the manifest says "Image 2 — HER LIKENESS
   * … this is the person to render; her face, hair and build come from this image." That is a
   * face-swap instruction wearing a reference's clothes, and combined with a client that carried a
   * reference over from the previous piece it is exactly how one athlete's likeness ended up
   * conditioning an edit of a photograph of someone else.
   *
   * BLOCKING, NOT A SILENT DROP. She chose that photograph and tagged it; removing it quietly
   * would generate something different from what the screen says she asked for. The rule that
   * "her references refuse and the brand's tail is sliced" applies here too — this is hers.
   *
   * ⚠️ Saved-face reference (B3) will need an explicit exception here — the persistent "this is me"
   * ref IS permitted to condition an edit; ad-hoc person refs are not.
   */
  const refusedOnEdit = brief.job.mode === "edit" && person.length > 0;
  if (refusedOnEdit) {
    blockers.push({
      field: "job.references",
      note:
        "An edit changes part of a photo you already have — it can't also put someone else in it. " +
        "Remove the photo tagged “You”, or start a new image instead.",
      severity: "blocking",
    });
  }
  // Refused AND unrouted. The blocker already stops the job, but a `character` slot that exists
  // only on a preview nobody may spend against is a slot a later caller can still read — and the
  // manifest line it would produce is the face-swap instruction above. Two halves, both cheap.
  const routedPerson = refusedOnEdit ? [] : person;

  // The SENTENCE is per-call rather than a shared template, because the two caps are not the same
  // kind of number and a blocking gap is copy she reads. The object cap is the model's documented
  // capacity; the character cap is OURS (studio/config.ts, CHARACTER_CAP — the pack size we have
  // actually measured, under what Google allows). "This model takes up to 3 photos of you" would be
  // a true-sounding sentence about a limit the model does not have.
  const over = (
    got: PlannedReference[],
    cap: number,
    note: (n: number, cap: number) => string,
  ) => {
    if (got.length <= cap) return;
    blockers.push({
      field: "job.references",
      note: note(got.length, cap),
      severity: "blocking",
    });
  };

  over(
    routedPerson,
    caps.character,
    (n, cap) =>
      `${n} photos of you — a piece can be built from up to ${cap}. Remove one and check again.`,
  );
  // ONE CAP FOR ONE SLOT. `product` and `object` share the object slot, so they share its ceiling —
  // counting them separately would let two roles put twice the slot's capacity into it and the
  // per-slot trim below would then silently drop whichever sorted last.
  //
  // The NOUN follows what she actually attached. "7 product photos" is the right sentence when she
  // attached seven products and the wrong one when three of them were objects, and a blocking gap
  // is copy she reads on the screen she is looking at — so it names the thing rather than the slot.
  over(
    [...product, ...object],
    caps.object,
    (n, cap) =>
      `${n} ${object.length ? "product and object photos" : "product photos"} — this model takes up to ${cap}. Remove one and check again.`,
  );

  // HERS — the frame plus everything she tagged. Kept as its own list rather than recovered later
  // by comparing paths: that only works while brand references are https urls and job references
  // are GCS paths, which is a coincidence of today's data and not a property of the types.
  const hers: PlannedReference[] = [];
  const src = brief.job.source;
  if (src) hers.push(plan("source-frame", src.ref, "the frame to preserve"));
  hers.push(...routedPerson, ...product, ...object);

  // THE BRAND'S — art-direction filler, taking whatever room hers left in each slot. The spike's
  // lesson is that a named piece with no reference is the failure that ships, so the per-piece SKU
  // photographs matter; hers were still chosen for THIS job, so they go first.
  const pieces = (brief.brand?.pieces ?? [])
    .filter((piece) => piece.reference)
    .map((piece) => plan("product", piece.reference!.ref, piece.name))
    .slice(0, Math.max(0, caps.object - product.length - object.length));
  const imagery = (brief.brand?.referenceImagery ?? [])
    .filter((img) => img.role !== "logo") // a logo is not art direction
    .map((img) =>
      plan("brand-imagery", img.ref, `${brief.brand!.name} ${img.role}`),
    )
    .slice(0, caps.style);

  // The TOTAL ceiling is ours and is about PAYLOAD rather than about the model (see refCapacityFor).
  // If hers alone exceed it, that is a refusal — trimming would silently drop a photo she chose.
  // Otherwise it trims the brand-derived tail, which is exactly what filler is for.
  if (hers.length > caps.total) {
    blockers.push({
      field: "job.references",
      note:
        `${hers.length} references on one image is more than this model takes (${caps.total}). ` +
        "Remove one and check again.",
      severity: "blocking",
    });
    return { references: [...hers, ...pieces, ...imagery], blockers };
  }

  const refs = [
    ...hers.filter((r) => r.slot === "frame"),
    ...hers.filter((r) => r.slot === "character"),
    ...hers.filter((r) => r.slot === "object"),
    ...pieces,
    ...imagery,
  ];
  return { references: refs.slice(0, caps.total), blockers };
}

export { buildPrompt };

/** The model a task routes to for this request — "" when it cannot route. What capsFor and the image dialect read. */
function routedModel(
  task: GenerationTask | null,
  opts: PreviewOptions,
): string {
  if (!task) return "";
  try {
    return resolve(task, opts).model;
  } catch {
    return ""; // unroutable — the floor is the right answer
  }
}

/**
 * Reference capacity for the model this brief would actually route to.
 *
 * Resolved rather than assumed, because the caps differ per model and the route is env-driven. An
 * UNROUTABLE brief (bad provider, unsupported task) resolves to the conservative floor instead of
 * throwing — previewGeneration's whole contract is to render a verdict rather than throw one, and
 * the routing failure is already reported as its own blocker a few lines later.
 *
 * `opts.maxReferences` stays honoured as a TIGHTENING of the total and nothing else. It is the
 * pre-existing caller-facing knob and it must not be able to widen a model's real capacity.
 */
function capsFor(
  task: GenerationTask | null,
  opts: PreviewOptions,
): RefCapacity {
  const model = routedModel(task, opts);
  const caps = refCapacityFor(model);
  return opts.maxReferences === undefined
    ? caps
    : { ...caps, total: Math.max(1, Math.min(caps.total, opts.maxReferences)) };
}

/**
 * The crops a masked edit will send — ONE PER REGION — derived from the frozen brief and nothing else.
 *
 * ─── PURE, AND THAT IS THE WHOLE SAFETY ARGUMENT ────────────────────────────────────────────────
 *
 * Everything this reads (`source.width`, `source.height`, `source.editRegions`) is frozen into the
 * brief by the preview route and replayed verbatim by /studio/generate. So previewGeneration and
 * runStudioGeneration compute the SAME crops, and therefore the same image size, and therefore the
 * same quote — by construction, with nothing passed between them that could be stale, forged or
 * forgotten. If this ever took an argument that was not the brief, the quote and the spend could be
 * for different jobs and the approved ceiling would guard neither.
 *
 * Null rather than an empty array when this is not a masked edit, so the difference between "no
 * crops because this is a generate" and "no crops because the regions are missing" stays visible.
 * A brief with regions but no measured dimensions cannot be cropped and returns null too — it is
 * already a blocking gap by then (assembleBrief refuses an edit with no regions, and the route
 * refuses a frame it could not measure), so this never silently degrades a real job.
 */
/**
 * A region large enough that editing inside it re-renders the frame, with nothing marking it as an
 * inversion. Null when the brief is fine.
 *
 * Reads the FROZEN source dimensions rather than probing the image: `mapRegions` already refused any
 * region that does not lie inside them, so they are the space the regions are measured in and the
 * only ones this can honestly compare against.
 */
function wholeFrameEditBlocker(brief: CreativeBrief): BriefGap | null {
  const src = brief.job.source;
  if (brief.job.mode !== "edit" || !src?.width || !src?.height) return null;

  const frame = { width: src.width, height: src.height };
  const offender = (src.editRegions ?? []).find(
    (r) => !r.subjectNoun && coversMostOfFrame(r, frame),
  );
  if (!offender) return null;

  return routingBlocker(
    "regions",
    "We couldn't work out what to change here — the area we found covers the whole photo, and " +
      "editing all of it would redraw you along with the background. Try naming the thing you " +
      "want changed, or mark just that area.",
  );
}

export function editCropsFor(brief: CreativeBrief): PlannedCrop[] | null {
  const { mode, source } = brief.job;
  if (mode !== "edit" || !source?.editRegions.length) return null;
  if (!source.width || !source.height) return null;
  const crops = planCrops(source.editRegions, {
    width: source.width,
    height: source.height,
  });
  // A DEGENERATE CROP MEANS THE BRIEF DISAGREES WITH ITSELF, and the honest answer is "no crops"
  // rather than a zero-width extract.
  //
  // planCrop clamps to the frame, so a region that does not actually lie inside the stated
  // dimensions collapses — a box at 2125,2345 on a frame claiming to be 1080x1920 clamps to nothing.
  // That cannot happen through the product: mapRegions refuses an out-of-bounds box in fraction
  // space before it becomes pixels, and the route freezes the regions and the measured dimensions
  // into the brief together. It CAN happen to a brief assembled by hand or frozen by an older code
  // path, and `sharp.extract` on a zero-width rectangle throws mid-generation, after the approval
  // has been consumed.
  //
  // Returning null here does not quietly fall back to the whole-frame re-render: plannedInputs
  // raises a BLOCKING gap for an edit that has regions and no crops, so the job refuses before it
  // spends. See the blocker below.
  if (
    crops.some(
      (c) => c.send.width < MIN_REGION_PX || c.send.height < MIN_REGION_PX,
    )
  )
    return null;
  return crops;
}

/**
 * The output resolution this edit needs — the smallest that will not force an upscale.
 *
 * ONE SIZE FOR THE WHOLE JOB, taken from the LARGEST crop, rather than a size per crop. A per-crop
 * optimum would be a little cheaper on the small ones, and it would make the size depend on which
 * region a call is for — which is exactly the thing that must not vary between the preview's
 * derivation and generate's. One number, from the brief, for every call in the job.
 */
/**
 * Which crop a given call is for.
 *
 * A preview passes no index and gets crop 0 — verbatim what the job's FIRST call will send, so the
 * check describes a request somebody actually makes rather than a synthetic whole-frame one.
 */
export function cropFor(
  crops: PlannedCrop[] | null,
  cropIndex?: number,
): PlannedCrop | null {
  if (!crops?.length) return null;
  return crops[cropIndex ?? 0] ?? null;
}

export function editImageSizeFor(crops: PlannedCrop[]): ImageSizeName {
  const largest = Math.max(...crops.map((c) => c.send.width * c.send.height));
  return smallestImageSizeFor(largest);
}

/** A frozen intent that is one CROP and nothing else (PR 19). A crop never composes: its reader is a whole sentence. */
function isCropOnly(brief: CreativeBrief): boolean {
  const native = readNativeIntent(brief);
  return (
    native.kind === "native" &&
    native.intent.changes.length === 1 &&
    native.intent.changes[0].op === "CROP"
  );
}

/** Everything the router needs, derived from the brief. Exported so runGeneration and tests share it. */
export function plannedInputs(
  brief: CreativeBrief,
  opts: PreviewOptions = {},
): {
  task: GenerationTask | null;
  inputs: GenerationInputs;
  references: PlannedReference[];
  blocker: BriefGap | null;
  /** Over-capacity refusals. Separate from `blocker`, which is only ever about routing. */
  referenceBlockers: BriefGap[];
  /** Provider knobs derived from the job. Already merged over the caller's own. */
  providerParams: Record<string, unknown> | undefined;
  /**
   * One crop per region for a masked edit, null otherwise. Derived from the brief (editCropsFor), so
   * every caller that plans this brief gets the same list without being handed one.
   */
  crops: PlannedCrop[] | null;
  /** What kind of video segment this is. Null for every image task. */
  shotType: ShotType | null;
  /** Where that shot type sends it. Null for every image task — see the note on the return. */
  videoRoute: TaskRoute | null;
  /**
   * The prompt template this brief compiles from, as the registry keys it (quality-scrappy pieces 4 and 8):
   * `studio.video.<name>` for a clip, `studio.image.generate` for an image generate, `studio.image.edit.*` for an edit
   * (templates/resolve.ts), null for a crop. What templates/freeze.ts freezes.
   */
  templateKey: string | null;
} {
  const { task, blocker: routingIssue } = taskFor(brief);
  const { references, blockers: referenceBlockers } = referencesFor(
    brief,
    capsFor(task, opts),
  );
  const isVideo = task === "video.generate";
  // ─── "NO CROPS" NOW HAS TWO MEANINGS, AND THEY NEED OPPOSITE ANSWERS ───────────────────────
  //
  // DEGENERATE   regions exist and `planCrops` collapsed them → the brief disagrees with itself
  // NOT WANTED   this path deliberately does not crop         → nothing is wrong at all
  //
  // Before a path could be chosen there was only one way to reach an empty list, so the blocker
  // below could treat it as unambiguous. Now the caller's intent is the thing that separates them,
  // which is why it has to be passed rather than re-derived from the brief — the brief looks
  // identical in both cases.
  //
  // ─── A NATIVE EDIT IS THE THIRD "NOT WANTED", AND THE BRIEF ITSELF SAYS SO ─────────────────
  //
  // A brief carrying a frozen intent (studio/nativeEdit.ts) runs as one full-frame call, so it wants
  // no crops whatever path is threaded — and unlike `path`, that fact is READ OFF THE BRIEF, the way
  // editCropsFor reads its regions. The preview and the generate leg plan from one frozen object, so
  // they cannot disagree about whether this job is native, what size it is, or what it costs.
  const native = readNativeIntent(brief);
  const wantsCrops =
    native.kind === "none" &&
    (opts.path === undefined ||
      opts.path === "MASKED" ||
      opts.path === "BACKGROUND");
  const crops = wantsCrops ? editCropsFor(brief) : null;
  // A brief that carries an intent we cannot run REFUSES. Ignoring it would plan the masked path for
  // a job that was quoted as a native edit — a different implementation at a different price.
  const nativeBlocker =
    native.kind === "invalid"
      ? routingBlocker(
          "job.editIntent",
          "This check was saved in a form we can't run any more — check the cost again.",
        )
      : null;

  // ONE selection, shared by the prompt and the canvas. They describe the same picture, so a helper
  // rather than two lookups: two places choosing a crop is two places that can choose differently,
  // and the failure would be a prompt describing region A on a canvas shaped for region B.
  const crop = cropFor(crops, opts.cropIndex);

  // ─── WHAT KIND OF SEGMENT THIS IS, AND THEREFORE WHERE IT GOES ───────────────────────────────
  //
  // Derived from the references the planner just produced (studio/video/shotType.ts) — never stored,
  // never picked, never guessed from her sentence. Resolved HERE and not at the call because the
  // runner reads `provider` and `model` OFF THE JOB ROW, and the row is written from the frozen
  // preview plan: whatever is decided at this line is what a clip is committed to, and nothing
  // downstream may re-decide it.
  // ─── ⚠️  WHAT KIND OF SEGMENT, AND WHY A LAST FRAME DECIDES IT BEFORE THE REFERENCES DO ──────
  //
  // `shotTypeFor` is UNCHANGED and is still the only thing that reads the references — its test
  // enumerates all 32 subsets of the role union to prove it can never return `transition`, and that
  // test passes verbatim because a bridge is not something you can see in a reference list. A
  // transition is selected by a SECOND SIGNAL: the caller asked the clip to arrive somewhere.
  //
  // ⚠️ AND IT OVERRIDES `identity` RATHER THAN LOSING TO IT. A clip with her likeness AND a last
  // frame would otherwise route to Veo, and `submitVideoOperation` builds `instances[0] = { prompt,
  // image }` and stops — the last frame would be silently dropped and she would be billed for an
  // ordinary image-to-video clip labelled as a bridge. That is the exact failure `shotType.ts`
  // refused to ship a transition for in the first place, arriving from the other direction.
  //
  // So the precedence is forced by 1d being deferred, not chosen: the only route that can carry a
  // last frame is the transition route. When Vertex learns to send one, this is where the choice
  // becomes a real one and deserves an argument.
  const shotType = isVideo
    ? brief.job.lastFrame
      ? ("transition" as const)
      : shotTypeFor(references)
    : null;
  const videoRoute = shotType ? videoRouteFor(shotType) : null;
  const videoSize = shotType
    ? videoOutputSizeFor(shotType, aspectFor(brief, crop))
    : null;

  // The prompt a clip actually sends. A shot type with no VALIDATED template refuses rather than
  // borrowing one — see studio/video/prompts.ts. `prompt: ""` on that path is not a gap: router's
  // `validate` rejects an empty prompt, so the refusal arrives twice, once in her words.
  // The dialect — OFF unless STUDIO_DIALECTS is exactly "true" (opt-in, ADI-QS-GO). From the run's ROW model when the
  // runner passes one, else from this quote's route; never from anything the env says at the run (R6).
  const dialect =
    shotType &&
    dialectsEnabled() &&
    dialectFor(opts.dialectModel ?? videoRoute?.model) === "seedance"
      ? ("seedance" as const)
      : null;
  // quality-scrappy piece 7: the Gemini 3 Pro Image dialect (compile/geminiDialect.ts) — opt-in like Seedance's, and
  // chosen from the model THIS image call routes to: the one capsFor reads and the job row records, so the quote and
  // the run write for the model that is called. A crop is cut in-process and a clip is video, so neither is written in
  // it. Its face is the default until a published template names one (piece 8).
  const imageDialect: GeminiImageDialect | null =
    (task === "image.generate" || task === "image.edit") &&
    dialectsEnabled() &&
    dialectFor(opts.dialectModel ?? routedModel(task, opts)) === "gemini-image"
      ? { aspect: aspectFor(brief, crop) ?? null, font: DEFAULT_TEXT_FONT }
      : null;
  const videoPromptResult = shotType
    ? videoPromptFor(shotType, brief, opts.shotBeat ?? "static", dialect)
    : null;
  const videoPrompt =
    videoPromptResult && !isPromptRefusal(videoPromptResult)
      ? videoPromptResult.prompt
      : shotType
        ? ""
        : null;
  const videoPromptBlocker =
    videoPromptResult && isPromptRefusal(videoPromptResult)
      ? routingBlocker("job.deliverable", videoPromptResult.blocker)
      : null;

  // ─── SOUND IS READ OFF THE BRIEF, AND ONLY AN IDENTITY CLIP ON VERTEX CAN HAVE IT ────────────
  //
  // Off the BRIEF because the quote and the run both arrive here with empty options (the route's
  // `previewGeneration(brief, {})`, the runner's `inputsFor`), so the brief is the only thing both
  // legs share. `opts.generateAudio` stays as the probe's seam and cannot turn a frozen choice OFF.
  //
  // IDENTITY ONLY. B-roll and bridges run through the OpenRouter adapter, which forces
  // `generate_audio: false` below its params spread on purpose (it is what stops a Kling
  // under-quote) — so for those shots this stays false, the wire stays false, and a token-priced
  // quote does not move. She is not refused: a b-roll clip with sound asked for is a silent b-roll
  // clip at the same price.
  //
  // VERTEX ONLY, and that one IS a refusal. With STUDIO_VIDEO_PROVIDER=openrouter the same adapter
  // withholds opts from pricing, so Veo quotes the $0.40/s audio arm and the wire still says off:
  // she would pay the sound price for silence.
  const askedForSound = brief.job.audio === true || opts.generateAudio === true;
  // ─── WHICH SHOTS MAY SOUND — A PER-MODEL QUESTION, NOT A PREFERENCE ─────────────────────────
  //
  //   identity   Veo on Vertex. A real, priced audio SKU at DOUBLE the per-second rate, so it is
  //              part of what she approves — and refused outright off Vertex, below.
  //   broll      Seedance over OpenRouter. Priced `per_video_token`, and its published
  //              `video_tokens_without_audio` equals `video_tokens`, so there is no audio arm to
  //              buy: the quote cannot move. `wantsAudio` in studio/pricing is consulted only
  //              inside `case "per_second"`, which Seedance never reaches.
  //   transition Kling, which bills 0.126/s with audio against the flat 0.084/s we quote, with no
  //              `usdWithAudio` key. That is a 50% under-quote, so sound is NEVER offered here —
  //              and the OpenRouter adapter excludes Kling by model as well, so neither this line
  //              nor a `providerParams` value alone can open it.
  const soundableShot = shotType === "identity" || shotType === "broll";
  const wantsSound = askedForSound && soundableShot;
  // ⚠️ THE ONE REFUSAL, and it is an OVER-quote rather than an under one. On
  // `STUDIO_VIDEO_PROVIDER=openrouter` the identity clip is Veo through an adapter that withholds
  // `opts` from pricing — and an UNSET `generateAudio` buys Veo's pricier arm — so she would be
  // quoted $0.40/s while that same adapter forces the wire to false: the sound price for silence.
  // B-roll is not refused here, because nothing about its price depends on the answer.
  const audioBlocker =
    wantsSound && shotType === "identity" && videoRoute?.provider !== "vertex"
      ? routingBlocker(
          "job.audio",
          "Sound isn't available for this clip right now — turn sound off to make it.",
        )
      : null;

  // AN EDIT THAT CANNOT BE CROPPED MUST NOT RUN, because the only thing left for it to do is the
  // full re-render this whole path exists to replace — and it would do it silently, having quoted
  // and been approved as an edit. Reachable two ways, and both are already refusals upstream: a
  // frame whose bytes we could not measure (routes/studio.ts refuses that), and regions that do not
  // lie inside the dimensions frozen beside them (mapRegions refuses that). This is the backstop
  // for a brief that reached here anyway.
  // PR 19 (S-7): the window a crop cuts, planned from the frozen source — the quote's and the run's, one number.
  const cropWindow =
    task === "image.crop" && native.kind === "native" && brief.job.source
      ? plannedCropWindow(
          brief.job.source,
          native.intent.changes[0].change ?? "",
        )
      : null;
  const cropBlocker =
    task === "image.crop" && !cropWindow
      ? routingBlocker(
          "job.editIntent",
          "This crop can't be planned on this photo — check its size and try again.",
        )
      : null;
  const blocker =
    routingIssue ??
    nativeBlocker ??
    cropBlocker ??
    videoPromptBlocker ??
    audioBlocker ??
    // ⚠️ `wantsCrops` GUARDS THIS, and without it a deliberately-chosen FULL_IMAGE job would be
    // refused by the very check that exists to stop an accidental one. The backstop still fires for
    // every path that asked to be cropped and could not be.
    (wantsCrops &&
    brief.job.mode === "edit" &&
    brief.job.source?.editRegions.length &&
    !crops
      ? routingBlocker(
          "job.source",
          "We can't place this edit on the photo — we couldn't match the area to change against the " +
            "photo's own dimensions. Try re-uploading it, or mark the area again.",
        )
      : // ─── THE CALL CAP, REFUSED BEFORE IT SPENDS ──────────────────────────────────────────────
        //
        // Derived from the same crops the quote and the spend derive from, so the preview and the
        // generate leg refuse identically — this runs on both sides of the approval gate, which is
        // the property that keeps a job from passing the check and then busting the cap.
        //
        // A BLOCKER, NOT A TRUNCATION. Silently dropping the crops past the cap would edit some of
        // what she asked for and report success, which is the one outcome worse than refusing: she
        // would pay, receive a photo, and have to find the missing change herself.
        crops && crops.length > maxEditCalls()
        ? routingBlocker(
            "regions",
            `That's ${crops.length} separate areas to edit, and we change up to ${maxEditCalls()} at ` +
              "a time. Ask for fewer things in one go, or mark just what you want changed.",
          )
        : // ─── A WHOLE-FRAME REGION THAT IS NOT AN INVERSION, REFUSED BEFORE SHE PAYS ────────────
          //
          // The layer that tells her BEFORE the money. `pasteBack` refuses the same shape
          // structurally (see MAX_EDIT_INSIDE_FRAME_SHARE), but by the time it runs the patch has
          // already billed, so the only outcomes left there are refuse or re-render her. This one
          // costs nothing: the geometry is known here, and a region covering half the frame with no
          // `subjectNoun` to invert it will edit INSIDE its own rectangle — which is the whole
          // photograph.
          //
          // ⚠️ SIX REAL JOBS REACHED THIS STATE AND REPORTED SUCCESS. All six were background
          // requests whose `subjectNoun` detection did not return; one of them said "dont change
          // any other elements of the photo". They were composited as ordinary rectangle edits and
          // the athlete was re-rendered.
          //
          // ⚠️ THE CHECK IS GEOMETRY, DELIBERATELY, AND ASKS NOTHING OF ANY NOUN. Every other guard
          // on this path reads a field that detection may have dropped. A destructive outcome must
          // be explicitly requested, never reached by a field being absent — the same rule that
          // makes GENERATE unreachable rather than discouraged in studio/classify.ts.
          wholeFrameEditBlocker(brief));
  const inputs: GenerationInputs = {
    // ─── ⚠️  A THIRD ARM, AND THE SHAPE IS WHY THE IMAGE GOLDENS CANNOT MOVE ──────────────────
    //
    // Video is decided FIRST and returns before either image arm is consulted, so `buildPrompt`
    // and `buildNativePrompt` are reached by exactly the briefs that reached them before and
    // produce exactly the strings they produced before. That is a property of the control flow
    // rather than a hope about it: 36 goldens pin the image prompts byte-for-byte, and the only
    // way this commit could move one is by editing those functions, which it does not.
    prompt: videoPrompt
      ? videoPrompt
      : native.kind === "native"
        ? buildNativePrompt(brief, references, native.intent, imageDialect)
        : buildPrompt(brief, references, crop, imageDialect),
    // THE FLATTENING FIX (ledger #2). `slot` and `label` ride across this boundary now; before,
    // this line built a bare {kind,url} and the role died here, leaving array position as the
    // adapter's only signal. Stored form still — a preview never fetches anything, and
    // runGeneration swaps in resolved bytes/urls while carrying these same two fields over.
    references: references.map(
      (r) =>
        ({ kind: "url", url: r.ref, slot: r.slot, label: r.label }) as ImageRef,
    ),
    // Both modes now. A generate takes its deliverable's art direction; an edit takes the shape of
    // the frame it is editing, which is what stops the output coming back on its side.
    ...(aspectFor(brief, crop) ? { aspectRatio: aspectFor(brief, crop)! } : {}),
    // ⚠️ THE BRIEF, AND NOTHING ELSE. This was a PreviewOptions field too, for one PR, kept "for the
    // probe scripts" — and no script used it: they all set the ROUTER's inputs directly. A second
    // source for one approved fact is the same drift one level up, and an option the spend leg can
    // never see (it replays with `{}`) is wiring that only a comment would ever defend.
    ...(isVideo
      ? {
          durationSeconds: brief.job.durationSeconds ?? DEFAULT_CLIP_SECONDS,
        }
      : {}),
    // ─── THE FRAME THE CLIP ARRIVES AT ─────────────────────────────────────────────────────────
    //
    // Video only, and absent unless asked for — so a clip that names no last frame produces inputs
    // byte-identical to what it produced before this existed, and every image task is untouched by
    // construction (the guard is `isVideo`, the same one `durationSeconds` sits behind).
    //
    // ⚠️ READ OFF THE BRIEF, NOT OFF AN OPTION, AND THAT IS THE WHOLE POINT. It was an option for
    // one commit and the option was wrong: `runStudioGeneration` replays `stored.brief` and passes
    // no caller options, so a last frame that reached the QUOTE through PreviewOptions was gone by
    // the time the money moved — she would approve a Kling bridge and be billed for an ordinary
    // clip on another model. On the brief, the quoted job and the run job are the same object by
    // construction rather than by a caller remembering to re-send something.
    //
    // ⚠️ STORED FORM HERE. `runGeneration` swaps in the resolved ref exactly as it does for the
    // array; a preview must not carry a signed url. `slot: "frame"` is what it IS rather than where
    // it sorts — `lastFrame` is read by the video branch alone and never joins SLOT_ORDER
    // (studio/types.ts), so it cannot move an image golden.
    // PR 19: the planned window, on a crop alone — every other task's inputs are byte-identical.
    ...(cropWindow ? { crop: cropWindow } : {}),
    ...(isVideo && brief.job.lastFrame
      ? {
          lastFrame: {
            kind: "url",
            url: brief.job.lastFrame.ref,
            slot: "frame",
            label: "the frame to arrive at",
          } as ImageRef,
        }
      : {}),
    // ─── THE PIXELS A PER-TOKEN VIDEO SKU CANNOT BE QUOTED WITHOUT ─────────────────────────────
    //
    // Null for every shot that does not need them, which is every one that bills per SECOND — so
    // an identity clip's inputs are byte-identical to what they were before shot routing existed.
    // For b-roll they are load-bearing: seedance bills per_video_token, both halves of that quote
    // are functions of the output's size (studio/pricing.ts: "a request that names no size cannot
    // be priced at all"), and spendCaps REFUSES an unpriced quote. Without these two numbers a
    // b-roll segment is not cheap, it is impossible.
    //
    // ⚠️ THE SAME TWO NUMBERS REACH THE WIRE. studio/adapters/openrouter.ts sends
    // `size: "${width}x${height}"` when both are present, so the size that picks the price tier is
    // the size the request buys — by construction rather than by agreement.
    ...(videoSize ?? {}),
  };

  // The caller's own parameters are spread LAST so an explicit choice beats our default — the same
  // precedence the vertex adapter uses when it builds the request body.
  const providerParams = isVideo
    ? {
        ...(opts.providerParams ?? {}),
        parameters: {
          generateAudio: wantsSound,
          ...((opts.providerParams?.parameters as object) ?? {}),
        },
      }
    : crops
      ? // THE DERIVED SIZE WINS, and this is the one place in this function where the caller does
        // NOT get the last word. Everywhere else an explicit parameter beats our default, which is
        // right for knobs that only change the picture. `imageSize` is not one of those: it is what
        // studio/pricing turns into the quoted figure AND what decides whether the returned patch is
        // large enough for the paste-back. A caller silently moving it would decouple the crop plan
        // from the render and the quote from the spend at the same time. It is derived from the
        // frozen brief, so it is the same value on both sides of the approval by construction.
        {
          ...(opts.providerParams ?? {}),
          ...imageSizeParams(editImageSizeFor(crops)),
        }
      : native.kind === "native"
        ? // THE FROZEN TIER WINS, on the same argument as the crop-derived size above: it is what
          // pricing turns into the figure she approved. It was frozen with her intent, so the size
          // that runs is the size she was quoted even if the sizing rule moves in between.
          {
            ...(opts.providerParams ?? {}),
            ...imageSizeParams(native.intent.imageSize),
          }
        : opts.providerParams;

  // quality-scrappy piece 8: every image call a model is sent has a key now — the generate's, the masked edit's, and
  // each native edit's by operation, compound or ad (templates/resolve.ts). A crop, and a brief whose intent cannot
  // run, have none.
  const templateKey =
    videoPromptResult && !isPromptRefusal(videoPromptResult)
      ? `studio.video.${videoPromptResult.template}`
      : !isVideo &&
          (task === "image.generate" || task === "image.edit") &&
          native.kind !== "invalid"
        ? imageTemplateKey(
            brief,
            native.kind === "native" ? native.intent : null,
          )
        : null;

  return {
    task,
    inputs,
    references,
    blocker,
    referenceBlockers,
    providerParams,
    crops,
    shotType,
    templateKey,
    /**
     * Where this clip goes, resolved from its shot type.
     *
     * ⚠️ studio/videoRunner.ts DELIBERATELY IGNORES THIS. It re-derives inputs from the frozen brief
     * but takes provider and model OFF THE ROW, because config answers "what would we do now" and
     * the row answers "what did we commit to then" — and a job already in flight only ever wants
     * the second question. Returned here for the PREVIEW, which is the moment the commitment is
     * made.
     */
    videoRoute,
  };
}

/**
 * A clip length the model cannot serve is a BLOCKER, not a provider error — and it has to be caught
 * HERE, at the check, rather than at the call.
 *
 * ─── WHY THE PLACEMENT IS THE WHOLE POINT ───────────────────────────────────────────────────────
 *
 * Veo on Vertex serves 4, 6 and 8 seconds — not a range, three values. Until this existed the route
 * accepted 1..60 and the preview happily quoted a 30s clip, so an athlete could be shown a price,
 * approve it, and have Vertex refuse the request afterwards. That ordering is what makes it a spend
 * bug rather than a validation nicety: `consumePreview` burns her approval BEFORE the provider call,
 * so a duration that can never run would consume the approval and then fail — and the re-run costs
 * her a fresh check for a number nothing ever told her was impossible.
 *
 * Refusing at the check means the impossible duration is never quoted, never approved and never
 * consumed. An unverified model (`supportedDurationsFor` -> null) is left alone rather than guessed
 * at: refusing a length we simply have not checked would be inventing a limit.
 */
function durationBlockers(
  task: GenerationTask | null,
  inputs: GenerationInputs,
  /** The model this clip is ACTUALLY routed to. Falls back to the task route for a caller with none. */
  model?: string,
): BriefGap[] {
  if (task !== "video.generate" || inputs.durationSeconds === undefined)
    return [];
  const allowed = supportedDurationsFor(
    model ?? routeFor("video.generate").model,
  );
  if (!allowed || allowed.includes(inputs.durationSeconds)) return [];
  const list =
    allowed.length > 1
      ? `${allowed.slice(0, -1).join(", ")} or ${allowed[allowed.length - 1]}`
      : String(allowed[0]);
  return [
    routingBlocker(
      "durationSeconds",
      `This model can only make clips of ${list} seconds — ${inputs.durationSeconds}s isn't one of them. ` +
        "Pick one of those lengths and check the cost again.",
    ),
  ];
}

/**
 * A clip we could not STORE must not be generated.
 *
 * `storeAsset` inherited mediaStore's 25 MB stills cap, so an oversized clip failed with "over the
 * media size cap" — after the provider had been paid and the approval consumed. Video now has its
 * own ceiling (`maxVideoBytes`), and this refuses at the CHECK anything projected to exceed it, on
 * the same principle as the duration blocker above: a job that cannot possibly land should never be
 * quoted, approved or consumed.
 *
 * The projection is an assumption (`videoBytesPerSecond`, measured off the spike and rounded up) and
 * errs high, which can only refuse early rather than overspend. At today's 8s ceiling it cannot
 * fire — see the note on that constant for why it is still worth having.
 */
function sizeBlockers(
  task: GenerationTask | null,
  inputs: GenerationInputs,
): BriefGap[] {
  if (task !== "video.generate" || !inputs.durationSeconds) return [];
  const projected = inputs.durationSeconds * videoBytesPerSecond();
  if (projected <= maxVideoBytes()) return [];
  const mb = (n: number) => Math.round(n / (1024 * 1024));
  return [
    routingBlocker(
      "durationSeconds",
      `A ${inputs.durationSeconds}s clip would be around ${mb(projected)}MB, over the ${mb(maxVideoBytes())}MB ` +
        "we can store. Make it shorter and check the cost again.",
    ),
  ];
}

// ─── previewGeneration ──────────────────────────────────────────────────────────────────────────

/**
 * Is this gap answered by the brief's own frozen intent? Exactly one case: an edit with no regions,
 * on a brief whose native intent needs none — an add (PR C′), whose thing is not in the frame to be
 * bounded. assembleBrief raises the gap for every region-less edit, on the premise that one
 * "degrades into a full re-render"; for an add, one full-frame call is the operation.
 *
 * Since composition, also a composed sentence none of whose clauses names a thing in the frame — an
 * add beside a background, a background beside a look. Detection was not asked (decision 3), and
 * every change compiles from the classifier's words alone (studio/nativeEdit.ts, `isRegionFree`).
 *
 * ⚠️ READ OFF THE BRIEF ON EVERY CALL, NEVER BAKED IN. The gap stays on the brief, so the preview and
 * the generate leg each decide the waiver from the frozen intent they are holding. A brief whose
 * intent went missing blocks on this gap again — it does not quietly run her sentence as the full
 * re-render the gap exists to stop.
 */
function waivedByIntent(gap: BriefGap, read: NativeIntentRead): boolean {
  return (
    gap.field === NO_EDIT_REGIONS_FIELD &&
    read.kind === "native" &&
    isRegionFree(read.intent)
  );
}

/**
 * What would run, what it would cost, and whether we may. No network, no spend, no writes.
 *
 * Returns a verdict rather than throwing: every refusal here is one a person needs to READ.
 */
export function previewGeneration(
  brief: CreativeBrief,
  opts: PreviewOptions = {},
): GenerationPreview {
  // THE RESOLUTION NOTE, on a native edit only: she is told BEFORE she pays that the edit comes back
  // smaller than her photo (PR N, N.3 — studio/nativeEdit.ts). Derived from the frozen brief like
  // everything else here, and `degraded`, never blocking: it is information, not a refusal.
  const nativeRead = readNativeIntent(brief);
  const resolutionNote =
    nativeRead.kind === "native" && brief.job.source
      ? nativeResolutionNote(nativeRead.intent, brief.job.source)
      : null;
  // An add with no object photo still routes, and the model invents the thing — she is told, beside
  // the built-from strip, that nothing of hers is being placed (C′, C.3).
  const inventedNote =
    nativeRead.kind === "native" ? inventedObjectNote(nativeRead.intent) : null;
  // …and when her PRODUCT photo is the thing an add places (C3), that is said too, before she pays: the
  // freeze assumed it, and a photo of something else would otherwise be found only in the render.
  const placedNote =
    nativeRead.kind === "native"
      ? placedProductNote(brief, nativeRead.intent)
      : null;
  // …and when a MOVE's thing was taken by elimination rather than by name (F-WB5 (d)), that assumption
  // is said too: detection found one region and confirmed no noun, so the freeze used it. She can see
  // the region drawn; this names it in words and gives her the action that changes it.
  const assumedMove =
    nativeRead.kind === "native" ? assumedMoveNote(nativeRead.intent) : null;
  // A brand change that dropped words she typed — a model name — says so before she pays (B.1c).
  const droppedNote =
    nativeRead.kind === "native" ? droppedWordsNote(nativeRead.intent) : null;
  // A look of hers beside "keep me as I am" covers her too — said before she pays (the interpreter, I.1;
  // M6). Only a version 2 intent carries the constraint, so every earlier preview is unchanged.
  const lookNote =
    nativeRead.kind === "native" ? lookCoversHerNote(nativeRead.intent) : null;
  const warnings: BriefGap[] = [
    ...brief.gaps.filter((g) => g.severity === "degraded"),
    ...(resolutionNote
      ? [
          {
            field: "job.source",
            note: resolutionNote,
            severity: "degraded" as const,
          },
        ]
      : []),
    ...(inventedNote
      ? [
          {
            field: "job.references",
            note: inventedNote,
            severity: "degraded" as const,
          },
        ]
      : []),
    ...(placedNote
      ? [
          {
            field: "job.references",
            note: placedNote,
            severity: "degraded" as const,
          },
        ]
      : []),
    ...(assumedMove
      ? [
          {
            field: "job.source",
            note: assumedMove,
            severity: "degraded" as const,
          },
        ]
      : []),
    ...(droppedNote
      ? [
          {
            field: "job.direction",
            note: droppedNote,
            severity: "degraded" as const,
          },
        ]
      : []),
    ...(lookNote
      ? [
          {
            field: "job.direction",
            note: lookNote,
            severity: "degraded" as const,
          },
        ]
      : []),
  ];
  const {
    task,
    inputs,
    references,
    blocker,
    referenceBlockers,
    providerParams,
    crops,
    videoRoute,
  } = plannedInputs(brief, opts);

  const blockers: BriefGap[] = [
    ...blockingGaps(brief).filter((g) => !waivedByIntent(g, nativeRead)),
    ...(blocker ? [blocker] : []),
    ...referenceBlockers,
    // AGAINST THE ROUTED MODEL, not against the task's default one. Veo serves 4/6/8 seconds and
    // seedance-fast serves 4..15, so checking a b-roll clip against Veo's list would refuse a 5s
    // segment the provider it is actually going to would have served.
    ...durationBlockers(task, inputs, videoRoute?.model),
    ...sizeBlockers(task, inputs),
  ];

  let plan: GenerationPlan | null = null;
  let cost: EstimatedCost | null = null;
  if (task) {
    try {
      // ─── THE DERIVED ROUTE WINS, and this is the same rule `imageSizeParams` states above ────
      //
      // Everywhere else an explicit option beats our default, which is right for knobs that only
      // change the picture. A video route is not one of those: it is what studio/pricing turns into
      // the quoted figure AND what the job row is written from. A caller silently moving it would
      // decouple the quote from the spend and the plan from the row at the same time.
      //
      // The ENV escape hatch survives untouched — `videoRouteFor("identity")` IS
      // `routeFor("video.generate")`, so STUDIO_VIDEO_PROVIDER and STUDIO_VIDEO_MODEL still move it.
      plan = estimate(task, inputs, {
        ...opts,
        providerParams,
        ...(videoRoute ?? {}),
      });
      // ONE CALL PER REGION. `estimate` quotes a single image; a three-region edit runs three of
      // them, so the figure she approves has to be the total or she is approving a third of what she
      // is about to spend. Scaled HERE rather than through `inputs.n` — see scaleCost's note for why
      // the obvious version poisons the cost log.
      if (crops && crops.length > 1)
        plan = { ...plan, cost: scaleCost(plan.cost, crops.length) };
      cost = asEstimated(plan.cost);
    } catch (err) {
      // A routing failure (no provider, unsupported task, bad input) is a refusal the athlete should
      // see, not a stack trace. Everything else — including our own basis guarantee — still throws.
      if (err instanceof GenerationError && err.code !== "provider_error") {
        blockers.push(
          routingBlocker(
            "job",
            `This cannot be routed to a model: ${err.message}`,
          ),
        );
      } else {
        throw err;
      }
    }
  }

  // ─── THE TARGET MANIFEST'S CHECK (quality-scrappy piece 1, behind STUDIO_DIALECTS) ─────────────────
  //
  // A compiled payload never carries a parameter its target does not accept (compile/targets/manifest.ts). Asked
  // HERE, against the plan's resolved (model, provider) — the pair the job row is written from — so it refuses at the
  // quote, before an approval exists, rather than at the provider after one was spent. A target the manifest does not
  // describe is not judged: refusing everything unlisted would refuse the fal mask and the local crop for nothing.
  if (plan && dialectsEnabled()) {
    const target = targetFor(plan.model, plan.provider);
    const asked = target
      ? payloadViolations(
          target,
          payloadOf(inputs, providerParams, plan.provider),
        )
      : [];
    if (asked.length)
      blockers.push(
        routingBlocker(
          "job",
          `This asks ${plan.model} for something it doesn't take: ${asked.join(", ")}. ` +
            "Change the request and check the cost again.",
        ),
      );
  }

  const canGenerate = blockers.length === 0 && plan !== null;
  const preview: GenerationPreview = {
    previewId: randomUUID(),
    createdAt: new Date().toISOString(),
    status: canGenerate ? "ready" : "blocked",
    brief,
    plan,
    references,
    cost,
    unpriced: cost?.unpriced === true,
    blockers,
    warnings,
    verdict: {
      canGenerate,
      headline: canGenerate ? "Ready to generate" : "Can't generate yet",
      reason: blockers[0]?.note ?? null,
    },
  };

  logger.info(
    {
      previewId: preview.previewId,
      athleteId: brief.athlete.athleteId,
      mode: brief.job.mode,
      task,
      status: preview.status,
      blockers: blockers.length,
      warnings: warnings.length,
      costUsd: cost?.amountUsd ?? null,
      unpriced: preview.unpriced,
    },
    "generation preview",
  );
  return preview;
}

// ─── runGeneration ──────────────────────────────────────────────────────────────────────────────

/**
 * Generate, but only if the brief still allows it.
 *
 * The gate is RE-DERIVED here rather than taken on trust from a preview. That is the whole point of
 * this function existing: it is the last thing between a brief and a billable call, so it must not
 * depend on a caller having done the right thing earlier.
 */
export async function runGeneration(
  brief: CreativeBrief,
  opts: PreviewOptions = {},
): Promise<GenerationResult> {
  const preview = previewGeneration(brief, opts);
  if (preview.status === "blocked" || !preview.plan) {
    const why = preview.blockers
      .map((b) => `${b.field}: ${b.note}`)
      .join(" | ");
    throw new GenerationError(
      `Refusing to generate — ${preview.blockers.length} blocking gap(s). ${why}`,
      "invalid_input",
    );
  }

  const { task, inputs, references, providerParams, videoRoute } =
    plannedInputs(brief, opts);
  // Resolve stored refs into something a provider can actually read. The default pass-through is
  // correct for brand imagery (real urls) and wrong for a GCS path, which is why a caller generating
  // from owned media has to supply a resolver.
  //
  // THE SLOT IS RE-ATTACHED HERE, AND THAT LINE IS LOAD-BEARING. A resolver is caller-supplied and
  // knows nothing about roles — it turns a path into bytes or a signed url and returns a bare
  // ImageRef. Taking its return value as-is would drop `slot` on the one path that actually
  // generates, which is precisely the flattening this work exists to fix, re-introduced at the last
  // possible moment. The PLANNER owns the slot, so the planner puts it back.
  const resolveRef =
    opts.resolveReference ??
    ((r: PlannedReference): ImageRef => ({ kind: "url", url: r.ref }));
  const resolved = await Promise.all(
    references.map(
      async (r): Promise<ImageRef> => ({
        ...(await resolveRef(r)),
        slot: r.slot,
        label: r.label,
      }),
    ),
  );

  // ─── ⚠️  THE LAST FRAME IS RESOLVED TOO, AND IT IS NOT IN THAT ARRAY ─────────────────────────
  //
  // `lastFrame` is deliberately its own field rather than a fifth slot (studio/types.ts), which
  // means the `references.map` above does not touch it. Spreading `...inputs` on its own would
  // therefore hand the adapter the STORED ref — a `gs://` path or a bare GCS key — as though it
  // were a url.
  //
  // ⚠️ THAT FAILS *AFTER* THE MONEY. The request is accepted and billed, and the provider then
  // cannot read the frame: it refuses, or it silently makes an ordinary image-to-video clip with
  // no destination and we pay for something labelled as a transition that is not one. This is the
  // `unsigned_urls` class exactly — that one cost seven billed Seedance clips because the url
  // looked like it needed no credential, and this one looks like a resolved reference.
  //
  // Resolved through THE SAME resolver, not a second copy of it: whatever a caller does to sign or
  // fetch a reference is by construction what happens to the frame the clip must arrive at. The
  // role is `source-frame` because that is what it is — a frame of hers, not a likeness ref — and
  // `slotFor` maps it to `frame`, which is the slot it is stamped with above.
  const resolvedLastFrame = inputs.lastFrame
    ? {
        ...(await resolveRef({
          role: "source-frame",
          ref: (inputs.lastFrame as { url?: string }).url ?? "",
          label: inputs.lastFrame.label ?? "the frame to arrive at",
          slot: "frame",
        })),
        slot: "frame" as const,
        label: inputs.lastFrame.label ?? "the frame to arrive at",
      }
    : undefined;

  logger.info(
    {
      previewId: preview.previewId,
      athleteId: brief.athlete.athleteId,
      task,
      quotedUsd: preview.cost?.amountUsd,
    },
    "generation approved by pre-check — calling the router",
  );
  return generate(
    task!,
    {
      ...inputs,
      references: resolved,
      // Only when there is one — `{ lastFrame: undefined }` is a different object from one with no
      // such key, and the adapters test `if (inputs.lastFrame)`, so an explicit undefined would be
      // harmless here and confusing in a log.
      ...(resolvedLastFrame ? { lastFrame: resolvedLastFrame } : {}),
    },
    // ─── ⚠️  THE ROUTE THE QUOTE PRICED, SPREAD LAST — THE SAME LINE `previewGeneration` HAS ────
    //
    // `previewGeneration` spreads the shot type's route into `estimate`, so a b-roll clip is quoted
    // on seedance and a transition on Kling. This call used to pass `{ ...opts, providerParams }`
    // and nothing else, so `generate` re-resolved through the DEFAULT video route — Veo — and the
    // run spent on a model the quote never priced. Measured, not reasoned: the clip-audio probe
    // quoted seedance and then failed on Veo's duration list ("supported durations are [8,4,6]").
    //
    // The product's video path never reached this — /studio/generate queues video, and the runner
    // reads provider and model OFF THE JOB ROW — so this closes a trap rather than a live charge.
    // An image task carries no video route, so its call is unchanged.
    { ...opts, providerParams, ...(videoRoute ?? {}) },
  );
}
