-- 0036_workflow_active_scope.sql — "one active run per athlete" is scoped by the definition.
--
-- Found on the first hand-run: an athlete's Instagram first look was blocked while their TikTok
-- first look ran, because the active-run rule was per (athlete, process). The design says one
-- run per connection. A definition may now derive a finer scope from the input
-- (first_look → 'first_look:<platform>'); everything else keeps the process name.

ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "active_scope" text;
UPDATE "workflow_runs" SET "active_scope" = "process" WHERE "active_scope" IS NULL;

-- Deploy-window safety: code that predates this column inserts without it. Default the scope
-- to the process name in the database, so the migration can land before or after the deploy.
CREATE OR REPLACE FUNCTION workflow_runs_default_scope() RETURNS trigger AS $$
BEGIN
  IF NEW.active_scope IS NULL THEN NEW.active_scope := NEW.process; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS workflow_runs_default_scope ON "workflow_runs";
CREATE TRIGGER workflow_runs_default_scope BEFORE INSERT ON "workflow_runs"
  FOR EACH ROW EXECUTE FUNCTION workflow_runs_default_scope();

ALTER TABLE "workflow_runs" ALTER COLUMN "active_scope" SET NOT NULL;

DROP INDEX IF EXISTS "workflow_runs_one_active";
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_runs_one_active"
  ON "workflow_runs" ("athlete_id", "active_scope") WHERE status IN ('running','waiting');
