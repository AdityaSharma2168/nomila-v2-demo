/**
 * Test discovery + partitioning — the part of the test runner that decides WHICH
 * files exist and WHERE they run.
 *
 * This module is deliberately pure (no child_process, no jest invocation) so it can
 * be unit-tested cheaply in discovery.test.ts, which is what makes the under-discovery
 * guard (assertCompletePartition) something we can actually prove works rather than
 * just assert in a comment.
 *
 * History: CI used to enumerate ~40 test file paths by hand across three jobs. Any
 * test file not on one of those lists silently never ran — that is how two files with
 * five failing tests (server/studio/composite.test.ts, server/voice/dealRoutes.test.ts)
 * sat unnoticed on main. This module replaces "hand list" with "glob the filesystem,
 * then fail loudly if the partition doesn't account for every file it found."
 */
import fs from "node:fs";
import path from "node:path";

export interface Batch {
  /** Stable batch name, e.g. "server/services" or "server/services#2" once split. */
  name: string;
  /** Repo-relative, forward-slash test file paths belonging to this batch. */
  files: string[];
}

// Every top-level tree that can contain tests. Mirrors jest.config.cjs `roots`, plus
// `shared/` (currently empty of tests, kept so a future shared/*.test.ts isn't missed).
export const DEFAULT_ROOTS = ["server", "client", "scripts", "shared"];

// Matches jest.config.cjs's testMatch (["**/*.test.ts"]). Included .tsx defensively —
// there are none today, but a future RN component test shouldn't need this file touched.
const TEST_FILE_RE = /\.test\.tsx?$/;

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "server_dist",
  "coverage",
  ".expo",
  "android",
  "ios",
]);

// A suite count above which a single area is split into fixed-size, ordered chunks so
// no one batch grows without bound as an area's test count grows over time. This is a
// safety valve, NOT the primary partitioning mechanism — area is.
export const DEFAULT_SUITE_CAP = 40;

// Suites per jest PROCESS within a batch — distinct from DEFAULT_SUITE_CAP, which bounds a
// batch (= one CI job). A db-backed suite's PGlite WASM memory outlives its Jest module
// registry, so one long-lived process grows by ~170–230 MB per suite on a Linux runner even
// though every suite closes its database (33 routes suites in one process peaked at
// 6,649 MB of the runner's 7,168). Eight keeps a process near 3 GB; the price is one extra
// jest boot per chunk (~2–4 s with a warm transform cache).
export const DEFAULT_CHUNK_SIZE = 8;

/** Split a batch's files into runs of at most `size`; 0 (or less) means one run of everything. Order preserved. */
export function chunkFiles(files: string[], size: number = DEFAULT_CHUNK_SIZE): string[][] {
  if (files.length === 0) return [];
  if (size <= 0 || files.length <= size) return [files];
  const out: string[][] = [];
  for (let i = 0; i < files.length; i += size) out.push(files.slice(i, i + size));
  return out;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function walk(dir: string, baseDir: string, found: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, baseDir, found);
    } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      found.push(toPosix(path.relative(baseDir, full)));
    }
  }
}

/** Discover every test file under `roots`, relative to `baseDir`. Sorted, deterministic. */
export function discoverTestFiles(roots: string[] = DEFAULT_ROOTS, baseDir: string = process.cwd()): string[] {
  const found: string[] = [];
  for (const root of roots) {
    const abs = path.join(baseDir, root);
    if (!fs.existsSync(abs)) continue;
    walk(abs, baseDir, found);
  }
  return found.sort();
}

/**
 * The stable "area" a test file belongs to: the top-level root, plus its immediate
 * subdirectory for `server/` (that's where the memory-cost variance actually lives —
 * server/studio vs server/voice vs server/services behave very differently under
 * PGlite). A loose file directly under a root (e.g. server/migrationsGuard.test.ts)
 * gets its own "(root)" bucket rather than silently joining an unrelated area.
 */
export function areaForFile(relPath: string): string {
  const parts = relPath.split("/");
  const root = parts[0];
  if (root === "server") {
    return parts.length > 2 ? `server/${parts[1]}` : "server/(root)";
  }
  if (root === "client" || root === "scripts" || root === "shared") {
    return root;
  }
  throw new Error(
    `Cannot determine a test area for "${relPath}" — it is outside the known roots ` +
      `(${DEFAULT_ROOTS.join(", ")}). If this is a new root that legitimately holds tests, ` +
      `add it to DEFAULT_ROOTS in scripts/testRunner/discovery.ts.`
  );
}

/** Partition files into batches by area, splitting any area over `suiteCap` into ordered chunks. */
export function partitionIntoBatches(files: string[], suiteCap: number = DEFAULT_SUITE_CAP): Batch[] {
  const byArea = new Map<string, string[]>();
  for (const file of [...files].sort()) {
    const area = areaForFile(file);
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area)!.push(file);
  }

  const batches: Batch[] = [];
  for (const area of [...byArea.keys()].sort()) {
    const areaFiles = byArea.get(area)!;
    if (areaFiles.length <= suiteCap) {
      batches.push({ name: area, files: areaFiles });
      continue;
    }
    const chunkCount = Math.ceil(areaFiles.length / suiteCap);
    for (let i = 0; i < chunkCount; i++) {
      batches.push({ name: `${area}#${i + 1}`, files: areaFiles.slice(i * suiteCap, (i + 1) * suiteCap) });
    }
  }
  return batches;
}

/**
 * THE UNDER-DISCOVERY GUARD. Throws unless every discovered file is assigned to
 * exactly one batch and every batch file was actually discovered. This is what makes
 * it impossible to reintroduce "test file exists but nothing runs it" — a hand-edited
 * batch list, a typo'd exclusion, a partition bug that drops a file all trip this.
 */
export function assertCompletePartition(files: string[], batches: Batch[]): void {
  const fileSet = new Set(files);
  const seen = new Map<string, number>();
  for (const batch of batches) {
    for (const f of batch.files) {
      seen.set(f, (seen.get(f) ?? 0) + 1);
    }
  }

  const missing = files.filter((f) => !seen.has(f));
  const extra = [...seen.keys()].filter((f) => !fileSet.has(f));
  const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([f]) => f);

  if (missing.length || extra.length || duplicated.length) {
    const lines: string[] = [
      "FATAL: test discovery/partition mismatch (under-discovery guard tripped).",
      "A discovered test file would silently NOT run, or a batch references a file discovery didn't find.",
    ];
    if (missing.length) {
      lines.push(`\n${missing.length} discovered file(s) NOT assigned to any batch:`);
      for (const f of missing) lines.push(`  - ${f}`);
    }
    if (extra.length) {
      lines.push(`\n${extra.length} batch file(s) not present in discovery (stale/renamed?):`);
      for (const f of extra) lines.push(`  - ${f}`);
    }
    if (duplicated.length) {
      lines.push(`\n${duplicated.length} file(s) assigned to more than one batch:`);
      for (const f of duplicated) lines.push(`  - ${f}`);
    }
    throw new Error(lines.join("\n"));
  }
}

export interface BatchPlan {
  files: string[];
  batches: Batch[];
}

/** Discover, partition, and validate in one call. Throws if the guard trips. */
export function buildBatchPlan(
  options: { roots?: string[]; baseDir?: string; suiteCap?: number } = {}
): BatchPlan {
  const files = discoverTestFiles(options.roots, options.baseDir);
  const batches = partitionIntoBatches(files, options.suiteCap ?? DEFAULT_SUITE_CAP);
  assertCompletePartition(files, batches);
  return { files, batches };
}
