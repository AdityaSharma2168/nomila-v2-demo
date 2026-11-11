/**
 * agent/onboarding/miaPreview.ts — the seam to the M.I.A. preview (a preliminary score with four groups), shown first in
 * the reveal moment.
 *
 * The implementation is services/miaPreview/preview.ts (revealMiaPreview): the existing M.I.A. evaluator run on her
 * memory through the memory adapter. It registers itself here when that module loads (the server loads it through the
 * /me/mia-preview route and the onboarding workflow), so onboarding never imports the M.I.A. services. Read only: the
 * workflow's mia_preview step computes the preview; the reveal only shows what is ready.
 *
 * Unregistered (a unit test that never loads the services) ⇒ null, no card.
 *
 * miaStrengthsGaps projects a preview into the dimension-tagged strengths and gaps onboarding reads (the only source of
 * strengths and gaps since understand 1.7.0 / onboarding 1.7.0).
 */
import type { MiaPreview } from "../../../shared/agent";

export type MiaPreviewProvider = (athleteId: string) => Promise<MiaPreview | null>;

let provider: MiaPreviewProvider | null = null;

/** The M.I.A. preview for an athlete, or null when none is available yet. Never throws: a failure means no card. */
export async function getMiaPreview(athleteId: string): Promise<MiaPreview | null> {
  if (!provider) return null;
  try {
    const p = await provider(athleteId);
    return p && typeof p.score === "number" && Number.isFinite(p.score) && Array.isArray(p.groups) ? p : null;
  } catch {
    return null;
  }
}

/** The M.I.A. preview module (or a test) registers its implementation here. Pass null to restore the stub. */
export function setMiaPreviewProvider(p: MiaPreviewProvider | null): void {
  provider = p;
}

/** One strength, gap or missing-data item, tagged with the M.I.A. dimension (and its ring group) it belongs to. */
export interface MiaTaggedItem {
  dimension: string;
  group: string | null;
  text: string;
}

export interface MiaStrengthsGaps {
  key_strengths: MiaTaggedItem[];
  key_constraints: MiaTaggedItem[];
  important_missing_data: MiaTaggedItem[];
  evaluator_notes: { key_strengths: string[]; key_constraints: string[]; important_missing_data: string[] };
}

/**
 * Strengths and gaps come from the M.I.A. only (owner decision, 10 Oct 2026): the Brief no longer writes its own.
 * A pure projection of a preview, nothing recomputed. Each item is tagged with its dimension because it IS one of the
 * read's eight dimensions, by the state the M.I.A. concluded for it:
 *   key_strengths           dimensions in state "strength", with the evaluator's rationale
 *   key_constraints         dimensions in state "gap", with the evaluator's rationale
 *   important_missing_data  dimensions in state "unknown" (not enough evidence to judge), with what is missing
 * `evaluator_notes` are the M.I.A.'s own overall lists (key_strengths / key_constraints / important_missing_data as the
 * evaluator returned them); the evaluator does not tie those to a dimension, so they are context, never a tag.
 */
export function miaStrengthsGaps(p: MiaPreview): MiaStrengthsGaps {
  const groupOf = new Map(p.groups.flatMap((g) => g.dimensions.map((d) => [d.key, g.key] as const)));
  const dims = p.assessment?.dimensions ?? [];
  type Dim = (typeof dims)[number];
  const missingWords = (d: Dim) => {
    const missing = d.components.filter((c) => c.evidenceClass === "MISSING").map((c) => c.key.replace(/_/g, " "));
    return missing.length ? `Missing: ${missing.join(", ")}.` : "Not enough evidence to judge yet.";
  };
  const tagged = (state: Dim["state"], text: (d: Dim) => string): MiaTaggedItem[] =>
    dims.filter((d) => d.state === state).map((d) => ({ dimension: d.key, group: groupOf.get(d.key) ?? null, text: text(d) }));
  const notes = p.assessment?.notes;
  return {
    key_strengths: tagged("strength", (d) => d.rationale ?? ""),
    key_constraints: tagged("gap", (d) => d.rationale ?? ""),
    important_missing_data: tagged("unknown", (d) => d.rationale ?? missingWords(d)),
    evaluator_notes: { key_strengths: notes?.strengths ?? [], key_constraints: notes?.constraints ?? [], important_missing_data: notes?.missingEvidence ?? [] },
  };
}
