import {
  candidateDomains, compactName, findVerifiedOfficialSite, homeIdentityFromHtml, isNotABrandSite, labelMatches, normaliseBrandName,
  siteTextMatches, type HomeIdentity, type SiteSearchAnswer,
} from "./brandSiteSearch";
import { loadJob } from "../agent/jobs";
import { modelFor } from "../agent/models";

test("names are normalised the way people know them", () => {
  expect(normaliseBrandName("MUD\\WTR")).toBe("MUD WTR");
  expect(normaliseBrandName("Remedy Organics, Inc.")).toBe("Remedy Organics");
  expect(normaliseBrandName("The Example Company LLC")).toBe("Example");
  expect(normaliseBrandName("  Acme/Labs  ")).toBe("Acme Labs");
  expect(compactName("MUD\\WTR")).toBe("mudwtr");
  expect(compactName("Salt & Stone")).toBe("saltandstone");
  expect(compactName("Café Ñ")).toBe("cafen");
});

test("non-brand sites are never candidates", () => {
  for (const d of ["amazon.com", "amazon.co.uk", "instagram.com", "linkedin.com", "en.wikipedia.org", "crunchbase.com", "walmart.com", "prnewswire.com", "shop.myshopify.com"]) {
    expect(isNotABrandSite(d)).toBe(true);
  }
  expect(isNotABrandSite("mudwtr.com")).toBe(false);
});

test("sending services and creator platforms are never a brand's site, at any depth", () => {
  for (const d of ["collabs.io", "mail.collabs.io", "jellyotter.io", "partners.jellyotter.io", "msg-biz.online", "news.msg-biz.online"]) {
    expect(isNotABrandSite(d)).toBe(true);
  }
});

test("label and site-text matching", () => {
  expect(labelMatches("mudwtr.com", "MUD\\WTR")).toBe(true);
  expect(labelMatches("drinkremedy.com", "Remedy")).toBe(true);           // contains, ≥ 4 letters
  expect(labelMatches("abc.com", "Remedy Organics")).toBe(false);
  expect(siteTextMatches(["MUD\\WTR | Coffee Alternative"], "MUD\\WTR")).toBe(true);
  expect(siteTextMatches(["Remedy Organics – plant protein"], "Remedy Organics Inc")).toBe(true);
  expect(siteTextMatches(["Shop everything"], "Remedy Organics")).toBe(false);
  expect(siteTextMatches(["AB"], "AB")).toBe(false);                        // too short to trust
});

test("homepage identity is read from title and og:site_name", () => {
  const html = `<html><head><title>Home &amp; Away | Example</title><meta property="og:site_name" content="Example Brand"></head></html>`;
  expect(homeIdentityFromHtml(html)).toEqual({ title: "Home & Away | Example", siteName: "Example Brand" });
  expect(homeIdentityFromHtml("<html></html>")).toEqual({ title: null, siteName: null });
});

test("candidates: the answer first, then cited hosts, without non-brand sites", () => {
  const ans = { domain: "https://www.mudwtr.com/shop", sources: [{ url: "https://www.amazon.com/x" }, { url: "https://mudwtr.com/about" }, { url: "https://press.example.org/a" }] };
  expect(candidateDomains(ans)).toEqual([{ domain: "mudwtr.com", cited: true }, { domain: "press.example.org", cited: true }]);
});

const answer = (domain: string | null, urls: string[] = []): SiteSearchAnswer => ({ domain, sources: urls.map((url) => ({ url })), cost: { microUsd: 12_000 } });
const homes = (m: Record<string, HomeIdentity | null>) => async (d: string) => (d in m ? m[d] : null);

test("accepts a site whose homepage carries the name; high when the domain agrees", async () => {
  const r = await findVerifiedOfficialSite("MUD\\WTR", {
    search: async () => answer("mudwtr.com", ["https://mudwtr.com"]),
    home: homes({ "mudwtr.com": { finalDomain: "mudwtr.com", title: "MUD\\WTR | A coffee alternative", siteName: null } }),
  });
  expect(r).toMatchObject({ domain: "mudwtr.com", confidence: "high", source: "web_search_verified", costMicroUsd: 12_000 });
});

test("medium when the homepage carries the name but the domain does not spell it", async () => {
  const r = await findVerifiedOfficialSite("Remedy Organics", {
    search: async () => answer("drinkplants.example"),
    home: homes({ "drinkplants.example": { finalDomain: "drinkplants.example", title: "Remedy Organics", siteName: null } }),
  });
  expect(r).toMatchObject({ domain: "drinkplants.example", confidence: "medium" });
});

test("rejects a site that does not carry the name, and a retailer, and an unverifiable guess", async () => {
  const wrong = await findVerifiedOfficialSite("Stan Eats", {
    search: async () => answer("stan.example", ["https://stan.example"]),
    home: homes({ "stan.example": { finalDomain: "stan.example", title: "Stan — streaming", siteName: null } }),
  });
  expect(wrong.domain).toBeNull();
  const retail = await findVerifiedOfficialSite("Acme Labs", { search: async () => answer("amazon.com", ["https://www.amazon.com/acme"]), home: homes({}) });
  expect(retail).toMatchObject({ domain: null, evidence: expect.stringContaining("non-brand") });
  // Unreadable homepage, label is the name, but the search never cited it: not enough.
  const uncited = await findVerifiedOfficialSite("Acmelabs", { search: async () => answer("acmelabs.example"), home: homes({}) });
  expect(uncited.domain).toBeNull();
});

test("an unreadable homepage passes only when the label IS the name and the search cited it", async () => {
  const r = await findVerifiedOfficialSite("Acmelabs", { search: async () => answer("acmelabs.example", ["https://acmelabs.example/"]), home: homes({}) });
  expect(r).toMatchObject({ domain: "acmelabs.example", confidence: "medium" });
});

test("a redirect to a non-brand site is not accepted", async () => {
  const r = await findVerifiedOfficialSite("Acme Labs", {
    search: async () => answer("acmelabs.example"),
    home: homes({ "acmelabs.example": { finalDomain: "amazon.com", title: "Acme Labs", siteName: null } }),
  });
  expect(r.domain).toBeNull();
});

test("the skill runs on OpenAI with web search (never Gemini)", () => {
  const skill = loadJob("brand/official-site");
  expect(skill.tools).toContain("web_search");
  expect(modelFor(skill).provider).toBe("openai");
});

test("roots, shared platforms and mere mentions", async () => {
  const { rootDomain, siteNamesItself } = await import("./brandSiteSearch");
  expect(rootDomain("shop.brand.example")).toBe("brand.example");
  expect(rootDomain("en.lador.co.kr")).toBe("lador.co.kr");
  expect(isNotABrandSite("acmehelp.zendesk.com")).toBe(true);
  expect(isNotABrandSite("acme.base44.app")).toBe(true);
  expect(siteNamesItself({ title: "MUD\WTR | A coffee alternative", siteName: null }, "MUD\WTR")).toBe(true);
  expect(siteNamesItself({ title: "Character — the home improvement brand", siteName: "Character" }, "Home Improvement Brand")).toBe(false);

  // A subdomain hit is stored as its root.
  const sub = await findVerifiedOfficialSite("Gamebrand", {
    search: async () => answer("welcome.gamebrand.example", ["https://welcome.gamebrand.example"]),
    home: homes({ "welcome.gamebrand.example": { finalDomain: "welcome.gamebrand.example", title: "Gamebrand", siteName: null } }),
  });
  expect(sub).toMatchObject({ domain: "gamebrand.example", confidence: "high" });
  // A help-desk page is the platform's, never the brand's.
  const desk = await findVerifiedOfficialSite("Acme", { search: async () => answer("acmehelp.zendesk.com"), home: homes({}) });
  expect(desk.domain).toBeNull();
  // A generic name that a title merely mentions, on a domain that does not spell it: rejected.
  const generic = await findVerifiedOfficialSite("Home Improvement Brand", {
    search: async () => answer("withcharacter.example"),
    home: homes({ "withcharacter.example": { finalDomain: "withcharacter.example", title: "Character — the home improvement brand", siteName: "Character" } }),
  });
  expect(generic.domain).toBeNull();
});
