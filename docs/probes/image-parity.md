# Image-path parity + dev-env cleanup · ledger

| | |
|---|---|
| Branch | `studio/image-parity` (worktree `/Users/adi/nomila-v2-worktrees/image-parity`), created `--no-track` from origin/main |
| Base | **`7121871f`** ("Merge pull request #591 from nomila-co/studio/style-spec", PR 18) |
| Env commits | `b1b1216d` (the strip, superseded) → `66eeea3c` (its revert) → **`51c22373`** (the six missing pins, all `=true`) |
| Known dirty baseline | `server/scripts/calibration/runs/blind-eval/blind-eval-2026-09-14.zip` shows ` M` at checkout (the gitattributes quirk). Never staged. It is part of the runner's snapshot. |
| Phase R | Read-only, $0. The R-report was given in session on 24 Sep 2026 and held for rulings. |

**Rulings are cited as follows. All three are Adi's, on 24 Sep 2026, in session.**

| Cite | Message | Status |
|---|---|---|
| **ADI-GO-IP** | "Env ruling changed: the pins stay … Then go, with these rulings." | The env rulings and the house rule stand. R-2, R-4, R-5, R-6, R-8, R-14, T7, T8 and C-2 are superseded by the two below. |
| **ADI-IP-S** | "Rulings on S-1 to S-4 …" | S-1 and S-2 stand, and so does the R-4 precedence rule as a recorded rule. S-3, R-6-revised, T7 and T8 are superseded by ADI-IP-SCOPE. |
| **ADI-IP-SCOPE** | "Stop. Scope correction … This PR does not touch the edit-op feature …" | In force. It supersedes both messages above where they conflict. |

---

## What this PR is (ADI-IP-SCOPE)

1. **The env pins** (`66eeea3c`, `51c22373`) and **three devEnv tests**, with M-env.
2. **R-3 (a): the pure move** of `buildPrompt` into `server/studio/compile/image.ts`. It must be byte-identical and prove it: `git diff --color-moved` over the commit, plus a script showing every moved block matches byte-for-byte apart from import/export lines. **No behaviour change.**
3. **The image.generate route test, T1–T6.**
4. **R-10 (a)**, plus a unit test that the fence arm still renders when `untrusted` is true.
5. **R-7 (a), R-9 (b), R-11 (a), R-12 (b) and R-13 in this ledger**, with the census half rows derived, registered and verdicted.
6. **R-4**: the precedence rule and the "plan-aware Create Anything" card are recorded here. Nothing is built for it.

**Not in this PR:**
- No `STUDIO_IMAGE_PARITY` and no client twin. The client flag count stays at **16**.
- No `planId` anywhere; R-2 is dropped.
- No walk.
- Nothing in the edit-op feature: the typed-op engine, `ops.ts`, the native compile (`assemble.ts`), quote or batch bodies, the Agent-screen edit sheet, the carousel or the Board. **PR 19 owns all of that and runs in parallel.**

---

## Rulings

| # | Ruling | Cite |
|---|---|---|
| Env | **The pins stay.** Dev is all-on by design. Flag-off walks go in the worktree's `.env.local`, which outranks `.env.development`. The strip (`b1b1216d`) is reverted (`66eeea3c`), and the six flags that were never pinned are added `=true` (`51c22373`). `grep -c '^EXPO_PUBLIC_STUDIO_.*=true$'` printed **16**. | ADI-GO-IP |
| House rule | **`EXPO_PUBLIC_STUDIO_*` lines in `.env.development` are `=true` only, never `=false`.** | ADI-GO-IP |
| R-1 (b) | The runner runs the env mutations. The permission rule `Read(./.env.*)` in `/Users/adi/nomila-v2/.claude/settings.local.json` blocked a read of `.env.development` during setup, and was left as it is. The step it blocked (the count) was run by Adi. | ADI-GO-IP |
| devEnv tests (replace 0b) | **Test 1:** every `EXPO_PUBLIC_STUDIO_*` line in `.env.development` is `=true`; a failure names the key. **M-env:** set one to `=false` → red by name. **Test 2:** as proposed (every flag `flags.ts` reads resolves on in the dev bundle over a fixture `.env`), with a pinned count of **16** (no twin; ADI-IP-SCOPE). **Test 3:** every flag `flags.ts` reads has a `=true` pin, so a new flag without a pin fails by name. | ADI-GO-IP, ADI-IP-SCOPE |
| R-2 | **Dropped.** No `planId` in this PR. | ADI-IP-SCOPE |
| R-3 (a) | **A pure move, byte-identical, with the text-identity proof.** See the deviation below: moved **whole, not split**. | ADI-GO-IP, ADI-IP-SCOPE |
| R-4 | **Nothing is built.** No campaign block on generates: no product request can carry a `planId` to a generate (ADI-IP-S, S-4). **The precedence rule is recorded for when a plan-bearing generate surface exists:** the style reference wins on look; the campaign's `feel:` and `how it should feel:` lines are withheld; concept and constraints still ride; code decides, not the model. Reason: the style reference is the one image she picked for *this* still, while campaign feel is plan-level, so the more specific pick wins, and the model is never handed two disagreeing descriptions of the look to arbitrate. Card **K-IP1** (plan-aware Create Anything). | ADI-IP-S, ADI-IP-SCOPE |
| R-5, R-6, S-3, T7, T8 | **Moved to PR 19** (card K-IP2). | ADI-IP-SCOPE |
| R-7 (a) | **A generate runs neither the interpreter nor the classifier. K7 closes as deliberate**, citing Q4 below. | ADI-GO-IP |
| R-8 + C-2 | **Moved to PR 19** (card K-IP3). | ADI-IP-SCOPE |
| R-9 (b) | Dead arms 1–3 (`Routed.ambiguity`, `confidence`, `low_confidence*`) are **left to PR 19 as K8**. | ADI-GO-IP |
| R-10 (a) | **`direction.untrusted` is kept as a deliberate defence.** The census row is re-verdicted DELIBERATE-DEAD and its stale cites are fixed. A unit test asserts that the fence arm still renders when `untrusted` is true, because the census traces nonces and cannot guard a boolean (C-3). | ADI-GO-IP |
| R-11 (a) | **`ProductPiece.reference` is kept as a deliberate slot.** PR 19.5's product placement is the likely data source. | ADI-GO-IP |
| R-12 (b) | **The 19 AthleteHalf leaves the R-report listed, and brand `tier` and `recentCampaigns`, are dead by ruling. AthleteHalf and BrandHalf become census sources.** The half rows are derived ($0), the exact coverage registered, and then the verdicts written. **Brand `tone.audience` is dead by ruling for now:** its effect is a model-output claim and this PR has no eval. | ADI-GO-IP |
| R-13 | K23, K30 and K36 are **out**. | ADI-GO-IP |
| R-14 | **Moved to PR 19** (card K-IP4). | ADI-IP-SCOPE |
| S-1 (a) | Storyboard stills are dropped: the ruling named a surface that does not exist (`storyboardLogic.ts:56`, `storyboardRun.ts:71-77`). (b), a Board-row still generate, is not built. | ADI-IP-S |
| S-2 | No carousel changes at all. No `planId` on `BATCH_QUOTE_BODY`, because a seam with no caller is a dead field. Card K-IP5. | ADI-IP-S |
| Walk | **None.** | ADI-IP-SCOPE |

### Deviation, stated before the build: the move is whole, not split
The R-report proposed three functions (`compileGeneratePrompt`, `compileCropPrompt`, `compileFrameSpacePrompt`). **A split cannot be text-identical:**
- The generate, crop and frame-space arms are interleaved in one `parts` list (`preview.ts:627-864`).
- Separating them rewrites the control flow.

ADI-GO-IP and ADI-IP-SCOPE require text identity. So commit 1 moves `buildPrompt` and its private `delimited` into `compile/image.ts` **verbatim, as one function**. The split is carded as K-IP6, since it needs its own proof.

### DEAD-BY-RULING (written when ruled, per PR 16's standing rule)
| Field | Ruling | Cite |
|---|---|---|
| AthleteHalf, the 18 leaves no reader holds: `identity.name`, `identity.firstName`, `identity.identityLine`, `identity.org`, `identity.conference`, `identity.marqueeTag`, `voice.storyArc`, `voice.highlights`, `aesthetic.notes` (personal data or proper nouns her prompt must never carry: `preview.ts:588-617`, "the athlete's name never goes in a prompt", HER STORY removed); `identity.sport`, `identity.segment`, `identity.tier`, `audience.ageRange`, `audience.topMarket` (already carried by `aesthetic.register` or `audience.descriptor`, `brief.ts:850-852`; sport compiled twice reopens the two-sports bug, `brief.ts:816-843`); `identity.division`, `audience.topCity`, `audience.share`, `commercialState` (no visual meaning; `commercialState` is a candidate to decide a branch, never prompt text) | **DELIBERATE-DEAD in image compile** | ADI-GO-IP R-12 |
| AthleteHalf `athleteId` | **Not dead:** it decides the job row's owner (`jobs.ts:72`) and the reference reads (`generate.ts:265` onward). Verdicted DECIDES. The R-report counted it among "the 19"; the ruling is about image compile, and `athleteId` never enters a prompt. | ADI-GO-IP R-12; `jobs.ts:72` |
| BrandHalf `tier`, `recentCampaigns` | **DELIBERATE-DEAD**: `tier` is commercial, and campaign names are text an image model would print | ADI-GO-IP R-12 |
| BrandHalf `tone.audience` | **DELIBERATE-DEAD for now**: its effect is a model-output claim, and there is no eval in this PR | ADI-GO-IP R-12 |
| BrandHalf `pieces[].reference.ref` / `.source` / `.note` | **DELIBERATE-DEAD as a kept slot.** The only writers set `null` (`brief.ts:679,690`); the readers are ready (`preview.ts:541-544`, `brief.ts:763`). The likely data source is PR 19.5's product placement. | ADI-GO-IP R-11 |
| `briefJob:direction.untrusted` | **DELIBERATE-DEAD as a kept defence.** No production door sets `origin: "inbound"` (`routes/studio.ts:1439`, `edit/engine.ts:340`; the only producer, `concept.ts:117`, has no route). The fence arm stays, pinned by a unit test. | ADI-GO-IP R-10 |
| K7 ("image generate never classifies or interprets") | **Closed as deliberate.** See Q4. | ADI-GO-IP R-7 |

---

## Phase R answers, in brief (the full report was given in session)

- **Q1.** There is one production call site, `preview.ts:1223-1227`.
  - **Generate:** `DIRECTION: <her words>`, verbatim (`:857-861`).
  - **Masked edit:** the crop label only (`:854-855`).
  - **Non-native edit without a crop:** only already-blocked briefs reach it in production.
  - The concept path (`concept.ts:132,184`) also reaches it, but has no route.
- **Q2.** 9 of the 118 goldens exercise `buildPrompt`: 6 generate and 3 masked, one of them frame-space.
- **Q3.** Video honours a confirmed "do not" through `carrier.ts:214` behind `STUDIO_BRIEF_CARRIER` (`config.ts:1720`) plus `STUDIO_BRAND_PROFILES` (`carrier.ts:137-148`). On images the constraints die:
  - on the client, where only clips send `planId` (`storyboardRun.ts:93,177`);
  - in both image compilers, which hold `brief.job.campaign` and never read it.
- **Q4 (K7's close).** A generate should run **neither**:
  - With no source photo the classifier's answer is fixed: `allowedOps` → `["GENERATE"]`, and rule 0 returns one GENERATE step with no targets and no value (`classify.ts:199,1234`). The keep reading is skipped (`:4411`).
  - The interpreter needs a frame and a native edit (`interpret/eligibility.ts:110-122`), and everything on its menu is an edit to an existing frame (`interpret/menu.ts:113-122`).
  - A generate already sends her whole sentence verbatim, so no parse has anything to recover. The native path needs a parse only because it drops the sentence (`compile/assemble.ts:5-11`).
- **Q5.** A known-brand ad excludes its own brand (`ops.ts:561-563`), and `ops.test.ts:217` asserts it. Moved to PR 19 (K-IP3).
- **Q6.** All five arms are dead in production. Rulings R-9, R-10 and R-11.
- **Q7.** AthleteHalf has 22 leaves; 3 are compiled (`preview.ts:684,835`). BrandHalf `tier`, `tone.audience` and `recentCampaigns` are read by no compiler. The census had no half rows at all (17 sources, `rows.test.ts:28`).
- **Q8.** The census drives image.generate through the routes (flows 6 and 8) but asserts nothing at the spend boundary. Hence T1–T6.
- **Q9.** K23, K30 and K36 are out.
- **Q10.** No model cells.

### Dev-env facts
- **0a.** All 16 client flags are read in exactly one place, `client/lib/flags.ts:17-196`, each as `=== "true"`, so unset means off. At the base, `.env.development` pinned 10 of them `=true`. **`51c22373` pins the other 6** (COMPOSER, LIBRARY_FIELDS, BRIEF_CARRIER, IDENTITY_PACK, IDENTITY_DRIFT, STYLE_SPEC), which **flips their dev default from off to on**. The 10 are unchanged.
- **0c.** The branch tips of PR 12 (#582, `de0e3a19`), PR 14 (#585, `4626e521`) and PR 17 (#586, `62ced82f`) all carry `.env.development` blob `ad1b024f`, the base's file: 10 pins, all `=true`.
  - `git log --oneline -G'EXPO_PUBLIC_STUDIO_(LIBRARY_FIELDS|BRIEF_CARRIER|IDENTITY_PACK)' -- .env.development` prints only `51c22373`, so **no blob before today ever pinned those three**.
  - **No walk ran with its own surface pinned `false`.**
  - **Correction (named):** the R-report said COMPOSER was "never in the file". That was wrong. `EXPO_PUBLIC_STUDIO_COMPOSER=false` was committed in `e563487f` (24 Sep 10:41) and removed in `a441bec1` (12:39), on PR 15/15.1's line, after all three merges. What is true: COMPOSER is not in the base's blob.

### The runner (K-S7, rebuilt in the scratchpad)
- It snapshots the **raw sha256 of all 2209 tracked files**, plus HEAD and `git status --porcelain`, and checks both before and after every mutation. That covers the zip, which PR 18's check excluded.
- `mut-PENDING.json` is written before any file changes.
- INT, TERM and HUP restore synchronously; the next start restores after a SIGKILL. jest runs as an async child, and a run that matches 0 tests is an error.
- **Selftest on a real mutation** (ST1: `fenced()` fences regardless of the flag), at tip `51c22373`:
  - `--selftest term`: "restored server/studio/compile/fence.ts (SIGTERM)", exit 130, the tree clean, no PENDING.
  - `--selftest kill`: exit 137, with `fence.ts` dirty and PENDING on disk. The next start printed "restored server/studio/compile/fence.ts (a previous run died mid-mutation)" and was byte-identical across 2209 files, tree sha256 `d37424e6…` both before and after.

---

## Predictions

The first set was registered in the R-report (24 Sep 2026). **Rows marked "scope ruling" were re-registered after ADI-IP-S and ADI-IP-SCOPE, before any build commit. They are scope rulings, not misses.**

| Claim | Predicted | How it is measured | Status |
|---|---|---|---|
| P-1 Goldens exercising the moved code | **9** (6 generate, 3 masked incl. frame-space) of 118 | `compile/golden.test.ts` | registered |
| P-2 Golden set size | **118**, unchanged. R-report: 122. **Scope ruling:** no campaign or ad-op goldens. | `golden.test.ts` `toHaveLength(118)` | re-registered |
| P-3 Golden bytes | **All 118 byte-identical**, with every flag state the file already tests | `golden.test.ts` | re-registered (R-8's exception moved to PR 19) |
| P-4 Text identity of the move | **0** moved lines differ; the only other diff lines are import/export lines, plus the new file's header comment, reported separately | `git diff --color-moved` + `scratchpad/movecheck.mjs` | registered |
| P-5 Census rows | **475** (434 + 22 AthleteHalf + 19 BrandHalf), **19 sources** | `rows.test.ts` | registered (derived, $0) |
| P-6 Census coverage, flags on | **335 / 475** (322 + 3 + 1 + 9) | `studioFlowCensus.ts` `coverage()` over `verdicts.ts` | registered |
| P-7 Census coverage, flags off | **302 / 475** (289 + 13) | same | registered |
| P-8 Census verdict totals, flags on | CONSUMED **225**, DECIDES **110**, DISPLAY **83**, DELIBERATE-DEAD **38**, DEAD **19** | a count over `verdicts.ts` | registered |
| P-9 Dead arms | **0 go live, 0 deleted, 2 kept deliberate** (`untrusted`, `ProductPiece.reference`), **3 left to PR 19** | ledger + diff | registered |
| P-10 Constraint fields reaching an image prompt | **0 new** on any path. R-report: 1 field on 4 paths. **Scope ruling.** | the goldens + route T1 | re-registered |
| P-11 Client flags | **16** in `flags.ts`; **16** `=true` pins; devEnv test 2 pinned at 16. ADI-GO-IP said 17 with a twin. **Scope ruling:** no twin. | devEnv tests 2 and 3 | re-registered |
| P-12 Dev defaults changed vs main | **6** flip from off to on (the six new pins); **0** flip from on to off. R-report: "10 of 10 flip". **Env ruling:** the pins stay. | `git diff origin/main -- .env.development` | re-registered |
| P-13 Planner fingerprint | **`0ebb8528a218`, unchanged** | `agent/plan.test.ts:1520` | registered |
| P-14 Video prompt goldens | **Unchanged** | `video/prompts.test.ts` | registered |
| P-15 PR 18 P-fence set | **The same 4 cells**, bytes unchanged | `golden.test.ts:1357` | re-registered (R-8's re-capture moved) |
| P-16 Route test T1–T6 | **All green on the tip with no production change.** They pin today's behaviour. T4's LIBRARY_FIELDS-off pass is labelled as the known hole C-5. | `server/routes/studio.imageGenerate.test.ts` | registered |
| P-17 T6 | **Scope ruling, redefined:** with no parity flag, T6 pins today's flag-off bytes on this path. With `STUDIO_IDENTITY_PACK` and `STUDIO_STYLE_SPEC` off, the captured references are her picks only and the prompt carries no fence marker. | T6 | re-registered |

## Mutations (planned; each red by name, then restored, tree byte-identical before and after)
| # | Mutation | Expected red |
|---|---|---|
| M-env | one `.env.development` pin set to `=false` | devEnv test 1 (names the key) and test 2 |
| M-env3 | one pin line deleted | devEnv test 3 (names the flag) |
| M-mv1 / M-mv2 / M-mv3 | one byte changed in the moved function's generate, crop and frame-space arms | the generate / masked / frame-space goldens, by name |
| M-fence | the untrusted arm rendered as plain `DIRECTION:` | the R-10 unit test, and the golden "generate — a story from an untrusted inbound brief" |
| M-T1 | `runGeneration` sends a prompt other than the one planned | T1 |
| **M-x1** (crosses client/server) | `client/lib/identityPack.ts` orders pack picks ahead of hers | T2 |
| **M-x2** (crosses client/server) | `client/lib/studio-contract.ts` `toEngineReferences` drops the role | T2 |
| M-T3a / M-T3b | the athlete filter dropped from the owned-image read; the athlete check dropped from the preview load | T3 |
| M-T4 | the likeness gate lets a made-here row through | T4 |
| M-T5a / M-T5b | the job records the estimate as its cost; a double tap spends twice | T5 |

## Spend
| Cell | Quoted | Reported |
|---|---|---|
| Phase R | $0 | $0 |
| The build | $0 (no model cells; every adapter mocked) | — |

## Cards
| # | Card | Owner |
|---|---|---|
| K-IP1 | **Plan-aware Create Anything.** No product request can carry a `planId` to a generate. When one can, the R-4 precedence rule above applies. | unowned (ADI-IP-S) |
| K-IP2 | **Moved to PR 19:** R-5, R-6, S-3, T7, T8. `planId` on typed-edit quote bodies; the Agent-screen sheet sends it only while a current, un-stale plan is on screen (`AgentScreen.tsx:318,436`); constraints reach an edit. | PR 19 (ADI-IP-SCOPE) |
| K-IP3 | **Moved to PR 19:** R-8 + C-2. The ad op's own-brand exclusion (`ops.ts:561-563`, asserted at `ops.test.ts:217`), and the rewording to "any <brand> logo", so there is no article logic (`compile/constraints.ts:59-61`). The finding to pass on: the re-capture touches **3 goldens** ("interpreter — exclude_marks beside the brand's DO NOTs: one line", "interpreter — exclude_marks with no brand attached: the DO NOT line alone", "interpreter — sentence 4's C: two swaps of hers, and no Nike logos anywhere") and **5 literal strings in 3 test files** (`nativeEdit.test.ts:970,973`, `compile/fences.test.ts:116,120`, `routes/studio.interpret.test.ts:562`). One re-capture, not two. | PR 19 (ADI-IP-SCOPE) |
| K-IP4 | **Moved to PR 19:** R-14. `AD_PARAMS.campaign` is appended only at run (`edit/engine.ts:607-611`), so the quoted prompt is not the prompt that runs. | PR 19 (ADI-IP-SCOPE) |
| K-IP5 | **The carousel's constraints.** The carousel already holds the brief's lines in memory (`BrandPlanStep.tsx:287-292`, `SetupScreen.tsx:91-98`), so a later PR could carry constraints there without a plan row. | unowned (ADI-IP-S) |
| K-IP6 | **Split `buildPrompt`** (now in `compile/image.ts`) into its generate, crop and frame-space functions, with its own proof. The arms are interleaved in one parts list. | unowned |
| K-IP7 | **`eas update`'s env mode, unverified from code.** `eas-update-preview.yml:67` runs `eas update --branch preview`; `eas-cli` is not a dependency, so whether it bundles through `expo export` (forced production, `exportApp.js:116-119`) cannot be cited. Guard 3's other paths are closed. | PR 20 (Adi, 24 Sep 2026) |
| C-1 | A video with a refused template gets `videoPrompt = ""`, which is falsy, so the preview plans the **still** prompt (`preview.ts:1104-1109,1223`). It is blocked, so it doesn't spend, but the comments at `:1098` and `:1218` are wrong. The move leaves this dispatch byte-identical. | unowned |
| C-3 | The census traces nonces, so a boolean like `untrusted` going live cannot red it. R-10's unit test covers this one field. | unowned |
| C-4 | `createAnythingLogic.ts:684-688` discards a `new_image` reading at send. The generate is sent fresh, with no interpretation record. | unowned |
| C-5 | With `STUDIO_LIBRARY_FIELDS` off, a made-here row that is not her passes the reference door (`routes/studio.ts:682`). T4 pins it as a known hole, not as desired behaviour. | unowned |
| C-6 | `flow-eval.md` says "320 of 432". The census was 434 rows at the base (PR 18 added two) and is 475 after this PR. | ledger note |
| C-7 | Four census rows still name "K15 → image-path parity PR" as owner and are **not** addressed here: `clipRequest:references[].label`, `briefInput:references[].label`, `briefJob:references[].label` (the client never sends a label, `studio-contract.ts:579`) and `briefJob:direction.featuredPieces` (the inbound arm R-10 keeps). They are re-owned to this card, not silently left. | unowned |
| C-8 | BrandHalf `pieces[].granularity` (written sku/category, read by nothing) and `competitors` (read by nothing as a field; its content is folded into `donts` at `brief.ts:925-928`) have **no ruling**. Verdicted DEAD, as findings. | unowned |

---

## Build (24 Sep 2026)

### Commits
| Commit | What |
|---|---|
| `66eeea3c`, `51c22373` | The env pins: the strip reverted, and the six missing flags pinned `=true` |
| `0a41f344` | This ledger: the rulings, and the re-registered predictions, before any build commit |
| `b7e71617` | The three devEnv tests |
| `bac8e6cb` | **The move**, verbatim: `buildPrompt` and `delimited` into `compile/image.ts` |
| `53e341db` | The R-10 unit test, `compile/image.test.ts` |
| `a769d55b` | Comments only: the stale `TODO(compile tier)` retired, and `compile/index.ts` lists `image.ts` |
| `836ff0c3` | The route tests, T1–T6 (`studio.imageGenerate.test.ts`) plus guard 1 (`studio.maskedEdit.test.ts`), with goldens captured on the pre-move tip |
| `a904d163` | The census: two new sources, 41 verdicts, R-10's re-verdict, and C-7's re-owners |
| `42bd194c` | The census fix: `ORIGIN` for the two new sources (miss M-1) |

`npm ci` ran in the worktree before the build: it installs from the lockfile, and no tracked file changed.

### The predictions, measured
| # | Predicted | Measured | |
|---|---|---|---|
| P-1 | 9 goldens exercise the moved code | 9 (6 generate, 3 masked); every one goes red when the moved code changes (M-mv1–3) | **hit** |
| P-2 | 118 goldens | 118 (`golden.test.ts` `toHaveLength(118)` green) | **hit** |
| P-3 | All 118 byte-identical in every flag state tested | 602 / 602 across the six `buildPrompt`-caller suites after the move (golden 357, preview 170, brief 46, style 16, orientation 9, fences 4) | **hit** |
| P-4 | 0 moved lines differ | `movecheck.mjs bac8e6cb`: 299 removed from `preview.ts` = **290 moved** (one block, `576-865`) + 9 import/export; 4 added, all import/export; `image.ts` = 290 moved verbatim + 6 import/export + 7 header comment + blanks; block byte-identical (20,203 bytes); **PASS**. Negative control (one byte flipped in memory): FAIL, exit 1. `git show --color-moved=plain bac8e6cb`: all 290 moved lines are coloured as moved on both sides. The only plain lines are the 9 removed and 4 added import/export lines in `preview.ts`, plus the 6 imports and 4 header text lines in `image.ts`. | **hit** |
| P-5 | 475 rows, 19 sources | 475, 19 (`rows.test` 7 / 7) | **hit** |
| P-6 | 335 / 475 flags on | **335 / 475** | **hit** |
| P-7 | 302 / 475 flags off | **302 / 475** | **hit** |
| P-8 | CONSUMED 225, DECIDES 110, DISPLAY 83, DELIBERATE-DEAD 38, DEAD 19 | exactly those | **hit** |
| P-9 | 0 live, 0 deleted, 2 kept, 3 to PR 19 | as predicted | **hit** |
| P-10 | 0 new constraint paths | 0; no production byte changed (P-3, T1/T6/masked goldens) | **hit** |
| P-11 | 16 client flags, 16 pins, test 2 pinned at 16 | 16 / 16 / 16 (devEnv 22 / 22) | **hit** |
| P-12 | 6 dev defaults flip off → on; 0 on → off | `git diff origin/main -- .env.development`: +6 lines, 0 removed | **hit** |
| P-13 | Fingerprint `0ebb8528a218` unchanged | `agent/plan.test` 106 / 106, the pin at `:1520` green | **hit** |
| P-14 | Video goldens unchanged | `video/prompts.test` 66 / 66 | **hit** |
| P-15 | P-fence: the same 4 cells | green in the 602 above | **hit** |
| P-16 | T1–T6 green on the tip, no production change | T1–T6: 10 / 10. The masked suite: 1 / 1. Both goldens captured on the pre-move tip `b7e71617` are **byte-identical** to a capture on this tip (sha256 equal) | **hit** |
| P-17 | T6: her picks only, no fence marker | as predicted | **hit** |

### Mutations: 14, every one red by name and then restored, with the tree byte-identical before and after
The runner snapshots the raw sha256 of every tracked file (2210 files at `b7e71617`, 2216 at `a904d163`).

| # | Mutation (file) | Red, by name | Failed / run |
|---|---|---|---|
| M-env | `EXPO_PUBLIC_STUDIO_QA_DISPLAY=false` (`.env.development`) | "every EXPO_PUBLIC_STUDIO_* line … is =true", naming `EXPO_PUBLIC_STUDIO_QA_DISPLAY=false`; "… resolves on …: EXPO_PUBLIC_STUDIO_QA_DISPLAY"; "every flag … has a =true pin" | 3 / 22 |
| M-env3 | the `EXPO_PUBLIC_STUDIO_STYLE_SPEC=true` line deleted | "every flag … has a =true pin", naming `EXPO_PUBLIC_STUDIO_STYLE_SPEC` | 1 / 22 |
| M-mv1 | generate arm: "Do not write" → "Do not print" (`compile/image.ts`) | the goldens "generate — an ad is square" and the other generate cells; route T1 | 22 / 367 |
| M-mv2 | crop arm: "pixel crop" → "px crop" | "masked — crop 0 of a one-region edit"; route "a drawn-box masked edit" | 8 / 358 |
| M-mv3 | frame-space arm: "below" dropped | "masked — the frame-space arm, which no crop reaches" (×3 flag states), plus P-fence | 4 / 357 |
| M-fence | the untrusted arm as plain `DIRECTION:` | "an untrusted direction is fenced as data" (×2); the golden "generate — a story from an untrusted inbound brief" | 6 / 361 |
| M-T1 | `runGeneration` appends a space to the prompt it sends (`preview.ts`) | T1, T2, T6 | 3 / 10 |
| **M-x1** (client → server) | `client/lib/identityPack.ts`: the pack's picks placed ahead of hers | T2 | 1 / 10 |
| **M-x2** (client → server) | `client/lib/studio-contract.ts` `toEngineReferences`: every photo sent as `object` | T2 (also T4 and T6) | 3 / 10 |
| M-T3a | the athlete filter dropped from `readOwnedImage` (`routes/studio.ts`) | T3 "another athlete's photo in her request is a 404"; "… in HER pack is a 404 too" | 2 / 10 |
| M-T3b | the athlete check dropped from `loadPreview` (`previewStore.ts`) | T3 "another athlete cannot spend her preview" | 1 / 10 |
| M-T4 | `likenessDecision` rule 3 off (`referenceGate.ts`) | T4 "a made-here still that is not from her is refused" | 1 / 10 |
| M-T5a | `succeedJob` records `costUsd + 1` (`jobs.ts`) | T5 | 1 / 10 |
| M-T5b | the `consumed_at IS NULL` guard dropped from the atomic claim (`previewStore.ts:175`) | T5 | 1 / 10 |

**Two mutations deviate from the plan, stated plainly:**
- M-T5a was planned as "the job records the estimate as its cost". It was built as "a cost other than the adapter's" (`+ 1`), which exercises the same assertion.
- M-T5b was planned as "a double tap spends twice". It was built as the claim's own guard removed, which is the line that makes a double tap spend once.

### Guard 1: the masked edit through the real route
`server/routes/studio.maskedEdit.test.ts`, $0:
- `router.generate` is mocked to answer with a real PNG the crop's size. The frame is a real 1200×1800 JPEG made by sharp.
- Any other outbound fetch throws, so the suite cannot reach a model.

What it holds:
- A drawn box stays masked (no `editIntent` is frozen).
- The **quoted** prompt, and the prompt **sent for crop 0**, each equal a capture taken on the pre-move tip, equal each other, and equal `plannedInputs(stored brief, { cropIndex: 0 })`.
- The model is handed exactly one reference: `[frame, bytes]`, the crop, smaller than the frame.
- One job succeeds, with one asset pasted back.
- M-mv2 reds it by name.

### Guard 2: import cycles
`scratchpad/cyclecheck.mjs` is an equivalent scripted check; madge is not a dependency, and none was added. Every import, export-from, `require` and dynamic import is resolved with the TypeScript compiler's own module resolution against the repo's tsconfig. It walks two graphs from `server/studio/compile/image.ts`: RUNTIME (type-only edges erased) and ALL. Output, verbatim:
```
start: server/studio/compile/image.ts
direct imports:
  server/studio/brief.ts  (type-only)
  server/studio/composite.ts
  server/studio/preview.ts  (type-only)
  server/studio/compile/fence.ts
  server/studio/compile/manifest.ts
  server/studio/compile/style.ts
RUNTIME graph: 11 files reachable; preview.ts NOT reachable
ALL graph (type-only edges included): 105 files reachable; preview.ts reachable via server/studio/compile/image.ts -> server/studio/preview.ts
```
- The real check exits 0.
- **The negative control** starts from `server/studio/generate.ts`, which imports `preview.ts` at runtime. It prints `RUNTIME graph: 119 files reachable; preview.ts REACHABLE via server/studio/generate.ts -> server/studio/preview.ts` and exits 1.
- **The one edge to `preview.ts` is type-only:** `import type { PlannedReference } from "../preview"`, erased at compile. It is the same edge `compile/manifest.ts:11` and `compile/assemble.ts:29` already carry on main.
- **At runtime, `compile/image.ts` imports nothing from `preview.ts`, directly or transitively.**

### Guard 3: production and EAS bundles never load `.env.development`
Versions: `@expo/cli` (the copy under `node_modules/@expo/cli`), `@expo/env` 2.0.11, `@expo/metro-config` 54.0.15.

1. **Which files load is chosen by `NODE_ENV`.** `@expo/env` `getEnvFiles` (`build/index.js:88-111`) returns `` [`.env.${mode}.local`, `.env.local` (not in test), `.env.${mode}`, `.env`] ``, with `mode = process.env.NODE_ENV`. So `.env.development` is read only when `NODE_ENV` is `development`.
2. **Web export forces production.** Both web deploys run `npx expo export --platform web` with no `--dev` (`deploy-web-dev.yml:47`, `deploy-prod.yml:215`). `exportAppAsync` has the comment "Force the environment during export and do not allow overriding it", then `const environment = dev ? 'development' : 'production'; process.env.NODE_ENV = environment;` (`@expo/cli/build/src/export/exportApp.js:116-119`).
3. **The dev-bundle env module exists only in dev.** The `expo/virtual/env` module that merges `['.env', '.env.development', '.env.local', '.env.development.local']` is emitted only when `options.dev` (`@expo/metro-config/build/transform-worker/transform-worker.js:150-163`). A production bundle gets a throwing Proxy there instead, and its `EXPO_PUBLIC_*` values are inlined from `process.env` (point 1).
4. **Native release builds (EAS `preview` and `production` profiles)** bundle through `export:embed`:
   - Xcode passes `--dev false` for any non-Debug configuration (`expo/scripts/react-native-xcode.sh:55-56`).
   - Gradle passes `--dev <devEnabled>`, false for a release variant (`BundleHermesCTask.kt:149-150`).
   - `exportEmbedAsync` calls `setNodeEnv(options.dev ? 'development' : 'production')` (`exportEmbedAsync.js:187`).
   - **One caveat, now CLOSED (24 Sep 2026):** `setNodeEnv` keeps a pre-existing value (`process.env.NODE_ENV = process.env.NODE_ENV || mode`, `utils/nodeEnv.js:67-68`). `eas.json`'s profiles set no `NODE_ENV`; their `env` blocks carry only `EXPO_PUBLIC_*`. The one place left that could set it is the EAS dashboard. **Adi checked it: no `NODE_ENV` in production (project and account scope) or preview.** The commands and their output, as Adi ran them (npm's install notices omitted):
     ```
     npx eas-cli@latest env:list --environment production
     Environment: production
     No variables found for this environment.

     npx eas-cli@latest env:list --environment production --scope account
     Environment: production
     No variables found for this environment.

     npx eas-cli@latest env:list --environment preview
     Environment: preview
     No variables found for this environment.
     ```
5. **`eas update`** (`eas-update-preview.yml:67`) **stays OPEN, carded K-IP7 → PR 20.** `eas-cli` is not in `node_modules`, so its code cannot be cited here. It is documented to bundle through `expo export`, and point 2 would then hold, but that is not verified from code.
6. **The EAS `development` profile** (`developmentClient: true`) builds a dev client whose JS comes from a local Metro. That is a developer's machine, where `.env.development` applies by design.

**Server flags that pair with the six newly pinned client flags**, for dev servers to match (in the PR description too):

| Client pin (new) | Server flag | Read at | Also needs | Spend when on |
|---|---|---|---|---|
| `EXPO_PUBLIC_STUDIO_COMPOSER` | `STUDIO_COMPOSER` | `server/studio/config.ts:1695` | — | $0 (rules) |
| `EXPO_PUBLIC_STUDIO_LIBRARY_FIELDS` | `STUDIO_LIBRARY_FIELDS` | `config.ts:1706-1707` | — | $0 (readers of stored tags) |
| `EXPO_PUBLIC_STUDIO_BRIEF_CARRIER` | `STUDIO_BRIEF_CARRIER` | `config.ts:1720-1721` | `STUDIO_BRAND_PROFILES` (`config.ts:1299-1300`) for the campaign parts: tone, style, energy, constraints, references | $0 |
| `EXPO_PUBLIC_STUDIO_IDENTITY_PACK` | `STUDIO_IDENTITY_PACK` | `config.ts:1730-1731` | — | the pack routes quote a calibration; nothing spends without her tap |
| `EXPO_PUBLIC_STUDIO_IDENTITY_DRIFT` | `STUDIO_IDENTITY_DRIFT` | `config.ts:1739-1740` | `STUDIO_QA_DISPLAY` (the chip is behind it), and clip QA itself runs only with `STUDIO_CREATIVE_QA` (`videoRunner.ts:504`) | **embeds per clip** when clip QA runs |
| `EXPO_PUBLIC_STUDIO_STYLE_SPEC` | `STUDIO_STYLE_SPEC` | `config.ts:1757` | with `STUDIO_IDENTITY_PACK` also on, an identity observation on each accepted typed edit | ≈ $0.00128 per accept (ADI-GO18 G10) |

### The gate: scoped, by Adi's ruling
- **The full-suite run was VOID, not red.** `npm test` bare, at tip `a904d163`, discovered 534 files in 20 batches. `client#1` ran green (chunks of 8/8 suites: 122, 158, 63, 111 and 99 tests). Then the machine's disk filled: from `server/services#1` onward, every chunk crashed at jest's haste-map cache write (`ENOSPC: no space left on device, open '/private/var/folders/…/T/jest_dx/haste-map-…'`) before running a test (`gate1.log`). It says nothing about the code.
- **Adi cleared space, then ruled: no full re-run; scoped suites only** (24 Sep 2026, "u dont need to re run full gate just do scoped ones"). This is a deviation from the house rule that the full suite runs at the hold, made by Adi and recorded here.
- **Scoped gate at `42bd194c`: 22 suites, 1120 / 1120 green, 0 failed.** Jest's JSON, read per suite:

  | Suite | Tests |
  |---|---|
  | `compile/golden` | 357 |
  | `preview` | 170 |
  | `agent/plan` (**the fingerprint `0ebb8528a218`, P-13: hit**) | 106 |
  | `routes/studio` | 94 |
  | `generate` | 93 |
  | `video/prompts` (**P-14: hit**) | 66 |
  | `routes/studio.native` | 51 |
  | `brief` | 46 |
  | `routes/studio.generate` | 29 |
  | `devEnvLayering` | 22 |
  | `compile/style` | 16 |
  | `routes/studio.imageGenerate` | 10 |
  | `orientation` | 9 |
  | `census/capabilities` | 9 |
  | `compile/describe` | 9 |
  | `census/rows` | 7 |
  | `routes/studio.style` | 7 |
  | `census/census` | 6 |
  | `compile/fences` | 4 |
  | `compile/image` | 4 |
  | `compile/looks` | 4 |
  | `routes/studio.maskedEdit` | 1 |

- **The other checks, at `42bd194c`:**
  - `npm run check:types` (`tsc --noEmit`): exit 0.
  - `npx tsc --noEmit -p tsconfig.jest.json`: exit 0.
  - eslint on every touched `.ts`/`.tsx`: 0 errors, 39 warnings. All are `import/first` or `no-require-imports`, the `jest.mock`-first pattern of the sibling route suites.
  - prettier on the 13 touched `.ts`/`.json` files: clean. Each one was clean on main, or is new.
- **Not run: the rest of the suite**, by the ruling above. That covers what the scoped set does not import: Mila, services, skills, the video runner, most of `server/routes`.

### Things to know, stated plainly
- **C-1's cites at this tip:** `preview.ts:805` (the comment), `:813` (`""`) and `:932` (the dispatch). The move changed none of its bytes.
- **`studio.imageGenerate.test.ts` and `studio.maskedEdit.test.ts` lint with 0 errors** and the same warning pattern as `studio.native.test.ts` (`import/first` and `no-require-imports`, from `jest.mock` before the imports).
- **T2's manifest line reads `PRODUCT: "product 1"`**, not the tray's name: the client never sends a label (C-7, K15's remainder). Pinned as it is.
- **The pre-move capture worktree** `/Users/adi/nomila-v2-worktrees/ip-base-b7e7161` (detached at `b7e71617`, `node_modules` symlinked) is left in place, so the capture can be re-run.
- **The route goldens' prompts carry no path or id.** The references' paths are asserted by the tests, not stored in the golden.

## Misses
- **M-1: the census commit `a904d163` shipped a red suite.** It added `athleteHalf` and `brandHalf` to `SOURCES` (`rows.ts`) without their entries in `ORIGIN` (`census/measure.ts:22`, typed `Record<SourceName, …>`). So `census.test.ts`'s `measure` read `undefined.point`, and "captured the flow's artifacts" went red in both runs. `tsc` names the gap too.
  - **Why it slipped:** I ran `rows.test` alone after that commit, not `census.test` and not `tsc`.
  - **Caught by** the scoped gate. **Fixed in `42bd194c`:** both sources are `{ point: "none" }`, held by their static and cite verdicts. Census 22 / 22 and both `tsc` configs are clean after the fix.
  - The predictions are unaffected (P-5 to P-8 were counts over `verdicts.ts` and `rows.ts`, and they hold). Recorded, not retrofitted.
