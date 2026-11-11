# A services architecture — wrapping Nomila as APIs other applications can call

> **Status:** design, for review. Nothing implemented.
> Companion to `agent-runtime.md` (§8 decides Studio's runtime, which is itself a service).
> **Sequenced with the other two workstreams in [`00-roadmap.md`](./00-roadmap.md).**

---

## 1 · You already have a services architecture. It has one consumer.

This is the useful starting point, because the pattern is proven in production rather than
theoretical: **the voice worker is a separate application, in a separate repository, calling
Nomila over HTTP.**

- `mila-voice` — a LiveKit Cloud agent, its own repo, its own deploy, holding the voice model,
  its prompt and its tools.
- It calls `/api/internal/voice/*` on `nomila-v2` for everything it knows about an athlete:
  score, score history, deal brief, brand brief, threads, transcript, profile, web search.
- Authenticated by a shared secret, `VOICE_SERVICE_SECRET`, in an `x-voice-secret` header.

So the question is not "can we do this" — it is **"how do we generalise the tier we have to a
tier we can hand to someone outside the company."** Those are different problems.

## 2 · Two auth tiers exist. The third one is the whole job.

| Tier | Who | How the athlete is identified | Blast radius |
|---|---|---|---|
| **User** | the athlete's own app session | `req.athleteId`, derived server-side from the token — never from the request body | one athlete |
| **Trusted infrastructure** | our own workers (`mila-voice`, Cloud Scheduler) | **from the URL path**, with a shared secret as the only check | **every athlete** |
| **Third party** | another company's application | *does not exist* | — |

`server/voice/auth.ts` is admirably blunt about what tier 2 actually is:

> *"The caller is TRUSTED INFRASTRUCTURE, not a user — there is no session and no `req.athleteId`,
> so the athlete id comes from the path and this secret is the ENTIRE authorization boundary.
> **Whoever holds it can read any athlete's data.**"*

That is the correct design for our own worker and **exactly the wrong design for a partner.** A
third-party tier is not tier 2 with the secret shared more widely; it is a different model:

- a **per-client credential**, revocable independently, so one partner's leak is one partner's
  problem;
- **scopes** — read analytics ≠ read deals ≠ post on her behalf;
- and **per-athlete consent**, because the athlete, not us, decides which partner sees her
  contracts. Tier 2 has no concept of this at all.

`brand_api_keys` (`shared/schema.ts:757`) was where this was supposed to go, and it is **entirely
dead**: no foreign key, no reader, no writer, and no `brandAuth` middleware anywhere in `server/`.
Its own comment says *"All brand routes return 501 until Phase 2 launch"* — **no route in the
repo returns 501.** The comment is aspirational, not stale-but-once-true. The only routes actually
at `/api/v1/brands/*` are athlete-facing brand lookups behind `requireAuth`. Tier 3 was sketched
in a table comment and never started.

## 3 · You already have two URL shapes, and the second one duplicates the auth check

I first wrote that everything is `/api/v1/me` and the resource shape would need adding. **That was
wrong, and the truth is more useful.** Both shapes already exist in the user tier:

- `/api/v1/me/*` — 19 routers, where tenancy is structural because there is no id to tamper with.
- `/api/v1/athletes/:id/*` — about fifteen routes, where **every single one hand-rolls the same
  guard**: `if (req.athleteId !== req.params.id) return 403` (`index.ts:244`, `719`, `761`, `1132`,
  and a dozen more).

So the duplication is not a future cost — **we are paying it now, in fifteen copies of the check
that `/me` exists specifically to avoid.** And a third copy of the pattern exists in tier 2: the
voice worker's `/api/internal/voice/athletes/:id/score`, `/deals`, `/profile`
(`voice/scoreRoute.ts:88`, `dealRoutes.ts:376`, `profileRoute.ts:59`) — a second route tree over
the same data, written because the first one was `/me`-shaped.

**The fix is consolidation, not addition.** One canonical resource shape,
`/api/v1/athletes/{id}/…`, with the ownership check in **one** middleware; `/me` becomes an alias
that resolves `{id}` from the token and hits the same handler. That removes fifteen hand-written
403s, gives a partner a URL that makes sense, and lets the voice tree collapse into the same
handlers with a different guard.

**Versioning needs the same treatment.** There are currently five namespace shapes:
`/api/v1/me`, `/api/v1/athletes/:id`, unversioned `/api/card` and `/c/:shareId`, unversioned
`/api/internal`, and bare top-level (`/pay`, `/confirm`, `/deposit`, and — oddly —
`POST /voice/token`, a real authenticated user endpoint with no `/api` or `/v1` at all). About
**140 routes** in total, of which **46 are defined inline in `index.ts`** (a 1,930-line file),
including the entire card/share surface. An API product cannot have its public surface living in
the entrypoint.

## 4 · The logic is already service-shaped — better than I assumed

The thing that usually makes this migration painful is absent. A search for Express
`Request`/`Response` types across `server/services/**`, `server/skills/**`, `server/studio/**` and
`server/mila/tools/**` returns **zero matches**. Roughly 190 exported functions, all taking plain
arguments and returning plain values. `routes/studio.ts` describes itself as *"A THIN HANDLER,
DELIBERATELY. All the thinking already exists."*

`server/mila/tools/*` is the standout: `execute(athleteId, args)` with a Zod-validated args object
and a server-injected athlete id, returning JSON-serialisable data. **That is already an internal
RPC layer** — twelve functions that could be exposed with almost no adaptation.

And where services do report progress, they take a **generic callback**, not the response object:
`onStep: (label: string) => void`, wired to SSE by the route (`kitCache.ts`, `pitches.ts`).
Studio's core takes a plain `AbortSignal`. That is the right pattern and it is used consistently.

**One real offender, and it is an important one.** `server/mila/loop.ts` takes an `SSEStream` as a
**required** parameter and drives it throughout (`loop.ts:57`, and `sse.status/token/done` calls at
`264`, `299`, `352`, `413`, `477`). So the single most valuable piece of logic in the product —
answering a chat turn — **has no plain "run a turn, return a result" entry point.** Another
application cannot call Mila without fabricating an object that satisfies the SSE interface. If
one thing gets refactored for this architecture, it is this: give the loop a callback-shaped
transport like every other service already has.

**Correcting something else I said:** I claimed Studio streams. It does not — and that is good
news. `POST /studio/generate` starts a job and the caller polls `GET /studio/jobs/:jobId`
(`routes/studio.ts:527`, `591`). **Studio already implements the job-shaped pattern this document
recommends**, which makes it the easiest surface in the app to expose to another application and
a working template for the rest.

The genuinely hard endpoints are three: `POST /api/v1/me/chat`, and the two pitch streams
(`index.ts:786`, `818`). A non-browser caller would have to speak `text/event-stream` and parse a
bespoke, undocumented event vocabulary (`status`/`token`/`done`/`suggestions`/`profileUpdates`/
`error`, `lib/sse.ts:3-18`).

## 5 · Four gaps that are invisible today and blocking the day a partner arrives

None of these hurt while the only caller is our own app. All of them are load-bearing for anyone
else.

- **Roles are write-only.** `account_roles` supports `athlete | fan | brand | school_admin | admin`
  and is populated at signup — but **only `admin` is ever checked** (`lib/auth.ts:99`,
  `routes/admin.ts:44`). There is no authorization branch on `fan`, `brand` or `school_admin`
  anywhere in the server. Concretely: **an account with role `brand` has exactly the same access as
  an athlete** to every `/me` and `/athletes/:id` route, because they all key off `req.athleteId`
  alone. The scaffolding for a brand persona exists and enforces nothing.
- **No pagination convention.** Every list endpoint hard-caps a different hand-picked number —
  `.limit(100)`, `50`, `30`, `20`, `8` — with no cursor and (with one exception) no client control.
  **Any list longer than the cap is silently truncated with no way to fetch the rest.** That is
  acceptable for a UI that shows a screenful; it is a correctness bug in an API.
- **No client-supplied idempotency.** Idempotency exists inside specific payment paths as
  server-derived Stripe keys, but there is no `Idempotency-Key` header support anywhere. A partner
  has no safe way to retry a POST.
- **`shared/` is not shared.** It holds one file — the Drizzle schema — and **nothing under
  `client/` imports it.** Every client hook hand-writes its own interface for the response shape,
  with no compile-time link to what the handler actually returns, and five hooks fall back to
  `any`. The drift is silent today; published to a partner it becomes a support burden.

Rate limiting covers four endpoints (draft, chat, voice-token, auth); everything else is unlimited.

## 6 · The design

**Four services, one API front door.**

```
                    ┌─────────────────────────────────────────┐
   partner app ───► │  api.nomila.co   —  the ONLY public door │
   athlete app ───► │  tier 1 (session) · tier 3 (client key)  │
                    └───────────────┬─────────────────────────┘
                                    │  tier 2, internal only
                ┌───────────────────┼────────────────────┐
                ▼                   ▼                    ▼
        mila-voice worker    Agent Server (§8)     Cloud Scheduler
        (LiveKit, own repo)  (Studio's graphs)     (cron skills)
```

Five rules that make this hold:

1. **One public door.** Partners talk to our API and nothing else. In particular the **Agent
   Server is tier 2, never public** — it has its own auth model, its own run/thread/assistant API,
   and exposing it would mean partners depending on LangGraph's surface instead of ours. Front it.
2. **Tenancy is checked in one place, per tier.** Tier 1 derives the athlete from the token; tier
   3 checks *client → athlete consent → scope* before the handler runs; tier 2 stays a secret and
   stays internal. No handler re-implements this.
3. **The API is versioned and typed.** `/api/v1` already exists as a prefix; make it a contract —
   an OpenAPI document generated from the route schemas, so a partner gets a client rather than a
   PDF. Zod is already a dependency and already describes tool arguments; the same schemas can
   describe request bodies.
4. **Long work returns a job, not a held connection** — and **Studio already does this**
   (`POST /studio/generate` → `GET /studio/jobs/:jobId`). Generalise Studio's pattern rather than
   inventing one: a partner gets `202` and a run id, then polls or receives a webhook. It is also
   the same conclusion `agent-runtime` §8 reaches for video, and it makes SSE an *optional
   upgrade* for our own clients rather than the only way in.
5. **Every response is athlete-scoped and consent-gated.** Contracts, inbox content and rate cards
   are the crown jewels; a partner scope should have to name them explicitly, and the athlete
   should be able to see and revoke what she granted. `card_shares` already models revocable,
   scoped, expiring access to a *deck* — the same posture, generalised.

## 7 · What to build, and when

The honest ordering, given that Studio is the current focus and there are no external callers yet:

| | Step | Size | When |
|---|---|---|---|
| **A** | **Consolidate the two URL shapes** onto one canonical resource path with a single ownership middleware; `/me` becomes an alias. Move the 46 inline routes out of `index.ts`. | S–M | **Now** — it deletes fifteen copies of a hand-written 403, and only gets more expensive |
| **B** | **Generate an OpenAPI document** from the existing routes; publish types the client imports instead of hand-writing | S–M | Now-ish; it is also how the founder sees what the platform can do |
| **C** | **Job-shaped responses for long work** (`202` + run id + status endpoint) | M | With Studio's Agent Server — the same change, done once |
| **D** | **Tier 3: client credentials, scopes, per-athlete consent** — finally build `brand_api_keys` | M–L | When there is a real first partner. Design it now, build it then. |
| **E** | Rate limiting and quotas per client, `Idempotency-Key` on writes | M | With D |
| **F** | **A cursor-pagination convention** on every list endpoint | S | Now-ish — today lists silently truncate, which is a bug an API contract would expose |
| **G** | **Give `mila/loop.ts` a callback transport** so a chat turn can be called without an SSE object | S | Whenever Mila needs a second caller — it is the only genuinely coupled service left |

**A and B are worth doing now even with zero external callers**, because they are how the founder
and any future partner *see* the system, and because A is a rename that only gets more expensive.
D should wait for a real partner — building a permission model against an imagined one is how you
get the wrong model.

## 8 · How this interacts with the Studio runtime decision

Adopting the Agent Server (`agent-runtime.md` §8) **adds a third service**, and that is the moment
to set these conventions rather than after. Three specific consequences:

- **The Agent Server is internal.** Our API calls it; partners never do. That keeps LangGraph an
  implementation detail we can replace, rather than a contract we have published.
- **Job-shaped responses (step C) stop being optional.** Once generation runs as a queued,
  resumable run, "202 + run id" is the natural response shape anyway — so do it once, for both the
  app and any partner.
- **Trace context should cross the boundary.** If tracing lands first (`agent-runtime` §4), a
  request id propagated from the API into the Agent Server and into the voice worker makes one
  trace out of three services. Cheap if designed in, painful to retrofit.
