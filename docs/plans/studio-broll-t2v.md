# Studio — b-roll made from words (B-t2v): ledger

Branch `studio/broll-t2v`, off `74bb888` (#552, stills). Written 21 Sep 2026. The build card is
`docs/studio-broll-t2v-card.md`; the decision is `docs/studio-broll-t2v-decision.md`. This is the PR
after C1 (stills) and before C1b (Board still rows).

## What changed

| # | Commit | What |
|---|---|---|
| 1 | `9eefd94` | **Server contract.** The planner names no photo for b-roll (`CASTABLE_KINDS = ["i2v"]`), and the caster casts none: no search, no athlete-present gate, no swap. A plan of only b-roll is made, not refused. The route returns `picksWithoutHer`. |
| 2 | `a14b1ce` | **Client.** A b-roll item seeds a photo-less Board row made from its direction. The Agent screen shows "B-ROLL · MADE FROM WORDS". A pick without her is told why it was left out. |
| 3 | `39f1db7` | **The bridge wedge.** A bridge is never asked for beside a photo-less row, so the Board can no longer sit unpriceable forever. |
| 4 | `9e9dba4` | **Quote matches run on t2v.** A photo-less b-roll row goes through the real preview and the real generate; the job row names the quote's model. |
| 5 | `5b3cc0f` | **The model knob, held.** `STUDIO_AGENT_MODEL` really reaches the call. |
| 6 | `a9e26a7` | **The flip.** The planner runs on `GEMINI.pro`. Thinking follows the model, and the timeout is sized for Pro. |
| 7 | this | Docs. |

Every behavioural commit lists its revert checks, red by name.

## Decisions and why

- **Product stays image-to-video.** Her ACTUAL product has to appear — the bottle she sells, not one
  a model imagined from a sentence. A product item keeps her photo, is never searched, and is never
  touched by the b-roll change. The change is keyed on the Agent's `kind === "broll"`; the Board's
  `row.kind === "broll"` is shared with products and her own photo b-roll rows, and is left alone.
- **Grounding rule 1 narrows to clips made from a photo.** i2v (by its ref) and product (named only
  when she picked one — the prompt never mentions a kind it does not offer) may describe only what
  their photo shows. A b-roll direction is FREED to imagine a scene. That is what it is for.
  - It stays tied to her ask and her feel.
  - It may borrow from her picks' lines for continuity (kit colours, setting).
  - It has nobody in it.
  - Rule 2 (never invented text, slogans or overlays) stays global.
- **`castCount` counts what will be made** — photo items plus b-roll from words. Only a plan where
  nothing can be made is refused (422).
- **Scenes stay in the planner's library, as context.** `rankWithoutHer` casts nothing now. The 8
  scene places are unchanged (the card's §6 minimal answer); a scene she has is evidence of where she
  plays, which a sentence-made shot can stay true to.

## The UX question — an object photo picked as a regular pick

After B-t2v a person-less regular pick (a soccer ball) has **no kind it can be cast into**:
- i2v needs her in the frame;
- b-roll is made from words;
- only the *Your products* tray is ever a product.

1. **Planner nudge — yes, built.** It cannot steer the pick toward product (a regular pick can't
   become a product item). The real hazard was the planner naming the ball as an **i2v** ref. The
   caster would then swap it for a photo of her — a ball direction on a photo of her, finding 6
   again. The prompt now says:
   - only a `person_in_frame: yes` photo can be an i2v ref;
   - a person-less pick is never a ref;
   - a b-roll scene may borrow from its line.

   If a model names one anyway, the swap still happens and SAYS so (`SWAPPED_LINE`).
2. **The left-out line — was not legible; built.** "1 of the 3 photos you picked isn't in this plan —
   the plan didn't find a place for it." named neither which photo, nor why, nor what to do. The route
   now returns `picksWithoutHer`, and such a pick gets its own sentence: *"…doesn't have you in it.
   B-roll is made from words now, so it can't be a shot of its own — the plan may still borrow from it
   for a scene. To show it exactly as it is, add it under Your products."*

## The planner model

**Gemini 3 Pro:** `GEMINI.pro`, the registry's identifier (`server/lib/models.ts`,
`"gemini-3.1-pro-preview"`, already registered).

**Cost moves from ~$0.01 to a few cents per plan** ($0 of generation until she approves, so no cap
interaction), **and "Planning…" gets a few seconds slower.**

Two consequences the flip needed:
- **Thinking follows the model.** Pro gets NO thinking config, the shape `GEMINI.pro` is sent daily
  here (`shotList.ts`, `narrator.ts`). A zero budget on 3.1 Pro is undocumented. Flash, by override,
  keeps `thinkingBudget: 0`.
- **The timeout is 15 s → 30 s**, unmeasured on Pro. The "plan derived" log line now carries `ms`.

If plans read worse or the wait is painful, reverting is **one env line**:
`STUDIO_AGENT_MODEL=<Flash model>`.

## Found, not fixed (carded in `docs/studio-broll-t2v-card.md` §2)

- An env change to the b-roll route between quote and run can run a cheaper or equal model than the
  one quoted: the run re-derives the route, and `routedModel` decides nothing.
- The route's input cap on duration reads Veo's list (8 s), so b-roll can't ask for 9–15 s. The Board
  sends no duration, so this doesn't bite.

## Device check (Adi)

iOS Simulator **and** phone-width Chrome, `EXPO_PUBLIC_STUDIO_AGENT` on, server on this branch:

1. **Plan with b-roll.** Plan something that wants scenes. B-roll items read "B-ROLL · MADE FROM
   WORDS" with the `type` mark and are not left out. The estimate prices them.
2. **Put it on the board.** The b-roll rows arrive photo-less (the `type` icon), each with its
   direction as the sentence, and the Board prices and runs. A b-roll clip comes back without opening
   on a photo.
3. **A product still shows her product.** Pick a product: its item keeps her photo and its clip starts
   on it.
4. **The soccer ball.** Pick a photo without her as a regular pick. It isn't cast, and the line says
   why and says "add it under Your products".
5. **The bridge wedge.** On a board with a photo-less row, the join beside it reads "Crossfade · free
   — a bridge needs a photo on both sides" and can't be tapped into a bridge. The board prices.
6. **The planner on Pro.** Plans should show more beat variety and better scene sentences. Note how
   long "Planning…" takes (the server log's `ms`). If either is worse, it's one env line back.
