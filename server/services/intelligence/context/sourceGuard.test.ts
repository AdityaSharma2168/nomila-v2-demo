/**
 * sourceGuard.test.ts — gate G5 "no silent fallback", source level (design §3.4, R4): the files that read
 * the legacy research blob (`athleteSnapshots.research`) or the projection columns
 * (`athletes.school | division | conference`) are EXACTLY the allow-list below. 2d-2..2d-6 shrink the list
 * as each reader moves to a view; Step 4 removes the blob and the projection. A NEW reader anywhere else
 * fails the build. Like boundary.test.ts this checks the source, not the runtime.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SERVER = join(__dirname, "..", "..", "..");

/** The 2d-1 allow-list (the §1.2 audit's blob readers). Remove entries as readers migrate; never add without a design entry. */
const BLOB_READERS = [
  "services/intelligence/context/legacyAdapter.ts",   // the ONLY parser (design §3.1)
  "mila/onboarding.ts",                                 // #2 onboarding block → promptView (2d-2)
  "services/athleteContext.ts",                         // #5 deck assembler → deckView (2d-4)
  "services/athleteRecord.ts",                          // #1 Facts screen → recordView (2d-2)
  "skills/collectDiscoveryAnalytics.ts",                // #34 discovery handles → knownHandles (2d-5)
  "skills/researchAthlete.ts",                          // the WRITE path (KEEP: research produces the blob until Step 4)
  "workflow/definitions/onboarding.ts",                 // #15 signup research anchor + #16 handles → searchView (2d-5)
];

const PROJECTION_READERS = [
  "services/intelligence/context/legacyAdapter.ts",
  "services/affiliations.ts",                           // the projection WRITER (projectPrimary; KEEP until Step 4)
  "mila/onboarding.ts",                                 // #2 → promptView (2d-2)
  "mila/tools/getProfile.ts",                           // #8 → identityView (2d-3)
  "routes/admin.ts",                                    // #12 admin list → identityView (2d-3)
  "routes/waitlist.ts",                                 // #13 waitlist creation writes the column (KEEP: a write, not a read)
  "services/athleteContext.ts",                         // #5 → deckView (2d-4)
  "services/athleteRecord.ts",                          // #1 → recordView (2d-2)
  "services/intelligence/research/refresh.ts",          // #31 hintsFor fallback → searchView (2d-5)
  "voice/profileRoute.ts",                              // #9 → identityView (2d-3)
  "workflow/definitions/onboarding.ts",                 // #15 → searchView (2d-5)
  "workflow/definitions/researchRefresh.ts",            // #17 → searchView (2d-5)
  "scripts/reprojectAffiliations.ts",                   // 2d-6: the projection reconciliation reports before → after (the projection WRITER's tool)
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !/testFixtures\.ts$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(SERVER, p).replace(/\\/g, "/");
const readersOf = (re: RegExp) => walk(SERVER).filter((f) => re.test(readFileSync(f, "utf8"))).map(rel).sort();

describe("G5: the legacy blob and the projection columns are read only by the allow-listed files", () => {
  it("athleteSnapshots.research", () => {
    const found = readersOf(/\bathleteSnapshots\.research\b/);
    expect(found).toContain("services/intelligence/context/legacyAdapter.ts");   // not vacuous
    expect(found.filter((f) => !BLOB_READERS.includes(f))).toEqual([]);
    expect(found).toEqual([...BLOB_READERS].sort());                              // and the list has no dead entries
  });

  it("athletes.school / division / conference", () => {
    const found = readersOf(/\bathletes\.(school|division|conference)\b/);
    expect(found).toContain("services/intelligence/context/legacyAdapter.ts");
    expect(found.filter((f) => !PROJECTION_READERS.includes(f))).toEqual([]);
    expect(found).toEqual([...PROJECTION_READERS].sort());
  });

  it("2d-6 (§4.4): research never writes the projection — no athleteUpdate.school/conference/division in researchAthlete", () => {
    const src = readFileSync(join(SERVER, "skills/researchAthlete.ts"), "utf8");
    expect(src).not.toMatch(/athleteUpdate\.(school|conference|division)\b/);
    expect(src).toMatch(/athleteUpdate\.sport\b/);   // the sport fill stays (not a projection of the ledger)
  });

  it("nothing under services/intelligence/context/ other than the adapter touches the blob or the projection", () => {
    const here = walk(__dirname).filter((f) => /\bathleteSnapshots\.research\b|\bathletes\.(school|division|conference)\b/.test(readFileSync(f, "utf8"))).map(rel);
    expect(here).toEqual(["services/intelligence/context/legacyAdapter.ts"]);
  });
});
