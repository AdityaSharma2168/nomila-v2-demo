/**
 * senderProfile.test.ts — the facts, and the traps that made them facts.
 *
 * Almost every case here is a bug that reached production once. The matching rules look
 * fussy until you see what a careless one costs: a substring match dropped real brand mail
 * ("x.com" inside "maxx.com"), a display-name match dropped Nike, and an unanchored token
 * let a newsletter through because "chipotle" contains "hi".
 */

import {
  senderProfile, parseFrom, domainOf, isWorkflowDomain,
  MASS_PR_AGGREGATOR_DOMAINS,
} from "./senderProfile";

describe("parseFrom / domainOf — the address, never the display name", () => {
  it("reads the address out of a full header", () => {
    expect(parseFrom("Nike Athlete Support <partnerships@nike.com>"))
      .toEqual({ localPart: "partnerships", domain: "nike.com" });
  });

  it("reads a bare address", () => {
    expect(parseFrom("bare@brand.io")).toEqual({ localPart: "bare", domain: "brand.io" });
  });

  it("returns null domain when there is no address at all", () => {
    expect(domainOf("nope")).toBeNull();
    expect(domainOf(null)).toBeNull();
    expect(domainOf("")).toBeNull();
  });
});

describe("blocked senders", () => {
  it("matches a blocked domain by equality or suffix", () => {
    expect(senderProfile("a@shopify.com").blockedDomain).toBe("shopify.com");
    expect(senderProfile("a@mail.shopify.com").blockedDomain).toBe("shopify.com");
  });

  // The reason blocking is domain-scoped rather than a substring search.
  it("does NOT match a domain that merely contains a blocked one", () => {
    expect(senderProfile("hello@maxx.com").blockedDomain).toBeNull();
    expect(senderProfile("hi@notgoogle.company").blockedDomain).toBeNull();
  });

  it("matches transactional local parts, exact or token+separator", () => {
    expect(senderProfile("receipts@brand.com").blockedLocalPart).toBe("receipts");
    expect(senderProfile("support-team@brand.com").blockedLocalPart).toBe("support");
    expect(senderProfile("noreply-anything@brand.com").blockedLocalPart).toBe("noreply");
  });

  // The Nike regression: the display name is brand-controlled text and must never gate.
  it("does NOT block on a word that only appears in the display name", () => {
    expect(senderProfile("Nike Athlete Support <partnerships@nike.com>").blockedLocalPart).toBeNull();
  });

  it("does NOT block a local part that merely ends with a blocked token", () => {
    expect(senderProfile("athlete-support@brand.com").blockedLocalPart).toBeNull();
  });
});

describe("mass-PR aggregators", () => {
  it("matches as a substring of the whole header, so every kglowing* domain is covered", () => {
    expect(senderProfile("official@kglowingamerica.com").aggregator).toBe("kglowing");
    expect(senderProfile("pr@kglowing.com").aggregator).toBe("kglowing");
    expect(senderProfile("campaigns@crevasse.ai").aggregator).toBe("crevasse.ai");
  });

  it("leaves ordinary brands alone", () => {
    expect(senderProfile("colleen@wildgrain.test").aggregator).toBeNull();
  });

  it("the list is non-empty, since dropping it silently would be invisible", () => {
    expect(MASS_PR_AGGREGATOR_DOMAINS.length).toBeGreaterThan(0);
  });
});

describe("bulk marketing vs a human", () => {
  const blasts = [
    "adidas@us-news.comms.adidas.com",
    "marriottbonvoy@email-marriott.com",
    "chipotle@email.chipotle.com",
    "stores@e.lululemon.com",
    "one@email.chick-fil-a.com",
    "email@news.ussoccer.com",
  ];
  it.each(blasts)("%s is newsletter plumbing", (from) => {
    expect(senderProfile(from).bulkMarketing).toBe(true);
  });

  // The trap: an unanchored human-token match vetoed by accident, because "chipotle"
  // contains "hi". Same shape as "pr" inside "press".
  it("a brand name containing a human token is still plumbing", () => {
    expect(senderProfile("chipotle@email.chipotle.com").human).toBe(false);
    expect(senderProfile("express@email.brand.com").human).toBe(false);
  });

  it("a partnerships address on the same infrastructure is NOT plumbing", () => {
    expect(senderProfile("partnerships@email.somebrand.com").bulkMarketing).toBe(false);
  });

  it("a first.last address on the same infrastructure is NOT plumbing", () => {
    expect(senderProfile("sam.ortega@email.vitalis.test").bulkMarketing).toBe(false);
  });

  it("an ordinary brand domain is not plumbing at all", () => {
    expect(senderProfile("crew@novaro.test").bulkMarketing).toBe(false);
    expect(senderProfile("colleen@wildgrain.test").bulkMarketing).toBe(false);
  });
});

describe("free mail and workflow providers", () => {
  it("knows free mail", () => {
    expect(senderProfile("someone@gmail.com").freeMail).toBe(true);
    expect(senderProfile("someone@brand.com").freeMail).toBe(false);
  });

  // These carry a deal to `signed`. Judging the domain would break contracts silently.
  it("knows the providers that carry a deal forward, including subdomains", () => {
    expect(isWorkflowDomain("adobesign.com")).toBe(true);
    expect(isWorkflowDomain("na4.docusign.net")).toBe(true);
    expect(isWorkflowDomain("billing.stripe.com")).toBe(true);
    expect(isWorkflowDomain("randombrand.com")).toBe(false);
  });
});

describe("other facts", () => {
  it("recognises a brand outreach address", () => {
    expect(senderProfile("partnerships@nike.com").brandOutreach).toBe(true);
    expect(senderProfile("someone@nike.com").brandOutreach).toBe(false);
  });

  it("recognises a media outlet", () => {
    expect(senderProfile("editor@espn.com").mediaOutlet).toBe("espn.com");
    expect(senderProfile("editor@brand.com").mediaOutlet).toBeNull();
  });

  it("recognises a school address", () => {
    expect(senderProfile("athletics@stanford.edu").school).toBe(true);
    expect(senderProfile("a@stanford.com").school).toBe(false);
  });

  it("never throws on junk input", () => {
    for (const junk of ["", "   ", "not-an-email", "@", "a@", "@b.com"]) {
      expect(() => senderProfile(junk)).not.toThrow();
    }
    expect(() => senderProfile(null)).not.toThrow();
  });
});
