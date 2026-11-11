/**
 * mila-lock.ts — write server/agent/mila/skills.lock.json: each Mila skill's version (nomila.yaml) and the sha256 of its
 * served text (load.ts skillBodyDigest: the SKILL.md body as Mastra's skill tool serves it, authoring comments out).
 * mila.guard.test.ts fails when the served text changed and the lock was not refreshed, so a text change always comes
 * with a version bump; an edit to an authoring comment changes nothing served and needs none.
 *
 *   npm run mila:lock
 *
 * It refuses to write while lockProblems finds anything: a served-text change whose version was not bumped, or a
 * version lower than the locked one (versions only go up).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCK_FILE, MILA_DIR, buildSkillsLock, lockProblems, type SkillsLock } from "../server/agent/mila/load";

const file = join(MILA_DIR, LOCK_FILE);
const before: SkillsLock = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const after = buildSkillsLock();
const problems = lockProblems(before, after);
if (problems.length) {
  for (const p of problems) console.error(`skills/${p.name}: ${p.message}; fix version in skills/${p.name}/nomila.yaml first`);
  process.exit(1);
}
writeFileSync(file, JSON.stringify(after, null, 2) + "\n", "utf8");
console.log(`wrote ${LOCK_FILE}: ${Object.entries(after).map(([n, e]) => `${n}@${e.version}`).join(", ")}`);
