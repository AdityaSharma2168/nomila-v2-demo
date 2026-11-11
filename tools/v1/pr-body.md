**Safety only. This does not enable video.** `assertRunnableInline` still throws `unsupported_task`
for `video.generate`, and no line of this PR touches it. What changes is that when someone eventually
deletes that throw, the caps they inherit are real and tested.

Recon: `docs/probes/video-scope-audit.md` §4.4. This is PR 2 of that ladder, landed first on purpose.

## The holes, priced

| Hole | Before | After |
|---|---|---|
| `MAX_CLIP_SECONDS = 60` — a length no reachable model serves | a 60s clip **quotes $24.00** with audio, is approved, and Vertex refuses it *after* `consumePreview` burnt the approval | derived from the routed model (`maxClipSeconds()` → Veo's `[4,6,8]` → **8s**), clamped at `HARD_MAX_CLIP_SECONDS = 60` |
| `maxJobUsd() ?? 30` — placeholder with a TODO | **$24.00 < $30, so the cap would not have fired** | **$10** |
| No cumulative ceiling | a loop of $1.60 clips bounded by nothing | **$25/athlete/rolling-24h**, `STUDIO_MAX_DAY_USD` |
| Unpriced model (Seedance) | refused in three places, pinned by none | pinned, with the `amountUsd: 0` trap asserted |

Worst clip anyone can now request: **$3.20** (8s × $0.40/s). What the product orders is the silent
arm — **$1.60**.

## Why the gate moved into its own module

`assertRunnableInline` (`generate.ts:1106`) throws before the money checks (`:1111+`). So the caps sit
*downstream* of the hold, and while the hold stands **no test could show them refusing a clip**. Three
caps had never once been demonstrated refusing the thing they exist for.

`server/studio/spendCaps.ts` is the same four checks, in the same order, at the same point in the call
— but callable with a video quote, so `spendCaps.test.ts` can prove each refusal against real quotes
from the live price table. Nothing about *when* they run moves.

The consequence that matters is written at both ends of the hold: **deleting the throw does not delete
the caps.** Whoever enables video removes one line and inherits every refusal below it, already tested.

## Proof

- **Scoped Studio suites: 73 suites / 2446 tests / 0 red.** Base (`27185ee`): 72 / 2414 / 0. Delta is
  exactly the 32 tests this PR adds.
- **12 revert checks, 12/12 held** — each breaks one guard and names the test that must notice.
  RC5 failed on the first pass and **the test was wrong, not the guard**: the original ordering case
  passed under the very mutation it was named for. Rewritten so it bites. Written up in the ledger.
- `check:types` clean, including `tsconfig.jest.json` (tests are not type-checked by the default
  config — see `check-types-skips-tests`).
- **Lint equal to base on every shared file**; both new files 0 errors (their 5 warnings are the
  repo-wide `jest.mock`-before-import pattern).
- `check:format`: red on `main` for ~728 files (no prettier config, so an 80-col default against a
  ~100-col codebase). Both new files are prettier-clean; added lines in existing files match their
  neighbours. No file got a wholesale reformat.

## Review checklist

- **Scope** — `server/studio/**`, `server/routes/studio*`, one doc. Content Hub lane only.
- **Tenancy** — the one new query, `spentTodayUsd`, filters on `athlete_id`; a test pins that one
  athlete's day does not count against another's.
- **Destructive surface** — none. No migration, no DDL, no schema change, no deploy config, no script,
  no send. Read-only query on an existing column.
- **Untrusted content** — none enters a prompt; refusal messages carry only figures we computed.
- **Secrets** — none.
- **Reversibility** — safe live on merge. It only ever *refuses more*, on a path video cannot reach.
  The image path's behaviour changes in exactly two ways: the per-job refusal message now names the
  cap, and a per-athlete day over $25 is refused.

## Deferred, deliberately

- **V-L1 — a global (cross-athlete) ceiling.** Needs an unscoped aggregate in the hot path and a
  product decision about whose runaway locks out whom. **Mia's call, written up not built.**
- **V-L2 — the 25 MB store ceiling for video.** Bounds output *size*, not *spend*; cannot fire at
  today's 8s limit. Belongs with whichever PR moves the clip cap.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
