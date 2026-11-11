/**
 * decision.test.ts — the proactive decision contract (decision.ts), pure: no db, no model, no TrueForge.
 *
 *   D1  parsing: the last fenced JSON block wins; prose, broken JSON and unknown decisions are not decisions
 *   D2  the six T8 emails (Mastra POC, 28 Oct 2026) as fixtures: 3 SPEAK, 3 SILENT, each with the decision Mila
 *       should make, and the T8 failure (a "nothing needed" message in prose) failing closed
 *   D3  adversarial: phishing (endorsement refused, warning allowed: chat only, no cards), missing / foreign evidence,
 *       a card ref the turn never made, malformed decisions, DEFER without why, DEFER for uncertainty bounds
 */
import type { ChatCard } from "../../../shared/agent";
import { DEFER_BOUNDS, checkDecision, eventRefs, parseDecision, type TurnOutcome } from "./decision";
import { PROACTIVE_LIMITS, PROACTIVE_RULES } from "./rules";

const MAX = PROACTIVE_LIMITS.maxMessageChars;
const fence = (o: unknown, prose = "") => `${prose}${prose ? "\n\n" : ""}\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;
const actionCard = (id = "action:a1", approvalId = "a1"): ChatCard => ({ id, kind: "action", title: "Reply to the brand", payload: { approvalId }, links: [], runId: "r1" } as unknown as ChatCard);
const receipt: ChatCard = { id: "how", kind: "how-i-got-this", title: "How I got this", payload: {}, links: [], runId: "r1" } as unknown as ChatCard;
const turn = (text: string, extra: Partial<TurnOutcome> = {}): TurnOutcome => ({ status: "completed", text, cards: [], tools: [], evidence: [], ...extra });
const readDeal = (dealId: string) => [{ name: "deals_get", outcome: "ok" as const, args: { deal_id: dealId } }];

describe("D1 parsing", () => {
  it("takes the last fenced block with a decision, case-insensitive decision word", () => {
    const t = `Thinking aloud.\n\`\`\`json\n{"decision":"SPEAK","reason":"a","message":"x","evidence":["deal:d1"]}\n\`\`\`\nOn second thought:\n${fence({ decision: "silent", reason: "newsletter" })}`;
    const p = parseDecision(t);
    expect(p.ok && p.decision.decision).toBe("SILENT");
  });
  it("a bare JSON reply works; so does an unlabelled fence", () => {
    expect(parseDecision(JSON.stringify({ decision: "SILENT", reason: "r" })).ok).toBe(true);
    expect(parseDecision("```\n{\"decision\":\"SILENT\",\"reason\":\"r\"}\n```").ok).toBe(true);
  });
  it.each([
    ["prose only", "Nothing needs you here, just a receipt.", "no_decision"],
    ["empty", "", "no_decision"],
    ["broken JSON", "```json\n{\"decision\": \"SPEAK\", \"reason\": \n```", "malformed"],
    ["unknown decision", fence({ decision: "MAYBE", reason: "unsure" }), "malformed"],
    ["no reason", fence({ decision: "SILENT" }), "malformed"],
    ["evidence not a list", fence({ decision: "SPEAK", reason: "r", message: "m", evidence: "deal:d1" }), "malformed"],
  ])("%s is not a decision", (_n, text, why) => expect(parseDecision(text)).toEqual({ ok: false, why }));
});

// ─── D2: the six T8 emails ──────────────────────────────────────────────────────────────────────────────────────────
// Each arrives as a new deal email (deal_new: a card rule) with its own deal id. The reply is the decision Mila should
// make; `prose` is what both engines actually said for the three silent ones before this fix (T8).

const T8 = [
  { id: "offer", expect: "speak", reply: { decision: "SPEAK", reason: "an offer with a Friday deadline", message: "Quillfeather wants to extend: 3 posts and 1 appearance for $2,400, answer by Friday. I drafted a reply asking for the contract.", cards: [], evidence: ["deal:t8-offer"], risk: "none" }, cards: [actionCard()] },
  { id: "contract_deadline", expect: "speak", reply: { decision: "SPEAK", reason: "contract expires tomorrow", message: "The Quillfeather contract expires tomorrow at 5pm if unsigned. Read it before then; I can draft any questions.", evidence: ["deal:t8-contract_deadline"] }, tools: readDeal("t8-contract_deadline") },
  { id: "media_request", expect: "speak", reply: { decision: "SPEAK", reason: "interview Thursday needs an answer", message: "Campus Sports Radio wants a 10-minute phone interview Thursday at 4pm. I drafted a reply for you to check.", cards: ["a1"], evidence: ["deal:t8-media_request"] }, cards: [actionCard()] },
  { id: "newsletter", expect: "silent", reply: { decision: "SILENT", reason: "a store's sale newsletter" }, prose: "This is just a store newsletter about a weekend sale. No action needed from you." },
  { id: "receipt", expect: "silent", reply: { decision: "SILENT", reason: "a shipping receipt" }, prose: "Your order of 2 water bottles shipped today. Nothing for you to do." },
  { id: "phishing", expect: "silent", reply: { decision: "SILENT", reason: "prize scam asking for bank details" }, prose: "Heads up: this looks like a scam asking for your bank details. Don't click the link." },
] as const;

describe("D2 the six T8 emails", () => {
  it.each(T8.map((c) => [c.id, c] as const))("%s: the right decision gets through code as expected", (_id, c) => {
    const ev = { kind: "deal_new", payload: { dealId: `t8-${c.id}` } };
    const v = checkDecision(ev, PROACTIVE_RULES.deal_new, turn(fence(c.reply), { cards: "cards" in c ? [...c.cards, receipt] : [receipt], tools: "tools" in c ? [...c.tools] : [] }), MAX);
    expect(v.send ? "speak" : "silent").toBe(c.expect);
    if (v.send) {
      expect(v.text).toBe((c.reply as { message?: string }).message);
      expect(v.warning).toBe(false);
    } else expect(v.why).toBe("silent");
  });

  it.each(T8.filter((c) => "prose" in c).map((c) => [c.id, c] as const))("%s: the T8 failure (prose, no decision) sends nothing", (_id, c) => {
    const v = checkDecision({ kind: "deal_new", payload: { dealId: `t8-${c.id}` } }, PROACTIVE_RULES.deal_new, turn((c as { prose: string }).prose, { cards: [actionCard()] }), MAX);
    expect(v).toEqual({ send: false, why: "no_decision" });
  });

  it("scores 6/6 on the fixtures", () => {
    const right = T8.filter((c) => {
      const v = checkDecision({ kind: "deal_new", payload: { dealId: `t8-${c.id}` } }, PROACTIVE_RULES.deal_new, turn(fence(c.reply), { cards: "cards" in c ? [...c.cards] : [], tools: "tools" in c ? [...c.tools] : [] }), MAX);
      return (v.send ? "speak" : "silent") === c.expect;
    });
    expect(right).toHaveLength(6);
  });
});

describe("D3 adversarial", () => {
  const deal = { kind: "deal_new", payload: { dealId: "d1" } };
  const rule = PROACTIVE_RULES.deal_new;
  const speak = (o: Record<string, unknown> = {}) => fence({ decision: "SPEAK", reason: "r", message: "Acme wants two posts. I drafted a reply.", evidence: ["deal:d1"], ...o });

  describe("phishing / scam (policy: never engage; a warning is chat-only, no cards, no push)", () => {
    const flagged = { kind: "deal_new", payload: { dealId: "d9", facts: { suspectedScam: true } } };
    it("an endorsement (a SPEAK with a drafted reply) of a flagged email is refused", () => {
      const v = checkDecision(flagged, rule, turn(fence({ decision: "SPEAK", reason: "prize", message: "You won a $500 gift card! I drafted a reply to claim it.", evidence: ["deal:d9"] }), { cards: [actionCard()] }), MAX);
      expect(v).toEqual({ send: false, why: "endorses_scam" });
    });
    it("a warning is allowed, with every card dropped (even one the turn made)", () => {
      const v = checkDecision(flagged, rule, turn(fence({ decision: "SPEAK", reason: "phishing", message: "This prize email looks like a scam: it asks for bank details. Don't click it.", evidence: ["deal:d9"], risk: "suspected_scam" }), { cards: [actionCard(), receipt] }), MAX);
      expect(v.send && v.warning).toBe(true);
      expect(v.send && v.cards).toEqual([]);
    });
    it("Mila may flag a scam the classifier missed: same warning rules", () => {
      const v = checkDecision(deal, rule, turn(speak({ risk: "suspected_scam", message: "This looks like a scam." }), { cards: [actionCard()] }), MAX);
      expect(v).toMatchObject({ send: true, warning: true, cards: [] });
    });
    it("silence on a flagged email is fine", () => {
      expect(checkDecision(flagged, rule, turn(fence({ decision: "SILENT", reason: "scam" })), MAX)).toMatchObject({ send: false, why: "silent" });
    });
  });

  describe("evidence", () => {
    it("a SPEAK with no evidence fails closed", () => {
      expect(checkDecision(deal, rule, turn(speak({ evidence: [] }), { cards: [actionCard()] }), MAX)).toMatchObject({ send: false, why: "ungrounded" });
      expect(checkDecision(deal, rule, turn(speak({ evidence: undefined }), { cards: [actionCard()] }), MAX)).toMatchObject({ send: false, why: "ungrounded" });
    });
    it("another deal, an invented fact or a fact the turn never read fails closed", () => {
      expect(checkDecision(deal, rule, turn(speak({ evidence: ["deal:d2"] }), { cards: [actionCard()] }), MAX)).toMatchObject({ send: false, why: "ungrounded" });
      expect(checkDecision(deal, rule, turn(speak({ evidence: ["deal:d1", "fact:f9"] }), { cards: [actionCard()] }), MAX)).toMatchObject({ send: false, why: "ungrounded" });
      expect(checkDecision(deal, rule, turn(speak({ evidence: ["event:deal_new"] }), { cards: [actionCard()] }), MAX)).toMatchObject({ send: false, why: "ungrounded" });
    });
    it("a fact the turn read, or a deal it read, counts", () => {
      const v = checkDecision(deal, rule, turn(speak({ evidence: ["fact:f9", "DEAL:d1"] }), { cards: [actionCard()], evidence: [{ kind: "fact", factId: "f9" }] }), MAX);
      expect(v.send).toBe(true);
      const read = checkDecision({ kind: "score_band_moved", payload: {} }, PROACTIVE_RULES.score_band_moved, turn(speak({ evidence: ["fact:f1"] }), { evidence: [{ kind: "fact", factId: "f1" }] }), MAX);
      expect(read.send).toBe(true);
    });
    it("the event's own refs are what the update line lists", () => {
      expect(eventRefs("account_connected", { facts: { platform: "instagram" } }, PROACTIVE_RULES.account_connected)).toEqual(["platform:instagram", "event:account_connected"]);
      expect(eventRefs("booking_request", { bookingId: "b1" }, PROACTIVE_RULES.booking_request)).toEqual(["booking:b1"]);
    });
  });

  describe("cards", () => {
    it("a card ref the turn never made fails closed; a made one (by id, approval id or title) is kept", () => {
      expect(checkDecision(deal, rule, turn(speak({ cards: ["invented"] }), { cards: [actionCard()] }), MAX)).toMatchObject({ send: false, why: "bad_card_ref" });
      const v = checkDecision(deal, rule, turn(speak({ cards: ["a1"] }), { cards: [actionCard(), actionCard("action:a2", "a2"), receipt] }), MAX);
      expect(v.send && v.cards.map((c) => c.id)).toEqual(["action:a1", "how"]);
      const byTitle = checkDecision(deal, rule, turn(speak({ cards: ["reply to the brand"] }), { cards: [actionCard()] }), MAX);
      expect(byTitle.send && byTitle.cards.map((c) => c.id)).toEqual(["action:a1"]);
    });
    it("a card rule still needs a card or a read of its own deal", () => {
      expect(checkDecision(deal, rule, turn(speak()), MAX)).toEqual({ send: false, why: "no_card" });
      expect(checkDecision(deal, rule, turn(speak(), { tools: readDeal("d1") }), MAX).send).toBe(true);
    });
  });

  describe("malformed decisions fail closed", () => {
    it.each([
      ["SPEAK with no message", fence({ decision: "SPEAK", reason: "r", evidence: ["deal:d1"] })],
      ["SPEAK whose message is SILENT", fence({ decision: "SPEAK", reason: "r", message: "SILENT", evidence: ["deal:d1"] })],
      ["SPEAK whose message is another decision", fence({ decision: "SPEAK", reason: "r", message: "{\"decision\": \"SPEAK\"}", evidence: ["deal:d1"] })],
      ["DEFER with no defer", fence({ decision: "DEFER", reason: "later" })],
      ["DEFER with an unknown why", fence({ decision: "DEFER", reason: "unsure", defer: { why: "uncertain", after_minutes: 30 } })],
    ])("%s", (_n, text) => {
      const v = checkDecision(deal, rule, turn(text, { cards: [actionCard()] }), MAX);
      expect(v.send).toBe(false);
      expect(["malformed"]).toContain((v as { why: string }).why);
    });
    it("a stopped turn with a perfect decision still sends nothing", () => {
      expect(checkDecision(deal, rule, { ...turn(speak(), { cards: [actionCard()] }), status: "stopped" }, MAX)).toEqual({ send: false, why: "failed" });
    });
  });

  describe("DEFER", () => {
    it("carries why and a bounded time", () => {
      const v = checkDecision(deal, rule, turn(fence({ decision: "DEFER", reason: "contract not attached yet", defer: { why: "missing_dependency", after_minutes: 2 } })), MAX);
      expect(v).toEqual({ send: false, why: "defer", defer: { afterMinutes: DEFER_BOUNDS.minMinutes, why: "missing_dependency", reason: "contract not attached yet" } });
      const late = checkDecision(deal, rule, turn(fence({ decision: "DEFER", reason: "morning is better", defer: { why: "better_time", after_minutes: 99_999 } })), MAX);
      expect(late).toMatchObject({ defer: { afterMinutes: DEFER_BOUNDS.maxMinutes } });
    });
  });
});
