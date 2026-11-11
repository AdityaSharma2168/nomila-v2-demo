# Workflow runner — the durable process layer

**Status:** PR 1 of the onboarding workflow. Design note (with rationale, alternatives considered
and the three confirmed decisions): the *Workflow Runner Note* artifact; companion designs:
*Onboarding Workflow Design* and *Agentic Architecture Review* (3 Sep 2026).

## What it is

A small, Postgres-only runtime for multi-step processes: onboarding, Studio generation, the
weekly plan, scheduled refreshes. Two tables, one registry, one tick, one endpoint.

- `workflow_runs` — one row per process instance, pinned to a definition version.
- `workflow_steps` — **append-only**, one row per step attempt. Ready rows are the queue; the
  table is also the audit trail.
- `server/workflow/registry.ts` — definitions are code (`defineWorkflow`), versioned, kept for
  as long as a run references them.
- `server/workflow/runner.ts` — `startRun`, `kick`, `tick`, `completeStep`, `retryRun`,
  `cancelRun`, `expireLeases`.
- `POST /api/internal/workflow-tick` — Cloud Scheduler, every minute, under an advisory lock.
- `POST /api/v1/me/workflow/runs/:id/steps/:step/complete` — the one door for `await_human`
  steps (landing page, Mila chat, voice worker all call it).
- `/api/v1/admin/workflow/*` + `admin/runs.html` — list, detail, retry, cancel.

## Step kinds

`code` · `model` (a code step that calls a model; same runtime, filterable) · `await_human`
(run parks; `payload()` renders, `complete()` writes) · `schedule` (ready at a future time).
`parallel: true` makes a step share its predecessor's ordinal; the run advances when the whole
ordinal is done.

## Guarantees (pinned by `server/workflow/runner.test.ts`)

- at-least-once execution; a step attempt is never claimed twice (`FOR UPDATE SKIP LOCKED`)
- a run whose process dies mid-step resumes after the lease expires
- retries follow exponential backoff with jitter (1 min → 5 → 25, three attempts), then the
  run fails **loudly** with the step name and error
- one active run per (athlete, process); a repeat `startRun` returns the existing run;
  `idempotencyKey` does the same across athletes
- payloads are references only and ≤ 8 KB — enforced
- a run keeps the definition version it started on
- `tick` runs a finished step's successors inline (`kicked`), so tick-driven runs move at step
  speed, not clock speed

## Rules for definition authors

- Steps are idempotent. Check before writing, or key writes so a repeat is a no-op.
- Return ids, never documents. Langfuse holds prompts and responses; the step holds `trace_id`.
- Throw on failure. Never swallow; the runner records and retries.
- A definition change is a new version. Never rename or reorder steps inside a live version.
- Config (prompts, thresholds, question lists) lives in the prompt registry, not in the step.

## Deliberately not here (yet)

Cloud Tasks dispatch (steps run inside the tick or kick; add when a step outgrows a few
minutes), a `notify` step kind, retention/archive of finished runs (PR 4), any workflow
definition (onboarding is PR 2).

## Borrowed

From Trigger.dev (Apache-2.0): idempotency keys on start, the retry policy shape
(`maxAttempts/factor/min/max/randomize`), the run/attempt status vocabulary. Not borrowed: its
run engine (Redis + Lua + container supervisor) — self-hosting it was assessed and declined;
its cloud was declined on data-residency grounds.
