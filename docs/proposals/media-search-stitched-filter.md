# Proposal for Mia — refuse stitched compilations inside `searchMedia` (Shape A)

**Status: written, NOT applied.** `server/services/mediaSearch.ts` is shared code (kits, hero picks,
the picker's search). The Studio lane carries the in-lane form today — Shape B, an escalating k in
`server/studio/agent/library.ts` (`LIBRARY_SEARCH_KS`) — and this proposal is the home it should
move to once B has measured the effect.

## The defect

`searchMedia` filters on athlete · stored · top-level and NOT on media type, so an athlete's videos
come back among her "photos". On the measured library (enrichment eval, 22 Sep 2026) 21 of the top
24 for a recap brief were STITCHED COMPILATIONS — the outputs of her own timeline stitches — which
the planner's library refuses AFTER the k is spent: 3 of 16 places filled, all three off-sport.

## The change — one optional filter, default off

```diff
 export interface MediaFilters {
   brandSafe?: boolean;
   shotTypes?: string[];
   excludeBrands?: string[];
   preferBrandSafe?: boolean;
   athletePresent?: boolean;
   playableVideo?: boolean;
+  /** Drop the outputs of Studio stitches — a compilation of her clips is never one of her photos or clips. */
+  excludeStitched?: boolean;
 }
```

and in the SELECT's predicate, when set:

```ts
NOT (origin = 'generated' AND (generation_job_id IS NULL OR gcs_path LIKE '%/studio/stitch/%'))
```

— the SQL twin of `provenanceOfRow`'s stitched arm, already written as `notStitchedHere` in
`server/studio/agent/cast.ts` (`listClips`), and held equal to the TS fold by cast.test.ts.

**Blast radius.** Nothing else reads the new flag; every existing caller's query is byte-identical.
The flag is passed only by `library.ts`. Predictions: her-room fills at k = 24 on the measured
brief; `LIBRARY_SEARCH_KS` collapses back to one step and the overfetch is deleted; the doctrine
eval's recorded libraries do not change (Shape B already fills the same room with the same rows —
the ranking is unchanged, only the truncation point).

**What it does not fix, and B does:** a top-k crowded by rows the offer refuses for any OTHER
reason (untagged, `athlete_present` null, the subject guard). B's loop covers those; A covers the
one named. Keep B's loop until the guard is retired with the prompt fix, then remove it.
