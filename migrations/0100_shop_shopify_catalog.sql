-- 0100_shop_shopify_catalog.sql — the catalog-only Shopify app for Her picks (docs/design/shop-her-picks.md §12).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declarations ship in ONE commit or the drift gate reds the deploy. Needs 0096 (shop_items).
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- shopify_shops          one row per store that installed the app (scope read_products only). Brand data. The offline
--                        token is ALWAYS a tokenCrypto kms1: envelope — the CHECK refuses anything else — and is NULLed
--                        on uninstall.
-- shop_catalog_products  the store's products (title, handle, URL, image, price, availability). Brand data.
-- shop_brand_approvals   the brand's yes / no to an athlete featuring its products, and the code it gave her. Hers.
-- shop_items.catalog_product_id  a pick chosen from a catalog (SET NULL when the catalog row goes).
--
-- No orders, no customers, no money anywhere. Additive: three new tables and one nullable column. Every statement
-- re-runs as a no-op. Names and definitions are written exactly as a shared/schema.ts push produces them. No
-- transaction control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK.

CREATE TABLE IF NOT EXISTS shopify_shops (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  shop_domain    text NOT NULL,
  primary_domain text,
  name           text,
  brand_id       integer,
  access_token   text,
  scopes         text,
  status         text DEFAULT 'installed' NOT NULL,
  installed_at   timestamp with time zone,
  uninstalled_at timestamp with time zone,
  last_synced_at timestamp with time zone,
  created_at     timestamp with time zone DEFAULT now() NOT NULL,
  updated_at     timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT shopify_shops_status_check CHECK (status IN ('installed','uninstalled')),
  CONSTRAINT shopify_shops_token_sealed_check CHECK (access_token IS NULL OR access_token LIKE 'kms1:%')
);

CREATE TABLE IF NOT EXISTS shop_catalog_products (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  shop_id            uuid NOT NULL,
  shopify_product_id text NOT NULL,
  handle             text NOT NULL,
  title              text NOT NULL,
  vendor             text,
  product_type       text,
  product_url        text NOT NULL,
  image_url          text,
  price_cents        integer,
  currency           text,
  available          boolean DEFAULT true NOT NULL,
  product_status     text,
  synced_at          timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_brand_approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  shop_id      uuid NOT NULL,
  athlete_id   uuid NOT NULL,
  status       text DEFAULT 'pending' NOT NULL,
  code         text,
  requested_at timestamp with time zone DEFAULT now() NOT NULL,
  decided_at   timestamp with time zone,
  CONSTRAINT shop_brand_approvals_status_check CHECK (status IN ('pending','approved','declined','revoked'))
);

ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS catalog_product_id uuid;

ALTER TABLE shopify_shops DROP CONSTRAINT IF EXISTS shopify_shops_brand_id_inbox_brands_id_fk;
ALTER TABLE shopify_shops ADD CONSTRAINT shopify_shops_brand_id_inbox_brands_id_fk
  FOREIGN KEY (brand_id) REFERENCES public.inbox_brands(id) ON DELETE no action ON UPDATE no action;

ALTER TABLE shop_catalog_products DROP CONSTRAINT IF EXISTS shop_catalog_products_shop_id_shopify_shops_id_fk;
ALTER TABLE shop_catalog_products ADD CONSTRAINT shop_catalog_products_shop_id_shopify_shops_id_fk
  FOREIGN KEY (shop_id) REFERENCES public.shopify_shops(id) ON DELETE cascade ON UPDATE no action;

ALTER TABLE shop_brand_approvals DROP CONSTRAINT IF EXISTS shop_brand_approvals_shop_id_shopify_shops_id_fk;
ALTER TABLE shop_brand_approvals ADD CONSTRAINT shop_brand_approvals_shop_id_shopify_shops_id_fk
  FOREIGN KEY (shop_id) REFERENCES public.shopify_shops(id) ON DELETE cascade ON UPDATE no action;

ALTER TABLE shop_brand_approvals DROP CONSTRAINT IF EXISTS shop_brand_approvals_athlete_id_athletes_id_fk;
ALTER TABLE shop_brand_approvals ADD CONSTRAINT shop_brand_approvals_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;

ALTER TABLE shop_items DROP CONSTRAINT IF EXISTS shop_items_catalog_product_id_shop_catalog_products_id_fk;
ALTER TABLE shop_items ADD CONSTRAINT shop_items_catalog_product_id_shop_catalog_products_id_fk
  FOREIGN KEY (catalog_product_id) REFERENCES public.shop_catalog_products(id) ON DELETE set null ON UPDATE no action;

CREATE UNIQUE INDEX IF NOT EXISTS shopify_shops_domain_uq ON shopify_shops USING btree (shop_domain);
CREATE UNIQUE INDEX IF NOT EXISTS shop_catalog_products_shop_product_uq ON shop_catalog_products USING btree (shop_id, shopify_product_id);
CREATE INDEX IF NOT EXISTS idx_shop_catalog_products_shop ON shop_catalog_products USING btree (shop_id, title);
CREATE UNIQUE INDEX IF NOT EXISTS shop_brand_approvals_shop_athlete_uq ON shop_brand_approvals USING btree (shop_id, athlete_id);
