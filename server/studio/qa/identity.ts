/**
 * studio/qa/identity — Q.1. How far did her face move, measured against the root of the chain.
 *
 * ─── ⚠️  THIS CHECK ASSERTS NO THRESHOLD, AND THAT IS THE FINDING, NOT A SHORTCUT ──────────────
 *
 * It records a distance and where that distance falls relative to a measured band. It never returns
 * `fail`, and it returns `flag` only in the one situation the corpus can actually justify. The
 * reason is not caution — it is that THE CORPUS CONTAINS NO IDENTITY FAILURE TO CALIBRATE AGAINST.
 *
 * 2.4a is the anchor named by the brief, the sweep and the roadmap, and it is not one. Measured
 * (`scripts/studioQaCalibrate.ts`, and see the note on `labeledSet.SWEEP_OUTPUTS` 2.4a): source and
 * output are both 1056x1408 and the mean-absolute pixel difference over the head region is EXACTLY
 * 0.000 against 4.245 for the whole frame. It is a masked edit on a 521x542 jersey region, so the
 * composite pasted her face back byte-for-byte. Her face in that output IS the source's face. The
 * embedding agreed, returning 0.0127 — the smallest distance anywhere in the corpus. What Adi saw
 * is the sleeve/shoulder distortion his own note also records.
 *
 * So there is no positive example, and a threshold fitted to zero positives is a number somebody
 * made up. Recording the distance costs nothing, is reversible, and accumulates the distribution
 * that a real threshold will one day be derived from. Asserting one today would be inventing a
 * fact — and this stage exists precisely because plausible-looking facts shipped before.
 *
 * THE FIRST REAL POSITIVES ARE COMING. Sweep #2 (roadmap PR N) reruns every prompt through the
 * full-frame path, where nothing is preserved by construction and her face is re-rendered on every
 * call. That is where an identity failure can first exist. Recalibrate then; expect it.
 *
 * ─── THE BAND, AND WHY IT IS THE USEFUL PART ───────────────────────────────────────────────────
 *
 * Measured over her library — every non-generated IMAGE where vision tagging says she is present at
 * prominence >= 0.5, pairwise, n=28 usable pairs of 36 (see IDENTITY_REFERENCES):
 *
 *     SAME PERSON, DIFFERENT PHOTOGRAPH   0.1588 .. 0.5282
 *     clean edits of one frame            0.0169 .. 0.3669
 *
 * That band is what a threshold has to clear, and it is worth having on its own: it says how far
 * this metric moves for a face that is indisputably hers, shot on another day, in another pose,
 * under other light. A generation landing INSIDE it has moved no further than a different photo of
 * her. Landing ABOVE it is the first genuinely interesting signal this check can produce — nothing
 * in the corpus does, which is exactly why it is worth watching for rather than asserting about.
 *
 * `q2-a` is the instructive case. Full-frame background replacement, verdicted CLEAN, face distance
 * 0.3669 — inside the band. Her face WAS re-rendered and it is still recognisably her, and the
 * number says so. That is the check working, on the only kind of evidence available.
 */
import { embeddingDistance, embedImageBytes } from "./embed";
import { faceCrop, type FaceCrop, type FaceMiss } from "./face";
import { SpendMeter, type QaSpend } from "./cost";
import type { ComparedAgainst, IdentityTarget } from "./identitySet";
import { unknownResult, type CheckResult, type ComparisonPair } from "./types";

/**
 * Same person, different photograph — the empirical band, from `qa-fixtures/calibration.json`.
 *
 * ⚠️ THESE ARE MEASUREMENTS, NOT TUNING KNOBS. They came from 28 pairs of her own library and they
 * describe this metric's behaviour, not a policy. Change them when the corpus changes — after sweep
 * #2, or when her library grows — by RE-RUNNING the calibration, never by hand to make a case come
 * out differently. Both are env-overridable so a recalibration is config, not a redeploy.
 */
export const SAME_PERSON_BAND = {
  min: Number(process.env.STUDIO_QA_IDENTITY_BAND_MIN ?? 0.1588),
  max: Number(process.env.STUDIO_QA_IDENTITY_BAND_MAX ?? 0.5282),
  /** How many pairs the band was measured from. On the record, so a reader can weigh it. */
  pairs: 28,
  measuredAt: "2026-09-09",
} as const;

export type BandPosition = "below" | "within" | "above";

/**
 * The band a distance is placed against. The global const above by default; HER OWN measured band
 * (identity_profiles, PR 17 R-4) when — and only when — her stranger control passed. The caller
 * decides which (studio/identity/profile.ts `bandFor`); this file only reads what it is handed, and
 * with nothing handed it is byte-identical to before PR 17.
 * ⚠️ MUTATION (identity.test "position() reads the profile row when control failed"): the caller
 * hands a band whose control did not pass — profile.test holds the rule at its source.
 */
export interface BandRange {
  min: number;
  max: number;
  pairs: number;
}

export interface IdentityDetail {
  /** Cosine distance between face crops. 0 is identical. The number this check exists to record. */
  distance: number;
  /** Where it falls relative to SAME_PERSON_BAND. */
  band: BandPosition;
  /** The measured band, copied onto the record so a stored verdict is readable without this file. */
  bandRange: { min: number; max: number; pairs: number };
  /** What was compared, by asset id — the chain ROOT and the output, never an intermediate step. */
  comparedSourceAssetId: string | null;
  comparedOutputAssetId: string | null;
  chainDepth: number;
  /** The instrument. Recorded because a later run must know whether it can compare numbers. */
  method: "face-crop/multimodalembedding@001";
  /** Detection confidence and relative size, both halves — a tiny face embeds poorly. */
  sourceFace: { confidence: number; sizeFrac: number; small: boolean };
  outputFace: { confidence: number; sizeFrac: number; small: boolean };
}

export const position = (
  d: number,
  band: BandRange = SAME_PERSON_BAND,
): BandPosition => (d < band.min ? "below" : d > band.max ? "above" : "within");

/**
 * Compare the face in the output against the face at the root of the chain.
 *
 * `unknown` when either face is missing — a back view, a product shot, a crop that excludes her
 * head are all ordinary outputs, and NOTHING may be inferred from a missing face. It must never
 * read as a pass: "every guard passed, nothing was flagged" is the sentence this whole PR exists
 * to stop being true of a broken image.
 */
export async function checkIdentity(
  pair: ComparisonPair,
  band: BandRange = SAME_PERSON_BAND,
): Promise<CheckResult<IdentityDetail>> {
  const started = Date.now();
  const meter = new SpendMeter();

  const [src, out] = await Promise.all([
    faceCrop(pair.sourceBytes, pair.sourceMimeType, "source"),
    faceCrop(pair.outputBytes, pair.outputMimeType, "output"),
  ]);
  meter.vision(src.usage);
  meter.vision(out.usage);

  if (!src.crop || !out.crop) {
    const which =
      !src.crop && !out.crop
        ? "neither image"
        : !src.crop
          ? "the source"
          : "the output";
    return unknownResult(
      `No face found in ${which} — identity was not measurable.`,
      src.error ?? out.error,
      meter.total(),
      Date.now() - started,
    );
  }

  const [srcVec, outVec] = await Promise.all([
    embedImageBytes(src.crop.bytes),
    embedImageBytes(out.crop.bytes),
  ]);
  meter.embed(2);

  if (!srcVec || !outVec)
    return unknownResult(
      "Face found but the embedding call did not return a vector.",
      "embedding unavailable",
      meter.total(),
      Date.now() - started,
    );

  const distance = Number(embeddingDistance(srcVec, outVec).toFixed(4));
  const where = position(distance, band);

  const detail: IdentityDetail = {
    distance,
    band: where,
    bandRange: { min: band.min, max: band.max, pairs: band.pairs },
    comparedSourceAssetId: pair.sourceAssetId,
    comparedOutputAssetId: pair.outputAssetId,
    chainDepth: pair.chainDepth,
    method: "face-crop/multimodalembedding@001",
    sourceFace: {
      confidence: src.crop.confidence,
      sizeFrac: Number(src.crop.sizeFrac.toFixed(4)),
      small: src.crop.small,
    },
    outputFace: {
      confidence: out.crop.confidence,
      sizeFrac: Number(out.crop.sizeFrac.toFixed(4)),
      small: out.crop.small,
    },
  };

  // The ONLY non-pass this check will assert, and it is still not a failure claim. "Above the band"
  // means the face moved further than any two photographs of her ever did. Nothing in the corpus
  // reaches it, so it is a signal to look — never evidence on its own, and never `fail`, because
  // there is no verdicted example of what a true identity failure measures.
  const status = where === "above" ? "flag" : "pass";
  const summary =
    where === "above"
      ? `Face distance ${distance} is above the same-person band (${band.min}–${band.max}, n=${band.pairs}) — further than any two photographs of her. Worth a look; no threshold is asserted.`
      : `Face distance ${distance} (${where} the same-person band ${band.min}–${band.max}). Recorded, not gated.`;

  // A tiny face is a weak measurement whatever the number says, so it is said out loud rather than
  // silently trusted — the same reason the calibration reports sizeFrac at all.
  const caveat =
    detail.sourceFace.small || detail.outputFace.small
      ? " Face is small in frame; the distance is less reliable."
      : "";

  return {
    status,
    summary: summary + caveat,
    detail,
    error: null,
    spend: meter.total(),
    latencyMs: Date.now() - started,
  };
}

/**
 * ─── ⚠️  THE DEAD RULER. READ THIS BEFORE READING ANY NUMBER `observeGenerateIdentity` WRITES. ──
 *
 * This is the SAME instrument as `checkIdentity` above, and on 2026-09-15 it failed its control. An
 * invented person — no photograph of her anywhere in the request — scored 0.3584 against her held-out
 * photographs, INSIDE her own same-person band on that set (0.3158–0.4186, 6 pairs). A stranger is
 * indistinguishable from her on this metric, so no threshold exists at any value
 * (docs/plans/studio-generation-identity-plan.md, R0.a).
 *
 * The distances are recorded anyway, and that is the point rather than a contradiction: whatever
 * replaces this ruler (R0.a, parked with Mia) needs production rows to be validated against, and
 * blind production data does not exist until something writes it. So they go on the record as
 * OBSERVATIONS — never a check, never in `overall`, never shown to her — and the caveat travels
 * with them, on the record itself, so a reader of the jsonb does not need this file to be warned.
 *
 * Nothing about her face is kept: each crop is embedded in memory, compared and dropped, and only the
 * distance survives. Computing a face template is the BIPA/CUBI trigger, and whatever the instrument
 * becomes, it keeps that property (R0.a, "Legal").
 */
export const DEAD_RULER_CAVEAT =
  "Observation only, never a verdict. multimodalembedding@001 failed its stranger control on 2026-09-15: an invented person scored 0.3584 against her held-out photos, inside her own same-person band (0.3158-0.4186). These distances are a baseline for a replacement instrument to be validated against, not evidence about her face.";

/**
 * WHY a comparison has no distance — a closed code on the record, never a null left to be guessed at.
 *
 * On Adi's R0.b acceptance one of her three references came back `distance: null` while the other two
 * scored, and nothing on the record could say which of four things had happened: the photo was never
 * fetched, the vision call failed, it found no face, or the embedding did not return. These are those.
 *
 *   unfetched     the photograph's bytes could not be read (inspect.ts fetches them)
 *   no_face       the face box found none — an answer, not a failure
 *   vision_error  the face-box call or its answer failed
 *   unusable_box  a face was reported but its box did not parse
 *   embed_failed  a face was cut out but its embedding did not return
 */
export type IdentityMiss = "unfetched" | FaceMiss | "embed_failed";

export interface IdentityComparison {
  comparedAgainst: ComparedAgainst;
  assetId: string;
  /** Face crop to face crop. Null when either face was missing or the embedding did not return. */
  distance: number | null;
  face: { confidence: number; sizeFrac: number; small: boolean } | null;
  /**
   * Why `distance` is null — and null exactly when it is not. This photograph's own miss first; then,
   * when the photo was fine, the render's (`outputReason`), which costs every comparison alike.
   */
  reason: IdentityMiss | null;
}

export interface GenerateIdentityObservation {
  method: "face-crop/multimodalembedding@001";
  caveat: string;
  /** Null when no face was found in the render — then every distance is null too. */
  outputFace: { confidence: number; sizeFrac: number; small: boolean } | null;
  /** Why the RENDER gave nothing to compare against — null when its face was cut out and embedded. */
  outputReason: Exclude<IdentityMiss, "unfetched"> | null;
  comparisons: IdentityComparison[];
  /** Means over the comparisons that produced a distance; null when none in the group did. */
  referencesMean: number | null;
  identitySetMean: number | null;
  /**
   * How many distances each mean is over. Beside the means because a mean of one and a mean of three
   * read the same on the record, and the group's size alone (its comparisons) says what was attempted,
   * not what scored.
   */
  referencesCount: number;
  identitySetCount: number;
  spend: QaSpend;
  latencyMs: number;
}

const faceOf = (c: FaceCrop | null) =>
  c && {
    confidence: c.confidence,
    sizeFrac: Number(c.sizeFrac.toFixed(4)),
    small: c.small,
  };

/**
 * A GENERATE's face against the photographs of her it was built from, and against her held-out set
 * (qa/identitySet.ts). A target whose bytes could not be fetched is recorded with no face, not dropped,
 * so the record says what was attempted. Every face box and every embedding runs concurrently.
 *
 * Each photograph's id rides on its own face-box and embedding calls, so a failure's log line names the
 * photo (the render's too, when the caller passes it) — and each comparison carries why it has no
 * distance (`IdentityMiss`). No retry and no change to the crop: the instrument is R0.a's to replace.
 */
export async function observeGenerateIdentity(
  output: { bytes: Buffer; mimeType: string; assetId?: string },
  targets: (IdentityTarget & { bytes: Buffer | null; mimeType: string })[],
): Promise<GenerateIdentityObservation> {
  const started = Date.now();
  const meter = new SpendMeter();
  const crop = async (
    bytes: Buffer,
    mimeType: string,
    label: string,
    assetId: string | undefined,
  ) => {
    const r = await faceCrop(bytes, mimeType, label, assetId);
    meter.vision(r.usage);
    return { crop: r.crop, miss: r.miss };
  };
  const [out, faces] = await Promise.all([
    crop(output.bytes, output.mimeType, "generate", output.assetId),
    Promise.all(
      targets.map(
        (t): Promise<{ crop: FaceCrop | null; miss: IdentityMiss | null }> =>
          t.bytes
            ? crop(t.bytes, t.mimeType, t.comparedAgainst, t.assetId)
            : Promise.resolve({ crop: null, miss: "unfetched" }),
      ),
    ),
  ]);

  // No face in the render → nothing to compare, and no embedding is paid for.
  const toEmbed = out.crop
    ? [
        { crop: out.crop, assetId: output.assetId },
        ...faces.map((f, i) => ({ crop: f.crop, assetId: targets[i].assetId })),
      ]
    : [];
  const vecs = await Promise.all(
    toEmbed.map((x) =>
      x.crop ? embedImageBytes(x.crop.bytes, x.assetId) : null,
    ),
  );
  meter.embed(toEmbed.filter((x) => x.crop).length);
  const [outVec, ...targetVecs] = vecs;

  // The render always has bytes, so its miss is a face box's — or, once cut out, its embedding's.
  const outputReason: GenerateIdentityObservation["outputReason"] = out.crop
    ? outVec
      ? null
      : "embed_failed"
    : out.miss;

  const comparisons = targets.map((t, i): IdentityComparison => {
    const v = targetVecs[i];
    const distance =
      outVec && v ? Number(embeddingDistance(outVec, v).toFixed(4)) : null;
    return {
      comparedAgainst: t.comparedAgainst,
      assetId: t.assetId,
      distance,
      face: faceOf(faces[i].crop),
      reason:
        distance !== null
          ? null
          : (faces[i].miss ?? outputReason ?? "embed_failed"),
    };
  });
  const scored = (group: ComparedAgainst) =>
    comparisons.flatMap((c) =>
      c.comparedAgainst === group && c.distance !== null ? [c.distance] : [],
    );
  const mean = (group: ComparedAgainst) => {
    const d = scored(group);
    return d.length
      ? Number((d.reduce((a, b) => a + b, 0) / d.length).toFixed(4))
      : null;
  };

  return {
    method: "face-crop/multimodalembedding@001",
    caveat: DEAD_RULER_CAVEAT,
    outputFace: faceOf(out.crop),
    outputReason,
    comparisons,
    referencesMean: mean("references"),
    identitySetMean: mean("identity-set"),
    referencesCount: scored("references").length,
    identitySetCount: scored("identity-set").length,
    spend: meter.total(),
    latencyMs: Date.now() - started,
  };
}
