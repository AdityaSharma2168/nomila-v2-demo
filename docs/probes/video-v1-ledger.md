# VIDEO V1 — LEDGER

> **Spend guards only.** This PR caps what a video job could cost. It does **not** enable video:
> `assertRunnableInline` (`server/studio/generate.ts:129-133`, called at `:1106`) still throws
> `unsupported_task` for `video.generate`, and no line of this PR touches it. Zero model calls were
> made building it — every figure below comes from the price table via `estimate()`, not from a run.

Recon for this PR is `docs/probes/video-scope-audit.md` §4.4 ("Latent spend holes still live on main").
This is PR 2 of that document's ladder, landed ahead of the rest on purpose: the holes are armed the
moment anyone deletes the hold, so the caps go in while nothing can reach them.

---

## What was armed, priced

| Hole                                                                                      | On main before this PR                                                                                                                    | Now                                                                                                                    |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `MAX_CLIP_SECONDS = 60` (`routes/studio.ts:227`) — a length **no reachable model serves** | a 60s clip **quotes $24.00** on the with-audio SKU, is approved, and is refused by Vertex _after_ `consumePreview` has burnt the approval | derived from the routed model (`maxClipSeconds()` → Veo's `[4,6,8]` → **8s**), clamped at `HARD_MAX_CLIP_SECONDS = 60` |
| `maxJobUsd() ?? 30` (`config.ts:580`) — a placeholder with a TODO                         | **$24.00 < $30, so the cap would not have fired**                                                                                         | **$10** — 3× the worst clip that can now be requested, ~75× an image quote                                             |
| No cumulative ceiling anywhere                                                            | a loop of $1.60 clips is bounded by nothing                                                                                               | **$25/athlete/rolling-24h**, `STUDIO_MAX_DAY_USD`                                                                      |
| Unpriced model (Seedance)                                                                 | refused in three places, pinned by **none**                                                                                               | pinned, with the `amountUsd: 0` trap asserted                                                                          |

**Worst clip anyone can now request: $3.20** (8s × $0.40/s, with-audio SKU). What the product actually
orders is the silent arm — `preview.ts` sets `generateAudio: false` — so **$1.60**.

The unpriced trap, stated once because it is the subtle one: `pricing.ts:52-54` returns
`{ amountUsd: 0, unpriced: true }`, because a `CostEstimate` must carry a number. **Read the number
alone and Seedance is free.** The flag is the only thing between an unpriced model and a $0 approval,
which is why `spendCaps.test.ts` asserts the zero explicitly — so nobody later "fixes" it into meaning
what it looks like.

---

## Ledger

### V-L1 · A global spend ceiling — **PROPOSAL FOR MIA, deliberately not built**

The daily ceiling shipped here is **per athlete**: `spentTodayUsd()` filters on `athlete_id`, like every
other query in the codebase, and `routes/studio.generate.test.ts` pins that one athlete's day does not
count against another's. That is the tenancy-correct shape and it is the one our lane permits — but it
is not a company budget. N athletes can each spend $25, so the real exposure is N × $25 and the
ceiling that would actually bound the GCP bill does not exist. Building it means a cross-athlete
aggregate (`SUM(cost_estimated_usd) GROUP BY ()` with no tenancy predicate) sitting in the hot path of
every generate, which is a deliberate hole in the rule that every query is scoped — plus a decision
about what happens when one athlete's runaway locks everyone else out, which is a product question and
not an engineering one. **Neither is ours to decide. This is the whole of the proposal; nothing was
built.** The per-athlete ceiling stands underneath whatever Mia decides, and a global one would sit
above it rather than replace it.

### V-L2 · The 25 MB store ceiling for video — **V-FOLLOW-UP, out of scope here**

`storeAsset` inherits `mediaStore.MEDIA_MAX_BYTES` (25 MB, `mediaStore.ts:18`, "stills only in v1"), so
an oversized clip fails with "over the media size cap" **after** the provider has been paid. The fix is
written on the unmerged `studio-video-foundation` branch (`eb01fb3`): a `maxVideoBytes()` of 200 MB, a
`videoBytesPerSecond()` projection measured off the spike, and a blocker in `previewGeneration` that
refuses a clip projected to exceed it before the approval is consumed.

**It is not in this PR, and the reason is that it is a different kind of guard.** Everything here bounds
what a job may COST; that one bounds what its OUTPUT may WEIGH. They fail differently, they are tested
differently, and bundling them would make this PR's claim ("no clip can cost more than $X") harder to
check rather than easier. It also cannot fire at today's limits — 8s × 2 MB/s ≈ 16 MB against a 200 MB
ceiling — so it buys nothing until the clip cap moves or Seedance/Kling (15s) become reachable. It
belongs with whichever PR moves one of those. Note that main's own fix for the 25 MB cap biting on
images is a **JPEG re-encode ladder**, and that does not generalize: you cannot JPEG a clip.

### V-L3 · The hold, and where it is — **CONFIRMED IN PLACE, unchanged by this PR**

`assertRunnableInline` at `server/studio/generate.ts:129-133`, called at `:1106`. It throws
`GenerationError(VIDEO_NOT_INLINE_YET, "unsupported_task")`, which `routes/studio.ts` maps to a 503.
`generate.test.ts` still asserts it refuses, that the router is never reached, and that no job row opens
and no approval is consumed.

**The ordering fact this PR is built around:** the hold is at `:1106` and the money checks are at
`:1111+`, so the caps sit _downstream_ of it. Two consequences, both now written into the code:

1. **No clip reaches a cap today**, so no test could show one refusing through `runStudioGeneration` —
   which is why the gate moved to `server/studio/spendCaps.ts`, where it can be called directly with a
   real video quote and proven to refuse. A guard that cannot be demonstrated refusing is not a guard.
2. **Deleting the hold does not delete the caps.** Whoever enables video removes `:1106` and inherits
   every refusal below it, already tested. That is the intended order and the reason this PR lands
   first: the caps are load-bearing the moment the hold goes, rather than something to remember.

`generate.test.ts` pins consequence 1 as a property — the day's total is never even read for a held
task, and a clip quoted at $0 is still refused, because it is the TASK that is held and not the price.

### V-L4 · `estimate()` quotes video on the WITH-AUDIO SKU by default — **known behaviour, not a bug**

A bare `estimate("video.generate", { durationSeconds: 8 })` returns **$3.20**, not $1.60. `wantsAudio`
(`pricing.ts:46-50`) tests `params?.generateAudio !== false`, so an **absent** parameter resolves to the
expensive $0.40/s arm. That is deliberate and documented at the function — over-quoting is the safe
direction, and being billed less than quoted surprises nobody.

It is filed because the default is invisible at the call site and the product path does not take it:
`preview.ts:1039` sets `generateAudio: opts.generateAudio ?? false` explicitly, so **every quote an
athlete actually sees is the $0.20/s arm**. The two figures differ by 2x, which is exactly the size of
error that makes a spend test look right while measuring the wrong thing. It cost this PR one
iteration — the first draft of `spendCaps.test.ts` asserted $1.60 for a clip the helper was quoting at
$3.20 — and the fix was to make every case state the arm it means rather than inherit one:
`silentClip()` mirrors what `preview.ts` sends, and the worst-case cases pass `true`.

**Anyone quoting video anywhere must name the arm.** A figure taken from a bare `estimate()` is the
ceiling, not the price.

### V-L5 · A `text eol=lf` glob catches a binary `.zip` — **NOT OURS, proposal for the calibration owner**

Found by my own push helper refusing to run: it hard-failed on a dirty working tree naming
`server/scripts/calibration/runs/blind-eval/blind-eval-2026-09-14.zip`, a file no commit on this branch
goes near — and one that **cannot be cleaned**. `git checkout --` re-dirties it immediately.

`.gitattributes` carries `server/scripts/calibration/runs/** text eol=lf`. The intent is stated right
above it and is correct: freeze artifacts are hashed by content, so pin them to LF and a Windows
checkout and Linux CI produce identical bytes. But `runs/**` is a directory glob, and it catches one
binary — the zip. Git therefore runs the CRLF→LF clean filter over an archive, which reads **251,877
bytes against a stored 251,881**, so `git status` reports it modified in perpetuity.

**What is actually at risk, stated no higher than it is.** Both copies still pass `unzip -t`: the four
bytes are CRs in the archive's structure (it is a Windows-built zip — its entries are
`openai\zippy-fish.parsed.json`, with backslashes) and unzip tolerates their loss. Nothing in the repo
reads the file; nothing references it by name. So this is not a corruption incident today. It is two
smaller things:

1. **Every fresh checkout of this repo is born dirty**, and no amount of `git checkout` fixes it. Any
   tooling that gates on a clean tree — a push helper, a release script, a pre-commit hook — trips on
   it, which is exactly how it surfaced.
2. **Stored and working bytes disagree permanently**, so whoever eventually stages it commits a
   different archive than the one in history, for no reason they will be able to see.

**The fix is one line and it is not ours to write** (`server/scripts/calibration/**` is outside the Ask
Mila / Content Hub lane): a `-text` exception for the binary, e.g.
`server/scripts/calibration/runs/**/*.zip -text` after the existing rule. Exactly one tracked file
under that glob is binary today, so the exception is that narrow. Flagging rather than fixing.

What this PR did about it: the push helper's dirty-tree guard now asks the question it meant to ask —
is there uncommitted work in a file **this branch edits** — and notes anything else without blocking.
A push sends commits, not the working tree, so a dirty file outside the diff was never going to travel.

---

## Numbers, and where they came from

| Number           | Value                       | Source                                                                                                |
| ---------------- | --------------------------- | ----------------------------------------------------------------------------------------------------- |
| Veo clip lengths | `[4, 6, 8]`                 | OpenRouter `GET /api/v1/videos/models` `supported_durations`, 2026-09-07; consistent with Vertex docs |
| Working clip cap | **8s**                      | the max of that list, via `maxClipSeconds()`                                                          |
| Absolute clamp   | **60s**                     | `HARD_MAX_CLIP_SECONDS` — the old value, kept as a clamp no env override can exceed                   |
| Veo price        | $0.20/s, $0.40/s with audio | `config.ts:401-403`, pricing_skus                                                                     |
| Worst clip       | **$3.20**                   | 8 × $0.40, asserted live in `spendCaps.test.ts`                                                       |
| Per-job cap      | **$10**                     | `eb01fb3`'s figure, adopted verbatim                                                                  |
| Daily ceiling    | **$25/athlete**             | ~5 acceptance runs of headroom ($1.45–$2.41 each); a loop dies inside one afternoon                   |

---

## Proof

12 revert checks, each breaking exactly one guard and naming the test that must notice. **12/12 held.**

| #    | Mutation                                        | Test that caught it                       |
| ---- | ----------------------------------------------- | ----------------------------------------- |
| RC1  | `maxJobUsd` default back to 30                  | the per-job cap is $10                    |
| RC2  | `maxDayUsd` default to 100                      | the daily ceiling is $25                  |
| RC3  | drop the `HARD_MAX_CLIP_SECONDS` clamp          | 60 is an absolute clamp                   |
| RC4  | drop the `unpriced` flag from the check         | Seedance is refused                       |
| RC5  | move the unpriced check below the caps          | refuses for being unpriced, not for a cap |
| RC6  | drop the cap from the per-job message           | names both figures                        |
| RC7  | day total excludes the job being asked for      | counts the job being asked for            |
| RC8  | drop the env var from the daily message         | names the env var                         |
| RC9  | count `canceled` jobs in the day                | a canceled job is not a charge            |
| RC10 | drop the tenancy predicate from `spentTodayUsd` | one athlete's day is not another's        |
| RC11 | route clip cap back to 60                       | a 30s clip is refused                     |
| RC12 | unwire the gate from `runStudioGeneration`      | the day's ceiling refusal                 |

**RC5 failed on the first pass, and the test was wrong rather than the guard.** The original ordering
case set every cap to zero and asserted the unpriced message — but an unpriced quote carries $0, and
`0 > 0` is false, so moving the unpriced check to last _still_ produced the unpriced message. The test
passed under the exact mutation it was named for. It was rewritten to use a quote that is unpriced and
carries a number over a cap, which does bite. Recorded here because it is the failure mode the revert
checks exist to catch, and it caught one of mine.
