# Mila chat v2: the server side

Approved design: https://claude.ai/artifact/G893jBHp55Z3D41aHjfdsp (owner approved all five decisions, 31 Oct 2026).
This is step 1, the server. The app change (assistant-ui RN primitives) is the next PR.

**What the athlete notices:** nothing yet. The route is dev only (`MILA_CHAT_V2`), and no app build calls it. One
change reaches today's app on dev: a Mastra turn no longer stops when the phone drops (decision 4). The reply is
finished and saved, and it shows when the chat is reopened.

## The wire

`POST /api/v1/me/chat/v2` (requireAuth, then `chatLimiter` and the hourly cap, then the Mastra turn's own session and
ownership checks). Body: `{ conversationId?, message: { id?, text, attachments? } }`. Only `message.text` and
`message.attachments` are used. `attachments` is what the composer's ＋ attached: up to 4 of `{ asset_id, role:
photo|video|product }`, ids of media the athlete already uploaded to her library, with POST /me/chat's shape and checks
(a bad shape is a 400; an id that is not hers, deleted or unknown refuses the whole turn with a 404). An attachment-only
turn reads "Take a look at this.". As on v1, neither engine reads the attachments yet. History, message ids, tools,
state and context sent by the client are ignored: the server picks every id, and Mastra memory holds the thread.
(It used to answer 409 `engine_not_mastra` off Mastra; since Mastra-only PR 2 every turn runs on Mastra.) It is not mounted while `MILA_CHAT_V2`
is off (prod ships `"false"`, and `scripts/prod-flag-guard.ts` refuses a deploy that would switch it on).

The response is the AI SDK v7 UI message stream over SSE: headers `content-type: text/event-stream`,
`x-vercel-ai-ui-message-stream: v1`, `cache-control: no-cache`, `x-accel-buffering: no`. Each part is sent as
`data: <json>\n\n`, and the stream ends with `data: [DONE]`. A `: keepalive` comment goes out every 15 s.

```
runMilaTurn (Mastra) ──tap──▶ Mastra chunks ─▶ toAISdkStream(v7) ─▶ allow-list filter ─▶ SSE
                     tools carry transform.display: input → status line, output → card DTOs
```

The turn drives itself. The tap only enqueues, so a slow or missing reader never slows or stops the turn.
Mastra's `handleChatStream` / `chatRoute` are not used, because they trust client history and approvals.

## Part types (all others are dropped)

| Part | Carries |
|---|---|
| `start` | `messageId` = the run id, `messageMetadata: { runId }`. Sent as soon as the run row exists |
| `start-step` / `finish-step` | nothing |
| `text-start` / `text-delta` / `text-end` | `id`, `delta`: the same text v1 streams and the chat row keeps |
| `data-mila-status` | `id: "status"`, `{ label, phase }`: one of the fixed lines in `agent/tf/toolStatus.ts` |
| `data-mila-card` | `id` = card id, `{ type, data }`: a checked card DTO, sent once, as soon as its tool finishes |
| `data-mila-done` | `{ runId, status, stopReason, messageIds }` |
| `error` | one fixed sentence (never the provider's error) |
| `finish` | `finishReason`: `stop` / `error` / `other` |

Layer 1 is the display rules. Every Mila tool has a display rule (`agent/engine/mastra/display.ts`). Its input becomes
`{ label }` and its output becomes `{ cards }` or null. Mastra suppresses input deltas and puts a placeholder in every
other phase. Layer 2 is the filter (`chatV2Stream.ts`). It rebuilds each known part field by field and drops
everything else, including `tool-input-*`, tool errors, reasoning, sources, files, Mastra's `data-tool-*` parts and
any data part it did not make. A CI guard (`display.test.ts`) fails when a Mila tool has no display rule, or when a
card-making tool has a card type with no DTO schema.

## Card DTOs (`shared/milaCards.ts`)

Each DTO is a zod schema, and parsing strips unknown keys. Every DTO has `{ id, title, links, fields }`. Ids are
strings. A DTO that fails its schema is dropped and logged.

- **action**: an approval card. It carries `pendingActionId` and `state: "needs_approval"` (decision 3). The tap is
  the existing `POST /api/v1/pending-actions/:id/approve`, which claims the action at most once. A saved chat's card
  (`GET /api/v1/me/conversations/:id`, which the old chat reads too) carries its row's state NOW: `state` is
  `needs_approval`, `sent`, `declined`, `failed` or `expired`, and `stateAt` says when (server/mila/approvalStates.ts:
  one query per conversation, scoped to her rows; an id that is not hers leaves the card as it was saved).
- **deal-reply**: also carries `pendingActionId` and `needs_approval`. Its `politeNo` inside `deal-closed` does too.
- Also: `connect`, `quick-question`, `open-screen`, `goal-change`, `progress`, `ready`, `deal`, `deal-closed`,
  `deals-waiting`, `booking`, `document`, `how-i-got-this` (added by the turn at the end), and `waitlist-card`.
- The v1 widgets map as follows: `deal_card` → deal, `deal_list` → deal (one card per row), `reply_action` →
  deal-reply, `goal_change` → goal-change. `onboarding_update` and `shop_item` have no DTO yet, because no Mastra
  tool makes them.

## Reconnect

1. The `start` part gives the phone the run id.
2. If the phone drops, the turn keeps running. It stops only on Stop, a newer turn in the same conversation, account
   deletion, the cost cap or the turn timeout. The reply is saved before the run is marked ended.
3. When the phone comes back, it calls `GET /api/v1/me/chat/v2/runs/:runId`, which returns
   `{ runId, status: running|completed|stopped|failed, stopReason?, messageIds, conversationId, turnTimeoutMs,
   runningForMs? }` (`turnTimeoutMs` is the engine's `TF.turnTimeoutMs`; `runningForMs`, while running, is how far into
   it the run is, measured on the server). The run must belong to the athlete; otherwise the answer is 404. While the
   status is `running`, the phone shows "Mila is still working…" and polls with a growing wait (3 s × 1.6, up to 20 s)
   until the turn timeout has passed (plus 30 s for the save), 60 looks at most. Still running then: "This is taking
   longer than usual. I'll let you know when it's ready." (no error, no Retry; coming back to the app looks again).
   Only a stopped or failed run shows the error and Retry. Once the run has ended, the phone re-reads
   `GET /api/v1/me/conversations/:id`. A chat turn that completes with a saved reply after the phone stopped listening
   sends one "Mila / Your reply is ready." push (agent/engine/replyPush.ts), opening that conversation on that message.
4. Stop is `POST /api/v1/me/chat/v2/runs/:runId/stop`. It answers 202, 409 if the run already ended, or 404. It marks
   the run (error `"stop asked"`); the turn reads the mark within one fence poll on any instance (at once on this
   instance), and before and after it claims the conversation's row. The row is NOT given back by the Stop: the
   stopping turn keeps it until it has ended, so a message sent right after a Stop waits for it (as for a superseded
   turn) and the two never write the thread at once.
5. The v1 app's Stop (`client/hooks/use-mila-chat.ts`) calls `POST /api/v1/me/chat/stop { conversation_id }`, because
   the v1 wire only carries the run id on `done`. On the Mastra engine it stops every chat turn of that athlete still
   running in that conversation; on TrueForge it is a no-op (the dropped connection is still the stop there).

Mid-sentence resume (a shared event log) is not built.
