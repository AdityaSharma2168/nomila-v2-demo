/**
 * studio/identity/calibrate — the per-athlete measurement (PR 17, R-4/R-5). Arithmetic here; the
 * model calls are `measureFaces`, which reaches qa/face.ts and qa/embed.ts through a DYNAMIC import
 * (qa/embed → lib/mediaEmbed builds a GCS client at module load; videoRunner.ts states why that
 * must not happen on import).
 *
 * ─── ONE PRE-REGISTERED MEASUREMENT, NO INVENTED NUMBER ─────────────────────────────────────────
 *
 *   (i)  her-vs-her: every pair of pack photographs that produced a face vector → cosine distance;
 *        the band is their min and max, and `pairs` is how many there were.
 *   (ii) strangers: each stranger sample photograph vs EVERY pack photograph → the stranger's
 *        distances. The control PASSES only if every stranger distance lands above band_max.
 *
 * No threshold is chosen, fitted or defaulted anywhere in this file. `controlOf` compares numbers
 * the corpus produced; `bandOf` reports extremes. Whether the band may then be ASSERTED is
 * profile.ts's rule (control_passed), and the ledger records the outcome per run — the embedder
 * decision is Adi's, later, on those counts (R-5).
 *
 * ⚠️ MUTATION (calibrate.test) "a threshold is asserted before the stranger control passes": make
 * `controlOf` answer true on an empty stranger set, or on a stranger inside the band.
 *
 * Nothing about a face is kept: vectors live in the caller's frame and are dropped when it returns.
 */
import type { IdentityBand } from "./types";

export interface FaceMeasure {
  assetId: string;
  /** The vector, in memory only. Null when no face was found or the embed did not return. */
  vector: number[] | null;
  faceSizeFrac: number | null;
  miss: string | null;
}

export function pairwiseDistances(
  faces: FaceMeasure[],
  distance: (a: number[], b: number[]) => number,
): { a: string; b: string; d: number }[] {
  const out: { a: string; b: string; d: number }[] = [];
  const scored = faces.filter((f) => f.vector);
  for (let i = 0; i < scored.length; i++)
    for (let j = i + 1; j < scored.length; j++)
      out.push({
        a: scored[i].assetId,
        b: scored[j].assetId,
        d: Number(distance(scored[i].vector!, scored[j].vector!).toFixed(4)),
      });
  return out;
}

/** The extremes of what was measured. Null with fewer than one pair — no band from no data. */
export function bandOf(pairs: { d: number }[]): IdentityBand | null {
  if (pairs.length === 0) return null;
  let min = Infinity,
    max = -Infinity;
  for (const p of pairs) {
    if (p.d < min) min = p.d;
    if (p.d > max) max = p.d;
  }
  return { min, max, pairs: pairs.length };
}

export function strangerDistances(
  pack: FaceMeasure[],
  strangers: FaceMeasure[],
  distance: (a: number[], b: number[]) => number,
): { strangerAssetId: string; packAssetId: string; d: number }[] {
  const out: { strangerAssetId: string; packAssetId: string; d: number }[] = [];
  for (const s of strangers) {
    if (!s.vector) continue;
    for (const p of pack) {
      if (!p.vector) continue;
      out.push({
        strangerAssetId: s.assetId,
        packAssetId: p.assetId,
        d: Number(distance(s.vector, p.vector).toFixed(4)),
      });
    }
  }
  return out;
}

export interface ControlResult {
  passed: boolean;
  /** How many stranger distances were measured. Zero means NOT passed — an absent control is not a pass. */
  measured: number;
  /** How many landed at or below band_max — each one is a stranger the ruler could not tell from her. */
  inside: number;
  minStranger: number | null;
}

/**
 * Passed only if EVERY measured stranger distance is strictly above band_max — and only if
 * something was measured at all. An empty control is a control that did not run.
 */
export function controlOf(
  band: IdentityBand | null,
  distances: { d: number }[],
): ControlResult {
  if (!band || distances.length === 0)
    return {
      passed: false,
      measured: distances.length,
      inside: 0,
      minStranger: null,
    };
  const inside = distances.filter((x) => x.d <= band.max).length;
  const minStranger = Math.min(...distances.map((x) => x.d));
  return {
    passed: inside === 0,
    measured: distances.length,
    inside,
    minStranger,
  };
}

/**
 * Face box + embed for each photograph, concurrently, vectors in memory. The two boundaries are
 * qa/face.ts and qa/embed.ts, loaded here rather than at module top (see the header).
 */
export async function measureFaces(
  photos: { assetId: string; bytes: Buffer; mimeType: string }[],
  label: string,
): Promise<{ faces: FaceMeasure[]; visionCalls: number; embedCalls: number }> {
  const [{ faceCrop }, { embedImageBytes }] = await Promise.all([
    import("../qa/face.js"),
    import("../qa/embed.js"),
  ]);
  let embedCalls = 0;
  const faces = await Promise.all(
    photos.map(async (p): Promise<FaceMeasure> => {
      const r = await faceCrop(p.bytes, p.mimeType, label, p.assetId);
      if (!r.crop)
        return {
          assetId: p.assetId,
          vector: null,
          faceSizeFrac: null,
          miss: r.miss,
        };
      embedCalls += 1;
      const v = await embedImageBytes(r.crop.bytes, p.assetId);
      return {
        assetId: p.assetId,
        vector: v,
        faceSizeFrac: Number(r.crop.sizeFrac.toFixed(4)),
        miss: v ? null : "embed_failed",
      };
    }),
  );
  return { faces, visionCalls: photos.length, embedCalls };
}

/** The quote for a measurement, at qa/cost.ts's rates (the ledger's stated basis). */
export function quoteMeasure(photos: number): {
  faceBoxUsd: number;
  embedUsd: number;
  usd: number;
} {
  const flashIn = Number(
    process.env.STUDIO_QA_USD_PER_INPUT_TOKEN ?? 0.3 / 1_000_000,
  );
  const flashOut = Number(
    process.env.STUDIO_QA_USD_PER_OUTPUT_TOKEN ?? 2.5 / 1_000_000,
  );
  const embed = Number(process.env.STUDIO_QA_USD_PER_EMBED ?? 0.0001);
  // A probe-scaled still ≈ 1,300 input tokens and ≈ 60 output tokens per face box (qa/face.ts).
  const faceBoxUsd = photos * (1_300 * flashIn + 60 * flashOut);
  const embedUsd = photos * embed;
  return {
    faceBoxUsd: Number(faceBoxUsd.toFixed(4)),
    embedUsd: Number(embedUsd.toFixed(4)),
    usd: Number((faceBoxUsd + embedUsd).toFixed(4)),
  };
}
