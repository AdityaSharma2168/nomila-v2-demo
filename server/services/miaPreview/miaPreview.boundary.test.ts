/**
 * miaPreview.boundary.test.ts — the preview's code path never imports or queries a RETIRING table.
 *
 * The switch map retires athlete_facts, research_*, athlete_research_state, athlete_inferences and
 * identity_intelligence_*. The memory adapter is THE M.I.A. path for new-agent athletes, so its files must not reach
 * them. Two guards, both derived rather than listed by hand where they can be:
 *
 *   STATIC   (here) the preview's own files: no retiring table's schema export in an import, no retiring table name in
 *            any string (raw SQL), no import of the legacy research / canonical-context / identity-intelligence
 *            modules or the legacy M.I.A. research reader, and only the connected-account helpers from the social block.
 *            The retiring exports are read from shared/schema.ts, so a new research_* table is covered automatically.
 *   RUNTIME  (miaPreview.db.test.ts) the whole path — preview, the mia_evaluation workflow, My Intelligence — runs with
 *            every retiring table DROPPED, so any query against one fails that suite.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..", "..");
const PREVIEW_FILES = [
  "server/services/miaPreview/memoryAdapter.ts",
  "server/services/miaPreview/previewMeta.ts",
  "server/services/miaPreview/preview.ts",
  "server/services/miaPreview/factsOnlySpec.ts",
  "server/routes/meMiaPreview.ts",
];
const RETIRING_TABLE = /^(research_[a-z_]+|identity_intelligence[a-z_]*|athlete_facts|athlete_inferences|athlete_research_state)$/;

/** schema export name → table name, for every pgTable in shared/schema.ts. */
function schemaTables(): Map<string, string> {
  const src = readFileSync(join(REPO, "shared/schema.ts"), "utf8");
  const out = new Map<string, string>();
  for (const m of src.matchAll(/export const (\w+)\s*=\s*pgTable\(\s*"([a-z0-9_]+)"/g)) out.set(m[1], m[2]);
  return out;
}

const read = (f: string) => readFileSync(join(REPO, f), "utf8");
const importsOf = (src: string) => [...src.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+"([^"]+)"/g)].map((m) => ({ names: m[1], from: m[2] }));
const dynamicImportsOf = (src: string) => [...src.matchAll(/import\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]);

const retiringExports = [...schemaTables()].filter(([, table]) => RETIRING_TABLE.test(table)).map(([name]) => name);

test("the retiring set is what the switch map names (derived from the schema)", () => {
  const tables = [...schemaTables().values()].filter((t) => RETIRING_TABLE.test(t));
  expect(tables).toEqual(expect.arrayContaining(["athlete_facts", "athlete_research_state", "athlete_inferences", "research_evidence", "research_runs", "research_source_payloads", "identity_intelligence_attempts"]));
  expect(retiringExports.length).toBe(tables.length);
});

describe.each(PREVIEW_FILES)("%s", (file) => {
  const src = read(file);
  const imports = importsOf(src);

  test("imports no retiring table from the schema", () => {
    for (const imp of imports.filter((i) => /shared\/schema$/.test(i.from))) {
      const names = imp.names.replace(/[{}]/g, " ").split(/[\s,]+/).filter(Boolean).map((n) => n.replace(/^type$/, ""));
      for (const r of retiringExports) expect(names).not.toContain(r);
    }
  });

  test("names no retiring table in any string (no raw SQL against them)", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
    const strings = [...code.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]);
    for (const s of strings) expect(s).not.toMatch(/\b(research_[a-z_]+|identity_intelligence[a-z_]*|athlete_facts|athlete_inferences|athlete_research_state)\b/);
  });

  test("imports none of the legacy research / identity readers", () => {
    const LEGACY = /intelligence\/(research|context)\/|identityIntelligence|marketabilityBeta1Service|marketabilityBeta1Canonical|athleteKnowledge|athleteRecord/;
    for (const from of [...imports.map((i) => i.from), ...dynamicImportsOf(src)]) expect(from).not.toMatch(LEGACY);
  });

  test("from the social block, only the connected-account helpers (never citedHandles / discovery)", () => {
    for (const imp of imports.filter((i) => /marketabilityBeta1SocialBlock$/.test(i.from))) {
      const names = imp.names.replace(/[{}]/g, " ").split(/[\s,]+/).filter((n) => n && n !== "type");
      for (const n of names) expect(["connectedBlock", "renderBlock", "SocialAccountBlock", "SocialBlockRecord"]).toContain(n);
    }
  });
});

test("the evaluation gate and My Intelligence decide a memory athlete's identity from memory before any legacy read", () => {
  const orch = read("server/services/marketabilityBeta1Orchestrator.ts");
  const gate = orch.slice(orch.indexOf("export async function miaIdentityGate"));
  expect(gate.indexOf("isMemoryAthlete")).toBeGreaterThan(-1);
  expect(gate.indexOf("isMemoryAthlete")).toBeLessThan(gate.indexOf("readIdentityState"));
  // The snapshot is built from memory only (4 Nov 2026: the legacy, search-enabled snapshot is gone).
  const build = orch.slice(orch.indexOf("export async function buildAndPersistSnapshot"), orch.indexOf("export async function persistSnapshot"));
  expect(build.indexOf("isMemoryAthlete")).toBeGreaterThan(-1);
  expect(build.indexOf("isMemoryAthlete")).toBeLessThan(build.indexOf("buildMemoryFactsSnapshot("));
  expect(build).not.toMatch(/buildEvidenceSnapshot|buildMemoryEvidenceSnapshot/);

  const view = read("server/services/intelligence/views/myIntelligence.ts");
  const fn = view.slice(view.indexOf("export async function buildMyIntelligence"));
  expect(fn.indexOf("readMemoryIdentity")).toBeGreaterThan(-1);
  expect(fn.indexOf("readMemoryIdentity")).toBeLessThan(fn.indexOf("readResearchStatus"));
});
