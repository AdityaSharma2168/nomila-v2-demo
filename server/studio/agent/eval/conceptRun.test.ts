/**
 * conceptRun.test.ts — the concept runner writes NOTHING to a database (PR 16, R-9, M11). Every concept,
 * picked or not, lives in its run file under probe-out/. Held structurally: the runner imports no
 * database module and no schema table, so it has no way to write one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RUNNER = readFileSync(
  join(__dirname, "..", "..", "..", "scripts", "studioConceptEval.ts"),
  "utf8",
);
const imports = RUNNER.split("\n").filter((l) =>
  /^\s*import\b|require\(|await import\(/.test(l),
);

describe("the concept runner", () => {
  it("an un-picked concept is written to the DB — it cannot be: no db, no schema, no drizzle import", () => {
    expect(
      imports.filter((l) =>
        /\/db\b|shared\/schema|drizzle|pgliteDb|savePlan|plans"/.test(l),
      ),
    ).toEqual([]);
  });
  it("keeps every concept on the run file", () => {
    expect(RUNNER).toContain("concepts,");
    expect(RUNNER).toContain('join(DIR, "runs"');
  });
});
