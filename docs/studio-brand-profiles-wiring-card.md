# Card — wiring brand profiles into the Agent planner (after PR 2 merges)

**Status:** CARD, 22 Sep 2026. Nothing here is built. PR 3 (`studio/brand-profiles`) stops at the boundary below,
on purpose. PR 2 (`studio/c3-doctrine2`) owns `server/studio/agent/*` and `AgentScreen.tsx` until it merges.
**Spec:** `docs/specs/creative-architecture.md` (Mia's). §5 is the Creative Spec, §7 is Reference Decomposition.

## The boundary: what PR 3 built, and where it stops

Everything PR 3 built is callable **in-process only**:

| Built in PR 3 | Where |
|---|---|
| `studio_brand_profiles` and `studio_reference_analyses` (migration 0060) | `migrations/0060_studio_brand_profiles.sql`, `shared/schema.ts` |
| Profile store: create, list and get, plus a profile's analyses; athlete-scoped | `server/studio/reference/store.ts` |
| The engine: `decomposeReference()`, one call, flag-gated | `server/studio/reference/decompose.ts` |
| The stored decomposition shape (zod, strict) | `server/studio/reference/schema.ts` |
| `CampaignBrief` (campaign-brief/1) + `validateCampaignBrief()` | `server/studio/campaign/brief.ts` |

**Nothing** in `server/studio/agent/**`, `server/routes/**` or `client/**` imports any of it. `git grep "studio/reference\|studio/campaign" -- server/studio/agent server/routes client`
returns nothing at the PR 3 tip. That grep is the boundary check.

## What the wiring adds, in order, each separately revertible

1. **Profile routes, behind `STUDIO_BRAND_PROFILES`** (404 when off, like `agentEnabled()`):
   - `POST /studio/brand-profiles`, `GET /studio/brand-profiles` and `GET /studio/brand-profiles/:id/references`. All go through `requireAuth` and `req.athleteId!`.
   - `POST /studio/brand-profiles/:id/references` takes `{ source: { kind: "image", assetId } | { kind: "brief", text }, role }`. It calls `decomposeReference` and returns the model and cost.
2. **`PlanAsk.campaign?: CampaignBrief`.** This is a new optional field beside `aesthetic` and `sport` in `agent/types.ts`. The route's `AGENT_BODY_KEYS` gains `campaign`, and the route runs `validateCampaignBrief` before the planner sees it. A brief that fails validation is a 400 naming its issues, never a silent drop.
3. **A fenced CAMPAIGN block** in `agentPrompt`, next to `ASK_OPEN`, `LIBRARY_OPEN` and `PRODUCTS_OPEN`:
   - The brief is model- or picker-written, so it is **data**: every string goes through `fenced()`.
   - `PlanAsk.prompt` stays her own words and is never merged with the brief.
   - A reference's `intent` goes in as its summaries and tags only.
4. **Handle resolution.** `product_1` and `ref_1` resolve server-side against HER library and HER analyses, the way LIBRARY handles do today. A handle that resolves to nothing is dropped and shown, never guessed.
5. **CreativeSpec storage (spec §5: "stored … every revision creates a new version").** This is the deferred table, landing here with its first writer. Proposed: `studio_campaign_briefs (id, athlete_id, lineage_id, version, brief jsonb, created_at)`, with a unique `(lineage_id, version)`. It is migration 0061 or later, and needs Mia's DDL approval.
6. **The image compile and the style slot.** A profile's analyses reach `BrandProfileInput` (`interpret/core.ts`) as extra fenced fields. Tagged refs through `RefCapacity.style` are the old card's step 4, and they compete with cover and gallery imagery. See `docs/studio-brand-profiles-card.md` §3.

## Open items for Mia (none blocks PR 3)

- **The five required dimensions.** Camera, lighting, composition, color and mood (keyed `emotional_tone`), built as decided. She confirms this async.
- **The spec's values that are missing from its own vocabularies.**
  - §5 `goal: product_awareness` is not in the house `BriefObjective`; the fixture maps it to `showcase-product`.
  - §5 `style: premium_sports` is not in §8's Commercial styles; the fixture maps it to `sports_campaign` and keeps "premium" as a tone.
  - §12 `location: stadium_tunnel` is not in §8's environment list. The probe tagged a tunnel `studio` for lack of a better word.
- **Over-inference on minimal briefs** (probe finding 1). "a soccer ad with me in it" came back with all twelve dimensions filled. Should `reference/2` keep optional dimensions null unless the brief implies them? The re-probe costs about $0.006.
- **`objective.type`** (`brand_campaign` | `ad` | `social_content`) and the `maximum` | `high` | `standard` priorities are ours; the spec shows one value of each.
