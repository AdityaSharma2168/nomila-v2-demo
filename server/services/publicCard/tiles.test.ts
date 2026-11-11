/**
 * tiles.test.ts — the four grid tiles (design v2.1: always four tiles, Create always present, fallbacks never repeat).
 */
import { resolveTileSlots, type TileSlotInput } from "./tiles";
import type { PublicTile } from "./view";

const chapters = [
  { id: "highlights", kind: "highlights" as const, title: "Highlights" },
  { id: "story", kind: "story" as const, title: "Story" },
  { id: "media", kind: "media" as const, title: "Media" },
  { id: "impact", kind: "impact" as const, title: "Impact" },
];
const ig = [{ network: "Instagram", url: "https://instagram.com/x", handle: "x" }];
const base: TileSlotInput = { firstName: "Alex", partnerOn: true, bookOn: true, shopOn: true, chapters, socials: ig };

const key = (t: PublicTile) => `${t.intent}|${t.label}|${t.subLabel}|${t.targetChapterId ?? ""}`;
const expectDistinct = (tiles: PublicTile[]) => expect(new Set(tiles.map(key)).size).toBe(tiles.length);

describe("resolveTileSlots", () => {
  it("all doors on: Partner · Book / Shop · Create, in slot order, with the approved sub-labels", () => {
    const t = resolveTileSlots(base);
    expect(t.map((x) => x.slot)).toEqual(["tl", "tr", "bl", "br"]);
    expect(t.map((x) => x.intent)).toEqual(["partner", "book", "shop", "create"]);
    expect(t.map((x) => x.subLabel)).toEqual([
      "Sponsorships, posts, interviews & more",
      "Book a session with Alex",
      "Things Alex uses",
      "Coming soon",
    ]);
    expect(t[3].soon).toBe(true);
  });

  it("one slot off → Story (opens the Story card)", () => {
    const t = resolveTileSlots({ ...base, shopOn: false });
    expect(t[2]).toMatchObject({ slot: "bl", intent: "story", label: "Story", subLabel: "See Alex's story", targetChapterId: "story" });
  });

  it("two slots off → Story, then Follow (her linked profiles)", () => {
    const t = resolveTileSlots({ ...base, bookOn: false, shopOn: false });
    expect(t[1]).toMatchObject({ intent: "story", targetChapterId: "story" });
    expect(t[2]).toMatchObject({ intent: "follow", label: "Follow", subLabel: "Alex on Instagram" });
    expectDistinct(t);
  });

  it("Follow names the network for one profile, and says 'social profiles' for several", () => {
    const two = [...ig, { network: "TikTok", url: "https://tiktok.com/@x", handle: "x" }];
    const t = resolveTileSlots({ ...base, bookOn: false, shopOn: false, socials: two });
    expect(t[2].subLabel).toBe("Alex's social profiles");
  });

  it("two slots off and no socials → the second Story tile opens the Media card, not the Story card", () => {
    const t = resolveTileSlots({ ...base, bookOn: false, shopOn: false, socials: [] });
    expect(t[1]).toMatchObject({ intent: "story", targetChapterId: "story" });
    expect(t[2]).toMatchObject({ intent: "story", targetChapterId: "media", subLabel: "Photos & videos of Alex" });
    expectDistinct(t);
  });

  it("Partner switched off → its slot falls back too (Partner first in the fallback order)", () => {
    const t = resolveTileSlots({ ...base, partnerOn: false, bookOn: false });
    expect(t[0]).toMatchObject({ slot: "tl", intent: "story" });
    expect(t[1]).toMatchObject({ slot: "tr", intent: "follow" });
    expect(t[3].intent).toBe("create");
  });

  it("no Story chapter → the Story tile opens the first card (Highlights)", () => {
    const t = resolveTileSlots({ ...base, shopOn: false, chapters: [chapters[0]] });
    expect(t[2]).toMatchObject({ intent: "story", targetChapterId: "highlights" });
  });

  it("never two identical tiles for any two-fallback case, even with one chapter and no socials (Ask is the last resort)", () => {
    const t = resolveTileSlots({ ...base, bookOn: false, shopOn: false, socials: [], chapters: [chapters[0]] });
    expectDistinct(t);
    expect(t.map((x) => x.intent)).toEqual(["partner", "story", "ask", "create"]);
  });

  it("every door off: three distinct fallbacks once there is a second chapter or a social profile", () => {
    for (const shape of [
      { socials: ig, chapters: [chapters[0]] },
      { socials: [], chapters: chapters.slice(0, 2) },
      { socials: [], chapters },
    ]) {
      const t = resolveTileSlots({ ...base, partnerOn: false, bookOn: false, shopOn: false, ...shape });
      expectDistinct(t);
      expect(t[3].intent).toBe("create");
    }
  });

  it("hints replace nothing unless set, and only on doors that are on", () => {
    expect(resolveTileSlots(base)[1].hint).toBeNull();
    const t = resolveTileSlots({ ...base, shopOn: false, hints: { book: "Next: Thu 4:30p", shop: "12 picks" } });
    expect(t[1].hint).toBe("Next: Thu 4:30p");
    expect(t[2].hint).toBeUndefined(); // the fallback tile carries no hint
  });
});
