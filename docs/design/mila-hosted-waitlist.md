# Mila hosts the waitlist (TrueForge), dev only

Status: built behind `MILA_TF_WAITLIST` (dev `true`, prod `false`). Builds on Mila on TrueForge step 2
(`docs/design/mila-on-trueforge-step2.md`) and the waitlist join flow (`landing/index.html`, PR #1140).

## What the athlete experiences

She signs in exactly as today (Google, Apple, Microsoft or an email code). From then on the join flow is a
conversation with Mila instead of a row of screens:

1. **Mila says hello.** A short greeting appears under Mila's face and name, and the sport grid (the same tiles, the
   same "Continue") sits right under it in the conversation.
2. **She picks her sport.** The tap saves it exactly as today. If the athlete index found a public profile, the same
   **"Is this you?"** card appears next; if nothing placed her, the same **"Where do you play?"** card (optional).
3. **Research starts.** Our workflow runner starts her sign-up research the way it does today. Mila says what she is
   doing, and a status line under it changes as the real work moves on ("Finding you", "Reading 11 pages",
   "Checking 18 facts", "Scoring"). These words come from the runner's own progress, never from the model.
4. **"Is this you?" for her accounts.** When research finds an Instagram or YouTube account that may be hers, the same
   handle rows appear with "That's me" / "Not me". Her tap is saved by our server, as today.
5. **Quick score.** When the quick M.I.A. score lands, the same black score card with the ring appears, and Mila says
   it is a quick, early read.
6. **Full score.** When the full score lands it replaces the quick one in place (the same settle animation), and Mila
   says so.
7. **Invite.** "Invite your team" opens the same share card (her M.I.A. card, her own link). "See my spot" ends the
   conversation on today's spot screen.

At any point she can **type a question** ("how long does this take?", "what is the M.I.A.?") and Mila answers from real
data. A quiet **"Just show me my score"** link is always there: it ends the conversation and puts her on today's
screens at the step she is on. If Mila can't be reached, she lands on today's screens without noticing anything broke.

Later, when she is let into the app, the onboarding conversation continues **in the same Mila conversation**, so Mila
remembers what they already talked about.

## Rules that do not change

- **Every must-happen step is a code-built card or control**: sport, "Is this you?", team, the handle rows, the score,
  the invite. Each tap goes to the same server endpoint as today. The model never decides a step is done and never
  writes into a card.
- **Status is never invented.** The status line is code (the progress endpoint's real stage). Mila's own words about
  status come from `CONTEXT` (built from the same progress data) or the `waitlist_status` tool.
- **Nothing is sent or published by Mila.** Her only action tool, `start_research`, starts our own runner workflow
  (idempotent, the same run the sport tap already started).
- **Flag off ⇒ nothing changes.** The landing asks the server first; with the flag off (prod) it gets
  `{ enabled: false }` and runs today's screens exactly.

## The existing screens and where they sit in the conversation

| Step | Existing screen / card (landing) | Shown by | What Mila says around it (moment) |
|---|---|---|---|
| Sign-in | hero sign-in buttons | unchanged | nothing (no Mila before sign-in) |
| Greeting + sport | `#j-sport` (name field when needed, sport tiles, Continue) | code, right after sign-in | `hello`: greets her, says what happens next, invites her to pick |
| Is this you? (index) | `#j-claim` | code, when POST /waitlist answers 409 | nothing new (she is mid-answer) |
| Your team | `#j-team` (only when nothing placed her) | code | nothing new |
| Connect Instagram | `#j-connect` | skipped in the hosted flow; still reachable from the score card ("Connect Instagram to sharpen") and "needs more" | — |
| Research | the status line (`.stat`, `liveLineOf`) | code, polling GET /waitlist/progress every 4 s | `research_started`: what she is doing now, from STATUS |
| Handles | `#j-handles` rows (from `#j-wait`) | code, when progress has handles to confirm | `handles_found`: asks her to check which are hers |
| Quick score | `#j-score` (ring, quick sources) | code, when `quickScore` appears | `score_quick`: a quick, early read; the full one is coming |
| Full score | `#j-score`, settled in place | code, when `score` appears | `score_final`: the full score is here and replaced the quick one |
| Invite | `#j-bring` (her card, Share, Text, Email, Copy link) | code, on "Invite your team" | `invite`: thanks her; she keeps her spot either way |
| Spot | `#j-spot` | today's full screen | the conversation ends here |

The cards are the existing DOM moved into the conversation (`landing/mila-host.js`), painted by the existing code
(`paintSports`, `paintClaim`, `paintHandles`, `paintView`, `paintBring`). Nothing is redrawn or restyled: a card keeps
its light or dark look with the existing classes, plus one wrapper that lets it sit in the thread (rounded, 1px line,
as the Mila cards in DESIGN.md §16). On a fallback every moved card goes back to its own screen.

Mila may also ask the page to show one of these cards again (`show_waitlist_card`, below), e.g. "show me my score".
The server answers `shown` only when the card can be shown from real state; the page draws it with the same code.

## The skip path and the fallback

- **Skip** ("Just show me my score", under the message box): stops Mila's turns, puts every card back and runs today's
  `route()`, which opens the step she is on (the wait screen while research runs, the score once it is ready). The
  choice is remembered on this device, so a return visit goes straight to today's screens.
- **Fallback, automatic**: GET `/api/v1/waitlist/mila` says `enabled: false`, or fails, or a Mila turn fails (network,
  non-200, a stream that ends without `done`, or an error stop) ⇒ the same as skip, without the remembered choice. A
  card she already answered stays answered (the server holds every tap).

## Server

**Flag.** `MILA_TF_WAITLIST` (only the exact string `"true"`), and it needs `NOMILA_MCP_ENABLED` and the TrueForge
settings (`tfMissingConfig()` empty). Dev yaml `true`, prod yaml `false`; pinned by `tfWaitlistFlag.test.ts`.

**Routes** (`server/routes/waitlistMila.ts`, mounted at `/api/v1/waitlist/mila`; the landing's Firebase token, as the
other waitlist routes, so a waitlisted athlete can use it):

- `GET /` → `{ enabled }`.
- `POST /turn` (SSE) `{ moment?: hello | research_started | handles_found | score_quick | score_final | invite,
  message?: string ≤ 1,000 }` → streamed `token`s, then `done { runId, cards }`. Exactly one of moment / message.
  404 with the flag off. Per-user limit: 30 turns per 10 minutes. The day cost cap applies (as in the chat).

**One conversation per athlete.** `waitlistConversationId(athleteId)` is a fixed UUID derived from her id, so the
waitlist turns and, later, her onboarding turns share one `mila_tf_sessions` row and one TrueForge session. Her
messages and Mila's answers are `chat_messages` rows in that conversation (so the app can show it later). The waitlist
card requests are never saved to the chat history (the app does not draw them).

**One turn** reuses `runTfChatTurn` (`server/agent/tf/chat.ts`), with options added for the waitlist:

- skill `waitlist` (`server/agent/jobs/waitlist.md`): its tool list bounds the pass, scopes read · draft;
- the input: `<app_updates>` with the moment's line (fixed text per moment, Prompt Register), then `<surface>` (the
  waitlist surface, `server/agent/mila/surfaces/waitlist.md`, because the saved `mila-dev` agent carries the chat
  surface), then `<context>` (the waitlist context below), then `ATHLETE MESSAGE` (her words, or "(none: this turn is
  the app moment above)");
- a moment turn writes no `chat_messages` row for her (she said nothing).

**The waitlist context** (`server/agent/tf/waitlistContext.ts`, ≤ 2,000 characters): TODAY; ATHLETE name · sport ·
team; STATUS from `waitlistResearchProgress` (research state, the live stage in words, which steps are done, the score
stage with the quick or full value and confidence, handles and whether each is confirmed), SPOT (#n of total), and CAN
DO NOW (the three tools). Nothing invented, nothing from the client.

**Tools** (registered in the app registry, so they appear on `/mcp` for a pass whose skill lists them; `enabled()` =
the flag):

| Tool | Permission | What it does |
|---|---|---|
| `waitlist_status` | read | Her real waitlist state: research state and live stage, steps, score stage and values, handles, spot. |
| `start_research` | draft | Starts her sign-up research, or joins the run already going (`startSignupResearchChecked`, key `signup_research:<id>`). Idempotent. Refuses with a reason (no sport yet, no name, held for more detail). |
| `show_waitlist_card` | read | `card`: sport · is_this_you · handles · score · invite. Answers `shown` when real state allows it (sport: not saved yet; is_this_you: sport saved and research not started; handles: research found accounts; score: a quick or full score exists; invite: always), else `unavailable` with the reason. A shown card becomes a `waitlist-card` for the page. |

`confirm_handle` is deliberately **not** a tool: confirming an account is her tap only.

**Mila's definition** (`server/agent/mila`): `surfaces/waitlist.md` (where Mila is, what the app shows, the order) and
`skills/waitlist/SKILL.md` (tone, order, never invent status, answer questions in between, the skip). The playbook is
also the `waitlist` skill's body (so `get_playbook` can reload it after a compaction); a test pins the two equal.

## Onboarding on the same conversation

Behind the same flag, `agent_onboarding`'s `opening` and `insights` steps and her conversation turns
(`POST /api/v1/agent/onboarding/turn`) run through `takeMilaTurn` (`server/agent/onboarding/milaTurn.ts`; was `takeTfTurn` in `tfTurn.ts`) instead of
`takeTurn`:

- **Code still holds the onboarding.** Her taps are applied by the same `applyActions`; the required checkpoints
  advance only from what code showed. Code picks the cards, from the existing card kinds and payloads:
  - opening (the reveal): the M.I.A. preview when it is ready, then the facts list ("Is this right?", the fact-review
    card) → `reveal` and `facts_review` done;
  - insights: the M.I.A. preview if not shown yet, her early rate ranges when the Brief has them, the plan's
    recommended goals (up to three);
  - her later turns, one group at a time: connect offers (only real connectors she can be offered now), then what
    Nomila can do (capabilities), then "How Mila works" (consent).
- **Mila's words come from TrueForge**, in the waitlist conversation's session, with the chat skill's tools (she can
  look up her facts and the M.I.A.). The turn's `<app_updates>` say what happened (the step, her taps) and which cards
  are under Mila's reply, so she talks around them instead of repeating them.
- **Recorded as before**: the turn record (her input, Mila's words, the cards, the checkpoints) is the TrueForge run's
  output, under the onboarding's turn prefix, so the onboarding screen, resume, the path log and the cost cap read it
  unchanged. A retried step reuses the finished run (no second call).
- **Fallback**: a TrueForge turn that fails or ends with no words falls back to `takeTurn` for that turn (today's
  path), with her taps already applied.

What this path does not have that `takeTurn` has: the model-written reveal card (headline, highlights, standing,
windows), model-chosen quick questions, the optional age-band question and model-written insight cards. Mila says
those things in her words instead, from facts she looks up. This is the trade-off of moving the words to TrueForge
while keeping the cards code-built; it is dev only.

## Prompt Register (added, exact text in the code)

- Mila & agent: surface `waitlist` 1.0.0, playbook `waitlist` 1.0.0 (= skill `waitlist` 1.0.0 body);
- tools `waitlist_status`, `start_research`, `show_waitlist_card` 1.0.0 (descriptions);
- "Mila on TrueForge — waitlist moments" (the six moment lines, the no-message label);
- "Mila on TrueForge — waitlist context" (the context template);
- "Mila on TrueForge — onboarding turn updates" (the step lines, the tap lines, the cards line).

## Tests (PGlite; TrueForge, providers and models faked; one suite at a time)

- `tf/tfWaitlist.db.test.ts`: the tools over the real `/mcp` router (status from real rows; `start_research`
  idempotent — two calls, one run; the card enum and its availability rules); a waitlist turn (skill and scopes on the
  pass, the moment line, no user row for a moment, cards on `done`, not in history); the same session reused by an
  onboarding turn; flag off ⇒ route 404 and tools absent.
- `onboarding/milaTurn.test.ts` (was `tfTurn.test.ts`; in-memory store, the Mila turn faked): opening, insights and a conversation turn through the fake turn: cards picked by
  code, checkpoints advanced, the turn record readable by `onboardingState`, a retried step reuses its run, a failed
  Mila turn falls back to `takeTurn`.
- `tf/tfWaitlistFlag.test.ts`: dev on, prod off.
- `routes/waitlistMila.test.ts`: flag off ⇒ `enabled:false` and 404; the turn runs for the token's athlete; `done` carries the status; bad input refused.
- `scripts/landingMilaHost.test.ts`: the landing's pure helpers (moment for a progress change, the SSE reader, when to
  fall back).
- Chrome, over http, with the mock (`?mock=1&mila=1`): every step's screenshot in the PR.

## Open items

- The score-ready email is not sent from dev today (dev has no `LANDING_URL`, so `waitlistPageUrl()` is null). Setting
  `LANDING_URL=https://nomila.web.app` on dev would turn it on; not changed here.
- Account deletion does not delete TrueForge sessions yet (step 2 open item; required before any prod switch).
- The landing is deployed only with production (`deploy-prod.yml`, site `nomila`, also served as nomila.web.app, which
  talks to dev). Until then the hosted flow is tested from a local copy of the landing pointed at dev (`?api=dev`,
  localhost only).
