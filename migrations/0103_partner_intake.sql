-- 0103_partner_intake.sql — the Partner door of her public profile: brand and press requests, the Nomila relay thread
-- on the opportunity, and the Serious offer hold (docs: design-public-card-v3 §6, §6a, §7a, §11; "v2: Mila at the
-- centre"). Dark behind PUBLIC_CARD + PARTNER_INTAKE (both off).
--
-- 0101 and 0102 belong to other tracks; the whole partner stack (PRs 1–3) shares this ONE numbered file, so its
-- schema lands in the first PR and the later PRs only add code.
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declarations ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- partner_requests      — one request sent to her from her public profile (kind sponsorship | content | endorsement |
--                         appearance | press | other). drafting → awaiting_email → confirmed (lands as a deal) or expired
--                         (72h unconfirmed). Token HASHES only (draft, confirm, status page, reply-to address).
-- partner_settings      — her Serious offer switch and amount (on by default, $50; $50/$100/$150/$250).
-- brand_site_previews   — the light homepage read (title / description / og tags), 7-day cache. Brand data.
-- partner_fit_previews  — Mila's first read ("why she fits"), cached per (athlete, card version, domain).
-- public_rate_counters  — database-backed counters for the public routes (keyed hashes; no IP stored).
-- partner_visitor_codes — 6-digit email codes for "Your requests" and the forwarded-link re-check (hashes only).
-- inbox_messages        — moderation + moderation_reason, NULL except on platform 'nomila' (relayed) rows; held_body:
--                         a held / blocked message's text, kept OUT of body so no body reader ever shows it.
-- deals                 — deposit_status gains 'credited' (the hold captured and counted toward the first payment).
-- payments              — partner_request_id (a Serious-offer hold placed before the request is confirmed, so before
--                         any deal exists); credit_cents + credit_payment_id (the captured hold credited against the
--                         brand's first deal payment); payments_subject_check widened for that one case only.
--
-- Every existing payments row has partner_request_id / credit_* NULL, so the new checks validate against current data
-- with no backfill. Every statement re-runs as a no-op (IF NOT EXISTS, or DROP-then-ADD of a named constraint). Names
-- and definitions are written exactly as a shared/schema.ts push produces them.
-- No transaction control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK.

CREATE TABLE IF NOT EXISTS partner_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id          uuid NOT NULL CONSTRAINT partner_requests_athlete_id_athletes_id_fk REFERENCES athletes(id),
  public_ref          text NOT NULL,
  kind                text NOT NULL,
  status              text NOT NULL DEFAULT 'drafting',
  outcome             text,
  snapshot_version    integer,
  website             text,
  domain              text,
  brand_name          text NOT NULL,
  display_name        text NOT NULL,
  site_meta           jsonb,
  fit_preview         jsonb,
  brief               jsonb NOT NULL,
  contact_name        text,
  contact_email       text,
  contact_email_hash  text NOT NULL,
  email_domain_match  boolean NOT NULL DEFAULT false,
  draft_token_hash    text NOT NULL,
  token_nonce         text NOT NULL,
  confirm_token_hash  text,
  status_token_hash   text,
  reply_token_hash    text,
  deal_id             uuid CONSTRAINT partner_requests_deal_id_deals_id_fk REFERENCES deals(id),
  inbox_thread_id     uuid CONSTRAINT partner_requests_inbox_thread_id_inbox_threads_id_fk REFERENCES inbox_threads(id),
  expires_at          timestamptz NOT NULL,
  sent_at             timestamptz,
  confirmed_at        timestamptz,
  brief_seen_at       timestamptz,
  first_reply_at      timestamptz,
  decided_at          timestamptz,
  contact_redacted_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_requests_kind_check      CHECK (kind IN ('sponsorship','content','endorsement','appearance','press','other')),
  CONSTRAINT partner_requests_status_check    CHECK (status IN ('drafting','awaiting_email','confirmed','expired')),
  CONSTRAINT partner_requests_outcome_check   CHECK (outcome IS NULL OR (outcome IN ('agreed','declined') AND status = 'confirmed' AND decided_at IS NOT NULL)),
  CONSTRAINT partner_requests_confirmed_check CHECK (status <> 'confirmed' OR (deal_id IS NOT NULL AND confirmed_at IS NOT NULL AND status_token_hash IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS partner_requests_public_ref_uq    ON partner_requests USING btree (public_ref);
CREATE UNIQUE INDEX IF NOT EXISTS partner_requests_draft_token_uq   ON partner_requests USING btree (draft_token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS partner_requests_confirm_token_uq ON partner_requests USING btree (confirm_token_hash) WHERE confirm_token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS partner_requests_status_token_uq  ON partner_requests USING btree (status_token_hash) WHERE status_token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS partner_requests_reply_token_uq   ON partner_requests USING btree (reply_token_hash) WHERE reply_token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS partner_requests_deal_uq          ON partner_requests USING btree (deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_partner_requests_athlete_status  ON partner_requests USING btree (athlete_id, status);
CREATE INDEX IF NOT EXISTS idx_partner_requests_email_hash      ON partner_requests USING btree (contact_email_hash);
CREATE INDEX IF NOT EXISTS idx_partner_requests_status_expires  ON partner_requests USING btree (status, expires_at);

CREATE TABLE IF NOT EXISTS partner_settings (
  athlete_id            uuid PRIMARY KEY CONSTRAINT partner_settings_athlete_id_athletes_id_fk REFERENCES athletes(id),
  serious_offer_enabled boolean NOT NULL DEFAULT true,
  serious_offer_cents   integer NOT NULL DEFAULT 5000,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_settings_amount_check CHECK (serious_offer_cents IN (5000,10000,15000,25000))
);

CREATE TABLE IF NOT EXISTS brand_site_previews (
  domain     text PRIMARY KEY,
  readable   boolean NOT NULL,
  site_meta  jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS partner_fit_previews (
  athlete_id       uuid NOT NULL CONSTRAINT partner_fit_previews_athlete_id_athletes_id_fk REFERENCES athletes(id),
  snapshot_version integer NOT NULL,
  domain           text NOT NULL,
  lines            jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_fit_previews_athlete_id_snapshot_version_domain_pk PRIMARY KEY (athlete_id, snapshot_version, domain)
);

CREATE TABLE IF NOT EXISTS public_rate_counters (
  bucket       text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  CONSTRAINT public_rate_counters_bucket_window_start_pk PRIMARY KEY (bucket, window_start)
);

CREATE TABLE IF NOT EXISTS partner_visitor_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_hash text NOT NULL,
  code_hash  text NOT NULL,
  attempts   integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partner_visitor_codes_email ON partner_visitor_codes USING btree (email_hash, created_at);

-- ── inbox_messages: relay moderation, only on platform 'nomila' rows (no CHECK on platform itself, so no change there) ──
ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS moderation text;
ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS moderation_reason text;
ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS held_body text;
ALTER TABLE inbox_messages DROP CONSTRAINT IF EXISTS inbox_messages_moderation_check;
ALTER TABLE inbox_messages ADD CONSTRAINT inbox_messages_moderation_check CHECK (moderation IS NULL OR (platform = 'nomila' AND moderation IN ('pending','clean','held','blocked')));
ALTER TABLE inbox_messages DROP CONSTRAINT IF EXISTS inbox_messages_held_body_check;
ALTER TABLE inbox_messages ADD CONSTRAINT inbox_messages_held_body_check CHECK (held_body IS NULL OR moderation IN ('held','blocked'));

-- ── deals: 'credited' — a Serious-offer hold captured when she agreed, counted toward the brand's first payment ──
ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_deposit_status_check;
ALTER TABLE deals ADD CONSTRAINT deals_deposit_status_check CHECK (deposit_status IN ('none','held','released','expired','credited'));

-- ── payments: the Serious-offer hold before a deal exists, and its credit against the first payment ──
ALTER TABLE payments ADD COLUMN IF NOT EXISTS partner_request_id uuid;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS credit_cents integer;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS credit_payment_id uuid;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_partner_request_id_partner_requests_id_fk;
ALTER TABLE payments ADD CONSTRAINT payments_partner_request_id_partner_requests_id_fk FOREIGN KEY (partner_request_id) REFERENCES partner_requests(id);
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_credit_payment_id_payments_id_fk;
ALTER TABLE payments ADD CONSTRAINT payments_credit_payment_id_payments_id_fk FOREIGN KEY (credit_payment_id) REFERENCES payments(id);
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_subject_check;
ALTER TABLE payments ADD CONSTRAINT payments_subject_check CHECK (
  (kind = 'booking_payment' AND booking_id IS NOT NULL AND deal_id IS NULL AND partner_request_id IS NULL)
  OR (kind = 'deal_payment' AND deal_id IS NOT NULL AND booking_id IS NULL AND partner_request_id IS NULL)
  OR (kind = 'deposit' AND booking_id IS NULL AND (deal_id IS NOT NULL OR partner_request_id IS NOT NULL))
);
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_credit_check;
ALTER TABLE payments ADD CONSTRAINT payments_credit_check CHECK (
  (credit_cents IS NULL AND credit_payment_id IS NULL)
  OR (kind = 'deal_payment' AND credit_cents > 0 AND credit_payment_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_partner_request ON payments USING btree (partner_request_id) WHERE partner_request_id IS NOT NULL;
