# Card — b-roll goes text-to-video (the Agent stops casting photos for b-roll)

**Status:** BUILT on `studio/broll-t2v` (21 Sep 2026) — see `docs/plans/studio-broll-t2v.md` for
what landed, the commits and the device check. §4's bridge wedge is fixed there, and §6 was answered
the minimal way: scenes stay in the planner's library as context, reservation unchanged. The two
§2 caveats remain open, as recorded. The decision behind it is in `docs/studio-broll-t2v-decision.md`.

*The card below is as it was approved.*

**Status (as approved):** CARD, approved in outline (Adi, 21 Sep 2026). **Its own small PR, right after C1 (stills)
and before C1b.** It is Agent-side and does not ride the stills branch.

Line numbers are as of `f8e8a25` (#551) plus the still-clips branch's commit 1, which touched
`cast.ts`. Re-read before editing.

## The change

- **Planner:** a `broll` item carries a **scene description and no `ref`**. The ref requirement from
  the finding-6 commit applies to `i2v` only. `product` already takes her picks in order and never
  had a ref.
- **Caster:** `cast.ts` **skips casting for `broll` entirely**. There is no search, no athlete-present
  gate and no swap.
- **Seed:** `seedRowsFrom` gives a b-roll item **no asset**: `{ assetId: null, thumbUrl: null,
  kind: "broll", hasPerson: false }`.
- **Board:** that row rides the photo-less t2v path the Board already has ("Add a shot without a
  photo"). No new machinery.

It **deletes more than it adds**: the b-roll arm of `fitsKind`, the b-roll search-and-swap, and the
route's scene reservation for the planner.

---

## 1 · Confirmed: the Board tolerates a b-roll row with no thumbnail

- **It renders.** `StoryboardTab.tsx:1019-1029` shows `row.thumbUrl ? <Image …> : <View thumbEmpty>`
  with the Feather `type` icon for a photo-less row. There are no `assetId!` or `thumbUrl!`
  assertions anywhere under `client/screens/studio`.
- **She can already make one.** "Add a shot without a photo — just describe it"
  (`StoryboardTab.tsx:689-700`, `addTextShot` at `:536-555`) adds exactly the row the seed will add.
- **Its rules already exist.**
  - "Slight movement" is refused with no photo (`storyboardLogic.ts:423-427`); the b-roll guard stays
    quiet (`:405-413`).
  - All four shot slots are offered (`:135-138`), and sound is not priced up (`:268-269`).
  - `clipRequestFor` sends `references: []` (`storyboardRun.ts:47-49`).
- **Stitch.** `boardStitch` joins the *made* clip's asset from its view and never reads
  `row.assetId` (`boardStitch.ts:62-63, 78-84`).

## 2 · Confirmed: on the t2v path the quote prices what runs (the #545 / PR-0 question)

**Quote.** `POST /studio/preview` → `previewGeneration` → `plannedInputs`:
- `referencesFor` is `[]`, and the route is decided in one place (`preview.ts:1005-1010`):
  `shotTypeFor([])` = `broll`, then `videoRouteFor("broll")` = openrouter `seedance-2.0-fast`.
- The estimate is priced on that routed model (`preview.ts:1489-1493`), at seedance-fast's per-token
  rate (`config.ts:661-667`).
- The duration is checked against the routed model's 4–15 s list (`preview.ts:1468-1472`).

**Run.** `POST /studio/generate`:
- It re-derives the plan with `previewGeneration(stored.brief)` (`generate.ts:1143`). That is the
  **same frozen brief**, with no references on it, so it yields the same route.
- It checks the fresh amount against the approved one (`generate.ts:1179`, `spendCaps.ts:165-178`),
  then writes provider and model onto the job row (`jobs.ts:82-83`).
- The runner reads them **off the row** and re-decides nothing (`videoRunner.ts:213-278`).
- The adapter sends neither `frame_images` nor `input_references` (`openrouter.ts:185-199`).

**Nothing downstream needs a reference:**
- `videoRunner.ts:127-137` — "an unreferenced clip is a legitimate text-to-video job";
- first-frame cropping returns `no-frame` (`firstFrame.ts:185-187`);
- clip QA reads the clip's own frames (`qa/videoClip.ts:197-216`).

So the PR-0 class of bug does not arise: quote and run derive the route from the same thing (no
references), not from two different inputs.

**Two pre-existing caveats, neither this card's, both true of photo b-roll today:**

- **An env change between quote and run.** The run re-derives the route under the *current* env. If
  `STUDIO_VIDEO_BROLL_PROVIDER`/`MODEL` changes in the ≤30 min a preview lives:
  - a dearer model is refused (`spendCaps.ts:177`);
  - a **cheaper or equal one runs silently**, because the stored `routedModel` is "USED TO DECIDE
    NOTHING" (`previewStore.ts:69-81`).

  Its own card: compare the fresh model to `routedModel` at generate time.
- **The route's duration cap reads Veo's list (max 8 s)** (`maxClip` at `routes/studio.ts:283-284`, applied at `:452-457`; `maxClipSeconds` in `config.ts`), so a
  b-roll clip cannot ask for 9–15 s. The Board sends no duration, so this doesn't bite.

## 3 · Products stay image-to-video — key the change on the Agent's kind, never the Board's

A `product` item takes her pick and never goes through `CASTABLE_KINDS` or `fitsKind`
(`cast.ts:364-373`). `seedRowsFrom` turns it into a Board **`broll` row with its photo**
(`agentLogic.ts:132-141`), sent with role `object` (`storyboardRun.ts:35-38`), which routes to
seedance as image-to-video.

So the change is keyed on the Agent's `item.kind === "broll"`. Keying it on the Board's
`row.kind === "broll"` — say, `clipRequestFor` dropping references for b-roll rows — would strip the
photo from **every product** and from her own hand-added photo b-roll rows. That is forbidden.

## 4 · Required in the same PR: a bridge beside a photo-less row stalls the Board's price

1. `setBridge` does not check `assetId` (`storyboardLogic.ts:485-497`), and the join pill renders on
   every row after the first (`StoryboardTab.tsx:979-1004`).
2. `bridgeRequestFor` returns null when either side has no photo (`storyboardRun.ts:111-114`), so no
   bridge quote ever arrives.
3. `boardQuote` counts the bridge as missing (`storyboardLogic.ts:603-606`). The Board shows "Still
   working out what this board costs — one moment." **forever** and cannot be approved. The cost
   header still counts "· N bridge" (`StoryboardTab.tsx:1226`).

Today this takes a hand-made text shot. After this change every Agent b-roll row is photo-less, so it
becomes the common case.

**Fix:**
- `setBridge` refuses when the row or the row before it has no photo, and `normalizeBoard` strips such
  a request after a reorder;
- the pill says why;
- a `boardQuote` test holds it.

It is the same rule C1b needs for stills.

Copy that still assumes a photo: "Start with a photo." (`StoryboardTab.tsx:655-663`) and "Add a photo
to start the board." (`storyboardLogic.ts:543`).

## 5 · Every site, from the recon

**`server/studio/agent/plan.ts`**
- `:86-91` — the system line ("every clip is made by bringing ONE of her photographs to life").
- `:101-105` — the grounding rule becomes i2v-only; b-roll needs its own rule (no people, no text or
  logos).
- `:175, :179-181` — the b-roll kind line, and ref/searchQuery "or null for broll".
- `:190, :195-198` — the rules that tie b-roll to library scenes.
- `:290-295, :301` — `parsePlan` requires a shown ref for every castable kind. A ref-less b-roll item
  would **refuse the whole plan** until b-roll leaves `CASTABLE_KINDS`.

**`server/studio/agent/types.ts`**
- `:43` — `CASTABLE_KINDS = ["i2v"]`. This one constant drives `parsePlan` and both casting passes.
- `:17-19`, `:106`, `:124-145` — the docs.

**`server/studio/agent/cast.ts`**
- `:23-24, :37-40` — the header's b-roll rules go.
- `:162-187` — `rankWithoutHer` is no longer used by casting.
- `:190-194` — `fitsKind` becomes i2v-only in practice.
- `:328, :374-377` — once b-roll leaves `CASTABLE_KINDS` it would fall into `uncast()` ("Couldn't
  find a photo for this."). That is wrong; it needs its own branch before that.
- `:204-229` — the `CastItem` union needs a third state: **no photo, and not left out**.
- `:395-409` — the b-roll search and `SWAPPED_LINE` go. `:386-393` — picks no longer fill b-roll.
- `:450` — `castCount` counts only photo items, so an all-b-roll plan counts 0.

**`server/routes/studio.ts`, `POST /studio/agent/plan`**
- `:2097-2098, :2193, :2197-2211` — the 8 scene slots and the `rankWithoutHer` split can go.
- `:2266-2269` — **an all-b-roll plan would 422** on the zero-cast check; t2v items must count.
- `:2271-2285` — the log's `dropped` would count t2v items as dropped.

**Client**
- `use-studio.ts:580-611` — the `AgentPlanItem` invariant ("an asset or a line") gains the third
  state.
- `agentLogic.ts:131` — `if (!item.assetId) return []` **drops** a ref-less item. It must emit the
  photo-less row, telling it apart from a left-out item by `item.uncast`.
- `agentLogic.ts:175-183` — `picksLeftOut` will report more unused picks.
- `AgentScreen.tsx:421, :466-478` — the render branch on `assetId` would show a t2v item as "LEFT
  OUT". It needs the Board's `type` icon. `:524-526` — the sound hint ignores it.

**Tests that pin b-roll casting today**
- `plan.test.ts:78-80, 188-201, 372-379`
- `cast.test.ts:217-232, 268-286, 288-322, 338-356, 384-436, 438-478, 484-510, 579-597`
- `studio.agent.test.ts:258-284, 340-361`
- `agentLogic.test.ts:58-70, 110-123, 134-151`

These change *meaning*; they are rewritten to the new rule, not loosened. A test that pinned "b-roll
is cast to a scene" becomes one that pins "b-roll is never cast".

## 6 · One question for Adi before the build

Should the planner still be **shown** scene photos (`person_in_frame: no`)? If b-roll never uses one,
the library block could show only photos of her, which is shorter and cheaper. But a scene photo is
also evidence of where she plays and trains, which grounds a t2v sentence ("empty stands at dusk"
reads truer when her library holds stands).

Recommendation: keep showing them as **context only** (no ref), and drop the 8-slot reservation.
