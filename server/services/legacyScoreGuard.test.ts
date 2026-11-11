/**
 * legacyScoreGuard.test.ts — legacy /850 score + v3 rates retirement, P2-3 (owner decisions 8 Oct 2026).
 *
 * NOTHING reads the legacy score or the computed rates any more. The columns
 * `athletes_current.{display_score, tier, internal_score, capitals, pav, deal_type_rates, rate_card}` are still WRITTEN
 * by the legacy engine until P2-4 stops it, and dropped by migration in P3-1 — so a new read anywhere would either show
 * a retired number or break when the column goes. This guard FAILS on any read in server/, client/ or shared/:
 *
 *   · a Drizzle column reference `athletesCurrent.<legacy column>` (selects, where, order by — every read);
 *   · a whole-row `select().from(athletesCurrent)` (it reads every legacy column along with the rest);
 *   · raw SQL selecting a legacy column from `athletes_current`.
 *
 * Writes are not reads: the legacy writer sets these keys in an insert object, which none of the patterns match.
 * The allow-list is the code P2-4 / P2-5 DELETE; it may only shrink, and it has no dead entries (asserted below).
 * Like services/intelligence/context/sourceGuard.test.ts this checks the source, not the runtime.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");
const DIRS = ["server", "client", "shared"].map((d) => join(ROOT, d));

const LEGACY = "display_score|tier|internal_score|capitals|pav|deal_type_rates|rate_card";

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "athletesCurrent.<legacy column>", re: new RegExp(`\\bathletesCurrent\\.(${LEGACY})\\b`) },
  { name: "select().from(athletesCurrent)", re: /\.select\(\s*\)\s*\.from\(\s*athletesCurrent\s*\)/ },
  { name: "raw SQL select of a legacy column", re: new RegExp(`select[^;\`]*\\b(${LEGACY})\\b[^;\`]*\\bfrom\\s+athletes_current\\b`, "i") },
];

/** The legacy engine itself — deleted by P2-4 (computation) and P2-5 (dead code). Only ever shrinks. */
const ALLOWED: Record<string, string> = {
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__snapshots__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/testFixtures\.ts$/.test(name) && name !== "schema.ts") out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(ROOT, p).replace(/\\/g, "/");

const files = DIRS.flatMap((d) => walk(d));
const hits = new Map<string, string[]>();
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const { name, re } of PATTERNS) if (re.test(src)) hits.set(rel(f), [...(hits.get(rel(f)) ?? []), name]);
}

describe("legacy score / rate columns: no reads outside the legacy engine (P2-3 guard)", () => {
  it("walks the real tree (not vacuous)", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.map(rel)).toContain("server/services/athleteContext.ts");
  });

  it("finds no read of athletes_current.{display_score, tier, internal_score, capitals, pav, deal_type_rates, rate_card} outside the allow-list", () => {
    const offenders = [...hits.entries()].filter(([f]) => !(f in ALLOWED)).map(([f, why]) => `${f}: ${why.join(", ")}`);
    expect(offenders).toEqual([]);
  });

  it("has no dead allow-list entries (delete the entry with the file)", () => {
    expect(Object.keys(ALLOWED).filter((f) => !hits.has(f))).toEqual([]);
  });

  it("the patterns catch the reads they are for", () => {
    const [col, whole, raw] = PATTERNS.map((p) => p.re);
    expect(col.test("db.select({ s: athletesCurrent.display_score })")).toBe(true);
    expect(col.test("eq(athletesCurrent.rate_card, x)")).toBe(true);
    expect(col.test("athletesCurrent.story_arc")).toBe(false);
    expect(whole.test("db.select()\n  .from(athletesCurrent)")).toBe(true);
    expect(whole.test("db.select({ a: athletesCurrent.athlete_id }).from(athletesCurrent)")).toBe(false);
    expect(raw.test("SELECT tier, display_score FROM athletes_current WHERE athlete_id = $1")).toBe(true);
    expect(raw.test("SELECT story_arc FROM athletes_current")).toBe(false);
    // a write is not a read
    expect([col, whole, raw].some((re) => re.test("db.insert(athletesCurrent).values({ display_score: 1, tier: 'x' })"))).toBe(false);
  });
});
