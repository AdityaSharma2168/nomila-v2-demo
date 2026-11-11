/**
 * costLog.test.ts — the harness's logging and report math, with no real generation anywhere.
 *
 * Two halves:
 *  - the pure aggregation, fed hand-written records with known costs and latencies, so the report
 *    arithmetic is asserted rather than eyeballed;
 *  - the round trip through a real temp file (append, read back, fold tags), plus the router
 *    instrumentation with fetch stubbed exactly as router.test.ts does it.
 *
 * The log path is redirected to os.tmpdir() for every test, so a run never writes into the repo.
 */
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  aggregate, emptyAttribution, formatReport, readLog, recordGeneration, tagGeneration, safeRef, toCostBasis,
  type GenerationRecord,
} from "./costLog";
import { generate } from "./router";

const ORIGINAL_ENV = { ...process.env };
let dir: string;
let logFile: string;
let fetchMock: jest.Mock;

const B64 = Buffer.from("fake-png-bytes").toString("base64");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "studio-cost-"));
  logFile = join(dir, "log.jsonl");
  process.env = { ...ORIGINAL_ENV, OPENROUTER_API_KEY: "test-key", STUDIO_COST_LOG: logFile };
  process.env.STUDIO_IMAGE_PROVIDER = "openrouter";
  process.env.STUDIO_IMAGE_EDIT_PROVIDER = "openrouter";
  process.env.STUDIO_VIDEO_PROVIDER = "openrouter";
  process.env.STUDIO_IMAGE_MODEL = "test/image-model";
  process.env.STUDIO_IMAGE_EDIT_MODEL = "test/image-model";
  process.env.STUDIO_VIDEO_MODEL = "test/video-model";
  process.env.STUDIO_PRICE_JSON = JSON.stringify({
    "test/image-model": { unit: "per_image", usd: 0.04 },
    "test/video-model": { unit: "per_second", usd: 0.4 },
  });
  fetchMock = jest.fn();
  global.fetch = fetchMock as any;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));
afterAll(() => { process.env = ORIGINAL_ENV; });

function queue(...bodies: unknown[]) {
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body, text: async () => "" } as any);
  }
}

/**
 * A completed video job is followed by the adapter's own AUTHENTICATED download of the clip, so a
 * video test queues one more response than it used to.
 *
 * ⚠️ QUEUE IT EXPLICITLY RATHER THAN LETTING THE MOCK RUN DRY. Without it `fetch` resolves
 * `undefined`, the adapter degrades to no-bytes, and the test still passes — green while silently
 * exercising the failure path and proving nothing about the success one.
 */
function queueClipDownload() {
  const clip = Buffer.from("fake-mp4-bytes");
  fetchMock.mockResolvedValueOnce({
    ok: true, status: 200,
    arrayBuffer: async () => clip.buffer.slice(clip.byteOffset, clip.byteOffset + clip.byteLength),
    json: async () => ({}), text: async () => "",
  } as any);
}

/** A hand-written record, so the aggregation is fed known numbers. */
function rec(over: Partial<GenerationRecord> = {}): GenerationRecord {
  return {
    kind: "generation",
    id: over.id ?? Math.random().toString(36).slice(2),
    timestamp: "2026-08-27T00:00:00.000Z",
    task: "image.edit",
    model: "nano",
    provider: "openrouter",
    inputRefs: { count: 1 },
    outputRef: null,
    cost: 0.1,
    costBasis: "authoritative",
    detail: null,
    latencyMs: 1000,
    qualityTag: null,
    ...emptyAttribution(),
    ...over,
  };
}

describe("aggregate — the report math", () => {
  it("counts, totals cost and gives avg/min/max latency per model per task", () => {
    const rows = aggregate([
      rec({ cost: 0.10, latencyMs: 1000 }),
      rec({ cost: 0.20, latencyMs: 3000 }),
      rec({ cost: 0.30, latencyMs: 2000 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model: "nano", task: "image.edit", provider: "openrouter",
      count: 3,
      costAuthoritative: 0.6,
      avgLatencyMs: 2000, minLatencyMs: 1000, maxLatencyMs: 3000,
    });
  });

  it("separates a model's tasks, and the same task across providers", () => {
    const rows = aggregate([
      rec({ task: "image.generate" }),
      rec({ task: "image.edit" }),
      rec({ task: "image.edit", provider: "vertex" }),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.task === "image.edit").map((r) => r.provider).sort()).toEqual(["openrouter", "vertex"]);
  });

  it("NEVER adds an estimated cost to a billed one, even within a group", () => {
    const rows = aggregate([
      rec({ cost: 1, costBasis: "authoritative" }),
      rec({ cost: 5, costBasis: "estimated" }),
    ]);
    expect(rows[0]).toMatchObject({
      count: 2,
      costAuthoritative: 1, countAuthoritative: 1,
      costEstimated: 5, countEstimated: 1,
    });
    // There is deliberately no combined total on the row.
    expect(rows[0]).not.toHaveProperty("costTotal");
  });

  it("tallies hand-written quality tags and counts what is still untagged", () => {
    const rows = aggregate([
      rec({ qualityTag: "identity held" }),
      rec({ qualityTag: "identity held" }),
      rec({ qualityTag: "drifted" }),
      rec({ qualityTag: null }),
    ]);
    expect(rows[0].qualityTags).toEqual({ "identity held": 2, drifted: 1 });
    expect(rows[0].untagged).toBe(1);
  });

  it("orders rows by how much each was used", () => {
    const rows = aggregate([
      rec({ model: "rare" }),
      rec({ model: "common" }), rec({ model: "common" }), rec({ model: "common" }),
    ]);
    expect(rows.map((r) => r.model)).toEqual(["common", "rare"]);
  });
});

describe("formatReport", () => {
  it("says so plainly when nothing has run", () => {
    expect(formatReport([])).toMatch(/No generations logged yet/);
  });

  it("marks estimated money with ~ and keeps the two totals apart", () => {
    const out = formatReport(aggregate([
      rec({ model: "veo", task: "video.generate", provider: "vertex", cost: 2.4, costBasis: "estimated", latencyMs: 42_000 }),
      rec({ model: "nano", cost: 0.037, costBasis: "authoritative", latencyMs: 6_000 }),
    ]));
    expect(out).toContain("$2.40~");
    expect(out).toContain("1 est");
    expect(out).toContain("1 billed");
    expect(out).toMatch(/billed \$0\.0370 - estimated \$2\.40~/);
    expect(out).toContain("never added together");
  });

  it("renders latency in seconds and the per-model quality tallies", () => {
    const out = formatReport(aggregate([rec({ latencyMs: 6500, qualityTag: "drifted" })]));
    expect(out).toContain("6.5s");
    expect(out).toContain("drifted x1");
  });
});

describe("safeRef — a signed url must never reach the log", () => {
  it("drops the query string, which is where a GCS signature lives", () => {
    expect(safeRef("https://storage.googleapis.com/bucket/a/b.jpg?X-Goog-Signature=deadbeef&X-Goog-Expires=900"))
      .toBe("https://storage.googleapis.com/bucket/a/b.jpg");
  });
  it("keeps a gs:// uri and tolerates a non-url", () => {
    expect(safeRef("gs://bucket/a/b.mp4")).toBe("gs://bucket/a/b.mp4");
    expect(safeRef("not a url?x=1")).toBe("not a url");
    expect(safeRef(null)).toBeNull();
  });
});

describe("basis vocabulary", () => {
  it("maps the adapters' words onto the harness's", () => {
    expect(toCostBasis("reported")).toBe("authoritative");
    expect(toCostBasis("estimated")).toBe("estimated");
  });
});

describe("file round trip", () => {
  it("appends one line per generation and reads them back", async () => {
    await recordGeneration({ ...rec({ cost: 0.5 }), timestamp: "2026-08-27T00:00:00.000Z" } as any);
    await recordGeneration({ ...rec({ cost: 0.25 }), timestamp: "2026-08-27T00:00:01.000Z" } as any);
    expect(readFileSync(logFile, "utf8").trim().split("\n")).toHaveLength(2);
    const back = await readLog(logFile);
    expect(back).toHaveLength(2);
    expect(back.map((r) => r.cost).sort()).toEqual([0.25, 0.5]);
  });

  it("folds a tag onto its generation without rewriting the original line", async () => {
    const id = await recordGeneration(rec() as any);
    await tagGeneration(id, "identity held", "eyes right, kit right");

    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);                                   // append-only
    expect(JSON.parse(lines[0]).qualityTag).toBeNull();              // original untouched

    const [folded] = await readLog(logFile);
    expect(folded.qualityTag).toBe("identity held");
  });

  it("lets a re-judgement win", async () => {
    const id = await recordGeneration(rec() as any);
    await tagGeneration(id, "drifted");
    await tagGeneration(id, "identity held");
    expect((await readLog(logFile))[0].qualityTag).toBe("identity held");
  });

  it("treats a missing log as empty, not an error", async () => {
    expect(await readLog(join(dir, "nope.jsonl"))).toEqual([]);
  });

  it("writes a tag to the SAME file it was told to, not to the default path", async () => {
    // Regression: the report script reads an explicit --log but tagGeneration wrote to
    // logPath(), so every hand-written tag silently vanished into a stray file.
    const other = join(dir, "explicit.jsonl");
    const id = await recordGeneration(rec() as any, other);
    await tagGeneration(id, "identity held", undefined, other);

    expect(existsSync(logFile)).toBe(false);                       // default path untouched
    expect((await readLog(other))[0].qualityTag).toBe("identity held");
  });

  it("skips a torn line rather than losing the whole report", async () => {
    await recordGeneration(rec({ cost: 1 }) as any);
    writeFileSync(logFile, `${readFileSync(logFile, "utf8")}{"kind":"generation","id":\n`, "utf8");
    await recordGeneration(rec({ cost: 2 }) as any);
    const back = await readLog(logFile);
    expect(back.map((r) => r.cost).sort()).toEqual([1, 2]);
  });
});

describe("the join keys — every line carries all six, null where the call site had none (PR 11, R-1)", () => {
  const KEYS = ["jobId", "previewId", "editPreviewId", "batchId", "promptVersion", "assetId"] as const;

  /** ⚠️ MUTATION "a cost line without a job id": drop `...attributionFor(attribution)` from recordGeneration. */
  it("a line written with no attribution still has every key, each null — never a missing key", async () => {
    await recordGeneration({
      task: "image.edit", model: "m", provider: "openrouter", inputRefs: { count: 0 },
      outputRef: null, cost: 0.01, costBasis: "estimated", detail: null, latencyMs: 1,
    }, logFile);
    const raw = JSON.parse(readFileSync(logFile, "utf8").trim());
    for (const k of KEYS) {
      expect(Object.prototype.hasOwnProperty.call(raw, k)).toBe(true);
      expect(raw[k]).toBeNull();
    }
  });

  it("a partial attribution is filled to the full key set, undefined written as null", async () => {
    await recordGeneration({
      task: "image.edit", model: "m", provider: "openrouter", inputRefs: { count: 0 },
      outputRef: null, cost: 0.01, costBasis: "estimated", detail: null, latencyMs: 1,
      attribution: { jobId: "job-1", editPreviewId: "edit-1" },
    }, logFile);
    const [r] = await readLog(logFile);
    expect(r).toMatchObject({
      jobId: "job-1", editPreviewId: "edit-1",
      previewId: null, batchId: null, promptVersion: null, assetId: null,
    });
  });

  it("the router carries a caller's attribution onto the line it writes", async () => {
    queue({ data: [{ b64_json: B64, media_type: "image/png" }], usage: { cost: 0.037 } });
    await generate("image.generate", { prompt: "x" }, {
      attribution: { jobId: "job-9", previewId: "prev-9", promptVersion: "interpret/6" },
    });
    const [r] = await readLog(logFile);
    expect(r).toMatchObject({
      jobId: "job-9", previewId: "prev-9", promptVersion: "interpret/6",
      editPreviewId: null, batchId: null, assetId: null,
    });
  });

  it("a line written before PR 11 still reads — the keys are simply absent, not an error", async () => {
    const old = { kind: "generation", id: "old-1", timestamp: "2026-09-01T00:00:00.000Z", task: "image.edit",
      model: "m", provider: "openrouter", inputRefs: { count: 1 }, outputRef: null, cost: 0.1,
      costBasis: "estimated", detail: null, latencyMs: 5, qualityTag: null };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(logFile, `${JSON.stringify(old)}\n`);
    const [r] = await readLog(logFile);
    expect(r.id).toBe("old-1");
    expect(r.jobId).toBeUndefined();
  });
});

describe("router instrumentation — every generate() is counted", () => {
  it("records a completed image generation with the provider's billed cost", async () => {
    queue({ data: [{ b64_json: B64, media_type: "image/png" }], usage: { cost: 0.037 } });

    await generate("image.generate", { prompt: "her, mid-stride" });

    const [r] = await readLog(logFile);
    expect(r).toMatchObject({
      task: "image.generate",
      model: "test/image-model",
      provider: "openrouter",
      cost: 0.037,
      costBasis: "authoritative",
      // How the number was reached, not just what it was — a cost line that cannot say where it came
      // from is what sent the U2 run digging. adapters/vertex.test.ts covers the case this exists
      // for: two "estimated" lines that only detail can tell apart.
      detail: "provider-reported usage.cost",
      inputRefs: { count: 0 },
      qualityTag: null,
    });
    expect(r.outputRef).toBe(`bytes:${Buffer.from("fake-png-bytes").byteLength}`);
    expect(typeof r.latencyMs).toBe("number");
  });

  it("carries an estimate through as estimated — a Vertex number is never shown as billed", async () => {
    queue({ data: [{ b64_json: B64, media_type: "image/png" }] });     // no usage.cost
    await generate("image.generate", { prompt: "x", n: 2 });
    const [r] = await readLog(logFile);
    expect(r.costBasis).toBe("estimated");
    expect(r.cost).toBeCloseTo(0.08);
    expect(r.detail).toBe("2 × $0.04/image");
  });

  it("logs the reference COUNT plus caller-supplied ids, never the signed urls themselves", async () => {
    queue({ data: [{ b64_json: B64, media_type: "image/png" }] });
    const signed = "https://storage.googleapis.com/b/a.jpg?X-Goog-Signature=secret";
    await generate(
      "image.edit",
      { prompt: "reframe", references: [{ kind: "url", url: signed }] },
      { refIds: ["asset-uuid-1"] },
    );
    const [r] = await readLog(logFile);
    expect(r.inputRefs).toEqual({ count: 1, ids: ["asset-uuid-1"] });
    expect(readFileSync(logFile, "utf8")).not.toContain("X-Goog-Signature");
  });

  it("stores a video output url with its query string stripped", async () => {
    queue(
      { id: "job-1", status: "pending" },
      { id: "job-1", status: "completed", unsigned_urls: ["https://openrouter.ai/api/v1/videos/job-1/content?index=0"], usage: { cost: 2.4 } },
    );
    queueClipDownload();
    await generate("video.generate", { prompt: "x", durationSeconds: 6 }, { pollIntervalMs: 1 });
    const [r] = await readLog(logFile);
    expect(r.outputRef).toBe("https://openrouter.ai/api/v1/videos/job-1/content");
    expect(r.cost).toBe(2.4);
  });

  it("does NOT log a dry run — no work happened and no money moved", async () => {
    await generate("image.generate", { prompt: "x" }, { dryRun: true });
    expect(existsSync(logFile)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does NOT log a failed generation — a throw costs nothing and would skew the averages", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" } as any);
    await expect(generate("image.generate", { prompt: "x" })).rejects.toThrow();
    expect(await readLog(logFile)).toEqual([]);
  });

  it("honours noLog", async () => {
    queue({ data: [{ b64_json: B64, media_type: "image/png" }] });
    await generate("image.generate", { prompt: "x" }, { noLog: true });
    expect(await readLog(logFile)).toEqual([]);
  });

  it("never fails a generation because the log could not be written", async () => {
    process.env.STUDIO_COST_LOG = join(dir, "no-such-dir", "log.jsonl");
    queue({ data: [{ b64_json: B64, media_type: "image/png" }], usage: { cost: 0.01 } });
    const res = await generate("image.generate", { prompt: "x" });
    expect(res.assets).toHaveLength(1);        // the caller still got what they paid for
  });

  it("produces a report end to end from real logged calls", async () => {
    queue(
      { data: [{ b64_json: B64, media_type: "image/png" }], usage: { cost: 0.04 } },
      { data: [{ b64_json: B64, media_type: "image/png" }], usage: { cost: 0.06 } },
    );
    await generate("image.generate", { prompt: "a" });
    await generate("image.generate", { prompt: "b" });

    const rows = aggregate(await readLog(logFile));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 2, countAuthoritative: 2, costAuthoritative: 0.1 });
    expect(formatReport(rows)).toContain("test/image-model");
  });
});
