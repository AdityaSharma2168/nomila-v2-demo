import { actionEmphasis, calendarDaysBetween, cardAction, cardLogo, cardVisual, footLine, kindChip, monogramOf, moveChip, primaryAction, qualLabel, reasonSource, showSetMinimum, whatMattersHead, POSTER_TOKENS } from "./oppBoardLogic";
import type { BoardItem } from "../../hooks/use-opportunity-board";

const NOW = new Date("2026-10-07T12:00:00Z");
const item = (over: Partial<BoardItem> = {}): BoardItem => ({
  opportunity_id: "o1", brand: { id: 1, name: "Stan Eats", logo_url: null, category: null, tier: null, research_confirmed: false, image_url: null, safe_logo_url: null, is_person: false },
  deal_ids: ["d1"], lead_deal_id: "d1", lead_thread_id: "t1", qualification: "needs_terms", state: "needs_terms",
  kind: "deal", kind_label: null, poster: "paid", whats_new: null, stage: null, message_count: 1, via: null, channel: "direct",
  standing: "none", line: "Their ask: … · no fee yet", awaiting_response_from: "athlete", her_move_since: "2026-09-22T12:00:00Z",
  overdue: true, going_quiet: false, brand_rollup: null, brand_opportunity_ids: ["o1"], last_activity_at: "2026-09-22T12:00:00Z", ...over,
});

describe("cardVisual", () => {
  it("a photo whenever the server sent a trusted cover; otherwise a name poster", () => {
    expect(cardVisual(item())).toBe("poster");
    expect(cardVisual(item({ brand: { ...item().brand, research_confirmed: true, image_url: null } }))).toBe("poster");
    expect(cardVisual(item({ brand: { ...item().brand, research_confirmed: true, image_url: "https://x/y.jpg" } }))).toBe("photo");
    // The server sends image_url only for trusted imagery (confirmed research, or the own site once settled).
    expect(cardVisual(item({ brand: { ...item().brand, research_confirmed: false, image_url: "https://x/y.jpg" } }))).toBe("photo");
  });

  it("names the four qualifications in her words and offers Set your minimum only when she has none", () => {
    const money = (state: string) => ({ read: { money: { line: "", state, source: "" } } as any });
    expect(qualLabel(item({ qualification: "workable", ...money("above_min") }))).toBe("Meets your minimum");
    expect(qualLabel(item({ qualification: "workable", ...money("no_min") }))).toBe("Terms in");
    expect(qualLabel(item({ qualification: "below_floor" }))).toBe("Below your minimum");
    expect(qualLabel(item({ qualification: "needs_terms" }))).toBe("Needs terms");
    expect(qualLabel(item({ qualification: "verify_first" }))).toBe("Verify first");
    expect(showSetMinimum(item({ qualification: "workable", ...money("no_min") }))).toBe(true);
    expect(showSetMinimum(item({ qualification: "workable", ...money("above_min") }))).toBe(false);
  });
  it("the poster palette never uses the overdue blue", () => {
    for (const t of Object.values(POSTER_TOKENS)) for (const c of [t.from, t.mid, t.to]) expect(c.toUpperCase()).not.toBe("#2D6BFF");
  });
});

describe("chips", () => {
  it("a request shows its own label; a deal its qualification", () => {
    expect(kindChip(item({ kind: "interview", kind_label: "Podcast" }))).toEqual({ text: "Podcast", dark: true });
    expect(kindChip(item())).toEqual({ text: "Needs terms", dark: false });
  });
  it("blue only when overdue", () => {
    expect(moveChip(item(), NOW)).toEqual({ text: "Waiting 15 days", overdue: true });
    expect(moveChip(item({ overdue: false }), NOW)).toBeNull(); // the line already says "Waiting on you since …"
    expect(moveChip(item({ awaiting_response_from: "brand" }), NOW)).toBeNull();
  });
  it("counts calendar days, so it agrees with the date shown (sent late on the 13th, read early on the 23rd = 10)", () => {
    const sent = new Date(2026, 9, 13, 22, 0); // local 13 Oct, 22:00
    const read = new Date(2026, 9, 23, 8, 0);  // local 23 Oct, 08:00 — only 9 full 24-hour days later
    expect(calendarDaysBetween(sent, read)).toBe(10);
    expect(moveChip(item({ her_move_since: sent.toISOString() }), read)).toEqual({ text: "Waiting 10 days", overdue: true });
  });
});

describe("primaryAction", () => {
  it("requests are always answered; never ask-for-terms to an unverifiable sender", () => {
    expect(primaryAction(item({ kind: "interview", kind_label: "Interview" }))).toBe("Reply");
    expect(primaryAction(item())).toBe("Ask for terms");
    expect(primaryAction(item({ channel: "unverifiable" }))).toBe("Reply");
    expect(primaryAction(item({ state: "below_floor", qualification: "below_floor" }))).toBe("Counter");
    expect(primaryAction(item({ qualification: "verify_first" }))).toBe("Verify");
  });
});

it("footLine leaves a named agency to its chip, and never says a second \"since …\" (the line and the chip carry the date)", () => {
  expect(footLine(item({ channel: "agency", via: "Jelly Otter", message_count: 3 }))).toBe("3 messages");
  expect(footLine(item({ channel: "agency", via: null, message_count: 1 }))).toBe("via an agency");
  expect(footLine(item())).toBe("");
  expect(footLine(item({ message_count: 4, overdue: true }))).not.toMatch(/since/);
});

describe("reasonSource", () => {
  it("passes the server's plain labels through", () => {
    for (const s of ["from their email", "from the sender’s address", "from the dates", "from Nomila’s research"]) expect(reasonSource(s)).toBe(s);
  });
  it("maps an older server's pipeline names to plain words", () => {
    expect(reasonSource("qualification")).toBe("from their email");
    expect(reasonSource("the classifier · kind")).toBe("from their email");
    expect(reasonSource("the classifier · channel")).toBe("from the sender’s address");
    expect(reasonSource("the classifier · sender domain")).toBe("from the sender’s address");
    expect(reasonSource("timing")).toBe("from the dates");
    expect(reasonSource("brand research (confirmed)")).toBe("from Nomila’s research");
  });
  it("omits any other internal token, and an empty source", () => {
    expect(reasonSource("the classifier · something new")).toBeNull();
    expect(reasonSource("enrichment v2")).toBeNull();
    expect(reasonSource("")).toBeNull();
    expect(reasonSource(null)).toBeNull();
  });
});

it("monogram: the brand's first letter, never for a person", () => {
  expect(monogramOf(item())).toBe("S");
  expect(monogramOf(item({ brand: { ...item().brand, name: "MUD\WTR" } }))).toBe("M");
  expect(monogramOf(item({ brand: { ...item().brand, is_person: true } }))).toBeNull();
});

describe("the one next step (8 Oct 2026)", () => {
  const next = (action: any, label: string) => ({ action, label, why: "w", due: null, hers: true });
  it("the card's action is the server's next step; an older server falls back to the card's state", () => {
    expect(cardAction(item({ next: next("confirm_signed", "Confirm it’s signed") }))).toBe("Confirm it’s signed");
    expect(cardAction(item())).toBe("Ask for terms");
  });
  it("one primary: while 'Looks signed' is up the action is secondary; dismissed or not signed, it is primary", () => {
    expect(actionEmphasis(true, false)).toBe("secondary");
    expect(actionEmphasis(true, true)).toBe("primary");
    expect(actionEmphasis(false, false)).toBe("primary");
  });
  it("the heading and count are Home's: a new athlete has none; an active one the board's needsYou", () => {
    expect(whatMattersHead({ whatMatters: [], counts: { open: 0, inMotion: 0, toVerify: 0, filed: 0, needsYou: 0 } })).toEqual({ title: "What matters next", sub: null, count: 0 });
    expect(whatMattersHead({ whatMatters: [item()], counts: { open: 12, inMotion: 0, toVerify: 0, filed: 0, needsYou: 11 } }))
      .toEqual({ title: "What matters next", sub: "11 waiting on you, most pressing first.", count: 11 });
    expect(whatMattersHead({ whatMatters: [item()], counts: { open: 1, inMotion: 0, toVerify: 0, filed: 0, needsYou: 1 } }).sub).toBe("1 waiting on you.");
    // an older server without needsYou: the cards shown
    expect(whatMattersHead({ whatMatters: [item(), item()], counts: { open: 9, inMotion: 0, toVerify: 0, filed: 0 } }).count).toBe(2);
  });
  it("the logo chip: confirmed research's logo, else the evidence domain's; nothing without either", () => {
    const b = item().brand;
    expect(cardLogo(item({ brand: { ...b, research_confirmed: true, logo_url: "https://l/x.png", safe_logo_url: null, domain: "x.example" } }))).toEqual({ logoUrl: "https://l/x.png", domain: "x.example" });
    expect(cardLogo(item({ brand: { ...b, logo_url: "https://guess/y.png", safe_logo_url: null, domain: null } }))).toBeNull(); // unconfirmed, no evidence: never shown
    expect(cardLogo(item({ brand: { ...b, safe_logo_url: null, domain: "z.example" } }))).toEqual({ logoUrl: null, domain: "z.example" });
    // A logo check found nothing good enough: no logo and no favicon fallback — the initial.
    expect(cardLogo(item({ brand: { ...b, research_confirmed: true, logo_url: "https://l/x.png", domain: "z.example", logo_none: true } }))).toBeNull();
  });
  it("a count is never '1 messages'", () => {
    expect(footLine(item({ message_count: 1 }))).toBe("");
    expect(footLine(item({ message_count: 3 }))).toBe("3 messages");
  });
});
