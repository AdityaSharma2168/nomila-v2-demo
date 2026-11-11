/**
 * ownSiteImagery.test.ts — a brand's cover and logo come ONLY from its own domain. No network: safeFetch runs for
 * real (scheme, address and hop checks) with an injected resolver and fetch; the Yoku check is injected.
 *
 *   - the homepage og:image on the same domain (or a subdomain) is taken, checked as a real image of sane size
 *   - an og:image hosted on another domain is not taken
 *   - a homepage redirect to another registrable domain is refused at the hop (never requested)
 *   - an image redirect off the domain, a tiny image or a non-image is refused
 *   - logo: Yoku when it verifies the domain, else Google's favicon
 */
import { fetchOwnSiteImagery, metaImageRefs, pickOwnSiteCover, COVER_MIN_BYTES } from "./ownSiteImagery";
import { safeFetch } from "./safeFetch";

const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
const html = (og: string, extra = "") => `<html><head><meta property="og:image" content="${og}">${extra}</head><body></body></html>`;
const img = (bytes = COVER_MIN_BYTES + 100, type = "image/jpeg") => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": type } });
const page = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
const redirect = (to: string) => new Response(null, { status: 301, headers: { location: to } });

function site(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    const r = routes[String(url)];
    return r ? r() : new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const noYoku = async () => false;

describe("pure pickers", () => {
  it("resolves relative og:image against the page and keeps only https refs on the domain", () => {
    const refs = metaImageRefs(html("/img/hero.jpg", `<meta name="twitter:image" content="https://cdn.other.com/x.jpg">`), "https://www.brand.example/");
    expect(refs.map((r) => r.url)).toEqual(["https://www.brand.example/img/hero.jpg", "https://cdn.other.com/x.jpg"]);
    expect(pickOwnSiteCover(refs, "brand.example")).toBe("https://www.brand.example/img/hero.jpg");
    expect(pickOwnSiteCover(refs.slice(1), "brand.example")).toBeNull();
    expect(pickOwnSiteCover([{ url: "http://brand.example/a.jpg", width: null, height: null }], "brand.example")).toBeNull();
    // look-alike domains never match
    expect(pickOwnSiteCover([{ url: "https://notbrand.example/a.jpg", width: null, height: null }], "brand.example")).toBeNull();
  });
  it("skips an og:image declared too small", () => {
    const refs = metaImageRefs(html("https://brand.example/a.jpg", `<meta property="og:image:width" content="64">`), "https://brand.example/");
    expect(pickOwnSiteCover(refs, "brand.example")).toBeNull();
  });
});

describe("fetchOwnSiteImagery", () => {
  it("takes the same-domain og:image after checking it is a real image", async () => {
    const { impl, calls } = site({
      "https://www.brand.example/": () => page(html("https://static.brand.example/hero.jpg")),
      "https://static.brand.example/hero.jpg": () => img(),
    });
    const r = await fetchOwnSiteImagery("brand.example", { resolve, fetchImpl: impl, hasYokuLogo: noYoku });
    expect(r).toMatchObject({ domain: "brand.example", cover: "https://static.brand.example/hero.jpg", logoSource: "favicon", coverMiss: null });
    expect(r!.logoUrl).toContain("google.com/s2/favicons?domain=brand.example");
    expect(calls).toEqual(["https://www.brand.example/", "https://static.brand.example/hero.jpg"]);
  });

  it("rejects an og:image hosted on another domain (no request is made for it)", async () => {
    const { impl, calls } = site({
      "https://www.brand.example/": () => page(html("https://cdn.elsewhere.example/hero.jpg")),
      "https://brand.example/": () => page(html("https://cdn.elsewhere.example/hero.jpg")),
    });
    const r = await fetchOwnSiteImagery("brand.example", { resolve, fetchImpl: impl, hasYokuLogo: noYoku });
    expect(r!.cover).toBeNull();
    expect(r!.coverMiss).toContain("og:image not on the domain");
    expect(calls.some((c) => c.includes("elsewhere"))).toBe(false);
  });

  it("refuses a homepage redirect to another registrable domain at the hop", async () => {
    const { impl, calls } = site({
      "https://www.brand.example/": () => redirect("https://www.parked-domains.example/landing"),
      "https://brand.example/": () => redirect("https://www.parked-domains.example/landing"),
      "https://www.parked-domains.example/landing": () => page(html("https://www.parked-domains.example/hero.jpg")),
    });
    const r = await fetchOwnSiteImagery("brand.example", { resolve, fetchImpl: impl, hasYokuLogo: noYoku });
    expect(r!.cover).toBeNull();
    expect(r!.coverMiss).toContain("page refused: hop_not_allowed");
    expect(calls.some((c) => c.includes("parked-domains"))).toBe(false);
  });

  it("follows a redirect that stays on the domain (bare → www)", async () => {
    const { impl } = site({
      "https://www.brand.example/": () => redirect("https://shop.brand.example/"),
      "https://shop.brand.example/": () => page(html("https://shop.brand.example/hero.png")),
      "https://shop.brand.example/hero.png": () => img(COVER_MIN_BYTES + 1, "image/png"),
    });
    const r = await fetchOwnSiteImagery("brand.example", { resolve, fetchImpl: impl, hasYokuLogo: async () => true });
    expect(r).toMatchObject({ cover: "https://shop.brand.example/hero.png", logoSource: "yoku" });
    expect(r!.logoUrl).toContain("cdn.yoku.app/brand.example");
  });

  it("refuses an image that redirects off the domain, a tiny image, or a non-image", async () => {
    for (const [route, miss] of [
      [() => redirect("https://tracker.example/pixel.gif"), "image refused: hop_not_allowed"],
      [() => img(100), "image too small"],
      [() => img(COVER_MIN_BYTES + 100, "text/html"), "image type text/html"],
    ] as const) {
      const { impl } = site({
        "https://www.brand.example/": () => page(html("https://brand.example/hero.jpg")),
        "https://brand.example/": () => page(html("https://brand.example/hero.jpg")),
        "https://brand.example/hero.jpg": route,
      });
      const r = await fetchOwnSiteImagery("brand.example", { resolve, fetchImpl: impl, hasYokuLogo: noYoku });
      expect(r!.cover).toBeNull();
      expect(r!.coverMiss).toContain(miss);
    }
  });

  it("a free-mail or non-brand domain is never fetched", async () => {
    const { impl, calls } = site({});
    expect(await fetchOwnSiteImagery("gmail.com", { resolve, fetchImpl: impl, hasYokuLogo: noYoku })).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("safeFetch allowHop", () => {
  it("is checked on the first URL too", async () => {
    const { impl, calls } = site({ "https://a.example/": () => page("x") });
    await expect(safeFetch("https://a.example/", {}, { resolve, fetchImpl: impl, allowHop: () => false })).rejects.toMatchObject({ reason: "hop_not_allowed" });
    expect(calls).toEqual([]);
  });
});
