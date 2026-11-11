/**
 * contactDetails.test.ts — the one contact-detail stripper (lib/contactDetails.ts), and the detector research shares.
 * Made-up people and places only; no database, no network.
 */
import { privateFormats, stripContactDetails } from "./contactDetails";

describe("stripContactDetails", () => {
  it.each([
    ["an email with its emoji label and a labelled handle (a profile bio)", "Rower and coach in training 🚣 💌: someone@example.com ig: lake.rower", "Rower and coach in training 🚣"],
    ["an email with a word label", "Distance swimmer. Business inquiries: team@example.org", "Distance swimmer."],
    ["an @handle", "Proud member of the crew @riverclub_official", "Proud member of the crew"],
    ["a handle followed by more words", "Shoutout @coach.jo for the plan. Back at it Monday.", "Shoutout for the plan. Back at it Monday."],
    ["a URL", "New video up https://example.com/watch?v=abc123 — go see it", "New video up — go see it"],
    ["a www address", "Everything is at www.example.net", "Everything is"],
    ["a bare web address", "Shop my picks at mystore.shop | Fencer", "Shop my picks | Fencer"],
    ["a link-in-bio address", "Climber 🧗 linktr.ee/someclimber", "Climber 🧗"],
    ["a North American phone", "Bookings (555) 010-2030", ""],
    ["a dotted phone", "Call 555.010.2030 for sessions", "for sessions"],
    ["a spaced phone", "Text 555 010 2030", ""],
    ["an international phone", "WhatsApp +44 20 7946 0958 anytime", "anytime"],
    ["ten digits run together", "Coach | 5550102030", "Coach"],
    ["a street address", "Camp is held at 450 West Oak Ave each June", "Camp is held each June"],
    ["a PO box", "Letters welcome at PO Box 1234.", "Letters welcome."],
    ["several at once", "📧 hi@example.com • 📞 555-010-2030 • 🌐 example.com", ""],
  ])("removes %s", (_label, input, expected) => {
    expect(stripContactDetails(input)).toBe(expected);
  });

  it.each([
    "Two-time regional champion, 2019 - 2023.",
    "12,400 followers and counting. 3:45 mile, 1500m in 4:02.",
    "Training for the 2028 Games. Faith, family, and the next race.",
    "Rowing taught me patience — and a 5 a.m. alarm.",
    "U.S. junior team member since 2024.",
    "Line one\n\nLine two   with   spacing",
  ])("leaves normal text exactly as it is: %s", (text) => {
    expect(stripContactDetails(text)).toBe(text);
  });

  it("keeps a handle it is told to keep (the page's own link), and a shop's web-address name when asked", () => {
    expect(stripContactDetails("Follow @myhandle", { keepHandles: new Set(["myhandle"]) })).toBe("Follow @myhandle");
    expect(stripContactDetails("Example.com", { bareDomains: false })).toBe("Example.com");
    expect(stripContactDetails("Example.com")).toBe("");
  });

  it("is idempotent", () => {
    const once = stripContactDetails("Sprinter ⚡ DM for collabs: @fast.one | fast@example.com");
    expect(once).toBe("Sprinter ⚡");
    expect(stripContactDetails(once)).toBe(once);
  });
});

describe("privateFormats (research privacy, unchanged)", () => {
  it("finds an email, a strict phone and a street address; not year ranges or stats", () => {
    expect(privateFormats("write to a@example.com")).toEqual(["contact"]);
    expect(privateFormats("call (555) 010-2030")).toEqual(["contact"]);
    expect(privateFormats("lives at 12 Example Street")).toEqual(["address"]);
    expect(privateFormats("2019 - 2023, 12,400 followers")).toEqual([]);
  });
});
