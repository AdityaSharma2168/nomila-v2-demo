import { describe, expect, it, afterEach } from "@jest/globals";
import { bookLine, frontDoors, planDeck } from "./layout";
import { frontDoorsHtml, ownerRailHtml, renderFrontDoorHtml } from "./render";
import { claimHref, doorsOn, ownerRail, publicSafeKit, renderEnginePublicPage } from "./publicPage";

const conf = { level: "verified", score: 1 } as any;
const base = (cards: any[]) => ({
  athleteId: "a", identity: { name: "Alex Rivera", sport: "track", school: "State", hook: "" }, tokens: { theme: "luxe", accent: "#E84591" },
  cards, meta: { generatedAt: "", overallConfidence: 1 }, imagePool: [{ gcsPath: "https://img.example/pool1.jpg", shotType: "portrait", hero: 1 }],
}) as any;
const cover = { id: "cover", type: "cover", emphasis: "hero", confidence: conf, eyebrow: "", image: "https://img.example/cover.jpg", nameLines: ["Alex", "Rivera"], meta: "Track · State", hook: "Fast, then faster.", stats: [{ value: "12K", label: "Followers" }] };
const sig = { id: "signatureIdea", type: "signatureIdea", emphasis: "hero", confidence: conf, eyebrow: "", title: "Run Your Own Race", line: "Reach me at alex@example.com.", lineEmphasis: "", facets: [], note: "", image: "https://img.example/idea.jpg" };
const record = { id: "achievements", type: "achievements", emphasis: "hero", confidence: conf, eyebrow: "", bg: null, heroEntry: { year: "2025", name: "Conference champion", badge: "", detail: "" }, entries: [], footnote: "" };
const emptyAudience = { id: "audience", type: "audience", emphasis: "standard", confidence: conf, eyebrow: "", headline: "", sub: "", share: null, geo: [], stats: [] };

describe("front door: doors", () => {
  it("1 door: Partner alone, full width", () => {
    const r = frontDoors({ first: "Alex", partnerOn: true, bookOn: false, shopOn: false });
    expect(r.arrangement).toBe("one");
    expect(r.doors.map((d) => d.key)).toEqual(["partner"]);
    expect(r.doors[0]).toMatchObject({ label: "Partner with Alex", primary: true });
  });
  it("2 doors: Partner + Book, two equal tiles", () => {
    const r = frontDoors({ first: "Alex", partnerOn: true, bookOn: true, shopOn: false, offers: [{ durationMin: 45, format: "in_person" }, { durationMin: 30, format: "virtual" }] });
    expect(r.arrangement).toBe("two");
    expect(r.doors[1]).toMatchObject({ key: "book", label: "Book Alex", line: "From 30-min calls", primary: false });
  });
  it("3 doors: Partner full width over Book + Shop; never a fourth door, Create or Mila", () => {
    const r = frontDoors({ first: "Alex", partnerOn: true, bookOn: true, shopOn: true });
    expect(r.arrangement).toBe("stack");
    expect(r.doors.map((d) => d.key)).toEqual(["partner", "book", "shop"]);
    const html = frontDoorsHtml(r.doors.map((d) => ({ ...d, href: `/p/alex/${d.key}` })), r.arrangement);
    expect(html).toContain('href="/p/alex/partner"');
    expect(html).toContain('href="/p/alex/book"');
    expect(html).toContain('href="/p/alex/shop"');
    expect(html).not.toMatch(/create|mila/i);
  });
  it("the Book line comes from real offers and never carries a price", () => {
    expect(bookLine("Alex", [])).toBe("Sessions with Alex");
    expect(bookLine("Alex", [{ durationMin: 60, format: "in_person" }])).toBe("From 60-min sessions");
    expect(bookLine("Alex", [{ durationMin: 30, format: "virtual" }])).not.toMatch(/\$|\d+\.\d\d/);
  });
  it("doors follow the published tiles (the publisher already applied her switches)", () => {
    const tiles = [{ intent: "partner" }, { intent: "story" }, { intent: "shop" }, { intent: "create" }] as any;
    expect(doorsOn({ tiles })).toEqual({ partnerOn: true, bookOn: false, shopOn: true });
  });
});

describe("front door: page", () => {
  const kit = base([cover, sig, record, emptyAudience]);
  const doors = frontDoors({ first: "Alex", partnerOn: true, bookOn: false, shopOn: false });
  const html = renderFrontDoorHtml(kit, { look: "luxe", doors: doors.doors.map((d) => ({ ...d, href: `/p/alex/${d.key}` })), arrangement: doors.arrangement, handle: "alex", likeEndpoint: "/p/alex/like", cssHref: "/p/_a/nomi.css", jsHref: "/p/_a/front.js" });

  it("hero cards are the generic Nomi Card chapters with data, in a sideways carousel front.js can drive", () => {
    expect(planDeck(kit, "public").map((s) => s.cardType)).toEqual(["cover", "signatureIdea", "achievements", "close"]);
    expect(html).toContain('id="pc-track"');
    expect(html.match(/class="pc-card fd-card"/g)?.length).toBe(4);
    expect(html).toContain('id="pc-chap">Cover · 1 of 4');
  });
  it("fits the public page's strict CSP: no inline script or style", () => {
    expect(html).not.toMatch(/<style|style="/);
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
    expect(html).toContain('<script src="/p/_a/front.js" defer></script>');
  });
  it("visitors get the heart and no metrics", () => {
    expect(html).toContain('id="pc-like"');
    expect(html).not.toContain("fd-rail");
  });
  it("the owner view swaps the heart for the 30-day rail; counts tap through to Business", () => {
    const rail = ownerRail({ windowDays: 30, since: "2026-09-23", views: 1200, likes: 86, requests: 4, bookings: 2, shop: 37 } as any);
    expect(rail.map((r) => r.key)).toEqual(["views", "likes", "requests", "bookings", "shop"]);
    expect(rail.find((r) => r.key === "requests")!.href).toBe("co.nomila.app://opportunities");
    const owner = renderFrontDoorHtml(kit, { look: "luxe", doors: [], arrangement: "none", handle: "alex", likeEndpoint: null, inlineCss: true, metrics: rail });
    expect(owner).toContain("fd-rail");
    expect(owner).not.toContain('id="pc-like"');
    expect(ownerRailHtml(rail)).toContain(">1.2K<");
    expect(ownerRail(null)).toEqual([]);
  });
  it("every public text goes through the contact-detail filter; URLs are left alone", () => {
    const safe = publicSafeKit(kit);
    expect(JSON.stringify(safe)).not.toContain("alex@example.com");
    expect(safe.cards[0].image).toBe("https://img.example/cover.jpg");
  });
});

describe("front door: the public route's engine hook", () => {
  const view = { handle: "alex", athlete: { firstName: "Alex" }, tiles: [{ intent: "partner" }], offers: [] } as any;
  const paths = { base: "/p/alex", css: "/p/_a/nomi.css", js: "/p/_a/front.js", like: "/p/alex/like" };

  it("no cached card → null; a public page never builds one", async () => {
    expect(await renderEnginePublicPage(view, paths, { athleteIdOf: async () => "a", cachedKit: async () => null })).toBeNull();
    expect(await renderEnginePublicPage(view, paths, { athleteIdOf: async () => null, cachedKit: async () => base([cover]) })).toBeNull();
  });
});

describe("cover legibility", () => {
  it("a full-length portrait (small face) splits: photo band on top, name on ink below", async () => {
    const { coverFitFor } = await import("./layout");
    expect(coverFitFor({ x: 0.4, y: 0.12, w: 0.12, h: 0.1 })).toBe("split");
    expect(coverFitFor({ x: 0.3, y: 0.15, w: 0.35, h: 0.32 })).toBe("overlay");
    expect(coverFitFor(null)).toBe("overlay");
  });
  it("split puts the type outside the photo; overlay gives the type its own dark panel", () => {
    const k = base([cover]);
    const d = frontDoors({ first: "Alex", partnerOn: true, bookOn: false, shopOn: false });
    const opts = { look: "luxe" as const, doors: [], arrangement: d.arrangement, handle: "alex", likeEndpoint: null, inlineCss: true };
    const split = renderFrontDoorHtml(k, { ...opts, coverFit: "split" });
    expect(split).toMatch(/k-cover split[^>]*><div class="cover-band"><img class="bandimg"/);
    const coverSection = split.slice(split.indexOf("k-cover split"), split.indexOf("</section>", split.indexOf("k-cover split")));
    expect(coverSection).not.toContain('class="bg"');
    const over = renderFrontDoorHtml(k, { ...opts, coverFit: "overlay" });
    expect(over).toContain('class="inner bottom panel"');
  });
});

describe("front door: sheets", () => {
  const kit = base([cover, sig, record, emptyAudience]);
  const doors = frontDoors({ first: "Alex", partnerOn: true, bookOn: true, shopOn: true });
  const opts = { look: "luxe" as const, doors: doors.doors.map((d) => ({ ...d, href: `/p/alex/${d.key}` })), arrangement: doors.arrangement, handle: "alex", likeEndpoint: "/p/alex/like", cssHref: "/p/_a/nomi.css", jsHref: "/p/_a/front.js" };
  const withSheets = renderFrontDoorHtml(kit, { ...opts, sheetsJsHref: "/p/_a/sheets.js?v=1" });
  const without = renderFrontDoorHtml(kit, opts);

  it("every door stays a real link to its own page (no-script fallback) and is marked to open a sheet", () => {
    for (const k of ["partner", "book", "shop"]) {
      expect(withSheets).toContain(`data-door="${k}" data-sheet href="/p/alex/${k}" aria-haspopup="dialog"`);
    }
  });
  it("one labelled, modal dialog, loaded from a file (no inline script or style)", () => {
    expect(withSheets.match(/id="fd-sheet"/g)?.length).toBe(1);
    expect(withSheets).toContain('role="dialog" aria-modal="true" aria-labelledby="fd-sheet-title"');
    expect(withSheets).toContain('<script src="/p/_a/sheets.js?v=1" defer></script>');
    expect(withSheets).not.toMatch(/<style|style="/);
  });
  it("without sheets.js the page is unchanged: no dialog, the doors are plain links", () => {
    expect(without).not.toContain("fd-sheet");
    expect(without).not.toContain("sheets.js");
  });
});

describe("front door: Get your own Nomi Card", () => {
  const prev = process.env.NOMI_CLAIM_URL;
  afterEach(() => { if (prev === undefined) delete process.env.NOMI_CLAIM_URL; else process.env.NOMI_CLAIM_URL = prev; });
  it("points at today's sign-up entry with the handle as the referral", () => {
    delete process.env.NOMI_CLAIM_URL;
    expect(claimHref("miabhuta")).toBe("https://nomila.co/?ref=miabhuta");
    process.env.NOMI_CLAIM_URL = "https://example.test/claim?src=page";
    expect(claimHref("a-b")).toBe("https://example.test/claim?src=page&ref=a-b");
  });
  it("no handle → the plain entry", () => {
    delete process.env.NOMI_CLAIM_URL;
    expect(claimHref(null)).toBe("https://nomila.co");
  });
});
