/**
 * agent/postKit/intake.ts — the post kit's half of the targeted camera-roll ask (CAMERA_ROLL_INTAKE; design "Media
 * Intake Plan", option c).
 *
 * A kit that was built with nothing of hers in it ("Needs a clip you don't have yet") offers "Check your camera roll
 * for …". That opens the review already filtered and biased toward what the post needs; the clip she picks is imported
 * and then put straight into that kit (edit.ts useAsset).
 *
 *   postNeeds   what one post action needs, in the post's own words, and whether it wants a clip — read through the
 *               athlete-scoped store, so another athlete's action is simply null. The words are EMBEDDED to bias the
 *               ranking (routes/media.ts); they never enter a prompt.
 */
import type { ActionDecisionDetail } from "../../../shared/plan";
import type { CameraRollKind } from "../../../shared/cameraRollIntake";
import { LOOKING_FOR_MAX_CHARS } from "../../../shared/cameraRollIntake";
import { neverTermsFrom } from "../neverTerms";
import { dayWords } from "../plan/goals";
import type { AgentStore } from "../research/store";
import type { Preference } from "../../../shared/agent";
import { momentFor } from "./build";
import { isVideoFormat, postSpecOf } from "./kit";

export interface PostNeeds {
  /** What to look for, in the post's own words (its media needs, else what it shows). */
  lookingFor: string;
  /** Which items the review should look at first. */
  kind: CameraRollKind;
}

/** Whether the post's own words name only video. The same reading the Goals row uses for "Needs a clip". */
const namesOnlyVideo = (t: string): boolean => {
  const s = t.toLowerCase();
  return /\b(clips?|videos?|footage|reels?)\b/.test(s) && !/\b(photos?|stills?|pictures?|images?|selfies?)\b/.test(s);
};

export async function postNeeds(
  store: AgentStore, preferences: (athleteId: string) => Promise<Preference[]>, athleteId: string, decisionId: string,
): Promise<PostNeeds | null> {
  const d = await store.getDecision(athleteId, decisionId);
  if (!d || d.kind !== "action") return null;
  const det = (d.detail ?? {}) as unknown as ActionDecisionDetail;
  if (det.kind !== "post") return null;
  const neverTerms = neverTermsFrom(await preferences(athleteId));
  const spec = postSpecOf(det, d.suggested, await momentFor(store, athleteId, det), neverTerms, dayWords);
  const lookingFor = (spec.mediaNeeds || spec.brief.show).replace(/\s+/g, " ").trim().slice(0, LOOKING_FOR_MAX_CHARS);
  if (!lookingFor) return null;
  const wantsClip = (spec.formatFixed && isVideoFormat(spec.idea.format)) || namesOnlyVideo(spec.mediaNeeds);
  return { lookingFor, kind: wantsClip ? "videos" : "all" };
}
