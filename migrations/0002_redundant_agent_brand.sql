ALTER TABLE "athletes" drop column "segment";--> statement-breakpoint
ALTER TABLE "athletes" ADD COLUMN "segment" text GENERATED ALWAYS AS (CASE
      WHEN "division" IN ('D1','FBS','FCS','D2','D3','NAIA','JUCO','NJCAA') THEN 'college'
      WHEN "division" IN ('HS','High School') THEN 'high_school'
      WHEN "division" IN ('Youth','Club','AAU') THEN 'youth'
      WHEN "division" = 'Pro' THEN 'pro'
      WHEN "division" = 'Olympic'
        OR "school" ILIKE '%olympic%'
        OR "school" ILIKE '%team usa%'
        OR "school" ILIKE '%national team%' THEN 'olympic'
      ELSE 'unknown'
    END) STORED;