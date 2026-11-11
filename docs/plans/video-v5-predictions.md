# Video V5 — predictions, written before the diff

One branch, `studio-video-v5`, two commits. Predictions for each are written here BEFORE the code,
so a surprise is visible as a surprise. Anything outside prediction stops the build.

V5 does **not** enable generation. `STUDIO_VIDEO_ENABLED` stays dark. It makes the OpenRouter video
adapter correct (commit 1) and reachable from the runner (commit 2), for when the flag flips.

---

## Commit 1 — adapter correctness

Three changes to `server/studio/adapters/openrouter.ts`, one to `server/studio/types.ts`, and tests.

### 1.1 The bearer on download — PRIORITY

**The defect.** `generateVideo` returns the completed clip as `{ url }`. `storeAsset`
(`studio/generate.ts:761`) hands a url-only asset to `rehostFromUrl` (`lib/mediaStore.ts:37`), which
is a bare `fetch(url)` with no `Authorization` header. OpenRouter's `unsigned_urls` are **not**
unsigned — they are `/api/v1/videos/{id}/content`, ordinary authenticated API endpoints. A bare
fetch gets 401. The V2 run lost all seven of its billed Seedance clips exactly this way: generated,
paid for, undownloadable. The step-0 probe downloaded 4 of 4 **because it sent the bearer itself**.

**Where the fix goes, and why not in `mediaStore`.** `mediaStore.ts` is shared code and stays
untouched. The credential belongs where the provider is known, which is the adapter. So the adapter
downloads the clip itself and returns the bytes.

**Prediction — what changes on the wire and in the result:**

- A completed video job makes **one additional `fetch`**, to the content url, carrying
  `Authorization: Bearer <key>`. Sent **only** to `openrouter.ai`, so a host that is not ours can
  never receive our token.
- `assets[0]` gains `bytes`. `storeAsset` prefers `bytes`, so it takes `saveBuffer` and
  `rehostFromUrl` is **never reached** on this path. That is what keeps shared code untouched.
- `assets[0].url` is **kept**, not replaced. Two existing tests depend on it
  (`costLog.test.ts:284` asserts `outputRef` is the stripped content url; `router.test.ts:284`
  asserts `res.assets[0].url`), and the url is the only recovery handle if storage later fails.
  **Prediction: both stay green without being edited.** If either needs editing, the design is
  wrong, not the test.
- This makes the two providers agree rather than diverge: `vertex.ts` already returns
  `bytesBase64Encoded` as `bytes` for video, so buffering is the existing house behaviour, not a new
  memory cost invented here.

**⚠️ A download failure must not throw the spend away.** `router.ts:144` logs cost **only on
success**, and its comment ("a throw costs nothing") reasons about IMAGES, where OpenRouter bills
all-or-nothing. For video that reasoning is false: the clip is billed at completion, so a throw
_after_ completion loses both the clip and the record of paying for it. That is the V2 failure
repeated. So the download is wrapped: on failure it logs loudly and returns the asset **url-only**,
the router still writes the cost line with the url as `outputRef`, and the job fails downstream with
the money on record.

**Revert check (shown RED by name):** `sends the bearer when it downloads the finished clip` — a
test asserting the download call carries `Authorization: Bearer test-key`. Reverting the header makes
it fail; a stub returning 401 makes the no-bearer path observable.

### 1.2 `last_frame` — cherry-picked from `throwaway/kling-hard-cell` (978e73c)

`supported_frame_images` is a LIST and every video model in the registry advertises both members.
Only `first_frame` was ever sent, so a caller could pin where a clip STARTS and never where it ends.

- `types.ts` gains `GenerationInputs.lastFrame?: ImageRef` — deliberately **not** a fifth `RefSlot`,
  because a slot joins `SLOT_ORDER`, which the prompt's reference manifest numbers against, and a
  slot added for video would move image goldens for no reason.
- `videoImageFields` assembles first and last independently, so a lone last frame is legal.

**Prediction: strictly additive.** A caller that sets no `lastFrame` produces a **byte-identical**
request to today's. The 6 existing `openrouter.test.ts` video-body tests pass unedited.

**Revert checks (RED by name):** the three cherry-picked cases —
`sends the last frame as a SECOND frame_images entry, first then last`,
`does not take the last frame out of references — extra refs stay style refs`,
`a last frame with no references is a lone last_frame, not a first_frame`.

### 1.3 The under-quote fix — now VERIFIED, not assumed

`config.ts` prices Kling flat `$0.084/s` and exempts its audio arm in writing. OpenRouter's guide
says `generate_audio` "defaults to true for models that support audio output", so an **unset** flag
buys `$0.126/s` — a 50% under-quote, the one direction the pre-generation check exists to prevent.

The step-0 probe settled it: every cell sent `generate_audio: false` and every cell invoiced
**$0.5040 = 6s x $0.084**. The flag is honoured. So the fix is to send it, and the existing price
becomes true.

**Prediction: no pricing change is needed at all.** Kling has no `usdWithAudio` entry, so it already
quotes `$0.084`. Sending the flag makes that quote correct rather than optimistic. `defaultPrices()`
is **not edited**.

**⚠️ One deliberate exception to a house convention, flagged for review.** `providerParams` normally
"ride through untouched, and win". `generate_audio` is set **after** the `providerParams` spread, so
a caller **cannot** override it. Reason: the quote is written against audio-off. A caller who could
flip the flag would silently rebuild the 50% under-quote this change exists to remove. Audio and its
price are one decision and are kept coupled — turning audio on should require a code change that also
moves the price. (Per-clip audio is not wanted anyway; the bed comes from the V6 stitch path.)

**`router.test.ts:668` is updated** — "Kling has no audio arm to pick" becomes a statement that
audio-off is now _enforced on the wire_ rather than _assumed_. Adi signed this off explicitly; it
pins a deliberate decision and is not being rewritten to make my own change pass.

**Revert check (RED by name):** `forces generate_audio off, so the flat $0.084 quote is the real
price` and `a caller cannot buy the expensive audio arm through providerParams`. Dropping the line
leaves the flag unset (the expensive arm); moving it above the spread lets a caller override it.

### Test-harness consequence, predicted

Three suites stub `fetch` and queue exactly the calls the video path makes:
`adapters/openrouter.test.ts`, `router.test.ts`, `costLog.test.ts`. The download is a **new third
call**, so each harness needs one more queued response. **Prediction: those are harness edits, not
assertion edits** — no existing expectation changes. If an assertion has to move, that is a finding
and it stops the build.

### Gate

`npm test` bare — full suite, not a scope. Both `tsc -p tsconfig.json` and
`tsc -p tsconfig.jest.json`. Baseline to beat: the peer session measured 356 suites / 6616 tests / 0
failed on main today. `affiliationSync`'s "year-only from/to" is a known ~1-in-3 house flake — a lone
red there is not this diff.

---

## Commit 2 — reachability

### The design decision, made before any code

**Provider comes off the STORED ROW, never off current config.** `generation_jobs` already
carries both `provider` and `model`, written at queue time from the frozen preview plan
(`studio/jobs.ts:80-81`) — so **no DDL and no heuristic is needed**, and the model id's shape
never has to be parsed to guess where it belongs. The row is the record of what we committed
to; `routeFor()` only answers what we would do now.

The failure this avoids is not hypothetical and it is worse than a refusal: a clip queued while
`STUDIO_VIDEO_PROVIDER=openrouter`, claimed after the flag moved to vertex, would be **submitted
to Vertex** — or, on a resume, would poll an **OpenRouter job id against Vertex's
`fetchPredictOperation`**, which fails looking like a dead job rather than a misroute.

⚠️ `router.resolve()` falls back to route config when `opts.provider` is `undefined`, so a NULL
`provider` column must be resolved EXPLICITLY, never left to fall through.

### 2.1 The OpenRouter submit/poll split

`generateVideo` polls to completion in one call; the runner's contract needs the two halves
separately so a handle can be persisted between them. Mirrors `vertex.ts` exactly:
`submitVideoOperation(inputs, model, opts) => Promise<string>` and
`pollVideoOperation(handle, model, inputs, opts)`, with `generateVideo` becoming the composition
of the two — which is the shape `vertex.ts` already has.

**Prediction: all 17 `openrouter.test.ts` cases pass UNEDITED.** `generate()` still composes the
same two halves, so the wire body is byte-identical and the download still happens at the end of
the poll. If any wire assertion moves, the split changed behaviour and that stops the build.

### 2.2 Runner dispatch

`GenerationAdapter` gains an optional `video?: { submit, poll }`. Vertex and OpenRouter implement
it; fal does not, and does not have to — it has no video and the optionality says so in the type.
The runner resolves through the **existing** `router.resolve()` registry rather than a parallel
map, passing the row's provider and model as overrides so neither is read from config.

**Prediction: all 10 existing `videoRunner.test.ts` cases pass UNEDITED.** They seed
`provider: "vertex"` and mock `./adapters/vertex`, which is still the module the vertex arm
reaches. If one needs editing, the dispatch changed Vertex's behaviour, which it must not.

Model translation stays provider-local: vertex gets `vertexModelFor(job.model)`, everything else
gets `job.model` verbatim, because `routes()` already stored it in its provider's own form.

**A NULL `provider` resolves to vertex, and that is reading history, not falling back to config.**
Such a row was queued when the runner was hardwired to Vertex and no other provider was reachable,
so Vertex is what it was committed to. An unknown or non-video provider is REFUSED rather than
guessed — no spend on a guess.

### Revert checks (RED by name, through the REAL runner path)

Mocked at the network and credential boundaries only — `global.fetch` and `google-auth-library`,
the way `vertex.test.ts` already does — with **both adapters real** and PGlite rows. The assertion
is which HOST was called, so it proves routing end to end rather than that a mock was invoked.

1. `routes an OpenRouter job to OpenRouter, not to Vertex` — red against the hardwired path.
2. `a config flip between queue and claim does not misroute an in-flight job` — row says
   openrouter, `STUDIO_VIDEO_PROVIDER=vertex`, must still reach openrouter.ai. Red the moment
   dispatch consults current config.
3. `a resume-poll goes to the provider that holds the operation` — row with a stored handle polls
   that provider's endpoint and submits nothing. Red against the misroute.
4. `submits exactly once across a die-and-hand-off cycle, on OpenRouter too` — the original
   brief's submit-once property, on the arm that did not previously exist.

### Gate

Same as commit 1: bare `npm test`, both tsconfigs. Announce to the V7 session first.

⚠️ Check before handing over: the reformatting check across every changed file (base vs now), and
whether anything here touches the lease/reap paths the V7 stitch runner shares an advisory-lock
namespace with. Dispatch sits inside `workJob`; `videoTick`, the claim and the reaper should be
untouched, and if that holds there is no collision to coordinate.
