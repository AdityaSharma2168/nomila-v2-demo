/**
 * agent/postKit/render/verify.ts — check before deliver (A4) for a post kit's preview render: every file the render
 * wrote, read off the disk BEFORE anything is uploaded or the kit is marked ready (worker.ts).
 *
 *   video    ffprobe reads it; its length is the plan's (a reel: plan.totalSec; a clip slide: its cut), within the
 *            structure check's slack; sound when a bed was laid; the plan's frame; a size between 1 byte and the
 *            upload cap
 *   picture  it decodes at the plan's frame; a size between 1 byte and the upload cap
 *
 * One failing file fails the render: the preview is a set, and half a carousel is not ready either. $0, local.
 */
import { durationAround, verifyDeliverable, type VerifyFailure, type VerifyResult, type VideoFacts, type ImageFacts } from "../../../services/verify/deliverable";
import type { RenderPlan } from "./compile";
import type { LocalRender } from "./local";

/** The upload caps a published output must fit (lib/mediaStore UPLOAD_LIMITS). */
const MAX_BYTES = { video: 200 * 1024 * 1024, image: 25 * 1024 * 1024 } as const;

export interface RenderReaders {
  video?: (path: string) => Promise<VideoFacts>;
  image?: (path: string) => Promise<ImageFacts>;
}

/** Each output's expected length: a reel is the plan's whole timeline; a clip slide is its own position's cut. */
function expectedSec(plan: RenderPlan, sourceAssetId: string, used: Set<number>): number | null {
  if (plan.output === "video") return plan.totalSec;
  const i = plan.positions.findIndex((p, ix) => !used.has(ix) && p.assetId === sourceAssetId && p.kind === "clip");
  if (i < 0) return null;
  used.add(i);
  const p = plan.positions[i];
  return p.trimEndSec! - p.trimStartSec!;
}

export async function verifyRender(plan: RenderPlan, render: LocalRender, readers: RenderReaders = {}): Promise<VerifyResult> {
  const failures: VerifyFailure[] = [];
  const checked = new Set<string>();
  const used = new Set<number>();
  if (!render.outputs.length) failures.push({ check: "readable", reason: "the render wrote no output" });
  for (const [i, o] of render.outputs.entries()) {
    const r = o.kind === "video"
      ? await verifyDeliverable("video", { path: o.path }, {
          durationSec: (() => { const s = expectedSec(plan, o.sourceAssetId, used); return s === null ? undefined : durationAround(s); })(),
          audio: plan.output === "video" && !!plan.bed,
          width: plan.width, height: plan.height, bytes: { min: 1, max: MAX_BYTES.video }, read: readers.video,
        })
      : await verifyDeliverable("image", { path: o.path }, {
          width: plan.width, height: plan.height, bytes: { min: 1, max: MAX_BYTES.image }, read: readers.image,
        });
    r.checked.forEach((c) => checked.add(c));
    if (!r.ok) failures.push(...r.failures.map((f) => ({ ...f, reason: `output ${i}: ${f.reason}` })));
  }
  const kind = plan.output === "video" ? "video" : "image";
  return failures.length ? { ok: false, kind, status: "needs_a_look", checked: [...checked], failures } : { ok: true, kind, checked: [...checked] };
}
