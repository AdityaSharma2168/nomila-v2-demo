# Mila voice — feedback triage (mila-37)

Investigation only, no code changed. Branch `adi/mila-37-voice-feedback`.

Two repos are in play:

- `nomila-v2` — the internal voice routes (`server/voice/*`), mounted at `/api/internal/voice`.
- `/Users/adi/mila-voice` — the LiveKit worker. This is where the voice model, the
  system prompt, and the tool registry live. Most of the "Mila doesn't know X"
  findings resolve here, not in the backend.

## The one-paragraph version

The voice path is deliberately **enum-and-number only**. Every voice route
allow-lists its response field by field and drops all free text, because the
consumer is a TTS layer that reads whatever it receives aloud verbatim — so
brand-authored email text and web-derived brand copy are structurally excluded
(`dealRoutes.ts:20-26`, `brandBriefRoute.ts:73-80`, `dealBriefRoute.ts:36-43`).
Almost every Group A complaint is that boundary working as designed. The data
exists; it is held back on purpose. Separately, the voice worker registers only
**four** tools — `get_score`, `open_draft`, `list_deals`, `get_deal_brief`
(`agent.ts:673-816`) — so the athlete profile, the rate card, and brand research
are not merely thin, they are absent.

## Registered voice tools vs. text-chat tools

| Tool | Text chat | Voice |
|---|---|---|
| `get_score` | ✅ | ✅ |
| `list_deals` | ✅ | ✅ |
| `get_deal_brief` | — | ✅ |
| `open_draft` | (as `draft_reply`) | ✅ |
| `get_profile` | ✅ | ❌ |
| `get_rate_card` | ✅ | ❌ |
| `get_brand` (web research) | ✅ | ❌ |
| `get_brand_fit` | ✅ | ❌ |
| `get_deal` | ✅ | ❌ (exported, unregistered) |
| `get_brand_brief` | — | ❌ (exported, unregistered) |
| `get_analytics` | ✅ | ❌ |
| `list_tasks_threads` | ✅ | ❌ |

`get_deal` and `get_brand_brief` are exported, tested and served — only the
registration line was removed (`agent.ts:812-815`), so re-adding either is one line.

---

# GROUP A — deal & brand details

## 1. Deal ask should auto-give summary + deliverables + comp

**Root cause.** `get_deal_brief` → `POST /athletes/:id/deal-brief` →
`toBriefDeal()` (`server/voice/dealBriefRoute.ts:159`). It allow-lists to:
`dealId, brand, amount, status, dealType, detectedAt, verdict, scoreNumeric,
hasThread, fitBand, sportFit, audienceFit, brandTier, recommendation,
recommendationConfidence, urgency, economicsState, hasRedFlag, exclusivity,
brandRelevance, rateComparison, deliverableScope`.

No summary text. No deliverable list. One integer for comp. The header
(`dealBriefRoute.ts:36-43`) states the rule: this surface reaches TTS, so free
text cannot cross.

**Data present?**

- **Summary — YES, but untrusted.** `deals.raw_data.summary` (written from
  `cls.summary`, `dealDetector.ts:1199`), `inbox_threads.summary`, and
  `conversation_state.conversation_state` ("one-sentence what's happening now").
  All three are model-written *from brand email*, i.e. attacker-controlled.
- **Deliverables — YES.** See item 3.
- **Comp — PARTIALLY, and there is a bug.**

> ⚠️ **Correctness issue found incidentally.** The wire's `amount` comes from
> `deals.amount`. `server/lib/dealVoice.ts:14-17` names this as money-safety
> invariant #1: *"NEVER speak `deals.amount`. It goes stale (we saw $200 on a deal
> whose live offer was $950)."* The live structured comp is
> `inbox_threads.conversation_state.key_details.offer_struct` —
> `{ amount, unit, deliverable_counts, recurring, commission_pct }`. The voice
> path reads the field that module forbids speaking, and speaks it. This is
> independent of the feature ask and worth confirming against a real deal.

`server/lib/dealVoice.ts` is a dependency-free, money-safe composer that already
solves this shape (`composeDealVoice(deal, thread)`, plus
`assertNoUnbackedFigures()`). It is pure — no db, no model, no clock — so calling
it from Mila's own code is reuse, not a shared-code change.

**Effort:** M — structured half (`offer_struct`) only. L if you want the prose summary,
which needs an app-side narrator or a sanitizer.
**Injection-relevant:** YES, high. This is the exact boundary the route exists to hold.
**Type:** code (wire widening) + prompt.

## 2. Deal SCORE + the "why"

**Root cause: not data — the prompt.** Everything needed is already on the wire:
`scoreNumeric` (1–10, range-validated), `verdict`, `fitBand`, `sportFit`,
`audienceFit`, `brandTier`, `recommendation`, `recommendationConfidence`, and the
four term grades.

The `get_deal_brief` tool description forbids saying it out loud:

- *"never by reading the number, the field names, or the words 'rating', 'score'
  or 'fit band' out loud"*
- *"NEVER NARRATE THE MACHINERY … Never say 'verdict', 'score', 'recommendation',
  'rating', 'grade', or 'the system says'."*

Mila is complying. The "why" is meant to surface as prose ("exact sport match,
premium brand"); if it lands thin, that is prompt adherence, not missing data.

> ⚠️ **Decision needed, not a bug fix.** The ban is deliberate — it exists to stop
> "the deal has a pretty low verdict and recommends rejecting it", i.e. the scoring
> pipeline read aloud at the athlete. Suggested middle: permit the number **only on
> an explicit ask** ("what's the score on that one"), keep the ban on unprompted
> narration.

**Data present:** YES, fully, already on the wire.
**Effort:** S. **Injection-relevant:** NO. **Type:** prompt-only.

## 3. Deliverables default to "social post" ← clearest root cause on the list

`dealBriefRoute` returns `dealType: str(row.deal_type)` ← `deals.deal_type` ←
`categoryToDealType(cls.category)` (`server/skills/dealDetector.ts:1184-1193`):

```
PAID       → "social_post"
MEDIA      → "appearance"
EDITORIAL  → "other"
GIFTING    → "other"
SCHOOL_NIL → "other"
default    → "other"
```

Every paid deal is literally the string `social_post`. That is the generic string
Mila is reading.

**Data present? YES — two sources, neither reaching voice:**

1. `deals.raw_data.deliverables` — `string[]` from the classifier
   (`dealDetector.ts:1203`), e.g. `["3 Instagram reels", "2 stories"]`.
   **Free text from email → untrusted.**
2. `inbox_threads.conversation_state.key_details.offer_struct.deliverable_counts`
   — `Record<string, number>`, e.g. `{reels: 2, posts: 3, stories: 4, videos: 1}`
   (`threadSummarizer.ts:43`). **Structured: numbers keyed by a small vocabulary.**

Source 2 is both the safe one and the better answer — "two reels and three
stories" beats "a social post".

**Effort:** S–M. **Injection-relevant:** LOW via source 2 (clamp keys to an
allow-list, clamp values to positive ints); HIGH via source 1.
**Type:** code (wire) + prompt.

## 4. Brand details don't surface

**Root cause.** On the deal branch `get_deal_brief` returns only
`brandKnowledge: "full" | "thin"` plus, when precomputed, `reasons` (three
app-generated narrative angles: audience / credibility / whitespace). Every
enriched field is dropped at the wire.

Held in `inbox_brands` (per the gorjana row) and **never crossing**: `description`,
`category`, `brand_tier`, `audience_summary`, `sport_categories[]`,
`known_athlete_partnerships[]`, and the `enrichment` jsonb — `brand_values`,
`content_style`, `recent_campaigns[]`, `product_categories[]`,
`partnership_style`, `competitors[]`, `markets[]`, `industry`.

Reason at `brandBriefRoute.ts:73-80`: web-derived → attacker-influenceable.
`get_brand` wraps these in `<external_content>` for the chat model, but *"that is a
PROMPT construct — it means nothing over HTTP and a TTS layer would read it aloud
verbatim."*

Your three sub-asks map cleanly: **(a) via web search** → item 6, doesn't exist on
voice; **(b) via ingest enrichment** and **(c) stored info** → both present, both
blocked at the wire.

**A second, non-obvious cause.** `reasons` only exists for pairs already
backfilled into `brandFitStore`. Per your own notes only 1/22 athletes has a
connected snapshot, so most brand asks land on the **cold path** = enum only, and
fill-for-next-time. That alone would make brand answers feel empty even with the
wire unchanged. Worth measuring coverage before widening anything.

**Risk ladder if you widen it:**

| Field | Value spoken | Risk |
|---|---|---|
| `brand_tier` | med | ~none — already a validated enum (`TIERS`, `getDeal.ts:68`) |
| `sport_categories[]` | med | low — small vocabulary, allow-listable |
| `known_athlete_partnerships[]` | **high** | moderate — names; sanitizable like `voiceSeed.ts safeName()` |
| `product_categories[]`, `partnership_style` | med | moderate — short, enumerable-ish |
| `description`, `audience_summary`, `brand_values`, `recent_campaigns[]` | **highest** | **highest** — free paragraphs, straight to TTS |

**Effort:** M (structured fields) / L (prose — needs a sanitizer or app-side narration).
**Injection-relevant:** YES — the largest surface on the list.
**Type:** code + policy decision.

## 5. Weak sense of the athlete's own brand / values

**Root cause.** There is no profile tool on the voice path at all. The four
registered tools are `get_score`, `open_draft`, `list_deals`, `get_deal_brief`.
No `get_profile`, no `get_rate_card`. There is also no
`/api/internal/voice/athletes/:id/profile` route to call.

`voiceSeed` does not carry it either — it is purely prior-session recall (deals
discussed, brands discussed, open topics), and injects nothing on a first session.

**Data present? YES, and it is the cleanest data on the list.**
`server/mila/tools/getProfile.ts` already returns `full_name, sport, school,
division, conference, segment, status, plan, goal_archetype, secondary_goals,
brand_voice`, plus connected platforms. All athlete-set or app-owned — **not**
web-derived, **not** email-derived. `get_rate_card` exists for rates.

> Note the standing inconsistency: the `get_deal_brief` description leans on
> *"The money grade is measured against HER OWN RATE"*, but the worker has no rate
> tool, so Mila can never actually say what that rate is.

Work required: one internal voice route (mirror `scoreRoute.ts`), one worker tool,
prompt lines. No new data plumbing and no new risk class.

**Effort:** M. **Injection-relevant:** NO. **Type:** new capability (but all
existing pieces).

---

# GROUP B — voice mechanics

## 6. Web search "not working" in voice

**Root cause: it does not exist on the voice path.** Not wired, not erroring —
absent. `get_brand` is a text-chat tool; it calls `getOrResearchBrand` →
`researchBrand`, which uses Gemini Google Search grounding
(`server/skills/researchBrand.ts:56`, `tools: [{ googleSearch: {} }]`). The voice
worker never registers it, and every voice brand route is documented cache-only
with no import path to `services/brandIntel` or `skills/researchBrand`.

**And the prompt instructs her to deny it.** From the `get_deal_brief` description:
*"Do NOT offer to look them up, pull their profile, research them, dig into them,
check again, or find them another way. THERE IS NO LOOKUP."* That is why it reads
as broken rather than missing.

**Feasibility — better than expected.** The LiveKit Google plugin supports it on
the realtime model:

- `geminiTools?: LLMTools` is an option on `RealtimeModel`
  (`agents-plugin-google/dist/realtime/realtime_api.d.ts:183-185`)
- a `GoogleSearch` tool class ships with the plugin (`dist/tools.d.ts:7`)
- `buildConnectConfig()` merges `geminiTools` with the function tool context
  (`dist/realtime/realtime_api.js:970-976`), so grounding and function calling coexist

Roughly `geminiTools: [new google.GoogleSearch()]`.

> ⚠️ **This is the single most injection-relevant change available.** Native
> grounding injects arbitrary retrieved web text directly into the live model's
> context. It does not pass through your tool boundary, so it **cannot** be wrapped
> in `<external_content>`, and it is spoken aloud. One line bypasses the guarantee
> every voice route was built to hold — *"Not one character of external text crosses
> this boundary"* (`dealRoutes.ts:24-26`).

**Boundary-preserving alternative:** a server-side `research_brand` voice tool
calling the existing `getOrResearchBrand` and returning only allow-listed
structured fields. Same discipline as everything else — but ~35s (per the
`brandBriefRoute` header), so it needs a filler/async story, and that machinery was
deliberately deleted for documented reasons (`agent.ts:115-158`).

**Effort:** S (native grounding, high risk) / L (safe route, re-opens async-tool problems).
**Injection-relevant:** MAXIMUM. **Type:** new capability + policy decision.

## 7. Goes silent instead of asking for clarification

Two distinct causes — worth not conflating:

**(a) Prompt.** There is no instruction anywhere in `MILA` or the tool descriptions
to ask a clarifying question. The prompt pushes the opposite: *"STOP THERE"*,
*"say plainly you don't have it"*, *"Saying you have nothing is a complete answer"*.
Nothing covers "if you're unsure what they mean, ask".

**(b) Code / model.** Per your memory note: silent `MALFORMED_FUNCTION_CALL` on
terse deal asks — intermittent, model-side, kills the turn with no error and no
crash. `get_deal_brief` was built to reduce it by removing the id argument, and the
header is explicit that this is *"a by-construction fix for the SHAPE of the
problem; it is NOT a verified fix for the MALFORMED fault itself"*
(`dealBriefRoute.ts:20-24`).

So some silences are prompt, some are the model dropping the turn. A prompt edit
fixes (a) only; (b) needs a turn watchdog in the worker — detect a turn that ended
with no audio and no tool result, then generate a recovery reply.

**Effort:** S for (a), M for (b). **Injection-relevant:** NO.
**Type:** prompt-only (a) + code (b).

## 8. Barge-in — she keeps talking

**Root cause: one line.** `mila-voice/src/agent.ts:106`

```ts
activityHandling: 'NO_INTERRUPTION'
```

Its own comment: *"Detected activity no longer aborts a turn that is already
playing."* That is barge-in, switched off.

**Why it's there.** She was interrupting *herself*. Her audio returned through the
speakers, Gemini's server-side VAD called it a user turn, and Gemini started a
replacement generation — 3–4 stacked restarts with nobody else in the room.
Nothing client-side can veto that: `interruptByAudioActivity` early-returns for any
RealtimeModel with server-side turn detection, so the framework's own `minWords`
gate and false-interruption pause/resume never run for this setup.

**Feasibility — the preconditions have since been removed.** Two of the three
things `NO_INTERRUPTION` was compensating for are already fixed by other means:

1. The largest cause of restarts was the backgrounded-tool double delivery
   (`updateChatCtx` auto-reply + `deliverReply`, two deliveries of one answer).
   Per `agent.ts:83-89` that path is now **unreachable** — every tool is blocking.
2. The echo settings (`START_SENSITIVITY_LOW` + `prefixPaddingMs: 300`) were
   **measured** taking a session from several spurious input transcripts to
   **zero** (`agent.ts:77-81`).

Plus `noiseCancellation: audioEnhancement({ model: 'quailVfS' })` on input
(`main.ts`). So the setting is plausibly vestigial.

Honest caveat: this is an empirical question, and it must be tested **on speakers,
not headphones** — that is the configuration that produced the original failure.
Rollback is reverting one enum.

**Effort:** S to attempt, M to validate. **Injection-relevant:** NO. **Type:** code (config).

## 9. Loading indicator while the draft widget generates

**Root cause: the indicator already exists.** `client/components/mila/MilaReplyWidget.tsx:154-214`
renders a real card — brand logo, "Draft reply", brand name — with
**"Writing your draft…"** / **"Preparing your draft…"**.

The symptom is the *fallback branch of the same block*. When `working` is false
(not streaming, nothing in flight), it renders a button instead — "Write draft",
or **"Try again"** once `attemptsRef.current > 0` (line 208). "Try again" reads
exactly like an error.

Two ways to land there:

- **First paint** after the card is pushed, before the `useEffect` fires — a brief
  flash of a button.
- **Auto-attempts exhausted** at `MAX_AUTO_ATTEMPTS = 2` (line 88). Aborts are
  common here: the comment at lines 116-123 records that the transcript storm
  re-renders the list **~46 times over ~13s** while Mila is still speaking, and a
  remount in that window aborts the in-flight fetch with an `AbortError` that sets
  no error state.

So the card most likely looked like an error because it *was* showing "Try again"
after two aborted attempts. That is a different fix from adding a spinner.

**Effort:** S (reword exhausted state + suppress first-paint flash) / M (fix the
remount churn). **Injection-relevant:** NO. **Type:** code (client).

---

# GROUP C — draft / send

## 10. Read the draft aloud, and "send it" sends

**Current state — deliberate, and stated in three places:**

- Prompt (`agent.ts:24`): *"you cannot send: only their tap on Send sends, and a
  spoken 'send it' does NOT send anything."*
- `open_draft` resolves only — `draftIntentRoute` *"does not draft and returns no
  draft text."*
- `useReplyAction` is *"the ONE send path"*, tap-only: *"The model never sends: chat
  text can't trigger this, only the on-screen tap does."*

**The blocker is architectural, not policy: the draft body does not exist on the
server.** The pushed card pins `draft: null` regardless of payload
(`widgetPush.ts:196-199` — *"no draft copy can be injected over this channel"*),
and the **client** generates the body locally. The worker has never seen the text.
So "send it" would be Mila sending words she cannot read and the athlete has not
seen.

Note that the read-aloud half of the ask is what forces the body to reach the voice
model — which turns brand-email-influenced draft text into spoken output.

Existing safety machinery worth preserving: propose-then-approve, at-most-once (a
second approve 409s), client single-flight ref, terminal "sent" state, and
`sendable` gated to gmail/instagram with an inbound message present
(`draftIntentRoute.ts:77, 226-227`).

**Safest shape if you build it:** Mila says "say 'send it' to confirm" → the spoken
confirmation flips a **client-side** armed state → the **client** sends the body it
already holds. The model never carries the text and never calls the send API, so
the one-send-path invariant survives.

**Effort:** L. **Injection-relevant:** YES (read-back puts draft text into speech).
**Also the only irreversible action on this list — it sends real email to real
brands.** Flagged per the destructive-surface rule; recommend not building until
Group A lands.
**Type:** new capability.

---

# GROUP D — polish

## 11. Spoken follow-up question at the end

**Root cause: the prompt forbids it, specifically.** `get_deal_brief` description,
step 4 of the judgment shape:

> *"CLOSE BY LANDING THE CALL AGAIN … **Close on the call, not on a question — do
> not end a judgment answer by asking what else they want to look at.**"*

It is already permitted in two dead-end cases: `notCached` (*"Ending flat is worse
than it needs to be, so offer something you can actually do"*) and the ceiling case
(*"that's the core of what I've got on them; want to go through the deal terms?"*).

So this is a targeted edit: keep the no-question rule for **judgment** answers (it
exists so she doesn't undercut a verdict with a hedge), permit an offer-shaped
follow-up after **informational** answers.

**Effort:** S. **Injection-relevant:** NO. **Type:** prompt-only.

---

# Ranking by value / effort

## Tier 1 — build these first

| # | Item | Effort | Why first |
|---|---|---|---|
| **3** | Real deliverables | **S–M** | Clearest root cause on the list (a 3-value enum). Safe structured source already exists. Large perceived-quality jump per line changed. |
| **8** | Barge-in | **S** to try | One enum. Changes how the whole call *feels*. Both conditions it compensated for are independently fixed. Trivial rollback. |
| **5** | Athlete profile / brand | **M** | Fixes "she only knows I'm an athlete". Data is app-owned → ~zero injection risk. All pieces exist; only the route + registration are missing. |

## Tier 1.5 — nearly free, bundle into one change

| # | Item | Effort |
|---|---|---|
| **2** | Score + why (permit number on explicit ask) | S, prompt-only |
| **7a** | Ask for clarification instead of going quiet | S, prompt-only |
| **11** | Offer-shaped follow-up on informational answers | S, prompt-only |

All three are edits to `MILA` and the `get_deal_brief` description in one file.
Ship as a single prompt commit with an eval run against the golden set.

## Tier 2

| # | Item | Effort | Note |
|---|---|---|---|
| **1** | Comp via `offer_struct` (+ stale-amount fix) | M | Carries a real correctness fix; pairs naturally with #3 (same jsonb) |
| **9** | Draft card "Try again" wording | S | Cheap; the churn fix underneath is M |
| **7b** | Silent-turn watchdog | M | Needs the malformed-call fault reproduced first |

## Tier 3 — decide before building

| # | Item | Effort | Blocker |
|---|---|---|---|
| **4** | Brand enrichment to voice | M / L | Policy call on prose vs. structured. **Check `brandFitStore` coverage first** — cold-path emptiness may be most of the symptom. |
| **6** | Web search in voice | S / L | Highest injection surface on the list. Explicit decision required. |
| **10** | Voice-driven send | L | Consequential + irreversible. Not before Group A. |

## Suggested first slice

**#3 + #8 + #5**, plus the Tier 1.5 prompt bundle as a fourth cheap rider.

That covers "deliverables are generic", "she won't stop talking", and "she doesn't
know who I am" — three of the loudest complaints — without touching the untrusted-text
boundary, the send path, or any web-research capability.

## Two things to confirm before building

1. **Stale `deals.amount` on the voice wire** (item 1). If real, Mila is speaking
   wrong dollar figures today, which outranks every feature here.
2. **`brandFitStore` coverage** (item 4). If most athlete×brand pairs are cold, the
   brand answers are thin for a reason that has nothing to do with the wire shape.

## Out of scope / needs Mia

Nothing here requires a shared-code change yet. Two things to watch:

- `server/lib/dealVoice.ts` is pure and dependency-free, so **calling** it from
  Mila's code is reuse, not a shared-code change. Do not modify it.
- Item 3's safe source and item 1's comp both live in
  `inbox_threads.conversation_state`, which the voice routes do not currently read
  at all. Reading it is new query surface inside Mila's own routes — fine — but it
  must stay filtered by `athleteId` like every other voice read.
