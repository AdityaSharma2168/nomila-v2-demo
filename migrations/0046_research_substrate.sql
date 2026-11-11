-- 0046_research_substrate — Phase A Step 2a: the research substrate (design
-- docs/architecture/phase-a/step2-research-canonical-profile-design.md §4).
--
-- Six tables, all keyed on athlete_id (ADR-015: the athlete is the domain owner; no user,
-- organization or tenant column, ADR-016). Evidence → facts → inferences, with the research
-- lifecycle state per athlete. Pure DDL, IF NOT EXISTS throughout; nothing dropped or altered.
-- pg_trgm supports the Athlete Index name/alias search (Step 2c). Nothing reads these tables in
-- production until Step 2d; writes are gated by RESEARCH_SUBSTRATE_WRITE (default off).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── research_runs ──────────────────────────────────────────────────────────────
-- One row per research job or per-domain refresh, with cost telemetry (spec §4).
CREATE TABLE IF NOT EXISTS research_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id          uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  domain              text NOT NULL,                              -- identity | profile | affiliations | achievements | press | brand_mentions | narrative | social_handles | signals | full
  trigger             text NOT NULL,
  providers           jsonb NOT NULL DEFAULT '[]'::jsonb,          -- [{ role, provider, model }]
  identity_hints      jsonb,                                       -- the hints used (ledger-derived); hashed copy in hints_hash
  hints_hash          text,
  status              text NOT NULL DEFAULT 'running',
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  calls               integer NOT NULL DEFAULT 0,
  tokens_in           integer,
  tokens_out          integer,
  tokens_cached       integer,
  latency_ms          integer,
  estimated_cost_usd  numeric(10,4),
  confidence_out      numeric(3,2),
  summary             jsonb,                                       -- { payloads, evidence, facts, inferences, cited, uncited, conflicting, suspect, refused }
  error               jsonb,                                       -- normalized: { reason, message, subCalls[] } (Step 1a shape)
  CONSTRAINT research_runs_trigger_check CHECK (trigger IN ('signup','identity_confirmed','ttl','event','manual','backfill','dual_write')),
  CONSTRAINT research_runs_status_check  CHECK (status IN ('running','ok','partial','failed'))
);
CREATE INDEX IF NOT EXISTS research_runs_athlete_idx ON research_runs (athlete_id, started_at DESC);

-- ── research_source_payloads ──────────────────────────────────────────────────
-- The sanitized provider envelope per call (search response with its grounding chunks and
-- supports, extraction response, signal bodies). Same contract as raw_source_payloads:
-- sanitize → assertNoSecrets → hash; retained 90 d (web_researched class).
CREATE TABLE IF NOT EXISTS research_source_payloads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  athlete_id          uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  provider            text NOT NULL,                               -- gemini_grounded | kimi_extract | google_trends | gdelt | ...
  model               text,
  endpoint_family     text NOT NULL,                               -- search:<queryName> | extraction | signal:<provider> | legacy_blob
  request             jsonb,                                       -- allow-listed request record
  payload             jsonb NOT NULL,                              -- sanitized; chunks + supports preserved verbatim
  payload_hash        text NOT NULL,
  bytes               integer,
  sanitizer_version   text NOT NULL,
  fetched_at          timestamptz NOT NULL,
  retained_until      timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS research_payloads_run_idx       ON research_source_payloads (run_id);
CREATE INDEX IF NOT EXISTS research_payloads_retention_idx ON research_source_payloads (retained_until) WHERE retained_until IS NOT NULL;

-- ── research_evidence ─────────────────────────────────────────────────────────
-- One normalized claim, tied to the exact provider segment that supports it (§3.2). Append-only.
-- source_url / source_domain / source_type are copied from the cited chunk, never reconstructed.
CREATE TABLE IF NOT EXISTS research_evidence (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id          uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  run_id              uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  payload_id          uuid REFERENCES research_source_payloads(id) ON DELETE SET NULL,
  kind                text NOT NULL,
  claim               jsonb NOT NULL,                              -- registry-shaped for fact-bearing kinds: { factKey, value, ... }
  support             jsonb,                                       -- { chunkIds[], supportIds[], quote }
  lineage_status      text NOT NULL,
  source_url          text,
  source_domain       text,
  source_type         text NOT NULL DEFAULT 'unknown',
  published_at        timestamptz,
  retrieved_at        timestamptz NOT NULL,
  extractor           text,                                        -- model@version
  extraction_schema_version text,
  confidence          numeric(3,2) NOT NULL DEFAULT 0.50,
  source_class        text NOT NULL DEFAULT 'web_researched',
  about_identity_confidence numeric(3,2),
  suspect             boolean NOT NULL DEFAULT false,
  dedupe_key          text NOT NULL,
  superseded_by       uuid REFERENCES research_evidence(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT research_evidence_kind_check    CHECK (kind IN ('achievement','press_mention','brand_mention','affiliation','profile_attribute','social_handle','nil_mention','sentiment','media_asset','identity_signal','signal')),
  CONSTRAINT research_evidence_lineage_check CHECK (lineage_status IN ('cited','uncited','conflicting')),
  CONSTRAINT research_evidence_source_type_check CHECK (source_type IN ('official_governing_body','official_team_or_school','major_news','reference','regional_news','athlete_authored_public','aggregator_or_blog','unknown')),
  CONSTRAINT research_evidence_source_class_check CHECK (source_class IN ('connected_verified','platform_public','web_researched','inferred','imputed'))
);
CREATE INDEX IF NOT EXISTS research_evidence_athlete_kind_idx ON research_evidence (athlete_id, kind, retrieved_at DESC);
CREATE INDEX IF NOT EXISTS research_evidence_dedupe_idx       ON research_evidence (athlete_id, dedupe_key);

-- ── athlete_facts ─────────────────────────────────────────────────────────────
-- Resolved attribute-level facts (design §4.1, §4.5). Two independent provenance fields:
-- origin (who put it forward) and source_class (authority of the evidence).
--
-- SourceClass vocabulary note (review): the canonical SourceClass vocabulary is unchanged and
-- global — connected_verified | platform_public | web_researched | inferred | imputed — and
-- research_evidence, social_identities, social_metric_observations and social_features all
-- admit all five. athlete_facts INTENTIONALLY admits only connected_verified | platform_public |
-- web_researched | NULL: an inference never becomes a fact and an imputed value is a
-- signal-engine concern, so `inferred` and `imputed` are invalid for facts BY DESIGN (R1). NULL
-- is reserved for the athlete's own assertion/proof (origin athlete_asserted | athlete_proof),
-- which is authority above the evidence ladder, not evidence of a class.
CREATE TABLE IF NOT EXISTS athlete_facts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id          uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  fact_key            text NOT NULL,
  value               jsonb NOT NULL,
  value_text          text NOT NULL,
  status              text NOT NULL,
  valid_from          date,
  valid_to            date,
  observed_at         timestamptz,
  retrieved_at        timestamptz NOT NULL,
  origin              text NOT NULL,
  source_class        text,
  authority_tier      smallint,
  confidence          numeric(3,2) NOT NULL,
  provenance          jsonb NOT NULL,                              -- { evidenceIds[], assertedId, connectionId, proofId, domains[], corroboration }
  freshness_family    text NOT NULL,
  resolver_version    text NOT NULL,
  registry_version    text NOT NULL,
  superseded_by       uuid REFERENCES athlete_facts(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT athlete_facts_status_check CHECK (status IN ('current','historical','superseded','retracted','disputed')),
  CONSTRAINT athlete_facts_origin_check CHECK (origin IN ('athlete_asserted','athlete_proof','connection','research','backfill')),
  CONSTRAINT athlete_facts_source_class_check CHECK (source_class IS NULL OR source_class IN ('connected_verified','platform_public','web_researched')),
  CONSTRAINT athlete_facts_assertion_class_check CHECK ((origin IN ('athlete_asserted','athlete_proof')) = (source_class IS NULL))
);
CREATE INDEX IF NOT EXISTS athlete_facts_athlete_key_idx ON athlete_facts (athlete_id, fact_key, status);
CREATE INDEX IF NOT EXISTS athlete_facts_alias_trgm_idx  ON athlete_facts USING gin (value_text gin_trgm_ops) WHERE fact_key = 'alias';
CREATE INDEX IF NOT EXISTS athletes_full_name_trgm_idx   ON athletes USING gin (full_name gin_trgm_ops);

-- ── athlete_inferences ────────────────────────────────────────────────────────
-- Derived interpretations (story arc, bounded classifications) with lineage. Never facts.
CREATE TABLE IF NOT EXISTS athlete_inferences (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id          uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  inference_key       text NOT NULL,
  value               jsonb NOT NULL,
  taxonomy_version    text,
  producer            text NOT NULL,                               -- model@version | rule@version
  lineage             jsonb NOT NULL,                              -- { factIds[], evidenceIds[], runId }
  confidence          numeric(3,2),
  computed_at         timestamptz NOT NULL DEFAULT now(),
  superseded_by       uuid REFERENCES athlete_inferences(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS athlete_inferences_athlete_key_idx ON athlete_inferences (athlete_id, inference_key, computed_at DESC);

-- ── athlete_research_state ────────────────────────────────────────────────────
-- One row per athlete: research lifecycle + per-domain freshness. Connection status is
-- derived at read time and deliberately NOT stored here (R2).
CREATE TABLE IF NOT EXISTS athlete_research_state (
  athlete_id          uuid PRIMARY KEY REFERENCES athletes(id) ON DELETE CASCADE,
  research_status     text NOT NULL DEFAULT 'seed_only',
  identity_confidence numeric(3,2) NOT NULL DEFAULT 0.00,
  identity_resolved_at timestamptz,
  domains             jsonb NOT NULL DEFAULT '{}'::jsonb,          -- domain → { status, lastRunId, lastResearchedAt, staleAfter }
  disputed_domains    jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_researched_at  timestamptz,
  next_due_at         timestamptz,
  total_cost_usd      numeric(10,4) NOT NULL DEFAULT 0,
  search_hints        jsonb,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT athlete_research_state_status_check CHECK (research_status IN ('seed_only','identity_resolved','research_partial','research_complete','research_stale'))
);
CREATE INDEX IF NOT EXISTS athlete_research_state_due_idx ON athlete_research_state (next_due_at) WHERE next_due_at IS NOT NULL;
