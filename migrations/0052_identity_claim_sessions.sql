-- 0052_identity_claim_sessions — Phase A Step 3b (plan step3-identity.md §3b §12, P-5 approved).
--
-- Additive and idempotent; NO transaction control (server/migrationsGuard.test.ts). No data change: existing identity_claims
-- rows (the §3a-C collision claims) keep claim_session_id NULL.
--   identity_claims.claim_session_id   one UUID per candidate-selection interaction (workflow state; never a match id)
--   identity_claims_user_session_idx   lookup by user / session / status (confirm, dismiss, resume)
--   identity_claims_session_proposed_uq   the candidate-flow invariant: at most one active proposed claim per (user, athlete, session)
--   athlete_index_matches_decision_check  + linked_by_ownership, linked_by_operator (the 0047 DROP-then-ADD pattern)

ALTER TABLE identity_claims ADD COLUMN IF NOT EXISTS claim_session_id uuid NULL;

CREATE INDEX IF NOT EXISTS identity_claims_user_session_idx ON identity_claims (user_id, claim_session_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS identity_claims_session_proposed_uq ON identity_claims (user_id, athlete_id, claim_session_id)
  WHERE status = 'proposed' AND claim_session_id IS NOT NULL;

ALTER TABLE athlete_index_matches DROP CONSTRAINT IF EXISTS athlete_index_matches_decision_check;
ALTER TABLE athlete_index_matches ADD CONSTRAINT athlete_index_matches_decision_check
  CHECK (decision IN ('linked_by_auth','linked_by_verified_email','linked_by_ownership','linked_by_operator','possible_duplicate','new'));
