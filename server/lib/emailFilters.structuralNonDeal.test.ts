import { isPaymentToAthlete, statedPaymentAmount, structuralNonDeal, hasNamedBrandCampaign } from "./emailFilters";

// Stage-1 deterministic pre-filter. Non-deal CLASSES the LLM classifier over-admits
// (consumer promos, referral spam, platform pitches, agency onboarding, paid surveys)
// must be caught here with the right disposition — while REAL 1:1 brand deals pass
// through untouched (return null).
//
// SYNTHETIC DATA ONLY. Every sender, person, handle and message below is invented (.test
// domains). Each case reproduces the SHAPE of a message class the filter must handle, never
// the text of a real email (Google API Limited Use: Gmail content is never kept in the repo).

describe("structuralNonDeal — real non-deals ARE flagged", () => {
  it("fan-community platform pitch → platform_pitch", () => {
    const r = structuralNonDeal(
      "team@huddlehq.test",
      "Exclusive Fan Community Opportunity for your superfans",
      "Hey Riley — we built you something. Join our platform and give your superfans exclusive access. Monetize your audience with our dashboard. Check it out at huddlehq.test",
    );
    expect(r).not.toBeNull();
    expect(r!.disposition).toBe("platform_pitch");
  });

  it("fintech referral → referral", () => {
    const r = structuralNonDeal(
      "no@northpeakbank.test",
      "Get $400 when you open Northpeak Checking",
      "Open a Northpeak Checking account today and get $400 when you open with direct deposit.",
    );
    expect(r).not.toBeNull();
    expect(r!.disposition).toBe("referral");
  });

  it("restaurant consumer promo → consumer_promo", () => {
    const r = structuralNonDeal(
      "rewards@casaverdegrill.test",
      "Claim your free chips",
      "Your rewards are waiting. Claim your free chips and salsa in the app today.",
    );
    expect(r).not.toBeNull();
    expect(r!.disposition).toBe("consumer_promo");
  });

  it("hotel loyalty blast → consumer_promo", () => {
    const r = structuralNonDeal(
      "rewards@harborline.test",
      "Earn 125K Points",
      "Book now and earn 125K points toward your next stay with Harborline Rewards.",
    );
    expect(r).not.toBeNull();
    expect(r!.disposition).toBe("consumer_promo");
  });

  it("beauty gifting blast → consumer_promo", () => {
    const r = structuralNonDeal(
      "hello@glowmi.test",
      "[Glowmi] @riley.athlete.test Seoul's #1 serum — free product for 1 TikTok",
      "Hi @riley.athlete.test! We'd love to send you Seoul's #1 serum — free product in exchange for 1 TikTok. Apply via the form!",
    );
    expect(r).not.toBeNull();
    expect(r!.disposition).toBe("consumer_promo");
  });

  it("sports agency onboarding → agency_onboarding", () => {
    const r = structuralNonDeal(
      "recruiting@summitsportsagency.test",
      "Pro Representation & NIL Opportunities",
      "We'd love to represent you and add you to our network. We offer pro representation and can help you land NIL opportunities.",
    );
    expect(r).not.toBeNull();
    expect(r!.disposition).toBe("agency_onboarding");
  });

  it("compensated survey → survey", () => {
    const r = structuralNonDeal(
      "invites@insightpanel.test",
      "Compensated survey — share your insight",
      "You're invited to a compensated survey. We'd love your insight; participate in our research and get paid.",
    );
    expect(r).not.toBeNull();
    expect(r!.disposition).toBe("survey");
  });
});

describe("structuralNonDeal — real DEALS are NOT flagged (null)", () => {
  it("jewelry brand paid partnership proposal", () => {
    const r = structuralNonDeal(
      "partnerships@solsticejewelry.test",
      "Sports Club Partnership Proposal — $3.5k cash + product for 12 posts",
      "Hi Riley, we'd love to partner with you. We're offering $3.5k cash + product for 12 posts across the quarter.",
    );
    expect(r).toBeNull();
  });

  it("apparel brand World Cup paid campaign", () => {
    const r = structuralNonDeal(
      "talent@vantagesport.test",
      "World Cup paid campaign",
      "Hi Riley, we'd love to have you in our paid World Cup campaign this summer. Let's talk rates.",
    );
    expect(r).toBeNull();
  });

  it("podcast interview request", () => {
    const r = structuralNonDeal(
      "producer@benchtalk.test",
      "Interview request — would love to have you on the show",
      "Hi Riley, we'd love to have you as a guest on our podcast to talk about your season.",
    );
    expect(r).toBeNull();
  });

  it("apparel gifting note", () => {
    const r = structuralNonDeal(
      "gifting@lumawear.test",
      "Sending you some pieces",
      "Hi Riley! We'd love to send you some pieces from our new collection — no strings attached. What's your size?",
    );
    expect(r).toBeNull();
  });

  it("a gifting wrapper IS a mass blast when the ask is affiliate signup", () => {
    // The shape: free product as the wrapper, then a P.S. whose real ask is joining a
    // commission storefront through a referral link. It also addresses her as a
    // distribution channel ("you or anyone you know", "share it with friends") rather
    // than as a creator, and carries an unsubscribe footer.
    const r = structuralNonDeal(
      "Tess <tess@calmint.test>",
      "Calmint Gifting Opportunity!",
      "Hi Riley! I'm Tess reaching out from Calmint with a gifting opportunity for you or the " +
      "people in your life! If you (or anyone you know) is looking to unwind, " +
      "we'd love to send you some mints to try! Click the link below to fill out our gifting " +
      "form, or feel free to share it with friends. P.S.! We're also on a creator storefront, where you can " +
      "earn a 15% commission when you help support other customers. If you aren't already on " +
      "it, you can join with this referral link! Warmly, Tess, Partnerships @ " +
      "Calmint. Click here to unsubscribe.",
    );
    expect(r?.disposition).toBe("referral");
  });

  it("commission ON TOP of a fee is still a real deal", () => {
    // The precision guard for the rule above: a percentage alongside a fee is a deal
    // ("negotiate flat fee + commission"), not affiliate spam.
    const r = structuralNonDeal(
      "partnerships@realbrand.test",
      "Campaign offer",
      "We'd love to work with you: $1,200 per video for three videos, plus 15% commission on " +
      "any sales your code drives. Happy to discuss the rate.",
    );
    expect(r).toBeNull();
  });

  it("agency naming a SPECIFIC brand campaign is a deal, not onboarding", () => {
    // "Gatorade" is on the filter's known-brand list; the agency and the message are invented.
    const r = structuralNonDeal(
      "talent@bigagency.test",
      "Gatorade campaign for you",
      "Hi Riley, we're a talent agency and we have a Gatorade campaign for you. We'd represent you on it — paid opportunity.",
    );
    expect(r).toBeNull();
  });
});

// Shapes the earlier rules let through to the Explore list.
describe("structuralNonDeal — sweepstakes / team admin / recruiting", () => {
  it("flags a prize draw (running store)", () => {
    const r = structuralNonDeal("news@stridestore.test", "Enter to win the Trailmax Runner PRO", "");
    expect(r?.disposition).toBe("sweepstakes");
  });

  it("flags 'chance to win' (hotel)", () => {
    const r = structuralNonDeal("news@harborline.test", "Enter for a Chance to Win One Night With a Headliner", "");
    expect(r?.disposition).toBe("sweepstakes");
  });

  it("flags a cash prize draw (rentals)", () => {
    const r = structuralNonDeal("hello@staysavvy.test", "Win $500. Tell us your story.", "");
    expect(r?.disposition).toBe("sweepstakes");
  });

  it("flags a club scouting report", () => {
    const r = structuralNonDeal("info@rivertonfc.test", "2026 Riverton FC Summer Showcase Scouting Report", "");
    expect(r?.disposition).toBe("team_admin");
  });

  it("flags league training logistics", () => {
    const r = structuralNonDeal("admin@youthleague.test", "National Talent ID — Training Tonight at 6PM & Tomorrow's Schedule", "");
    expect(r?.disposition).toBe("team_admin");
  });

  it("flags a kit-size request", () => {
    const r = structuralNonDeal("admin@youthleague.test", "Sizes Needed for the Tour!", "");
    expect(r?.disposition).toBe("team_admin");
  });

  it("flags hourly gig work", () => {
    const r = structuralNonDeal("no-reply@gigtasks.test", "Ready to get started on Project Lantern and earn $30/hr?", "");
    expect(r?.disposition).toBe("recruiting");
  });

  it("flags a job interview", () => {
    const r = structuralNonDeal("recruiting@quantfirm.test", "Interview with Quantfirm", "");
    expect(r?.disposition).toBe("recruiting");
  });
});

// The precision half. These are the shapes the new rules could plausibly swallow, and
// each is a deal we must NOT set aside — a wrong demote hides real money.
describe("structuralNonDeal — new rules do NOT swallow real deals", () => {
  it("a gifting offer is not a sweepstakes", () => {
    const r = structuralNonDeal(
      "gifting@agencynine.test",
      "[GIFTING OPPORTUNITY] Restwell Relief Now In Stores Nationwide",
      "We'd love to send you Restwell Relief to try and share with your audience.",
    );
    expect(r?.disposition).not.toBe("sweepstakes");
  });

  it("a paid campaign that mentions winning a match is not team admin", () => {
    const r = structuralNonDeal(
      "talent@brightview.test",
      "Brightview World Cup Event Content with Riley Quinn",
      "Paid content around the World Cup final — we'd cover appearance and usage.",
    );
    expect(r).toBeNull();
  });

  it("a paid rate discussion is not recruiting", () => {
    const r = structuralNonDeal(
      "brand@voltra.test",
      "Voltra Summer Campaign — Rate Discussion",
      "Following up on rates for the summer campaign — we're at $4,000 for three posts.",
    );
    expect(r).toBeNull();
  });

  it("a podcast interview REQUEST is still not recruiting", () => {
    const r = structuralNonDeal(
      "producer@benchtalk.test",
      "Interview request — would love to have you on the show",
      "We'd love to have you as a guest to talk about your season.",
    );
    expect(r).toBeNull();
  });
});

// A brand's retail newsletter is not an opportunity, and the difference from a real
// approach is structural rather than linguistic: partnership mail comes from a PERSON,
// advertising comes from the brand's own name on a send-only subdomain.
describe("structuralNonDeal — bulk-marketing senders", () => {
  const blasts = [
    ["strideline@us-news.comms.strideline.test", "Strideline Runner X World Cup 26"],
    ["harborlinerewards@email-harborline.test", "Your February stay in review"],
    ["stores@e.lumawear.test", "Come run with Lumawear and the Saturday Run Club"],
    ["one@email.casaverdegrill.test", "Tomorrow: Celebrate with food on us"],
    ["email@news.nationalsoccer.test", "Moving on"],
  ];
  it.each(blasts)("files %s as a marketing blast", (from, subject) => {
    const r = structuralNonDeal(from, subject, "Shop the new drop. View in browser.");
    expect(r?.disposition).toBe("marketing_blast");
  });

  // The bug this pins: an unanchored local-part guard vetoed by accident, because
  // "sushiro" contains "hi". Short tokens must match whole segments only.
  it("is not fooled by a brand name that happens to contain a human token", () => {
    const r = structuralNonDeal("sushiro@email.sushiro.test", "Riley: Claim your Free Edamame", "Free edamame awaits.");
    expect(r?.disposition).toBeDefined();
    expect(r?.disposition).not.toBeNull();
  });

  // ── the half that protects money ──────────────────────────────────────────
  it("does NOT file a person at a real brand", () => {
    expect(structuralNonDeal("colleen@wildgrain.test", "Your gift from us", "Hi Riley, we would love to send you...")).toBeNull();
  });

  it("does NOT file a partnerships address even on marketing infrastructure", () => {
    // A brand routing genuine outreach through its ESP must still get through.
    const r = structuralNonDeal("partnerships@email.somebrand.test", "Collab proposal", "Hi Riley, we would love to work together on a paid campaign.");
    expect(r?.disposition).not.toBe("marketing_blast");
  });

  it("does NOT file a first.last human address on marketing infrastructure", () => {
    const r = structuralNonDeal("sam.ortega@email.vitalis.test", "VITALIS", "Hi Riley, we are expanding into the US and would love to talk.");
    expect(r?.disposition).not.toBe("marketing_blast");
  });

  it("does NOT file an ordinary brand domain", () => {
    const r = structuralNonDeal("crew@novaro.test", "Collab", "Hi there, we would love to send you product.");
    expect(r?.disposition).not.toBe("marketing_blast");
  });

  // Order matters: a more specific content reason makes a better receipt than
  // "bulk-marketing sender", so the content rules keep precedence.
  it("still reports the SPECIFIC reason when a content rule also matches", () => {
    const r = structuralNonDeal(
      "harborlinerewards@email-harborline.test",
      "Enter for a Chance to Win One Night With a Headliner",
      "Enter to win a stay.",
    );
    expect(r?.disposition).toBe("sweepstakes");
  });
});

// Emptiness is judged on subject + body, because that is what the classifier reads and
// because a missing body is usually OUR failure, not the sender's: bodies lost by an old
// extraction bug came back as real pitches when re-fetched, and some can never be
// re-fetched while the subject still states the offer.
describe("structuralNonDeal — a message with nothing to evaluate", () => {
  it("does NOT flag a substantive subject just because the body is missing", () => {
    const r = structuralNonDeal("hi@legflow.test", "Paid Legflow Collab: Smarter Leg Recovery!", "");
    expect(r?.disposition).not.toBe("empty");
  });

  // An unrecoverable body, but the subject alone states a paid partnership — the subject
  // gives the classifier enough to judge, so the call belongs to it and not to a filter
  // reacting to text we lost.
  it("does NOT flag an offer stated in the subject when the body is gone", () => {
    const r = structuralNonDeal(
      "jo.reyes@helpinghands.test",
      "Paid Partnership with Helping Hands: International Women's Day",
      "",
    );
    expect(r?.disposition).not.toBe("empty");
  });

  it("flags a message with neither subject nor body", () => {
    expect(structuralNonDeal("a@b.com", "", "")?.disposition).toBe("empty");
  });

  it("flags whitespace-only in both fields", () => {
    expect(structuralNonDeal("a@b.com", "   ", "        ")?.disposition).toBe("empty");
  });

  // THE SAFETY CASE, and the reason the bar is EMPTY rather than SHORT. Mid-negotiation
  // replies are legitimately terse, and often come from a different person on the brand's
  // team, so no length threshold can separate them from a content-free blast.
  it("does NOT flag a short human reply mid-deal", () => {
    const r = structuralNonDeal(
      "legal@solsticejewelry.test",
      "Re: Sports Club Partnership",
      "Sounds good — sending the contract Monday.",
    );
    expect(r?.disposition).not.toBe("empty");
  });

  it("does NOT flag a one-line reply from a NEW person on the brand team", () => {
    const r = structuralNonDeal(
      "marcus@solsticejewelry.test",
      "Re: Sports Club Partnership",
      "Looping in Marcus who handles contracts.",
    );
    expect(r?.disposition).not.toBe("empty");
  });

  it("does NOT flag a terse but real offer", () => {
    const r = structuralNonDeal("talent@vantagesport.test", "Paid campaign", "$4,000 for three posts. Interested?");
    expect(r?.disposition).not.toBe("empty");
  });
});

describe("structuralNonDeal — billing mail is not a deal (invoices, receipts, statements, payment notices)", () => {
  it("a company's remittance / payment advice with an amount and no ask → billing", () => {
    const r = structuralNonDeal(
      "accounts.payable@northwind-apparel.test",
      "Payment advice 4471",
      "Dear supplier, please find the remittance details below. Goods and services supplied as invoiced. Amount: USD 1,250.00. Invoice number 88-311.",
    );
    expect(r?.disposition).toBe("billing");
  });

  it("an invoice, a receipt and an account statement → billing", () => {
    expect(structuralNonDeal("billing@northwind-apparel.test", "Invoice INV-2207 from Northwind", "Your invoice is attached. Amount due: $89.00 by 30 Oct.")?.disposition).toBe("billing");
    expect(structuralNonDeal("orders@harborgoods.test", "Your receipt from Harbor Goods", "Thanks for your purchase. Total paid $42.10.")?.disposition).toBe("billing");
    expect(structuralNonDeal("noreply@lakeview-credit.test", "Your monthly statement is ready", "Your October account statement is now available to view online.")?.disposition).toBe("billing");
  });

  it("a terse remittance subject (\"<Company> Adv.<number>;<date>\") with only a legal footer in the email text → billing", () => {
    const footer = "This e-mail or any attachments may contain confidential or privileged information. If you have received this e-mail in error, please notify the sender.";
    expect(structuralNonDeal("payment.advices@northwind-group.test", "Northwind Apparel Inc. Adv.20012345;10/15/2026", footer)?.disposition).toBe("billing");
    expect(structuralNonDeal("ap@northwind-group.test", "Payment advices", footer)?.disposition).toBe("billing");
    expect(structuralNonDeal("ap@northwind-group.test", "Fwd: details", `${footer}\n\nWe have settled the following items with bank transfer. Net USD 5,000.00`)?.disposition).toBe("billing");
  });

  it("does NOT read ordinary deal subjects as billing", () => {
    for (const subject of ["Advance copy of the campaign brief", "Adv. placement on our spring drop", "Ad campaign for the season", "Paid partnership — two posts"]) {
      expect(structuralNonDeal("maya@northwind-apparel.test", subject, "Would you be interested in working with us?")?.disposition).not.toBe("billing");
    }
    expect(structuralNonDeal("maya@northwind-apparel.test", "Advance copy of the campaign brief", "Here is the brief.")?.disposition).not.toBe("billing");
  });

  it("does NOT flag a real offer that mentions invoicing — the ask wins", () => {
    const r = structuralNonDeal(
      "maya@northwind-apparel.test",
      "Paid partnership — two posts",
      "Hi Riley, we'd love to partner with you on our spring campaign: two posts, $3,000, paid on invoice within 30 days. Would you be interested?",
    );
    expect(r?.disposition).not.toBe("billing");
  });

  it("does NOT flag deal-workflow payout mail (the paperwork matcher records it on the deal)", () => {
    const r = structuralNonDeal("receipts@stripe.com", "Your receipt from Northwind Apparel", "Payment received for the agreed campaign. Amount: $3,000.00.");
    expect(r?.disposition).not.toBe("billing");
  });
});

describe("hasNamedBrandCampaign", () => {
  it("recognizes a known brand by name", () => {
    expect(hasNamedBrandCampaign("we have a Gatorade campaign for you")).toBe(true);
    expect(hasNamedBrandCampaign("the Vuori activation next month")).toBe(true);
  });

  it("does not fire on generic agency boilerplate with no brand", () => {
    expect(hasNamedBrandCampaign("we offer pro representation and NIL opportunities")).toBe(false);
  });
});

describe("payment notices paying her vs other billing", () => {
  it("a remittance / payment advice is paid-to-her; an invoice, receipt or statement is not", () => {
    expect(isPaymentToAthlete("ap@payer-group.test", "Payerco Adv.20012345;10/15/2026", "We have settled the following items by bank transfer. Net USD 5,000.00")).toBe(true);
    expect(isPaymentToAthlete("ap@payer-group.test", "Remittance advice", "Payment of USD 900.00")).toBe(true);
    expect(isPaymentToAthlete("billing@northwind-apparel.test", "Invoice INV-2207", "Amount due: $89.00")).toBe(false);
    expect(isPaymentToAthlete("orders@harborgoods.test", "Your receipt from Harbor Goods", "Total paid $42.10.")).toBe(false);
    expect(isPaymentToAthlete("maya@northwind-apparel.test", "Paid partnership", "Would you be interested in two posts? Paid by bank transfer.")).toBe(false);
  });

  it("the stated amount: the labelled net/total first, else the largest currency-marked figure", () => {
    expect(statedPaymentAmount("Invoice 4471 USD 4,800.00 Net USD 5,000.00")).toEqual({ amountCents: 500000, currency: "usd" });
    expect(statedPaymentAmount("Items: $120.00, $80.50")).toEqual({ amountCents: 12000, currency: "usd" });
    expect(statedPaymentAmount("Inv 10/09/2026 USD        5,000.00        0.00        5,000.00")).toEqual({ amountCents: 500000, currency: "usd" });
    expect(statedPaymentAmount("Amount\nUSD\n5,000.00")).toBeNull();
    expect(statedPaymentAmount("Total paid 1.250,00")).toBeNull();
    expect(statedPaymentAmount("Amount paid: 700.00 EUR")).toEqual({ amountCents: 70000, currency: "eur" });
    expect(statedPaymentAmount("no money here")).toBeNull();
  });
});
