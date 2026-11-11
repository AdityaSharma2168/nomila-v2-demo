# Jobs at connect — the first workflows (PR 2 of onboarding)

**Design:** the *Jobs at Connect Note* artifact (3 Sep 2026, all four items confirmed).
**Runner:** `docs/plans/workflow-runner.md`.

## The three definitions (`server/workflow/definitions/`)

| Process | Started by | Idempotency key | Steps |
|---|---|---|---|
| `onboarding` v1 | signup (waitlist route once a sport is known; app signup when it sends one); admin promote as a safety net | `onboarding:<athleteId>` | `research` (model) → `context_ready` (code) |
| `first_look` v1 | OAuth callback for instagram / tiktok / youtube | `connect:<connectionId>` | `fetch_social` ∥ `backfill_recent` → `compute_first_look` (model) |
| `research_refresh` v1 | admin promote with `reresearch: true` | — | `research` (model) |

Rules that hold across them:

- **Known handles win.** Typed at signup (`athletes.socials`) or connected (`connected_accounts.platform_username`) handles override anything research extracts, so platform discovery never runs on a guess when a real handle exists (`collectKnownHandles`).
- **Proof of work, not trust.** `fetch_social` requires a *new* `social_connect` snapshot after the call; the underlying skill swallows provider errors by design, so the step checks the outcome and fails the attempt otherwise.
- **The first look never blocks on the model.** Themes and tone come from one Flash call (`first_look.themes`, registry, unlocked); a failure stores the look with empty lists and the error.
- **Not a scoring input.** `athlete_snapshots.first_look` is a document for Mila and the cards. Scoring reads `research`, `social`, `deals`, trends and news only.

## The cleanups

- `server/services/athletesCurrentWriter.ts` — the only writer of `athletes_current`. v3 rate card always; pav and deal-type rates projected from it; research columns when research ran; timestamps per what changed.
- `buildSearchName()` in the research skill — one place, three callers.
- `shared/goals.ts` — the goal vocabulary; the waitlist route rejects unknown values; `waitlist.goals.test.ts` pins the landing page's list to it.
- Promotion no longer researches and no longer writes a `tasks` row.

## Next (PR 3)

The Mila conversation as `onboarding` v2: greeting + what we know (from research and the first look), corrections written without a tap under the agreed exception, two discovery questions, the brand-relationships question with one reconcile line, the two doors. Tables `athlete_asserted` and `brand_relationships`. `get_athlete_context` with provenance and `score_inputs`.
