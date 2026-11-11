/**
 * tickGate — D6, as ruled (PR 20, docs/probes/ship.md item 4, ADI-S20-GO): "a tick whose flag is off does nothing and
 * spends nothing."
 *
 * The three scheduled Studio ticks (server/index.ts: studio-edit-tick, studio-video-tick, studio-stitch-tick) ask this
 * FIRST — before the advisory lock, before the runner module is even loaded — and answer `skipped` when it says no. So a
 * scheduler job created ahead of a flip is inert: no claim, no reap, no provider call, no ffmpeg.
 *
 *   edit   — STUDIO_ENABLED and STUDIO_IMAGE_EDIT_OPS: the typed edit routes are the only door that queues a mode='edit'
 *            job (studio/edit/routes.ts), and they 404 without IMAGE_EDIT_OPS.
 *   video  — STUDIO_ENABLED and STUDIO_VIDEO_ENABLED: the one flag between a request and a paid Veo / Seedance call.
 *   stitch — STUDIO_ENABLED: stitching is $0 ffmpeg and has no flag of its own; with Studio off nothing queues one —
 *            OR AGENT_POST_KITS + AGENT_POST_KIT_RENDER, which queue post-kit preview renders on the same queue.
 *
 * All three read through studioFlag, so STUDIO_ALL_ON opens them exactly as it opens their routes.
 *
 * ⚠️ WHAT D6 COSTS, ruled knowingly: turning a flag off mid-flight STALLS that queue — a clip already submitted to Veo
 * (paid) is not collected while STUDIO_VIDEO_ENABLED is off; its lease lapses and the next tick after the flag comes
 * back resumes it with its operation handle (studio/videoRunner.ts, the submit-once pair). Nothing is lost; nothing new
 * is spent. The publish tick is NOT gated here: it runs with STUDIO_PUBLISH_MODE off on purpose, to close what waited.
 *
 * ⚠️ MUTATIONS (tickGate.test.ts): make any gate always open — its "… does nothing while … is off" row reds by name;
 * delete a handler's gate check in server/index.ts — "every scheduled Studio tick asks the gate before its lock" reds.
 */
import {
  imageEditOpsEnabled,
  studioEnabled,
  studioVideoEnabled,
} from "./config";
import { agentPostKitRenderEnabled } from "../agent/postKit/config";

export type StudioTick = "edit" | "video" | "stitch";

export type TickGate = { run: true } | { run: false; reason: string };

/** Whether this tick may do anything at all right now. Read at call time, like every flag. */
export function tickGate(tick: StudioTick): TickGate {
  // The stitch queue also carries post-kit preview renders (agent/postKit/render, $0 ffmpeg like any stitch): with
  // those on, the stitch tick runs even while the Studio is dark, or a render whose lease lapsed would never resume.
  if (tick === "stitch" && agentPostKitRenderEnabled()) return { run: true };
  if (!studioEnabled()) return { run: false, reason: "STUDIO_ENABLED is off" };
  if (tick === "edit" && !imageEditOpsEnabled())
    return { run: false, reason: "STUDIO_IMAGE_EDIT_OPS is off" };
  if (tick === "video" && !studioVideoEnabled())
    return { run: false, reason: "STUDIO_VIDEO_ENABLED is off" };
  return { run: true };
}
