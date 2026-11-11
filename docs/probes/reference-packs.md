# Reference packs — what changed, and every proof that is not a model call

R1 of the generation identity plan (`docs/plans/studio-generation-identity-plan.md`). The measurement
that _decided_ this build was the identity probe of 2026-09-15, which is recorded in that plan and is
not repeated here. This document is the build's own evidence: the corpus diff, the revert checks and
the goldens, all of which cost $0.

## The change, in one line

Several photographs of the same athlete now reach the model as ONE identity, said out loud, instead of
as several separate people described identically.

## What the athlete sees

| before                                         | after                                                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| a "You" tile, with nothing suggesting a second | "2 of 3 photos of you. Different days and different angles hold your face better than one photo can." |
| —                                              | "Photos of you only — not a friend, not a teammate."                                                  |
| "6 photos of you — this model takes up to 5"   | "6 photos of you — a piece can be built from up to 3. Remove one and check again."                    |

## The corpus diff — 48,528 prompt cells, $0

Every quoted string in the Studio test files that could be a direction (4,044 of them, the same corpus
source the classifier's route diffs have used since sweep #3), at twelve reference shapes, compiled
through `plannedInputs` on main `43e0f9b` and on this branch **in one process**, and compared.

| shape                 | byte-identical | moved | how                 |
| --------------------- | -------------: | ----: | ------------------- |
| `gen-0ref`            |           4044 |     0 | —                   |
| `gen-1ref`            |              0 |  4044 | LIKENESS_BLOCK_ONLY |
| `gen-2ref`            |              0 |  4044 | LIKENESS_BLOCK_ONLY |
| `gen-3ref`            |              0 |  4044 | LIKENESS_BLOCK_ONLY |
| `gen-4ref`            |              0 |  4044 | **NEWLY_REFUSED**   |
| `gen-5ref`            |              0 |  4044 | **NEWLY_REFUSED**   |
| `gen-3ref-product`    |              0 |  4044 | LIKENESS_BLOCK_ONLY |
| `gen-1ref-brand`      |              0 |  4044 | LIKENESS_BLOCK_ONLY |
| `gen-3ref-brand`      |              0 |  4044 | LIKENESS_BLOCK_ONLY |
| `gen-3ref-untrusted`  |              0 |  4044 | LIKENESS_BLOCK_ONLY |
| `edit-frame`          |           4044 |     0 | —                   |
| `edit-person-refused` |           4044 |     0 | —                   |

`LIKENESS_BLOCK_ONLY` is a machine check, not a summary: the only prompt lines that differ match
`— HER LIKENESS`, and the planned reference array and the blocker list are identical. So on every one
of those 28,308 cells the change is the likeness block and nothing else — not the header, not the
TEXT AND NAMES line, not the brand block, not the fence around an untrusted brief, not the DIRECTION.

**`NEWLY_REFUSED` is the one behaviour change, and it is the cap.** At four or five photos of herself,
main planned the job and this branch blocks it with
`4 photos of you — a piece can be built from up to 3. Remove one and check again.` Nothing is silently
dropped: over-capacity has always refused rather than trimmed what she tagged, and only the number and
the sentence moved.

**A generate with no photograph of her, and every edit, are byte-identical.** A person reference on an
edit is still refused, with the same sentence.

## Revert checks — 7 guards, predictions written first

Each production change was reverted on its own and the suites re-run. The predictions were written
down before any of them was run; all seven matched exactly.

| #    | reverted                                                       | predicted |   red |
| ---- | -------------------------------------------------------------- | --------: | ----: |
| RV-1 | the collapse (three per-image likeness lines back)             |         9 | **9** |
| RV-2 | the angle sentence re-added, nothing else                      |         5 | **5** |
| RV-3 | the scene release removed, nothing else                        |         5 | **5** |
| RV-4 | `CHARACTER_CAP` 3 → 5                                          |         3 | **3** |
| RV-5 | the person blocker sentence back to "this model takes up to N" |         1 | **1** |
| RV-6 | the person downscale removed                                   |         3 | **3** |
| RV-7 | `personPackNote` returns null always                           |         3 | **3** |

RV-2 and RV-3 are the two that matter most: the angle deletion and the scene release are separately
pinned, so neither can be lost inside the other's wording.

**RV-6 leaves three of its six tests green, and that is correct.** Two of them assert the FALLBACK — a
failed fetch or an undecodable file sends the reference as a url, which is exactly what shipped before
packs — and the third asserts the edit path is untouched. They pin the degradation, not the feature.

**RV-4 is what found a real hole.** The client's `MAX_PERSON` was asserted as the literal `3`, with a
comment claiming a server change would turn it red. It would not have. It now imports `refCapacityFor`
and compares against the real capacity of the model `image.generate` routes to.

## Goldens — 96 fixtures, 4 touched

| fixture                                                         |                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------ |
| `generate — a post with a brand, her likeness and a product`    | changed: the only existing fixture carrying a likeness |
| `generate — a pack of three photographs of her`                 | new                                                    |
| `generate — two photographs of her are not a range`             | new                                                    |
| `generate — a pack of three, then her product photo as Image 4` | new                                                    |

The other two generate goldens have no person reference and are byte-identical, as are all 90 edit
fixtures. The Image 4 one exists because the block collapses three images into one LINE, so the count
of manifest lines no longer equals the count of images — and a product addressed as Image 2 because
something upstream counted lines would tell the model to render her face as the product.

## The live acceptance runs — what they actually decided

Through the product path (`assembleBrief → previewGeneration → savePreview → runStudioGeneration`),
athlete `3811cedd`, portrait, "a portrait of me on a soccer pitch at golden hour…". $1.7747 over four
runs, of which **$1.0928 is void** — it predates the orientation fix and both its arms were sideways.

| references | which photograph                                            |             outcome |
| ---------- | ----------------------------------------------------------- | ------------------: |
| 1          | `e58f3a5a` — the outlier of her library, face 0.19 of frame | **a stranger, 6/6** |
| 1          | `25499d98` — a good upright photograph                      |        **her, 1/1** |
| 3          | the pack, **which contains `e58f3a5a`**                     |        **her, 4/4** |
| 3          | the pack, sent SIDEWAYS (pre-fix)                           |     a stranger, 2/2 |

And the ACTION pose — "mid-air doing a bicycle kick … under stadium lights at night, full body,
side-on" — re-run after the orientation fix, with the one-reference arm given the GOOD photograph so
the cell isolates the pose rather than re-measuring the outlier:

| references     | outcome |
| -------------- | ------: |
| 1 (`25499d98`) | **her** |
| 3 (the pack)   | **her** |

Both came back side-on with her face visible and in focus. R0's worry — that the single-reference arm
put the subject BACK-TO-CAMERA on this sentence (1 of 2 cells, and 2 of 2 on the no-reference control)
— did not reproduce in either arm with the angle sentence deleted. That is one cell per arm, so it is
an absence of the failure rather than evidence it is fixed.

**The count claim is false and the control killed it.** One good photograph of her is enough. What
failed six times out of six is one specific photograph — and the same photograph, inside a pack of
three, came back as her four times out of four.

**So the pack does not beat a good photograph; it stops a weak one from sinking the job.** That is
the claim the picker copy now makes, and it is the one the runs support. She has no way to know which
of her photographs is the weak one, which is what makes it worth saying at all.

⚠️ The single-reference failures are not random: across two runs and two prompt versions the outlier
produced the _same_ stranger — a woman about a decade older, with braids. That looks like the model
falling back to a generic "female soccer athlete" prior when the reference gives it too little, not
inventing someone fresh each time.

**n is small.** One athlete, two sentences, n=1 on the control and on both action cells. Every
conclusion here rests on single-digit sample counts and one person's eye.

## The cap, verified through the product path at $0

`assembleBrief → previewGeneration`, four person references, no frame, athlete `3811cedd`. Run at 3,
4 and 5 so the boundary is located rather than asserted, with a tripwire on `router.generate` that
throws if anything reaches the renderer. It never fired: **0 render calls, $0.**

| person references | status    |  quoted | blocker                                                                            |
| ----------------: | --------- | ------: | ---------------------------------------------------------------------------------- |
|                 3 | `ready`   | $0.2273 | —                                                                                  |
|                 4 | `blocked` |       — | `4 photos of you — a piece can be built from up to 3. Remove one and check again.` |
|                 5 | `blocked` |       — | `5 photos of you — a piece can be built from up to 3. Remove one and check again.` |

**Which layer refuses:** `referencesFor()` in `studio/preview.ts`, at `over(routedPerson,
caps.character, …)`, reading `CHARACTER_CAP` through `refCapacityFor("gemini-3-pro-image")`. Plan
time, inside `previewGeneration`.

Two things that matter more than "it blocks":

- **`assembleBrief` is not a gate.** It carries all four references through. Nothing upstream of the
  planner refuses.
- **Nothing REMOVES the fourth reference.** The planned list still holds all four beside the blocker;
  the job is refused whole. That is this file's standing rule for anything she tagged — silently
  dropping the photograph she chose would generate something other than what the screen says she
  asked for.

A blocked preview still carries a `plan` and a non-null `cost`, and that is dead data rather than an
approvable figure: `approvalRefusal` refuses any stored preview whose status is not `ready`,
`runStudioGeneration` re-derives the verdict and refuses before the router, and
`createGenerationJob` refuses a blocked preview a third time.

## ⚠️ The client cannot express this job, and that is a pre-existing bug

**UI acceptance of the pack could not be completed, and no code in this PR is responsible.** In the
tray, one attached photo is always designated EDITING — the frame — and the badge cannot be cleared:
X-ing it moves the designation to the next photo rather than removing it. So a reference-only
multi-photo generate cannot be expressed through the client at all; every attempt plans as an edit,
and an edit refuses person references outright (`refusedOnEdit`). A four-photo pack therefore cannot
be attempted from the UI, which is why the cap above is verified server-side instead.

This is the frame-defaulting behaviour, now logged as structural rather than incidental. It is
**outside this PR's scope** and is not worked around here: the server half is correct and provably
so, and the client half of R1 (the count, the reason, the consent line) renders correctly but cannot
be exercised end-to-end until the tray can express "no frame".

**2026-09-16 — addressed on `studio/frame-defaulting`** (not merged as this is written): a photo of hers is the
frame only when she marks it, the badge clears on a second tap, and a marked photo beside other photos of her asks
"edit the marked one, or a new image from all of them" before anything is checked. The evidence is
`docs/probes/frame-defaulting.md`; the four-photo acceptance above is Adi's to run on that branch.

## What is NOT measured here

- **The scene release has never been measured on its own.** It rode inside the `bound3` wording the
  probe ran, and on the single-photograph line it is an extrapolation from that arm.
- **Why the outlier fails is not established.** Face size in frame is the visible difference
  (0.19 against 0.39 and 0.38) and the plan already flagged it as the most distant of her seven, but
  nothing here separates "small face" from "unrepresentative photograph".
- **The 2048 downscale has never been measured against identity.** Every image in the probe went out
  at full resolution. If a pack ever looks worse than the same photographs did before this, that is
  the first thing to rule out.
- **Nothing verifies whose face is in a photograph.** The person slot's one-person boundary is carried
  by copy, by `refusedOnEdit`, and by the server reading every asset under her own athlete id.
