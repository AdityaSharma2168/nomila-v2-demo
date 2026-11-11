/**
 * postKit/copy — the post kit's words, shared by the kit screen (screens/agent/PostKitScreen.tsx) and the For you feed
 * (screens/agent/StudioForYouScreen.tsx), and the two mappings from a server answer to one plain-words line: a failed
 * write (writeFailLine) and a build that made nothing (buildOutcomeLine). The server's own message is never shown.
 */
import { apiErrorOf, type PostKitBuildOutcome, type PostKitWrite } from "../../lib/agent/api";
import { POST_KIT_CAPTION_CHARS } from "../../../shared/postKit";

export const POST_KIT_COPY = {
  back: "Studio",
  title: "Post kit",
  idea: "The idea",
  why: "Why this, now",
  timedFor: (name: string) => `Timed for ${name}`,
  forGoal: (goal: string) => `For: ${goal}`,
  caption: "Caption",
  save: "Save caption",
  swap: "Swap",
  swapLabel: (kind: "photo" | "clip") => `Swap this ${kind} for another`,
  swapOption: (kind: "photo" | "clip", n: number, of: number) => `Use this ${kind} instead, ${n} of ${of}`,
  playClip: "Play this clip again",
  showClip: "Play this clip",
  posted: "I posted it",
  confirmPosted: "Confirm posted",
  confirmLine: "Tap again to confirm you've posted it yourself.",
  done: "Posted",
  doneLine: "You marked this one posted, so it can't be changed now.",
  share: "Share / Save",
  error: "Couldn't load this post kit.",
  retry: "Retry",
  closedTitle: "This one's no longer open",
  closedLine: "It came off your plan, so there's nothing left to post here.",
  noKit: "Nothing's built for this one yet.",
  build: "Build it",
  building: "Mila is building your post kit…",
  swapTitle: "Swap this one for",
  swapEmpty: "Nothing else in your library fits this post yet.",
  noAssets: "Nothing in your library fits this post yet.",
  /** EXPO_PUBLIC_CAMERA_ROLL_INTAKE: the targeted ask's button on a kit with nothing of hers yet. */
  checkCameraRoll: (format: string) => (format === "reel" || format === "story" ? "Check your camera roll for a clip" : "Check your camera roll for this post"),
  // A failed write, in plain words — never the server's own message.
  failDone: "This one's already marked posted, so it can't change.",
  failConflict: "This post kit changed somewhere else. Here's the latest.",
  failClosed: "This one's no longer open.",
  failSwapOption: "That one can't go in this post anymore. Pick another.",
  failCaptionEmpty: "Add a few words before saving.",
  failCaptionLong: `A caption can be up to ${POST_KIT_CAPTION_CHARS.toLocaleString("en-US")} characters.`,
  failGoal: "This one waits until its goal is kept.",
  failSwap: "Couldn't swap that. Try again.",
  failCaption: "Couldn't save your caption. Try again.",
  failPosted: "Couldn't mark it posted. Try again.",
  failBuild: "Couldn't build this one. Try again.",
  // "Build it" answered without a kit (the build's outcome), in plain words. The two caps are money; the count is kits.
  buildHeld: "This one touches something you asked to keep out of your posts, so Mila didn't build it.",
  /** Held by the final guard (server/agent/postKit/finalGuard.ts), by why. */
  buildHeldNumber: "This one leans on a number Mila couldn't check against your facts, so Mila didn't build it.",
  buildHeldOnCard: "This one's opening line has a price, a contact detail or the M.I.A., which can't go on a post, so Mila didn't build it.",
  buildHeldNothingLeft: "Nothing would be left to post once the parts Mila couldn't check came out, so Mila didn't build it.",
  buildDayCap: "Mila has used today's budget for post kits. Try again tomorrow.",
  buildWeekCap: "Mila has used this week's budget for post kits. Try again next week.",
  buildWeekCount: "That's this week's post kits made. Try again next week.",
  buildChanged: "This one changed while it was being built. Try again.",
  // The rendered preview (preview.ts): the raw media shows meanwhile.
  inThisPost: "What's in it",
  previewPreparing: "Preparing your preview",
  previewFailed: "Your preview didn't come out.",
  previewRetry: "Try again",
  previewStillMaking: "Still being made. Try again in a few minutes.",
  failPreview: "Couldn't ask for your preview again. Try again.",
  failPreviewGone: "None of this post's photos or clips are in your library anymore.",
  // The suggested music (MusicChoices.tsx).
  music: "Music",
  musicHint: "Tap play to hear a track with your preview.",
  musicUse: "Use this",
  musicUseLabel: (title: string) => `Use ${title} in your post`,
  musicInUse: "In your post",
  musicNone: "No music",
  musicPlay: (title: string) => `Play ${title} with your preview`,
  musicStop: (title: string) => `Stop ${title}`,
  musicCredit: "This track's credit stays at the end of your caption.",
  musicContentId: "May get a YouTube claim; paste the credit in the description.",
  musicNotForBrand: "Not for brand posts",
  failMusicNoRoom: "Your caption is too long to add this track's credit. Shorten it first, or pick another track.",
  failCaptionNoRoom: "Leave room at the end for the music credit, or pick a track that doesn't need one.",
  musicInApp: "Want a trending sound? Add it in Instagram or TikTok when you post.",
  musicUnavailable: "Not ready to play yet",
  failMusic: "Couldn't change the music. Try again.",
  failMusicOption: "That track can't go in this post. Pick another.",
  /** EXPO_PUBLIC_CAMERA_ROLL_INTAKE: what she imported for this post couldn't go into its kit. */
  failUse: "It's in your library, but it couldn't go into this post's kit. Try again.",
} as const;

/**
 * Why "Build it" made nothing, from the build's outcome (client/lib/agent/api.ts PostKitBuildOutcome): held for her
 * never-list; skipped for today's or this week's budget, or this week's number of kits; changed elsewhere meanwhile;
 * or — anything else, or no outcome — the plain "couldn't build". Only asked when the fresh read still has no kit.
 */
export function buildOutcomeLine(outcome: PostKitBuildOutcome | null): string {
  if (outcome?.status === "held") {
    if (outcome.reason === "final_guard" && outcome.block === "number_is_the_point") return POST_KIT_COPY.buildHeldNumber;
    if (outcome.reason === "final_guard" && outcome.block === "on_card") return POST_KIT_COPY.buildHeldOnCard;
    if (outcome.reason === "final_guard" && outcome.block === "nothing_left") return POST_KIT_COPY.buildHeldNothingLeft;
    return POST_KIT_COPY.buildHeld;   // never_content, or the words you asked to keep out (never-use, avoided, care)
  }
  if (outcome?.status === "skipped") {
    if (outcome.reason === "day_cap") return POST_KIT_COPY.buildDayCap;
    if (outcome.reason === "week_count") return POST_KIT_COPY.buildWeekCount;
    return POST_KIT_COPY.buildWeekCap;
  }
  if (outcome?.status === "conflict" || outcome?.status === "exists") return POST_KIT_COPY.buildChanged;
  return POST_KIT_COPY.failBuild;
}

/** A failed write as one plain-words line for her (the code picks it; the server's message is never shown). */
export function writeFailLine(op: PostKitWrite["op"], err: unknown): string {
  const { status, code } = apiErrorOf(err);
  if (code === "done") return POST_KIT_COPY.failDone;
  if (code === "conflict") return POST_KIT_COPY.failConflict;
  if (code === "closed" || code === "answered") return POST_KIT_COPY.failClosed;
  if (code === "goal_not_kept") return POST_KIT_COPY.failGoal;
  if (op === "swap" && (code === "unavailable" || code === "not_on_shortlist" || code === "format_mismatch" || code === "not_in_kit")) return POST_KIT_COPY.failSwapOption;
  if (op === "caption" && code === "too_long") return POST_KIT_COPY.failCaptionLong;
  if (op === "caption" && code === "no_room_for_credit") return POST_KIT_COPY.failCaptionNoRoom;
  if (op === "music" && code === "no_room_for_credit") return POST_KIT_COPY.failMusicNoRoom;
  if (op === "caption" && status === 400) return POST_KIT_COPY.failCaptionEmpty;
  if (op === "preview" && (code === "no_assets" || code === "nothing_to_render")) return POST_KIT_COPY.failPreviewGone;
  if (op === "music" && (code === "not_a_choice" || code === "not_brand_safe" || code === "not_offered" || code === "no_music_choices")) return POST_KIT_COPY.failMusicOption;
  return { swap: POST_KIT_COPY.failSwap, caption: POST_KIT_COPY.failCaption, posted: POST_KIT_COPY.failPosted, build: POST_KIT_COPY.failBuild, preview: POST_KIT_COPY.failPreview, music: POST_KIT_COPY.failMusic, use: POST_KIT_COPY.failUse }[op];
}
