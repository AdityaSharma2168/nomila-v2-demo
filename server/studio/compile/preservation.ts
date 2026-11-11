/**
 * studio/compile/preservation — the preservation clause, as one managed block.
 *
 * ─── RESTYLE IS ACCEPTED; THE PRESERVATION CLAUSE IS REQUIRED AND UNVALIDATED ────────────────────
 *
 * Q5L's full-frame cells applied every colour and restyled every garment, differently each run. Adi
 * accepted that as what a native edit does — an explicit decision, recorded in the memo, and not a
 * pass. They also visibly shifted the scene's lighting, and they ran WITHOUT the clause below. So the
 * clause goes on every compiled prompt, and nothing has measured it yet: sweep #2 does.
 */
import type { EditOperation } from "../classify";
import { listOf } from "./text";

/**
 * THE PRESERVATION CLAUSE — the scene properties a native edit must keep unless her request is
 * itself ABOUT them. REQUIRED-BUT-UNVALIDATED: see the header, and the memo's Routing decision.
 *
 * A named constant because it is the seed template the Creative Director (PR CD) inherits, and a
 * clause that lives only inside a string builder is one nobody can find to change deliberately.
 *
 * `waivedBy` is "unless the request specifies otherwise", made concrete per operation: a grade
 * ("black and white", "golden hour", "more contrast") is a request to change the light and the
 * colour, and a background change is a request to change the scene. Everything else she can ask for
 * changes a THING, and the light it sits in stays.
 *
 * A headline (DISPLAY_TEXT, PR T) waives nothing: it is written onto the photograph she has, in its light.
 */
type SceneProperty =
  | "lighting"
  | "exposure"
  | "contrast"
  | "colour grade"
  | "scene";

export const NATIVE_PRESERVATION: {
  readonly properties: readonly SceneProperty[];
  readonly waivedBy: Readonly<
    Partial<Record<EditOperation, readonly SceneProperty[]>>
  >;
} = {
  properties: ["lighting", "exposure", "contrast", "colour grade", "scene"],
  waivedBy: {
    GLOBAL_STYLE: ["lighting", "exposure", "contrast", "colour grade"],
    CHANGE_BACKGROUND: ["scene"],
    // PR 19: a relight changes the light and what it does to the picture; a camera move shows the scene anew.
    RELIGHT: ["lighting", "exposure", "contrast", "colour grade"],
    CAMERA: ["scene"],
  },
};

/** The preservation sentence for these operations, or null when every property is waived. */
export function preservationClause(
  ops: readonly EditOperation[],
): string | null {
  const waived = new Set(
    ops.flatMap((op) => NATIVE_PRESERVATION.waivedBy[op] ?? []),
  );
  const kept = NATIVE_PRESERVATION.properties.filter((p) => !waived.has(p));
  if (!kept.length) return null;
  return `Keep the original photograph's ${listOf(kept)} exactly as ${kept.length === 1 ? "it is" : "they are"}.`;
}
