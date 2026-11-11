import { preFilterEmail, isForwardedSubject } from "./emailFilters";
import { parseFrom, MASS_PR_AGGREGATOR_DOMAINS } from "./senderProfile";

describe("isForwardedSubject", () => {
  it("recognizes common Fwd / Fw subjects", () => {
    for (const s of ["Fwd: Partnership with Acme", "FW: rate card", "Fw: Re: hello", " [Fwd]: brief "]) {
      expect(isForwardedSubject(s)).toBe(true);
    }
    expect(isForwardedSubject("Re: Partnership with Acme")).toBe(false);
    expect(isForwardedSubject("Sponsorship opportunity")).toBe(false);
  });
});

// Deterministic pre-filter drop for high-volume creator-PR aggregators, whose blasts
// are structurally indistinguishable from real deals to the LLM classifier.
// Synthetic senders and subjects (.test domains); only the aggregator domains are real,
// because they are the blocklist under test.
describe("preFilterEmail — mass-PR aggregator block", () => {
  it("drops crevasse.ai campaign blasts before any LLM call", () => {
    const r = preFilterEmail("campaigns@crevasse.ai", "💸 2nd Round Invitation | Synthetic Creator Campaign");
    expect(r.shouldProcess).toBe(false);
    expect(r.reason).toMatch(/aggregator: crevasse\.ai/);
  });

  it("drops every kglowing* domain variant", () => {
    for (const from of [
      "official@kglowingamerica.com",
      "collab@kglowingusa.com",
      "campaigns@kglowingusa.co.kr",
      "partners@kglowing.ai",
    ]) {
      const r = preFilterEmail(from, "[Brand] @riley.athlete.test Free serum for 1 TikTok 🎁");
      expect(r.shouldProcess).toBe(false);
      expect(r.reason).toMatch(/aggregator: kglowing/);
    }
  });

  it("beats the pr@/collab@ brand fast-track (ordering guard)", () => {
    // pr@kglowing.com matches BRAND_SENDER_PATTERNS /^pr@/ — it must still be dropped,
    // which only holds because the aggregator check runs BEFORE the fast-track.
    const r = preFilterEmail("pr@kglowing.com", "PR Invitation: a celebrity's hair care secret");
    expect(r.shouldProcess).toBe(false);
    expect(r.reason).toContain("Mass-PR aggregator");
  });

  it("also matches the 'Display Name <email>' From format", () => {
    const r = preFilterEmail("Kglowing Team <official@kglowing.com>", "Gifted collab");
    expect(r.shouldProcess).toBe(false);
  });

  it("does NOT block genuine brand / agency outreach", () => {
    for (const from of [
      "partnerships@peakform.test",
      "gifting@agencynine.test",    // gifting via an agency
      "athletes@apparelco.test",    // apparel athlete program
      "jordan@prfirm.test",         // a retailer via its PR agency
    ]) {
      const r = preFilterEmail(from, "Collab opportunity with Riley");
      expect(r.shouldProcess).toBe(true);
    }
  });

  it("keeps the list lowercase (From is case-folded before substring match)", () => {
    expect(MASS_PR_AGGREGATOR_DOMAINS.length).toBeGreaterThan(0);
    for (const d of MASS_PR_AGGREGATOR_DOMAINS) expect(d).toBe(d.toLowerCase());
  });
});

describe("parseFrom", () => {
  it("extracts local part + domain, ignoring the display name", () => {
    expect(parseFrom("Nike Athlete Support <partnerships@nike.com>")).toEqual({ localPart: "partnerships", domain: "nike.com" });
    expect(parseFrom("bare@brand.io")).toEqual({ localPart: "bare", domain: "brand.io" });
  });
});

describe("preFilterEmail — A16 blocked-sender precision", () => {
  const proc = (from: string, subject = "Partnership opportunity") => preFilterEmail(from, subject).shouldProcess;

  it("no longer drops real brand outreach with a noise word in the display name", () => {
    // "Support" is only in the display name; the address is partnerships@nike.com.
    expect(proc("Nike Athlete Support <partnerships@nike.com>")).toBe(true);
  });

  it("does not drop a domain that merely contains a blocked domain as a substring", () => {
    expect(proc("Team <deals@maxx.com>")).toBe(true); // maxx.com is not x.com
  });

  it("still blocks the real platform domain (equality + subdomain)", () => {
    expect(proc("X <no@x.com>")).toBe(false);
    expect(proc("X <news@mail.x.com>")).toBe(false);
  });

  it("still blocks transactional local-parts (exact + token-boundary + prefix)", () => {
    expect(proc("Acme <support@acme.com>")).toBe(false);
    expect(proc("Acme <support-team@acme.com>")).toBe(false);
    expect(proc("Acme <noreply@acme.com>")).toBe(false);
    expect(proc("Acme <no-reply-42@acme.com>")).toBe(false);
  });

  it("does not block a local-part that merely ends with a blocked token", () => {
    expect(proc("Nike <athlete-support@nike.com>")).toBe(true);
  });
});

describe("deal paperwork senders pass the pre-filter (12 Oct 2026)", () => {
  it("e-sign, payment and scheduling providers reach the paperwork path", () => {
    for (const from of [
      "DocuSign <dse_na2@docusign.net>",
      "Dropbox Sign <noreply@mail.hellosign.com>",
      "Stripe <notifications@stripe.com>",
      "PayPal <service@paypal.com>",
      "Calendly <notifications@calendly.com>",
    ]) {
      expect([from, preFilterEmail(from, "Invoice for March posts").shouldProcess]).toEqual([from, true]);
    }
  });
  it("other blocked senders are still dropped", () => {
    expect(preFilterEmail("Amazon <orders@amazon.com>", "Your order").shouldProcess).toBe(false);
    expect(preFilterEmail("Dropbox <no-reply@dropbox.com>", "Shared folder").shouldProcess).toBe(false);
  });
});
