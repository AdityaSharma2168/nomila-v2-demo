/**
 * templates/resolve — which registry template an image brief compiles from (quality-scrappy pieces 8 and 9). Rules only,
 * no database, no model, no embeddings: the frozen brief decides, so the quote and the run name the same key by
 * construction. Piece 8 is the base key; piece 9 (`resolveTemplate`) the variants a published row may be written for.
 *
 *   a generate                         studio.image.generate
 *   an edit with no frozen intent      studio.image.edit.masked      (a box she drew — compile/image.ts's edit arm)
 *   a native edit the ad treatment     studio.image.edit.ad          (the interpreter read a treatment in her words)
 *     wrote
 *   a native edit of two or more       studio.image.edit.compound
 *     changes
 *   a native edit of one change        studio.image.edit.<operation>
 *   a crop                             none — it is cut in-process and never sent to a model
 */
import type { CreativeBrief } from "../brief";
import type { EditOperation } from "../classify";
import type { FrozenEditIntent } from "../nativeEdit";
import type { RegistryTemplateKey } from "./render";

/** One template per operation a model is sent. GENERATE is not an edit; CROP is never sent. */
export const NATIVE_OP_KEYS: Readonly<
  Record<Exclude<EditOperation, "GENERATE" | "CROP">, RegistryTemplateKey>
> = {
  RECOLOR: "studio.image.edit.recolor",
  APPLY_DESIGN: "studio.image.edit.apply_design",
  REPLACE_OBJECT: "studio.image.edit.replace_object",
  ADD_OBJECT: "studio.image.edit.add_object",
  REMOVE_OBJECT: "studio.image.edit.remove_object",
  MOVE_OBJECT: "studio.image.edit.move_object",
  DISPLAY_TEXT: "studio.image.edit.display_text",
  CHANGE_BACKGROUND: "studio.image.edit.change_background",
  GLOBAL_STYLE: "studio.image.edit.global_style",
  RELIGHT: "studio.image.edit.relight",
  CAMERA: "studio.image.edit.camera",
  BRAND_MARK: "studio.image.edit.brand_mark",
};

/**
 * An ad: the interpreter read a TREATMENT in her sentence (interpret/core.ts allows exactly one, and only where the ad
 * gate found an ad). A typed sentence that happens to read like one is a compound — nothing marked it as an ad.
 */
export const isAdBrief = (brief: CreativeBrief): boolean =>
  !!brief.job.interpretation?.spans?.some((s) => s.reads === "treatment");

/** The base template key an image brief compiles from, or null when none applies (a crop). */
export function imageTemplateKey(
  brief: CreativeBrief,
  intent: FrozenEditIntent | null,
): RegistryTemplateKey | null {
  if (brief.job.mode === "generate") return "studio.image.generate";
  if (!intent) return "studio.image.edit.masked";
  const ops = intent.changes.map((c) => c.op);
  if (!ops.length || ops.some((op) => op === "CROP" || op === "GENERATE"))
    return null;
  if (isAdBrief(brief)) return "studio.image.edit.ad";
  if (ops.length > 1) return "studio.image.edit.compound";
  return NATIVE_OP_KEYS[ops[0] as keyof typeof NATIVE_OP_KEYS];
}

/** What the resolver read off the brief — recorded beside the key it froze, so a score can be sliced by it later. */
export interface TemplateInputs {
  /** The frozen intent's operations, or "masked" / "generate". */
  ops: string[];
  /** The ad treatment wrote this intent (`isAdBrief`). */
  ad: boolean;
  /** The reference roles attached, deduplicated, in the brief's order. */
  roles: string[];
  brand: boolean;
  /** A style reference with a reading (compile/style.ts `styleSpecOf`). */
  styleSpec: boolean;
}

/**
 * The VARIANTS a published row may be written for, most specific first — each a base key with a suffix, and each only
 * where its condition holds. A variant is rendered under its base's placeholders (templates/render.ts
 * `registryTemplateOn`), so it can say more for her case and can drop nothing the base must keep.
 */
const VARIANTS: readonly {
  suffix: string;
  holds: (i: TemplateInputs) => boolean;
}[] = [
  { suffix: "+style", holds: (i) => i.styleSpec },
  { suffix: "+brand", holds: (i) => i.brand },
  { suffix: "+product", holds: (i) => i.roles.includes("product") },
  { suffix: "+her", holds: (i) => i.roles.includes("person") },
];

/**
 * The resolver (quality-scrappy piece 9) — rules only: the keys a published row could be frozen from for this brief,
 * most specific first and the base key last, and what it read to choose them. templates/freeze.ts takes the first one
 * published; today no variant is, so every brief freezes its base key, which is today's prompt.
 */
export function resolveTemplate(
  brief: CreativeBrief,
  intent: FrozenEditIntent | null,
  base: string,
): { candidates: string[]; inputs: TemplateInputs } {
  const inputs: TemplateInputs = {
    ops: base.startsWith("studio.video.")
      ? ["clip"]
      : intent
        ? intent.changes.map((c) => c.op)
        : [brief.job.mode === "generate" ? "generate" : "masked"],
    ad: !!intent && isAdBrief(brief),
    roles: [...new Set((brief.job.references ?? []).map((r) => r.role))],
    brand: !!brief.brand,
    styleSpec: (brief.job.references ?? []).some(
      (r) => r.role === "style_reference" && !!r.style,
    ),
  };
  // Only an image template has variants; a clip's key is its template's name and stands alone.
  const candidates = base.startsWith("studio.image.")
    ? [
        ...VARIANTS.filter((v) => v.holds(inputs)).map(
          (v) => `${base}${v.suffix}`,
        ),
        base,
      ]
    : [base];
  return { candidates, inputs };
}
