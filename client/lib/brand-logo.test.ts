/**
 * brand-logo.test — the ONE source chain behind every brand / platform mark (ui/LogoMark):
 * the stored logo (never a dead Clearbit URL) → Google's favicon for the domain → nothing (the caller's initials).
 * No Clearbit is ever minted, and no domain is ever guessed from a name.
 */
import { brandLogoChain, brandLogoUri, domainFromLogoUrl, platformDomain } from "./brand-logo";

test("a stored logo wins; a Clearbit logo is dead and falls through to the domain's favicon", () => {
  expect(brandLogoUri("https://cdn.example/logo.png", "brand.example")).toBe("https://cdn.example/logo.png");
  expect(brandLogoUri("https://logo.clearbit.com/brand.example", "brand.example")).toBe("https://www.google.com/s2/favicons?domain=brand.example&sz=128");
  expect(brandLogoUri("   ", "https://www.brand.example/path")).toBe("https://www.google.com/s2/favicons?domain=www.brand.example&sz=128");
});

test("no logo and no domain ⇒ null (initials), never a guess; a Clearbit URL alone ⇒ null", () => {
  expect(brandLogoUri(null, null)).toBeNull();
  expect(brandLogoUri("https://logo.clearbit.com/x.com", null)).toBeNull();
  expect(JSON.stringify(brandLogoUri("https://logo.clearbit.com/x.com", "x.com"))).not.toContain("clearbit");
});

test("platformDomain: the known platforms' sites, `<platform>.com` otherwise, null for nothing", () => {
  expect(platformDomain("instagram")).toBe("instagram.com");
  expect(platformDomain("TikTok")).toBe("tiktok.com");
  expect(platformDomain("twitter")).toBe("x.com");
  expect(platformDomain("gmail")).toBe("gmail.com");
  expect(platformDomain("twitch")).toBe("twitch.com");
  expect(platformDomain("")).toBeNull();
  expect(platformDomain(null)).toBeNull();
});

test("domainFromLogoUrl: the domain from every stored logo form Nomila mints (Yoku, favicon, old Clearbit); else null", () => {
  expect(domainFromLogoUrl("https://cdn.yoku.app/gorjana.com/type/logo/w/256/format/png/fallback/404")).toBe("gorjana.com");
  expect(domainFromLogoUrl("https://www.google.com/s2/favicons?domain=adidas.com&sz=128")).toBe("adidas.com");
  expect(domainFromLogoUrl("https://www.google.com/s2/favicons?sz=64&domain=Example.org")).toBe("example.org");
  expect(domainFromLogoUrl("https://logo.clearbit.com/nike.com")).toBe("nike.com");
  expect(domainFromLogoUrl("https://cdn.example.com/logo.png")).toBeNull();
  expect(domainFromLogoUrl(null)).toBeNull();
});

test("brandLogoChain: the stored logo, then the domain's favicon (given, or read off the stored URL); never Clearbit, no duplicates", () => {
  const yoku = "https://cdn.yoku.app/brand.example/type/logo/w/256/format/png/fallback/lettermark";
  // A Yoku logo is asked for in its fail-on-miss form, so a miss steps down to the favicon instead of a letter.
  expect(brandLogoChain(yoku, null)).toEqual([
    "https://cdn.yoku.app/brand.example/type/logo/w/256/format/png/fallback/404",
    "https://www.google.com/s2/favicons?domain=brand.example&sz=128",
  ]);
  expect(brandLogoChain(yoku, "brand.example")[1]).toBe("https://www.google.com/s2/favicons?domain=brand.example&sz=128");
  // A favicon stored as the logo is not tried twice.
  expect(brandLogoChain("https://www.google.com/s2/favicons?domain=brand.example&sz=128", null)).toEqual(["https://www.google.com/s2/favicons?domain=brand.example&sz=128"]);
  // A logo from elsewhere keeps its path untouched; with no domain there is nothing behind it.
  expect(brandLogoChain("https://cdn.example/fallback/lettermark", null)).toEqual(["https://cdn.example/fallback/lettermark"]);
  expect(brandLogoChain("https://logo.clearbit.com/brand.example", null)).toEqual(["https://www.google.com/s2/favicons?domain=brand.example&sz=128"]);
  expect(brandLogoChain(null, null)).toEqual([]);
});
