# VIDEO PROMPT/PAYLOAD QUALITY — LEDGER

> Recon 2026-09-20 on main 512de3a (V10 = #532). Four cards: structured shot slots, b-roll prompt
> structure, face preservation, Veo audio. This file is the list of what was FOUND and not fixed, so
> that "harmless today" has somewhere to be written down other than a commit message.

## Recorded defects — open

### D1 · Env drift: a prompt compiled for one model can be sent to another

The video prompt is not stored and replayed; it is RECOMPILED at run time from the frozen brief
(`videoRunner.inputsFor` → `plannedInputs(brief, {})`). The run DISPATCHES on the job row
(`job.provider` / `job.model`, frozen at queue time), but the recompile goes through
`videoRouteFor`, which reads env at call time (`STUDIO_VIDEO_BROLL_MODEL` and friends,
`server/studio/config.ts`).

Today this is invisible: `videoPromptFor(shot, brief, beat)` does not take the model, so the text is
the same whichever model env names. The day templates become per-model (card 1 rung 7 — Veo wants
framing/movement/lighting as prose, seedance wants it terse), an env change between quote and run
compiles the prompt for model A and sends it to model B. Nothing errors.

It is quote/run drift wearing a new hat: the same class as `kind → role` (485cb6f) and
`durationSeconds` (de8826f). **Blocks rung 7.** The fix is one of: compile against the ROW's model at
run time, or freeze the template key on the brief.

### D2 · The video runner drops every reference's slot

`videoRunner.resolvedReferences` maps `resolveStoredReference` over the planned references and
returns the results as they come. `resolveStoredReference` returns a bare `{kind, bytes|url}` — the
`slot` and `label` the planner typed (the "flattening fix", ledger #2 in preview.ts) are carried over
by `runGeneration` on the IMAGE path and by nothing on the video path.

So on a clip, `orderBySlot` — which both video adapters use to pick the first frame — sees untyped
references and degrades to array position. Harmless while the planner emits the frame first, which
it does. It stops being harmless the first time a clip carries a mood board or a product ahead of
her photograph: the wrong image becomes the first frame, and `frameForClip` (which asks the same
question the same way, on purpose) crops the wrong one too.

"Harmless today" is what the duration hole was until the flag flip was scheduled.

### D3 · `PreviewOptions.durationSeconds` is dead-but-plausible wiring

The brief beats it and the route no longer sets it (de8826f). It survives because four probe scripts
pass it. **Scheduled, soon, its own commit:** delete it, and move the scripts to the brief path or to
an escape hatch whose NAME says harness-only. `PreviewOptions.shotBeat` is the same shape and worse:
no caller sets it at all, so `identity-pose` is unreachable in the product.

### D4 · The stitch runner never ducks the bed

`plan.ts` ducks only when `bed.duck` is set; `toStitchRequest` passes `{ source }` alone, under a
comment that says "ducked" (`video/spec.ts`). Inaudible while every clip is silent. It is the first
thing that breaks if clip audio is ever turned on — see the audio memo below.

### D5 · Clip QA's text check cannot fail a b-roll clip for signage

`qa/text.ts` fails only on a person's name or handle; signage and brand text are
"Recorded, never a failure". The stage runs only under `STUDIO_CREATIVE_QA=true` and no route reads
`creative_qa`. So "the template prevents, QA detects" has no second half yet.

### D6 · The video tick endpoint is not gated by the video flag — a flip-checklist DECISION

`POST /api/internal/studio-video-tick` (`server/index.ts`) checks the cron secret and nothing else:
it does not read `STUDIO_VIDEO_ENABLED`. `videoTick` claims the oldest queued video job in the
database, whoever queued it.

Fine today, and confirmed rather than assumed: Adi listed the schedulers on 2026-09-20 and no
`studio-video-tick` job exists on dev or prod (only `studio-stitch-tick-dev`, the free path, which
cannot claim generation jobs). So nothing calls it.

It stops being fine on the day the video-tick schedulers are created. At that point the relationship
between the endpoint and the flag has to be CHOSEN, not inherited: either the tick refuses while the
flag is off (so a scheduler created early is inert), or it deliberately drains regardless (so a job
queued before a flag rollback still completes — it has already had its approval consumed, which is
an argument for draining). Both are defensible; having neither written down is not. **Goes on the
flag-flip checklist.**

## Decision record — Veo audio: PARKED (2026-09-20)

Parked pending D4. The facts the decision rests on:

- The wire field is `parameters.generateAudio`; the product sends an explicit `false`
  (`preview.ts`), and no caller, route or client sets it.
- Quote already equals invoice. An explicit false buys the silent SKU (`pricing.ts` `wantsAudio`),
  so she is quoted and billed $0.20/s. The "defaults to the with-audio SKU" behaviour applies only to
  a bare `estimate()` and to Veo over OpenRouter. Audio on is $0.40/s: 8s goes $1.60 → $3.20.
- The stitcher is safe with mixed audio/silent inputs (`anullsrc`, separate folds, `acrossfade`).
  Players are muted by default; only the stitch result plays unmuted.
- The OpenRouter adapter hard-forces `generate_audio: false` BELOW the params spread, with a written
  decision that per-clip audio is not wanted because the bed comes from the stitch path.
- A PreviewOptions seam would quote audio-on and run audio-off (the runner replays `{}`), so the two
  real routes are: flip the default (1–2 commits, Veo only), or a per-clip brief field (3–4 commits,
  inherits the frozen-brief rules).
- Unverified: Google's doc default for the flag; whether a Veo audio stream's length matches its
  video's; what Veo generates (ambient vs speech) when the prompt says nothing about sound. Clip QA
  looks at frames only.

## Veo reference images — doc read (2026-09-20, $0) — ALL SECONDHAND

Google's Vertex pages render navigation only through the fetcher; nothing below was read from a
primary parameter table.

- First frame (`image`) and `referenceImages` are reported mutually exclusive in one request, by
  several third-party guides quoting an API error.
- A reply attributed to Google staff on the AI developers forum: "referenceImages only supports 16:9
  at the moment." Our clips are 9:16.
- Veo 3.1 Standard takes up to 3 asset references; Fast does not. Whether our pinned
  `veo-3.1-generate-001` on Vertex accepts them is unconfirmed.

Consequence: probe cell C (crop + references) is not runnable for a vertical clip. The probe is A/B.
