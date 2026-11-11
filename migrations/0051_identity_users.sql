-- 0051_identity_users — Phase A Step 3a, the split (design step3-identity-design.md §3, LOCKED at #424; plan step3-identity.md §1).
--
-- Additive and idempotent; NO transaction control (server/migrationsGuard.test.ts). Applied through scripts/db-migrate.sh only.
--   users            the authenticated person (ADR-015); provider_uid = athletes.auth_id as it is stored today
--   identity_claims  the claim lifecycle state (D-14); 3a writes only §3a-C collision claims
--   athlete_users    the membership; relation locked to 'self'; one active self per athlete (D-2)
--   user_roles       a role belongs to a person (D-11); account_roles keeps serving the compatibility read
--   connected_accounts.connected_by_user_id   who performed the OAuth
--   social_identities_owner_uq                D-13: one active canonical owner per (platform, account_id) — created only after
--                                             scripts/checkIdentityCollisions.ts reports zero (dev: 0 on 11 Sep 2026; prod: 0 rows)
--   athlete_index_v  re-created with has_user / claimability reading the projection OR a self-membership (dual until 3d);
--                    column list and order unchanged (assertIndexShape)

CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text NOT NULL,
  provider_uid   text NOT NULL,
  email          text,
  email_verified boolean NOT NULL DEFAULT false,
  display_name   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz,
  disabled_at    timestamptz,
  CONSTRAINT users_provider_check CHECK (provider IN ('firebase','microsoft')),
  CONSTRAINT users_provider_uid_uq UNIQUE (provider, provider_uid)
);
CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS identity_claims (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  athlete_id  uuid NOT NULL REFERENCES athletes(id),
  match_id    uuid REFERENCES athlete_index_matches(id) ON DELETE SET NULL,
  proof       text NOT NULL,
  status      text NOT NULL DEFAULT 'proposed',
  proposed_at timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  decided_by  text,
  note        jsonb,
  CONSTRAINT identity_claims_proof_check   CHECK (proof IN ('existing_auth','verified_unique_email','verified_social_ownership','human_confirmation','none')),
  CONSTRAINT identity_claims_status_check  CHECK (status IN ('proposed','confirmed','rejected','expired','superseded')),
  CONSTRAINT identity_claims_decided_check CHECK (decided_by IS NULL OR decided_by IN ('user','operator','system'))
);
CREATE INDEX IF NOT EXISTS identity_claims_athlete_idx ON identity_claims (athlete_id, status);
CREATE INDEX IF NOT EXISTS identity_claims_user_idx    ON identity_claims (user_id, status);

CREATE TABLE IF NOT EXISTS athlete_users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id     uuid NOT NULL REFERENCES athletes(id),
  user_id        uuid NOT NULL REFERENCES users(id),
  relation       text NOT NULL DEFAULT 'self',
  proof          text NOT NULL,
  claim_id       uuid REFERENCES identity_claims(id) ON DELETE SET NULL,
  note           text,
  established_at timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  revoked_reason text,
  CONSTRAINT athlete_users_relation_check CHECK (relation IN ('self')),
  CONSTRAINT athlete_users_proof_check    CHECK (proof IN ('existing_auth','verified_unique_email','verified_social_ownership','human_confirmation'))
);
CREATE UNIQUE INDEX IF NOT EXISTS athlete_users_active_uq   ON athlete_users (athlete_id, user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS athlete_users_one_self_uq ON athlete_users (athlete_id) WHERE relation = 'self' AND revoked_at IS NULL;
CREATE INDEX        IF NOT EXISTS athlete_users_user_idx    ON athlete_users (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS user_roles (
  user_id    uuid NOT NULL REFERENCES users(id),
  role       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role),
  CONSTRAINT user_roles_role_check CHECK (role IN ('athlete','fan','brand','school_admin','admin'))
);

ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS connected_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS social_identities_owner_uq ON social_identities (platform, account_id)
  WHERE source_class = 'connected_verified' AND status = 'active';

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
  (a.auth_id IS NOT NULL OR EXISTS (SELECT 1 FROM athlete_users au WHERE au.athlete_id = a.id AND au.relation = 'self' AND au.revoked_at IS NULL)) AS has_user,
  CASE WHEN ga.athlete_id IS NOT NULL OR a.auth_id IS NOT NULL OR EXISTS (SELECT 1 FROM athlete_users au WHERE au.athlete_id = a.id AND au.relation = 'self' AND au.revoked_at IS NULL) THEN 'none'
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
