import {
  FRAME_SURFACES, composedTile, fillPhotos, isWide, mapPoint, meTileKeys, rangeLabel, ratesForTile, surfaceOf, tileLine, ME_TILES_COPY,
  type ComposedKey, type TileContent,
} from "./meTilesLogic";

const content = (over: Partial<TileContent> = {}): TileContent => ({
  firstName: "Sam",
  photos: ["https://cdn.example/a.jpg?sig=1", "https://cdn.example/b.jpg"],
  planPhotos: [],
  rates: [],
  ...over,
});

describe("surfaces", () => {
  it("maps every frame surface's box corners onto its quad (within a few units)", () => {
    for (const key of Object.keys(FRAME_SURFACES) as ComposedKey[]) {
      for (const { id, quad } of FRAME_SURFACES[key]) {
        const s = surfaceOf(id, quad);
        const corners = [mapPoint(s.m, 0, 0), mapPoint(s.m, s.w, 0), mapPoint(s.m, s.w, s.h), mapPoint(s.m, 0, s.h)];
        corners.forEach(([x, y], i) => {
          expect(Math.abs(x - quad[i][0])).toBeLessThan(12);
          expect(Math.abs(y - quad[i][1])).toBeLessThan(12);
        });
      }
    }
  });

  it("is exact for an upright rectangle", () => {
    const s = surfaceOf("r", [[10, 20], [110, 20], [110, 220], [10, 220]]);
    expect(s.w).toBe(100);
    expect(s.h).toBe(200);
    expect(mapPoint(s.m, 50, 100)).toEqual([60, 120]);
  });
});

describe("composedTile", () => {
  it("draws nothing of hers without a photo (the plain frame shows)", () => {
    expect(composedTile("brand", content({ photos: [] }))).toBeNull();
    expect(composedTile("plan", content({ photos: [], planPhotos: [] }))).toBeNull();
    expect(composedTile("page", content({ photos: [] }))).toBeNull();
  });

  it("fills every print on Your plan, newest post on top, her library after the plan's own pictures", () => {
    const t = composedTile("plan", content({ planPhotos: ["https://cdn.example/post1.jpg"] }))!;
    const photos = t.layers.filter((l) => l.kind === "photo");
    expect(photos).toHaveLength(3);
    expect(photos.map((l) => l.surface)).toEqual(["print3", "print2", "print1"]);
    expect(photos[2].kind === "photo" && photos[2].uri).toBe("https://cdn.example/post1.jpg");
  });

  it("puts her first name on the book and the page, and the page's ask to partner", () => {
    const book = composedTile("brand", content())!;
    expect(book.layers.some((l) => l.kind === "text" && l.text === "SAM")).toBe(true);
    const page = composedTile("page", content())!;
    expect(page.layers.some((l) => l.kind === "text" && l.text === "Partner with Sam")).toBe(true);
    expect(ME_TILES_COPY.partner("")).toBe("Partner with me");
  });

  it("lists up to three rate ranges on the card, or the ask to set them", () => {
    const r = (label: string) => ({ label, low: 1500, high: 5000, currency: "usd" });
    const card = composedTile("rates", content({ rates: [r("Post"), r("Reel"), r("Story"), r("Event")] }))!;
    const texts = card.layers.filter((l) => l.kind === "text").map((l) => (l.kind === "text" ? l.text : ""));
    expect(texts).toEqual(["RATES", "Post", "$1.5–5k", "Reel", "$1.5–5k", "Story", "$1.5–5k"]);
    const empty = composedTile("rates", content())!;
    expect(empty.layers.some((l) => l.kind === "text" && l.text === ME_TILES_COPY.ratesEmpty)).toBe(true);
  });

  it("keys the flattened picture on content, not on a photo link's signature", () => {
    const a = composedTile("brand", content({ photos: ["https://cdn.example/a.jpg?sig=1"] }))!;
    const b = composedTile("brand", content({ photos: ["https://cdn.example/a.jpg?sig=2"] }))!;
    const c = composedTile("brand", content({ photos: ["https://cdn.example/c.jpg?sig=1"] }))!;
    expect(a.contentKey).toBe(b.contentKey);
    expect(a.contentKey).not.toBe(c.contentKey);
  });
});

describe("helpers", () => {
  it("formats ranges compactly", () => {
    expect(rangeLabel(1500, 5000)).toBe("$1.5–5k");
    expect(rangeLabel(500, 900)).toBe("$500–900");
    expect(rangeLabel(800, 1200)).toBe("$800–1.2k");
    expect(rangeLabel(2000, 3000, "eur")).toBe("EUR 2–3k");
  });

  it("repeats photos only when there are fewer than the slots", () => {
    expect(fillPhotos(["p"], ["a", "p", "b"], 3)).toEqual(["p", "a", "b"]);
    expect(fillPhotos([], ["a"], 3)).toEqual(["a", "a", "a"]);
    expect(fillPhotos([], [], 3)).toEqual([]);
  });

  it("keeps rate rows that carry a suggested range", () => {
    expect(ratesForTile([
      { label: "Post", suggested: { low: 1, high: 2, currency: "usd" } },
      { label: "Hour", suggested: null },
    ])).toEqual([{ label: "Post", low: 1, high: 2, currency: "usd" }]);
    expect(ratesForTile(null)).toEqual([]);
  });
});

describe("which tiles show", () => {
  it("shows the six set-up tiles, no Offers (offers live in Business)", () => {
    expect(meTileKeys()).toEqual(["brand", "page", "rates", "bookings", "shop"]);
    // The plan is the brand book's last chapter now: no separate tile.
    expect(meTileKeys()).not.toContain("plan");
    expect(meTileKeys()).not.toContain("offers");
    expect(ME_TILES_COPY.bookings).toBe("Your bookings");
    expect(ME_TILES_COPY.shop).toBe("Your shop");
  });

  it("runs an odd last tile full width; an even count fills two columns", () => {
    const five = meTileKeys();
    expect(isWide(five, 4)).toBe(true);
    const four = five.slice(0, 4);
    expect(four.some((_, i) => isWide(four, i))).toBe(false);
  });
});

describe("the line under each tile", () => {
  const none = { book: null, plan: null, rates: 0, bookingsEnabled: false, sessions: 0, shopPicks: 0 };
  it("every tile has a short line; Bookings and Shop invite her to turn them on until they are on", () => {
    for (const k of meTileKeys()) {
      const l = tileLine(k, none);
      expect(l.text.length).toBeGreaterThan(0);
      expect(l.text.length).toBeLessThanOrEqual(26);
    }
    expect(tileLine("brand", none)).toEqual({ text: "How brands see you", invite: false });
    expect(tileLine("plan", none).text).toBe("Your goals and this week");
    expect(tileLine("page", none).text).toBe("Your public page");
    expect(tileLine("rates", none).text).toBe("Ranges + your minimums");
    expect(tileLine("bookings", none)).toEqual({ text: "Turn on", invite: true });
    expect(tileLine("shop", none)).toEqual({ text: "Turn on", invite: true });
  });
  it("a live fact replaces the line when there is one, and is never a request count", () => {
    const live = { book: "Mila is writing it", plan: "2 goals · 3 posts ready", rates: 3, bookingsEnabled: true, sessions: 2, shopPicks: 4 };
    expect(tileLine("brand", live).text).toBe("Mila is writing it");
    // Once the book is ready (no book line), the Brand book tile carries the plan's live progress — its last chapter.
    expect(tileLine("brand", { ...live, book: null }).text).toBe("2 goals · 3 posts ready");
    expect(tileLine("plan", live).text).toBe("2 goals · 3 posts ready");
    expect(tileLine("rates", live).text).toBe("3 rates set");
    expect(tileLine("bookings", live)).toEqual({ text: "2 session types", invite: false });
    expect(tileLine("bookings", { ...live, sessions: 0 }).text).toBe("What people can book");
    expect(tileLine("shop", live)).toEqual({ text: "4 picks", invite: false });
  });
});
