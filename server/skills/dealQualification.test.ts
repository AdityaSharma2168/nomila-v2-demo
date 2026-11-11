/**
 * dealQualification — the code-enforced half of Opportunities PR 1 qualification. Pure: no DB, no model.
 */

jest.mock("../db", () => ({ db: {} }));

import {
  parseModelQualification,
  enforceQualification,
  mergeQualification,
  intakeActionFor,
  floorFor,
  withoutRetiredFloor,
  withoutUnstatedFee,
  effectiveQualification,
  UNSTATED_FEE_REASON,
  internalTestSenders,
  isInternalSender,
  possibleTestMessage,
  internalSenderQualification,
  QUALIFICATION_VERSION,
  type ModelQualification,
  type QualificationFloors,
  type StoredQualification,
} from "./dealQualification";

const FLOORS: QualificationFloors = {
  minimumRates: { socialPost: 1000 },
};

const model = (over: Partial<ModelQualification> = {}): ModelQualification => ({
  channel:            "direct",
  qualification:      "workable",
  reason:             "A brand offers a paid post.",
  claims_known_brand: false,
  work_kind:          "social_post",
  work_units:         1,
  cash_amount:        null,
  comp_kind:          null,
  ...over,
});

const enforce = (m: ModelQualification | null, over: Partial<Parameters<typeof enforceQualification>[0]> = {}) =>
  enforceQualification({ model: m, from: "Pat <pat@brandco.com>", deliverables: [], floors: FLOORS, messageId: "m1", ...over });

describe("parseModelQualification — schema widening", () => {
  it("reads every new field and validates enums", () => {
    const q = parseModelQualification({
      channel: "agency", qualification: "needs_terms", qualification_reason: "  Asks about fees.  ",
      claims_known_brand: true, work_kind: "appearance", work_units: "3", cash_amount: "$1,500", comp_kind: "cash",
    });
    expect(q).toEqual({
      channel: "agency", qualification: "needs_terms", reason: "Asks about fees.", claims_known_brand: true,
      work_kind: "appearance", work_units: 3, cash_amount: 1500, comp_kind: "cash",
    });
  });

  it("drops unknown enum values and returns null when the model produced no qualification at all", () => {
    expect(parseModelQualification({ category: "PAID" })).toBeNull();
    const q = parseModelQualification({ channel: "carrier pigeon", qualification: "amazing", work_kind: "dance" });
    expect(q).toBeNull();
    const q2 = parseModelQualification({ channel: "direct", qualification: "amazing", comp_kind: "vibes" });
    expect(q2?.qualification).toBeNull();
    expect(q2?.comp_kind).toBeNull();
  });

  it("never lets the model decide below_floor — it is read as 'terms stated'", () => {
    expect(parseModelQualification({ channel: "direct", qualification: "below_floor" })?.qualification).toBe("workable");
  });
});

describe("floor arithmetic is code, not the model", () => {
  it("cash-only under her own floor ⇒ below_floor, with the numbers recorded", () => {
    const q = enforce(model({ cash_amount: 150, comp_kind: "cash" }))!;
    expect(q.qualification).toBe("below_floor");
    expect(q.qualification_floor).toEqual({ kind: "social_post", cash: 150, units: 1, floor: 1000, source: "minimum_rate" });
    expect(q.qualification_reason).toContain("$150");
    expect(q.qualification_reason).toContain("$1,000");
  });

  it("cash-only at or above the floor ⇒ workable, even when the model said needs_terms", () => {
    expect(enforce(model({ cash_amount: 1000, comp_kind: "cash" }))!.qualification).toBe("workable");
    expect(enforce(model({ qualification: "needs_terms", cash_amount: 5000, comp_kind: "cash" }))!.qualification).toBe("workable");
  });

  it("multiplies the floor by the units the cash covers", () => {
    expect(enforce(model({ cash_amount: 2500, comp_kind: "cash", work_units: 3 }))!.qualification).toBe("below_floor");
    expect(enforce(model({ cash_amount: 3000, comp_kind: "cash", work_units: 3 }))!.qualification).toBe("workable");
  });

  it("never falls back to a computed rate when she set no floor for that kind of work (legacy retirement)", () => {
    const q = enforce(model({ work_kind: "appearance", cash_amount: 2000, comp_kind: "cash" }))!;
    expect(q.qualification).toBe("workable");
    expect(q.qualification_floor).toBeNull();
    expect(q.qualification_reason).toMatch(/no floor set/);
  });

  it("mixed cash + product is never 'below' by itself", () => {
    const q = enforce(model({ cash_amount: 100, comp_kind: "cash_and_product" }))!;
    expect(q.qualification).toBe("workable");
    expect(q.qualification_floor).toBeNull();
  });

  it("non-cash-only offers (product, commission) are workable, not below", () => {
    expect(enforce(model({ comp_kind: "product" }))!.qualification).toBe("workable");
    expect(enforce(model({ comp_kind: "commission" }))!.qualification).toBe("workable");
  });

  it("missing floor ⇒ never 'below' (no floor for the kind, no floors at all, placeholder rate)", () => {
    expect(enforce(model({ work_kind: "other", cash_amount: 10, comp_kind: "cash" }))!.qualification).toBe("workable");
    expect(enforce(model({ cash_amount: 10, comp_kind: "cash" }), { floors: null })!.qualification).toBe("workable");
    expect(enforce(model({ work_kind: "ambassador", cash_amount: 1, comp_kind: "cash" }))!.qualification).toBe("workable");
    expect(floorFor("ambassador", FLOORS)).toBeNull();
  });

  it("cash with no comp kind is treated as cash-only", () => {
    expect(enforce(model({ cash_amount: 150, comp_kind: null }))!.qualification).toBe("below_floor");
  });
});

describe("paid with no amount named ⇒ needs_terms, never workable (23 Oct)", () => {
  it("cash or cash plus product with no figure is needs_terms, whatever the model said", () => {
    for (const comp_kind of ["cash", "cash_and_product"] as const) {
      const q = enforce(model({ qualification: "workable", comp_kind, cash_amount: null }), { deliverables: ["1 integrated video"] })!;
      expect(q.qualification).toBe("needs_terms");
      expect(q.qualification_reason).toBe(UNSTATED_FEE_REASON);
      expect(q.qualification_floor).toBeNull();
    }
  });

  it("keeps the model's own sentence when it already said needs_terms", () => {
    const q = enforce(model({ qualification: "needs_terms", reason: "They ask for your rates.", comp_kind: "cash_and_product" }))!;
    expect(q).toMatchObject({ qualification: "needs_terms", qualification_reason: "They ask for your rates." });
  });

  it("a stated figure (cash, or cash plus product) is still terms; product or commission alone still workable", () => {
    expect(enforce(model({ comp_kind: "cash_and_product", cash_amount: 400 }))!.qualification).toBe("workable");
    expect(enforce(model({ comp_kind: "cash", cash_amount: 1200 }))!.qualification).toBe("workable");
    expect(enforce(model({ comp_kind: "product", cash_amount: null }))!.qualification).toBe("workable");
    expect(enforce(model({ comp_kind: "commission", cash_amount: null }))!.qualification).toBe("workable");
  });
});

describe("withoutUnstatedFee — a stored workable that names no amount reads as needs_terms", () => {
  const stored = (over: Partial<StoredQualification> = {}): StoredQualification => ({
    channel: "agency", qualification: "workable",
    qualification_reason: "Terms are stated (cash plus product); it isn't a cash-only offer, so it isn't measured against your floor.",
    qualification_version: QUALIFICATION_VERSION, qualification_message_id: "m1", qualification_floor: null, ...over,
  });

  it("cash plus product with no figure anywhere ⇒ needs_terms, channel and audit fields kept", () => {
    const q = withoutUnstatedFee(stored(), { statedCash: null, offerUnit: null })!;
    expect(q.qualification).toBe("needs_terms");
    expect(q.qualification_reason).toBe(UNSTATED_FEE_REASON);
    expect(q.channel).toBe("agency");
    expect(q.qualification_message_id).toBe("m1");
  });

  it("keeps workable when any cash figure is known, or the stored reason names one, or a floor check exists", () => {
    expect(withoutUnstatedFee(stored(), { statedCash: 500 })!.qualification).toBe("workable");
    expect(withoutUnstatedFee(stored(), { statedCash: "750.00" })!.qualification).toBe("workable");
    expect(withoutUnstatedFee(stored({ qualification_reason: "Terms are stated ($2,000 cash); there's no floor set for this kind of work yet." }))!.qualification).toBe("workable");
    expect(withoutUnstatedFee(stored({ qualification_floor: { kind: "social_post", cash: 900, units: 1, floor: 500, source: "minimum_rate" } }))!.qualification).toBe("workable");
  });

  it("keeps product-only and commission-only offers workable (complete terms without a fee)", () => {
    expect(withoutUnstatedFee(stored({ qualification_reason: "Terms are stated (product); it isn't a cash-only offer, so it isn't measured against your floor." }))!.qualification).toBe("workable");
    expect(withoutUnstatedFee(stored({ qualification_reason: "Terms are stated (commission); it isn't a cash-only offer, so it isn't measured against your floor." }))!.qualification).toBe("workable");
    expect(withoutUnstatedFee(stored(), { offerUnit: "gifting_only" })!.qualification).toBe("workable");
    expect(withoutUnstatedFee(stored(), { offerUnit: "commission_only" })!.qualification).toBe("workable");
  });

  it("leaves every other verdict alone", () => {
    for (const qualification of ["needs_terms", "below_floor", "verify_first", "not_relevant"] as const) {
      expect(withoutUnstatedFee(stored({ qualification }))!.qualification).toBe(qualification);
    }
    expect(withoutUnstatedFee(null)).toBeNull();
  });

  it("effectiveQualification reads a raw classification, using its offer_amount as a stated figure", () => {
    const cls = { qualification: "workable", channel: "agency", qualification_reason: stored().qualification_reason, offer_amount: null };
    expect(effectiveQualification(cls)).toBe("needs_terms");
    expect(effectiveQualification({ ...cls, offer_amount: 300 })).toBe("workable");
    expect(effectiveQualification(cls, { statedCash: 300 })).toBe("workable");
    expect(effectiveQualification({})).toBeNull();
  });
});

describe("missing money is never a penalty", () => {
  it("a real brand with no money and no deliverables ⇒ needs_terms, whatever the model guessed", () => {
    expect(enforce(model({ qualification: "needs_terms" }))!.qualification).toBe("needs_terms");
    expect(enforce(model({ qualification: "workable" }))!.qualification).toBe("needs_terms");
  });

  it("deliverables without compensation (or asking her quote) ⇒ still needs_terms — inquire before any rate", () => {
    expect(enforce(model({ qualification: "needs_terms" }), { deliverables: ["2 reels"] })!.qualification).toBe("needs_terms");
    expect(enforce(model({ qualification: "workable" }), { deliverables: ["2 reels"] })!.qualification).toBe("needs_terms");
  });
});

describe("verify_first only for an unverifiable sender claiming a recognisable brand", () => {
  it("unverifiable + recognisable claim ⇒ verify_first, even when the model called it not_relevant", () => {
    expect(enforce(model({ channel: "unverifiable", claims_known_brand: true, qualification: "workable" }))!.qualification).toBe("verify_first");
    expect(enforce(model({ channel: "unverifiable", claims_known_brand: true, qualification: "not_relevant" }))!.qualification).toBe("verify_first");
  });

  it("the model's verify_first without both conditions falls through to the terms rule", () => {
    expect(enforce(model({ channel: "unverifiable", claims_known_brand: false, qualification: "verify_first" }))!.qualification).toBe("needs_terms");
    expect(enforce(model({ channel: "direct", claims_known_brand: true, qualification: "verify_first" }))!.qualification).toBe("needs_terms");
  });

  it("agencies are judged separately: a legit agency for a known brand is a normal opportunity", () => {
    const q = enforce(model({ channel: "agency", claims_known_brand: true, qualification: "needs_terms" }), { from: "Ann <ann@agencyco.com>" })!;
    expect(q.qualification).toBe("needs_terms");
    expect(q.channel).toBe("agency");
  });
});

describe("contract / e-signature workflow mail is never filed or held", () => {
  it("an e-sign provider message is terms-based even if the model said not_relevant or claimed a brand", () => {
    const from = "Via Esign <dse@docusign.net>";
    expect(enforce(model({ qualification: "not_relevant" }), { from })!.qualification).toBe("needs_terms");
    expect(enforce(model({ channel: "unverifiable", claims_known_brand: true }), { from })!.qualification).toBe("needs_terms");
  });
});

describe("requests of her are never junk (owner, 7 Oct)", () => {
  it("an interview / press ask (MEDIA) or a school request is never not_relevant", () => {
    expect(enforce(model({ qualification: "not_relevant", comp_kind: "none" }), { category: "MEDIA" })!.qualification).toBe("needs_terms");
    expect(enforce(model({ qualification: "not_relevant", comp_kind: "none" }), { category: "SCHOOL_NIL" })!.qualification).toBe("needs_terms");
  });
  it("other categories can still be not_relevant", () => {
    expect(enforce(model({ qualification: "not_relevant" }), { category: "NOISE" })!.qualification).toBe("not_relevant");
  });
});

describe("stored shape", () => {
  it("carries the version and the message it came from", () => {
    const q = enforce(model({ qualification: "not_relevant", reason: "A newsletter." }))!;
    expect(q).toMatchObject({
      qualification: "not_relevant", qualification_reason: "A newsletter.",
      qualification_version: QUALIFICATION_VERSION, qualification_message_id: "m1", channel: "direct",
    });
  });

  it("no model output ⇒ no qualification", () => {
    expect(enforce(null)).toBeNull();
  });
});

describe("mergeQualification — re-qualified on every message", () => {
  const s = (qualification: StoredQualification["qualification"]): StoredQualification => ({
    channel: "direct", qualification, qualification_reason: qualification, qualification_version: QUALIFICATION_VERSION,
    qualification_message_id: null, qualification_floor: null,
  });

  it("needs_terms → workable / below_floor once terms appear", () => {
    expect(mergeQualification(s("needs_terms"), s("workable"), { followUp: true })?.qualification).toBe("workable");
    expect(mergeQualification(s("needs_terms"), s("below_floor"), { followUp: true })?.qualification).toBe("below_floor");
    expect(mergeQualification(s("below_floor"), s("workable"), { followUp: true })?.qualification).toBe("workable");
  });

  it("a later message without terms does not erase terms already stated", () => {
    expect(mergeQualification(s("workable"), s("needs_terms"), { followUp: true })?.qualification).toBe("workable");
  });

  it("a follow-up is never re-judged as junk or verify-first", () => {
    expect(mergeQualification(s("needs_terms"), s("not_relevant"), { followUp: true })?.qualification).toBe("needs_terms");
    expect(mergeQualification(null, s("not_relevant"), { followUp: true })).toBeNull();
    expect(mergeQualification(s("workable"), s("verify_first"), { followUp: true })?.qualification).toBe("workable");
  });

  it("first touch takes the new verdict; nothing new keeps the stored one", () => {
    expect(mergeQualification(null, s("not_relevant"), { followUp: false })?.qualification).toBe("not_relevant");
    expect(mergeQualification(s("workable"), null, { followUp: true })?.qualification).toBe("workable");
  });
});

describe("internal test senders — config only", () => {
  const LIST = " Dev@Team.example , @internal.example ";

  it("parses addresses and domains from the comma-separated list", () => {
    const s = internalTestSenders(LIST);
    expect([...s.addresses]).toEqual(["dev@team.example"]);
    expect([...s.domains]).toEqual(["internal.example"]);
  });

  it("matches an exact address, a domain and its subdomains — nothing else", () => {
    expect(isInternalSender("Dev <DEV@team.example>", LIST)).toBe(true);
    expect(isInternalSender("other@team.example", LIST)).toBe(false);
    expect(isInternalSender("a@internal.example", LIST)).toBe(true);
    expect(isInternalSender("a@mail.internal.example", LIST)).toBe(true);
    expect(isInternalSender("a@notinternal.example", LIST)).toBe(false);
  });

  it("an empty or unset list never treats anyone as internal", () => {
    expect(isInternalSender("a@internal.example", "")).toBe(false);
    const prev = process.env.INTERNAL_TEST_SENDERS;
    delete process.env.INTERNAL_TEST_SENDERS;
    expect(isInternalSender("a@internal.example")).toBe(false);
    expect(internalSenderQualification("a@internal.example", "m1")).toBeNull();
    if (prev !== undefined) process.env.INTERNAL_TEST_SENDERS = prev;
  });

  it("possibleTestMessage notes an obvious 'test' marker", () => {
    expect(possibleTestMessage({ from: "a@internal.example", subject: "Test deal" }, LIST)).toBe('internal sender + "test" in subject/body');
    expect(possibleTestMessage({ from: "a@internal.example", subject: "Partnership", body: "hello" }, LIST)).toBe("internal sender");
    expect(possibleTestMessage({ from: "brand@brandco.com", subject: "Test drive our app" }, LIST)).toBeNull();
  });
});

describe("intake action + flag", () => {
  it("maps states to what the flag does", () => {
    const base = { channel: "direct" as const, qualification_reason: "", qualification_version: "", qualification_message_id: null, qualification_floor: null };
    expect(intakeActionFor({ ...base, qualification: "not_relevant" })).toBe("file");
    expect(intakeActionFor({ ...base, qualification: "verify_first" })).toBe("mint_marked");
    expect(intakeActionFor({ ...base, qualification: "needs_terms" })).toBe("mint");
    expect(intakeActionFor({ ...base, qualification: "below_floor" })).toBe("mint");
    expect(intakeActionFor({ ...base, qualification: "workable" })).toBe("mint");
    expect(intakeActionFor(null)).toBe("mint");
  });

  it("e-sign mail is never labelled an unverifiable channel", () => {
    const q = enforce(model({ channel: "unverifiable", claims_known_brand: true, qualification: "needs_terms" }), { from: "Adobe Sign <echosign@adobesign.com>" })!;
    expect(q.channel).toBe("direct");
    expect(q.qualification).toBe("needs_terms");
  });
});

describe("withoutRetiredFloor (legacy retirement, phase 1)", () => {
  const stored = (over: Partial<StoredQualification> = {}): StoredQualification => ({
    channel: "direct",
    qualification: "below_floor",
    qualification_reason: "The cash offered ($300 for 1 social post) is under your floor for this kind of work ($876 each).",
    qualification_version: QUALIFICATION_VERSION,
    qualification_message_id: null,
    qualification_floor: { kind: "social_post", cash: 300, units: 1, floor: 876, source: "rate_card_mid" },
    ...over,
  });

  it("a floor that was the computed rate-card mid reads as workable, no floor set — never the computed number", () => {
    const q = withoutRetiredFloor(stored())!;
    expect(q.qualification).toBe("workable");
    expect(q.qualification_floor).toBeNull();
    expect(q.qualification_reason).toBe("Terms are stated ($300 cash); there's no floor set for this kind of work yet.");
    expect(q.qualification_reason).not.toContain("876");
  });

  it("her own floor is kept exactly as stored", () => {
    const own = stored({ qualification_floor: { kind: "social_post", cash: 300, units: 1, floor: 500, source: "minimum_rate" } });
    expect(withoutRetiredFloor(own)).toBe(own);
    expect(withoutRetiredFloor(null)).toBeNull();
  });
});
