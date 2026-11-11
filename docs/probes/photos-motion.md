# PR 5 — photos into motion — ledger

Branch `studio/photos-motion` off origin/main 2830656 (ingest-flip #564 merged). Test athlete
`3811cedd`. Spec: docs/specs/studio-video-use-cases.md, "Photos into motion — nothing generated".
Everything here is editing: no model call, no spend. Probes under gitignored
`probe-out/photos-motion/`, read-only on the database, the test athlete only.

Scope as landed: **Part A only** (A1 motion, A2 beat grid, A3 one look). Part B (layouts) is not
built in this PR. Part C (cutout, parallax, mask jobs) was dropped entirely by Adi on 22 Sep 2026:
no card.

## PR 6's naming contract (Adi, 22 Sep 2026)

- **Image-item motion, final wire names:** `"dolly"` (D2's centred push-in; renamed from `"pan"` on
  the wire, with a parse alias so stored specs keep working), `"zoom"` (to a point), `"sweep"`
  (across), `"punch"`. Optional `focus {x, y}`, fractions of the upright photo. `"pan"` stays
  reserved for the generated-shot camera vocabulary in `server/studio/agent/capabilities.ts`, and is
  refused on image items once the alias window closes.
- **Plan-level in PR 6:** `look`, the track id, `onBeat`.
- PR 6 exposes all of these to the planner as capability entries. The Board chips already carry the
  human names (Push-in / Zoom in / Pan / Punch) and do not change.
- Why: today "pan" means three things — a planner image item's push-in (`plan.ts`), a camera pan in
  a generated shot (`capabilities.ts`), and the Board's "Pan" chip, which is `"sweep"` on the wire.

## What was built

| commit  | item                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------- |
| 25e9aab | A1 — zoom / sweep / punch toward a point; tap-to-point on the Board                                     |
| 685f39a | A2 — beat detector (spectral flux, comb tempo, joint period + phase, octave check), pure TS             |
| 7c79f36 | A2b — bed grids in beds.ts and /stitch/options; Board music, On the beat, snapped holds, per-row badge  |
| 2032e0d | A3 — one look: per-photo correction (neutral-pixel gray-world + exposure) then the set's look, in sharp |
| 4196065 | A1 follow-up — untapped zoom / punch heads for the upper middle (0.5, 0.28); attention dropped          |

Every mutation reds by name (listed in each commit). §11 (Debian ffmpeg 5.1.9, node:20-slim,
linux/amd64) ran on every commit that touched still.ts or beatGrid.ts.

**Part A gate** on 2032e0d: 434 suites / 8,512 tests / 1 red — affiliationSync's year-only
from/to, the house flake; 8/8 on the isolated re-run. 4196065 ran still.test, stitchRunner.test
and §11 only.

## Predictions against what happened

- **A1 — attention finds her ≥ 4 of 6: MISSED, 0 of 8.** libvips' attention point landed on the
  crowd, a ball, the floor, headline text and her shin across 8 photos of her. It is a saliency map,
  not a person finder, and her photos have busy backgrounds. Her face sat within ~0.1 of
  (0.5, 0.28) in all 8, so that framing prior replaced it (4196065). A real person finder would be
  a model call and is not built.
- **A2 — tempo within 0.5 BPM, phase within 1 frame:** held, with margin (0.01 BPM, ≤ 6 ms on
  lavfi fixtures). The first cut had the onset-latency correction backwards and read every fixture
  28 ms early; the tests caught it.
- **A2 — the six beds are 70–100 BPM:** 5 of 6. tokyo-sunset measures 63.
- **A3 — warm and cool casts within 6/255 under Natural:** held. Black and white is now held to a
  grey control rather than a fixed number, because the channel spread is 4/255 on ffmpeg 9.0.1 and
  7/255 on 5.1.9. Also found: sharp runs `modulate` before `linear` whatever the call order, so the
  grade renders in two passes.

## The bed grids

Measured on the installed `.m4a` files. md5 and size match the bucket objects for all six (checked
by Adi, 22 Sep 2026). Each bed's two halves agree within 0.04 BPM and 12 ms.

| bed                | BPM  | beat 0  |
| ------------------ | ---- | ------- |
| walking-away       | 81.5 | 0.012 s |
| doodles            | 85   | 0.004 s |
| tokyo-sunset       | 63   | 0.951 s |
| hope-on-repeat     | 85   | 0.012 s |
| we-drove-all-night | 76   | 0.001 s |
| only-human         | 85   | 0.012 s |

tokyo-sunset's 0.951 s is −1 ms modulo its 0.952 s period. **By-ear check against a click on the
grid: PENDING.** Renders are in `probe-out/photos-motion/beats/ear/<bed>-grid.m4a`.

Below 70 BPM a photo is held for the fewest beats that make 1.5 s (Adi). At 63 BPM the server's
1 s floor already forces two beats; the rule bites at 60 BPM.

## A4 — the live render

Sources, Adi's call (option 3): her 2 real uploads (`7fe0b609`, `37df2f85`) plus 4 identity-bound
generated photos (`f0e9aa91`, `132e7373`, `904d8bf4`, `493166ca`; bound per S2's own predicate).
**Her upload library holds only 2 real photos of her** — the rest are a different player and product
shots. That is the thin-library case: a 6-photo "every pixel is hers" edit cannot be built from real
photos of this athlete today.

## Cards (not built)

- **PR 8 — tracks for hype edits.** Every bed is lo-fi at 63–85 BPM; hype edits need 110–130 BPM
  coverage. Licensing is Mia's.
- **Transitions.** Native to xfade on 5.1.9: fade, fadewhite (flash), fadeblack (dip), wipes,
  slides, zoomin, hblur, dissolve, pixelize, circle / radial. A whip needs a hand-built chain
  (slide + dblur). A photo-stack flip is a perspective / rotate graph, frame-free but complex. Light
  leaks and film burns need overlay frames, which is an asset pack and a licensing question like the
  beds.
- **Beat grid for her own video's sound** (`bedAssetId`): would need runtime detection; her own
  sound is usually speech or ambience.
- **Grade clips, not only stills.** That is the engine's conform chain (plan.ts), its most
  regression-prone file.
- **Brand palette → look.** Needs brand-profile data mapped to a grade; a taste call.
