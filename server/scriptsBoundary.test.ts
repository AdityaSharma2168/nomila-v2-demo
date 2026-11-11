/**
 * scriptsBoundary.test.ts — production code may not import from server/scripts/.
 *
 * server/scripts/ holds operational tooling and analysis: calibration runners, diagnostics, backfills, probes. It is
 * allowed to import production modules — that is the point of it. The dependency must never run the other way, or the
 * methodological record and the running product become entangled: an analysis script would be load-bearing at runtime,
 * and deleting an obsolete diagnostic would break the server.
 *
 * DESIGN RULE — production source is defined CONSERVATIVELY as all TypeScript under server/ except explicitly documented
 * non-production exclusions. This guard is deny-by-default so that a new runtime directory is protected the day it
 * appears; an allow-list of known runtime trees fails open, silently, exactly when the repo's structure changes.
 * (server/workflow/ already existed when this was written and would have been missed by an obvious allow-list.)
 *
 * The rule is checked on the SOURCE, not the runtime, so a type-only import is caught too — `import type { X } from
 * "../scripts/..."` couples production to tooling just as surely as a value import does. Relative specifiers are resolved
 * against the importing file's directory rather than matched as substrings, so `../../scripts/foo` from a nested module
 * is caught and an unrelated path such as `client/scripts/` is not.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const SERVER_ROOT = join(__dirname);
const FORBIDDEN_ROOT = join(SERVER_ROOT, "scripts");

/**
 * Non-production paths. Add to this list only with a reason; never remove from it to make a failure go away.
 *  - server/scripts/     the tooling itself — it may import production freely
 *  - *.test.ts           tests may exercise analysis tooling; that is not production coupling
 *  - *.testFixtures.ts   fixtures shared by tests
 */
const EXCLUDED = [
  (p: string) => p === "scripts" || p.startsWith(`scripts${sep}`),
  (p: string) => p.endsWith(".test.ts"),
  (p: string) => p.endsWith(".testFixtures.ts"),
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const IMPORT_SPECIFIER = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|(?:^|[^.\w])require\(\s*["']([^"']+)["']\s*\)|(?:^|[^.\w])import\(\s*["']([^"']+)["']\s*\)/g;

/** Every specifier a file imports from, in source order. */
function specifiersOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(IMPORT_SPECIFIER)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) out.push(spec);
  }
  return out;
}

/** True when the specifier, resolved from the importing file, lands inside server/scripts/. */
function resolvesIntoScripts(fromFile: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;   // package imports can never reach a local directory
  const resolved = resolve(dirname(fromFile), specifier);
  const rel = relative(FORBIDDEN_ROOT, resolved);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

describe("production code may not import from server/scripts/", () => {
  const productionFiles = walk(SERVER_ROOT).filter((f) => {
    const rel = relative(SERVER_ROOT, f);
    return !EXCLUDED.some((isExcluded) => isExcluded(rel));
  });

  it("finds production source to check (the guard is not silently scanning nothing)", () => {
    expect(productionFiles.length).toBeGreaterThan(100);
  });

  it("no production module imports server/scripts/", () => {
    const violations: string[] = [];
    for (const file of productionFiles) {
      const source = readFileSync(file, "utf8");
      for (const specifier of specifiersOf(source)) {
        if (resolvesIntoScripts(file, specifier)) violations.push(`${relative(SERVER_ROOT, file)} imports "${specifier}"`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("the guard actually detects a violation (it would catch a real one)", () => {
    const pretendFile = join(SERVER_ROOT, "services", "pretend.ts");
    expect(resolvesIntoScripts(pretendFile, "../scripts/calibration/blindEval/runBlindEval")).toBe(true);
    expect(resolvesIntoScripts(join(SERVER_ROOT, "services", "intelligence", "deep", "x.ts"), "../../../scripts/anything")).toBe(true);
    expect(resolvesIntoScripts(pretendFile, "./marketabilityBeta1")).toBe(false);
    expect(resolvesIntoScripts(pretendFile, "drizzle-orm")).toBe(false);
  });
});
