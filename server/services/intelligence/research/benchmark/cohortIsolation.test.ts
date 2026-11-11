/**
 * Cohort isolation (review of #443, 12 Sep 2026): the provider-execution cohort carries identity/research inputs only;
 * frozen M.I.A. targets live in an evaluation-only file that the request builder never loads.
 */

import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..", "..", "..", "..", "scripts", "calibration");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");

describe("calibration cohort isolation", () => {
  it("the execution cohort has no target, score, tier or calibration label on any athlete", () => {
    const cohort = JSON.parse(read("cohort.dev20.json"));
    expect(cohort.athletes).toHaveLength(20);
    for (const a of cohort.athletes) {
      expect(Object.keys(a).sort()).toEqual(expect.arrayContaining(["key", "fullName", "sport", "group", "anchor"]));
      for (const k of Object.keys(a)) expect(k).not.toMatch(/target|score|tier|rank|calibration|mia/i);
      expect(JSON.stringify(a)).not.toMatch(/\b\d{3}\b(?![^"]*")/);   // no bare three-digit numbers (a score) inside athlete records
    }
  });

  it("the targets file is evaluation-only and covers exactly the cohort", () => {
    const cohort = JSON.parse(read("cohort.dev20.json"));
    const targets = JSON.parse(read("cohort.dev20.targets.json"));
    expect(targets.note).toMatch(/EVALUATION LAYER ONLY/);
    expect(Object.keys(targets.targets).sort()).toEqual(cohort.athletes.map((a: any) => a.key).sort());
  });

  it("the request builder never references the targets or gold files", () => {
    const harness = read("providerBenchmark.ts");
    expect(harness).not.toMatch(/targets\.json|loadTargets|targetScore/);
    const spec = readFileSync(join(__dirname, "..", "spec", "researchSpecV1.ts"), "utf8");
    expect(spec).not.toMatch(/targetScore|loadTargets|gold\.json/);
  });
});
