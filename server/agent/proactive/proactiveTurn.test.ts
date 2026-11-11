/**
 * proactiveTurn.test.ts — the pure parts of Mila's server-started turn: code's checks on the turn's decision before
 * anything is sent (the full contract is decision.test.ts), the clip, every rule's shape, the update lines (no athlete,
 * sport or brand in code), and the definition's proactive part matching the register's exact text. The turn runs on a
 * fake (never TrueForge).
 */
jest.mock("../../db", () => ({ db: {} }));

import type { ChatCard } from "../../../shared/agent";
import { ATHLETE_EVENT_KINDS, PROACTIVE_LIMITS, PROACTIVE_RULES } from "./rules";
import { firstSentence, milaPushEvent, plainText } from "./dispatcher";
import { PROACTIVE_LEAD, PROACTIVE_LINES, clipAtSentence, proactivePreface, refsLine, runProactiveTurn, verdictOf } from "./turn";

const card = (kind: string): ChatCard => ({ id: `c-${kind}`, kind, title: "Reply to the brand", payload: {}, links: [], runId: "r1" } as unknown as ChatCard);
const done = (text: string, cards: ChatCard[] = [], tools: any[] = []) => ({ status: "completed" as const, text, cards, tools });
const speak = (message: string, evidence: string[]) => `\`\`\`json\n${JSON.stringify({ decision: "SPEAK", reason: "needs them", message, cards: [], evidence, risk: "none" })}\n\`\`\``;
const silent = () => `\`\`\`json\n${JSON.stringify({ decision: "SILENT", reason: "nothing for them" })}\n\`\`\``;

describe("code checks before sending", () => {
  const deal = PROACTIVE_RULES.brand_reply;
  const br = (dealId: string) => ({ kind: "brand_reply", payload: { dealId } });
  it("a card rule needs a card, or a read of the event's own deal", () => {
    expect(verdictOf(br("d1"), deal, done(speak("They replied.", ["deal:d1"])))).toEqual({ send: false, why: "no_card" });
    expect(verdictOf(br("d1"), deal, done(speak("They replied.", ["deal:d1"]), [card("how-i-got-this")]))).toEqual({ send: false, why: "no_card" });
    expect(verdictOf(br("d1"), deal, done(speak("They replied.", ["deal:d1"]), [card("action")])).send).toBe(true);
    expect(verdictOf(br("d1"), deal, done(speak("They confirmed the date.", ["deal:d1"]), [], [{ name: "deals_get", outcome: "ok", args: { deal_id: "d1" } }])).send).toBe(true);
    // Reading some other deal, or a failed read, is not news about this one.
    expect(verdictOf(br("d1"), deal, done(speak("x", ["deal:d1"]), [], [{ name: "deals_get", outcome: "ok", args: { deal_id: "d2" } }])).send).toBe(false);
    expect(verdictOf(br("d1"), deal, done(speak("x", ["deal:d1"]), [], [{ name: "deals_get", outcome: "error", args: { deal_id: "d1" } }])).send).toBe(false);
  });
  it("a booking reads its booking", () => {
    expect(verdictOf({ kind: "booking_request", payload: { bookingId: "b1" } }, PROACTIVE_RULES.booking_request, done(speak("A request.", ["booking:b1"]), [], [{ name: "bookings_get", outcome: "ok", args: { booking_id: "b1" } }])).send).toBe(true);
  });
  it("a text rule needs a SPEAK; prose, SILENT, a stopped or failed turn send nothing", () => {
    const pay = { kind: "payment_received", payload: {} };
    const rule = PROACTIVE_RULES.payment_received;
    expect(verdictOf(pay, rule, done(speak("You got paid.", ["event:payment_received"]))).send).toBe(true);
    // The T8 failure: a "nothing needed" message in prose is no decision at all, so nothing is sent.
    expect(verdictOf(pay, rule, done("You got paid. No action needed."))).toEqual({ send: false, why: "no_decision" });
    expect(verdictOf(pay, rule, done(silent()))).toMatchObject({ send: false, why: "silent" });
    expect(verdictOf(pay, rule, done("SILENT"))).toEqual({ send: false, why: "silent" });
    expect(verdictOf(pay, rule, { ...done(speak("You got paid.", ["event:payment_received"])), status: "failed" })).toEqual({ send: false, why: "failed" });
    expect(verdictOf(pay, rule, { ...done(speak("You got paid.", ["event:payment_received"])), status: "stopped" })).toEqual({ send: false, why: "failed" });
  });
  it("a card waiting on their tap is sent only on a SPEAK; a wordless SPEAK needs a server-queued card", () => {
    const ev = br("d1");
    const rule = PROACTIVE_RULES.brand_reply;
    const waitingCard = { ...card("action"), payload: { approvalId: "a1" } } as ChatCard;
    const wordless = speak("", ["deal:d1"]);
    const waiting = { ...done(wordless, [waitingCard, card("how-i-got-this")]), approvalState: "awaiting_approval" as const };
    // A SPEAK with no words, carrying the approval card this turn queued: sent, no words invented (generic push line).
    expect(verdictOf(ev, rule, waiting)).toMatchObject({ send: true, text: "", cards: waiting.cards });
    // No decision, or SILENT, with a waiting card: fail closed (the approval's own waiting push already went out).
    expect(verdictOf(ev, rule, { ...waiting, text: "" })).toEqual({ send: false, why: "empty" });
    expect(verdictOf(ev, rule, { ...waiting, text: "SILENT" })).toEqual({ send: false, why: "silent" });
    expect(verdictOf(ev, rule, { ...waiting, text: silent() })).toMatchObject({ send: false, why: "silent" });
    // Wordless SPEAK without a waiting run, or with only a non-approval card: malformed.
    expect(verdictOf(ev, rule, { ...waiting, approvalState: null })).toMatchObject({ send: false, why: "malformed" });
    expect(verdictOf(ev, rule, { ...waiting, cards: [card("action")] })).toMatchObject({ send: false, why: "malformed" });
    // Ungrounded or failed: nothing.
    expect(verdictOf(br("d2"), rule, waiting)).toMatchObject({ send: false, why: "ungrounded" });
    expect(verdictOf(ev, rule, { ...waiting, status: "failed" })).toEqual({ send: false, why: "failed" });
  });
  it("a long message is clipped at a sentence", () => {
    const long = "One sentence here. ".repeat(100);
    const v = verdictOf({ kind: "payment_received", payload: {} }, PROACTIVE_RULES.payment_received, done(speak(long, ["event:payment_received"])));
    expect(v.send && v.text.length <= PROACTIVE_LIMITS.maxMessageChars && v.text.endsWith(".")).toBe(true);
    expect(clipAtSentence("short", 100)).toBe("short");
  });
  it("the refs line names the event's own refs, and nothing else", () => {
    expect(refsLine("brand_reply", { dealId: "d1" }, PROACTIVE_RULES.brand_reply)).toBe("Evidence refs for this update: deal:d1.");
    expect(refsLine("payment_received", {}, PROACTIVE_RULES.payment_received)).toBe("Evidence refs for this update: event:payment_received.");
    expect(refsLine("video_ready", {}, PROACTIVE_RULES.video_ready)).toBe("This update carries no ref of its own: a SPEAK must cite a fact:<id> you read this turn.");
  });
});

describe("the rules table", () => {
  it("every kind has a rule and a line; speak-now rules say where, what to check, and the lock-screen words", () => {
    for (const k of ATHLETE_EVENT_KINDS) {
      const r = PROACTIVE_RULES[k];
      expect(["speak_now", "reminder", "brief", "silent"]).toContain(r.outcome);
      expect(PROACTIVE_LINES[k]({}).length).toBeGreaterThan(20);
      if (r.outcome !== "speak_now") continue;
      expect(r.placement).toBeDefined();
      expect(r.check).toBeDefined();
      if (r.push) { expect(r.pref).toBeDefined(); expect(r.pushBody).toBeTruthy(); }
      if (r.check === "card" && r.placement !== "day") expect(r.subjectTool).toBeDefined();
    }
  });
  it("owner defaults (27 Oct 2026)", () => {
    const now = ATHLETE_EVENT_KINDS.filter((k) => PROACTIVE_RULES[k].outcome === "speak_now");
    expect(now.sort()).toEqual(["account_connected", "booking_request", "brand_reply", "deal_new", "event_passed", "payment_received", "post_published", "score_band_moved", "video_ready"]);
    // 10 Nov 2026 (content engine step 2c): a game that just passed is speak-now only with a card, never text alone.
    expect(PROACTIVE_RULES.event_passed).toMatchObject({ check: "card", pref: "milaSuggestion" });
    expect(PROACTIVE_RULES.account_connected.push).toBe(false);
    expect(PROACTIVE_LIMITS.dailyMilaPushCap).toBe(5);
    expect(PROACTIVE_RULES.research_done.outcome).toBe("brief");
    expect(PROACTIVE_RULES.draft_waiting.outcome).toBe("reminder");
  });
  it("owner rule (28 Oct 2026): business events and what they asked for are never paced", () => {
    const important = ATHLETE_EVENT_KINDS.filter((k) => PROACTIVE_RULES[k].important);
    expect(important.sort()).toEqual(["booking_request", "brand_reply", "deal_new", "payment_received", "post_published", "video_ready"]);
  });
  it("lines quote the source's label and never name a sport, school or league", () => {
    const line = PROACTIVE_LINES.brand_reply({ dealId: "d1", label: "Acme\nCo" });
    expect(line).toContain('"Acme Co"');
    expect(line).toContain("deal_id d1");
    const all = ATHLETE_EVENT_KINDS.map((k) => PROACTIVE_LINES[k]({})).join(" ") + PROACTIVE_LEAD;
    expect(all).not.toMatch(/soccer|football|basketball|stanford|ncaa|nwsl|\bshe\b|\bher\b/i);
  });
});

/** Prompt Register entry 79 (v2, 28 Oct 2026): the exact text the model receives. */
const PROACTIVE_MD_V2 = [
  "<when_you_start>",
  "# When you start the conversation",
  "",
  "You also act as the athlete's manager when they are not talking to you. Sometimes a turn starts from an app update instead of a message from them: a brand email, a booking, a payment, a finished score or video. Decide whether it is worth interrupting them.",
  "",
  "SPEAK when the update needs them (an offer, a decision, a reply, a deadline) or is news they would want now, even if you cannot prepare a card for it yet. The message leads with what happened and the one next move you recommend, in two or three sentences, with the action as a card they can tap when you can make one. Say only what the update and their record support. Never send, accept, publish or pay on your own; every outbound step is their tap.",
  "",
  "SILENT when it needs nothing from them: a newsletter, a promotion, a receipt, something you already told them, or something only waiting on the other side. Silence sends nothing, so never write a message to say nothing is needed.",
  "",
  "If it looks like a scam or phishing (a prize, an urgent link, a request for bank details or a password), never engage or draft a reply. Answer SILENT, or SPEAK one line of warning with \"risk\": \"suspected_scam\".",
  "",
  "DEFER only when something it depends on is not ready yet, or a later time is clearly better; never because you are unsure.",
  "",
  "End the turn with this JSON block and nothing after it:",
  "```json",
  "{\"decision\": \"SPEAK|SILENT|DEFER\", \"reason\": \"one short line\", \"message\": \"SPEAK only: what they read\", \"cards\": [], \"evidence\": [\"refs listed in the update, or fact:<id> you read\"], \"risk\": \"none\", \"defer\": {\"why\": \"missing_dependency|better_time\", \"after_minutes\": 60}}",
  "```",
  "A SPEAK needs a message and at least one evidence ref. \"cards\": [] shows every card your tools made this turn; to show only some, list their exact titles. Leave out \"defer\" unless you DEFER.",
  "</when_you_start>",
].join("\n");

describe("the definition's proactive part", () => {
  it("is the register's exact text (entry 79, v2), comments stripped, Mila never gendered", () => {
    const p = proactivePreface();
    expect(p).toBe(PROACTIVE_MD_V2);
    expect(p).not.toMatch(/<!--|-->/);
    expect(p).not.toMatch(/\b(she|he|her|his|hers|him)\b/i);
  });
  it("no longer asks for a message when nothing is needed (the T8 contradiction)", () => {
    const p = proactivePreface();
    expect(p).not.toMatch(/say so plainly/i);
    expect(p).toMatch(/never write a message to say nothing is needed/);
    expect(p).toMatch(/never because you are unsure/);
  });
});

describe("runProactiveTurn", () => {
  it("runs isolated, with no athlete message, the lead + the event line, and the proactive preface", async () => {
    const runTurn = jest.fn(async () => ({ runId: "r1", text: "SILENT", status: "completed" as const, stopReason: null, cards: [], cost: {} as any, tools: [] }));
    const r = await runProactiveTurn({ athleteId: "dd1a8a80-d31b-423a-a572-9d146716cb0f", kind: "brand_reply", payload: { dealId: "d1", label: "Acme" }, conversationId: "c1" }, { runTurn: runTurn as any });
    expect(r.verdict).toEqual({ send: false, why: "silent" });
    const [p, , opts] = runTurn.mock.calls[0] as any[];
    expect(p).toMatchObject({ athleteId: "dd1a8a80-d31b-423a-a572-9d146716cb0f", message: null, conversationId: "c1" });
    expect(opts.isolated).toBe(true);
    expect(opts.trigger).toBe("event");
    expect(opts.updates[0]).toBe(PROACTIVE_LEAD);
    expect(opts.updates[1]).toContain("deal_id d1");
    expect(opts.updates[2]).toBe("Evidence refs for this update: deal:d1.");
    expect(opts.preface({ isNew: true })[0]).toContain("# When you start the conversation");
  });
});

describe("the lock-screen sentence is plain text", () => {
  it.each([
    ["**Acme** replied with a _rate_ for three posts. I drafted an answer.", "Acme replied with a rate for three posts."],
    ["__Acme__ sent *the brief*. More below.", "Acme sent the brief."],
    ["[Acme](https://acme.example/deal) asked for `deal_id` details. Then more.", "Acme asked for deal_id details."],
    ["## New deal\n- **Acme** wants two posts. Second line.", "New deal Acme wants two posts."],
    ["1. Reply to ~~Glow~~ Acme today! Then rest.", "Reply to Glow Acme today!"],
    ["> Acme said yes. Nice.", "Acme said yes."],
    ["```\nignored fence\n```\nAcme paid.", "ignored fence Acme paid."],
    ["Your deal_id stays as written. Fine.", "Your deal_id stays as written."],
  ])("%j", (md, want) => expect(firstSentence(md)).toBe(want));

  it("keeps the length limit after stripping", () => {
    const s = firstSentence(`**${"word ".repeat(60)}**`, 160);
    expect(s.length).toBeLessThanOrEqual(160);
    expect(s.endsWith("…")).toBe(true);
    expect(s).not.toMatch(/[*_`]/);
  });

  it("a message with no words (only a waiting card) gets the generic line, never an empty notification", () => {
    const ev = { dedupeKey: "brand_reply:x", payload: { dealId: "d1" } } as any;
    const at = { conversationId: "c1", messageId: "m1" };
    expect(milaPushEvent(ev, PROACTIVE_RULES.brand_reply, at, "").named?.body).toBe(milaPushEvent(ev, PROACTIVE_RULES.brand_reply, at, "").body);
    expect(milaPushEvent(ev, PROACTIVE_RULES.brand_reply, at, "Acme replied. More.").named?.body).toBe("Acme replied.");
  });

  it("strips without losing words", () => {
    expect(plainText("![logo](x.png) **bold** and <https://a.example>")).toBe("logo bold and https://a.example");
  });
});
