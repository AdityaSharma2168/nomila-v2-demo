# Shared LLM concurrency / resilience wrapper — spec + blast radius

Status: proposal (not implemented). Separate from the R1 scoring work.

## Problem (recap)
Every model-calling subsystem fans out with unbounded `Promise.all`/`allSettled` and draws on
the **same Vertex (Kimi) / Gemini quota with no coordination**. Per-call retry exists on the
research/search side (ad-hoc, 3 different implementations) but not in the deal pipeline, and a
**global concurrency limiter exists nowhere**. Result: a Gmail push with N messages fires ~3N
concurrent Kimi calls; multiple mailboxes multiply it → 429 cascade. `kimiInstant` also has no
timeout, so a hung Vertex call blocks indefinitely.

## Design decision that keeps the blast radius small
**Put the limiter at the call primitive (`kimi.ts` + the Gemini client), not at each fan-out
site.** Then every caller and every unbounded `Promise.all` is automatically bounded — they just
enqueue into the shared gate — with **zero changes to callers**. We do NOT rewrite the fan-out
sites; we make the thing they call self-throttling.

## Interface — `server/lib/llm.ts`
```ts
// Bounded concurrency across the whole process, per provider (separate quotas).
export const kimiGate   = createGate(Number(process.env.KIMI_MAX_CONCURRENCY   ?? 10));
export const geminiGate = createGate(Number(process.env.GEMINI_MAX_CONCURRENCY ?? 8));

// Retry with exponential backoff + jitter — lifted from researchAthlete.runGeminiWithRetry,
// generalized. Retries on 429 / 5xx / empty response; gives up after `attempts`.
export function withRetry<T>(fn: () => Promise<T>, opts?: {
  attempts?: number; baseMs?: number; label?: string; retryable?: (e: unknown) => boolean;
}): Promise<T>;

// Reject if the underlying call doesn't settle in time (lifted from researchAthlete's local one).
export function withTimeout<T>(p: Promise<T>, ms: number, label?: string): Promise<T>;

// Compose: gate → retry → timeout. One call for model work.
export function callModel<T>(gate: Gate, fn: () => Promise<T>, opts?: {
  timeoutMs?: number; attempts?: number; label?: string;
}): Promise<T>;
```
`createGate` is a tiny in-process semaphore (≈ p-limit). No new infra, no external dependency
required (or use `p-limit` if preferred).

## Where it plugs in
`kimi.ts` — wrap each function body once:
```ts
export async function kimiInstant(system, user, jsonMode = false) {
  const kimi = await getVertexClient();
  return callModel(kimiGate, () => kimi.chat.completions.create({ ...same as today }),
    { timeoutMs: 60_000, attempts: 4, label: "kimiInstant" });
}
```
Same for `kimiThinking`. For Gemini, route `researchAthlete`/`researchBrand`'s `generateContent`
through `callModel(geminiGate, …)` and delete their local retry loops.

## Blast radius
| Change | Files |
|---|---|
| **New file** | `server/lib/llm.ts` (gate + withRetry + withTimeout + callModel) |
| **Wrap primitives** | `lib/kimi.ts` (`kimiInstant`, `kimiThinking`, `kimiStream`†, `kimiSearch`), the Gemini call path in `researchAthlete.ts` + `researchBrand.ts` |
| **Consolidate (delete ad-hoc)** | `researchAthlete.ts` `runGeminiWithRetry` + local `withTimeout` → shared; `gdelt.ts` + `fetchSocialData.ts` retry loops → shared `withRetry` (HTTP, **not** the LLM gate — different quotas) |
| **Auto-covered, NO change** | all 7 Kimi call sites (`threadSummarizer:93`, `researchBrand:104`, `researchAthlete:326`, `dealDetector:527/717`, `chat:143/159`, `deals:398`) and every unbounded fan-out (`webhooks:117`, `instagramSync:27`, `platformDiscovery:306`, `researchAthlete:505/548`, `researchBrand:85`, `collectSocialAnalytics:139`) |

So the real edit surface is **`kimi.ts` + the Gemini path + retiring 3 retry loops** — the dozen
fan-out/call sites come along for free.

## Config / sizing
- Two gates (Kimi/Vertex and Gemini have separate quotas). Env-tunable.
- Size to `provider req/min quota ÷ 60 × avg call seconds`, with headroom. Pull the actual Vertex
  quota first; start conservative (Kimi ~10, Gemini ~8) and raise.

## † Streaming caveat (the one non-trivial part) — and the streaming-timeout follow-up
`kimiStream` (chat, deal draft) holds a connection for the stream's duration. Gate it by
**acquiring a slot at initiation and releasing on stream end/abort**; retry only on
connection-establishment failure — **no mid-stream retry** (can't safely replay a partially
consumed stream).

**Streaming timeout — the explicit follow-up.**
> **Trigger: real athlete usage of chat / draft-reply.** This is our **only user-facing hang
> path** — every other Kimi call is background (classify/score/summarize/research). So it's the
> **highest-visibility hang risk the moment someone is actually using the product**: a hung
> classify stalls a queue silently, but a hung chat/draft freezes the screen a person is staring at.

The non-streaming timeout shipped in the durability changeset (`kimiInstant`/`kimiThinking`); `kimiStream`
has **none** today, so a hung stream can still hang. A stream needs a **first-token (TTFT) timeout**,
not a total one — a long spoken/written answer is legitimate, but silence at the start is the failure
to catch. Implement as: reject if no first chunk within ~10s, then let the stream run unbounded (or
to an idle-gap timeout between chunks). It's also the gating requirement before building a
conversational **voice/text agent** — that agent's user-facing response routes through `kimiStream`
(not `kimiInstant`, which is one-shot by contract), so it inherits `kimiStream`'s lack of a TTFT bound.

## What this does NOT fix (still phased, tracked separately)
- **Throughput**: the gate makes bursts *safe*, not *fast*. A 200-email onboarding still drains
  through the gate serially-ish. The **durable queue** (Cloud Tasks → worker) is the phase-2
  answer for throughput + backpressure.
- ~~**Durability**: cursor-before-processing + no idempotency gate~~ — **SHIPPED** in the inbox
  durability changeset (`docs/inbox-durability-changeset.md`, PR #35): non-streaming timeout,
  cursor-after-processing, idempotency-gate-before-classify. The *residual* durability gap (ack-first
  means a reclaimed instance still relies on next-notification + cron) remains the **durable queue**'s job.
- **Streaming timeout** for `kimiStream` — see the follow-up above; prerequisite for a voice/text agent.
- **Redundant calls**: 3 Kimi calls/message, re-run on every reply. Add the material-change gate
  (deferred Phase 2 #9) — ~⅓ cost off active threads.

## Deferred work — triggers (when to build each, and why)

**1. Shared wrapper — gate + retry consolidation (this doc).**
> **Trigger: the 2nd/3rd *simultaneously active* mailbox generating real burst load.** The trigger
> is **concurrent push simultaneity, not mailbox count** — it is **NOT** tripped by one user who
> connects several mailboxes (their pushes still arrive roughly serially). What trips it is
> multiple *independent* accounts receiving mail at the same moment, so their `Promise.allSettled`
> fan-outs stack ~3 Kimi calls each onto the shared Vertex quota with no coordination → 429 cascade.

Why it's cheap: the gate lives at the call primitive (`kimi.ts` + Gemini client), so all callers
and fan-outs are covered with no rewrites. It makes bursts **safe**, not **fast** — throughput is
the queue's job (below).

**2. Durable queue + material-change gate — the real "scale to many users" answer (phase 2/3).**
> **Trigger: sustained multi-user load — when the wrapper is throttling enough that latency or the
> `droppedCount` log becomes visible.** Size dispatch rate against *observed* load, not a guess.

Not the wrapper. The wrapper bounds a burst; the queue (Cloud Tasks → worker) delivers three things
the wrapper can't: **throughput** (onboarding a 200-email mailbox drains through a gate serially-ish),
**full cursor durability** (enqueue+ack means a reclaimed instance can't lose messages — closes the
residual ack-first gap the durability changeset left open), and **DB-ceiling relief** (worker
concurrency decoupled from webhook fan-in, so pool max 20 × N instances stops racing Cloud SQL's
`max_connections`). Also folds in **redundant-call reduction** (skip re-summarize/re-score when the
offer didn't materially change — the deferred Phase 2 #9, ~⅓ cost off active threads).

**3. Streaming (TTFT) timeout for `kimiStream`.** Trigger + rationale in the Streaming section above
(only user-facing hang path; prerequisite for a voice/text agent).

**4. Dead-code cleanup (whenever, low priority).** `kimiThinking` and `kimiSearch` currently have
**zero callers** in `server/` (verified). Remove or wire them; until then they're just surface area.
