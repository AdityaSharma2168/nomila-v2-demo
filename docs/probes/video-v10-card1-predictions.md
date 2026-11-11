# Card 1 (lastFrame, 1a+1b) — predictions, written BEFORE the build

**Written 2026-09-20, before a line of card 1 exists.** Not edited afterwards except §4.

## 1. What card 1 is, and what it deliberately is not

`GenerationInputs.lastFrame` has existed since V5 and the OpenRouter adapter consumes it correctly
(`videoImageFields`, `frame_images` with `frame_type: "last_frame"`). The probe has now shown the
field is load-bearing: same A, same B, same prompt, ratio **0.056** with it and **1.020** without.

Nothing on the product path can set it. Three sites, of which this card is two:

|     | site                                                                                                 | status                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1a  | `plannedInputs` never sets `inputs.lastFrame`                                                        | **this card**                                                                                          |
| 1b  | `runGeneration` resolves only `references`, so a stored `lastFrame` would reach the adapter unsigned | **this card**                                                                                          |
| 1d  | `vertex.ts submitVideoOperation` never sends one                                                     | **deferred** — Veo-only, unasked-for, and "Veo 3.1 takes a last frame" has no recorded capability read |

## 2. The shape, decided before writing it

**`PreviewOptions.lastFrameRef?: string`, a STORED ref — not an `ImageRef`, not a brief field.**

- _A stored ref, resolved late._ Everything else on this path is: `PlannedReference.ref` is a GCS path
  and `resolveReference` turns it into bytes or a signed url at generate time. A preview never
  resolves anything, and **a signed url must never be written to `studio_generation_previews`** — it
  would be frozen into a row and expire. Taking an `ImageRef` here would invite exactly that.
- _An option, not a brief field._ `durationSeconds`, `generateAudio` and `shotBeat` are all options
  for the stated reason that the brief describes the job. A `CreativeBrief` column is a shared-schema
  change, which is out of scope — and V10's transition supplies this from the TIMELINE (clip B's
  first frame), which is not a brief concept at all. If the keyframes UI later wants it on the brief,
  that is Mia's call and a migration.
- _Not a fifth `RefSlot`._ `types.ts:128` already argues this: a slot joins SLOT_ORDER, which every
  image path sorts against and which the prompt's manifest numbers from, so it would move image
  goldens for no reason.

## 3. Predictions

| #   | prediction                                                                                                                                                                                                                                            | confidence |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| P1  | **0 of 36 image goldens move.** Video returns before either image arm is consulted, and this touches only the video branch.                                                                                                                           | high       |
| P2  | **The full existing suite stays green with the field unset.** Every addition is behind `opts.lastFrameRef !== undefined`.                                                                                                                             | high       |
| P3  | **1b is the one that would have cost money.** A `lastFrame` set but unresolved reaches OpenRouter as a raw `gs://` or bare path; the request is billed and the fetch 401s or the provider refuses. Same class as `unsigned_urls` losing 7 paid clips. | high       |
| P4  | `estimate()` is unchanged by a last frame. Kling and Veo bill per SECOND, so a second image moves no quote. The probe's four cells invoiced $0.42 each with a last frame on three of them and none on the fourth.                                     | high       |
| P5  | The refusal in `videoPromptFor("transition")` still fires. Card 1 makes the field _settable_; it does not make `shotTypeFor` return `transition`. `shotType.test.ts:98` stays green **verbatim**.                                                     | high       |
| P6  | Untouched: `refIds` grows by one when a last frame is sent. It is log-only and never reaches a provider, but a frame that cost money to fetch should appear in the cost log beside the others.                                                        | medium     |

## 4. Revert checks — each names its own mutation

Every one must be RED under the named mutation and GREEN without it.

| id  | mutation                                                                     | must red                                                                                    |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| RC1 | `plannedInputs` ignores `opts.lastFrameRef`                                  | "sets lastFrame on the video branch from a stored ref"                                      |
| RC2 | `plannedInputs` sets `lastFrame` on an IMAGE task too                        | "never sets lastFrame on an image task"                                                     |
| RC3 | **`runGeneration` passes `inputs.lastFrame` through without resolving it**   | **"resolves lastFrame through the same resolver as references"** — the paid-clip-loss guard |
| RC4 | `runGeneration` resolves it but drops `slot`/`label`                         | "the resolved last frame keeps its slot"                                                    |
| RC5 | `lastFrame` is drawn from `references[last]` instead of its own option       | "a last frame is not the last reference"                                                    |
| RC6 | the option is read but the ref is passed as an `ImageRef` bytes/url directly | covered by RC3's resolver assertion                                                         |

**RC3 is the one this card exists for.** A test that only checks `lastFrame` is _present_ would pass
under the exact bug that loses paid clips, so it asserts the resolver **ran** — that what reaches the
router is the resolver's output and not the stored ref.

## 5. Result — BUILT 2026-09-20

All five revert checks RED under the mutation they name, green without it (verified by
`fullName` out of `--json --outputFile`, not by a count):

| id      | mutation                                  | red test                                                            |
| ------- | ----------------------------------------- | ------------------------------------------------------------------- |
| RC1     | ignore `opts.lastFrameRef`                | 5 red, incl. "sets lastFrame on the video branch from a stored ref" |
| RC2     | drop the `isVideo` guard                  | "never sets lastFrame on an image task, even when one is passed"    |
| **RC3** | **pass `lastFrame` through unresolved**   | **"resolves lastFrame through the same resolver as references"**    |
| RC4     | drop `slot`/`label` from the resolved ref | "the resolved last frame keeps its slot and label"                  |
| RC5     | draw it from `references[last]`           | 4 red, incl. "a last frame is not the last reference"               |

| #   | prediction                                                               | outcome                                                       |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| P1  | 0 of 36 image goldens move                                               | ✅ none moved                                                 |
| P2  | suite green with the field unset                                         | ✅ 150/150; shotType + prompts + openrouter + compile 167/167 |
| P3  | 1b is the one that would have cost money                                 | ✅ RC3 reds only under the unresolved-passthrough mutation    |
| P4  | `estimate()` unchanged by a last frame                                   | ✅ per-second SKUs; the probe's four cells all invoiced $0.42 |
| P5  | the transition refusal still fires, `shotType.test.ts:98` green verbatim | ✅ untouched                                                  |
| P6  | `refIds` grows by one                                                    | ❌ **FALSIFIED** — see below                                  |

**P6 falsified, and deliberately left alone.** `generate.ts` builds `refIds` from
`preview.references`, which by design excludes the last frame, so a frame that cost money to fetch
will not appear in the cost log beside the others. It is log-only and outside 1a+1b, so it is written
down rather than fixed — a one-line follow-up whenever somebody is next in that file.

`import/first` warnings are 7 on `main` and 7 here, checked in place: none added. The diff is 175
insertions and 0 deletions.
