/**
 * mediaDetailLogic — MediaDetail's rules, as pure functions (PR 9.5, F22 B4).
 *
 * "Analyzed" for a VIDEO means read as a clip — `vision.beats` is an array — never merely that the
 * poster frame was tagged (`vision` present). Every video row has poster tags from the photo lane, so
 * keying on `vision` alone said "Analyzed" over a clip the planner could only append whole. For an
 * IMAGE, `vision` present is analyzed, unchanged (R-5).
 *
 * ⚠️ MUTATION (mediaDetailLogic.test): key a video on `vision` — "poster-only video shows Analyzed"
 * reds by name.
 */
export interface AnalyzedInput {
  isVideo: boolean;
  /** The row's `vision` object, whatever the tagger wrote; only `beats` is read here. */
  vision: object | null | undefined;
  /** The server's clip-read state when it serves one; the beats array decides when it does not. */
  read?: { state: string } | null;
}

export function analyzedOf(d: AnalyzedInput): boolean {
  const v = (d.vision ?? null) as { beats?: unknown } | null;
  if (!d.isVideo) return !!v;
  if (d.read) return d.read.state === "done";
  return Array.isArray(v?.beats);
}

/** The strip's pending word for a video not yet read — it is not "Analyzing…" unless a read runs. */
export const analyzedPendingLabel = (
  isVideo: boolean,
  read?: { state: string } | null,
): string =>
  isVideo && read?.state !== "reading" ? "Not read yet" : "Analyzing…";
