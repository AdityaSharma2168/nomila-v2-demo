/**
 * studioSweep2Plan — sweep #2's cells and what they are quoted at. PURE: no database, no network,
 * no spend. The runner (studioSweep2.ts) imports this; so does its test, which pins that the list
 * covers what PR N's N.4 asked for and that the printed estimate is the price table's own sum.
 *
 * ─── WHAT SWEEP #2 IS FOR ───────────────────────────────────────────────────────────────────────
 *
 * The original sweep's prompts, through the PRODUCT's native edit path — freeze at preview, one
 * full-frame call, Creative QA on every output. It is the proof the product does what the probe did,
 * PR Q's calibration event (full-frame is the first path where an identity failure can exist), and
 * the Mia demo material. Adi verdicts it, in daylight. Nothing here runs it.
 *
 * ─── WHAT IT DELIBERATELY INCLUDES ──────────────────────────────────────────────────────────────
 *
 *   • sections 1–5 on their ORIGINAL sources, so every cell has a sweep #1 twin to compare against;
 *   • 1.5a — the jacket, the three-hands case — at n=2: the variance cell, and the one most likely to
 *     produce the identity failure Q's band has never seen;
 *   • a multi-part recolour at n=2 where BOTH garments genuinely change. afc78262's jersey, shorts and
 *     socks are all black, so sweep 3.1's "the shorts black" is a no-op and "the jersey white and the
 *     socks yellow" is not — one-call compound editing is the DESIGN, and this is where it is tested;
 *   • 3.2, the mixed recolour + design sentence — which the classifier ASKs on, so it is staged as a
 *     gate cell: it must BLOCK at the preview and spend nothing;
 *   • every background prompt on BOTH 4000px sources, not only its original — the halo lived on a
 *     4000px frame, and the native path's resolution rule lands hardest there;
 *   • the two-image ball insertion through the Object tile. Pre-C′ there is no ADD_OBJECT, so it is
 *     staged as the GENERATE it routes to: her photo as identity, the ball as the object reference.
 */
import { estimateCost } from "../studio/pricing";
import {
  imageSizeParams,
  routeFor,
  smallestImageSizeFor,
  type ImageSizeName,
} from "../studio/config";
import { route } from "../studio/classify";
import type { ImageRef } from "../studio/types";

/** A stand-in reference. The estimate reads only how MANY references a request carries. */
const REF: ImageRef = { kind: "url", url: "about:blank" };

export type SourceKey = "small" | "halo" | "large" | "jacket" | "mint";

/**
 * The sweep's source frames — `media_assets.id` PREFIXES as the sweep printed them (the `src`
 * column), resolved at run time under the athlete. DISPLAY dimensions, which is what the size rule
 * and the ratio pin read.
 */
export const SWEEP2_SOURCES: Record<
  SourceKey,
  { prefix: string; width: number; height: number; note: string }
> = {
  small: {
    prefix: "afc78262",
    width: 1008,
    height: 1476,
    note: "the workhorse — black Stanford jersey, black shorts, black socks, pink cleats",
  },
  halo: {
    prefix: "a81be2c0",
    width: 4000,
    height: 6000,
    note: "orientation 8 — sweep 1.2 / 4.2 / 5.1 / 5.2, the green-halo frame",
  },
  large: {
    prefix: "5581e882",
    width: 4000,
    height: 6000,
    note: "N.1's frame — white shorts, white ankle socks, ball in the air",
  },
  jacket: {
    prefix: "3b9be374",
    width: 4000,
    height: 6000,
    note: "orientation 8 — sweep 1.5, the three-hands case",
  },
  mint: {
    prefix: "517ed082",
    width: 1056,
    height: 1408,
    note: "sweep 2.4a's mint CarMax jersey",
  },
};

/** The soccer ball — the Object tile's reference for the insertion cell. */
export const SWEEP2_BALL = { prefix: "e64e900a", label: "the ball" };

export type CellKind =
  /** An edit her sentence describes: frozen at preview, one full-frame call, QA'd. */
  | "native"
  /** Staged to prove a gate: must BLOCK at the preview and spend nothing. */
  | "expect-block"
  /** Net-new with references — the ball insertion, pre-C′. */
  | "generate";

export interface Sweep2Cell {
  id: string;
  section: "1" | "2" | "3" | "4" | "5" | "multi" | "bg-4000" | "object";
  source: SourceKey;
  sentence: string;
  kind: CellKind;
  /** The sweep #1 cell this reruns, when it is one — its twin for the verdict. */
  sweep1?: string;
  /** Why the cell is on the list, in one line. */
  why: string;
}

const PINK = "make the jacket pink";
const MULTI = "make the jersey white and the socks yellow";
const STADIUM = "put me in a packed stadium";
const BEACH = "change the background to a beach at sunset";
const STUDIO = "change the background to a plain studio backdrop";

export const SWEEP2_CELLS: Sweep2Cell[] = [
  // ─── Section 1 — recolour ────────────────────────────────────────────────────────────────────
  {
    id: "1.1",
    section: "1",
    source: "small",
    sentence: "change the color of the jersey to purple",
    kind: "native",
    sweep1: "1.1",
    why: "the only sweep #1 cell with no defect — the control",
  },
  {
    id: "1.2",
    section: "1",
    source: "halo",
    sentence: "make the sports bra white",
    kind: "native",
    sweep1: "1.2",
    why: "masked drew a line and distorted the strap",
  },
  {
    id: "1.3a",
    section: "1",
    source: "small",
    sentence: "change the socks to yellow",
    kind: "native",
    sweep1: "1.3a",
    why: "the rim, on the small source",
  },
  {
    id: "1.3b",
    section: "1",
    source: "large",
    sentence: "change the socks to yellow",
    kind: "native",
    sweep1: "1.3b",
    why: "the same ask at 4000px — the resolution rule's 4K arm",
  },
  {
    id: "1.4",
    section: "1",
    source: "small",
    sentence: "make the cleats black",
    kind: "native",
    sweep1: "1.4",
    why: "masked left a halo round both boots",
  },
  {
    id: "1.5a-r1",
    section: "1",
    source: "jacket",
    sentence: PINK,
    kind: "native",
    sweep1: "1.5a",
    why: "THE VARIANCE / IDENTITY CELL — masked came back maroon with a third hand",
  },
  {
    id: "1.5a-r2",
    section: "1",
    source: "jacket",
    sentence: PINK,
    kind: "native",
    sweep1: "1.5a",
    why: "its repeat — n=2 is what separates a defect from a draw",
  },
  {
    id: "1.5b",
    section: "1",
    source: "jacket",
    sentence: "recolor the jacket to be black",
    kind: "native",
    sweep1: "1.5b",
    why: "the byte-identical-mask control that worked",
  },

  // ─── Section 2 — design and branding ─────────────────────────────────────────────────────────
  {
    id: "2.1",
    section: "2",
    source: "small",
    sentence: "put a number 10 on the jersey",
    kind: "native",
    sweep1: "2.1",
    why: "masked: right number, scraggly lines, quality hit",
  },
  {
    id: "2.2",
    section: "2",
    source: "small",
    sentence: "add a nike swoosh to the shorts",
    kind: "native",
    sweep1: "2.2",
    why: "masked: the phantom success — no swoosh, every guard passed",
  },
  {
    id: "2.3",
    section: "2",
    source: "small",
    sentence: "put a sponsor patch on the sleeve",
    kind: "native",
    sweep1: "2.3",
    why: "masked: part-of-garment overreach, sleeves distorted",
  },
  {
    id: "2.4a",
    section: "2",
    source: "mint",
    sentence: "add an adidas logo to the jersey",
    kind: "native",
    sweep1: "2.4a",
    why: "masked failed on this frame",
  },
  {
    id: "2.4b",
    section: "2",
    source: "small",
    sentence: "add an adidas logo to the jersey",
    kind: "native",
    sweep1: "2.4b",
    why: "masked's cleanest design — and it swapped the swoosh unasked",
  },

  // ─── Section 3 — multi-target ────────────────────────────────────────────────────────────────
  {
    id: "3.1",
    section: "3",
    source: "small",
    sentence: "make the jersey red and the shorts black",
    kind: "native",
    sweep1: "3.1",
    why: "the sweep's own prompt; its shorts are ALREADY black, so only the jersey really changes",
  },
  {
    id: "3.2",
    section: "3",
    source: "small",
    sentence: "change my jersey to blue and add an adidas logo",
    kind: "expect-block",
    sweep1: "3.2",
    why: "the classifier ASKs on recolour + design; it must block and spend nothing",
  },

  // ─── Multi-part — both garments genuinely change ─────────────────────────────────────────────
  {
    id: "multi-r1",
    section: "multi",
    source: "small",
    sentence: MULTI,
    kind: "native",
    why: "two real changes in ONE call — the design, tested; jersey and socks are both black",
  },
  {
    id: "multi-r2",
    section: "multi",
    source: "small",
    sentence: MULTI,
    kind: "native",
    why: "its repeat",
  },

  // ─── Section 4 — background, on the originals ────────────────────────────────────────────────
  {
    id: "4.1",
    section: "4",
    source: "small",
    sentence: STADIUM,
    kind: "native",
    sweep1: "4.1",
    why: "masked: correct, read as slop",
  },
  {
    id: "4.2",
    section: "4",
    source: "halo",
    sentence: BEACH,
    kind: "native",
    sweep1: "4.2",
    why: "masked: the green halo and cooked borders",
  },
  {
    id: "4.3",
    section: "4",
    source: "large",
    sentence: STUDIO,
    kind: "native",
    sweep1: "4.3",
    why: "masked: border artifact",
  },

  // ─── Every background prompt on BOTH 4000px sources ──────────────────────────────────────────
  {
    id: "4.1-halo",
    section: "bg-4000",
    source: "halo",
    sentence: STADIUM,
    kind: "native",
    why: "4.1's ask at 4000px, on the halo frame",
  },
  {
    id: "4.1-large",
    section: "bg-4000",
    source: "large",
    sentence: STADIUM,
    kind: "native",
    why: "4.1's ask at 4000px, on N.1's frame",
  },
  {
    id: "4.2-large",
    section: "bg-4000",
    source: "large",
    sentence: BEACH,
    kind: "native",
    why: "4.2's ask on the other 4000px frame",
  },
  {
    id: "4.3-halo",
    section: "bg-4000",
    source: "halo",
    sentence: STUDIO,
    kind: "native",
    why: "4.3's ask on the other 4000px frame",
  },

  // ─── Section 5 — objects ─────────────────────────────────────────────────────────────────────
  {
    id: "5.1",
    section: "5",
    source: "halo",
    sentence: "remove the ball",
    kind: "native",
    sweep1: "5.1",
    why: "masked: very clean, on a rectangle",
  },
  {
    id: "5.2",
    section: "5",
    source: "halo",
    sentence: "change the ball to a black one",
    kind: "native",
    sweep1: "5.2",
    why: "masked: clean — classifies as a RECOLOUR of the ball",
  },

  // ─── The two-image insertion, through the Object tile — GENERATE pre-C′ ─────────────────────
  {
    id: "ball",
    section: "object",
    source: "small",
    sentence: "create a new photo of me with this ball at my feet",
    kind: "generate",
    why: "her photo as identity, the ball as the object reference — the BOLYN test, as a generate",
  },
];

/** Creative QA's measured cost per inspected generation — PR Q (#381), $0.0212. Not in qa/ as a constant. */
export const QA_USD_PER_GENERATION = 0.0212;

export interface CellQuote {
  /** The size requested, or "default" for a generate that names none (the API serves 1K). */
  size: ImageSizeName | "default" | null;
  /** What the preview quotes and the cap checks — image tokens plus reference tokens. */
  quotedUsd: number;
  /** What Vertex bills: image tokens only (adapters/vertex.ts `costFromUsage`). */
  billedUsd: number;
}

/** The quote the product would show for this cell, from the price table — never a hand-typed figure. */
export function quoteFor(cell: Sweep2Cell): CellQuote {
  if (cell.kind === "expect-block")
    return { size: null, quotedUsd: 0, billedUsd: 0 };
  if (cell.kind === "generate") {
    const model = routeFor("image.generate").model;
    // Her photo and the ball — two references, no size named, the API's 1K default.
    return {
      size: "default",
      quotedUsd: estimateCost(
        { prompt: "", references: [REF, REF], n: 1 },
        model,
      ).amountUsd,
      billedUsd: estimateCost({ prompt: "", references: [], n: 1 }, model)
        .amountUsd,
    };
  }
  const src = SWEEP2_SOURCES[cell.source];
  const size = smallestImageSizeFor(src.width * src.height);
  const model = routeFor("image.edit").model;
  const opts = { providerParams: imageSizeParams(size) };
  return {
    size,
    // The frame is the one reference a native edit sends on these briefs (no brand, no object).
    quotedUsd: estimateCost(
      { prompt: "", references: [REF], n: 1 },
      model,
      opts,
    ).amountUsd,
    billedUsd: estimateCost({ prompt: "", references: [], n: 1 }, model, opts)
      .amountUsd,
  };
}

/** What the classifier makes of the sentence — pure, and exactly what the freeze will see. */
export function classifyCell(cell: Sweep2Cell) {
  return route(cell.sentence, cell.kind !== "generate");
}

export interface Sweep2Estimate {
  cells: number;
  spending: number;
  quotedUsd: number;
  billedUsd: number;
  qaUsd: number;
}

/** The sweep's total. QA only inspects DERIVED assets, so a generate adds nothing to it. */
export function sweep2Estimate(
  cells: Sweep2Cell[] = SWEEP2_CELLS,
): Sweep2Estimate {
  const round = (n: number) => Math.round(n * 1e4) / 1e4;
  const quotes = cells.map(quoteFor);
  const native = cells.filter((c) => c.kind === "native").length;
  return {
    cells: cells.length,
    spending: cells.filter((c) => c.kind !== "expect-block").length,
    quotedUsd: round(quotes.reduce((s, q) => s + q.quotedUsd, 0)),
    billedUsd: round(quotes.reduce((s, q) => s + q.billedUsd, 0)),
    qaUsd: round(native * QA_USD_PER_GENERATION),
  };
}
