#!/usr/bin/env -S npx tsx
/**
 * run-tests.ts — the single test runner for both `npm test` and CI.
 *
 * WHY THIS EXISTS: CI used to run three Jest jobs, each with a hand-enumerated list of
 * test file paths. Any test file not manually added to one of those lists never ran —
 * that's how server/studio/composite.test.ts and server/voice/dealRoutes.test.ts sat on
 * main with 5 failing tests, invisible to CI, for an unknown amount of time. Meanwhile
 * `npm test` with everything in one Jest process (`--runInBand`) grew to 15.5 GB RSS
 * (8 GB heap ceiling) and hung with no output for 33+ minutes.
 *
 * This script fixes both by construction:
 *   1. Discovery is a filesystem glob (scripts/testRunner/discovery.ts) — never a list.
 *   2. Files are partitioned into batches by stable area (top-level dir under server/,
 *      plus client/scripts/shared), each capped at DEFAULT_SUITE_CAP suites.
 *   3. Every batch runs `jest --runInBand` in fresh child processes, DEFAULT_CHUNK_SIZE
 *      suites per process, so memory from one PGlite-heavy suite can't accumulate across
 *      a whole area — let alone into the next one.
 *   4. Before running anything, assertCompletePartition() throws if any discovered file
 *      isn't in exactly one batch — the guard that makes silent under-discovery
 *      impossible to reintroduce. This runs on every invocation, not just in --check.
 *
 * Usage:
 *   npm test                                # discover + run everything, batch by batch
 *   npm test -- --area server/services       # only batches under this area (any #chunk)
 *   npm test -- --batch server/studio        # exactly one batch (what CI's matrix uses)
 *   npm test -- --filter dealDetector         # only files whose path contains this substring
 *   npm test -- --check                      # discovery/partition only, no jest run
 *   npm test -- --list-batches               # print ["area", ...] JSON, for CI's matrix
 *   npm test -- --suite-cap 25                # override DEFAULT_SUITE_CAP
 *   npm test -- --chunk-size 8                # suites per jest process (0 = whole batch in one)
 *
 * Memory, revisited (17 Sep 2026): the "~5 GB per db-backed suite" that made server/routes
 * kill a 7 GB runner was ts-jest's in-process type-checker, not PGlite — see
 * tsconfig.jest.json (isolatedModules) and docs/audits/ci-test-harness-memory.md. A suite
 * now costs ~1 GB. What is left is retention: each suite's PGlite WASM memory outlives its
 * Jest module registry, so a process still grows per file — ~80 MB on macOS but 170–230 MB
 * on the Linux runner, where the 33-suite server/routes process peaked at 6,649 MB of 7,168
 * even after the ts-jest fix. Hence DEFAULT_CHUNK_SIZE: a batch runs as several short-lived
 * jest processes, which bounds any one process to ~1 GB + chunk × retention no matter how
 * large an area grows.
 *
 * Known pre-existing failures this runner will (correctly) surface, out of scope to fix
 * here: server/studio/composite.test.ts (1, pixel-diff), server/voice/dealRoutes.test.ts
 * (4, deal list returns empty), and an occasionally-flaky server/skills/archiveStaleDeals
 * .test.ts (initTestDb hook timeout under load; passes in isolation).
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Batch, DEFAULT_CHUNK_SIZE, DEFAULT_SUITE_CAP, buildBatchPlan, chunkFiles } from "./testRunner/discovery";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

interface CliArgs {
  area?: string;
  batch?: string;
  filters: string[];
  suiteCap: number;
  chunkSize: number;
  listBatches: boolean;
  check: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    filters: [],
    suiteCap: DEFAULT_SUITE_CAP,
    chunkSize: DEFAULT_CHUNK_SIZE,
    listBatches: false,
    check: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--area") args.area = argv[++i];
    else if (a === "--batch") args.batch = argv[++i];
    else if (a === "--suite-cap") args.suiteCap = Number(argv[++i]);
    else if (a === "--chunk-size") args.chunkSize = Number(argv[++i]);
    else if (a === "--list-batches") args.listBatches = true;
    else if (a === "--check" || a === "--dry-run") args.check = true;
    else if (a === "--filter") args.filters.push(argv[++i]);
    else if (a.startsWith("--")) continue; // unknown flag: ignore rather than hard-fail
    else args.filters.push(a); // bare positional arg == a path/substring filter
  }
  return args;
}

function selectBatches(batches: Batch[], args: CliArgs): Batch[] {
  let selected = batches;
  if (args.batch) {
    selected = selected.filter((b) => b.name === args.batch);
  } else if (args.area) {
    selected = selected.filter((b) => b.name === args.area || b.name.startsWith(`${args.area}#`));
  }
  if (args.filters.length) {
    selected = selected
      .map((b) => ({ name: b.name, files: b.files.filter((f) => args.filters.some((p) => f.includes(p))) }))
      .filter((b) => b.files.length > 0);
  }
  return selected;
}

function resolveJestBin(): string {
  const pkgJsonPath = require.resolve("jest/package.json");
  const pkg = require(pkgJsonPath) as { bin: string };
  return path.join(path.dirname(pkgJsonPath), pkg.bin);
}

interface BatchSummary {
  numTotalTestSuites: number;
  numPassedTestSuites: number;
  numFailedTestSuites: number;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
}

interface FailingSuite {
  file: string;
  failureMessages: string[];
}

interface BatchResult {
  name: string;
  fileCount: number;
  exitCode: number | null;
  durationMs: number;
  peakRssMB: number | null;
  summary?: BatchSummary;
  failingSuites: FailingSuite[];
  crashed: boolean;
  crashOutputTail?: string;
}

/**
 * Best-effort peak RSS for the child, polled from /proc/<pid>/status on Linux (where CI
 * runs, and where the 15.5 GB blowup was actually observed). VmHWM is the kernel's own
 * high-water mark for resident memory, so a ~1s poll is enough to catch it — we don't
 * need every sample, just to not miss the peak by more than a second. No-op (returns
 * null forever) on non-Linux platforms rather than pulling in a native dependency for it.
 */
function watchPeakRssMB(pid: number): { stop: () => number | null } {
  if (process.platform !== "linux") {
    return { stop: () => null };
  }
  let peakKB = 0;
  const timer = setInterval(() => {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const m = status.match(/VmHWM:\s+(\d+)\s+kB/);
      if (m) peakKB = Math.max(peakKB, parseInt(m[1], 10));
    } catch {
      // process may have already exited between the tick and the read; ignore.
    }
  }, 1000);
  timer.unref?.();
  return {
    stop: () => {
      clearInterval(timer);
      return peakKB > 0 ? peakKB / 1024 : null;
    },
  };
}

/** One jest process over `files`. Called once per chunk by runBatch. */
function runJest(name: string, files: string[], jestBin: string): Promise<BatchResult> {
  return new Promise((resolve) => {
    const safeName = name.replace(/[\\/#()]/g, "_");
    const outFile = path.join(os.tmpdir(), `run-tests-${process.pid}-${safeName}-${Date.now()}.json`);
    const args = [
      jestBin,
      "--config",
      "jest.config.cjs",
      "--runInBand",
      "--json",
      "--outputFile",
      outFile,
      "--runTestsByPath",
      ...files,
    ];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // 4096 on purpose — BELOW a standard 7 GB GitHub runner. An over-budget batch then dies
      // as a V8 "heap out of memory" with the last PASS line naming the suite it was in, instead
      // of the host killing the runner agent ("The runner has received a shutdown signal") with
      // no attribution at all. The largest batch (server/routes, 33 suites) peaks under 4 GB RSS
      // with ts-jest in transpile-only mode; a 3 GB ceiling was measured to survive it.
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--experimental-vm-modules --max-old-space-size=4096",
      LOG_LEVEL: process.env.LOG_LEVEL ?? "silent",
    };

    const start = Date.now();
    let tailBuf = "";

    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    const rssWatcher = child.pid ? watchPeakRssMB(child.pid) : { stop: () => null };

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      process.stdout.write(text);
      tailBuf = (tailBuf + text).slice(-8000);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("close", (code) => {
      const peakRssMB = rssWatcher.stop();
      const durationMs = Date.now() - start;
      let summary: BatchSummary | undefined;
      const failingSuites: FailingSuite[] = [];
      let crashed = false;

      try {
        const raw = fs.readFileSync(outFile, "utf8");
        const json = JSON.parse(raw);
        summary = {
          numTotalTestSuites: json.numTotalTestSuites,
          numPassedTestSuites: json.numPassedTestSuites,
          numFailedTestSuites: json.numFailedTestSuites,
          numTotalTests: json.numTotalTests,
          numPassedTests: json.numPassedTests,
          numFailedTests: json.numFailedTests,
        };
        for (const tr of json.testResults ?? []) {
          // Jest's --json schema names the per-assertion array `assertionResults`, NOT
          // `testResults` (that key only exists at the top level, one entry per suite).
          const failedAssertions = (tr.assertionResults ?? []).filter((t: any) => t.status === "failed");
          if (tr.status === "failed" || failedAssertions.length > 0) {
            failingSuites.push({
              file: path.relative(REPO_ROOT, tr.name).split(path.sep).join("/"),
              failureMessages:
                failedAssertions.length > 0
                  ? failedAssertions.map((t: any) => t.fullName || t.title || "unnamed test")
                  : [tr.message?.split("\n")[0] || "suite failed (no assertion detail)"],
            });
          }
        }
      } catch {
        crashed = true;
      } finally {
        try {
          fs.unlinkSync(outFile);
        } catch {
          // best-effort cleanup
        }
      }

      resolve({
        name,
        fileCount: files.length,
        exitCode: code,
        durationMs,
        peakRssMB,
        summary,
        failingSuites,
        crashed: crashed && code !== 0,
        crashOutputTail: crashed ? tailBuf : undefined,
      });
    });
  });
}

function fmtDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Fold per-chunk results into the one BatchResult the reporting below expects. */
function mergeChunkResults(batch: Batch, parts: BatchResult[]): BatchResult {
  const crashedPart = parts.find((p) => p.crashed);
  const summaries = parts.map((p) => p.summary).filter((s): s is BatchSummary => s !== undefined);
  const summary =
    summaries.length > 0
      ? summaries.reduce((acc, s) => ({
          numTotalTestSuites: acc.numTotalTestSuites + s.numTotalTestSuites,
          numPassedTestSuites: acc.numPassedTestSuites + s.numPassedTestSuites,
          numFailedTestSuites: acc.numFailedTestSuites + s.numFailedTestSuites,
          numTotalTests: acc.numTotalTests + s.numTotalTests,
          numPassedTests: acc.numPassedTests + s.numPassedTests,
          numFailedTests: acc.numFailedTests + s.numFailedTests,
        }))
      : undefined;
  return {
    name: batch.name,
    fileCount: batch.files.length,
    exitCode: parts.find((p) => (p.exitCode ?? 0) !== 0)?.exitCode ?? 0,
    durationMs: parts.reduce((a, p) => a + p.durationMs, 0),
    peakRssMB: parts.reduce<number | null>((a, p) => (p.peakRssMB === null ? a : Math.max(a ?? 0, p.peakRssMB)), null),
    summary,
    failingSuites: parts.flatMap((p) => p.failingSuites),
    crashed: crashedPart !== undefined,
    crashOutputTail: crashedPart?.crashOutputTail,
  };
}

/**
 * A batch = one CI job, but NOT one process: its files run in chunks of `chunkSize`, each
 * in a fresh jest process, so per-suite memory retention (see DEFAULT_CHUNK_SIZE) resets
 * every few suites instead of compounding across the whole area.
 */
async function runBatch(batch: Batch, jestBin: string, chunkSize: number): Promise<BatchResult> {
  const chunks = chunkFiles(batch.files, chunkSize);
  console.log(
    `\n▶ batch ${batch.name} — ${batch.files.length} suite(s), ${chunks.length} fresh process(es)` +
      (chunks.length > 1 ? ` of ≤${chunkSize}` : "")
  );
  const parts: BatchResult[] = [];
  for (const [i, files] of chunks.entries()) {
    const part = await runJest(`${batch.name}#chunk${i + 1}`, files, jestBin);
    parts.push(part);
    if (chunks.length > 1) {
      const rss = part.peakRssMB ? `, peak RSS ${part.peakRssMB.toFixed(0)} MB` : "";
      console.log(
        `  · chunk ${i + 1}/${chunks.length}: ${files.length} suite(s), ${fmtDuration(part.durationMs)}${rss}` +
          (part.crashed ? " — CRASHED" : "")
      );
    }
  }
  return mergeChunkResults(batch, parts);
}

function printBatchLine(r: BatchResult): void {
  if (r.crashed) {
    console.log(`✗ ${r.name}: CRASHED (exit ${r.exitCode}) after ${fmtDuration(r.durationMs)} — no JSON report produced`);
    return;
  }
  const s = r.summary!;
  const status = s.numFailedTests > 0 || s.numFailedTestSuites > 0 ? "FAIL" : "PASS";
  const rss = r.peakRssMB ? `, peak RSS ${r.peakRssMB.toFixed(0)} MB` : "";
  console.log(
    `${status === "PASS" ? "✓" : "✗"} ${r.name}: ${s.numTotalTestSuites} suite(s), ${s.numTotalTests} test(s), ` +
      `${s.numFailedTests} failed, ${fmtDuration(r.durationMs)}${rss}`
  );
}

function printFinalSummary(results: BatchResult[]): void {
  console.log("\n" + "=".repeat(72));
  console.log("FINAL SUMMARY");
  console.log("=".repeat(72));

  let totalSuites = 0;
  let totalTests = 0;
  let totalFailedTests = 0;
  const allFailingSuites: { batch: string; suite: FailingSuite }[] = [];
  const crashedBatches: string[] = [];

  for (const r of results) {
    if (r.crashed || !r.summary) {
      crashedBatches.push(r.name);
      continue;
    }
    totalSuites += r.summary.numTotalTestSuites;
    totalTests += r.summary.numTotalTests;
    totalFailedTests += r.summary.numFailedTests;
    for (const fs_ of r.failingSuites) allFailingSuites.push({ batch: r.name, suite: fs_ });
  }

  console.log(`Batches run: ${results.length}`);
  console.log(`Suites: ${totalSuites}  Tests: ${totalTests}  Failed tests: ${totalFailedTests}`);

  if (crashedBatches.length) {
    console.log(`\nCRASHED batches (no report — treat as failed): ${crashedBatches.join(", ")}`);
  }

  if (allFailingSuites.length) {
    console.log(`\nFailing suites (${allFailingSuites.length}):`);
    for (const { batch, suite } of allFailingSuites) {
      console.log(`  [${batch}] ${suite.file}`);
      for (const msg of suite.failureMessages) console.log(`      ✗ ${msg}`);
    }
  } else if (!crashedBatches.length) {
    console.log("\nAll suites passed.");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // buildBatchPlan runs the under-discovery guard unconditionally — if it throws, this
  // process dies with a non-zero exit before a single test runs. That's the point.
  const { files, batches } = buildBatchPlan({ baseDir: REPO_ROOT, suiteCap: args.suiteCap });
  // Goes to stderr, not stdout: --list-batches's stdout must be pure JSON so CI can pipe
  // it straight into a matrix (`fromJson(...)`) without scraping a human-readable line out.
  console.error(`Discovered ${files.length} test file(s) across ${batches.length} batch(es).`);

  if (args.listBatches) {
    // Plain array of batch names — this is what CI's discover job feeds to the test
    // job's `strategy.matrix.batch`, so each area (or split chunk) becomes its own job.
    console.log(JSON.stringify(batches.map((b) => b.name)));
    return;
  }

  const selected = selectBatches(batches, args);
  if (selected.length === 0) {
    console.error(
      `No batches matched the given filter (area=${args.area ?? "-"} batch=${args.batch ?? "-"} filters=${JSON.stringify(
        args.filters
      )}).`
    );
    process.exitCode = 1;
    return;
  }

  if (args.check) {
    for (const b of selected) console.log(`  ${b.name.padEnd(28)} ${b.files.length} suite(s)`);
    console.log("\n✓ discovery/partition check passed (guard did not trip).");
    return;
  }

  const jestBin = resolveJestBin();
  const results: BatchResult[] = [];
  for (const batch of selected) {
    const result = await runBatch(batch, jestBin, args.chunkSize);
    results.push(result);
    printBatchLine(result);
  }

  printFinalSummary(results);

  const anyFailed = results.some((r) => r.crashed || (r.exitCode ?? 0) !== 0);
  process.exitCode = anyFailed ? 1 : 0;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
