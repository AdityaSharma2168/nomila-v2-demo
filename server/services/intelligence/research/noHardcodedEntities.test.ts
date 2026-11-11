/**
 * noHardcodedEntities.test.ts — guards against baking a specific athlete, school or domain into the
 * research prompt/spec source or the source-type domain policy. Standing rule: nothing here should
 * apply to one athlete rather than every athlete.
 *
 * The denylist below guards against KNOWN PAST LEAKS specifically (not a general profanity/name
 * filter): "gostanford.com" / "goduke.com" were hardcoded into policy.ts's official_team_or_school
 * domain list, and "soccer" / "Stanford University" / "All-ACC First Team" / "On3" Mia-shaped values
 * leaked into the direct-evidence and extraction prompt examples. If this test starts failing because
 * a NEW file legitimately needs one of these strings, that's a sign to reconsider the design, not to
 * just widen an allowlist.
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_RESEARCH_POLICY } from "./policy";

const RESEARCH_DIR = __dirname;
const SPEC_DIR = path.join(RESEARCH_DIR, "spec");

const DENYLIST = ["stanford", "gostanford", "goduke", "bhuta", "mia bhuta"];

/** Non-test .ts source files that build research prompts/specs, or hold the source-type domain policy. */
function promptAndPolicySourceFiles(): string[] {
  const files: string[] = [path.join(RESEARCH_DIR, "policy.ts")];
  for (const name of fs.readdirSync(SPEC_DIR)) {
    if (name.endsWith(".ts") && !name.endsWith(".test.ts")) files.push(path.join(SPEC_DIR, name));
  }
  return files;
}

describe("no hardcoded entities in research prompts/spec or policy", () => {
  it.each(promptAndPolicySourceFiles())("%s contains none of the denylisted strings", (file) => {
    const text = fs.readFileSync(file, "utf8").toLowerCase();
    const hits = DENYLIST.filter((term) => text.includes(term));
    expect(hits).toEqual([]);
  });

  it("official_team_or_school lists only generic suffix/patterns, no school-specific domains", () => {
    const allowed = new Set([".edu", "athletics.com"]);
    const list = DEFAULT_RESEARCH_POLICY.sourceTypeDomains.official_team_or_school;
    const unexpected = list.filter((d) => !allowed.has(d));
    expect(unexpected).toEqual([]);
  });
});
