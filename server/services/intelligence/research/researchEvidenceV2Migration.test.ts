/**
 * researchEvidenceV2Migration.test.ts — Phase A Step 4, migrations/0053_research_evidence_v2.sql:
 * the `research_evidence_kind_check` / `research_evidence_lineage_check` CHECK constraints gain the
 * seven research-spec/1 evidence kinds + `research_finding`, and the three native provider lineage
 * levels, additively (design docs/architecture/phase-a/step4-research-architecture-simplification.md §3).
 *
 *   (a) static mirror: the migration file and shared/schema.ts list the exact same values, in the
 *       same order, for both CHECKs — and the pre-0053 value sets are an untouched prefix of the new
 *       ones (nothing removed, nothing reordered: backward compatible).
 *   (b) PGlite behaviour: the new kind/lineage combinations are accepted, the legacy combination
 *       (press_mention/cited) still is, and a bogus value is still rejected.
 *
 * NOTE on how the PGlite test DB is built: server/testUtils/pgliteDb.ts's initTestDb() does NOT apply
 * the hand-written migrations/*.sql files. It pushes shared/schema.ts straight into PGlite via
 * drizzle-kit's generateMigration (empty → schema), so the CHECK constraint PGlite ends up with is
 * whatever shared/schema.ts's `check(...)` calls say — never migrations/0053_research_evidence_v2.sql
 * itself. Part (b)'s schema-based tests therefore exercise the schema.ts mirror, not the migration
 * file. To also prove the migration FILE (not just its schema.ts mirror) is correct and idempotent,
 * the second describe block below reads migrations/0053_research_evidence_v2.sql, splits it on ';'
 * into individual statements, and executes each with `db.execute(sql.raw(...))` against the same
 * PGlite database — twice in a row (idempotency), then repeats the acceptance/rejection assertions.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../../testUtils/pgliteDb";
import { researchEvidence, researchRuns } from "../../../../shared/schema";

const MIGRATION_PATH = join(__dirname, "../../../../migrations/0053_research_evidence_v2.sql");
const SCHEMA_PATH = join(__dirname, "../../../../shared/schema.ts");

/** Pulls the single-quoted values out of a `... IN ('a','b',...)` list, in order. */
function parseValues(inList: string): string[] {
  return [...inList.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

function extractFromMigration(sqlText: string, constraintName: string): string[] {
  const re = new RegExp(`CONSTRAINT ${constraintName}[\\s\\S]*?CHECK \\([a-z_]+ IN \\(([^)]*)\\)\\)`);
  const m = sqlText.match(re);
  if (!m) throw new Error(`${constraintName}: no CHECK found in migration file`);
  return parseValues(m[1]);
}

function extractFromSchema(schemaText: string, constraintName: string): string[] {
  const re = new RegExp(`check\\("${constraintName}",\\s*sql\`\\$\\{[^}]+\\}\\s*IN\\s*\\(([^)]*)\\)\`\\)`);
  const m = schemaText.match(re);
  if (!m) throw new Error(`${constraintName}: no CHECK found in shared/schema.ts`);
  return parseValues(m[1]);
}

describe("0053_research_evidence_v2: migration file mirrors shared/schema.ts", () => {
  const migrationSql = readFileSync(MIGRATION_PATH, "utf8");
  const schemaTs = readFileSync(SCHEMA_PATH, "utf8");

  const OLD_KINDS = ["achievement", "press_mention", "brand_mention", "affiliation", "profile_attribute", "social_handle", "nil_mention", "sentiment", "media_asset", "identity_signal", "signal"];
  const OLD_LINEAGE = ["cited", "uncited", "conflicting"];
  const NEW_KINDS = [...OLD_KINDS, "career_event", "reputation_event", "social_metric_claim", "representation", "venture", "crossover_appearance", "narrative_claim", "research_finding"];
  const NEW_LINEAGE = [...OLD_LINEAGE, "native_supported", "native_retrieved", "asserted_only"];

  // 0082_research_identity_sources widened both CHECKs (+ athlete_statement, + source_read) and owns them now (CHECK OWNERSHIP
  // RULE): 0053 keeps its own set in the guarded form, and schema.ts mirrors 0082 — 0053's set is an untouched prefix of it.
  // 0082's own mirror test: researchIdentitySourcesMigration.test.ts.
  it("kind: 0053 lists its own set; schema.ts (= 0082) extends it, in the identical order", () => {
    const fromMigration = extractFromMigration(migrationSql, "research_evidence_kind_check");
    const fromSchema = extractFromSchema(schemaTs, "research_evidence_kind_check");
    expect(fromMigration).toEqual(NEW_KINDS);
    expect(fromSchema).toEqual([...NEW_KINDS, "athlete_statement"]);
    expect(fromSchema.slice(0, fromMigration.length)).toEqual(fromMigration);
  });

  it("lineage_status: 0053 lists its own set; schema.ts (= 0082) extends it, in the identical order", () => {
    const fromMigration = extractFromMigration(migrationSql, "research_evidence_lineage_check");
    const fromSchema = extractFromSchema(schemaTs, "research_evidence_lineage_check");
    expect(fromMigration).toEqual(NEW_LINEAGE);
    expect(fromSchema).toEqual([...NEW_LINEAGE, "source_read"]);
    expect(fromSchema.slice(0, fromMigration.length)).toEqual(fromMigration);
  });

  it("backward compatible: the pre-0053 kind values are an untouched, unreordered prefix of the new list", () => {
    const fromMigration = extractFromMigration(migrationSql, "research_evidence_kind_check");
    expect(fromMigration.slice(0, OLD_KINDS.length)).toEqual(OLD_KINDS);
  });

  it("backward compatible: the pre-0053 lineage values are an untouched, unreordered prefix of the new list", () => {
    const fromMigration = extractFromMigration(migrationSql, "research_evidence_lineage_check");
    expect(fromMigration.slice(0, OLD_LINEAGE.length)).toEqual(OLD_LINEAGE);
  });
});

// A single PGlite instance/schema is shared (server/testUtils/pgliteDb.ts is a module-level
// singleton), so initTestDb()/closeTestDb() are called once for the whole file — not per describe
// block — otherwise the first describe's afterAll would close the connection out from under the
// second one.
beforeAll(initTestDb);
afterAll(closeTestDb);

describe("0053_research_evidence_v2: PGlite CHECK behaviour (schema.ts-derived constraint)", () => {
  let athleteId: string;
  let runId: string;

  beforeAll(async () => {
    athleteId = await seedAthlete("Evidence V2 Athlete");
    const [run] = await db.insert(researchRuns).values({ athlete_id: athleteId, domain: "identity", trigger: "dual_write" } as any).returning({ id: researchRuns.id });
    runId = run.id;
  });

  const row = (over: Partial<typeof researchEvidence.$inferInsert>) => ({
    athlete_id: athleteId,
    run_id: runId,
    claim: {} as any,
    retrieved_at: new Date(),
    dedupe_key: `dedupe-${Math.random()}`,
    ...over,
  }) as any;

  it("accepts the new kind 'research_finding' with the new lineage 'native_supported'", async () => {
    const [r] = await db.insert(researchEvidence).values(row({ kind: "research_finding", lineage_status: "native_supported" })).returning({ id: researchEvidence.id });
    expect(r.id).toBeTruthy();
  });

  it("accepts the new kind 'career_event' with the new lineage 'native_retrieved'", async () => {
    const [r] = await db.insert(researchEvidence).values(row({ kind: "career_event", lineage_status: "native_retrieved" })).returning({ id: researchEvidence.id });
    expect(r.id).toBeTruthy();
  });

  it("accepts the new kind 'narrative_claim' with the new lineage 'asserted_only'", async () => {
    const [r] = await db.insert(researchEvidence).values(row({ kind: "narrative_claim", lineage_status: "asserted_only" })).returning({ id: researchEvidence.id });
    expect(r.id).toBeTruthy();
  });

  it("backward compatible: the legacy combination kind 'press_mention' + lineage 'cited' still succeeds", async () => {
    const [r] = await db.insert(researchEvidence).values(row({ kind: "press_mention", lineage_status: "cited" })).returning({ id: researchEvidence.id });
    expect(r.id).toBeTruthy();
  });

  it("rejects an unknown kind", async () => {
    await expect(db.insert(researchEvidence).values(row({ kind: "bogus_kind", lineage_status: "cited" }))).rejects.toThrow();
  });

  it("rejects an unknown lineage_status", async () => {
    await expect(db.insert(researchEvidence).values(row({ kind: "press_mention", lineage_status: "unsupported" }))).rejects.toThrow();
  });
});

describe("0053_research_evidence_v2: the migration FILE itself, applied (twice) as raw SQL against PGlite", () => {
  let athleteId: string;
  let runId: string;

  beforeAll(async () => {
    athleteId = await seedAthlete("Evidence V2 Migration-Applied Athlete");
    const [run] = await db.insert(researchRuns).values({ athlete_id: athleteId, domain: "identity", trigger: "dual_write" } as any).returning({ id: researchRuns.id });
    runId = run.id;

    // Apply the migration file's own SQL — not the schema.ts mirror — twice in a row, proving it is
    // idempotent (as its header claims) against a database that already carries the constraints
    // (shared/schema.ts was pushed by initTestDb() with 0082's wider sets in place). Since 0082 owns both
    // CHECKs, 0053 is two guarded DO blocks: on this database they leave the wider constraints alone.
    const raw = readFileSync(MIGRATION_PATH, "utf8");
    // Strip `--` comment lines first (the header prose has its own semicolons); the DO blocks are separated by a blank line.
    const withoutComments = raw.replace(/^--.*$/gm, "");
    const statements = withoutComments.split(/\n\s*\n/).map((s) => s.trim()).filter((s) => s.length > 0);
    expect(statements.length).toBe(2); // one guarded DO block for kind, one for lineage
    for (const s of statements) expect(s).toMatch(/^DO \$\$ BEGIN[\s\S]*NOT VALID;[\s\S]*END \$\$;$/);
    for (let pass = 0; pass < 2; pass++) {
      for (const statement of statements) await db.execute(sql.raw(statement));
    }
  });

  const row = (over: Partial<typeof researchEvidence.$inferInsert>) => ({
    athlete_id: athleteId,
    run_id: runId,
    claim: {} as any,
    retrieved_at: new Date(),
    dedupe_key: `dedupe-migrated-${Math.random()}`,
    ...over,
  }) as any;

  it("accepts a new kind/lineage combination after the migration SQL was (re-)applied", async () => {
    const [r] = await db.insert(researchEvidence).values(row({ kind: "reputation_event", lineage_status: "native_retrieved" })).returning({ id: researchEvidence.id });
    expect(r.id).toBeTruthy();
  });

  it("still accepts the legacy combination after the migration SQL was (re-)applied", async () => {
    const [r] = await db.insert(researchEvidence).values(row({ kind: "press_mention", lineage_status: "cited" })).returning({ id: researchEvidence.id });
    expect(r.id).toBeTruthy();
  });

  it("does not re-narrow 0082's sets: athlete_statement / source_read are still accepted after 0053 was (re-)applied", async () => {
    const [r] = await db.insert(researchEvidence).values(row({ kind: "athlete_statement", lineage_status: "source_read" })).returning({ id: researchEvidence.id });
    expect(r.id).toBeTruthy();
  });

  it("still rejects a bogus kind after the migration SQL was (re-)applied", async () => {
    await expect(db.insert(researchEvidence).values(row({ kind: "bogus_kind", lineage_status: "cited" }))).rejects.toThrow();
  });
});
