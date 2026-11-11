/**
 * qa/join — the joined row, against real SQL (PGlite), and the one thing it must never do: invent a
 * half that is not there.
 *
 * REVERT CHECKS, red by name:
 *   "join query invents a row when the job has no asset"  → synthesize an asset for an asset-less job
 *   tenancy                                                → drop `athlete_id` from any predicate
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initTestDb, closeTestDb } from "../../testUtils/pgliteDb";
import {
  athletes,
  generationJobs,
  mediaAssets,
  studioEditPreviews,
} from "../../../shared/schema";
import { recordGeneration } from "../costLog";
import { costLinesFor, joinRow, latestAcceptedEditId } from "./join";
import { writeVerdict } from "./record";
import type { CreativeQaVerdict } from "./verdict";

const HER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SOMEONE_ELSE = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

let logFile: string;

beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values([
    { id: HER, full_name: "Her" },
    { id: SOMEONE_ELSE, full_name: "Someone Else" },
  ] as never);
});
afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  // FK order: edit rows point at jobs and assets; jobs point at their source asset.
  await db.delete(studioEditPreviews);
  await db.delete(generationJobs);
  await db.delete(mediaAssets);
  logFile = join(mkdtempSync(join(tmpdir(), "join-")), "log.jsonl");
});

async function seedJob(
  athleteId: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  // The schema's own rule: an edit-mode job names its source (generation_jobs_edit_needs_source).
  const source =
    over.mode === "edit" && !over.source_asset_id
      ? await seedAsset(athleteId, { origin: "upload", platform: "upload" })
      : null;
  const [row] = await db
    .insert(generationJobs)
    .values({
      athlete_id: athleteId,
      origin: "system",
      mode: "generate",
      objective: "grow-following",
      deliverable: "post",
      brief: { job: { direction: { statement: "never printed" } } },
      status: "succeeded",
      provider: "vertex",
      model: "test-model",
      cost_estimated_usd: "0.1344",
      cost_basis: "estimated",
      ...(source ? { source_asset_id: source } : {}),
      ...over,
    } as never)
    .returning({ id: generationJobs.id });
  return row.id;
}

async function seedAsset(
  athleteId: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: athleteId,
      platform: "studio",
      origin: "generated",
      media_type: "IMAGE",
      status: "stored",
      approval_status: "draft",
      gcs_path: "athletes/x/out.png",
      ingested_at: new Date(),
      ...over,
    } as never)
    .returning({ id: mediaAssets.id });
  return row.id;
}

async function seedEdit(
  athleteId: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const source = await seedAsset(athleteId, {
    origin: "upload",
    platform: "upload",
  });
  const [row] = await db
    .insert(studioEditPreviews)
    .values({
      athlete_id: athleteId,
      source_asset_id: source,
      op: "recolour",
      params: { sentence: "x" },
      status: "accepted",
      cost_quoted_usd: "0.13",
      cost_usd: "0.1344",
      expires_at: new Date(Date.now() + 60_000),
      ...over,
    } as never)
    .returning({ id: studioEditPreviews.id });
  return row.id;
}

const VERDICT = {
  schemaVersion: 6,
  at: "2026-09-23T00:00:00.000Z",
  overall: "flag",
  unknownChecks: 0,
  advisoryChecks: [],
  checks: {},
  subject: "generate",
  spend: {
    usd: 0.01,
    basis: "estimated",
    visionCalls: 1,
    embedCalls: 0,
    inputTokens: 1,
    outputTokens: 1,
  },
  latencyMs: 1,
  comparison: {
    rootAssetId: "r",
    outputAssetId: "o",
    chainDepth: 0,
    chainTruncated: false,
  },
} as unknown as CreativeQaVerdict;

describe("walked from each id, every half is what is there", () => {
  it("from an accepted EDIT's asset: job, asset, edit row and verdict all found, joined", async () => {
    const jobId = await seedJob(HER, { mode: "edit" });
    const assetId = await seedAsset(HER, { generation_job_id: jobId });
    const editId = await seedEdit(HER, {
      job_id: jobId,
      accepted_asset_id: assetId,
    });
    await writeVerdict(assetId, HER, VERDICT);

    const row = await joinRow(HER, { assetId }, { logPath: logFile });
    expect(row.job?.id).toBe(jobId);
    expect(row.asset?.id).toBe(assetId);
    expect(row.asset?.generationJobId).toBe(jobId);
    expect(row.edit?.id).toBe(editId);
    expect(row.edit?.accepted_asset_id).toBe(assetId);
    expect(row.verdict?.overall).toBe("flag");
    expect(row.costLines).toEqual([]);
  });

  it("from the JOB: the same row; from the EDIT ROW: the same row", async () => {
    const jobId = await seedJob(HER, { mode: "edit" });
    const assetId = await seedAsset(HER, { generation_job_id: jobId });
    const editId = await seedEdit(HER, {
      job_id: jobId,
      accepted_asset_id: assetId,
    });

    const byJob = await joinRow(HER, { jobId }, { logPath: logFile });
    expect([byJob.job?.id, byJob.asset?.id, byJob.edit?.id]).toEqual([
      jobId,
      assetId,
      editId,
    ]);

    const byEdit = await joinRow(
      HER,
      { editPreviewId: editId },
      { logPath: logFile },
    );
    expect([byEdit.job?.id, byEdit.asset?.id, byEdit.edit?.id]).toEqual([
      jobId,
      assetId,
      editId,
    ]);
  });

  it("a GENERATE has no edit row, and says so", async () => {
    const jobId = await seedJob(HER);
    const assetId = await seedAsset(HER, { generation_job_id: jobId });
    const row = await joinRow(HER, { assetId }, { logPath: logFile });
    expect(row.job?.id).toBe(jobId);
    expect(row.edit).toBeNull();
    expect(row.verdict).toBeNull();
  });
});

describe("⚠️ it never invents a half", () => {
  /** ⚠️ MUTATION "join query invents a row when the job has no asset": return a placeholder asset for an asset-less job. */
  it("a job with no asset → asset null, verdict null, edit null — not a placeholder", async () => {
    const jobId = await seedJob(HER, { status: "failed" });
    const row = await joinRow(HER, { jobId }, { logPath: logFile });
    expect(row.job?.id).toBe(jobId);
    expect(row.asset).toBeNull();
    expect(row.verdict).toBeNull();
    expect(row.edit).toBeNull();
  });

  it("an id that does not exist → every half null", async () => {
    const row = await joinRow(
      HER,
      { assetId: "cccccccc-dddd-4eee-8fff-000000000000" },
      { logPath: logFile },
    );
    expect(row).toMatchObject({
      job: null,
      asset: null,
      edit: null,
      verdict: null,
      costLines: [],
    });
  });
});

describe("tenancy", () => {
  it("another athlete's asset, job and edit row are NOT FOUND, not joined", async () => {
    const jobId = await seedJob(SOMEONE_ELSE);
    const assetId = await seedAsset(SOMEONE_ELSE, { generation_job_id: jobId });
    const editId = await seedEdit(SOMEONE_ELSE, {
      job_id: jobId,
      accepted_asset_id: assetId,
    });

    expect(await joinRow(HER, { assetId }, { logPath: logFile })).toMatchObject(
      { job: null, asset: null, edit: null },
    );
    expect(await joinRow(HER, { jobId }, { logPath: logFile })).toMatchObject({
      job: null,
      asset: null,
      edit: null,
    });
    expect(
      await joinRow(HER, { editPreviewId: editId }, { logPath: logFile }),
    ).toMatchObject({ job: null, asset: null, edit: null });
  });

  it("her job never joins to someone else's asset, even one that names her job", async () => {
    const jobId = await seedJob(HER);
    // A row that should not exist — but if it did, it is not hers and must not appear.
    await seedAsset(SOMEONE_ELSE, { generation_job_id: jobId });
    const row = await joinRow(HER, { jobId }, { logPath: logFile });
    expect(row.job?.id).toBe(jobId);
    expect(row.asset).toBeNull();
  });
});

describe("the cost lines", () => {
  const line = (attribution: Record<string, string | null>) =>
    recordGeneration(
      {
        task: "image.edit",
        model: "m",
        provider: "openrouter",
        inputRefs: { count: 0 },
        outputRef: null,
        cost: 0.1,
        costBasis: "estimated",
        detail: null,
        latencyMs: 1,
        attribution,
      },
      logFile,
    );

  it("matches by job id, asset id or edit-row id; a line naming none of them never matches", async () => {
    const jobId = await seedJob(HER, { mode: "edit" });
    const assetId = await seedAsset(HER, { generation_job_id: jobId });
    const editId = await seedEdit(HER, {
      job_id: jobId,
      accepted_asset_id: assetId,
    });
    await line({ jobId });
    await line({ assetId });
    await line({ editPreviewId: editId });
    await line({ jobId: "some-other-job" });
    await line({});

    const row = await joinRow(HER, { assetId }, { logPath: logFile });
    expect(row.costLines).toHaveLength(3);
    expect(row.costLinesFrom).toBe(logFile);
  });

  it("a null key on the row matches nothing — a line with jobId null is not 'the job with no id'", () => {
    const lines = [
      { jobId: null, assetId: null, editPreviewId: null },
    ] as unknown as Parameters<typeof costLinesFor>[0];
    expect(
      costLinesFor(lines, { jobId: null, assetId: null, editPreviewId: null }),
    ).toEqual([]);
  });

  it("a missing log is no lines, not an error", async () => {
    const jobId = await seedJob(HER);
    const row = await joinRow(
      HER,
      { jobId },
      { logPath: join(tmpdir(), "no-such-join-log.jsonl") },
    );
    expect(row.costLines).toEqual([]);
  });
});

describe("her newest accepted edit (the script's --latest-edit)", () => {
  it("is the most recently decided ACCEPTED row under her, never a quoted or discarded one, never someone else's", async () => {
    const older = await seedEdit(HER, {
      decided_at: new Date(Date.now() - 60_000),
    });
    const newest = await seedEdit(HER, { decided_at: new Date() });
    await seedEdit(HER, {
      status: "discarded",
      decided_at: new Date(Date.now() + 60_000),
    });
    await seedEdit(SOMEONE_ELSE, {
      decided_at: new Date(Date.now() + 120_000),
    });
    expect(await latestAcceptedEditId(HER)).toBe(newest);
    expect(newest).not.toBe(older);
  });

  it("null when she has none", async () => {
    expect(await latestAcceptedEditId(HER)).toBeNull();
  });
});
