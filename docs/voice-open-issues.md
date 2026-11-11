# Voice — open issues, and one that isn't

Written 4 Sep 2026, after reading `server/voice/*`, `server/mila/*`,
`client/components/mila/*` and the unmerged `adi/*` branches.

Each item says what it is, **why it is that way**, and the cheapest path to a fix.
Items marked NOT A BUG were investigated and closed — recorded so they are not
raised again.

Two repos are in play throughout:

- **`nomila-v2`** — the internal voice routes (`server/voice/*`, mounted at
  `/api/internal/voice`), and the whole text-chat brain.
- **`nomila-co/mila-voice`** — the LiveKit worker: the voice model, its system
  prompt, and its tool registry. A private repo in our own org, readable with
  `gh repo clone nomila-co/mila-voice`. Earlier notes called it
  "`/Users/adi/mila-voice`, not in this repo" and treated it as unreadable; that
  is only where Aditya's clone sits. **Everything below marked ✅ was read in the
  worker's source rather than inferred from this side.**

They are coupled by one unversioned JSON blob stamped into the LiveKit token
(`{ athleteId, conversationId }`, `server/voice/webTokenRoute.ts:364`) and the
agent-name string `"mila-voice"`. `webTokenRoute.ts:76-78` says the quiet part:
*"the two sides are coupled by this metadata shape and nothing else… remember
the worker may be running an older build than this one."*

---

## 1 · Voice search cannot disambiguate a brand — REAL

**Not a permissions problem.** The name "identity-aware" was mine and it was a
bad one: it reads like a data-access hole, and there isn't one. See the security
note below before anything else.

**What voice search is.** `server/voice/webSearchRoute.ts` is one OpenAI web
search (the `voice/web-search` skill; it was a Tavily query until Nov 2026)
against the PUBLIC WEB. It reads no Nomila data. It returns `title`, `snippet`,
`source` and, for display only, `url` — and `source`, the part Mila speaks, is the
HOSTNAME, not the href, because *"a full URL
is unspeakable at best; at worst it is a typo-squat domain read aloud with our
credibility behind it."* Raw page content, images and any synthesized
answer never cross. So it is the right tool for "find me a book
to read", and it is deliberately not a search of our own data.

**What actually goes wrong.** Mila researched the wrong company called "Pillar".
The route takes `{ query }` and nothing else — no `brandId`, no domain — so the
model can say *search Pillar* but cannot say *the Pillar on this deal, at this
domain*. The worker knows which brand is being discussed; the query cannot carry
it. `docs/voice-search-identity-and-turn-silence.md`: **the two calls never
meet.**

**Fix.** Pass the brand's known domain (or id) alongside the query so the search
can be constrained.

**✅ The worker half does not exist.** `mila-voice` has no
`adi/voice-search-identity` branch — the only identity branch there,
`adi/mila-34-voice-identity`, is 0 files ahead of main. And the shipped tool
takes exactly one parameter and posts exactly one field
(`src/webSearchTool.ts:144`, `:163`):

```ts
parameters: z.object({ query: z.… })
body: JSON.stringify({ query })
```

So the `nomila-v2` half being 5 files ahead is the *whole* of what exists. The
server could accept a brand id tomorrow and nothing would send one.

**Ask Aditya:** the worker half was never started — is that deliberate, or did it
get lost? It is the half that matters.

---

## 1a · Can a voice user reach another athlete's data? — NO

Checked, because "not identity-aware" invited the question.

**The athlete id never comes from the user.** `/voice/token` sits behind
`requireAuth` (Firebase token in, `req.athleteId` out, 401 otherwise), and
`server/voice/webTokenRoute.ts:324` reads `req.athleteId` from that SESSION. It
is stamped into the LiveKit token metadata; the worker reads it from there and
calls back with it. There is no field in any request for a client to forge.

**A guessed conversation id does not get you in either.**
`resolveVoiceConversation` (`server/mila/conversations.ts:141-199`) has an
explicit case for "this UUID exists but belongs to another athlete" and
substitutes a fresh one rather than joining. Silent substitution over a 4xx is
deliberate — an error would confirm the guessed UUID belongs to somebody. The
client's `"Voice is writing to a different conversation than this chat"` notice
is the visible edge of that refusal, not merely a bug indicator.

**Where the trust does sit.** The internal routes trust the WORKER, not a user.
`server/voice/auth.ts` says so: *"the athlete id comes from the path and this
secret is the ENTIRE authorization boundary. Whoever holds it can read any
athlete's data."* That is a normal service-to-service boundary and it is bounded
deliberately — its own secret (explicitly NOT reused from `CRON_SECRET`, to keep
the blast radius narrow), constant-time compared so it cannot leak by response
timing, and FAIL-CLOSED: unset means 401 to everything, which doubles as the
kill switch.

**So the line already drawn is the right one:** researching another athlete on
the public web is fine and possible; reading another athlete's Nomila data is
unreachable from a user, and reachable from the worker only because the worker
is us.

---

## 2 · Voice speaks a stale money figure — NOT A BUG

**The claim.** That voice reads `deals.amount`, which
`server/lib/dealVoice.ts:14-17` names as money-safety invariant #1: *"NEVER
speak `deals.amount`. It goes stale (we saw $200 on a deal whose live offer was
$950)."*

**Checked. It does not.** Both voice deal routes drop it at the boundary and
resolve money from the thread's structured offer fields:

- `server/voice/dealRoutes.ts:310` — *"MONEY: `amount` is the tool's
  `offer.amount`, NOT its `amount`. The latter is `deals.amount`, a
  detection-time snapshot that drifts stale."*
- `server/voice/dealBriefRoute.ts:261` — *"`deals.amount` is dropped at this
  boundary."*

Both cite `dealVoice.ts:14-17` by name, and
`server/voice/dealBriefRoute.test.ts:874-886` tests the exact $200/$950 case,
asserting the answer is **950** and explicitly *not* 200.

**The invariant is honoured and covered.** Nothing to do.

---

## 3 · Cards made in voice do not survive reopening — NARROWER THAN STATED

**What happens.** A card pushed during a voice call renders live, and on reopening the
conversation it has become a plain line of text.

**True only of the transcript path.** `server/voice/transcriptRoute.ts` inserts
`content` and never touches the widget column, and `appendWidgetMessage`
(`client/hooks/use-mila-chat.ts`) appends to **live state only**. So a card Mila
spoke about mid-call is lost.

**But the draft card already persists, and the mechanism is proven.**
`server/voice/draftIntentRoute.ts` writes `chat_messages.widget` with
`source: "voice"` before it answers, under the heading *"persist first, push
second"* — deliberately, so the card exists whether or not the live push lands. And
`getConversationMessages` selects `widget` back out, for exactly this reason.

So this is **not** "should voice cards persist, and can they?" — one of them already
does. The ask is to reuse `draftIntentRoute`'s pattern on the transcript path. That is
a much smaller question, and it does not gate the redesign the way the original
framing suggested.

## 4 · Voice has 9 tools; text has 13 — SMALLER GAP THAN REPORTED

**✅ Counted in both registries. An earlier note in this file said "4 versus 12"
and named the profile as absent. Both were wrong.**

Voice registers **nine** (`mila-voice/src/agent.ts:1607-1703`):

```
get_athlete_profile   get_deal_brief      get_score
get_score_history     get_share_signals   get_thread
list_deals            open_draft          web_search  (flag-gated)
```

Text registers **thirteen** (`server/mila/tools/`): `draft_reply`,
`get_analytics`, `get_brand`, `get_brand_fit`, `get_deal`, `get_help`,
`get_profile`, `get_rate_card`, `get_score`, `list_deals`,
`list_tasks_threads`, `navigate`, and Gemini's built-in grounding.

**So the profile is NOT absent from voice** — `get_athlete_profile` is
registered, and the system prompt tells Mila to call it once and reuse it for the
call. Voice also has three tools text does NOT: `get_deal_brief`,
`get_score_history`, `get_share_signals`.

**What voice genuinely lacks:** `get_rate_card`, `get_brand`, `get_brand_fit`,
`get_analytics`, `list_tasks_threads`, `navigate`.

`get_deal` and `get_brand_brief` are further along than the rest — exported,
tested and served, with only the registration line removed
(`agent.ts:1703-1705`): *"putting either back is adding one line here."*

**It is still gated.** `ISSUES.md:51-80` — *"AUDIT REQUIRED: email-derived prose
in voice tool results."* Correct: anything a voice tool returns is read aloud by
TTS, where prompt delimiters mean nothing.

**Three ways out, and it is a product call:** narrow what voice claims; widen the
registry behind the audit; or let voice **hand off** — she says "let me pull that
up" and the answer lands in the thread. The third is closest to what ships, and
the worker's own prompt already mandates the spoken half of it (§8).

---

## 5 · `adi/voice-drafting-fixes` — ALREADY MERGED, correction

**An earlier version of this document asked Aditya to merge this branch. That was
wrong, and the mistake is worth recording because it will recur.**

All six fixes are on `main`. The branch only *looks* unmerged: this repo
squash-merges, which rewrites the patch-id, so `git cherry` and
`git branch --no-merged` both keep listing a branch forever after its PR lands.

Each fix was then checked on `main` individually rather than trusted:

```
open_draft resolves a partial brand, and asks when it is ambiguous   → dealResolver.ts, "ambiguous" verdict + tied names
brand narration was truncating, then caching the failure forever     → brandNarration.ts, "a FAILED generation is NOT settled"
restore the inbound gate on the text card                            → widgets.ts, isSendableWithDraft
an empty body is a failure, not a draft                              → dealDraft.ts, reason "empty_body"
clearing the draft text no longer unmounts the editor                → DealActionSheet.tsx
sheet copy no longer promises a redraft this sheet cannot do         → DealActionSheet.tsx
```

**The reliable test is a two-dot diff, not `git cherry`.** A branch whose work has
landed sits thousands of deletions *behind* `main` (this one: −58,994). A branch with
real work ahead of it has new files `main` does not have. The same check cleared every
other `adi/*` branch and PR #290's server half.

**What this fix means for the Mila redesign.** The inbound-gate change is the precedent
the whole card recommendation rests on: `reply_action` — one of Mila's four widget types
— used to recompute "can this send?" from a hand-copied list of three terms, omitted
*inbound*, and offered Send on threads that would 400. It now calls the shared
`isSendableWithDraft`, under the comment *"Add a term to `sendGate.ts`, never to a copy
here."* That same change also added a field (`has_inbound`) to the widget payload, so the
payload is demonstrably extensible. Everything the redesign asks for is a repeat of a
move already made here.

## 6 · Context is a one-way mirror — BY DESIGN, worth knowing

**Voice → text: complete.** Every spoken turn is a real `chat_messages` row
(`transcriptRoute.ts:115-123`, `source: "voice"`), and both text read paths are
unfiltered on `source`, so voice turns replay into Gemini verbatim.

**Text → voice: nothing, in words.** `server/mila/voiceMemory.ts:19-22`, in
capitals: *"THE FORBIDDEN VERSION OF THIS FEATURE IS LOADING `chat_messages`
INTO VOICE. That table holds brand- and email-derived prose… anything seeded
into a voice session is read aloud by a TTS layer, where prompt delimiters mean
nothing."*

The rule is **write unified, read structured.** A voice session opens with one
templated sentence built from ids and closed enums
(`server/voice/voiceSeed.ts`), and only when a `get_deal` happened over text. A
purely conversational text history seeds nothing — `seedRoute.ts:126` returns
`{ seed: null }` and the worker opens cold.

**✅ Confirmed from the worker side too.** `mila-voice/src/memory.ts:1-6`:
*"Everything substantive is server-side… **the worker's job is only to carry
turns out and one line in.**"* There is no history reader in the worker; both
directions fail quietly by design, because *"a session that fails to START
because a memory read timed out is a broken one."*

**This is a security invariant, not tech debt.** Do not "fix" it by replaying
chat messages. The sanctioned widening is to record more structured tool results
into `voice_context`, which is work in *this* repo behind the same audit as §4.

---

## 7 · Fixed on 4 Sep — no action needed

- **Android voice was off.** Nothing technical blocked it: the audio preset
  (`AndroidAudioTypePresets.communication`), the SDKs, the Expo plugins and
  `RECORD_AUDIO` were all already correct, and the comment said why — *"the
  transport would work, but no one has heard it yet."* Enabled behind the
  existing flag in **PR #326**. **Untested on a device.**
- **Three stale comments** in `useMilaVoice.ts` claimed the native flag was "set
  in no EAS profile" and "dark in every build profile". `eas.json` had set it to
  `"true"` in `preview` and `production` for some time. Corrected in the same PR.
- **The `development` EAS profile had no `env` block at all**, so the one build
  anyone would test with shipped native voice dark while the two shipping
  profiles had it on. That asymmetry is the likeliest reason nobody has heard
  Android. Fixed in **PR #326**, though the Metro shell still governs a dev
  client regardless of the profile.

---

## 8 · The worker's prompt already solves a UI problem — READ BEFORE REDESIGNING

`mila-voice/src/agent.ts:43` mandates the spoken filler you can see in the
screenshots:

> **SAY WHAT YOU'RE DOING BEFORE ANY TOOL THAT TAKES MORE THAN A BEAT.**
> `web_search`… goes out to the open web and takes several seconds, and you
> cannot speak while it runs. **Silence on a call is indistinguishable from a
> dropped line**, so before you call it, say one short sentence out loud… That
> line is not optional. Say it ONCE.

"Let me check that for you" is that rule firing, not chattiness. The redesign
must not add a second, visual answer to the same problem without deciding which
one owns it — a spinner AND a spoken "let me look that up" is the same
information twice, and the prompt explicitly forbids narrating progress after
the first line.

---

## 9 · Why voice searches through us instead of natively — ANSWERED

The worker calls **our** web-search route (OpenAI web search since Nov 2026; Tavily when this was written) rather than Grok's own search
(`src/webSearchTool.ts:160`). The reason is in the registration comment
(`agent.ts:1696-1702`):

> Same shared array as the rest, so **both models get the same tool with the same
> wrapping**; whether both models can USE it well is a separate question the flag
> exists to let us answer.

"Both models" is literal — there is a **Gemini Live fallback**
(`gemini-live-2.5-flash-native-audio`, `agent.ts:1304`) behind Grok
(`grok-voice-fast-1.0`, `:998`). Native search would behave differently per model
AND dissolve the retrieved text into prose, losing the bounded-fields property
the whole injection argument rests on (§1).

Text, separately, grounds with **Gemini's native `googleSearch`**
(`server/mila/grounding.ts`). So both providers are in use, deliberately, and
`server/scripts/compareSearch.ts` is the harness that was used to choose.

---

## Questions for Aditya

1. **Stale branches** — nothing of yours is genuinely unmerged (§5). `adi/*` and
   PR #290 all land squashed and then linger in the branch list forever. Can the
   merged ones be deleted, so the list stops manufacturing false alarms? PR #290's
   server half is on `main`; its client half touches three files PR #320 rewrote, so
   we could not tell from outside whether it is superseded — can you confirm before
   it is closed?
2. **Search identity (§1)** — the worker half was never started. Deliberate, or
   dropped? The `nomila-v2` half is inert without it.
3. **Voice cards (§3)** — the draft card already persists; should the transcript
   path reuse that same mechanism? Smaller than we first wrote it up, but it still
   wants deciding before the design, not
   after.
4. **Tool parity (§4)** — narrow, widen, or hand off? `get_deal` and
   `get_brand_brief` are one line each; the rest wait on the audit.
5. **The `ISSUES.md:51` audit** — has anyone run it? It blocks everything
   downstream of §4 and §6.
6. **`adi/voice-turn-watchdog`** in the worker repo — that is the "turns go
   silent" fix from the same investigation as §1. Same question: still live?
7. **Status ownership (§8)** — if the prompt already speaks "let me check that",
   does the UI show a spinner too, or defer to the voice?
