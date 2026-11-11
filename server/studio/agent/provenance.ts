/**
 * studio/agent/provenance — where a library row came from, in the three words the planner reads.
 *
 * The column is `media_assets.origin` ('upload' | 'generated' | 'connected' | 'discovery'). The
 * picker already folds it into three names (studio/mediaList.ts `MEDIA_ORIGINS`), and these are
 * the same three, with the same members — a test pins the two equal, because this module must not
 * import mediaList: mediaList reaches lib/mediaStore, which builds a GCS client at module load, and
 * the planner's graph stays free of anything that opens a connection (studio/agent/types.ts).
 *
 *   camera      she shot it — an upload, or a camera-roll import (origin 'upload')
 *   made-here   Studio generated it (origin 'generated')
 *   synced      it came off one of her accounts (origin 'connected' or 'discovery')
 *
 *   stitched-here  a COMPILATION the stitch engine wrote — made here, but of several things, some
 *                  of which may be b-roll or a branded segment (doctrine PR, 22 Sep 2026)
 *
 * ─── WHY A FOURTH WORD, AND WHY IT IS INFERRED (doctrine PR, 22 Sep 2026) ────────────────────
 *
 * On device, "use my real footage" cast a prior stitched output — which held a branded OWN YOUR
 * GAME segment — as "your clip". A trust problem, not taste: a compilation is not her footage. But
 * `origin` cannot say so: the stitch publisher (video/materialize.ts `publishStitchOutput`) writes
 * `origin: 'generated'`, exactly as a generated clip does. What tells them apart is on the row:
 *
 *   - a generated clip carries `generation_job_id` (studio/jobs.ts `recordGeneratedAsset` requires
 *     one); the stitch publisher writes it NULL on purpose (the link lives on
 *     studio_stitch_jobs.output_asset_id);
 *   - the stitch publisher's path is `athletes/<id>/studio/stitch/<job>/output.mp4`.
 *
 * EITHER witness makes a made-here video `stitched-here`, so a future publisher that starts writing
 * job ids does not silently re-admit compilations, and neither does one that moves the path.
 * cast.test.ts pins the fold against the REAL publisher's row, not a hand-shaped one.
 *
 * The caster never OFFERS a stitched-here row (cast.ts `listClips` excludes it — enforcement); the
 * label exists so a stitched row she PICKS herself is still read for what it is, and so the plan
 * eval can see the exclusion hold.
 *
 * LABELS FIRST (C2 Half B). Nothing ranked on these until the doctrine PR. They are on every
 * library line so that when it does, the planner has already been reading them. Ground truth on
 * the measured library (22 Sep 2026): every clip is `made-here` or `camera` — there is no synced
 * video row at all — which is exactly why the label has to exist before "real footage first" can.
 */
export const PROVENANCES = [
  "camera",
  "made-here",
  "synced",
  "stitched-here",
] as const;
export type Provenance = (typeof PROVENANCES)[number];

/** origin column value → provenance. The same fold as mediaList's MEDIA_ORIGINS, pinned by test. */
export const PROVENANCE_OF_ORIGIN: Readonly<Record<string, Provenance>> = {
  upload: "camera",
  generated: "made-here",
  connected: "synced",
  discovery: "synced",
};

/** A row's provenance from its origin alone, or null for an origin this module does not know (never guessed). */
export const provenanceOf = (
  origin: string | null | undefined,
): Provenance | null =>
  origin ? (PROVENANCE_OF_ORIGIN[origin] ?? null) : null;

/** The stitch publisher's path, as video/materialize.ts writes it. A segment match, not a prefix: the athlete id precedes it. */
export const STITCH_OUTPUT_PATH_RE = /\/studio\/stitch\//;

/**
 * A row's provenance, read off the whole row: `provenanceOf(origin)`, except that a made-here VIDEO
 * with no generation job or under the stitch path is `stitched-here` (see the header). A photograph
 * is never stitched — the stitch writes only mp4s.
 */
export const provenanceOfRow = (row: {
  origin: string | null | undefined;
  isVideo: boolean;
  generationJobId: string | null | undefined;
  gcsPath: string | null | undefined;
}): Provenance | null => {
  const base = provenanceOf(row.origin);
  if (base !== "made-here" || !row.isVideo) return base;
  const noJob =
    row.generationJobId === null || row.generationJobId === undefined;
  const underStitchPath = STITCH_OUTPUT_PATH_RE.test(row.gcsPath ?? "");
  return noJob || underStitchPath ? "stitched-here" : base;
};

/** The words on the planner's line. Plain English, two of them hyphen-free. */
export const PROVENANCE_LABEL: Readonly<Record<Provenance, string>> = {
  camera: "her camera",
  "made-here": "made here",
  synced: "synced from her accounts",
  "stitched-here": "stitched here",
};

/** The one account whose name the line says (PR 4 B2b): a reel she posted is "her instagram". */
export const INSTAGRAM_LABEL = "her instagram";

/**
 * The planner's words for a row: `PROVENANCE_LABEL`, except that a synced row off Instagram names
 * the account — "from: her instagram" is what rule 3's own-footage order reads (camera > her
 * instagram > made here). Any other synced platform keeps the generic words.
 */
export const provenanceLabelOf = (
  provenance: Provenance,
  platform: string | null | undefined,
): string =>
  provenance === "synced" && platform === "instagram"
    ? INSTAGRAM_LABEL
    : PROVENANCE_LABEL[provenance];
