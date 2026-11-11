import type { StudioItem } from "./agent/types";
import type { StoryItem } from "./homeV3Logic";
import { coverCaption, coverName, dotOf, feedAction, feedChip, feedEntries, feedLine, feedStartIndex, studioEmpty, studioGrid, studioPostTitle, studioShelves, tileOf } from "./studioV3Logic";

const NOW = new Date(2026, 9, 20, 9, 0, 0);

const item = (o: Partial<StudioItem> & Pick<StudioItem, "id" | "kind">): StudioItem => ({
  title: "Untitled", status: "draft", version: 1, goal: null, thumbUrl: null, updatedAt: "2026-10-19T00:00:00Z", meta: null, open: null, ...o,
});

const moment = (o: Partial<StoryItem> & Pick<StoryItem, "id">): StoryItem => ({
  circle: "moments", kicker: "Sat 7 Nov", title: "A final", line: null,
  action: { label: "Make this post", target: { screen: "mila", draft: "Help me" } }, ...o,
});

describe("studioPostTitle", () => {
  it("titles a post by its hook, as Home does", () => {
    expect(studioPostTitle({ title: "Review your captaincy portrait", hook: "Captain's armband, day one." })).toBe("Captain's armband, day one.");
  });
  it("drops the chore verb when there is no hook", () => {
    expect(studioPostTitle({ title: "Review your captaincy portrait", hook: null })).toBe("Captaincy portrait");
  });
});

describe("dotOf", () => {
  it("is green once posted, grey while Mila works, pink otherwise", () => {
    expect(dotOf({ kind: "post_kit", status: "published" })).toBe("posted");
    expect(dotOf({ kind: "post_kit", status: "draft", working: true })).toBe("working");
    expect(dotOf({ kind: "post_kit", status: "draft" })).toBe("ready");
    expect(dotOf({ kind: "deck", status: "draft" })).toBe("working");
    expect(dotOf({ kind: "deck", status: "approved" })).toBe("ready");
  });
});

describe("studioShelves", () => {
  const items = [
    item({ id: "p1", kind: "post_kit", dueOn: "2026-10-22", hook: "Road trip.", format: "feed", updatedAt: "2026-10-18T00:00:00Z" }),
    item({ id: "p2", kind: "post_kit", dueOn: "2026-10-20", hook: "Day one.", format: "reel" }),
    item({ id: "p3", kind: "post_kit", status: "published", hook: "Done." }),
    item({ id: "deck-1", kind: "deck", title: "adidas America Inc.", status: "published", logoUrl: "https://logo/x.png" }),
  ];
  const moments = [moment({ id: "moment:a" }), moment({ id: "moment:b", kitActionId: "p1" })];
  const shelves = studioShelves(items, moments, NOW);

  it("keeps the four shelves in order", () => {
    expect(shelves.map((s) => s.key)).toEqual(["ready", "ideas", "posted", "decks"]);
  });
  it("puts the soonest-due post first in Ready, with Home's title and a relative day", () => {
    const ready = shelves[0].tiles;
    expect(ready.map((t) => t.id)).toEqual(["p2", "p1"]);
    expect(ready[0]).toMatchObject({ title: "Day one.", kicker: "Today · Reel", dot: "ready", open: { to: "feed", id: "p2" } });
  });
  it("lists only moments with nothing prepared as ideas", () => {
    expect(shelves[1].tiles.map((t) => t.id)).toEqual(["moment:a"]);
  });
  it("opens a posted kit on its kit screen", () => {
    expect(shelves[2].tiles[0]).toMatchObject({ id: "p3", dot: "posted", open: { to: "kit", id: "p3" } });
  });
  it("shows a deck with its brand's short name and logo", () => {
    expect(shelves[3].tiles[0]).toMatchObject({ title: "adidas", logoUrl: "https://logo/x.png", shape: "cover", kicker: "Deck" });
  });
  it("is empty only when every shelf is", () => {
    expect(studioEmpty(shelves)).toBe(false);
    expect(studioEmpty(studioShelves([], [], NOW))).toBe(true);
  });
});

describe("studioGrid", () => {
  it("lists every made item newest first", () => {
    const g = studioGrid([item({ id: "a", kind: "post_kit", updatedAt: "2026-10-01T00:00:00Z" }), item({ id: "b", kind: "deck", updatedAt: "2026-10-05T00:00:00Z" })], NOW);
    expect(g.map((t) => t.id)).toEqual(["b", "a"]);
  });
});

describe("tileOf", () => {
  it("never shows jargon words", () => {
    const t = tileOf(item({ id: "x", kind: "post_kit", title: "Post kit v1", hook: "A line." }), NOW);
    expect(JSON.stringify(t)).not.toMatch(/Draft|v1|Post kit/);
  });

  it("a kit not yet posted never says Posted, even with no due day and no format (it sits in Ready for you)", () => {
    const k = item({ id: "k", kind: "post_kit", status: "draft", hook: "A question." });
    const t = tileOf(k, NOW);
    expect(t.dot).toBe("ready");
    expect(t.kicker).not.toMatch(/Posted/);
    expect(studioShelves([k], [], NOW).find((s) => s.key === "ready")!.tiles.map((x) => x.id)).toEqual(["k"]);
    expect(tileOf(item({ id: "p", kind: "post_kit", status: "published" }), NOW).kicker).toBe("Posted");
  });
});

describe("feedStartIndex", () => {
  it("starts on the tapped kit, else the first", () => {
    expect(feedStartIndex(["a", "b", "c"], "b")).toBe(1);
    expect(feedStartIndex(["a"], "z")).toBe(0);
    expect(feedStartIndex(["a"], null)).toBe(0);
  });
});

describe("the feed (Studio's default view)", () => {
  const items = [
    item({ id: "p1", kind: "post_kit", dueOn: "2026-10-22", hook: "Road trip.", format: "feed" }),
    item({ id: "p2", kind: "post_kit", dueOn: "2026-10-20", hook: "Day one.", format: "reel" }),
    item({ id: "p3", kind: "post_kit", status: "published", hook: "Done.", meta: "41 views" }),
    item({ id: "deck-1", kind: "deck", title: "gorjana", status: "published" }),
  ];
  const moments = [
    moment({ id: "moment:a", moment: { hook: "Light the lamps.", angle: null, whyNow: "Lots of fans celebrate", kind: "Holiday" } }),
    moment({ id: "moment:b", kitActionId: "p1" }),
  ];
  const feed = feedEntries(items, moments, NOW);

  it("runs Ready for you (soonest due) → ideas with nothing prepared → posted; decks stay in Browse", () => {
    expect(feed.map((e) => e.id)).toEqual(["p2", "p1", "moment:a", "p3"]);
  });
  it("says what each card is, in words, with one action", () => {
    expect(feedChip(feed[0])).toEqual({ dot: "ready", text: "Ready for you" });
    expect(feedAction(feed[0])).toBe("Review & post");
    expect(feedLine(feed[0])).toBe("Today · Reel");
    expect(feedChip(feed[2])).toEqual({ dot: "ready", text: "Idea · Holiday" });
    expect(feedAction(feed[2])).toBe("Make this post");
    expect(feedLine(feed[2])).toBe("Sat 7 Nov · Lots of fans celebrate");
    expect(feedChip(feed[3]).dot).toBe("posted");
    expect(feedAction(feed[3])).toBe("See it");
  });
});

describe("Decks & pages", () => {
  it("puts her brand book first, then pitches newest first", () => {
    const shelves = studioShelves([
      item({ id: "deck-1", kind: "deck", title: "gorjana", updatedAt: "2026-10-19T00:00:00Z" }),
      item({ id: "brand-book", kind: "page", title: "Your brand book", updatedAt: "2026-01-01T00:00:00Z" }),
      item({ id: "deck-2", kind: "deck", title: "Lilyeve", updatedAt: "2026-10-20T00:00:00Z" }),
    ], [], NOW);
    expect(shelves[3].tiles.map((t) => t.id)).toEqual(["brand-book", "deck-2", "deck-1"]);
  });
  it("sets a cover's name as the pitch cover does, and captions brand · type · status", () => {
    expect(coverName("Mia Bhuta")).toEqual({ first: "MIA", rest: "BHUTA" });
    expect(coverName("")).toEqual({ first: "", rest: "" });
    const deck = tileOf(item({ id: "d", kind: "deck", title: "adidas America Inc.", status: "approved" }), NOW);
    expect(coverCaption(deck)).toBe("adidas · Deck · Ready for you");
  });
});
