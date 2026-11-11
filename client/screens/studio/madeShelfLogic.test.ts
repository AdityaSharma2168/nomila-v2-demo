import {
  shelfCounts,
  shelfSections,
  visibleItems,
  type Lens,
} from "./madeShelfLogic";
import type {
  MadeItem,
  MadeState,
  StudioSurface,
} from "../../hooks/use-studio-pending";

function item(
  assetId: string,
  surface: StudioSurface,
  state: MadeState,
  extra: Partial<MadeItem> = {},
): MadeItem {
  return {
    assetId,
    surface,
    state,
    mediaType: "image",
    url: null,
    thumbUrl: null,
    title: "Yours",
    subtitle: null,
    scheduledFor: null,
    postedAt: null,
    createdAt: null,
    ...extra,
  };
}

const SHELF: MadeItem[] = [
  item("b1", "brand", "posted", { title: "gorjana", subtitle: "Ad 2 of 3" }),
  item("b2", "brand", "awaiting", { title: "gorjana", subtitle: "Ad 3 of 3" }),
  item("b3", "brand", "scheduled", { title: "gorjana", subtitle: "Ad 1 of 3" }),
  item("p1", "personal", "draft"),
  item("p2", "personal", "scheduled"),
  item("a1", "anything", "making", { mediaType: "video" }),
  item("x1", "brand", "archived", { title: "Celsius" }),
  item("x2", "personal", "archived"),
];

describe("the archive rule", () => {
  it("keeps archived work off the shelf", () => {
    const shown = visibleItems(SHELF, "all", "");
    expect(shown.map((i) => i.assetId)).not.toContain("x1");
    expect(shown.map((i) => i.assetId)).not.toContain("x2");
    expect(shown).toHaveLength(6);
  });

  it("shows only archived work when that is what was asked for", () => {
    const shown = visibleItems(SHELF, "archived", "");
    expect(shown.map((i) => i.assetId).sort()).toEqual(["x1", "x2"]);
  });

  it("does not let archived work inflate the state counts", () => {
    // "All work" is the shelf's size, not the table's — two archived rows must not appear in it.
    expect(shelfCounts(SHELF).all).toBe(6);
    expect(shelfCounts(SHELF).archived).toBe(2);
  });
});

describe("the state strip", () => {
  it("counts each lens off the live shelf", () => {
    expect(shelfCounts(SHELF)).toEqual({
      scheduled: 2,
      attention: 2,
      all: 6,
      archived: 2,
    });
  });

  it("treats awaiting and making as one thing, because both are waiting on her", () => {
    const shown = visibleItems(SHELF, "attention", "");
    expect(shown.map((i) => i.assetId).sort()).toEqual(["a1", "b2"]);
  });

  it("narrows to scheduled across every section, not just one", () => {
    const shown = visibleItems(SHELF, "scheduled", "");
    expect(shown.map((i) => i.assetId).sort()).toEqual(["b3", "p2"]);
  });

  it("reports zero rather than hiding a lens with nothing in it", () => {
    const none = shelfCounts([item("p1", "personal", "draft")]);
    expect(none.scheduled).toBe(0);
    expect(none.attention).toBe(0);
  });
});

describe("sections", () => {
  it("orders by attention, not by size", () => {
    const secs = shelfSections(SHELF, "all", "");
    expect(secs.map((s) => s.key)).toEqual(["brand", "personal", "anything"]);
  });

  it("drops a section with nothing in it rather than rendering an empty heading", () => {
    const secs = shelfSections(SHELF, "all", "");
    expect(secs.map((s) => s.key)).not.toContain("pitch");
  });

  it("keeps sections while a lens is narrowing them", () => {
    const secs = shelfSections(SHELF, "scheduled", "");
    expect(secs.map((s) => s.key)).toEqual(["brand", "personal"]);
    expect(
      secs.every((s) => s.items.every((i) => i.state === "scheduled")),
    ).toBe(true);
  });

  it("returns nothing at all when the lens empties every section", () => {
    expect(
      shelfSections([item("p1", "personal", "draft")], "scheduled", ""),
    ).toEqual([]);
  });
});

describe("search", () => {
  it("matches a brand name", () => {
    expect(
      visibleItems(SHELF, "all", "gorjana")
        .map((i) => i.assetId)
        .sort(),
    ).toEqual(["b1", "b2", "b3"]);
  });

  it("matches the deliverable line", () => {
    expect(visibleItems(SHELF, "all", "Ad 2").map((i) => i.assetId)).toEqual([
      "b1",
    ]);
  });

  it("matches a format", () => {
    expect(visibleItems(SHELF, "all", "video").map((i) => i.assetId)).toEqual([
      "a1",
    ]);
  });

  it("ignores case and surrounding space, because a search box collects both", () => {
    expect(visibleItems(SHELF, "all", "  GORJANA ")).toHaveLength(3);
  });

  it("still respects the archive rule while searching", () => {
    // Celsius exists only as an archived row — searching the shelf must not surface it.
    expect(visibleItems(SHELF, "all", "celsius")).toEqual([]);
    expect(
      visibleItems(SHELF, "archived", "celsius").map((i) => i.assetId),
    ).toEqual(["x1"]);
  });

  it("treats an empty query as no filter", () => {
    (["all", "scheduled", "attention", "archived"] as Lens[]).forEach(
      (lens) => {
        expect(visibleItems(SHELF, lens, "   ")).toEqual(
          visibleItems(SHELF, lens, ""),
        );
      },
    );
  });
});
