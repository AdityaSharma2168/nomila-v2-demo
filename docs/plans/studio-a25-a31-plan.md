# Studio A2.5 + A3.1 — design plan (FOR REVIEW, nothing built)

> Branch `adi/studio-precheck-content-model`, off `5d099b4` (A2 merged; `b6d490a` in history).
> Nothing in this plan is implemented.
> DDL is proposed, not written. Prod is untouched — every probe below was `SELECT` / `information_schema`.

---

## 0 · What I verified first, and what it changed

Five probes, all read-only. Two of them changed the design materially.

| Probe | Result | Effect on the plan |
|---|---|---|
| Do the Stage-3 columns exist in prod? | **Yes, all of them** — `origin`, `derived_from_asset_id`, `approval_status`, `deal_id`, `deleted_at` | A3.1 is mostly *activation*, not new schema. The delta is 6 statements, not a table redesign |
| Are the content tables there? | `content_posts`, `content_brands`, `kit_content` all **exist and are empty (0 rows)** | The publish-records table is already built. Nothing to migrate, nothing to break |
| Is any of it in use? | `media_assets`: 564 rows — 561 `connected`, 3 `upload`. `approval_status` **564 × NULL**. `derived_from_asset_id` **0 non-null**. `deleted_at` 0. `deal_id` 0 | Zero live data depends on these. Adding constraints validates instantly and cannot fail on existing rows |
| What's actually missing? | `derived_from_asset_id` has **no FK and no index**. `origin` has **no CHECK**. No asset→job link. `content_posts` has no dedup guard | This is the exact A3.1 delta |
| Can PGlite enforce a plpgsql trigger? | **Yes** — verified: generated+draft REFUSED, generated+approved ALLOWED, ingested/NULL ALLOWED | The "nothing publishes from draft" guarantee can live in the DB *and* be tested in CI. This decided §6 |

Also found, and it matters for §9: **`migrations/*.sql` files are not the executor.** `0022_content_tables.sql` says so in its own header — DDL reaches prod through an idempotent `psql` block in `.github/workflows/deploy.yml` (~line 148). The `migrations/meta/_journal.json` is stale (12 entries ending `0011`, while the folder runs to `0026`), and `npm run db:migrate` is recorded as broken here. **`.github/workflows/**` is out of my lane**, so I can write the DDL but I cannot ship it. See §9.

Nothing in the repo reads or writes `approval_status`, `derived_from_asset_id`, or `content_posts` today — grep returns zero hits outside `shared/schema.ts`.

---

# A2.5 — Pre-generation check

## 1 · The shape

**Naming collision, first.** `GenerationPlan` is already taken — `server/studio/types.ts` exports it as the router's dry-run result (`task, provider, model, inputs, cost`). A2.5's output is a strictly bigger thing: the router plan *plus* the brief *plus* the gate verdict. Reusing the name would silently change an existing exported type that `router.estimate()` returns.

**Proposed:** a new `GenerationPreview` that *contains* the router's `GenerationPlan` unchanged. → **Open question Q1.**

```ts
// server/studio/preview.ts

/** A preview has not run anything, so its cost is ALWAYS an estimate. Narrowing the field means a
 *  billed figure cannot be assigned to a preview even by mistake — it is a type error, not a bug. */
export type EstimatedCost = CostEstimate & { basis: "estimated" };

export type PreviewStatus = "ready" | "blocked";

export interface GenerationPreview {
  previewId: string;              // uuid — joins to the cost log and (later) the job row
  createdAt: string;              // ISO

  status: PreviewStatus;          // "blocked" ⇒ generation must not be offered
  brief: CreativeBrief;           // the full A2 brief, verbatim (the UI renders athlete/brand/job from this)

  /** The resolved route. NULL only when status is "blocked" before routing was attempted. */
  plan: GenerationPlan | null;    // { task, provider, model, inputs, cost } — the router's own type

  /** Hoisted from plan.cost so the UI has one place to read money from. */
  cost: EstimatedCost;
  /** true ⇒ we have no price for this model. Show "unknown", never $0. */
  unpriced: boolean;

  blockers: BriefGap[];           // severity "blocking" — why generation is refused
  warnings: BriefGap[];           // severity "degraded" — proceed, expect less

  /** What the UI should say on the button. Derived, so copy lives in one place. */
  verdict: {
    canGenerate: boolean;
    headline: string;             // "Ready to generate" | "Can't generate yet"
    reason: string | null;        // first blocker's note, for the one-line explanation
  };
}
```

**What the caller/UI actually gets back:** everything needed to render an approval screen without a second call — who it's for, what will run, what it will cost, what's missing, and whether the button is enabled.

**Rejected:** returning a bare `GenerationPlan` with a `gaps` array bolted on. It makes the money field and the gate field peers, when in fact the gate *governs* whether the money field is meaningful at all. The nested shape says that.

## 2 · How cost is derived, and how basis is protected

**Path: `estimate(task, inputs, opts)` from `server/studio/router.ts`.** Not `generate({ dryRun: true })`.

Both return the same cost, but `estimate()` is the narrower door: it is synchronous, makes no network call, and the adapter contract on `GenerationAdapter.estimate` already says *"Must never make a billable call."* `generate({dryRun:true})` reaches the same place through the door that can also spend. For a function whose entire purpose is "tell me before I spend", the door that cannot spend is the right one.

**How basis stays honest — three layers:**

1. **The adapters already carry it correctly.** `CostEstimate.basis` is `"estimated"` pre-run and `"reported"` only for work that actually ran. `router.generate()` explicitly never recomputes it ("the cost and its basis are taken from what the adapter returned and never recomputed").
2. **The type narrows it.** `EstimatedCost = CostEstimate & { basis: "estimated" }`. A preview physically cannot hold a `"reported"` figure.
3. **`unpriced` is hoisted to the top level.** Today `estimateCost` returns `{ amountUsd: 0, unpriced: true }` when there's no price. A UI reading `amountUsd` alone would render **$0.00** for "we have no idea" — the exact failure the pricing module was written to avoid. Hoisting it makes it hard to miss.

**One honesty note to surface in the UI, not just the type:** on the Vertex image path the pre-run number uses the `tokensPerImage` **assumption** (1120, measured once), while the post-run number is recomputed from tokens Vertex actually reported. So the preview figure and the logged figure will differ slightly, legitimately. `cost.detail` already carries that sentence; the UI should show it.

## 3 · The refuse-on-gap flow

**Concretely: a preview returns `status: "blocked"`, it does not throw. `generate` throws.** Two different jobs.

- The **preview** is a rendering call. The UI needs to *display* why it can't generate — a thrown error gives it a string where it needs a list. So the preview always returns a well-formed object; `blockers` carries `blockingGaps(brief)` verbatim.
- The **generate boundary** re-runs the gate and **throws** `GenerationError(..., "invalid_input")`. This is defence in depth: a caller that skips the preview, or acts on a stale one, still cannot spend on a blocked job. The preview is advisory; the generate boundary is enforcement.

```
                                    ┌── status "blocked" ──► UI renders blockers. No spend. STOP.
assembleBrief(input)                │
      │                             │
      ▼                             │
  CreativeBrief ──► previewGeneration(brief, opts)
                          │  blockingGaps(brief)          ← gate, read-only
                          │  estimate(task, inputs)       ← cost, no billable call
                          │
                          └── status "ready" ──► [ APPROVAL — U2 ] ──► runGeneration(brief, opts)
                                                                            │
                                                                            ├─ re-assert gate ─► throws if blocked
                                                                            ├─ router.generate()  ← the only spend
                                                                            └─ costLog record
```

**Why re-assert rather than trust a preview token:** a token would need issuing, storing, and expiring — that is U2's problem. Re-deriving the gate from the brief is cheap (it is pure function over data already in hand) and has no staleness window. If the brief changed between preview and generate, the second check catches it.

## 4 · Scope now vs deferred to U2

**In scope now**
- `previewGeneration(brief, opts) => GenerationPreview` and the `GenerationPreview` type.
- Mapping a `CreativeBrief` → router `GenerationInputs` (prompt assembly, reference selection, task choice from `job.mode`).
- The gate at both the preview and the generate boundary.
- PGlite/unit tests: blocked-vs-ready, `unpriced` surfacing, basis narrowing, and that a blocked brief throws at generate.

**Deferred to U2**
- Any persistence of the preview or of approval — no row is written by A2.5.
- Who approved, when, and proof-of-approval carried into generate.
- Spend caps, budgets, per-athlete limits.
- Showing alternates ("cheaper model?"), re-pricing on edit, currency display.
- The screen itself.

**Deliberately not now:** persisting the preview. It would create a fourth state concept (see §10) before U2 has decided what approval even looks like, and a stored preview goes stale the moment the brief changes.

---

# A3.1 — Content model

## 5 · Schema delta — the exact DDL

Additive only. No `UPDATE`, no `DELETE`, no `DROP COLUMN`, no data backfill. Every statement is `IF NOT EXISTS`-guarded or idempotent, matching the house style in `0022`.

```sql
-- migrations/0027_studio_generation.sql
-- Additive only. Executor is the psql block in .github/workflows/deploy.yml (see §9) — NOT this file.

-- ─── 1. Lineage: make derived_from_asset_id a real relationship ────────────────────────────────
-- The column exists and is 0/564 populated, so both statements validate instantly.
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_derived_from_fkey;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_derived_from_fkey
  FOREIGN KEY (derived_from_asset_id) REFERENCES media_assets(id) ON DELETE SET NULL;

-- Partial: only ~generated rows carry a parent, so the index stays tiny.
CREATE INDEX IF NOT EXISTS idx_media_assets_derived_from
  ON media_assets (derived_from_asset_id) WHERE derived_from_asset_id IS NOT NULL;

-- ─── 2. Constrain the origin vocabulary ────────────────────────────────────────────────────────
-- Existing values are only 'connected' (561) and 'upload' (3) — both listed, so this cannot fail.
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_origin_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_origin_check
  CHECK (origin IN ('connected','discovery','upload','generated'));

-- ─── 3. The job record ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS generation_jobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id         uuid    NOT NULL REFERENCES athletes(id)     ON DELETE CASCADE,
  brand_id           integer          REFERENCES inbox_brands(id),

  -- The job, denormalised out of the brief so it is queryable without opening the jsonb.
  origin             text    NOT NULL,          -- 'system' | 'inbound'   (BriefOrigin)
  mode               text    NOT NULL,          -- 'edit' | 'generate'    (BriefMode)
  objective          text    NOT NULL,
  deliverable        text    NOT NULL,

  -- The frozen CreativeBrief: the immutable record of exactly what was asked, including every
  -- reference that went in. This is the lineage record for inputs (§7).
  brief              jsonb   NOT NULL,

  -- edit mode only: the frame the output must stay continuous with.
  source_asset_id    uuid             REFERENCES media_assets(id),

  -- Lifecycle. Copied from media_backfill_state (§8). No leasing.
  status             text    NOT NULL DEFAULT 'pending',
  last_error         text,

  -- Routing + money, recorded as quoted.
  provider           text,
  model              text,
  cost_estimated_usd numeric,
  cost_basis         text,

  created_at         timestamptz DEFAULT now(),
  started_at         timestamptz,
  completed_at       timestamptz,
  updated_at         timestamptz DEFAULT now(),

  CONSTRAINT generation_jobs_origin_check CHECK (origin IN ('system','inbound')),
  CONSTRAINT generation_jobs_mode_check   CHECK (mode   IN ('edit','generate')),
  CONSTRAINT generation_jobs_status_check CHECK (status IN ('pending','running','succeeded','failed','canceled')),
  -- The edit/generate fork, enforced by the database and not only by assembleBrief.
  CONSTRAINT generation_jobs_edit_needs_source CHECK (
    (mode = 'edit'     AND source_asset_id IS NOT NULL) OR
    (mode = 'generate' AND source_asset_id IS NULL)
  )
);

-- Tenancy first: every read is "this athlete's jobs, newest first".
CREATE INDEX IF NOT EXISTS idx_generation_jobs_athlete
  ON generation_jobs (athlete_id, created_at DESC);
-- The worker's only query: what is waiting.
CREATE INDEX IF NOT EXISTS idx_generation_jobs_status
  ON generation_jobs (status, created_at) WHERE status IN ('pending','running');
CREATE INDEX IF NOT EXISTS idx_generation_jobs_source
  ON generation_jobs (source_asset_id) WHERE source_asset_id IS NOT NULL;

-- ─── 4. Asset → the job that made it ───────────────────────────────────────────────────────────
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS generation_job_id uuid
  REFERENCES generation_jobs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_media_assets_generation_job
  ON media_assets (generation_job_id) WHERE generation_job_id IS NOT NULL;

-- ─── 5. Publish records: dedup + deal lookup ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_content_posts_deal
  ON content_posts (deal_id) WHERE deal_id IS NOT NULL;
-- One publish record per real post. Table is empty, so this cannot conflict.
CREATE UNIQUE INDEX IF NOT EXISTS content_posts_platform_permalink_uniq
  ON content_posts (platform, permalink) WHERE permalink IS NOT NULL;

-- ─── 6. "Nothing publishes from draft", as a database guarantee ────────────────────────────────
-- Scoped to origin='generated' on purpose: the 561 ingested rows carry approval_status NULL by
-- design ("NULL = ungated", 0022) and must stay publishable. Verified working under PGlite.
CREATE OR REPLACE FUNCTION content_posts_require_approval() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM media_assets a
    WHERE a.id = NEW.asset_id
      AND a.origin = 'generated'
      AND a.approval_status IS DISTINCT FROM 'approved'
  ) THEN
    RAISE EXCEPTION 'asset % is generated and not approved — cannot record a publish', NEW.asset_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_content_posts_require_approval ON content_posts;
CREATE TRIGGER trg_content_posts_require_approval
  BEFORE INSERT OR UPDATE ON content_posts
  FOR EACH ROW EXECUTE FUNCTION content_posts_require_approval();
```

**Not changing `media_assets.approval_status`'s CHECK.** It already allows `NULL | draft | approved | rejected`, which is exactly the vocabulary in §6. Zero schema change for approval is a feature.

### The one alternative I rejected, and why

For the publish guarantee I first designed a **composite foreign key** instead of a trigger: `UNIQUE (id, approval_status)` on `media_assets`, plus `content_posts.asset_approval_status text NOT NULL CHECK (= 'approved')` with `FOREIGN KEY (asset_id, asset_approval_status)`. That makes the guarantee pure relational algebra — no procedural code.

**Rejected for two concrete reasons:**
1. It would make the **561 ingested assets unpublishable**. Their `approval_status` is NULL, so they cannot satisfy a composite FK requiring `'approved'`. Recording that an IG post was published is a legitimate `content_posts` row. Fixing it would mean backfilling all 561 to `'approved'` — a prod data write, and one `0022` explicitly rejects ("no retroactive gating").
2. It would **block `approved → rejected` on anything already published** (`ON UPDATE RESTRICT`). Revoking clearance for content that has already gone out is a real operation — a takedown — and the schema shouldn't forbid it.

The trigger is scoped to `origin='generated'`, so it does neither. It is verified working in PGlite, which means the guarantee is testable in CI rather than asserted in prose.

### `ON DELETE SET NULL` on the lineage FK

`RESTRICT` is stricter and would turn "never hard-delete a referenced asset" into a DB rule — but it would also **break athlete deletion**: `media_assets.athlete_id` is `ON DELETE CASCADE`, so offboarding/GDPR removal of an athlete would hit the RESTRICT between her own assets and fail. `CASCADE` is worse — deleting one source frame would silently take out every variant derived from it. `SET NULL` is the only option that survives both. Losing a pointer is recoverable; losing the asset is not.

## 6 · The approval state machine

**Three different state concepts exist here and they must not be merged.** Naming them explicitly, because this is the thing most likely to get muddled:

| Concept | Where it lives | Question it answers | Status |
|---|---|---|---|
| Job lifecycle | `generation_jobs.status` | Did the work run? | A3.1, now |
| Content clearance | `media_assets.approval_status` | May this be published? | A3.1, now |
| Spend approval | *nothing — not persisted* | May we spend to run this? | **U2** (§4) |

### States (`media_assets.approval_status`)

| State | Meaning |
|---|---|
| `NULL` | Ungated. Ingested/connected content. Not in the machine at all — no retroactive gating |
| `draft` | Generated content exists but is not cleared. **Initial state for every `origin='generated'` asset** |
| `approved` | Cleared for embed and publish |
| `rejected` | Refused. Stays for the record; the asset is not deleted |

### Transition table

| From ↓ / To → | `NULL` | `draft` | `approved` | `rejected` |
|---|---|---|---|---|
| `NULL` | — | ✗ forbidden | ✗ forbidden | ✗ forbidden |
| `draft` | ✗ forbidden | — | ✅ **clear** | ✅ **refuse** |
| `approved` | ✗ forbidden | ✗ forbidden | — | ✅ **revoke / takedown** |
| `rejected` | ✗ forbidden | ✅ **reopen** | ✗ forbidden | — |

Reasoning for the forbidden ones:
- **`* → NULL`** — un-gating is not a transition. NULL means "was never gated"; once content enters the machine it stays in it, or the audit trail lies.
- **`NULL → anything`** — an ingested IG photo does not need clearance. Letting it enter would silently gate 561 existing assets.
- **`approved → draft`** — no silent un-approval. Withdrawing clearance is `approved → rejected`, which is visible and reads as a decision. Getting back to a working state is then `rejected → draft`.
- **`rejected → approved`** — no one-step rehabilitation. A rejected asset goes back to `draft` and is cleared deliberately, so approving something previously refused is always two explicit acts.

### Where enforcement lives

**One chokepoint, plus a database backstop.**

```ts
// server/studio/approval.ts
const LEGAL: Record<string, ApprovalStatus[]> = {
  draft:    ["approved", "rejected"],
  approved: ["rejected"],
  rejected: ["draft"],
};

export async function setApprovalStatus(
  athleteId: string, assetId: string, next: ApprovalStatus,
): Promise<MediaAsset>
```

It (1) loads the asset **filtered by `athlete_id`** — tenancy, non-negotiable; (2) refuses if current is `NULL` (not in the machine); (3) refuses if `next` is not in `LEGAL[current]`, throwing `GenerationError(..., "invalid_input")` naming both states; (4) writes with a **guarded UPDATE** — `WHERE id = $1 AND athlete_id = $2 AND approval_status = $current` — so two concurrent transitions can't both win. Zero rows updated ⇒ someone else moved it ⇒ throw.

Nothing else in the codebase may write `approval_status`. That is enforceable by review because there is exactly one writer today (none) and this becomes the one.

### The "nothing publishes from draft" guarantee, concretely

Three layers, weakest to strongest:

1. **Application** — `publishAsset()` refuses unless `approval_status = 'approved'` for generated assets.
2. **Database** — the trigger in §5. Even a raw `INSERT INTO content_posts` from a script or psql is refused. *Verified under PGlite: generated+draft → `REFUSED`, generated+approved → `ALLOWED`, ingested/NULL → `ALLOWED`.*
3. **Test** — a PGlite case asserting exactly those three outcomes, so the guarantee is checked on every CI run rather than believed.

Layer 2 is the one that actually matters: it holds even for code that hasn't been written yet.

## 7 · The lineage model

Three pointers, each answering a different question. No join table.

| Pointer | Direction | Answers | Set when |
|---|---|---|---|
| `media_assets.generation_job_id` | asset → job | "what made this?" | Both modes, always |
| `media_assets.derived_from_asset_id` | asset → source asset | "what did this come from?" | **edit only** |
| `generation_jobs.brief` (jsonb) | job → every input | "what exactly was asked, with which references?" | Both modes, always |

**Recorded per mode:**

- **`edit`** — output asset gets `origin='generated'`, `approval_status='draft'`, `generation_job_id=<job>`, `derived_from_asset_id=<the preserved frame>`. The job carries `mode='edit'`, `source_asset_id`, and the frozen brief including `job.source.editRegions` — so the exact mask geometry that produced the output is recoverable.
- **`generate`** — same, except `derived_from_asset_id` is **NULL** (there is no frame to preserve — that is the definition of the mode) and `source_asset_id` is NULL, enforced by `generation_jobs_edit_needs_source`.

**Why the frozen brief instead of a `generation_inputs` join table:** a generate job's inputs are not only assets — they are brand reference imagery (external URLs), product-piece references, palette, prompt text, and the direction. A join table models only the asset-shaped subset and would need a parallel mechanism for the rest, i.e. two half-records of the same thing. The brief already carries all of it in one immutable object, and A2 built it. **Deliberately not building the join table.**

The one thing this costs: "which assets fed this job" is a jsonb query rather than an index scan. At the volumes in play (0 jobs today) that is not a real cost, and `derived_from_asset_id` covers the one traversal that matters — "show me everything derived from this photo" — with a real index.

## 8 · Reuse, and what is deliberately not built

**Copying:**
- **`media_backfill_state`** for the resumable-job shape — `status` (`pending|running|complete|error`), `last_error`, `updated_at`. `generation_jobs.status` is the same idea with `succeeded/failed/canceled` instead of `complete/error`, because a generation can be cancelled by the athlete and a backfill cannot.
- **`pending_actions`** for the propose→approve→execute discipline and its per-transition timestamps (`created_at / started_at / completed_at`).
- **`studio/costLog.ts`** unchanged — jobs record cost as quoted; the cost log stays the record of what ran.
- **`GenerationError`** from `studio/types.ts` for every refusal, rather than a new error class.

**Deliberately not building — confirming these stay out:**
- **Job leasing. Confirmed out.** No `lease_expires_at`, no `worker_id`, no `FOR UPDATE SKIP LOCKED`. There is one process and no concurrent worker pool; leasing solves a problem we do not have and is the single most expensive thing to get wrong.
- No retry/backoff columns (`attempts`, `next_attempt_at`). A failed job is failed; re-running is a new job with its own row and its own cost line.
- No queue table, no scheduler, no cron. A3.1 records jobs; it does not run them.
- No `generation_inputs` join table (§7).
- No new approval states, and no change to the existing `approval_status` CHECK.

## 9 · Migration plan

**Order:**

1. `shared/schema.ts` — add `generationJobs`, add `generation_job_id` to `mediaAssets`, add the FK/CHECK/index declarations. Drizzle-side only; changes nothing at runtime.
2. `migrations/0027_studio_generation.sql` — the DDL in §5 verbatim, with the same "this file records intent, the executor is deploy.yml" header `0022` carries.
3. **Prod application is NOT mine.** The executor is the `psql` block in `.github/workflows/deploy.yml`, and that path is out of my lane. I will write the exact statements to paste and hand them over. → **Open question Q5.**
4. PGlite tests: the schema is pushed into PGlite from `shared/schema.ts` by `initTestDb()`, so tests pick it up automatically — **except the trigger**, which is not expressible in Drizzle and must be applied by the test's own `client.exec()`. That asymmetry needs a small helper so the trigger is tested from the same source string the migration uses. → **Open question Q4.**

**Confirmation that this never touches existing prod data:**

| Statement kind | Count | Touches rows? |
|---|---|---|
| `ADD CONSTRAINT ... FOREIGN KEY` | 1 | Validates 564 rows (all NULL) — passes, writes nothing |
| `ADD CONSTRAINT ... CHECK` | 1 | Validates 564 rows (`connected`/`upload`, both listed) — passes, writes nothing |
| `CREATE TABLE` | 1 | New, empty |
| `ADD COLUMN` | 1 | Nullable, no default ⇒ metadata-only in PG11+, no rewrite |
| `CREATE INDEX` | 5 | Read-only build over 564 rows |
| `CREATE TRIGGER` / `FUNCTION` | 1 | Affects future inserts only |

**No `UPDATE`, `DELETE`, `DROP COLUMN`, `TRUNCATE`, or backfill anywhere.** Every existing row is untouched, and the two new constraints were checked against the live distribution above precisely so neither can fail on apply.

`CREATE INDEX CONCURRENTLY` is *not* used: the deploy block at line ~148 is not `--single-transaction`, so it would be legal, but at 564 rows the lock is sub-millisecond and CONCURRENTLY adds a failure mode (invalid indexes on interruption) for no benefit.

---

# Cross-cutting

## 10 · Shared types and coupling

| Touchpoint | A2.5 | A3.1 | Note |
|---|---|---|---|
| `CreativeBrief` (`studio/brief.ts`) | reads it | **stores it frozen** in `generation_jobs.brief` | Tightest coupling. A brief shape change is now a stored-data concern, not just a type concern — the golden test locks it, and stored briefs must be read defensively |
| `BriefGap` / `blockingGaps()` | the gate | — | A2.5 is the only consumer |
| `BriefMode` (`'edit' \| 'generate'`) | picks the router task | **`generation_jobs.mode` CHECK** | Same vocabulary in TS and in the DB. They can drift; the CHECK is the backstop |
| `BriefOrigin` | — | `generation_jobs.origin` CHECK | Same |
| `CostEstimate` (`studio/types.ts`) | narrowed to `EstimatedCost` | `cost_estimated_usd` + `cost_basis` | A3.1 stores what A2.5 quoted |
| `GenerationError` | throws it | throws it | Shared, unchanged |
| `shared/schema.ts` | — | **modified** | The only file outside `server/studio/**` either piece changes |

**Files both touch:** `server/studio/types.ts` (A2.5 adds `GenerationPreview`; A3.1 adds nothing) and `server/studio/brief.ts` (read-only for both). The real coupling is one-directional: **A3.1 depends on A2's brief shape being stable.** That argues for building A2.5 first and A3.1 second, which is the order given.

## 11 · Assumptions that would change the design if wrong

| # | Assumption | Verified? | If wrong |
|---|---|---|---|
| A1 | The Stage-3 columns and content tables exist in prod | ✅ probed | Would become a much larger migration |
| A2 | Nothing reads/writes them today | ✅ grepped — zero hits | Activation could break a live consumer |
| A3 | `approval_status` is 100% NULL, so the machine starts clean | ✅ probed — 564/564 | Would need a backfill decision |
| A4 | PGlite supports plpgsql triggers | ✅ probed | The DB guarantee would drop to app-only; I'd revisit the composite FK |
| A5 | `origin` only ever holds `connected`/`upload` today | ✅ probed | The CHECK would fail on apply |
| A6 | `deploy.yml`'s psql block is the real executor and `migrations/*.sql` are records | ✅ read `0022`'s header + `deploy.yml` | Migration plan changes entirely |
| A7 | **One process, no concurrent workers** — so no leasing | ❌ **not verified** | If jobs will ever be picked up by >1 Cloud Run instance, `status='running'` races and leasing becomes necessary. → **Q3** |
| A8 | **A generated asset always produces exactly one `media_assets` row** | ❌ **not verified** | `n > 1` on the router produces several assets per job. If a job can yield 4 variants, they all share `generation_job_id` (fine) — but "the output asset" language in §7 needs to become plural. → **Q2** |

A7 and A8 are the two I could not settle by probing; both are product decisions.

## 12 · Open questions — your call before I build

**Q1 · Naming.** `GenerationPlan` is taken by the router. Do you want A2.5's output called **`GenerationPreview`** (my proposal, wraps the existing `GenerationPlan` untouched), or would you rather rename the router's type and free the name up? The rename touches `router.estimate()`'s signature and its tests.

**Q2 · One asset per job, or many?** The router takes `n`. If a job may return 4 variants the athlete picks from, `generation_jobs` is 1:N with `media_assets` (already true via `generation_job_id`) but the approval machine then applies **per asset**, and "approve the job" is not a thing. I've designed for **per-asset approval with N allowed**, which I think is right — confirm?

**Q3 · Will generation ever run on more than one instance?** I've confirmed leasing stays out per your instruction. I want to flag the consequence explicitly: with multiple Cloud Run instances polling `status='pending'`, two could claim the same job and double-spend. Single-runner is safe. If that changes, this is the first thing that must change with it.

**Q4 · Where should the trigger DDL live so tests and prod share one source?** Drizzle can't express a trigger, so it can't ride `initTestDb()`. My proposal: a single exported SQL string in `server/studio/sql/contentPostsApproval.sql`, imported by both the migration file and the test's `client.exec()`. Slightly unusual — happy to instead duplicate it and add a test asserting the two match.

**Q5 · Who applies the DDL?** `.github/workflows/deploy.yml` is out of my lane. I'll write `0027_studio_generation.sql` and hand you the exact statements — confirm you (or Mia) will paste them into the deploy block, and whether you want that done before or after the code merges. The code is safe either way: nothing reads `generation_jobs` until it exists, but a job insert would fail until the DDL lands.

**Q6 · Minor — `rejected → draft` reopen.** I've allowed it so a refused asset can be reworked, with `rejected → approved` forbidden so rehabilitation is always two deliberate acts. If you'd rather rejection be terminal, say so and I'll drop the reopen edge.

---

## Build order once approved

1. A2.5 — `preview.ts` + brief→inputs mapping + tests. No schema.
2. A3.1 — `shared/schema.ts` + `0027_studio_generation.sql` + `approval.ts` + PGlite tests incl. the trigger.
3. Review pass, then commit. DDL handed over, not applied.
