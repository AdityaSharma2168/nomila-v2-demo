-- 0055_mia_evaluator_service — Phase A Step 4: persistence for the M.I.A. evaluator service
-- (design docs/architecture/phase-a/step4-evaluator-service-design.md, approved).
--
-- Three append-only records, deliberately separate so a movement in an athlete's score can be attributed:
--
--   mia_evidence_snapshots   what we SENT      — identity + the authoritative social block, digested
--   mia_evaluation_runs      what came BACK    — the raw provider envelope and the parsed judgements
--   intelligence_ledger      the ASSESSMENT    — the scored result, superseded rather than updated
--
-- Collapsing these into one row would lose exactly that: when a score moves we must be able to say whether the INPUTS
-- moved, the EVALUATOR moved, or the SCORING moved. That separation is what made the Beta.1 freeze gate meaningful and
-- it is the same discipline here.
--
-- NO tenancy column, deliberately. ADR-015: a user may act on many athletes and an athlete may be acted on by many
-- users. ADR-016: organisation affiliation does not imply access to private athlete data — a school may see public
-- marketability intelligence without seeing the inbox. So access is an AUTHORISATION relationship resolved at the
-- service boundary, not ownership of the intelligence row. athlete_id is the durable identity here.
--
-- Additive and idempotent; NO transaction control (server/migrationsGuard.test.ts). Creates nothing that any existing
-- reader touches: shadow-only until a reader is deliberately switched.

-- ── what we sent ────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mia_evidence_snapshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id         uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  -- Identity exactly as resolved at snapshot time. These two are the ONLY athlete-specific values in the prompt
  -- besides the social block; the rubric itself is frozen and digest-pinned in code.
  name               text NOT NULL,
  sport              text NOT NULL,
  -- The AUTHORITATIVE SOCIAL DATA block verbatim, or NULL when no platform data resolved. Never a summary: the
  -- evaluator is told to treat this text as measured fact, so what it received is what we must be able to reproduce.
  social_block       text,
  -- One row per account behind the block: platform, account id, observation date, source class.
  social_sources     jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The max observation date of the Nomila-supplied evidence. NOT the trigger time, job start or completion time.
  -- This is the supersession ordering key: jobs finish out of order, and an evaluation carrying older evidence must
  -- never overwrite one carrying newer.
  evidence_as_of     timestamptz NOT NULL,
  -- sha256 of the canonical snapshot. Idempotency is keyed on this: an unchanged snapshot must not pay for a re-run,
  -- because the evaluator's research is non-deterministic and a repeat samples drift rather than learning anything.
  digest             text NOT NULL,
  -- Why the evaluation was requested. RECORDED HERE, NEVER SENT: an orchestration fact is not evidence. If a trigger
  -- reached the evaluator, an athlete who just connected would score differently from an identical athlete who did
  -- not — ADR-002's bonus arriving by a side channel.
  trigger_reason     text NOT NULL,
  built_at           timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mia_evidence_snapshots_athlete_idx ON mia_evidence_snapshots (athlete_id, evidence_as_of DESC);
CREATE INDEX IF NOT EXISTS mia_evidence_snapshots_digest_idx  ON mia_evidence_snapshots (athlete_id, digest);

-- ── what came back ──────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mia_evaluation_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id        uuid NOT NULL REFERENCES mia_evidence_snapshots(id) ON DELETE CASCADE,
  athlete_id         uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  -- 'ok' | 'failed_provider' | 'failed_validation' | 'failed_scoring'. A partial or unparseable response produces a
  -- run row and NO ledger entry: a partial assessment is worse than none, and a failure must never supersede.
  status             text NOT NULL,
  evaluator_version  text NOT NULL,
  provider           text NOT NULL,
  model              text NOT NULL,
  -- The provider envelope, sanitized. Retries reuse the snapshot but produce distinct runs — the evaluator is
  -- non-deterministic, so a retry is a NEW SAMPLE, not a repeat.
  raw                jsonb,
  -- The 44 normalized judgements: status, 0-100, H/M/L, evidence ids, rationale.
  judgements         jsonb,
  -- sha256 of the judgement set, so a stored result is traceable to the exact judgements that produced it.
  judgements_digest  text,
  attempt            integer NOT NULL DEFAULT 1,
  cost_usd           numeric(10,4),
  latency_ms         integer,
  usage              jsonb,
  error              text,
  started_at         timestamptz NOT NULL,
  finished_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mia_evaluation_runs_athlete_idx  ON mia_evaluation_runs (athlete_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mia_evaluation_runs_snapshot_idx ON mia_evaluation_runs (snapshot_id);

-- ── the judgement of record ─────────────────────────────────────────────────────────────────────────────────────
-- Shared by every intelligence engine, distinguished by `kind`. Marketability writes ASSESSMENT; Rates will write
-- ESTIMATE, Earnings FORECAST, Deal Intelligence RECOMMENDATION (server/services/intelligence/contracts/
-- intelligenceLedger.ts). The engines stay independent; what they share is provenance, versioning and outcome
-- recording — never intelligence.
CREATE TABLE IF NOT EXISTS intelligence_ledger (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type       text NOT NULL,
  subject_id         uuid NOT NULL,
  owner              text NOT NULL,
  -- ASSESSMENT has no commensurable future observation — nothing ever arrives saying an athlete's "true"
  -- marketability was some number. ESTIMATE, FORECAST and RECOMMENDATION do. That distinction is enforced in the
  -- contract types so an assessment cannot be paired with an outcome to produce an error (ADR-011).
  kind               text NOT NULL CHECK (kind IN ('ASSESSMENT','ESTIMATE','FORECAST','RECOMMENDATION')),
  value              jsonb NOT NULL,
  -- NULLABLE ON PURPOSE. A categorical band is only meaningful where a VERSIONED policy defines how an engine's
  -- aggregate confidence becomes HIGH/MEDIUM/LOW. Beta.1 has no such policy: the frozen evaluator emits H/M/L per
  -- sub-signal and the scorer aggregates those numerically, but nothing ever defined the mapping between the two.
  -- Forcing a band here would make whatever thresholds the first writer happened to pick into methodology by
  -- accident. The numeric confidence lives in `value` and is the frozen, versioned quantity; this column stays NULL
  -- until a band policy is deliberately versioned. (NULL passes the CHECK: `NULL IN (...)` is unknown, not false.)
  confidence         text CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  -- Every parameter set in force, so the judgement can be re-derived or re-explained later.
  versions           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- A snapshot of the material inputs — enough to re-derive, not the whole athlete.
  inputs             jsonb NOT NULL DEFAULT '[]'::jsonb,
  assumptions        jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Same key, same reason as the snapshot: supersession compares EVIDENCE as-of, never completion time.
  evidence_as_of     timestamptz NOT NULL,
  -- FORECAST only: when its observation becomes available.
  horizon_at         timestamptz,
  -- Provenance back to what produced it. Null for engines with no evaluator run.
  evaluation_run_id  uuid REFERENCES mia_evaluation_runs(id) ON DELETE SET NULL,
  -- Corrections supersede; rows are never updated in place. The point of the row is what we believed THEN.
  superseded_by      uuid REFERENCES intelligence_ledger(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intelligence_ledger_current_idx ON intelligence_ledger (subject_type, subject_id, kind, evidence_as_of DESC) WHERE superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS intelligence_ledger_owner_idx   ON intelligence_ledger (owner, created_at DESC);
CREATE INDEX IF NOT EXISTS intelligence_ledger_run_idx     ON intelligence_ledger (evaluation_run_id);
