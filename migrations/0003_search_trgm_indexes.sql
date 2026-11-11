CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_deals_brand_name_trgm ON deals USING GIN (brand_name gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inbox_brands_name_trgm ON inbox_brands USING GIN (name gin_trgm_ops);
