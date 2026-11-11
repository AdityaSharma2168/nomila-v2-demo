# PR 10 — Confirm→plan integrity + the flag-off leak — ledger

Branch `studio/confirm-integrity` off origin/main **036cc1c6** (PR #577 merged). AUDIT2 was pinned at
c8242e07; `git diff --stat c8242e07..HEAD` touches 15 files (objectives 3b-2, migration 0065,
`previews.migration.test.ts` list-line bump) — **none in this block's component map**; every cite below
was re-verdicted at the tip anyway. Probes (none expected) under gitignored `probe-out/confirm-integrity/`.
Phase R is read-only, $0, no jest, no server, no DB. No DDL in this PR.

## Phase R — claims (verdicted at 036cc1c6)

| # | Claim | Verdict | At the tip |
|---|---|---|---|
| C1 | `STUDIO_IMAGE_EDIT` read only by AgentScreen:423,452 and NowFeed:42 | CONFIRMED | `client/lib/flags.ts:113`; readers AgentScreen.tsx:59,423,452; NowFeed.tsx:24,42. No other client reader. |
| C1 | BrandPlanStep:287 and SetupScreen:80 navigate with no flag check | CONFIRMED | BrandPlanStep.tsx:287 `nav.navigate("StudioCarouselCreate"` — no `flags` import in the file. SetupScreen.tsx:80-81 `toCarousel`; :220 `format === "carousel" ? toCarousel : toPlan`; no `flags` import. |
| C1 | edit routes 404 when `STUDIO_IMAGE_EDIT_OPS` off (edit/routes.ts:141-147) | CONFIRMED | `requireEditOps` routes.ts:140-146; `imageEditOpsEnabled` config.ts:1674. |
| C1 | use-studio-edits.ts:27 surfaces "Something went wrong (404)" | CONFIRMED, plus | :27 (every POST), :165 (`useBatch`), :218 (`useEditsList`, but :217 maps 404 → `{edits: []}` so the Now feed is already quiet). **Nuance:** the Create screen's FIRST call is not the quote — `useRecommendEdits` fires on mount for the carried ref (CarouselCreateScreen.tsx:99-113, enabled by `refs[0]` + `briefLines`), so `/studio/edits/recommend` 404s before she taps anything; the quote 404 then lands in `setError`. |
| C2 | `isBrandWork` suggest.ts:24-31 treats grow-following/recap/concept as own | CONFIRMED | `OWN_CONTENT_OBJECTIVES` :24-28, `isBrandWork` :30-31, used :67. |
| C2 | entryPrompt.ts:105-108 filters the catalogue on it | CONFIRMED | `musicCatalogue` :105-108; also `parseMusic` :259-270 drops a named non-brandSafe track on the same rule. |
| C2 | brief path sets objective from the goal (directionLogic:555-559,:610,:645; brandLogic:242) | CONFIRMED | `goalToObjective` :555-559; `const goal = goalToObjective(valueAt(b,"objective.goal"))` :610; `objective: goal` :645; brandLogic.ts:242 `composed.objective ?? "showcase-product"`. |
| C2 | manual path hard-codes :201 | CONFIRMED | brandLogic.ts:201 `objective: "showcase-product"`. The manual assembly also hard-codes `objective.type: "brand_campaign", goal: "showcase-product"` in the brief itself (:140-143). |
| C3 | brandLogic:176 product, :177 output = video/9:16/null (:155-159) | CONFIRMED | :176 `product: assembled.product ?? b.product ?? null`; :177 `output: assembled.output`; :155-159 the constant. **brandPlan.test.ts:376-398 pins this wrong behaviour by name** ("…only overlays the product she picked here and the Board's output") — it flips under R-3 (see P-tests). |
| C3 | planner's deliver-as line plan.ts:399-402 never sees a confirmed image/4:5 | CONFIRMED | :398-402 builds it from `c.output`; the brief path's `c.output` is always the :155-159 constant. |
| C4 | IDENTITY_WORDS :582-586 vs enum brief.ts:23,119; maximum/standard → no phrase | CONFIRMED | directionLogic.ts:582-586 keys `high/medium/low`; `PRIORITIES = ["maximum","high","standard"]` brief.ts:73 (comment :23, used :119 and :129); :637 `IDENTITY_WORDS[identity] ?? null` → `maximum` and `standard` compose nothing; `medium`/`low` are dead keys. |
| C5 | campaignBlock prints name + attributes only (:361-364); grep profile → 0 | CONFIRMED | plan.ts:361-364; `grep -n profile server/studio/agent/plan.ts` → 0. **Note:** schema `brand.profile` is a `handle` (`/^[a-z]+_[0-9]{1,3}$/`, brief.ts:84-86, :110), not prose — the line renders the handle. The manual assembly sends `profile: null` (brandLogic:149). |
| C6 | referenceAssetId collected BrandPostScreen:179,206,234 → brandLogic:119,:246, no consumer | PARTIAL | Collection: BrandPostScreen.tsx:179 state, :234 set from `decomposeReference`, :206 into `ctx`, plus :71/:155/:265/:344/:506 (prop + type + two `onPick` sites). brandLogic.ts:119 (`BrandPlanInput`), :227 (`BriefHandoff` type), :246. **No plan-body consumer**: agentLogic.ts `briefBody` :612-636 never forwards it, `AGENT_BODY_KEYS` routes/studio.ts:2117 has no such key (a 400 if it were sent). **Two display consumers exist** the block did not list: BrandPlanStep.tsx:212 `" · reference saved"` and ConfirmBriefStep.tsx:144-148 "Your reference is saved with this brief." Tests: brandPlan.test.ts:45,406,435,455; ConfirmBriefStep.test.tsx:236. The source is `use-studio-direction.ts:318` (reads `x-studio-reference-asset-id`); `server/scripts/studioDirectionDecompose.ts:79-113` reads the same header (script, out of lane, untouched). |
| C7 | listEditPreviews :80-96 and readyBatches :138-157 ignore expires_at; presentEdit signs expired | CONFIRMED | previews.ts:81-96 (no expiry predicate; `isEditPreviewExpired` :137-140 exists and is used only by the single-row run/accept paths engine.ts:444,:690). carouselLogic.ts:138-157 reads `status` only; `EditPresented.expiresAt` exists (editTypes.ts:45). engine.ts:797-800 signs on `status === "ready" && gcs_path` alone. |
| C7 | NowFeed reads readyBatches (:42-43, :109-131) | CONFIRMED | NowFeed.tsx:42-43; the READY rows :109-131 → `onOpenCarousel` → StudioHomeScreen.tsx:175 → Create screen with `batchId`. |

### Every consumer of the purpose chip (so R-2 changes none unlisted)

Client — AgentScreen.tsx:141 state (seed: `fromBrief.objective`, else `OBJECTIVE_CHOICES[0]` = grow-following), :223 inherited (`BRAND_BOARD_OBJECTIVE` agentLogic:570/:644), :198 `askedFor` key, :251 concepts body, :286 plan body, :319 plan record, :342 quote pass `boardRequests(…, plan.objective)`, :397 `buildSeed` → StoryboardTab.tsx:294 board state → :359 `boardRequests` (in every generation request), :369 `boardSignature`, :847 `useMusicSuggestion` → POST `/studio/stitch/music/suggest` `{feel, objective}` (use-studio-stitch.ts:395-425).
Server — routes/studio.ts:2144 validate → `deriveConcepts` (objective) → `derivePlan` `ask.objective` → plan.ts:460 prompt line `objective:`, :482 `capabilityBlock(kinds, ask.objective)` → entryPrompt `musicCatalogue`, :869 `given.objective` → :736 `parseMusic`; routes/studio.ts:2851 `suggestMusic(req.body)` → suggest.ts:67 `forBrand`.
**R-2 rewires only the four music sinks** (musicCatalogue, parseMusic, suggestMusic, and the Board's suggest call). The prompt's `objective:` line, concepts, boardRequests, signatures and the chip UI keep reading the chip.

## Pre-registered predictions

- **P-chip.** With `EXPO_PUBLIC_STUDIO_IMAGE_EDIT` unset: BrandPlanStep's chooser renders no Carousel chip (Video only); SetupScreen's Carousel chip CTA reads "Build the plan" and calls `toPlan` (→ StudioMakeIt); a jest render of the Set-it-up path with the flag off records **zero** fetches to any `/studio/edits` URL. Falsified if any `/studio/edits/*` request is recorded, or the chip still routes to StudioCarouselCreate.
- **P-music.** A confirmed brief with `objective.goal = "grow-following"`, `objective.type = "brand_campaign"`: (i) `capabilityBlock` lists no track with `brandSafe:false`; (ii) `parseMusic` nulls a named uncleared track; (iii) the Board's suggest for that plan ranks only brandSafe — all three via one derivation, and the manual path (brandPlanBody) derives the same value from the same function. Falsified if any of the three offers/keeps an uncleared track, or if the two paths reach `forBrand` through different code.
- **P-output.** A confirmed brief with `output: {type:"image", aspect_ratio:"4:5", platform:null}` through `brandCampaignBrief` → `campaignBlock` yields the line `deliver as: image, 4:5` verbatim. Falsified if the line reads `video, 9:16` or is absent.
- **P-tests (fingerprint).** Existing tests that change and why: brandPlan.test.ts:376-398 (asserts `output` = video/9:16 and product overlay wins → flips under R-3); brandPlan.test.ts:406,430-455 (`referenceAssetId` in the hand-off → gone under R-6); ConfirmBriefStep.test.tsx:236 (prop removed); entryPrompt.test.ts:172-188 and suggest.test.ts:66-140 (drive brand-ness by objective string → driven by the derivation's input under R-2); plan.test.ts:1391 `brand: Solstice — clean, minimal` **unchanged** (fixture profile is null → no suffix). No test in plan.test pins a prompt hash; the prompt-fingerprint change is one appended segment on the `brand:` line when `profile` is non-null, else byte-identical. Falsified if any other existing test reds.
- **P-expiry.** `listEditPreviews` with `expires_at <= now` rows: not returned; `presentEdit` on an expired ready row: `url: null`. The six callers (routes.ts:466; batch.ts:290,519,550,602,623) stop seeing expired rows — runBatch skips an expired quoted row (it would not run anyway: engine.ts:444 refuses), reroll's candidate cap counts live rows only, acceptAll skips expired (engine.ts:690 already refuses per row). Falsified if any batch.test goes red.

## Mutations (red by name, then green)

| Mutation | Lives in |
|---|---|
| "Carousel chip renders with STUDIO_IMAGE_EDIT off" | client/screens/studio/carouselLogic.test.ts (structural + a pure chooser-formats helper test) |
| "a grow-following brand brief is offered a non-brandSafe track" | server/studio/agent/entryPrompt.test.ts + server/studio/music/suggest.test.ts |
| "manual and brief paths disagree on brand-ness" | client/screens/studio/brandPlan.test.ts (both bodies through one derivation) |
| "confirmed output block reaches the planner as video/9:16 after confirming image/4:5" | client/screens/studio/brandPlan.test.ts (+ server plan.test for the deliver-as line) |
| "confirmed product loses to the screen's" | client/screens/studio/brandPlan.test.ts |
| "identity_priority maximum produces no phrase" | client/screens/studio/directionLogic.test.ts |
| "brand.profile absent from the campaign block" | server/studio/agent/plan.test.ts |
| "an expired ready row shows under Now" | client/screens/studio/carouselLogic.test.ts (readyBatches) + server/studio/edit/batch.test.ts or routes.test.ts (listEditPreviews / presentEdit) |
| "referenceAssetId still collected" | client/screens/studio/brandPlan.test.ts (structural grep over BrandPostScreen/brandLogic) |

## Component map (per lane)

- **Commit 1 / R-1 (F10):** `client/screens/studio/BrandPlanStep.tsx`, `client/screens/studio/SetupScreen.tsx`, `client/screens/studio/CarouselCreateScreen.tsx`, `client/screens/studio/brandLogic.ts` (a flag-aware formats helper so the chooser is testable), `client/screens/studio/carouselLogic.test.ts`.
- **R-2 (F23a):** `server/studio/music/suggest.ts` (the one derivation `brandWorkFor`), `server/studio/agent/entryPrompt.ts`, `server/studio/agent/plan.ts`, `server/routes/studio.ts` (plan route passes deal presence; suggest route body), `client/hooks/use-studio-stitch.ts`, `client/screens/studio/StoryboardTab.tsx`, `client/screens/studio/agentLogic.ts`, `client/screens/studio/brandLogic.ts`, tests: entryPrompt.test, suggest.test, brandPlan.test, plan.test.
- **R-3 (F23b):** `client/screens/studio/brandLogic.ts`, `brandPlan.test.ts`.
- **R-4 (F23c):** `client/screens/studio/directionLogic.ts`, `directionLogic.test.ts`.
- **R-5 (F23d):** `server/studio/agent/plan.ts`, `plan.test.ts`.
- **R-6:** `client/screens/studio/BrandPostScreen.tsx`, `brandLogic.ts`, `BrandPlanStep.tsx`, `client/components/studio/ConfirmBriefStep.tsx` (+ its test), `brandPlan.test.ts`. `use-studio-direction.ts` and the server header stay (PR 14's source).
- **R-7 (F3):** `server/studio/edit/previews.ts`, `server/studio/edit/engine.ts` (presentEdit), `client/screens/studio/carouselLogic.ts`, tests: batch.test / routes.test, carouselLogic.test.
- Docs: `docs/probes/confirm-integrity.md`.

## Spend

None planned. No model cell in this PR; every check is deterministic (jest). If a cell is ever wanted, it is quoted here first.

## Decisions needed before Phase B

D1. **R-1 vs the R-8 fence.** carouselLogic.test.ts:189-211 forbids `onOtherFormat|SetupScreen|StudioMakeIt` in BrandPlanStep, so the chooser cannot "fall back" to the pre-PR-9 next-screen path without breaking a fence R-8 says must hold. Reading the mutation name ("Carousel chip renders with STUDIO_IMAGE_EDIT off"), I take R-1 to mean: **BrandPlanStep hides the Carousel chip when off (Video only); SetupScreen's chip → toPlan (the :220 cite); CarouselCreateScreen renders a closed door and fires no request when off.** Confirm or correct.
D2. **R-2's fallback with no brief and no deal.** The plain Agent screen (no brand flow) has neither. Options: (a) keep `isBrandWork(chip)` there only, fail-closed as today; (b) own content. I recommend (a): the ruling's inputs are absent, and (b) opens the direction suggest.ts:16 says costs. With a brief present, `objective.type ∈ {brand_campaign, ad}` → brand; `social_content` → brand iff a deal is linked or `brand` block is non-null (fail-closed); a deal alone → brand.
D3. **R-7 presentEdit:** `url: null` on an expired row while `status` stays `"ready"` (no DDL, no new status). readyBatches then also drops rows whose `expiresAt <= now` client-side, so a cached list cannot resurrect one.

## Adi's go (23 Sep 2026) — decisions

1. R-1 amended: BrandPlanStep hides the Carousel chip when STUDIO_IMAGE_EDIT is off (Video only); SetupScreen's chip → toPlan; CarouselCreateScreen renders a closed door, mounts no hook, makes no request. New mutation "Create screen fires a request with the flag off".
2. R-2 as a rule: brand = deal linked, OR objective.type ∈ {brand_campaign, ad}, OR social_content with a brand block or a deal. Only with none of those inputs does the purpose chip decide (plain Agent screen). One function, both paths. New mutation "a deal-linked plan with no brief is treated as own content".
3. R-7: no new status, no DDL; presentEdit returns `{ url: null, expired: true }` on an expired row.
4. Component-map additions approved (CarouselCreateScreen, ConfirmBriefStep + test, routes/studio.ts plan + suggest handlers kept minimal, use-studio-stitch.ts, StoryboardTab.tsx, engine.ts presentEdit).
5. brandPlan.test.ts:376-398 pins the bug — flip it deliberately, recorded here.
6. The blind-eval zip stays untouched and out of every commit (it shows modified in this fresh worktree — CRLF normalisation on a binary; every commit is by explicit path).

## Commit 1 — F10, the flag-off leak (R-1)

What changed: `brandFormatsFor(imageEdit)` in brandLogic.ts (Video only when off); BrandPlanStep reads it with `STUDIO_IMAGE_EDIT`; SetupScreen's `toCarousel` falls through to `toPlan` when off and the CTA reads "Build the plan"; CarouselCreateScreen is now a wrapper — closed door with the flag off, the old screen (renamed `CarouselCreateOpen`, hooks and all) only with it on. Both R-8 fences hold unchanged: the literal `format === "carousel" ? toCarousel : toPlan` stays at SetupScreen's CTA, and BrandPlanStep still names no StudioMakeIt/SetupScreen path.

Prettier: all five touched files were already unformatted on origin/main → left as they were; the new `.test.tsx` is formatted.

P-chip: **held.** Rendered with the flag off, the Set-it-up Carousel chip navigates to StudioMakeIt with `format: "carousel"`, and `global.fetch` is called 0 times; the Create screen with the flag off calls no edit hook and fetch 0 times.

Mutations (scoped run: CarouselCreateScreen.test.tsx + carouselLogic.test.ts, 13 tests):

| Mutation | Applied as | Red by name |
|---|---|---|
| "Carousel chip renders with STUDIO_IMAGE_EDIT off" (a) | `brandFormatsFor` returns BRAND_FORMATS regardless | 1 red: "…with STUDIO_IMAGE_EDIT off the chooser is Video only, the chooser reads the flag, and the Create screen is a closed door before any hook" |
| "Carousel chip renders with STUDIO_IMAGE_EDIT off" (b) | SetupScreen `toCarousel` guard dropped | 2 red: the structural one above + "…with the flag off the Set-it-up Carousel chip builds the plan — StudioMakeIt, never the Create screen, and no request to /studio/edits" |
| "Create screen fires a request with the flag off" | wrapper renders CarouselCreateOpen regardless | 2 red: "…with the flag off the Create screen is a closed door: no hook mounts, no request, the way back works" + the structural one |

Restored: 13/13 green. Each mutation applied to and restored from a scratch backup copy, never `git checkout`.

## Commit 2 — R-2, brand-ness for the music (F23a)

What changed: `brandWorkFor(signals)` + `brandSignalsFrom(campaign, dealLinked, objective)` in `music/suggest.ts` — the rule as Adi stated it. `entryPrompt.ts`'s `capabilityBlock` / `parseMusic` take a boolean (a caller that forgets it cannot compile; `parsePlan`'s absent `forBrand` still reads as brand work). `plan.ts` derives once (`forBrandOf(ask)`) for the catalogue and the parse; `PlanAsk` gains `dealLinked`, which the plan route sets from the validated deal. The Board's suggestion sends its stored plan id; the suggest handler reads HER row (`readPlan`, tenancy-filtered; not hers → 404) and derives the same signals from `brief` + `deal_deliverable_id`.

**Why the Board carries the plan id rather than signals on the seed:** the seed's type (`storyboardLogic.ts`) and `AgentScreen.tsx` are both open uncommitted in the clip-reads lane; the plan id was already on the seed. The server deriving from the stored row is also the stronger trust boundary (the client cannot claim own-content for a brand plan). **Edge:** a board whose plan failed to save (`planId` null) falls to the chip. Recorded, not patched.

Chip consumers untouched (as promised in R): the prompt's `objective:` line, concepts, boardRequests, signatures, the chip UI.

P-music: **held** — the grow-following brand_campaign brief yields brandSafe-only through `capabilityBlock`, `parseMusic` and `suggestMusic`, all via `brandWorkFor`; manual (`brandPlanBody`) and brief (`briefHandoff`) campaigns derive `true` through the same call (brandPlan.test). P-tests: **held with one refinement** — the five predicted test sites changed; plan.test.ts:1391 unchanged; `plan.test`'s "music fail-closed without an objective" case was renamed to `forBrand` (it spread `objective` into `given`, which the boolean seam no longer reads).

Scoped run (suggest, entryPrompt, plan, brandPlan, studio.stitch — `--runInBand`): 5 suites, **207/207**. Mutation evidence follows once the jest slot is free (join-row holds it).

### Rebase onto origin/main ee357e11 (PR 9.5 merged), 23 Sep 2026

Adi ran `git rebase origin/main` (the harness denies rebase to Claude); it applied 3/3 with no conflicts. Commit SHAs became 2d8e702b (F10), 78d7893b (R-2), 64b10c52 (ledger). Anchors that moved: AgentScreen.tsx flag reads :423→:433 and :452→:462 (clip-reads edited the file); routes/studio.ts `AGENT_BODY_KEYS` :2117→:2118 and the suggest handler :2850→:2853 (9.5's import at :148); 9.5's mount at :3274 and this PR's two hunks (:2330 `dealLinked`, :2863 `brandSignalsFrom`) coexist. Every other cite unchanged. `plans.ts` (9.5's beats merge) is not touched by this PR.

The blind-eval zip: `.gitattributes` forces `server/scripts/calibration/runs/** text eol=lf`, which catches the binary and makes every fresh worktree show it modified; it blocked the rebase ("unstaged changes"). Cleared with `git update-index --assume-unchanged` on that path for the rebase and reverted after; the file's bytes were never written. Out of lane; noted for whoever owns calibration.

### R-2 mutations (rebased tip; suites: suggest, entryPrompt, plan, brandPlan = 137 tests)

| Mutation | Applied as | Red by name |
|---|---|---|
| "a grow-following brand brief is offered a non-brandSafe track" | `brandWorkFor` returns `isBrandWork(s.objective)` before reading the brief | 9 red, among them "…a grow-following brand brief is offered a non-brandSafe track: never — the brief's type decides, not the goal-as-chip" (entryPrompt.test) and "…the suggestion is brandSafe-only whatever the chip says" (suggest.test) |
| "a deal-linked plan with no brief is treated as own content" | the `dealLinked` line dropped from `brandWorkFor` | 4 red, among them "…a deal-linked plan with no brief is treated as own content: never — the deal alone makes it brand work, whatever the chip says" (plan.test) and its suggest.test twin |
| "manual and brief paths disagree on brand-ness" | `agentPrompt` reads `capabilityBlock(kinds, isBrandWork(ask.objective))` | 1 red: "…manual and brief paths disagree on brand-ness: never — the prompt and the parse both come through forBrandOf, and nothing in plan.ts reads the chip for it" (plan.test) |

Restored: 137/137 green. (A first attempt matched 0 tests — the zsh unquoted-`$VAR` trap from the notes; re-run with explicit paths.)

### Whole-suite gate #1 — rebased R-2 tip (64b10c52 + ledger)

`npm test` bare: 18 batches, 490 suites, **9308 / 9308, 0 failed**; every per-batch line reads `0 failed`; FINAL SUMMARY "All suites passed". Exit 0 (read for the record, not as the verdict). No flake this run.

## Commit 3 — R-3, the confirmed brief wins (F23b)

`brandCampaignBrief` now takes the confirmed `product` whole (her picked photo fills only a confirmed product with no `ref`) and the confirmed `output` field by field (video/9:16 fills only a field the brief left null). brandPlan.test.ts:376-398 — which pinned the leak by name ("…only overlays the product she picked here and the Board's output") — is flipped deliberately, per Adi's go, and says so in its comment.

P-output: **held** — through the client assembly (brandPlan.test) and, per Adi's test 2, through the real plan route (studio.agent.test): `deliver as: image, 4:5`, the product line beside it, no `9:16` in the block; the row stores the image/4:5 block.

| Mutation | Applied as | Red by name | Green side |
|---|---|---|---|
| "confirmed product loses to the screen's" | `product: assembled.product ?? b.product ?? null` | 1 red: "her confirmed brief is the campaign — its product and its output win; the step fills only what the brief has none of" (brandPlan.test, 20 tests) | same test |
| "confirmed output block reaches the planner as video/9:16 after confirming image/4:5" | `output: assembled.output` | 1 red: the same test | brandPlan.test above + **T2** "through the real plan route, a confirmed image/4:5 brief reaches the planner as 'deliver as: image, 4:5' with its product intact — never video/9:16 (PR 10, R-3)" — its own red side shown: deliver-as forced to `video, 9:16` → 1 red of 66 in studio.agent.test |

## Commit 4 — Adi's three confirmations (23 Sep 2026)

| # | Test (file) | Red side shown |
|---|---|---|
| T1 | "with STUDIO_IMAGE_EDIT off, neither screen makes a network call on mount, and the Set-it-up Carousel chip's handler is toPlan — StudioMakeIt, never the Create screen" (CarouselCreateScreen.test.tsx; the Create-screen half is its sibling "…closed door: no hook mounts, no request…") | commit 1's mutations M1b / M2 (both red these by name) |
| T2 | as above (studio.agent.test.ts) | deliver-as forced to video/9:16 → red |
| T3 | "through the real suggest route, a brand brief whose goal is grow-following is answered with brandSafe tracks only — on the brief path and the manual path; the chip alone still ranks the uncleared one" (studio.music.test.ts, new file: the committed catalogue + one uncleared warm track via a module mock, since every real track is brandSafe) | R-2 M-a (chip read first) → 1 red of 1 — the green side of "a grow-following brand brief is offered a non-brandSafe track" |

T1's "handler is toPlan" is asserted behaviourally (navigate → StudioMakeIt with `format: "carousel"`, the label "Build the plan", zero fetches before and after) plus structurally (carouselLogic.test pins the `if (!STUDIO_IMAGE_EDIT) { toPlan();` guard). T3's last leg notes an honest limit: the file seeds no deal row, so "deal alone" is exercised in suggest.test / plan.test (unit), not through the route.

Scoped: the three files 71/71; brandPlan + plan 115/115.

### Whole-suite gate #2 — tip 8f746af6 (R-3 + the three confirmations + dev flags)

`npm test` bare: 19 batches, 491 suites, **9311 / 9311, 0 failed**; all 19 `✓` batch lines read `0 failed`; FINAL SUMMARY "All suites passed" (one more suite and three more tests than gate #1 — the new route test file and Adi's three). `tsc --noEmit` and `tsc -p tsconfig.jest.json` clean. Lint: 0 errors across every file the branch touches (warnings are the repo's usual). Prettier: every pre-existing touched file was already unformatted on main and is left as it was; the new files are formatted.

### Dev flags (Adi, 23 Sep 2026)

`.env.development` committed on this branch (8f746af6) with the 22 Sep set plus brand profiles, direction moments, image edit and clip reads — the 22 Sep commit had never reached origin. Server flags live in the gitignored `.env` (Adi's paste; Claude is denied env files). On the "retired flag due to SAM": no `STUDIO_*` env read was ever removed from server code; the retired thing is the masked composite path's role for typed edits (native edit routes around it). The sweep-2 row 1.2 distortion was on the masked path, and the 9 Sep measurement shows the strip seams come from the masked path WITHOUT the shape mask — so `STUDIO_GARMENT_MASK=true` with `STUDIO_NATIVE_EDIT=true` is the safe state; nothing needs to stay off.

### Holding

R-4 … R-7 are BUILT as edit scripts (typechecked cumulatively, 0 lint errors) and NOT applied; they wait for Adi's go after this hold.

## Adi's go #2 (23 Sep 2026): UI check 1–3 passed → R-4 … R-7, one commit each

| Commit | Item | Scoped green | Mutation | Applied as | Red by name |
|---|---|---|---|---|---|
| 150fa44f | R-4 IDENTITY_WORDS on the enum | directionLogic.test 22/22 | "identity_priority maximum produces no phrase" | `identityWords` answers null for `maximum` | 1 red: "every member of the schema's identity_priority enum composes a phrase — maximum, high and standard each read differently" |
| c41dbb77 | R-5 brand.profile in campaignBlock | plan.test 96/96 | "brand.profile absent from the campaign block" | profile suffix dropped from the brand line | 1 red: "the brand's profile handle renders beside its name and attributes; with none the line is byte-identical to before" |
| 3244fb4f | R-6 referenceAssetId deleted (+ BrandPlanStep:212, ConfirmBriefStep:144-148 and their tests) | brandPlan + ConfirmBriefStep + carouselLogic 39/39; `grep referenceAssetId client` → only use-studio-direction.ts (the header read, PR 14's source) | "referenceAssetId still collected" | field re-added to `BrandPlanInput` | 1 red: "referenceAssetId still collected: never — no screen state, no input field, no hand-off field; the plan body never carried it" |
| ea087bcb | R-7 expiry | batch + carouselLogic + routes + engine 54 (see the miss below) | "an expired ready row shows under Now" ×3 sites | (a) `gt` predicate dropped in `listEditPreviews`; (b) `presentEdit` signs on status alone; (c) expiry line dropped in `readyBatches` | (a) 1 red of 14, (b) 1 red of 14: "…gone from every list, the batch view and accept-all, and presentEdit signs nothing for it" (batch.test); (c) 1 red of 10: "…by the server's flag, or by its expiresAt against the clock" (carouselLogic.test) |

R-5 prompt fingerprint (R-9): the brand line gains ` — profile <handle>` only when `brand.profile` is non-null; every existing planner test's prompt is byte-identical (plan.test 96/96 with no other assertion touched).

**P-expiry: held, with one miss honoured.** `listEditPreviews` with `expires_at <= now`: not returned; `presentEdit` on an expired ready row: `{ url: null, expired: true }`; batch.test's other cases (runBatch, sweep, reroll cap, accept-all) unchanged, 14/14. **The miss:** the first R-7 green run showed 2 client reds I had not predicted — carouselLogic.test's readyBatches fixture expires at 2026-09-24T00:00Z and the tests read `Date.now()`; on the evening of 23 Sep (UTC already the 24th) the real clock passed it, so the new expiry rule dropped the fixture rows and the pre-existing test :153 went red too. Not a defect in the rule — a time-bomb fixture. Fixed by giving those cases a fixed clock (`NOW = 2026-09-23T12:00Z`), the check itself untouched; re-run 24/24; M-c re-run still red by name.

Mutation count this round: 6 red by name (R-4 ×1, R-5 ×1, R-6 ×1, R-7 ×3). PR total: 14, plus the red sides of T2 and T3.

### Whole-suite gate #3 — tip ea087bcb (R-4 … R-7 landed)

`npm test` bare: 19 batches, 491 suites, **9315 / 9315, 0 failed**; all 19 `✓` batch lines read `0 failed`; FINAL SUMMARY "All suites passed". `tsc --noEmit` and `tsc -p tsconfig.jest.json` clean; 0 lint errors on every touched file; prettier untouched on the sixteen pre-existing files (all unformatted on main). Note: library-fields (PR 12) may have started its own gate part-way through this one; contention produces false reds (hook timeouts), never false greens, so this green stands, and none appeared.
