# Storyboard tab, step 1 (`storyboardLogic`) — predictions, written BEFORE the code

**Written 2026-09-20, before the module exists.** Not edited afterwards except §4.

## 1. What this step is

Pure arithmetic and rules for a board of stills: rows, reorder, validation, the person/b-roll guard,
and the quote. **No UI, no fetch, no server, $0.** Everything it needs about the world is passed in.

## 2. Shapes, decided before writing them

**`kind` is `"broll" | "motion"` — SHOT words, never model names.** `shotType.ts`'s "NOT a user
picker" decision stands: she picks a shot, the router still picks the model. `motion` is the word for
"slight movements" because "identity" is our vocabulary for why it routes where it does, not hers.

**⚠️ The module NEVER COMPUTES A PRICE.** It sums quotes it is handed. Pricing lives in
`server/studio/config.ts` and the only honest per-row figure is the one the server's own preview
returns — the same rule `StitchLimits` states for the timeline ("what the server told us a timeline
may be, never hardcoded here"). A client-side price table would be a second source of truth for
money, and the first time it disagreed she would approve one number and be billed another.

**`maxJobUsd` is passed in for the same reason**, and applied to the BOARD TOTAL. That is stricter
than the server, which applies it per job and would happily run five legal jobs — deliberately, since
a board is one decision to her however many jobs it is underneath.

**A bridge is `bridgeRequested` on the row it arrives at, never on row 0** — the same vocabulary and
the same invariant `stitchLogic` already uses, so the handoff to the timeline is a rename of nothing.

## 3. Predictions

| #   | prediction                                                                                                                                                                     | confidence |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| P1  | The person/b-roll guard is the only rule that can make a `kind` unsettable. Everything else about a row is free to change.                                                     | high       |
| P2  | `setKind` refusing is a NO-OP, not a clamp. Silently rewriting her choice to `motion` would be a different board than the one on screen.                                       | high       |
| P3  | An unpriced row blocks the whole board. `spendCaps` refuses an unpriced quote, so a board containing one cannot run and must say so before she approves, not after.            | high       |
| P4  | The board ceiling uses the **audio-arm** figure and shows expected beside it — the probes' posture. Over-quoting is the safe direction.                                        | high       |
| P5  | Reorder must clear a bridge that lands on row 0, exactly as `normalize` does on the timeline. A bridge into the first clip is a bridge from nothing.                           | high       |
| P6  | Removing a row cannot orphan a bridge: the row that inherits position 0 loses its ask.                                                                                         | medium     |
| P7  | The quote is a pure function of (rows, quotes, limits). Reordering rows does not change the total — only which joins exist, and a bridge's price is the same wherever it sits. | medium     |

## 4. Revert checks — each names its mutation

| id    | mutation                                          | must red                                              |
| ----- | ------------------------------------------------- | ----------------------------------------------------- |
| RC-S1 | `brollRefusal` returns null for a person row      | "b-roll is refused on a row that carries her"         |
| RC-S2 | `setKind` clamps to `motion` instead of no-op     | "refusing a kind leaves the row untouched"            |
| RC-S3 | an unpriced row is skipped instead of blocking    | "one unpriced row blocks the whole board"             |
| RC-S4 | board total compared to nothing / the cap dropped | "a board over maxJobUsd refuses before anything runs" |
| RC-S5 | reorder stops clearing a row-0 bridge             | "a bridge dragged to the front is cleared"            |
| RC-S6 | bridges omitted from the board total              | "requested bridges are in the total"                  |
| RC-S7 | the ceiling is reported as the expected invoice   | "ceiling and expected are different numbers"          |

## 5. Result

Not built yet.
