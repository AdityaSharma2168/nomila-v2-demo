# Card — one Studio media picker (card 3 graduates)

**Status:** BUILT 21 Sep 2026 on `studio/media-picker` (cut from #553 → 1de3409). Ledger and commits:
`docs/plans/studio-media-picker.md`. Two things changed from this card, both Adi's decisions:
- **Search ranks itself**, not through `searchMedia`: one embedText, then cosine over the rows our
  own predicate already let through (the route header says why).
- **Board and Agent offer uploads + Made here**; synced posts stay off them until the EXIF
  re-measure (`docs/studio-media-picker-followups.md` card 1).

Open-cards card 3 is resolved by it.

## What she has today — three pickers, three lists, three defects

| Surface | Source | Defect |
|---|---|---|
| Board, YOUR UPLOADS | `useMyMedia("photos", {source:"upload"})` (StoryboardTab) | Page 1 of 24, `fetchNextPage` never called (card 3). Sorted `posted_at DESC NULLS LAST`, so photos made in Studio sink. |
| Agent, PHOTOS / PRODUCTS / VIDEOS | the Board's list, plus `/stitch/clips` | The same 24-cap. No search, so a library of hundreds can't be found in. |
| Video tab, clips + photos | `GET /studio/stitch/clips`, `GET /studio/stitch/stills` | Newest 60, no search, no paging past 60. |

`/me/media` is shared and is not ours to change. `/stitch/clips` and `/stitch/stills` already show the
mould: a Studio-owned list whose eligibility is the consumer's own.

## The build

**One component, `StudioMediaPicker`, mounted in all three surfaces** — the Board strip, the Agent's
three strips, and the Video tab's two.

- **Compact strip:** the newest N, each row by its own date (`COALESCE(posted_at, ingested_at)`), as
  the strips are today.
- **"View more" → a modal:**
  - **Search:** a box backed by `GET /studio/media/search?q=` (below).
  - **Filter chips:** Photos · Clips · Made here · Uploaded. Chips combine; each surface sets which
    it offers.
  - **Pagination past 24:** a cursor on `(COALESCE(posted_at, ingested_at), id)`. A page that ends on
    an undated row keeps paging — the null-cursor bug `/me/media` has (media.ts) is not repeated.
  - **Upload in place:** through the existing `useUploadMedia`. A new upload lands at the top and is
    selectable at once.
- **`context` prop, reserved now:** `"board" | "agent-pick" | "agent-product" | "video-clip" |
  "video-still"`. It decides the list's eligibility today. It is reserved for showing
  **caster-eligibility reasons** later ("nobody is tagged in this photo — it can't be a shot of you;
  add it as a product"), the picker-side twin of `picksWithoutHer`.

## Server — in the `/stitch/clips` mould, ours, athlete-scoped

- **`GET /studio/media?kind=photos|clips&origin=…&cursor=…`**
  - Photos go through `studio/photoPredicate.ts` (`herPhoto`); clips through the stitch's own
    eligibility (`VIDEO_TYPES`, mp4 bytes behind `gcs_path`).
  - A `context` narrows further: `video-still` adds `STILL_CONTENT_TYPES`.
  - Signed thumb, plus signed full url where the surface previews.
- **`GET /studio/media/search?q=&kind=…`** wraps the shared `searchMedia` (not changed), then:
  - **re-loads every hit through our own predicate**, because searchMedia filters on neither
    `media_type` nor `deleted_at` and passes untagged rows as filler (studio/agent/cast.ts header,
    facts 1–3);
  - is one `embedText` per query, fractions of a cent, debounced client-side, never on each keystroke.
- Both routes are declared before any `/:id` route. There is no DDL. `/me/media` is untouched.

## Tests (the house pattern)

- **PGlite, per route:**
  - hers only, where another athlete's row is the same answer as none;
  - deleted, child and wrong-type rows are excluded;
  - the cursor walks past 24 and past an undated row;
  - search re-filters a hit searchMedia would have returned.
- **Named mutations:** drop the athlete clause (tenancy); drop the re-filter after searchMedia (a
  video with a poster, or a deleted photo, appears).
- **Component:** a renderer suite for the strip and modal (TimelineTrack's harness shape). Search
  debounces; paging appends; upload-in-place selects.

## Out of scope for it

Changing `searchMedia`'s ranking (shared, Mia's). Tagging photos that enrichment has not reached.
Anything about what the caster casts.
