import {
  firstNameFrom,
  buildGreeting,
  buildSignature,
  sanitizeDraftBody,
  assembleReplyEmail,
  reflowHardWraps,
} from "./draftFormat";

describe("firstNameFrom", () => {
  it("takes the first token of a display name, capitalized", () => {
    expect(firstNameFrom("sarah lee")).toBe("Sarah");
    expect(firstNameFrom("Sarah Lee")).toBe("Sarah");
  });

  it("handles 'Last, First' ordering", () => {
    expect(firstNameFrom("Lee, Sarah")).toBe("Sarah");
  });

  it("strips wrapping quotes from Gmail display names", () => {
    expect(firstNameFrom('"Sarah Lee"')).toBe("Sarah");
  });

  it("rejects email addresses and junk", () => {
    expect(firstNameFrom("sarah@acme.com")).toBeNull();
    expect(firstNameFrom("  ")).toBeNull();
    expect(firstNameFrom(null)).toBeNull();
    expect(firstNameFrom("123 Marketing")).toBeNull();
  });
});

describe("buildGreeting", () => {
  it("greets the sender by first name when available", () => {
    expect(buildGreeting({ senderName: "Sarah Lee", brandName: "Acme" })).toBe("Hi Sarah,");
  });

  it("falls back to the brand team", () => {
    expect(buildGreeting({ senderName: "sarah@acme.com", brandName: "Acme" })).toBe("Hi Acme team,");
  });

  it("falls back to a neutral greeting", () => {
    expect(buildGreeting({ senderName: null, brandName: null })).toBe("Hi there,");
  });
});

describe("buildSignature", () => {
  it("uses the saved preference verbatim", () => {
    expect(buildSignature({ sign_off: "Go Dawgs", name: "Jordan T." })).toBe("Go Dawgs,\nJordan T.");
  });

  it("strips a trailing comma the user typed into the sign-off", () => {
    expect(buildSignature({ sign_off: "Thanks,", name: "Jordan" })).toBe("Thanks,\nJordan");
  });

  it("defaults to Best + athlete first name when no preference is set", () => {
    expect(buildSignature(null, "Jordan Taylor")).toBe("Best,\nJordan");
    expect(buildSignature({}, "Jordan Taylor")).toBe("Best,\nJordan");
  });

  it("degrades to just the sign-off when no name is known", () => {
    expect(buildSignature(null, null)).toBe("Best,");
  });
});

describe("sanitizeDraftBody", () => {
  it("passes a clean body through unchanged", () => {
    const body = "Thanks so much for reaching out about the campaign.\n\nI'd love to hear more about the deliverables. Could we set up a quick call this week?";
    expect(sanitizeDraftBody(body)).toBe(body);
  });

  it("strips a leading subject line and greeting the model added anyway", () => {
    const raw = "Subject: Re: Partnership\n\nHi Sarah,\n\nThanks for reaching out — I'm interested.\n\nWhat are the next steps?";
    expect(sanitizeDraftBody(raw)).toBe("Thanks for reaching out — I'm interested.\n\nWhat are the next steps?");
  });

  it("strips a trailing sign-off block including the name under it", () => {
    const raw = "Thanks for the offer — I'm excited to move forward.\n\nBest regards,\nJordan Taylor";
    expect(sanitizeDraftBody(raw)).toBe("Thanks for the offer — I'm excited to move forward.");
  });

  it("keeps a short closing sentence that is content, not a sign-off", () => {
    const raw = "Thanks for the offer.\n\nLooking forward to it!";
    expect(sanitizeDraftBody(raw)).toBe(raw);
  });

  it("does not treat a mid-body 'Thanks' paragraph as a sign-off", () => {
    const raw = "Thanks!\n\nCould you share the creative brief and the shoot window?";
    expect(sanitizeDraftBody(raw)).toBe(raw);
  });

  // The greeting is composed in code and prepended, so a salutation left in the
  // body ships as a doubled greeting. The own-line case was handled; the model
  // routinely runs it into the first sentence instead.
  it("strips a greeting run into the first sentence", () => {
    const raw = "Hi Jenn! Thank you so much for reaching out.\n\nCould you share the deliverables?";
    expect(sanitizeDraftBody(raw)).toBe("Thank you so much for reaching out.\n\nCould you share the deliverables?");
  });

  it("strips an inline greeting separated by a dash or comma", () => {
    expect(sanitizeDraftBody("Hey Jennifer — thanks for reaching out.")).toBe("Thanks for reaching out.");
    expect(sanitizeDraftBody("Hello Jennifer, thanks for reaching out.")).toBe("Thanks for reaching out.");
    expect(sanitizeDraftBody("Good morning Sarah — I'd love to hear more.")).toBe("I'd love to hear more.");
  });

  it("strips an inline greeting after a subject line", () => {
    const raw = "Subject: Re: Partnership\n\nHi Sarah, thanks for reaching out.";
    expect(sanitizeDraftBody(raw)).toBe("Thanks for reaching out.");
  });

  it("does not eat a sentence that merely opens with a greeting word", () => {
    // No separator — this is body copy, not a salutation.
    const raw = "Hi rates for social posts vary by scope, so let me explain.";
    expect(sanitizeDraftBody(raw)).toBe(raw);
  });

  it("does not strip a greeting that appears mid-body", () => {
    const raw = "Thanks for the note.\n\nHi again, just following up on the timeline.";
    expect(sanitizeDraftBody(raw)).toBe(raw);
  });

  it("removes placeholder tokens", () => {
    const raw = "I'd love to partner with [Brand Name] on this.\n\nMy rate for this scope is {{rate}} — happy to discuss.";
    expect(sanitizeDraftBody(raw)).toBe("I'd love to partner with on this.\n\nMy rate for this scope is — happy to discuss.");
  });

  it("drops lines that leak internal analysis", () => {
    const raw = "I'm excited about this opportunity.\nPer the M.I.A. score analysis, I have strong leverage here.\nCould we discuss the rate?";
    expect(sanitizeDraftBody(raw)).toBe("I'm excited about this opportunity.\nCould we discuss the rate?");
  });

  it("strips markdown emphasis and collapses extra blank lines", () => {
    const raw = "I love **this campaign** idea.\n\n\n\nLet me know the `next steps`.";
    expect(sanitizeDraftBody(raw)).toBe("I love this campaign idea.\n\nLet me know the next steps.");
  });
});

describe("assembleReplyEmail", () => {
  it("joins greeting, body, and signature with blank lines", () => {
    expect(
      assembleReplyEmail({ greeting: "Hi Sarah,", body: "Thanks for reaching out.", signature: "Best,\nJordan" }),
    ).toBe("Hi Sarah,\n\nThanks for reaching out.\n\nBest,\nJordan");
  });

  it("skips an empty body rather than doubling blank lines", () => {
    expect(assembleReplyEmail({ greeting: "Hi there,", body: "  ", signature: "Best," })).toBe("Hi there,\n\nBest,");
  });
});


describe("reflowHardWraps", () => {
  // A synthetic reply in the shape of what "really weird spacing" looked like: Kimi
  // wrapped at ~75 columns, we sent text/plain, and every client froze those breaks —
  // then a phone wrapped the 75-char lines again. (Invented text, not a real email.)
  const SENT_FOR_REAL = [
    "Hi Ava,",
    "",
    "Thanks so much for the follow-up, and it was lovely to hear from you! As I",
    "mentioned to Dana & the team, I really like the products and the founder’s",
    "story. Our values line up well.",
  ].join("\n");

  it("folds a hard-wrapped paragraph back into one line", () => {
    expect(reflowHardWraps(SENT_FOR_REAL)).toBe(
      "Hi Ava,\n\nThanks so much for the follow-up, and it was lovely to hear from you! " +
      "As I mentioned to Dana & the team, I really like the products and the founder’s " +
      "story. Our values line up well.",
    );
  });

  it("never drops or reorders a word", () => {
    const words = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");
    expect(words(reflowHardWraps(SENT_FOR_REAL))).toBe(words(SENT_FOR_REAL));
  });

  it("keeps blank-line paragraph breaks", () => {
    const twoParas = [
      "In short, I keep a small number of partners and build long-term, durable",
      "partnerships with each of them.",
      "",
      "Here is a second paragraph that is also long enough to have been wrapped by",
      "the model at the usual column.",
    ].join("\n");
    expect(reflowHardWraps(twoParas).split("\n")).toEqual([
      "In short, I keep a small number of partners and build long-term, durable partnerships with each of them.",
      "",
      "Here is a second paragraph that is also long enough to have been wrapped by the model at the usual column.",
    ]);
  });

  it("leaves a short line alone, so a greeting never swallows the line below", () => {
    expect(reflowHardWraps("Dana,\nCongratulations!")).toBe("Dana,\nCongratulations!");
  });

  it("preserves deliverable lists and the label line above them", () => {
    const withList = [
      "Here’s a proposal that should sit comfortably inside the campaign budget:",
      "- $12k: $8K cash / $4K product credit",
      "- 2 Instagram reels plus 3 stories across the launch window in October",
      "- 1 appearance",
    ].join("\n");
    expect(reflowHardWraps(withList)).toBe(withList);
  });

  it("handles numbered lists the same way", () => {
    const numbered = [
      "The timeline I would suggest, assuming we can agree on the rate this week:",
      "1. Contract signed by the end of this month so production can be scheduled",
      "2. Shoot in September",
    ].join("\n");
    expect(reflowHardWraps(numbered)).toBe(numbered);
  });

  it("is a no-op on text that was never wrapped", () => {
    const clean = "Short one.\n\nAnother paragraph.";
    expect(reflowHardWraps(clean)).toBe(clean);
  });

  it("runs as part of sanitizeDraftBody, so the saved draft is already reflowed", () => {
    const raw = [
      "Thank you for the quick reply! It was really nice to hear from you, and I look",
      "forward to working together on this.",
    ].join("\n");
    expect(sanitizeDraftBody(raw)).toBe(
      "Thank you for the quick reply! It was really nice to hear from you, and I look forward to working together on this.",
    );
  });
});

// Cases an adversarial review proved the first (length-only) predicate mangled. Each
// one is text a real reply plausibly contains, where joining destroys meaning.
describe("reflowHardWraps — what it must NOT join", () => {
  it("leaves a contact block under a finished sentence alone", () => {
    const raw = [
      "Happy to test the product — please send it over whenever you are ready.",
      "Jordan Smith",
      "1234 Elm Street, Apt 5",
      "Austin, TX 78701",
    ].join("\n");
    expect(reflowHardWraps(raw)).toBe(raw);
  });

  it("keeps an unmarked deliverable list as separate lines", () => {
    const raw = [
      "Here is what I can offer for this campaign:",
      "2 Instagram Reels and 4 Stories over a four-week flight window in March",
      "Full usage rights for 6 months",
      "Whitelisting available at an additional fee",
    ].join("\n");
    expect(reflowHardWraps(raw)).toBe(raw);
  });

  it("keeps a rate table's rows apart", () => {
    const raw = [
      "Here is my rate card for the deliverables you described in your note.",
      "Instagram Reel $1,500",
      "Story frames (3) $500",
    ].join("\n");
    expect(reflowHardWraps(raw)).toBe(raw);
  });

  it("does not fold a sign-off the trailing-block matcher doesn't know", () => {
    const raw = [
      "I would love to be part of this campaign and can share my media kit today.",
      "Warm wishes,",
      "Jordan",
    ].join("\n");
    expect(reflowHardWraps(raw)).toBe(raw);
  });

  it("keeps sentences that were deliberately put on their own lines", () => {
    const raw = [
      "I would love to move forward with this and can start as early as March.",
      "One quick thing before we sign anything.",
    ].join("\n");
    expect(reflowHardWraps(raw)).toBe(raw);
  });

  it("never inlines a link or splits one across a wrap", () => {
    const standalone = [
      "You can see the full audience demographics and past campaign work here:",
      "https://nomila.co/media-kit/jordan-smith",
      "Let me know what you think.",
    ].join("\n");
    expect(reflowHardWraps(standalone)).toBe(standalone);

    const split = [
      "The deck lives at https://docs.google.com/document/d/abc123/view?usp=",
      "sharing",
    ].join("\n");
    expect(reflowHardWraps(split)).toBe(split);
  });

  it.each(["→", "»", "✓", "+", "◦", "‣", "▪"])(
    "protects list items marked with %s",
    (marker) => {
      const raw = [
        "These are the deliverables I would suggest for the launch this spring:",
        `${marker} 2 Instagram Reels delivered before the campaign window opens`,
        `${marker} 4 Stories across the launch week itself`,
      ].join("\n");
      expect(reflowHardWraps(raw)).toBe(raw);
    },
  );

  it("normalizes CRLF instead of leaking it into the output", () => {
    const raw = "This line is long enough to have been wrapped by the model at\r\ncolumn.";
    expect(reflowHardWraps(raw)).toBe("This line is long enough to have been wrapped by the model at column.");
  });
});
