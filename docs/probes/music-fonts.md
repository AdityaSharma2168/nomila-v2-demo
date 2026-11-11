# PR 8 — music tracks, the recommender, caption fonts — ledger

Branch `studio/music-fonts`. The data half (fonts catalogue, `tracks.ts`, `recommend.ts`) was built on
2830656 and rebased onto c70c2f9 (PR 5 merged); the Board wiring (items 4–6) is built on top.

## Decisions, with who made them

- **The four tracks are Artlist, Adi's own sourcing (22 Sep 2026).** Not CC0: `license: "artlist"`,
  a named plan holder, and a `brandSafe` switch that is true pending Mia's reading of the terms. They
  are NOT added to `STITCH_BEDS`, whose suite admits CC0/PD only; the two catalogues are joined where
  a name is resolved (`beds.ts`), and the suite asserts no name is in both.
- **Row prose doubles as feel input (Adi).** The Board has no feel field. The Suggested track is read
  from her row sentences (`feelFromRows` → `POST /studio/stitch/music/suggest`). The route takes a
  list of strings, not rows, so **PR 6's plan-level feel can replace this source later without
  touching the route** — only the client's `feelFromRows` call changes.
- **Preselected until touched (Adi).** The suggestion is the bed in effect until she taps any Music
  chip ("None" included); from then on her pick stands and the suggestion never re-asserts
  (`musicLogic.effectiveBed`).
- **Brand work is fail-closed off the objective.** `OWN_CONTENT_OBJECTIVES` = grow-following, recap,
  concept. Anything else — a brand objective, a new one, a missing one — is brand work, and a track
  that is not `brandSafe` is never suggested or listed for it. Every Board today is grow-following.
- **Beds get no mood tags in this PR (Adi).** The recommender ranks the four tracks only; tagging the
  six beds is an ear job (card below).

## The track grids

Measured offline with PR 5's `beatGrid.ts` (read via `git show`, run from probe-out), whole track and
each half independently. Ear files: `probe-out/music-fonts/ear/`.

| Track           |    BPM | First beat | Half-split                           | Ear check (Adi, 22 Sep)           |
| --------------- | -----: | ---------: | ------------------------------------ | --------------------------------- |
| walking-around  |  84.00 |    0.696 s | ✅ 0.02 BPM, 5 ms                    | on the beat                       |
| status          |  89.99 |    0.328 s | ❌ half B 327 ms off (half a period) | on the beat at 5 s and 130 s      |
| with-your-hands | 114.99 |    0.086 s | ✅ 0.00 BPM, 4 ms                    | on the beat                       |
| save            | 120.00 |    0.092 s | ✅ (detector said 60.00 — its floor) | the 120 grid lands on every click |

## Caption fonts — the measured holes

Every font rendered against the whole caption allowlist, typed and uppercased, beside a character
known to be missing (the method captionRender.test uses for Outfit). Outfit, Anton, Jost and Bodoni
Moda draw all of it. **Barlow Condensed lacks Ĳ ĳ; Instrument Serif lacks ¤ ¦ ¬ ± ² ³ ¹ ¼ ½ ¾.** These
are `CAPTION_FONT_HOLES`; a caption in that font containing one is refused naming the characters
(the general allowlist is unchanged, so a stored caption with no font is judged as before). The suite
re-measures every font in both directions. Anton and Instrument Serif have one face each, so their
Clean and Bold styles differ in case and plate, not weight.

## Cards (not built)

- **Row 1 is never "on the beat" on these tracks.** The Board starts the track at 0; a track whose
  beat 0 is past half a frame (all four — up to 0.696 s) leaves the first photo starting between
  beats. Every CUT still lands on the grid. Fix: start the track at `firstBeatSec` (`bedStartSec`).
- **BPM coverage gap.** 90–110 has only status (at the edge); 110–130 has with-your-hands and save.
  Wanted: one track around 100–108 and one around 124–130.
- **Tag the six beds' moods and energy** — by ear, same drill as the tracks.
- **Prod upload** — see `docs/plans/studio-video-flip-checklist.md`: the tracks exist only in dev's
  bucket.
- **Per-platform loudness.** The tracks sit at −8.4 to −10.1 LUFS integrated.
