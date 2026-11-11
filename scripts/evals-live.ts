/**
 * evals-live.ts — the PAID eval run: `npm run evals:live`. By hand only.
 *
 *   1. refuses under CI (any CI env var) — it is never part of CI or `npm test`
 *   2. lists the cases, prints the model and a cost estimate (server/agent/evals/live.ts estimateLiveCost)
 *   3. asks; nothing is called unless a person types "yes" on a terminal (no flag skips the question)
 *   4. plays each tool-choice case as one model call, grades the first step with the offline grader, prints the
 *      grades and what it actually cost; exits 1 when any case failed
 *
 * The offline set (server/agent/evals/offline, CI) is the free half: the same cases and graders over scripted outputs.
 * It reads the provider keys from the environment it is run in; it never reads .env itself.
 */
import { createInterface } from "node:readline/promises";
import { CARD_EVAL_CASES } from "../server/agent/evals/offline/cardChoice.cases";
import { TOOL_CHOICE_CASES } from "../server/agent/evals/offline/toolChoice.cases";

async function main(): Promise<number> {
  if (process.env.CI) {
    console.error("evals:live: paid runs never run in CI.");
    return 2;
  }
  // The run never touches a database; server/db.ts only needs a URL to import (it builds its pool lazily), as the
  // catalogue does (scripts/catalogue/build.ts).
  process.env.DATABASE_URL ??= "postgres://evals-live@127.0.0.1:1/none";
  const { estimateLiveCost, livePlan, playToolChoice } = await import("../server/agent/evals/live");
  const plan = livePlan();
  const est = estimateLiveCost(plan);
  console.log("Tool choice (played):");
  for (const c of TOOL_CHOICE_CASES) console.log(`  ${c.id.padEnd(24)} ${c.question}`);
  console.log(`Card choice (listed, not played until #1193's card tools are registered): ${CARD_EVAL_CASES.length} cases`);
  console.log(`\nModel ${est.model}: ${est.cases} calls, ~${est.inputTokensPerCase} input + ~${est.outputTokensPerCase} output tokens each.`);
  console.log(`Estimated cost: about $${est.usd.toFixed(2)} (an over-estimate).`);

  if (!process.stdin.isTTY) {
    console.error("evals:live: needs a person at a terminal to confirm; nothing was run.");
    return 2;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Spend about $${est.usd.toFixed(2)} on ${est.cases} live calls? Type "yes" to run: `)).trim().toLowerCase();
  rl.close();
  if (answer !== "yes") {
    console.log("Nothing was run.");
    return 0;
  }

  const provider = plan.model.provider === "gemini"
    ? (await import("../server/agent/geminiProvider")).createGeminiProvider()
    : (await import("../server/agent/openaiResponses")).createOpenAIProvider();
  const results = await playToolChoice(provider, plan);
  let spent = 0;
  for (const r of results) {
    spent += r.microUsd;
    console.log(`${r.grade.pass ? "PASS" : "FAIL"}  ${r.id.padEnd(24)} ${r.calls.map((c) => c.name).join(" → ") || "(no tool)"}`);
    for (const p of r.grade.problems) console.log(`      - ${p}`);
  }
  const failed = results.filter((r) => !r.grade.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed. Spent $${(spent / 1e6).toFixed(4)}.`);
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => {
  console.error(`evals:live failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
