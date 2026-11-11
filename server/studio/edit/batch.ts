/**
 * studio/edit/batch — the ad carousel's batch (PR 9, Lane 4): one itemized quote for 1–3 references, her
 * Create tap as the consent, the work in the background under an ATOMIC claim, and downloads as the only
 * library writes.
 *
 * ─── THE ROWS ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * A batch is a set of studio_edit_previews rows sharing `batch_id`, every one under its own quote (the same
 * machine every edit uses). Per reference: an optional STAGE-A row (`params.role = "intermediate"` — the
 * grounded cleanup rec's op) and N STAGE-B rows (`params.stage = "B"`, `params.after = <A row id>`) — the ad
 * op. The quote answers per-ref lines and a total BEFORE anything runs. ⚠️ MUTATION (batch.test): queue a row
 * whose quote was never consumed — "run starts without the itemized quote" reds by name.
 *
 * ─── ONE OWNER PER JOB (Adi's rider 1: the stitch-tick double-fire) ─────────────────────────────────────
 *
 * Create queues the rows' jobs and KICKS the tick in-process; the scheduler's tick sweeps whatever a kick
 * missed. Both go through `claimEditJobs`: UPDATE … WHERE status = 'queued' AND mode = 'edit' … FOR UPDATE
 * SKIP LOCKED — one claimer wins, the other finds nothing. The video tick claims `mode <> 'edit'`, so the
 * two ticks never meet. ⚠️ MUTATION: drop the status predicate from the claim — "kick and tick both run the
 * same job" reds by name.
 *
 * ─── STAGE B READS STAGE A, AND A IS NEVER KEPT ─────────────────────────────────────────────────────────
 *
 * A stage-B row waits (deferred, back to the queue) until its A row is `ready`, then runs the ad op with A's
 * preview object as the frame (`executeEdit`'s sourceOverride) while its own `source_asset_id` stays the
 * ORIGINAL reference — so derived_from at download names the original. `params.chain = {cleanup: <A id>}`
 * records the stage. An A row is discarded (object deleted) once its B rows are ready and no re-roll can
 * still need it, or once every B row is decided; `acceptEdit` refuses it at all times. ⚠️ MUTATION: accept an
 * intermediate — "intermediate persists as a library row" reds by name.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { db } from "../../db";
import { createLogger } from "../../logger";
import {
  generationJobs,
  studioEditPreviews,
  type GenerationJob,
  type StudioEditPreview,
  type StudioEditPreviewStatus,
} from "../../../shared/schema";
import { clearLease, leaseMs, queueJob } from "../videoJobs";
import { createGenerationJob, failJob } from "../jobs";
import { consumePreview, loadPreview } from "../previewStore";
import {
  acceptEdit,
  discardEdit,
  executeEdit,
  prepareRun,
  presentEdit,
  quoteEdit,
  type EditRefusal,
} from "./engine";
import { groundRecs, type Rec } from "./recommend";
import { advance, listEditPreviews, readEditPreview } from "./previews";

const logger = createLogger("studio/edit/batch");

export const MAX_REFS = 3;
export const MAX_INITIAL_CANDIDATES = 3;
export const MAX_CANDIDATES = 4;
export const EDIT_RUNNER_ID = `edit-${hostname()}-${randomUUID().slice(0, 8)}`;
const DEFAULT_TICK_BATCH = Number(process.env.STUDIO_EDIT_TICK_BATCH ?? 4);

const refuse = (
  status: EditRefusal["status"],
  error: string,
  field?: string,
): EditRefusal => ({
  ok: false,
  status,
  error,
  ...(field ? { field } : {}),
});

export interface BatchRefInput {
  assetId: string;
  /** How many ads from this reference, 1–3. The total across refs is ≤ 3. */
  variations: number;
  /** A recommendation for this reference, as the popover showed it — re-grounded here, or refused. */
  cleanup: Rec | null;
}

export interface QuoteBatchInput {
  athleteId: string;
  refs: BatchRefInput[];
  brand: string;
  campaign?: { product?: string; story?: string; goal?: string };
  headline?: string;
  /** Her setting — required (Adi, 23 Sep 2026); the first variation is set there, the others elsewhere. */
  setting: string;
  instruction?: string;
  /** The brief's lines the cleanup rec must re-ground against — the same lines the popover read. */
  briefLines: string[];
  brandId?: number | null;
}

export interface BatchLine {
  assetId: string;
  cleanup: { id: string; op: string; costUsd: number | null } | null;
  ads: { id: string; costUsd: number | null }[];
}

export interface BatchQuote {
  batchId: string;
  lines: BatchLine[];
  totalUsd: number;
  unpriced: boolean;
}

/**
 * THE THREE ADS DIFFER (Adi, 23 Sep 2026): one prompt three times returned near-twins, so each variation
 * takes its own setting — hers on the first when she gave one, then settings from this list she did not,
 * in order. Every line routes as a CHANGE_BACKGROUND value (route-checked, ≤ 40 characters).
 */
export const VARIATION_SETTINGS: readonly string[] = [
  "stadium pitch at dusk",
  "empty studio with dramatic light",
  "city street at night",
  "training ground at golden hour",
  "packed stadium under floodlights",
  "white studio with soft shadows",
];

/** The setting for variation `i` (0-based): hers first when given, then the list minus hers. */
export function settingForVariation(
  hers: string | null | undefined,
  i: number,
): string {
  const own = hers?.trim() || null;
  const rest = VARIATION_SETTINGS.filter((v) => v !== own);
  if (own) return i === 0 ? own : rest[(i - 1) % rest.length];
  return rest[i % rest.length];
}

const meta = (row: StudioEditPreview) =>
  (row.params ?? {}) as Record<string, unknown>;
const isIntermediate = (row: StudioEditPreview) =>
  meta(row).role === "intermediate";
const afterOf = (row: StudioEditPreview): string | null =>
  typeof meta(row).after === "string" ? (meta(row).after as string) : null;
const candidates = (rows: StudioEditPreview[]) =>
  rows.filter((r) => !isIntermediate(r));

// ─── quote ──────────────────────────────────────────────────────────────────────────────────────────────

export async function quoteBatch(
  input: QuoteBatchInput,
): Promise<({ ok: true } & BatchQuote) | EditRefusal> {
  if (!input.refs.length) return refuse(400, "Add at least one photo.", "refs");
  // ⚠️ MUTATION (batch.test): accept a 4th — "a 4th reference accepted" reds by name.
  if (input.refs.length > MAX_REFS)
    return refuse(400, `Up to ${MAX_REFS} photos — remove one.`, "refs");
  const total = input.refs.reduce((s, r) => s + r.variations, 0);
  if (
    input.refs.some(
      (r) =>
        !Number.isInteger(r.variations) ||
        r.variations < 1 ||
        r.variations > MAX_INITIAL_CANDIDATES,
    )
  )
    return refuse(400, "Each photo makes 1 to 3 ads.", "refs");
  if (total > MAX_INITIAL_CANDIDATES)
    return refuse(
      400,
      `Up to ${MAX_INITIAL_CANDIDATES} ads in one go — fewer per photo, or fewer photos.`,
      "refs",
    );
  const ids = new Set(input.refs.map((r) => r.assetId));
  if (ids.size !== input.refs.length)
    return refuse(400, "The same photo is listed twice.", "refs");

  const batchId = randomUUID();
  const lines: BatchLine[] = [];
  let totalUsd = 0;
  let unpriced = false;
  const made: string[] = [];
  const adParamsFor = (variation: number) => ({
    brand: input.brand,
    ...(input.headline ? { headline: input.headline } : {}),
    setting: settingForVariation(input.setting, variation),
    ...(input.campaign ? { campaign: input.campaign } : {}),
    ...(input.instruction ? { instruction: input.instruction } : {}),
  });

  const bail = async (r: EditRefusal): Promise<EditRefusal> => {
    // Nothing half-quoted survives: the rows made so far are discarded (quotes expire on their own).
    for (const id of made)
      await discardEdit({ athleteId: input.athleteId, id }).catch(
        () => undefined,
      );
    return r;
  };

  for (const ref of input.refs) {
    let cleanupRow: StudioEditPreview | null = null;
    let cleanupCost: number | null = null;
    if (ref.cleanup) {
      // The rec is re-grounded HERE, against the same lines, through the same check the popover's pass ran.
      // ⚠️ MUTATION: skip it — "cleanup runs on a ref with no grounded rec" reds by name.
      const grounded = groundRecs({ recs: [ref.cleanup] }, input.briefLines);
      const rec = grounded.recs[0];
      if (!rec)
        return bail(
          refuse(
            422,
            "That clean-up isn't grounded in the brief, so it can't be part of the quote.",
            "refs",
          ),
        );
      const q = await quoteEdit({
        athleteId: input.athleteId,
        sourceAssetId: ref.assetId,
        op: rec.op,
        params: rec.params,
        brandId: input.brandId ?? null,
        batchId,
        meta: { role: "intermediate", because: rec.because },
      });
      if (!q.ok) return bail(q);
      cleanupRow = q.row;
      cleanupCost = q.quote.costUsd;
      made.push(q.row.id);
      totalUsd += q.quote.costUsd ?? 0;
      unpriced = unpriced || q.quote.unpriced;
    }
    const ads: BatchLine["ads"] = [];
    for (let i = 0; i < ref.variations; i++) {
      const q = await quoteEdit({
        athleteId: input.athleteId,
        sourceAssetId: ref.assetId,
        op: "ad",
        params: adParamsFor(i),
        brandId: input.brandId ?? null,
        batchId,
        meta: {
          stage: "B",
          ...(cleanupRow ? { after: cleanupRow.id } : {}),
          variation: i + 1,
        },
      });
      if (!q.ok) return bail(q);
      ads.push({ id: q.row.id, costUsd: q.quote.costUsd });
      made.push(q.row.id);
      totalUsd += q.quote.costUsd ?? 0;
      unpriced = unpriced || q.quote.unpriced;
    }
    lines.push({
      assetId: ref.assetId,
      cleanup: cleanupRow
        ? { id: cleanupRow.id, op: cleanupRow.op, costUsd: cleanupCost }
        : null,
      ads,
    });
  }
  logger.info(
    {
      athleteId: input.athleteId,
      batchId,
      refs: input.refs.length,
      rows: made.length,
      totalUsd,
      unpriced,
    },
    "carousel batch quoted",
  );
  return {
    ok: true,
    batchId,
    lines,
    totalUsd: Math.round(totalUsd * 10000) / 10000,
    unpriced,
  };
}

// ─── run: her Create tap ────────────────────────────────────────────────────────────────────────────────

/**
 * Consumes every row's quote and queues its job — all rows checked first, so a batch runs whole or not at
 * all — then kicks the tick. Returns as soon as the rows are queued; no model call happens here.
 * ⚠️ MUTATION (batch.test): await the tick here — "Create blocks the screen until completion" reds by name.
 */
export async function runBatch(input: {
  athleteId: string;
  batchId: string;
  kick?: boolean;
}): Promise<{ ok: true; queued: number } | EditRefusal> {
  const rows = await listEditPreviews(input.athleteId, {
    batchId: input.batchId,
    limit: 50,
  });
  // Oldest row first: a reference's A row was quoted before its B rows, so its job is created first and the
  // tick — which claims oldest-first — runs A before any B looks for it. Order is the chain's only clock.
  const pending = rows
    .filter((r) => r.status === "quoted" && !r.job_id)
    .sort((x, y) => x.created_at.getTime() - y.created_at.getTime());
  if (!rows.length) return refuse(404, "We couldn't find that batch.");
  if (!pending.length) return refuse(409, "This batch is already running.");

  const prepared: { row: StudioEditPreview; job: GenerationJob }[] = [];
  for (const row of pending) {
    const prep = await prepareRun(input.athleteId, row.id);
    if (!prep.ok) return prep;
    const job = await createGenerationJob(prep.prepared.preview);
    const claim = await consumePreview(
      input.athleteId,
      row.preview_id!,
      job.id,
    );
    if (!claim.claimed) {
      await failJob(job.id, input.athleteId, "The quote was already spent.");
      return refuse(409, "This batch's quote was already spent.");
    }
    if (!(await queueJob(job.id, input.athleteId))) {
      await failJob(job.id, input.athleteId, "The job could not be queued.");
      return refuse(409, "This batch could not start.");
    }
    await db
      .update(studioEditPreviews)
      .set({ job_id: job.id })
      .where(
        and(
          eq(studioEditPreviews.id, row.id),
          eq(studioEditPreviews.athlete_id, input.athleteId),
        ),
      );
    prepared.push({ row, job });
  }
  logger.info(
    {
      athleteId: input.athleteId,
      batchId: input.batchId,
      queued: prepared.length,
    },
    "carousel batch queued",
  );
  if (input.kick !== false) kickEditTick();
  return { ok: true, queued: prepared.length };
}

/** The in-process kick: the same tick the scheduler runs, started and not awaited. Errors are logged, never thrown. */
export function kickEditTick(): void {
  void editTick().catch((err) =>
    logger.warn({ err }, "edit tick (kick) failed"),
  );
}

// ─── the tick ───────────────────────────────────────────────────────────────────────────────────────────

/** The atomic claim: queued edit jobs only, oldest first, one winner per row. Mirrors claimVideoJobs. */
export async function claimEditJobs(
  limit: number,
  holder: string,
): Promise<GenerationJob[]> {
  const now = new Date();
  const until = new Date(now.getTime() + leaseMs());
  const res = await db.execute(sql`
    UPDATE generation_jobs
       SET status = 'running',
           lease_until = ${until},
           lease_holder = ${holder},
           attempts = attempts + 1,
           started_at = COALESCE(started_at, ${now}),
           updated_at = ${now}
     WHERE id IN (
       SELECT id FROM generation_jobs
        WHERE status = 'queued'
          AND mode = 'edit'
        ORDER BY created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
     RETURNING id`);
  const out = res as unknown as { rows?: { id: string }[] } | { id: string }[];
  const ids = (Array.isArray(out) ? out : (out.rows ?? [])).map((r) => r.id);
  if (!ids.length) return [];
  // Worked oldest-first, as claimed: a reference's A job precedes its B jobs, and the order the rows are
  // handed back is the order they run — a select without ORDER BY once worked a B before its A.
  return db
    .select()
    .from(generationJobs)
    .where(inArray(generationJobs.id, ids))
    .orderBy(asc(generationJobs.created_at), asc(generationJobs.id));
}

export type EditJobOutcome = "succeeded" | "failed" | "deferred" | "orphaned";

export interface EditTickResult {
  claimed: number;
  succeeded: number;
  failed: number;
  deferred: number;
  orphaned: number;
}

/** Back to the queue, the attempt not counted: a wait is not a try. */
async function deferJob(job: GenerationJob): Promise<void> {
  await db
    .update(generationJobs)
    .set({
      status: "queued",
      attempts: Math.max(0, job.attempts - 1),
      updated_at: new Date(),
    })
    .where(eq(generationJobs.id, job.id));
  await clearLease(job.id);
}

async function rowForJob(
  job: GenerationJob,
): Promise<StudioEditPreview | null> {
  const [row] = await db
    .select()
    .from(studioEditPreviews)
    .where(
      and(
        eq(studioEditPreviews.job_id, job.id),
        eq(studioEditPreviews.athlete_id, job.athlete_id),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function workEditJob(job: GenerationJob): Promise<EditJobOutcome> {
  const athleteId = job.athlete_id;
  const row = await rowForJob(job);
  if (!row) {
    await failJob(job.id, athleteId, "No edit row for this job.");
    return "orphaned";
  }
  // Stage B waits for its A.
  let override: { ref: string; width: number; height: number } | undefined;
  const after = afterOf(row);
  if (after) {
    const a = await readEditPreview(athleteId, after);
    if (!a || a.status === "failed" || a.status === "discarded") {
      const why = a
        ? `The clean-up step ${a.status}.`
        : "The clean-up step is gone.";
      await failJob(job.id, athleteId, why);
      await advance(
        athleteId,
        row.id,
        row.status as StudioEditPreviewStatus,
        "failed",
        { error: why },
      );
      return "failed";
    }
    if (a.status !== "ready" || !a.gcs_path || !a.width || !a.height) {
      await deferJob(job);
      return "deferred";
    }
    override = { ref: a.gcs_path, width: a.width, height: a.height };
  }
  if (
    !(await advance(athleteId, row.id, "quoted", "running", {
      ran_at: new Date(),
    }))
  ) {
    // Already running elsewhere (a claim that should not have happened) — stand down without spending.
    await clearLease(job.id);
    return "deferred";
  }
  const stored = row.preview_id
    ? await loadPreview(athleteId, row.preview_id)
    : null;
  if (!stored) {
    const why = "The quote behind this row is gone.";
    await failJob(job.id, athleteId, why);
    await advance(athleteId, row.id, "running", "failed", { error: why });
    return "failed";
  }
  try {
    if (override) {
      await db
        .update(studioEditPreviews)
        .set({ params: { ...meta(row), chain: { cleanup: after } } })
        .where(eq(studioEditPreviews.id, row.id));
    }
    await executeEdit(athleteId, row, stored.brief, job, {
      sourceOverride: override,
    });
    if (row.batch_id) await sweepIntermediates(athleteId, row.batch_id);
    return "succeeded";
  } catch {
    return "failed"; // executeEdit already failed the job and the row
  }
}

export async function editTick(
  limit = DEFAULT_TICK_BATCH,
): Promise<EditTickResult> {
  const jobs = await claimEditJobs(limit, EDIT_RUNNER_ID);
  const tally: EditTickResult = {
    claimed: jobs.length,
    succeeded: 0,
    failed: 0,
    deferred: 0,
    orphaned: 0,
  };
  for (const job of jobs) tally[await workEditJob(job)]++;
  if (jobs.length)
    logger.info({ holder: EDIT_RUNNER_ID, ...tally }, "edit tick");
  return tally;
}

/**
 * An intermediate goes once nothing can still need it: every B row after it is at least ready AND either
 * the batch can take no more candidates (a re-roll would need A) or every B row is decided.
 */
export async function sweepIntermediates(
  athleteId: string,
  batchId: string,
): Promise<number> {
  const rows = await listEditPreviews(athleteId, { batchId, limit: 50 });
  const full = candidates(rows).length >= MAX_CANDIDATES;
  let swept = 0;
  for (const a of rows.filter(
    (r) => isIntermediate(r) && (r.status === "ready" || r.status === "quoted"),
  )) {
    const bs = rows.filter((r) => afterOf(r) === a.id);
    if (!bs.length) continue;
    const settled = (s: string) =>
      s === "ready" || s === "accepted" || s === "discarded" || s === "failed";
    const decided = (s: string) =>
      s === "accepted" || s === "discarded" || s === "failed";
    if (!bs.every((b) => settled(b.status))) continue;
    if (!(full || bs.every((b) => decided(b.status)))) continue;
    const out = await discardEdit({ athleteId, id: a.id });
    if (out.ok) swept++;
  }
  return swept;
}

// ─── reroll · accept-all · view ─────────────────────────────────────────────────────────────────────────

/** ONE more ad from one of the batch's references, quoted afresh — never past four candidates. */
export async function rerollBatch(input: {
  athleteId: string;
  batchId: string;
  assetId: string;
}): Promise<
  | ({ ok: true } & { id: string; costUsd: number | null; unpriced: boolean })
  | EditRefusal
> {
  const rows = await listEditPreviews(input.athleteId, {
    batchId: input.batchId,
    limit: 50,
  });
  if (!rows.length) return refuse(404, "We couldn't find that batch.");
  // ⚠️ MUTATION (batch.test): drop this cap — "candidate or stage count exceeds the quote" reds by name.
  if (candidates(rows).length >= MAX_CANDIDATES)
    return refuse(
      409,
      "That's the one extra — four is the most one carousel makes.",
    );
  const sibling = candidates(rows).find(
    (r) => r.source_asset_id === input.assetId,
  );
  if (!sibling) return refuse(404, "That photo isn't in this carousel.");
  const m = meta(sibling);
  const params: Record<string, unknown> = {};
  for (const k of ["brand", "headline", "campaign", "instruction"])
    if (m[k] !== undefined) params[k] = m[k];
  // A different setting from every sibling's, so the extra is not a twin either.
  const used = new Set(
    candidates(rows).map((r) => String(meta(r).setting ?? "")),
  );
  params.setting =
    VARIATION_SETTINGS.find((v) => !used.has(v)) ??
    settingForVariation(null, candidates(rows).length);
  const a = afterOf(sibling)
    ? await readEditPreview(input.athleteId, afterOf(sibling)!)
    : null;
  const canChain = !!a && a.status === "ready";
  const q = await quoteEdit({
    athleteId: input.athleteId,
    sourceAssetId: input.assetId,
    op: "ad",
    params,
    batchId: input.batchId,
    meta: { stage: "B", reroll: true, ...(canChain ? { after: a!.id } : {}) },
  });
  if (!q.ok) return q;
  return {
    ok: true,
    id: q.row.id,
    costUsd: q.quote.costUsd,
    unpriced: q.quote.unpriced,
  };
}

/** Every ready candidate kept — the discarded skipped, the intermediates never. Answers the assets. */
export async function acceptAllBatch(input: {
  athleteId: string;
  batchId: string;
}): Promise<{ ok: true; assetIds: string[]; skipped: number } | EditRefusal> {
  const rows = await listEditPreviews(input.athleteId, {
    batchId: input.batchId,
    limit: 50,
  });
  if (!rows.length) return refuse(404, "We couldn't find that batch.");
  const assetIds: string[] = [];
  let skipped = 0;
  for (const r of candidates(rows)) {
    // ⚠️ MUTATION (batch.test): include the discarded — "download-all includes a discarded frame" reds by name.
    if (r.status !== "ready") {
      if (r.status === "discarded") skipped++;
      continue;
    }
    const out = await acceptEdit({ athleteId: input.athleteId, id: r.id });
    if (out.ok) assetIds.push(out.assetId);
  }
  if (input.batchId) await sweepIntermediates(input.athleteId, input.batchId);
  return { ok: true, assetIds, skipped };
}

export async function batchView(athleteId: string, batchId: string) {
  const rows = await listEditPreviews(athleteId, { batchId, limit: 50 });
  const presented = await Promise.all(rows.map(presentEdit));
  return {
    batchId,
    candidates: presented.filter((_, i) => !isIntermediate(rows[i])),
    intermediates: presented
      .filter((_, i) => isIntermediate(rows[i]))
      .map((p) => ({
        id: p.id,
        status: p.status,
        sourceAssetId: p.sourceAssetId,
      })),
    running: rows.some(
      (r) =>
        !isIntermediate(r) && (r.status === "quoted" || r.status === "running"),
    ),
    canReroll:
      candidates(rows).length < MAX_CANDIDATES &&
      rows.some((r) => !isIntermediate(r) && r.status === "ready"),
  };
}
