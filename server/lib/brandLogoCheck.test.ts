import { assessLogo, declaredIconUrls, homeBacksBrand, iconRejection, imageSize, readLogoCheck, logoCheckOf, logoColor, logoColorFromPixels, HERO_MAX_LIGHTNESS, MIN_ICON_BYTES } from "./brandLogoCheck";
import { brandDisplayColor, brandDisplayLogo, brandLogoNone } from "./brandIdentity";
import sharp from "sharp";

/** A PNG-shaped buffer: real signature + IHDR size, padded to `bytes`. Only the header is ever read. */
function png(w: number, h: number, bytes = 2000): Buffer {
  const b = Buffer.alloc(Math.max(bytes, 24), 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "ascii"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}
const response = (status: number, type: string, body: Buffer = Buffer.alloc(0)) =>
  ({ ok: status === 200, status, headers: { get: (k: string) => (k === "content-type" ? type : null) }, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) }) as any;

/** Yoku answers `yoku`; the favicon service answers `icon`. No network. */
const fakeFetch = (yoku: any, icon: any) => (async (url: string) => (String(url).includes("cdn.yoku.app") ? yoku : icon)) as any;
const home = (title: string | null) => async () => ({ finalDomain: "x", title, siteName: null });

describe("imageSize / iconRejection", () => {
  test("reads PNG size; rejects small, tiny, default and non-image icons", () => {
    expect(imageSize(png(180, 180))).toEqual({ w: 180, h: 180 });
    expect(iconRejection({ status: 200, contentType: "image/png", bytes: png(180, 180) })).toBeNull();
    expect(iconRejection({ status: 200, contentType: "image/png", bytes: png(32, 32) })).toBe("icon 32px");
    expect(iconRejection({ status: 200, contentType: "image/png", bytes: png(128, 128, MIN_ICON_BYTES - 10) })).toBe("icon too small");
    expect(iconRejection({ status: 404, contentType: "image/png", bytes: png(16, 16) })).toBe("no icon");
    expect(iconRejection({ status: 200, contentType: "text/html", bytes: png(128, 128) })).toBe("no icon");
  });
});

describe("declaredIconUrls", () => {
  test("largest declared icon first, apple-touch as 180, then the header logo; no SVG masks; absolute URLs", () => {
    const html = `<head><link rel="mask-icon" href="/mask.svg"><link rel="icon" sizes="16x16" href="/f16.png">
      <link rel="icon" sizes="192x192" href="https://cdn.x.com/i192.png"><link rel="apple-touch-icon" href="/at.png"></head>
      <header><img class="site-logo" src="/img/logo.png" alt="Brand"></header>`;
    expect(declaredIconUrls(html, "https://brand.com/")).toEqual([
      "https://cdn.x.com/i192.png", "https://brand.com/at.png", "https://brand.com/f16.png", "https://brand.com/img/logo.png",
    ]);
    expect(declaredIconUrls("<html></html>", "https://brand.com/")).toEqual([]);
  });
});

describe("homeBacksBrand", () => {
  test("the homepage must carry the brand's name; unreadable homepage falls back to the domain label", () => {
    expect(homeBacksBrand({ finalDomain: "a", title: "MUD\\WTR | A coffee alternative", siteName: null }, "mudwtr.com", "MUD\\WTR")).toBe(true);
    expect(homeBacksBrand({ finalDomain: "a", title: "Agentic Phone — early access", siteName: null }, "insightlabs.ai", "Insight Labs")).toBe(false);
    expect(homeBacksBrand(null, "insightlabs.ai", "Insight Labs")).toBe(true);
    expect(homeBacksBrand(null, "acme.com", "Zeta Foods")).toBe(false);
  });
});

describe("assessLogo", () => {
  test("Yoku's full logo first", async () => {
    const a = await assessLogo("acme.com", "Acme", { fetchImpl: fakeFetch(response(200, "image/png", png(256, 64)), null), home: home("Acme") });
    expect(a).toMatchObject({ source: "yoku", url: expect.stringContaining("cdn.yoku.app/acme.com") });
  });
  test("a big enough icon on a site that names the brand", async () => {
    const a = await assessLogo("acme.com", "Acme", { fetchImpl: fakeFetch(response(404, "text/html"), response(200, "image/png", png(180, 180))), home: home("Acme — shop") });
    expect(a).toMatchObject({ source: "favicon", url: expect.stringContaining("faviconV2") });
  });
  test("a 16px icon, a default icon, or a site that doesn't name the brand → the initial", async () => {
    const small = await assessLogo("acme.com", "Acme", { fetchImpl: fakeFetch(response(404, ""), response(200, "image/jpeg", png(16, 16, 400))), home: home("Acme") });
    expect(small).toMatchObject({ url: null });
    const other = await assessLogo("insightlabs.ai", "Insight Labs", { fetchImpl: fakeFetch(response(404, ""), response(200, "image/png", png(256, 256))), home: home("Agentic Phone — early access") });
    expect(other).toMatchObject({ url: null, reason: "site does not name the brand" });
    const builder = await assessLogo("acme.webflow.io", "Acme", { fetchImpl: fakeFetch(response(404, ""), response(200, "image/png", png(256, 256))), home: home("Acme") });
    expect(builder).toMatchObject({ url: null, reason: "site-builder host" });
  });
  test("a tiny favicon falls back to the site's own declared icon, only when the homepage names the brand", async () => {
    const page = `<html><head><title>Remedy Organics | Plant protein</title>
      <link rel="icon" href="/favicon-32.png" sizes="32x32"><link rel="apple-touch-icon" href="/apple-touch-icon.png"></head></html>`;
    const site = (title: string) => (async (url: string) => {
      const u = String(url);
      if (u.includes("cdn.yoku.app")) return response(404, "");
      if (u.includes("faviconV2")) return response(200, "image/png", png(16, 16, 400));
      if (u.endsWith("/apple-touch-icon.png")) return response(200, "image/png", png(180, 180));
      if (u.endsWith("/favicon-32.png")) return response(200, "image/png", png(32, 32));
      return { ...response(200, "text/html"), url: u, text: async () => page.replace("Remedy Organics | Plant protein", title) };
    }) as any;
    const own = await assessLogo("remedyorganics.com", "Remedy Organics", { fetchImpl: site("Remedy Organics | Plant protein") });
    expect(own).toMatchObject({ source: "site_icon", url: "https://remedyorganics.com/apple-touch-icon.png" });
    const notTheBrand = await assessLogo("remedyorganics.com", "Remedy Organics", { fetchImpl: site("Domain for sale") });
    expect(notTheBrand).toMatchObject({ url: null });
  });
  test("never throws", async () => {
    const a = await assessLogo("acme.com", "Acme", { fetchImpl: (async () => { throw new Error("down"); }) as any, home: home(null) });
    expect(a).toMatchObject({ url: null, reason: "unreachable" });
  });
});

describe("display respects the check", () => {
  const now = new Date("2026-10-20T00:00:00Z");
  test("a checked-none domain shows no favicon and flags logo_none; unchecked keeps today's floor", () => {
    const none = { logo_check: logoCheckOf("acme.com", { url: null, source: null, reason: "icon 16px" }, now) };
    expect(readLogoCheck(none, "acme.com")?.result).toBe("none");
    expect(brandDisplayLogo({ domain: "acme.com", logo_url: null, enrichment: none })).toBeNull();
    expect(brandLogoNone({ domain: "acme.com", enrichment: none })).toBe(true);
    expect(brandDisplayLogo({ domain: "acme.com", logo_url: null, enrichment: {} })).toContain("favicons?domain=acme.com");
    expect(brandLogoNone({ domain: "acme.com", enrichment: {} })).toBe(false);
    // A check for another domain never applies.
    expect(brandLogoNone({ domain: "other.com", enrichment: none })).toBe(false);
    // Candidate domain path.
    const cand = { candidate: { domain: "acme.com", logo_url: null }, ...none };
    expect(brandDisplayLogo({ domain: null, logo_url: null, enrichment: cand })).toBeNull();
    expect(brandLogoNone({ domain: null, enrichment: cand })).toBe(true);
  });
});

describe("the logo's colour", () => {
  /** RGBA pixels: `n` of one colour, the rest a ground. */
  const pixels = (fg: [number, number, number, number], n: number, ground: [number, number, number, number], total = 400) => {
    const a = new Uint8Array(total * 4);
    for (let i = 0; i < total; i++) a.set(i < n ? fg : ground, i * 4);
    return a;
  };
  test("the dominant colour, deepened for white type; the white or transparent ground never counts", () => {
    const red = logoColorFromPixels(pixels([230, 30, 40, 255], 120, [255, 255, 255, 255]));
    expect(red).toMatch(/^#[0-9A-F]{6}$/);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(red!.slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(g); expect(r).toBeGreaterThan(b);
    expect(Math.max(r, g, b)).toBeLessThanOrEqual(Math.round(255 * (2 * HERO_MAX_LIGHTNESS)) + 1);
    expect(logoColorFromPixels(pixels([20, 120, 220, 255], 80, [0, 0, 0, 0]))).not.toBeNull();
  });
  test("a colourless mark (black or grey on white) has no colour; stray pixels are not one", () => {
    expect(logoColorFromPixels(pixels([0, 0, 0, 255], 200, [255, 255, 255, 255]))).toBeNull();
    expect(logoColorFromPixels(pixels([128, 128, 128, 255], 200, [255, 255, 255, 255]))).toBeNull();
    expect(logoColorFromPixels(pixels([230, 30, 40, 255], 2, [255, 255, 255, 255]))).toBeNull();
  });
  test("reads a real image file; an unreadable one is null, never a throw", async () => {
    const file = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 46, g: 160, b: 90, alpha: 1 } } }).png().toBuffer();
    expect(await logoColor(file)).toMatch(/^#[0-9A-F]{6}$/);
    expect(await logoColor(Buffer.from("not an image"))).toBeNull();
  });
  test("the check stores it with an ok logo only, and display reads it for the domain checked", () => {
    const now = new Date("2026-10-20T00:00:00Z");
    expect(logoCheckOf("acme.com", { url: "u", source: "yoku", reason: "logo", color: "#8A1C22" }, now).color).toBe("#8A1C22");
    expect(logoCheckOf("acme.com", { url: null, source: null, reason: "none", color: "#8A1C22" }, now).color).toBeNull();
    const enrichment = { logo_check: logoCheckOf("acme.com", { url: "u", source: "yoku", reason: "logo", color: "#8A1C22" }, now) };
    expect(brandDisplayColor({ domain: "acme.com", enrichment })).toBe("#8A1C22");
    expect(brandDisplayColor({ domain: "other.com", enrichment })).toBeNull();
    expect(brandDisplayColor({ domain: null, enrichment: null })).toBeNull();
  });
});
