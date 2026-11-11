/**
 * studio/agent/eval/routeCell — one ROUTE answer (POST /studio/agent/plan, after castPlan) as the
 * numbers a baseline table carries, and those numbers pooled over a brief's n cells.
 *
 * Pure. The input is the route's own `items` — the cast shape, gates applied — never a raw planner
 * plan: a count taken before castPlan is a count of what the gates would have refused (the eval
 * bypass PR 6 fenced, docs/probes/capabilities.md). Every cast asset id is kept whole so a cell
 * says which photo or clip each slot is.
 */
import type { CastItem } from "../cast";

/** The generated still cast as her on 22 Sep 2026 with zero person references (c3-doctrine2.md:16-17). */
export const LOOKALIKE_PREFIX = "a6a8b954";

/** What a cell needs of an item — the route's JSON, which is `CastItem` serialised. */
export type RouteItem = Pick<
  CastItem,
  | "kind"
  | "assetId"
  | "provenance"
  | "trim"
  | "motion"
  | "uncast"
  | "demoted"
  | "swapped"
  | "sound"
  | "athletePresent"
> &
  Partial<Pick<CastItem, "reason">>;

export interface RouteCellSlot {
  kind: RouteItem["kind"];
  assetId: string | null;
  provenance: RouteItem["provenance"];
  trim: RouteItem["trim"];
  motion: RouteItem["motion"];
  demoted: boolean;
  /** The planner's reason, whole — entry, why it fits, what it beat — or null (PR 6, 6a2). */
  reason: CastItem["reason"];
}

export interface RouteCellCounts {
  /** Items the plan will make — cast to an asset, or b-roll from words. Left-out items are not slots. */
  slots: number;
  /** Slots cast to an asset whose provenance is her camera — clip or held still alike. */
  camera: number;
  /** Slots cast to a made-here asset. */
  madeHere: number;
  /** i2v items cast to a photo (an i2v that survived A1b). */
  i2v: number;
  /** i2v items cast to a made-here photo. */
  i2vMadeHere: number;
  /** Image items cast to a photo — a held still, pushed-in or not, demoted or planned. */
  held: number;
  /** Held stills that were a planned i2v A1b turned into a push-in. */
  demoted: number;
  /** Clips cast to a clip. */
  clips: number;
  /** b-roll from words — no asset, not left out. */
  brollFromWords: number;
  /** Products cast. */
  products: number;
  /** Items left out (uncast set). */
  leftOut: number;
  /** The lookalike cast anywhere in the cell. */
  lookalike: number;
  /** Items — left out or not — whose reason names a capability-library entry (PR 6, 6a2). */
  reasons: number;
  /** Every item the route answered, left out or not: the denominator for `reasons`. */
  items: number;
}

export interface RouteCell extends RouteCellCounts {
  /** Every slot, in order, with its full asset id. */
  slotList: RouteCellSlot[];
  /** Every slot is a camera asset — the acceptance-recap bar. b-roll from words breaks it. */
  allCamera: boolean;
}

export function summarizeRouteCell(items: readonly RouteItem[]): RouteCell {
  const slots = items.filter((i) => !(i.assetId === null && i.uncast !== null));
  const cast = slots.filter((i) => i.assetId !== null);
  const counts: RouteCellCounts = {
    slots: slots.length,
    camera: cast.filter((i) => i.provenance === "camera").length,
    madeHere: cast.filter((i) => i.provenance === "made-here").length,
    i2v: cast.filter((i) => i.kind === "i2v").length,
    i2vMadeHere: cast.filter(
      (i) => i.kind === "i2v" && i.provenance === "made-here",
    ).length,
    held: cast.filter((i) => i.kind === "image").length,
    demoted: cast.filter((i) => i.kind === "image" && i.demoted !== null)
      .length,
    clips: cast.filter((i) => i.kind === "clip").length,
    brollFromWords: slots.filter((i) => i.assetId === null).length,
    products: cast.filter((i) => i.kind === "product").length,
    leftOut: items.length - slots.length,
    lookalike: cast.filter((i) => i.assetId!.startsWith(LOOKALIKE_PREFIX))
      .length,
    reasons: items.filter((i) => i.reason).length,
    items: items.length,
  };
  return {
    ...counts,
    slotList: slots.map((i) => ({
      kind: i.kind,
      assetId: i.assetId,
      provenance: i.provenance,
      trim: i.trim,
      motion: i.motion,
      demoted: i.demoted !== null,
      reason: i.reason ?? null,
    })),
    allCamera:
      slots.length > 0 &&
      cast.length === slots.length &&
      counts.camera === slots.length,
  };
}

export interface PooledCells extends RouteCellCounts {
  cells: number;
  /** Pooled camera slots over pooled slots — the thresholded number. Null when no slot exists. */
  cameraShare: number | null;
  allCameraCells: number;
}

const COUNT_KEYS = [
  "slots",
  "camera",
  "madeHere",
  "i2v",
  "i2vMadeHere",
  "held",
  "demoted",
  "clips",
  "brollFromWords",
  "products",
  "leftOut",
  "lookalike",
  "reasons",
  "items",
] as const satisfies readonly (keyof RouteCellCounts)[];

export function poolRouteCells(cells: readonly RouteCell[]): PooledCells {
  const sum: RouteCellCounts = {
    slots: 0,
    camera: 0,
    madeHere: 0,
    i2v: 0,
    i2vMadeHere: 0,
    held: 0,
    demoted: 0,
    clips: 0,
    brollFromWords: 0,
    products: 0,
    leftOut: 0,
    lookalike: 0,
    reasons: 0,
    items: 0,
  };
  for (const c of cells) for (const k of COUNT_KEYS) sum[k] += c[k];
  return {
    ...sum,
    cells: cells.length,
    cameraShare: sum.slots ? sum.camera / sum.slots : null,
    allCameraCells: cells.filter((c) => c.allCamera).length,
  };
}
