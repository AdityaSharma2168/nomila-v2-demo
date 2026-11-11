# PR 4 — doctrine enforcement, connected-video ingestion, flip checklist — ledger

Branch `studio/ingest-flip` off origin/main 70f38c4 (#563 c3-doctrine2 merged; #562 brand-profiles
before it). Test athlete `3811cedd`, sport soccer; real clip `d076a790`; AI camera-roll uploads
`e055746a`, `64c9bf0d`. Probes under gitignored `probe-out/ingest-flip/`. Commit 0 (6178bcf) put
the video use-cases brief in `docs/specs/` as PDF + extracted text. Order: A → B2a → B2b → C.

Approved 22 Sep 2026 (Adi): A1a + A1b as scoped, no motion word-list, $0.40 cap. B in full, split
B2a (the two shared edits Mia approved) / B2b (Studio half). C1 SHA on the Studio router; C4
`server/lib/safeFetch.ts` + two call sites (Mia cleared it for this PR); C5 from the pricing page.

## Lane A · i2v demotion

**Rule:** an image becomes an i2v only when her ask wants her IN MOTION and no CLIP line from her
camera covers that moment; otherwise it is held, or pushed in. Both conditions are judgments
about the moment, so the doctrine carries them (A1a); code enforces the one condition it can read
(A1b): on an own-footage brief (`asksForOwnFootage`, the reading the planner is given), her
camera covers the brief by her own words, so an i2v is held pushed-in on the same photo ($0) and
the card says why. No word-list for "motion": it would strip hype and boots-then-match, whose
criteria allow an i2v.

**A1a — prediction, before the commit.** Rule 1 gains the sentence; DOCTRINE_RULES stays 9; the
tripwire list gains its phrase. Mutation "delete the sentence" → reds by that phrase in plan.test.

**A1b — prediction, before the commit.** `castPlan` with `ownFootage`: an i2v whose photo is cast
(named, picked or searched — after S1b only camera, synced or picked can reach it) comes back
`kind: "image"`, `motion: "pan"`, same asset, `demoted` set to the card line; off an own-footage
brief the same item is an i2v as before. Rule 3's own-footage clause and the cast order state
camera > connected > made-here (B2b adds the connected half). Mutation "i2v exempt on own footage"
→ reds by name in cast.test and studio.agent.test.

**Live — prediction, written before either run.** Ad-brief control "a soccer ad with me in it"
(objective grow-following, the Agent screen's default), n=3 BEFORE on this tip's server and n=3
AFTER A1a+A1b, through the real route, 6 planner calls, $0.40 cap:

- i2v items across the three cells drop by at least half (before: expected ≈ 1 per cell, Adi's
  11:32 control cast one — 5581e882);
- held/pan items rise by the same count;
- d076a790 clip slots per cell unchanged ±1, and no cell loses its last camera slot.

The ad brief is not an own-footage brief: only A1a's sentence acts on it. A1b is held by fixture.

### Lane A · before, measured (6178bcf, server started from this worktree, 3 calls, 22 Sep 2026)

Ad-brief control "a soccer ad with me in it", grow-following, n=3 — **i2v 3 of 3 cells, every one
5581e882 (camera)**; held images 1 (e64e900a, pushed in, #1); d076a790 slots 2 · 2 · 3; camera
4/5 · 5/5 · 5/6; one made-here clip (ebe01971) in #0 and #2; b-roll from words once (#0). List
price $1.41 · $0.80 · $0.80. Tokens: this server was not tee'd — booked from Adi's terminal
(pending). So the after-run's bar is: i2v ≤ 1 across three cells, held/pan ≥ 3, d076a790 2–3 per
cell.

## Lane B · connected video

### B1 · recon (22 Sep 2026, code read at 70f38c4)

- Instagram media lands through `server/skills/rehostAthleteMedia.ts` as `origin='connected'`,
  `media_type='VIDEO'` for a reel (Graph's `media_product_type` is dropped at
  `lib/integrations/instagram.ts:512,819`), and a VIDEO row holds the POSTER jpeg only.
- `server/skills/fetchTopVideoFiles.ts` swaps the mp4 in for the top 8 by views, daily at 04:30 in
  the production cron only — nothing triggers it locally. It moved the poster to `gcs_thumb_path`.
- The poster cron (`services/videoPoster.ts:210`) selects `origin IN ('upload','generated')` AND
  `gcs_thumb_path IS NULL` — so it never saw a connected row twice over: no precise duration, no
  1080p transcode, no `original_gcs_path`.
- The enrich cron's clip predicate (`studio/enrich/videoEnrichment.ts:83`) has no origin filter;
  a connected mp4 row with a poster is already a candidate. `STUDIO_VIDEO_ENRICH` is in neither
  Cloud Run yaml, so only a local run tags a clip.
- The Studio folds connected/discovery → `synced` ("synced from her accounts"); no rule of the
  doctrine names synced; `listClips` ranks upload 0, connected 1, generated 2.
- The test athlete's clip room today (route-probe dry, 6178bcf): d076a790, e055746a, 64c9bf0d
  (camera) + five made-here clips — **no synced clip**.

### B2a · the two shared edits (Mia-approved, 22 Sep 2026) — prediction before the commit

1. `fetchTopVideoFiles` reads `INSTAGRAM_VIDEO_FETCH_CAP` (default 8 — prod unchanged until PR 5's
   flip; 25 in Adi's .env) and no longer writes `gcs_thumb_path`: the poster worker makes the
   poster, measures the duration, transcodes and writes `original_gcs_path`.
2. The poster cron's origin list gains `connected`. Nothing else in its WHERE changes.

Tests: fetch — the env cap is honoured (a row past the cap is not fetched) and the thumbnail is
left null; mutation "cap ignored" reds by name. Poster — a connected posterless mp4 is processed
and keeps its origin; mutation "connected dropped from the origin list" reds by name.

**Live (approved as one-shot, in-process, her rows only):** N connected rows become video rows
for 3811cedd after the fetch; after ⌈N/3⌉ poster passes all N carry a poster, a precise duration
and `original_gcs_path`, and **zero rows change origin**. Enrich afterwards (quoted first):
provenance `no-device-metadata`, encoder Lavf.

**On merge, stated:** new fetches in prod carry no thumbnail until the next poster tick (the
scheduler runs every 5 min, `provision-schedulers.sh:68`); the previously-kept Instagram poster
objects are orphaned — carded, not cleaned.

### B2a · live — BLOCKED on data (read-only probe, 22 Sep 2026)

`probe-out/ingest-flip/ig-rows.ts` on 3811cedd, aggregates only: her `instagram` connection is
**`pending`**, not active, and she holds **no stored Instagram video row** — one `REELS` row with
`status='failed'` (and four failed TikTok rows). `fetchTopVideoFiles` returns `{0,0,0}` at its
connection check, so the live N is **0** on the test athlete. The shared edits are proven by
fixture and mutation; the live leg waits on a connected account (Adi's call).

### B2b · the Studio half — predictions before the code

1. **Enrich visits connected** — no code: the clip predicate has no origin filter. A fixture holds
   it: a connected Instagram mp4 with the poster worker's poster and `original_gcs_path` is tagged
   with beats, probed at its ORIGINAL, and a Lavf container with no device atom scores
   `no-device-metadata` with `encoder: Lavf…`. Mutation "provenanceOf skips connected" reds by name.
2. **"from: her instagram"** — `platform` rides the castable row, the library entry and the cast
   item; a synced row whose platform is instagram reads `from: her instagram` on the planner's line
   and **FROM YOUR INSTAGRAM** on the card; any other synced row keeps "synced from her accounts".
   Mutation "platform ignored" reds the label case by name.
3. **Doctrine order on an own-footage brief: camera > connected > made-here** — rule 3's clause and
   `OWN_FOOTAGE_LINE` name it; the rule count stays 9. The cast's search swap on an own-footage
   brief takes the best provenance group first (camera, then synced), brand-clean within it.
   Mutation "no provenance order in the swap" reds by name. `listClips` already ranks upload 0 ·
   connected 1 · generated 2, so acceptance-recap still offers d076a790 first.

## Lane C · flip checklist — predictions before the code (22 Sep 2026)

### C1 · 0060, the ticks, the SHA — and the enrich tick (Adi's addendum)

**0060 on dev — verified read-only, no code.** `gh run view` of deploy-dev: #562's run
(35780762987, 20:40Z) applied `0060_studio_brand_profiles`; #563's (35784720351, 21:09Z) re-ran it
idempotently (`NOTICE: relation … already exists` on every CREATE) and step 5/6, the HARD drift
gate, printed `✅ No drift`. No ledger table exists for hand-written migrations, so the deploy log
and the drift gate ARE the record. The scheduler read (`gcloud scheduler jobs list`) was denied to
Claude — Adi runs it (card below).

**SHA at startup — the Studio router, not server/index.ts.** `server/studio/buildInfo.ts` (pure,
runner injected): `K_REVISION` on Cloud Run, else `git rev-parse --short HEAD`, else null; the
router logs it once at module load (`studio router ready`, `revision`, `source`). Mutation
"K_REVISION ignored" reds by name. Prediction: the next local start logs this worktree's short SHA
— the memory rule "verify the server's build before acceptance" becomes one grep of the log.

**The enrich tick — cap and bound are code.**
- `STUDIO_ENRICH_DAILY_CAP_USD`: per athlete per UTC day, across every run. Each clip call that
  reached the model records its settled cost on its row (`metadata.enrich_spend = {day, usd}`, one
  key, jsonb_set; a transport error books the estimate — a ceiling, like the day cap). A chunk
  sums today's spend per athlete, leaves out athletes at the cap, and skips (untouched, no attempt)
  a clip whose estimate would cross an athlete's remaining day. The day key rolls at 00:00 UTC —
  that IS the resume. **Unset = no daily cap** (today's behaviour; the lane is off on Cloud Run).
- `STUDIO_VIDEO_ENRICH_CHUNK`: the clip lane's chunk bound, default 8 (unchanged).
- Tests: two clips, a cap that fits one → the first tagged, the second untouched, `dailyCapped 1`,
  spend recorded under today; an athlete already at the cap → nothing selected, no model call;
  yesterday's spend is not counted. Mutation "daily cap ignored" reds by name.
- **Found, for the card:** the enrich route (`server/index.ts:799`) loops up to `maxTicks` (60)
  chunks per request, and each chunk makes a fresh $2 `RunBudget` — so one request can spend far
  past one batch. The route already reads `maxTicks` from the body; the new job sends
  `{"maxTicks":1}`, which makes one request one batch without touching index.ts. And
  `provision-schedulers.sh` sends `"{}"` and rewrites every job's body on each run — so the tick is
  its own job, never an edit of `media-enrich-cron`.

### C2 · EXPO_PUBLIC flags

`tools/expo-flags/list-expo-flags.sh` greps `client/` for `process.env.EXPO_PUBLIC_*` and prints the
unique names; `--script` prints an `expo-dev.sh` that sets every STUDIO_* one true, the rest left
to `.env`. Prediction: 9 names (5 STUDIO_*), no `EXPO_PUBLIC_STUDIO_BRAND_PROFILES` (server-only).
The regenerated `~/nomila-v2-worktrees/expo-dev.sh` sets the 5. The workflow settings are a card.

### C3 · .env hygiene

A command that prints duplicated key NAMES (never values) — Adi applies it. The tee convention,
key-limit policy and worktree hygiene go in `docs/studio-dev-hygiene.md`. Prediction: STUDIO_ENABLED
×3 appears in the list.

### C4 · SSRF

`server/lib/safeFetch.ts` + `fetchPage` and `fetchImageBytes` wired. https only; resolve and refuse
loopback, RFC 1918, CGNAT, link-local (169.254/16, fe80::/10), ULA, unspecified, multicast and
`metadata.google.internal` by name; `redirect: "manual"`, every hop re-checked, 5 hops. No new
dependency (node's `net.BlockList` + `dns.promises.lookup`). Tests stub DNS and fetch, never the
network. Mutations: "redirect allowed" (redirect: follow, hops unchecked) reds by name; "metadata
host allowed" reds by name. Carded: mediaStore.ts:37, studio/adapters/vertex.ts:133,
rate/validateRateCitations.ts:65, and the DNS-rebinding window (the connect is not pinned to the
checked address without undici).

### C5 · the planner's price

From Google's published price page for `gemini-3.1-pro-preview` (URL cited when fetched); a text
token `Price` unit in `server/studio/config.ts`, `studioPlanEval` reads it instead of asking for
`--usd-in/--usd-out`. Today's runs re-booked at the real rate as one correction line in both
ledgers. Prediction: the rate differs from the assumed $1.25/$10 per M, so every figure booked
today moves.

### C5 · measured — the rate, and the day re-booked

**Rate:** `gemini-3.1-pro-preview`, paid tier, standard: **$2.00 in / $12.00 out per M** for a prompt ≤ 200k
tokens (output includes thinking), $4.00 / $18.00 above — https://ai.google.dev/gemini-api/docs/pricing,
read 22 Sep 2026 (page "last updated 2026-09-22"). The planner calls **Vertex** (`global`); the Vertex price
page came back truncated from the fetch twice, so the Vertex figure is **unconfirmed** — the first invoice
line settles it. Prediction held: the rate differs from the assumed $1.25/$10 — it IS the "alternate".

**Built:** a text-price table beside `Price` in `server/studio/config.ts` (`textPriceFor`, `textCallUsd`,
`STUDIO_TEXT_PRICE_JSON` override), priced per call because the tier is chosen by one prompt's size;
`studioPlanEval` prints the registry figure and falls back to `--usd-in/--usd-out` only for an unpriced
model. Test: the after-S1b mean call is $0.0751 (was $0.0602); mutation "long tier ignored" reds by name.

**Re-booked (one line, in c3-doctrine2.md):** A $2.33 · round 2 $1.41 · before-S1b $0.43 · after-S1b
$1.13 — **$5.30, not $4.22**. Two runs were over their caps at the real rate (A by $0.23, after-S1b by
$0.33). **Lane A here:** 6 calls ≈ $0.45 at the real rate — over the $0.40 cap approved on the old
per-call figure; the after-run waits on Adi's word (raise to $0.50, or n=2).

### Lane A · after, measured — the prediction MISSED (222e5af, server restarted 14:58, 3 calls, 22 Sep 2026)

Server start logged `studio router ready  revision 222e5af  source git` (C1's line, first live start — held).
Ad-brief control, n=3, same brief, same objective:

| | before (6178bcf) | after (222e5af) | predicted |
| --- | --- | --- | --- |
| i2v items | 3 — 5581e882 (camera) ×3 | **3** — 5581e882 (camera), 37e0eedb, 354c4ff4 (made-here) | ≤ 1 — **missed** |
| held / pushed-in | 1 — e64e900a (camera) | 3 — **3bb6f269 (made-here) ×3**, "premium brand sign-off" | +2 — count held, wrong photo |
| camera slots | 14 of 16 | **7 of 14** | none lost — **missed** |
| d076a790 beats | 2 · 2 · 3 | 2 · 1 · 1 | ±1 — **missed** |
| b-roll from words | 1 | 2 | — |

**Read.** A1a's sentence did not demote the i2v — every cell kept one, and two of three moved the i2v
onto a made-here still. The held/pan slots it added are one made-here "sign-off" still, pushed in, in
every cell — round 2's finding again (a $0 made-here still is attractive; S1 gates i2v, and an image
off an own-footage brief is allowed) — and camera share halved. n=3 cannot separate the sentence from
variance (the before's 14/16 was high), but the direction is wrong on every count that moved. B2b's
rule-3 sentence is also live on this server; it names only her instagram and she has no synced row,
so it is the less likely author. **A1b is untouched by this** — code, fixture-proven, own-footage only.

**Spend:** before 16,665 in / 15,128 out = **$0.215**; after 16,959 in / 10,239 out = **$0.157**
($2/$12, the registry rate); **Lane A $0.372**, under the $0.40 cap. (A fourth `plan derived` line in
the tee, 5,663 in, landed before the probe started — not this run's.)

### A1a — REVERTED (Adi, 22 Sep 2026) · the card

**Measured** (ad-brief control, n=3 each, 6178bcf → 222e5af): i2v **3 of 3 cells, unchanged**; the added
holds went **all to 3bb6f269 (made-here), pushed in**, "premium brand sign-off"; camera slots **14/16 →
7/14**. Reverted as 6459e1a; A1b (own-footage demotion, code) stays.

**Carded, for PR 6:** a made-here still is never held or pushed in when a camera beat covers the moment.
"Covers the moment" is a judgment the cast cannot read today — it needs the capability score (what a
beat can stand in for), which is PR 6's problem. Rule 1's sentence goes back in only with a mechanism
behind it and a measured n ≥ 5.

## A2 · meta images are never castable as held or i2v unless picked — prediction before the code

**What a meta image is** (read-only probe `meta-rows.ts`, her rows): `vision.shot_type === "text_graphic"`
OR a closed vocabulary in the tagger's description/setting — screenshot, screen grab, mockup, phone
frame, abstract graphic, colour block, split/solid colour. NOT "graphic background" (real studio
portraits of her) and NOT "text overlay" (campaign stills — rule 2's sign-off). Her library holds 7:
the made-here Instagram screenshot 8fbe1dff (round 2's pushed-in "aftermath" on a live brief), two
uploaded colour blocks (b9920e2a text_graphic, cf5ba50e other), a made-here colour block, a made-here
text_graphic with her name overlaid, a made-here Instagram screenshot, a made-here smartphone mockup.

**Built:** `isMetaImage(vision)` in cast.ts; `CastableRow.meta`; `fitsKind` refuses a meta row for
`image` and `i2v` unless `picked`; the left-out reason says `meta_image`. Mutation "meta images
castable" reds by name in cast.test.

**⚠️ What A2 cannot move:** 3bb6f269 — the still that took the held slots — is `shot_type: action`,
her present, under a brand banner. It is not a meta image. So on the re-run camera share can only come
back through A1a's REVERT, and the run doubles as the test of whether A1a caused the drop.

**Re-run — prediction, before it** (ad-brief control, n=3, server on the A2 tip, $0.20 cap): camera
slots **≥ 12 of 14** (the revert); **zero meta rows cast**; i2v count **unchanged from baseline (3)**.
If camera stays near 7/14 with A1a gone, the drop was variance (or B2b's sentence), not A1a — and the
revert was right for a different reason: no evidence it helped.

### A2 re-run — measured (252ddf4, A1a reverted; server restarted 15:09, `revision 252ddf4`; n=2, 22 Sep 2026)

**Stopped at n=2 on the cap:** the first two calls booked **$0.140** (11,198 in / 9,828 out at $2/$12); a
third (~$0.07) would have passed the $0.20 cap.

| | before (6178bcf, n=3) | A1a (222e5af, n=3) | A1b + A2 (252ddf4, n=2) | predicted |
| --- | --- | --- | --- | --- |
| camera slots | 14/16 (88%) | 7/14 (50%) | **7/11 (64%)** | ≥ 12/14 — **missed** |
| meta rows cast | 0 | 0 | **0** | 0 — held, not discriminating |
| i2v | 3 — 5581e882 camera ×3 | 3 — 2 made-here | **2 — 5581e882 camera ×2 (1 per cell)** | unchanged — **held** |
| 3bb6f269 held | 0 | 3 | 1 | — |

**Read.** With A1a gone the i2v refs are back on her camera photo in both cells (A1a had moved 2 of 3 to
made-here stills) — the one clean signal, and it points at A1a. Camera share came back only part-way,
and at n=2 that is inside the spread between the before and A1a runs: **these runs cannot say whether A1a
caused the camera drop.** "Zero meta cast" is true on every run of this brief, before A2 too — A2's
proof is its fixtures and the mutation, not this brief. The camera question is PR 6's (the capability
score) and the held made-here still is the card above.

**Lane A spend, all runs:** before $0.215 · A1a after $0.157 · A2 re-run $0.140 — **$0.512**.

### The A2 re-run's non-camera slots, and whether the library moved (Adi's question, 22 Sep 2026)

| cell | items | camera | non-camera — id · provenance · kind |
| --- | ---: | ---: | --- |
| #0 | 5 | 4 | ebe01971 · made-here · clip |
| #1 | 6 | 3 | 4ecafec0 · made-here · clip; ebe01971 · made-here · clip; 3bb6f269 · made-here · image, pushed in |

All four are made-here; **zero synced / connected rows in the library on every run** (before, A1a, A2) —
she holds no stored Instagram video (B2a's blocker).

**The library did not move.** Every probe call on all three runs recorded 31 entries (photos 6 camera /
17 made-here, clips 3 camera / 5 made-here) and the same eight clip ids in the same order; the server's own
`agent library assembled` lines agree (`found 24`, `herSurvivors 20`, `library 31`, same clips) on all eight
probe calls. The probe did NOT record photo ids — so `lib-drift.ts` (read-only, her rows, aggregates) closed
it from the table: **no row of hers created, ingested, deleted or re-tagged after 20:20Z (13:20 PDT)**, before
every run. The probe now records every offered id for next time.

**So the camera comparison is not confounded by the library — it is confounded by the prompt and by n.**
Before (6178bcf) and A2 (252ddf4) differ in B2b's rule-3 sentence (conditional on her instagram; nothing
here fired it, but it is text in the prompt) and n is 3 vs 2. **The ad-brief baseline is re-recorded on the
merged tip, n ≥ 5 with ids, before it is used as a before again.**
