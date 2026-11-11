# Mila on TrueForge, step 2: the chat endpoint

Status: built behind `MILA_TF_CHAT` (dev on, prod off). Step 1 (our tools as one MCP server, the athlete pass) is on
main. TrueForge references are to `@truefoundry/trueforge@0.180.0` (commit `d15fbad`), the version running on dev.

## What the athlete experiences

- **Nothing new on screen.** They type to Mila in the same chat. The answer streams in the same way, and the same
  cards show under it: "Want me to save that?", goal changes, links, "How I got this".
- **Mila remembers the conversation.** Within one conversation Mila keeps everything said so far, because TrueForge
  holds the transcript. A new conversation in the app starts fresh.
- **Mila knows what they tapped.** If they tap Save or Not now on one of Mila's cards, Mila is told at the top of their
  next message. It won't ask again about something already done, and it won't claim something happened that they
  declined.
- **Nothing goes out without their tap.** Sending, posting, sharing and saving to memory are still only queued as
  cards. The tap runs them through our own approve endpoint. TrueForge is never involved in a tap.
- **Limits stay the same.** Their daily spend cap applies before every message. If they leave mid-answer, the work
  stops: we cancel the TrueForge turn instead of letting it keep running and spending.
- **No odd code in the chat.** If TrueForge's generative UI is left on, the app still never shows its markup.

## 1. The endpoint: same route, same wire

- `POST /api/v1/chat` gets one more branch, ahead of the `AGENT_V3` harness branch:
  `if (milaTfChatEnabled()) runTfChatTurn(…)`.
- It speaks the same SSE contract as the harness path:
  - `status` events;
  - `{token}` events while the answer streams;
  - one terminal `done` carrying `runId` and `cards` (`shared/agent.ts` `AgentDoneFields`).
- The app already draws these. Preview and production builds have `EXPO_PUBLIC_AGENT_V3=true`, so **no client change
  is needed**. Switching is a server flag only.
- `milaTfChatEnabled()` is true only when `MILA_TF_CHAT === "true"` **and** `NOMILA_MCP_ENABLED` is on. Without our MCP
  server, Mila would have no tools.
- With the flag off, the route is exactly what it was. `chat.tfChat.test.ts` pins this.

## 2. One message, step by step (`server/agent/tf/chat.ts`)

1. **Sign-in, let-in gate, rate limit.** These are unchanged in the route (`requireAuth`, `chatLimiter`, the hourly
   count).
2. **Her row.** Her message is written to `chat_messages`, as the harness path does, and the conversation row is
   upserted.
3. **The run.** An `agent_runs` row is inserted with status `running`, `provider = "trueforge"`, `model` = the
   TrueForge agent name, and `skill_version = "tf:<agent>"`. Its id is the pass's `rid`, and every tool writes against
   it: approvals carry `runId`, and turn items have an FK to it.
4. **Day cap.** Her spend since UTC midnight (`spentTodayMicroUsd`) is checked against `AGENT_DAY_COST_CAP_USD`
   (`policy.checkCost`). If she is over it: the stop message, the run marked `stopped / cost_cap_day`, and no
   TrueForge call.
5. **Session.** We look up `mila_tf_sessions` by (athlete, conversation). The first message of a conversation:
   - creates a TrueForge session with `POST /api/v1/sessions` and `{agent:{name}, metadata:{nomila_session}}`;
   - stores the mapping.

   Rules:
   - The agent is always named, never given as an inline spec. TrueForge has no session policy yet (upstream #541), so
     the name is what pins the model, instructions and MCP servers.
   - A turn without a conversation id gets a row that is never reused.
6. **Pass.** `issueAthletePass` with:
   - `sub` = her;
   - `sid` = the session row;
   - `rid` = the run;
   - `skill` = the chat skill, whose tool list bounds every call;
   - `scp` = read · draft · propose · act. Propose and act are only ever queued.
7. **Input.** One `user.message`, made of three parts in this order:
   - app updates since her last turn (§5), if any;
   - the compact context;
   - `ATHLETE MESSAGE` and her text, unchanged.

   See "The context block" below.
8. **Turn.** `POST /api/v1/sessions/{id}/turns` with `{input, previous_turn_id:"auto", stream:true}` and
   `x-tfg-mcp-headers: {"nomila":{"x-nomila-athlete-pass":…}}`.
   - The SSE frames are `id: <seq>` + `data: <event JSON>` (apis/turns.ts `turnEventSsePayload`).
   - We stream `model.message.delta` content from `thread_id === "main"` only. Subagent text is never shown.
   - Consecutive assistant messages are separated by a blank line.
9. **End.** `turn.done` is the end. Its `state.status` is `done`, `cancelled` or `error`, and `state.metrics` holds
   tokens and `total_cost_in_usd` (use-agent "Turn events reference").
10. **Cards.** We take what the turn's MCP calls left in `mila_tf_turn_items`. In order:
    - an action card for each queued approval;
    - tool cards in call order;
    - "How I got this", built from the evidence (cited facts) as the harness does.
11. **Record.** On the run: status, stop reason, tokens, cost (micro-dollars), the tool-call records and the evidence.
    The assistant row gets `agent_cards` and `agent_run_id`. Then `done`.

**The context block** (`tf/context.ts`, at most 4,000 characters, about 1,000 tokens). TrueForge keeps every turn's
input in its history and re-reads it on every later turn. So this block is deliberately smaller than the harness's
CONTEXT (about 12,000 characters). It holds:

- `TODAY` and `OPENED FROM`;
- `ATHLETE`: name, sport, Brief stage, memory state, self-declared age band;
- `GOALS`: up to 5, with `G:` ids, up to 3 of this week's actions each, set aside, and recommended with `D:` ids;
- `CONNECTED`;
- `WAITING FOR YOUR TAP`;
- `NEVER USE`;
- a line saying facts are not listed: look them up with `recall_facts`;
- `CAN DO NOW`, built from the tools this pass can actually see (flags already applied).

Facts are not in the block. Mila fetches them, and their F-keys hold for the whole conversation (§4).

**Prompt Register.** The context template, the CAN DO NOW wording, the app-update lines and the `ATHLETE MESSAGE`
label are model-facing. They are registered as "Mila on TrueForge — per-turn input" (Mila & agent page).

The context and the updates are fenced with the shared escaper (`wrapTagged`): goal words and card titles can quote
outside text.

**What is not carried over from the harness path:**
- the rolling summary fold, since TrueForge holds the transcript and compacts it itself;
- the "(cards shown: …)" history notes, since TrueForge's history already has the tool calls and results;
- attachments, which the harness doesn't pass either.

## 3. Our API → TrueForge through IAP (`tf/iapToken.ts`, `tf/client.ts`)

- **IAP.** TrueForge-dev sits behind IAP (method A, proven 26 Oct).
  - We send an OIDC ID token for `nomila-tf-caller@`, with `aud` = the IAP OAuth client id and `includeEmail`, in
    `Proxy-Authorization`.
  - TrueForge's own API key stays in `Authorization`.
- **Minting.** At runtime, from the runtime SA through IAM Credentials
  `projects/-/serviceAccounts/{sa}:generateIdToken` `{audience, includeEmail:true}`. The runtime SA has
  `roles/iam.serviceAccountTokenCreator` on `nomila-tf-caller@` (checked).
- **Caching.** The token is cached until 5 minutes before its `exp`. Concurrent callers share one mint.
- **Retry.** If IAP refuses the token (a non-JSON 401/403), the client mints a fresh one and retries once.
- **Config, dev yaml only:**
  - `TRUEFORGE_BASE_URL`, `TRUEFORGE_IAP_AUDIENCE`, `TRUEFORGE_CALLER_SA`, `TRUEFORGE_AGENT=mila-dev`;
  - `TRUEFORGE_API_KEY`, from Secret Manager `TRUEFORGE_DEV_API_KEY`. The runtime SA has project-wide
    secretAccessor.
- Prod has only `MILA_TF_CHAT=false`.
- No token, key or pass is ever logged. A missing setting is reported by name only.

## 4. The durable card store (`mcp/dbTurnStore.ts`, migration 0141)

Step 1 kept a turn's cards in process memory. That breaks as soon as TrueForge's MCP call reaches a different API
instance from the one streaming the chat. Two tables replace it, and each column is there for a behaviour.

**`mila_tf_sessions`: one row per (athlete, conversation)**

| Column | Why it exists |
|---|---|
| `id` | The pass's `sid`. The MCP layer finds the session's tool state by it. |
| `athlete_id` | Tenancy: the state is read only by `id` + the pass's `sub`. Cascade on account delete. |
| `conversation_id` | Reuse the TrueForge session for the app's conversation, and find where to deliver an approval event (run → conversation). NULL: never reused. Unique with `athlete_id`. |
| `tf_session_id` | The TrueForge session to send turns to. Unique. Replaced if TrueForge says the session is gone (404/412). |
| `tool_state` | What the tools share across the conversation's turns: F-keys (`F3` means the same fact all conversation long, since TrueForge's history keeps earlier keys visible), connectors already offered (once a conversation), her own words (the deal-numbers check), and the playbook parts already returned (get_playbook once per conversation). |
| `state_version` | Compare-and-set, so parallel tool calls in one turn never overwrite each other's keys. |
| `pending_events` | App events Mila hasn't been told yet (§5). |
| `created_at` | When the conversation reached TrueForge, for support and a future retention sweep. |

**`mila_tf_turn_items`: what one turn's tool calls left for the app**

| Column | Why it exists |
|---|---|
| `id` (serial) | Call order: cards show in the order the tools ran. |
| `athlete_id` | Tenancy (items are taken by run + athlete). Cascade. |
| `run_id` | The turn. The chat endpoint takes by it. FK to `agent_runs` with cascade. Inserts happen only when the run is this athlete's, so a pass can't drop cards on someone else's run. |
| `kind` | `card` / `approval` / `evidence` / `tool` (the call record for the run trace; TrueForge exports no traces). Check constraint. |
| `payload` | The item. |

Notes on the turn items:
- **No session or tool-call-id column.** The run already names the conversation, and items are only ever read whole,
  per run, in order.
- **Take deletes.** `take()` deletes and returns in one statement. The table only holds a turn's items for the
  seconds the turn lasts. The kept copy is `chat_messages.agent_cards` and the run row.

**Concurrency.** A tool call that changed the shared state saves it compare-and-set. If another call of the same turn
saved first:
- a read call is simply run again on the fresh state;
- any other call merges what doesn't collide.

**Migration.**
- `0141_mila_tf_chat.sql` is additive, idempotent and has no transaction control. It is on `db-migrate.sh` after 0140,
  and pinned by `milaTfChat.migration.test.ts`: it must equal a schema push, re-run as a no-op, and cascade.
- **Dry-run on a dev clone (26 Oct):**
  - A scratch database was built from dev's schema (`pg_dump --schema-only`, 145 public tables, the same count as
    dev).
  - 0141 applied twice: both runs exited 0.
  - `\d` matched the design.
  - A smoke insert and an athlete delete cascaded to 0 rows.
  - The scratch database was dropped.
  - Then `BEGIN; 0141; ROLLBACK;` ran on dev itself: exit 0, and dev still has no `mila_tf_*` tables.
- **How it deploys.** `db-migrate.sh` runs on both dev and prod deploys. Prod therefore gets two **empty** tables on
  its next deploy. With `MILA_TF_CHAT` off, nothing reads or writes them: the route branch, the MCP router (off in prod
  via `NOMILA_MCP_ENABLED`) and the event hook all check the flag.
- **Privacy.** Both tables are in the athlete-data manifest: deleted and exported with the account. TrueForge itself is
  listed as an external store (§9).

## 5. Events from outside the chat

**What TrueForge offers.** A turn's `input` accepts only `user.message`, `user.tool_approval` and
`user.tool_response` (docs/api/use-agent.mdx "Turn input", openapi `TurnInputItem`). The turn-events endpoint
(`POST …/turns/{id}/events`, `TurnInboundEventItem`) accepts only approval, tool-response, approval-policy and
MCP-auth-continue items. There is **no system or event message type**.

**Why not a turn of its own.** Sending an event as its own turn would:
- cost a model call;
- produce an answer nobody reads;
- cancel any turn running in that session ("Creating a new turn in a session automatically cancels any turn still
  running").

**Built for approvals.** An event is queued on the session (`pending_events`) and delivered at the top of her next
message, inside `<app_updates>`. Its header is "APP UPDATES — what happened in the app since your last turn, recorded
by Nomila (not typed by the athlete)", with one line per event:
- `- <when> UTC · The athlete approved "<title>". It is done.`
- `- <when> UTC · The athlete approved "<title>", but it failed. It did not happen.`
- `- <when> UTC · The athlete declined "<title>". It did not happen.`

Delivered events are removed only after TrueForge accepts the turn (first event received), so a failed call doesn't
lose them. At most 20 wait per session; the oldest is dropped first.

**Hooks.**
- `POST /pending-actions/:id/approve` (agent_action), after `executeAgentAction`;
- `POST /pending-actions/:id/dismiss` for an agent_action.

Both call `noteApprovalOutcome`. It finds the run's conversation, does nothing when the flag is off, and never throws.

**Outside events, same mechanism (built after #1139, `tf/events.ts`).** These are not tied to one of Mila's runs, so
they are queued on the athlete's **most recently used** TrueForge conversation: the one whose newest TrueForge turn
(`agent_runs`, provider `trueforge`) is latest (`sessions.ts queueEventForAthlete`). A conversation the app never named
is never a target. Each event has a key, and nothing is added while an event with the same key still waits on that
session, so a webhook delivered twice or a retried callback queues the news once.

| Event | Source | Key (one waiting per key) | Line Mila reads |
|---|---|---|---|
| A deal reply arrived | `skills/dealDetector.ts`, both reply branches, next to the "A brand replied" push. Same 24-hour freshness rule, so a backfill, reconnect or replay never queues old news. The brand is read from the deal for this athlete only. | `deal_reply:<deal id>` | `A new message arrived on their deal with "<brand>" (deal_id <id>). Read it with deals_get before you say what it says.` |
| Research finished | the `onDone` hook (exactly once per run) of `lean_research_refresh` and of every `signup_research` version | `research_done:<run id>` | `The research refresh finished: <n> new facts saved to their record. Look them up with recall_facts before you use them.` (or "Research on the athlete finished", "nothing new was saved", or no count when the run's output has none) |
| An account was connected | `routes/oauthCallback.ts`, after the provider activated the row | `account_connected:<connection id>:<connected_at>` | `The athlete connected <Service>. Nomila is reading it now, which can take a few minutes.` (or "reconnected") |

A **new** conversation starts without these events. Its CONTEXT block already shows what is connected and whether
memory is still being built, and Mila reads deals through the deal tools. The exact lines are in the Prompt Register
("Mila on TrueForge — per-turn input").

## 6. Generative UI

TrueForge's agent setting is left as it is; that's the owner's call. When it is on, TrueForge tells the model to fence
OpenUI code in ```` ```openui ```` (trueforge-core `capabilities/builtins/OpenUI.ts`, "openui-markdown-fencing").

The endpoint removes every such block **while streaming** (`tf/openuiFilter.ts`):
- text that might still be the start of a fence is held back a few characters until the next chunk decides it;
- an unclosed block is dropped to the end;
- other code fences pass through untouched.

The app is safe either way. A future `show_card` (genui-library) is separate work.

## 7. Limits

| Limit | How it is enforced |
|---|---|
| Daily cost cap | Her UTC-day spend across all agent runs, checked before each turn (`AGENT_DAY_COST_CAP_USD`). |
| Per-turn cost | TrueForge can't be stopped by spend mid-turn. The turn timeout and the agent's own iteration limit bound it; the real cost is recorded from `turn.done.state.metrics`. A turn without metrics is logged. |
| Turn timeout | `MILA_TF_TURN_TIMEOUT_MS`, default 240 s and capped below the pass's 10-minute life. We abort the read and call `POST …/cancel`. |
| Connect timeout | `MILA_TF_CONNECT_TIMEOUT_MS`, default 60 s, for the response head only. A TrueForge-dev cold start takes 20–30 s. |
| Retries | One retry, only before the first event. A lost session (404/412) gets a new session; a transient failure (408/429/5xx or network) is retried after 1 s. Never after events started, since that would repeat work. |
| Cancel on disconnect | Her leaving aborts the stream and calls `POST /api/v1/sessions/{id}/cancel`. The call is idempotent; it aborts the model request, waits for running MCP calls and ends with `turn.done` cancelled. Without it, "the turn keeps running after the client disconnects". |
| One turn per session | TrueForge cancels a running turn when a new one is created (`cancelled-for-next-turn`). We record that as stopped/aborted with no stop text. |

## 8. Tests (PGlite; TrueForge, providers and models faked)

- **`tf/tfChat.db.test.ts`.** The fake TrueForge calls **our real `/mcp` router** mid-turn with the pass it was given,
  so the real tools, approval queue and durable store run. It covers:
  - T1: tenancy — the pass names the caller, her session and her run; a pass for A can't write items on B's run or
    read B's session state;
  - T2: the run row and its cost and tool records;
  - T3: cards on `done` and on the assistant row; streamed text;
  - T4: an approved or declined tap reaches the next turn once, and nothing is queued while the flag is off;
  - T5: openui blocks are stripped across deltas;
  - T6: the day cap, cancel on leave, a lost-session retry, session reuse, and F-keys stable across turns.
- **`tf/tfUnits.test.ts`.** The openui filter at every chunk size; the IAP token cache, refresh, de-dupe, invalidate
  and request shape; the client's headers, SSE parsing, IAP retry and error mapping; CAN DO NOW; input fencing; the
  metrics → cost mapping.
- **`tf/tfFlag.test.ts`.** The yaml pins: dev on and prod off; settings in dev only; the key is a secret reference.
- **`tf/milaTfChat.migration.test.ts`.** As in §4.
- **`routes/chat.tfChat.test.ts`.** With the flag off in every form the route is unchanged; on, it calls the TrueForge
  turn for the caller.
- **`mcp/mcp.test.ts`.** Updated for the async store.

## 9. Open items

- **Done after #1139: account deletion deletes her TrueForge sessions.** Her `tf_session_id`s are read before the
  delete transaction (the rows cascade), then each session is deleted with `DELETE /api/v1/sessions/{session_id}`
  after commit. TrueForge 0.180.0 documents this as deleting "a session and all related turns, events, and internal
  state", returning 204 and "idempotent if already gone"; a 404 also counts as deleted. Transient failures (408, 429,
  5xx, network) are retried 3 times with backoff; a 403 ("not the session creator") is not. The outcome, and the ids
  of any session not deleted, are the receipt step `purge_tf_sessions`, which fails the receipt
  (`lib/privacy/trueforgeSessions.ts`). It runs whenever TrueForge is configured, whatever the flag says now. With
  sessions but no configuration, the step fails as `not_configured`. EXTERNAL_STORES now says deletable.
- **Done after #1139: the other events** (deal reply, research finished, account connected): §5.
- **Done in this PR:** #1138's per-session `loadedPlaybooks` (get_playbook once per conversation) lives in the
  durable `tool_state` (no in-process store is used by the app); `30-how-to-work.md` and `45-product.md` now say CONTEXT
  is the short block above, facts come from `recall_facts` and the M.I.A. from `read_scouting`. The CONNECTED line says
  whether a connection can still be offered in this conversation (from the session's tool state).
- **Leftover items.** Items written by an MCP call still running after a cancel stay until the run or the athlete is
  deleted (cascade). They are small and harmless; a sweep can take them later.
- **Per-turn spend cap** inside TrueForge (needs an upstream hook) is not built.
