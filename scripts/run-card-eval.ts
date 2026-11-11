/**
 * run-card-eval.ts — the card-choice eval (server/agent/evals/milaCards.cases.ts: "did Mila pick the right card?").
 *
 *   npx tsx scripts/run-card-eval.ts            # lists the cases and their expectations (free, no provider)
 *   npx tsx scripts/run-card-eval.ts --paid     # NOT BUILT: playing the cases through the live chat turn is a paid run
 *                                               # that needs the owner's OK; this flag only says so and exits 2
 *
 * Never in CI: with CI set it refuses anything but the listing. Not part of `npm test`.
 */
import { CARD_EVAL_CASES } from "../server/agent/evals/milaCards.cases";

const paid = process.argv.includes("--paid");
if (paid && process.env.CI) {
  console.error("run-card-eval: paid runs never run in CI");
  process.exit(2);
}
for (const c of CARD_EVAL_CASES) {
  console.log(`${c.id.padEnd(22)} ${c.expect.tool.padEnd(20)} ${c.situation}`);
  for (const check of c.expect.checks) console.log(`${"".padEnd(23)}- ${check}`);
}
if (paid) {
  console.error("\nrun-card-eval: the paid run (cases through the live chat turn, graded in code) is not built yet. Ask the owner before building or running it.");
  process.exit(2);
}
