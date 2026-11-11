-- 0099_bookings.sql — Bookings v2, PR B1: the schema for paid bookings sold from her public card. Schema only;
-- nothing reads or writes these tables until later PRs, and the feature is dark behind BOOKINGS_ENABLED (off).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declarations ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- offers           — what she sells: format, HER price (she receives 100%), length, virtual (LiveKit or a pasted link)
--                    or in person (her chosen venue; ID + selfie always required), her rules, HER cancellation window
--                    (free_cancel_hours, default 24; v2.1) under a versioned policy_key, status (+ paused_reason, e.g.
--                    'no_show_review' after BOOKING_NO_SHOW_PAUSE_THRESHOLD athlete no-shows).
-- offer_slots      — the concrete times she offers (slots mode).
-- bookings         — one buyer request start to finish: snapshots of what was agreed (price, the ONE service fee,
--                    all-in total, her cancellation window + policy version), no-show marking (no_show_by; v2.1), minimal buyer data (contact never shown to her unless she shares contact), verification
--                    state (email/phone code, Stripe Identity status), where/when (revealed only after payment), and
--                    the clocks. uq_bookings_live_slot stops a slot being held twice.
-- booking_events   — append-only history, incl. LiveKit attendance (evidence only, never releases money) and
--                    no-show marks (kind 'no_show').
-- booking_messages — Nomila-relayed messages with a moderation state.
-- booking_reports  — the trust-and-safety review queue; an open row freezes the 48h auto-release.
-- safety_blocks    — blocks (hers) and platform bans, as keyed hashes / Stripe card fingerprints only.
-- athlete_payout_adjustments — the Stripe fee she owes back when SHE causes a refund (the actual fee, deducted
--                    from her next payout); her first athlete-caused cancellation is waived (one 'waived' row).
-- payments         — deal_id becomes NULLable; booking_id (NO cascade: payments is the ledger); kind gains
--                    'booking_payment'; payments_subject_check = exactly one subject per kind; one payment per booking.
--
-- Every existing payments row has deal_id set, booking_id NULL and kind deposit|deal_payment, so both new checks
-- validate against current data with no backfill. Every statement re-runs as a no-op (IF NOT EXISTS, or DROP-then-ADD
-- of a named constraint). Names and definitions are written exactly as a shared/schema.ts push produces them.
-- No transaction control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK.

CREATE TABLE IF NOT EXISTS offers (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id              uuid NOT NULL CONSTRAINT offers_athlete_id_athletes_id_fk REFERENCES athletes(id),
  public_id               text NOT NULL CONSTRAINT offers_public_id_unique UNIQUE,
  format                  text NOT NULL,
  title                   text NOT NULL,
  description             text,
  price_cents             integer NOT NULL,
  currency                text NOT NULL DEFAULT 'usd',
  duration_minutes        integer NOT NULL,
  location_mode           text NOT NULL,
  video_mode              text,
  venue                   text,
  require_id_verification boolean NOT NULL DEFAULT false,
  allow_minor_attendees   boolean NOT NULL DEFAULT false,
  returning_buyers_only   boolean NOT NULL DEFAULT false,
  scheduling_mode         text NOT NULL DEFAULT 'request',
  available_from          date,
  available_until         date,
  free_cancel_hours       integer NOT NULL DEFAULT 24,
  policy_key              text NOT NULL DEFAULT 'athlete_window_v1',
  status                  text NOT NULL DEFAULT 'draft',
  paused_reason           text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offers_format_check          CHECK (format IN ('video_call','appearance','clinic','custom')),
  CONSTRAINT offers_location_mode_check   CHECK (location_mode IN ('virtual','in_person')),
  CONSTRAINT offers_video_mode_check      CHECK (video_mode IS NULL OR video_mode IN ('livekit','link')),
  CONSTRAINT offers_scheduling_mode_check CHECK (scheduling_mode IN ('slots','request')),
  CONSTRAINT offers_status_check          CHECK (status IN ('draft','published','paused','archived')),
  CONSTRAINT offers_price_check           CHECK (price_cents > 0),
  CONSTRAINT offers_duration_check        CHECK (duration_minutes > 0),
  CONSTRAINT offers_in_person_id_check    CHECK (location_mode <> 'in_person' OR require_id_verification),
  CONSTRAINT offers_free_cancel_hours_check CHECK (free_cancel_hours > 0 AND free_cancel_hours <= 720),
  CONSTRAINT offers_paused_reason_check   CHECK (paused_reason IS NULL OR (status = 'paused' AND paused_reason IN ('athlete','no_show_review','support')))
);
CREATE INDEX IF NOT EXISTS idx_offers_athlete_status ON offers USING btree (athlete_id, status);

CREATE TABLE IF NOT EXISTS offer_slots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id     uuid NOT NULL CONSTRAINT offer_slots_offer_id_offers_id_fk REFERENCES offers(id),
  athlete_id   uuid NOT NULL CONSTRAINT offer_slots_athlete_id_athletes_id_fk REFERENCES athletes(id),
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  withdrawn_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offer_slots_time_check CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_offer_slots_offer ON offer_slots USING btree (offer_id, starts_at);

CREATE TABLE IF NOT EXISTS bookings (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id                 uuid NOT NULL CONSTRAINT bookings_athlete_id_athletes_id_fk REFERENCES athletes(id),
  offer_id                   uuid NOT NULL CONSTRAINT bookings_offer_id_offers_id_fk REFERENCES offers(id),
  slot_id                    uuid CONSTRAINT bookings_slot_id_offer_slots_id_fk REFERENCES offer_slots(id),
  status                     text NOT NULL DEFAULT 'unverified',
  format                     text NOT NULL,
  title                      text NOT NULL,
  duration_minutes           integer NOT NULL,
  location_mode              text NOT NULL,
  policy_key                 text NOT NULL,
  free_cancel_hours          integer NOT NULL,
  price_cents                integer NOT NULL,
  service_fee_cents          integer NOT NULL,
  buyer_total_cents          integer NOT NULL,
  currency                   text NOT NULL DEFAULT 'usd',
  buyer_kind                 text NOT NULL DEFAULT 'fan',
  buyer_org_name             text,
  buyer_name                 text NOT NULL,
  buyer_email                text NOT NULL,
  buyer_phone                text,
  buyer_email_hash           text NOT NULL,
  buyer_phone_hash           text,
  buyer_message              text,
  buyer_timezone             text,
  buyer_adult_attested       boolean NOT NULL DEFAULT false,
  minor_attendee             boolean NOT NULL DEFAULT false,
  parent_present_attested    boolean NOT NULL DEFAULT false,
  buyer_token_hash           text NOT NULL CONSTRAINT bookings_buyer_token_hash_unique UNIQUE,
  otp_channel                text,
  otp_hash                   text,
  otp_expires_at             timestamptz,
  otp_attempts               integer NOT NULL DEFAULT 0,
  email_verified_at          timestamptz,
  phone_verified_at          timestamptz,
  identity_required          boolean NOT NULL DEFAULT false,
  identity_status            text,
  stripe_identity_session_id text,
  identity_verified_at       timestamptz,
  contact_shared_at          timestamptz,
  proposed_note              text,
  starts_at                  timestamptz,
  ends_at                    timestamptz,
  meeting_mode               text,
  meeting_link               text,
  venue                      text,
  respond_by                 timestamptz,
  pay_by                     timestamptz,
  accepted_at                timestamptz,
  confirmed_at               timestamptz,
  athlete_done_at            timestamptz,
  buyer_confirmed_at         timestamptz,
  release_due_at             timestamptz,
  released_at                timestamptz,
  canceled_at                timestamptz,
  canceled_by                text,
  refund_outcome             text,
  no_show_by                 text,
  no_show_marked_at          timestamptz,
  buyer_redacted_at          timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bookings_status_check          CHECK (status IN ('unverified','requested','accepted','confirmed','in_review','issue_reported','disputed','released','declined','withdrawn','expired','canceled','refunded')),
  CONSTRAINT bookings_format_check          CHECK (format IN ('video_call','appearance','clinic','custom')),
  CONSTRAINT bookings_location_mode_check   CHECK (location_mode IN ('virtual','in_person')),
  CONSTRAINT bookings_buyer_kind_check      CHECK (buyer_kind IN ('fan','brand')),
  CONSTRAINT bookings_otp_channel_check     CHECK (otp_channel IS NULL OR otp_channel IN ('email','phone')),
  CONSTRAINT bookings_identity_status_check CHECK (identity_status IS NULL OR identity_status IN ('pending','verified','requires_input','canceled')),
  CONSTRAINT bookings_meeting_mode_check    CHECK (meeting_mode IS NULL OR meeting_mode IN ('livekit','link','in_person')),
  CONSTRAINT bookings_canceled_by_check     CHECK (canceled_by IS NULL OR canceled_by IN ('buyer','athlete','system','admin')),
  CONSTRAINT bookings_refund_outcome_check  CHECK (refund_outcome IS NULL OR refund_outcome IN ('full','price_only','none')),
  CONSTRAINT bookings_amounts_check         CHECK (price_cents > 0 AND service_fee_cents >= 0 AND buyer_total_cents = price_cents + service_fee_cents),
  CONSTRAINT bookings_in_person_id_check    CHECK (location_mode <> 'in_person' OR identity_required),
  CONSTRAINT bookings_minor_parent_check    CHECK (NOT minor_attendee OR parent_present_attested),
  CONSTRAINT bookings_free_cancel_hours_check CHECK (free_cancel_hours > 0 AND free_cancel_hours <= 720),
  CONSTRAINT bookings_no_show_by_check      CHECK (no_show_by IS NULL OR no_show_by IN ('buyer','athlete')),
  CONSTRAINT bookings_no_show_marked_check  CHECK ((no_show_by IS NULL) = (no_show_marked_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_bookings_athlete_status   ON bookings USING btree (athlete_id, status);
CREATE INDEX IF NOT EXISTS idx_bookings_status_release   ON bookings USING btree (status, release_due_at);
CREATE INDEX IF NOT EXISTS idx_bookings_buyer_email_hash ON bookings USING btree (buyer_email_hash);
CREATE INDEX IF NOT EXISTS idx_bookings_athlete_no_show  ON bookings USING btree (athlete_id) WHERE no_show_by = 'athlete';
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_live_slot  ON bookings USING btree (slot_id)
  WHERE slot_id IS NOT NULL AND status IN ('accepted','confirmed','in_review','issue_reported','disputed');

CREATE TABLE IF NOT EXISTS booking_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL CONSTRAINT booking_events_booking_id_bookings_id_fk REFERENCES bookings(id),
  kind        text NOT NULL,
  actor       text NOT NULL,
  from_status text,
  to_status   text,
  data        jsonb,
  at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_events_kind_check  CHECK (kind IN ('status','attendance','no_show','message','safety','payment','note')),
  CONSTRAINT booking_events_actor_check CHECK (actor IN ('buyer','athlete','system','stripe','livekit','admin'))
);
CREATE INDEX IF NOT EXISTS idx_booking_events_booking ON booking_events USING btree (booking_id, at);

CREATE TABLE IF NOT EXISTS booking_messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        uuid NOT NULL CONSTRAINT booking_messages_booking_id_bookings_id_fk REFERENCES bookings(id),
  sender            text NOT NULL,
  body              text NOT NULL,
  moderation        text NOT NULL DEFAULT 'pending',
  moderation_reason text,
  delivered_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_messages_sender_check     CHECK (sender IN ('buyer','athlete','nomila')),
  CONSTRAINT booking_messages_moderation_check CHECK (moderation IN ('pending','clean','held','blocked'))
);
CREATE INDEX IF NOT EXISTS idx_booking_messages_booking ON booking_messages USING btree (booking_id, created_at);

CREATE TABLE IF NOT EXISTS booking_reports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id          uuid NOT NULL CONSTRAINT booking_reports_booking_id_bookings_id_fk REFERENCES bookings(id),
  athlete_id          uuid NOT NULL CONSTRAINT booking_reports_athlete_id_athletes_id_fk REFERENCES athletes(id),
  reported_by         text NOT NULL,
  category            text NOT NULL,
  details             text,
  status              text NOT NULL DEFAULT 'open',
  resolution          text,
  resolution_note     text,
  assigned_to         text,
  support_notified_at timestamptz,
  opened_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  CONSTRAINT booking_reports_reported_by_check CHECK (reported_by IN ('buyer','athlete','admin','system')),
  CONSTRAINT booking_reports_category_check    CHECK (category IN ('safety','no_show','not_as_described','harassment','fraud','payment','other')),
  CONSTRAINT booking_reports_status_check      CHECK (status IN ('open','in_review','resolved')),
  CONSTRAINT booking_reports_resolution_check  CHECK (resolution IS NULL OR resolution IN ('release','refund','no_action','ban')),
  CONSTRAINT booking_reports_resolved_check    CHECK ((status = 'resolved') = (resolution IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_booking_reports_status  ON booking_reports USING btree (status, opened_at);
CREATE INDEX IF NOT EXISTS idx_booking_reports_booking ON booking_reports USING btree (booking_id);

CREATE TABLE IF NOT EXISTS safety_blocks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope      text NOT NULL,
  athlete_id uuid CONSTRAINT safety_blocks_athlete_id_athletes_id_fk REFERENCES athletes(id),
  kind       text NOT NULL,
  value_hash text NOT NULL,
  reason     text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  lifted_at  timestamptz,
  CONSTRAINT safety_blocks_scope_check         CHECK (scope IN ('athlete','platform')),
  CONSTRAINT safety_blocks_kind_check          CHECK (kind IN ('email','phone','card_fingerprint')),
  CONSTRAINT safety_blocks_created_by_check    CHECK (created_by IN ('athlete','admin')),
  CONSTRAINT safety_blocks_scope_athlete_check CHECK ((scope = 'athlete') = (athlete_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_safety_blocks_lookup ON safety_blocks USING btree (kind, value_hash);

CREATE TABLE IF NOT EXISTS athlete_payout_adjustments (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id                    uuid NOT NULL CONSTRAINT athlete_payout_adjustments_athlete_id_athletes_id_fk REFERENCES athletes(id),
  booking_id                    uuid NOT NULL CONSTRAINT athlete_payout_adjustments_booking_id_bookings_id_fk REFERENCES bookings(id),
  kind                          text NOT NULL DEFAULT 'athlete_cancel_processing_fee',
  amount_cents                  integer NOT NULL,
  currency                      text NOT NULL DEFAULT 'usd',
  status                        text NOT NULL DEFAULT 'owed',
  stripe_balance_transaction_id text,
  recovered_payment_id     uuid CONSTRAINT athlete_payout_adjustments_recovered_payment_id_payments_id_fk REFERENCES payments(id),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  settled_at                    timestamptz,
  CONSTRAINT athlete_adjustments_kind_check   CHECK (kind IN ('athlete_cancel_processing_fee')),
  CONSTRAINT athlete_adjustments_status_check CHECK (status IN ('owed','waived','recovered','written_off')),
  CONSTRAINT athlete_adjustments_amount_check CHECK (amount_cents >= 0)
);
CREATE INDEX IF NOT EXISTS idx_athlete_adjustments_owed ON athlete_payout_adjustments USING btree (athlete_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_athlete_adjustments_booking ON athlete_payout_adjustments USING btree (booking_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS uq_athlete_adjustments_first_waiver ON athlete_payout_adjustments USING btree (athlete_id, kind)
  WHERE status = 'waived';

-- ── payments: one subject per row, deal OR booking ──
ALTER TABLE payments ALTER COLUMN deal_id DROP NOT NULL;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS booking_id uuid;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_booking_id_bookings_id_fk;
ALTER TABLE payments ADD CONSTRAINT payments_booking_id_bookings_id_fk FOREIGN KEY (booking_id) REFERENCES bookings(id);
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_kind_check;
ALTER TABLE payments ADD CONSTRAINT payments_kind_check CHECK (kind IN ('deposit','deal_payment','booking_payment'));
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_subject_check;
ALTER TABLE payments ADD CONSTRAINT payments_subject_check CHECK (
  (kind = 'booking_payment' AND booking_id IS NOT NULL AND deal_id IS NULL)
  OR (kind IN ('deposit','deal_payment') AND deal_id IS NOT NULL AND booking_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_booking ON payments USING btree (booking_id) WHERE booking_id IS NOT NULL;
