/**
 * publicPage.test.ts — /p/:handle behind PUBLIC_CARD: flag off → 404 everywhere; headers (strict CSP, noindex,
 * caching, ETag/304); same 404 for unknown and malformed handles; the no-script doors; the dev fixture route; the
 * static bundle and Mila's loops. No DB, no providers: the view loader is the fixtures.
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createPublicPageRouter } from "./publicPage";
import { PUBLIC_CARD_FIXTURES } from "../services/publicCard/fixtures";

let server: Server;
let base: string;
const ENV = { ...process.env };

beforeAll(async () => {
  const app = express();
  app.use(createPublicPageRouter({ loadView: async (h) => PUBLIC_CARD_FIXTURES[h] ?? null }));
  // the router's own default (no loadView passed) on a second mount point, to prove it still 404s with no loader wired
  const bare = express();
  bare.use(createPublicPageRouter());
  app.use("/bare", bare);
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  process.env.PUBLIC_CARD = "true";
  delete process.env.PUBLIC_CARD_FIXTURES;
  process.env.NODE_ENV = "test";
});
afterAll(() => {
  process.env = ENV;
});

const get = async (p: string, init: RequestInit = {}) => {
  const res = await fetch(base + p, init);
  return { status: res.status, headers: res.headers, text: await res.text() };
};

describe("PUBLIC_CARD off", () => {
  it.each(["/p/avery-okafor", "/p/avery-okafor/partner", "/p/_dev/fixtures/avery-okafor", "/p/_a/front.css", "/p/_a/mila/mila-idle.mp4"])(
    "%s → 404 (the route does not exist)",
    async (p) => {
      process.env.PUBLIC_CARD = "false";
      const r = await get(p);
      expect(r.status).toBe(404);
      expect(r.text).toBe('{"error":"Not found"}'); // fell through to the app's 404, nothing rendered
    },
  );
  it("anything but exactly 'true' is off", async () => {
    process.env.PUBLIC_CARD = "1";
    expect((await get("/p/avery-okafor")).status).toBe(404);
  });
});

describe("GET /p/:handle", () => {
  it("200 with a strict CSP, noindex, and 60s caching keyed on the snapshot version", async () => {
    const r = await get("/p/avery-okafor");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("media-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(r.text).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(r.headers.get("cache-control")).toBe("public, max-age=60");
    expect(r.headers.get("etag")).toMatch(/^W\/"pc-3-page-/);
    expect(r.text).toContain('aria-label="Ask Mila"');
  });

  it("304 when the ETag matches", async () => {
    const first = await get("/p/avery-okafor");
    const again = await get("/p/avery-okafor", { headers: { "If-None-Match": first.headers.get("etag")! } });
    expect(again.status).toBe(304);
    expect(again.text).toBe("");
  });

  it("an indexable card says so in the header too", async () => {
    const app = express();
    app.use(createPublicPageRouter({ loadView: async () => ({ ...PUBLIC_CARD_FIXTURES["sam-ito"], indexable: true }) }));
    const s = await new Promise<Server>((resolve) => { const x = app.listen(0, () => resolve(x)); });
    const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/p/sam-ito`);
    expect(res.headers.get("x-robots-tag")).toBe("all");
    await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  it("unknown, malformed and upper-case handles all get the same 404 page (with the CSP and noindex)", async () => {
    const bodies = new Set<string>();
    for (const p of ["/p/nobody-here", "/p/Avery-Okafor", "/p/a", "/p/-bad-", "/p/avery-okafor/nonsense"]) {
      const r = await get(p);
      expect(r.status).toBe(404);
      expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      bodies.add(r.text);
    }
    expect(bodies.size).toBe(1);
  });

  it("with no loadView wired (the router's default when none is passed), every handle is a 404 even with the flag on", async () => {
    expect((await get("/bare/p/avery-okafor")).status).toBe(404);
  });
});

describe("no-script doors", () => {
  it("GET /p/:handle/partner is the plain request form", async () => {
    const r = await get("/p/avery-okafor/partner");
    expect(r.status).toBe(200);
    expect(r.text).toContain('action="/p/avery-okafor/partner"');
    expect(r.headers.get("content-security-policy")).toContain("form-action 'self'");
  });
  it("POST /p/:handle/partner has no backend yet: 503, and says nothing was sent", async () => {
    const r = await get("/p/avery-okafor/partner", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "kind=sponsorship&name=x&email=x%40y.z&message=hi",
    });
    expect(r.status).toBe(503);
    expect(r.text).toContain("Nothing was sent.");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
  it.each(["book", "shop", "create", "ask", "follow"])("GET /p/:handle/%s renders", async (door) => {
    const r = await get(`/p/avery-okafor/${door}`);
    expect(r.status).toBe(200);
    expect(r.text).toContain('href="/p/avery-okafor"'); // back to the profile
  });
});

describe("dev fixtures", () => {
  it("serve the same renderer, uncached, outside production", async () => {
    const r = await get("/p/_dev/fixtures/rowan-castell");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.text).toContain('href="/p/_dev/fixtures/rowan-castell/partner"');
    expect((await get("/p/_dev/fixtures")).text).toContain("sam-ito");
    expect((await get("/p/_dev/fixtures/sam-ito/create")).status).toBe(200);
  });
  it("404 in production (every deployed service), whatever else is set", async () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_CARD_FIXTURES = "true";
    expect((await get("/p/_dev/fixtures/avery-okafor")).status).toBe(404);
    expect((await get("/p/_dev/fixtures")).status).toBe(404);
  });
  it("unknown fixture → 404", async () => {
    expect((await get("/p/_dev/fixtures/nobody")).status).toBe(404);
  });
});

describe("static bundle + Mila loops", () => {
  it("serves the stylesheet and script, and nothing else from that folder", async () => {
    const css = await get("/p/_a/front.css?v=x");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toMatch(/text\/css/);
    expect((await get("/p/_a/front.js")).headers.get("content-type")).toMatch(/javascript/);
    expect((await get("/p/_a/other.js")).status).toBe(404);
    expect((await get("/p/_a/..%2F..%2Fpackage.json")).status).toBe(404);
  });
  it("serves the Mila widget bundle and links it from the page, with its data block", async () => {
    expect((await get("/p/_a/mila.js?v=x")).status).toBe(200);
    expect((await get("/p/_a/mila.css?v=x")).headers.get("content-type")).toContain("text/css");
    const page = await get("/p/avery-okafor");
    expect(page.text).toContain('<script src="/p/_a/mila.js?v=');
    expect(page.text).toContain('<link rel="stylesheet" href="/p/_a/mila.css?v=');
    expect(page.text).toContain('<script type="application/json" id="pc-data">');
  });
  it("without the widget (mila: false) the doors stay plain links and the bundle is not served", async () => {
    const app = express();
    app.use(createPublicPageRouter({ mila: false, loadView: async (h) => PUBLIC_CARD_FIXTURES[h] ?? null }));
    const s = await new Promise<Server>((resolve) => { const x = app.listen(0, () => resolve(x)); });
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const html = await (await fetch(b + "/p/avery-okafor")).text();
    expect(html).not.toContain("mila.js");
    expect(html).not.toContain("pc-data");
    expect((await fetch(b + "/p/_a/mila.js")).status).toBe(404);
    await new Promise<void>((resolve) => s.close(() => resolve()));
  });
  it("serves Mila's idle loop with byte ranges (Safari needs them) and the still", async () => {
    const r = await fetch(`${base}/p/_a/mila/mila-idle.mp4?v=1`, { headers: { Range: "bytes=0-99" } });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect(r.headers.get("cache-control")).toMatch(/max-age=31536000/);
    await r.arrayBuffer();
    expect((await get("/p/_a/mila/mila-still.png")).status).toBe(200);
    expect((await get("/p/_a/mila/mila-speaking.mp4")).status).toBe(404); // voice is not on the public page
  });
});

describe("public Mila mode on the page (PR 5, ASK_MILA_PUBLIC)", () => {
  afterEach(() => { delete process.env.ASK_MILA_PUBLIC; });
  const dataOf = (html: string) => JSON.parse(html.split('<script type="application/json" id="pc-data">')[1].split("</script>")[0]);
  async function serve(askMila: boolean | undefined, taps?: { booking: boolean; partner: boolean }) {
    const app = express();
    app.use(createPublicPageRouter({ loadView: async (h) => (PUBLIC_CARD_FIXTURES[h] ? { ...PUBLIC_CARD_FIXTURES[h], askMila } : null), askTaps: taps }));
    const s = await new Promise<Server>((resolve) => { const x = app.listen(0, () => resolve(x)); });
    return { b: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => s.close(() => r())) };
  }

  it("off: no ask.js on the page or served, and the sheet gets no endpoint (typing stays closed)", async () => {
    const { b, close } = await serve(true);
    const html = await (await fetch(b + "/p/avery-okafor")).text();
    expect(html).not.toContain("ask.js");
    expect(dataOf(html).ask).toBeNull();
    expect((await fetch(b + "/p/_a/ask.js")).status).toBe(404);
    await close();
  });

  it("on, with her Ask Mila on: ask.js after mila.js, the endpoint and only the wired taps; the ETag differs", async () => {
    const off = await serve(true);
    const etagOff = (await fetch(off.b + "/p/avery-okafor")).headers.get("etag");
    await off.close();
    process.env.ASK_MILA_PUBLIC = "true";
    const { b, close } = await serve(true, { booking: false, partner: true });
    const res = await fetch(b + "/p/avery-okafor");
    const html = await res.text();
    expect(html.indexOf('<script src="/p/_a/ask.js?v=')).toBeGreaterThan(html.indexOf('<script src="/p/_a/mila.js?v='));
    expect(dataOf(html).ask).toEqual({ endpoint: "/p/avery-okafor/ask", booking: false, partner: true });
    expect(res.headers.get("etag")).not.toBe(etagOff);
    const js = await fetch(b + "/p/_a/ask.js?v=x");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    await close();
  });

  it("on, but her Ask Mila off, or a dev fixture page: no ask.js and no endpoint", async () => {
    process.env.ASK_MILA_PUBLIC = "true";
    process.env.NODE_ENV = "test";
    const { b, close } = await serve(false);
    const html = await (await fetch(b + "/p/avery-okafor")).text();
    expect(html).not.toContain("ask.js");
    expect(dataOf(html).ask).toBeNull();
    const fx = await (await fetch(b + "/p/_dev/fixtures/avery-okafor")).text();
    expect(fx).not.toContain("ask.js");
    await close();
  });
});
