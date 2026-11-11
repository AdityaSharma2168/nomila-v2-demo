/**
 * cameraRollIntakeLogic.test — the intake's pure rules on the phone: what a review looks at and how far back, bursts
 * collapsed before any preview is made (videos never), upload types, the daily-cap answer, what arrives pre-ticked
 * (every keeper — or, for a post, the one best match of the kind it wants), the tally and the error line, and the
 * shared ask codec a chat card or a post kit hands the review.
 */
import {
  BURST_WINDOW_MS, collapseBursts, contentTypeOf, createdAfterFor, dailyLimitOf, durationLabel, errorLineOf, importTally,
  initialTicks, mediaTypesFor, reviewCopy,
} from "./cameraRollIntakeLogic";
import { encodeCameraRollAsk, parseCameraRollAsk } from "../../shared/cameraRollIntake";

describe("what a review looks at", () => {
  it("photos · videos · both", () => {
    expect([mediaTypesFor("photos"), mediaTypesFor("videos"), mediaTypesFor("all")]).toEqual([["photo"], ["video"], ["photo", "video"]]);
  });
  it("how far back: nothing for 'since last review', else a dated window", () => {
    const now = Date.UTC(2026, 9, 12);
    expect(createdAfterFor("last_review", now)).toBeUndefined();
    expect(createdAfterFor("7d", now)).toBe(now - 7 * 86_400_000);
    expect(createdAfterFor("30d", now)).toBe(now - 30 * 86_400_000);
  });
});

describe("bursts", () => {
  const a = (id: string, t: number, mediaType = "photo", w = 3000, h = 4000) => ({ id, creationTime: t, mediaType, width: w, height: h });
  it("near-identical frames shot within a moment become the first; videos are never collapsed", () => {
    const t = 1_000_000;
    const r = collapseBursts([a("p1", t), a("p2", t - 300), a("p3", t - 600), a("v1", t - 700, "video"), a("v2", t - 800, "video"), a("p4", t - 900 - BURST_WINDOW_MS)]);
    expect(r.kept.map((x) => x.id)).toEqual(["p1", "v1", "v2", "p4"]);
    expect(r.skipped).toBe(2);
  });
  it("a different frame size is a different photo, however close in time", () => {
    expect(collapseBursts([a("p1", 1000), a("p2", 900, "photo", 4000, 3000)]).kept).toHaveLength(2);
  });
});

describe("upload types", () => {
  it.each([
    ["IMG_1.MOV", "video", "video/quicktime"], ["clip.mp4", "video", "video/mp4"], ["noext", "video", "video/mp4"],
    ["a.HEIC", "photo", "image/heic"], ["a.png", "photo", "image/png"], ["a.jpg", "photo", "image/jpeg"],
  ] as const)("%s (%s) → %s", (name, kind, type) => { expect(contentTypeOf(name, kind)).toBe(type); });
});

describe("the server's answers", () => {
  it("the daily cap, read out of the error; any other error is not it", () => {
    const err = new Error(`429: ${JSON.stringify({ error: "That's the most for today. The rest can be reviewed tomorrow.", code: "daily_limit", limit: 600, used: 590 })}`);
    expect(dailyLimitOf(err)).toEqual({ message: "That's the most for today. The rest can be reviewed tomorrow.", limit: 600, used: 590 });
    expect(dailyLimitOf(new Error("429: plain text"))).toBeNull();
    expect(dailyLimitOf(new Error(`500: ${JSON.stringify({ code: "daily_limit" })}`))).toBeNull();
  });
  it("the server's own sentence, else the fallback", () => {
    expect(errorLineOf(new Error(`409: ${JSON.stringify({ error: "Nomila is still looking at that one. Try again in a minute.", code: "untagged" })}`), "x")).toBe("Nomila is still looking at that one. Try again in a minute.");
    expect(errorLineOf(new Error("Network request failed"), "fallback")).toBe("fallback");
  });
});

describe("what arrives ticked", () => {
  const keepers = [
    { id: "p-best", kind: "photo" as const, rank: 0.9 },
    { id: "v-good", kind: "video" as const, rank: 0.7 },
    { id: "v-best", kind: "video" as const, rank: 0.8 },
  ];
  it("a general review: every keeper", () => {
    expect([...initialTicks(keepers, false, "all")].sort()).toEqual(["p-best", "v-best", "v-good"]);
  });
  it("for a post that wants a clip: only the best clip", () => {
    expect([...initialTicks(keepers, true, "videos")]).toEqual(["v-best"]);
  });
  it("for a post that wants either: only the best of all", () => {
    expect([...initialTicks(keepers, true, "all")]).toEqual(["p-best"]);
  });
  it("nothing kept: nothing ticked", () => {
    expect(initialTicks([], true, "videos").size).toBe(0);
  });
});

describe("words", () => {
  it("the tally", () => {
    expect(importTally([{ media_type: "IMAGE" }, { media_type: "IMAGE" }, { media_type: "VIDEO" }], 0)).toBe("Added 2 photos and 1 video to your library");
    expect(importTally([{ media_type: "VIDEO" }], 2)).toBe("Added 1 video to your library — 2 didn't make it");
  });
  it("a clip's length", () => {
    expect([durationLabel(7.4), durationLabel(65), durationLabel(0), durationLabel(null)]).toEqual(["0:07", "1:05", null, null]);
  });
  it("the screen's words say only previews leave the phone, and what a targeted review looks for", () => {
    expect(reviewCopy("videos", null).lede).toMatch(/Only a small preview of each leaves your phone/);
    expect(reviewCopy("videos", "a short clip of the warm-up.").lede).toMatch(/for a short clip of the warm-up\. Only/);
    expect(reviewCopy("all", "x").start).toBe("Find it");
  });
});

describe("the ask codec (shared)", () => {
  it("round-trips, and refuses what it is not", () => {
    const ask = { kind: "videos" as const, since: "7d" as const, forPost: "3f1c2a9e-1111-4111-8111-111111111111" };
    expect(parseCameraRollAsk(encodeCameraRollAsk(ask))).toEqual(ask);
    expect(parseCameraRollAsk(encodeCameraRollAsk({ ...ask, forPost: null }))).toEqual({ ...ask, forPost: null });
    for (const bad of ["", "videos", "gifs.7d", "videos.1y", "videos.7d.bad id!", "a.b.c.d", null, undefined]) expect(parseCameraRollAsk(bad)).toBeNull();
  });
});
