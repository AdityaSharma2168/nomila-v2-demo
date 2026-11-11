/**
 * shared/deals.ts — the one deal vocabulary. Pure functions only; no DB, no providers.
 */
import {
  DEAL_TYPES, DELIVERABLES, INTENTS_BY_TYPE, RATE_TYPES, REPLY_INTENTS, ACCEPT_INTENTS, FIGURE_INTENTS,
  DELIVERABLE_UNIT, DELIVERABLE_RATE_TYPE, LEGACY_FLOOR_KEY, TERMS_BY_TYPE, TERM_KEYS,
  dealTypeOf, floorKeyOf, readFloor, parseTermSheet, intentAllowed, unknownTerms,
} from "../../shared/deals";

describe("dealTypeOf", () => {
  it("types each classifier shape", () => {
    const cases: Array<[Parameters<typeof dealTypeOf>[0], string]> = [
      [{ category: "PAID", workKind: "social_post", compKind: "cash", cashAmount: 1200 }, "paid_content"],
      [{ category: "PAID", workKind: "social_post", compKind: "none" }, "paid_no_fee"],
      [{ category: "PAID", qualification: "needs_terms" }, "paid_no_fee"],
      [{ category: "PAID", compKind: "commission" }, "affiliate"],
      [{ category: "PAID", workKind: "ambassador", compKind: "cash", cashAmount: 6000 }, "ambassador"],
      [{ category: "PAID", workKind: "licensing" }, "licensing"],
      [{ category: "PAID", workKind: "autograph" }, "licensing"],
      [{ category: "PAID", workKind: "appearance", cashAmount: 800 }, "appearance"],
      [{ category: "PAID", compKind: "product" }, "gift"],
      [{ category: "GIFTING" }, "gift"],
      [{ category: "EDITORIAL" }, "product_review"],
      [{ category: "MEDIA", mediaKind: "interview" }, "press"],
      [{ category: "MEDIA", mediaKind: "cover" }, "press"],
      [{ category: "MEDIA", mediaKind: "podcast" }, "podcast"],
      [{ category: "MEDIA", workKind: "appearance", compKind: "cash", cashAmount: 500 }, "appearance"],
      [{ category: "SCHOOL_NIL" }, "school_compliance"],
      [{ category: "SCHOOL_NIL", compKind: "cash", cashAmount: 2000 }, "collective"],
      [{ category: "PAID", qualification: "verify_first", cashAmount: 5000 }, "verify"],
      [{ category: "PAID", paperwork: true }, "paperwork"],
      [{ dealTypeColumn: "social_post" }, "paid_content"],
      [{ dealTypeColumn: "appearance" }, "appearance"],
      [{ dealTypeColumn: "ambassador" }, "ambassador"],
      [{}, "paid_content"],
    ];
    for (const [input, want] of cases) expect([input, dealTypeOf(input)]).toEqual([input, want]);
  });

  it("review edge cases (12 Oct): school work, a later cash figure, case, paid media, commission vs ambassador", () => {
    // A SCHOOL_NIL thread the classifier read as work (the .edu fast path sets no work_kind) is a collective deal.
    expect(dealTypeOf({ category: "SCHOOL_NIL", workKind: "social_post" })).toBe("collective");
    expect(dealTypeOf({ category: "SCHOOL_NIL" })).toBe("school_compliance");
    // needs_terms from an earlier message, then a cash figure: the cash wins.
    expect(dealTypeOf({ category: "PAID", qualification: "needs_terms", cashAmount: 900 })).toBe("paid_content");
    // Paid with no amount named (23 Oct): still "no fee yet" — ask for terms, never accept or counter with nothing stated.
    expect(dealTypeOf({ category: "PAID", qualification: "needs_terms", compKind: "cash" })).toBe("paid_no_fee");
    expect(dealTypeOf({ category: "PAID", qualification: "needs_terms", compKind: "cash_and_product" })).toBe("paid_no_fee");
    expect(dealTypeOf({ category: "PAID", qualification: "needs_terms", compKind: "cash_and_product", cashAmount: 500 })).toBe("paid_content");
    // Case.
    expect(dealTypeOf({ category: "MEDIA", mediaKind: "Podcast" })).toBe("podcast");
    expect(dealTypeOf({ category: "PAID", workKind: "Ambassador", compKind: "CASH", cashAmount: 1 })).toBe("ambassador");
    // A paid podcast (the outlet pays) is a paid appearance: her minimum and a counter apply.
    expect(dealTypeOf({ category: "MEDIA", mediaKind: "podcast", compKind: "cash", cashAmount: 500 })).toBe("appearance");
    // Commission-only is an affiliate programme even when it calls itself ambassador; with cash it is ambassador.
    expect(dealTypeOf({ category: "PAID", workKind: "ambassador", compKind: "commission" })).toBe("affiliate");
    expect(dealTypeOf({ category: "PAID", workKind: "ambassador", compKind: "commission", cashAmount: 1000 })).toBe("ambassador");
  });

  it("FAN, NOISE and unknown categories are not deals: null, never paid content", () => {
    for (const category of ["FAN", "NOISE", "fan", "WHATEVER"]) expect(dealTypeOf({ category, cashAmount: 500 })).toBeNull();
    expect(dealTypeOf({ category: "FAN", paperwork: true })).toBe("paperwork");
  });

  it("is case-insensitive on category and total", () => {
    expect(dealTypeOf({ category: "gifting" })).toBe("gift");
    for (const t of DEAL_TYPES) expect(typeof t).toBe("string");
  });
});

describe("INTENTS_BY_TYPE", () => {
  it("covers every type, with intents from the closed enum", () => {
    for (const t of DEAL_TYPES) {
      for (const i of INTENTS_BY_TYPE[t]) expect(REPLY_INTENTS).toContain(i);
    }
    expect(INTENTS_BY_TYPE.collective).toEqual(INTENTS_BY_TYPE.paid_content);
    expect(INTENTS_BY_TYPE.paperwork).toEqual([]);
  });

  it("never offers a counter or terms ask to press, and never a money counter on a gift", () => {
    expect(INTENTS_BY_TYPE.press).not.toContain("counter");
    expect(INTENTS_BY_TYPE.press).not.toContain("ask_terms");
    expect(INTENTS_BY_TYPE.gift).not.toContain("counter");
    expect(intentAllowed("press", "counter")).toBe(false);
    expect(intentAllowed("paid_content", "counter")).toBe(true);
  });

  it("accept and figure intents are real intents", () => {
    for (const i of [...ACCEPT_INTENTS, ...FIGURE_INTENTS]) expect(REPLY_INTENTS).toContain(i);
  });
});

describe("deliverables and rate types", () => {
  it("every deliverable has a unit and a (possibly null) rate type from RATE_TYPES", () => {
    for (const d of DELIVERABLES) {
      expect(DELIVERABLE_UNIT[d]).toBeTruthy();
      const rt = DELIVERABLE_RATE_TYPE[d];
      if (rt !== null) expect(RATE_TYPES).toContain(rt);
    }
    for (const r of RATE_TYPES) expect(r in LEGACY_FLOOR_KEY).toBe(true);
  });
});

describe("floorKeyOf — one floor key from the kind of work", () => {
  it("an appearance is floored on the appearance rate, not per-post", () => {
    expect(floorKeyOf({ dealType: "appearance" })).toBe("appearance_in_person_hour");
    expect(floorKeyOf({ dealType: "paid_content", workKind: "appearance" })).toBe("appearance_in_person_hour");
  });

  it("deliverables decide before work_kind", () => {
    expect(floorKeyOf({ dealType: "paid_content", workKind: "social_post", deliverables: [{ kind: "tiktok_video" }] })).toBe("tiktok_video");
    expect(floorKeyOf({ dealType: "paid_content", deliverables: [{ kind: "ig_live" }, { kind: "ig_reel" }] })).toBe("ig_reel");
  });

  it("a deliverable refines the key only within the deal's own family of work", () => {
    // An ambassador deal listing posts is floored on her ambassador minimum, never per-post.
    expect(floorKeyOf({ dealType: "ambassador", workKind: "ambassador", deliverables: [{ kind: "ig_post" }, { kind: "ig_reel" }] })).toBe("ambassador_month");
    // An appearance that also asks for a story stays on the appearance key; a virtual one refines it.
    expect(floorKeyOf({ dealType: "appearance", deliverables: [{ kind: "ig_story" }] })).toBe("appearance_in_person_hour");
    expect(floorKeyOf({ dealType: "appearance", deliverables: [{ kind: "ig_story" }, { kind: "virtual_appearance" }] })).toBe("appearance_virtual");
    // Licensing listing a post is still licensing.
    expect(floorKeyOf({ dealType: "licensing", deliverables: [{ kind: "ig_post" }] })).toBe("licensing");
    // No base at all: the first deliverable with a rate type decides.
    expect(floorKeyOf({ deliverables: [{ kind: "interview" }, { kind: "yt_short" }] })).toBe("yt_short");
  });

  it("press, gifts, school and affiliate are never floored", () => {
    for (const t of ["press", "podcast", "gift", "product_review", "school_compliance", "verify", "paperwork", "affiliate"] as const) {
      expect(floorKeyOf({ dealType: t, workKind: "appearance", deliverables: [{ kind: "ig_reel" }] })).toBeNull();
    }
  });

  it("falls back to the deal type, then null", () => {
    expect(floorKeyOf({ dealType: "ambassador" })).toBe("ambassador_month");
    expect(floorKeyOf({ dealType: "paid_content" })).toBe("ig_post");
    expect(floorKeyOf({})).toBeNull();
  });
});

describe("readFloor", () => {
  it("reads the rate-type key first, then the legacy key; never zero", () => {
    expect(readFloor({ appearance: 1500, socialPost: 400 }, "appearance_in_person_hour")).toBe(1500);
    expect(readFloor({ appearance_in_person_hour: 300, appearance: 1500 }, "appearance_in_person_hour")).toBe(300);
    expect(readFloor({ socialPost: "$835" }, "ig_reel")).toBe(835);
    expect(readFloor({ socialPost: 0 }, "ig_post")).toBeNull();
    expect(readFloor({ socialPost: 400 }, null)).toBeNull();
    expect(readFloor(null, "ig_post")).toBeNull();
    expect(readFloor({ socialPost: 400 }, "booking_video_call_30")).toBeNull();
    expect(readFloor({ booking_clinic: 90 }, "booking_clinic")).toBeNull();
    // Same fallback as services/rates.ts minimumFor: a camp or a talk never reads the per-appearance key.
    expect(readFloor({ appearance: 1500 }, "camp_clinic")).toBeNull();
    expect(readFloor({ appearance: 1500 }, "speaking")).toBeNull();
    expect(readFloor({ camp_clinic: 900, appearance: 1500 }, "camp_clinic")).toBe(900);
  });
});

describe("parseTermSheet", () => {
  it("keeps valid fields, drops invented or malformed ones, and computes unknown by type", () => {
    const sheet = parseTermSheet({
      fee: { amount: "$1,200", unit: "flat", currency: "usd" },
      deliverables: [{ kind: "ig_reel", count: 3 }, { kind: "made_up", count: 1 }, { kind: "tiktok_video", count: "2" }],
      usage: { paid: true, months: 12 },
      exclusivity: {},
      approvalRounds: "two",
      killFee: 0,
      commission: { pct: 250 },
      giftPostingRequired: "yes",
    }, "paid_content");
    expect(sheet.fee).toEqual({ amount: 1200, unit: "flat", currency: "USD" });
    expect(sheet.deliverables).toEqual([{ kind: "ig_reel", count: 3 }, { kind: "tiktok_video", count: 2 }]);
    expect(sheet.usage).toEqual({ paid: true, months: 12 });
    expect(sheet.exclusivity).toBeUndefined();
    expect(sheet.approvalRounds).toBeUndefined();
    expect(sheet.killFee).toBeUndefined();
    expect(sheet.commission).toBeUndefined();
    expect(sheet.giftPostingRequired).toBeUndefined();
    expect(sheet.unknown).toEqual(["whitelisting", "exclusivity", "approvalRounds", "payment"]);
  });

  it("never throws on junk and lists every relevant term as unknown", () => {
    expect(parseTermSheet(null, "press")).toEqual({ unknown: ["deliverables"] });
    expect(parseTermSheet("nope").unknown).toEqual([...TERM_KEYS]);
    expect(parseTermSheet(undefined, "verify").unknown).toEqual([]);
  });

  it("TERMS_BY_TYPE never asks a journalist for a fee", () => {
    expect(TERMS_BY_TYPE.press).not.toContain("fee");
    expect(unknownTerms({ fee: { amount: 1 } }, "press")).toEqual(["deliverables"]);
  });
});
