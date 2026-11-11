/**
 * brandIdentity — the own-domain correctness gate for brand research (BRAND_IDENTITY_GATE). Pure.
 */
import { brandDisplayLogo, brandNeedsCandidateLookup, decideIdentity, hostOf, identityNeedsCheck, literalAdvertiserDomain, onDomain, readIdentity } from "./brandIdentity";
import { bestLogoUrl } from "./brandLogoSources";

const NOW = new Date("2026-10-06T12:00:00Z");

describe("hostOf", () => {
  it("prefers the grounding title (Vertex URIs are redirects)", () => {
    expect(hostOf("www.mpgummies.com", "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc")).toBe("mpgummies.com");
  });
  it("falls back to the URI host, never the redirect host", () => {
    expect(hostOf("MPG Gummies — Home", "https://shop.mpgummies.com/about")).toBe("shop.mpgummies.com");
    expect(hostOf("Some page", "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc")).toBeNull();
  });
});

describe("onDomain", () => {
  it("matches the domain and its subdomains only — look-alikes never", () => {
    expect(onDomain("startx1.com", "startx1.com")).toBe(true);
    expect(onDomain("blog.startx1.com", "startx1.com")).toBe(true);
    expect(onDomain("startx.com", "startx1.com")).toBe(false);
    expect(onDomain("notstartx1.com", "startx1.com")).toBe(false);
  });
});

describe("decideIdentity", () => {
  it("confirmed when a grounding source is hosted on the evidence domain", () => {
    const id = decideIdentity("mpgummies.com", ["wikipedia.org", "mpgummies.com", "mpgummies.com"], NOW);
    expect(id).toEqual({ status: "confirmed", domain: "mpgummies.com", own_sources: ["mpgummies.com"], basis: "own_domain_source", checked_at: NOW.toISOString() });
  });
  it("unconfirmed when every source is about a look-alike (the StartX1 case)", () => {
    const id = decideIdentity("startx1.com", ["startx.com", "stanford.edu", "startx.fr"], NOW);
    expect(id).toMatchObject({ status: "unconfirmed", domain: "startx1.com", own_sources: [], basis: "no_own_domain_source" });
  });
  it("unconfirmed with no domain evidence — a name is never evidence", () => {
    expect(decideIdentity(null, ["stan-eats.com"], NOW)).toMatchObject({ status: "unconfirmed", domain: null, basis: "no_domain_evidence" });
  });
  it("free-mail and e-sign domains are not evidence", () => {
    expect(decideIdentity("gmail.com", ["gmail.com"], NOW)).toMatchObject({ status: "unconfirmed", domain: null });
  });
  it("checks against the registrable domain of a sending host", () => {
    expect(decideIdentity("email.gorjana.com", ["gorjana.com"], NOW)).toMatchObject({ status: "confirmed", domain: "gorjana.com" });
  });
});

describe("identityNeedsCheck", () => {
  const checked = { identity: { status: "unconfirmed", domain: null, own_sources: [], basis: "no_domain_evidence", checked_at: NOW.toISOString() } };
  it("never-researched rows are left to the normal freshness rule", () => {
    expect(identityNeedsCheck({ enriched_at: null, domain: null, enrichment: null })).toBe(false);
  });
  it("researched but never checked → re-check", () => {
    expect(identityNeedsCheck({ enriched_at: NOW, domain: "x.com", enrichment: { industry: "Tech" } })).toBe(true);
  });
  it("checked against the domain we still hold → no re-check", () => {
    expect(identityNeedsCheck({ enriched_at: NOW, domain: null, enrichment: checked })).toBe(false);
  });
  it("a domain arrived since the check (agency mail showed the site) → re-check", () => {
    expect(identityNeedsCheck({ enriched_at: NOW, domain: "mudwtr.com", enrichment: checked })).toBe(true);
  });
  it("readIdentity ignores malformed records", () => {
    expect(readIdentity({ identity: { status: "maybe" } })).toBeNull();
    expect(readIdentity(checked)?.status).toBe("unconfirmed");
  });
});

describe("literalAdvertiserDomain", () => {
  const body = "Hi Mia, we're reaching out from Collabs on behalf of MUD\\WTR — see https://www.mudwtr.com/starter-kit for the kit.";
  it("keeps a domain that literally appears in the message", () => {
    expect(literalAdvertiserDomain("mudwtr.com", body, "mail.collabs.io")).toBe("mudwtr.com");
    expect(literalAdvertiserDomain("https://www.mudwtr.com/", body, "mail.collabs.io")).toBe("mudwtr.com");
  });
  it("drops a domain the model supplied from memory", () => {
    expect(literalAdvertiserDomain("hisense.com", "Hisense is an official World Cup sponsor.", "adelixir.com")).toBeNull();
  });
  it("is bounded: x1.com is not present inside startx1.com", () => {
    expect(literalAdvertiserDomain("x1.com", "write to hello@startx1.com", "agency.com")).toBeNull();
  });
  it("finds it in an address", () => {
    expect(literalAdvertiserDomain("brand.co", "cc: partnerships@brand.co", "agency.com")).toBe("brand.co");
  });
  it("never the sender's own domain, free-mail, or junk", () => {
    expect(literalAdvertiserDomain("collabs.io", "via collabs.io", "mail.collabs.io")).toBeNull();
    expect(literalAdvertiserDomain("gmail.com", "write to me@gmail.com", "agency.com")).toBeNull();
    expect(literalAdvertiserDomain("not a domain", body, "agency.com")).toBeNull();
    expect(literalAdvertiserDomain(null, body, "agency.com")).toBeNull();
  });
});

describe("brandDisplayLogo", () => {
  const yoku = (d: string) => `https://cdn.yoku.app/${d}/type/logo/w/256/format/png/fallback/lettermark`;
  it("uses the row's own domain: its stored logo, else its favicon", () => {
    expect(brandDisplayLogo({ domain: "acme.com", logo_url: yoku("acme.com"), enrichment: null })).toBe(yoku("acme.com"));
    expect(brandDisplayLogo({ domain: "acme.com", logo_url: null, enrichment: null })).toContain("favicons?domain=acme.com");
    expect(brandDisplayLogo({ domain: "acme.com", logo_url: "https://logo.clearbit.com/acme.com", enrichment: null })).toContain("favicons?domain=acme.com");
  });
  it("falls back to the name search's candidate domain when the row has none", () => {
    const cand = { candidate: { domain: "mudwtr.com", name: "MUD\WTR", source: "name_search", proposed_at: "2026-10-20T00:00:00Z", logo_url: yoku("mudwtr.com") } };
    expect(brandDisplayLogo({ domain: null, logo_url: null, enrichment: cand })).toBe(yoku("mudwtr.com"));
    const noLogo = { candidate: { ...cand.candidate, logo_url: null } };
    expect(brandDisplayLogo({ domain: "", logo_url: null, enrichment: noLogo })).toContain("favicons?domain=mudwtr.com");
  });
  it("draws nothing for a person or free-mail sender with no company", () => {
    expect(brandDisplayLogo({ domain: null, logo_url: null, enrichment: { candidate_lookup: { at: "x", found: false } } })).toBeNull();
    expect(brandDisplayLogo({ domain: "gmail.com", logo_url: null, enrichment: null })).toBeNull();
  });
});

describe("brandNeedsCandidateLookup", () => {
  const now = new Date("2026-10-20T00:00:00Z");
  it("asks for a domain-less, non-agency brand not searched inside the cap window", () => {
    expect(brandNeedsCandidateLookup({ domain: null, enrichment: null }, now, 30)).toBe(true);
    expect(brandNeedsCandidateLookup({ domain: "acme.com", enrichment: null }, now, 30)).toBe(false);
    expect(brandNeedsCandidateLookup({ domain: null, enrichment: null, is_agency: true }, now, 30)).toBe(false);
    expect(brandNeedsCandidateLookup({ domain: null, enrichment: { candidate_lookup: { at: "2026-10-10T00:00:00Z" } } }, now, 30)).toBe(false);
    expect(brandNeedsCandidateLookup({ domain: null, enrichment: { candidate_lookup: { at: "2026-09-01T00:00:00Z" } } }, now, 30)).toBe(true);
  });
});

describe("bestLogoUrl", () => {
  const res = (ok: boolean, type: string) => ({ ok, headers: { get: () => type } }) as unknown as Response;
  it("takes Yoku only when it verifiably has the brand, else the favicon; never throws", async () => {
    expect(await bestLogoUrl("acme.com", (async () => res(true, "image/png")) as any)).toContain("cdn.yoku.app/acme.com");
    expect(await bestLogoUrl("acme.com", (async () => res(false, "text/html")) as any)).toContain("favicons?domain=acme.com");
    expect(await bestLogoUrl("acme.com", (async () => { throw new Error("down"); }) as any)).toContain("favicons?domain=acme.com");
  });
});
