/**
 * plainQualificationReason — "Why it's here" in her words (owner, 8 Oct 2026). A termed verdict is worded from the
 * STRUCTURED floor check / offer, never from code's rule sentence about floors and cash-only measurement; an untermed
 * verdict keeps the model's one plain sentence. Pure.
 */
jest.mock("../db", () => ({ db: {} }));

import { floorFor, minimumContextFor, plainQualificationReason, withoutRetiredFloor, type StoredQualification } from "./dealQualification";
import { deliverableOfText } from "../../shared/deals";

const q = (o: Partial<StoredQualification>): StoredQualification => ({
  channel: "direct", qualification: "workable", qualification_reason: "", qualification_version: "opps-qual/1",
  qualification_message_id: null, qualification_floor: null, ...o,
});
const RULE_TEXT = /floor|cash-only|measured against|terms are stated/i;

it("below and at her minimum: worded from the floor check", () => {
  const floor = { kind: "social_post" as const, cash: 500, units: 2, floor: 400, source: "minimum_rate" as const };
  expect(plainQualificationReason(q({ qualification: "below_floor", qualification_floor: floor, qualification_reason: "The cash offered ($500 for 2 social posts) is under your floor for this kind of work ($400 each)." })))
    .toBe("They offered $500 for 2 social posts. That’s under your minimum of $400 each.");
  expect(plainQualificationReason(q({ qualification_floor: { ...floor, units: 1 } })))
    .toBe("They offered $500 for 1 social post. That meets your minimum of $400 each.");
});

it("termed without a minimum: product, commission or a named fee — never the rule sentence", () => {
  const stored = "Terms are stated (product); it isn't a cash-only offer, so it isn't measured against your floor.";
  expect(plainQualificationReason(q({ qualification_reason: stored }), { state: "product" })).toBe("They’re offering product, not a fee.");
  expect(plainQualificationReason(q({ qualification_reason: stored }), { offer: { unit: "gifting_only", product_value: 250 } })).toBe("They’re offering product worth about $250, not a fee.");
  expect(plainQualificationReason(q({}), { offer: { unit: "commission_only" } })).toBe("They’re offering a commission on sales, not a set fee.");
  // Commission only shares the product state (23 Oct): still worded as commission, never as product.
  expect(plainQualificationReason(q({}), { state: "product", offer: { unit: "commission_only" } })).toBe("They’re offering a commission on sales, not a set fee.");
  expect(plainQualificationReason(q({ qualification_reason: "Terms are stated (commission); it isn't a cash-only offer, so it isn't measured against your floor." }), { state: "product" }))
    .toBe("They’re offering a commission on sales, not a set fee.");
  expect(plainQualificationReason(q({}), { cash: 1200 })).toBe("They named a fee of $1,200. You haven’t set a minimum for this kind of work yet.");
  for (const r of [plainQualificationReason(q({ qualification_reason: stored })), plainQualificationReason(q({}), { cash: 10 })]) expect(r).not.toMatch(RULE_TEXT);
});

describe("a named fee with no stored floor check: her minimum for THIS work, never 'none set' when she has some", () => {
  // A generic athlete with minimums for Reels and appearances only (no feed-post minimum, no legacy key).
  const minimumRates = { ig_reel: 900, appearance_in_person_hour: 400 };

  it("a deliverable the classifier named in words maps to its rate type (work kind 'other' included)", () => {
    const m = minimumContextFor({ minimumRates, dealType: "paid_content", workKind: "other", deliverableTexts: ["2 Instagram Reels"] });
    expect(m).toMatchObject({ rateType: "ig_reel", minimum: 900, anySet: true });
    expect(plainQualificationReason(q({}), { cash: 1500, minimum: m })).toBe("They named a fee of $1,500. Your minimum for an Instagram Reel is $900.");
  });

  it("a term-sheet deliverable refines the deal type's key", () => {
    const m = minimumContextFor({ minimumRates, dealType: "appearance", termDeliverables: [{ kind: "appearance_hour" }] });
    expect(m).toMatchObject({ rateType: "appearance_in_person_hour", minimum: 400 });
  });

  it("a kind of work she has no minimum for is named", () => {
    const m = minimumContextFor({ minimumRates, dealType: "paid_content", deliverableTexts: ["1 TikTok video"] });
    expect(plainQualificationReason(q({}), { cash: 600, minimum: m })).toBe("They named a fee of $600. You haven’t set a minimum for a TikTok video yet.");
  });

  it("work that maps to no rate type says which work it couldn't match, not that she has no minimums", () => {
    const m = minimumContextFor({ minimumRates, dealType: null, workKind: "other", deliverableTexts: ["Brand podcast mention"] });
    expect(m.rateType).toBeNull();
    const r = plainQualificationReason(q({}), { cash: 700, minimum: m });
    expect(r).toBe("They named a fee of $700. You have minimums set, but Nomila couldn’t match “Brand podcast mention” to one of them.");
    expect(r).not.toMatch(/haven’t set/);
  });

  it("with no minimums at all, it says so plainly", () => {
    const m = minimumContextFor({ minimumRates: {}, dealType: "paid_content", workKind: "other", deliverableTexts: ["mystery work"] });
    expect(plainQualificationReason(q({}), { cash: 700, minimum: { ...m, rateType: null } })).toBe("They named a fee of $700. You haven’t set any minimums yet.");
  });

  it("the qualification check itself reads the deliverables: a Reel offer is measured against her Reel minimum", () => {
    expect(floorFor("social_post", { minimumRates }, ["3 Instagram Reels"])).toEqual({ floor: 900, source: "minimum_rate" });
    expect(floorFor("other", { minimumRates }, ["one IG reel"])).toEqual({ floor: 900, source: "minimum_rate" });
    expect(floorFor("social_post", { minimumRates }, [])).toBeNull();
  });

  it("free-text deliverables: the specific format wins", () => {
    expect(["2 Instagram Reels", "IG story x3", "one TikTok", "TikTok Live", "YouTube Short", "virtual meet and greet", "in-person appearance", "feed post", "Instagram carousel"].map(deliverableOfText))
      .toEqual(["ig_reel", "ig_story", "tiktok_video", "tiktok_live", "yt_short", "virtual_appearance", "appearance_hour", "ig_post", "ig_carousel"]);
    expect(deliverableOfText("something else")).toBeNull();
  });
});

it("a retired computed floor reads as no minimum set", () => {
  const retired = withoutRetiredFloor(q({ qualification: "below_floor", qualification_floor: { kind: "social_post", cash: 300, units: 1, floor: 876, source: "rate_card_mid" } }));
  expect(plainQualificationReason(retired, { cash: 300 })).toBe("They named a fee of $300. You haven’t set a minimum for this kind of work yet.");
});

it("untermed verdicts keep the model's own sentence; nothing stored → null", () => {
  expect(plainQualificationReason(q({ qualification: "needs_terms", qualification_reason: "They want three posts but haven't named a fee." }))).toBe("They want three posts but haven't named a fee.");
  expect(plainQualificationReason(q({ qualification: "needs_terms", qualification_reason: "  " }))).toBeNull();
  expect(plainQualificationReason(null)).toBeNull();
});
