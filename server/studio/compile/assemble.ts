/**
 * studio/compile/assemble — the clauses, in order, as one instruction; and the instruction, with what
 * must travel beside it, as the prompt a native edit sends.
 *
 * ─── THE INSTRUCTION COMES FROM THE INTENT, NEVER FROM HER SENTENCE ──────────────────────────────
 *
 * Every gate on this path — the person guard, ASK, the generate gate — decides on the CLASSIFIED
 * intent. If the raw sentence reached the model, the model could act on any part of it no gate
 * sanctioned. So the prompt is a function of the frozen intent alone: an operation, a target the
 * classifier extracted, and a change string whose provenance studio/nativeIntent.ts writes down.
 * `direction.statement` is not read anywhere in this file.
 *
 * ─── MULTI-PART INTENTS COMPILE INTO ONE CALL — THE DESIGN, NOT A SETTLED CAPABILITY ─────────────
 *
 * Two changes are two clauses of one instruction and one call. What stands behind that is the
 * probe's Q3: two favourable n=1 cells, which is a reason to try it and not evidence that it works.
 * Sweep #2 settles one-call compound editing, or brings PR D″'s orchestrator back. Nothing here
 * assumes the answer.
 *
 * ─── THE ORDER IS THE FROZEN INTENT'S ───────────────────────────────────────────────────────────
 *
 * The clauses are compiled in the order of `intent.changes`, and nothing here re-orders them. That
 * order is this module's rule (order.ts, `sceneLast` — composition's decision 5), applied when the
 * intent is frozen: every change to a thing in step order, then the background, then a headline, then a
 * look.
 */
import type { CreativeBrief } from "../brief";
import type { FrozenEditIntent, NativeChange } from "../nativeEdit";
import type { PlannedReference } from "../preview";
import { constraintDoNots, constraintKeepSentences } from "./constraints";
import {
  NATIVE_FRAME_LINE,
  objectImageNumber,
  placedPhoto,
  referenceManifest,
} from "./manifest";
import { preservationClause } from "./preservation";
import {
  ADD_FRAMING_LINE,
  clauseFor,
  placedAdds,
  type NativeAddressing,
} from "./templates";
import { fenced } from "./fence";
import {
  canvasSentence,
  exactTextLine,
  FRAME_ROLE_LINE,
  type GeminiImageDialect,
} from "./geminiDialect";
import { renderableStyle, styleBlock, styleSpecOf } from "./style";
import { listOf } from "./text";
import { correctiveBlock } from "../gateVocab";
import { registryTemplateOn, renderTemplate } from "../templates/render";
import { imageTemplateKey } from "../templates/resolve";

/**
 * What the instruction confines the change to — the "change only X" half of Q5's prompt.
 *
 * Q5's exact wording for a region, Q2's for a background ("keep the person exactly as-is"), and a
 * whole-frame look keeps the content and changes only the look.
 */
/**
 * PR 19's two whole-frame operations each promise their own scope — without an arm here they fell through to
 * "change only ." (an empty list). L-A's keep sentence for a relight (docs/probes/image-ops.md, LIGHT-1), and R-13's
 * for a camera move: her pose unchanged, which CAM-1's rubric checks.
 */
export const RELIGHT_SCOPE =
  "Change only the light — its direction, colour and softness, and the highlights and shadows it casts on the " +
  "person and the scene. Keep the person's face, pose and clothing and everything in the frame exactly where and " +
  "what it is, and keep the framing exactly as it is.";
/** A crop changes no pixel it keeps (S-7). */
export const CROP_SCOPE =
  "Keep every pixel inside the crop exactly as it is — only the frame is cut.";
export const CAMERA_SCOPE =
  "Keep the person's face, pose, expression and clothing, and the place, exactly as they are — change only where " +
  "the camera is.";

function scopeClause(changes: readonly NativeChange[]): string {
  if (changes.length === 1 && changes[0].op === "RELIGHT") return RELIGHT_SCOPE;
  if (changes.length === 1 && changes[0].op === "CAMERA") return CAMERA_SCOPE;
  if (changes.length === 1 && changes[0].op === "CROP") return CROP_SCOPE;
  const named = [
    ...new Set(
      changes.filter((c) => c.target !== null).map((c) => `the ${c.target}`),
    ),
  ];
  const background = changes.some((c) => c.op === "CHANGE_BACKGROUND");
  const look = changes.some((c) => c.op === "GLOBAL_STYLE");
  const added = changes.flatMap((c) => (c.add ? [`the ${c.add.thing}`] : []));
  // A headline is added too — the banner its clause asks for (PR T) — so it is scoped as an add is: alone
  // it is "only add the banner", and beside a change it is "the added banner", after the background.
  const banner = changes.some((c) => c.op === "DISPLAY_TEXT");
  // PR 19: the ad's brand logo is added the same way — "only add the logo", or "the added logo" beside a change.
  const logo = changes.some((c) => c.op === "BRAND_MARK");
  const adding = [
    ...added,
    ...(banner ? ["the banner"] : []),
    ...(logo ? ["the logo"] : []),
  ];

  // An add changes nothing that is already there, so "change only" would be the wrong promise: the
  // only difference in the output should be the thing that was not in the frame before.
  if (adding.length && !background && !look && !named.length) {
    return `Keep everything else exactly as-is — only add ${listOf(adding)}.`;
  }
  // ⚠️ `!adding.length` in both of these since composition: an add beside a background ("add a soccer
  // ball at her feet and change the background to a stadium") would otherwise be told "change only
  // the background" — a scope sentence contradicting the instruction before it. Alone, a background
  // or a look keeps Q2's and N's words exactly.
  if (background && !look && !named.length && !adding.length) {
    return "Keep the person exactly as-is — change only the background.";
  }
  if (look && !background && !named.length && !adding.length) {
    return "Keep everything in the photograph exactly where and what it is — change only its overall look.";
  }
  return `Keep everything else exactly as-is — change only ${listOf([
    ...named,
    ...added.map((a) => a.replace(/^the /, "the added ")),
    ...(background ? ["the background"] : []),
    ...(banner ? ["the added banner"] : []),
    ...(logo ? ["the added logo"] : []),
    ...(look ? ["the overall look"] : []),
    // PR 19: never alone here (the arms above take a lone one), and named if a compound ever carries one.
    ...(changes.some((c) => c.op === "RELIGHT") ? ["the light"] : []),
    ...(changes.some((c) => c.op === "CAMERA")
      ? ["the camera's position"]
      : []),
  ])}.`;
}

/**
 * The framing line, when a change puts something AT A PLACE — `templates.ts`, `ADD_FRAMING_LINE`.
 *
 * Its own sentence after the preservation clause rather than a word inside it: the clause is shared by
 * every operation and 29 of the 30 renders 1a measured hold their frame without a line, so this one
 * belongs to the one operation that measurably does not. One line however many adds a compound carries
 * — it is a fact about the frame, not about each thing going into it.
 */
function framingClause(changes: readonly NativeChange[]): string | null {
  return placedAdds(changes).length ? ADD_FRAMING_LINE : null;
}

/**
 * The instruction a native edit sends, from the frozen intent and nothing else.
 *
 * For "make the shorts black and green" with detection's label "black and green shorts", the first
 * two sentences are Q5's measured prompt VERBATIM — "make the shorts black and green. Keep everything
 * else exactly as-is — change only the shorts." — and the preservation clause follows. That is
 * pinned in nativeEdit.test.ts, because it is what makes sweep #2 a measurement of the same prompt
 * the probe accepted plus exactly one new sentence.
 *
 * A version 2 intent's `preserve_person` adds ONE keep sentence after the preservation clause
 * (compile/constraints.ts). A version 1 intent adds nothing, so every earlier prompt is byte-identical.
 *
 * A PLACED ADD adds one more sentence after the preservation clause — the framing line (wave B,
 * addition (a); templates.ts has what measured it). Every prompt that carries no placed add, which is
 * every recolour, removal, background, look, headline and worn add, is byte-identical to main's.
 */
export function compileNativeInstruction(
  intent: FrozenEditIntent,
  addressing: NativeAddressing = {},
): string {
  return Object.values(nativeInstructionPieces(intent, addressing))
    .filter(Boolean)
    .join(" ");
}

/**
 * The instruction's sentences, NAMED and in the order the instruction joins them (quality-scrappy piece 8) — what a
 * published template positions (templates/render.ts, NATIVE_EDIT). An absent one is "".
 *
 * The Gemini image dialect's two (piece 7), when buildNativePrompt passes it: the exact text a headline adds, straight
 * after the clause that adds it (rule 5, ours), and the shape the photograph keeps, last among the keeps (rule 3).
 */
function nativeInstructionPieces(
  intent: FrozenEditIntent,
  addressing: NativeAddressing,
) {
  const dialect = addressing.dialect;
  return {
    clause: `${intent.changes.map((c) => clauseFor(c, addressing)).join(", and ")}.`,
    text: (dialect && exactTextLine(intent.changes)) || "",
    scope: scopeClause(intent.changes),
    preservation: preservationClause(intent.changes.map((c) => c.op)) ?? "",
    framing: framingClause(intent.changes) ?? "",
    keep: constraintKeepSentences(intent).join(" "),
    aspect: (dialect && canvasSentence(dialect.aspect, "edit")) || "",
  };
}

/**
 * The prompt a NATIVE edit sends — the compiled instruction, and only what must travel with it.
 *
 * Deliberately much less than `buildPrompt` (studio/preview.ts). What that function carries for an
 * edit is either about the masked path (the crop and its coordinates, a frame line promising the
 * pixels outside a region) or is art direction (the brand's tone, palette and do's), and on a
 * full-frame call art direction restyles the whole photograph rather than one crop — the untested gap
 * the memo's Routing decision names. What stays:
 *
 *   • the reference manifest, when there is more than the frame. With the frame alone there is nothing
 *     to address — Q5 sent no manifest — and with an object or a product it is what tells the model
 *     which image is which (studio/refOrder.ts);
 *   • the compiled instruction, from the frozen intent alone (above);
 *   • the brand's DO NOTs — constraints rather than direction, and the ones that keep a competitor's
 *     mark off a sponsor's job. A version 2 intent's `exclude_marks` joins them on the same line
 *     (compile/constraints.ts), or stands as the line alone when no brand is attached.
 *
 * No `GOAL:`, no `DIRECTION:`. Her sentence reaches the model only through the classified intent.
 */
export function buildNativePrompt(
  brief: CreativeBrief,
  references: PlannedReference[],
  intent: FrozenEditIntent,
  /** The Gemini image dialect (quality-scrappy piece 7) — studio/preview.ts passes it only for that model. */
  dialect: GeminiImageDialect | null = null,
): string {
  const pieces = nativePieces(brief, references, intent, dialect);
  const literal = [
    pieces.references,
    [
      pieces.clause,
      pieces.text,
      pieces.scope,
      pieces.preservation,
      pieces.framing,
      pieces.keep,
      pieces.aspect,
    ]
      .filter(Boolean)
      .join(" "),
    pieces.style,
    pieces.donts,
  ]
    .filter(Boolean)
    .join("\n\n");
  // quality-scrappy piece 5: a re-quote's fix, last — as buildPrompt closes with it. It was missing here, so a native
  // edit's re-quote after a failed gate ran the prompt that had just failed. No corrective, nothing added.
  const fix = correctiveBlock(brief.job.corrective);
  const withFix = (p: string) => (fix ? `${p}\n\n${fix}` : p);
  // quality-scrappy piece 8: a published template for this edit, when one was frozen onto the brief at the quote — it
  // positions the same pieces and may name the headline's face (meta.font). Else, and on any envelope it cannot use,
  // the literal. The clause stays the code's: a row can move it and never reword it (ADI-QS-5 (4)).
  const key = imageTemplateKey(brief, intent);
  const frozen = key ? registryTemplateOn(brief.job.template, key) : null;
  const published =
    key && frozen
      ? renderTemplate(frozen, key, (meta) =>
          nativePieces(
            brief,
            references,
            intent,
            dialect && meta.font ? { ...dialect, font: meta.font } : dialect,
          ),
        )
      : null;
  return withFix(published ? published.prompt : literal);
}

/**
 * The native prompt's pieces, NAMED (quality-scrappy piece 8): what the literal above joins, and what a published
 * template (templates/render.ts, NATIVE_EDIT) positions.
 */
function nativePieces(
  brief: CreativeBrief,
  references: PlannedReference[],
  intent: FrozenEditIntent,
  dialect: GeminiImageDialect | null,
) {
  // Rule 1 of the dialect: the frame alone was the one image no line named. With more than the frame, the manifest
  // below already gives every image its one job.
  let refs = "";
  if (dialect && references.length === 1 && references[0].slot === "frame")
    refs = FRAME_ROLE_LINE;
  if (references.length > 1) {
    // Her Product photo, when an add places it (C3), reads the Object line — it is a thing to put in the frame.
    const placed = placedPhoto(brief, intent);
    refs =
      referenceManifest(
        brief,
        references,
        NATIVE_FRAME_LINE,
        placed?.role === "product" ? placed.ref : undefined,
      ) ?? "";
  }
  // A style reference drives the look only through a GLOBAL_STYLE change (PR 18). referencesFor refuses one on an
  // edit that changes no look, so a spec with no look to drive is never reached here; it would render nothing.
  const spec = styleSpecOf(brief);
  const styleLook =
    !!spec &&
    renderableStyle(spec) &&
    intent.changes.some((c) => c.op === "GLOBAL_STYLE");
  const instruction = nativeInstructionPieces(intent, {
    objectImage: objectImageNumber(brief, references, intent),
    ...(styleLook ? { styleLook: true } : {}),
    ...(dialect ? { dialect } : {}),
  });
  const block = styleLook && spec ? styleBlock(spec, "edit") : null;
  // The brand's DO NOTs are its research, web-derived: FENCED, verbatim (ADI-24SEP R1, PR 16 K1). Our own
  // constraint DO NOTs (exclude_marks) are instructions we wrote, and stay outside every fence. ⚠️ MUTATION
  // (compile/fences.test "a fenced field is concatenated into an instruction").
  const donts = [
    ...(brief.brand?.donts ?? []).map(fenced),
    ...constraintDoNots(intent),
  ];
  return {
    references: refs,
    ...instruction,
    style: block ?? "",
    donts: donts.length ? `DO NOT: ${donts.join("; ")}.` : "",
  };
}
