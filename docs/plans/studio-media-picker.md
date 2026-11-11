# The shared Studio media picker — ledger

Branch `studio/media-picker`, cut from origin/main `1de3409` (#553, B-t2v, a real merge commit whose
tree equals 4af8b3e — nothing drifted). Card: `docs/studio-media-picker-card.md`. Follow-ups:
`docs/studio-media-picker-followups.md`.

## Decisions (Adi, 21 Sep 2026)

| # | Decision |
|---|---|
| G1 | **Search ranks itself.** Our predicate first, then one embedText and cosine over what passed. `searchMedia` is untouched. Why: it cuts a fixed top k before any filter a mount needs (an uploads-only search on a synced-heavy library could come back near-empty), it falls back quietly to a popularity list, and 30% of its score is hero/views, which is wrong for choosing by eye. A null embed is a 503 with a sentence. |
| G3 | **Board and Agent: uploads + Made here. Video tab: all three.** Synced posts stay off the Board and Agent until the EXIF re-measure (followups 1). The synced chip says "From your accounts". |
| — | Props: `selectedIds` in, whole-row `onPick` out, `renderTile` per mount. `context` is typed and reserved. |
| — | Keyset cursor on `COALESCE(posted_at, ingested_at), id`: it walks the undated tail, and the key travels as text with microseconds. Search is one page (60), no cursor. Search is sent on submit, never on a debounce. |
| — | HEIC: filtered on the server for the Video tab's stills. Board/Agent unmarked (followups 2). An upload in place is picked only if the server lists it for the mount; otherwise she is told why. |
| — | Rejected generations are offered in v1, as /stitch/* offers them. |
| A | "Back to the plan" is a head link with an inline confirm (Adi's choice over a banner). |

## Commits

| # | Commit | What | Tests | Revert checks (all red by name) |
|---|---|---|---|---|
| 1 | 2866c03 | `herClip` beside `herPhoto`; /stitch/clips reads it | hold 155/155 | RC1 → "offers exactly what a stitch accepts…" |
| 2 | de3d115 | GET /studio/media + `studio/mediaList.ts` | +13 | RC2a tenancy · 2b undated tail · 2c HEIC · 2d microseconds · 2e origin |
| 3 | 6d0aab3 | GET /studio/media/search, ranked by similarity alone | +10 | RC3a predicate · 3b 503 · 3c cut-before-filter · 3d tenancy |
| 4 | 6167842 | `mediaPickerLogic.ts` + `use-studio-media.ts` | +13 | RC4a pinning · 4b synced on Board · 4c chips · 4d upload rule |
| 5 | a7334fa | `StudioMediaPicker.tsx` | +10 (renderer) | RC5a search on submit · 5b refresh after upload · 5c strip pinning |
| 6 | ffe8953 | Board mount | wiring | — |
| 7 | 74d06be | Agent mount (three strips) | wiring | — |
| 8 | 657c911 | Video tab mount + picked rows in the timeline's lookups | wiring | — |
| B/C | 5a2f098 | One row: "Redo this shot" / "Make just this one" | +13 | RC-B1 admit skipped · B2 stale quote · B3 fresh per piece |
| A | de3be15 | "‹ Back to the plan" | +4 | RC-A1 running · A2 holds-work |
| 3′ | d99504a | Lint follow-up: the embed timeout const below the imports (7 import/first warnings → 0) | — | — |

**Gate (21 Sep 2026):** bare `npm test`, 17 batches — **408 suites / 7970 tests / 0 failed**. It started
before d99504a (a const moved in routes/studio.ts), so all 12 `server/routes/studio*.test.ts` suites were
re-run on d99504a: 415/415. tsc clean on both configs. Lint 0 errors, with pre-existing files at main's
warning count. Prettier parity exact.

**RC3d changed meaning under G1.** The recon predicted a tenancy mutation that could NOT go red:
searchMedia was athlete-scoped, so dropping the clause from our re-load alone would stay green. With
own-ranking there is one query, so dropping the athlete clause now reds "search is hers only". That
non-mutation no longer exists.

## Observed behaviour changes (not bugs fixed on purpose — they come with the new list)

- **Deleted photos leave the Board and Agent strips.** `/me/media` never filtered `deleted_at`.
- **Photos and clips made here stop sinking.** Each row is ordered by its own date, not `posted_at`
  alone.

## Facts worth keeping

- React Navigation 7.5.5 `navigate()` pushes a screen it is not already on. The seeded Board sits
  ABOVE the Agent screen, so "Back to the plan" is a pop (followups 4 for the banner it strands).
- A single-row redo is `runBoardPieces` on a shorter list, and its quote is `boardQuote([row], …)`,
  so its refusals are the board's own sentences.
- `StudioHomeScreen.tsx` and `routes/studio.ts` are prettier-dirty on origin/main: edited in place,
  never reformatted.
