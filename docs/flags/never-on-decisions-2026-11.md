# Never-on flags: decision list (2 Nov 2026)

**What this is.** Every on/off flag that is off or unset in `gcp/cloud-run-dev.yaml`, `gcp/cloud-run-prod.yaml`, on both
live Cloud Run services (`nomila-v2`, `nomila-v2-prod`, read 2 Nov 2026) and in every shipping `eas.json` profile
(development, preview, production). Nothing here changes code. Each row says what the flag gates in plain words, when
it was added, whether work is moving on it, which owner rule applies, and my recommendation:

- **KEEP**: Studio (owner rule: keep all Studio), new-but-off work (owner rule, 25 Oct: keep new-but-off), a safety or
  emergency switch, or a switch waiting on an outside party.
- **DELETE**: decided legacy or a dead switch; deleting it removes the flag and its never-run branch.
- **DECIDE**: needs the owner's call (usually "turn it on, or delete it").

Source list: the catalogue generator from #1178 (`npm run catalogue`, status `never-on`, 40 flags), re-derived against
main `752fd1a5` and the live services. "Added" is the first commit on main that introduced the name (`git log -S`).
"Recent" counts commits on main since 19 Oct that touch the name; open PRs are named where one exists.

## Corrections to the catalogue's never-on list (read this first)

Ten of the 40 are **not actually off** in dev and prod:

| Flag | Why it is really on |
|---|---|
| STUDIO_ENABLED, STUDIO_VIDEO_ENABLED, STUDIO_SERVER_ROUTING, STUDIO_NATIVE_EDIT, STUDIO_DISPLAY_TEXT, STUDIO_GARMENT_MASK, STUDIO_BACKGROUND_MASK, STUDIO_OBJECT_MASK | Read through `studioFlag()` (server/studio/studioFlag.ts): with `STUDIO_ALL_ON="true"` (set in both yamls and both live services) every such flag is on unless its own variable is exactly `"false"`. Unset means ON in dev and prod. |
| STUDIO_VIDEO_FRAME_CROP | Its default is ON: only the exact value `"false"` turns it off (server/studio/videoRunner.ts). |
| EXPO_PUBLIC_WEB_V2 | Not in eas.json, but `.github/workflows/deploy-web-dev.yml` and `deploy-prod.yml` set it to `true` for the web builds. On for the web app, off for native builds. |

The catalogue generator should learn the `studioFlag` master and the workflow-set client env (follow-up to #1178).

Two flags the catalogue did not count here belong on the list: `INTELLIGENCE_REQUESTS_V1` (in the dev yaml as `"false"`,
read by nothing since the 25 Oct cleanup) and `MILA_CHAT_MINIMAL` (read by server/mila/chatMinimal.ts, set nowhere).
`CANONICAL_CONTEXT_READERS` is a list, not a boolean, but it is empty everywhere and goes with `CONTEXT_SHADOW`.
`OAUTH_BROWSER_BINDING` is unset everywhere but its default is ON (it is an emergency off switch), so it is not never-on.

## The list

### Server

| Flag | What it gates, in plain words | Added | Recent / in progress | Rule | Recommendation | Done 2 Nov |
|---|---|---|---|---|---|---|
| ADMIN_OPEN_ACCESS | Lets ANY signed-in user into the admin dashboard (the launch posture before roles existed). The server already refuses to boot in production with it on (server/lib/envGuards.ts). | 21 Jun (#10) | 2 (prod yaml declarations, 24–25 Oct) | decided legacy | **DELETE**: an open-admin backdoor that must never be used again; roles are the only gate. | **Deleted** (flag, requireAdmin branch, /admin/me openAccess, dashboard banner and the prod env guard: no code path can open admin) |
| AGENT_DOCUMENTS_CARD | Mila sends the new `document` card instead of the existing `ready` card after making a document. Waiting on the card's design; no client draws it yet. | 23 Oct | 1 | new-but-off | **KEEP** | – |
| AGENT_POST_KIT_CAPABILITY_BLOCK | Post kits are matched by the Studio capability layer's block (no fixed look or music list in the prompt). | 12 Oct | 1 (golden test, 2 Nov) | Studio | **KEEP** | – |
| AGENT_POST_KIT_MUSIC_CHOICES | A post kit offers three suggested tracks from the free music library. | 12 Oct | 0 | Studio | **KEEP** | – |
| AGENT_RESEARCH_REFRESH_COHORT | The daily research-refresh sweep over every athlete (paid; bounded by run/day caps). The one-athlete refresh is separate. | 13 Oct | 2; open PRs #1071, #1073, #1075, #1077 (refresh v2) | new-but-off, cost switch | **KEEP** | – |
| CONTEXT_SHADOW | A reader not yet moved to the canonical context also builds the new view and logs a diff (no behaviour change). Goes with `CANONICAL_CONTEXT_READERS` (empty everywhere). | 11 Sep (#410) | 1 | Phase A Step 2d migration, never advanced | **DECIDE**: the reader migration has not moved since September; lean DELETE both, unless Step 2d is still planned. | **Deleted** with CANONICAL_CONTEXT_READERS (context/config.ts and every listed/shadow reader branch; the builder, views and pure diff stay) |
| DEALS_PARTITION_FLASH | The deal engine's same-deal partition (grouping, opportunity placement, new-subject branch) runs on Gemini Flash instead of the retired Kimi model. Its sibling DEALS_SUMMARY_FLASH has been on everywhere since October. | 12 Oct | 1 | new-but-off | **DECIDE**: with Kimi end-of-life, the off branch may already fail and fall back to "unsplit"; lean turn it ON in dev after the parity eval (server/scripts/deals/evalDealEngineParity.ts), then retire it. | **ON in dev** (dev yaml; prod off, added to the prod flag guard). Offline tests green (dealEngineModels, dealGrouping); the live parity eval is NOT run: follow-up before the Kimi retirement |
| ENABLE_TEST_PAGE | Serves an internal test page from the API (also refused when NODE_ENV=production). | 29 May | 0 | decided legacy | **DELETE** | **Deleted** (GET /test, GET /paytest, the /paytest harness and both pages) |
| ENABLE_VOICE_WEB_DEMO | The August web-voice demo token route, superseded by MILA_VOICE_WEB the next day. | 9 Aug | 0 | decided legacy | **DELETE** | **Deleted** (GET /voice demo page, its CSP, mila-voice.html; POST /voice/token stays) |
| IDENTITY_ENTAILMENT_ENABLED | Identity Intelligence check 8: a second model checks each claim is entailed by its evidence. The interface is a stub; nothing was ever built behind it. | 2 Oct (#739) | 0 | dead stub | **DELETE** (re-add with the real check if it is ever built) | **Deleted** (the check-8 stub and its type) |
| JOIN_WAITLIST | Dev's join flow: agent-front sign-ups are created `waitlisted` instead of `raw`. Prod uses WAITLIST_ALL_SIGNUPS (every door) instead. | 23 Oct | 8 | new-but-off | **DECIDE** with WAITLIST_ALL_SIGNUPS (see "The inverted flag"): lean DELETE, since prod's broader switch replaced it. | **Deleted** (sign-up status, let-in gate, onboarding front and App.tsx join-flow branches); dev sign-ups stay `raw`; WAITLIST_ALL_SIGNUPS kept |
| LOCAL_BACKGROUND_WORK | A developer's local server may run shared background work (workflow steps, Studio video jobs) against the dev database. Documented in CLAUDE.md. | 23 Oct | 1 | developer switch, not a feature flag | **KEEP** | – |
| MAILBOX_ZERO_RETENTION | Email ingest keeps no body or subject, only ids, hashes and derived fields (CASA / launch trust invariant). Also turns on MILA_CHAT_MINIMAL's behaviour. | 7 Oct | 0 | new-but-off, privacy | **KEEP** (a launch-compliance decision, not a cleanup) | – |
| MILA_CHAT_MINIMAL *(extra)* | The old Mila loop stores chat rows minimally (tool rows stubbed, long quotes trimmed, draft bodies not stored). Interim twin of MAILBOX_ZERO_RETENTION. | Oct | 0 | old loop | **DELETE** once MAILBOX_ZERO_RETENTION is decided (it reads either). | Kept (waits on MAILBOX_ZERO_RETENTION) |
| MIA_FACTS_NO_EVIDENCE_ECHO | The Gemini facts-only M.I.A. evaluator uses prompt 0.6.0 (no evidence echo; a cost cut). "Dev only until its equivalence check passed", but never set in dev. | 23 Oct | 4 | new-but-off | **KEEP** (or DECIDE to run its equivalence check) | – |
| MILA_FUZZY_BRAND | An incident switch: when an exact brand lookup finds nothing, voice deal lookups may try a fuzzy match (never for drafts). | 10 Aug | 0 | old voice path | **DECIDE**: lean DELETE; never needed in three months. | **Deleted** (voice deal resolver exact-match only, which is what ran live; server/voice/brandMatch.ts had no caller and was deleted 3 Nov 2026: the agent deal tools use agent/deals/map's own brandMatches) |
| MILA_WEB_SEARCH | The OLD Mila loop (server/mila/loop.ts) gets Gemini web-search grounding. The new agent's chat does not read it. | 2 Aug | 0 | old loop | **DELETE** (with the old loop; see the AGENT_V3 retirement in this PR) | **Deleted** (the old loop's Gemini grounding: tool, prompt guidance, accumulator, done fields); the old loop stays |
| MONTHLY_REENRICH | The monthly legacy re-research of every athlete (old `researchAthlete`, outside the daily cap). Switched off on purpose 24 Oct. | 24 Oct (as a flag) | 1 | decided legacy | **DELETE** (the cron branch and the flag; research refresh replaces it) | **Deleted** (the monthly cron branch; the reEnrichAthletes skill stays) |
| MUSIC_ALLOW_ATTRIBUTION_TRACKS | Post-kit music may offer tracks that need a credit line (CC BY / BY-SA). Owner decision M2: not for now. | 12 Oct | 0 | Studio, owner hold | **KEEP** | – |
| OBJECTIVES_V1 | The Objective review surface on My Intelligence (pairs with EXPO_PUBLIC_OBJECTIVES_V1). Dev yaml "false", prod unset. | 23 Sep | 2 (25 Oct legacy cleanup touched it) | Checkpoint-era work, surface never shipped | **DECIDE**: lean DELETE with its client twin unless Objectives come back in the Plan. | **Deleted** with EXPO_PUBLIC_OBJECTIVES_V1 (Objective review screen, its doors and route, the My Intelligence goals bridge); data tables kept |
| ONBOARDING_STATE_AFTER_CONVERSATION | The onboarding turn puts STATE after the conversation (better prompt caching; a cost cut). | 23 Oct | 3 | new-but-off | **KEEP** | – |
| ONBOARDING_V3 | New workflow-onboarding runs start on v3 (the identity guard first). The workflow onboarding is the pre-agent path; the agent onboarding is now always on. | 11 Sep (#426) | 9 | legacy workflow onboarding | **DECIDE**: lean DELETE (v2 stays the start version) unless the workflow onboarding is still a planned path. | **Deleted** (flag and the v3 definition: dev workflow_runs has no onboarding v3 rows, read-only 2 Nov); v2 stays the start version |
| OUTLOOK_PUSH | Microsoft Graph change notifications as a "sync now" signal for Outlook mailboxes. Waits on the Azure setup. | 6 Oct | 0 | new-but-off | **KEEP** | – |
| PARTNER_INBOUND_MAIL | Partner-door notices carry a reply-to and the partner mailbox is polled for replies. | 10 Oct | 0 | new-but-off | **KEEP** | – |
| PHOTO_CUTOUT_V1 | The cover photo of a brand book / Nomi Card / public page uses her cut-out on the look's ground (when a body mask exists). | 21 Oct | 1; PR #975 (photo cut-out, paused) | new-but-off | **KEEP** | – |
| SHOP_SHOPIFY_APP | The catalog-only Shopify app: its routes, webhook, reconcile cron and "From your brands" (needs SHOP_V1). | 7 Oct | 0 | new-but-off | **KEEP** | – |
| STUDIO_DIALECTS | Studio governance flag: the target manifest's payload check and the Seedance b-roll dialect (never reached by STUDIO_ALL_ON; waits on a walk-through). | 28 Sep | 2 (25 Oct keep-all-Studio) | Studio | **KEEP** | – |
| STUDIO_ENABLED, STUDIO_VIDEO_ENABLED, STUDIO_SERVER_ROUTING, STUDIO_NATIVE_EDIT, STUDIO_DISPLAY_TEXT, STUDIO_GARMENT_MASK, STUDIO_BACKGROUND_MASK, STUDIO_OBJECT_MASK | Studio itself, video, server-side edit routing, full-frame native edits, headline text, and the garment / background / object masks. **On in dev and prod via STUDIO_ALL_ON.** | 27 Aug – 18 Sep | 2 each (25 Oct) | Studio | **KEEP** | – |
| STUDIO_VIDEO_FRAME_CROP | Studio video sends the cropped first frame. **Default on.** | 20 Sep | 2 (25 Oct) | Studio | **KEEP** | – |
| TIKTOK_DEMOGRAPHICS_ENABLED | Requests TikTok's `creator_info` scope and audience demographics. Waits on TikTok's scope review (an unapproved scope can fail the whole authorization). | 30 Jun (#29) | 0 | waits on an outside party | **KEEP** | – |
| VOICE_GRANT_ENFORCE | Internal voice routes REQUIRE the per-session, athlete-bound grant (today the shared worker secret alone is enough, which is an all-athletes key). | 7 Oct | 0 | security hardening never switched on | **DECIDE**: lean turn it ON (dev first, then prod) and then retire the flag, not delete the check. | **ON in dev** (dev yaml; prod off, added to the prod flag guard). mila-voice sends `x-voice-grant` on all 16 internal calls; dev observe mode logged zero grant failures (30 days) |
| INTELLIGENCE_REQUESTS_V1 *(extra)* | Nothing: the reader was deleted in the 25 Oct legacy cleanup; only the dev yaml line (`"false"`) is left. | 28 Sep | 1 | dead | **DELETE** (the yaml line) | **Deleted** (the dev yaml line) |

### Client (EXPO_PUBLIC_*)

| Flag | What it gates | Added | Recent | Rule | Recommendation | Done 2 Nov |
|---|---|---|---|---|---|---|
| EXPO_PUBLIC_OBJECTIVES_V1 | The Objective review door on the Brand tab and its screen (pairs with OBJECTIVES_V1). Preview "false". | 23 Sep | – | as OBJECTIVES_V1 | **DECIDE** with OBJECTIVES_V1 | **Deleted** with OBJECTIVES_V1 (flags.ts, eas.json preview) |
| EXPO_PUBLIC_SHOP_SHOPIFY_APP | "From your brands" on My Picks (pairs with SHOP_SHOPIFY_APP; needs SHOP_V1). | 7 Oct | – | new-but-off | **KEEP** | – |
| EXPO_PUBLIC_WEB_V2 | Dev/prod web parity: shareable URLs, the phone-width column, same-tab connects, web push. **On for the web builds** (set by the deploy workflows). | 17 Oct | 3 | live on web | **KEEP** (not never-on) | – |

## Done 2 Nov 2026 (owner: "go with your recommendation")

PR `chore/never-on-flag-decisions` carries every DELETE and DECIDE above as recommended: ADMIN_OPEN_ACCESS,
ENABLE_TEST_PAGE, ENABLE_VOICE_WEB_DEMO, IDENTITY_ENTAILMENT_ENABLED, MILA_WEB_SEARCH, MONTHLY_REENRICH,
INTELLIGENCE_REQUESTS_V1, JOIN_WAITLIST, ONBOARDING_V3, OBJECTIVES_V1 + EXPO_PUBLIC_OBJECTIVES_V1, CONTEXT_SHADOW +
CANONICAL_CONTEXT_READERS and MILA_FUZZY_BRAND are deleted; DEALS_PARTITION_FLASH and VOICE_GRANT_ENFORCE are ON in the
dev yaml only and guarded in prod (scripts/prod-flag-guard.ts). MILA_CHAT_MINIMAL stays until MAILBOX_ZERO_RETENTION is
decided. Follow-ups: run the live deal-engine parity eval with the owner before Kimi retires; then switch both new dev
flags on in prod deliberately and retire them.

## Summary

Of the 40 the catalogue listed: KEEP 26, DELETE 6, DECIDE 8 (plus two extras to DELETE).

- **KEEP: 26**: AGENT_DOCUMENTS_CARD, AGENT_POST_KIT_CAPABILITY_BLOCK, AGENT_POST_KIT_MUSIC_CHOICES,
  AGENT_RESEARCH_REFRESH_COHORT, LOCAL_BACKGROUND_WORK, MAILBOX_ZERO_RETENTION, MIA_FACTS_NO_EVIDENCE_ECHO,
  MUSIC_ALLOW_ATTRIBUTION_TRACKS, ONBOARDING_STATE_AFTER_CONVERSATION, OUTLOOK_PUSH, PARTNER_INBOUND_MAIL, PHOTO_CUTOUT_V1,
  SHOP_SHOPIFY_APP, the ten STUDIO_* flags, TIKTOK_DEMOGRAPHICS_ENABLED, EXPO_PUBLIC_SHOP_SHOPIFY_APP, EXPO_PUBLIC_WEB_V2.
- **DELETE: 6**: ADMIN_OPEN_ACCESS, ENABLE_TEST_PAGE, ENABLE_VOICE_WEB_DEMO, IDENTITY_ENTAILMENT_ENABLED, MILA_WEB_SEARCH,
  MONTHLY_REENRICH; plus the extras MILA_CHAT_MINIMAL (after MAILBOX_ZERO_RETENTION is decided) and INTELLIGENCE_REQUESTS_V1.
- **DECIDE: 8**: CONTEXT_SHADOW (+ CANONICAL_CONTEXT_READERS), DEALS_PARTITION_FLASH, JOIN_WAITLIST, MILA_FUZZY_BRAND,
  OBJECTIVES_V1, EXPO_PUBLIC_OBJECTIVES_V1, ONBOARDING_V3, VOICE_GRANT_ENFORCE (seven decisions: the two OBJECTIVES flags
  go together).

## The inverted flag

**WAITLIST_ALL_SIGNUPS**: `"true"` in the prod yaml and on the live prod service, unset (off) in dev. Added 24 Oct
(owner decision): every new account, from every door, joins the waitlist in production; admin promotion lets people in.

Recommendation: **KEEP** it. It is the launch gate for production, and it is meant to differ from dev (dev must stay open
for testing). Two small follow-ups: write `WAITLIST_ALL_SIGNUPS: "false"` explicitly in the dev yaml so the difference is
on the page, and retire it together with JOIN_WAITLIST on the day the waitlist ends (one decision, one PR).
