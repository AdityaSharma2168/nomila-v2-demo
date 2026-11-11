/**
 * render.test.ts — the public page renderer over the three made-up fixtures (no DB, no providers, no model).
 */
import fs from "fs";
import path from "path";
import { averyOkafor, rowanCastell, samIto, PUBLIC_CARD_FIXTURES } from "./fixtures";
import { DOOR_PAGES, renderDoorPage, renderPublicCardHtml, safeHttpUrl, widgetData, type RenderOptions } from "./render";
import type { PublicCardView } from "./view";

const opts = (basePath = "/p/test"): RenderOptions => ({
  basePath,
  publicOrigin: "https://example.test",
  assets: {
    css: "/p/_a/front.css?v=1",
    js: "/p/_a/front.js?v=1",
    milaJs: "/p/_a/mila.js?v=1",
    mila: { poster: "/p/_a/mila/mila-still.png?v=1", idle: "/p/_a/mila/mila-idle.mp4?v=1" },
  },
});
const all = Object.values(PUBLIC_CARD_FIXTURES);
const tilesOf = (html: string) => [...html.matchAll(/<a class="pc-tile pc-tile--(tl|tr|bl|br)[^"]*" href="([^"]*)" data-intent="([a-z]+)"/g)];

describe("renderPublicCardHtml — structure", () => {
  it.each(all.map((v) => [v.handle, v] as const))("%s: four tiles in slot order, one 'Ask Mila' centre, every chapter as a slide", (_h, v) => {
    const html = renderPublicCardHtml(v, opts());
    const tiles = tilesOf(html);
    expect(tiles.map((m) => m[1])).toEqual(["tl", "tr", "bl", "br"]);
    expect(tiles.map((m) => m[3])).toEqual(v.tiles.map((t) => t.intent));
    expect(html.match(/aria-label="Ask Mila"/g)).toHaveLength(1);
    expect(html.match(/aria-roledescription="slide"/g)).toHaveLength(v.chapters.length);
    expect(html).toContain(`<h1 class="pc-name"><span>${v.athlete.firstName}</span> <span>${v.athlete.lastName}</span></h1>`);
  });

  it("the full card: Partner · Book / Shop · Create with the approved sub-labels", () => {
    const html = renderPublicCardHtml(averyOkafor, opts("/p/avery-okafor"));
    expect(tilesOf(html).map((m) => [m[3], m[2]])).toEqual([
      ["partner", "/p/avery-okafor/partner"],
      ["book", "/p/avery-okafor/book"],
      ["shop", "/p/avery-okafor/shop"],
      ["create", "/p/avery-okafor/create"],
    ]);
    for (const s of ["Sponsorships, posts, interviews &amp; more", "Book a session with Avery", "Things Avery uses", "Coming soon"]) expect(html).toContain(s);
  });

  it("Shop not on → that slot is Story, an in-page link to the Story card; a set hint replaces the sub-label", () => {
    const html = renderPublicCardHtml(rowanCastell, opts());
    const t = tilesOf(html);
    expect(t[2][3]).toBe("story");
    expect(t[2][2]).toBe("#ch-story");
    expect(html).toContain("See Rowan&#39;s story");
    expect(html).toContain('<small class="pc-tsub pc-tsub--hint">Next: Thu 4:30p</small>');
    expect(html).not.toContain("Book a session with Rowan"); // the hint replaced it
  });

  it("a new athlete with little data: Story + Follow fallbacks, still four tiles, no verified mark", () => {
    const html = renderPublicCardHtml(samIto, opts());
    expect(tilesOf(html).map((m) => m[3])).toEqual(["partner", "story", "follow", "create"]);
    expect(html).toContain("Sam on Instagram");
    expect(html).not.toContain("Verified by Nomila");
    expect(html).toContain('id="follow"'); // the footer section the no-script Follow page mirrors
  });

  it("the Mila avatar is a still poster with no autoplay; the loop is muted, inline and metadata-only", () => {
    const html = renderPublicCardHtml(averyOkafor, opts());
    const video = html.match(/<video class="pc-mila-v"[^>]*>/)![0];
    expect(video).toContain('poster="/p/_a/mila/mila-still.png?v=1"');
    expect(video).toMatch(/ muted /);
    expect(video).toContain("playsinline");
    expect(video).toContain('preload="metadata"');
    expect(video).not.toContain("autoplay");
  });
});

describe("renderPublicCardHtml — head, CSP-safety, escaping", () => {
  it.each(all.map((v) => [v.handle, v] as const))("%s: og tags, canonical and noindex by default", (_h, v) => {
    const html = renderPublicCardHtml(v, opts(`/p/${v.handle}`));
    expect(html).toContain(`<meta property="og:title" content="${v.athlete.firstName} ${v.athlete.lastName} · Nomila">`);
    expect(html).toContain(`<meta property="og:url" content="https://example.test/p/${v.handle}">`);
    expect(html).toContain('<meta property="og:type" content="profile">');
    expect(html).toContain('<meta name="twitter:card"');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  });

  it("indexable cards drop the robots meta", () => {
    const html = renderPublicCardHtml({ ...averyOkafor, indexable: true }, opts());
    expect(html).not.toContain('name="robots"');
  });

  it.each(all.map((v) => [v.handle, v] as const))("%s: no inline script, no style attributes, no <style> block (strict CSP)", (_h, v) => {
    const pages = [renderPublicCardHtml(v, opts()), ...DOOR_PAGES.map((d) => renderDoorPage(v, d, opts()))];
    for (const html of pages) {
      const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
      for (const attrs of scripts) expect(attrs.includes(" src=") || attrs.includes('type="application/json"')).toBe(true);
      expect(html).not.toMatch(/\sstyle=/);
      expect(html).not.toContain("<style");
      expect(html).not.toMatch(/\son[a-z]+=/); // no inline event handlers
    }
  });

  it("visitors never see the word 'brief'", () => {
    for (const v of all) {
      const pages = [renderPublicCardHtml(v, opts()), ...DOOR_PAGES.map((d) => renderDoorPage(v, d, opts()))];
      for (const html of pages) expect(html.toLowerCase()).not.toContain("brief");
    }
  });

  it("escapes every value and drops unsafe URLs", () => {
    const evil: PublicCardView = {
      ...averyOkafor,
      athlete: { ...averyOkafor.athlete, firstName: '<img src=x onerror="alert(1)">', quote: "</script><script>alert(1)</script>" },
      socials: [{ network: "Bad", url: "javascript:alert(1)", handle: "x" }],
      chapters: averyOkafor.chapters.map((c) =>
        c.kind === "media" ? { ...c, items: [{ type: "link" as const, title: "t", outlet: "o", url: "javascript:alert(1)" }] } : c,
      ),
    };
    const html = renderPublicCardHtml(evil, opts());
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("&lt;img src=x");
    // the widget's JSON block cannot be closed early
    const json = html.match(/<script type="application\/json" id="pc-data">([\s\S]*?)<\/script>/)![1];
    expect(json).not.toContain("<");
    expect(JSON.parse(json).first).toBe(evil.athlete.firstName);
  });

  it("safeHttpUrl keeps http(s) only", () => {
    expect(safeHttpUrl("https://a.test/x")).toBe("https://a.test/x");
    expect(safeHttpUrl("javascript:alert(1)")).toBe("");
    expect(safeHttpUrl("data:text/html,x")).toBe("");
    expect(safeHttpUrl("not a url")).toBe("");
  });
});

describe("renderDoorPage — the no-script doors", () => {
  it("Partner is a plain request form that posts to this card, with the six request kinds", () => {
    const html = renderDoorPage(averyOkafor, "partner", opts("/p/avery-okafor"));
    expect(html).toContain('<form class="pc-form" method="post" action="/p/avery-okafor/partner">');
    expect(html.match(/name="kind"/g)).toHaveLength(6);
    expect(html).toContain("Interview, podcast or editorial");
    expect(html).toContain("Send to Avery");
    expect(html).toContain("Nothing is sent until you tap.");
    expect(html).toMatch(/<button class="pc-btn pc-btn--big" type="submit" disabled/); // not yet: no backend until the intake PR
    expect(html).toContain("Requests open soon.");
  });

  it("Book lists the all-in prices; Shop marks every pick as a paid link through /go/:code", () => {
    const book = renderDoorPage(averyOkafor, "book", opts());
    expect(book).toContain("$177.96");
    const shop = renderDoorPage(averyOkafor, "shop", opts());
    expect(shop.match(/Paid link</g)).toHaveLength(averyOkafor.picks.length);
    expect(shop).toContain('href="/go/fxa1"');
    expect(shop).toContain('rel="noopener noreferrer sponsored"');
    expect(shop).toContain("Paid links. Avery may earn a commission if you buy.");
    expect(shop).toContain("From brands Avery works with");
    expect(shop).toContain("Amazon Associate");
  });

  it("Create is one line, with no form and no email field", () => {
    const html = renderDoorPage(samIto, "create", opts());
    expect(html).toContain("Create with Sam is coming soon.");
    expect(html).not.toContain("<form");
    expect(html).not.toContain('type="email"');
  });

  it("widgetData carries published data only, with quoted prices", () => {
    const d = JSON.parse(widgetData(averyOkafor, opts()));
    expect(d.offers[0].price).toBe("$177.96");
    expect(d.picks[0].href).toBe("/go/fxa1");
    expect(Object.keys(d).sort()).toEqual(["ask", "askChips", "basePath", "bookPath", "chapters", "doors", "first", "handle", "mila", "minor", "offers", "partnerKinds", "picks", "socials", "version"]);
  });

  it("widgetData.bookPath: the Book door page when bookings are on and her card has the Book door, else null", () => {
    const withBook = { ...opts("/p/avery-okafor"), assets: { ...opts().assets, bookJs: "/p/_a/book.js?v=1" } };
    const hasBook = averyOkafor.tiles.some((t) => t.intent === "book");
    expect(JSON.parse(widgetData(averyOkafor, withBook)).bookPath).toBe(hasBook ? "/p/avery-okafor/book" : null);
    expect(JSON.parse(widgetData(averyOkafor, opts("/p/avery-okafor"))).bookPath).toBeNull();
    const noBook = { ...averyOkafor, tiles: averyOkafor.tiles.map((t) => (t.intent === "book" ? { ...t, intent: "story" as const } : t)) as typeof averyOkafor.tiles };
    expect(JSON.parse(widgetData(noBook, withBook)).bookPath).toBeNull();
  });
});

describe("platform rule", () => {
  it("nothing athlete-specific in the renderer, tiles or route code (fixture names and sports live only in fixtures)", () => {
    const words = ["Avery", "Okafor", "Rowan", "Castell", "Sam", "Ito", "sprint", "rowing", "swim", "Northline", "Brightwater"];
    for (const f of ["render.ts", "tiles.ts", "view.ts", "flag.ts", "../../routes/publicPage.ts", "../../public/p/front.js", "../../public/p/front.css"]) {
      const src = fs.readFileSync(path.join(__dirname, f), "utf8");
      for (const w of words) expect({ f, hit: new RegExp(`\\b${w}\\b`, "i").test(src) }).toEqual({ f, hit: false });
    }
  });
});

describe("Book door — the request flow hook (Bookings PR2)", () => {
  const withOffers = (ids: string[]): PublicCardView => ({
    ...averyOkafor,
    offers: ids.map((id, i) => ({ id, title: `Session ${i}`, durationMin: 30, format: "virtual" as const, allInMinor: 17_796, currency: "USD" })),
  });
  it("marks real offers with their public id and loads book.js only on the Book door, only when given", () => {
    const o = { ...opts(), assets: { ...opts().assets, bookJs: "/p/_a/book.js?v=1" } };
    const html = renderDoorPage(withOffers(["offer:pub_abc123", "o9", "offer:bad id!"]), "book", o);
    expect(html).toContain('data-book');
    expect(html).toContain('data-offer="pub_abc123"');
    expect(html.match(/data-offer=/g)).toHaveLength(1); // fixtures and malformed keys stay plain rows
    expect(html).toContain('data-book-soon');
    expect(html).toContain('<script src="/p/_a/book.js?v=1" defer></script>');
    expect(renderDoorPage(withOffers(["offer:pub_abc123"]), "shop", o)).not.toContain("book.js");
    expect(renderDoorPage(withOffers(["offer:pub_abc123"]), "book", opts())).not.toContain("book.js");
  });
  it("the door carries her handle so book.js reads her offers live, even when the published list is empty", () => {
    const o = { ...opts(), assets: { ...opts().assets, bookJs: "/p/_a/book.js?v=1" } };
    expect(renderDoorPage(withOffers(["offer:pub_abc123"]), "book", o)).toContain(`data-book data-book-handle="${averyOkafor.handle}"`);
    const empty = renderDoorPage(withOffers([]), "book", o);
    expect(empty).toContain(`data-book-handle="${averyOkafor.handle}"`);
    expect(empty).toContain("has no sessions open right now.");
  });
  it("book.js asks for her live offers by handle, and falls back to each published row", () => {
    const js = fs.readFileSync(path.join(process.cwd(), "server/public/p/book.js"), "utf8");
    expect(js).toContain('"/cards/" + encodeURIComponent(handle) + "/offers"');
    expect(js).toContain('"/offers/" + encodeURIComponent(id)');
  });
  it("book.js writes only with textContent, sets no inline styles, and talks only to this origin", () => {
    const js = fs.readFileSync(path.join(process.cwd(), "server/public/p/book.js"), "utf8");
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.style\.|setAttribute\("style"|eval\(/);
    expect(js).toContain('var API = "/api/v1/book"');
    expect(js).not.toMatch(/https?:\/\//);
    expect(js).toContain('credentials: "omit"');
    expect(js).toContain('"nb-access:"'); // the key the /b/ page reads
  });
});
