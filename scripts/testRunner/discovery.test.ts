/**
 * Proves the under-discovery guard actually works — the property CI silently lacked
 * for years (a test file not on a hand-written list never ran). See discovery.ts for
 * the history; this file is the "write a test for this behaviour" acceptance criterion.
 */
import path from "node:path";
import {
  DEFAULT_ROOTS,
  areaForFile,
  assertCompletePartition,
  buildBatchPlan,
  chunkFiles,
  discoverTestFiles,
  partitionIntoBatches,
} from "./discovery";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

describe("assertCompletePartition (the under-discovery guard)", () => {
  it("does not throw when every discovered file is assigned exactly once", () => {
    const files = ["server/services/a.test.ts", "server/services/b.test.ts"];
    const batches = [{ name: "server/services", files: [...files] }];
    expect(() => assertCompletePartition(files, batches)).not.toThrow();
  });

  it("throws when a discovered file is missing from every batch (the real-world regression)", () => {
    const files = ["server/services/a.test.ts", "server/services/b.test.ts"];
    // Simulates exactly what hand-written CI lists did: silently drop a file.
    const batches = [{ name: "server/services", files: ["server/services/a.test.ts"] }];
    expect(() => assertCompletePartition(files, batches)).toThrow(/not assigned to any batch/i);
    expect(() => assertCompletePartition(files, batches)).toThrow(/server\/services\/b\.test\.ts/);
  });

  it("throws when a batch references a file discovery never found (stale entry)", () => {
    const files = ["server/services/a.test.ts"];
    const batches = [
      { name: "server/services", files: ["server/services/a.test.ts", "server/services/deleted.test.ts"] },
    ];
    expect(() => assertCompletePartition(files, batches)).toThrow(/not present in discovery/i);
  });

  it("throws when a file is double-counted across batches", () => {
    const files = ["server/services/a.test.ts"];
    const batches = [
      { name: "server/services#1", files: ["server/services/a.test.ts"] },
      { name: "server/services#2", files: ["server/services/a.test.ts"] },
    ];
    expect(() => assertCompletePartition(files, batches)).toThrow(/more than one batch/i);
  });
});

describe("areaForFile", () => {
  it("groups server/ files by their immediate subdirectory", () => {
    expect(areaForFile("server/services/foo.test.ts")).toBe("server/services");
    expect(areaForFile("server/services/intelligence/bar.test.ts")).toBe("server/services");
    expect(areaForFile("server/studio/composite.test.ts")).toBe("server/studio");
  });

  it("buckets loose server/*.test.ts files into their own area", () => {
    expect(areaForFile("server/migrationsGuard.test.ts")).toBe("server/(root)");
  });

  it("treats client/, scripts/, shared/ as single areas", () => {
    expect(areaForFile("client/lib/foo.test.ts")).toBe("client");
    expect(areaForFile("scripts/seed-injection-fixture.test.ts")).toBe("scripts");
    expect(areaForFile("shared/foo.test.ts")).toBe("shared");
  });

  it("throws for a file outside every known root", () => {
    expect(() => areaForFile("evals/foo.test.ts")).toThrow(/outside the known roots/i);
  });
});

describe("partitionIntoBatches", () => {
  it("splits an area exceeding the suite cap into ordered, deterministic chunks", () => {
    const files = Array.from({ length: 5 }, (_, i) => `server/services/f${i}.test.ts`);
    const batches = partitionIntoBatches(files, 2);
    expect(batches.map((b) => b.name)).toEqual(["server/services#1", "server/services#2", "server/services#3"]);
    expect(batches.flatMap((b) => b.files).sort()).toEqual([...files].sort());
    // No batch guard trip either.
    expect(() => assertCompletePartition(files, batches)).not.toThrow();
  });

  it("keeps an area under the cap as a single batch", () => {
    const files = ["server/mila/a.test.ts", "server/mila/b.test.ts"];
    const batches = partitionIntoBatches(files, 40);
    expect(batches).toEqual([{ name: "server/mila", files }]);
  });
});

describe("chunkFiles (suites per jest process within a batch)", () => {
  it("splits in order into runs of at most `size`, keeping every file exactly once", () => {
    const files = Array.from({ length: 10 }, (_, i) => `server/routes/f${i}.test.ts`);
    const chunks = chunkFiles(files, 4);
    expect(chunks.map((c) => c.length)).toEqual([4, 4, 2]);
    expect(chunks.flat()).toEqual(files);
  });

  it("returns a single run when the batch fits, or when chunking is disabled with 0", () => {
    const files = ["server/lib/a.test.ts", "server/lib/b.test.ts"];
    expect(chunkFiles(files, 8)).toEqual([files]);
    expect(chunkFiles(files, 0)).toEqual([files]);
    expect(chunkFiles([], 8)).toEqual([]);
  });
});

describe("real repo discovery + partition", () => {
  it("accounts for every *.test.ts file actually on disk (no file falls through)", () => {
    const { files, batches } = buildBatchPlan({ baseDir: REPO_ROOT });
    expect(files.length).toBeGreaterThan(250); // ~292 at time of writing; guards against a root disappearing
    expect(() => assertCompletePartition(files, batches)).not.toThrow();

    const batchFiles = new Set(batches.flatMap((b) => b.files));
    for (const f of files) {
      expect(batchFiles.has(f)).toBe(true);
    }
  });

  it("finds known files in the areas they're expected to be in", () => {
    const files = discoverTestFiles(DEFAULT_ROOTS, REPO_ROOT);
    expect(files).toContain("server/studio/composite.test.ts");
    expect(files).toContain("server/voice/dealRoutes.test.ts");
  });
});
