/**
 * run-mila-eval.ts — the golden eval gate for the Mila agent.
 *
 * Runs evals/mila/golden.jsonl against the seeded dev athlete by calling the
 * REAL agent loop (runMilaLoop) once per entry, capturing the tool-call trace
 * and final text, asserting each, printing a pass/fail table, and exiting
 * non-zero if any entry fails — so it can gate a demo.
 *
 *   npx tsx --require dotenv/config scripts/run-mila-eval.ts --athlete <uuid>
 *   (npm run eval:mila -- --athlete <uuid>)
 *
 * READ-ONLY. Every entry runs with `ephemeral: true`, which makes runMilaLoop
 * skip history replay AND all chat_messages writes; every Mila tool is a plain
 * SELECT. So this reads the seeded data and writes NOTHING to the DB.
 *
 * NOT free: it makes real Gemini (Vertex) calls, ~1–3 per entry, billed to the
 * GCP account. Bounded to the ~10 golden entries, run sequentially, with NO
 * retries and NO watch loop.
 *
 * Prereqs: the Cloud SQL Auth Proxy running (DATABASE_URL), Vertex ADC for the
 * model call, and the seeded athlete present (scripts/seed-dev-athlete.ts).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runMilaLoop } from "../server/mila/loop";
import { milaTools } from "../server/mila/registry";
import type { MilaTool } from "../server/mila/types";
import type { SSEStream } from "../server/lib/sse";
import { pool } from "../server/db";

// The seeded athlete these assertions are written against (score 512, the SEED
// brands, the analytics deltas) — any athlete seeded by scripts/seed-dev-athlete.ts.
// Named explicitly: npm run eval:mila -- --athlete <uuid>. Read-only.
const ATHLETE_ARG_INDEX = process.argv.indexOf("--athlete");
const TARGET_ATHLETE_ID = ATHLETE_ARG_INDEX >= 0 ? (process.argv[ATHLETE_ARG_INDEX + 1] ?? "") : "";
const GOLDEN_PATH = join(process.cwd(), "evals", "mila", "golden.jsonl");

// A token still holding a <PLACEHOLDER> hasn't been filled in (e.g. the
// injection probe's attacker address) — that entry can't gate until it is.
const PLACEHOLDER_RE = /<[A-Za-z0-9_]+>/;

interface GoldenEntry {
  id: string;
  prompt: string;
  expect_tools: string[];
  must_contain: string[];
  must_not_contain: string[];
}

type Status = "PASS" | "FAIL" | "NEEDS_INPUT";
interface Result {
  id: string;
  status: Status;
  tools: string[];
  reasons: string[];
}

// ─── Matching — fact-based, never sentence-based ───────────────────────────────
// Each token is a group of `|`-separated alternatives, matched case-insensitively
// as a substring. must_contain: every group must hit ≥1 alternative. This lets a
// reworded-but-correct answer pass ("12,000" | "12000" | "12k").
const alts = (group: string): string[] =>
  group
    .split("|")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);

const groupHit = (haystackLower: string, group: string): boolean =>
  alts(group).some((a) => haystackLower.includes(a));

const firstForbidden = (haystackLower: string, group: string): string | null =>
  alts(group).find((a) => haystackLower.includes(a)) ?? null;

/** A minimal SSEStream: the loop returns the final text directly, so tokens are
 *  discarded here. `signal` is a fresh, un-aborted controller so nothing in the
 *  loop early-returns; `closed` stays false. */
function makeStubSSE(): SSEStream {
  return {
    status: () => {},
    token: () => {},
    done: () => {},
    suggestions: () => {},
    profileUpdates: () => {},
    error: () => {},
    close: () => {},
    abort: () => {},
    signal: new AbortController().signal,
    closed: false,
  };
}

async function runEntry(entry: GoldenEntry): Promise<Result> {
  // Unfilled placeholder → the gate can't verify this entry; treat as a failure
  // (never a silent pass) with an actionable message.
  const placeholder = [...entry.must_contain, ...entry.must_not_contain]
    .map((t) => t.match(PLACEHOLDER_RE)?.[0])
    .find(Boolean);
  if (placeholder) {
    return {
      id: entry.id,
      status: "NEEDS_INPUT",
      tools: [],
      reasons: [
        `unfilled placeholder ${placeholder} — replace it in evals/mila/golden.jsonl before this entry can gate`,
      ],
    };
  }

  // Capture the tool trace by wrapping each tool's execute (name recorded on
  // call). Wrapping preserves name/description/argsSchema, so declarations and
  // arg validation are unchanged.
  const trace: string[] = [];
  const instrumented: MilaTool[] = milaTools.map((t) => ({
    ...t,
    execute: (athleteId, args) => {
      trace.push(t.name);
      return t.execute(athleteId, args);
    },
  }));

  let text = "";
  try {
    const res = await runMilaLoop(
      {
        athleteId: TARGET_ATHLETE_ID,
        message: entry.prompt,
        ephemeral: true,
        sse: makeStubSSE(),
      },
      instrumented,
    );
    text = res.text ?? "";
  } catch (err) {
    return {
      id: entry.id,
      status: "FAIL",
      tools: trace,
      reasons: [`loop threw: ${(err as Error).message}`],
    };
  }

  const reasons: string[] = [];
  const lower = text.toLowerCase();

  // Liveness: a correct answer is never empty.
  if (!text.trim()) reasons.push("empty answer");

  // expect_tools — each entry is a `|`-group; AT LEAST ONE of its alternatives
  // must appear in the trace (presence, not order; extra calls are fine). A
  // single-tool entry like "get_score" is just a one-alternative group; a group
  // like "get_deal|list_deals" accepts either valid grounding.
  const traceLower = trace.map((t) => t.toLowerCase());
  for (const group of entry.expect_tools) {
    const opts = alts(group);
    if (!opts.some((t) => traceLower.includes(t))) {
      reasons.push(
        `expected tool ${opts.map((t) => `"${t}"`).join(" or ")} not called (trace: ${trace.join(", ") || "none"})`,
      );
    }
  }

  // must_contain — the fact must be present, in any phrasing.
  for (const group of entry.must_contain) {
    if (!groupHit(lower, group)) reasons.push(`missing required: "${group}"`);
  }

  // must_not_contain — the defense: none of these may appear.
  for (const group of entry.must_not_contain) {
    const hit = firstForbidden(lower, group);
    if (hit) reasons.push(`contains forbidden: "${hit}"`);
  }

  return {
    id: entry.id,
    status: reasons.length ? "FAIL" : "PASS",
    tools: trace,
    reasons,
  };
}

function printTable(results: Result[]): void {
  const w = Math.max(4, ...results.map((r) => r.id.length));
  const mark = (s: Status) =>
    s === "PASS" ? "✓ PASS" : s === "NEEDS_INPUT" ? "⚠ INPUT" : "✗ FAIL";
  console.log(`\n${"ID".padEnd(w)}  RESULT   TOOLS CALLED`);
  console.log(`${"─".repeat(w)}  ───────  ───────────`);
  for (const r of results) {
    console.log(
      `${r.id.padEnd(w)}  ${mark(r.status).padEnd(7)}  ${r.tools.join(", ") || "—"}`,
    );
  }
}

async function main(): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(TARGET_ATHLETE_ID)) {
    throw new Error("usage: run-mila-eval.ts --athlete <uuid> (an athlete seeded by scripts/seed-dev-athlete.ts)");
  }
  const lines = readFileSync(GOLDEN_PATH, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const entries: GoldenEntry[] = lines.map((line, i) => {
    try {
      return JSON.parse(line) as GoldenEntry;
    } catch (err) {
      throw new Error(
        `golden.jsonl line ${i + 1}: invalid JSON — ${(err as Error).message}`,
      );
    }
  });

  console.log(
    `Running ${entries.length} golden evals against athlete ${TARGET_ATHLETE_ID} (read-only, real model calls)…`,
  );

  const results: Result[] = [];
  for (const entry of entries) {
    process.stdout.write(`  … ${entry.id}\n`);
    results.push(await runEntry(entry));
  }

  printTable(results);

  const failed = results.filter((r) => r.status !== "PASS");
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  if (failed.length) {
    console.log("\nFailures:");
    for (const r of failed) {
      console.log(`  ✗ ${r.id} [${r.status}]`);
      for (const reason of r.reasons) console.log(`      - ${reason}`);
    }
  }

  await pool.end();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await pool.end();
  } catch {
    // pool may not have opened; ignore.
  }
  process.exit(1);
});
