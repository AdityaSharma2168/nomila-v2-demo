/**
 * marketabilityBeta1CanonicalQuarantine.test.ts — the withdrawn deterministic signal-derivation path gains no new callers.
 *
 * `SOCIAL_FEATURE_KEYS` maps social feature keys straight onto Beta.1 sub-signals: metric -> signal, deterministically.
 * That is the approach withdrawn in ADR-017 — Slice E scored 0.08 against the development reference set where the
 * rubric-constrained evaluator scores 0.887. It is also the most tempting wrong turn in the codebase, because it is a
 * ready-made map from the metrics we collect to the exact ten social sub-signals, sitting in a file that looks like
 * production infrastructure.
 *
 * Connected metrics reach the evaluator as EVIDENCE — feature -> factual prose in the authoritative social block ->
 * rubric-constrained judgment -> frozen arithmetic. Nomila computes rates; the evaluator decides what a rate means.
 *
 * The allow-list below is the CURRENT set of callers, all of which are deleted with the canonical path in the cleanup.
 * Add to it only to remove an entry. If you are here because this test failed on code you just wrote, the answer is
 * almost certainly the social block, not this map.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SERVER_ROOT = join(__dirname, "..");
const QUARANTINED = join(SERVER_ROOT, "services", "marketabilityBeta1Canonical.ts");

/** Modules permitted to import the withdrawn path today. Every entry is slated for deletion; this list only shrinks. */
const ALLOWED = [
  join("services", "marketabilityBeta1Canonical.ts"),
  join("services", "marketabilityBeta1Canonical.test.ts"),
  join("services", "marketabilityBeta1Normalization.ts"),
  join("services", "marketabilityBeta1Normalization.test.ts"),
  join("services", "marketabilityBeta1Service.ts"),
  join("scripts", "_beta1Readiness.ts"),   // untracked local diagnostic: present on a dev machine, absent in CI
];

const WITHDRAWN_SYMBOLS = ["SOCIAL_FEATURE_KEYS", "buildMarketabilityBeta1InputFromCanonical"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Source-text scan, so a type-only import is caught exactly like a value import. */
const IMPORT_RE = /(?:^|\n)\s*import\s[^;]*?from\s*["']([^"']+)["']/g;

describe("the withdrawn deterministic signal-derivation path is quarantined", () => {
  const files = walk(SERVER_ROOT).filter((f) => !ALLOWED.includes(relative(SERVER_ROOT, f)));

  it("scans a meaningful amount of source", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("gains no new importer of marketabilityBeta1Canonical", () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(IMPORT_RE)) {
        const spec = m[1];
        if (!spec.startsWith(".")) continue;
        const resolved = `${resolve(dirname(file), spec)}.ts`;
        if (resolved === QUARANTINED) violations.push(`${relative(SERVER_ROOT, file)} imports the withdrawn canonical path`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("names no withdrawn symbol outside the allow-list", () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const symbol of WITHDRAWN_SYMBOLS) {
        if (source.includes(symbol)) violations.push(`${relative(SERVER_ROOT, file)} references ${symbol}`);
      }
    }
    // This file names them in prose; exclude itself.
    expect(violations.filter((v) => !v.startsWith(`services${sep}marketabilityBeta1CanonicalQuarantine`))).toEqual([]);
  });

  // NOTE: there is deliberately no "every allow-listed file still exists" assertion. An entry vanishing is the
  // DESIRED end state — the list shrinks as the canonical path is deleted — and some entries are untracked local
  // diagnostics that exist on a developer machine and not in CI. Asserting existence encoded the opposite invariant
  // and failed in CI on a file whose absence was correct.
  it("the allow-list has no duplicates", () => {
    expect(new Set(ALLOWED).size).toBe(ALLOWED.length);
  });
});
