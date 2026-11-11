/**
 * jobs-golden.ts — write server/agent/jobs/served.golden.json: EVERY prompt the job loader serves (every id the loader
 * lists, chat and waitlist included), exactly as the code at this checkout serves it: the front-matter fields
 * (version, description, inputs, outputs, effort, model tier, tools, limits), the instructions with every include
 * expanded, the full text the model receives (instructionsFor: the harness rules + "# Skill: id vX" + the procedure)
 * and its promptDigest. jobs.golden.test.ts compares the loader against it, so a change that should move no served
 * byte (a refactor, a file move) is proven byte-identical. `generated_at` records the git commit it was written from
 * (with "-dirty" when the working tree had changes).
 *
 * Line endings are normalised to LF (a Windows checkout has CRLF on disk; the server image and CI read LF), the same
 * way scripts/mila-golden.ts does.
 *
 * Regenerate only on purpose: a deliberate text change, in the same PR as its Prompt Register entry. Never to make the
 * test pass.
 *
 *   npm run jobs:golden
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const GOLDEN_FILE = join(process.cwd(), "server", "agent", "jobs", "served.golden.json");

function gitSha(): string {
  const sha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  const dirty = execSync("git status --porcelain --untracked-files=no", { encoding: "utf8" }).trim() !== "";
  return dirty ? `${sha}-dirty` : sha;
}

async function main() {
  const { listJobs, loadJob, instructionsFor, promptDigest } = await import("../server/agent/jobs");
  const lf = (s: string) => s.replace(/\r\n/g, "\n");
  const jobs: Record<string, unknown> = {};
  for (const { id } of listJobs()) {
    const job = loadJob(id);
    const served = { ...job, instructions: lf(job.instructions) };
    jobs[id] = { ...served, served_text: instructionsFor(served), prompt_digest: promptDigest(served) };
  }
  const golden = { generated_at: gitSha(), jobs };
  mkdirSync(dirname(GOLDEN_FILE), { recursive: true });
  writeFileSync(GOLDEN_FILE, JSON.stringify(golden, null, 2) + "\n", "utf8");
  console.log(`wrote ${GOLDEN_FILE} at ${golden.generated_at}: ${Object.keys(jobs).length} job prompts`);
}

main().catch((err) => { console.error(err); process.exit(1); });
