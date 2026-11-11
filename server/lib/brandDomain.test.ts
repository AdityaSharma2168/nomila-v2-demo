/**
 * Peeling a sending host down to the brand's actual domain.
 *
 * Every case here is a real row from inbox_brands, because the failure this fixes was not
 * hypothetical: 271 of 271 deals had no usable brand domain, so search rendered a grey icon
 * where the brand's logo belongs.
 *
 * The two rules that matter pull in opposite directions, which is why both are pinned:
 *  - peel a KNOWN sending prefix (email.jellycat.com is not an identity)
 *  - leave an UNKNOWN subdomain alone (athletics.msstate.edu is one)
 * A blanket "keep the last two labels" satisfies the first and destroys the second.
 */

import { registrableDomain, brandDomainOf, domainOf } from "./senderProfile";

describe("registrableDomain", () => {
  it.each([
    ["email.jellycat.com",        "jellycat.com"],
    ["e.lululemon.com",           "lululemon.com"],
    ["mkt.pacsun.com",            "pacsun.com"],
    ["news.ussoccer.com",         "ussoccer.com"],
    ["info.asics.com",            "asics.com"],
    ["emails.fleetfeet.com",      "fleetfeet.com"],
    ["us.mail.shein.com",         "shein.com"],      // two prefixes deep
    ["usa.temu.com",              "temu.com"],
    ["fanmail.sjearthquakes.com", "sjearthquakes.com"],
    ["newsletter.togethxr.com",   "togethxr.com"],
  ])("peels %s to %s", (input, expected) => {
    expect(registrableDomain(input)).toBe(expected);
  });

  it("leaves an unrecognised subdomain alone", () => {
    // These ARE the brand. A university athletics department is not msstate.edu, and
    // trimming to two labels to satisfy jellycat would silently merge it with the university.
    expect(registrableDomain("athletics.msstate.edu")).toBe("athletics.msstate.edu");
    expect(registrableDomain("athletics.pitt.edu")).toBe("athletics.pitt.edu");
  });

  it("keeps three labels over a two-part public suffix", () => {
    // The bug this replaced: falling back to the last two labels returned the bare suffix
    // "co.uk", and the image fetcher went looking for a logo on a public suffix.
    expect(registrableDomain("creatorlab.campfire.co.uk")).toBe("campfire.co.uk");
    expect(registrableDomain("campfire.co.uk")).toBe("campfire.co.uk");
    expect(registrableDomain("email.something.com.au")).toBe("something.com.au");
  });

  it("handles www, case, padding and junk", () => {
    expect(registrableDomain("WWW.Gorjana.com ")).toBe("gorjana.com");
    expect(registrableDomain("gorjana.com")).toBe("gorjana.com");
    expect(registrableDomain("localhost")).toBeNull();   // no dot — not a domain
    expect(registrableDomain("")).toBeNull();
    expect(registrableDomain(null)).toBeNull();
  });
});

describe("brandDomainOf", () => {
  it("returns null for senders that are not the brand", () => {
    // A wrong logo is worse than none: Constant Contact's mark on a Payless deal renders
    // perfectly and nobody looks twice. A blank shows a monogram and invites a correction.
    expect(brandDomainOf("shared1.ccsend.com")).toBeNull();          // Constant Contact
    expect(brandDomainOf("us.umusic-online.com")).toBeNull();        // Universal Music
    expect(brandDomainOf("arms.mail.armssoftware.com")).toBeNull();  // athletics CRM
    expect(brandDomainOf("immersivegamebox.creator-hero.com")).toBeNull();
    // Creator platforms and bulk-sending hosts: their logo is the platform's, never the brand's.
    expect(brandDomainOf("partners.jellyotter.io")).toBeNull();
    expect(brandDomainOf("mail.collabs.io")).toBeNull();
    expect(brandDomainOf("msg-biz.online")).toBeNull();
    // A brand whose name merely resembles a platform is untouched.
    expect(brandDomainOf("mail.jellyotterswim.com")).toBe("jellyotterswim.com");
  });

  it("catches an unlisted subdomain of a known non-brand sender", () => {
    // The check runs on the PEELED domain, so a new sending host at a known ESP is refused
    // without anyone adding it to the list.
    expect(brandDomainOf("email.ccsend.com")).toBeNull();
    expect(brandDomainOf("anything.sendgrid.net")).toBeNull();
  });

  it("a free-mail (shared mailbox) domain is never a brand's identity", () => {
    expect(brandDomainOf("gmail.com")).toBeNull();
    expect(brandDomainOf("adobesign.com")).toBeNull();     // e-sign paperwork names the brand, never owns it
    expect(brandDomainOf("na2.docusign.net")).toBeNull();
    expect(brandDomainOf("yahoo.com")).toBeNull();
    expect(brandDomainOf("outlook.com")).toBeNull();
    expect(brandDomainOf("icloud.com")).toBeNull();
  });

  it("still returns real brands", () => {
    expect(brandDomainOf("email.jellycat.com")).toBe("jellycat.com");
    expect(brandDomainOf("gorjana.com")).toBe("gorjana.com");
  });
});

describe("domainOf stays exact", () => {
  it("does not peel", () => {
    // Load-bearing. The pre-filter, the blocked-domain list and the self-sender check all
    // reason about the host that actually sent the mail. Peeling here would let a blocked
    // sending host through via a parent domain that is not blocked.
    expect(domainOf("Brand <hello@email.jellycat.com>")).toBe("email.jellycat.com");
    expect(domainOf("x@shared1.ccsend.com")).toBe("shared1.ccsend.com");
  });
});
