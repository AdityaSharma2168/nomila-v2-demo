/**
 * agent/postKit/render/worker.ts — the stitch runner's second kind of job: a post kit's preview render (design §11 v2,
 * build step 9). studio/stitchRunner.ts claims it off the same queue, under the same lease, the same per-instance
 * capacity guard and the same reaper as any stitch, and hands it here when its spec says it is one (compile.ts
 * isRenderJobSpec).
 *
 *   read      the stored spec, checked (compile.ts readRenderJobSpec) — a plan edited on the row is refused
 *   gate      AGENT_POST_KITS + AGENT_POST_KIT_RENDER still on; the kit still wants THIS job (superseded below):
 *             cancelled before any byte moves, and checked again before anything is uploaded
 *   fetch     materializeWorkspace — tenancy, the caps and the download, the stitch runner's own: every id resolved
 *             under the athlete OFF THE ROW, a photo through the photo predicate, the licensed track off its allowlist
 *   measure   ffprobe on every clip; the plan conformed to the files' real lengths (compile.ts conformToProbes)
 *   render    local.ts, inside ONE budget that starts before the probes (renderBudgetMs)
 *   verify    check before deliver (A4, render/verify.ts): every file read off the disk — ffprobe / decode, length,
 *             sound when a bed was laid, frame, size. One that fails: the preview is failed as "needs a look"
 *             (RENDER_ERRORS.needsALook), nothing is published (the files are kept aside for debugging, never in
 *             her library: services/verify/keep.ts), and the kit is never marked ready
 *   publish   derived media assets with lineage (publish.ts), bounded by the transfer budget
 *   close     the job row (succeeded / failed / canceled, holder-guarded) and the kit's preview (ready / failed, only
 *             while the kit's preview key is still this one). A lease lost before the close leaves the kit alone.
 *
 * The job row is ALWAYS closed: the whole body sits in one try/finally, and a kit write that fails never skips the job
 * close. A job the reaper gives up on marks its kit failed too (failExhaustedRenders), so a kit never says "queued" for
 * a render nobody will run.
 *
 * No model call, no provider, no spend: the whole graph is local CPU, GCS and the database (stitchRunner.test.ts walks
 * it). A failure the athlete can act on is written as her sentence; anything else is logged and replaced.
 */
import { createLogger } from "../../../logger";
import type { StudioStitchJob } from "../../../../shared/schema";
import type { PostKitPreview, PostKitPreviewOutput, RenderNote } from "../../../../shared/postKit";
import { dbStore } from "../../research/dbStore";
import type { AgentStore } from "../../research/store";
import { withTimeout } from "../../../lib/withTimeout";
import { cancelStitch, failStitch, stitchTimeoutMs, succeedStitch, transferTimeoutMs } from "../../../studio/stitchJobs";
import { musicBedFor, type BedSource } from "../../../studio/video/beds";
import { MaterializeError, materializeWorkspace, type StitchWorkspace, type TimelineEntry } from "../../../studio/video/materialize";
import { probeMedia } from "../../../studio/video/probe";
import { DEFAULT_STILL_SEC } from "../../../studio/video/spec";
import { agentPostKitRenderEnabled, POST_KIT_RENDER } from "../config";
import { conformToProbes, coverAssetFor, isRenderJobSpec, readRenderJobSpec, type RenderPlan } from "./compile";
import { renderLocal, type LocalRender } from "./local";
import { currentPreview, markFailed, markReady } from "./preview";
import { publishRenderOutputs, type PublishInput } from "./publish";
import { verifyRender } from "./verify";
import { logNeedsALook, type VerifyResult } from "../../../services/verify/deliverable";
import { keepForReview } from "../../../services/verify/keep";

const logger = createLogger("agent/postKit/render/worker");

export interface RenderWorkerDeps {
  store: AgentStore;
  materialize(athleteId: string, timeline: TimelineEntry[], signal: AbortSignal, bed: BedSource | null): Promise<StitchWorkspace>;
  /** A downloaded clip's real length, from the file. */
  probeSec(path: string): Promise<number>;
  publish(input: PublishInput): Promise<PostKitPreviewOutput[]>;
  /** Check before deliver (A4): the rendered files against the plan. Default: render/verify.ts on the real files. */
  verify?(plan: RenderPlan, render: LocalRender): Promise<VerifyResult>;
  /** A render that failed its check is copied aside for debugging (services/verify/keep.ts). Default: the media bucket. */
  keep?(athleteId: string, jobId: string, render: LocalRender): Promise<string[]>;
  jobs: {
    succeed(jobId: string, holder: string, outputAssetId: string): Promise<boolean>;
    fail(jobId: string, holder: string, message: string): Promise<boolean>;
    cancel(jobId: string, holder: string, message: string): Promise<boolean>;
  };
  now?: () => Date;
}

export function dbRenderWorkerDeps(): RenderWorkerDeps {
  return {
    store: dbStore,
    materialize: (athleteId, timeline, signal, bed) => materializeWorkspace(athleteId, timeline, signal, bed),
    probeSec: async (path) => (await probeMedia(path)).durationSec,
    publish: publishRenderOutputs,
    verify: (plan, render) => verifyRender(plan, render),
    keep: (athleteId, jobId, render) => keepForReview(athleteId, jobId, render.outputs.map((o) => ({ path: o.path, contentType: o.contentType, kind: o.kind }))),
    jobs: { succeed: succeedStitch, fail: failStitch, cancel: cancelStitch },
  };
}

/** Readable sentences: the only text a failed preview carries to the athlete. */
export const RENDER_ERRORS = {
  off: "Post previews are switched off right now.",
  unreadable: "This preview's request could not be read. Change the post to ask for a new one.",
  nothing: "None of this post's photos or clips could be used for a preview.",
  generic: "We couldn't put this preview together. Change the post or try again.",
  exhausted: "We tried to put this preview together several times and couldn't. Change the post or try again.",
  needsALook: "This preview didn't pass its check, so it isn't ready yet. Change the post or try again.",
} as const;

/**
 * The render's CPU budget: AGENT_POST_KIT_RENDER_TIMEOUT_MS, never more than three quarters of the stitch queue's own
 * ffmpeg budget — the lease is derived from that budget (studio/stitchJobs.ts leaseMs), so the quarter left is the
 * lease's slack for everything the budget does not time (the database, the checks, the dispose).
 */
export const renderBudgetMs = (): number => Math.min(POST_KIT_RENDER.TIMEOUT_MS, Math.floor(stitchTimeoutMs() * 0.75));

/** The plan's positions as the stitch workspace takes them: a clip with its trims, a photo as a still (photo predicate). */
export function timelineFor(plan: RenderPlan): TimelineEntry[] {
  return plan.positions.map((p) => p.kind === "clip"
    ? { assetId: p.assetId, trimStartSec: p.trimStartSec!, trimEndSec: p.trimEndSec! }
    : { assetId: p.assetId, stillSec: p.holdSec ?? DEFAULT_STILL_SEC });
}

/**
 * Whether the kit no longer wants this job — only ever because of a preview asked for AT OR AFTER this job was queued
 * (both by the database's clock):
 *   - for the SAME key, naming another job (or a reused set), and not failed — that one owns the key;
 *   - for ANOTHER key.
 * A preview older than the job is the one this job replaces: the request that queued it may not have written it yet
 * (a tick can claim the row between its insert and the kit write), so it is never a reason to cancel.
 */
export function supersededBy(current: PostKitPreview | null, job: Pick<StudioStitchJob, "id" | "created_at">, key: string): boolean {
  if (!current) return false;
  if (Date.parse(current.requestedAt) < new Date(job.created_at).getTime()) return false;
  if (current.key === key) return current.jobId !== job.id && current.status !== "failed";
  return true;
}

export type RenderOutcome = "succeeded" | "failed" | "canceled" | "lost";

export async function workPostKitRender(job: StudioStitchJob, holder: string, deps: RenderWorkerDeps = dbRenderWorkerDeps()): Promise<RenderOutcome> {
  const athleteId = job.athlete_id; // OFF THE ROW. Never from the spec.
  const now = () => (deps.now ? deps.now() : new Date());
  let closed = false;
  let target: { decisionId: string; key: string } | null = null;
  let workspace: StitchWorkspace | null = null;
  const transfers = new AbortController();
  let transferDeadline: ReturnType<typeof setTimeout> | null = null;

  const close = async (how: "fail" | "cancel", message: string): Promise<void> => {
    closed = true;
    await (how === "fail" ? deps.jobs.fail(job.id, holder, message) : deps.jobs.cancel(job.id, holder, message));
  };
  const fail = async (message: string): Promise<RenderOutcome> => {
    await close("fail", message);
    if (target) {
      // Its own catch: a kit that cannot be written must never leave the job row open.
      await markFailed(deps.store, athleteId, target.decisionId, target.key, message, now()).catch((err) =>
        logger.error({ jobId: job.id, athleteId, error: String(err?.message ?? err).slice(0, 200) }, "post kit preview could not be marked failed"));
    }
    return "failed";
  };
  const superseded = async (when: string): Promise<boolean> => {
    if (!supersededBy(await currentPreview(deps.store, athleteId, target!.decisionId), job, target!.key)) return false;
    await close("cancel", "A newer preview of this post was asked for.");
    logger.info({ jobId: job.id, athleteId, decisionId: target!.decisionId, when }, "post kit render superseded");
    return true;
  };

  try {
    const spec = readRenderJobSpec(job.spec);
    if ("error" in spec) {
      logger.warn({ jobId: job.id, athleteId, problem: spec.error }, "post kit render spec refused");
      return await fail(RENDER_ERRORS.unreadable);
    }
    target = { decisionId: spec.decisionId, key: spec.key };
    const { decisionId, key } = target;
    if (!agentPostKitRenderEnabled()) return await fail(RENDER_ERRORS.off);
    if (await superseded("before it started")) return "canceled";

    transferDeadline = setTimeout(() => transfers.abort(new Error("Downloading the post's media took too long")), transferTimeoutMs());
    // NULL when the licensed tracks are not installed: the preview is cut without music rather than refused.
    const bed = spec.plan.output === "video" ? musicBedFor(spec.plan.bed) : null;
    const runtimeNotes: RenderNote[] = spec.plan.output === "video" && spec.plan.bed && !bed ? ["music_not_installed"] : [];
    workspace = await deps.materialize(athleteId, timelineFor(spec.plan), transfers.signal, bed);
    clearTimeout(transferDeadline);

    // ONE budget from here: the probes, every photo, the loudness, every ffmpeg run.
    const deadline = Date.now() + renderBudgetMs();
    const probed = new Map<string, number>();
    for (const [assetId, path] of workspace.paths) {
      if (Date.now() >= deadline) throw new Error("The preview used up its whole encode budget measuring its clips");
      probed.set(assetId, await deps.probeSec(path));
    }
    const conformed = conformToProbes(spec.plan, probed);
    if (!conformed) return await fail(RENDER_ERRORS.nothing);
    const plan: RenderPlan = conformed.plan.output === "video" && !workspace.bedPath ? { ...conformed.plan, bed: null } : conformed.plan;

    const local = await renderLocal(plan, { clips: workspace.paths, photos: workspace.stills, bedPath: workspace.bedPath }, workspace.dir, deadline);
    // CHECK BEFORE DELIVER (A4): on the local files, before anything is uploaded. A render that fails is "needs a look":
    // the preview fails with her sentence, nothing is published, and the kit is never marked ready.
    // A check that THROWS fails closed with the same sentence (verify/deliverable VERIFIER_ERROR_MODE) — never the
    // generic catch below — and is final: the job is failed, not retried, so a verifier bug cannot loop a render.
    const verdict: VerifyResult = await (deps.verify ?? verifyRender)(plan, local).catch((e) => ({
      ok: false as const, kind: plan.output === "video" ? "video" as const : "image" as const, status: "needs_a_look" as const, checked: ["verifier_error"],
      failures: [{ check: "verifier_error", reason: `the check itself failed: ${String(e?.message ?? e).slice(0, 200)}` }],
    }));
    if (!verdict.ok) {
      // The files are kept aside (never in her library) before the workspace is disposed, so what failed can be opened.
      const kept = deps.keep ? await withTimeout(deps.keep(athleteId, job.id, local), transferTimeoutMs(), "keeping a render that needs a look").catch(() => []) : [];
      logNeedsALook("post_kit_render", verdict, { jobId: job.id, athleteId, decisionId, kept });
      return await fail(RENDER_ERRORS.needsALook);
    }
    // Nothing is uploaded for a kit that has moved on while this rendered.
    if (await superseded("before upload")) return "canceled";
    const outputs = await withTimeout(deps.publish({ athleteId, decisionId, key, render: local }), transferTimeoutMs(), "post kit preview upload");

    closed = true;
    if (!(await deps.jobs.succeed(job.id, holder, outputs[0].assetId))) {
      // The lease went to another runner: the job is theirs to close and the kit theirs to write.
      logger.warn({ jobId: job.id, athleteId, decisionId }, "post kit render finished after its lease was lost — the kit is left to the job's holder");
      return "lost";
    }
    const landed = await markReady(deps.store, athleteId, decisionId, key, {
      outputs, coverAssetId: coverAssetFor(plan, outputs), notes: [...conformed.notes, ...runtimeNotes], at: now(),
    });
    logger.info({
      jobId: job.id, athleteId, decisionId, key, format: plan.format, outputs: outputs.length, landed,
      durationSec: local.outputs[0].durationSec,
    }, landed ? "post kit preview ready" : "post kit preview rendered for a kit that has since changed");
    return "succeeded";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ jobId: job.id, athleteId, decisionId: target?.decisionId, error: message.slice(0, 800) }, "post kit render failed");
    if (closed) return "failed";
    // MaterializeError messages are written for her and name the caps; an ffmpeg stderr tail or a GCS error is not.
    return await fail(err instanceof MaterializeError ? err.message : RENDER_ERRORS.generic).catch(() => "failed" as const);
  } finally {
    if (transferDeadline) clearTimeout(transferDeadline);
    if (workspace) await workspace.dispose().catch((err) => logger.error({ jobId: job.id, err }, "render workspace not disposed — this instance has leaked tmpfs"));
    if (!closed) {
      await deps.jobs.fail(job.id, holder, RENDER_ERRORS.generic).catch((err) =>
        logger.error({ jobId: job.id, err }, "post kit render job could not be closed — the reaper will requeue it"));
    }
  }
}

/**
 * The reaper's hook (studio/stitchJobs.ts reapExpiredStitchLeases): every post-kit render it gave up on marks its kit
 * failed — only while the kit's preview is still that render's key. Any other row is not this module's.
 */
export async function failExhaustedRenders(
  rows: Array<Pick<StudioStitchJob, "id" | "athlete_id" | "spec">>,
  store: AgentStore = dbStore,
  at: Date = new Date(),
): Promise<void> {
  for (const row of rows) {
    if (!isRenderJobSpec(row.spec)) continue;
    const spec = readRenderJobSpec(row.spec);
    if ("error" in spec) continue;
    await markFailed(store, row.athlete_id, spec.decisionId, spec.key, RENDER_ERRORS.exhausted, at).catch((err) =>
      logger.error({ jobId: row.id, error: String(err?.message ?? err).slice(0, 200) }, "an exhausted render's kit could not be marked failed"));
  }
}
