# Studio — the Agent tab

**Status (21 Sep 2026):** built on `studio/agent-tab`, behind `STUDIO_AGENT` (server) and
`EXPO_PUBLIC_STUDIO_AGENT` (client), both default off. Its prerequisites landed first as their own
PRs: #548 (runGeneration spends on the quoted route), #549 (the stitch clip list and the enrichment
gate), #550 (the Board admits a whole board, against the server's ceiling, on a quote for the board
on screen). Device-checked on phone-width Chrome, seven findings addressed in-branch or carded (below); a
second pass on the finished branch is Adi's.

---

## What it is

A planner in front of the Board. She says what she wants, picks anything she wants in it, and sets
what it is for and how it should feel. The server plans it from her own photographs and returns the
plan — nothing priced, nothing spent. The Agent screen prices it with the Board's own code and shows
an estimate. "Put it on the board" hands the rows to the Board, which quotes them fresh, admits the
whole board, and is the only place anything is spent. When the run settles, the Board stitches what
was made into one video.

**The Agent does not own a second engine.** Its output is a populated Board.

## Where the money is

| Step                        | Calls                                                      | Spends  |
| --------------------------- | ---------------------------------------------------------- | ------- |
| `POST /studio/agent/plan`   | one planner call (Gemini Pro since b-roll t2v — `docs/plans/studio-broll-t2v.md`); two embeds for the library, one per i2v fallback | no      |
| The Agent screen's estimate | one `previewNow` per shot (a $0 check)                     | no      |
| The Board's own quote       | one `previewNow` per piece, then `POST /studio/plan/admit` | no      |
| "Make the board"            | admission, then `/studio/generate` per piece               | **yes** |
| "Stitch these N clips"      | `POST /studio/stitch` (CPU, its own queue)                 | no      |

## Decisions

Decided in review, 21 Sep 2026. Not to be re-opened without a reason the code gives.

1. **Images only for planning.** Uploaded videos are placed as they are — at the END of the video,
   in the order she picked them — never quoted, planned around or cast.
2. **Planner on Flash, one call, never retried** (`server/studio/agent/config.ts`). A planner that
   retried itself would be a loop in front of a spend.
3. **v1 vocabulary: i2v · b-roll · product.** `image` ("keep this photo as it is") is held in the
   type and refused by the parser — a $0 item with no preview, no Board row and no path into a
   stitch (`docs/studio-agent-open-cards.md` card 2).
4. **Products are hers, never the model's.** She picks up to five (`MAX_PLAN_PRODUCTS`); they are
   never searched for; the planner is offered the kind only when she gave one, and the parser
   refuses a product item she did not give (the prompt not offering it is a request to the model,
   not a check). Product items take her products in the order she picked them, all of them
   reserved before any search; a product item past the last is dropped with its line, and a
   product the plan leaves out is named on the Agent screen.
5. **The planner names the photo; casting is still ours.** _Reversed in review after device check
   finding 6_ — it was "a search query per item, never an asset". With only a query, the direction
   and the photo were chosen separately, and a basketball direction was cast onto a soccer photo.
   Now each item names the library `ref` its direction is written about; a ref it was not shown
   refuses the whole plan. A ref is a handle into rows the route loaded under her athlete id through
   the caster's own predicate — never an id. The caster casts the named photo when it fits the kind
   (`athlete_present === true` for i2v, `=== false` for b-roll) and is not taken; otherwise the item
   is SWAPPED — to an unused pick, then her library by its query — and says so on screen
   (`server/studio/agent/cast.ts`).
6. **Her picks, used where they fit.** The planner is shown which photos she picked and asked to name
   them where they fit; a pick fills a swapped item before any search; a pick is never forced into a
   kind it does not fit; a pick the plan leaves out is named on the Agent screen.
7. **An item nothing fits is dropped AND SHOWN** — a "left out" line where it was. Only a plan in
   which nothing could be cast is refused.
8. **The handoff is route params, in memory.** A saved plan is out of v1 (card 4: its own table, its
   own PR).
9. **The Board is the only door that spends.** The planning route writes no preview and admits
   nothing; the Board re-quotes and admits at the tap.
10. **Two numbers, on purpose.** The Agent screen shows an ESTIMATE labelled "final price on the
    Board"; the Board's fresh quote is the only number that spends. See the ledger.
11. **A plan never lands silently on her work.** Empty board → applied. Her work on it → an inline
    Replace / Keep mine. A run in progress → held until it settles or she dismisses it.
12. **The objective travels with the plan and is in the Board's quote key**, so a plan built as
    "showcase-product" is priced and run as that.
13. **The stitch is on every board.** Unbridged joins crossfade, as "Crossfade · free" promised;
    partial runs stitch what was made with the count on the button and each missing piece named;
    the clip limit is checked when the plan is made and again at the button.
14. **Admission bounds a board (15 pieces), not a plan (6 items)** — `MAX_ADMIT_PIECES` and
    `MAX_PLAN_ITEMS` are different questions and are never to be merged again.
15. **The filtered-clip retry is its own switch** (`STUDIO_AGENT_RETRY`), off; turning the Agent on
    can never turn it on. `docs/plans/studio-video-flip-checklist.md` §10.

## Ledger

- **Product rides as plain b-roll (v1) — unless she is in it.** A product item becomes a b-roll row
  with nobody in it. Nothing on the video path reads a reference's role beyond `person` — routing
  and the prompt are unchanged — so only the label on the brief is lost. **v2 upgrade, if the label
  ever matters:** a product role on Board rows, which touches `clipRequestFor` and the quote key.
  **The exception (device check, finding 4):** a product photo the tagger says she is in (her hand
  round the bottle) arrives as slight movement, marked as her. As b-roll it would have gone to
  seedance, which refuses real people 6 of 6 — a latent bug in the single-product code, fixed with
  the multi-select. Only `athlete_present === true` moves it; an untagged product stays b-roll.
- **Sound is recommended per item (device check, finding 1).** The planner returns `sound` per item
  (only a literal `true` counts); the Agent screen shows "Sound on" on those items and prices them
  with it; the seed turns the Board row's own sound on, where she can turn it off. It is a PRICE on a
  shot of her — Veo's audio SKU is double, so a 4 s identity clip is $1.60 instead of $0.80 — and
  free on seedance b-roll. **Near the ceiling:** an all-sound six-item plan of identity shots is
  6 × $1.60 = **$9.60 against the Board's default $10 total** (`maxJobUsd`), so one bridge tips it
  over. The Board refuses it loudly — the system working — but expect it in a demo. **Unmeasured:**
  what Veo does with the sound clause's negatives (no music, no voice) — #545's open item; it does
  not block this.
- **Scenes get their own places (device check, finding 2).** Both plans came back without b-roll.
  searchMedia's default score gives every photo of her up to 0.18 of `heroScore` that a scene can
  never earn, so on her library (358 photos of her, 7 without) the planner's top 24 held no scene
  (inferred — the plans themselves were not saved; every reference that day was `person`), and the
  caster, searching the same way, could not have cast one. The planner is now shown up to 16
  photos of her and up to 8 scenes (`AGENT_LIBRARY_WITH_HER` / `_WITHOUT_HER` — a split that
  compensates for that one bias, not a tuning knob), her picks first; b-roll is cast from her scenes
  ranked among themselves by similarity alone (`rankWithoutHer`); the prompt asks for b-roll where a
  place or a detail helps. searchMedia is not changed. Whether her object shots are tagged as having
  her in them was carded and is answered — they are not; her library holds few scenes
  (`docs/studio-agent-open-cards.md` card 5).
- **Another brand on a photo is flagged, not fixed (device check, finding 3).** An Adidas ad cast a
  photo with a Nike logo and said nothing. Now, when her sentence names a sportswear brand, every
  cast photo whose tags show ANOTHER sportswear brand carries a factual line — "This photo shows
  Nike." — and the caster prefers a photo showing none of them when one fits as well
  (`studio/agent/brands.ts`). Her own picks and products are never passed over for it; they are
  flagged the same way. A photo is still cast when nothing clean fits: the plan is hers to judge,
  and she can swap the row on the Board. Matching is `brandNamesMatch`, the curator's production
  rule; her sentence is searched for whole words, because that rule's substring half would read
  ASICS out of "back to basics". **Sportswear only — a narrowing of the approved "any other brand",
  on the data:** her library's brand tags are mostly not rivals of anything — her school's name on
  about 165 of 365 photos, league and team names, a shirt sponsor, a drink on a bench — so "any other
  brand" would flag most of her library. The tagger's junk ("three", "unidentified crest logo") and
  variants ("adidas" / "Adidas Originals") cannot misfire: junk names no sportswear brand, and
  variants match. **Not caught:** a drink in a drinks ad, or any clash outside kit and shoes — the
  tagger writes no category to tell a rival from a sponsor.
- **Card — logo swap (v2, not built).** Replacing the other brand's mark instead of flagging it,
  for three reasons, each enough alone: (1) the masked edit it needs is the path with the known
  distortion defect at the mask's edge; (2) it is an `image.edit` per photo — an interpreter and a
  detection pass, paid, and image edits are locked off for Agent items (v1 plans video only); (3)
  altering another company's trademark on a real photo of a real athlete is a policy question, not an
  engineering one — Mia's, before anyone builds it.
- **Card — "add it, then animate it" (v2, not built; the constructive version of the logo swap).**
  When the planner wants something no photo shows ("add jewellery", "add a billboard"), it proposes
  a suggestion chip — "This photo could work with jewellery added — generate it?" — then an image
  edit, then i2v of the edited frame. Blocked by the same three: the masked-edit distortion defect is
  undiagnosed; the `image.edit` cost path is locked off for Agent items; and adding or altering marks
  is the same policy question. It graduates with the AI-clip-editing lane. Until then the grounding
  rules keep the planner inside what the photos show (finding 6).
- **Directions are grounded in the named photo (device check, finding 6).** Plans described a
  billboard, stadium lights and on-screen slogans in no photo, and a basketball move on a soccer
  photo. Diagnosis (read-only): every cast photo's tags said soccer; her library holds basketball
  photos — so the planner wrote about one photo and the caster cast another (decision 5, reversed).
  The prompt now makes every castable item name its photo, says a direction may describe only what
  that photo's line shows, never text or overlays (the pipeline renders none), never contradicting
  sport, setting, attire or light; shows each photo's brands so a plan for one brand can avoid
  another's (the clean-photo preference now lives with the planner, the caster keeps it only on the
  swap path); and tells it a photo whose line names a specific person may not be her. The test is a
  DELETION TRIPWIRE only — prose against pixels cannot be checked without a vision call.
- **The photo picker's 24-upload limit is inherited, deliberately.** The Agent screen reuses the
  Board's picker, so it offers the 24 newest-captured uploads only (card 3: `fetchNextPage` is never
  called). Not fixed here — see PR C. Casting is not limited by it: it searches her whole library
  (F8, `docs/studio-agent-open-cards.md` ledger — picker ≠ caster is intentional).
- **Why a plan is priced twice.** The Agent screen prices the plan so she can decide whether it is
  worth taking to the Board at all, before she leaves the screen — "she approves what she sees" holds
  at both doors. The cost is a round trip and up to six extra preview rows, both free (a preview
  calls no provider). The Board then prices it again because its quote is the one that spends, and
  it must be fresh (a check expires after 30 minutes; the ceiling can move). So the two can differ
  over TIME, and the label says so; they cannot differ in METHOD — both are built by the same code
  from the same rows — `seedRowsFrom` is the only mapping from a plan to rows, and `rowQuoteFrom` the only
  mapping from a preview to a quote.
- **PR C — next, small, its own:** the picker's 24-upload limit (card 3). The Agent screen and the
  Board both get the fix at once.
- **Also carded, not built:** a poster written when a generated clip is recorded
  (`docs/studio-video-enrichment-card.md` — it would silently opt clips out of the poster cron's
  duration probe and transcode); the still→clip encode that `image` would need (card 2); a saved
  plan (card 4).
- **Found while building, not changed:** the Board's quote round never reads a preview's
  `unavailable` (e.g. video switched off), so `boardQuote`'s "unavailable" refusal is never reached
  from the Board. `rowQuoteFrom` was lifted from the Board byte for byte and keeps that behaviour —
  fixing it is a Board change of its own.
- **"Fine-tune in Video" (device check, finding 5).** Once the Board's stitch is ready, a button
  opens the Video tab with that video already on its timeline (`fineTuneTimeline`), where trims,
  captions and sound live. It waits for the clip list to hold the video and never lands on a
  timeline she has started. Leaving the Board does not keep the Board — as before — and the button
  says so: the stitched video and its clips are saved in her library either way.
- **Stitch after an edit.** The stitch joins the Board's pieces as they are now, with the clips the
  last run made. A shot added after the run has no clip and is named as left out — it is not made
  silently, and it is not stitched around silently.

## Device check (Adi, 21 Sep 2026)

Full pipeline verified on phone-width Chrome — plan, estimate, handoff, Make the board, and the
stitch. Two plans priced at $4.00 for 5 items and $3.20 for 4, which is exactly 4 s × $0.20/s per
soundless Veo clip; the estimate's label and "The Board prices it fresh" read as intended. Five
findings from that pass, then two from the pass after — all addressed in this branch, or carded:

| #   | Finding                                    | What changed                                                                          |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| 1   | Every clip came back silent                | The planner recommends sound per item; shown, priced, seeded on the Board (agent 13)  |
| 2   | No b-roll in either plan                   | Scenes get their own places and are ranked among themselves (agent 14); card 5 closed |
| 3   | An Adidas ad cast a photo with a Nike logo | Sportswear-brand flag + clean photo preferred (agent 15); logo swap carded            |
| 4   | Only one product                           | Up to five, in pick order; a product photo with her in it is made as her (agent 12)   |
| 5   | After the stitch, no way into the timeline | "Fine-tune in Video" opens it on the Video tab's timeline (agent 16)                  |
| 6   | Directions described what no photo showed  | Each item names its photo by ref; grounding rules; swaps shown (agent 18)             |
| 7   | A named pro player cast as her             | Carded (open cards 6); planner told a named person may not be her (agent 18)          |

Another device pass on the finished branch is Adi's, before the PR opens.

## Files

| Where                                          | What                                                   |
| ---------------------------------------------- | ------------------------------------------------------ |
| `server/studio/agent/{config,types,plan}.ts`   | the planner: model, vocabulary, prompt, parser         |
| `server/studio/agent/cast.ts`                  | casting: the predicate, picks first, the verdict       |
| `server/studio/agent/brands.ts`                | the brand she named, and the flag on another one       |
| `server/routes/studio.ts` `/studio/agent/plan` | the route: flag, shape, tenancy, plan, cast            |
| `client/screens/studio/AgentScreen.tsx`        | the screen                                             |
| `client/screens/studio/agentLogic.ts`          | the request, the ONE plan→rows mapping, the clip limit |
| `client/screens/studio/boardStitch.ts`         | the Board's stitch: joins, count, what is left out     |
| `client/screens/studio/StoryboardTab.tsx`      | the door, the seed banner, the objective, the stitch   |

## Commits

`04b89b2` the planner · `f8901b9` merge of main (#548–#550) · `d663a8c` B1 the v1 vocabulary ·
`62759f4` 6 casting · `59446c4` 8 the route · `b9dde0f` D4 picks first · `cc4871c` 9 the screen ·
`9f5acd2` 10 the handoff and the stitch · `ae57842` 11 this ledger · device check: `21c8b9e` 12
products · `01a8afe` 13 sound · `90eca2f` 14 scenes · `8518dec` 15 brand flag · `1b199c0` 16 fine-tune ·
`bc78fe4` 17 card 5 answered · 18 the planner names its photo (findings 6 and 7).
