/**
 * relay/moderation.test.ts — the relay's check (design §7a): contact details, off-platform payment asks and links are
 * HELD; scam shapes are BLOCKED; ordinary deal talk is CLEAN — including numbers that are money, dates and quantities.
 */
import { moderateMessage, reasonText } from "./moderation";

const verdict = (s: string) => moderateMessage(s);

describe("clean: ordinary deal conversation passes", () => {
  it.each([
    "Thanks! Could you share your availability for the first week of November?",
    "We were thinking three short videos and one story, budget around $5,000 – $15,000.",
    "The shoot is on 2026-11-14 at 10:00 and lasts two hours.",
    "Our team loved your recovery notes. What formats do you usually do?",
    "We can send 2 pairs in size 8 and 9.",
    "Happy to adjust the timeline, 4 to 6 weeks works.",
    "Sounds good — let's keep everything here.",
  ])("%s", (s) => { expect(verdict(s)).toEqual({ state: "clean", reasons: [] }); });
});

describe("held: contact details", () => {
  it("an email address, plain or spelled out", () => {
    expect(verdict("email me at jordan@brand-example.com").reasons).toContain("contact_email");
    expect(verdict("reach me: jordan at brandexample dot com").reasons).toContain("contact_email");
    expect(verdict("jordan [at] brandexample [dot] com").state).toBe("held");
  });
  it("a phone number in any common shape", () => {
    for (const p of ["call 415 555 0134 tomorrow", "+1 (415) 555-0134", "my cell is 415.555.0134", "+44 20 7946 0958"]) {
      expect(verdict(p).reasons).toContain("contact_phone");
    }
  });
  it("a social handle, and asks to move to another app", () => {
    expect(verdict("follow @brand_official for the brief").reasons).toContain("contact_handle");
    expect(verdict("can you DM me on Instagram?").reasons).toContain("contact_offplatform");
    expect(verdict("WhatsApp me when you can").reasons).toContain("contact_offplatform");
    expect(verdict("add me on telegram").reasons).toContain("contact_offplatform");
  });
});

describe("held: off-platform payment asks", () => {
  it.each([
    "we can pay you directly via Venmo",
    "Zelle works for us",
    "let's do this off-platform to skip the fees",
    "we'll pay outside of Nomila",
    "paypal is easiest",
    "we can wire the money once signed",
  ])("%s", (s) => {
    const v = verdict(s);
    expect(v.state).toBe("held");
    expect(v.reasons).toContain("off_platform_payment");
  });
});

describe("held: links", () => {
  it("a URL, a www. host or a bare domain", () => {
    for (const l of ["see https://example.com/deck", "www.example.org has it", "the deck is on example.co/x"]) {
      expect(verdict(l).reasons).toContain("link");
    }
  });
  it("an email address is held as contact, not double-counted as a link", () => {
    expect(verdict("write to a@b-example.com").reasons).toEqual(["contact_email"]);
  });
  it("several reasons are kept together, in a stored form", () => {
    const v = verdict("Venmo me or text 415 555 0134, deck at https://x.example.com");
    expect(v.state).toBe("held");
    expect(v.reasons).toEqual(expect.arrayContaining(["contact_phone", "off_platform_payment", "link"]));
    expect(reasonText(v)).toMatch(/contact_phone/);
    expect(reasonText({ state: "clean", reasons: [] })).toBeNull();
  });
});

describe("blocked: scam shapes are never delivered", () => {
  it.each([
    "please pay the deposit in gift cards",
    "send me your password to set up the account",
    "we pay in bitcoin",
    "use Western Union for the fee",
    "tell me your verification code",
  ])("%s", (s) => { expect(verdict(s)).toEqual({ state: "blocked", reasons: ["scam"] }); });
});

describe("it does not read look-alikes as contact details", () => {
  it("prices, ranges, dates and order numbers are not phone numbers", () => {
    for (const s of ["$15,000 – $50,000", "2026-10-15 to 2026-11-15", "order 12345678", "between 1,000 and 5,000 units"]) {
      expect(verdict(s).reasons).not.toContain("contact_phone");
    }
  });
  it("unicode tricks are normalised first (full-width @)", () => {
    expect(verdict("name＠brandexample.com").reasons).toContain("contact_email");
  });
});
