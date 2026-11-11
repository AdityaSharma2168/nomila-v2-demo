-- 0048_athlete_index — Phase A Step 2c: the Athlete Index (design
-- docs/architecture/phase-a/step2c-athlete-index-design.md §2, §3, §9.1; frozen 11 Sep 2026).
--
-- Additive: ONE view (the first in the system), three lookup indexes, one telemetry table.
-- No column on athletes changes. The view carries NO auth or private column: email, auth_id,
-- stripe, plan, goals and every connected_verified observation stay outside it (ADR-015/016).
-- athletes_auth_id_uq is NOT here: it lands in a separate PR after the collision pre-flight.
--
-- CREATE OR REPLACE VIEW is idempotent while the column list is unchanged; a later column change
-- must DROP VIEW first (Postgres refuses to rename/remove view columns in place).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── the canonical Athlete Index record ───────────────────────────────────────
CREATE OR REPLACE VIEW athlete_index_v AS
SELECT
  a.id                                                              AS athlete_id,
  a.full_name                                                       AS full_name,
  trim(regexp_replace(lower(a.full_name), '[^a-z0-9]+', ' ', 'g'))  AS name_norm,
  coalesce(al.aliases, ARRAY[]::text[])                             AS aliases,
  coalesce(sp.sport, a.sport)                                       AS sport,
  aff.org_name                                                      AS team_or_school,
  aff.org_kind                                                      AS org_kind,
  aff.level                                                         AS level,
  aff.conference                                                    AS conference,
  aff.kind                                                          AS affiliation_kind,
  cy.season                                                         AS class_year,
  gy.year                                                           AS graduation_year,
  ht.city_or_country                                                AS city_or_country,
  coalesce(ent.handles, '{}'::jsonb) || coalesce(ids.handles, '{}'::jsonb) AS known_social_handles,
  coalesce(rs.identity_confidence, 0)                               AS identity_confidence,
  coalesce(rs.research_status, 'seed_only')                         AS research_status,
  coalesce(rs.disputed_domains, '[]'::jsonb)                        AS disputed_domains,
  rs.last_researched_at                                             AS last_researched_at,
  rs.next_due_at                                                    AS next_due_at,
  coalesce(cs.connection_status, 'none')                            AS connection_status,
  (a.auth_id IS NOT NULL)                                           AS has_user,
  CASE WHEN ga.athlete_id IS NOT NULL OR a.auth_id IS NOT NULL THEN 'none'
       WHEN a.email IS NOT NULL OR a.status = 'waitlisted'         THEN 'open'
       ELSE 'review' END                                            AS claimability,
  (ga.athlete_id IS NOT NULL)                                       AS is_golden_anchor,
  a.status                                                          AS athlete_status,
  greatest(a.created_at, rs.updated_at, aff.updated_at, ids.last_verified_at) AS index_updated_at
FROM athletes a
LEFT JOIN athlete_research_state rs ON rs.athlete_id = a.id
LEFT JOIN golden_athletes ga ON ga.athlete_id = a.id AND coalesce(ga.active, true)
LEFT JOIN LATERAL (
  SELECT x.org_name, x.org_kind, x.level, x.conference, x.kind, x.updated_at
  FROM athlete_affiliations x
  WHERE x.athlete_id = a.id AND x.ended_on IS NULL
  ORDER BY x.is_primary DESC, x.created_at DESC
  LIMIT 1
) aff ON true
LEFT JOIN LATERAL (
  SELECT array_agg(f.value_text ORDER BY f.value_text) AS aliases
  FROM athlete_facts f WHERE f.athlete_id = a.id AND f.fact_key = 'alias' AND f.status = 'current'
) al ON true
LEFT JOIN LATERAL (
  SELECT f.value->>'sport' AS sport
  FROM athlete_facts f WHERE f.athlete_id = a.id AND f.fact_key = 'sport' AND f.status = 'current'
  ORDER BY CASE f.origin WHEN 'athlete_proof' THEN 0 WHEN 'athlete_asserted' THEN 1 WHEN 'connection' THEN 2 WHEN 'research' THEN 3 ELSE 4 END, f.retrieved_at DESC
  LIMIT 1
) sp ON true
LEFT JOIN LATERAL (
  SELECT (f.value->>'season')::int AS season
  FROM athlete_facts f WHERE f.athlete_id = a.id AND f.fact_key = 'class_year' AND f.status = 'current'
  ORDER BY f.retrieved_at DESC LIMIT 1
) cy ON true
LEFT JOIN LATERAL (
  SELECT (f.value->>'year')::int AS year
  FROM athlete_facts f WHERE f.athlete_id = a.id AND f.fact_key = 'graduation_year' AND f.status = 'current'
  ORDER BY f.retrieved_at DESC LIMIT 1
) gy ON true
LEFT JOIN LATERAL (
  SELECT nullif(concat_ws(', ', f.value->>'city', f.value->>'country'), '') AS city_or_country
  FROM athlete_facts f WHERE f.athlete_id = a.id AND f.fact_key = 'hometown' AND f.status = 'current'
  ORDER BY f.retrieved_at DESC LIMIT 1
) ht ON true
LEFT JOIN LATERAL (
  SELECT jsonb_object_agg(h.platform, jsonb_build_object('handle', h.handle, 'sourceClass', h.source_class, 'confidence', h.confidence)) AS handles,
         max(h.last_verified_at) AS last_verified_at
  FROM (
    SELECT DISTINCT ON (s.platform) s.platform, s.handle, s.source_class, s.confidence, s.last_verified_at
    FROM social_identities s
    WHERE s.athlete_id = a.id AND s.status = 'active' AND s.handle IS NOT NULL
    ORDER BY s.platform, CASE s.source_class WHEN 'connected_verified' THEN 0 WHEN 'platform_public' THEN 1 WHEN 'web_researched' THEN 2 WHEN 'inferred' THEN 3 ELSE 4 END
  ) h
) ids ON true
LEFT JOIN LATERAL (
  SELECT jsonb_object_agg(CASE e.key WHEN 'twitter' THEN 'x' ELSE e.key END, jsonb_build_object('handle', ltrim(e.value, '@'), 'sourceClass', 'entered', 'confidence', NULL)) AS handles
  FROM jsonb_each_text(a.socials) e
  WHERE e.value <> '' AND e.key IN ('instagram', 'tiktok', 'youtube', 'twitter', 'x')
) ent ON true
LEFT JOIN LATERAL (
  SELECT CASE WHEN bool_or(c.status = 'active') THEN 'active' WHEN bool_or(c.status = 'expired') THEN 'expired' WHEN bool_or(c.status = 'revoked') THEN 'revoked' ELSE 'none' END AS connection_status
  FROM connected_accounts c WHERE c.athlete_id = a.id
) cs ON true;

-- ── lookup indexes (design §3) ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS athlete_facts_name_trgm_idx   ON athlete_facts USING gin (value_text gin_trgm_ops) WHERE fact_key = 'name';
CREATE INDEX IF NOT EXISTS social_identities_handle_idx  ON social_identities (platform, lower(handle)) WHERE status = 'active' AND handle IS NOT NULL;
CREATE INDEX IF NOT EXISTS athletes_email_lower_idx      ON athletes (lower(email)) WHERE email IS NOT NULL;

-- ── athlete_index_matches: every index decision, telemetry not state (design §5.2) ──
-- `query` never carries the email; `chosen_athlete_id` / `created_athlete_id` never the uid.
CREATE TABLE IF NOT EXISTS athlete_index_matches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at                  timestamptz NOT NULL DEFAULT now(),
  path                text NOT NULL,                                  -- signup | microsoft | waitlist | admin | api | connect
  query               jsonb NOT NULL,                                 -- { name, sport, teamOrSchool, classYear, handles } — never email
  candidates          jsonb NOT NULL DEFAULT '[]'::jsonb,             -- [{ athleteId, matchScore, signals, tier, claimability }]
  tier                text NOT NULL,
  claim_proof         text NOT NULL,
  decision            text NOT NULL,
  chosen_athlete_id   uuid REFERENCES athletes(id) ON DELETE SET NULL,
  created_athlete_id  uuid REFERENCES athletes(id) ON DELETE SET NULL,
  policy_version      text NOT NULL,
  CONSTRAINT athlete_index_matches_tier_check     CHECK (tier IN ('auto_match','candidate','new')),
  CONSTRAINT athlete_index_matches_proof_check    CHECK (claim_proof IN ('existing_auth','verified_unique_email','verified_social_ownership','human_confirmation','none')),
  CONSTRAINT athlete_index_matches_decision_check CHECK (decision IN ('linked_by_auth','linked_by_verified_email','possible_duplicate','new'))
);
CREATE INDEX IF NOT EXISTS athlete_index_matches_at_idx ON athlete_index_matches (at DESC);
