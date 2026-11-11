/**
 * goalsLogic.test — the post row's rules (design "Goals tab post details + plan ready", 12 Oct 2026): every row state
 * from the served kit in short and the plan run in progress (including the 10-minute preview stall, the kit screen's own
 * rule), the eyebrow, the status words, the one button, the opened row's media line and the "plan updated" notice.
 */
import { PREVIEW_STALL_MS } from "../../components/postKit/preview";
import { ACTION_POST_NO_KIT, ACTION_POST_READY, actionPostPreparing, goalsPostsFixture } from "./goalsFixtures";
import {
  GOALS_UPDATING_COPY, kitMediaLine, postButton, postEyebrow, postHookLine, postRowStallAt, postRowState, postsThisWeek, postStatus,
} from "./goalsLogic";
import type { GoalActionView } from "../../../shared/plan";

const NOW = Date.parse("2026-10-12T10:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const planningAt = (step: "plan" | "post_kits" | "tell") => ({ runId: "run-2", step, startedAt: ago(60_000) });

describe("postRowState: every state", () => {
  it("ready: built, preview ready or never asked for", () => {
    expect(postRowState(ACTION_POST_READY, null, NOW)).toBe("ready");
    expect(postRowState({ ...ACTION_POST_READY, kit: { ...ACTION_POST_READY.kit!, preview: null } }, null, NOW)).toBe("ready");
  });
  it("preparing inside the stall window; preview failed past it (the kit screen's 10 minutes), and when it failed", () => {
    expect(postRowState(actionPostPreparing(ago(PREVIEW_STALL_MS - 1000)), null, NOW)).toBe("preparing");
    expect(postRowState(actionPostPreparing(ago(PREVIEW_STALL_MS)), null, NOW)).toBe("preview_failed");
    const failed: GoalActionView = { ...ACTION_POST_READY, kit: { ...ACTION_POST_READY.kit!, preview: { status: "failed", requestedAt: ago(1000) } } };
    expect(postRowState(failed, null, NOW)).toBe("preview_failed");
    expect(postRowStallAt(actionPostPreparing(ago(1000)))).toBe(NOW - 1000 + PREVIEW_STALL_MS);
    expect(postRowStallAt(ACTION_POST_READY)).toBeNull();
  });
  it("building only while the run is on its post_kits step; otherwise no kit", () => {
    expect(postRowState(ACTION_POST_NO_KIT, planningAt("post_kits"), NOW)).toBe("building");
    expect(postRowState(ACTION_POST_NO_KIT, planningAt("plan"), NOW)).toBe("no_kit");
    expect(postRowState(ACTION_POST_NO_KIT, null, NOW)).toBe("no_kit");
  });
  it("needs media: a kit with none of her assets; done: posted", () => {
    expect(postRowState({ ...ACTION_POST_READY, kit: { built: true, assets: 0, aiGenerationNeeded: true, preview: null } }, null, NOW)).toBe("needs_media");
    expect(postRowState({ ...ACTION_POST_READY, state: "done" }, planningAt("post_kits"), NOW)).toBe("done");
  });
});

describe("the row's words", () => {
  it("eyebrow: format · Before <moment>, else the pillar, else the format alone", () => {
    expect(postEyebrow(ACTION_POST_READY)).toBe("Reel · Before [Event A]");
    expect(postEyebrow(actionPostPreparing(ago(0)))).toBe("Carousel · Behind the scenes");
    expect(postEyebrow({ ...ACTION_POST_NO_KIT, pillar: null })).toBe("Story");
    expect(postEyebrow({ ...ACTION_POST_NO_KIT, pillar: null, post: { ...ACTION_POST_NO_KIT.post!, format: "feed" } })).toBe("Photo post");
  });
  it("the opening line in curly quotes, never doubled", () => {
    expect(postHookLine("Nobody sees the early part.")).toBe("“Nobody sees the early part.”");
    expect(postHookLine("“Already quoted”")).toBe("“Already quoted”");
  });
  it("status: Kit ready waits on her (blue) with its date; the spinners; needs media names what is missing", () => {
    expect(postStatus(ACTION_POST_READY, "ready")).toEqual({ text: "Kit ready", waiting: true, spinner: false, date: "Sun 18 Oct" });
    expect(postStatus(ACTION_POST_READY, "preparing")).toMatchObject({ text: "Preparing your preview", spinner: true, date: null });
    expect(postStatus(ACTION_POST_READY, "building")).toMatchObject({ text: "Mila is building your kit", spinner: true });
    expect(postStatus(ACTION_POST_READY, "preview_failed").text).toBe("Preview didn't come out");
    // The noun comes from the plan's own words, never the format; unclear → the neutral "something".
    const needs = (mediaNeeds: string) => postStatus({ ...ACTION_POST_READY, post: { ...ACTION_POST_READY.post!, mediaNeeds } }, "needs_media").text;
    expect(needs("A clip of you talking to camera.")).toBe("Needs a clip you don't have yet");
    expect(needs("Three photos, one per thing.")).toBe("Needs a photo you don't have yet");
    expect(needs("One warm-up clip and one still of you arriving.")).toBe("Needs something you don't have yet");
    expect(needs("Your teammates at the opener.")).toBe("Needs something you don't have yet");
    expect(postStatus({ ...ACTION_POST_READY, post: null }, "needs_media").text).toBe("Needs something you don't have yet");
    expect(postStatus(ACTION_POST_NO_KIT, "no_kit")).toMatchObject({ text: "No kit yet", date: "Sat 17 Oct", waiting: false });
    expect(postStatus(ACTION_POST_READY, "done").text).toBe("Posted");
  });
  it("one button: Open kit (off while building), Build it with no kit, none once posted", () => {
    expect(postButton("ready")).toEqual({ label: "Open kit", build: false, disabled: false });
    expect(postButton("preview_failed")).toMatchObject({ label: "Open kit", disabled: false });
    expect(postButton("building")).toEqual({ label: "Open kit", build: false, disabled: true });
    expect(postButton("no_kit")).toEqual({ label: "Build it", build: true, disabled: false });
    expect(postButton("done")).toBeNull();
  });
  it("the opened row's media line counts the kit's own picks", () => {
    expect(kitMediaLine([{ mediaType: "clip", inKit: true }, { mediaType: "clip", inKit: true }, { mediaType: "photo", inKit: false }])).toBe("Cut from 2 clips in your library");
    expect(kitMediaLine([{ mediaType: "photo", inKit: true }])).toBe("Made from 1 photo in your library");
    expect(kitMediaLine([{ mediaType: "photo", inKit: true }, { mediaType: "clip", inKit: true }])).toBe("Made from 1 photo and 1 clip in your library");
    expect(kitMediaLine([{ mediaType: "photo", inKit: false }])).toBeNull();
  });
  it("the plan-updated notice counts the posts still to do this week", () => {
    const g = goalsPostsFixture();
    expect(postsThisWeek(g.goals)).toBe(3);
    expect(GOALS_UPDATING_COPY.done(3)).toBe("Your plan is updated: 3 posts this week.");
    expect(GOALS_UPDATING_COPY.done(1)).toBe("Your plan is updated: 1 post this week.");
    expect(GOALS_UPDATING_COPY.done(0)).toBe("Your plan is updated.");
  });
});
