/**
 * agent/media/tools.ts — Mila's media tools, one group (CAMERA_ROLL_INTAKE; design "Media Intake Plan", option c).
 *
 *   check_camera_roll   read   a one-tap card that opens the camera-roll review on her phone — filtered (photos, videos
 *                              or both; new since her last review, or the last 7 or 30 days) and, for a post that needs
 *                              media, biased toward what that post needs, with the pick going straight into its kit
 *
 * WHAT THE TOOL CANNOT DO, AND SAYS SO. Nomila never sees her camera roll: only her phone reads it, only while the app
 * is open, only with her photo permission, and only once she opens the review. So the tool never "looks" and never
 * reports anything about her photos — it offers the door. Its result tells the model exactly that, so a reply can't
 * claim otherwise.
 *
 * Gated by `enabled`: with the flag off, the registry leaves the tool out of every skill (ToolRegistry.forSkill), so the
 * chat's tools and prompt are exactly what they were. No tool takes an athlete id; the athlete is the run's.
 */
import { z } from "zod";
import type { ActionDecisionDetail } from "../../../shared/plan";
import type { ChatCard } from "../../../shared/agent";
import {
  CAMERA_ROLL_KINDS, CAMERA_ROLL_SCREEN, CAMERA_ROLL_SINCE, encodeCameraRollAsk,
  type CameraRollKind, type CameraRollSince,
} from "../../../shared/cameraRollIntake";
import { cameraRollIntakeEnabled } from "../../lib/cameraRollIntake";
import type { AgentStore } from "../research/store";
import { errorResult, okResult, type AgentTool, type ToolContext } from "../tools";

/** The description the model reads: what it does, when to use it, when not to, and what it can never claim. */
export const CHECK_CAMERA_ROLL_DESCRIPTION =
  "Show a one-tap card that opens a review of the athlete's phone camera roll, so they can add new photos or videos to their library: their phone makes small previews, Nomila scores them, and they pick what to import. " +
  "Use when: they want to add recent photos or clips; a post of theirs needs a photo or clip they don't have in their library yet (pass for_post with that post action's id); they mention something they shot recently that would make a good post. " +
  "Don't use: to find something already in their library (media_search does that); to upload or post anything for them; when they have just closed a review; more than once in a conversation. " +
  "Nomila cannot see their camera roll. Never say you looked at, found or chose any photo or video: say the card opens the review on their phone.";

/** What the card says, by what it looks at. */
export function cameraRollLabel(kind: CameraRollKind, forPost: boolean): string {
  if (forPost) return kind === "videos" ? "Check your camera roll for a clip for this post" : "Check your camera roll for this post";
  return kind === "videos" ? "Check your camera roll for new videos" : kind === "photos" ? "Check your camera roll for new photos" : "Check your camera roll";
}

/** Turns that already offered the review (at most once a turn; the description asks once a conversation). */
const offered = new WeakMap<object, true>();

export function mediaTools(store: AgentStore): AgentTool[] {
  const checkCameraRoll: AgentTool = {
    name: "check_camera_roll",
    description: CHECK_CAMERA_ROLL_DESCRIPTION,
    kind: "ours",
    permission: "read",
    enabled: cameraRollIntakeEnabled,
    args: z.object({
      kind: z.enum(CAMERA_ROLL_KINDS).optional().describe("What to look at: photos, videos or all (default all). Use videos when the need is a clip."),
      since: z.enum(CAMERA_ROLL_SINCE).optional().describe("How far back: last_review (everything new since their last review, the default), 7d or 30d."),
      for_post: z.string().max(80).optional().describe("A post action's id, when the review is for one post that needs media. The pick then goes straight into that post's kit."),
      why: z.string().max(200).optional().describe("One short line on why now, in plain words, for the card."),
    }),
    async execute(ctx: ToolContext, a: { kind?: CameraRollKind; since?: CameraRollSince; for_post?: string; why?: string }) {
      if (!cameraRollIntakeEnabled()) return errorResult("the camera-roll review is not available: do not offer it");
      if (ctx.turn && offered.has(ctx.turn)) return errorResult("the camera-roll review was already offered in this turn: do not offer it again");
      let forPost: string | null = null;
      let kind: CameraRollKind = a.kind ?? "all";
      if (a.for_post) {
        const id = a.for_post.trim();
        const d = await store.getDecision(ctx.athleteId, id).catch(() => null);
        const det = (d?.detail ?? {}) as Partial<ActionDecisionDetail>;
        if (!d || d.kind !== "action" || det.kind !== "post") {
          return errorResult("for_post is not one of the athlete's post actions: call again without for_post to open a general review, or use the post's action id from CONTEXT");
        }
        if (d.response !== "pending") return errorResult("that post is already done or closed: offer a general review without for_post instead");
        forPost = d.id;
        if (!a.kind && det.post && ["reel", "story"].includes(String(det.post.format))) kind = "videos";
      }
      if (ctx.turn) offered.set(ctx.turn, true);
      const since: CameraRollSince = a.since ?? "last_review";
      return okResult({
        id: encodeCameraRollAsk({ kind, since, forPost }),
        label: cameraRollLabel(kind, forPost !== null),
        why: String(a.why ?? "").replace(/\s+/g, " ").trim(),
        note: "A card is shown. Nothing has been looked at yet: the review runs on their phone when they tap it. Do not describe any photo or video.",
      });
    },
    card(result, ctx): ChatCard | null {
      const r = result as { id?: string; label?: string; why?: string };
      if (!r.id || !r.label) return null;
      return {
        id: `camera-roll:${ctx.runId}:${r.id}`, kind: "open-screen", title: r.label,
        payload: { screen: CAMERA_ROLL_SCREEN, id: r.id, label: r.label, why: r.why ?? "" },
        links: [{ label: "Open the review", target: { screen: CAMERA_ROLL_SCREEN, id: r.id } }], runId: ctx.runId,
      };
    },
  };
  return [checkCameraRoll];
}
