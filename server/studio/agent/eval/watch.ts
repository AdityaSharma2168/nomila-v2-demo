/**
 * studio/agent/eval/watch — the three PR 15 cards as free, deterministic WATCH metrics (PR 16, R-12).
 * A number per run, no threshold — watched, never gated.
 *
 *   (a) camera-vs-shot_type disagreement on photo rows, by ADI'S PRE-REGISTERED TABLE (ADI-24SEP R9,
 *       docs/probes/flow-eval.md §7). No code related the two vocabularies; this table is his, and the
 *       finer shot-size tag (the PR 12 card) would replace it with a measured relation.
 *   (b) capability drop-rate per plan: slots asked vs slots a Board row keeps (`slotsAllowed`).
 *   (c) join-reason distribution per stitch.
 * ⚠️ MUTATION (watch.test): count a compatible pair — "a compatible pair counts as a disagreement" reds.
 */
import { seedRowsFrom } from "../../../../client/screens/studio/agentLogic";
import type { AgentPlanItem } from "../../../../client/hooks/use-studio";

/** shot_type → the camera members that agree with it. `other` is not counted; `text_graphic` agrees with none. */
export const CAMERA_COMPAT: Readonly<
  Record<string, readonly string[] | "any">
> = {
  portrait: [
    "medium",
    "close_up",
    "extreme_close_up",
    "medium_wide",
    "low_angle",
    "high_angle",
    "over_the_shoulder",
  ],
  action: [
    "wide",
    "medium_wide",
    "medium",
    "low_angle",
    "high_angle",
    "overhead",
    "pov",
  ],
  lifestyle: [
    "wide",
    "medium_wide",
    "medium",
    "close_up",
    "pov",
    "over_the_shoulder",
    "high_angle",
  ],
  group: ["wide", "medium_wide", "medium", "overhead", "high_angle"],
  text_graphic: [],
  other: "any",
};

export interface PhotoRowAsk {
  /** The planner's camera ask on the item, or null when it asked none. */
  camera: string | null;
  /** The cast photo's tagged shot_type. */
  shotType: string;
}

/** (a) The disagreement rate over photo rows that asked a camera and whose shot_type is counted. */
export function cameraDisagreement(rows: readonly PhotoRowAsk[]): {
  counted: number;
  disagree: number;
  rate: number | null;
} {
  let counted = 0;
  let disagree = 0;
  for (const r of rows) {
    if (!r.camera) continue;
    const ok = CAMERA_COMPAT[r.shotType];
    if (ok === undefined || ok === "any") continue;
    counted++;
    if (!ok.includes(r.camera)) disagree++;
  }
  return { counted, disagree, rate: counted ? disagree / counted : null };
}

/** (b) Slots the planner asked for vs slots the Board rows keep, per plan. */
export function dropRate(
  items: readonly AgentPlanItem[],
  composer: boolean,
): { asked: number; kept: number; rate: number | null } {
  const asked = items.reduce(
    (n, i) =>
      n +
      (i.uncast
        ? 0
        : Object.values(i.shot ?? {}).filter((v) => v !== undefined).length),
    0,
  );
  const rows = seedRowsFrom([...items], "watch", 3, composer);
  const kept = rows.reduce(
    (n, r) =>
      n + Object.values(r.shot ?? {}).filter((v) => v !== undefined).length,
    0,
  );
  return { asked, kept, rate: asked ? (asked - kept) / asked : null };
}

/** (c) How many joins of each reason a stitch made (`boardStitch(...).joins`). */
export function joinDistribution(
  joins: Readonly<Record<string, { reason: string }>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const j of Object.values(joins))
    out[j.reason] = (out[j.reason] ?? 0) + 1;
  return out;
}

/**
 * (d) K40, promoted (Adi, 24 Sep 2026): i2v cast onto a MADE-HERE still, per plan. The S-2 reveal's
 * weakest column (i2v_reserved) scored 1.00 on exactly the briefs where the route cast every i2v onto a
 * made-here photo — so the signal is deterministic and needs no judge. Counted off the route's own cast
 * items (kind + provenance); a b-roll made from words has no asset and is never counted.
 * ⚠️ MUTATION (watch.test): count a camera i2v as made-here — "a camera i2v counts as made-here" reds.
 */
export function i2vOnMadeHere(
  items: readonly {
    kind: string;
    assetId: string | null;
    provenance?: string | null;
  }[],
): {
  i2v: number;
  onMadeHere: number;
  rate: number | null;
} {
  const i2v = items.filter((i) => i.kind === "i2v" && i.assetId !== null);
  const onMadeHere = i2v.filter((i) => i.provenance === "made-here").length;
  return {
    i2v: i2v.length,
    onMadeHere,
    rate: i2v.length ? onMadeHere / i2v.length : null,
  };
}
