/**
 * studio/videoRunner — the consumer for detached video jobs.
 *
 * `POST /studio/generate` queues a video job and returns; this works it. One tick is:
 *
 *   reap expired leases · claim ≤ N queued · for each: submit-once or resume-poll · store · close
 *
 * The same shape server/workflow/runner.ts uses, and for the same reason: queued rows ARE the queue,
 * the tick is the consumer, SKIP LOCKED is the mutex. No broker, no worker process, no framework.
 *
 * ─── WHAT MAKES THIS DIFFERENT FROM THE WORKFLOW RUNNER ─────────────────────────────────────────
 *
 * Every step of a workflow can be re-run; that is what its retry policy assumes. A step here COSTS
 * MONEY and is not re-runnable, so this runner never retries a provider call. When it takes over a
 * job that already has an operation handle it RESUMES POLLING that operation — the Veo job is still
 * running at Vertex whether or not our instance survived, so re-submitting would buy a second copy
 * of a video already paid for. studio/videoJobs.ts holds the guards; this file holds the order they
 * are called in.
 *
 * ─── TENANCY ────────────────────────────────────────────────────────────────────────────────────
 *
 * This is a system consumer over every athlete's jobs, so the claim is not athlete-scoped — see the
 * note in studio/videoJobs.ts. The athlete for each job is read OFF THE CLAIMED ROW and used for
 * every subsequent write. No request, client or model supplies it, and nothing here accepts one.
 */
import { randomUUID } from "crypto";
import { hostname } from "os";
import {
  previewGeneration,
  plannedInputs,
  type PreviewOptions,
} from "./preview";
import {
  resolveStoredReference,
  storeAsset,
  studioObjectBase,
} from "./generate";
import { failJob, recordGeneratedAsset, succeedJob } from "./jobs";
import { creativeQaEnabled } from "./qa/record";
import { frameForClip } from "./video/firstFrame";
import {
  claimVideoJobs,
  clearLease,
  clearOperationName,
  notePoll,
  recordOperationName,
  recordSubmitAttempt,
  reapExpiredLeases,
  renewLease,
} from "./videoJobs";
import { resolve } from "./router";
import { recordGeneration, safeRef } from "./costLog";
import {
  clipQcEnabled,
  outputGateEnabled,
  promptRegistryEnabled,
  retryEnabled,
  vertexModelFor,
  videoPoll,
} from "./config";
import {
  checkStructureBytes,
  clipExpectation,
  unmeasured,
  writeStructure,
} from "./video/structure";
import { recordGate, templateOf } from "./outputGate";
import { recordScore } from "./templateScore";
import { isRetryableRefusal } from "./refusal";
import { createLogger } from "../logger";
import {
  GenerationError,
  type GenerationInputs,
  type ImageRef,
  type ProviderName,
  type ShotType,
} from "./types";
import type { CreativeBrief } from "../studio/brief";
import type { GenerationJob } from "../../shared/schema";

const logger = createLogger("studio/videoRunner");

/**
 * Who this process is, for the lease. Stable for the life of the instance and unique across
 * instances — the hostname alone is not (Cloud Run reuses it), so a random suffix is appended.
 * Only ever compared for equality; nothing parses it.
 */
export const RUNNER_ID = `${hostname()}-${randomUUID().slice(0, 8)}`;

const DEFAULT_BATCH = Number(process.env.STUDIO_VIDEO_TICK_BATCH ?? 2);

export interface VideoTickResult {
  reaped: { orphaned: number; exhausted: number; requeued: number };
  claimed: number;
  succeeded: number;
  failed: number;
  /** Still running at the provider — this tick ran out of poll budget, the next one resumes. */
  deferred: number;
  /** Not ours any more; another runner holds the lease. Nothing was spent. */
  stoodDown: number;
}

/**
 * Rebuild what to send from the job's FROZEN brief — never from a request, and never from anything
 * the client can still influence between the approval and the call.
 *
 * This is the same `plannedInputs` the preview used, so the job that runs is the job that was
 * quoted. It is re-derived rather than stored because a stored copy is a second source of truth that
 * can disagree with the brief it came from.
 */
function inputsFor(job: GenerationJob): {
  inputs: GenerationInputs;
  brief: CreativeBrief;
  opts: PreviewOptions;
  /**
   * DESCRIPTIVE, NOT AUTHORITATIVE — the same distinction this file makes about the provider. The
   * ROUTE is read off the row, because config answers "what would we do now" and the row answers
   * "what did we commit to then". This is re-derived from the frozen brief and is used only to
   * LABEL the re-roll record, so a surface can say what kind of segment it would be re-rolling.
   * Nothing is dispatched on it.
   */
  shotType: ShotType | null;
  /** The template the prompt compiled from (quality-scrappy piece 4) — what the gate's log line counts by. */
  templateKey: string | null;
} {
  const brief = job.brief as unknown as CreativeBrief;
  // ⚠️ NO OPTIONS, SO ONLY WHAT IS ON THE BRIEF SURVIVES TO HERE. This comment used to say duration
  // and audio were "already baked into the brief" — neither was: both rode on PreviewOptions, so a
  // clip quoted at 8s ran at the 4s default. BOTH are on the brief now — `durationSeconds` and
  // `audio` — which is what lets sound double the Veo rate and still arrive: `plannedInputs` reads
  // the frozen brief, so the arm quoted is the arm this line submits. Anything per-clip must be
  // frozen on the brief to reach here; a PreviewOptions field is quoted and then lost.
  const opts: PreviewOptions = {};
  // The ROW's model chooses the prompt's dialect, never the env at this moment (ADI-QS-GO R6, ledger D1): the row is
  // what this job will be dispatched to (`videoAdapterFor`), so it is what the prompt must be written for. Passed to
  // the planner alone — `opts` below carries only what the adapter reads.
  const { task, inputs, providerParams, shotType, templateKey } = plannedInputs(
    brief,
    {
      ...opts,
      ...(job.model ? { dialectModel: job.model } : {}),
    },
  );
  if (task !== "video.generate") {
    throw new GenerationError(
      `Job ${job.id} is not a video job (task ${task})`,
      "invalid_input",
    );
  }
  return {
    inputs,
    brief,
    opts: { ...opts, providerParams },
    shotType,
    templateKey,
  };
}

/** Resolve the brief's stored references into bytes/urls a provider can read. */
async function resolvedReferences(
  brief: CreativeBrief,
  inputs: GenerationInputs,
): Promise<ImageRef[]> {
  const { references } = previewGeneration(brief);
  const resolved = await Promise.all(
    references.map((r) => resolveStoredReference(r, brief)),
  );
  // Keep whatever the planner produced if resolution yields nothing — an unreferenced clip is a
  // legitimate text-to-video job.
  return resolved.length ? resolved : (inputs.references ?? []);
}

/**
 * The first frame, cut to the clip's shape before it is sent (video/firstFrame.ts says why).
 *
 * ⚠️ AN OPTIMIZATION, SO IT FALLS BACK RATHER THAN REFUSING — `personReference`'s rule, for its
 * reason. The uncropped frame is exactly what shipped before this, so if sharp fails the honest
 * answer is to send that and say so, not to fail a clip she has already approved.
 *
 * `STUDIO_VIDEO_FRAME_CROP=false` turns it off. That is not a rollout flag — the whole video arm is
 * already dark behind STUDIO_VIDEO_ENABLED — it is what lets a probe produce the AS-STORED cell on
 * the product path, which is the control the crop has never been measured against.
 *
 * The quote does not move: no video SKU prices the input image (Veo bills seconds, seedance bills
 * the REQUESTED w x h x frames), so a smaller first frame is not a price term.
 */
async function framedReferences(
  job: GenerationJob,
  references: ImageRef[],
  aspectRatio: string | undefined,
): Promise<ImageRef[]> {
  if (process.env.STUDIO_VIDEO_FRAME_CROP === "false") return references;
  try {
    const framed = await frameForClip(references, aspectRatio);
    logger.info(
      { jobId: job.id, aspectRatio, ...framed.note },
      "first frame checked against the clip's aspect before send",
    );
    return framed.references;
  } catch (err) {
    logger.warn(
      {
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      },
      "could not crop the first frame to the clip's aspect — sending it as stored, as before",
    );
    return references;
  }
}

/** What one pass over a job concluded. Only two of the four are terminal. */
type JobOutcome =
  /** Terminal, with assets recorded. */
  | "succeeded"
  /** Terminal, recorded as failed. */
  | "failed"
  /** NOT terminal: the provider is still working. The lease lapses and the next tick resumes it. */
  | "deferred"
  /** NOT terminal and NOT ours: another runner holds it. We spent nothing and touched nothing. */
  | "stood_down";

/**
 * ─── WHICH PROVIDER THIS JOB BELONGS TO, AND WHY IT IS READ OFF THE ROW ────────────────────────
 *
 * ⚠️ NEVER `routeFor("video.generate")`, AND NEVER `STUDIO_VIDEO_PROVIDER`. Config answers "what
 * would we do now"; the row answers "what did we commit to then", and a job already in flight only
 * ever wants the second question.
 *
 * `studio/jobs.ts` writes `provider` and `model` onto the row at queue time, off the frozen preview
 * plan — the same plan the athlete's approval was quoted against. So the answer is already stored
 * and nothing here has to parse a model id's shape to guess where it belongs.
 *
 * WHAT READING CONFIG WOULD COST, and it is worse than a refusal. A clip queued while the flag said
 * `openrouter`, claimed after it moved to `vertex`, would be SUBMITTED to Vertex — a second charge
 * for a clip already running elsewhere. On a resume it is nastier still: an OpenRouter job id would
 * be polled against Vertex's `fetchPredictOperation`, which fails looking like a dead job rather
 * than a misroute, so the clip is paid for, abandoned, and the log blames the wrong provider.
 *
 * ⚠️ A NULL `provider` RESOLVES TO VERTEX, AND THAT IS STILL READING THE ROW. Such a row was queued
 * when this runner imported Vertex's two functions directly and no other provider was reachable
 * from here at all — so Vertex is what it was committed to, as a matter of history rather than of
 * fallback. It is named explicitly for the same reason: `router.resolve` falls back to ROUTE CONFIG
 * when `opts.provider` is undefined, which is the one thing this function exists to prevent.
 */
function providerFor(job: GenerationJob): ProviderName {
  return (job.provider as ProviderName | null) ?? "vertex";
}

/**
 * The provider's detached video pair, resolved from the row.
 *
 * Goes through `router.resolve` rather than a second registry of its own — that is the one place
 * that already maps a provider name to an adapter and checks the task is supported. Both fields are
 * passed as overrides, so the route's own provider and model are never consulted.
 *
 * The model translation stays provider-local: `routes()` stored the id in its provider's own form
 * at queue time (`forProvider`), so Vertex's is already Vertex-native and `vertexModelFor` is a
 * no-op on it — kept for rows written before that was true. Every other provider's id travels
 * verbatim, because translating an OpenRouter id would be inventing one.
 */
function videoAdapterFor(job: GenerationJob): {
  model: string;
  submit: NonNullable<ReturnType<typeof resolve>["adapter"]["video"]>["submit"];
  poll: NonNullable<ReturnType<typeof resolve>["adapter"]["video"]>["poll"];
} {
  const provider = providerFor(job);
  const stored = job.model ?? "";
  const model = provider === "vertex" ? vertexModelFor(stored) : stored;

  const { adapter } = resolve("video.generate", { provider, model });
  if (!adapter.video) {
    // REFUSED, never guessed. A provider with no detached pair cannot be handed a queued clip, and
    // substituting a different one would submit this job somewhere it was never quoted against.
    throw new GenerationError(
      `Provider "${provider}" has no detached video support, so job ${job.id} cannot be worked. ` +
        "The job was queued against it; nothing else may be substituted.",
      "unsupported_task",
      provider,
    );
  }
  return { model, submit: adapter.video.submit, poll: adapter.video.poll };
}

/**
 * Work one claimed job.
 *
 * THE SUBMIT DECISION IS THE WHOLE FUNCTION. Everything else is bookkeeping.
 */
async function workJob(job: GenerationJob): Promise<JobOutcome> {
  const athleteId = job.athlete_id; // OFF THE ROW. Never from anywhere else.
  // Provider and model come OFF THE ROW too, for the same reason and with sharper consequences —
  // see `videoAdapterFor`. Read here, outside the try, because this cannot throw and the catch
  // below wants both for its log line: a misroute presents as a dead job, so the provider a job
  // went to is the first thing anyone reading that line needs.
  const provider = providerFor(job);
  let model = job.model ?? "";
  // Declared out here so the failure log can say whether a second clip was bought before this job
  // failed — a re-rolled failure costs twice, and a log line that cannot distinguish the two makes
  // the rate impossible to count.
  let reRolled = false;

  try {
    // ⚠️ INSIDE THE TRY, and it was outside in the first draft of this commit. `videoAdapterFor`
    // throws for a row whose provider cannot serve video, and out here that throw escapes workJob
    // AND videoTick — killing the whole tick, taking every other claimed job in the batch down with
    // it, and leaving this one claimed with its lease still held. One unworkable row would stop the
    // queue. In here the existing catch fails just this job and clears its lease, which is what
    // every other bad-job path already does.
    const dispatch = videoAdapterFor(job);
    model = dispatch.model;
    const { submit, poll } = dispatch;

    const { inputs, brief, opts, shotType, templateKey } = inputsFor(job);
    const references = await framedReferences(
      job,
      await resolvedReferences(brief, inputs),
      inputs.aspectRatio,
    );
    const callInputs: GenerationInputs = { ...inputs, references };

    // Renew the lease on every provider poll, so a job that is genuinely progressing is never
    // reaped out from under itself, while a dead instance still lapses within one lease.
    const runOpts = {
      ...opts,
      onProgress: () => {
        void renewLease(job.id, RUNNER_ID);
        void notePoll(job.id);
      },
      // Bound one tick's polling. A job that outlives this is not lost — the lease lapses, the
      // reaper requeues it WITH its operation handle, and the next tick resumes the same operation.
      maxPollMs: Number(
        process.env.STUDIO_VIDEO_TICK_POLL_MS ?? videoPoll().maxMs,
      ),
    };

    // ── The submit-once decision ──────────────────────────────────────────────────────────────
    //
    // Lifted into a closure because there is now a SECOND caller: the one re-roll below. The body
    // is unchanged — every guard in it, and the order of them, is what makes a submit safe, and a
    // re-roll that reimplemented any of it would be a second place for a double charge to live.
    const submitOnce = async (): Promise<string | null> => {
      // STAND DOWN IF WE NO LONGER HOLD THE LEASE. This is the guard for the one race the claim
      // cannot prevent: our lease can lapse while we are merely SLOW, the reaper can requeue the
      // job, and another runner can take it — all while this process is still alive and about to
      // spend money on it. `recordSubmitAttempt` is guarded on the holder, so its `false` is the
      // signal that the job is not ours any more. Checking it BEFORE the provider call is what
      // makes that a no-op rather than a double charge.
      if (!(await recordSubmitAttempt(job.id, RUNNER_ID))) {
        logger.warn(
          { jobId: job.id },
          "lease lost before submit — standing down without spending",
        );
        return null;
      }
      // Past this line a charge may have happened. Everything after it is written to be safe with
      // that being true.
      const submitted = await submit(callInputs, model, runOpts);
      if (!(await recordOperationName(job.id, submitted))) {
        // Narrower still: a handle landed between our attempt and our write. Ours is now a leaked
        // operation at the provider. We must NOT poll it — the job belongs to whoever's handle the
        // row carries, and polling ours too would store the asset twice against one job.
        logger.error(
          { jobId: job.id, leakedOperation: submitted },
          "lost the submit race — this operation is orphaned at the provider and will not be polled",
        );
        return null;
      }
      return submitted;
    };

    let operationName = job.provider_operation_name;
    if (!operationName) {
      operationName = await submitOnce();
      if (!operationName) return "stood_down";
    } else {
      logger.info(
        { jobId: job.id, provider, model, operationName },
        "resuming a handed-off operation — NOT re-submitting",
      );
    }

    // ── Poll to completion (or to this tick's budget), with at most ONE re-roll ───────────────
    //
    // ─── ⚠️  THE ONLY PLACE IN THIS RUNNER THAT MAY SPEND TWICE, AND IT IS OFF BY DEFAULT ─────
    //
    // A `content_filtered` clip was GENERATED AND BILLED and then withheld by an output filter
    // (studio/refusal.ts). The same request can produce a different outcome, so asking again is
    // meaningful — and it is NOT free: it buys a second clip. Worse, `spentTodayUsd` sums
    // `cost_estimated_usd` per generation_jobs ROW and a re-roll reuses the row, so that second
    // clip is money the daily ceiling structurally cannot see.
    //
    // Hence three separate brakes, all of which must be open:
    //   1. `retryEnabled()` — STUDIO_AGENT_RETRY, default off. Nothing re-rolls until the rate of
    //      `content_filtered` has been counted off real jobs. ⚠️ NOT `STUDIO_AGENT`: turning the
    //      Agent on for a demo must not buy second clips the day cap cannot see.
    //   2. `isRetryableRefusal` — a `content_blocked` input refusal is the same "no" twice, and a
    //      timeout is not a refusal at all (it is handled by the catch, which defers the job).
    //   3. `reRolled` — once. Bounded by a local, in one tick, so there is no state to leak and no
    //      counter to get wrong.
    //
    // The handle is cleared through `clearOperationName`, which can only ever undo OUR OWN write.
    let out: Awaited<ReturnType<typeof poll>>;
    for (;;) {
      try {
        out = await poll(operationName, model, callInputs, runOpts);
        break;
      } catch (err) {
        const refusal = err instanceof GenerationError ? err : null;
        if (
          !refusal ||
          !isRetryableRefusal(refusal.code) ||
          reRolled ||
          !retryEnabled()
        ) {
          throw err;
        }

        // The old operation is finished and its result withheld; a new ask needs a new handle.
        if (!(await clearOperationName(job.id, RUNNER_ID, operationName)))
          return "stood_down";
        const again = await submitOnce();
        if (!again) return "stood_down";

        logger.warn(
          {
            jobId: job.id,
            athleteId,
            provider,
            model,
            code: refusal.code,
            error: refusal.message.slice(0, 160),
          },
          "output filter withheld the clip — re-rolling once, which spends again",
        );
        operationName = again;
        reRolled = true;
      }
    }

    /** What was stored, so the QA stage below can inspect it without re-downloading it. */
    const recorded: { assetId: string; bytes?: Buffer }[] = [];
    for (const [i, asset] of out.assets.entries()) {
      const stored = await storeAsset(
        asset,
        studioObjectBase(athleteId, job.id, i),
      );
      const row = await recordGeneratedAsset({
        athleteId,
        jobId: job.id,
        gcsPath: stored.gcs_path,
        contentType: stored.content_type,
        mediaType: "VIDEO",
        width: asset.width ?? null,
        height: asset.height ?? null,
        bytes: stored.bytes,
        durationSeconds: asset.durationSeconds ?? null,
        // A video generate has no source frame to stay continuous with — the anchor is a reference,
        // not a frame the output must preserve. Same rule the inline path applies to `generate`.
        derivedFromAssetId: null,
      });
      // The pixels the adapter just returned, kept so QA does not re-download what we uploaded a
      // line ago. Absent for a rehosted-from-url asset, which inspectClipAsset reads back instead.
      recorded.push({
        assetId: row.id,
        ...(asset.bytes ? { bytes: asset.bytes } : {}),
      });

      // ─── THE COST LINE, AT POLL-COMPLETE (PR 11, R-2) ────────────────────────────────────────
      //
      // The queued path never enters `router.generate()` — it is `submit` + `poll` on the adapter's
      // detached pair — so until this line every product clip was invisible to the cost log. One
      // line per stored clip, written HERE and nowhere earlier: a submit that never completes has
      // no clip to attribute a line to, and a re-roll reuses the row (see `reRolled`).
      //
      // The figure is the QUOTE off the job row, basis "estimated", and `detail` says so: the poll
      // result carries no billed amount (studio/types.ts `poll` returns assets + handle only), and a
      // number recomputed here could disagree with the one she approved. Best-effort by
      // `recordGeneration`'s own rule — a logging failure cannot fail a clip that is already stored.
      await recordGeneration({
        task: "video.generate",
        model,
        provider,
        inputRefs: { count: callInputs.references?.length ?? 0 },
        outputRef: safeRef(stored.gcs_path),
        cost:
          job.cost_estimated_usd === null ? 0 : Number(job.cost_estimated_usd),
        costBasis: "estimated",
        detail:
          job.cost_estimated_usd === null
            ? "unpriced: generation_jobs.cost_estimated_usd is null"
            : "quoted: generation_jobs.cost_estimated_usd — the poll result carries no billed figure",
        latencyMs: job.started_at ? Date.now() - job.started_at.getTime() : 0,
        attribution: { jobId: job.id, assetId: row.id },
      });
    }

    await succeedJob(job.id, athleteId);
    await clearLease(job.id);

    // ─── ⚠️  CLIP QA RUNS HERE, AND "HERE" IS THE WHOLE DESIGN ─────────────────────────────────
    //
    // The image path awaits its QA BEFORE succeedJob, so the verdict is on the record by the time
    // the asset is. VIDEO MUST DO THE OPPOSITE, and it is not a preference:
    //
    //   `reapExpiredLeases` requeues on `status='running' AND lease_until < now()`, and it KEEPS
    //   `provider_operation_name` — deliberately, so a handed-off job resumes polling work that is
    //   already paid for. Between the store and `succeedJob` the job is still `running`, and the
    //   lease is only renewed on POLL progress, which has finished. Today that window is
    //   milliseconds. A QA stage inside it is up to three minutes, on top of a poll that may
    //   already have consumed most of `leaseMs()` — so the lease lapses, the reaper requeues, the
    //   next runner resumes THE SAME OPERATION, and `recordGeneratedAsset` runs a second time.
    //   One clip, two rows in her library, and nothing anywhere says why.
    //
    // Past `succeedJob` the status is terminal, so the reaper's predicate excludes the row whatever
    // the lease says, and the stage can take as long as it needs. The cost is that a client polling
    // `GET /studio/jobs/:jobId` can see `succeeded` one tick before the verdict lands, which is
    // fine — it is already polling.
    //
    // ⚠️ `leaseMs()` has a hard `Math.max(180_000, …)` floor, so this cannot be papered over by
    // making the lease longer, and it should not be: the fix is ordering, not a bigger number.
    //
    // Behind STUDIO_CREATIVE_QA, default off, exactly as the image hook is. Never throws — every
    // path in inspectClipAsset returns null — so a generation that has been paid for, stored and
    // closed cannot be undone by an inspection.
    // ⚠️ ITS OWN try/catch, AND THAT IS LOAD-BEARING RATHER THAN BELT-AND-BRACES. `studio/jobs.ts`
    // `finish()` is UNGUARDED ON STATUS: it writes whatever status it is given over whatever is
    // there. So a throw anywhere after `succeedJob` but inside this function's outer try reaches
    // that catch, which calls `failJob` — and flips a job that SUCCEEDED, whose clip is stored and
    // whose money is spent, to `failed`. She would be told "couldn't generate that" about a clip
    // sitting in her library.
    //
    // `inspectClipAsset` is written never to throw, on every path. That is a property of THAT
    // function, and the runner must not depend on it: one future edit in qa/ would otherwise turn
    // a bad inspection into a lost generation. Swallowed here, logged, and the job stays closed.
    if (creativeQaEnabled()) {
      for (const r of recorded) {
        try {
          // ─── ⚠️  DYNAMIC, AND IT IS NOT A STYLE CHOICE ───────────────────────────────────
          //
          // A static import here reaches qa/inspectClip -> qa/videoClip -> qa/identity ->
          // qa/embed -> lib/mediaEmbed, and THAT module constructs a GCS `Storage` client at
          // module load (`new Storage().bucket(BUCKET)`, mediaEmbed.ts:19). Importing this file
          // then meant building a cloud client, which threw in a suite that had no reason to mock
          // it and took the whole jest worker down with it — videoRunner.dispatch.test.ts, which
          // is about provider dispatch and touches none of this.
          //
          // It is also simply wrong to pay for eagerly: the stage is behind a flag that is OFF by
          // default, so every instance was loading the module graph of something that never runs.
          // Inside the flag check, nothing is loaded until the first clip is actually inspected.
          //
          // `.js` on the specifier is this repo's convention for a dynamic import (server/CLAUDE.md;
          // the same form generate.ts uses for threadSummarizer); jest's moduleNameMapper strips it.
          const { inspectClipAsset } = await import("./qa/inspectClip.js");
          await inspectClipAsset({
            assetId: r.assetId,
            athleteId,
            // Her sentence, off the FROZEN brief — the immutable record of what was asked.
            instruction: brief.job.direction.statement,
            // Both off the ROW. `cost_estimated_usd` is what this clip was QUOTED, which is what a
            // re-roll of the same brief would cost — never a figure recomputed here, which could
            // disagree with the one she approved.
            shotType,
            quotedUsd:
              job.cost_estimated_usd === null
                ? null
                : Number(job.cost_estimated_usd),
            ...(r.bytes ? { bytes: r.bytes } : {}),
          });
        } catch (err) {
          logger.warn(
            {
              jobId: job.id,
              assetId: r.assetId,
              error: (err instanceof Error ? err.message : String(err)).slice(
                0,
                160,
              ),
            },
            "clip QA threw — the job stays succeeded and the clip stays stored",
          );
        }
      }
    }

    // ─── THE STRUCTURE CHECK (quality-scrappy piece 2), behind STUDIO_CLIP_QC ──────────────────────
    //
    // $0 and local: length, shape, black, frozen, and — where sound was paid for — silence (video/structure.ts).
    // After the QA stage and past `succeedJob`, for the same reasons that stage is: the status is terminal, and a
    // check must never be able to flip a stored, paid-for clip to `failed`. Its OWN try/catch for the reason the QA
    // block gives above — `checkStructureBytes` and `writeStructure` never throw, and the runner does not rely on it.
    // Expected values come off the planner's inputs, which are the quote's (inputsFor).
    if (clipQcEnabled()) {
      const expected = clipExpectation(inputs, opts.providerParams);
      for (const r of recorded) {
        try {
          const record = r.bytes
            ? await checkStructureBytes(r.bytes, expected, "clip")
            : unmeasured(
                expected,
                "clip",
                "the clip's bytes did not reach this instance",
              );
          await writeStructure(r.assetId, athleteId, record);
        } catch (err) {
          logger.warn(
            {
              jobId: job.id,
              assetId: r.assetId,
              error: (err instanceof Error ? err.message : String(err)).slice(
                0,
                160,
              ),
            },
            "structure check threw — the job stays succeeded and the clip stays stored",
          );
        }
      }
    }

    // ─── THE OUTPUT GATE (quality-scrappy piece 5), opt-in STUDIO_OUTPUT_GATE ──────────────────────────
    //
    // LAST, because it reads what the two checks above wrote (creative_qa.checks.text, creative_qa.structure). It marks
    // the OUTPUT and never the job: past succeedJob, for every reason the QA block gives. Until it lands, a gated job
    // read says the clip is still being checked (routes/studio.ts `withGates`), so no watcher presents it as done.
    if (outputGateEnabled()) {
      const template = templateOf(brief, templateKey);
      for (const r of recorded) {
        try {
          await recordGate(r.assetId, athleteId, "clip", template);
        } catch {
          // recordGate never throws; the runner does not rely on it (see the QA block above).
        }
      }
    }

    // ─── THE TEMPLATE'S SCORE (quality-scrappy piece 10), STUDIO_PROMPT_REGISTRY ────────────────────────────────
    //
    // After the gate, which it reads. Observation only: on the asset, and one log line per clip by template key and
    // version. A clip runs no adherence judge, so its score says "n/a" there rather than guessing.
    if (promptRegistryEnabled()) {
      const template = templateOf(brief, templateKey);
      for (const r of recorded) {
        try {
          await recordScore(r.assetId, athleteId, "clip", "generate", template);
        } catch {
          // recordScore never throws; the runner does not rely on it.
        }
      }
    }

    logger.info(
      { jobId: job.id, athleteId, assets: out.assets.length },
      "video job complete",
    );
    return "succeeded";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A timeout is NOT a failure — the operation is still running at Vertex. Leave the job running
    // and let its lease lapse so the reaper requeues it WITH the handle and the next tick resumes.
    // Failing here would abandon a clip that is about to be ready and that has already been paid for.
    if (err instanceof GenerationError && err.code === "timeout") {
      logger.info(
        { jobId: job.id },
        "poll budget spent — leaving the job for the next tick to resume",
      );
      return "deferred";
    }
    // ─── THE CODE DECIDES WHAT IS RECORDED, NOT THE PROVIDER'S PROSE ───────────────────────────
    //
    // `failJob` still takes a string — adding a column for this would be a migration, and the code
    // is already carried by the error. What changes is that the SENTENCE is now chosen by the code
    // rather than being whatever the provider happened to say, so "this will never work" and "that
    // did not work" stop reading identically in `last_error`. The provider's own words are kept on
    // the end, because an operator debugging a refusal needs them.
    const code = err instanceof GenerationError ? err.code : null;
    const reason =
      code === "content_blocked"
        ? "This can't be made from that photo — the video model won't accept it, and asking " +
          `again won't change that. Try a different photo. (${message})`
        : code === "content_filtered"
          ? "The video model made this and then held it back on a content check. Trying again " +
            `may work. (${message})`
          : message;

    await failJob(job.id, athleteId, reason);
    await clearLease(job.id);
    logger.warn(
      {
        jobId: job.id,
        athleteId,
        provider,
        model,
        code,
        reRolled,
        error: message,
      },
      "video job failed",
    );
    return "failed";
  }
}

/**
 * One consumer pass. Call under the advisory lock (server/index.ts), exactly as the workflow tick is.
 *
 * The lock is belt-and-braces rather than the safety mechanism: SKIP LOCKED already makes two
 * simultaneous ticks claim different rows. It exists to stop three instances all spending CPU on a
 * queue that is usually empty.
 */
export async function videoTick(
  limit = DEFAULT_BATCH,
): Promise<VideoTickResult> {
  const reaped = await reapExpiredLeases();
  const jobs = await claimVideoJobs(limit, RUNNER_ID);
  const tally: Record<JobOutcome, number> = {
    succeeded: 0,
    failed: 0,
    deferred: 0,
    stood_down: 0,
  };
  for (const job of jobs) tally[await workJob(job)]++;
  return {
    reaped,
    claimed: jobs.length,
    succeeded: tally.succeeded,
    failed: tally.failed,
    deferred: tally.deferred,
    stoodDown: tally.stood_down,
  };
}
