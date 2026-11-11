# Runbook — Brand Identity Backfill (re-attribution + dedup, model A)

Migration that re-attributes agency-mediated deals to the real advertiser, dedups brand
identity on `normalized_name`, makes `inbox_brands.domain` nullable, and flags agency rows.
Runs on deploy via `server/scripts/backfillBrandIdentityWrite.ts` (after `db:migrate`).

- **Schema** (add `normalized_name`/`is_agency`, swap constraints) is **idempotent** — runs every deploy.
- **Data backfill** (re-point `brand_id`, create advertiser rows, write `classification.advertiser`,
  flag `is_agency`, sync `deals.brand_name`) runs **once**, guarded by `brand_identity_backfill_marker`.
- Aliases (`get brick→brick`, `fazit beauty→fazit`) are **self-validated** — applied only when the
  target row exists and shares a domain in the data; otherwise skipped + logged.

---

## 1. Pre-flight: collision check (READ-ONLY, run any time)
Run ahead of a release so collisions surface on your schedule, not mid-deploy:

```bash
DATABASE_URL=<prod-or-dump> npx tsx --require dotenv/config server/scripts/checkBrandCollisions.ts
# exit 0 = safe to migrate · exit 1 = collisions listed (with the colliding rows)
```
It recomputes `normalized_name` (with validated aliases) and reports any two **distinct** brands
that would collide on the `UNIQUE(normalized_name)` index. Writes nothing.

## 2. Force a data re-run
The data backfill is normally skipped after the first successful run. To re-apply it (it reverts
from the snapshots, then re-runs deterministically — **this discards manual brand edits made since**):

```bash
FORCE_BRAND_BACKFILL=1 DATABASE_URL=<db> npx tsx --require dotenv/config server/scripts/backfillBrandIdentityWrite.ts
```

## 3. Roll back (restore from snapshots)
Snapshots captured at first run: `inbox_brands_bak`, `threads_brand_bak`, `deals_brand_bak`.
Run as one transaction (restores pointers first, then drops rows created by the backfill):

```sql
BEGIN;
UPDATE inbox_threads t SET brand_id = k.brand_id, classification = k.classification
  FROM threads_brand_bak k WHERE t.id = k.id;
UPDATE deals d SET brand_name = k.brand_name FROM deals_brand_bak k WHERE d.id = k.id;
UPDATE inbox_brands SET is_agency = false;
UPDATE inbox_brands b SET domain = k.domain, logo_url = k.logo_url
  FROM inbox_brands_bak k WHERE b.id = k.id;
DELETE FROM inbox_brands WHERE id NOT IN (SELECT id FROM inbox_brands_bak);
DELETE FROM brand_identity_backfill_marker;   -- lets a future deploy re-apply the backfill
COMMIT;
```
This reverts the **data**. The added columns (`normalized_name`, `is_agency`) and the
`UNIQUE(normalized_name)` index are harmless to leave. To fully revert the **schema** too (only after
the data rollback, since it restores original non-null/unique domains):

```sql
DROP INDEX IF EXISTS inbox_brands_normalized_name_key;
ALTER TABLE inbox_brands ALTER COLUMN domain SET NOT NULL;
ALTER TABLE inbox_brands ADD CONSTRAINT inbox_brands_domain_key UNIQUE (domain);
-- optional: ALTER TABLE inbox_brands DROP COLUMN normalized_name, DROP COLUMN is_agency;
```

## 4. Interpreting a collision-gate abort on deploy
Deploy log shows:
```
BACKFILL FAILED (rolled back): COLLISION GATE: <normalized_name>×<n>, ...
```
Meaning: two distinct brands normalized to the same `normalized_name`; the migration **rolled back
the whole transaction and exited non-zero**, so `set -e` aborted the deploy — **nothing shipped, no
partial DB changes** (the snapshot tables may exist; that's harmless). The `UNIQUE` is never forced.

To resolve:
1. `checkBrandCollisions.ts` (step 1) to list the colliding rows.
2. Either rename/merge one side in `inbox_brands`, or add a **validated** alias candidate in
   `brandResolver.ts` `ALIAS_CANDIDATES` (it only applies if it shares a domain in the data).
3. Re-run the deploy.

## Notes
- `tsx` is a dependency and `npm ci` runs before the migration step, so the script is available on deploy.
- The collision check / migration import the same `normalizeBrand`, so dev and prod normalize identically.
- A name that normalizes to empty (`""`) is stored as `NULL` (multiple allowed), never `''`.
