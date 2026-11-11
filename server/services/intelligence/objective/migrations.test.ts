/**
 * migrations.test.ts — the revert checks for migrations/0063_objectives.sql and 0065_objective_run_events.sql.
 *
 * The Studio pattern (server/studio/publish/jobs.migration.test.ts), applied to the Objective tables. Each claim
 * below reds BY NAME when the claim is taken out of the file:
 *
 *   0063  three tables whose columns, constraints and indexes equal what shared/schema.ts declares; listed in
 *         db-migrate.sh once, after 0062; applies to a pre-0063 database and again without error; and the two
 *         CHECKs that carry the governance boundary hold in the database itself — a row cannot be `active`
 *         without the athlete's yes, and a system event cannot carry a user.
 *   0065  widens exactly one CHECK: after it, reconciliation's three actions are accepted; before it, refused.
 *         Listed once, after 0064. Applies twice without error.
 *
 * Statements are executed one at a time (each autocommits under psql -f), never as one implicit transaction.
 * `splitStatements` is duplicated from the Studio test rather than imported, for the same reason it gives.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..", "..");
const M0063 = readFileSync(join(ROOT, "migrations", "0063_objectives.sql"), "utf8");
const M0065 = readFileSync(join(ROOT, "migrations", "0065_objective_run_events.sql"), "utf8");
const M0068 = readFileSync(join(ROOT, "migrations", "0068_objective_evidence_as_seen.sql"), "utf8");
const M0069 = readFileSync(join(ROOT, "migrations", "0069_objective_lineage.sql"), "utf8");
const M0070 = readFileSync(join(ROOT, "migrations", "0070_objective_deferral.sql"), "utf8");
const M0079 = readFileSync(join(ROOT, "migrations", "0079_objective_change_assessed.sql"), "utf8");
const DB_MIGRATE = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
const TABLES = ["objective_proposal_sets", "objectives", "objective_events"];

function splitStatements(sql: string): string[] {
  const out: string[] = []; let buf = "", i = 0, tag: string | null = null;
  while (i < sql.length) {
    if (tag === null) {
      if (sql[i] === "-" && sql[i + 1] === "-") { const nl = sql.indexOf("\n", i); const end = nl === -1 ? sql.length : nl; buf += sql.slice(i, end); i = end; continue; }
      const m = /^\$([A-Za-z_]*)\$/.exec(sql.slice(i));
      if (m) { tag = m[0]; buf += tag; i += tag.length; continue; }
      if (sql[i] === ";") { if (buf.trim()) out.push(buf.trim()); buf = ""; i++; continue; }
      buf += sql[i++]; continue;
    }
    if (sql.startsWith(tag, i)) { buf += tag; i += tag.length; tag = null; continue; }
    buf += sql[i++];
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((s) => s.replace(/--[^\n]*/g, "").trim().length > 0);
}
async function applyLikePsql(pg: PGlite, sql: string): Promise<Error | null> {
  for (const statement of splitStatements(sql)) { try { await pg.exec(statement); } catch (err) { return err as Error; } }
  return null;
}
async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
/** Pre-0063: schema.ts pushed, then the three tables rewound away (events first — they reference the others). */
async function pre0063(): Promise<PGlite> {
  const pg = await pushed();
  for (const t of [...TABLES].reverse()) await pg.exec(`DROP TABLE ${t};`);
  return pg;
}
/** Pre-0068: everything pushed, then the two evidence columns rewound away. */
async function pre0068(): Promise<PGlite> {
  const pg = await pushed();
  await pg.exec(`ALTER TABLE objective_proposal_sets DROP COLUMN state_snapshot, DROP COLUMN opportunity_map;`);
  return pg;
}
/** Pre-0065: everything pushed, then the action CHECK rewound to 0063's nine actions. */
async function pre0065(): Promise<PGlite> {
  const pg = await pushed();
  await pg.exec(`ALTER TABLE objective_events DROP CONSTRAINT objective_events_action_check;`);
  await pg.exec(`ALTER TABLE objective_events ADD CONSTRAINT objective_events_action_check CHECK (action IN ('presented','created','accept','modify','decline','defer','abandon','achieve','supersede'));`);
  return pg;
}
/** Pre-0069: everything pushed, then lineage rewound away and the CHECK rewound to 0065's twelve actions. */
async function pre0069(): Promise<PGlite> {
  const pg = await pushed();
  await pg.exec(`ALTER TABLE objectives DROP COLUMN lineage;`);
  await pg.exec(`ALTER TABLE objective_events DROP CONSTRAINT objective_events_action_check;`);
  await pg.exec(`ALTER TABLE objective_events ADD CONSTRAINT objective_events_action_check CHECK (action IN ('presented','created','accept','modify','decline','defer','abandon','achieve','supersede','reaffirmed_by_run','re_proposed_while_declined','re_surfaced'));`);
  return pg;
}
const columnsOf = async (pg: PGlite, t: string) => (await pg.query<any>(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='${t}' ORDER BY column_name`)).rows;
const constraintsOf = async (pg: PGlite, t: string) => (await pg.query<any>(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='${t}'::regclass ORDER BY conname`)).rows;
const indexesOf = async (pg: PGlite, t: string) => (await pg.query<any>(`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='${t}' ORDER BY indexname`)).rows.map((r: any) => r.indexname);

const ATHLETE = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
async function seed(pg: PGlite) {
  await pg.query(`INSERT INTO athletes (id, full_name) VALUES ($1, 'A') ON CONFLICT DO NOTHING`, [ATHLETE]);
  await pg.query(`INSERT INTO users (id, provider, provider_uid) VALUES ($1, 'firebase', 'u') ON CONFLICT DO NOTHING`, [USER]);
  const o = (await pg.query<{ id: string }>(`INSERT INTO objectives (athlete_id, version, origin, domain, desired_state, provenance, success, confidence, disposition, lifecycle, created_snapshot, created_at)
    VALUES ($1, 'objective/1.0.0', 'nomila', 'audience', '{}', '{}', '{}', 'LOW', 'unreviewed', 'proposed', '{}', now()) RETURNING id`, [ATHLETE])).rows[0].id;
  return o;
}

describe("0063 — the file matches shared/schema.ts, and is on the list", () => {
  it("is listed in db-migrate.sh step 3, once, after 0062", () => {
    const list = DB_MIGRATE.split("\n").map((l) => l.trim());
    expect(list.filter((l) => l === "0063_objectives \\")).toHaveLength(1);
    expect(list.indexOf("0063_objectives \\")).toBe(list.indexOf("0062_media_assets_origin_reference \\") + 1);
  });
  it("applies to a pre-0063 database, and again without error (every statement guarded)", async () => {
    const pg = await pre0063();
    expect(await applyLikePsql(pg, M0063)).toBeNull();
    expect(await applyLikePsql(pg, M0063)).toBeNull();
  });
  it("produces the columns, constraints and indexes schema.ts declares, table by table (0065's CHECK and 0068's columns applied on top)", async () => {
    const want = await pushed(); const got = await pre0063(); expect(await applyLikePsql(got, M0063)).toBeNull();
    expect(await applyLikePsql(got, M0068)).toBeNull(); // 0068 adds two columns to objective_proposal_sets; schema.ts declares them
    expect(await applyLikePsql(got, M0069)).toBeNull(); // 0069 adds objectives.lineage and widens the action CHECK
    expect(await applyLikePsql(got, M0070)).toBeNull(); // 0070 adds objectives.deferral
    for (const t of TABLES) {
      expect(await columnsOf(got, t)).toEqual(await columnsOf(want, t));
      expect(await indexesOf(got, t)).toEqual(await indexesOf(want, t));
      const [g, w] = [await constraintsOf(got, t), await constraintsOf(want, t)];
      // 0065 widens one CHECK on objective_events. Foreign keys are compared by DEFINITION: 0063 shipped them under
      // Postgres's default names (…_fkey) rather than drizzle's (…_athletes_id_fk) and is already applied on dev;
      // a rename would be a migration for a cosmetic difference. Every other constraint must match by name and text.
      const norm = (rows: any[]) => rows.filter((r) => r.conname !== "objective_events_action_check")
        .map((r) => (r.def.startsWith("FOREIGN KEY") ? { conname: "<fk>", def: r.def } : r))
        .sort((x, y) => (x.conname + x.def).localeCompare(y.conname + y.def));
      expect(norm(g)).toEqual(norm(w));
    }
  });
  it("the database refuses `active` without the athlete's yes", async () => {
    const pg = await pre0063(); await applyLikePsql(pg, M0063); const id = await seed(pg);
    await expect(pg.query(`UPDATE objectives SET lifecycle='active', disposition='unreviewed' WHERE id=$1`, [id])).rejects.toThrow(/objectives_active_needs_yes/);
    await expect(pg.query(`UPDATE objectives SET lifecycle='active', disposition='declined' WHERE id=$1`, [id])).rejects.toThrow(/objectives_active_needs_yes/);
    await pg.query(`UPDATE objectives SET lifecycle='active', disposition='accepted' WHERE id=$1`, [id]);
  });
  it("the database refuses a system event with a user, and a person's event without one", async () => {
    const pg = await pre0063(); await applyLikePsql(pg, M0063); const id = await seed(pg);
    await expect(pg.query(`INSERT INTO objective_events (objective_id, athlete_id, at, actor_user_id, actor_role, action) VALUES ($1,$2,now(),$3,'system','presented')`, [id, ATHLETE, USER])).rejects.toThrow(/system_has_no_user/);
    await expect(pg.query(`INSERT INTO objective_events (objective_id, athlete_id, at, actor_user_id, actor_role, action) VALUES ($1,$2,now(),NULL,'athlete','accept')`, [id, ATHLETE])).rejects.toThrow(/system_has_no_user/);
    await pg.query(`INSERT INTO objective_events (objective_id, athlete_id, at, actor_user_id, actor_role, action) VALUES ($1,$2,now(),NULL,'system','presented')`, [id, ATHLETE]);
  });
  it("one row per proposal, ever", async () => {
    const pg = await pre0063(); await applyLikePsql(pg, M0063); await seed(pg);
    const setId = (await pg.query<{ id: string }>(`INSERT INTO objective_proposal_sets (athlete_id, as_of, spec_version, canonical_sha256, state_as_of, opportunity_map_as_of, set, record) VALUES ($1, now(), 'v', 'd', now(), now(), '{}', '{}') RETURNING id`, [ATHLETE])).rows[0].id;
    const ins = () => pg.query(`INSERT INTO objectives (athlete_id, version, origin, domain, desired_state, provenance, success, confidence, disposition, lifecycle, created_snapshot, created_at, proposal_set_id, proposal_key)
      VALUES ($1, 'objective/1.0.0', 'nomila', 'audience', '{}', '{}', '{}', 'LOW', 'unreviewed', 'proposed', '{}', now(), $2, 'k')`, [ATHLETE, setId]);
    await ins();
    await expect(ins()).rejects.toThrow(/objectives_one_per_proposal/);
  });
});

describe("0065 — reconciliation's three actions", () => {
  it("is listed in db-migrate.sh step 3, once, after 0064", () => {
    const list = DB_MIGRATE.split("\n").map((l) => l.trim());
    expect(list.filter((l) => l === "0065_objective_run_events \\")).toHaveLength(1);
    expect(list.indexOf("0065_objective_run_events \\")).toBe(list.indexOf("0064_studio_edit_previews \\") + 1);
  });
  it("does not re-narrow a CHECK a later migration owns: re-running 0063, 0065 and 0069 over rows written under 0079 succeeds", async () => {
    // The deploy of 25 Sep 2026 failed exactly here: 0063 re-added its nine-action CHECK over spans_live rows.
    const pg = await pushed(); const id = await seed(pg);
    await pg.query(`INSERT INTO objective_events (objective_id, athlete_id, at, actor_user_id, actor_role, action) VALUES ($1,$2,now(),NULL,'system','spans_live')`, [id, ATHLETE]);
    await pg.query(`INSERT INTO objective_events (objective_id, athlete_id, at, actor_user_id, actor_role, action) VALUES ($1,$2,now(),NULL,'system','change_assessed')`, [id, ATHLETE]);
    expect(await applyLikePsql(pg, M0063)).toBeNull();
    expect(await applyLikePsql(pg, M0065)).toBeNull();
    expect(await applyLikePsql(pg, M0069)).toBeNull();
    expect(await applyLikePsql(pg, M0079)).toBeNull();
    const [c] = (await constraintsOf(pg, "objective_events")).filter((r: any) => r.conname === "objective_events_action_check");
    expect(c.def).toContain("'spans_live'"); expect(c.def).toContain("'change_assessed'"); expect(c.def).not.toContain("NOT VALID");
  });
  it("on a fresh database the sequence 0063 → 0065 → 0069 → 0079 ends with the owner's validated definition; 0065 alone adds the twelve, unvalidated, only when absent", async () => {
    const pg = await pre0065(); const id = await seed(pg);
    // pre0065 already carries a (nine-action) CHECK, so 0065 and 0069 leave it alone — ownership has moved to 0079
    expect(await applyLikePsql(pg, M0065)).toBeNull();
    expect(await applyLikePsql(pg, M0069)).toBeNull();
    expect(await applyLikePsql(pg, M0079)).toBeNull();
    const ins = (a: string) => pg.query(`INSERT INTO objective_events (objective_id, athlete_id, at, actor_user_id, actor_role, action) VALUES ($1,$2,now(),NULL,'system',$3)`, [id, ATHLETE, a]);
    for (const a of ["reaffirmed_by_run", "re_proposed_while_declined", "re_surfaced", "spans_live", "change_assessed"]) await ins(a);
    await expect(ins("rank")).rejects.toThrow(/objective_events_action_check/);
  });
  it("after 0065, 0069 and 0079 the CHECK equals what schema.ts declares", async () => {
    const want = await pushed(); const got = await pre0065(); await applyLikePsql(got, M0065); await applyLikePsql(got, M0069); await applyLikePsql(got, M0079);
    expect(await constraintsOf(got, "objective_events")).toEqual(await constraintsOf(want, "objective_events"));
  });
});

describe("0069 — lineage and reconciliation 2.0's findings", () => {
  it("is listed in db-migrate.sh step 3, once, after 0068", () => {
    const list = DB_MIGRATE.split("\n").map((l) => l.trim());
    expect(list.filter((l) => l === "0069_objective_lineage \\")).toHaveLength(1);
    expect(list.indexOf("0069_objective_lineage \\")).toBe(list.indexOf("0068_objective_evidence_as_seen \\") + 1);
  });
  it("adds the nullable lineage column and applies twice; its CHECK is now the guarded form (0079 owns it), so the findings arrive with 0079", async () => {
    const want = await pushed(); const got = await pre0069(); const id = await seed(got);
    const ins = (a: string) => got.query(`INSERT INTO objective_events (objective_id, athlete_id, at, actor_user_id, actor_role, action) VALUES ($1,$2,now(),NULL,'system',$3)`, [id, ATHLETE, a]);
    for (const a of ["spans_live", "splits_live", "may_relate"]) await expect(ins(a)).rejects.toThrow(/objective_events_action_check/);
    expect(await applyLikePsql(got, M0069)).toBeNull();
    expect(await applyLikePsql(got, M0069)).toBeNull();
    await expect(ins("spans_live")).rejects.toThrow(/objective_events_action_check/); // guarded: an existing CHECK is left alone
    expect(await applyLikePsql(got, M0079)).toBeNull();
    for (const a of ["spans_live", "splits_live", "may_relate"]) await ins(a);
    await applyLikePsql(got, M0070);
    expect(await columnsOf(got, "objectives")).toEqual(await columnsOf(want, "objectives"));
    expect(await constraintsOf(got, "objective_events")).toEqual(await constraintsOf(want, "objective_events"));
  });
});

describe("0079 — change_assessed (Slice 3 B) and success_confirmed (Slice 3 A)", () => {
  it("is listed in db-migrate.sh step 3, once, after 0077", () => {
    const list = DB_MIGRATE.split("\n").map((l) => l.trim());
    expect(list.filter((l) => l === "0079_objective_change_assessed \\")).toHaveLength(1);
    expect(list.indexOf("0079_objective_change_assessed \\")).toBe(list.indexOf("0077_intelligence_requests \\") + 1);
  });
  it("owns the CHECK: admits change_assessed, keeps every earlier action, applies twice, and matches schema.ts", async () => {
    const want = await pushed(); const got = await pre0069(); await applyLikePsql(got, M0069); const id = await seed(got);
    const ins = (a: string) => got.query(`INSERT INTO objective_events (objective_id, athlete_id, at, actor_user_id, actor_role, action) VALUES ($1,$2,now(),NULL,'system',$3)`, [id, ATHLETE, a]);
    await expect(ins("change_assessed")).rejects.toThrow(/objective_events_action_check/);
    await expect(ins("success_confirmed")).rejects.toThrow(/objective_events_action_check/);
    expect(await applyLikePsql(got, M0079)).toBeNull();
    expect(await applyLikePsql(got, M0079)).toBeNull();
    for (const a of ["presented", "reaffirmed_by_run", "may_relate", "change_assessed", "success_confirmed"]) await ins(a);
    await expect(ins("rank")).rejects.toThrow(/objective_events_action_check/);
    expect(await constraintsOf(got, "objective_events")).toEqual(await constraintsOf(want, "objective_events"));
  });
});

describe("0070 — deferral column", () => {
  it("is listed in db-migrate.sh step 3, once, after 0069", () => {
    const list = DB_MIGRATE.split("\n").map((l) => l.trim());
    expect(list.filter((l) => l === "0070_objective_deferral \\")).toHaveLength(1);
    expect(list.indexOf("0070_objective_deferral \\")).toBe(list.indexOf("0069_objective_lineage \\") + 1);
  });
  it("adds exactly one nullable jsonb column, applies twice, and matches schema.ts", async () => {
    const want = await pushed(); const got = await pushed();
    await got.exec(`ALTER TABLE objectives DROP COLUMN deferral;`);
    expect(await applyLikePsql(got, M0070)).toBeNull();
    expect(await applyLikePsql(got, M0070)).toBeNull();
    expect(await columnsOf(got, "objectives")).toEqual(await columnsOf(want, "objectives"));
  });
});

describe("0068 — evidence-as-seen columns", () => {
  it("is listed in db-migrate.sh step 3, once, after 0067", () => {
    const list = DB_MIGRATE.split("\n").map((l) => l.trim());
    expect(list.filter((l) => l === "0068_objective_evidence_as_seen \\")).toHaveLength(1);
    expect(list.indexOf("0068_objective_evidence_as_seen \\")).toBe(list.indexOf("0067_identity_profile \\") + 1);
  });
  it("adds exactly the two nullable jsonb columns schema.ts declares, applies twice, and touches nothing else", async () => {
    const want = await pushed(); const got = await pre0068();
    const before = await columnsOf(got, "objective_proposal_sets");
    expect(before.map((c: any) => c.column_name)).not.toContain("state_snapshot");
    expect(await applyLikePsql(got, M0068)).toBeNull();
    expect(await applyLikePsql(got, M0068)).toBeNull();
    expect(await columnsOf(got, "objective_proposal_sets")).toEqual(await columnsOf(want, "objective_proposal_sets"));
    const added = (await columnsOf(got, "objective_proposal_sets")).filter((c: any) => ["state_snapshot", "opportunity_map"].includes(c.column_name));
    expect(added.map((c: any) => [c.data_type, c.is_nullable])).toEqual([["jsonb", "YES"], ["jsonb", "YES"]]);
  });
});
