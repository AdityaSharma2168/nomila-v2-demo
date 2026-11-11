# Studio A3.2 — campaign concept → deck slot (design plan, FOR REVIEW)

> Branch `adi/studio-campaign-concept`, off `main` (`65719f0`). **Nothing is implemented.**
> Every probe below was a read: `grep`, file reads, `git log`. No DB was touched, no model was called.
> Baseline `npx tsc --noEmit -p tsconfig.json` on this branch: **exit 0**.

---

## 0 · Four reads that changed the design

| Probe | Result | Effect |
|---|---|---|
| Does the deck have a concept slot? | **Yes.** `mediaKitService.ts:320-326` builds a `campaignConcept` card with `image: heroImg ?? whyFitsImg ?? null` | The slot exists and is filled by a **recycled IG photo**. A3.2 replaces a stand-in, it doesn't create a card |
| Does anything read `kit_content`? | **No.** Hits are `shared/schema.ts`, `migrations/0022`, `migrations/0027`, two docs. **Zero readers, 0 rows in prod** | Writing `kit_content` alone puts nothing on screen. Making it render = a deck-engine change = **out of lane** |
| Is there another seam? | **Yes.** `cardOverrides.applyOverrides()` already routes `ov.images[cardId]` → `card.image` for any card with an `image` field, and `kitCache.signKit()` **already signs `campaignConcept.image`** | The picture can reach the deck with **zero lines changed** in mediaKitService / curator / narrator / kitCache / cardOverrides |
| Does the publish gate cover embedding? | **No.** The 0027 trigger fires on `content_posts` only. `kit_content` is unguarded | An unapproved concept can be embedded in a deck sent to a brand. **A3.2 has to close this** — §3 |

Two more facts that constrain the design:

- **The concept card is brand-only.** `if (brand && cc)` — no `brandId`, no card. And if `narrateCampaignConcept` returned `null` at build time, the card does not exist at all, so an override has nothing to attach to (`applyOverrides` only maps over cards that exist). An embed must therefore *check the cached kit first and refuse with a reason*, not write an override that silently does nothing.
- **`main` does not have the Veo SKU fix** (`dc710b5`, `ff990ed` are unmerged on `adi/studio-veo-sku`). Irrelevant here — the concept path is `image.generate`, not Veo — but this branch quotes a silent clip at 2× until that merges.

---

## 1 · The flow, end to end

```
assembleBrief({ athleteId, brandId, origin, objective:"concept",
                deliverable:"post", mode:"generate" })          brief.ts     — pure read
      ↓
previewGeneration(brief)                                        preview.ts   — A2.5 gate, $0, no network
      ↓  status "ready"        │ status "blocked" → STOP, render blockers, no job row, no spend
      ↓
[spend approval — an argument the caller must pass; not persisted anywhere yet, see §5]
      ↓
createGenerationJob(preview)                                    jobs.ts      — generation_jobs, pending, frozen brief
claimJob(jobId)                                                 jobs.ts      — pending → running
      ↓
runGeneration(brief)                                            preview.ts   — RE-DERIVES the gate, then router
      ↓
saveConceptBytes(...)                                           NEW          — Buffer → GCS (§6)
recordGeneratedAsset(...)                                       jobs.ts      — media_assets: origin='generated',
                                                                               approval_status='draft',
                                                                               generation_job_id=<job>,
                                                                               derived_from_asset_id=NULL
succeedJob(jobId) / failJob(jobId, err)                         jobs.ts
      ↓
——— a human looks at it (U2). Nothing below runs until they do. ———
      ↓
setApprovalStatus(athleteId, assetId, "approved")               approval.ts  — A3.1, draft → approved
      ↓
embedConceptInDeck({ athleteId, brandId, assetId })             NEW          — §2
      ↓
the deck's campaignConcept card renders the generated image
```

Nothing in that chain is a new primitive. A3.2 is `concept.ts` — the orchestration — plus the embed seam and its guard.

---

## 2 · The deck-slot integration (the lane question)

### The three candidates

**(a) `kit_content` — the documented home, no readers.** 0022 calls it "embed-by-reference (D7): an asset placed into a media kit at a position". It is exactly right conceptually and it does **nothing** today: no code reads it. Wiring it up means teaching `mediaKitService`/`kitCache` to read a table and fold it into `campaignConcept.image` — **a deck-engine change. Out of lane. Not proposed.**

**(b) `card_overrides.images` — the serve-time override layer.** Already built for exactly this shape of thing, already applied on every read path:

```ts
// cardOverrides.ts — applyOverrides(), UNCHANGED. This is the seam.
const swap = ov.images?.[c.id];
if (swap) { ... const path = typeof swap === "string" ? swap : swap.path;
            if ("image" in c) (c as any).image = path; ... }
```

`campaignConcept` has an `image` field, so `"image" in c` is true. `kitCache.signKit()` already signs `campaignConcept.image`. Writing `data.images.campaignConcept = "<gcs_path>"` at `(athlete_id, brand_id)` lands the asset in the slot. **Zero deck-engine lines change.** Studio *calls* the exported `getOverrides` / `saveOverrides` — it does not modify them.

**(c) writing `media_kits.data` directly.** Rejected: that jsonb is the cache the deck engine owns and rebuilds. `buildAndCacheKit` would wipe it on the next data-change event.

### Proposal: (b) is the mechanism, (a) is the record, and the guard rides on (a)

`embedConceptInDeck` does two writes, in this order:

1. `INSERT INTO kit_content (media_kit_id, asset_id, position)` — the canonical relational record of the embed. **A trigger can guard this** (§3); a jsonb blob inside `card_overrides` cannot carry an FK or a per-asset trigger predicate.
2. Read-modify-write `card_overrides.data.images.campaignConcept = asset.gcs_path` — the mechanism the renderer honours today.

Ordering is the point: **step 1 must commit before step 2 runs.** A draft asset is refused by Postgres before the picture can reach the deck. When the deck engine eventually learns to read `kit_content`, step 2 becomes redundant and is deleted — the record is already correct.

Both writes are inside one transaction. The `kit_content` unique index `(media_kit_id, asset_id)` makes re-embedding the same asset idempotent.

### Refusals, before either write

| Condition | Why |
|---|---|
| asset's `athlete_id ≠ req.athleteId` | tenancy — every read and write predicate carries it |
| `origin ≠ 'generated'` | this door is for Studio output; ingested media has its own path |
| `approval_status ≠ 'approved'` | **the A3.1 publish gate** (belt; §3 is the braces) |
| `deleted_at IS NOT NULL` | soft-deleted content is not embeddable |
| no `media_kits` row for `(athleteId, brandId, opportunity_id IS NULL)` | there is no deck to embed into |
| the cached kit has no `campaignConcept` card | the narrator returned null, or `brandId = 0`. Refuse loudly — an override on a non-existent card is a silent no-op |
| `brandId = 0` | the concept card is brand-only |

### What A3.2 reads from the deck, and how

One helper, `readDeckConceptSlot(athleteId, brandId)`: a plain `SELECT data FROM media_kits WHERE athlete_id = $1 AND brand_id = $2 AND opportunity_id IS NULL`, then find the card with `id === "campaignConcept"`. **A SELECT, not `getOrBuildKit`** — `getOrBuildKit` builds on a cache miss, which runs the whole agent DAG and spends model money. A3.2 must never trigger a deck rebuild.

---

## 3 · The migration (my lane) — the embed guard

Today's guarantee is "nothing **publishes** from draft" (`content_posts`). It does not cover "nothing gets **embedded in a deck** from draft" — and a deck goes to a brand, so an unapproved concept in a deck is the same failure with a different verb.

Proposed: a **third block in `server/studio/sql/generationGuards.sql`**, mirroring the existing one exactly:

```sql
-- ── 3. "Nothing embeds from draft" ────────────────────────────────────────────
-- Same guarantee as the publish gate, one verb over: a pitch deck goes to a brand, so an
-- unapproved generated asset embedded in one has already reached the outside.
-- Scoped to origin='generated' for the same reason: ingested rows carry approval_status NULL
-- by design and embedding one is legitimate (0022 rejects retroactive gating).
CREATE OR REPLACE FUNCTION kit_content_require_approval() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM media_assets a
    WHERE a.id = NEW.asset_id
      AND a.origin = 'generated'
      AND a.approval_status IS DISTINCT FROM 'approved'
  ) THEN
    RAISE EXCEPTION 'asset % is generated and not approved - cannot embed it in a kit', NEW.asset_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_kit_content_require_approval ON kit_content;
CREATE TRIGGER trg_kit_content_require_approval
  BEFORE INSERT OR UPDATE ON kit_content
  FOR EACH ROW EXECUTE FUNCTION kit_content_require_approval();
```

**Blast radius: nil.** `kit_content` is **0 rows in prod**. The trigger is scoped to `origin='generated'`, of which there are also 0 rows. Idempotent (`CREATE OR REPLACE` / `DROP TRIGGER IF EXISTS`). No UPDATE, no DELETE, no DROP, no backfill.

**⚠️ FLAG — this ships on merge.** `.github/workflows/deploy.yml:290` already runs `psql -f server/studio/sql/generationGuards.sql` on every deploy. Editing that file means **the trigger reaches the prod DB the moment this merges to `main`**, without me touching `.github/workflows/**` (which is out of my lane). That is the intended path — it's how 0027's guards got there — but it is a prod DDL change and you should approve it as one. → **Q1.**

Two consequences:

- `approval.test.ts` asserts `migrations/0027_studio_generation.sql` **contains `generationGuards.sql` verbatim**. So 0027's embedded block (lines 102-144, between the `>>> BEGIN` / `<<< END` markers) must be re-synced in the same commit. That means editing an already-applied migration file — acceptable here only because 0027 explicitly is not the executor ("This file records intent"), and the drift test exists to force exactly this.
- The alternative — a new `migrations/0028_*.sql` and a new guards file — would need a new `-f` line in `deploy.yml` to ever run. **I cannot make that edit**, so the guard would sit unshipped until Mia added it. That's the trade in Q1.

---

## 4 · Generation mode: this is `generate`, confirmed

`mode: "generate"`, `objective: "concept"`, `deliverable: "post"` → `taskFor()` returns **`image.generate`**. Full generation, no source frame. Three independent things enforce it:

- `assembleBrief` throws if `mode: "generate"` carries a `source`.
- The DB CHECK `generation_jobs_edit_needs_source` requires `mode='generate' AND source_asset_id IS NULL`.
- `referencesFor()` adds no `source-frame` entry without `brief.job.source`.

Lineage for a generate is therefore: `generation_job_id` (what made it) + the frozen `brief` jsonb (what was asked). **`derived_from_asset_id` stays NULL** — there is no frame it came from, by definition. That is an assertion in the suite, not a comment.

References that *do* go in: brand product photos (none on file today — every piece's `reference` is null) and brand `referenceImagery` (logo skipped — "a logo is not art direction"). So today's concept generation is text-driven off the brief with cover/gallery brand imagery when present.

**Where A4 (edit/composite) differs** — none of this is built here:

| | A3.2 concept (`generate`) | A4 edit (`edit`) |
|---|---|---|
| task | `image.generate` | `image.edit` |
| source | forbidden | required (`assembleBrief` throws without it) |
| references | brand pieces + imagery | **source frame FIRST**, then pieces |
| `editRegions` | n/a | required — empty is a *blocking* gap |
| prompt | "Create a {deliverable}…" | "Retouch the supplied frame… every other pixel stays" |
| lineage | `generation_job_id` only | `+ derived_from_asset_id` |
| output | net-new image | masked composite, ~99.6% of the frame bit-identical |
| aspect | `4:5` from `ASPECT` | inherited from the frame (`ASPECT` applies to generate only) |

---

## 5 · What A3.2 actually builds vs. what waits for U1/U2

**Built and testable now, with no UI:**

| File | What |
|---|---|
| `server/studio/concept.ts` | `previewConcept()` · `runConceptGeneration()` · `embedConceptInDeck()` · `readDeckConceptSlot()` |
| `server/studio/storage.ts` *(or a `mediaStore` export — §6/Q2)* | generated bytes → GCS |
| `server/studio/sql/generationGuards.sql` | + the `kit_content` approval trigger |
| `migrations/0027_studio_generation.sql` | re-synced embedded copy (drift test) |
| `server/studio/concept.test.ts` | PGlite + real triggers + stubbed router — §7 |

**Deferred, deliberately:**

- **No HTTP route.** There is no `server/routes/studio.ts` today. Adding one before U2 exists means an athlete-scoped surface with no consumer — a tenancy risk for no benefit. The pipeline is a library, driven by tests now and by the U2 route later. → **Q4.**
- **Spend approval is an argument, not a record.** A3.1's own header says it "is not persisted anywhere yet". `runConceptGeneration` takes an explicit `approvedCostUsd` and refuses if the re-derived quote exceeds it — an in-process gate. Persisting spend approval is U2's.
- **`n = 1`.** The router takes `n`, and approval is per-asset, so variants work by construction. A3.2 does one.
- **The deck engine reading `kit_content`** (which would delete the `card_overrides` half of §2) — Mia's, not mine.
- **Seeding the image prompt with the deck's existing concept copy** — see Q3.

---

## 6 · The one real gap: nothing uploads the bytes

`recordGeneratedAsset` takes a `gcsPath`. The adapters return `bytes: Buffer` (images come back base64). **`server/lib/mediaStore.ts` has no exported save-a-Buffer function** — it exports `rehostFromUrl`, `uploadLocalFile`, `signedUrl`, `signedUploadUrl`, `uploadObjectPath`, and none of them takes a Buffer. Three options:

| | Approach | Cost |
|---|---|---|
| **(a) recommended** | Add `saveBuffer(gcsPath, bytes, contentType)` to `mediaStore.ts` — ~6 lines, wraps `bucket.file(dest).save(buf)` which `rehostFromUrl` already calls internally | One additive export **outside `server/studio/**`** → needs your OK |
| (b) | `server/studio/storage.ts` with its own `new Storage()` handle | In lane, but a second bucket handle and duplicated config |
| (c) | Buffer → temp file → existing `uploadLocalFile` | Zero new code outside studio, pointless disk round-trip |

→ **Q2.** Path convention either way: `athletes/<athleteId>/studio/<jobId>/<n>.<ext>`, mirroring `uploadObjectPath`'s `athletes/<id>/uploads/<uuid>.<ext>`.

---

## 7 · Tests — folded into A3.2's own suite

One new suite, `server/studio/concept.test.ts`. Harness copied from the two that exist rather than invented: **PGlite** with `generationGuards.sql` applied (as `approval.test.ts` does, so the triggers are real Postgres), and **the router mocked at the module boundary** (as `preview.test.ts` does, so "did we spend?" is a call count). **Model spend: $0.**

**1 · Unapproved-publish-REFUSED** — against the real setup, four layers:

- `embedConceptInDeck` on a `draft` generated asset → `GenerationError`, and **no `kit_content` row and no `card_overrides` row** (the deck never sees it).
- Then **bypass the application entirely**: raw `INSERT INTO kit_content` via `client.exec` → Postgres raises `check_violation`. This is the assertion that matters — it holds against a script, a psql session, and code not yet written.
- Same asset, raw `INSERT INTO content_posts` → still refused by the existing 0027 trigger.
- Approve it → both inserts now succeed. Proves the trigger gates on approval, not on `origin`.

**2 · Missing-ref-preview-REFUSED** — through the **real `assembleBrief`**, not a hand-built brief: seed `athletes` + `athletes_current` + an `inbox_brands` row whose `enrichment.product_categories` is `["necklaces"]`, then `origin: "inbound"` with `ask.featuredPieces: ["<synthetic SKU name>"]`. The named piece has no `reference` → `collectGaps` emits `severity: "blocking"` on `brand.pieces[…].reference` → `previewGeneration` returns `status: "blocked"`, `plan: null`, and:

- `generateMock` **not called** — nothing was spent.
- `createGenerationJob(preview)` throws — no `generation_jobs` row exists for a blocked preview.
- `runConceptGeneration` throws before the router.

One precision: `previewGeneration` *does* call `estimate()` on a blocked brief. `estimate` is a local price-table lookup that "must never make a billable call" (`types.ts`), so the spend assertion is on `generate`. The suite asserts both — `generate` never called, `estimate` non-billable by contract.

*Build risk:* `getAthleteContext` inner-joins `athletes_current`, so that row must be seeded or `assembleBrief` returns nothing. Everything else it reads (snapshots, analytics, media) degrades to empty cleanly. If it turns out to need more seeding than is reasonable, I fall back to `preview.test.ts`'s hand-built brief and say so rather than thinning the assertion.

**3 · Happy path — approved concept lands in the slot:**

- Stubbed router returns one image Buffer → job goes `pending → running → succeeded`; asset row has `origin='generated'`, `approval_status='draft'`, `generation_job_id` set, **`derived_from_asset_id` NULL** (the generate-mode lineage assertion from §4).
- `setApprovalStatus(draft → approved)`.
- `embedConceptInDeck` → `kit_content` row exists; `card_overrides.data.images.campaignConcept === asset.gcs_path`.
- **The seam assertion:** take the seeded cached kit, run it through the **real `applyOverrides()`** imported from `services/cardOverrides` (read-only use, unmodified), and assert `cards.find(c => c.id === "campaignConcept").image` is now the generated path. This proves the integration end-to-end *without touching the deck engine* — if someone changes `applyOverrides`, this test tells us.

**4 · Tenancy + the refusal table from §2** — another athlete's `assetId` → refused; another athlete's `media_kit` → refused; `brandId = 0` → refused; a cached kit with no `campaignConcept` card → refused with a reason, and **no override written**.

Run scoped and `--runInBand` (PGlite suites): `npx jest server/studio --runInBand`.

**Real generation:** not needed for any of the above. If you want one end-to-end burn against Vertex it is **one call, ~$0.13** (the `gemini-3-pro-image` estimate the existing suites carry). I will not make it without you saying so.

---

## 8 · Gates before I hand it back

`npx tsc --noEmit -p tsconfig.json` (CI's exact command, whole project) · `npm run lint` · `npm run check:format` · `npx jest server/studio --runInBand`. Commit, **no push**, then pause.

---

## 9 · Open questions

| # | Question | My recommendation |
|---|---|---|
| **Q1** | The embed trigger in `generationGuards.sql` **auto-deploys to prod on merge** (deploy.yml already `-f`s that file) and forces a re-sync of 0027's embedded copy. Alternative: a new `0028` + guards file that **can never run** without a `.github/workflows` edit I'm not allowed to make. | **Extend `generationGuards.sql` + re-sync 0027.** The guard is worthless unless it's actually in the DB, and the blast radius is genuinely nil (0 rows). But this is a prod DDL change — your call. |
| **Q2** | Storage: add `saveBuffer()` to `server/lib/mediaStore.ts` (**outside `server/studio/**`**), or keep a studio-local `Storage` handle? | **(a)**, with your OK. It's ~6 lines wrapping a call `rehostFromUrl` already makes; a second bucket handle is parallel machinery. |
| **Q3** | Should the generated image be seeded with the deck's *existing* concept copy (`title` / `line` / `facets` from `narrateCampaignConcept`)? It makes card and picture one idea instead of two. | **Defer.** That copy is narrator output derived from brand enrichment — external text — so routing it into a generation prompt opens an injection path that must travel delimited-as-data, and `BriefInput` has no trusted-direction field today. Worth doing; worth doing on its own. |
| **Q4** | HTTP route now, or library-only until U2? | **Library-only.** An athlete-scoped route with no consumer is tenancy surface for nothing. |
| **Q5** | `deliverable` for a concept image: `"post"` (4:5) vs `"ad"` (1:1)? The luxe card renders a full-bleed portrait photo plate. | **`"post"` → 4:5.** Closest to the card's shape. Trivial to change — it's one field on the input. |
| **Q6** | `card_overrides.data` is the athlete's *editor* state and `saveOverrides` rewrites the whole jsonb. A studio read-modify-write can clobber a concurrent editor save (last-write-wins). | Accept for A3.2 — the editor is U1, not yet live, so there is no concurrent writer. Flagging it because it becomes real the day U1 ships, and the fix (a narrower write, or the deck reading `kit_content`) is not mine to make. |

---

## 10 · Scope check

- **Touches:** `server/studio/**` (new `concept.ts`, `concept.test.ts`, `storage.ts?`, `sql/generationGuards.sql`), `migrations/0027_*.sql` (drift re-sync), this doc. Pending Q2: one additive export in `server/lib/mediaStore.ts`.
- **Does not touch:** `mediaKitService.ts`, `curator.ts`, `narrator.ts`, `kitCache.ts`, `cardOverrides.ts`, `shotList.ts`, themes, any route, any client file, `.github/workflows/**`, `gcp/**`, `package.json`.
- **Prod DB writes:** `generation_jobs`, `media_assets` (new rows only, `origin='generated'`), `kit_content`, `card_overrides` — content/generation tables only. Plus the §3 DDL on merge, pending Q1.
- **Reads from the deck engine:** `media_kits.data` (SELECT), and `applyOverrides` / `getOverrides` / `saveOverrides` called as exported functions. Nothing in the deck engine is modified.
- **Reversibility:** the pipeline is dead code until something calls it (no route, no UI). The trigger is additive on an empty table. Safe live the moment it merges.

---

## 11 · Post-build addendum — reject-retracts-embed (guards §4)

The build surfaced a gap this plan did not cover: §3 stops an unapproved asset *entering* a deck,
but nothing stopped the same bad state being reached from the other side — embed while approved,
then reject, and the deck goes on rendering content whose clearance was withdrawn.

**Decision: enforce in the database, as a REFUSAL rather than a cascading delete.**

A cascade was the obvious shape and is the wrong one:

| | Why not |
|---|---|
| It cannot finish the job | A `media_assets` trigger can delete the `kit_content` row, but the half that RENDERS is a gcs_path inside `card_overrides.data->'images'`, keyed by `(athlete_id, brand_id)` — a `brand_id` the trigger does not have. It would remove the record and leave the picture on screen: the exact failure direction §2's write-ordering exists to prevent. |
| It deletes to express a decision | `approval.ts`: "The row stays; content is never deleted to express a decision." A cascade destroys the evidence the asset was embedded and the position the athlete chose. |
| It is an invisible blast radius | A trigger silently editing the deck engine's editor-state jsonb, in a lane we may not modify. |

The refusal form reaches the same guarantee — **no state exists where a rejected asset is embedded,
because it is unreachable** — while deleting nothing and matching the two existing guards, which all
`RAISE EXCEPTION` and none of which mutate another table.

**What shipped**

- `generationGuards.sql` §4 — `BEFORE UPDATE ON media_assets`, gated by
  `WHEN (OLD.approval_status IS DISTINCT FROM NEW.approval_status)` so only a clearance change is
  ever evaluated and every other write on an embedded asset is untouched. Refuses when the asset is
  `origin='generated'`, is leaving `approved`, and a `kit_content` row exists. `NULL` is not an
  escape hatch either.
- `concept.ts: unembedConceptFromDeck()` — the explicit retraction. Writes are the MIRROR of the
  embed: picture first, record second, so a partial failure leaves the embed recorded but no longer
  rendered. Fail-safe in the same direction both ways round. It only clears the override when it
  still points at *this* asset, so a retraction never wipes a picture the athlete has since chosen.
- `concept.ts: decksEmbedding()` — what a caller has to clear first.
- `approval.ts` — an application pre-check so the refusal is a readable `GenerationError` naming the
  decks, keeping that file's "every refusal names both states" contract. The DB is the copy that
  cannot be bypassed; this one is the copy a person can read.

**Deliberately NOT extended to `content_posts`.** A publish record is a historical fact about
something that already happened in the world; rejecting content afterwards is exactly what should
stay possible. An embed is a *live placement*. Only the live one locks clearance.

**Consequence for U2:** rejecting an embedded concept is now two acts, and the UI should offer them
as one gesture ("remove from deck and reject") rather than surfacing the refusal to the athlete.
