# Studio Agent — cards found while planning the Agent tab

Written 21 Sep 2026, while planning the Agent tab. Six cards, each recorded here so it is raised on
its own terms rather than smuggled in beside a feature: a defect since fixed (1), a missing
capability the Agent no longer needs (2), a defect still open (3), a decision (4), and two from the
device checks — an enrichment question answered (5) and an enrichment defect open (6). A short
ledger of casting decisions closes the file.

---

## 1 · A video with no poster was set down by enrichment for good — FIXED, card moved

**Status:** FIXED on main by #549 (`987cae0`): the enrichment gate, and the one-time statement that
revived the 4 rows already set down (run 2026-09-21). Root cause, fix and the note left for Mia now
live in **`docs/studio-video-enrichment-card.md`**.

This card was wrong about two things, and the move corrects both: it framed the defect as
uploads-only (generated clips land posterless too, and at least 2 of the 4 were clips made in
Studio), and as Mia's to schedule (Studio fixed it). What stays here is what the Agent needs.

**Coverage, measured before the fix** (read-only aggregate, one athlete):

| media_type | stored | castable | abandoned | reason         |
| ---------- | -----: | -------: | --------: | -------------- |
| IMAGE      |    364 |      364 |     **0** | —              |
| VIDEO      |     33 |       29 |     **4** | all `attempts` |
| total      |    397 |      393 |         4 | 1.0%           |

No photograph was ever abandoned, so the Agent's photo-only casting was never short a row to this.

**Evidence — the ten attempts went in one cron request, not over ten firings:**

| upload → abandoned | window crosses a quarter-hour | abandoned, seconds past the quarter-hour | her uploads in the window |
| -----------------: | :---------------------------: | ---------------------------------------: | ------------------------: |
|               61 s |              no               |                                     64 s |                         0 |
|               61 s |              no               |                                     74 s |                         0 |
|              109 s |              yes              |                                     70 s |                         0 |
|              182 s |              yes              |                                     70 s |                         0 |

All 4 rows spent their 10 attempts 61–182 s after being written, and each was set down 64–74 s after
a quarter-hour mark, which is the enrichment cron's schedule. None of her uploads landed in any of
those windows. Ten separate cron firings would need at least 135 min, and the per-upload kick is
ruled out. It was one request's loop. Two rows were written 3 s and 13 s after the quarter-hour,
while that request was already running; each pass re-reads the candidates, so a row that lands
mid-request is taken by it.

### Still true for the Agent: a row with no tags is unrankable, and gets cast as filler

The fix removed the abandoned rows, not the untagged ones. A photograph uploaded a minute ago, before
the cron has reached it, has no `metadata.vision` and no `metadata.embedding` either — and the
Agent's planner casts through `searchMedia`, which does not exclude such a row. It **scores exactly
zero and sorts last**, which is worse than being excluded, not better:

```ts
// mediaSearch.ts — EVERY filter guards on `x.tags &&`, so a row with NO tags passes all of them
if (f.athletePresent && x.tags && !x.tags.athlete_present) return false;
// ...and then scores as nothing
const hero  = x.tags ? heroScore(x.tags) : 0;                 // 0
const s     = simN(x);                                        // 0 — no embedding
score = q ? 0.7 * s + 0.3 * (0.6 * hero + 0.4 * viewsN) : …;  // → 0.12 × viewsN
```

For an upload with no likes or comments `viewsN` is `log10(1)/7 = 0`, so the score is **0.000**. The
row is still in the candidate set and `searchMedia` returns the top `k` — so when the library holds
fewer than `k` rows that score above zero, **an untagged row is cast as filler**, silently, and it is
precisely the row we know nothing about. It is not invisible; it is unrankable — last, and last
still gets picked from a thin shelf.

⚠️ IT ALSO DEFEATS THE identity/b-roll SPLIT. `MediaFilters.athletePresent` is truthy-only —
`athletePresent: false` is a no-op, and a row with no tags passes the `true` case as well. So an
untagged row can be cast into an `i2v` item (Veo, the expensive arm) with nothing having established
that she is in it, or into a `broll` item with nothing having established that she is not.

**So the caster (Agent commit 6) must:** post-filter on `athletePresent` rather than trusting the
filter, and refuse a row with no tags for BOTH castable kinds. A guard in our own code working around
a shared-module behaviour — not a change to `mediaSearch.ts`.

---

## 2 · A still cannot be a segment of a stitch — ABSORBED by PR C1 (stills), Board half BUILT as C1b

**Status:** CLOSED (21 Sep 2026). C1 merged (#552); the Board/Agent half is BUILT on
`studio/still-board` (PR C1b, `docs/plans/studio-still-board.md`) after flip checklist §11 passed on
Debian's ffmpeg 5.1.9 (7/7, both architectures). The record below stands.

**Status (as absorbed):** ABSORBED (21 Sep 2026). The stitch half is BUILT on `studio/still-clips` (PR C1): a
timeline position may carry `stillSec` ("this photo, held for N seconds", 1–8 s), resolved through
the caster's own photo predicate and encoded into a clip by the runner before the engine runs, at $0.
The Video tab can hold her photos. The Board/Agent half — a non-generating `still` row kind and the
planner's `image` un-refused — is **C1b**, a separate PR, gated on the still encode being checked on
prod's ffmpeg 5.1 (flip checklist §11). Design and measurements: `docs/plans/studio-still-clips.md`.

The text below is the card as it was written, kept for the record.

**Status (as written):** REAL constraint, correctly enforced, and a missing capability rather than a bug.

**What is true today.** `server/studio/video/materialize.ts` refuses it by design: `VIDEO_TYPES` is
`["VIDEO", "REELS"]`, and a timeline naming an IMAGE asset fails with `not_a_video` — which today can
only be a caller bug.

**Why it came up, and why it no longer blocks anything.** The planner was going to propose an
`image` item — "keep this photograph as it is, don't spend a clip on it". **`image` is out of v1**
(decided in review, 21 Sep 2026): a $0 item with no preview, no Board row kind and no path into a
stitch complicated admission, the handoff and execution for nothing the rest of the plan needed. It
stays reserved in the type union and the parser refuses it. v1's vocabulary is `i2v` · `broll` ·
`product`.

**What bringing `image` back would take** — this card. An ffmpeg still→clip step: loop the image for
N seconds at the target's fps, matching the target's dimensions and SAR, producing a real video input
the existing graph can join. It spends **no model money** — it is CPU — but it is not free work:

- the target's `fps`, `width`/`height` and SAR all have to be matched, and `scale=iw*sar:ih` is
  already a known trap on this path;
- it changes what `resolveClips` may accept, which is a money-adjacent contract;
- `assertTimelineFits` counts seconds and bytes over clips, and a synthesised clip has neither until
  it is made;
- a still has no audio track, which the concat/xfade graph has opinions about.

---

## 3 · The storyboard picker offers only the 24 most recently-captured uploads — cause found

**Status:** RESOLVED by the shared Studio media picker (`studio/media-picker`,
`docs/plans/studio-media-picker.md`). It graduated on 21 Sep 2026 into `docs/studio-media-picker-card.md`.
The Board, the Agent and the Video tab now list through GET /studio/media — paged past 24 by a
keyset cursor, each row by its own date, deleted rows excluded — with search, chips and upload in
place. The diagnosis below stands as the record.

**Status (as written):** REAL, unfixed, **its own card** — deliberately not part of the Agent PR.

**What she sees.** The Board's YOUR UPLOADS strip appears to accept only "certain" photographs.

**What it actually is — three intentional filters and one accidental one.**

Load-bearing and correct, leave them:

1. `media_type IN ('IMAGE','CAROUSEL_ALBUM')` — photos only. A board row is a still that becomes
   motion.
2. `origin = 'upload'` — what she deliberately put in, not her synced grid.
3. `athlete_id`, `status='stored'`, `parent_media_id IS NULL` — tenancy, and top-level only.

Accidental, and the whole of the symptom:

4. **`PAGE = 24`, and page 2 is never asked for.** `StoryboardTab` flattens `data.pages` and
   **`fetchNextPage` does not appear in the file**. There is no "load more" and nothing says anything
   is missing.

**CAUSE FOUND: wire `fetchNextPage`.** The earlier note on this recorded the symptom with the cause
unreproduced. The cause is that the infinite query is never advanced.

**The sharper edge.** Rows sort by `posted_at DESC`, and for an upload `posted_at` is the photo's
CAPTURE date, not its upload date (`postedAtFrom`, `routes/media.ts` — deliberate, so a photo shot
last summer stops winning every recency tie). So the 24 on offer are the 24 newest _photographs_,
not the 24 newest _uploads_: import an old shoot and it can land outside the window the moment it
arrives, which reads exactly like "it refused my photo".

**Not this branch.** Recorded here, owned separately.

**Related, and already fixed.** The Video tab's stitch picker had the same shape — page 1 of
`/me/media`, and generated clips (no `posted_at`) sorting after every dated video, which hid 9 of 31
of hers at random. It now reads Studio's own list (#549). The Board's photo picker is still this card.

**Not the Agent's shelf.** The picker offers her uploads; the Agent casts from her whole library —
see ledger F8. Picker ≠ caster is intentional.

---

## 4 · Saving an Agent plan — decided OUT of v1, and why

**Status:** DECIDED (Adi, 21 Sep 2026). Not a defect — a capability deferred on purpose, written
down so the decision is not re-opened from memory. Building it later is its own card and its own PR.

**What v1 does instead.** The plan travels in ROUTE PARAMS, in memory — the way `StudioMakeIt`
already carries everything its plan needs. The Agent screen's "Put it on the board" spends nothing;
it navigates to the Board with the cast items as a seed, the Board's rows start from that seed, and
the Board's own effect re-quotes them. "Make the board", behind plan admission, stays the only door
that spends. Nothing about the plan is stored, so leaving the Board loses it — exactly as a board
built by hand is lost today.

**Why not a fourth `ENTRY_KIND` on `studio_session_entries`** (the design first briefed). Four
reasons, each read from the code rather than assumed:

- **(a) Threads leak into Create Anything.** An entry needs a `studio_sessions` row, and
  `listSessions` (`server/studio/sessions.ts:631`) lists every row with no filter on entry kind. So
  every agent run would appear in Create Anything's Threads list, untitled, and bump `updated_at` —
  and the Create Anything door resumes her latest open thread, which would be an agent thread whose
  only entry `readSession` skips as an unknown kind (`sessions.ts:1042`). She would open an empty
  thread. This reason alone kills it.
- **(b) The payload holds no prose.** Mila's entries carry ids and closed codes only
  (`sessions.ts:276`, `shared/schema.ts:1871`). A plan's beats and directions are prose, so the
  Board's rows would have to be re-read from each preview's frozen brief — a new read path — and the
  preview ids in the payload have no FK, so once the previews are swept (`PREVIEW_TTL_MS`, 30 min)
  the entry can seed nothing.
- **(c) Append-only fights re-quote-on-approve.** `appendEntry` never updates a row. The Board's
  re-quote mints fresh preview ids the entry can never record, so it could never say what actually
  ran.
- **(d) The Board has nothing to persist into.** Its rows are `useState`, so a stored plan would
  seed a surface that forgets it on unmount.

**What building it properly takes, when there is a reason to.**

1. Its own table (athlete-scoped, `ON DELETE CASCADE` from `athletes`), holding the ask she typed
   and the cast items. ⚠️ Storing model-written prose is itself a decision: the sessions module
   refused prose deliberately, and a beat is model text derived from her words.
2. The DDL through `scripts/db-migrate.sh` — the migration and `shared/schema.ts` in ONE commit,
   because the drift gate compares names.
3. A read route scoped by `req.athleteId`; the Board seeds from it exactly as it seeds from params.
4. Quotes are never stored. Re-opening a saved plan re-quotes, the same as a fresh seed.
5. Its own PR and its own review — never folded into the Agent card.

**What would make it worth building.** She needs to leave a plan and come back to it before making
it, or a plan must be reviewable by someone else. Neither is a v1 need.

---

## 5 · Are her object shots tagged as having her in them? — ANSWERED: no systemic fault

**Status:** SETTLED by the corrected count (21 Sep 2026). Her library simply holds few scenes;
nothing is owed to enrichment on this evidence. Kept for the record and the method.

**The corrected count** (word boundaries; one athlete; counts only). Of the 184 castable photos
whose description names an object (ball, bottle, shoe, jewellery, trophy…): **182 are tagged with
her in them, 2 without**. Of the 182, **164 mention no hand** — action (85), portrait (44) and
lifestyle (16) shots of her WITH a ball, which is correct tagging — and **18 mention a hand**, the
upper bound on hand-in-frame object shots (in a portrait, "hand" is usually just hers). So the scene
shelf is small because her photos are of her, not because the tagger marks object shots as hers.

**Original status:** OPEN, carded (device check, finding 2 — Adi, 21 Sep 2026: "card it, don't fight
the tagger from the caster"). Shared code — `lib/visionTag.ts` is enrichment, not the Agent's.

**What the device check showed.** Two plans, no b-roll in either: every one of the 34 references
the day's clip previews carried was `person`. Of her 365 castable photographs, the tagger says she is
absent from **7** (5 of them uploads).

**What was code, and is fixed in PR B.** searchMedia's default score gives every photo of her up to
0.18 of `heroScore` that a scene cannot earn, so the planner's "top 24" never held a scene and the
caster could not reach one. Scenes now get their own places in the planner's library and are ranked
among themselves for b-roll (`studio/agent/cast.ts` `rankWithoutHer`; the 16/8 split in the route).

**What is still a question.** Whether the ball, jewellery and bottle shots she has are tagged
`athlete_present: true` because a hand or a sleeve is in the frame. If so, they are identity frames
by our own rule — casting one into b-roll sends her hand to seedance, which refuses real people 6 of
6 — and the only fix is upstream: what the tagger's prompt means by "present" for a partial body.
The first count said 220 true vs 3 false, but **it proves nothing**: its pattern had no word
boundaries, so "ring" matched inside "wearing", "during" and "bring", and it counted nearly every
description. The corrected, read-only count (word boundaries; split by whether the description
mentions a hand) is above.

**If it shows hand-in-frame object shots:** a tagger card for Mia — re-tagging has a cost, and the
same flag drives `heroScore`, the media kit's curator and every searchMedia caller, so it is not a
change to make from here. **If it does not:** her library simply holds few scenes, and nothing is
owed.

---

## 6 · `athlete_present` means "an athlete is in frame", not "SHE is" — a named pro was cast as her

**Status:** OPEN, carded (device check, finding 7 — Adi, 21 Sep 2026). Enrichment is shared code
(`lib/visionTag.ts`) — Mia's. Belongs to the enrichment-quality eval queued after PR C2.

**Exhibit.** Row `f608e704…` in her library is a photo of a named professional player — a different,
male athlete. The tagger marked it `athlete_present: true`, and one day's plans cast it three times.
As an identity shot, Veo would animate him into her ad.

**Why, read from the code.** `tagAsset(gcsPath)` is given the image and nothing else — no name, no
reference photo. Its prompt asks whether "the athlete [is] clearly the subject" of "an elite young
female athlete's" media kit. So the flag answers "is an athlete the subject?", and it cannot answer
"is it HER?" — it has never been told who she is. The same flag drives `heroScore`, so the media
kit's hero picks share the hazard.

**Fix options, none cheap:**

1. **At enrichment:** "is THIS athlete present" needs a reference — her name (only catches a public
   figure the model recognises by name) or a reference image (which makes it an identity judgment,
   option 2's problem, inside the tagger).
2. **At cast time:** an is-her check on each i2v candidate. This is the identity-instrument problem:
   no identity measure in this repo has passed a negative control (the first-frame probe; a stranger
   scored inside her own band). Not buildable until one does.

**What PR B does about it (v1 mitigation, partial).** The planner's grounding rules say a photo whose
line names a specific person may not be her and must never be an i2v item — the library line already
carries the tagger's description, where the name appears. It catches only a photo the tagger named;
and ref-casting NARROWS the hazard (the planner chooses the photo, reading its line) but does not
close it: the line still says `person_in_frame: yes`, and the query fallback (`searchMedia`, whose
filter is the same flag) can still cast such a photo.

---

## Ledger — casting decisions

- **F8 · Where casting draws from.** The Agent casts from her WHOLE library — uploads, synced posts
  and clips made in Studio — while the Board's picker offers uploads only (card 3). **Picker ≠ caster
  is intentional** (Adi, 21 Sep 2026): reaching enriched photographs the picker cannot show is the
  Agent's point, and all of it is her own media. `searchMedia` has no `media_type` and no
  `deleted_at` filter, so the caster re-loads every candidate through its own athlete-scoped
  predicate — photos only, stored, top-level, not deleted — before it may be cast. No production
  code sets `deleted_at` today; the predicate is there for the day something does.
- **An item nothing can be cast for** is dropped and SHOWN — the plan she approves carries a visible
  "couldn't find a photo for this" line where the item was. The whole plan is refused only when no
  castable item survives.
- **A non-empty Board** asks before a plan replaces it — replace or cancel. No merging in v1.
