/**
 * linkMeta.test.ts — reading the public preview of her link (docs/design/shop-her-picks.md §4). Every fetch is a fake:
 * no test reaches the network.
 *
 *   L1 her link is accepted only as http/https, kept exactly as given; credentials, junk and over-long links refused
 *   L2 Shopify: a /products/<handle> page is read from the store's public product JSON (source "shopify"), her link kept
 *   L3 Open Graph: title / image / store / price, entities decoded, one line, clipped; relative and http images dropped
 *   L4 networks (display only): her Amazon tag, an Amazon link without one (note), LTK / ShopMy hosts, a short link
 *      that lands on Amazon
 *   L5 robots.txt is obeyed: a disallowed path is never fetched; 4xx = allowed; 5xx / unreachable = not allowed
 *   L6 bounds: the body read is capped; a refused (SSRF) or failing fetch is "unreadable", never a throw
 */
import { amazonTag, checkLink, networkOf, parseRobots, readCapped, readLink, robotsAllows, shopifyJsonUrl, _clearRobotsCache, MAX_HTML_BYTES, type Fetcher } from "./linkMeta";
import { UnsafeUrlError } from "../../lib/safeFetch";

type Page = { status?: number; type?: string; body: string; url?: string } | Error;
function fake(pages: Record<string, Page>): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    const p = pages[url];
    if (p instanceof Error) throw p;
    if (!p) return new Response("nope", { status: 404, headers: { "content-type": "text/plain" } });
    const res = new Response(p.body, { status: p.status ?? 200, headers: { "content-type": p.type ?? "text/html; charset=utf-8" } });
    if (p.url) Object.defineProperty(res, "url", { value: p.url });
    return res;
  };
  return { fetcher, calls };
}
const ok = (raw: string) => { const c = checkLink(raw); if (!c.ok) throw new Error(c.error); return c; };

beforeEach(() => _clearRobotsCache());

describe("L1 her link", () => {
  it("keeps the link exactly as she gave it (trimmed), http or https", () => {
    expect(ok("  https://shop.example.com/p/1?ref=her-code ").url).toBe("https://shop.example.com/p/1?ref=her-code");
    expect(ok("http://shop.example.com/p").host).toBe("shop.example.com");
  });
  it.each([
    ["ftp://x.example.com/a", "only http and https"],
    ["javascript:alert(1)", "only http and https"],
    ["https://user:pw@x.example.com/", "password"],
    ["not a link", "doesn't look like a link"],
    ["https://localhost/", "doesn't look like a link"],
    [`https://x.example.com/${"a".repeat(2100)}`, "too long"],
  ])("refuses %s", (raw, why) => {
    const c = checkLink(raw);
    expect(c.ok).toBe(false);
    expect((c as { error: string }).error).toContain(why);
  });
});

describe("L2 Shopify", () => {
  it("reads the store's public product JSON and keeps her link (with her code) untouched", async () => {
    const link = ok("https://store.example.com/collections/new/products/trail-runner?ref=HERCODE");
    expect(shopifyJsonUrl(link.parsed)).toBe("https://store.example.com/products/trail-runner.json");
    const { fetcher, calls } = fake({
      "https://store.example.com/robots.txt": { type: "text/plain", body: "User-agent: *\nDisallow: /checkout\n" },
      "https://store.example.com/products/trail-runner.json": { type: "application/json", body: JSON.stringify({ product: {
        title: "Trail  Runner\n2", vendor: "Example Co", image: { src: "https://cdn.example.com/a.jpg" },
        variants: [{ price: "129.00", presentment_prices: [{ price: { amount: "129.00", currency_code: "USD" } }] }],
      } }) },
    });
    const r = await readLink(link, { fetcher });
    expect(r).toMatchObject({ url: link.url, source: "shopify", title: "Trail Runner 2", merchant: "Example Co", imageUrl: "https://cdn.example.com/a.jpg", priceCents: 12900, currency: "USD" });
    expect(r.notes).toEqual(["read"]);
    expect(calls).not.toContain("https://store.example.com/collections/new/products/trail-runner?ref=HERCODE"); // no page fetch needed
  });
  it("a /products/ page that is not a Shopify store falls back to Open Graph", async () => {
    const link = ok("https://other.example.com/products/thing");
    const { fetcher } = fake({
      "https://other.example.com/robots.txt": { status: 404, body: "" },
      "https://other.example.com/products/thing": { body: `<meta property="og:title" content="Thing">` },
    });
    const r = await readLink(link, { fetcher });
    expect(r.source).toBe("link");
    expect(r.title).toBe("Thing");
  });
});

describe("L3 Open Graph", () => {
  it("title, image, store, price; entities decoded; http and javascript images dropped", async () => {
    const link = ok("https://shop.example.com/item/9");
    const html = `<html><head><title>Fallback</title>
      <meta content="Tom &amp; Jerry&#39;s &quot;Tee&quot;" property="og:title">
      <meta property='og:site_name' content='Example Shop'>
      <meta property="og:image" content="/img/tee.jpg">
      <meta property="product:price:amount" content="1,049.50"><meta property="product:price:currency" content="usd">`;
    const { fetcher } = fake({ "https://shop.example.com/robots.txt": { status: 404, body: "" }, "https://shop.example.com/item/9": { body: html } });
    const r = await readLink(link, { fetcher });
    expect(r).toMatchObject({ title: `Tom & Jerry's "Tee"`, merchant: "Example Shop", imageUrl: "https://shop.example.com/img/tee.jpg", priceCents: 104950, currency: "USD", source: "link" });
    const bad = fake({ "https://shop.example.com/robots.txt": { status: 404, body: "" }, "https://shop.example.com/item/9": { body: `<meta property="og:image" content="http://insecure.example.com/x.jpg"><title>T</title>` } });
    expect((await readLink(link, { fetcher: bad.fetcher })).imageUrl).toBeNull();
  });
  it("an http link is read over https", async () => {
    const link = ok("http://shop.example.com/a");
    const { fetcher, calls } = fake({ "https://shop.example.com/robots.txt": { status: 404, body: "" }, "https://shop.example.com/a": { body: "<title>A</title>" } });
    const r = await readLink(link, { fetcher });
    expect(r.url).toBe("http://shop.example.com/a");
    expect(calls.every((c) => c.startsWith("https://"))).toBe(true);
  });
});

describe("L4 networks (display only)", () => {
  it("her Amazon tag; no tag → a note; never added by us", async () => {
    expect(amazonTag("https://www.amazon.com/dp/B000?tag=her-20")).toBe("her-20");
    const tagged = ok("https://www.amazon.com/dp/B000TEST?tag=her-20");
    const pages = { "https://www.amazon.com/robots.txt": { status: 404, body: "" }, "https://www.amazon.com/dp/B000TEST?tag=her-20": { body: "<title>Thing</title>" } };
    const r = await readLink(tagged, { fetcher: fake(pages).fetcher });
    expect(r).toMatchObject({ source: "amazon", networkTag: "her-20", url: "https://www.amazon.com/dp/B000TEST?tag=her-20" });
    const bare = ok("https://www.amazon.co.uk/dp/B000TEST");
    const r2 = await readLink(bare, { fetcher: fake({}).fetcher });
    expect(r2.networkTag).toBeNull();
    expect(r2.notes).toContain("amazon_no_tag");
  });
  it("a short link that lands on Amazon reads her tag where it lands", async () => {
    const link = ok("https://amzn.to/3abc");
    expect(networkOf(link.host)).toBe("amazon");
    const { fetcher } = fake({ "https://amzn.to/robots.txt": { status: 404, body: "" }, "https://amzn.to/3abc": { body: "<title>X</title>", url: "https://www.amazon.com/dp/B1?tag=landed-20" } });
    expect((await readLink(link, { fetcher })).networkTag).toBe("landed-20");
  });
  it("LTK and ShopMy hosts", () => {
    expect(networkOf("liketk.it")).toBe("ltk");
    expect(networkOf("www.shopltk.com")).toBe("ltk");
    expect(networkOf("go.shopmy.us")).toBe("shopmy");
    expect(networkOf("notamazon.com")).toBe("link");
    expect(networkOf("amazon.com.evil.example")).toBe("link");
  });
});

describe("L5 robots.txt", () => {
  it("parses groups; longest match wins; allow wins a tie; * and $", () => {
    const rules = parseRobots("User-agent: other\nDisallow: /\n\nUser-agent: *\nDisallow: /p/\nAllow: /p/ok\nDisallow: /*.json$\n");
    expect(robotsAllows(rules, "/p/x")).toBe(false);
    expect(robotsAllows(rules, "/p/ok/1")).toBe(true);
    expect(robotsAllows(rules, "/products/a.json")).toBe(false);
    expect(robotsAllows(rules, "/products/a.json?x=1")).toBe(true);
    expect(robotsAllows(rules, "/elsewhere")).toBe(true);
    expect(robotsAllows(parseRobots("User-agent: NomilaLinkPreview\nDisallow: /\nUser-agent: *\nAllow: /\n"), "/a")).toBe(false);
  });
  it("a disallowed page is never fetched; the pick is still possible (she types the title)", async () => {
    const link = ok("https://shop.example.com/private/1");
    const { fetcher, calls } = fake({ "https://shop.example.com/robots.txt": { type: "text/plain", body: "User-agent: *\nDisallow: /private\n" } });
    const r = await readLink(link, { fetcher });
    expect(calls).toEqual(["https://shop.example.com/robots.txt"]);
    expect(r.notes).toEqual(["robots"]);
    expect(r.title).toBeNull();
  });
  it("5xx or unreachable robots → not fetched; 4xx → fetched", async () => {
    const link = ok("https://shop.example.com/a");
    const down = fake({ "https://shop.example.com/robots.txt": { status: 503, body: "" } });
    await readLink(link, { fetcher: down.fetcher });
    expect(down.calls).toEqual(["https://shop.example.com/robots.txt"]);
    _clearRobotsCache();
    const gone = fake({ "https://shop.example.com/robots.txt": new Error("ECONNRESET") });
    await readLink(link, { fetcher: gone.fetcher });
    expect(gone.calls).toEqual(["https://shop.example.com/robots.txt"]);
  });
});

describe("L6 bounds", () => {
  it("reads at most the cap", async () => {
    const big = new Response("x".repeat(MAX_HTML_BYTES + 5000));
    expect((await readCapped(big, MAX_HTML_BYTES)).length).toBe(MAX_HTML_BYTES);
  });
  it("a refused (private-address) or failing fetch is unreadable, never a throw", async () => {
    const link = ok("https://internal.example.com/a");
    const { fetcher } = fake({ "https://internal.example.com/robots.txt": { status: 404, body: "" }, "https://internal.example.com/a": new UnsafeUrlError("https://internal.example.com/a", "private_address") });
    const r = await readLink(link, { fetcher });
    expect(r.notes).toEqual(["unreadable"]);
    expect(r.url).toBe("https://internal.example.com/a");
  });
});
