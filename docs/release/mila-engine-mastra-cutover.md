# Mila engine: Mastra cutover checklist

Owner decision (30 Oct 2026): Mastra becomes Mila's engine **on dev**, with TrueForge kept as a fallback you can switch
back to. Production stays on TrueForge (and every Mila surface is off there). This page lists what must be true at
each step, and how to undo it.

> **Update, 9 Nov 2026 (Mastra-only, PR 3 of 3). TrueForge and the `/mcp` server are deleted.** `server/agent/tf/`,
> `server/agent/mcp/` (and the `POST /mcp` mount), `server/lib/privacy/trueforgeSessions.ts` and the `get_playbook`
> tool are gone; account deletion no longer calls TrueForge (our own rows, `mila_tf_sessions` and the `mastra` schema,
> are still purged and verified). The dev YAML drops `NOMILA_MCP_ENABLED`, `NOMILA_MCP_CALLER_SECRET` and every
> `TRUEFORGE_*` setting; `NOMILA_MCP_PASS_KEY` stays (every Mastra tool call runs under the athlete pass). The prod
> YAML is untouched: its `NOMILA_MCP_ENABLED="false"` and `MILA_ENGINE="trueforge"` lines are now inert and go in a
> release. Mastra's served text is byte-identical. Left for later: the TrueForge-dev service, its database and its IAM
> grants (sessions it still holds go when it is decommissioned, not by the account delete); renaming
> `mila_tf_sessions`, `MILA_TF_WAITLIST` and `NOMILA_MCP_PASS_KEY`. The "Removing TrueForge" section below is history.
>
> **Update, 8 Nov 2026 (Mastra-only, PR 2 of 3). There is no engine switch any more.** Mila runs on Mastra, always:
> `MILA_ENGINE` and `MILA_MASTRA_ATHLETES` are read by nothing, the harness (`server/agent/harness.ts`,
> `server/agent/chat.ts`) is deleted, and the "Rollback" section below no longer works (there is nothing to roll back
> to by a flag; going back means reverting the deploy). The features keep their own flags (`MILA_CHAT_V2`,
> `MILA_TF_WAITLIST`, `MILA_PROACTIVE`, `MILA_WELCOME`, …); only the engine precondition went. `MILA_TF_CHAT` is
> gone from the code and the dev YAML. The prod YAML still says `MILA_ENGINE="trueforge"`, which is now inert; prod
> is updated from dev in its own approved release, and from then on prod's Mila runs on Mastra (it needs
> `NOMILA_MCP_PASS_KEY` and `OPENAI_API_KEY` there). PR 3 deletes `server/agent/tf/`, `server/agent/mcp/` and the
> TrueForge session clean-up. Everything below is history.
>
> **Update, 5 Nov 2026 (P1, `feat/p1-mastra-standalone`).** The rollback target is now **the harness**, not TrueForge:
> prod has always run the harness and never had TrueForge. Any `MILA_ENGINE` value other than `mastra` (unset,
> `harness`, `trueforge`, a typo) runs the chat on the harness, and the Mastra-only surfaces (proactive, the
> Mila-hosted waitlist, chat v2) are off. TrueForge is no longer chosen by any value; its code stays until it is
> removed. Mastra chat no longer needs `NOMILA_MCP_ENABLED` or `MILA_TF_CHAT`, and the waitlist on Mastra no longer
> needs the `TRUEFORGE_*` settings (the pass key `NOMILA_MCP_PASS_KEY` is still needed: every tool call checks the
> athlete pass). `MILA_MASTRA_ATHLETES` (empty by default) moves only the listed athletes' chat to Mastra while
> `MILA_ENGINE` is not `mastra`. Sections below that say "TrueForge" as the fallback describe the old rule.

## What changes for the athlete

Nothing they should notice. The chat, Mila's own messages (proactive), the waitlist and onboarding look and behave the
same: same cards, same tap-to-send approvals, same status lines while Mila works. Only the engine running Mila's turn
changes. That is why the owner's phone check below matters: it is the only check of how it feels.

## How it works (short)

- `MILA_ENGINE` picks who runs Mila: `mastra` = Mastra as a library inside our API (`server/agent/engine/mastra`).
  Anything else = the harness for the chat, with the Mastra-only surfaces off (P1, 5 Nov 2026; it used to mean
  TrueForge). It is read on every turn, so a switch takes effect without a deploy.
- One entry point, `runMilaTurn` (`server/agent/engine/index.ts`), is used by chat, proactive, waitlist and onboarding.
- Mila's tools run in-process through the same function `/mcp` uses for TrueForge (`callPassTool`), with the same signed
  athlete pass checked on every call.
- Mastra keeps conversation history only, in its own schema `mastra` (migration 0147). No working memory or other
  automatic memory. Account deletion removes it.
- Costs come from our price table (`server/agent/models.ts`), recorded on `agent_runs` with `provider = 'mastra'`.
  An aborted or failed turn records the steps that finished (summed from Mastra's step-finish usage). The per-run cap
  (`AGENT_SKILL_CAPS` / the skill's `cost_cap_usd`, chat $0.15 / `AGENT_RUN_COST_CAP_USD`) is checked after every step:
  past it the turn stops with the cost-cap message. A turn that hits the step limit (16) says so.
- One turn at a time per conversation, across instances (`mila_tf_sessions.running_run_id`, 0147): a new message
  while Mila is still answering stops the running turn and answers the new one, which is what TrueForge does today
  (it cancels a running turn when another starts in the same session). The stopped turn keeps any text it had already
  streamed, like a cancelled TrueForge turn. A turn left behind by a dead instance is ignored after the turn timeout.
- No EE features configured: no FGA provider and no licence key (`MASTRA_EE_LICENSE` / `MASTRA_LICENSE_KEY` are set
  nowhere; pinned by `engine.test.ts`). The `@mastra/core` package itself does ship EE code; none of it is switched on.

## Step 1: before merge (this PR)

| Check | How | Status |
|---|---|---|
| Clean install, no hidden flags | `npm ci --ignore-scripts` (no `--legacy-peer-deps` anywhere; CI does this) | |
| Build | `tsc --noEmit` clean; the Docker image builds (deploy-dev builds it) | |
| Isolation tests green on the final code | `npm test -- server/agent/engine/mastra/isolation.test.ts` (thread-id reuse, foreign run id, foreign message id, forged context) | |
| End-to-end turn tests green | `npm test -- server/agent/engine/mastra/mastraTurn.db.test.ts` (approval card, fence, cost cap, SPEAK/SILENT, rollback) | |
| Duplicate protection green | `npm test -- server/routes/pendingActions.approvalState.test.ts` and `server/agent/tf/tfChat.db.test.ts` (a card runs once; a second tap is refused). Approvals are our own tap cards on both engines; Mastra's own approval/suspend is not used. | |
| Policy pins green | `npm test -- server/agent/engine/engine.test.ts` (exact versions; no `@mastra/server`, `deployer`, `mcp`; memory off; dev = mastra, prod = trueforge) and `npm test -- scripts/prodFlagGuard.test.ts` | |
| Migration dry run on dev | `PROXY_PORT=5440 npx tsx scripts/mastra/dryRunMigration.ts` (BEGIN … ROLLBACK) | done 30 Oct (again after the review fixes): 53 tables + 3 `mila_tf_sessions` columns created inside, re-run no-op, rolled back, nothing kept |
| DDL matches the pinned `@mastra/pg` | `npx tsx scripts/mastra/exportDdl.ts --check` | |

**Rule for `@mastra/pg` version bumps.** 0147 matches what `@mastra/pg` 1.32.0 creates on a FRESH install, and the
test checks exactly that. Every statement is `IF NOT EXISTS`, which never alters a table that already exists. So a
bump whose DDL differs must ship a NEW numbered migration with the `ALTER` statements (written by hand from the diff
of the two exports), and move the pinned version in `mastraStore.migration.test.ts` / `ddl.ts`. Never regenerate or
edit 0147 once it is applied. The test fails on the bump until this is done.

## Step 2: merge and deploy to dev

The dev deploy runs `scripts/db-migrate.sh`, which applies 0147 (creates schema `mastra`, drops the POC's empty
`mastra_poc`). Then the dev service starts with `MILA_ENGINE=mastra`.

Check right after the deploy:
- Server boots; `/health` OK.
- One chat message from a test athlete gets an answer; `agent_runs` shows `provider = 'mastra'` for it.

## Step 3: dev soak (at least 5 working days)

Pass criteria, compared per engine on `agent_runs` (`provider` = `mastra` vs `trueforge`):

| Signal | Query basis | Pass |
|---|---|---|
| Errors | `status = 'failed'` share of turns | ≤ 2% and not above TrueForge's last 2 weeks |
| Latency | `ended_at - started_at`, p50 and p95 | p95 ≤ TrueForge's p95 + 10% |
| Cost | `cost_micro_usd` per turn and per athlete per day | within 20% of the POC estimate (~$0.0008 per turn on gpt-6-luna); no day cap hits that TrueForge would not have hit |
| Tool error rate | `tools_called[].outcome = 'error'` share of calls | ≤ 5% |
| Proactive | SPEAK / SILENT / DEFER mix on `trigger = 'event'` turns | no message sent that the decision should have kept silent (spot-check 20) |
| Isolation | logs `mastra tool: athlete pass refused`, `TenantGuardError` | zero outside tests |
| Deletion | delete one test athlete with Mastra history | receipt complete; `mastra.*` rows for them = 0 |

Monitoring: Cloud Logging filter `jsonPayload.msg="mastra turn"` (fields: `engine`, `status`, `ms`, `microUsd`,
`toolErrors`); Langfuse traces named `mila.turn` (ids, numbers and tool names only; no conversation text).

## Step 4: owner phone check

On the dev build, the owner uses Mila for a normal session: a chat with a tool (deals, facts), one approval card tapped,
one proactive message. Pass: nothing feels different or slower. Owner signs off here.

## Rollback (tested)

Since P1 (5 Nov 2026) the rollback goes to **the harness** (what prod runs today):

```
gcloud run services update nomila-v2 --region=us-central1 --update-env-vars MILA_ENGINE=harness
# prod: gcloud run services update nomila-v2-prod --region=us-central1 --project=gamechanger-pocket-agent --update-env-vars MILA_ENGINE=harness
```

Then set `MILA_ENGINE` to `"harness"` (or `"trueforge"`, read the same) in the YAML too, or the next deploy switches
back. On the harness a conversation continues from its chat rows (the harness replays `chat_messages`); Mastra's tool
results are not carried. Proactive, the Mila-hosted waitlist and chat v2 are off until `MILA_ENGINE` is `mastra`
again. A gradual cutover without a global flip: keep `MILA_ENGINE=harness` and set
`MILA_MASTRA_ATHLETES=<id>,<id>`; clearing it moves those athletes back. The list moves nobody while the service has
no `NOMILA_MCP_PASS_KEY` (a listed athlete stays on the harness), so set the key first. Pinned by `engine.test.ts` and
`routes/chat.engine.test.ts`.

What follows describes the old rule (TrueForge as the fallback, dev only):

What happens to a conversation when the engine changes (either way). Each conversation's row records the engine that
ran its last turn (`mila_tf_sessions.last_engine`, 0147; rows from before 0147 count as Mastra's when the mapping is
`mastra:<id>`, else TrueForge's).

- **Mastra → TrueForge (rollback).** On the conversation's next message TrueForge opens a NEW session under the same
  row (a `mastra:` mapping is never sent to TrueForge; an old TrueForge session from before Mastra is not reused,
  because it misses Mastra's turns). That first turn gets the new-session preface and, as app updates, the
  conversation's last 10 chat rows (her words and Mila's, oldest first, each clipped to 600 characters, without the
  message being answered). It does not get Mastra's tool calls or results, only the text in the chat.
- **TrueForge → Mastra (switching forward again).** The same: if a Mastra thread already exists for that row it is
  deleted (it misses TrueForge's turns), and the first Mastra turn gets the preface plus the last 10 chat rows.
- Nothing else changes: the chat history in the app, cards, approvals waiting on a tap and queued app updates stay.
- Tested: `mastraTurn.db.test.ts` M7 (both directions) and `engine.test.ts`.

## Production

Not part of this PR. Prod's YAML says `MILA_ENGINE=trueforge`, which since P1 means the harness, and
`scripts/prod-flag-guard.ts` refuses a deploy that would set anything but `trueforge` or `harness` (or name athletes in
`MILA_MASTRA_ATHLETES`) unless the live service already has it. Switching prod is the owner's call, after Steps 1–4,
and needs `OPENAI_API_KEY` (prod's own key) and the Mila surfaces turned on first.

**Node 22 and pg 8.23.1 reach prod with the next promote.** The Docker image is shared: it moved from
`node:20-slim` to `node:22.22-bookworm-slim` (same Debian, so the same ffmpeg 5.1). The top-level `pg` driver, shared
by the whole API, moved from 8.21.0 to 8.23.1 (what `@mastra/pg` needs). Verified on this branch: clean install,
`tsc`, the test suites above, and CI on Node 22.22.

**HARD GATE before any prod promote** (whatever the engine flag says): the Node 22 image builds, the dev deploy boots
and serves on it (Step 2), and one Studio video job (ffmpeg) completes on dev. No promote until all three are done.

**Prod connection budget (before prod runs Mastra).** Mastra's store has its own pool of 4 connections per instance,
opened only when `MILA_ENGINE=mastra` (it is built lazily, so prod on TrueForge opens none). Prod's
`nomila-prod-db` (db-g1-small) allows about 50 connections, minus 3 reserved; today it runs maxScale 4 × `DB_POOL_MAX`
10 = 40. With Mastra on: 4 × (10 + 4) = 56, over the limit. Before switching prod to Mastra, either set
`max_connections=100` on the instance (restart) or lower `DB_POOL_MAX` to 7 (4 × (7 + 4) = 44). Dev: 3 × (5 + 4) = 27 of
100. **Done (Nov 2026, chore/db-pool-budget):** the prod YAML sets `DB_POOL_MAX=7` and `MILA_MASTRA_POOL_MAX=4` (the Mastra
pool is now configurable), and `server/lib/dbPoolBudget.test.ts` fails CI if maxScale × (both pools) passes 45 (prod) or 95
(dev). It reaches the live service with the next promote.

## Removing TrueForge (only after all of the above pass)

1. A full release cycle on dev with Mastra and no rollback.
2. Prod switched to Mastra by the owner and soaked with the same criteria.
3. Then, in its own PR: remove `agent/tf/chat.ts` turn code and the TrueForge client, keep `/mcp` only if another caller
   needs it, keep `deleteAthleteTfSessions` until every athlete's TrueForge sessions are confirmed deleted, drop the
   `TRUEFORGE_*` settings from the YAMLs.
