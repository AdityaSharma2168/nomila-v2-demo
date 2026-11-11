Video V9 gives a generated clip the two things it has never had: a **route chosen from what kind of
segment it is**, and an **inspection after it is made**. Three tracks, each with its predictions
committed before a line of it was built and scored afterwards in
`docs/plans/studio-video-v9-plan.md` (Parts III, V and VII).

**This merges dark.** `STUDIO_VIDEO_ENABLED` and `STUDIO_CREATIVE_QA` are both off by default and
neither default moves here. No file under `migrations/`, no line of `shared/schema.ts`, no line of
`.github/workflows/**` or `gcp/**`.

## Two live defects this fixes, both found by building it

**1. B-roll could be routed but never PRICED, so it could never be made.** seedance bills
`per_video_token`, both halves of that quote are functions of the output's size, and
`studio/pricing.ts` says plainly that _"a request that names no size cannot be priced at all"_ —
while `spendCaps` REFUSES an unpriced quote. So a b-roll segment was not cheap, it was impossible.
The fix sends width/height for exactly the shots that bill per token and nothing for the ones that
bill per second, so **an identity clip's inputs are byte-identical to what they were before shot
routing existed**. The same two numbers reach the wire (`openrouter.ts` sends
`size: "${width}x${height}"`), so the size that picks the price tier is the size the request buys —
by construction rather than by agreement. Quoted `$0.3667` at 4s and `$0.5481` at 6s, exact to four
decimals, and `$0.5481` is what the bake-off was actually invoiced.

**2. A clip was asking for a photograph.** The product path sent `buildPrompt`'s image prompt to
Veo — the prompts that actually worked in V2b lived in a throwaway script. `studio/video/prompts.ts`
now holds three templates (motion, camera, preservation; no "photorealistic photograph"), golden-
pinned including the untrusted-fencing cell. **0 of 36 image goldens move**, and that is a property
of the control flow rather than a hope about it: the video arm returns before either image arm is
consulted, and neither `buildPrompt` nor `buildNativePrompt` is edited.

A third, latent: `durationBlockers` checked every clip against Veo's 4/6/8, so the moment b-roll
routed to seedance-fast (which serves 4..15) a 5s b-roll segment would have been refused for a limit
belonging to a model it was never going to.

## What it adds

- **`shotTypeFor(brief)`** — `identity` when a person reference is present, `broll` otherwise,
  derived from the references the planner already produced. Never stored, never picked from a menu,
  never guessed from her sentence. Pinned over **all 32** subsets of the role union, not three
  examples. `transition` is deliberately unreachable.
- **`videoRouteFor` / `videoOutputSizeFor`** — the route table, beside `routes()` and not inside it,
  resolved in the preview because the job row is written from the frozen plan. The `STUDIO_VIDEO_*`
  env escape hatches survive untouched.
- **The clip QA instrument** — adaptive sampling off a drift curve, per-frame records, coverage.
  The ported curve reproduces V2b's published numbers **exactly** (3/3, maxD 0.000), and the sampler
  **never loses** to a fixed grid: 16 wins, 8 ties, 0 losses, with every win a mid-clip excursion.
- **The runner's QA stage**, behind the flag, dynamically imported, **after `succeedJob`** — see
  below.
- **`video/reroll.ts`, record-only** — a failed clip _recommends_ a re-roll and nothing acts on it.

## ⚠️ Two places where the ORDER is the design

**QA runs after `succeedJob`, not before.** The image path does the opposite, and video must not
copy it. `reapExpiredLeases` requeues on `status='running' AND lease_until < now()` and **keeps**
`provider_operation_name`. Between the store and `succeedJob` the job is still running with its
lease renewed only on poll progress, which has finished — so a three-minute QA stage in that window
means the lease lapses, another instance's reaper requeues, the next runner **resumes the same
operation**, and `recordGeneratedAsset` runs a second time. One clip, two rows in her library,
nothing saying why. Pinned by `qa-before-succeed-double-records` as a row count of 2, with a control
beside it proving the reaper works in this harness at all.

**The QA call has its own try/catch, and it is load-bearing.** `jobs.ts` `finish()` is unguarded on
status, so a throw after `succeedJob` but inside `workJob`'s outer try reaches that catch, calls
`failJob`, and flips a job that SUCCEEDED — clip stored, money spent — to `failed`.
`inspectClipAsset` is written never to throw, but that is a property of _that_ function and the
runner must not depend on it.

## Why a failed clip does not re-roll itself

**This is a money rule, not a product preference.** `spentTodayUsd` banks the quote **at INSERT**,
so an in-runner re-roll reusing the same row spends a second $1.20 the rolling 24-hour ceiling never
sees — the exact failure that cap exists to prevent, and one no amount of care inside the runner can
undo, because the ledger was never told. `attempts` cannot be borrowed either: it is the LEASE
counter, and touching it would move a clip toward "gave up after 5 attempts" for having been bad.
A re-roll is a NEW preview, a NEW approval and a NEW job row, started from the client.

It recommends **nothing** four times, each a decision rather than a gap: a pass; a pass carrying
unknowns (charging her because a check could not _look_ inverts the point of `unknown`); a `flag`
(worth a human's attention ≠ worth her money); and `marks` alone, whose 16 false positives against 6
true negatives on the 36-row corpus would make that recommendation a bill for nothing four times in
five.

## What could break

- **Nothing with the flags off**, which is how this merges. The video path is unreachable and the QA
  stage costs one boolean per tick.
- With `STUDIO_VIDEO_ENABLED` on, a b-roll clip now routes to seedance-fast at a 720 short edge
  instead of being refused as unpriced. That is the fix, and it is the one behaviour change a flag
  flip would expose.
- `videoRunner.ts` shows a large diff because prettier reformatted the whole file; the behavioural
  change is the QA block, the `recorded[]` array and `shotType` on `inputsFor`.

## What was verified

- **Full bare `npm test`** — **380 suites · 7032 tests · 0 failed** (17 batches, exit 0). The whole suite, not a chosen scope — this branch touches `server/scripts/`, which a scoped run never sees. A first pass of the identical tree came back with one red, the `affiliationSync` year-only case that fails about one run in three on main itself; it re-ran green with nothing changed.
- `tsc --noEmit` clean on the app config **and** on `tsconfig.jest.json` (which is the only thing
  that type-checks the tests).
- **Revert checks, 9 across the three tracks**, each with its mutation and its red count recorded in
  the commit that introduced it. One of them (`qa-before-succeed-double-records`) **passed under its
  own mutation on the first attempt** and was rebuilt to reap concurrently from inside the QA stage;
  both the failure and the fix are written on the test.
- An existing guard — `stitchRunner.test.ts`'s no-spend-surface walk — caught `ShotType` being
  declared in `studio/video/shotType.ts`, which would have pulled `preview.ts` into the stitch
  runner's graph via `config.ts`. It now lives in `studio/types.ts`. That walk reads import
  specifiers out of the source and does not care that `import type` is erased at runtime; that
  reading is conservative and correct.

## What I am unsure about

- **No bar is written in the identity metric, on any outcome.** A stranger scores below her own
  band on a curated set, and the V-4 probe that would test it is n=3 — the most it can earn is
  "worth building a real instrument against". `marks` stays advisory on video permanently.
- **`transition` is unreachable**, so the "a shot type with no validated template refuses" path is a
  property of the function, not of any brief that can exist today.
- **Two gates are unfired**: ~$0.50 of instrument validation (V-3/V-4) and ~$3.60 of paid cells
  (G1), predictions committed in `docs/probes/video-v9-predictions.md`. The `--paid` arm is still a
  deliberate refusal stub.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
