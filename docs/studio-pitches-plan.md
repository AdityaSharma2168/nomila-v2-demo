# Studio + Pitches — build plan

Status: **Phases 0–5 built** (on `feat/studio-pitches`, typechecks clean, Phase 0 + Gate-2 insights DB-verified) · Phase 6 (cross-tab echoes) deferred

Brand-specific pitch decks get a real front-of-house: a **Studio** creator-workspace tab (today an empty
placeholder — `MainTabNavigator.tsx:173`), a searchable **Pitches** library, per-pitch detail, and an
**agentic, confirmation-gated create flow** with a live agent-step timeline. The generation engine already
exists and is untouched; this is almost entirely front-of-house plus one backend refactor (Phase 5).

Design reference: the tappable Fable prototypes (Pitch Spine, Studio hub, Pitches list, PitchDetail,
create flow). This doc is the implementation counterpart.

---

## The Pitch object & status model

A **Pitch** is the brand-specific kit row we already store — `media_kits` keyed `(athlete_id, brand_id)`
with `brand_id > 0` (`brand_id = 0` stays the public/generic card). No new "pitch" table. Status is
**derived** from tables that already exist:

| Status | Derived from |
|---|---|
| `tailoring` | build in progress / requested-not-yet-cached (transient; persisted only once the pausable builder lands in Phase 5) |
| `ready` | `media_kits` row exists (`brand_id>0`), never shared |
| `sent` | a non-revoked `card_shares` row exists for `(athlete_id, brand_id)` → `sent_at = min(created_at)` |
| `opened` | any `card_share_views` row for those shares → `opens_count`, `last_opened_at` |
| `failed` | build errored (needs the build-state from Phase 5) |
| `stale` *(orthogonal flag)* | public card `media_kits(brand_id=0).generated_at` **or** `card_overrides.updated_at` is newer than this pitch's `generated_at` / last `sent_at` |

Schema facts confirmed (in `shared/schema.ts`):
- `mediaKits` `(athlete_id uuid, brand_id integer)` PK — `:621`
- `cardOverrides` same PK — `:635`
- `cardShares` has `athlete_id`, **`brand_id text`**, `tailoring 'generic'|'brand'`, `deal_id`, `revoked`, `created_at` — `:647`
- `cardShareViews` has `share_id`, `opened_at`, `dwell_ms`, `is_forward` — `:670`
- `inboxBrands.enrichment` jsonb already stores **`recent_campaigns`** (+ `brand_values`, `competitors`, `markets`) from grounded web research — `:223`

> Note: `cardShares.brand_id` is `text`, `mediaKits.brand_id` is `integer` — the derivation join must cast.
> Status is therefore ~zero-migration for Phases 0–3; the only genuinely new persistence is a build-state
> for `tailoring`/`failed`, introduced with the pausable builder in Phase 5.

---

## What already exists (so we don't rebuild it)

- **Grounded brand research for any brand** — `researchBrand()` (`server/skills/researchBrand.ts:70`): 4 parallel
  Gemini calls *with Google Search*, extracted to a rich record incl. `recent_campaigns`. Reachable for
  arbitrary brands via `getOrResearchBrand(..., {athletePicked:true})` (`brandIntel.ts:120`) →
  `POST /api/v1/brands/resolve` (`index.ts:557`). The BrandPicker "Add '{q}'" affordance already calls it.
- **SSE event streaming** — `server/lib/sse.ts` (`openSSEStream` with `status()`/`token()`/`done()` + keepalive +
  abort). In production for Mila chat (`server/routes/chat.ts`), with a proven client consumer
  (`client/hooks/use-mila-chat.ts`). The step-timeline reuses this transport.
- **The generation engine** — `assembleMediaKit(athleteId,{brandId})` (`server/services/mediaKitService.ts:115`)
  → `getBrandContext` + `deriveDeckPlan`/`deriveShotList` (Gemini) + `curateAthleteMedia` (Curator) +
  `narrateKit`/`narrateWhyFits` (Narrator multi-model). Cached per pitch in `media_kits` via
  `getOrBuildKit`/`buildAndCacheKit` (`server/services/kitCache.ts`).

Status vocabulary (locked): **pink** tailoring · **stone** ready · **blue** sent · **gold** opened · red failed.
Gold is reserved app-wide for "a brand is looking"; the loud "opened" event lives in Opportunities, quiet
gold echoes everywhere else.

---

## Phases

Each phase ends in something testable. Riskiest work (builder refactor) is last, after value is on screen.

### Phase 0 — Pitch contract + data plumbing · S · risk Low
- [ ] `server/services/pitches.ts`: `listPitches(athleteId)` + `derivePitchStatus()` off `media_kits` ⋈ `card_shares` ⋈ `card_share_views`, incl. `stale` compare.
- [ ] Surface `recent_campaigns` / `brand_values` in `getBrandContext` (`shotList.ts:30`) — data present, currently unread.
- [ ] `GET /api/v1/athletes/:id/pitches` → the derived list.
- **Test:** endpoint returns existing brand kits with correct statuses. No UI.

### Phase 1 — `usePitches` + PitchChip atoms · S · risk Low
- [ ] `client/hooks/use-pitches.ts` (list / create / rebuild / delete).
- [ ] `client/components/pitch/` — `PitchChip`, `PitchAvatar`, `PitchStatusDot`, `OpensPill` (status vocabulary).
- **Test:** atoms render across all statuses; hook returns live data.

### Phase 2 — Studio hub + Pitches list/search · M · risk Low–Med
- [ ] Replace `Studio` placeholder (`MainTabNavigator.tsx:173`) with `StudioScreen` (masthead, Card "source" band, Pitches shelf + status summary, Posts/Ads strip, Media row).
- [ ] `PitchesListScreen` (status filter row + local brand search).
- **Test:** open Studio → real pitch tiles, correct statuses, gold "opened" floats up, stale badge, search/filter work. **First "it's real" moment.**

### Phase 3 — brandId through native render + PitchDetail · M · risk Med
- [ ] Plumb `brandId` so native render serves the **brand-tailored** deck (today ignores it → generic).
- [ ] `PitchDetailScreen`: deck + look switcher (Campaign/Luxe/Broadcast/Immersive) + analytics echo + Share/Resend/Rebuild + stale→warn-before-resend.
- **Test:** tap tile → tailored deck, switch looks, warn-before-resend on a stale pitch.

### Phase 4 — Create flow: Gate 1 + Gate 2 · M · risk Med
- [ ] Expand `brands/resolve` response for the **confirm-brand card** (Gate 1: logo/name/category/handle/HQ/segment).
- [ ] New `GET .../pitch-insights` → `recent_campaigns` + `whyFits` angles for **Gate 2** (reuses research + whyFits; no new model work).
- [ ] Extend `BrandPicker.tsx`; two confirm modals; sequence: quick lookup → Gate 1 → (Phase 5 timeline) → Gate 2 → build.
- **Test:** type "Prime Hydration" → confirm brand → confirm angles → pitch created `ready`.

### Phase 5 — Pausable builder + SSE step timeline (Gate 3) · L · risk Med–High
- [ ] Split `assembleMediaKit` (`mediaKitService.ts:115`) into **Phase A** (context/plan/insights, `:117–249`, returnable for Gate 2) and **Phase B** (cast/assemble, `:250–433`).
- [ ] Persist a small **build-state** for `tailoring`/`failed` (the one new persistence).
- [ ] New SSE build endpoint emitting `sse.status()` per stage (reuse `server/lib/sse.ts`).
- [ ] Client `use-build-stream.ts` (fork `use-mila-chat.ts`) + step-timeline component; **fallback** to coarse status polling if streaming fails — same timeline, no redesign.
- **Test:** create flow shows real agent steps with "found" chips as the pipeline runs, twice (research, build) around Gate 2.

### Phase 6 — Cross-tab echoes *(optional, later)* · M · risk Low
- [ ] Loud "brand opened your pitch" card in Opportunities; gold Studio tab pip; deal ↔ pitch two-way link.
- Additive front-of-house once the Pitch object exists.

---

## Out of scope (separate track)
Posts & Ads and Media **generation** (the AI create tools). Studio *surfaces* them in Phase 2, but building
those creation surfaces is a separate feature with its own plan.

## House rules for this build
Migrations: surgical raw SQL, idempotent + additive (not `drizzle-kit push`). Branch: `feat/studio-pitches`.
Don't commit/push without explicit ask. Never print secrets. DB reachable via Cloud SQL proxy (127.0.0.1:5440).
