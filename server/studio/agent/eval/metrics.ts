/**
 * studio/agent/eval/metrics — what a plan looks like as numbers, with no judgment in it.
 *
 * Pure. These are the counts the ledger carries per merge beside the blind scores: how much of a
 * board is generated, whether her real material was used when the library had it, how often the
 * planner stepped outside §8's closed lists (the null rate C2 Half B logs), and whether an i2v was
 * asked of a photo she is not in. None of them says a plan is GOOD — that is the judge's — but a
 * merge that moves them is a merge to look at.
 */
import { CAPABILITY_AXES } from "../capabilities";
import type { AgentPlan, LibraryEntry, PlanItemKind } from "../types";
import { PLAN_ITEM_KINDS } from "../types";

/** What the metrics need of a library line — a subset of LibraryEntry, so a recording can be thinner. */
export type LibrarySummary = Pick<
  LibraryEntry,
  "ref" | "mediaType" | "athletePresent" | "provenance" | "picked"
>;

export interface PlanMetrics {
  items: number;
  kinds: Record<PlanItemKind, number>;
  /** i2v + broll + product over items — the "board of N is N generations" number. */
  generationShare: number;
  /** clip + image over items. */
  realShare: number;
  brollCount: number;
  i2vCount: number;
  /** Capability values outside the closed lists (parsePlan nulled them). */
  nulled: number;
  /** Nulled per item — the rate the C2 ledger asked the eval to surface. */
  nullRate: number;
  /** i2v items whose ref is a photo the tagger did not see her in — a plan no clip should be made from. */
  i2vWithoutHer: number;
  /** Items whose ref names a stitched compilation — the exclusion failing, or a pick of one. */
  stitchedRefs: number;
  /**
   * Refs named by more than one item at the SAME cut — "use each photo at most once" not held. A clip
   * cut to two different beats is two windows of one file, not a reuse (the baseline did this on
   * three cells, legitimately).
   */
  refsReused: number;
  /** Items with a sound recommendation. */
  soundOn: number;
  /**
   * Clip items whose line has person_in_frame: no — the ball-on-grass filler channel. The
   * diagnostic read found the generic-filler disease had migrated from b-roll into $0 clip rows in
   * ~9 of 33 plans; the b-roll count alone would have reported an improvement.
   */
  clipsWithoutHer: number;
  /** Generated items (i2v · broll · product) — the ones whose direction is a prompt. */
  generatedItems: number;
  /** Of those, how many carry every §8 axis (camera · movement · lighting · composition · motion). */
  generatedWithAllAxes: number;
  /** generatedWithAllAxes over generatedItems; 0 when nothing was generated. */
  axesCoverage: number;
  /** Plan-level gap lines the planner declared (the honest-gap rule). */
  gaps: number;
  /** `product` items — the only place a promoted product may appear. */
  productItems: number;
  /** Whether the library offered any real material at all — a clip or a photo — so realShare means something. */
  libraryHadClips: boolean;
}

const GENERATED: readonly PlanItemKind[] = ["i2v", "broll", "product"];

const zeroKinds = (): Record<PlanItemKind, number> =>
  Object.fromEntries(PLAN_ITEM_KINDS.map((k) => [k, 0])) as Record<
    PlanItemKind,
    number
  >;

/** A plan's numbers, or null when the planner returned nothing usable (a null plan is its own count). */
export function planMetrics(
  plan: AgentPlan | null,
  library: readonly LibrarySummary[],
): PlanMetrics | null {
  if (!plan) return null;
  const byRef = new Map(library.map((e) => [e.ref, e]));
  const kinds = zeroKinds();
  const seen = new Map<string, number>();
  let i2vWithoutHer = 0;
  let stitchedRefs = 0;
  let soundOn = 0;
  let clipsWithoutHer = 0;
  let generatedWithAllAxes = 0;
  for (const item of plan.items) {
    kinds[item.kind] += 1;
    if (item.sound) soundOn += 1;
    if (item.kind === "clip") {
      const line = item.ref ? byRef.get(item.ref) : undefined;
      if (line && !line.athletePresent) clipsWithoutHer += 1;
    }
    if (GENERATED.includes(item.kind)) {
      const caps = item.capabilities ?? {};
      if (CAPABILITY_AXES.every((a) => caps[a] !== undefined))
        generatedWithAllAxes += 1;
    }
    if (item.ref) {
      const cut = `${item.ref}#${item.segment ?? "whole"}`;
      seen.set(cut, (seen.get(cut) ?? 0) + 1);
      const line = byRef.get(item.ref);
      if (item.kind === "i2v" && line && !line.athletePresent)
        i2vWithoutHer += 1;
      if (line?.provenance === "stitched-here") stitchedRefs += 1;
    }
  }
  const items = plan.items.length;
  const generated = kinds.i2v + kinds.broll + kinds.product;
  const real = kinds.clip + kinds.image;
  return {
    items,
    kinds,
    generationShare: items ? generated / items : 0,
    realShare: items ? real / items : 0,
    brollCount: kinds.broll,
    i2vCount: kinds.i2v,
    nulled: plan.nulled.length,
    nullRate: items ? plan.nulled.length / items : 0,
    i2vWithoutHer,
    stitchedRefs,
    refsReused: [...seen.values()].filter((n) => n > 1).length,
    soundOn,
    clipsWithoutHer,
    generatedItems: generated,
    generatedWithAllAxes,
    axesCoverage: generated ? generatedWithAllAxes / generated : 0,
    gaps: plan.gaps.length,
    productItems: kinds.product,
    libraryHadClips: library.some((e) => e.mediaType === "clip"),
  };
}

/** The numeric fields a run aggregates. */
export const METRIC_FIELDS = [
  "items",
  "generationShare",
  "realShare",
  "brollCount",
  "i2vCount",
  "nulled",
  "nullRate",
  "i2vWithoutHer",
  "stitchedRefs",
  "refsReused",
  "soundOn",
  "clipsWithoutHer",
  "axesCoverage",
  "gaps",
  "productItems",
] as const;
export type MetricField = (typeof METRIC_FIELDS)[number];

export interface Aggregate {
  n: number;
  mean: number;
  min: number;
  max: number;
  /** Sample standard deviation; 0 for n < 2. */
  sd: number;
}

/** Mean, spread and range of one field across cells. Empty input → n 0 and NaN-free zeros. */
export function aggregate(values: readonly number[]): Aggregate {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, min: 0, max: 0, sd: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const sd =
    n < 2
      ? 0
      : Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
  return { n, mean, min: Math.min(...values), max: Math.max(...values), sd };
}

/** Every metric field aggregated across a list of plans; null plans are counted, not averaged in. */
export function aggregateMetrics(list: readonly (PlanMetrics | null)[]): {
  nullPlans: number;
  fields: Record<MetricField, Aggregate>;
} {
  const usable = list.filter((m): m is PlanMetrics => m !== null);
  const fields = Object.fromEntries(
    METRIC_FIELDS.map((f) => [f, aggregate(usable.map((m) => m[f]))]),
  ) as Record<MetricField, Aggregate>;
  return { nullPlans: list.length - usable.length, fields };
}
