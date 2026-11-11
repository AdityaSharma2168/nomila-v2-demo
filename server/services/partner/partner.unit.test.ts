/**
 * partner.unit.test.ts — the Partner door's pure parts.
 *
 *   U1 kinds map onto the EXISTING vocabularies only (DealCategory, deals_type_check, MEDIA_KINDS); press is MEDIA
 *   U2 the fit output gate: cited sources only, no money, no contact, no promises, at most 3, de-duplicated
 *   U3 pre-qualified markers: timing end, budget against HER minimum only (never the retired rate card)
 *   U4 tokens: derived tokens are stable per (purpose, id, nonce) and differ across them; the visitor-check cookie
 *      verifies only unaltered and unexpired; seals bind their value
 *   U5 emails: every template renders through the shared helper, escaped, content-free, never says "brief"
 */
// Pure functions only: a stub db (not PGlite, whose WASM boot would outlive this suite and break the next one in the process).
jest.mock("../../db", () => ({ db: {}, pool: { end: async () => {}, on: () => {} } }));
import { DEAL_CATEGORIES, MEDIA_KINDS } from "../../skills/dealDetector";
import { KIND_MAP, PRESS_FORMAT_MEDIA_KIND, PARTNER_REQUEST_KINDS } from "./kinds";
import { gateFitLines } from "./fit";
import { budgetMarker, timingEnd } from "./prequal";
import { deriveToken, readVisitorCheck, seal, sealValid, signVisitorCheck, emailHash } from "./tokens";
import { renderTemplate } from "../notify/templates/render";
import { PARTNER_TEMPLATES, usd } from "../notify/templates/partner";
import type { PublishedCardFacts } from "./publishedCard";

const card: PublishedCardFacts = { athleteId: "a", handle: "h", firstName: "Avery", version: 1, partnerOpen: true,
  chapters: [{ id: "story", title: "Story", text: "x" }, { id: "media", title: "Media", text: "y" }] };

describe("U1 kinds", () => {
  it("every kind maps to an existing DealCategory and deal_type; press is MEDIA with a real media_kind", () => {
    const dealTypes = ["social_post", "appearance", "ambassador", "autograph", "licensing", "other"];
    for (const k of PARTNER_REQUEST_KINDS) {
      expect(DEAL_CATEGORIES.has(KIND_MAP[k].category)).toBe(true);
      expect(dealTypes).toContain(KIND_MAP[k].dealType);
    }
    expect(KIND_MAP.press).toMatchObject({ category: "MEDIA", press: true });
    expect(PARTNER_REQUEST_KINDS.filter((k) => KIND_MAP[k].press)).toEqual(["press"]);
    for (const m of Object.values(PRESS_FORMAT_MEDIA_KIND)) expect(MEDIA_KINDS as readonly string[]).toContain(m);
    // the chips, word for word
    expect(PARTNER_REQUEST_KINDS.map((k) => KIND_MAP[k].label)).toEqual([
      "Sponsorship or ambassador", "Social posts or content", "Endorsement or product collab", "Appearance or event",
      "Interview, podcast or editorial", "Something else",
    ]);
  });
});

describe("U2 the fit gate", () => {
  it("keeps only cited, short, clean lines", () => {
    const out = gateFitLines({ lines: [
      { text: "Fits the morning-routine theme.", source: "story" },
      { text: "Fits the morning-routine theme.", source: "story" },          // duplicate
      { text: "Priced at 2k per post.", source: "media" },                    // money
      { text: "Call 415 555 0134.", source: "site" },                         // contact
      { text: "Avery will say yes, guaranteed.", source: "site" },            // promise
      { text: "No source.", source: "" },
      { text: "A".repeat(201), source: "site" },                              // too long
      { text: "Their site talks about recovery.", source: "site" },
      { text: "Matches the media chapter.", source: "[media]" },               // bracketed id is accepted
      { text: "One too many.", source: "story" },
    ] }, card, "site");
    expect(out).toEqual([
      { text: "Fits the morning-routine theme.", source: "story" },
      { text: "Their site talks about recovery.", source: "site" },
      { text: "Matches the media chapter.", source: "media" },
    ]);
    expect(gateFitLines({ lines: [{ text: "From the site.", source: "site" }] }, card, "told")).toEqual([]);
    expect(gateFitLines("nonsense", card, "site")).toEqual([]);
  });
});

describe("U3 markers", () => {
  it("timing end: a month ends on its last day; a range on its end; flexible is open", () => {
    expect(timingEnd({ type: "commercial", goal: null, idea: "x", timing: { kind: "month", month: "2026-02" }, budget: "not_sure", agency: false, client_brand: null })).toBe("2026-02-28");
    expect(timingEnd({ type: "commercial", goal: null, idea: "x", timing: { kind: "range", from: "2026-01-01", to: "2026-03-05" }, budget: "not_sure", agency: false, client_brand: null })).toBe("2026-03-05");
    expect(timingEnd({ type: "commercial", goal: null, idea: "x", timing: { kind: "flexible" }, budget: "not_sure", agency: false, client_brand: null })).toBeNull();
    expect(timingEnd({ type: "press", topic: "t", format: "podcast", deadline: "2026-04-01" })).toBe("2026-04-01");
  });
  it("budget against her own minimum only", () => {
    const b = (budget: any) => ({ type: "commercial" as const, goal: null, idea: "x", timing: { kind: "flexible" as const }, budget, agency: false, client_brand: null });
    const floors = { minimumRates: { socialPost: 4_000 } };
    expect(budgetMarker(b("5k_15k"), "content", floors)).toBe("at_or_above");
    expect(budgetMarker(b("1k_5k"), "content", floors)).toBe("spans");
    expect(budgetMarker(b("under_1k"), "content", floors)).toBe("below");
    expect(budgetMarker(b("not_sure"), "content", floors)).toBe("not_stated");
    // no minimum of her own → no marker (the computed rate card is retired)
    expect(budgetMarker(b("under_1k"), "content", { minimumRates: {} })).toBe("no_minimum");
    expect(budgetMarker({ type: "press", topic: "t", format: "podcast", deadline: null }, "press", floors)).toBeNull();
  });
});

describe("U4 tokens", () => {
  it("derived tokens: stable, purpose-bound, nonce-revocable; reply tokens are lower-case hex", () => {
    const s1 = deriveToken("status", "id1", "n1");
    expect(deriveToken("status", "id1", "n1")).toBe(s1);
    expect(deriveToken("confirm", "id1", "n1")).not.toBe(s1);
    expect(deriveToken("status", "id2", "n1")).not.toBe(s1);
    expect(deriveToken("status", "id1", "n2")).not.toBe(s1);
    expect(deriveToken("reply", "id1", "n1")).toMatch(/^[0-9a-f]{32}$/);
    expect(emailHash(" A@B.example ")).toBe(emailHash("a@b.example"));
  });
  it("the visitor-check cookie verifies only unaltered and unexpired", () => {
    const h = emailHash("v@x.example");
    const c = signVisitorCheck(h, Date.now() + 60_000);
    expect(readVisitorCheck(c)).toBe(h);
    expect(readVisitorCheck(c.replace(/.$/, (x) => (x === "A" ? "B" : "A")))).toBeNull();
    expect(readVisitorCheck(signVisitorCheck(h, Date.now() - 1))).toBeNull();
    expect(readVisitorCheck(`${emailHash("w@x.example")}.${c.split(".").slice(1).join(".")}`)).toBeNull();
    expect(readVisitorCheck(undefined)).toBeNull();
  });
  it("a seal binds its exact value", () => {
    const v = { a: 1, b: ["x"] };
    expect(sealValid(v, seal(v))).toBe(true);
    expect(sealValid({ a: 2, b: ["x"] }, seal(v))).toBe(false);
    expect(sealValid(v, "")).toBe(false);
  });
});

describe("U5 emails (the shared renderTemplate)", () => {
  const L = "https://p.example/r/t";
  const all: Array<[keyof typeof PARTNER_TEMPLATES, Record<string, string>]> = [
    ["confirm", { first: "Avery", ref: "ABC234", link: "https://p.example/partner/confirm/t" }],
    ["confirmWithHold", { first: "Avery", ref: "ABC234", link: "https://p.example/partner/confirm/t", hold: "$50" }],
    ["received", { first: "Avery", ref: "ABC234", link: L }],
    ["newMessage", { first: "Avery", ref: "ABC234", link: L }],
    ["statusUpdate", { first: "Avery", ref: "ABC234", link: L }],
    ["declined", { first: "Avery", ref: "ABC234", link: L }],
    ["declinedReleased", { first: "Avery", ref: "ABC234", link: L, amount: "$50" }],
    ["agreed", { first: "Avery", ref: "ABC234", link: L, amount: "$100" }],
    ["holdReleasedUnconfirmed", { first: "Avery", ref: "ABC234", amount: "$50" }],
    ["holdReleasedNoReply", { first: "Avery", ref: "ABC234", link: L, amount: "$50" }],
    ["holdReleasedNoDeal", { first: "Avery", ref: "ABC234", link: L, amount: "$50" }],
    ["visitorCode", { code: "012345" }],
  ];
  it("every template renders with its vars, never says brief, and carries no message text", () => {
    expect(all.map(([k]) => k).sort()).toEqual(Object.keys(PARTNER_TEMPLATES).sort());
    for (const [k, vars] of all) {
      const r = renderTemplate(PARTNER_TEMPLATES[k], vars);
      expect(r.html + r.text + r.subject).not.toMatch(/\bbrief\b/i);
      expect(r.text.length).toBeGreaterThan(10);
    }
    expect(renderTemplate(PARTNER_TEMPLATES.declinedReleased, all[6][1]).text).toMatch(/Declined: your hold of \$50 was released/);
    expect(renderTemplate(PARTNER_TEMPLATES.agreed, all[7][1]).text).toMatch(/charged \$100/);
    expect(usd(5000)).toBe("$50");
    expect(usd(12345)).toBe("$123.45");
  });
  it("escapes everything a visitor typed; a missing var is refused", () => {
    const r = renderTemplate(PARTNER_TEMPLATES.received, { first: "<script>x</script>", ref: "\"><img>", link: L });
    expect(r.html).not.toMatch(/<script>|<img>/);
    expect(r.html).toMatch(/&lt;script&gt;/);
    expect(() => renderTemplate(PARTNER_TEMPLATES.agreed, { first: "Avery", ref: "R", link: L })).toThrow(/missing var/);
  });
});
