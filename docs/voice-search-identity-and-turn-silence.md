# Voice — search identity, and turns that go silent

> Nov 2026: the route's provider is now OpenAI web search (the `voice/web-search` skill), not Tavily; "the search
> call" below means that call. The search-identity analysis is unchanged by the switch.

Investigation and plan. Follows `docs/mila-37-voice-feedback-triage.md`, which
this supersedes on items 6 (web search) and 7 (goes silent).

Two repos, as before:

- `nomila-v2` — internal voice routes (`server/voice/*`), mounted at `/api/internal/voice`.
- `/Users/adi/mila-voice` — the LiveKit worker: the voice model, the system prompt, the tools.

Branches:

| Work | nomila-v2 | mila-voice | Base |
|---|---|---|---|
| #1 search identity | `adi/voice-search-identity` | `adi/voice-search-identity` | `adi/voice-websearch` (both) |
| #2 turn silence | — | `adi/voice-turn-watchdog` | `main` |

They are split because they have different bases and different review surfaces.
`webSearchRoute.ts` exists only on `adi/voice-websearch`, so #1 must sit on it;
#2 fixes behaviour that is live today and must not inherit an unmerged feature
branch to do it.

---

# 1 — Search is not identity-aware

## Symptom

Mila searched a brand the athlete has a deal with and described **a different
company of the same name** — a deal with "Pillar" answered with an unrelated
Pillar. She only corrected it when pushed, and when pushed she reasoned about it
correctly: *"I found a few Pillars, the deal brief doesn't say what they sell so
I can't match it."*

Separately, for Gorjana she flip-flopped: good fit → after search, not a good
fit → good fit again.

## The flow today

```
athlete says "Pillar"
  └─ get_deal_brief("Pillar")                     mila-voice src/agent.ts:430
       └─ POST /athletes/:id/deal-brief            server/voice/dealBriefRoute.ts
            → { source, deal, brandId, brandProfile:{tier,sportCategories},
                brandSummary?, reasons? }          ← no domain, no category, no site
  └─ web_search({ query: "Pillar" })              mila-voice src/webSearchTool.ts:127
       └─ POST /athletes/:id/web-search            server/voice/webSearchRoute.ts
            → OpenAI web search(query) → [{title, snippet, source:<hostname>, url}] × 5
```

**The two calls never meet.** `web_search` takes one argument — a free-text
`query` the model composes. No dealId, no brandId, no domain. The route resolves
nothing about the athlete beyond rate-limiting on `athleteId`. There is no point
in either process where a search result is compared against the deal it was
supposedly about, so "this result IS the deal's brand" is an assumption nothing
ever tests.

## Why there is nothing to compare against

The app holds hard identity anchors. None crosses the voice wire.

| Anchor | Location | Reality |
|---|---|---|
| `deals.brand_id` | `shared/schema.ts:174` | **dead column.** `upsertDealForThread` (`dealDetector.ts:1271-1310`) is the only place a `deals` row is written and never sets it |
| `inbox_threads.classification.brand_domain` | written `dealDetector.ts:580` from `extractDomainFromEmail(from)` (`:423`) | **the real anchor** — the sender's literal email domain, per-deal, per-athlete |
| `inbox_brands.domain` | `shared/schema.ts:244` | present, but `inbox_brands` is a GLOBAL table with a unique `normalized_name`, so a "Pillar" row may belong to another athlete's different Pillar |
| `inbox_messages.sender_email` | `shared/schema.ts:317` | present; `get_thread` returns `sender_name` only (`threadRoutes.ts:296`) |

`brandProfile.ts` narrows an `inbox_brands` row to `tier` + `sportCategories`
because everything else on the row is web-grounded prose. `domain` was excluded
by the same sweep even though it is a database key rather than prose, and that
exclusion is what leaves Mila with no way to tell one Pillar from another.

The naming problem is recursive: `brandBriefRoute.ts:186` and
`brandKnowledgeRoute.ts:138` both resolve the brand **by name with `domain:
null`** — "the worker has no domain to give."

## Why the answer came out confident

Nothing asserts the result is the deal's brand, and nothing asserts it isn't.
The prompt reinforces the assumption in two places:

- `agent.ts:39` — "ONE CALL, THEN BELIEVE IT", and an outside company after a
  miss "is a `web_search` question". Correct routing, framed as *believe it*.
- `agent.ts:51` — the only rule about web results covers **attribution** ("a
  couple of write-ups say…") and **not obeying instructions**. Nothing about
  entity identity. The word "same" does not appear.

## The Gorjana flip-flop is a different bug

It is **precedence**, not identity. Gorjana resolves to a real brand row, so the
brief returns `brandProfile`, likely `brandSummary`, possibly `reasons` — our own
written fit analysis. Five web-search snippets then arrive with equal standing and no
stated rank.

The prompt gives internal fields authority individually (`reasons` is "OUR
analysis… yours to say", `brandSummary` is "YOUR OWN LINE… We wrote it") and
settles one two-source conflict explicitly ("ONE TIER, NOT TWO"). But nothing
ranks web results against an internal fit read, so a snippet that reads off-sport
silently outranks a computed fit and then loses to it again next turn.

## The decisive design point

`webSearchTool.ts` wraps `source` — the hostname — inside `<external_content>`,
and the reasoning is sound: a domain is chosen by whoever registered it, and
`totally-legit-brand-verification.com` is a sentence as much as an address. But
the hostname is also the *only* identity signal in the result. **We hand the model
the one field it would need to match on, inside a fence that tells it to distrust
that field.** Asking the model to reconcile is therefore incoherent; the
comparison must happen server-side, where a hostname is a string we compare
rather than text a model is told to distrust.

## Plan — Option B, server reconciles

### nomila-v2 · `adi/voice-search-identity` off `adi/voice-websearch`

**New — `server/voice/brandIdentity.ts`**

- `resolveDealDomain(athleteId, brandPhrase)` → `{ domain, via: "thread" | "brandRow" | null }`
  - Primary: reuse `resolveDealsForBrand` (`./dealResolver`) — already
    athlete-scoped, already fuzzy-aware, and **the same path `get_deal_brief`
    takes, so the search and the brief cannot disagree about which deal they
    mean**. Winning deal → `raw_data.thread_id` → `inbox_threads.classification.brand_domain`.
  - Fallback: `findCachedBrand(name, null)` → `inbox_brands.domain`, only when the
    thread path yields nothing, and reported in `via` so the weaker provenance is
    visible in logs and tests.
- `sameCompany(a, b)` — registrable-domain comparison so `shop.gorjana.com`
  matches `gorjana.com`. Naive suffix strip, **no new dependency**; the known
  limitation is multi-part TLDs (`.co.uk`), documented rather than papered over.

**Modified — `server/voice/webSearchRoute.ts`**

- Body accepts optional `brand`, bounded by the same `flatten(…, MAX_QUERY_CHARS)`
  as `query`.
- **The anchor resolves CONCURRENTLY with the search call**, never before it.
  Both are awaited together. The lookup is two indexed reads, but it would
  otherwise land inside a window where the athlete may already be inaudible, and
  serialising it would spend that window for nothing.
- The `{ results }` variant gains two top-level booleans. `disabled` /
  `rateLimited` / `timedOut` are untouched — they are terminal states, and adding
  fields gives the model something to interpret.

```ts
{ results: [...],            // unchanged: bounded title/snippet/source
  knownDomain: boolean,      // do we hold a domain for this athlete's deal
  identityConfirmed: boolean }
```

- **The domain itself never crosses.** Only the booleans. Keeps the route's
  "hostname at most, never a URL" rule, adds no new spoken surface, and means
  Mila can say she cannot confirm without naming anything.
- Logging stays counts-and-booleans: no domain, no query, no results.

**Modified — `server/voice/webSearchRoute.test.ts`**

Currently a no-DB harness (express + a mocked search); becomes PGlite-backed per the
repo rule for DB-touching suites, run with `--runInBand`. Cases: thread-path hit,
brand-row fallback, no anchor → `knownDomain:false`, subdomain match, non-match →
`identityConfirmed:false`, and:

> **The tenancy test.** Another athlete's deal with the same brand name must not
> supply the anchor. `inbox_brands` is global and `resolveDealsForBrand` is the
> only athlete-scoped step, so this is the test that pins the boundary. A failure
> here is a cross-tenant read, not a cosmetic bug.

### mila-voice · `adi/voice-search-identity` off `adi/voice-websearch`

**Modified — `src/webSearchTool.ts`**

- `parameters` gains optional `brand`.
- `toToolResult` passes both booleans through **outside** `external()` — ours,
  like `resultCount`.
- **`undefined` must not collapse to `false`.** A new worker against an old route
  receives neither field; that is *unknown*, not *unconfirmed*. The fields are
  emitted only when the route sent them, and the prompt rule keys off presence.
- `webSearchTool.test.ts` extends the containment test to pin that neither
  boolean is ever wrapped.

**Modified — `src/agent.ts`** (prompt only)

- **Identity** — `identityConfirmed:false` → say you found a company by that name
  but cannot confirm it is the same one as their deal. `knownDomain:false` →
  state the uncertainty honestly rather than resolving it either way. Pass
  `brand` when the search is about a company they have a deal with.
- **Precedence** (Gorjana, independent of the above) — a web result adds colour
  about a company and never revises a fit read; the internal `reasons` and grades
  own the fit. On conflict, say both and say which you trust.

> **Do not oversell `identityConfirmed`.** It means *"this result is about the
> same domain that emailed you."* It does **not** mean the company is verified,
> legitimate, or the real trademark holder — someone emailing from
> `nike-partners.com` whose site ranks would confirm. The prompt wording must
> carry that distinction, and it must never be described to anyone as
> verification. What it buys is the end of a silent assumption, not a guarantee.

## Blast radius

**nomila-v2** — behaviour change confined to the voice web-search route.
`get_deal_brief`, `brand-brief` and `brand-knowledge` wires are deliberately
untouched, preserving `dealBriefRoute`'s documented byte-identical-cold-body
invariant with the other two. New reads only (`deals`, `inbox_threads`), no
writes, no migration, no DDL. Tenancy is the review point: this route has no
session and the shared secret is the whole boundary, so every new query filters
by the path `athleteId`. Reversible — `MILA_VOICE_WEB_SEARCH` gates the route
ahead of all of it; flag off returns `{disabled:true}` before a new line runs.

**mila-voice** — the prompt change is the real risk and is *not* confined to
search turns. This prompt is dense and load-bearing; the repo has already learned
that "the description IS behaviour on this stack". Registration tests pin which
tools exist; **nothing pins prose behaviour**, so this needs a live listen, not a
green suite. Adding an optional tool param is backward compatible in both
directions given the `undefined` handling above.

## Blocking unknown

How often is `inbox_threads.classification.brand_domain` actually populated? If
mostly null, `knownDomain:false` becomes the common answer and the design
degrades to "always say I cannot confirm" — honest but not useful, and the weight
would shift to the brand-row fallback. Approved aggregate-only query, no rows
returned:

```sql
select count(*), count(*) filter (where classification->>'brand_domain' is not null)
from inbox_threads;
```

**No #1 code is written until this comes back.**

---

# 2 — Turns that go silent

## The prompt is not the problem

`agent.ts:33` has covered this since `b6ba7bd` (2026-08-10): *"WHEN YOU CAN'T
ANSWER, ASK — DON'T GO QUIET… say so and ask ONE short question."* It predates the
test that reported the symptom. Every remaining cause kills the turn **below** the
prompt, where no instruction can reach.

## Correction: which causes are model-agnostic

We serve calls with **Grok** (`grok-voice-fast-1.0`, behind `MILA_VOICE_XAI`);
Gemini Live is the fallback. The earlier investigation cited
`@livekit/agents-plugin-google` paths throughout. Re-checked against the Grok
path, the split is **not** what it looked like:

| Cause | Mechanism | Grok? |
|---|---|---|
| (a) mic deaf during tool calls | `pendingToolCallIds` gate in `pushAudio` | **No — Gemini only** |
| (b) empty turn / `MALFORMED_FUNCTION_CALL` | `turnComplete` with no content | Gemini mechanism; the *shape* is model-agnostic |
| (c) no error listener, framework swallows errors | `AgentSession` | **Yes** |
| (d) consumed tool call answered with nothing | `voice/generation.ts` | **Yes** (framework), different consequence per plugin |

### (a) is Gemini-only — evidence

- `agents-plugin-openai/src/realtime/realtime_model.ts:852` — `pushAudio` is
  unconditional: resample, `input_audio_buffer.append`, done. No gate, no
  early return, no pending-call set anywhere in the plugin.
- `agents-plugin-xai/src/realtime/realtime_model.ts:34` —
  `class RealtimeModel extends OpenAIRealtimeModel`, and the xai realtime module
  does not override `pushAudio`.
- The framework's `clearAudio()` call sites (`agent_activity.ts:1182, 1525, 1977`)
  are turn-detection and backchannel paths, not tool paths; `:1977` is gated on
  `!llm.capabilities.turnDetection`, which is false for both realtime models.

So **there is no 3–9s deaf window on the Grok path.** On Grok an unanswered tool
call leaves the model waiting for a `function_call_output` that never arrives —
one dead turn — rather than discarding every subsequent microphone frame for the
rest of the session.

The one thing this cannot rule out is xAI's *server-side* behaviour: whether the
Grok realtime API itself ignores input audio while a function call is
outstanding is behind their API and is only answerable on a live call.

For the record, the worst Grok-path silence on file is already fixed and was a
different mechanism entirely — the `RemoteChatContext` cascade in
`patches/@livekit__agents-plugin-openai@1.6.2.patch`, where one dropped
conversation item corrupted the rest of the session and "the athlete's turns stop
reaching the model mid-call". Grok's silence mode is context-mirror corruption,
not a mic gate.

### (b) — a real remaining leak, in the framework

`voice/generation.ts:1224-1232`:

```ts
if (!isFunctionTool(tool)) {
  logger.error({ function: toolCall.name, speech_id: speechHandle.id },
               `unknown tool type: ${typeof tool}`);
  continue;                                   // ← consumed, answered with nothing
}
```

Same asymmetry as CASE 1 in `patches/@livekit__agents@1.6.2.patch`: the `if
(!tool)` branch ten lines below *does* answer via
`toolCompleted(createToolOutput({ exception }))`; this one does not. Reachable
from our side only if a registered tool fails `isFunctionTool` at runtime —
`budgeted()` rebuilds every tool through `tool()` with an `as any` cast, which is
exactly the kind of thing that could produce one.

Every other path in `performToolExecutions` answers: argument-validation failure
emits a `ToolError`, an execution throw is answered in a `finally`, and an
aborted execution is deliberately left retryable (CASE 2 of the existing patch
flushes it).

## Plan — `adi/voice-turn-watchdog` off `main`

Re-scoped so the primary fixes are the ones that bite on Grok.

**Primary (both models)**

1. **Turn watchdog** — `src/turnWatchdog.ts`, a pure state machine with injectable
   timers, in the shape of `./turnBudget`. Armed by a final non-empty
   `UserInputTranscribed`; disarmed by `AgentStateChanged → 'speaking'`; a tool in
   flight **suspends** the countdown and settling resumes it, so a legitimately
   slow tool cannot trip it and a model that receives a tool result and says
   nothing still does. Fires one short recovery `generateReply`, one shot per
   turn, with a hard cap of two consecutive recoveries — model calls bill a real
   account, and a watchdog that keeps prompting a dead session is the
   retry-until-success loop this codebase refuses to write. Model-agnostic by
   construction: it keys off `AgentSession` events, never plugin internals.
2. **Error listener** — `AgentSessionEventTypes.Error` and `Close` in `main.ts`.
   There is none today: `main.ts:146` registers only `ConversationItemAdded`, and
   `agent_session.js:913` returns immediately for anything recoverable and absorbs
   the first three unrecoverable LLM errors (`types.js:30`) before it will close a
   session. Structured, `module: 'mila.session'`, type/message/recoverable only.
3. **Close the unanswered-call leak** — the `!isFunctionTool` path above. Since
   the reachable cause is our own `budgeted()` rebuild, guard it in our own code:
   assert at agent construction that every registered tool satisfies
   `llm.isFunctionTool`, so a bad rebuild fails at boot instead of silently
   killing a live call. The upstream branch is documented as the residual.

**Fallback hardening (Gemini only)**

4. **Hold-and-replay for the Gemini mic gate** — see the mechanism note below.
   Demoted from the primary fix, since it cannot affect a Grok call.

Validation is against a **Grok** call.

## Mechanism note — why hold-and-replay does not reintroduce what the mute prevents

The Gemini guard is not wrong to exist. `pushAudio` refuses input while
`pendingToolCallIds` is non-empty because sending realtime input during an
outstanding function call invites Gemini to open a **new turn before the response
lands** — a replacement generation, which is the restart pattern
`ECHO_PREFIX_PADDING_MS` and `START_SENSITIVITY_LOW` already exist to suppress. If
we simply removed the guard, the athlete's mid-search speech would reach Gemini
while a call was pending and could provoke exactly that.

Hold-and-replay **keeps the guard's invariant and removes only the data loss.**
No audio reaches Gemini while a call is outstanding — the ordering the guard
protects is preserved exactly. What changes is that the frames are buffered
instead of discarded, and replayed, in order, the moment the set empties. What
Gemini sees is unchanged in kind and sequence — function call, function response,
then the athlete's audio. What changes is that the audio still exists: the words
arrive a few seconds late instead of never.

Three properties keep it bounded:

- **Ordering** — the replay is flushed ahead of the live frame that found the gate
  open, so the athlete's held sentence precedes what they are saying now.
- **Buffer cap** — bounded by held duration (~15s, comfortably past any real
  tool), dropping *oldest* first, because a replay is the tail of a sentence and
  the tail carries the meaning.
- **A valve** — if the gate stays continuously shut past every ceiling on this
  worker (`web_search` bounds its fetch at 7s over a route bounded at 5s; read
  endpoints at 2s), the pending set is cleared, the buffer replayed, and the event
  logged loudly. Clearing is safe in both directions: a response arriving later
  deletes an id from a set that no longer holds it (a no-op), and Gemini's view is
  already inconsistent because the response it waits for is never coming. A trip
  is not a fix — it is a leak becoming visible and bounded instead of silent and
  terminal.

Implementation is by **instance assignment, not a patch**: `pushAudio` is
dispatched off the instance including from the base class's own reader loop
(`llm/realtime.ts` `_mainTaskImpl` calls `this.pushAudio(value)`), so replacing
the method on the session intercepts every frame. A delegating wrapper would not —
the base class would reach past it. It fails open: `pendingToolCallIds` is
`private` in TypeScript and an ordinary property at runtime, so if it is absent or
not a `Set` (Grok takes this path; an upstream rename would too) nothing is
installed and behaviour is exactly today's.

---

# 3 — iOS audio glitches (parked)

Root-cause analysis retained for whenever it is picked up.

Two independent managers own the same `AVAudioSession`. `client/lib/voiceGlobals.ts`
calls `registerGlobals()` with no options; the default is
`autoConfigureAudioSession: true` (`@livekit/react-native/src/index.tsx:59-68`),
which runs `setupIOSAudioManagement()` at app entry and installs a native observer
that reconfigures and activates/deactivates the session on every audio-engine
playout/recording transition, `deactivateOnStop: true`. `voiceSession.ts` then also
calls the SDK-deprecated `AudioSession.configureAudio(...)` + `startAudioSession()`
at connect.

They write different configurations:

| | our `configureAudio` (`LiveKitReactNativeModule.swift:59-79`) | auto `recording` (`AudioManager.ts:275`) | auto `playout` |
|---|---|---|---|
| category | `playAndRecord` | `playAndRecord` | **`playback`** |
| options | airPlay, bluetooth, A2DP, **`defaultToSpeaker`** | bluetooth, **`mixWithOthers`** | `mixWithOthers` |
| mode | `videoChat` | `videoChat` | **`spokenAudio`** |

Likely causes, in order: category/mode churn on a live session (each engine
transition re-applies a config; `setCategory`/`setMode` on an active session
forces route renegotiation and the audio unit can restart); `defaultToSpeaker` not
durable (ours sets it, the automatic recording config does not, so the first
transition drops it); `mixWithOthers` on `playAndRecord` giving up exclusive audio;
and `deactivateOnStop` deactivating a session our code believes it owns. Nothing
handles `AVAudioSessionInterruption` or route-change notifications either.

Not verified on device — `ios/Pods` predates the native transport. Cheapest
confirmation: whether glitches correlate with Mila starting/stopping speech
(→ cause 1) or with background audio present (→ cause 3).
