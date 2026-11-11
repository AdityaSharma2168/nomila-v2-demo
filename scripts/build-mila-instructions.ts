/**
 * build-mila-instructions.ts — print Mila's definition (draft) as one instruction string, with its size and digest.
 *
 *   npx tsx scripts/build-mila-instructions.ts                 # chat surface to stdout, summary to stderr
 *   npx tsx scripts/build-mila-instructions.ts --surface voice
 *   npx tsx scripts/build-mila-instructions.ts --out /tmp/mila-chat.txt
 *   npx tsx scripts/build-mila-instructions.ts --sizes         # per-file token estimates only
 *
 * No network, no database. The output is what goes into the Mastra agent's `instructions` (and the Prompt Register).
 */
import { writeFileSync } from "node:fs";
import {
  MILA_PLAYBOOKS, MILA_SURFACES, approxTokens, buildMilaInstructions, coreFiles, digestOf, readPlaybook, type MilaSurface,
} from "../server/agent/mila/build";
import { readCore, readSurface } from "../server/agent/mila/load";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (argv.includes("--sizes")) {
  // Each line is labelled with its file's path under server/agent/mila.
  const line = (label: string, text: string) => console.log(`${label.padEnd(36)} ~${approxTokens(text)} tokens`);
  for (const f of coreFiles()) line(`instructions/${f}`, readCore(f));
  for (const s of MILA_SURFACES) line(`surfaces/${s}.md`, readSurface(s));
  for (const p of MILA_PLAYBOOKS) line(`skills/${p}/SKILL.md`, readPlaybook(p));
  process.exit(0);
}

const surface = (flag("--surface") ?? "chat") as MilaSurface;
if (!MILA_SURFACES.includes(surface)) {
  console.error(`unknown surface "${surface}" (one of ${MILA_SURFACES.join(", ")})`);
  process.exit(2);
}
const text = buildMilaInstructions({ surface });
const out = flag("--out");
if (out) writeFileSync(out, text, "utf8");
else process.stdout.write(text);
console.error(`mila/${surface}: ${text.length} chars, ~${approxTokens(text)} tokens, sha256 ${digestOf(text).slice(0, 16)}`);
