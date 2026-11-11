# 14 · Studio inventory — pinned branch manifest + capability table (Agent G)

Read-only. Written 2026-09-27. Companion to `07-studio.md` (the narrative, the key trace, the re-verified priors).
Method: `git for-each-ref refs/remotes/origin/` filtered to `studio*`, `adi/studio-*`, `chore/composer-dev-flag`,
`chore/expo-dev-flags`; ancestry via `git merge-base --is-ancestor <tip> 9fff9b15`; PR state via
`gh pr list --state all --author <engineer>` (head branch → number/state/merge commit); squash-merged branches checked by PR
merge commit, unmerged work by `git cherry 9fff9b15 <tip>`.

## A. Manifest verdict (the part that joins the as-of manifest)

| ref | SHA | status | what it is |
|---|---|---|---|
| **Canonical "current Studio" = `origin/main`** | **`9fff9b15`** | — | Every Studio PR through #607 (`studio/ship-docs`, merged 2026-09-25 10:46Z) is on main. The newest five tips named in `00-control.md` (`ship-docs bd0ed0ce`, `ship-sched 63c059de`, `ship-cites 4bd111b1`, `ship ecf04cfa`, `image-ops 67ca7e15`) are all **ancestors of main** (merged by merge-commit #607/#606/#605/#604/#603). |
| Brain stack tip (#665) | `3f0139f6` | OPEN_PR (stack) | Adds CreativeIntent + Campaign lineage to Studio: `server/studio/creative/{door,interpret,resolve,routes}.ts` (new), `brief.ts` (+`athlete` origin, `CampaignLineage`), `config.ts` (2 flags), `jobs.ts`, `agent/plans.ts`, `publish/runner.ts` (+`recordPublishedIdentity`), `server/routes/studio.ts` (+57/−3), `server/routes/campaignGovernance.ts` (new) — `git diff 9fff9b15 3f0139f6 --stat -- server/studio server/routes shared`. Studio commits on the stack: `20cfd173` (creative slice, PR #657), `e69cc7d8`/`a057cd14` (campaign), `f5b2b9f3` (outcome join 0075). |
| Dev Cloud Run image | `202771d3` | deployed-dev | `gcloud run services describe nomila-v2` → revision `nomila-v2-00757-gs2`, image tag `…/nomila-v2:202771d3` (the parent of `3f0139f6`; `git diff 202771d3 3f0139f6 --stat` = 5 files, scripts/docs). Carries all Studio code of main + the stack's Studio diff. |
| **Unmerged Studio work #1** | `origin/studio/acceptance-harness` `f3851671` | UNMERGED_BRANCH · PR #507 OPEN | 10 commits not on main (`git cherry` all `+`): `server/scripts/studioAcceptance.ts` + `server/scripts/acceptance/*` (7,674 lines) — a 106-cell acceptance harness through the real preview route. Tooling only; no product code. |
| **Unmerged Studio work #2** | `origin/chore/expo-dev-flags` `3a5ced1f` | UNMERGED_BRANCH · PR #567 OPEN | 3 commits not on main: `70343d0d` "an ask on her photo is never a generate…" (classifier PR 1) and `b4a7d764` "a body modification is hers on every operation, and her skin is never a look" (classifier PR 1b) — guard changes in `server/studio/classify.ts` (`SKIN_WORDS` exists only here: `git grep SKIN_WORDS 9fff9b15` = none) — plus `.env.development` Studio client flags. **Two classifier safety fixes are not on main.** Merge-base `2ab0cf53` (2026-09-19): stale against main. |
| Closed-unmerged tip | `origin/adi/studio-u2-generation` `4ae27fdf` | UNMERGED_BRANCH · PR #300 CLOSED | 1 commit beyond merged #291 (`6eaee8c8`): "one image instruction, a graceful empty result, a deliberate pick" (`server/studio/preview.ts`, `types.ts`, 9 files). Whether its content was re-landed later: UNKNOWN (would need a content diff against the current `compile/image.ts`). |
| Stale remote tips (content on main) | `origin/studio/mila-direction 035a4e9e`, `origin/studio/video-publish-instagram 57ad6a21` | MAIN | Remote tip ≠ PR head: `035a4e9e` is an ancestor of main (landed via #572); `57ad6a21` is patch-equivalent on main (`git cherry` → `-`, landed via #544). |

Stacking: the `studio/*` PRs were stacked in series on main (each branch's base = main at the time; `baseRefName` = `main` for every
engineer PR in the listing). No Studio branch is stacked on the Brain stack; the Brain stack (#656 → #657 → #658 …) is
stacked on `docs/campaign-creative-seam` (#655) → `feat/outreach-planner` → … (see `gh pr list` baseRefName).

Out of scope but in the `adi/*` glob: 44 `adi/mila-*`, `adi/voice-*`, `adi/conversations-ddl`, `adi/*deploy*`, `adi/livekit-prod-mount`
branches (Mila chat/voice, Jul–Aug 2026) — all ancestors of main or merged by PR (#96–#246), except
`adi/mila-30-voice-secret-mount` (PR #196 CLOSED; superseded by #197 `adi/mila-30-secret-only` MERGED).

## B. Full Studio branch table (138 refs; newest first)

`merged-to-main?` = tip is an ancestor of `9fff9b15`. "no" + MERGED PR = squash-merged; its content is on main via the merge
commit shown (→). "Contained in" is `origin/main 9fff9b15` for every row whose PR is MERGED or which is an ancestor; the
exceptions are marked in §A.

| branch | tip SHA | date | merged-to-main (ancestor)? | PR # · state · → merge commit |
|---|---|---|---|---|
| `studio/ship` | `ecf04cfa` | 2026-09-25 | yes (ancestor) | #604 MERGED →430f80ce |
| `studio/ship-sched` | `63c059de` | 2026-09-25 | yes (ancestor) | #606 MERGED →0b406e40 |
| `studio/ship-docs` | `bd0ed0ce` | 2026-09-25 | yes (ancestor) | #607 MERGED →38b500ca |
| `studio/ship-cites` | `4bd111b1` | 2026-09-25 | yes (ancestor) | #605 MERGED →9dbef288 |
| `studio/image-ops` | `67ca7e15` | 2026-09-25 | yes (ancestor) | #603 MERGED →b9989e6b |
| `studio/style-spec` | `852e5869` | 2026-09-24 | yes (ancestor) | #591 MERGED →7121871f |
| `studio/plan-memory` | `da3f7137` | 2026-09-24 | yes (ancestor) | #583 MERGED →93ff0765 |
| `studio/library-fields` | `de0e3a19` | 2026-09-24 | yes (ancestor) | #582 MERGED →9aafd2e3 |
| `studio/library-fields-madehere` | `a7a1eac3` | 2026-09-24 | yes (ancestor) | #584 MERGED →e7e53f06 |
| `studio/join-row` | `9e8e44f3` | 2026-09-24 | yes (ancestor) | #581 MERGED →02124b71 |
| `studio/image-parity` | `7dff26bf` | 2026-09-24 | yes (ancestor) | #594 MERGED →eef372b9 |
| `studio/identity-pack` | `62ced82f` | 2026-09-24 | yes (ancestor) | #586 MERGED →639d8d44 |
| `studio/flow-eval` | `bd5d98c4` | 2026-09-24 | yes (ancestor) | #590 MERGED →7a083fc6 |
| `studio/confirm-integrity` | `f93a0063` | 2026-09-24 | yes (ancestor) | #580 MERGED →de3fc18b |
| `studio/composer` | `b36a7354` | 2026-09-24 | yes (ancestor) | #587 MERGED →b5469982 |
| `studio/composer-boundary` | `6db6c420` | 2026-09-24 | yes (ancestor) | #589 MERGED →e9cac92d |
| `studio/brief-carrier` | `4626e521` | 2026-09-24 | yes (ancestor) | #585 MERGED →e2950e5a |
| `chore/composer-dev-flag` | `e563487f` | 2026-09-24 | yes (ancestor) | #588 MERGED →487053e2 |
| `studio/mila-direction` | `035a4e9e` | 2026-09-23 | yes (ancestor) | #572 MERGED →b6e7f2b8; #569 MERGED →a1aec84d |
| `studio/image-edit` | `81f545e7` | 2026-09-23 | yes (ancestor) | #576 MERGED →c8242e07 |
| `studio/clip-reads` | `f043f08d` | 2026-09-23 | yes (ancestor) | #579 MERGED →ee357e11 |
| `studio/plan-doctrine` | `ff83f89b` | 2026-09-22 | yes (ancestor) | #558 MERGED →ef31bad4 |
| `studio/photos-motion` | `16a1765f` | 2026-09-22 | yes (ancestor) | #565 MERGED →c70c2f94 |
| `studio/music-fonts` | `1b77005d` | 2026-09-22 | yes (ancestor) | #566 MERGED →2bedd2ed |
| `studio/ingest-flip` | `ed3d4df6` | 2026-09-22 | yes (ancestor) | #564 MERGED →28306566 |
| `studio/enrich-fixes` | `07c44ae5` | 2026-09-22 | yes (ancestor) | #561 MERGED →3e121d13 |
| `studio/enrich-eval` | `91383784` | 2026-09-22 | yes (ancestor) | #560 MERGED →1564425d |
| `studio/enrich-51s-bug` | `4206da05` | 2026-09-22 | yes (ancestor) | #559 MERGED →213552cb |
| `studio/capabilities` | `f2038267` | 2026-09-22 | yes (ancestor) | #568 MERGED →9d822523 |
| `studio/c3-doctrine2` | `0555e999` | 2026-09-22 | yes (ancestor) | #563 MERGED →70f38c40 |
| `studio/c2-video-intelligence` | `ded4acba` | 2026-09-22 | yes (ancestor) | #557 MERGED →b430f014 |
| `studio/brand-profiles` | `a2019392` | 2026-09-22 | yes (ancestor) | #562 MERGED →047d1342 |
| `studio/agent-route-test-broll-ref` | `8ab76ed5` | 2026-09-22 | yes (ancestor) | #556 MERGED →78309fec |
| `chore/expo-dev-flags` | `3a5ced1f` | 2026-09-22 | no | #567 OPEN |
| `studio/video-clips-posters` | `2ed90261` | 2026-09-21 | yes (ancestor) | #549 MERGED →987cae03 |
| `studio/still-clips` | `4381eab4` | 2026-09-21 | yes (ancestor) | #552 MERGED →74bb8882 |
| `studio/still-board` | `a8d543e7` | 2026-09-21 | yes (ancestor) | #555 MERGED →e074b58f |
| `studio/run-video-route` | `10fecad1` | 2026-09-21 | yes (ancestor) | #548 MERGED →64472e5a |
| `studio/media-picker` | `52dcf1c8` | 2026-09-21 | yes (ancestor) | #554 MERGED →35a6ca27 |
| `studio/broll-t2v` | `4af8b3ea` | 2026-09-21 | yes (ancestor) | #553 MERGED →1de3409c |
| `studio/agent-tab` | `9be1d0ec` | 2026-09-21 | yes (ancestor) | #551 MERGED →f8e8a25e |
| `studio/agent-prereqs` | `eaa55d12` | 2026-09-21 | yes (ancestor) | #550 MERGED →70944dcd |
| `studio/video-slots-requote` | `7a73cd21` | 2026-09-20 | yes (ancestor) | #538 MERGED →990a67db |
| `studio/video-shot-slots` | `0dc37dd8` | 2026-09-20 | yes (ancestor) | #537 MERGED →40b4b97e |
| `studio/video-publish-syncfix` | `39211feb` | 2026-09-20 | yes (ancestor) | #544 MERGED →dfaa7cde |
| `studio/video-publish-instagram` | `57ad6a21` | 2026-09-20 | no | #543 MERGED →7add0d3f |
| `studio/video-first-frame-probe` | `828ee8d5` | 2026-09-20 | yes (ancestor) | #539 MERGED →599d1273 |
| `studio/video-first-frame-crop` | `edc53fb6` | 2026-09-20 | yes (ancestor) | #534 MERGED →8c5a18a2 |
| `studio/video-duration-option-delete` | `b77862d7` | 2026-09-20 | yes (ancestor) | #535 MERGED →f736ad91 |
| `studio/video-duration-on-brief` | `efa94faa` | 2026-09-20 | yes (ancestor) | #533 MERGED →fd75b33e |
| `studio/video-captions-music` | `4273da66` | 2026-09-20 | yes (ancestor) | #540 MERGED →1ceabee6 |
| `studio/video-bed-from-video` | `d8e69a12` | 2026-09-20 | yes (ancestor) | #541 MERGED →d3ef80d6 |
| `studio/clip-audio-and-flags` | `5ac85f30` | 2026-09-20 | yes (ancestor) | #545 MERGED →e4696a7c |
| `studio-video-v10` | `93fd86ba` | 2026-09-20 | yes (ancestor) | #532 MERGED →512de3ac |
| `studio/stitch-runner-hook-timeout` | `73d3b84f` | 2026-09-19 | yes (ancestor) | #523 MERGED →2ab0cf53 |
| `studio-video-v9` | `44269230` | 2026-09-19 | yes (ancestor) | #531 MERGED →91fcb3b1 |
| `studio-video-v8` | `f0f88a5e` | 2026-09-19 | yes (ancestor) | #529 MERGED →801c42f0 |
| `studio-video-v7` | `2edb6bb8` | 2026-09-19 | yes (ancestor) | #522 MERGED →a7349d7c |
| `studio-video-v5` | `2faca4e3` | 2026-09-19 | yes (ancestor) | #521 MERGED →e3333d3b |
| `studio-duration-fix` | `5af45973` | 2026-09-19 | yes (ancestor) | #525 MERGED →bfa335c8 |
| `studio/wave-d` | `19527a3c` | 2026-09-18 | yes (ancestor) | #508 MERGED →76901178 |
| `studio/wave-d-client-pins` | `7ea38565` | 2026-09-18 | yes (ancestor) | #509 MERGED →2b2b78f9 |
| `studio/wave-c` | `ebad7107` | 2026-09-18 | yes (ancestor) | #506 MERGED →27185ee0 |
| `studio/ci-ffmpeg` | `cef58a05` | 2026-09-18 | yes (ancestor) | #515 MERGED →8bf1ec94 |
| `studio/card2-sweep2-pin` | `e3ca1c91` | 2026-09-18 | yes (ancestor) | #512 MERGED →e96323a1 |
| `studio/card2-per-target-colour` | `6488b820` | 2026-09-18 | yes (ancestor) | #511 MERGED →7fd93134 |
| `studio/acceptance-harness` | `f3851671` | 2026-09-18 | no | #507 OPEN |
| `studio-video-v6` | `99e337a4` | 2026-09-18 | yes (ancestor) | #514 MERGED →2c481bd6 |
| `studio-video-v4` | `d3a6ac92` | 2026-09-18 | yes (ancestor) | #517 MERGED →04f74791 |
| `studio-video-v3` | `3bbcc94a` | 2026-09-18 | yes (ancestor) | #516 MERGED →9e8bb558 |
| `studio-video-v2` | `d06b468e` | 2026-09-18 | yes (ancestor) | #513 MERGED →6763b73e |
| `studio-video-v1` | `d46b2abb` | 2026-09-18 | yes (ancestor) | #510 MERGED →4ccc518d |
| `studio/wave-b-paths` | `0c3b4ad6` | 2026-09-17 | yes (ancestor) | #502 MERGED →82f862fd |
| `studio/wave-a` | `988e49ff` | 2026-09-17 | yes (ancestor) | #497 MERGED →2dc602ed |
| `studio/product-add-referent` | `9e83dd66` | 2026-09-17 | yes (ancestor) | #498 MERGED →b3ee70c8 |
| `studio/probe-framing-identity` | `e62ab24b` | 2026-09-17 | yes (ancestor) | #499 MERGED →7d12dbcc |
| `studio/wave3-fixes` | `dfc13289` | 2026-09-16 | yes (ancestor) | #491 MERGED →7fafeed4 |
| `studio/wave1-fixes` | `c9b65d89` | 2026-09-16 | yes (ancestor) | #487 MERGED →5a21a115 |
| `studio/reference-packs` | `8e16488b` | 2026-09-16 | yes (ancestor) | #482 MERGED →e1c0f286 |
| `studio/qa-scores-generates` | `9ed6a057` | 2026-09-16 | yes (ancestor) | #484 MERGED →374cc3ae |
| `studio/preservation-fixes` | `3911f093` | 2026-09-16 | yes (ancestor) | #488 MERGED →e7580f11 |
| `studio/interpreter-generate-exit` | `b9a2ca0b` | 2026-09-16 | yes (ancestor) | #490 MERGED →5385e573 |
| `studio/frame-defaulting` | `fe56951b` | 2026-09-16 | yes (ancestor) | #486 MERGED →8603f24a |
| `studio/catch-all-interpret` | `7a3a6cc2` | 2026-09-16 | yes (ancestor) | #492 MERGED →29b2fc8e |
| `studio/auto-mark` | `b668362f` | 2026-09-16 | yes (ancestor) | #489 MERGED →f3ff6af0 |
| `studio/sessions-server` | `c7477249` | 2026-09-15 | yes (ancestor) | #471 MERGED →c86baced |
| `studio/sessions-client` | `b21ece7f` | 2026-09-15 | yes (ancestor) | #475 MERGED →bdbd8c08 |
| `studio/generate-defects` | `82ecf868` | 2026-09-15 | yes (ancestor) | #478 MERGED →aa0d0b79 |
| `studio/text-op` | `fc1f9915` | 2026-09-14 | yes (ancestor) | #461 MERGED →7bbe6089 |
| `studio/style-vocab` | `ee80a4a3` | 2026-09-14 | yes (ancestor) | #467 MERGED →655ea36a |
| `studio/interpreter` | `a8dc17b2` | 2026-09-14 | yes (ancestor) | #465 MERGED →c4951e2e |
| `studio/add-onto-body` | `63d35b52` | 2026-09-13 | yes (ancestor) | #456 MERGED →db76dc2f |
| `studio/replace-with-ref` | `333ef25b` | 2026-09-12 | yes (ancestor) | #444 MERGED →d90efda5 |
| `studio/brand-item-demonstrative` | `dc7a7463` | 2026-09-12 | yes (ancestor) | #445 MERGED →bccaf2b8 |
| `studio/text-render-probe` | `249ce991` | 2026-09-11 | yes (ancestor) | #433 MERGED →4c475fbe |
| `studio/compiler-extract` | `1f767127` | 2026-09-11 | yes (ancestor) | #406 MERGED →b9ad08b0 |
| `studio/sweep-3-findings` | `9de924df` | 2026-09-10 | no | #393 MERGED →b91bb7c5 |
| `studio/native-edit-path` | `5550dfb1` | 2026-09-10 | no | #382 MERGED →246a98c5 |
| `studio/guard-scope` | `31389ccf` | 2026-09-10 | yes (ancestor) | #405 MERGED →e0b49086 |
| `studio/composition-2` | `e998d52d` | 2026-09-10 | no | #398 MERGED →621405d2 |
| `studio/composition-1` | `f4732aef` | 2026-09-10 | no | #396 MERGED →281e3129 |
| `studio/brand-change` | `6ae1dd7b` | 2026-09-10 | no | #392 MERGED →c06e768a |
| `studio/add-object` | `ea8bc3c7` | 2026-09-10 | no | #387 MERGED →dc7bfb48 |
| `studio/route-switch` | `11cff322` | 2026-09-09 | no | #376 MERGED →84e5763c |
| `studio/reference-roles` | `5135d2f9` | 2026-09-09 | no | #380 MERGED →e9d705c9 |
| `studio/probe-memo` | `aee6a897` | 2026-09-09 | no | #378 MERGED →70e03c4b |
| `studio/precedence` | `e307b843` | 2026-09-09 | no | #379 MERGED →8d78ec79 |
| `studio/creative-qa` | `9757def2` | 2026-09-09 | no | #381 MERGED →eb7d770c |
| `studio/classifier` | `71276340` | 2026-09-09 | no | #374 MERGED →654931a5 |
| `studio/background-extract` | `6f9d44f9` | 2026-09-09 | no | #377 MERGED →8f8ecc83 |
| `studio-seam-quality` | `3864d895` | 2026-09-08 | no | #373 MERGED →3f92fe98 |
| `studio-multi-region-edit` | `7d6ffd62` | 2026-09-08 | no | #367 MERGED →eef3b281 |
| `studio-garment-masking` | `5e5af598` | 2026-09-08 | no | #369 MERGED →2075731b |
| `studio-prompt-rewriter` | `fafeb240` | 2026-09-06 | no | #344 MERGED →0a415521 |
| `studio-generation-statelessness` | `56ad973d` | 2026-09-06 | no | #337 MERGED →0fb75700 |
| `studio-edit-pipeline` | `539d2007` | 2026-09-06 | no | #340 MERGED →1676393d |
| `studio-deal-deliverables` | `4176ba8c` | 2026-09-06 | no | #338 MERGED →ea465d90 |
| `studio-composite-feather` | `abab33e8` | 2026-09-06 | no | #343 MERGED →8502ecae |
| `studio-asset-viewer` | `675abda6` | 2026-09-06 | no | #342 MERGED →37b29923 |
| `studio-0038-deploy-block` | `db953997` | 2026-09-06 | no | #339 MERGED →a756dd88 |
| `studio-made-shelf-surface` | `5ff0d5e3` | 2026-09-05 | no | #336 MERGED →bb2366da |
| `studio-drop-inspiration-role` | `c60bea15` | 2026-09-04 | no | #329 MERGED →7b20d78a |
| `adi/studio-u3-mask-editor` | `93da85e9` | 2026-09-03 | no | #311 MERGED →bb6898df |
| `adi/studio-reference-gen` | `fff7b588` | 2026-09-03 | no | #312 MERGED →a45dd6c2 |
| `adi/studio-edit-orientation` | `59f61164` | 2026-09-03 | no | #314 MERGED →6ceb52cf |
| `adi/studio-u2-generation` | `4ae27fdf` | 2026-08-31 | no | #300 CLOSED; #291 MERGED →98210b1e |
| `adi/studio-u1-workspace` | `46d637e5` | 2026-08-30 | no | #286 MERGED →b0ff3d70 |
| `adi/studio-veo-sku` | `dc710b5e` | 2026-08-29 | no | #281 MERGED →94276fb1 |
| `adi/studio-precheck-content-model` | `fab8fc12` | 2026-08-29 | no | #280 MERGED →65719f03 |
| `adi/studio-deploy-migration` | `2a4fa67b` | 2026-08-29 | no | #279 MERGED →df1d9e52 |
| `adi/studio-campaign-concept` | `9b4681ca` | 2026-08-29 | no | #282 MERGED →378a386f |
| `adi/studio-brief-assembler` | `cfdf82de` | 2026-08-29 | yes (ancestor) | none (direct merge) |
| `adi/studio-vertex-adapter` | `76dc66fc` | 2026-08-27 | yes (ancestor) | none (direct merge) |
| `adi/studio-tab-shell` | `b04690d2` | 2026-08-27 | yes (ancestor) | none (direct merge) |
| `adi/studio-router` | `d53227b7` | 2026-08-27 | yes (ancestor) | none (direct merge) |
| `adi/studio-inventory-audit` | `a68e384b` | 2026-08-27 | yes (ancestor) | none (direct merge) |
| `adi/studio-cost-harness` | `931a4f22` | 2026-08-27 | yes (ancestor) | none (direct merge) |
| `adi/studio-athlete-context` | `f49cd6df` | 2026-08-27 | yes (ancestor) | none (direct merge) |

## C. Capability table — status · location · flag · CI vs execution

Side: **CI** = Creative Intelligence (what to make, why, for whom, when, tied to which Objective/Campaign/context);
**EXEC** = creative execution (given an approved intent/brief/reference, generate/edit/QA/publish); **SEAM** = contract/lineage
between the two (credited to neither).

Dev flag state: dev Cloud Run sets `STUDIO_ALL_ON=true` (`gcp/cloud-run-dev.yaml:425-426`; confirmed on the live service with
`gcloud run services describe nomila-v2`, revision `nomila-v2-00757-gs2`). Every boolean Studio flag reads through `studioFlag()`
(`server/studio/studioFlag.ts:32-36`). So **every boolean Studio flag is effectively ON on dev** unless its own line says `"false"`,
and none does. Prod sets `STUDIO_ENABLED="false"` (`gcp/cloud-run-prod.yaml:338-339`), so every Studio route returns 404 there.

Paths are on `9fff9b15` unless marked `[stack]` (= `3f0139f6`).

| # | Capability | Side | Impl · Location · flag | Evidence |
|---|---|---|---|---|
| 1 | Studio tab entry (Now · Made · Video · Board tabs; Create Anything; Agent door) | EXEC (surface) | BUILT · MAIN · `EXPO_PUBLIC_STUDIO_ENABLED`/`_AGENT`; eas `preview` sets `EXPO_PUBLIC_STUDIO_ALL_ON` · deployed-dev (preview build) | `client/screens/studio/StudioHomeScreen.tsx:159-176`; `eas.json:27` |
| 2 | Freeform athlete ask → edit/generate (Create Anything, sessions/threads) | EXEC | BUILT · MAIN · `STUDIO_SESSIONS`, `STUDIO_SERVER_ROUTING` | `server/routes/studioSessions.ts:109-231`; dev: 69 `studio_sessions`, 547 entries |
| 3 | Classifier + interpreter (parse her edit sentence into an op) | EXEC | BUILT · MAIN · `STUDIO_INTERPRETER` (+`NATIVE_EDIT`). Two guard fixes are UNMERGED (#567) | `server/studio/classify.ts:112-130`; `interpret/core.ts:1-18`; `interpret/transport.ts:70` (gemini-3.5-flash, T=0) |
| 4 | Concepts step (2–3 angle/feeling/line from the ask + sport + campaign) | CI (interprets a given ask) | BUILT · MAIN · `STUDIO_AGENT` | `server/studio/agent/concepts.ts:1-17,156`; blind-scored in S-1 (07 §4) |
| 5 | Direction tool `propose_campaign` (2–3 brief proposals from a closed objective code + brand + occasion + library) | CI (interpretation) | BUILT · MAIN · `STUDIO_BRAND_PROFILES` | `direction/propose.ts:153-160,303-311`; `gemini-3.1-pro-preview`, `config.ts:1374-1383` |
| 6 | `research_moment` ("why now" from a live Google-grounded search) | CI (context, ad hoc) | BUILT · MAIN · `STUDIO_DIRECTION_MOMENTS` (not counted by the day cap) | `direction/moment.ts:1-8,382-399`; its only athlete read is `athletes.sport` |
| 7 | Trend signal | CI | MISSING · MAIN (a stub that answers `available:false`) | `direction/trend.ts:2-6` |
| 8 | Fixtures / calendar ("when") | CI | MISSING · MAIN (the client stub returns `[]`) | `client/hooks/use-studio-pending.ts:294-297`; `scheduleLogic.ts` computes slots from fixtures only |
| 9 | Brief summarise (her PDF → CampaignBrief) | CI-intake | BUILT · MAIN · `STUDIO_BRAND_PROFILES` | `direction/routes.ts:443,480`; `config.ts:1347` |
| 10 | Brief carrier (the plan's brief → the job prompt) | SEAM→EXEC | BUILT · MAIN · `STUDIO_BRIEF_CARRIER`. Renders only tone/style/energy/aesthetic/concept/constraints, and only into **video** templates | `campaign/carrier.ts:59-94,175-217`; flow-eval census, `docs/probes/flow-eval.md` §2.1 |
| 11 | CampaignBrief `campaign-brief/1` (no athlete or campaign id, by design) | SEAM | BUILT · MAIN | `server/studio/campaign/brief.ts:15-17,44-224` |
| 12 | Planner (ask + objective code + library → ≤6 items of i2v/broll/clip/image/product, plus look, music, gaps) | CI (asset mix) + EXEC | BUILT · MAIN · `STUDIO_AGENT` | `agent/plan.ts:211-259` (9 doctrine rules), `:479-520`, `:847-856` (GEMINI.pro, T=0.6) |
| 13 | Plan memory / replan | EXEC | BUILT · MAIN (0066) | `studio_plans`, `shared/schema.ts:2187-2216`; `routes/studio.ts:2776-2860`; dev: 93 rows, all on the Studio engineer's test athlete |
| 14 | Reference decomposition + style-spec | EXEC (style) | BUILT · MAIN · `STUDIO_BRAND_PROFILES` / `STUDIO_STYLE_SPEC` | `reference/decompose.ts:1-18`, `styleSpec.ts:1-18`; dev: 7 `studio_reference_analyses` |
| 15 | Athlete media library + tagger fields + picker | EXEC | BUILT · MAIN · `STUDIO_LIBRARY_FIELDS` | `agent/library.ts:50-54,291,335,409`; `mediaList.ts:217-233` |
| 16 | Video enrichment / clip read | EXEC | BUILT · MAIN · `STUDIO_VIDEO_ENRICH`, `STUDIO_CLIP_READ`; enrich cap $5/day on dev | `enrich/videoTag.ts:334-337`; `enrich/config.ts:57-73` |
| 17 | Identity pack (10–15 photos, calibrated band, stranger control) | EXEC | BUILT · MAIN · `STUDIO_IDENTITY_PACK` | `identity/types.ts:8-9`, `calibrate.ts`, `profile.ts:3-12`; dev: 1 `identity_profiles` row (the engineer's test athlete), 0 for Mia |
| 18 | Identity preservation (reference ordering, per-model caps, Veo for people, preservation clause, reference gate) | EXEC | BUILT · MAIN. The provider enforces none of it | `refOrder.ts:34`; `config.ts:192-194,838-846`; `compile/preservation.ts`; `referenceGate.ts:1-22`; `types.ts:275-286` |
| 19 | Brand knowledge in Studio (athleteContext + brandContext in the image brief) | EXEC (context in execution) | PARTIAL · MAIN. The full brand row reaches only the flag-off single-photo path and the ad interpreter; Board and carousel send the name only | `brief.ts:858-931`; `compile/image.ts:122-123,160-167`; flow-eval §2.10 |
| 20 | Studio brand profiles (per-athlete brand memory) | CI-memory | DESIGNED/table-only · MAIN. `createBrandProfile` has no caller | dev: 0 `studio_brand_profiles`; flow-eval §2.10 |
| 21 | Product/brand media (product photos, logo marks) | EXEC | BUILT · MAIN (product referent, BRAND_MARK op, ad op) | `edit/ops.ts` (`STUDIO_EDIT_OPS`, `schema.ts:2240`); `classify.ts:112-130` |
| 22 | Image generate | EXEC | BUILT · MAIN · Vertex `gemini-3-pro-image` | `adapters/vertex.ts:184`; `config.ts:129-140`; dev: 548 `generation_jobs` in total |
| 23 | Image edit (masked composite, native full-frame, typed ops, image-ops text parser, mask editor) | EXEC | BUILT · MAIN · `STUDIO_NATIVE_EDIT`, `STUDIO_IMAGE_EDIT_OPS`, `STUDIO_IMAGE_OPS`, `*_MASK` | `composite.ts:1-40`; `nativeEdit.ts:156-196`; `edit/engine.ts:613`; `imageOps.ts:24-515`; `client/components/studio/MaskEditor.tsx` |
| 24 | Segmentation (SAM-3 via fal) / auto-mask (Gemini Flash boxes) | EXEC | BUILT · MAIN. Dev runs with **no `FAL_KEY`**, accepted by the ship ruling | `adapters/fal.ts:207`; `autoMask.ts:664-689`; `docs/probes/ship.md` "Masks" |
| 25 | Video i2v (identity shots) | EXEC | BUILT · MAIN · `STUDIO_VIDEO_ENABLED` · Vertex `veo-3.1-generate-001` | `adapters/vertex.ts:283,312`; `video/shotType.ts:81-89` |
| 26 | Video b-roll t2v | EXEC | BUILT · MAIN · OpenRouter `bytedance/seedance-2.0-fast`, 720p | `adapters/openrouter.ts:285,307`; `config.ts:191-204,247-254` |
| 27 | Transition (first/last frame) | EXEC | PARTIAL · MAIN. Kling v3.0 std is routed only when `lastFrame` is set, and `shotTypeFor` never reaches it | `config.ts:206-219`; `preview.ts:807-811` |
| 28 | Shot slots / ShotSpec / composer | EXEC | BUILT · MAIN · `STUDIO_COMPOSER` | `types.ts:213-231`; `server/studio/composerBoundary.test.ts:1-21` |
| 29 | Stitch (ffmpeg), stills in motion, captions, music beds | EXEC | BUILT · MAIN · `STUDIO_STITCH_BEDS_READY` | `stitchRunner.ts:225-347`; `video/stillMotion.ts:10`; `video/captionRender.ts:241`; `video/beds.ts:45`; dev: 47 stitch jobs, all succeeded |
| 30 | EditSpec | — | MISSING by design (edits carry `FrozenEditIntent`/`StudioEditOp`) | `campaign-creative-seam-checkpoint.md` §11 |
| 31 | Model routing | EXEC | BUILT · MAIN. A task→provider/model table; the capability tables do not choose models | `config.ts:121-221`; `router.ts:32-53`; `preview.ts:277-299` |
| 32 | Quote / approve spend / requote / caps | EXEC | BUILT · MAIN. Single-use priced preview (30 min), fresh requote at spend. Per-job cap: dev $30, prod $5, default $10. Rolling-day cap: default $25 | `previewStore.ts:57,88,117,263-278`; `spendCaps.ts:160-315`; `routes/studio.ts:1998-2012` |
| 33 | Output clearance (draft → approved/rejected) | EXEC | BUILT · MAIN | `approval.ts:47-145`; routes at `routes/studio.ts:3546-3611` |
| 34 | Creative QA (image: text/anatomy; edit: adds identity/marks/adherence; clip QA) | EXEC | BUILT · MAIN · `STUDIO_CREATIVE_QA`. **Observation only; gates nothing** | `qa/verdict.ts:20-24`; `generate.ts:1428-1446`; stored in `media_assets.metadata.creative_qa` (`qa/record.ts:47-89`) |
| 35 | Lineage (job ↔ asset ↔ edit preview ↔ QA ↔ cost line; made-here labels) | EXEC | BUILT · MAIN. The join runs only from a script or eval; no route serves it | `qa/join.ts:1-30,224-244`; `agent/provenance.ts:43-84`; `media_assets.generation_job_id` |
| 36 | Deal linkage (deal_deliverables) | SEAM | PARTIAL · MAIN. Table + read route, **no writer anywhere**. The id sits on the plan row only and never reaches the job or asset | `schema.ts:1519-1544`; `dealDeliverables.ts:83-88`; dev: 0 `deal_deliverables` |
| 37 | Publish to Instagram (video/Reels only, submit-once, approval-gated) | EXEC | BUILT · MAIN · `STUDIO_PUBLISH_MODE` (a value flag, **unset on dev and prod, so off**) + `IG_REQUEST_PUBLISH_SCOPE` | `publish/eligibility.ts:35,103-109`; `instagram.ts:53-54,330-335`; `runner.ts:263-317` |
| 38 | Scheduled posting ("post at T") | CI (when) + EXEC | MISSING. No `scheduled_at`; publish is immediate. "ship-sched" set up Cloud Scheduler ticks, not post scheduling | `publish/routes.ts:306-332`; client `scheduleLogic.ts` has no fixture feed |
| 39 | Carousel / image publish | EXEC | MISSING ("Only a video can be posted from here.") | `publish/eligibility.ts:108` |
| 40 | Outcomes / analytics on Studio-made posts | MEASURE | MISSING on main. EXPERIMENTAL · OPEN_PR [stack]: `published_asset_identities` (0075) + `observationsForAsset`; `attribution.ts` calls itself "experimental and unmounted"; 0 rows | `publish/runner.ts:141-146` [stack]; `outcome/publishedIdentity.ts:40-75` [stack] |
| 41 | CreativeIntent contract + store + athlete door (`request_creative`, `/studio/creative/intents`) | SEAM (CI entry) | BUILT · OPEN_PR [stack] #657 · `STUDIO_CREATIVE_INTENTS` (**effectively ON on dev via ALL_ON**, 07 §1) · 0 rows · no client UI | `creative/door.ts:31-41` [stack]; `mila/registry.ts:52` [stack]; `grep creativeIntent client/` finds nothing |
| 42 | CreativeIntent interpretation (`interpretCreativeIntent` → `proposeCampaign`) | CI | PARTIAL/broken in code · OPEN_PR [stack]. It passes her free-text `purpose` as `objective`; `readInput` rejects anything outside `BRIEF_GOALS`, so the result is `invalid_input` → HTTP 502. The test mocks `proposeCampaign` | `creative/interpret.ts:35` [stack]; `direction/propose.ts:157-160,309-311`; `server/routes/studio.creative.test.ts:18` |
| 43 | CreativeIntent → BriefInput → preview/job lineage | SEAM | BUILT · OPEN_PR [stack] | `creative/resolve.ts:38-63` [stack]; `jobs.ts:88-93` [stack]; dev: `generation_jobs.creative_intent_id` set on 0 of 548 |
| 44 | Campaign → CreativeIntent[] (on spec approval) | SEAM | BUILT · OPEN_PR [stack] · `STUDIO_CAMPAIGN_GOVERNANCE` (effectively ON on dev via ALL_ON, while Brain readiness reads raw `=== "true"` and reports it off). Campaigns come only from an operator script | `campaign/materialize.ts:26-48` [stack]; `routes/campaignGovernance.ts:53-59` [stack]; `brainLoopDurable.ts:86-104` [stack]; `executionReadiness.ts:56,68` [stack] |
| 45 | Recommendation / Objective / Opportunity / State content into Studio planning | CI | MISSING. No planner, concept or direction path reads them; only ids ride along, as provenance | grep of `server/studio/agent/*`, `direction/*`; `07-studio.md` §3 |
| 46 | Planner Commission → CreativeIntent | SEAM | DESIGNED/test-only · OPEN_PR [stack]. `intentFromCommission` has no non-test caller | `services/intelligence/creative/intents.ts:15-25` [stack] |
| 47 | Flow census + plan/concept evals | EXEC (quality harness) | BUILT · MAIN · test-harness-only / scripts; results kept as ledgers | `server/studio/agent/eval/**`; `docs/probes/flow-eval.md`, `plan-eval.md` |
| 48 | Acceptance harness (106 cells) | EXEC (quality harness) | BUILT · UNMERGED_BRANCH · PR #507 OPEN | `origin/studio/acceptance-harness:server/scripts/studioAcceptance.ts` |

**Tally.** Rows are counted by side. The SEAM rows (10, 11, 36, 41, 43, 44, 46) and row 30 are credited to neither side.
- **EXEC and quality-harness rows (29):** 25 BUILT on MAIN (counting rows 12 and 38 on this side too) · 2 PARTIAL (brand knowledge, transition) · 1 MISSING (carousel/image publish) · 1 on an UNMERGED branch (acceptance harness). Scheduled posting's execution half (row 38) is also MISSING.
- **CI rows (11, counting rows 12 and 38 on this side too):**
  - 5 BUILT on MAIN, all of the *interpretation / asset-mix* kind: concepts, propose_campaign, research_moment, summarise, planner asset mix. Each starts from an ask or objective code the athlete supplies.
  - 1 table only (brand profiles).
  - 4 MISSING: trend, fixtures (the "when"), scheduled posting, and Brain/Objective/State content in planning.
  - 1 broken in code on the stack: CreativeIntent interpretation.
