/**
 * marketabilityBeta1Orchestrator.test.ts — the decisions that cost money or change an athlete's score.
 *
 * The evaluator client and the params loader are mocked. That is the point of the split: the judgement path is frozen
 * and validated against the 37-athlete development cohort, so what needs proving HERE is the orchestration around it —
 * when we ask, when we refuse to ask, and which of two answers stands.
 *
 * The four properties:
 *   1. The snapshot is built when the work RUNS, not when it was scheduled.
 *   2. An unchanged digest does not pay for a provider call; a manual refresh deliberately does.
 *   3. A failed evaluation never blocks the retry and never supersedes a good result.
 *   4. Supersession compares EVIDENCE as-of, never completion time.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { athletes, intelligenceLedger, miaEvaluationRuns, miaEvidenceSnapshots } from "../../shared/schema";
import { eq } from "drizzle-orm";

const SUB_WEIGHTS = { social_presence: { follower_scale: 1.0 } };

/** Every call returns a usable response unless a test says otherwise. Counted, because a call is ~$0.21. */
const callEvaluator = jest.fn();
jest.mock("./marketabilityBeta1Evaluator", () => {
  const actual = jest.requireActual("./marketabilityBeta1Evaluator");
  return { ...actual, callEvaluator: (...args: any[]) => callEvaluator(...args) };
});

/** The social block the snapshot builder will see. Mutable, so a test can change the world mid-run. */
let socialBlockNow: string | null = "AUTHORITATIVE SOCIAL DATA\n\n- instagram @a — observed 2026-09-14; followers: 1,000";
/** Kept beside the block text on purpose: in the text the date is evaluator input, on the source it is the evidence age. */
let observedNow = "2026-09-14";
jest.mock("./marketabilityBeta1SocialBlock", () => ({
  connectedBlock: async () => [{ platform: "instagram", handle: "a", source: "connected_verified", observedAt: observedNow, followers: 1000 }],
  citedHandles: async () => [],
  discoveryBlock: async () => [],
  renderBlock: () => socialBlockNow ?? "",
}));

/**
 * Since 4 Nov 2026 M.I.A. evaluates only from facts in memory (the search-enabled evaluator is retired), so the test
 * athlete is a memory athlete and her snapshot is a facts-only block: the heading, then the same mutable social block,
 * with its one connected account as provenance (cited as "platform:instagram"). Orchestration is what is under test.
 */
let mockIsMemory = true;
jest.mock("./miaPreview/memoryAdapter", () => {
  const actual = jest.requireActual("./miaPreview/memoryAdapter");
  const { FACTS_HEADING } = jest.requireActual("./miaPreview/factsOnlySpec");
  const { snapshotDigest } = jest.requireActual("./marketabilityBeta1Snapshot");
  const { db: tdb } = jest.requireActual("../testUtils/pgliteDb");
  const { athletes: tAthletes } = jest.requireActual("../../shared/schema");
  const { eq: teq } = jest.requireActual("drizzle-orm");
  return {
    ...actual,
    isMemoryAthlete: async () => mockIsMemory,
    buildMemoryFactsSnapshot: async (athleteId: string, triggerReason: string, opts: { triggerDetail?: string | null; now?: Date } = {}) => {
      const [row] = await tdb.select().from(tAthletes).where(teq(tAthletes.id, athleteId)).limit(1);
      if (!row?.full_name || !row.sport) return null;
      const socialBlock = `${FACTS_HEADING}\n\n${socialBlockNow ?? ""}`;
      const now = opts.now ?? new Date();
      return {
        athleteId, name: row.full_name, sport: row.sport, socialBlock,
        socialSources: [{ platform: "instagram", accountId: "a", observedAt: observedNow, sourceClass: "connected_verified" }],
        evidenceAsOf: new Date(observedNow).toISOString(), digest: snapshotDigest({ name: row.full_name, sport: row.sport, socialBlock, evaluator: "facts" }),
        triggerReason, triggerDetail: opts.triggerDetail ?? null, builtAt: now.toISOString(),
        inputs: { publicFactIds: [], measuredFactIds: [], connectedPlatforms: ["instagram"] },
      };
    },
  };
});

let mockLastSource: string | null = null;
/** Frozen arithmetic is not under test here; a one-signal engine keeps the assertions about orchestration. */
jest.mock("./marketabilityBeta1Params", () => ({
  loadBeta1Params: async () => ({
    params: { version: "v1.0.1-beta.1", schemaVersion: "marketability-config/1", config: { subWeights: SUB_WEIGHTS } },
    bundle: {},
    versions: { marketability: "v1.0.1-beta.1", lookups: "l1", policy: "p1", cohorts: "c1", priors: "pr1", freshness: "f1" },
  }),
}));
jest.mock("./marketabilityBeta1Normalization", () => ({ createBeta1Normalizer: () => ({ prior: () => ({ key: "x", value: 50, confidence: 0.3, source: "imputed", evidenceIds: [], modelVersion: "prior", asOf: "2026-09-14", imputed: true }) }) }));
jest.mock("./marketabilityBeta1Freeze", () => ({
  BETA1_FREEZE_AS_OF: "2026-09-14T00:00:00.000Z",
  // The label the orchestrator derived for the one judgement (A2), captured so a test can read it.
  buildBeta1Dimensions: (j: any, _sport: string, _prior: unknown, _w: unknown, _asOf: string, sourceOf?: (x: any) => string) => {
    mockLastSource = sourceOf ? sourceOf(j.signals[0]) : "web_researched";
    return { social_presence: { follower_scale: { key: "social_presence.follower_scale", value: j.signals[0]?.score ?? 50, confidence: 0.9, source: mockLastSource, evidenceIds: [], modelVersion: "mia-evaluator", asOf: "2026-09-14", imputed: false } } };
  },
}));
jest.mock("./marketabilityBeta1", () => ({
  MARKETABILITY_BETA1_VERSION: "v1.0.1-beta.1",
  computeMarketabilityBeta1: (input: any) => {
    const value = input.dimensions.social_presence.follower_scale.value;
    return { score: Math.round(850 * Math.pow(value / 100, 0.8)), composite: value, potential: null, confidence: 80, dimensions: [], drivers: [], version: "v1.0.1-beta.1", asOf: input.asOf, provenance: { sourceMode: null, contextBuiltAt: null } };
  },
}));

import {
  buildAndPersistSnapshot, getMarketability, runEvaluation, scoreAndRecord,
} from "./marketabilityBeta1Orchestrator";

const response = (score: number) => ({
  model: "gemini-3.5-flash", modelVersion: "v1", responseId: "r1", latencyMs: 85_000,
  finishReason: "STOP", truncated: false,
  usage: { promptTokens: 4000, outputTokens: 3000, thoughtTokens: 2000, totalTokens: 9000, searchCalls: 6 },
  costUsd: 0.21, native: {},
  text: JSON.stringify({
    athlete: { identity_confidence: "HIGH" },
    dimensions: { social_presence: { follower_scale: { status: "scored", score, confidence: "HIGH", evidence_ids: ["platform:instagram"], rationale: "r" } } },
    marketability_summary: "A summary",
  }),
});

let athleteId: string;

beforeAll(async () => { await initTestDb(); }, 120_000);
afterAll(async () => { await closeTestDb(); });

beforeEach(async () => {
  callEvaluator.mockReset();
  callEvaluator.mockResolvedValue(response(70));
  socialBlockNow = "AUTHORITATIVE SOCIAL DATA\n\n- instagram @a — observed 2026-09-14; followers: 1,000";
  observedNow = "2026-09-14";
  athleteId = await seedAthlete("Orchestrated Athlete");
  await db.update(athletes).set({ sport: "Soccer" } as any).where(eq(athletes.id, athleteId));
});

describe("the snapshot is the evidence as it is NOW", () => {
  it("captures a change that landed after the run was scheduled", async () => {
    // The debounce exists to coalesce events, not to freeze evidence. A run scheduled at 10:00 that fires at 10:10
    // must see the 10:07 connect — evaluating the 10:00 world would knowingly spend a real call on stale input.
    const atSchedulingTime = await buildAndPersistSnapshot(athleteId, "SOCIAL_BLOCK_CHANGED");
    socialBlockNow = "AUTHORITATIVE SOCIAL DATA\n\n- instagram @a — observed 2026-09-14; followers: 1,000\n- youtube @a — observed 2026-09-14; subscribers: 4,000";
    const atExecutionTime = await buildAndPersistSnapshot(athleteId, "SOCIAL_BLOCK_CHANGED");

    expect(atExecutionTime!.digest).not.toBe(atSchedulingTime!.digest);
    const [row] = await db.select().from(miaEvidenceSnapshots).where(eq(miaEvidenceSnapshots.id, atExecutionTime!.snapshotId));
    expect(row.social_block).toContain("youtube");
  });

  it("records the trigger on the row and keeps it out of the digest", async () => {
    const a = await buildAndPersistSnapshot(athleteId, "IDENTITY_RESOLVED");
    const b = await buildAndPersistSnapshot(athleteId, "USER_REQUESTED_REFRESH");
    // Same evidence, different reason for looking: the same question, so the same digest.
    expect(b!.digest).toBe(a!.digest);
    const [row] = await db.select().from(miaEvidenceSnapshots).where(eq(miaEvidenceSnapshots.id, b!.snapshotId));
    expect(row.trigger_reason).toBe("USER_REQUESTED_REFRESH");
  });
});

describe("an unchanged digest does not pay for a provider call", () => {
  it("reports unchanged only after an evaluation actually succeeded", async () => {
    const first = await buildAndPersistSnapshot(athleteId, "IDENTITY_RESOLVED");
    // Nothing has been evaluated yet, so an identical digest is still an unanswered question.
    expect(first!.unchanged).toBe(false);
    const second = await buildAndPersistSnapshot(athleteId, "IDENTITY_RESOLVED");
    expect(second!.unchanged).toBe(false);

    await runEvaluation(first!.snapshotId);
    const third = await buildAndPersistSnapshot(athleteId, "IDENTITY_RESOLVED");
    expect(third!.unchanged).toBe(true);
  });

  it("does not let a FAILED evaluation suppress the retry", async () => {
    // Otherwise a single provider outage would freeze an athlete's score permanently, and the freeze would look like
    // a decision rather than an accident.
    const snap = await buildAndPersistSnapshot(athleteId, "IDENTITY_RESOLVED");
    // A REFUSAL (parsed, nothing scored) rather than prose: prose is now a parse failure and throws to be retried,
    // which is a different branch. What this test is about is that a failure does not mark the digest as answered.
    callEvaluator.mockResolvedValue({ ...response(70), text: JSON.stringify({ dimensions: { social_presence: { follower_scale: { status: "missing" } } } }) });
    const run = await runEvaluation(snap!.snapshotId);
    expect(run.status).toBe("failed_validation");

    const next = await buildAndPersistSnapshot(athleteId, "IDENTITY_RESOLVED");
    expect(next!.unchanged).toBe(false);
  });

  it("records a validation failure without a ledger entry", async () => {
    const snap = await buildAndPersistSnapshot(athleteId, "IDENTITY_RESOLVED");
    callEvaluator.mockResolvedValue({ ...response(70), text: JSON.stringify({ dimensions: { social_presence: { follower_scale: { status: "missing" } } } }) });
    const run = await runEvaluation(snap!.snapshotId);

    const [row] = await db.select().from(miaEvaluationRuns).where(eq(miaEvaluationRuns.id, run.runId));
    expect(row.status).toBe("failed_validation");
    expect(row.raw).toBeTruthy();          // the response is kept: it is the evidence of what went wrong
    expect(row.judgements).toBeNull();
    expect(await scoreAndRecord(run.runId)).toBeNull();
    expect(await getMarketability(athleteId)).toBeNull();
  });

  it("propagates a transport failure instead of recording it as an answer", async () => {
    const snap = await buildAndPersistSnapshot(athleteId, "IDENTITY_RESOLVED");
    callEvaluator.mockRejectedValue(new Error("504 upstream timeout"));
    await expect(runEvaluation(snap!.snapshotId)).rejects.toThrow(/504/);
    // A timeout is worth retrying — it is a new sample of a non-deterministic evaluator, not a repeat.
    expect(await db.select().from(miaEvaluationRuns).where(eq(miaEvaluationRuns.athlete_id, athleteId))).toHaveLength(0);
  });
});

describe("each scored judgement is labelled by what it cites (A2)", () => {
  const citing = (ids: string[], evidence: unknown[]) => ({
    ...response(70),
    text: JSON.stringify({
      athlete: { identity_confidence: "HIGH" },
      dimensions: { social_presence: { follower_scale: { status: "scored", score: 70, confidence: "HIGH", evidence_ids: ids, rationale: "r" } } },
      evidence,
      marketability_summary: "A summary",
    }),
  });
  const labelFor = async (answer: ReturnType<typeof citing>) => {
    callEvaluator.mockResolvedValue(answer);
    mockLastSource = null;
    const snap = await buildAndPersistSnapshot(athleteId, "SOCIAL_BLOCK_CHANGED");
    await scoreAndRecord((await runEvaluation(snap!.snapshotId)).runId);
    return mockLastSource;
  };
  it("citing the connected-account block is connected_verified; a citation that is not a supplied fact is never scored", async () => {
    expect(await labelFor(citing(["platform:instagram"], [{ id: "platform:instagram", claim: "@a has 1,000 Instagram followers", source_type: "platform" }]))).toBe("connected_verified");
    // Facts-only (the only evaluator since 4 Nov 2026): an id that is not in the snapshot is dropped, the signal is
    // missing, nothing is scored, and no score is recorded (no label is ever derived).
    expect(await labelFor(citing(["e1"], [{ id: "e1", claim: "Profiled in a regional paper", source_url: "https://news.example/a" }]))).toBeNull();
  });
});

describe("M.I.A. never searches (4 Nov 2026)", () => {
  afterEach(() => { mockIsMemory = true; });
  it("an athlete with no memory facts gets no snapshot and no provider call: nothing to score from yet", async () => {
    mockIsMemory = false;
    expect(await buildAndPersistSnapshot(athleteId, "IDENTITY_RESOLVED")).toBeNull();
    expect(callEvaluator).not.toHaveBeenCalled();
    expect(await db.select().from(miaEvidenceSnapshots).where(eq(miaEvidenceSnapshots.athlete_id, athleteId))).toHaveLength(0);
  });
  it("a snapshot built for the retired search-enabled evaluator is refused without a call", async () => {
    const [row] = await db.insert(miaEvidenceSnapshots).values({ athlete_id: athleteId, name: "Orchestrated Athlete", sport: "Soccer", social_block: "AUTHORITATIVE SOCIAL DATA", social_sources: [] as any, evidence_as_of: new Date(), digest: "legacy", trigger_reason: "IDENTITY_RESOLVED", built_at: new Date() } as any).returning({ id: miaEvidenceSnapshots.id });
    await expect(runEvaluation(row.id)).rejects.toThrow(/retired search-enabled evaluator/);
    expect(callEvaluator).not.toHaveBeenCalled();
  });
});

describe("which result stands", () => {
  async function evaluate(): Promise<string> {
    const snap = await buildAndPersistSnapshot(athleteId, "SOCIAL_BLOCK_CHANGED");
    const run = await runEvaluation(snap!.snapshotId);
    return run.runId;
  }

  it("records an assessment and reads it back as the score of record", async () => {
    const scored = await scoreAndRecord(await evaluate());
    expect(scored!.becameCurrent).toBe(true);

    const current = await getMarketability(athleteId);
    expect(current!.score).toBe(scored!.score);
    expect(current!.versions.evaluator).toBeTruthy();
    expect(current!.versions.methodology).toBe("v1.0.1-beta.1+facts.1");
    // Additive (Concept 0.4 Slice 2): the row's own id and write time, so a reader needs no ledger query of its own.
    expect(current!.entryId).toBe(scored!.ledgerId);
    expect(new Date(current!.createdAt).toISOString()).toBe(current!.createdAt);
  });

  // Kept from the retired golden-path file (its frozen-cohort equivalence went with the search-enabled path): the reader
  // serves the winning entry as stored, and the provenance chain ledger → run → snapshot → digest holds on facts-only.
  it("serves exactly the winning ledger entry and records the provenance chain: ledger → run → snapshot → digest", async () => {
    const runId = await evaluate();
    await scoreAndRecord(runId);
    const current = await getMarketability(athleteId);
    const [entry] = await db.select().from(intelligenceLedger).where(eq(intelligenceLedger.evaluation_run_id, runId));
    expect(current!.value).toEqual(entry.value);
    expect(current!.evidenceAsOf).toBe(entry.evidence_as_of.toISOString());
    expect(current!.versions).toEqual(entry.versions);
    expect(current!.confidenceBand).toBeNull();
    expect(entry.superseded_by).toBeNull();

    const [run] = await db.select().from(miaEvaluationRuns).where(eq(miaEvaluationRuns.id, runId));
    const [snap] = await db.select().from(miaEvidenceSnapshots).where(eq(miaEvidenceSnapshots.id, run.snapshot_id));
    expect(run.status).toBe("ok");
    expect(run.judgements_digest).toBeTruthy();
    expect(snap.digest).toBeTruthy();
    // Marketability consumes no upstream intelligence (ADR-011): inputs and assumptions stay empty.
    expect(entry.inputs).toEqual([]);
    expect(entry.assumptions).toEqual([]);
    expect(current!.versions.evaluator).toBe(run.evaluator_version);
  });

  it("returns null for an athlete who has never been assessed — not a zero", async () => {
    // A zero is a judgement about someone. No assessment is the absence of one, and callers must be able to tell.
    expect(await getMarketability(await seedAthlete("Unassessed"))).toBeNull();
  });

  it("supersedes on newer evidence", async () => {
    const first = await scoreAndRecord(await evaluate());
    socialBlockNow = "AUTHORITATIVE SOCIAL DATA\n\n- instagram @a — observed 2026-09-20; followers: 9,000";
    observedNow = "2026-09-20";
    callEvaluator.mockResolvedValue(response(90));
    const second = await scoreAndRecord(await evaluate());

    expect(second!.becameCurrent).toBe(true);
    expect((await getMarketability(athleteId))!.score).toBe(second!.score);
    const [old] = await db.select().from(intelligenceLedger).where(eq(intelligenceLedger.id, first!.ledgerId));
    expect(old.superseded_by).toBe(second!.ledgerId);
  });

  it("does NOT let an older-evidence result overwrite a newer one that finished first", async () => {
    // Jobs finish out of order: a retried run started at 10:00 can land after a clean run started at 10:20. The late
    // result is still recorded — it is what we believed, and the call was already paid for — but it arrives already
    // superseded rather than replacing a better-informed assessment.
    socialBlockNow = "AUTHORITATIVE SOCIAL DATA\n\n- instagram @a — observed 2026-09-20; followers: 9,000";
    observedNow = "2026-09-20";
    const newer = await scoreAndRecord(await evaluate());

    socialBlockNow = "AUTHORITATIVE SOCIAL DATA\n\n- instagram @a — observed 2026-09-01; followers: 500";
    observedNow = "2026-09-01";
    callEvaluator.mockResolvedValue(response(20));
    const late = await scoreAndRecord(await evaluate());

    expect(late!.becameCurrent).toBe(false);
    expect((await getMarketability(athleteId))!.score).toBe(newer!.score);
    const [row] = await db.select().from(intelligenceLedger).where(eq(intelligenceLedger.id, late!.ledgerId));
    expect(row.superseded_by).toBe(newer!.ledgerId);
  });

  it("lets a manual refresh on identical evidence stand as the new answer", async () => {
    // Same supplied evidence, fresh grounded research. The point of asking again is to stand on the new answer, so a
    // tie on evidence date breaks toward the one that arrived later.
    const first = await scoreAndRecord(await evaluate());
    callEvaluator.mockResolvedValue(response(85));
    const refreshed = await scoreAndRecord(await evaluate());

    expect(refreshed!.becameCurrent).toBe(true);
    expect(refreshed!.score).not.toBe(first!.score);
    expect((await getMarketability(athleteId))!.score).toBe(refreshed!.score);
  });
});

describe("the score step survives being run twice", () => {
  it("files ONE assessment per evaluation run, however many times the step retries", async () => {
    // The runner's contract is explicitly at-least-once: "a step may run twice. Check before writing, or key writes
    // so a repeat is a no-op." Without the guard, a lease expiry or a transient error after the insert files a second
    // assessment for the same run — identical numbers, duplicated history, and the duplicate superseding the
    // original, which would make an athlete's history read as though their score had moved when nothing happened.
    const snap = await buildAndPersistSnapshot(athleteId, "SOCIAL_BLOCK_CHANGED");
    const run = await runEvaluation(snap!.snapshotId);

    const first = await scoreAndRecord(run.runId);
    const repeat = await scoreAndRecord(run.runId);

    expect(repeat!.ledgerId).toBe(first!.ledgerId);
    expect(repeat!.score).toBe(first!.score);
    expect(repeat!.becameCurrent).toBe(first!.becameCurrent);

    const entries = await db.select().from(intelligenceLedger).where(eq(intelligenceLedger.subject_id, athleteId));
    expect(entries).toHaveLength(1);
    expect(entries[0].superseded_by).toBeNull();
  });

  it("reports a repeat of an already-superseded entry as not current", async () => {
    // A retry must report what is TRUE now, not what was true when the entry was first written.
    observedNow = "2026-09-01";
    socialBlockNow = "AUTHORITATIVE SOCIAL DATA\n\n- instagram @a — observed 2026-09-01; followers: 500";
    const oldSnap = await buildAndPersistSnapshot(athleteId, "SOCIAL_BLOCK_CHANGED");
    const oldRun = await runEvaluation(oldSnap!.snapshotId);
    await scoreAndRecord(oldRun.runId);

    observedNow = "2026-09-20";
    socialBlockNow = "AUTHORITATIVE SOCIAL DATA\n\n- instagram @a — observed 2026-09-20; followers: 9,000";
    const newSnap = await buildAndPersistSnapshot(athleteId, "SOCIAL_BLOCK_CHANGED");
    const newRun = await runEvaluation(newSnap!.snapshotId);
    await scoreAndRecord(newRun.runId);

    // The older entry has since been superseded; re-running its step says so rather than claiming currency.
    expect((await scoreAndRecord(oldRun.runId))!.becameCurrent).toBe(false);
    expect(await db.select().from(intelligenceLedger).where(eq(intelligenceLedger.subject_id, athleteId))).toHaveLength(2);
  });
});

describe("a formatting accident is retried; a refusal is not", () => {
  /**
   * The cohort run cost a real athlete an assessment through this. Jimmer Fredette's response was COMPLETE —
   * finishReason STOP, not truncated, 26KB, properly closed fence — and contained `"rationale": His narrat…`, one
   * missing opening quote. The old classification called every unusable response permanent, reasoning that "the
   * model would produce it again". True of a refusal; false of a formatting slip against a stochastic model.
   */
  it("THROWS on malformed JSON, so the step's bounded retry asks again", async () => {
    const snap = await buildAndPersistSnapshot(athleteId, "IDENTITY_RESOLVED");
    callEvaluator.mockResolvedValue({ ...response(70), text: '{"dimensions": {"social_presence": {"follower_scale": {"status":"scored","score":70,"rationale": Unquoted}}}}' });

    await expect(runEvaluation(snap!.snapshotId)).rejects.toThrow(/JSON did not parse/);

    // The attempt is still RECORDED before the throw — a retry is a new sample, not a repeat, and each one has to be
    // countable if the parse-failure rate is ever to be measured rather than guessed.
    const [run] = await db.select().from(miaEvaluationRuns).where(eq(miaEvaluationRuns.athlete_id, athleteId));
    expect(run.status).toBe("failed_parse");
    expect(run.raw).toBeTruthy();
    expect(run.judgements).toBeNull();
  });

  it("RETURNS on a parsed-but-empty response, so no retry is attempted", async () => {
    // The evaluator read the question and scored nothing. Asking again buys the same refusal at ~$0.21.
    const snap = await buildAndPersistSnapshot(athleteId, "IDENTITY_RESOLVED");
    callEvaluator.mockResolvedValue({ ...response(70), text: JSON.stringify({ dimensions: { social_presence: { follower_scale: { status: "missing" } } } }) });

    const run = await runEvaluation(snap!.snapshotId);
    expect(run.status).toBe("failed_validation");

    const [row] = await db.select().from(miaEvaluationRuns).where(eq(miaEvaluationRuns.id, run.runId));
    expect(row.status).toBe("failed_validation");
  });

  it("neither class writes a ledger entry — a partial assessment is worse than none", async () => {
    const snap = await buildAndPersistSnapshot(athleteId, "IDENTITY_RESOLVED");
    callEvaluator.mockResolvedValue({ ...response(70), text: JSON.stringify({ dimensions: { social_presence: { follower_scale: { status: "missing" } } } }) });
    const run = await runEvaluation(snap!.snapshotId);
    expect(await scoreAndRecord(run.runId)).toBeNull();
    expect(await getMarketability(athleteId)).toBeNull();
  });

  it("a retried parse failure that later succeeds produces a normal assessment", async () => {
    // What the fix is FOR: the second sample is well-formed and the athlete gets the assessment the first attempt
    // lost. Recorded as two runs against one snapshot, which is exactly what a retry is.
    const snap = await buildAndPersistSnapshot(athleteId, "IDENTITY_RESOLVED");
    callEvaluator.mockResolvedValueOnce({ ...response(70), text: '{"dimensions": {"x": Unquoted}}' });
    await expect(runEvaluation(snap!.snapshotId, 1)).rejects.toThrow();

    callEvaluator.mockResolvedValue(response(70));
    const retry = await runEvaluation(snap!.snapshotId, 2);
    expect(retry.status).toBe("ok");
    const scored = await scoreAndRecord(retry.runId);
    expect(scored).not.toBeNull();

    const runs = await db.select().from(miaEvaluationRuns).where(eq(miaEvaluationRuns.snapshot_id, snap!.snapshotId));
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.status).sort()).toEqual(["failed_parse", "ok"]);
  });
});
