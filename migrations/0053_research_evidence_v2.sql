-- 0053_research_evidence_v2 — Phase A Step 4 (design docs/architecture/phase-a/step4-research-architecture-simplification.md
-- §3, approved): the seven research-spec/1 evidence kinds + `research_finding` (sourced findings with no registry key), and
-- the three native provider lineage levels. Existing rows and existing values are unaffected; no data change.
--
-- Additive and idempotent; NO transaction control (server/migrationsGuard.test.ts). Old values are kept first, new values
-- appended, so the original set is visibly a prefix of the new one (backward compatible: nothing removed, nothing reordered).
--
-- CHECK OWNERSHIP RULE (0063): 0082_research_identity_sources widened both CHECKs and OWNS them now. This file therefore adds
-- each only if absent, NOT VALID, so re-running it on every deploy never re-narrows them over rows written under 0082's set.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'research_evidence_kind_check') THEN
    ALTER TABLE research_evidence ADD CONSTRAINT research_evidence_kind_check
      CHECK (kind IN ('achievement','press_mention','brand_mention','affiliation','profile_attribute','social_handle','nil_mention','sentiment','media_asset','identity_signal','signal','career_event','reputation_event','social_metric_claim','representation','venture','crossover_appearance','narrative_claim','research_finding')) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'research_evidence_lineage_check') THEN
    ALTER TABLE research_evidence ADD CONSTRAINT research_evidence_lineage_check
      CHECK (lineage_status IN ('cited','uncited','conflicting','native_supported','native_retrieved','asserted_only')) NOT VALID;
  END IF;
END $$;
