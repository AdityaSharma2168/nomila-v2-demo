/**
 * mila-golden.ts — write server/agent/mila/served.golden.json: every surface's built instructions, every playbook's served text and version, the proactive preface, the waitlist preface and the waitlist pass's prompt, exactly as the
 * code at this checkout serves them. load.test.ts compares the loader against it, so a change that should move no
 * served byte (a refactor, a file move) is proven byte-identical. `generated_at` records the git commit it was written
 * from (with "-dirty" when the working tree had changes).
 *
 * Regenerate only on purpose: a deliberate text change, in the same PR as its Prompt Register entry. Never to make the
 * test pass.
 *
 *   npm run mila:golden
 */
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const GOLDEN_FILE = "served.golden.json";

function gitSha(): string {
  const sha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  const dirty = execSync("git status --porcelain --untracked-files=no", { encoding: "utf8" }).trim() !== "";
  return dirty ? `${sha}-dirty` : sha;
}

async function main() {
  // The preface modules import the db module, which needs a URL to load; nothing here opens a connection.
  process.env.DATABASE_URL ??= "postgres://unused@127.0.0.1:1/unused";
  const { MILA_DIR, MILA_SURFACES, buildMilaInstructions, digestOf, listPlaybooks } = await import("../server/agent/mila/build");
  const { loadPlaybook } = await import("../server/agent/engine/tools/playbooks");
  const { proactivePreface } = await import("../server/agent/proactive/turn");
  const { waitlistPreface } = await import("../server/agent/waitlist/turn");
  const { loadJob, promptDigest } = await import("../server/agent/jobs");

  const lf = (s: string) => s.replace(/\r\n/g, "\n");
  const instructions: Record<string, string> = {};
  for (const s of MILA_SURFACES) instructions[s] = buildMilaInstructions({ surface: s });
  const playbooks: Record<string, { version: string; text: string }> = {};
  for (const name of listPlaybooks()) {
    const p = loadPlaybook(name);
    playbooks[name] = { version: p.version, text: p.text };
  }
  const ws = loadJob("waitlist");
  const wsInstructions = lf(ws.instructions);
  const golden = {
    generated_at: gitSha(),
    instructions,
    instructions_sha256: Object.fromEntries(Object.entries(instructions).map(([k, v]) => [k, digestOf(v)])),
    playbooks,
    proactive_preface: proactivePreface(),
    waitlist_preface: { new: waitlistPreface(true), resumed: waitlistPreface(false) },
    waitlist_skill: { version: ws.version, tools: ws.tools, instructions: wsInstructions, prompt_digest: promptDigest({ ...ws, instructions: wsInstructions }) },
  };
  writeFileSync(join(MILA_DIR, GOLDEN_FILE), JSON.stringify(golden, null, 2) + "\n", "utf8");
  console.log(`wrote ${GOLDEN_FILE} at ${golden.generated_at}: ${Object.keys(instructions).length} surfaces, ${Object.keys(playbooks).length} playbooks`);
}

main().catch((err) => { console.error(err); process.exit(1); });
