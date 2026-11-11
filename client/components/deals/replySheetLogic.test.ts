import { draftRequest, legacyIntentOf, parseMoney, rowsShownFor, splitRows, teamMember, termRowsFor, theirTerm } from "./replySheetLogic";
import type { TermSheet } from "../../../shared/deals";

const sheet: TermSheet = {
  fee: { amount: 1400, unit: "flat" },
  deliverables: [{ kind: "ig_reel", count: 2 }],
  usage: { paid: true, months: 12 },
  unknown: ["approvalRounds"],
};

describe("termRowsFor — their term → your ask", () => {
  it("a counter shows the type's terms with what they stated, else Not stated", () => {
    const rows = termRowsFor("counter", "paid_content", sheet);
    expect(rows.map((r) => r.term)).toEqual(["fee", "deliverables", "usage", "whitelisting", "exclusivity", "approvalRounds", "payment"]);
    expect(rows[0]).toMatchObject({ label: "Fee", theirs: "$1,400", numeric: true });
    expect(rows[1].theirs).toBe("2 × Instagram Reel");
    expect(rows[2].theirs).toBe("Paid usage · 12 months");
    expect(rows[5].theirs).toBe("Not stated");
  });

  it("a one-figure reply shows only the fee; every other reply none", () => {
    expect(termRowsFor("share_rate", "paid_no_fee", sheet).map((r) => r.term)).toEqual(["fee"]);
    expect(termRowsFor("accept_terms", "paid_content", sheet)).toEqual([]);
    expect(termRowsFor("ask_questions", "press", sheet)).toEqual([]);
    expect(rowsShownFor("propose_paid")).toBe("fee");
  });

  it("an appearance counters fee, logistics, payment and kill fee", () => {
    expect(termRowsFor("counter", "appearance", { logistics: { hours: 3, travelCovered: false }, unknown: [] }).map((r) => [r.term, r.theirs])).toEqual([
      ["fee", "Not stated"], ["logistics", "3 hours · no travel"], ["payment", "Not stated"], ["killFee", "Not stated"],
    ]);
  });

  it("commission and product-only fees read in words", () => {
    expect(theirTerm("fee", { fee: { unit: "commission_only" }, unknown: [] })).toBe("Commission only");
    expect(theirTerm("fee", { fee: { amount: 1000, unit: "monthly" }, unknown: [] })).toBe("$1,000 a month");
    expect(theirTerm("commission", { commission: { pct: 10, code: "MIA10" }, unknown: [] })).toBe("10% · code MIA10");
    expect(theirTerm("fee", null)).toBeNull();
  });
});

describe("parseMoney", () => {
  it("reads her typed figure and nothing else", () => {
    expect(parseMoney("$1,800")).toBe(1800);
    expect(parseMoney("1.8k")).toBe(1800);
    expect(parseMoney("2000")).toBe(2000);
    expect(parseMoney("about 2k")).toBeNull();
    expect(parseMoney("0")).toBeNull();
    expect(parseMoney("")).toBeNull();
  });
});

describe("draftRequest", () => {
  const rows = termRowsFor("counter", "paid_content", sheet);

  it("her rows become term asks; the fee she typed is the ONE figure", () => {
    const r = draftRequest({ intent: "counter", asks: { fee: "$1,800", usage: "3 months", payment: "  " }, rows, asTeam: false });
    expect(r).toMatchObject({ reply_intent: "negotiate", intent: "counter", voice: "athlete", figure: 1800, custom_instruction: "Counter at $1,800" });
    expect(r.term_asks).toEqual([{ term: "usage", ask: "3 months" }]);
    expect(r.selected_terms).toEqual(["Usage rights: 3 months"]);
  });

  it("an intent that may state no figure carries none, whatever was typed", () => {
    const r = draftRequest({ intent: "ask_question", asks: { fee: "1800" }, rows: termRowsFor("counter", "paid_content", sheet), asTeam: false });
    expect(r.figure).toBeUndefined();
    expect(r.custom_instruction).toBeUndefined();
  });

  it("signs as her team only when asked", () => {
    expect(draftRequest({ intent: "accept_terms", asks: {}, rows: [], asTeam: true }).voice).toBe("agent");
  });
});

describe("legacyIntentOf", () => {
  it("maps the type's intents onto the route's four", () => {
    expect(legacyIntentOf("accept_and_propose_times")).toBe("accept");
    expect(legacyIntentOf("acknowledge")).toBe("accept");
    expect(legacyIntentOf("counter")).toBe("negotiate");
    expect(legacyIntentOf("share_rate")).toBe("negotiate");
    expect(legacyIntentOf("ask_questions_in_advance")).toBe("request_terms");
    expect(legacyIntentOf("decline")).toBe("decline");
  });
});

describe("teamMember (D2)", () => {
  it("only a named person — never an invented agency", () => {
    expect(teamMember({ agent_name: "  ", agent_role: "Manager" })).toBeNull();
    expect(teamMember(null)).toBeNull();
    expect(teamMember({ agent_name: "Alex Chen", agent_role: "Manager" })).toEqual({ name: "Alex Chen", role: "Manager" });
    expect(teamMember({ agent_name: "Alex Chen" })).toEqual({ name: "Alex Chen", role: null });
  });
});

describe("splitRows", () => {
  it("raises the fee and what they stated, up to three rows; the rest wait", () => {
    const { shown, more } = splitRows(termRowsFor("counter", "paid_content", sheet));
    expect(shown.map((r) => r.term)).toEqual(["fee", "deliverables", "usage"]);
    expect(more.map((r) => r.term)).toEqual(["whitelisting", "exclusivity", "approvalRounds", "payment"]);
    expect(splitRows(termRowsFor("counter", "appearance", { unknown: [] })).shown.map((r) => r.term)).toEqual(["fee", "logistics", "payment"]);
  });
});
