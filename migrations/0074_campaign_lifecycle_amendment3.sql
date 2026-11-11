-- 0074_campaign_lifecycle_amendment3.sql — #570 Amendment 3: `idea` removed from the campaign lifecycle (the Recommendation
-- is the governed pre-campaign object) and `active` is a derived reading, not a stored status. completesWhen lives inside
-- campaign_deliverables.intent (jsonb) and needs no column.
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.

ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_status_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_status_check CHECK (status IN ('planning', 'approved', 'ended'));
