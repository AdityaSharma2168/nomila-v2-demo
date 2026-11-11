import { cardReplyIntent, closedLine, intentLabel, letterActions, readRows } from "./dealLetterLogic";
import { INTENTS_BY_TYPE, REPLY_INTENT_LABEL, type DealRead, type DealType } from "../../../shared/deals";

const actionsOf = (t: DealType) => INTENTS_BY_TYPE[t].map((intent) => ({ intent, label: REPLY_INTENT_LABEL[intent] }));
const brand = (is_person = false) => ({ brand: { id: 1, name: "X", logo_url: null, category: null, tier: null, research_confirmed: false, image_url: null, safe_logo_url: null, is_person } });

describe("readRows — the four-line read", () => {
  const read: DealRead = {
    money: { line: "About $700 a Reel: above your minimum.", state: "above_min", source: "Their email, 10 Oct" },
    fit: { line: "Training content is their core audience.", source: "Nomila’s research · confirmed brand" },
    risk: { line: "Nothing to flag.", flags: [], source: "Checked against your partners" },
    goal: { line: "Helps “bigger brand partners”.", source: "Your goals" },
  };

  it("keeps the order and each row's own source", () => {
    const rows = readRows(read, brand());
    expect(rows.map((r) => r.label)).toEqual(["Money", "Fit", "Risk", "Goal"]);
    expect(rows[0]).toMatchObject({ line: read.money.line, source: "Their email, 10 Oct", flagged: false });
  });

  it("an unconfirmed brand: Fit waits and says why — a person is named as a person", () => {
    expect(readRows({ ...read, fit: null }, brand(true))[1]).toMatchObject({ line: "Can’t judge yet: a person, not a confirmed brand.", source: "Nomila’s research · no brand found" });
    expect(readRows({ ...read, fit: null }, brand(false))[1].line).toBe("Can’t judge yet: Nomila hasn’t confirmed this brand.");
  });

  it("no goal match is said plainly; a risk flag is the one flagged row", () => {
    const rows = readRows({ ...read, goal: null, risk: { line: "Couldn’t confirm who this is.", flags: ["unverified_identity"], source: "Identity check" } }, brand());
    expect(rows[3]).toMatchObject({ line: "Doesn’t connect to a goal you’ve set", source: "Your goals" });
    expect(rows.filter((r) => r.flagged).map((r) => r.key)).toEqual(["risk"]);
  });
});

describe("letterActions — the actions of the deal's type", () => {
  it("an interview: Accept and suggest times, then Ask questions first, Not for me (the Harrison Szep letter)", () => {
    const a = letterActions({ actions: actionsOf("press"), next: { action: "reply", label: "Reply", why: "", due: null, hers: true } });
    expect(a.primary?.label).toBe("Accept and suggest times");
    expect(a.secondary).toBeNull();
    expect(a.link?.label).toBe("Ask questions first");
    expect(a.notForMe).toBe(true);
  });

  it("a paid deal: Reply leads (opening on Accept terms), Counter is the outlined second", () => {
    const a = letterActions({ actions: actionsOf("paid_content"), next: { action: "reply", label: "Reply", why: "", due: null, hers: true } });
    expect(a.primary).toEqual({ intent: "accept_terms", label: "Reply" });
    expect(a.secondary?.intent).toBe("counter");
    expect(a.link).toBeNull();
  });

  it("below her minimum the server points at the counter: Counter leads, Reply steps down", () => {
    const a = letterActions({ actions: actionsOf("paid_content"), next: { action: "counter", label: "Counter", why: "", due: null, hers: true } });
    expect(a.primary?.intent).toBe("counter");
    expect(a.secondary).toEqual({ intent: "accept_terms", label: "Reply" });
  });

  it("terms in: one Accept or counter button that opens the sheet on accepting (counter is in the sheet)", () => {
    const item = { actions: actionsOf("paid_content"), next: { action: "accept_or_counter" as const, label: "Accept or counter", why: "", due: null, hers: true }, lead_deal_id: "d1" };
    expect(letterActions(item).primary).toEqual({ intent: "accept_terms", label: "Accept or counter" });
    expect(letterActions(item).secondary).toBeNull();
    expect(cardReplyIntent(item)).toBe("accept_terms");
  });

  it("no fee yet: Ask for terms leads, Share my rate is the link", () => {
    const a = letterActions({ actions: actionsOf("paid_no_fee"), next: { action: "ask_for_terms", label: "Ask for terms", why: "", due: null, hers: true } });
    expect(a.primary?.intent).toBe("ask_terms");
    expect(a.link?.intent).toBe("share_rate");
  });

  it("verify first: Ask who they are", () => {
    expect(letterActions({ actions: actionsOf("verify"), next: { action: "verify", label: "Verify", why: "", due: null, hers: true } }).primary?.intent).toBe("ask_who_they_are");
  });

  it("decline is never a reply button here, and paperwork offers none", () => {
    const all = letterActions({ actions: actionsOf("gift") });
    expect([all.primary, all.secondary, all.link].map((x) => x?.intent)).not.toContain("decline");
    expect(letterActions({ actions: actionsOf("paperwork") })).toEqual({ primary: null, secondary: null, link: null, notForMe: false });
    expect(letterActions({}).primary).toBeNull();
  });

  it("labels come from the server first", () => {
    expect(intentLabel("counter", { actions: [{ intent: "counter", label: "Counter the fee" }] })).toBe("Counter the fee");
    expect(intentLabel("counter")).toBe("Counter");
  });
});

describe("cardReplyIntent — the board card's Reply opens the sheet in one tap", () => {
  const next = (action: "reply" | "counter" | "ask_for_terms" | "verify" | "confirm_signed") => ({ action, label: "x", why: "", due: null, hers: true });

  it("a reply step opens on the deal's suggested answer; a counter step on Counter; no fee yet on Ask for terms", () => {
    expect(cardReplyIntent({ lead_deal_id: "d1", actions: actionsOf("paid_content"), next: next("reply") })).toBe("accept_terms");
    expect(cardReplyIntent({ lead_deal_id: "d1", actions: actionsOf("paid_content"), next: next("counter") })).toBe("counter");
    expect(cardReplyIntent({ lead_deal_id: "d1", actions: actionsOf("paid_no_fee"), next: next("ask_for_terms") })).toBe("ask_terms");
    expect(cardReplyIntent({ lead_deal_id: "d1", actions: actionsOf("press"), next: next("reply") })).toBe("accept_and_propose_times");
  });

  it("not a reply (confirm signed, verify), no deal, no answers or an older server: null — the card opens the detail", () => {
    expect(cardReplyIntent({ lead_deal_id: "d1", actions: actionsOf("paid_content"), next: next("confirm_signed") })).toBeNull();
    expect(cardReplyIntent({ lead_deal_id: "d1", actions: actionsOf("verify"), next: next("verify") })).toBeNull();
    expect(cardReplyIntent({ lead_deal_id: null, actions: actionsOf("paid_content"), next: next("reply") })).toBeNull();
    expect(cardReplyIntent({ lead_deal_id: "d1", actions: actionsOf("paperwork"), next: next("reply") })).toBeNull();
    expect(cardReplyIntent({ lead_deal_id: "d1", actions: actionsOf("paid_content") })).toBeNull();
  });
});

describe("closedLine", () => {
  it("says why and when, in her words", () => {
    expect(closedLine({ reason: "declined", at: "2026-10-12T15:00:00Z" })).toBe("Declined · Oct 12, 2026");
    expect(closedLine({ reason: "not_relevant", at: null })).toBe("Not a deal");
    expect(closedLine({ reason: "won", at: "2026-03-02T00:00:00Z" })).toBe("Done · Mar 2, 2026");
    expect(closedLine(null)).toBe("Closed");
  });
});
