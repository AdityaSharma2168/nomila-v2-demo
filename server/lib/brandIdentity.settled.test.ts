/**
 * Who a brand is, settled without asking the athlete when the evidence is strong (pure parts): the verified
 * official-site match, the evidence picker, and identitySettled.
 */
// Pure functions only: a stub db, so nothing opens (or outlives) a database.
jest.mock("../db", () => ({ db: {} }));

import { describe, expect, it } from "@jest/globals";
import { identitySettled, strongSiteMatch, trustedOwnCover, type BrandCandidate } from "./brandIdentity";
import { strongIdentityEvidence } from "../services/brandConfirmation";

const cand = (over: Partial<BrandCandidate>): BrandCandidate => ({
  domain: "remedyorganics.com", name: "Remedy Organics", source: "web_search_verified", proposed_at: "2026-10-20T00:00:00Z",
  confidence: "high", evidence: "homepage: Remedy Organics", ...over,
});

describe("strongSiteMatch", () => {
  it("accepts the brand's own title, alone or with generic words", () => {
    expect(strongSiteMatch("Remedy Organics", cand({}))).toBe(true);
    expect(strongSiteMatch("INIU", cand({ domain: "iniushop.com", evidence: "homepage: INIU Official Store" }))).toBe(true);
    expect(strongSiteMatch("MUD\\WTR", cand({ domain: "mudwtr.com", evidence: "homepage: MUD\\WTR" }))).toBe(true);
    expect(strongSiteMatch("GAMEGOU", cand({ domain: "gamegou.com", evidence: "homepage: Gamegou" }))).toBe(true);
  });

  it("refuses a different or partial name, a weaker search, or medium confidence", () => {
    expect(strongSiteMatch("Insight Labs", cand({ domain: "insightlabs.ai", evidence: "homepage: Agentic Phone" }))).toBe(false);
    expect(strongSiteMatch("Remedy Organics", cand({ evidence: "homepage: Remedy" }))).toBe(false);
    expect(strongSiteMatch("NextGen Prospects", cand({ evidence: "homepage: Nextgen Prospect" }))).toBe(false);
    expect(strongSiteMatch("Remedy Organics", cand({ evidence: "homepage: Remedy Organics Fake Reviews" }))).toBe(false);
    expect(strongSiteMatch("Chevrolet", cand({ source: "name_search", evidence: "homepage: Chevrolet" }))).toBe(false);
    expect(strongSiteMatch("Remedy Organics", cand({ confidence: "medium" }))).toBe(false);
    expect(strongSiteMatch("Remedy Organics", cand({ evidence: null }))).toBe(false);
  });
});

describe("strongIdentityEvidence", () => {
  it("a verified official site settles a brand with no domain", () => {
    expect(strongIdentityEvidence({ name: "Remedy Organics", domain: null, enrichment: { candidate: cand({}) } }))
      .toEqual({ domain: "remedyorganics.com", basis: "verified_official_site", evidence: "homepage: Remedy Organics" });
  });

  it("the brand's own email domain settles it when no search disagrees", () => {
    expect(strongIdentityEvidence({ name: "StartX1", domain: "startx1.com", enrichment: {} }))
      .toEqual({ domain: "startx1.com", basis: "sender_domain", evidence: "domain from the brand's email: startx1.com" });
  });

  it("weak or conflicting evidence asks the athlete", () => {
    expect(strongIdentityEvidence({ name: "Insight Labs", domain: null, enrichment: { candidate: cand({ domain: "insightlabs.ai", evidence: "homepage: Agentic Phone" }) } })).toBeNull();
    expect(strongIdentityEvidence({ name: "Chevrolet", domain: null, enrichment: { candidate: cand({ domain: "chevrolet.com", source: "name_search", evidence: null }) } })).toBeNull();
    expect(strongIdentityEvidence({ name: "Acme", domain: "acme-mail.com", enrichment: { candidate: cand({ domain: "acme.com", evidence: "homepage: Acme" }) } })).toBeNull();
    expect(strongIdentityEvidence({ name: "Harrison Szep", domain: null, enrichment: {} })).toBeNull();
  });
});

describe("identitySettled", () => {
  it("research, her tap or the system each settle it; nothing else does", () => {
    expect(identitySettled({ identity: { status: "confirmed", domain: "a.com", own_sources: ["a.com"], basis: "own_domain_source", checked_at: "" } })).toBe(true);
    expect(identitySettled({ athlete_confirmed: { domain: "a.com", assertion_id: "x", at: "2026-10-20T00:00:00Z" } })).toBe(true);
    expect(identitySettled({ system_confirmed: { domain: "a.com", basis: "verified_official_site", evidence: null, at: "2026-10-20T00:00:00Z" } })).toBe(true);
    expect(identitySettled({ identity: { status: "unconfirmed", domain: "a.com", own_sources: [], basis: "no_own_domain_source", checked_at: "" } })).toBe(false);
    expect(identitySettled(null)).toBe(false);
  });
});

describe("trustedOwnCover", () => {
  const own = { source: "own_site", domain: "remedyorganics.com", cover: "https://remedyorganics.com/og.jpg", logo_url: null, basis: "system_confirmed", fetched_at: "2026-10-22T00:00:00Z" };
  it("shows the own-site cover only while the system or she vouches for that domain", () => {
    const sys = { domain: "remedyorganics.com", basis: "verified_official_site", evidence: null, at: "2026-10-22T00:00:00Z" };
    expect(trustedOwnCover({ domain: "remedyorganics.com", enrichment: { own_site: own, system_confirmed: sys } })).toBe(own.cover);
    expect(trustedOwnCover({ domain: "remedyorganics.com", enrichment: { own_site: own, system_confirmed: { ...sys, basis: "sender_domain" } } })).toBeNull();
    expect(trustedOwnCover({ domain: "remedyorganics.com", enrichment: { own_site: own } })).toBeNull();
  });
});
