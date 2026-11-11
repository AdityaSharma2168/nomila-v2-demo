/**
 * agent/postKit/render/request.ts — asking for a kit's preview render, idempotently (design §11 v2, build step 9).
 *
 * Called after a kit is built, after a swap, after a caption edit, and by the preview route. Each call compiles the kit
 * as it is NOW (compile.ts) and:
 *
 *   the key is the preview's, and it is live             nothing — a caption edit changes no pixel, so it renders nothing
 *     (ready, or queued with its job still queued/running; on the route's re-ask a ready one's outputs must still exist)
 *   the outputs for this key were published before      reused: the preview is ready at once, no job (a swap back)
 *   otherwise                                           one stitch-queue job (studio/stitchRunner.ts), the preview
 *                                                       written as queued, and the runner kicked
 *
 * So a preview can never stick at "queued": one whose job ended (failed, cancelled, reaped, gone) is asked again, as is a
 * failed one — and, on the route's re-ask (the screen's "Try again"), one queued past POST_KIT_PREVIEW_STALL_MS, its
 * old job cancelled. A job this call queued but did not end up pointing the kit at (the key turned out unchanged, the write
 * lost a race, the key moved on a retry) is cancelled before the call returns, so two jobs never run for one key.
 *
 * Every time stamped here is the DATABASE's (the job row's created_at, or its now()), so the runner can order a preview
 * against a job (worker.ts). Dark unless AGENT_POST_KITS and AGENT_POST_KIT_RENDER are both on; nothing here calls a
 * model or spends.
 */
import type { ActionDecisionDetail } from "../../../../shared/plan";
import {
  POST_KIT_PREVIEW_STALL_MS, POST_KIT_RENDER_CONTRACT,
  type PostKit, type PostKitPreview, type PostKitPreviewOutput, type PostKitPreviewView,
} from "../../../../shared/postKit";
import { bedsReady } from "../../../studio/video/beds";
import { musicLibraryReady } from "../../../studio/music/library";
import { kitIsBrandWork, reconcileMusic } from "../music";
import { createLogger } from "../../../logger";
import type { PostKitDeps } from "../build";
import { agentPostKitRenderEnabled } from "../config";
import { compileRender, coverAssetFor, renderJobSpec, type RenderJobSpec, type RenderSource } from "./compile";

const logger = createLogger("agent/postKit/render");
const ATTEMPTS = 3;

export type RenderJobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

/** The render's outside world: the stitch queue, and the derived assets a render publishes. Athlete first, always. */
export interface PostKitRenderPort {
  /** Queue one render (a studio_stitch_jobs row born queued): its id, and its created_at by the database's clock. */
  queue(athleteId: string, spec: RenderJobSpec): Promise<{ jobId: string; queuedAt: string }>;
  /** Cancel a render this request queued and did not use — only while nobody has claimed it. */
  cancel(athleteId: string, jobId: string): Promise<void>;
  /** A render job's status now, or null when there is no such row of the athlete's. */
  jobStatus(athleteId: string, jobId: string): Promise<RenderJobStatus | null>;
  /** The database's now(), ISO — for a reused preview's requestedAt. */
  clock(): Promise<string>;
  /** Start the runner now. Unawaited and never throws: the scheduled tick is the fallback. */
  kick(): void;
  /** What a run actually published for this kit and key, in order — null unless a whole set is there (publish.ts). */
  published(athleteId: string, decisionId: string, key: string): Promise<PostKitPreviewOutput[] | null>;
  /** Whether every one of these output assets is still there (stored, not deleted, hers). */
  outputsExist(athleteId: string, assetIds: readonly string[]): Promise<boolean>;
  /** Fresh signed URLs for a preview's outputs and cover, read through the athlete's own rows (null for one gone). */
  sign(athleteId: string, preview: PostKitPreview): Promise<{ items: Array<string | null>; coverUrl: string | null }>;
}

export type RenderRequestOutcome =
  | { status: "off" }
  | { status: "no_kit" }
  | { status: "nothing_to_render"; reason: "no_assets" | "nothing_available" }
  | { status: "unchanged"; key: string }
  | { status: "reused"; key: string }
  | { status: "queued"; key: string; jobId: string }
  | { status: "conflict" };

/**
 * Whether a preview for the key being asked is live — nothing to do. A queued one is live only while its job is; and,
 * on the route's re-ask (`verify`), only until it stalls: queued POST_KIT_PREVIEW_STALL_MS after it was asked for (by
 * the database's clock, the clock requestedAt is on), it is what the screen's "Try again" is for, so it is asked again.
 */
async function live(port: PostKitRenderPort, athleteId: string, p: PostKitPreview, verify: boolean): Promise<boolean> {
  if (p.status === "ready") return !verify || (await port.outputsExist(athleteId, p.outputs.map((o) => o.assetId)));
  if (p.status === "queued") {
    if (!p.jobId) return false;
    if (verify && Date.parse(await port.clock()) - Date.parse(p.requestedAt) >= POST_KIT_PREVIEW_STALL_MS) return false;
    const s = await port.jobStatus(athleteId, p.jobId);
    return s === "queued" || s === "running";
  }
  return false;
}

/**
 * Ask for this kit's preview. `verify` (the route's re-ask) also checks that a ready preview's outputs still exist —
 * one deleted since is rendered again rather than answered "unchanged" forever.
 */
export async function requestPostKitRender(deps: PostKitDeps, athleteId: string, decisionId: string, opts: { verify?: boolean } = {}): Promise<RenderRequestOutcome> {
  const port = deps.render;
  if (!agentPostKitRenderEnabled() || !port) return { status: "off" };
  /** Jobs this call queued, by key. Every one the kit does not end up naming is cancelled on the way out. */
  const queued = new Map<string, { jobId: string; queuedAt: string }>();
  const done = async (out: RenderRequestOutcome): Promise<RenderRequestOutcome> => {
    const keep = out.status === "queued" ? out.jobId : null;
    for (const { jobId } of queued.values()) {
      if (jobId !== keep) await port.cancel(athleteId, jobId);
    }
    return out;
  };

  for (let i = 0; i < ATTEMPTS; i++) {
    const d = await deps.store.getDecision(athleteId, decisionId);
    if (!d || d.kind !== "action") return done({ status: "no_kit" });
    const det = (d.detail ?? {}) as unknown as ActionDecisionDetail;
    const stored: PostKit | undefined = det.prepared?.postKit;
    if (!stored || !stored.assets.length) return done({ status: "no_kit" });
    const forBrand = kitIsBrandWork(det);
    // The kit against the post as it is NOW (music.ts): a post that became brand work since the build drops a track
    // that is not brand-safe, and its credit leaves the caption. Rendered from, and written back below.
    const kit = reconcileMusic(stored, forBrand);
    const reconciled = kit !== stored;

    // What is still hers, through the same predicate the kit was built through: a deleted asset is left out, not fetched.
    const rows = await deps.media.load(athleteId, [...new Set(kit.treatmentPlan.order)]);
    const sources = new Map<string, RenderSource>([...rows].map(([id, r]) => [id, { mediaType: r.mediaType, durationSec: r.durationSeconds }]));
    const c = compileRender(kit, sources, { forBrand, musicReady: bedsReady(), libraryReady: musicLibraryReady() });
    if (!c.ok) return done({ status: "nothing_to_render", reason: c.reason });
    if (kit.preview?.key === c.key && (await live(port, athleteId, kit.preview, !!opts.verify))) {
      if (!reconciled) return done({ status: "unchanged", key: c.key });
      // Same render, but the stored music or caption was stale: write the reconciled kit, keep the preview.
      const fixed: ActionDecisionDetail = { ...det, prepared: { ...(det.prepared ?? {}), postKit: kit } };
      const ok = await deps.store.updateDecision(athleteId, decisionId, {
        detail: fixed as unknown as Record<string, unknown>, ifUnchanged: { detail: d.detail ?? {}, response: d.response },
      });
      if (!ok) continue;
      return done({ status: "unchanged", key: c.key });
    }

    const reuse = await port.published(athleteId, decisionId, c.key);
    let preview: PostKitPreview;
    if (reuse) {
      const at = await port.clock();
      preview = {
        contract: POST_KIT_RENDER_CONTRACT, key: c.key, status: "ready", jobId: null, outputs: reuse,
        coverAssetId: coverAssetFor(c.plan, reuse), notes: c.notes, error: null, requestedAt: at, renderedAt: at,
      };
    } else {
      // One job per key per call, however many times the write below has to be retried.
      if (!queued.has(c.key)) queued.set(c.key, await port.queue(athleteId, renderJobSpec(decisionId, c.plan, c.key)));
      const job = queued.get(c.key)!;
      preview = {
        contract: POST_KIT_RENDER_CONTRACT, key: c.key, status: "queued", jobId: job.jobId, outputs: [],
        coverAssetId: null, notes: c.notes, error: null, requestedAt: job.queuedAt, renderedAt: null,
      };
    }
    const detail: ActionDecisionDetail = { ...det, prepared: { ...(det.prepared ?? {}), postKit: { ...kit, preview } } };
    const written = await deps.store.updateDecision(athleteId, decisionId, {
      detail: detail as unknown as Record<string, unknown>, ifUnchanged: { detail: d.detail ?? {}, response: d.response },
    });
    if (!written) continue;
    // The preview this one replaced may still have a job on the queue (a stalled re-ask): it is cancelled, so two jobs
    // never work one kit. If it is already running it cannot be cancelled, but it no longer owns the kit (worker.ts
    // writes only for the preview's own job), so what it makes never lands.
    const replaced = kit.preview?.status === "queued" ? kit.preview.jobId : null;
    if (replaced && replaced !== preview.jobId) await port.cancel(athleteId, replaced);
    logger.info({ athleteId, decisionId, key: c.key, format: c.plan.format, positions: c.plan.positions.length, reused: !!reuse, notes: c.notes }, "post kit preview requested");
    if (reuse) return done({ status: "reused", key: c.key });
    const out = await done({ status: "queued", key: c.key, jobId: preview.jobId! });
    port.kick();
    return out;
  }
  return done({ status: "conflict" });
}

/**
 * Ask, and swallow: a kit is built or edited whether or not its preview could be asked for. For the build and the two
 * edits, where the preview is a by-product.
 */
export async function requestQuietly(deps: PostKitDeps, athleteId: string, decisionId: string): Promise<RenderRequestOutcome | null> {
  try {
    return await requestPostKitRender(deps, athleteId, decisionId);
  } catch (err: any) {
    logger.warn({ athleteId, decisionId, error: String(err?.message ?? err).slice(0, 300) }, "post kit preview could not be requested");
    return null;
  }
}

/** The preview as a screen draws it, signed now. Without a render port (render off), the urls are null. */
export async function previewView(deps: PostKitDeps, athleteId: string, kit: PostKit | null): Promise<PostKitPreviewView | null> {
  const p = kit?.preview;
  if (!p) return null;
  const signed = p.status === "ready" && deps.render ? await deps.render.sign(athleteId, p) : { items: p.outputs.map(() => null), coverUrl: null };
  return {
    status: p.status,
    previewUrl: signed.items[0] ?? null,
    items: p.outputs.map((o, i) => ({ kind: o.kind, url: signed.items[i] ?? null })),
    coverUrl: signed.coverUrl,
    notes: p.notes,
    error: p.error,
  };
}
